import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mergeConfig, parseLedger } from "../cli/lib.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");
const SUITE_TMP_ROOT = makeTempDir("stdd-review-loop-suite-");

process.env.TMPDIR = SUITE_TMP_ROOT;
after(() => {
	fs.rmSync(SUITE_TMP_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

function tmpDir() {
	return makeTempDir("stdd-review-loop-");
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

const ALL_CAPS = { subagents: true, crossCli: true, worktrees: true };

async function tmpGitRepo(config = {}) {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			canonicalDocs: ["docs/**/*.md"],
			...config,
		}),
	);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 1;\n");
	fs.writeFileSync(path.join(dir, "other.js"), "export const o = 1;\n");
	fs.writeFileSync(path.join(dir, "docs", "spec.md"), "# Spec\n\nThe value is one.\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2;\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [ ] closing review [review:]\n",
	);
	return { dir, git };
}

function readLedger(dir) {
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	return fs.existsSync(ledgerPath) ? parseLedger(fs.readFileSync(ledgerPath, "utf8")) : [];
}

/** Dispatch a subagent review and grade it with the given findings. */
async function approveWith(dir, findings, summary = "sound") {
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, JSON.stringify({ summary, findings }));
	const graded = await run(["review", "--result", resultPath], { cwd: dir });
	return { prep, graded, briefPath: prep.stdout.match(/brief written to (\S+)/)?.[1] };
}

const ADVISORY_IMPL = [{ severity: "advisory", path: "impl.js", line: 1, message: "name the constant" }];

// --- advisory settlement: stdd review --settle ---

test("a review event records the digest of every changed path under review", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "fresh.txt"), "untracked and part of the change\n");
	const { graded } = await approveWith(dir, []);
	assert.equal(graded.code, 0, graded.stdout + graded.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.deepEqual(Object.keys(review.files).sort(), ["fresh.txt", "impl.js"]);
	assert.match(review.files["impl.js"], /^blob:/);
	assert.match(review.files["fresh.txt"], /^blob:/);
});

test("settle: fixing exactly the advisory-named path with a fresh verify keeps the approval current", async () => {
	const { dir } = await tmpGitRepo();
	const { graded } = await approveWith(dir, ADVISORY_IMPL);
	assert.equal(graded.code, 0, graded.stdout + graded.stderr);
	const approval = readLedger(dir).find((e) => e.event === "review");

	const current = await run(["review", "--settle"], { cwd: dir });
	assert.equal(current.code, 1);
	assert.match(current.stderr, /nothing to settle — the approval is current/);

	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	const stale = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(stale.review.stale, true, "editing stales the approval first");

	const unverified = await run(["review", "--settle"], { cwd: dir });
	assert.equal(unverified.code, 1);
	assert.match(unverified.stderr, /run `stdd verify -- <cmd>` on the settled checkout first/);
	assert.equal(readLedger(dir).filter((e) => e.event === "review").length, 1, "nothing recorded");

	const verify = await run(["verify", "--", "true"], { cwd: dir });
	assert.equal(verify.code, 0, verify.stderr);
	const settled = await run(["review", "--settle"], { cwd: dir });
	assert.equal(settled.code, 0, settled.stdout + settled.stderr);
	assert.match(settled.stdout, /settled/);

	const reviews = readLedger(dir).filter((e) => e.event === "review");
	assert.equal(reviews.length, 2);
	const event = reviews.at(-1);
	assert.equal(event.via, "settled");
	assert.equal(event.verdict, "approved");
	assert.equal(event.settles, approval.request);
	assert.deepEqual(event.findings, []);
	assert.equal(event.summary, "advisory findings settled without a new dispatch");
	assert.notEqual(event.snapshot, approval.snapshot);
	assert.notEqual(event.files["impl.js"], approval.files["impl.js"]);
	assert.equal(event.taskId, approval.taskId);

	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review.stale, false);
	assert.equal(status.review.via, "settled");
	assert.equal(status.plan.review.done, true, "the [review:] item closes from the settled approval");
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout);

	// a settled approval carries no advisories, so it cannot be settled again
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 3;\n");
	await run(["verify", "--", "true"], { cwd: dir });
	const again = await run(["review", "--settle"], { cwd: dir });
	assert.equal(again.code, 1);
	assert.match(again.stderr, /no advisory findings/);
});

test("settle refuses when a path no advisory named changed, and records nothing", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	fs.writeFileSync(path.join(dir, "other.js"), "export const o = 2;\n");
	await run(["verify", "--", "true"], { cwd: dir });
	const refused = await run(["review", "--settle"], { cwd: dir });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /other\.js/);
	assert.doesNotMatch(refused.stderr, /impl\.js/);
	assert.match(refused.stderr, /real round.*`stdd review`/);
	assert.equal(readLedger(dir).filter((e) => e.event === "review").length, 1);
});

