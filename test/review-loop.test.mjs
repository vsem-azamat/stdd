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

/** `stdd review --guard` with an optional Claude hook payload on stdin. */
function guard(dir, payload = "", extra = []) {
	const res = spawnSync("node", [CLI, "review", "--guard", ...extra], {
		cwd: dir,
		encoding: "utf8",
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
	});
	return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

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
	const idle = guard(dir);
	assert.deepEqual(idle, { code: 0, stdout: "", stderr: "" });
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "the guard writes nothing");

	const bare = tmpDir();
	const outside = guard(bare);
	assert.deepEqual(outside, { code: 0, stdout: "", stderr: "" });
	assert.deepEqual(fs.readdirSync(bare), [], "the guard creates no .stdd/ outside a repository");
});

test("review --guard exits 2 with the request named while a review is in flight", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stderr);
	const request = readLedger(dir).find((e) => e.event === "review-request");
	const before = fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8");
	const blocked = guard(dir);
	assert.equal(blocked.code, 2);
	assert.equal(blocked.stdout, "");
	assert.equal(
		blocked.stderr,
		`stdd review: a review is in flight (request ${request.id}, via subagent) — wait for its verdict and record it with \`stdd review --result <file>\`; editing now would make the review stale. To abandon it run \`stdd review --cleanup\`.\n`,
	);
	assert.equal(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"), before);

	const nested = path.join(dir, "docs");
	assert.equal(guard(nested).code, 2, "from a subdirectory too");

	const cleanup = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleanup.code, 0, cleanup.stderr);
	assert.equal(guard(dir).code, 0);

	for (const extra of [["--settle"], ["--via", "subagent"], ["--cleanup"], ["--force"]]) {
		const res = guard(dir, "", extra);
		assert.equal(res.code, 1, extra.join(" "));
		assert.match(res.stderr, /--guard/);
	}
});

test("init --session-hook wires the Claude PreToolUse guard hook only when review.guardHook is on", async () => {
	const { claudeGuardCommand, installSessionHook } = await import("../cli/claude-hooks.mjs");
	const SOURCE_RUNNER = 'node "$(git rev-parse --show-toplevel)/cli/stdd.mjs"';
	const dir = tmpDir();
	execFileSyncGit(dir);
	const settingsPath = path.join(dir, ".claude", "settings.json");
	const read = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	const configPath = path.join(dir, ".stdd", "config.json");
	const setGuard = (value) => {
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.review = { ...(config.review ?? {}), guardHook: value };
		fs.writeFileSync(configPath, JSON.stringify(config, null, "\t"));
	};

	const off = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(off.code, 0, off.stderr);
	assert.doesNotMatch(off.stdout, /PreToolUse/);
	assert.equal(read().hooks.PreToolUse, undefined, "the guard hook is opt-in");
	assert.match((await run(["doctor", dir])).stdout, /guard hook not wired \(review\.guardHook is off\)/);

	setGuard(true);
	const first = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(first.code, 0, first.stderr);
	assert.match(
		first.stdout,
		/Wired the Claude Code PreToolUse hook \(Edit\|Write\|MultiEdit\|NotebookEdit → stdd review --guard --hook\)/,
	);
	let settings = read();
	assert.equal(settings.hooks.PreToolUse.length, 1);
	assert.equal(settings.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
	assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
	assert.match(
		settings.hooks.PreToolUse[0].hooks[0].command,
		/^npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+ -- stdd review --guard --hook$/,
		"an adopting repository gets the pinned package runner",
	);
	assert.equal(claudeGuardCommand(SOURCE_RUNNER), `${SOURCE_RUNNER} review --guard --hook`);
	assert.match(
		(await run(["doctor", dir])).stdout,
		/guard hook wired \(PreToolUse → stdd review --guard --hook\)/,
	);

	const second = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(second.code, 0, second.stderr);
	assert.match(second.stdout, /already carries the review guard hook/);
	assert.equal(read().hooks.PreToolUse.length, 1);

	// a hand-flipped key is reported as a mismatch until init runs again
	setGuard(false);
	assert.match((await run(["doctor", dir])).stdout, /guard hook wired but review\.guardHook is off/);
	const removed = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(removed.code, 0, removed.stderr);
	assert.match(removed.stdout, /Removed the managed Claude Code review guard hook/);
	assert.equal(read().hooks.PreToolUse, undefined);
	assert.ok(settings.hooks.SessionStart, "the session hook stays");
	setGuard(true);
	assert.match((await run(["doctor", dir])).stdout, /guard hook not wired but review\.guardHook is on/);

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
	installSessionHook(dir, SOURCE_RUNNER, ["claude"], { guardHook: true });
	settings = read();
	const commands = settings.hooks.PreToolUse.flatMap((group) =>
		group.hooks.map((hook) => [group.matcher, hook.command]),
	);
	assert.deepEqual(commands.sort(), [
		["Edit", "printf 'user hook'"],
		["Edit|Write|MultiEdit|NotebookEdit", claudeGuardCommand(SOURCE_RUNNER)],
	]);
	// removal leaves the user's hook alone
	installSessionHook(dir, SOURCE_RUNNER, ["claude"], { guardHook: false });
	assert.deepEqual(
		read().hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command)),
		["printf 'user hook'"],
	);
});

