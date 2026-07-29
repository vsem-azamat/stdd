import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseLedger } from "../cli/lib.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");
const REVIEW_TEST_TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-suite-"));

// Keep every repository, stub, FIFO, quarantine, and private brief created by
// this worker under one owned root. The worker-local environment is inherited
// by CLI children, and one teardown prevents repeated suites from exhausting
// the host's shared /tmp inode pool.
process.env.TMPDIR = REVIEW_TEST_TMP_ROOT;
after(() => {
	fs.rmSync(REVIEW_TEST_TMP_ROOT, {
		recursive: true,
		force: true,
		maxRetries: 3,
		retryDelay: 20,
	});
});

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return {
			code: err.code ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
}

async function waitForPath(filePath, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const ALL_CAPS = { subagents: true, crossCli: true, worktrees: true };

async function tmpGitRepo(capabilities = ALL_CAPS, review) {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities,
			...(review ? { review } : {}),
		}),
	);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 1;\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2;\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [ ] closing review [review:]\n",
	);
	return { dir, git };
}

function readLedger(dir) {
	return parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
}

function privateStateFor(briefDir) {
	const identity = (candidate) => {
		const stat = fs.lstatSync(candidate, { bigint: true });
		return Object.fromEntries(
			["dev", "ino", "uid", "mode", "nlink"].map((field) => [field, stat[field].toString()]),
		);
	};
	return {
		version: 1,
		tempRoot: identity(path.resolve(os.tmpdir())),
		directory: identity(briefDir),
		artifacts: Object.fromEntries(
			fs
				.readdirSync(briefDir)
				.filter((name) => name.endsWith(".md") || name === "last-message.txt")
				.sort()
				.map((name) => [name, identity(path.join(briefDir, name))]),
		),
	};
}

function replaceReviewFixtureFile(filePath, content) {
	const original = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		fs.rmSync(filePath);
		fs.writeFileSync(filePath, content, { mode: 0o600 });
	} finally {
		fs.closeSync(original);
	}
}

function assertReviewFixtureInodeChanged(request, filePath) {
	const captured = request.privateState.artifacts[path.basename(filePath)];
	const current = fs.lstatSync(filePath, { bigint: true });
	assert.notEqual(
		`${current.dev}:${current.ino}`,
		`${captured.dev}:${captured.ino}`,
		"replacement fixture must not reuse the captured inode",
	);
}

/** A codex stand-in: writes the canned last message and exits. */
function stubCodex(lastMessage, exitCode = 0) {
	const bin = path.join(tmpDir(), "codex-stub");
	const quoted = `'${lastMessage.replaceAll("'", `'\\''`)}'`;
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf '%s' ${quoted} > "$out"
exit ${exitCode}
`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

function capturingCodex(lastMessage, capturePath) {
	const bin = path.join(tmpDir(), "codex-capturing-stub");
	const quotedMessage = `'${lastMessage.replaceAll("'", `'\\''`)}'`;
	const quotedCapture = `'${capturePath.replaceAll("'", `'\\''`)}'`;
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > ${quotedCapture}
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf '%s' ${quotedMessage} > "$out"
`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

const envWith = (bin) => ({ ...process.env, STDD_CODEX_BIN: bin });

function reviewSettlementReplacementRaceEnv(briefPath, auditPath) {
	const hookPath = path.join(tmpDir(), "review-settlement-replacement-race.mjs");
	const briefName = path.basename(briefPath);
	const briefDirName = path.basename(path.dirname(briefPath));
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";

const briefName = ${JSON.stringify(briefName)};
const briefDirName = ${JSON.stringify(briefDirName)};
const auditPath = ${JSON.stringify(auditPath)};
const originalRename = fs.renameSync;
const originalWrite = fs.writeFileSync;
const originalMkdir = fs.mkdirSync;
const audit = { raced: false, target: null, held: null, replacement: null, prohibited: [] };

function saveAudit() {
  originalWrite(auditPath, JSON.stringify(audit));
}

fs.renameSync = function (source, target, ...args) {
  const result = originalRename.call(this, source, target, ...args);
  const sourceName = path.basename(String(source));
  if (!audit.raced && (sourceName === briefName || sourceName === briefDirName)) {
    audit.raced = true;
    audit.target = path.join(fs.realpathSync(path.dirname(String(target))), path.basename(String(target)));
    audit.held = \`\${audit.target}.race-held\`;
    originalRename.call(this, target, audit.held);
    if (sourceName === briefDirName) {
      originalMkdir.call(this, audit.target, { mode: 0o700 });
      audit.replacement = path.join(audit.target, "replacement.txt");
      originalWrite(audit.replacement, "ATTACKER_REPLACEMENT_SURVIVES\\n", { mode: 0o600 });
    } else {
      audit.replacement = String(target);
      originalWrite(audit.replacement, "ATTACKER_REPLACEMENT_SURVIVES\\n", { mode: 0o600 });
    }
    saveAudit();
  }
  return result;
};

for (const method of ["unlinkSync", "rmSync", "rmdirSync"]) {
  const original = fs[method];
  fs[method] = function (target, ...args) {
    const shown = String(target);
    if (shown.includes(briefDirName) || shown.includes("stdd-review-quarantine-")) {
      audit.prohibited.push({ method, target: shown });
      saveAudit();
      throw new Error(\`prohibited destructive settlement call: \${method}\`);
    }
    return original.call(this, target, ...args);
  };
}
`,
	);
	return { ...process.env, NODE_OPTIONS: `--import=${hookPath}` };
}

function assertQuarantinedSecretWasWiped(audit, secretMarker) {
	assert.equal(audit.raced, true, "the final-name replacement race was injected");
	assert.deepEqual(audit.prohibited, [], "settlement never unlinks, recursively removes, or rmdirs");
	assert.equal(
		fs.readFileSync(audit.replacement, "utf8"),
		"ATTACKER_REPLACEMENT_SURVIVES\n",
		"the replacement inode survives",
	);
	const held = fs.lstatSync(audit.held);
	const files = held.isDirectory()
		? fs
				.readdirSync(audit.held)
				.map((name) => path.join(audit.held, name))
				.filter((candidate) => fs.lstatSync(candidate).isFile())
		: [audit.held];
	for (const candidate of files) {
		assert.doesNotMatch(
			fs.readFileSync(candidate, "utf8"),
			new RegExp(secretMarker),
			`private bytes were wiped before ${candidate} entered quarantine`,
		);
	}
}

function planMutationTrapEnv(dir, mode) {
	const hookPath = path.join(tmpDir(), `review-plan-${mode}-trap.mjs`);
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const mode = ${JSON.stringify(mode)};
const planPath = ${JSON.stringify(planPath)};
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;

fs.writeFileSync = function (target, ...args) {
  if (mode === "write" && String(target) === planPath) {
    throw new Error("injected plan write failure");
  }
  return originalWrite.call(this, target, ...args);
};

fs.renameSync = function (source, target, ...args) {
  if (mode === "rename" && (String(source) === planPath || String(target) === planPath)) {
    throw new Error("injected plan rename failure");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);
	return { NODE_OPTIONS: `--import=${hookPath}` };
}

function killAfterApprovalAppendEnv() {
	const hookPath = path.join(tmpDir(), "review-kill-after-approval.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const originalAppend = fs.appendFileSync;
let killed = false;
fs.appendFileSync = function (target, data, ...args) {
  const value = originalAppend.call(this, target, data, ...args);
  if (!killed && String(data).includes('"event":"review"')) {
    killed = true;
    process.kill(process.pid, "SIGKILL");
  }
  return value;
};
`,
	);
	return { NODE_OPTIONS: `--import=${hookPath}` };
}

function changePlanAtVerdictLockEnv(resultPath, planPath) {
	const hookPath = path.join(tmpDir(), "review-change-plan-at-verdict-lock.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const resultPath = ${JSON.stringify(resultPath)};
const planPath = ${JSON.stringify(planPath)};
const originalRead = fs.readFileSync;
const originalLink = fs.linkSync;
let resultRead = false;
let snapshotRead = false;
let changed = false;

fs.readFileSync = function (target, ...args) {
  const value = originalRead.call(this, target, ...args);
  if (String(target) === resultPath) resultRead = true;
  if (resultRead && String(target) === planPath) snapshotRead = true;
  return value;
};

fs.linkSync = function (source, target, ...args) {
  if (!changed && snapshotRead && /stdd-ledger-[0-9a-f]+\\.lock$/.test(String(target))) {
    changed = true;
    fs.appendFileSync(planPath, "- [ ] injected after final snapshot\\n");
  }
  return originalLink.call(this, source, target, ...args);
};
`,
	);
	return { NODE_OPTIONS: `--import=${hookPath}` };
}

test("review --via codex: approved verdict is recorded and closes the [review:] item", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const events = readLedger(dir);
	const request = events.find((e) => e.event === "review-request");
	const review = events.find((e) => e.event === "review");
	assert.equal(request.via, "codex");
	assert.match(request.brief, /^sha256:/);
	assert.equal(review.verdict, "approved");
	assert.equal(review.request, request.id);
	assert.equal(review.snapshot, request.snapshot);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review \[review:\]/);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
	assert.equal(status.plan.next, null);
});

for (const { via, envName } of [
	{ via: "codex", envName: "STDD_CODEX_BIN" },
	{ via: "claude", envName: "STDD_CLAUDE_BIN" },
]) {
	test(`review --via ${via} rejects a control-bearing ${envName} before allocating state`, async () => {
		const { dir } = await tmpGitRepo();
		const privateTmp = tmpDir();
		const marker = `FORGED_${via.toUpperCase()}_RUNNER`;
		const reviewed = await run(["review", "--via", via], {
			cwd: dir,
			env: {
				...process.env,
				TMPDIR: privateTmp,
				[envName]: `/printable/prefix\n${marker}`,
			},
		});

		assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
		assert.match(reviewed.stderr, new RegExp(`${envName} must be a non-empty single printable line`));
		assert.doesNotMatch(`${reviewed.stdout}${reviewed.stderr}`, new RegExp(marker));
		assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "no request was recorded");
		assert.deepEqual(fs.readdirSync(privateTmp), [], "no private brief was allocated");
	});
}

test("review accepts a printable runner path containing spaces and Unicode", async () => {
	const { dir } = await tmpGitRepo();
	const original = stubCodex('{"summary": "sound", "findings": []}');
	const bin = path.join(path.dirname(original), "codex runner über 👩‍💻");
	fs.renameSync(original, bin);

	const reviewed = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});

	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
	const event = readLedger(dir).find((candidate) => candidate.event === "review");
	assert.equal(event.runner.command, `${bin} exec --sandbox read-only`);
});

test("approval closes from the ledger without writing or renaming the plan", async () => {
	for (const mode of ["write", "rename"]) {
		const { dir } = await tmpGitRepo();
		const planPath = path.join(dir, ".stdd", "plan.md");
		const before = fs.readFileSync(planPath, "utf8");
		const bin = stubCodex('{"summary": "sound", "findings": []}');
		const res = await run(["review", "--via", "codex"], {
			cwd: dir,
			env: { ...envWith(bin), ...planMutationTrapEnv(dir, mode) },
		});
		assert.equal(res.code, 0, `${mode}: ${res.stdout}${res.stderr}`);
		assert.equal(fs.readFileSync(planPath, "utf8"), before, mode);
		const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
		assert.equal(status.plan.review.done, true, mode);
		assert.equal(status.plan.next, null, mode);
		const gate = await run(["status", "--gate"], { cwd: dir });
		assert.equal(gate.code, 0, `${mode}: ${gate.stdout}${gate.stderr}`);
	}
});

test("a kill immediately after the approval append still leaves one closed ledger-derived item", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	const before = fs.readFileSync(planPath, "utf8");
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	let killed;
	try {
		await exec("node", [CLI, "review", "--via", "codex"], {
			cwd: dir,
			env: { ...envWith(bin), ...killAfterApprovalAppendEnv() },
		});
	} catch (err) {
		killed = err;
	}
	assert.equal(killed?.signal, "SIGKILL");
	assert.equal(fs.readFileSync(planPath, "utf8"), before);
	assert.equal(
		readLedger(dir)
			.filter((event) => event.event === "review")
			.at(-1).verdict,
		"approved",
	);

	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
	assert.equal(status.plan.next, null);
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
	const recovered = await run(["note", "recover killed review lock"], { cwd: dir });
	assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
});

test("review excludes a plan that predates the active task", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# Previous task\n\n- [ ] NEVER_INCLUDE_THIS_OLD_PLAN\n",
	);
	const started = await run(["task", "start", "new review scope"], {
		cwd: dir,
	});
	assert.equal(started.code, 0, started.stdout + started.stderr);

	const capturePath = path.join(tmpDir(), "review-brief.md");
	const bin = capturingCodex('{"summary": "sound", "findings": []}', capturePath);
	const reviewed = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);

	const brief = fs.readFileSync(capturePath, "utf8");
	assert.doesNotMatch(brief, /NEVER_INCLUDE_THIS_OLD_PLAN/);
	assert.match(brief, /\(no plan for the active task\)/);
});

