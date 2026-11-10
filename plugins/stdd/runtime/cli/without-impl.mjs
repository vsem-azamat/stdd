// `stdd red --without-impl`: prove a test depends on the implementation by
// running it with the branch's implementation changes removed. Owns the strip
// set, the backup, the restore guarantee, and the recovery hooks; the run and
// the ledger write stay with the generic recorder.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { gitChangedPaths, gitWorkingPaths } from "./ledger.mjs";
import { globToRegExp, RED_WITHOUT_IMPL_MODE } from "./lib.mjs";
import { recordRun } from "./recorders.mjs";
import { fail, MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { checkoutSnapshot, dirtySnapshot } from "./snapshot.mjs";

const STATE_GLOB = ".stdd/**";
const MANIFEST_NAME = "manifest.json";
const MANIFEST_VERSION = 1;
const LABEL = "stdd red --without-impl";
const RECOVERY_SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
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

/** Private backup location for one repository; its presence means a run is open or was interrupted. */
export function withoutImplBackupDir(cwd) {
	const key = createHash("sha256").update(fs.realpathSync(cwd)).digest("hex").slice(0, 32);
	return path.join(os.tmpdir(), `stdd-without-impl-${key}`);
}

function gitBytes(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: MAX_SUBPROCESS_BUFFER,
	});
}

