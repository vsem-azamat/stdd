import fs from "node:fs";
import path from "node:path";
import {
	openNativeRepoPath,
	openOrCreateNativeRepoDirectory,
	readNativeFile,
	verifyNativeRepoDirectory,
	writeNativeFileContent,
} from "./held-fs.mjs";
import { sha256 } from "./lib.mjs";
import { viewPath } from "./path-bytes.mjs";

export const WORKER_DELETIONS_REL = ".stdd/worker-deletions";
export const WORKER_FILE_MODES = new Set([0o600, 0o644, 0o755]);
export const WORKER_DIRECTORY_MODES = new Set([0o700, 0o755]);
const WORKER_NATIVE_READ_LIMIT = 64 * 1024 * 1024;

export const workerPathForMatch = (relative) => Buffer.from(relative, "utf8").toString("latin1");
export const workerViewPath = (relative) => viewPath(workerPathForMatch(relative));

function sameNativeIdentity(left, right) {
	return (
		left?.version === right?.version &&
		left?.platform === right?.platform &&
		left?.volume === right?.volume &&
		left?.fileId === right?.fileId &&
		left?.kind === right?.kind
	);
}

function sameNativeObservation(left, right) {
	return (
		sameNativeIdentity(left?.identity, right?.identity) &&
		left?.owner === right?.owner &&
		left?.permissions === right?.permissions &&
		left?.linkCount === right?.linkCount &&
		left?.size === right?.size &&
		left?.modifiedNs === right?.modifiedNs &&
		left?.changedNs === right?.changedNs
	);
}

function nativeMode(observation, fallback = null) {
	if (observation.identity.platform === "win32") return fallback;
	const parsed = Number(observation.permissions);
	return Number.isSafeInteger(parsed) ? parsed & 0o777 : null;
}

function assertWorkerFileObservation(
	context,
	relative,
	observation,
	modeHint = null,
	legacyMode = null,
) {
	if (observation.identity.kind !== "file" || observation.linkCount !== "1") {
		throw new Error(
			`worker path ${workerViewPath(relative)} must be a single-linked regular file or symlink`,
		);
	}
	if (
		observation.identity.platform !== "win32" &&
		observation.owner !== context.root.observation.owner
	) {
		throw new Error(`worker path ${workerViewPath(relative)} must be owned by the worker root owner`);
	}
	const mode = nativeMode(observation, modeHint);
	if (!WORKER_FILE_MODES.has(mode) && mode !== legacyMode) {
		throw new Error(
			`worker path ${workerViewPath(relative)} has unsupported mode ${
				mode === null ? "unknown" : `0${mode.toString(8)}`
			}; supported file modes are 0600, 0644, and 0755`,
		);
	}
	return mode;
}

function symlinkTargetBytes(state) {
	if (typeof state?.targetBase64 === "string") return Buffer.from(state.targetBase64, "base64");
	return Buffer.from(state?.target ?? "", "utf8");
}

function symlinkTargetString(state, relative, platform = null) {
	const bytes = symlinkTargetBytes(state);
	const windowsTarget = platform === "win32" || state?.portable?.sandbox?.platform === "win32";
	let target = bytes.toString(windowsTarget ? "utf16le" : "utf8");
	if (!Buffer.from(target, windowsTarget ? "utf16le" : "utf8").equals(bytes)) {
		throw new Error(
			windowsTarget
				? `worker symlink ${workerViewPath(relative)} has a malformed UTF-16LE target that protocol-v1 cannot publish`
				: `worker symlink ${workerViewPath(relative)} has a non-UTF-8 target that protocol-v1 cannot publish`,
		);
	}
	if (windowsTarget) {
		if (target.startsWith("\\??\\UNC\\")) target = `\\\\${target.slice(8)}`;
		else if (target.startsWith("\\??\\")) target = target.slice(4);
	}
	return target;
}

