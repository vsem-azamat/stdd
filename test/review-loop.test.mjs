import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
