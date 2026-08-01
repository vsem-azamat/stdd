#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCapabilities, DEFAULT_CONFIG, parseFrontmatter } from "../cli/lib.mjs";
import { renderAgentSkill } from "../sdk/adapters.mjs";
import { nativeFsTarget, openNativeFsSession } from "../sdk/native-fs.mjs";
import { assertSkillName } from "../sdk/path.mjs";
import { verifyNativePrebuilds } from "./verify-native-prebuilds.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const QUARANTINE_README =
	"STDD plugin build quarantine.\n\n" +
	"These stale generated skill directories were removed from the active skills registry but are deliberately retained " +
	"for explicit operator settlement. Plugin builds never recursively delete a final quarantine basename. Inspect and remove this directory manually.\n";
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

const FLAT_RUNTIME_DIRECTORIES = Object.freeze([
	"cli",
	"sdk",
	"method",
	"playbooks",
	"templates",
	"adapters",
]);
export const RUNTIME_DIRECTORIES = Object.freeze([...FLAT_RUNTIME_DIRECTORIES, "prebuilds"]);

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

const ERROR_FIELDS = ["code", "class", "operation", "osCode", "mutation", "retryable"];

function wrappedNativeError(label, error, detail) {
	const suffix = detail ?? error?.message ?? String(error);
	const metadata = error?.code
		? ` [code=${error.code} operation=${error.operation ?? "unknown"} mutation=${error.mutation ?? "unknown"}]`
		: "";
	const wrapped = new Error(`${label}: ${suffix}${metadata}`, { cause: error });
	for (const field of ERROR_FIELDS) {
		if (error && field in error) wrapped[field] = error[field];
	}
	return wrapped;
}

function unsafeDetail(error, kind) {
	if (error?.code === "symlink-rejected") return `is a symlink and is unsafe for plugin publication`;
	if (error?.code === "not-directory" || error?.code === "not-directory-capability") {
		return `must be a directory and is unsafe for plugin publication`;
	}
	if (error?.code === "not-file") return `must be a regular file and is unsafe for plugin publication`;
	return kind ? `could not be opened as a safe ${kind}: ${error?.message ?? String(error)}` : undefined;
}

async function nativeCall(label, action, kind) {
	try {
		return await action();
	} catch (error) {
		throw wrappedNativeError(label, error, unsafeDetail(error, kind));
	}
}

function sameIdentity(left, right) {
	return (
		left?.version === right?.version &&
		left?.platform === right?.platform &&
		left?.volume === right?.volume &&
		left?.fileId === right?.fileId &&
		left?.kind === right?.kind
	);
}

function sameObservation(left, right) {
	return (
		sameIdentity(left?.identity, right?.identity) &&
		left?.owner === right?.owner &&
		left?.permissions === right?.permissions &&
		left?.linkCount === right?.linkCount &&
		left?.size === right?.size &&
		left?.modifiedNs === right?.modifiedNs &&
		left?.changedNs === right?.changedNs
	);
}

function relativeParts(relative) {
	return relative === "" ? [] : relative.split("/");
}

async function listEntries(session, directory, label) {
	const entries = [];
	let cursor = null;
	do {
		const page = await nativeCall(label, () => session.list(directory.cap, { cursor, limit: 256 }));
		entries.push(...page.entries);
		cursor = page.cursor;
	} while (cursor !== null);
	return entries;
}

async function openRelative(session, root, relative, label, expectedKind, opened = []) {
	let current = root;
	for (const segment of relativeParts(relative)) {
		current = await nativeCall(label, () => session.openChild(current.cap, segment), expectedKind);
		opened.push(current);
	}
	if (expectedKind && current.observation.identity.kind !== expectedKind) {
		throw new Error(`${label} must be a ${expectedKind === "file" ? "regular file" : "directory"}`);
	}
	return current;
}

async function optionalChild(session, parent, name, label) {
	try {
		return await session.openChild(parent.cap, name);
	} catch (error) {
		if (error?.code === "not-found") return null;
		throw wrappedNativeError(label, error, unsafeDetail(error));
	}
}

async function closeCapabilities(session, capabilities) {
	const closed = new Set();
	for (const capability of [...capabilities].reverse()) {
		if (!capability?.cap || closed.has(capability.cap)) continue;
		closed.add(capability.cap);
		try {
			await session.closeCapability(capability.cap);
		} catch {
			// Capability release is best-effort once a transport has failed; never
			// replace the actionable mutation/retained-path diagnostic.
		}
	}
}

async function assertRebound(session, absoluteRoot, originalRoot, relative, expected, label) {
	const opened = [];
	try {
		const reboundRoot = await nativeCall(label, () => session.openRoot(absoluteRoot), "directory");
		opened.push(reboundRoot);
		if (!sameIdentity(reboundRoot.observation.identity, originalRoot.observation.identity)) {
			throw new Error(`${label} changed identity during plugin publication`);
		}
		const rebound = await openRelative(
			session,
			reboundRoot,
			relative,
			label,
			expected.identity.kind,
			opened,
		);
		if (!sameIdentity(rebound.observation.identity, expected.identity)) {
			throw new Error(`${label} changed identity during plugin publication`);
		}
		return { observation: rebound.observation };
	} finally {
		await closeCapabilities(session, opened);
	}
}

