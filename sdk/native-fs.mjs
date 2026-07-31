import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_FS_PROTOCOL_VERSION = 1;

const IDENTITY_VERSION = 2;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_LINK_TARGET_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 1024;
const DEFAULT_LIST_ENTRIES = 256;
const DEFAULT_TIMEOUT_MS = 2_000;
const SHUTDOWN_GRACE_MS = 250;
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);
const PLATFORM_STRATEGIES = Object.freeze({
	linux: Object.freeze({
		artifactName: "stdd-fs",
		executable: (artifact) => `/proc/${process.pid}/fd/${artifact.handle.fd}`,
		environment: () => ({}),
	}),
	darwin: Object.freeze({
		artifactName: "stdd-fs",
		executable: (artifact) => artifact.path,
		environment: () => ({}),
	}),
	win32: Object.freeze({
		artifactName: "stdd-fs.exe",
		executable: (artifact) => artifact.path,
		environment: () => {
			const environment = {};
			if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
			return environment;
		},
	}),
});
const SUPPORTED_TARGETS = new Set(
	Object.keys(PLATFORM_STRATEGIES).flatMap((platform) =>
		[...SUPPORTED_ARCHITECTURES].map((architecture) => `${platform}-${architecture}`),
	),
);
const DIRECTORY_CREATION_MODES = new Set([0o700, 0o755]);
const FILE_CREATION_MODES = new Set([0o600, 0o644, 0o755]);
const MUTATING_OPERATIONS = new Set([
	"create-directory",
	"create-file",
	"write",
	"truncate",
	"flush",
	"rename",
	"symlink",
]);
const ERROR_FIELDS = ["class", "code", "mutation", "operation", "osCode", "retryable"];
const IDENTITY_FIELDS = ["version", "platform", "volume", "fileId", "kind"];
const OBSERVATION_FIELDS = [
	"identity",
	"owner",
	"permissions",
	"linkCount",
	"size",
	"modifiedNs",
	"changedNs",
];
const PRIMITIVE_FIELDS = [
	"identity",
	"noFollow",
	"atomicRename",
	"noReplace",
	"fileFlush",
	"directoryFlush",
];
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class NativeFsError extends Error {
	constructor(message, fields) {
		super(message);
		this.name = "NativeFsError";
		for (const key of ERROR_FIELDS) this[key] = fields[key];
	}
}

function localError(
	code,
	operation,
	mutation = "none",
	errorClass = "transport",
	retryable = false,
	detail = "",
) {
	return new NativeFsError(`${operation}: ${code}${detail ? ` (${detail})` : ""}`, {
		code,
		class: errorClass,
		operation,
		osCode: null,
		mutation,
		retryable,
	});
}

function exactKeys(value, expected) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function safeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function printable(value) {
	if (typeof value !== "string" || value.trim() === "") return false;
	for (const character of value) {
		const code = character.codePointAt(0);
		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x00ad ||
			code === 0x034f ||
			code === 0x061c ||
			code === 0x180e ||
			code === 0x200b ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2060 && code <= 0x206f) ||
			code === 0xfeff ||
			(code >= 0xfff9 && code <= 0xfffb) ||
			(code >= 0x1bca0 && code <= 0x1bcaf) ||
			(code >= 0x1d173 && code <= 0x1d17a) ||
			code === 0xe0001
		) {
			return false;
		}
	}
	return true;
}

function decimalString(value) {
	return (
		typeof value === "string" &&
		value.length <= 20 &&
		/^(?:0|[1-9][0-9]*)$/.test(value) &&
		BigInt(value) <= U64_MAX
	);
}

function signedDecimalString(value) {
	if (
		typeof value !== "string" ||
		value === "-0" ||
		value.length > 40 ||
		!/^-?(?:0|[1-9][0-9]*)$/.test(value)
	) {
		return false;
	}
	const parsed = BigInt(value);
	return parsed >= I128_MIN && parsed <= I128_MAX;
}

function listCursor(value) {
	return decimalString(value) && BigInt(value) <= I64_MAX;
}

function fileIdString(value, platform) {
	return platform === "win32"
		? typeof value === "string" && /^[0-9a-f]{32}$/.test(value)
		: decimalString(value);
}

