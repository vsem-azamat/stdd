import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	claudeStopCommand,
	codexStopCommand,
	installAgentHooks,
	installSessionHook,
	installStopHook,
	renderPiLifecycleExtension,
} from "../cli/claude-hooks.mjs";
import {
	finalizeGeneratedFilesWithCapabilities,
	generatedQuarantineInventory,
	readManifestDocumentWithCapabilities,
	recoverCleanupJournalWithCapabilities,
} from "../cli/generated-files.mjs";
import {
	openNativeRepoMutation,
	openOrCreateNativeRepoDirectory,
	publishNativeRepoFile,
	readOptionalNativeRepoFile,
} from "../cli/held-fs.mjs";
import { parseLedger, sha256 } from "../cli/lib.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PKG_ROOT, "cli", "stdd.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
const NPM_RUNNER = `npm exec --offline --package=@stdd/cli@${VERSION} -- stdd`;
const SOURCE_RUNNER = 'node "$(git rev-parse --show-toplevel)/cli/stdd.mjs"';
const STALE_CODEX_STOP_NORMALIZER =
	'const fs=require("node:fs");let value;try{value=JSON.parse(fs.readFileSync(0,"utf8"));}catch{}const valid=typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.keys(value).length===0||(value.decision==="block"&&typeof value.reason==="string"&&value.reason.length>0));process.stdout.write(valid?JSON.stringify(value)+"\\n":"{}\\n");';

function staleNormalizedCodexStopCommand(runner) {
	return `{ stdd_codex_stop_protocol=1; output="$(${runner} stop-hook --agent codex 2>/dev/null)" && printf '%s' "$output" | node -e '${STALE_CODEX_STOP_NORMALIZER}' 2>/dev/null || printf '{}\\n'; exit 0; }`;
}

function tmpDir() {
	return makeTempDir("stdd-configure-");
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

const ALL_CAPS = { subagents: true, crossCli: true, worktrees: true };

test("generated publication uses portable capabilities and rejects a replaced repository root", async () => {
	const dir = tmpDir();
	const parked = `${dir}-parked`;
	const context = await openNativeRepoMutation(dir, "configure test helper");
	try {
		const generated = await openOrCreateNativeRepoDirectory(context, "generated", {
			mode: 0o755,
		});
		assert.equal(generated.observation.identity.version, 2);
		assert.equal(generated.observation.identity.platform, process.platform);

		fs.renameSync(dir, parked);
		fs.mkdirSync(dir);
		await assert.rejects(
			publishNativeRepoFile(context, "generated/output.txt", "portable\n"),
			(error) => error.mutation === "committed" && /root changed|postflight/i.test(error.message),
		);
		assert.ok(!fs.existsSync(path.join(dir, "generated", "output.txt")));
		assert.equal(fs.readFileSync(path.join(parked, "generated", "output.txt"), "utf8"), "portable\n");
	} finally {
		await context.close();
	}
});

test("an indeterminate temporary creation reports the exact inactive retained basename", async () => {
	const dir = tmpDir();
	const context = await openNativeRepoMutation(dir, "native temporary fault test");
	const real = context.session;
	let fired = false;
	context.session = new Proxy(real, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function") return value;
			if (property !== "createFile") return value.bind(target);
			return async (...args) => {
				const result = await value.apply(target, args);
				if (!fired) {
					fired = true;
					const error = new Error("injected native create fault");
					error.code = "injected-fault";
					error.mutation = "committed";
					throw error;
				}
				return result;
			};
		},
	});
	try {
		await assert.rejects(
			publishNativeRepoFile(context, "output.txt", "content\n"),
			/inactive temporary .*\.stdd-generated-[0-9a-f]{32}\.tmp.*retained/i,
		);
	} finally {
		await context.close();
	}
	assert.ok(!fs.existsSync(path.join(dir, "output.txt")));
	assert.equal(
		fs.readdirSync(dir).filter((name) => /^\.stdd-generated-[0-9a-f]{32}\.tmp$/.test(name)).length,
		1,
	);
});

test("publication rejects a same-inode content change after user-owned inspection", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "user.txt"), "first\n");
	const context = await openNativeRepoMutation(dir, "native content binding test");
	try {
		const state = await readOptionalNativeRepoFile(context, "user.txt");
		fs.writeFileSync(path.join(dir, "user.txt"), "other\n");
		await assert.rejects(
			publishNativeRepoFile(context, "user.txt", "rendered\n", {
				expectedTarget: state.file.observation.identity,
				expectedBytes: state.bytes,
			}),
			/content changed after it was inspected/,
		);
	} finally {
		await context.close();
	}
	assert.equal(fs.readFileSync(path.join(dir, "user.txt"), "utf8"), "other\n");
});

test("dynamic source compilation fails before the first generated write", async () => {
	const dir = tmpDir();
	const local = path.join(dir, ".stdd", "playbooks", "local");
	fs.mkdirSync(local, { recursive: true });
	fs.writeFileSync(
		path.join(local, "bad.md"),
		"---\nname: bad-local\ndescription: Bad local playbook\n---\n\n<!-- cap:teleport -->\nnever\n<!-- /cap -->\n",
	);
	fs.writeFileSync(path.join(dir, "sentinel.txt"), "unchanged\n");
	const result = await run(["init", dir, "--tools", "claude"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /unknown capability "teleport"/);
	assert.equal(fs.readFileSync(path.join(dir, "sentinel.txt"), "utf8"), "unchanged\n");
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "method.md")));
	assert.ok(!fs.existsSync(path.join(dir, ".claude")));
});

test("a late generated destination is natively preflighted before earlier outputs change", async () => {
	const dir = tmpDir();
	const outside = tmpDir();
	const lateParent = path.join(dir, ".claude", "skills");
	fs.mkdirSync(lateParent, { recursive: true });
	fs.symlinkSync(outside, path.join(lateParent, "stdd-worktrees"), "junction");
	const result = await run(["init", dir, "--tools", "claude"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /unsafe symlink|symlink.*unsafe/i);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "method.md")));
	assert.deepEqual(fs.readdirSync(outside), []);
});

test("init helper preflight failure leaves the target byte-for-byte untouched", async () => {
	const dir = tmpDir();
	const sentinel = path.join(dir, "sentinel.txt");
	fs.writeFileSync(sentinel, "unchanged\n");
	const before = new Map(
		fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]),
	);
	const corruptPackage = tmpDir();
	const artifactRoot = path.join(corruptPackage, "prebuilds", "stdd-fs");
	fs.mkdirSync(artifactRoot, { recursive: true });
	fs.writeFileSync(
		path.join(artifactRoot, "manifest.json"),
		"{ injected native helper preflight failure\n",
	);

	const previousPackageRoot = process.env.STDD_NATIVE_FS_PACKAGE_ROOT;
	process.env.STDD_NATIVE_FS_PACKAGE_ROOT = corruptPackage;
	try {
		await assert.rejects(
			openNativeRepoMutation(dir, "native filesystem helper for init"),
			/native filesystem helper.*manifest is not valid JSON/i,
		);
	} finally {
		if (previousPackageRoot === undefined) delete process.env.STDD_NATIVE_FS_PACKAGE_ROOT;
		else process.env.STDD_NATIVE_FS_PACKAGE_ROOT = previousPackageRoot;
	}
	assert.deepEqual(fs.readdirSync(dir), [...before.keys()]);
	for (const [name, bytes] of before) {
		assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes, name);
	}
});

test("lifecycle hooks publish through the init native capability session", async () => {
	const dir = tmpDir();
	const expectedDir = tmpDir();
	installSessionHook(expectedDir, SOURCE_RUNNER, ["claude"]);
	installStopHook(expectedDir, SOURCE_RUNNER, ["claude"]);
	const expected = fs.readFileSync(path.join(expectedDir, ".claude", "settings.json"));
	const context = await openNativeRepoMutation(dir, "configure hook publication test");
	try {
		const installed = await installAgentHooks(context, SOURCE_RUNNER, ["claude"], {
			sessionHook: true,
			stopHook: true,
		});
		assert.equal(installed, true);
		assert.deepEqual(
			fs.readFileSync(path.join(dir, ".claude", "settings.json")),
			expected,
			"capability publication preserves the established hook bytes exactly",
		);
		const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
		assert.deepEqual(Object.keys(settings.hooks), ["SessionStart", "Stop"]);
		assert.match(settings.hooks.SessionStart[0].hooks[0].command, /status --local/);
		assert.match(settings.hooks.Stop[0].hooks[0].command, /stop-hook/);
	} finally {
		await context.close();
	}
});

