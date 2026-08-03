// --- the project policy document: standing decisions, bounded grants ---
// Policy is durable repository state, not task state: it needs no active task
// and never touches the ledger. It is tracked, so it is published the way every
// other tracked file is — identity-bound and atomic, never written in place.
// Callers translate these errors into CLI diagnostics; the module itself stays
// testable in process.
import { resolveWritableRepoPath } from "../sdk/path.mjs";
import {
	openNativeRepoMutation,
	publishNativeRepoFile,
	readOptionalNativeRepoFile,
} from "./held-fs.mjs";
import { appendPolicyNote, appendPolicyPermission, assertPolicyAction } from "./lib.mjs";
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
