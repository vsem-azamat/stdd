// --- the session ledger (see method: "The session ledger and stdd status") ---
//
// Owns the ledger's durable shape end to end: the event schema, branch and
// task scoping, the lock/transaction/recovery machinery, the task lifecycle,
// the durable plan, and `stdd defer`. It has no dependency on the entry module.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameFileIdentity } from "../sdk/file-observation.mjs";
import { assertPrintableSingleLine, isPrintableSingleLine } from "../sdk/text.mjs";
import { deriveTaskState, scopeTaskEvents } from "../sdk/workflow.mjs";
import { loadConfig } from "./config.mjs";
import {
	openOrCreateNativeRepoDirectory,
	readNativeFile,
	readOptionalNativeRepoFile,
	verifyNativeRepoDirectory,
	writeNativeFileContent,
} from "./held-fs.mjs";
import { appendDeferred, deriveReviewVerdict, parseReviewResult, sha256 } from "./lib.mjs";
import { splitNul } from "./path-bytes.mjs";
import { git, MAX_SUBPROCESS_BUFFER, statePath } from "./runtime.mjs";
import {
	isLedgerStringArray,
	isPlainLedgerRecord,
	MANIFEST_HASH_PATTERN,
	sameReviewPrivateState,
} from "./state-validation.mjs";
import { findWorkerRoot, readWorkerMetadata, WORKER_ID_PATTERN } from "./worker-metadata.mjs";

export const LEDGER_REL = ".stdd/ledger.jsonl";
export const PLAN_REL = ".stdd/plan.md";
export const STATE_EXEMPT = [LEDGER_REL, PLAN_REL];
export const LEGACY_LEDGER_RESET_TEMP_IGNORE = ".stdd/.ledger-reset-*.tmp";
export const LEDGER_RESET_TEMP_GIT_GLOB = `.stdd/.ledger-reset-${"[0-9a-f]".repeat(32)}.tmp`;
const LEDGER_INTERNAL_TEMP_PREFIXES = [
	"ledger-reset",
	"ledger-prepared",
	"ledger-recovered",
	"ledger-aborted",
];
export const LEDGER_INTERNAL_TEMP_GIT_GLOBS = LEDGER_INTERNAL_TEMP_PREFIXES.map(
	(prefix) => `.stdd/.${prefix}-${"[0-9a-f]".repeat(32)}.tmp`,
);
const LEDGER_ACTIVE_TEMP_BASENAME = /^\.(?:ledger-reset|ledger-prepared)-[0-9a-f]{32}\.tmp$/;
export const LEDGER_INTERNAL_TEMP_RELATIVE =
	/^\.stdd\/\.(?:ledger-reset|ledger-prepared)-[0-9a-f]{32}\.tmp$/;
const LEDGER_RETAINED_FILE_RELATIVE =
	/^\.stdd\/ledger-quarantines\/(\.ledger-recovered-([0-9a-f]{32})\.tmp)\/(inventory\.json|payload)$/;
const LF_BYTE = 0x0a;
const LEGACY_FLOW_MARKER = "taskless-v1";
const LEGACY_RECORDER_EVENTS = new Set(["docs", "red", "verify", "note"]);
const LEDGER_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LEDGER_PARTIAL_LOCK_GRACE_MS = 1_000;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const LEDGER_MODULE = import.meta.url;
export const REVIEW_VIAS = ["subagent", "codex", "claude"];
export const DOCS_DECISIONS = ["updated-first", "checked", "not-applicable"];
export const LABEL_TO_DECISION = {
	"Docs updated first": "updated-first",
	"Docs checked, no change needed": "checked",
	"Docs not applicable": "not-applicable",
};

function fail(message) {
	fs.writeSync(process.stderr.fd, `stdd: ${message}\n`);
	process.exit(1);
}

/** UTF-8 git paths without core.quotePath/C-style quoting. */
export function gitChangedPaths(repoDir, range) {
	return splitNul(
		execFileSync("git", ["-C", repoDir, "diff", "--name-only", "-z", "--end-of-options", range], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		}),
	).map((entry) => entry.toString("utf8"));
}

/** Staged, unstaged, and untracked paths, with NUL-safe Git output. */
export function gitWorkingPaths(repoDir) {
	const tracked = splitNul(
		execFileSync("git", ["-C", repoDir, "diff", "--name-only", "-z", "HEAD"], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		}),
	);
	const untracked = splitNul(
		execFileSync("git", ["-C", repoDir, "ls-files", "--others", "--exclude-standard", "-z"], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		}),
	);
	return [...tracked, ...untracked].map((entry) => entry.toString("utf8"));
}

function ownedMode(observed, kind, mode, currentUid) {
	const shape =
		(kind === "file" ? observed.isFile() : observed.isDirectory()) &&
		!observed.isSymbolicLink() &&
		(kind !== "file" || observed.nlink === 1);
	if (!shape) return false;
	// Node exposes synthetic POSIX mode/uid values on Windows. The native
	// creator already enforces a protected current-user DACL; read-only
	// inventory recognition can bind only the exact token/provenance/shape.
	if (process.platform === "win32") return true;
	return (observed.mode & 0o777) === mode && (currentUid === null || observed.uid === currentUid);
}

function trustedLedgerQuarantine(cwd, containerName, token) {
	try {
		const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
		const root = path.join(cwd, ".stdd", "ledger-quarantines");
		const container = path.join(root, containerName);
		if (!ownedMode(fs.lstatSync(root), "directory", 0o700, currentUid)) return null;
		if (!ownedMode(fs.lstatSync(container), "directory", 0o700, currentUid)) return null;
		const names = fs.readdirSync(container).sort();
		if (names.length !== 2 || names[0] !== "inventory.json" || names[1] !== "payload") return null;
		for (const name of names) {
			if (!ownedMode(fs.lstatSync(path.join(container, name)), "file", 0o600, currentUid)) return null;
		}
		const inventory = JSON.parse(fs.readFileSync(path.join(container, "inventory.json"), "utf8"));
		const retained = `.stdd/ledger-quarantines/${containerName}/payload`;
		if (
			inventory?.schema !== 1 ||
			inventory.kind !== "ledger-transaction-temp" ||
			inventory.phase !== "recovered" ||
			!new RegExp(`^\\.stdd/\\.ledger-(?:reset|prepared)-${token}\\.tmp$`).test(inventory.original) ||
			inventory.retained !== retained ||
			inventory.identity?.version !== 2 ||
			inventory.identity.kind !== "file"
		) {
			return null;
		}
		return inventory;
	} catch {
		return null;
	}
}

