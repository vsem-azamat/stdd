import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openNativeRepoMutation } from "../cli/held-fs.mjs";
import { parseLedger, sha256 } from "../cli/lib.mjs";
import { workerCollect, workerCreate } from "../cli/worker.mjs";
import {
	preflightPrivateWorkerQuarantine,
	publishWorkerFile,
	publishWorkerSymlink,
	quarantineWorkerDeletion,
	readNativeWorkerPath,
	readWorkerDeletionQuarantineState,
	readWorkerPathState,
	workerQuarantineInventory,
	writeNewWorkerPath,
} from "../cli/worker-fs.mjs";
import { parseWorkerMetadata } from "../cli/worker-metadata.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

async function run(args, options = {}) {
	try {
		const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], options);
		return { code: 0, stdout, stderr };
	} catch (error) {
		return {
			code: error.code ?? 1,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
		};
	}
}

function writeLedgerEvents(root, events) {
	fs.mkdirSync(path.join(root, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".stdd", "ledger.jsonl"),
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		{ mode: 0o600 },
	);
}

function appendWorkerEvidence(sandbox, specs) {
	const metadata = JSON.parse(fs.readFileSync(path.join(sandbox, ".stdd", "worker.json"), "utf8"));
	const events = specs.map((spec) => {
		const common = {
			ts: new Date().toISOString(),
			taskId: metadata.source.taskId,
			branch: metadata.source.branch,
		};
		if (spec === "red") {
			return {
				...common,
				event: "red",
				cmd: "node failing-test.mjs",
				exit: 1,
				excerpt: "intentional failure",
				genuine: "yes",
			};
		}
		if (spec === "verify") {
			return {
				...common,
				event: "verify",
				cmd: "node passing-test.mjs",
				exit: 0,
				excerpt: "",
			};
		}
		return { ...common, event: "note", text: spec.note };
	});
	fs.appendFileSync(
		path.join(sandbox, ".stdd", "ledger.jsonl"),
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
	);
}

