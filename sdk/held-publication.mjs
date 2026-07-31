import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function lstatOrNull(target, options) {
	try {
		return fs.lstatSync(target, options);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

export function sameFileIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function heldDirectorySafetyError(message) {
	const error = new Error(message);
	error.code = "ERR_STDD_HELD_DIRECTORY_UNSAFE";
	return error;
}

export function isHeldDirectorySafetyError(error) {
	return error?.code === "ERR_STDD_HELD_DIRECTORY_UNSAFE";
}

export function sameHeldFileObservation(left, right) {
	return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
		(field) =>
			typeof left?.[field] === "bigint" &&
			typeof right?.[field] === "bigint" &&
			left[field] === right[field],
	);
}

export function samePublicationObservation(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

export function samePublicationPayload(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

export function requireSafeDirectory(target, label) {
	const observed = lstatOrNull(target);
	if (!observed) throw new Error(`${label} is missing; expected a non-symlinked directory`);
	if (observed.isSymbolicLink()) {
		throw new Error(`${label} is a symlink and is unsafe for plugin publication`);
	}
	if (!observed.isDirectory()) {
		throw new Error(`${label} is not a directory and is unsafe for plugin publication`);
	}
	return observed;
}

export function requireSafeRegularFile(target, label, { allowMissing = false } = {}) {
	const observed = lstatOrNull(target);
	if (!observed && allowMissing) return null;
	if (!observed) throw new Error(`${label} is missing; expected a non-symlinked regular file`);
	if (observed.isSymbolicLink()) {
		throw new Error(`${label} is a symlink and is unsafe for plugin publication`);
	}
	if (!observed.isFile()) {
		throw new Error(`${label} is not a regular file and is unsafe for plugin publication`);
	}
	return observed;
}

export function requireSafeTree(target, label) {
	requireSafeDirectory(target, label);
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		const child = path.join(target, entry.name);
		const childLabel = `${label}/${entry.name}`;
		const observed = fs.lstatSync(child);
		if (observed.isSymbolicLink()) {
			throw new Error(`${childLabel} is a symlink and is unsafe for plugin publication`);
		}
		if (observed.isDirectory()) requireSafeTree(child, childLabel);
		else if (!observed.isFile()) {
			throw new Error(`${childLabel} is not a regular file and is unsafe for plugin publication`);
		}
	}
}

function openHeldDirectoryWith(logicalPath, label, sameObservation, { preflight = true } = {}) {
	if (preflight) {
		const before = fs.lstatSync(logicalPath, { bigint: true });
		if (before.isSymbolicLink() || !before.isDirectory()) {
			throw heldDirectorySafetyError(`${label} must remain a non-symlinked directory`);
		}
	}
	const descriptor = fs.openSync(
		logicalPath,
		fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
	);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const atPath = fs.lstatSync(logicalPath, { bigint: true });
		const heldPath = `/proc/self/fd/${descriptor}`;
		if (
			!opened.isDirectory() ||
			atPath.isSymbolicLink() ||
			!atPath.isDirectory() ||
			!sameObservation(opened, atPath) ||
			fs.realpathSync(heldPath) !== fs.realpathSync(logicalPath)
		) {
			throw heldDirectorySafetyError(`${label} changed while its publication boundary was opened`);
		}
		return { descriptor, heldPath, logicalPath, opened, label };
	} catch (err) {
		fs.closeSync(descriptor);
		throw err;
	}
}

export function openHeldDirectory(logicalPath, label) {
	return openHeldDirectoryWith(logicalPath, label, sameHeldFileObservation);
}

export function openHeldDirectoryByIdentity(logicalPath, label) {
	return openHeldDirectoryWith(logicalPath, label, sameFileIdentity, { preflight: false });
}

export function closeHeldDirectory(held) {
	fs.closeSync(held.descriptor);
}

export function assertHeldDirectoryAttached(held) {
	let logical;
	try {
		logical = fs.lstatSync(held.logicalPath, { bigint: true });
	} catch (err) {
		throw heldDirectorySafetyError(`${held.label} changed during plugin publication: ${err.message}`);
	}
	if (
		logical.isSymbolicLink() ||
		!logical.isDirectory() ||
		logical.dev !== held.opened.dev ||
		logical.ino !== held.opened.ino ||
		fs.realpathSync(held.heldPath) !== fs.realpathSync(held.logicalPath)
	) {
		throw heldDirectorySafetyError(`${held.label} changed identity during plugin publication`);
	}
}

function observeHeldRegularFile(
	held,
	name,
	label,
	{ allowMissing = false, requireSingleLink = false } = {},
) {
	const heldTarget = path.join(held.heldPath, name);
	const logicalTarget = path.join(held.logicalPath, name);
	const heldObserved = lstatOrNull(heldTarget);
	const logicalObserved = lstatOrNull(logicalTarget);
	if (!heldObserved || !logicalObserved) {
		if (allowMissing && !heldObserved && !logicalObserved) return null;
		throw new Error(`${label} changed or disappeared during plugin publication`);
	}
	if (
		heldObserved.isSymbolicLink() ||
		logicalObserved.isSymbolicLink() ||
		!heldObserved.isFile() ||
		!logicalObserved.isFile()
	) {
		throw new Error(`${label} is not a safe regular file during plugin publication`);
	}
	const heldBig = fs.lstatSync(heldTarget, { bigint: true });
	const logicalBig = fs.lstatSync(logicalTarget, { bigint: true });
	if (!sameHeldFileObservation(heldBig, logicalBig)) {
		throw new Error(`${label} changed identity during plugin publication`);
	}
	if (requireSingleLink && (heldBig.nlink !== 1n || logicalBig.nlink !== 1n)) {
		throw new Error(`${label} must remain a single-link regular file during plugin publication`);
	}
	return heldBig;
}

export function readHeldRegularFile(held, name, label, options = {}) {
	const { encoding = "utf8", ...observationOptions } = options;
	assertHeldDirectoryAttached(held);
	const expected = observeHeldRegularFile(held, name, label, observationOptions);
	const target = path.join(held.heldPath, name);
	const descriptor = fs.openSync(
		target,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!opened.isFile() || !sameHeldFileObservation(expected, opened)) {
			throw new Error(`${label} changed while it was opened`);
		}
		const content = fs.readFileSync(descriptor, encoding);
		const after = fs.fstatSync(descriptor, { bigint: true });
		const namespaceAfter = observeHeldRegularFile(held, name, label, observationOptions);
		if (
			!sameHeldFileObservation(opened, after) ||
			!sameHeldFileObservation(after, namespaceAfter) ||
			(Buffer.isBuffer(content) && BigInt(content.length) !== after.size)
		) {
			throw new Error(`${label} changed while it was read`);
		}
		assertHeldDirectoryAttached(held);
		return content;
	} finally {
		fs.closeSync(descriptor);
	}
}

