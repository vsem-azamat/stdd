import assert from "node:assert/strict";
import { test } from "node:test";
import {
	appendDeferred,
	extractDocPaths,
	findEvidenceLines,
	globToRegExp,
	mergeConfig,
	nearMissEvidenceLines,
	parseFrontmatter,
	parsePlan,
	planProgress,
	scanTemporal,
	sentinelSuggestion,
	temporalMatchers,
	workflowValidatesStaleBody,
} from "../cli/lib.mjs";

test("globToRegExp: ** crosses segments, * stays inside one", () => {
	const re = globToRegExp("docs/**/plans/**");
	assert.ok(re.test("docs/plans/a.md"));
	assert.ok(re.test("docs/x/y/plans/deep/b.md"));
	assert.ok(!re.test("docs/plansx/b.md"));
	assert.ok(!re.test("src/docs/plans/b.md"));

	const star = globToRegExp("docs/*.md");
	assert.ok(star.test("docs/a.md"));
	assert.ok(!star.test("docs/sub/a.md"));
});

test("globToRegExp: leading ** matches root and nested paths", () => {
	const re = globToRegExp("**/*.agent-plan.md");
	assert.ok(re.test("task.agent-plan.md"));
	assert.ok(re.test("deep/nested/task.agent-plan.md"));
	assert.ok(!re.test("task.agent-plan.mdx"));
});

test("globToRegExp: literal dots and spaces are not regex operators", () => {
	assert.ok(!globToRegExp("docs/*.md").test("docs/amd"));
	assert.ok(globToRegExp("docs/my plan/*.md").test("docs/my plan/a.md"));
});

test("parseFrontmatter: LF, CRLF, missing block, colon in value", () => {
	const lf = parseFrontmatter("---\nname: a\ndescription: b: c\n---\nbody");
	assert.equal(lf.meta.name, "a");
	assert.equal(lf.meta.description, "b: c");
	assert.equal(lf.body, "body");

	const crlf = parseFrontmatter("---\r\nname: a\r\n---\r\nbody\r\n");
	assert.equal(crlf.meta.name, "a");
	assert.equal(crlf.body, "body\n");

	const none = parseFrontmatter("just text");
	assert.deepEqual(none.meta, {});
	assert.equal(none.body, "just text");
});

test("mergeConfig: merges over defaults, rejects wrong shapes", () => {
	const merged = mergeConfig({ temporalPhrases: ["formerly"] });
	assert.deepEqual(merged.temporalPhrases, ["formerly"]);
	assert.ok(merged.forbiddenArtifacts.length > 0);

	assert.throws(() => mergeConfig({ canonicalDocs: "docs/**" }), /array of strings/);
	assert.throws(() => mergeConfig({ forbiddenArtifacts: [42] }), /array of strings/);
});

test("findEvidenceLines: extracts label and content from line starts", () => {
	const hits = findEvidenceLines("Summary\n\nDocs updated first: docs/domain/pricing.md\n");
	assert.deepEqual(hits, [{ label: "Docs updated first", content: "docs/domain/pricing.md", line: 3 }]);
});

test("findEvidenceLines: a bare label yields empty content", () => {
	const hits = findEvidenceLines("Docs updated first:\nrest of body\n");
	assert.deepEqual(hits, [{ label: "Docs updated first", content: "", line: 1 }]);
});

test("findEvidenceLines: quoted templates and fenced code do not count", () => {
	const body = [
		"> Docs updated first: quoted template",
		"```",
		"Docs not applicable: inside a fence",
		"```",
		"Docs checked, no change needed: docs/domain/auth.md — rule already covered",
	].join("\n");
	const hits = findEvidenceLines(body);
	assert.deepEqual(hits, [
		{
			label: "Docs checked, no change needed",
			content: "docs/domain/auth.md — rule already covered",
			line: 5,
		},
	]);
});

test("findEvidenceLines: CRLF bodies and case-insensitive labels", () => {
	const hits = findEvidenceLines("docs not applicable: lint only\r\n");
	assert.deepEqual(hits, [{ label: "Docs not applicable", content: "lint only", line: 1 }]);
});

