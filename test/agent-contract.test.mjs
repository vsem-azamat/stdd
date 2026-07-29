import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	assertAgent,
	assertContractTarget,
	assertContractTranscript,
	assertPiLifecycleCapture,
	assertPluginHookCapture,
	createClaudeProofArgs,
	createCodexPluginHookArgs,
	createCodexPluginProofArgs,
	createCodexRepositoryProofArgs,
	createContractPrompt,
	createContractProof,
	createPiProofArgs,
	DEFAULT_CONTRACT_TARGETS,
	installContractProbe,
	PI_LIFECYCLE_PROBE,
	withContractFixture,
} from "../scripts/agent-contract-lib.mjs";

test("agent contract accepts only the supported model-backed CLIs", () => {
	assert.deepEqual(DEFAULT_CONTRACT_TARGETS, [
		"claude",
		"codex",
		"pi",
		"codex-plugin",
		"claude-plugin",
		"pi-plugin",
	]);
	assert.doesNotThrow(() => assertAgent("claude"));
	assert.doesNotThrow(() => assertAgent("codex"));
	assert.doesNotThrow(() => assertAgent("pi"));
	assert.throws(() => assertAgent("other"), /unknown agent "other"; use claude, codex, or pi/);
	for (const target of ["claude", "codex", "pi", "codex-plugin", "claude-plugin", "pi-plugin"]) {
		assert.doesNotThrow(() => assertContractTarget(target));
	}
	assert.throws(
		() => assertContractTarget("other"),
		/unknown contract target "other"; use claude, codex, pi, codex-plugin, claude-plugin, or pi-plugin/,
	);
});

test("contract prompts keep the opaque discovery proof isolated in the installed skill", () => {
	const firstProof = createContractProof();
	const secondProof = createContractProof();
	const skillPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stdd-contract-")), "SKILL.md");
	fs.writeFileSync(skillPath, "# Installed skill\n");
	installContractProbe(skillPath, firstProof);

	assert.match(firstProof, /^stdd-contract-[0-9a-f]{48}$/);
	assert.notEqual(firstProof, secondProof);
	assert.match(fs.readFileSync(skillPath, "utf8"), new RegExp(firstProof));
	for (const agent of ["claude", "codex", "pi", "codex-plugin", "claude-plugin", "pi-plugin"]) {
		const prompt = createContractPrompt(agent);
		assert.ok(prompt.includes("STDD_CONTRACT_PROBE"));
		assert.ok(
			prompt.includes(
				agent === "claude"
					? "/stdd-start-change"
					: agent === "codex"
						? "$stdd-start-change"
						: agent === "codex-plugin"
							? "$stdd:stdd-start-change"
							: agent === "claude-plugin"
								? "/stdd:stdd-start-change"
								: "/skill:stdd-start-change",
			),
		);
		assert.ok(!prompt.includes(firstProof));
		assert.ok(!prompt.includes(secondProof));
	}
});

test("repository contract fixtures are removed when their callback fails", () => {
	let fixtureDir;
	assert.throws(
		() =>
			withContractFixture("stdd-contract-cleanup-", (dir) => {
				fixtureDir = dir;
				fs.writeFileSync(path.join(dir, "runner-output.jsonl"), "partial\n");
				throw new Error("injected contract runner failure");
			}),
		/injected contract runner failure/,
	);
	assert.ok(fixtureDir);
	assert.ok(!fs.existsSync(fixtureDir));
});

test("plugin hook contract requires both host-discovered lifecycle calls", () => {
	const capture = [
		JSON.stringify({ argv: ["status", "--local"], cwd: "/repo", input: "" }),
		JSON.stringify({
			argv: ["stop-hook", "--agent", "codex"],
			cwd: "/repo",
			input: '{"stop_hook_active":false}',
		}),
	].join("\n");
	assert.doesNotThrow(() => assertPluginHookCapture(capture, "/repo"));
	const claudeCapture = capture.replace('"codex"', '"claude"');
	assert.doesNotThrow(() => assertPluginHookCapture(claudeCapture, "/repo", "claude", { exact: true }));
	for (const incomplete of [
		JSON.stringify({ argv: ["status", "--local"], cwd: "/repo", input: "" }),
		JSON.stringify({ argv: ["stop-hook", "--agent", "codex"], cwd: "/repo", input: "{}" }),
		`${capture}\n${capture}`,
	]) {
		assert.throws(
			() => assertPluginHookCapture(incomplete, "/repo", "codex", { exact: true }),
			/plugin host did not execute exactly one SessionStart and Stop/,
		);
	}
});

