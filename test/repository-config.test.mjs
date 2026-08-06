import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INSTALL_LIFECYCLE, INSTALLABLE_FIELDS } from "./helpers/published-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

test("the privacy statement is reachable and the manifests keep its claim true", () => {
	// A directory submission cites this file by URL, so it has to stay at the
	// repository root under that exact name. Of the claims it makes, the one
	// about installs is the one that can rot without anyone noticing: the
	// statement would still read fine while the manifest beneath it had changed.
	// The published bundle's copy of this invariant lives with the rest of that
	// bundle's contract in plugin.test.mjs; the root manifest, which ships the
	// CLI, was covered nowhere despite CONTRIBUTING.md stating the rule.
	assert.match(read("PRIVACY.md"), /^# Privacy$/m);
	assert.match(read("README.md"), /\(PRIVACY\.md\)/, "the statement is linked, not orphaned");
	const root = JSON.parse(read("package.json"));
	for (const field of INSTALLABLE_FIELDS) {
		// npm accepts an array for the bundle fields and an object for the rest, so
		// compare the declared names rather than the container.
		const declared = root[field] ?? {};
		assert.deepEqual(
			Array.isArray(declared) ? declared : Object.keys(declared),
			[],
			`package.json declares ${field}, which the privacy statement denies`,
		);
	}
	// An install lifecycle script defeats the same sentence from the other side:
	// it can fetch anything while every dependency field stays empty.
	for (const script of INSTALL_LIFECYCLE) {
		assert.equal(
			root.scripts?.[script],
			undefined,
			`package.json runs a ${script} script, which the privacy statement denies`,
		);
	}
	assert.equal(
		fs.existsSync(path.join(ROOT, "binding.gyp")),
		false,
		"binding.gyp makes npm synthesize an install script the privacy statement denies",
	);
});

function jobBlock(workflow, jobName) {
	const lines = workflow.split("\n");
	const start = lines.findIndex((line) => line === `  ${jobName}:`);
	assert.notEqual(start, -1, `missing ${jobName} job`);
	let end = lines.findIndex((line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:$/.test(line));
	if (end === -1) end = lines.length;
	return lines.slice(start, end).join("\n");
}

function matrixEntries(workflow) {
	const matrix = workflow.match(/^\s{8}include:\n([\s\S]*?)(?=^\s{4}steps:)/m);
	assert.ok(matrix, "missing matrix include");
	const entries = [];
	let current;
	for (const line of matrix[1].split("\n")) {
		const start = line.match(/^\s{10}- target: (.+)$/);
		if (start) {
			current = { target: start[1] };
			entries.push(current);
			continue;
		}
		const field = line.match(/^\s{12}(runner|binary|artifact): (.+)$/);
		if (field && current) current[field[1]] = field[2];
	}
	return entries;
}

test("native prebuild workflow has the exact native runner and binary matrix", () => {
	const workflow = read(".github/workflows/native-prebuilds.yml");
	assert.match(
		read(".cargo/config.toml"),
		/target_env = "msvc"[\s\S]*linker = "rust-lld"[\s\S]*link-arg=\/Brepro/,
	);
	assert.deepEqual(matrixEntries(workflow), [
		{
			target: "linux-x64",
			runner: "ubuntu-24.04",
			binary: "native/stdd-fs/target/release/stdd-fs",
			artifact: "stdd-fs",
		},
		{
			target: "linux-arm64",
			runner: "ubuntu-24.04-arm",
			binary: "native/stdd-fs/target/release/stdd-fs",
			artifact: "stdd-fs",
		},
		{
			target: "darwin-x64",
			runner: "macos-15-large",
			binary: "native/stdd-fs/target/release/stdd-fs",
			artifact: "stdd-fs",
		},
		{
			target: "darwin-arm64",
			runner: "macos-15",
			binary: "native/stdd-fs/target/release/stdd-fs",
			artifact: "stdd-fs",
		},
		{
			target: "win32-x64",
			runner: "windows-2025",
			binary: "native/stdd-fs/target/release/stdd-fs.exe",
			artifact: "stdd-fs.exe",
		},
		{
			target: "win32-arm64",
			runner: "windows-11-arm",
			binary: "native/stdd-fs/target/release/stdd-fs.exe",
			artifact: "stdd-fs.exe",
		},
	]);
});

test("native prebuild workflow is bootstrap-triggered, bounded, least-privilege, and immutable", () => {
	const workflow = read(".github/workflows/native-prebuilds.yml");
	assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
	assert.match(workflow, /^\s{2}pull_request:\s*$/m);
	assert.match(workflow, /^\s{2}push:\n\s{4}branches: \[main\]/m);
	assert.doesNotMatch(
		workflow,
		/^\s+paths:\s*$/m,
		"every PR must exercise the six-platform helper-consumer scenarios",
	);
	assert.match(workflow, /^permissions:\n {2}contents: read$/m);
	assert.match(workflow, /^concurrency:\n {2}group: .+\n {2}cancel-in-progress: true$/m);
	assert.equal((workflow.match(/timeout-minutes:/g) ?? []).length, 2);

	const actionReferences = [...workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gm)].map(
		(match) => match[1],
	);
	assert.ok(actionReferences.length >= 6);
	for (const reference of actionReferences) {
		assert.match(reference, /^[^@]+@[0-9a-f]{40}$/, reference);
	}
});

test("every matrix entry runs locked release tests, a native probe, and uploads only its helper record", () => {
	const workflow = read(".github/workflows/native-prebuilds.yml");
	const build = jobBlock(workflow, "build");
	assert.equal((build.match(/cargo test --locked --release/g) ?? []).length, 1);
	assert.equal(matrixEntries(workflow).length, 6);
	assert.match(build, /RUSTUP_TOOLCHAIN: 1\.97\.0/);
	assert.match(build, /rustup toolchain install 1\.97\.0 --profile minimal --no-self-update/);
	assert.match(build, /--probe-root/);
	assert.match(build, /--record-binary/);
	assert.match(build, /stdd-fs-\$\{\{ matrix\.target \}\}/);
	assert.doesNotMatch(build, /qemu|cross-compile|target\/release\/deps|\.pdb/i);
});

test("assembly uploads the canonical bundle before the final committed-byte comparison", () => {
	const workflow = read(".github/workflows/native-prebuilds.yml");
	const assemble = jobBlock(workflow, "assemble");
	const verify = assemble.indexOf("Verify assembled prebuilds");
	const upload = assemble.indexOf("Upload stdd-fs-prebuilds bundle");
	const compare = assemble.indexOf("Compare assembled and committed prebuilds");
	assert.ok(verify >= 0 && upload > verify && compare > upload);
	assert.match(assemble, /rejects duplicate, missing, and extra build artifacts/);
	assert.match(assemble, /JSON\.stringify\(manifest, null, "\\t"\) \+ "\\n"/);
	assert.match(assemble, /diff -ru --no-dereference/);
	assert.equal(assemble.trimEnd().endsWith('prebuilds/stdd-fs"'), true);
});

test("normal CI and release carry named native verifier and package gates", () => {
	const ci = read(".github/workflows/ci.yml");
	const gate = jobBlock(ci, "native-prebuilds");
	assert.match(gate, /name: Native prebuild repository gate/);
	assert.match(gate, /node scripts\/verify-native-prebuilds\.mjs --smoke-current/);
	assert.match(gate, /node --test test\/native-packaging\.test\.mjs/);

	const release = read(".github/workflows/release.yml");
	const verifier = release.indexOf("node scripts/verify-native-prebuilds.mjs --smoke-current");
	const pack = release.indexOf("npm pack --dry-run --ignore-scripts --json");
	const checkPack = release.indexOf("--check-pack");
	const tests = release.indexOf("npm test");
	const publish = release.indexOf("scripts/publish-package.mjs");
	assert.ok(verifier >= 0 && pack > verifier && checkPack > pack);
	assert.ok(tests > checkPack && publish > tests);
	assert.doesNotMatch(release, /cargo build|cargo test/);
});

test("one tag publishes the CLI and the universal bundle before announcing the release", () => {
	const release = read(".github/workflows/release.yml");
	const cli = release.indexOf("node scripts/publish-package.mjs .\n");
	const bundle = release.indexOf("node scripts/publish-package.mjs ./plugins/stdd\n");
	const announcement = release.indexOf("gh release create");
	assert.ok(cli >= 0, "the tag publishes @stdd/cli");
	assert.ok(bundle > cli, "the same tag publishes the @stdd/plugin bundle");
	assert.ok(announcement > bundle, "the release is announced only once both packages exist");
	assert.doesNotMatch(
		release,
		/npm publish/,
		"both packages publish through the rerunnable publisher, never a bare npm publish",
	);
});

/**
 * A fake `npm` on PATH: it records every call and answers `npm view` with the
 * given registry outcome. The publisher's whole job is deciding between those
 * outcomes, so the decision is what the tests exercise.
 */
function fakeNpm(directory, { viewStatus, viewStdout, refusal = null }) {
	const bin = path.join(directory, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const log = path.join(directory, "npm-calls.log");
	const script = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
		'if [ "$1" = "view" ]; then',
		`  printf '%s\\n' ${JSON.stringify(viewStdout)}`,
		`  exit ${viewStatus}`,
		"fi",
	];
	if (refusal === null) {
		script.push("exit 0");
	} else {
		// Real npm writes its credential diagnosis to stderr and only at the level
		// that asks for it, so the stub does the same: a publish that dropped the
		// level is answered with silence, and a publisher that swallowed the
		// child's streams has nothing to show for the line that was written.
		script.push(
			'case "$*" in',
			`  *--loglevel*verbose*) printf '%s\\n' ${JSON.stringify(refusal)} >&2 ;;`,
			"esac",
			"exit 1",
		);
	}
	fs.writeFileSync(path.join(bin, "npm"), script.join("\n"), { mode: 0o755 });
	return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : []) };
}

