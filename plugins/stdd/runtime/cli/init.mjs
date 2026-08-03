import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
	AGENT_ADAPTERS,
	CI_ADAPTERS,
	CROSS_CLI_REVIEW_VIA_TOKEN,
	getAgentAdapter,
	MANDATORY_ROUTING_SKILLS,
	renderAgentInstructions,
	renderAgentSkill,
	renderCiTemplate,
} from "../sdk/adapters.mjs";
import { resolveWritableRepoPath } from "../sdk/path.mjs";
import { hasLocalStddBinary, isStddSourceCheckout, prepareAgentHooks } from "./claude-hooks.mjs";
import { loadConfig } from "./config.mjs";
import {
	finalizeGeneratedFilesWithCapabilities,
	KNOWN_CAPABILITIES,
	KNOWN_TOOLS,
	loadLocalPlaybooks,
	loadPlaybooks,
	NATIVE_MANIFEST_IDENTITY,
	NPM_RUNNER,
	PKG_ROOT,
	readManifestDocument,
	readManifestDocumentWithCapabilities,
	recoverCleanupJournalWithCapabilities,
	renderInstalledMethod,
	SOURCE_RUNNER,
	STAMP,
	VERSION,
	validateAdapterSelection,
} from "./generated-files.mjs";
import {
	openNativeRepoMutation,
	openOrCreateNativeRepoDirectory,
	preflightNativeRepoDestination,
	publishNativeRepoFile,
	readOptionalNativeRepoFile,
} from "./held-fs.mjs";
import {
	LEDGER_REL,
	LEDGER_RESET_TEMP_GIT_GLOB,
	LEGACY_LEDGER_RESET_TEMP_IGNORE,
	PLAN_REL,
	REVIEW_VIAS,
} from "./ledger.mjs";
import { compileCapabilities, DEFAULT_CONFIG, mergeConfig, sha256 } from "./lib.mjs";
import { fail } from "./runtime.mjs";
import { WORKER_DELETIONS_REL } from "./worker-fs.mjs";
import { WORKER_METADATA_REL } from "./worker-metadata.mjs";

const UNINSPECTED_CONFIG = Symbol("uninspected config");
const PRE_PUSH_HEADER =
	"#!/bin/sh\n# user-owned after generation — append your own steps freely\n" +
	"# project-local/offline only: the explicit scoped package can never resolve unscoped `stdd`\n";

// Seeded once, then owned by the repository. Both headings ship empty: an
// entry is a decision someone made, never a default the kit assumed.
const POLICY_SEED =
	"# Project policy\n\n" +
	"Standing decisions for this repository. A note records nuance and grants\n" +
	"nothing. A permission grants one action, and names the condition a session\n" +
	"must verify before acting on it.\n\n" +
	"Record them with `stdd policy add <text>` and\n" +
	'`stdd policy allow <action> --when "<condition>"`.\n\n' +
	"## Permissions\n\n## Notes\n";

function prePushHook(runner) {
	return `${PRE_PUSH_HEADER}${runner} check . || exit 1\n`;
}

function isGeneratedPrePushHook(content) {
	const command = content.slice(PRE_PUSH_HEADER.length);
	return (
		content.startsWith(PRE_PUSH_HEADER) &&
		(command === `${SOURCE_RUNNER} check . || exit 1\n` ||
			/^npm exec --offline (?:(?:--package=@stdd\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? )?-- stdd) check \. \|\| exit 1\n$/.test(
				command,
			))
	);
}

/**
 * `--capabilities <list>`: write the full profile into the user-owned
 * config — named capabilities on, every other known one off. Other config
 * keys survive untouched.
 */
function preservedPublicationMode(state, fallback, label) {
	if (!state || state.file.observation.identity.platform === "win32") return fallback;
	const mode = Number(state.file.observation.permissions) & 0o777;
	if (![0o600, 0o644, 0o755].includes(mode)) {
		throw new Error(
			`${label} has unsupported mode ${mode.toString(8)}; preserve it manually before retrying`,
		);
	}
	return mode;
}

async function readConfigForWrite(context, inspectedState = UNINSPECTED_CONFIG) {
	const state =
		inspectedState !== UNINSPECTED_CONFIG
			? inspectedState
			: await readOptionalNativeRepoFile(context, ".stdd/config.json", {
					label: "config path",
				});
	let parsed = { ...DEFAULT_CONFIG };
	if (state) {
		try {
			parsed = JSON.parse(state.bytes.toString("utf8"));
		} catch (err) {
			fail(`.stdd/config.json is not valid JSON: ${err.message}`);
		}
	}
	try {
		mergeConfig(parsed);
	} catch (err) {
		fail(`.stdd/config.json: ${err.message}`);
	}
	return { parsed, state };
}

