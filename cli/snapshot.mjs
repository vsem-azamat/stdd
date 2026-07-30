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
import {
	currentTaskPlan,
	isStateExemptPath,
	isTrustedLedgerInternalTemp,
	STATE_EXEMPT,
} from "./ledger.mjs";
import { sha256 } from "./lib.mjs";
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
	return sameReviewFileObservation(left, right) && left.uid === right.uid && left.gid === right.gid;
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
 * The plan as snapshot material: checkbox marks are normalized away —
 * they are claims graded by the ledger. Editing the plan's words DOES
 * stale a review: the verdict is a comparison against exactly that
 * specification.
 */
function normalizedPlanContent(plan) {
	if (plan === null) return "(no plan for the active task)";
	return plan.replace(/^(\s*[-*+]\s+)\[[ xX]\]/gm, "$1[ ]");
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
	if (strict) {
		// A review over bytes that cannot be fingerprinted safely proves
		// nothing. Soft callers retain the metadata sentinel for stale logic,
		// but dispatch/grading rejects unreadable, raced, hard-linked, and
		// non-regular dirty paths.
		const unsafe = [...new Set([...Object.keys(dirty), ...Object.keys(reviewDirty)])].filter(
			(p) =>
				dirty[p]?.startsWith("unreadable:") ||
				dirty[p]?.startsWith("unsafe:") ||
				reviewDirty[p]?.startsWith("unreadable:") ||
				reviewDirty[p]?.startsWith("unsafe:"),
		);
		if (unsafe.length > 0) {
			// the keys are latin1 byte-exact; render them through the one view
			// seam so a non-UTF-8 or control-byte name reads right and cannot
			// inject a line into the message
			fail(
				`dirty file(s) cannot be fingerprinted safely — nothing to review there: ${unsafe
					.map(viewPath)
					.join(", ")}`,
			);
		}
	}
	const plan = currentTaskPlan(cwd);
	const changedFiles = capturedChangedFiles(cwd, baseRef, strict);
	const porcelain = capturedPorcelain(cwd);
	const untrackedFiles = capturedUntrackedFiles(cwd, strict);
	const snapshot = sha256(
		`${sha256(diffBytes)}\n${JSON.stringify(dirty)}\n${normalizedPlanContent(plan)}`,
	);
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
 * Hash of the work under review: the diff against baseRef plus the
 * dirty-file state, `.stdd/` excluded — the ledger and the plan are
 * working artifacts, never the subject of the review, and recording the
 * review itself must not invalidate it.
 */
export function reviewSnapshot(cwd, baseRef, strict = false) {
	return captureReviewMaterial(cwd, baseRef, strict).snapshot;
}

export function sameReviewFileObservation(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
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
			!sameReviewFileObservation(before, opened) ||
			!sameReviewFileObservation(opened, pathAtOpen) ||
			!sameReviewFileObservation(parentBefore, parentAtOpen) ||
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
			!sameReviewFileObservation(opened, after) ||
			!sameReviewFileObservation(after, finalPath) ||
			!sameReviewFileObservation(parentBefore, finalParent) ||
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
