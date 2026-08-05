// --- checkout, dirty, worker, and review observations ---
//
// Owns every filesystem observation the loop compares against itself: the
// checkout and dirty-path fingerprints, the managed-worker tree walk, and the
// review material a brief is built from. Bytes leave this module only through a
// verified descriptor. It has no dependency on the entry module.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameFileObservation } from "../sdk/file-observation.mjs";
import {
	currentTaskPlan,
	isStateExemptPath,
	isTrustedLedgerInternalTemp,
	STATE_EXEMPT,
} from "./ledger.mjs";
import { deferredSectionRange, sha256 } from "./lib.mjs";
import {
	absPathBuf,
	bufferPathIsWithin,
	parentPathBuf,
	pathForMatch,
	realPathBuf,
	splitNul,
	viewPath,
} from "./path-bytes.mjs";
import { fail, MAX_SUBPROCESS_BUFFER, subprocessError } from "./runtime.mjs";
import { readWorkerPathState, sameWorkerState, workerViewPath } from "./worker-fs.mjs";
import { readWorkerMetadata, WORKER_METADATA_REL } from "./worker-metadata.mjs";

export const DIRTY_FINGERPRINT_READ_LIMIT = 40_000;

function snapshotStatMetadata(st) {
	return [st.dev, st.ino, st.uid, st.gid, st.mode, st.nlink, st.size, st.mtimeNs, st.ctimeNs].join(":");
}

function snapshotOwnerIsCurrent(st) {
	return typeof process.getuid !== "function" || st.uid === BigInt(process.getuid());
}

function sameSnapshotFileObservation(left, right) {
	return sameFileObservation(left, right) && left.uid === right.uid && left.gid === right.gid;
}

function unsafeSnapshotFingerprint(kind, st) {
	return `${kind}:${st ? snapshotStatMetadata(st) : "unstattable"}`;
}

/** Historical raw-byte fingerprint, now read only through a verified fd. */
function fingerprintRawSnapshotDescriptor(descriptor) {
	const hash = createHash("sha256");
	const chunk = Buffer.alloc(64 * 1024);
	let position = 0;
	for (;;) {
		const count = fs.readSync(descriptor, chunk, 0, chunk.length, position);
		if (count === 0) break;
		hash.update(chunk.subarray(0, count));
		position += count;
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Brief-inspection fingerprint for one already-verified descriptor.
 * Oversized files bind a bounded prefix to identity and change metadata;
 * no inspection descriptor reads beyond the inline bound.
 */
function fingerprintBoundedReviewDescriptor(descriptor, opened, retainBytes = false) {
	const oversized = opened.size > BigInt(DIRTY_FINGERPRINT_READ_LIMIT);
	const expected = Number(
		opened.size < BigInt(DIRTY_FINGERPRINT_READ_LIMIT)
			? opened.size
			: BigInt(DIRTY_FINGERPRINT_READ_LIMIT),
	);
	const hash = createHash("sha256");
	if (oversized) {
		hash.update(`stdd-bounded-file-v1:${snapshotStatMetadata(opened)}\n`);
	}
	const retained = retainBytes ? Buffer.alloc(expected) : null;
	const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(expected, 1)));
	let position = 0;
	while (position < expected) {
		const count = fs.readSync(
			descriptor,
			chunk,
			0,
			Math.min(chunk.length, expected - position),
			position,
		);
		if (count === 0) break;
		hash.update(chunk.subarray(0, count));
		if (retained !== null) chunk.copy(retained, position, 0, count);
		position += count;
	}
	return {
		fingerprint: `sha256:${hash.digest("hex")}`,
		bytes: retained?.subarray(0, position) ?? null,
		complete: position === expected,
		oversized,
	};
}