async function assertReboundStat(session, absoluteRoot, originalRoot, relative, expected, label) {
	const parts = relativeParts(relative);
	const name = parts.pop();
	const parentRelative = parts.join("/");
	const opened = [];
	try {
		const reboundRoot = await nativeCall(label, () => session.openRoot(absoluteRoot), "directory");
		opened.push(reboundRoot);
		if (!sameIdentity(reboundRoot.observation.identity, originalRoot.observation.identity)) {
			throw new Error(`${label} changed identity during plugin publication`);
		}
		const parent = await openRelative(session, reboundRoot, parentRelative, label, "directory", opened);
		const rebound = await nativeCall(label, () => session.stat(parent.cap, name));
		if (!sameIdentity(rebound.observation.identity, expected.identity)) {
			throw new Error(`${label} changed identity during plugin publication`);
		}
		return rebound;
	} finally {
		await closeCapabilities(session, opened);
	}
}

async function assertExactNames(session, directory, expected, label) {
	const actual = (await listEntries(session, directory, label)).map(({ name }) => name).sort();
	const canonical = [...expected].sort();
	if (actual.length !== canonical.length || actual.some((entry, index) => entry !== canonical[index])) {
		throw new Error(
			`${label} has missing or extra entries (expected ${canonical.join(", ")}, found ${actual.join(", ")})`,
		);
	}
}

async function validateTree(session, directory, label) {
	for (const entry of await listEntries(session, directory, label)) {
		const childLabel = `${label}/${entry.name}`;
		if (entry.observation.identity.kind === "directory") {
			const child = await nativeCall(childLabel, () => session.openChild(directory.cap, entry.name));
			try {
				await validateTree(session, child, childLabel);
			} finally {
				await closeCapabilities(session, [child]);
			}
		} else if (entry.observation.identity.kind !== "file") {
			throw new Error(
				`${childLabel} is a symlink or non-regular object and is unsafe for plugin publication`,
			);
		}
	}
}

async function readCapabilityBytes(session, file, size, label) {
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_BYTES) {
		throw new Error(`${label} is oversized`);
	}
	const chunks = [];
	let offset = 0;
	while (offset < size) {
		const requested = Math.min(CHUNK_BYTES, size - offset);
		const result = await nativeCall(label, () => session.read(file.cap, offset, requested));
		const chunk = Buffer.from(result.data, "base64");
		if (chunk.length === 0) throw new Error(`${label} changed while being read`);
		chunks.push(chunk);
		offset += chunk.length;
	}
	const extra = await nativeCall(label, () => session.read(file.cap, offset, 1));
	if (Buffer.from(extra.data, "base64").length !== 0 || !extra.eof) {
		throw new Error(`${label} changed while being read`);
	}
	return Buffer.concat(chunks, offset);
}

async function readExactSource(context, parent, name, relative, label, options = {}) {
	const file = await nativeCall(label, () => context.session.openChild(parent.cap, name), "file");
	if (file.observation.identity.kind !== "file") throw new Error(`${label} must be a regular file`);
	if (options.requireSingleLink && file.observation.linkCount !== "1") {
		throw new Error(`${label} must be a single-link regular file`);
	}
	const size = Number(file.observation.size);
	const first = await readCapabilityBytes(context.session, file, size, label);
	const after = await nativeCall(label, () => context.session.stat(file.cap));
	if (!sameObservation(after.observation, file.observation)) {
		throw new Error(`${label} changed while being read`);
	}
	const second = await readCapabilityBytes(context.session, file, size, label);
	if (!first.equals(second)) throw new Error(`${label} changed while being read`);
	await assertRebound(
		context.session,
		context.absoluteRoot,
		context.root,
		relative,
		file.observation,
		label,
	);
	const source = { relative, label, observation: file.observation, bytes: first, file };
	context.sources.push(source);
	return source;
}

function modeBits(observation) {
	if (observation.identity.platform === "win32") return null;
	return Number(BigInt(observation.permissions) & 0o777n);
}

function readBootstrapFile(filePath, label) {
	const before = fs.lstatSync(filePath, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
		throw new Error(`${label} must be a single-link regular file`);
	}
	const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
			throw new Error(`${label} changed while opening`);
		}
		const bytes = fs.readFileSync(descriptor);
		const after = fs.fstatSync(descriptor, { bigint: true });
		const rebound = fs.lstatSync(filePath, { bigint: true });
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size ||
			rebound.dev !== opened.dev ||
			rebound.ino !== opened.ino ||
			BigInt(bytes.length) !== opened.size
		) {
			throw new Error(`${label} changed while being read`);
		}
		return bytes;
	} finally {
		fs.closeSync(descriptor);
	}
}

