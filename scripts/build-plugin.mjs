#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCapabilities, DEFAULT_CONFIG, parseFrontmatter } from "../cli/lib.mjs";
import { renderAgentSkill } from "../sdk/adapters.mjs";
import {
	atomicWriteFile,
	closeHeldDirectory,
	ensureHeldChildDirectory,
	openHeldDirectory,
	quarantineStaleSkill,
	readHeldRegularFile,
	requireSafeDirectory,
	requireSafeRegularFile,
	requireSafeTree,
} from "../sdk/held-publication.mjs";
import { assertSkillName } from "../sdk/path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUARANTINE_README =
	"STDD plugin build quarantine.\n\n" +
	"These stale generated skill directories were removed from the active skills registry but retained " +
	"because Node.js has no descriptor-relative unlink primitive. Inspect and remove this directory manually.\n";
const PI_PACKAGE_FILES = Object.freeze([
	".codex-plugin/",
	".claude-plugin/",
	"extensions/",
	"hooks/",
	"scripts/",
	"skills/",
	"runtime/",
	"README.md",
	"LICENSE",
]);

export const RUNTIME_DIRECTORIES = Object.freeze([
	"cli",
	"sdk",
	"method",
	"playbooks",
	"templates",
	"adapters",
]);

function validateRuntimeSurface(pkg) {
	const packageDirectories = Array.isArray(pkg.files)
		? pkg.files
				.filter((entry) => typeof entry === "string" && !entry.startsWith("!") && entry.endsWith("/"))
				.map((entry) => entry.slice(0, -1))
		: [];
	const expected = new Set(RUNTIME_DIRECTORIES);
	const actual = new Set(packageDirectories);
	if (expected.size !== actual.size || [...expected].some((directory) => !actual.has(directory))) {
		throw new Error(
			`plugin runtime surface (${RUNTIME_DIRECTORIES.join(", ")}) must match package files (${packageDirectories.join(", ")})`,
		);
	}
}

function runtimeSourceFiles(root) {
	const files = new Map([["package.json", fs.readFileSync(path.join(root, "package.json"), "utf8")]]);
	for (const directory of RUNTIME_DIRECTORIES) {
		const sourceRoot = path.join(root, directory);
		requireSafeDirectory(sourceRoot, `${directory} runtime source`);
		for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
			if (!entry.isFile()) {
				throw new Error(`plugin runtime source ${directory}/${entry.name} must be a regular file`);
			}
			requireSafeRegularFile(
				path.join(sourceRoot, entry.name),
				`plugin runtime source ${directory}/${entry.name}`,
			);
			files.set(`${directory}/${entry.name}`, null);
		}
	}
	return files;
}

function validateExtensionOutput(extensionsRoot) {
	if (!fs.existsSync(extensionsRoot)) return;
	requireSafeTree(extensionsRoot, "plugins/stdd/extensions");
	for (const entry of fs.readdirSync(extensionsRoot)) {
		if (entry !== "stdd.mjs") {
			throw new Error(`stale plugin extension output ${entry}; remove it before rebuilding`);
		}
	}
}

function validateRuntimeOutput(runtimeRoot, sourceFiles) {
	if (!fs.existsSync(runtimeRoot)) return;
	requireSafeTree(runtimeRoot, "plugins/stdd/runtime");
	const expectedRoot = new Set(["package.json", ...RUNTIME_DIRECTORIES]);
	for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
		if (!expectedRoot.has(entry.name)) {
			throw new Error(`stale plugin runtime output ${entry.name}; remove it before rebuilding`);
		}
	}
	for (const directory of RUNTIME_DIRECTORIES) {
		const outputRoot = path.join(runtimeRoot, directory);
		if (!fs.existsSync(outputRoot)) continue;
		const expected = new Set(
			[...sourceFiles.keys()]
				.filter((relative) => relative.startsWith(`${directory}/`))
				.map((relative) => relative.slice(directory.length + 1)),
		);
		for (const entry of fs.readdirSync(outputRoot)) {
			if (!expected.has(entry)) {
				throw new Error(
					`stale plugin runtime output ${directory}/${entry}; remove it before rebuilding`,
				);
			}
		}
	}
}

function sameStringArray(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((value, index) => value === expected[index])
	);
}

function validateCodexManifest(manifest) {
	if (manifest?.name !== "stdd") throw new TypeError('Codex plugin manifest name must be "stdd"');
	if (manifest.hooks !== "./hooks/codex-hooks.json") {
		throw new TypeError("Codex plugin manifest must select ./hooks/codex-hooks.json");
	}
	const prompts = manifest.interface?.defaultPrompt;
	if (
		!Array.isArray(prompts) ||
		prompts.length === 0 ||
		prompts.length > 3 ||
		prompts.some((prompt) => typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 128)
	) {
		throw new TypeError(
			"Codex plugin interface.defaultPrompt must be an array of 1-3 non-empty strings up to 128 characters",
		);
	}
}