function fingerprintDirtyPath(abs, observed, boundedReview) {
	if (observed.isSymbolicLink()) {
		try {
			const target = fs.readlinkSync(abs, "buffer");
			const after = fs.lstatSync(abs, { bigint: true });
			if (!after.isSymbolicLink() || !sameSnapshotFileObservation(observed, after)) {
				return unsafeSnapshotFingerprint("unsafe", observed);
			}
			return sha256(`link:${target.toString("latin1")}`);
		} catch {
			return unsafeSnapshotFingerprint("unsafe", observed);
		}
	}
	if (!observed.isFile() || observed.nlink !== 1n || !snapshotOwnerIsCurrent(observed)) {
		return unsafeSnapshotFingerprint("unsafe", observed);
	}

	let descriptor = null;
	try {
		descriptor = fs.openSync(
			abs,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const pathAtOpen = fs.lstatSync(abs, { bigint: true });
		if (
			!opened.isFile() ||
			opened.nlink !== 1n ||
			!snapshotOwnerIsCurrent(opened) ||
			pathAtOpen.isSymbolicLink() ||
			!pathAtOpen.isFile() ||
			pathAtOpen.nlink !== 1n ||
			!snapshotOwnerIsCurrent(pathAtOpen) ||
			!sameSnapshotFileObservation(observed, opened) ||
			!sameSnapshotFileObservation(opened, pathAtOpen)
		) {
			return unsafeSnapshotFingerprint("unsafe", observed);
		}
		const fingerprint = boundedReview
			? fingerprintBoundedReviewDescriptor(descriptor, opened)
			: {
					fingerprint: fingerprintRawSnapshotDescriptor(descriptor),
					complete: true,
				};
		const after = fs.fstatSync(descriptor, { bigint: true });
		const finalPath = fs.lstatSync(abs, { bigint: true });
		if (
			!fingerprint.complete ||
			finalPath.isSymbolicLink() ||
			!finalPath.isFile() ||
			finalPath.nlink !== 1n ||
			!snapshotOwnerIsCurrent(after) ||
			!snapshotOwnerIsCurrent(finalPath) ||
			!sameSnapshotFileObservation(opened, after) ||
			!sameSnapshotFileObservation(after, finalPath)
		) {
			return unsafeSnapshotFingerprint("unsafe", observed);
		}
		return fingerprint.fingerprint;
	} catch (err) {
		return unsafeSnapshotFingerprint(err.code === "EACCES" ? "unreadable" : "unsafe", observed);
	} finally {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The descriptor is no longer part of the snapshot after the verified read.
			}
		}
	}
}

/**
 * Content hashes of every dirty (staged, unstaged, untracked) path.
 * Deleted paths and untracked directories hash to null — equality of
 * nulls still distinguishes inherited state from a slice's own edits.
 */
export function dirtySnapshot(cwd, { boundedReview = false } = {}) {
	const worker = readWorkerMetadata(cwd);
	if (worker) {
		try {
			return workerDirtySnapshot(worker.root, worker);
		} catch (err) {
			fail(err.message);
		}
	}
	// -z: NUL-delimited, no C-style octal quoting — read as raw bytes so a
	// non-UTF-8 filename is never folded to U+FFFD (which would collapse
	// distinct paths and look up files at the wrong location, letting an
	// untracked doc's content change without staling a review).
	// --untracked-files=all: a wholly untracked directory must list every
	// file inside it, or edits there would never change the snapshot
	const tokens = splitNul(
		execFileSync("git", ["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all"], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		}),
	);
	// null-prototype: a file literally named `__proto__` (or `constructor`)
	// must be an own data property, not a write through Object.prototype's
	// setter — otherwise its fingerprint vanishes and edits never stale
	const dirty = Object.create(null);
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i];
		if (entry.length === 0) continue;
		const xy = entry.subarray(0, 2).toString("latin1"); // status bytes are ASCII
		const p = pathForMatch(entry.subarray(3)); // latin1, byte-exact key
		// a rename/copy entry is followed by the origin path token — the
		// current path is what the snapshot tracks
		if (/[RC]/.test(xy)) i++;
		if (isStateExemptPath(cwd, p)) continue;
		// the filesystem path is built from raw bytes, not a decoded string,
		// so a non-UTF-8 name is stat/read at its true location
		const abs = absPathBuf(cwd, p);
		// lstat: a stable symlink is fingerprinted by its target PATH — the
		// change is the link itself. Regular bytes are read only through a
		// no-follow, nonblocking descriptor tied back to this observation.
		let st = null;
		let statError = null;
		try {
			st = p.endsWith("/") ? null : fs.lstatSync(abs, { bigint: true });
		} catch (err) {
			statError = err;
			st = null;
		}
		dirty[p] =
			st === null
				? statError && statError.code !== "ENOENT"
					? unsafeSnapshotFingerprint("unreadable", null)
					: null
				: fingerprintDirtyPath(abs, st, boundedReview);
	}
	return dirty;
}