async function fixture() {
	const root = makeTempDir("stdd-worker-source-");
	const git = (...args) =>
		exec("git", ["-C", root, "-c", "user.name=STDD", "-c", "user.email=stdd@test", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(root, ".stdd"));
	fs.mkdirSync(path.join(root, "src"));
	fs.mkdirSync(path.join(root, "док"));
	fs.writeFileSync(path.join(root, ".stdd", "config.json"), '{"redPattern":"fail|ERR_ASSERTION"}\n');
	fs.writeFileSync(
		path.join(root, ".gitignore"),
		"ignored/\nnode_modules/\n/dist/\n.stdd/ledger.jsonl\n.stdd/plan.md\n.stdd/worker.json\n.stdd/worker-deletions/\n",
	);
	fs.writeFileSync(path.join(root, "README.md"), "# Source\n");
	fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
	fs.writeFileSync(path.join(root, "src", "shared.js"), "export const shared = true;\n");
	fs.chmodSync(path.join(root, "src", "shared.js"), 0o644);
	fs.writeFileSync(path.join(root, "док", "info.md"), "bound\n");
	fs.symlinkSync("app.js", path.join(root, "src", "current.js"));
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
	fs.writeFileSync(path.join(root, "src", "draft.js"), "export const draft = true;\n");
	fs.writeFileSync(path.join(root, "root-draft.txt"), "draft\n");
	fs.mkdirSync(path.join(root, "ignored"));
	fs.writeFileSync(path.join(root, "ignored", "secret.txt"), "secret\n");
	fs.writeFileSync(path.join(root, ".stdd", "plan.md"), "working plan\n");
	writeLedgerEvents(root, [
		{
			ts: new Date().toISOString(),
			event: "task-start",
			id: "task-worker-fixture",
			name: "worker fixture",
			planBaseline: null,
			branch: "feature",
		},
		{
			ts: new Date().toISOString(),
			event: "docs",
			decision: "updated-first",
			paths: ["README.md"],
			snapshot: `sha256:${"0".repeat(64)}`,
			reason: "worker fixture",
			taskId: "task-worker-fixture",
			branch: "feature",
		},
	]);
	return { root, git };
}

function ledger(directory) {
	return parseLedger(fs.readFileSync(path.join(directory, ".stdd", "ledger.jsonl"), "utf8"));
}

test("worker create requires an active task, docs decision, scope, and absent destination", async () => {
	const root = makeTempDir("stdd-worker-preconditions-");
	await exec("git", ["-C", root, "init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
	await exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
	await exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
	const destination = path.join(os.tmpdir(), `stdd-worker-destination-${Date.now()}`);
	const idle = await run(["worker", "create", destination, "--allowed", "src/**"], { cwd: root });
	assert.equal(idle.code, 1);
	assert.match(idle.stderr, /active task/);
	assert.equal(fs.existsSync(destination), false);

	writeLedgerEvents(root, [
		{
			ts: new Date().toISOString(),
			event: "task-start",
			id: "task-preconditions",
			name: "preconditions",
			planBaseline: null,
			branch: "main",
		},
	]);
	const noDocs = await run(["worker", "create", destination, "--allowed", "src/**"], { cwd: root });
	assert.equal(noDocs.code, 1);
	assert.match(noDocs.stderr, /docs decision/);
	const noScope = await run(["worker", "create", destination], { cwd: root });
	assert.equal(noScope.code, 1);
	assert.match(noScope.stderr, /--frozen|--allowed/);
	fs.appendFileSync(
		path.join(root, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "docs",
			decision: "updated-first",
			paths: ["README.md"],
			snapshot: `sha256:${"0".repeat(64)}`,
			reason: "precondition fixture",
			taskId: "task-preconditions",
			branch: "main",
		})}\n`,
	);
	fs.mkdirSync(destination);
	const exists = await run(["worker", "create", destination, "--allowed", "src/**"], { cwd: root });
	assert.equal(exists.code, 1);
	assert.match(exists.stderr, /must not exist/);
	assert.ok(
		fs.statSync(destination).isDirectory(),
		"a destination this process did not create survives",
	);
});

async function createdWorker() {
	const source = await fixture();
	const sandbox = makeTempDir("stdd-worker-parent-");
	fs.rmSync(sandbox, { recursive: true });
	const created = await run(
		["worker", "create", sandbox, "--frozen", "README.md,док/**", "--allowed", "src/**"],
		{
			cwd: source.root,
		},
	);
	assert.equal(created.code, 0, created.stdout + created.stderr);
	return { ...source, sandbox };
}

function nativeBoundaryMutation(opened, predicate, mutate) {
	let fired = false;
	return {
		get fired() {
			return fired;
		},
		openNativeRepoMutation: async (...args) => {
			const context = await openNativeRepoMutation(...args);
			const real = context.session;
			context.session = new Proxy(real, {
				get(target, property) {
					const value = target[property];
					if (typeof value !== "function") return value;
					if (property !== "read") return value.bind(target);
					return async (...operationArgs) => {
						const result = await value.apply(target, operationArgs);
						if (!fired && predicate(result, operationArgs)) {
							fired = true;
							await mutate();
						}
						return result;
					};
				},
			});
			opened.push(context);
			return context;
		},
	};
}

const readsWorkerLedger = (result) =>
	Buffer.from(result.data, "base64").includes(Buffer.from('"event":"task-start"'));

test("worker native publication detects a replaced logical root", async () => {
	const root = makeTempDir("stdd-worker-root-swap-");
	const moved = `${root}-moved`;
	const context = await openNativeRepoMutation(root, "worker root replacement test");
	fs.renameSync(root, moved);
	fs.mkdirSync(root);
	try {
		await assert.rejects(
			writeNewWorkerPath(context, "file.txt", {
				state: { type: "file", mode: 0o644, hash: "unused" },
				bytes: Buffer.from("worker\n"),
			}),
			/root changed|postflight/i,
		);
		assert.equal(fs.existsSync(path.join(root, "file.txt")), false);
		assert.equal(fs.readFileSync(path.join(moved, "file.txt"), "utf8"), "worker\n");
	} finally {
		await context.close();
	}
});

test("worker create makes a bound gitless snapshot and bootstrap ledger", async () => {
	const { root, git } = await fixture();
	const sandbox = path.join(os.tmpdir(), `stdd-worker-sandbox-${Date.now()}`);
	const created = await run(
		["worker", "create", sandbox, "--frozen", "README.md,док/**", "--allowed", "src/**"],
		{ cwd: root },
	);
	assert.equal(created.code, 0, created.stdout + created.stderr);
	assert.match(created.stdout, /gitless worker.*created/i);
	assert.equal(fs.existsSync(path.join(sandbox, ".git")), false);
	assert.equal(fs.existsSync(path.join(sandbox, "ignored", "secret.txt")), false);
	assert.equal(fs.existsSync(path.join(sandbox, ".stdd", "plan.md")), false);
	assert.equal(
		fs.readFileSync(path.join(sandbox, "src", "app.js"), "utf8"),
		"export const value = 2;\n",
	);
	assert.equal(
		fs.readFileSync(path.join(sandbox, "src", "draft.js"), "utf8"),
		"export const draft = true;\n",
	);
	assert.equal(fs.readlinkSync(path.join(sandbox, "src", "current.js")), "app.js");
	assert.equal(fs.statSync(path.join(sandbox, "src", "shared.js")).mode & 0o777, 0o644);

	const metadataBytes = fs.readFileSync(path.join(sandbox, ".stdd", "worker.json"));
	const metadata = JSON.parse(metadataBytes);
	assert.equal(metadata.schema, 2);
	assert.match(metadata.workerId, /^worker-[0-9a-f]{24}$/);
	assert.equal(metadata.source.branch, "feature");
	assert.equal(metadata.source.head, (await git("rev-parse", "HEAD")).stdout.trim());
	assert.equal(metadata.source.taskId, ledger(root).find((event) => event.event === "task-start").id);
	assert.deepEqual(metadata.scope, {
		frozenPaths: ["README.md", "док/**"],
		allowedPaths: ["src/**"],
	});
	assert.ok(Object.hasOwn(metadata.baseline.files, "src/app.js"));
	assert.deepEqual(Object.keys(metadata.baseline.files["src/app.js"].portable), ["source", "sandbox"]);
	assert.equal(metadata.baseline.files["src/current.js"].targetBase64, "YXBwLmpz");
	assert.equal(Object.hasOwn(metadata.baseline.files, "ignored/secret.txt"), false);

	const sourceEvent = ledger(root).find((event) => event.event === "worker-create");
	assert.equal(sourceEvent.workerId, metadata.workerId);
	assert.match(sourceEvent.metadataHash, /^sha256:[0-9a-f]{64}$/);
	const workerEvents = ledger(sandbox);
	assert.deepEqual(
		workerEvents.map((event) => event.event),
		["task-start", "docs", "scope"],
	);
	assert.ok(workerEvents.every((event) => event.branch === "feature"));
});

test("metadata v1 remains readable alongside the additive portable schema", () => {
	const legacy = {
		schema: 1,
		workerId: "worker-000000000000000000000000",
		source: {
			root: "/tmp/source",
			branch: "feature",
			taskId: "task-legacy",
			taskName: "legacy worker",
			head: "0123456789abcdef",
		},
		scope: { frozenPaths: [], allowedPaths: ["src/**"] },
		baseline: {
			files: {
				"src/file.js": { type: "file", hash: `sha256:${"0".repeat(64)}`, mode: 0o664 },
			},
		},
	};
	assert.equal(
		parseWorkerMetadata(JSON.stringify(legacy), "/tmp/worker", "/tmp/worker/.stdd/worker.json").schema,
		1,
	);
});

test("schema-v1 collection deletes and replaces 0664 baselines recoverably and idempotently", async () => {
	const { root, sandbox } = await createdWorker();
	const metadataPath = path.join(sandbox, ".stdd", "worker.json");
	const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
	metadata.schema = 1;
	for (const state of Object.values(metadata.baseline.files)) {
		if (state === null) continue;
		delete state.portable;
		if (state.type === "symlink") delete state.targetBase64;
	}
	metadata.baseline.files["src/shared.js"].mode = 0o664;
	metadata.baseline.files["src/app.js"].mode = 0o664;
	fs.chmodSync(path.join(root, "src", "shared.js"), 0o664);
	fs.chmodSync(path.join(sandbox, "src", "shared.js"), 0o664);
	fs.chmodSync(path.join(root, "src", "app.js"), 0o664);
	fs.chmodSync(path.join(sandbox, "src", "app.js"), 0o664);
	const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
	fs.writeFileSync(metadataPath, metadataBytes, { mode: 0o600 });
	const sourceEvents = ledger(root);
	const binding = sourceEvents.find((event) => event.event === "worker-create");
	binding.metadataHash = sha256(metadataBytes);
	fs.writeFileSync(
		path.join(root, ".stdd", "ledger.jsonl"),
		`${sourceEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
		{ mode: 0o600 },
	);

	fs.rmSync(path.join(sandbox, "src", "shared.js"));
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), "retained legacy replacement\n", {
		mode: 0o664,
	});
	fs.chmodSync(path.join(sandbox, "src", "app.js"), 0o664);
	const context = await openNativeRepoMutation(root, "legacy worker recovery setup");
	const expected = await readNativeWorkerPath(context, "src/app.js", { legacyMode: 0o664 });
	await quarantineWorkerDeletion(
		context,
		"src/app.js",
		metadata.workerId,
		expected.state,
		expected.observation,
		null,
		"src/app.js",
		0o664,
	);
	await context.close();

	await workerCollect(root, sandbox);
	assert.equal(
		fs.readFileSync(path.join(root, "src", "app.js"), "utf8"),
		"retained legacy replacement\n",
	);
	assert.equal(fs.statSync(path.join(root, "src", "app.js")).mode & 0o777, 0o664);
	assert.equal(fs.existsSync(path.join(root, "src", "shared.js")), false);
	await workerCollect(root, sandbox);
	assert.equal(fs.statSync(path.join(root, "src", "app.js")).mode & 0o777, 0o664);
	fs.chmodSync(path.join(sandbox, "src", "app.js"), 0o755);
	await assert.rejects(workerCollect(root, sandbox), /unsupported creation mode|exact inherited/i);
	assert.equal(fs.statSync(path.join(root, "src", "app.js")).mode & 0o777, 0o664);
});

