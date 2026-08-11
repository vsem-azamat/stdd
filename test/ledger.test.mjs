import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openNativeRepoMutation } from "../cli/held-fs.mjs";
import {
	appendLedger,
	isStateExemptPath,
	ledgerQuarantineInventory,
	mutateLedgerWithNativeSession,
	withLedgerLock,
} from "../cli/ledger.mjs";
import { mergeConfig, parseLedger, redGenuine } from "../cli/lib.mjs";
import { deriveTaskState } from "../sdk/workflow.mjs";
import { switchBranchWhenFileOpens, switchTaskWhenFileOpens } from "./helpers/file-open-race.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");
const LEDGER_SOURCE = path.resolve(path.dirname(CLI), "ledger.mjs");
const RESET_TEMP_IGNORE = `.stdd/.ledger-reset-${"[0-9a-f]".repeat(32)}.tmp`;
const SYNC_CONSOLE_HOOK = path.join(tmpDir(), "sync-console.mjs");
fs.writeFileSync(
	SYNC_CONSOLE_HOOK,
	`import fs from "node:fs";
import { format } from "node:util";
console.log = (...args) => fs.writeSync(process.stdout.fd, format(...args) + "\\n");
console.error = (...args) => fs.writeSync(process.stderr.fd, format(...args) + "\\n");
`,
);

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-ledger-test-"));
}

async function run(args, opts = {}) {
	const env = opts.env ?? process.env;
	const nodeOptions = [env.NODE_OPTIONS, `--import=${SYNC_CONSOLE_HOOK}`].filter(Boolean).join(" ");
	try {
		const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
			...opts,
			env: { ...env, NODE_OPTIONS: nodeOptions },
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		return {
			code: err.code ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
}

/** Git repo on branch `feature` with a docs change and an impl change vs main. */
async function tmpGitRepo() {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), JSON.stringify({ baseRef: "main" }));
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	fs.writeFileSync(path.join(dir, "impl.js"), "export {};\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	return { dir, git };
}

function readLedger(dir) {
	return parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
}

async function waitForFile(file, message) {
	for (let attempts = 0; !fs.existsSync(file) && attempts < 500; attempts++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(fs.existsSync(file), message);
}

function ledgerLockPath(dir) {
	const key = createHash("sha256").update(fs.realpathSync(dir)).digest("hex").slice(0, 32);
	return path.join(os.tmpdir(), `stdd-ledger-${key}.lock`);
}

function ledgerTransactionTemps(dir) {
	const stddDir = path.join(dir, ".stdd");
	if (!fs.existsSync(stddDir)) return [];
	return fs
		.readdirSync(stddDir)
		.filter((name) => /^\.ledger-reset-[0-9a-f]{32}\.tmp$/.test(name))
		.sort();
}

function proxyNativeSession(context, handlers) {
	const real = context.session;
	context.session = new Proxy(real, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function") return value;
			if (!(property in handlers)) return value.bind(target);
			return (...args) => handlers[property](value.bind(target), ...args);
		},
	});
}

function nativeRecord(event = "note") {
	return JSON.stringify({
		ts: "2026-07-31T00:00:00.000Z",
		event,
		text: "native mutation test",
		branch: "feature",
	});
}

function retainedLedgerQuarantines(dir) {
	const root = path.join(dir, ".stdd", "ledger-quarantines");
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root)
		.filter((name) => /^\.ledger-recovered-[0-9a-f]{32}\.tmp$/.test(name))
		.sort();
}

/** PATH prefix with a fake `gh` whose behavior is scripted per test. */
function fakeGh(script) {
	const bin = tmpDir();
	fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n${script}\n`, {
		mode: 0o755,
	});
	return {
		...process.env,
		PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
	};
}

function planReadFaultEnv(dir) {
	const hookPath = path.join(tmpDir(), "reset-plan-read.mjs");
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
const planPath = ${JSON.stringify(planPath)};
const originalReadFile = fs.readFileSync;
let fired = false;

fs.readFileSync = function (target, ...args) {
  if (!fired && String(target) === planPath) {
    fired = true;
    const error = new Error("injected plan read failure");
    error.code = "EACCES";
    throw error;
  }
  return originalReadFile.call(this, target, ...args);
};
`,
	);
	return { ...process.env, NODE_OPTIONS: `--import=${hookPath}` };
}

function runCommitGapSwitchEnv(dir, mode) {
	const hookPath = path.join(tmpDir(), `run-commit-gap-${mode}.mjs`);
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const originalLink = fs.linkSync;
let switched = false;
fs.linkSync = function (source, target) {
  if (!switched && /stdd-ledger-[0-9a-f]+\\.lock$/.test(String(target))) {
    switched = true;
    if (${JSON.stringify(mode)} === "task") {
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      for (const args of [["task", "finish"], ["task", "start", "task B"]]) {
        const result = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...args], {
          cwd: ${JSON.stringify(dir)},
          env,
          encoding: "utf8",
        });
        if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      }
    } else {
      const result = spawnSync(
        "git",
        ["-C", ${JSON.stringify(dir)}, "checkout", "-qb", "run-hijack"],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    }
  }
  return originalLink.call(this, source, target);
};
`,
	);
	return { ...process.env, NODE_OPTIONS: `--import=${hookPath}` };
}

// --- lib ---

test("mutating ledger transactions use the portable native filesystem session boundary", () => {
	const source = fs.readFileSync(LEDGER_SOURCE, "utf8");
	assert.match(source, /openNativeRepoMutation/);
	assert.equal(source.match(/context = await openNativeRepoMutation/g)?.length, 1);
	assert.doesNotMatch(source, /openHeldLinuxRepoDirectory/);
	assert.doesNotMatch(source, /appendLedgerTransactionHeld|readHeldLedger|heldPath/);
	assert.doesNotMatch(source, /process\.platform\s*!==?\s*["']linux["']/);
	assert.doesNotMatch(source, /\/proc\/self\/fd/);
});

test("a ledger mutation creates a missing .stdd directory through native capabilities", async () => {
	const dir = tmpDir();
	await exec("git", ["-C", dir, "init", "-q", "-b", "feature"]);
	await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	await exec("git", ["-C", dir, "config", "user.name", "Test"]);
	fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
	await exec("git", ["-C", dir, "add", "README.md"]);
	await exec("git", ["-C", dir, "commit", "-qm", "fixture"]);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd")));
	const started = await run(["task", "start", "native directory creation"], { cwd: dir });
	assert.equal(started.code, 0, started.stdout + started.stderr);
	assert.equal(fs.statSync(path.join(dir, ".stdd")).mode & 0o777, 0o755);
	assert.equal(fs.statSync(path.join(dir, ".stdd", "ledger.jsonl")).mode & 0o777, 0o600);
});

test("native helper preflight failure leaves ledger bytes and transaction namespace untouched", async () => {
	const { dir } = await tmpGitRepo();
	const packageRoot = tmpDir();
	const target = `${process.platform}-${process.arch}`;
	const artifactName = process.platform === "win32" ? "stdd-fs.exe" : "stdd-fs";
	const bytes = Buffer.from("not a native filesystem helper\n");
	const artifactRelative = `${target}/${artifactName}`;
	fs.mkdirSync(path.join(packageRoot, "prebuilds", "stdd-fs", target), { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "prebuilds", "stdd-fs", artifactRelative), bytes, {
		mode: 0o755,
	});
	fs.writeFileSync(
		path.join(packageRoot, "prebuilds", "stdd-fs", "manifest.json"),
		JSON.stringify({
			schema: 1,
			artifacts: [
				{
					target,
					protocol: 1,
					path: artifactRelative,
					size: bytes.length,
					sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
				},
			],
		}),
	);

	const started = await run(["task", "start", "must not mutate"], {
		cwd: dir,
		env: { ...process.env, STDD_NATIVE_FS_PACKAGE_ROOT: packageRoot },
	});
	assert.equal(started.code, 1, started.stdout + started.stderr);
	assert.equal(fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), false);
	assert.deepEqual(ledgerTransactionTemps(dir), []);
});

test("parseLedger tolerates blank and corrupt lines", () => {
	const events = parseLedger('{"event":"note","text":"a"}\n\nnot json\n{"event":"note","text":"b"}\n');
	assert.equal(events.length, 2);
	assert.equal(events[1].text, "b");
});

test("redGenuine: exit 0 is never a genuine red", () => {
	assert.equal(redGenuine(0, "1 failing", "failing"), "no");
});

test("redGenuine: without a redPattern the answer is unknown", () => {
	assert.equal(redGenuine(1, "1 failing", null), "unknown");
});

test("redGenuine: redPattern separates test failure from env error", () => {
	assert.equal(redGenuine(1, "✖ 3 failing", "failing"), "yes");
	assert.equal(redGenuine(127, "tsc: command not found", "failing"), "no");
});

test("mergeConfig accepts a redPattern and rejects an invalid one", () => {
	assert.equal(mergeConfig({ redPattern: "\\d+ failing" }).redPattern, "\\d+ failing");
	assert.throws(() => mergeConfig({ redPattern: 42 }), /redPattern/);
	assert.throws(() => mergeConfig({ redPattern: "(" }), /redPattern/);
});

// --- task lifecycle ---

test("task start creates a durable identity and subsequent events carry taskId", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "# Old plan\n");
	const started = await run(["task", "start", "gross pricing"], { cwd: dir });
	assert.equal(started.code, 0, started.stderr);
	assert.match(started.stdout, /task-[0-9a-f]+/);
	const duplicate = await run(["task", "start", "another"], { cwd: dir });
	assert.equal(duplicate.code, 1);
	assert.match(duplicate.stderr, /already active/);
	await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	const events = readLedger(dir);
	const task = events.find((event) => event.event === "task-start");
	const docs = events.find((event) => event.event === "docs");
	assert.match(task.id, /^task-[0-9a-f]{12}$/);
	assert.match(task.planBaseline, /^sha256:/);
	assert.equal(docs.taskId, task.id);
});

test("task transitions reject non-printable Git branches before ledger or log mutation", async (t) => {
	const controls = [
		["RLO", "\u202e"],
		["LRI", "\u2066"],
		["ZWSP", "\u200b"],
		["BOM", "\ufeff"],
		["DEL", "\u007f"],
	];
	const transitions = [
		{ name: "start", command: ["task", "start", "new task"], prepare: async () => {} },
		{
			name: "finish",
			command: ["task", "finish"],
			prepare: (dir) => run(["task", "start", "existing"], { cwd: dir }),
		},
		{
			name: "reset",
			command: ["task", "reset", "replacement"],
			prepare: (dir) => run(["task", "start", "existing"], { cwd: dir }),
		},
	];
	for (const [controlName, control] of controls) {
		for (const transition of transitions) {
			await t.test(`${transition.name}/${controlName}`, async (subtest) => {
				const { dir, git } = await tmpGitRepo();
				await transition.prepare(dir);
				const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
				const before = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : null;
				const hostileBranch = `hostile-${control}owned`;
				try {
					await git("checkout", "-qb", hostileBranch);
				} catch {
					subtest.skip(`this Git build rejects ${controlName} in branch names`);
					return;
				}

				const result = await run(transition.command, { cwd: dir });

				assert.equal(result.code, 1, result.stdout + result.stderr);
				assert.match(result.stderr, /current Git branch.*single printable line/i);
				assert.ok(!result.stdout.includes("owned"));
				assert.ok(!result.stderr.includes("owned"));
				if (before === null) {
					assert.ok(!fs.existsSync(ledgerPath), "rejection creates no ledger");
				} else {
					assert.deepEqual(
						fs.readFileSync(ledgerPath),
						before,
						"rejection leaves ledger byte-identical",
					);
				}
			});
		}
	}
});

test("task transitions preserve an ordinary Unicode Git branch", async () => {
	const { dir, git } = await tmpGitRepo();
	const branch = "фича/می‌خواهم-👩‍💻";
	await git("checkout", "-qb", branch);

	assert.equal((await run(["task", "start", "unicode"], { cwd: dir })).code, 0);
	assert.equal((await run(["task", "finish"], { cwd: dir })).code, 0);
	assert.equal((await run(["task", "start", "again"], { cwd: dir })).code, 0);
	assert.equal((await run(["task", "reset", "replacement"], { cwd: dir })).code, 0);

	const events = readLedger(dir);
	assert.ok(events.length > 0);
	assert.ok(events.every((event) => event.branch === branch));
	assert.equal(deriveTaskState(events).state, "active");
	assert.equal(deriveTaskState(events).task.name, "replacement");
});

test("a ledger already poisoned by a non-printable branch remains diagnosable and immutable", async () => {
	const { dir } = await tmpGitRepo();
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const poisoned = `${JSON.stringify({
		ts: new Date().toISOString(),
		event: "task-start",
		id: "task-poisoned",
		name: "poisoned",
		planBaseline: null,
		branch: "feature-\u202eowned",
	})}\n`;
	fs.writeFileSync(ledgerPath, poisoned);

	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.state, "invalid");
	assert.match(status.next, /malformed task boundary/i);

	const transition = await run(["task", "start", "replacement"], { cwd: dir });
	assert.equal(transition.code, 1, transition.stdout + transition.stderr);
	assert.match(transition.stderr, /malformed task boundary.*repair/i);
	assert.equal(fs.readFileSync(ledgerPath, "utf8"), poisoned);
});

test("ordinary ledger appends add exactly one LF separator when needed", async (t) => {
	for (const scenario of [
		{ name: "missing final LF", suffix: "", separator: "\n" },
		{ name: "lone final CR", suffix: "\r", separator: "\n" },
		{ name: "existing final LF", suffix: "\n", separator: "" },
	]) {
		await t.test(scenario.name, async () => {
			const { dir } = await tmpGitRepo();
			const started = await run(["task", "start", "separator probe"], { cwd: dir });
			assert.equal(started.code, 0, started.stdout + started.stderr);
			const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
			const terminated = fs.readFileSync(ledgerPath);
			assert.equal(terminated[0], 0x7b, "an empty ledger never receives a leading separator");
			assert.equal(terminated.at(-1), 0x0a);
			const firstRecord = terminated.subarray(0, -1);
			const existing = Buffer.concat([firstRecord, Buffer.from(scenario.suffix)]);
			fs.writeFileSync(ledgerPath, existing);

			const noted = await run(["note", "separator preserved"], { cwd: dir });
			assert.equal(noted.code, 0, noted.stdout + noted.stderr);
			const events = readLedger(dir);
			assert.equal(events.length, 2);
			assert.equal(events[1].event, "note");
			assert.equal(events[1].taskId, events[0].id);
			assert.equal(deriveTaskState(events).state, "active");

			const expected = Buffer.concat([
				existing,
				Buffer.from(scenario.separator),
				Buffer.from(`${JSON.stringify(events[1])}\n`),
			]);
			assert.deepEqual(fs.readFileSync(ledgerPath), expected);
		});
	}
});

test("simultaneous task starts serialize the state read and accept exactly one", async () => {
	const { dir } = await tmpGitRepo();
	const hookPath = path.join(tmpDir(), "start-lock-barrier.mjs");
	const release = path.join(tmpDir(), "release");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const originalLink = fs.linkSync;
let waited = false;
fs.linkSync = function (source, target) {
  if (!waited && /stdd-ledger-[0-9a-f]+\\.lock$/.test(String(target))) {
    waited = true;
    fs.writeFileSync(process.env.STDD_TEST_READY, "");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
      Atomics.wait(wait, 0, 0, 10);
    }
    if (!fs.existsSync(${JSON.stringify(release)})) throw new Error("start barrier timed out");
  }
  return originalLink.call(this, source, target);
};
`,
	);
	const readyA = path.join(tmpDir(), "ready-a");
	const readyB = path.join(tmpDir(), "ready-b");
	const start = (name, ready) =>
		run(["task", "start", name], {
			cwd: dir,
			env: {
				...process.env,
				NODE_OPTIONS: `--import=${hookPath}`,
				STDD_TEST_READY: ready,
			},
		});
	const first = start("first contender", readyA);
	const second = start("second contender", readyB);
	await Promise.all([
		waitForFile(readyA, "first start reached the lock"),
		waitForFile(readyB, "second start reached the lock"),
	]);
	fs.writeFileSync(release, "");
	const results = await Promise.all([first, second]);

	assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
	assert.match(results.find((result) => result.code === 1).stderr, /already active/);
	const events = readLedger(dir);
	assert.equal(events.filter((event) => event.event === "task-start").length, 1);
	assert.equal(deriveTaskState(events).state, "active");
});

