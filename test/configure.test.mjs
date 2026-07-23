import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-configure-"));
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

async function tmpGitRepo(capabilities = ALL_CAPS) {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", capabilities }),
	);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 1;\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2;\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	return { dir, git };
}

test("init records the generated targets in the manifest", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--ci", "github", "--session-hook"]);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(manifest.targets, {
		tools: ["claude"],
		ci: ["github"],
		hooks: false,
		sessionHook: true,
		stopHook: false,
	});
});

test("configure edits capabilities and route, preserves other keys, recompiles remembered targets", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--ci", "github"]);
	const cfgPath = path.join(dir, ".stdd", "config.json");
	const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
	cfg.redPattern = "MY_PATTERN";
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));

	const res = await run([
		"configure",
		dir,
		"--capabilities",
		"subagents,crossCli,worktrees",
		"--review-via",
		"codex",
	]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const after = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
	assert.equal(after.redPattern, "MY_PATTERN", "user keys survive configure");
	assert.deepEqual(after.capabilities, { subagents: true, crossCli: true, worktrees: true });
	assert.equal(after.review.via, "codex");
	// remembered targets are recompiled against the new profile
	const slice = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	assert.match(slice, /codex exec/, "crossCli block appears after the toggle");
	// files whose target is remembered are never dropped
	assert.ok(fs.existsSync(path.join(dir, ".github", "workflows", "stdd.yml")));
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.match(manifest.files[".github/workflows/stdd.yml"], /^sha256:/);
});

test("configure on a legacy manifest without targets never drops the CI workflow", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--ci", "github"]);
	// simulate an install made before targets were remembered
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	delete manifest.targets;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));

	const res = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(
		fs.existsSync(path.join(dir, ".github", "workflows", "stdd.yml")),
		"the tracked CI workflow survives configure on a legacy install",
	);
	const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	assert.match(after.files[".github/workflows/stdd.yml"], /^sha256:/);
});

test("legacy target inference reads manifest.files, not stray directories", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "codex"]);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	delete manifest.targets;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
	// a stray empty skills directory must not smuggle claude into the targets
	fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });

	const res = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(
		!fs.existsSync(path.join(dir, ".claude", "skills", "stdd-planning", "SKILL.md")),
		"claude skills must not appear for a codex-only legacy install",
	);
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "AGENTS-snippet.md")));
});

test("stop-hook fails open: no commits or broken config exits 0, never 1", async () => {
	// a repo with no commit — rev-parse has no branch to name
	const bare = tmpDir();
	await exec("git", ["-C", bare, "init", "-q", "-b", "main"]);
	fs.mkdirSync(path.join(bare, ".stdd"), { recursive: true });
	const noCommit = runStopHook(bare, "{}");
	assert.equal(noCommit.code, 0, noCommit.stderr);

	// unparseable config — an internal error must not trap the session
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), "{broken");
	const brokenCfg = runStopHook(dir, "{}");
	assert.equal(brokenCfg.code, 0, brokenCfg.stderr);

	// outside any repository — resolution must fail open, never exit 1
	const nowhere = tmpDir();
	const outside = runStopHook(nowhere, "{}");
	assert.equal(outside.code, 0, outside.stderr);
});

test("stop-hook fails open on a malformed payload — never a re-blocking loop", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	// with a readable payload the broken claim blocks…
	assert.equal(runStopHook(dir, "{}").code, 2);
	// …but an unreadable one cannot prove stop_hook_active is false — exit 0
	const malformed = runStopHook(dir, "{not json");
	assert.equal(malformed.code, 0, malformed.stderr);
});

test("configure rejects a route incompatible with the profile, config untouched", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude"]); // default profile: crossCli off
	const cfgPath = path.join(dir, ".stdd", "config.json");
	const before = fs.readFileSync(cfgPath, "utf8");
	const res = await run(["configure", dir, "--review-via", "codex"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
	assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "no partial write");
});

test("configure without an install fails with the pointer to init", async () => {
	const dir = tmpDir();
	const res = await run(["configure", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /stdd init/);
});

test("interactive configure defaults to the current values", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude"]);
	// subagents=default(current: on), crossCli=y, worktrees=default(on),
	// route=codex, stop hook=n
	const out = execFileSync(process.execPath, [CLI, "configure", dir], {
		input: "\ny\n\ncodex\nn\n",
		encoding: "utf8",
	});
	assert.match(out, /\[Y\/n\]/);
	const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(cfg.capabilities, { subagents: true, crossCli: true, worktrees: true });
	assert.equal(cfg.review.via, "codex");
});

test("init --stop-hook merges a Stop hook entry idempotently", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const settingsPath = path.join(dir, ".claude", "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.match(settings.hooks.Stop[0].hooks[0].command, /stdd stop-hook/);
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const again = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(again.hooks.Stop.length, 1, "idempotent");
});

// stop-hook reads its payload from stdin to EOF — execFile keeps stdin
// open, so these calls must use execFileSync with `input`
function runStopHook(dir, payload) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, "stop-hook"], {
			cwd: dir,
			input: payload,
			encoding: "utf8",
		});
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

test("stdd stop-hook: clean exits 0, broken claim exits 2, stop_hook_active never loops", async () => {
	const { dir } = await tmpGitRepo();
	const clean = runStopHook(dir, "{}");
	assert.equal(clean.code, 0, clean.stderr);

	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const broken = runStopHook(dir, "{}");
	assert.equal(broken.code, 2);
	assert.match(broken.stderr, /review/);

	const active = runStopHook(dir, '{"stop_hook_active": true}');
	assert.equal(active.code, 0, "a blocked stop is never re-blocked into a loop");
});

test("review --via claude dispatches the claude runner headless", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [ ] closing review [review:]\n",
	);
	const bin = path.join(tmpDir(), "claude-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
printf '%s' '{"summary": "sound", "findings": []}'
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "claude"], {
		cwd: dir,
		env: { ...process.env, STDD_CLAUDE_BIN: bin },
	});
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const events = parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
	const review = events.find((e) => e.event === "review");
	assert.equal(review.via, "claude");
	assert.equal(review.verdict, "approved");
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[x\] closing review/);
});

test("review --via claude requires the crossCli capability", async () => {
	const { dir } = await tmpGitRepo({ subagents: true, crossCli: false, worktrees: true });
	const res = await run(["review", "--via", "claude"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
});