test("worker publication cannot set a mode different from the inherited v1 baseline", async () => {
	await assert.rejects(
		publishWorkerFile(
			{},
			"src/app.js",
			Buffer.from("sandbox-selected mode\n"),
			0o755,
			null,
			null,
			"worker-000000000000000000000000",
			0o664,
		),
		/exact inherited legacy mode/,
	);
});

test("unsupported source modes fail complete create preflight", async () => {
	const { root } = await fixture();
	fs.chmodSync(path.join(root, "src", "shared.js"), 0o664);
	const destination = path.join(os.tmpdir(), `stdd-worker-unsupported-mode-${Date.now()}`);
	const result = await run(["worker", "create", destination, "--allowed", "src/**"], { cwd: root });
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /unsupported mode 0664.*0600.*0644.*0755/i);
	assert.equal(fs.existsSync(destination), false, "unsupported mode fails before destination mutation");
});

test("worker create preflights destination-parent symlink capability only for symlink snapshots", async () => {
	{
		const { root } = await fixture();
		const destination = path.join(os.tmpdir(), `stdd-worker-create-symlink-${Date.now()}`);
		let fired = false;
		const openMutation = async (...args) => {
			const context = await openNativeRepoMutation(...args);
			const real = context.session;
			context.session = new Proxy(real, {
				get(target, property) {
					const value = target[property];
					if (typeof value !== "function") return value;
					if (property !== "preflightSymlink") return value.bind(target);
					return async () => {
						fired = true;
						const error = new Error("injected missing Windows create symlink capability");
						error.code = "symlink-privilege-or-developer-mode-required";
						error.mutation = "none";
						throw error;
					};
				},
			});
			return context;
		};
		await assert.rejects(
			workerCreate(root, destination, ["README.md"], ["src/**"], {
				openNativeRepoMutation: openMutation,
			}),
			/missing Windows create symlink capability/,
		);
		assert.equal(fired, true);
		assert.equal(fs.existsSync(destination), false);
	}
	{
		const { root, git } = await fixture();
		await git("rm", "src/current.js");
		await git("commit", "-qm", "regular-only snapshot");
		const destination = path.join(os.tmpdir(), `stdd-worker-create-regular-${Date.now()}`);
		let called = false;
		const openMutation = async (...args) => {
			const context = await openNativeRepoMutation(...args);
			const real = context.session;
			context.session = new Proxy(real, {
				get(target, property) {
					const value = target[property];
					if (typeof value !== "function") return value;
					if (property !== "preflightSymlink") return value.bind(target);
					return async () => {
						called = true;
						throw new Error("regular-only create must not preflight symlinks");
					};
				},
			});
			return context;
		};
		await workerCreate(root, destination, ["README.md"], ["src/**"], {
			openNativeRepoMutation: openMutation,
		});
		assert.equal(called, false);
		assert.equal(fs.existsSync(destination), true);
		fs.rmSync(destination, { recursive: true });
	}
});

