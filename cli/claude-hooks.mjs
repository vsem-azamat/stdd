import fs from "node:fs";
import path from "node:path";
import { getAgentAdapter } from "../sdk/adapters.mjs";
import { resolveWritableRepoPath } from "../sdk/path.mjs";

const CLAUDE_HOOKS_FILE = getAgentAdapter("claude").hooksFile;
const CODEX_HOOKS_FILE = getAgentAdapter("codex").hooksFile;
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
		commandMarker: "stdd status",
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
		commandMarker: "stdd stop-hook",
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
		commandMarker: "stdd status",
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
		commandMarker: "stdd stop-hook",
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

export function installSessionHook(targetDir, npmRunner, tools = ["claude"]) {
	if (tools.includes("claude")) installClaudeSessionHooks(targetDir, npmRunner);
	if (tools.includes("codex")) installCodexSessionHook(targetDir, npmRunner);
}

export function installStopHook(targetDir, npmRunner, tools = ["claude"]) {
	if (tools.includes("claude")) installClaudeStopHook(targetDir, npmRunner);
	if (tools.includes("codex")) installCodexStopHook(targetDir, npmRunner);
}

/**
 * Install every requested lifecycle hook as one configuration operation.
 * All touched settings files are validated before the first write, so an
 * invalid sibling event cannot leave a partial install behind.
 */
export function installAgentHooks(
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