export function ledgerQuarantineInventory(cwd) {
	const root = path.join(cwd, ".stdd", "ledger-quarantines");
	let names;
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	return names
		.map((containerName) => {
			const match = containerName.match(/^\.ledger-recovered-([0-9a-f]{32})\.tmp$/);
			if (!match || !trustedLedgerQuarantine(cwd, containerName, match[1])) return null;
			return {
				relative: `.stdd/ledger-quarantines/${containerName}`,
				provenance: "ledger recovery inventory",
			};
		})
		.filter(Boolean)
		.sort((left, right) => left.relative.localeCompare(right.relative));
}

export function isTrustedLedgerInternalTemp(cwd, file) {
	const retained = file.match(LEDGER_RETAINED_FILE_RELATIVE);
	if (retained) return trustedLedgerQuarantine(cwd, retained[1], retained[2]) !== null;
	if (!LEDGER_INTERNAL_TEMP_RELATIVE.test(file)) return false;
	try {
		const observed = fs.lstatSync(path.join(cwd, file));
		const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
		return ownedMode(observed, "file", 0o600, currentUid);
	} catch {
		return false;
	}
}

export function isStateExemptPath(cwd, file) {
	return STATE_EXEMPT.includes(file) || isTrustedLedgerInternalTemp(cwd, file);
}

/**
 * The ledger and config anchor to the repository, never the shell's cwd —
 * a recorder run from a subdirectory must not create a nested `.stdd/`.
 * Resolution: the git toplevel when it holds `.stdd/` (or when none exists
 * yet), otherwise the nearest ancestor holding `.stdd/`. Outside a git
 * repo the cwd is returned unchanged — recorders require git anyway.
 */
export function resolveRepoDir(cwd) {
	let top;
	try {
		top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return findWorkerRoot(cwd) ?? cwd;
	}
	if (fs.existsSync(path.join(top, ".stdd"))) return top;
	let dir = path.resolve(cwd);
	while (dir !== top && path.dirname(dir) !== dir) {
		if (fs.existsSync(path.join(dir, ".stdd"))) return dir;
		dir = path.dirname(dir);
	}
	return top;
}

/** Current printable branch name, or null outside a git repo; hostile names fail before use. */
export function currentBranch(cwd) {
	let branch;
	try {
		branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return readWorkerMetadata(cwd)?.source.branch ?? null;
	}
	try {
		return assertPrintableSingleLine(branch, "current Git branch");
	} catch {
		fail("current Git branch must be a non-empty single printable line without control characters");
	}
}

export function requireBranch(cwd) {
	const branch = currentBranch(cwd);
	if (!branch) fail("the ledger needs a git repository with at least one commit");
	return branch;
}

// --- the durable event schema ---

function isOptionalPrintable(value) {
	return value === undefined || isPrintableSingleLine(value);
}

function isOptionalSnapshot(value) {
	return value === undefined || isPrintableSingleLine(value);
}

function isCanonicalLedgerTimestamp(value) {
	if (value === undefined) return true;
	if (!isPrintableSingleLine(value)) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function isLedgerReviewFindings(summary, findings) {
	return parseReviewResult(JSON.stringify({ summary, findings })) !== null;
}

function isLedgerReviewRunner(value) {
	return (
		value === undefined ||
		(isPlainLedgerRecord(value) &&
			isPrintableSingleLine(value.command) &&
			(value.exit === null || Number.isSafeInteger(value.exit)) &&
			isOptionalPrintable(value.error))
	);
}

function isLedgerScopeBaseline(value) {
	if (
		!isPlainLedgerRecord(value) ||
		!isPrintableSingleLine(value.head) ||
		!isPlainLedgerRecord(value.dirty)
	) {
		return false;
	}
	return Object.values(value.dirty).every(
		(fingerprint) => fingerprint === null || typeof fingerprint === "string",
	);
}

export function isStateLedgerEvent(event) {
	const taskBoundary =
		event.event === "task-start" || event.event === "task-finish" || event.event === "task-reset";
	if (
		!isPrintableSingleLine(event.event) ||
		!isPrintableSingleLine(event.branch) ||
		!isCanonicalLedgerTimestamp(event.ts) ||
		(!taskBoundary && !isOptionalPrintable(event.taskId)) ||
		(event.legacyFlow !== undefined && event.legacyFlow !== LEGACY_FLOW_MARKER)
	) {
		return false;
	}
	switch (event.event) {
		case "task-start":
		case "task-finish":
		case "task-reset":
			// deriveTaskState owns the full task-boundary schema and preserves
			// its field-specific repair reason. Every state consumer passes
			// these records through that validator before using them.
			return true;
		case "docs":
			if (
				!DOCS_DECISIONS.includes(event.decision) ||
				!isLedgerStringArray(event.paths) ||
				!isOptionalSnapshot(event.snapshot) ||
				!isOptionalPrintable(event.reason)
			) {
				return false;
			}
			return event.decision === "not-applicable"
				? event.paths.length === 0 && isPrintableSingleLine(event.reason)
				: event.paths.length > 0 &&
						(event.decision !== "checked" || isPrintableSingleLine(event.reason));
		case "red":
			return (
				typeof event.cmd === "string" &&
				event.cmd.length > 0 &&
				Number.isSafeInteger(event.exit) &&
				event.exit >= 0 &&
				typeof event.excerpt === "string" &&
				isOptionalSnapshot(event.snapshot) &&
				["yes", "no", "unknown"].includes(event.genuine)
			);
		case "verify":
			return (
				typeof event.cmd === "string" &&
				event.cmd.length > 0 &&
				Number.isSafeInteger(event.exit) &&
				event.exit >= 0 &&
				typeof event.excerpt === "string" &&
				isOptionalSnapshot(event.snapshot)
			);
		case "note":
			return typeof event.text === "string" && event.text.length > 0;
		case "scope":
			return (
				isLedgerStringArray(event.frozenPaths) &&
				isLedgerStringArray(event.allowedPaths) &&
				event.frozenPaths.length + event.allowedPaths.length > 0 &&
				isLedgerScopeBaseline(event.baseline)
			);
		case "worker-create":
			return (
				WORKER_ID_PATTERN.test(event.workerId) &&
				MANIFEST_HASH_PATTERN.test(event.metadataHash) &&
				isPrintableSingleLine(event.sourceHead)
			);
		case "review-request":
			return (
				isPrintableSingleLine(event.id) &&
				REVIEW_VIAS.includes(event.via) &&
				isOptionalSnapshot(event.snapshot) &&
				isOptionalPrintable(event.brief) &&
				isOptionalPrintable(event.briefHash) &&
				(event.brief !== undefined || event.briefHash !== undefined) &&
				isPrintableSingleLine(event.briefPath) &&
				isOptionalPrintable(event.forced) &&
				(event.privateState === undefined ||
					sameReviewPrivateState(event.privateState, event.privateState))
			);
		case "review":
			if (
				!isOptionalPrintable(event.request) ||
				!REVIEW_VIAS.includes(event.via) ||
				!["approved", "changes-requested", "error"].includes(event.verdict) ||
				!isOptionalSnapshot(event.snapshot) ||
				!isLedgerReviewRunner(event.runner)
			) {
				return false;
			}
			if (event.verdict === "error") return isPrintableSingleLine(event.reason);
			return (
				isLedgerReviewFindings(event.summary, event.findings) &&
				deriveReviewVerdict(event.findings) === event.verdict
			);
		case "review-cancelled":
			return (
				isPrintableSingleLine(event.request) &&
				REVIEW_VIAS.includes(event.via) &&
				isPrintableSingleLine(event.reason)
			);
		default:
			return false;
	}
}

/**
 * State derivation must preserve every non-blank ledger line. The public
 * parseLedger helper remains tolerant for callers that only inspect evidence,
 * but silently dropping a torn write here could revive older legacy state.
 * A syntax error or event without trustworthy branch metadata is represented
 * by a non-object event so deriveTaskState reports the ledger as invalid
 * through the same boundary contract.
 */
export function parseStateLedger(text, branch) {
	const events = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			events.push(null);
			continue;
		}
		if (typeof event !== "object" || event === null || Array.isArray(event)) {
			events.push(event);
			continue;
		}
		if (!isPrintableSingleLine(event.branch)) {
			events.push(null);
			continue;
		}
		if (event.branch !== branch) continue;
		if (!isStateLedgerEvent(event)) {
			events.push(null);
			continue;
		}
		events.push(event);
	}
	return events;
}