async function publishConfig(context, parsed, state) {
	const content = Buffer.from(`${JSON.stringify(parsed, null, "\t")}\n`);
	const file = await publishNativeRepoFile(context, ".stdd/config.json", content, {
		mode: preservedPublicationMode(state, 0o644, ".stdd/config.json"),
		tempPrefix: ".config-",
		expectedTarget: state?.file.observation.identity ?? null,
		expectedBytes: state?.bytes ?? null,
	});
	return { file, bytes: content };
}

async function writeCapabilities(context, list, inspectedState) {
	const { parsed, state } = await readConfigForWrite(context, inspectedState);
	parsed.capabilities = Object.fromEntries(KNOWN_CAPABILITIES.map((c) => [c, list.includes(c)]));
	return publishConfig(context, parsed, state);
}

/** Set review.via (and optionally the budget) in the user-owned config,
 * preserving every other key. */
async function writeReviewVia(context, via, maxRounds = null, inspectedState) {
	const { parsed, state } = await readConfigForWrite(context, inspectedState);
	parsed.review = {
		...(parsed.review ?? {}),
		via,
		...(maxRounds !== null ? { maxRounds } : {}),
	};
	return publishConfig(context, parsed, state);
}

/**
 * `--interview`: one question at a time, the recommended answer first —
 * an empty answer takes it. Piped answers work; a stream that ends early
 * resolves every remaining question to its default.
 */
