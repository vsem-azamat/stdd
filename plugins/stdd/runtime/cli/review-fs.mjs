import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assertHeldDirectoryAttached,
	closeHeldDirectory,
	isHeldDirectorySafetyError,
	openHeldDirectoryByIdentity,
	sameHeldFileObservation,
} from "../sdk/held-publication.mjs";
import { MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { isReviewInodeIdentity } from "./state-validation.mjs";

const REVIEW_REQUEST_ID_PATTERN = /^rev-(?:[0-9a-f]{8}|[0-9a-f]{32})$/u;

function hashReviewDescriptor(descriptor) {
	const digest = createHash("sha256");
	const chunk = Buffer.alloc(64 * 1024);
	let position = 0;
	for (;;) {
		const count = fs.readSync(descriptor, chunk, 0, chunk.length, position);
		if (count === 0) break;
		digest.update(chunk.subarray(0, count));
		position += count;
	}
	return `sha256:${digest.digest("hex")}`;
}

const REVIEW_PRIVATE_COMPANIONS = new Set(["last-message.txt"]);

function isReviewOwnedArtifact(request, name) {
	if (name === `${request.id}.md` || REVIEW_PRIVATE_COMPANIONS.has(name)) return true;
	return new RegExp(`^\\.${request.id}-(?:[0-9a-f]{32}|artifact-[0-9a-f]{32})\\.retired$`).test(name);
}

function reviewInodeIdentity(stat) {
	return {
		dev: stat.dev.toString(),
		ino: stat.ino.toString(),
		uid: stat.uid.toString(),
		mode: stat.mode.toString(),
		nlink: stat.nlink.toString(),
	};
}

function reviewIdentityMatches(stat, identity, { ignoreDirectoryLinkCount = false } = {}) {
	return (
		isReviewInodeIdentity(identity) &&
		stat.dev === BigInt(identity.dev) &&
		stat.ino === BigInt(identity.ino) &&
		stat.uid === BigInt(identity.uid) &&
		stat.mode === BigInt(identity.mode) &&
		(ignoreDirectoryLinkCount || stat.nlink === BigInt(identity.nlink))
	);
}

export function captureReviewPrivateState(briefDir) {
	const tempRoot = fs.lstatSync(path.resolve(os.tmpdir()), { bigint: true });
	const directory = fs.lstatSync(briefDir, { bigint: true });
	const artifacts = Object.create(null);
	for (const name of fs.readdirSync(briefDir).sort()) {
		const artifact = fs.lstatSync(path.join(briefDir, name), { bigint: true });
		artifacts[name] = reviewInodeIdentity(artifact);
	}
	return {
		version: 1,
		tempRoot: reviewInodeIdentity(tempRoot),
		directory: reviewInodeIdentity(directory),
		artifacts,
	};
}

function openReviewHeldDirectory(logicalPath, label) {
	try {
		return openHeldDirectoryByIdentity(logicalPath, label);
	} catch (err) {
		if (["ENOENT", "ELOOP"].includes(err.code) || isHeldDirectorySafetyError(err)) {
			return null;
		}
		throw err;
	}
}

function inspectReviewOwnedArtifact(sourcePath, name, currentUid) {
	let descriptor = null;
	try {
		const before = fs.lstatSync(sourcePath, { bigint: true });
		descriptor = fs.openSync(sourcePath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const atPath = fs.lstatSync(sourcePath, { bigint: true });
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			!opened.isFile() ||
			opened.isSymbolicLink() ||
			opened.nlink !== 1n ||
			(opened.mode & 0o077n) !== 0n ||
			(currentUid !== null && opened.uid !== BigInt(currentUid)) ||
			!sameHeldFileObservation(before, opened) ||
			!sameHeldFileObservation(opened, atPath)
		) {
			fs.closeSync(descriptor);
			return null;
		}
		return { name, sourcePath, descriptor, opened };
	} catch (err) {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The unsafe artifact remains untouched.
			}
		}
		if (err.code === "ENOENT" || err.code === "ELOOP") return null;
		throw err;
	}
}

const REVIEW_QUARANTINE_README = `STDD private review quarantine — do not load

This directory may contain zero-length tombstones or a namespace replacement
detected after an identity-checked move. STDD deliberately does not delete it
automatically: Node/POSIX provides no identity-conditioned rename primitive
against a malicious same-UID namespace racer. Inspect and remove this
directory manually when convenient. Captured private artifact bytes are
overwritten and truncated through held descriptors before the move.
`;

