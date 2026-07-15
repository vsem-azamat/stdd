import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractDocPaths,
	findEvidenceLines,
	globToRegExp,
	mergeConfig,
	nearMissEvidenceLines,
	parseFrontmatter,
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
	assert.deepEqual(hits, [{ label: "Docs updated first", content: "docs/domain/pricing.md" }]);
});

test("findEvidenceLines: a bare label yields empty content", () => {
	const hits = findEvidenceLines("Docs updated first:\nrest of body\n");
	assert.deepEqual(hits, [{ label: "Docs updated first", content: "" }]);
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
		},
	]);
});

test("findEvidenceLines: CRLF bodies and case-insensitive labels", () => {
	const hits = findEvidenceLines("docs not applicable: lint only\r\n");
	assert.deepEqual(hits, [{ label: "Docs not applicable", content: "lint only" }]);
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

test("mergeConfig: validates the readiness contract shape", () => {
	const ok = mergeConfig({ readiness: { required: [{ path: "node_modules", hint: "install" }] } });
	assert.equal(ok.readiness.required[0].path, "node_modules");
	assert.deepEqual(mergeConfig({}).readiness, { required: [] });

	assert.throws(() => mergeConfig({ readiness: { required: "node_modules" } }), /readiness/);
	assert.throws(() => mergeConfig({ readiness: { required: [{ hint: "no path" }] } }), /readiness/);
	assert.throws(() => mergeConfig({ readiness: { required: [{ path: 42 }] } }), /readiness/);
});
