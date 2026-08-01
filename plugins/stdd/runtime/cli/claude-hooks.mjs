import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentAdapter } from "../sdk/adapters.mjs";
import { resolveWritableRepoPath } from "../sdk/path.mjs";
import { publishNativeRepoFile, readOptionalNativeRepoFile } from "./held-fs.mjs";

const CLAUDE_HOOKS_FILE = getAgentAdapter("claude").hooksFile;
const CODEX_HOOKS_FILE = getAgentAdapter("codex").hooksFile;
const PI_HOOKS_FILE = getAgentAdapter("pi").hooksFile;
const PI_LIFECYCLE_MARKER = "STDD managed Pi lifecycle extension v1";
const LEGACY_STATUS_COMMANDS = [
	"npx --no stdd status || true",
	"npm exec --offline -- stdd status || true",
	"npm exec --offline -- stdd status --local || true",
];
const GENERATED_STATUS_COMMAND_PATTERN =
	/^npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? -- stdd status(?: --local)? \|\| true$/;
const SOURCE_CHECKOUT_RUNNER = 'node "$(git rev-parse --show-toplevel)/cli/stdd.mjs"';
const PINNED_NPM_RUNNER_IN_COMMAND_PATTERN =
	/npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? -- stdd/;
const LEGACY_CODEX_STOP_NORMALIZER =
	'const fs=require("node:fs");let value;try{value=JSON.parse(fs.readFileSync(0,"utf8"));}catch{}const valid=typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.keys(value).length===0||(value.decision==="block"&&typeof value.reason==="string"&&value.reason.length>0));process.stdout.write(valid?JSON.stringify(value)+"\\n":"{}\\n");';
const CODEX_STOP_NORMALIZER =
	'const fs=require("node:fs");let value;try{value=JSON.parse(fs.readFileSync(0,"utf8"));}catch{}const object=typeof value==="object"&&value!==null&&!Array.isArray(value);const keys=object?Object.keys(value):[];const valid=object&&(keys.length===0||(keys.length===2&&keys.includes("decision")&&keys.includes("reason")&&value.decision==="block"&&typeof value.reason==="string"&&value.reason.trim().length>0));process.stdout.write(valid?JSON.stringify(value)+"\\n":"{}\\n");';

export function isStddSourceCheckout(targetDir) {
	if (
		fs.existsSync(path.join(targetDir, "cli", "stdd.mjs")) &&
		fs.existsSync(path.join(targetDir, "package.json"))
	) {
		try {
			if (JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8")).name === "@stdd/cli")
				return true;
		} catch {
			return false;
		}
	}
	return false;
}

export function hasLocalStddBinary(targetDir) {
	if (isStddSourceCheckout(targetDir)) return true;
	return ["stdd", "stdd.cmd", "stdd.ps1"].some((name) =>
		fs.existsSync(path.join(targetDir, "node_modules", ".bin", name)),
	);
}

function hookSettingsShapeError(settings, events) {
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return "settings";
	if (
		settings.hooks !== undefined &&
		(typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))
	) {
		return "hooks";
	}
	const allEvents = new Set([...events, ...Object.keys(settings.hooks ?? {})]);
	for (const event of allEvents) {
		const groups = settings.hooks?.[event];
		if (groups === undefined) continue;
		if (!Array.isArray(groups)) return `hooks.${event}`;
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
			const group = groups[groupIndex];
			if (typeof group !== "object" || group === null || Array.isArray(group)) {
				return `hooks.${event}[${groupIndex}]`;
			}
			if (group.matcher !== undefined && typeof group.matcher !== "string") {
				return `hooks.${event}[${groupIndex}].matcher`;
			}
			if (!Array.isArray(group.hooks)) return `hooks.${event}[${groupIndex}].hooks`;
			for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex++) {
				const hook = group.hooks[hookIndex];
				if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
					return `hooks.${event}[${groupIndex}].hooks[${hookIndex}]`;
				}
				if (typeof hook.type !== "string" || hook.type === "") {
					return `hooks.${event}[${groupIndex}].hooks[${hookIndex}].type`;
				}
				if (hook.type === "command" && (typeof hook.command !== "string" || hook.command === "")) {
					return `hooks.${event}[${groupIndex}].hooks[${hookIndex}].command`;
				}
			}
		}
	}
	return null;
}

