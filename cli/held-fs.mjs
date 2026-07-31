import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publishHeldParentFile, sameFileIdentity } from "../sdk/held-publication.mjs";
import { openNativeFsSession } from "../sdk/native-fs.mjs";
import { resolveRepoPath, resolveWritableRepoPath } from "../sdk/path.mjs";

const MAX_NATIVE_CHUNK = 64 * 1024;

function relativeSegments(relative, label) {
	const normalized = relative === "." ? "" : relative;
	if (
		typeof normalized !== "string" ||
		path.isAbsolute(normalized) ||
		normalized.includes("\\") ||
		normalized.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new Error(`${label} must be a safe repository-relative path`);
	}
	return normalized === "" ? [] : normalized.split("/");
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

function nativeFailure(label, error) {
	const unsafeSymlink = error?.code === "symlink-rejected" ? "unsafe symlink: " : "";
	const detail =
		error && typeof error === "object" && "code" in error
			? `${unsafeSymlink}${error.message} (${error.code}, mutation=${error.mutation ?? "unknown"})`
			: (error?.message ?? String(error));
	const wrapped = new Error(`${label}: ${detail}`, { cause: error });
	for (const field of ["code", "class", "operation", "osCode", "mutation", "retryable"]) {
		if (error && typeof error === "object" && field in error) wrapped[field] = error[field];
	}
	return wrapped;
}

/**
 * One verified helper session for one mutating init/configure command.
 * Artifact verification, handshake, root binding, and filesystem probing all
 * complete before the returned context permits its first mutation.
 */
export async function openNativeRepoMutation(targetDir, label = "native filesystem helper") {
	let session = null;
	try {
		const packageRoot = process.env.STDD_NATIVE_FS_PACKAGE_ROOT;
		session = await openNativeFsSession(packageRoot ? { packageRoot } : {});
		const rootPath = path.resolve(targetDir);
		const root = await session.openRoot(rootPath);
		await session.probe(root.cap);
		return {
			session,
			root,
			rootPath,
			async close() {
				await session.close();
			},
		};
	} catch (error) {
		if (session) await session.close().catch(() => {});
		throw nativeFailure(`${label} preflight failed`, error);
	}
}

export async function openNativeRepoPath(context, relative, label = "repository path") {
	const segments = relativeSegments(relative, label);
	let current = context.root;
	for (const segment of segments) {
		try {
			current = await context.session.openChild(current.cap, segment);
		} catch (error) {
			throw nativeFailure(`${label} could not be opened`, error);
		}
	}
	return current;
}

export async function preflightNativeRepoDestination(
	context,
	relative,
	label = "generated destination",
) {
	const segments = relativeSegments(relative, label);
	let current = context.root;
	for (const [index, segment] of segments.entries()) {
		let child;
		try {
			child = await context.session.openChild(current.cap, segment);
		} catch (error) {
			if (error?.code === "not-found") return;
			throw nativeFailure(`${label} could not be inspected`, error);
		}
		const final = index === segments.length - 1;
		if (!final && child.observation.identity.kind !== "directory") {
			throw new Error(`${label} contains an unsafe non-directory parent ${JSON.stringify(segment)}`);
		}
		if (final && child.observation.identity.kind !== "file") {
			throw new Error(`${label} is occupied by an unsafe non-file object`);
		}
		current = child;
	}
}

export async function openOrCreateNativeRepoDirectory(
	context,
	relative,
	{ mode = 0o755, label = "generated directory" } = {},
) {
	const segments = relativeSegments(relative, label);
	let current = context.root;
	for (const segment of segments) {
		try {
			current = await context.session.openChild(current.cap, segment);
		} catch (error) {
			if (error?.code !== "not-found") throw nativeFailure(`${label} could not be opened`, error);
			try {
				current = await context.session.createDirectory(current.cap, segment, mode);
			} catch (createError) {
				throw nativeFailure(`${label} could not be created`, createError);
			}
		}
		if (current.observation.identity.kind !== "directory") {
			throw new Error(`${label} contains an unsafe non-directory segment ${JSON.stringify(segment)}`);
		}
	}
	return current;
}

export async function verifyNativeRepoDirectory(context, relative, expected, label) {
	let rebound;
	try {
		rebound = await context.session.openRoot(context.rootPath);
		if (!sameNativeIdentity(rebound.observation.identity, context.root.observation.identity)) {
			throw new Error("repository root changed during native publication");
		}
		for (const segment of relativeSegments(relative, label)) {
			rebound = await context.session.openChild(rebound.cap, segment);
		}
		if (!sameNativeIdentity(rebound.observation.identity, expected)) {
			throw new Error(`${label} changed during native publication`);
		}
		return rebound;
	} catch (error) {
		if (!("mutation" in error)) error.mutation = "committed";
		throw nativeFailure(`${label} postflight failed`, error);
	}
}

export async function readNativeFile(context, file, maximum = 16 * 1024 * 1024) {
	if (file.observation.identity.kind !== "file") {
		throw new Error("native read capability is not a regular file");
	}
	const size = Number(file.observation.size);
	if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
		throw new Error(`native file is oversized (maximum ${maximum} bytes)`);
	}
	const readPass = async () => {
		const chunks = [];
		let offset = 0;
		while (offset < size) {
			const response = await context.session.read(
				file.cap,
				offset,
				Math.min(MAX_NATIVE_CHUNK, size - offset),
			);
			const bytes = Buffer.from(response.data, "base64");
			if (bytes.length === 0 && !response.eof) throw new Error("native file read made no progress");
			chunks.push(bytes);
			offset += bytes.length;
			if (response.eof) break;
		}
		if (offset !== size) throw new Error("native file changed size while it was read");
		return Buffer.concat(chunks);
	};
	const first = await readPass();
	const second = await readPass();
	const after = await context.session.stat(file.cap);
	if (
		!first.equals(second) ||
		!sameNativeIdentity(file.observation.identity, after.observation.identity) ||
		after.observation.size !== file.observation.size
	) {
		throw new Error("native file changed while it was read");
	}
	return second;
}

