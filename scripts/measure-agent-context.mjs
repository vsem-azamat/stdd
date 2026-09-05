#!/usr/bin/env node
// Measures the reading an agent performs on the normal start → implement →
// finish path, per supported host, from the generated entrypoints of an
// initialized checkout.
//
// The graph is derived from the generated files themselves, never from a
// hand-maintained list:
//
// - injected: the host's always-on STDD block (the generated snippet that
//   `stdd init` places in CLAUDE.md, AGENTS.md, or .pi/APPEND_SYSTEM.md).
//   The session hook's `stdd status --local` output is injected too, but it is
//   dynamic runtime text, not a file, and is reported as unmeasured.
// - skill: the phase's native skill file, loaded when the phase is invoked.
// - required: a repository path named in backticks inside a sentence that
//   directs the reader to it (read, open, load, consult) with no condition
//   attached. Followed transitively through the same rule.
// - conditional: the same directive with a condition attached ("open it when
//   one of them blocks a step"). Named per phase and sized, but not counted as
//   normal-path reading; a worst-case figure adds them all.
// - referenced: every other repository path a mandatory file names in
//   backticks and that exists in the checkout. Named, not directed to.
// - routes: other skills a mandatory file names by skill name. Escalations,
//   not reads on the normal path.
// - excluded: project-specific reads ("the canonical docs governing the
//   touched behavior") are unbounded and not counted.
//
// Sizes are UTF-8 bytes and Unicode code points. They describe reading
// volume only — not tokens, speed, or cost. Identical paths are counted once
// per phase, and the cumulative row counts each path once across the whole
// path, so the snippet and a shared required read are not double-counted.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ADAPTERS } from "../sdk/adapters.mjs";

export const PHASES = Object.freeze([
	{ id: "start", skill: "stdd-start-change" },
	{ id: "implement", skill: "stdd-implement" },
	{ id: "finish", skill: "stdd-finish-change" },
]);

/** The commit the reduction is measured against; see `renderMarkdown`. */
export const BASELINE_COMMIT = "8cba71fcb08811f18077687c860407f35d548f7d";

/** A repository path named in backticks. */
export const NAMED_PATH = /`((?:\.stdd|method|playbooks|docs|templates)\/[\w./-]+\.(?:md|json))`/g;
/** A sentence that directs the reader to a file. */
export const DIRECTIVE = /\b(?:read|open|load|consult)\b/i;
/** A directive that applies only in a named situation. */
export const CONDITION = /\b(?:when|if|unless|only|once|not before|then, not)\b/i;
const SKILL_NAME = /`(stdd-[a-z][a-z0-9-]*)`|the ([a-z-]+) playbook\b/g;

function measure(text) {
	return { bytes: Buffer.byteLength(text, "utf8"), chars: Array.from(text).length };
}

function readRepoFile(root, relative) {
	const text = fs.readFileSync(path.join(root, relative), "utf8");
	return { path: relative, ...measure(text), text };
}

function exists(root, relative) {
	try {
		return fs.statSync(path.join(root, relative)).isFile();
	} catch {
		return false;
	}
}

function sentences(text) {
	// Fenced code is a literal, not prose. Split the rest on sentence ends.
	const prose = text.replace(/```[\s\S]*?```/g, " ");
	return prose.split(/(?<=[.!?])\s+|\n\s*\n/);
}

/**
 * Classify every repository path a text names: `required` (directed to, no
 * condition), `conditional` (directed to under a condition), or `referenced`
 * (named only). A path directed to anywhere in the text is never demoted to
 * referenced by a later mention; a required mention outranks a conditional one.
 */
export function classifyDirectives(text, root) {
	const rank = { referenced: 0, conditional: 1, required: 2 };
	const found = new Map();
	for (const sentence of sentences(text)) {
		const directed = DIRECTIVE.test(sentence);
		const conditional = directed && CONDITION.test(sentence);
		const kind = directed ? (conditional ? "conditional" : "required") : "referenced";
		for (const match of sentence.matchAll(NAMED_PATH)) {
			const relative = match[1];
			if (!exists(root, relative)) continue;
			const previous = found.get(relative);
			if (!previous || rank[kind] > rank[previous]) found.set(relative, kind);
		}
	}
	return found;
}