export function atomicWriteFile(held, name, content, label, { mode } = {}) {
	assertHeldDirectoryAttached(held);
	const existing = observeHeldRegularFile(held, name, label, { allowMissing: true });
	const publicationMode = mode ?? (existing ? Number(existing.mode & 0o777n) : 0o644);
	const temporaryName = `.${name}-${randomBytes(16).toString("hex")}.tmp`;
	const temporary = path.join(held.heldPath, temporaryName);
	const target = path.join(held.heldPath, name);
	let descriptor = null;
	let operationError = null;
	try {
		descriptor = fs.openSync(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			publicationMode,
		);
		fs.fchmodSync(descriptor, publicationMode);
		fs.writeFileSync(descriptor, content);
		fs.fsyncSync(descriptor);
		const temporaryObserved = fs.fstatSync(descriptor, { bigint: true });
		if (
			(Number(temporaryObserved.mode) & 0o777) !== publicationMode ||
			temporaryObserved.size !== BigInt(Buffer.byteLength(content))
		) {
			throw new Error(`${label} temporary bytes or mode did not match the requested publication`);
		}
		fs.closeSync(descriptor);
		descriptor = null;
		assertHeldDirectoryAttached(held);
		const beforeRename = observeHeldRegularFile(held, name, label, { allowMissing: true });
		if (
			(existing === null) !== (beforeRename === null) ||
			(existing !== null && !sameHeldFileObservation(existing, beforeRename))
		) {
			throw new Error(`${label} changed before atomic publication`);
		}
		fs.renameSync(temporary, target);
		fs.fsyncSync(held.descriptor);
		const published = fs.lstatSync(target, { bigint: true });
		if (
			published.isSymbolicLink() ||
			!published.isFile() ||
			published.dev !== temporaryObserved.dev ||
			published.ino !== temporaryObserved.ino ||
			(Number(published.mode) & 0o777) !== publicationMode
		) {
			throw new Error(`${label} did not retain the atomically published file identity and mode`);
		}
		assertHeldDirectoryAttached(held);
		const logicalPublished = observeHeldRegularFile(held, name, label);
		if (logicalPublished.dev !== published.dev || logicalPublished.ino !== published.ino) {
			throw new Error(`${label} changed after atomic publication`);
		}
	} catch (err) {
		operationError = err;
	} finally {
		if (descriptor !== null) fs.closeSync(descriptor);
	}
	if (operationError) {
		const retained = lstatOrNull(temporary);
		throw new Error(
			`${operationError.message}${
				retained
					? `; unverified publication temp ${path.join(
							held.logicalPath,
							temporaryName,
						)} was retained — inspect and remove it manually`
					: ""
			}`,
			{ cause: operationError },
		);
	}
}

