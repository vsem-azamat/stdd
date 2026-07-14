import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractDocPaths,
	findEvidenceLines,
	globToRegExp,
	mergeConfig,
	parseFrontmatter,
	scanTemporal,
	temporalMatchers,
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