test("settle refuses an approval with no advisory findings and a non-approval newest verdict", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, []);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	await run(["verify", "--", "true"], { cwd: dir });
	const clean = await run(["review", "--settle"], { cwd: dir });
	assert.equal(clean.code, 1);
	assert.match(clean.stderr, /no advisory findings/);

	const { graded } = await approveWith(dir, [
		{ severity: "blocking", path: "impl.js", message: "wrong" },
	]);
	assert.equal(graded.code, 1);
	const blocked = await run(["review", "--settle"], { cwd: dir });
	assert.equal(blocked.code, 1);
	assert.match(blocked.stderr, /not an approval/);
});

test("settle refuses when only the plan changed: no advisory names the plan", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl differently\n- [ ] closing review [review:]\n",
	);
	await run(["verify", "--", "true"], { cwd: dir });
	const refused = await run(["review", "--settle"], { cwd: dir });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /plan/);
});

test("settle refuses an approval recorded without file digests", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const lines = fs
		.readFileSync(ledgerPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const event = JSON.parse(line);
			if (event.event === "review") delete event.files;
			return JSON.stringify(event);
		});
	fs.writeFileSync(ledgerPath, `${lines.join("\n")}\n`);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review.verdict, "approved", "a review event without files still parses");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	await run(["verify", "--", "true"], { cwd: dir });
	const refused = await run(["review", "--settle"], { cwd: dir });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /digests/);
});

test("a plain dispatch is refused while only advisory-named paths changed; --force --reason overrides", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	const refused = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(refused.code, 1, refused.stdout + refused.stderr);
	assert.equal(
		refused.stderr,
		"stdd: only advisory-named paths changed since the approval — run `stdd review --settle` after a fresh `stdd verify`; a new dispatch needs `--force --reason <why>`\n",
	);
	assert.equal(readLedger(dir).filter((e) => e.event === "review-request").length, 1);

	const forced = await run(
		["review", "--via", "subagent", "--force", "--reason", "the fix touched the public name"],
		{ cwd: dir },
	);
	assert.equal(forced.code, 0, forced.stdout + forced.stderr);
	const requests = readLedger(dir).filter((e) => e.event === "review-request");
	assert.equal(requests.length, 2);
	assert.equal(requests.at(-1).forced, "the fix touched the public name");
});

test("a plain dispatch proceeds once a path outside the advisories changed", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	fs.writeFileSync(path.join(dir, "other.js"), "export const o = 2;\n");
	const dispatched = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(dispatched.code, 0, dispatched.stdout + dispatched.stderr);
	assert.equal(readLedger(dir).filter((e) => e.event === "review-request").length, 2);
});

test("settled is a ledger-only route: --via, review.via, and --result refuse it", async () => {
	const { dir } = await tmpGitRepo();
	const via = await run(["review", "--via", "settled"], { cwd: dir });
	assert.equal(via.code, 1);
	assert.match(via.stderr, /unknown review route "settled"/);
	assert.throws(() => mergeConfig({ review: { via: "settled" } }), /review\.via/);
	const configured = await run(["configure", dir, "--review-via", "settled"]);
	assert.equal(configured.code, 1);
	assert.equal(readLedger(dir).length, 0);
});

test("--settle cannot be combined with dispatch, result, or cleanup flags", async () => {
	const { dir } = await tmpGitRepo();
	for (const extra of [
		["--via", "subagent"],
		["--result", "x.json"],
		["--cleanup"],
		["--force"],
		["--timeout", "5"],
	]) {
		const res = await run(["review", "--settle", ...extra], { cwd: dir });
		assert.equal(res.code, 1, extra.join(" "));
		assert.match(res.stderr, /--settle/, extra.join(" "));
	}
	assert.equal(readLedger(dir).length, 0);
});

test("a settled approval reads as an approval for the follow-up context", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	await run(["verify", "--", "true"], { cwd: dir });
	const settled = await run(["review", "--settle"], { cwd: dir });
	assert.equal(settled.code, 0, settled.stderr);
	fs.writeFileSync(path.join(dir, "other.js"), "export const o = 2;\n");
	const next = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(next.code, 0, next.stdout + next.stderr);
	const brief = fs.readFileSync(next.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.doesNotMatch(brief, /## Prior review findings|## Follow-up review/);
});

// --- the in-flight guard: stdd review --guard and the Claude PreToolUse hook ---

test("review --guard exits 0 silently with no request in flight, never creating state", async () => {
	const { dir } = await tmpGitRepo();
	const idle = await run(["review", "--guard"], { cwd: dir });
	assert.deepEqual(idle, { code: 0, stdout: "", stderr: "" });
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "the guard writes nothing");

	const bare = tmpDir();
	const outside = await run(["review", "--guard"], { cwd: bare });
	assert.deepEqual(outside, { code: 0, stdout: "", stderr: "" });
	assert.deepEqual(fs.readdirSync(bare), [], "the guard creates no .stdd/ outside a repository");
});