async function assertSessionArtifactAttached(session, label) {
	const artifact = session.artifact;
	if (!artifact?.handle || typeof artifact.path !== "string") {
		throw new Error(`${label}: native session did not retain its verified helper capability`);
	}
	const opened = await artifact.handle.stat({ bigint: true });
	const installed = fs.lstatSync(artifact.path, { bigint: true });
	if (
		!opened.isFile() ||
		opened.isSymbolicLink() ||
		!installed.isFile() ||
		installed.isSymbolicLink() ||
		opened.dev !== artifact.dev ||
		opened.ino !== artifact.ino ||
		opened.size !== BigInt(artifact.size) ||
		installed.dev !== opened.dev ||
		installed.ino !== opened.ino ||
		installed.size !== opened.size ||
		installed.mode !== opened.mode
	) {
		throw new Error(`${label} changed after native helper verification`);
	}
	return artifact;
}

async function readSessionArtifact(session, expected, label) {
	const artifact = await assertSessionArtifactAttached(session, label);
	if (
		artifact.target !== expected.target ||
		artifact.size !== expected.size ||
		artifact.sha256 !== expected.sha256
	) {
		throw new Error(`${label} does not match the verified native manifest`);
	}
	const bytes = Buffer.alloc(expected.size);
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesRead } = await artifact.handle.read(
			bytes,
			offset,
			Math.min(CHUNK_BYTES, bytes.length - offset),
			offset,
		);
		if (bytesRead === 0) throw new Error(`${label} changed while being read`);
		offset += bytesRead;
	}
	await assertSessionArtifactAttached(session, label);
	if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected.sha256) {
		throw new Error(`${label} changed after native helper verification`);
	}
	return bytes;
}

async function preflightFile(context, parent, name, label) {
	const existing = await optionalChild(context.session, parent, name, label);
	if (!existing) return null;
	try {
		if (existing.observation.identity.kind !== "file") {
			throw new Error(`${label} must be a regular file and is unsafe for plugin publication`);
		}
		return existing.observation;
	} finally {
		await closeCapabilities(context.session, [existing]);
	}
}

async function ensureDirectory(context, relative, label, mode = 0o755) {
	if (context.directories.has(relative)) return context.directories.get(relative);
	const parts = relativeParts(relative);
	const name = parts.pop();
	const parentRelative = parts.join("/");
	const parent = await ensureDirectory(context, parentRelative, parentRelative || "package source root");
	const created = await nativeCall(label, () => context.session.createDirectory(parent.cap, name, mode));
	await nativeCall(label, () =>
		context.session.flush(parent.cap, "namespace", parent.observation.identity),
	);
	await assertRebound(
		context.session,
		context.absoluteRoot,
		context.root,
		relative,
		created.observation,
		label,
	);
	context.directories.set(relative, created);
	return created;
}

async function preflightDirectory(context, relative, label, required = true) {
	if (context.directories.has(relative)) return context.directories.get(relative);
	const parts = relativeParts(relative);
	const name = parts.pop();
	const parentRelative = parts.join("/");
	const parent = context.directories.get(parentRelative);
	if (!parent) {
		if (required) throw new Error(`${label} is missing; expected a directory`);
		return null;
	}
	const child = await optionalChild(context.session, parent, name, label);
	if (!child) {
		if (required) throw new Error(`${label} is missing; expected a directory`);
		return null;
	}
	if (child.observation.identity.kind !== "directory") {
		throw new Error(`${label} must be a directory and is unsafe for plugin publication`);
	}
	context.directories.set(relative, child);
	return child;
}

async function assertTargetUnchanged(context, parent, name, original, label) {
	try {
		const now = await context.session.stat(parent.cap, name);
		if (!original || !sameObservation(now.observation, original)) {
			throw new Error(`${label} changed before publication`);
		}
	} catch (error) {
		if (error?.code === "not-found" && !original) return;
		if (error?.message?.includes("changed before publication")) throw error;
		throw wrappedNativeError(label, error);
	}
}

