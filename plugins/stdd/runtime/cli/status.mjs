import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoPath, resolveWritableRepoPath } from "../sdk/path.mjs";
import { escapeNonPrintableSingleLine } from "../sdk/text.mjs";
import { deriveLoopState } from "../sdk/workflow.mjs";
import { statusPr } from "./ci.mjs";
import { loadConfig } from "./config.mjs";
import {
	gitChangedPaths,
	gitWorkingPaths,
	isStateExemptPath,
	LEDGER_REL,
	PLAN_REL,
	parseStateLedger,
	rawLedger,
	requireBranch,
	resolveRepoDir,
	scopeLedgerForCheckout,
	taskPlanContent,
} from "./ledger.mjs";
import { DEFAULT_CONFIG, globToRegExp, mergeConfig, parsePlan, planProgress } from "./lib.mjs";
import { reviewRequestAnswered } from "./review.mjs";
import { statePath } from "./runtime.mjs";
import { checkoutSnapshot, reviewSnapshot } from "./snapshot.mjs";

/**
 * `stdd status` — the next-step oracle. Inputs in order of trust: git (diff
 * against the configured baseRef, dirty state), the ledger, then the forge.
 */
export function status(cwd, asJson, localOnly = false) {
	const config = loadConfig(cwd);
	const branch = requireBranch(cwd);
	const allBranchEvents = rawLedger(cwd, branch);
	const scoped = scopeLedgerForCheckout(cwd, branch, allBranchEvents, config);
	const task = scoped.state;
	const events = scoped.events;

	// git: changed files = committed diff vs baseRef + dirty working tree
	let changed = null;
	if (config.baseRef) {
		try {
			changed = [
				...new Set([...gitChangedPaths(cwd, `${config.baseRef}...HEAD`), ...gitWorkingPaths(cwd)]),
			].filter((file) => !isStateExemptPath(cwd, file));
		} catch {
			changed = null; // unresolvable baseRef — report unknown, never error
		}
	}
	const canonical = config.canonicalDocs.map(globToRegExp);
	const docsChanged = (changed ?? []).filter((f) => canonical.some((re) => re.test(f)));
	const nonDocChanged = (changed ?? []).filter((f) => !canonical.some((re) => re.test(f)));
	if (task.state === "invalid") {
		const invalid = {
			state: "invalid",
			task: null,
			branch,
			loop: {
				docs: { done: false },
				red: { done: false },
				impl: { done: false },
				verify: { done: false, stale: false },
			},
			slice: { declared: false },
			plan: { present: false },
			review: null,
			pr: { state: "unknown", reason: "invalid task ledger" },
			next: `repair the malformed task boundary in .stdd/ledger.jsonl: ${task.reason}`,
		};
		if (asJson) console.log(JSON.stringify(invalid, null, "\t"));
		else
			console.log(
				`task:   invalid on ${branch}\nerror:  ${task.reason}\nnext:   repair .stdd/ledger.jsonl before recording evidence`,
			);
		return;
	}
	if (task.state === "idle") {
		const idle = {
			state: "idle",
			task: null,
			branch,
			loop: {
				docs: { done: false },
				red: { done: false },
				impl: { done: false },
				verify: { done: false, stale: false },
			},
			slice: { declared: false },
			plan: { present: false },
			review: null,
			pr: { state: "unknown", reason: "idle task" },
			next: "no task is required for discussion or read-only work",
		};
		if (asJson) console.log(JSON.stringify(idle, null, "\t"));
		else
			console.log(
				`task:   idle on ${branch}\nnext:   no task is required for discussion or read-only work`,
			);
		return;
	}

	const docsEvent = events.filter((e) => e.event === "docs").at(-1) ?? null;
	const checkedPathsExist = (docsEvent?.paths ?? []).every((docPath) => {
		try {
			return fs.existsSync(resolveRepoPath(cwd, docPath, "recorded docs path"));
		} catch {
			return false;
		}
	});
	const docsEventDone =
		docsEvent &&
		(changed === null
			? docsEvent.decision === "not-applicable" || (docsEvent.paths?.length > 0 && checkedPathsExist)
			: docsEvent.decision === "updated-first"
				? docsEvent.paths?.length > 0 &&
					docsEvent.paths.every((docPath) => docsChanged.includes(docPath))
				: docsEvent.decision === "checked"
					? docsChanged.length === 0 && docsEvent.paths?.length > 0 && checkedPathsExist
					: docsEvent.decision === "not-applicable" && docsChanged.length === 0);
	const currentSnapshot = checkoutSnapshot(cwd);
	const {
		redEvent,
		redLegacy,
		verifyEvent,
		recordedVerify,
		verifyStale,
		loop: recordedLoop,
	} = deriveLoopState(events, currentSnapshot, nonDocChanged.length > 0);

	const loop = {
		docs: docsEvent
			? docsEventDone
				? {
						done: true,
						source: "ledger",
						decision: docsEvent.decision,
						paths: docsEvent.paths,
					}
				: {
						done: false,
						source: "ledger",
						decision: docsEvent.decision,
						paths: docsEvent.paths,
						stale: true,
					}
			: docsChanged.length > 0
				? { done: true, source: "diff", paths: docsChanged }
				: { done: false },
		...recordedLoop,
	};
	const scopeEvent = events.filter((e) => e.event === "scope").at(-1) ?? null;
	const slice = scopeEvent
		? {
				declared: true,
				frozenPaths: scopeEvent.frozenPaths,
				allowedPaths: scopeEvent.allowedPaths,
			}
		: { declared: false };
	// the durable plan: a checkbox is a claim; [red:]-tagged items need the
	// ledger's proof (see planProgress)
	const reviewEvents = events.filter((e) => e.event === "review");
	const latestReview = reviewEvents.at(-1) ?? null;
	// a stale approval reopens the review everywhere: for grading purposes
	// it stops being the newest approval
	const reviewStale =
		latestReview?.verdict === "approved" &&
		latestReview.snapshot !== reviewSnapshot(cwd, config.baseRef);
	const gradableReviews = reviewStale
		? [...reviewEvents, { event: "review", verdict: "stale" }]
		: reviewEvents;
	const planPath = statePath(cwd, PLAN_REL, "plan path");
	const planContent = taskPlanContent(cwd, task, planPath);
	const plan =
		planContent !== null
			? (() => {
					const parsed = parsePlan(planContent);
					const p = planProgress(
						parsed,
						events.filter((e) => e.event === "red"),
						gradableReviews,
					);
					const pick = (i) => ({
						text: i.text,
						line: i.line,
						red: i.red,
						review: i.review,
					});
					// a [review:]-tagged item is the closing review and closes only
					// through the ledger; untagged plans fall back to the LAST item
					// mentioning "review" — a mid-plan "review X" step never counts
					const tagged = parsed.items.find((i) => i.review) ?? null;
					const lastItem = parsed.items.at(-1) ?? null;
					const heuristic = lastItem && /\breview\b/i.test(lastItem.text) ? lastItem : null;
					const reviewItem = tagged ?? heuristic;
					const reviewDone = tagged
						? latestReview?.verdict === "approved" && !reviewStale
						: (reviewItem?.checked ?? false);
					return {
						present: true,
						total: p.total,
						done: p.done,
						mode: parsed.mode,
						deferred: parsed.deferred.length,
						next: p.next ? pick(p.next) : null,
						unproven: p.unproven.map(pick),
						review: reviewItem ? { present: true, done: reviewDone } : { present: false },
					};
				})()
			: { present: false };
	const pr = localOnly ? { state: "unknown", reason: "local mode" } : statusPr(cwd);
	const trunc = (s) => (s.length > 72 ? `${s.slice(0, 69)}…` : s);
	const canReview = Boolean(config.capabilities?.subagents || config.capabilities?.crossCli);
	const reviewBudget = config.review.maxRounds ?? 0;
	const reviewRoundsSpent = events.filter(
		(event) => event.event === "review" && event.verdict === "changes-requested",
	).length;
	const reviewBudgetSpent = reviewBudget > 0 && reviewRoundsSpent >= reviewBudget;
	const reviewInvocation = reviewBudgetSpent
		? '`stdd review --force --reason "<why>"`'
		: "`stdd review`";
	const rerunReview = canReview
		? reviewBudgetSpent
			? `run ${reviewInvocation} deliberately`
			: `run ${reviewInvocation} again`
		: `enable a compatible review capability/route, then run ${reviewInvocation}${
				reviewBudgetSpent ? " deliberately" : " again"
			}`;
	// The closing review rides on coordination — a plan that ordered the work, or
	// a slice handed to a worker whose code the orchestrator never watched being
	// written. A single slice coordinates nothing, claims no review, and is owed
	// none, so nothing is named. Expectation and completion are separate
	// questions: reading a missing plan as an unfinished review is what made
	// `status` ask after every verified loop, whatever the change's size.
	const reviewExpected = Boolean(latestReview) || plan.present || Boolean(scopeEvent);
	const recordedReviewSatisfied = latestReview?.verdict === "approved" && !reviewStale;
	// Once a ledger verdict exists it is authoritative; a checked legacy
	// heuristic item must never hide a newer failed or stale review.
	const reviewSatisfied = !reviewExpected
		? true
		: latestReview
			? recordedReviewSatisfied
			: Boolean(plan.review?.done);
	const reviewNeedsAction = !reviewSatisfied;
	const reviewFailureGuidance =
		latestReview?.verdict === "changes-requested"
			? `fix the ${latestReview.findings?.length ?? 0} review finding(s) and ${rerunReview}`
			: latestReview?.verdict === "error" || reviewStale
				? `repair the stale or errored closing review and ${rerunReview}`
				: null;
	const reviewFailureOutranksPlan =
		reviewFailureGuidance !== null && (!plan.present || !plan.next || plan.next.review);

	let next;
	if (pr.state === "open" && pr.checks.failure > 0) {
		// a red required check on an open PR outranks everything — pr-green
		next = `drive PR #${pr.number}'s required checks terminal-green (pr-green playbook)`;
	} else if (!loop.docs.done) {
		next = "make the docs decision: edit the canonical docs, or record `stdd docs <decision>`";
	} else if (!loop.red.done) {
		next = "write the failing test and record it via `stdd red -- <cmd>`";
	} else if (!loop.impl.done) {
		next = "implement until the red test passes";
	} else if (!loop.verify.done) {
		next = "run the narrowest verify lane via `stdd verify -- <cmd>`";
	} else if (reviewFailureOutranksPlan) {
		const scopeFirst = scopeEvent ? "run `stdd scope` (slice postflight), then " : "";
		next = `${scopeFirst}${reviewFailureGuidance}`;
	} else if (plan.present && plan.next) {
		if (plan.unproven.some((u) => u.line === plan.next.line)) {
			next = plan.next.review
				? `plan item "${trunc(plan.next.text)}" is checked but the review is unproven — ${rerunReview}`
				: `plan item "${trunc(plan.next.text)}" is checked but unproven — ` +
					`record \`stdd red -- <cmd containing "${plan.next.red}">\` or uncheck it`;
		} else if (plan.next.review) {
			next = `${rerunReview} — the closing review closes "${trunc(plan.next.text)}"`;
		} else {
			next = `continue the plan (${plan.done}/${plan.total} done) — next item: "${trunc(plan.next.text)}"`;
		}
	} else if (reviewNeedsAction && (canReview || latestReview)) {
		const scopeFirst = scopeEvent ? "run `stdd scope` (slice postflight), then " : "";
		next = `${scopeFirst}${
			reviewFailureGuidance ??
			"dispatch a fresh reviewer with `stdd review`; after approval, draft the evidence line via `stdd evidence`"
		}`;
	} else if (pr.state === "none") {
		// the closing review rides on a dispatch capability — with both routes
		// off the suggestion is omitted, never degraded to self-review; a
		// plan whose own review item is checked is not asked twice
		const review =
			!reviewSatisfied && canReview
				? "dispatch a fresh reviewer over the diff (delegate-slice playbook), then "
				: "";
		next = scopeEvent
			? `run \`stdd scope\` (slice postflight), then ${review}draft the evidence line via \`stdd evidence\` and open the PR`
			: `${review}draft the evidence line via \`stdd evidence\`, then open the PR`;
	} else if (pr.state === "open" && (pr.checks.failure > 0 || pr.checks.pending > 0)) {
		next = `drive PR #${pr.number}'s required checks terminal-green (pr-green playbook)`;
	} else if (pr.state === "open") {
		next = `PR #${pr.number} checks are green — done pending review and merge`;
	} else {
		next = `PR state unknown (${pr.reason}) — draft the evidence line via \`stdd evidence\` if no PR exists yet`;
	}

	const reviewState = latestReview
		? {
				verdict: latestReview.verdict,
				via: latestReview.via,
				blocking: (latestReview.findings ?? []).filter((f) => f.severity === "blocking").length,
				stale: reviewStale,
			}
		: null;
	if (asJson) {
		console.log(
			JSON.stringify(
				{
					state: task.state,
					task: task.state === "active" ? task.task : null,
					branch,
					loop,
					slice,
					plan,
					review: reviewState,
					pr,
					next,
				},
				null,
				"\t",
			),
		);
		return;
	}
	const mark = (step) => (step.done ? "✓" : "✗");
	const docsDetail = docsEventDone
		? ` (${docsEvent.decision}${docsEvent.paths?.length ? `: ${docsEvent.paths.join(", ")}` : ""})`
		: docsEvent
			? ` — stale or contradicted ${docsEvent.decision} decision`
			: docsChanged.length > 0
				? ` (diff: ${docsChanged.join(", ")})`
				: changed === null
					? " — unknown (no resolvable baseRef)"
					: " — no docs decision recorded, no canonical docs in the diff";
	const redDetail = redEvent
		? ` (genuine: ${redEvent.genuine}, exit ${redEvent.exit}: ${escapeNonPrintableSingleLine(redEvent.cmd)}${redLegacy ? "; legacy evidence" : redEvent.workerId ? "; imported worker evidence" : ""})`
		: " — no red recorded";
	const implDetail = loop.impl.done
		? " (checkout changed after the recorded red)"
		: redEvent
			? " — no checkout change after the recorded red"
			: " — waiting for red";
	const verifyDetail = verifyEvent
		? ` (exit 0: ${escapeNonPrintableSingleLine(verifyEvent.cmd)}${verifyEvent.snapshot ? "" : "; legacy evidence"})`
		: verifyStale
			? recordedVerify?.workerId
				? " — imported worker verify is stale by design; run fresh source verification"
				: " — stale: checkout changed after the passing verify"
			: " — no passing verify recorded since the last red";
	const prLine =
		pr.state === "open"
			? `#${pr.number} — ${pr.checks.failure} failing, ${pr.checks.pending} pending, ${pr.checks.success} green`
			: pr.state === "none"
				? `none for ${branch}`
				: `unknown (${pr.reason})`;
	console.log(
		[
			...(task.state === "active"
				? [`task:   ${task.task.id} (${task.task.name})`]
				: ["task:   legacy branch-scoped state"]),
			`loop:   docs ${mark(loop.docs)}${docsDetail}`,
			`        red  ${mark(loop.red)}${redDetail}`,
			`        impl ${mark(loop.impl)}${implDetail}`,
			`        verify ${mark(loop.verify)}${verifyDetail}`,
			...(scopeEvent
				? [
						`slice:  declared (frozen: ${scopeEvent.frozenPaths.join(", ") || "—"}; ` +
							`allowed: ${scopeEvent.allowedPaths.join(", ") || "—"}) — postflight: stdd scope`,
					]
				: []),
			...(plan.present
				? [
						`plan:   ${plan.total === 0 ? "no checklist items" : `${plan.done}/${plan.total} done`}` +
							(plan.mode ? ` [mode: ${plan.mode}]` : "") +
							(plan.deferred > 0 ? ` (${plan.deferred} deferred)` : "") +
							(plan.next
								? ` — next: "${trunc(plan.next.text)}"`
								: plan.total > 0
									? " — all items closed"
									: ""),
						...plan.unproven.map((u) =>
							u.review
								? `        unproven: "${trunc(u.text)}" — checked, but the newest recorded review is not an approval`
								: `        unproven: "${trunc(u.text)}" — checked, but no recorded red matches "${u.red}"`,
						),
					]
				: []),
			...(reviewState
				? [
						`review: ${
							reviewState.verdict === "approved"
								? `approved via ${reviewState.via}${reviewState.stale ? " — STALE, the checkout changed since" : ""}`
								: reviewState.verdict === "changes-requested"
									? `changes requested via ${reviewState.via} — ${reviewState.blocking} blocking`
									: `error via ${reviewState.via} — rerun \`stdd review\``
						}`,
					]
				: []),
			`pr:     ${prLine}`,
			`next:   ${next}`,
		].join("\n"),
	);
}

/**
 * The gate's inputs loaded without fail(): null when the repo has no
 * usable branch or config — the stop hook treats that as nothing to
 * judge, because fail() exits and would bypass its fail-open contract.
 */
function softGateInputs(cwd) {
	try {
		const configPath = resolveWritableRepoPath(cwd, ".stdd/config.json", "config path");
		const ledgerPath = resolveWritableRepoPath(cwd, LEDGER_REL, "ledger path");
		const planPath = resolveWritableRepoPath(cwd, PLAN_REL, "plan path");
		const config = fs.existsSync(configPath)
			? mergeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")))
			: DEFAULT_CONFIG;
		const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!branch || branch === "HEAD") return null;
		return { config, branch, ledgerPath, planPath };
	} catch {
		return null;
	}
}

function unavailableReviewRouteReason(via, capabilities, subject) {
	if ((via === "codex" || via === "claude") && !capabilities.crossCli) {
		return `${subject} uses "${via}" but the crossCli capability is off`;
	}
	if (via === "subagent" && !capabilities.subagents) {
		return `${subject} uses "subagent" but the subagents capability is off`;
	}
	return null;
}

function gateReasons(cwd, inputs = null) {
	const config = inputs?.config ?? loadConfig(cwd);
	const branch = inputs?.branch ?? requireBranch(cwd);
	const branchEvents = inputs?.ledgerPath
		? fs.existsSync(inputs.ledgerPath)
			? parseStateLedger(fs.readFileSync(inputs.ledgerPath, "utf8"), branch)
			: []
		: rawLedger(cwd, branch);
	const scoped = scopeLedgerForCheckout(cwd, branch, branchEvents, config);
	if (scoped.state.state === "idle") return [];
	if (scoped.state.state === "invalid") {
		return [
			`malformed task boundary in .stdd/ledger.jsonl: ${scoped.state.reason} — repair .stdd/ledger.jsonl before recording or claiming evidence`,
		];
	}
	const events = scoped.events;
	const reasons = [];
	const latest = events.filter((e) => e.event === "review").at(-1) ?? null;
	const approvalStale =
		latest?.verdict === "approved" && latest.snapshot !== reviewSnapshot(cwd, config.baseRef);
	if (latest?.verdict === "changes-requested") {
		const blocking = (latest.findings ?? []).filter((f) => f.severity === "blocking").length;
		reasons.push(
			`the newest review requested changes (${blocking} blocking) — fix and rerun \`stdd review\``,
		);
	}
	if (latest?.verdict === "error") {
		reasons.push(`the newest review errored (${latest.reason ?? "unknown"}) — rerun \`stdd review\``);
	}
	if (approvalStale) {
		reasons.push("the approved review is stale — the checkout changed since; rerun `stdd review`");
	}
	const planPath = inputs?.planPath ?? statePath(cwd, PLAN_REL, "plan path");
	const planContent = taskPlanContent(cwd, scoped.state, planPath);
	let unprovenClaim = false;
	if (planContent !== null) {
		const parsed = parsePlan(planContent);
		const claimed = parsed.items.some((i) => i.review && i.checked);
		if (claimed && latest?.verdict !== "approved") {
			unprovenClaim = true;
			reasons.push("a [review:] item is checked but no approved review is recorded — run `stdd review`");
		}
	}
	const openRequests = events.filter(
		(event) => event.event === "review-request" && !reviewRequestAnswered(events, event.id),
	);
	for (const request of openRequests) {
		const unavailable = unavailableReviewRouteReason(
			request.via,
			config.capabilities,
			`open review request ${request.id ?? "(unknown)"}`,
		);
		if (unavailable) reasons.push(unavailable);
	}
	const needsFreshDispatch =
		unprovenClaim ||
		latest?.verdict === "changes-requested" ||
		latest?.verdict === "error" ||
		approvalStale;
	if (needsFreshDispatch && openRequests.length === 0) {
		const unavailable = unavailableReviewRouteReason(
			config.review.via,
			config.capabilities,
			"review.via",
		);
		if (unavailable) reasons.push(unavailable);
	}
	return reasons;
}

/**
 * `stdd status --gate` — the review state as an exit code for hooks.
 * Fails on broken claims (checked-but-unproven review, changes-requested,
 * error, stale approval, impossible route), never on unfinished work.
 */
export function statusGate(cwd) {
	const reasons = gateReasons(cwd);
	if (reasons.length === 0) {
		console.log("stdd status --gate: ok");
		process.exit(0);
	}
	for (const r of reasons) console.log(`✗ ${r}`);
	process.exit(1);
}

/**
 * `stdd stop-hook` — the gate as a Claude Code Stop hook. Blocks the stop
 * (exit 2, reasons on stderr) only on broken claims; respects a host-provided
 * stop_hook_active guard so a blocked stop is never re-blocked into a loop,
 * and fails open on internal errors — a broken hook must not trap the session.
 */
export function stopHookCmd(rawCwd, agent = "claude") {
	const allow = () => {
		if (agent === "codex") console.log("{}");
		process.exit(0);
	};
	let payload = {};
	try {
		payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
	} catch {
		// an unreadable payload cannot prove stop_hook_active is false —
		// blocking here could re-block indefinitely; fail open
		allow();
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) allow();
	if (payload.stop_hook_active) allow();
	// soft repo resolution — resolveRepoDir()'s fail() would exit 1 and
	// bypass the fail-open contract
	let cwd = null;
	try {
		const resolved = resolveRepoDir(rawCwd);
		cwd = fs.existsSync(path.join(resolved, ".stdd")) ? resolved : null;
	} catch {
		cwd = null;
	}
	if (!cwd) allow();
	const inputs = softGateInputs(cwd);
	if (!inputs) allow();
	let reasons;
	try {
		reasons = gateReasons(cwd, inputs);
	} catch {
		allow();
	}
	if (agent === "codex") {
		// On Stop, "block" means keep the agent going with `reason` as the
		// continuation prompt. An empty object allows the turn to end.
		console.log(
			JSON.stringify(
				reasons.length === 0
					? {}
					: {
							decision: "block",
							reason: `STDD review claims are not proven: ${reasons.join("; ")}`,
						},
			),
		);
		process.exit(0);
	}
	if (reasons.length === 0) process.exit(0);
	console.error("stdd stop-hook: broken review claims —");
	for (const r of reasons) console.error(`  ✗ ${r}`);
	console.error("fix, defer, or run `stdd review` — then end the session");
	process.exit(2);
}