function makePrompter() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// Own line queue instead of rl.question: piped answers arrive in one
	// burst, and lines emitted while no question is pending would be lost.
	const lines = [];
	const waiters = [];
	let closed = false;
	rl.on("line", (line) => {
		const waiter = waiters.shift();
		if (waiter) waiter(line);
		else lines.push(line);
	});
	rl.on("close", () => {
		closed = true;
		while (waiters.length > 0) waiters.shift()("");
	});
	const readLine = () => {
		if (lines.length > 0) return Promise.resolve(lines.shift());
		if (closed) return Promise.resolve("");
		return new Promise((resolve) => waiters.push(resolve));
	};
	const ask = async (question, def) => {
		process.stdout.write(question);
		const answer = (await readLine()).trim();
		return answer === "" ? def : answer;
	};
	const yes = async (question, def) =>
		/^y/i.test(await ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `, def ? "y" : "n"));
	return { ask, yes, close: () => rl.close() };
}

/** The reviewer-route question, shared by init --interview and configure. */
async function askReviewVia(ask, close, def) {
	const via = await ask(`Independent reviewer route (${REVIEW_VIAS.join("/")}) [${def}]: `, def);
	if (!REVIEW_VIAS.includes(via)) {
		close();
		fail(`unknown review route "${via}" (known: ${REVIEW_VIAS.join(", ")})`);
	}
	return via;
}

function recommendedReviewVia(tools, capabilities) {
	if (capabilities.crossCli) {
		return getAgentAdapter(tools[0]).crossCliReviewVia;
	}
	if (capabilities.subagents) return "subagent";
	return DEFAULT_CONFIG.review.via;
}

export async function interview() {
	const { ask, yes, close } = makePrompter();

	console.log("stdd init — one question at a time; an empty answer takes the recommended default\n");
	const toolsAnswer = await ask(
		`Agents to compile for (${KNOWN_TOOLS.join(", ")}) [${KNOWN_TOOLS.join(",")}]: `,
		KNOWN_TOOLS.join(","),
	);
	const tools = toolsAnswer
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	try {
		validateAdapterSelection("tools", tools, KNOWN_TOOLS, { nonEmpty: true });
	} catch (err) {
		close();
		fail(err.message);
	}
	const capabilitiesList = [];
	if (await yes("Can agents dispatch subagents?", true)) capabilitiesList.push("subagents");
	if (await yes("May selected agent CLIs invoke a second reviewer CLI?", false))
		capabilitiesList.push("crossCli");
	if (await yes("Are isolated git worktrees available?", true)) capabilitiesList.push("worktrees");
	const capabilities = Object.fromEntries(
		KNOWN_CAPABILITIES.map((capability) => [capability, capabilitiesList.includes(capability)]),
	);
	// The first selected native host is the driver for the repository-level
	// default. Generated skills still carry a per-host explicit override.
	const reviewVia = await askReviewVia(ask, close, recommendedReviewVia(tools, capabilities));
	const ci = (await yes("Install the GitHub Actions gate (stdd check + PR evidence)?", true))
		? ["github"]
		: [];
	const hooks = await yes("Install the pre-push hook (stdd check — fast, offline)?", true);
	const sessionHook =
		tools.length > 0 ? await yes("Wire native agent session hooks (stdd status --local)?", true) : false;
	const stopHook =
		tools.length > 0
			? await yes("Wire native agent stop integrations (gate or corrective continuation)?", false)
			: false;
	close();
	const hasDispatch = capabilitiesList.includes("subagents") || capabilitiesList.includes("crossCli");
	if (
		hasDispatch &&
		(reviewVia === "codex" || reviewVia === "claude") &&
		!capabilitiesList.includes("crossCli")
	) {
		fail(
			`review route "${reviewVia}" needs the crossCli capability — answer y to cross-CLI or pick subagent`,
		);
	}
	if (hasDispatch && reviewVia === "subagent" && !capabilitiesList.includes("subagents")) {
		fail(
			`review route "subagent" needs the subagents capability — answer y to subagents or pick another route`,
		);
	}
	return {
		tools,
		ci,
		hooks,
		sessionHook,
		stopHook,
		capabilitiesList,
		reviewVia,
	};
}

/**
 * `stdd configure` — the interview again, over an existing install:
 * current values are the defaults, only the capability profile and the
 * review route are edited, every other config key is preserved, and the
 * same generated targets (remembered in the manifest) are recompiled.
 * Never changes CI target selection or removes hook files. A remembered Stop
 * hook is maintained, and --stop-hook is the explicit opt-in that may add it.
 */
export async function configure(targetDir, opts) {
	const configPath = path.join(targetDir, ".stdd", "config.json");
	if (!fs.existsSync(configPath)) {
		fail(
			"no .stdd/config.json here — `stdd configure` edits an existing install; run `stdd init` first",
		);
	}
	const config = loadConfig(targetDir);
	let targets = null;
	let manifestFiles = null;
	let manifest = null;
	try {
		manifest = readManifestDocument(targetDir);
	} catch (err) {
		fail(`.stdd/manifest.json ${err.message}`);
	}
	if (manifest && Object.hasOwn(manifest, "targets")) {
		targets = manifest.targets;
	} else if (manifest) {
		manifestFiles = Object.keys(manifest.files);
	}
	// installs made before targets were remembered: infer what the previous
	// init actually GENERATED from manifest.files — live directories lie (a
	// stray empty .claude/skills must not smuggle claude in) and an
	// inferred blank would make the stale-file cleanup delete the CI
	// workflow. The filesystem is the last resort with no usable manifest;
	// hook files and settings entries are user-owned, never
	// manifest-tracked, so they are always read from their files.
	if (!targets) {
		const tools = [];
		const ci = [];
		const skillRootCounts = new Map();
		for (const adapter of Object.values(AGENT_ADAPTERS)) {
			skillRootCounts.set(adapter.skillRoot, (skillRootCounts.get(adapter.skillRoot) ?? 0) + 1);
		}
		if (manifestFiles) {
			for (const adapter of Object.values(AGENT_ADAPTERS)) {
				const ownsDistinctSkillRoot = skillRootCounts.get(adapter.skillRoot) === 1;
				if (
					manifestFiles.includes(adapter.snippetFile) ||
					(ownsDistinctSkillRoot &&
						manifestFiles.some((file) => file.startsWith(`${adapter.skillRoot}/`)))
				) {
					tools.push(adapter.id);
				}
			}
			for (const adapter of Object.values(CI_ADAPTERS)) {
				if (adapter.outputFile && manifestFiles.includes(adapter.outputFile)) ci.push(adapter.id);
			}
		} else {
			for (const adapter of Object.values(AGENT_ADAPTERS)) {
				const ownsDistinctSkillRoot = skillRootCounts.get(adapter.skillRoot) === 1;
				if (
					fs.existsSync(path.join(targetDir, adapter.snippetFile)) ||
					(ownsDistinctSkillRoot && fs.existsSync(path.join(targetDir, adapter.skillRoot)))
				) {
					tools.push(adapter.id);
				}
			}
			for (const adapter of Object.values(CI_ADAPTERS)) {
				if (adapter.outputFile && fs.existsSync(path.join(targetDir, adapter.outputFile))) {
					ci.push(adapter.id);
				}
			}
		}
		let settingsText = "";
		for (const relative of new Set(Object.values(AGENT_ADAPTERS).map((adapter) => adapter.hooksFile))) {
			try {
				settingsText += fs.readFileSync(path.join(targetDir, relative), "utf8");
			} catch {
				// absent agent settings do not imply hooks
			}
		}
		targets = {
			tools: tools.length > 0 ? tools : ["claude"],
			ci,
			hooks: fs.existsSync(path.join(targetDir, ".stdd", "hooks", "pre-push")),
			sessionHook:
				settingsText.includes("stdd status") ||
				(settingsText.includes("STDD managed Pi lifecycle extension") &&
					settingsText.includes('pi.on("session_start"')),
			stopHook:
				settingsText.includes("stdd stop-hook") ||
				(settingsText.includes("STDD managed Pi lifecycle extension") &&
					settingsText.includes('pi.on("agent_settled"')),
		};
	}
	let capabilitiesList = opts.capabilitiesList ?? null;
	let reviewVia = opts.reviewVia ?? null;
	let maxRounds = opts.maxRounds ?? null;
	let stopHook = Boolean(opts.stopHook);
	const interactive = !capabilitiesList && !reviewVia && maxRounds === null && !stopHook;
	if (interactive) {
		const { ask, yes, close } = makePrompter();
		console.log("stdd configure — one question at a time; an empty answer keeps the current value\n");
		capabilitiesList = [];
		if (await yes("Can agents dispatch subagents?", config.capabilities.subagents))
			capabilitiesList.push("subagents");
		if (await yes("May selected agent CLIs invoke a second reviewer CLI?", config.capabilities.crossCli))
			capabilitiesList.push("crossCli");
		if (await yes("Are isolated git worktrees available?", config.capabilities.worktrees))
			capabilitiesList.push("worktrees");
		reviewVia = await askReviewVia(ask, close, config.review.via);
		const current = config.review.maxRounds ?? 0;
		const budgetAnswer = await ask(
			`Review budget — changes-requested rounds before refusal (0 = unlimited) [${current}]: `,
			String(current),
		);
		maxRounds = Number(budgetAnswer);
		if (!/^\d+$/.test(budgetAnswer) || !Number.isSafeInteger(maxRounds)) {
			close();
			fail("the review budget must be a non-negative safe integer (0 = unlimited)");
		}
		if (targets.tools.length > 0 && !targets.stopHook) {
			stopHook = await yes(
				"Wire native agent stop integrations (gate or corrective continuation)?",
				false,
			);
		}
		close();
	}
	// validate the combination BEFORE any write — no partial configuration
	const caps = capabilitiesList
		? Object.fromEntries(KNOWN_CAPABILITIES.map((c) => [c, capabilitiesList.includes(c)]))
		: config.capabilities;
	const via = reviewVia ?? config.review.via;
	const hasDispatch = caps.subagents || caps.crossCli;
	if (hasDispatch && (via === "codex" || via === "claude") && !caps.crossCli) {
		fail(`review.via "${via}" needs the crossCli capability — pick another route or enable crossCli`);
	}
	if (hasDispatch && via === "subagent" && !caps.subagents) {
		fail(
			`review.via "subagent" needs the subagents capability — pick another route or enable subagents`,
		);
	}
	const desiredStopHook = stopHook || targets.stopHook;
	const existingCi = targets.ci.filter((provider) => {
		const outputFile = CI_ADAPTERS[provider].outputFile;
		return outputFile === null || fs.existsSync(path.join(targetDir, outputFile));
	});
	await init(targetDir, {
		tools: targets.tools,
		ci: existingCi,
		rememberedCiTargets: targets.ci,
		hooks: false,
		sessionHook: false,
		stopHook: desiredStopHook,
		rememberedHookTargets: {
			hooks: targets.hooks,
			sessionHook: targets.sessionHook,
			stopHook: desiredStopHook,
		},
		capabilitiesList: capabilitiesList ?? Object.keys(caps).filter((c) => caps[c]),
		reviewVia: via,
		reviewMaxRounds: maxRounds,
	});
}

export async function init(targetDir, opts) {
	const { tools, ci, hooks, sessionHook, capabilitiesList } = opts;
	const stopHook = Boolean(opts.stopHook);
	const rememberedCiTargets = opts.rememberedCiTargets ?? ci;
	const rememberedHookTargets = opts.rememberedHookTargets ?? {
		hooks: Boolean(hooks),
		sessionHook: Boolean(sessionHook),
		stopHook,
	};
	const automationRunner = isStddSourceCheckout(targetDir) ? SOURCE_RUNNER : NPM_RUNNER;
	try {
		resolveWritableRepoPath(targetDir, ".stdd", "stdd install path");
	} catch (err) {
		fail(err.message);
	}
	// Config is user-owned input. Validate it before loading playbooks,
	// inspecting manifests, or writing any generated/install state.
	const existingConfig = loadConfig(targetDir);
	// A previous crash or publish failure is settled before this run reads
	// dynamic paths below. An unprovable inode or parent identity blocks init
	// with the journal as the authoritative diagnostic.
	// Validate every repo-authored dynamic path before the first write. A
	// cloned repository must not turn `stdd init` into an arbitrary writer.
	const local = loadLocalPlaybooks(targetDir);
	let previousManifest;
	try {
		previousManifest = readManifestDocument(targetDir);
	} catch (error) {
		fail(`.stdd/manifest.json ${error.message}`);
	}
	let oldFiles = previousManifest?.files ?? Object.create(null);
	let oldQuarantineIdentities = previousManifest?.quarantineIdentities ?? Object.create(null);
	let previouslyRetainedCleanupJournals = Object.keys(oldFiles).filter((relative) =>
		relative.split("/").some((segment) => /^\.stdd-cleanup-journal-[0-9a-f]{32}\.tmp$/.test(segment)),
	);
	// A same-name local recipe always replaces the kit recipe. Capability
	// filtering happens afterwards, so an inactive local override intentionally
	// leaves an optional skill absent instead of silently falling back to the kit.
	const capabilities = capabilitiesList
		? Object.fromEntries(KNOWN_CAPABILITIES.map((c) => [c, capabilitiesList.includes(c)]))
		: existingConfig.capabilities;
	const reviewVia =
		opts.reviewVia ??
		(capabilitiesList && (capabilities.crossCli || capabilities.subagents)
			? recommendedReviewVia(tools, capabilities)
			: null);
	const agentNeutralReviewVia = reviewVia ?? existingConfig.review.via;
	const applies = (pb) => {
		if (!pb.meta.requires) return true;
		if (!KNOWN_CAPABILITIES.includes(pb.meta.requires)) {
			fail(`playbook ${pb.file}: requires unknown capability "${pb.meta.requires}"`);
		}
		return capabilities[pb.meta.requires];
	};
	const compile = (pb, text) => {
		try {
			return compileCapabilities(text, capabilities);
		} catch (err) {
			throw new Error(`playbook ${pb.file}: ${err.message}`, { cause: err });
		}
	};
	const localNames = new Set(local.map((pb) => pb.meta.name));
	const localActive = local.filter(applies);
	const kitActive = loadPlaybooks()
		.filter(applies)
		.filter((pb) => {
			if (!localNames.has(pb.meta.name)) return true;
			console.log(`local recipe overrides the kit playbook "${pb.meta.name}" (${pb.file})`);
			return false;
		});
	const activeNames = new Set([...kitActive, ...localActive].map((pb) => pb.meta.name));
	for (const name of MANDATORY_ROUTING_SKILLS) {
		if (!activeNames.has(name)) {
			fail(
				`mandatory routing skill "${name}" is inactive; capability profiles and local overrides must keep every managed agent route available`,
			);
		}
	}

	// Compile and render every dynamic source before opening the mutating
	// helper session. A malformed playbook, capability block, or CI template
	// must not leave a partial installation behind.
	const compiledPlaybooks = new Map(
		[...kitActive, ...localActive].map((pb) => [
			pb,
			{ source: compile(pb, pb.source), body: compile(pb, pb.body) },
		]),
	);
	const toolPlans = new Map();
	for (const tool of tools) {
		const adapter = getAgentAdapter(tool);
		const skills = new Map();
		for (const pb of [...kitActive, ...localActive]) {
			skills.set(
				pb,
				renderAgentSkill({
					adapter: tool,
					name: pb.meta.name,
					description: pb.meta.description,
					when: pb.meta.when,
					body: compiledPlaybooks.get(pb).body,
					stamp: STAMP,
				}),
			);
		}
		toolPlans.set(tool, {
			adapter,
			skills,
			snippet: renderAgentInstructions({
				adapter: tool,
				stamp: STAMP,
				npmRunner: automationRunner,
				crossCli: capabilities.crossCli,
				projectLogEnabled: existingConfig.projectLog.enabled,
			}),
		});
	}
	const ciPlans = new Map();
	for (const provider of ci) {
		const adapter = CI_ADAPTERS[provider];
		if (adapter.outputFile !== null) {
			ciPlans.set(
				provider,
				renderCiTemplate(
					fs.readFileSync(path.join(PKG_ROOT, "templates", adapter.templateFile), "utf8"),
					{ stamp: STAMP, version: VERSION },
				),
			);
		}
	}
	const publicationPaths = new Set([".stdd/method.md", ".stdd/config.json", ".gitignore"]);
	for (const pb of kitActive) publicationPaths.add(`.stdd/playbooks/${pb.file}`);
	for (const { adapter, skills } of toolPlans.values()) {
		publicationPaths.add(adapter.snippetFile);
		publicationPaths.add(adapter.instructionsFile);
		for (const pb of skills.keys()) {
			publicationPaths.add(`${adapter.skillRoot}/${pb.meta.name}/SKILL.md`);
		}
	}
	for (const adapter of Object.values(AGENT_ADAPTERS)) {
		publicationPaths.add(adapter.instructionsFile);
	}
	for (const provider of ciPlans.keys()) publicationPaths.add(CI_ADAPTERS[provider].outputFile);
	if (hooks) publicationPaths.add(".stdd/hooks/pre-push");
	publicationPaths.add(".stdd/policy.md");
	for (const relative of publicationPaths) {
		resolveWritableRepoPath(targetDir, relative, `generated path ${JSON.stringify(relative)}`);
	}

	let context;
	let recoveredCleanupJournals = [];
	let publishAgentHooks = async () => true;
	try {
		context = await openNativeRepoMutation(targetDir, "native filesystem helper for init");
		for (const relative of publicationPaths) {
			await preflightNativeRepoDestination(
				context,
				relative,
				`generated path ${JSON.stringify(relative)}`,
			);
		}
		if (sessionHook || stopHook) {
			publishAgentHooks = await prepareAgentHooks(context, automationRunner, tools, {
				sessionHook,
				stopHook,
			});
		}
		try {
			previousManifest = await readManifestDocumentWithCapabilities(context);
		} catch (error) {
			throw new Error(`.stdd/manifest.json ${error.message}`, { cause: error });
		}
		oldFiles = previousManifest?.files ?? Object.create(null);
		oldQuarantineIdentities = previousManifest?.quarantineIdentities ?? Object.create(null);
		previouslyRetainedCleanupJournals = Object.keys(oldFiles).filter((relative) =>
			relative.split("/").some((segment) => /^\.stdd-cleanup-journal-[0-9a-f]{32}\.tmp$/.test(segment)),
		);
		const instructionStates = new Map();
		for (const adapter of Object.values(AGENT_ADAPTERS)) {
			instructionStates.set(
				adapter.instructionsFile,
				await readOptionalNativeRepoFile(context, adapter.instructionsFile, {
					label: `${adapter.instructionsFile} path`,
				}),
			);
		}
		const prePushState = hooks
			? await readOptionalNativeRepoFile(context, ".stdd/hooks/pre-push", {
					label: "pre-push hook path",
				})
			: null;
		const policyState = await readOptionalNativeRepoFile(context, ".stdd/policy.md", {
			label: "policy path",
		});
		const gitignoreState = await readOptionalNativeRepoFile(context, ".gitignore", {
			label: ".gitignore path",
		});
		let configState = (await readConfigForWrite(context)).state;
		if (configState) preservedPublicationMode(configState, 0o644, ".stdd/config.json");
		for (const [relative, state] of instructionStates) {
			if (state) preservedPublicationMode(state, 0o644, relative);
		}
		if (gitignoreState) preservedPublicationMode(gitignoreState, 0o644, ".gitignore");
		if (prePushState) preservedPublicationMode(prePushState, 0o755, ".stdd/hooks/pre-push");
		if (policyState) preservedPublicationMode(policyState, 0o644, ".stdd/policy.md");
		recoveredCleanupJournals = await recoverCleanupJournalWithCapabilities(context);
		await openOrCreateNativeRepoDirectory(context, ".stdd", {
			mode: 0o755,
			label: "stdd install directory",
		});
		if (capabilitiesList) {
			configState = await writeCapabilities(context, capabilitiesList, configState);
		}
		if (reviewVia) {
			configState = await writeReviewVia(context, reviewVia, opts.reviewMaxRounds ?? null, configState);
		}
		// The previous run's manifest: files it generated that this profile no
		// longer produces are removed at the end — only when still byte-identical.
		// Every generated file is recorded here (repo-relative path → content
		// hash) and written to .stdd/manifest.json, so check/doctor can detect
		// hand edits, deletions, and stale copies. User-owned files (config.json,
		// local recipes) are deliberately not recorded.
		const generated = Object.create(null);
		const initialQuarantineIdentities = Object.create(null);
		const retireOnlyFiles = new Set();
		const writeGenerated = async (relPath, content) => {
			await publishNativeRepoFile(context, relPath, content, {
				mode: 0o644,
				tempPrefix: ".stdd-generated-",
			});
			generated[relPath] = sha256(content);
		};

		await writeGenerated(
			".stdd/method.md",
			renderInstalledMethod(
				fs.readFileSync(path.join(PKG_ROOT, "method", "README.md"), "utf8"),
				existingConfig.projectLog.enabled,
			),
		);
		for (const pb of kitActive) {
			await writeGenerated(
				`.stdd/playbooks/${pb.file}`,
				compiledPlaybooks.get(pb).source.replaceAll(CROSS_CLI_REVIEW_VIA_TOKEN, agentNeutralReviewVia),
			);
		}
		if (!configState) {
			await publishNativeRepoFile(
				context,
				".stdd/config.json",
				`${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`,
				{ mode: 0o644, tempPrefix: ".config-", expectedTarget: null },
			);
		}
		console.log(`Installed .stdd/ (method, ${kitActive.length} playbooks, config)`);

		const managedInstructions = /<!-- stdd:begin[^>]*-->\r?\n[\s\S]*?<!-- stdd:end -->\r?\n?/;
		for (const tool of tools) {
			const { adapter, skills, snippet } = toolPlans.get(tool);
			for (const pb of [...kitActive, ...localActive]) {
				await writeGenerated(`${adapter.skillRoot}/${pb.meta.name}/SKILL.md`, skills.get(pb));
			}
			await writeGenerated(adapter.snippetFile, snippet);
			resolveWritableRepoPath(targetDir, adapter.instructionsFile, `${adapter.instructionsFile} path`);
			const instructionState = instructionStates.get(adapter.instructionsFile);
			const block = `<!-- stdd:begin — managed section, re-run \`stdd init\` to update -->\n${snippet}<!-- stdd:end -->\n`;
			if (!instructionState) {
				await publishNativeRepoFile(context, adapter.instructionsFile, block, {
					mode: 0o644,
					tempPrefix: ".instructions-",
					expectedTarget: null,
				});
				console.log(`Wrote ${adapter.instructionsFile} with the managed STDD section`);
			} else {
				const current = instructionState.bytes.toString("utf8");
				const updated = managedInstructions.test(current)
					? current.replace(managedInstructions, block)
					: `${current}${current.endsWith("\n") ? "" : "\n"}\n${block}`;
				if (updated !== current) {
					await publishNativeRepoFile(context, adapter.instructionsFile, updated, {
						mode: preservedPublicationMode(instructionState, 0o644, adapter.instructionsFile),
						tempPrefix: ".instructions-",
						expectedTarget: instructionState.file.observation.identity,
						expectedBytes: instructionState.bytes,
					});
				}
				console.log(`Updated the managed STDD section in ${adapter.instructionsFile}`);
			}
			console.log(
				`Installed ${kitActive.length + localActive.length} ${tool} skills under ${adapter.skillRoot}/`,
			);
		}
		for (const adapter of Object.values(AGENT_ADAPTERS).filter(
			(candidate) => !tools.includes(candidate.id),
		)) {
			resolveWritableRepoPath(targetDir, adapter.instructionsFile, `${adapter.instructionsFile} path`);
			const instructionState = instructionStates.get(adapter.instructionsFile);
			if (!instructionState) continue;
			const current = instructionState.bytes.toString("utf8");
			if (!managedInstructions.test(current)) continue;
			const updated = current.replace(managedInstructions, "");
			if (updated.trim() === "") {
				// User-owned instruction files are not normally manifest-tracked.
				// When the managed section is the whole file, temporarily add its
				// exact current bytes to the old ownership set so finalization
				// retires it behind the same cleanup WAL as generated outputs.
				oldFiles[adapter.instructionsFile] = sha256(current);
				retireOnlyFiles.add(adapter.instructionsFile);
			} else {
				await publishNativeRepoFile(context, adapter.instructionsFile, updated, {
					mode: preservedPublicationMode(instructionState, 0o644, adapter.instructionsFile),
					tempPrefix: ".instructions-",
					expectedTarget: instructionState.file.observation.identity,
					expectedBytes: instructionState.bytes,
				});
			}
			console.log(`Removed the managed STDD section from deselected ${adapter.instructionsFile}`);
		}

		for (const provider of ci) {
			const adapter = CI_ADAPTERS[provider];
			if (adapter.outputFile === null) {
				console.log(
					`Portable CI contract for ${adapter.id} (compose with your provider's checkout and live PR/MR body):\n` +
						`  npx --yes @stdd/cli@${VERSION} check .\n` +
						`  printf '%s' "$REVIEW_BODY" | npx --yes @stdd/cli@${VERSION} check-pr - --base "$BASE_REF"`,
				);
				continue;
			}
			await writeGenerated(adapter.outputFile, ciPlans.get(provider));
			console.log(`Installed ${adapter.outputFile} (${provider} live review evidence)`);
		}

		// Repository-owned standing decisions. Seeded once and then hands-off:
		// user-owned after generation like config.json, never manifested, so a
		// recorded permission survives every later init.
		if (!policyState) {
			await publishNativeRepoFile(context, ".stdd/policy.md", POLICY_SEED, {
				mode: 0o644,
				tempPrefix: ".policy-",
				directoryMode: 0o755,
				expectedTarget: null,
			});
			console.log("Installed .stdd/policy.md (notes and conditional permissions)");
		}

		if (hooks) {
			// One fast offline command only — network calls in hooks produce
			// false positives that train --no-verify. User-owned after
			// generation (like config.json): never manifested. A byte-for-byte
			// generated hook is safe to re-pin on upgrade; any user edit makes it
			// hands-off.
			resolveWritableRepoPath(targetDir, ".stdd/hooks/pre-push", "pre-push hook path");
			const hookState = prePushState;
			if (hookState) {
				const current = hookState.bytes.toString("utf8");
				const updated = prePushHook(automationRunner);
				if (current !== updated && isGeneratedPrePushHook(current)) {
					await publishNativeRepoFile(context, ".stdd/hooks/pre-push", updated, {
						mode: preservedPublicationMode(hookState, 0o755, ".stdd/hooks/pre-push"),
						tempPrefix: ".hook-",
						directoryMode: 0o755,
						expectedTarget: hookState.file.observation.identity,
						expectedBytes: hookState.bytes,
					});
					console.log("Re-pinned the generated .stdd/hooks/pre-push to this stdd version");
				} else {
					console.log(".stdd/hooks/pre-push already exists — left untouched (user-owned)");
				}
			} else {
				await publishNativeRepoFile(context, ".stdd/hooks/pre-push", prePushHook(automationRunner), {
					mode: 0o755,
					tempPrefix: ".hook-",
					directoryMode: 0o755,
					expectedTarget: null,
				});
				console.log(
					"Installed .stdd/hooks/pre-push (runs stdd check — fast, offline). Wire it up with ONE of:\n" +
						"  git config core.hooksPath .stdd/hooks   # note: this disables hooks in .git/hooks\n" +
						"  …or call `stdd check` from your existing husky/lefthook pre-push",
				);
			}
		}

		if (sessionHook || stopHook) await publishAgentHooks();
		if ((hooks || sessionHook || stopHook) && !hasLocalStddBinary(targetDir)) {
			console.error(
				"stdd init: automation was generated, but no project-local stdd binary is installed — " +
					"run `npm install --save-dev --save-exact @stdd/cli` before relying on hooks",
			);
		}

		// The ledger and the plan are per-checkout working artifacts — never
		// committed. The ignore rules are user-owned once written, not manifested.
		resolveWritableRepoPath(targetDir, ".gitignore", ".gitignore path");
		const gitignore = gitignoreState?.bytes.toString("utf8") ?? "";
		const retainedLines = gitignore
			.split("\n")
			.filter((line) => line !== LEGACY_LEDGER_RESET_TEMP_IGNORE && line !== LEDGER_RESET_TEMP_GIT_GLOB);
		const retained = retainedLines.join("\n");
		const missing = [LEDGER_REL, PLAN_REL, WORKER_METADATA_REL, `${WORKER_DELETIONS_REL}/`].filter(
			(line) => !retainedLines.includes(line),
		);
		if (retained !== gitignore || missing.length > 0) {
			const sep = retained === "" || retained.endsWith("\n") ? "" : "\n";
			await publishNativeRepoFile(
				context,
				".gitignore",
				`${retained}${sep}${missing.join("\n")}${missing.length ? "\n" : ""}`,
				{
					mode: preservedPublicationMode(gitignoreState, 0o644, ".gitignore"),
					tempPrefix: ".gitignore-",
					expectedTarget: gitignoreState?.file.observation.identity ?? null,
					expectedBytes: gitignoreState?.bytes ?? null,
				},
			);
			if (missing.length > 0) {
				console.log(`Added ${missing.join(", ")} to .gitignore (per-checkout, never committed)`);
			}
		}

		await finalizeGeneratedFilesWithCapabilities(context, {
			oldFiles,
			oldQuarantineIdentities,
			initialQuarantineIdentities,
			generated,
			retainedCleanupJournals: [...previouslyRetainedCleanupJournals, ...recoveredCleanupJournals],
			targets: {
				tools,
				ci: rememberedCiTargets,
				hooks: rememberedHookTargets.hooks,
				sessionHook: rememberedHookTargets.sessionHook,
				stopHook: rememberedHookTargets.stopHook,
			},
			legacyRetainedCleanupJournal: previousManifest?.retainedCleanupJournal ?? null,
			expectedManifestIdentity: previousManifest?.[NATIVE_MANIFEST_IDENTITY] ?? null,
			retireOnlyFiles: [...retireOnlyFiles],
		});
	} catch (error) {
		await context?.close().catch(() => {});
		fail(error.message);
	} finally {
		await context?.close().catch(() => {});
	}
}
