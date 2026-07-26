import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	claudeStopCommand,
	codexStopCommand,
	installSessionHook,
	installStopHook,
} from "../cli/claude-hooks.mjs";
import { parseLedger } from "../cli/lib.mjs";

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PKG_ROOT, "cli", "stdd.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
const NPM_RUNNER = `npm exec --offline --package=@stdd/cli@${VERSION} -- stdd`;
const SOURCE_RUNNER = 'node "$(git rev-parse --show-toplevel)/cli/stdd.mjs"';
const STALE_CODEX_STOP_NORMALIZER =
	'const fs=require("node:fs");let value;try{value=JSON.parse(fs.readFileSync(0,"utf8"));}catch{}const valid=typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.keys(value).length===0||(value.decision==="block"&&typeof value.reason==="string"&&value.reason.length>0));process.stdout.write(valid?JSON.stringify(value)+"\\n":"{}\\n");';

function staleNormalizedCodexStopCommand(runner) {
	return `{ stdd_codex_stop_protocol=1; output="$(${runner} stop-hook --agent codex 2>/dev/null)" && printf '%s' "$output" | node -e '${STALE_CODEX_STOP_NORMALIZER}' 2>/dev/null || printf '{}\\n'; exit 0; }`;
}

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

test("the repository manifest remembers its installed lifecycle hooks", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, ".stdd", "manifest.json"), "utf8"));
	assert.equal(manifest.targets.sessionHook, true);
	assert.equal(manifest.targets.stopHook, true);
	for (const relative of [".claude/settings.json", ".codex/hooks.json"]) {
		const settings = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, relative), "utf8"));
		assert.ok(settings.hooks.SessionStart?.length > 0, relative);
		assert.ok(settings.hooks.Stop?.length > 0, relative);
	}
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

test("configure never restores a deleted remembered CI workflow, while init still can", async () => {
	const dir = tmpDir();
	const workflowPath = path.join(dir, ".github", "workflows", "stdd.yml");
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	await run(["init", dir, "--tools", "claude", "--ci", "github"]);
	fs.rmSync(workflowPath);

	const configured = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(configured.code, 0, configured.stdout + configured.stderr);
	assert.ok(!fs.existsSync(workflowPath), "configure must preserve the user's workflow deletion");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	assert.deepEqual(manifest.targets.ci, ["github"], "the selected CI target remains remembered");
	assert.ok(
		!Object.hasOwn(manifest.files, ".github/workflows/stdd.yml"),
		"a deliberately absent workflow is no longer tracked as generated",
	);

	const configuredAgain = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(configuredAgain.code, 0, configuredAgain.stdout + configuredAgain.stderr);
	assert.ok(!fs.existsSync(workflowPath), "later configure runs must not restore it either");

	const initialized = await run(["init", dir, "--tools", "claude", "--ci", "github"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	assert.ok(fs.existsSync(workflowPath), "explicit init --ci still installs the workflow");
});

test("configure rejects malformed remembered targets before any write", async () => {
	for (const malformed of [
		{
			tools: ["unknown-agent"],
			ci: [],
			hooks: false,
			sessionHook: false,
			stopHook: false,
		},
		{
			tools: ["claude"],
			ci: ["unknown-ci"],
			hooks: false,
			sessionHook: false,
			stopHook: false,
		},
		{
			tools: ["claude"],
			ci: [],
			hooks: "yes",
			sessionHook: false,
			stopHook: false,
		},
	]) {
		const dir = tmpDir();
		await run(["init", dir, "--tools", "claude"]);
		const configPath = path.join(dir, ".stdd", "config.json");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const configBefore = fs.readFileSync(configPath, "utf8");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		manifest.targets = malformed;
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		const manifestBefore = fs.readFileSync(manifestPath, "utf8");

		const res = await run([
			"configure",
			dir,
			"--capabilities",
			"crossCli,worktrees",
			"--review-via",
			"codex",
		]);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /manifest\.json.*targets/i);
		assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
		assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
	}
});

test("configure rejects a present malformed or unreadable manifest before any write", async () => {
	for (const corruptManifest of [
		(manifestPath) => fs.writeFileSync(manifestPath, "{}\n"),
		(manifestPath) => {
			fs.rmSync(manifestPath);
			fs.mkdirSync(manifestPath);
		},
	]) {
		const dir = tmpDir();
		await run(["init", dir, "--tools", "claude"]);
		const configPath = path.join(dir, ".stdd", "config.json");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const skillPath = path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md");
		const configBefore = fs.readFileSync(configPath, "utf8");
		const skillBefore = fs.readFileSync(skillPath, "utf8");
		corruptManifest(manifestPath);

		const res = await run([
			"configure",
			dir,
			"--capabilities",
			"subagents,crossCli,worktrees",
			"--review-via",
			"codex",
		]);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /manifest\.json/i);
		assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
		assert.equal(fs.readFileSync(skillPath, "utf8"), skillBefore);
	}
});

