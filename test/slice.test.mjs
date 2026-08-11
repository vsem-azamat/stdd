import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseLedger } from "../cli/lib.mjs";
import { switchBranchWhenFileOpens, switchTaskWhenFileOpens } from "./helpers/file-open-race.mjs";
import { makeTempDir } from "./helpers/tmp.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

function tmpDir() {
	return makeTempDir("stdd-slice-test-");
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

test("slice new records nothing when the active task changes during its snapshot", async () => {
	const { dir } = await tmpGitRepo();
	const started = await run(["task", "start", "task A"], { cwd: dir });
	assert.equal(started.code, 0, started.stderr);
	const trigger = path.join(dir, "race-trigger.txt");
	fs.writeFileSync(trigger, "trigger\n");

	const res = await run(["slice", "new", "--allowed", "src/**"], {
		cwd: dir,
		env: switchTaskWhenFileOpens({ cli: CLI, dir, trigger }),
	});

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /active task changed/);
	const events = readLedger(dir);
	assert.equal(events.filter((event) => event.event === "scope").length, 0);
	const latestStart = events.filter((event) => event.event === "task-start").at(-1);
	assert.equal(latestStart.name, "task B");
});

test("slice new records nothing when the branch changes during its snapshot", async () => {
	const { dir } = await tmpGitRepo();
	const started = await run(["task", "start", "task A"], { cwd: dir });
	assert.equal(started.code, 0, started.stderr);
	const trigger = path.join(dir, "race-trigger.txt");
	fs.writeFileSync(trigger, "trigger\n");

	const res = await run(["slice", "new", "--allowed", "src/**"], {
		cwd: dir,
		env: switchBranchWhenFileOpens({ dir, trigger }),
	});

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /switched branches/);
	assert.equal(readLedger(dir).filter((event) => event.event === "scope").length, 0);
});

test("slice new requires --frozen or --allowed", async () => {
	const { dir } = await tmpGitRepo();
	const res = await run(["slice", "new"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /--frozen|--allowed/);
});

test("slice new rejects control, bidi, and invisible characters before recording scope", async () => {
	for (const [flag, glob] of [
		["--allowed", "src/**\nforged"],
		["--frozen", "docs/\u001b[31m**"],
		["--allowed", "src/\u202e**"],
		["--frozen", "docs/\u200b**"],
	]) {
		const { dir } = await tmpGitRepo();
		const res = await run(["slice", "new", flag, glob], { cwd: dir });
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, new RegExp(`${flag} glob must be a non-empty single printable line`));
		assert.ok(
			!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")),
			`${flag} ${JSON.stringify(glob)} must not reach durable task state`,
		);
	}
});

test("status fails closed on a hostile persisted scope glob without printing it", async () => {
	const { dir, git } = await tmpGitRepo();
	const branch = (await git("branch", "--show-current")).stdout.trim();
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
	fs.writeFileSync(
		ledgerPath,
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "scope",
			frozenPaths: [],
			allowedPaths: ["src/**\nforged status line"],
			baseline: { head: (await git("rev-parse", "HEAD")).stdout.trim(), dirty: {} },
			branch,
		})}\n`,
	);

	const res = await run(["status", "--local", "--json"], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const status = JSON.parse(res.stdout);
	assert.equal(status.state, "invalid");
	assert.equal(status.slice.declared, false);
	assert.ok(!res.stdout.includes("forged status line"));
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

test("scope exempts only the exact reset temp and keeps other .stdd changes visible", async () => {
	const { dir } = await tmpGitRepo();
	await run(["slice", "new", "--allowed", "src/**"], { cwd: dir });
	const exact = path.join(dir, ".stdd", `.ledger-reset-${"a".repeat(32)}.tmp`);
	fs.writeFileSync(exact, "exact private temp\n", { mode: 0o600 });
	const exactResult = await run(["scope"], { cwd: dir });
	assert.equal(exactResult.code, 0, exactResult.stdout + exactResult.stderr);
	fs.rmSync(exact);

	for (const name of [
		`.ledger-reset-${"a".repeat(31)}.tmp`,
		`.ledger-reset-${"a".repeat(33)}.tmp`,
		`.ledger-reset-${"A".repeat(32)}.tmp`,
		`.ledger-reset-${"g".repeat(32)}.tmp`,
		`.ledger-reset-${"a".repeat(32)}.tmp.extra`,
	]) {
		const candidate = path.join(dir, ".stdd", name);
		fs.writeFileSync(candidate, "near miss\n");
		const result = await run(["scope"], { cwd: dir });
		assert.equal(result.code, 1, `${name}: ${result.stdout}${result.stderr}`);
		assert.match(result.stderr, new RegExp(name.replaceAll(".", "\\.")), name);
		fs.rmSync(candidate);
	}

	fs.writeFileSync(path.join(dir, ".stdd", "config.json"), "{}\n");
	const configResult = await run(["scope"], { cwd: dir });
	assert.equal(configResult.code, 1, configResult.stdout + configResult.stderr);
	assert.match(configResult.stderr, /\.stdd\/config\.json/);
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

test("deleting a baseline-untracked frozen file is a slice-introduced violation", async () => {
	const { dir } = await tmpGitRepo();
	const inherited = path.join(dir, "docs", "domain", "draft.md");
	fs.writeFileSync(inherited, "untracked at baseline\n");
	await run(["slice", "new", "--frozen", "docs/**"], { cwd: dir });
	fs.rmSync(inherited);

	const res = await run(["scope"], { cwd: dir });

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /docs\/domain\/draft\.md.*frozen path modified/i);
});

test("deleting a baseline-modified tracked frozen file is a slice-introduced violation", async () => {
	const { dir } = await tmpGitRepo();
	const inherited = path.join(dir, "docs", "domain", "pricing.md");
	fs.writeFileSync(inherited, "modified at baseline\n");
	await run(["slice", "new", "--frozen", "docs/**"], { cwd: dir });
	fs.rmSync(inherited);

	const res = await run(["scope"], { cwd: dir });

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /docs\/domain\/pricing\.md.*frozen path modified/i);
});

test("deleting a baseline-dirty file inside allowed paths passes scope", async () => {
	const { dir } = await tmpGitRepo();
	const inherited = path.join(dir, "src", "draft.js");
	fs.writeFileSync(inherited, "untracked at baseline\n");
	await run(["slice", "new", "--allowed", "src/**"], { cwd: dir });
	fs.rmSync(inherited);

	const res = await run(["scope"], { cwd: dir });

	assert.equal(res.code, 0, res.stdout + res.stderr);
	assert.match(res.stdout, /1 introduced change/);
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
	assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "stdd-delegate-slice", "SKILL.md")));
});