function validateJsonHookEvents({ targetDir, settingsRelative, settingsLabel, events, parseMessage }) {
	const settingsPath = resolveWritableRepoPath(
		targetDir,
		settingsRelative,
		`${settingsLabel} settings path`,
	);
	if (!fs.existsSync(settingsPath)) return true;
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {
		console.error(`${settingsRelative} does not parse — left untouched; ${parseMessage}`);
		return false;
	}
	const invalid = hookSettingsShapeError(settings, events);
	if (invalid) {
		console.error(
			`${settingsRelative} has an invalid ${invalid} shape — left untouched; ${parseMessage}`,
		);
		return false;
	}
	return true;
}

function installJsonHook({
	targetDir,
	settingsRelative,
	settingsLabel,
	event,
	entry,
	legacyCommands,
	generatedCommandPattern = null,
	isManagedCommand = () => false,
	parseMessage,
	existingMessage,
	migratedMessage,
	installedMessage,
}) {
	const settingsPath = resolveWritableRepoPath(
		targetDir,
		settingsRelative,
		`${settingsLabel} settings path`,
	);
	let settings = {};
	if (fs.existsSync(settingsPath)) {
		try {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		} catch {
			console.error(
				`${settingsRelative} does not parse — left untouched; ${parseMessage}:\n  ` +
					JSON.stringify({ hooks: { [event]: [entry] } }),
			);
			return false;
		}
	}
	const invalid = hookSettingsShapeError(settings, [event]);
	if (invalid) {
		console.error(
			`${settingsRelative} has an invalid ${invalid} shape — left untouched; ${parseMessage}`,
		);
		return false;
	}
	settings.hooks ??= {};
	settings.hooks[event] ??= [];
	let migrated = false;
	const currentCommand = entry.hooks[0].command;
	const splitGroups = [];
	for (const group of [...settings.hooks[event]]) {
		if (!Array.isArray(group?.hooks)) continue;
		for (let index = group.hooks.length - 1; index >= 0; index--) {
			const hook = group.hooks[index];
			const managed =
				hook?.command === currentCommand ||
				legacyCommands.includes(hook?.command) ||
				(typeof hook?.command === "string" &&
					(generatedCommandPattern?.test(hook.command) || isManagedCommand(hook.command)));
			if (!managed) continue;
			if (hook.command !== currentCommand) {
				hook.command = currentCommand;
				migrated = true;
			}
			if (entry.matcher === undefined || group.matcher === entry.matcher) continue;
			if (group.hooks.length === 1) {
				group.matcher = entry.matcher;
			} else {
				// A matcher belongs to the whole group. Moving only the managed
				// hook keeps unrelated sibling hooks on the user's matcher.
				group.hooks.splice(index, 1);
				splitGroups.push({ matcher: entry.matcher, hooks: [hook] });
			}
			migrated = true;
		}
	}
	settings.hooks[event].push(...splitGroups);
	let currentSeen = false;
	for (const group of settings.hooks[event]) {
		if (!Array.isArray(group?.hooks)) continue;
		group.hooks = group.hooks.filter((hook) => {
			if (hook?.command !== currentCommand) return true;
			if (!currentSeen) {
				currentSeen = true;
				return true;
			}
			migrated = true;
			return false;
		});
	}
	settings.hooks[event] = settings.hooks[event].filter(
		(group) => !Array.isArray(group?.hooks) || group.hooks.length > 0,
	);
	if (migrated) {
		fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
		console.log(migratedMessage);
		return true;
	}
	if (
		currentSeen ||
		settings.hooks[event].some((group) =>
			(Array.isArray(group?.hooks) ? group.hooks : []).some((hook) => hook?.command === currentCommand),
		)
	) {
		console.log(existingMessage);
		return true;
	}
	settings.hooks[event].push(entry);
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	console.log(installedMessage);
	return true;
}

function removeManagedJsonHook({
	targetDir,
	settingsRelative,
	settingsLabel,
	event,
	currentCommand,
	legacyCommands,
	generatedCommandPattern,
	removedMessage,
}) {
	const settingsPath = resolveWritableRepoPath(
		targetDir,
		settingsRelative,
		`${settingsLabel} settings path`,
	);
	if (!fs.existsSync(settingsPath)) return;
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	const groups = settings.hooks?.[event];
	if (!Array.isArray(groups)) return;
	let removed = false;
	for (const group of groups) {
		if (!Array.isArray(group?.hooks)) continue;
		group.hooks = group.hooks.filter((hook) => {
			const managed =
				hook?.command === currentCommand ||
				legacyCommands.includes(hook?.command) ||
				(typeof hook?.command === "string" && generatedCommandPattern.test(hook.command));
			if (managed) removed = true;
			return !managed;
		});
	}
	settings.hooks[event] = groups.filter(
		(group) => !Array.isArray(group?.hooks) || group.hooks.length > 0,
	);
	if (settings.hooks[event].length === 0) delete settings.hooks[event];
	if (!removed) return;
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	console.log(removedMessage);
}