function openReviewQuarantine(realTempRoot, tempHeld) {
	if (process.platform !== "linux") return null;
	const heldQuarantinePath = fs.mkdtempSync(path.join(tempHeld.heldPath, "stdd-review-quarantine-"));
	const quarantinePath = fs.realpathSync(heldQuarantinePath);
	if (path.dirname(quarantinePath) !== realTempRoot) {
		throw new Error("private review quarantine escaped the held OS temp root");
	}
	fs.chmodSync(heldQuarantinePath, 0o700);
	fs.writeFileSync(path.join(heldQuarantinePath, "README.txt"), REVIEW_QUARANTINE_README, {
		mode: 0o600,
		flag: "wx",
	});
	let quarantineHeld = null;
	try {
		quarantineHeld = openHeldDirectoryByIdentity(quarantinePath, "private review quarantine");
		assertHeldDirectoryAttached(tempHeld);
		return {
			quarantinePath,
			tempHeld,
			quarantineHeld,
			tempDescriptor: tempHeld.descriptor,
			quarantineDescriptor: quarantineHeld.descriptor,
			heldTemp: tempHeld.heldPath,
			heldQuarantine: quarantineHeld.heldPath,
		};
	} catch (err) {
		if (quarantineHeld !== null) closeHeldDirectory(quarantineHeld);
		if (isHeldDirectorySafetyError(err)) {
			throw new Error("could not hold the private review quarantine identities");
		}
		throw err;
	}
}

function closeReviewQuarantine(quarantine) {
	if (quarantine === null) return;
	try {
		closeHeldDirectory(quarantine.quarantineHeld);
	} catch {
		// The quarantine identity was already settled.
	}
}

function captureReviewSettlementBoundary(
	request,
	realTempRoot,
	realDir,
	observedDir,
	currentUid,
	settlement,
) {
	const privateState = request.privateState;
	if (
		typeof privateState !== "object" ||
		privateState === null ||
		Object.keys(privateState).sort().join(",") !== "artifacts,directory,tempRoot,version" ||
		privateState.version !== 1 ||
		!isReviewInodeIdentity(privateState.tempRoot) ||
		!isReviewInodeIdentity(privateState.directory) ||
		typeof privateState.artifacts !== "object" ||
		privateState.artifacts === null ||
		Array.isArray(privateState.artifacts)
	) {
		return null;
	}
	settlement.tempHeld = openReviewHeldDirectory(realTempRoot, "private review temp root");
	if (settlement.tempHeld === null) return null;
	settlement.tempDescriptor = settlement.tempHeld.descriptor;
	const openedTemp = settlement.tempHeld.opened;
	const heldTemp = settlement.tempHeld.heldPath;
	if (
		!reviewIdentityMatches(openedTemp, privateState.tempRoot, {
			ignoreDirectoryLinkCount: true,
		})
	) {
		return null;
	}
	settlement.dirHeld = openReviewHeldDirectory(realDir, "private review directory");
	if (settlement.dirHeld === null) return null;
	settlement.dirDescriptor = settlement.dirHeld.descriptor;
	const openedDir = settlement.dirHeld.opened;
	if (
		openedDir.dev !== BigInt(observedDir.dev) ||
		openedDir.ino !== BigInt(observedDir.ino) ||
		(openedDir.mode & 0o077n) !== 0n ||
		(currentUid !== null && openedDir.uid !== BigInt(currentUid))
	) {
		return null;
	}
	const heldDir = settlement.dirHeld.heldPath;
	const names = fs.readdirSync(heldDir);
	if (names.some((name) => !isReviewOwnedArtifact(request, name))) return null;
	if (
		!reviewIdentityMatches(openedDir, privateState.directory) ||
		Object.keys(privateState.artifacts).some((name) => !isReviewOwnedArtifact(request, name))
	) {
		return null;
	}
	const capturedNames = Object.keys(privateState.artifacts).sort();
	const actualNames = [...names].sort();
	if (
		capturedNames.length !== actualNames.length ||
		capturedNames.some((name, index) => name !== actualNames[index])
	) {
		return null;
	}
	for (const name of names) {
		const artifact = inspectReviewOwnedArtifact(path.join(heldDir, name), name, currentUid);
		if (artifact === null || !reviewIdentityMatches(artifact.opened, privateState.artifacts[name])) {
			return null;
		}
		settlement.artifacts.push(artifact);
	}
	return { privateState, heldTemp, heldDir };
}

