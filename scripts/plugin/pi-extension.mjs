import { execFile } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAdoptingRoot } from "../scripts/adopting-root.mjs";

const RUNTIME = fileURLToPath(new URL("../runtime/cli/stdd.mjs", import.meta.url));
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SESSION_RUNTIME_FAILURE =
	"STDD bundled runtime failed. Update the STDD plugin or re-run `stdd init`.";

function exec(command, args, cwd) {
	return new Promise((resolve) => {
		const child = execFile(
			command,
			args,
			{
				cwd,
				encoding: "utf8",
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
			},
			(error, stdout, stderr) => {
				const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
				resolve({ exitCode, stdout, stderr });
			},
		);
		child.stdin?.end();
	});
}

async function runStdd(cwd, args) {
	const root = resolveAdoptingRoot(cwd);
	if (!root || !fs.existsSync(RUNTIME)) return null;
	return exec(process.execPath, [RUNTIME, ...args], root);
}

export default function stddPlugin(pi) {
	const restore = async (_event, ctx) => {
		const result = await runStdd(ctx.cwd, ["status", "--local"]);
		if (!result) return;
		if (result.exitCode !== 0) {
			if (ctx.hasUI) ctx.ui.notify(SESSION_RUNTIME_FAILURE, "warning");
			return;
		}
		if (result.stdout.trim() === "") return;
		pi.sendMessage(
			{
				customType: "stdd-status",
				content: result.stdout,
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
	};
	pi.on("session_start", restore);
	pi.on("session_compact", restore);

	let skipNextGate = false;
	pi.on("agent_settled", async (_event, ctx) => {
		if (skipNextGate) {
			skipNextGate = false;
			return;
		}
		const result = await runStdd(ctx.cwd, ["stop-hook"]);
		if (result?.exitCode !== 2 || result.stderr.trim() === "") return;
		skipNextGate = true;
		pi.sendMessage(
			{
				customType: "stdd-stop-gate",
				content: result.stderr,
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
