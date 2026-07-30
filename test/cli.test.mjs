import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { codexStopCommand } from "../cli/claude-hooks.mjs";

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PKG_ROOT, "cli", "stdd.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
const NPM_RUNNER = `npm exec --offline --package=@stdd/cli@${VERSION} -- stdd`;
const sha256 = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmpRepo() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-test-"));
}

function snapshotTreeBytes(root) {
	const snapshot = {};
	const walk = (dir, relative = "") => {
		for (const entry of fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				snapshot[`${entryRelative}/`] = null;
				walk(entryPath, entryRelative);
			} else {
				snapshot[entryRelative] = fs.readFileSync(entryPath).toString("base64");
			}
		}
	};
	walk(root);
	return snapshot;
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

async function cleanupTransactionFixture(multiple) {
	const dir = tmpRepo();
	if (!multiple) {
		const initialized = await run(["init", dir, "--tools", "claude", "--ci", "github"]);
		assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
		return {
			dir,
			args: ["init", dir, "--tools", "claude"],
			sources: [".github/workflows/stdd.yml"],
		};
	}
	const initialized = await run(["init", dir, "--tools", "claude"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities.worktrees = false;
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	return {
		dir,
		args: ["init", dir, "--tools", "claude"],
		sources: [".stdd/playbooks/worktrees.md", ".claude/skills/stdd-worktrees/SKILL.md"],
	};
}

async function cleanupJournalFixture() {
	const dir = tmpRepo();
	const initialized = await run(["init", dir, "--tools", "claude"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const sourceRelative = ".stdd/method.md";
	const sourcePath = path.join(dir, sourceRelative);
	const sourceStat = fs.lstatSync(sourcePath);
	const parentStat = fs.lstatSync(path.dirname(sourcePath));
	const journalPath = path.join(dir, ".stdd", "cleanup-transaction.json");
	const journal = {
		version: 1,
		entries: [
			{
				source: sourceRelative,
				quarantine: `.stdd/.stdd-cleanup-${"a".repeat(32)}.tmp`,
				hash: sha256(fs.readFileSync(sourcePath)),
				parentDev: String(parentStat.dev),
				parentIno: String(parentStat.ino),
				fileDev: String(sourceStat.dev),
				fileIno: String(sourceStat.ino),
				phase: "planned",
				keepSource: false,
				reason: "",
			},
		],
	};
	fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(journalPath, 0o600);
	return { dir, journalPath };
}

test("repository development base policy stays aligned", () => {
	const config = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, ".stdd", "config.json"), "utf8"));
	const contributing = fs.readFileSync(path.join(PKG_ROOT, "CONTRIBUTING.md"), "utf8");
	const workflow = fs.readFileSync(path.join(PKG_ROOT, ".github", "workflows", "ci.yml"), "utf8");
	const pushTrigger = workflow.match(/\n {2}push:\n([\s\S]*?)\n {2}pull_request:/)?.[1] ?? "";
	assert.equal(config.baseRef, "origin/main");
	assert.match(contributing, /PRs against `main`/);
	assert.doesNotMatch(contributing, /`dev` integration branch/);
	assert.match(pushTrigger, /^ {4}branches:\s*\[main\]\s*$/m);
	assert.doesNotMatch(pushTrigger, /\bdev\b/);
});

test("init installs native Claude and Codex skills plus minimal instruction files", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "claude,codex"]);
	assert.equal(res.code, 0);
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "method.md")));
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "config.json")));
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "AGENTS-snippet.md")));
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "CLAUDE-snippet.md")));
	for (const relative of [
		[".claude", "skills", "stdd-brainstorming", "SKILL.md"],
		[".agents", "skills", "stdd-brainstorming", "SKILL.md"],
		[".claude", "skills", "stdd-start-change", "SKILL.md"],
		[".agents", "skills", "stdd-implement", "SKILL.md"],
		[".agents", "skills", "stdd-finish-change", "SKILL.md"],
	]) {
		assert.ok(fs.existsSync(path.join(dir, ...relative)), relative.join("/"));
	}
	const claudeSkill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-brainstorming", "SKILL.md"),
		"utf8",
	);
	const codexSkill = fs.readFileSync(
		path.join(dir, ".agents", "skills", "stdd-brainstorming", "SKILL.md"),
		"utf8",
	);
	assert.equal(codexSkill, claudeSkill, "one playbook contract compiles identically");
	assert.match(claudeSkill, /^---\nname: stdd-brainstorming\ndescription: .+\n---\n/);
	assert.match(claudeSkill, /generated by stdd v/);
	assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /\$stdd-start-change/);
	assert.match(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /\/stdd-start-change/);
	assert.ok(
		!fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").includes("debugging.md"),
		"always-on instructions route; native skill descriptions own the catalog",
	);
});

test("init installs Pi beside Claude and Codex without duplicating Agent Skills", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "claude,codex,pi"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);

	const piSnippetPath = path.join(dir, ".stdd", "PI-snippet.md");
	const piInstructionsPath = path.join(dir, ".pi", "APPEND_SYSTEM.md");
	const sharedSkillPath = path.join(dir, ".agents", "skills", "stdd-start-change", "SKILL.md");
	assert.ok(fs.existsSync(piSnippetPath));
	assert.ok(fs.existsSync(piInstructionsPath));
	assert.ok(fs.existsSync(sharedSkillPath));
	assert.ok(!fs.existsSync(path.join(dir, ".pi", "skills")));
	assert.match(fs.readFileSync(piSnippetPath, "utf8"), /\/skill:stdd-start-change/);
	assert.match(fs.readFileSync(piInstructionsPath, "utf8"), /\/skill:stdd-finish-change/);
	assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /\$stdd-start-change/);

	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(manifest.targets.tools, ["claude", "codex", "pi"]);
	assert.match(manifest.files[".stdd/PI-snippet.md"], /^sha256:/);
	assert.match(manifest.files[".agents/skills/stdd-start-change/SKILL.md"], /^sha256:/);
	assert.ok(!Object.keys(manifest.files).some((file) => file.startsWith(".pi/skills/")));

	const before = snapshotTreeBytes(dir);
	const repeated = await run(["init", dir, "--tools", "claude,codex,pi"]);
	assert.equal(repeated.code, 0, repeated.stdout + repeated.stderr);
	assert.deepEqual(snapshotTreeBytes(dir), before);

	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "order.md"), "Canonical behavior.\n");
	const doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
	assert.match(doctor.stdout, /✓ \.pi\/APPEND_SYSTEM\.md carries the STDD section/);
});

test("Pi-only init uses its own router and the shared Agent Skills registry", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "pi", "--capabilities", "crossCli"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(fs.existsSync(path.join(dir, ".pi", "APPEND_SYSTEM.md")));
	assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "stdd-planning", "SKILL.md")));
	assert.ok(!fs.existsSync(path.join(dir, "AGENTS.md")));
	assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.md")));
	const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.equal(config.review.via, "claude");
});

test("init installs the pr-green playbook as a skill and lists it for codex", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex"]);
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "playbooks", "pr-green.md")));
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-pr-green", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /terminal-green|terminal green/i);
	const codexSkill = fs.readFileSync(
		path.join(dir, ".agents", "skills", "stdd-pr-green", "SKILL.md"),
		"utf8",
	);
	assert.equal(codexSkill, skill);
});

test("init --hooks writes a user-owned pre-push hook running stdd check", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "codex", "--hooks"]);
	assert.equal(res.code, 0);
	const hookPath = path.join(dir, ".stdd", "hooks", "pre-push");
	const hook = fs.readFileSync(hookPath, "utf8");
	assert.match(hook, /stdd check/);
	assert.ok(hook.includes(`${NPM_RUNNER} check`));
	assert.ok(!hook.includes("npx"), "offline hooks never resolve a registry package");
	assert.ok(!/gh |check-pr/.test(hook), "the hook stays fast and offline");
	assert.ok(fs.statSync(hookPath).mode & 0o111, "the hook is executable");
	assert.match(res.stdout, /core\.hooksPath/);
	assert.match(res.stderr, /no project-local stdd binary.*save-exact @stdd\/cli/i);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.ok(!(".stdd/hooks/pre-push" in manifest.files), "user-owned — not manifest-tracked");
});

test("init --hooks never overwrites an existing hook", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex", "--hooks"]);
	const hookPath = path.join(dir, ".stdd", "hooks", "pre-push");
	fs.appendFileSync(hookPath, "npm run my-own-step\n");
	await run(["init", dir, "--tools", "codex", "--hooks"]);
	assert.match(fs.readFileSync(hookPath, "utf8"), /my-own-step/);
});

test("init --hooks re-pins an untouched generated hook from an older release", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex", "--hooks"]);
	const hookPath = path.join(dir, ".stdd", "hooks", "pre-push");
	const old = fs.readFileSync(hookPath, "utf8").replace(`@stdd/cli@${VERSION}`, "@stdd/cli@0.5.0");
	fs.writeFileSync(hookPath, old);
	await run(["init", dir, "--tools", "codex", "--hooks"]);
	assert.ok(fs.readFileSync(hookPath, "utf8").includes(`${NPM_RUNNER} check`));
});

test("plain init writes no hooks; doctor reports hook wiring informationally", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "hooks")));
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "a.md"), "Present tense.\n");
	const without = await run(["doctor", dir]);
	assert.equal(without.code, 0, without.stdout + without.stderr);
	assert.match(without.stdout, /hook not installed|no pre-push hook/i);
	await run(["init", dir, "--tools", "codex", "--hooks"]);
	const withHook = await run(["doctor", dir]);
	assert.equal(withHook.code, 0, withHook.stdout + withHook.stderr);
	assert.match(withHook.stdout, /pre-push hook/i);
});

test("init installs the investigation playbook as a skill and lists it for codex", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex"]);
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "playbooks", "investigation.md")));
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-investigation", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /read-only|no file edits/i);
	assert.match(skill, /hypothesis is not a diagnosis/i);
	assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "stdd-investigation", "SKILL.md")));
});

test("init generates the project-log retrieval rule for agents", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	const snippet = fs.readFileSync(path.join(dir, ".stdd", "AGENTS-snippet.md"), "utf8");
	assert.match(snippet, /[Dd]o not search the project log/);
	assert.match(snippet, /explicitly asks/);
});

test("init compiles a disabled project-log policy into method and agent routing", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		`${JSON.stringify({ projectLog: { enabled: false } }, null, "\t")}\n`,
	);

	const initialized = await run(["init", dir, "--tools", "codex"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const snippet = fs.readFileSync(path.join(dir, ".stdd", "AGENTS-snippet.md"), "utf8");
	assert.match(snippet, /does not use a project log/i);
	assert.match(snippet, /Do not create or search/i);
	assert.doesNotMatch(snippet, /authority: non-canonical/);

	const method = fs.readFileSync(path.join(dir, ".stdd", "method.md"), "utf8");
	assert.match(method, /^# Repository policy: no project log/);
	assert.match(method, /projectLog\.enabled.*false/);
	assert.ok(
		method.indexOf("Repository policy: no project log") < method.indexOf("# The STDD Method"),
		"repository policy must precede generic method guidance",
	);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.equal(manifest.files[".stdd/method.md"], sha256(method));

	fs.mkdirSync(path.join(dir, "docs", "project"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "project", "deferred.md"), "Deferred.\n");
	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1);
	assert.match(checked.stderr, /docs\/project\/deferred\.md/);
	assert.match(checked.stderr, /projectLog\.enabled is false/);
	const diagnosed = await run(["doctor", dir]);
	assert.equal(diagnosed.code, 1);
	assert.match(diagnosed.stdout, /tracked project-log file/);
	assert.match(diagnosed.stdout, /projectLog\.enabled is false/);
});

test("the default project-log policy keeps dated project records permitted", async () => {
	const dir = tmpRepo();
	const initialized = await run(["init", dir, "--tools", "codex"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	fs.mkdirSync(path.join(dir, "docs", "project"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "project", "deferred.md"), "Deferred.\n");
	const checked = await run(["check", dir]);
	assert.equal(checked.code, 0, checked.stdout + checked.stderr);
});

test("changing the project-log policy makes generated method and routing stale", async () => {
	const dir = tmpRepo();
	const initialized = await run(["init", dir, "--tools", "codex"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.projectLog.enabled = false;
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);

	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1);
	assert.match(checked.stderr, /\.stdd\/method\.md/);
	assert.match(checked.stderr, /does not match the canonical method shipped by this CLI/);
	assert.match(checked.stderr, /\.stdd\/AGENTS-snippet\.md/);
	assert.match(checked.stderr, /does not match the current repository policy/);
	assert.match(checked.stderr, /re-run stdd init/);
});

test("init is idempotent and preserves an existing config", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const configPath = path.join(dir, ".stdd", "config.json");
	fs.writeFileSync(configPath, JSON.stringify({ temporalPhrases: ["formerly"] }));
	const res = await run(["init", dir, "--tools", "claude"]);
	assert.equal(res.code, 0);
	assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).temporalPhrases, ["formerly"]);
});

test("init --ci github writes the stdd workflow with a live body fetch", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "claude", "--ci", "github"]);
	assert.equal(res.code, 0);
	const wf = fs.readFileSync(path.join(dir, ".github", "workflows", "stdd.yml"), "utf8");
	assert.match(wf, /generated by stdd v/);
	assert.match(wf, /types: \[opened, edited, synchronize, reopened\]/);
	assert.match(wf, /fetch-depth: 0/);
	assert.match(wf, /actions\/setup-node@v4/);
	assert.match(wf, /node-version: 22/);
	assert.match(wf, /set -o pipefail/);
	assert.match(wf, /node --input-type=module/);
	assert.ok(!wf.includes("gh api"), "the generated workflow must not depend on the gh CLI");
	assert.ok(!/\$\{(?!\{)/.test(wf), "no JS template literals in the shell script (SC2016)");
	assert.ok(
		!wf.includes("github.event.pull_request.body"),
		"the generated workflow must not read the frozen event payload body",
	);
	assert.ok(wf.includes(`@stdd/cli@${VERSION} check .`));
	assert.ok(wf.includes(`@stdd/cli@${VERSION} check-pr`));
	assert.ok(!/@stdd\/cli (?:check|check-pr)/.test(wf), "every generated CI invocation is pinned");
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.match(manifest.files[".github/workflows/stdd.yml"], /^sha256:/);
});

test("init --ci gitlab writes an includeable live-MR adapter", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "codex", "--ci", "gitlab"]);
	assert.equal(res.code, 0, res.stderr);
	const file = path.join(dir, ".gitlab", "stdd.gitlab-ci.yml");
	const ci = fs.readFileSync(file, "utf8");
	assert.match(ci, /image: node:22/);
	assert.match(ci, /GIT_DEPTH: "0"/);
	assert.match(ci, /CI_API_V4_URL/);
	assert.match(ci, /CI_MERGE_REQUEST_IID/);
	assert.match(ci, /CI_MERGE_REQUEST_DIFF_BASE_SHA/);
	assert.match(ci, /set -o pipefail/);
	assert.match(ci, /\|\s*npx --yes @stdd\/cli@[^\s]+ check-pr - --base/);
	assert.doesNotMatch(ci, /mktemp|body_file|check-pr "\$body_file"/);
	assert.ok(ci.includes(`@stdd/cli@${VERSION} check .`));
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.match(manifest.files[".gitlab/stdd.gitlab-ci.yml"], /^sha256:/);
});

test("generated GitLab API fetch targets the merge request project for fork MRs", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "codex", "--ci", "gitlab"]);
	assert.equal(res.code, 0, res.stderr);
	const ci = fs.readFileSync(path.join(dir, ".gitlab", "stdd.gitlab-ci.yml"), "utf8");
	const inline = ci.match(/node --input-type=module -e '\n([\s\S]*?)\n {6}' \| npx/);
	assert.ok(inline, "the generated inline GitLab API fetch script is extractable");

	const harness = `
globalThis.fetch = async (url, options) => {
	if (options.headers["JOB-TOKEN"] !== process.env.CI_JOB_TOKEN) {
		throw new Error("missing GitLab job token");
	}
	process.stderr.write("FETCH_URL=" + url + "\\n");
	return {
		ok: true,
		status: 200,
		json: async () => ({ description: "Docs checked, no change needed: README.md" }),
	};
};
${inline[1]}
`;
	const { stdout, stderr } = await exec("node", ["--input-type=module", "-e", harness], {
		env: {
			...process.env,
			CI_API_V4_URL: "https://gitlab.example/api/v4",
			CI_PROJECT_ID: "source/group",
			CI_MERGE_REQUEST_PROJECT_ID: "target/group",
			CI_MERGE_REQUEST_IID: "41",
			CI_JOB_TOKEN: "test-token",
		},
	});

	assert.equal(stdout, "Docs checked, no change needed: README.md");
	assert.match(
		stderr,
		/FETCH_URL=https:\/\/gitlab\.example\/api\/v4\/projects\/target%2Fgroup\/merge_requests\/41/,
	);
	assert.doesNotMatch(stderr, /source%2Fgroup/);
});

test("a no-file CI adapter writes no provider file and prints the portable contract", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "codex", "--ci", "generic"]);
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /Portable CI contract for generic/);
	assert.match(res.stdout, /check-pr - --base/);
	assert.ok(!fs.existsSync(path.join(dir, ".github")));
	assert.ok(!fs.existsSync(path.join(dir, ".gitlab")));
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(manifest.targets.ci, ["generic"]);
});

test("plain init never touches .github", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	assert.ok(!fs.existsSync(path.join(dir, ".github")));
});

test("init accepts registered CI adapters, rejects unknown values, and keeps --ci init-only", async () => {
	const dir = tmpRepo();
	const gitlab = await run(["init", dir, "--ci", "gitlab"]);
	assert.equal(gitlab.code, 0);
	const bad = await run(["init", dir, "--ci", "circle"]);
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /unknown ci/i);
	assert.equal((await run(["check", dir, "--ci", "github"])).code, 1);
});