function installClaudeSessionHooks(targetDir, npmRunner) {
	if (
		!validateJsonHookEvents({
			targetDir,
			settingsRelative: CLAUDE_HOOKS_FILE,
			settingsLabel: "Claude",
			events: ["SessionStart", "PostCompact"],
			parseMessage: "merge the session hooks manually",
		})
	) {
		return;
	}
	const sessionInstalled = installJsonHook({
		targetDir,
		settingsRelative: CLAUDE_HOOKS_FILE,
		settingsLabel: "Claude",
		event: "SessionStart",
		entry: {
			matcher: "startup|resume|clear|compact",
			hooks: [{ type: "command", command: `${npmRunner} status --local || true` }],
		},
		legacyCommands: LEGACY_STATUS_COMMANDS,
		generatedCommandPattern: GENERATED_STATUS_COMMAND_PATTERN,
		parseMessage: "merge the hook manually",
		existingMessage: ".claude/settings.json already carries the session-start hook — left untouched",
		migratedMessage:
			"Migrated the Claude Code session-start hook to the current STDD lifecycle contract",
		installedMessage:
			"Wired the Claude Code SessionStart hook (startup|resume|clear|compact → stdd status --local)",
	});
	if (!sessionInstalled) return;
	removeManagedJsonHook({
		targetDir,
		settingsRelative: CLAUDE_HOOKS_FILE,
		settingsLabel: "Claude",
		event: "PostCompact",
		currentCommand: `${npmRunner} status --local || true`,
		legacyCommands: LEGACY_STATUS_COMMANDS,
		generatedCommandPattern: GENERATED_STATUS_COMMAND_PATTERN,
		removedMessage:
			"Removed the redundant managed Claude Code PostCompact hook (SessionStart compact owns restore)",
	});
}

export function claudeStopCommand(npmRunner) {
	return `{ output="$(${npmRunner} stop-hook 2>&1)"; status=$?; if [ "$status" -eq 2 ]; then printf '%s\\n' "$output" >&2; exit 2; fi; exit 0; }`;
}

function normalizedCodexStopCommand(npmRunner, normalizer) {
	return `{ : "STDD managed Codex Stop protocol v1"; output="$(${npmRunner} stop-hook --agent codex 2>/dev/null)" && printf '%s' "$output" | node -e '${normalizer}' 2>/dev/null || printf '{}\\n'; exit 0; }`;
}

function legacyMarkedCodexStopCommand(npmRunner, normalizer) {
	return `{ stdd_codex_stop_protocol=1; output="$(${npmRunner} stop-hook --agent codex 2>/dev/null)" && printf '%s' "$output" | node -e '${normalizer}' 2>/dev/null || printf '{}\\n'; exit 0; }`;
}

export function codexStopCommand(npmRunner) {
	return normalizedCodexStopCommand(npmRunner, CODEX_STOP_NORMALIZER);
}

function legacyCodexStopCommand(npmRunner) {
	return `{ output="$(${npmRunner} stop-hook --agent codex 2>/dev/null)" && printf '%s\\n' "$output" || printf '{}\\n'; exit 0; }`;
}

function knownCodexStopRunners(command) {
	const runners = [SOURCE_CHECKOUT_RUNNER, "npm exec --offline -- stdd"].filter((runner) =>
		command.includes(runner),
	);
	const pinnedNpmRunner = command.match(PINNED_NPM_RUNNER_IN_COMMAND_PATTERN)?.[0];
	if (pinnedNpmRunner) runners.push(pinnedNpmRunner);
	return runners;
}

function isKnownGeneratedCodexStopCommand(command) {
	return knownCodexStopRunners(command).some(
		(runner) =>
			command === `${runner} stop-hook --agent codex` ||
			command === legacyCodexStopCommand(runner) ||
			command === legacyMarkedCodexStopCommand(runner, LEGACY_CODEX_STOP_NORMALIZER) ||
			command === legacyMarkedCodexStopCommand(runner, CODEX_STOP_NORMALIZER) ||
			command === normalizedCodexStopCommand(runner, LEGACY_CODEX_STOP_NORMALIZER) ||
			command === normalizedCodexStopCommand(runner, CODEX_STOP_NORMALIZER),
	);
}