test("unsafe lifecycle targets fail init before generated publication", async () => {
	const dir = tmpDir();
	const outside = tmpDir();
	fs.symlinkSync(outside, path.join(dir, ".claude"), "junction");
	const result = await run(["init", dir, "--tools", "claude", "--session-hook"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /unsafe symlink|symlink.*unsafe/i);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "method.md")));
	assert.deepEqual(fs.readdirSync(outside), []);
});

test("capability hook publication preserves the unsafe symlink diagnostic", async () => {
	const dir = tmpDir();
	const outside = tmpDir();
	fs.symlinkSync(outside, path.join(dir, ".claude"), "junction");
	const context = await openNativeRepoMutation(dir, "configure hook symlink test");
	try {
		await assert.rejects(
			installAgentHooks(context, SOURCE_RUNNER, ["claude"], {
				sessionHook: true,
			}),
			/unsafe symlink/i,
		);
	} finally {
		await context.close();
	}
	assert.deepEqual(fs.readdirSync(outside), []);
});

test("unsupported user-owned modes fail preflight before generated publication", async () => {
	for (const relative of [".gitignore", ".claude/settings.json"]) {
		const dir = tmpDir();
		const target = path.join(dir, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, relative === ".gitignore" ? "node_modules\n" : "{}\n", { mode: 0o664 });
		fs.chmodSync(target, 0o664);
		const args = ["init", dir, "--tools", "claude"];
		if (relative.includes("settings")) args.push("--session-hook");
		const result = await run(args);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /unsupported mode 664.*preserve it manually before retrying/i);
		assert.ok(!fs.existsSync(path.join(dir, ".stdd", "method.md")));
	}
});

test("configure preserves a private user-owned config mode", async () => {
	const dir = tmpDir();
	const initialized = await run(["init", dir, "--tools", "claude"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const configPath = path.join(dir, ".stdd", "config.json");
	fs.chmodSync(configPath, 0o600);
	const configured = await run([
		"configure",
		dir,
		"--capabilities",
		"crossCli",
		"--review-via",
		"codex",
	]);
	assert.equal(configured.code, 0, configured.stdout + configured.stderr);
	assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test("doctor inventory accepts a private-layout pending cleanup WAL", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { mode: 0o700 });
	const quarantine =
		".stdd/generated-quarantines/.stdd-cleanup-55555555555555555555555555555555.tmp/stdd.yml";
	fs.writeFileSync(
		path.join(dir, ".stdd", "cleanup-transaction.json"),
		`${JSON.stringify(
			{
				version: 1,
				entries: [
					{
						source: ".github/workflows/stdd.yml",
						quarantine,
						hash: `sha256:${"0".repeat(64)}`,
						parentDev: "1",
						parentIno: "2",
						fileDev: "1",
						fileIno: "3",
						phase: "planned",
						keepSource: false,
						reason: "",
					},
				],
			},
			null,
			"\t",
		)}\n`,
		{ mode: 0o600 },
	);
	assert.deepEqual(generatedQuarantineInventory(dir), [
		{ relative: quarantine, provenance: "cleanup journal" },
	]);
});

function injectNativeFault(context, matcher, { after = false, mutation = "none" } = {}) {
	const real = context.session;
	let fired = false;
	context.session = new Proxy(real, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function") return value;
			if (property !== "rename") return value.bind(target);
			return async (...args) => {
				if (!fired && matcher(args[0])) {
					fired = true;
					if (!after) {
						const error = new Error("injected native rename fault");
						error.code = "injected-fault";
						error.mutation = mutation;
						throw error;
					}
					await value.apply(target, args);
					const error = new Error("injected native rename fault");
					error.code = "injected-fault";
					error.mutation = mutation;
					throw error;
				}
				return value.apply(target, args);
			};
		},
	});
}

async function nativeCleanupFaultFixture() {
	const dir = tmpDir();
	// Any recognized generated output the current profile no longer produces.
	// Not a provider CI path: those are released rather than retired, so they
	// never reach the cleanup transaction these tests exercise.
	const source = ".stdd/playbooks/planning.md";
	const bytes = Buffer.from("retired playbook\n");
	fs.mkdirSync(path.dirname(path.join(dir, source)), { recursive: true });
	fs.writeFileSync(path.join(dir, source), bytes);
	return {
		dir,
		source,
		bytes,
		options: {
			oldFiles: { [source]: sha256(bytes) },
			generated: Object.create(null),
			targets: { tools: ["claude"], hooks: false, sessionHook: false, stopHook: false },
		},
	};
}

