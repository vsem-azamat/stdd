#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertAgent,
	assertContractTarget,
	assertContractTranscript,
	assertPiLifecycleCapture,
	assertPluginHookCapture,
	createCodexPluginHookArgs,
	createCodexPluginProofArgs,
	createCodexRepositoryProofArgs,
	createContractPrompt,
	DEFAULT_CONTRACT_TARGETS,
	installContractProbe,
	PI_LIFECYCLE_PROBE,
	withContractFixture,
} from "./agent-contract-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "stdd.mjs");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "stdd");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : DEFAULT_CONTRACT_TARGETS;
for (const target of targets) assertContractTarget(target);

if (process.env.STDD_AGENT_CONTRACT !== "1") {
	console.error(
		"agent contract tests call installed model-backed CLIs; opt in with STDD_AGENT_CONTRACT=1",
	);
	process.exit(2);
}

const git = (cwd, ...args) =>
	execFileSync("git", ["-C", cwd, "-c", "user.email=contract@stdd", "-c", "user.name=stdd", ...args], {
		encoding: "utf8",
	});

function commandFailure(run) {
	return (
		run.error?.message ||
		run.stderr?.trim() ||
		run.stdout?.trim() ||
		(run.signal ? `signal ${run.signal}` : `exit ${run.status}`)
	);
}

