import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function enclosingGitMarkerRoot(start) {
	let candidate = path.resolve(start);
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

export function resolveAdoptingRoot(cwd) {
	const start = path.resolve(cwd);
	const gitMarkerRoot = enclosingGitMarkerRoot(start);
	const top = spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	const gitRootResolved = !top.error && top.status === 0;
	if (gitRootResolved) {
		const candidate = top.stdout.trim();
		const markerMatches =
			!gitMarkerRoot || path.resolve(gitMarkerRoot) === path.resolve(candidate || ".");
		return candidate && markerMatches && fs.existsSync(path.join(candidate, ".stdd")) ? candidate : null;
	}
	if (gitMarkerRoot) return null;

	let candidate = start;
	while (true) {
		if (fs.existsSync(path.join(candidate, ".stdd"))) return candidate;
		const parent = path.dirname(candidate);
		if (parent === candidate) return null;
		candidate = parent;
	}
}