function windowsSecurityString(value, kind) {
	return (
		printable(value) &&
		Buffer.byteLength(value) <= 4096 &&
		(kind === "owner"
			? /^S-(?:[0-9]+-)+[0-9]+$/.test(value)
			: value.startsWith("O:") && value.includes("D:P"))
	);
}

function basename(value) {
	return (
		printable(value) &&
		Buffer.byteLength(value) <= 255 &&
		value !== "." &&
		value !== ".." &&
		!value.includes("/") &&
		!value.includes("\\")
	);
}

function assertTarget(target) {
	if (!SUPPORTED_TARGETS.has(target)) {
		throw new Error(`unsupported native filesystem target: ${target}`);
	}
}

function targetParts(target) {
	assertTarget(target);
	const separator = target.lastIndexOf("-");
	return {
		platform: target.slice(0, separator),
		architecture: target.slice(separator + 1),
	};
}

export function nativeFsTarget(platform = process.platform, architecture = process.arch) {
	if (!Object.hasOwn(PLATFORM_STRATEGIES, platform) || !SUPPORTED_ARCHITECTURES.has(architecture)) {
		throw new Error(`unsupported native filesystem target: ${platform}-${architecture}`);
	}
	return `${platform}-${architecture}`;
}

async function readBoundedFile(filePath, maximum, subject) {
	const observed = await fs.promises.lstat(filePath, { bigint: true });
	if (!observed.isFile() || observed.isSymbolicLink()) {
		throw new Error(`${subject} must be a regular non-symlink file`);
	}
	if (observed.size > BigInt(maximum)) throw new Error(`${subject} is oversized`);
	const handle = await fs.promises.open(
		filePath,
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			!opened.isFile() ||
			opened.isSymbolicLink() ||
			opened.dev !== observed.dev ||
			opened.ino !== observed.ino ||
			opened.size !== observed.size ||
			opened.size > BigInt(maximum)
		) {
			throw new Error(`${subject} changed while opening`);
		}
		const bytes = await handle.readFile();
		if (bytes.length > maximum) throw new Error(`${subject} is oversized`);
		const after = await handle.stat({ bigint: true });
		const finalPath = await fs.promises.lstat(filePath, { bigint: true });
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size ||
			finalPath.isSymbolicLink() ||
			!finalPath.isFile() ||
			finalPath.dev !== opened.dev ||
			finalPath.ino !== opened.ino ||
			finalPath.size !== opened.size
		) {
			throw new Error(`${subject} changed while reading`);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

function expectedArtifactPath(target) {
	const { platform } = targetParts(target);
	return `${target}/${PLATFORM_STRATEGIES[platform].artifactName}`;
}

function parseManifest(bytes, target) {
	let manifest;
	try {
		manifest = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("native filesystem artifact manifest is not valid JSON");
	}
	if (!exactKeys(manifest, ["artifacts", "schema"])) {
		throw new Error("native filesystem artifact manifest has an invalid shape");
	}
	if (manifest.schema !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 6) {
		throw new Error("native filesystem artifact manifest is incompatible");
	}
	const seen = new Set();
	for (const artifact of manifest.artifacts) {
		if (!exactKeys(artifact, ["path", "protocol", "sha256", "size", "target"])) {
			throw new Error("native filesystem artifact manifest has an invalid entry");
		}
		assertTarget(artifact.target);
		if (seen.has(artifact.target)) {
			throw new Error("native filesystem artifact manifest has duplicate targets");
		}
		seen.add(artifact.target);
		if (
			artifact.protocol !== NATIVE_FS_PROTOCOL_VERSION ||
			artifact.path !== expectedArtifactPath(artifact.target) ||
			!safeInteger(artifact.size) ||
			artifact.size < 1 ||
			!/^sha256:[0-9a-f]{64}$/.test(artifact.sha256)
		) {
			throw new Error(`native filesystem artifact manifest has an invalid ${artifact.target} entry`);
		}
	}
	const artifact = manifest.artifacts.find((entry) => entry.target === target);
	if (!artifact) {
		throw new Error(`native filesystem artifact manifest has no exact ${target} entry`);
	}
	return artifact;
}

async function assertArtifactPathIdentity(artifact) {
	const opened = await artifact.handle.stat({ bigint: true });
	const installed = await fs.promises.lstat(artifact.path, { bigint: true });
	if (
		!opened.isFile() ||
		opened.isSymbolicLink() ||
		!installed.isFile() ||
		installed.isSymbolicLink() ||
		opened.dev !== artifact.dev ||
		opened.ino !== artifact.ino ||
		opened.size !== BigInt(artifact.size) ||
		installed.dev !== opened.dev ||
		installed.ino !== opened.ino ||
		installed.size !== opened.size ||
		opened.mode !== artifact.mode ||
		installed.mode !== opened.mode ||
		(Number(installed.mode) & 0o111) === 0
	) {
		throw new Error("native filesystem artifact changed after verification");
	}
}

async function inspectArtifact(packageRoot, target, keepOpen) {
	if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) {
		throw new Error("native filesystem package root must be absolute");
	}
	assertTarget(target);
	const manifestPath = path.join(packageRoot, "prebuilds", "stdd-fs", "manifest.json");
	const manifestBytes = await readBoundedFile(
		manifestPath,
		MAX_MANIFEST_BYTES,
		"native filesystem artifact manifest",
	);
	const artifact = parseManifest(manifestBytes, target);
	const artifactPath = path.join(packageRoot, "prebuilds", "stdd-fs", ...artifact.path.split("/"));
	const observed = await fs.promises.lstat(artifactPath, { bigint: true });
	if (!observed.isFile() || observed.isSymbolicLink()) {
		throw new Error("native filesystem artifact must be a regular non-symlink file");
	}
	if (observed.size !== BigInt(artifact.size)) {
		throw new Error("native filesystem artifact size does not match its manifest");
	}
	if ((Number(observed.mode) & 0o111) === 0) {
		throw new Error("native filesystem artifact is not executable");
	}
	const handle = await fs.promises.open(
		artifactPath,
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			!opened.isFile() ||
			opened.isSymbolicLink() ||
			opened.dev !== observed.dev ||
			opened.ino !== observed.ino ||
			opened.size !== observed.size
		) {
			throw new Error("native filesystem artifact changed while opening");
		}
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(64 * 1024);
		let offset = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}
		const digest = `sha256:${hash.digest("hex")}`;
		const result = {
			target,
			path: artifactPath,
			size: artifact.size,
			sha256: artifact.sha256,
			handle,
			dev: opened.dev,
			ino: opened.ino,
			mode: opened.mode,
		};
		await assertArtifactPathIdentity(result);
		if (digest !== artifact.sha256 || offset !== artifact.size) {
			throw new Error("native filesystem artifact hash does not match its manifest");
		}
		if (!keepOpen) {
			await handle.close();
			result.handle = null;
		}
		return result;
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

