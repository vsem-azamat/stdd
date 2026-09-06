// The reading on the start → implement → finish path is part of the kit's
// contract: the always-on block and the method stay small, phase detail lives
// in the playbooks and reference documents the phase routes to, every path a
// generated file names resolves in a clean consumer install, and no route asks
// a session to read everything. These tests pin that partition and the rules
// the core must keep carrying, not a word count alone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BASELINE_COMMIT,
	classifyDirectives,
	measureAgentContext,
	NAMED_PATH,
	PHASES,
	renderMarkdown,
} from "../scripts/measure-agent-context.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "stdd.mjs");
const REPORT = path.join(ROOT, "docs", "agent-context.md");
const HOSTS = ["claude", "codex", "pi"];
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const REFERENCES = fs
	.readdirSync(path.join(ROOT, "method"))
	.filter((name) => /^reference-[a-z-]+\.md$/.test(name))
	.map((name) => ({
		canonical: `method/${name}`,
		installed: `.stdd/reference/${name.replace(/^reference-/, "")}`,
	}));
// The one rewrite an installed copy is allowed to differ by.
const installedText = (text) =>
	text.replace(/`method\/reference-([a-z-]+)\.md`/g, "`.stdd/reference/$1.md`");
// Per-checkout working files a generated file may name without them existing,
// and the other hosts' snippets, which exist only for a selected host.
const WORKING_FILE =
	/^\.stdd\/(ledger\.jsonl|plan\.md|worker\.json|cleanup-transaction\.json|(?:CLAUDE|AGENTS|PI)-snippet\.md)$|^\.stdd\/playbooks\/local\//;

// Cumulative ceiling on the mandatory path, with headroom for wording edits
// and well below the baseline commit's figure (48,104 bytes for claude).
// Moving prose into a required read does not count as savings.
const CUMULATIVE_CEILING = 40_000;

const report = measureAgentContext(ROOT, HOSTS);

