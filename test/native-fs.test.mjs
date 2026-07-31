import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	NATIVE_FS_PROTOCOL_VERSION,
	nativeFsTarget,
	openNativeFsSession,
	verifyNativeFsArtifact,
} from "../sdk/native-fs.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREBUILDS_ROOT = path.join(PACKAGE_ROOT, "prebuilds", "stdd-fs");
const MANIFEST = path.join(PREBUILDS_ROOT, "manifest.json");
const ARTIFACT = path.join(PREBUILDS_ROOT, "linux-x64", "stdd-fs");
const MAX_CHUNK_BYTES = 64 * 1024;

function temporaryDirectory(t, prefix = "stdd-native-fs-") {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

async function sessionFor(t, options = {}) {
	const session = await openNativeFsSession({ packageRoot: PACKAGE_ROOT, ...options });
	t.after(() => session.close());
	return session;
}

function artifactEntry(target, bytes) {
	return {
		target,
		protocol: 1,
		path: `${target}/${target.startsWith("win32-") ? "stdd-fs.exe" : "stdd-fs"}`,
		size: bytes.length,
		sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	};
}

function writeArtifactPackage(t, bytes, { mode = 0o755, target = "linux-x64" } = {}) {
	const root = temporaryDirectory(t, "stdd-native-package-");
	const targetRoot = path.join(root, "prebuilds", "stdd-fs", target);
	fs.mkdirSync(targetRoot, { recursive: true });
	const executable = path.join(targetRoot, target.startsWith("win32-") ? "stdd-fs.exe" : "stdd-fs");
	fs.writeFileSync(executable, bytes, { mode });
	const manifestPath = path.join(root, "prebuilds", "stdd-fs", "manifest.json");
	fs.writeFileSync(
		manifestPath,
		`${JSON.stringify({ schema: 1, artifacts: [artifactEntry(target, bytes)] }, null, "\t")}\n`,
	);
	return { root, targetRoot, executable, manifestPath };
}

function assertIdentity(identity, kind) {
	assert.deepEqual(Object.keys(identity).sort(), ["fileId", "kind", "platform", "version", "volume"]);
	assert.equal(identity.version, 2);
	assert.equal(identity.platform, "linux");
	assert.match(identity.volume, /^(?:0|[1-9][0-9]*)$/);
	assert.match(identity.fileId, /^(?:0|[1-9][0-9]*)$/);
	assert.equal(identity.kind, kind);
}

function assertObservation(observation, kind) {
	assert.deepEqual(Object.keys(observation).sort(), [
		"changedNs",
		"identity",
		"linkCount",
		"modifiedNs",
		"owner",
		"permissions",
		"size",
	]);
	assertIdentity(observation.identity, kind);
	for (const field of ["owner", "permissions", "linkCount", "size", "modifiedNs", "changedNs"]) {
		assert.match(observation[field], /^-?(?:0|[1-9][0-9]*)$/);
	}
}

let compiledFakeHelper = null;
function fakeHelperBinary() {
	if (compiledFakeHelper) return compiledFakeHelper;
	const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-native-fake-build-"));
	const source = path.join(buildRoot, "fake.c");
	const output = path.join(buildRoot, "fake");
	fs.writeFileSync(
		source,
		`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  char mode[32] = {0}, line[2097152], id[64] = {0};
  FILE *settings = fopen("fake-mode", "r");
  if (!settings || !fgets(mode, sizeof(mode), settings)) return 9;
  fclose(settings);
  mode[strcspn(mode, "\\r\\n")] = 0;
  int count = 0;
  while (fgets(line, sizeof(line), stdin)) {
    count++;
    char *start = strstr(line, "\\"id\\":\\"");
    if (!start) return 8;
    start += 6;
    char *end = strchr(start, '"');
    if (!end || (size_t)(end - start) >= sizeof(id)) return 8;
    memcpy(id, start, (size_t)(end - start));
    id[end - start] = 0;
    if (count == 1) {
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"protocol\\":1,\\"helper\\":\\"stdd-fs\\",\\"maxLineBytes\\":1048576,\\"maxChunkBytes\\":65536}}\\n", id);
      fflush(stdout);
      if (!strcmp(mode, "clean-eof")) return 0;
      continue;
    }
    if (!strcmp(mode, "malformed")) { puts("{not json}"); fflush(stdout); }
    else if (!strcmp(mode, "bad-result")) {
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"cap\\":\\"c1\\"}}\\n", id);
      fflush(stdout);
    } else if (!strcmp(mode, "wrong-kind")) {
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"cap\\":\\"c1\\",\\"observation\\":{\\"identity\\":{\\"version\\":2,\\"platform\\":\\"linux\\",\\"volume\\":\\"1\\",\\"fileId\\":\\"1\\",\\"kind\\":\\"file\\"},\\"owner\\":\\"1\\",\\"permissions\\":\\"1\\",\\"linkCount\\":\\"1\\",\\"size\\":\\"0\\",\\"modifiedNs\\":\\"0\\",\\"changedNs\\":\\"0\\"}}}\\n", id);
      fflush(stdout);
    } else if (!strcmp(mode, "wrong-rename")) {
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"observation\\":{\\"identity\\":{\\"version\\":2,\\"platform\\":\\"linux\\",\\"volume\\":\\"1\\",\\"fileId\\":\\"2\\",\\"kind\\":\\"file\\"},\\"owner\\":\\"1\\",\\"permissions\\":\\"1\\",\\"linkCount\\":\\"1\\",\\"size\\":\\"0\\",\\"modifiedNs\\":\\"0\\",\\"changedNs\\":\\"0\\"}}}\\n", id);
      fflush(stdout);
    } else if (!strcmp(mode, "capture-create")) {
      int directory = strstr(line, "\\"op\\":\\"create-directory\\"") != NULL;
      int file = strstr(line, "\\"op\\":\\"create-file\\"") != NULL;
      int directory_mode = strstr(line, "\\"mode\\":448") || strstr(line, "\\"mode\\":493");
      int file_mode = strstr(line, "\\"mode\\":384") || strstr(line, "\\"mode\\":420") || strstr(line, "\\"mode\\":493");
      if (!strstr(line, "\\"expected\\":null") || !(directory ? directory_mode : file && file_mode)) return 7;
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"cap\\":\\"c1\\",\\"observation\\":{\\"identity\\":{\\"version\\":2,\\"platform\\":\\"linux\\",\\"volume\\":\\"1\\",\\"fileId\\":\\"1\\",\\"kind\\":\\"%s\\"},\\"owner\\":\\"1\\",\\"permissions\\":\\"33152\\",\\"linkCount\\":\\"1\\",\\"size\\":\\"0\\",\\"modifiedNs\\":\\"0\\",\\"changedNs\\":\\"0\\"}}}\\n", id, directory ? "directory" : "file");
      fflush(stdout);
    } else if (!strcmp(mode, "capture-set-mode")) {
      if (!strstr(line, "\\"op\\":\\"set-mode\\"") ||
          !strstr(line, "\\"cap\\":\\"c1\\"") ||
          !strstr(line, "\\"mode\\":436") ||
          !strstr(line, "\\"kind\\":\\"file\\"")) return 7;
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"observation\\":{\\"identity\\":{\\"version\\":2,\\"platform\\":\\"linux\\",\\"volume\\":\\"1\\",\\"fileId\\":\\"2\\",\\"kind\\":\\"file\\"},\\"owner\\":\\"1\\",\\"permissions\\":\\"33204\\",\\"linkCount\\":\\"1\\",\\"size\\":\\"0\\",\\"modifiedNs\\":\\"0\\",\\"changedNs\\":\\"0\\"}}}\\n", id);
      fflush(stdout);
    } else if (!strcmp(mode, "capture-read-link")) {
      if (!strstr(line, "\\"op\\":\\"read-link\\"") ||
          !strstr(line, "\\"parent\\":\\"c1\\"") ||
          !strstr(line, "\\"name\\":\\"link\\"") ||
          !strstr(line, "\\"kind\\":\\"symlink\\"")) return 7;
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"data\\":\\"Li4vZXNjYXBlL/9ieXRlcw==\\"}}\\n", id);
      fflush(stdout);
    } else if (!strcmp(mode, "oversized-read-link")) {
      printf("{\\"v\\":1,\\"id\\":\\"%s\\",\\"ok\\":true,\\"result\\":{\\"data\\":\\"", id);
      for (int i = 0; i < 21846; i++) fputs("AAAA", stdout);
      puts("\\"}}");
      fflush(stdout);
    } else if (!strcmp(mode, "oversized")) {
      for (int i = 0; i < 1048577; i++) fputc('x', stdout);
      fflush(stdout);
    } else if (!strcmp(mode, "out-of-order")) {
      puts("{\\"v\\":1,\\"id\\":\\"wrong\\",\\"ok\\":true,\\"result\\":{}}");
      fflush(stdout);
    } else if (!strcmp(mode, "timeout")) sleep(2);
    else if (!strcmp(mode, "crash")) return 3;
  }
  return 0;
}
`,
	);
	try {
		execFileSync("cc", ["-Os", "-s", "-o", output, source]);
	} catch (error) {
		if (error.code !== "EPERM" || error.status !== 0 || !fs.existsSync(output)) throw error;
	}
	compiledFakeHelper = fs.readFileSync(output);
	fs.rmSync(buildRoot, { recursive: true, force: true });
	return compiledFakeHelper;
}

test("native filesystem target IDs and root manifest cover the six-target schema", () => {
	assert.equal(NATIVE_FS_PROTOCOL_VERSION, 1);
	assert.deepEqual(
		[
			nativeFsTarget("linux", "x64"),
			nativeFsTarget("linux", "arm64"),
			nativeFsTarget("darwin", "x64"),
			nativeFsTarget("darwin", "arm64"),
			nativeFsTarget("win32", "x64"),
			nativeFsTarget("win32", "arm64"),
		],
		["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"],
	);
	assert.throws(() => nativeFsTarget("windows", "x64"), /unsupported native filesystem target/);
	assert.throws(() => nativeFsTarget("linux", "riscv64"), /unsupported native filesystem target/);
	assert.equal(fs.existsSync(path.join(PREBUILDS_ROOT, "linux-x64", "manifest.json")), false);
	const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
	assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "schema"]);
	assert.equal(manifest.artifacts.length, 6);
	for (const artifact of manifest.artifacts) {
		assert.deepEqual(Object.keys(artifact).sort(), ["path", "protocol", "sha256", "size", "target"]);
	}
	assert.deepEqual(
		manifest.artifacts.map(({ path: artifactPath }) => artifactPath),
		[
			"darwin-arm64/stdd-fs",
			"darwin-x64/stdd-fs",
			"linux-arm64/stdd-fs",
			"linux-x64/stdd-fs",
			"win32-arm64/stdd-fs.exe",
			"win32-x64/stdd-fs.exe",
		],
	);
});

