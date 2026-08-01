import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	currentNativeTarget,
	NATIVE_PREBUILD_TARGETS,
	smokeCurrentPrebuild,
	verifyNativePrebuilds,
} from "../scripts/verify-native-prebuilds.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function binaryBytes(target) {
	const bytes = Buffer.alloc(256, 0);
	if (target.startsWith("linux-")) {
		bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
		bytes.writeUInt16LE(target.endsWith("-x64") ? 62 : 183, 18);
	} else if (target.startsWith("darwin-")) {
		bytes.set([0xcf, 0xfa, 0xed, 0xfe]);
		bytes.writeInt32LE(target.endsWith("-x64") ? 0x01000007 : 0x0100000c, 4);
	} else {
		bytes.set([0x4d, 0x5a]);
		bytes.writeUInt32LE(0x80, 0x3c);
		bytes.set([0x50, 0x45, 0, 0], 0x80);
		bytes.writeUInt16LE(target.endsWith("-x64") ? 0x8664 : 0xaa64, 0x84);
	}
	return bytes;
}

function artifactEntry(target, bytes) {
	const executable = target.startsWith("win32-") ? "stdd-fs.exe" : "stdd-fs";
	return {
		target,
		protocol: 1,
		path: `${target}/${executable}`,
		size: bytes.length,
		sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	};
}

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-native-packaging-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const prebuilds = path.join(root, "prebuilds", "stdd-fs");
	fs.mkdirSync(prebuilds, { recursive: true });
	const artifacts = [];
	for (const target of NATIVE_PREBUILD_TARGETS) {
		const bytes = binaryBytes(target);
		const entry = artifactEntry(target, bytes);
		const executable = path.join(prebuilds, ...entry.path.split("/"));
		fs.mkdirSync(path.dirname(executable), { recursive: true });
		fs.writeFileSync(executable, bytes, { mode: target.startsWith("win32-") ? 0o644 : 0o755 });
		artifacts.push(entry);
	}
	const manifestPath = path.join(prebuilds, "manifest.json");
	fs.writeFileSync(manifestPath, `${JSON.stringify({ schema: 1, artifacts }, null, "\t")}\n`);
	return { root, prebuilds, manifestPath };
}

test("verifier accepts only the canonical exact-six package tree", (t) => {
	const pkg = fixture(t);
	const result = verifyNativePrebuilds(pkg.root);
	assert.deepEqual(
		result.artifacts.map(({ target }) => target),
		NATIVE_PREBUILD_TARGETS,
	);
	assert.equal(result.schema, 1);
});