test("review --guard exits 2 with the request named while a review is in flight", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stderr);
	const request = readLedger(dir).find((e) => e.event === "review-request");
	const before = fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8");
	const blocked = await run(["review", "--guard"], { cwd: dir });
	assert.equal(blocked.code, 2);
	assert.equal(blocked.stdout, "");
	assert.equal(
		blocked.stderr,
		`stdd review: a review is in flight (request ${request.id}, via subagent) — wait for its verdict and record it with \`stdd review --result <file>\`; editing now would make the review stale. To abandon it run \`stdd review --cleanup\`.\n`,
	);
	assert.equal(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"), before);

	const nested = path.join(dir, "docs");
	assert.equal((await run(["review", "--guard"], { cwd: nested })).code, 2, "from a subdirectory too");

	const cleanup = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleanup.code, 0, cleanup.stderr);
	assert.equal((await run(["review", "--guard"], { cwd: dir })).code, 0);

	for (const extra of [["--settle"], ["--via", "subagent"], ["--cleanup"], ["--force"]]) {
		const res = await run(["review", "--guard", ...extra], { cwd: dir });
		assert.equal(res.code, 1, extra.join(" "));
		assert.match(res.stderr, /--guard/);
	}
});

test("init --session-hook wires the Claude PreToolUse guard hook idempotently and migrates it", async () => {
	const { claudeGuardCommand, installSessionHook } = await import("../cli/claude-hooks.mjs");
	const SOURCE_RUNNER = 'node "$(git rev-parse --show-toplevel)/cli/stdd.mjs"';
	const dir = tmpDir();
	execFileSyncGit(dir);
	const first = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(first.code, 0, first.stderr);
	assert.match(
		first.stdout,
		/Wired the Claude Code PreToolUse hook \(Edit\|Write\|MultiEdit\|NotebookEdit → stdd review --guard\)/,
	);
	const settingsPath = path.join(dir, ".claude", "settings.json");
	const read = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	let settings = read();
	assert.equal(settings.hooks.PreToolUse.length, 1);
	assert.equal(settings.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
	assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
	assert.match(
		settings.hooks.PreToolUse[0].hooks[0].command,
		/^npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+ -- stdd review --guard$/,
		"an adopting repository gets the pinned package runner",
	);
	assert.equal(claudeGuardCommand(SOURCE_RUNNER), `${SOURCE_RUNNER} review --guard`);

	const second = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(second.code, 0, second.stderr);
	assert.match(second.stdout, /already carries the review guard hook/);
	assert.equal(read().hooks.PreToolUse.length, 1);
	settings = read();
	delete settings.hooks.SessionStart;
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	const doctor = await run(["doctor", dir]);
	assert.match(doctor.stdout, /project-local stdd binary/, "doctor counts the guard hook as wired");

	// a pinned-package generated command migrates to the current runner; a
	// user hook sharing the group keeps its own matcher
	settings = read();
	settings.hooks.PreToolUse = [
		{
			matcher: "Edit",
			hooks: [
				{
					type: "command",
					command: "npm exec --offline --package=@stdd/cli@0.9.0 -- stdd review --guard",
				},
				{ type: "command", command: "printf 'user hook'" },
			],
		},
	];
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	installSessionHook(dir, SOURCE_RUNNER, ["claude"]);
	settings = read();
	const commands = settings.hooks.PreToolUse.flatMap((group) =>
		group.hooks.map((hook) => [group.matcher, hook.command]),
	);
	assert.deepEqual(commands.sort(), [
		["Edit", "printf 'user hook'"],
		["Edit|Write|MultiEdit|NotebookEdit", claudeGuardCommand(SOURCE_RUNNER)],
	]);
});

test("the guard hook runs the real guard: exit 2 while a request is open, 0 otherwise", async () => {
	const { claudeGuardCommand } = await import("../cli/claude-hooks.mjs");
	const { dir } = await tmpGitRepo();
	const command = claudeGuardCommand(`node ${JSON.stringify(CLI)}`);
	const idle = spawnSync("/bin/sh", ["-c", command], { cwd: dir, encoding: "utf8" });
	assert.equal(idle.status, 0, idle.stderr);
	await run(["review", "--via", "subagent"], { cwd: dir });
	const blocked = spawnSync("/bin/sh", ["-c", command], { cwd: dir, encoding: "utf8" });
	assert.equal(blocked.status, 2);
	assert.match(blocked.stderr, /a review is in flight/);
});

function execFileSyncGit(dir) {
	execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
}

// --- preflight: review.preflight ---

test("mergeConfig validates review.preflight and review.briefExclude", () => {
	assert.deepEqual(mergeConfig({}).review.preflight, []);
	assert.deepEqual(mergeConfig({}).review.briefExclude, []);
	assert.deepEqual(mergeConfig({ review: { preflight: ["npm run lint"] } }).review.preflight, [
		"npm run lint",
	]);
	assert.deepEqual(mergeConfig({ review: { briefExclude: ["**/*.lock"] } }).review.briefExclude, [
		"**/*.lock",
	]);
	for (const bad of ["npm run lint", [""], [1], ["a\nb"], [{}]]) {
		assert.throws(() => mergeConfig({ review: { preflight: bad } }), /review\.preflight/);
	}
	for (const bad of ["**/*.lock", [""], [1], ["a\nb"]]) {
		assert.throws(() => mergeConfig({ review: { briefExclude: bad } }), /review\.briefExclude/);
	}
});

test("preflight commands run in order before dispatch and are recorded as verify evidence", async () => {
	const { dir } = await tmpGitRepo({
		review: { preflight: ["echo PREFLIGHT_ONE && pwd", "echo PREFLIGHT_TWO"] },
	});
	const res = await run(["review", "--via", "subagent"], { cwd: path.join(dir, "docs") });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(
		res.stdout.indexOf("PREFLIGHT_ONE") < res.stdout.indexOf("PREFLIGHT_TWO") &&
			res.stdout.indexOf("PREFLIGHT_TWO") < res.stdout.indexOf("brief written to"),
		res.stdout,
	);
	assert.match(
		res.stdout,
		new RegExp(`^${fs.realpathSync(dir).replaceAll(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`, "m"),
		"runs from the repository root",
	);
	const events = readLedger(dir);
	const verifies = events.filter((e) => e.event === "verify");
	assert.deepEqual(
		verifies.map((e) => [e.cmd, e.exit]),
		[
			["sh -c echo PREFLIGHT_ONE && pwd", 0],
			["sh -c echo PREFLIGHT_TWO", 0],
		],
	);
	for (const verify of verifies) {
		assert.match(verify.snapshot, /^sha256:/);
		assert.match(verify.excerpt, /PREFLIGHT_/);
	}
	assert.ok(
		events.indexOf(verifies[1]) < events.findIndex((e) => e.event === "review-request"),
		"preflight is recorded before the request",
	);
});

test("the first failing preflight aborts the dispatch, even with --force, and records nothing further", async () => {
	const { dir } = await tmpGitRepo({
		review: { preflight: ["echo NOPE >&2; exit 3", "echo NEVER_RUNS"] },
	});
	for (const args of [[], ["--force", "--reason", "forced rounds still preflight"]]) {
		const res = await run(["review", "--via", "subagent", ...args], { cwd: dir });
		assert.equal(res.code, 1, args.join(" "));
		assert.match(res.stderr, /NOPE/);
		assert.equal(
			res.stderr.split("\n").at(-2),
			"stdd: preflight failed: echo NOPE >&2; exit 3 (exit 3) — fix it before dispatching a review",
		);
		assert.doesNotMatch(res.stdout, /NEVER_RUNS/);
	}
	const events = readLedger(dir);
	assert.deepEqual(
		events.filter((e) => e.event === "verify").map((e) => e.exit),
		[3, 3],
	);
	assert.equal(events.filter((e) => e.event === "review-request").length, 0);
});

test("--guard, --settle, --result, and --cleanup never run the preflight", async () => {
	const { dir } = await tmpGitRepo({ review: { preflight: ["echo RAN_PREFLIGHT; exit 9"] } });
	const guard = await run(["review", "--guard"], { cwd: dir });
	assert.deepEqual(guard, { code: 0, stdout: "", stderr: "" });
	const settle = await run(["review", "--settle"], { cwd: dir });
	assert.equal(settle.code, 1);
	assert.doesNotMatch(settle.stdout + settle.stderr, /RAN_PREFLIGHT|preflight/);
	const result = await run(["review", "--result", "-"], { cwd: dir });
	assert.equal(result.code, 1);
	assert.doesNotMatch(result.stdout + result.stderr, /RAN_PREFLIGHT|preflight/);
	const cleanup = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleanup.code, 0, cleanup.stderr);
	assert.doesNotMatch(cleanup.stdout + cleanup.stderr, /RAN_PREFLIGHT|preflight/);
	assert.equal(readLedger(dir).filter((e) => e.event === "verify").length, 0);
});

