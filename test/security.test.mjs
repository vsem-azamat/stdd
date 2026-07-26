import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256 } from "../cli/lib.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-security-"));
}

function snapshotTreeBytes(root) {
	const snapshot = {};
	const walk = (dir, relative = "") => {
		for (const entry of fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name))) {
			const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				snapshot[`${entryRelative}/`] = null;
				walk(entryPath, entryRelative);
			} else if (entry.isSymbolicLink()) {
				snapshot[entryRelative] = `symlink:${fs.readlinkSync(entryPath)}`;
			} else {
				snapshot[entryRelative] = fs.readFileSync(entryPath).toString("base64");
			}
		}
	};
	walk(root);
	return snapshot;
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

test("init rejects a local playbook name that escapes the skills directory", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	fs.mkdirSync(path.join(dir, ".stdd", "playbooks", "local"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "playbooks", "local", "escape.md"),
		"---\nname: ../../../escaped\ndescription: unsafe\n---\nbody\n",
	);
	const res = await run(["init", dir, "--tools", "claude"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /playbook name|safe/i);
	assert.ok(!fs.existsSync(path.join(root, "escaped", "SKILL.md")));
});

test("init rejects unsafe manifest paths before writing or deleting anything", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	fs.mkdirSync(dir);
	assert.equal((await run(["init", dir, "--tools", "codex"])).code, 0);
	const victim = path.join(root, "victim.txt");
	fs.writeFileSync(victim, "keep me\n");
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.files["../victim.txt"] = sha256("keep me\n");
	fs.writeFileSync(manifestPath, JSON.stringify(manifest));
	const res = await run(["init", dir, "--tools", "codex"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /manifest.*unsafe|unsafe.*manifest/i);
	assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n");
});

test("init rejects forged manifest ownership before changing any target bytes", async () => {
	for (const forged of [
		"README.md",
		".stdd/config.json",
		".stdd/playbooks/local.md",
		".stdd/playbooks/local/deploy.md",
		".claude/skills/stdd-debugging/README.md",
		".claude/skills-near/stdd-debugging/SKILL.md",
		".github/workflows/stdd.yml.bak",
	]) {
		const root = tmpRoot();
		const dir = path.join(root, "repo");
		fs.mkdirSync(dir);
		const initialized = await run(["init", dir, "--tools", "claude"]);
		assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
		const target = path.join(dir, forged);
		if (!fs.existsSync(target)) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(
				target,
				forged === ".stdd/playbooks/local/deploy.md"
					? "---\nname: forged-local\ndescription: valid user-owned recipe\n---\nBody.\n"
					: `user-owned ${forged}\n`,
			);
		}
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		manifest.files[forged] = sha256(fs.readFileSync(target));
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		const before = snapshotTreeBytes(dir);

		const rejected = await run(["init", dir, "--tools", "claude"]);

		assert.equal(rejected.code, 1, `${forged}: ${rejected.stdout}${rejected.stderr}`);
		assert.match(rejected.stderr, /not a recognized STDD-generated output path/i, forged);
		assert.deepEqual(snapshotTreeBytes(dir), before, `${forged} must fail before every target write`);
	}
});

test("init refuses generated writes through a repository symlink", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	const outside = path.join(root, "outside");
	fs.mkdirSync(dir);
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(dir, ".claude"));
	const res = await run(["init", dir, "--tools", "claude"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /symlink.*unsafe|unsafe.*symlink/i);
	assert.deepEqual(fs.readdirSync(outside), []);
});

test("init refuses to compile a symlinked local playbook", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	const outside = path.join(root, "outside.md");
	fs.mkdirSync(path.join(dir, ".stdd", "playbooks", "local"), { recursive: true });
	fs.writeFileSync(outside, "---\nname: leaked\ndescription: must stay outside\n---\noutside secret\n");
	fs.symlinkSync(outside, path.join(dir, ".stdd", "playbooks", "local", "leaked.md"));
	const res = await run(["init", dir, "--tools", "claude"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /regular file|symlink.*unsafe/i);
	assert.ok(!fs.existsSync(path.join(dir, ".claude", "skills", "leaked", "SKILL.md")));
});

test("init rejects a malformed manifest before rewriting generated files", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	fs.mkdirSync(dir);
	assert.equal((await run(["init", dir, "--tools", "codex"])).code, 0);
	const methodPath = path.join(dir, ".stdd", "method.md");
	fs.writeFileSync(methodPath, "preserve this hand edit\n");
	fs.writeFileSync(path.join(dir, ".stdd", "manifest.json"), "{not json");
	const res = await run(["init", dir, "--tools", "codex"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /manifest\.json is not valid JSON/i);
	assert.equal(fs.readFileSync(methodPath, "utf8"), "preserve this hand edit\n");
});