test("init rejects duplicate adapter selections before creating durable state", async () => {
	for (const args of [
		["--tools", "claude,claude"],
		["--ci", "github,github"],
	]) {
		const dir = tmpRepo();
		const res = await run(["init", dir, ...args]);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /duplicate adapter IDs/);
		assert.ok(!fs.existsSync(path.join(dir, ".stdd")));
	}
});

test("doctor flags a workflow validating the frozen payload body without an edited trigger", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
	const stale = [
		"on:",
		"  pull_request:",
		"    types: [opened, synchronize]",
		"jobs:",
		"  stdd:",
		"    steps:",
		"      - env:",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
		"          PR_BODY: ${{ github.event.pull_request.body }}",
		"        run: printf '%s' \"$PR_BODY\" | npx @stdd/cli check-pr -",
		"",
	].join("\n");
	fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), stale);
	const res = await run(["doctor", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ .*frozen event payload|✗ .*body edits will not be re-checked/i);

	fs.writeFileSync(
		path.join(dir, ".github", "workflows", "ci.yml"),
		stale.replace("types: [opened, synchronize]", "types: [opened, edited, synchronize]"),
	);
	const ok = await run(["doctor", dir]);
	assert.ok(!/body edits will not be re-checked/i.test(ok.stdout));
});

test("doctor flags a PR template whose placeholder would pass the evidence gate", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
	const tpl = path.join(dir, ".github", "pull_request_template.md");
	fs.writeFileSync(tpl, "## Summary\n\nDocs updated first: <fill in>\n");
	const res = await run(["doctor", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ .*pull_request_template.*evidence/i);

	fs.writeFileSync(tpl, "## Summary\n\n> Docs updated first: <fill in>\n");
	const ok = await run(["doctor", dir]);
	assert.ok(!/pull_request_template.*evidence/i.test(ok.stdout));
});

test("check reports artifacts and temporal narrative, exits 1", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "docs", "domain", "order.md"),
		"The order previously shipped.\nno longer-lived tokens are fine.\n",
	);
	fs.writeFileSync(path.join(dir, "docs", "plans", "p.md"), "step 1\n");
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /docs\/plans\/p\.md: committed working artifact/);
	assert.match(res.stderr, /order\.md:1: temporal narrative .* \("previously"\)/);
	assert.ok(!res.stderr.includes(":2:"), "hyphenated compound must not match");
});

test("check passes on a clean repo", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "order.md"), "Orders ship after review.\n");
	const res = await run(["check", dir]);
	assert.equal(res.code, 0);
	assert.match(res.stdout, /stdd check: OK/);
});

test("init records generated files in .stdd/manifest.json", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex"]);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.equal(manifest.generatedBy, "stdd");
	assert.ok(manifest.version.length > 0);
	assert.match(manifest.files[".stdd/method.md"], /^sha256:[0-9a-f]{64}$/);
	assert.ok(manifest.files[".claude/skills/stdd-debugging/SKILL.md"]);
	assert.ok(manifest.files[".stdd/AGENTS-snippet.md"]);
	assert.equal(manifest.files[".stdd/config.json"], undefined, "config is user-owned");
});

test("the repository carries one byte-identical canonical and generated method contract", () => {
	const canonical = fs.readFileSync(path.join(PKG_ROOT, "method", "README.md"));
	const generated = fs.readFileSync(path.join(PKG_ROOT, ".stdd", "method.md"));
	const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(generated, canonical);
	assert.equal(manifest.files[".stdd/method.md"], sha256(canonical));
});

test("check rejects a same-version stale method even when its manifest hash agrees", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const methodPath = path.join(dir, ".stdd", "method.md");
	const stale = Buffer.from(`${fs.readFileSync(methodPath, "utf8")}\nStale same-version contract.\n`);
	fs.writeFileSync(methodPath, stale);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.files[".stdd/method.md"] = sha256(stale);
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1, checked.stdout + checked.stderr);
	assert.match(checked.stderr, /\.stdd\/method\.md: .*canonical method.*re-run stdd init/i);
});

test("check and doctor diagnose malformed manifest documents without crashing", async () => {
	const hash = `sha256:${"0".repeat(64)}`;
	const targets = {
		tools: ["claude"],
		ci: [],
		hooks: false,
		sessionHook: false,
		stopHook: false,
	};
	const manifest = (files = {}, extra = {}) => ({
		generatedBy: "stdd",
		version: VERSION,
		files,
		...extra,
	});
	for (const [name, text] of [
		["null", "null\n"],
		["array", "[]\n"],
		["primitive", "42\n"],
		["missing generator", `${JSON.stringify({ version: VERSION, files: {} })}\n`],
		["wrong generator", `${JSON.stringify(manifest({}, { generatedBy: "other" }))}\n`],
		["missing version", `${JSON.stringify({ generatedBy: "stdd", files: {} })}\n`],
		["null version", `${JSON.stringify(manifest({}, { version: null }))}\n`],
		["malformed version", `${JSON.stringify(manifest({}, { version: "v1" }))}\n`],
		["missing files", `${JSON.stringify({ generatedBy: "stdd", version: VERSION })}\n`],
		["null files", `${JSON.stringify(manifest(null))}\n`],
		["array files", `${JSON.stringify(manifest([]))}\n`],
		["primitive files", `${JSON.stringify(manifest("files"))}\n`],
		["missing hash", `${JSON.stringify(manifest({ ".stdd/method.md": null }))}\n`],
		["array hash", `${JSON.stringify(manifest({ ".stdd/method.md": [] }))}\n`],
		["primitive hash", `${JSON.stringify(manifest({ ".stdd/method.md": 42 }))}\n`],
		["bad hash", `${JSON.stringify(manifest({ ".stdd/method.md": "sha256:nope" }))}\n`],
		[
			"uppercase hash",
			`${JSON.stringify(manifest({ ".stdd/method.md": `sha256:${"A".repeat(64)}` }))}\n`,
		],
		["unsafe path", `${JSON.stringify(manifest({ "../outside.md": hash }))}\n`],
		[
			"own __proto__ file",
			`{"generatedBy":"stdd","version":${JSON.stringify(VERSION)},"files":{"__proto__":"bad"}}\n`,
		],
		["null targets", `${JSON.stringify(manifest({}, { targets: null }))}\n`],
		["array targets", `${JSON.stringify(manifest({}, { targets: [] }))}\n`],
		["primitive targets", `${JSON.stringify(manifest({}, { targets: true }))}\n`],
		[
			"missing target field",
			`${JSON.stringify(manifest({}, { targets: { ...targets, stopHook: undefined } }))}\n`,
		],
		[
			"unknown target field",
			`${JSON.stringify(manifest({}, { targets: { ...targets, future: false } }))}\n`,
		],
		[
			"unknown target adapter",
			`${JSON.stringify(manifest({}, { targets: { ...targets, tools: ["unknown"] } }))}\n`,
		],
		[
			"wrong target boolean",
			`${JSON.stringify(manifest({}, { targets: { ...targets, hooks: "yes" } }))}\n`,
		],
	]) {
		const dir = tmpRepo();
		await run(["init", dir, "--tools", "claude"]);
		fs.writeFileSync(path.join(dir, ".stdd", "manifest.json"), text);
		for (const command of ["check", "doctor"]) {
			const result = await run([command, dir]);
			assert.equal(result.code, 1, `${name}/${command}: ${result.stdout}${result.stderr}`);
			const output = `${result.stdout}${result.stderr}`;
			assert.match(output, /\.stdd\/manifest\.json/i, `${name}/${command}`);
			assert.match(
				output,
				/re-run stdd init|unsafe path|generatedBy|version|files must|sha256|targets|JSON object/i,
				`${name}/${command}`,
			);
			assert.doesNotMatch(output, /TypeError|Cannot convert undefined or null/i, `${name}/${command}`);
		}
	}
});

test("check and doctor accept a valid legacy manifest without targets", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "contract.md"), "Current behavior.\n");
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	delete manifest.targets;
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	for (const command of ["check", "doctor"]) {
		const result = await run([command, dir]);
		assert.equal(result.code, 0, `${command}: ${result.stdout}${result.stderr}`);
	}
});

test("check and doctor report unsafe manifested filesystem objects without crashing", async () => {
	const cases = [
		{
			name: "directory",
			setup(target) {
				fs.rmSync(target);
				fs.mkdirSync(target);
				return {};
			},
		},
		{
			name: "symlink",
			setup(target, original) {
				const outside = path.join(tmpRepo(), "outside-method.md");
				fs.writeFileSync(outside, original);
				fs.rmSync(target);
				fs.symlinkSync(outside, target);
				return {};
			},
		},
		{
			name: "read error",
			setup(target) {
				const hookPath = path.join(tmpRepo(), "manifest-read-error.mjs");
				fs.writeFileSync(
					hookPath,
					`import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)};
const originalOpen = fs.openSync;
const originalRead = fs.readFileSync;
const denied = () => Object.assign(new Error("injected unreadable manifest output"), { code: "EACCES" });
fs.openSync = function (candidate, ...args) {
  if (path.resolve(String(candidate)) === target) throw denied();
  return originalOpen.call(this, candidate, ...args);
};
fs.readFileSync = function (candidate, ...args) {
  if (typeof candidate !== "number" && path.resolve(String(candidate)) === target) throw denied();
  return originalRead.call(this, candidate, ...args);
};
`,
				);
				return { env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` } };
			},
		},
		{
			name: "replacement race",
			setup(target) {
				const hookPath = path.join(tmpRepo(), "replace-manifest-output-on-read.mjs");
				fs.writeFileSync(
					hookPath,
					`import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)};
const originalOpen = fs.openSync;
const originalRead = fs.readFileSync;
const originalRemove = fs.rmSync;
const originalMkdir = fs.mkdirSync;
let replaced = false;
function replace(candidate) {
  if (replaced || path.resolve(String(candidate)) !== target) return;
  replaced = true;
  originalRemove.call(fs, target);
  originalMkdir.call(fs, target);
}
fs.openSync = function (candidate, ...args) {
  replace(candidate);
  return originalOpen.call(this, candidate, ...args);
};
fs.readFileSync = function (candidate, ...args) {
  if (typeof candidate !== "number") replace(candidate);
  return originalRead.call(this, candidate, ...args);
};
`,
				);
				return { env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` } };
			},
		},
	];
	if (spawnSync("mkfifo", ["--version"], { encoding: "utf8" }).status === 0) {
		cases.push({
			name: "FIFO",
			setup(target) {
				fs.rmSync(target);
				const created = spawnSync("mkfifo", [target], { encoding: "utf8" });
				assert.equal(created.status, 0, created.stderr);
				return {};
			},
		});
	}

	for (const { name, setup } of cases) {
		for (const command of ["check", "doctor"]) {
			const dir = tmpRepo();
			await run(["init", dir, "--tools", "codex"]);
			fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
			fs.writeFileSync(path.join(dir, "docs", "domain", "contract.md"), "Current behavior.\n");
			const target = path.join(dir, ".stdd", "method.md");
			const options = setup(target, fs.readFileSync(target));
			const result = await run([command, dir], options);
			const output = `${result.stdout}${result.stderr}`;
			assert.equal(result.code, 1, `${name}/${command}: ${output}`);
			if (command === "check") {
				assert.match(output, /\.stdd\/method\.md/i, `${name}/${command}`);
				assert.match(
					output,
					/regular file|symlink|non-regular|unreadable|read|replaced|safe/i,
					`${name}/${command}`,
				);
			} else {
				assert.match(output, /generated file is stale.*re-run stdd init/i, `${name}/${command}`);
			}
			assert.doesNotMatch(output, /\n\s+at |node:fs|EISDIR|TypeError/i, `${name}/${command}`);
		}
	}
});

test("check and doctor report a permission-denied manifested file when not running as root", {
	skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "contract.md"), "Current behavior.\n");
	const target = path.join(dir, ".stdd", "method.md");
	fs.chmodSync(target, 0);
	for (const command of ["check", "doctor"]) {
		const result = await run([command, dir]);
		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.code, 1, `${command}: ${output}`);
		assert.match(
			output,
			command === "check" ? /\.stdd\/method\.md.*read/i : /generated file is stale.*re-run stdd init/i,
			command,
		);
		assert.doesNotMatch(output, /\n\s+at |node:fs|TypeError/i, command);
	}
});

test("check rejects partial generated surfaces when the manifest is missing", async () => {
	const generatedStamp = `<!-- generated by stdd v${VERSION} — do not edit -->\n`;
	for (const [relative, content] of [
		[".stdd/method.md", "partial method\n"],
		[".stdd/AGENTS-snippet.md", generatedStamp],
		[".stdd/CLAUDE-snippet.md", generatedStamp],
		[".agents/skills/stdd-partial/SKILL.md", generatedStamp],
		[".claude/skills/stdd-partial/SKILL.md", generatedStamp],
	]) {
		const dir = tmpRepo();
		const target = path.join(dir, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);

		const checked = await run(["check", dir]);
		assert.equal(checked.code, 1, `${relative}: ${checked.stdout}${checked.stderr}`);
		assert.match(checked.stderr, /\.stdd\/manifest\.json.*missing.*partial install/i, relative);
	}
});

test("check reports unsafe exact generated objects without a manifest", async () => {
	for (const kind of ["directory", "symlink"]) {
		const dir = tmpRepo();
		const methodPath = path.join(dir, ".stdd", "method.md");
		fs.mkdirSync(path.dirname(methodPath), { recursive: true });
		let outside = null;
		if (kind === "directory") {
			fs.mkdirSync(methodPath);
		} else {
			outside = path.join(tmpRepo(), "outside-method");
			fs.writeFileSync(outside, "outside survives\n");
			fs.symlinkSync(outside, methodPath);
		}

		const checked = await run(["check", dir]);

		assert.equal(checked.code, 1, `${kind}: ${checked.stdout}${checked.stderr}`);
		assert.match(checked.stderr, /\.stdd\/method\.md: unsafe object.*exact generated-output path/i);
		assert.match(checked.stderr, /\.stdd\/manifest\.json: .*missing.*partial install/i);
		if (outside) assert.equal(fs.readFileSync(outside, "utf8"), "outside survives\n");
	}
});

