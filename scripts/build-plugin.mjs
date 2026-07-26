#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCapabilities, DEFAULT_CONFIG, parseFrontmatter } from "../cli/lib.mjs";
import { renderAgentSkill } from "../sdk/adapters.mjs";
import { assertSkillName } from "../sdk/path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUARANTINE_README =
	"STDD plugin build quarantine.\n\n" +
	"These stale generated skill directories were removed from the active skills registry but retained " +
	"because Node.js has no descriptor-relative unlink primitive. Inspect and remove this directory manually.\n";

function validateDefaultPrompts(manifest) {
	const prompts = manifest?.interface?.defaultPrompt;
	if (
		!Array.isArray(prompts) ||
		prompts.length === 0 ||
		prompts.length > 3 ||
		prompts.some((prompt) => typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 128)
	) {
		throw new TypeError(
			"plugin interface.defaultPrompt must be an array of 1-3 non-empty strings up to 128 characters",
		);
	}
}

function lstatOrNull(target) {
	try {
		return fs.lstatSync(target);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

function requireSafeDirectory(target, label) {
	const observed = lstatOrNull(target);
	if (!observed) throw new Error(`${label} is missing; expected a non-symlinked directory`);
	if (observed.isSymbolicLink()) {
		throw new Error(`${label} is a symlink and is unsafe for plugin publication`);
	}
	if (!observed.isDirectory()) {
		throw new Error(`${label} is not a directory and is unsafe for plugin publication`);
	}
	return observed;
}

function requireSafeRegularFile(target, label, { allowMissing = false } = {}) {
	const observed = lstatOrNull(target);
	if (!observed && allowMissing) return null;
	if (!observed) throw new Error(`${label} is missing; expected a non-symlinked regular file`);
	if (observed.isSymbolicLink()) {
		throw new Error(`${label} is a symlink and is unsafe for plugin publication`);
	}
	if (!observed.isFile()) {
		throw new Error(`${label} is not a regular file and is unsafe for plugin publication`);
	}
	return observed;
}

function requireSafeTree(target, label) {
	requireSafeDirectory(target, label);
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		const child = path.join(target, entry.name);
		const childLabel = `${label}/${entry.name}`;
		const observed = fs.lstatSync(child);
		if (observed.isSymbolicLink()) {
			throw new Error(`${childLabel} is a symlink and is unsafe for plugin publication`);
		}
		if (observed.isDirectory()) requireSafeTree(child, childLabel);
		else if (!observed.isFile()) {
			throw new Error(`${childLabel} is not a regular file and is unsafe for plugin publication`);
		}
	}
}

function sameFileObservation(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function openHeldDirectory(logicalPath, label) {
	const before = fs.lstatSync(logicalPath, { bigint: true });
	if (before.isSymbolicLink() || !before.isDirectory()) {
		throw new Error(`${label} must remain a non-symlinked directory`);
	}
	const descriptor = fs.openSync(
		logicalPath,
		fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
	);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const atPath = fs.lstatSync(logicalPath, { bigint: true });
		const heldPath = `/proc/self/fd/${descriptor}`;
		if (
			!opened.isDirectory() ||
			!sameFileObservation(opened, atPath) ||
			fs.realpathSync(heldPath) !== fs.realpathSync(logicalPath)
		) {
			throw new Error(`${label} changed while its publication boundary was opened`);
		}
		return { descriptor, heldPath, logicalPath, opened, label };
	} catch (err) {
		fs.closeSync(descriptor);
		throw err;
	}
}

function closeHeldDirectory(held) {
	fs.closeSync(held.descriptor);
}

function assertHeldDirectoryAttached(held) {
	let logical;
	try {
		logical = fs.lstatSync(held.logicalPath, { bigint: true });
	} catch (err) {
		throw new Error(`${held.label} changed during plugin publication: ${err.message}`);
	}
	if (
		logical.isSymbolicLink() ||
		!logical.isDirectory() ||
		logical.dev !== held.opened.dev ||
		logical.ino !== held.opened.ino ||
		fs.realpathSync(held.heldPath) !== fs.realpathSync(held.logicalPath)
	) {
		throw new Error(`${held.label} changed identity during plugin publication`);
	}
}

function observeHeldRegularFile(
	held,
	name,
	label,
	{ allowMissing = false, requireSingleLink = false } = {},
) {
	const heldTarget = path.join(held.heldPath, name);
	const logicalTarget = path.join(held.logicalPath, name);
	const heldObserved = lstatOrNull(heldTarget);
	const logicalObserved = lstatOrNull(logicalTarget);
	if (!heldObserved || !logicalObserved) {
		if (allowMissing && !heldObserved && !logicalObserved) return null;
		throw new Error(`${label} changed or disappeared during plugin publication`);
	}
	if (
		heldObserved.isSymbolicLink() ||
		logicalObserved.isSymbolicLink() ||
		!heldObserved.isFile() ||
		!logicalObserved.isFile()
	) {
		throw new Error(`${label} is not a safe regular file during plugin publication`);
	}
	const heldBig = fs.lstatSync(heldTarget, { bigint: true });
	const logicalBig = fs.lstatSync(logicalTarget, { bigint: true });
	if (!sameFileObservation(heldBig, logicalBig)) {
		throw new Error(`${label} changed identity during plugin publication`);
	}
	if (requireSingleLink && (heldBig.nlink !== 1n || logicalBig.nlink !== 1n)) {
		throw new Error(`${label} must remain a single-link regular file during plugin publication`);
	}
	return heldBig;
}

function readHeldRegularFile(held, name, label, options = {}) {
	assertHeldDirectoryAttached(held);
	const expected = observeHeldRegularFile(held, name, label, options);
	const target = path.join(held.heldPath, name);
	const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!sameFileObservation(expected, opened)) {
			throw new Error(`${label} changed while it was opened`);
		}
		const content = fs.readFileSync(descriptor, "utf8");
		const after = fs.fstatSync(descriptor, { bigint: true });
		const namespaceAfter = observeHeldRegularFile(held, name, label, options);
		if (!sameFileObservation(opened, after) || !sameFileObservation(after, namespaceAfter)) {
			throw new Error(`${label} changed while it was read`);
		}
		assertHeldDirectoryAttached(held);
		return content;
	} finally {
		fs.closeSync(descriptor);
	}
}