test("gitless workers record local evidence and enforce manifest scope", async () => {
	const { sandbox } = await createdWorker();
	fs.mkdirSync(path.join(sandbox, "node_modules", "dependency"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, "node_modules", "dependency", "index.js"), "generated\n");
	fs.mkdirSync(path.join(sandbox, "node_modules", "dependency", ".git"));
	fs.writeFileSync(path.join(sandbox, "node_modules", "dependency", ".git", "config"), "ignored\n");
	fs.mkdirSync(path.join(sandbox, "dist"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, "dist", "ignored.js"), "generated\n");
	fs.mkdirSync(path.join(sandbox, "src", "dist"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, "src", "dist", "collected.js"), "in scope\n");
	const ignoredReadiness = await run(["scope"], { cwd: sandbox });
	assert.equal(ignoredReadiness.code, 0, ignoredReadiness.stdout + ignoredReadiness.stderr);
	assert.match(ignoredReadiness.stdout, /1 worker change/);
	const subdirectoryScope = await run(["scope"], { cwd: path.join(sandbox, "src") });
	assert.equal(subdirectoryScope.code, 0, subdirectoryScope.stdout + subdirectoryScope.stderr);
	assert.match(subdirectoryScope.stdout, /1 worker change/);
	const status = await run(["status", "--local", "--json"], { cwd: sandbox });
	assert.equal(status.code, 0, status.stdout + status.stderr);
	assert.equal(JSON.parse(status.stdout).task.name, "worker fixture");
	const readiness = await run(["doctor", "--readiness"], { cwd: sandbox });
	assert.equal(readiness.code, 0, readiness.stdout + readiness.stderr);

	appendWorkerEvidence(sandbox, ["red", "verify", { note: "worker handoff" }]);

	fs.writeFileSync(path.join(sandbox, "src", "app.js"), "export const value = 3;\n");
	const allowed = await run(["scope"], { cwd: sandbox });
	assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
	fs.writeFileSync(path.join(sandbox, "README.md"), "# forbidden\n");
	const frozen = await run(["scope"], { cwd: sandbox });
	assert.equal(frozen.code, 1);
	assert.match(frozen.stderr, /README\.md.*frozen/);

	for (const command of [
		["task", "finish"],
		["docs", "updated-first", "README.md"],
		["slice", "new", "--allowed", "src/**"],
		["worker", "create", `${sandbox}-nested`, "--allowed", "src/**"],
		["review", "--via", "claude"],
		["evidence", "--base", "HEAD"],
	]) {
		const rejected = await run(command, { cwd: sandbox });
		assert.equal(rejected.code, 1, `${command.join(" ")}: ${rejected.stdout}${rejected.stderr}`);
		assert.match(rejected.stderr, /source checkout|gitless worker/i, command.join(" "));
	}
});

test("worker deletion quarantine is private, inventoried, and idempotent", async () => {
	const root = makeTempDir("stdd-worker-native-quarantine-");
	fs.writeFileSync(path.join(root, "victim.txt"), "preserved\n", { mode: 0o644 });
	const workerId = "worker-000000000000000000000000";
	const context = await openNativeRepoMutation(root, "worker quarantine test");
	try {
		const expected = await readNativeWorkerPath(context, "victim.txt", { bytes: true });
		await quarantineWorkerDeletion(
			context,
			"victim.txt",
			workerId,
			expected.state,
			expected.observation,
		);
		assert.equal(fs.existsSync(path.join(root, "victim.txt")), false);
		const workerRoot = path.join(root, ".stdd", "worker-deletions", workerId);
		assert.equal(fs.statSync(workerRoot).mode & 0o777, 0o700);
		const retained = path.join(workerRoot, fs.readdirSync(workerRoot)[0]);
		assert.equal(fs.statSync(retained).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(retained, "inventory.json")).mode & 0o777, 0o600);
		assert.equal(fs.readFileSync(path.join(retained, "payload"), "utf8"), "preserved\n");
		fs.writeFileSync(path.join(workerRoot, "unknown-sibling"), "operator-owned\n");
		const inventory = await workerQuarantineInventory(context, [workerId]);
		assert.equal(inventory.length, 1);
		assert.equal(fs.readFileSync(path.join(workerRoot, "unknown-sibling"), "utf8"), "operator-owned\n");
		for (const ancestor of [path.join(root, ".stdd", "worker-deletions"), workerRoot]) {
			fs.chmodSync(ancestor, 0o755);
			await assert.rejects(
				workerQuarantineInventory(context, [workerId]),
				/ancestor.*owner-private|private-permissions-required/i,
			);
			fs.chmodSync(ancestor, 0o700);
		}
		const inventoryPath = path.join(retained, "inventory.json");
		const exactInventory = fs.readFileSync(inventoryPath, "utf8");
		const malformed = { ...JSON.parse(exactInventory), extra: true };
		fs.writeFileSync(inventoryPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
		await assert.rejects(
			readWorkerDeletionQuarantineState(context, "victim.txt", workerId),
			/exact provenance schema/i,
		);
		fs.writeFileSync(inventoryPath, exactInventory, { mode: 0o600 });
		const interruptedPayload = path.join(retained, "payload.interrupted");
		fs.renameSync(path.join(retained, "payload"), interruptedPayload);
		assert.deepEqual(await workerQuarantineInventory(context, [workerId]), []);
		fs.renameSync(interruptedPayload, path.join(retained, "payload"));
		await quarantineWorkerDeletion(
			context,
			"victim.txt",
			workerId,
			expected.state,
			expected.observation,
		);
	} finally {
		await context.close();
	}
});

test("worker quarantine preflight rejects a symlinked recognized ancestor", async () => {
	const root = makeTempDir("stdd-worker-quarantine-symlink-");
	fs.mkdirSync(path.join(root, ".stdd"), { mode: 0o700 });
	fs.mkdirSync(path.join(root, "outside"), { mode: 0o700 });
	fs.symlinkSync(path.join(root, "outside"), path.join(root, ".stdd", "worker-deletions"));
	const context = await openNativeRepoMutation(root, "worker quarantine symlink test");
	try {
		await assert.rejects(
			preflightPrivateWorkerQuarantine(context, "victim.txt", "worker-000000000000000000000000"),
			/symlink|unsafe/i,
		);
		assert.equal(fs.existsSync(path.join(root, "outside", "worker-000000000000000000000000")), false);
	} finally {
		await context.close();
	}
});

