import { spawnSync } from "node:child_process";
import { resolveRepoPath } from "../sdk/path.mjs";
import { assertPrintableSingleLine } from "../sdk/text.mjs";
import { loadConfig } from "./config.mjs";
import {
	appendLedger,
	DOCS_DECISIONS,
	ledgerAppendContext,
	withCapturedLedgerIdentity,
} from "./ledger.mjs";
import { redGenuine } from "./lib.mjs";
import { fail, MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { checkoutSnapshot } from "./snapshot.mjs";

const EXCERPT_LIMIT = 2000;

/** `stdd docs <decision> [paths…] [--reason <why>]` — record the docs decision. */
function recordDocs(cwd, decision, paths, reason) {
	if (!DOCS_DECISIONS.includes(decision)) {
		// Free text is the recurring mistake — answer with the exact forms
		// and, when a decision word is buried in the prose, the corrected call.
		const joined = [decision ?? "", ...paths].join(" ");
		const stem = /not[- ]applicable/i.test(joined)
			? "not-applicable"
			: /updated[- ]first/i.test(joined)
				? "updated-first"
				: /\bchecked\b/i.test(joined)
					? "checked"
					: null;
		fail(
			`unknown docs decision "${decision ?? ""}" — the decision is one word, then its arguments:\n` +
				"  stdd docs updated-first <paths…>\n" +
				"  stdd docs checked <paths…> --reason <why>\n" +
				"  stdd docs not-applicable --reason <why>" +
				(stem ? `\ndid you mean: stdd docs ${stem} …` : ""),
		);
	}
	if (reason !== null) {
		try {
			assertPrintableSingleLine(reason, "docs reason");
		} catch {
			fail("docs reason must be a non-empty single printable line without control characters");
		}
	}
	if (decision === "not-applicable") {
		if (paths.length > 0) {
			fail(
				"not-applicable takes no paths — put the why into --reason:\n" +
					'  stdd docs not-applicable --reason "<why implementation-only>"',
			);
		}
		if (!reason) fail("not-applicable needs --reason <why implementation-only>");
	} else if (paths.length === 0) {
		fail(`${decision} needs at least one docs path`);
	}
	if (decision === "checked" && !reason) {
		fail("checked needs --reason <why no change is needed>");
	}
	for (const docPath of paths) {
		try {
			resolveRepoPath(cwd, docPath, `docs path ${JSON.stringify(docPath)}`);
		} catch (err) {
			fail(err.message);
		}
	}
	const docsContext = ledgerAppendContext(cwd, { event: "docs" });
	const event = {
		event: "docs",
		decision,
		paths,
		snapshot: checkoutSnapshot(cwd),
		...(reason ? { reason } : {}),
		...(docsContext.task ? { taskId: docsContext.task.id } : {}),
	};
	try {
		withCapturedLedgerIdentity(
			cwd,
			{
				expectedBranch: docsContext.branch,
				expectedTaskState: docsContext.taskState,
				subject: "docs evidence",
				retry: "stdd docs",
			},
			() =>
				appendLedger(cwd, event, {
					preserveTaskScope: true,
					lockHeld: true,
					expectedBranch: docsContext.branch,
				}),
		);
	} catch (err) {
		fail(err.message);
	}
	console.log(`stdd docs: recorded ${decision}${paths.length ? ` (${paths.join(", ")})` : ""}`);
}

/**
 * `stdd red|verify -- <cmd>` — run the command, record {cmd, exit, excerpt}
 * verbatim, pass the exit code through. Output flows to the caller unchanged.
 */
function recordRun(cwd, kind, argv) {
	// A single whitespace-carrying word after -- is a description, not a
	// command — it can never spawn. Reject with the corrected form and
	// record nothing: prose in the ledger verifies nothing.
	if (argv.length === 1 && /\s/.test(argv[0])) {
		fail(
			`${kind} takes the command and its arguments, never prose — nothing was recorded\n` +
				`  e.g.:             stdd ${kind} -- pnpm --filter api test\n` +
				`  shell constructs: stdd ${kind} -- sh -c "<cmd>"`,
		);
	}
	// A recorder must know it can persist the result before it launches a
	// command with arbitrary side effects.
	const runContext = ledgerAppendContext(cwd, { event: kind });
	const config = loadConfig(cwd);
	const result = spawnSync(argv[0], argv.slice(1), {
		encoding: "utf8",
		maxBuffer: MAX_SUBPROCESS_BUFFER,
	});
	let exit = result.status ?? 1;
	let output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error) {
		exit = 127;
		output += `${result.error.message}\n`;
	}
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.error) {
		console.error(
			`stdd ${kind}: ${result.error.message}` +
				(result.error.code === "ENOENT"
					? " — command not found; is the worktree ready (stdd doctor --readiness)? " +
						"Shell constructs need sh -c"
					: ""),
		);
	}

	const event = {
		event: kind,
		cmd: argv.join(" "),
		exit,
		excerpt: output.slice(-EXCERPT_LIMIT),
		snapshot: checkoutSnapshot(cwd),
	};
	if (kind === "red") {
		event.genuine = redGenuine(exit, output, config.redPattern ?? null);
		if (exit === 0) {
			console.error('stdd red: the command exited 0 — that is green, not red (recorded genuine: "no")');
		} else if (event.genuine === "unknown") {
			console.error(
				'stdd red: no redPattern in .stdd/config.json — cannot assert genuine-red (recorded genuine: "unknown")',
			);
		} else if (event.genuine === "no") {
			console.error(
				'stdd red: output does not match redPattern — this looks like an environment error, not a genuine red (recorded genuine: "no")',
			);
		}
	}
	try {
		withCapturedLedgerIdentity(
			cwd,
			{
				expectedBranch: runContext.branch,
				expectedTaskState: runContext.taskState,
				subject: `${kind} result`,
				retry: `stdd ${kind}`,
			},
			() =>
				appendLedger(
					cwd,
					{
						...event,
						...(runContext.task ? { taskId: runContext.task.id } : {}),
					},
					{
						preserveTaskScope: true,
						lockHeld: true,
						expectedBranch: runContext.branch,
					},
				),
		);
	} catch (err) {
		fail(err.message);
	}
	process.exit(exit);
}

export { recordDocs, recordRun };