test("native publication aborts before either rename when the captured branch changes", async () => {
	const { dir } = await tmpGitRepo();
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	fs.writeFileSync(ledgerPath, "original bytes without LF");
	const before = fs.readFileSync(ledgerPath);
	const context = await openNativeRepoMutation(dir, "ledger branch switch test");
	try {
		await assert.rejects(
			mutateLedgerWithNativeSession(context, [nativeRecord("task-start")], {
				beforeCommit(phase) {
					if (phase === "pre-rename") {
						throw new Error("the checkout switched branches before publication");
					}
				},
			}),
			/switched branches/,
		);
	} finally {
		await context.close();
	}
	assert.deepEqual(fs.readFileSync(ledgerPath), before);
	assert.equal(ledgerTransactionTemps(dir).length, 1, "the exact active temp remains recoverable");
});

test("task names reject line and terminal injection before recording", async () => {
	for (const name of [
		"safe\nforged: approved",
		"safe\u001b[2Jforged",
		"safe\tforged",
		"safe\u202eforged",
		"safe\u2066forged",
		"safe\u200bforged",
		"safe\ufeffforged",
	]) {
		const { dir } = await tmpGitRepo();
		const started = await run(["task", "start", name], { cwd: dir });
		assert.equal(started.code, 1, started.stdout + started.stderr);
		assert.match(started.stderr, /single printable line/);
		assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")));
	}
});

test("task lifecycle rejects malformed ledgers without changing their bytes", async (t) => {
	const malformedLedgers = [
		{
			name: "primitive event",
			content: "null\n",
			reason: /task event at index 0 must be a plain record object/,
		},
		{
			name: "malformed boundary",
			content: `${JSON.stringify({
				ts: "2026-07-25T12:34:56.789Z",
				branch: "feature",
				event: "task-start",
				name: "missing id",
				planBaseline: null,
			})}\n`,
			reason: /task-start needs a non-empty id/,
		},
	];
	const transitions = [
		{ name: "start", args: ["task", "start", "replacement"] },
		{ name: "finish", args: ["task", "finish"] },
		{ name: "reset", args: ["task", "reset", "replacement"] },
	];

	for (const malformed of malformedLedgers) {
		for (const transition of transitions) {
			await t.test(`${transition.name} with ${malformed.name}`, async () => {
				const { dir } = await tmpGitRepo();
				const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
				fs.writeFileSync(ledgerPath, malformed.content);

				const result = await run(transition.args, { cwd: dir });

				assert.equal(result.code, 1, result.stdout + result.stderr);
				assert.match(result.stderr, /malformed task boundary in \.stdd\/ledger\.jsonl/);
				assert.match(result.stderr, malformed.reason);
				assert.match(result.stderr, /repair \.stdd\/ledger\.jsonl before changing task lifecycle/);
				assert.equal(
					fs.readFileSync(ledgerPath, "utf8"),
					malformed.content,
					"rejected lifecycle transition must not append to or rewrite the corrupt ledger",
				);
			});
		}
	}
});

test("task reset validates its replacement name before closing the active task", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "safe task"], { cwd: dir });
	const reset = await run(["task", "reset", "unsafe\nforged"], { cwd: dir });
	assert.equal(reset.code, 1, reset.stdout + reset.stderr);
	assert.match(reset.stderr, /single printable line/);
	const events = readLedger(dir);
	assert.equal(events.filter((event) => event.event === "task-reset").length, 0);
	assert.equal(deriveTaskState(events).state, "active");
	assert.equal(deriveTaskState(events).task.name, "safe task");
});

test("task finish makes status idle without deleting old plan or evidence", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "finish me"], { cwd: dir });
	await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] old unfinished item\n");
	const finished = await run(["task", "finish"], { cwd: dir });
	assert.equal(finished.code, 0, finished.stderr);
	const status = await run(["status", "--local"], { cwd: dir });
	assert.equal(status.code, 0);
	assert.match(status.stdout, /task:\s+idle/);
	assert.match(status.stdout, /no task is required for discussion or read-only work/i);
	assert.doesNotMatch(status.stdout, /task start/i);
	const idleJson = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(idleJson.state, "idle");
	assert.deepEqual(Object.keys(idleJson), [
		"state",
		"task",
		"branch",
		"loop",
		"slice",
		"plan",
		"review",
		"pr",
		"next",
	]);
	assert.equal(idleJson.loop.verify.done, false);
	assert.equal(idleJson.slice.declared, false);
	assert.equal(idleJson.plan.present, false);
	assert.equal(idleJson.review, null);
	assert.equal(idleJson.next, "no task is required for discussion or read-only work");
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "plan.md")));
	assert.ok(readLedger(dir).some((event) => event.event === "task-finish"));
	const afterFinish = await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	assert.equal(afterFinish.code, 1);
	assert.match(afterFinish.stderr, /no active task/);
	assert.equal(
		readLedger(dir).filter((event) => event.event === "docs").length,
		1,
		"an idle task never accepts evidence that readers would discard",
	);
	const sideEffect = path.join(dir, "must-not-exist.txt");
	const idleRun = await run(
		[
			"verify",
			"--",
			"node",
			"-e",
			`require("node:fs").writeFileSync(${JSON.stringify(sideEffect)},"x")`,
		],
		{ cwd: dir },
	);
	assert.equal(idleRun.code, 1);
	assert.match(idleRun.stderr, /no active task/);
	assert.ok(!fs.existsSync(sideEffect), "the command is rejected before it can mutate the checkout");
});