test("worker collect publishes root files, symlinks, and deletions through a held root", async () => {
	const { root } = await fixture();
	const sandbox = makeTempDir("stdd-worker-root-parent-");
	fs.rmSync(sandbox, { recursive: true });
	const created = await run(
		["worker", "create", sandbox, "--allowed", "README.md,root-draft.txt,root-link"],
		{ cwd: root },
	);
	assert.equal(created.code, 0, created.stdout + created.stderr);
	fs.writeFileSync(path.join(sandbox, "README.md"), "# Collected root\n");
	fs.rmSync(path.join(sandbox, "root-draft.txt"));
	fs.symlinkSync("README.md", path.join(sandbox, "root-link"));
	const collected = await run(["worker", "collect", sandbox], { cwd: root });
	assert.equal(collected.code, 0, collected.stdout + collected.stderr);
	assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "# Collected root\n");
	assert.equal(fs.existsSync(path.join(root, "root-draft.txt")), false);
	assert.equal(fs.readlinkSync(path.join(root, "root-link")), "README.md");
});

test("worker collect imports scoped files and evidence idempotently without changing Git history", async () => {
	const { root, git, sandbox } = await createdWorker();
	const gitBefore = fs.statSync(path.join(root, ".git"));
	const headBefore = (await git("rev-parse", "HEAD")).stdout.trim();
	appendWorkerEvidence(sandbox, ["red", "verify", { note: "collected handoff" }]);
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), "export const value = 4;\n");
	fs.writeFileSync(path.join(sandbox, "src", "new.js"), "export const added = true;\n");
	fs.rmSync(path.join(sandbox, "src", "draft.js"));
	fs.unlinkSync(path.join(sandbox, "src", "current.js"));
	fs.symlinkSync("new.js", path.join(sandbox, "src", "current.js"));
	// Simulate an interrupted prior collection: one path is already final while
	// the addition and deletion remain at their baseline states.
	fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 4;\n");

	const collected = await run(["worker", "collect", sandbox], { cwd: root });
	assert.equal(collected.code, 0, collected.stdout + collected.stderr);
	assert.match(collected.stdout, /3 file change.*3 evidence/i);
	assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "export const value = 4;\n");
	assert.equal(
		fs.readFileSync(path.join(root, "src", "new.js"), "utf8"),
		"export const added = true;\n",
	);
	assert.equal(fs.existsSync(path.join(root, "src", "draft.js")), false);
	assert.equal(fs.readlinkSync(path.join(root, "src", "current.js")), "new.js");
	assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), headBefore);
	const gitAfter = fs.statSync(path.join(root, ".git"));
	assert.equal(gitAfter.dev, gitBefore.dev);
	assert.equal(gitAfter.ino, gitBefore.ino);
	const quarantine = path.join(root, ".stdd", "worker-deletions");
	assert.ok(fs.existsSync(quarantine));
	const workerQuarantine = path.join(quarantine, fs.readdirSync(quarantine)[0]);
	assert.equal(fs.statSync(quarantine).mode & 0o777, 0o700);
	assert.equal(fs.statSync(workerQuarantine).mode & 0o777, 0o700);
	assert.equal(
		(await git("check-ignore", ".stdd/worker-deletions")).stdout.trim(),
		".stdd/worker-deletions",
	);
	const imported = ledger(root).filter((event) => ["red", "verify", "note"].includes(event.event));
	assert.deepEqual(
		imported.map((event) => event.event),
		["red", "verify", "note"],
	);
	assert.ok(imported.every((event) => !Object.hasOwn(event, "snapshot")));
	const parentStatus = await run(["status", "--local", "--json"], { cwd: root });
	assert.equal(parentStatus.code, 0, parentStatus.stdout + parentStatus.stderr);
	assert.equal(JSON.parse(parentStatus.stdout).loop.verify.done, false);

	const repeated = await run(["worker", "collect", sandbox], { cwd: root });
	assert.equal(repeated.code, 0, repeated.stdout + repeated.stderr);
	assert.match(repeated.stdout, /already collected|0 file change/i);
	assert.equal(
		ledger(root).filter((event) => ["red", "verify", "note"].includes(event.event)).length,
		3,
	);
});

test("worker collect fails closed before import on binding, scope, conflict, Git, and file hazards", async () => {
	{
		const { sandbox } = await createdWorker();
		fs.writeFileSync(path.join(sandbox, ".stdd", "worker.json"), "{}\n");
		const result = await run(["status", "--local"], { cwd: sandbox });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /^stdd: invalid managed worker metadata schema/m);
		assert.doesNotMatch(result.stderr, /at .*stdd\.mjs/);
	}
	{
		const { root, sandbox } = await createdWorker();
		const metadataPath = path.join(sandbox, ".stdd", "worker.json");
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
		metadata.scope.allowedPaths = ["**"];
		fs.writeFileSync(metadataPath, JSON.stringify(metadata));
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /metadata.*hash|binding/i);
	}
	{
		const { root, sandbox } = await createdWorker();
		fs.writeFileSync(
			path.join(root, ".gitignore"),
			fs.readFileSync(path.join(root, ".gitignore"), "utf8").replace(".stdd/worker-deletions/\n", ""),
		);
		fs.rmSync(path.join(sandbox, "src", "draft.js"));
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /quarantine.*not Git-ignored/i);
	}
	{
		const { root, sandbox } = await createdWorker();
		fs.writeFileSync(path.join(sandbox, "README.md"), "forbidden\n");
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /frozen|scope/i);
	}
	{
		const { root, sandbox } = await createdWorker();
		fs.writeFileSync(path.join(sandbox, "док", "info.md"), "forbidden unicode\n");
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /док\/info\.md.*frozen/i);
	}
	{
		const { root, sandbox } = await createdWorker();
		const hostile = "forged\n\u001b[31m.js";
		fs.writeFileSync(path.join(sandbox, "src", hostile), "worker\n");
		fs.writeFileSync(path.join(root, "src", hostile), "orchestrator\n");
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.equal(result.stderr.includes(`forged\n${String.fromCharCode(0x1b)}`), false);
		assert.match(result.stderr, /forged(?:\\n|\\u000a)\\u001b\[31m\.js/);
	}
	{
		const { root, sandbox } = await createdWorker();
		fs.writeFileSync(path.join(sandbox, "src", "app.js"), "worker\n");
		fs.writeFileSync(path.join(sandbox, "src", "new.js"), "must not import\n");
		fs.writeFileSync(path.join(root, "src", "app.js"), "orchestrator\n");
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /conflict.*src\/app\.js/i);
		assert.equal(fs.existsSync(path.join(root, "src", "new.js")), false);
	}
	{
		const { root, sandbox } = await createdWorker();
		fs.mkdirSync(path.join(sandbox, "nested", ".git"), { recursive: true });
		fs.writeFileSync(path.join(sandbox, "nested", ".git", "config"), "unsafe\n");
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /must not contain \.git/i);
	}
	if (process.platform !== "win32") {
		const { root, sandbox } = await createdWorker();
		const fifo = path.join(sandbox, "src", "unsafe-fifo");
		await exec("mkfifo", [fifo]);
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /regular file or symlink|unsafe file/i);
	}
});

