import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { median, percentile } from "../cli/stats.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

const line = (event) => JSON.stringify(event);
const finding = (severity) => ({ severity, message: `${severity} finding` });

// Branch feat/a: a finished task with every verdict kind, an open task whose
// first dispatch errors, an abandoned task and its reset successor, a legacy
// event without a task, and three malformed lines.
const MAIN_LEDGER = [
	line({
		ts: "2026-10-20T08:00:00.000Z",
		event: "task-start",
		id: "task-cccc",
		name: "gamma",
		planBaseline: null,
		branch: "feat/a",
	}),
	line({ ts: "2026-10-20T08:05:00.000Z", event: "task-reset", taskId: "task-cccc", branch: "feat/a" }),
	line({
		ts: "2026-10-20T08:05:00.000Z",
		event: "task-start",
		id: "task-dddd",
		name: "gamma",
		planBaseline: null,
		branch: "feat/a",
	}),
	line({
		ts: "2026-10-20T08:06:00.000Z",
		event: "docs",
		taskId: "task-dddd",
		decision: "not-applicable",
		paths: [],
		reason: "refactor",
		branch: "feat/a",
	}),
	line({ ts: "2026-10-20T08:20:00.000Z", event: "task-finish", taskId: "task-dddd", branch: "feat/a" }),
	"not json at all",
	line({
		ts: "2026-11-01T10:00:00.000Z",
		event: "task-start",
		id: "task-aaaa",
		name: "alpha: a long task name that gets truncated in the table",
		planBaseline: null,
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:01:00.000Z",
		event: "docs",
		taskId: "task-aaaa",
		decision: "updated-first",
		paths: ["docs/a.md"],
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:02:00.000Z",
		event: "red",
		taskId: "task-aaaa",
		cmd: "npm test",
		exit: 1,
		excerpt: "1 failing",
		genuine: "yes",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:03:00.000Z",
		event: "red",
		taskId: "task-aaaa",
		cmd: "npm test",
		exit: 1,
		excerpt: "1 failing",
		genuine: "yes",
		mode: "without-implementation",
		stripped: ["src/a.js"],
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:05:00.000Z",
		event: "verify",
		taskId: "task-aaaa",
		cmd: "npm test",
		exit: 1,
		excerpt: "",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:06:00.000Z",
		event: "verify",
		taskId: "task-aaaa",
		cmd: "npm test",
		exit: 0,
		excerpt: "",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:10:00.000Z",
		event: "review-request",
		taskId: "task-aaaa",
		id: "rr-1",
		via: "codex",
		briefPath: "/tmp/b1",
		briefHash: "sha256:x",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:12:00.000Z",
		event: "review",
		taskId: "task-aaaa",
		request: "rr-1",
		via: "codex",
		verdict: "changes-requested",
		summary: "fix",
		findings: [finding("blocking"), finding("advisory")],
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:15:00.000Z",
		event: "review-request",
		taskId: "task-aaaa",
		id: "rr-2",
		via: "codex",
		briefPath: "/tmp/b2",
		briefHash: "sha256:x",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:17:00.000Z",
		event: "review",
		taskId: "task-aaaa",
		request: "rr-2",
		via: "codex",
		verdict: "approved",
		summary: "ok",
		findings: [finding("advisory")],
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:20:00.000Z",
		event: "verify",
		taskId: "task-aaaa",
		cmd: "npm test",
		exit: 0,
		excerpt: "",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:22:00.000Z",
		event: "review-request",
		taskId: "task-aaaa",
		id: "rr-3",
		via: "codex",
		briefPath: "/tmp/b3",
		briefHash: "sha256:x",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-01T10:25:00.000Z",
		event: "review",
		taskId: "task-aaaa",
		request: "rr-3",
		via: "settled",
		verdict: "approved",
		summary: "settled",
		findings: [],
		branch: "feat/a",
	}),
	line({ ts: "2026-11-01T10:30:00.000Z", event: "task-finish", taskId: "task-aaaa", branch: "feat/a" }),
	"[1, 2]",
	line({
		ts: "2026-11-05T09:00:00.000Z",
		event: "task-start",
		id: "task-bbbb",
		name: "beta",
		planBaseline: null,
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-05T09:01:00.000Z",
		event: "red",
		taskId: "task-bbbb",
		cmd: "go test",
		exit: 2,
		excerpt: "cannot find package",
		genuine: "no",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-05T09:02:00.000Z",
		event: "review-request",
		taskId: "task-bbbb",
		id: "rr-4",
		via: "claude",
		briefPath: "/tmp/b4",
		briefHash: "sha256:x",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-05T09:03:00.000Z",
		event: "review",
		taskId: "task-bbbb",
		request: "rr-4",
		via: "claude",
		verdict: "error",
		reason: "timeout",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-05T09:04:00.000Z",
		event: "review-request",
		taskId: "task-bbbb",
		id: "rr-5",
		via: "claude",
		briefPath: "/tmp/b5",
		briefHash: "sha256:x",
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-05T09:06:00.000Z",
		event: "review",
		taskId: "task-bbbb",
		request: "rr-5",
		via: "claude",
		verdict: "approved",
		summary: "ok",
		findings: [],
		branch: "feat/a",
	}),
	line({
		ts: "2026-11-05T09:07:00.000Z",
		event: "note",
		text: "legacy event without a task",
		branch: "feat/a",
	}),
	"42",
].join("\n");

