import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isStateLedgerEvent } from "../cli/ledger.mjs";
import { parseLedger, parsePlan, planProgress } from "../cli/lib.mjs";
import { withoutImplBackupDir } from "../cli/without-impl.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

const PROBE_PATHS = [
	"src/impl.js",
	"src/modified.js",
	"src/removed.js",
	"src/added-committed.js",
	"src/staged-new.js",
	"src/untracked.js",
	"src/kept.js",
	"bin/tool.sh",
	"test/probe.js",
	"test/new.test.js",
	"docs/domain/pricing.md",
];

// The probe is the "test": it reports what the tree looked like while it ran
// and fails the way a real test does when the implementation is missing.
const FEATURE_PROBE = `const fs = require("node:fs");
const seen = {};
for (const p of ${JSON.stringify(PROBE_PATHS)}) {
	seen[p] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
console.log(JSON.stringify(seen));
if (!/feature/.test(seen["src/impl.js"] ?? "")) {
	console.log("1 failing");
	process.exit(1);
}
`;

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

/** Every path with its bytes and mode (symlinks by target), .git and the ledger excluded. */
function treeState(root) {
	const state = {};
	const walk = (dir, relative = "") => {
		for (const entry of fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = relative ? `${relative}/${entry.name}` : entry.name;
			if (rel === ".git" || rel === ".stdd/ledger.jsonl") continue;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				state[`${rel}/`] = "dir";
				walk(abs, rel);
			} else if (entry.isSymbolicLink()) {
				state[rel] = `link:${fs.readlinkSync(abs)}`;
			} else {
				const st = fs.statSync(abs);
				state[rel] = `${(st.mode & 0o777).toString(8)}:${fs.readFileSync(abs).toString("base64")}`;
			}
		}
	};
	walk(root);
	return state;
}

async function gitState(git) {
	const status = (await git("status", "--porcelain", "--untracked-files=all")).stdout;
	const index = (await git("ls-files", "-s")).stdout;
	const staged = (await git("diff", "--cached")).stdout;
	return { status, index, staged };
}

/**
 * main → feature with committed implementation, test, and docs changes, plus
 * a working tree carrying every kind of change the strip set must handle.
 */