export function preflightWorkerCreationState(
	relative,
	state,
	inheritedLegacyMode = null,
	platform = null,
) {
	if (state === null) return;
	if (state.type === "file") {
		if (
			(inheritedLegacyMode !== null && state.mode !== inheritedLegacyMode) ||
			(inheritedLegacyMode === null && !WORKER_FILE_MODES.has(state.mode))
		) {
			throw new Error(`worker path ${workerViewPath(relative)} has an unsupported creation mode`);
		}
		return;
	}
	if (state.type === "symlink") {
		symlinkTargetString(state, relative, platform);
		return;
	}
	throw new Error(`worker path ${workerViewPath(relative)} has an unsupported file type`);
}

async function closeNative(context, ...values) {
	const capabilities = new Set(
		values
			.flat()
			.map((value) => (typeof value === "string" ? value : value?.cap))
			.filter((cap) => cap && cap !== context.root.cap),
	);
	for (const cap of capabilities) await context.session.closeCapability(cap).catch(() => {});
}

async function openNativeParent(context, relative, label) {
	const parentRelative = path.posix.dirname(relative);
	return openNativeRepoPath(context, parentRelative, label);
}

async function statNativeChild(context, parent, name) {
	try {
		return (await context.session.stat(parent.cap, name)).observation;
	} catch (error) {
		if (error?.code === "not-found") return null;
		throw error;
	}
}

export async function readNativeWorkerPath(
	context,
	relative,
	{ bytes = false, modeHint = null, legacyMode = null } = {},
) {
	let parent;
	let file;
	try {
		try {
			parent = await openNativeParent(
				context,
				relative,
				`worker path parent ${JSON.stringify(path.posix.dirname(relative))}`,
			);
		} catch (error) {
			if (error?.code === "not-found") return { state: null, bytes: null, observation: null };
			throw error;
		}
		const name = path.posix.basename(relative);
		const observed = await statNativeChild(context, parent, name);
		if (observed === null) return { state: null, bytes: null, observation: null };
		if (observed.identity.kind === "symlink") {
			const result = await context.session.readLink(parent.cap, name, observed.identity);
			const targetBytes = Buffer.from(result.data, "base64");
			const after = await context.session.stat(parent.cap, name);
			if (!sameNativeObservation(observed, after.observation)) {
				throw new Error(`worker path ${workerViewPath(relative)} changed while reading its symlink`);
			}
			const target = targetBytes.toString("utf8");
			return {
				state: {
					type: "symlink",
					target,
					targetBase64: targetBytes.toString("base64"),
					hash: sha256(Buffer.concat([Buffer.from("link:"), targetBytes])),
				},
				bytes: null,
				observation: observed,
			};
		}
		const mode = assertWorkerFileObservation(context, relative, observed, modeHint, legacyMode);
		file = await context.session.openChild(parent.cap, name);
		if (!sameNativeObservation(observed, file.observation)) {
			throw new Error(`worker path ${workerViewPath(relative)} changed before it could be read`);
		}
		const content = await readNativeFile(context, file, WORKER_NATIVE_READ_LIMIT);
		const finalPath = await context.session.stat(parent.cap, name);
		if (!sameNativeObservation(observed, finalPath.observation)) {
			throw new Error(`worker path ${workerViewPath(relative)} changed while reading`);
		}
		return {
			state: { type: "file", hash: sha256(content), mode },
			bytes: bytes ? content : null,
			observation: observed,
		};
	} finally {
		await closeNative(context, file, parent);
	}
}

export function stateWithPortableIdentity(state, sourceObservation, sandboxObservation) {
	if (state === null) return null;
	return {
		...state,
		portable: {
			source: sourceObservation.identity,
			sandbox: sandboxObservation.identity,
		},
	};
}

export function sameWorkerState(left, right) {
	if (left === null || left === undefined || right === null || right === undefined) {
		return (left ?? null) === (right ?? null);
	}
	if (left.type !== right.type || left.hash !== right.hash) return false;
	if (left.type === "file") return left.mode === right.mode;
	if (left.type === "symlink") {
		return symlinkTargetBytes(left).equals(symlinkTargetBytes(right));
	}
	return false;
}

async function ensureWorkerParent(context, relative, mode = 0o755, beforeCommit = null) {
	const parentRelative = path.posix.dirname(relative);
	return openOrCreateNativeRepoDirectory(context, parentRelative, {
		mode,
		label: `worker parent for ${JSON.stringify(relative)}`,
		beforeCommit,
	});
}

