// --- declared scope: validation, glob classification, and postflight ---
//
// Owns the scope contract shared by delegated slices and managed workers: what
// a legal --frozen/--allowed declaration is, how a path is classified against
// it, plus scope declaration (`stdd slice new`) and postflight (`stdd scope`).
// It has no dependency on the entry module.
import { execFileSync } from "node:child_process";
import { assertPrintableSingleLine } from "../sdk/text.mjs";
import {
	appendLedger,
	isStateExemptPath,
	ledgerAppendContext,
	loadLedger,
	requireBranch,
	withCapturedLedgerIdentity,
} from "./ledger.mjs";
import { latinGlob, pathForMatch, splitNul, viewPath } from "./path-bytes.mjs";
import { fail, MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { dirtySnapshot, workerDirtySnapshot } from "./snapshot.mjs";
import { workerPathForMatch, workerViewPath } from "./worker-fs.mjs";
import { readWorkerMetadata } from "./worker-metadata.mjs";

export function validateScopeDeclaration(subject, frozenPaths, allowedPaths) {
	if (frozenPaths.length === 0 && allowedPaths.length === 0) {
		fail(`${subject} needs a scope — pass --frozen <globs> and/or --allowed <globs>`);
	}
	for (const [label, globs] of [
		["--frozen", frozenPaths],
		["--allowed", allowedPaths],
	]) {
		for (const glob of globs) {
			try {
				assertPrintableSingleLine(glob, `${label} glob`);
			} catch {
				fail(
					`${label} glob must be a non-empty single printable line without control or invisible characters`,
				);
			}
		}
	}
}

function classifyScopePath(frozen, allowed, comparable) {
	if (frozen.some((pattern) => pattern.test(comparable))) return "frozen";
	if (allowed.length > 0 && !allowed.some((pattern) => pattern.test(comparable))) {
		return "outside-allowed";
	}
	return null;
}

export function workerScopeViolations(scope, relativePaths) {
	const frozen = scope.frozenPaths.map(latinGlob);
	const allowed = scope.allowedPaths.map(latinGlob);
	return relativePaths.flatMap((relative) => {
		const kind = classifyScopePath(frozen, allowed, workerPathForMatch(relative));
		return kind ? [{ relative, kind }] : [];
	});
}

/**
 * `stdd slice new` — declare a delegated slice's scope and snapshot the
 * checkout baseline (head + dirty-file hashes) into a ledger scope event.
 */
export function sliceNew(cwd, frozenPaths, allowedPaths) {
	validateScopeDeclaration("slice new", frozenPaths, allowedPaths);
	const sliceContext = ledgerAppendContext(cwd, { event: "scope" });
	const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	const event = {
		event: "scope",
		frozenPaths,
		allowedPaths,
		baseline: { head, dirty: dirtySnapshot(cwd) },
		...(sliceContext.task ? { taskId: sliceContext.task.id } : {}),
	};
	try {
		withCapturedLedgerIdentity(
			cwd,
			{
				expectedBranch: sliceContext.branch,
				expectedTaskState: sliceContext.taskState,
				subject: "slice scope",
				retry: "stdd slice new",
			},
			() =>
				appendLedger(cwd, event, {
					preserveTaskScope: true,
					lockHeld: true,
					expectedBranch: sliceContext.branch,
				}),
		);
	} catch (err) {
		fail(err.message);
	}
	console.log(
		`stdd slice: scope declared (frozen: ${frozenPaths.join(", ") || "—"}; ` +
			`allowed: ${allowedPaths.join(", ") || "—"}) — baseline at ${head.slice(0, 7)}`,
	);
}

/** Check sandbox-local changes against the scope bound in worker metadata. */
function workerScopeCheck(metadata) {
	let dirty;
	try {
		dirty = workerDirtySnapshot(metadata.root, metadata);
	} catch (err) {
		fail(err.message);
	}
	const violations = workerScopeViolations(metadata.scope, Object.keys(dirty)).map(
		({ relative, kind }) =>
			`${workerViewPath(relative)}: ${kind === "frozen" ? "frozen path modified by this worker" : "outside the allowed paths"}`,
	);
	if (violations.length > 0) {
		console.error(`stdd scope: ${violations.length} violation(s)\n`);
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log(`stdd scope: OK (${Object.keys(dirty).length} worker change(s), all in scope)`);
}

/**
 * `stdd scope` — postflight against the slice baseline, not a ref. Only
 * session-introduced changes count; inherited dirt (already modified at
 * baseline, byte-identical now) is reported separately, never blamed.
 */
export function scopeCheck(cwd) {
	const worker = readWorkerMetadata(cwd);
	if (worker) return workerScopeCheck(worker);
	const branch = requireBranch(cwd);
	const scope = loadLedger(cwd, branch)
		.filter((e) => e.event === "scope")
		.at(-1);
	if (!scope) {
		fail("no slice declared for this branch — run `stdd slice new --frozen/--allowed` first");
	}
	let committed;
	try {
		// -z + raw bytes: keep committed paths byte-exact so they compare and
		// glob-match consistently with the latin1 keys from dirtySnapshot
		committed = splitNul(
			execFileSync("git", ["-C", cwd, "diff", "--name-only", "-z", scope.baseline.head, "HEAD"], {
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: MAX_SUBPROCESS_BUFFER,
			}),
		).map(pathForMatch);
	} catch {
		fail(`baseline commit ${scope.baseline.head.slice(0, 7)} is gone — cannot diff the slice`);
	}
	const introduced = new Set(committed);
	const inherited = [];
	const currentDirty = dirtySnapshot(cwd);
	const baselineDirty = scope.baseline.dirty;
	for (const p of new Set([...Object.keys(baselineDirty), ...Object.keys(currentDirty)])) {
		const baselineHas = Object.hasOwn(baselineDirty, p);
		const currentHas = Object.hasOwn(currentDirty, p);
		if (baselineHas && currentHas && baselineDirty[p] === currentDirty[p]) inherited.push(p);
		else introduced.add(p);
	}
	// stdd's own bookkeeping (the ledger grows during the slice by design;
	// the exact trusted reset temp may exist during recovery) is never in scope.
	// Every other .stdd path is an ordinary deliverable and stays visible.
	for (const p of introduced) {
		if (isStateExemptPath(cwd, p)) introduced.delete(p);
	}
	const frozen = scope.frozenPaths.map(latinGlob);
	const allowed = scope.allowedPaths.map(latinGlob);
	const violations = [];
	for (const p of introduced) {
		const shown = viewPath(p);
		const kind = classifyScopePath(frozen, allowed, p);
		if (kind === "frozen") violations.push(`${shown}: frozen path modified by this slice`);
		else if (kind === "outside-allowed") violations.push(`${shown}: outside the allowed paths`);
	}
	for (const p of inherited) {
		console.log(`inherited dirt (present at baseline, not introduced by this slice): ${viewPath(p)}`);
	}
	if (violations.length > 0) {
		console.error(`stdd scope: ${violations.length} violation(s)\n`);
		for (const v of violations) console.error(`  ${v}`);
		process.exit(1);
	}
	console.log(`stdd scope: OK (${introduced.size} introduced change(s), all in scope)`);
}
