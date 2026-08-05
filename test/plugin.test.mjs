import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileCapabilities, DEFAULT_CONFIG, parseFrontmatter } from "../cli/lib.mjs";
import { buildPlugin, RUNTIME_DIRECTORIES } from "../scripts/build-plugin.mjs";
import { NATIVE_PREBUILD_TARGETS, verifyNativePrebuilds } from "../scripts/verify-native-prebuilds.mjs";
import { renderAgentSkill } from "../sdk/adapters.mjs";
import { openNativeFsSession } from "../sdk/native-fs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(ROOT, "plugins", "stdd");

function runtimeSourceFiles(root) {
	return [
		"package.json",
		...RUNTIME_DIRECTORIES.flatMap((directory) =>
			fs
				.readdirSync(path.join(root, directory), { recursive: true })
				.filter((entry) => fs.statSync(path.join(root, directory, entry)).isFile())
				.map((entry) => path.join(directory, entry)),
		),
	];
}

function declaredPackageFiles(packageRoot) {
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
	const files = new Set(["package.json"]);
	for (const entry of manifest.files) {
		const absolute = path.join(packageRoot, entry);
		if (entry.endsWith("/")) {
			for (const relative of fs.readdirSync(absolute, { recursive: true })) {
				if (fs.statSync(path.join(absolute, relative)).isFile()) {
					files.add(path.join(entry, relative));
				}
			}
		} else {
			files.add(entry);
		}
	}
	return [...files].sort();
}

function pluginBuildFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-build-"));
	for (const directory of RUNTIME_DIRECTORIES) {
		fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
	}
	fs.cpSync(plugin, path.join(root, "plugins", "stdd"), { recursive: true });
	fs.cpSync(path.join(ROOT, "scripts", "plugin"), path.join(root, "scripts", "plugin"), {
		recursive: true,
	});
	fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(root, "LICENSE"));
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	pkg.version = "9.9.9";
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
	return {
		root,
		pluginRoot: path.join(root, "plugins", "stdd"),
	};
}

function nativeSessionFactory(root, intercept) {
	return async (options) => {
		assert.deepEqual(options, { packageRoot: root });
		const session = await openNativeFsSession(options);
		const paths = new Map();
		return new Proxy(session, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				return async (...args) => {
					const parentPath = paths.get(args[0]);
					const details = { method: property, args, path: parentPath };
					if (property === "openChild" || property === "createDirectory" || property === "createFile") {
						details.path = parentPath === "" ? args[1] : `${parentPath}/${args[1]}`;
					} else if (["read", "write", "truncate", "flush", "stat"].includes(property)) {
						details.path = paths.get(args[0]);
					} else if (property === "rename") {
						const request = args[0];
						const fromParent = paths.get(request.fromParent);
						const toParent = paths.get(request.toParent);
						details.fromPath = fromParent === "" ? request.from : `${fromParent}/${request.from}`;
						details.toPath = toParent === "" ? request.to : `${toParent}/${request.to}`;
					}
					await intercept?.("before", details);
					const result = await value.apply(target, args);
					if (property === "openRoot") paths.set(result.cap, "");
					if (property === "openChild" || property === "createDirectory" || property === "createFile") {
						paths.set(result.cap, details.path);
					}
					await intercept?.("after", { ...details, result });
					return result;
				};
			},
		});
	};
}

