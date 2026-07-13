import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