test("real helper exposes typed capability methods, v2 observations, and bounded list continuation", async (t) => {
	const rootPath = temporaryDirectory(t);
	const session = await sessionFor(t);
	for (const method of [
		"probe",
		"preflightSymlink",
		"verifyPrivate",
		"openRoot",
		"openChild",
		"createDirectory",
		"createFile",
		"setMode",
		"stat",
		"list",
		"read",
		"readLink",
		"write",
		"truncate",
		"flush",
		"rename",
		"symlink",
		"closeCapability",
		"request",
	]) {
		assert.equal(typeof session[method], "function", method);
	}

	const root = await session.openRoot(rootPath);
	assertObservation(root.observation, "directory");
	const probe = await session.probe(root.cap);
	assert.deepEqual(Object.keys(probe).sort(), ["filesystem", "filesystemId", "platform", "primitives"]);
	assert.equal(probe.platform, "linux");
	assert.ok(["ext", "tmpfs", "xfs", "overlayfs", "btrfs"].includes(probe.filesystem));
	assert.deepEqual(Object.keys(probe.primitives).sort(), [
		"atomicRename",
		"directoryFlush",
		"fileFlush",
		"identity",
		"noFollow",
		"noReplace",
	]);
	assert.deepEqual(await session.preflightSymlink(root.cap), {});

	const directory = await session.createDirectory(root.cap, "held", 0o700);
	assert.deepEqual(await session.verifyPrivate(directory.cap), {});
	fs.mkdirSync(path.join(rootPath, "public"), { mode: 0o755 });
	const publicDirectory = await session.openChild(root.cap, "public");
	await assert.rejects(
		session.verifyPrivate(publicDirectory.cap),
		(error) => error.code === "private-permissions-required" && error.mutation === "none",
	);
	const file = await session.createFile(directory.cap, "payload.bin", 0o600);
	assertObservation(file.observation, "file");
	const native = fs.lstatSync(path.join(rootPath, "held", "payload.bin"), { bigint: true });
	assert.equal(file.observation.owner, native.uid.toString());
	assert.equal(file.observation.permissions, native.mode.toString());
	assert.equal(file.observation.linkCount, native.nlink.toString());
	assert.equal(file.observation.size, native.size.toString());

	const bytes = Buffer.from([0, 255, 1, 128, 65, 0, 66]);
	assert.deepEqual(await session.write(file.cap, 0, bytes, file.observation.identity), {
		written: bytes.length,
	});
	await session.flush(file.cap, "data", file.observation.identity);
	const read = await session.read(file.cap, 0, bytes.length);
	assert.deepEqual(Buffer.from(read.data, "base64"), bytes);
	assert.equal(read.eof, false);
	await session.truncate(file.cap, 3, file.observation.identity);
	await session.flush(file.cap, "all", file.observation.identity);
	assert.equal(Buffer.from((await session.read(file.cap, 0, 8)).data, "base64").length, 3);
	assert.equal(
		(await session.stat(file.cap)).observation.identity.fileId,
		file.observation.identity.fileId,
	);

	await session.createFile(directory.cap, "a", 0o600);
	await session.createFile(directory.cap, "z", 0o600);
	const listedNames = [];
	let cursor = null;
	for (let pageCount = 0; pageCount < 4; pageCount += 1) {
		const page = await session.list(directory.cap, { cursor, limit: 2 });
		assert.ok(page.entries.length <= 2);
		listedNames.push(...page.entries.map((entry) => entry.name));
		cursor = page.cursor;
		if (cursor === null) break;
	}
	assert.equal(cursor, null);
	assert.deepEqual(listedNames.sort(), ["a", "payload.bin", "z"]);

	const destination = await session.createDirectory(root.cap, "destination", 0o700);
	const renamed = await session.rename({
		fromParent: directory.cap,
		from: "payload.bin",
		expected: file.observation.identity,
		toParent: destination.cap,
		to: "moved.bin",
		replace: "never",
	});
	assert.deepEqual(renamed.observation.identity, file.observation.identity);
	const link = await session.symlink(destination.cap, "link", "moved.bin");
	assertIdentity(link.observation.identity, "symlink");
	await assert.rejects(
		session.openChild(destination.cap, "link"),
		(error) => error.code === "symlink-rejected" && error.mutation === "none",
	);
	await session.flush(destination.cap, "namespace", destination.observation.identity);

	for (const cap of [file.cap, publicDirectory.cap, destination.cap, directory.cap, root.cap]) {
		assert.deepEqual(await session.closeCapability(cap), {});
	}
	await assert.rejects(
		session.stat(file.cap),
		(error) => error.code === "unknown-capability" && error.mutation === "none",
	);
});

