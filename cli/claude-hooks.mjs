import fs from "node:fs";
import path from "node:path";
import { resolveWritableRepoPath } from "../sdk/path.mjs";

export function hasLocalStddBinary(targetDir) {
	return ["stdd", "stdd.cmd", "stdd.ps1"].some((name) =>
		fs.existsSync(path.join(targetDir, "node_modules", ".bin", name)),
	);
}

function installClaudeHook({
	targetDir,
	event,
	entry,
	commandMarker,
	legacyCommands,
	generatedCommandPattern,
	parseMessage,
	existingMessage,
	migratedMessage,
	installedMessage,
}) {
	const settingsPath = resolveWritableRepoPath(
		targetDir,
		".claude/settings.json",
		"Claude settings path",
	);
	let settings = {};
	if (fs.existsSync(settingsPath)) {
		try {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		} catch {
			console.error(
				`.claude/settings.json does not parse — left untouched; ${parseMessage}:\n  ` +
					JSON.stringify({ hooks: { [event]: [entry] } }),
			);
			return;
		}
	}
	if (
		typeof settings !== "object" ||
		settings === null ||
		Array.isArray(settings) ||
		(settings.hooks !== undefined &&
			(typeof settings.hooks !== "object" ||
				settings.hooks === null ||
				Array.isArray(settings.hooks))) ||
		(settings.hooks?.[event] !== undefined && !Array.isArray(settings.hooks[event]))
	) {
		console.error(
			`.claude/settings.json has an invalid hooks.${event} shape — left untouched; ${parseMessage}`,
		);
		return;
	}
	settings.hooks ??= {};
	settings.hooks[event] ??= [];
	let migrated = false;
	for (const group of settings.hooks[event]) {
		for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
			if (
				legacyCommands.includes(hook?.command) ||
				(typeof hook?.command === "string" && generatedCommandPattern.test(hook.command))
			) {
				hook.command = entry.hooks[0].command;
				migrated = true;
			}
		}
	}
	if (migrated) {
		fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
		console.log(migratedMessage);
		return;
	}
	if (JSON.stringify(settings.hooks[event]).includes(commandMarker)) {
		console.log(existingMessage);
		return;
	}
	settings.hooks[event].push(entry);
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	console.log(installedMessage);
}

export function installSessionHook(targetDir, npmRunner) {
	const entry = {
		matcher: "startup|clear|compact",
		hooks: [{ type: "command", command: `${npmRunner} status || true` }],
	};
	installClaudeHook({
		targetDir,
		event: "SessionStart",
		entry,
		commandMarker: "stdd status",
		legacyCommands: ["npx --no stdd status || true", "npm exec --offline -- stdd status || true"],
		generatedCommandPattern:
			/^npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? -- stdd status \|\| true$/,
		parseMessage: "merge the hook manually",
		existingMessage: ".claude/settings.json already carries the session-start hook — left untouched",
		migratedMessage: "Migrated the Claude Code session-start hook to the local offline stdd binary",
		installedMessage:
			"Wired the Claude Code SessionStart hook (startup|clear|compact → stdd status) in .claude/settings.json",
	});
}

export function installStopHook(targetDir, npmRunner) {
	const entry = { hooks: [{ type: "command", command: `${npmRunner} stop-hook` }] };
	installClaudeHook({
		targetDir,
		event: "Stop",
		entry,
		commandMarker: "stdd stop-hook",
		legacyCommands: ["npx --no stdd stop-hook", "npm exec --offline -- stdd stop-hook"],
		generatedCommandPattern:
			/^npm exec --offline --package=@stdd\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? -- stdd stop-hook$/,
		parseMessage: "merge the hook manually",
		existingMessage: ".claude/settings.json already carries the stop hook — left untouched",
		migratedMessage: "Migrated the Claude Code stop hook to the local offline stdd binary",
		installedMessage:
			"Wired the Claude Code Stop hook (stdd stop-hook — gate on session end) in .claude/settings.json",
	});
}