test("check reports unsafe exact shipped native skill objects without a manifest", async () => {
	for (const skillRoot of [".agents/skills", ".claude/skills"]) {
		for (const kind of ["directory", "symlink"]) {
			const dir = tmpRepo();
			const relative = `${skillRoot}/stdd-start-change/SKILL.md`;
			const target = path.join(dir, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			let outside = null;
			if (kind === "directory") {
				fs.mkdirSync(target);
			} else {
				outside = path.join(tmpRepo(), `${path.basename(skillRoot)}-outside-skill`);
				fs.writeFileSync(outside, "outside skill survives\n");
				fs.symlinkSync(outside, target);
			}

			const checked = await run(["check", dir]);

			assert.equal(checked.code, 1, `${relative}/${kind}: ${checked.stdout}${checked.stderr}`);
			assert.match(
				checked.stderr,
				new RegExp(
					`${relative.replaceAll(".", "\\.").replaceAll("/", "\\/")}: unsafe object.*exact generated-output path`,
					"i",
				),
			);
			assert.match(checked.stderr, /\.stdd\/manifest\.json: .*missing.*partial install/i);
			if (outside) assert.equal(fs.readFileSync(outside, "utf8"), "outside skill survives\n");
		}
	}
});

test("check reserves validated local recipe skill paths without a manifest", async () => {
	for (const skillRoot of [".agents/skills", ".claude/skills"]) {
		for (const kind of ["directory", "symlink"]) {
			const dir = tmpRepo();
			const localRecipe = path.join(dir, ".stdd", "playbooks", "local", "deploy.md");
			fs.mkdirSync(path.dirname(localRecipe), { recursive: true });
			fs.writeFileSync(
				localRecipe,
				"---\nname: acme-deploy\ndescription: Deploy acme\n---\n\nRun deploy.\n",
			);
			const relative = `${skillRoot}/acme-deploy/SKILL.md`;
			const target = path.join(dir, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			let outside = null;
			if (kind === "directory") {
				fs.mkdirSync(target);
			} else {
				outside = path.join(tmpRepo(), "outside-local-skill");
				fs.writeFileSync(outside, "outside survives\n");
				fs.symlinkSync(outside, target);
			}
			const unrelated = path.join(dir, skillRoot, "user-owned", "SKILL.md");
			fs.mkdirSync(unrelated, { recursive: true });

			const checked = await run(["check", dir]);

			assert.equal(checked.code, 1, `${relative}/${kind}: ${checked.stdout}${checked.stderr}`);
			assert.match(
				checked.stderr,
				new RegExp(
					`${relative.replaceAll(".", "\\.").replaceAll("/", "\\/")}: unsafe object.*exact generated-output path`,
					"i",
				),
			);
			assert.match(checked.stderr, /\.stdd\/manifest\.json: .*missing.*partial install/i);
			assert.doesNotMatch(checked.stderr, /user-owned/);
			if (outside) assert.equal(fs.readFileSync(outside, "utf8"), "outside survives\n");
		}
	}
});

test("check ignores absent shipped skills and unrelated user-owned native skills", async () => {
	const dir = tmpRepo();
	for (const skillRoot of [".agents/skills", ".claude/skills"]) {
		const custom = path.join(dir, skillRoot, "acme-release", "SKILL.md");
		fs.mkdirSync(path.dirname(custom), { recursive: true });
		fs.writeFileSync(custom, "# User-owned skill\n");
	}

	const checked = await run(["check", dir]);

	assert.equal(checked.code, 0, checked.stdout + checked.stderr);
	assert.doesNotMatch(checked.stderr, /partial install|manifest\.json/i);
});

test("a failed first manifest publish leaves partial outputs detectable", async () => {
	const dir = tmpRepo();
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const hookPath = path.join(tmpRepo(), "fail-manifest-publish.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const manifest = ${JSON.stringify(manifestPath)};
const originalOpen = fs.openSync;
fs.openSync = function (target, ...args) {
  if (path.basename(String(target)).startsWith(".manifest-")) {
    throw new Error("injected manifest publish failure");
  }
  return originalOpen.call(this, target, ...args);
};
`,
	);
	const initialized = await run(["init", dir, "--tools", "claude,codex"], {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(initialized.code, 1, initialized.stdout + initialized.stderr);
	assert.match(initialized.stderr, /injected manifest publish failure/);
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "method.md")));
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "AGENTS-snippet.md")));
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "CLAUDE-snippet.md")));
	assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "stdd-start-change", "SKILL.md")));
	assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "stdd-start-change", "SKILL.md")));
	assert.ok(!fs.existsSync(manifestPath));
	assert.deepEqual(
		fs.readdirSync(path.join(dir, ".stdd")).filter((entry) => entry.startsWith(".manifest-")),
		[],
		"a failed atomic publish removes its temporary manifest",
	);

	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1, checked.stdout + checked.stderr);
	assert.match(checked.stderr, /\.stdd\/manifest\.json.*missing.*partial install/i);
});

test("check passes right after init and flags hand-edited generated files", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	assert.equal((await run(["check", dir])).code, 0);

	const playbook = path.join(dir, ".stdd", "playbooks", "debugging.md");
	fs.appendFileSync(playbook, "\nlocal tweak\n");
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /\.stdd\/playbooks\/debugging\.md: .*edited by hand or stale/);
});

test("check flags generated files missing from disk", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	fs.rmSync(path.join(dir, ".stdd", "method.md"));
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /\.stdd\/method\.md: .*missing/);
});

test("check flags stale generated-file stamps", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const skillPath = path.join(dir, ".claude", "skills", "stdd-debugging", "SKILL.md");
	fs.writeFileSync(
		skillPath,
		fs.readFileSync(skillPath, "utf8").replace(/generated by stdd v[^\s]+/, "generated by stdd v0.0.0"),
	);
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /re-run stdd init/);
});

test("check rejects invalid config with a useful error", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), '{"canonicalDocs": "oops"}');
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /"canonicalDocs" must be an array of strings/);
});

test("strict argument parsing fails loudly", async () => {
	const dir = tmpRepo();
	assert.equal((await run(["check", dir, "--unknown"])).code, 1);
	assert.equal((await run(["check", dir, "--tools", "claude"])).code, 1);
	const badTool = await run(["init", dir, "--tools", "nope"]);
	assert.equal(badTool.code, 1);
	assert.match(badTool.stderr, /unknown tool\(s\): nope/);
	assert.equal((await run(["check", dir, "extra"])).code, 1);
});

test("check-pr accepts exactly one evidence line", async () => {
	const dir = tmpRepo();
	const ok = path.join(dir, "ok.md");
	fs.writeFileSync(ok, "Body\nDocs not applicable: lint only\n");
	assert.equal((await run(["check-pr", ok])).code, 0);

	const missing = path.join(dir, "missing.md");
	fs.writeFileSync(missing, "no evidence\n");
	const res = await run(["check-pr", missing]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no docs evidence line/);

	const double = path.join(dir, "double.md");
	fs.writeFileSync(double, "Docs updated first: a\nDocs not applicable: b\n");
	const dres = await run(["check-pr", double]);
	assert.equal(dres.code, 1);
	assert.match(dres.stderr, /2 docs evidence lines \(lines 1, 2\)/);
});

test("doctor reports missing readiness paths with their hints", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			readiness: {
				required: [
					{ path: "node_modules", hint: "pnpm install --frozen-lockfile" },
					{ path: "apps/api/.env" },
				],
			},
		}),
	);
	const res = await run(["doctor", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ node_modules missing — pnpm install --frozen-lockfile/);
	assert.match(res.stdout, /✗ apps\/api\/\.env missing/);
});

test("doctor --readiness runs only the readiness section", async () => {
	const dir = tmpRepo(); // no .stdd install, no docs — full doctor would fail loudly
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ readiness: { required: [{ path: "node_modules", hint: "install" }] } }),
	);
	const res = await run(["doctor", dir, "--readiness"]);
	assert.equal(res.code, 0);
	assert.match(res.stdout, /✓ worktree ready \(1\/1 present\)/);
	assert.ok(!res.stdout.includes("canonical docs"), "--readiness must skip adoption checks");

	const empty = tmpRepo();
	const none = await run(["doctor", empty, "--readiness"]);
	assert.equal(none.code, 0);
	assert.match(none.stdout, /no readiness contract declared/);
});

test("--readiness is only valid for doctor", async () => {
	const dir = tmpRepo();
	assert.equal((await run(["check", dir, "--readiness"])).code, 1);
});

test("doctor reports findings on a messy repo and exits 1", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "plans", "old-plan.md"), "step 1\n");
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\n");
	const res = await run(["doctor", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ .stdd\/ is not installed/);
	assert.match(res.stdout, /✗ no canonical docs found/);
	assert.match(res.stdout, /✗ 1 committed working artifact/);
	assert.match(res.stdout, /✗ AGENTS\.md has no managed STDD routing contract/);
});

test("doctor passes on a healthy stdd repo and exits 0", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "order.md"), "Orders ship after review.\n");
	const res = await run(["doctor", dir]);
	assert.equal(res.code, 0);
	assert.match(res.stdout, /✓ .stdd\/ installed/);
	assert.match(res.stdout, /✓ canonical docs present/);
	assert.match(res.stdout, /✓ no committed working artifacts/);
	assert.match(res.stdout, /✓ AGENTS\.md carries the STDD section/);
});

test("doctor rejects incomplete STDD headings and managed routing contracts", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "order.md"), "Canonical behavior.\n");

	for (const instructions of [
		"# Rules\n\n## STDD\n",
		"<!-- stdd:begin -->\n## STDD\n<!-- stdd:end -->\n",
		"<!-- stdd:begin -->\n## STDD\n\n`$stdd-start-change`\n`$stdd-implement`\n<!-- stdd:end -->\n",
	]) {
		fs.writeFileSync(path.join(dir, "AGENTS.md"), instructions);
		const res = await run(["doctor", dir]);
		assert.equal(res.code, 1);
		assert.match(res.stdout, /✗ AGENTS\.md has no managed STDD routing contract/);
	}
});

test("doctor fails when a selected agent instruction file was deleted", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "order.md"), "Canonical behavior.\n");
	fs.rmSync(path.join(dir, "AGENTS.md"));

	const res = await run(["doctor", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ AGENTS\.md is missing/);
	assert.match(res.stdout, /re-run stdd init for codex/);
});

test("doctor rejects malformed remembered targets instead of treating them as legacy", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "order.md"), "Canonical behavior.\n");
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.targets.tools = [];
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	const res = await run(["doctor", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ \.stdd\/manifest\.json targets are invalid/);
	assert.match(res.stdout, /tools must be a non-empty array/);
});

test("doctor counts temporal narrative and stale generated files", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "order.md"), "Previously orders shipped.\n");
	const skillPath = path.join(dir, ".claude", "skills", "stdd-debugging", "SKILL.md");
	fs.writeFileSync(
		skillPath,
		fs.readFileSync(skillPath, "utf8").replace(/generated by stdd v[^\s]+/, "generated by stdd v0.0.0"),
	);
	const res = await run(["doctor", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ 1 canonical doc matches configured temporal phrases/);
	assert.match(res.stdout, /✗ 1 generated file is stale/);
});

async function tmpGitRepo() {
	const dir = tmpRepo();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	fs.writeFileSync(path.join(dir, "impl.js"), "export {};\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	return dir;
}

test("check-pr --base passes when claimed docs really changed", async () => {
	const dir = await tmpGitRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: docs/domain/pricing.md\n");
	const res = await run(["check-pr", body, "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
});

test("check-pr --base supports Unicode and backticked paths with spaces", async () => {
	const dir = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "docs", "domain", "über.md"), "Rule.\n");
	fs.writeFileSync(path.join(dir, "docs", "domain", "design notes.md"), "Rule.\n");
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", [
		"-C",
		dir,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		"unicode docs",
	]);
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: docs/domain/über.md, `docs/domain/design notes.md`\n");
	const res = await run(["check-pr", body, "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0, res.stderr);
});

test("check-pr --base fails when a claimed doc is not in the diff", async () => {
	const dir = await tmpGitRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: docs/domain/unrelated.md\n");
	const res = await run(["check-pr", body, "--base", "main"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /docs\/domain\/unrelated\.md/);
	assert.match(res.stderr, /not changed/);
});

test("check-pr --base fails when 'updated first' names no path at all", async () => {
	const dir = await tmpGitRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: see the description\n");
	const res = await run(["check-pr", body, "--base", "main"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no doc paths/i);
});

test("check-pr --base verifies 'checked, no change needed' paths exist", async () => {
	const dir = await tmpGitRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs checked, no change needed: docs/domain/pricing.md — covered\n");
	assert.equal((await run(["check-pr", body, "--base", "main"], { cwd: dir })).code, 0);

	fs.writeFileSync(body, "Docs checked, no change needed: docs/domain/ghost.md — covered\n");
	const res = await run(["check-pr", body, "--base", "main"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /ghost\.md/);
	assert.match(res.stderr, /does not exist/);
});

test("check-pr without --base keeps text-only behavior", async () => {
	const dir = await tmpGitRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: docs/domain/unrelated.md\n");
	assert.equal((await run(["check-pr", body], { cwd: dir })).code, 0);
});

test("check-pr failure points at a near-miss line with a corrected form", async () => {
	const dir = tmpRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Summary\n\n**Docs updated first:** docs/domain/orgs.md\n");
	const res = await run(["check-pr", body]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /near-miss/);
	assert.match(res.stderr, /line 3/);
	assert.match(res.stderr, /found: \*\*Docs updated first:\*\* docs\/domain\/orgs\.md/);
	assert.match(res.stderr, /fix: {3}Docs updated first: docs\/domain\/orgs\.md/);
	assert.match(res.stderr, /column 0/);
});

test("check-pr failure without a near-miss keeps the generic message", async () => {
	const dir = tmpRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "no evidence here\n");
	const res = await run(["check-pr", body]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no docs evidence line/);
	assert.ok(!res.stderr.includes("near-miss"));
});

test("check-pr --base suggests the correct label for sentinel content", async () => {
	const dir = await tmpGitRepo();
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: not applicable\n");
	const res = await run(["check-pr", body, "--base", "main"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no doc paths/i);
	assert.match(res.stderr, /Docs not applicable: <why implementation-only>/);
});

/**
 * A repo with a real `origin` (bare sibling): main pushed, a feature branch
 * with a docs change checked out. Returns paths plus a PATH prefix holding a
 * fake `gh` that prints the JSON written to `ghOutput`.
 */
async function tmpGitRepoWithOrigin() {
	const root = tmpRepo();
	const origin = path.join(root, "origin.git");
	const dir = path.join(root, "work");
	fs.mkdirSync(dir);
	await exec("git", ["init", "-q", "--bare", origin]);
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	await git("remote", "add", "origin", origin);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("push", "-q", "origin", "main");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	await git("add", ".");
	await git("commit", "-qm", "change");

	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const ghOutput = path.join(root, "gh.json");
	fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\ncat "${ghOutput}"\n`, { mode: 0o755 });
	const env = {
		...process.env,
		PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
	};
	const headSha = (await git("rev-parse", "HEAD")).stdout.trim();
	return { dir, git, ghOutput, env, headSha };
}

test("check-pr --pr validates the live body against the PR's base and head", async () => {
	const { dir, ghOutput, env, headSha } = await tmpGitRepoWithOrigin();
	fs.writeFileSync(
		ghOutput,
		JSON.stringify({
			body: "Docs updated first: docs/domain/pricing.md\n",
			baseRefName: "main",
			headRefOid: headSha,
			number: 7,
		}),
	);
	const res = await run(["check-pr", "--pr", "7"], { cwd: dir, env });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /OK \(PR #7 body, base origin\/main, head [0-9a-f]{7}\)/);
});

test("check-pr --pr diffs the PR head, not a diverged local checkout", async () => {
	const { dir, git, ghOutput, env, headSha } = await tmpGitRepoWithOrigin();
	await git("update-ref", "refs/heads/tmp-pr", headSha);
	await git("push", "-q", "origin", "refs/heads/tmp-pr:refs/pull/7/head");
	await git("checkout", "-q", "main"); // local HEAD no longer matches the PR head
	fs.writeFileSync(
		ghOutput,
		JSON.stringify({
			body: "Docs updated first: docs/domain/pricing.md\n",
			baseRefName: "main",
			headRefOid: headSha,
			number: 7,
		}),
	);
	const res = await run(["check-pr", "--pr", "7"], { cwd: dir, env });
	assert.equal(res.code, 0, res.stderr);
});

test("check-pr --pr checks referenced docs in the PR head, not the local checkout", async () => {
	const { dir, git, ghOutput, env } = await tmpGitRepoWithOrigin();
	fs.writeFileSync(path.join(dir, "docs", "domain", "feature-only.md"), "Feature rule.\n");
	await git("add", ".");
	await git("commit", "-qm", "feature-only doc");
	const headSha = (await git("rev-parse", "HEAD")).stdout.trim();
	await git("update-ref", "refs/heads/tmp-pr", headSha);
	await git("push", "-q", "origin", "refs/heads/tmp-pr:refs/pull/8/head");
	await git("checkout", "-q", "main");
	fs.writeFileSync(
		ghOutput,
		JSON.stringify({
			body: "Docs checked, no change needed: docs/domain/feature-only.md — governing rule\n",
			baseRefName: "main",
			headRefOid: headSha,
			number: 8,
		}),
	);
	const res = await run(["check-pr", "--pr", "8"], { cwd: dir, env });
	assert.equal(res.code, 0, res.stderr);
});

test("check-pr --pr fails when the PR head cannot be resolved", async () => {
	const { dir, git, ghOutput, env } = await tmpGitRepoWithOrigin();
	await git("checkout", "-q", "main");
	fs.writeFileSync(
		ghOutput,
		JSON.stringify({
			body: "Docs updated first: docs/domain/pricing.md\n",
			baseRefName: "main",
			headRefOid: "0123456789abcdef0123456789abcdef01234567",
			number: 7,
		}),
	);
	const res = await run(["check-pr", "--pr", "7"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /local HEAD differs from PR head/);
});

test("check-pr --pr is exclusive with the body file and --base, and needs gh", async () => {
	const { dir, env } = await tmpGitRepoWithOrigin();
	const both = await run(["check-pr", "body.md", "--pr", "7"], { cwd: dir, env });
	assert.equal(both.code, 1);
	assert.match(both.stderr, /--pr replaces/);

	const withBase = await run(["check-pr", "--pr", "7", "--base", "main"], { cwd: dir, env });
	assert.equal(withBase.code, 1);
	assert.match(withBase.stderr, /--pr derives the base/);

	const noGh = await run(["check-pr", "--pr", "7"], {
		cwd: dir,
		env: { ...process.env, PATH: path.dirname(process.execPath) },
	});
	assert.equal(noGh.code, 1);
	assert.match(noGh.stderr, /GitHub CLI|gh/);
});

test("evidence prints a finished 'Docs updated first' line when canonical docs changed", async () => {
	const dir = await tmpGitRepo();
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "Docs updated first: docs/domain/pricing.md\n");
});

test("evidence lists every changed canonical doc on one line", async () => {
	const dir = await tmpGitRepo();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	fs.writeFileSync(path.join(dir, "docs", "domain", "auth.md"), "Sessions expire.\n");
	await git("add", ".");
	await git("commit", "-qm", "more docs");
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "Docs updated first: docs/domain/auth.md, docs/domain/pricing.md\n");
});

test("evidence exits nonzero with templates on stderr when no canonical docs changed", async () => {
	const dir = await tmpGitRepo();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("checkout", "-qb", "impl-only", "main");
	fs.writeFileSync(path.join(dir, "util.js"), "export {};\n");
	await git("add", ".");
	await git("commit", "-qm", "impl");
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.equal(res.stdout, "", "stdout must stay empty so $(...) cannot embed a template");
	assert.match(res.stderr, /Docs checked, no change needed: <docs \+ reason>/);
	assert.match(res.stderr, /Docs not applicable: <why implementation-only>/);
});

test("evidence requires a base: --base flag or config baseRef", async () => {
	const dir = await tmpGitRepo();
	const missing = await run(["evidence"], { cwd: dir });
	assert.equal(missing.code, 1);
	assert.match(missing.stderr, /--base|baseRef/);

	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), '{"baseRef": "main"}');
	const fromConfig = await run(["evidence"], { cwd: dir });
	assert.equal(fromConfig.code, 0);
	assert.equal(fromConfig.stdout, "Docs updated first: docs/domain/pricing.md\n");
});

test("check-pr rejects a bare evidence label", async () => {
	const dir = tmpRepo();
	const bare = path.join(dir, "bare.md");
	fs.writeFileSync(bare, "Summary\nDocs updated first:\n");
	const res = await run(["check-pr", bare]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /name/i);
});

test("check-pr ignores quoted templates and code fences", async () => {
	const dir = tmpRepo();
	const quoted = path.join(dir, "quoted.md");
	fs.writeFileSync(
		quoted,
		"> Docs updated first: template\n```\nDocs not applicable: example\n```\nDocs not applicable: lint only\n",
	);
	assert.equal((await run(["check-pr", quoted])).code, 0);
});

// --- forgiving errors: unknown commands suggest the intended one ---

test("an unknown command suggests the closest known one", async () => {
	const light = await run(["light-ci-status"]);
	assert.equal(light.code, 1);
	assert.match(light.stderr, /unknown command "light-ci-status"/);
	assert.match(light.stderr, /did you mean "status"/);

	const typo = await run(["evidnce"]);
	assert.equal(typo.code, 1);
	assert.match(typo.stderr, /did you mean "evidence"/);
});

test("an unknown command without a close match still prints usage", async () => {
	const res = await run(["frobnicate"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /unknown command "frobnicate"/);
	assert.ok(!/did you mean/.test(res.stderr));
	assert.match(res.stdout, /Usage: stdd/);
});

test("the AGENTS snippet names the package-runner fallback for stdd", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	const snippet = fs.readFileSync(path.join(dir, ".stdd", "AGENTS-snippet.md"), "utf8");
	assert.ok(snippet.includes("pnpm exec stdd") && snippet.includes(NPM_RUNNER));
	assert.ok(!snippet.includes("npx --no stdd"));
	assert.match(snippet, /not on PATH/i);
});

// --- config gates: contentRules and branchPattern (V1 review, proposals 8/9) ---

async function tmpGitDir() {
	const dir = tmpRepo();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	return { dir, git };
}

test("contentRules: forbid flags matching lines with the repo-authored message", async () => {
	const { dir, git } = await tmpGitDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			contentRules: [
				{
					name: "idempotent migrations",
					files: "migrations/*.sql",
					forbid: "ADD COLUMN (?!IF NOT EXISTS)",
					message: "use IF NOT EXISTS",
				},
			],
		}),
	);
	fs.mkdirSync(path.join(dir, "migrations"));
	fs.writeFileSync(path.join(dir, "migrations", "0001.sql"), "ALTER TABLE t ADD COLUMN a int;\n");
	fs.writeFileSync(path.join(dir, "other.sql"), "ADD COLUMN b int;\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /migrations\/0001\.sql:1: idempotent migrations — use IF NOT EXISTS/);
	assert.ok(!/other\.sql/.test(res.stderr), "files outside the glob are not graded");
});