export function rawLedger(cwd, branch) {
	const ledgerPath = statePath(cwd, LEDGER_REL, "ledger path");
	if (!fs.existsSync(ledgerPath)) return [];
	return parseStateLedger(fs.readFileSync(ledgerPath, "utf8"), branch);
}

/** Branch named by a local or remote base ref, or null for tags/expressions. */
function baseRefBranch(cwd, baseRef) {
	if (!baseRef) return null;
	let fullRef;
	try {
		fullRef = git("-C", cwd, "rev-parse", "--symbolic-full-name", "--verify", baseRef);
	} catch {
		return null;
	}
	if (fullRef.startsWith("refs/heads/")) return fullRef.slice("refs/heads/".length);
	if (!fullRef.startsWith("refs/remotes/")) return null;
	const remoteAndBranch = fullRef.slice("refs/remotes/".length);
	const separator = remoteAndBranch.indexOf("/");
	return separator < 0 ? null : remoteAndBranch.slice(separator + 1);
}

function legacyCheckoutIsIdle(cwd, branch, config) {
	const baseRef = config.baseRef ?? "";
	const isBaseBranch = baseRefBranch(cwd, baseRef) === branch;
	if (!isBaseBranch) return false;
	try {
		const changed = [
			...new Set([...gitChangedPaths(cwd, `${config.baseRef}...HEAD`), ...gitWorkingPaths(cwd)]),
		].filter((file) => !isStateExemptPath(cwd, file));
		return changed.length === 0;
	} catch {
		return false;
	}
}

/** Apply task boundaries and the clean-base legacy compatibility rule once. */
export function scopeLedgerForCheckout(
	cwd,
	branch,
	events = rawLedger(cwd, branch),
	config = loadConfig(cwd),
) {
	const scoped = scopeTaskEvents(events);
	const managedLegacyFlow = events.some((event) => event?.legacyFlow === LEGACY_FLOW_MARKER);
	if (
		scoped.state.state === "legacy" &&
		events.length > 0 &&
		!managedLegacyFlow &&
		legacyCheckoutIsIdle(cwd, branch, config)
	) {
		return {
			state: { state: "idle", task: null, reason: "clean-base-legacy" },
			events: [],
		};
	}
	return scoped;
}

export function taskLifecycleState(events) {
	const state = deriveTaskState(events);
	if (state.state === "invalid") {
		throw new Error(
			`malformed task boundary in .stdd/ledger.jsonl: ${state.reason} — ` +
				"repair .stdd/ledger.jsonl before changing task lifecycle",
		);
	}
	return state;
}

function inspectLedgerAppendContext(
	cwd,
	event,
	{ allowHistoricalTask = false, allowBranchScopedHistorical = false } = {},
) {
	const branch = currentBranch(cwd);
	if (!branch) {
		throw new Error("the ledger needs a git repository with at least one commit");
	}
	const taskState = scopeLedgerForCheckout(cwd, branch).state;
	if (taskState.state === "invalid") {
		throw new Error(`malformed task boundary in .stdd/ledger.jsonl: ${taskState.reason}`);
	}
	const task = taskState.state === "active" ? taskState.task : null;
	const closesHistoricalEvent =
		(typeof event.taskId === "string" && (event.event === "review-cancelled" || allowHistoricalTask)) ||
		(event.event === "review-cancelled" && allowBranchScopedHistorical);
	const emptyCleanBaseReview =
		event.event === "review-request" &&
		taskState.state === "legacy" &&
		legacyCheckoutIsIdle(cwd, branch, loadConfig(cwd));
	if (
		(taskState.state === "idle" || emptyCleanBaseReview) &&
		event.event !== "task-start" &&
		!closesHistoricalEvent
	) {
		throw new Error(
			'no active task — run `stdd task start "<short name>"` before recording new evidence',
		);
	}
	return { branch, taskState, task };
}

export function ledgerAppendContext(cwd, event, options = {}) {
	try {
		return inspectLedgerAppendContext(cwd, event, options);
	} catch (err) {
		fail(err.message);
	}
}

// --- the ledger lock, its recovery, and the append/transaction path ---

function ledgerLockPath(cwd) {
	const repo = fs.realpathSync(cwd);
	const key = createHash("sha256").update(repo).digest("hex").slice(0, 32);
	return path.join(os.tmpdir(), `stdd-ledger-${key}.lock`);
}

