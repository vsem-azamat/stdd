// --- the project policy document: standing decisions, bounded grants ---
// Policy is durable repository state, not task state: it needs no active task
// and never touches the ledger. Callers translate these errors into CLI
// diagnostics; the module itself stays testable in process.
import fs from "node:fs";
import { resolveWritableRepoPath } from "../sdk/path.mjs";
import { appendPolicyNote, appendPolicyPermission, POLICY_ACTIONS } from "./lib.mjs";
import { findWorkerRoot } from "./worker-metadata.mjs";

const POLICY_REL = ".stdd/policy.md";

/**
 * Resolve the policy document for writing. A managed gitless worker sandbox is
 * refused outright: a delegated agent that could append a permission would be
 * granting itself the authority its brief withheld.
 */
function policyPath(cwd) {
	if (findWorkerRoot(cwd)) {
		throw new Error(
			"policy is owned by the source checkout — a managed worker cannot record standing decisions",
		);
	}
	return resolveWritableRepoPath(cwd, POLICY_REL, "policy path");
}

function appendPolicy(target, transform) {
	const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
	fs.writeFileSync(target, transform(existing));
}

/** `stdd policy add <text>` — record project nuance. Grants nothing. */
export function policyAdd(cwd, text) {
	const target = policyPath(cwd);
	appendPolicy(target, (content) => appendPolicyNote(content, text));
	return target;
}

/**
 * `stdd policy allow <action> --when <condition>` — pre-authorize one outward
 * effect. The action must come from the closed set, and the condition is
 * mandatory: a grant the session cannot verify is not a grant.
 */
export function policyAllow(cwd, action, condition) {
	if (!POLICY_ACTIONS.includes(action)) {
		throw new Error(
			`unknown policy action ${JSON.stringify(action)} (known: ${POLICY_ACTIONS.join(", ")})`,
		);
	}
	if (typeof condition !== "string" || condition.trim() === "") {
		throw new Error(
			`every permission names what to verify: policy allow <action> --when "<verifiable condition>"`,
		);
	}
	const target = policyPath(cwd);
	appendPolicy(target, (content) => appendPolicyPermission(content, action, condition.trim()));
	return target;
}