test("task reset closes the old identity and starts a fresh one", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "first"], { cwd: dir });
	const first = readLedger(dir).find((event) => event.event === "task-start").id;
	const reset = await run(["task", "reset", "second"], { cwd: dir });
	assert.equal(reset.code, 0, reset.stderr);
	const starts = readLedger(dir).filter((event) => event.event === "task-start");
	assert.equal(starts.length, 2);
	assert.notEqual(starts[1].id, first);
	assert.equal(starts[1].name, "second");
	assert.ok(readLedger(dir).some((event) => event.event === "task-reset"));
});

test("task reset transaction separates an unterminated valid ledger record", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "first"], { cwd: dir });
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const terminated = fs.readFileSync(ledgerPath);
	assert.equal(terminated.at(-1), 0x0a);
	const existing = terminated.subarray(0, -1);
	fs.writeFileSync(ledgerPath, existing);

	const reset = await run(["task", "reset", "second"], { cwd: dir });
	assert.equal(reset.code, 0, reset.stdout + reset.stderr);
	const events = readLedger(dir);
	assert.equal(events.length, 3);
	assert.deepEqual(
		events.map((event) => event.event),
		["task-start", "task-reset", "task-start"],
	);
	const taskState = deriveTaskState(events);
	assert.equal(taskState.state, "active");
	assert.equal(taskState.task.name, "second");

	const expected = Buffer.concat([
		existing,
		Buffer.from("\n"),
		Buffer.from(`${JSON.stringify(events[1])}\n`),
		Buffer.from(`${JSON.stringify(events[2])}\n`),
	]);
	assert.deepEqual(fs.readFileSync(ledgerPath), expected);
});

test("task reset leaves the old task active when the replacement plan cannot be read", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "first"], { cwd: dir });
	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] replacement work\n");
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const before = fs.readFileSync(ledgerPath);

	const reset = await run(["task", "reset", "replacement"], {
		cwd: dir,
		env: planReadFaultEnv(dir),
	});

	assert.equal(reset.code, 1, reset.stdout + reset.stderr);
	assert.match(reset.stderr, /injected plan read failure/);
	assert.deepEqual(fs.readFileSync(ledgerPath), before);
	const state = deriveTaskState(readLedger(dir));
	assert.equal(state.state, "active");
	assert.equal(state.task.name, "first");
});

test("a locked action failure discards every record it queued before throwing", async () => {
	const { dir } = await tmpGitRepo();
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.throws(
		() =>
			withLedgerLock(dir, () => {
				appendLedger(
					dir,
					{ event: "task-start", id: "task-queued-failure", name: "must not commit" },
					{ lockHeld: true, expectedBranch: "feature" },
				);
				throw new Error("injected locked action failure");
			}),
		/injected locked action failure/,
	);
	assert.ok(!fs.existsSync(ledgerPath));
});

test("a pre-rename native fault leaves the ledger unchanged and retry recovers exact bytes", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "first"], { cwd: dir });
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const before = fs.readFileSync(ledgerPath);
	const record = nativeRecord();
	const faulted = await openNativeRepoMutation(dir, "ledger pre-rename fault test");
	let fired = false;
	proxyNativeSession(faulted, {
		rename: async (rename, operation) => {
			if (!fired && /^\.ledger-prepared-/.test(operation.to)) {
				fired = true;
				const error = new Error("injected native pre-rename fault");
				error.code = "injected-fault";
				error.mutation = "none";
				throw error;
			}
			return rename(operation);
		},
	});
	try {
		await assert.rejects(mutateLedgerWithNativeSession(faulted, [record]), /pre-rename fault/);
	} finally {
		await faulted.close();
	}
	assert.deepEqual(fs.readFileSync(ledgerPath), before);
	const [activeName] = ledgerTransactionTemps(dir);
	assert.match(activeName, /^\.ledger-reset-[0-9a-f]{32}\.tmp$/);
	const retainedBytes = fs.readFileSync(path.join(dir, ".stdd", activeName));
	assert.deepEqual(retainedBytes, Buffer.concat([before, Buffer.from(`${record}\n`)]));

	const retry = await openNativeRepoMutation(dir, "ledger pre-rename retry test");
	try {
		await mutateLedgerWithNativeSession(retry, [record]);
	} finally {
		await retry.close();
	}
	assert.deepEqual(fs.readFileSync(ledgerPath), Buffer.concat([before, Buffer.from(`${record}\n`)]));
	const [quarantine] = retainedLedgerQuarantines(dir);
	assert.ok(quarantine, "the stranded transaction has one recognized retained location");
	const retainedRoot = path.join(dir, ".stdd", "ledger-quarantines", quarantine);
	const inventory = JSON.parse(fs.readFileSync(path.join(retainedRoot, "inventory.json"), "utf8"));
	assert.equal(inventory.schema, 1);
	assert.equal(inventory.kind, "ledger-transaction-temp");
	assert.equal(inventory.original, `.stdd/${activeName}`);
	assert.equal(inventory.retained, `.stdd/ledger-quarantines/${quarantine}/payload`);
	assert.deepEqual(fs.readFileSync(path.join(retainedRoot, "payload")), retainedBytes);
});

test("prepared native temps recover through the same deterministic provenance path", async () => {
	const { dir } = await tmpGitRepo();
	const token = "a".repeat(32);
	const preparedName = `.ledger-prepared-${token}.tmp`;
	const bytes = Buffer.from("prepared transaction bytes\n");
	fs.writeFileSync(path.join(dir, ".stdd", preparedName), bytes, { mode: 0o600 });
	const context = await openNativeRepoMutation(dir, "prepared ledger recovery test");
	try {
		await mutateLedgerWithNativeSession(context, []);
	} finally {
		await context.close();
	}
	assert.deepEqual(ledgerTransactionTemps(dir), []);
	const quarantine = `.ledger-recovered-${token}.tmp`;
	const root = path.join(dir, ".stdd", "ledger-quarantines", quarantine);
	const inventory = JSON.parse(fs.readFileSync(path.join(root, "inventory.json"), "utf8"));
	assert.equal(inventory.sourcePhase, "ledger-prepared");
	assert.equal(inventory.original, `.stdd/${preparedName}`);
	assert.deepEqual(fs.readFileSync(path.join(root, "payload")), bytes);
});

test("an interrupted deterministic inventory write is completed on recovery", async () => {
	const { dir } = await tmpGitRepo();
	const token = "e".repeat(32);
	const activeName = `.ledger-reset-${token}.tmp`;
	const container = path.join(dir, ".stdd", "ledger-quarantines", `.ledger-recovered-${token}.tmp`);
	fs.writeFileSync(path.join(dir, ".stdd", activeName), "recover after inventory interruption\n", {
		mode: 0o600,
	});
	fs.mkdirSync(container, { recursive: true, mode: 0o700 });
	fs.chmodSync(container, 0o700);
	fs.writeFileSync(path.join(container, `.inventory-${token}.tmp`), "partial", { mode: 0o600 });
	const context = await openNativeRepoMutation(dir, "ledger inventory recovery test");
	try {
		await mutateLedgerWithNativeSession(context, []);
	} finally {
		await context.close();
	}
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", activeName)));
	assert.ok(!fs.existsSync(path.join(container, `.inventory-${token}.tmp`)));
	const inventory = JSON.parse(fs.readFileSync(path.join(container, "inventory.json"), "utf8"));
	assert.equal(inventory.original, `.stdd/${activeName}`);
	assert.equal(inventory.retained, `.stdd/ledger-quarantines/.ledger-recovered-${token}.tmp/payload`);
	assert.equal(
		fs.readFileSync(path.join(container, "payload"), "utf8"),
		"recover after inventory interruption\n",
	);
	const relativeContainer = `.stdd/ledger-quarantines/.ledger-recovered-${token}.tmp`;
	assert.equal(isStateExemptPath(dir, `${relativeContainer}/inventory.json`), true);
	assert.equal(isStateExemptPath(dir, `${relativeContainer}/payload`), true);
	assert.deepEqual(ledgerQuarantineInventory(dir), [
		{ relative: relativeContainer, provenance: "ledger recovery inventory" },
	]);
	const doctor = await run(["doctor", dir]);
	assert.match(doctor.stdout, /retained ledger quarantine.*inventory proven/i);
	fs.writeFileSync(path.join(container, "unexpected"), "not trusted\n");
	assert.equal(isStateExemptPath(dir, `${relativeContainer}/payload`), false);
});

for (const mutation of ["possible", "committed"]) {
	test(`an identity-proven ${mutation} final rename is accepted exactly once`, async () => {
		const { dir } = await tmpGitRepo();
		const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
		const record = nativeRecord(`rename-${mutation}`);
		const context = await openNativeRepoMutation(dir, `ledger ${mutation} rename test`);
		let fired = false;
		proxyNativeSession(context, {
			rename: async (rename, operation) => {
				const result = await rename(operation);
				if (!fired && operation.to === "ledger.jsonl") {
					fired = true;
					const error = new Error(`injected ${mutation} final rename fault`);
					error.code = "injected-fault";
					error.mutation = mutation;
					throw error;
				}
				return result;
			},
		});
		try {
			await mutateLedgerWithNativeSession(context, [record]);
		} finally {
			await context.close();
		}
		assert.equal(fs.readFileSync(ledgerPath, "utf8"), `${record}\n`);
		const retry = await openNativeRepoMutation(dir, `ledger ${mutation} rename retry`);
		try {
			await mutateLedgerWithNativeSession(retry, []);
		} finally {
			await retry.close();
		}
		assert.equal(fs.readFileSync(ledgerPath, "utf8"), `${record}\n`);
	});
}

test("a possible namespace flush fault preserves the committed publication for retry", async () => {
	const { dir } = await tmpGitRepo();
	const record = nativeRecord("namespace-flush");
	const context = await openNativeRepoMutation(dir, "ledger namespace flush test");
	let committed = false;
	let fired = false;
	proxyNativeSession(context, {
		rename: async (rename, operation) => {
			const result = await rename(operation);
			if (operation.to === "ledger.jsonl") committed = true;
			return result;
		},
		flush: async (flush, ...args) => {
			if (committed && !fired) {
				fired = true;
				const error = new Error("injected native namespace flush fault");
				error.code = "injected-fault";
				error.mutation = "possible";
				throw error;
			}
			return flush(...args);
		},
	});
	try {
		await assert.rejects(mutateLedgerWithNativeSession(context, [record]), /namespace flush fault/);
	} finally {
		await context.close();
	}
	assert.equal(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"), `${record}\n`);
	const retry = await openNativeRepoMutation(dir, "ledger namespace flush retry");
	try {
		await mutateLedgerWithNativeSession(retry, []);
	} finally {
		await retry.close();
	}
});

test("native precommit rejects a ledger changed after its capability snapshot", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "first"], { cwd: dir });
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const concurrent = Buffer.from("concurrent exact bytes\n");
	const context = await openNativeRepoMutation(dir, "ledger snapshot conflict test");
	let changed = false;
	proxyNativeSession(context, {
		rename: async (rename, operation) => {
			const result = await rename(operation);
			if (!changed && /^\.ledger-prepared-/.test(operation.to)) {
				changed = true;
				fs.writeFileSync(ledgerPath, concurrent);
			}
			return result;
		},
	});
	try {
		await assert.rejects(
			mutateLedgerWithNativeSession(context, [nativeRecord("snapshot-conflict")]),
			/ledger changed after its transaction snapshot/,
		);
	} finally {
		await context.close();
	}
	assert.deepEqual(fs.readFileSync(ledgerPath), concurrent);
	assert.equal(
		fs.readdirSync(path.join(dir, ".stdd")).filter((name) => /^\.ledger-prepared-/.test(name)).length,
		1,
	);
});

