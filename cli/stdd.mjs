#!/usr/bin/env node
import path from "node:path";
import { check, doctor } from "./check.mjs";
import { ciCommand } from "./ci.mjs";
import { loadConfig } from "./config.mjs";
import { checkPr, evidence } from "./evidence.mjs";
import {
	KNOWN_CAPABILITIES,
	KNOWN_CI,
	KNOWN_TOOLS,
	VERSION,
	validateAdapterSelection,
} from "./generated-files.mjs";
import { configure, init, interview } from "./init.mjs";
import {
	appendLedger,
	defer,
	finishTask,
	REVIEW_VIAS,
	resetTask,
	resolveRepoDir,
	startTask,
} from "./ledger.mjs";
import { didYouMean } from "./lib.mjs";
import { recordDocs, recordRun } from "./recorders.mjs";
import { reviewCleanup, reviewRun, reviewSubmit } from "./review.mjs";
import { fail } from "./runtime.mjs";
import { scopeCheck, sliceNew } from "./scope.mjs";
import { status, statusGate, stopHookCmd } from "./status.mjs";
import { workerCollect, workerCreate } from "./worker.mjs";
import { readWorkerMetadata, WORKER_LOCAL_COMMANDS } from "./worker-metadata.mjs";

// --- argument parsing (strict: unknown flags are errors) ---
const [, , command, ...rest] = process.argv;

let commandWorker;
if (command !== "stop-hook") {
	try {
		commandWorker = readWorkerMetadata(process.cwd());
	} catch (err) {
		fail(err.message);
	}
}
if (
	commandWorker &&
	command &&
	(!WORKER_LOCAL_COMMANDS.has(command) ||
		(command === "doctor" && (rest.length !== 1 || rest[0] !== "--readiness")) ||
		(command === "status" && !rest.includes("--local")))
) {
	fail(
		`stdd ${command ?? "command"} is source-checkout-owned and unavailable in a managed gitless worker; ` +
			"run it from the bound source checkout",
	);
}

// Ledger commands parse their own arguments (`--` passthrough, repeated
// positionals) and exit here; the strict generic loop below never sees them.
if (command === "red" || command === "verify") {
	const sep = rest.indexOf("--");
	if (sep === -1 || sep === rest.length - 1) {
		fail(`${command} needs a command: stdd ${command} -- <cmd> [args…]`);
	}
	if (sep !== 0) fail(`unexpected argument before --: ${rest[0]}`);
	recordRun(resolveRepoDir(process.cwd()), command, rest.slice(sep + 1));
}
if (command === "task") {
	const subcommand = rest[0];
	const cwd = resolveRepoDir(process.cwd());
	if (subcommand === "start") {
		startTask(cwd, rest.slice(1).join(" "));
	} else if (subcommand === "finish") {
		if (rest.length > 1) fail(`unexpected argument: ${rest[1]}`);
		finishTask(cwd);
	} else if (subcommand === "reset") {
		resetTask(cwd, rest.slice(1).join(" ") || null);
	} else {
		fail(`unknown task subcommand "${subcommand ?? ""}" — use start, finish, or reset`);
	}
	process.exit(0);
}
if (command === "docs") {
	let reason = null;
	const words = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--reason" || arg.startsWith("--reason=")) {
			reason = arg.includes("=") ? arg.slice("--reason=".length) : (rest[++i] ?? "");
			if (!reason) fail("--reason requires a value");
		} else if (arg.startsWith("--")) {
			fail(`unknown flag: ${arg}`);
		} else {
			words.push(arg);
		}
	}
	recordDocs(resolveRepoDir(process.cwd()), words[0], words.slice(1), reason);
	process.exit(0);
}
if (command === "note") {
	const text = rest.join(" ").trim();
	if (!text) fail("note needs text: stdd note <text>");
	appendLedger(resolveRepoDir(process.cwd()), { event: "note", text });
	console.log("stdd note: recorded");
	process.exit(0);
}
if (command === "defer") {
	const text = rest.join(" ").trim();
	if (!text) fail("defer needs text: stdd defer <what is cut and why>");
	defer(resolveRepoDir(process.cwd()), text);
	process.exit(0);
}
function parseScopeFlags(args, startIndex) {
	let frozen = [];
	let allowed = [];
	for (let i = startIndex; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--frozen" || arg.startsWith("--frozen=")) {
			const value = arg.includes("=") ? arg.slice("--frozen=".length) : (args[++i] ?? "");
			frozen = value.split(",").filter(Boolean);
			if (frozen.length === 0) fail("--frozen requires globs, e.g. --frozen docs/**");
		} else if (arg === "--allowed" || arg.startsWith("--allowed=")) {
			const value = arg.includes("=") ? arg.slice("--allowed=".length) : (args[++i] ?? "");
			allowed = value.split(",").filter(Boolean);
			if (allowed.length === 0) fail("--allowed requires globs, e.g. --allowed src/**");
		} else {
			fail(`unexpected argument: ${arg}`);
		}
	}
	return { frozen, allowed };
}

