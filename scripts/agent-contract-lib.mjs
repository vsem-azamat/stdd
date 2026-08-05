import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROOF_PATTERN = /^stdd-contract-[0-9a-f]{48}$/;

export const DEFAULT_CONTRACT_TARGETS = Object.freeze([
	"claude",
	"codex",
	"pi",
	"codex-plugin",
	"claude-plugin",
	"pi-plugin",
	"pi-plugin-contract",
]);
export const PI_LIFECYCLE_PROBE = "stdd-pi-lifecycle-probe";

export const assertAgent = (agent) => {
	if (agent !== "claude" && agent !== "codex" && agent !== "pi") {
		throw new Error(`unknown agent ${JSON.stringify(agent)}; use claude, codex, or pi`);
	}
};

export const assertContractTarget = (target) => {
	if (!DEFAULT_CONTRACT_TARGETS.includes(target)) {
		throw new Error(
			`unknown contract target ${JSON.stringify(target)}; use claude, codex, pi, codex-plugin, claude-plugin, pi-plugin, or pi-plugin-contract`,
		);
	}
};

export function createContractProof() {
	return `stdd-contract-${randomBytes(24).toString("hex")}`;
}

export function installContractProbe(skillPath, proof = createContractProof()) {
	if (!PROOF_PATTERN.test(proof)) {
		throw new Error("contract proof must be an opaque stdd-contract token");
	}
	fs.appendFileSync(
		skillPath,
		[
			"",
			"## Model-backed contract probe",
			"",
			"When the request says it is an STDD contract probe, do not edit files or run commands.",
			`Reply with this opaque discovery proof and nothing else: \`${proof}\`.`,
			"",
		].join("\n"),
	);
	return proof;
}

export function createContractPrompt(target) {
	assertContractTarget(target);
	const invocation =
		target === "claude"
			? "/stdd-start-change"
			: target === "codex"
				? "$stdd-start-change"
				: target === "codex-plugin"
					? "$stdd:stdd-start-change"
					: target === "claude-plugin"
						? "/stdd:stdd-start-change"
						: "/skill:stdd-start-change";
	return (
		`${invocation} This is STDD_CONTRACT_PROBE, not a real change. ` +
		"Load the named skill and follow its model-backed contract-probe directions exactly."
	);
}

export function createCodexRepositoryProofArgs(prompt) {
	return ["exec", "--sandbox", "read-only", "--ephemeral", "--json", prompt];
}

export function createClaudeProofArgs(prompt) {
	return ["-p", "--permission-mode", "plan", "--output-format", "stream-json", "--verbose", prompt];
}

export function createPiProofArgs(prompt) {
	return ["--mode", "json", "--no-session", "--approve", "--no-tools", "--offline", prompt];
}

export function createCodexPluginProofArgs(prompt) {
	return createCodexRepositoryProofArgs(prompt);
}

export function createCodexPluginHookArgs(prompt) {
	return [
		"exec",
		"--sandbox",
		"read-only",
		"--ephemeral",
		"--dangerously-bypass-hook-trust",
		"--json",
		prompt,
	];
}