/**
 * Bind a recorded loop fact to the exact checkout that produced it. HEAD is
 * included deliberately: committing after verification requires a fresh run
 * on the commit that will actually be reviewed and pushed.
 */
export function checkoutSnapshot(cwd) {
	let head;
	try {
		head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		head = readWorkerMetadata(cwd)?.source.head ?? "(no HEAD)";
	}
	const dirty = dirtySnapshot(cwd);
	return sha256(`${head}\n${JSON.stringify(dirty)}`);
}

function workerIgnoredPaths(root, relativePaths, gitDir) {
	if (relativePaths.length === 0) return new Set();
	try {
		const input = Buffer.concat(relativePaths.map((relative) => Buffer.from(`${relative}\0`)));
		const output = execFileSync(
			"git",
			[`--git-dir=${gitDir}`, `--work-tree=${root}`, "check-ignore", "--no-index", "-z", "--stdin"],
			{ cwd: root, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: MAX_SUBPROCESS_BUFFER },
		);
		return new Set(splitNul(output).map((entry) => entry.toString("utf8")));
	} catch (err) {
		if (err.status === 1) return new Set();
		throw new Error(`cannot evaluate sandbox ignore rules: ${err.message}`);
	}
}

function workerTreeFiles(root, metadata) {
	const files = new Set();
	const baselinePaths = Object.keys(metadata.baseline.files);
	const baselinePrefixes = new Set();
	for (const baseline of baselinePaths) {
		let prefix = path.posix.dirname(baseline);
		while (prefix !== ".") {
			baselinePrefixes.add(prefix);
			prefix = path.posix.dirname(prefix);
		}
	}
	const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-ignore-"));
	const walk = (directory, prefix = "") => {
		const entries = fs.readdirSync(directory, { withFileTypes: true, encoding: "buffer" });
		const names = entries.map((entry) => {
			const name = entry.name.toString("utf8");
			if (!Buffer.from(name, "utf8").equals(entry.name)) {
				throw new Error("managed worker sandbox does not support non-UTF-8 paths");
			}
			return name;
		});
		const relatives = names.map((name) => (prefix ? `${prefix}/${name}` : name));
		const ignored = workerIgnoredPaths(root, relatives, gitDir);
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			const relative = relatives[index];
			const carriesBaseline =
				Object.hasOwn(metadata.baseline.files, relative) || baselinePrefixes.has(relative);
			if (ignored.has(relative) && !carriesBaseline) continue;
			if (relative.split("/").includes(".git")) {
				throw new Error(`managed worker sandbox must not contain .git: ${workerViewPath(relative)}`);
			}
			if (isStateExemptPath(root, relative) || relative === WORKER_METADATA_REL) continue;
			const absolute = path.join(directory, names[index]);
			if (entry.isDirectory()) walk(absolute, relative);
			else files.add(relative);
		}
	};
	try {
		execFileSync("git", ["init", "--bare", "-q", gitDir], { stdio: "ignore" });
		walk(root);
		return [...files].sort();
	} finally {
		fs.rmSync(gitDir, { recursive: true, force: true });
	}
}

export function workerCurrentStates(root, metadata) {
	const paths = new Set([...Object.keys(metadata.baseline.files), ...workerTreeFiles(root, metadata)]);
	const states = Object.create(null);
	for (const relative of paths) states[relative] = readWorkerPathState(root, relative).state;
	return states;
}