for (const [name, fault] of [
	["pre-rename", { after: false, mutation: "none" }],
	["committed", { after: true, mutation: "committed" }],
]) {
	test(`native cleanup ${name} faults remain WAL-recoverable`, async () => {
		const fixture = await nativeCleanupFaultFixture();
		const context = await openNativeRepoMutation(fixture.dir, "native cleanup fault test");
		injectNativeFault(context, ({ to }) => to === "planning.md", fault);
		try {
			await assert.rejects(
				finalizeGeneratedFilesWithCapabilities(context, fixture.options),
				/cleanup-transaction\.json remains for recovery|injected native rename fault/,
			);
		} finally {
			await context.close();
		}
		assert.ok(fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
		const recovery = await openNativeRepoMutation(fixture.dir, "native cleanup recovery test");
		try {
			await recoverCleanupJournalWithCapabilities(recovery);
		} finally {
			await recovery.close();
		}
		assert.deepEqual(fs.readFileSync(path.join(fixture.dir, fixture.source)), fixture.bytes);
		assert.ok(!fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
	});
}

test("a committed rollback fault remains journaled and settles on the next retry", async () => {
	const fixture = await nativeCleanupFaultFixture();
	const first = await openNativeRepoMutation(fixture.dir, "native rollback setup test");
	injectNativeFault(first, ({ to }) => to === "planning.md", {
		after: true,
		mutation: "committed",
	});
	try {
		await assert.rejects(finalizeGeneratedFilesWithCapabilities(first, fixture.options));
	} finally {
		await first.close();
	}
	const faultedRecovery = await openNativeRepoMutation(fixture.dir, "native rollback fault test");
	injectNativeFault(faultedRecovery, ({ to }) => to === "planning.md", {
		after: true,
		mutation: "committed",
	});
	try {
		await assert.rejects(
			recoverCleanupJournalWithCapabilities(faultedRecovery),
			/unresolved cleanup state|capability-bound rollback failed/,
		);
	} finally {
		await faultedRecovery.close();
	}
	assert.ok(fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
	const retry = await openNativeRepoMutation(fixture.dir, "native rollback retry test");
	try {
		await recoverCleanupJournalWithCapabilities(retry);
	} finally {
		await retry.close();
	}
	assert.deepEqual(fs.readFileSync(path.join(fixture.dir, fixture.source)), fixture.bytes);
	assert.ok(!fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
});

test("a possible namespace-flush fault after cleanup remains WAL-recoverable", async () => {
	const fixture = await nativeCleanupFaultFixture();
	const context = await openNativeRepoMutation(fixture.dir, "native cleanup flush fault test");
	const real = context.session;
	let cleanupRenamed = false;
	let fired = false;
	context.session = new Proxy(real, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function") return value;
			if (property === "rename") {
				return async (...args) => {
					const result = await value.apply(target, args);
					if (args[0].to === "planning.md") cleanupRenamed = true;
					return result;
				};
			}
			if (property === "flush") {
				return async (...args) => {
					if (cleanupRenamed && !fired) {
						fired = true;
						const error = new Error("injected native flush fault");
						error.code = "injected-fault";
						error.mutation = "possible";
						throw error;
					}
					return value.apply(target, args);
				};
			}
			return value.bind(target);
		},
	});
	try {
		await assert.rejects(
			finalizeGeneratedFilesWithCapabilities(context, fixture.options),
			/cleanup-transaction\.json remains for recovery|injected native flush fault/,
		);
	} finally {
		await context.close();
	}
	const recovery = await openNativeRepoMutation(fixture.dir, "native cleanup flush recovery test");
	try {
		await recoverCleanupJournalWithCapabilities(recovery);
	} finally {
		await recovery.close();
	}
	assert.deepEqual(fs.readFileSync(path.join(fixture.dir, fixture.source)), fixture.bytes);
	assert.ok(!fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
});

test("a committed manifest rename is settled from the durable WAL on retry", async () => {
	const fixture = await nativeCleanupFaultFixture();
	const context = await openNativeRepoMutation(fixture.dir, "native manifest fault test");
	injectNativeFault(context, ({ to }) => to === "manifest.json", {
		after: true,
		mutation: "committed",
	});
	try {
		await assert.rejects(
			finalizeGeneratedFilesWithCapabilities(context, fixture.options),
			/cleanup-transaction\.json remains for recovery/,
		);
	} finally {
		await context.close();
	}
	assert.ok(fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
	const recovery = await openNativeRepoMutation(fixture.dir, "native manifest recovery test");
	try {
		await recoverCleanupJournalWithCapabilities(recovery);
	} finally {
		await recovery.close();
	}
	assert.ok(!fs.existsSync(path.join(fixture.dir, fixture.source)));
	assert.ok(!fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
	assert.ok(generatedQuarantineInventory(fixture.dir).length >= 2);
});

test("an interrupted cleanup-journal zeroization settles from manifest-bound identity", async () => {
	const fixture = await nativeCleanupFaultFixture();
	const context = await openNativeRepoMutation(fixture.dir, "native zeroization fault test");
	const real = context.session;
	let manifestRenamed = false;
	let fired = false;
	context.session = new Proxy(real, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function") return value;
			if (property === "rename") {
				return async (...args) => {
					const result = await value.apply(target, args);
					if (args[0].to === "manifest.json") manifestRenamed = true;
					return result;
				};
			}
			if (property === "write") {
				return async (...args) => {
					if (manifestRenamed && !fired) {
						fired = true;
						const bytes = Buffer.from(args[2]);
						await value.call(
							target,
							args[0],
							args[1],
							bytes.subarray(0, Math.ceil(bytes.length / 2)),
							args[3],
						);
						const error = new Error("injected native zeroization fault");
						error.code = "injected-fault";
						error.mutation = "possible";
						throw error;
					}
					return value.apply(target, args);
				};
			}
			return value.bind(target);
		},
	});
	try {
		await assert.rejects(
			finalizeGeneratedFilesWithCapabilities(context, fixture.options),
			/injected native zeroization fault|settlement did not complete/,
		);
	} finally {
		await context.close();
	}
	assert.ok(fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
	const recovery = await openNativeRepoMutation(fixture.dir, "native zeroization recovery test");
	try {
		await recoverCleanupJournalWithCapabilities(recovery);
	} finally {
		await recovery.close();
	}
	assert.ok(!fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
	const retained = generatedQuarantineInventory(fixture.dir).find(({ relative }) =>
		relative.endsWith("/cleanup-transaction.tombstone"),
	);
	assert.ok(retained);
	assert.equal(fs.statSync(path.join(fixture.dir, retained.relative)).size, 0);
	assert.deepEqual(fs.readFileSync(path.join(fixture.dir, retained.relative)), Buffer.alloc(0));
	const inspection = await openNativeRepoMutation(fixture.dir, "retained parent binding test");
	try {
		const manifest = await readManifestDocumentWithCapabilities(inspection);
		const state = await readOptionalNativeRepoFile(inspection, retained.relative);
		assert.deepEqual(
			manifest.quarantineIdentities[retained.relative].parentObservation.identity,
			state.parent.observation.identity,
		);
	} finally {
		await inspection.close();
	}
});

test("an operator-removed cleanup-journal tombstone stays absent on the next init", async () => {
	const dir = tmpDir();
	assert.equal((await run(["init", dir, "--tools", "claude"])).code, 0);
	assert.equal((await run(["init", dir, "--tools", "codex"])).code, 0);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const before = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const retained = before.retainedCleanupJournals.find((relative) =>
		relative.endsWith("/cleanup-transaction.tombstone"),
	);
	assert.ok(retained);
	fs.unlinkSync(path.join(dir, retained));
	const rerun = await run(["init", dir, "--tools", "codex"]);
	assert.equal(rerun.code, 0, rerun.stderr);
	const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	assert.ok(!Object.hasOwn(after.files, retained));
	assert.ok(!Object.hasOwn(after.quarantineIdentities, retained));
	assert.ok(!(after.retainedCleanupJournals ?? []).includes(retained));
	assert.equal((await run(["check", dir])).code, 0);
});

test("a committed cleanup-journal settlement remains a recognized retained quarantine", async () => {
	const fixture = await nativeCleanupFaultFixture();
	const context = await openNativeRepoMutation(fixture.dir, "native settlement fault test");
	injectNativeFault(context, ({ to }) => to === "cleanup-transaction.tombstone", {
		after: true,
		mutation: "committed",
	});
	try {
		await assert.rejects(
			finalizeGeneratedFilesWithCapabilities(context, fixture.options),
			/injected native rename fault|settlement did not complete/,
		);
	} finally {
		await context.close();
	}
	assert.ok(!fs.existsSync(path.join(fixture.dir, ".stdd", "cleanup-transaction.json")));
	assert.ok(!fs.existsSync(path.join(fixture.dir, fixture.source)));
	const inventory = generatedQuarantineInventory(fixture.dir);
	assert.ok(inventory.some(({ relative }) => relative.endsWith("/planning.md")));
	assert.ok(inventory.some(({ relative }) => relative.endsWith("/cleanup-transaction.tombstone")));
});

test("native manifest inspection accepts private and canonical VCS modes only", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { mode: 0o700 });
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	fs.writeFileSync(
		manifestPath,
		`${JSON.stringify({ generatedBy: "stdd", version: VERSION, files: {} }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	const context = await openNativeRepoMutation(dir, "native manifest inspection test");
	try {
		assert.equal((await readManifestDocumentWithCapabilities(context)).version, VERSION);
		fs.chmodSync(manifestPath, 0o644);
		assert.equal((await readManifestDocumentWithCapabilities(context)).version, VERSION);
		fs.chmodSync(manifestPath, 0o666);
		await assert.rejects(
			readManifestDocumentWithCapabilities(context),
			/mode 0600 or canonical VCS checkout mode 0644/i,
		);
	} finally {
		await context.close();
	}
});

test("init normalizes a canonical VCS manifest mode back to private mode", async () => {
	const dir = tmpDir();
	assert.equal((await run(["init", dir, "--tools", "claude"])).code, 0);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	fs.chmodSync(manifestPath, 0o644);
	const rerun = await run(["init", dir, "--tools", "claude"]);
	assert.equal(rerun.code, 0, rerun.stderr);
	assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
});

async function tmpGitRepo(capabilities = ALL_CAPS) {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", capabilities }),
	);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 1;\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2;\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	return { dir, git };
}

test("init records the generated targets in the manifest", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--session-hook"]);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(manifest.targets, {
		tools: ["claude"],
		hooks: false,
		sessionHook: true,
		stopHook: false,
	});
});

test("stale generated outputs and the settled WAL remain stable retained quarantines", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, "method"));
	fs.writeFileSync(path.join(dir, "method", "README.md"), "# Canonical fixture\n");
	assert.equal((await run(["init", dir, "--tools", "claude"])).code, 0);
	const migrated = await run(["init", dir, "--tools", "codex"]);
	assert.equal(migrated.code, 0, migrated.stdout + migrated.stderr);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const first = fs.readFileSync(manifestPath);
	const quarantines = generatedQuarantineInventory(dir).map((entry) => entry.relative);
	assert.ok(quarantines.length > 1);
	assert.ok(
		quarantines.some((relative) =>
			relative.split("/").some((segment) => segment.startsWith(".stdd-cleanup-journal-")),
		),
	);
	for (const parent of new Set(quarantines.map((relative) => path.dirname(path.join(dir, relative))))) {
		assert.equal(fs.statSync(parent).mode & 0o777, 0o700, parent);
	}
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "cleanup-transaction.json")));

	const rerun = await run(["init", dir, "--tools", "codex"]);
	assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
	assert.deepEqual(fs.readFileSync(manifestPath), first, "successful reruns reuse exact quarantines");

	const inventory = generatedQuarantineInventory(dir);
	assert.deepEqual(
		inventory.map((entry) => entry.relative),
		quarantines,
	);
	assert.ok(inventory.every((entry) => entry.provenance === "manifest"));
});

test("native cleanup recovery accepts a legacy v1 Linux identity journal", async (t) => {
	if (process.platform !== "linux") {
		t.skip("legacy dev/inode identities are a Linux compatibility contract");
		return;
	}
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { mode: 0o700 });
	const source = ".stdd/CLAUDE-snippet.md";
	const quarantine = ".stdd/.stdd-cleanup-11111111111111111111111111111111.tmp";
	const sourcePath = path.join(dir, source);
	fs.writeFileSync(sourcePath, "legacy generated bytes\n");
	const parent = fs.statSync(path.dirname(sourcePath));
	const file = fs.statSync(sourcePath);
	fs.renameSync(sourcePath, path.join(dir, quarantine));
	fs.writeFileSync(
		path.join(dir, ".stdd", "cleanup-transaction.json"),
		`${JSON.stringify(
			{
				version: 1,
				entries: [
					{
						source,
						quarantine,
						hash: sha256("legacy generated bytes\n"),
						parentDev: String(parent.dev),
						parentIno: String(parent.ino),
						fileDev: String(file.dev),
						fileIno: String(file.ino),
						phase: "quarantined",
						keepSource: false,
						reason: "",
					},
				],
			},
			null,
			"\t",
		)}\n`,
		{ mode: 0o600 },
	);

	const context = await openNativeRepoMutation(dir, "legacy cleanup recovery test");
	let retained;
	try {
		retained = await recoverCleanupJournalWithCapabilities(context);
	} finally {
		await context.close();
	}
	assert.equal(retained.length, 1);
	assert.ok(fs.existsSync(sourcePath));
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "cleanup-transaction.json")));
	assert.equal(fs.statSync(path.dirname(path.join(dir, retained[0]))).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.join(dir, retained[0])).size, 0);
});

test("committed recovery prefers the newest retained-journal basename over the legacy field", async (t) => {
	if (process.platform !== "linux") {
		t.skip("legacy dev/inode identities are a Linux compatibility contract");
		return;
	}
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".stdd"), { mode: 0o700 });
	const source = ".stdd/CLAUDE-snippet.md";
	const quarantine = ".stdd/.stdd-cleanup-22222222222222222222222222222222.tmp";
	const bytes = "committed quarantine\n";
	fs.writeFileSync(path.join(dir, quarantine), bytes);
	const parent = fs.statSync(path.join(dir, ".stdd"));
	const file = fs.statSync(path.join(dir, quarantine));
	const first =
		".stdd/generated-quarantines/.stdd-cleanup-journal-33333333333333333333333333333333.tmp/cleanup-transaction.tombstone";
	const latest =
		".stdd/generated-quarantines/.stdd-cleanup-journal-44444444444444444444444444444444.tmp/cleanup-transaction.tombstone";
	fs.mkdirSync(path.dirname(path.join(dir, first)), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, first), "");
	const entry = {
		source,
		quarantine,
		hash: sha256(bytes),
		parentDev: String(parent.dev),
		parentIno: String(parent.ino),
		fileDev: String(file.dev),
		fileIno: String(file.ino),
		phase: "quarantined",
		keepSource: false,
		reason: "",
	};
	fs.writeFileSync(
		path.join(dir, ".stdd", "cleanup-transaction.json"),
		`${JSON.stringify({ version: 1, entries: [entry] }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(dir, ".stdd", "manifest.json"),
		`${JSON.stringify(
			{
				generatedBy: "stdd",
				version: VERSION,
				files: {
					[quarantine]: sha256(bytes),
					[first]: sha256(""),
					[latest]: sha256(""),
				},
				retainedCleanupJournal: first,
				retainedCleanupJournals: [first, latest],
			},
			null,
			"\t",
		)}\n`,
		{ mode: 0o600 },
	);

	const context = await openNativeRepoMutation(dir, "committed cleanup recovery test");
	try {
		assert.deepEqual(await recoverCleanupJournalWithCapabilities(context), []);
	} finally {
		await context.close();
	}
	assert.ok(fs.existsSync(path.join(dir, first)), "legacy retained journal remains stable");
	assert.ok(fs.existsSync(path.join(dir, latest)), "the live WAL settles at the newest basename");
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "cleanup-transaction.json")));
});

test("user-owned instruction retirement is WAL-backed without manifesting the source path", async () => {
	const dir = tmpDir();
	const content = "<!-- stdd:begin -->\nmanaged\n<!-- stdd:end -->\n";
	fs.writeFileSync(path.join(dir, "AGENTS.md"), content);
	const context = await openNativeRepoMutation(dir, "instruction retirement test");
	try {
		await finalizeGeneratedFilesWithCapabilities(context, {
			oldFiles: { "AGENTS.md": sha256(content) },
			generated: Object.create(null),
			targets: {
				tools: ["codex"],
				hooks: false,
				sessionHook: false,
				stopHook: false,
			},
			retireOnlyFiles: ["AGENTS.md"],
		});
	} finally {
		await context.close();
	}
	assert.ok(!fs.existsSync(path.join(dir, "AGENTS.md")));
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.ok(!Object.hasOwn(manifest.files, "AGENTS.md"));
	assert.ok(
		Object.keys(manifest.files).some(
			(relative) =>
				relative.startsWith(".stdd/generated-quarantines/") && relative.endsWith("/AGENTS.md"),
		),
	);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "cleanup-transaction.json")));
});

