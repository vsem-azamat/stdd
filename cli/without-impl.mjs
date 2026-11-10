// `stdd red --without-impl`: prove a test depends on the implementation by
// running it with the branch's implementation changes removed. Owns the strip
// set, the backup, the restore guarantee, and the recovery hooks; the run and
// the ledger write stay with the generic recorder.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { globToRegExp, RED_WITHOUT_IMPL_MODE } from "./lib.mjs";
import { splitNul, viewPath } from "./path-bytes.mjs";
import { recordRun } from "./recorders.mjs";
import { fail, MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { dirtySnapshot } from "./snapshot.mjs";

const LABEL = "stdd red --without-impl";
// one lock per repository, inside the git dir: survives reboots and TMPDIR
// differences, so a second run can never miss an open or interrupted one
const LOCK_GIT_PATH = "stdd-without-impl";
const MANIFEST_NAME = "manifest.json";
const MANIFEST_VERSION = 2;
const RECOVERY_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
// git tree-entry modes that can be written back as a working-tree file
const BLOB_MODES = new Set(["100644", "100755"]);
const SYMLINK_MODE = "120000";
const IN_PROGRESS = [
	["rebase-merge", "rebase"],
	["rebase-apply", "rebase"],
	["MERGE_HEAD", "merge"],
	["CHERRY_PICK_HEAD", "cherry-pick"],
	["BISECT_LOG", "bisect"],
];

function gitBytes(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: MAX_SUBPROCESS_BUFFER,
	});
}

function gitText(cwd, args) {
	return gitBytes(cwd, args).toString("utf8").trim();
}

/** Where one run keeps its backup and manifest; its existence is the lock. */
export function withoutImplBackupDir(cwd) {
	return path.resolve(cwd, gitText(cwd, ["rev-parse", "--git-path", LOCK_GIT_PATH]));
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/**
 * The leftover state of a lock, or null when none exists: which process took
 * it, whether that process is still alive, and how many paths its manifest
 * still marks stripped. Soft on purpose — `stdd status` reads it too, and a
 * damaged manifest must not take the status down.
 */
export function withoutImplLockState(cwd) {
	let lockDir;
	try {
		lockDir = withoutImplBackupDir(cwd);
	} catch {
		return null;
	}
	if (!fs.existsSync(lockDir)) return null;
	let manifest = null;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(lockDir, MANIFEST_NAME), "utf8"));
	} catch {
		manifest = null;
	}
	const pid = Number.isInteger(manifest?.pid) ? manifest.pid : null;
	const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
	return {
		path: lockDir,
		pid,
		alive: pid !== null && processAlive(pid),
		stripped: entries.filter((entry) => entry?.stripped === true).length,
	};
}

/** One sentence a user can act on when a lock is left behind. */
export function describeWithoutImplLock(lock) {
	const manifestPath = path.join(lock.path, MANIFEST_NAME);
	const owner =
		lock.pid === null
			? `a ${LABEL} run left its lock at ${lock.path} without a manifest`
			: lock.alive
				? `another ${LABEL} run (pid ${lock.pid}) is still running in this checkout — wait for it to finish; its lock is ${lock.path}`
				: `a ${LABEL} run (pid ${lock.pid}) is no longer running but left its lock at ${lock.path}`;
	if (lock.alive) return owner;
	return lock.stripped > 0
		? `${owner}; ${lock.stripped} path(s) still stripped — restore the tree from ${manifestPath}, then remove the directory`
		: `${owner}; nothing is stripped — remove the directory`;
}

function operationInProgress(cwd) {
	for (const [name, label] of IN_PROGRESS) {
		let marker;
		try {
			marker = gitText(cwd, ["rev-parse", "--git-path", name]);
		} catch {
			continue;
		}
		if (fs.existsSync(path.resolve(cwd, marker))) return label;
	}
	return null;
}

/**
 * Changed paths as raw bytes: the tracked diff against the merge base, the
 * working tree against HEAD, and untracked files. `--no-renames` keeps both
 * sides of a rename, so the old name is written back and the new one removed;
 * the shared ledger helpers collapse renames and keep their own callers.
 */