// OS-temp lock cleanup is outside the repository capability boundary. It
// still conditions retirement on the exact inode observed by this process.
function retirePortableTempMetadata(
	filePath,
	observed,
	{ preserve = false, prefix = ".stdd-remove" } = {},
) {
	let quarantine = null;
	try {
		const parent = path.dirname(filePath);
		const parentObserved = fs.lstatSync(parent);
		if (!parentObserved.isDirectory() || parentObserved.isSymbolicLink()) return false;
		const current = fs.lstatSync(filePath);
		if (!sameFileIdentity(current, observed)) return false;
		quarantine = path.join(parent, `${prefix}-${randomBytes(16).toString("hex")}.tmp`);
		fs.renameSync(filePath, quarantine);
		const parentAfter = fs.lstatSync(parent);
		const moved = fs.lstatSync(quarantine);
		if (!sameFileIdentity(parentObserved, parentAfter) || !sameFileIdentity(current, moved)) {
			if (!fs.existsSync(filePath)) fs.renameSync(quarantine, filePath);
			return false;
		}
		if (!preserve) {
			// Lock/owner files contain only STDD coordination metadata and
			// live in a sticky/private temp directory. The unpredictable
			// quarantine name narrows cleanup to the inode just moved out of
			// the authoritative lock path. Repository data uses preserve=true
			// because concurrent user edits must never be unlinked.
			try {
				fs.unlinkSync(quarantine);
			} catch {
				// The lock name is already retired. A cleanup remnant is inert
				// and preferable to making lock release fail after the action.
			}
		}
		quarantine = null;
		return true;
	} catch {
		return false;
	}
}