test("a same-byte retained quarantine replacement is not accepted as the journaled identity", async () => {
	const dir = tmpDir();
	assert.equal((await run(["init", dir, "--tools", "claude"])).code, 0);
	assert.equal((await run(["init", dir, "--tools", "codex"])).code, 0);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const before = fs.readFileSync(manifestPath);
	const manifest = JSON.parse(before);
	const relative = Object.keys(manifest.quarantineIdentities).find(
		(candidate) => !candidate.includes(".stdd-cleanup-journal-"),
	);
	assert.ok(relative);
	const quarantinePath = path.join(dir, relative);
	const bytes = fs.readFileSync(quarantinePath);
	const replacementPath = `${quarantinePath}.replacement`;
	fs.writeFileSync(replacementPath, bytes);
	fs.renameSync(replacementPath, quarantinePath);
	assert.notEqual(
		String(fs.statSync(quarantinePath).ino),
		manifest.quarantineIdentities[relative].identity.fileId,
	);

	const rerun = await run(["init", dir, "--tools", "codex"]);
	assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
	assert.deepEqual(fs.readFileSync(manifestPath), before);
});

test("an upgrade past the CI adapters keeps the workflow and stops managing it", async () => {
	// A pre-0.10.0 install has a generated .github/workflows/stdd.yml recorded
	// in its manifest. The adapters that wrote it are gone, so the retirement
	// sweep would delete a byte-identical file — silently removing the
	// adopter's CI gate. It must be released instead: left on disk, dropped
	// from the manifest, and no longer verified by check.
	const workflowRel = ".github/workflows/stdd.yml";
	const seedLegacyInstall = async () => {
		const dir = tmpDir();
		await run(["init", dir, "--tools", "claude"]);
		const workflowPath = path.join(dir, workflowRel);
		const bytes = "name: STDD\non: pull_request\njobs: {}\n";
		fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
		fs.writeFileSync(workflowPath, bytes);
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		manifest.files[workflowRel] = sha256(bytes);
		manifest.targets.ci = ["github"];
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		return { dir, workflowPath, bytes, manifestPath };
	};

	for (const command of ["init", "configure"]) {
		const { dir, workflowPath, bytes, manifestPath } = await seedLegacyInstall();
		const args =
			command === "init"
				? ["init", dir, "--tools", "claude"]
				: ["configure", dir, "--capabilities", "subagents,worktrees"];
		const res = await run(args);
		assert.equal(res.code, 0, `${command}: ${res.stdout}${res.stderr}`);
		assert.equal(fs.readFileSync(workflowPath, "utf8"), bytes, `${command} kept the workflow`);
		assert.match(res.stdout, /Left \.github\/workflows\/stdd\.yml in place/);
		const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		assert.ok(!Object.hasOwn(after.files, workflowRel), `${command} stopped tracking it`);
		assert.ok(!Object.hasOwn(after.targets, "ci"), `${command} dropped the retired target`);
		assert.equal((await run(["check", dir])).code, 0, `${command}: check stays green`);

		// released, not frozen: editing it afterwards is the adopter's business
		fs.writeFileSync(workflowPath, `${bytes}# edited\n`);
		assert.equal((await run(["check", dir])).code, 0, `${command}: an edit is no longer graded`);
	}
});

