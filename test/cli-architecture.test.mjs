// Characterization/architecture gate for the CLI decomposition described in
// README.md's "Development" section: an acyclic, flat `cli/*.mjs` module
// graph, with `cli/stdd.mjs` owning argument order and dispatch only.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PKG_ROOT, "cli", "stdd.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;

function tmpRepo() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-arch-test-"));
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

// --- golden CLI behavior ---

test("no-arg invocation prints usage and exits 0", async () => {
	const res = await run([], { cwd: tmpRepo() });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /^Usage: stdd </);
	assert.equal(res.stderr, "");
});

test('unknown command "workr" suggests "worker"', async () => {
	const res = await run(["workr"], { cwd: tmpRepo() });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /unknown command "workr"/);
	assert.match(res.stderr, /did you mean "worker"/);
});

test("an unknown generic flag fails fast", async () => {
	const res = await run(["doctor", "--frobnicate"], { cwd: tmpRepo() });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /unknown flag: --frobnicate/);
});

test("version and --version both print the installed package version", async () => {
	const dir = tmpRepo();
	const viaCommand = await run(["version"], { cwd: dir });
	const viaFlag = await run(["--version"], { cwd: dir });
	assert.equal(viaCommand.code, 0);
	assert.equal(viaFlag.code, 0);
	assert.equal(viaCommand.stdout.trim(), VERSION);
	assert.equal(viaFlag.stdout.trim(), VERSION);
});

// --- flat, acyclic module graph invariant ---

test("all runtime cli entries are regular flat .mjs files", () => {
	const cliDir = path.join(PKG_ROOT, "cli");
	const entries = fs.readdirSync(cliDir, { withFileTypes: true });
	assert.ok(entries.length > 0, "cli/ must not be empty");
	for (const entry of entries) {
		assert.ok(entry.isFile(), `cli/${entry.name} must be a regular file, not a directory or symlink`);
		assert.match(entry.name, /\.mjs$/, `cli/${entry.name} must be a flat .mjs module`);
	}
});

function relativeImportSpecifiers(source) {
	const specifiers = new Set();
	const re = /\bfrom\s+["']([^"']+)["']/g;
	let match = re.exec(source);
	while (match) {
		if (match[1].startsWith(".")) specifiers.add(match[1]);
		match = re.exec(source);
	}
	return [...specifiers];
}

function buildRelativeImportGraph(rootFile) {
	const graph = new Map();
	const visit = (file) => {
		if (graph.has(file)) return;
		const deps = relativeImportSpecifiers(fs.readFileSync(file, "utf8")).map((specifier) =>
			path.resolve(path.dirname(file), specifier),
		);
		graph.set(file, deps);
		for (const dep of deps) visit(dep);
	};
	visit(rootFile);
	return graph;
}

function findImportCycle(graph, rootFile) {
	const color = new Map();
	const stack = [];
	const visit = (node) => {
		color.set(node, "in-progress");
		stack.push(node);
		for (const dep of graph.get(node) ?? []) {
			const state = color.get(dep) ?? "unvisited";
			if (state === "in-progress") return [...stack.slice(stack.indexOf(dep)), dep];
			if (state === "unvisited") {
				const cycle = visit(dep);
				if (cycle) return cycle;
			}
		}
		stack.pop();
		color.set(node, "done");
		return null;
	};
	return visit(rootFile);
}

test("relative-import graph rooted at cli/stdd.mjs is acyclic", () => {
	const graph = buildRelativeImportGraph(CLI);
	assert.ok(graph.size > 1, "the graph must actually traverse imports, not just the root");
	const cycle = findImportCycle(graph, CLI);
	assert.equal(
		cycle,
		null,
		cycle && `import cycle: ${cycle.map((f) => path.relative(PKG_ROOT, f)).join(" -> ")}`,
	);
});

test("cli/path-bytes.mjs exists and exports the ten path-bytes primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "path-bytes.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/path-bytes.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedExports = [
		"splitNul",
		"pathForMatch",
		"pathForView",
		"latinGlob",
		"absPathBuf",
		"parentPathBuf",
		"realPathBuf",
		"bufferPathIsWithin",
		"displayPath",
		"viewPath",
	];
	for (const name of expectedExports) {
		assert.equal(typeof mod[name], "function", `path-bytes.mjs must export ${name}`);
	}
});

test("cli/held-fs.mjs exists and exports the held-filesystem primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "held-fs.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/held-fs.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedExports = [
		"openHeldLinuxRepoDirectory",
		"openOrCreateHeldGeneratedParent",
		"publishGeneratedFileSafely",
	];
	for (const name of expectedExports) {
		assert.equal(typeof mod[name], "function", `held-fs.mjs must export ${name}`);
	}
});

test("cli/worker-fs.mjs exists and exports the worker path/publication primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "worker-fs.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/worker-fs.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedExports = [
		"workerPathForMatch",
		"workerViewPath",
		"openWorkerPublicationParent",
		"publishWorkerFile",
		"assertHeldWorkerDirectory",
		"publishWorkerSymlink",
		"sameWorkerState",
		"readWorkerPathState",
		"writeNewWorkerPath",
		"quarantineWorkerDeletion",
	];
	for (const name of expectedExports) {
		assert.equal(typeof mod[name], "function", `worker-fs.mjs must export ${name}`);
	}
	assert.equal(
		typeof mod.WORKER_DELETIONS_REL,
		"string",
		"worker-fs.mjs must export WORKER_DELETIONS_REL",
	);
});

test("cli/runtime.mjs exists and exports the generic process/error primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "runtime.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/runtime.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedFunctionExports = [
		"fail",
		"statePath",
		"git",
		"subprocessError",
		"requireHeldParentPublicationPlatform",
		"requireReviewSettlementPlatform",
	];
	for (const name of expectedFunctionExports) {
		assert.equal(typeof mod[name], "function", `runtime.mjs must export ${name}`);
	}
	assert.equal(
		typeof mod.MAX_SUBPROCESS_BUFFER,
		"number",
		"runtime.mjs must export MAX_SUBPROCESS_BUFFER",
	);
});