test("rename enforces never, any, and expected replacement across held directories", async (t) => {
	const rootPath = temporaryDirectory(t);
	const session = await sessionFor(t);
	const root = await session.openRoot(rootPath);
	await session.probe(root.cap);
	const left = await session.createDirectory(root.cap, "left", 0o700);
	const right = await session.createDirectory(root.cap, "right", 0o700);

	const blocked = await session.createFile(left.cap, "blocked", 0o600);
	const occupied = await session.createFile(right.cap, "occupied", 0o600);
	await assert.rejects(
		session.rename({
			fromParent: left.cap,
			from: "blocked",
			expected: blocked.observation.identity,
			toParent: right.cap,
			to: "occupied",
			replace: "never",
		}),
		(error) =>
			error.code === "identity-conflict" && error.class === "conflict" && error.mutation === "none",
	);
	assert.equal(fs.existsSync(path.join(rootPath, "left", "blocked")), true);

	const expectedSource = await session.createFile(left.cap, "expected-source", 0o600);
	const expectedTarget = await session.createFile(right.cap, "expected-target", 0o600);
	const expectedResult = await session.rename({
		fromParent: left.cap,
		from: "expected-source",
		expected: expectedSource.observation.identity,
		toParent: right.cap,
		to: "expected-target",
		replace: "expected",
		expectedTarget: expectedTarget.observation.identity,
	});
	assert.deepEqual(expectedResult.observation.identity, expectedSource.observation.identity);

	const anySource = await session.createFile(left.cap, "any-source", 0o600);
	const anyResult = await session.rename({
		fromParent: left.cap,
		from: "any-source",
		expected: anySource.observation.identity,
		toParent: right.cap,
		to: "occupied",
		replace: "any",
		expectedTarget: null,
	});
	assert.deepEqual(anyResult.observation.identity, anySource.observation.identity);
	await assert.rejects(
		session.rename({
			fromParent: left.cap,
			from: "blocked",
			expected: blocked.observation.identity,
			toParent: right.cap,
			to: "new",
			replace: "any",
		}),
		(error) => error.code === "invalid-fields" && error.mutation === "none",
	);
	await session.closeCapability(occupied.cap);
});