function reviewSettlementHashMatches(request, artifacts, expectedHash) {
	if (expectedHash === null) return true;
	if (!/^sha256:[0-9a-f]{64}$/.test(expectedHash)) return false;
	const brief = artifacts.find((artifact) => artifact.name === `${request.id}.md`);
	if (brief === undefined) return false;
	return (
		hashReviewDescriptor(brief.descriptor) === expectedHash &&
		sameHeldFileObservation(brief.opened, fs.fstatSync(brief.descriptor, { bigint: true })) &&
		sameHeldFileObservation(brief.opened, fs.lstatSync(brief.sourcePath, { bigint: true }))
	);
}

function wipeReviewSettlementArtifacts(artifacts, currentUid) {
	for (const artifact of artifacts) {
		const atSource = fs.lstatSync(artifact.sourcePath, { bigint: true });
		const beforeWipe = fs.fstatSync(artifact.descriptor, { bigint: true });
		if (
			!sameHeldFileObservation(artifact.opened, beforeWipe) ||
			!sameHeldFileObservation(beforeWipe, atSource)
		) {
			return false;
		}
		const zeroes = Buffer.alloc(64 * 1024);
		let position = 0n;
		while (position < beforeWipe.size) {
			const remaining = beforeWipe.size - position;
			const length = Number(remaining < BigInt(zeroes.length) ? remaining : BigInt(zeroes.length));
			const written = fs.writeSync(artifact.descriptor, zeroes, 0, length, null);
			if (written <= 0) throw new Error("could not overwrite a private review artifact");
			position += BigInt(written);
		}
		fs.fsyncSync(artifact.descriptor);
		fs.ftruncateSync(artifact.descriptor, 0);
		fs.fsyncSync(artifact.descriptor);
		const wiped = fs.fstatSync(artifact.descriptor, { bigint: true });
		const wipedAtPath = fs.lstatSync(artifact.sourcePath, { bigint: true });
		if (
			wiped.dev !== beforeWipe.dev ||
			wiped.ino !== beforeWipe.ino ||
			!wiped.isFile() ||
			wiped.nlink !== 1n ||
			wiped.size !== 0n ||
			(wiped.mode & 0o077n) !== 0n ||
			(currentUid !== null && wiped.uid !== BigInt(currentUid)) ||
			!sameHeldFileObservation(wiped, wipedAtPath)
		) {
			return false;
		}
		artifact.opened = wiped;
	}
	return true;
}

function reviewSettlementArtifactsRemainBound(request, heldDir, artifacts) {
	const finalNames = fs.readdirSync(heldDir);
	if (
		finalNames.length !== artifacts.length ||
		finalNames.some((name) => !isReviewOwnedArtifact(request, name))
	) {
		return false;
	}
	return artifacts.every((artifact) => {
		const atPath = fs.lstatSync(artifact.sourcePath, { bigint: true });
		const held = fs.fstatSync(artifact.descriptor, { bigint: true });
		return sameHeldFileObservation(artifact.opened, held) && sameHeldFileObservation(held, atPath);
	});
}

function moveReviewSettlementToQuarantine(request, realTempRoot, realDir, settlement, boundary) {
	settlement.quarantine = openReviewQuarantine(realTempRoot, settlement.tempHeld);
	if (settlement.quarantine === null) return false;
	try {
		assertHeldDirectoryAttached(settlement.tempHeld);
		assertHeldDirectoryAttached(settlement.dirHeld);
		assertHeldDirectoryAttached(settlement.quarantine.quarantineHeld);
	} catch (err) {
		if (isHeldDirectorySafetyError(err)) return false;
		throw err;
	}
	const sourceDir = path.join(boundary.heldTemp, path.basename(realDir));
	const targetDir = path.join(
		settlement.quarantine.heldQuarantine,
		`review-${request.id}-${randomBytes(16).toString("hex")}.tombstone`,
	);
	const beforeMove = fs.fstatSync(settlement.dirDescriptor, { bigint: true });
	const sourceAtMove = fs.lstatSync(sourceDir, { bigint: true });
	if (
		beforeMove.dev !== sourceAtMove.dev ||
		beforeMove.ino !== sourceAtMove.ino ||
		!sourceAtMove.isDirectory()
	) {
		return false;
	}
	fs.renameSync(sourceDir, targetDir);
	fs.fsyncSync(settlement.quarantine.quarantineDescriptor);
	fs.fsyncSync(settlement.quarantine.tempDescriptor);
	const afterMove = fs.fstatSync(settlement.dirDescriptor, { bigint: true });
	const targetAtMove = fs.lstatSync(targetDir, { bigint: true });
	try {
		assertHeldDirectoryAttached(settlement.tempHeld);
		assertHeldDirectoryAttached(settlement.quarantine.quarantineHeld);
	} catch (err) {
		if (isHeldDirectorySafetyError(err)) return false;
		throw err;
	}
	return (
		afterMove.dev === beforeMove.dev &&
		afterMove.ino === beforeMove.ino &&
		targetAtMove.dev === afterMove.dev &&
		targetAtMove.ino === afterMove.ino &&
		targetAtMove.isDirectory()
	);
}