function validateClaudeManifest(manifest) {
	if (manifest?.name !== "stdd") throw new TypeError('Claude plugin manifest name must be "stdd"');
	if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
		throw new TypeError("Claude plugin manifest description must be non-empty");
	}
	if (typeof manifest.author?.name !== "string" || manifest.author.name.trim() === "") {
		throw new TypeError("Claude plugin manifest author.name must be non-empty");
	}
	if (manifest.hooks !== "./hooks/claude-hooks.json") {
		throw new TypeError("Claude plugin manifest must select ./hooks/claude-hooks.json");
	}
}

function validatePiManifest(manifest) {
	if (manifest?.name !== "@stdd/plugin") {
		throw new TypeError('Pi package manifest name must be "@stdd/plugin"');
	}
	if (manifest.type !== "module") throw new TypeError('Pi package manifest type must be "module"');
	if (manifest.license !== "MIT") throw new TypeError('Pi package manifest license must be "MIT"');
	if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes("pi-package")) {
		throw new TypeError('Pi package manifest keywords must include "pi-package"');
	}
	if (!sameStringArray(manifest.pi?.skills, ["./skills"])) {
		throw new TypeError("Pi package manifest pi.skills must contain only ./skills");
	}
	if (!sameStringArray(manifest.pi?.extensions, ["./extensions/stdd.mjs"])) {
		throw new TypeError("Pi package manifest pi.extensions must contain only ./extensions/stdd.mjs");
	}
	if (!sameStringArray(manifest.files, PI_PACKAGE_FILES)) {
		throw new TypeError("Pi package manifest files must match the universal plugin surface");
	}
	if (Object.keys(manifest.dependencies ?? {}).length !== 0) {
		throw new TypeError("Pi package manifest must not declare runtime dependencies");
	}
}