test("a fresh approval without a current plan advances status to evidence", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "small planless change"], { cwd: dir });
	fs.rmSync(path.join(dir, ".stdd", "plan.md"));
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);

	const fakeBin = tmpDir();
	fs.writeFileSync(path.join(fakeBin, "gh"), '#!/bin/sh\necho "no pull requests found" >&2; exit 1\n', {
		mode: 0o755,
	});
	const status = JSON.parse(
		(
			await run(["status", "--json"], {
				cwd: dir,
				env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
			})
		).stdout,
	);
	assert.equal(status.plan.present, false);
	assert.equal(status.review.verdict, "approved");
	assert.match(status.next, /draft the evidence line/);
	assert.doesNotMatch(status.next, /fresh reviewer|stdd review/);
});

test("editing only a pre-task plan checkbox stales an approval that excluded the plan", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(planPath, "# Previous task\n\n- [ ] old checkbox\n");
	await run(["task", "start", "new review scope"], { cwd: dir });
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);

	fs.writeFileSync(planPath, "# Previous task\n\n- [x] old checkbox\n");
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 1);
	assert.match(gate.stdout, /stale/);
});

test("review --via codex: a blocking finding means changes-requested, exit 1, item stays open", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const bin = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "changes-requested");
	assert.equal(review.findings.length, 1);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review \[review:\]/);
	const local = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(local.next, /review/i, "local session routing prioritizes the failed closing review");
	assert.doesNotMatch(local.next, /draft the evidence/i);
	fs.rmSync(path.join(dir, ".stdd", "plan.md"));
	const withoutPlan = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(withoutPlan.next, /review/i);
	assert.doesNotMatch(
		withoutPlan.next,
		/draft the evidence/i,
		"a failed or stale review never routes to evidence even without a plan item",
	);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities = { subagents: false, crossCli: false, worktrees: false };
	config.review = { via: "subagent", maxRounds: 0 };
	fs.writeFileSync(configPath, JSON.stringify(config));
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const routeDisabled = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(routeDisabled.next, /review/i);
	assert.match(routeDisabled.next, /enable.*capabilit|compatible.*route/i);
	assert.doesNotMatch(routeDisabled.next, /draft the evidence/i);
});

test("status fixes changes-requested findings before spending another review round", async () => {
	const { dir } = await tmpGitRepo(ALL_CAPS, { via: "codex", maxRounds: 2 });
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const bin = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const review = await run(["review"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(review.code, 1, review.stdout + review.stderr);

	const assertFixesBeforeReview = (next) => {
		const fix = next.indexOf("fix the 1 review finding(s)");
		const rerun = next.search(/run `stdd review(?: --force)?`/);
		assert.ok(fix >= 0, `expected findings-first guidance, got: ${next}`);
		assert.ok(rerun > fix, `expected review only after the fix, got: ${next}`);
		assert.doesNotMatch(next, /closing review closes|checked but the review is unproven/);
	};

	const open = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(open.next);

	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.review.maxRounds = 1;
	fs.writeFileSync(configPath, JSON.stringify(config));
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const exhausted = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(exhausted.next);
	assert.match(exhausted.next, /`stdd review --force`/);
	assert.doesNotMatch(exhausted.next, /`stdd review` again/);

	config.capabilities = { subagents: false, crossCli: false, worktrees: true };
	fs.writeFileSync(configPath, JSON.stringify(config));
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const disabled = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(disabled.next);
	assert.match(disabled.next, /enable a compatible review capability\/route/);
	assert.match(disabled.next, /`stdd review --force`/);

	const planPath = path.join(dir, ".stdd", "plan.md");
	const plan = fs.readFileSync(planPath, "utf8");
	fs.writeFileSync(planPath, plan.replace("- [ ] closing review", "- [x] closing review"));
	const falselyChecked = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(falselyChecked.next);
});

test("status repairs an errored closing review before generic review-plan guidance", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const malformed = stubCodex("not json");
	const review = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(malformed),
	});
	assert.equal(review.code, 2, review.stdout + review.stderr);

	const errored = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(errored.next, /repair the stale or errored closing review/);
	assert.doesNotMatch(errored.next, /closing review closes/);

	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [ ] adjust implementation\n- [ ] closing review [review:]\n",
	);
	const unfinishedPlan = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(unfinishedPlan.next, /continue the plan.*adjust implementation/);
	assert.doesNotMatch(unfinishedPlan.next, /repair the stale or errored closing review/);
});

test("review --via codex: malformed reviewer output is an error, never an approval", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex("LGTM, ship it");
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
});

test("review --via codex: a failing runner is an error verdict", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "ok", "findings": []}', 3);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 2);
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("review --via codex never reads a replaced last-message symlink", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "foreign-review-output.json");
	fs.writeFileSync(outside, '{"summary":"foreign","findings":[]}');
	const bin = path.join(tmpDir(), "codex-output-symlink-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
rm -f "$out"
ln -s ${JSON.stringify(outside)} "$out"
`,
	);
	fs.chmodSync(bin, 0o755);

	const reviewed = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});

	assert.equal(reviewed.code, 2, reviewed.stdout + reviewed.stderr);
	assert.match(reviewed.stderr, /output artifact changed identity|unsafe/i);
	assert.equal(fs.readFileSync(outside, "utf8"), '{"summary":"foreign","findings":[]}');
	const request = readLedger(dir).find((event) => event.event === "review-request");
	assert.ok(
		fs.lstatSync(path.join(path.dirname(request.briefPath), "last-message.txt")).isSymbolicLink(),
	);
	assert.equal(
		readLedger(dir).find((event) => event.event === "review" && event.request === request.id).verdict,
		"error",
	);
});

test("review --via codex without the crossCli capability fails without recording", async () => {
	const { dir } = await tmpGitRepo({
		subagents: true,
		crossCli: false,
		worktrees: true,
	});
	const res = await run(["review", "--via", "codex"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")));
});

test("review --via subagent prepares the brief; --result grades it against the open request", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.ok(briefPath && fs.existsSync(briefPath), prep.stdout);
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /## Plan/);
	assert.match(brief, /## Changed files/);
	assert.match(brief, /^M\timpl\.js$/m, "the manifest names every changed file");
	assert.match(brief, /## Diff/);
	assert.match(brief, /closing review \[review:\]/);
	assert.match(brief, /export const v = 2/);

	const expectedOutputContract = `Respond with ONLY one JSON object, no prose around it:
{"summary": "<non-empty printable single line>", "findings": [{"severity": "blocking" | "advisory", "path": "<non-empty printable single line>" | null, "line": <positive safe integer or null>, "message": "<non-empty printable single line>"}]}
\`summary\` and every finding's required \`message\` must be non-empty printable single lines; ordinary Unicode, including ZWNJ/ZWJ and emoji, remains valid.
Each finding has \`severity: blocking | advisory\`, \`path\` absent or null or a non-empty printable single line, and \`line\` absent or null or a positive safe integer.
For a control-bearing repository path that cannot cross this inline boundary, omit \`path\` rather than emitting unsafe text. Any wrong field type or output shape invalidates the whole result.
An empty findings array means the change is sound.`;
	const outputContract = brief
		.slice(brief.indexOf("Respond with ONLY one JSON object"), brief.indexOf("## Code quality rubric"))
		.trim();
	assert.equal(outputContract, expectedOutputContract);

	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "approved");
	assert.equal(review.via, "subagent");
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review \[review:\]/);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("reviewer-controlled result text cannot inject the ledger or terminal output", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			summary: "summary\nFORGED_SUMMARY_LINE",
			findings: [
				{
					severity: "blocking",
					path: "impl.js\u001b[2JFORGED_PATH",
					line: 0,
					message: "finding\nFORGED_TERMINAL_LINE",
				},
			],
		}),
	);

	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr);
	assert.doesNotMatch(`${res.stdout}${res.stderr}`, /FORGED_/);
	assert.ok(!`${res.stdout}${res.stderr}`.includes("\u001b[2J"));
	const ledgerText = fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8");
	assert.doesNotMatch(ledgerText, /FORGED_/);
	const review = readLedger(dir).find((event) => event.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /malformed reviewer output/);
	assert.equal(review.summary, undefined);
	assert.equal(review.findings, undefined);
});

test("printable reviewer fields persist and print without coercion", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const resultPath = path.join(tmpDir(), "result.json");
	const expected = {
		summary: "Unicode summary ✅",
		findings: [
			{
				severity: "blocking",
				path: "src/über\u200cname.js",
				line: Number.MAX_SAFE_INTEGER,
				message: "Unicode message 👩‍💻",
			},
		],
	};
	fs.writeFileSync(resultPath, JSON.stringify(expected));

	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(
		res.stdout,
		new RegExp(`src/über\u200cname\\.js:${Number.MAX_SAFE_INTEGER} — Unicode message 👩‍💻`),
	);
	const review = readLedger(dir).find((event) => event.event === "review");
	assert.equal(review.summary, expected.summary);
	assert.deepEqual(review.findings, expected.findings);
});

test("review --result with a changed checkout records a stale error", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 3;\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /stale/);
});

test("--timeout rejects non-integer and out-of-range values before any side effect", async () => {
	const { dir } = await tmpGitRepo();
	for (const bad of ["1.5", "0", "-3", "1e9", "nope"]) {
		const res = await run(["review", "--via", "codex", "--timeout", bad], {
			cwd: dir,
		});
		assert.equal(res.code, 1, `--timeout ${bad} must fail at parse time`);
		assert.match(res.stderr, /--timeout/);
	}
	assert.ok(
		!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")),
		"no request may be recorded for an invalid flag",
	);
});

test("review --cleanup rejects every dispatch-only flag before cleanup", async () => {
	const expected =
		"stdd: --cleanup cancels open review requests and cannot be combined with dispatch flags\n";
	for (const dispatchArgs of [["--timeout", "1"], ["--via", "codex"], ["--force"]]) {
		const { dir } = await tmpGitRepo();
		const res = await run(["review", "--cleanup", ...dispatchArgs], { cwd: dir });
		assert.equal(res.code, 1, dispatchArgs.join(" "));
		assert.equal(res.stderr, expected, dispatchArgs.join(" "));
	}
});

test("review --result rejects every dispatch-only flag before reading the result", async () => {
	const cases = [
		{
			args: ["--timeout", "1"],
			expected:
				"stdd: --result grades an existing request — --timeout and --force belong to the dispatch call\n",
		},
		{
			args: ["--via", "codex"],
			expected: "stdd: --result grades an existing request — --via belongs to the dispatch call\n",
		},
		{
			args: ["--force"],
			expected:
				"stdd: --result grades an existing request — --timeout and --force belong to the dispatch call\n",
		},
	];
	for (const { args, expected } of cases) {
		const { dir } = await tmpGitRepo();
		const missingResult = path.join(dir, "missing-result.json");
		const res = await run(["review", "--result", missingResult, ...args], { cwd: dir });
		assert.equal(res.code, 1, args.join(" "));
		assert.equal(res.stderr, expected, args.join(" "));
	}
});

test("review rejects an idle task before creating a private brief", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "finished task"], { cwd: dir });
	await run(["task", "finish"], { cwd: dir });
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-idle-"));

	const res = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: privateTmp },
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /no active task/);
	assert.deepEqual(fs.readdirSync(privateTmp), [], "no source-bearing temp directory is allocated");
});

test("a task switch after review capture records no request and reports no subagent success", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-request-task-race-"));
	const hookPath = path.join(tmpDir(), "switch-task-before-request.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const originalWrite = fs.writeFileSync;
let switched = false;
fs.writeFileSync = function (target, data, ...args) {
  const value = originalWrite.call(this, target, data, ...args);
  if (
    !switched &&
    String(target).startsWith(${JSON.stringify(`${privateTmp}${path.sep}`)}) &&
    /rev-[0-9a-f]{32}\\.md$/.test(String(target))
  ) {
    switched = true;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    for (const command of [["task", "finish"], ["task", "start", "replacement task"]]) {
      const run = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...command], {
        cwd: ${JSON.stringify(dir)},
        env,
        encoding: "utf8",
      });
      if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    }
  }
  return value;
};
`,
	);

	const reviewed = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			TMPDIR: privateTmp,
		},
	});
	assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
	assert.match(reviewed.stderr, /active task changed/i);
	assert.doesNotMatch(reviewed.stdout, /brief written|dispatch a fresh/i);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-request"));
	assert.ok(
		!fs.readdirSync(privateTmp).some((name) => /^stdd-review-[0-9A-Za-z]{6}$/.test(name)),
		"rejected request removes its source-bearing private brief",
	);
});

test("a branch switch after review capture records no request and reports no subagent success", async () => {
	const { dir } = await tmpGitRepo();
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-request-branch-race-"));
	const hookPath = path.join(tmpDir(), "switch-branch-before-request.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const originalWrite = fs.writeFileSync;
let switched = false;
fs.writeFileSync = function (target, data, ...args) {
  const value = originalWrite.call(this, target, data, ...args);
  if (
    !switched &&
    String(target).startsWith(${JSON.stringify(`${privateTmp}${path.sep}`)}) &&
    /rev-[0-9a-f]{32}\\.md$/.test(String(target))
  ) {
    switched = true;
    const run = spawnSync("git", ["-C", ${JSON.stringify(dir)}, "checkout", "-qb", "hijack"], {
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
  }
  return value;
};
`,
	);

	const reviewed = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			TMPDIR: privateTmp,
		},
	});
	assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
	assert.match(reviewed.stderr, /switched branches/i);
	assert.doesNotMatch(reviewed.stdout, /brief written|dispatch a fresh/i);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.ok(
		!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
	);
	assert.ok(
		!fs.readdirSync(privateTmp).some((name) => /^stdd-review-[0-9A-Za-z]{6}$/.test(name)),
		"rejected request removes its source-bearing private brief",
	);
});