test("failed probe leaves target namespace unchanged and mutation requires successful probe", async (t) => {
	const rootPath = temporaryDirectory(t);
	fs.writeFileSync(path.join(rootPath, "ordinary-file"), "safe");
	const session = await sessionFor(t);
	const root = await session.openRoot(rootPath);
	const file = await session.openChild(root.cap, "ordinary-file");
	await assert.rejects(
		session.probe(file.cap),
		(error) => error.code === "not-directory-capability" && error.mutation === "none",
	);
	await assert.rejects(
		session.createFile(root.cap, "must-not-exist", 0o600),
		(error) =>
			error.code === "probe-required" && error.class === "unsupported" && error.mutation === "none",
	);
	assert.equal(fs.existsSync(path.join(rootPath, "must-not-exist")), false);
	assert.equal(fs.readFileSync(path.join(rootPath, "ordinary-file"), "utf8"), "safe");
});

test("exact fields, capability kinds, expected identities, and reserved names fail before mutation", async (t) => {
	const rootPath = temporaryDirectory(t);
	const session = await sessionFor(t);
	const root = await session.openRoot(rootPath);
	await session.probe(root.cap);
	const file = await session.createFile(root.cap, "safe", 0o600);
	const wrong = {
		...file.observation.identity,
		fileId: String(BigInt(file.observation.identity.fileId) + 1n),
	};
	for (const fields of [
		{ path: rootPath, unknown: true },
		{ path: rootPath, paht: rootPath },
	]) {
		await assert.rejects(
			session.request("open-root", fields),
			(error) => error.code === "invalid-fields" && error.mutation === "none",
		);
	}
	await assert.rejects(
		session.request("create-file", { parent: root.cap, name: "missing-expected" }),
		(error) => error.code === "invalid-fields" && error.mutation === "none",
	);
	await assert.rejects(
		session.request("write", {
			cap: file.cap,
			offset: 0,
			data: Buffer.from("changed").toString("base64"),
			expected: wrong,
		}),
		(error) => error.code === "identity-conflict" && error.mutation === "none",
	);
	assert.equal(fs.readFileSync(path.join(rootPath, "safe"), "utf8"), "");
	await assert.rejects(
		session.request("write", {
			cap: file.cap,
			offset: 0,
			data: "",
			expected: { ...file.observation.identity, platform: "darwin" },
		}),
		(error) => error.code === "foreign-identity" && error.mutation === "none",
	);
	await assert.rejects(
		session.request("write", {
			cap: file.cap,
			offset: 0,
			data: "",
			expected: { ...file.observation.identity, volume: "18446744073709551616" },
		}),
		(error) => error.code === "invalid-identity" && error.mutation === "none",
	);
	await assert.rejects(
		session.read(root.cap, 0, 1),
		(error) => error.code === "not-file-capability" && error.mutation === "none",
	);
	await assert.rejects(
		session.request("stat", { cap: file.cap, v: 1 }),
		(error) => error.code === "reserved-field" && error.mutation === "none",
	);
	for (const name of [".", "..", "../escape", "nested/name", "hidden\u202eowned"]) {
		await assert.rejects(
			session.createFile(root.cap, name, 0o600),
			(error) => error.code === "invalid-basename" && error.mutation === "none",
		);
	}
});

