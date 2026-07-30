import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	publishHeldParentFile,
	sameFileIdentity,
	samePublicationObservation,
} from "../sdk/held-publication.mjs";
import { resolveRepoPath, resolveWritableRepoPath } from "../sdk/path.mjs";
import { openOrCreateHeldGeneratedParent } from "./held-fs.mjs";
import { sha256 } from "./lib.mjs";
import { viewPath } from "./path-bytes.mjs";

export const WORKER_DELETIONS_REL = ".stdd/worker-deletions";

export const workerPathForMatch = (relative) => Buffer.from(relative, "utf8").toString("latin1");
export const workerViewPath = (relative) => viewPath(workerPathForMatch(relative));

export function openWorkerPublicationParent(cwd, parentRelative) {
	if (parentRelative !== ".") return openOrCreateHeldGeneratedParent(cwd, parentRelative);
	const logicalPath = fs.realpathSync(cwd);
	const before = fs.lstatSync(logicalPath);
	const descriptor = fs.openSync(
		logicalPath,
		fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
	);
	const identity = fs.fstatSync(descriptor);
	if (!sameFileIdentity(before, identity)) {
		fs.closeSync(descriptor);
		throw new Error("source checkout root changed before worker publication");
	}
	return { descriptor, logicalPath, identity, heldPath: `/proc/self/fd/${descriptor}` };
}

export function publishWorkerFile(
	cwd,
	relative,
	content,
	mode,
	expectedState,
	assertCollectionContext = null,
) {
	const target = resolveRepoPath(cwd, relative, `worker collection path ${JSON.stringify(relative)}`);
	const parentRelative = path.posix.dirname(relative);
	publishHeldParentFile({
		openDirectory: () => openWorkerPublicationParent(cwd, parentRelative),
		logicalTargetPath: target,
		content,
		mode,
		tempPrefix: ".stdd-worker-collect-",
		identityError: `worker collection path ${JSON.stringify(relative)} changed during publication`,
		noReplace: true,
		onRenameAttempt: () => {
			const liveState = readWorkerPathState(cwd, relative).state;
			if (!sameWorkerState(liveState, expectedState)) {
				throw new Error(`worker collection path ${workerViewPath(relative)} changed after preflight`);
			}
			if (assertCollectionContext !== null) assertCollectionContext();
		},
	});
}

export function assertHeldWorkerDirectory(held, label) {
	const descriptorState = fs.fstatSync(held.descriptor);
	const logicalState = fs.lstatSync(held.logicalPath);
	if (
		!sameFileIdentity(held.identity, descriptorState) ||
		!sameFileIdentity(descriptorState, logicalState) ||
		(typeof process.getuid === "function" && descriptorState.uid !== process.getuid())
	) {
		throw new Error(`${label} changed during worker collection`);
	}
}

export function publishWorkerSymlink(
	cwd,
	relative,
	target,
	workerId,
	expectedState,
	assertCollectionContext = null,
) {
	const parentRelative = path.posix.dirname(relative);
	const held = openWorkerPublicationParent(cwd, parentRelative);
	const name = path.posix.basename(relative);
	const temp = `.stdd-worker-link-${workerId.slice("worker-".length)}-${randomBytes(8).toString("hex")}`;
	try {
		assertHeldWorkerDirectory(held, `parent of ${workerViewPath(relative)}`);
		fs.symlinkSync(target, path.join(held.heldPath, temp));
		const liveState = readWorkerPathState(cwd, relative).state;
		if (!sameWorkerState(liveState, expectedState)) {
			throw new Error(`worker collection path ${workerViewPath(relative)} changed after preflight`);
		}
		if (assertCollectionContext !== null) assertCollectionContext();
		fs.linkSync(path.join(held.heldPath, temp), path.join(held.heldPath, name));
		fs.unlinkSync(path.join(held.heldPath, temp));
		assertHeldWorkerDirectory(held, `parent of ${workerViewPath(relative)}`);
		const logical = resolveRepoPath(cwd, relative, "collected worker symlink");
		const heldState = fs.lstatSync(path.join(held.heldPath, name));
		const observed = fs.lstatSync(logical);
		if (
			!heldState.isSymbolicLink() ||
			!sameFileIdentity(heldState, observed) ||
			fs.readlinkSync(path.join(held.heldPath, name)) !== target ||
			fs.readlinkSync(logical) !== target
		) {
			throw new Error(`worker collection could not verify ${workerViewPath(relative)}`);
		}
	} finally {
		try {
			fs.unlinkSync(path.join(held.heldPath, temp));
		} catch {}
		fs.closeSync(held.descriptor);
	}
}