export function workerDirtySnapshot(root, metadata) {
	const current = workerCurrentStates(root, metadata);
	const dirty = Object.create(null);
	for (const relative of new Set([...Object.keys(metadata.baseline.files), ...Object.keys(current)])) {
		const before = metadata.baseline.files[relative] ?? null;
		const after = current[relative] ?? null;
		if (!sameWorkerState(before, after)) {
			dirty[relative] = after?.hash ?? null;
		}
	}
	return dirty;
}

// Only the WORKING artifacts are exempt from review evidence — recording
// events must never invalidate a review. Tracked .stdd/ deliverables
// (config, generated kit) stay under review like any other file.
const REVIEW_EXEMPT = STATE_EXEMPT;

function reviewExemptPathspecs(cwd) {
	const trustedTemps = [];
	try {
		for (const name of fs.readdirSync(path.join(cwd, ".stdd"))) {
			const relative = `.stdd/${name}`;
			if (isTrustedLedgerInternalTemp(cwd, relative)) trustedTemps.push(relative);
		}
	} catch {
		// An absent/unreadable state directory contributes no trusted exemption.
	}
	return [...REVIEW_EXEMPT, ...trustedTemps].map((p) => `:(exclude,literal)${p}`);
}

/**
 * The diff under review. `strict` aborts on an unresolvable base — a
 * review of an unavailable diff proves nothing and must not be recordable;
 * status/gate callers stay tolerant and get a placeholder instead.
 */
function reviewDiff(cwd, baseRef, strict) {
	try {
		return execFileSync(
			"git",
			[
				"-C",
				cwd,
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--full-index",
				"--end-of-options",
				baseRef,
				"--",
				".",
				...reviewExemptPathspecs(cwd),
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: MAX_SUBPROCESS_BUFFER,
			},
		);
	} catch {
		if (strict) {
			fail(
				`cannot diff against "${baseRef}" — fetch the base ref or fix "baseRef" in .stdd/config.json`,
			);
		}
		return Buffer.from("(unresolvable base)");
	}
}

/**
 * The plan as snapshot material: checkbox marks are normalized away — they are
 * claims graded by the ledger — and so is the `## Deferred` section, which
 * holds recorded scope cuts rather than specification. A session that finds
 * something after an approval is told to defer it instead of editing; that
 * move must not destroy the approval it protects. The reviewer still receives
 * the whole plan file in the brief. Editing the plan's words DOES stale a
 * review: the verdict is a comparison against exactly that specification.
 */
function normalizedPlanContent(plan) {
	if (plan === null) return "(no plan for the active task)";
	// Line endings are normalized before anything else, and unconditionally:
	// doing it only on the branch that finds a section would make the first
	// `stdd defer` on a CRLF plan look like an edit.
	const lines = plan.replaceAll("\r\n", "\n").split("\n");
	const section = deferredSectionRange(lines);
	const kept =
		section === null ? lines : [...lines.slice(0, section.start), ...lines.slice(section.end)];
	return (
		kept
			.join("\n")
			.replace(/^(\s*[-*+]\s+)\[[ xX]\]/gm, "$1[ ]")
			// Trailing newlines are not specification, and creating the section on
			// a plan that lacked a final newline leaves one behind. Adding a line
			// after the last one still reads as the edit it is.
			.replace(/\n+$/, "")
	);
}

/**
 * Every path whose working-tree content differs from `baseRef`, mapped to a
 * content fingerprint. The set is the union of the tracked diff and the
 * untracked entries of `git status`, which makes it invariant under `git add`
 * and `git commit`: staging moves a path between those two inputs and
 * committing empties the second, but neither changes a byte on disk. Keys stay
 * byte-exact latin1, so a non-UTF-8 name is never folded to U+FFFD and two
 * distinct paths never collapse into one.
 *
 * The executable bit rides along because the fingerprint hashes content only,
 * and git itself distinguishes exactly `100644` from `100755`.
 */
