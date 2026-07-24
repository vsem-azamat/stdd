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
cat > /dev/null
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
	assert.match(brief, /## Changed files/);
	assert.match(brief, /^M\timpl\.js$/m, "the manifest names every changed file");
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

test("--timeout rejects non-integer and out-of-range values before any side effect", async () => {
	const { dir } = await tmpGitRepo();
	for (const bad of ["1.5", "0", "-3", "1e9", "nope"]) {
		const res = await run(["review", "--via", "codex", "--timeout", bad], { cwd: dir });
		assert.equal(res.code, 1, `--timeout ${bad} must fail at parse time`);
		assert.match(res.stderr, /--timeout/);
	}
	assert.ok(
		!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")),
		"no request may be recorded for an invalid flag",
	);
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

test("editing the plan after approval stales it; the auto-checked box does not", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout); // the [review:] box was auto-checked — still fresh
	fs.appendFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] a new scope item\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the reviewer never saw the current specification");
	assert.match(stale.stdout, /stale/i);
});

test("an unresolvable baseRef aborts the review before recording anything", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "origin/nowhere", capabilities: ALL_CAPS }),
	);
	const bin = stubCodex('{"summary": "s", "findings": []}');
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /cannot diff/i);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing recorded");
});

test("the brief carries untracked-file contents", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "brand-new.js"), "export const UNTRACKED_MARKER = 42;\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /UNTRACKED_MARKER/);
});

test("the brief carries the quality rubric and names changed governing docs", async () => {
	const { dir, git } = await tmpGitRepo();
	// a canonical doc changed on the branch is the spec delta
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "billing.md"), "# Billing rules\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: billing");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /## Code quality rubric/);
	assert.match(brief, /magic numbers/i);
	assert.match(brief, /type contracts/i);
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/billing\.md/);
});

test("the brief names an untracked governing doc as part of the spec delta", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "draft.md"), "# Draft\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/draft\.md/);
});

test("governing docs survive C-quoting: a non-ASCII doc name is still named", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "платежи.md"), "# Платежи\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: payments");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /- docs\/domain\/платежи\.md/);
	assert.doesNotMatch(brief, /none changed on this branch/);
});

test("governing docs cover renames: both old and new doc paths are named", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "old-name.md"), "# Spec\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: spec");
	await git("checkout", "-q", "main");
	await git("merge", "-q", "--ff-only", "feature");
	await git("checkout", "-q", "feature");
	await git("mv", "docs/domain/old-name.md", "docs/domain/new-name.md");
	await git("commit", "-qm", "docs: rename");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /- docs\/domain\/new-name\.md/);
	assert.match(brief, /- docs\/domain\/old-name\.md/);
});

test("paths with control chars or quotes are presented quoted, never raw", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// a double-quote and a tab are both legal in a Linux pathname; raw
	// interpolation would break the tab-delimited manifest and let a
	// crafted newline inject Markdown into the Governing docs list
	const quoted = 'docs/domain/a"b.md';
	fs.writeFileSync(path.join(dir, "docs", "domain", 'a"b.md'), "# Q\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: quoted");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	// JSON.stringify escapes the quote — the raw path never appears verbatim
	assert.ok(brief.includes(JSON.stringify(quoted)), "governing docs quote the path");
	assert.ok(!brief.includes(`- ${quoted}`), "the raw quote is not interpolated");
});

test("non-UTF-8 doc names stay distinct: byte-safe parsing never collapses paths", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// two distinct filenames that a UTF-8 decode folds to the same U+FFFD
	// string; byte-exact parsing must keep them as two governing docs
	const base = Buffer.from(`${dir}/docs/domain/`);
	fs.writeFileSync(Buffer.concat([base, Buffer.from([0xff]), Buffer.from(".md")]), "# A\n");
	fs.writeFileSync(Buffer.concat([base, Buffer.from([0xfe]), Buffer.from(".md")]), "# B\n");
	await git("add", "-A");
	await git("commit", "-qm", "docs: byte names");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	// byte-distinct not only in matching but in the display: each renders
	// its own escaped bytes, never a shared U+FFFD
	assert.match(brief, /- "docs\/domain\/\\xff\.md"/);
	assert.match(brief, /- "docs\/domain\/\\xfe\.md"/);
});

test("governing-doc globs with a non-ASCII literal match under byte-safe encoding", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", capabilities: ALL_CAPS, canonicalDocs: ["docs/über/**/*.md"] }),
	);
	fs.mkdirSync(path.join(dir, "docs", "über"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "über", "spec.md"), "# Spec\n");
	await git("add", "-A");
	await git("commit", "-qm", "docs: uber");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/über\/spec\.md/);
	assert.doesNotMatch(brief, /none changed on this branch/);
});