test("review rejects an empty clean-base legacy scope before creating a request", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("checkout", "-q", "main");
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.state, "legacy");
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-empty-clean-base-"));

	const res = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: privateTmp },
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /no active task/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")));
	assert.deepEqual(fs.readdirSync(privateTmp), []);
});

test("review rejects clean-base legacy state before creating an invisible request", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("checkout", "-q", "main");
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			branch: "main",
			event: "note",
			text: "legacy residue",
		})}\n`,
	);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.state, "idle");
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-clean-base-"));

	const res = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: privateTmp },
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /no active task/);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-request"));
	assert.deepEqual(fs.readdirSync(privateTmp), []);
});

test("review --result without an open request fails", async () => {
	const { dir } = await tmpGitRepo();
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "?", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no open review request/);
});

test("appending ledger events between request and result does not go stale", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	await run(["note", "worker finished"], { cwd: dir });
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
});

test("status --gate: changes-requested fails, approval passes, checked-but-unproven fails", async () => {
	const { dir } = await tmpGitRepo();
	// checked review item, no recorded review at all
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const unproven = await run(["status", "--gate"], { cwd: dir });
	assert.equal(unproven.code, 1, unproven.stdout);
	assert.match(unproven.stdout, /checked but/i);

	const blocking = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(blocking) });
	const changes = await run(["status", "--gate"], { cwd: dir });
	assert.equal(changes.code, 1);
	assert.match(changes.stdout, /requested changes/i);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	// the approval goes stale as soon as the reviewed work changes
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 4;\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1);
	assert.match(stale.stdout, /stale/i);
});

test("status gate and Stop allow every capability profile when no review is claimed", async () => {
	for (const { name, capabilities, via } of [
		{
			name: "none",
			capabilities: { subagents: false, crossCli: false, worktrees: true },
			via: "subagent",
		},
		{
			name: "subagents",
			capabilities: { subagents: true, crossCli: false, worktrees: true },
			via: "subagent",
		},
		{
			name: "crossCli",
			capabilities: { subagents: false, crossCli: true, worktrees: true },
			via: "codex",
		},
		{ name: "both", capabilities: ALL_CAPS, via: "codex" },
	]) {
		const { dir } = await tmpGitRepo(capabilities, { via });
		fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "# P\n\n- [x] impl\n- [ ] verify\n");

		const gate = await run(["status", "--gate"], { cwd: dir });
		assert.equal(gate.code, 0, `${name}: ${gate.stdout}${gate.stderr}`);

		const stop = spawnSync(process.execPath, [CLI, "stop-hook"], {
			cwd: dir,
			input: '{"stop_hook_active":false}',
			encoding: "utf8",
		});
		assert.equal(stop.status, 0, `${name}: ${stop.stdout}${stop.stderr}`);
	}
});

test("status gate still rejects unavailable routes needed by a claim or open request", async () => {
	const capabilities = { subagents: false, crossCli: false, worktrees: true };

	const { dir: claimedDir } = await tmpGitRepo(capabilities, { via: "subagent" });
	fs.writeFileSync(
		path.join(claimedDir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const claimed = await run(["status", "--gate"], { cwd: claimedDir });
	assert.equal(claimed.code, 1, claimed.stdout + claimed.stderr);
	assert.match(claimed.stdout, /subagents capability is off/i);
	const claimedStop = spawnSync(process.execPath, [CLI, "stop-hook"], {
		cwd: claimedDir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(claimedStop.status, 2, claimedStop.stdout + claimedStop.stderr);
	assert.match(claimedStop.stderr, /subagents capability is off/i);

	const { dir: requestedDir } = await tmpGitRepo(capabilities, { via: "subagent" });
	fs.writeFileSync(path.join(requestedDir, ".stdd", "plan.md"), "# P\n\n- [x] impl\n");
	fs.writeFileSync(
		path.join(requestedDir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id: "rev-12345678",
			via: "subagent",
			snapshot: "snapshot",
			briefHash: "hash",
			briefPath: path.join(tmpDir(), "brief.md"),
			branch: "feature",
		})}\n`,
	);
	const requested = await run(["status", "--gate"], { cwd: requestedDir });
	assert.equal(requested.code, 1, requested.stdout + requested.stderr);
	assert.match(requested.stdout, /open review request.*subagents capability is off/i);
	const requestedStop = spawnSync(process.execPath, [CLI, "stop-hook"], {
		cwd: requestedDir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(requestedStop.status, 2, requestedStop.stdout + requestedStop.stderr);
	assert.match(requestedStop.stderr, /open review request.*subagents capability is off/i);
});