test("creation modes and exact request shapes fail locally before issue", async (t) => {
	const operations = [
		{
			operation: "create-directory",
			validMode: 0o700,
			unsupportedMode: 0o750,
		},
		{
			operation: "create-file",
			validMode: 0o600,
			unsupportedMode: 0o640,
		},
	];
	for (const { operation, validMode, unsupportedMode } of operations) {
		const invalid = [
			["missing", { parent: "c1", name: "x", expected: null }, "invalid-fields"],
			[
				"wrong type",
				{ parent: "c1", name: "x", mode: String(validMode), expected: null },
				"invalid-mode",
			],
			[
				"unsupported",
				{ parent: "c1", name: "x", mode: unsupportedMode, expected: null },
				"invalid-mode",
			],
			[
				"unknown",
				{ parent: "c1", name: "x", mode: validMode, expected: null, unknown: true },
				"invalid-fields",
			],
			["misspelled", { parent: "c1", name: "x", mdoe: validMode, expected: null }, "invalid-fields"],
		];
		for (const [label, fields, code] of invalid) {
			await t.test(`${operation} ${label}`, async (t) => {
				const pkg = writeArtifactPackage(t, fakeHelperBinary());
				fs.writeFileSync(path.join(pkg.root, "fake-mode"), "bad-result\n");
				const session = await sessionFor(t, {
					packageRoot: pkg.root,
					target: "linux-x64",
				});
				await assert.rejects(
					session.request(operation, fields),
					(error) => error.code === code && error.mutation === "none",
				);
				await assert.rejects(
					session.request("probe", { root: "c1" }),
					(error) => error.code === "malformed-response",
				);
			});
		}
		for (const [label, mode] of [
			["missing typed mode", undefined],
			["wrong typed mode", String(validMode)],
			["unsupported typed mode", unsupportedMode],
		]) {
			await t.test(`${operation} ${label}`, async (t) => {
				const pkg = writeArtifactPackage(t, fakeHelperBinary());
				fs.writeFileSync(path.join(pkg.root, "fake-mode"), "bad-result\n");
				const session = await sessionFor(t, {
					packageRoot: pkg.root,
					target: "linux-x64",
				});
				const result =
					operation === "create-directory"
						? session.createDirectory("c1", "x", mode)
						: session.createFile("c1", "x", mode);
				await assert.rejects(
					result,
					(error) => error.code === "invalid-mode" && error.mutation === "none",
				);
				await assert.rejects(
					session.request("probe", { root: "c1" }),
					(error) => error.code === "malformed-response",
				);
			});
		}
	}

	const pkg = writeArtifactPackage(t, fakeHelperBinary());
	fs.writeFileSync(path.join(pkg.root, "fake-mode"), "capture-create\n");
	const session = await sessionFor(t, {
		packageRoot: pkg.root,
		target: "linux-x64",
	});
	for (const mode of [0o700, 0o755]) {
		assert.equal((await session.createDirectory("c1", `dir-${mode}`, mode)).cap, "c1");
	}
	for (const mode of [0o600, 0o644, 0o755]) {
		assert.equal((await session.createFile("c1", `file-${mode}`, mode)).cap, "c1");
	}
});

