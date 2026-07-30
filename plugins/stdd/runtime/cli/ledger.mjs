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
import {
	sameFileIdentity,
	samePublicationObservation,
	samePublicationPayload,
} from "../sdk/held-publication.mjs";
import { assertPrintableSingleLine, isPrintableSingleLine } from "../sdk/text.mjs";
import { deriveTaskState, scopeTaskEvents } from "../sdk/workflow.mjs";
import { loadConfig } from "./config.mjs";
import { openHeldLinuxRepoDirectory } from "./held-fs.mjs";
import { appendDeferred, deriveReviewVerdict, parseReviewResult, sha256 } from "./lib.mjs";
import { splitNul } from "./path-bytes.mjs";
import { fail, git, MAX_SUBPROCESS_BUFFER, statePath } from "./runtime.mjs";
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
	/^\.stdd\/\.(?:ledger-reset|ledger-prepared|ledger-recovered|ledger-aborted)-[0-9a-f]{32}\.tmp$/;
const LF_BYTE = 0x0a;
const LEGACY_FLOW_MARKER = "taskless-v1";
const LEGACY_RECORDER_EVENTS = new Set(["docs", "red", "verify", "note"]);
const LEDGER_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LEDGER_PARTIAL_LOCK_GRACE_MS = 1_000;
export const REVIEW_VIAS = ["subagent", "codex", "claude"];
export const DOCS_DECISIONS = ["updated-first", "checked", "not-applicable"];
export const LABEL_TO_DECISION = {
	"Docs updated first": "updated-first",
	"Docs checked, no change needed": "checked",
	"Docs not applicable": "not-applicable",
};

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

