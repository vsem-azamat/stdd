import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openOrCreateHeldGeneratedParent } from "../cli/held-fs.mjs";
import { parseLedger } from "../cli/lib.mjs";
import {
	publishWorkerFile,
	publishWorkerSymlink,
	quarantineWorkerDeletion,
	readWorkerPathState,
} from "../cli/worker-fs.mjs";

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

async function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-source-"));
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
	fs.chmodSync(path.join(root, "src", "shared.js"), 0o664);
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
	assert.equal((await run(["task", "start", "worker fixture"], { cwd: root })).code, 0);
	assert.equal((await run(["docs", "updated-first", "README.md"], { cwd: root })).code, 0);
	return { root, git };
}

function ledger(directory) {
	return parseLedger(fs.readFileSync(path.join(directory, ".stdd", "ledger.jsonl"), "utf8"));
}

test("worker create requires an active task, docs decision, scope, and absent destination", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-preconditions-"));
	await exec("git", ["-C", root, "init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
	await exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
	await exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
	const destination = path.join(os.tmpdir(), `stdd-worker-destination-${Date.now()}`);
	const idle = await run(["worker", "create", destination, "--allowed", "src/**"], { cwd: root });
	assert.equal(idle.code, 1);
	assert.match(idle.stderr, /active task/);
	assert.equal(fs.existsSync(destination), false);

	await run(["task", "start", "preconditions"], { cwd: root });
	const noDocs = await run(["worker", "create", destination, "--allowed", "src/**"], { cwd: root });
	assert.equal(noDocs.code, 1);
	assert.match(noDocs.stderr, /docs decision/);
	const noScope = await run(["worker", "create", destination], { cwd: root });
	assert.equal(noScope.code, 1);
	assert.match(noScope.stderr, /--frozen|--allowed/);
	await run(["docs", "updated-first", "README.md"], { cwd: root });
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
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-parent-"));
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

test("worker create cannot be redirected by replacing its destination parent at mkdir", async () => {
	const { root } = await fixture();
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-parent-swap-"));
	const movedParent = `${parent}-moved`;
	const destination = path.join(parent, "sandbox");
	const hookPath = path.join(root, "worker-parent-swap-hook.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";\nimport path from "node:path";\nconst original = fs.mkdirSync;\nlet fired = false;\nfs.mkdirSync = function (target, options) {\n  if (!fired && path.basename(String(target)) === "sandbox") {\n    fired = true;\n    fs.renameSync(process.env.STDD_TEST_PARENT, process.env.STDD_TEST_MOVED_PARENT);\n    original.call(this, process.env.STDD_TEST_PARENT);\n  }\n  return original.call(this, target, options);\n};\n`,
	);
	const result = await run(["worker", "create", destination, "--allowed", "src/**"], {
		cwd: root,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			STDD_TEST_PARENT: parent,
			STDD_TEST_MOVED_PARENT: movedParent,
		},
	});
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /destination parent.*changed|partial sandbox/i);
	assert.equal(fs.existsSync(destination), false, "the replacement parent receives no sandbox");
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
	assert.equal(fs.statSync(path.join(sandbox, "src", "shared.js")).mode & 0o777, 0o664);

	const metadataBytes = fs.readFileSync(path.join(sandbox, ".stdd", "worker.json"));
	const metadata = JSON.parse(metadataBytes);
	assert.equal(metadata.schema, 1);
	assert.match(metadata.workerId, /^worker-[0-9a-f]{24}$/);
	assert.equal(metadata.source.branch, "feature");
	assert.equal(metadata.source.head, (await git("rev-parse", "HEAD")).stdout.trim());
	assert.equal(metadata.source.taskId, ledger(root).find((event) => event.event === "task-start").id);
	assert.deepEqual(metadata.scope, {
		frozenPaths: ["README.md", "док/**"],
		allowedPaths: ["src/**"],
	});
	assert.ok(Object.hasOwn(metadata.baseline.files, "src/app.js"));
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

	const red = await run(["red", "--", process.execPath, "-e", "process.exit(1)"], {
		cwd: sandbox,
	});
	assert.equal(red.code, 1);
	const verify = await run(["verify", "--", process.execPath, "-e", "process.exit(0)"], {
		cwd: sandbox,
	});
	assert.equal(verify.code, 0, verify.stdout + verify.stderr);
	assert.equal((await run(["note", "worker handoff"], { cwd: sandbox })).code, 0);

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

test("held directory creation applies a private mode from the first inode", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-private-parent-"));
	const held = openOrCreateHeldGeneratedParent(root, ".stdd/worker-deletions", 0o700);
	try {
		assert.equal(fs.statSync(path.join(root, ".stdd")).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(root, ".stdd", "worker-deletions")).mode & 0o777, 0o700);
	} finally {
		fs.closeSync(held.descriptor);
	}
});

test("failed deletion quarantine setup closes every held descriptor", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-quarantine-fd-"));
	fs.mkdirSync(path.join(root, ".stdd"));
	fs.writeFileSync(path.join(root, ".stdd", "worker-deletions"), "unsafe parent\n");
	fs.writeFileSync(path.join(root, "victim.txt"), "preserved\n");
	const before = fs.readdirSync("/proc/self/fd").length;
	for (let index = 0; index < 20; index++) {
		assert.throws(
			() => quarantineWorkerDeletion(root, "victim.txt", "worker-000000000000000000000000", null),
			/symlink or unsafe non-directory/,
		);
	}
	assert.equal(fs.readdirSync("/proc/self/fd").length, before);
});

test("worker collect publishes root files, symlinks, and deletions through a held root", async () => {
	const { root } = await fixture();
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-root-parent-"));
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
	await run(["red", "--", process.execPath, "-e", "process.exit(1)"], { cwd: sandbox });
	await run(["verify", "--", process.execPath, "-e", "process.exit(0)"], { cwd: sandbox });
	await run(["note", "collected handoff"], { cwd: sandbox });
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

test("worker publication refuses a target that no longer matches preflight", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-publication-state-"));
	fs.writeFileSync(path.join(root, "file.txt"), "baseline\n");
	const expectedFile = readWorkerPathState(root, "file.txt").state;
	fs.writeFileSync(path.join(root, "file.txt"), "concurrent\n");
	assert.throws(
		() => publishWorkerFile(root, "file.txt", Buffer.from("worker\n"), 0o644, expectedFile),
		/changed after preflight/,
	);
	assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "concurrent\n");
	assert.deepEqual(
		fs.readdirSync(root).filter((name) => name.startsWith(".stdd-worker-collect-")),
		[],
		"a rejected publication must retire its private temp",
	);

	fs.symlinkSync("baseline", path.join(root, "link"));
	const expectedLink = readWorkerPathState(root, "link").state;
	fs.unlinkSync(path.join(root, "link"));
	fs.symlinkSync("concurrent", path.join(root, "link"));
	assert.throws(
		() => publishWorkerSymlink(root, "link", "worker", "worker-000000000000000000000000", expectedLink),
		/changed after preflight/,
	);
	assert.equal(fs.readlinkSync(path.join(root, "link")), "concurrent");

	fs.writeFileSync(path.join(root, "context.txt"), "baseline\n");
	const expectedContextFile = readWorkerPathState(root, "context.txt").state;
	assert.throws(
		() =>
			publishWorkerFile(root, "context.txt", Buffer.from("worker\n"), 0o644, expectedContextFile, () => {
				throw new Error("bound worker branch changed at publication");
			}),
		/bound worker branch changed at publication/,
	);
	assert.equal(fs.readFileSync(path.join(root, "context.txt"), "utf8"), "baseline\n");
});

test("worker path reads reject an in-place write after descriptor content was read", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-worker-in-place-read-"));
	const target = path.join(root, "file.txt");
	fs.writeFileSync(target, "baseline\n");
	const original = fs.readFileSync;
	fs.readFileSync = function (subject, ...args) {
		const content = original.call(this, subject, ...args);
		if (typeof subject === "number") {
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
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), final);
	fs.writeFileSync(path.join(root, "src", "app.js"), final);
	const hookPath = path.join(root, "collect-final-race-hook.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";\nconst original = fs.readFileSync;\nlet fired = false;\nfs.readFileSync = function (target, ...args) {\n  if (!fired && String(target) === process.env.STDD_TEST_WORKER_LEDGER) {\n    fired = true;\n    fs.writeFileSync(process.env.STDD_TEST_SOURCE_PATH, "concurrent third state\\n");\n  }\n  return original.call(this, target, ...args);\n};\n`,
	);
	const result = await run(["worker", "collect", sandbox], {
		cwd: root,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			STDD_TEST_WORKER_LEDGER: path.join(sandbox, ".stdd", "ledger.jsonl"),
			STDD_TEST_SOURCE_PATH: path.join(root, "src", "app.js"),
		},
	});
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /conflict.*src\/app\.js|source changed after preflight/i);
	assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "concurrent third state\n");
});

