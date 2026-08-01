import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPrintableSingleLine } from "../sdk/text.mjs";
import { isLedgerStringArray, isPlainLedgerRecord, MANIFEST_HASH_PATTERN } from "./state-validation.mjs";

export const WORKER_METADATA_REL = ".stdd/worker.json";
export const WORKER_METADATA_SCHEMA = 2;
export const WORKER_METADATA_READABLE_SCHEMAS = new Set([1, WORKER_METADATA_SCHEMA]);
export const WORKER_EVIDENCE_EVENTS = new Set(["red", "verify", "note"]);
export const WORKER_LOCAL_COMMANDS = new Set([
	"red",
	"verify",
	"note",
	"status",
	"scope",
	"doctor",
	"version",
	"--version",
]);

const WORKER_ID_RANDOM_BYTES = 12;
export const WORKER_ID_PATTERN = /^worker-[0-9a-f]{24}$/u;

export function createWorkerId() {
	return `worker-${randomBytes(WORKER_ID_RANDOM_BYTES).toString("hex")}`;
}

export function findWorkerRoot(start) {
	let candidate = path.resolve(start);
	while (true) {
		if (fs.existsSync(path.join(candidate, WORKER_METADATA_REL))) return candidate;
		const parent = path.dirname(candidate);
		if (parent === candidate) return null;
		candidate = parent;
	}
}

function exactKeys(value, keys) {
	if (!isPlainLedgerRecord(value)) return false;
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validPortableIdentity(identity, kind) {
	return (
		exactKeys(identity, ["version", "platform", "volume", "fileId", "kind"]) &&
		identity.version === 2 &&
		["linux", "darwin", "win32"].includes(identity.platform) &&
		typeof identity.volume === "string" &&
		typeof identity.fileId === "string" &&
		identity.kind === kind
	);
}

function validateWorkerFileState(state, schema) {
	const portableValid =
		schema === 1 ||
		(exactKeys(state?.portable, ["source", "sandbox"]) &&
			validPortableIdentity(state.portable.source, state.type) &&
			validPortableIdentity(state.portable.sandbox, state.type));
	return (
		state === null ||
		(isPlainLedgerRecord(state) &&
			portableValid &&
			((state.type === "file" &&
				exactKeys(
					state,
					schema === 1 ? ["type", "hash", "mode"] : ["type", "hash", "mode", "portable"],
				) &&
				MANIFEST_HASH_PATTERN.test(state.hash) &&
				(schema === 1
					? Number.isInteger(state.mode) && state.mode >= 0 && state.mode <= 0o777
					: [0o600, 0o644, 0o755].includes(state.mode))) ||
				(state.type === "symlink" &&
					exactKeys(
						state,
						schema === 1
							? ["type", "target", "hash"]
							: ["type", "target", "targetBase64", "hash", "portable"],
					) &&
					typeof state.target === "string" &&
					(schema === 1 ||
						(typeof state.targetBase64 === "string" &&
							Buffer.from(state.targetBase64, "base64").toString("base64") === state.targetBase64)) &&
					MANIFEST_HASH_PATTERN.test(state.hash))))
	);
}

export function parseWorkerMetadata(metadataBytes, root, metadataPath) {
	let parsed;
	try {
		parsed = JSON.parse(metadataBytes);
	} catch (err) {
		throw new Error(`invalid managed worker metadata: ${err.message}`);
	}
	if (
		!WORKER_METADATA_READABLE_SCHEMAS.has(parsed?.schema) ||
		!WORKER_ID_PATTERN.test(parsed.workerId ?? "") ||
		!isPlainLedgerRecord(parsed.source) ||
		!isPrintableSingleLine(parsed.source.root) ||
		!isPrintableSingleLine(parsed.source.branch) ||
		!isPrintableSingleLine(parsed.source.taskId) ||
		!isPrintableSingleLine(parsed.source.taskName) ||
		!isPrintableSingleLine(parsed.source.head) ||
		!isPlainLedgerRecord(parsed.scope) ||
		!isLedgerStringArray(parsed.scope.frozenPaths) ||
		!isLedgerStringArray(parsed.scope.allowedPaths) ||
		parsed.scope.frozenPaths.length + parsed.scope.allowedPaths.length === 0 ||
		!isPlainLedgerRecord(parsed.baseline) ||
		!isPlainLedgerRecord(parsed.baseline.files) ||
		!Object.values(parsed.baseline.files).every((state) => validateWorkerFileState(state, parsed.schema))
	) {
		throw new Error("invalid managed worker metadata schema");
	}
	parsed.baseline.files = Object.assign(Object.create(null), parsed.baseline.files);
	return { ...parsed, root, metadataPath, metadataBytes };
}

export function readWorkerMetadata(cwd, { required = false } = {}) {
	const root = findWorkerRoot(cwd);
	if (!root) {
		if (required) throw new Error("not a managed gitless worker sandbox");
		return null;
	}
	const metadataPath = path.join(root, WORKER_METADATA_REL);
	let metadataBytes;
	try {
		const observed = fs.lstatSync(metadataPath);
		if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink !== 1) {
			throw new Error("metadata must be a single-linked regular file");
		}
		metadataBytes = fs.readFileSync(metadataPath, "utf8");
	} catch (err) {
		throw new Error(`invalid managed worker metadata: ${err.message}`);
	}
	return parseWorkerMetadata(metadataBytes, root, metadataPath);
}