test("the repository manifest remembers its installed lifecycle hooks", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, ".stdd", "manifest.json"), "utf8"));
	assert.equal(manifest.targets.sessionHook, true);
	assert.equal(manifest.targets.stopHook, true);
	for (const relative of [".claude/settings.json", ".codex/hooks.json"]) {
		const settings = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, relative), "utf8"));
		assert.ok(settings.hooks.SessionStart?.length > 0, relative);
		assert.ok(settings.hooks.Stop?.length > 0, relative);
	}
});

test("configure edits capabilities and route, preserves other keys, recompiles remembered targets", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude"]);
	const cfgPath = path.join(dir, ".stdd", "config.json");
	const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
	cfg.redPattern = "MY_PATTERN";
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));

	const res = await run([
		"configure",
		dir,
		"--capabilities",
		"subagents,crossCli,worktrees",
		"--review-via",
		"codex",
	]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const after = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
	assert.equal(after.redPattern, "MY_PATTERN", "user keys survive configure");
	assert.deepEqual(after.capabilities, { subagents: true, crossCli: true, worktrees: true });
	assert.equal(after.review.via, "codex");
	// remembered targets are recompiled against the new profile
	const slice = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	assert.match(slice, /codex exec/, "crossCli block appears after the toggle");
});

test("configure rejects malformed remembered targets before any write", async () => {
	for (const malformed of [
		{
			tools: ["unknown-agent"],
			hooks: false,
			sessionHook: false,
			stopHook: false,
		},
		{
			tools: ["claude"],
			hooks: "yes",
			sessionHook: false,
			stopHook: false,
		},
	]) {
		const dir = tmpDir();
		await run(["init", dir, "--tools", "claude"]);
		const configPath = path.join(dir, ".stdd", "config.json");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const configBefore = fs.readFileSync(configPath, "utf8");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		manifest.targets = malformed;
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		const manifestBefore = fs.readFileSync(manifestPath, "utf8");

		const res = await run([
			"configure",
			dir,
			"--capabilities",
			"crossCli,worktrees",
			"--review-via",
			"codex",
		]);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /manifest\.json.*targets/i);
		assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
		assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
	}
});

test("configure rejects a present malformed or unreadable manifest before any write", async () => {
	for (const corruptManifest of [
		(manifestPath) => fs.writeFileSync(manifestPath, "{}\n"),
		(manifestPath) => {
			fs.rmSync(manifestPath);
			fs.mkdirSync(manifestPath);
		},
	]) {
		const dir = tmpDir();
		await run(["init", dir, "--tools", "claude"]);
		const configPath = path.join(dir, ".stdd", "config.json");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const skillPath = path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md");
		const configBefore = fs.readFileSync(configPath, "utf8");
		const skillBefore = fs.readFileSync(skillPath, "utf8");
		corruptManifest(manifestPath);

		const res = await run([
			"configure",
			dir,
			"--capabilities",
			"subagents,crossCli,worktrees",
			"--review-via",
			"codex",
		]);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /manifest\.json/i);
		assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
		assert.equal(fs.readFileSync(skillPath, "utf8"), skillBefore);
	}
});

test("configure rejects invalid manifest identity and hashes before any write", async () => {
	for (const [name, mutate] of [
		["wrong generator", (manifest) => (manifest.generatedBy = "other")],
		["missing version", (manifest) => delete manifest.version],
		["malformed version", (manifest) => (manifest.version = "v1")],
		["missing hash", (manifest) => (manifest.files[".stdd/method.md"] = null)],
		["uppercase hash", (manifest) => (manifest.files[".stdd/method.md"] = `sha256:${"A".repeat(64)}`)],
	]) {
		const dir = tmpDir();
		await run(["init", dir, "--tools", "claude"]);
		const configPath = path.join(dir, ".stdd", "config.json");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const skillPath = path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md");
		const configBefore = fs.readFileSync(configPath, "utf8");
		const skillBefore = fs.readFileSync(skillPath, "utf8");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		mutate(manifest);
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		const manifestBefore = fs.readFileSync(manifestPath, "utf8");

		const result = await run([
			"configure",
			dir,
			"--capabilities",
			"subagents,crossCli,worktrees",
			"--review-via",
			"codex",
		]);
		assert.equal(result.code, 1, `${name}: ${result.stdout}${result.stderr}`);
		assert.match(
			result.stderr,
			/manifest\.json.*generatedBy|manifest\.json.*version|manifest\.json.*sha256/i,
		);
		assert.equal(fs.readFileSync(configPath, "utf8"), configBefore, name);
		assert.equal(fs.readFileSync(skillPath, "utf8"), skillBefore, name);
		assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore, name);
	}
});

test("canonical configure docs name the explicit Stop-hook exception", () => {
	const method = fs.readFileSync(path.join(PKG_ROOT, "method", "reference-integration.md"), "utf8");
	assert.match(method, /does not install or remove CI workflows/i);
	assert.match(method, /explicit exception:[\s\S]*--stop-hook[\s\S]*install/i);
});

test("configure restores only remembered Stop hooks, never pre-push or session hooks", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--hooks", "--session-hook", "--stop-hook"]);
	fs.rmSync(path.join(dir, ".stdd", "hooks", "pre-push"));
	fs.rmSync(path.join(dir, ".claude", "settings.json"));

	const res = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "hooks", "pre-push")));
	const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
	assert.deepEqual(Object.keys(settings.hooks), ["Stop"]);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(
		{
			hooks: manifest.targets.hooks,
			sessionHook: manifest.targets.sessionHook,
			stopHook: manifest.targets.stopHook,
		},
		{ hooks: true, sessionHook: true, stopHook: true },
		"configure preserves remembered targets without recreating pre-push/session hooks",
	);
});

test("legacy target inference reads manifest.files, not stray directories", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "codex"]);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	delete manifest.targets;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
	// a stray empty skills directory must not smuggle claude into the targets
	fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });

	const res = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(
		!fs.existsSync(path.join(dir, ".claude", "skills", "stdd-planning", "SKILL.md")),
		"claude skills must not appear for a codex-only legacy install",
	);
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "AGENTS-snippet.md")));
});

test("filesystem target inference preserves Codex without a manifest", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "codex"]);
	fs.rmSync(path.join(dir, ".stdd", "manifest.json"));

	const res = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "stdd-planning", "SKILL.md")));
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.deepEqual(manifest.targets.tools, ["codex"]);
});

test("stop-hook fails open: no commits or broken config exits 0, never 1", async () => {
	// a repo with no commit — rev-parse has no branch to name
	const bare = tmpDir();
	await exec("git", ["-C", bare, "init", "-q", "-b", "main"]);
	fs.mkdirSync(path.join(bare, ".stdd"), { recursive: true });
	const noCommit = runStopHook(bare, "{}");
	assert.equal(noCommit.code, 0, noCommit.stderr);

	// unparseable config — an internal error must not trap the session
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), "{broken");
	const brokenCfg = runStopHook(dir, "{}");
	assert.equal(brokenCfg.code, 0, brokenCfg.stderr);

	// outside any repository — resolution must fail open, never exit 1
	const nowhere = tmpDir();
	const outside = runStopHook(nowhere, "{}");
	assert.equal(outside.code, 0, outside.stderr);
});

test("stop-hook fails open on a malformed payload — never a re-blocking loop", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	// with a readable payload the broken claim blocks…
	assert.equal(runStopHook(dir, "{}").code, 2);
	// …but an unreadable one cannot prove stop_hook_active is false — exit 0
	const malformed = runStopHook(dir, "{not json");
	assert.equal(malformed.code, 0, malformed.stderr);
	const nonObject = runStopHook(dir, "null");
	assert.equal(nonObject.code, 0, "a syntactically valid non-object payload also fails open");
});