async function fixture({ config = { baseRef: "main", redPattern: "\\d+ failing" } } = {}) {
	const dir = makeTempDir("stdd-without-impl-");
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	const write = (rel, content, mode) => {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
		if (mode !== undefined) fs.chmodSync(path.join(dir, rel), mode);
	};
	await git("init", "-q", "-b", "main");
	write(".stdd/config.json", JSON.stringify(config));
	write(".gitignore", ".stdd/ledger.jsonl\n");
	write("src/impl.js", "export const v = 'base';\n");
	write("src/modified.js", "base modified\n");
	write("src/removed.js", "to be removed\n");
	write("src/kept.js", "unchanged\n");
	write("test/probe.js", "console.log('base probe'); process.exit(1);\n");
	write("docs/domain/pricing.md", "Prices are net.\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	write("src/impl.js", "export const v = 'feature';\n");
	write("src/added-committed.js", "committed on the branch\n");
	write("bin/tool.sh", "#!/bin/sh\necho tool\n", 0o755);
	write("test/probe.js", FEATURE_PROBE);
	write("docs/domain/pricing.md", "Prices are gross.\n");
	await git("add", ".");
	await git("commit", "-qm", "feature");
	// working tree: tracked modified, tracked deleted, staged new, untracked, untracked test
	write("src/modified.js", "feature modified\n");
	fs.rmSync(path.join(dir, "src", "removed.js"));
	write("src/staged-new.js", "staged\n");
	await git("add", "src/staged-new.js");
	write("src/untracked.js", "untracked impl\n");
	write("test/new.test.js", "untracked test\n");
	return { dir, git };
}

const EXPECTED_STRIP = [
	"bin/tool.sh",
	"src/added-committed.js",
	"src/impl.js",
	"src/modified.js",
	"src/removed.js",
	"src/staged-new.js",
	"src/untracked.js",
];

function readLedger(dir) {
	const file = path.join(dir, ".stdd", "ledger.jsonl");
	return fs.existsSync(file) ? parseLedger(fs.readFileSync(file, "utf8")) : [];
}

test("red --without-impl strips the implementation, keeps tests and docs, and restores byte-for-byte", async () => {
	const { dir, git } = await fixture();
	const before = treeState(dir);
	const gitBefore = await gitState(git);

	const res = await run(["red", "--without-impl", "--", "node", "test/probe.js"], { cwd: dir });
	assert.equal(res.code, 1, res.stderr);
	const seen = JSON.parse(res.stdout.split("\n")[0]);
	assert.equal(seen["src/impl.js"], "export const v = 'base';\n", "committed impl change reverted");
	assert.equal(seen["src/modified.js"], "base modified\n", "unstaged modification reverted");
	assert.equal(seen["src/removed.js"], "to be removed\n", "working-tree deletion reverted");
	assert.equal(seen["src/added-committed.js"], null, "file added on the branch removed");
	assert.equal(seen["src/staged-new.js"], null, "staged new file removed");
	assert.equal(seen["src/untracked.js"], null, "untracked file removed");
	assert.equal(seen["bin/tool.sh"], null, "executable added on the branch removed");
	assert.equal(seen["src/kept.js"], "unchanged\n", "unchanged file untouched");
	assert.equal(seen["test/probe.js"], FEATURE_PROBE, "the modified test survives");
	assert.equal(seen["test/new.test.js"], "untracked test\n", "an untracked test survives");
	assert.equal(seen["docs/domain/pricing.md"], "Prices are gross.\n", "canonical docs survive");

	assert.deepEqual(treeState(dir), before, "the tree is restored byte-for-byte, modes included");
	assert.deepEqual(await gitState(git), gitBefore, "status, index, and staged state are unchanged");
	assert.equal(fs.existsSync(withoutImplBackupDir(dir)), false, "the backup directory is removed");

	for (const stripped of EXPECTED_STRIP) {
		assert.match(res.stderr, new RegExp(`^\\s*${stripped.replaceAll(".", "\\.")}$`, "m"));
	}
	assert.match(res.stderr, /restored/i);

	const [event] = readLedger(dir);
	assert.equal(event.event, "red");
	assert.equal(event.exit, 1);
	assert.equal(event.genuine, "yes");
	assert.equal(event.mode, "without-implementation");
	assert.deepEqual(event.stripped, EXPECTED_STRIP);
	assert.equal(event.cmd, "node test/probe.js");
	assert.ok(isStateLedgerEvent({ ...event }), "the event passes the durable schema");
});

test("red --without-impl restores the tree when the command cannot run and passes 127 through", async () => {
	const { dir, git } = await fixture();
	const before = treeState(dir);
	const gitBefore = await gitState(git);
	const res = await run(["red", "--without-impl", "--", "stdd-no-such-command-xyz"], { cwd: dir });
	assert.equal(res.code, 127);
	assert.deepEqual(treeState(dir), before);
	assert.deepEqual(await gitState(git), gitBefore);
	const [event] = readLedger(dir);
	assert.equal(event.mode, "without-implementation");
	assert.equal(event.genuine, "no");
});

test("red --without-impl fails loudly, keeps the backup, and records nothing when the snapshot differs", async () => {
	const { dir } = await fixture();
	const res = await run(
		[
			"red",
			"--without-impl",
			"--",
			"node",
			"-e",
			"require('node:fs').writeFileSync('coverage.txt', 'x'); console.log('1 failing'); process.exit(1)",
		],
		{ cwd: dir },
	);
	assert.equal(res.code, 1);
	const backup = withoutImplBackupDir(dir);
	assert.match(res.stderr, /coverage\.txt/);
	assert.ok(res.stderr.includes(backup), `names the backup directory: ${res.stderr}`);
	assert.ok(fs.existsSync(path.join(backup, "manifest.json")), "the backup is retained");
	assert.deepEqual(readLedger(dir), [], "nothing is recorded");
	// the stripped paths were still restored
	assert.equal(
		fs.readFileSync(path.join(dir, "src", "impl.js"), "utf8"),
		"export const v = 'feature';\n",
	);
	assert.equal(fs.existsSync(path.join(dir, "src", "untracked.js")), true);

	// a leftover backup from an interrupted run refuses the next run
	fs.rmSync(path.join(dir, "coverage.txt"));
	const again = await run(["red", "--without-impl", "--", "node", "test/probe.js"], { cwd: dir });
	assert.equal(again.code, 1);
	assert.ok(again.stderr.includes(backup), again.stderr);
	assert.deepEqual(readLedger(dir), []);
	fs.rmSync(backup, { recursive: true, force: true });
});

test("red --without-impl refuses without a resolvable baseRef, an empty strip set, or an operation in progress", async () => {
	const noBase = await fixture({ config: { redPattern: "\\d+ failing" } });
	let res = await run(["red", "--without-impl", "--", "node", "test/probe.js"], { cwd: noBase.dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /baseRef/);
	assert.deepEqual(readLedger(noBase.dir), []);

	const badBase = await fixture({ config: { baseRef: "nope/missing" } });
	res = await run(["red", "--without-impl", "--", "node", "test/probe.js"], { cwd: badBase.dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /nope\/missing/);
	assert.deepEqual(readLedger(badBase.dir), []);

	const { dir, git } = await fixture();
	// only test and docs changes against main: nothing to strip
	await git("reset", "-q", "--hard");
	await git("clean", "-fdq");
	await git("checkout", "-q", "main");
	await git("checkout", "-qb", "docs-only");
	fs.writeFileSync(path.join(dir, "test", "probe.js"), FEATURE_PROBE);
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	await git("add", ".");
	await git("commit", "-qm", "tests and docs");
	res = await run(["red", "--without-impl", "--", "node", "test/probe.js"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /nothing to strip/);
	assert.match(res.stderr, /main/);
	assert.deepEqual(readLedger(dir), []);

	await git("checkout", "-q", "feature");
	const head = (await git("rev-parse", "HEAD")).stdout.trim();
	fs.writeFileSync(path.join(dir, ".git", "MERGE_HEAD"), `${head}\n`);
	res = await run(["red", "--without-impl", "--", "node", "test/probe.js"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /merge/i);
	assert.deepEqual(readLedger(dir), []);
	assert.equal(
		fs.readFileSync(path.join(dir, "src", "impl.js"), "utf8"),
		"export const v = 'feature';\n",
	);
});

test("--without-impl belongs to red only and still needs the -- separator", async () => {
	const { dir } = await fixture();
	let res = await run(["verify", "--without-impl", "--", "node", "test/probe.js"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /--without-impl/);
	res = await run(["red", "--without-impl", "node", "test/probe.js"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /--/);
	res = await run(["red", "--", "--without-impl", "node"], { cwd: dir });
	assert.equal(res.code, 127, "after -- the flag is part of the command");
	assert.deepEqual(readLedger(dir).length, 1);
});

test("a without-implementation red closes a [red:] plan item like any genuine red", async () => {
	const plan = parsePlan("- [x] probe proven [red: probe.js]\n");
	const event = {
		event: "red",
		cmd: "node test/probe.js",
		exit: 1,
		genuine: "yes",
		mode: "without-implementation",
		stripped: ["src/impl.js"],
	};
	assert.equal(planProgress(plan, [event]).done, 1);
	assert.equal(planProgress(plan, [{ ...event, genuine: "no" }]).done, 0);

	const { dir } = await fixture();
	const started = await run(["task", "start", "prove the probe"], { cwd: dir });
	assert.equal(started.code, 0, started.stderr);
	fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "- [x] probe proven [red: probe.js]\n");
	const res = await run(["red", "--without-impl", "--", "node", "test/probe.js"], { cwd: dir });
	assert.equal(res.code, 1);
	const status = await run(["status", "--local", "--json"], { cwd: dir });
	assert.equal(status.code, 0, status.stderr);
	const parsed = JSON.parse(status.stdout);
	assert.equal(parsed.plan.done, 1);
	assert.equal(parsed.loop.red.done, true);
});

test("the durable schema accepts the without-implementation fields only together", () => {
	const base = {
		event: "red",
		branch: "feature",
		cmd: "node test/probe.js",
		exit: 1,
		excerpt: "1 failing",
		genuine: "yes",
	};
	assert.equal(isStateLedgerEvent(base), true);
	assert.equal(
		isStateLedgerEvent({ ...base, mode: "without-implementation", stripped: ["src/impl.js"] }),
		true,
	);
	assert.equal(isStateLedgerEvent({ ...base, mode: "without-implementation" }), false);
	assert.equal(isStateLedgerEvent({ ...base, stripped: ["src/impl.js"] }), false);
	assert.equal(isStateLedgerEvent({ ...base, mode: "other", stripped: ["src/impl.js"] }), false);
	assert.equal(isStateLedgerEvent({ ...base, mode: "without-implementation", stripped: [] }), false);
});