function publishFixture(name, version) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-publish-"));
	const target = path.join(directory, "package");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, version }));
	return { directory, target };
}

test("a rerun after a partial release leaves the version the registry already carries", {
	skip: process.platform === "win32" ? "needs a POSIX shell stub" : false,
}, () => {
	const { directory, target } = publishFixture("@stdd/cli", "1.2.3");
	const npm = fakeNpm(directory, { viewStatus: 0, viewStdout: "1.2.3" });
	const run = spawnSync("node", [path.join(ROOT, "scripts/publish-package.mjs"), target], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${npm.bin}${path.delimiter}${process.env.PATH}` },
	});
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /@stdd\/cli@1\.2\.3/);
	assert.deepEqual(
		npm.calls().filter(Boolean),
		["view @stdd/cli@1.2.3 version"],
		"an immutable version already on the registry is never republished",
	);
});

test("a version the registry does not carry is published from its own directory", {
	skip: process.platform === "win32" ? "needs a POSIX shell stub" : false,
}, () => {
	const { directory, target } = publishFixture("@stdd/plugin", "1.2.3");
	const npm = fakeNpm(directory, { viewStatus: 1, viewStdout: "" });
	const run = spawnSync("node", [path.join(ROOT, "scripts/publish-package.mjs"), target], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${npm.bin}${path.delimiter}${process.env.PATH}` },
	});
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(npm.calls().filter(Boolean), [
		"view @stdd/plugin@1.2.3 version",
		`publish --access public --loglevel verbose ${target}`,
	]);
});

test("a refused publish carries the reason npm reports only at verbose", {
	skip: process.platform === "win32" ? "needs a POSIX shell stub" : false,
}, () => {
	// npm resolves trusted-publishing credentials in a helper that never throws.
	// A rejected token exchange returns no credential and reports the registry's
	// own explanation at `verbose`; npm then publishes with whatever the runner's
	// `.npmrc` holds and the registry answers `404 ... could not be found or you
	// do not have permission`, which names the package rather than the refusal.
	// What has to hold is that the explanation reaches the release log, and that
	// needs both the level producing it and streams that carry it — so this
	// asserts the line, not the argument that requests it.
	const { directory, target } = publishFixture("@stdd/plugin", "1.2.3");
	const refusal = "npm verbose oidc Failed token exchange request with body message: no match";
	const npm = fakeNpm(directory, { viewStatus: 1, viewStdout: "", refusal });
	const run = spawnSync("node", [path.join(ROOT, "scripts/publish-package.mjs"), target], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${npm.bin}${path.delimiter}${process.env.PATH}` },
	});
	assert.equal(run.status, 1, "a refused publish still fails the release step");
	assert.match(run.stderr, /oidc Failed token exchange request with body message: no match/);
});