if (command === "worker") {
	const subcommand = rest[0];
	if (subcommand !== "create" && subcommand !== "collect") {
		fail(`unknown worker subcommand "${subcommand ?? ""}" — use create or collect`);
	}
	const directory = rest[1];
	if (!directory || directory.startsWith("--")) {
		fail(`worker ${subcommand} needs a directory`);
	}
	if (subcommand === "collect") {
		if (rest.length > 2) fail(`unexpected argument: ${rest[2]}`);
		workerCollect(resolveRepoDir(process.cwd()), directory);
		process.exit(0);
	}
	const { frozen, allowed } = parseScopeFlags(rest, 2);
	workerCreate(resolveRepoDir(process.cwd()), directory, frozen, allowed);
	process.exit(0);
}
if (command === "slice") {
	if (rest[0] !== "new") {
		fail(`unknown slice subcommand "${rest[0] ?? ""}" — use "stdd slice new"`);
	}
	const { frozen, allowed } = parseScopeFlags(rest, 1);
	sliceNew(resolveRepoDir(process.cwd()), frozen, allowed);
	process.exit(0);
}
if (command === "scope") {
	if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
	scopeCheck(resolveRepoDir(process.cwd()));
	process.exit(0);
}
if (command === "stop-hook") {
	let agent = "claude";
	if (rest.length > 0) {
		if (rest[0] !== "--agent" || !rest[1] || rest.length > 2) {
			fail(`stop-hook accepts only --agent claude|codex`);
		}
		agent = rest[1];
		if (agent !== "claude" && agent !== "codex") fail(`unknown hook agent "${agent}"`);
	}
	// raw cwd: the command resolves the repo itself, softly — a hook must
	// fail open even outside a usable worktree
	stopHookCmd(process.cwd(), agent);
}
if (command === "status") {
	const unknown = rest.filter((a) => a !== "--json" && a !== "--gate" && a !== "--local");
	if (unknown.length > 0) fail(`unexpected argument: ${unknown[0]}`);
	if (rest.includes("--gate")) statusGate(resolveRepoDir(process.cwd()));
	status(resolveRepoDir(process.cwd()), rest.includes("--json"), rest.includes("--local"));
	process.exit(0);
}
if (command === "review") {
	let via = null;
	let timeout = 600;
	let timeoutSpecified = false;
	let result = null;
	let force = false;
	let cleanup = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--force") {
			force = true;
		} else if (arg === "--cleanup") {
			cleanup = true;
		} else if (arg === "--via" || arg.startsWith("--via=")) {
			via = arg.includes("=") ? arg.slice("--via=".length) : (rest[++i] ?? "");
			if (!via) fail(`--via requires a value (${REVIEW_VIAS.join(", ")})`);
		} else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
			const value = arg.includes("=") ? arg.slice("--timeout=".length) : (rest[++i] ?? "");
			timeoutSpecified = true;
			timeout = Number(value);
			// integer seconds, bounded: spawnSync needs a sane uint32 of
			// milliseconds, and a parse-time failure must precede any side
			// effect (request event, brief file)
			if (!/^\d+$/.test(value) || !Number.isInteger(timeout) || timeout < 1 || timeout > 86_400)
				fail("--timeout requires whole seconds between 1 and 86400, e.g. --timeout 600");
		} else if (arg === "--result" || arg.startsWith("--result=")) {
			result = arg.includes("=") ? arg.slice("--result=".length) : (rest[++i] ?? "");
			if (!result) fail("--result requires a file path or - for stdin");
		} else {
			fail(`unexpected argument: ${arg}`);
		}
	}
	const cwd = resolveRepoDir(process.cwd());
	if (cleanup) {
		if (result !== null || via !== null || timeoutSpecified || force) {
			fail("--cleanup cancels open review requests and cannot be combined with dispatch flags");
		}
		process.exit(reviewCleanup(cwd) ? 0 : 1);
	} else if (result !== null) {
		if (via !== null) fail("--result grades an existing request — --via belongs to the dispatch call");
		if (timeoutSpecified || force) {
			fail("--result grades an existing request — --timeout and --force belong to the dispatch call");
		}
		reviewSubmit(cwd, loadConfig(cwd), result);
	} else {
		reviewRun(cwd, via, timeout, force);
	}
	process.exit(0);
}
let tools = null;
let ci = null;
let baseRefArg = null;
let prArg = null;
let readinessOnly = false;
let hooksFlag = false;
let capabilitiesArg = null;
let sessionHookFlag = false;
let stopHookFlag = false;
let reviewViaArg = null;
let maxRoundsArg = null;
let interviewFlag = false;
let watchFlag = false;
let intervalArg = 15;
let timeoutArg = 1800;
const positional = [];
for (let i = 0; i < rest.length; i++) {
	const arg = rest[i];
	if (arg === "--base" || arg.startsWith("--base=")) {
		if (command !== "check-pr" && command !== "evidence") {
			fail(`--base is only valid for "stdd check-pr" and "stdd evidence"`);
		}
		baseRefArg = arg.includes("=") ? arg.slice("--base=".length) : (rest[++i] ?? "");
		if (!baseRefArg) fail("--base requires a git ref, e.g. --base origin/main");
	} else if (arg === "--hooks") {
		if (command !== "init") fail(`--hooks is only valid for "stdd init"`);
		hooksFlag = true;
	} else if (arg === "--session-hook") {
		if (command !== "init") fail(`--session-hook is only valid for "stdd init"`);
		sessionHookFlag = true;
	} else if (arg === "--stop-hook") {
		if (command !== "init" && command !== "configure") {
			fail(`--stop-hook is only valid for "stdd init" and "stdd configure"`);
		}
		stopHookFlag = true;
	} else if (arg === "--review-via" || arg.startsWith("--review-via=")) {
		if (command !== "configure") fail(`--review-via is only valid for "stdd configure"`);
		reviewViaArg = arg.includes("=") ? arg.slice("--review-via=".length) : (rest[++i] ?? "");
		if (!REVIEW_VIAS.includes(reviewViaArg)) {
			fail(`--review-via must be one of: ${REVIEW_VIAS.join(", ")}`);
		}
	} else if (arg === "--max-rounds" || arg.startsWith("--max-rounds=")) {
		if (command !== "configure") fail(`--max-rounds is only valid for "stdd configure"`);
		const value = arg.includes("=") ? arg.slice("--max-rounds=".length) : (rest[++i] ?? "");
		maxRoundsArg = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(maxRoundsArg)) {
			fail("--max-rounds requires a non-negative safe integer (0 = unlimited)");
		}
	} else if (arg === "--interview") {
		if (command !== "init") fail(`--interview is only valid for "stdd init"`);
		interviewFlag = true;
	} else if (arg === "--capabilities" || arg.startsWith("--capabilities=")) {
		if (command !== "init" && command !== "configure") {
			fail(`--capabilities is only valid for "stdd init" and "stdd configure"`);
		}
		const value = arg.includes("=") ? arg.slice("--capabilities=".length) : (rest[++i] ?? "");
		capabilitiesArg = value.split(",").filter(Boolean);
		if (capabilitiesArg.length === 0) {
			fail("--capabilities requires a value, e.g. --capabilities subagents,worktrees");
		}
		const unknown = capabilitiesArg.filter((c) => !KNOWN_CAPABILITIES.includes(c));
		if (unknown.length > 0) {
			fail(`unknown capability(ies): ${unknown.join(", ")} (known: ${KNOWN_CAPABILITIES.join(", ")})`);
		}
	} else if (arg === "--readiness") {
		if (command !== "doctor") fail(`--readiness is only valid for "stdd doctor"`);
		readinessOnly = true;
	} else if (arg === "--watch") {
		if (command !== "ci") fail(`--watch is only valid for "stdd ci"`);
		watchFlag = true;
	} else if (arg === "--interval" || arg.startsWith("--interval=")) {
		if (command !== "ci") fail(`--interval is only valid for "stdd ci"`);
		const value = arg.includes("=") ? arg.slice("--interval=".length) : (rest[++i] ?? "");
		intervalArg = Number(value);
		if (!Number.isFinite(intervalArg) || intervalArg < 0) {
			fail("--interval requires seconds, e.g. --interval 15");
		}
	} else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
		if (command !== "ci") fail(`--timeout is only valid for "stdd ci"`);
		const value = arg.includes("=") ? arg.slice("--timeout=".length) : (rest[++i] ?? "");
		timeoutArg = Number(value);
		if (!Number.isFinite(timeoutArg) || timeoutArg < 0) {
			fail("--timeout requires seconds, e.g. --timeout 1800");
		}
	} else if (arg === "--pr" || arg.startsWith("--pr=")) {
		if (command !== "check-pr") fail(`--pr is only valid for "stdd check-pr"`);
		prArg = arg.includes("=") ? arg.slice("--pr=".length) : (rest[++i] ?? "");
		if (!prArg) fail("--pr requires a PR number, or . for the current branch's PR");
	} else if (arg === "--ci" || arg.startsWith("--ci=")) {
		if (command !== "init") fail(`--ci is only valid for "stdd init"`);
		const value = arg.includes("=") ? arg.slice("--ci=".length) : (rest[++i] ?? "");
		ci = value.split(",").filter(Boolean);
		if (ci.length === 0) fail("--ci requires a value, e.g. --ci github");
		const unknown = ci.filter((c) => !KNOWN_CI.includes(c));
		if (unknown.length > 0) {
			fail(`unknown ci provider(s): ${unknown.join(", ")} (known: ${KNOWN_CI.join(", ")})`);
		}
		try {
			ci = validateAdapterSelection("ci", ci, KNOWN_CI);
		} catch (err) {
			fail(`--ci ${err.message.replace(/^ci /, "")}`);
		}
	} else if (arg === "--tools" || arg.startsWith("--tools=")) {
		if (command !== "init") fail(`--tools is only valid for "stdd init"`);
		const value = arg.includes("=") ? arg.slice("--tools=".length) : (rest[++i] ?? "");
		tools = value.split(",").filter(Boolean);
		if (tools.length === 0) fail("--tools requires a value, e.g. --tools claude,codex,pi");
		const unknown = tools.filter((t) => !KNOWN_TOOLS.includes(t));
		if (unknown.length > 0) {
			fail(`unknown tool(s): ${unknown.join(", ")} (known: ${KNOWN_TOOLS.join(", ")})`);
		}
		try {
			tools = validateAdapterSelection("tools", tools, KNOWN_TOOLS, {
				nonEmpty: true,
			});
		} catch (err) {
			fail(`--tools ${err.message.replace(/^tools /, "")}`);
		}
	} else if (arg.startsWith("--")) {
		fail(`unknown flag: ${arg}`);
	} else {
		positional.push(arg);
	}
}
if (positional.length > 1) fail(`unexpected argument: ${positional[1]}`);
const targetDir = path.resolve(positional[0] ?? ".");