test("malformed non-boundary branches cannot hide a newer changes-requested review", async () => {
	for (const { branchMetadata, invalid } of [
		{ branchMetadata: {}, invalid: true },
		{ branchMetadata: { branch: "feature\nforged" }, invalid: true },
		{ branchMetadata: { branch: "other" }, invalid: false },
	]) {
		const { dir } = await tmpGitRepo();
		const clean = stubCodex('{"summary": "sound", "findings": []}');
		const approved = await run(["review", "--via", "codex"], {
			cwd: dir,
			env: envWith(clean),
		});
		assert.equal(approved.code, 0, approved.stdout + approved.stderr);
		assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);

		fs.appendFileSync(
			path.join(dir, ".stdd", "ledger.jsonl"),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				event: "review",
				verdict: "changes-requested",
				via: "codex",
				snapshot: "newer-review",
				summary: "blocking",
				findings: [
					{
						severity: "blocking",
						path: "impl.js",
						line: 1,
						message: "newest review blocks",
					},
				],
				...branchMetadata,
			})}\n`,
		);

		const gate = await run(["status", "--gate"], { cwd: dir });
		assert.equal(gate.code, invalid ? 1 : 0, gate.stdout + gate.stderr);
		if (invalid) {
			assert.match(gate.stdout, /malformed task boundary/i);
			assert.match(gate.stdout, /repair.*ledger\.jsonl/i);
		}
	}
});

test("status --gate and Stop hooks block malformed task state without crashing on primitive events", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "null\n");

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 1, gate.stdout + gate.stderr);
	assert.match(gate.stdout, /malformed task boundary/i);
	assert.match(gate.stdout, /repair.*ledger\.jsonl/i);

	const claude = spawnSync(process.execPath, [CLI, "stop-hook"], {
		cwd: dir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(claude.status, 2, claude.stdout + claude.stderr);
	assert.match(claude.stderr, /malformed task boundary/i);
	assert.match(claude.stderr, /repair.*ledger\.jsonl/i);

	const codex = spawnSync(process.execPath, [CLI, "stop-hook", "--agent", "codex"], {
		cwd: dir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(codex.status, 0, codex.stdout + codex.stderr);
	const decision = JSON.parse(codex.stdout);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /malformed task boundary/i);
	assert.match(decision.reason, /repair.*ledger\.jsonl/i);
});

test("status, gate, and Stop classify malformed ledger event payloads as invalid", async (t) => {
	for (const scenario of [
		{
			name: "docs.paths",
			event: {
				event: "docs",
				decision: "checked",
				paths: { 0: "docs/domain/pricing.md", length: 1 },
				reason: "malformed array lookalike",
				snapshot: "snapshot",
			},
		},
		{
			name: "review.findings",
			event: {
				event: "review",
				request: "rev-12345678",
				via: "codex",
				verdict: "changes-requested",
				snapshot: "snapshot",
				summary: "malformed findings",
				findings: {
					severity: "blocking",
					path: "impl.js",
					line: 1,
					message: "must be an array",
				},
			},
		},
	]) {
		await t.test(scenario.name, async () => {
			const { dir } = await tmpGitRepo();
			const started = await run(["task", "start", "malformed ledger payload"], { cwd: dir });
			assert.equal(started.code, 0, started.stdout + started.stderr);
			const taskId = readLedger(dir).find((event) => event.event === "task-start").id;
			fs.appendFileSync(
				path.join(dir, ".stdd", "ledger.jsonl"),
				`${JSON.stringify({
					ts: new Date().toISOString(),
					branch: "feature",
					taskId,
					...scenario.event,
				})}\n`,
			);

			const status = await run(["status", "--local", "--json"], { cwd: dir });
			assert.equal(status.code, 0, status.stdout + status.stderr);
			const parsedStatus = JSON.parse(status.stdout);
			assert.equal(parsedStatus.state, "invalid");
			assert.match(parsedStatus.next, /repair.*malformed.*ledger/i);

			const gate = await run(["status", "--gate"], { cwd: dir });
			assert.equal(gate.code, 1, gate.stdout + gate.stderr);
			assert.match(gate.stdout, /malformed task boundary/i);
			assert.match(gate.stdout, /repair.*ledger\.jsonl/i);

			const claude = spawnSync(process.execPath, [CLI, "stop-hook"], {
				cwd: dir,
				input: '{"stop_hook_active":false}',
				encoding: "utf8",
			});
			assert.equal(claude.status, 2, claude.stdout + claude.stderr);
			assert.match(claude.stderr, /malformed task boundary/i);

			const codex = spawnSync(process.execPath, [CLI, "stop-hook", "--agent", "codex"], {
				cwd: dir,
				input: '{"stop_hook_active":false}',
				encoding: "utf8",
			});
			assert.equal(codex.status, 0, codex.stdout + codex.stderr);
			const decision = JSON.parse(codex.stdout);
			assert.equal(decision.decision, "block");
			assert.match(decision.reason, /malformed task boundary/i);
		});
	}
});

test("editing the plan after ledger-derived approval stales it", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);
	fs.appendFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] a new scope item\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the reviewer never saw the current specification");
	assert.match(stale.stdout, /stale/i);
});

test("a stranded private reset temp does not stale a review snapshot", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const tempPath = path.join(dir, ".stdd", `.ledger-reset-${"b".repeat(32)}.tmp`);
	fs.writeFileSync(tempPath, "interrupted private transaction\n", { mode: 0o600 });

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review.verdict, "approved");
	assert.equal(status.review.stale, false);

	const recovered = await run(["note", "recover stranded reset temp"], { cwd: dir });
	assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
	assert.ok(!fs.existsSync(tempPath));
});

test("exact-name reset artifacts are exempt only with the trusted private-file shape", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const exact = path.join(dir, ".stdd", `.ledger-reset-${"c".repeat(32)}.tmp`);
	const outside = path.join(tmpDir(), "outside");
	fs.writeFileSync(outside, "outside\n");
	const cases = [
		{
			name: "non-private regular file",
			setup: () => fs.writeFileSync(exact, "public\n", { mode: 0o644 }),
			cleanup: () => fs.rmSync(exact),
		},
		{
			name: "symlink",
			setup: () => fs.symlinkSync(outside, exact),
			cleanup: () => fs.rmSync(exact),
		},
		{
			name: "directory",
			setup() {
				fs.mkdirSync(exact);
				fs.writeFileSync(path.join(exact, "child"), "child\n");
			},
			cleanup: () => fs.rmSync(exact, { recursive: true }),
		},
	];
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		cases.push({
			name: "foreign owner",
			setup() {
				fs.writeFileSync(exact, "foreign\n", { mode: 0o600 });
				fs.chownSync(exact, 65534, 65534);
			},
			cleanup: () => fs.rmSync(exact),
		});
	}
	for (const artifact of cases) {
		artifact.setup();
		const stale = await run(["status", "--gate"], { cwd: dir });
		assert.equal(stale.code, 1, `${artifact.name}: ${stale.stdout}${stale.stderr}`);
		assert.match(stale.stdout, /stale/i, artifact.name);
		artifact.cleanup();
		assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0, artifact.name);
	}
});

test("review diff and changed manifest exempt only exact shape-validated ledger temps", async () => {
	const cases = [
		{
			name: `.ledger-recovered-${"d".repeat(32)}.tmp`,
			mode: 0o600,
			visible: false,
		},
		{
			name: `.ledger-recovered-${"d".repeat(31)}.tmp`,
			mode: 0o600,
			visible: true,
		},
		{
			name: `.ledger-recovered-${"e".repeat(32)}.tmp`,
			mode: 0o644,
			visible: true,
		},
	];
	for (const fixture of cases) {
		const { dir, git } = await tmpGitRepo();
		const relative = `.stdd/${fixture.name}`;
		const candidate = path.join(dir, relative);
		fs.writeFileSync(candidate, `review-visible-${fixture.name}\n`, { mode: fixture.mode });
		fs.chmodSync(candidate, fixture.mode);
		await git("add", relative);
		await git("commit", "-qm", `add ${fixture.name}`);

		const prepared = await run(["review", "--via", "subagent"], { cwd: dir });
		assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
		const briefPath = prepared.stdout.match(/brief written to (\S+)/)?.[1];
		const brief = fs.readFileSync(briefPath, "utf8");
		assert.equal(
			brief.includes(fixture.name),
			fixture.visible,
			`${fixture.name} visibility must match its exact basename and private shape`,
		);
	}
});

test("every reset-temp near miss remains visible and stales an approved review", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".gitignore"), ".stdd/.ledger-reset-*.tmp\n");
	const initialized = await run(["init", dir, "--tools", "codex"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const reviewed = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);

	for (const name of [
		`.ledger-reset-${"a".repeat(31)}.tmp`,
		`.ledger-reset-${"a".repeat(33)}.tmp`,
		`.ledger-reset-${"A".repeat(32)}.tmp`,
		`.ledger-reset-${"g".repeat(32)}.tmp`,
		`.ledger-reset-${"a".repeat(32)}.tmp.extra`,
	]) {
		const candidate = path.join(dir, ".stdd", name);
		fs.writeFileSync(candidate, "near miss\n");
		const stale = await run(["status", "--gate"], { cwd: dir });
		assert.equal(stale.code, 1, `${name}: ${stale.stdout}${stale.stderr}`);
		assert.match(stale.stdout, /stale/i, name);
		fs.rmSync(candidate);
		const restored = await run(["status", "--gate"], { cwd: dir });
		assert.equal(restored.code, 0, `${name}: ${restored.stdout}${restored.stderr}`);
	}
});

test("a committed reset-temp near miss remains in the review diff and manifest", async () => {
	const { dir, git } = await tmpGitRepo();
	const relative = `.stdd/.ledger-reset-${"A".repeat(32)}.tmp`;
	fs.writeFileSync(path.join(dir, relative), "TRACKED_RESET_NEAR_MISS\n");
	await git("add", "-f", relative);
	await git("commit", "-qm", "tracked reset near miss");

	const prepared = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
	const briefPath = prepared.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, new RegExp(relative.replaceAll(".", "\\.")));
	assert.match(brief, /TRACKED_RESET_NEAR_MISS/);
});

test("an unresolvable baseRef aborts the review before recording anything", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "origin/nowhere", capabilities: ALL_CAPS }),
	);
	const bin = stubCodex('{"summary": "s", "findings": []}');
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /cannot diff/i);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing recorded");
});

test("the brief carries untracked-file contents", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "brand-new.js"), "export const UNTRACKED_MARKER = 42;\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /UNTRACKED_MARKER/);
});

test("the brief carries the quality rubric and names changed governing docs", async () => {
	const { dir, git } = await tmpGitRepo();
	// a canonical doc changed on the branch is the spec delta
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "billing.md"), "# Billing rules\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: billing");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /## Code quality rubric/);
	assert.match(brief, /magic numbers/i);
	assert.match(brief, /type contracts/i);
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/billing\.md/);
});

test("the brief names an untracked governing doc as part of the spec delta", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "draft.md"), "# Draft\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/draft\.md/);
});

test("governing docs survive C-quoting: a non-ASCII doc name is still named", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "платежи.md"), "# Платежи\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: payments");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /- docs\/domain\/платежи\.md/);
	assert.doesNotMatch(brief, /none changed on this branch/);
});

test("governing docs cover renames: both old and new doc paths are named", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "old-name.md"), "# Spec\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: spec");
	await git("checkout", "-q", "main");
	await git("merge", "-q", "--ff-only", "feature");
	await git("checkout", "-q", "feature");
	await git("mv", "docs/domain/old-name.md", "docs/domain/new-name.md");
	await git("commit", "-qm", "docs: rename");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /- docs\/domain\/new-name\.md/);
	assert.match(brief, /- docs\/domain\/old-name\.md/);
});

test("paths with control chars or quotes are presented quoted, never raw", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// a double-quote and a tab are both legal in a Linux pathname; raw
	// interpolation would break the tab-delimited manifest and let a
	// crafted newline inject Markdown into the Governing docs list
	const quoted = 'docs/domain/a"b.md';
	fs.writeFileSync(path.join(dir, "docs", "domain", 'a"b.md'), "# Q\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: quoted");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	// JSON.stringify escapes the quote — the raw path never appears verbatim
	assert.ok(brief.includes(JSON.stringify(quoted)), "governing docs quote the path");
	assert.ok(!brief.includes(`- ${quoted}`), "the raw quote is not interpolated");
});

test("review paths escape every shared non-printable filename scalar", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	const cases = [
		["c1\u0085name.md", "\\u0085"],
		["line\u2028separator.md", "\\u2028"],
		["paragraph\u2029separator.md", "\\u2029"],
		["bidi\u202eoverride.md", "\\u202e"],
		["invisible\u200bspace.md", "\\u200b"],
	];
	for (const [name] of cases) {
		fs.writeFileSync(path.join(dir, "docs", "domain", name), "# Safe display\n");
	}
	await git("add", ".");
	await git("commit", "-qm", "docs: hostile display names");

	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	for (const [name, escaped] of cases) {
		assert.ok(!brief.includes(name), `${JSON.stringify(name)} stayed raw`);
		assert.ok(brief.includes(escaped), `${JSON.stringify(name)} was not visibly escaped`);
	}
});

test("non-UTF-8 doc names stay distinct: byte-safe parsing never collapses paths", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// two distinct filenames that a UTF-8 decode folds to the same U+FFFD
	// string; byte-exact parsing must keep them as two governing docs
	const base = Buffer.from(`${dir}/docs/domain/`);
	fs.writeFileSync(Buffer.concat([base, Buffer.from([0xff]), Buffer.from(".md")]), "# A\n");
	fs.writeFileSync(Buffer.concat([base, Buffer.from([0xfe]), Buffer.from(".md")]), "# B\n");
	await git("add", "-A");
	await git("commit", "-qm", "docs: byte names");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	// byte-distinct not only in matching but in the display: each renders
	// its own escaped bytes, never a shared U+FFFD
	assert.match(brief, /- "docs\/domain\/\\xff\.md"/);
	assert.match(brief, /- "docs\/domain\/\\xfe\.md"/);
});

test("governing-doc globs with a non-ASCII literal match under byte-safe encoding", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			canonicalDocs: ["docs/über/**/*.md"],
		}),
	);
	fs.mkdirSync(path.join(dir, "docs", "über"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "über", "spec.md"), "# Spec\n");
	await git("add", "-A");
	await git("commit", "-qm", "docs: uber");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/über\/spec\.md/);
	assert.doesNotMatch(brief, /none changed on this branch/);
});

test("an untracked non-UTF-8 doc is fingerprinted byte-safely: a later edit stales the review", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// a non-UTF-8 untracked file: a UTF-8 decode would look it up under a
	// U+FFFD path, get a null fingerprint, and never notice a content change
	const p = Buffer.concat([Buffer.from(`${dir}/docs/domain/`), Buffer.from([0xff]), Buffer.from(".md")]);
	fs.writeFileSync(p, "# original\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	fs.writeFileSync(p, "# changed after the snapshot was recorded\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr); // stale — snapshot changed
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("a file named __proto__ is fingerprinted: a later edit stales the review", async () => {
	const { dir } = await tmpGitRepo();
	// a plain {} would route this through Object.prototype's __proto__ setter
	// and drop it from the snapshot; a null-prototype object keeps it
	fs.writeFileSync(path.join(dir, "__proto__"), "# original\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	fs.writeFileSync(path.join(dir, "__proto__"), "# changed after the snapshot was recorded\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr); // stale — snapshot changed
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("an untracked governing doc is named but its content is never inlined", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "governed.md"), "# Spec\nINLINE_MARKER_XYZ\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /docs\/domain\/governed\.md/); // named
	assert.doesNotMatch(brief, /INLINE_MARKER_XYZ/); // content not inlined (paths-only)
});

test("governing docs without a doc change name the configured globs instead", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/\*\*\/\*\.md/);
	assert.doesNotMatch(brief, /read these first/);
});

test("review request ids carry real entropy", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	const requests = readLedger(dir).filter((e) => e.event === "review-request");
	assert.equal(requests.length, 2);
	assert.match(requests[0].id, /^rev-[0-9a-f]{32}$/);
	assert.match(requests[1].id, /^rev-[0-9a-f]{32}$/);
	assert.notEqual(requests[0].id, requests[1].id);
});

test("the review diff cap counts raw UTF-8 bytes", async () => {
	const { dir } = await tmpGitRepo();
	fs.appendFileSync(path.join(dir, "impl.js"), `// ${"€".repeat(450_000)}\n`);

	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	const diffSection = brief.split(/## Diff \(against [^)]+\)\n\n/u)[1];
	const [boundedDiff] = diffSection.split("\n[diff truncated at 400000 bytes");

	assert.ok(Buffer.byteLength(boundedDiff, "utf8") <= 400_000);
	assert.doesNotMatch(boundedDiff, /\uFFFD/u, "the byte boundary must not split a UTF-8 sequence");
});

test("tracked .stdd deliverables are under review — changing one stales the approval", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	// .stdd/config.json is committed in this fixture — a deliverable, not a
	// working artifact
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			redPattern: "changed",
		}),
	);
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, stale.stdout);
	assert.match(stale.stdout, /stale/i);
});

test("the brief skips symlinks and bounds large untracked files", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "secret.txt");
	fs.writeFileSync(outside, "OUTSIDE_SECRET_MARKER");
	fs.symlinkSync(outside, path.join(dir, "leak.txt"));
	fs.writeFileSync(path.join(dir, "big.txt"), `${"x".repeat(50_000)}END_MARKER`);
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.ok(!brief.includes("OUTSIDE_SECRET_MARKER"), "symlink content leaked into the brief");
	assert.match(brief, /\[truncated\]/);
	assert.ok(!brief.includes("END_MARKER"), "large file was read past the bound");
	// skipped or not, every untracked path is NAMED in the manifest —
	// nothing the reviewer was not told about may exist
	const manifestSection = brief.split("## Changed files")[1].split("## Diff")[0];
	assert.match(manifestSection, /leak\.txt.*skipped/);
	assert.match(manifestSection, /big\.txt/);
});