async function publishFile(context, parentRelative, name, content, label, options = {}) {
	const parent = context.directories.get(parentRelative);
	if (!parent) throw new Error(`${label}: publication parent was not prepared`);
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
	const existing = options.existing ?? null;
	const mode = options.mode ?? 0o644;
	const temporaryName = `.${name}-${randomBytes(16).toString("hex")}.tmp`;
	let temporary = null;
	let finalFile = null;
	try {
		temporary = await nativeCall(label, () =>
			context.session.createFile(parent.cap, temporaryName, mode),
		);
		let offset = 0;
		while (offset < bytes.length) {
			const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
			const result = await nativeCall(label, () =>
				context.session.write(temporary.cap, offset, chunk, temporary.observation.identity),
			);
			if (result.written < 1) throw new Error(`${label}: native helper made no write progress`);
			offset += result.written;
		}
		await nativeCall(label, () =>
			context.session.truncate(temporary.cap, bytes.length, temporary.observation.identity),
		);
		await nativeCall(label, () =>
			context.session.flush(temporary.cap, "all", temporary.observation.identity),
		);
		const verified = await readCapabilityBytes(context.session, temporary, bytes.length, label);
		const temporaryStat = await nativeCall(label, () => context.session.stat(temporary.cap));
		if (
			!verified.equals(bytes) ||
			!sameIdentity(temporaryStat.observation.identity, temporary.observation.identity) ||
			(modeBits(temporaryStat.observation) !== null && modeBits(temporaryStat.observation) !== mode)
		) {
			throw new Error(`${label}: temporary publication verification failed`);
		}
		await assertTargetUnchanged(context, parent, name, existing, label);
		const renamed = await nativeCall(label, () =>
			context.session.rename({
				fromParent: parent.cap,
				from: temporaryName,
				expected: temporary.observation.identity,
				toParent: parent.cap,
				to: name,
				replace: existing ? "any" : "never",
				...(existing ? { expectedTarget: null } : {}),
			}),
		);
		await nativeCall(label, () =>
			context.session.flush(parent.cap, "namespace", parent.observation.identity),
		);
		finalFile = await nativeCall(label, () => context.session.openChild(parent.cap, name), "file");
		if (!sameIdentity(finalFile.observation.identity, renamed.observation.identity)) {
			throw new Error(`${label} changed after publication`);
		}
		const relative = parentRelative ? `${parentRelative}/${name}` : name;
		await assertRebound(
			context.session,
			context.absoluteRoot,
			context.root,
			relative,
			finalFile.observation,
			label,
		);
	} catch (error) {
		if (!temporary) throw error;
		const mutation = error?.mutation ?? error?.cause?.mutation ?? "unknown";
		const retained = `${parentRelative}/${temporaryName}`;
		const wrapped = new Error(
			`${error.message}; temporary publication ${retained} may remain (mutation=${mutation}); inspect it manually`,
			{ cause: error },
		);
		for (const field of ERROR_FIELDS) {
			if (error && field in error) wrapped[field] = error[field];
		}
		throw wrapped;
	} finally {
		await closeCapabilities(context.session, [temporary, finalFile]);
	}
}

async function quarantineStaleSkill(context, skills, quarantine, name, expected) {
	const label = `stale plugin skill ${name}`;
	const before = await nativeCall(label, () => context.session.stat(skills.cap, name));
	if (!sameObservation(before.observation, expected)) {
		throw new Error(`${label} changed before quarantine`);
	}
	const retiredName = `${name}-${randomBytes(16).toString("hex")}.retired`;
	const occupied = await optionalChild(context.session, quarantine, retiredName, label);
	if (occupied) {
		await closeCapabilities(context.session, [occupied]);
		throw new Error(`${label}: quarantine destination unexpectedly exists`);
	}
	let moved = false;
	let retiredCapability = null;
	try {
		await nativeCall(label, () =>
			context.session.rename({
				fromParent: skills.cap,
				from: name,
				expected: expected.identity,
				toParent: quarantine.cap,
				to: retiredName,
				replace: "never",
			}),
		);
		moved = true;
		await nativeCall(label, () =>
			context.session.flush(skills.cap, "namespace", skills.observation.identity),
		);
		await nativeCall(label, () =>
			context.session.flush(quarantine.cap, "namespace", quarantine.observation.identity),
		);
		try {
			await context.session.stat(skills.cap, name);
			throw new Error(`${label} remained in the active registry after quarantine`);
		} catch (error) {
			if (error?.code !== "not-found") throw error;
		}
		retiredCapability = await nativeCall(label, () =>
			context.session.openChild(quarantine.cap, retiredName),
		);
		if (
			retiredCapability.observation.identity.kind !== "directory" ||
			!sameIdentity(retiredCapability.observation.identity, expected.identity)
		) {
			throw new Error(`${label} quarantine identity changed`);
		}
		await assertRebound(
			context.session,
			context.absoluteRoot,
			context.root,
			`plugins/stdd/.stdd-plugin-quarantine/${retiredName}`,
			retiredCapability.observation,
			label,
		);
		await assertRebound(
			context.session,
			context.absoluteRoot,
			context.root,
			"plugins/stdd/skills",
			skills.observation,
			"plugins/stdd/skills",
		);
	} catch (error) {
		if (moved) {
			try {
				const retired = await context.session.openChild(quarantine.cap, retiredName);
				try {
					let sourceMissing = false;
					try {
						await context.session.stat(skills.cap, name);
					} catch (sourceError) {
						sourceMissing = sourceError?.code === "not-found";
					}
					if (sourceMissing && sameIdentity(retired.observation.identity, expected.identity)) {
						await context.session.rename({
							fromParent: quarantine.cap,
							from: retiredName,
							expected: expected.identity,
							toParent: skills.cap,
							to: name,
							replace: "never",
						});
						await context.session.flush(skills.cap, "namespace", skills.observation.identity);
						await context.session.flush(quarantine.cap, "namespace", quarantine.observation.identity);
					}
				} finally {
					await closeCapabilities(context.session, [retired]);
				}
			} catch {
				// The verified tree or a replacement at its final basename is retained for manual settlement.
			}
		}
		throw wrappedNativeError(
			label,
			error,
			`quarantine postflight failed; retained trees were not deleted: ${error.message}`,
		);
	} finally {
		await closeCapabilities(context.session, [retiredCapability]);
	}
}