export async function verifyNativeFsArtifact(packageRoot, target) {
	const inspected = await inspectArtifact(packageRoot, target, false);
	return Object.freeze({
		target: inspected.target,
		path: inspected.path,
		size: inspected.size,
		sha256: inspected.sha256,
	});
}

function validateIdentity(identity, platform, operation) {
	if (
		!exactKeys(identity, IDENTITY_FIELDS) ||
		identity.version !== IDENTITY_VERSION ||
		identity.platform !== platform ||
		!decimalString(identity.volume) ||
		!fileIdString(identity.fileId, platform) ||
		!["directory", "file", "symlink", "other"].includes(identity.kind)
	) {
		throw localError("malformed-response", operation);
	}
	return identity;
}

function validateObservation(observation, platform, operation) {
	if (!exactKeys(observation, OBSERVATION_FIELDS)) {
		throw localError("malformed-response", operation);
	}
	validateIdentity(observation.identity, platform, operation);
	if (
		platform === "win32"
			? !windowsSecurityString(observation.owner, "owner") ||
				!windowsSecurityString(observation.permissions, "permissions")
			: !decimalString(observation.owner) || !decimalString(observation.permissions)
	) {
		throw localError("malformed-response", operation);
	}
	for (const field of ["linkCount", "size"]) {
		if (!decimalString(observation[field])) throw localError("malformed-response", operation);
	}
	for (const field of ["modifiedNs", "changedNs"]) {
		if (!signedDecimalString(observation[field])) {
			throw localError("malformed-response", operation);
		}
	}
	return observation;
}