test("setMode binds a held file identity and validates the legacy mode range strictly", async (t) => {
	const expected = {
		version: 2,
		platform: "linux",
		volume: "1",
		fileId: "2",
		kind: "file",
	};
	const pkg = writeArtifactPackage(t, fakeHelperBinary());
	fs.writeFileSync(path.join(pkg.root, "fake-mode"), "capture-set-mode\n");
	const session = await sessionFor(t, { packageRoot: pkg.root, target: "linux-x64" });
	const changed = await session.setMode("c1", 0o664, expected);
	assert.deepEqual(changed.observation.identity, expected);
	for (const mode of ["0664", 0o1000, -1]) {
		await assert.rejects(
			session.setMode("c1", mode, expected),
			(error) => error.code === "invalid-mode" && error.mutation === "none",
		);
	}
	await assert.rejects(
		session.setMode("c1", 0o664, { ...expected, kind: "directory" }),
		(error) => error.code === "file-identity-required" && error.mutation === "none",
	);
});

test("readLink proxies an exact identity and validates lossless bounded results", async (t) => {
	const expected = {
		version: 2,
		platform: "linux",
		volume: "1",
		fileId: "2",
		kind: "symlink",
	};
	const pkg = writeArtifactPackage(t, fakeHelperBinary());
	fs.writeFileSync(path.join(pkg.root, "fake-mode"), "capture-read-link\n");
	const session = await sessionFor(t, { packageRoot: pkg.root, target: "linux-x64" });
	const result = await session.readLink("c1", "link", expected);
	assert.deepEqual(
		Buffer.from(result.data, "base64"),
		Buffer.from([
			0x2e, 0x2e, 0x2f, 0x65, 0x73, 0x63, 0x61, 0x70, 0x65, 0x2f, 0xff, 0x62, 0x79, 0x74, 0x65, 0x73,
		]),
	);

	for (const [fields, code] of [
		[{ parent: "c1", name: "link", expected, unknown: true }, "invalid-fields"],
		[{ parent: "c1", name: "../link", expected }, "invalid-basename"],
		[
			{ parent: "c1", name: "link", expected: { ...expected, kind: "file" } },
			"symlink-identity-required",
		],
		[{ parent: "c1", name: "link", expected: { ...expected, platform: "darwin" } }, "foreign-identity"],
	]) {
		await assert.rejects(
			session.request("read-link", fields),
			(error) => error.code === code && error.mutation === "none",
		);
	}
});