test("worker publication refuses a target that no longer matches preflight", async () => {
	const root = makeTempDir("stdd-worker-publication-state-");
	fs.writeFileSync(path.join(root, "file.txt"), "baseline\n");
	const context = await openNativeRepoMutation(root, "worker publication race test");
	try {
		const expectedFile = (await readNativeWorkerPath(context, "file.txt")).state;
		fs.writeFileSync(path.join(root, "file.txt"), "concurrent\n");
		await assert.rejects(
			publishWorkerFile(context, "file.txt", Buffer.from("worker\n"), 0o644, expectedFile),
			/changed after preflight/,
		);
		assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "concurrent\n");

		fs.symlinkSync("baseline", path.join(root, "link"));
		const expectedLink = (await readNativeWorkerPath(context, "link")).state;
		fs.unlinkSync(path.join(root, "link"));
		fs.symlinkSync("concurrent", path.join(root, "link"));
		await assert.rejects(
			publishWorkerSymlink(
				context,
				"link",
				expectedLink,
				"worker-000000000000000000000000",
				expectedLink,
			),
			/changed after preflight/,
		);
		assert.equal(fs.readlinkSync(path.join(root, "link")), "concurrent");
	} finally {
		await context.close();
	}
});

test("worker mutation context fails before creating destination or quarantine parents", async () => {
	const root = makeTempDir("stdd-worker-parent-preflight-");
	fs.writeFileSync(path.join(root, "victim.txt"), "baseline\n");
	const context = await openNativeRepoMutation(root, "worker parent preflight test");
	try {
		let publicationCheck = false;
		await assert.rejects(
			publishWorkerFile(
				context,
				"missing/parent/result.txt",
				Buffer.from("worker\n"),
				0o644,
				null,
				() => {
					publicationCheck = true;
					throw new Error("injected publication context drift");
				},
			),
			/publication context drift/,
		);
		assert.equal(publicationCheck, true);
		assert.equal(fs.existsSync(path.join(root, "missing")), false);

		const victim = await readNativeWorkerPath(context, "victim.txt");
		let quarantineCheck = false;
		await assert.rejects(
			quarantineWorkerDeletion(
				context,
				"victim.txt",
				"worker-000000000000000000000000",
				victim.state,
				victim.observation,
				() => {
					quarantineCheck = true;
					throw new Error("injected quarantine context drift");
				},
			),
			/quarantine context drift/,
		);
		assert.equal(quarantineCheck, true);
		assert.equal(fs.readFileSync(path.join(root, "victim.txt"), "utf8"), "baseline\n");
		assert.equal(fs.existsSync(path.join(root, ".stdd")), false);
	} finally {
		await context.close();
	}
});

test("worker collection preflights symlink capability before source mutation and skips it for regular-only changes", async () => {
	{
		const { root, sandbox } = await createdWorker();
		fs.unlinkSync(path.join(sandbox, "src", "current.js"));
		fs.symlinkSync("shared.js", path.join(sandbox, "src", "current.js"));
		let fired = false;
		const openMutation = async (...args) => {
			const context = await openNativeRepoMutation(...args);
			const real = context.session;
			context.session = new Proxy(real, {
				get(target, property) {
					const value = target[property];
					if (typeof value !== "function") return value;
					if (property !== "preflightSymlink") return value.bind(target);
					return async () => {
						fired = true;
						const error = new Error("injected missing Windows symlink capability");
						error.code = "symlink-privilege-or-developer-mode-required";
						error.mutation = "none";
						throw error;
					};
				},
			});
			return context;
		};
		await assert.rejects(
			workerCollect(root, sandbox, { openNativeRepoMutation: openMutation }),
			/missing Windows symlink capability/,
		);
		assert.equal(fired, true, "symlink capability preflight fired");
		assert.equal(fs.readlinkSync(path.join(root, "src", "current.js")), "app.js");
		assert.equal(fs.existsSync(path.join(root, ".stdd", "worker-deletions")), false);
	}
	{
		const { root, sandbox } = await createdWorker();
		fs.writeFileSync(path.join(sandbox, "src", "regular.js"), "regular\n");
		let called = false;
		const openMutation = async (...args) => {
			const context = await openNativeRepoMutation(...args);
			const real = context.session;
			context.session = new Proxy(real, {
				get(target, property) {
					const value = target[property];
					if (typeof value !== "function") return value;
					if (property !== "preflightSymlink") return value.bind(target);
					return async () => {
						called = true;
						throw new Error("regular-only collection must not require symlink capability");
					};
				},
			});
			return context;
		};
		await workerCollect(root, sandbox, { openNativeRepoMutation: openMutation });
		assert.equal(called, false);
		assert.equal(fs.readFileSync(path.join(root, "src", "regular.js"), "utf8"), "regular\n");
	}
});