function gitText(cwd, args) {
	return gitBytes(cwd, args).toString("utf8").trim();
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

/** The path's content at the merge base, or null when it does not exist there. */
function baseState(cwd, mergeBase, relative) {
	const entry = gitBytes(cwd, ["ls-tree", "-z", mergeBase, "--", relative]).toString("utf8");
	if (entry === "") return null;
	const [mode, type, rest] = entry.replace(/\0$/, "").split(/[ \t]/, 3);
	const sha = rest.split("\t")[0];
	if (type !== "blob" || (!BLOB_MODES.has(mode) && mode !== SYMLINK_MODE)) {
		throw new Error(`cannot strip ${relative}: it is a ${type} (${mode}) at the merge base`);
	}
	const bytes = gitBytes(cwd, ["cat-file", "blob", sha]);
	return mode === SYMLINK_MODE
		? { kind: "symlink", target: bytes.toString("utf8") }
		: { kind: "file", mode: mode === "100755" ? 0o755 : 0o644, bytes };
}

function currentState(cwd, relative) {
	const abs = path.join(cwd, relative);
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
 * is touched, so a refused run strips nothing and records nothing.
 */
function planStrip(cwd, config) {
	const baseRef = config.baseRef;
	if (!baseRef) {
		fail(
			`${LABEL} needs a baseRef in .stdd/config.json to strip against, e.g. "baseRef": "origin/main" — nothing recorded`,
		);
	}
	let mergeBase;
	try {
		mergeBase = gitText(cwd, ["merge-base", baseRef, "HEAD"]);
	} catch {
		fail(`baseRef ${baseRef} does not resolve against HEAD — nothing stripped, nothing recorded`);
	}
	const operation = operationInProgress(cwd);
	if (operation) {
		fail(`a ${operation} is in progress — finish or abort it before ${LABEL}; nothing recorded`);
	}
	const backupDir = withoutImplBackupDir(cwd);
	if (fs.existsSync(backupDir)) {
		fail(
			`a previous ${LABEL} run left its backup at ${backupDir} — the tree may still be stripped; ` +
				`restore it from ${path.join(backupDir, MANIFEST_NAME)}, then remove the directory; nothing recorded`,
		);
	}
	const keep = [STATE_GLOB, ...config.testGlobs, ...config.canonicalDocs].map(globToRegExp);
	const changed = new Set([...gitChangedPaths(cwd, `${baseRef}...HEAD`), ...gitWorkingPaths(cwd)]);
	const stripped = [...changed].filter((p) => p !== "" && !keep.some((re) => re.test(p))).sort();
	if (stripped.length === 0) {
		fail(
			`nothing to strip — no implementation change against ${baseRef} ` +
				"(tests, canonical docs, and .stdd/ are kept in place); nothing recorded",
		);
	}
	let entries;
	try {
		entries = stripped.map((relative) => ({
			path: relative,
			current: currentState(cwd, relative),
			base: baseState(cwd, mergeBase, relative),
		}));
	} catch (err) {
		fail(`${err.message} — nothing stripped, nothing recorded`);
	}
	return { baseRef, mergeBase, backupDir, entries };
}

function removeEmptyParents(cwd, relative) {
	let dir = path.dirname(path.join(cwd, relative));
	const root = path.resolve(cwd);
	while (dir !== root && dir.startsWith(root)) {
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
		throw new Error(`${relative} became a directory during the run; it was not restored`);
	}
	fs.rmSync(abs);
}

function writeState(cwd, relative, state, bytesFrom) {
	const abs = path.join(cwd, relative);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	if (state.kind === "symlink") {
		fs.symlinkSync(state.target, abs);
		return;
	}
	if (bytesFrom) fs.copyFileSync(bytesFrom, abs);
	else fs.writeFileSync(abs, state.bytes);
	fs.chmodSync(abs, state.mode);
}

/** Save every stripped path under the backup, then put its merge-base content (or nothing) in place. */
function strip(cwd, plan) {
	fs.mkdirSync(plan.backupDir, { recursive: true, mode: 0o700 });
	const manifest = {
		version: MANIFEST_VERSION,
		repository: fs.realpathSync(cwd),
		baseRef: plan.baseRef,
		mergeBase: plan.mergeBase,
		entries: plan.entries.map((entry, index) => ({
			path: entry.path,
			kind: entry.current.kind,
			...(entry.current.kind === "file" ? { mode: entry.current.mode, backup: String(index) } : {}),
			...(entry.current.kind === "symlink" ? { target: entry.current.target } : {}),
		})),
	};
	for (const [index, entry] of plan.entries.entries()) {
		if (entry.current.kind === "file") {
			fs.copyFileSync(path.join(cwd, entry.path), path.join(plan.backupDir, String(index)));
		}
	}
	fs.writeFileSync(
		path.join(plan.backupDir, MANIFEST_NAME),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	for (const entry of plan.entries) {
		const abs = path.join(cwd, entry.path);
		removePath(abs, entry.path);
		if (entry.base) writeState(cwd, entry.path, entry.base, null);
		else removeEmptyParents(cwd, entry.path);
	}
}

/** Put every saved path back exactly as it was. Idempotent per plan. */
function restore(cwd, plan) {
	if (plan.restored) return;
	plan.restored = true;
	for (const [index, entry] of plan.entries.entries()) {
		const abs = path.join(cwd, entry.path);
		removePath(abs, entry.path);
		if (entry.current.kind === "absent") removeEmptyParents(cwd, entry.path);
		else
			writeState(
				cwd,
				entry.path,
				entry.current,
				entry.current.kind === "file" ? path.join(plan.backupDir, String(index)) : null,
			);
	}
}

function changedDirtyPaths(before, after) {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter((key) => before[key] !== after[key]).sort();
}

function emit(result) {
	if (result?.stdout) process.stdout.write(result.stdout);
	if (result?.stderr) process.stderr.write(result.stderr);
}

/**
 * `stdd red --without-impl -- <cmd>`: strip, run through the ordinary red
 * recorder, restore, and refuse to record when the restored checkout does
 * not match the snapshot taken before the strip.
 */
export function redWithoutImpl(cwd, argv) {
	recordRun(cwd, "red", argv, {
		wrap(run) {
			const config = loadConfig(cwd);
			const plan = planStrip(cwd, config);
			const stripped = plan.entries.map((entry) => entry.path);
			const headBefore = gitText(cwd, ["rev-parse", "HEAD"]);
			const dirtyBefore = dirtySnapshot(cwd);
			const snapshotBefore = checkoutSnapshot(cwd);
			const recover = (signal) => {
				let message = `${LABEL}: interrupted by ${signal}`;
				try {
					restore(cwd, plan);
					fs.rmSync(plan.backupDir, { recursive: true, force: true });
					message += "; the stripped paths were restored";
				} catch (err) {
					message += `; restore failed (${err.message}) — the backup is kept at ${plan.backupDir}`;
				}
				fs.writeSync(process.stderr.fd, `${message}\n`);
			};
			const onSignal = (signal) => {
				recover(signal);
				process.exit(128 + RECOVERY_SIGNALS[signal]);
			};
			const onException = (err) => {
				recover(`an uncaught exception: ${err?.message ?? String(err)}`);
				process.exit(1);
			};
			for (const signal of Object.keys(RECOVERY_SIGNALS)) process.on(signal, onSignal);
			process.on("uncaughtException", onException);

			let result = null;
			let restoreError = null;
			try {
				strip(cwd, plan);
				console.error(
					`${LABEL}: stripped ${stripped.length} path(s) against ${plan.baseRef} (merge base ${plan.mergeBase.slice(0, 12)}):`,
				);
				for (const p of stripped) console.error(`  ${p}`);
				result = run();
			} finally {
				try {
					restore(cwd, plan);
				} catch (err) {
					restoreError = err;
				}
				for (const signal of Object.keys(RECOVERY_SIGNALS)) process.off(signal, onSignal);
				process.off("uncaughtException", onException);
			}
			if (restoreError) {
				emit(result);
				fail(
					`${LABEL}: restore failed — ${restoreError.message}; the backup is kept at ${plan.backupDir}; nothing recorded`,
				);
			}
			const headAfter = gitText(cwd, ["rev-parse", "HEAD"]);
			const dirtyAfter = dirtySnapshot(cwd);
			if (checkoutSnapshot(cwd) !== snapshotBefore) {
				emit(result);
				const differing = changedDirtyPaths(dirtyBefore, dirtyAfter);
				fail(
					`${LABEL}: the checkout differs after the restore` +
						(headAfter !== headBefore ? ` (HEAD moved from ${headBefore} to ${headAfter})` : "") +
						(differing.length ? ` — ${differing.join(", ")}` : "") +
						`; the stripped paths were written back and the backup is kept at ${plan.backupDir} — ` +
						"inspect the tree, then remove that directory; nothing recorded",
				);
			}
			fs.rmSync(plan.backupDir, { recursive: true, force: true });
			console.error(
				`${LABEL}: restored ${stripped.length} path(s); the checkout matches its pre-run snapshot`,
			);
			return { result, fields: { mode: RED_WITHOUT_IMPL_MODE, stripped } };
		},
	});
}