export async function readOptionalNativeRepoFile(
	context,
	relative,
	{ label = "repository file", maximum = 16 * 1024 * 1024 } = {},
) {
	resolveRepoPath(context.rootPath, relative, label);
	const parentRelative = path.posix.dirname(relative);
	let parent;
	try {
		parent = await openNativeRepoPath(context, parentRelative, `${label} parent`);
	} catch (error) {
		if (error?.code === "not-found") return null;
		throw error;
	}
	let file;
	try {
		file = await context.session.openChild(parent.cap, path.posix.basename(relative));
	} catch (error) {
		if (error?.code === "not-found") return null;
		throw nativeFailure(`${label} could not be opened`, error);
	}
	return { parent, file, bytes: await readNativeFile(context, file, maximum) };
}

export async function writeNativeFileContent(context, file, content) {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
	const identity = file.observation.identity;
	let offset = 0;
	while (offset < bytes.length) {
		const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + MAX_NATIVE_CHUNK));
		const result = await context.session.write(file.cap, offset, chunk, identity);
		if (result.written < 1) throw new Error("native file write made no progress");
		offset += result.written;
	}
	await context.session.truncate(file.cap, bytes.length, identity);
	await context.session.flush(file.cap, "all", identity);
}

/**
 * Publish one file through a held directory capability. The destination is
 * identity-bound when present and no-replace when absent; the parent is
 * durably flushed before the helper returns.
 */
