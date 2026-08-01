import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_PREBUILD_TARGETS = Object.freeze([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
]);

const TARGET_SET = new Set(NATIVE_PREBUILD_TARGETS);
const MANIFEST_KEYS = ["schema", "artifacts"];
const ARTIFACT_KEYS = ["target", "protocol", "path", "size", "sha256"];
const HELLO_RESULT_KEYS = ["protocol", "helper", "maxLineBytes", "maxChunkBytes"];
const PROBE_RESULT_KEYS = ["platform", "filesystem", "filesystemId", "primitives"];
const PRIMITIVE_KEYS = [
	"identity",
	"noFollow",
	"atomicRename",
	"noReplace",
	"fileFlush",
	"directoryFlush",
];
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_SMOKE_TIMEOUT_MS = 2_000;
const MODULE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");

function fail(message) {
	throw new Error(`native prebuild verification failed: ${message}`);
}

function exactKeys(value, expected) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	);
}

function orderedKeys(value, expected) {
	return exactKeys(value, expected) && expected.every((key, index) => Object.keys(value)[index] === key);
}

function expectedExecutable(target) {
	return target.startsWith("win32-") ? "stdd-fs.exe" : "stdd-fs";
}

export function expectedNativeArtifactPath(target) {
	if (!TARGET_SET.has(target)) fail(`unsupported target ${target}`);
	return `${target}/${expectedExecutable(target)}`;
}

function assertSafeInteger(value, subject) {
	if (!Number.isSafeInteger(value) || value < 1) fail(`${subject} must be a positive safe integer`);
}

function lstatRegularFile(filePath, subject) {
	let stat;
	try {
		stat = fs.lstatSync(filePath, { bigint: true });
	} catch (error) {
		fail(`${subject} cannot be inspected: ${error.message}`);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		fail(`${subject} must be a regular non-symlink file`);
	}
	return stat;
}

function readStableFile(filePath, subject, maximum = Number.MAX_SAFE_INTEGER) {
	const before = lstatRegularFile(filePath, subject);
	if (before.size > BigInt(maximum)) fail(`${subject} is oversized`);
	const bytes = fs.readFileSync(filePath);
	const after = lstatRegularFile(filePath, subject);
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		BigInt(bytes.length) !== after.size
	) {
		fail(`${subject} changed while being read`);
	}
	return { bytes, stat: after };
}

function assertDirectory(directoryPath, subject) {
	let stat;
	try {
		stat = fs.lstatSync(directoryPath);
	} catch (error) {
		fail(`${subject} cannot be inspected: ${error.message}`);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		fail(`${subject} must be a non-symlink directory`);
	}
}

function assertExactNames(directoryPath, expected, subject) {
	const actual = fs.readdirSync(directoryPath).sort();
	const sortedExpected = [...expected].sort();
	if (
		actual.length !== sortedExpected.length ||
		actual.some((entry, index) => entry !== sortedExpected[index])
	) {
		fail(
			`${subject} has missing or extra entries (expected ${sortedExpected.join(", ")}, found ${actual.join(", ")})`,
		);
	}
}

function assertExecutableShape(bytes, target) {
	if (target.startsWith("linux-")) {
		if (
			bytes.length < 20 ||
			!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
			bytes[4] !== 2 ||
			bytes[5] !== 1
		) {
			fail(`${target} helper is not a little-endian ELF64 executable`);
		}
		const expectedMachine = target.endsWith("-x64") ? 62 : 183;
		if (bytes.readUInt16LE(18) !== expectedMachine) {
			fail(`${target} helper has the wrong ELF machine`);
		}
		return;
	}
	if (target.startsWith("darwin-")) {
		if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
			fail(`${target} helper is not a little-endian Mach-O 64 executable`);
		}
		const expectedCpu = target.endsWith("-x64") ? 0x01000007 : 0x0100000c;
		if (bytes.readInt32LE(4) !== expectedCpu) {
			fail(`${target} helper has the wrong Mach-O CPU type`);
		}
		return;
	}
	if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
		fail(`${target} helper has no MZ header`);
	}
	const peOffset = bytes.readUInt32LE(0x3c);
	if (
		peOffset > bytes.length - 6 ||
		!bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
	) {
		fail(`${target} helper has no valid PE header`);
	}
	const expectedMachine = target.endsWith("-x64") ? 0x8664 : 0xaa64;
	if (bytes.readUInt16LE(peOffset + 4) !== expectedMachine) {
		fail(`${target} helper has the wrong PE machine`);
	}
}