test("init rejects an invalid manifest hash before cleanup or republishing", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	fs.mkdirSync(dir);
	assert.equal((await run(["init", dir, "--tools", "codex"])).code, 0);
	const manifestPath = path.join(dir, ".stdd", "manifest.json");
	const methodPath = path.join(dir, ".stdd", "method.md");
	const codexSkillPath = path.join(dir, ".agents", "skills", "stdd-planning", "SKILL.md");
	const claudeSkillPath = path.join(dir, ".claude", "skills", "stdd-planning", "SKILL.md");
	const methodBefore = fs.readFileSync(methodPath, "utf8");
	const codexSkillBefore = fs.readFileSync(codexSkillPath, "utf8");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.files[".stdd/method.md"] = null;
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	const manifestBefore = fs.readFileSync(manifestPath, "utf8");

	const result = await run(["init", dir, "--tools", "claude"]);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /manifest\.json.*sha256/i);
	assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
	assert.equal(fs.readFileSync(methodPath, "utf8"), methodBefore);
	assert.equal(fs.readFileSync(codexSkillPath, "utf8"), codexSkillBefore);
	assert.ok(!fs.existsSync(claudeSkillPath));
});

test("init and configure preserve non-regular former outputs during cleanup", async () => {
	for (const [name, prepare, command] of [
		[
			"init",
			async (dir) => {
				await run(["init", dir, "--tools", "codex"]);
				return path.join(dir, ".agents", "skills", "stdd-worktrees", "SKILL.md");
			},
			["init", "--tools", "claude"],
		],
		[
			"configure",
			async (dir) => {
				await run(["init", dir, "--tools", "claude"]);
				return path.join(dir, ".claude", "skills", "stdd-worktrees", "SKILL.md");
			},
			["configure", "--capabilities", "subagents,crossCli", "--review-via", "codex"],
		],
	]) {
		const root = tmpRoot();
		const dir = path.join(root, "repo");
		fs.mkdirSync(dir);
		const target = await prepare(dir);
		const relative = path.relative(dir, target).split(path.sep).join("/");
		const manifestPath = path.join(dir, ".stdd", "manifest.json");
		const expectedHash = JSON.parse(fs.readFileSync(manifestPath, "utf8")).files[relative];
		fs.rmSync(target);
		fs.mkdirSync(target);

		const result = await run([command[0], dir, ...command.slice(1)]);
		assert.equal(result.code, 0, `${name}: ${result.stdout}${result.stderr}`);
		assert.match(result.stderr, /preserved.*cannot be safely inspected|preserved.*regular file/i, name);
		assert.ok(fs.lstatSync(target).isDirectory(), `${name}: directory must not be deleted`);
		const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		assert.equal(after.files[relative], expectedHash, `${name}: unsafe output remains tracked`);
	}
});

test("doctor rejects a readiness path that escapes the repository", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ readiness: { required: [{ path: "../outside", hint: "unsafe" }] } }),
	);
	const res = await run(["doctor", dir, "--readiness"]);
	assert.equal(res.code, 1);
	assert.match(res.stderr, /readiness path.*safe repository-relative path/i);
});

test("a base ref cannot be interpreted as a git output option", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	fs.mkdirSync(dir);
	await exec("git", ["-C", dir, "init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(dir, "README.md"), "base\n");
	await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
	await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
	const victimStem = path.join(root, "git-output");
	const res = await run(["evidence", `--base=--output=${victimStem}`], { cwd: dir });
	assert.equal(res.code, 1);
	assert.ok(!fs.existsSync(`${victimStem}...HEAD`));
});

test("recorders refuse ledger and plan symlinks outside the repository", async () => {
	const root = tmpRoot();
	const dir = path.join(root, "repo");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	await exec("git", ["-C", dir, "init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(dir, "README.md"), "base\n");
	await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
	await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);

	const ledgerVictim = path.join(root, "ledger-victim");
	fs.writeFileSync(ledgerVictim, "keep ledger\n");
	fs.symlinkSync(ledgerVictim, path.join(dir, ".stdd", "ledger.jsonl"));
	const note = await run(["note", "must not escape"], { cwd: dir });
	assert.equal(note.code, 1);
	assert.match(note.stderr, /ledger path.*symlink/i);
	assert.equal(fs.readFileSync(ledgerVictim, "utf8"), "keep ledger\n");

	const planVictim = path.join(root, "plan-victim");
	fs.writeFileSync(planVictim, "keep plan\n");
	fs.symlinkSync(planVictim, path.join(dir, ".stdd", "plan.md"));
	const deferred = await run(["defer", "must not escape"], { cwd: dir });
	assert.equal(deferred.code, 1);
	assert.match(deferred.stderr, /plan path.*symlink/i);
	assert.equal(fs.readFileSync(planVictim, "utf8"), "keep plan\n");
});