test("large untracked fingerprints never read an oversized file to EOF and still stale on edits", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "large-sparse.bin");
	const descriptor = fs.openSync(target, "w");
	fs.ftruncateSync(descriptor, 8 * 1024 * 1024);
	fs.writeSync(descriptor, Buffer.from("PREFIX"), 0, 6, 0);
	fs.writeSync(descriptor, Buffer.from("TAIL"), 0, 4, 8 * 1024 * 1024 - 4);
	fs.closeSync(descriptor);
	const auditPath = path.join(tmpDir(), "large-read-audit.json");
	const hookPath = path.join(tmpDir(), "large-read-trap.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalClose = fs.closeSync;
const originalWrite = fs.writeFileSync;
const totals = new Map();
const completed = [];

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
function settle(fd) {
  completed.push(totals.get(fd) ?? 0);
  totals.delete(fd);
}
fs.openSync = function (candidate, flags, ...args) {
  const fd = originalOpen.call(this, candidate, flags, ...args);
  if (isTarget(candidate)) totals.set(fd, 0);
  return fd;
};
fs.readSync = function (fd, ...args) {
  const count = originalRead.call(this, fd, ...args);
  if (totals.has(fd)) totals.set(fd, totals.get(fd) + count);
  return count;
};
fs.closeSync = function (fd, ...args) {
  settle(fd);
  return originalClose.call(this, fd, ...args);
};
process.on("exit", () => {
  for (const fd of totals.keys()) settle(fd);
  originalWrite.call(fs, auditPath, JSON.stringify({ completed }));
});
`,
	);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const env = {
		...envWith(clean),
		NODE_OPTIONS: `--import=${hookPath}`,
	};
	const reviewed = await run(["review", "--via", "codex"], { cwd: dir, env });
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
	const reviewedReads = JSON.parse(fs.readFileSync(auditPath, "utf8")).completed;
	assert.ok(
		reviewedReads.some((bytes) => bytes === 8 * 1024 * 1024),
		"the compatibility snapshot retains the historical whole-file raw hash",
	);
	assert.ok(
		reviewedReads.some((bytes) => bytes > 0 && bytes <= 40_000),
		"brief inspection has its own bounded descriptor read",
	);

	const observed = fs.statSync(target);
	fs.utimesSync(target, observed.atime, new Date(observed.mtimeMs + 60_000));
	const metadataOnly = await run(["status", "--gate"], { cwd: dir, env });
	assert.equal(
		metadataOnly.code,
		0,
		"metadata-only changes preserve the historical raw-byte snapshot contract",
	);

	const edited = fs.openSync(target, "r+");
	fs.writeSync(edited, Buffer.from("MIDDLE_EDIT"), 0, 11, 4 * 1024 * 1024);
	fs.closeSync(edited);
	const stale = await run(["status", "--gate"], { cwd: dir, env });
	assert.equal(stale.code, 1, stale.stdout + stale.stderr);
	assert.match(stale.stdout, /stale/i);
	const staleReads = JSON.parse(fs.readFileSync(auditPath, "utf8")).completed;
	assert.ok(
		staleReads.some((bytes) => bytes === 8 * 1024 * 1024) &&
			staleReads.some((bytes) => bytes > 0 && bytes <= 40_000),
		"stale checking keeps raw compatibility and a bounded inspection fingerprint",
	);
});

test("dirty snapshot never follows a regular file replaced by an outside symlink", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "swap-to-link.txt");
	const outside = path.join(tmpDir(), "outside-secret.txt");
	const auditPath = path.join(tmpDir(), "symlink-read-audit.json");
	fs.writeFileSync(target, "repository bytes\n");
	fs.writeFileSync(outside, "OUTSIDE_BYTES_MUST_NOT_BE_READ\n");
	const hookPath = path.join(tmpDir(), "dirty-symlink-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";

const target = ${JSON.stringify(target)};
const outside = ${JSON.stringify(outside)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const outsideIdentity = fs.lstatSync(outside, { bigint: true });
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalWrite = fs.writeFileSync;
let swapped = false;
let outsideReads = 0;
const outsideDescriptors = new Set();

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (!swapped && isTarget(candidate)) {
    swapped = true;
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }
  const fd = originalOpen.call(this, candidate, flags, ...args);
  const opened = fs.fstatSync(fd, { bigint: true });
  if (opened.dev === outsideIdentity.dev && opened.ino === outsideIdentity.ino) {
    outsideDescriptors.add(fd);
  }
  return fd;
};
fs.readSync = function (fd, ...args) {
  const count = originalRead.call(this, fd, ...args);
  if (outsideDescriptors.has(fd)) outsideReads += count;
  return count;
};
process.on("exit", () => {
  originalWrite.call(fs, auditPath, JSON.stringify({ swapped, outsideReads }));
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
	assert.equal(audit.swapped, true, "the pathname race was injected");
	assert.equal(audit.outsideReads, 0, "the replacement symlink target was never read");
	assert.doesNotMatch(`${prep.stdout}${prep.stderr}`, /OUTSIDE_BYTES_MUST_NOT_BE_READ/);
	const status = await run(["status", "--gate"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
});

test("dirty snapshot opens a raced FIFO nonblocking and rejects it without hanging", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "swap-to-fifo.txt");
	const auditPath = path.join(tmpDir(), "fifo-open-audit.json");
	fs.writeFileSync(target, "repository bytes\n");
	const hookPath = path.join(tmpDir(), "dirty-fifo-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalWrite = fs.writeFileSync;
let swapped = false;
let safeFlags = false;

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (!swapped && isTarget(candidate)) {
    swapped = true;
    fs.rmSync(target);
    const made = spawnSync("mkfifo", [target]);
    if (made.status !== 0) throw new Error(String(made.stderr));
  }
  if (isTarget(candidate)) {
    safeFlags =
      typeof flags === "number" &&
      (flags & fs.constants.O_NONBLOCK) !== 0 &&
      (flags & fs.constants.O_NOFOLLOW) !== 0;
    if (!safeFlags) {
      const err = new Error("test refused a potentially blocking FIFO open");
      err.code = "EINTR";
      throw err;
    }
  }
  return originalOpen.call(this, candidate, flags, ...args);
};
process.on("exit", () => {
  originalWrite.call(fs, auditPath, JSON.stringify({ swapped, safeFlags }));
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		timeout: 5000,
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
	assert.equal(audit.swapped, true, "the FIFO race was injected");
	assert.equal(audit.safeFlags, true, "the raced pathname was opened with nonblocking no-follow flags");
	const status = await run(["status", "--gate"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
});

test("brief inspection opens a raced FIFO nonblocking and classifies it unsafe", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "brief-swap-to-fifo.txt");
	const auditPath = path.join(tmpDir(), "brief-fifo-open-audit.json");
	fs.writeFileSync(target, "repository bytes\n");
	const hookPath = path.join(tmpDir(), "brief-fifo-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalWrite = fs.writeFileSync;
let targetOpens = 0;
let swapped = false;
let inspectionSafeFlags = false;

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (isTarget(candidate)) {
    targetOpens++;
    if (targetOpens === 3) {
      swapped = true;
      fs.rmSync(target);
      const made = spawnSync("mkfifo", [target]);
      if (made.status !== 0) throw new Error(String(made.stderr));
      inspectionSafeFlags =
        typeof flags === "number" &&
        (flags & fs.constants.O_NONBLOCK) !== 0 &&
        (flags & fs.constants.O_NOFOLLOW) !== 0;
      if (!inspectionSafeFlags) {
        const err = new Error("test refused a potentially blocking brief FIFO open");
        err.code = "EINTR";
        throw err;
      }
    }
  }
  return originalOpen.call(this, candidate, flags, ...args);
};
process.on("exit", () => {
  originalWrite.call(
    fs,
    auditPath,
    JSON.stringify({ targetOpens, swapped, inspectionSafeFlags }),
  );
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		timeout: 5000,
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
	assert.equal(audit.swapped, true, "the third open raced brief inspection");
	assert.equal(audit.inspectionSafeFlags, true, "brief inspection uses nonblocking no-follow flags");
	assert.doesNotMatch(prep.stdout, /brief written to/);
	assert.match(prep.stderr, /checkout changed|cannot be fingerprinted safely/i);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.ok(
		!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
		"the unsafe brief candidate is rejected before dispatch",
	);
});

test("dirty snapshot rejects hard-linked files without reading their shared inode", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "outside-hardlink.txt");
	const target = path.join(dir, "hardlink.txt");
	const auditPath = path.join(tmpDir(), "hardlink-read-audit.json");
	fs.writeFileSync(outside, "SHARED_OUTSIDE_BYTES\n");
	fs.linkSync(outside, target);
	const hookPath = path.join(tmpDir(), "dirty-hardlink-trap.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalWrite = fs.writeFileSync;
const descriptors = new Set();
let bytesRead = 0;

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  const fd = originalOpen.call(this, candidate, flags, ...args);
  if (isTarget(candidate)) descriptors.add(fd);
  return fd;
};
fs.readSync = function (fd, ...args) {
  const count = originalRead.call(this, fd, ...args);
  if (descriptors.has(fd)) bytesRead += count;
  return count;
};
process.on("exit", () => {
  originalWrite.call(fs, auditPath, JSON.stringify({ bytesRead }));
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	assert.match(prep.stderr, /hardlink\.txt/);
	assert.equal(
		JSON.parse(fs.readFileSync(auditPath, "utf8")).bytesRead,
		0,
		"the shared inode was rejected before content reads",
	);
	const status = await run(["status", "--gate"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
});

test("untracked brief inspection never follows file or parent swaps at open or read", async () => {
	for (const mode of ["file-open", "parent-open", "file-read"]) {
		const { dir } = await tmpGitRepo();
		const parent = path.join(dir, `untracked-${mode}`);
		const parkedParent = path.join(dir, `parked-${mode}`);
		const outsideParent = path.join(tmpDir(), `outside-${mode}`);
		const target = path.join(parent, "candidate.txt");
		const outside = path.join(outsideParent, "candidate.txt");
		fs.mkdirSync(parent);
		fs.mkdirSync(outsideParent);
		fs.writeFileSync(target, `ORIGINAL_UNTRACKED_${mode}\n`);
		fs.writeFileSync(outside, `OUTSIDE_SECRET_${mode}\n`);
		const hookPath = path.join(tmpDir(), `swap-untracked-${mode}.mjs`);
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const mode = ${JSON.stringify(mode)};
const target = ${JSON.stringify(target)};
const parent = ${JSON.stringify(parent)};
const parkedParent = ${JSON.stringify(parkedParent)};
const outsideParent = ${JSON.stringify(outsideParent)};
const outside = ${JSON.stringify(outside)};
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalRename = fs.renameSync;
const targetBytes = Buffer.from(target);
let targetOpens = 0;
let inspectionFd = null;
let swapped = false;
function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
function swap() {
  if (swapped) return;
  swapped = true;
  if (mode === "parent-open") {
    originalRename.call(fs, parent, parkedParent);
    fs.symlinkSync(outsideParent, parent, "dir");
  } else {
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }
}
fs.openSync = function (candidate, flags, ...args) {
  const matches = isTarget(candidate);
  if (matches) {
    targetOpens++;
    if (targetOpens === 2 && mode.endsWith("-open")) swap();
  }
  const fd = originalOpen.call(this, candidate, flags, ...args);
  if (matches && targetOpens === 2) inspectionFd = fd;
  return fd;
};
fs.readSync = function (fd, ...args) {
  if (fd === inspectionFd && mode === "file-read") swap();
  return originalRead.call(this, fd, ...args);
};
`,
		);

		const prep = await run(["review", "--via", "subagent"], {
			cwd: dir,
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(prep.code, 1, `${mode}: ${prep.stdout}${prep.stderr}`);
		assert.match(prep.stderr, /checkout changed.*building.*brief|cannot be fingerprinted safely/i, mode);
		assert.doesNotMatch(prep.stdout, /brief written to/, mode);
		const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
		assert.ok(
			!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
			`${mode}: a raced checkout is rejected before dispatch`,
		);
	}
});

test("unsafe or raced canonical docs are named but never offered as governing docs to open", async () => {
	for (const mode of ["symlink", "tracked-symlink", "open-race"]) {
		const { dir, git } = await tmpGitRepo();
		const docsDir = path.join(dir, "docs", "domain");
		const target = path.join(docsDir, `${mode}.md`);
		const outside = path.join(tmpDir(), `${mode}-secret.md`);
		fs.mkdirSync(docsDir, { recursive: true });
		fs.writeFileSync(outside, `CANONICAL_OUTSIDE_SECRET_${mode}\n`);
		if (mode.endsWith("symlink")) {
			fs.symlinkSync(outside, target);
			if (mode === "tracked-symlink") {
				await git("add", "docs/domain/tracked-symlink.md");
				await git("commit", "-qm", "docs: add unsafe canonical link");
			}
		} else fs.writeFileSync(target, "# Safe before inspection\n");

		let env = process.env;
		if (mode === "open-race") {
			const hookPath = path.join(tmpDir(), "swap-canonical-open.mjs");
			fs.writeFileSync(
				hookPath,
				`import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)};
const outside = ${JSON.stringify(outside)};
const originalOpen = fs.openSync;
const targetBytes = Buffer.from(target);
let targetOpens = 0;
function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (isTarget(candidate) && ++targetOpens === 2) {
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }
  return originalOpen.call(this, candidate, flags, ...args);
};
`,
			);
			env = { ...process.env, NODE_OPTIONS: `--import=${hookPath}` };
		}

		const prep = await run(["review", "--via", "subagent"], { cwd: dir, env });
		if (mode === "open-race") {
			assert.equal(prep.code, 1, `${mode}: ${prep.stdout}${prep.stderr}`);
			assert.match(prep.stderr, /checkout changed.*building.*brief|cannot be fingerprinted safely/i);
			assert.doesNotMatch(prep.stdout, /brief written to/);
			assert.doesNotMatch(
				`${prep.stdout}${prep.stderr}`,
				new RegExp(`CANONICAL_OUTSIDE_SECRET_${mode}`),
			);
			const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
			assert.ok(
				!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
				"a raced canonical doc is rejected before dispatch",
			);
			continue;
		}
		assert.equal(prep.code, 0, `${mode}: ${prep.stdout}${prep.stderr}`);
		const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
		assert.doesNotMatch(brief, new RegExp(`CANONICAL_OUTSIDE_SECRET_${mode}`), mode);
		const manifestSection = brief.split("## Changed files")[1].split("## Diff")[0];
		assert.match(manifestSection, new RegExp(`${mode}\\.md.*(?:unsafe|skipped)`, "i"), mode);
		const governingSection = brief.split("## Governing docs")[1].split("## Plan")[0];
		assert.match(governingSection, new RegExp(`${mode}\\.md.*do not open`, "i"), mode);
		assert.doesNotMatch(governingSection, new RegExp(`read these first[^#]*${mode}\\.md`, "i"), mode);
	}
});

test("an unreadable dirty file aborts the review with the path named; status stays alive", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "aa-locked.txt"), "secret", { mode: 0o000 });
	// a review over content that cannot be read proves nothing — abort,
	// name the path, record nothing
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	assert.match(prep.stderr, /aa-locked\.txt/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing recorded");
	// the soft callers never crash on it
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout);
});

test("a readable file whose bytes spell the sentinel is still just content", async () => {
	const { dir } = await tmpGitRepo();
	// the sentinel lives outside the content-hash namespace — these exact
	// bytes must never be misclassified as an unreadable file
	fs.writeFileSync(path.join(dir, "odd.txt"), "unreadable:odd.txt");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
});