export function withContractFixture(prefix, action) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return action(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export function assertPluginHookCapture(capture, expectedCwd, agent = "codex", { exact = false } = {}) {
	if (typeof capture !== "string") throw new TypeError("plugin hook capture must be a string");
	if (agent !== "codex" && agent !== "claude") {
		throw new TypeError('plugin hook capture agent must be "codex" or "claude"');
	}
	const events = parseJsonLines(capture);
	const sessionEvents = events.filter(
		(event) =>
			event.cwd === expectedCwd &&
			Array.isArray(event.argv) &&
			event.argv.length === 2 &&
			event.argv[0] === "status" &&
			event.argv[1] === "--local",
	);
	const stopEvents = events.filter((event) => {
		if (
			event.cwd !== expectedCwd ||
			!Array.isArray(event.argv) ||
			event.argv.length !== 3 ||
			event.argv[0] !== "stop-hook" ||
			event.argv[1] !== "--agent" ||
			event.argv[2] !== agent ||
			typeof event.input !== "string" ||
			event.input === ""
		) {
			return false;
		}
		try {
			const payload = JSON.parse(event.input);
			return typeof payload === "object" && payload !== null && !Array.isArray(payload);
		} catch {
			return false;
		}
	});
	const missingLifecycle = sessionEvents.length === 0 || stopEvents.length === 0;
	const duplicateLifecycle =
		exact && (sessionEvents.length !== 1 || stopEvents.length !== 1 || events.length !== 2);
	if (missingLifecycle || duplicateLifecycle) {
		const expectation = exact ? "exactly one" : "both";
		throw new Error(
			`plugin host did not execute ${expectation} SessionStart and Stop lifecycle command (session=${sessionEvents.length}, stop=${stopEvents.length}, total=${events.length})`,
		);
	}
}

export function assertPiLifecycleCapture(transcript) {
	if (typeof transcript !== "string") throw new TypeError("Pi lifecycle transcript must be a string");
	const events = parseJsonLines(transcript);
	const statusSeen = events.some(
		(event) =>
			event?.type === "message_end" &&
			event.message?.role === "custom" &&
			event.message.customType === "stdd-status" &&
			typeof event.message.content === "string" &&
			event.message.content.trim() === PI_LIFECYCLE_PROBE,
	);
	if (!statusSeen) {
		throw new Error("Pi host did not load the project lifecycle extension");
	}
}

function parseJsonLines(transcript) {
	const lines = transcript.split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.length === 0) throw new Error("contract transcript is empty");
	return lines.map((line, index) => {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error(`contract transcript line ${index + 1} is not JSON`);
		}
		if (typeof event !== "object" || event === null || Array.isArray(event)) {
			throw new Error(`contract transcript line ${index + 1} is not a JSON event`);
		}
		return event;
	});
}

function assertOnlyKeys(value, allowed, subject) {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new Error(`${subject} has unknown content: ${unknown.join(", ")}`);
	}
}

