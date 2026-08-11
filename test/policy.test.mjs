import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { POLICY_ACTIONS, parsePolicy } from "../cli/lib.mjs";
import { policyAdd, policyAllow } from "../cli/policy.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const POLICY_REL = ".stdd/policy.md";

function tmpRepo() {
	const dir = makeTempDir("stdd-policy-test-");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	return dir;
}

function readPolicy(dir) {
	return fs.readFileSync(path.join(dir, POLICY_REL), "utf8");
}

test("policy add creates the document and records a note that grants nothing", async () => {
	const dir = tmpRepo();
	await policyAdd(dir, "backend slices go to codex");
	await policyAdd(dir, "seed data is never rewritten");

	const policy = parsePolicy(readPolicy(dir));
	assert.deepEqual(policy.notes, ["backend slices go to codex", "seed data is never rewritten"]);
	assert.deepEqual(policy.permissions, []);
});

test("policy allow records an action with the condition that gates it", async () => {
	const dir = tmpRepo();
	await policyAllow(dir, "merge", "draft cleared, review approved, every required check green");
	await policyAllow(dir, "migrate", "the branch is dev or staging");

	const policy = parsePolicy(readPolicy(dir));
	assert.deepEqual(policy.permissions, [
		{ action: "merge", condition: "draft cleared, review approved, every required check green" },
		{ action: "migrate", condition: "the branch is dev or staging" },
	]);
});

test("an action outside the closed set is rejected and names the set", async () => {
	const dir = tmpRepo();
	await assert.rejects(
		() => policyAllow(dir, "skip-review", "I am in a hurry"),
		(err) => {
			assert.match(err.message, /unknown policy action "skip-review"/);
			for (const action of POLICY_ACTIONS) assert.match(err.message, new RegExp(action));
			return true;
		},
	);
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});

test("a rejected action is never echoed with its invisible characters", async () => {
	const dir = tmpRepo();
	for (const action of ["skip\u202ereview", "skip\u200breview", "skip\u0000review"]) {
		await assert.rejects(
			() => policyAllow(dir, action, "any condition"),
			(err) => {
				assert.match(err.message, /single printable line/);
				assert.ok(!err.message.includes(action), "the raw action must not reach a diagnostic");
				return true;
			},
			JSON.stringify(action),
		);
	}
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});

test("a permission without a verifiable condition is rejected", async () => {
	const dir = tmpRepo();
	for (const condition of ["", "   "]) {
		await assert.rejects(
			() => policyAllow(dir, "deploy", condition),
			/policy allow <action> --when "<verifiable condition>"/,
		);
	}
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});

function markWorker(dir) {
	fs.writeFileSync(
		path.join(dir, ".stdd", "worker.json"),
		JSON.stringify({
			schema: 1,
			workerId: `worker-${"a1b2c3d4e5f6".repeat(2)}`,
			source: {
				root: "/src",
				branch: "feature",
				taskId: "task-1234",
				taskName: "a slice",
				head: "0123456789abcdef0123456789abcdef01234567",
			},
			scope: { frozenPaths: ["docs/**"], allowedPaths: [] },
			baseline: { files: {} },
		}),
	);
}

test("a managed worker sandbox cannot grant itself authority", async () => {
	const dir = tmpRepo();
	markWorker(dir);

	await assert.rejects(
		() => policyAdd(dir, "anything at all"),
		/policy is owned by the source checkout/,
	);
	await assert.rejects(
		() => policyAllow(dir, "merge", "any condition"),
		/policy is owned by the source checkout/,
	);
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});

test("a malformed worker marker reports the metadata, not a false sandbox claim", async () => {
	const dir = tmpRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "worker.json"), "{}\n");

	await assert.rejects(
		() => policyAdd(dir, "anything at all"),
		(err) => {
			assert.match(err.message, /invalid managed worker metadata/);
			assert.doesNotMatch(err.message, /owned by the source checkout/);
			return true;
		},
	);
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});

test("a policy document replaced by a symlink is never written through", async () => {
	const dir = tmpRepo();
	const outside = path.join(dir, "outside.md");
	fs.writeFileSync(outside, "untouched\n");
	fs.symlinkSync(outside, path.join(dir, POLICY_REL));

	await assert.rejects(() => policyAdd(dir, "a note that must not escape"));
	assert.equal(fs.readFileSync(outside, "utf8"), "untouched\n");
});

test("a hard-linked policy document is not published in place", async () => {
	const dir = tmpRepo();
	const target = path.join(dir, POLICY_REL);
	fs.writeFileSync(target, "## Notes\n\n- first\n");
	const twin = path.join(dir, "twin.md");
	fs.linkSync(target, twin);

	await policyAdd(dir, "second");
	// Publication replaces the name rather than writing through the shared
	// inode, so the twin keeps the bytes it was linked to.
	assert.equal(fs.readFileSync(twin, "utf8"), "## Notes\n\n- first\n");
	assert.match(readPolicy(dir), /- first\n- second\n/);
});