export async function publishNativeRepoFile(context, relative, content, options = {}) {
	const {
		mode = 0o644,
		tempPrefix = ".stdd-generated-",
		directoryMode = 0o755,
		expectedTarget,
		expectedBytes,
	} = options;
	const targetWasInspected = Object.hasOwn(options, "expectedTarget");
	const targetBytesWereInspected = Object.hasOwn(options, "expectedBytes");
	resolveRepoPath(context.rootPath, relative, `generated path ${JSON.stringify(relative)}`);
	const parentRelative = path.posix.dirname(relative);
	const targetName = path.posix.basename(relative);
	const parent = await openOrCreateNativeRepoDirectory(context, parentRelative, {
		mode: directoryMode,
		label: `generated parent for ${JSON.stringify(relative)}`,
	});
	let target = null;
	try {
		target = await context.session.openChild(parent.cap, targetName);
	} catch (error) {
		if (error?.code !== "not-found") throw nativeFailure(`generated target ${relative}`, error);
	}
	if (
		targetWasInspected &&
		((expectedTarget === null && target !== null) ||
			(expectedTarget !== null &&
				(target === null || !sameNativeIdentity(target.observation.identity, expectedTarget))))
	) {
		const error = new Error(`generated target ${relative} changed after it was inspected`);
		error.code = "identity-conflict";
		error.mutation = "none";
		throw nativeFailure(`generated target ${relative}`, error);
	}
	let temporary = null;
	for (let attempt = 0; attempt < 16 && temporary === null; attempt += 1) {
		const name = `${tempPrefix}${randomNativeBasename()}.tmp`;
		try {
			temporary = {
				name,
				file: await context.session.createFile(parent.cap, name, mode),
			};
		} catch (error) {
			if (error?.code !== "identity-conflict") {
				const retained =
					error?.mutation === "possible" || error?.mutation === "committed"
						? `; inactive temporary ${parentRelative}/${name} may have been retained for manual inspection`
						: "";
				throw nativeFailure(`generated temporary for ${relative}${retained}`, error);
			}
		}
	}
	if (!temporary) throw new Error(`generated temporary name exhausted for ${relative}`);
	try {
		await writeNativeFileContent(context, temporary.file, content);
	} catch (error) {
		throw nativeFailure(
			`generated temporary ${parentRelative}/${temporary.name} was retained for manual inspection`,
			error,
		);
	}
	try {
		if (targetBytesWereInspected && target) {
			const currentBytes = await readNativeFile(context, target);
			if (!currentBytes.equals(Buffer.from(expectedBytes))) {
				const conflict = new Error(
					`generated target ${relative} content changed after it was inspected`,
				);
				conflict.code = "identity-conflict";
				conflict.mutation = "none";
				throw conflict;
			}
		}
		await context.session.rename({
			fromParent: parent.cap,
			from: temporary.name,
			expected: temporary.file.observation.identity,
			toParent: parent.cap,
			to: targetName,
			replace: target ? "expected" : "never",
			...(target ? { expectedTarget: target.observation.identity } : {}),
		});
		await context.session.flush(parent.cap, "namespace", parent.observation.identity);
		await verifyNativeRepoDirectory(
			context,
			parentRelative,
			parent.observation.identity,
			`generated parent for ${JSON.stringify(relative)}`,
		);
	} catch (error) {
		throw nativeFailure(`generated publication for ${relative}`, error);
	}
	try {
		const published = await context.session.openChild(parent.cap, targetName);
		if (!sameNativeIdentity(published.observation.identity, temporary.file.observation.identity)) {
			const error = new Error(
				`generated path ${JSON.stringify(relative)} changed during native publication`,
			);
			error.mutation = "committed";
			throw error;
		}
		return published;
	} catch (error) {
		if (error?.mutation !== "committed") error.mutation = "committed";
		throw nativeFailure(`generated publication for ${relative} postflight failed`, error);
	}
}

export async function retireNativeRepoFile(context, relative, content) {
	resolveRepoPath(context.rootPath, relative, `retired path ${JSON.stringify(relative)}`);
	const sourceParentRelative = path.posix.dirname(relative);
	const sourceParent = await openNativeRepoPath(
		context,
		sourceParentRelative,
		`retired parent for ${relative}`,
	);
	const source = await context.session.openChild(sourceParent.cap, path.posix.basename(relative));
	const observed = await readNativeFile(context, source);
	const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
	if (!observed.equals(expected)) throw new Error(`${relative} changed before retained retirement`);
	if (
		source.observation.owner !== context.root.observation.owner ||
		source.observation.linkCount !== "1"
	) {
		throw new Error(`${relative} must be repository-owned and single-linked before retirement`);
	}
	const container = `.stdd-cleanup-${randomNativeBasename()}.tmp`;
	const quarantineParentRelative = `.stdd/generated-quarantines/${container}`;
	const quarantineParent = await openOrCreateNativeRepoDirectory(context, quarantineParentRelative, {
		mode: 0o700,
		label: `retained quarantine for ${relative}`,
	});
	if (
		quarantineParent.observation.identity.platform !== "win32" &&
		(Number(quarantineParent.observation.permissions) & 0o777) !== 0o700
	) {
		throw new Error(`retained quarantine for ${relative} must be owner-private mode 0700`);
	}
	if (quarantineParent.observation.owner !== context.root.observation.owner) {
		throw new Error(`retained quarantine for ${relative} must be owned by the repository owner`);
	}
	await context.session.rename({
		fromParent: sourceParent.cap,
		from: path.posix.basename(relative),
		expected: source.observation.identity,
		toParent: quarantineParent.cap,
		to: path.posix.basename(relative),
		replace: "never",
	});
	for (const directory of [sourceParent, quarantineParent]) {
		await context.session.flush(directory.cap, "namespace", directory.observation.identity);
	}
	await verifyNativeRepoDirectory(
		context,
		sourceParentRelative,
		sourceParent.observation.identity,
		`retired source parent for ${relative}`,
	);
	await verifyNativeRepoDirectory(
		context,
		quarantineParentRelative,
		quarantineParent.observation.identity,
		`retained quarantine for ${relative}`,
	);
	return {
		relative: `${quarantineParentRelative}/${path.posix.basename(relative)}`,
		observation: source.observation,
		bytes: observed,
	};
}

function randomNativeBasename() {
	return randomBytes(16).toString("hex");
}

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