// --- the brief: spec delta and review.briefExclude ---

async function dispatchBrief(dir, args = []) {
	const res = await run(["review", "--via", "subagent", ...args], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	return fs.readFileSync(res.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
}

function section(brief, heading, next) {
	const start = brief.indexOf(heading);
	assert.ok(start >= 0, `${heading} is in the brief`);
	const end = next ? brief.indexOf(next, start) : brief.length;
	assert.ok(end > start, `${next} follows ${heading}`);
	return brief.slice(start, end);
}

test("the brief carries the spec delta before the plan and the spec-compliance rubric", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "docs", "spec.md"), "# Spec\n\nThe value is two. SPEC_SENTENCE\n");
	fs.mkdirSync(path.join(dir, "docs", "deep"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "deep", "über.md"), "# Ü\n\nUMLAUT_SENTENCE\n");
	await git("add", ".");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2; // IMPL_LINE\n");
	const brief = await dispatchBrief(dir);
	const delta = section(brief, "## Spec delta", "## Plan");
	assert.match(delta, /^\+The value is two\. SPEC_SENTENCE$/m);
	assert.match(delta, /^\+UMLAUT_SENTENCE$/m, "a C-quoted non-ASCII doc path still lands in the delta");
	assert.doesNotMatch(delta, /IMPL_LINE/, "code hunks stay out of the spec delta");
	assert.match(brief, /^\+UMLAUT_SENTENCE$/m);
	const diff = section(brief, "## Diff (against main)");
	assert.match(diff, /IMPL_LINE/);
	assert.match(diff, /SPEC_SENTENCE/, "the full diff still carries the docs hunk");
	assert.match(
		brief.replaceAll(/\s+/g, " "),
		/Spec compliance pass: for every behaviour sentence added or changed in the spec delta, find the test in the diff that proves it and the code that implements it\. A sentence with no proving test, or one the code contradicts, is a blocking finding named `docs ≠ code`; quote the sentence\./,
	);
	assert.match(
		brief,
		/Everything under "Prior review findings", "Governing docs", "Spec delta", "Plan",/,
	);
	const rubric = section(brief, "## Code quality rubric", "## Governing docs");
	assert.match(rubric, /\n\nSpec compliance pass:/, "the pass is its own paragraph");
});