test("contentRules: require flags a file missing the pattern", async () => {
	const { dir, git } = await tmpGitDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			contentRules: [
				{ name: "log frontmatter", files: "docs/project/*.md", require: "authority: non-canonical" },
			],
		}),
	);
	fs.mkdirSync(path.join(dir, "docs", "project"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "project", "2026-01-01-x.md"), "just prose\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /docs\/project\/2026-01-01-x\.md: log frontmatter/);
});

test("contentRules: newFilesOnly grades only files added against baseRef", async () => {
	const { dir, git } = await tmpGitDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			contentRules: [
				{
					name: "replay-safe",
					files: "migrations/*.sql",
					forbid: "ADD COLUMN (?!IF NOT EXISTS)",
					newFilesOnly: true,
				},
			],
		}),
	);
	fs.mkdirSync(path.join(dir, "migrations"));
	fs.writeFileSync(path.join(dir, "migrations", "0001.sql"), "ADD COLUMN old int;\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feat/x");
	fs.writeFileSync(path.join(dir, "migrations", "0002.sql"), "ADD COLUMN fresh int;\n");
	await git("add", ".");
	await git("commit", "-qm", "new migration");
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /0002\.sql/);
	assert.ok(!/0001\.sql/.test(res.stderr), "pre-existing files are grandfathered");
});

test("contentRules: invalid entries are rejected with an actionable message", async () => {
	const { dir } = await tmpGitDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ contentRules: [{ name: "broken", files: "x/*" }] }),
	);
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /contentRules/);
	assert.match(res.stderr, /forbid or require/);
});

test("branchPattern: a non-matching branch fails check; detached HEAD skips it", async () => {
	const { dir, git } = await tmpGitDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ branchPattern: "^(main|feat/|fix/)" }),
	);
	fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "worktree-shipping-uiux");
	const bad = await run(["check", dir]);
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /branch "worktree-shipping-uiux" does not match branchPattern/);

	await git("checkout", "-qb", "feat/good-name");
	assert.equal((await run(["check", dir])).code, 0);

	await git("checkout", "-q", "--detach");
	assert.equal((await run(["check", dir])).code, 0, "detached checkouts (CI) skip the rule");
});

test("check-pr names the line numbers when the body carries duplicate evidence lines", async () => {
	const body = path.join(tmpRepo(), "pr.md");
	fs.writeFileSync(body, "Docs updated first: docs/a.md\n\nDocs not applicable: also this\n");
	const res = await run(["check-pr", body]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /2 docs evidence lines \(lines 1, 3\)/);
});

// --- the init configurator: capability profile, local recipes, interview, session hook ---

test("init compiles playbooks against the capability profile", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ capabilities: { subagents: false, crossCli: true, worktrees: false } }),
	);
	const res = await run(["init", dir, "--tools", "claude,codex"]);
	assert.equal(res.code, 0, res.stderr);
	const slice = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	assert.ok(!/never your session history/.test(slice), "subagents-off block is stripped");
	assert.match(slice, /codex exec/, "crossCli-on block survives");
	assert.ok(!/cap:/.test(slice), "no marker residue");
	const copy = fs.readFileSync(path.join(dir, ".stdd", "playbooks", "delegate-slice.md"), "utf8");
	assert.ok(!/never your session history/.test(copy), "the agent-neutral copy is compiled too");
	assert.ok(
		!fs.existsSync(path.join(dir, ".claude", "skills", "stdd-worktrees")),
		"requires: worktrees playbook is skipped",
	);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "playbooks", "worktrees.md")));
	const snippet = fs.readFileSync(path.join(dir, ".stdd", "AGENTS-snippet.md"), "utf8");
	assert.ok(!/worktrees\.md/.test(snippet), "skipped playbook is not listed");
});

test("agent-neutral playbooks resolve the configured cross-CLI review route", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			capabilities: { subagents: false, crossCli: true, worktrees: false },
			review: { via: "claude" },
		}),
	);

	const res = await run(["init", dir, "--tools", "codex"]);
	assert.equal(res.code, 0, res.stderr);
	const planning = fs.readFileSync(path.join(dir, ".stdd", "playbooks", "planning.md"), "utf8");
	assert.match(planning, /stdd review --via claude/);
	assert.doesNotMatch(planning, /STDD_CROSS_CLI_REVIEW_VIA/);
});

test("init with default capabilities keeps today's output", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const slice = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	assert.match(slice, /never your session history/);
	assert.ok(!/codex exec/.test(slice), "crossCli defaults off");
	assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "stdd-worktrees", "SKILL.md")));
});

test("init --capabilities writes the profile into the config, keeping other keys", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex", "--capabilities", "crossCli,worktrees"]);
	const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(config.capabilities, { subagents: false, crossCli: true, worktrees: true });
	assert.equal(config.review.via, "claude", "cross-CLI defaults to the Codex driver's peer");

	const dir2 = tmpRepo();
	fs.mkdirSync(path.join(dir2, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir2, ".stdd", "config.json"), JSON.stringify({ baseRef: "origin/main" }));
	await run(["init", dir2, "--tools", "codex", "--capabilities", "subagents"]);
	const config2 = JSON.parse(fs.readFileSync(path.join(dir2, ".stdd", "config.json"), "utf8"));
	assert.equal(config2.baseRef, "origin/main", "existing config keys survive");
	assert.deepEqual(config2.capabilities, { subagents: true, crossCli: false, worktrees: false });

	const bad = await run(["init", tmpRepo(), "--capabilities", "teleport"]);
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /teleport/);
});

test("init and configure reject non-object config before changing any target bytes", async () => {
	for (const malformed of ["null\n", "[]\n", "42\n"]) {
		for (const command of [
			["init", "--tools", "codex", "--capabilities", "worktrees"],
			["configure", "--capabilities", "worktrees"],
		]) {
			const dir = tmpRepo();
			fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
			fs.writeFileSync(path.join(dir, ".stdd", "config.json"), malformed);
			fs.writeFileSync(path.join(dir, "sentinel.txt"), "must survive byte-for-byte\n");
			const before = snapshotTreeBytes(dir);

			const res = await run([command[0], dir, ...command.slice(1)]);

			assert.equal(res.code, 1, `${command[0]} accepted ${malformed.trim()}`);
			assert.match(res.stderr, /\.stdd\/config\.json: config must be a JSON object/i);
			assert.deepEqual(
				snapshotTreeBytes(dir),
				before,
				`${command[0]} must reject ${malformed.trim()} before every target write`,
			);
		}
	}
});