function closeReviewSettlement(settlement) {
	for (const artifact of settlement.artifacts) {
		try {
			fs.closeSync(artifact.descriptor);
		} catch {
			// The exact private inode has already been wiped and quarantined.
		}
	}
	if (settlement.dirHeld !== null) {
		try {
			closeHeldDirectory(settlement.dirHeld);
		} catch {
			// The exact private directory has already been quarantined.
		}
	}
	if (settlement.tempHeld !== null) {
		try {
			closeHeldDirectory(settlement.tempHeld);
		} catch {
			// The exact OS temp-root identity has already been released.
		}
	}
	closeReviewQuarantine(settlement.quarantine);
}

function reviewSettlementAlreadyGone(dir, expectedHash, error) {
	if (error.code !== "ENOENT" || expectedHash !== null) return false;
	try {
		fs.lstatSync(dir);
		return false;
	} catch (recheckError) {
		if (recheckError.code === "ENOENT") return true;
		throw recheckError;
	}
}

function settleReviewPrivateDirectory(
	request,
	realTempRoot,
	realDir,
	observedDir,
	{ dryRun = false, expectedHash = null } = {},
) {
	const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
	const settlement = {
		tempHeld: null,
		tempDescriptor: null,
		dirHeld: null,
		dirDescriptor: null,
		quarantine: null,
		artifacts: [],
	};
	try {
		if (process.platform !== "linux") return false;
		const boundary = captureReviewSettlementBoundary(
			request,
			realTempRoot,
			realDir,
			observedDir,
			currentUid,
			settlement,
		);
		if (boundary === null || !reviewSettlementHashMatches(request, settlement.artifacts, expectedHash)) {
			return false;
		}
		if (dryRun) return true;

		if (
			!wipeReviewSettlementArtifacts(settlement.artifacts, currentUid) ||
			!reviewSettlementArtifactsRemainBound(request, boundary.heldDir, settlement.artifacts)
		) {
			return false;
		}
		return moveReviewSettlementToQuarantine(request, realTempRoot, realDir, settlement, boundary);
	} catch (err) {
		if (reviewSettlementAlreadyGone(realDir, expectedHash, err)) return true;
		if (err.code === "ENOENT" || err.code === "ELOOP") return false;
		throw err;
	} finally {
		closeReviewSettlement(settlement);
	}
}

/** Remove only temp directories created by this review subsystem. */
export function removeReviewBrief(request, { dryRun = false, expectedHash = null } = {}) {
	if (typeof request?.briefPath !== "string" || typeof request?.id !== "string") return false;
	if (!REVIEW_REQUEST_ID_PATTERN.test(request.id)) return false;
	const briefPath = path.resolve(request.briefPath);
	const dir = path.dirname(briefPath);
	const tempRoot = path.resolve(os.tmpdir());
	if (
		path.dirname(dir) !== tempRoot ||
		!/^stdd-review-[0-9A-Za-z]{6}$/.test(path.basename(dir)) ||
		path.basename(briefPath) !== `${request.id}.md`
	) {
		return false;
	}

	let dirStat;
	try {
		dirStat = fs.lstatSync(dir, { bigint: true });
	} catch (err) {
		if (reviewSettlementAlreadyGone(dir, expectedHash, err)) return true;
		if (err.code === "ENOENT") return false;
		throw err;
	}
	const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
	if (
		!dirStat.isDirectory() ||
		dirStat.isSymbolicLink() ||
		(dirStat.mode & 0o077n) !== 0n ||
		(currentUid !== null && dirStat.uid !== BigInt(currentUid))
	) {
		return false;
	}

	let realTempRoot;
	let realDir;
	let realDirStat;
	try {
		realTempRoot = fs.realpathSync(tempRoot);
		realDir = fs.realpathSync(dir);
		realDirStat = fs.statSync(realDir, { bigint: true });
	} catch (err) {
		if (reviewSettlementAlreadyGone(dir, expectedHash, err)) return true;
		if (err.code === "ENOENT") return false;
		throw err;
	}
	if (
		path.dirname(realDir) !== realTempRoot ||
		path.basename(realDir) !== path.basename(dir) ||
		realDirStat.dev !== dirStat.dev ||
		realDirStat.ino !== dirStat.ino
	) {
		return false;
	}

	if (expectedHash !== null) {
		if (dryRun) return false;
		return settleReviewPrivateDirectory(request, realTempRoot, realDir, dirStat, {
			expectedHash,
		});
	}
	return settleReviewPrivateDirectory(request, realTempRoot, realDir, dirStat, { dryRun });
}