function installPluginHookProbe(root) {
	const capturePath = path.join(root, "capture.jsonl");
	const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-hook-probe-"));
	fs.cpSync(plugin, pluginRoot, { recursive: true });
	const installedCli = path.join(pluginRoot, "runtime", "cli", "stdd.mjs");
	fs.writeFileSync(
		installedCli,
		[
			'import fs from "node:fs";',
			`fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
			"  argv: process.argv.slice(2),",
			"  cwd: process.cwd(),",
			'  input: fs.readFileSync(0, "utf8"),',
			'}) + "\\n");',
			'process.stdout.write(process.argv[2] === "stop-hook" ? "{}\\n" : "probe-session\\n");',
		].join("\n"),
	);
	return {
		capturePath,
		helper: path.join(pluginRoot, "scripts", "stdd-hook.mjs"),
		env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
	};
}

test("the Codex plugin is version-aligned and contains every playbook skill", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	const manifest = JSON.parse(
		fs.readFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"),
	);
	assert.equal(manifest.name, "stdd");
	assert.equal(manifest.version, pkg.version);
	assert.equal(manifest.hooks, "./hooks/codex-hooks.json");
	assert.ok(Array.isArray(manifest.interface.defaultPrompt));
	assert.ok(manifest.interface.defaultPrompt.length > 0 && manifest.interface.defaultPrompt.length <= 3);
	assert.ok(
		manifest.interface.defaultPrompt.every(
			(prompt) => typeof prompt === "string" && prompt.length > 0 && prompt.length <= 128,
		),
	);
	for (const file of fs
		.readdirSync(path.join(ROOT, "playbooks"))
		.filter((name) => name.endsWith(".md"))) {
		const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(ROOT, "playbooks", file), "utf8"));
		const skill = fs.readFileSync(path.join(plugin, "skills", meta.name, "SKILL.md"), "utf8");
		assert.equal(
			skill,
			renderAgentSkill({
				adapter: "codex",
				name: meta.name,
				description: meta.description,
				when: meta.when,
				body: compileCapabilities(body, DEFAULT_CONFIG.capabilities),
				stamp: `generated by stdd plugin build v${pkg.version} — do not edit`,
			}),
		);
	}
	const planning = fs.readFileSync(path.join(plugin, "skills", "stdd-planning", "SKILL.md"), "utf8");
	assert.match(planning, /stdd review --via subagent/);
	assert.doesNotMatch(planning, /stdd review --via (?:codex|claude)|STDD_CROSS_CLI_REVIEW_VIA/);
	assert.doesNotMatch(planning, /fresh-context pass|re-read the full diff|degrades to/i);

	const planningSource = fs.readFileSync(path.join(ROOT, "playbooks", "planning.md"), "utf8");
	const { meta: planningMeta, body: planningBody } = parseFrontmatter(planningSource);
	const noRoute = renderAgentSkill({
		adapter: "codex",
		name: planningMeta.name,
		description: planningMeta.description,
		when: planningMeta.when,
		body: compileCapabilities(planningBody, {
			subagents: false,
			crossCli: false,
			worktrees: true,
		}),
		stamp: "generated",
	});
	assert.doesNotMatch(
		noRoute,
		/\[review:\]|stdd review|independent review|## The closing review|fresh-context pass|re-read the full diff|degrades to|STDD_CROSS_CLI_REVIEW_VIA/i,
	);
});

test("the universal plugin is version-aligned for Claude Code and Pi", () => {
	const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	const version = rootPackage.version;
	const claudeManifest = JSON.parse(
		fs.readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"),
	);
	assert.deepEqual(
		{
			name: claudeManifest.name,
			version: claudeManifest.version,
			description: claudeManifest.description,
			author: claudeManifest.author,
			hooks: claudeManifest.hooks,
		},
		{
			name: "stdd",
			version,
			description: "Native STDD workflow skills and lifecycle context",
			author: { name: "Azamat Almazbek uulu" },
			hooks: "./hooks/claude-hooks.json",
		},
	);

	const piManifest = JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8"));
	assert.equal(piManifest.name, "@stdd/plugin");
	assert.equal(piManifest.version, version);
	assert.equal(piManifest.type, "module");
	assert.equal(piManifest.license, "MIT");
	assert.ok(piManifest.keywords.includes("pi-package"));
	// Publishing with provenance signs the package against its source
	// repository, so the bundle must point at the same repository as the CLI —
	// generated from it, never hand-kept in step.
	assert.deepEqual(piManifest.repository, {
		...rootPackage.repository,
		directory: "plugins/stdd",
	});
	assert.deepEqual(piManifest.pi, {
		skills: ["./skills"],
		extensions: ["./extensions/stdd.mjs"],
	});
	assert.deepEqual(piManifest.dependencies ?? {}, {});
	assert.equal(
		fs.readFileSync(path.join(plugin, "extensions", "stdd.mjs"), "utf8"),
		fs.readFileSync(path.join(ROOT, "scripts", "plugin", "pi-extension.mjs"), "utf8"),
	);
	assert.deepEqual(
		fs.readFileSync(path.join(plugin, "LICENSE")),
		fs.readFileSync(path.join(ROOT, "LICENSE")),
	);
});

test("each host's root catalog resolves to the bundle and its documented install id", () => {
	// The contract harness installs these exact files through the real hosts;
	// what it cannot check without those binaries is that the catalog still
	// points at something, still names one plugin, and still matches the
	// install command users are told to run. That is what this covers.
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	const hosts = [
		{
			catalog: path.join(".claude-plugin", "marketplace.json"),
			manifest: path.join(".claude-plugin", "plugin.json"),
			// A relative Claude Code source resolves against the marketplace root.
			resolve: (entry) => entry.source,
		},
		{
			catalog: path.join(".agents", "plugins", "marketplace.json"),
			manifest: path.join(".codex-plugin", "plugin.json"),
			resolve: (entry) => {
				assert.equal(entry.source.source, "local");
				// Codex requires both on every entry; a host rejects the catalog
				// outright when either is missing.
				assert.deepEqual(entry.policy, {
					installation: "AVAILABLE",
					authentication: "ON_INSTALL",
				});
				assert.equal(typeof entry.category, "string");
				return entry.source.path;
			},
		},
	];

	for (const host of hosts) {
		const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, host.catalog), "utf8"));
		assert.equal(
			catalog.plugins.length,
			1,
			`${host.catalog} lists one plugin — the contract harness installs it by that entry`,
		);
		const [entry] = catalog.plugins;

		// The source must reach a directory this host can actually load, not
		// merely be a well-formed string.
		const sourced = path.join(ROOT, host.resolve(entry));
		const manifest = JSON.parse(fs.readFileSync(path.join(sourced, host.manifest), "utf8"));
		assert.equal(entry.name, manifest.name);

		// `npm run build:plugin` version-aligns the bundle manifests and nothing
		// above them, so a version restated here would be a second place to bump
		// that no build touches. Each host reads it from the manifest instead.
		assert.equal(
			entry.version,
			undefined,
			`${host.catalog} takes its version from the bundle manifest it sources`,
		);

		assert.ok(
			readme.includes(`${entry.name}@${catalog.name}`),
			`README documents installing ${entry.name}@${catalog.name}`,
		);
	}
});

test("the Pi package tarball contains only the declared universal bundle", () => {
	const packed = spawnSync(
		"npm",
		["pack", "--dry-run", "--ignore-scripts", "--json", "./plugins/stdd"],
		{ cwd: ROOT, encoding: "utf8" },
	);
	assert.equal(packed.status, 0, packed.stderr);
	const report = JSON.parse(packed.stdout);
	const packedPackage = Array.isArray(report) ? report[0] : Object.values(report)[0];
	assert.equal(packedPackage.name, "@stdd/plugin");
	const files = packedPackage.files.map(({ path: relative }) => relative).sort();
	assert.deepEqual(files, declaredPackageFiles(plugin));
});

test("the Pi package lifecycle is self-contained, lazy, and fail-open", async () => {
	const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-pi-plugin-"));
	fs.cpSync(plugin, packageRoot, { recursive: true });
	const capturePath = path.join(packageRoot, "capture.jsonl");
	fs.writeFileSync(
		path.join(packageRoot, "runtime", "cli", "stdd.mjs"),
		[
			'import fs from "node:fs";',
			`fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
			'if (process.env.STDD_FAKE_PI_FAIL) { process.stdout.write("secret output"); process.stderr.write("secret error"); process.exit(7); }',
			'if (process.argv[2] === "status") process.stdout.write("task: pi-plugin\\n");',
			'else { process.stderr.write("correct the review\\n"); process.exitCode = 2; }',
		].join("\n"),
	);
	const handlers = new Map();
	const messages = [];
	const notifications = [];
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
	};
	const extensionUrl = `${pathToFileURL(path.join(packageRoot, "extensions", "stdd.mjs")).href}?fixture=${Date.now()}`;
	const { default: extension } = await import(extensionUrl);
	extension(pi);
	assert.deepEqual([...handlers.keys()], ["session_start", "session_compact", "agent_settled"]);

	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-pi-plugin-outside-"));
	await handlers.get("session_start")({}, { cwd: outside });
	assert.equal(fs.existsSync(capturePath), false, "the runtime stays dormant without .stdd");

	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-pi-plugin-repo-"));
	const nested = path.join(repo, "packages", "app");
	fs.mkdirSync(path.join(repo, ".stdd"));
	fs.mkdirSync(nested, { recursive: true });
	await handlers.get("session_start")({}, { cwd: nested });
	assert.deepEqual(messages.shift(), {
		message: { customType: "stdd-status", content: "task: pi-plugin\n", display: false },
		options: { deliverAs: "nextTurn" },
	});
	await handlers.get("agent_settled")({}, { cwd: nested });
	assert.deepEqual(messages.shift(), {
		message: { customType: "stdd-stop-gate", content: "correct the review\n", display: true },
		options: { deliverAs: "followUp", triggerTurn: true },
	});
	await handlers.get("agent_settled")({}, { cwd: nested });
	assert.equal(messages.length, 0, "the corrective turn is never looped");

	process.env.STDD_FAKE_PI_FAIL = "1";
	try {
		await handlers.get("session_start")(
			{},
			{
				cwd: nested,
				hasUI: true,
				ui: { notify: (...args) => notifications.push(args) },
			},
		);
	} finally {
		delete process.env.STDD_FAKE_PI_FAIL;
	}
	assert.equal(messages.length, 0, "failed child output never enters model context");
	assert.deepEqual(notifications, [
		["STDD bundled runtime failed. Update the STDD plugin or re-run `stdd init`.", "warning"],
	]);

	const outerRepo = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-pi-plugin-outer-"));
	const nestedCheckout = path.join(outerRepo, "nested-checkout");
	fs.mkdirSync(path.join(outerRepo, ".stdd"));
	fs.mkdirSync(path.join(nestedCheckout, ".git"), { recursive: true });
	const savedPath = process.env.PATH;
	process.env.PATH = "";
	try {
		await handlers.get("session_start")({}, { cwd: nestedCheckout });
	} finally {
		process.env.PATH = savedPath;
	}

	const calls = fs
		.readFileSync(capturePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		calls.map(({ argv }) => argv),
		[["status", "--local"], ["stop-hook"], ["status", "--local"]],
	);
	assert.ok(calls.every(({ cwd }) => cwd === repo));
});

test("the Codex plugin carries a version-aligned CLI runtime", () => {
	const runtime = path.join(plugin, "runtime");
	const expectedFiles = runtimeSourceFiles(ROOT).sort();
	const actualFiles = fs
		.readdirSync(runtime, { recursive: true })
		.filter((entry) => fs.statSync(path.join(runtime, entry)).isFile())
		.sort();
	assert.deepEqual(actualFiles, expectedFiles, "the committed runtime has no orphaned output");
	for (const relative of expectedFiles) {
		assert.equal(
			fs.readFileSync(path.join(runtime, relative), "utf8"),
			fs.readFileSync(path.join(ROOT, relative), "utf8"),
			relative,
		);
	}
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8")).version,
		JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
	);
});