switch (command) {
	case "init": {
		if (
			interviewFlag &&
			(tools || ci || capabilitiesArg || hooksFlag || sessionHookFlag || stopHookFlag)
		) {
			fail("--interview replaces the other init flags — drop them and answer the questions instead");
		}
		const opts = interviewFlag
			? await interview()
			: {
					tools: tools ?? KNOWN_TOOLS,
					ci: ci ?? [],
					hooks: hooksFlag,
					sessionHook: sessionHookFlag,
					stopHook: stopHookFlag,
					capabilitiesList: capabilitiesArg,
				};
		init(targetDir, opts);
		break;
	}
	case "configure":
		await configure(targetDir, {
			capabilitiesList: capabilitiesArg,
			reviewVia: reviewViaArg,
			maxRounds: maxRoundsArg,
			stopHook: stopHookFlag,
		});
		break;
	case "check":
		check(targetDir);
		break;
	case "doctor":
		doctor(targetDir, readinessOnly);
		break;
	case "check-pr":
		checkPr(positional[0], baseRefArg, prArg);
		break;
	case "evidence":
		// Without an explicit dir, evidence anchors to the repo like the
		// recorders — its config and ledger live at the root .stdd/.
		evidence(positional[0] ? targetDir : resolveRepoDir(process.cwd()), baseRefArg);
		break;
	case "ci":
		await ciCommand(positional[0] ?? null, watchFlag, intervalArg, timeoutArg);
		break;
	case "--version":
	case "version":
		console.log(VERSION);
		break;
	default: {
		if (command) {
			const guess = didYouMean(command, [
				"init",
				"configure",
				"check",
				"check-pr",
				"evidence",
				"doctor",
				"status",
				"task",
				"docs",
				"red",
				"verify",
				"note",
				"defer",
				"slice",
				"worker",
				"scope",
				"review",
				"ci",
				"version",
			]);
			console.error(`stdd: unknown command "${command}"${guess ? ` — did you mean "${guess}"?` : ""}`);
		}
		console.log(
			"Usage: stdd <init|configure|check|check-pr|evidence|doctor|task|status|ci|docs|red|verify|note|defer|slice|worker|scope|review|stop-hook> " +
				"[dir|pr-body-file|pr] [--tools claude,codex,pi] [--ci github,gitlab,generic] [--hooks] " +
				"[--session-hook] [--interview] [--base <ref>] " +
				"[--pr <n|.>] [--watch] [--readiness] [--json] [--gate] [--local] [--reason <why>] " +
				"[--capabilities <list>] [--via subagent|codex|claude] [--review-via <route>] " +
				"[--max-rounds <n>] [--stop-hook] [--cleanup] [--force] [--result <file|->] " +
				"[--frozen <globs>] [--allowed <globs>] [--interval <s>] [--timeout <s>] [-- <cmd>]",
		);
		process.exit(command ? 1 : 0);
	}
}