test("an untracked non-UTF-8 doc is fingerprinted byte-safely: a later edit stales the review", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// a non-UTF-8 untracked file: a UTF-8 decode would look it up under a
	// U+FFFD path, get a null fingerprint, and never notice a content change
	const p = Buffer.concat([Buffer.from(`${dir}/docs/domain/`), Buffer.from([0xff]), Buffer.from(".md")]);
	fs.writeFileSync(p, "# original\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	fs.writeFileSync(p, "# changed after the snapshot was recorded\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr); // stale — snapshot changed
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("a file named __proto__ is fingerprinted: a later edit stales the review", async () => {
	const { dir } = await tmpGitRepo();
	// a plain {} would route this through Object.prototype's __proto__ setter
	// and drop it from the snapshot; a null-prototype object keeps it
	fs.writeFileSync(path.join(dir, "__proto__"), "# original\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	fs.writeFileSync(path.join(dir, "__proto__"), "# changed after the snapshot was recorded\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr); // stale — snapshot changed
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("governing docs without a doc change name the configured globs instead", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/\*\*\/\*\.md/);
	assert.doesNotMatch(brief, /read these first/);
});

test("review request ids carry real entropy", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	const request = readLedger(dir).find((e) => e.event === "review-request");
	assert.match(request.id, /^rev-[0-9a-f]{8}$/);
});

test("tracked .stdd deliverables are under review — changing one stales the approval", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	// .stdd/config.json is committed in this fixture — a deliverable, not a
	// working artifact
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", capabilities: ALL_CAPS, redPattern: "changed" }),
	);
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, stale.stdout);
	assert.match(stale.stdout, /stale/i);
});

test("the brief skips symlinks and bounds large untracked files", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "secret.txt");
	fs.writeFileSync(outside, "OUTSIDE_SECRET_MARKER");
	fs.symlinkSync(outside, path.join(dir, "leak.txt"));
	fs.writeFileSync(path.join(dir, "big.txt"), `${"x".repeat(50_000)}END_MARKER`);
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.ok(!brief.includes("OUTSIDE_SECRET_MARKER"), "symlink content leaked into the brief");
	assert.match(brief, /\[truncated\]/);
	assert.ok(!brief.includes("END_MARKER"), "large file was read past the bound");
	// skipped or not, every untracked path is NAMED in the manifest —
	// nothing the reviewer was not told about may exist
	const manifestSection = brief.split("## Changed files")[1].split("## Diff")[0];
	assert.match(manifestSection, /leak\.txt.*skipped/);
	assert.match(manifestSection, /big\.txt/);
});

test("an unreadable dirty file aborts the review with the path named; status stays alive", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "aa-locked.txt"), "secret", { mode: 0o000 });
	// a review over content that cannot be read proves nothing — abort,
	// name the path, record nothing
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	assert.match(prep.stderr, /aa-locked\.txt/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing recorded");
	// the soft callers never crash on it
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout);
});

test("a readable file whose bytes spell the sentinel is still just content", async () => {
	const { dir } = await tmpGitRepo();
	// the sentinel lives outside the content-hash namespace — these exact
	// bytes must never be misclassified as an unreadable file
	fs.writeFileSync(path.join(dir, "odd.txt"), "unreadable:odd.txt");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
});

test("scope: a changed-but-still-unreadable file is never inherited dirt", async () => {
	const { dir } = await tmpGitRepo();
	const locked = path.join(dir, "locked.bin");
	fs.writeFileSync(locked, "v1", { mode: 0o000 });
	await run(["slice", "new", "--allowed", "impl.js"], { cwd: dir });
	// the owner flips the bits, changes the content, relocks
	fs.chmodSync(locked, 0o600);
	fs.writeFileSync(locked, "v2-changed");
	fs.chmodSync(locked, 0o000);
	const res = await run(["scope"], { cwd: dir });
	fs.chmodSync(locked, 0o600);
	assert.equal(res.code, 1, "the change happened outside the allowed scope");
});

test("a file turning unreadable after approval reads as stale", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "data.txt"), "readable\n");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.chmodSync(path.join(dir, "data.txt"), 0o000);
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the approval no longer covers what exists");
	fs.chmodSync(path.join(dir, "data.txt"), 0o600);
});

test("the review budget stops the loop after maxRounds changes-requested; errors never burn it", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			review: { via: "codex", maxRounds: 1 },
		}),
	);
	// an error verdict must not count toward the budget
	const malformed = stubCodex("not json at all");
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(malformed) });
	const blocking = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const first = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(blocking) });
	assert.equal(first.code, 1, "the error round did not burn the budget");

	const refused = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(blocking) });
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /budget/);
	assert.equal(
		readLedger(dir).filter((e) => e.event === "review-request").length,
		2,
		"the refused round records nothing",
	);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const forced = await run(["review", "--via", "codex", "--force"], {
		cwd: dir,
		env: envWith(clean),
	});
	assert.equal(forced.code, 0, forced.stdout + forced.stderr);
});