test("extractDocPaths: pulls .md paths out of prose, ignores plain reasons", () => {
	assert.deepEqual(
		extractDocPaths("docs/domain/pricing.md, docs/product/roadmap.md — per-item rejected"),
		["docs/domain/pricing.md", "docs/product/roadmap.md"],
	);
	assert.deepEqual(extractDocPaths("lint-only mechanical change"), []);
	assert.deepEqual(extractDocPaths("`docs/domain/auth.md` (rule already covered)"), [
		"docs/domain/auth.md",
	]);
});

test("nearMissEvidenceLines: markdown emphasis around the label", () => {
	const hits = nearMissEvidenceLines("Summary\n\n**Docs updated first:** docs/domain/orgs.md\n");
	assert.equal(hits.length, 1);
	assert.equal(hits[0].line, 3);
	assert.equal(hits[0].raw, "**Docs updated first:** docs/domain/orgs.md");
	assert.equal(hits[0].suggestion, "Docs updated first: docs/domain/orgs.md");
});

test("nearMissEvidenceLines: list and quote markers, leading whitespace", () => {
	const list = nearMissEvidenceLines("- Docs checked, no change needed: docs/a.md — covered\n");
	assert.equal(list[0].suggestion, "Docs checked, no change needed: docs/a.md — covered");

	const quoted = nearMissEvidenceLines("> Docs not applicable: lint only\n");
	assert.equal(quoted[0].suggestion, "Docs not applicable: lint only");

	const indented = nearMissEvidenceLines("  Docs not applicable: build plumbing\n");
	assert.equal(indented[0].suggestion, "Docs not applicable: build plumbing");
});

test("nearMissEvidenceLines: strictly valid lines are not near-misses", () => {
	assert.deepEqual(nearMissEvidenceLines("Docs updated first: docs/a.md\n"), []);
});

test("sentinelSuggestion: wrong sentinel as 'updated first' content maps to the right label", () => {
	assert.equal(sentinelSuggestion("not applicable"), "Docs not applicable: <why implementation-only>");
	assert.equal(sentinelSuggestion("n/a"), "Docs not applicable: <why implementation-only>");
	assert.equal(
		sentinelSuggestion("no change needed"),
		"Docs checked, no change needed: <docs + reason>",
	);
	assert.equal(sentinelSuggestion("see the description"), null);
});

test("nearMissEvidenceLines: truncated label stems match", () => {
	const hits = nearMissEvidenceLines("Docs checked, no docs change needed: docs/a.md — covered\n");
	assert.equal(hits.length, 1);
	assert.equal(hits[0].suggestion, "Docs checked, no change needed: docs/a.md — covered");
});

test("nearMissEvidenceLines: fenced code and unrelated prose do not match", () => {
	const fenced = nearMissEvidenceLines("```\n**Docs updated first:** docs/a.md\n```\n");
	assert.deepEqual(fenced, []);
	assert.deepEqual(nearMissEvidenceLines("We updated the docs for this change.\n"), []);
	assert.deepEqual(nearMissEvidenceLines("Summary of the change.\n"), []);
});

test("workflowValidatesStaleBody: payload body into check-pr without an edited trigger", () => {
	const stale =
		"on:\n  pull_request:\n    types: [opened, synchronize]\n" +
		"  run: printf '%s' \"${{ github.event.pull_request.body }}\" | stdd check-pr -\n";
	assert.ok(workflowValidatesStaleBody(stale));
	assert.ok(!workflowValidatesStaleBody(stale.replace("[opened,", "[opened, edited,")));
	assert.ok(!workflowValidatesStaleBody("run: npx @stdd/cli check .\n"));
	assert.ok(
		!workflowValidatesStaleBody("labels: ${{ github.event.pull_request.body }}\n"),
		"payload body without check-pr is not this finding",
	);
});

test("scanTemporal: skips fences and hyphenated compounds", () => {
	const matchers = temporalMatchers(["no longer", "previously"]);
	const hits = scanTemporal(
		[
			"The order previously shipped.", // hit
			"no longer-lived tokens are fine.", // compound — no hit
			"```",
			"no longer inside a fence",
			"```",
			"It is no longer draft.", // hit
		],
		matchers,
	);
	assert.deepEqual(
		hits.map((h) => [h.line, h.phrase]),
		[
			[1, "previously"],
			[6, "no longer"],
		],
	);
});

// --- the durable plan: parsePlan, planProgress, appendDeferred ---