test("readLink rejects an oversized helper result", async (t) => {
	const pkg = writeArtifactPackage(t, fakeHelperBinary());
	fs.writeFileSync(path.join(pkg.root, "fake-mode"), "oversized-read-link\n");
	const session = await sessionFor(t, { packageRoot: pkg.root, target: "linux-x64" });
	await assert.rejects(
		session.readLink("c1", "link", {
			version: 2,
			platform: "linux",
			volume: "1",
			fileId: "2",
			kind: "symlink",
		}),
		(error) => error.code === "malformed-response" && error.class === "transport",
	);
});

test("JavaScript decodes base64 and enforces exact 64 KiB bounds before issue", async (t) => {
	const rootPath = temporaryDirectory(t);
	const session = await sessionFor(t);
	const root = await session.openRoot(rootPath);
	await session.probe(root.cap);
	const file = await session.createFile(root.cap, "bounded", 0o600);
	const maximum = Buffer.alloc(MAX_CHUNK_BYTES, 0xa5);
	assert.deepEqual(await session.write(file.cap, 0, maximum, file.observation.identity), {
		written: MAX_CHUNK_BYTES,
	});
	await assert.rejects(
		session.write(file.cap, 0, Buffer.alloc(MAX_CHUNK_BYTES + 1), file.observation.identity),
		(error) => error.code === "chunk-too-large" && error.mutation === "none",
	);
	await assert.rejects(
		session.request("write", {
			cap: file.cap,
			offset: 0,
			data: "AA===",
			expected: file.observation.identity,
		}),
		(error) => error.code === "invalid-base64" && error.mutation === "none",
	);
	await assert.rejects(
		session.read(file.cap, 0, MAX_CHUNK_BYTES + 1),
		(error) => error.code === "chunk-too-large" && error.mutation === "none",
	);
});

test("root manifest verifier accepts hardlinked package files and rejects target/path/integrity changes", async (t) => {
	const verified = await verifyNativeFsArtifact(PACKAGE_ROOT, "linux-x64");
	assert.equal(verified.path, ARTIFACT);
	assert.equal(verified.target, "linux-x64");
	assert.match(verified.sha256, /^sha256:[0-9a-f]{64}$/);
	assert.ok(verified.size > 0);

	const original = fs.readFileSync(ARTIFACT);
	await t.test("hardlinked manifest and helper", async (t) => {
		const pkg = writeArtifactPackage(t, original);
		const helperSeed = path.join(pkg.targetRoot, "helper-seed");
		fs.renameSync(pkg.executable, helperSeed);
		fs.linkSync(helperSeed, pkg.executable);
		const manifestSeed = path.join(path.dirname(pkg.manifestPath), "manifest-seed");
		fs.renameSync(pkg.manifestPath, manifestSeed);
		fs.linkSync(manifestSeed, pkg.manifestPath);
		const hardlinked = await verifyNativeFsArtifact(pkg.root, "linux-x64");
		assert.equal(hardlinked.size, original.length);
	});

	for (const scenario of ["wrong-target", "path", "hash", "size", "symlink", "nonregular", "mode"]) {
		await t.test(scenario, async (t) => {
			const pkg = writeArtifactPackage(t, original);
			const manifest = JSON.parse(fs.readFileSync(pkg.manifestPath, "utf8"));
			if (scenario === "wrong-target") manifest.artifacts[0].target = "linux-arm64";
			if (scenario === "path") manifest.artifacts[0].path = "stdd-fs";
			if (scenario === "hash") manifest.artifacts[0].sha256 = `sha256:${"0".repeat(64)}`;
			if (scenario === "size") manifest.artifacts[0].size += 1;
			if (["wrong-target", "path", "hash", "size"].includes(scenario)) {
				fs.writeFileSync(pkg.manifestPath, JSON.stringify(manifest));
			}
			if (scenario === "symlink") {
				fs.rmSync(pkg.executable);
				fs.symlinkSync(ARTIFACT, pkg.executable);
			}
			if (scenario === "nonregular") {
				fs.rmSync(pkg.executable);
				fs.mkdirSync(pkg.executable);
			}
			if (scenario === "mode") fs.chmodSync(pkg.executable, 0o644);
			await assert.rejects(verifyNativeFsArtifact(pkg.root, "linux-x64"));
		});
	}
});