function recoverAbandonedLedgerLock(lockPath) {
	let observed;
	let owner = null;
	try {
		observed = fs.lstatSync(lockPath);
		if (!observed.isFile() || observed.isSymbolicLink()) return false;
		try {
			owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		} catch {
			// Legacy lock acquisition exposed this inode before writing owner
			// metadata. A grace period protects a live, just-created lock.
		}
	} catch {
		return false;
	}
	const validOwner =
		Number.isSafeInteger(owner?.pid) &&
		owner.pid > 0 &&
		typeof owner.token === "string" &&
		/^[0-9a-f]{32}$/.test(owner.token);
	if (!validOwner) {
		const age = Date.now() - Math.max(observed.mtimeMs, observed.ctimeMs);
		return age >= LEDGER_PARTIAL_LOCK_GRACE_MS ? retirePortableTempMetadata(lockPath, observed) : false;
	}
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (err) {
		if (err.code !== "ESRCH") return false;
	}
	const recovered = retirePortableTempMetadata(lockPath, observed);
	if (recovered) {
		const ownerPath = `${lockPath}.${owner.pid}.${owner.token}.owner`;
		retirePortableTempMetadata(ownerPath, observed);
	}
	return recovered;
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

function assertPrivateLedgerTemp(context, entry) {
	const observation = entry.observation;
	if (
		observation.identity.kind !== "file" ||
		observation.linkCount !== "1" ||
		(observation.identity.platform !== "win32" &&
			observation.owner !== context.root.observation.owner) ||
		(observation.identity.platform !== "win32" && (Number(observation.permissions) & 0o777) !== 0o600)
	) {
		throw new Error(
			`unsafe ledger transaction temporary file ${JSON.stringify(`.stdd/${entry.name}`)} — ` +
				"expected a regular owner-only (0600) file owned by the current user; remove it manually",
		);
	}
}

async function closeNativeCapabilitiesBestEffort(context, capabilities) {
	for (const cap of [...capabilities].reverse()) {
		await context.session.closeCapability(cap).catch(() => {});
	}
}

async function quarantineLedgerTemp(context, stdd, source, capabilities, beforeCommit) {
	const match = source.name.match(/^\.(ledger-reset|ledger-prepared)-([0-9a-f]{32})\.tmp$/);
	if (!match) throw new Error(`unrecognized ledger transaction temporary ${source.name}`);
	const [, sourcePhase, token] = match;
	const root = await openOrCreateNativeRepoDirectory(context, ".stdd/ledger-quarantines", {
		mode: 0o700,
		label: "retained ledger quarantine root",
		beforeCommit,
	});
	capabilities.add(root.cap);
	if (
		(root.observation.identity.platform !== "win32" &&
			root.observation.owner !== context.root.observation.owner) ||
		(root.observation.identity.platform !== "win32" &&
			(Number(root.observation.permissions) & 0o777) !== 0o700)
	) {
		throw new Error("retained ledger quarantine root must be owner-private mode 0700");
	}
	// The source token makes even a crash immediately after mkdir attributable
	// without scanning outside the one recognized quarantine root.
	const containerName = `.ledger-recovered-${token}.tmp`;
	let container;
	try {
		await beforeCommit("quarantine-container");
		container = await context.session.createDirectory(root.cap, containerName, 0o700);
	} catch (error) {
		if (error?.code !== "identity-conflict") throw error;
		container = await context.session.openChild(root.cap, containerName);
	}
	capabilities.add(container.cap);
	if (
		container.observation.identity.kind !== "directory" ||
		(container.observation.identity.platform !== "win32" &&
			container.observation.owner !== context.root.observation.owner) ||
		(container.observation.identity.platform !== "win32" &&
			(Number(container.observation.permissions) & 0o777) !== 0o700)
	) {
		throw new Error(`retained ledger quarantine ${containerName} is not an owner-private directory`);
	}
	const retained = `.stdd/ledger-quarantines/${containerName}/payload`;
	const provenance = Buffer.from(
		`${JSON.stringify({
			schema: 1,
			kind: "ledger-transaction-temp",
			phase: "recovered",
			sourcePhase,
			original: `.stdd/${source.name}`,
			retained,
			identity: source.observation.identity,
			size: source.observation.size,
		})}\n`,
	);
	let inventory = null;
	try {
		inventory = await context.session.openChild(container.cap, "inventory.json");
		capabilities.add(inventory.cap);
	} catch (error) {
		if (error?.code !== "not-found") throw error;
	}
	if (!inventory) {
		const stagedName = `.inventory-${token}.tmp`;
		let staged;
		try {
			staged = await context.session.openChild(container.cap, stagedName);
		} catch (error) {
			if (error?.code !== "not-found") throw error;
			await beforeCommit("quarantine-inventory-create");
			staged = await context.session.createFile(container.cap, stagedName, 0o600);
		}
		capabilities.add(staged.cap);
		if (
			staged.observation.identity.kind !== "file" ||
			(staged.observation.identity.platform !== "win32" &&
				staged.observation.owner !== context.root.observation.owner) ||
			staged.observation.linkCount !== "1" ||
			(staged.observation.identity.platform !== "win32" &&
				(Number(staged.observation.permissions) & 0o777) !== 0o600)
		) {
			throw new Error(`retained ledger quarantine ${containerName} has an unsafe inventory temporary`);
		}
		await writeNativeFileContent(context, staged, provenance);
		await beforeCommit("quarantine-inventory-publish");
		await context.session.rename({
			fromParent: container.cap,
			from: stagedName,
			expected: staged.observation.identity,
			toParent: container.cap,
			to: "inventory.json",
			replace: "never",
		});
		await context.session.flush(container.cap, "namespace", container.observation.identity);
		await context.session.flush(root.cap, "namespace", root.observation.identity);
		inventory = await context.session.openChild(container.cap, "inventory.json");
		capabilities.add(inventory.cap);
	}
	const existing = await readNativeFile(context, inventory);
	if (!existing.equals(provenance)) {
		throw new Error(
			`retained ledger quarantine ${containerName} has provenance that does not match its active transaction`,
		);
	}
	await beforeCommit("quarantine-payload");
	await context.session.rename({
		fromParent: stdd.cap,
		from: source.name,
		expected: source.observation.identity,
		toParent: container.cap,
		to: "payload",
		replace: "never",
	});
	for (const directory of [stdd, container, root]) {
		await context.session.flush(directory.cap, "namespace", directory.observation.identity);
	}
	await verifyNativeRepoDirectory(context, ".stdd", stdd.observation.identity, "ledger directory");
	await verifyNativeRepoDirectory(
		context,
		`.stdd/ledger-quarantines/${containerName}`,
		container.observation.identity,
		"retained ledger quarantine",
	);
}

/** One capability session performs recovery and at most one atomic ledger publication. */
export async function mutateLedgerWithNativeSession(context, records, { beforeCommit = () => {} } = {}) {
	const capabilities = new Set();
	try {
		const stdd = await openOrCreateNativeRepoDirectory(context, ".stdd", {
			mode: 0o755,
			label: "ledger directory",
			beforeCommit,
		});
		capabilities.add(stdd.cap);
		const entries = await listNativeDirectory(context, stdd);
		const active = entries
			.filter((entry) => LEDGER_ACTIVE_TEMP_BASENAME.test(entry.name))
			.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of active) assertPrivateLedgerTemp(context, entry);
		const original = await readOptionalNativeRepoFile(context, ".stdd/ledger.jsonl", {
			label: "ledger",
			maximum: MAX_LEDGER_BYTES,
		});
		if (original) {
			capabilities.add(original.parent.cap);
			capabilities.add(original.file.cap);
		}
		for (const entry of active) {
			await quarantineLedgerTemp(context, stdd, entry, capabilities, beforeCommit);
		}
		if (records.length === 0) return;

		const originalBytes = original?.bytes ?? Buffer.alloc(0);
		const separator =
			originalBytes.length > 0 && originalBytes.at(-1) !== LF_BYTE ? Buffer.from("\n") : Buffer.alloc(0);
		const content = Buffer.concat([
			originalBytes,
			separator,
			...records.map((record) => Buffer.from(`${record}\n`)),
		]);
		if (content.length > MAX_LEDGER_BYTES) {
			throw new Error("ledger transaction exceeds the maximum supported size");
		}
		const token = randomBytes(16).toString("hex");
		const resetName = `.ledger-reset-${token}.tmp`;
		const preparedName = `.ledger-prepared-${token}.tmp`;
		await beforeCommit("prepare");
		const temporary = await context.session.createFile(stdd.cap, resetName, 0o600);
		capabilities.add(temporary.cap);
		await writeNativeFileContent(context, temporary, content);
		await beforeCommit("pre-rename");
		await context.session.rename({
			fromParent: stdd.cap,
			from: resetName,
			expected: temporary.observation.identity,
			toParent: stdd.cap,
			to: preparedName,
			replace: "never",
		});
		await context.session.flush(stdd.cap, "namespace", stdd.observation.identity);
		await verifyNativeRepoDirectory(context, ".stdd", stdd.observation.identity, "ledger directory");
		const prepared = await context.session.openChild(stdd.cap, preparedName);
		capabilities.add(prepared.cap);
		if (!sameNativeIdentity(prepared.observation.identity, temporary.observation.identity)) {
			throw new Error("ledger transaction temporary file was replaced before commit");
		}
		const current = await readOptionalNativeRepoFile(context, ".stdd/ledger.jsonl", {
			label: "ledger",
			maximum: MAX_LEDGER_BYTES,
		});
		if (current) {
			capabilities.add(current.parent.cap);
			capabilities.add(current.file.cap);
		}
		if (
			(original === null) !== (current === null) ||
			(original &&
				(!current ||
					!sameNativeIdentity(original.file.observation.identity, current.file.observation.identity) ||
					!original.bytes.equals(current.bytes)))
		) {
			throw new Error(
				"ledger changed after its transaction snapshot; the prepared transaction was not committed",
			);
		}
		await beforeCommit("commit");
		try {
			await context.session.rename({
				fromParent: stdd.cap,
				from: preparedName,
				expected: prepared.observation.identity,
				toParent: stdd.cap,
				to: "ledger.jsonl",
				replace: current ? "expected" : "never",
				...(current ? { expectedTarget: current.file.observation.identity } : {}),
			});
		} catch (error) {
			if (error?.mutation !== "possible" && error?.mutation !== "committed") throw error;
			let published;
			try {
				published = await context.session.openChild(stdd.cap, "ledger.jsonl");
				capabilities.add(published.cap);
			} catch {
				throw error;
			}
			if (!sameNativeIdentity(published.observation.identity, prepared.observation.identity)) {
				throw error;
			}
		}
		await context.session.flush(stdd.cap, "namespace", stdd.observation.identity);
		await verifyNativeRepoDirectory(context, ".stdd", stdd.observation.identity, "ledger directory");
		const published = await context.session.openChild(stdd.cap, "ledger.jsonl");
		capabilities.add(published.cap);
		if (!sameNativeIdentity(published.observation.identity, prepared.observation.identity)) {
			const error = new Error("ledger transaction temporary file was replaced at commit");
			error.mutation = "committed";
			throw error;
		}
	} finally {
		await closeNativeCapabilitiesBestEffort(context, capabilities);
	}
}