function installClaudeStopHook(targetDir, npmRunner) {
	const entry = { hooks: [{ type: "command", command: claudeStopCommand(npmRunner) }] };
	installJsonHook({
		targetDir,
		settingsRelative: CLAUDE_HOOKS_FILE,
		settingsLabel: "Claude",
		event: "Stop",
		entry,
		legacyCommands: [
			"npx --no stdd stop-hook",
			"npm exec --offline -- stdd stop-hook",
			`${npmRunner} stop-hook`,
		],
		generatedCommandPattern:
			/^(?:npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? -- stdd stop-hook|\{ output="\$\(npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? -- stdd stop-hook 2>&1\)"; status=\$\?; if \[ "\$status" -eq 2 \]; then printf '%s\\n' "\$output" >&2; exit 2; fi; exit 0; \})$/,
		parseMessage: "merge the hook manually",
		existingMessage: ".claude/settings.json already carries the stop hook — left untouched",
		migratedMessage: "Migrated the Claude Code stop hook to the local offline stdd binary",
		installedMessage:
			"Wired the Claude Code Stop hook (stdd stop-hook — gate on session end) in .claude/settings.json",
	});
}

function installCodexSessionHook(targetDir, npmRunner) {
	installJsonHook({
		targetDir,
		settingsRelative: CODEX_HOOKS_FILE,
		settingsLabel: "Codex",
		event: "SessionStart",
		entry: {
			matcher: "startup|resume|clear|compact",
			hooks: [{ type: "command", command: `${npmRunner} status --local || true` }],
		},
		legacyCommands: LEGACY_STATUS_COMMANDS,
		generatedCommandPattern: GENERATED_STATUS_COMMAND_PATTERN,
		parseMessage: "merge the hook manually",
		existingMessage: ".codex/hooks.json already carries the session-start hook — left untouched",
		migratedMessage: "Re-pinned the Codex session-start hook",
		installedMessage:
			"Wired the Codex SessionStart hook (startup|resume|clear|compact → stdd status --local)",
	});
}

function installCodexStopHook(targetDir, npmRunner) {
	installJsonHook({
		targetDir,
		settingsRelative: CODEX_HOOKS_FILE,
		settingsLabel: "Codex",
		event: "Stop",
		entry: {
			hooks: [{ type: "command", command: codexStopCommand(npmRunner) }],
		},
		legacyCommands: [
			"npm exec --offline -- stdd stop-hook --agent codex",
			`${npmRunner} stop-hook --agent codex`,
			legacyCodexStopCommand(npmRunner),
		],
		isManagedCommand: isKnownGeneratedCodexStopCommand,
		parseMessage: "merge the hook manually",
		existingMessage: ".codex/hooks.json already carries the stop hook — left untouched",
		migratedMessage: "Re-pinned the Codex stop hook",
		installedMessage: "Wired the Codex Stop hook (stdd stop-hook --agent codex)",
	});
}

export function renderPiLifecycleExtension(npmRunner, { sessionHook = false, stopHook = false } = {}) {
	const metadata = JSON.stringify({
		sessionHook: Boolean(sessionHook),
		stopHook: Boolean(stopHook),
		runner: npmRunner,
	});
	const lines = [
		`// ${PI_LIFECYCLE_MARKER} ${metadata}`,
		'import { execFile } from "node:child_process";',
		"",
		`const runner = ${JSON.stringify(npmRunner)};`,
		"",
		"function runStdd(ctx, args) {",
		"\treturn new Promise((resolve) => {",
		'\t\tconst child = execFile("/bin/sh", ["-c", runner + " " + args], {',
		"\t\t\tcwd: ctx.cwd,",
		'\t\t\tencoding: "utf8",',
		"\t\t\ttimeout: 10_000,",
		"\t\t\tmaxBuffer: 1024 * 1024,",
		"\t\t}, (error, stdout, stderr) => {",
		"\t\t\tconst exitCode = error",
		'\t\t\t\t? (typeof error.code === "number" ? error.code : null)',
		"\t\t\t\t: 0;",
		"\t\t\tresolve({ exitCode, stdout, stderr });",
		"\t\t});",
		"\t\tchild.stdin?.end();",
		"\t});",
		"}",
		"",
		"export default function stddLifecycle(pi) {",
	];
	if (sessionHook) {
		lines.push(
			"\tconst restore = async (_event, ctx) => {",
			'\t\tconst result = await runStdd(ctx, "status --local");',
			'\t\tif (result.exitCode !== 0 || result.stdout.trim() === "") return;',
			"\t\tpi.sendMessage({",
			'\t\t\tcustomType: "stdd-status",',
			"\t\t\tcontent: result.stdout,",
			"\t\t\tdisplay: false,",
			'\t\t}, { deliverAs: "nextTurn" });',
			"\t};",
			'\tpi.on("session_start", restore);',
			'\tpi.on("session_compact", restore);',
		);
	}
	if (stopHook) {
		if (sessionHook) lines.push("");
		lines.push(
			"\tlet skipNextGate = false;",
			'\tpi.on("agent_settled", async (_event, ctx) => {',
			"\t\tif (skipNextGate) {",
			"\t\t\tskipNextGate = false;",
			"\t\t\treturn;",
			"\t\t}",
			'\t\tconst result = await runStdd(ctx, "stop-hook");',
			'\t\tif (result.exitCode !== 2 || result.stderr.trim() === "") return;',
			"\t\tskipNextGate = true;",
			"\t\tpi.sendMessage({",
			'\t\t\tcustomType: "stdd-stop-gate",',
			"\t\t\tcontent: result.stderr,",
			"\t\t\tdisplay: true,",
			'\t\t}, { deliverAs: "followUp", triggerTurn: true });',
			"\t});",
		);
	}
	lines.push("}", "");
	return lines.join("\n");
}