test("parsePlan: checkboxes with state, [red:] tags, fences skipped", () => {
	const plan = parsePlan(
		[
			"# Plan: parser",
			"",
			"Intent prose is ignored.",
			"",
			"- [x] 1. docs edit",
			"- [ ] 2. parser rejects empty input [red: parser.test]",
			"* [X] 3. wire status",
			"```",
			"- [ ] inside a fence",
			"```",
			"not a checkbox",
		].join("\n"),
	);
	assert.equal(plan.items.length, 3);
	assert.deepEqual(
		plan.items.map((i) => [i.checked, i.red]),
		[
			[true, null],
			[false, "parser.test"],
			[true, null],
		],
	);
	assert.equal(plan.items[1].line, 6);
	assert.equal(plan.items[1].text, "2. parser rejects empty input [red: parser.test]");
	assert.deepEqual(plan.deferred, []);
});

test("parsePlan: the Deferred section is separate and never counts as items", () => {
	const plan = parsePlan(
		[
			"- [ ] 1. real step",
			"",
			"## Deferred",
			"",
			"- glob dialect docs",
			"- [ ] checkbox-styled cut",
		].join("\n"),
	);
	assert.equal(plan.items.length, 1);
	assert.deepEqual(plan.deferred, ["glob dialect docs", "checkbox-styled cut"]);
});

test("planProgress: a plain checked item is done; unchecked is the next open item", () => {
	const plan = parsePlan("- [x] 1. docs\n- [ ] 2. impl\n- [ ] 3. verify\n");
	const p = planProgress(plan, []);
	assert.equal(p.total, 3);
	assert.equal(p.done, 1);
	assert.equal(p.next.text, "2. impl");
	assert.deepEqual(p.unproven, []);
});

test("planProgress: a checked [red:] item without a matching red stays open and unproven", () => {
	const plan = parsePlan("- [x] parser rejects empty [red: parser.test]\n");
	const none = planProgress(plan, []);
	assert.equal(none.done, 0);
	assert.equal(none.unproven.length, 1);
	assert.equal(none.next.text, "parser rejects empty [red: parser.test]");

	const wrongCmd = planProgress(plan, [{ cmd: "npm test", genuine: "yes" }]);
	assert.equal(wrongCmd.done, 0);

	const notGenuine = planProgress(plan, [{ cmd: "node --test parser.test.mjs", genuine: "no" }]);
	assert.equal(notGenuine.done, 0);

	const proven = planProgress(plan, [{ cmd: "node --test parser.test.mjs", genuine: "yes" }]);
	assert.equal(proven.done, 1);
	assert.equal(proven.next, null);
	assert.deepEqual(proven.unproven, []);
});

test("planProgress: genuine unknown (no redPattern) still closes a [red:] item", () => {
	const plan = parsePlan("- [x] step [red: parser.test]\n");
	const p = planProgress(plan, [{ cmd: "node --test parser.test.mjs", genuine: "unknown" }]);
	assert.equal(p.done, 1);
});

test("appendDeferred: creates the section and appends inside an existing one", () => {
	const created = appendDeferred("", "glob dialect docs");
	assert.match(created, /^## Deferred\n\n- glob dialect docs\n$/);

	const appended = appendDeferred(created, "second cut");
	assert.match(appended, /- glob dialect docs\n- second cut\n/);

	const withPlan = appendDeferred("# Plan\n\n- [ ] step\n", "a cut");
	assert.match(withPlan, /- \[ \] step\n\n## Deferred\n\n- a cut\n/);
});

test("appendDeferred: inserts before a following section, not at file end", () => {
	const content = "## Deferred\n\n- first\n\n## Notes\n\nprose\n";
	const out = appendDeferred(content, "second");
	assert.match(out, /- first\n- second\n\n## Notes\n/);
});

test("mergeConfig: validates the readiness contract shape", () => {
	const ok = mergeConfig({ readiness: { required: [{ path: "node_modules", hint: "install" }] } });
	assert.equal(ok.readiness.required[0].path, "node_modules");
	assert.deepEqual(mergeConfig({}).readiness, { required: [] });

	assert.throws(() => mergeConfig({ readiness: { required: "node_modules" } }), /readiness/);
	assert.throws(() => mergeConfig({ readiness: { required: [{ hint: "no path" }] } }), /readiness/);
	assert.throws(() => mergeConfig({ readiness: { required: [{ path: 42 }] } }), /readiness/);
});