// A second worktree's ledger: one finished task on another branch.
const OTHER_LEDGER = [
	line({
		ts: "2026-11-02T12:00:00.000Z",
		event: "task-start",
		id: "task-eeee",
		name: "epsilon",
		planBaseline: null,
		branch: "feat/b",
	}),
	line({
		ts: "2026-11-02T12:01:00.000Z",
		event: "docs",
		taskId: "task-eeee",
		decision: "checked",
		paths: ["docs/e.md"],
		reason: "covered",
		branch: "feat/b",
	}),
	line({ ts: "2026-11-02T13:00:00.000Z", event: "task-finish", taskId: "task-eeee", branch: "feat/b" }),
].join("\n");

function checkout(ledger) {
	const dir = makeTempDir("stdd-stats-");
	fs.mkdirSync(path.join(dir, ".stdd"));
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), "{}");
	if (ledger !== null) fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), `${ledger}\n`);
	return dir;
}

test("median and percentile use nearest-rank on the sorted values", () => {
	assert.equal(median([]), null);
	assert.equal(median([7]), 7);
	assert.equal(median([30, 15]), 22.5);
	assert.equal(median([60, 15, 30]), 30);
	assert.equal(percentile([60, 15, 30], 75), 60);
	assert.equal(percentile([1, 2, 3, 4], 75), 3);
	assert.equal(percentile([], 75), null);
});

