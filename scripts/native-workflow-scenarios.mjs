#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentNativeTarget } from "./verify-native-prebuilds.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(args, name) {
	const index = args.indexOf(name);
	if (index < 0 || index === args.length - 1) throw new Error(`${name} requires a value`);
	return args[index + 1];
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		input: options.input,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status ?? result.error?.code}): ${result.stderr || result.stdout}`,
		);
	}
	if (result.stderr) process.stderr.write(result.stderr);
	return result.stdout;
}

function preparePackageRoot(helper, target, temporaryRoot) {
	const packageRoot = path.join(temporaryRoot, "package");
	fs.cpSync(ROOT, packageRoot, {
		recursive: true,
		filter: (source) => {
			const relative = path.relative(ROOT, source);
			return ![".git", "node_modules"].some(
				(excluded) => relative === excluded || relative.startsWith(`${excluded}${path.sep}`),
			);
		},
	});
	const manifestPath = path.join(packageRoot, "prebuilds", "stdd-fs", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const artifact = manifest.artifacts.find((entry) => entry.target === target);
	if (!artifact) throw new Error(`committed manifest has no ${target} entry`);
	const destination = path.join(packageRoot, "prebuilds", "stdd-fs", ...artifact.path.split("/"));
	fs.copyFileSync(helper, destination);
	if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
	const bytes = fs.readFileSync(destination);
	artifact.size = bytes.length;
	artifact.sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return packageRoot;
}

function git(cwd, ...args) {
	return run("git", args, { cwd });
}

function ledger(fixture) {
	return fs
		.readFileSync(path.join(fixture, ".stdd", "ledger.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function main(args) {
	const helper = path.resolve(option(args, "--helper"));
	const target = option(args, "--target");
	if (target !== currentNativeTarget()) {
		throw new Error(`scenario target ${target} does not match runner ${currentNativeTarget()}`);
	}
	// macOS exposes /var as a symlink to /private/var, while Windows' generic
	// temp path may use an 8.3 alias under a non-traversable profile ancestor.
	// Native runners provide a physical, helper-admissible RUNNER_TEMP.
	const tempBase = process.env.RUNNER_TEMP || os.tmpdir();
	const temporaryRoot = fs.realpathSync.native(
		fs.mkdtempSync(path.join(tempBase, "stdd-native-workflows-")),
	);
	try {
		const packageRoot = preparePackageRoot(helper, target, temporaryRoot);
		const cli = path.join(packageRoot, "cli", "stdd.mjs");
		const env = {
			...process.env,
			STDD_NATIVE_FS_PACKAGE_ROOT: packageRoot,
			STDD_NATIVE_WORKFLOW_SCENARIO: "1",
		};
		const fixture = path.join(temporaryRoot, "fixture");
		fs.mkdirSync(fixture);
		fs.writeFileSync(path.join(fixture, "README.md"), "# Native workflow fixture\n");
		git(fixture, "init", "-q", "-b", "main");
		git(fixture, "config", "user.name", "STDD Native CI");
		git(fixture, "config", "user.email", "native-ci@example.test");
		git(fixture, "add", ".");
		git(fixture, "commit", "-qm", "fixture");
		const stdd = (...commandArgs) => run(process.execPath, [cli, ...commandArgs], { cwd: fixture, env });

		// init / configure
		stdd("init", fixture, "--tools", "codex", "--capabilities", "subagents");
		const configPath = path.join(fixture, ".stdd", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.baseRef = "HEAD";
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
		stdd("configure", fixture, "--review-via", "subagent");
		const configured = JSON.parse(fs.readFileSync(configPath, "utf8"));
		assert.equal(configured.review.via, "subagent");
		assert.equal(configured.capabilities.subagents, true);
		assert.deepEqual(
			fs.readFileSync(path.join(fixture, ".stdd", "method.md")),
			fs.readFileSync(path.join(packageRoot, "method", "README.md")),
		);
		assert.match(fs.readFileSync(path.join(fixture, "AGENTS.md"), "utf8"), /STDD/u);
		fs.symlinkSync("README.md", path.join(fixture, "README.link"), "file");
		git(fixture, "add", ".");
		git(fixture, "commit", "-qm", "initialize stdd");
		if (process.platform === "win32") {
			const freshCheckout = path.join(temporaryRoot, "fresh-checkout");
			run("git", ["clone", "-q", fixture, freshCheckout], { cwd: temporaryRoot, env });
			stdd("init", freshCheckout, "--tools", "codex", "--capabilities", "subagents");
		}

		// task reset
		stdd("task", "start", "native workflow");
		stdd("task", "reset", "native workflow reset");
		let events = ledger(fixture);
		const starts = events.filter((event) => event.event === "task-start");
		assert.equal(starts.length, 2);
		assert.notEqual(starts[0].id, starts[1].id);
		assert.equal(starts[1].name, "native workflow reset");
		stdd("docs", "checked", "method/README.md", "--reason", "portable contract already applies");

		// worker create / worker collect
		const worker = path.join(temporaryRoot, "worker");
		stdd("worker", "create", worker, "--allowed", "README.md", "--allowed", "README.link");
		assert.equal(fs.readlinkSync(path.join(worker, "README.link")), "README.md");
		fs.appendFileSync(path.join(worker, "README.md"), "collected through the native helper\n");
		stdd("worker", "collect", worker);
		assert.match(fs.readFileSync(path.join(fixture, "README.md"), "utf8"), /collected through/u);
		assert.equal(fs.existsSync(path.join(worker, ".git")), false);

		// review --result / review --cleanup
		fs.writeFileSync(
			path.join(fixture, ".stdd", "plan.md"),
			"# Native workflow plan\n\n- [ ] Independent review [review:]\n",
		);
		const dispatch = stdd("review", "--via", "subagent");
		const briefPath = dispatch.match(/brief written to (.+)\s*$/m)?.[1];
		if (!briefPath) throw new Error("subagent review did not report its private brief path");
		const resultPath = path.join(temporaryRoot, "review-result.json");
		fs.writeFileSync(resultPath, '{"summary":"native workflow approved","findings":[]}\n');
		stdd("review", "--result", resultPath);
		events = ledger(fixture);
		assert.ok(
			events.some((event) => event.event === "review" && event.summary === "native workflow approved"),
		);
		assert.equal(fs.existsSync(briefPath), false, "settled review brief must leave its dispatch path");
		fs.appendFileSync(path.join(fixture, "README.md"), "cleanup request\n");
		const cleanupDispatch = stdd("review", "--via", "subagent");
		const cleanupBrief = cleanupDispatch.match(/brief written to (.+)\s*$/m)?.[1];
		if (!cleanupBrief) throw new Error("cleanup review did not report its private brief path");
		stdd("review", "--cleanup");
		events = ledger(fixture);
		assert.ok(events.some((event) => event.event === "review-cancelled"));
		assert.equal(
			fs.existsSync(cleanupBrief),
			false,
			"cancelled review brief must leave its dispatch path",
		);

		// plugin build using the same staged helper package.
		run(process.execPath, [path.join(packageRoot, "scripts", "build-plugin.mjs")], {
			cwd: packageRoot,
			env,
		});
		for (const relative of ["cli/stdd.mjs", "sdk/native-fs.mjs", "prebuilds/stdd-fs/manifest.json"]) {
			assert.deepEqual(
				fs.readFileSync(path.join(packageRoot, "plugins", "stdd", "runtime", relative)),
				fs.readFileSync(path.join(packageRoot, relative)),
			);
		}
		assert.equal(
			fs.existsSync(
				path.join(
					packageRoot,
					"plugins",
					"stdd",
					"runtime",
					"sdk",
					["held", "publication.mjs"].join("-"),
				),
			),
			false,
		);
		process.stdout.write(`verified ${target} native command workflows\n`);
	} finally {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

try {
	main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
}