test("native postflight detects parent replacement after committing only to the captured parent", async () => {
	const { dir } = await tmpGitRepo();
	const stdd = path.join(dir, ".stdd");
	const parked = `${stdd}-parked`;
	const record = nativeRecord("parent-replacement");
	const context = await openNativeRepoMutation(dir, "ledger parent replacement test");
	let replaced = false;
	proxyNativeSession(context, {
		rename: async (rename, operation) => {
			const result = await rename(operation);
			if (!replaced && operation.to === "ledger.jsonl") {
				replaced = true;
				fs.renameSync(stdd, parked);
				fs.mkdirSync(stdd);
			}
			return result;
		},
	});
	try {
		await assert.rejects(
			mutateLedgerWithNativeSession(context, [record]),
			(error) => error.mutation === "committed" && /postflight|changed/i.test(error.message),
		);
	} finally {
		await context.close();
	}
	assert.ok(!fs.existsSync(path.join(stdd, "ledger.jsonl")));
	assert.equal(fs.readFileSync(path.join(parked, "ledger.jsonl"), "utf8"), `${record}\n`);
});

test("recovery rename faults retain inventory and settle on the next retry", async () => {
	const { dir } = await tmpGitRepo();
	const token = "b".repeat(32);
	const activeName = `.ledger-reset-${token}.tmp`;
	const bytes = Buffer.from("recover me exactly\n");
	fs.writeFileSync(path.join(dir, ".stdd", activeName), bytes, { mode: 0o600 });
	const faulted = await openNativeRepoMutation(dir, "ledger recovery rename fault test");
	let fired = false;
	proxyNativeSession(faulted, {
		rename: async (rename, operation) => {
			const result = await rename(operation);
			if (!fired && operation.to === "payload") {
				fired = true;
				const error = new Error("injected committed recovery rename fault");
				error.code = "injected-fault";
				error.mutation = "committed";
				throw error;
			}
			return result;
		},
	});
	try {
		await assert.rejects(mutateLedgerWithNativeSession(faulted, []), /recovery rename fault/);
	} finally {
		await faulted.close();
	}
	const root = path.join(dir, ".stdd", "ledger-quarantines", `.ledger-recovered-${token}.tmp`);
	assert.ok(fs.existsSync(path.join(root, "inventory.json")));
	assert.deepEqual(fs.readFileSync(path.join(root, "payload")), bytes);
	const retry = await openNativeRepoMutation(dir, "ledger recovery rename retry");
	try {
		await mutateLedgerWithNativeSession(retry, []);
	} finally {
		await retry.close();
	}
	assert.deepEqual(ledgerTransactionTemps(dir), []);
});

test("native recovery refuses symlink and hard-link transaction impostors", async (t) => {
	for (const kind of ["symlink", "hard-link"]) {
		await t.test(kind, async () => {
			const { dir } = await tmpGitRepo();
			const victim = path.join(tmpDir(), `${kind}-victim`);
			fs.writeFileSync(victim, "keep me\n", { mode: 0o600 });
			const token = (kind === "symlink" ? "c" : "d").repeat(32);
			const temp = path.join(dir, ".stdd", `.ledger-reset-${token}.tmp`);
			if (kind === "symlink") {
				fs.rmSync(temp, { force: true });
				fs.symlinkSync(victim, temp);
			} else {
				fs.linkSync(victim, temp);
			}
			const context = await openNativeRepoMutation(dir, `ledger ${kind} recovery test`);
			try {
				await assert.rejects(
					mutateLedgerWithNativeSession(context, []),
					/unsafe ledger transaction temporary file.*regular owner-only/i,
				);
			} finally {
				await context.close();
			}
			assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n");
		});
	}
});

test("capability close failures are best-effort and do not mask publication diagnostics", async () => {
	const { dir } = await tmpGitRepo();
	const context = await openNativeRepoMutation(dir, "ledger close capability test");
	let closes = 0;
	proxyNativeSession(context, {
		closeCapability: async () => {
			closes += 1;
			throw new Error("injected capability close fault");
		},
	});
	try {
		await mutateLedgerWithNativeSession(context, [nativeRecord("close-capability")]);
	} finally {
		await context.close();
	}
	assert.ok(closes > 0);
	assert.match(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"), /close-capability/);
});
test("a portable ledger lock release failure is reported instead of silently leaking", async () => {
	const { dir } = await tmpGitRepo();
	const hookPath = path.join(tmpDir(), "fail-lock-release.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
const originalRename = fs.renameSync;
fs.renameSync = function (source, target, ...args) {
  if (/stdd-ledger-[0-9a-f]+\\.lock$/.test(String(source))) {
    throw new Error("injected portable lock release failure");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);
	const result = await run(["task", "start", "must report release"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /could not release the ledger shared lock safely/i);
	fs.rmSync(ledgerLockPath(dir), { force: true });
});

test("task reset publishes its pair under one lock against a concurrent start", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "first"], { cwd: dir });
	const [resetResult, interloperResult] = await Promise.all([
		run(["task", "reset", "replacement"], { cwd: dir }),
		run(["task", "start", "interloper"], { cwd: dir }),
	]);
	assert.equal(resetResult.code, 0, resetResult.stdout + resetResult.stderr);
	assert.equal(interloperResult.code, 1, interloperResult.stdout + interloperResult.stderr);
	assert.match(interloperResult.stderr, /already active/);
	const events = readLedger(dir);
	const resetIndex = events.findIndex((event) => event.event === "task-reset");
	assert.ok(resetIndex > 0);
	assert.equal(events[resetIndex + 1].event, "task-start");
	assert.equal(events[resetIndex + 1].name, "replacement");
	assert.equal(events.filter((event) => event.event === "task-start").length, 2);
	assert.equal(deriveTaskState(events).state, "active");
	assert.equal(deriveTaskState(events).task.name, "replacement");
});

test("a dead ledger lock is recovered before a task transition", async () => {
	const { dir } = await tmpGitRepo();
	const lockPath = ledgerLockPath(dir);
	let deadPid = process.pid + 1_000_000;
	for (;;) {
		try {
			process.kill(deadPid, 0);
			deadPid++;
		} catch (err) {
			if (err.code === "ESRCH") break;
			throw err;
		}
	}
	fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: "b".repeat(32) }), {
		mode: 0o600,
	});

	const started = await run(["task", "start", "after stale lock"], {
		cwd: dir,
	});
	assert.equal(started.code, 0, started.stdout + started.stderr);
	assert.ok(!fs.existsSync(lockPath));
	assert.equal(deriveTaskState(readLedger(dir)).state, "active");
});

test("a process killed after atomic lock creation leaves a recoverable owner inode", async () => {
	const { dir } = await tmpGitRepo();
	const lockPath = ledgerLockPath(dir);
	const ready = path.join(tmpDir(), "linked-lock-ready");
	const hookPath = path.join(tmpDir(), "pause-after-lock-link.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const originalLink = fs.linkSync;
fs.linkSync = function (source, target) {
  const value = originalLink.call(this, source, target);
  if (/stdd-ledger-[0-9a-f]+\\.lock$/.test(String(target))) {
    fs.writeFileSync(${JSON.stringify(ready)}, "");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 60_000);
  }
  return value;
};
`,
	);
	const child = execFile("node", [CLI, "task", "start", "killed owner"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	const exited = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	await waitForFile(ready, "child linked the complete owner inode");
	assert.ok(fs.existsSync(lockPath));
	child.kill("SIGKILL");
	const killed = await exited;
	assert.equal(killed.signal, "SIGKILL");

	const recovered = await run(["task", "start", "replacement owner"], {
		cwd: dir,
	});
	assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
	assert.ok(!fs.existsSync(lockPath));
	const ownerPrefix = `${path.basename(lockPath)}.`;
	assert.ok(
		!fs.readdirSync(path.dirname(lockPath)).some((entry) => entry.startsWith(ownerPrefix)),
		"recovery removes the killed owner's hard-link name too",
	);
	assert.equal(deriveTaskState(readLedger(dir)).state, "active");
});

test("a fresh incomplete legacy lock is not stolen while its creator is live", async () => {
	const { dir } = await tmpGitRepo();
	const lockPath = ledgerLockPath(dir);
	fs.writeFileSync(lockPath, "");

	const contender = run(["task", "start", "after partial owner"], { cwd: dir });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(fs.existsSync(lockPath), "the grace period protects a just-created partial lock");
	fs.unlinkSync(lockPath);
	const started = await contender;

	assert.equal(started.code, 0, started.stdout + started.stderr);
	assert.equal(deriveTaskState(readLedger(dir)).state, "active");
});

test("an old malformed legacy lock is recovered after the bounded grace period", async () => {
	const { dir } = await tmpGitRepo();
	const lockPath = ledgerLockPath(dir);
	fs.writeFileSync(lockPath, "{not-json");
	const old = new Date(Date.now() - 5_000);
	fs.utimesSync(lockPath, old, old);

	const started = await run(["task", "start", "after malformed lock"], {
		cwd: dir,
	});
	assert.equal(started.code, 0, started.stdout + started.stderr);
	assert.ok(!fs.existsSync(lockPath));
	assert.equal(deriveTaskState(readLedger(dir)).state, "active");
});

test("a live ledger lock fails safely without stealing the owner lock", async () => {
	const { dir } = await tmpGitRepo();
	const lockPath = ledgerLockPath(dir);
	fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "a".repeat(32) }), {
		mode: 0o600,
	});
	const hookPath = path.join(tmpDir(), "advance-lock-clock.mjs");
	fs.writeFileSync(
		hookPath,
		`const realNow = Date.now;
let calls = 0;
Date.now = () => realNow() + calls++ * 20_000;
`,
	);

	const started = await run(["task", "start", "must not start"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(started.code, 1, started.stdout + started.stderr);
	assert.match(started.stderr, /ledger is busy/i);
	assert.ok(fs.existsSync(lockPath), "a contender never removes a live owner's lock");
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")));
	fs.unlinkSync(lockPath);
});

test("an in-flight recorder records nothing when its captured task changes", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "task A"], { cwd: dir });
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const taskA = readLedger(dir).find((event) => event.event === "task-start").id;
	const switchCode = [
		'const fs = require("node:fs");',
		`const ledger = ${JSON.stringify(ledgerPath)};`,
		`const branch = "feature";`,
		`fs.appendFileSync(ledger, JSON.stringify({ts:new Date().toISOString(),branch,event:"task-finish",taskId:${JSON.stringify(taskA)}})+"\\n");`,
		'fs.appendFileSync(ledger, JSON.stringify({ts:new Date().toISOString(),branch,event:"task-start",id:"task-b",name:"task B",planBaseline:null})+"\\n");',
	].join("");
	const recorded = await run(["verify", "--", "node", "-e", switchCode], {
		cwd: dir,
	});
	assert.equal(recorded.code, 1, recorded.stdout + recorded.stderr);
	assert.match(recorded.stderr, /active task changed/);
	const events = readLedger(dir);
	assert.equal(deriveTaskState(events).task.id, "task-b");
	assert.equal(events.filter((event) => event.event === "verify").length, 0);
});

test("red and verify record nothing when identity switches immediately before their commit lock", async (t) => {
	for (const kind of ["red", "verify"]) {
		for (const mode of ["task", "branch"]) {
			await t.test(`${kind}: ${mode} switch`, async () => {
				const { dir, git } = await tmpGitRepo();
				await run(["task", "start", "task A"], { cwd: dir });
				const command =
					kind === "red"
						? [kind, "--", "node", "-e", "process.exit(1)"]
						: [kind, "--", "node", "-e", ""];

				const recorded = await run(command, {
					cwd: dir,
					env: runCommitGapSwitchEnv(dir, mode),
				});

				assert.equal(recorded.code, 1, recorded.stdout + recorded.stderr);
				assert.match(recorded.stderr, mode === "task" ? /active task changed/ : /switched branches/);
				const events = readLedger(dir);
				assert.equal(events.filter((event) => event.event === kind).length, 0);
				if (mode === "task") {
					assert.equal(deriveTaskState(events).task.name, "task B");
				} else {
					assert.equal((await git("branch", "--show-current")).stdout.trim(), "run-hijack");
				}
			});
		}
	}
});

test("status reports a malformed task boundary instead of pretending it is legacy", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			branch: "feature",
			event: "task-start",
			name: "missing id",
		})}\n`,
	);
	const json = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(json.state, "invalid");
	assert.match(json.next, /malformed task boundary/);
	const human = await run(["status", "--local"], { cwd: dir });
	assert.match(human.stdout, /task:\s+invalid/);
	assert.doesNotMatch(human.stdout, /legacy branch-scoped state/);
});

