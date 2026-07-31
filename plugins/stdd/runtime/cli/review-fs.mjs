import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openNativeRepoMutation, readNativeFile, writeNativeFileContent } from "./held-fs.mjs";
import { MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { isReviewInodeIdentity, sameReviewPrivateState } from "./state-validation.mjs";

const REVIEW_REQUEST_ID_PATTERN = /^rev-(?:[0-9a-f]{8}|[0-9a-f]{32})$/u;
const REVIEW_DIRECTORY_PATTERN = /^stdd-review-(?:[0-9A-Za-z]{6}|[0-9a-f]{8}|[0-9a-f]{32})$/u;
const REVIEW_PRIVATE_COMPANIONS = new Set(["last-message.txt"]);
const NATIVE_CHUNK_BYTES = 64 * 1024;
const REVIEW_INVENTORY_NAME = "inventory.json";
const REVIEW_RETAINED_NAME = "private";

function isReviewOwnedArtifact(request, name) {
	if (name === `${request.id}.md` || REVIEW_PRIVATE_COMPANIONS.has(name)) return true;
	return new RegExp(`^\\.${request.id}-(?:[0-9a-f]{32}|artifact-[0-9a-f]{32})\\.retired$`).test(name);
}

function stableObservation(observation) {
	const { identity, owner, permissions, linkCount } = observation;
	return { identity, owner, permissions, linkCount };
}

function sameNativeIdentity(left, right) {
	return (
		left?.version === right?.version &&
		left?.platform === right?.platform &&
		left?.volume === right?.volume &&
		left?.fileId === right?.fileId &&
		left?.kind === right?.kind
	);
}

function recordedObservationMatches(current, recorded, kind, { ignoreLinkCount = false } = {}) {
	if (recorded?.identity?.version === 2) {
		return (
			sameNativeIdentity(current.identity, recorded.identity) &&
			current.identity.kind === kind &&
			current.owner === recorded.owner &&
			current.permissions === recorded.permissions &&
			(ignoreLinkCount || current.linkCount === recorded.linkCount)
		);
	}
	if (!isReviewInodeIdentity(recorded) || current.identity.platform !== "linux") return false;
	return (
		current.identity.volume === recorded.dev &&
		current.identity.fileId === recorded.ino &&
		current.identity.kind === kind &&
		current.owner === recorded.uid &&
		current.permissions === recorded.mode &&
		(ignoreLinkCount || current.linkCount === recorded.nlink)
	);
}

function privateObservation(observation, mode) {
	return (
		(observation.identity.kind === "directory" || observation.linkCount === "1") &&
		(observation.identity.platform === "win32"
			? observation.permissions ===
				`O:${observation.owner}D:P(A;;FA;;;${observation.owner})(A;;FA;;;SY)(A;;FA;;;BA)`
			: (Number(observation.permissions) & 0o777) === mode)
	);
}

function reviewOwner(request) {
	return request.privateState.version === 2
		? request.privateState.directory.owner
		: request.privateState.directory.uid;
}

function recordedOwner(recorded) {
	return recorded?.identity?.version === 2 ? recorded.owner : recorded?.uid;
}

function pathApiFor(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}

function samePlatformPath(left, right, platform) {
	return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function canonicalTempRootPath(value, platform) {
	if (typeof value !== "string") return null;
	const pathApi = pathApiFor(platform);
	if (!pathApi.isAbsolute(value)) return null;
	let normalized = pathApi.normalize(value);
	if (platform === "win32") {
		normalized = normalized.replace(/^([a-z]):/u, (_, drive) => `${drive.toUpperCase()}:`);
	}
	return normalized;
}

function parseReviewLocation(request) {
	if (
		typeof request?.briefPath !== "string" ||
		typeof request?.id !== "string" ||
		!REVIEW_REQUEST_ID_PATTERN.test(request.id)
	) {
		return null;
	}
	const platform =
		request.privateState?.version === 2
			? request.privateState.tempRoot?.identity?.platform
			: contextPlatformPathKind();
	const pathApi = pathApiFor(platform);
	const tempRoot =
		request.privateState?.version === 2
			? canonicalTempRootPath(request.privateState.tempRootPath, platform)
			: path.resolve(os.tmpdir());
	if (
		tempRoot === null ||
		(request.privateState?.version === 2 && tempRoot !== request.privateState.tempRootPath)
	) {
		return null;
	}
	const briefPath = pathApi.resolve(request.briefPath);
	const directoryPath = pathApi.dirname(briefPath);
	const directoryName = pathApi.basename(directoryPath);
	if (
		!samePlatformPath(pathApi.dirname(directoryPath), tempRoot, platform) ||
		!REVIEW_DIRECTORY_PATTERN.test(directoryName) ||
		pathApi.basename(briefPath) !== `${request.id}.md`
	) {
		return null;
	}
	return {
		tempRoot,
		briefPath,
		directoryPath,
		directoryName,
		quarantineName: `stdd-review-quarantine-${request.id.slice(4)}`,
	};
}

function contextPlatformPathKind() {
	return path.sep === "\\" ? "win32" : "linux";
}

async function listNativeDirectory(context, directory) {
	const entries = [];
	let cursor = null;
	do {
		const page = await context.session.list(directory.cap, { cursor, limit: 256 });
		entries.push(...page.entries);
		cursor = page.cursor;
	} while (cursor !== null);
	return entries;
}

async function closeCapabilities(context, capabilities) {
	for (const cap of [...capabilities].reverse()) {
		await context.session.closeCapability(cap).catch(() => {});
	}
}

function register(capabilities, value) {
	capabilities.add(value.cap);
	return value;
}

function hashBytes(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function exactPrivateState(request) {
	return sameReviewPrivateState(request?.privateState, request?.privateState);
}

function inventoryBytes(request, location) {
	return Buffer.from(
		`${JSON.stringify({
			schema: 1,
			kind: "private-review",
			request: request.id,
			brief: request.brief ?? request.briefHash ?? null,
			original: location.directoryName,
			retained: `${location.quarantineName}/${REVIEW_RETAINED_NAME}`,
			directory: request.privateState.directory,
		})}\n`,
	);
}

/** Exact ledger-derived candidate for read-only doctor inventory; never scans OS temp. */
export function reviewRetainedInventoryExpectation(request) {
	if (!exactPrivateState(request)) return null;
	const location = parseReviewLocation(request);
	if (!location) return null;
	return {
		request,
		location,
		owner: reviewOwner(request),
		inventory: inventoryBytes(request, location),
		quarantinePath: pathApiFor(request.privateState.tempRoot.identity?.platform ?? "linux").join(
			location.tempRoot,
			location.quarantineName,
		),
	};
}

async function inspectRetainedSettlement(context, request, location, capabilities) {
	let quarantine;
	try {
		quarantine = register(
			capabilities,
			await context.session.openChild(context.root.cap, location.quarantineName),
		);
	} catch (error) {
		if (error?.code === "not-found") return null;
		throw error;
	}
	if (
		quarantine.observation.identity.kind !== "directory" ||
		!privateObservation(quarantine.observation, 0o700) ||
		quarantine.observation.owner !== reviewOwner(request)
	) {
		return false;
	}
	const entries = await listNativeDirectory(context, quarantine);
	const names = entries.map((entry) => entry.name).sort();
	if (names.length !== 2 || names[0] !== REVIEW_INVENTORY_NAME || names[1] !== REVIEW_RETAINED_NAME) {
		return false;
	}
	const inventory = register(
		capabilities,
		await context.session.openChild(quarantine.cap, REVIEW_INVENTORY_NAME),
	);
	const retained = register(
		capabilities,
		await context.session.openChild(quarantine.cap, REVIEW_RETAINED_NAME),
	);
	if (
		!privateObservation(inventory.observation, 0o600) ||
		inventory.observation.owner !== reviewOwner(request) ||
		!(await readNativeFile(context, inventory, 64 * 1024)).equals(inventoryBytes(request, location)) ||
		!recordedObservationMatches(retained.observation, request.privateState.directory, "directory")
	) {
		return false;
	}
	const retainedEntries = await listNativeDirectory(context, retained);
	const retainedNames = retainedEntries.map((entry) => entry.name).sort();
	const capturedNames = Object.keys(request.privateState.artifacts).sort();
	if (
		retainedNames.length !== capturedNames.length ||
		retainedNames.some((name, index) => name !== capturedNames[index]) ||
		retainedNames.some((name) => !isReviewOwnedArtifact(request, name))
	) {
		return false;
	}
	for (const name of retainedNames) {
		const artifact = register(capabilities, await context.session.openChild(retained.cap, name));
		if (
			recordedOwner(request.privateState.artifacts[name]) !== reviewOwner(request) ||
			artifact.observation.owner !== reviewOwner(request) ||
			!recordedObservationMatches(artifact.observation, request.privateState.artifacts[name], "file") ||
			!privateObservation(artifact.observation, 0o600) ||
			artifact.observation.size !== "0"
		) {
			return false;
		}
	}
	return { quarantine, retained };
}

/** Inspect one exact ledger-proven retained review location through one native helper session. */
export async function inspectReviewRetainedInventory(request, { context = null, strict = false } = {}) {
	const expected = reviewRetainedInventoryExpectation(request);
	const recordedPlatform =
		request?.privateState?.version === 2 ? request.privateState.tempRoot.identity?.platform : "linux";
	if (!expected) return null;
	const ownsContext = context === null;
	let transaction = context;
	const capabilities = new Set();
	try {
		transaction ??= await openReviewFsTransaction(
			"retained review inventory native filesystem helper",
			request,
		);
		if (
			transaction.root.observation.identity.platform !== recordedPlatform ||
			!recordedObservationMatches(
				transaction.root.observation,
				request.privateState.tempRoot,
				"directory",
				{
					ignoreLinkCount: true,
				},
			)
		) {
			return null;
		}
		const retained = await inspectRetainedSettlement(
			transaction,
			request,
			expected.location,
			capabilities,
		);
		return retained
			? { path: expected.quarantinePath, provenance: `review request ${request.id}` }
			: null;
	} catch (error) {
		if (strict) throw error;
		return null;
	} finally {
		if (transaction) {
			await closeCapabilities(transaction, capabilities);
			if (ownsContext) await transaction.close();
		}
	}
}

export async function openReviewFsTransaction(
	label = "review native filesystem helper",
	request = null,
) {
	// macOS commonly exposes /var as a symlink to /private/var; open-root
	// intentionally rejects symlink traversal, so bind new and legacy-current
	// transactions to the physical temp root.
	let tempRoot = fs.realpathSync.native(os.tmpdir());
	if (request?.privateState?.version === 2 && exactPrivateState(request)) {
		tempRoot = request.privateState.tempRootPath;
	}
	return openNativeRepoMutation(tempRoot, label);
}

async function wipeReviewArtifact(context, file) {
	const current = await context.session.stat(file.cap);
	const expected = current.observation.identity;
	if (!privateObservation(current.observation, 0o600)) {
		throw new Error("partial private review artifact is not owner-private");
	}
	let offset = 0;
	const size = Number(current.observation.size);
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SUBPROCESS_BUFFER) {
		throw new Error("partial private review artifact has an unsafe size");
	}
	const zeroes = Buffer.alloc(NATIVE_CHUNK_BYTES);
	while (offset < size) {
		const length = Math.min(zeroes.length, size - offset);
		const result = await context.session.write(file.cap, offset, zeroes.subarray(0, length), expected);
		if (result.written < 1) throw new Error("could not overwrite a private review artifact");
		offset += result.written;
	}
	await context.session.flush(file.cap, "all", expected);
	await context.session.truncate(file.cap, 0, expected);
	await context.session.flush(file.cap, "all", expected);
	const wiped = await context.session.stat(file.cap);
	if (
		!recordedObservationMatches(wiped.observation, stableObservation(current.observation), "file") ||
		!privateObservation(wiped.observation, 0o600) ||
		wiped.observation.size !== "0"
	) {
		throw new Error("partial private review artifact was not wiped");
	}
}

async function wipePartialReviewCreation(context, directory, files) {
	if (!directory) return false;
	const failures = [];
	if (!privateObservation(directory.observation, 0o700)) {
		failures.push(new Error("partial private review directory is not owner-private"));
	}
	for (const file of files) {
		try {
			if (file.observation.owner !== directory.observation.owner) {
				throw new Error("partial private review artifact owner does not match its directory owner");
			}
			await wipeReviewArtifact(context, file);
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		await context.session.flush(directory.cap, "namespace", directory.observation.identity);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			failures.map((failure) => failure?.message ?? String(failure)).join("; "),
		);
	}
	return true;
}

/** Create all source-bearing review artifacts in one preflighted helper session. */
export async function createReviewPrivateArtifacts(
	id,
	brief,
	{ lastMessage = false, context: suppliedContext = null } = {},
) {
	if (!REVIEW_REQUEST_ID_PATTERN.test(id)) throw new Error("invalid review request id");
	const context =
		suppliedContext ??
		(await openReviewFsTransaction("private review creation native filesystem helper"));
	const ownsContext = suppliedContext === null;
	const capabilities = new Set();
	const directoryName = `stdd-review-${id.slice(4)}`;
	let directory = null;
	const createdFiles = [];
	try {
		directory = register(
			capabilities,
			await context.session.createDirectory(context.root.cap, directoryName, 0o700),
		);
		if (!privateObservation(directory.observation, 0o700)) {
			throw new Error("private review directory is not owner-private");
		}
		const artifacts = Object.create(null);
		for (const [name, content] of [
			[`${id}.md`, brief],
			...(lastMessage ? [["last-message.txt", ""]] : []),
		]) {
			const file = register(capabilities, await context.session.createFile(directory.cap, name, 0o600));
			createdFiles.push(file);
			await writeNativeFileContent(context, file, content);
			const current = await context.session.stat(file.cap);
			if (
				!sameNativeIdentity(current.observation.identity, file.observation.identity) ||
				!privateObservation(current.observation, 0o600) ||
				current.observation.owner !== directory.observation.owner
			) {
				throw new Error(`private review artifact ${name} changed during creation`);
			}
			artifacts[name] = stableObservation(current.observation);
		}
		await context.session.flush(directory.cap, "namespace", directory.observation.identity);
		const reboundRoot = register(capabilities, await context.session.openRoot(context.rootPath));
		if (!sameNativeIdentity(reboundRoot.observation.identity, context.root.observation.identity)) {
			throw new Error("OS temp root changed during private review creation");
		}
		const reboundDirectory = register(
			capabilities,
			await context.session.openChild(reboundRoot.cap, directoryName),
		);
		if (!sameNativeIdentity(reboundDirectory.observation.identity, directory.observation.identity)) {
			throw new Error("private review directory changed during creation");
		}
		return {
			briefPath: path.join(context.rootPath, directoryName, `${id}.md`),
			outPath: path.join(context.rootPath, directoryName, "last-message.txt"),
			privateState: {
				version: 2,
				tempRootPath: canonicalTempRootPath(
					context.rootPath,
					context.root.observation.identity.platform,
				),
				tempRoot: stableObservation(context.root.observation),
				directory: stableObservation(directory.observation),
				artifacts,
			},
		};
	} catch (error) {
		let wiped = false;
		try {
			wiped = await wipePartialReviewCreation(context, directory, createdFiles);
		} catch (wipeError) {
			error.message = `${error.message}; partial private review wipe failed: ${wipeError.message}`;
		}
		error.message = `${error.message}; partial private review state ${
			wiped ? "was wiped and retained" : "may be retained"
		} at ${path.join(context.rootPath, directoryName)} for manual remediation`;
		throw error;
	} finally {
		await closeCapabilities(context, capabilities);
		if (ownsContext) await context.close();
	}
}

/**
 * Bind the complete source namespace before the caller commits its terminal
 * ledger event. The same capabilities remain live for the subsequent wipe
 * and retained move.
 */
export async function prepareReviewBriefSettlement(context, request, { expectedHash = null } = {}) {
	const location = parseReviewLocation(request);
	const capabilities = new Set();
	try {
		if (!location || !exactPrivateState(request)) return { state: "unsafe", context, capabilities };
		if (
			!recordedObservationMatches(context.root.observation, request.privateState.tempRoot, "directory", {
				ignoreLinkCount: true,
			})
		) {
			return { state: "unsafe", context, capabilities };
		}
		let directory;
		try {
			directory = register(
				capabilities,
				await context.session.openChild(context.root.cap, location.directoryName),
			);
		} catch (error) {
			if (error?.code !== "not-found") throw error;
			const retained = await inspectRetainedSettlement(context, request, location, capabilities);
			return { state: retained ? "retained" : "unsafe", context, capabilities, location, retained };
		}
		if (
			!recordedObservationMatches(directory.observation, request.privateState.directory, "directory") ||
			!privateObservation(directory.observation, 0o700)
		) {
			return { state: "unsafe", context, capabilities };
		}
		const entries = await listNativeDirectory(context, directory);
		const names = entries.map((entry) => entry.name).sort();
		const capturedNames = Object.keys(request.privateState.artifacts).sort();
		if (
			names.length !== capturedNames.length ||
			names.some((name, index) => name !== capturedNames[index]) ||
			names.some((name) => !isReviewOwnedArtifact(request, name))
		) {
			return { state: "unsafe", context, capabilities };
		}
		const artifacts = [];
		for (const name of names) {
			const artifact = register(capabilities, await context.session.openChild(directory.cap, name));
			if (
				recordedOwner(request.privateState.artifacts[name]) !== reviewOwner(request) ||
				artifact.observation.owner !== reviewOwner(request) ||
				!recordedObservationMatches(
					artifact.observation,
					request.privateState.artifacts[name],
					"file",
				) ||
				!privateObservation(artifact.observation, 0o600)
			) {
				return { state: "unsafe", context, capabilities };
			}
			artifacts.push({ name, file: artifact });
		}
		if (expectedHash !== null) {
			if (!/^sha256:[0-9a-f]{64}$/.test(expectedHash)) {
				return { state: "unsafe", context, capabilities };
			}
			const brief = artifacts.find((artifact) => artifact.name === `${request.id}.md`);
			if (
				!brief ||
				hashBytes(await readNativeFile(context, brief.file, MAX_SUBPROCESS_BUFFER)) !== expectedHash
			) {
				return { state: "unsafe", context, capabilities };
			}
		}
		return { state: "source", context, capabilities, request, location, directory, artifacts };
	} catch (error) {
		await closeCapabilities(context, capabilities);
		throw error;
	}
}

async function createOrVerifyQuarantine(prepared) {
	const { context, request, location, capabilities } = prepared;
	let quarantine;
	try {
		quarantine = register(
			capabilities,
			await context.session.openChild(context.root.cap, location.quarantineName),
		);
	} catch (error) {
		if (error?.code !== "not-found") throw error;
		quarantine = register(
			capabilities,
			await context.session.createDirectory(context.root.cap, location.quarantineName, 0o700),
		);
	}
	if (
		quarantine.observation.identity.kind !== "directory" ||
		!privateObservation(quarantine.observation, 0o700) ||
		quarantine.observation.owner !== reviewOwner(request)
	) {
		throw new Error("private review quarantine is not an owner-private directory");
	}
	let inventory = null;
	try {
		inventory = register(
			capabilities,
			await context.session.openChild(quarantine.cap, REVIEW_INVENTORY_NAME),
		);
	} catch (error) {
		if (error?.code !== "not-found") throw error;
	}
	const stagedName = `.inventory-${request.id.slice(4)}.tmp`;
	if (inventory === null) {
		let staged;
		try {
			staged = register(capabilities, await context.session.openChild(quarantine.cap, stagedName));
		} catch (error) {
			if (error?.code !== "not-found") throw error;
			staged = register(
				capabilities,
				await context.session.createFile(quarantine.cap, stagedName, 0o600),
			);
		}
		if (
			!privateObservation(staged.observation, 0o600) ||
			staged.observation.owner !== reviewOwner(request)
		) {
			throw new Error("private review quarantine has an unsafe inventory temporary");
		}
		await writeNativeFileContent(context, staged, inventoryBytes(request, location));
		staged = { ...staged, observation: (await context.session.stat(staged.cap)).observation };
		try {
			await context.session.rename({
				fromParent: quarantine.cap,
				from: stagedName,
				expected: staged.observation.identity,
				toParent: quarantine.cap,
				to: REVIEW_INVENTORY_NAME,
				replace: "never",
			});
		} catch (error) {
			if (!["possible", "committed"].includes(error?.mutation)) throw error;
		}
		await context.session.flush(quarantine.cap, "namespace", quarantine.observation.identity);
		inventory = register(
			capabilities,
			await context.session.openChild(quarantine.cap, REVIEW_INVENTORY_NAME),
		);
		if (!sameNativeIdentity(inventory.observation.identity, staged.observation.identity)) {
			throw new Error("private review quarantine inventory publication was replaced");
		}
	}
	if (
		!privateObservation(inventory.observation, 0o600) ||
		inventory.observation.owner !== reviewOwner(request) ||
		!(await readNativeFile(context, inventory, 64 * 1024)).equals(inventoryBytes(request, location))
	) {
		throw new Error("private review quarantine has mismatched ledger provenance");
	}
	const names = (await listNativeDirectory(context, quarantine)).map((entry) => entry.name).sort();
	if (names.length !== 1 || names[0] !== REVIEW_INVENTORY_NAME) {
		throw new Error("private review quarantine contains an unknown or conflicting sibling");
	}
	return quarantine;
}

async function preflightExistingQuarantineOwner(prepared) {
	const { context, request, location, capabilities } = prepared;
	let quarantine;
	try {
		quarantine = register(
			capabilities,
			await context.session.openChild(context.root.cap, location.quarantineName),
		);
	} catch (error) {
		if (error?.code === "not-found") return;
		throw error;
	}
	if (
		quarantine.observation.identity.kind !== "directory" ||
		!privateObservation(quarantine.observation, 0o700) ||
		quarantine.observation.owner !== reviewOwner(request)
	) {
		throw new Error("private review quarantine is not an owner-private directory");
	}
}

async function retainedMoveCommitted(prepared, quarantine) {
	const { context, directory, location, capabilities } = prepared;
	let source = null;
	let retained = null;
	try {
		source = register(
			capabilities,
			await context.session.openChild(context.root.cap, location.directoryName),
		);
	} catch (error) {
		if (error?.code !== "not-found") throw error;
	}
	try {
		retained = register(
			capabilities,
			await context.session.openChild(quarantine.cap, REVIEW_RETAINED_NAME),
		);
	} catch (error) {
		if (error?.code !== "not-found") throw error;
	}
	return (
		source === null &&
		retained !== null &&
		sameNativeIdentity(retained.observation.identity, directory.observation.identity)
	);
}

export async function settlePreparedReviewBrief(prepared) {
	if (prepared.state === "retained") return true;
	if (prepared.state !== "source") return false;
	const { context, directory, artifacts, location } = prepared;
	await preflightExistingQuarantineOwner(prepared);
	for (const artifact of artifacts) {
		await wipeReviewArtifact(context, artifact.file);
	}
	const finalEntries = await listNativeDirectory(context, directory);
	if (
		finalEntries.length !== artifacts.length ||
		finalEntries.some((entry) => {
			const artifact = artifacts.find((candidate) => candidate.name === entry.name);
			return (
				!artifact || !sameNativeIdentity(entry.observation.identity, artifact.file.observation.identity)
			);
		})
	) {
		return false;
	}
	const quarantine = await createOrVerifyQuarantine(prepared);
	try {
		await context.session.rename({
			fromParent: context.root.cap,
			from: location.directoryName,
			expected: directory.observation.identity,
			toParent: quarantine.cap,
			to: REVIEW_RETAINED_NAME,
			replace: "never",
		});
	} catch (error) {
		if (
			!["possible", "committed"].includes(error?.mutation) ||
			!(await retainedMoveCommitted(prepared, quarantine))
		) {
			throw error;
		}
	}
	await context.session.flush(quarantine.cap, "namespace", quarantine.observation.identity);
	await context.session.flush(context.root.cap, "namespace", context.root.observation.identity);
	if (!(await retainedMoveCommitted(prepared, quarantine))) return false;
	const reboundRoot = register(prepared.capabilities, await context.session.openRoot(context.rootPath));
	if (!sameNativeIdentity(reboundRoot.observation.identity, context.root.observation.identity))
		return false;
	const reboundQuarantine = register(
		prepared.capabilities,
		await context.session.openChild(reboundRoot.cap, location.quarantineName),
	);
	const reboundRetained = register(
		prepared.capabilities,
		await context.session.openChild(reboundQuarantine.cap, REVIEW_RETAINED_NAME),
	);
	if (!sameNativeIdentity(reboundRetained.observation.identity, directory.observation.identity))
		return false;
	return Boolean(
		await inspectRetainedSettlement(context, prepared.request, location, prepared.capabilities),
	);
}

export async function closePreparedReviewBrief(prepared) {
	await closeCapabilities(prepared.context, prepared.capabilities);
}

/** Settle one request with one helper session when no wider transaction owns one. */
export async function removeReviewBrief(
	request,
	{ dryRun = false, expectedHash = null, context = null } = {},
) {
	const ownedContext = context === null;
	const transaction =
		context ?? (await openReviewFsTransaction("review native filesystem helper", request));
	let prepared;
	try {
		prepared = await prepareReviewBriefSettlement(transaction, request, { expectedHash });
		if (dryRun) return prepared.state === "source" || prepared.state === "retained";
		return await settlePreparedReviewBrief(prepared);
	} finally {
		if (prepared) await closePreparedReviewBrief(prepared);
		if (ownedContext) await transaction.close();
	}
}

export async function readVerifiedReviewArtifact(request, name) {
	if (!REVIEW_PRIVATE_COMPANIONS.has(name)) return null;
	const location = parseReviewLocation(request);
	if (!location || !exactPrivateState(request)) return null;
	const context = await openReviewFsTransaction("private review read native filesystem helper", request);
	const capabilities = new Set();
	try {
		if (
			!recordedObservationMatches(context.root.observation, request.privateState.tempRoot, "directory", {
				ignoreLinkCount: true,
			})
		) {
			return null;
		}
		const directory = register(
			capabilities,
			await context.session.openChild(context.root.cap, location.directoryName),
		);
		if (
			!recordedObservationMatches(directory.observation, request.privateState.directory, "directory") ||
			!privateObservation(directory.observation, 0o700)
		) {
			return null;
		}
		const file = register(capabilities, await context.session.openChild(directory.cap, name));
		if (
			recordedOwner(request.privateState.artifacts?.[name]) !== reviewOwner(request) ||
			file.observation.owner !== reviewOwner(request) ||
			!recordedObservationMatches(file.observation, request.privateState.artifacts?.[name], "file") ||
			!privateObservation(file.observation, 0o600)
		) {
			return null;
		}
		return (await readNativeFile(context, file, MAX_SUBPROCESS_BUFFER)).toString("utf8");
	} catch (error) {
		if (error?.code === "not-found" || error?.code === "symlink-rejected") return null;
		throw error;
	} finally {
		await closeCapabilities(context, capabilities);
		await context.close();
	}
}