export async function preflightWorkerParent(context, relative) {
	const segments = path.posix.dirname(relative) === "." ? [] : path.posix.dirname(relative).split("/");
	let current = context.root;
	const opened = [];
	try {
		for (const segment of segments) {
			try {
				current = await context.session.openChild(current.cap, segment);
			} catch (error) {
				if (error?.code === "not-found") return;
				throw error;
			}
			opened.push(current);
			if (current.observation.identity.kind !== "directory") {
				throw new Error(`worker parent for ${workerViewPath(relative)} contains a non-directory`);
			}
		}
	} finally {
		await closeNative(context, opened);
	}
}

async function flushAndVerifyParent(context, relative, parent) {
	await context.session.flush(parent.cap, "namespace", parent.observation.identity);
	await verifyNativeRepoDirectory(
		context,
		path.posix.dirname(relative),
		parent.observation.identity,
		`worker parent for ${JSON.stringify(relative)}`,
	);
}

export async function writeNewWorkerPath(context, relative, result) {
	if (result.state === null) return { state: null, observation: null };
	const parent = await ensureWorkerParent(
		context,
		relative,
		relative.startsWith(".stdd/") ? 0o700 : 0o755,
	);
	let created;
	try {
		const name = path.posix.basename(relative);
		if (result.state.type === "symlink") {
			created = await context.session.symlink(
				parent.cap,
				name,
				symlinkTargetString(result.state, relative, result.observation?.identity?.platform ?? null),
			);
		} else {
			created = await context.session.createFile(parent.cap, name, result.state.mode);
			await writeNativeFileContent(context, created, result.bytes);
		}
		await flushAndVerifyParent(context, relative, parent);
		const published = await context.session.stat(parent.cap, name);
		if (!sameNativeIdentity(published.observation.identity, created.observation.identity)) {
			const error = new Error(
				`worker destination ${workerViewPath(relative)} changed after publication`,
			);
			error.mutation = "committed";
			throw error;
		}
		if (result.state.type === "symlink") {
			const linked = await context.session.readLink(parent.cap, name, created.observation.identity);
			if (!Buffer.from(linked.data, "base64").equals(symlinkTargetBytes(result.state))) {
				throw new Error(`worker destination ${workerViewPath(relative)} has the wrong symlink target`);
			}
		}
		return { state: result.state, observation: published.observation };
	} finally {
		await closeNative(context, created, parent);
	}
}

async function settleWorkerTemporary(
	context,
	relative,
	workerId,
	staged = null,
	assertCollectionContext = null,
	legacyMode = null,
) {
	const inspected = await readNativeWorkerPath(context, relative, {
		bytes: true,
		modeHint: legacyMode ?? 0o644,
		legacyMode,
	});
	if (inspected.state === null) return;
	if (staged && !sameNativeIdentity(inspected.observation.identity, staged.observation.identity)) {
		throw new Error(`worker temporary ${workerViewPath(relative)} changed before cleanup`);
	}
	let settledState = inspected.state;
	let expectedObservation = inspected.observation;
	if (inspected.state.type === "file") {
		if (assertCollectionContext !== null) await assertCollectionContext();
		const parent = await openNativeParent(context, relative, "worker temporary cleanup parent");
		let file;
		try {
			file = await context.session.openChild(parent.cap, path.posix.basename(relative));
			if (!sameNativeIdentity(file.observation.identity, inspected.observation.identity)) {
				throw new Error(`worker temporary ${workerViewPath(relative)} changed before cleanup`);
			}
			let offset = 0;
			const length = inspected.bytes.length;
			while (offset < length) {
				const chunk = Buffer.alloc(Math.min(64 * 1024, length - offset));
				const result = await context.session.write(file.cap, offset, chunk, file.observation.identity);
				if (result.written < 1) throw new Error("worker temporary cleanup made no progress");
				offset += result.written;
			}
			await context.session.flush(file.cap, "all", file.observation.identity);
			await context.session.truncate(file.cap, 0, file.observation.identity);
			await context.session.flush(file.cap, "all", file.observation.identity);
		} finally {
			await closeNative(context, file, parent);
		}
		const zeroed = await readNativeWorkerPath(context, relative, {
			modeHint: inspected.state.mode,
			legacyMode,
		});
		settledState = zeroed.state;
		expectedObservation = zeroed.observation;
	}
	const identityKey = sha256(JSON.stringify(expectedObservation.identity)).slice("sha256:".length);
	await quarantineWorkerDeletion(
		context,
		relative,
		workerId,
		settledState,
		expectedObservation,
		assertCollectionContext,
		`${relative}#temporary-${identityKey}`,
		legacyMode,
	);
}

