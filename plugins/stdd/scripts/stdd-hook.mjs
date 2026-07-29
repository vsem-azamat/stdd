#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdoptingRoot } from "./adopting-root.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_RUNTIME_FAILURE =
	"stdd plugin: bundled runtime failed — update the STDD plugin or re-run `stdd init`\n";

const mode = process.argv[2];
if (mode !== "session" && mode !== "stop" && mode !== "stop-claude") process.exit(0);

let stopOutput = null;
let exitCode = 0;
try {
	const root = resolveAdoptingRoot(process.cwd());
	const cli = path.join(PLUGIN_ROOT, "runtime", "cli", "stdd.mjs");
	if (root && fs.existsSync(cli)) {
		const input = mode === "session" ? undefined : fs.readFileSync(0);
		const args =
			mode === "session"
				? ["status", "--local"]
				: ["stop-hook", "--agent", mode === "stop" ? "codex" : "claude"];
		const run = spawnSync(process.execPath, [cli, ...args], {
			cwd: root,
			encoding: "utf8",
			input,
			timeout: 9000,
		});
		if (!run.error && run.status === 0) {
			if (mode === "session") {
				if (run.stdout) process.stdout.write(run.stdout);
				if (run.stderr) process.stderr.write(run.stderr);
			} else if (mode === "stop") {
				const text = run.stdout.trim();
				if (text !== "") {
					try {
						const parsed = JSON.parse(text);
						const object = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
						const keys = object ? Object.keys(parsed) : [];
						const valid =
							object &&
							(keys.length === 0 ||
								(keys.length === 2 &&
									keys.includes("decision") &&
									keys.includes("reason") &&
									parsed.decision === "block" &&
									typeof parsed.reason === "string" &&
									parsed.reason.trim().length > 0));
						if (valid) stopOutput = JSON.stringify(parsed);
					} catch {
						// Malformed child output is an internal failure: allow Stop.
					}
				}
			}
		} else if (mode === "session") {
			process.stderr.write(SESSION_RUNTIME_FAILURE);
		} else if (mode === "stop-claude" && !run.error && run.status === 2 && run.stderr.trim() !== "") {
			process.stderr.write(run.stderr);
			exitCode = 2;
		}
	}
} catch {
	// A lifecycle integration must never trap or abort the host agent.
}

// Lifecycle helpers fail open. Codex Stop always receives valid JSON:
// a verified block object, or {} to allow the turn to end.
if (mode === "stop") console.log(stopOutput ?? "{}");
process.exit(exitCode);
