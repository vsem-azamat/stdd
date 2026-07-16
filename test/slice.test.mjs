import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseLedger } from "../cli/lib.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-slice-test-"));
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

/** Committed repo on `feature`: docs/domain/pricing.md + src/impl.js tracked. */
async function tmpGitRepo() {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are net.\n");
	fs.writeFileSync(path.join(dir, "src", "impl.js"), "export {};\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	return { dir, git };
}

function readLedger(dir) {
	return parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
}

// --- stdd slice new ---

test("slice new records scope globs and a checkout baseline", async () => {
	const { dir, git } = await tmpGitRepo();
	// pre-existing dirt: the baseline must capture it with a content hash
	fs.writeFileSync(path.join(dir, "src", "impl.js"), "export const dirty = 1;\n");
	const res = await run(["slice", "new", "--frozen", "docs/**", "--allowed", "src/**,test/**"], {
		cwd: dir,
	});
	assert.equal(res.code, 0);
	const [event] = readLedger(dir);
	assert.equal(event.event, "scope");
	assert.deepEqual(event.frozenPaths, ["docs/**"]);
	assert.deepEqual(event.allowedPaths, ["src/**", "test/**"]);
	assert.equal(event.baseline.head, (await git("rev-parse", "HEAD")).stdout.trim());
	assert.match(event.baseline.dirty["src/impl.js"], /^sha256:/);
});

test("slice new requires --frozen or --allowed", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["slice", "new"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /--frozen|--allowed/);
});

test("slice rejects an unknown subcommand", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["slice", "close"], { cwd: dir });
	assert.equal(res.code, 1);
});

// --- stdd scope ---

test("scope without a declared slice fails with the fix", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /stdd slice new/);
});

test("scope passes when only allowed paths changed", async () => {
	const { dir } = await tmpGitRepo();
	await run(["slice", "new", "--frozen", "docs/**", "--allowed", "src/**"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "src", "impl.js"), "export const changed = 1;\n");
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /OK/);
});

test("scope fails on a working-tree change to a frozen path", async () => {
	const { dir } = await tmpGitRepo();
	await run(["slice", "new", "--frozen", "docs/**"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /docs\/domain\/pricing\.md/);
	assert.match(res.stderr, /frozen/);
});

test("scope fails on a committed change to a frozen path", async () => {
	const { dir, git } = await tmpGitRepo();
	await run(["slice", "new", "--frozen", "docs/**"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	await git("add", ".");
	await git("commit", "-qm", "sneaky docs change");
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /docs\/domain\/pricing\.md/);
});

test("scope fails on a change outside the allowed paths", async () => {
	const { dir } = await tmpGitRepo();
	await run(["slice", "new", "--allowed", "src/**"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "rogue.txt"), "out of scope\n");
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /rogue\.txt/);
	assert.match(res.stderr, /allowed/);
});

test("inherited dirt is reported separately and never blamed", async () => {
	const { dir } = await tmpGitRepo();
	// docs file already dirty BEFORE the slice starts — frozen or not, the
	// slice did not introduce it
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	await run(["slice", "new", "--frozen", "docs/**"], { cwd: dir });
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /inherited/i);
	assert.match(res.stdout, /docs\/domain\/pricing\.md/);
});

test("editing an inherited-dirty frozen file is a violation", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross.\n");
	await run(["slice", "new", "--frozen", "docs/**"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "docs", "domain", "pricing.md"), "Prices are gross + VAT.\n");
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /docs\/domain\/pricing\.md/);
});

test("a new untracked file under a frozen glob is a violation", async () => {
	const { dir } = await tmpGitRepo();
	await run(["slice", "new", "--frozen", "docs/**"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "docs", "domain", "new.md"), "Sneaky new doc.\n");
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /docs\/domain\/new\.md/);
});

test("scope uses the latest scope event on the branch", async () => {
	const { dir } = await tmpGitRepo();
	await run(["slice", "new", "--frozen", "src/**"], { cwd: dir });
	await run(["slice", "new", "--frozen", "docs/**", "--allowed", "src/**"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "src", "impl.js"), "export const v2 = 1;\n");
	const res = await run(["scope"], { cwd: dir });
	assert.equal(res.code, 0, res.stderr);
});

// --- init installs the playbook ---

test("init installs the delegate-slice playbook as a skill and lists it for codex", async () => {
	const dir = tmpDir();
	const res = await run(["init", dir, "--tools", "claude,codex"]);
	assert.equal(res.code, 0);
	assert.ok(fs.existsSync(path.join(dir, ".stdd", "playbooks", "delegate-slice.md")));
	const skill = fs.readFileSync(
		path.join(dir, ".claude", "skills", "stdd-delegate-slice", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /stdd slice new/);
	assert.match(
		fs.readFileSync(path.join(dir, ".stdd", "AGENTS-snippet.md"), "utf8"),
		/delegate-slice\.md/,
	);
});