function parseManagedPiLifecycleExtension(content) {
	const firstLine = content.split(/\r?\n/u, 1)[0];
	const prefix = `// ${PI_LIFECYCLE_MARKER} `;
	if (!firstLine.startsWith(prefix)) return null;
	let metadata;
	try {
		metadata = JSON.parse(firstLine.slice(prefix.length));
	} catch {
		return null;
	}
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata) ||
		typeof metadata.runner !== "string" ||
		typeof metadata.sessionHook !== "boolean" ||
		typeof metadata.stopHook !== "boolean"
	) {
		return null;
	}
	const expected = renderPiLifecycleExtension(metadata.runner, metadata);
	return expected === content ? metadata : null;
}

function validatePiLifecycleExtension(targetDir) {
	const extensionPath = resolveWritableRepoPath(targetDir, PI_HOOKS_FILE, "Pi lifecycle extension path");
	if (!fs.existsSync(extensionPath)) return true;
	const current = fs.readFileSync(extensionPath, "utf8");
	if (parseManagedPiLifecycleExtension(current)) return true;
	console.error(
		`${PI_HOOKS_FILE} conflicts with the managed Pi lifecycle extension — left untouched; ` +
			"move or merge it manually",
	);
	return false;
}

function installPiLifecycleExtension(
	targetDir,
	npmRunner,
	{ sessionHook = false, stopHook = false } = {},
) {
	const extensionPath = resolveWritableRepoPath(targetDir, PI_HOOKS_FILE, "Pi lifecycle extension path");
	let previous = null;
	if (fs.existsSync(extensionPath)) {
		const current = fs.readFileSync(extensionPath, "utf8");
		previous = parseManagedPiLifecycleExtension(current);
		if (!previous) return false;
	}
	const desired = {
		sessionHook: Boolean(sessionHook || previous?.sessionHook),
		stopHook: Boolean(stopHook || previous?.stopHook),
	};
	const rendered = renderPiLifecycleExtension(npmRunner, desired);
	if (fs.existsSync(extensionPath) && fs.readFileSync(extensionPath, "utf8") === rendered) {
		console.log(`${PI_HOOKS_FILE} already carries the requested STDD lifecycle extension`);
		return true;
	}
	fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
	fs.writeFileSync(extensionPath, rendered);
	console.log(
		`Wired the Pi lifecycle extension (${[
			...(desired.sessionHook ? ["session restore"] : []),
			...(desired.stopHook ? ["bounded stop continuation"] : []),
		].join(", ")})`,
	);
	return true;
}

export function installSessionHook(targetDir, npmRunner, tools = ["claude"]) {
	if (tools.includes("claude")) installClaudeSessionHooks(targetDir, npmRunner);
	if (tools.includes("codex")) installCodexSessionHook(targetDir, npmRunner);
	if (tools.includes("pi")) installPiLifecycleExtension(targetDir, npmRunner, { sessionHook: true });
}

