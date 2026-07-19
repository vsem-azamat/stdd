import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mergeConfig, parseLedger, redGenuine } from "../cli/lib.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-ledger-test-"));
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

/** Git repo on branch `feature` with a docs change and an impl change vs main. */
async function tmpGitRepo() {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), JSON.stringify({ baseRef: "main" }));
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	fs.writeFileSync(path.join(dir, "impl.js"), "export {};\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	return { dir, git };
}

function readLedger(dir) {
	return parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
}

/** PATH prefix with a fake `gh` whose behavior is scripted per test. */
function fakeGh(script) {
	const bin = tmpDir();
	fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return {
		...process.env,
		PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
	};
}

// --- lib ---

test("parseLedger tolerates blank and corrupt lines", () => {
	const events = parseLedger('{"event":"note","text":"a"}\n\nnot json\n{"event":"note","text":"b"}\n');
	assert.equal(events.length, 2);
	assert.equal(events[1].text, "b");
});

test("redGenuine: exit 0 is never a genuine red", () => {
	assert.equal(redGenuine(0, "1 failing", "failing"), "no");
});

test("redGenuine: without a redPattern the answer is unknown", () => {
	assert.equal(redGenuine(1, "1 failing", null), "unknown");
});

test("redGenuine: redPattern separates test failure from env error", () => {
	assert.equal(redGenuine(1, "✖ 3 failing", "failing"), "yes");
	assert.equal(redGenuine(127, "tsc: command not found", "failing"), "no");
});

test("mergeConfig accepts a redPattern and rejects an invalid one", () => {
	assert.equal(mergeConfig({ redPattern: "\\d+ failing" }).redPattern, "\\d+ failing");
	assert.throws(() => mergeConfig({ redPattern: 42 }), /redPattern/);
	assert.throws(() => mergeConfig({ redPattern: "(" }), /redPattern/);
});

// --- recorders ---

test("stdd docs updated-first records the decision with branch and paths", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	assert.equal(res.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.event, "docs");
	assert.equal(event.decision, "updated-first");
	assert.deepEqual(event.paths, ["docs/domain/pricing.md"]);
	assert.equal(event.branch, "feature");
	assert.ok(event.ts);
});

test("stdd docs updated-first requires at least one path", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "updated-first"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /path/i);
});

test("stdd docs checked records paths and reason; reason is required", async () => {
	const { dir } = await tmpGitRepo();
	const bad = await run(["docs", "checked", "docs/domain/pricing.md"], { cwd: dir });
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /--reason/);
	const res = await run(
		["docs", "checked", "docs/domain/pricing.md", "--reason", "existing rule covers it"],
		{ cwd: dir },
	);
	assert.equal(res.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.decision, "checked");
	assert.equal(event.reason, "existing rule covers it");
});

test("stdd docs not-applicable requires a reason and takes no paths", async () => {
	const { dir } = await tmpGitRepo();
	assert.equal((await run(["docs", "not-applicable"], { cwd: dir })).code, 1);
	const res = await run(["docs", "not-applicable", "--reason", "lint-only change"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(readLedger(dir)[0].reason, "lint-only change");
});

test("stdd docs rejects an unknown decision", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "maybe"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /updated-first|checked|not-applicable/);
});

test("recorders need a git repository", async () => {
	const dir = tmpDir();
	const res = await run(["docs", "not-applicable", "--reason", "x"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /git repo/i);
});

test("stdd red passes the exit code through and records the run", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "node", "-e", "console.log('boom'); process.exit(3)"], {
		cwd: dir,
	});
	assert.equal(res.code, 3);
	assert.match(res.stdout, /boom/);
	const [event] = readLedger(dir);
	assert.equal(event.event, "red");
	assert.equal(event.exit, 3);
	assert.match(event.excerpt, /boom/);
	assert.equal(event.genuine, "unknown");
	assert.match(res.stderr, /redPattern/);
});

test("stdd red with a matching redPattern records genuine: yes", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "\\d+ failing" }),
	);
	await run(["red", "--", "node", "-e", "console.log('2 failing'); process.exit(1)"], { cwd: dir });
	assert.equal(readLedger(dir)[0].genuine, "yes");
});