function safeNumericMetadata(value) {
	if (value === null || typeof value === "number" || typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.every(safeNumericMetadata);
	if (typeof value !== "object") return false;
	return Object.values(value).every(safeNumericMetadata);
}

function safeTranscriptDiagnostic(value, proof) {
	if (typeof value !== "string") return "";
	return value
		.replaceAll(proof, "<contract-proof>")
		.replace(/\b(?:sk|sess|key|token)[-_][0-9A-Za-z._-]{12,}\b/gi, "<credential>")
		.slice(0, 1000);
}

function finalCodexAssistantMessage(events, proof) {
	let index = 0;
	const thread = events[index++];
	if (thread?.type !== "thread.started" || typeof thread.thread_id !== "string") {
		throw new Error("Codex transcript must begin with thread.started");
	}
	assertOnlyKeys(thread, ["type", "thread_id"], "Codex thread.started");

	const turn = events[index++];
	if (turn?.type !== "turn.started") {
		const rejectedMessage =
			turn?.item?.type === "error" ? safeTranscriptDiagnostic(turn.item.message, proof) : "";
		throw new Error(
			`Codex transcript must contain one turn.started after thread.started; got ${
				turn?.type ?? "end of transcript"
			}${turn?.item?.type ? `/${turn.item.type}` : ""}${rejectedMessage ? `: ${rejectedMessage}` : ""}`,
		);
	}
	assertOnlyKeys(turn, ["type"], "Codex turn.started");

	while (events[index]?.type === "item.completed" && events[index].item?.type === "reasoning") {
		const event = events[index++];
		assertOnlyKeys(event, ["type", "item"], "Codex reasoning event");
		assertOnlyKeys(event.item, ["id", "type", "text"], "Codex reasoning item");
		if (typeof event.item.id !== "string" || typeof event.item.text !== "string") {
			throw new Error("Codex reasoning item has malformed metadata");
		}
	}

	const final = events[index++];
	if (final?.type !== "item.completed" || final.item?.type !== "agent_message") {
		throw new Error("Codex transcript contains a non-reasoning item or no final agent message");
	}
	assertOnlyKeys(final, ["type", "item"], "Codex final message event");
	assertOnlyKeys(final.item, ["id", "type", "text"], "Codex final message item");
	if (typeof final.item.id !== "string" || typeof final.item.text !== "string") {
		throw new Error("Codex final agent message is malformed");
	}

	const terminal = events[index++];
	if (terminal?.type !== "turn.completed" || !safeNumericMetadata(terminal.usage)) {
		throw new Error("Codex transcript must end with a numeric-metadata turn.completed");
	}
	assertOnlyKeys(terminal, ["type", "usage"], "Codex turn.completed");
	if (index !== events.length) {
		throw new Error("Codex transcript has content after turn.completed");
	}
	return final.item.text;
}

function containsProof(value, proof) {
	return JSON.stringify(value).includes(proof);
}

function isAllowedClaudeMetadata(event, proof, initSeen) {
	const allowedSystemSubtype =
		event?.type === "system" &&
		(event.subtype === "hook_started" ||
			event.subtype === "hook_response" ||
			(initSeen && event.subtype === "thinking_tokens"));
	const allowedRateLimit = initSeen && event?.type === "rate_limit_event";
	if (!allowedSystemSubtype && !allowedRateLimit) return false;
	if (containsProof(event, proof)) {
		throw new Error(`Claude ${event.type}/${event.subtype ?? "metadata"} leaked the contract proof`);
	}
	return true;
}

function finalClaudeAssistantMessage(events, proof) {
	let initSeen = false;
	let finalText = null;
	let assistantMessages = 0;
	for (let index = 0; index < events.length - 1; index++) {
		const event = events[index];
		if (event?.type === "system" && event.subtype === "init") {
			if (initSeen || assistantMessages > 0) {
				throw new Error("Claude system/init must occur exactly once before assistant content");
			}
			if (containsProof(event, proof)) {
				throw new Error("Claude system metadata leaked the contract proof");
			}
			initSeen = true;
			continue;
		}
		if (isAllowedClaudeMetadata(event, proof, initSeen)) continue;
		if (
			!initSeen ||
			event?.type !== "assistant" ||
			event.message?.role !== "assistant" ||
			!Array.isArray(event.message.content)
		) {
			throw new Error(`Claude transcript contains disallowed ${event?.type ?? "unknown"} content`);
		}
		if (finalText !== null) {
			throw new Error("Claude transcript contains assistant content after the final text");
		}
		assistantMessages++;
		const messageMetadata = {
			...event,
			message: { ...event.message, content: [] },
		};
		if (containsProof(messageMetadata, proof)) {
			throw new Error("Claude assistant metadata leaked the contract proof");
		}
		const texts = [];
		for (const block of event.message.content) {
			if (typeof block !== "object" || block === null) {
				throw new Error("Claude assistant content contains a malformed block");
			}
			if (block.type === "text") {
				assertOnlyKeys(block, ["type", "text"], "Claude text block");
				if (typeof block.text !== "string") {
					throw new Error("Claude assistant text block is malformed");
				}
				texts.push(block.text);
				continue;
			}
			if (block.type === "thinking") {
				assertOnlyKeys(block, ["type", "thinking", "signature"], "Claude thinking block");
				if (typeof block.thinking !== "string") {
					throw new Error("Claude thinking block is malformed");
				}
				continue;
			}
			if (block.type === "redacted_thinking") {
				assertOnlyKeys(block, ["type", "data"], "Claude redacted thinking block");
				if (typeof block.data !== "string") {
					throw new Error("Claude redacted thinking block is malformed");
				}
				continue;
			}
			throw new Error(`Claude assistant content contains disallowed ${block.type ?? "unknown"} block`);
		}
		const text = texts.join("");
		if (text !== "") {
			if (finalText !== null) {
				throw new Error("Claude transcript contains text before the final assistant message");
			}
			finalText = text;
		}
	}
	if (!initSeen || assistantMessages === 0 || finalText === null) {
		throw new Error("Claude transcript has no final assistant text");
	}

	const terminal = events.at(-1);
	if (
		terminal?.type !== "result" ||
		terminal.subtype !== "success" ||
		terminal.is_error === true ||
		typeof terminal.result !== "string"
	) {
		throw new Error("Claude transcript must end with a successful result");
	}
	const terminalMetadata = { ...terminal, result: "" };
	if (containsProof(terminalMetadata, proof)) {
		throw new Error("Claude result metadata leaked the contract proof");
	}
	return terminal.result === finalText ? finalText : null;
}

function piAssistantText(message, proof, subject) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) {
		throw new Error(`${subject} has malformed assistant content`);
	}
	const metadata = { ...message, content: [] };
	if (containsProof(metadata, proof)) {
		throw new Error(`${subject} leaked the contract proof in assistant metadata`);
	}
	let text = "";
	for (const block of message.content) {
		if (block?.type === "text" && typeof block.text === "string") {
			const blockMetadata = { ...block, text: "" };
			if (containsProof(blockMetadata, proof)) {
				throw new Error(`${subject} leaked the contract proof in text metadata`);
			}
			text += block.text;
			continue;
		}
		if (block?.type === "thinking" && typeof block.thinking === "string") {
			if (containsProof(block, proof)) {
				throw new Error(`${subject} leaked the contract proof in thinking`);
			}
			continue;
		}
		throw new Error(`${subject} contains disallowed ${block?.type ?? "unknown"} block`);
	}
	return text;
}

