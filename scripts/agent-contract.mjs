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
	createClaudeProofArgs,
	createCodexPluginHookArgs,
	createCodexPluginProofArgs,
	createCodexRepositoryProofArgs,
	createContractPrompt,
	createPiProofArgs,
	DEFAULT_CONTRACT_TARGETS,
	installContractProbe,
	PI_LIFECYCLE_PROBE,
	withContractFixture,
} from "./agent-contract-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "stdd.mjs");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "stdd");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

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
					args: createClaudeProofArgs(prompt),
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
	// never be able to forge a structured assistant event — which is also why
	// nothing here watches it for a same-name skill overlap: Pi reports that on
	// interactive startup only, so a non-interactive run leaves stderr empty
	// whether or not an overlap exists. The `pi-plugin-contract` target proves
	// the resolution instead, by which probe the transcript comes back with.
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

// A catalog the shipping repository carries but no host can read is exactly
// the defect this contract exists to catch, so the temporary marketplace holds
// the real file rather than a hand-written copy of it. Only the plugin beneath
// the catalog is instrumented; the catalog itself installs as published, and
// the install identifier is read back out of it instead of being restated
// here.
function installMarketplaceCatalog(marketplaceRoot, pluginRoot, catalogPath) {
	const source = path.join(ROOT, catalogPath);
	const target = path.join(marketplaceRoot, catalogPath);
	const packagedPlugin = path.join(marketplaceRoot, "plugins", "stdd");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.mkdirSync(path.dirname(packagedPlugin), { recursive: true });
	fs.cpSync(pluginRoot, packagedPlugin, { recursive: true });
	fs.copyFileSync(source, target);
	const catalog = JSON.parse(fs.readFileSync(source, "utf8"));
	if (!Array.isArray(catalog.plugins) || catalog.plugins.length !== 1) {
		throw new Error(`${catalogPath} must list exactly one plugin for the contract harness`);
	}
	return { packagedPlugin, pluginId: `${catalog.plugins[0].name}@${catalog.name}` };
}

function installCaptureCli(pluginRoot, capturePath, sessionOutput = "plugin session hook active") {
	const installedCli = path.join(pluginRoot, "runtime", "cli", "stdd.mjs");
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
			`process.stdout.write(process.argv[2] === "stop-hook" ? "{}\\n" : ${JSON.stringify(`${sessionOutput}\n`)});`,
		].join("\n"),
	);
}

function seedClaudeAuth(claudeHome) {
	const sourceHome = path.join(os.homedir(), ".claude");
	const source = path.join(sourceHome, ".credentials.json");
	if (!fs.existsSync(source)) return;
	const target = path.join(claudeHome, ".credentials.json");
	fs.copyFileSync(source, target);
	fs.chmodSync(target, 0o600);
}

function runClaudePluginContract() {
	const claudeBin = process.env.STDD_CLAUDE_BIN || "claude";
	assertCliAvailable(claudeBin, "claude");
	runChecked(claudeBin, ["plugin", "--help"], {
		label: "Claude plugin host availability check",
		timeout: 10_000,
	});

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-claude-plugin-contract-"));
	const marketplaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-claude-marketplace-"));
	const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-claude-home-"));
	fs.chmodSync(claudeHome, 0o700);
	const capturePath = path.join(dir, ".stdd", "plugin-hook-capture.jsonl");
	try {
		git(dir, "init", "-q", "-b", "main");
		fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
		fs.writeFileSync(path.join(dir, "README.md"), "# Plugin contract fixture\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "fixture");

		const { packagedPlugin, pluginId } = installMarketplaceCatalog(
			marketplaceRoot,
			PLUGIN_ROOT,
			path.join(".claude-plugin", "marketplace.json"),
		);
		installCaptureCli(packagedPlugin, capturePath);
		const proof = installContractProbe(
			path.join(packagedPlugin, "skills", "stdd-start-change", "SKILL.md"),
		);
		seedClaudeAuth(claudeHome);
		const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };
		runChecked(claudeBin, ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "user"], {
			env,
			label: "temporary Claude STDD marketplace install",
		});
		runChecked(claudeBin, ["plugin", "install", pluginId, "--scope", "user"], {
			env,
			label: "temporary Claude STDD plugin install",
		});
		const listed = runChecked(claudeBin, ["plugin", "list", "--json"], {
			env,
			label: "temporary Claude STDD plugin discovery",
		});
		if (!listed.stdout.includes(pluginId)) {
			throw new Error("Claude plugin host did not list the installed STDD plugin");
		}
		const run = runChecked(claudeBin, createClaudeProofArgs(createContractPrompt("claude-plugin")), {
			cwd: dir,
			env,
			label: "claude installed-plugin contract runner",
			timeout: 180_000,
		});
		assertContractTranscript({ agent: "claude", proof, transcript: run.stdout ?? "" });
		const capture = fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf8") : "";
		assertPluginHookCapture(capture, dir, "claude", { exact: true });
		fs.rmSync(capturePath);
		assertFixtureClean(dir, "claude installed plugin");
		console.log("claude-plugin: installed skill and lifecycle hook discovery contracts passed");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(marketplaceRoot, { recursive: true, force: true });
		fs.rmSync(claudeHome, { recursive: true, force: true });
	}
}

function seedPiAuth(piHome) {
	const source = path.join(os.homedir(), ".pi", "agent", "auth.json");
	if (!fs.existsSync(source)) return;
	const target = path.join(piHome, "auth.json");
	fs.copyFileSync(source, target);
	fs.chmodSync(target, 0o600);
}

