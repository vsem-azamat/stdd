import fs from "node:fs";
import path from "node:path";
import { assertPrintableSingleLine } from "./text.mjs";

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
 * Validate a slash-normalized repository-relative path at the shared
 * printable-text boundary before applying lexical containment rules.
 */
export function assertRepoRelativePath(relative, label = "path") {
	const candidate = assertPrintableSingleLine(relative, label);
	if (candidate.includes("\\") || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
		throw new Error(`${label} must be a safe repository-relative path: ${JSON.stringify(candidate)}`);
	}
	const segments = candidate.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`${label} must be a safe repository-relative path: ${JSON.stringify(candidate)}`);
	}
	return candidate;
}

/**
 * Resolve a validated repository-relative path below the supplied root.
 */
export function resolveRepoPath(root, relative, label = "path") {
	const candidate = assertRepoRelativePath(relative, label);
	const segments = candidate.split("/");
	const absoluteRoot = path.resolve(root);
	const target = path.resolve(absoluteRoot, ...segments);
	const fromRoot = path.relative(absoluteRoot, target);
	if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
		throw new Error(`${label} must be a safe repository-relative path: ${JSON.stringify(candidate)}`);
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
		let observed;
		try {
			observed = fs.lstatSync(cursor);
		} catch (err) {
			if (err.code === "ENOENT") continue;
			throw err;
		}
		if (observed.isSymbolicLink()) {
			throw new Error(`${label} crosses a symlink and is unsafe to write: ${JSON.stringify(relative)}`);
		}
	}
	return target;
}