test("worker collect resumes a replacement after its baseline reached quarantine", async () => {
	const { root, sandbox } = await createdWorker();
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), "worker replacement\n");
	const metadata = JSON.parse(fs.readFileSync(path.join(sandbox, ".stdd", "worker.json"), "utf8"));
	const expected = readWorkerPathState(root, "src/app.js").state;
	quarantineWorkerDeletion(root, "src/app.js", metadata.workerId, expected);
	assert.equal(fs.existsSync(path.join(root, "src", "app.js")), false);

	const result = await run(["worker", "collect", sandbox], { cwd: root });
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "worker replacement\n");
});

test("worker collect never overwrites a target created at the publication boundary", async () => {
	const { root, sandbox } = await createdWorker();
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), "worker result\n");
	const hookPath = path.join(root, "collect-no-replace-hook.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";\nimport path from "node:path";\nconst original = fs.linkSync;\nlet fired = false;\nfs.linkSync = function (source, target, ...args) {\n  if (!fired && path.basename(String(target)) === "app.js") {\n    fired = true;\n    fs.writeFileSync(process.env.STDD_TEST_SOURCE_PATH, "concurrent at publication\\n");\n  }\n  return original.call(this, source, target, ...args);\n};\n`,
	);
	const result = await run(["worker", "collect", sandbox], {
		cwd: root,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			STDD_TEST_SOURCE_PATH: path.join(root, "src", "app.js"),
		},
	});
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /exist|changed|publication|conflict/i);
	assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "concurrent at publication\n");
});

test("worker collect rechecks source HEAD before importing evidence", async () => {
	const { root, sandbox } = await createdWorker();
	await run(["note", "worker-only evidence"], { cwd: sandbox });
	const hookPath = path.join(root, "collect-head-race-hook.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";\nimport { execFileSync } from "node:child_process";\nconst original = fs.readFileSync;\nlet fired = false;\nfs.readFileSync = function (target, ...args) {\n  if (!fired && String(target) === process.env.STDD_TEST_WORKER_LEDGER) {\n    fired = true;\n    fs.writeFileSync(process.env.STDD_TEST_HEAD_FILE, "head drift\\n");\n    execFileSync("git", ["-C", process.env.STDD_TEST_SOURCE_ROOT, "add", "."]);\n    execFileSync("git", ["-C", process.env.STDD_TEST_SOURCE_ROOT, "-c", "user.name=STDD", "-c", "user.email=stdd@test", "commit", "-qm", "concurrent head"]);\n  }\n  return original.call(this, target, ...args);\n};\n`,
	);
	const result = await run(["worker", "collect", sandbox], {
		cwd: root,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			STDD_TEST_WORKER_LEDGER: path.join(sandbox, ".stdd", "ledger.jsonl"),
			STDD_TEST_SOURCE_ROOT: root,
			STDD_TEST_HEAD_FILE: path.join(root, "head-drift.txt"),
		},
	});
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /HEAD.*changed|bound.*HEAD/i);
	assert.equal(
		ledger(root).some((event) => event.note === "worker-only evidence"),
		false,
	);
});