async function assertNativeExpectedState(context, relative, expectedState, legacyMode = null) {
	const live = await readNativeWorkerPath(context, relative, {
		legacyMode,
		modeHint: expectedState?.type === "file" ? expectedState.mode : null,
	});
	if (!sameWorkerState(live.state, expectedState)) {
		throw new Error(
			`worker collection path ${workerViewPath(relative)} changed after preflight ` +
				`(${JSON.stringify({ expected: expectedState, actual: live.state })})`,
		);
	}
	return live;
}

export async function publishWorkerFile(
	context,
	relative,
	content,
	mode,
	expectedState,
	assertCollectionContext = null,
	workerId = "worker-000000000000000000000000",
	inheritedLegacyMode = null,
) {
	if (
		(inheritedLegacyMode !== null &&
			(!Number.isInteger(inheritedLegacyMode) ||
				inheritedLegacyMode < 0 ||
				inheritedLegacyMode > 0o777 ||
				mode !== inheritedLegacyMode)) ||
		(inheritedLegacyMode === null && !WORKER_FILE_MODES.has(mode))
	) {
		throw new Error(
			`worker path ${workerViewPath(relative)} may use only its exact inherited legacy mode`,
		);
	}
	await assertNativeExpectedState(context, relative, expectedState);
	if (assertCollectionContext !== null) await assertCollectionContext();
	const beforeCommit = async () => {
		await assertNativeExpectedState(context, relative, expectedState);
		if (assertCollectionContext !== null) await assertCollectionContext();
	};
	const parent = await ensureWorkerParent(context, relative, 0o755, beforeCommit);
	const token = sha256(`${workerId}:${relative}`).slice(7, 31);
	const temp = `.stdd-worker-collect-${token}.tmp`;
	const temporaryRelative =
		path.posix.dirname(relative) === "." ? temp : `${path.posix.dirname(relative)}/${temp}`;
	let staged;
	try {
		await beforeCommit();
		const stagedMode = WORKER_FILE_MODES.has(mode) ? mode : 0o600;
		staged = await context.session.createFile(parent.cap, temp, stagedMode);
		await writeNativeFileContent(context, staged, content);
		if (mode !== stagedMode) {
			const changed = await context.session.setMode(staged.cap, mode, staged.observation.identity);
			staged = { ...staged, observation: changed.observation };
			await context.session.flush(staged.cap, "all", staged.observation.identity);
		}
		await beforeCommit();
		try {
			await context.session.rename({
				fromParent: parent.cap,
				from: temp,
				expected: staged.observation.identity,
				toParent: parent.cap,
				to: path.posix.basename(relative),
				replace: "never",
			});
		} catch (error) {
			if (!["possible", "committed"].includes(error?.mutation)) throw error;
			const rebound = await context.session.stat(parent.cap, path.posix.basename(relative));
			if (!sameNativeIdentity(rebound.observation.identity, staged.observation.identity)) throw error;
		}
		await flushAndVerifyParent(context, relative, parent);
		return staged.observation;
	} catch (error) {
		try {
			await settleWorkerTemporary(
				context,
				temporaryRelative,
				workerId,
				staged,
				assertCollectionContext,
				inheritedLegacyMode,
			);
			error.message = `${error.message}; inactive worker temporary was securely quarantined`;
		} catch (cleanupError) {
			error.message = `${error.message}; worker temporary cleanup failed: ${cleanupError.message}`;
		}
		throw error;
	} finally {
		await closeNative(context, staged, parent);
	}
}