export function readWorkerPathState(root, relative, { bytes = false } = {}) {
	resolveRepoPath(root, relative, `worker path ${JSON.stringify(relative)}`);
	const relativeParent = path.posix.dirname(relative);
	const safeParent =
		relativeParent === "."
			? root
			: resolveWritableRepoPath(
					root,
					relativeParent,
					`worker path parent ${JSON.stringify(relativeParent)}`,
				);
	const absolute = path.join(safeParent, path.posix.basename(relative));
	let observed;
	try {
		observed = fs.lstatSync(absolute);
	} catch (err) {
		if (err.code === "ENOENT") return { state: null, bytes: null };
		throw err;
	}
	if (observed.isSymbolicLink()) {
		const target = fs.readlinkSync(absolute);
		const after = fs.lstatSync(absolute);
		if (!after.isSymbolicLink() || !sameFileIdentity(observed, after)) {
			throw new Error(`worker path ${workerViewPath(relative)} changed while reading its symlink`);
		}
		return { state: { type: "symlink", target, hash: sha256(`link:${target}`) }, bytes: null };
	}
	if (!observed.isFile() || observed.nlink !== 1) {
		throw new Error(
			`worker path ${workerViewPath(relative)} must be a single-linked regular file or symlink`,
		);
	}
	const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const opened = fs.fstatSync(descriptor);
		if (!samePublicationObservation(observed, opened)) {
			throw new Error(`worker path ${workerViewPath(relative)} changed before it could be read`);
		}
		const content = fs.readFileSync(descriptor);
		const after = fs.fstatSync(descriptor);
		const finalPath = fs.lstatSync(absolute);
		if (!samePublicationObservation(opened, after) || !samePublicationObservation(after, finalPath)) {
			throw new Error(`worker path ${workerViewPath(relative)} changed while reading`);
		}
		return {
			state: { type: "file", hash: sha256(content), mode: observed.mode & 0o777 },
			bytes: bytes ? content : null,
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

export function writeNewWorkerPath(destination, relative, result) {
	const absolute = resolveWritableRepoPath(
		destination,
		relative,
		`worker destination ${JSON.stringify(relative)}`,
	);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	if (result.state === null) return;
	if (result.state.type === "symlink") {
		fs.symlinkSync(result.state.target, absolute);
		return;
	}
	const descriptor = fs.openSync(absolute, "wx", 0o600);
	try {
		fs.writeFileSync(descriptor, result.bytes);
		fs.fchmodSync(descriptor, result.state.mode);
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	const written = fs.lstatSync(absolute);
	if (!written.isFile() || (written.mode & 0o777) !== result.state.mode) {
		throw new Error(`worker destination mode could not be preserved for ${workerViewPath(relative)}`);
	}
}

export function sameWorkerState(left, right) {
	if (left === null || left === undefined || right === null || right === undefined) {
		return (left ?? null) === (right ?? null);
	}
	if (left.type !== right.type || left.hash !== right.hash) return false;
	if (left.type === "file") return left.mode === right.mode;
	if (left.type === "symlink") return left.target === right.target;
	return false;
}

function workerDeletionQuarantinePath(relative, workerId) {
	return `${WORKER_DELETIONS_REL}/${workerId}/${sha256(relative).slice("sha256:".length)}`;
}

export function readWorkerDeletionQuarantineState(cwd, relative, workerId) {
	const root = path.join(cwd, WORKER_DELETIONS_REL);
	const leaf = path.join(root, workerId);
	let rootState;
	let leafState;
	try {
		rootState = fs.lstatSync(root);
		leafState = fs.lstatSync(leaf);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
	const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
	if (
		rootState.isSymbolicLink() ||
		!rootState.isDirectory() ||
		(rootState.mode & 0o777) !== 0o700 ||
		leafState.isSymbolicLink() ||
		!leafState.isDirectory() ||
		(leafState.mode & 0o777) !== 0o700 ||
		(currentUid !== null && (rootState.uid !== currentUid || leafState.uid !== currentUid))
	) {
		throw new Error("worker deletion quarantine is not an owner-private directory");
	}
	return readWorkerPathState(cwd, workerDeletionQuarantinePath(relative, workerId)).state;
}

export function quarantineWorkerDeletion(
	cwd,
	relative,
	workerId,
	expectedState,
	assertCollectionContext = null,
) {
	const parentRelative = path.posix.dirname(relative);
	const quarantineRelative = `${WORKER_DELETIONS_REL}/${workerId}`;
	const sourceName = path.posix.basename(relative);
	const quarantineName = path.posix.basename(workerDeletionQuarantinePath(relative, workerId));
	let sourceParent = null;
	let quarantineRoot = null;
	let quarantine = null;
	try {
		sourceParent = openWorkerPublicationParent(cwd, parentRelative);
		quarantineRoot = openOrCreateHeldGeneratedParent(cwd, WORKER_DELETIONS_REL, 0o700);
		fs.fchmodSync(quarantineRoot.descriptor, 0o700);
		assertHeldWorkerDirectory(quarantineRoot, "worker deletion quarantine root");
		quarantine = openOrCreateHeldGeneratedParent(cwd, quarantineRelative, 0o700);
		fs.fchmodSync(quarantine.descriptor, 0o700);
		assertHeldWorkerDirectory(sourceParent, `source parent of ${workerViewPath(relative)}`);
		assertHeldWorkerDirectory(quarantine, "worker deletion quarantine");
		const liveState = readWorkerPathState(cwd, relative).state;
		const heldSource = fs.lstatSync(path.join(sourceParent.heldPath, sourceName));
		const logicalSource = fs.lstatSync(resolveRepoPath(cwd, relative, "worker deletion source"));
		if (
			!sameWorkerState(liveState, expectedState) ||
			!sameFileIdentity(heldSource, logicalSource) ||
			(typeof process.getuid === "function" && heldSource.uid !== process.getuid())
		) {
			throw new Error(`worker deletion source ${workerViewPath(relative)} changed after preflight`);
		}
		if (assertCollectionContext !== null) assertCollectionContext();
		fs.renameSync(
			path.join(sourceParent.heldPath, sourceName),
			path.join(quarantine.heldPath, quarantineName),
		);
		assertHeldWorkerDirectory(sourceParent, `source parent of ${workerViewPath(relative)}`);
		assertHeldWorkerDirectory(quarantineRoot, "worker deletion quarantine root");
		assertHeldWorkerDirectory(quarantine, "worker deletion quarantine");
		const heldQuarantined = fs.lstatSync(path.join(quarantine.heldPath, quarantineName));
		const logicalQuarantined = fs.lstatSync(path.join(quarantine.logicalPath, quarantineName));
		if (
			!sameFileIdentity(heldSource, heldQuarantined) ||
			!sameFileIdentity(heldQuarantined, logicalQuarantined)
		) {
			throw new Error(`worker deletion quarantine could not verify ${workerViewPath(relative)}`);
		}
	} finally {
		if (quarantine !== null) fs.closeSync(quarantine.descriptor);
		if (quarantineRoot !== null) fs.closeSync(quarantineRoot.descriptor);
		if (sourceParent !== null) fs.closeSync(sourceParent.descriptor);
	}
}