test("stdd red flags an env error as not genuine under a redPattern", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "\\d+ failing" }),
	);
	const res = await run(
		["red", "--", "node", "-e", "console.error('tsc: not found'); process.exit(127)"],
		{
			cwd: dir,
		},
	);
	assert.equal(res.code, 127);
	assert.equal(readLedger(dir)[0].genuine, "no");
	assert.match(res.stderr, /not.*genuine|environment/i);
});

test("stdd red on a passing command records genuine: no — green is not red", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "node", "-e", ""], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(readLedger(dir)[0].genuine, "no");
	assert.match(res.stderr, /green, not red/i);
});

test("stdd verify records the run and passes the exit through", async () => {
	const { dir } = await tmpGitRepo();
	const ok = await run(["verify", "--", "node", "-e", "console.log('61 passing')"], { cwd: dir });
	assert.equal(ok.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.event, "verify");
	assert.equal(event.exit, 0);
	assert.match(event.excerpt, /61 passing/);
});

test("stdd red and verify require a command after --", async () => {
	const { dir } = await tmpGitRepo();
	assert.equal((await run(["red"], { cwd: dir })).code, 1);
	assert.equal((await run(["verify", "--"], { cwd: dir })).code, 1);
});

test("stdd note appends free-form handoff context", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["note", "workaround: build api before webapp typecheck"], { cwd: dir });
	assert.equal(res.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.event, "note");
	assert.match(event.text, /workaround/);
});

// --- root anchoring: the ledger and config belong to the repo, not the cwd ---

test("recorders run from a subdirectory write the root ledger", async () => {
	const { dir } = await tmpGitRepo();
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(sub, { recursive: true });
	const res = await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: sub });
	assert.equal(res.code, 1);
	assert.ok(!fs.existsSync(path.join(sub, ".stdd")), "no nested apps/api/.stdd may appear");
	assert.equal(readLedger(dir)[0].event, "red");
});

test("recorders read the root config (redPattern) from a subdirectory", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "\\d+ failing" }),
	);
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(sub, { recursive: true });
	await run(["red", "--", "node", "-e", "console.log('2 failing'); process.exit(1)"], { cwd: sub });
	assert.equal(readLedger(dir)[0].genuine, "yes");
});

test("status from a subdirectory reads the root ledger", async () => {
	const { dir } = await tmpGitRepo();
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(sub, { recursive: true });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: sub, env })).stdout);
	assert.equal(s.loop.red.done, true);
});

test("a leftover nested .stdd does not win over the toplevel's", async () => {
	const { dir } = await tmpGitRepo();
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(path.join(sub, ".stdd"), { recursive: true });
	await run(["note", "anchored"], { cwd: sub });
	assert.equal(readLedger(dir)[0].text, "anchored");
	assert.ok(!fs.existsSync(path.join(sub, ".stdd", "ledger.jsonl")));
});

test("without a toplevel .stdd, the nearest ancestor holding one wins", async () => {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	const pkg = path.join(dir, "packages", "a");
	fs.mkdirSync(path.join(pkg, ".stdd"), { recursive: true });
	fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "root.txt"), "x\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	const res = await run(["note", "package-scoped"], { cwd: path.join(pkg, "src") });
	assert.equal(res.code, 0);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd")), "the toplevel gains no .stdd");
	const events = parseLedger(fs.readFileSync(path.join(pkg, ".stdd", "ledger.jsonl"), "utf8"));
	assert.equal(events[0].text, "package-scoped");
});

// --- status ---

test("status reads the loop from git and the ledger, and names the next step", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const before = await run(["status", "--json"], { cwd: dir, env });
	assert.equal(before.code, 0);
	const s1 = JSON.parse(before.stdout);
	assert.equal(s1.branch, "feature");
	assert.equal(s1.loop.docs.done, true); // canonical docs changed in the diff
	assert.equal(s1.loop.red.done, false);
	assert.equal(s1.loop.impl.done, true); // non-doc change in the diff
	assert.equal(s1.loop.verify.done, false);
	assert.match(s1.next, /stdd red/);

	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	const mid = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(mid.loop.red.done, true);
	assert.match(mid.next, /stdd verify/);

	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const done = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(done.loop.verify.done, true);
	assert.equal(done.pr.state, "none");
	assert.match(done.next, /evidence|pr/i);
});