export async function publishWorkerSymlink(
	context,
	relative,
	state,
	workerId,
	expectedState,
	assertCollectionContext = null,
) {
	await assertNativeExpectedState(context, relative, expectedState);
	if (assertCollectionContext !== null) await assertCollectionContext();
	const beforeCommit = async () => {
		await assertNativeExpectedState(context, relative, expectedState);
		if (assertCollectionContext !== null) await assertCollectionContext();
	};
	const parent = await ensureWorkerParent(context, relative, 0o755, beforeCommit);
	const temp = `.stdd-worker-link-${workerId.slice("worker-".length)}-${sha256(relative).slice(7, 23)}`;
	const temporaryRelative =
		path.posix.dirname(relative) === "." ? temp : `${path.posix.dirname(relative)}/${temp}`;
	let staged;
	try {
		await beforeCommit();
		staged = await context.session.symlink(parent.cap, temp, symlinkTargetString(state, relative));
		await beforeCommit();
		try {
			await context.session.rename({
				fromParent: parent.cap,
				from: temp,
				expected: staged.observation.identity,
				toParent: parent.cap,
				to: path.posix.basename(relative),
				replace: "never",
			});
		} catch (error) {
			if (!["possible", "committed"].includes(error?.mutation)) throw error;
			const rebound = await context.session.stat(parent.cap, path.posix.basename(relative));
			if (!sameNativeIdentity(rebound.observation.identity, staged.observation.identity)) throw error;
		}
		await flushAndVerifyParent(context, relative, parent);
		const linked = await context.session.readLink(
			parent.cap,
			path.posix.basename(relative),
			staged.observation.identity,
		);
		if (!Buffer.from(linked.data, "base64").equals(symlinkTargetBytes(state))) {
			throw new Error(`worker collection could not verify ${workerViewPath(relative)}`);
		}
		return staged.observation;
	} catch (error) {
		try {
			await settleWorkerTemporary(context, temporaryRelative, workerId, staged, assertCollectionContext);
			error.message = `${error.message}; inactive worker temporary was quarantined`;
		} catch (cleanupError) {
			error.message = `${error.message}; worker temporary cleanup failed: ${cleanupError.message}`;
		}
		throw error;
	} finally {
		await closeNative(context, staged, parent);
	}
}

function workerDeletionToken(relative) {
	return sha256(Buffer.from(relative, "utf8")).slice("sha256:".length);
}

export function workerDeletionQuarantinePath(relative, workerId) {
	return `${WORKER_DELETIONS_REL}/${workerId}/${workerDeletionToken(relative)}`;
}

function workerDeletionInventory(workerId, relative, expectedState, expectedIdentity) {
	return Buffer.from(
		`${JSON.stringify(
			{
				schema: 1,
				workerId,
				path: relative,
				state: expectedState,
				expectedIdentity,
			},
			null,
			2,
		)}\n`,
	);
}

function exactKeys(value, keys) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validWorkerDeletionState(state) {
	if (state?.type === "file") {
		return (
			exactKeys(state, ["type", "hash", "mode"]) &&
			/^sha256:[0-9a-f]{64}$/.test(state.hash) &&
			Number.isInteger(state.mode) &&
			state.mode >= 0 &&
			state.mode <= 0o777
		);
	}
	return (
		state?.type === "symlink" &&
		exactKeys(state, ["type", "target", "targetBase64", "hash"]) &&
		typeof state.target === "string" &&
		typeof state.targetBase64 === "string" &&
		Buffer.from(state.targetBase64, "base64").toString("base64") === state.targetBase64 &&
		/^sha256:[0-9a-f]{64}$/.test(state.hash)
	);
}

function parseWorkerDeletionInventory(bytes, workerId, relative = null, token = null) {
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new Error(`worker deletion quarantine inventory is malformed: ${error.message}`);
	}
	if (
		!exactKeys(parsed, ["schema", "workerId", "path", "state", "expectedIdentity"]) ||
		parsed.schema !== 1 ||
		parsed.workerId !== workerId ||
		typeof parsed.path !== "string" ||
		(relative !== null && parsed.path !== relative) ||
		(token !== null && workerDeletionToken(parsed.path) !== token) ||
		!validWorkerDeletionState(parsed.state) ||
		!exactKeys(parsed.expectedIdentity, ["version", "platform", "volume", "fileId", "kind"]) ||
		parsed.expectedIdentity.version !== 2 ||
		!["linux", "darwin", "win32"].includes(parsed.expectedIdentity.platform) ||
		typeof parsed.expectedIdentity.volume !== "string" ||
		typeof parsed.expectedIdentity.fileId !== "string" ||
		parsed.expectedIdentity.kind !== parsed.state.type
	) {
		throw new Error("worker deletion quarantine inventory does not match its exact provenance schema");
	}
	return parsed;
}

