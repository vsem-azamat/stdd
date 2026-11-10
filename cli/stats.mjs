// `stdd stats`: the process read-out. Reads ledgers raw, across every branch,
// and aggregates per task and in summary. Read-only by construction: it never
// imports the append path.

import fs from "node:fs";
import path from "node:path";
import { LEDGER_REL } from "./ledger.mjs";
import { RED_WITHOUT_IMPL_MODE } from "./lib.mjs";
import { fail, statePath } from "./runtime.mjs";

const DOCS_HISTOGRAM_KEYS = ["updated-first", "checked", "not-applicable"];
const SETTLED_VIA = "settled";
const NAME_WIDTH = 36;
const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** Nearest-rank percentile over the values (0 < p ≤ 100); null for no values. */
export function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1];
}

/** The median, averaging the two middle values of an even count; null for no values. */
export function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Every JSON-object line, in file order; anything else is counted, never fatal. */
export function parseStatsLedger(text) {
	const events = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			skipped++;
			continue;
		}
		if (typeof event !== "object" || event === null || Array.isArray(event)) {
			skipped++;
			continue;
		}
		events.push(event);
	}
	return { events, skipped };
}

function minutesBetween(start, end) {
	const ms = Date.parse(end) - Date.parse(start);
	return Number.isFinite(ms) ? Math.round((ms / 60_000) * 100) / 100 : null;
}

function verdictKind(event) {
	if (event.verdict === "approved" && event.via === SETTLED_VIA) return "settled";
	return event.verdict;
}

function countFindings(findings, severity) {
	return Array.isArray(findings) ? findings.filter((f) => f?.severity === severity).length : 0;
}

function taskRow(task) {
	const events = task.events;
	const reds = events.filter((e) => e.event === "red");
	const verifies = events.filter((e) => e.event === "verify");
	const reviews = events.filter((e) => e.event === "review");
	const docs = events.filter((e) => e.event === "docs").at(-1) ?? null;
	const kinds = reviews.map(verdictKind);
	const firstVerdict = kinds.find((kind) => kind !== "error") ?? null;
	const followedBy = (index, predicate) => events.slice(index + 1).some(predicate);
	const approvals = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => event.event === "review" && verdictKind(event) === "approved");
	return {
		id: task.id,
		name: task.name,
		branch: task.branch,
		started: task.started,
		finished: task.finished,
		state: task.state,
		minutes: task.state === "finished" ? minutesBetween(task.started, task.finished) : null,
		docs: docs?.decision ?? null,
		red: {
			total: reds.length,
			genuine: reds.filter((e) => e.genuine === "yes").length,
			withoutImpl: reds.filter((e) => e.mode === RED_WITHOUT_IMPL_MODE).length,
		},
		verify: { total: verifies.length, failing: verifies.filter((e) => e.exit !== 0).length },
		review: {
			dispatches: events.filter((e) => e.event === "review-request").length,
			approved: kinds.filter((kind) => kind === "approved").length,
			changesRequested: kinds.filter((kind) => kind === "changes-requested").length,
			error: kinds.filter((kind) => kind === "error").length,
			settled: kinds.filter((kind) => kind === "settled").length,
			firstVerdict,
			blocking: reviews.reduce((sum, e) => sum + countFindings(e.findings, "blocking"), 0),
			advisory: reviews.reduce((sum, e) => sum + countFindings(e.findings, "advisory"), 0),
			reReviewAfterApprove: approvals.some(({ index }) =>
				followedBy(index, (e) => e.event === "review-request"),
			),
			stale: approvals.some(({ index }) =>
				followedBy(index, (e) => e.event === "red" || e.event === "verify" || e.event === "docs"),
			),
		},
	};
}

/** Group events by task id; a task is its `task-start` plus every event carrying its id. */
export function aggregateTasks(events) {
	const tasks = new Map();
	for (const event of events) {
		if (event.event === "task-start") {
			if (typeof event.id !== "string" || tasks.has(event.id)) continue;
			tasks.set(event.id, {
				id: event.id,
				name: typeof event.name === "string" ? event.name : "",
				branch: typeof event.branch === "string" ? event.branch : "",
				started: typeof event.ts === "string" ? event.ts : null,
				finished: null,
				state: "open",
				events: [],
			});
			continue;
		}
		const task = typeof event.taskId === "string" ? tasks.get(event.taskId) : undefined;
		if (!task) continue;
		if (event.event === "task-finish" || event.event === "task-reset") {
			if (task.state === "open") {
				task.state = event.event === "task-finish" ? "finished" : "abandoned";
				task.finished = typeof event.ts === "string" ? event.ts : null;
			}
			continue;
		}
		task.events.push(event);
	}
	return [...tasks.values()]
		.map(taskRow)
		.sort((a, b) => (a.started === b.started ? 0 : (a.started ?? "") < (b.started ?? "") ? 1 : -1));
}