function stdd(args, cwd) {
	try {
		return {
			code: 0,
			out: execFileSync(process.execPath, [CLI, ...args], { cwd, stdio: "pipe" }).toString(),
		};
	} catch (err) {
		return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

function install(tool) {
	const dir = makeTempDir("stdd-context-");
	const result = stdd(["init", dir, "--tools", tool], ROOT);
	assert.equal(result.code, 0, result.out);
	return dir;
}

function walkFiles(dir, relative = "") {
	const out = [];
	for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
		const rel = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
		else out.push(rel);
	}
	return out;
}

test("the recorded agent-context report is what the generated entrypoints measure today", () => {
	assert.equal(
		fs.readFileSync(REPORT, "utf8"),
		renderMarkdown(report),
		"docs/agent-context.md is stale — re-run `node scripts/measure-agent-context.mjs . > docs/agent-context.md`",
	);
	assert.match(BASELINE_COMMIT, /^[0-9a-f]{40}$/);
	assert.match(read("CONTRIBUTING.md"), /measure-agent-context\.mjs/);
});

test("directive detection covers read, open, load, and consult, and keeps conditions apart", () => {
	const dir = makeTempDir("stdd-directives-");
	fs.mkdirSync(path.join(dir, "method"));
	fs.writeFileSync(path.join(dir, "method", "a.md"), "a\n");
	fs.writeFileSync(path.join(dir, "method", "b.md"), "b\n");
	const kinds = (text) => Object.fromEntries(classifyDirectives(text, dir));
	for (const verb of ["Read", "Open", "Load", "Consult", "read", "open"]) {
		assert.deepEqual(kinds(`${verb} \`method/a.md\` first.`), { "method/a.md": "required" }, verb);
	}
	assert.deepEqual(kinds("The rules are in `method/a.md`; open it when a step blocks."), {
		"method/a.md": "conditional",
	});
	assert.deepEqual(kinds("The rules are in `method/a.md`; open it only if a step blocks."), {
		"method/a.md": "conditional",
	});
	assert.deepEqual(kinds("See `method/a.md` for the internals."), { "method/a.md": "referenced" });
	assert.deepEqual(kinds("Open `method/a.md`. Later `method/a.md` is mentioned again, if needed."), {
		"method/a.md": "required",
	});
	assert.deepEqual(kinds("```\nRead `method/a.md`\n```\n`method/b.md` exists."), {
		"method/b.md": "referenced",
	});
	assert.deepEqual(kinds("Read `method/missing.md`."), {});
});

test("the required-read graph is one hop: start requires the method, the other phases require nothing", () => {
	for (const host of report.hosts) {
		const byPhase = new Map(host.phases.map((phase) => [phase.phase, phase]));
		assert.deepEqual(
			byPhase.get("start").required.map((file) => file.path),
			[".stdd/method.md"],
			`${host.host} start`,
		);
		assert.deepEqual(
			byPhase.get("start").conditional,
			[],
			`${host.host} start has no conditional reads`,
		);
		for (const phase of ["implement", "finish"]) {
			assert.deepEqual(byPhase.get(phase).required, [], `${host.host} ${phase}`);
			assert.deepEqual(
				byPhase.get(phase).conditional.map((file) => file.path),
				[".stdd/reference/commands.md"],
				`${host.host} ${phase} routes to the command internals only when blocked`,
			);
		}
		assert.ok(
			host.cumulative.bytes < CUMULATIVE_CEILING,
			`${host.host} reads ${host.cumulative.bytes} bytes across start → implement → finish; ceiling ${CUMULATIVE_CEILING}`,
		);
	}
});

test("reference documents are routed to, never required, and never route back to the whole", () => {
	const method = read("method/README.md");
	assert.ok(REFERENCES.length >= 3);
	for (const { canonical } of REFERENCES) {
		assert.ok(method.includes(`\`${canonical}\``), `method names ${canonical}`);
		// Descriptive prose may mention reading a file under a condition; an
		// unconditional directive would be a read-all cycle.
		const directed = [...classifyDirectives(read(canonical), ROOT)].filter(
			([, kind]) => kind === "required",
		);
		assert.deepEqual(directed, [], `${canonical} requires no further reading`);
	}
	assert.match(read("playbooks/implement.md"), /`method\/reference-commands\.md`/);
	assert.match(read("playbooks/finish-change.md"), /`method\/reference-commands\.md`/);
	// Only start-change directs a read on the normal path, and only to the method.
	for (const phase of PHASES) {
		const body = read(`playbooks/${phase.skill.replace(/^stdd-/, "")}.md`);
		const required = [...classifyDirectives(body, ROOT)]
			.filter(([, kind]) => kind === "required")
			.map(([p]) => p);
		assert.deepEqual(required, phase.id === "start" ? [".stdd/method.md"] : [], phase.skill);
	}
});

test("canonical sources keep repository-relative reference names for standalone reading", () => {
	for (const file of [
		"method/README.md",
		...REFERENCES.map((r) => r.canonical),
		...fs
			.readdirSync(path.join(ROOT, "playbooks"))
			.filter((n) => n.endsWith(".md"))
			.map((n) => `playbooks/${n}`),
	]) {
		const text = read(file);
		assert.doesNotMatch(
			text,
			/\.stdd\/reference\/[a-z-]+\.md/,
			`${file} names the installed copy instead of the source`,
		);
		for (const match of text.matchAll(NAMED_PATH)) {
			const relative = match[1];
			if (WORKING_FILE.test(relative)) continue;
			assert.ok(fs.existsSync(path.join(ROOT, relative)), `${file} names ${relative}`);
		}
	}
});

for (const tool of HOSTS) {
	test(`a clean ${tool} install carries every reference document its generated files name`, () => {
		const dir = install(tool);
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
		for (const { canonical, installed } of REFERENCES) {
			const copy = fs.readFileSync(path.join(dir, installed), "utf8");
			assert.equal(copy, installedText(read(canonical)), `${installed} is the rewritten canonical text`);
			assert.equal(manifest.files[installed], sha256(copy), `${installed} is manifest-tracked`);
		}
		const generated = Object.keys(manifest.files).filter((file) => file.endsWith(".md"));
		assert.ok(generated.includes(".stdd/method.md"));
		for (const file of generated) {
			const text = fs.readFileSync(path.join(dir, file), "utf8");
			assert.doesNotMatch(
				text,
				/method\/reference-[a-z-]+\.md/,
				`${file} names a package path the checkout lacks`,
			);
			for (const match of text.matchAll(NAMED_PATH)) {
				const relative = match[1];
				if (WORKING_FILE.test(relative)) continue;
				assert.ok(
					fs.existsSync(path.join(dir, relative)),
					`${file} names ${relative}, absent from the install`,
				);
			}
		}
		// The rewrite keeps every cross-reference between the copies resolvable.
		for (const { installed } of REFERENCES) {
			const text = fs.readFileSync(path.join(dir, installed), "utf8");
			for (const other of text.matchAll(/`(\.stdd\/reference\/[a-z-]+\.md)`/g)) {
				assert.ok(fs.existsSync(path.join(dir, other[1])), `${installed} names ${other[1]}`);
			}
		}
		const check = stdd(["check", dir], ROOT);
		assert.equal(check.code, 0, check.out);
	});
}

test("reference copies follow the managed lifecycle: idempotent re-init, upgrade, drift, retirement", () => {
	const dir = install("claude");
	const before = Object.fromEntries(
		walkFiles(dir, ".stdd/reference").map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
	);
	assert.ok(Object.keys(before).length >= 3);

	// Re-running init changes nothing.
	assert.equal(stdd(["init", dir, "--tools", "claude"], ROOT).code, 0);
	assert.deepEqual(
		Object.fromEntries(
			walkFiles(dir, ".stdd/reference").map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
		),
		before,
	);

	// An install from a kit that shipped no copies gains them on the next init.
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	for (const file of Object.keys(manifest.files))
		if (file.startsWith(".stdd/reference/")) delete manifest.files[file];
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	fs.rmSync(path.join(dir, ".stdd", "reference"), { recursive: true });
	assert.equal(stdd(["init", dir, "--tools", "claude"], ROOT).code, 0);
	assert.deepEqual(
		Object.fromEntries(
			walkFiles(dir, ".stdd/reference").map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
		),
		before,
	);

	// A hand edit is drift, named by path.
	fs.appendFileSync(path.join(dir, ".stdd", "reference", "commands.md"), "\nlocal tweak\n");
	const drift = stdd(["check", dir], ROOT);
	assert.notEqual(drift.code, 0);
	assert.match(drift.out, /\.stdd\/reference\/commands\.md/);
	assert.equal(stdd(["init", dir, "--tools", "claude"], ROOT).code, 0);
	assert.equal(stdd(["check", dir], ROOT).code, 0);

	// A copy a newer kit no longer ships is retired with the other generated outputs.
	const retired = path.join(dir, ".stdd", "reference", "obsolete.md");
	fs.writeFileSync(retired, "old\n");
	const withRetired = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	withRetired.files[".stdd/reference/obsolete.md"] = sha256("old\n");
	fs.writeFileSync(manifestPath, `${JSON.stringify(withRetired, null, "\t")}\n`);
	assert.equal(stdd(["init", dir, "--tools", "claude"], ROOT).code, 0);
	assert.ok(!fs.existsSync(retired), "an unshipped byte-identical copy is removed");
	assert.equal(stdd(["check", dir], ROOT).code, 0);
});

test("the plugin bundle names installed copies in its skills and ships the sources in its runtime", () => {
	for (const name of fs.readdirSync(path.join(ROOT, "plugins", "stdd", "skills"))) {
		const skill = read(`plugins/stdd/skills/${name}/SKILL.md`);
		assert.doesNotMatch(skill, /method\/reference-[a-z-]+\.md/, name);
	}
	assert.match(
		read("plugins/stdd/skills/stdd-finish-change/SKILL.md"),
		/`\.stdd\/reference\/commands\.md`/,
	);
	for (const { canonical } of REFERENCES) {
		assert.equal(
			read(`plugins/stdd/runtime/${canonical}`),
			read(canonical),
			`${canonical} ships in the runtime`,
		);
	}
	const pkg = JSON.parse(read("package.json"));
	assert.ok(pkg.files.includes("method/"), "@stdd/cli packages the method directory");
	assert.ok(pkg.files.includes("playbooks/"));
	const plugin = JSON.parse(read("plugins/stdd/package.json"));
	assert.ok(plugin.files.includes("runtime/"), "@stdd/plugin packages the runtime");
});

test("the core keeps the rules the partition must not weaken", () => {
	const method = read("method/README.md");
	for (const rule of [
		// routing and proportionality
		/one slice/,
		/Escalate as\s+soon as any of four things appears/,
		// docs-before-code and evidence
		/that edit is the spec/i,
		/Red before green/,
		/Docs updated first:/,
		/Docs checked, no change needed:/,
		/Docs not applicable:/,
		/Never claim "done"/,
		/terminal-green/,
		// TDD exceptions
		/design-first/,
		/reproduce the symptom in a test/i,
		// readiness and freshness
		/stdd doctor --readiness/,
		/Compaction is a trust boundary/,
		/stale/,
		// outcome focus
		/outcomes, not internals/,
		// authorization
		/Only permissions carry\s+authority/,
		/closed set/,
		/cannot waive a method gate/,
		/verifies it mechanically and states what it verified/,
		/Precedence runs live instruction, then policy, then kit default/,
		// review
		/derived, never self-declared/,
		/freezes\s+the checkout/,
		/never a silent fall-back to\s+self-review/,
		/untrusted review data/,
		/evidence, not a security boundary/,
		// definition of done
		/not runtime proof/,
	]) {
		assert.match(method, rule);
	}
	// The moved mechanics still have exactly one home.
	const commands = read("method/reference-commands.md");
	for (const rule of [
		/check-pr/,
		/--json/,
		/\[red: /,
		/Mode: inline\|delegated/,
		/maxRounds/,
		/--force/,
		/--gate/,
	]) {
		assert.match(commands, rule);
	}
	assert.match(read("method/reference-generated-state.md"), /— when:/);
	assert.match(read("method/reference-integration.md"), /contentRules/);
	assert.match(read("method/reference-integration.md"), /branchPattern/);
	assert.match(read("method/reference-integration.md"), /\.stdd\/reference\//);
});