test("status reports valid-JSON non-object ledger events as invalid instead of crashing", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "null\n");
	const result = await run(["status", "--local", "--json"], { cwd: dir });
	assert.equal(result.code, 0, result.stderr);
	const json = JSON.parse(result.stdout);
	assert.equal(json.state, "invalid");
	assert.match(json.next, /task event at index 0 must be a plain record object/);
});

test("status and gate reject a truncated task boundary instead of resurrecting legacy evidence", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			event: "docs",
			branch: "feature",
			decision: "checked",
			paths: ["docs/domain/pricing.md"],
			reason: "legacy evidence",
		})}\n{"event":"task-start","id":"task-truncated"`,
	);

	const status = await run(["status", "--local", "--json"], { cwd: dir });
	assert.equal(status.code, 0, status.stderr);
	const json = JSON.parse(status.stdout);
	assert.equal(json.state, "invalid");
	assert.match(json.next, /repair.*ledger\.jsonl/i);

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 1, gate.stdout + gate.stderr);
	assert.match(gate.stdout, /malformed task boundary/i);
	assert.match(gate.stdout, /repair.*ledger\.jsonl/i);
});

test("task-boundary branch filtering preserves malformed metadata and ignores valid foreign boundaries", async () => {
	const timestamp = "2026-07-25T12:34:56.789Z";
	const malformedLedgers = [
		[
			{ event: "note", branch: "feature", text: "legacy evidence" },
			{
				event: "task-start",
				id: "task-missing-branch",
				name: "missing branch",
				ts: timestamp,
				planBaseline: null,
			},
		],
		[
			{
				event: "task-start",
				id: "task-a",
				name: "A",
				branch: "feature",
				ts: timestamp,
				planBaseline: null,
			},
			{ event: "task-finish", taskId: "task-a", branch: "feature\nforged" },
		],
	];

	for (const events of malformedLedgers) {
		const { dir } = await tmpGitRepo();
		fs.writeFileSync(
			path.join(dir, ".stdd", "ledger.jsonl"),
			`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		);
		const result = await run(["status", "--local", "--json"], { cwd: dir });
		assert.equal(result.code, 0, result.stderr);
		const status = JSON.parse(result.stdout);
		assert.equal(status.state, "invalid");
		assert.match(status.next, /repair.*ledger\.jsonl/i);
	}

	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${[
			{ event: "note", branch: "feature", text: "current legacy evidence" },
			{
				event: "task-start",
				id: "task-other",
				name: "other branch task",
				branch: "other",
				ts: timestamp,
				planBaseline: null,
			},
		]
			.map((event) => JSON.stringify(event))
			.join("\n")}\n`,
	);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.state, "legacy");
});

test("clean base without current-branch events accepts the first legacy docs decision", async () => {
	for (const { existing, args, decision } of [
		{
			existing: [],
			args: ["docs", "checked", "docs/domain/pricing.md", "--reason", "existing rule covers the change"],
			decision: "checked",
		},
		{
			existing: [{ event: "note", branch: "other", text: "foreign state" }],
			args: ["docs", "not-applicable", "--reason", "implementation-only change"],
			decision: "not-applicable",
		},
	]) {
		const { dir, git } = await tmpGitRepo();
		await git("checkout", "-q", "main");
		if (existing.length > 0) {
			fs.writeFileSync(
				path.join(dir, ".stdd", "ledger.jsonl"),
				`${existing.map((event) => JSON.stringify(event)).join("\n")}\n`,
			);
		}

		const recorded = await run(args, { cwd: dir });
		assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
		assert.match(recorded.stderr, /recording branch-scoped legacy evidence/i);
		const event = readLedger(dir).find(
			(candidate) => candidate.branch === "main" && candidate.event === "docs",
		);
		assert.equal(event.decision, decision);
	}
});

test("clean base preserves the sequential taskless legacy recorder flow", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("checkout", "-q", "main");
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({ event: "note", branch: "other", text: "foreign state" })}\n`,
	);

	const recorded = [
		await run(
			["docs", "checked", "docs/domain/pricing.md", "--reason", "existing rule covers the change"],
			{ cwd: dir },
		),
		await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir }),
		await run(["verify", "--", "node", "-e", ""], { cwd: dir }),
		await run(["note", "legacy handoff"], { cwd: dir }),
	];
	assert.deepEqual(
		recorded.map((result) => result.code),
		[0, 1, 0, 0],
	);
	for (const result of recorded) {
		assert.match(result.stderr, /recording branch-scoped legacy evidence/i);
	}

	const currentEvents = readLedger(dir).filter((event) => event.branch === "main");
	assert.deepEqual(
		currentEvents.map((event) => event.event),
		["docs", "red", "verify", "note"],
	);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.state, "legacy");
	assert.equal(status.loop.docs.done, true);
	assert.equal(status.loop.red.done, true);
	assert.equal(status.loop.verify.done, true);

	const review = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(review.code, 1, review.stdout + review.stderr);
	assert.match(review.stderr, /no active task/);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-request"));
});

test("clean base branch ignores legacy unfinished state", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("checkout", "-q", "main");
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			event: "docs",
			branch: "main",
			decision: "checked",
			paths: ["docs/domain/pricing.md"],
			reason: "previous task",
		})}\n`,
	);
	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "- [x] previous task closing review [review:]\n");
	const status = await run(["status", "--local"], { cwd: dir });
	assert.equal(status.code, 0);
	assert.match(status.stdout, /task:\s+idle/);
	assert.ok(!status.stdout.includes("previous task"));

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
	const evidence = await run(["evidence"], { cwd: dir });
	assert.equal(evidence.code, 1, "old docs evidence is not inherited on a clean base branch");
	const review = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(review.code, 1, review.stdout + review.stderr);
	assert.match(review.stderr, /no active task/);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-request"));
});

test("clean base detection preserves slashes in branch names", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("checkout", "-qb", "release/1.x", "main");
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "origin/release/1.x" }),
	);
	await git("add", ".stdd/config.json");
	await git("commit", "-qm", "release config");
	await git("update-ref", "refs/remotes/origin/release/1.x", "HEAD");
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({ event: "note", branch: "release/1.x", text: "old state" })}\n`,
	);
	const status = await run(["status", "--local"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
	assert.match(status.stdout, /task:\s+idle/);
});