test("worker path reads reject an in-place write after descriptor content was read", () => {
	const root = makeTempDir("stdd-worker-in-place-read-");
	const target = path.join(root, "file.txt");
	fs.writeFileSync(target, "baseline\n");
	const original = fs.readFileSync;
	fs.readFileSync = function (subject, ...args) {
		const content = original.call(this, subject, ...args);
		if (String(subject) === target) {
			fs.writeFileSync(target, "changed!\n");
			const future = new Date(Date.now() + 10_000);
			fs.utimesSync(target, future, future);
		}
		return content;
	};
	try {
		assert.throws(() => readWorkerPathState(root, "file.txt"), /changed while reading/);
	} finally {
		fs.readFileSync = original;
	}
});

test("worker collect rechecks an already-final path before reporting success", async () => {
	const { root, sandbox } = await createdWorker();
	const final = "export const value = 9;\n";
	const sharedFinal = "export const shared = 9;\n";
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), final);
	fs.writeFileSync(path.join(root, "src", "app.js"), final);
	fs.writeFileSync(path.join(sandbox, "src", "shared.js"), sharedFinal);
	fs.writeFileSync(path.join(root, "src", "shared.js"), sharedFinal);
	const opened = [];
	const boundary = nativeBoundaryMutation(opened, readsWorkerLedger, () => {
		fs.writeFileSync(path.join(root, "src", "app.js"), "concurrent third state\n");
	});
	await assert.rejects(
		workerCollect(root, sandbox, { openNativeRepoMutation: boundary.openNativeRepoMutation }),
		/conflict.*src\/app\.js|final source state changed/i,
	);
	assert.equal(boundary.fired, true, "the NativeFsSession read boundary injection fired");
	assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "concurrent third state\n");
	assert.equal(fs.readFileSync(path.join(root, "src", "shared.js"), "utf8"), sharedFinal);
});

test("worker collect stops evidence publication when a final path drifts during ledger staging", async () => {
	const { root, sandbox } = await createdWorker();
	const final = "export const value = 12;\n";
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), final);
	fs.writeFileSync(path.join(root, "src", "app.js"), final);
	appendWorkerEvidence(sandbox, [{ note: "must-not-commit-after-path-drift" }]);
	let fired = false;
	const openMutation = async (...args) => {
		const context = await openNativeRepoMutation(...args);
		const real = context.session;
		context.session = new Proxy(real, {
			get(target, property) {
				const value = target[property];
				if (typeof value !== "function") return value;
				if (property !== "createFile") return value.bind(target);
				return async (...operationArgs) => {
					const result = await value.apply(target, operationArgs);
					if (!fired && /^\.ledger-reset-/.test(operationArgs[1])) {
						fired = true;
						fs.writeFileSync(path.join(root, "src", "app.js"), "concurrent third state\n");
					}
					return result;
				};
			},
		});
		return context;
	};
	await assert.rejects(
		workerCollect(root, sandbox, { openNativeRepoMutation: openMutation }),
		/final source state changed|conflict.*src\/app\.js/i,
	);
	assert.equal(fired, true, "the ledger staging injection fired");
	assert.equal(
		ledger(root).some((event) => event.note === "must-not-commit-after-path-drift"),
		false,
	);
});

test("worker collect resumes a replacement after its baseline reached quarantine", async () => {
	const { root, sandbox } = await createdWorker();
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), "worker replacement\n");
	const metadata = JSON.parse(fs.readFileSync(path.join(sandbox, ".stdd", "worker.json"), "utf8"));
	const context = await openNativeRepoMutation(root, "worker interrupted collection setup");
	const expected = await readNativeWorkerPath(context, "src/app.js");
	await quarantineWorkerDeletion(
		context,
		"src/app.js",
		metadata.workerId,
		expected.state,
		expected.observation,
	);
	await context.close();
	assert.equal(fs.existsSync(path.join(root, "src", "app.js")), false);

	const result = await run(["worker", "collect", sandbox], { cwd: root });
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "worker replacement\n");
});

test("worker publication never overwrites a target created at the native rename boundary", async () => {
	const root = makeTempDir("stdd-worker-no-replace-");
	const context = await openNativeRepoMutation(root, "worker no-replace test");
	const real = context.session;
	let fired = false;
	context.session = new Proxy(real, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function") return value;
			if (property !== "rename") return value.bind(target);
			return async (options) => {
				if (!fired) {
					fired = true;
					const competing = await target.createFile(options.toParent, options.to, 0o644);
					await target.flush(options.toParent, "namespace", context.root.observation.identity);
					await target.closeCapability(competing.cap);
				}
				return value.call(target, options);
			};
		},
	});
	try {
		await assert.rejects(
			publishWorkerFile(context, "result.txt", Buffer.from("worker\n"), 0o644, null),
			/identity-conflict|rename/i,
		);
		assert.equal(fs.readFileSync(path.join(root, "result.txt")).length, 0);
	} finally {
		await context.close();
	}
});

