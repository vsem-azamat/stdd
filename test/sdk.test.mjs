import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	deriveLoopState,
	extractDocPaths,
	mergeConfig,
	resolveRepoPath,
	STDD_VERSION,
} from "../sdk/index.mjs";

test("the public SDK entry point exposes versioned pure helpers", () => {
	assert.match(STDD_VERSION, /^\d+\.\d+\.\d+$/);
	const config = mergeConfig({});
	assert.ok(config.capabilities);
	config.canonicalDocs.push("docs/custom/**/*.md");
	assert.ok(!DEFAULT_CONFIG.canonicalDocs.includes("docs/custom/**/*.md"));
	assert.throws(() => DEFAULT_CONFIG.canonicalDocs.push("docs/mutated/**/*.md"), TypeError);
	assert.deepEqual(extractDocPaths("docs/über.md"), ["docs/über.md"]);
});

test("resolveRepoPath accepts safe repository paths and rejects escapes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-sdk-"));
	assert.equal(resolveRepoPath(root, "docs/domain/a.md"), path.join(root, "docs/domain/a.md"));
	assert.equal(
		resolveRepoPath(path.parse(root).root, "docs/a.md"),
		path.join(path.parse(root).root, "docs/a.md"),
	);
	for (const unsafe of ["../outside", "/absolute", "C:\\outside", "docs/../../outside", "a\0b"]) {
		assert.throws(() => resolveRepoPath(root, unsafe), /safe repository-relative path/i);
	}
});

test("deriveLoopState exposes snapshot-aware proof without CLI side effects", () => {
	const events = [
		{ event: "red", exit: 1, genuine: "yes", snapshot: "red" },
		{ event: "verify", exit: 0, snapshot: "green" },
	];
	const green = deriveLoopState(events, "green");
	assert.equal(green.loop.red.done, true);
	assert.equal(green.loop.impl.done, true);
	assert.equal(green.loop.verify.done, true);
	const stale = deriveLoopState(events, "later");
	assert.equal(stale.loop.verify.done, false);
	assert.equal(stale.loop.verify.stale, true);
});