test("clean base detection does not confuse a branch with a base-ref suffix", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "origin/release/1.x" }),
	);
	await git("add", ".stdd/config.json");
	await git("commit", "-qm", "remote release base");
	await git("update-ref", "refs/remotes/origin/release/1.x", "HEAD");
	await git("checkout", "-qb", "1.x");
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({ event: "note", branch: "1.x", text: "branch-scoped state" })}\n`,
	);

	const status = await run(["status", "--local"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
	assert.match(status.stdout, /task:\s+legacy branch-scoped state/);
});

// --- recorders ---

test("stdd docs updated-first records the decision with branch and paths", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "updated-first", "docs/domain/pricing.md"], {
		cwd: dir,
	});
	assert.equal(res.code, 0);
	assert.match(res.stderr, /stdd task start/, "legacy recording is explicit, not silent");
	const [event] = readLedger(dir);
	assert.equal(event.event, "docs");
	assert.equal(event.decision, "updated-first");
	assert.deepEqual(event.paths, ["docs/domain/pricing.md"]);
	assert.equal(event.branch, "feature");
	assert.ok(event.ts);
});

test("stdd docs records nothing when the active task changes during its snapshot", async () => {
	const { dir } = await tmpGitRepo();
	const started = await run(["task", "start", "task A"], { cwd: dir });
	assert.equal(started.code, 0, started.stderr);
	const trigger = path.join(dir, "race-trigger.txt");
	fs.writeFileSync(trigger, "trigger\n");

	const res = await run(["docs", "updated-first", "docs/domain/pricing.md"], {
		cwd: dir,
		env: switchTaskWhenFileOpens({ cli: CLI, dir, trigger }),
	});

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /active task changed/);
	const events = readLedger(dir);
	assert.equal(events.filter((event) => event.event === "docs").length, 0);
	const active = deriveTaskState(events);
	assert.equal(active.state, "active");
	assert.equal(active.task.name, "task B");
});

test("stdd docs records nothing when the branch changes during its snapshot", async () => {
	const { dir } = await tmpGitRepo();
	const started = await run(["task", "start", "task A"], { cwd: dir });
	assert.equal(started.code, 0, started.stderr);
	const trigger = path.join(dir, "race-trigger.txt");
	fs.writeFileSync(trigger, "trigger\n");

	const res = await run(["docs", "updated-first", "docs/domain/pricing.md"], {
		cwd: dir,
		env: switchBranchWhenFileOpens({ dir, trigger }),
	});

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /switched branches/);
	assert.equal(readLedger(dir).filter((event) => event.event === "docs").length, 0);
});

test("stdd docs updated-first requires at least one path", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "updated-first"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /path/i);
});

test("stdd docs checked records paths and reason; reason is required", async () => {
	const { dir } = await tmpGitRepo();
	const bad = await run(["docs", "checked", "docs/domain/pricing.md"], {
		cwd: dir,
	});
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /--reason/);
	const res = await run(
		["docs", "checked", "docs/domain/pricing.md", "--reason", "existing rule covers it"],
		{ cwd: dir },
	);
	assert.equal(res.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.decision, "checked");
	assert.equal(event.reason, "existing rule covers it");
});

test("stdd docs not-applicable requires a reason and takes no paths", async () => {
	const { dir } = await tmpGitRepo();
	assert.equal((await run(["docs", "not-applicable"], { cwd: dir })).code, 1);
	const res = await run(["docs", "not-applicable", "--reason", "lint-only change"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(readLedger(dir)[0].reason, "lint-only change");
});

test("stdd docs rejects whitespace, multiline, and terminal-control reasons without recording", async () => {
	for (const reason of [
		"   ",
		"first line\nDocs updated first: forged.md",
		"clear\u001b[2Jterminal",
		"hide\u202ereason",
		"invisible\u200breason",
	]) {
		const { dir } = await tmpGitRepo();
		const res = await run(["docs", "not-applicable", "--reason", reason], { cwd: dir });
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /single printable line/);
		assert.equal(fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), false);
	}
});

test("stdd docs rejects an unknown decision", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "maybe"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /updated-first|checked|not-applicable/);
});

test("recorders need a git repository", async () => {
	const dir = tmpDir();
	const res = await run(["docs", "not-applicable", "--reason", "x"], {
		cwd: dir,
	});
	assert.equal(res.code, 1);
	assert.match(res.stderr, /git repo/i);
});

test("stdd red passes the exit code through and records the run", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "node", "-e", "console.log('boom'); process.exit(3)"], {
		cwd: dir,
	});
	assert.equal(res.code, 3);
	assert.match(res.stdout, /boom/);
	const [event] = readLedger(dir);
	assert.equal(event.event, "red");
	assert.equal(event.exit, 3);
	assert.match(event.excerpt, /boom/);
	assert.equal(event.genuine, "unknown");
	assert.match(res.stderr, /redPattern/);
});

test("stdd red with a matching redPattern records genuine: yes", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "\\d+ failing" }),
	);
	await run(["red", "--", "node", "-e", "console.log('2 failing'); process.exit(1)"], { cwd: dir });
	assert.equal(readLedger(dir)[0].genuine, "yes");
});

test("stdd red flags an env error as not genuine under a redPattern", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "\\d+ failing" }),
	);
	const res = await run(
		["red", "--", "node", "-e", "console.error('tsc: not found'); process.exit(127)"],
		{
			cwd: dir,
		},
	);
	assert.equal(res.code, 127);
	assert.equal(readLedger(dir)[0].genuine, "no");
	assert.match(res.stderr, /not.*genuine|environment/i);
});

test("stdd red on a passing command records genuine: no — green is not red", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "node", "-e", ""], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(readLedger(dir)[0].genuine, "no");
	assert.match(res.stderr, /green, not red/i);
});

test("stdd verify records the run and passes the exit through", async () => {
	const { dir } = await tmpGitRepo();
	const ok = await run(["verify", "--", "node", "-e", "console.log('61 passing')"], { cwd: dir });
	assert.equal(ok.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.event, "verify");
	assert.equal(event.exit, 0);
	assert.match(event.excerpt, /61 passing/);
});

test("stdd red and verify require a command after --", async () => {
	const { dir } = await tmpGitRepo();
	assert.equal((await run(["red"], { cwd: dir })).code, 1);
	assert.equal((await run(["verify", "--"], { cwd: dir })).code, 1);
});

test("stdd note appends free-form handoff context", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["note", "workaround: build api before webapp typecheck"], { cwd: dir });
	assert.equal(res.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.event, "note");
	assert.match(event.text, /workaround/);
});

// --- root anchoring: the ledger and config belong to the repo, not the cwd ---

test("recorders run from a subdirectory write the root ledger", async () => {
	const { dir } = await tmpGitRepo();
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(sub, { recursive: true });
	const res = await run(["red", "--", "node", "-e", "process.exit(1)"], {
		cwd: sub,
	});
	assert.equal(res.code, 1);
	assert.ok(!fs.existsSync(path.join(sub, ".stdd")), "no nested apps/api/.stdd may appear");
	assert.equal(readLedger(dir)[0].event, "red");
});

test("recorders read the root config (redPattern) from a subdirectory", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "\\d+ failing" }),
	);
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(sub, { recursive: true });
	await run(["red", "--", "node", "-e", "console.log('2 failing'); process.exit(1)"], { cwd: sub });
	assert.equal(readLedger(dir)[0].genuine, "yes");
});

test("status from a subdirectory reads the root ledger", async () => {
	const { dir } = await tmpGitRepo();
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(sub, { recursive: true });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: sub, env })).stdout);
	assert.equal(s.loop.red.done, true);
});

test("human status visibly escapes multiline and terminal-control commands", async () => {
	const { dir } = await tmpGitRepo();
	const redScript = "process.exitCode = 1;\n//\u001b[2JFORGED_RED";
	const red = await run(["red", "--", "node", "-e", redScript], { cwd: dir });
	assert.equal(red.code, 1, red.stdout + red.stderr);
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation\n");
	const verifyScript = "//\u202eFORGED_VERIFY\n";
	const verify = await run(["verify", "--", "node", "-e", verifyScript], { cwd: dir });
	assert.equal(verify.code, 0, verify.stdout + verify.stderr);

	const status = await run(["status", "--local"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
	assert.ok(!status.stdout.includes("\u001b"));
	assert.ok(!status.stdout.includes("\u202e"));
	assert.match(status.stdout, /\\u000a/);
	assert.match(status.stdout, /\\u001b/);
	assert.match(status.stdout, /\\u202e/);
});

test("a leftover nested .stdd does not win over the toplevel's", async () => {
	const { dir } = await tmpGitRepo();
	const sub = path.join(dir, "apps", "api");
	fs.mkdirSync(path.join(sub, ".stdd"), { recursive: true });
	await run(["note", "anchored"], { cwd: sub });
	assert.equal(readLedger(dir)[0].text, "anchored");
	assert.ok(!fs.existsSync(path.join(sub, ".stdd", "ledger.jsonl")));
});

test("without a toplevel .stdd, the nearest ancestor holding one wins", async () => {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	const pkg = path.join(dir, "packages", "a");
	fs.mkdirSync(path.join(pkg, ".stdd"), { recursive: true });
	fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "root.txt"), "x\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	const res = await run(["note", "package-scoped"], {
		cwd: path.join(pkg, "src"),
	});
	assert.equal(res.code, 0);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd")), "the toplevel gains no .stdd");
	const events = parseLedger(fs.readFileSync(path.join(pkg, ".stdd", "ledger.jsonl"), "utf8"));
	assert.equal(events[0].text, "package-scoped");
});

// --- status ---

test("status reads the loop from git and the ledger, and names the next step", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const before = await run(["status", "--json"], { cwd: dir, env });
	assert.equal(before.code, 0);
	const s1 = JSON.parse(before.stdout);
	assert.equal(s1.state, "legacy");
	assert.equal(s1.branch, "feature");
	assert.equal(s1.loop.docs.done, true); // canonical docs changed in the diff
	assert.equal(s1.loop.red.done, false);
	assert.equal(s1.loop.impl.done, false); // implementation is ordered after red
	assert.equal(s1.loop.verify.done, false);
	assert.match(s1.next, /stdd red/);

	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implemented after red\n");
	const mid = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(mid.loop.red.done, true);
	assert.match(mid.next, /stdd verify/);

	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const done = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(done.loop.verify.done, true);
	assert.equal(done.pr.state, "none");
	assert.match(done.next, /evidence|pr/i);
});

test("status never counts a passing or non-genuine red as proof", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["red", "--", "node", "-e", ""], { cwd: dir });
	const passing = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(passing.loop.red.done, false);

	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "real test failure" }),
	);
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	const envError = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(envError.loop.red.done, false);
});

test("status binds implementation and verify to checkout snapshots", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	const beforeImpl = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(
		beforeImpl.loop.impl.done,
		false,
		"changes that predate red are not implementation proof",
	);

	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	const afterImpl = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(afterImpl.loop.impl.done, true);
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const verified = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(verified.loop.verify.done, true);

	fs.appendFileSync(path.join(dir, "impl.js"), "// changed after verify\n");
	const stale = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(stale.loop.verify.done, false);
	assert.equal(stale.loop.verify.stale, true);
	assert.match(stale.next, /verify/i);
});

test("status rejects a docs decision contradicted by the current checkout", async () => {
	const { dir, git } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "revert docs");

	const status = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(status.loop.docs.done, false);
	assert.equal(status.loop.docs.stale, true);
	assert.match(status.next, /docs decision/i);
});

test("status names the fresh reviewer ahead of the evidence line", async () => {
	const { dir } = await tmpGitRepo(); // default capabilities: subagents on
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.match(s.next, /fresh reviewer.*stdd evidence/s);

	// with every dispatch route off, the suggestion is omitted — never
	// degraded to self-review
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: { subagents: false, crossCli: false, worktrees: false },
		}),
	);
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const off = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.ok(!/reviewer/.test(off.next), off.next);
	assert.match(off.next, /stdd evidence/);
});

test("a plan whose checked review item closed the loop is not asked to review twice", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] implement the thing\n- [x] independent review (fresh reviewer)\n",
	);
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.plan.review.done, true);
	assert.ok(!/reviewer/.test(s.next), s.next);
	assert.match(s.next, /stdd evidence/);

	// only the LAST item can be the closing review — a mid-plan step that
	// merely mentions "review" never suppresses the fresh-reviewer prompt
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] review requirements with product\n- [x] implement the thing\n",
	);
	const mid = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(mid.plan.review.present, false);
	assert.match(mid.next, /fresh reviewer/);
});

test("status ignores ledger events from other branches", async () => {
	const { dir, git } = await tmpGitRepo();
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	await git("checkout", "-qb", "other");
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.branch, "other");
	assert.equal(s.loop.red.done, false);
});

test("a verify recorded before the last red does not count", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.loop.verify.done, false);
});

test("status reports the branch PR and its check rollup via gh", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh(
		`cat <<'EOF'
{"number": 42, "url": "https://example.test/pr/42", "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}]}
EOF`,
	);
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.pr.state, "open");
	assert.equal(s.pr.number, 42);
	assert.equal(s.pr.checks.failure, 1);
	assert.match(s.next, /check|green/i);
});

test("status degrades to unknown when gh is unavailable", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh("exit 4"); // gh present but erroring unexpectedly
	const res = await run(["status", "--json"], { cwd: dir, env });
	assert.equal(res.code, 0);
	assert.equal(JSON.parse(res.stdout).pr.state, "unknown");
});

test("status --local never invokes the forge adapter", async () => {
	const { dir } = await tmpGitRepo();
	const marker = path.join(tmpDir(), "gh-called");
	const env = fakeGh(`touch "${marker}"; exit 99`);
	const res = await run(["status", "--local"], { cwd: dir, env });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /pr:\s+unknown \(local mode\)/);
	assert.ok(!fs.existsSync(marker), "the gh process was never spawned");
});

test("status human output is one screen ordered as the loop", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const res = await run(["status"], { cwd: dir, env });
	assert.equal(res.code, 0);
	const order = ["docs", "red", "impl", "verify", "pr:", "next:"];
	let last = -1;
	for (const token of order) {
		const idx = res.stdout.indexOf(token);
		assert.ok(idx > last, `"${token}" out of order in:\n${res.stdout}`);
		last = idx;
	}
});

// --- derivation: evidence and check-pr read the ledger ---

test("evidence prints the finished line from a recorded sentinel decision", async () => {
	const { dir, git } = await tmpGitRepo();
	// undo the docs change so the diff carries no canonical docs
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "revert docs");
	await run(["docs", "checked", "docs/domain/pricing.md", "--reason", "rule already covers it"], {
		cwd: dir,
	});
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(
		res.stdout.trim(),
		"Docs checked, no change needed: docs/domain/pricing.md — rule already covers it",
	);
});

test("evidence: the diff wins over a contradicted ledger claim", async () => {
	const { dir } = await tmpGitRepo();
	// ledger says not-applicable, but the diff changes a canonical doc
	await run(["docs", "not-applicable", "--reason", "just lint"], { cwd: dir });
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(res.stdout.trim(), "Docs updated first: docs/domain/pricing.md");
	assert.match(res.stderr, /ledger|contradict/i);
});

test("evidence without a ledger behaves exactly as before", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["evidence", "--base", "main"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.equal(res.stdout.trim(), "Docs updated first: docs/domain/pricing.md");
});

test("check-pr adds an advisory line when the body disagrees with the ledger", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs not applicable: implementation-only\n");
	const res = await run(["check-pr", body], { cwd: dir });
	assert.equal(res.code, 0, "advisory only — the gate's pass condition is unchanged");
	assert.match(res.stderr, /ledger/i);
	assert.match(res.stderr, /updated-first/);
});

test("check-pr stays silent when the body matches the recorded decision", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "updated-first", "docs/domain/pricing.md"], { cwd: dir });
	const body = path.join(dir, "pr.md");
	fs.writeFileSync(body, "Docs updated first: docs/domain/pricing.md\n");
	const res = await run(["check-pr", body], { cwd: dir });
	assert.equal(res.code, 0);
	assert.ok(!/ledger/i.test(res.stderr), res.stderr);
});

// --- init ---

test("init gitignores the ledger", async () => {
	const dir = tmpDir();
	await exec("git", ["-C", dir, "init", "-q"]);
	const res = await run(["init", dir, "--tools", "codex"]);
	assert.equal(res.code, 0);
	const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.match(ignore, /^\.stdd\/ledger\.jsonl$/m);
	assert.ok(!ignore.split("\n").includes(RESET_TEMP_IGNORE));
	assert.ok(!ignore.split("\n").includes(".stdd/.ledger-reset-*.tmp"));
	// idempotent: a second init adds no duplicate
	await run(["init", dir, "--tools", "codex"]);
	const again = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.equal(again.match(/ledger\.jsonl/g).length, 1);
	assert.equal(again.split("\n").filter((line) => line === RESET_TEMP_IGNORE).length, 0);
});

test("init removes reset-temp ignore rules so shape and every near miss stay observable", async () => {
	const dir = tmpDir();
	await exec("git", ["-C", dir, "init", "-q"]);
	fs.writeFileSync(path.join(dir, ".gitignore"), ".stdd/.ledger-reset-*.tmp\n");
	await run(["init", dir, "--tools", "codex"]);
	const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.ok(!ignore.split("\n").includes(RESET_TEMP_IGNORE));
	assert.ok(!ignore.split("\n").includes(".stdd/.ledger-reset-*.tmp"));

	const exact = `.stdd/.ledger-reset-${"a".repeat(32)}.tmp`;
	const nearMisses = [
		`.stdd/.ledger-reset-${"a".repeat(31)}.tmp`,
		`.stdd/.ledger-reset-${"a".repeat(33)}.tmp`,
		`.stdd/.ledger-reset-${"A".repeat(32)}.tmp`,
		`.stdd/.ledger-reset-${"g".repeat(32)}.tmp`,
		`.stdd/.ledger-reset-${"a".repeat(32)}.tmp.extra`,
	];
	for (const relative of [exact, ...nearMisses]) {
		const target = path.join(dir, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "candidate\n");
	}
	const status = (
		await exec("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], {
			encoding: "utf8",
		})
	).stdout;
	assert.ok(status.includes(exact), "git must expose the exact name for runtime shape validation");
	for (const relative of nearMisses) assert.match(status, new RegExp(relative.replaceAll(".", "\\.")));
});

// --- forgiving errors: recorders hint the corrected form ---

test("stdd docs with free text prints the three forms and a did-you-mean", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "updated-first: docs/domain/pricing.md (auto-release)"], {
		cwd: dir,
	});
	assert.equal(res.code, 1);
	assert.match(res.stderr, /did you mean.*stdd docs updated-first/s);
	assert.match(res.stderr, /stdd docs updated-first <paths…>/);
	assert.match(res.stderr, /stdd docs checked <paths…> --reason <why>/);
	assert.match(res.stderr, /stdd docs not-applicable --reason <why>/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing is recorded");
});

test("stdd docs not-applicable with a path suggests moving it into --reason", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["docs", "not-applicable", "lint-only cleanup"], {
		cwd: dir,
	});
	assert.equal(res.code, 1);
	assert.match(res.stderr, /stdd docs not-applicable --reason/);
});

test("stdd red rejects prose after -- and records nothing", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "vitest: 3 api + 1 admin red tests"], {
		cwd: dir,
	});
	assert.equal(res.code, 1);
	assert.match(res.stderr, /command and its arguments, never prose|not prose/i);
	assert.match(res.stderr, /sh -c/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing is recorded");
});

test("stdd red on a missing command records the env error and hints readiness", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["red", "--", "definitely-not-a-command-xyz"], {
		cwd: dir,
	});
	assert.equal(res.code, 127);
	assert.equal(readLedger(dir)[0].exit, 127);
	assert.match(res.stderr, /doctor --readiness/);
});

// --- status: a declared slice is part of the loop's state ---

test("status reports a declared slice and names the postflight", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	await run(["slice", "new", "--frozen", "docs/**", "--allowed", "src/**"], {
		cwd: dir,
	});
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "slice.js"), "export {};\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });

	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.slice.declared, true);
	assert.deepEqual(s.slice.frozenPaths, ["docs/**"]);
	assert.deepEqual(s.slice.allowedPaths, ["src/**"]);
	assert.match(s.next, /stdd scope/);

	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /slice: {2}declared \(frozen: docs\/\*\*; allowed: src\/\*\*\)/);
	assert.match(human.stdout, /postflight: stdd scope/);
});

test("status without a slice reports declared: false and stays quiet", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.slice.declared, false);
	const human = await run(["status"], { cwd: dir, env });
	assert.ok(!/slice:/.test(human.stdout), "no slice line when none is declared");
});

// --- the durable plan: status reads .stdd/plan.md; stdd defer ---

test("status reports plan progress and names the next plan item after verify", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# Plan\n\n- [x] 1. docs edit\n- [x] 2. impl\n- [ ] 3. wire status output\n",
	);
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	// complete the loop so the oracle reaches the plan before "open the PR"
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const res = await run(["status", "--json"], { cwd: dir, env });
	assert.equal(res.code, 0);
	const s = JSON.parse(res.stdout);
	assert.equal(s.plan.present, true);
	assert.equal(s.plan.total, 3);
	assert.equal(s.plan.done, 2);
	assert.equal(s.plan.next.text, "3. wire status output");
	assert.match(s.next, /plan/);
	assert.match(s.next, /3\. wire status output/);

	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /plan: {3}2\/3 done — next: "3\. wire status output"/);
});

test("status reports the plan's declared Mode line; absent line stays silent", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# Plan\n\nMode: inline\n\n- [x] 1. docs\n- [ ] 2. impl\n",
	);
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.plan.mode, "inline");
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /plan: {3}1\/2 done \[mode: inline\] — next: "2\. impl"/);

	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] 1. impl\n");
	const s2 = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s2.plan.mode, null);
	const human2 = await run(["status"], { cwd: dir, env });
	assert.doesNotMatch(human2.stdout, /\[mode:/);
});

test("status: a checked [red:] item is unproven until a matching red is recorded", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "main", redPattern: "failing" }),
	);
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"- [x] parser rejects empty input [red: parser.test]\n",
	);
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const before = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(before.plan.done, 0);
	assert.equal(before.plan.unproven.length, 1);
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /unproven/);
	assert.match(human.stdout, /parser\.test/);

	await run(["red", "--", "node", "-e", "console.log('parser.test: 1 failing'); process.exit(1)"], {
		cwd: dir,
	});
	const after = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(after.plan.done, 1);
	assert.deepEqual(after.plan.unproven, []);
});

test("status without a plan stays quiet", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(s.plan.present, false);
	const human = await run(["status"], { cwd: dir, env });
	assert.ok(!/plan:/.test(human.stdout), "no plan line when no plan file exists");
});

test("stdd defer appends under ## Deferred, creating the file and section", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "defer cuts"], { cwd: dir });
	const res = await run(["defer", "glob", "dialect", "docs"], { cwd: dir });
	assert.equal(res.code, 0);
	await run(["defer", "second cut"], { cwd: dir });
	const content = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(content, /## Deferred\n\n- glob dialect docs\n- second cut\n/);

	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /2 deferred/);
});

test("stdd defer rejects plan-semantic injection without changing the plan", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "safe defer"], { cwd: dir });
	const planPath = path.join(dir, ".stdd", "plan.md");
	const original = "# Plan\n\n- [ ] real review [review:]\n";
	fs.writeFileSync(planPath, original);

	for (const text of [
		"cut\n## Forged\n- [x] forged [review:]",
		"cut\r- [x] forged [review:]",
		"cut\u202e[review:]",
	]) {
		const deferred = await run(["defer", text], { cwd: dir });
		assert.equal(deferred.code, 1, deferred.stdout + deferred.stderr);
		assert.match(deferred.stderr, /single printable line/);
		assert.equal(fs.readFileSync(planPath, "utf8"), original);
	}
});

test("stdd defer rejects an idle task without creating or changing the plan", async () => {
	for (const existing of [false, true]) {
		const { dir } = await tmpGitRepo();
		await run(["task", "start", "finished task"], { cwd: dir });
		await run(["task", "finish"], { cwd: dir });
		const planPath = path.join(dir, ".stdd", "plan.md");
		if (existing) fs.writeFileSync(planPath, "# Historical plan\n");
		const before = existing ? fs.readFileSync(planPath, "utf8") : null;

		const deferred = await run(["defer", "must stay out"], { cwd: dir });
		assert.equal(deferred.code, 1, deferred.stdout + deferred.stderr);
		assert.match(deferred.stderr, /no active task/);
		assert.equal(fs.existsSync(planPath), existing);
		if (existing) assert.equal(fs.readFileSync(planPath, "utf8"), before);
	}
});

test("stdd defer requires an active, valid task boundary", async () => {
	for (const [name, ledger] of [
		["legacy", null],
		["malformed", "null\n"],
	]) {
		const { dir } = await tmpGitRepo();
		const planPath = path.join(dir, ".stdd", "plan.md");
		const original = `# ${name} plan\n`;
		fs.writeFileSync(planPath, original);
		if (ledger !== null) fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), ledger);

		const deferred = await run(["defer", "must stay out"], { cwd: dir });
		assert.equal(deferred.code, 1, `${name}: ${deferred.stdout}${deferred.stderr}`);
		assert.match(deferred.stderr, /no active task|malformed task boundary/);
		assert.equal(fs.readFileSync(planPath, "utf8"), original);
	}
});