test("result-shape and transport failures close the artifact fd and terminate the helper", async (t) => {
	for (const mode of [
		"bad-result",
		"wrong-kind",
		"wrong-rename",
		"malformed",
		"oversized",
		"out-of-order",
		"timeout",
		"clean-eof",
	]) {
		await t.test(mode, async (t) => {
			const pkg = writeArtifactPackage(t, fakeHelperBinary());
			fs.writeFileSync(path.join(pkg.root, "fake-mode"), `${mode}\n`);
			const session = await openNativeFsSession({
				packageRoot: pkg.root,
				target: "linux-x64",
				timeoutMs: 100,
			});
			const descriptor = session.artifact.handle.fd;
			const pid = session.child.pid;
			const expected = {
				version: 2,
				platform: "linux",
				volume: "1",
				fileId: "1",
				kind: "file",
			};
			const operation = ["bad-result", "wrong-kind"].includes(mode)
				? session.openRoot(path.resolve(pkg.root))
				: mode === "wrong-rename"
					? session.rename({
							fromParent: "c1",
							from: "source",
							expected,
							toParent: "c2",
							to: "target",
							replace: "never",
						})
					: session.request("probe", { root: "c1" });
			await assert.rejects(operation, (error) => {
				assert.equal(error.mutation, mode === "wrong-rename" ? "possible" : "none");
				if (mode === "timeout") assert.equal(error.code, "timeout");
				else if (mode === "oversized") assert.equal(error.code, "line-too-large");
				else if (mode === "clean-eof") assert.match(error.code, /helper-exit|unexpected-eof/);
				else assert.equal(error.code, "malformed-response");
				return true;
			});
			await session.close();
			assert.throws(() => fs.fstatSync(descriptor), /EBADF/);
			assert.throws(() => process.kill(pid, 0), /ESRCH/);
			await session.close();
		});
	}
});

test("transport marks an issued mutator indeterminate and escalates a hung child", async (t) => {
	const pkg = writeArtifactPackage(t, fakeHelperBinary());
	fs.writeFileSync(path.join(pkg.root, "fake-mode"), "timeout\n");
	const session = await openNativeFsSession({
		packageRoot: pkg.root,
		target: "linux-x64",
		timeoutMs: 100,
	});
	await assert.rejects(
		session.request("create-file", { parent: "c1", name: "x", mode: 0o600, expected: null }),
		(error) => error.operation === "create-file" && error.mutation === "possible",
	);
	await session.close();
	assert.notEqual(session.child.signalCode, null);
});

test("setMode transport failure is classified as an indeterminate mutation", async (t) => {
	const pkg = writeArtifactPackage(t, fakeHelperBinary());
	fs.writeFileSync(path.join(pkg.root, "fake-mode"), "timeout\n");
	const session = await openNativeFsSession({
		packageRoot: pkg.root,
		target: "linux-x64",
		timeoutMs: 100,
	});
	await assert.rejects(
		session.setMode("c1", 0o664, {
			version: 2,
			platform: "linux",
			volume: "1",
			fileId: "2",
			kind: "file",
		}),
		(error) => error.operation === "set-mode" && error.mutation === "possible",
	);
	await session.close();
});