async function assertPrivateWorkerObject(context, held, label, kind) {
	if (
		held.observation.identity.kind !== kind ||
		(held.observation.identity.platform !== "win32" &&
			held.observation.owner !== context.root.observation.owner) ||
		(kind === "file" && held.observation.linkCount !== "1")
	) {
		throw new Error(`${label} is not an exact owner-private ${kind}`);
	}
	try {
		await context.session.verifyPrivate(held.cap);
	} catch (error) {
		throw new Error(`${label} is not owner-private: ${error.message}`, { cause: error });
	}
}

async function openPrivateWorkerPath(
	context,
	targetRelative,
	{ create = false, beforeCommit = null } = {},
) {
	const segments = targetRelative.split("/");
	let current = context.root;
	const opened = [];
	try {
		for (const [index, segment] of segments.entries()) {
			try {
				current = await context.session.openChild(current.cap, segment);
			} catch (error) {
				if (!create || error?.code !== "not-found") throw error;
				if (beforeCommit !== null) await beforeCommit();
				current = await context.session.createDirectory(current.cap, segment, 0o700);
			}
			opened.push(current);
			if (index > 0) {
				await assertPrivateWorkerObject(
					context,
					current,
					`worker deletion quarantine ancestor ${segments.slice(0, index + 1).join("/")}`,
					"directory",
				);
			}
		}
		for (const held of opened.slice(0, -1)) await closeNative(context, held);
		return current;
	} catch (error) {
		await closeNative(context, opened);
		throw error;
	}
}

export async function preflightPrivateWorkerQuarantine(context, relative, workerId) {
	const segments = workerDeletionQuarantinePath(relative, workerId).split("/");
	let current = context.root;
	const opened = [];
	try {
		for (const [index, segment] of segments.entries()) {
			try {
				current = await context.session.openChild(current.cap, segment);
			} catch (error) {
				if (error?.code === "not-found") return;
				throw error;
			}
			opened.push(current);
			if (index > 0) {
				await assertPrivateWorkerObject(
					context,
					current,
					`worker deletion quarantine ancestor ${segments.slice(0, index + 1).join("/")}`,
					"directory",
				);
			}
		}
	} finally {
		await closeNative(context, opened);
	}
}

async function openPrivateWorkerQuarantine(context, relative, workerId, options = {}) {
	const containerRelative = workerDeletionQuarantinePath(relative, workerId);
	return {
		container: await openPrivateWorkerPath(context, containerRelative, options),
		containerRelative,
	};
}

export async function readWorkerDeletionQuarantineState(context, relative, workerId) {
	let container;
	let inventory;
	try {
		try {
			({ container } = await openPrivateWorkerQuarantine(context, relative, workerId));
		} catch (error) {
			if (error?.code === "not-found") return null;
			throw error;
		}
		try {
			inventory = await context.session.openChild(container.cap, "inventory.json");
		} catch (error) {
			if (error?.code === "not-found") return null;
			throw error;
		}
		await assertPrivateWorkerObject(context, inventory, "worker deletion inventory", "file");
		const parsed = parseWorkerDeletionInventory(
			await readNativeFile(context, inventory, 64 * 1024),
			workerId,
			relative,
		);
		const payload = await readNativeWorkerPath(
			{
				...context,
				root: container,
				rootPath: path.join(context.rootPath, workerDeletionQuarantinePath(relative, workerId)),
			},
			"payload",
			{ modeHint: parsed.state?.mode ?? null, legacyMode: parsed.state?.mode ?? null },
		);
		// Inventory is deliberately durable before the identity-conditioned
		// move. A retry resumes that exact move when the payload is not there yet.
		if (payload.state === null) return null;
		if (
			!sameWorkerState(payload.state, parsed.state) ||
			!sameNativeIdentity(payload.observation.identity, parsed.expectedIdentity)
		) {
			throw new Error("worker deletion quarantine payload does not match its inventory");
		}
		return payload.state;
	} finally {
		await closeNative(context, inventory, container);
	}
}

