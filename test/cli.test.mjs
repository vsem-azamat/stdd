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
import { createReviewPrivateArtifacts, removeReviewBrief } from "../cli/review-fs.mjs";

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

test("init seeds a user-owned policy document and never overwrites it", async () => {
	const dir = tmpRepo();
	assert.equal((await run(["init", dir, "--tools", "codex"])).code, 0);

	const policyPath = path.join(dir, ".stdd", "policy.md");
	const seeded = fs.readFileSync(policyPath, "utf8");
	assert.match(seeded, /^## Permissions$/m);
	assert.match(seeded, /^## Notes$/m);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.ok(!(".stdd/policy.md" in manifest.files), "user-owned — not manifest-tracked");

	assert.equal(
		(await run(["policy", "allow", "merge", "--when", "review approved"], { cwd: dir })).code,
		0,
	);
	const edited = fs.readFileSync(policyPath, "utf8");
	assert.equal((await run(["init", dir, "--tools", "codex"])).code, 0);
	assert.equal(fs.readFileSync(policyPath, "utf8"), edited, "a recorded decision survives re-init");
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

test("read-only adoption commands do not require the native helper", async () => {
	const dir = tmpRepo();
	await run(["init", dir, "--tools", "claude,codex"]);
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "contract.md"), "Portable contract.\n");
	const env = {
		...process.env,
		STDD_NATIVE_FS_PACKAGE_ROOT: path.join(dir, "missing-native-package"),
	};
	for (const command of [
		["check", dir],
		["doctor", dir],
	]) {
		const result = await run(command, { env });
		assert.equal(result.code, 0, `${command[0]}: ${result.stdout}${result.stderr}`);
		assert.doesNotMatch(result.stdout + result.stderr, /native filesystem|prebuild|artifact manifest/i);
	}
});

test("doctor inventories only exact ledger-proven retained review quarantines", async () => {
	const dir = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), "{}\n");
	fs.writeFileSync(path.join(dir, ".stdd", "method.md"), "# Method\n");
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-doctor-review-"));
	const previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = tempRoot;
	try {
		const id = "rev-00000000000000000000000000000071";
		const created = await createReviewPrivateArtifacts(id, "DOCTOR_REVIEW_PRIVATE_BYTES");
		const request = {
			ts: new Date().toISOString(),
			branch: "feature",
			event: "review-request",
			id,
			via: "subagent",
			brief: `sha256:${"a".repeat(64)}`,
			briefPath: created.briefPath,
			privateState: created.privateState,
		};
		const terminal = {
			ts: new Date().toISOString(),
			branch: "feature",
			event: "review-cancelled",
			request: id,
			via: "subagent",
			reason: "test cancellation",
		};
		fs.writeFileSync(
			path.join(dir, ".stdd", "ledger.jsonl"),
			`${JSON.stringify(request)}\n${JSON.stringify(terminal)}\n`,
			{ mode: 0o600 },
		);
		assert.equal(await removeReviewBrief(request), true);

		const forged = path.join(tempRoot, `stdd-review-quarantine-${"f".repeat(32)}`);
		fs.mkdirSync(path.join(forged, "private"), { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(forged, "inventory.json"), '{"kind":"private-review"}\n', {
			mode: 0o600,
		});

		const result = await run(["doctor", dir], {
			cwd: dir,
			env: { ...process.env, TMPDIR: path.join(tempRoot, "different-current-root") },
		});
		assert.match(result.stdout, /1 retained review quarantine \(ledger and inventory proven/);
		assert.match(result.stdout, new RegExp(`review request ${id}`));
		assert.doesNotMatch(result.stdout, new RegExp(path.basename(forged)));
		assert.equal(fs.existsSync(forged), true, "an unrelated forged temp remains visible and untouched");
	} finally {
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
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

// --- generic entry parsing preserves byte-level compatibility ---

test("generic entry parsing preserves exact usage and first-error behavior", async () => {
	const dir = tmpRepo();
	const usage =
		"Usage: stdd <init|configure|check|check-pr|evidence|doctor|task|status|ci|docs|red|verify|note|defer|policy|slice|worker|scope|review|stop-hook> " +
		"[dir|pr-body-file|pr] [--tools claude,codex,pi] [--ci github,gitlab,generic] [--hooks] " +
		"[--session-hook] [--interview] [--base <ref>] " +
		"[--pr <n|.>] [--watch] [--readiness] [--json] [--gate] [--local] [--reason <why>] " +
		"[--capabilities <list>] [--via subagent|codex|claude] [--review-via <route>] " +
		"[--max-rounds <n>] [--stop-hook] [--cleanup] [--force] [--result <file|->] " +
		"[--frozen <globs>] [--allowed <globs>] [--when <condition>] [--interval <s>] [--timeout <s>] [-- <cmd>]\n";

	assert.deepEqual(await run([], { cwd: dir }), {
		code: 0,
		stdout: usage,
		stderr: "",
	});
	assert.deepEqual(await run(["check", "--tools", "claude", "--frobnicate"], { cwd: dir }), {
		code: 1,
		stdout: "",
		stderr: 'stdd: --tools is only valid for "stdd init"\n',
	});
	assert.deepEqual(await run(["check", "--frobnicate", "--tools", "claude"], { cwd: dir }), {
		code: 1,
		stdout: "",
		stderr: "stdd: unknown flag: --frobnicate\n",
	});
	assert.deepEqual(await run(["ci", "--timeout", "--watch"], { cwd: dir }), {
		code: 1,
		stdout: "",
		stderr: "stdd: --timeout requires seconds, e.g. --timeout 1800\n",
	});
	assert.deepEqual(await run(["--version", "--frobnicate"], { cwd: dir }), {
		code: 1,
		stdout: "",
		stderr: "stdd: unknown flag: --frobnicate\n",
	});
});

test("attached and separated generic values preserve exact diagnostics", async () => {
	const dir = tmpRepo();
	const expected = {
		code: 1,
		stdout: "",
		stderr: "stdd: unknown tool(s): nope (known: claude, codex, pi)\n",
	};
	assert.deepEqual(await run(["init", "--tools", "nope"], { cwd: dir }), expected);
	assert.deepEqual(await run(["init", "--tools=nope"], { cwd: dir }), expected);
	for (const [owner, flag] of [
		["init", "hooks"],
		["init", "session-hook"],
		["init", "stop-hook"],
		["init", "interview"],
		["doctor", "readiness"],
		["ci", "watch"],
	]) {
		assert.deepEqual(await run([owner, `--${flag}=yes`], { cwd: dir }), {
			code: 1,
			stdout: "",
			stderr: `stdd: unknown flag: --${flag}=yes\n`,
		});
	}
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

// --- stdd policy: notes and conditional permissions from the CLI ---

test("stdd policy records a note and a conditional permission", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	const note = await run(["policy", "add", "backend", "slices", "go", "to", "codex"], { cwd: dir });
	assert.equal(note.code, 0);

	const allow = await run(["policy", "allow", "merge", "--when", "review approved and CI green"], {
		cwd: dir,
	});
	assert.equal(allow.code, 0);

	const document = fs.readFileSync(path.join(dir, ".stdd", "policy.md"), "utf8");
	assert.match(document, /## Notes\n\n- backend slices go to codex\n/);
	assert.match(document, /## Permissions\n\n- merge — when: review approved and CI green\n/);
});

test("stdd policy show is the enforcing reader, not the raw file", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "policy.md"),
		"## Permissions\n\n" +
			"- merge — when: review approved\n" +
			"- skip-review — when: I am in a hurry\n\n" +
			"```\n## Permissions\n\n- deploy — when: inside an example\n```\n\n" +
			"## Notes\n\n- backend slices go to codex\n",
	);

	const res = await run(["policy", "show"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /merge — when: review approved/);
	assert.match(res.stdout, /backend slices go to codex/);
	// The grant naming an unknown action is shown as ignored, never as granted.
	assert.match(res.stdout, /ignored[\s\S]*skip-review/i);
	// The fenced example grants nothing and is not reported at all.
	assert.ok(!res.stdout.includes("inside an example"), "a fenced example is not a permission");
});

test("stdd policy show reports an absent document without failing", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	const res = await run(["policy", "show"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /no project policy recorded/i);
});

test("stdd policy refuses an unknown subcommand, an unknown action, and a bare grant", async () => {
	const dir = tmpRepo();
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	const subcommand = await run(["policy", "grant"], { cwd: dir });
	assert.equal(subcommand.code, 1);
	assert.match(subcommand.stderr, /unknown policy subcommand "grant" — use show, add, or allow/);

	const action = await run(["policy", "allow", "skip-review", "--when", "I am in a hurry"], {
		cwd: dir,
	});
	assert.equal(action.code, 1);
	assert.match(action.stderr, /unknown policy action "skip-review"/);

	const bare = await run(["policy", "allow", "merge"], { cwd: dir });
	assert.equal(bare.code, 1);
	assert.match(bare.stderr, /--when "<verifiable condition>"/);

	assert.equal(fs.existsSync(path.join(dir, ".stdd", "policy.md")), false);
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

// A small change routes start-change → implement → finish-change and never
// opens the planning skill, so finish-change has to carry the command itself.
test("the finish-change skill names the route-specific closing-review command", async () => {
	const crossCli = tmpRepo();
	await run(["init", crossCli, "--tools", "claude,codex", "--capabilities", "crossCli"]);
	const claude = fs.readFileSync(
		path.join(crossCli, ".claude", "skills", "stdd-finish-change", "SKILL.md"),
		"utf8",
	);
	const codex = fs.readFileSync(
		path.join(crossCli, ".agents", "skills", "stdd-finish-change", "SKILL.md"),
		"utf8",
	);
	assert.match(claude, /stdd review --via codex/);
	assert.match(codex, /stdd review --via claude/);

	const subagents = tmpRepo();
	await run(["init", subagents, "--tools", "claude", "--capabilities", "subagents"]);
	const withSubagents = fs.readFileSync(
		path.join(subagents, ".claude", "skills", "stdd-finish-change", "SKILL.md"),
		"utf8",
	);
	assert.match(withSubagents, /stdd review --via subagent/);
	assert.match(withSubagents, /stdd review --result/);

	const none = tmpRepo();
	await run(["init", none, "--tools", "claude", "--capabilities", "worktrees"]);
	const withoutDispatch = fs.readFileSync(
		path.join(none, ".claude", "skills", "stdd-finish-change", "SKILL.md"),
		"utf8",
	);
	assert.doesNotMatch(withoutDispatch, /stdd review/);
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