test("worker native proxy faults preserve unknown outcomes and committed rename recovery", async () => {
	for (const [operation, mode, inheritedLegacyMode] of [
		["createFile", 0o644, null],
		["write", 0o644, null],
		["truncate", 0o644, null],
		["flush", 0o644, null],
		["setMode", 0o664, 0o664],
	]) {
		const root = makeTempDir(`stdd-worker-${operation}-fault-`);
		const context = await openNativeRepoMutation(root, `worker ${operation} fault test`);
		const real = context.session;
		let armed = true;
		context.session = new Proxy(real, {
			get(target, property) {
				const value = target[property];
				if (typeof value !== "function") return value;
				if (property !== operation) return value.bind(target);
				return async (...args) => {
					const result = await value.apply(target, args);
					if (armed) {
						armed = false;
						const error = new Error(`injected ${operation} fault`);
						error.code = "injected-fault";
						error.mutation = operation === "createFile" ? "committed" : "possible";
						throw error;
					}
					return result;
				};
			},
		});
		try {
			await assert.rejects(
				publishWorkerFile(
					context,
					"result.txt",
					Buffer.from("worker\n"),
					mode,
					null,
					null,
					"worker-000000000000000000000000",
					inheritedLegacyMode,
				),
				/injected|quarantined/i,
			);
			assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
			armed = true;
			await assert.rejects(
				publishWorkerFile(
					context,
					"result.txt",
					Buffer.from("worker\n"),
					mode,
					null,
					null,
					"worker-000000000000000000000000",
					inheritedLegacyMode,
				),
				/injected|quarantined/i,
			);
			await publishWorkerFile(
				context,
				"result.txt",
				Buffer.from("worker\n"),
				mode,
				null,
				null,
				"worker-000000000000000000000000",
				inheritedLegacyMode,
			);
			assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8"), "worker\n");
			assert.equal(fs.statSync(path.join(root, "result.txt")).mode & 0o777, mode);
		} finally {
			await context.close();
		}
	}

	const root = makeTempDir("stdd-worker-rename-committed-");
	const context = await openNativeRepoMutation(root, "worker committed rename test");
	const real = context.session;
	let fired = false;
	context.session = new Proxy(real, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function") return value;
			if (property !== "rename") return value.bind(target);
			return async (...args) => {
				const result = await value.apply(target, args);
				if (!fired) {
					fired = true;
					const error = new Error("injected committed rename");
					error.code = "injected-fault";
					error.mutation = "committed";
					throw error;
				}
				return result;
			};
		},
	});
	try {
		await publishWorkerFile(context, "result.txt", Buffer.from("worker\n"), 0o644, null);
		assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8"), "worker\n");
	} finally {
		await context.close();
	}
});

test("worker symlink fingerprints bind readLink raw bytes and fail closed when unpublishable", async (t) => {
	if (process.platform === "win32") return t.skip("raw non-UTF-8 link targets are Unix-only");
	const source = makeTempDir("stdd-worker-link-bytes-");
	fs.symlinkSync(Buffer.from([0xff, 0x62]), path.join(source, "link"));
	const sourceContext = await openNativeRepoMutation(source, "worker raw link source");
	try {
		const result = await readNativeWorkerPath(sourceContext, "link");
		assert.equal(result.state.targetBase64, "/2I=");
		const destination = makeTempDir("stdd-worker-link-bytes-dest-");
		const destinationContext = await openNativeRepoMutation(destination, "worker raw link destination");
		try {
			await assert.rejects(
				writeNewWorkerPath(destinationContext, "link", result),
				/non-UTF-8 target.*cannot publish/i,
			);
			assert.equal(fs.existsSync(path.join(destination, "link")), false);
		} finally {
			await destinationContext.close();
		}
	} finally {
		await sourceContext.close();
	}
});

test("worker collect rechecks source HEAD before importing evidence", async () => {
	const { root, git, sandbox } = await createdWorker();
	appendWorkerEvidence(sandbox, [{ note: "worker-only evidence" }]);
	const opened = [];
	const boundary = nativeBoundaryMutation(opened, readsWorkerLedger, async () => {
		fs.writeFileSync(path.join(root, "head-drift.txt"), "head drift\n");
		await git("add", ".");
		await git("commit", "-qm", "concurrent head");
	});
	await assert.rejects(
		workerCollect(root, sandbox, { openNativeRepoMutation: boundary.openNativeRepoMutation }),
		/HEAD.*changed|bound.*HEAD/i,
	);
	assert.equal(boundary.fired, true, "the NativeFsSession read boundary injection fired");
	assert.equal(
		ledger(root).some((event) => event.note === "worker-only evidence"),
		false,
	);
});

test("worker collect rechecks branch identity after preflight and before publication", async () => {
	const { root, git, sandbox } = await createdWorker();
	fs.writeFileSync(path.join(sandbox, "src", "new.js"), "worker result\n");
	let fired = false;
	const openMutation = async (...args) => {
		const context = await openNativeRepoMutation(...args);
		const real = context.session;
		context.session = new Proxy(real, {
			get(target, property) {
				const value = target[property];
				if (typeof value !== "function") return value;
				if (property !== "write") return value.bind(target);
				return async (...operationArgs) => {
					const result = await value.apply(target, operationArgs);
					if (!fired) {
						fired = true;
						await git("checkout", "-qb", "concurrent-switch");
					}
					return result;
				};
			},
		});
		return context;
	};
	await assert.rejects(
		workerCollect(root, sandbox, { openNativeRepoMutation: openMutation }),
		/branch.*changed|bound.*branch/i,
	);
	assert.equal(fired, true, "the NativeFsSession write boundary injection fired during staging");
	assert.equal(fs.existsSync(path.join(root, "src", "new.js")), false);
});

test("managed-worker restrictions survive a nested Git boundary", async () => {
	const { sandbox } = await createdWorker();
	const nested = path.join(sandbox, "ignored", "dependency");
	fs.mkdirSync(nested, { recursive: true });
	await exec("git", ["-C", nested, "init", "-q"]);
	const result = await run(["task", "finish"], { cwd: nested });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /source checkout|gitless worker/i);
});

test("worker collect requires the bound source task branch and HEAD", async () => {
	{
		const { root, git, sandbox } = await createdWorker();
		await git("checkout", "main");
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /branch.*changed|bound.*branch/i);
	}
	{
		const { root, git, sandbox } = await createdWorker();
		fs.writeFileSync(path.join(root, "head-drift.txt"), "drift\n");
		await git("add", "head-drift.txt");
		await git("commit", "-qm", "head drift");
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /HEAD.*changed|bound.*HEAD/i);
	}
	{
		const { root, sandbox } = await createdWorker();
		fs.appendFileSync(
			path.join(root, ".stdd", "ledger.jsonl"),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				event: "task-finish",
				id: "task-worker-fixture",
				taskId: "task-worker-fixture",
				branch: "feature",
			})}\n`,
		);
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /active task|task.*changed/i);
	}
});