test("configure --guard-hook on|off sets review.guardHook and re-wires the hook in one step", async () => {
	const dir = tmpDir();
	execFileSyncGit(dir);
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const settingsPath = path.join(dir, ".claude", "settings.json");
	const configPath = path.join(dir, ".stdd", "config.json");
	const on = await run(["configure", dir, "--guard-hook", "on"]);
	assert.equal(on.code, 0, on.stdout + on.stderr);
	assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).review.guardHook, true);
	assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.PreToolUse.length, 1);
	const off = await run(["configure", dir, "--guard-hook", "off"]);
	assert.equal(off.code, 0, off.stdout + off.stderr);
	assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).review.guardHook, false);
	assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.PreToolUse, undefined);
	const bad = await run(["configure", dir, "--guard-hook", "maybe"]);
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /--guard-hook/);
	const wrongCommand = await run(["init", dir, "--guard-hook", "on"]);
	assert.equal(wrongCommand.code, 1);
	assert.throws(() => mergeConfig({ review: { guardHook: "yes" } }), /review\.guardHook/);
	assert.equal(mergeConfig({}).review.guardHook, false);
});

test("the guard hook blocks only writes inside the repository while a request is open", async () => {
	const { claudeGuardCommand } = await import("../cli/claude-hooks.mjs");
	const { dir } = await tmpGitRepo();
	const command = claudeGuardCommand(`node ${JSON.stringify(CLI)}`);
	const hook = (payload) =>
		spawnSync("/bin/sh", ["-c", command], {
			cwd: dir,
			encoding: "utf8",
			input: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
	const inside = path.join(dir, "impl.js");
	const outside = path.join(tmpDir(), "result.json");
	fs.symlinkSync(path.dirname(outside), path.join(dir, "escape"));
	const idle = hook({ tool_name: "Write", tool_input: { file_path: inside } });
	assert.equal(idle.status, 0, idle.stderr);

	await run(["review", "--via", "subagent"], { cwd: dir });
	const blocked = hook({ tool_name: "Edit", tool_input: { file_path: inside } });
	assert.equal(blocked.status, 2);
	assert.match(blocked.stderr, /a review is in flight/);
	assert.equal(hook({ tool_input: { file_path: "docs/new.md" } }).status, 2, "a relative repo path");
	assert.equal(hook({ tool_input: { file_path: path.join(dir, ".stdd", "plan.md") } }).status, 2);
	assert.equal(hook({ tool_input: { notebook_path: path.join(dir, "n.ipynb") } }).status, 2);
	assert.equal(hook({ tool_input: { file_path: path.join(dir, "deep", "er", "new.js") } }).status, 2);

	const allowed = hook({ tool_name: "Write", tool_input: { file_path: outside } });
	assert.deepEqual([allowed.status, allowed.stderr], [0, ""], "the result file lives outside the repo");
	assert.equal(
		hook({ tool_input: { file_path: path.join(dir, "escape", "r.json") } }).status,
		0,
		"a symlink out of the checkout is outside it",
	);
	assert.equal(hook("").status, 2, "no payload: the checkout is the target");
	assert.equal(hook("not json").status, 2, "an unreadable payload falls back to the checkout");
	for (const payload of [
		"null",
		"[]",
		'"x"',
		"{}",
		{ tool_input: {} },
		{ tool_input: [] },
		{ tool_input: "impl.js" },
		{ tool_input: { file_path: 7 } },
		{ tool_input: { file_path: "", notebook_path: path.join(dir, "n.ipynb") } },
	]) {
		assert.equal(hook(payload).status, 2, `blocks without a usable path: ${JSON.stringify(payload)}`);
	}
	assert.equal(
		hook({ tool_input: { file_path: "", notebook_path: outside } }).status,
		0,
		"the first non-empty path counts",
	);
	// without --hook the payload is never read, so a direct call cannot block
	// on an open stdin and the checkout is always the target
	const direct = guard(dir, { tool_input: { file_path: outside } });
	assert.equal(direct.code, 2, direct.stderr);
	const stray = guard(dir, "", ["--hook", "--settle"]);
	assert.equal(stray.code, 1);
	const hookAlone = await run(["review", "--hook"], { cwd: dir });
	assert.equal(hookAlone.code, 1);
	assert.match(hookAlone.stderr, /--hook .*--guard/);
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
	assert.deepEqual(guard(dir), { code: 0, stdout: "", stderr: "" });
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

// --- review follow-up: plan digest, lost briefs, verify freshness, brief details ---

test("a review event records the normalized plan digest", async () => {
	const { dir } = await tmpGitRepo();
	const { graded } = await approveWith(dir, []);
	assert.equal(graded.code, 0, graded.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.match(review.plan, /^sha256:[0-9a-f]{64}$/);
});

test("settle refuses a plan edit made alongside the advisory fix; the plain dispatch proceeds", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\nScope: impl must ALSO delete the database.\n\n- [x] impl\n- [ ] closing review [review:]\n",
	);
	await run(["verify", "--", "true"], { cwd: dir });
	const refused = await run(["review", "--settle"], { cwd: dir });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /plan changed/);
	assert.equal(readLedger(dir).filter((e) => e.event === "review").length, 1);
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 1, "the approval is stale, not settled");
	const dispatched = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(dispatched.code, 0, dispatched.stdout + dispatched.stderr);
	// ticking a box is not a plan edit: still settleable
	const { dir: ticked } = await tmpGitRepo();
	await approveWith(ticked, ADVISORY_IMPL);
	fs.writeFileSync(path.join(ticked, "impl.js"), "export const VALUE = 2;\n");
	fs.writeFileSync(
		path.join(ticked, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	await run(["verify", "--", "true"], { cwd: ticked });
	const settled = await run(["review", "--settle"], { cwd: ticked });
	assert.equal(settled.code, 0, settled.stderr);
});

test("settle refuses an approval recorded without a plan digest", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	fs.writeFileSync(
		ledgerPath,
		`${fs
			.readFileSync(ledgerPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const event = JSON.parse(line);
				if (event.event === "review") delete event.plan;
				return JSON.stringify(event);
			})
			.join("\n")}\n`,
	);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	await run(["verify", "--", "true"], { cwd: dir });
	const refused = await run(["review", "--settle"], { cwd: dir });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /digests/);
});

test("settle needs a green, current verify recorded after the approval", async () => {
	const { dir } = await tmpGitRepo();
	await run(["verify", "--", "true"], { cwd: dir });
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	const beforeApproval = await run(["review", "--settle"], { cwd: dir });
	assert.equal(beforeApproval.code, 1);
	assert.match(beforeApproval.stderr, /run `stdd verify -- <cmd>` on the settled checkout first/);

	const failing = await run(["verify", "--", "false"], { cwd: dir });
	assert.equal(failing.code, 1);
	const afterRed = await run(["review", "--settle"], { cwd: dir });
	assert.equal(afterRed.code, 1);
	assert.match(afterRed.stderr, /stdd verify/);

	await run(["verify", "--", "true"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 3;\n");
	const stale = await run(["review", "--settle"], { cwd: dir });
	assert.equal(stale.code, 1);
	assert.match(stale.stderr, /stdd verify/);

	// restoring the content the pre-approval verify saw does not revive it
	const { dir: restored } = await tmpGitRepo();
	fs.writeFileSync(path.join(restored, "impl.js"), "export const VALUE = 2;\n");
	await run(["verify", "--", "true"], { cwd: restored });
	fs.writeFileSync(path.join(restored, "impl.js"), "export const v = 2;\n");
	await approveWith(restored, ADVISORY_IMPL);
	fs.writeFileSync(path.join(restored, "impl.js"), "export const VALUE = 2;\n");
	const revived = await run(["review", "--settle"], { cwd: restored });
	assert.equal(revived.code, 1);
	assert.match(revived.stderr, /stdd verify/);
	assert.equal(readLedger(restored).filter((e) => e.event === "review").length, 1);
});

test("settle refuses while a review request is open", async () => {
	const { dir } = await tmpGitRepo();
	await approveWith(dir, ADVISORY_IMPL);
	fs.writeFileSync(path.join(dir, "other.js"), "export const o = 2;\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stderr);
	fs.writeFileSync(path.join(dir, "other.js"), "export const o = 1;\n");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	await run(["verify", "--", "true"], { cwd: dir });
	const refused = await run(["review", "--settle"], { cwd: dir });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /in flight/);
	assert.equal(readLedger(dir).filter((e) => e.event === "review").length, 1);
});

test("cleanup cancels a request whose private directory is gone, and the guard reopens", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	fs.rmSync(path.dirname(briefPath), { recursive: true, force: true });
	assert.equal(guard(dir).code, 2);
	const cleanup = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleanup.code, 0, cleanup.stdout + cleanup.stderr);
	assert.match(cleanup.stdout, /cancelled 1 request/);
	const cancelled = readLedger(dir).find((e) => e.event === "review-cancelled");
	assert.ok(cancelled, "a terminal cancellation was recorded");
	assert.match(cancelled.reason, /gone/);
	assert.equal(guard(dir).code, 0);
	const again = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(again.code, 0, again.stderr);
	assert.equal((await run(["review", "--cleanup"], { cwd: dir })).code, 0);
});

for (const recreate of [false, true]) {
	test(`cleanup cancels a request whose temp root is ${recreate ? "recreated" : "gone"}, and the guard reopens`, async () => {
		const { dir } = await tmpGitRepo();
		const tempRoot = tmpDir();
		const env = { ...process.env, TMPDIR: tempRoot };
		const prep = await run(["review", "--via", "subagent"], { cwd: dir, env });
		assert.equal(prep.code, 0, prep.stderr);
		assert.ok(prep.stdout.includes(fs.realpathSync(tempRoot)), "the brief lives under the scratch root");
		fs.rmSync(tempRoot, { recursive: true, force: true });
		if (recreate) fs.mkdirSync(tempRoot);
		// a process whose own TMPDIR is missing cannot take the ledger lock at
		// all; the request's recorded root vanishing is the case under test
		const after = recreate ? env : process.env;
		const resultPath = path.join(tmpDir(), "result.json");
		fs.writeFileSync(resultPath, '{"summary": "ok", "findings": []}');
		const result = await run(["review", "--result", resultPath], { cwd: dir, env: after });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /is gone/);
		assert.match(result.stderr, /--cleanup/);
		assert.doesNotMatch(result.stderr, /integrity/);
		const cleanup = await run(["review", "--cleanup"], { cwd: dir, env: after });
		assert.equal(cleanup.code, 0, cleanup.stdout + cleanup.stderr);
		assert.match(cleanup.stdout, /cancelled 1 request/);
		const cancelled = readLedger(dir).find((e) => e.event === "review-cancelled");
		assert.match(cancelled.reason, /gone/);
		assert.equal(guard(dir).code, 0);
	});
}