function assertPiNonAssistantMessage(message, proof, subject) {
	if (message?.role === "toolResult") {
		throw new Error(`${subject} contains a tool result`);
	}
	if (message?.role === "user" && Array.isArray(message.content)) {
		const metadata = { ...message, content: [] };
		if (containsProof(metadata, proof)) {
			throw new Error(`${subject} leaked the contract proof in user metadata`);
		}
		for (const block of message.content) {
			if (block?.type !== "text" || typeof block.text !== "string") {
				throw new Error(`${subject} contains malformed user content`);
			}
			if (containsProof({ ...block, text: "" }, proof)) {
				throw new Error(`${subject} leaked the contract proof in user content metadata`);
			}
		}
		return;
	}
	if (containsProof(message, proof)) {
		throw new Error(`${subject} leaked the contract proof outside assistant content`);
	}
}

function assertPiStreamUpdate(update, proof) {
	const type = update?.type;
	if (typeof type !== "string" || type.startsWith("toolcall_") || type === "error") {
		throw new Error(`Pi message update contains disallowed ${type ?? "unknown"} content`);
	}
	if (type === "start") {
		if (containsProof({ ...update, partial: null }, proof)) {
			throw new Error("Pi message update leaked the contract proof in metadata");
		}
		piAssistantText(update.partial, proof, "Pi message update");
		return;
	}
	if (type.startsWith("thinking_")) {
		if (containsProof(update, proof)) {
			throw new Error("Pi thinking update leaked the contract proof");
		}
		return;
	}
	if (type.startsWith("text_")) {
		const metadata = { ...update, partial: null, delta: "", content: "" };
		if (containsProof(metadata, proof)) {
			throw new Error("Pi text update leaked the contract proof in metadata");
		}
		piAssistantText(update.partial, proof, "Pi text update");
		return;
	}
	if (type === "done") {
		const metadata = { ...update, message: null };
		if (containsProof(metadata, proof) || update.reason === "toolUse") {
			throw new Error("Pi completion update contains disallowed metadata");
		}
		piAssistantText(update.message, proof, "Pi completion update");
		return;
	}
	throw new Error(`Pi message update contains disallowed ${type} content`);
}