function validateCapabilityResult(result, platform, operation) {
	if (!exactKeys(result, ["cap", "observation"]) || !/^c[1-9][0-9]{0,19}$/.test(result.cap)) {
		throw localError("malformed-response", operation);
	}
	validateObservation(result.observation, platform, operation);
	return result;
}

function sameIdentity(left, right) {
	return (
		exactKeys(left, IDENTITY_FIELDS) &&
		exactKeys(right, IDENTITY_FIELDS) &&
		IDENTITY_FIELDS.every((field) => left[field] === right[field])
	);
}

function decodeBase64(value, operation, code = "invalid-base64", errorClass = "invalid-request") {
	if (
		typeof value !== "string" ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw localError(code, operation, "none", errorClass);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) {
		throw localError(code, operation, "none", errorClass);
	}
	return decoded;
}

function validateSuccessResult(result, pending) {
	const { operation, fields, platform } = pending;
	if (result === null || typeof result !== "object" || Array.isArray(result)) {
		throw localError("malformed-response", operation);
	}
	switch (operation) {
		case "hello":
			if (
				!exactKeys(result, ["helper", "maxChunkBytes", "maxLineBytes", "protocol"]) ||
				result.protocol !== NATIVE_FS_PROTOCOL_VERSION ||
				result.helper !== "stdd-fs" ||
				result.maxLineBytes !== MAX_LINE_BYTES ||
				result.maxChunkBytes !== MAX_CHUNK_BYTES
			) {
				throw localError("protocol-mismatch", "hello");
			}
			return result;
		case "probe":
			if (
				!exactKeys(result, ["filesystem", "filesystemId", "platform", "primitives"]) ||
				result.platform !== platform ||
				!printable(result.filesystem) ||
				Buffer.byteLength(result.filesystem) > 64 ||
				!printable(result.filesystemId) ||
				Buffer.byteLength(result.filesystemId) > 64 ||
				!exactKeys(result.primitives, PRIMITIVE_FIELDS) ||
				!PRIMITIVE_FIELDS.every(
					(field) =>
						printable(result.primitives[field]) && Buffer.byteLength(result.primitives[field]) <= 128,
				)
			) {
				throw localError("malformed-response", operation);
			}
			return result;
		case "open-root":
		case "create-directory": {
			const validated = validateCapabilityResult(result, platform, operation);
			if (validated.observation.identity.kind !== "directory") {
				throw localError("malformed-response", operation);
			}
			return validated;
		}
		case "create-file": {
			const validated = validateCapabilityResult(result, platform, operation);
			if (validated.observation.identity.kind !== "file") {
				throw localError("malformed-response", operation);
			}
			return validated;
		}
		case "open-child": {
			const validated = validateCapabilityResult(result, platform, operation);
			if (!["directory", "file"].includes(validated.observation.identity.kind)) {
				throw localError("malformed-response", operation);
			}
			return validated;
		}
		case "stat":
			if (!exactKeys(result, ["observation"])) {
				throw localError("malformed-response", operation);
			}
			validateObservation(result.observation, platform, operation);
			return result;
		case "rename":
			if (!exactKeys(result, ["observation"])) {
				throw localError("malformed-response", operation);
			}
			validateObservation(result.observation, platform, operation);
			if (!sameIdentity(result.observation.identity, fields.expected)) {
				throw localError("malformed-response", operation);
			}
			return result;
		case "symlink":
			if (!exactKeys(result, ["observation"])) {
				throw localError("malformed-response", operation);
			}
			validateObservation(result.observation, platform, operation);
			if (result.observation.identity.kind !== "symlink") {
				throw localError("malformed-response", operation);
			}
			return result;
		case "list": {
			if (
				!exactKeys(result, ["cursor", "entries"]) ||
				!Array.isArray(result.entries) ||
				result.entries.length > fields.limit ||
				!(result.cursor === null || listCursor(result.cursor))
			) {
				throw localError("malformed-response", operation);
			}
			const names = new Set();
			for (const entry of result.entries) {
				if (!exactKeys(entry, ["name", "observation"]) || names.has(entry.name)) {
					throw localError("malformed-response", operation);
				}
				if (!basename(entry.name)) {
					const escaped =
						typeof entry.name === "string" ? JSON.stringify(entry.name) : "non-string name";
					throw localError(
						"malformed-response",
						operation,
						"none",
						"transport",
						false,
						`unsafe listed name ${escaped}`,
					);
				}
				validateObservation(entry.observation, platform, operation);
				names.add(entry.name);
			}
			return result;
		}
		case "read": {
			if (!exactKeys(result, ["data", "eof"]) || typeof result.eof !== "boolean") {
				throw localError("malformed-response", operation);
			}
			const decoded = decodeBase64(result.data, operation, "malformed-response", "transport");
			if (decoded.length > fields.length || decoded.length > MAX_CHUNK_BYTES) {
				throw localError("malformed-response", operation);
			}
			return result;
		}
		case "read-link": {
			if (!exactKeys(result, ["data"])) {
				throw localError("malformed-response", operation);
			}
			const decoded = decodeBase64(result.data, operation, "malformed-response", "transport");
			if (decoded.length > MAX_LINK_TARGET_BYTES) {
				throw localError("malformed-response", operation);
			}
			return result;
		}
		case "write":
			if (
				!exactKeys(result, ["written"]) ||
				!safeInteger(result.written) ||
				result.written > decodeBase64(fields.data, operation).length
			) {
				throw localError("malformed-response", operation);
			}
			return result;
		case "truncate":
		case "flush":
		case "preflight-symlink":
		case "verify-private":
		case "close":
			if (!exactKeys(result, [])) throw localError("malformed-response", operation);
			return result;
		default:
			throw localError("malformed-response", operation);
	}
}

