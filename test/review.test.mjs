import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseLedger } from "../cli/lib.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
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

async function tmpGitRepo(capabilities = ALL_CAPS, review) {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", capabilities, ...(review ? { review } : {}) }),
	);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 1;\n");
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
	return parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
}

/** A codex stand-in: writes the canned last message and exits. */
function stubCodex(lastMessage, exitCode = 0) {
	const bin = path.join(tmpDir(), "codex-stub");
	const quoted = `'${lastMessage.replaceAll("'", `'\\''`)}'`;
	fs.writeFileSync(
		bin,
		`#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf '%s' ${quoted} > "$out"
exit ${exitCode}
`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

const envWith = (bin) => ({ ...process.env, STDD_CODEX_BIN: bin });

test("review --via codex: approved verdict is recorded and closes the [review:] item", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const events = readLedger(dir);
	const request = events.find((e) => e.event === "review-request");
	const review = events.find((e) => e.event === "review");
	assert.equal(request.via, "codex");
	assert.match(request.brief, /^sha256:/);
	assert.equal(review.verdict, "approved");
	assert.equal(review.request, request.id);
	assert.equal(review.snapshot, request.snapshot);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[x\] closing review \[review:\]/);
});

test("review --via codex: a blocking finding means changes-requested, exit 1, item stays open", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "changes-requested");
	assert.equal(review.findings.length, 1);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review \[review:\]/);
});

test("review --via codex: malformed reviewer output is an error, never an approval", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex("LGTM, ship it");
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
});

test("review --via codex: a failing runner is an error verdict", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "ok", "findings": []}', 3);
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 2);
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("review --via codex without the crossCli capability fails without recording", async () => {
	const { dir } = await tmpGitRepo({ subagents: true, crossCli: false, worktrees: true });
	const res = await run(["review", "--via", "codex"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")));
});

test("review --via subagent prepares the brief; --result grades it against the open request", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.ok(briefPath && fs.existsSync(briefPath), prep.stdout);
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /## Plan/);
	assert.match(brief, /## Diff/);
	assert.match(brief, /closing review \[review:\]/);
	assert.match(brief, /export const v = 2/);

	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "approved");
	assert.equal(review.via, "subagent");
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[x\] closing review \[review:\]/);
});

test("review --result with a changed checkout records a stale error", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 3;\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /stale/);
});

test("review --result without an open request fails", async () => {
	const { dir } = await tmpGitRepo();
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "?", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no open review request/);
});

test("appending ledger events between request and result does not go stale", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	await run(["note", "worker finished"], { cwd: dir });
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
});

test("status --gate: changes-requested fails, approval passes, checked-but-unproven fails", async () => {
	const { dir } = await tmpGitRepo();
	// checked review item, no recorded review at all
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const unproven = await run(["status", "--gate"], { cwd: dir });
	assert.equal(unproven.code, 1, unproven.stdout);
	assert.match(unproven.stdout, /checked but/i);

	const blocking = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(blocking) });
	const changes = await run(["status", "--gate"], { cwd: dir });
	assert.equal(changes.code, 1);
	assert.match(changes.stdout, /requested changes/i);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	// the approval goes stale as soon as the reviewed work changes
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 4;\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1);
	assert.match(stale.stdout, /stale/i);
});

test("status names stdd review for an open [review:] item and shows the review line", async () => {
	const { dir } = await tmpGitRepo();
	const env = {
		...process.env,
		PATH: `${path.join(dir, "fake-bin")}:${process.env.PATH}`,
	};
	fs.mkdirSync(path.join(dir, "fake-bin"));
	fs.writeFileSync(
		path.join(dir, "fake-bin", "gh"),
		'#!/bin/sh\necho "no pull requests found" >&2; exit 1\n',
	);
	fs.chmodSync(path.join(dir, "fake-bin", "gh"), 0o755);
	await run(["docs", "not-applicable", "--reason", "test fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.match(s.next, /stdd review/);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const after = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(after.review.verdict, "approved");
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /review: approved via codex/);
});