export function buildPlugin(root = ROOT) {
	const pluginsRoot = path.join(root, "plugins");
	const pluginRoot = path.join(root, "plugins", "stdd");
	const skillsRoot = path.join(pluginRoot, "skills");
	const manifestRoot = path.join(pluginRoot, ".codex-plugin");
	const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const claudeManifestRoot = path.join(pluginRoot, ".claude-plugin");
	const claudeManifestPath = path.join(claudeManifestRoot, "plugin.json");
	const piManifestPath = path.join(pluginRoot, "package.json");
	const hooksRoot = path.join(pluginRoot, "hooks");
	const scriptsRoot = path.join(pluginRoot, "scripts");
	const extensionSourceRoot = path.join(root, "scripts", "plugin");
	const extensionSourcePath = path.join(extensionSourceRoot, "pi-extension.mjs");
	const extensionsRoot = path.join(pluginRoot, "extensions");
	const runtimeRoot = path.join(pluginRoot, "runtime");
	const runtimeFiles = runtimeSourceFiles(root);
	if (process.platform !== "linux") {
		throw new Error(
			"secure plugin publication requires Linux held-directory support (/proc/self/fd); nothing was written",
		);
	}

	// Validate every existing publication boundary before reading templates
	// into an output plan. No manifest or skill is written until all active
	// and stale targets, plus the lifecycle bundle, have passed this preflight.
	requireSafeDirectory(pluginsRoot, "plugins directory");
	requireSafeDirectory(pluginRoot, "plugins/stdd");
	requireSafeDirectory(manifestRoot, "plugins/stdd/.codex-plugin");
	requireSafeRegularFile(manifestPath, "plugins/stdd/.codex-plugin/plugin.json");
	requireSafeDirectory(claudeManifestRoot, "plugins/stdd/.claude-plugin");
	requireSafeRegularFile(claudeManifestPath, "plugins/stdd/.claude-plugin/plugin.json");
	requireSafeRegularFile(piManifestPath, "plugins/stdd/package.json");
	requireSafeRegularFile(path.join(pluginRoot, "README.md"), "plugins/stdd/README.md");
	requireSafeRegularFile(path.join(pluginRoot, "LICENSE"), "plugins/stdd/LICENSE", {
		allowMissing: true,
	});
	requireSafeDirectory(skillsRoot, "plugins/stdd/skills");
	requireSafeTree(hooksRoot, "plugins/stdd/hooks");
	requireSafeTree(scriptsRoot, "plugins/stdd/scripts");
	requireSafeDirectory(extensionSourceRoot, "Pi extension source directory");
	requireSafeRegularFile(extensionSourcePath, "Pi extension source");
	validateExtensionOutput(extensionsRoot);
	requireSafeRegularFile(path.join(root, "package.json"), "package runtime source");
	requireSafeRegularFile(path.join(root, "LICENSE"), "package license source");
	validateRuntimeOutput(runtimeRoot, runtimeFiles);

	const playbooksRoot = path.join(root, "playbooks");
	requireSafeDirectory(playbooksRoot, "playbooks directory");
	const heldDirectories = [];
	try {
		const sourceRootHeld = openHeldDirectory(root, "package source root");
		heldDirectories.push(sourceRootHeld);
		const packageSource = readHeldRegularFile(sourceRootHeld, "package.json", "package runtime source", {
			requireSingleLink: true,
		});
		if (packageSource !== runtimeFiles.get("package.json")) {
			throw new Error("package runtime source changed during plugin build");
		}
		runtimeFiles.set("package.json", packageSource);
		const pkg = JSON.parse(packageSource);
		validateRuntimeSurface(pkg);

		const pluginHeld = openHeldDirectory(pluginRoot, "plugins/stdd");
		heldDirectories.push(pluginHeld);
		const manifestHeld = openHeldDirectory(manifestRoot, "plugins/stdd/.codex-plugin");
		heldDirectories.push(manifestHeld);
		const claudeManifestHeld = openHeldDirectory(claudeManifestRoot, "plugins/stdd/.claude-plugin");
		heldDirectories.push(claudeManifestHeld);
		const extensionSourceHeld = openHeldDirectory(extensionSourceRoot, "Pi extension source directory");
		heldDirectories.push(extensionSourceHeld);
		const extensionsHeld = fs.existsSync(extensionsRoot)
			? openHeldDirectory(extensionsRoot, "plugins/stdd/extensions")
			: ensureHeldChildDirectory(pluginHeld, "extensions", "plugins/stdd/extensions");
		heldDirectories.push(extensionsHeld);
		const skillsHeld = openHeldDirectory(skillsRoot, "plugins/stdd/skills");
		heldDirectories.push(skillsHeld);
		const playbooksHeld = openHeldDirectory(playbooksRoot, "playbooks directory");
		heldDirectories.push(playbooksHeld);
		const runtimeHeld = fs.existsSync(runtimeRoot)
			? openHeldDirectory(runtimeRoot, "plugins/stdd/runtime")
			: ensureHeldChildDirectory(pluginHeld, "runtime", "plugins/stdd/runtime");
		heldDirectories.push(runtimeHeld);
		const runtimeSourceDirectories = new Map();
		const runtimeOutputDirectories = new Map();
		for (const directory of RUNTIME_DIRECTORIES) {
			const sourceHeld = openHeldDirectory(path.join(root, directory), `${directory} runtime source`);
			heldDirectories.push(sourceHeld);
			runtimeSourceDirectories.set(directory, sourceHeld);
			const outputPath = path.join(runtimeRoot, directory);
			const outputHeld = fs.existsSync(outputPath)
				? openHeldDirectory(outputPath, `plugins/stdd/runtime/${directory}`)
				: ensureHeldChildDirectory(runtimeHeld, directory, `plugins/stdd/runtime/${directory}`);
			heldDirectories.push(outputHeld);
			runtimeOutputDirectories.set(directory, outputHeld);
		}

		const manifest = JSON.parse(
			readHeldRegularFile(manifestHeld, "plugin.json", "plugins/stdd/.codex-plugin/plugin.json"),
		);
		const claudeManifest = JSON.parse(
			readHeldRegularFile(claudeManifestHeld, "plugin.json", "plugins/stdd/.claude-plugin/plugin.json"),
		);
		const piManifest = JSON.parse(
			readHeldRegularFile(pluginHeld, "package.json", "plugins/stdd/package.json"),
		);
		validateCodexManifest(manifest);
		validateClaudeManifest(claudeManifest);
		validatePiManifest(piManifest);
		manifest.version = pkg.version;
		claudeManifest.version = pkg.version;
		piManifest.version = pkg.version;

		const stamp = `generated by stdd plugin build v${pkg.version} — do not edit`;
		const generatedNames = new Set();
		const generatedSkills = new Map();
		for (const file of fs.readdirSync(playbooksHeld.heldPath).filter((name) => name.endsWith(".md"))) {
			const source = readHeldRegularFile(playbooksHeld, file, `playbook ${file}`, {
				requireSingleLink: true,
			});
			const { meta, body } = parseFrontmatter(source);
			assertSkillName(meta.name, `playbook ${file} name`);
			if (generatedNames.has(meta.name)) {
				throw new Error(`duplicate plugin skill name ${JSON.stringify(meta.name)}`);
			}
			const output = renderAgentSkill({
				adapter: "codex",
				name: meta.name,
				description: meta.description,
				when: meta.when,
				body: compileCapabilities(body, DEFAULT_CONFIG.capabilities),
				stamp,
			});
			generatedNames.add(meta.name);
			generatedSkills.set(meta.name, output);
		}

		const existingSkillNames = new Set();
		const staleSkillNames = [];
		for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
			const skillDir = path.join(skillsRoot, entry.name);
			requireSafeDirectory(skillDir, `plugin skill ${entry.name}`);
			existingSkillNames.add(entry.name);
			if (generatedNames.has(entry.name)) {
				requireSafeRegularFile(path.join(skillDir, "SKILL.md"), `plugin skill ${entry.name}/SKILL.md`, {
					allowMissing: true,
				});
			} else {
				requireSafeTree(skillDir, `stale plugin skill ${entry.name}`);
				staleSkillNames.push(entry.name);
			}
		}

		const activeSkillDirectories = new Map();
		for (const name of generatedNames) {
			if (!existingSkillNames.has(name)) continue;
			const held = openHeldDirectory(path.join(skillsRoot, name), `plugin skill ${name}`);
			heldDirectories.push(held);
			activeSkillDirectories.set(name, held);
		}

		// Move stale load paths out of `skills/` before publishing any file
		// bytes. Node has no unlinkat(2)-equivalent, so recursive deletion
		// would reintroduce a final-basename race. Keep the verified inode in
		// a non-loadable, owner-private quarantine for explicit settlement.
		if (staleSkillNames.length > 0) {
			const quarantine = ensureHeldChildDirectory(
				pluginHeld,
				".stdd-plugin-quarantine",
				"plugins/stdd/.stdd-plugin-quarantine",
				0o700,
			);
			heldDirectories.push(quarantine);
			atomicWriteFile(
				quarantine,
				"README.txt",
				QUARANTINE_README,
				"plugins/stdd/.stdd-plugin-quarantine/README.txt",
			);
			for (const name of staleSkillNames) quarantineStaleSkill(skillsHeld, quarantine, name);
		}

		for (const name of generatedNames) {
			if (activeSkillDirectories.has(name)) continue;
			const held = ensureHeldChildDirectory(skillsHeld, name, `plugin skill ${name}`);
			heldDirectories.push(held);
			activeSkillDirectories.set(name, held);
		}

		for (const [name, output] of generatedSkills) {
			atomicWriteFile(
				activeSkillDirectories.get(name),
				"SKILL.md",
				output,
				`plugin skill ${name}/SKILL.md`,
			);
		}
		const extensionSource = readHeldRegularFile(
			extensionSourceHeld,
			"pi-extension.mjs",
			"Pi extension source",
			{ requireSingleLink: true },
		);
		atomicWriteFile(extensionsHeld, "stdd.mjs", extensionSource, "plugins/stdd/extensions/stdd.mjs");
		const licenseSource = readHeldRegularFile(sourceRootHeld, "LICENSE", "package license source", {
			requireSingleLink: true,
		});
		atomicWriteFile(pluginHeld, "LICENSE", licenseSource, "plugins/stdd/LICENSE");
		atomicWriteFile(
			manifestHeld,
			"plugin.json",
			`${JSON.stringify(manifest, null, "  ")}\n`,
			"plugins/stdd/.codex-plugin/plugin.json",
		);
		atomicWriteFile(
			claudeManifestHeld,
			"plugin.json",
			`${JSON.stringify(claudeManifest, null, "  ")}\n`,
			"plugins/stdd/.claude-plugin/plugin.json",
		);
		atomicWriteFile(
			pluginHeld,
			"package.json",
			`${JSON.stringify(piManifest, null, "  ")}\n`,
			"plugins/stdd/package.json",
		);
		for (const relative of runtimeFiles.keys()) {
			if (relative === "package.json") continue;
			const [directory, file] = relative.split("/");
			const content = readHeldRegularFile(
				runtimeSourceDirectories.get(directory),
				file,
				`plugin runtime source ${relative}`,
				{ requireSingleLink: true },
			);
			atomicWriteFile(
				runtimeOutputDirectories.get(directory),
				file,
				content,
				`plugins/stdd/runtime/${relative}`,
			);
		}
		// Publish the version-bearing package file last: after an interruption,
		// it must never claim newer runtime code than the files beside it.
		atomicWriteFile(runtimeHeld, "package.json", packageSource, "plugins/stdd/runtime/package.json");
		console.log(`Built universal STDD plugin skills and runtime for v${pkg.version}`);
	} finally {
		for (const held of heldDirectories.reverse()) closeHeldDirectory(held);
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) buildPlugin();