function changedContentFingerprints(cwd, baseRef, strict) {
	const paths = new Set(); // latin1, byte-exact keys
	const remember = (p) => {
		if (!isStateExemptPath(cwd, p)) paths.add(p);
	};
	try {
		for (const entry of splitNul(
			execFileSync(
				"git",
				[
					"-C",
					cwd,
					"diff",
					"--name-only",
					"-z",
					// Rename detection makes the path set depend on the index: an
					// unstaged rename reads as a deletion plus an untracked file,
					// and a staged one collapses to the destination alone. Reporting
					// both sides always keeps the set invariant under `git add`.
					"--no-renames",
					"--end-of-options",
					baseRef,
					"--",
					".",
					...reviewExemptPathspecs(cwd),
				],
				{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_SUBPROCESS_BUFFER },
			),
		)) {
			if (entry.length > 0) remember(pathForMatch(entry));
		}
	} catch (err) {
		if (strict) {
			fail(
				`cannot diff against "${baseRef}" — fetch the base ref or fix "baseRef" in .stdd/config.json`,
			);
		}
		return { "(unresolvable base ref)": subprocessError(err) };
	}
	const statusTokens = splitNul(
		execFileSync("git", ["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all"], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		}),
	);
	for (let i = 0; i < statusTokens.length; i++) {
		const entry = statusTokens[i];
		if (entry.length === 0) continue;
		const xy = entry.subarray(0, 2).toString("latin1"); // status bytes are ASCII
		// a rename/copy entry is followed by its origin path token; consume it
		// here or the next iteration would read that path as a status entry
		if (/[RC]/.test(xy)) {
			i++;
			continue;
		}
		if (xy === "??") remember(pathForMatch(entry.subarray(3)));
	}

	const gitlinks = gitlinkRecords(cwd, baseRef);
	// null-prototype for the same reason dirtySnapshot uses one: a file named
	// `__proto__` must be an own data property, not a write through the setter
	const changed = Object.create(null);
	for (const key of [...paths].sort()) {
		const abs = absPathBuf(cwd, key);
		let st = null;
		let statError = null;
		try {
			st = key.endsWith("/") ? null : fs.lstatSync(abs, { bigint: true });
		} catch (err) {
			statError = err;
			st = null;
		}
		if (st === null) {
			changed[key] =
				statError && statError.code !== "ENOENT" ? unsafeSnapshotFingerprint("unreadable", null) : null;
			continue;
		}
		if (st.isDirectory()) {
			// A gitlink differs from base by the commit it points at, which no
			// filesystem fingerprint of the directory can see. Git resolves the
			// worktree side of the pointer, so its raw record is the content.
			changed[key] = gitlinkFingerprint(cwd, key, gitlinks.has(key), gitlinks.get(key), st);
			continue;
		}
		const fingerprint = fingerprintDirtyPath(abs, st, false);
		// A sentinel is stored bare so the strict rejection below still
		// recognizes it by prefix.
		if (fingerprint.startsWith("unsafe:") || fingerprint.startsWith("unreadable:")) {
			changed[key] = fingerprint;
			continue;
		}
		// The object type leads, because a symlink's fingerprint hashes the
		// string `link:<target>` and a regular file holding exactly those bytes
		// would otherwise be indistinguishable from it. git records exactly
		// 100644 or 100755 and derives that from the OWNER execute bit alone, so
		// group and other execute are not part of what the snapshot compares.
		const kind = st.isSymbolicLink() ? "link" : "blob";
		changed[key] = `${kind}:${fingerprint}:${(st.mode & 0o100n) === 0n ? "-" : "x"}`;
	}
	return changed;
}

/**
 * One gitlink's snapshot record: always the submodule's checked-out HEAD, and
 * never git's raw destination id. That id is the indexed pointer and is
 * all-zeros while the submodule is out of sync, so reading it would give the
 * same worktree pointer two spellings and let `git add` alone stale a review.
 *
 * A directory is only a gitlink when git says so. Without that gate an
 * ordinary directory left where a tracked file used to be would resolve
 * through the parent repository and hash as a plausible pointer instead of
 * being refused. Anything unresolvable stays unsafe, which strict dispatch
 * rejects rather than approving a tree it could not read.
 */