test("the universal plugin carries the exact verified six-target native runtime", () => {
	const rootPrebuilds = path.join(ROOT, "prebuilds", "stdd-fs");
	const pluginRuntime = path.join(plugin, "runtime");
	const pluginPrebuilds = path.join(pluginRuntime, "prebuilds", "stdd-fs");
	const rootManifest = verifyNativePrebuilds(ROOT);
	const pluginManifest = verifyNativePrebuilds(pluginRuntime);
	assert.deepEqual(
		rootManifest.artifacts.map(({ target }) => target),
		NATIVE_PREBUILD_TARGETS,
	);
	assert.deepEqual(pluginManifest, rootManifest);
	assert.deepEqual(
		fs.readFileSync(path.join(pluginPrebuilds, "manifest.json")),
		fs.readFileSync(path.join(rootPrebuilds, "manifest.json")),
	);
	for (const artifact of rootManifest.artifacts) {
		const rootArtifact = path.join(rootPrebuilds, ...artifact.path.split("/"));
		const pluginArtifact = path.join(pluginPrebuilds, ...artifact.path.split("/"));
		assert.deepEqual(fs.readFileSync(pluginArtifact), fs.readFileSync(rootArtifact), artifact.target);
		const expectedMode = artifact.target.startsWith("win32-") ? 0o644 : 0o755;
		assert.equal(fs.statSync(pluginArtifact).mode & 0o777, expectedMode, artifact.target);
	}
	const pluginPackage = JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8"));
	assert.deepEqual(pluginPackage.dependencies ?? {}, {});
	assert.deepEqual(pluginPackage.optionalDependencies ?? {}, {});
	for (const lifecycle of ["preinstall", "install", "postinstall"]) {
		assert.equal(pluginPackage.scripts?.[lifecycle], undefined);
	}
	assert.doesNotMatch(
		fs.readFileSync(path.join(pluginRuntime, "sdk", "native-fs.mjs"), "utf8"),
		/\b(?:download|fetch|https?\.request)\b/,
	);
});

test("the npm package excludes the marketplace-only plugin bundle", () => {
	const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: ROOT,
		encoding: "utf8",
	});
	assert.equal(packed.status, 0, packed.stderr);
	const report = JSON.parse(packed.stdout);
	const packedPackage = Array.isArray(report) ? report[0] : Object.values(report)[0];
	const files = packedPackage.files.map(({ path: relative }) => relative);
	assert.ok(files.length > 0);
	assert.ok(files.every((relative) => !relative.startsWith("plugins/")));
});

test("plugin build creates and repairs the bundled runtime from package sources", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const runtime = path.join(pluginRoot, "runtime");
	fs.rmSync(runtime, { recursive: true });
	await buildPlugin(root);
	for (const relative of runtimeSourceFiles(root)) {
		assert.deepEqual(
			fs.readFileSync(path.join(runtime, relative)),
			fs.readFileSync(path.join(root, relative)),
			`runtime byte identity: ${relative}`,
		);
	}
	assert.equal(
		fs.readFileSync(path.join(runtime, "cli", "stdd.mjs"), "utf8"),
		fs.readFileSync(path.join(root, "cli", "stdd.mjs"), "utf8"),
	);
	assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8")).version, "9.9.9");
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).version,
		"9.9.9",
	);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version,
		"9.9.9",
	);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version,
		"9.9.9",
	);
	assert.equal(
		fs.readFileSync(path.join(pluginRoot, "extensions", "stdd.mjs"), "utf8"),
		fs.readFileSync(path.join(root, "scripts", "plugin", "pi-extension.mjs"), "utf8"),
	);
	assert.deepEqual(
		fs.readFileSync(path.join(pluginRoot, "LICENSE")),
		fs.readFileSync(path.join(root, "LICENSE")),
	);
	const nativeManifest = verifyNativePrebuilds(root);
	const nativeOutputRoot = path.join(runtime, "prebuilds", "stdd-fs");
	assert.deepEqual(verifyNativePrebuilds(runtime), nativeManifest);
	for (const artifact of nativeManifest.artifacts) {
		assert.deepEqual(
			fs.readFileSync(path.join(nativeOutputRoot, ...artifact.path.split("/"))),
			fs.readFileSync(path.join(root, "prebuilds", "stdd-fs", ...artifact.path.split("/"))),
			artifact.target,
		);
	}

	fs.writeFileSync(path.join(runtime, "cli", "stdd.mjs"), "drift\n");
	const driftedNative = path.join(nativeOutputRoot, "linux-x64", "stdd-fs");
	fs.writeFileSync(driftedNative, "native drift\n");
	fs.chmodSync(driftedNative, 0o700);
	fs.rmSync(path.join(pluginRoot, "extensions", "stdd.mjs"));
	fs.writeFileSync(path.join(pluginRoot, "LICENSE"), "license drift\n");
	await buildPlugin(root);
	assert.equal(
		fs.readFileSync(path.join(runtime, "cli", "stdd.mjs"), "utf8"),
		fs.readFileSync(path.join(root, "cli", "stdd.mjs"), "utf8"),
	);
	assert.equal(
		fs.readFileSync(path.join(pluginRoot, "extensions", "stdd.mjs"), "utf8"),
		fs.readFileSync(path.join(root, "scripts", "plugin", "pi-extension.mjs"), "utf8"),
	);
	assert.deepEqual(
		fs.readFileSync(path.join(pluginRoot, "LICENSE")),
		fs.readFileSync(path.join(root, "LICENSE")),
	);
	assert.deepEqual(verifyNativePrebuilds(runtime), nativeManifest);
	assert.deepEqual(
		fs.readFileSync(driftedNative),
		fs.readFileSync(path.join(root, "prebuilds", "stdd-fs", "linux-x64", "stdd-fs")),
	);
	assert.equal(fs.statSync(driftedNative).mode & 0o777, 0o755);
	for (const textOutput of [
		path.join(pluginRoot, "skills", "stdd-start-change", "SKILL.md"),
		path.join(pluginRoot, "extensions", "stdd.mjs"),
		path.join(pluginRoot, "runtime", "cli", "stdd.mjs"),
		path.join(pluginRoot, "runtime", "package.json"),
	]) {
		assert.equal(fs.statSync(textOutput).mode & 0o777, 0o644, textOutput);
	}
});