test("the spec delta names an untracked canonical doc", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "docs", "new-spec.md"), "# New\n\nNEW_SPEC_SENTENCE\n");
	const brief = await dispatchBrief(dir);
	const delta = section(brief, "## Spec delta", "## Plan");
	assert.match(delta, /docs\/new-spec\.md/);
	assert.doesNotMatch(delta, /no canonical docs changed/);
});

test("color.ui=always does not break the per-file split of the brief", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("config", "color.ui", "always");
	await git("config", "color.diff", "always");
	fs.writeFileSync(path.join(dir, "docs", "spec.md"), "# Spec\n\nCOLORED_SPEC_SENTENCE\n");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2; // COLORED_IMPL\n");
	const brief = await dispatchBrief(dir);
	const delta = section(brief, "## Spec delta", "## Plan");
	assert.match(delta, /COLORED_SPEC_SENTENCE/);
	assert.doesNotMatch(delta, /COLORED_IMPL/);
	assert.ok(!brief.includes("\u001b["), "no escape sequences reach the brief");
});

test("the settlement refusal is decided before the preflight runs", async () => {
	const { dir } = await tmpGitRepo({ review: { preflight: ["echo RAN_PREFLIGHT"] } });
	await approveWith(dir, ADVISORY_IMPL);
	const before = readLedger(dir).filter((e) => e.event === "verify").length;
	fs.writeFileSync(path.join(dir, "impl.js"), "export const VALUE = 2;\n");
	const refused = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /--settle/);
	assert.doesNotMatch(refused.stdout, /RAN_PREFLIGHT/);
	assert.equal(readLedger(dir).filter((e) => e.event === "verify").length, before);
});

test("a rename whose destination contains ' b/' is split on its rename lines", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, "notes.txt"),
		`${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n`,
	);
	await git("add", ".");
	await git("commit", "-qm", "notes");
	fs.mkdirSync(path.join(dir, "docs", "n b"), { recursive: true });
	await git("mv", "notes.txt", "docs/n b/spec.md");
	fs.appendFileSync(path.join(dir, "docs", "n b", "spec.md"), "RENAMED_SPEC_SENTENCE\n");
	await git("add", "-A");
	const brief = await dispatchBrief(dir);
	const delta = section(brief, "## Spec delta", "## Plan");
	assert.match(delta, /RENAMED_SPEC_SENTENCE/);
});