function gitlinkFingerprint(cwd, latin1, isGitlink, indexed, st) {
	if (!isGitlink) return unsafeSnapshotFingerprint("unsafe", st);
	const head = submoduleHead(cwd, latin1);
	// One spelling for one pointer. A checked-out submodule answers with its
	// own HEAD, which is what the reviewer's diff shows and what neither
	// staging nor committing can change. Git's own id is the indexed pointer:
	// it is all-zeros while the checkout is out of sync, so it serves only the
	// uninitialized case, where there is no checkout to ask and the recorded
	// pointer is the whole truth.
	// The reviewer's diff carries git's `-dirty` marker for a submodule whose
	// worktree has uncommitted work, so the snapshot carries it too.
	if (head !== null) return `gitlink:${head}:${submoduleIsDirty(cwd, latin1) ? "dirty" : "clean"}`;
	if (indexed) return `gitlink:${indexed}:absent`;
	return unsafeSnapshotFingerprint("unsafe", st);
}

/** Whether the submodule checkout has uncommitted work, as git's marker reads it. */
function submoduleIsDirty(cwd, latin1) {
	const directory = submoduleDirectory(cwd, latin1);
	if (directory === null) return true;
	try {
		return (
			execFileSync("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"], {
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: MAX_SUBPROCESS_BUFFER,
			}).length > 0
		);
	} catch {
		return true;
	}
}

/**
 * The submodule's directory as a string git can take after `-C`, or null when
 * the name is not valid UTF-8 and therefore cannot be handed over without
 * corruption.
 */
function submoduleDirectory(cwd, latin1) {
	const bytes = Buffer.from(latin1, "latin1");
	const utf8 = bytes.toString("utf8");
	if (!Buffer.from(utf8, "utf8").equals(bytes)) return null;
	return path.join(cwd, utf8);
}

/** The submodule's checked-out HEAD, or null when there is no checkout to ask. */
function submoduleHead(cwd, latin1) {
	const directory = submoduleDirectory(cwd, latin1);
	if (directory === null) return null;
	try {
		const [head, toplevel] = execFileSync(
			"git",
			["-C", directory, "rev-parse", "HEAD", "--show-toplevel"],
			{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_SUBPROCESS_BUFFER },
		)
			.toString("utf8")
			.trim()
			.split("\n");
		if (!/^[0-9a-f]{40,}$/.test(head ?? "")) return null;
		// the submodule must be its own repository root; resolving to an
		// enclosing one would report the superproject's HEAD as this pointer
		if (path.resolve(toplevel ?? "") !== path.resolve(directory)) return null;
		return head;
	} catch {
		return null;
	}
}

/**
 * The changed paths git reports as gitlinks, keyed byte-exactly. Only their
 * identity is taken from here — the pointer itself is read from the submodule
 * checkout, because the id in this record is the indexed one.
 */
function gitlinkRecords(cwd, baseRef) {
	const records = new Map();
	let output;
	try {
		output = execFileSync(
			"git",
			[
				"-C",
				cwd,
				"diff",
				"--raw",
				"-z",
				"--no-renames", // same reason as the name-only pass: one path set
				"--end-of-options",
				baseRef,
				"--",
				".",
				...reviewExemptPathspecs(cwd),
			],
			{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_SUBPROCESS_BUFFER },
		);
	} catch {
		return records;
	}
	const tokens = splitNul(output);
	for (let i = 0; i < tokens.length; i++) {
		const meta = tokens[i].toString("latin1");
		if (!meta.startsWith(":")) continue;
		// :<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>[\0<dest>]
		const fields = meta.slice(1).split(" ");
		if (fields.length < 5) continue;
		const [srcMode, dstMode, , dstSha, status] = fields;
		let p = tokens[++i];
		if (p === undefined) break;
		// a rename or copy emits source then destination; the destination is the
		// path that exists now, and it is the one the snapshot tracks
		if (/^[RC]/.test(status)) {
			const destination = tokens[++i];
			if (destination === undefined) break;
			p = destination;
		}
		if (srcMode !== "160000" && dstMode !== "160000") continue;
		records.set(pathForMatch(p), /^0+$/.test(dstSha ?? "") ? null : dstSha);
	}
	return records;
}