export async function quarantineWorkerDeletion(
	context,
	relative,
	workerId,
	expectedState,
	expectedObservation,
	assertCollectionContext = null,
	quarantineRelative = relative,
	legacyMode = null,
) {
	const existing = await readWorkerDeletionQuarantineState(context, quarantineRelative, workerId);
	if (sameWorkerState(existing, expectedState)) return;
	const beforeCommit = async () => {
		const live = await assertNativeExpectedState(context, relative, expectedState, legacyMode);
		if (!sameNativeIdentity(live.observation?.identity, expectedObservation?.identity)) {
			throw new Error(`worker deletion source ${workerViewPath(relative)} changed after preflight`);
		}
		if (assertCollectionContext !== null) await assertCollectionContext();
	};
	await beforeCommit();
	const sourceParent = await openNativeParent(context, relative, "worker deletion source parent");
	const { container, containerRelative } = await openPrivateWorkerQuarantine(
		context,
		quarantineRelative,
		workerId,
		{ create: true, beforeCommit },
	);
	let inventory;
	try {
		await beforeCommit();
		const inventoryBytes = workerDeletionInventory(
			workerId,
			quarantineRelative,
			expectedState,
			expectedObservation.identity,
		);
		try {
			inventory = await context.session.openChild(container.cap, "inventory.json");
			const existingBytes = await readNativeFile(context, inventory, 64 * 1024);
			if (!existingBytes.equals(inventoryBytes)) {
				throw new Error("worker deletion quarantine inventory conflicts with this collection");
			}
		} catch (error) {
			if (error?.code !== "not-found") throw error;
			await beforeCommit();
			inventory = await context.session.createFile(container.cap, "inventory.json", 0o600);
			await writeNativeFileContent(context, inventory, inventoryBytes);
		}
		await assertPrivateWorkerObject(context, inventory, "worker deletion inventory", "file");
		await context.session.flush(container.cap, "namespace", container.observation.identity);
		await beforeCommit();
		await assertPrivateWorkerObject(
			context,
			container,
			`worker deletion quarantine ${containerRelative}`,
			"directory",
		);
		try {
			await context.session.rename({
				fromParent: sourceParent.cap,
				from: path.posix.basename(relative),
				expected: expectedObservation.identity,
				toParent: container.cap,
				to: "payload",
				replace: "never",
			});
		} catch (error) {
			if (!["possible", "committed"].includes(error?.mutation)) throw error;
			const retained = await readNativeWorkerPath(
				{
					...context,
					root: container,
					rootPath: path.join(context.rootPath, containerRelative),
				},
				"payload",
				{ modeHint: expectedState?.mode ?? null },
			);
			if (
				!sameWorkerState(retained.state, expectedState) ||
				!sameNativeIdentity(retained.observation?.identity, expectedObservation.identity)
			) {
				throw error;
			}
		}
		for (const directory of [sourceParent, container]) {
			await context.session.flush(directory.cap, "namespace", directory.observation.identity);
		}
		await assertPrivateWorkerObject(
			context,
			container,
			`worker deletion quarantine ${containerRelative}`,
			"directory",
		);
		await verifyNativeRepoDirectory(
			context,
			path.posix.dirname(relative),
			sourceParent.observation.identity,
			`worker deletion source parent for ${workerViewPath(relative)}`,
		);
		await verifyNativeRepoDirectory(
			context,
			containerRelative,
			container.observation.identity,
			`worker deletion quarantine for ${workerViewPath(relative)}`,
		);
	} finally {
		await closeNative(context, inventory, container, sourceParent);
	}
}