const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);

/** The summary block and the raw counts its ratios came from. */
export function summarize(tasks) {
	const finished = tasks.filter((t) => t.state === "finished");
	const minutes = finished.map((t) => t.minutes).filter((m) => m !== null);
	const reviewed = tasks.filter((t) => t.review.dispatches > 0);
	const dispatches = tasks.reduce((sum, t) => sum + t.review.dispatches, 0);
	const errors = tasks.reduce((sum, t) => sum + t.review.error, 0);
	const withVerdict = tasks.filter((t) => t.review.firstVerdict !== null);
	const firstApproved = withVerdict.filter((t) => t.review.firstVerdict === "approved");
	const approvals = tasks.reduce((sum, t) => sum + t.review.approved, 0);
	const reReviewed = tasks.filter((t) => t.review.reReviewAfterApprove).length;
	const stale = tasks.filter((t) => t.review.stale).length;
	const reds = tasks.reduce((sum, t) => sum + t.red.total, 0);
	const genuine = tasks.reduce((sum, t) => sum + t.red.genuine, 0);
	const docsDecisions = Object.fromEntries(DOCS_HISTOGRAM_KEYS.map((key) => [key, 0]));
	docsDecisions.none = 0;
	for (const task of tasks) {
		if (task.docs !== null && DOCS_HISTOGRAM_KEYS.includes(task.docs)) docsDecisions[task.docs]++;
		else docsDecisions.none++;
	}
	const counts = {
		dispatches,
		errors,
		withVerdict: withVerdict.length,
		firstApproved: firstApproved.length,
		approvals,
		reReviewed,
		stale,
		reds,
		genuine,
	};
	const summary = {
		tasks: {
			total: tasks.length,
			finished: finished.length,
			open: tasks.filter((t) => t.state === "open").length,
			abandoned: tasks.filter((t) => t.state === "abandoned").length,
		},
		minutesToFinish: { median: median(minutes), p75: percentile(minutes, 75) },
		reviewed: { tasks: reviewed.length, dispatchesPerTask: ratio(dispatches, reviewed.length) },
		firstVerdictApprovalRate: ratio(firstApproved.length, withVerdict.length),
		errorShare: ratio(errors, dispatches),
		reReviewAfterApproveShare: ratio(reReviewed, approvals),
		staleShare: ratio(stale, approvals),
		findings: {
			blocking: tasks.reduce((sum, t) => sum + t.review.blocking, 0),
			advisory: tasks.reduce((sum, t) => sum + t.review.advisory, 0),
		},
		docsDecisions,
		genuineRedShare: ratio(genuine, reds),
	};
	return { summary, counts };
}

function parseSince(since) {
	if (since === null) return null;
	const timestamp = SINCE_FORMAT.test(since) ? Date.parse(`${since}T00:00:00.000Z`) : Number.NaN;
	if (!Number.isFinite(timestamp))
		fail(`--since requires a date as YYYY-MM-DD, e.g. --since 2026-01-31`);
	return timestamp;
}

function resolveLedgerPath(cwd, given) {
	const resolved = path.resolve(cwd, given);
	let target = resolved;
	try {
		if (fs.statSync(resolved).isDirectory()) target = path.join(resolved, LEDGER_REL);
	} catch {
		fail(`--ledger ${given}: no such file or directory`);
	}
	if (!fs.existsSync(target)) fail(`--ledger ${given}: ${target} does not exist`);
	return target;
}

function readLedgers(cwd, ledgers) {
	const files = [];
	const own = statePath(cwd, LEDGER_REL, "ledger path");
	if (fs.existsSync(own)) files.push(own);
	for (const given of ledgers) files.push(resolveLedgerPath(cwd, given));
	const events = [];
	let skipped = 0;
	for (const file of files) {
		const parsed = parseStatsLedger(fs.readFileSync(file, "utf8"));
		events.push(...parsed.events);
		skipped += parsed.skipped;
	}
	return { events, skipped };
}