function validateStructuredError(error, expectedOperation) {
	if (!exactKeys(error, ERROR_FIELDS)) {
		throw localError("malformed-response", expectedOperation);
	}
	if (
		!printable(error.code) ||
		!printable(error.class) ||
		!printable(error.operation) ||
		error.operation !== expectedOperation ||
		!(error.osCode === null || Number.isSafeInteger(error.osCode)) ||
		!["none", "possible", "committed"].includes(error.mutation) ||
		typeof error.retryable !== "boolean"
	) {
		throw localError("malformed-response", expectedOperation);
	}
	return new NativeFsError(`${error.operation}: ${error.code}`, error);
}

function validateResponse(response, pending) {
	if (
		response === null ||
		typeof response !== "object" ||
		Array.isArray(response) ||
		response.v !== NATIVE_FS_PROTOCOL_VERSION ||
		response.id !== pending.id ||
		typeof response.ok !== "boolean"
	) {
		throw localError("malformed-response", pending.operation);
	}
	if (response.ok) {
		if (!exactKeys(response, ["id", "ok", "result", "v"])) {
			throw localError("malformed-response", pending.operation);
		}
		return validateSuccessResult(response.result, pending);
	}
	if (!exactKeys(response, ["error", "id", "ok", "v"])) {
		throw localError("malformed-response", pending.operation);
	}
	throw validateStructuredError(response.error, pending.operation);
}

function requestBounds(operation, fields, platform) {
	if (operation === "create-directory" || operation === "create-file") {
		if (!exactKeys(fields, ["parent", "name", "mode", "expected"])) {
			throw localError("invalid-fields", operation, "none", "invalid-request");
		}
		const allowed = operation === "create-directory" ? DIRECTORY_CREATION_MODES : FILE_CREATION_MODES;
		if (!Number.isInteger(fields.mode) || !allowed.has(fields.mode)) {
			throw localError("invalid-mode", operation, "none", "invalid-request");
		}
		if (fields.expected !== null) {
			throw localError("null-required", operation, "none", "invalid-request");
		}
	}
	for (const field of ["offset", "length", "size", "limit"]) {
		if (field in fields && !safeInteger(fields[field])) {
			throw localError(`invalid-${field}`, operation, "none", "invalid-request");
		}
	}
	if (operation === "read" && fields.length > MAX_CHUNK_BYTES) {
		throw localError("chunk-too-large", operation, "none", "invalid-request");
	}
	if (operation === "read-link") {
		if (!exactKeys(fields, ["parent", "name", "expected"])) {
			throw localError("invalid-fields", operation, "none", "invalid-request");
		}
		validCapability(fields.parent, operation);
		if (!basename(fields.name)) {
			throw localError("invalid-basename", operation, "none", "invalid-request");
		}
		expectedIdentity(fields.expected, platform, operation);
		if (fields.expected.kind !== "symlink") {
			throw localError("symlink-identity-required", operation, "none", "invalid-request");
		}
	}
	if (operation === "write") {
		const decoded = decodeBase64(fields.data, operation);
		if (decoded.length > MAX_CHUNK_BYTES) {
			throw localError("chunk-too-large", operation, "none", "invalid-request");
		}
	}
}