test("plugin build rejects package/runtime surface drift", async () => {
	const { root } = pluginBuildFixture();
	const pkgPath = path.join(root, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	pkg.files.splice(pkg.files.indexOf("adapters/"), 1);
	fs.writeFileSync(pkgPath, JSON.stringify(pkg));
	await assert.rejects(() => buildPlugin(root), /plugin runtime surface.*must match package files/i);
});

test("plugin build rejects malformed universal manifests", async () => {
	for (const mode of ["claude", "pi"]) {
		const { root, pluginRoot } = pluginBuildFixture();
		const manifestPath =
			mode === "claude"
				? path.join(pluginRoot, ".claude-plugin", "plugin.json")
				: path.join(pluginRoot, "package.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		manifest.name = "not-stdd";
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		await assert.rejects(() => buildPlugin(root), /manifest|universal plugin surface/i, mode);
	}
});

test("plugin build rejects stale and unsafe runtime publication paths", async () => {
	{
		const { root, pluginRoot } = pluginBuildFixture();
		fs.writeFileSync(path.join(pluginRoot, "extensions", "stale.mjs"), "stale\n");
		await assert.rejects(() => buildPlugin(root), /stale plugin extension output stale\.mjs/);
	}
	{
		const { root, pluginRoot } = pluginBuildFixture();
		fs.writeFileSync(path.join(pluginRoot, "runtime", "cli", "stale.mjs"), "stale\n");
		await assert.rejects(() => buildPlugin(root), /stale plugin runtime output cli\/stale\.mjs/);
	}
	{
		const { root, pluginRoot } = pluginBuildFixture();
		fs.writeFileSync(
			path.join(pluginRoot, "runtime", "prebuilds", "stdd-fs", "linux-x64", "stale"),
			"stale\n",
		);
		await assert.rejects(
			() => buildPlugin(root),
			/stale plugin runtime output prebuilds\/stdd-fs\/linux-x64\/stale/,
		);
	}
	{
		const { root, pluginRoot } = pluginBuildFixture();
		const outside = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "stdd-runtime-outside-")),
			"lib.mjs",
		);
		fs.writeFileSync(outside, "outside\n");
		fs.rmSync(path.join(root, "cli", "lib.mjs"));
		fs.symlinkSync(outside, path.join(root, "cli", "lib.mjs"));
		await assert.rejects(
			() => buildPlugin(root),
			/runtime source cli\/lib\.mjs.*regular file|regular file.*runtime source cli\/lib\.mjs/i,
		);
		assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
		assert.ok(fs.existsSync(path.join(pluginRoot, "runtime", "cli", "lib.mjs")));
	}
	{
		const { root, pluginRoot } = pluginBuildFixture();
		const outside = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "stdd-runtime-outside-")),
			"lib.mjs",
		);
		fs.writeFileSync(outside, "outside\n");
		fs.rmSync(path.join(pluginRoot, "runtime", "cli", "lib.mjs"));
		fs.symlinkSync(outside, path.join(pluginRoot, "runtime", "cli", "lib.mjs"));
		await assert.rejects(() => buildPlugin(root), /symlink.*runtime|runtime.*symlink/i);
		assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
	}
});

test("plugin lifecycle uses its bundled runtime without a repository dependency", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-self-contained-"));
	fs.mkdirSync(path.join(repo, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".stdd", "config.json"), "{}\n");
	fs.writeFileSync(path.join(repo, "README.md"), "# Fixture\n");
	assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo }).status, 0);
	assert.equal(spawnSync("git", ["add", "."], { cwd: repo }).status, 0);
	assert.equal(
		spawnSync(
			"git",
			["-c", "user.name=STDD", "-c", "user.email=stdd@example.test", "commit", "-qm", "fixture"],
			{ cwd: repo },
		).status,
		0,
	);
	const helper = path.join(plugin, "scripts", "stdd-hook.mjs");

	const session = spawnSync(process.execPath, [helper, "session"], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin },
	});
	assert.equal(session.status, 0);
	assert.match(session.stdout, /^task:/);
	assert.equal(session.stderr, "");
	assert.equal(fs.existsSync(path.join(repo, "node_modules", "@stdd", "cli")), false);

	const stop = spawnSync(process.execPath, [helper, "stop"], {
		cwd: repo,
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin },
	});
	assert.equal(stop.status, 0);
	assert.deepEqual(JSON.parse(stop.stdout), {});
	assert.equal(stop.stderr, "");
});

test("the supported plugin build workflow documents its portable native runtime boundary", () => {
	for (const relative of ["README.md", "method/reference-integration.md"]) {
		const documentation = fs.readFileSync(path.join(ROOT, relative), "utf8");
		assert.match(
			documentation,
			/npm run build:plugin[\s\S]{0,300}(?:all six native|helper hashes|native helper artifacts)/i,
			relative,
		);
	}
});

