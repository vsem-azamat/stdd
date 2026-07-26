import fs from "node:fs";
import path from "node:path";

function writePreload(dir, name, lines) {
	const preload = path.join(dir, name);
	fs.writeFileSync(preload, lines.join("\n"));
	return { ...process.env, NODE_OPTIONS: `--import=${preload}` };
}

export function switchTaskWhenFileOpens({ cli, dir, trigger }) {
	return writePreload(dir, "switch-task-on-open.mjs", [
		'import fs from "node:fs";',
		'import { spawnSync } from "node:child_process";',
		`const cli = ${JSON.stringify(cli)};`,
		`const cwd = ${JSON.stringify(dir)};`,
		`const trigger = ${JSON.stringify(trigger)};`,
		"const originalOpenSync = fs.openSync;",
		"const readOnlyMask = fs.constants.O_WRONLY | fs.constants.O_RDWR;",
		"let switched = false;",
		"fs.openSync = function (target, flags, ...args) {",
		'  const readOnly = flags === "r" || (Number.isInteger(flags) && (flags & readOnlyMask) === fs.constants.O_RDONLY);',
		"  if (!switched && String(target) === trigger && readOnly) {",
		"    switched = true;",
		"    const env = { ...process.env };",
		"    delete env.NODE_OPTIONS;",
		'    for (const command of [["task", "finish"], ["task", "start", "task B"]]) {',
		'      const result = spawnSync(process.execPath, [cli, ...command], { cwd, env, encoding: "utf8" });',
		"      if (result.status !== 0) throw new Error(result.stdout + result.stderr);",
		"    }",
		"  }",
		"  return originalOpenSync.call(this, target, flags, ...args);",
		"};",
	]);
}

export function switchBranchWhenFileOpens({ dir, trigger }) {
	return writePreload(dir, "switch-branch-on-open.mjs", [
		'import fs from "node:fs";',
		'import { spawnSync } from "node:child_process";',
		`const cwd = ${JSON.stringify(dir)};`,
		`const trigger = ${JSON.stringify(trigger)};`,
		"const originalOpenSync = fs.openSync;",
		"const readOnlyMask = fs.constants.O_WRONLY | fs.constants.O_RDWR;",
		"let switched = false;",
		"fs.openSync = function (target, flags, ...args) {",
		'  const readOnly = flags === "r" || (Number.isInteger(flags) && (flags & readOnlyMask) === fs.constants.O_RDONLY);',
		"  if (!switched && String(target) === trigger && readOnly) {",
		"    switched = true;",
		'    const result = spawnSync("git", ["-C", cwd, "checkout", "-qb", "race-branch"], { encoding: "utf8" });',
		"    if (result.status !== 0) throw new Error(result.stdout + result.stderr);",
		"  }",
		"  return originalOpenSync.call(this, target, flags, ...args);",
		"};",
	]);
}