function plainFields(fields, operation) {
	if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
		throw localError("invalid-request", operation, "none", "invalid-request");
	}
	const snapshot = {};
	for (const key of Object.keys(fields)) {
		const descriptor = Object.getOwnPropertyDescriptor(fields, key);
		if (!descriptor || !("value" in descriptor)) {
			throw localError("invalid-request", operation, "none", "invalid-request");
		}
		snapshot[key] = descriptor.value;
	}
	return snapshot;
}

function validCapability(cap, operation) {
	if (typeof cap !== "string" || !/^c[1-9][0-9]{0,19}$/.test(cap)) {
		throw localError("invalid-capability", operation, "none", "invalid-request");
	}
	return cap;
}

function expectedIdentity(identity, platform, operation) {
	if (!exactKeys(identity, IDENTITY_FIELDS) || identity.version !== IDENTITY_VERSION) {
		throw localError("invalid-identity", operation, "none", "invalid-request");
	}
	if (identity.platform !== platform) {
		throw localError("foreign-identity", operation, "none", "invalid-request");
	}
	if (
		!decimalString(identity.volume) ||
		!fileIdString(identity.fileId, platform) ||
		!["directory", "file", "symlink", "other"].includes(identity.kind)
	) {
		throw localError("invalid-identity", operation, "none", "invalid-request");
	}
	return identity;
}

class NativeFsSession {
	constructor(child, artifact, timeoutMs, platform) {
		this.child = child;
		this.artifact = artifact;
		this.timeoutMs = timeoutMs;
		this.platform = platform;
		this.nextId = 1;
		this.pending = null;
		this.buffer = Buffer.alloc(0);
		this.closed = false;
		this.failure = null;
		this.queue = Promise.resolve();
		this.stderrBytes = 0;
		this.shutdownPromise = null;
		child.stdout.on("data", (chunk) => this.onData(chunk));
		child.stderr.on("data", (chunk) => {
			this.stderrBytes += chunk.length;
			if (this.stderrBytes > MAX_LINE_BYTES) this.failTransport("helper-stderr-too-large");
		});
		child.stdout.on("end", () => this.failTransport("unexpected-eof"));
		child.on("error", () => this.failTransport("helper-spawn-failed"));
		child.on("exit", () => this.failTransport("helper-exit"));
		child.stdin.on("error", () => this.failTransport("unexpected-eof"));
	}