export function installStopHook(targetDir, npmRunner, tools = ["claude"]) {
	if (tools.includes("claude")) installClaudeStopHook(targetDir, npmRunner);
	if (tools.includes("codex")) installCodexStopHook(targetDir, npmRunner);
	if (tools.includes("pi")) installPiLifecycleExtension(targetDir, npmRunner, { stopHook: true });
}

/**
 * Install every requested lifecycle hook as one configuration operation.
 * All touched settings files are validated before the first write, so an
 * invalid sibling event cannot leave a partial install behind.
 */
function installAgentHooksViaPathnames(
	targetDir,
	npmRunner,
	tools = ["claude"],
	{ sessionHook = false, stopHook = false } = {},
) {
	const validations = [];
	if (tools.includes("claude")) {
		const events = [
			...(sessionHook ? ["SessionStart", "PostCompact"] : []),
			...(stopHook ? ["Stop"] : []),
		];
		if (events.length > 0) {
			validations.push({
				settingsRelative: CLAUDE_HOOKS_FILE,
				settingsLabel: "Claude",
				events,
			});
		}
	}
	if (tools.includes("codex")) {
		const events = [...(sessionHook ? ["SessionStart"] : []), ...(stopHook ? ["Stop"] : [])];
		if (events.length > 0) {
			validations.push({
				settingsRelative: CODEX_HOOKS_FILE,
				settingsLabel: "Codex",
				events,
			});
		}
	}
	if (tools.includes("pi") && (sessionHook || stopHook) && !validatePiLifecycleExtension(targetDir)) {
		return false;
	}
	for (const validation of validations) {
		if (
			!validateJsonHookEvents({
				targetDir,
				...validation,
				parseMessage: "merge the requested lifecycle hooks manually",
			})
		) {
			return false;
		}
	}
	if (sessionHook) installSessionHook(targetDir, npmRunner, tools);
	if (stopHook) installStopHook(targetDir, npmRunner, tools);
	return true;
}

/**
 * Render lifecycle hook updates in an isolated staging directory, then
 * publish the exact resulting bytes through the init/configure helper
 * session. Target bytes and identities are read through capabilities before
 * rendering, and publication rejects any target that changed in between.
 */
export async function prepareAgentHooks(
	context,
	npmRunner,
	tools = ["claude"],
	{ sessionHook = false, stopHook = false } = {},
) {
	const relatives = [
		...(tools.includes("claude") && (sessionHook || stopHook) ? [CLAUDE_HOOKS_FILE] : []),
		...(tools.includes("codex") && (sessionHook || stopHook) ? [CODEX_HOOKS_FILE] : []),
		...(tools.includes("pi") && (sessionHook || stopHook) ? [PI_HOOKS_FILE] : []),
	];
	const inspected = new Map();
	for (const relative of relatives) {
		inspected.set(
			relative,
			await readOptionalNativeRepoFile(context, relative, {
				label: `${relative} lifecycle configuration`,
			}),
		);
	}

	const publications = [];
	const staging = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-hook-publication-"));
	try {
		for (const [relative, state] of inspected) {
			if (!state) continue;
			const stagedPath = path.join(staging, ...relative.split("/"));
			fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
			fs.writeFileSync(stagedPath, state.bytes);
		}
		const installed = installAgentHooksViaPathnames(staging, npmRunner, tools, {
			sessionHook,
			stopHook,
		});
		if (!installed) return async () => false;
		for (const [relative, state] of inspected) {
			const stagedPath = path.join(staging, ...relative.split("/"));
			if (!fs.existsSync(stagedPath)) continue;
			const desired = fs.readFileSync(stagedPath);
			if (state?.bytes.equals(desired)) continue;
			const mode =
				state?.file.observation.identity.platform === "win32"
					? 0o644
					: Number(state?.file.observation.permissions ?? 0o644) & 0o777;
			if (![0o600, 0o644, 0o755].includes(mode)) {
				throw new Error(
					`${relative} has unsupported mode ${mode.toString(8)}; preserve it manually before retrying`,
				);
			}
			publications.push({ relative, desired, mode, state });
		}
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
	return async () => {
		for (const { relative, desired, mode, state } of publications) {
			await publishNativeRepoFile(context, relative, desired, {
				mode,
				tempPrefix: ".stdd-hook-",
				expectedTarget: state?.file.observation.identity ?? null,
				expectedBytes: state?.bytes ?? null,
			});
		}
		return true;
	};
}

export async function installAgentHooks(context, npmRunner, tools = ["claude"], options = {}) {
	const publish = await prepareAgentHooks(context, npmRunner, tools, options);
	return publish();
}