function finalPiAssistantMessage(events, proof) {
	if (events[0]?.type !== "session") {
		throw new Error("Pi transcript must begin with a session header");
	}
	if (events.at(-1)?.type !== "agent_settled") {
		throw new Error("Pi transcript must end with agent_settled");
	}
	const allowed = new Set([
		"session",
		"agent_start",
		"turn_start",
		"message_start",
		"message_update",
		"message_end",
		"turn_end",
		"agent_end",
		"agent_settled",
	]);
	let finalText = null;
	let assistantMessages = 0;
	let turnEnds = 0;
	let agentEnds = 0;
	for (const event of events) {
		if (!allowed.has(event?.type)) {
			throw new Error(`Pi transcript contains disallowed ${event?.type ?? "unknown"} content`);
		}
		if (event.type === "message_start" || event.type === "message_end") {
			if (containsProof({ ...event, message: null }, proof)) {
				throw new Error(`Pi ${event.type} leaked the contract proof in metadata`);
			}
			if (event.message?.role !== "assistant") {
				assertPiNonAssistantMessage(event.message, proof, `Pi ${event.type}`);
				continue;
			}
			const text = piAssistantText(event.message, proof, `Pi ${event.type}`);
			if (event.type === "message_end" && text !== "") {
				assistantMessages++;
				if (finalText !== null) {
					throw new Error("Pi transcript contains text before the final assistant message");
				}
				finalText = text;
			}
			continue;
		}
		if (event.type === "message_update") {
			if (
				containsProof({ ...event, message: null, assistantMessageEvent: null }, proof) ||
				event.message?.role !== "assistant"
			) {
				throw new Error("Pi message update contains disallowed metadata");
			}
			piAssistantText(event.message, proof, "Pi message update");
			assertPiStreamUpdate(event.assistantMessageEvent, proof);
			continue;
		}
		if (event.type === "turn_end") {
			turnEnds++;
			if (!Array.isArray(event.toolResults) || event.toolResults.length !== 0) {
				throw new Error("Pi turn_end contains tool results");
			}
			if (containsProof({ ...event, message: null, toolResults: [] }, proof)) {
				throw new Error("Pi turn_end leaked the contract proof in metadata");
			}
			const text = piAssistantText(event.message, proof, "Pi turn_end");
			if (finalText === null || text !== finalText) {
				throw new Error("Pi turn_end does not match the final assistant message");
			}
			continue;
		}
		if (event.type === "agent_end") {
			agentEnds++;
			if (!Array.isArray(event.messages)) {
				throw new Error("Pi agent_end has malformed messages");
			}
			if (containsProof({ ...event, messages: [] }, proof)) {
				throw new Error("Pi agent_end leaked the contract proof in metadata");
			}
			let terminalAssistantSeen = false;
			for (const message of event.messages) {
				if (message?.role !== "assistant") {
					assertPiNonAssistantMessage(message, proof, "Pi agent_end");
					continue;
				}
				const text = piAssistantText(message, proof, "Pi agent_end");
				if (finalText === null || text !== finalText) {
					throw new Error("Pi agent_end does not match the final assistant message");
				}
				terminalAssistantSeen = true;
			}
			if (!terminalAssistantSeen) {
				throw new Error("Pi agent_end has no terminal assistant message");
			}
			continue;
		}
		if (containsProof(event, proof)) {
			throw new Error(`Pi ${event.type} leaked the contract proof`);
		}
	}
	if (assistantMessages !== 1 || finalText === null || turnEnds !== 1 || agentEnds !== 1) {
		throw new Error("Pi transcript has no single tool-free final assistant turn");
	}
	return finalText;
}

export function assertContractTranscript({ agent, proof, transcript }) {
	assertAgent(agent);
	if (!PROOF_PATTERN.test(proof)) {
		throw new Error("contract proof must be an opaque stdd-contract token");
	}
	if (typeof transcript !== "string") {
		throw new TypeError("contract transcript must be a string");
	}
	let finalMessage = null;
	let parseError = null;
	try {
		const events = parseJsonLines(transcript);
		finalMessage =
			agent === "codex"
				? finalCodexAssistantMessage(events, proof)
				: agent === "pi"
					? finalPiAssistantMessage(events, proof)
					: finalClaudeAssistantMessage(events, proof);
	} catch (err) {
		parseError = err.message;
	}
	if (finalMessage !== proof) {
		const detail =
			parseError ??
			(finalMessage === null
				? "no final assistant message"
				: `final assistant message was ${JSON.stringify(finalMessage)}`);
		throw new Error(`${agent} did not prove that stdd-start-change loaded\n${detail}`);
	}
}