test("status ignores ledger events from other branches", async () => {
	const { dir, git } = await tmpGitRepo();
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	await git("checkout", "-qb", "other");
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.branch, "other");
	assert.equal(s.loop.red.done, false);
});

test("a verify recorded before the last red does not count", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.loop.verify.done, false);
});

test("status reports the branch PR and its check rollup via gh", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh(
		`cat <<'EOF'
{"number": 42, "url": "https://example.test/pr/42", "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}]}
EOF`,
	);
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.pr.state, "open");
	assert.equal(s.pr.number, 42);
	assert.equal(s.pr.checks.failure, 1);
	assert.match(s.next, /check|green/i);
});

test("status degrades to unknown when gh is unavailable", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh("exit 4"); // gh present but erroring unexpectedly
	const res = await run(["status", "--json"], { cwd: dir, env });
	assert.equal(res.code, 0);
	assert.equal(JSON.parse(res.stdout).pr.state, "unknown");
});

test("status human output is one screen ordered as the loop", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const res = await run(["status"], { cwd: dir, env });
	assert.equal(res.code, 0);
	const order = ["docs", "red", "impl", "verify", "pr:", "next:"];
	let last = -1;
	for (const token of order) {
		const idx = res.stdout.indexOf(token);
		assert.ok(idx > last, `"${token}" out of order in:\n${res.stdout}`);
		last = idx;
	}
});

// --- derivation: evidence and check-pr read the ledger ---

test("evidence prints the finished line from a recorded sentinel decision", async () => {
	const { dir, git } = await tmpGitRepo();
	// undo the docs change so the diff carries no canonical docs
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "revert docs");
	await run(["docs", "checked", "docs/domain/pricing.md", "--reason", "rule already covers it"], {
		cwd: dir,
	});
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(
		res.stdout.trim(),
		"Docs checked, no change needed: docs/domain/pricing.md — rule already covers it",
	);
});

test("evidence: the diff wins over a contradicted ledger claim", async () => {
	const { dir } = await tmpGitRepo();
	// ledger says not-applicable, but the diff changes a canonical doc
	await run(["docs", "not-applicable", "--reason", "just lint"], { cwd: dir });
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(res.stdout.trim(), "Docs updated first: docs/domain/pricing.md");
	assert.match(res.stderr, /ledger|contradict/i);
});

test("evidence without a ledger behaves exactly as before", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(res.stdout.trim(), "Docs updated first: docs/domain/pricing.md");
});

test("check-pr adds an advisory line when the body disagrees with the ledger", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs not applicable: implementation-only\n");
	const res = await run(["check-pr", body], { cwd: dir });
	assert.equal(res.code, 0, "advisory only — the gate's pass condition is unchanged");
	assert.match(res.stderr, /ledger/i);
	assert.match(res.stderr, /updated-first/);
});

test("check-pr stays silent when the body matches the recorded decision", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: docs/domain/pricing.md\n");
	const res = await run(["check-pr", body], { cwd: dir });
	assert.equal(res.code, 0);
	assert.ok(!/ledger/i.test(res.stderr), res.stderr);
});

// --- init ---

test("init gitignores the ledger", async () => {
	const dir = tmpDir();
	await exec("git", ["-C", dir, "init", "-q"]);
	const res = await run(["init", dir, "--tools", "codex"]);
	assert.equal(res.code, 0);
	const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.match(ignore, /^\.stdd\/ledger\.jsonl$/m);
	// idempotent: a second init adds no duplicate
	await run(["init", dir, "--tools", "codex"]);
	const again = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.equal(again.match(/ledger\.jsonl/g).length, 1);
});

// --- forgiving errors: recorders hint the corrected form ---

test("stdd docs with free text prints the three forms and a did-you-mean", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "updated-first: docs/domain/pricing.md (auto-release)"], {
		cwd: dir,
	});
	assert.equal(res.code, 1);
	assert.match(res.stderr, /did you mean.*stdd docs updated-first/s);
	assert.match(res.stderr, /stdd docs updated-first <paths…>/);
	assert.match(res.stderr, /stdd docs checked <paths…> --reason <why>/);
	assert.match(res.stderr, /stdd docs not-applicable --reason <why>/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing is recorded");
});