test("configure rejects invalid manifest identity and hashes before any write", async () => {
	for (const [name, mutate] of [
		["wrong generator", (manifest) => (manifest.generatedBy = "other")],
		["missing version", (manifest) => delete manifest.version],
		["malformed version", (manifest) => (manifest.version = "v1")],
		["missing hash", (manifest) => (manifest.files[".stdd/method.md"] = null)],
		["uppercase hash", (manifest) => (manifest.files[".stdd/method.md"] = `sha256:${"A".repeat(64)}`)],
	]) {
		const dir = tmpDir();
		await run(["init", dir, "--tools", "claude"]);
		const configPath = path.join(dir, ".stdd", "config.json");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const skillPath = path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md");
		const configBefore = fs.readFileSync(configPath, "utf8");
		const skillBefore = fs.readFileSync(skillPath, "utf8");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		mutate(manifest);
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		const manifestBefore = fs.readFileSync(manifestPath, "utf8");

		const result = await run([
			"configure",
			dir,
			"--capabilities",
			"subagents,crossCli,worktrees",
			"--review-via",
			"codex",
		]);
		assert.equal(result.code, 1, `${name}: ${result.stdout}${result.stderr}`);
		assert.match(
			result.stderr,
			/manifest\.json.*generatedBy|manifest\.json.*version|manifest\.json.*sha256/i,
		);
		assert.equal(fs.readFileSync(configPath, "utf8"), configBefore, name);
		assert.equal(fs.readFileSync(skillPath, "utf8"), skillBefore, name);
		assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore, name);
	}
});

test("canonical configure docs name the explicit Stop-hook exception", () => {
	const method = fs.readFileSync(path.join(PKG_ROOT, "method", "README.md"), "utf8");
	assert.match(method, /does not install or remove CI workflows/i);
	assert.match(method, /explicit exception:[\s\S]*--stop-hook[\s\S]*install/i);
});

test("configure restores only remembered Stop hooks, never pre-push or session hooks", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--hooks", "--session-hook", "--stop-hook"]);
	fs.rmSync(path.join(dir, ".stdd", "hooks", "pre-push"));
	fs.rmSync(path.join(dir, ".claude", "settings.json"));

	const res = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "hooks", "pre-push")));
	const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
	assert.deepEqual(Object.keys(settings.hooks), ["Stop"]);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(
		{
			hooks: manifest.targets.hooks,
			sessionHook: manifest.targets.sessionHook,
			stopHook: manifest.targets.stopHook,
		},
		{ hooks: true, sessionHook: true, stopHook: true },
		"configure preserves remembered targets without recreating pre-push/session hooks",
	);
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

test("filesystem target inference preserves Codex and GitLab without a manifest", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "codex", "--ci", "gitlab"]);
	fs.rmSync(path.join(dir, ".stdd", "manifest.json"));

	const res = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "stdd-planning", "SKILL.md")));
	assert.ok(fs.existsSync(path.join(dir, ".gitlab", "stdd.gitlab-ci.yml")));
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(manifest.targets.tools, ["codex"]);
	assert.deepEqual(manifest.targets.ci, ["gitlab"]);
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
	const nonObject = runStopHook(dir, "null");
	assert.equal(nonObject.code, 0, "a syntactically valid non-object payload also fails open");
});

