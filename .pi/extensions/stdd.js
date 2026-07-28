// STDD managed Pi lifecycle extension v1 {"sessionHook":true,"stopHook":true,"runner":"node \"$(git rev-parse --show-toplevel)/cli/stdd.mjs\""}
import { execFile } from "node:child_process";

const runner = "node \"$(git rev-parse --show-toplevel)/cli/stdd.mjs\"";

function runStdd(ctx, args) {
	return new Promise((resolve) => {
		const child = execFile("/bin/sh", ["-c", runner + " " + args], {
			cwd: ctx.cwd,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		}, (error, stdout, stderr) => {
			const exitCode = error
				? (typeof error.code === "number" ? error.code : null)
				: 0;
			resolve({ exitCode, stdout, stderr });
		});
		child.stdin?.end();
	});
}

export default function stddLifecycle(pi) {
	const restore = async (_event, ctx) => {
		const result = await runStdd(ctx, "status --local");
		if (result.exitCode !== 0 || result.stdout.trim() === "") return;
		pi.sendMessage({
			customType: "stdd-status",
			content: result.stdout,
			display: false,
		}, { deliverAs: "nextTurn" });
	};
	pi.on("session_start", restore);
	pi.on("session_compact", restore);

	let skipNextGate = false;
	pi.on("agent_settled", async (_event, ctx) => {
		if (skipNextGate) {
			skipNextGate = false;
			return;
		}
		const result = await runStdd(ctx, "stop-hook");
		if (result.exitCode !== 2 || result.stderr.trim() === "") return;
		skipNextGate = true;
		pi.sendMessage({
			customType: "stdd-stop-gate",
			content: result.stderr,
			display: true,
		}, { deliverAs: "followUp", triggerTurn: true });
	});
}