test("plugin publication uses one portable native filesystem session", async () => {
	const builder = fs.readFileSync(path.join(ROOT, "scripts", "build-plugin.mjs"), "utf8");
	assert.match(builder, /import \{[^}]*openNativeFsSession[^}]*\} from "\.\.\/sdk\/native-fs\.mjs"/);
	assert.doesNotMatch(builder, /held-publication\.mjs|\/proc\/self\/fd/);
	assert.doesNotMatch(builder, /process\.platform\s*!==\s*"linux"/);
	assert.equal(fs.existsSync(path.join(ROOT, "sdk", "held-publication.mjs")), false);
	assert.equal(fs.existsSync(path.join(plugin, "runtime", "sdk", "held-publication.mjs")), false);

	const { root } = pluginBuildFixture();
	let opened = 0;
	let closed = 0;
	let capabilitiesClosed = 0;
	await buildPlugin(root, {
		openSession: async (options) => {
			opened += 1;
			assert.deepEqual(options, { packageRoot: root });
			const { openNativeFsSession } = await import("../sdk/native-fs.mjs");
			const session = await openNativeFsSession(options);
			return new Proxy(session, {
				get(target, property, receiver) {
					if (property === "closeCapability") {
						return async (...args) => {
							capabilitiesClosed += 1;
							return target.closeCapability(...args);
						};
					}
					if (property === "close") {
						return async () => {
							closed += 1;
							await target.close();
						};
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	});
	assert.equal(opened, 1);
	assert.equal(closed, 1);
	assert.ok(capabilitiesClosed > 100, "short-lived native capabilities are closed during the build");

	const manifestPath = path.join(root, "plugins", "stdd", ".codex-plugin", "plugin.json");
	const manifestBefore = fs.readFileSync(manifestPath);
	await assert.rejects(
		() =>
			buildPlugin(root, {
				openSession: async (options) => {
					opened += 1;
					const session = await openNativeFsSession(options);
					return new Proxy(session, {
						get(target, property, receiver) {
							if (property === "probe") {
								return async () => {
									const error = new Error("injected native probe failure");
									Object.assign(error, {
										code: "unsupported-probe",
										class: "unsupported",
										operation: "probe",
										osCode: null,
										mutation: "none",
										retryable: false,
									});
									throw error;
								};
							}
							if (property === "close") {
								return async () => {
									closed += 1;
									await target.close();
								};
							}
							const value = Reflect.get(target, property, receiver);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				},
			}),
		/injected native probe failure.*code=unsupported-probe.*mutation=none/i,
	);
	assert.equal(opened, 2);
	assert.equal(closed, 2);
	assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
});

test("plugin runtime package metadata is the final published output", async () => {
	const { root } = pluginBuildFixture();
	const renamed = [];
	await buildPlugin(root, {
		openSession: nativeSessionFactory(root, async (stage, call) => {
			if (stage === "after" && call.method === "rename") renamed.push(call.toPath);
		}),
	});
	assert.ok(renamed.length > 1);
	assert.equal(renamed.at(-1), "plugins/stdd/runtime/package.json");
});

test("plugin build starts its verified helper without PATH or network access", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const keys = ["PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
	const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	try {
		process.env.PATH = "";
		process.env.HTTP_PROXY = "http://127.0.0.1:1";
		process.env.HTTPS_PROXY = "http://127.0.0.1:1";
		process.env.ALL_PROXY = "socks5://127.0.0.1:1";
		process.env.NO_PROXY = "";
		await buildPlugin(root);
	} finally {
		for (const key of keys) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	}
	assert.match(
		fs.readFileSync(path.join(pluginRoot, "skills", "stdd-start-change", "SKILL.md"), "utf8"),
		/generated by stdd plugin build v9\.9\.9/,
	);
	assert.doesNotMatch(
		fs.readFileSync(path.join(ROOT, "scripts", "build-plugin.mjs"), "utf8"),
		/\b(?:download|fetch|https?\.request|npm|pnpm)\b/,
	);
});

test("plugin build rejects package replacement across session bootstrap", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const packagePath = path.join(root, "package.json");
	const parked = path.join(root, "package.json.parked");
	const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const manifestBefore = fs.readFileSync(manifestPath);
	const openSession = async (options) => {
		const session = await openNativeFsSession(options);
		fs.renameSync(packagePath, parked);
		const replacement = JSON.parse(fs.readFileSync(parked, "utf8"));
		replacement.version = "8.8.8";
		fs.writeFileSync(packagePath, JSON.stringify(replacement));
		return session;
	};
	await assert.rejects(
		() => buildPlugin(root, { openSession }),
		/package runtime source changed during plugin build/i,
	);
	assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
});

test("plugin build rejects current helper replacement after session verification", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const manifestBefore = fs.readFileSync(manifestPath);
	const openSession = async (options) => {
		const session = await openNativeFsSession(options);
		const helperPath = session.artifact.path;
		try {
			fs.renameSync(helperPath, `${helperPath}.parked`);
		} catch {
			await session.close();
			throw new Error("current helper replacement was blocked safely by the operating system");
		}
		fs.writeFileSync(helperPath, "ATTACKER_HELPER\n", { mode: 0o755 });
		return session;
	};
	await assert.rejects(
		() => buildPlugin(root, { openSession }),
		/native prebuild .* helper changed after native helper verification|replacement was blocked safely/i,
	);
	assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
});

test("plugin hooks are lifecycle-only and delegate to the bundled CLI", () => {
	const hooks = JSON.parse(fs.readFileSync(path.join(plugin, "hooks", "codex-hooks.json"), "utf8"));
	assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart", "Stop"]);
	const sessionCommand = hooks.hooks.SessionStart[0].hooks[0].command;
	const stopCommand = hooks.hooks.Stop[0].hooks[0].command;
	assert.match(sessionCommand, /stdd-hook\.mjs/);
	assert.match(stopCommand, /stdd-hook\.mjs/);
	const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-hook-runtime-"));
	fs.cpSync(plugin, pluginRoot, { recursive: true });
	const hostEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot };
	delete hostEnv.PLUGIN_ROOT;

	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-hook-"));
	const nested = path.join(repo, "packages", "app");
	const installedCli = path.join(pluginRoot, "runtime", "cli", "stdd.mjs");
	fs.mkdirSync(path.join(repo, ".stdd"), { recursive: true });
	fs.mkdirSync(nested, { recursive: true });
	fs.mkdirSync(path.join(nested, ".stdd"), { recursive: true });
	const initialized = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	assert.equal(initialized.status, 0);
	fs.writeFileSync(
		installedCli,
		[
			'import fs from "node:fs";',
			`fs.writeFileSync(${JSON.stringify(path.join(repo, "capture.json"))}, JSON.stringify({`,
			"  argv: process.argv.slice(2),",
			"  cwd: process.cwd(),",
			'  input: fs.readFileSync(0, "utf8"),',
			"}));",
			'const stop = process.argv[2] === "stop-hook";',
			'const stopOutput = process.env.STDD_FAKE_STOP_OUTPUT ?? JSON.stringify({ decision: "block", reason: "keep going" });',
			'process.stdout.write(process.env.STDD_FAKE_CHILD_FAIL || process.env.STDD_FAKE_MALFORMED ? "not-json" : stop ? stopOutput : "forwarded-out");',
			'process.stderr.write(process.env.STDD_FAKE_CHILD_FAIL ? "internal failure" : "forwarded-err");',
			"process.exit(process.env.STDD_FAKE_CHILD_FAIL ? 7 : 0);",
		].join("\n"),
	);
	const helper = path.join(pluginRoot, "scripts", "stdd-hook.mjs");
	const session = spawnSync(sessionCommand, {
		cwd: nested,
		encoding: "utf8",
		env: hostEnv,
		shell: true,
	});
	assert.equal(session.status, 0);
	assert.equal(session.stdout, "forwarded-out");
	assert.equal(session.stderr, "forwarded-err");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, "capture.json"), "utf8")).argv, [
		"status",
		"--local",
	]);

	const stop = spawnSync(stopCommand, {
		cwd: nested,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
		env: hostEnv,
		shell: true,
	});
	assert.equal(stop.status, 0);
	assert.deepEqual(JSON.parse(stop.stdout), { decision: "block", reason: "keep going" });
	assert.equal(stop.stderr, "", "Stop forwards protocol JSON only");
	const captured = JSON.parse(fs.readFileSync(path.join(repo, "capture.json"), "utf8"));
	assert.deepEqual(captured.argv, ["stop-hook", "--agent", "codex"]);
	assert.equal(captured.cwd, repo, "the nearest repository root is used");
	assert.equal(captured.input, '{"stop_hook_active":false}');

	for (const { name, child, expected } of [
		{
			name: "valid padded reason",
			child: '{"decision":"block","reason":"  keep going  "}',
			expected: { decision: "block", reason: "  keep going  " },
		},
		{
			name: "whitespace-only reason",
			child: '{"decision":"block","reason":"  \\t\\n  "}',
			expected: {},
		},
		{
			name: "extra key",
			child: '{"decision":"block","reason":"keep going","extra":true}',
			expected: {},
		},
	]) {
		const result = spawnSync(process.execPath, [helper, "stop"], {
			cwd: nested,
			input: "{}",
			encoding: "utf8",
			env: { ...process.env, STDD_FAKE_STOP_OUTPUT: child },
		});
		assert.equal(result.status, 0, `${name}: helper exit`);
		assert.equal(result.stderr, "", `${name}: helper stderr`);
		assert.deepEqual(JSON.parse(result.stdout), expected, `${name}: helper payload`);
		assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, `${name}: canonical JSON`);
	}

	const failedSession = spawnSync(process.execPath, [helper, "session"], {
		cwd: nested,
		encoding: "utf8",
		env: { ...process.env, STDD_FAKE_CHILD_FAIL: "1" },
	});
	assert.equal(failedSession.status, 0, "a failed session runtime remains fail-open");
	assert.equal(failedSession.stdout, "", "child output is not forwarded on failure");
	assert.equal(
		failedSession.stderr,
		"stdd plugin: bundled runtime failed — update the STDD plugin or re-run `stdd init`\n",
	);

	const failedChild = spawnSync(process.execPath, [helper, "stop"], {
		cwd: nested,
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, STDD_FAKE_CHILD_FAIL: "1" },
	});
	assert.equal(failedChild.status, 0, "the child failure is fail-open");
	assert.deepEqual(JSON.parse(failedChild.stdout), {}, "child failure becomes an allow response");
	assert.equal(failedChild.stderr, "", "internal child diagnostics never break the host lifecycle");

	const malformedSuccess = spawnSync(process.execPath, [helper, "stop"], {
		cwd: nested,
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, STDD_FAKE_MALFORMED: "1" },
	});
	assert.equal(malformedSuccess.status, 0);
	assert.deepEqual(
		JSON.parse(malformedSuccess.stdout),
		{},
		"malformed output becomes an allow response",
	);

	const noRepository = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-no-repo-"));
	const missingCli = spawnSync(process.execPath, [helper, "stop"], {
		cwd: noRepository,
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(missingCli.status, 0);
	assert.deepEqual(JSON.parse(missingCli.stdout), {}, "missing local state still returns allow JSON");

	const directoryFd = fs.openSync(repo, "r");
	try {
		const unreadableInput = spawnSync(process.execPath, [helper, "stop"], {
			cwd: nested,
			stdio: [directoryFd, "pipe", "pipe"],
		});
		assert.equal(unreadableInput.status, 0, "an internal stdin read error is fail-open");
		assert.deepEqual(JSON.parse(unreadableInput.stdout), {});
	} finally {
		fs.closeSync(directoryFd);
	}
});