function atomicWriteFile(held, name, content, label) {
	assertHeldDirectoryAttached(held);
	const existing = observeHeldRegularFile(held, name, label, { allowMissing: true });
	const temporaryName = `.${name}-${randomBytes(16).toString("hex")}.tmp`;
	const temporary = path.join(held.heldPath, temporaryName);
	const target = path.join(held.heldPath, name);
	let descriptor = null;
	let operationError = null;
	try {
		descriptor = fs.openSync(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			existing ? Number(existing.mode & 0o777n) : 0o644,
		);
		fs.writeFileSync(descriptor, content);
		fs.fsyncSync(descriptor);
		const temporaryObserved = fs.fstatSync(descriptor, { bigint: true });
		fs.closeSync(descriptor);
		descriptor = null;
		assertHeldDirectoryAttached(held);
		const beforeRename = observeHeldRegularFile(held, name, label, { allowMissing: true });
		if (
			(existing === null) !== (beforeRename === null) ||
			(existing !== null && !sameFileObservation(existing, beforeRename))
		) {
			throw new Error(`${label} changed before atomic publication`);
		}
		fs.renameSync(temporary, target);
		fs.fsyncSync(held.descriptor);
		const published = fs.lstatSync(target, { bigint: true });
		if (
			published.isSymbolicLink() ||
			!published.isFile() ||
			published.dev !== temporaryObserved.dev ||
			published.ino !== temporaryObserved.ino
		) {
			throw new Error(`${label} did not retain the atomically published file identity`);
		}
		assertHeldDirectoryAttached(held);
		const logicalPublished = observeHeldRegularFile(held, name, label);
		if (logicalPublished.dev !== published.dev || logicalPublished.ino !== published.ino) {
			throw new Error(`${label} changed after atomic publication`);
		}
	} catch (err) {
		operationError = err;
	} finally {
		if (descriptor !== null) fs.closeSync(descriptor);
	}
	if (operationError) {
		const retained = lstatOrNull(temporary);
		throw new Error(
			`${operationError.message}${
				retained
					? `; unverified publication temp ${path.join(
							held.logicalPath,
							temporaryName,
						)} was retained — inspect and remove it manually`
					: ""
			}`,
			{ cause: operationError },
		);
	}
}

function ensureHeldChildDirectory(parent, name, label, mode = 0o755) {
	assertHeldDirectoryAttached(parent);
	const heldChild = path.join(parent.heldPath, name);
	const logicalChild = path.join(parent.logicalPath, name);
	const heldBefore = lstatOrNull(heldChild);
	const logicalBefore = lstatOrNull(logicalChild);
	if (!heldBefore && !logicalBefore) {
		fs.mkdirSync(heldChild, { mode });
		fs.fsyncSync(parent.descriptor);
	} else if (!heldBefore || !logicalBefore) {
		throw new Error(`${label} changed before directory creation`);
	}
	assertHeldDirectoryAttached(parent);
	const child = openHeldDirectory(logicalChild, label);
	try {
		const throughParent = fs.lstatSync(heldChild, { bigint: true });
		if (throughParent.dev !== child.opened.dev || throughParent.ino !== child.opened.ino) {
			throw new Error(`${label} changed identity after directory creation`);
		}
		return child;
	} catch (err) {
		closeHeldDirectory(child);
		throw err;
	}
}