function changedPathBytes(toplevel, baseRef) {
	const list = (args) => splitNul(gitBytes(toplevel, args)).filter((entry) => entry.length > 0);
	return [
		...list(["diff", "--name-only", "-z", "--no-renames", "--end-of-options", `${baseRef}...HEAD`]),
		...list(["diff", "--name-only", "-z", "--no-renames", "HEAD"]),
		...list(["ls-files", "--others", "--exclude-standard", "-z"]),
	];
}

/**
 * Every blob of the merge-base tree, indexed by path, and a batch reader for
 * their contents: one git process each, however many paths the run strips.
 */
function baseTree(toplevel, mergeBase) {
	const tree = new Map();
	for (const entry of splitNul(gitBytes(toplevel, ["ls-tree", "-r", "-z", mergeBase]))) {
		if (entry.length === 0) continue;
		const text = entry.toString("utf8");
		const tab = text.indexOf("\t");
		const [mode, type, sha] = text.slice(0, tab).split(" ");
		tree.set(text.slice(tab + 1), { mode, type, sha });
	}
	return tree;
}

function blobContents(toplevel, shas) {
	const contents = new Map();
	if (shas.length === 0) return contents;
	const output = execFileSync("git", ["-C", toplevel, "cat-file", "--batch"], {
		input: `${shas.join("\n")}\n`,
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: MAX_SUBPROCESS_BUFFER,
	});
	let offset = 0;
	while (offset < output.length) {
		const lineEnd = output.indexOf(0x0a, offset);
		const [sha, type, size] = output.subarray(offset, lineEnd).toString("utf8").split(" ");
		if (type !== "blob") throw new Error(`cannot read base content of ${sha}: ${type}`);
		const length = Number(size);
		contents.set(sha, output.subarray(lineEnd + 1, lineEnd + 1 + length));
		offset = lineEnd + 1 + length + 1;
	}
	return contents;
}

/** The path's state at the merge base, or null when it does not exist there. */
function baseState(tree, contents, relative) {
	const entry = tree.get(relative);
	if (!entry) return null;
	if (entry.type !== "blob" || (!BLOB_MODES.has(entry.mode) && entry.mode !== SYMLINK_MODE)) {
		throw new Error(`cannot strip ${relative}: it is a ${entry.type} (${entry.mode}) at the merge base`);
	}
	const bytes = contents.get(entry.sha);
	if (!bytes) throw new Error(`cannot read the merge-base content of ${relative}`);
	return entry.mode === SYMLINK_MODE
		? { kind: "symlink", target: bytes.toString("utf8") }
		: { kind: "file", mode: entry.mode === "100755" ? 0o755 : 0o644, bytes };
}

function currentState(toplevel, relative) {
	const abs = path.join(toplevel, relative);
	let observed;
	try {
		observed = fs.lstatSync(abs);
	} catch (err) {
		if (err.code === "ENOENT") return { kind: "absent" };
		throw new Error(`cannot strip ${relative}: ${err.message}`);
	}
	if (observed.isSymbolicLink()) return { kind: "symlink", target: fs.readlinkSync(abs) };
	if (observed.isFile()) return { kind: "file", mode: observed.mode & 0o777 };
	throw new Error(`cannot strip ${relative}: not a regular file or symlink`);
}

/**
 * Decide what the run removes. Every refusal happens here, before the tree
 * is touched, so a refused run strips nothing and records nothing. Paths are
 * toplevel-relative throughout; the `.stdd/` exclusion is anchored to the
 * actual stdd root, and the configured globs match root-relative paths.
 */