test("Claude plugin hooks preserve Claude's native fail-open Stop protocol", () => {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"),
	);
	assert.equal(manifest.hooks, "./hooks/claude-hooks.json");
	const hooks = JSON.parse(fs.readFileSync(path.join(plugin, "hooks", "claude-hooks.json"), "utf8"));
	const stopCommand = hooks.hooks.Stop[0].hooks[0].command;
	assert.match(stopCommand, /stdd-hook\.mjs.*stop-claude/);

	const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-claude-plugin-hook-"));
	fs.cpSync(plugin, pluginRoot, { recursive: true });
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-claude-plugin-repo-"));
	fs.mkdirSync(path.join(repo, ".stdd"));
	assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo }).status, 0);
	fs.writeFileSync(
		path.join(pluginRoot, "runtime", "cli", "stdd.mjs"),
		[
			'if (process.argv.slice(2).join(" ") !== "stop-hook --agent claude") process.exit(9);',
			'if (process.env.STDD_FAKE_CLAUDE_BLOCK) { process.stderr.write("review required\\n"); process.exit(2); }',
			'if (process.env.STDD_FAKE_CLAUDE_FAIL) { process.stdout.write("secret out"); process.stderr.write("secret err"); process.exit(7); }',
		].join("\n"),
	);
	const helper = path.join(pluginRoot, "scripts", "stdd-hook.mjs");
	const env = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot };
	const blocked = spawnSync(process.execPath, [helper, "stop-claude"], {
		cwd: repo,
		input: '{"hook_event_name":"Stop"}',
		encoding: "utf8",
		env: { ...env, STDD_FAKE_CLAUDE_BLOCK: "1" },
	});
	assert.equal(blocked.status, 2);
	assert.equal(blocked.stdout, "");
	assert.equal(blocked.stderr, "review required\n");

	const failed = spawnSync(process.execPath, [helper, "stop-claude"], {
		cwd: repo,
		input: "{}",
		encoding: "utf8",
		env: { ...env, STDD_FAKE_CLAUDE_FAIL: "1" },
	});
	assert.equal(failed.status, 0);
	assert.equal(failed.stdout, "");
	assert.equal(failed.stderr, "");
});

test("plugin hooks never escape a resolved nested Git checkout", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-parent-"));
	fs.mkdirSync(path.join(parent, ".stdd"), { recursive: true });
	const { capturePath, helper, env } = installPluginHookProbe(parent);
	assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: parent }).status, 0);

	const nestedRepo = path.join(parent, "vendor", "unrelated");
	const cwd = path.join(nestedRepo, "packages", "app");
	fs.mkdirSync(cwd, { recursive: true });
	assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: nestedRepo }).status, 0);

	const session = spawnSync(process.execPath, [helper, "session"], {
		cwd,
		encoding: "utf8",
		env,
	});
	assert.equal(session.status, 0);
	assert.equal(session.stdout, "");
	assert.equal(session.stderr, "");

	const stop = spawnSync(process.execPath, [helper, "stop"], {
		cwd,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
		env,
	});
	assert.equal(stop.status, 0);
	assert.equal(stop.stdout, "{}\n");
	assert.equal(stop.stderr, "");

	const withoutGit = spawnSync(process.execPath, [helper, "session"], {
		cwd,
		encoding: "utf8",
		env: { ...env, PATH: path.join(parent, "missing-bin") },
	});
	assert.equal(withoutGit.status, 0);
	assert.equal(withoutGit.stdout, "");
	assert.equal(withoutGit.stderr, "");

	const symlinkedRoot = path.join(parent, "vendor", "symlinked-boundary");
	const symlinkedCwd = path.join(symlinkedRoot, "packages", "app");
	fs.mkdirSync(symlinkedCwd, { recursive: true });
	fs.symlinkSync(path.join(parent, "missing-git-dir"), path.join(symlinkedRoot, ".git"));
	const acrossSymlink = spawnSync(process.execPath, [helper, "session"], {
		cwd: symlinkedCwd,
		encoding: "utf8",
		env,
	});
	assert.equal(acrossSymlink.status, 0);
	assert.equal(acrossSymlink.stdout, "");
	assert.equal(acrossSymlink.stderr, "");
	assert.equal(
		fs.existsSync(capturePath),
		false,
		"the nested checkout must not invoke an unrelated parent CLI, even when Git cannot run",
	);
});

test("plugin hooks discover an adopting ancestor only when cwd is outside Git", () => {
	const adoptingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-non-git-"));
	fs.mkdirSync(path.join(adoptingRoot, ".stdd"), { recursive: true });
	const { capturePath, helper, env } = installPluginHookProbe(adoptingRoot);
	const cwd = path.join(adoptingRoot, "packages", "app");
	fs.mkdirSync(cwd, { recursive: true });

	const session = spawnSync(process.execPath, [helper, "session"], {
		cwd,
		encoding: "utf8",
		env,
	});
	assert.equal(session.status, 0);
	assert.equal(session.stdout, "probe-session\n");

	const stop = spawnSync(process.execPath, [helper, "stop"], {
		cwd,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
		env,
	});
	assert.equal(stop.status, 0);
	assert.equal(stop.stdout, "{}\n");
	const captures = fs
		.readFileSync(capturePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		captures.map(({ argv, cwd: invokedFrom }) => ({ argv, cwd: invokedFrom })),
		[
			{ argv: ["status", "--local"], cwd: adoptingRoot },
			{ argv: ["stop-hook", "--agent", "codex"], cwd: adoptingRoot },
		],
	);
	assert.equal(captures[1].input, '{"stop_hook_active":false}');
});

test("plugin build rejects an active skill directory symlink before writing any output", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const safeSkillPath = path.join(pluginRoot, "skills", "stdd-brainstorming", "SKILL.md");
	const manifestBefore = fs.readFileSync(manifestPath);
	const safeSkillBefore = fs.readFileSync(safeSkillPath);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-outside-skill-"));
	const outsideSkill = path.join(outside, "SKILL.md");
	const outsideBefore = Buffer.from("OUTSIDE_SKILL_MUST_NOT_CHANGE\n");
	fs.writeFileSync(outsideSkill, outsideBefore);
	const activeSkillDir = path.join(pluginRoot, "skills", "stdd-start-change");
	fs.rmSync(activeSkillDir, { recursive: true });
	fs.symlinkSync(outside, activeSkillDir, "dir");

	await assert.rejects(() => buildPlugin(root), /skill.*stdd-start-change.*symlink|symlink.*skill/i);
	assert.deepEqual(fs.readFileSync(outsideSkill), outsideBefore);
	assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
	assert.deepEqual(fs.readFileSync(safeSkillPath), safeSkillBefore);
});

test("plugin build rejects manifest path symlinks before writing any output", async () => {
	for (const mode of ["manifest-file", "manifest-parent"]) {
		const { root, pluginRoot } = pluginBuildFixture();
		const manifestDir = path.join(pluginRoot, ".codex-plugin");
		const manifestPath = path.join(manifestDir, "plugin.json");
		const safeSkillPath = path.join(pluginRoot, "skills", "stdd-brainstorming", "SKILL.md");
		const safeSkillBefore = fs.readFileSync(safeSkillPath);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), `stdd-plugin-outside-${mode}-`));
		const outsideManifest = path.join(outside, "plugin.json");
		const outsideBefore = fs.readFileSync(manifestPath);
		fs.writeFileSync(outsideManifest, outsideBefore);
		if (mode === "manifest-file") {
			fs.rmSync(manifestPath);
			fs.symlinkSync(outsideManifest, manifestPath);
		} else {
			fs.rmSync(manifestDir, { recursive: true });
			fs.symlinkSync(outside, manifestDir, "dir");
		}

		await assert.rejects(
			() => buildPlugin(root),
			/codex-plugin|plugin\.json.*symlink|symlink.*manifest/i,
		);
		assert.deepEqual(fs.readFileSync(outsideManifest), outsideBefore, mode);
		assert.deepEqual(fs.readFileSync(safeSkillPath), safeSkillBefore, mode);
	}
});