test("stats --json aggregates every task across branches and ledgers with stable keys", async () => {
	const dir = checkout(MAIN_LEDGER);
	const other = makeTempDir("stdd-stats-other-");
	fs.mkdirSync(path.join(other, ".stdd"));
	fs.writeFileSync(path.join(other, ".stdd", "ledger.jsonl"), `${OTHER_LEDGER}\n`);

	const res = await run(["stats", "--json", "--ledger", other], { cwd: dir });
	assert.equal(res.code, 0, res.stderr);
	const report = JSON.parse(res.stdout);
	assert.deepEqual(Object.keys(report), ["tasks", "summary", "skippedLines"]);
	assert.equal(report.skippedLines, 3);
	assert.deepEqual(
		report.tasks.map((t) => t.id),
		["task-bbbb", "task-eeee", "task-aaaa", "task-dddd", "task-cccc"],
		"newest first",
	);

	const alpha = report.tasks.find((t) => t.id === "task-aaaa");
	assert.deepEqual(alpha, {
		id: "task-aaaa",
		name: "alpha: a long task name that gets truncated in the table",
		branch: "feat/a",
		started: "2026-11-01T10:00:00.000Z",
		finished: "2026-11-01T10:30:00.000Z",
		state: "finished",
		minutes: 30,
		docs: "updated-first",
		red: { total: 2, genuine: 2, withoutImpl: 1 },
		verify: { total: 3, failing: 1 },
		review: {
			dispatches: 3,
			approved: 1,
			changesRequested: 1,
			error: 0,
			settled: 1,
			firstVerdict: "changes-requested",
			blocking: 1,
			advisory: 2,
			reReviewAfterApprove: true,
			stale: true,
		},
	});
	const beta = report.tasks.find((t) => t.id === "task-bbbb");
	assert.equal(beta.state, "open");
	assert.equal(beta.finished, null);
	assert.equal(beta.minutes, null);
	assert.equal(beta.docs, null);
	assert.deepEqual(beta.red, { total: 1, genuine: 0, withoutImpl: 0 });
	assert.equal(beta.review.error, 1);
	assert.equal(beta.review.firstVerdict, "approved");
	assert.equal(beta.review.reReviewAfterApprove, false);
	assert.equal(beta.review.stale, false);
	const gamma = report.tasks.find((t) => t.id === "task-cccc");
	assert.equal(gamma.state, "abandoned");
	assert.equal(gamma.finished, "2026-10-20T08:05:00.000Z");
	assert.equal(gamma.minutes, null);
	assert.equal(report.tasks.find((t) => t.id === "task-dddd").minutes, 15);
	assert.equal(report.tasks.find((t) => t.id === "task-eeee").branch, "feat/b");

	assert.deepEqual(report.summary, {
		tasks: { total: 5, finished: 3, open: 1, abandoned: 1 },
		minutesToFinish: { median: 30, p75: 60 },
		reviewed: { tasks: 2, dispatchesPerTask: 2.5 },
		firstVerdictApprovalRate: 0.5,
		errorShare: 0.2,
		reReviewAfterApproveShare: 0.5,
		staleShare: 0.5,
		findings: { blocking: 1, advisory: 2 },
		docsDecisions: { "updated-first": 1, checked: 1, "not-applicable": 1, none: 2 },
		genuineRedShare: 2 / 3,
	});
	assert.equal(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"), `${MAIN_LEDGER}\n`);
});

test("stats --since keeps tasks started on or after the date and --ledger accepts a file path", async () => {
	const dir = checkout(MAIN_LEDGER);
	const otherFile = path.join(makeTempDir("stdd-stats-file-"), "ledger.jsonl");
	fs.writeFileSync(otherFile, `${OTHER_LEDGER}\n`);
	const res = await run(["stats", "--json", "--since", "2026-11-01", "--ledger", otherFile], {
		cwd: dir,
	});
	assert.equal(res.code, 0, res.stderr);
	const report = JSON.parse(res.stdout);
	assert.deepEqual(report.tasks.map((t) => t.id).sort(), ["task-aaaa", "task-bbbb", "task-eeee"]);
	assert.equal(report.summary.tasks.total, 3);
	const bad = await run(["stats", "--since", "yesterday"], { cwd: dir });
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /YYYY-MM-DD/);
	const missing = await run(["stats", "--ledger", path.join(dir, "nope.jsonl")], { cwd: dir });
	assert.equal(missing.code, 1);
	assert.match(missing.stderr, /nope\.jsonl/);
});

test("stats prints a human table newest first with the summary and reports skipped lines", async () => {
	const dir = checkout(MAIN_LEDGER);
	const res = await run(["stats"], { cwd: dir });
	assert.equal(res.code, 0, res.stderr);
	const betaRow = res.stdout.indexOf("beta");
	const alphaRow = res.stdout.indexOf("alpha");
	assert.ok(betaRow !== -1 && alphaRow !== -1 && betaRow < alphaRow, res.stdout);
	assert.doesNotMatch(res.stdout, /gets truncated in the table/, "long names are truncated");
	assert.match(res.stdout, /tasks:\s+4 \(2 finished, 1 open, 1 abandoned\)/);
	assert.match(res.stdout, /first-verdict approval:\s+1\/2/);
	assert.match(res.stdout, /skipped 3 malformed line/);
	assert.doesNotMatch(res.stdout, /feat\/b/);
});

test("stats needs no task and exits 0 on an empty or missing ledger", async () => {
	const missing = checkout(null);
	let res = await run(["stats"], { cwd: missing });
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /no tasks recorded/);
	res = await run(["stats", "--json"], { cwd: missing });
	assert.equal(res.code, 0);
	assert.deepEqual(JSON.parse(res.stdout).tasks, []);
	assert.equal(JSON.parse(res.stdout).summary.tasks.total, 0);
	const empty = checkout("");
	res = await run(["stats"], { cwd: empty });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /no tasks recorded/);
	const unknown = await run(["stats", "--gate"], { cwd: empty });
	assert.equal(unknown.code, 1);
	const typo = await run(["statz"], { cwd: empty });
	assert.equal(typo.code, 1);
	assert.match(typo.stderr, /did you mean "stats"/);
});
