import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publishHeldParentFile, sameFileIdentity } from "../sdk/held-publication.mjs";
import { resolveRepoPath } from "../sdk/path.mjs";
import { openOrCreateHeldGeneratedParent } from "./held-fs.mjs";
import { viewPath } from "./path-bytes.mjs";

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

export function publishWorkerFile(cwd, relative, content, mode) {
	const target = resolveRepoPath(cwd, relative, `worker collection path ${JSON.stringify(relative)}`);
	const parentRelative = path.posix.dirname(relative);
	publishHeldParentFile({
		openDirectory: () => openWorkerPublicationParent(cwd, parentRelative),
		logicalTargetPath: target,
		content,
		mode,
		tempPrefix: ".stdd-worker-collect-",
		identityError: `worker collection path ${JSON.stringify(relative)} changed during publication`,
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

export function publishWorkerSymlink(cwd, relative, target, workerId) {
	const parentRelative = path.posix.dirname(relative);
	const held = openWorkerPublicationParent(cwd, parentRelative);
	const name = path.posix.basename(relative);
	const temp = `.stdd-worker-link-${workerId.slice("worker-".length)}-${randomBytes(8).toString("hex")}`;
	try {
		assertHeldWorkerDirectory(held, `parent of ${workerViewPath(relative)}`);
		fs.symlinkSync(target, path.join(held.heldPath, temp));
		fs.renameSync(path.join(held.heldPath, temp), path.join(held.heldPath, name));
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
