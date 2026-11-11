import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export {
	DEFAULT_CONFIG,
	extractDocPaths,
	mergeConfig,
	parseLedger,
	parsePlan,
	sha256,
} from "../cli/lib.mjs";
export {
	AGENT_ADAPTERS,
	CLAUDE_INSTRUCTIONS_MODES,
	DEFAULT_CLAUDE_INSTRUCTIONS,
	defineAgentAdapter,
	getAgentAdapter,
	planInstructionFiles,
	renderAgentInstructions,
	renderAgentSkill,
} from "./adapters.mjs";
export { assertSkillName, resolveRepoPath, resolveWritableRepoPath } from "./path.mjs";
export { assertPrintableSingleLine, isPrintableSingleLine } from "./text.mjs";
export { deriveLoopState, deriveTaskState, scopeTaskEvents } from "./workflow.mjs";

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STDD_VERSION = JSON.parse(
	fs.readFileSync(path.join(SDK_ROOT, "package.json"), "utf8"),
).version;