const NATIVE_LEDGER_PROGRAM = `
import fs from "node:fs";
import {
  currentBranch,
  mutateLedgerWithNativeSession,
} from ${JSON.stringify(LEDGER_MODULE)};
import { openNativeRepoMutation } from ${JSON.stringify(new URL("./held-fs.mjs", import.meta.url).href)};

const request = JSON.parse(fs.readFileSync(0, "utf8"));
let context;
try {
  context = await openNativeRepoMutation(request.cwd, "ledger native filesystem helper");
  const beforeCommit = !request.checkBranch || request.expectedBranch === null ? () => {} : () => {
    if (currentBranch(request.cwd) !== request.expectedBranch) {
      throw new Error("the checkout switched branches before the ledger transaction was recorded — nothing recorded; retry on " + request.expectedBranch);
    }
  };
  await mutateLedgerWithNativeSession(context, request.records, { beforeCommit });
} catch (error) {
  globalThis.process.stderr.write(JSON.stringify({
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    operation: error?.operation ?? null,
    mutation: error?.mutation ?? null,
  }));
  globalThis.process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
}
`;

function runNativeLedgerMutation(cwd, records, expectedBranch, checkBranch) {
	try {
		execFileSync(process.execPath, ["--input-type=module", "--eval", NATIVE_LEDGER_PROGRAM], {
			input: JSON.stringify({ cwd, records, expectedBranch, checkBranch }),
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 2 * 1024 * 1024,
		});
	} catch (error) {
		const stderr = error.stderr?.toString("utf8").trim();
		if (stderr) {
			try {
				const native = JSON.parse(stderr);
				const metadata = [
					native.code ? `code=${native.code}` : null,
					native.operation ? `operation=${native.operation}` : null,
					native.mutation ? `mutation=${native.mutation}` : null,
				].filter(Boolean);
				throw new Error(`${native.message}${metadata.length ? ` (${metadata.join(", ")})` : ""}`, {
					cause: error,
				});
			} catch (parsedError) {
				if (parsedError.cause === error) throw parsedError;
			}
		}
		const outcome = error.signal
			? `native ledger helper terminated by ${error.signal}; commit outcome is unknown — inspect ${LEDGER_REL} before retrying`
			: "native ledger helper failed without a structured diagnostic; commit outcome is unknown";
		throw new Error(outcome, { cause: error });
	}
}

let activeLedgerMutation = null;

export function withLedgerLock(cwd, action) {
	const lockPath = ledgerLockPath(cwd);
	const token = randomBytes(16).toString("hex");
	const ownerPath = `${lockPath}.${process.pid}.${token}.owner`;
	const deadline = Date.now() + 10_000;
	let ownerFd;
	let ownerStat;
	let lockStat;
	try {
		ownerFd = fs.openSync(ownerPath, "wx", 0o600);
		ownerStat = fs.fstatSync(ownerFd);
		fs.writeFileSync(
			ownerFd,
			JSON.stringify({
				pid: process.pid,
				token,
				createdAt: new Date().toISOString(),
			}),
		);
		fs.fsyncSync(ownerFd);
		fs.closeSync(ownerFd);
		ownerFd = null;
	} catch (err) {
		if (ownerFd !== null && ownerFd !== undefined) {
			try {
				fs.closeSync(ownerFd);
			} catch {
				// The unique owner path is removed below.
			}
		}
		if (ownerStat && !retirePortableTempMetadata(ownerPath, ownerStat)) {
			throw new Error(
				`${err.message}; additionally, could not retire the private ledger lock owner file at ${ownerPath}`,
				{ cause: err },
			);
		}
		throw err;
	}
	let result;
	let actionFailure = null;
	let nativeFailure = null;
	try {
		for (;;) {
			try {
				// The shared name appears atomically only after complete owner
				// metadata has been written and flushed to its inode.
				fs.linkSync(ownerPath, lockPath);
				lockStat = ownerStat;
				if (!retirePortableTempMetadata(ownerPath, ownerStat)) {
					const lockRetired = retirePortableTempMetadata(lockPath, lockStat);
					if (lockRetired) lockStat = null;
					throw new Error(
						lockRetired
							? "could not retire the private ledger lock owner file"
							: "could not retire the private ledger lock owner file or release the shared lock",
					);
				}
				ownerStat = null;
				break;
			} catch (err) {
				if (err.code !== "EEXIST") throw err;
				if (recoverAbandonedLedgerLock(lockPath)) continue;
				if (Date.now() >= deadline) {
					throw new Error("the ledger is busy in another stdd process; retry the command");
				}
				Atomics.wait(LEDGER_LOCK_WAIT, 0, 0, 20);
			}
		}
		if (activeLedgerMutation !== null) throw new Error("nested ledger mutation is unsupported");
		activeLedgerMutation = {
			cwd,
			records: [],
			expectedBranch: null,
			checkBranch: true,
			committed: false,
		};
		try {
			result = action();
		} catch (err) {
			actionFailure = err;
		}
		try {
			if (!activeLedgerMutation.committed) {
				const records = actionFailure === null ? activeLedgerMutation.records : [];
				const expectedBranch = actionFailure === null ? activeLedgerMutation.expectedBranch : null;
				const checkBranch = actionFailure === null ? activeLedgerMutation.checkBranch : false;
				runNativeLedgerMutation(cwd, records, expectedBranch, checkBranch);
			}
		} catch (err) {
			nativeFailure = err;
		} finally {
			activeLedgerMutation = null;
		}
	} catch (err) {
		if (actionFailure === null) actionFailure = err;
	}
	if (nativeFailure && actionFailure === null) actionFailure = nativeFailure;
	else if (nativeFailure && actionFailure) {
		actionFailure = new Error(`${actionFailure.message}; additionally, ${nativeFailure.message}`, {
			cause: actionFailure,
		});
	}
	const releaseFailures = [];
	if (lockStat && !retirePortableTempMetadata(lockPath, lockStat)) {
		releaseFailures.push("shared lock");
	}
	if (ownerStat && !retirePortableTempMetadata(ownerPath, ownerStat)) {
		releaseFailures.push("owner file");
	}
	if (releaseFailures.length > 0) {
		const releaseMessage = `could not release the ledger ${releaseFailures.join(
			" and ",
		)} safely; inspect ${lockPath}`;
		throw new Error(
			actionFailure ? `${actionFailure.message}; additionally, ${releaseMessage}` : releaseMessage,
			actionFailure ? { cause: actionFailure } : undefined,
		);
	}
	if (actionFailure) throw actionFailure;
	return result;
}

export function sameTaskBoundary(expected, current) {
	if (expected.state !== current.state) return false;
	if (expected.state === "legacy" || expected.state === "idle") return true;
	return expected.state === "active" && current.task.id === expected.task.id;
}