async function validateRuntimeOutput(context, runtime, expectedFiles) {
	if (!runtime) return;
	const expected = new Set(expectedFiles);
	const visit = async (directory, prefix = "") => {
		for (const entry of await listEntries(context.session, directory, "plugins/stdd/runtime")) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const isExpectedFile = expected.has(relative);
			const isExpectedDirectory = [...expected].some((file) => file.startsWith(`${relative}/`));
			if (entry.observation.identity.kind === "directory" && isExpectedDirectory) {
				const child = await nativeCall("plugins/stdd/runtime", () =>
					context.session.openChild(directory.cap, entry.name),
				);
				context.directories.set(`plugins/stdd/runtime/${relative}`, child);
				await visit(child, relative);
			} else if (["symlink", "other"].includes(entry.observation.identity.kind)) {
				throw new Error(
					`plugin runtime output ${relative} is a symlink or non-regular object and is unsafe for plugin publication`,
				);
			} else if (!isExpectedFile) {
				throw new Error(`stale plugin runtime output ${relative}; remove it before rebuilding`);
			}
		}
	};
	await visit(runtime);
}

async function buildPlan(context, nativeManifest, packageBootstrap, currentHelperBytes) {
	const requiredDirectories = [
		["plugins", "plugins directory"],
		["plugins/stdd", "plugins/stdd"],
		["plugins/stdd/.codex-plugin", "plugins/stdd/.codex-plugin"],
		["plugins/stdd/.claude-plugin", "plugins/stdd/.claude-plugin"],
		["plugins/stdd/skills", "plugins/stdd/skills"],
		["plugins/stdd/hooks", "plugins/stdd/hooks"],
		["plugins/stdd/scripts", "plugins/stdd/scripts"],
		["scripts", "scripts directory"],
		["scripts/plugin", "Pi extension source directory"],
		["playbooks", "playbooks directory"],
		["prebuilds", "prebuilds runtime source"],
		["prebuilds/stdd-fs", "native prebuild runtime source"],
		...FLAT_RUNTIME_DIRECTORIES.map((directory) => [directory, `${directory} runtime source`]),
	];
	for (const [relative, label] of requiredDirectories) {
		await preflightDirectory(context, relative, label, true);
	}
	const plugin = context.directories.get("plugins/stdd");
	const skills = context.directories.get("plugins/stdd/skills");
	const playbooks = context.directories.get("playbooks");
	const nativeSource = context.directories.get("prebuilds/stdd-fs");
	await validateTree(
		context.session,
		context.directories.get("plugins/stdd/hooks"),
		"plugins/stdd/hooks",
	);
	await validateTree(
		context.session,
		context.directories.get("plugins/stdd/scripts"),
		"plugins/stdd/scripts",
	);

	const runtimeFiles = new Map();
	for (const directory of FLAT_RUNTIME_DIRECTORIES) {
		const sourceDirectory = context.directories.get(directory);
		for (const entry of await listEntries(
			context.session,
			sourceDirectory,
			`${directory} runtime source`,
		)) {
			if (entry.observation.identity.kind !== "file") {
				throw new Error(`plugin runtime source ${directory}/${entry.name} must be a regular file`);
			}
			runtimeFiles.set(`${directory}/${entry.name}`, null);
		}
	}
	runtimeFiles.set("package.json", null);
	runtimeFiles.set("prebuilds/stdd-fs/manifest.json", null);
	for (const artifact of nativeManifest.artifacts) {
		runtimeFiles.set(`prebuilds/stdd-fs/${artifact.path}`, null);
	}

	const runtime = await preflightDirectory(
		context,
		"plugins/stdd/runtime",
		"plugins/stdd/runtime",
		false,
	);
	const extensions = await preflightDirectory(
		context,
		"plugins/stdd/extensions",
		"plugins/stdd/extensions",
		false,
	);
	if (extensions) {
		await validateTree(context.session, extensions, "plugins/stdd/extensions");
		const extensionEntries = await listEntries(context.session, extensions, "plugins/stdd/extensions");
		for (const entry of extensionEntries) {
			if (entry.name !== "stdd.mjs") {
				throw new Error(`stale plugin extension output ${entry.name}; remove it before rebuilding`);
			}
		}
	}
	await validateRuntimeOutput(context, runtime, runtimeFiles.keys());

	await preflightFile(context, plugin, "README.md", "plugins/stdd/README.md").then((value) => {
		if (!value) throw new Error("plugins/stdd/README.md is missing; expected a regular file");
	});

	const packageSource = await readExactSource(
		context,
		context.root,
		"package.json",
		"package.json",
		"package runtime source",
		{ requireSingleLink: true },
	);
	if (!packageSource.bytes.equals(packageBootstrap)) {
		throw new Error("package runtime source changed during plugin build");
	}
	const pkg = JSON.parse(packageSource.bytes.toString("utf8"));
	validateRuntimeSurface(pkg);
	const licenseSource = await readExactSource(
		context,
		context.root,
		"LICENSE",
		"LICENSE",
		"package license source",
		{ requireSingleLink: true },
	);
	const extensionSource = await readExactSource(
		context,
		context.directories.get("scripts/plugin"),
		"pi-extension.mjs",
		"scripts/plugin/pi-extension.mjs",
		"Pi extension source",
		{ requireSingleLink: true },
	);

	await assertExactNames(
		context.session,
		nativeSource,
		["manifest.json", ...nativeManifest.artifacts.map(({ target }) => target)],
		"native prebuild runtime source",
	);
	const nativeManifestSource = await readExactSource(
		context,
		nativeSource,
		"manifest.json",
		"prebuilds/stdd-fs/manifest.json",
		"native prebuild manifest",
		{ requireSingleLink: true },
	);
	const heldNativeManifest = JSON.parse(nativeManifestSource.bytes.toString("utf8"));
	if (
		!nativeManifestSource.bytes.equals(
			Buffer.from(`${JSON.stringify(heldNativeManifest, null, "\t")}\n`),
		) ||
		JSON.stringify(heldNativeManifest) !== JSON.stringify(nativeManifest)
	) {
		throw new Error("native prebuild manifest changed after verification");
	}
	const nativeSources = new Map();
	for (const artifact of nativeManifest.artifacts) {
		const relativeDirectory = `prebuilds/stdd-fs/${artifact.target}`;
		const sourceDirectory = await preflightDirectory(
			context,
			relativeDirectory,
			`native prebuild ${artifact.target} source`,
			true,
		);
		const executable = path.basename(artifact.path);
		await assertExactNames(
			context.session,
			sourceDirectory,
			[executable],
			`native prebuild ${artifact.target} source`,
		);
		let source;
		if (artifact.target === nativeFsTarget()) {
			const observed = await nativeCall(`native prebuild ${artifact.target} helper`, () =>
				context.session.stat(sourceDirectory.cap, executable),
			);
			if (observed.observation.identity.kind !== "file" || observed.observation.linkCount !== "1") {
				throw new Error(`native prebuild ${artifact.target} helper must be a single-link regular file`);
			}
			await assertReboundStat(
				context.session,
				context.absoluteRoot,
				context.root,
				`${relativeDirectory}/${executable}`,
				observed.observation,
				`native prebuild ${artifact.target} helper`,
			);
			source = {
				relative: `${relativeDirectory}/${executable}`,
				label: `native prebuild ${artifact.target} helper`,
				observation: observed.observation,
				bytes: currentHelperBytes,
				statOnly: true,
				parent: sourceDirectory,
				name: executable,
			};
			context.sources.push(source);
		} else {
			source = await readExactSource(
				context,
				sourceDirectory,
				executable,
				`${relativeDirectory}/${executable}`,
				`native prebuild ${artifact.target} helper`,
				{ requireSingleLink: true },
			);
		}
		if (
			source.bytes.length !== artifact.size ||
			`sha256:${createHash("sha256").update(source.bytes).digest("hex")}` !== artifact.sha256
		) {
			throw new Error(`native prebuild ${artifact.target} changed after verification`);
		}
		nativeSources.set(artifact.target, {
			...source,
			executable,
			mode: artifact.target.startsWith("win32-") ? 0o644 : 0o755,
		});
	}

	const manifestSource = await readExactSource(
		context,
		context.directories.get("plugins/stdd/.codex-plugin"),
		"plugin.json",
		"plugins/stdd/.codex-plugin/plugin.json",
		"plugins/stdd/.codex-plugin/plugin.json",
		{ requireSingleLink: true },
	);
	const claudeManifestSource = await readExactSource(
		context,
		context.directories.get("plugins/stdd/.claude-plugin"),
		"plugin.json",
		"plugins/stdd/.claude-plugin/plugin.json",
		"plugins/stdd/.claude-plugin/plugin.json",
		{ requireSingleLink: true },
	);
	const piManifestSource = await readExactSource(
		context,
		plugin,
		"package.json",
		"plugins/stdd/package.json",
		"plugins/stdd/package.json",
		{ requireSingleLink: true },
	);
	const manifest = JSON.parse(manifestSource.bytes.toString("utf8"));
	const claudeManifest = JSON.parse(claudeManifestSource.bytes.toString("utf8"));
	const piManifest = JSON.parse(piManifestSource.bytes.toString("utf8"));
	validateCodexManifest(manifest);
	validateClaudeManifest(claudeManifest);
	validatePiManifest(piManifest);
	manifest.version = pkg.version;
	claudeManifest.version = pkg.version;
	piManifest.version = pkg.version;

	const stamp = `generated by stdd plugin build v${pkg.version} — do not edit`;
	const generatedSkills = new Map();
	for (const entry of await listEntries(context.session, playbooks, "playbooks directory")) {
		if (entry.observation.identity.kind !== "file") {
			throw new Error(`playbook ${entry.name} must be a regular file`);
		}
		if (!entry.name.endsWith(".md")) continue;
		const source = await readExactSource(
			context,
			playbooks,
			entry.name,
			`playbooks/${entry.name}`,
			`playbook ${entry.name}`,
			{ requireSingleLink: true },
		);
		const { meta, body } = parseFrontmatter(source.bytes.toString("utf8"));
		assertSkillName(meta.name, `playbook ${entry.name} name`);
		if (generatedSkills.has(meta.name)) {
			throw new Error(`duplicate plugin skill name ${JSON.stringify(meta.name)}`);
		}
		generatedSkills.set(
			meta.name,
			renderAgentSkill({
				adapter: "codex",
				name: meta.name,
				description: meta.description,
				when: meta.when,
				body: compileCapabilities(body, DEFAULT_CONFIG.capabilities),
				stamp,
			}),
		);
	}

	const staleSkills = [];
	const activeSkills = new Map();
	for (const entry of await listEntries(context.session, skills, "plugins/stdd/skills")) {
		if (entry.observation.identity.kind !== "directory") {
			throw new Error(`plugin skill ${entry.name} is a symlink or not a directory and is unsafe`);
		}
		const skill = await nativeCall(`plugin skill ${entry.name}`, () =>
			context.session.openChild(skills.cap, entry.name),
		);
		context.directories.set(`plugins/stdd/skills/${entry.name}`, skill);
		if (generatedSkills.has(entry.name)) {
			await preflightFile(context, skill, "SKILL.md", `plugin skill ${entry.name}/SKILL.md`);
			activeSkills.set(entry.name, skill);
		} else {
			await validateTree(context.session, skill, `stale plugin skill ${entry.name}`);
			staleSkills.push({ name: entry.name, observation: skill.observation });
		}
	}

	const runtimeSources = new Map();
	for (const relative of runtimeFiles.keys()) {
		if (relative === "package.json" || relative.startsWith("prebuilds/")) continue;
		const [directory, file] = relative.split("/");
		runtimeSources.set(
			relative,
			await readExactSource(
				context,
				context.directories.get(directory),
				file,
				relative,
				`plugin runtime source ${relative}`,
				{ requireSingleLink: true },
			),
		);
	}

	const quarantine = await preflightDirectory(
		context,
		"plugins/stdd/.stdd-plugin-quarantine",
		"plugins/stdd/.stdd-plugin-quarantine",
		false,
	);
	if (quarantine) {
		if (quarantine.observation.owner !== plugin.observation.owner) {
			throw new Error("plugins/stdd/.stdd-plugin-quarantine must be owner-private");
		}
		const bits = modeBits(quarantine.observation);
		if (bits !== null && bits !== 0o700) {
			throw new Error("plugins/stdd/.stdd-plugin-quarantine must have mode 0700");
		}
	}

	const outputSpecs = [];
	const addOutput = async (parentRelative, name, bytes, label, mode = 0o644) => {
		const parent = context.directories.get(parentRelative);
		const existing = parent ? await preflightFile(context, parent, name, label) : null;
		outputSpecs.push({ parentRelative, name, bytes, label, mode, existing });
	};
	for (const [name, output] of generatedSkills) {
		await addOutput(`plugins/stdd/skills/${name}`, "SKILL.md", output, `plugin skill ${name}/SKILL.md`);
	}
	await addOutput(
		"plugins/stdd/extensions",
		"stdd.mjs",
		extensionSource.bytes,
		"plugins/stdd/extensions/stdd.mjs",
	);
	await addOutput("plugins/stdd", "LICENSE", licenseSource.bytes, "plugins/stdd/LICENSE");
	await addOutput(
		"plugins/stdd/.codex-plugin",
		"plugin.json",
		`${JSON.stringify(manifest, null, "  ")}\n`,
		"plugins/stdd/.codex-plugin/plugin.json",
	);
	await addOutput(
		"plugins/stdd/.claude-plugin",
		"plugin.json",
		`${JSON.stringify(claudeManifest, null, "  ")}\n`,
		"plugins/stdd/.claude-plugin/plugin.json",
	);
	await addOutput(
		"plugins/stdd",
		"package.json",
		`${JSON.stringify(piManifest, null, "  ")}\n`,
		"plugins/stdd/package.json",
	);
	for (const [relative, source] of runtimeSources) {
		const [directory, file] = relative.split("/");
		await addOutput(
			`plugins/stdd/runtime/${directory}`,
			file,
			source.bytes,
			`plugins/stdd/runtime/${relative}`,
		);
	}
	await addOutput(
		"plugins/stdd/runtime/prebuilds/stdd-fs",
		"manifest.json",
		nativeManifestSource.bytes,
		"plugins/stdd/runtime/prebuilds/stdd-fs/manifest.json",
	);
	for (const artifact of nativeManifest.artifacts) {
		const source = nativeSources.get(artifact.target);
		await addOutput(
			`plugins/stdd/runtime/prebuilds/stdd-fs/${artifact.target}`,
			source.executable,
			source.bytes,
			`plugins/stdd/runtime/prebuilds/stdd-fs/${artifact.path}`,
			source.mode,
		);
	}
	await addOutput(
		"plugins/stdd/runtime",
		"package.json",
		packageSource.bytes,
		"plugins/stdd/runtime/package.json",
	);

	return {
		pkg,
		generatedSkills,
		activeSkills,
		staleSkills,
		outputSpecs,
	};
}