test("configure --max-rounds sets the review budget and preserves the route", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude"]);
	const res = await run(["configure", dir, "--max-rounds", "3"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.equal(cfg.review.maxRounds, 3);
	assert.equal(cfg.review.via, "subagent", "the route is untouched");
	const bad = await run(["configure", dir, "--max-rounds", "x"]);
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /--max-rounds/);

	// an overflow must fail at parse time — Infinity serializes to null
	// and would corrupt the user's config
	const huge = await run(["configure", dir, "--max-rounds", "9".repeat(400)]);
	assert.equal(huge.code, 1);
	assert.match(huge.stderr, /--max-rounds/);
	const cfg2 = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.equal(cfg2.review.maxRounds, 3, "the config survives the rejected overflow");
});

test("configure rejects a route incompatible with the profile, config untouched", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude"]); // default profile: crossCli off
	const cfgPath = path.join(dir, ".stdd", "config.json");
	const before = fs.readFileSync(cfgPath, "utf8");
	const res = await run(["configure", dir, "--review-via", "codex"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
	assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "no partial write");
});

test("init and configure support a no-dispatch profile without false gate or Stop claims", async () => {
	const { dir } = await tmpGitRepo();
	const initialized = await run([
		"init",
		dir,
		"--tools",
		"codex",
		"--capabilities",
		"worktrees",
		"--stop-hook",
	]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);

	const configured = await run(["configure", dir, "--capabilities", "worktrees"]);
	assert.equal(configured.code, 0, configured.stdout + configured.stderr);
	const config = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(config.capabilities, {
		subagents: false,
		crossCli: false,
		worktrees: true,
	});
	assert.equal(config.review.via, "subagent", "the unavailable default remains dormant, not claimed");

	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "# P\n\n- [x] impl\n- [ ] verify\n");
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
	assert.equal(runStopHook(dir, "{}").code, 0);
});

test("configure without an install fails with the pointer to init", async () => {
	const dir = tmpDir();
	const res = await run(["configure", dir]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /stdd init/);
});

test("interactive configure defaults to the current values", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude"]);
	// subagents=default(current: on), crossCli=y, worktrees=default(on),
	// route=codex, budget=default(0), stop hook=n
	const out = execFileSync(process.execPath, [CLI, "configure", dir], {
		input: "\ny\n\ncodex\n\nn\n",
		encoding: "utf8",
	});
	assert.match(out, /\[Y\/n\]/);
	const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "config.json"), "utf8"));
	assert.deepEqual(cfg.capabilities, { subagents: true, crossCli: true, worktrees: true });
	assert.equal(cfg.review.via, "codex");
	assert.equal(cfg.review.maxRounds ?? 0, 0);
});

test("init --stop-hook merges a Stop hook entry idempotently", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const settingsPath = path.join(dir, ".claude", "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.match(settings.hooks.Stop[0].hooks[0].command, /stdd stop-hook/);
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const again = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(again.hooks.Stop.length, 1, "idempotent");
	again.hooks.Stop[0].hooks[0].command = "npx --no stdd stop-hook";
	fs.writeFileSync(settingsPath, JSON.stringify(again, null, "\t"));
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const migrated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(migrated.hooks.Stop[0].hooks[0].command, claudeStopCommand(NPM_RUNNER));
	migrated.hooks.Stop[0].hooks[0].command =
		"npm exec --offline --package=@stdd/cli@0.5.0 -- stdd stop-hook";
	fs.writeFileSync(settingsPath, JSON.stringify(migrated, null, "\t"));
	await run(["init", dir, "--tools", "claude", "--stop-hook"]);
	const repinned = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(repinned.hooks.Stop[0].hooks[0].command, claudeStopCommand(NPM_RUNNER));
});