test("configure --max-rounds sets the review budget and preserves the route", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude"]);
	const res = await run(["configure", dir, "--max-rounds", "3"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.equal(cfg.review.maxRounds, 3);
	assert.equal(cfg.review.via, "subagent", "the route is untouched");
	const bad = await run(["configure", dir, "--max-rounds", "x"]);
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /--max-rounds/);

	// an overflow must fail at parse time — Infinity serializes to null
	// and would corrupt the user's config
	const huge = await run(["configure", dir, "--max-rounds", "9".repeat(400)]);
	assert.equal(huge.code, 1);
	assert.match(huge.stderr, /--max-rounds/);
	const cfg2 = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.equal(cfg2.review.maxRounds, 3, "the config survives the rejected overflow");
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

test("init and configure support a no-dispatch profile without false gate or Stop claims", async () => {
	const { dir } = await tmpGitRepo();
	const initialized = await run([
		"init",
		dir,
		"--tools",
		"codex",
		"--capabilities",
		"worktrees",
		"--stop-hook",
	]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);

	const configured = await run(["configure", dir, "--capabilities", "worktrees"]);
	assert.equal(configured.code, 0, configured.stdout + configured.stderr);
	const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(config.capabilities, {
		subagents: false,
		crossCli: false,
		worktrees: true,
	});
	assert.equal(config.review.via, "subagent", "the unavailable default remains dormant, not claimed");

	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "# P\n\n- [x] impl\n- [ ] verify\n");
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
	assert.equal(runStopHook(dir, "{}").code, 0);
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
	// route=codex, budget=default(0), stop hook=n
	const out = execFileSync(process.execPath, [CLI, "configure", dir], {
		input: "\ny\n\ncodex\n\nn\n",
		encoding: "utf8",
	});
	assert.match(out, /\[Y\/n\]/);
	const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(cfg.capabilities, { subagents: true, crossCli: true, worktrees: true });
	assert.equal(cfg.review.via, "codex");
	assert.equal(cfg.review.maxRounds ?? 0, 0);
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
	again.hooks.Stop[0].hooks[0].command = "npx --no stdd stop-hook";
	fs.writeFileSync(settingsPath, JSON.stringify(again, null, "\t"));
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const migrated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(migrated.hooks.Stop[0].hooks[0].command, claudeStopCommand(NPM_RUNNER));
	migrated.hooks.Stop[0].hooks[0].command =
		"npm exec --offline --package=@stdd/cli@0.5.0 -- stdd stop-hook";
	fs.writeFileSync(settingsPath, JSON.stringify(migrated, null, "\t"));
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const repinned = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(repinned.hooks.Stop[0].hooks[0].command, claudeStopCommand(NPM_RUNNER));
});

test("generated Stop commands fail open when the project-local runner is unavailable", () => {
	const missing = "/definitely/missing/stdd-runner";
	const claude = spawnSync("/bin/sh", ["-c", claudeStopCommand(missing)], {
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(claude.status, 0);
	assert.equal(claude.stdout, "");
	assert.equal(claude.stderr, "");

	const codex = spawnSync("/bin/sh", ["-c", codexStopCommand(missing)], {
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(codex.status, 0);
	assert.deepEqual(JSON.parse(codex.stdout), {});
	assert.equal(codex.stderr, "");
});

test("the Codex Stop wrapper normalizes only valid continuation JSON and always exits zero", () => {
	const dir = tmpDir();
	const runner = path.join(dir, "fake-codex-stdd");
	fs.writeFileSync(
		runner,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
		'#!/bin/sh\nprintf \'%s\' "${STDD_FAKE_STDOUT-}"\nprintf \'%s\' "${STDD_FAKE_STDERR-}" >&2\nexit "${STDD_FAKE_EXIT:-0}"\n',
		{ mode: 0o755 },
	);
	const execute = ({ stdout = "", stderr = "hidden diagnostic", exit = "0" }) =>
		spawnSync("/bin/sh", ["-c", codexStopCommand(runner)], {
			input: '{"stop_hook_active":false}',
			encoding: "utf8",
			env: {
				...process.env,
				STDD_FAKE_STDOUT: stdout,
				STDD_FAKE_STDERR: stderr,
				STDD_FAKE_EXIT: exit,
			},
		});

	for (const { name, child, expected } of [
		{
			name: "valid block",
			child: ' { "decision": "block", "reason": "keep going" }\n',
			expected: { decision: "block", reason: "keep going" },
		},
		{
			name: "valid padded reason",
			child: '{"decision":"block","reason":"  keep going  "}',
			expected: { decision: "block", reason: "  keep going  " },
		},
		{ name: "valid continue", child: "{}\n", expected: {} },
		{ name: "malformed JSON", child: "not-json", expected: {} },
		{ name: "array schema", child: "[]", expected: {} },
		{ name: "unexpected decision", child: '{"decision":"allow"}', expected: {} },
		{ name: "missing block reason", child: '{"decision":"block"}', expected: {} },
		{ name: "empty block reason", child: '{"decision":"block","reason":""}', expected: {} },
		{
			name: "whitespace-only block reason",
			child: '{"decision":"block","reason":"  \\t\\n  "}',
			expected: {},
		},
		{
			name: "extra block key",
			child: '{"decision":"block","reason":"keep going","extra":true}',
			expected: {},
		},
		{ name: "empty stdout", child: "", expected: {} },
	]) {
		const result = execute({ stdout: child });
		assert.equal(result.status, 0, `${name}: wrapper exit`);
		assert.equal(result.stderr, "", `${name}: diagnostics are suppressed`);
		assert.deepEqual(JSON.parse(result.stdout), expected, `${name}: normalized payload`);
		assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, `${name}: canonical JSON output`);
	}

	const failed = execute({
		stdout: '{"decision":"block","reason":"must not survive"}',
		exit: "7",
	});
	assert.equal(failed.status, 0, "child nonzero is fail-open");
	assert.equal(failed.stderr, "");
	assert.equal(failed.stdout, "{}\n");
});

test("the Claude Stop wrapper preserves only an intentional block exit", () => {
	const dir = tmpDir();
	const runner = path.join(dir, "fake-stdd");
	fs.writeFileSync(
		runner,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
		"#!/bin/sh\nprintf 'intentional block\\n' >&2\nexit \"${STDD_FAKE_EXIT:-2}\"\n",
		{ mode: 0o755 },
	);
	const blocked = spawnSync("/bin/sh", ["-c", claudeStopCommand(runner)], {
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(blocked.status, 2);
	assert.equal(blocked.stderr, "intentional block\n");

	const broken = spawnSync("/bin/sh", ["-c", claudeStopCommand(runner)], {
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, STDD_FAKE_EXIT: "7" },
	});
	assert.equal(broken.status, 0);
	assert.equal(broken.stderr, "");
});

test("source-checkout hook runner stays idempotent", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				PostCompact: [
					{ hooks: [{ type: "command", command: `${SOURCE_RUNNER} status --local || true` }] },
				],
				Stop: [{ hooks: [{ type: "command", command: `${SOURCE_RUNNER} stop-hook` }] }],
			},
		}),
	);
	fs.writeFileSync(
		path.join(dir, ".codex", "hooks.json"),
		JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: `${SOURCE_RUNNER} stop-hook --agent codex` }] }],
			},
		}),
	);
	for (let i = 0; i < 2; i++) {
		installSessionHook(dir, SOURCE_RUNNER, ["claude", "codex"]);
		installStopHook(dir, SOURCE_RUNNER, ["claude", "codex"]);
	}
	const claude = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
	const codex = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
	assert.equal(claude.hooks.SessionStart.length, 1);
	assert.equal(claude.hooks.PostCompact, undefined);
	assert.equal(claude.hooks.Stop.length, 1);
	assert.equal(codex.hooks.SessionStart.length, 1);
	assert.equal(codex.hooks.Stop.length, 1);
	assert.equal(claude.hooks.Stop[0].hooks[0].command, claudeStopCommand(SOURCE_RUNNER));
	assert.equal(codex.hooks.Stop[0].hooks[0].command, codexStopCommand(SOURCE_RUNNER));
});

