#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_RUNTIME_FAILURE =
	"stdd plugin: bundled runtime failed — update the STDD plugin or re-run `stdd init`\n";

const mode = process.argv[2];
if (mode !== "session" && mode !== "stop") process.exit(0);

function enclosingGitMarkerRoot(start) {
	let candidate = start;
	while (true) {
		try {
			fs.lstatSync(path.join(candidate, ".git"));
			return candidate;
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return candidate;
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) return null;
		candidate = parent;
	}
}

let stopOutput = null;
try {
	let root = null;
	const gitMarkerRoot = enclosingGitMarkerRoot(process.cwd());
	const top = spawnSync("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	const gitRootResolved = !top.error && top.status === 0;
	if (gitRootResolved) {
		const candidate = top.stdout.trim();
		const markerMatches =
			!gitMarkerRoot || path.resolve(gitMarkerRoot) === path.resolve(candidate || ".");
		if (candidate && markerMatches && fs.existsSync(path.join(candidate, ".stdd"))) root = candidate;
	}
	if (!gitRootResolved && !gitMarkerRoot) {
		let candidate = process.cwd();
		while (path.dirname(candidate) !== candidate && !fs.existsSync(path.join(candidate, ".stdd"))) {
			candidate = path.dirname(candidate);
		}
		if (fs.existsSync(path.join(candidate, ".stdd"))) root = candidate;
	}

	const cli = path.join(PLUGIN_ROOT, "runtime", "cli", "stdd.mjs");
	if (root && fs.existsSync(cli)) {
		const input = mode === "stop" ? fs.readFileSync(0) : undefined;
		const run = spawnSync(
			process.execPath,
			[cli, ...(mode === "session" ? ["status", "--local"] : ["stop-hook", "--agent", "codex"])],
			{
				cwd: root,
				encoding: "utf8",
				input,
				timeout: 9000,
			},
		);
		if (!run.error && run.status === 0) {
			if (mode === "session") {
				if (run.stdout) process.stdout.write(run.stdout);
				if (run.stderr) process.stderr.write(run.stderr);
			} else {
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
		}
	}
} catch {
	// A lifecycle integration must never trap or abort the host agent.
}

// Lifecycle helpers fail open. Codex Stop always receives valid JSON:
// a verified block object, or {} to allow the turn to end.
if (mode === "stop") console.log(stopOutput ?? "{}");
process.exit(0);
