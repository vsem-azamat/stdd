import { assertRepoRelativePath, assertSkillName } from "./path.mjs";
import { assertPrintableSingleLine } from "./text.mjs";

const SEMVER_PATTERN =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const CI_STAMP_PLACEHOLDER = "__STAMP__";
const CI_VERSION_PLACEHOLDER = "__VERSION__";
const CI_PLACEHOLDER_PATTERN = /__[A-Z][A-Z0-9_]*__/u;
export const CROSS_CLI_REVIEW_VIA_TOKEN = "{{STDD_CROSS_CLI_REVIEW_VIA}}";
const CROSS_CLI_REVIEW_VIAS = new Set(["claude", "codex"]);

const deepFreeze = (value) => {
	for (const child of Object.values(value)) {
		if (child && typeof child === "object") deepFreeze(child);
	}
	return Object.freeze(value);
};

export const MANDATORY_ROUTING_SKILLS = deepFreeze([
	"stdd-investigation",
	"stdd-brainstorming",
	"stdd-start-change",
	"stdd-implement",
	"stdd-finish-change",
]);

function requireString(value, field) {
	if (typeof value !== "string" || value === "") {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireCommentText(value, field) {
	const candidate = assertPrintableSingleLine(value, field);
	if (candidate.includes("-->")) {
		throw new TypeError(`${field} must not close an HTML comment`);
	}
	return candidate;
}

function requireInlineCode(value, field) {
	const candidate = assertPrintableSingleLine(value, field);
	if (candidate.includes("`")) {
		throw new TypeError(`${field} must not contain backticks`);
	}
	return candidate;
}

export function assertSemanticVersion(value, field) {
	const candidate = assertPrintableSingleLine(value, field);
	const match = SEMVER_PATTERN.exec(candidate);
	const hasZeroPaddedPrereleaseNumber = match?.[1]
		?.split(".")
		.some(
			(identifier) => identifier.length > 1 && identifier.startsWith("0") && /^\d+$/u.test(identifier),
		);
	if (!match || hasZeroPaddedPrereleaseNumber) {
		throw new TypeError(`${field} must be a semantic version`);
	}
	return candidate;
}

function requireRepoPath(value, field) {
	return assertRepoRelativePath(value, field);
}

function requirePrefix(value) {
	const prefix = assertPrintableSingleLine(value, "agent adapter explicitPrefix");
	if (/\s|`/u.test(prefix)) {
		throw new TypeError(
			"agent adapter explicitPrefix must not contain whitespace, controls, or backticks",
		);
	}
	return prefix;
}

export function defineAgentAdapter(adapter) {
	const crossCliReviewVia = adapter?.crossCliReviewVia ?? null;
	if (crossCliReviewVia !== null && !CROSS_CLI_REVIEW_VIAS.has(crossCliReviewVia)) {
		throw new TypeError('agent adapter crossCliReviewVia must be "claude", "codex", or null');
	}
	const copy = {
		id: assertSkillName(adapter?.id, "agent adapter id"),
		skillRoot: requireRepoPath(adapter?.skillRoot, "agent adapter skillRoot"),
		instructionsFile: requireRepoPath(adapter?.instructionsFile, "agent adapter instructionsFile"),
		snippetFile: requireRepoPath(adapter?.snippetFile, "agent adapter snippetFile"),
		explicitPrefix: requirePrefix(adapter?.explicitPrefix),
		hooksFile: requireRepoPath(adapter?.hooksFile, "agent adapter hooksFile"),
		crossCliReviewVia,
	};
	return deepFreeze(copy);
}

export function defineCiAdapter(adapter) {
	const id = assertSkillName(adapter?.id, "CI adapter id");
	const outputIsNull = adapter?.outputFile === null;
	const templateIsNull = adapter?.templateFile === null;
	if (outputIsNull !== templateIsNull) {
		throw new TypeError("CI adapter outputFile and templateFile must both be null or both be paths");
	}
	const copy = {
		id,
		outputFile: outputIsNull ? null : requireRepoPath(adapter?.outputFile, "CI adapter outputFile"),
		templateFile: templateIsNull
			? null
			: requireRepoPath(adapter?.templateFile, "CI adapter templateFile"),
	};
	return deepFreeze(copy);
}

export const AGENT_ADAPTERS = deepFreeze({
	claude: defineAgentAdapter({
		id: "claude",
		skillRoot: ".claude/skills",
		instructionsFile: "CLAUDE.md",
		snippetFile: ".stdd/CLAUDE-snippet.md",
		explicitPrefix: "/",
		hooksFile: ".claude/settings.json",
		crossCliReviewVia: "codex",
	}),
	codex: defineAgentAdapter({
		id: "codex",
		skillRoot: ".agents/skills",
		instructionsFile: "AGENTS.md",
		snippetFile: ".stdd/AGENTS-snippet.md",
		explicitPrefix: "$",
		hooksFile: ".codex/hooks.json",
		crossCliReviewVia: "claude",
	}),
	pi: defineAgentAdapter({
		id: "pi",
		skillRoot: ".agents/skills",
		instructionsFile: ".pi/APPEND_SYSTEM.md",
		snippetFile: ".stdd/PI-snippet.md",
		explicitPrefix: "/skill:",
		hooksFile: ".pi/extensions/stdd.js",
		crossCliReviewVia: "claude",
	}),
});

export const CI_ADAPTERS = deepFreeze({
	github: defineCiAdapter({
		id: "github",
		outputFile: ".github/workflows/stdd.yml",
		templateFile: "github-stdd.yml",
	}),
	gitlab: defineCiAdapter({
		id: "gitlab",
		outputFile: ".gitlab/stdd.gitlab-ci.yml",
		templateFile: "gitlab-stdd.yml",
	}),
	generic: defineCiAdapter({
		id: "generic",
		outputFile: null,
		templateFile: null,
	}),
});

export function getAgentAdapter(id) {
	if (!Object.hasOwn(AGENT_ADAPTERS, id)) {
		throw new Error(`unknown agent adapter ${JSON.stringify(id)}`);
	}
	return AGENT_ADAPTERS[id];
}

export function getCiAdapter(id) {
	if (!Object.hasOwn(CI_ADAPTERS, id)) {
		throw new Error(`unknown CI adapter ${JSON.stringify(id)}`);
	}
	return CI_ADAPTERS[id];
}

function resolveAgentAdapter(adapter) {
	return typeof adapter === "string" ? getAgentAdapter(adapter) : defineAgentAdapter(adapter);
}

export function renderAgentSkill({ adapter: adapterInput, name, description, when, body, stamp }) {
	const safeName = assertSkillName(name, "agent skill name");
	const safeDescription = assertPrintableSingleLine(description, "agent skill description");
	let safeBody = requireString(body, "agent skill body");
	const safeStamp = requireCommentText(stamp, "agent skill stamp");
	const safeWhen = when === undefined ? null : assertPrintableSingleLine(when, "agent skill when");
	const adapter = adapterInput === undefined ? null : resolveAgentAdapter(adapterInput);
	if (safeBody.includes(CROSS_CLI_REVIEW_VIA_TOKEN)) {
		if (!adapter?.crossCliReviewVia) {
			throw new TypeError(
				"agent skill adapter must define crossCliReviewVia to resolve the cross-CLI reviewer token",
			);
		}
		safeBody = safeBody.replaceAll(CROSS_CLI_REVIEW_VIA_TOKEN, adapter.crossCliReviewVia);
	}
	const routedDescription = safeWhen ? `${safeDescription}. Use when: ${safeWhen}` : safeDescription;
	return (
		`---\nname: ${safeName}\ndescription: ${JSON.stringify(routedDescription)}\n---\n\n` +
		`<!-- ${safeStamp} -->\n\n${safeBody}`
	);
}

export function renderAgentInstructions({
	adapter: adapterInput,
	stamp,
	npmRunner,
	crossCli,
	projectLogEnabled = true,
}) {
	const adapter = resolveAgentAdapter(adapterInput);
	const safeStamp = requireCommentText(stamp, "agent instructions stamp");
	const safeNpmRunner = requireInlineCode(npmRunner, "agent instructions npmRunner");
	if (typeof crossCli !== "boolean") {
		throw new TypeError("agent instructions crossCli must be a boolean");
	}
	if (typeof projectLogEnabled !== "boolean") {
		throw new TypeError("agent instructions projectLogEnabled must be a boolean");
	}
	const invoke = (name) => `\`${adapter.explicitPrefix}${name}\``;
	const [investigation, brainstorming, startChange, implement, finishChange] = MANDATORY_ROUTING_SKILLS;
	return [
		`<!-- ${safeStamp} -->`,
		"",
		"## STDD",
		"",
		"This repository follows `.stdd/method.md`. Route read-only current-state",
		`factual or diagnostic questions directly to Investigation with ${invoke(investigation)}.`,
		"Route opinions, future behavior, and hypothetical implementation approaches",
		`directly to Brainstorming with ${invoke(brainstorming)}.`,
		"",
		"Use Investigation → Brainstorming only when unknown current facts materially affect future design.",
		"Reading docs or code during Brainstorming does not by itself require Investigation.",
		"",
		"Start Change is the action boundary. Invoke it only after explicit intent to",
		`persist a work artifact or modify the repository, using ${invoke(startChange)}.`,
		"A hypothetical plan shown only in chat remains Brainstorming.",
		"",
		"Before any repository change (behavior, implementation-only work, fixes, or",
		`refactors), invoke ${invoke(startChange)}; use ${invoke(implement)} for the`,
		`docs/red/green/verify slice and ${invoke(finishChange)} to close it.`,
		"",
		...(projectLogEnabled
			? [
					"Do not search the project log (dated entries marked",
					"`authority: non-canonical`, e.g. `docs/project/`) unless the user",
					"explicitly asks for historical rationale or deferred work.",
				]
			: [
					"This repository does not use a project log. Do not create or search",
					"dated decision, design, or deferred-work archives. Keep current behavior",
					"in canonical docs; use PR descriptions and git history for rationale.",
				]),
		"",
		"If `stdd` is not on PATH, use the project-local runner",
		`(\`pnpm exec stdd\`, \`${safeNpmRunner}\`). Installed npm fallbacks must pin`,
		"the exact scoped `@stdd/cli` version. Never resolve the unrelated",
		"unscoped registry package `stdd`.",
		"",
		"Read project policy with `stdd policy show` before asking for a decision",
		"it may already answer. That view is the enforcing one: it lists only the",
		"grants this kit honors, each naming a condition to verify before acting.",
		"Reading `.stdd/policy.md` directly trusts whatever the file happens to say;",
		"there, only `## Permissions` entries ever grant authority.",
		...(crossCli
			? adapter.id === "pi"
				? [
						"",
						"Pi and Claude Code may invoke each other for a bounded, read-only",
						"review or delegated slice when the applicable skill requests it.",
					]
				: [
						"",
						"Claude Code and Codex may invoke each other for a bounded, read-only",
						"review or delegated slice when the applicable skill requests it.",
					]
			: []),
		"",
	].join("\n");
}

export function renderCiTemplate(template, { stamp, version }) {
	const safeTemplate = requireString(template, "CI template");
	const safeStamp = assertPrintableSingleLine(stamp, "CI stamp");
	const safeVersion = assertSemanticVersion(version, "CI version");
	if (!safeTemplate.includes(CI_STAMP_PLACEHOLDER) || !safeTemplate.includes(CI_VERSION_PLACEHOLDER)) {
		throw new TypeError("CI template must contain __STAMP__ and __VERSION__ placeholders");
	}
	const rendered = safeTemplate.replace(/__STAMP__|__VERSION__/gu, (placeholder) =>
		placeholder === CI_STAMP_PLACEHOLDER ? safeStamp : safeVersion,
	);
	if (CI_PLACEHOLDER_PATTERN.test(rendered)) {
		throw new TypeError("CI template contains an unresolved placeholder");
	}
	return rendered;
}
