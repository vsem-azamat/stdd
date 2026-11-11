import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { measureAgentContext } from "../scripts/measure-agent-context.mjs";
import {
	claudeMemoryImportsAgentsMd,
	MANDATORY_ROUTING_SKILLS,
	renderAgentInstructions,
} from "../sdk/adapters.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PKG_ROOT, "cli", "stdd.mjs");
const AGENTS_MD = ["--claude-instructions", "agents-md"];

async function run(args) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args]);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

function repo() {
	const dir = makeTempDir("stdd-claude-instr-");
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "rules.md"), "# Rules\n");
	return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const manifestOf = (dir) => JSON.parse(read(dir, ".stdd/manifest.json"));
const ok = (result) => assert.equal(result.code, 0, result.stdout + result.stderr);
const hasBoth = (text) =>
	MANDATORY_ROUTING_SKILLS.every((n) => text.includes(`\`$${n}\``) && text.includes(`\`/${n}\``));

test("fresh claude+codex in agents-md mode: one AGENTS.md, no CLAUDE.md, doctor passes", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	assert.ok(!exists(dir, "CLAUDE.md"), "init never creates CLAUDE.md");
	const agents = read(dir, "AGENTS.md");
	assert.ok(hasBoth(agents), "section names both forms");
	assert.equal((agents.match(/<!-- stdd:begin/g) ?? []).length, 1);
	assert.equal(
		read(dir, ".stdd/AGENTS-snippet.md"),
		agents.replace(/^<!-- stdd:begin[^\n]*\n/, "").replace(/<!-- stdd:end -->\n$/, ""),
	);
	assert.ok(!exists(dir, ".stdd/CLAUDE-snippet.md"));
	const manifest = manifestOf(dir);
	assert.equal(manifest.targets.claudeInstructions, "agents-md");
	assert.ok(!(".stdd/CLAUDE-snippet.md" in manifest.files));
	assert.ok(exists(dir, ".claude/skills/stdd-start-change/SKILL.md"), "skills are unaffected");
	const doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
	assert.doesNotMatch(doctor.stdout, /CLAUDE\.md is missing/);
	const check = await run(["check", dir]);
	assert.equal(check.code, 0, check.stdout + check.stderr);
});

test("the shared section stays short", () => {
	const common = { stamp: "s", npmRunner: "npx stdd", crossCli: false };
	const one = renderAgentInstructions({ adapter: "codex", ...common });
	const both = renderAgentInstructions({ adapter: "codex", alsoFor: ["claude"], ...common });
	assert.ok(hasBoth(both));
	assert.ok(both.length < one.length * 1.35, `${both.length} vs ${one.length}`);
});

test("claude-only agents-md writes AGENTS.md in Claude's form", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude", ...AGENTS_MD]));
	assert.ok(!exists(dir, "CLAUDE.md"));
	const agents = read(dir, "AGENTS.md");
	for (const n of MANDATORY_ROUTING_SKILLS) assert.ok(agents.includes(`\`/${n}\``));
	assert.ok(!agents.includes("`$stdd-"));
	assert.ok(exists(dir, ".stdd/AGENTS-snippet.md"));
	assert.ok(!exists(dir, ".stdd/CLAUDE-snippet.md"));
	const doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
});

test("re-init without the flag keeps the mode; a bad value and claude-less tools are errors", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	ok(await run(["init", dir, "--tools", "claude,codex"]));
	assert.ok(!exists(dir, "CLAUDE.md"));
	assert.equal(manifestOf(dir).targets.claudeInstructions, "agents-md");
	ok(await run(["configure", dir, "--review-via", "subagent"]).then((r) => r));
	assert.ok(!exists(dir, "CLAUDE.md"));
	assert.equal(manifestOf(dir).targets.claudeInstructions, "agents-md");

	const other = repo();
	const bad = await run(["init", other, "--tools", "claude", "--claude-instructions", "nope"]);
	assert.notEqual(bad.code, 0);
	assert.match(bad.stderr, /claude-instructions/);
	const noClaude = await run(["init", other, "--tools", "codex", ...AGENTS_MD]);
	assert.notEqual(noClaude.code, 0);
	assert.match(noClaude.stderr, /claude/);
	assert.ok(!exists(other, ".stdd"), "nothing written");
	const wrongCommand = await run(["check", other, ...AGENTS_MD]);
	assert.notEqual(wrongCommand.code, 0);
});

test("a manifest without the field means claude-md", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex"]));
	assert.equal(manifestOf(dir).targets.claudeInstructions, undefined);
	assert.ok(exists(dir, "CLAUDE.md"));
	assert.ok(!read(dir, "AGENTS.md").includes("`/stdd-"));
});

