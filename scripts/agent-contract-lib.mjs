import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROOF_PATTERN = /^stdd-contract-[0-9a-f]{48}$/;

export const DEFAULT_CONTRACT_TARGETS = Object.freeze(["claude", "codex", "codex-plugin"]);

export const assertAgent = (agent) => {
	if (agent !== "claude" && agent !== "codex") {
		throw new Error(`unknown agent ${JSON.stringify(agent)}; use claude or codex`);
	}
};

export const assertContractTarget = (target) => {
	if (target !== "claude" && target !== "codex" && target !== "codex-plugin") {
		throw new Error(
			`unknown contract target ${JSON.stringify(target)}; use claude, codex, or codex-plugin`,
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
				: "$stdd:stdd-start-change";
	return (
		`${invocation} This is STDD_CONTRACT_PROBE, not a real change. ` +
		"Load the named skill and follow its model-backed contract-probe directions exactly."
	);
}

export function createCodexRepositoryProofArgs(prompt) {
	return ["exec", "--sandbox", "read-only", "--ephemeral", "--json", prompt];
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

export function assertPluginHookCapture(capture, expectedCwd) {
	if (typeof capture !== "string") throw new TypeError("plugin hook capture must be a string");
	const events = parseJsonLines(capture);
	const sessionSeen = events.some(
		(event) =>
			event.cwd === expectedCwd &&
			Array.isArray(event.argv) &&
			event.argv.length === 2 &&
			event.argv[0] === "status" &&
			event.argv[1] === "--local",
	);
	const stopSeen = events.some((event) => {
		if (
			event.cwd !== expectedCwd ||
			!Array.isArray(event.argv) ||
			event.argv.length !== 3 ||
			event.argv[0] !== "stop-hook" ||
			event.argv[1] !== "--agent" ||
			event.argv[2] !== "codex" ||
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
	if (!sessionSeen || !stopSeen) {
		throw new Error("plugin host did not execute both SessionStart and Stop lifecycle commands");
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
