import fs from "node:fs";
import path from "node:path";

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Validate the directory name used by agent skill adapters. */
export function assertSkillName(name, label = "playbook name") {
	if (typeof name !== "string" || !SAFE_SKILL_NAME.test(name)) {
		throw new Error(
			`${label} must be a safe lowercase skill name matching ${SAFE_SKILL_NAME}, got ${JSON.stringify(name)}`,
		);
	}
	return name;
}

/**
 * Resolve a slash-normalized repository path without allowing absolute paths,
 * traversal, control bytes, or Windows separator ambiguity.
 */
export function resolveRepoPath(root, relative, label = "path") {
	if (
		typeof relative !== "string" ||
		relative === "" ||
		relative.includes("\\") ||
		[...relative].some((c) => c.charCodeAt(0) < 0x20) ||
		path.posix.isAbsolute(relative) ||
		path.win32.isAbsolute(relative)
	) {
		throw new Error(`${label} must be a safe repository-relative path: ${JSON.stringify(relative)}`);
	}
	const segments = relative.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`${label} must be a safe repository-relative path: ${JSON.stringify(relative)}`);
	}
	const absoluteRoot = path.resolve(root);
	const target = path.resolve(absoluteRoot, ...segments);
	const fromRoot = path.relative(absoluteRoot, target);
	if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
		throw new Error(`${label} must be a safe repository-relative path: ${JSON.stringify(relative)}`);
	}
	return target;
}

/**
 * The write/delete variant also rejects an existing symlink anywhere below
 * the repository root, so lexical containment cannot be redirected outside.
 */
export function resolveWritableRepoPath(root, relative, label = "path") {
	const absoluteRoot = path.resolve(root);
	const target = resolveRepoPath(absoluteRoot, relative, label);
	let cursor = absoluteRoot;
	for (const segment of path.relative(absoluteRoot, target).split(path.sep)) {
		if (!segment) continue;
		cursor = path.join(cursor, segment);
		if (!fs.existsSync(cursor)) continue;
		if (fs.lstatSync(cursor).isSymbolicLink()) {
			throw new Error(`${label} crosses a symlink and is unsafe to write: ${JSON.stringify(relative)}`);
		}
	}
	return target;
}