test("migration: CLAUDE.md that is only the managed section is retired", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex"]));
	assert.ok(exists(dir, "CLAUDE.md"));
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	assert.ok(!exists(dir, "CLAUDE.md"));
	assert.ok(!exists(dir, ".stdd/CLAUDE-snippet.md"));
	assert.ok(hasBoth(read(dir, "AGENTS.md")));
	const doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
});

test("migration: CLAUDE.md with user content and the import is kept without the section", async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Mine\n\n@AGENTS.md\n\nUse tabs.\n");
	ok(await run(["init", dir, "--tools", "claude,codex"]));
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	const claude = read(dir, "CLAUDE.md");
	assert.ok(!claude.includes("stdd:begin"));
	assert.match(claude, /^@AGENTS\.md$/m);
	assert.match(claude, /Use tabs\./);
	const doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
});

test("migration: CLAUDE.md with user content and no import fails before any write", async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Mine\n\nUse tabs.\n");
	ok(await run(["init", dir, "--tools", "claude,codex"]));
	const snapshot = (root) => {
		const out = {};
		const walk = (d) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else out[path.relative(root, p)] = fs.readFileSync(p, "base64");
			}
		};
		walk(root);
		return out;
	};
	const before = snapshot(dir);
	const result = await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /@AGENTS\.md/);
	assert.match(result.stderr, /Claude Code reads only/);
	assert.deepEqual(snapshot(dir), before, "nothing changed");
});

test("doctor in agents-md mode: failures", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	// CLAUDE.md without the import
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Mine\n");
	let doctor = await run(["doctor", dir]);
	assert.notEqual(doctor.code, 0);
	assert.match(doctor.stdout, /✗ CLAUDE\.md does not import @AGENTS\.md/);
	// CLAUDE.md with import but a stale managed section
	const section = read(dir, "AGENTS.md");
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), `@AGENTS.md\n\n${section}`);
	doctor = await run(["doctor", dir]);
	assert.notEqual(doctor.code, 0);
	assert.match(doctor.stdout, /✗ CLAUDE\.md still carries a managed STDD section/);
	// with the import and no section it passes
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n");
	doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
	// AGENTS.md carrying only Codex's form fails
	fs.rmSync(path.join(dir, "CLAUDE.md"));
	fs.writeFileSync(path.join(dir, "AGENTS.md"), section.replaceAll("`/stdd-", "`stdd-"));
	doctor = await run(["doctor", dir]);
	assert.notEqual(doctor.code, 0);
	assert.match(doctor.stdout, /AGENTS\.md has no managed STDD routing contract/);
});

test("switching back to claude-md restores the default layout", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	ok(await run(["init", dir, "--tools", "claude,codex", "--claude-instructions", "claude-md"]));
	assert.match(read(dir, "CLAUDE.md"), /`\/stdd-start-change`/);
	const agents = read(dir, "AGENTS.md");
	assert.match(agents, /`\$stdd-start-change`/);
	assert.ok(!agents.includes("`/stdd-"));
	assert.equal(manifestOf(dir).targets.claudeInstructions, undefined);
	assert.ok(exists(dir, ".stdd/CLAUDE-snippet.md"));
	const doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);

	const solo = repo();
	ok(await run(["init", solo, "--tools", "claude", ...AGENTS_MD]));
	ok(await run(["init", solo, "--tools", "claude", "--claude-instructions", "claude-md"]));
	assert.ok(!exists(solo, "AGENTS.md"), "section-only AGENTS.md is retired");
	assert.ok(!exists(solo, ".stdd/AGENTS-snippet.md"));
	assert.match(read(solo, "CLAUDE.md"), /`\/stdd-start-change`/);
});

test("pi is unaffected in agents-md mode", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex,pi", ...AGENTS_MD]));
	assert.match(read(dir, ".pi/APPEND_SYSTEM.md"), /`\/skill:stdd-start-change`/);
	const doctor = await run(["doctor", dir]);
	assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
});

function snapshotTree(root) {
	const out = {};
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out[path.relative(root, p)] = fs.readFileSync(p, "base64");
		}
	};
	walk(root);
	return out;
}

test("import detection follows Claude Code's parsing rules", () => {
	const yes = [
		"@AGENTS.md\n",
		"See @AGENTS.md first.\n",
		"See @AGENTS.md.\n",
		"@./AGENTS.md\n",
		"# Mine\r\n\r\n@AGENTS.md\r\n",
		"(@AGENTS.md)\n",
		"```js\nx\n```\n@AGENTS.md\n",
	];
	const no = [
		"```\n@AGENTS.md\n```\n",
		"~~~\n@AGENTS.md\n~~~\n",
		"<!-- @AGENTS.md -->\n",
		"<!--\n@AGENTS.md\n-->\n",
		"Use `@AGENTS.md` here\n",
		"@AGENTS.md.bak\n",
		"foo@AGENTS.md\n",
		"@AGENTS.mdx\n",
		"@docs/AGENTS.md\n",
		"nothing\n",
	];
	for (const text of yes) assert.equal(claudeMemoryImportsAgentsMd(text), true, JSON.stringify(text));
	for (const text of no) assert.equal(claudeMemoryImportsAgentsMd(text), false, JSON.stringify(text));
});