// Pi registers a bundle's skills into the same flat registry an initialized
// repository generates into, so the two adoption modes overlap by name. With
// `adopted`, the fixture carries both copies and each gets its own probe: the
// transcript can then only carry the repository's, which is what "the
// repository definition wins" means in a form a host can be held to.
function runPiPluginContract({ adopted = false } = {}) {
	const target = adopted ? "pi-plugin-contract" : "pi-plugin";
	const piBin = process.env.STDD_PI_BIN || "pi";
	assertCliAvailable(piBin, "pi");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stdd-${target}-`));
	const packagedPlugin = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-pi-package-"));
	const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-pi-home-"));
	fs.chmodSync(piHome, 0o700);
	const capturePath = path.join(dir, ".stdd", "plugin-hook-capture.jsonl");
	try {
		git(dir, "init", "-q", "-b", "main");
		if (adopted) {
			// The adopted fixture is a repository that ran init, so it generates
			// its own `.agents/skills` alongside the installed bundle's.
			execFileSync(process.execPath, [CLI, "init", dir, "--tools", "codex,pi"], {
				stdio: "pipe",
			});
		} else {
			fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
		}
		// The bundle keeps its own probe in the adopted fixture too. Asserting the
		// repository's proof is what proves precedence: a transcript carrying the
		// bundle's would mean the losing copy was loaded. It is written before the
		// fixture commit so the repository still ends the run clean.
		const repositoryProof = adopted
			? installContractProbe(path.join(dir, ".agents", "skills", "stdd-start-change", "SKILL.md"))
			: null;
		fs.writeFileSync(path.join(dir, "README.md"), "# Plugin contract fixture\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "fixture");
		fs.cpSync(PLUGIN_ROOT, packagedPlugin, { recursive: true });
		installCaptureCli(packagedPlugin, capturePath, PI_LIFECYCLE_PROBE);
		const bundleProof = installContractProbe(
			path.join(packagedPlugin, "skills", "stdd-start-change", "SKILL.md"),
		);
		const proof = repositoryProof ?? bundleProof;
		seedPiAuth(piHome);
		const env = { ...process.env, PI_CODING_AGENT_DIR: piHome };
		runChecked(piBin, ["install", packagedPlugin, "--approve"], {
			cwd: dir,
			env,
			label: "temporary Pi STDD package install",
		});
		const run = runChecked(piBin, createPiProofArgs(createContractPrompt(target)), {
			cwd: dir,
			env,
			label: adopted
				? "pi bundle-over-contract precedence runner"
				: "pi installed-package contract runner",
			timeout: 180_000,
		});
		assertPiLifecycleCapture(run.stdout ?? "");
		assertContractTranscript({ agent: "pi", proof, transcript: run.stdout ?? "" });
		const capture = fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf8") : "";
		const calls = capture
			.split(/\r?\n/u)
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
		if (!calls.some((event) => event.cwd === dir && event.argv?.join(" ") === "status --local")) {
			throw new Error("Pi package host did not execute the bundled lifecycle runtime");
		}
		fs.rmSync(capturePath);
		assertFixtureClean(dir, "pi installed package");
		console.log(
			adopted
				? "pi-plugin-contract: repository skill precedence and bundled lifecycle contracts passed"
				: "pi-plugin: installed package skill and lifecycle contracts passed",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(packagedPlugin, { recursive: true, force: true });
		fs.rmSync(piHome, { recursive: true, force: true });
	}
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
		fs.writeFileSync(path.join(dir, "README.md"), "# Plugin contract fixture\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "fixture");

		const { packagedPlugin, pluginId } = installMarketplaceCatalog(
			marketplaceRoot,
			PLUGIN_ROOT,
			path.join(".agents", "plugins", "marketplace.json"),
		);
		installCaptureCli(packagedPlugin, capturePath);
		const proof = installContractProbe(
			path.join(packagedPlugin, "skills", "stdd-start-change", "SKILL.md"),
		);
		seedCodexAuth(codexHome);
		const env = { ...process.env, CODEX_HOME: codexHome };
		runChecked(codexBin, ["plugin", "marketplace", "add", marketplaceRoot, "--json"], {
			env,
			label: "temporary STDD plugin marketplace install",
		});
		runChecked(codexBin, ["plugin", "add", pluginId, "--json"], {
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

// One entry per target, so a target added to the supported list without a
// runner is a missing key rather than a silent fall-through into the
// repository runner — where it would surface only during an opt-in run against
// a live CLI. `runners` is injectable so an ordinary test run can prove the
// routing without starting a host.
export function contractRunners() {
	return Object.freeze({
		claude: () => runRepoContract("claude"),
		codex: () => runRepoContract("codex"),
		pi: () => runRepoContract("pi"),
		"codex-plugin": () => runCodexPluginContract(),
		"claude-plugin": () => runClaudePluginContract(),
		"pi-plugin": () => runPiPluginContract(),
		"pi-plugin-contract": () => runPiPluginContract({ adopted: true }),
	});
}

export function dispatchContractTargets(targets, runners = contractRunners()) {
	for (const target of targets) assertContractTarget(target);
	for (const target of targets) {
		const run = runners[target];
		if (typeof run !== "function") {
			throw new Error(`contract target ${JSON.stringify(target)} has no runner`);
		}
		run();
	}
}

// Importing this module must start nothing: the unit tests read its routing,
// while only a direct invocation runs a contract against an installed CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const requested = process.argv.slice(2);
	const targets = requested.length > 0 ? requested : DEFAULT_CONTRACT_TARGETS;
	for (const target of targets) assertContractTarget(target);

	if (process.env.STDD_AGENT_CONTRACT !== "1") {
		console.error(
			"agent contract tests call installed model-backed CLIs; opt in with STDD_AGENT_CONTRACT=1",
		);
		process.exit(2);
	}
	dispatchContractTargets(targets);
}