export function withCapturedLedgerIdentity(
	cwd,
	{ expectedBranch, expectedTaskState, subject, retry = "stdd review" },
	action,
) {
	return withLedgerLock(cwd, () => {
		const branch = currentBranch(cwd);
		if (branch !== expectedBranch) {
			throw new Error(
				`the checkout switched branches before the ${subject} was recorded — nothing recorded; ` +
					`rerun \`${retry}\` on ${expectedBranch}`,
			);
		}
		const currentTaskState = deriveTaskState(rawLedger(cwd, expectedBranch));
		if (!sameTaskBoundary(expectedTaskState, currentTaskState)) {
			throw new Error(
				`the active task changed before the ${subject} was recorded — nothing recorded; ` +
					`rerun \`${retry}\` for the current task`,
			);
		}
		return action();
	});
}

function jsonlRecordSeparator(byteLength, finalByte) {
	return byteLength > 0 && finalByte !== LF_BYTE ? "\n" : "";
}

export function ledgerFileRecordSeparator(ledgerPath) {
	let fd;
	try {
		fd = fs.openSync(ledgerPath, "r");
	} catch (err) {
		if (err.code === "ENOENT") return "";
		throw err;
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size === 0) return "";
		const finalByte = Buffer.allocUnsafe(1);
		if (fs.readSync(fd, finalByte, 0, 1, size - 1) !== 1) {
			throw new Error("could not read the final ledger byte before appending");
		}
		return jsonlRecordSeparator(size, finalByte[0]);
	} finally {
		fs.closeSync(fd);
	}
}

export function appendLedger(
	cwd,
	event,
	{
		allowHistoricalTask = false,
		allowBranchScopedHistorical = false,
		preserveTaskScope = false,
		lockHeld = false,
		expectedBranch = null,
	} = {},
) {
	const write = () => {
		const { branch, taskState, task } = inspectLedgerAppendContext(cwd, event, {
			allowHistoricalTask,
			allowBranchScopedHistorical,
		});
		if (expectedBranch !== null && branch !== expectedBranch) {
			throw new Error(
				`the checkout switched branches before ${event.event} was recorded — nothing recorded; ` +
					`retry on ${expectedBranch}`,
			);
		}
		const recordedBranch = expectedBranch ?? branch;
		if (taskState.state === "legacy" && event.event !== "task-start") {
			fs.writeSync(
				process.stderr.fd,
				'stdd: no active task; recording branch-scoped legacy evidence — run `stdd task start "<short name>"`\n',
			);
		}
		const record = JSON.stringify({
			ts: new Date().toISOString(),
			...(task && !event.taskId && !preserveTaskScope ? { taskId: task.id } : {}),
			...event,
			...(taskState.state === "legacy" && LEGACY_RECORDER_EVENTS.has(event.event)
				? { legacyFlow: LEGACY_FLOW_MARKER }
				: {}),
			branch: recordedBranch,
		});
		if (activeLedgerMutation === null || activeLedgerMutation.cwd !== cwd) {
			throw new Error("ledger append escaped its native mutation session");
		}
		if (activeLedgerMutation.committed) {
			throw new Error("ledger append cannot run after the native mutation committed");
		}
		if (
			activeLedgerMutation.expectedBranch !== null &&
			activeLedgerMutation.expectedBranch !== recordedBranch
		) {
			throw new Error("one ledger mutation cannot publish records for multiple branches");
		}
		activeLedgerMutation.expectedBranch = recordedBranch;
		activeLedgerMutation.records.push(record);
	};
	try {
		if (lockHeld) write();
		else withLedgerLock(cwd, write);
	} catch (err) {
		if (lockHeld) throw err;
		fail(err.message);
	}
}

function enqueueLedgerTransaction(cwd, events, expectedBranch, subject, checkBranch = true) {
	if (activeLedgerMutation === null || activeLedgerMutation.cwd !== cwd) {
		throw new Error(`${subject} escaped its native mutation session`);
	}
	if (activeLedgerMutation.committed) {
		throw new Error(`${subject} cannot append after the ledger mutation committed`);
	}
	if (
		activeLedgerMutation.expectedBranch !== null &&
		activeLedgerMutation.expectedBranch !== expectedBranch
	) {
		throw new Error("one ledger mutation cannot publish records for multiple branches");
	}
	activeLedgerMutation.expectedBranch = expectedBranch;
	activeLedgerMutation.checkBranch = activeLedgerMutation.checkBranch && checkBranch;
	for (const event of events) {
		activeLedgerMutation.records.push(
			JSON.stringify({ ts: new Date().toISOString(), ...event, branch: expectedBranch }),
		);
	}
}

function appendLedgerTransaction(cwd, events, expectedBranch) {
	if (currentBranch(cwd) !== expectedBranch) {
		throw new Error(
			`the checkout switched branches before the task reset was recorded — nothing recorded; retry on ${expectedBranch}`,
		);
	}
	enqueueLedgerTransaction(cwd, events, expectedBranch, "ledger reset");
}

/** Queue one provenance-captured terminal event while the caller holds the ledger lock. */
export function appendCapturedLedgerEvent(cwd, event, expectedBranch) {
	enqueueLedgerTransaction(cwd, [event], expectedBranch, event.event, false);
}

/** Commit the queued records before a later side effect runs under the same lock. */
export function commitActiveLedgerMutation(cwd) {
	if (activeLedgerMutation === null || activeLedgerMutation.cwd !== cwd) {
		throw new Error("ledger commit escaped its native mutation session");
	}
	if (activeLedgerMutation.committed) throw new Error("ledger mutation was already committed");
	runNativeLedgerMutation(
		cwd,
		activeLedgerMutation.records,
		activeLedgerMutation.expectedBranch,
		activeLedgerMutation.checkBranch,
	);
	activeLedgerMutation.committed = true;
}

// --- the task lifecycle, the durable plan, and deferred cuts ---

/** Current task's ledger events. Branch-only history remains a legacy scope. */
export function loadLedger(cwd, branch, config = loadConfig(cwd)) {
	return scopeLedgerForCheckout(cwd, branch, rawLedger(cwd, branch), config).events;
}

function planHash(cwd) {
	const planPath = statePath(cwd, PLAN_REL, "plan path");
	return fs.existsSync(planPath) ? sha256(fs.readFileSync(planPath)) : null;
}