export async function workerQuarantineInventory(context, workerIds) {
	const inventory = [];
	for (const workerId of [...new Set(workerIds)].sort()) {
		let root;
		try {
			root = await openPrivateWorkerPath(context, `${WORKER_DELETIONS_REL}/${workerId}`);
		} catch (error) {
			if (error?.code === "not-found" || error?.cause?.code === "not-found") continue;
			throw error;
		}
		try {
			let cursor = null;
			do {
				const page = await context.session.list(root.cap, { cursor, limit: 256 });
				cursor = page.cursor;
				for (const entry of page.entries) {
					if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
					let container;
					let inventoryFile;
					try {
						container = await context.session.openChild(root.cap, entry.name);
						await assertPrivateWorkerObject(
							context,
							container,
							`retained worker quarantine ${workerId}/${entry.name}`,
							"directory",
						);
						inventoryFile = await context.session.openChild(container.cap, "inventory.json");
						await assertPrivateWorkerObject(
							context,
							inventoryFile,
							`retained worker quarantine ${workerId}/${entry.name}/inventory.json`,
							"file",
						);
						const parsed = parseWorkerDeletionInventory(
							await readNativeFile(context, inventoryFile, 64 * 1024),
							workerId,
							null,
							entry.name,
						);
						const nested = {
							...context,
							root: container,
							rootPath: path.join(context.rootPath, WORKER_DELETIONS_REL, workerId, entry.name),
						};
						const payload = await readNativeWorkerPath(nested, "payload", {
							modeHint: parsed.state?.mode ?? null,
							legacyMode: parsed.state?.mode ?? null,
						});
						if (
							payload.state !== null &&
							sameWorkerState(payload.state, parsed.state) &&
							sameNativeIdentity(payload.observation.identity, parsed.expectedIdentity)
						) {
							inventory.push({
								relative: `${WORKER_DELETIONS_REL}/${workerId}/${entry.name}`,
								provenance: `worker ${workerId}, deleted ${workerViewPath(parsed.path)}`,
							});
						}
					} catch (error) {
						if (error?.code !== "not-found") throw error;
						// An interrupted location without inventory or payload is not yet proven inventory.
					} finally {
						await closeNative(context, inventoryFile, container);
					}
				}
			} while (cursor !== null);
		} finally {
			await closeNative(context, root);
		}
	}
	return inventory.sort((left, right) => left.relative.localeCompare(right.relative));
}

// Read-only managed-sandbox commands intentionally do not require the helper.
// This compatibility reader performs no mutation; create and collect use the
// capability-relative functions above for every transaction observation.
export function readWorkerPathState(root, relative, { bytes = false } = {}) {
	const absolute = path.join(root, ...relative.split("/"));
	let observed;
	try {
		observed = fs.lstatSync(absolute, { bigint: true });
	} catch (error) {
		if (error.code === "ENOENT") return { state: null, bytes: null };
		throw error;
	}
	if (observed.isSymbolicLink()) {
		const targetBytes = fs.readlinkSync(absolute, { encoding: "buffer" });
		const after = fs.lstatSync(absolute, { bigint: true });
		if (!after.isSymbolicLink() || observed.dev !== after.dev || observed.ino !== after.ino) {
			throw new Error(`worker path ${workerViewPath(relative)} changed while reading its symlink`);
		}
		return {
			state: {
				type: "symlink",
				target: targetBytes.toString("utf8"),
				targetBase64: targetBytes.toString("base64"),
				hash: sha256(Buffer.concat([Buffer.from("link:"), targetBytes])),
			},
			bytes: null,
		};
	}
	if (!observed.isFile() || observed.nlink !== 1n) {
		throw new Error(
			`worker path ${workerViewPath(relative)} must be a single-linked regular file or symlink`,
		);
	}
	const mode = Number(observed.mode & 0o777n);
	const content = fs.readFileSync(absolute);
	const after = fs.lstatSync(absolute, { bigint: true });
	if (
		observed.dev !== after.dev ||
		observed.ino !== after.ino ||
		observed.size !== after.size ||
		observed.mtimeNs !== after.mtimeNs ||
		observed.ctimeNs !== after.ctimeNs
	) {
		throw new Error(`worker path ${workerViewPath(relative)} changed while reading`);
	}
	return { state: { type: "file", hash: sha256(content), mode }, bytes: bytes ? content : null };
}