test("scope: a changed-but-still-unreadable file is never inherited dirt", async () => {
	const { dir } = await tmpGitRepo();
	const locked = path.join(dir, "locked.bin");
	fs.writeFileSync(locked, "v1", { mode: 0o000 });
	await run(["slice", "new", "--allowed", "impl.js"], { cwd: dir });
	// the owner flips the bits, changes the content, relocks
	fs.chmodSync(locked, 0o600);
	fs.writeFileSync(locked, "v2-changed");
	fs.chmodSync(locked, 0o000);
	const res = await run(["scope"], { cwd: dir });
	fs.chmodSync(locked, 0o600);
	assert.equal(res.code, 1, "the change happened outside the allowed scope");
});

test("a file turning unreadable after approval reads as stale", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "data.txt"), "readable\n");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.chmodSync(path.join(dir, "data.txt"), 0o000);
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the approval no longer covers what exists");
	fs.chmodSync(path.join(dir, "data.txt"), 0o600);
});

test("the review budget stops the loop after maxRounds changes-requested; errors never burn it", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			review: { via: "codex", maxRounds: 1 },
		}),
	);
	// an error verdict must not count toward the budget
	const malformed = stubCodex("not json at all");
	await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(malformed),
	});
	const blocking = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const first = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(blocking),
	});
	assert.equal(first.code, 1, "the error round did not burn the budget");

	const refused = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(blocking),
	});
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /budget/);
	assert.equal(
		readLedger(dir).filter((e) => e.event === "review-request").length,
		2,
		"the refused round records nothing",
	);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const forced = await run(["review", "--via", "codex", "--force"], {
		cwd: dir,
		env: envWith(clean),
	});
	assert.equal(forced.code, 0, forced.stdout + forced.stderr);
});

test("a stale approval reopens the review in plain status, not only in the gate", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "not-applicable", "--reason", "test fixture"], {
		cwd: dir,
	});
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 5;\n");
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir })).stdout);
	assert.equal(s.review.stale, true);
	assert.equal(s.plan.review.done, false, "a stale approval is not a done review");
	assert.match(s.next, /stdd verify/, "verification stales before the review can be repeated");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const reverified = JSON.parse((await run(["status", "--json"], { cwd: dir })).stdout);
	assert.match(reverified.next, /repair the stale or errored closing review/);
	assert.match(reverified.next, /stdd review/);
	assert.doesNotMatch(reverified.next, /closing review closes/);
});

test("a checkout that changes while the codex reviewer runs records stale", async () => {
	const { dir } = await tmpGitRepo();
	// this stand-in mutates the repo before answering — the approval it
	// returns is about a diff that does not exist anymore
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
printf 'mutated' >> "${path.join(dir, "impl.js")}"
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /stale/);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review/);
});

test("non-ASCII dirty filenames do not crash the review", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "тест-файл.txt"), "содержимое\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
});

test("binary dirty files are hashed by raw bytes, not lossy text decoding", async () => {
	const { dir } = await tmpGitRepo();
	// both byte sequences decode to the same replacement character — a
	// text-decoded hash cannot tell them apart
	fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0xc3]));
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0xc4]));
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the binary changed — the approval must go stale");
});

test("committed binary bytes stale approval even when an external display diff is unchanged", async () => {
	const { dir, git } = await tmpGitRepo();
	const externalDiff = path.join(tmpDir(), "constant-external-diff");
	fs.writeFileSync(externalDiff, "#!/bin/sh\nprintf 'constant binary display\\n'\n");
	fs.chmodSync(externalDiff, 0o755);
	await git("config", "diff.external", externalDiff);
	fs.writeFileSync(path.join(dir, "committed.bin"), Buffer.from([0, 0xff, 1, 0xfe]));
	await git("add", "committed.bin");
	await git("commit", "--amend", "-qm", "binary version one");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const reviewed = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);

	fs.writeFileSync(path.join(dir, "committed.bin"), Buffer.from([0, 0xfe, 1, 0xff]));
	await git("add", "committed.bin");
	await git("commit", "--amend", "-qm", "binary version two");
	const stale = await run(["status", "--gate"], { cwd: dir });

	assert.equal(stale.code, 1, "changed committed bytes cannot inherit approval from a display diff");
	assert.match(stale.stdout, /stale/i);
});

test("snapshots and brief hashes carry a single sha256: prefix", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	const request = readLedger(dir).find((e) => e.event === "review-request");
	assert.match(request.snapshot, /^sha256:[0-9a-f]{64}$/);
	assert.match(request.brief, /^sha256:[0-9a-f]{64}$/);
});

test("edits inside a wholly untracked directory stale the approval", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "newdir"));
	fs.writeFileSync(path.join(dir, "newdir", "mod.js"), "export const a = 1;\n");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.writeFileSync(path.join(dir, "newdir", "mod.js"), "export const a = 2;\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "untracked work changed — the approval must go stale");
});

test("non-ASCII untracked filenames still reach the brief", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "данные.txt"), "CYRILLIC_CONTENT_MARKER\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /CYRILLIC_CONTENT_MARKER/);
});

test("the brief travels to codex over stdin, not as one huge argv element", async () => {
	const { dir } = await tmpGitRepo();
	const side = path.join(tmpDir(), "stdin-capture.txt");
	const argsCapture = path.join(tmpDir(), "argv-capture.txt");
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > "${side}"
printf '%s\\n' "$@" > "${argsCapture}"
out=""
prev=""
last=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
  last="$a"
done
[ "$last" = "-" ] || { echo "prompt must be stdin (-)" >&2; exit 9; }
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const captured = fs.readFileSync(side, "utf8");
	assert.match(captured, /# Independent closing review/);
	const args = fs.readFileSync(argsCapture, "utf8").trimEnd().split("\n");
	assert.deepEqual(args.slice(0, 4), ["exec", "--sandbox", "read-only", "--ephemeral"]);
	assert.equal(args[4], "--output-last-message");
	assert.equal(args.length, 7);
	assert.equal(args.at(-1), "-");
});

test("the brief file is owner-only in a private temp directory", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.equal(fs.statSync(briefPath).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(briefPath)).mode & 0o777, 0o700);
	assert.match(fs.readFileSync(briefPath, "utf8"), /untrusted review data/i);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const submitted = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(submitted.code, 0, submitted.stdout + submitted.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)), "submitted review removes the private brief");
});

test("review requests capture a complete lossless v1 private state", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const request = readLedger(dir).find((event) => event.event === "review-request");
	assert.equal(request.privateState.version, 1);
	assert.equal(
		request.privateState.tempRoot.dev,
		fs.statSync(os.tmpdir(), { bigint: true }).dev.toString(),
	);
	assert.deepEqual(Object.keys(request.privateState.artifacts), [`${request.id}.md`]);
	for (const identity of [
		request.privateState.tempRoot,
		request.privateState.directory,
		...Object.values(request.privateState.artifacts),
	]) {
		assert.deepEqual(Object.keys(identity).sort(), ["dev", "ino", "mode", "nlink", "uid"]);
		for (const value of Object.values(identity)) assert.match(value, /^(?:0|[1-9][0-9]*)$/);
	}
});

test("review --cleanup refuses a same-name directory ABA replacement before mutation", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const briefDir = path.dirname(briefPath);
	const displaced = `${briefDir}.original`;
	const bytes = fs.readFileSync(briefPath);
	fs.renameSync(briefDir, displaced);
	fs.mkdirSync(briefDir, { mode: 0o700 });
	fs.writeFileSync(briefPath, bytes, { mode: 0o600 });

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.deepEqual(fs.readFileSync(briefPath), bytes, "replacement directory remains untouched");
	assert.deepEqual(
		fs.readFileSync(path.join(displaced, path.basename(briefPath))),
		bytes,
		"captured directory remains available for manual remediation",
	);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-cancelled"));
});

test("review --cleanup performs no mutation when held-parent settlement is unavailable", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const before = fs.readFileSync(briefPath);
	const hookPath = path.join(tmpDir(), "review-non-linux.mjs");
	fs.writeFileSync(hookPath, `Object.defineProperty(process, "platform", { value: "darwin" });\n`);

	const cleaned = await run(["review", "--cleanup"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.deepEqual(fs.readFileSync(briefPath), before);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-cancelled"));
});

test("review dispatch fails before allocating private state when held-parent settlement is unavailable", async () => {
	const { dir } = await tmpGitRepo();
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-non-linux-"));
	const hookPath = path.join(tmpDir(), "review-dispatch-non-linux.mjs");
	fs.writeFileSync(hookPath, `Object.defineProperty(process, "platform", { value: "darwin" });\n`);

	const reviewed = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			TMPDIR: privateTmp,
		},
	});

	assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
	assert.match(reviewed.stderr, /secure private review artifact settlement.*unsupported/i);
	assert.deepEqual(fs.readdirSync(privateTmp), []);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.ok(
		!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
	);
});

test("review --result never accepts or deletes a modified or replaced private brief", async () => {
	for (const mode of ["modified", "replaced"]) {
		const { dir } = await tmpGitRepo();
		const prep = await run(["review", "--via", "subagent"], { cwd: dir });
		assert.equal(prep.code, 0, prep.stdout + prep.stderr);
		const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
		const request = readLedger(dir).find((event) => event.event === "review-request");
		const replacement = `UNTRUSTED_PRIVATE_BRIEF_${mode}\n`;
		if (mode === "replaced") replaceReviewFixtureFile(briefPath, replacement);
		else fs.writeFileSync(briefPath, replacement, { mode: 0o600 });
		if (mode === "replaced") assertReviewFixtureInodeChanged(request, briefPath);
		const resultPath = path.join(tmpDir(), `${mode}-result.json`);
		fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');

		const submitted = await run(["review", "--result", resultPath], { cwd: dir });
		assert.equal(submitted.code, 1, `${mode}: ${submitted.stdout}${submitted.stderr}`);
		assert.match(submitted.stderr, /private review brief.*integrity|integrity.*private review brief/i);
		assert.equal(fs.readFileSync(briefPath, "utf8"), replacement, `${mode}: replacement survives`);
		assert.ok(
			!readLedger(dir).some(
				(event) =>
					(event.event === "review" || event.event === "review-cancelled") &&
					event.request === request.id,
			),
			`${mode}: an unverified brief cannot produce a terminal verdict`,
		);

		const cleaned = await run(["review", "--cleanup"], { cwd: dir });
		if (mode === "modified") {
			assert.equal(cleaned.code, 0, `${mode}: ${cleaned.stdout}${cleaned.stderr}`);
			assert.ok(!fs.existsSync(briefPath), `${mode}: the captured inode can be settled`);
			assert.equal(
				readLedger(dir).filter(
					(event) => event.event === "review-cancelled" && event.request === request.id,
				).length,
				1,
			);
		} else {
			assert.equal(cleaned.code, 1, `${mode}: ${cleaned.stdout}${cleaned.stderr}`);
			assert.equal(fs.readFileSync(briefPath, "utf8"), replacement);
			assert.ok(
				!readLedger(dir).some(
					(event) => event.event === "review-cancelled" && event.request === request.id,
				),
				"an ABA replacement requires manual remediation",
			);
		}
	}
});