export function isTrustedLedgerInternalTemp(cwd, file) {
	if (!LEDGER_INTERNAL_TEMP_RELATIVE.test(file)) return false;
	try {
		const observed = fs.lstatSync(path.join(cwd, file));
		const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
		return (
			observed.isFile() &&
			!observed.isSymbolicLink() &&
			observed.nlink === 1 &&
			(observed.mode & 0o777) === 0o600 &&
			(currentUid === null || observed.uid === currentUid)
		);
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

function lstatIfPresent(filePath) {
	try {
		return fs.lstatSync(filePath);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

function retireHeldRepoTransactionTemp(
	heldDirectory,
	sourceName,
	observed,
	{ prefix = ".ledger-recovered" } = {},
) {
	const heldSource = path.join(heldDirectory.heldPath, sourceName);
	let quarantinePath = null;
	let moved = false;
	try {
		const parentOpened = fs.fstatSync(heldDirectory.descriptor);
		if (!sameFileIdentity(heldDirectory.identity, parentOpened)) {
			throw new Error("repository transaction parent changed after it was held");
		}
		const current = fs.lstatSync(heldSource);
		if (!sameFileIdentity(current, observed)) {
			throw new Error("repository transaction temp changed before retirement");
		}
		quarantinePath = path.join(
			heldDirectory.heldPath,
			`${prefix}-${randomBytes(16).toString("hex")}.tmp`,
		);
		fs.renameSync(heldSource, quarantinePath);
		moved = true;
		const movedObserved = fs.lstatSync(quarantinePath);
		const parentHeldAfter = fs.fstatSync(heldDirectory.descriptor);
		if (!sameFileIdentity(current, movedObserved) || !sameFileIdentity(parentOpened, parentHeldAfter)) {
			throw new Error("repository transaction temp changed during held-parent retirement");
		}
		const logicalParentAfter = fs.lstatSync(heldDirectory.logicalPath);
		if (
			logicalParentAfter.isSymbolicLink() ||
			!logicalParentAfter.isDirectory() ||
			!sameFileIdentity(parentOpened, logicalParentAfter)
		) {
			// The rename was still confined to the held directory. Restore the
			// non-authoritative temp only when its old name is still absent.
			const sourceAfter = lstatIfPresent(heldSource);
			const quarantineAfter = lstatIfPresent(quarantinePath);
			if (sourceAfter === null && quarantineAfter && sameFileIdentity(current, quarantineAfter)) {
				fs.renameSync(quarantinePath, heldSource);
				const restored = fs.lstatSync(heldSource);
				if (!sameFileIdentity(current, restored)) {
					throw new Error("repository transaction temp changed while restoring held evidence");
				}
				quarantinePath = null;
				moved = false;
			}
			throw new Error(
				"repository transaction parent changed during held-parent retirement; no outside path was modified",
			);
		}
		quarantinePath = null;
		return { retired: true };
	} catch (err) {
		if (moved && quarantinePath !== null) {
			try {
				const sourceAfter = lstatIfPresent(heldSource);
				const quarantineAfter = lstatIfPresent(quarantinePath);
				if (
					sourceAfter === null &&
					quarantineAfter &&
					sameFileIdentity(observed, quarantineAfter) &&
					sameFileIdentity(heldDirectory.identity, fs.fstatSync(heldDirectory.descriptor))
				) {
					fs.renameSync(quarantinePath, heldSource);
				}
			} catch {}
		}
		return {
			retired: false,
			reason: `${err.message}; the repository transaction temp was preserved for inspection`,
		};
	}
}

function retireRepoTransactionTemp(filePath, observed, options = {}) {
	if (process.platform !== "linux") {
		return {
			retired: false,
			reason:
				"safe repository transaction-temp retirement needs Linux held-parent support; the file was preserved",
		};
	}
	let heldDirectory = null;
	try {
		heldDirectory = openHeldLinuxRepoDirectory(
			path.dirname(path.dirname(filePath)),
			".stdd",
			"repository transaction parent",
		);
		return retireHeldRepoTransactionTemp(heldDirectory, path.basename(filePath), observed, options);
	} catch (err) {
		return {
			retired: false,
			reason: `${err.message}; the repository transaction temp was preserved for inspection`,
		};
	} finally {
		if (heldDirectory !== null) {
			try {
				fs.closeSync(heldDirectory.descriptor);
			} catch {}
		}
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

/**
 * Remove only transaction temps that this CLI could have created. Recovery
 * runs after acquiring the ledger lock, so no live reset can own a matching
 * file. Anything with the internal name but without the exact private-file
 * shape is left untouched and blocks ledger mutation for manual inspection.
 */
function recoverLedgerResetTemps(cwd) {
	const ledgerPath = statePath(cwd, LEDGER_REL, "ledger path");
	const ledgerDir = path.dirname(ledgerPath);
	if (!fs.existsSync(ledgerDir)) return;
	const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
	let heldDirectory = null;
	let recoveryDir = ledgerDir;
	let activeNames;
	if (process.platform === "linux") {
		try {
			heldDirectory = openHeldLinuxRepoDirectory(cwd, ".stdd", "repository transaction parent");
		} catch (err) {
			if (!err.stddHeldNamespaceUnavailable) throw err;
			const names = fs.readdirSync(ledgerDir).filter((name) => LEDGER_ACTIVE_TEMP_BASENAME.test(name));
			if (names.length === 0) return;
			throw new Error(
				`${err.message}; safe ledger transaction recovery requires a held repository namespace, so every temp was preserved`,
			);
		}
		recoveryDir = heldDirectory.heldPath;
	}
	try {
		activeNames = fs
			.readdirSync(recoveryDir)
			.filter((candidate) => LEDGER_ACTIVE_TEMP_BASENAME.test(candidate))
			.sort();
		for (const name of activeNames) {
			const relative = `.stdd/${name}`;
			const tempPath = path.join(recoveryDir, name);
			let observed;
			try {
				observed = fs.lstatSync(tempPath);
			} catch (err) {
				if (err.code === "ENOENT") continue;
				throw err;
			}
			const safe =
				observed.isFile() &&
				!observed.isSymbolicLink() &&
				observed.nlink === 1 &&
				(observed.mode & 0o777) === 0o600 &&
				(currentUid === null || observed.uid === currentUid);
			if (!safe) {
				throw new Error(
					`unsafe ledger transaction temporary file ${JSON.stringify(relative)} — ` +
						"expected a regular owner-only (0600) file owned by the current user; remove it manually",
				);
			}
			const retirement =
				heldDirectory === null
					? retireRepoTransactionTemp(tempPath, observed, { prefix: ".ledger-recovered" })
					: retireHeldRepoTransactionTemp(heldDirectory, name, observed, {
							prefix: ".ledger-recovered",
						});
			if (!retirement.retired) {
				throw new Error(
					`ledger transaction temporary file ${JSON.stringify(relative)} changed during recovery; ` +
						`nothing recorded — ${retirement.reason}`,
				);
			}
		}
	} finally {
		if (heldDirectory !== null) {
			try {
				fs.closeSync(heldDirectory.descriptor);
			} catch {}
		}
	}
}

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
		recoverLedgerResetTemps(cwd);
		result = action();
	} catch (err) {
		actionFailure = err;
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
	const ledgerPath = statePath(cwd, LEDGER_REL, "ledger path");
	fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
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
			console.error(
				'stdd: no active task; recording branch-scoped legacy evidence — run `stdd task start "<short name>"`',
			);
		}
		const separator = ledgerFileRecordSeparator(ledgerPath);
		fs.appendFileSync(
			ledgerPath,
			`${separator}${JSON.stringify({
				ts: new Date().toISOString(),
				...(task && !event.taskId && !preserveTaskScope ? { taskId: task.id } : {}),
				...event,
				...(taskState.state === "legacy" && LEGACY_RECORDER_EVENTS.has(event.event)
					? { legacyFlow: LEGACY_FLOW_MARKER }
					: {}),
				branch: recordedBranch,
			})}\n`,
		);
	};
	try {
		if (lockHeld) write();
		else withLedgerLock(cwd, write);
	} catch (err) {
		if (lockHeld) throw err;
		fail(err.message);
	}
}

function writeAllSync(fd, data) {
	const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
	let offset = 0;
	while (offset < buffer.length) {
		const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
		if (written <= 0) throw new Error("could not complete the ledger transaction write");
		offset += written;
	}
}

/**
 * Publish adjacent ledger records as one copy-on-write transaction. The caller
 * holds the ledger lock and prepares every fallible input before entering. A
 * failed/partial temp write or process interruption leaves ledger.jsonl
 * untouched; rename is the only commit point.
 */
function readHeldLedger(heldDirectory) {
	const heldLedger = path.join(heldDirectory.heldPath, "ledger.jsonl");
	let descriptor = null;
	try {
		descriptor = fs.openSync(heldLedger, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (err) {
		if (err.code === "ENOENT") {
			return { existed: false, content: Buffer.alloc(0), mode: 0o600, identity: null };
		}
		throw err;
	}
	try {
		const opened = fs.fstatSync(descriptor);
		const named = fs.lstatSync(heldLedger);
		const parent = fs.fstatSync(heldDirectory.descriptor);
		if (
			opened.isSymbolicLink() ||
			!opened.isFile() ||
			named.isSymbolicLink() ||
			!named.isFile() ||
			!sameFileIdentity(opened, named) ||
			!sameFileIdentity(heldDirectory.identity, parent)
		) {
			throw new Error("ledger changed while it was opened through the captured ledger parent");
		}
		const content = fs.readFileSync(descriptor);
		const afterRead = fs.fstatSync(descriptor);
		const afterNamed = fs.lstatSync(heldLedger);
		if (
			!samePublicationObservation(opened, afterRead) ||
			!samePublicationObservation(afterRead, afterNamed)
		) {
			throw new Error("ledger changed while its transaction snapshot was read");
		}
		return {
			existed: true,
			content,
			mode: opened.mode & 0o777,
			identity: afterRead,
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

function validateHeldLedgerCommit(
	heldDirectory,
	ledgerPath,
	tempDescriptor,
	tempIdentity,
	{ bindDescriptor = true } = {},
) {
	const heldLedger = path.join(heldDirectory.heldPath, "ledger.jsonl");
	const heldPublished = fs.lstatSync(heldLedger);
	const published = bindDescriptor ? fs.fstatSync(tempDescriptor) : heldPublished;
	const heldParent = fs.fstatSync(heldDirectory.descriptor);
	if (
		published.isSymbolicLink() ||
		!published.isFile() ||
		heldPublished.isSymbolicLink() ||
		!heldPublished.isFile() ||
		!samePublicationPayload(tempIdentity, published) ||
		!samePublicationObservation(published, heldPublished) ||
		!sameFileIdentity(heldDirectory.identity, heldParent)
	) {
		throw new Error("ledger transaction temporary file was replaced at commit");
	}
	const logicalParent = fs.lstatSync(heldDirectory.logicalPath);
	const logicalPublished = fs.lstatSync(ledgerPath);
	if (
		logicalParent.isSymbolicLink() ||
		!logicalParent.isDirectory() ||
		!sameFileIdentity(heldDirectory.identity, logicalParent) ||
		!samePublicationObservation(heldPublished, logicalPublished)
	) {
		throw new Error(
			"ledger directory changed during commit; the final rename stayed inside the captured ledger parent",
		);
	}
	return heldPublished;
}

function validateHeldOriginalLedger(heldDirectory, originalLedger) {
	const heldLedger = path.join(heldDirectory.heldPath, "ledger.jsonl");
	const current = lstatIfPresent(heldLedger);
	const unchanged = originalLedger.existed
		? current !== null &&
			!current.isSymbolicLink() &&
			current.isFile() &&
			samePublicationObservation(originalLedger.identity, current)
		: current === null;
	if (!unchanged || !sameFileIdentity(heldDirectory.identity, fs.fstatSync(heldDirectory.descriptor))) {
		throw new Error(
			"ledger changed after its transaction snapshot; the prepared reset was not committed",
		);
	}
}

function restoreHeldLedgerAfterRejectedCommit(
	heldDirectory,
	tempIdentity,
	original,
	originalMode,
	ledgerExisted,
) {
	const heldLedger = path.join(heldDirectory.heldPath, "ledger.jsonl");
	const rejectedPath = path.join(
		heldDirectory.heldPath,
		`.ledger-rejected-${randomBytes(16).toString("hex")}.tmp`,
	);
	let restoreDescriptor = null;
	let restorePath = null;
	try {
		const current = fs.lstatSync(heldLedger);
		if (!samePublicationObservation(tempIdentity, current)) {
			throw new Error("committed transaction inode changed before held-parent settlement");
		}
		let restoreIdentity = null;
		if (ledgerExisted) {
			restorePath = path.join(
				heldDirectory.heldPath,
				`.ledger-aborted-${randomBytes(16).toString("hex")}.tmp`,
			);
			restoreDescriptor = fs.openSync(restorePath, "wx", 0o600);
			fs.fchmodSync(restoreDescriptor, originalMode);
			writeAllSync(restoreDescriptor, original);
			fs.fsyncSync(restoreDescriptor);
			restoreIdentity = fs.fstatSync(restoreDescriptor);
			const restoreNamed = fs.lstatSync(restorePath);
			if (!samePublicationObservation(restoreIdentity, restoreNamed)) {
				throw new Error("ledger restoration temp changed before held-parent settlement");
			}
		}
		fs.renameSync(heldLedger, rejectedPath);
		const rejected = fs.lstatSync(rejectedPath);
		if (!samePublicationPayload(tempIdentity, rejected)) {
			throw new Error("rejected ledger changed during held-parent settlement");
		}
		if (ledgerExisted) {
			fs.renameSync(restorePath, heldLedger);
			restorePath = null;
			const restored = fs.lstatSync(heldLedger);
			if (!samePublicationPayload(restoreIdentity, restored)) {
				throw new Error("original ledger changed during held-parent restoration");
			}
		}
		fs.fsyncSync(heldDirectory.descriptor);
		return { settled: true };
	} catch (err) {
		return {
			settled: false,
			reason: `${err.message}; held-parent evidence was preserved for inspection`,
		};
	} finally {
		if (restoreDescriptor !== null) {
			try {
				fs.closeSync(restoreDescriptor);
			} catch {}
		}
	}
}

function appendLedgerTransactionHeld(cwd, events, expectedBranch, heldDirectory) {
	const ledgerPath = statePath(cwd, LEDGER_REL, "ledger path");
	const assertBranch = () => {
		if (currentBranch(cwd) !== expectedBranch) {
			throw new Error(
				`the checkout switched branches before the task reset was recorded — nothing recorded; ` +
					`retry on ${expectedBranch}`,
			);
		}
	};
	assertBranch();

	const originalLedger = readHeldLedger(heldDirectory);
	const original = originalLedger.content;
	const separator = jsonlRecordSeparator(original.length, original.at(-1));
	const transaction = events.map(
		(event) =>
			`${JSON.stringify({
				ts: new Date().toISOString(),
				...event,
				branch: expectedBranch,
			})}\n`,
	);
	const tempName = `.ledger-reset-${randomBytes(16).toString("hex")}.tmp`;
	const preparedName = `.ledger-prepared-${randomBytes(16).toString("hex")}.tmp`;
	const heldTemp = path.join(heldDirectory.heldPath, tempName);
	const heldPrepared = path.join(heldDirectory.heldPath, preparedName);
	const heldLedger = path.join(heldDirectory.heldPath, "ledger.jsonl");
	let descriptor = null;
	let tempIdentity = null;
	let activeName = tempName;
	let finalRenameCompleted = false;
	let committed = false;
	let transactionFailure = null;
	let settlementFailure = null;
	try {
		descriptor = fs.openSync(heldTemp, "wx", 0o600);
		writeAllSync(descriptor, original);
		writeAllSync(descriptor, separator);
		for (const record of transaction) writeAllSync(descriptor, record);
		fs.fsyncSync(descriptor);
		tempIdentity = fs.fstatSync(descriptor);
		assertBranch();
		const beforeRename = fs.lstatSync(heldTemp);
		const parentBeforeRename = fs.fstatSync(heldDirectory.descriptor);
		if (
			beforeRename.isSymbolicLink() ||
			!beforeRename.isFile() ||
			!samePublicationObservation(tempIdentity, beforeRename) ||
			!sameFileIdentity(heldDirectory.identity, parentBeforeRename)
		) {
			throw new Error("ledger transaction temporary file changed before commit");
		}
		fs.renameSync(heldTemp, heldPrepared);
		activeName = preparedName;
		const prepared = fs.lstatSync(heldPrepared);
		const preparedDescriptor = fs.fstatSync(descriptor);
		if (
			prepared.isSymbolicLink() ||
			!prepared.isFile() ||
			!samePublicationPayload(tempIdentity, preparedDescriptor) ||
			!samePublicationObservation(preparedDescriptor, prepared)
		) {
			throw new Error("ledger transaction temporary file was replaced before commit");
		}
		tempIdentity = preparedDescriptor;
		assertBranch();
		validateHeldOriginalLedger(heldDirectory, originalLedger);
		fs.renameSync(heldPrepared, heldLedger);
		activeName = "ledger.jsonl";
		finalRenameCompleted = true;
		fs.fsyncSync(heldDirectory.descriptor);
		const committedDescriptor = fs.fstatSync(descriptor);
		if (!samePublicationPayload(tempIdentity, committedDescriptor)) {
			throw new Error("ledger transaction temporary file was replaced at commit");
		}
		tempIdentity = committedDescriptor;
		validateHeldLedgerCommit(heldDirectory, ledgerPath, descriptor, tempIdentity);
		fs.closeSync(descriptor);
		descriptor = null;
		validateHeldLedgerCommit(heldDirectory, ledgerPath, null, tempIdentity, {
			bindDescriptor: false,
		});
		committed = true;
	} catch (err) {
		transactionFailure = err;
	} finally {
		if (descriptor !== null) {
			try {
				if (tempIdentity !== null) {
					const named =
						activeName === "ledger.jsonl"
							? lstatIfPresent(heldLedger)
							: lstatIfPresent(path.join(heldDirectory.heldPath, activeName));
					if (named && sameFileIdentity(tempIdentity, named)) fs.fstatSync(descriptor);
				}
				fs.closeSync(descriptor);
			} catch {}
		}
		if (!committed && tempIdentity !== null) {
			if (finalRenameCompleted) {
				const settlement = restoreHeldLedgerAfterRejectedCommit(
					heldDirectory,
					tempIdentity,
					original,
					originalLedger.mode,
					originalLedger.existed,
				);
				if (!settlement.settled) settlementFailure = settlement.reason;
			} else {
				const retirement = retireHeldRepoTransactionTemp(heldDirectory, activeName, tempIdentity, {
					prefix: ".ledger-aborted",
				});
				if (!retirement.retired) settlementFailure = retirement.reason;
			}
		}
	}
	if (settlementFailure) {
		throw new Error(
			`${transactionFailure?.message ?? "ledger transaction failed"}; ` +
				`could not safely retire failed ledger transaction temp or settle its held commit — ` +
				settlementFailure,
		);
	}
	if (transactionFailure) throw transactionFailure;
	return validateHeldLedgerCommit(heldDirectory, ledgerPath, null, tempIdentity, {
		bindDescriptor: false,
	});
}

function appendLedgerTransaction(cwd, events, expectedBranch) {
	if (process.platform !== "linux") {
		throw new Error(
			"task reset requires Linux held-parent support; nothing recorded and no transaction temp was created",
		);
	}
	const ledgerPath = statePath(cwd, LEDGER_REL, "ledger path");
	const ledgerDir = path.dirname(ledgerPath);
	fs.mkdirSync(ledgerDir, { recursive: true });
	let heldDirectory;
	try {
		heldDirectory = openHeldLinuxRepoDirectory(cwd, ".stdd", "ledger directory");
	} catch (err) {
		if (err.stddHeldNamespaceUnavailable) {
			throw new Error(
				`${err.message}; task reset requires a held repository namespace, so nothing was recorded and no transaction temp was created`,
			);
		}
		throw err;
	}
	let committedIdentity = null;
	let transactionFailure = null;
	try {
		committedIdentity = appendLedgerTransactionHeld(cwd, events, expectedBranch, heldDirectory);
	} catch (err) {
		transactionFailure = err;
	}
	const parentBeforeClose = fs.fstatSync(heldDirectory.descriptor);
	if (!sameFileIdentity(heldDirectory.identity, parentBeforeClose) && transactionFailure === null) {
		transactionFailure = new Error("captured ledger parent changed before descriptor close");
	}
	fs.closeSync(heldDirectory.descriptor);
	if (transactionFailure) throw transactionFailure;
	const logicalParentAfterClose = fs.lstatSync(heldDirectory.logicalPath);
	const logicalLedgerAfterClose = fs.lstatSync(ledgerPath);
	if (
		logicalParentAfterClose.isSymbolicLink() ||
		!logicalParentAfterClose.isDirectory() ||
		!sameFileIdentity(heldDirectory.identity, logicalParentAfterClose) ||
		!samePublicationObservation(committedIdentity, logicalLedgerAfterClose)
	) {
		throw new Error(
			"ledger directory changed around captured-parent descriptor close; commit evidence was preserved",
		);
	}
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
		fail(err.message);
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
	console.log(`stdd task: started ${started.id} (${taskName}) on ${started.branch}`);
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
	console.log(`stdd task: finished ${active.id} (${active.name}); evidence remains in the ledger`);
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
	console.log(`stdd task: reset to ${reset.id} (${reset.nextName}) on ${reset.branch}`);
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
				fs.mkdirSync(path.dirname(planPath), { recursive: true });
				fs.writeFileSync(planPath, nextContent);
			},
		);
	} catch (err) {
		fail(err.message);
	}
	console.log(
		`stdd defer: recorded under ${PLAN_REL} — carry it into the PR description's out-of-scope`,
	);
}