test("generated publication replaces a hard link without truncating its other name", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const generatedPath = path.join(dir, ".stdd", "method.md");
	const victim = path.join(tmpRepo(), "hardlink-victim.md");
	fs.writeFileSync(victim, "outside inode must not be truncated\n", { mode: 0o644 });
	fs.rmSync(generatedPath);
	fs.linkSync(victim, generatedPath);
	assert.equal(fs.lstatSync(victim).nlink, 2);

	const initialized = await run(["init", dir, "--tools", "claude"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	assert.equal(fs.readFileSync(victim, "utf8"), "outside inode must not be truncated\n");
	assert.equal(fs.lstatSync(victim).nlink, 1);
	assert.deepEqual(
		fs.readFileSync(generatedPath),
		fs.readFileSync(path.join(PKG_ROOT, "method", "README.md")),
	);
	assert.equal(fs.lstatSync(generatedPath).mode & 0o777, 0o644);
});

test("generated held-parent publication contains target and parent swaps", async () => {
	{
		const dir = tmpRepo();
		await run(["init", dir, "--tools", "claude"]);
		const generatedPath = path.join(dir, ".stdd", "method.md");
		const victim = path.join(tmpRepo(), "generated-target-victim");
		fs.writeFileSync(victim, "target hardlink victim survives\n", { mode: 0o644 });
		const hookPath = path.join(tmpRepo(), "swap-generated-target.mjs");
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const generated = ${JSON.stringify(generatedPath)};
const victim = ${JSON.stringify(victim)};
const originalRename = fs.renameSync;
let swapped = false;
fs.renameSync = function (source, target, ...args) {
  if (
    !swapped &&
    path.basename(String(source)).startsWith(".stdd-generated-") &&
    path.basename(String(target)) === "method.md"
  ) {
    swapped = true;
    fs.rmSync(generated);
    fs.linkSync(victim, generated);
  }
  return originalRename.call(this, source, target, ...args);
};
`,
		);
		const initialized = await run(["init", dir, "--tools", "claude"], {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
		assert.equal(fs.readFileSync(victim, "utf8"), "target hardlink victim survives\n");
		assert.equal(fs.lstatSync(victim).nlink, 1);
	}

	{
		const root = tmpRepo();
		const dir = path.join(root, "repo");
		fs.mkdirSync(dir);
		await run(["init", dir, "--tools", "claude"]);
		const stddDir = path.join(dir, ".stdd");
		const parked = path.join(root, "parked-stdd");
		const outside = path.join(root, "outside-stdd");
		fs.mkdirSync(outside);
		const outsideVictim = path.join(outside, "method.md");
		fs.writeFileSync(outsideVictim, "outside parent survives\n");
		const hookPath = path.join(root, "swap-generated-parent.mjs");
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const stddDir = ${JSON.stringify(stddDir)};
const parked = ${JSON.stringify(parked)};
const outside = ${JSON.stringify(outside)};
const originalRename = fs.renameSync;
let swapped = false;
fs.renameSync = function (source, target, ...args) {
  if (
    !swapped &&
    path.basename(String(source)).startsWith(".stdd-generated-") &&
    path.basename(String(target)) === "method.md"
  ) {
    swapped = true;
    originalRename.call(fs, stddDir, parked);
    fs.symlinkSync(outside, stddDir, "dir");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
		);
		const initialized = await run(["init", dir, "--tools", "claude"], {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(initialized.code, 1, initialized.stdout + initialized.stderr);
		assert.match(initialized.stderr, /changed during held-parent publication/i);
		assert.equal(fs.readFileSync(outsideVictim, "utf8"), "outside parent survives\n");
		assert.deepEqual(
			fs.readFileSync(path.join(parked, "method.md")),
			fs.readFileSync(path.join(PKG_ROOT, "method", "README.md")),
		);
	}
});

test("generated, journal, and manifest publication reject a replaced temp before rename", async () => {
	for (const kind of ["generated", "journal", "manifest"]) {
		let dir;
		let args;
		let finalPath;
		let tempPrefix;
		if (kind === "journal") {
			({ dir, args } = await cleanupTransactionFixture(false));
			finalPath = path.join(dir, ".stdd", "cleanup-transaction.json");
			tempPrefix = ".cleanup-journal-";
		} else {
			dir = tmpRepo();
			const initialized = await run(["init", dir, "--tools", "claude"]);
			assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
			args = ["init", dir, "--tools", "claude"];
			finalPath =
				kind === "generated"
					? path.join(dir, ".stdd", "method.md")
					: path.join(dir, ".stdd", "manifest.json");
			tempPrefix = kind === "generated" ? ".stdd-generated-" : ".manifest-";
		}
		const finalBefore = fs.existsSync(finalPath) ? fs.readFileSync(finalPath) : null;
		const root = tmpRepo();
		const parked = path.join(root, `${kind}-original.tmp`);
		const marker = path.join(root, `${kind}-marker.json`);
		const replacement = `attacker ${kind} temp survives\n`;
		const hookPath = path.join(root, `${kind}-pre-rename-temp-race.mjs`);
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const prefix = ${JSON.stringify(tempPrefix)};
const finalPath = ${JSON.stringify(finalPath)};
const parked = ${JSON.stringify(parked)};
const marker = ${JSON.stringify(marker)};
const replacement = ${JSON.stringify(replacement)};
const originalOpen = fs.openSync;
const originalFstat = fs.fstatSync;
const originalRename = fs.renameSync;
let tempFd = null;
let tempPath = null;
let swapped = false;
fs.openSync = function (target, ...args) {
  const fd = originalOpen.call(this, target, ...args);
  if (path.basename(String(target)).startsWith(prefix)) {
    tempFd = fd;
    tempPath = String(target);
  }
  return fd;
};
fs.fstatSync = function (fd, ...args) {
  const stat = originalFstat.call(this, fd, ...args);
  if (!swapped && fd === tempFd) {
    swapped = true;
    originalRename.call(fs, tempPath, parked);
    fs.writeFileSync(tempPath, replacement, { mode: 0o600 });
    fs.writeFileSync(
      marker,
      JSON.stringify({ tempPath: path.join(path.dirname(finalPath), path.basename(tempPath)) }),
    );
  }
  return stat;
};
`,
		);

		const failed = await run(args, {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(failed.code, 1, `${kind}: ${failed.stdout}${failed.stderr}`);
		const { tempPath } = JSON.parse(fs.readFileSync(marker, "utf8"));
		assert.equal(fs.readFileSync(tempPath, "utf8"), replacement, `${kind}: replacement survives`);
		assert.ok(fs.existsSync(parked), `${kind}: descriptor-bound original is preserved`);
		if (finalBefore === null) {
			assert.ok(!fs.existsSync(finalPath), `${kind}: replacement never becomes authoritative`);
		} else {
			assert.deepEqual(
				fs.readFileSync(finalPath),
				finalBefore,
				`${kind}: previous authoritative file survives`,
			);
		}
	}
});

test("generated publication detects rename, postflight, and descriptor-close races", async () => {
	for (const phase of ["rename-error", "postflight", "close"]) {
		const dir = tmpRepo();
		const initialized = await run(["init", dir, "--tools", "claude"]);
		assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
		const finalPath = path.join(dir, ".stdd", "method.md");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const manifestBefore = fs.readFileSync(manifestPath);
		const root = tmpRepo();
		const parked = path.join(root, `${phase}-descriptor-bound.md`);
		const marker = path.join(root, `${phase}-marker.json`);
		const replacement = `attacker ${phase} replacement survives\n`;
		const hookPath = path.join(root, `${phase}-generated-publication-race.mjs`);
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const phase = ${JSON.stringify(phase)};
const finalPath = ${JSON.stringify(finalPath)};
const parked = ${JSON.stringify(parked)};
const marker = ${JSON.stringify(marker)};
const replacement = ${JSON.stringify(replacement)};
const originalOpen = fs.openSync;
const originalClose = fs.closeSync;
const originalLstat = fs.lstatSync;
const originalRename = fs.renameSync;
let tempFd = null;
let tempPath = null;
let published = false;
let raced = false;
fs.openSync = function (target, ...args) {
  const fd = originalOpen.call(this, target, ...args);
  if (path.basename(String(target)).startsWith(".stdd-generated-")) {
    tempFd = fd;
    tempPath = String(target);
  }
  return fd;
};
fs.renameSync = function (source, target, ...args) {
  if (
    !raced &&
    phase === "rename-error" &&
    path.basename(String(source)).startsWith(".stdd-generated-") &&
    path.basename(String(target)) === "method.md"
  ) {
    raced = true;
    originalRename.call(fs, source, parked);
    fs.writeFileSync(source, replacement, { mode: 0o600 });
    fs.writeFileSync(
      marker,
      JSON.stringify({ location: path.join(path.dirname(finalPath), path.basename(String(source))) }),
    );
    throw new Error("injected generated rename failure");
  }
  const result = originalRename.call(this, source, target, ...args);
  if (
    path.basename(String(source)).startsWith(".stdd-generated-") &&
    path.basename(String(target)) === "method.md"
  ) published = true;
  return result;
};
fs.lstatSync = function (target, ...args) {
  const stat = originalLstat.call(this, target, ...args);
  if (!raced && phase === "postflight" && published && String(target) === finalPath) {
    raced = true;
    originalRename.call(fs, target, parked);
    fs.writeFileSync(target, replacement, { mode: 0o644 });
    fs.writeFileSync(marker, JSON.stringify({ location: finalPath }));
  }
  return stat;
};
fs.closeSync = function (fd) {
  if (!raced && phase === "close" && fd === tempFd) {
    if (!published) {
      fs.writeFileSync(marker, JSON.stringify({ location: "closed-before-publication" }));
      return originalClose.call(this, fd);
    }
    raced = true;
    const result = originalClose.call(this, fd);
    originalRename.call(fs, finalPath, parked);
    fs.writeFileSync(finalPath, replacement, { mode: 0o644 });
    fs.writeFileSync(marker, JSON.stringify({ location: finalPath }));
    return result;
  }
  return originalClose.call(this, fd);
};
`,
		);

		const failed = await run(["init", dir, "--tools", "claude"], {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(failed.code, 1, `${phase}: ${failed.stdout}${failed.stderr}`);
		const { location } = JSON.parse(fs.readFileSync(marker, "utf8"));
		assert.notEqual(
			location,
			"closed-before-publication",
			"temp descriptor stays open through postflight",
		);
		assert.equal(fs.readFileSync(location, "utf8"), replacement, `${phase}: replacement survives`);
		assert.deepEqual(
			fs.readFileSync(parked),
			fs.readFileSync(path.join(PKG_ROOT, "method", "README.md")),
			`${phase}: descriptor-bound generated bytes are preserved`,
		);
		assert.deepEqual(
			fs.readFileSync(manifestPath),
			manifestBefore,
			`${phase}: manifest stays authoritative`,
		);
	}
});

test("unsupported platforms fail before generated init mutation", async () => {
	const dir = tmpRepo();
	const hookPath = path.join(tmpRepo(), "force-portable-platform.mjs");
	fs.writeFileSync(hookPath, `Object.defineProperty(process, "platform", { value: "darwin" });\n`);
	const initialized = await run(["init", dir, "--tools", "claude"], {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(initialized.code, 1, initialized.stdout + initialized.stderr);
	assert.match(
		initialized.stderr,
		/secure init\/configure publication is unsupported.*held-parent pathname bridge/i,
	);
	assert.deepEqual(fs.readdirSync(dir), [], "unsupported init fails before generated install writes");
});

test("unsupported init and configure leave a committed cleanup journal byte-identical", async () => {
	for (const command of ["init", "configure"]) {
		const { dir, args } = await cleanupTransactionFixture(true);
		const journalPath = path.join(dir, ".stdd", "cleanup-transaction.json");
		const faultHookPath = path.join(tmpRepo(), `leave-committed-journal-${command}.mjs`);
		fs.writeFileSync(
			faultHookPath,
			`import fs from "node:fs";
import path from "node:path";
const originalOpen = fs.openSync;
let faulted = false;
fs.openSync = function (target, flags, ...args) {
  if (
    !faulted &&
    path.basename(String(target)) === "cleanup-transaction.json" &&
    typeof flags === "number" &&
    (flags & fs.constants.O_RDWR) === fs.constants.O_RDWR
  ) {
    faulted = true;
    throw new Error("injected cleanup journal clear failure");
  }
  return originalOpen.call(this, target, flags, ...args);
};
`,
		);
		const journaled = await run(args, {
			env: { ...process.env, NODE_OPTIONS: `--import=${faultHookPath}` },
		});
		assert.equal(journaled.code, 1, `${command}: ${journaled.stdout}${journaled.stderr}`);
		assert.ok(fs.existsSync(journalPath), `${command}: committed journal remains`);

		const before = snapshotTreeBytes(dir);
		const platformHookPath = path.join(tmpRepo(), `force-portable-platform-${command}.mjs`);
		fs.writeFileSync(
			platformHookPath,
			`Object.defineProperty(process, "platform", { value: "darwin" });\n`,
		);
		const commandArgs =
			command === "init" ? args : ["configure", dir, "--capabilities", "subagents,worktrees"];
		const unsupported = await run(commandArgs, {
			env: { ...process.env, NODE_OPTIONS: `--import=${platformHookPath}` },
		});
		assert.equal(unsupported.code, 1, `${command}: ${unsupported.stdout}${unsupported.stderr}`);
		assert.match(
			unsupported.stderr,
			/secure init\/configure publication is unsupported.*held-parent pathname bridge/i,
		);
		assert.deepEqual(
			snapshotTreeBytes(dir),
			before,
			`${command}: unsupported platform must not recover or mutate committed state`,
		);
	}
});

test("held ancestor creation cannot redirect mkdir outside the repository", async () => {
	const root = tmpRepo();
	const dir = path.join(root, "repo");
	const parked = path.join(root, "parked-repo");
	const outside = path.join(root, "outside");
	fs.mkdirSync(dir);
	fs.mkdirSync(outside);
	const hookPath = path.join(root, "swap-generated-ancestor.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const repo = ${JSON.stringify(dir)};
const parked = ${JSON.stringify(parked)};
const outside = ${JSON.stringify(outside)};
const originalMkdir = fs.mkdirSync;
const originalRename = fs.renameSync;
let swapped = false;
fs.mkdirSync = function (target, ...args) {
  if (
    !swapped &&
    String(target).startsWith("/proc/self/fd/") &&
    path.basename(String(target)) === ".stdd"
  ) {
    swapped = true;
    originalRename.call(fs, repo, parked);
    fs.symlinkSync(outside, repo, "dir");
  }
  return originalMkdir.call(this, target, ...args);
};
`,
	);
	const initialized = await run(["init", dir, "--tools", "claude"], {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(initialized.code, 1, initialized.stdout + initialized.stderr);
	assert.deepEqual(fs.readdirSync(outside), []);
	assert.ok(fs.existsSync(path.join(parked, ".stdd")));
});

test("cross-CLI init defaults review.via from the first selected native host", async () => {
	for (const { tools, expected } of [
		{ tools: "claude", expected: "codex" },
		{ tools: "codex", expected: "claude" },
		{ tools: "pi", expected: "claude" },
		{ tools: "claude,codex", expected: "codex" },
		{ tools: "codex,claude", expected: "claude" },
		{ tools: "pi,codex", expected: "claude" },
	]) {
		const dir = tmpRepo();
		const initialized = await run(["init", dir, "--tools", tools, "--capabilities", "crossCli"]);
		assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
		const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
		assert.equal(config.review.via, expected, tools);
	}
});

test("the append-only playbook registry covers shipped playbooks without fixture-only entries", () => {
	const registry = JSON.parse(
		fs.readFileSync(path.join(PKG_ROOT, "playbooks", "managed-playbooks.json"), "utf8"),
	);
	const shipped = fs
		.readdirSync(path.join(PKG_ROOT, "playbooks"))
		.filter((file) => file.endsWith(".md"))
		.sort();
	assert.deepEqual(registry.managed.filter((file) => shipped.includes(file)).sort(), shipped);
	assert.ok(!registry.managed.includes("retired-routing.md"));
});

test("historical playbook manifests cannot claim user-owned local recipes", async () => {
	const dir = tmpRepo();
	const initialized = await run(["init", dir, "--tools", "claude"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const localRelative = ".stdd/playbooks/local/acme-release.md";
	const localPath = path.join(dir, localRelative);
	const localBytes =
		"---\nname: acme-release\ndescription: User-owned release workflow\n---\n\nRelease Acme.\n";
	fs.mkdirSync(path.dirname(localPath), { recursive: true });
	fs.writeFileSync(localPath, localBytes);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const forged = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	forged.version = "0.6.0";
	forged.files[localRelative] = sha256(localBytes);
	fs.writeFileSync(manifestPath, `${JSON.stringify(forged, null, "\t")}\n`);
	const manifestBefore = fs.readFileSync(manifestPath);

	const reinitialized = await run(["init", dir, "--tools", "claude"]);

	assert.equal(reinitialized.code, 1, reinitialized.stdout + reinitialized.stderr);
	assert.match(reinitialized.stderr, /not a recognized STDD-generated output path/i);
	assert.equal(fs.readFileSync(localPath, "utf8"), localBytes);
	assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
});

test("re-init retires generated files the new profile no longer produces without quarantine churn", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const wt = path.join(dir, ".claude", "skills", "stdd-worktrees", "SKILL.md");
	assert.ok(fs.existsSync(wt));
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ capabilities: { worktrees: false } }),
	);
	await run(["init", dir, "--tools", "claude"]);
	assert.ok(!fs.existsSync(wt), "stale generated skill is retired from its agent load path");
	const firstManifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	const quarantines = Object.keys(firstManifest.files).filter((file) =>
		path.posix.basename(file).startsWith(".stdd-cleanup-"),
	);
	assert.ok(quarantines.length > 0, "identity-safe cleanup remains manifest-accounted");
	await run(["init", dir, "--tools", "claude"]);
	const secondManifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(
		Object.keys(secondManifest.files).sort(),
		Object.keys(firstManifest.files).sort(),
		"re-init keeps existing quarantine paths stable",
	);
	const check = await run(["check", dir]);
	assert.equal(check.code, 0, check.stderr);
});

test("a cleanup failure leaves the previous manifest authoritative", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const staleSkill = path.join(dir, ".claude", "skills", "stdd-worktrees", "SKILL.md");
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const previousManifest = fs.readFileSync(manifestPath, "utf8");
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities.worktrees = false;
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	const hookPath = path.join(tmpRepo(), "fail-generated-cleanup.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const staleSkill = ${JSON.stringify(staleSkill)};
const originalRemove = fs.rmSync;
const originalRename = fs.renameSync;
fs.rmSync = function (target, ...args) {
  if (path.resolve(String(target)) === staleSkill) throw new Error("injected generated cleanup failure");
  return originalRemove.call(this, target, ...args);
};
fs.renameSync = function (source, target, ...args) {
  if (String(target).includes(".stdd-cleanup-")) throw new Error("injected generated cleanup failure");
  return originalRename.call(this, source, target, ...args);
};
`,
	);

	const reinitialized = await run(["init", dir, "--tools", "claude"], {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(reinitialized.code, 1, reinitialized.stdout + reinitialized.stderr);
	assert.match(reinitialized.stderr, /injected generated cleanup failure/);
	assert.ok(fs.existsSync(staleSkill));
	assert.equal(
		fs.readFileSync(manifestPath, "utf8"),
		previousManifest,
		"a failed cleanup cannot publish a manifest that forgets the live skill",
	);
});

test("generated cleanup cannot be redirected outside by a final parent-directory swap", async () => {
	const root = tmpRepo();
	const dir = path.join(root, "repo");
	fs.mkdirSync(dir);
	await run(["init", dir, "--tools", "claude"]);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities.worktrees = false;
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);

	const target = path.join(dir, ".stdd", "playbooks", "worktrees.md");
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifestBefore = fs.readFileSync(manifestPath, "utf8");
	const parent = path.dirname(target);
	const parkedParent = path.join(root, "parked-playbooks");
	const outsideParent = path.join(root, "outside");
	const victim = path.join(outsideParent, "worktrees.md");
	fs.mkdirSync(outsideParent);
	fs.writeFileSync(victim, fs.readFileSync(target));
	const hookPath = path.join(root, "swap-cleanup-parent.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)};
const parent = ${JSON.stringify(parent)};
const parked = ${JSON.stringify(parkedParent)};
const outside = ${JSON.stringify(outsideParent)};
const originalRemove = fs.rmSync;
const originalRename = fs.renameSync;
let swapped = false;
function swap() {
  if (swapped) return;
  swapped = true;
  originalRename.call(fs, parent, parked);
  fs.symlinkSync(outside, parent, "dir");
}
fs.rmSync = function (candidate, ...args) {
  const text = String(candidate);
  if (!swapped && (path.resolve(text) === target || text.includes(".stdd-cleanup-"))) {
    swap();
  }
  return originalRemove.call(this, candidate, ...args);
};
fs.renameSync = function (source, targetPath, ...args) {
  if (!swapped && String(targetPath).includes(".stdd-cleanup-")) swap();
  return originalRename.call(this, source, targetPath, ...args);
};
`,
	);

	const result = await run(["init", dir, "--tools", "claude"], {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.ok(fs.existsSync(victim), "cleanup must not delete the same-named file outside the repo");
	assert.deepEqual(fs.readFileSync(victim), fs.readFileSync(path.join(parkedParent, "worktrees.md")));
	assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
});

test("post-quarantine faults always restore or publish every live cleanup path", async () => {
	for (const mode of ["post-rename-lstat", "rollback-failure", "source-replacement"]) {
		const dir = tmpRepo();
		await run(["init", dir, "--tools", "claude"]);
		const configPath = path.join(dir, ".stdd", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.capabilities.worktrees = false;
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
		const target = path.join(dir, ".stdd", "playbooks", "worktrees.md");
		const original = fs.readFileSync(target);
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const manifestBefore = fs.readFileSync(manifestPath, "utf8");
		const hookPath = path.join(tmpRepo(), `cleanup-${mode}.mjs`);
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
const mode = ${JSON.stringify(mode)};
const target = ${JSON.stringify(target)};
const originalRename = fs.renameSync;
const originalLstat = fs.lstatSync;
let quarantine = null;
let injected = false;
fs.renameSync = function (source, destination, ...args) {
  if (quarantine && String(source) === quarantine && mode === "rollback-failure") {
    throw new Error("injected cleanup rollback failure");
  }
  const result = originalRename.call(this, source, destination, ...args);
  if (!quarantine && String(destination).includes(".stdd-cleanup-")) {
    quarantine = String(destination);
    if (mode === "source-replacement") fs.writeFileSync(target, "attacker replacement\\n");
  }
  return result;
};
fs.lstatSync = function (candidate, ...args) {
  if (!injected && quarantine && String(candidate) === quarantine) {
    injected = true;
    throw new Error("injected post-rename lstat failure");
  }
  return originalLstat.call(this, candidate, ...args);
};
`,
		);
		const result = await run(["init", dir, "--tools", "claude"], {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});

		if (mode === "post-rename-lstat") {
			assert.equal(result.code, 1, result.stdout + result.stderr);
			assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
			assert.deepEqual(fs.readFileSync(target), original);
			continue;
		}
		assert.equal(result.code, 0, `${mode}: ${result.stdout}${result.stderr}`);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		const quarantineEntries = Object.keys(manifest.files).filter(
			(file) => file.startsWith(".stdd/playbooks/.stdd-cleanup-") && file.endsWith(".tmp"),
		);
		assert.equal(quarantineEntries.length, 1, mode);
		assert.deepEqual(fs.readFileSync(path.join(dir, quarantineEntries[0])), original, mode);
		if (mode === "rollback-failure") {
			assert.ok(!fs.existsSync(target));
			assert.ok(!Object.hasOwn(manifest.files, ".stdd/playbooks/worktrees.md"));
		} else {
			assert.equal(fs.readFileSync(target, "utf8"), "attacker replacement\n");
			assert.ok(Object.hasOwn(manifest.files, ".stdd/playbooks/worktrees.md"));
			const checked = await run(["check", dir]);
			assert.equal(checked.code, 1, checked.stdout + checked.stderr);
			assert.match(checked.stderr, /\.stdd\/playbooks\/worktrees\.md: edited by hand or stale/i);
		}
	}
});

test("manifest write failures rollback while rename-boundary failures stay journaled", async () => {
	for (const multiple of [false, true]) {
		for (const phase of ["temp-write", "final-rename"]) {
			const { dir, args, sources } = await cleanupTransactionFixture(multiple);
			const manifestPath = path.join(dir, ".stdd", "manifest.json");
			const manifestBefore = fs.readFileSync(manifestPath, "utf8");
			const sourceBytes = Object.fromEntries(
				sources.map((source) => [source, fs.readFileSync(path.join(dir, source))]),
			);
			const hookPath = path.join(tmpRepo(), `fail-${phase}.mjs`);
			fs.writeFileSync(
				hookPath,
				`import fs from "node:fs";
import path from "node:path";
const manifest = ${JSON.stringify(manifestPath)};
const phase = ${JSON.stringify(phase)};
const originalOpen = fs.openSync;
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
let manifestFd = null;
fs.openSync = function (target, ...args) {
  const fd = originalOpen.call(this, target, ...args);
  if (path.basename(String(target)).startsWith(".manifest-")) manifestFd = fd;
  return fd;
};
fs.writeFileSync = function (target, ...args) {
  if (phase === "temp-write" && target === manifestFd) {
    manifestFd = null;
    throw new Error("injected manifest temp write failure");
  }
  return originalWrite.call(this, target, ...args);
};
fs.renameSync = function (source, target, ...args) {
  if (phase === "final-rename" && path.basename(String(target)) === "manifest.json") {
    throw new Error("injected manifest final rename failure");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
			);

			const failed = await run(args, {
				env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
			});
			assert.equal(failed.code, 1, `${phase}/${multiple}: ${failed.stdout}${failed.stderr}`);
			assert.match(failed.stderr, /injected manifest (temp write|final rename) failure/);
			assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
			const journalPath = path.join(dir, ".stdd", "cleanup-transaction.json");
			if (phase === "temp-write") {
				for (const source of sources) {
					assert.deepEqual(fs.readFileSync(path.join(dir, source)), sourceBytes[source], source);
				}
				assert.ok(!fs.existsSync(journalPath));
			} else {
				assert.ok(fs.existsSync(journalPath));
				const recovered = await run(args);
				assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
				assert.ok(!fs.existsSync(journalPath));
			}
		}
	}
});

test("a manifest rename that succeeds before reporting failure remains journaled until recovery", async () => {
	const { dir, args, sources } = await cleanupTransactionFixture(true);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifestBefore = fs.readFileSync(manifestPath, "utf8");
	const hookPath = path.join(tmpRepo(), "fail-after-manifest-rename.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const manifest = ${JSON.stringify(manifestPath)};
const originalRename = fs.renameSync;
fs.renameSync = function (source, target, ...args) {
  const result = originalRename.call(this, source, target, ...args);
  if (path.basename(String(target)) === "manifest.json") {
    throw new Error("injected failure after manifest rename");
  }
  return result;
};
`,
	);
	const failed = await run(args, {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /injected failure after manifest rename/);
	assert.notEqual(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	for (const source of sources) {
		assert.ok(!fs.existsSync(path.join(dir, source)), source);
		assert.ok(
			Object.keys(manifest.files).some(
				(file) =>
					path.posix.dirname(file) === path.posix.dirname(source) &&
					path.posix.basename(file).startsWith(".stdd-cleanup-"),
			),
			source,
		);
	}
	const journalPath = path.join(dir, ".stdd", "cleanup-transaction.json");
	assert.ok(fs.existsSync(journalPath));
	const recovered = await run(args);
	assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
	assert.ok(!fs.existsSync(journalPath));
});

test("manifest fsync and journal-clear faults preserve the right side of the WAL boundary", async () => {
	for (const mode of ["file-fsync", "directory-fsync", "journal-clear"]) {
		const { dir, args, sources } = await cleanupTransactionFixture(true);
		const stddDir = path.join(dir, ".stdd");
		const manifestPath = path.join(stddDir, "manifest.json");
		const manifestBefore = fs.readFileSync(manifestPath, "utf8");
		const sourceBytes = Object.fromEntries(
			sources.map((source) => [source, fs.readFileSync(path.join(dir, source))]),
		);
		const hookPath = path.join(tmpRepo(), `manifest-${mode}.mjs`);
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const mode = ${JSON.stringify(mode)};
const stddDir = ${JSON.stringify(stddDir)};
const originalOpen = fs.openSync;
const originalFsync = fs.fsyncSync;
const originalRename = fs.renameSync;
let manifestFd = null;
let parentFd = null;
let manifestRenamed = false;
let faulted = false;
fs.openSync = function (target, ...args) {
  if (
    !faulted &&
    mode === "journal-clear" &&
    path.basename(String(target)) === "cleanup-transaction.json" &&
    typeof args[0] === "number" &&
    (args[0] & fs.constants.O_RDWR) === fs.constants.O_RDWR
  ) {
    faulted = true;
    throw new Error("injected cleanup journal clear failure");
  }
  const fd = originalOpen.call(this, target, ...args);
  if (path.basename(String(target)).startsWith(".manifest-")) manifestFd = fd;
  if (path.resolve(String(target)) === stddDir) parentFd = fd;
  return fd;
};
fs.renameSync = function (source, target, ...args) {
  const result = originalRename.call(this, source, target, ...args);
  if (path.basename(String(target)) === "manifest.json") manifestRenamed = true;
  return result;
};
fs.fsyncSync = function (fd) {
  if (!faulted && mode === "file-fsync" && fd === manifestFd) {
    faulted = true;
    manifestFd = null;
    throw new Error("injected manifest file fsync failure");
  }
  if (!faulted && mode === "directory-fsync" && manifestRenamed && fd === parentFd) {
    faulted = true;
    throw new Error("injected manifest directory fsync failure");
  }
  return originalFsync.call(this, fd);
};
`,
		);
		const failed = await run(args, {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(failed.code, 1, `${mode}: ${failed.stdout}${failed.stderr}`);
		assert.match(failed.stderr, /injected manifest|injected cleanup journal clear/i);
		const journalPath = path.join(stddDir, "cleanup-transaction.json");
		if (mode === "file-fsync") {
			assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
			for (const source of sources) {
				assert.deepEqual(fs.readFileSync(path.join(dir, source)), sourceBytes[source], source);
			}
			assert.ok(!fs.existsSync(journalPath));
		} else {
			assert.notEqual(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
			assert.ok(fs.existsSync(journalPath));
			const recovered = await run(args);
			assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
			assert.ok(!fs.existsSync(journalPath));
		}
	}
});

test("cleanup journal clear preserves a basename replacement and reports failure", async () => {
	const { args } = await cleanupTransactionFixture(false);
	const root = tmpRepo();
	const parked = path.join(root, "descriptor-bound-journal.json");
	const marker = path.join(root, "journal-clear-race.json");
	const replacement = "attacker cleanup journal replacement survives\n";
	const hookPath = path.join(root, "cleanup-journal-clear-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const parked = ${JSON.stringify(parked)};
const marker = ${JSON.stringify(marker)};
const replacement = ${JSON.stringify(replacement)};
const originalUnlink = fs.unlinkSync;
const originalRename = fs.renameSync;
let raced = false;
function canonical(candidate) {
  return path.join(fs.realpathSync(path.dirname(String(candidate))), path.basename(String(candidate)));
}
fs.unlinkSync = function (target, ...args) {
  if (!raced && path.basename(String(target)) === "cleanup-transaction.json") {
    raced = true;
    const replacementPath = canonical(target);
    originalRename.call(fs, target, parked);
    fs.writeFileSync(target, replacement, { mode: 0o600 });
    fs.writeFileSync(marker, JSON.stringify({ replacementPath, operation: "unlink" }));
  }
  return originalUnlink.call(this, target, ...args);
};
fs.renameSync = function (source, target, ...args) {
  if (
    !raced &&
    path.basename(String(source)) === "cleanup-transaction.json" &&
    (
      path.basename(String(target)).startsWith(".cleanup-journal-cleared-") ||
      (
        path.basename(String(target)).startsWith("cleanup-journal-") &&
        path.basename(String(target)).endsWith(".tombstone")
      )
    )
  ) {
    raced = true;
    const replacementPath = canonical(target);
    originalRename.call(fs, source, parked);
    fs.writeFileSync(source, replacement, { mode: 0o600 });
    fs.writeFileSync(marker, JSON.stringify({ replacementPath, operation: "rename" }));
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);

	const failed = await run(args, {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});

	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /cleanup journal.*changed.*clear/i);
	const raced = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.equal(fs.readFileSync(raced.replacementPath, "utf8"), replacement);
	assert.ok(fs.existsSync(parked), "the descriptor-bound journal inode is preserved");
	assert.equal(fs.statSync(parked).size, 0, "the exact journal bytes were wiped before the race");
});

test("cleanup journal clear rechecks its retired inode after descriptor close", async () => {
	const { args } = await cleanupTransactionFixture(false);
	const root = tmpRepo();
	const parked = path.join(root, "postflight-journal.json");
	const marker = path.join(root, "journal-clear-postflight.json");
	const replacement = "attacker postflight journal replacement survives\n";
	const hookPath = path.join(root, "cleanup-journal-clear-postflight.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const parked = ${JSON.stringify(parked)};
const marker = ${JSON.stringify(marker)};
const replacement = ${JSON.stringify(replacement)};
const originalLstat = fs.lstatSync;
const originalRename = fs.renameSync;
let retired = null;
let raced = false;
fs.renameSync = function (source, target, ...args) {
  const result = originalRename.call(this, source, target, ...args);
  if (
    path.basename(String(source)) === "cleanup-transaction.json" &&
    (
      path.basename(String(target)).startsWith(".cleanup-journal-cleared-") ||
      (
        path.basename(String(target)).startsWith("cleanup-journal-") &&
        path.basename(String(target)).endsWith(".tombstone")
      )
    )
  ) {
    retired = String(target);
  }
  return result;
};
fs.lstatSync = function (target, ...args) {
  const stat = originalLstat.call(this, target, ...args);
  if (!raced && retired !== null && String(target) === retired) {
    raced = true;
    const replacementPath = path.join(
      fs.realpathSync(path.dirname(String(target))),
      path.basename(String(target)),
    );
    originalRename.call(fs, target, parked);
    fs.writeFileSync(target, replacement, { mode: 0o600 });
    fs.writeFileSync(marker, JSON.stringify({ replacementPath }));
  }
  return stat;
};
`,
	);

	const failed = await run(args, {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});

	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /cleanup journal.*changed.*clear/i);
	const raced = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.equal(fs.readFileSync(raced.replacementPath, "utf8"), replacement);
	assert.ok(fs.existsSync(parked), "the exact cleared inode survives the postflight race");
	assert.equal(fs.statSync(parked).size, 0, "the quarantined exact inode contains no journal bytes");
});

test("successful cleanup journal settlement leaves only a zeroed OS-temp tombstone", async () => {
	const { dir, args } = await cleanupTransactionFixture(false);
	const prefix = "stdd-cleanup-journal-quarantine-";
	const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)));

	const initialized = await run(args);

	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "cleanup-transaction.json")));
	assert.deepEqual(
		fs
			.readdirSync(path.join(dir, ".stdd"))
			.filter((name) => name.startsWith(".cleanup-journal-cleared-")),
		[],
		"successful settlement leaves no retired journal artifact in the checkout",
	);
	const created = fs
		.readdirSync(os.tmpdir())
		.filter((name) => name.startsWith(prefix) && !before.has(name));
	assert.equal(created.length, 1, "one private OS-temp quarantine is allocated");
	const quarantine = path.join(os.tmpdir(), created[0]);
	assert.equal(fs.statSync(quarantine).mode & 0o777, 0o700);
	const files = fs.readdirSync(quarantine);
	assert.ok(files.includes("README.txt"));
	const tombstones = files.filter((name) => name !== "README.txt");
	assert.equal(tombstones.length, 1);
	assert.equal(fs.statSync(path.join(quarantine, tombstones[0])).size, 0);
	assert.match(fs.readFileSync(path.join(quarantine, "README.txt"), "utf8"), /do not load/i);
	for (const name of files) {
		assert.doesNotMatch(fs.readFileSync(path.join(quarantine, name), "utf8"), /"entries"/);
	}
});

test("cleanup journal settlement falls back to a same-device quarantine outside the checkout", async (t) => {
	const alternateTemp = "/dev/shm";
	if (!fs.existsSync(alternateTemp) || fs.statSync(alternateTemp).dev === fs.statSync(os.tmpdir()).dev) {
		t.skip("requires an alternate OS-temp directory on another device");
		return;
	}
	const { dir, args } = await cleanupTransactionFixture(false);
	const quarantineParent = path.dirname(dir);
	const prefix = "stdd-cleanup-journal-quarantine-";
	const before = new Set(fs.readdirSync(quarantineParent).filter((name) => name.startsWith(prefix)));

	const initialized = await run(args, {
		env: { ...process.env, TMPDIR: alternateTemp, TMP: alternateTemp, TEMP: alternateTemp },
	});

	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "cleanup-transaction.json")));
	const created = fs
		.readdirSync(quarantineParent)
		.filter((name) => name.startsWith(prefix) && !before.has(name));
	assert.equal(created.length, 1, "the same-device sibling quarantine is outside the checkout");
	assert.ok(!path.join(quarantineParent, created[0]).startsWith(`${dir}${path.sep}`));
	const tombstones = fs
		.readdirSync(path.join(quarantineParent, created[0]))
		.filter((name) => name !== "README.txt");
	assert.equal(tombstones.length, 1);
	assert.equal(fs.statSync(path.join(quarantineParent, created[0], tombstones[0])).size, 0);
});

test("cleanup WAL publication cannot be redirected by a swap inside held open or rename", async () => {
	for (const mode of ["temp-open", "journal-rename"]) {
		const { dir, args } = await cleanupTransactionFixture(false);
		const stddDir = path.join(dir, ".stdd");
		const root = tmpRepo();
		const parked = path.join(root, `parked-${mode}`);
		const outside = path.join(root, `outside-${mode}`);
		fs.mkdirSync(outside);
		const outsideJournal = path.join(outside, "cleanup-transaction.json");
		fs.writeFileSync(outsideJournal, "outside must survive\n");
		const hookPath = path.join(root, `swap-wal-${mode}.mjs`);
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const mode = ${JSON.stringify(mode)};
const stddDir = ${JSON.stringify(stddDir)};
const parked = ${JSON.stringify(parked)};
const outside = ${JSON.stringify(outside)};
const originalOpen = fs.openSync;
const originalRename = fs.renameSync;
let swapped = false;
function swap() {
  if (swapped) return;
  swapped = true;
  originalRename.call(fs, stddDir, parked);
  fs.symlinkSync(outside, stddDir, "dir");
}
fs.openSync = function (target, ...args) {
  if (
    mode === "temp-open" &&
    !swapped &&
    path.basename(String(target)).startsWith(".cleanup-journal-")
  ) swap();
  return originalOpen.call(this, target, ...args);
};
fs.renameSync = function (source, target, ...args) {
  if (
    mode === "journal-rename" &&
    !swapped &&
    path.basename(String(target)) === "cleanup-transaction.json"
  ) swap();
  return originalRename.call(this, source, target, ...args);
};
`,
		);
		const failed = await run(args, {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(failed.code, 1, `${mode}: ${failed.stdout}${failed.stderr}`);
		assert.equal(fs.readFileSync(outsideJournal, "utf8"), "outside must survive\n");
		const parkedJournal = path.join(parked, "cleanup-transaction.json");
		assert.ok(fs.existsSync(parkedJournal), "the held original parent receives the WAL");
		const journal = JSON.parse(fs.readFileSync(parkedJournal, "utf8"));
		assert.equal(journal.entries[0].phase, "planned");
	}
});

test("a partial manifest-failure rollback stays journaled and the next init recovers it", async () => {
	const { dir, args, sources } = await cleanupTransactionFixture(true);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifestBefore = fs.readFileSync(manifestPath, "utf8");
	const sourceBytes = Object.fromEntries(
		sources.map((source) => [source, fs.readFileSync(path.join(dir, source))]),
	);
	const hookPath = path.join(tmpRepo(), "partial-cleanup-rollback.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const originalWrite = fs.writeFileSync;
const originalOpen = fs.openSync;
const originalRename = fs.renameSync;
let blockedRollback = false;
let manifestFd = null;
fs.openSync = function (target, ...args) {
  const fd = originalOpen.call(this, target, ...args);
  if (path.basename(String(target)).startsWith(".manifest-")) manifestFd = fd;
  return fd;
};
fs.writeFileSync = function (target, ...args) {
  if (target === manifestFd) {
    manifestFd = null;
    throw new Error("injected manifest temp write failure");
  }
  return originalWrite.call(this, target, ...args);
};
fs.renameSync = function (source, target, ...args) {
  if (!blockedRollback && String(source).includes(".stdd-cleanup-")) {
    blockedRollback = true;
    throw new Error("injected one-entry rollback failure");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);

	const failed = await run(args, {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /cleanup-transaction\.json remains for recovery/);
	assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
	const journalPath = path.join(dir, ".stdd", "cleanup-transaction.json");
	const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
	assert.equal(journal.entries.length, sources.length);
	assert.ok(journal.entries.some((entry) => entry.phase === "unresolved"));
	assert.ok(journal.entries.some((entry) => entry.phase === "planned"));
	for (const entry of journal.entries) {
		assert.match(entry.source, /worktrees/);
		assert.match(entry.quarantine, /\.stdd-cleanup-[0-9a-f]{32}\.tmp$/);
		assert.match(entry.hash, /^sha256:[0-9a-f]{64}$/);
		assert.match(entry.parentDev, /^\d+$/);
		assert.match(entry.parentIno, /^\d+$/);
		assert.match(entry.fileDev, /^\d+$/);
		assert.match(entry.fileIno, /^\d+$/);
	}
	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1, checked.stdout + checked.stderr);
	assert.match(checked.stderr, /cleanup-transaction\.json.*pending/i);
	const diagnosed = await run(["doctor", dir]);
	assert.equal(diagnosed.code, 1, diagnosed.stdout + diagnosed.stderr);
	assert.match(`${diagnosed.stdout}${diagnosed.stderr}`, /cleanup-transaction\.json.*pending/i);

	const recovered = await run(args);
	assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
	assert.ok(!fs.existsSync(journalPath));
	for (const [source, bytes] of Object.entries(sourceBytes)) {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		const retired = Object.keys(manifest.files).find(
			(file) =>
				path.posix.dirname(file) === path.posix.dirname(source) &&
				path.posix.basename(file).startsWith(".stdd-cleanup-"),
		);
		assert.ok(retired, source);
		assert.deepEqual(fs.readFileSync(path.join(dir, retired)), bytes, source);
	}
});

test("combined parent swap and rollback failure leaves an identity-complete unresolved journal", async () => {
	const root = tmpRepo();
	const dir = path.join(root, "repo");
	fs.mkdirSync(dir);
	await run(["init", dir, "--tools", "claude"]);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities.worktrees = false;
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	const source = path.join(dir, ".stdd", "playbooks", "worktrees.md");
	const parent = path.dirname(source);
	const parked = path.join(root, "parked-playbooks");
	const outside = path.join(root, "outside-playbooks");
	fs.mkdirSync(outside);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifestBefore = fs.readFileSync(manifestPath, "utf8");
	const hookPath = path.join(root, "swap-and-fail-rollback.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
const parent = ${JSON.stringify(parent)};
const parked = ${JSON.stringify(parked)};
const outside = ${JSON.stringify(outside)};
const originalRename = fs.renameSync;
let quarantine = null;
let swapped = false;
fs.renameSync = function (source, target, ...args) {
  if (quarantine && String(source) === quarantine) {
    throw new Error("injected held-parent rollback failure");
  }
  const result = originalRename.call(this, source, target, ...args);
  if (!swapped && String(target).includes(".stdd-cleanup-")) {
    quarantine = String(target);
    swapped = true;
    originalRename.call(fs, parent, parked);
    fs.symlinkSync(outside, parent, "dir");
  }
  return result;
};
`,
	);
	const failed = await run(["init", dir, "--tools", "claude"], {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
	const manifest = JSON.parse(manifestBefore);
	assert.ok(
		!Object.keys(manifest.files).some((file) => path.basename(file).startsWith(".stdd-cleanup-")),
		"the old manifest never publishes a lexical quarantine under the replacement parent",
	);
	const journalPath = path.join(dir, ".stdd", "cleanup-transaction.json");
	const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	const entry = journal.entries.find((candidate) => candidate.source === ".stdd/playbooks/worktrees.md");
	assert.equal(entry.phase, "unresolved");
	assert.match(entry.reason, /symlink|logical parent no longer maps/i);
	assert.ok(fs.existsSync(path.join(parked, path.basename(entry.quarantine))));

	const retried = await run(["init", dir, "--tools", "claude"]);
	assert.equal(retried.code, 1, retried.stdout + retried.stderr);
	assert.match(retried.stderr, /cleanup-transaction\.json has unresolved cleanup state/i);
	assert.ok(fs.existsSync(journalPath));
});

test("hostile settlement probes become durable unresolved state without a recursive throw", async () => {
	const { dir, args } = await cleanupTransactionFixture(false);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifestBefore = fs.readFileSync(manifestPath, "utf8");
	const hookPath = path.join(tmpRepo(), "throw-settlement-probe.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
const originalRename = fs.renameSync;
const originalLstat = fs.lstatSync;
const originalExists = fs.existsSync;
let quarantine = null;
let tripped = false;
fs.renameSync = function (source, target, ...args) {
  const result = originalRename.call(this, source, target, ...args);
  if (!quarantine && String(target).includes(".stdd-cleanup-")) quarantine = String(target);
  return result;
};
fs.lstatSync = function (candidate, ...args) {
  if (!tripped && quarantine && String(candidate) === quarantine) {
    tripped = true;
    throw new Error("injected settlement lstat failure");
  }
  return originalLstat.call(this, candidate, ...args);
};
fs.existsSync = function (candidate) {
  if (tripped && String(candidate).startsWith("/proc/self/fd/")) {
    throw new Error("injected settlement exists probe failure");
  }
  return originalExists.call(this, candidate);
};
`,
	);
	const failed = await run(args, {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /settlement could not inspect its paths/i);
	assert.doesNotMatch(failed.stderr, /\n\s+at |Maximum call stack|recursive/i);
	assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
	const journal = JSON.parse(
		fs.readFileSync(path.join(dir, ".stdd", "cleanup-transaction.json"), "utf8"),
	);
	assert.equal(journal.entries[0].phase, "unresolved");
});

test("cleanup journal trust rejects every non-exact private mode and hard links", async () => {
	for (const mode of [0o640, 0o400, 0o660]) {
		const { dir, journalPath } = await cleanupJournalFixture();
		fs.chmodSync(journalPath, mode);
		const checked = await run(["check", dir]);
		assert.equal(checked.code, 1, `${mode.toString(8)}: ${checked.stdout}${checked.stderr}`);
		assert.match(checked.stderr, /cleanup-transaction\.json.*single-linked.*exactly mode 0600/i);
		assert.doesNotMatch(checked.stderr, /\n\s+at |node:fs/i);
	}

	const { dir, journalPath } = await cleanupJournalFixture();
	const alias = path.join(tmpRepo(), "journal-hardlink");
	fs.linkSync(journalPath, alias);
	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1, checked.stdout + checked.stderr);
	assert.match(checked.stderr, /cleanup-transaction\.json.*single-linked/i);
	assert.equal(fs.lstatSync(journalPath).nlink, 2);
});

test("cleanup journal rejects a foreign owner when the platform can create one", async (t) => {
	if (typeof process.getuid !== "function" || process.getuid() !== 0) {
		t.skip("requires permission to create a foreign-owned fixture");
		return;
	}
	const { dir, journalPath } = await cleanupJournalFixture();
	fs.chownSync(journalPath, 1, 1);
	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1, checked.stdout + checked.stderr);
	assert.match(checked.stderr, /cleanup-transaction\.json.*owned by the current user/i);
});

test("cleanup journal symlink and replacement races fail with a safe diagnostic", async () => {
	{
		const { dir, journalPath } = await cleanupJournalFixture();
		const target = path.join(tmpRepo(), "journal-target");
		fs.renameSync(journalPath, target);
		fs.symlinkSync(target, journalPath);
		const checked = await run(["check", dir]);
		assert.equal(checked.code, 1, checked.stdout + checked.stderr);
		assert.match(checked.stderr, /cleanup-transaction\.json.*invalid cleanup transaction journal/i);
		assert.doesNotMatch(checked.stderr, /\n\s+at |node:fs/i);
	}

	{
		const { dir, journalPath } = await cleanupJournalFixture();
		const hookPath = path.join(tmpRepo(), "replace-cleanup-journal-on-open.mjs");
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
const journal = ${JSON.stringify(journalPath)};
const parked = journal + ".parked";
const originalOpen = fs.openSync;
const originalRename = fs.renameSync;
const originalRead = fs.readFileSync;
const originalWrite = fs.writeFileSync;
let replaced = false;
fs.openSync = function (candidate, ...args) {
  if (!replaced && String(candidate).endsWith("/cleanup-transaction.json")) {
    replaced = true;
    const bytes = originalRead.call(fs, journal);
    originalRename.call(fs, journal, parked);
    originalWrite.call(fs, journal, bytes, { mode: 0o600 });
  }
  return originalOpen.call(this, candidate, ...args);
};
`,
		);
		const checked = await run(["check", dir], {
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(checked.code, 1, checked.stdout + checked.stderr);
		assert.match(checked.stderr, /cleanup-transaction\.json.*changed|unchanged regular file/i);
		assert.doesNotMatch(checked.stderr, /\n\s+at |node:fs/i);
	}
});

test("a parent swap inside the actual held rollback rename cannot touch the replacement parent", async () => {
	const { dir, args } = await cleanupTransactionFixture(true);
	const source = path.join(dir, ".stdd", "playbooks", "worktrees.md");
	const original = fs.readFileSync(source);
	const parent = path.dirname(source);
	const root = tmpRepo();
	const parked = path.join(root, "parked-playbooks");
	const outside = path.join(root, "outside-playbooks");
	fs.mkdirSync(outside);
	const outsideVictim = path.join(outside, "worktrees.md");
	fs.writeFileSync(outsideVictim, "outside must survive\n");
	const hookPath = path.join(root, "swap-during-held-rollback.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const parent = ${JSON.stringify(parent)};
const parked = ${JSON.stringify(parked)};
const outside = ${JSON.stringify(outside)};
const originalWrite = fs.writeFileSync;
const originalOpen = fs.openSync;
const originalRename = fs.renameSync;
let swapped = false;
let manifestFd = null;
fs.openSync = function (target, ...args) {
  const fd = originalOpen.call(this, target, ...args);
  if (path.basename(String(target)).startsWith(".manifest-")) manifestFd = fd;
  return fd;
};
fs.writeFileSync = function (target, ...args) {
  if (target === manifestFd) {
    manifestFd = null;
    throw new Error("injected manifest publish failure");
  }
  return originalWrite.call(this, target, ...args);
};
fs.renameSync = function (source, target, ...args) {
  if (
    !swapped &&
    String(source).startsWith("/proc/self/fd/") &&
    String(source).includes(".stdd-cleanup-") &&
    path.basename(String(target)) === "worktrees.md"
  ) {
    swapped = true;
    originalRename.call(fs, parent, parked);
    fs.symlinkSync(outside, parent, "dir");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);
	const failed = await run(args, {
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.equal(fs.readFileSync(outsideVictim, "utf8"), "outside must survive\n");
	assert.deepEqual(fs.readFileSync(path.join(parked, "worktrees.md")), original);
	const journal = JSON.parse(
		fs.readFileSync(path.join(dir, ".stdd", "cleanup-transaction.json"), "utf8"),
	);
	const entry = journal.entries.find((candidate) => candidate.source === ".stdd/playbooks/worktrees.md");
	assert.equal(entry.phase, "unresolved");
	assert.match(entry.reason, /logical parent changed during held-parent rollback/i);
});

test("a hand-edited formerly generated skill stays manifest-tracked and reports stale", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const staleRelative = ".claude/skills/stdd-worktrees/SKILL.md";
	const staleSkill = path.join(dir, staleRelative);
	fs.appendFileSync(staleSkill, "\nUser-owned preservation marker.\n");
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities.worktrees = false;
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);

	const reinitialized = await run(["init", dir, "--tools", "claude"]);
	assert.equal(reinitialized.code, 0, reinitialized.stdout + reinitialized.stderr);
	assert.ok(fs.existsSync(staleSkill), "the edited file is preserved for its owner");
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.ok(manifest.files[staleRelative], "the preserved generated file remains accountable");
	const checked = await run(["check", dir]);
	assert.equal(checked.code, 1, checked.stdout + checked.stderr);
	assert.match(checked.stderr, /stdd-worktrees\/SKILL\.md: .*edited by hand or stale/);
});

test("re-init removes only the managed instruction block for a deselected agent", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex"]);
	const agentsPath = path.join(dir, "AGENTS.md");
	fs.writeFileSync(
		agentsPath,
		fs
			.readFileSync(agentsPath, "utf8")
			.replace("<!-- stdd:begin", "# User-owned Codex rule\n\n<!-- stdd:begin"),
	);

	await run(["init", dir, "--tools", "claude"]);
	const agents = fs.readFileSync(agentsPath, "utf8");
	assert.match(agents, /User-owned Codex rule/);
	assert.doesNotMatch(agents, /<!-- stdd:begin|stdd-start-change/);
	assert.ok(!fs.existsSync(path.join(dir, ".agents", "skills", "stdd-start-change", "SKILL.md")));
	assert.ok(fs.existsSync(path.join(dir, "CLAUDE.md")));
	const doctor = await run(["doctor", dir]);
	assert.doesNotMatch(
		`${doctor.stdout}${doctor.stderr}`,
		/AGENTS\.md has no managed STDD routing contract/,
		"doctor grades only the selected agent targets",
	);
});

test("deselecting Pi removes only its router while Codex keeps the shared skills", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex,pi"]);
	const piInstructionsPath = path.join(dir, ".pi", "APPEND_SYSTEM.md");
	fs.writeFileSync(
		piInstructionsPath,
		fs
			.readFileSync(piInstructionsPath, "utf8")
			.replace("<!-- stdd:begin", "# User-owned Pi rule\n\n<!-- stdd:begin"),
	);

	const reinitialized = await run(["init", dir, "--tools", "codex"]);
	assert.equal(reinitialized.code, 0, reinitialized.stdout + reinitialized.stderr);
	const instructions = fs.readFileSync(piInstructionsPath, "utf8");
	assert.match(instructions, /User-owned Pi rule/);
	assert.doesNotMatch(instructions, /<!-- stdd:begin|\/skill:stdd-start-change/);
	assert.ok(
		fs.existsSync(path.join(dir, ".agents", "skills", "stdd-start-change", "SKILL.md")),
		"Codex still owns the shared Agent Skills output",
	);
	assert.ok(fs.existsSync(path.join(dir, "AGENTS.md")));
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(manifest.targets.tools, ["codex"]);
	assert.ok(!(".stdd/PI-snippet.md" in manifest.files));
});

test("local recipes compile to native skills and override the kit by name", async () => {
	const dir = tmpRepo();
	const local = path.join(dir, ".stdd", "playbooks", "local");
	fs.mkdirSync(local, { recursive: true });
	fs.writeFileSync(
		path.join(local, "deploy.md"),
		"---\nname: acme-deploy\ndescription: Deploy the acme stack\nwhen: Releasing to production.\n---\n\nRun the deploy pipeline.\n",
	);
	fs.writeFileSync(
		path.join(local, "debugging.md"),
		"---\nname: stdd-debugging\ndescription: Project debugging override\n---\n\nProject-specific debugging.\n",
	);
	const res = await run(["init", dir, "--tools", "claude,codex"]);
	assert.equal(res.code, 0, res.stderr);
	const deploy = fs.readFileSync(path.join(dir, ".claude", "skills", "acme-deploy", "SKILL.md"), "utf8");
	assert.match(deploy, /Deploy the acme stack/);
	const dbg = fs.readFileSync(path.join(dir, ".claude", "skills", "stdd-debugging", "SKILL.md"), "utf8");
	assert.match(dbg, /Project-specific debugging/);
	assert.match(res.stdout, /overrides/);
	const codexDeploy = fs.readFileSync(
		path.join(dir, ".agents", "skills", "acme-deploy", "SKILL.md"),
		"utf8",
	);
	assert.equal(codexDeploy, deploy);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.equal(manifest.files[".stdd/playbooks/local/deploy.md"], undefined, "sources are user-owned");
	assert.ok(manifest.files[".claude/skills/acme-deploy/SKILL.md"], "generated skills are manifested");
	assert.ok(manifest.files[".agents/skills/acme-deploy/SKILL.md"]);
});

test("init rejects duplicate local recipe names before changing any target bytes", async () => {
	const dir = tmpRepo();
	const installed = await run(["init", dir, "--tools", "claude,codex"]);
	assert.equal(installed.code, 0, installed.stdout + installed.stderr);
	const local = path.join(dir, ".stdd", "playbooks", "local");
	fs.mkdirSync(local, { recursive: true });
	fs.writeFileSync(
		path.join(local, "zeta.md"),
		"---\nname: acme-duplicate\ndescription: Later duplicate\n---\n\nZeta recipe.\n",
	);
	fs.writeFileSync(
		path.join(local, "alpha.md"),
		"---\nname: acme-duplicate\ndescription: Earlier duplicate\n---\n\nAlpha recipe.\n",
	);
	const before = snapshotTreeBytes(dir);

	const res = await run(["init", dir, "--tools", "claude,codex"]);

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /duplicate local playbook name "acme-duplicate"/i);
	assert.match(res.stderr, /local\/alpha\.md[\s\S]*local\/zeta\.md/i);
	assert.deepEqual(
		snapshotTreeBytes(dir),
		before,
		"preflight rejection leaves the target byte-identical",
	);
});

test("init rejects an inactive local override of a mandatory routing skill", async () => {
	const dir = tmpRepo();
	const local = path.join(dir, ".stdd", "playbooks", "local");
	fs.mkdirSync(local, { recursive: true });
	fs.writeFileSync(
		path.join(local, "start-change.md"),
		"---\nname: stdd-start-change\ndescription: Inactive mandatory override\nrequires: crossCli\n---\n\nINACTIVE_OVERRIDE_MARKER\n",
	);

	const res = await run(["init", dir, "--tools", "codex", "--capabilities", "worktrees"]);
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /mandatory routing skill "stdd-start-change".*inactive/i);
	assert.ok(!fs.existsSync(path.join(dir, "AGENTS.md")), "preflight failure writes no agent router");
	assert.ok(
		!fs.existsSync(path.join(dir, ".agents", "skills")),
		"preflight failure writes no generated skills",
	);
});

test("an inactive optional local override shadows the kit skill and removes its stale generated copy", async () => {
	const dir = tmpRepo();
	const first = await run(["init", dir, "--tools", "codex", "--capabilities", "worktrees"]);
	assert.equal(first.code, 0, first.stdout + first.stderr);
	const local = path.join(dir, ".stdd", "playbooks", "local");
	fs.mkdirSync(local, { recursive: true });
	const name = "stdd-worktrees";
	assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", name, "SKILL.md")));
	fs.writeFileSync(
		path.join(local, "worktrees.md"),
		`---\nname: ${name}\ndescription: Inactive optional override\nrequires: crossCli\n---\n\nINACTIVE_OVERRIDE_MARKER\n`,
	);

	const res = await run(["init", dir, "--tools", "codex", "--capabilities", "worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.match(res.stdout, /overrides/);
	assert.ok(
		!fs.existsSync(path.join(dir, ".agents", "skills", name, "SKILL.md")),
		`${name} is absent because the optional local override is inactive`,
	);
	const check = await run(["check", dir]);
	assert.equal(check.code, 0, check.stdout + check.stderr);
});

test("a local recipe without frontmatter fails init with the file named", async () => {
	const dir = tmpRepo();
	const local = path.join(dir, ".stdd", "playbooks", "local");
	fs.mkdirSync(local, { recursive: true });
	fs.writeFileSync(path.join(local, "bad.md"), "no frontmatter here\n");
	const res = await run(["init", dir, "--tools", "claude"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /bad\.md/);
});

test("init --interview asks one question at a time and applies the answers", async () => {
	const dir = tmpRepo();
	// tools=claude, subagents=default(Y), crossCli=y, worktrees=n,
	// route=default(codex, since crossCli is on), ci=n, hooks=n,
	// session-hook=n, stop-hook=n
	const answers = "claude\n\ny\nn\n\nn\nn\nn\nn\n";
	const out = execFileSync(process.execPath, [CLI, "init", dir, "--interview"], {
		input: answers,
		encoding: "utf8",
	});
	assert.match(out, /\[Y\/n\]/, "the recommended answer leads");
	const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(config.capabilities, { subagents: true, crossCli: true, worktrees: false });
	assert.equal(config.review.via, "codex", "the route default follows the profile");
	assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "stdd-planning", "SKILL.md")));
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "AGENTS-snippet.md")), "codex not selected");
	assert.ok(!fs.existsSync(path.join(dir, ".github", "workflows", "stdd.yml")), "ci declined");
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "hooks", "pre-push")), "hooks declined");
	assert.ok(!fs.existsSync(path.join(dir, ".claude", "settings.json")), "session hook declined");

	const conflict = await run(["init", dir, "--interview", "--tools", "codex"]);
	assert.equal(conflict.code, 1);
	assert.match(conflict.stderr, /--interview/);
});

test("Codex-only interview recommends Claude as the cross-CLI reviewer", () => {
	const dir = tmpRepo();
	// tools=codex, subagents=n, crossCli=y, worktrees=default(Y),
	// route=default(claude), then decline CI and all hooks.
	execFileSync(process.execPath, [CLI, "init", dir, "--interview"], {
		input: "codex\nn\ny\n\n\nn\nn\nn\nn\n",
		encoding: "utf8",
	});
	const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.equal(config.review.via, "claude");
});

test("init interview accepts a no-dispatch profile with a dormant review route", () => {
	const dir = tmpRepo();
	execFileSync(process.execPath, [CLI, "init", dir, "--interview"], {
		// codex; no subagents; no cross-CLI; keep worktrees and the dormant
		// subagent route; decline CI and lifecycle hooks.
		input: "codex\nn\nn\n\n\nn\nn\nn\nn\n",
		encoding: "utf8",
	});
	const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(config.capabilities, {
		subagents: false,
		crossCli: false,
		worktrees: true,
	});
	assert.equal(config.review.via, "subagent");
});

test("init --interview rejects empty and duplicate tool selections before writing state", async () => {
	for (const tools of [",,,", "claude,claude"]) {
		const dir = tmpRepo();
		const res = spawnSync(process.execPath, [CLI, "init", dir, "--interview"], {
			input: `${tools}\n`,
			encoding: "utf8",
		});
		assert.equal(res.status, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /non-empty array|duplicate adapter IDs/);
		assert.ok(!fs.existsSync(path.join(dir, ".stdd")));
	}
});

test("init --session-hook merges a SessionStart hook without duplicating or clobbering", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const settingsPath = path.join(dir, ".claude", "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	const entry = settings.hooks.SessionStart[0];
	assert.equal(entry.matcher, "startup|resume|clear|compact");
	assert.match(entry.hooks[0].command, /stdd status --local/);
	assert.equal(settings.hooks.PostCompact, undefined, "compaction has one restoration source");

	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const again = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(again.hooks.SessionStart.length, 1, "idempotent");
	assert.equal(again.hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
	assert.equal(again.hooks.PostCompact, undefined);

	again.hooks.SessionStart[0].matcher = "startup|resume|clear";
	again.hooks.PostCompact = [
		{
			matcher: "legacy-compact",
			hooks: [
				{ type: "command", command: `${NPM_RUNNER} status --local || true` },
				{ type: "command", command: "npx --no stdd status || true" },
				{ type: "command", command: "echo user-post-compact" },
			],
		},
	];
	fs.writeFileSync(settingsPath, JSON.stringify(again, null, "\t"));
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const matcherMigrated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(
		matcherMigrated.hooks.SessionStart[0].matcher,
		"startup|resume|clear|compact",
		"the pre-compact matcher is migrated",
	);
	assert.deepEqual(matcherMigrated.hooks.PostCompact, [
		{
			matcher: "legacy-compact",
			hooks: [{ type: "command", command: "echo user-post-compact" }],
		},
	]);

	matcherMigrated.hooks.SessionStart[0].hooks[0].command = "npx --no stdd status || true";
	fs.writeFileSync(settingsPath, JSON.stringify(matcherMigrated, null, "\t"));
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const migrated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(migrated.hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
	assert.equal(migrated.hooks.SessionStart[0].hooks[0].command, `${NPM_RUNNER} status --local || true`);

	migrated.hooks.SessionStart[0].hooks[0].command =
		"npm exec --offline --package=@stdd/cli@0.5.0 -- stdd status || true";
	fs.writeFileSync(settingsPath, JSON.stringify(migrated, null, "\t"));
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const repinned = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(repinned.hooks.SessionStart[0].hooks[0].command, `${NPM_RUNNER} status --local || true`);

	fs.writeFileSync(
		settingsPath,
		JSON.stringify({ model: "opus", hooks: { PreToolUse: [] } }, null, "\t"),
	);
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(merged.model, "opus", "existing settings survive the merge");
	assert.ok(Array.isArray(merged.hooks.PreToolUse));
	assert.equal(merged.hooks.SessionStart.length, 1);

	fs.writeFileSync(settingsPath, "{broken");
	const res = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(res.code, 0);
	assert.equal(fs.readFileSync(settingsPath, "utf8"), "{broken", "unparseable settings untouched");
	assert.match(`${res.stdout}${res.stderr}`, /does not parse/i);

	fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: {} } }));
	const invalid = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(invalid.code, 0);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(settingsPath, "utf8")),
		{ hooks: { SessionStart: {} } },
		"structurally invalid settings stay untouched",
	);
	assert.match(`${invalid.stdout}${invalid.stderr}`, /invalid hooks\.SessionStart shape/i);

	const invalidPostCompact = JSON.stringify({
		model: "opus",
		hooks: { PostCompact: {}, PreToolUse: [] },
	});
	fs.writeFileSync(settingsPath, invalidPostCompact);
	const atomic = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(atomic.code, 0);
	assert.equal(
		fs.readFileSync(settingsPath, "utf8"),
		invalidPostCompact,
		"invalid PostCompact leaves SessionStart and the whole settings file untouched",
	);
	assert.match(`${atomic.stdout}${atomic.stderr}`, /invalid hooks\.PostCompact shape/i);

	const invalidGroup = JSON.stringify({
		model: "opus",
		hooks: { SessionStart: [null], PreToolUse: [] },
	});
	fs.writeFileSync(settingsPath, invalidGroup);
	const deepInvalid = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(deepInvalid.code, 0);
	assert.equal(fs.readFileSync(settingsPath, "utf8"), invalidGroup);
	assert.match(`${deepInvalid.stdout}${deepInvalid.stderr}`, /hooks\.SessionStart\[0\]/);
});

test("session hook migration never changes the matcher of a user sibling", async () => {
	const dir = tmpRepo();
	const settingsPath = path.join(dir, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(
		settingsPath,
		JSON.stringify(
			{
				hooks: {
					SessionStart: [
						{
							matcher: "startup",
							hooks: [
								{ type: "command", command: "npx --no stdd status || true" },
								{ type: "command", command: "echo user-session-hook" },
							],
						},
					],
				},
			},
			null,
			"\t",
		),
	);

	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	const userGroup = settings.hooks.SessionStart.find((group) =>
		group.hooks.some((hook) => hook.command === "echo user-session-hook"),
	);
	const stddGroup = settings.hooks.SessionStart.find((group) =>
		group.hooks.some((hook) => hook.command === `${NPM_RUNNER} status --local || true`),
	);
	assert.equal(userGroup.matcher, "startup", "the user's matcher is preserved");
	assert.equal(userGroup.hooks.length, 1, "only the user's hook remains in its group");
	assert.equal(stddGroup.matcher, "startup|resume|clear|compact");
	assert.equal(stddGroup.hooks.length, 1, "STDD receives a dedicated matcher group");
});

test("a user command mentioning stdd status never suppresses the managed hook", async () => {
	const dir = tmpRepo();
	const settingsPath = path.join(dir, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						matcher: "startup",
						hooks: [{ type: "command", command: "echo stdd status telemetry" }],
					},
				],
			},
		}),
	);
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	const commands = settings.hooks.SessionStart.flatMap((group) =>
		group.hooks.map((hook) => hook.command),
	);
	assert.ok(commands.includes("echo stdd status telemetry"));
	assert.ok(commands.includes(`${NPM_RUNNER} status --local || true`));
});

test("combined lifecycle hook install validates every event before writing any", async () => {
	const dir = tmpRepo();
	const settingsPath = path.join(dir, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	const invalidStop = JSON.stringify({ model: "opus", hooks: { Stop: {} } }, null, "\t");
	fs.writeFileSync(settingsPath, invalidStop);

	const res = await run(["init", dir, "--tools", "claude", "--session-hook", "--stop-hook"]);
	assert.equal(res.code, 0);
	assert.equal(
		fs.readFileSync(settingsPath, "utf8"),
		invalidStop,
		"invalid Stop prevents SessionStart and PostCompact from being written",
	);
	assert.match(`${res.stdout}${res.stderr}`, /invalid hooks\.Stop shape/i);
});

test("lifecycle hook install rejects malformed existing events that are not being installed", async () => {
	for (const { tool, flags, settingsRelative, invalidEvent } of [
		{
			tool: "claude",
			flags: ["--session-hook"],
			settingsRelative: path.join(".claude", "settings.json"),
			invalidEvent: "Stop",
		},
		{
			tool: "codex",
			flags: ["--stop-hook"],
			settingsRelative: path.join(".codex", "hooks.json"),
			invalidEvent: "SessionStart",
		},
	]) {
		const dir = tmpRepo();
		const settingsPath = path.join(dir, settingsRelative);
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		const malformed = JSON.stringify({ model: "custom", hooks: { [invalidEvent]: {} } }, null, "\t");
		fs.writeFileSync(settingsPath, malformed);

		const res = await run(["init", dir, "--tools", tool, ...flags]);
		assert.equal(res.code, 0);
		assert.equal(
			fs.readFileSync(settingsPath, "utf8"),
			malformed,
			`${tool} settings remain byte-identical`,
		);
		assert.match(`${res.stdout}${res.stderr}`, new RegExp(`invalid hooks\\.${invalidEvent} shape`, "i"));
	}

	const dir = tmpRepo();
	const codexSettings = path.join(dir, ".codex", "hooks.json");
	fs.mkdirSync(path.dirname(codexSettings), { recursive: true });
	const malformedCodex = JSON.stringify({ hooks: { Stop: {} } }, null, "\t");
	fs.writeFileSync(codexSettings, malformedCodex);
	const atomic = await run(["init", dir, "--tools", "claude,codex", "--session-hook"]);
	assert.equal(atomic.code, 0);
	assert.ok(
		!fs.existsSync(path.join(dir, ".claude", "settings.json")),
		"a malformed Codex sibling event prevents an earlier Claude settings write",
	);
	assert.equal(fs.readFileSync(codexSettings, "utf8"), malformedCodex);
});

test("Codex receives native lifecycle hooks for local status and stop gating", async () => {
	const dir = tmpRepo();
	const res = await run(["init", dir, "--tools", "codex", "--session-hook", "--stop-hook"]);
	assert.equal(res.code, 0, res.stderr);
	const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
	assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
	assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, `${NPM_RUNNER} status --local || true`);
	assert.equal(hooks.hooks.Stop[0].hooks[0].command, codexStopCommand(NPM_RUNNER));
});

// --- the durable plan: check bans committing stdd's own bookkeeping ---

test("check fails when the plan or the ledger is a tracked file", async () => {
	const { dir, git } = await tmpGitDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] step\n");
	fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "");
	fs.writeFileSync(path.join(dir, ".stdd", "worker.json"), "{}\n");
	fs.mkdirSync(path.join(dir, ".stdd", "worker-deletions", "worker-test"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "worker-deletions", "worker-test", "bytes"), "private\n");
	fs.writeFileSync(path.join(dir, "readme.md"), "hi\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	const res = await run(["check", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /\.stdd\/plan\.md: committed stdd working artifact/);
	assert.match(res.stderr, /\.stdd\/ledger\.jsonl: committed stdd working artifact/);
	assert.match(res.stderr, /\.stdd\/worker\.json: committed stdd working artifact/);
	assert.match(
		res.stderr,
		/\.stdd\/worker-deletions\/worker-test\/bytes: committed stdd working artifact/,
	);
});

test("check still rejects a tracked exact reset transaction temp", async () => {
	const { dir, git } = await tmpGitDir();
	const relative = `.stdd/.ledger-reset-${"a".repeat(32)}.tmp`;
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, relative), "private transaction\n");
	fs.writeFileSync(path.join(dir, "readme.md"), "hi\n");
	await git("add", "-f", ".");
	await git("commit", "-qm", "tracked private temp");
	const result = await run(["check", dir]);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /\.ledger-reset-[a-f0-9]{32}\.tmp: committed stdd working artifact/i);
});

test("check ignores an untracked plan", async () => {
	const { dir, git } = await tmpGitDir();
	fs.writeFileSync(path.join(dir, "readme.md"), "hi\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] step\n");
	const res = await run(["check", dir]);
	assert.equal(res.code, 0);
});

// --- delegation choreography lands in the generated playbooks ---

test("the delegate-slice skill carries the worker protocol and review verdicts", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/);
	assert.match(skill, /before starting|before the first edit/i);
	assert.match(skill, /missing.*extra.*misunderstood/is);
	assert.match(skill, /never your session history/);
	assert.match(skill, /model explicitly/i);
});

test("the pr-green skill centers on stdd ci --watch with a recognition table", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-pr-green", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /stdd ci --watch/);
	assert.match(skill, /Recognition table/);
	assert.match(skill, /current head/);
});

test("the planning skill closes with the execution choice and the closing review", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-planning", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /Delegated.*delegate-slice/s);
	assert.match(skill, /Inline/);
	assert.match(skill, /one batched question/);
	assert.ok(
		!/the default when steps are independent/.test(skill),
		"delegation is an optimization, never mandated",
	);
	assert.match(skill, /## The closing review/);
	assert.match(skill, /never the implementing\s+session's history/);
	assert.match(skill, /fresh\s+read-only subagent/); // cap:subagents default on
});

test("native planning skills route cross-CLI review to the other host", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex", "--capabilities", "crossCli"]);
	const claude = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-planning", "SKILL.md"),
		"utf8",
	);
	const codex = fs.readFileSync(
		path.join(dir, ".agents", "skills", "stdd-planning", "SKILL.md"),
		"utf8",
	);
	assert.match(claude, /stdd review --via codex/);
	assert.doesNotMatch(claude, /stdd review --via claude|STDD_CROSS_CLI_REVIEW_VIA/);
	assert.match(codex, /stdd review --via claude/);
	assert.doesNotMatch(codex, /stdd review --via codex|STDD_CROSS_CLI_REVIEW_VIA/);
});

test("planning review guidance follows the complete capability matrix for each host", async () => {
	for (const profile of [
		{ capabilities: "worktrees", dispatch: false, subagent: false, crossCli: false },
		{ capabilities: "subagents", dispatch: true, subagent: true, crossCli: false },
		{ capabilities: "crossCli", dispatch: true, subagent: false, crossCli: true },
		{ capabilities: "subagents,crossCli", dispatch: true, subagent: true, crossCli: true },
	]) {
		const dir = tmpRepo();
		await run(["init", dir, "--tools", "claude,codex", "--capabilities", profile.capabilities]);
		for (const { root, peer, sameHost } of [
			{ root: ".claude", peer: "codex", sameHost: "claude" },
			{ root: ".agents", peer: "claude", sameHost: "codex" },
		]) {
			const skill = fs.readFileSync(path.join(dir, root, "skills", "stdd-planning", "SKILL.md"), "utf8");
			assert.equal(/\[review:\]/.test(skill), profile.dispatch, `${root} ${profile.capabilities}`);
			assert.equal(
				skill.includes("stdd review --via subagent"),
				profile.subagent,
				`${root} ${profile.capabilities}`,
			);
			assert.equal(
				skill.includes(`stdd review --via ${peer}`),
				profile.crossCli,
				`${root} ${profile.capabilities}`,
			);
			assert.doesNotMatch(skill, new RegExp(`stdd review --via ${sameHost}`));
			assert.doesNotMatch(skill, /Run it with `stdd review`/);
			assert.doesNotMatch(
				skill,
				/fresh-context pass|re-read the full diff|degrades to|STDD_CROSS_CLI_REVIEW_VIA/i,
			);
			if (!profile.dispatch) {
				assert.doesNotMatch(skill, /stdd review/);
				assert.doesNotMatch(
					skill,
					/independent review|## The closing review/i,
					`${root} ${profile.capabilities} must not require an unavailable review`,
				);
			}
		}
	}
});

test("with no dispatch route, generated skills never mention stdd review", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex", "--capabilities", "worktrees"]);
	for (const root of [".claude", ".agents"]) {
		for (const name of ["stdd-planning", "stdd-delegate-slice"]) {
			const skill = fs.readFileSync(path.join(dir, root, "skills", name, "SKILL.md"), "utf8");
			assert.ok(!/stdd review/.test(skill), `${root}/${name} refers to an unusable route`);
			assert.doesNotMatch(skill, /STDD_CROSS_CLI_REVIEW_VIA/);
			if (name === "stdd-planning") {
				assert.doesNotMatch(skill, /\[review:\]|fresh-context pass|re-read the full diff|degrades to/i);
				assert.doesNotMatch(skill, /independent review|## The closing review/i);
			}
		}
	}
});

test("a crossCli-only profile still routes the worker review through stdd review", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude", "--capabilities", "crossCli"]);
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /stdd review/);
});

test("skill descriptions carry the playbook's when line", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude"]);
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	const description = skill.match(/^description: (.*)$/m)?.[1] ?? "";
	assert.match(description, /Use when: Before implementing a multi-step change/);
});

test("start-change routes read-only work before creating task state", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	const skill = fs.readFileSync(
		path.join(dir, ".agents", "skills", "stdd-start-change", "SKILL.md"),
		"utf8",
	);
	assert.ok(
		skill.indexOf("read-only question") < skill.indexOf('stdd task start "<short change name>"'),
	);
	assert.match(skill, /do not start a\s+task or write the ledger/);
});

test("init creates AGENTS.md with the managed STDD section when absent", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "codex"]);
	const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	assert.match(agents, /<!-- stdd:begin/);
	assert.match(agents, /^## STDD$/m);
	assert.match(agents, /<!-- stdd:end -->/);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.equal(manifest.files["AGENTS.md"], undefined, "AGENTS.md is user-owned");
});

test("init replaces only the marked STDD section of an existing AGENTS.md", async () => {
	const dir = tmpRepo();
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "# House rules\n\nBe kind.\n");
	await run(["init", dir, "--tools", "codex"]);
	const first = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	assert.match(first, /# House rules/);
	assert.match(first, /Be kind\./);
	assert.match(first, /<!-- stdd:begin/);

	await run(["init", dir, "--tools", "codex"]);
	assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), first, "re-init is a no-op");

	fs.writeFileSync(path.join(dir, "AGENTS.md"), first.replace("Be kind.", "Be kind. Ship small."));
	await run(["init", dir, "--tools", "codex"]);
	const third = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	assert.match(third, /Ship small\./, "user content outside the markers survives");
	assert.equal(third.match(/<!-- stdd:begin/g).length, 1, "replaced in place, not appended");

	// a CRLF checkout still replaces the section instead of appending a twin
	fs.writeFileSync(path.join(dir, "AGENTS.md"), third.replaceAll("\n", "\r\n"));
	await run(["init", dir, "--tools", "codex"]);
	const crlf = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	assert.equal(crlf.match(/<!-- stdd:begin/g).length, 1, "CRLF section is replaced, not duplicated");
});