test("review --result binds verification to the descriptor opened for the private brief", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const replacement = "REPLACED_DURING_DESCRIPTOR_OPEN\n";
	const injected = path.join(tmpDir(), "descriptor-open-injected");
	const hookPath = path.join(tmpDir(), "replace-private-brief-at-open.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const briefPath = ${JSON.stringify(briefPath)};
const replacement = ${JSON.stringify(replacement)};
const injected = ${JSON.stringify(injected)};
const originalOpen = fs.openSync;
let replaced = false;
fs.openSync = function (candidate, ...args) {
  const shown = String(candidate);
  if (
    !replaced &&
    shown.startsWith("/proc/self/fd/") &&
    path.basename(shown) === path.basename(briefPath)
  ) {
    replaced = true;
    const original = originalOpen.call(fs, briefPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.rmSync(briefPath);
      fs.writeFileSync(briefPath, replacement, { mode: 0o600 });
    } finally {
      fs.closeSync(original);
    }
    fs.writeFileSync(injected, "yes");
  }
  return originalOpen.call(this, candidate, ...args);
};
`,
	);
	const resultPath = path.join(tmpDir(), "descriptor-result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');

	const submitted = await run(["review", "--result", resultPath], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.ok(fs.existsSync(injected), "the replacement raced the descriptor open");
	assertReviewFixtureInodeChanged(request, briefPath);
	assert.equal(submitted.code, 1, submitted.stdout + submitted.stderr);
	assert.match(submitted.stderr, /private review brief.*integrity/i);
	assert.equal(fs.readFileSync(briefPath, "utf8"), replacement);
	assert.ok(
		!readLedger(dir).some(
			(event) =>
				(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
		),
		"the raced descriptor cannot authorize a verdict",
	);

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.equal(fs.readFileSync(briefPath, "utf8"), replacement);
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === request.id),
	);
});

test("review --result wipes the verified inode before a quarantine-name replacement race", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const secretMarker = "INDEPENDENT_CLOSING_REVIEW";
	fs.appendFileSync(briefPath, `\n${secretMarker}\n`);
	const request = readLedger(dir).find((event) => event.event === "review-request");
	request.brief = `sha256:${createHash("sha256").update(fs.readFileSync(briefPath)).digest("hex")}`;
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const events = readLedger(dir).map((event) =>
		event.event === "review-request" && event.id === request.id ? request : event,
	);
	fs.writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	const resultPath = path.join(tmpDir(), "quarantine-race-result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const auditPath = path.join(tmpDir(), "result-quarantine-race.json");

	const submitted = await run(["review", "--result", resultPath], {
		cwd: dir,
		env: reviewSettlementReplacementRaceEnv(briefPath, auditPath),
	});

	assert.equal(submitted.code, 1, submitted.stdout + submitted.stderr);
	assert.match(submitted.stderr, /private review brief.*(?:removed|integrity)/i);
	assertQuarantinedSecretWasWiped(JSON.parse(fs.readFileSync(auditPath, "utf8")), secretMarker);
	assert.ok(!readLedger(dir).some((event) => event.event === "review" && event.request === request.id));
});

test("review dispatch rejects transient reverted bytes read while building the brief", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "transient.txt");
	const original = "ORIGINAL_CAPTURED_BYTES\n";
	const transient = "TRANSIENT_UNBOUND_BYTES\n";
	fs.writeFileSync(target, original);
	const hookPath = path.join(tmpDir(), "transient-review-build.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)};
const original = ${JSON.stringify(original)};
const transient = ${JSON.stringify(transient)};
const originalLstat = fs.lstatSync;
let targetLstats = 0;
function isTarget(candidate) {
  return path.resolve(String(candidate)) === target;
}
fs.lstatSync = function (candidate, ...args) {
  if (!isTarget(candidate)) return originalLstat.call(this, candidate, ...args);
  targetLstats++;
  if (targetLstats !== 2) return originalLstat.call(this, candidate, ...args);
  fs.writeFileSync(target, transient);
  const observed = originalLstat.call(this, candidate, ...args);
  fs.writeFileSync(target, original);
  return observed;
};
`,
	);

	const reviewed = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
	assert.match(
		reviewed.stderr,
		/checkout changed.*building.*brief|brief.*captured snapshot|cannot be fingerprinted safely/i,
	);
	assert.equal(fs.readFileSync(target, "utf8"), original);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.ok(
		!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
		"mismatched material is rejected before dispatch",
	);
});

test("concurrent review results record exactly one verdict for the request", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const resultPath = path.join(tmpDir(), "approved.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const results = await Promise.all([
		run(["review", "--result", resultPath], { cwd: dir }),
		run(["review", "--result", resultPath], { cwd: dir }),
	]);

	assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
	assert.match(
		results.find((result) => result.code === 1).stderr,
		/request.*no longer open|private review brief.*(?:integrity|could not be verified and removed)/i,
	);
	const terminal = readLedger(dir).filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminal.length, 1);
	assert.equal(terminal[0].event, "review");
});

test("concurrent review result and cleanup record one terminal outcome", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const resultPath = path.join(tmpDir(), "approved.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const cleanupHook = path.join(tmpDir(), "review-cleanup-remove-race.mjs");
	const cleanupReady = path.join(tmpDir(), "review-cleanup-remove-race.ready");
	fs.writeFileSync(
		cleanupHook,
		`import fs from "node:fs";
import path from "node:path";

const privateDir = ${JSON.stringify(path.dirname(request.briefPath))};
const ready = ${JSON.stringify(cleanupReady)};
const originalRealpath = fs.realpathSync;
fs.realpathSync = function (candidate, ...args) {
  const resolved = path.resolve(String(candidate));
  if (resolved === privateDir) {
    fs.writeFileSync(ready, "ready");
    const deadline = Date.now() + 5000;
    while (fs.existsSync(resolved) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (fs.existsSync(resolved)) throw new Error("timed out waiting for concurrent review result");
  }
  return originalRealpath.call(this, candidate, ...args);
};
`,
	);
	const cleanupPromise = run(["review", "--cleanup"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${cleanupHook}` },
	});
	await waitForPath(cleanupReady);
	const result = await run(["review", "--result", resultPath], { cwd: dir });
	const cleanup = await cleanupPromise;

	assert.equal(cleanup.code, 0, cleanup.stdout + cleanup.stderr);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /request.*no longer open|another result or cleanup already answered/i);
	const terminal = readLedger(dir).filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminal.length, 1);
	assert.equal(terminal[0].event, "review-cancelled");
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "the private brief directory is gone");
});

test("review result reports the cleanup winner after its open request brief disappears", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const resultPath = path.join(tmpDir(), "cleanup-wins-approved.json");
	const ready = path.join(tmpDir(), "cleanup-wins-result.ready");
	const release = path.join(tmpDir(), "cleanup-wins-result.release");
	const hookPath = path.join(tmpDir(), "cleanup-wins-result-race.mjs");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const resultPath = ${JSON.stringify(resultPath)};
const ready = ${JSON.stringify(ready)};
const release = ${JSON.stringify(release)};
const originalRead = fs.readFileSync;
fs.readFileSync = function (candidate, ...args) {
  if (String(candidate) === resultPath) {
    fs.writeFileSync(ready, "ready");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(release) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (!fs.existsSync(release)) throw new Error("timed out waiting for concurrent cleanup");
  }
  return originalRead.call(this, candidate, ...args);
};
`,
	);

	const resultPromise = run(["review", "--result", resultPath], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	await waitForPath(ready);
	const cleanup = await run(["review", "--cleanup"], { cwd: dir });
	fs.writeFileSync(release, "continue");
	const result = await resultPromise;

	assert.equal(cleanup.code, 0, cleanup.stdout + cleanup.stderr);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /request.*no longer open|another result or cleanup already answered/i);
	assert.doesNotMatch(result.stderr, /ENOENT|request left open|run `stdd review --cleanup`/i);
	const terminal = readLedger(dir).filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminal.length, 1);
	assert.equal(terminal[0].event, "review-cancelled");
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "cleanup settled the private directory");
});

test("review --cleanup keeps a missing artifact fail-closed while its private directory remains", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const privateDir = path.dirname(request.briefPath);
	const hookPath = path.join(tmpDir(), "cleanup-missing-artifact-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const briefPath = ${JSON.stringify(request.briefPath)};
const originalTruncate = fs.ftruncateSync;
let removed = false;
fs.ftruncateSync = function (descriptor, length, ...args) {
  const result = originalTruncate.call(this, descriptor, length, ...args);
  if (!removed && length === 0) {
    removed = true;
    fs.rmSync(briefPath);
  }
  return result;
};
`,
	);

	const cleaned = await run(["review", "--cleanup"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.match(cleaned.stderr, /private review.*could not be settled/i);
	assert.ok(fs.existsSync(privateDir), "a partial artifact loss cannot masquerade as full settlement");
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === request.id)
			.length,
		1,
	);
});

test("concurrent cross-CLI completion and cleanup record one terminal outcome", async () => {
	const { dir } = await tmpGitRepo();
	const controlDir = tmpDir();
	const ready = path.join(controlDir, "ready");
	const release = path.join(controlDir, "release");
	const bin = path.join(controlDir, "codex-waiting-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
: > "${ready}"
while [ ! -e "${release}" ]; do sleep 0.01; done
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);

	const completing = run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	await waitForPath(ready);
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	fs.writeFileSync(release, "go");
	const completed = await completing;

	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.equal(completed.code, 1, completed.stdout + completed.stderr);
	assert.match(completed.stderr, /request.*no longer open/i);
	const terminals = readLedger(dir).filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].event, "review-cancelled");
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "the private brief directory is gone");
});

test("review --cleanup cancels abandoned subagent requests and removes their briefs", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.ok(fs.existsSync(briefPath));
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)));
	assert.ok(readLedger(dir).some((e) => e.event === "review-cancelled"));
});

test("review --cleanup reaches an interrupted cross-CLI request and clears its gate", async () => {
	const { dir } = await tmpGitRepo({
		subagents: false,
		crossCli: false,
		worktrees: true,
	});
	const id = "rev-1234abcd";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	fs.writeFileSync(briefPath, "private cross-CLI brief", { mode: 0o600 });
	const lastMessagePath = path.join(briefDir, "last-message.txt");
	fs.writeFileSync(lastMessagePath, "interrupted reviewer output", { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);

	const blocked = await run(["status", "--gate"], { cwd: dir });
	assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
	assert.match(blocked.stdout, /open review request.*crossCli capability is off/i);

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(briefDir), "cleanup removes every owned private cross-CLI artifact");
	const terminals = readLedger(dir).filter(
		(event) => (event.event === "review" || event.event === "review-cancelled") && event.request === id,
	);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].event, "review-cancelled");

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
});

test("review --cleanup leaves legacy present artifacts without privateState for manual remediation", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-1234abd0";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	const bytes = "legacy private bytes\n";
	fs.writeFileSync(briefPath, bytes, { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "subagent",
			snapshot: "captured",
			brief: "sha256:legacy",
			briefPath,
			branch: "feature",
		})}\n`,
	);

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.equal(fs.readFileSync(briefPath, "utf8"), bytes);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-cancelled"));
});

test("review --cleanup preserves unknown private siblings and keeps terminal cleanup retryable", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-1234abce";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	const lastMessagePath = path.join(briefDir, "last-message.txt");
	const unknownPath = path.join(briefDir, "user-note.txt");
	fs.writeFileSync(briefPath, "private cross-CLI brief", { mode: 0o600 });
	fs.writeFileSync(lastMessagePath, "interrupted reviewer output", { mode: 0o600 });
	fs.writeFileSync(unknownPath, "unknown sibling survives\n", { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);

	const first = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(first.code, 1, first.stdout + first.stderr);
	assert.match(first.stderr, /could not remove.*request left open/i);
	assert.equal(fs.readFileSync(unknownPath, "utf8"), "unknown sibling survives\n");
	assert.ok(fs.existsSync(briefPath), "unknown siblings stop settlement before owned bytes are touched");
	assert.ok(fs.existsSync(lastMessagePath));
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === id).length,
		0,
	);

	const second = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(second.code, 1, second.stdout + second.stderr);
	assert.equal(fs.readFileSync(unknownPath, "utf8"), "unknown sibling survives\n");
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === id).length,
		0,
		"retrying an unsafe namespace never records cancellation",
	);

	fs.rmSync(unknownPath);
	const settled = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(settled.code, 0, settled.stdout + settled.stderr);
	assert.ok(!fs.existsSync(briefDir));
});

test("review --cleanup rejects an unsafe last-message companion without touching its target", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-1234abcf";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	fs.writeFileSync(briefPath, "private cross-CLI brief", { mode: 0o600 });
	const outside = path.join(tmpDir(), "outside-last-message.txt");
	fs.writeFileSync(outside, "outside survives\n");
	fs.symlinkSync(outside, path.join(briefDir, "last-message.txt"));
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.match(cleaned.stderr, /could not remove|unsafe|private/i);
	assert.equal(fs.readFileSync(outside, "utf8"), "outside survives\n");
	assert.ok(fs.existsSync(briefPath), "unsafe preflight leaves the request artifacts intact");
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === id),
	);
});

test("review --cleanup wipes owned bytes before a quarantine-name replacement race", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const secretMarker = "CLEANUP_PRIVATE_SECRET";
	fs.appendFileSync(briefPath, `\n${secretMarker}\n`);
	const auditPath = path.join(tmpDir(), "cleanup-quarantine-race.json");

	const cleaned = await run(["review", "--cleanup"], {
		cwd: dir,
		env: reviewSettlementReplacementRaceEnv(briefPath, auditPath),
	});

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.match(cleaned.stderr, /private review.*could not be settled/i);
	assertQuarantinedSecretWasWiped(JSON.parse(fs.readFileSync(auditPath, "utf8")), secretMarker);
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === request.id)
			.length,
		1,
	);
});

test("review --cleanup keeps cancellation on the captured branch when deletion switches checkout", async () => {
	const { dir, git } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const briefDirName = path.basename(path.dirname(briefPath));
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const hookPath = path.join(tmpDir(), "cleanup-branch-switch.mjs");
	fs.writeFileSync(
		hookPath,
		`import { spawnSync } from "node:child_process";
import fs from "node:fs";

let switched = false;
const originalRename = fs.renameSync;
fs.renameSync = function (source, target, ...args) {
  if (!switched && String(source).endsWith(${JSON.stringify(`/${briefDirName}`)})) {
    switched = true;
    const result = spawnSync("git", ["-C", ${JSON.stringify(dir)}, "checkout", "-qb", "hijack"], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);

	const cleaned = await run(["review", "--cleanup"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});

	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.equal((await git("branch", "--show-current")).stdout.trim(), "hijack");
	assert.ok(!fs.existsSync(briefPath));
	const cancellation = readLedger(dir).find(
		(event) => event.event === "review-cancelled" && event.request === request.id,
	);
	assert.equal(cancellation.branch, "feature");
});

test("review --cleanup preserves an open request and its brief when cancellation append fails", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const hookPath = path.join(tmpDir(), "cleanup-append-failure.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const originalAppend = fs.appendFileSync;
fs.appendFileSync = function (target, data, ...args) {
  if (String(data).includes('"event":"review-cancelled"')) {
    throw new Error("injected cancellation append failure");
  }
  return originalAppend.call(this, target, data, ...args);
};
`,
	);

	const cleaned = await run(["review", "--cleanup"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.match(cleaned.stderr, /injected cancellation append failure/);
	assert.match(cleaned.stderr, /request left open/);
	assert.ok(fs.existsSync(briefPath), "an open request must retain its private brief");
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === request.id),
	);
});