test("a stale approval reopens the review in plain status, not only in the gate", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "not-applicable", "--reason", "test fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 5;\n");
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir })).stdout);
	assert.equal(s.review.stale, true);
	assert.equal(s.plan.review.done, false, "a stale approval is not a done review");
	assert.match(s.next, /stdd review/);
});

test("a checkout that changes while the codex reviewer runs records stale", async () => {
	const { dir } = await tmpGitRepo();
	// this stand-in mutates the repo before answering — the approval it
	// returns is about a diff that does not exist anymore
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
printf 'mutated' >> "${path.join(dir, "impl.js")}"
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /stale/);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review/);
});

test("non-ASCII dirty filenames do not crash the review", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "тест-файл.txt"), "содержимое\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
});

test("binary dirty files are hashed by raw bytes, not lossy text decoding", async () => {
	const { dir } = await tmpGitRepo();
	// both byte sequences decode to the same replacement character — a
	// text-decoded hash cannot tell them apart
	fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0xc3]));
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0xc4]));
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the binary changed — the approval must go stale");
});

test("snapshots and brief hashes carry a single sha256: prefix", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	const request = readLedger(dir).find((e) => e.event === "review-request");
	assert.match(request.snapshot, /^sha256:[0-9a-f]{64}$/);
	assert.match(request.brief, /^sha256:[0-9a-f]{64}$/);
});

test("edits inside a wholly untracked directory stale the approval", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "newdir"));
	fs.writeFileSync(path.join(dir, "newdir", "mod.js"), "export const a = 1;\n");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.writeFileSync(path.join(dir, "newdir", "mod.js"), "export const a = 2;\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "untracked work changed — the approval must go stale");
});

test("non-ASCII untracked filenames still reach the brief", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "данные.txt"), "CYRILLIC_CONTENT_MARKER\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /CYRILLIC_CONTENT_MARKER/);
});

test("the brief travels to codex over stdin, not as one huge argv element", async () => {
	const { dir } = await tmpGitRepo();
	const side = path.join(tmpDir(), "stdin-capture.txt");
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > "${side}"
out=""
prev=""
last=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
  last="$a"
done
[ "$last" = "-" ] || { echo "prompt must be stdin (-)" >&2; exit 9; }
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const captured = fs.readFileSync(side, "utf8");
	assert.match(captured, /# Independent closing review/);
});

test("the brief file is owner-only in a private temp directory", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.equal(fs.statSync(briefPath).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(briefPath)).mode & 0o777, 0o700);
});

test("a branch switch while the reviewer runs records nothing", async () => {
	const { dir } = await tmpGitRepo();
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
git -C "${dir}" checkout -qb hijack
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /switched branches/i);
	const reviews = readLedger(dir).filter((e) => e.event === "review");
	assert.equal(reviews.length, 0, "no verdict may land on the hijacked branch");
});

test("an untracked symlink is hashed by its target path, not the target's content", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "target.txt");
	fs.writeFileSync(outside, "v1");
	fs.symlinkSync(outside, path.join(dir, "link.txt"));
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	// the file OUTSIDE the repository changes — the review must stay fresh
	fs.writeFileSync(outside, "v2");
	const still = await run(["status", "--gate"], { cwd: dir });
	assert.equal(still.code, 0, still.stdout);
});

test("--result never completes a codex request — no forged provenance", async () => {
	const { dir, git } = await tmpGitRepo();
	// leave a codex request open: the branch-switch guard aborts before
	// recording, then we return to the original branch
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
git -C "${dir}" checkout -qb elsewhere
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	await git("checkout", "-q", "feature");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "hand-fed", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /codex/);
	assert.equal(readLedger(dir).filter((e) => e.event === "review").length, 0);
});

test("auto-check follows parsePlan semantics — fenced and Deferred checkboxes never win", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		[
			"# P",
			"",
			"```",
			"- [ ] fenced example [review:]",
			"```",
			"",
			"- [x] impl",
			"- [ ] closing review [review:]",
			"",
			"## Deferred",
			"",
			"- [ ] deferred cut [review:]",
			"",
		].join("\n"),
	);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] fenced example/, "fenced checkbox untouched");
	assert.match(plan, /- \[ \] deferred cut/, "Deferred checkbox untouched");
	assert.match(plan, /- \[x\] closing review \[review:\]/, "the real item is the one checked");
});

test("auto-check skips items that merely mention [review:] in code", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [ ] tests cover the `[review:]` tag\n- [ ] closing review [review:]\n",
	);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] tests cover/, "the mention stays unchecked");
	assert.match(plan, /- \[x\] closing review \[review:\]/);
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