test("Pi host contract requires proof that the project lifecycle extension loaded", () => {
	const statusMessage = JSON.stringify({
		type: "message_end",
		message: {
			role: "custom",
			customType: "stdd-status",
			content: `${PI_LIFECYCLE_PROBE}\n`,
		},
	});
	assert.doesNotThrow(() =>
		assertPiLifecycleCapture(
			[
				JSON.stringify({ type: "session" }),
				statusMessage,
				JSON.stringify({ type: "agent_settled" }),
			].join("\n"),
		),
	);
	assert.throws(
		() =>
			assertPiLifecycleCapture(
				[JSON.stringify({ type: "session" }), JSON.stringify({ type: "agent_settled" })].join("\n"),
			),
		/Pi host did not load the project lifecycle extension/,
	);
});

test("native plugin proof arguments preserve each host's isolation contract", () => {
	const claudePrompt = createContractPrompt("claude-plugin");
	assert.deepEqual(createClaudeProofArgs(claudePrompt), [
		"-p",
		"--permission-mode",
		"plan",
		"--output-format",
		"stream-json",
		"--verbose",
		claudePrompt,
	]);
	const piPrompt = createContractPrompt("pi-plugin");
	assert.deepEqual(createPiProofArgs(piPrompt), [
		"--mode",
		"json",
		"--no-session",
		"--approve",
		"--no-tools",
		"--offline",
		piPrompt,
	]);
});

test("Codex plugin skill proof is isolated from the explicit hook-trust bypass", () => {
	const prompt = createContractPrompt("codex-plugin");
	const proofArgs = createCodexPluginProofArgs(prompt);
	const hookArgs = createCodexPluginHookArgs("hook lifecycle probe");
	const repositoryPrompt = createContractPrompt("codex");
	const repositoryArgs = createCodexRepositoryProofArgs(repositoryPrompt);

	assert.ok(!proofArgs.includes("--dangerously-bypass-hook-trust"));
	assert.ok(hookArgs.includes("--dangerously-bypass-hook-trust"));
	assert.deepEqual(repositoryArgs, [
		"exec",
		"--sandbox",
		"read-only",
		"--ephemeral",
		"--json",
		repositoryPrompt,
	]);
	assert.ok(proofArgs.includes("--ephemeral"));
	assert.ok(hookArgs.includes("--ephemeral"));
	assert.equal(proofArgs.at(-1), prompt);
	assert.equal(hookArgs.at(-1), "hook lifecycle probe");
});

test("contract transcript verification requires the final assistant message to equal the proof", () => {
	const proof = createContractProof();

	assert.doesNotThrow(() => {
		assertContractTranscript({
			agent: "codex",
			proof,
			transcript: [
				JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
				JSON.stringify({ type: "turn.started" }),
				JSON.stringify({
					type: "item.completed",
					item: { id: "reasoning-1", type: "reasoning", text: "follow the loaded skill" },
				}),
				JSON.stringify({
					type: "item.completed",
					item: { id: "message-1", type: "agent_message", text: proof },
				}),
				JSON.stringify({ type: "turn.completed", usage: {} }),
			].join("\n"),
		});
		assertContractTranscript({
			agent: "claude",
			proof,
			transcript: [
				JSON.stringify({
					type: "system",
					subtype: "hook_started",
					hook_event: "SessionStart",
				}),
				JSON.stringify({
					type: "system",
					subtype: "hook_response",
					hook_event: "SessionStart",
					output: "status ready",
				}),
				JSON.stringify({ type: "system", subtype: "init" }),
				JSON.stringify({
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "follow the loaded skill" },
							{ type: "text", text: proof },
						],
					},
				}),
				JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
				JSON.stringify({ type: "result", subtype: "success", result: proof }),
			].join("\n"),
		});
		assertContractTranscript({
			agent: "pi",
			proof,
			transcript: [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "session-1",
					timestamp: "2026-07-28T00:00:00.000Z",
					cwd: "/repo",
				}),
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({ type: "turn_start" }),
				JSON.stringify({
					type: "message_start",
					message: {
						role: "user",
						content: [{ type: "text", text: `Expanded native skill proof: ${proof}` }],
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "user",
						content: [{ type: "text", text: `Expanded native skill proof: ${proof}` }],
					},
				}),
				JSON.stringify({
					type: "message_start",
					message: { role: "assistant", content: [] },
				}),
				JSON.stringify({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: proof }] },
				}),
				JSON.stringify({
					type: "turn_end",
					message: { role: "assistant", content: [{ type: "text", text: proof }] },
					toolResults: [],
				}),
				JSON.stringify({
					type: "agent_end",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: `Expanded native skill proof: ${proof}` }],
						},
						{ role: "assistant", content: [{ type: "text", text: proof }] },
					],
				}),
				JSON.stringify({ type: "agent_settled" }),
			].join("\n"),
		});
	});
});