function planStrip(cwd, config, refuse) {
	const baseRef = config.baseRef;
	if (!baseRef) {
		refuse(
			`${LABEL} needs a baseRef in .stdd/config.json to strip against, e.g. "baseRef": "origin/main"`,
		);
	}
	const toplevel = fs.realpathSync(gitText(cwd, ["rev-parse", "--show-toplevel"]));
	const rootRelative = path.relative(toplevel, fs.realpathSync(cwd)).split(path.sep).join("/");
	let mergeBase;
	try {
		mergeBase = gitText(toplevel, ["merge-base", baseRef, "HEAD"]);
	} catch {
		refuse(`baseRef ${baseRef} does not resolve against HEAD — nothing stripped`);
	}
	const operation = operationInProgress(cwd);
	if (operation) refuse(`a ${operation} is in progress — finish or abort it before ${LABEL}`);

	const changed = new Set();
	for (const bytes of changedPathBytes(toplevel, baseRef)) {
		const utf8 = bytes.toString("utf8");
		if (!Buffer.from(utf8, "utf8").equals(bytes)) {
			refuse(
				`changed path ${viewPath(bytes.toString("latin1"))} is not valid UTF-8 — ${LABEL} cannot name it in the ledger; rename it first`,
			);
		}
		changed.add(utf8);
	}
	const stateGlob = globToRegExp(`${rootRelative ? `${rootRelative}/` : ""}.stdd/**`);
	const keep = [...config.testGlobs, ...config.canonicalDocs].map(globToRegExp);
	const rootView = (p) =>
		rootRelative && p.startsWith(`${rootRelative}/`) ? p.slice(rootRelative.length + 1) : p;
	const stripped = [...changed]
		.filter((p) => !stateGlob.test(p) && !keep.some((re) => re.test(rootView(p))))
		.sort();
	if (stripped.length === 0) {
		refuse(
			`nothing to strip — no implementation change against ${baseRef} ` +
				"(tests, canonical docs, and .stdd/ are kept in place)",
		);
	}
	let entries;
	try {
		const tree = baseTree(toplevel, mergeBase);
		const contents = blobContents(toplevel, [
			...new Set(stripped.map((relative) => tree.get(relative)?.sha).filter(Boolean)),
		]);
		entries = stripped.map((relative) => ({
			path: relative,
			current: currentState(toplevel, relative),
			base: baseState(tree, contents, relative),
		}));
	} catch (err) {
		refuse(`${err.message} — nothing stripped`);
	}
	return { baseRef, mergeBase, toplevel, entries };
}

