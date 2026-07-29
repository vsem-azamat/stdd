import fs from "node:fs";
import path from "node:path";
import { publishHeldParentFile, sameFileIdentity } from "../sdk/held-publication.mjs";
import { resolveRepoPath, resolveWritableRepoPath } from "../sdk/path.mjs";

export function openHeldLinuxRepoDirectory(targetDir, relative, label) {
	if (process.platform !== "linux") {
		throw new Error(`${label} needs Linux held-parent support`);
	}
	const logicalPath = resolveWritableRepoPath(targetDir, relative, label);
	const before = fs.lstatSync(logicalPath);
	if (before.isSymbolicLink() || !before.isDirectory()) {
		throw new Error(`${label} must be a non-symlinked directory`);
	}
	const descriptor = fs.openSync(
		logicalPath,
		fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
	);
	try {
		const opened = fs.fstatSync(descriptor);
		if (!sameFileIdentity(before, opened)) {
			throw new Error(`${label} changed before it could be held`);
		}
		const heldPath = `/proc/self/fd/${descriptor}`;
		try {
			fs.realpathSync(heldPath);
		} catch (err) {
			err.stddHeldNamespaceUnavailable = true;
			throw err;
		}
		return { descriptor, logicalPath, identity: opened, heldPath };
	} catch (err) {
		try {
			fs.closeSync(descriptor);
		} catch {}
		throw err;
	}
}

export function openOrCreateHeldGeneratedParent(targetDir, parentRelative, mode = 0o755) {
	const rootPath = path.resolve(targetDir);
	let logicalPath = rootPath;
	let descriptor = fs.openSync(
		rootPath,
		fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
	);
	try {
		let identity = fs.fstatSync(descriptor);
		const rootObserved = fs.lstatSync(rootPath);
		if (!sameFileIdentity(identity, rootObserved)) {
			throw new Error("repository root changed before generated publication");
		}
		for (const segment of parentRelative.split("/")) {
			const heldParent = `/proc/self/fd/${descriptor}`;
			fs.realpathSync(heldParent);
			const heldChild = path.join(heldParent, segment);
			try {
				fs.mkdirSync(heldChild, { mode });
			} catch (err) {
				if (err.code !== "EEXIST") throw err;
			}
			const childObserved = fs.lstatSync(heldChild);
			if (childObserved.isSymbolicLink() || !childObserved.isDirectory()) {
				throw new Error(
					`generated parent segment ${JSON.stringify(segment)} is a symlink or unsafe non-directory`,
				);
			}
			const childDescriptor = fs.openSync(
				heldChild,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
			);
			const childIdentity = fs.fstatSync(childDescriptor);
			const childLogicalPath = path.join(logicalPath, segment);
			const childLogical = fs.lstatSync(childLogicalPath);
			if (
				!sameFileIdentity(childObserved, childIdentity) ||
				!sameFileIdentity(childIdentity, childLogical)
			) {
				fs.closeSync(childDescriptor);
				throw new Error("generated parent changed during held-directory creation");
			}
			fs.closeSync(descriptor);
			descriptor = childDescriptor;
			identity = childIdentity;
			logicalPath = childLogicalPath;
		}
		return {
			descriptor,
			logicalPath,
			identity,
			heldPath: `/proc/self/fd/${descriptor}`,
		};
	} catch (err) {
		try {
			fs.closeSync(descriptor);
		} catch {}
		throw err;
	}
}

export function publishGeneratedFileSafely(targetDir, relative, content) {
	if (process.platform !== "linux") {
		throw new Error(
			"secure generated publication is unsupported because no held-parent pathname bridge is available",
		);
	}
	const filePath = resolveRepoPath(targetDir, relative, `generated path ${JSON.stringify(relative)}`);
	const parentRelative = path.posix.dirname(relative);
	// The final target is never opened, so a hard link cannot turn
	// regeneration into truncation of another inode.
	publishHeldParentFile({
		openDirectory: () => openOrCreateHeldGeneratedParent(targetDir, parentRelative),
		logicalTargetPath: filePath,
		content,
		mode: 0o644,
		tempPrefix: ".stdd-generated-",
		identityError: `generated path ${JSON.stringify(relative)} changed during held-parent publication`,
	});
}
