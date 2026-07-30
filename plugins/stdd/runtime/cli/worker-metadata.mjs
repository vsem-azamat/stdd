import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPrintableSingleLine } from "../sdk/text.mjs";
import { isLedgerStringArray, isPlainLedgerRecord, MANIFEST_HASH_PATTERN } from "./state-validation.mjs";

export const WORKER_METADATA_REL = ".stdd/worker.json";
export const WORKER_METADATA_SCHEMA = 1;
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

function validateWorkerFileState(state) {
	return (
		state === null ||
		(isPlainLedgerRecord(state) &&
			((state.type === "file" &&
				MANIFEST_HASH_PATTERN.test(state.hash) &&
				Number.isInteger(state.mode)) ||
				(state.type === "symlink" &&
					typeof state.target === "string" &&
					MANIFEST_HASH_PATTERN.test(state.hash))))
	);
}

export function readWorkerMetadata(cwd, { required = false } = {}) {
	const root = findWorkerRoot(cwd);
	if (!root) {
		if (required) throw new Error("not a managed gitless worker sandbox");
		return null;
	}
	const metadataPath = path.join(root, WORKER_METADATA_REL);
	let parsed;
	let metadataBytes;
	try {
		const observed = fs.lstatSync(metadataPath);
		if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink !== 1) {
			throw new Error("metadata must be a single-linked regular file");
		}
		metadataBytes = fs.readFileSync(metadataPath, "utf8");
		parsed = JSON.parse(metadataBytes);
	} catch (err) {
		throw new Error(`invalid managed worker metadata: ${err.message}`);
	}
	if (
		parsed?.schema !== WORKER_METADATA_SCHEMA ||
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
		!Object.values(parsed.baseline.files).every(validateWorkerFileState)
	) {
		throw new Error("invalid managed worker metadata schema");
	}
	parsed.baseline.files = Object.assign(Object.create(null), parsed.baseline.files);
	return { ...parsed, root, metadataPath, metadataBytes };
}