function capturedChangedFiles(cwd, baseRef, strict) {
	try {
		return execFileSync(
			"git",
			[
				"-C",
				cwd,
				"diff",
				"--name-status",
				"-z",
				"--end-of-options",
				baseRef,
				"--",
				".",
				...reviewExemptPathspecs(cwd),
			],
			{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_SUBPROCESS_BUFFER },
		);
	} catch (err) {
		if (strict) {
			fail(`cannot enumerate changed files — review aborted (git: ${subprocessError(err)})`);
		}
		return Buffer.from("(unresolvable changed-file manifest)");
	}
}

function capturedPorcelain(cwd) {
	try {
		return execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "(unavailable)";
	}
}

function capturedUntrackedFiles(cwd, strict) {
	try {
		return execFileSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		});
	} catch (err) {
		if (strict) {
			fail(`cannot enumerate untracked files — review aborted (git: ${subprocessError(err)})`);
		}
		return Buffer.from("(unresolvable untracked-file manifest)");
	}
}

export function captureReviewMaterial(cwd, baseRef, strict = false) {
	const diffBytes = reviewDiff(cwd, baseRef, strict);
	const diff = diffBytes.toString("utf8");
	const dirty = dirtySnapshot(cwd);
	const reviewDirty = dirtySnapshot(cwd, { boundedReview: true });
	const changedContent = changedContentFingerprints(cwd, baseRef, strict);
	if (strict) {
		// A review over bytes that cannot be fingerprinted safely proves
		// nothing. Soft callers retain the metadata sentinel for stale logic,
		// but dispatch/grading rejects unreadable, raced, hard-linked, and
		// non-regular paths — including a committed one that git status calls
		// clean, since the snapshot now reads those too.
		const maps = [dirty, reviewDirty, changedContent];
		const unsafe = [...new Set(maps.flatMap((m) => Object.keys(m)))].filter((p) =>
			maps.some((m) => m[p]?.startsWith?.("unreadable:") || m[p]?.startsWith?.("unsafe:")),
		);
		if (unsafe.length > 0) {
			// the keys are latin1 byte-exact; render them through the one view
			// seam so a non-UTF-8 or control-byte name reads right and cannot
			// inject a line into the message
			fail(
				`file(s) cannot be fingerprinted safely — nothing to review there: ${unsafe
					.map(viewPath)
					.join(", ")}`,
			);
		}
	}
	const plan = currentTaskPlan(cwd);
	const changedFiles = capturedChangedFiles(cwd, baseRef, strict);
	const porcelain = capturedPorcelain(cwd);
	const untrackedFiles = capturedUntrackedFiles(cwd, strict);
	const snapshot = sha256(`${JSON.stringify(changedContent)}\n${normalizedPlanContent(plan)}`);
	// The durable snapshot deliberately retains its long-standing exemptions
	// (ledger/plan bookkeeping and trusted reset temps). The ephemeral
	// material binding is stricter: every independent read consumed while
	// composing the brief must agree before and after the build.
	const materialBinding = sha256(
		`${snapshot}\n${JSON.stringify(reviewDirty)}\n${sha256(changedFiles)}\n${porcelain}\n${sha256(
			untrackedFiles,
		)}`,
	);
	return {
		snapshot,
		materialBinding,
		diffBytes,
		diff,
		dirty,
		reviewDirty,
		plan,
		changedFiles,
		porcelain,
		untrackedFiles,
	};
}

/**
 * Hash of the work under review: the content of every path that differs from
 * baseRef — tracked or untracked, committed or not — plus the plan's text,
 * `.stdd/` excluded, because the ledger and the plan are working artifacts and
 * recording the review itself must not invalidate it. Content, never git's
 * bookkeeping: staging or committing the reviewed work moves no bytes on disk
 * and therefore cannot stale a verdict about those bytes.
 */