export function taskPlanContent(cwd, taskState, planPath = statePath(cwd, PLAN_REL, "plan path")) {
	if (!fs.existsSync(planPath) || taskState.state === "idle" || taskState.state === "invalid") {
		return null;
	}
	const content = fs.readFileSync(planPath, "utf8");
	if (
		taskState.state === "active" &&
		taskState.task.planBaseline !== null &&
		taskState.task.planBaseline === sha256(content)
	) {
		return null;
	}
	return content;
}

/**
 * Return the plan that belongs to the current task. A plan left unchanged
 * across `task start` is historical context, not the new task's contract.
 * Branch-only ledgers retain their legacy behavior.
 */
export function currentTaskPlan(cwd) {
	const planPath = statePath(cwd, PLAN_REL, "plan path");
	if (!fs.existsSync(planPath)) return null;
	const branch = currentBranch(cwd);
	if (!branch) return fs.readFileSync(planPath, "utf8");
	const taskState = scopeLedgerForCheckout(cwd, branch).state;
	return taskPlanContent(cwd, taskState, planPath);
}

function normalizeTaskName(name) {
	try {
		return assertPrintableSingleLine(name, "task name").trim();
	} catch {
		if (typeof name !== "string" || name.trim() === "") {
			fail('task start needs a short name, e.g. `stdd task start "add invoices"`');
		}
		fail("task name must be a non-empty single printable line without control characters");
	}
}

function taskTransition(cwd, action) {
	try {
		return withLedgerLock(cwd, () => {
			const branch = currentBranch(cwd);
			if (!branch) {
				throw new Error("the ledger needs a git repository with at least one commit");
			}
			return action(branch);
		});
	} catch (err) {
		// This synchronous API may have just waited on the native subprocess;
		// write the terminal diagnostic synchronously before exiting as well.
		fs.writeSync(process.stderr.fd, `stdd: ${err.message}\n`);
		process.exit(1);
	}
}

export function startTask(cwd, name) {
	const taskName = normalizeTaskName(name);
	const started = taskTransition(cwd, (branch) => {
		const taskState = taskLifecycleState(rawLedger(cwd, branch));
		if (taskState.state === "active") {
			throw new Error(
				`task ${taskState.task.id} (${taskState.task.name}) is already active — ` +
					"finish it, reset it, or continue it",
			);
		}
		const id = `task-${randomBytes(6).toString("hex")}`;
		appendLedger(
			cwd,
			{
				event: "task-start",
				id,
				name: taskName,
				planBaseline: planHash(cwd),
			},
			{ lockHeld: true, expectedBranch: branch },
		);
		return { branch, id };
	});
	fs.writeSync(
		process.stdout.fd,
		`stdd task: started ${started.id} (${taskName}) on ${started.branch}\n`,
	);
}

export function finishTask(cwd) {
	const active = taskTransition(cwd, (branch) => {
		const taskState = taskLifecycleState(rawLedger(cwd, branch));
		if (taskState.state !== "active") {
			throw new Error('no active task — run `stdd task start "<name>"`');
		}
		const task = taskState.task;
		appendLedger(
			cwd,
			{ event: "task-finish", taskId: task.id },
			{ lockHeld: true, expectedBranch: branch },
		);
		return task;
	});
	fs.writeSync(
		process.stdout.fd,
		`stdd task: finished ${active.id} (${active.name}); evidence remains in the ledger\n`,
	);
}

export function resetTask(cwd, name = null) {
	const requestedName = name === null ? null : normalizeTaskName(name);
	const reset = taskTransition(cwd, (branch) => {
		const taskState = taskLifecycleState(rawLedger(cwd, branch));
		if (taskState.state !== "active") {
			throw new Error('no active task — run `stdd task start "<name>"`');
		}
		const active = taskState.task;
		const nextName = requestedName ?? active.name;
		const id = `task-${randomBytes(6).toString("hex")}`;
		const planBaseline = planHash(cwd);
		appendLedgerTransaction(
			cwd,
			[
				{ event: "task-reset", taskId: active.id },
				{
					event: "task-start",
					id,
					name: nextName,
					planBaseline,
				},
			],
			branch,
		);
		return { branch, id, nextName };
	});
	fs.writeSync(
		process.stdout.fd,
		`stdd task: reset to ${reset.id} (${reset.nextName}) on ${reset.branch}\n`,
	);
}

/**
 * `stdd defer <text>` — record a scope cut under the plan's `## Deferred`
 * section (see method: "The durable plan and stdd defer"). Creates the
 * plan file and the section as needed; never mutates git or appends to the ledger.
 */
export function defer(cwd, text) {
	try {
		assertPrintableSingleLine(text, "deferred cut");
	} catch {
		fail("deferred cut must be a non-empty single printable line without control characters");
	}
	// Resolve the mutation target before consulting lifecycle state. This is
	// read-only, but ensures an unsafe plan symlink is diagnosed as the target
	// violation even when the ledger is independently unsafe.
	const planPath = statePath(cwd, PLAN_REL, "plan path");
	const deferContext = ledgerAppendContext(cwd, { event: "defer" });
	if (!deferContext.task) {
		fail('no active task — run `stdd task start "<short name>"` before recording a scope cut');
	}
	const existed = fs.existsSync(planPath);
	let content = "";
	if (existed) {
		const fd = fs.openSync(planPath, "r");
		try {
			content = fs.readFileSync(fd, "utf8");
		} finally {
			fs.closeSync(fd);
		}
	}
	const nextContent = appendDeferred(content, text);
	try {
		withCapturedLedgerIdentity(
			cwd,
			{
				expectedBranch: deferContext.branch,
				expectedTaskState: deferContext.taskState,
				subject: "deferred plan cut",
				retry: "stdd defer",
			},
			() => {
				const stillExists = fs.existsSync(planPath);
				const current = stillExists ? fs.readFileSync(planPath, "utf8") : "";
				if (stillExists !== existed || current !== content) {
					throw new Error(
						"the plan changed before the deferred cut was recorded — nothing recorded; " +
							"rerun `stdd defer` for the current task",
					);
				}
				// Recovery/helper preflight must settle before the non-ledger plan
				// side effect; this lock action intentionally queues no records.
				commitActiveLedgerMutation(cwd);
				fs.mkdirSync(path.dirname(planPath), { recursive: true });
				fs.writeFileSync(planPath, nextContent);
			},
		);
	} catch (err) {
		fail(err.message);
	}
	fs.writeSync(
		process.stdout.fd,
		`stdd defer: recorded under ${PLAN_REL} — carry it into the PR description's out-of-scope\n`,
	);
}