test("plugin build rejects root, skill-file, hook, and script symlink boundaries", async () => {
	for (const mode of ["plugin-root", "skill-file", "hooks", "scripts"]) {
		const { root, pluginRoot } = pluginBuildFixture();
		const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
		const safeSkillPath = path.join(pluginRoot, "skills", "stdd-brainstorming", "SKILL.md");
		const manifestBefore = fs.readFileSync(manifestPath);
		const safeSkillBefore = fs.readFileSync(safeSkillPath);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), `stdd-plugin-outside-${mode}-`));
		const outsideFile = path.join(outside, mode === "skill-file" ? "SKILL.md" : `${mode}.txt`);
		const outsideBefore = Buffer.from(`OUTSIDE_${mode}_MUST_NOT_CHANGE\n`);
		fs.writeFileSync(outsideFile, outsideBefore);

		if (mode === "plugin-root") {
			fs.rmSync(pluginRoot, { recursive: true });
			fs.symlinkSync(outside, pluginRoot, "dir");
		} else if (mode === "skill-file") {
			const skillFile = path.join(pluginRoot, "skills", "stdd-start-change", "SKILL.md");
			fs.rmSync(skillFile);
			fs.symlinkSync(outsideFile, skillFile);
		} else {
			const boundary = path.join(pluginRoot, mode);
			fs.rmSync(boundary, { recursive: true });
			fs.symlinkSync(outside, boundary, "dir");
		}

		await assert.rejects(() => buildPlugin(root), /symlink.*unsafe|symlink.*plugin publication/i, mode);
		assert.deepEqual(fs.readFileSync(outsideFile), outsideBefore, mode);
		if (mode !== "plugin-root") {
			assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore, mode);
			assert.deepEqual(fs.readFileSync(safeSkillPath), safeSkillBefore, mode);
		}
	}
});

test("plugin build rejects unsafe universal manifest, extension, and license boundaries", async () => {
	for (const mode of [
		"claude-manifest",
		"pi-manifest",
		"extensions",
		"extension-source",
		"license-source",
		"license-output",
	]) {
		const { root, pluginRoot } = pluginBuildFixture();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), `stdd-universal-outside-${mode}-`));
		const outsideFile = path.join(outside, "outside.txt");
		const outsideBefore = Buffer.from(`OUTSIDE_${mode}_MUST_NOT_CHANGE\n`);
		fs.writeFileSync(outsideFile, outsideBefore);
		if (mode === "claude-manifest") {
			const target = path.join(pluginRoot, ".claude-plugin", "plugin.json");
			fs.rmSync(target);
			fs.symlinkSync(outsideFile, target);
		} else if (mode === "pi-manifest") {
			const target = path.join(pluginRoot, "package.json");
			fs.rmSync(target);
			fs.symlinkSync(outsideFile, target);
		} else if (mode === "extensions") {
			const target = path.join(pluginRoot, "extensions");
			fs.rmSync(target, { recursive: true });
			fs.symlinkSync(outside, target, "dir");
		} else if (mode === "extension-source") {
			const target = path.join(root, "scripts", "plugin");
			fs.rmSync(target, { recursive: true });
			fs.symlinkSync(outside, target, "dir");
		} else {
			const target =
				mode === "license-source" ? path.join(root, "LICENSE") : path.join(pluginRoot, "LICENSE");
			fs.rmSync(target);
			fs.symlinkSync(outsideFile, target);
		}
		await assert.rejects(() => buildPlugin(root), /symlink|unsafe|regular file/i, mode);
		assert.deepEqual(fs.readFileSync(outsideFile), outsideBefore, mode);
	}
});

test("plugin build rejects a playbook replaced during a native-session read", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const playbook = path.join(root, "playbooks", "planning.md");
	const parked = path.join(root, "playbooks", "planning.md.parked");
	const manifest = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const before = fs.readFileSync(manifest);
	let swapped = false;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (
			!swapped &&
			stage === "before" &&
			call.method === "read" &&
			call.path === "playbooks/planning.md"
		) {
			swapped = true;
			fs.renameSync(playbook, parked);
			fs.writeFileSync(
				playbook,
				"---\nname: stdd-planning\ndescription: Attacker replacement\n---\n\nATTACKER\n",
			);
		}
	});
	await assert.rejects(
		() => buildPlugin(root, { openSession }),
		/playbook planning\.md.*changed|changed.*playbook planning\.md/i,
	);
	assert.equal(swapped, true);
	assert.deepEqual(fs.readFileSync(manifest), before);
});

test("plugin build rejects multiply linked playbooks before publishing output", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const playbook = path.join(root, "playbooks", "planning.md");
	fs.linkSync(playbook, path.join(root, "playbooks", "planning-linked-copy"));
	const manifest = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const before = fs.readFileSync(manifest);
	await assert.rejects(() => buildPlugin(root), /playbook planning\.md.*single-link/i);
	assert.equal(fs.statSync(playbook).nlink, 2);
	assert.deepEqual(fs.readFileSync(manifest), before);
});

test("plugin build rejects same-inode source mutation before output mutation", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const playbook = path.join(root, "playbooks", "planning.md");
	const manifest = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const before = fs.readFileSync(manifest);
	let completedReads = 0;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (
			stage === "after" &&
			call.method === "read" &&
			call.path === "playbooks/planning.md" &&
			call.result.eof &&
			++completedReads === 2
		) {
			fs.appendFileSync(playbook, "\nMUTATED_IN_PLACE\n");
		}
	});
	await assert.rejects(() => buildPlugin(root, { openSession }), /playbook planning\.md.*changed/i);
	assert.deepEqual(fs.readFileSync(manifest), before);
});

test("plugin build rejects logical root replacement after probe preflight", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const manifest = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const before = fs.readFileSync(manifest);
	const parked = `${root}-parked`;
	let swapped = false;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (!swapped && stage === "before" && call.method === "probe") {
			swapped = true;
			fs.renameSync(root, parked);
			fs.mkdirSync(root);
		}
	});
	await assert.rejects(
		() => buildPlugin(root, { openSession }),
		/package source root.*changed identity/i,
	);
	assert.equal(fs.readdirSync(root).length, 0);
	assert.deepEqual(fs.readFileSync(path.join(parked, path.relative(root, manifest))), before);
});

test("plugin build confines a skill write when its held parent swaps", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const skillDir = path.join(pluginRoot, "skills", "stdd-brainstorming");
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-open-swap-"));
	fs.writeFileSync(path.join(outside, "SKILL.md"), "OUTSIDE\n");
	let swapped = false;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (
			!swapped &&
			stage === "before" &&
			call.method === "createFile" &&
			call.path?.startsWith("plugins/stdd/skills/stdd-brainstorming/.SKILL.md-")
		) {
			swapped = true;
			fs.renameSync(skillDir, path.join(pluginRoot, "skills", "parked-brainstorming"));
			fs.symlinkSync(outside, skillDir, "dir");
		}
	});
	await assert.rejects(() => buildPlugin(root, { openSession }), /changed|identity|unsafe|symlink/i);
	assert.equal(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8"), "OUTSIDE\n");
});