test("source-checkout Codex Stop migration removes the historical wrapper without user-hook loss", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const userCommand = "printf 'user Stop hook\\n'";
	const legacyCommand = `{ output="$(${SOURCE_RUNNER} stop-hook --agent codex 2>/dev/null)" && printf '%s\\n' "$output" || printf '{}\\n'; exit 0; }`;
	const currentCommand = codexStopCommand(SOURCE_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: legacyCommand },
								{ type: "command", command: userCommand },
							],
						},
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, SOURCE_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(migrated.hooks.Stop.length, 1, "the duplicate managed-only group is removed");
	assert.equal(commands.filter((command) => command === currentCommand).length, 1);
	assert.equal(commands.includes(legacyCommand), false);
	assert.equal(commands.filter((command) => command === userCommand).length, 1);
});

test("source-checkout Codex Stop migration replaces stale normalized wrappers with one strict boundary", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const userCommand = "printf 'user Stop hook\\n'";
	const staleCommand = staleNormalizedCodexStopCommand(SOURCE_RUNNER);
	const currentCommand = codexStopCommand(SOURCE_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.mkdirSync(path.join(dir, "cli"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "cli", "stdd.mjs"),
		'process.stdout.write(JSON.stringify({ decision: "block", reason: "keep going", extra: true }));\n',
	);
	assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: staleCommand },
								{ type: "command", command: userCommand },
							],
						},
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, SOURCE_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(migrated.hooks.Stop.length, 1, "the duplicate managed-only group is removed");
	assert.equal(commands.filter((command) => command === currentCommand).length, 1);
	assert.equal(commands.includes(staleCommand), false);
	assert.equal(commands.filter((command) => command === userCommand).length, 1);
	const [migratedCommand] = commands.filter((command) => command === currentCommand);
	const strict = spawnSync("/bin/sh", ["-c", migratedCommand], {
		cwd: dir,
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(strict.status, 0);
	assert.equal(strict.stderr, "");
	assert.equal(strict.stdout, "{}\n", "the migrated boundary rejects the stale extra-key schema");
});

