import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { POLICY_ACTIONS, parsePolicy } from "../cli/lib.mjs";
import { policyAdd, policyAllow } from "../cli/policy.mjs";

const POLICY_REL = ".stdd/policy.md";

function tmpRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-policy-test-"));
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	return dir;
}

function readPolicy(dir) {
	return fs.readFileSync(path.join(dir, POLICY_REL), "utf8");
}

test("policy add creates the document and records a note that grants nothing", () => {
	const dir = tmpRepo();
	policyAdd(dir, "backend slices go to codex");
	policyAdd(dir, "seed data is never rewritten");

	const policy = parsePolicy(readPolicy(dir));
	assert.deepEqual(policy.notes, ["backend slices go to codex", "seed data is never rewritten"]);
	assert.deepEqual(policy.permissions, []);
});

test("policy allow records an action with the condition that gates it", () => {
	const dir = tmpRepo();
	policyAllow(dir, "merge", "draft cleared, review approved, every required check green");
	policyAllow(dir, "migrate", "the branch is dev or staging");

	const policy = parsePolicy(readPolicy(dir));
	assert.deepEqual(policy.permissions, [
		{ action: "merge", condition: "draft cleared, review approved, every required check green" },
		{ action: "migrate", condition: "the branch is dev or staging" },
	]);
});

test("an action outside the closed set is rejected and names the set", () => {
	const dir = tmpRepo();
	assert.throws(
		() => policyAllow(dir, "skip-review", "I am in a hurry"),
		(err) => {
			assert.match(err.message, /unknown policy action "skip-review"/);
			for (const action of POLICY_ACTIONS) assert.match(err.message, new RegExp(action));
			return true;
		},
	);
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});

test("a permission without a verifiable condition is rejected", () => {
	const dir = tmpRepo();
	for (const condition of ["", "   "]) {
		assert.throws(
			() => policyAllow(dir, "deploy", condition),
			/policy allow <action> --when "<verifiable condition>"/,
		);
	}
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});

test("a managed worker sandbox cannot grant itself authority", () => {
	const dir = tmpRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "worker.json"), "{}\n");

	assert.throws(() => policyAdd(dir, "anything at all"), /policy is owned by the source checkout/);
	assert.throws(
		() => policyAllow(dir, "merge", "any condition"),
		/policy is owned by the source checkout/,
	);
	assert.equal(fs.existsSync(path.join(dir, POLICY_REL)), false);
});
