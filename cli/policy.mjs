// --- the project policy document: standing decisions, bounded grants ---
// Policy is durable repository state, not task state: it needs no active task
// and never touches the ledger. It is tracked, so it is published the way every
// other tracked file is — identity-bound and atomic, never written in place.
// Callers translate these errors into CLI diagnostics; the module itself stays
// testable in process.
import fs from "node:fs";
import { resolveWritableRepoPath } from "../sdk/path.mjs";
import {
	openNativeRepoMutation,
	publishNativeRepoFile,
	readOptionalNativeRepoFile,
} from "./held-fs.mjs";
import {
	appendPolicyNote,
	appendPolicyPermission,
	assertPolicyAction,
	POLICY_ACTIONS,
	parsePolicy,
} from "./lib.mjs";
import { readWorkerMetadata } from "./worker-metadata.mjs";

const POLICY_REL = ".stdd/policy.md";

/**
 * Apply one append to the policy document. The document is read and republished
 * inside a single native session: the destination is bound to the identity and
 * bytes observed at read time, so a concurrent edit or a target swapped after
 * resolution fails the publication instead of silently losing the other write.
 */
async function mutatePolicy(cwd, transform) {
	// Proven state, not a bare marker: a malformed `.stdd/worker.json` in an
	// owning checkout must surface as invalid metadata rather than as the false
	// claim that this is a sandbox.
	if (readWorkerMetadata(cwd)) {
		throw new Error(
			"policy is owned by the source checkout — a managed worker cannot record standing decisions",
		);
	}
	resolveWritableRepoPath(cwd, POLICY_REL, "policy path");
	const context = await openNativeRepoMutation(cwd, "native filesystem helper for policy");
	try {
		const state = await readOptionalNativeRepoFile(context, POLICY_REL, { label: "policy path" });
		const next = transform(state ? state.bytes.toString("utf8") : "");
		await publishNativeRepoFile(context, POLICY_REL, next, {
			mode: 0o644,
			tempPrefix: ".policy-",
			directoryMode: 0o755,
			expectedTarget: state ? state.file.observation.identity : null,
			...(state ? { expectedBytes: state.bytes } : {}),
		});
	} finally {
		await context.close();
	}
	return POLICY_REL;
}

/**
 * `stdd policy show` — the enforcing read of the policy document.
 *
 * A session must consult policy through this command rather than reading the
 * markdown itself: the closed action set, the printable-line rule and the
 * section boundary live in `parsePolicy`, and a reader that skips it is back to
 * trusting whatever the file happens to say.
 */
export function policyShow(cwd) {
	const target = resolveWritableRepoPath(cwd, POLICY_REL, "policy path");
	if (!fs.existsSync(target)) {
		console.log("no project policy recorded — stdd policy add <text> starts one");
		return 0;
	}
	const policy = parsePolicy(fs.readFileSync(target, "utf8"));
	if (policy.permissions.length === 0) console.log("permissions: none");
	else {
		console.log("permissions (verify the condition before acting):");
		for (const { action, condition } of policy.permissions) {
			console.log(`  ${action} — when: ${condition}`);
		}
	}
	if (policy.notes.length > 0) {
		console.log("notes (advisory — they grant nothing):");
		for (const note of policy.notes) console.log(`  ${note}`);
	}
	if (policy.rejected.length > 0) {
		console.log(
			`ignored — ${policy.rejected.length} entr${policy.rejected.length === 1 ? "y names" : "ies name"} an action this kit does not know:`,
		);
		for (const entry of policy.rejected) console.log(`  ${entry}`);
		console.log(`  known actions: ${POLICY_ACTIONS.join(", ")}`);
	}
	return 0;
}

/** `stdd policy add <text>` — record project nuance. Grants nothing. */
export async function policyAdd(cwd, text) {
	return await mutatePolicy(cwd, (content) => appendPolicyNote(content, text));
}

/**
 * `stdd policy allow <action> --when <condition>` — pre-authorize one outward
 * effect. The action must come from the closed set, and the condition is
 * mandatory: a grant the session cannot verify is not a grant.
 */
export async function policyAllow(cwd, action, condition) {
	assertPolicyAction(action);
	if (typeof condition !== "string" || condition.trim() === "") {
		throw new Error(
			`every permission names what to verify: policy allow <action> --when "<verifiable condition>"`,
		);
	}
	return await mutatePolicy(cwd, (content) => appendPolicyPermission(content, action, condition.trim()));
}