for (const [name, content, imports] of [
	["fenced block", "# Mine\n\n```\n@AGENTS.md\n```\n", false],
	["HTML comment", "# Mine\n\n<!-- @AGENTS.md -->\n", false],
	["inline sentence", "# Mine\n\nSee @AGENTS.md first.\n", true],
	["dot-slash form", "# Mine\n\n@./AGENTS.md\n", true],
	["CRLF", "# Mine\r\n\r\n@AGENTS.md\r\n", true],
]) {
	test(`init in agents-md mode: an import in a ${name} ${imports ? "keeps" : "does not keep"} CLAUDE.md`, async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), content);
		const result = await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]);
		assert.equal(result.code === 0, imports, result.stdout + result.stderr);
		if (!imports) assert.ok(!exists(dir, ".stdd"), "nothing written");
	});
}

for (const rel of [".claude/CLAUDE.md", "CLAUDE.local.md"]) {
	test(`${rel} without the import blocks agents-md in init (no writes, no hook lines) and in doctor`, async () => {
		const dir = repo();
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), "mine\n");
		const before = snapshotTree(dir);
		const refused = await run([
			"init",
			dir,
			"--tools",
			"claude,codex",
			"--session-hook",
			"--stop-hook",
			...AGENTS_MD,
		]);
		assert.notEqual(refused.code, 0);
		assert.match(refused.stderr, new RegExp(rel.replace(".", "\\.")));
		assert.match(refused.stderr, /@AGENTS\.md/);
		assert.doesNotMatch(refused.stdout, /Wired/);
		assert.deepEqual(snapshotTree(dir), before, "nothing changed");

		fs.writeFileSync(path.join(dir, rel), "@AGENTS.md\n");
		ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
		let doctor = await run(["doctor", dir]);
		assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
		fs.writeFileSync(path.join(dir, rel), "mine\n");
		doctor = await run(["doctor", dir]);
		assert.notEqual(doctor.code, 0);
		assert.match(doctor.stdout, new RegExp(`✗ ${rel.replace(".", "\\.")} does not import @AGENTS\\.md`));
	});
}

test("doctor rejects a fenced import in CLAUDE.md", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "```\n@AGENTS.md\n```\n");
	const doctor = await run(["doctor", dir]);
	assert.notEqual(doctor.code, 0);
	assert.match(doctor.stdout, /✗ CLAUDE\.md does not import @AGENTS\.md/);
});

test("a CLAUDE.md symlinked to AGENTS.md is refused", async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "# mine\n");
	fs.symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
	const result = await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]);
	assert.notEqual(result.code, 0);
	assert.equal(read(dir, "AGENTS.md"), "# mine\n");
});

test("a file with two managed sections is cleaned in one run", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex"]));
	const section = read(dir, "CLAUDE.md");
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), `@AGENTS.md\n\n${section}\n${section}`);
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	const claude = read(dir, "CLAUDE.md");
	assert.ok(!claude.includes("stdd:begin"));
	assert.match(claude, /@AGENTS\.md/);
});

test("--interview cannot be combined with --claude-instructions", async () => {
	const dir = repo();
	const result = await run(["init", dir, "--interview", ...AGENTS_MD]);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /--interview replaces the other init flags/);
	assert.ok(!exists(dir, ".stdd"));
});

test("renderAgentInstructions rejects unsupported alsoFor combinations", () => {
	const common = { stamp: "s", npmRunner: "npx stdd", crossCli: false };
	for (const bad of [
		{ adapter: "claude", alsoFor: ["codex"] },
		{ adapter: "pi", alsoFor: ["claude"] },
		{ adapter: "codex", alsoFor: ["pi"] },
		{ adapter: "codex", alsoFor: ["nope"] },
		{ adapter: "codex", alsoFor: "claude" },
		{ adapter: "codex", alsoFor: ["claude", "claude"] },
	]) {
		assert.throws(() => renderAgentInstructions({ ...bad, ...common }), TypeError, JSON.stringify(bad));
	}
});

test("measure-agent-context reads an agents-md install", async () => {
	const dir = repo();
	ok(await run(["init", dir, "--tools", "claude,codex", ...AGENTS_MD]));
	const report = measureAgentContext(dir);
	assert.ok(report);
	const solo = repo();
	ok(await run(["init", solo, "--tools", "claude", ...AGENTS_MD]));
	assert.ok(measureAgentContext(solo));
});