function routes(text, ownSkill) {
	const names = new Set();
	for (const match of text.matchAll(SKILL_NAME)) {
		const name = match[1] ?? `stdd-${match[2]}`;
		if (name !== ownSkill) names.add(name);
	}
	return [...names].sort();
}

/** Follows unconditional directives transitively; collects conditional ones. */
function walk(root, text, seen, required, conditional) {
	for (const [relative, kind] of classifyDirectives(text, root)) {
		if (kind === "referenced" || seen.has(relative)) continue;
		if (kind === "conditional") {
			if (!conditional.some((file) => file.path === relative)) {
				conditional.push(readRepoFile(root, relative));
			}
			continue;
		}
		seen.add(relative);
		const file = readRepoFile(root, relative);
		required.push(file);
		walk(root, file.text, seen, required, conditional);
	}
}

function referencedPaths(root, files, exclude) {
	const found = new Set();
	for (const file of files) {
		for (const match of file.text.matchAll(NAMED_PATH)) {
			const relative = match[1];
			if (!exclude.has(relative) && exists(root, relative)) found.add(relative);
		}
	}
	return [...found].sort();
}

function total(files) {
	return files.reduce(
		(sum, file) => ({ bytes: sum.bytes + file.bytes, chars: sum.chars + file.chars }),
		{ bytes: 0, chars: 0 },
	);
}

function strip(file) {
	const { text: _text, ...rest } = file;
	return rest;
}

export function readProfile(root) {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, ".stdd", "manifest.json"), "utf8"));
	const config = JSON.parse(fs.readFileSync(path.join(root, ".stdd", "config.json"), "utf8"));
	return {
		tools: manifest.targets.tools,
		version: manifest.version,
		capabilities: config.capabilities ?? {},
		reviewVia: config.review?.via ?? null,
		projectLog: config.projectLog?.enabled ?? true,
	};
}

export function measureAgentContext(root, tools) {
	const profile = readProfile(root);
	const hosts = [];
	for (const tool of tools ?? profile.tools) {
		const adapter = AGENT_ADAPTERS[tool];
		if (!adapter) throw new Error(`unknown host "${tool}"`);
		const injected = readRepoFile(root, adapter.snippetFile);
		const cumulativeSeen = new Set([injected.path]);
		const cumulativeFiles = [injected];
		const phases = [];
		for (const phase of PHASES) {
			const skill = readRepoFile(root, `${adapter.skillRoot}/${phase.skill}/SKILL.md`);
			const phaseSeen = new Set([injected.path, skill.path]);
			const required = [];
			const conditional = [];
			walk(root, skill.text, phaseSeen, required, conditional);
			const mandatory = [injected, skill, ...required];
			const incremental = mandatory.filter((file) => !cumulativeSeen.has(file.path));
			for (const file of incremental) {
				cumulativeSeen.add(file.path);
				cumulativeFiles.push(file);
			}
			const mandatoryTotal = total(mandatory);
			const conditionalTotal = total(conditional);
			phases.push({
				phase: phase.id,
				injected: strip(injected),
				skill: strip(skill),
				required: required.map(strip),
				conditional: conditional.map(strip),
				referenced: referencedPaths(
					root,
					mandatory,
					new Set([...phaseSeen, ...conditional.map((file) => file.path)]),
				),
				routes: routes(skill.text, phase.skill),
				phaseTotal: mandatoryTotal,
				worstCase: {
					bytes: mandatoryTotal.bytes + conditionalTotal.bytes,
					chars: mandatoryTotal.chars + conditionalTotal.chars,
				},
				incremental: { files: incremental.map((file) => file.path), ...total(incremental) },
			});
		}
		hosts.push({
			host: tool,
			injected: strip(injected),
			phases,
			cumulative: { files: cumulativeFiles.map((file) => file.path), ...total(cumulativeFiles) },
		});
	}
	return {
		units: { bytes: "UTF-8 bytes", chars: "Unicode code points" },
		profile,
		baseline: BASELINE_COMMIT,
		assumptions: [
			`measured from this checkout's generated files: stdd v${profile.version}, hosts ${profile.tools.join(", ")}, capabilities ${JSON.stringify(profile.capabilities)}, review.via ${JSON.stringify(profile.reviewVia)}, projectLog ${profile.projectLog}; every generated file carries the version stamp, so a version bump or a profile change moves the figures and the report is regenerated with them`,
			"injected: the generated snippet is present in every prompt of the host; the session hook's `stdd status --local` output is dynamic and unmeasured",
			"required: a backticked repository path in a sentence that directs the reader to it (read, open, load, consult) with no condition; followed transitively by the same rule",
			"conditional: the same directive under a condition (when, if, unless, only, once); sized per phase and added to the worst-case figure, not to the normal path",
			"referenced: other backticked repository paths that exist; routes: other skills named as escalations — neither is counted",
			"excluded: project-specific reads (the canonical docs governing the touched behavior) are unbounded and not counted",
			"phase counts each path once within the phase; cumulative counts each path once across start → implement → finish; incremental is what the phase adds to the cumulative set",
		],
		hosts,
	};
}