test("contract transcript verification rejects tool-assisted proof reads followed by an exact echo", () => {
	const proof = createContractProof();

	assert.throws(
		() =>
			assertContractTranscript({
				agent: "codex",
				proof,
				transcript: [
					JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
					JSON.stringify({ type: "turn.started" }),
					JSON.stringify({
						type: "item.completed",
						item: {
							id: "command-1",
							type: "command_execution",
							command: "cat .agents/skills/stdd-start-change/SKILL.md",
							aggregated_output: proof,
							exit_code: 0,
						},
					}),
					JSON.stringify({
						type: "item.completed",
						item: { id: "message-1", type: "agent_message", text: proof },
					}),
					JSON.stringify({ type: "turn.completed", usage: {} }),
				].join("\n"),
			}),
		/codex did not prove that stdd-start-change loaded/,
	);
	assert.throws(
		() =>
			assertContractTranscript({
				agent: "claude",
				proof,
				transcript: [
					JSON.stringify({ type: "system", subtype: "init" }),
					JSON.stringify({
						type: "assistant",
						message: {
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "tool-1",
									name: "Read",
									input: { file_path: ".claude/skills/stdd-start-change/SKILL.md" },
								},
							],
						},
					}),
					JSON.stringify({
						type: "user",
						message: {
							role: "user",
							content: [{ type: "tool_result", tool_use_id: "tool-1", content: proof }],
						},
					}),
					JSON.stringify({
						type: "assistant",
						message: {
							role: "assistant",
							content: [{ type: "text", text: proof }],
						},
					}),
					JSON.stringify({ type: "result", subtype: "success", is_error: false, result: proof }),
				].join("\n"),
			}),
		/claude did not prove that stdd-start-change loaded/,
	);
	const piTranscript = ({ session = {}, toolResults = [] } = {}) =>
		[
			JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/repo", ...session }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: proof }] },
			}),
			JSON.stringify({
				type: "turn_end",
				message: { role: "assistant", content: [{ type: "text", text: proof }] },
				toolResults,
			}),
			JSON.stringify({
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text: proof }] }],
			}),
			JSON.stringify({ type: "agent_settled" }),
		].join("\n");
	assert.throws(
		() =>
			assertContractTranscript({
				agent: "pi",
				proof,
				transcript: piTranscript({
					toolResults: [
						{
							role: "toolResult",
							toolCallId: "read-1",
							toolName: "read",
							content: [{ type: "text", text: proof }],
						},
					],
				}),
			}),
		/pi did not prove that stdd-start-change loaded/,
	);
	assert.throws(
		() =>
			assertContractTranscript({
				agent: "pi",
				proof,
				transcript: piTranscript({ session: { discoveryProof: proof } }),
			}),
		/pi did not prove that stdd-start-change loaded/,
	);
});

test("contract transcript verification ignores opaque proof in tool output", () => {
	const proof = createContractProof();

	assert.throws(
		() =>
			assertContractTranscript({
				agent: "codex",
				proof,
				transcript: [
					JSON.stringify({
						type: "item.completed",
						item: { type: "command_execution", aggregated_output: proof },
					}),
					JSON.stringify({
						type: "item.completed",
						item: { type: "agent_message", text: "tool completed" },
					}),
					JSON.stringify({ type: "turn.completed", usage: {} }),
				].join("\n"),
			}),
		/codex did not prove that stdd-start-change loaded/,
	);
	assert.throws(
		() =>
			assertContractTranscript({
				agent: "claude",
				proof,
				transcript: [
					JSON.stringify({
						type: "assistant",
						message: {
							role: "assistant",
							content: [{ type: "tool_use", name: "Read", input: { echoed: proof } }],
						},
					}),
					JSON.stringify({
						type: "result",
						subtype: "success",
						result: "tool completed",
					}),
				].join("\n"),
			}),
		/claude did not prove that stdd-start-change loaded/,
	);
});

test("contract transcript verification rejects extra text and a proof in a non-final message", () => {
	const proof = createContractProof();

	assert.throws(
		() =>
			assertContractTranscript({
				agent: "codex",
				proof,
				transcript: [
					JSON.stringify({
						type: "item.completed",
						item: { type: "agent_message", text: proof },
					}),
					JSON.stringify({
						type: "item.completed",
						item: { type: "agent_message", text: "later final answer" },
					}),
					JSON.stringify({ type: "turn.completed", usage: {} }),
				].join("\n"),
			}),
		/codex did not prove that stdd-start-change loaded/,
	);
	assert.throws(
		() =>
			assertContractTranscript({
				agent: "claude",
				proof,
				transcript: [
					JSON.stringify({
						type: "assistant",
						message: {
							role: "assistant",
							content: [{ type: "text", text: `${proof}\nextra text` }],
						},
					}),
					JSON.stringify({
						type: "result",
						subtype: "success",
						result: `${proof}\nextra text`,
					}),
				].join("\n"),
			}),
		/claude did not prove that stdd-start-change loaded/,
	);
});