test("versioned npm Codex Stop migration replaces a stale normalized wrapper", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const previousRunner = "npm exec --offline --package=@stdd/cli@0.6.0 -- stdd";
	const staleCommand = staleNormalizedCodexStopCommand(previousRunner);
	const currentCommand = codexStopCommand(NPM_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{ hooks: [{ type: "command", command: staleCommand }] },
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, NPM_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(migrated.hooks.Stop.length, 1);
	assert.deepEqual(commands, [currentCommand]);
});

test("Codex Stop migration collapses every known generated shape across runner families", () => {
	const legacyWrapper = (runner) =>
		`{ output="$(${runner} stop-hook --agent codex 2>/dev/null)" && printf '%s\\n' "$output" || printf '{}\\n'; exit 0; }`;

	for (const { name, previousRunner, targetRunner } of [
		{ name: "source to npm", previousRunner: SOURCE_RUNNER, targetRunner: NPM_RUNNER },
		{ name: "npm to source", previousRunner: NPM_RUNNER, targetRunner: SOURCE_RUNNER },
	]) {
		const dir = tmpDir();
		const hooksPath = path.join(dir, ".codex", "hooks.json");
		const userCommand = `printf '${name} user hook\\n'`;
		const currentCommand = codexStopCommand(targetRunner);
		const managedCommands = [
			`${previousRunner} stop-hook --agent codex`,
			legacyWrapper(previousRunner),
			staleNormalizedCodexStopCommand(previousRunner),
			codexStopCommand(previousRunner),
			currentCommand,
		];
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(
			hooksPath,
			`${JSON.stringify(
				{
					hooks: {
						Stop: managedCommands.map((command, index) => ({
							hooks: [
								{ type: "command", command },
								...(index === 0 ? [{ type: "command", command: userCommand }] : []),
							],
						})),
					},
				},
				null,
				"\t",
			)}\n`,
		);

		installStopHook(dir, targetRunner, ["codex"]);

		const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
		const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
		assert.equal(migrated.hooks.Stop.length, 1, `${name}: managed-only groups are removed`);
		assert.deepEqual(commands, [currentCommand, userCommand], `${name}: one current plus user hook`);
	}
});

test("Codex Stop migration preserves a custom wrapper using the same managed invocation", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const userCommand = "printf 'user Stop hook\\n'";
	const customCommand = `{ stdd_codex_stop_protocol=1; output="$(${SOURCE_RUNNER} stop-hook --agent codex 2>/dev/null)" && printf '%s' "$output" | node -e 'process.stdin.pipe(process.stdout)' 2>/dev/null || printf '{}\\n'; printf 'custom audit\\n' >&2; exit 0; }`;
	const currentCommand = codexStopCommand(SOURCE_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: customCommand },
								{ type: "command", command: userCommand },
							],
						},
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, SOURCE_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(commands.filter((command) => command === currentCommand).length, 1);
	assert.equal(commands.filter((command) => command === customCommand).length, 1);
	assert.equal(commands.filter((command) => command === userCommand).length, 1);
});