export function reviewSnapshot(cwd, baseRef, strict = false) {
	return captureReviewMaterial(cwd, baseRef, strict).snapshot;
}

/**
 * Inspect one review path through a descriptor. No bytes are returned until
 * the opened inode and its parent have been proven to be stable, regular, and
 * contained by the repository both before and after the bounded read.
 */
export function inspectReviewPath(cwd, latin1, realRoot, readLimit = null) {
	const absolute = absPathBuf(cwd, latin1);
	const parent = parentPathBuf(absolute);
	let before;
	let parentBefore;
	try {
		before = fs.lstatSync(absolute, { bigint: true });
		parentBefore = fs.lstatSync(parent, { bigint: true });
	} catch (err) {
		return {
			kind: err.code === "ENOENT" ? "missing" : "unsafe",
			reason: err.code === "ENOENT" ? "missing or deleted" : "metadata could not be read safely",
		};
	}
	if (
		before.isSymbolicLink() ||
		!before.isFile() ||
		before.nlink !== 1n ||
		parentBefore.isSymbolicLink() ||
		!parentBefore.isDirectory()
	) {
		return {
			kind: "unsafe",
			reason: "symlink, hard-linked, or non-regular filesystem object",
		};
	}

	let descriptor = null;
	try {
		const realParentBefore = realPathBuf(parent);
		if (!bufferPathIsWithin(realRoot, realParentBefore)) {
			return { kind: "unsafe", reason: "parent resolves outside the repository" };
		}
		descriptor = fs.openSync(
			absolute,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const pathAtOpen = fs.lstatSync(absolute, { bigint: true });
		const parentAtOpen = fs.lstatSync(parent, { bigint: true });
		const realParentAtOpen = realPathBuf(parent);
		const realFileAtOpen = realPathBuf(absolute);
		if (
			!opened.isFile() ||
			opened.nlink !== 1n ||
			pathAtOpen.isSymbolicLink() ||
			!pathAtOpen.isFile() ||
			!sameFileObservation(before, opened) ||
			!sameFileObservation(opened, pathAtOpen) ||
			!sameFileObservation(parentBefore, parentAtOpen) ||
			!bufferPathIsWithin(realRoot, realParentAtOpen) ||
			!bufferPathIsWithin(realRoot, realFileAtOpen)
		) {
			return { kind: "unsafe", reason: "changed or escaped during descriptor inspection" };
		}

		let bytes = null;
		let truncated = false;
		let contentHash = null;
		if (readLimit !== null) {
			const fingerprinted = fingerprintBoundedReviewDescriptor(descriptor, opened, true);
			if (!fingerprinted.complete) {
				return { kind: "unsafe", reason: "changed or ended during bounded descriptor read" };
			}
			bytes = fingerprinted.bytes;
			truncated = fingerprinted.oversized;
			contentHash = fingerprinted.fingerprint;
		}

		const after = fs.fstatSync(descriptor, { bigint: true });
		const finalPath = fs.lstatSync(absolute, { bigint: true });
		const finalParent = fs.lstatSync(parent, { bigint: true });
		const realParentAfter = realPathBuf(parent);
		const realFileAfter = realPathBuf(absolute);
		if (
			finalPath.isSymbolicLink() ||
			!finalPath.isFile() ||
			!sameFileObservation(opened, after) ||
			!sameFileObservation(after, finalPath) ||
			!sameFileObservation(parentBefore, finalParent) ||
			!bufferPathIsWithin(realRoot, realParentAfter) ||
			!bufferPathIsWithin(realRoot, realFileAfter)
		) {
			return { kind: "unsafe", reason: "changed or escaped while being inspected" };
		}
		return { kind: "regular", bytes, truncated, contentHash };
	} catch (err) {
		return {
			kind: "unsafe",
			reason:
				err.code === "ELOOP"
					? "became a symlink during inspection"
					: "could not be inspected without following filesystem replacements",
		};
	} finally {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The descriptor no longer participates in the brief once inspection returns.
			}
		}
	}
}
