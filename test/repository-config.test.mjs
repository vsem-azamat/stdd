import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

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
	for (const requiredPath of [
		"native/stdd-fs/**",
		".cargo/**",
		"Cargo.lock",
		"prebuilds/stdd-fs/**",
		"scripts/verify-native-prebuilds.mjs",
		".github/workflows/native-prebuilds.yml",
	]) {
		assert.ok(workflow.includes(requiredPath), requiredPath);
	}
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
	const publish = release.indexOf("npm publish");
	assert.ok(verifier >= 0 && pack > verifier && checkPack > pack);
	assert.ok(tests > checkPack && publish > tests);
	assert.doesNotMatch(release, /cargo build|cargo test/);
});