function inspectBinary(binaryPath, target) {
	if (!TARGET_SET.has(target)) fail(`unsupported target ${target}`);
	const { bytes, stat } = readStableFile(binaryPath, `${target} helper`);
	if (process.platform !== "win32") {
		const expectedMode = target.startsWith("win32-") ? 0o644 : 0o755;
		if ((Number(stat.mode) & 0o777) !== expectedMode) {
			fail(`${target} helper mode is not canonical`);
		}
	}
	assertExecutableShape(bytes, target);
	return {
		bytes,
		size: bytes.length,
		sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	};
}

function readManifest(packageRoot) {
	const prebuildsRoot = path.join(packageRoot, "prebuilds", "stdd-fs");
	assertDirectory(prebuildsRoot, "native prebuild root");
	const manifestPath = path.join(prebuildsRoot, "manifest.json");
	const { bytes } = readStableFile(manifestPath, "native prebuild manifest", MAX_MANIFEST_BYTES);
	let manifest;
	try {
		manifest = JSON.parse(bytes.toString("utf8"));
	} catch {
		fail("manifest is not valid JSON");
	}
	if (
		!orderedKeys(manifest, MANIFEST_KEYS) ||
		manifest.schema !== 1 ||
		!Array.isArray(manifest.artifacts)
	) {
		fail("manifest must have exact schema-1 shape");
	}
	const canonical = `${JSON.stringify(manifest, null, "\t")}\n`;
	if (!bytes.equals(Buffer.from(canonical))) fail("manifest bytes are not canonical");
	return { manifest, prebuildsRoot };
}

function validateManifestEntries(manifest) {
	if (manifest.artifacts.length !== NATIVE_PREBUILD_TARGETS.length) {
		fail(`manifest must contain exactly ${NATIVE_PREBUILD_TARGETS.length} artifacts`);
	}
	const seen = new Set();
	for (const [index, artifact] of manifest.artifacts.entries()) {
		if (!orderedKeys(artifact, ARTIFACT_KEYS)) fail(`manifest artifact ${index} has invalid shape`);
		if (artifact.target !== NATIVE_PREBUILD_TARGETS[index]) {
			fail("manifest artifacts are not in canonical target order");
		}
		if (seen.has(artifact.target)) fail(`manifest repeats target ${artifact.target}`);
		seen.add(artifact.target);
		if (
			artifact.protocol !== 1 ||
			artifact.path !== expectedNativeArtifactPath(artifact.target) ||
			typeof artifact.sha256 !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(artifact.sha256)
		) {
			fail(`manifest entry for ${artifact.target} is invalid`);
		}
		assertSafeInteger(artifact.size, `${artifact.target} size`);
	}
	if (seen.size !== TARGET_SET.size || NATIVE_PREBUILD_TARGETS.some((target) => !seen.has(target))) {
		fail("manifest target set is incomplete");
	}
}

export function verifyNativePrebuilds(packageRoot = REPOSITORY_ROOT) {
	if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) {
		fail("package root must be an absolute path");
	}
	const { manifest, prebuildsRoot } = readManifest(packageRoot);
	validateManifestEntries(manifest);
	assertExactNames(prebuildsRoot, ["manifest.json", ...NATIVE_PREBUILD_TARGETS], "native prebuild root");
	for (const artifact of manifest.artifacts) {
		const targetRoot = path.join(prebuildsRoot, artifact.target);
		assertDirectory(targetRoot, `${artifact.target} directory`);
		assertExactNames(targetRoot, [expectedExecutable(artifact.target)], `${artifact.target} directory`);
		const binaryPath = path.join(prebuildsRoot, ...artifact.path.split("/"));
		const inspected = inspectBinary(binaryPath, artifact.target);
		if (inspected.size !== artifact.size) fail(`${artifact.target} size does not match manifest`);
		if (inspected.sha256 !== artifact.sha256) fail(`${artifact.target} hash does not match manifest`);
	}
	return Object.freeze({
		schema: manifest.schema,
		artifacts: Object.freeze(manifest.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
	});
}

export function currentNativeTarget(platform = process.platform, architecture = process.arch) {
	const target = `${platform}-${architecture}`;
	return TARGET_SET.has(target) ? target : null;
}

function validateSuccess(response, id) {
	if (
		!exactKeys(response, ["v", "id", "ok", "result"]) ||
		response.v !== 1 ||
		response.id !== id ||
		response.ok !== true
	) {
		fail(`helper returned an invalid ${id} envelope`);
	}
	return response;
}