test("Pi lifecycle extension restores status and bounds stop continuation", async () => {
	const dir = tmpDir();
	const initialized = await run(["init", dir, "--tools", "pi", "--session-hook", "--stop-hook"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const extensionPath = path.join(dir, ".pi", "extensions", "stdd.js");
	const extension = fs.readFileSync(extensionPath, "utf8");
	assert.match(extension, /STDD managed Pi lifecycle extension v1/);
	assert.match(extension, /pi\.on\("session_start"/);
	assert.match(extension, /pi\.on\("session_compact"/);
	assert.match(extension, /status --local/);
	assert.match(extension, /deliverAs: "nextTurn"/);
	assert.match(extension, /pi\.on\("agent_settled"/);
	assert.match(extension, /stop-hook/);
	assert.match(extension, /deliverAs: "followUp", triggerTurn: true/);
	assert.match(extension, /skipNextGate/);
	assert.match(extension, /exitCode !== 2/);

	const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".stdd", "manifest.json"), "utf8"));
	assert.ok(
		!(".pi/extensions/stdd.js" in manifest.files),
		"the lifecycle extension is user-owned like native hook settings",
	);

	await run(["init", dir, "--tools", "pi", "--session-hook", "--stop-hook"]);
	assert.equal(fs.readFileSync(extensionPath, "utf8"), extension, "idempotent");
});

test("rendered Pi lifecycle extension executes restore and one corrective continuation", async () => {
	const dir = tmpDir();
	const runner = path.join(dir, "fake-stdd");
	const calls = path.join(dir, "calls.txt");
	fs.writeFileSync(
		runner,
		[
			"#!/bin/sh",
			"cat >/dev/null",
			`printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
			'if [ "$1 $2" = "status --local" ]; then printf "task: active\\n"; exit 0; fi',
			'if [ "$1" = "stop-hook" ]; then printf "review required\\n" >&2; exit 2; fi',
			"exit 7",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const extensionPath = path.join(dir, "stdd.mjs");
	fs.writeFileSync(
		extensionPath,
		renderPiLifecycleExtension(runner, { sessionHook: true, stopHook: true }),
	);
	const loaded = await import(`${new URL(`file://${extensionPath}`).href}?test=${Date.now()}`);
	const handlers = new Map();
	const sent = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		sendMessage(message, options) {
			sent.push({ message, options });
		},
	};
	loaded.default(pi);
	const ctx = { cwd: dir };

	await handlers.get("session_start")({}, ctx);
	assert.deepEqual(sent.shift(), {
		message: { customType: "stdd-status", content: "task: active\n", display: false },
		options: { deliverAs: "nextTurn" },
	});

	await handlers.get("agent_settled")({}, ctx);
	assert.deepEqual(sent.shift(), {
		message: { customType: "stdd-stop-gate", content: "review required\n", display: true },
		options: { deliverAs: "followUp", triggerTurn: true },
	});
	await handlers.get("agent_settled")({}, ctx);
	assert.deepEqual(sent, []);
	assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["status --local", "stop-hook"]);
});

test("Pi lifecycle extension merges requested features and preserves a conflict", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "pi", "--session-hook"]);
	const extensionPath = path.join(dir, ".pi", "extensions", "stdd.js");
	const sessionOnly = fs.readFileSync(extensionPath, "utf8");
	assert.match(sessionOnly, /session_start/);
	assert.doesNotMatch(sessionOnly, /agent_settled/);

	await run(["init", dir, "--tools", "pi", "--stop-hook"]);
	const combined = fs.readFileSync(extensionPath, "utf8");
	assert.match(combined, /session_start/);
	assert.match(combined, /agent_settled/);

	const conflictingDir = tmpDir();
	const conflictingPath = path.join(conflictingDir, ".pi", "extensions", "stdd.js");
	fs.mkdirSync(path.dirname(conflictingPath), { recursive: true });
	fs.writeFileSync(conflictingPath, "export default function userExtension() {}\n");
	const conflict = await run(["init", conflictingDir, "--tools", "claude,pi", "--session-hook"]);
	assert.equal(conflict.code, 0, conflict.stdout + conflict.stderr);
	assert.equal(fs.readFileSync(conflictingPath, "utf8"), "export default function userExtension() {}\n");
	assert.ok(
		!fs.existsSync(path.join(conflictingDir, ".claude", "settings.json")),
		"a conflicting Pi extension aborts lifecycle writes for every selected host",
	);
	assert.match(conflict.stderr, /conflicting.*Pi|Pi.*left untouched/i);
});

test("configure restores a remembered Pi stop continuation without adding session restore", async () => {
	const dir = tmpDir();
	await run(["init", dir, "--tools", "pi", "--session-hook", "--stop-hook"]);
	const extensionPath = path.join(dir, ".pi", "extensions", "stdd.js");
	fs.rmSync(extensionPath);

	const configured = await run(["configure", dir, "--capabilities", "subagents,worktrees"]);
	assert.equal(configured.code, 0, configured.stdout + configured.stderr);
	const extension = fs.readFileSync(extensionPath, "utf8");
	assert.match(extension, /agent_settled/);
	assert.doesNotMatch(
		extension,
		/session_start/,
		"configure maintains remembered Stop integration but never restores session hooks",
	);
});

test("generated Stop commands fail open when the project-local runner is unavailable", () => {
	const missing = "/definitely/missing/stdd-runner";
	const claude = spawnSync("/bin/sh", ["-c", claudeStopCommand(missing)], {
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(claude.status, 0);
	assert.equal(claude.stdout, "");
	assert.equal(claude.stderr, "");

	const codex = spawnSync("/bin/sh", ["-c", codexStopCommand(missing)], {
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(codex.status, 0);
	assert.deepEqual(JSON.parse(codex.stdout), {});
	assert.equal(codex.stderr, "");
});

test("the Codex Stop wrapper normalizes only valid continuation JSON and always exits zero", () => {
	const dir = tmpDir();
	const runner = path.join(dir, "fake-codex-stdd");
	fs.writeFileSync(
		runner,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
		'#!/bin/sh\nprintf \'%s\' "${STDD_FAKE_STDOUT-}"\nprintf \'%s\' "${STDD_FAKE_STDERR-}" >&2\nexit "${STDD_FAKE_EXIT:-0}"\n',
		{ mode: 0o755 },
	);
	const execute = ({ stdout = "", stderr = "hidden diagnostic", exit = "0" }) =>
		spawnSync("/bin/sh", ["-c", codexStopCommand(runner)], {
			input: '{"stop_hook_active":false}',
			encoding: "utf8",
			env: {
				...process.env,
				STDD_FAKE_STDOUT: stdout,
				STDD_FAKE_STDERR: stderr,
				STDD_FAKE_EXIT: exit,
			},
		});

	for (const { name, child, expected } of [
		{
			name: "valid block",
			child: ' { "decision": "block", "reason": "keep going" }\n',
			expected: { decision: "block", reason: "keep going" },
		},
		{
			name: "valid padded reason",
			child: '{"decision":"block","reason":"  keep going  "}',
			expected: { decision: "block", reason: "  keep going  " },
		},
		{ name: "valid continue", child: "{}\n", expected: {} },
		{ name: "malformed JSON", child: "not-json", expected: {} },
		{ name: "array schema", child: "[]", expected: {} },
		{ name: "unexpected decision", child: '{"decision":"allow"}', expected: {} },
		{ name: "missing block reason", child: '{"decision":"block"}', expected: {} },
		{ name: "empty block reason", child: '{"decision":"block","reason":""}', expected: {} },
		{
			name: "whitespace-only block reason",
			child: '{"decision":"block","reason":"  \\t\\n  "}',
			expected: {},
		},
		{
			name: "extra block key",
			child: '{"decision":"block","reason":"keep going","extra":true}',
			expected: {},
		},
		{ name: "empty stdout", child: "", expected: {} },
	]) {
		const result = execute({ stdout: child });
		assert.equal(result.status, 0, `${name}: wrapper exit`);
		assert.equal(result.stderr, "", `${name}: diagnostics are suppressed`);
		assert.deepEqual(JSON.parse(result.stdout), expected, `${name}: normalized payload`);
		assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, `${name}: canonical JSON output`);
	}

	const failed = execute({
		stdout: '{"decision":"block","reason":"must not survive"}',
		exit: "7",
	});
	assert.equal(failed.status, 0, "child nonzero is fail-open");
	assert.equal(failed.stderr, "");
	assert.equal(failed.stdout, "{}\n");
});

test("the Claude Stop wrapper preserves only an intentional block exit", () => {
	const dir = tmpDir();
	const runner = path.join(dir, "fake-stdd");
	fs.writeFileSync(
		runner,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
		"#!/bin/sh\nprintf 'intentional block\\n' >&2\nexit \"${STDD_FAKE_EXIT:-2}\"\n",
		{ mode: 0o755 },
	);
	const blocked = spawnSync("/bin/sh", ["-c", claudeStopCommand(runner)], {
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(blocked.status, 2);
	assert.equal(blocked.stderr, "intentional block\n");

	const broken = spawnSync("/bin/sh", ["-c", claudeStopCommand(runner)], {
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, STDD_FAKE_EXIT: "7" },
	});
	assert.equal(broken.status, 0);
	assert.equal(broken.stderr, "");
});

test("source-checkout hook runner stays idempotent", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				PostCompact: [
					{ hooks: [{ type: "command", command: `${SOURCE_RUNNER} status --local || true` }] },
				],
				Stop: [{ hooks: [{ type: "command", command: `${SOURCE_RUNNER} stop-hook` }] }],
			},
		}),
	);
	fs.writeFileSync(
		path.join(dir, ".codex", "hooks.json"),
		JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: `${SOURCE_RUNNER} stop-hook --agent codex` }] }],
			},
		}),
	);
	for (let i = 0; i < 2; i++) {
		installSessionHook(dir, SOURCE_RUNNER, ["claude", "codex"]);
		installStopHook(dir, SOURCE_RUNNER, ["claude", "codex"]);
	}
	const claude = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
	const codex = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
	assert.equal(claude.hooks.SessionStart.length, 1);
	assert.equal(claude.hooks.PostCompact, undefined);
	assert.equal(claude.hooks.Stop.length, 1);
	assert.equal(codex.hooks.SessionStart.length, 1);
	assert.equal(codex.hooks.Stop.length, 1);
	assert.equal(claude.hooks.Stop[0].hooks[0].command, claudeStopCommand(SOURCE_RUNNER));
	assert.equal(codex.hooks.Stop[0].hooks[0].command, codexStopCommand(SOURCE_RUNNER));
});

test("source-checkout Codex Stop migration removes the historical wrapper without user-hook loss", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const userCommand = "printf 'user Stop hook\\n'";
	const legacyCommand = `{ output="$(${SOURCE_RUNNER} stop-hook --agent codex 2>/dev/null)" && printf '%s\\n' "$output" || printf '{}\\n'; exit 0; }`;
	const currentCommand = codexStopCommand(SOURCE_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: legacyCommand },
								{ type: "command", command: userCommand },
							],
						},
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, SOURCE_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(migrated.hooks.Stop.length, 1, "the duplicate managed-only group is removed");
	assert.equal(commands.filter((command) => command === currentCommand).length, 1);
	assert.equal(commands.includes(legacyCommand), false);
	assert.equal(commands.filter((command) => command === userCommand).length, 1);
});

test("source-checkout Codex Stop migration replaces stale normalized wrappers with one strict boundary", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const userCommand = "printf 'user Stop hook\\n'";
	const staleCommand = staleNormalizedCodexStopCommand(SOURCE_RUNNER);
	const currentCommand = codexStopCommand(SOURCE_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.mkdirSync(path.join(dir, "cli"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "cli", "stdd.mjs"),
		'process.stdout.write(JSON.stringify({ decision: "block", reason: "keep going", extra: true }));\n',
	);
	assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: staleCommand },
								{ type: "command", command: userCommand },
							],
						},
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, SOURCE_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(migrated.hooks.Stop.length, 1, "the duplicate managed-only group is removed");
	assert.equal(commands.filter((command) => command === currentCommand).length, 1);
	assert.equal(commands.includes(staleCommand), false);
	assert.equal(commands.filter((command) => command === userCommand).length, 1);
	const [migratedCommand] = commands.filter((command) => command === currentCommand);
	const strict = spawnSync("/bin/sh", ["-c", migratedCommand], {
		cwd: dir,
		input: "{}",
		encoding: "utf8",
	});
	assert.equal(strict.status, 0);
	assert.equal(strict.stderr, "");
	assert.equal(strict.stdout, "{}\n", "the migrated boundary rejects the stale extra-key schema");
});

test("versioned npm Codex Stop migration replaces a stale normalized wrapper", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const previousRunner = "npm exec --offline --package=@stdd/cli@0.6.0 -- stdd";
	const staleCommand = staleNormalizedCodexStopCommand(previousRunner);
	const currentCommand = codexStopCommand(NPM_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{ hooks: [{ type: "command", command: staleCommand }] },
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, NPM_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(migrated.hooks.Stop.length, 1);
	assert.deepEqual(commands, [currentCommand]);
});

test("Codex Stop migration collapses every known generated shape across runner families", () => {
	const legacyWrapper = (runner) =>
		`{ output="$(${runner} stop-hook --agent codex 2>/dev/null)" && printf '%s\\n' "$output" || printf '{}\\n'; exit 0; }`;

	for (const { name, previousRunner, targetRunner } of [
		{ name: "source to npm", previousRunner: SOURCE_RUNNER, targetRunner: NPM_RUNNER },
		{ name: "npm to source", previousRunner: NPM_RUNNER, targetRunner: SOURCE_RUNNER },
	]) {
		const dir = tmpDir();
		const hooksPath = path.join(dir, ".codex", "hooks.json");
		const userCommand = `printf '${name} user hook\\n'`;
		const currentCommand = codexStopCommand(targetRunner);
		const managedCommands = [
			`${previousRunner} stop-hook --agent codex`,
			legacyWrapper(previousRunner),
			staleNormalizedCodexStopCommand(previousRunner),
			codexStopCommand(previousRunner),
			currentCommand,
		];
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(
			hooksPath,
			`${JSON.stringify(
				{
					hooks: {
						Stop: managedCommands.map((command, index) => ({
							hooks: [
								{ type: "command", command },
								...(index === 0 ? [{ type: "command", command: userCommand }] : []),
							],
						})),
					},
				},
				null,
				"\t",
			)}\n`,
		);

		installStopHook(dir, targetRunner, ["codex"]);

		const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
		const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
		assert.equal(migrated.hooks.Stop.length, 1, `${name}: managed-only groups are removed`);
		assert.deepEqual(commands, [currentCommand, userCommand], `${name}: one current plus user hook`);
	}
});

test("Codex Stop migration preserves a custom wrapper using the same managed invocation", () => {
	const dir = tmpDir();
	const hooksPath = path.join(dir, ".codex", "hooks.json");
	const userCommand = "printf 'user Stop hook\\n'";
	const customCommand = `{ stdd_codex_stop_protocol=1; output="$(${SOURCE_RUNNER} stop-hook --agent codex 2>/dev/null)" && printf '%s' "$output" | node -e 'process.stdin.pipe(process.stdout)' 2>/dev/null || printf '{}\\n'; printf 'custom audit\\n' >&2; exit 0; }`;
	const currentCommand = codexStopCommand(SOURCE_RUNNER);
	fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
	fs.writeFileSync(
		hooksPath,
		`${JSON.stringify(
			{
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: customCommand },
								{ type: "command", command: userCommand },
							],
						},
						{ hooks: [{ type: "command", command: currentCommand }] },
					],
				},
			},
			null,
			"\t",
		)}\n`,
	);

	installStopHook(dir, SOURCE_RUNNER, ["codex"]);

	const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	const commands = migrated.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
	assert.equal(commands.filter((command) => command === currentCommand).length, 1);
	assert.equal(commands.filter((command) => command === customCommand).length, 1);
	assert.equal(commands.filter((command) => command === userCommand).length, 1);
});

test("init recognizes a different @stdd/cli source checkout for offline hooks", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, "cli"), { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), '{"name":"@stdd/cli","version":"0.0.0"}');
	fs.writeFileSync(path.join(dir, "cli", "stdd.mjs"), "// source checkout marker\n");

	const res = await run(["init", dir, "--tools", "codex", "--session-hook"]);
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
	assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, `${SOURCE_RUNNER} status --local || true`);
	assert.doesNotMatch(res.stderr, /project-local stdd binary is missing/);
});

// stop-hook reads its payload from stdin to EOF — execFile keeps stdin
// open, so these calls must use execFileSync with `input`
function runStopHook(dir, payload, agent = "claude") {
	try {
		const stdout = execFileSync(
			process.execPath,
			[CLI, "stop-hook", ...(agent === "codex" ? ["--agent", "codex"] : [])],
			{
				cwd: dir,
				input: payload,
				encoding: "utf8",
			},
		);
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

function assertCodexAllows(result, message) {
	assert.equal(result.code, 0, `${message}: ${result.stderr}`);
	assert.equal(result.stderr, "", `${message}: fail-open must stay silent on stderr`);
	assert.equal(result.stdout.trim(), "{}", `${message}: Codex must receive an explicit allow payload`);
	assert.deepEqual(JSON.parse(result.stdout), {}, `${message}: stdout must be valid JSON`);
}

test("stdd stop-hook: clean exits 0, broken claim exits 2, stop_hook_active never loops", async () => {
	const { dir } = await tmpGitRepo();
	const clean = runStopHook(dir, "{}");
	assert.equal(clean.code, 0, clean.stderr);

	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const broken = runStopHook(dir, "{}");
	assert.equal(broken.code, 2);
	assert.match(broken.stderr, /review/);

	const active = runStopHook(dir, '{"stop_hook_active": true}');
	assert.equal(active.code, 0, "a blocked stop is never re-blocked into a loop");

	const nested = path.join(dir, "apps", "api");
	fs.mkdirSync(path.join(nested, ".stdd"), { recursive: true });
	const fromNested = runStopHook(nested, "{}");
	assert.equal(fromNested.code, 2, "the Git-root ledger wins over an accidental nested .stdd");
});

test("Codex stop-hook returns its Stop continuation protocol without a nonzero exit", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const blocked = runStopHook(dir, "{}", "codex");
	assert.equal(blocked.code, 0, blocked.stderr);
	const payload = JSON.parse(blocked.stdout);
	assert.equal(payload.decision, "block");
	assert.match(payload.reason, /review/i);

	const active = runStopHook(dir, '{"stop_hook_active": true}', "codex");
	assertCodexAllows(active, "a repeated Codex stop is allowed without another block");
});

test("Codex stop-hook prints a valid empty object on every fail-open branch", async () => {
	const { dir } = await tmpGitRepo();
	assertCodexAllows(runStopHook(dir, "{not json", "codex"), "malformed input");
	assertCodexAllows(runStopHook(dir, "null", "codex"), "non-object input");

	const outside = tmpDir();
	assertCodexAllows(runStopHook(outside, "{}", "codex"), "outside a repository");

	const { dir: missingState } = await tmpGitRepo();
	fs.rmSync(path.join(missingState, ".stdd"), { recursive: true });
	assertCodexAllows(runStopHook(missingState, "{}", "codex"), "repository without STDD state");

	const { dir: brokenConfig } = await tmpGitRepo();
	fs.writeFileSync(path.join(brokenConfig, ".stdd", "config.json"), "{broken");
	assertCodexAllows(runStopHook(brokenConfig, "{}", "codex"), "broken config");
});

test("review --via claude dispatches the claude runner headless", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [ ] closing review [review:]\n",
	);
	const bin = path.join(tmpDir(), "claude-stub");
	const argsPath = path.join(tmpDir(), "claude-args.txt");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
printf '%s\n' "$@" > "${argsPath}"
cat > /dev/null
printf '%s' '{"summary": "sound", "findings": []}'
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "claude"], {
		cwd: dir,
		env: { ...process.env, STDD_CLAUDE_BIN: bin },
	});
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const events = parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
	const review = events.find((e) => e.event === "review");
	assert.equal(review.via, "claude");
	assert.equal(review.verdict, "approved");
	assert.deepEqual(fs.readFileSync(argsPath, "utf8").trim().split("\n"), [
		"-p",
		"--safe-mode",
		"--tools",
		"Read,Glob,Grep",
		"--permission-mode",
		"dontAsk",
	]);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review/);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("review --via claude requires the crossCli capability", async () => {
	const { dir } = await tmpGitRepo({ subagents: true, crossCli: false, worktrees: true });
	const res = await run(["review", "--via", "claude"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
});