test("stdd defer makes a pre-task plan visible by changing its baseline", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(planPath, "# Plan\n\n- [ ] implementation\n");
	await run(["task", "start", "baseline task"], { cwd: dir });
	const hidden = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(hidden.plan.present, false);

	const deferred = await run(["defer", "later follow-up"], { cwd: dir });
	assert.equal(deferred.code, 0, deferred.stdout + deferred.stderr);
	const visible = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(visible.plan.present, true);
	assert.equal(visible.plan.deferred, 1);
	assert.match(fs.readFileSync(planPath, "utf8"), /## Deferred\n\n- later follow-up/);
});

test("stdd defer changes no plan when the active task switches during its read", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "task A"], { cwd: dir });
	const planPath = path.join(dir, ".stdd", "plan.md");
	const original = "# Task A plan\n\n- [ ] implementation\n";
	fs.writeFileSync(planPath, original);

	const deferred = await run(["defer", "must not reach task B"], {
		cwd: dir,
		env: switchTaskWhenFileOpens({ cli: CLI, dir, trigger: planPath }),
	});
	assert.equal(deferred.code, 1, deferred.stdout + deferred.stderr);
	assert.match(deferred.stderr, /active task changed/);
	assert.equal(fs.readFileSync(planPath, "utf8"), original);
	assert.equal(deriveTaskState(readLedger(dir)).task.name, "task B");
});