function quarantineStaleSkill(skills, quarantine, name) {
	const label = `stale plugin skill ${name}`;
	assertHeldDirectoryAttached(skills);
	assertHeldDirectoryAttached(quarantine);
	const source = path.join(skills.heldPath, name);
	const logicalSource = path.join(skills.logicalPath, name);
	const sourceObserved = fs.lstatSync(source, { bigint: true });
	const logicalObserved = fs.lstatSync(logicalSource, { bigint: true });
	if (
		sourceObserved.isSymbolicLink() ||
		!sourceObserved.isDirectory() ||
		!sameFileObservation(sourceObserved, logicalObserved)
	) {
		throw new Error(`${label} changed before confined quarantine`);
	}
	const retiredName = `${name}-${randomBytes(16).toString("hex")}.retired`;
	const retired = path.join(quarantine.heldPath, retiredName);
	const logicalRetired = path.join(quarantine.logicalPath, retiredName);
	if (lstatOrNull(retired) || lstatOrNull(logicalRetired)) {
		throw new Error(`${label} quarantine target unexpectedly exists`);
	}
	fs.renameSync(source, retired);
	fs.fsyncSync(skills.descriptor);
	fs.fsyncSync(quarantine.descriptor);
	const retiredObserved = fs.lstatSync(retired, { bigint: true });
	if (
		retiredObserved.dev !== sourceObserved.dev ||
		retiredObserved.ino !== sourceObserved.ino ||
		retiredObserved.mode !== sourceObserved.mode
	) {
		throw new Error(`${label} changed during confined quarantine`);
	}
	try {
		assertHeldDirectoryAttached(skills);
		assertHeldDirectoryAttached(quarantine);
		if (lstatOrNull(logicalSource)) {
			throw new Error(`${label} remained at its logical load path after quarantine`);
		}
		const logicalRetiredObserved = fs.lstatSync(logicalRetired, { bigint: true });
		if (
			logicalRetiredObserved.isSymbolicLink() ||
			!logicalRetiredObserved.isDirectory() ||
			logicalRetiredObserved.dev !== retiredObserved.dev ||
			logicalRetiredObserved.ino !== retiredObserved.ino
		) {
			throw new Error(`${label} quarantine target changed identity`);
		}
	} catch (err) {
		try {
			const currentRetired = fs.lstatSync(retired, { bigint: true });
			if (
				currentRetired.dev === sourceObserved.dev &&
				currentRetired.ino === sourceObserved.ino &&
				!lstatOrNull(source)
			) {
				fs.renameSync(retired, source);
			}
			fs.fsyncSync(skills.descriptor);
			fs.fsyncSync(quarantine.descriptor);
		} catch {
			// Preserve the confined quarantine rather than touching
			// the now-untrusted logical namespace.
		}
		throw err;
	}
	return retiredName;
}

export function buildPlugin(root = ROOT) {
	const pluginsRoot = path.join(root, "plugins");
	const pluginRoot = path.join(root, "plugins", "stdd");
	const skillsRoot = path.join(pluginRoot, "skills");
	const manifestRoot = path.join(pluginRoot, ".codex-plugin");
	const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	const hooksRoot = path.join(pluginRoot, "hooks");
	const scriptsRoot = path.join(pluginRoot, "scripts");
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
	requireSafeDirectory(skillsRoot, "plugins/stdd/skills");
	requireSafeTree(hooksRoot, "plugins/stdd/hooks");
	requireSafeTree(scriptsRoot, "plugins/stdd/scripts");

	const playbooksRoot = path.join(root, "playbooks");
	requireSafeDirectory(playbooksRoot, "playbooks directory");
	const heldDirectories = [];
	try {
		const pluginHeld = openHeldDirectory(pluginRoot, "plugins/stdd");
		heldDirectories.push(pluginHeld);
		const manifestHeld = openHeldDirectory(manifestRoot, "plugins/stdd/.codex-plugin");
		heldDirectories.push(manifestHeld);
		const skillsHeld = openHeldDirectory(skillsRoot, "plugins/stdd/skills");
		heldDirectories.push(skillsHeld);
		const playbooksHeld = openHeldDirectory(playbooksRoot, "playbooks directory");
		heldDirectories.push(playbooksHeld);

		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const manifest = JSON.parse(
			readHeldRegularFile(manifestHeld, "plugin.json", "plugins/stdd/.codex-plugin/plugin.json"),
		);
		validateDefaultPrompts(manifest);
		manifest.version = pkg.version;

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
		atomicWriteFile(
			manifestHeld,
			"plugin.json",
			`${JSON.stringify(manifest, null, "  ")}\n`,
			"plugins/stdd/.codex-plugin/plugin.json",
		);
		console.log(`Built STDD Codex plugin skills for v${pkg.version}`);
	} finally {
		for (const held of heldDirectories.reverse()) closeHeldDirectory(held);
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) buildPlugin();