export async function buildPlugin(root = ROOT, { openSession = openNativeFsSession } = {}) {
	const absoluteRoot = path.resolve(root);
	const packageBootstrap = readBootstrapFile(
		path.join(absoluteRoot, "package.json"),
		"package runtime source",
	);
	const nativeManifest = verifyNativePrebuilds(absoluteRoot);
	const session = await openSession({ packageRoot: absoluteRoot });
	try {
		const currentArtifact = nativeManifest.artifacts.find(({ target }) => target === nativeFsTarget());
		const currentHelperBytes = await readSessionArtifact(
			session,
			currentArtifact,
			`native prebuild ${currentArtifact.target} helper`,
		);
		const rootCapability = await nativeCall("package source root", () => session.openRoot(absoluteRoot));
		const context = {
			session,
			absoluteRoot,
			root: rootCapability,
			directories: new Map([["", rootCapability]]),
			sources: [],
		};
		const plan = await buildPlan(context, nativeManifest, packageBootstrap, currentHelperBytes);

		for (const source of context.sources) {
			try {
				const held = source.statOnly
					? await nativeCall(source.label, () => session.stat(source.parent.cap, source.name))
					: await nativeCall(source.label, () => session.stat(source.file.cap));
				if (!sameObservation(held.observation, source.observation)) {
					throw new Error(`${source.label} changed before plugin publication`);
				}
				const rebound = await (source.statOnly ? assertReboundStat : assertRebound)(
					session,
					absoluteRoot,
					rootCapability,
					source.relative,
					source.observation,
					source.label,
				);
				if (!sameObservation(rebound.observation, source.observation)) {
					throw new Error(`${source.label} changed before plugin publication`);
				}
			} finally {
				await closeCapabilities(session, [source.file]);
			}
		}
		const probed = new Set();
		for (const directory of context.directories.values()) {
			if (!directory || probed.has(directory.cap)) continue;
			await nativeCall("plugin publication filesystem preflight", () => session.probe(directory.cap));
			probed.add(directory.cap);
		}
		await assertRebound(
			session,
			absoluteRoot,
			rootCapability,
			"",
			rootCapability.observation,
			"package source root",
		);
		await assertSessionArtifactAttached(session, `native prebuild ${currentArtifact.target} helper`);

		let quarantine = context.directories.get("plugins/stdd/.stdd-plugin-quarantine");
		if (plan.staleSkills.length > 0) {
			quarantine = await ensureDirectory(
				context,
				"plugins/stdd/.stdd-plugin-quarantine",
				"plugins/stdd/.stdd-plugin-quarantine",
				0o700,
			);
			const readmeSpec = {
				parentRelative: "plugins/stdd/.stdd-plugin-quarantine",
				name: "README.txt",
				bytes: QUARANTINE_README,
				label: "plugins/stdd/.stdd-plugin-quarantine/README.txt",
				mode: 0o644,
				existing: await preflightFile(
					context,
					quarantine,
					"README.txt",
					"plugins/stdd/.stdd-plugin-quarantine/README.txt",
				),
			};
			await publishFile(
				context,
				readmeSpec.parentRelative,
				readmeSpec.name,
				readmeSpec.bytes,
				readmeSpec.label,
				readmeSpec,
			);
			for (const stale of plan.staleSkills) {
				await quarantineStaleSkill(
					context,
					context.directories.get("plugins/stdd/skills"),
					quarantine,
					stale.name,
					stale.observation,
				);
			}
		}

		for (const name of plan.generatedSkills.keys()) {
			await ensureDirectory(context, `plugins/stdd/skills/${name}`, `plugin skill ${name}`);
		}
		await ensureDirectory(context, "plugins/stdd/extensions", "plugins/stdd/extensions");
		await ensureDirectory(context, "plugins/stdd/runtime", "plugins/stdd/runtime");
		for (const directory of FLAT_RUNTIME_DIRECTORIES) {
			await ensureDirectory(
				context,
				`plugins/stdd/runtime/${directory}`,
				`plugins/stdd/runtime/${directory}`,
			);
		}
		await ensureDirectory(context, "plugins/stdd/runtime/prebuilds", "plugins/stdd/runtime/prebuilds");
		await ensureDirectory(
			context,
			"plugins/stdd/runtime/prebuilds/stdd-fs",
			"plugins/stdd/runtime/prebuilds/stdd-fs",
		);
		for (const artifact of nativeManifest.artifacts) {
			await ensureDirectory(
				context,
				`plugins/stdd/runtime/prebuilds/stdd-fs/${artifact.target}`,
				`plugins/stdd/runtime/prebuilds/stdd-fs/${artifact.target}`,
			);
		}

		const runtimePackage = plan.outputSpecs.pop();
		for (const output of plan.outputSpecs) {
			await publishFile(context, output.parentRelative, output.name, output.bytes, output.label, output);
		}
		// Publish the version-bearing package file last: after an interruption,
		// it must never claim newer runtime code than the files beside it.
		await publishFile(
			context,
			runtimePackage.parentRelative,
			runtimePackage.name,
			runtimePackage.bytes,
			runtimePackage.label,
			runtimePackage,
		);
		console.log(`Built universal STDD plugin skills and runtime for v${plan.pkg.version}`);
	} finally {
		await session.close();
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await buildPlugin();