export function ensureHeldChildDirectory(parent, name, label, mode = 0o755) {
	assertHeldDirectoryAttached(parent);
	const heldChild = path.join(parent.heldPath, name);
	const logicalChild = path.join(parent.logicalPath, name);
	const heldBefore = lstatOrNull(heldChild);
	const logicalBefore = lstatOrNull(logicalChild);
	if (!heldBefore && !logicalBefore) {
		fs.mkdirSync(heldChild, { mode });
		fs.fsyncSync(parent.descriptor);
	} else if (!heldBefore || !logicalBefore) {
		throw new Error(`${label} changed before directory creation`);
	}
	assertHeldDirectoryAttached(parent);
	const child = openHeldDirectory(logicalChild, label);
	try {
		const throughParent = fs.lstatSync(heldChild, { bigint: true });
		if (throughParent.dev !== child.opened.dev || throughParent.ino !== child.opened.ino) {
			throw new Error(`${label} changed identity after directory creation`);
		}
		return child;
	} catch (err) {
		closeHeldDirectory(child);
		throw err;
	}
}

export function quarantineStaleSkill(skills, quarantine, name) {
	const label = `stale plugin skill ${name}`;
	assertHeldDirectoryAttached(skills);
	assertHeldDirectoryAttached(quarantine);
	const source = path.join(skills.heldPath, name);
	const logicalSource = path.join(skills.logicalPath, name);
	const sourceObserved = fs.lstatSync(source, { bigint: true });
	const logicalObserved = fs.lstatSync(logicalSource, { bigint: true });
	if (
		sourceObserved.isSymbolicLink() ||
		!sourceObserved.isDirectory() ||
		!sameHeldFileObservation(sourceObserved, logicalObserved)
	) {
		throw new Error(`${label} changed before confined quarantine`);
	}
	const retiredName = `${name}-${randomBytes(16).toString("hex")}.retired`;
	const retired = path.join(quarantine.heldPath, retiredName);
	const logicalRetired = path.join(quarantine.logicalPath, retiredName);
	if (lstatOrNull(retired) || lstatOrNull(logicalRetired)) {
		throw new Error(`${label} quarantine target unexpectedly exists`);
	}
	fs.renameSync(source, retired);
	fs.fsyncSync(skills.descriptor);
	fs.fsyncSync(quarantine.descriptor);
	const retiredObserved = fs.lstatSync(retired, { bigint: true });
	if (
		retiredObserved.dev !== sourceObserved.dev ||
		retiredObserved.ino !== sourceObserved.ino ||
		retiredObserved.mode !== sourceObserved.mode
	) {
		throw new Error(`${label} changed during confined quarantine`);
	}
	try {
		assertHeldDirectoryAttached(skills);
		assertHeldDirectoryAttached(quarantine);
		if (lstatOrNull(logicalSource)) {
			throw new Error(`${label} remained at its logical load path after quarantine`);
		}
		const logicalRetiredObserved = fs.lstatSync(logicalRetired, { bigint: true });
		if (
			logicalRetiredObserved.isSymbolicLink() ||
			!logicalRetiredObserved.isDirectory() ||
			logicalRetiredObserved.dev !== retiredObserved.dev ||
			logicalRetiredObserved.ino !== retiredObserved.ino
		) {
			throw new Error(`${label} quarantine target changed identity`);
		}
	} catch (err) {
		try {
			const currentRetired = fs.lstatSync(retired, { bigint: true });
			if (
				currentRetired.dev === sourceObserved.dev &&
				currentRetired.ino === sourceObserved.ino &&
				!lstatOrNull(source)
			) {
				fs.renameSync(retired, source);
			}
			fs.fsyncSync(skills.descriptor);
			fs.fsyncSync(quarantine.descriptor);
		} catch {
			// Preserve the confined quarantine rather than touching
			// the now-untrusted logical namespace.
		}
		throw err;
	}
	return retiredName;
}

/**
 * Publish one complete file through an identity-bound held parent. The temp
 * descriptor stays open until the rename and first postflight have proved
 * that the published pathname still names the exact inode we wrote.
 */