export function readVerifiedReviewArtifact(request, name) {
	if (process.platform !== "linux" || !REVIEW_PRIVATE_COMPANIONS.has(name)) return null;
	if (
		typeof request?.briefPath !== "string" ||
		typeof request?.id !== "string" ||
		!REVIEW_REQUEST_ID_PATTERN.test(request.id)
	) {
		return null;
	}
	const briefPath = path.resolve(request.briefPath);
	const dir = path.dirname(briefPath);
	const tempRoot = path.resolve(os.tmpdir());
	if (
		path.dirname(dir) !== tempRoot ||
		!/^stdd-review-[0-9A-Za-z]{6}$/.test(path.basename(dir)) ||
		path.basename(briefPath) !== `${request.id}.md`
	) {
		return null;
	}
	const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
	let dirHeld = null;
	let artifactDescriptor = null;
	try {
		const dirAtPath = fs.lstatSync(dir, { bigint: true });
		if (
			!dirAtPath.isDirectory() ||
			dirAtPath.isSymbolicLink() ||
			(dirAtPath.mode & 0o077n) !== 0n ||
			(currentUid !== null && dirAtPath.uid !== BigInt(currentUid)) ||
			!reviewIdentityMatches(dirAtPath, request.privateState?.directory)
		) {
			return null;
		}
		const realTempRoot = fs.realpathSync(tempRoot);
		const realDir = fs.realpathSync(dir);
		if (path.dirname(realDir) !== realTempRoot || path.basename(realDir) !== path.basename(dir)) {
			return null;
		}
		dirHeld = openReviewHeldDirectory(realDir, "private review directory");
		if (dirHeld === null || !reviewIdentityMatches(dirHeld.opened, request.privateState?.directory)) {
			return null;
		}
		const heldDir = dirHeld.heldPath;
		const sourcePath = path.join(heldDir, name);
		const before = fs.lstatSync(sourcePath, { bigint: true });
		artifactDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const opened = fs.fstatSync(artifactDescriptor, { bigint: true });
		const expected = request.privateState?.artifacts?.[name];
		if (
			!opened.isFile() ||
			opened.isSymbolicLink() ||
			opened.nlink !== 1n ||
			(opened.mode & 0o077n) !== 0n ||
			(currentUid !== null && opened.uid !== BigInt(currentUid)) ||
			opened.size > BigInt(MAX_SUBPROCESS_BUFFER) ||
			!reviewIdentityMatches(opened, expected) ||
			!sameHeldFileObservation(before, opened) ||
			!sameHeldFileObservation(opened, fs.lstatSync(sourcePath, { bigint: true }))
		) {
			return null;
		}
		const text = fs.readFileSync(artifactDescriptor, "utf8");
		if (
			!sameHeldFileObservation(opened, fs.fstatSync(artifactDescriptor, { bigint: true })) ||
			!sameHeldFileObservation(opened, fs.lstatSync(sourcePath, { bigint: true }))
		) {
			return null;
		}
		return text;
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "ELOOP") return null;
		throw err;
	} finally {
		if (artifactDescriptor !== null) fs.closeSync(artifactDescriptor);
		if (dirHeld !== null) closeHeldDirectory(dirHeld);
	}
}

export function reviewPrivateDirectoryExists(request) {
	if (typeof request?.briefPath !== "string" || typeof request?.id !== "string") return true;
	if (!REVIEW_REQUEST_ID_PATTERN.test(request.id)) return true;
	const briefPath = path.resolve(request.briefPath);
	const dir = path.dirname(briefPath);
	const tempRoot = path.resolve(os.tmpdir());
	if (
		path.dirname(dir) !== tempRoot ||
		!/^stdd-review-[0-9A-Za-z]{6}$/.test(path.basename(dir)) ||
		path.basename(briefPath) !== `${request.id}.md`
	) {
		return true;
	}
	try {
		fs.lstatSync(dir);
		return true;
	} catch (err) {
		return err.code !== "ENOENT";
	}
}
