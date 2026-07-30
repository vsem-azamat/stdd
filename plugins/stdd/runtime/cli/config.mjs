// The repository's stdd configuration. Lower state modules read it through
// this owner so they never import the entry module.
import fs from "node:fs";
import { resolveWritableRepoPath } from "../sdk/path.mjs";
import { DEFAULT_CONFIG, mergeConfig } from "./lib.mjs";
import { fail } from "./runtime.mjs";

export function loadConfig(targetDir) {
	let configPath;
	try {
		configPath = resolveWritableRepoPath(targetDir, ".stdd/config.json", "config path");
	} catch (err) {
		fail(err.message);
	}
	if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (err) {
		fail(`.stdd/config.json is not valid JSON: ${err.message}`);
	}
	try {
		return mergeConfig(parsed);
	} catch (err) {
		fail(`.stdd/config.json: ${err.message}`);
	}
}