test("stdd docs not-applicable with a path suggests moving it into --reason", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "not-applicable", "lint-only cleanup"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /stdd docs not-applicable --reason/);
});

test("stdd red rejects prose after -- and records nothing", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "vitest: 3 api + 1 admin red tests"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /command and its arguments, never prose|not prose/i);
	assert.match(res.stderr, /sh -c/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing is recorded");
});

test("stdd red on a missing command records the env error and hints readiness", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "definitely-not-a-command-xyz"], { cwd: dir });
	assert.equal(res.code, 127);
	assert.equal(readLedger(dir)[0].exit, 127);
	assert.match(res.stderr, /doctor --readiness/);
});

// --- status: a declared slice is part of the loop's state ---

test("status reports a declared slice and names the postflight", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["slice", "new", "--frozen", "docs/**", "--allowed", "src/**"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });

	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.slice.declared, true);
	assert.deepEqual(s.slice.frozenPaths, ["docs/**"]);
	assert.deepEqual(s.slice.allowedPaths, ["src/**"]);
	assert.match(s.next, /stdd scope/);

	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /slice: {2}declared \(frozen: docs\/\*\*; allowed: src\/\*\*\)/);
	assert.match(human.stdout, /postflight: stdd scope/);
});

test("status without a slice reports declared: false and stays quiet", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.slice.declared, false);
	const human = await run(["status"], { cwd: dir, env });
	assert.ok(!/slice:/.test(human.stdout), "no slice line when none is declared");
});

// --- the durable plan: status reads .stdd/plan.md; stdd defer ---

test("status reports plan progress and names the next plan item after verify", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# Plan\n\n- [x] 1. docs edit\n- [x] 2. impl\n- [ ] 3. wire status output\n",
	);
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	// complete the loop so the oracle reaches the plan before "open the PR"
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const res = await run(["status", "--json"], { cwd: dir, env });
	assert.equal(res.code, 0);
	const s = JSON.parse(res.stdout);
	assert.equal(s.plan.present, true);
	assert.equal(s.plan.total, 3);
	assert.equal(s.plan.done, 2);
	assert.equal(s.plan.next.text, "3. wire status output");
	assert.match(s.next, /plan/);
	assert.match(s.next, /3\. wire status output/);

	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /plan: {3}2\/3 done — next: "3\. wire status output"/);
});

test("status: a checked [red:] item is unproven until a matching red is recorded", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "failing" }),
	);
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"- [x] parser rejects empty input [red: parser.test]\n",
	);
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const before = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(before.plan.done, 0);
	assert.equal(before.plan.unproven.length, 1);
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /unproven/);
	assert.match(human.stdout, /parser\.test/);

	await run(["red", "--", "node", "-e", "console.log('parser.test: 1 failing'); process.exit(1)"], {
		cwd: dir,
	});
	const after = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(after.plan.done, 1);
	assert.deepEqual(after.plan.unproven, []);
});

test("status without a plan stays quiet", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.plan.present, false);
	const human = await run(["status"], { cwd: dir, env });
	assert.ok(!/plan:/.test(human.stdout), "no plan line when no plan file exists");
});

test("stdd defer appends under ## Deferred, creating the file and section", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["defer", "glob", "dialect", "docs"], { cwd: dir });
	assert.equal(res.code, 0);
	await run(["defer", "second cut"], { cwd: dir });
	const content = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(content, /## Deferred\n\n- glob dialect docs\n- second cut\n/);

	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /2 deferred/);
});

// --- stdd ci: the settlement wait, head-pinned, stable-set threshold ---

/** Stateful fake gh: responses[i] answers call i+1; the last one repeats. */
function fakeGhSequence(responses) {
	const bin = tmpDir();
	const state = path.join(bin, "state");
	const cases = responses.map((json, i) => `${i + 1}) cat <<'EOF'\n${json}\nEOF\n;;`).join("\n");
	const script = [
		"#!/bin/sh",
		`n=$(cat "${state}" 2>/dev/null || echo 0)`,
		"n=$((n+1))",
		`echo $n > "${state}"`,
		`[ $n -gt ${responses.length} ] && n=${responses.length}`,
		"case $n in",
		cases,
		"esac",
	].join("\n");
	fs.writeFileSync(path.join(bin, "gh"), `${script}\n`, { mode: 0o755 });
	return {
		...process.env,
		PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
	};
}