test("review --cleanup retries a post-cancellation brief deletion failure", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const briefDirName = path.basename(path.dirname(briefPath));
	const hookPath = path.join(tmpDir(), "cleanup-quarantine-rename-failure.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const originalRename = fs.renameSync;
let failed = false;
fs.renameSync = function (source, target, ...args) {
  if (!failed && String(source).endsWith(${JSON.stringify(`/${briefDirName}`)})) {
    failed = true;
    throw new Error("injected private quarantine rename failure");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);

	const first = await run(["review", "--cleanup"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(first.code, 1, first.stdout + first.stderr);
	assert.match(first.stderr, /request .* was cancelled.*private review.*could not be settled/i);
	assert.match(first.stderr, /injected private quarantine rename failure/);
	assert.equal(fs.readFileSync(briefPath, "utf8"), "", "failed settlement retains only wiped bytes");
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === request.id)
			.length,
		1,
	);

	const retried = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(retried.code, 0, retried.stdout + retried.stderr);
	assert.ok(!fs.existsSync(briefPath), "later cleanup removes the cancelled request's retained brief");
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === request.id)
			.length,
		1,
		"retrying physical cleanup never appends a duplicate terminal cancellation",
	);
});

test("review --cleanup rejects primitive ledger events without crashing", async () => {
	for (const primitive of ["null", "42"]) {
		const { dir } = await tmpGitRepo();
		fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), `${primitive}\n`);

		const cleaned = await run(["review", "--cleanup"], { cwd: dir });
		assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
		assert.match(cleaned.stderr, /malformed task boundary/i);
		assert.match(cleaned.stderr, /repair.*ledger\.jsonl/i);
		assert.doesNotMatch(cleaned.stderr, /TypeError/);
	}
});

test("review --cleanup leaves a request open when its private brief cannot be removed", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const original = fs.openSync(briefPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		fs.rmSync(briefPath);
		fs.mkdirSync(briefPath);

		const failed = await run(["review", "--cleanup"], { cwd: dir });
		assert.equal(failed.code, 1, failed.stdout + failed.stderr);
		assert.match(failed.stderr, /could not remove/i);
		assert.ok(
			!readLedger(dir).some(
				(event) => event.event === "review-cancelled" && event.request === request.id,
			),
			"failed deletion must not make the request look answered",
		);

		fs.rmdirSync(briefPath);
		fs.writeFileSync(briefPath, "private brief", { mode: 0o600 });
	} finally {
		fs.closeSync(original);
	}
	assertReviewFixtureInodeChanged(request, briefPath);
	const retried = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(retried.code, 1, retried.stdout + retried.stderr);
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === request.id),
		"a replacement inode cannot inherit the captured cleanup authority",
	);
});

test("review --cleanup never follows a ledger-named symlink directory to delete an outside file", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const realBriefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const outsideDir = tmpDir();
	const victimPath = path.join(outsideDir, `${request.id}.md`);
	fs.writeFileSync(victimPath, "must survive");
	const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.rmdirSync(symlinkDir);
	fs.symlinkSync(outsideDir, symlinkDir, "dir");

	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const forgedLedger = fs
		.readFileSync(ledgerPath, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => {
			const event = JSON.parse(line);
			return JSON.stringify(
				event.event === "review-request"
					? { ...event, briefPath: path.join(symlinkDir, `${request.id}.md`) }
					: event,
			);
		})
		.join("\n");
	fs.writeFileSync(ledgerPath, `${forgedLedger}\n`);

	const failed = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /could not remove/i);
	assert.equal(fs.readFileSync(victimPath, "utf8"), "must survive");
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === request.id),
		"untrusted deletion target must leave the request open",
	);

	fs.unlinkSync(symlinkDir);
	fs.rmSync(victimPath);
	fs.rmdirSync(outsideDir);
	fs.rmSync(realBriefPath);
	fs.rmdirSync(path.dirname(realBriefPath));
});

test("review --cleanup reaches abandoned briefs after their task is finished", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "abandoned review"], { cwd: dir });
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.ok(fs.existsSync(briefPath));
	await run(["task", "finish"], { cwd: dir });

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)));
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const cancelled = readLedger(dir).find((event) => event.event === "review-cancelled");
	assert.equal(cancelled.request, request.id);
	assert.equal(cancelled.taskId, request.taskId);
});

test("review --cleanup preserves legacy branch-scoped cancellation provenance", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	assert.equal(request.taskId, undefined, "fixture request is legacy branch-scoped");

	await run(["task", "start", "newer task"], { cwd: dir });
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)));
	const cancelled = readLedger(dir).find((event) => event.event === "review-cancelled");
	assert.equal(cancelled.request, request.id);
	assert.equal(cancelled.taskId, undefined, "cancellation is not attributed to the newer task");
});

test("a branch switch while the reviewer runs cancels the original request without a verdict", async () => {
	const { dir } = await tmpGitRepo();
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
git -C "${dir}" checkout -qb hijack
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /switched branches/i);
	assert.match(res.stderr, /cancelled.*original request/i);
	const events = readLedger(dir);
	const request = events.find((event) => event.event === "review-request");
	const terminals = events.filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminals.length, 1, "the captured request gets exactly one terminal outcome");
	assert.equal(terminals[0].event, "review-cancelled");
	assert.equal(terminals[0].branch, "feature");
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "the private brief is removed");

	await exec("git", ["-C", dir, "checkout", "-q", "feature"]);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities.crossCli = false;
	fs.writeFileSync(configPath, JSON.stringify(config));
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
});

test("a task switch while the reviewer runs cancels the original request, not the new task", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const bin = path.join(tmpDir(), "codex-task-switch-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
node "${CLI}" task finish > /dev/null
node "${CLI}" task start "replacement task" > /dev/null
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /active task changed/i);
	assert.match(res.stderr, /cancelled.*original request/i);
	const events = readLedger(dir);
	const request = events.find((event) => event.event === "review-request");
	const terminals = events.filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].event, "review-cancelled");
	assert.equal(terminals[0].taskId, request.taskId);
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "the private brief is removed");
	const replacement = events.find(
		(event) => event.event === "task-start" && event.name === "replacement task",
	);
	assert.ok(replacement, "the replacement task exists");
	assert.equal(typeof replacement.id, "string");
	assert.notEqual(replacement.id, request.taskId);
	assert.notEqual(terminals[0].taskId, replacement.id);
});

test("a task switch while review --result is being read records nothing", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const fifo = path.join(tmpDir(), "review-result.fifo");
	const ready = path.join(tmpDir(), "writer-ready");
	const release = path.join(tmpDir(), "writer-release");
	await exec("mkfifo", [fifo]);
	const writer = exec(
		"sh",
		[
			"-c",
			'exec 3>"$1"; : > "$2"; while [ ! -e "$3" ]; do sleep 0.01; done; printf %s "$4" >&3',
			"review-writer",
			fifo,
			ready,
			release,
			'{"summary":"sound","findings":[]}',
		],
		{ cwd: dir },
	);
	const submitted = run(["review", "--result", fifo], { cwd: dir });
	for (let attempts = 0; !fs.existsSync(ready) && attempts < 500; attempts++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(fs.existsSync(ready), "review submit reached the blocking result read");

	await run(["task", "finish"], { cwd: dir });
	await run(["task", "start", "replacement task"], { cwd: dir });
	fs.writeFileSync(release, "");
	await writer;
	const res = await submitted;

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /active task changed/i);
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review").length,
		0,
		"the replacement task receives no verdict",
	);
	assert.ok(fs.existsSync(briefPath), "the still-open request keeps its private brief for cleanup");
});

test("a task switch after the final result check cannot attach approval to the replacement task", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const planPath = path.join(dir, ".stdd", "plan.md");
	const checkedPlan = "# Replacement plan\n\n- [x] closing review [review:]\n";
	const uncheckedPlan = "# Replacement plan\n\n- [ ] closing review [review:]\n";
	fs.writeFileSync(planPath, checkedPlan);
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);

	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const hookPath = path.join(tmpDir(), "switch-after-check.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const originalRead = fs.readFileSync;
let resultRead = false;
let switched = false;
fs.readFileSync = function (target, ...args) {
  const value = originalRead.call(this, target, ...args);
  if (String(target) === ${JSON.stringify(resultPath)}) resultRead = true;
  if (resultRead && !switched && String(target) === ${JSON.stringify(planPath)}) {
    switched = true;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    for (const command of [["task", "finish"], ["task", "start", "replacement task"]]) {
      const run = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...command], {
        cwd: ${JSON.stringify(dir)},
        env,
        encoding: "utf8",
      });
      if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    }
    fs.writeFileSync(${JSON.stringify(planPath)}, ${JSON.stringify(uncheckedPlan)});
  }
  return value;
};
`,
	);

	const submitted = await run(["review", "--result", resultPath], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(submitted.code, 1, submitted.stdout + submitted.stderr);
	assert.match(submitted.stderr, /active task changed/i);
	const events = readLedger(dir);
	const replacement = events.filter((event) => event.event === "task-start").at(-1);
	assert.equal(replacement.name, "replacement task");
	assert.ok(
		!events.some((event) => event.event === "review" && event.taskId === replacement.id),
		"task A's result must never become task B's verdict",
	);
	assert.equal(
		events.filter((event) => event.event === "review").length,
		0,
		"a task switch in the final record window records no verdict",
	);
	assert.equal(fs.readFileSync(planPath, "utf8"), uncheckedPlan);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review, null, "the replacement task has no forged approval");
	assert.equal(status.plan.review.done, false);
});

test("a plan change at the verdict lock records no approval for the old snapshot", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const planPath = path.join(dir, ".stdd", "plan.md");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');

	const submitted = await run(["review", "--result", resultPath], {
		cwd: dir,
		env: { ...process.env, ...changePlanAtVerdictLockEnv(resultPath, planPath) },
	});
	assert.equal(submitted.code, 1, submitted.stdout + submitted.stderr);
	assert.match(submitted.stderr, /checkout changed.*nothing recorded/i);
	assert.match(fs.readFileSync(planPath, "utf8"), /injected after final snapshot/);
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review").length,
		0,
		"the old plan snapshot receives no approval",
	);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review, null);
	assert.equal(status.plan.review.done, false);
});

test("an untracked symlink is hashed by its target path, not the target's content", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "target.txt");
	fs.writeFileSync(outside, "v1");
	fs.symlinkSync(outside, path.join(dir, "link.txt"));
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	// the file OUTSIDE the repository changes — the review must stay fresh
	fs.writeFileSync(outside, "v2");
	const still = await run(["status", "--gate"], { cwd: dir });
	assert.equal(still.code, 0, still.stdout);
});

test("--result never completes a codex request — no forged provenance", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-deadbeef";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	fs.writeFileSync(briefPath, "private brief for an interrupted CLI request", { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "hand-fed", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /codex/);
	assert.equal(readLedger(dir).filter((e) => e.event === "review").length, 0);
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(briefDir));
});

test("ledger-derived approval leaves every parsed plan checkbox unchanged", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(
		planPath,
		[
			"# P",
			"",
			"```",
			"- [ ] fenced example [review:]",
			"```",
			"",
			"- [x] impl",
			"- [ ] closing review [review:]",
			"",
			"## Deferred",
			"",
			"- [ ] deferred cut [review:]",
			"",
		].join("\n"),
	);
	const before = fs.readFileSync(planPath, "utf8");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(fs.readFileSync(planPath, "utf8"), before);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("ledger-derived approval recognizes the real tag without rewriting code mentions", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	const before = "# P\n\n- [ ] tests cover the `[review:]` tag\n- [ ] closing review [review:]\n";
	fs.writeFileSync(planPath, before);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(fs.readFileSync(planPath, "utf8"), before);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("status names stdd review for an open [review:] item and shows the review line", async () => {
	const { dir } = await tmpGitRepo();
	const env = {
		...process.env,
		PATH: `${path.join(dir, "fake-bin")}:${process.env.PATH}`,
	};
	fs.mkdirSync(path.join(dir, "fake-bin"));
	fs.writeFileSync(
		path.join(dir, "fake-bin", "gh"),
		'#!/bin/sh\necho "no pull requests found" >&2; exit 1\n',
	);
	fs.chmodSync(path.join(dir, "fake-bin", "gh"), 0o755);
	await run(["docs", "not-applicable", "--reason", "test fixture"], {
		cwd: dir,
	});
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.match(s.next, /stdd review/);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const after = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(after.review.verdict, "approved");
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /review: approved via codex/);
});