test("init recognizes a different @stdd/cli source checkout for offline hooks", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, "cli"), { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), '{"name":"@stdd/cli","version":"0.0.0"}');
	fs.writeFileSync(path.join(dir, "cli", "stdd.mjs"), "// source checkout marker\n");

	const res = await run(["init", dir, "--tools", "codex", "--session-hook"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
	assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, `${SOURCE_RUNNER} status --local || true`);
	assert.doesNotMatch(res.stderr, /project-local stdd binary is missing/);
});

// stop-hook reads its payload from stdin to EOF — execFile keeps stdin
// open, so these calls must use execFileSync with `input`
function runStopHook(dir, payload, agent = "claude") {
	try {
		const stdout = execFileSync(
			process.execPath,
			[CLI, "stop-hook", ...(agent === "codex" ? ["--agent", "codex"] : [])],
			{
				cwd: dir,
				input: payload,
				encoding: "utf8",
			},
		);
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

function assertCodexAllows(result, message) {
	assert.equal(result.code, 0, `${message}: ${result.stderr}`);
	assert.equal(result.stderr, "", `${message}: fail-open must stay silent on stderr`);
	assert.equal(result.stdout.trim(), "{}", `${message}: Codex must receive an explicit allow payload`);
	assert.deepEqual(JSON.parse(result.stdout), {}, `${message}: stdout must be valid JSON`);
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

	const nested = path.join(dir, "apps", "api");
	fs.mkdirSync(path.join(nested, ".stdd"), { recursive: true });
	const fromNested = runStopHook(nested, "{}");
	assert.equal(fromNested.code, 2, "the Git-root ledger wins over an accidental nested .stdd");
});

test("Codex stop-hook returns its Stop continuation protocol without a nonzero exit", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const blocked = runStopHook(dir, "{}", "codex");
	assert.equal(blocked.code, 0, blocked.stderr);
	const payload = JSON.parse(blocked.stdout);
	assert.equal(payload.decision, "block");
	assert.match(payload.reason, /review/i);

	const active = runStopHook(dir, '{"stop_hook_active": true}', "codex");
	assertCodexAllows(active, "a repeated Codex stop is allowed without another block");
});

test("Codex stop-hook prints a valid empty object on every fail-open branch", async () => {
	const { dir } = await tmpGitRepo();
	assertCodexAllows(runStopHook(dir, "{not json", "codex"), "malformed input");
	assertCodexAllows(runStopHook(dir, "null", "codex"), "non-object input");

	const outside = tmpDir();
	assertCodexAllows(runStopHook(outside, "{}", "codex"), "outside a repository");

	const { dir: missingState } = await tmpGitRepo();
	fs.rmSync(path.join(missingState, ".stdd"), { recursive: true });
	assertCodexAllows(runStopHook(missingState, "{}", "codex"), "repository without STDD state");

	const { dir: brokenConfig } = await tmpGitRepo();
	fs.writeFileSync(path.join(brokenConfig, ".stdd", "config.json"), "{broken");
	assertCodexAllows(runStopHook(brokenConfig, "{}", "codex"), "broken config");
});

test("review --via claude dispatches the claude runner headless", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [ ] closing review [review:]\n",
	);
	const bin = path.join(tmpDir(), "claude-stub");
	const argsPath = path.join(tmpDir(), "claude-args.txt");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
printf '%s\n' "$@" > "${argsPath}"
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
	assert.deepEqual(fs.readFileSync(argsPath, "utf8").trim().split("\n"), [
		"-p",
		"--safe-mode",
		"--tools",
		"Read,Glob,Grep",
		"--permission-mode",
		"dontAsk",
	]);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review/);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("review --via claude requires the crossCli capability", async () => {
	const { dir } = await tmpGitRepo({ subagents: true, crossCli: false, worktrees: true });
	const res = await run(["review", "--via", "claude"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
});