export function publishHeldParentFile({
	openDirectory,
	logicalTargetPath,
	content,
	mode,
	tempPrefix,
	identityError,
	onRenameAttempt = null,
	noReplace = false,
}) {
	let heldDirectory = null;
	let descriptor = null;
	let tempPath = null;
	let tempIdentity = null;
	const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
	try {
		heldDirectory = openDirectory();
		fs.fsyncSync(heldDirectory.descriptor);
		const tempName = `${tempPrefix}${randomBytes(16).toString("hex")}.tmp`;
		tempPath = path.join(heldDirectory.heldPath, tempName);
		const heldTargetPath = path.join(heldDirectory.heldPath, path.basename(logicalTargetPath));
		descriptor = fs.openSync(tempPath, "wx", 0o600);
		fs.fchmodSync(descriptor, mode);
		fs.writeFileSync(descriptor, content);
		fs.fsyncSync(descriptor);
		tempIdentity = fs.fstatSync(descriptor);
		const tempBeforeRename = fs.lstatSync(tempPath);
		const parentBeforeRename = fs.fstatSync(heldDirectory.descriptor);
		if (
			tempIdentity.isSymbolicLink() ||
			!tempIdentity.isFile() ||
			tempIdentity.nlink !== 1 ||
			(tempIdentity.mode & 0o777) !== mode ||
			(currentUid !== null && tempIdentity.uid !== currentUid) ||
			tempBeforeRename.isSymbolicLink() ||
			!tempBeforeRename.isFile() ||
			!samePublicationObservation(tempIdentity, tempBeforeRename) ||
			!sameFileIdentity(heldDirectory.identity, parentBeforeRename)
		) {
			throw new Error(identityError);
		}
		if (onRenameAttempt !== null) onRenameAttempt();
		if (noReplace) {
			fs.linkSync(tempPath, heldTargetPath);
			fs.unlinkSync(tempPath);
		} else {
			fs.renameSync(tempPath, heldTargetPath);
		}
		fs.fsyncSync(heldDirectory.descriptor);

		const validatePublishedIdentity = (bindDescriptor) => {
			const heldPublished = fs.lstatSync(heldTargetPath);
			const bound = bindDescriptor ? fs.fstatSync(descriptor) : heldPublished;
			const heldParent = fs.fstatSync(heldDirectory.descriptor);
			const logicalParent = fs.lstatSync(heldDirectory.logicalPath);
			const logicalPublished = fs.lstatSync(logicalTargetPath);
			if (
				bound.isSymbolicLink() ||
				!bound.isFile() ||
				bound.nlink !== 1 ||
				(bound.mode & 0o777) !== mode ||
				(currentUid !== null && bound.uid !== currentUid) ||
				heldPublished.isSymbolicLink() ||
				!heldPublished.isFile() ||
				(heldPublished.mode & 0o777) !== mode ||
				(currentUid !== null && heldPublished.uid !== currentUid) ||
				!samePublicationPayload(tempIdentity, bound) ||
				!samePublicationObservation(bound, heldPublished) ||
				!samePublicationObservation(bound, logicalPublished) ||
				!sameFileIdentity(heldDirectory.identity, heldParent) ||
				!sameFileIdentity(heldDirectory.identity, logicalParent)
			) {
				throw new Error(identityError);
			}
		};
		validatePublishedIdentity(true);
		fs.closeSync(descriptor);
		descriptor = null;
		validatePublishedIdentity(false);
	} finally {
		if (descriptor !== null) {
			try {
				const bound = fs.fstatSync(descriptor);
				if (tempPath !== null && tempIdentity !== null) {
					let atTemp = null;
					try {
						atTemp = fs.lstatSync(tempPath);
					} catch {
						// Missing or unreadable means there is no exact basename safe to retire.
					}
					if (
						atTemp !== null &&
						samePublicationObservation(tempIdentity, bound) &&
						samePublicationObservation(bound, atTemp)
					) {
						fs.unlinkSync(tempPath);
						if (heldDirectory !== null) fs.fsyncSync(heldDirectory.descriptor);
					}
				}
			} catch {
				// Preserve an unverifiable randomized temp rather than chasing a replaced basename.
			}
			try {
				fs.closeSync(descriptor);
			} catch {
				// Descriptor close failures do not justify touching an unverified pathname.
			}
		}
		if (heldDirectory !== null) {
			try {
				fs.closeSync(heldDirectory.descriptor);
			} catch {
				// Publication has already been proved or reported indeterminate.
			}
		}
	}
}