const pad = (value, width) => String(value).padEnd(width);
const padLeft = (value, width) => String(value).padStart(width);
const share = (numerator, denominator) =>
	denominator === 0
		? "n/a"
		: `${numerator}/${denominator} (${Math.round((numerator / denominator) * 100)}%)`;
const num = (value) => (value === null ? "n/a" : String(Math.round(value * 10) / 10));
const trunc = (text, width) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

function renderHuman(tasks, { summary, counts }, skipped) {
	const lines = [];
	if (tasks.length === 0) {
		lines.push("no tasks recorded");
	} else {
		lines.push(
			`${pad("started", 16)} ${pad("state", 9)} ${padLeft("min", 6)} ${pad("docs", 14)} ${pad("red", 9)} ${pad("verify", 7)} ${pad("reviews", 12)} ${pad("task", NAME_WIDTH)} branch`,
		);
		for (const task of tasks) {
			const red = `${task.red.genuine}/${task.red.total}${task.red.withoutImpl ? `+${task.red.withoutImpl}wi` : ""}`;
			const verify = `${task.verify.total - task.verify.failing}/${task.verify.total}`;
			const verdicts = [
				task.review.approved ? `${task.review.approved}A` : "",
				task.review.changesRequested ? `${task.review.changesRequested}C` : "",
				task.review.error ? `${task.review.error}E` : "",
				task.review.settled ? `${task.review.settled}S` : "",
			]
				.filter(Boolean)
				.join(" ");
			const reviews = task.review.dispatches ? `${task.review.dispatches} ${verdicts}`.trim() : "-";
			lines.push(
				`${pad((task.started ?? "").slice(0, 16).replace("T", " "), 16)} ${pad(task.state, 9)} ${padLeft(num(task.minutes), 6)} ${pad(task.docs ?? "-", 14)} ${pad(red, 9)} ${pad(verify, 7)} ${pad(reviews, 12)} ${pad(trunc(task.name, NAME_WIDTH), NAME_WIDTH)} ${task.branch}`,
			);
		}
		lines.push("");
		lines.push(
			`tasks:                     ${summary.tasks.total} (${summary.tasks.finished} finished, ${summary.tasks.open} open, ${summary.tasks.abandoned} abandoned)`,
			`minutes to finish:         median ${num(summary.minutesToFinish.median)}, p75 ${num(summary.minutesToFinish.p75)}`,
			`reviewed tasks:            ${summary.reviewed.tasks} (${num(summary.reviewed.dispatchesPerTask)} dispatches per reviewed task)`,
			`first-verdict approval:    ${share(counts.firstApproved, counts.withVerdict)}`,
			`dispatches ending error:   ${share(counts.errors, counts.dispatches)}`,
			`re-review after approve:   ${share(counts.reReviewed, counts.approvals)}`,
			`stale approvals:           ${share(counts.stale, counts.approvals)}`,
			`findings:                  ${summary.findings.blocking} blocking, ${summary.findings.advisory} advisory`,
			`docs decisions:            ${Object.entries(summary.docsDecisions)
				.map(([key, count]) => `${key} ${count}`)
				.join(", ")}`,
			`genuine reds:              ${share(counts.genuine, counts.reds)}`,
		);
	}
	if (skipped > 0) lines.push(`skipped ${skipped} malformed line(s)`);
	return lines.join("\n");
}

/** `stdd stats [--json] [--since <date>] [--ledger <path>]…` — print the read-out; always exit 0. */
export function stats(cwd, { json = false, since = null, ledgers = [] } = {}) {
	const sinceTimestamp = parseSince(since);
	const { events, skipped } = readLedgers(cwd, ledgers);
	const tasks = aggregateTasks(events).filter(
		(task) =>
			sinceTimestamp === null || (task.started !== null && Date.parse(task.started) >= sinceTimestamp),
	);
	const summarized = summarize(tasks);
	if (json) {
		console.log(JSON.stringify({ tasks, summary: summarized.summary, skippedLines: skipped }, null, 2));
	} else {
		console.log(renderHuman(tasks, summarized, skipped));
	}
	return 0;
}
