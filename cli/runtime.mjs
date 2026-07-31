import { execFileSync } from "node:child_process";
import { resolveWritableRepoPath } from "../sdk/path.mjs";

export function fail(message) {
	console.error(`stdd: ${message}`);
	process.exit(1);
}

export function statePath(cwd, relative, label) {
	try {
		return resolveWritableRepoPath(cwd, relative, label);
	} catch (err) {
		fail(err.message);
	}
}

/** Run git in the working directory, returning trimmed stdout; throws on failure. */
export function git(...args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

// cap on a subprocess's captured stdout — large diffs, manifests, and
// command output must not truncate silently at execFile's small default
export const MAX_SUBPROCESS_BUFFER = 64 * 1024 * 1024;

// the first line of a subprocess error's stderr or message — the actual
// cause (ENOENT, permission, maxBuffer overflow), not a guessed diagnosis
export const subprocessError = (err) =>
	(err?.stderr?.toString().trim() || err?.message || "unknown error").split("\n")[0];