const rollup = (head, checks) =>
	JSON.stringify({
		number: 7,
		url: "https://example.test/pr/7",
		headRefOid: head,
		statusCheckRollup: checks,
	});
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const passed = (name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });
const failedCheck = (name) => ({ name, status: "COMPLETED", conclusion: "FAILURE" });
const running = (name) => ({ name, status: "IN_PROGRESS", conclusion: "" });
const context = (name, state) => ({ context: name, state });

test("stdd ci reports the current head's checks and exits 0 on settled green", async () => {
	const { dir } = await tmpGitRepo();
	const head = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
	const env = fakeGhSequence([rollup(head, [passed("Lint"), context("GitGuardian", "SUCCESS")])]);
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /✓ Lint/);
	assert.match(res.stdout, /✓ GitGuardian/);
	assert.match(res.stdout, /green \(2 checks\)/);
	assert.ok(!/differs/.test(res.stderr), "no head warning when local HEAD matches");
});

test("stdd ci exits 1 on a terminal failure and warns when the local HEAD differs", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([rollup(HEAD_A, [passed("Lint"), failedCheck("Test")])]);
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ Test/);
	assert.match(res.stderr, /1 failing/);
	assert.match(res.stderr, /differs/);
});

test("stdd ci one-shot with pending checks is not settled", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([rollup(HEAD_A, [passed("Lint"), running("Test")])]);
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /not settled/);
	assert.match(res.stderr, /--watch/);
});

test("stdd ci --watch never settles on the first sighting of a check set", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([
		rollup(HEAD_A, [passed("Lint")]),
		rollup(HEAD_A, [passed("Lint"), passed("Test")]),
		rollup(HEAD_A, [passed("Lint"), passed("Test")]),
	]);
	const res = await run(["ci", "--watch", "--interval", "0"], { cwd: dir, env });
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /green \(2 checks\)/, "settled on the full set, not the early partial one");
});

test("stdd ci --watch exits the moment a check fails terminally", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([
		rollup(HEAD_A, [running("Lint"), running("Test")]),
		rollup(HEAD_A, [passed("Lint"), failedCheck("Test")]),
	]);
	const res = await run(["ci", "--watch", "--interval", "0"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /failing/);
});

test("stdd ci --watch restarts when the PR head moves", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([
		rollup(HEAD_A, [passed("Lint")]),
		rollup(HEAD_B, [passed("Lint")]),
		rollup(HEAD_B, [passed("Lint")]),
		rollup(HEAD_B, [passed("Lint")]),
	]);
	const res = await run(["ci", "--watch", "--interval", "0"], { cwd: dir, env });
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /head moved/);
	assert.match(res.stdout, new RegExp(HEAD_B.slice(0, 7)));
});

test("stdd ci --watch times out with pending checks named", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([rollup(HEAD_A, [running("Lint")])]);
	const res = await run(["ci", "--watch", "--interval", "0", "--timeout", "0"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /timed out/);
	assert.match(res.stderr, /Lint/);
});

test("stdd ci without a PR fails with a pointer, not a stack", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no PR for the current branch/);
});

test("init gitignores the plan alongside the ledger", async () => {
	const dir = tmpDir();
	await exec("git", ["-C", dir, "init", "-q"]);
	await run(["init", dir, "--tools", "codex"]);
	const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.match(ignore, /^\.stdd\/plan\.md$/m);
	assert.match(ignore, /^\.stdd\/ledger\.jsonl$/m);
	// an older checkout that already ignores the ledger gains only the plan line
	fs.writeFileSync(path.join(dir, ".gitignore"), ".stdd/ledger.jsonl\n");
	await run(["init", dir, "--tools", "codex"]);
	const upgraded = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.equal(upgraded.match(/ledger\.jsonl/g).length, 1);
	assert.match(upgraded, /^\.stdd\/plan\.md$/m);
});