function runChecked(bin, args, { cwd, env = process.env, label, timeout = 30_000 }) {
	const run = spawnSync(bin, args, {
		cwd,
		env,
		encoding: "utf8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (run.error || run.status !== 0) {
		throw new Error(`${label} failed: ${commandFailure(run)}`);
	}
	return run;
}

function assertCliAvailable(bin, label, env = process.env) {
	runChecked(bin, ["--version"], {
		env,
		label: `${label} CLI availability check`,
		timeout: 10_000,
	});
}

function assertFixtureClean(dir, label) {
	const dirty = git(dir, "status", "--porcelain").trim();
	if (dirty) throw new Error(`${label} modified the contract fixture:\n${dirty}`);
}

function installPiLifecycleProbeCli(dir) {
	const packageRoot = path.join(dir, "node_modules", "@stdd", "cli");
	const cliPath = path.join(packageRoot, "cli", "stdd.mjs");
	const binDir = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(path.dirname(cliPath), { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		`${JSON.stringify({
			name: "@stdd/cli",
			version: PACKAGE_VERSION,
			type: "module",
			bin: { stdd: "./cli/stdd.mjs" },
		})}\n`,
	);
	fs.writeFileSync(
		cliPath,
		[
			"#!/usr/bin/env node",
			`const probe = ${JSON.stringify(PI_LIFECYCLE_PROBE)};`,
			'if (process.argv[2] === "status") process.stdout.write(probe + "\\n");',
			'else if (process.argv[2] === "stop-hook") process.stdout.write("{}\\n");',
			"else process.exitCode = 2;",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	fs.symlinkSync("../@stdd/cli/cli/stdd.mjs", path.join(binDir, "stdd"));
	fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), "\nnode_modules/\n");
}

function runRepoContract(agent) {
	assertAgent(agent);
	return withContractFixture(`stdd-${agent}-contract-`, (dir) => runRepoContractInDir(agent, dir));
}

function runRepoContractInDir(agent, dir) {
	git(dir, "init", "-q", "-b", "main");
	const tools = agent === "pi" ? "codex,pi" : agent;
	const initArgs = [CLI, "init", dir, "--tools", tools];
	if (agent === "pi") initArgs.push("--session-hook", "--stop-hook");
	execFileSync(process.execPath, initArgs, {
		stdio: "pipe",
	});
	if (agent === "pi" && fs.existsSync(path.join(dir, ".pi", "skills"))) {
		throw new Error("Pi contract fixture created a duplicate .pi/skills registry");
	}
	const skillPath = path.join(
		dir,
		agent === "claude" ? ".claude" : ".agents",
		"skills",
		"stdd-start-change",
		"SKILL.md",
	);
	const proof = installContractProbe(skillPath);
	fs.writeFileSync(path.join(dir, "README.md"), "# Contract fixture\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "fixture");
	if (agent === "pi") installPiLifecycleProbeCli(dir);

	const prompt = createContractPrompt(agent);
	const command =
		agent === "claude"
			? {
					bin: process.env.STDD_CLAUDE_BIN || "claude",
					args: [
						"-p",
						"--permission-mode",
						"plan",
						"--output-format",
						"stream-json",
						"--verbose",
						prompt,
					],
				}
			: agent === "pi"
				? {
						bin: process.env.STDD_PI_BIN || "pi",
						args: ["--mode", "json", "--no-session", "--approve", "--no-tools", "--offline", prompt],
					}
				: {
						bin: process.env.STDD_CODEX_BIN || "codex",
						args: createCodexRepositoryProofArgs(prompt),
					};
	assertCliAvailable(command.bin, agent);
	const run = runChecked(command.bin, command.args, {
		cwd: dir,
		label: `${agent} contract runner`,
		timeout: 180_000,
	});
	// Every runner promises JSONL on stdout. Stderr is diagnostic-only and must
	// never be able to forge a structured assistant event.
	if (agent === "pi" && /\b(?:skill\s+)?collision\b/i.test(run.stderr ?? "")) {
		throw new Error(`Pi reported a skill collision: ${run.stderr.trim()}`);
	}
	const transcript = run.stdout ?? "";
	if (agent === "pi") assertPiLifecycleCapture(transcript);
	assertContractTranscript({ agent, proof, transcript });
	assertFixtureClean(dir, agent);
	console.log(`${agent}: explicit skill discovery contract passed`);
}

function seedCodexAuth(codexHome) {
	const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
	const source = path.join(sourceHome, "auth.json");
	if (!fs.existsSync(source)) return;
	const target = path.join(codexHome, "auth.json");
	fs.copyFileSync(source, target);
	fs.chmodSync(target, 0o600);
}

function installPluginMarketplace(marketplaceRoot, pluginRoot) {
	const marketplaceDir = path.join(marketplaceRoot, ".agents", "plugins");
	const packagedPlugin = path.join(marketplaceRoot, "plugins", "stdd");
	fs.mkdirSync(marketplaceDir, { recursive: true });
	fs.mkdirSync(path.dirname(packagedPlugin), { recursive: true });
	fs.cpSync(pluginRoot, packagedPlugin, { recursive: true });
	fs.writeFileSync(
		path.join(marketplaceDir, "marketplace.json"),
		`${JSON.stringify(
			{
				name: "stdd-contract",
				interface: { displayName: "STDD Contract" },
				plugins: [
					{
						name: "stdd",
						source: { source: "local", path: "./plugins/stdd" },
						policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
						category: "Productivity",
					},
				],
			},
			null,
			"\t",
		)}\n`,
	);
	return packagedPlugin;
}

function installCaptureCli(dir, capturePath) {
	const installedCli = path.join(dir, "node_modules", "@stdd", "cli", "cli", "stdd.mjs");
	fs.mkdirSync(path.dirname(installedCli), { recursive: true });
	fs.writeFileSync(
		installedCli,
		[
			'import fs from "node:fs";',
			`const capture = ${JSON.stringify(capturePath)};`,
			'const input = fs.readFileSync(0, "utf8");',
			"fs.appendFileSync(capture, `${JSON.stringify({",
			"  argv: process.argv.slice(2),",
			"  cwd: process.cwd(),",
			"  input,",
			"})}\\n`);",
			'process.stdout.write(process.argv[2] === "stop-hook" ? "{}\\n" : "plugin session hook active\\n");',
		].join("\n"),
	);
}

function runCodexPluginContract() {
	const codexBin = process.env.STDD_CODEX_BIN || "codex";
	assertCliAvailable(codexBin, "codex");
	runChecked(codexBin, ["plugin", "--help"], {
		label: "Codex plugin host availability check",
		timeout: 10_000,
	});

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-codex-plugin-contract-"));
	const marketplaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-marketplace-"));
	const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-codex-home-"));
	fs.chmodSync(codexHome, 0o700);
	const capturePath = path.join(dir, ".stdd", "plugin-hook-capture.jsonl");
	try {
		git(dir, "init", "-q", "-b", "main");
		fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
		installCaptureCli(dir, capturePath);
		fs.writeFileSync(path.join(dir, "README.md"), "# Plugin contract fixture\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "fixture");

		const packagedPlugin = installPluginMarketplace(marketplaceRoot, PLUGIN_ROOT);
		const proof = installContractProbe(
			path.join(packagedPlugin, "skills", "stdd-start-change", "SKILL.md"),
		);
		seedCodexAuth(codexHome);
		const env = { ...process.env, CODEX_HOME: codexHome };
		runChecked(codexBin, ["plugin", "marketplace", "add", marketplaceRoot, "--json"], {
			env,
			label: "temporary STDD plugin marketplace install",
		});
		runChecked(codexBin, ["plugin", "add", "stdd@stdd-contract", "--json"], {
			env,
			label: "temporary STDD plugin install",
		});
		const listed = runChecked(codexBin, ["plugin", "list", "--json"], {
			env,
			label: "temporary STDD plugin discovery",
		});
		let inventory;
		try {
			inventory = JSON.parse(listed.stdout);
		} catch {
			throw new Error("temporary STDD plugin discovery returned malformed JSON");
		}
		if (!JSON.stringify(inventory.installed ?? []).includes('"stdd"')) {
			throw new Error("Codex plugin host did not list the installed STDD plugin");
		}

		const proofRun = runChecked(
			codexBin,
			createCodexPluginProofArgs(createContractPrompt("codex-plugin")),
			{
				cwd: dir,
				env,
				label: "codex installed-plugin contract runner",
				timeout: 180_000,
			},
		);
		assertContractTranscript({ agent: "codex", proof, transcript: proofRun.stdout ?? "" });

		// Installing a plugin deliberately does not persist trust for its hooks.
		// Keep hook execution in a separate invocation: the package and capture
		// command are harness-owned and vetted, while its bypass warning/error
		// transcript can never count as native skill-discovery proof.
		runChecked(
			codexBin,
			createCodexPluginHookArgs(
				"Reply with exactly stdd-hook-contract-ok and do not use tools or commands.",
			),
			{
				cwd: dir,
				env,
				label: "codex installed-plugin lifecycle contract runner",
				timeout: 180_000,
			},
		);
		const capture = fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf8") : "";
		assertPluginHookCapture(capture, dir);
		fs.rmSync(capturePath);
		assertFixtureClean(dir, "codex installed plugin");
		console.log("codex-plugin: installed skill and lifecycle hook discovery contracts passed");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(marketplaceRoot, { recursive: true, force: true });
		fs.rmSync(codexHome, { recursive: true, force: true });
	}
}

for (const target of targets) {
	if (target === "codex-plugin") runCodexPluginContract();
	else runRepoContract(target);
}