test("the spec delta states when no canonical doc changed", async () => {
	const { dir } = await tmpGitRepo();
	const brief = await dispatchBrief(dir);
	const delta = section(brief, "## Spec delta", "## Plan");
	assert.match(delta, /\(no canonical docs changed on this branch\)/);
	assert.doesNotMatch(delta, /^\+/m);
});

test("review.briefExclude keeps hunks and untracked contents out of the brief but not out of review", async () => {
	const { dir, git } = await tmpGitRepo({ review: { briefExclude: ["generated/**"] } });
	fs.mkdirSync(path.join(dir, "generated"), { recursive: true });
	fs.writeFileSync(path.join(dir, "generated", "out.txt"), "base\n");
	await git("add", ".");
	await git("commit", "-qm", "generated base");
	fs.writeFileSync(path.join(dir, "generated", "out.txt"), "GEN_TRACKED_MARKER\n");
	fs.writeFileSync(path.join(dir, "generated", "new.txt"), "GEN_UNTRACKED_MARKER\n");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2; // IMPL_LINE\n");
	const brief = await dispatchBrief(dir);
	assert.doesNotMatch(brief, /GEN_TRACKED_MARKER|GEN_UNTRACKED_MARKER/);
	assert.match(brief, /IMPL_LINE/);
	const manifest = section(brief, "## Changed files", "## Diff");
	assert.match(manifest, /^A\tgenerated\/out\.txt \(excluded from diff by review\.briefExclude\)$/m);
	assert.match(manifest, /^A\?\tgenerated\/new\.txt \(excluded from diff by review\.briefExclude\)$/m);
	assert.match(manifest, /^M\timpl\.js$/m);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const graded = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(graded.code, 0, graded.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.ok(Object.hasOwn(review.files, "generated/out.txt"), "excluded paths are still fingerprinted");
	fs.writeFileSync(path.join(dir, "generated", "new.txt"), "edited after approval\n");
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review.stale, true, "editing an excluded file still stales the approval");
});