test("every native runner exercises command workflows with its built helper before upload", () => {
	const workflow = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "native-prebuilds.yml"),
		"utf8",
	);
	const scenario = fs.readFileSync(path.join(ROOT, "scripts", "native-workflow-scenarios.mjs"), "utf8");
	const invocations = [...workflow.matchAll(/node scripts\/native-workflow-scenarios\.mjs/g)].map(
		(match) => match.index,
	);
	assert.equal(invocations.length, 2);
	assert.ok(invocations.every((index) => index < workflow.indexOf("Upload Unix helper artifact")));
	for (const invocation of [
		/stdd\("init", fixture,/,
		/stdd\("configure", fixture,/,
		/stdd\("task", "reset",/,
		/stdd\("worker", "create", worker,/,
		/stdd\("worker", "collect", worker\)/,
		/stdd\("review", "--result", resultPath\)/,
		/stdd\("review", "--cleanup"\)/,
		/\[path\.join\(packageRoot, "scripts", "build-plugin\.mjs"\)\]/,
	]) {
		assert.match(scenario, invocation);
	}
	for (const semanticCheck of [
		/configured\.review\.via/,
		/starts\[0\]\.id/,
		/collected through/,
		/event\.event === "review"/,
		/event\.event === "review-cancelled"/,
		/runtime", relative/,
	]) {
		assert.match(scenario, semanticCheck);
	}
	assert.match(scenario, /STDD_NATIVE_FS_PACKAGE_ROOT/);
	assert.doesNotMatch(scenario, /execSync|shell:\s*true|https?:\/\//);
	assert.match(
		workflow,
		/diff -ru --no-dereference "assembled\/prebuilds\/stdd-fs" "prebuilds\/stdd-fs"/,
	);
});

test("verifier rejects manifest, filesystem, integrity, mode, and executable-shape drift", async (t) => {
	const scenarios = [
		["missing", (pkg) => fs.rmSync(path.join(pkg.prebuilds, "linux-x64", "stdd-fs"))],
		["extra", (pkg) => fs.writeFileSync(path.join(pkg.prebuilds, "extra"), "")],
		[
			"order",
			(pkg) => {
				const manifest = JSON.parse(fs.readFileSync(pkg.manifestPath, "utf8"));
				[manifest.artifacts[0], manifest.artifacts[1]] = [manifest.artifacts[1], manifest.artifacts[0]];
				fs.writeFileSync(pkg.manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
			},
		],
		[
			"hash",
			(pkg) => {
				const manifest = JSON.parse(fs.readFileSync(pkg.manifestPath, "utf8"));
				manifest.artifacts[0].sha256 = `sha256:${"0".repeat(64)}`;
				fs.writeFileSync(pkg.manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
			},
		],
		[
			"missing-executable-mode",
			(pkg) => fs.chmodSync(path.join(pkg.prebuilds, "linux-x64", "stdd-fs"), 0o644),
		],
		[
			"noncanonical-unix-mode",
			(pkg) => fs.chmodSync(path.join(pkg.prebuilds, "linux-x64", "stdd-fs"), 0o700),
		],
		[
			"executable-windows-mode",
			(pkg) => fs.chmodSync(path.join(pkg.prebuilds, "win32-x64", "stdd-fs.exe"), 0o755),
		],
		[
			"shape",
			(pkg) => {
				const executable = path.join(pkg.prebuilds, "win32-x64", "stdd-fs.exe");
				const bytes = fs.readFileSync(executable);
				bytes[0] = 0;
				fs.writeFileSync(executable, bytes);
			},
		],
		[
			"symlink",
			(pkg) => {
				const executable = path.join(pkg.prebuilds, "darwin-x64", "stdd-fs");
				fs.rmSync(executable);
				fs.symlinkSync(path.join(pkg.prebuilds, "linux-x64", "stdd-fs"), executable);
			},
		],
	];
	for (const [name, alter] of scenarios) {
		await t.test(name, (t) => {
			const pkg = fixture(t);
			alter(pkg);
			assert.throws(() => verifyNativePrebuilds(pkg.root), /native prebuild/i);
		});
	}
});

test("npm dry-run package contains every currently declared helper path", (t) => {
	const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-native-npm-cache-"));
	const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, npm_config_cache: npmCache },
	});
	fs.rmSync(npmCache, { recursive: true, force: true });
	if (packed.error?.code === "EPERM") {
		t.skip("sandbox blocks child-process npm; release and direct checks run the same pack gate");
		return;
	}
	assert.equal(packed.status, 0, packed.stderr);
	const report = JSON.parse(packed.stdout);
	const packageReport = Array.isArray(report) ? report[0] : Object.values(report)[0];
	const packedPaths = new Set(packageReport.files.map(({ path: relative }) => relative));
	const manifest = JSON.parse(
		fs.readFileSync(path.join(ROOT, "prebuilds", "stdd-fs", "manifest.json"), "utf8"),
	);
	assert.ok(packedPaths.has("prebuilds/stdd-fs/manifest.json"));
	assert.ok(packedPaths.has("sdk/file-observation.mjs"));
	assert.equal(packedPaths.has("sdk/held-publication.mjs"), false);
	for (const artifact of manifest.artifacts) {
		assert.ok(packedPaths.has(`prebuilds/stdd-fs/${artifact.path}`), artifact.path);
	}
});

test("current committed native helper answers the exact protocol-v1 hello", async (t) => {
	const target = currentNativeTarget();
	if (!target) {
		t.skip("host platform is outside the six supported native targets");
		return;
	}
	const manifest = JSON.parse(
		fs.readFileSync(path.join(ROOT, "prebuilds", "stdd-fs", "manifest.json"), "utf8"),
	);
	if (!manifest.artifacts.some((artifact) => artifact.target === target)) {
		t.skip(`${target} is not committed during bootstrap`);
		return;
	}
	const hello = await smokeCurrentPrebuild(ROOT);
	assert.equal(hello.result.protocol, 1);
	assert.equal(hello.result.helper, "stdd-fs");
});