test("plugin build retains a replacement swapped onto a failed native publication temp", async () => {
	const { root } = pluginBuildFixture();
	const park = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-temp-")), "temp");
	let replacement = null;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (replacement && stage === "before" && call.method === "closeCapability") {
			throw new Error("injected poisoned-session close failure");
		}
		if (
			!replacement &&
			stage === "before" &&
			call.method === "flush" &&
			call.path?.startsWith("plugins/stdd/skills/stdd-brainstorming/.SKILL.md-")
		) {
			replacement = path.join(root, ...call.path.split("/"));
			fs.renameSync(replacement, park);
			fs.writeFileSync(replacement, "REPLACEMENT_SURVIVES\n");
			const error = new Error("injected native temp flush failure");
			Object.assign(error, {
				code: "injected-failure",
				class: "io",
				operation: "flush",
				osCode: null,
				mutation: "possible",
				retryable: false,
			});
			throw error;
		}
	});
	await assert.rejects(
		() => buildPlugin(root, { openSession }),
		/injected native temp flush failure.*temporary publication.*mutation=possible/i,
	);
	assert.equal(fs.readFileSync(replacement, "utf8"), "REPLACEMENT_SURVIVES\n");
});

test("plugin build atomically replaces a final skill symlink swap without following it", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const skill = path.join(pluginRoot, "skills", "stdd-brainstorming", "SKILL.md");
	const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-final-")), "outside.md");
	fs.writeFileSync(outside, "OUTSIDE\n");
	let swapped = false;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (
			!swapped &&
			stage === "before" &&
			call.method === "rename" &&
			call.toPath === "plugins/stdd/skills/stdd-brainstorming/SKILL.md"
		) {
			swapped = true;
			fs.rmSync(skill);
			fs.symlinkSync(outside, skill);
		}
	});
	await buildPlugin(root, { openSession });
	assert.equal(swapped, true);
	assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE\n");
	assert.equal(fs.lstatSync(skill).isSymbolicLink(), false);
});

test("plugin build confines active skill creation when the skills parent swaps", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const skills = path.join(pluginRoot, "skills");
	const active = "stdd-start-change";
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-mkdir-"));
	fs.rmSync(path.join(skills, active), { recursive: true });
	let swapped = false;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (
			!swapped &&
			stage === "before" &&
			call.method === "createDirectory" &&
			call.path === `plugins/stdd/skills/${active}`
		) {
			swapped = true;
			fs.renameSync(skills, path.join(pluginRoot, "parked-skills"));
			fs.symlinkSync(outside, skills, "dir");
		}
	});
	await assert.rejects(() => buildPlugin(root, { openSession }), /changed|identity|unsafe|symlink/i);
	assert.equal(fs.existsSync(path.join(outside, active)), false);
});

test("plugin build confines stale skill quarantine when the skills parent swaps", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const skills = path.join(pluginRoot, "skills");
	const stale = "stdd-stale";
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-stale-"));
	fs.mkdirSync(path.join(skills, stale));
	fs.writeFileSync(path.join(skills, stale, "SKILL.md"), "STALE\n");
	fs.mkdirSync(path.join(outside, stale));
	fs.writeFileSync(path.join(outside, stale, "SKILL.md"), "OUTSIDE\n");
	let swapped = false;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (
			!swapped &&
			stage === "before" &&
			call.method === "rename" &&
			call.fromPath === `plugins/stdd/skills/${stale}`
		) {
			swapped = true;
			fs.renameSync(skills, path.join(pluginRoot, "parked-skills"));
			fs.symlinkSync(outside, skills, "dir");
		}
	});
	await assert.rejects(() => buildPlugin(root, { openSession }), /changed|identity|unsafe|symlink/i);
	assert.equal(fs.readFileSync(path.join(outside, stale, "SKILL.md"), "utf8"), "OUTSIDE\n");
});

test("plugin build retains stale skill quarantines without recursive removal", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const stale = "stdd-stale";
	fs.mkdirSync(path.join(pluginRoot, "skills", stale));
	fs.writeFileSync(path.join(pluginRoot, "skills", stale, "SKILL.md"), "STALE\n");
	const quarantine = path.join(pluginRoot, ".stdd-plugin-quarantine");
	fs.mkdirSync(quarantine, { mode: 0o700 });
	const retained = path.join(quarantine, "preexisting-replacement");
	fs.mkdirSync(retained);
	fs.writeFileSync(path.join(retained, "marker"), "SURVIVES\n");
	await buildPlugin(root);
	assert.doesNotMatch(
		fs.readFileSync(path.join(ROOT, "scripts", "build-plugin.mjs"), "utf8"),
		/\b(?:rmSync|rmdirSync|unlinkSync)\b/,
	);
	assert.equal(fs.statSync(quarantine).mode & 0o777, 0o700);
	assert.equal(fs.readFileSync(path.join(retained, "marker"), "utf8"), "SURVIVES\n");
	const retired = fs
		.readdirSync(quarantine)
		.find((name) => name.startsWith(`${stale}-`) && name.endsWith(".retired"));
	assert.equal(fs.readFileSync(path.join(quarantine, retired, "SKILL.md"), "utf8"), "STALE\n");
});

test("plugin build never deletes a replacement at a quarantine final name", async () => {
	const { root, pluginRoot } = pluginBuildFixture();
	const stale = "stdd-stale";
	fs.mkdirSync(path.join(pluginRoot, "skills", stale));
	fs.writeFileSync(path.join(pluginRoot, "skills", stale, "SKILL.md"), "STALE\n");
	const park = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-plugin-quarantine-"));
	let marker = null;
	const openSession = nativeSessionFactory(root, async (stage, call) => {
		if (
			!marker &&
			stage === "after" &&
			call.method === "rename" &&
			call.fromPath === `plugins/stdd/skills/${stale}` &&
			call.toPath.endsWith(".retired")
		) {
			const target = path.join(root, ...call.toPath.split("/"));
			fs.renameSync(target, path.join(park, path.basename(target)));
			fs.mkdirSync(target);
			marker = path.join(target, "marker");
			fs.writeFileSync(marker, "SURVIVES\n");
		}
	});
	await assert.rejects(() => buildPlugin(root, { openSession }), /changed|identity|quarantine/i);
	assert.equal(fs.readFileSync(marker, "utf8"), "SURVIVES\n");
});

test("plugin rebuild removes skills whose playbooks were deleted or renamed", async () => {
	const { root } = pluginBuildFixture();
	fs.mkdirSync(path.join(root, "plugins", "stdd", "skills", "stdd-stale"), { recursive: true });
	fs.writeFileSync(path.join(root, "plugins", "stdd", "skills", "stdd-stale", "SKILL.md"), "stale");
	await buildPlugin(root);
	assert.ok(!fs.existsSync(path.join(root, "plugins", "stdd", "skills", "stdd-stale")));
	const quarantine = path.join(root, "plugins", "stdd", ".stdd-plugin-quarantine");
	const retired = fs
		.readdirSync(quarantine)
		.find((name) => name.startsWith("stdd-stale-") && name.endsWith(".retired"));
	assert.equal(fs.readFileSync(path.join(quarantine, retired, "SKILL.md"), "utf8"), "stale");
	assert.match(fs.readFileSync(path.join(quarantine, "README.txt"), "utf8"), /inspect and remove/i);
	const manifestPath = path.join(root, "plugins", "stdd", ".codex-plugin", "plugin.json");
	const malformed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	malformed.interface.defaultPrompt = "not-an-array";
	fs.writeFileSync(manifestPath, JSON.stringify(malformed));
	await assert.rejects(() => buildPlugin(root), /defaultPrompt/);
});