function removeEmptyParents(toplevel, relative) {
	let dir = path.dirname(path.join(toplevel, relative));
	while (dir !== toplevel && dir.startsWith(toplevel)) {
		try {
			if (fs.readdirSync(dir).length > 0) return;
			fs.rmdirSync(dir);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

function removePath(abs, relative) {
	let observed;
	try {
		observed = fs.lstatSync(abs);
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
	if (observed.isDirectory()) {
		throw new Error(`${relative} became a directory during the run`);
	}
	fs.rmSync(abs);
}

function writeState(toplevel, relative, state, bytesFrom) {
	const abs = path.join(toplevel, relative);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	if (state.kind === "symlink") {
		fs.symlinkSync(state.target, abs);
		return;
	}
	if (bytesFrom) fs.copyFileSync(bytesFrom, abs);
	else fs.writeFileSync(abs, state.bytes);
	fs.chmodSync(abs, state.mode);
}

/** The manifest is the recovery map: rewritten atomically after every step that changes what it must describe. */
function writeManifest(lockDir, manifest) {
	const target = path.join(lockDir, MANIFEST_NAME);
	const temp = `${target}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(manifest, null, "\t")}\n`);
	fs.renameSync(temp, target);
}

/**
 * Phase one: copy every current file under the lock directory, recording an
 * entry only once its backup exists; the manifest is written once at the end
 * (an entry is only ever consulted by a restore, which handles entries marked
 * stripped, and nothing is stripped before phase two). Nothing in the tree
 * changes here, so a failure leaves the checkout exactly as it was.
 */
function backUp(lockDir, plan, manifest) {
	const runId = randomBytes(6).toString("hex");
	for (const [index, entry] of plan.entries.entries()) {
		const record = { path: entry.path, kind: entry.current.kind, stripped: false };
		if (entry.current.kind === "file") {
			record.mode = entry.current.mode;
			record.backup = `${runId}-${index}`;
			fs.copyFileSync(path.join(plan.toplevel, entry.path), path.join(lockDir, record.backup));
			if (!fs.existsSync(path.join(lockDir, record.backup))) {
				throw new Error(`backup of ${entry.path} did not land`);
			}
		} else if (entry.current.kind === "symlink") {
			record.target = entry.current.target;
		}
		manifest.entries.push(record);
	}
	writeManifest(lockDir, manifest);
}

/**
 * Phase two: mark every entry stripped in the manifest once, then put the
 * merge-base content (or nothing) in place. Marking ahead is safe: a restore
 * verifies each backup exists before touching the working file.
 */
function strip(lockDir, plan, manifest) {
	for (const entry of manifest.entries) entry.stripped = true;
	writeManifest(lockDir, manifest);
	for (const entry of plan.entries) {
		const abs = path.join(plan.toplevel, entry.path);
		removePath(abs, entry.path);
		if (entry.base) writeState(plan.toplevel, entry.path, entry.base, null);
		else removeEmptyParents(plan.toplevel, entry.path);
	}
}

/**
 * Put every stripped entry back exactly as it was. Every entry is attempted;
 * each failure is reported and the entry stays marked stripped in the
 * manifest, so the backup remains a usable recovery map.
 */
function restore(lockDir, toplevel, manifest) {
	const failures = [];
	for (const entry of manifest.entries) {
		if (!entry.stripped) continue;
		const abs = path.join(toplevel, entry.path);
		try {
			if (entry.kind === "file") {
				const backup = path.join(lockDir, entry.backup);
				if (!fs.existsSync(backup)) throw new Error(`backup file ${entry.backup} is missing`);
				removePath(abs, entry.path);
				writeState(toplevel, entry.path, { kind: "file", mode: entry.mode }, backup);
			} else if (entry.kind === "symlink") {
				removePath(abs, entry.path);
				writeState(toplevel, entry.path, { kind: "symlink", target: entry.target }, null);
			} else {
				removePath(abs, entry.path);
				removeEmptyParents(toplevel, entry.path);
			}
			entry.stripped = false;
		} catch (err) {
			failures.push(`${entry.path}: ${err.message}`);
		}
	}
	writeManifest(lockDir, manifest);
	return failures;
}

function observeCheckout(toplevel) {
	return { head: gitText(toplevel, ["rev-parse", "HEAD"]), dirty: dirtySnapshot(toplevel) };
}

function emit(result) {
	if (result?.stdout) process.stdout.write(result.stdout);
	if (result?.stderr) process.stderr.write(result.stderr);
}

/**
 * `stdd red --without-impl -- <cmd>`: claim the lock, strip, run through the
 * ordinary red recorder, restore, and refuse to record when the restored
 * checkout does not match what was observed before the strip. The command
 * runs asynchronously so a signal to this process can still restore the tree;
 * an interrupted run records nothing.
 */
export async function redWithoutImpl(cwd, argv) {
	return recordRun(cwd, "red", argv, {
		async wrap(run) {
			const config = loadConfig(cwd);
			const lockDir = withoutImplBackupDir(cwd);
			try {
				fs.mkdirSync(lockDir, { mode: 0o700 });
			} catch (err) {
				if (err.code !== "EEXIST") fail(`cannot create ${lockDir}: ${err.message} — nothing recorded`);
				fail(`${describeWithoutImplLock(withoutImplLockState(cwd))}; nothing recorded`);
			}
			// the manifest exists from the first moment the lock does: who holds
			// it, since when, and (so far) nothing stripped
			const manifest = {
				version: MANIFEST_VERSION,
				pid: process.pid,
				startedAt: new Date().toISOString(),
				repository: null,
				baseRef: null,
				mergeBase: null,
				entries: [],
			};
			writeManifest(lockDir, manifest);
			// nothing is backed up or stripped yet: a refusal releases the lock
			const refuse = (message) => {
				fs.rmSync(lockDir, { recursive: true, force: true });
				fail(`${message}; nothing recorded`);
			};
			const plan = planStrip(cwd, config, refuse);
			const stripped = plan.entries.map((entry) => entry.path);
			const strippedKeys = new Set(stripped.map((p) => Buffer.from(p, "utf8").toString("latin1")));
			manifest.repository = plan.toplevel;
			manifest.baseRef = plan.baseRef;
			manifest.mergeBase = plan.mergeBase;
			const before = observeCheckout(plan.toplevel);

			// the backup is removed only once the restored checkout has been
			// compared with the pre-run observation; until then it is the recovery map
			const restoreOrReport = (context) => {
				const failures = restore(lockDir, plan.toplevel, manifest);
				if (failures.length === 0) return null;
				return (
					`${context}: restore failed for ${failures.length} path(s) — ${failures.join("; ")}; ` +
					`the backup is kept at ${lockDir} (see ${MANIFEST_NAME})`
				);
			};

			let child = null;
			let interrupted = null;
			// the command runs detached in its own process group, so the signal
			// reaches a grandchild holding the output pipe, not only the shell
			const onSignal = (signal) => {
				interrupted = signal;
				if (!child) return;
				try {
					process.kill(-child.pid, signal);
				} catch {
					try {
						child.kill(signal);
					} catch {
						// the child may already be gone; the restore below is what matters
					}
				}
			};
			// a second signal while the restore runs must not stop it half-way:
			// from here until the restore finished, signals are noted and ignored
			const hold = () => {};
			const onException = (err) => {
				const problem = restoreOrReport(`${LABEL}: uncaught exception (${err?.message ?? String(err)})`);
				if (!problem) fs.rmSync(lockDir, { recursive: true, force: true });
				fs.writeSync(
					process.stderr.fd,
					`${problem ?? `${LABEL}: uncaught exception (${err?.message ?? String(err)}); the stripped paths were restored`}\n`,
				);
				process.exit(1);
			};
			for (const signal of RECOVERY_SIGNALS) process.on(signal, onSignal);
			process.on("uncaughtException", onException);
			const release = () => {
				for (const signal of RECOVERY_SIGNALS) {
					process.off(signal, onSignal);
					process.on(signal, hold);
				}
				process.off("uncaughtException", onException);
			};
			const unhold = () => {
				for (const signal of RECOVERY_SIGNALS) process.off(signal, hold);
			};

			try {
				backUp(lockDir, plan, manifest);
			} catch (err) {
				release();
				unhold();
				refuse(
					`cannot back up a path before stripping it — ${err.message}; nothing was stripped or changed`,
				);
			}
			let result = null;
			try {
				strip(lockDir, plan, manifest);
				console.error(
					`${LABEL}: stripped ${stripped.length} path(s) against ${plan.baseRef} (merge base ${plan.mergeBase.slice(0, 12)}):`,
				);
				for (const p of stripped) console.error(`  ${p}`);
				result = await run(
					(spawned) => {
						child = spawned;
					},
					{ detached: true },
				);
			} catch (err) {
				release();
				const problem = restoreOrReport(`${LABEL}: ${err.message}`);
				unhold();
				if (!problem) fs.rmSync(lockDir, { recursive: true, force: true });
				fail(problem ?? `${LABEL}: ${err.message}; the stripped paths were restored; nothing recorded`);
			}
			release();
			const signal = interrupted ?? result.signal ?? null;
			const problem = restoreOrReport(LABEL);
			unhold();
			if (signal) {
				emit(result);
				if (!problem) fs.rmSync(lockDir, { recursive: true, force: true });
				fs.writeSync(
					process.stderr.fd,
					`${problem ?? `${LABEL}: interrupted by ${signal}; the stripped paths were restored`}; nothing recorded\n`,
				);
				process.exit(128 + (os.constants.signals[signal] ?? 0));
			}
			if (problem) {
				emit(result);
				fail(`${problem}; nothing recorded`);
			}
			const after = observeCheckout(plan.toplevel);
			// a path that was clean before and dirty now is either a tracked file the
			// command modified (a difference) or an untracked file it created (left
			// in place, never restored over, because nothing of the user's was there)
			const tracked = new Set(
				splitNul(gitBytes(plan.toplevel, ["ls-files", "-z"])).map((entry) => entry.toString("latin1")),
			);
			const keys = new Set([...Object.keys(before.dirty), ...Object.keys(after.dirty)]);
			const created = [];
			const differing = [];
			for (const key of keys) {
				if (before.dirty[key] === after.dirty[key]) continue;
				if (before.dirty[key] === undefined && !strippedKeys.has(key) && !tracked.has(key)) {
					created.push(key);
				} else {
					differing.push(key);
				}
			}
			if (after.head !== before.head || differing.length > 0) {
				emit(result);
				fail(
					`${LABEL}: the checkout differs after the restore` +
						(after.head !== before.head ? ` (HEAD moved from ${before.head} to ${after.head})` : "") +
						(differing.length ? ` — ${differing.sort().map(viewPath).join(", ")}` : "") +
						"; the stripped paths were written back, the backup is kept at " +
						`${lockDir} — inspect the tree, then remove that directory; nothing recorded`,
				);
			}
			fs.rmSync(lockDir, { recursive: true, force: true });
			console.error(
				`${LABEL}: restored ${stripped.length} path(s); the checkout matches its pre-run state`,
			);
			if (created.length > 0) {
				console.error(
					`${LABEL}: left in place, created by the command: ${created.sort().map(viewPath).join(", ")}`,
				);
			}
			return { result, fields: { mode: RED_WITHOUT_IMPL_MODE, stripped } };
		},
	});
}