test("worker collect rechecks branch identity after preflight and before publication", async () => {
	const { root, sandbox } = await createdWorker();
	fs.writeFileSync(path.join(sandbox, "src", "app.js"), "worker result\n");
	const hookPath = path.join(root, "collect-branch-race-hook.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";\nimport { execFileSync } from "node:child_process";\nconst original = fs.readFileSync;\nlet fired = false;\nfs.readFileSync = function (target, ...args) {\n  if (!fired && String(target) === process.env.STDD_TEST_WORKER_LEDGER) {\n    fired = true;\n    execFileSync("git", ["-C", process.env.STDD_TEST_SOURCE_ROOT, "checkout", "-qb", "concurrent-switch"]);\n  }\n  return original.call(this, target, ...args);\n};\n`,
	);
	const result = await run(["worker", "collect", sandbox], {
		cwd: root,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			STDD_TEST_WORKER_LEDGER: path.join(sandbox, ".stdd", "ledger.jsonl"),
			STDD_TEST_SOURCE_ROOT: root,
		},
	});
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /branch.*changed|bound.*branch/i);
	assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "export const value = 2;\n");
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
		await run(["task", "finish"], { cwd: root });
		const result = await run(["worker", "collect", sandbox], { cwd: root });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /active task|task.*changed/i);
	}
});