test("stdd defer changes no plan when the branch switches during its read", async () => {
	const { dir, git } = await tmpGitRepo();
	await run(["task", "start", "task A"], { cwd: dir });
	const planPath = path.join(dir, ".stdd", "plan.md");
	const original = "# Task A plan\n\n- [ ] implementation\n";
	fs.writeFileSync(planPath, original);

	const deferred = await run(["defer", "must not reach another branch"], {
		cwd: dir,
		env: switchBranchWhenFileOpens({ dir, trigger: planPath }),
	});
	assert.equal(deferred.code, 1, deferred.stdout + deferred.stderr);
	assert.match(deferred.stderr, /switched branches/);
	assert.equal(fs.readFileSync(planPath, "utf8"), original);
	assert.equal((await git("branch", "--show-current")).stdout.trim(), "race-branch");
});

// --- stdd ci: the settlement wait, head-pinned, stable-set threshold ---

/** Stateful fake gh: responses[i] answers call i+1; the last one repeats. */
function fakeGhSequence(responses) {
	const bin = tmpDir();
	const state = path.join(bin, "state");
	const cases = responses.map((json, i) => `${i + 1}) cat <<'EOF'\n${json}\nEOF\n;;`).join("\n");
	const script = [
		"#!/bin/sh",
		`n=$(cat "${state}" 2>/dev/null || echo 0)`,
		"n=$((n+1))",
		`echo $n > "${state}"`,
		`[ $n -gt ${responses.length} ] && n=${responses.length}`,
		"case $n in",
		cases,
		"esac",
	].join("\n");
	fs.writeFileSync(path.join(bin, "gh"), `${script}\n`, { mode: 0o755 });
	return {
		...process.env,
		PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
	};
}

const rollup = (head, checks) =>
	JSON.stringify({
		number: 7,
		url: "https://example.test/pr/7",
		headRefOid: head,
		statusCheckRollup: checks,
	});
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const passed = (name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });
const failedCheck = (name) => ({
	name,
	status: "COMPLETED",
	conclusion: "FAILURE",
});
const running = (name) => ({ name, status: "IN_PROGRESS", conclusion: "" });
const context = (name, state) => ({ context: name, state });

test("stdd ci reports the current head's checks and exits 0 on settled green", async () => {
	const { dir } = await tmpGitRepo();
	const head = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
	const env = fakeGhSequence([rollup(head, [passed("Lint"), context("GitGuardian", "SUCCESS")])]);
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /✓ Lint/);
	assert.match(res.stdout, /✓ GitGuardian/);
	assert.match(res.stdout, /green \(2 checks\)/);
	assert.ok(!/differs/.test(res.stderr), "no head warning when local HEAD matches");
});

test("stdd ci exits 1 on a terminal failure and warns when the local HEAD differs", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([rollup(HEAD_A, [passed("Lint"), failedCheck("Test")])]);
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stdout, /✗ Test/);
	assert.match(res.stderr, /1 failing/);
	assert.match(res.stderr, /differs/);
});

test("stdd ci one-shot with pending checks is not settled", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([rollup(HEAD_A, [passed("Lint"), running("Test")])]);
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /not settled/);
	assert.match(res.stderr, /--watch/);
});

test("stdd ci --watch never settles on the first sighting of a check set", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([
		rollup(HEAD_A, [passed("Lint")]),
		rollup(HEAD_A, [passed("Lint"), passed("Test")]),
		rollup(HEAD_A, [passed("Lint"), passed("Test")]),
	]);
	const res = await run(["ci", "--watch", "--interval", "0"], {
		cwd: dir,
		env,
	});
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /green \(2 checks\)/, "settled on the full set, not the early partial one");
});

test("stdd ci --watch exits the moment a check fails terminally", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([
		rollup(HEAD_A, [running("Lint"), running("Test")]),
		rollup(HEAD_A, [passed("Lint"), failedCheck("Test")]),
	]);
	const res = await run(["ci", "--watch", "--interval", "0"], {
		cwd: dir,
		env,
	});
	assert.equal(res.code, 1);
	assert.match(res.stderr, /failing/);
});

test("stdd ci --watch restarts when the PR head moves", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([
		rollup(HEAD_A, [passed("Lint")]),
		rollup(HEAD_B, [passed("Lint")]),
		rollup(HEAD_B, [passed("Lint")]),
		rollup(HEAD_B, [passed("Lint")]),
	]);
	const res = await run(["ci", "--watch", "--interval", "0"], {
		cwd: dir,
		env,
	});
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /head moved/);
	assert.match(res.stdout, new RegExp(HEAD_B.slice(0, 7)));
});

test("stdd ci --watch times out with pending checks named", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGhSequence([rollup(HEAD_A, [running("Lint")])]);
	const res = await run(["ci", "--watch", "--interval", "0", "--timeout", "0"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /timed out/);
	assert.match(res.stderr, /Lint/);
});

test("stdd ci --watch: a cancelled twin next to a live re-run is not a red", async () => {
	const { dir } = await tmpGitRepo();
	const cancelled = {
		name: "Policy",
		status: "COMPLETED",
		conclusion: "CANCELLED",
		startedAt: "2026-07-19T10:00:00Z",
	};
	const rerunLive = {
		name: "Policy",
		status: "IN_PROGRESS",
		conclusion: "",
		startedAt: "2026-07-19T10:05:00Z",
	};
	const rerunDone = {
		name: "Policy",
		status: "COMPLETED",
		conclusion: "SUCCESS",
		startedAt: "2026-07-19T10:05:00Z",
	};
	const env = fakeGhSequence([
		rollup(HEAD_A, [cancelled, rerunLive]),
		rollup(HEAD_A, [cancelled, rerunDone]),
		rollup(HEAD_A, [cancelled, rerunDone]),
	]);
	const res = await run(["ci", "--watch", "--interval", "0"], {
		cwd: dir,
		env,
	});
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /green \(1 checks\)/);
});

test("stdd ci one-shot dedupes re-run duplicates in the summary count", async () => {
	const { dir } = await tmpGitRepo();
	const old = {
		name: "Lint",
		status: "COMPLETED",
		conclusion: "SUCCESS",
		startedAt: "2026-07-19T09:00:00Z",
	};
	const fresh = {
		name: "Lint",
		status: "COMPLETED",
		conclusion: "SUCCESS",
		startedAt: "2026-07-19T10:00:00Z",
	};
	const env = fakeGhSequence([rollup(HEAD_A, [old, fresh])]);
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /green \(1 checks\)/);
});

test("stdd ci without a PR fails with a pointer, not a stack", async () => {
	const { dir } = await tmpGitRepo();
	const env = fakeGh('echo "no pull requests found" >&2; exit 1');
	const res = await run(["ci"], { cwd: dir, env });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no PR for the current branch/);
});

test("init gitignores the plan alongside the ledger", async () => {
	const dir = tmpDir();
	await exec("git", ["-C", dir, "init", "-q"]);
	await run(["init", dir, "--tools", "codex"]);
	const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.match(ignore, /^\.stdd\/plan\.md$/m);
	assert.match(ignore, /^\.stdd\/ledger\.jsonl$/m);
	assert.match(ignore, /^\.stdd\/worker\.json$/m);
	assert.match(ignore, /^\.stdd\/worker-deletions\/$/m);
	assert.ok(!ignore.split("\n").includes(RESET_TEMP_IGNORE));
	// an older checkout that already ignores the ledger gains the plan and
	// private transaction-temp lines.
	fs.writeFileSync(path.join(dir, ".gitignore"), ".stdd/ledger.jsonl\n");
	await run(["init", dir, "--tools", "codex"]);
	const upgraded = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
	assert.equal(upgraded.match(/ledger\.jsonl/g).length, 1);
	assert.match(upgraded, /^\.stdd\/plan\.md$/m);
	assert.match(upgraded, /^\.stdd\/worker\.json$/m);
	assert.match(upgraded, /^\.stdd\/worker-deletions\/$/m);
	assert.ok(!upgraded.split("\n").includes(RESET_TEMP_IGNORE));
});