	onData(chunk) {
		if (this.failure) return;
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes(0x0a)) {
			this.failTransport("line-too-large");
			return;
		}
		for (;;) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline === -1) break;
			const line = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);
			if (line.length > MAX_LINE_BYTES) {
				this.failTransport("line-too-large");
				return;
			}
			if (!this.pending) {
				this.failTransport("out-of-order-response");
				return;
			}
			let response;
			try {
				response = JSON.parse(line.toString("utf8"));
				const result = validateResponse(response, this.pending);
				const pending = this.pending;
				this.pending = null;
				clearTimeout(pending.timer);
				pending.resolve(result);
			} catch (error) {
				const pending = this.pending;
				this.pending = null;
				const structured =
					error instanceof NativeFsError
						? error
						: localError("malformed-response", pending?.operation ?? "transport");
				if (pending) {
					clearTimeout(pending.timer);
					pending.reject(structured);
				}
				if (!(error instanceof NativeFsError) || error.class === "transport") {
					this.failTransport("malformed-response");
				}
			}
		}
	}

	failTransport(code) {
		if (this.closed || this.failure) return;
		const pending = this.pending;
		const operation = pending?.operation ?? "transport";
		const mutation = pending?.mutating && pending.issued ? "possible" : "none";
		const error = localError(code, operation, mutation);
		this.failure = error;
		this.pending = null;
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		void this.shutdown();
	}

	request(operation, fields = {}) {
		let snapshot;
		try {
			if (!printable(operation)) {
				throw localError("invalid-request", String(operation), "none", "invalid-request");
			}
			snapshot = plainFields(fields, operation);
			if ("v" in snapshot || "id" in snapshot || "op" in snapshot) {
				throw localError("reserved-field", operation, "none", "invalid-request");
			}
			requestBounds(operation, snapshot, this.platform);
		} catch (error) {
			return Promise.reject(error);
		}
		const run = () => this.requestNow(operation, snapshot);
		const result = this.queue.then(run);
		this.queue = result.catch(() => {});
		return result;
	}

	requestNow(operation, fields) {
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed) return Promise.reject(localError("session-closed", operation));
		const id = String(this.nextId++);
		const envelope = { v: NATIVE_FS_PROTOCOL_VERSION, id, op: operation, ...fields };
		const line = `${JSON.stringify(envelope)}\n`;
		if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
			return Promise.reject(localError("line-too-large", operation, "none", "invalid-request"));
		}
		return new Promise((resolve, reject) => {
			const pending = {
				id,
				operation,
				fields,
				platform: this.platform,
				mutating: MUTATING_OPERATIONS.has(operation),
				issued: false,
				resolve,
				reject,
				timer: null,
			};
			pending.timer = setTimeout(() => {
				if (this.pending !== pending) return;
				this.pending = null;
				const mutation = pending.mutating && pending.issued ? "possible" : "none";
				const error = localError("timeout", operation, mutation, "timeout", true);
				this.failure = error;
				reject(error);
				void this.shutdown();
			}, this.timeoutMs);
			this.pending = pending;
			pending.issued = true;
			this.child.stdin.write(line, (error) => {
				if (error && this.pending === pending) this.failTransport("unexpected-eof");
			});
		});
	}

	async probe(root) {
		return this.request("probe", { root: validCapability(root, "probe") });
	}

	async preflightSymlink(root) {
		return this.request("preflight-symlink", {
			root: validCapability(root, "preflight-symlink"),
		});
	}

	async verifyPrivate(cap) {
		return this.request("verify-private", {
			cap: validCapability(cap, "verify-private"),
		});
	}

	async openRoot(rootPath) {
		if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
			return Promise.reject(
				localError("absolute-path-required", "open-root", "none", "invalid-request"),
			);
		}
		return this.request("open-root", { path: rootPath });
	}

	async openChild(parent, name) {
		return this.request("open-child", {
			parent: validCapability(parent, "open-child"),
			name,
		});
	}

	async createDirectory(parent, name, mode) {
		return this.request("create-directory", {
			parent: validCapability(parent, "create-directory"),
			name,
			mode,
			expected: null,
		});
	}

	async createFile(parent, name, mode) {
		return this.request("create-file", {
			parent: validCapability(parent, "create-file"),
			name,
			mode,
			expected: null,
		});
	}

	async stat(capOrParent, name) {
		if (name === undefined) {
			return this.request("stat", { cap: validCapability(capOrParent, "stat") });
		}
		return this.request("stat", {
			parent: validCapability(capOrParent, "stat"),
			name,
		});
	}

	async list(cap, options = {}) {
		const { cursor = null, limit = DEFAULT_LIST_ENTRIES } = options;
		if (
			!(cursor === null || listCursor(cursor)) ||
			!safeInteger(limit) ||
			limit < 1 ||
			limit > MAX_LIST_ENTRIES
		) {
			return Promise.reject(localError("invalid-list-options", "list", "none", "invalid-request"));
		}
		return this.request("list", { cap: validCapability(cap, "list"), cursor, limit });
	}

	async read(cap, offset, length) {
		return this.request("read", { cap: validCapability(cap, "read"), offset, length });
	}

	async readLink(parent, name, expected) {
		return this.request("read-link", {
			parent: validCapability(parent, "read-link"),
			name,
			expected,
		});
	}

	async write(cap, offset, data, expected) {
		const encoded =
			Buffer.isBuffer(data) || data instanceof Uint8Array ? Buffer.from(data).toString("base64") : data;
		expectedIdentity(expected, this.platform, "write");
		return this.request("write", {
			cap: validCapability(cap, "write"),
			offset,
			data: encoded,
			expected,
		});
	}

	async truncate(cap, size, expected) {
		expectedIdentity(expected, this.platform, "truncate");
		return this.request("truncate", {
			cap: validCapability(cap, "truncate"),
			size,
			expected,
		});
	}

	async flush(cap, mode, expected) {
		expectedIdentity(expected, this.platform, "flush");
		return this.request("flush", {
			cap: validCapability(cap, "flush"),
			mode,
			expected,
		});
	}

	async rename(options) {
		const operation = "rename";
		const input = plainFields(options, operation);
		if (!["never", "any", "expected"].includes(input.replace)) {
			return Promise.reject(localError("invalid-replace-mode", operation, "none", "invalid-request"));
		}
		const expectedFields =
			input.replace === "never"
				? ["fromParent", "from", "expected", "toParent", "to", "replace"]
				: ["fromParent", "from", "expected", "toParent", "to", "replace", "expectedTarget"];
		if (!exactKeys(input, expectedFields)) {
			throw localError("invalid-fields", operation, "none", "invalid-request");
		}
		expectedIdentity(input.expected, this.platform, operation);
		const fields = {
			fromParent: validCapability(input.fromParent, operation),
			from: input.from,
			expected: input.expected,
			toParent: validCapability(input.toParent, operation),
			to: input.to,
			replace: input.replace,
		};
		if (input.replace === "any") {
			if (input.expectedTarget !== null) {
				return Promise.reject(localError("null-required", operation, "none", "invalid-request"));
			}
			fields.expectedTarget = null;
		} else if (input.replace === "expected") {
			expectedIdentity(input.expectedTarget, this.platform, operation);
			fields.expectedTarget = input.expectedTarget;
		}
		return this.request(operation, fields);
	}

	async symlink(parent, name, target) {
		return this.request("symlink", {
			parent: validCapability(parent, "symlink"),
			name,
			target,
			expected: null,
		});
	}

	async closeCapability(cap) {
		return this.request("close", { cap: validCapability(cap, "close") });
	}

	shutdown() {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shutdownPromise = (async () => {
			const artifact = this.artifact;
			this.artifact = null;
			if (artifact?.handle) {
				await artifact.handle.close().catch(() => {});
				artifact.handle = null;
			}
			this.child.stdin.end();
			if (this.child.exitCode === null && this.child.signalCode === null) {
				this.child.kill("SIGTERM");
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
					this.child.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			if (this.child.exitCode === null && this.child.signalCode === null) {
				this.child.kill("SIGKILL");
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
					this.child.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
		})();
		return this.shutdownPromise;
	}

	async close() {
		if (!this.closed) {
			this.closed = true;
			const pending = this.pending;
			if (pending) {
				clearTimeout(pending.timer);
				this.pending = null;
				pending.reject(localError("session-closed", pending.operation, "none"));
			}
		}
		await this.shutdown();
	}
}

export async function openNativeFsSession(options = {}) {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		throw new TypeError("native filesystem session options must be an object");
	}
	const packageRoot = options.packageRoot ?? MODULE_ROOT;
	const target = options.target ?? nativeFsTarget();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
		throw new RangeError("native filesystem timeoutMs must be an integer from 1 to 60000");
	}
	const artifact = await inspectArtifact(packageRoot, target, true);
	const currentTarget = nativeFsTarget();
	if (target !== currentTarget) {
		await artifact.handle.close();
		throw localError("unsupported-execution-target", "hello", "none", "unsupported");
	}
	const { platform } = targetParts(target);
	const strategy = PLATFORM_STRATEGIES[platform];
	await assertArtifactPathIdentity(artifact);
	let child;
	let session;
	try {
		// The installed package tree is trusted executing code. Linux can bind
		// exec to the verified fd; Darwin and Windows use the trusted package
		// path with pre/post identity checks. Same-user live package replacement
		// remains outside the target-namespace race model.
		child = spawn(strategy.executable(artifact), [], {
			cwd: packageRoot,
			env: strategy.environment(),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		session = new NativeFsSession(child, artifact, timeoutMs, platform);
		await assertArtifactPathIdentity(artifact);
	} catch {
		if (session) await session.close();
		else await artifact.handle.close().catch(() => {});
		throw localError("helper-spawn-failed", "hello");
	}
	try {
		await session.request("hello");
		return session;
	} catch (error) {
		await session.close();
		throw error;
	}
}
