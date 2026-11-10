// Checkout docs/run recorders; intentionally independent of the CLI entry module.

import { spawn } from "node:child_process";
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
export function recordDocs(cwd, decision, paths, reason) {
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
 * Run the command with captured output, resolving to a spawnSync-shaped
 * result. Asynchronous so the caller's signal handlers can fire while the
 * child runs; `onChild` hands the caller the process to forward a signal to.
 */
function runCommand(argv, onChild, spawnCwd) {
	return new Promise((resolve) => {
		const stdout = [];
		const stderr = [];
		let captured = 0;
		let error = null;
		let settled = false;
		const settle = (status, signal) => {
			if (settled) return;
			settled = true;
			resolve({
				status,
				signal,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				error,
			});
		};
		let child;
		try {
			child = spawn(argv[0], argv.slice(1), {
				stdio: ["ignore", "pipe", "pipe"],
				...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
			});
		} catch (err) {
			error = err;
			settle(null, null);
			return;
		}
		const collect = (sink) => (chunk) => {
			captured += chunk.length;
			if (captured > MAX_SUBPROCESS_BUFFER) {
				error ??= new Error("stdout/stderr maxBuffer length exceeded");
				child.kill();
				return;
			}
			sink.push(chunk);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.on("error", (err) => {
			error = err;
			settle(null, null);
		});
		child.on("close", (status, signal) => settle(status, signal));
		onChild?.(child);
	});
}

/**
 * `stdd red|verify -- <cmd>` — run the command, record {cmd, exit, excerpt}
 * verbatim, pass the exit code through. Output flows to the caller unchanged.
 * With `exitProcess: false` the exit code is returned instead, so another
 * command (the review preflight) can record a run the same way and go on;
 * `spawnCwd` runs the command somewhere other than the process cwd.
 * `wrap` runs the command inside a caller-owned bracket (`stdd red
 * --without-impl` strips and restores the tree around it) and returns
 * `{ result, fields }`; the fields are recorded on the event.
 */
export async function recordRun(
	cwd,
	kind,
	argv,
	{
		exitProcess = true,
		spawnCwd = undefined,
		wrap = async (run) => ({ result: await run(), fields: {} }),
	} = {},
) {
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
	const { result, fields } = await wrap((onChild) => runCommand(argv, onChild, spawnCwd));
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
		...fields,
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
	if (!exitProcess) return exit;
	process.exit(exit);
}