function parseResponse(line, id) {
	let response;
	try {
		response = JSON.parse(line);
	} catch {
		fail(`helper returned invalid JSON for ${id}`);
	}
	return validateSuccess(response, id);
}

async function runProtocol(executablePath, requests, timeoutMs) {
	return await new Promise((resolve, reject) => {
		const child = spawn(executablePath, [], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timer;
		let forceKillTimer;

		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else resolve(result);
		};
		const terminate = () => {
			if (forceKillTimer) return;
			child.kill();
			forceKillTimer = setTimeout(() => {
				child.kill("SIGKILL");
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
				child.unref();
			}, 250);
		};
		const overflow = (stream) => {
			terminate();
			finish(new Error(`native prebuild verification failed: helper ${stream} exceeded limit`));
		};
		child.stdout.on("data", (chunk) => {
			if (settled) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) overflow("stdout");
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			if (settled) return;
			stderrBytes += chunk.length;
			if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) overflow("stderr");
			else stderr.push(chunk);
		});
		child.once("error", (error) => {
			finish(new Error(`native prebuild verification failed: helper could not start: ${error.message}`));
		});
		child.once("close", (code, signal) => {
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (settled) return;
			if (code !== 0 || signal) {
				finish(new Error(`native prebuild verification failed: helper exited with ${code ?? signal}`));
				return;
			}
			const stderrText = Buffer.concat(stderr).toString("utf8");
			if (stderrText !== "") {
				finish(new Error("native prebuild verification failed: helper wrote to stderr"));
				return;
			}
			const stdoutText = Buffer.concat(stdout).toString("utf8");
			if (!stdoutText.endsWith("\n")) {
				finish(
					new Error("native prebuild verification failed: helper response is not newline terminated"),
				);
				return;
			}
			const lines = stdoutText.slice(0, -1).split("\n");
			if (lines.length !== requests.length) {
				finish(
					new Error("native prebuild verification failed: helper returned extra or missing responses"),
				);
				return;
			}
			try {
				finish(
					null,
					lines.map((line, index) => parseResponse(line, requests[index].id)),
				);
			} catch (error) {
				finish(error);
			}
		});
		timer = setTimeout(() => {
			terminate();
			finish(new Error(`native prebuild verification failed: helper timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdin.on("error", () => {});
		child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
	});
}

function validateHello(response) {
	if (
		!exactKeys(response.result, HELLO_RESULT_KEYS) ||
		response.result.protocol !== 1 ||
		response.result.helper !== "stdd-fs" ||
		response.result.maxLineBytes !== 1_048_576 ||
		response.result.maxChunkBytes !== 65_536
	) {
		fail("helper returned an incompatible protocol-v1 hello");
	}
	return response;
}

function validateProbe(responses, target) {
	const opened = responses[1];
	if (
		!exactKeys(opened.result, ["cap", "observation"]) ||
		opened.result.cap !== "c1" ||
		opened.result.observation?.identity?.platform !== target.split("-")[0]
	) {
		fail("helper returned an invalid open-root response");
	}
	const probe = responses[2];
	if (
		!exactKeys(probe.result, PROBE_RESULT_KEYS) ||
		probe.result.platform !== target.split("-")[0] ||
		typeof probe.result.filesystem !== "string" ||
		probe.result.filesystem.length === 0 ||
		typeof probe.result.filesystemId !== "string" ||
		probe.result.filesystemId.length === 0 ||
		!exactKeys(probe.result.primitives, PRIMITIVE_KEYS) ||
		!PRIMITIVE_KEYS.every(
			(key) =>
				typeof probe.result.primitives[key] === "string" && probe.result.primitives[key].length > 0,
		)
	) {
		fail("helper returned an invalid filesystem probe");
	}
}

export async function smokeNativeBinary(
	executablePath,
	{ target, probeRoot, timeoutMs = DEFAULT_SMOKE_TIMEOUT_MS } = {},
) {
	if (!TARGET_SET.has(target)) fail(`unsupported target ${target}`);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		fail("smoke timeout is invalid");
	}
	if (!path.isAbsolute(executablePath)) fail("smoke executable path must be absolute");
	inspectBinary(executablePath, target);
	const requests = [{ v: 1, id: "hello", op: "hello" }];
	if (probeRoot !== undefined) {
		if (typeof probeRoot !== "string" || !path.isAbsolute(probeRoot)) {
			fail("probe root must be an absolute path");
		}
		assertDirectory(probeRoot, "probe root");
		requests.push(
			{ v: 1, id: "open-root", op: "open-root", path: probeRoot },
			{ v: 1, id: "probe", op: "probe", root: "c1" },
		);
	}
	const responses = await runProtocol(executablePath, requests, timeoutMs);
	validateHello(responses[0]);
	if (probeRoot !== undefined) validateProbe(responses, target);
	return responses[0];
}

export async function smokeCurrentPrebuild(packageRoot = REPOSITORY_ROOT) {
	const target = currentNativeTarget();
	if (!target) fail(`unsupported current host ${process.platform}-${process.arch}`);
	const { manifest, prebuildsRoot } = readManifest(packageRoot);
	const artifact = manifest.artifacts.find((entry) => entry?.target === target);
	if (!artifact) fail(`manifest has no current target ${target}`);
	if (
		!orderedKeys(artifact, ARTIFACT_KEYS) ||
		artifact.protocol !== 1 ||
		artifact.path !== expectedNativeArtifactPath(target)
	) {
		fail(`current target ${target} has an invalid manifest entry`);
	}
	const executablePath = path.join(prebuildsRoot, ...artifact.path.split("/"));
	const inspected = inspectBinary(executablePath, target);
	if (inspected.size !== artifact.size || inspected.sha256 !== artifact.sha256) {
		fail(`current target ${target} does not match its manifest`);
	}
	return await smokeNativeBinary(executablePath, { target });
}

function nativeArtifactRecord(binaryPath, target, artifactPath) {
	if (artifactPath !== expectedNativeArtifactPath(target)) {
		fail(`record path for ${target} must be ${expectedNativeArtifactPath(target)}`);
	}
	const inspected = inspectBinary(binaryPath, target);
	return {
		target,
		protocol: 1,
		path: artifactPath,
		size: inspected.size,
		sha256: inspected.sha256,
	};
}

function verifyPackReport(packageRoot, reportPath) {
	const verified = verifyNativePrebuilds(packageRoot);
	const { bytes } = readStableFile(reportPath, "npm pack dry-run report", 4 * 1024 * 1024);
	let report;
	try {
		report = JSON.parse(bytes.toString("utf8"));
	} catch {
		fail("npm pack dry-run report is not valid JSON");
	}
	const packageReport = Array.isArray(report) ? report[0] : Object.values(report ?? {})[0];
	if (!packageReport || !Array.isArray(packageReport.files)) {
		fail("npm pack dry-run report has no file list");
	}
	const files = new Set(packageReport.files.map((entry) => entry?.path));
	const required = [
		"prebuilds/stdd-fs/manifest.json",
		...verified.artifacts.map((artifact) => `prebuilds/stdd-fs/${artifact.path}`),
	];
	for (const relative of required) {
		if (!files.has(relative)) fail(`npm package omits ${relative}`);
	}
	return required;
}

function optionValue(args, option) {
	const index = args.indexOf(option);
	if (index === -1 || index === args.length - 1 || args[index + 1].startsWith("--")) {
		fail(`${option} requires a value`);
	}
	return args[index + 1];
}

async function main(args) {
	let packageRoot = REPOSITORY_ROOT;
	if (args.includes("--root")) packageRoot = path.resolve(optionValue(args, "--root"));
	if (args.includes("--record-binary")) {
		const binaryPath = path.resolve(optionValue(args, "--record-binary"));
		const target = optionValue(args, "--target");
		const artifactPath = optionValue(args, "--artifact-path");
		process.stdout.write(`${JSON.stringify(nativeArtifactRecord(binaryPath, target, artifactPath))}\n`);
		return;
	}
	if (args.includes("--smoke-binary")) {
		const executablePath = path.resolve(optionValue(args, "--smoke-binary"));
		const target = optionValue(args, "--target");
		const probeRoot = path.resolve(optionValue(args, "--probe-root"));
		await smokeNativeBinary(executablePath, { target, probeRoot });
		process.stdout.write(`verified ${target} protocol-v1 hello/probe\n`);
		return;
	}
	if (args.includes("--check-pack")) {
		const reportPath = path.resolve(optionValue(args, "--check-pack"));
		const required = verifyPackReport(packageRoot, reportPath);
		process.stdout.write(`verified npm pack contains ${required.length} native prebuild files\n`);
		return;
	}
	const verified = verifyNativePrebuilds(packageRoot);
	if (args.includes("--smoke-current")) await smokeCurrentPrebuild(packageRoot);
	process.stdout.write(`verified ${verified.artifacts.length} native prebuilds\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