function fmt(n) {
	return n.toLocaleString("en-US");
}

function list(paths) {
	return paths.length ? paths.map((p) => `\`${p}\``).join(", ") : "none";
}

export function renderMarkdown(report) {
	const lines = ["# Agent reading on the start → implement → finish path", ""];
	lines.push(
		"Generated by `scripts/measure-agent-context.mjs` from this checkout's generated",
		"entrypoints; `test/agent-context.test.mjs` fails when it is stale. Sizes are",
		"UTF-8 bytes and Unicode code points of reading volume only. They are not tokens",
		"and claim nothing about model speed or cost.",
		"",
		"The reduction this partition delivers is measured against commit",
		`\`${report.baseline}\`, reproducible with the same script against a checkout of`,
		"that commit (for example `git worktree add /tmp/stdd-baseline <commit>`, then",
		"`node scripts/measure-agent-context.mjs /tmp/stdd-baseline`).",
		"",
		"## Assumptions",
		"",
		...report.assumptions.map((line) => `- ${line}`),
		"",
	);
	for (const host of report.hosts) {
		lines.push(`## ${host.host}`, "", `Injected every prompt: \`${host.injected.path}\``, "");
		lines.push(
			"| Phase | Skill | Required | Conditional | Referenced | Routes | Phase bytes | Phase chars | Worst-case bytes | Incremental bytes | Incremental chars |",
			"| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
		);
		for (const phase of host.phases) {
			lines.push(
				`| ${phase.phase} | \`${phase.skill.path}\` | ${list(phase.required.map((f) => f.path))} | ${list(
					phase.conditional.map((f) => f.path),
				)} | ${list(phase.referenced)} | ${list(phase.routes)} | ${fmt(phase.phaseTotal.bytes)} | ${fmt(
					phase.phaseTotal.chars,
				)} | ${fmt(phase.worstCase.bytes)} | ${fmt(phase.incremental.bytes)} | ${fmt(phase.incremental.chars)} |`,
			);
		}
		lines.push(
			"",
			`Cumulative (each path once): ${fmt(host.cumulative.bytes)} bytes, ${fmt(host.cumulative.chars)} chars over ${list(host.cumulative.files)}.`,
			"",
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const root = args.find((arg) => !arg.startsWith("--")) ?? process.cwd();
	const report = measureAgentContext(path.resolve(root));
	process.stdout.write(json ? `${JSON.stringify(report, null, "\t")}\n` : renderMarkdown(report));
}
