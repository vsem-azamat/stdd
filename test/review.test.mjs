import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseLedger } from "../cli/lib.mjs";
import {
	closePreparedReviewBrief,
	createReviewPrivateArtifacts,
	inspectReviewRetainedInventory,
	openReviewFsTransaction,
	prepareReviewBriefSettlement,
	removeReviewBrief,
	reviewRetainedInventoryExpectation,
	settlePreparedReviewBrief,
} from "../cli/review-fs.mjs";
import { sameReviewPrivateState } from "../cli/state-validation.mjs";

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "stdd.mjs");
const REVIEW_TEST_TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-suite-"));

// Keep every repository, stub, FIFO, quarantine, and private brief created by
// this worker under one owned root. The worker-local environment is inherited
// by CLI children, and one teardown prevents repeated suites from exhausting
// the host's shared /tmp inode pool.
process.env.TMPDIR = REVIEW_TEST_TMP_ROOT;
after(() => {
	fs.rmSync(REVIEW_TEST_TMP_ROOT, {
		recursive: true,
		force: true,
		maxRetries: 3,
		retryDelay: 20,
	});
});

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return {
			code: err.code ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
}

async function waitForPath(filePath, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const ALL_CAPS = { subagents: true, crossCli: true, worktrees: true };

async function tmpGitRepo(capabilities = ALL_CAPS, review) {
	const dir = tmpDir();
	const git = (...args) =>
		exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, ".stdd"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities,
			...(review ? { review } : {}),
		}),
	);
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 1;\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2;\n");
	await git("add", ".");
	await git("commit", "-qm", "change");
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [ ] closing review [review:]\n",
	);
	return { dir, git };
}

function readLedger(dir) {
	return parseLedger(fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8"));
}

function assertAbortedReviewSettled(tempRoot) {
	const names = fs.readdirSync(tempRoot);
	assert.deepEqual(
		names.filter((name) => /^stdd-review-[0-9a-f]{32}$/.test(name)),
		[],
		"no 32-hex source directory remains",
	);
	const quarantines = names.filter((name) => /^stdd-review-quarantine-[0-9a-f]{32}$/.test(name));
	assert.equal(quarantines.length, 1, "the aborted request has one retained quarantine");
	const retained = path.join(tempRoot, quarantines[0], "private");
	for (const name of fs.readdirSync(retained)) {
		assert.equal(fs.statSync(path.join(retained, name)).size, 0, `${name} retained source bytes`);
	}
}

function privateStateFor(briefDir) {
	const identity = (candidate) => {
		const stat = fs.lstatSync(candidate, { bigint: true });
		return Object.fromEntries(
			["dev", "ino", "uid", "mode", "nlink"].map((field) => [field, stat[field].toString()]),
		);
	};
	return {
		version: 1,
		tempRoot: identity(path.resolve(os.tmpdir())),
		directory: identity(briefDir),
		artifacts: Object.fromEntries(
			fs
				.readdirSync(briefDir)
				.filter((name) => name.endsWith(".md") || name === "last-message.txt")
				.sort()
				.map((name) => [name, identity(path.join(briefDir, name))]),
		),
	};
}

test("review private state accepts complete Linux v1 and exact portable v2 provenance", () => {
	const legacy = {
		version: 1,
		tempRoot: { dev: "1", ino: "2", uid: "3", mode: "16832", nlink: "4" },
		directory: { dev: "1", ino: "5", uid: "3", mode: "16832", nlink: "2" },
		artifacts: {
			"rev-1234abcd.md": { dev: "1", ino: "6", uid: "3", mode: "33152", nlink: "1" },
		},
	};
	assert.equal(sameReviewPrivateState(legacy, structuredClone(legacy)), true);
	const foreignLegacyArtifactOwner = structuredClone(legacy);
	foreignLegacyArtifactOwner.artifacts["rev-1234abcd.md"].uid = "4";
	assert.equal(
		sameReviewPrivateState(foreignLegacyArtifactOwner, structuredClone(foreignLegacyArtifactOwner)),
		false,
		"a v1 artifact owner must equal the recorded review-directory owner",
	);
	assert.equal(
		sameReviewPrivateState(legacy, {
			...structuredClone(legacy),
			directory: { ...legacy.directory, uid: "4" },
		}),
		false,
	);

	const observation = (kind, fileId, permissions, linkCount = "1") => ({
		identity: { version: 2, platform: "linux", volume: "11", fileId, kind },
		owner: "1000",
		permissions,
		linkCount,
	});
	const portable = {
		version: 2,
		tempRootPath: "/tmp",
		tempRoot: observation("directory", "20", "17407", "8"),
		directory: observation("directory", "21", "16832", "2"),
		artifacts: { "rev-1234abcd.md": observation("file", "22", "33152") },
	};
	assert.equal(sameReviewPrivateState(portable, structuredClone(portable)), true);
	const foreignPortableArtifactOwner = structuredClone(portable);
	foreignPortableArtifactOwner.artifacts["rev-1234abcd.md"].owner = "1001";
	assert.equal(
		sameReviewPrivateState(foreignPortableArtifactOwner, structuredClone(foreignPortableArtifactOwner)),
		false,
		"a v2 artifact owner must equal the recorded review-directory owner",
	);
	assert.equal(
		sameReviewPrivateState(portable, {
			...structuredClone(portable),
			artifacts: {
				"rev-1234abcd.md": {
					...portable.artifacts["rev-1234abcd.md"],
					permissions: "33188",
				},
			},
		}),
		false,
	);
	assert.equal(sameReviewPrivateState(portable, { ...structuredClone(portable), extra: true }), false);
	const withoutRootPath = structuredClone(portable);
	delete withoutRootPath.tempRootPath;
	assert.equal(sameReviewPrivateState(portable, withoutRootPath), false);
	assert.equal(
		sameReviewPrivateState(
			{ ...structuredClone(portable), tempRoot: null },
			{ ...structuredClone(portable), tempRoot: null },
		),
		false,
		"malformed v2 provenance is rejected without throwing",
	);
	const windowsObservation = (kind, fileId) => ({
		identity: { version: 2, platform: "win32", volume: "11", fileId, kind },
		owner: "S-1-5-21-1",
		permissions: "O:S-1-5-21-1D:P(A;;FA;;;S-1-5-21-1)(A;;FA;;;SY)(A;;FA;;;BA)",
		linkCount: "1",
	});
	const windows = {
		version: 2,
		tempRootPath: "C:\\Temp",
		tempRoot: windowsObservation("directory", "1".repeat(32)),
		directory: windowsObservation("directory", "2".repeat(32)),
		artifacts: { "rev-1234abcd.md": windowsObservation("file", "3".repeat(32)) },
	};
	assert.equal(sameReviewPrivateState(windows, structuredClone(windows)), true);
	const foreignWindowsArtifactOwner = structuredClone(windows);
	foreignWindowsArtifactOwner.artifacts["rev-1234abcd.md"] = windowsObservation("file", "3".repeat(32));
	foreignWindowsArtifactOwner.artifacts["rev-1234abcd.md"].owner = "S-1-5-21-2";
	foreignWindowsArtifactOwner.artifacts["rev-1234abcd.md"].permissions =
		"O:S-1-5-21-2D:P(A;;FA;;;S-1-5-21-2)(A;;FA;;;SY)(A;;FA;;;BA)";
	assert.equal(
		sameReviewPrivateState(foreignWindowsArtifactOwner, structuredClone(foreignWindowsArtifactOwner)),
		false,
		"a Windows artifact may be private for itself but must share the directory owner",
	);
	const foreignWindowsOwner = structuredClone(windows);
	foreignWindowsOwner.directory.owner = "S-1-5-21-2";
	assert.equal(
		sameReviewPrivateState(foreignWindowsOwner, structuredClone(foreignWindowsOwner)),
		false,
		"a Windows owner cannot differ from the owner named by its protected DACL",
	);
	assert.equal(
		sameReviewPrivateState(windows, { ...structuredClone(windows), tempRootPath: "c:\\Temp" }),
		false,
		"durable state comparison remains byte-exact even though Windows path use is case-insensitive",
	);
});

test("portable v2 settlement opens its recorded temp root while v1 keeps current-root compatibility", async () => {
	const originalTmpdir = process.env.TMPDIR;
	const recordedRoot = fs.mkdtempSync(path.join(REVIEW_TEST_TMP_ROOT, "recorded-root-"));
	const currentRoot = fs.mkdtempSync(path.join(REVIEW_TEST_TMP_ROOT, "current-root-"));
	process.env.TMPDIR = recordedRoot;
	try {
		const id = "rev-00000000000000000000000000000009";
		const created = await createReviewPrivateArtifacts(id, "RECORDED_ROOT_PRIVATE_BYTES");
		const request = { id, briefPath: created.briefPath, privateState: created.privateState };
		assert.equal(created.privateState.tempRootPath, path.resolve(recordedRoot));
		process.env.TMPDIR = currentRoot;
		assert.equal(await removeReviewBrief(request), true);
		assert.equal(fs.existsSync(path.dirname(created.briefPath)), false);
		assert.equal(
			fs.readFileSync(
				path.join(recordedRoot, `stdd-review-quarantine-${id.slice(4)}`, "private", `${id}.md`),
				"utf8",
			),
			"",
		);

		const legacyId = "rev-1234abc9";
		const legacyDir = fs.mkdtempSync(path.join(currentRoot, "stdd-review-"));
		const legacyBrief = path.join(legacyDir, `${legacyId}.md`);
		fs.writeFileSync(legacyBrief, "LEGACY_CURRENT_ROOT_BYTES", { mode: 0o600 });
		fs.chmodSync(legacyDir, 0o700);
		const legacy = { id: legacyId, briefPath: legacyBrief, privateState: privateStateFor(legacyDir) };
		assert.equal(await removeReviewBrief(legacy), true);
		assert.deepEqual(await inspectReviewRetainedInventory(legacy), {
			path: path.join(currentRoot, `stdd-review-quarantine-${legacyId.slice(4)}`),
			provenance: `review request ${legacyId}`,
		});
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}
});

test("native review settlement preserves wipe order and resolves a committed rename fault", async () => {
	const id = "rev-1234abca";
	const created = await createReviewPrivateArtifacts(id, "PRIVATE_NATIVE_REVIEW_BYTES");
	const request = { id, briefPath: created.briefPath, privateState: created.privateState };
	const context = await openReviewFsTransaction("review settlement proxy test");
	const calls = [];
	const session = context.session;
	let injected = false;
	context.session = new Proxy(session, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return async (...args) => {
				if (["write", "flush", "truncate", "rename"].includes(property)) calls.push(property);
				if (property === "rename" && args[0]?.to === "private" && !injected) {
					injected = true;
					await value.apply(target, args);
					const error = new Error("injected committed native review rename fault");
					error.mutation = "committed";
					throw error;
				}
				return value.apply(target, args);
			};
		},
	});
	let prepared;
	try {
		prepared = await prepareReviewBriefSettlement(context, request);
		assert.equal(prepared.state, "source");
		assert.equal(await settlePreparedReviewBrief(prepared), true);
		assert.deepEqual(calls.slice(0, 4), ["write", "flush", "truncate", "flush"]);
		assert.ok(calls.includes("rename"));
	} finally {
		if (prepared) await closePreparedReviewBrief(prepared);
		await context.close();
	}

	const retry = await openReviewFsTransaction("review retained retry test");
	let retried;
	try {
		retried = await prepareReviewBriefSettlement(retry, request);
		assert.equal(retried.state, "retained");
		assert.equal(await settlePreparedReviewBrief(retried), true);
	} finally {
		if (retried) await closePreparedReviewBrief(retried);
		await retry.close();
	}
	const quarantine = path.join(os.tmpdir(), `stdd-review-quarantine-${id.slice(4)}`);
	const inventory = JSON.parse(fs.readFileSync(path.join(quarantine, "inventory.json"), "utf8"));
	assert.equal(inventory.request, id);
	assert.equal(inventory.retained, `${path.basename(quarantine)}/private`);
	assert.equal(fs.readFileSync(path.join(quarantine, "private", `${id}.md`), "utf8"), "");
});

test("native review settlement resolves a possible retained-move rename fault", async () => {
	const id = "rev-1234abcc";
	const created = await createReviewPrivateArtifacts(id, "PRIVATE_POSSIBLE_MOVE_BYTES");
	const request = { id, briefPath: created.briefPath, privateState: created.privateState };
	const context = await openReviewFsTransaction("review possible retained move fault");
	const wasInjected = injectNativeReviewFault(
		context,
		(property, args) => property === "rename" && args[0]?.to === "private",
		{ after: true, mutation: "possible" },
	);
	let prepared;
	try {
		prepared = await prepareReviewBriefSettlement(context, request);
		assert.equal(await settlePreparedReviewBrief(prepared), true);
		assert.equal(wasInjected(), true);
	} finally {
		if (prepared) await closePreparedReviewBrief(prepared);
		await context.close();
	}
});

test("native review settlement rejects a quarantine whose owner differs from the recorded review owner", async () => {
	const id = "rev-0000000000000000000000000000000a";
	const created = await createReviewPrivateArtifacts(id, "FOREIGN_OWNER_PRIVATE_BYTES");
	const request = { id, briefPath: created.briefPath, privateState: created.privateState };
	const quarantineName = `stdd-review-quarantine-${id.slice(4)}`;
	fs.mkdirSync(path.join(os.tmpdir(), quarantineName), { mode: 0o700 });
	const context = await openReviewFsTransaction("review foreign quarantine owner test");
	const session = context.session;
	context.session = new Proxy(session, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property !== "openChild") return typeof value === "function" ? value.bind(target) : value;
			return async (...args) => {
				const opened = await value.apply(target, args);
				if (args[1] !== quarantineName) return opened;
				return {
					...opened,
					observation: { ...opened.observation, owner: `${opened.observation.owner}-foreign` },
				};
			};
		},
	});
	let prepared;
	try {
		prepared = await prepareReviewBriefSettlement(context, request);
		await assert.rejects(
			settlePreparedReviewBrief(prepared),
			/private review quarantine is not an owner-private directory/,
		);
		assert.equal(
			fs.readFileSync(created.briefPath, "utf8"),
			"FOREIGN_OWNER_PRIVATE_BYTES",
			"a foreign-owner quarantine is rejected before source mutation",
		);
		assert.equal(fs.existsSync(path.join(os.tmpdir(), quarantineName)), true);
	} finally {
		if (prepared) await closePreparedReviewBrief(prepared);
		await context.close();
	}
});

test("native review settlement rejects a foreign-owner artifact before wiping", async () => {
	const id = "rev-0000000000000000000000000000000b";
	const secret = "FOREIGN_ARTIFACT_OWNER_BYTES";
	const created = await createReviewPrivateArtifacts(id, secret);
	const request = { id, briefPath: created.briefPath, privateState: created.privateState };
	const forged = structuredClone(request);
	forged.privateState.artifacts[`${id}.md`].owner = `${forged.privateState.directory.owner}0`;
	assert.equal(await removeReviewBrief(forged), false);
	assert.equal(
		fs.readFileSync(created.briefPath, "utf8"),
		secret,
		"crafted ledger ownership is rejected before opening or wiping its artifact",
	);
	const context = await openReviewFsTransaction("review foreign artifact owner test");
	const session = context.session;
	context.session = new Proxy(session, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property !== "openChild") return typeof value === "function" ? value.bind(target) : value;
			return async (...args) => {
				const opened = await value.apply(target, args);
				if (args[1] !== `${id}.md`) return opened;
				return {
					...opened,
					observation: { ...opened.observation, owner: `${opened.observation.owner}0` },
				};
			};
		},
	});
	let prepared;
	try {
		prepared = await prepareReviewBriefSettlement(context, request);
		assert.equal(prepared.state, "unsafe");
		assert.equal(fs.readFileSync(created.briefPath, "utf8"), secret);
	} finally {
		if (prepared) await closePreparedReviewBrief(prepared);
		await context.close();
	}
});

test("retained review inspection accepts exact Windows capability provenance and rejects forgery", async () => {
	const id = "rev-0000000000000000000000000000000c";
	const owner = "S-1-5-21-1";
	const permissions = `O:${owner}D:P(A;;FA;;;${owner})(A;;FA;;;SY)(A;;FA;;;BA)`;
	const observation = (kind, fileId, size = "0") => ({
		identity: { version: 2, platform: "win32", volume: "11", fileId, kind },
		owner,
		permissions,
		linkCount: "1",
		size,
	});
	const stable = ({ identity, owner: observedOwner, permissions: observedPermissions, linkCount }) => ({
		identity,
		owner: observedOwner,
		permissions: observedPermissions,
		linkCount,
	});
	const request = {
		id,
		brief: `sha256:${"a".repeat(64)}`,
		briefPath: `C:\\Temp\\stdd-review-${id.slice(4)}\\${id}.md`,
		privateState: {
			version: 2,
			tempRootPath: "C:\\Temp",
			tempRoot: stable(observation("directory", "1".repeat(32))),
			directory: stable(observation("directory", "2".repeat(32))),
			artifacts: { [`${id}.md`]: stable(observation("file", "3".repeat(32))) },
		},
	};
	const expected = reviewRetainedInventoryExpectation(request);
	assert.ok(expected);
	const inventoryBytes = expected.inventory;
	let calls = 0;
	const entries = new Map([
		["root", observation("directory", "1".repeat(32))],
		["quarantine", observation("directory", "4".repeat(32))],
		["inventory", observation("file", "5".repeat(32), String(inventoryBytes.length))],
		["private", observation("directory", "2".repeat(32))],
		["artifact", observation("file", "3".repeat(32))],
	]);
	const context = {
		rootPath: "C:\\Temp",
		root: { cap: "root", observation: entries.get("root") },
		session: {
			async openChild(parent, name) {
				calls += 1;
				if (parent === "root" && name === `stdd-review-quarantine-${id.slice(4)}`)
					return { cap: "quarantine", observation: entries.get("quarantine") };
				if (parent === "quarantine" && name === "inventory.json")
					return { cap: "inventory", observation: entries.get("inventory") };
				if (parent === "quarantine" && name === "private")
					return { cap: "private", observation: entries.get("private") };
				if (parent === "private" && name === `${id}.md`)
					return { cap: "artifact", observation: entries.get("artifact") };
				throw Object.assign(new Error("not found"), { code: "not-found" });
			},
			async list(capability) {
				return capability === "quarantine"
					? { entries: [{ name: "inventory.json" }, { name: "private" }], cursor: null }
					: { entries: [{ name: `${id}.md` }], cursor: null };
			},
			async read(_capability, offset) {
				return { data: inventoryBytes.subarray(offset).toString("base64"), eof: true };
			},
			async stat(capability) {
				return { observation: entries.get(capability) };
			},
			async closeCapability() {},
		},
	};
	assert.deepEqual(await inspectReviewRetainedInventory(request, { context }), {
		path: `C:\\Temp\\stdd-review-quarantine-${id.slice(4)}`,
		provenance: `review request ${id}`,
	});

	const forged = structuredClone(request);
	forged.privateState.artifacts[`${id}.md`].owner = "S-1-5-21-2";
	forged.privateState.artifacts[`${id}.md`].permissions =
		"O:S-1-5-21-2D:P(A;;FA;;;S-1-5-21-2)(A;;FA;;;SY)(A;;FA;;;BA)";
	const callsBeforeForgery = calls;
	assert.equal(await inspectReviewRetainedInventory(forged, { context }), null);
	assert.equal(calls, callsBeforeForgery, "forged ledger provenance is rejected before inspection");
});

test("native review settlement fails closed on an unknown sibling before wiping", async () => {
	const id = "rev-1234abcb";
	const secret = "UNKNOWN_SIBLING_GUARDS_PRIVATE_BYTES";
	const created = await createReviewPrivateArtifacts(id, secret);
	const context = await openReviewFsTransaction("review unknown sibling test");
	try {
		const directory = await context.session.openChild(
			context.root.cap,
			path.basename(path.dirname(created.briefPath)),
		);
		const unknown = await context.session.createFile(directory.cap, "user-note.txt", 0o600);
		await context.session.write(unknown.cap, 0, Buffer.from("unowned"), unknown.observation.identity);
		await context.session.flush(unknown.cap, "all", unknown.observation.identity);
		const prepared = await prepareReviewBriefSettlement(context, {
			id,
			briefPath: created.briefPath,
			privateState: created.privateState,
		});
		try {
			assert.equal(prepared.state, "unsafe");
			assert.equal(fs.readFileSync(created.briefPath, "utf8"), secret);
		} finally {
			await closePreparedReviewBrief(prepared);
		}
	} finally {
		await context.close();
	}
});

function injectNativeReviewFault(
	context,
	matcher,
	{ after = false, mutation = "none", message = "injected native review fault" } = {},
) {
	const session = context.session;
	let injected = false;
	context.session = new Proxy(session, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return async (...args) => {
				if (injected || !matcher(property, args)) return value.apply(target, args);
				injected = true;
				if (after) await value.apply(target, args);
				const error = new Error(message);
				error.mutation = mutation;
				throw error;
			};
		},
	});
	return () => injected;
}

test("native review creation preflights and fails closed across create, write, and flush faults", async () => {
	const unavailableId = "rev-1234abc0";
	const previousPackageRoot = process.env.STDD_NATIVE_FS_PACKAGE_ROOT;
	process.env.STDD_NATIVE_FS_PACKAGE_ROOT = path.join(REVIEW_TEST_TMP_ROOT, "missing-native-package");
	try {
		await assert.rejects(
			createReviewPrivateArtifacts(unavailableId, "never written"),
			/preflight failed/u,
		);
		assert.equal(fs.existsSync(path.join(os.tmpdir(), `stdd-review-${unavailableId.slice(4)}`)), false);
	} finally {
		if (previousPackageRoot === undefined) delete process.env.STDD_NATIVE_FS_PACKAGE_ROOT;
		else process.env.STDD_NATIVE_FS_PACKAGE_ROOT = previousPackageRoot;
	}

	const cases = [
		["rev-1234abc1", "createDirectory", false, "none"],
		["rev-1234abc2", "createDirectory", true, "committed"],
		["rev-1234abc3", "createFile", true, "possible"],
		["rev-1234abc4", "write", true, "possible"],
		["rev-1234abc5", "flush", true, "committed"],
		["rev-00000000000000000000000000000001", "createDirectory", true, "possible"],
		["rev-00000000000000000000000000000002", "createFile", true, "committed"],
		["rev-00000000000000000000000000000003", "write", true, "committed"],
		["rev-00000000000000000000000000000004", "flush", true, "possible"],
		["rev-00000000000000000000000000000006", "truncate", true, "committed"],
		["rev-00000000000000000000000000000007", "stat", false, "none"],
		["rev-00000000000000000000000000000008", "openRoot", false, "none"],
		["rev-00000000000000000000000000000009", "openChild", true, "possible"],
		[
			"rev-0000000000000000000000000000000d",
			"flush",
			true,
			"committed",
			(args) => args[1] === "namespace",
		],
	];
	for (const [id, operation, afterMutation, mutation, matchesArgs = () => true] of cases) {
		const context = await openReviewFsTransaction(`review creation ${operation} fault`);
		const wasInjected = injectNativeReviewFault(
			context,
			(property, args) => property === operation && matchesArgs(args),
			{
				after: afterMutation,
				mutation,
			},
		);
		try {
			try {
				await assert.rejects(
					createReviewPrivateArtifacts(id, "PRIVATE_CREATION_FAULT_BYTES", { context }),
					(error) => error.mutation === mutation && error.message.includes(`stdd-review-${id.slice(4)}`),
				);
			} catch (error) {
				throw new Error(`${id}/${operation}: ${error.message}`, { cause: error });
			}
			assert.equal(wasInjected(), true);
			const partial = path.join(os.tmpdir(), `stdd-review-${id.slice(4)}`);
			if (fs.existsSync(partial)) {
				for (const name of fs.readdirSync(partial)) {
					const candidate = path.join(partial, name);
					if (fs.lstatSync(candidate).isFile()) {
						assert.equal(fs.statSync(candidate).size, 0, `${id}: ${name} was not wiped`);
					}
				}
			}
			assert.equal(
				fs.existsSync(path.join(os.tmpdir(), `stdd-review-quarantine-${id.slice(4)}`)),
				false,
				"an unledgered partial creation must not be invented as a review quarantine",
			);
		} finally {
			await context.close();
		}
	}
});

test("native review partial-creation cleanup uses held capabilities after a namespace swap", async () => {
	const id = "rev-00000000000000000000000000000005";
	const source = "PRIVATE_PARTIAL_CREATION_BYTES";
	const replacement = "UNRELATED_REPLACEMENT_BYTES";
	const directoryName = `stdd-review-${id.slice(4)}`;
	const visiblePath = path.join(os.tmpdir(), directoryName);
	const heldPath = path.join(os.tmpdir(), `${directoryName}-held`);
	const artifactName = `${id}.md`;
	const context = await openReviewFsTransaction("review creation namespace-swap fault");
	const session = context.session;
	let injected = false;
	let closeAttempts = 0;
	context.session = new Proxy(session, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return async (...args) => {
				if (property === "closeCapability") {
					closeAttempts += 1;
					throw new Error("injected capability close fault");
				}
				const result = await value.apply(target, args);
				if (!injected && property === "write") {
					injected = true;
					fs.renameSync(visiblePath, heldPath);
					fs.mkdirSync(visiblePath, { mode: 0o700 });
					fs.writeFileSync(path.join(visiblePath, artifactName), replacement, { mode: 0o600 });
					const error = new Error("injected namespace swap after partial write");
					error.mutation = "committed";
					throw error;
				}
				return result;
			};
		},
	});
	try {
		await assert.rejects(
			createReviewPrivateArtifacts(id, source, { context }),
			(error) =>
				error.mutation === "committed" &&
				error.message.includes("injected namespace swap after partial write") &&
				error.message.includes("partial private review state was wiped and retained"),
		);
		assert.equal(injected, true);
		assert.equal(closeAttempts, 2, "held file and directory closure must stay bounded");
		assert.equal(fs.statSync(path.join(heldPath, artifactName)).size, 0);
		assert.equal(fs.readFileSync(path.join(visiblePath, artifactName), "utf8"), replacement);
	} finally {
		await context.close();
	}
});

test("native review settlement resumes truncate and staged inventory faults", async () => {
	const cases = [
		{
			id: "rev-00000000000000000000000000000011",
			matcher: (property) => property === "write",
			mutation: "possible",
		},
		{
			id: "rev-00000000000000000000000000000012",
			matcher: (property) => property === "write",
			mutation: "committed",
		},
		{
			id: "rev-00000000000000000000000000000013",
			matcher: (property) => property === "flush",
			mutation: "possible",
		},
		{
			id: "rev-00000000000000000000000000000014",
			matcher: (property) => property === "flush",
			mutation: "committed",
		},
		{
			id: "rev-00000000000000000000000000000015",
			matcher: (property) => property === "truncate",
			mutation: "possible",
		},
		{
			id: "rev-1234abc6",
			matcher: (property) => property === "truncate",
			mutation: "committed",
		},
		{
			id: "rev-1234abc7",
			matcher: (property, args) =>
				property === "write" && Buffer.isBuffer(args[2]) && args[2].includes('"private-review"'),
			mutation: "possible",
		},
	];
	for (const { id, matcher, mutation } of cases) {
		const created = await createReviewPrivateArtifacts(id, "PRIVATE_RETRY_BYTES");
		const request = { id, briefPath: created.briefPath, privateState: created.privateState };
		const context = await openReviewFsTransaction("review resumable settlement fault");
		const wasInjected = injectNativeReviewFault(context, matcher, { after: true, mutation });
		let prepared;
		try {
			prepared = await prepareReviewBriefSettlement(context, request);
			await assert.rejects(settlePreparedReviewBrief(prepared), (error) => error.mutation === mutation);
			assert.equal(wasInjected(), true);
		} finally {
			if (prepared) await closePreparedReviewBrief(prepared);
			await context.close();
		}

		const retry = await openReviewFsTransaction("review resumable settlement retry");
		let retried;
		try {
			retried = await prepareReviewBriefSettlement(retry, request);
			assert.equal(retried.state, "source");
			assert.equal(await settlePreparedReviewBrief(retried), true);
		} finally {
			if (retried) await closePreparedReviewBrief(retried);
			await retry.close();
		}
	}
});

test("native review postflights reject parent and retained-final replacement observations", async () => {
	const parentId = "rev-1234abc8";
	const parentContext = await openReviewFsTransaction("review creation parent replacement");
	const parentSession = parentContext.session;
	let rootOpens = 0;
	parentContext.session = new Proxy(parentSession, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return async (...args) => {
				const result = await value.apply(target, args);
				if (property === "openRoot" && ++rootOpens === 1) {
					return {
						...result,
						observation: {
							...result.observation,
							identity: {
								...result.observation.identity,
								fileId: `${result.observation.identity.fileId}-replaced`,
							},
						},
					};
				}
				return result;
			};
		},
	});
	try {
		await assert.rejects(
			createReviewPrivateArtifacts(parentId, "PRIVATE_PARENT_REPLACEMENT", { context: parentContext }),
			/OS temp root changed/u,
		);
	} finally {
		await parentContext.close();
	}

	const finalId = "rev-1234abc9";
	const created = await createReviewPrivateArtifacts(finalId, "PRIVATE_FINAL_REPLACEMENT");
	const request = { id: finalId, briefPath: created.briefPath, privateState: created.privateState };
	const finalContext = await openReviewFsTransaction("review retained final replacement");
	const finalSession = finalContext.session;
	let retainedOpens = 0;
	finalContext.session = new Proxy(finalSession, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return async (...args) => {
				const result = await value.apply(target, args);
				if (property === "openChild" && args[1] === "private" && ++retainedOpens === 3) {
					return {
						...result,
						observation: {
							...result.observation,
							identity: {
								...result.observation.identity,
								fileId: `${result.observation.identity.fileId}-replaced`,
							},
						},
					};
				}
				return result;
			};
		},
	});
	let prepared;
	try {
		prepared = await prepareReviewBriefSettlement(finalContext, request);
		assert.equal(await settlePreparedReviewBrief(prepared), false);
	} finally {
		if (prepared) await closePreparedReviewBrief(prepared);
		await finalContext.close();
	}
	const retry = await openReviewFsTransaction("review retained final replacement retry");
	let retried;
	try {
		retried = await prepareReviewBriefSettlement(retry, request);
		assert.equal(retried.state, "retained");
		assert.equal(await settlePreparedReviewBrief(retried), true);
	} finally {
		if (retried) await closePreparedReviewBrief(retried);
		await retry.close();
	}
});

function replaceReviewFixtureFile(filePath, content) {
	const original = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		fs.rmSync(filePath);
		fs.writeFileSync(filePath, content, { mode: 0o600 });
	} finally {
		fs.closeSync(original);
	}
}

function assertReviewFixtureInodeChanged(request, filePath) {
	const captured = request.privateState.artifacts[path.basename(filePath)];
	const current = fs.lstatSync(filePath, { bigint: true });
	const capturedDevice = captured.identity?.volume ?? captured.dev;
	const capturedFile = captured.identity?.fileId ?? captured.ino;
	assert.notEqual(
		`${current.dev}:${current.ino}`,
		`${capturedDevice}:${capturedFile}`,
		"replacement fixture must not reuse the captured inode",
	);
}

/** A codex stand-in: writes the canned last message and exits. */
function stubCodex(lastMessage, exitCode = 0) {
	const bin = path.join(tmpDir(), "codex-stub");
	const quoted = `'${lastMessage.replaceAll("'", `'\\''`)}'`;
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf '%s' ${quoted} > "$out"
exit ${exitCode}
`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

function capturingCodex(lastMessage, capturePath) {
	const bin = path.join(tmpDir(), "codex-capturing-stub");
	const quotedMessage = `'${lastMessage.replaceAll("'", `'\\''`)}'`;
	const quotedCapture = `'${capturePath.replaceAll("'", `'\\''`)}'`;
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > ${quotedCapture}
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf '%s' ${quotedMessage} > "$out"
`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

const envWith = (bin) => ({ ...process.env, STDD_CODEX_BIN: bin });

function planMutationTrapEnv(dir, mode) {
	const hookPath = path.join(tmpDir(), `review-plan-${mode}-trap.mjs`);
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const mode = ${JSON.stringify(mode)};
const planPath = ${JSON.stringify(planPath)};
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;

fs.writeFileSync = function (target, ...args) {
  if (mode === "write" && String(target) === planPath) {
    throw new Error("injected plan write failure");
  }
  return originalWrite.call(this, target, ...args);
};

fs.renameSync = function (source, target, ...args) {
  if (mode === "rename" && (String(source) === planPath || String(target) === planPath)) {
    throw new Error("injected plan rename failure");
  }
  return originalRename.call(this, source, target, ...args);
};
`,
	);
	return { NODE_OPTIONS: `--import=${hookPath}` };
}

function killAfterApprovalAppendEnv(dir) {
	const hookPath = path.join(tmpDir(), "review-kill-after-approval.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const originalRename = fs.renameSync;
const ledger = ${JSON.stringify(path.join(dir, ".stdd", "ledger.jsonl"))};
let killed = false;
fs.renameSync = function (source, target, ...args) {
  const value = originalRename.call(this, source, target, ...args);
  if (!killed && /stdd-ledger-[0-9a-f]+.lock/.test(String(source)) &&
      fs.existsSync(ledger) && fs.readFileSync(ledger, "utf8").includes('"event":"review"')) {
    killed = true;
    process.kill(process.pid, "SIGKILL");
  }
  return value;
};
`,
	);
	return { NODE_OPTIONS: `--import=${hookPath}` };
}

function changePlanAtVerdictLockEnv(resultPath, planPath) {
	const hookPath = path.join(tmpDir(), "review-change-plan-at-verdict-lock.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const resultPath = ${JSON.stringify(resultPath)};
const planPath = ${JSON.stringify(planPath)};
const originalRead = fs.readFileSync;
const originalLink = fs.linkSync;
let resultRead = false;
let snapshotRead = false;
let changed = false;

fs.readFileSync = function (target, ...args) {
  const value = originalRead.call(this, target, ...args);
  if (String(target) === resultPath) resultRead = true;
  if (resultRead && String(target) === planPath) snapshotRead = true;
  return value;
};

fs.linkSync = function (source, target, ...args) {
  if (!changed && snapshotRead && /stdd-ledger-[0-9a-f]+\\.lock$/.test(String(target))) {
    changed = true;
    fs.appendFileSync(planPath, "- [ ] injected after final snapshot\\n");
  }
  return originalLink.call(this, source, target, ...args);
};
`,
	);
	return { NODE_OPTIONS: `--import=${hookPath}` };
}

test("review --via codex: approved verdict is recorded and closes the [review:] item", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const events = readLedger(dir);
	const request = events.find((e) => e.event === "review-request");
	const review = events.find((e) => e.event === "review");
	assert.equal(request.via, "codex");
	assert.match(request.brief, /^sha256:/);
	assert.equal(review.verdict, "approved");
	assert.equal(review.request, request.id);
	assert.equal(review.snapshot, request.snapshot);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review \[review:\]/);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
	assert.equal(status.plan.next, null);
});

for (const { via, envName } of [
	{ via: "codex", envName: "STDD_CODEX_BIN" },
	{ via: "claude", envName: "STDD_CLAUDE_BIN" },
]) {
	test(`review --via ${via} rejects a control-bearing ${envName} before allocating state`, async () => {
		const { dir } = await tmpGitRepo();
		const privateTmp = tmpDir();
		const marker = `FORGED_${via.toUpperCase()}_RUNNER`;
		const reviewed = await run(["review", "--via", via], {
			cwd: dir,
			env: {
				...process.env,
				TMPDIR: privateTmp,
				[envName]: `/printable/prefix\n${marker}`,
			},
		});

		assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
		assert.match(reviewed.stderr, new RegExp(`${envName} must be a non-empty single printable line`));
		assert.doesNotMatch(`${reviewed.stdout}${reviewed.stderr}`, new RegExp(marker));
		assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "no request was recorded");
		assert.deepEqual(fs.readdirSync(privateTmp), [], "no private brief was allocated");
	});
}

test("review accepts a printable runner path containing spaces and Unicode", async () => {
	const { dir } = await tmpGitRepo();
	const original = stubCodex('{"summary": "sound", "findings": []}');
	const bin = path.join(path.dirname(original), "codex runner über 👩‍💻");
	fs.renameSync(original, bin);

	const reviewed = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});

	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
	const event = readLedger(dir).find((candidate) => candidate.event === "review");
	assert.equal(event.runner.command, `${bin} exec --sandbox read-only`);
});

test("approval closes from the ledger without writing or renaming the plan", async () => {
	for (const mode of ["write", "rename"]) {
		const { dir } = await tmpGitRepo();
		const planPath = path.join(dir, ".stdd", "plan.md");
		const before = fs.readFileSync(planPath, "utf8");
		const bin = stubCodex('{"summary": "sound", "findings": []}');
		const res = await run(["review", "--via", "codex"], {
			cwd: dir,
			env: { ...envWith(bin), ...planMutationTrapEnv(dir, mode) },
		});
		assert.equal(res.code, 0, `${mode}: ${res.stdout}${res.stderr}`);
		assert.equal(fs.readFileSync(planPath, "utf8"), before, mode);
		const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
		assert.equal(status.plan.review.done, true, mode);
		assert.equal(status.plan.next, null, mode);
		const gate = await run(["status", "--gate"], { cwd: dir });
		assert.equal(gate.code, 0, `${mode}: ${gate.stdout}${gate.stderr}`);
	}
});

test("a kill immediately after the approval append still leaves one closed ledger-derived item", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	const before = fs.readFileSync(planPath, "utf8");
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	let killed;
	try {
		await exec("node", [CLI, "review", "--via", "codex"], {
			cwd: dir,
			env: { ...envWith(bin), ...killAfterApprovalAppendEnv(dir) },
		});
	} catch (err) {
		killed = err;
	}
	assert.equal(killed?.signal, "SIGKILL");
	assert.equal(fs.readFileSync(planPath, "utf8"), before);
	assert.equal(
		readLedger(dir)
			.filter((event) => event.event === "review")
			.at(-1).verdict,
		"approved",
	);

	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
	assert.equal(status.plan.next, null);
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
	const recovered = await run(["note", "recover killed review lock"], { cwd: dir });
	assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
});

test("review excludes a plan that predates the active task", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# Previous task\n\n- [ ] NEVER_INCLUDE_THIS_OLD_PLAN\n",
	);
	const started = await run(["task", "start", "new review scope"], {
		cwd: dir,
	});
	assert.equal(started.code, 0, started.stdout + started.stderr);

	const capturePath = path.join(tmpDir(), "review-brief.md");
	const bin = capturingCodex('{"summary": "sound", "findings": []}', capturePath);
	const reviewed = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);

	const brief = fs.readFileSync(capturePath, "utf8");
	assert.doesNotMatch(brief, /NEVER_INCLUDE_THIS_OLD_PLAN/);
	assert.match(brief, /\(no plan for the active task\)/);
});

test("a fresh approval without a current plan advances status to evidence", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "small planless change"], { cwd: dir });
	fs.rmSync(path.join(dir, ".stdd", "plan.md"));
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);

	const fakeBin = tmpDir();
	fs.writeFileSync(path.join(fakeBin, "gh"), '#!/bin/sh\necho "no pull requests found" >&2; exit 1\n', {
		mode: 0o755,
	});
	const status = JSON.parse(
		(
			await run(["status", "--json"], {
				cwd: dir,
				env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
			})
		).stdout,
	);
	assert.equal(status.plan.present, false);
	assert.equal(status.review.verdict, "approved");
	assert.match(status.next, /draft the evidence line/);
	assert.doesNotMatch(status.next, /fresh reviewer|stdd review/);
});

test("editing only a pre-task plan checkbox stales an approval that excluded the plan", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(planPath, "# Previous task\n\n- [ ] old checkbox\n");
	await run(["task", "start", "new review scope"], { cwd: dir });
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);

	fs.writeFileSync(planPath, "# Previous task\n\n- [x] old checkbox\n");
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 1);
	assert.match(gate.stdout, /stale/);
});

test("review --via codex: a blocking finding means changes-requested, exit 1, item stays open", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const bin = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "changes-requested");
	assert.equal(review.findings.length, 1);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review \[review:\]/);
	const local = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(local.next, /review/i, "local session routing prioritizes the failed closing review");
	assert.doesNotMatch(local.next, /draft the evidence/i);
	fs.rmSync(path.join(dir, ".stdd", "plan.md"));
	const withoutPlan = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(withoutPlan.next, /review/i);
	assert.doesNotMatch(
		withoutPlan.next,
		/draft the evidence/i,
		"a failed or stale review never routes to evidence even without a plan item",
	);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities = { subagents: false, crossCli: false, worktrees: false };
	config.review = { via: "subagent", maxRounds: 0 };
	fs.writeFileSync(configPath, JSON.stringify(config));
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const routeDisabled = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(routeDisabled.next, /review/i);
	assert.match(routeDisabled.next, /enable.*capabilit|compatible.*route/i);
	assert.doesNotMatch(routeDisabled.next, /draft the evidence/i);
});

test("status fixes changes-requested findings before spending another review round", async () => {
	const { dir } = await tmpGitRepo(ALL_CAPS, { via: "codex", maxRounds: 2 });
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const bin = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const review = await run(["review"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(review.code, 1, review.stdout + review.stderr);

	const assertFixesBeforeReview = (next) => {
		const fix = next.indexOf("fix the 1 review finding(s)");
		const rerun = next.search(/run `stdd review(?: --force --reason "<why>")?`/);
		assert.ok(fix >= 0, `expected findings-first guidance, got: ${next}`);
		assert.ok(rerun > fix, `expected review only after the fix, got: ${next}`);
		assert.doesNotMatch(next, /closing review closes|checked but the review is unproven/);
	};

	const open = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(open.next);

	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.review.maxRounds = 1;
	fs.writeFileSync(configPath, JSON.stringify(config));
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const exhausted = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(exhausted.next);
	assert.match(exhausted.next, /`stdd review --force --reason "<why>"`/);
	assert.doesNotMatch(exhausted.next, /`stdd review` again/);

	config.capabilities = { subagents: false, crossCli: false, worktrees: true };
	fs.writeFileSync(configPath, JSON.stringify(config));
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const disabled = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(disabled.next);
	assert.match(disabled.next, /enable a compatible review capability\/route/);
	assert.match(disabled.next, /`stdd review --force --reason "<why>"`/);

	const planPath = path.join(dir, ".stdd", "plan.md");
	const plan = fs.readFileSync(planPath, "utf8");
	fs.writeFileSync(planPath, plan.replace("- [ ] closing review", "- [x] closing review"));
	const falselyChecked = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assertFixesBeforeReview(falselyChecked.next);
});

test("status repairs an errored closing review before generic review-plan guidance", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "not-applicable", "--reason", "implementation-only fixture"], { cwd: dir });
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const malformed = stubCodex("not json");
	const review = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(malformed),
	});
	assert.equal(review.code, 2, review.stdout + review.stderr);

	const errored = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(errored.next, /repair the stale or errored closing review/);
	assert.doesNotMatch(errored.next, /closing review closes/);

	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [ ] adjust implementation\n- [ ] closing review [review:]\n",
	);
	const unfinishedPlan = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.match(unfinishedPlan.next, /continue the plan.*adjust implementation/);
	assert.doesNotMatch(unfinishedPlan.next, /repair the stale or errored closing review/);
});

test("review --via codex: malformed reviewer output is an error, never an approval", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex("LGTM, ship it");
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
});

test("review --via codex: a failing runner is an error verdict", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "ok", "findings": []}', 3);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 2);
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("review --via codex never reads a replaced last-message symlink", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "foreign-review-output.json");
	fs.writeFileSync(outside, '{"summary":"foreign","findings":[]}');
	const bin = path.join(tmpDir(), "codex-output-symlink-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
rm -f "$out"
ln -s ${JSON.stringify(outside)} "$out"
`,
	);
	fs.chmodSync(bin, 0o755);

	const reviewed = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});

	assert.equal(reviewed.code, 2, reviewed.stdout + reviewed.stderr);
	assert.match(reviewed.stderr, /output artifact changed identity|unsafe/i);
	assert.equal(fs.readFileSync(outside, "utf8"), '{"summary":"foreign","findings":[]}');
	const request = readLedger(dir).find((event) => event.event === "review-request");
	assert.ok(
		fs.lstatSync(path.join(path.dirname(request.briefPath), "last-message.txt")).isSymbolicLink(),
	);
	assert.equal(
		readLedger(dir).find((event) => event.event === "review" && event.request === request.id).verdict,
		"error",
	);
});

test("review --via codex without the crossCli capability fails without recording", async () => {
	const { dir } = await tmpGitRepo({
		subagents: true,
		crossCli: false,
		worktrees: true,
	});
	const res = await run(["review", "--via", "codex"], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /crossCli/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")));
});

test("review --via subagent prepares the brief; --result grades it against the open request", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.ok(briefPath && fs.existsSync(briefPath), prep.stdout);
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /## Plan/);
	assert.match(brief, /## Changed files/);
	assert.match(brief, /^M\timpl\.js$/m, "the manifest names every changed file");
	assert.match(brief, /## Diff/);
	assert.match(brief, /closing review \[review:\]/);
	assert.match(brief, /export const v = 2/);

	const expectedOutputContract = `Respond with ONLY one JSON object, no prose around it:
{"summary": "<non-empty printable single line>", "findings": [{"severity": "blocking" | "advisory", "path": "<non-empty printable single line>" | null, "line": <positive safe integer or null>, "message": "<non-empty printable single line>"}]}
\`summary\` and every finding's required \`message\` must be non-empty printable single lines; ordinary Unicode, including ZWNJ/ZWJ and emoji, remains valid.
Each finding has \`severity: blocking | advisory\`, \`path\` absent or null or a non-empty printable single line, and \`line\` absent or null or a positive safe integer.
For a control-bearing repository path that cannot cross this inline boundary, omit \`path\` rather than emitting unsafe text. Any wrong field type or output shape invalidates the whole result.
An empty findings array means the change is sound.`;
	const outputContract = brief
		.slice(brief.indexOf("Respond with ONLY one JSON object"), brief.indexOf("## Code quality rubric"))
		.trim();
	assert.equal(outputContract, expectedOutputContract);

	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "approved");
	assert.equal(review.via, "subagent");
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review \[review:\]/);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("reviewer-controlled result text cannot inject the ledger or terminal output", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			summary: "summary\nFORGED_SUMMARY_LINE",
			findings: [
				{
					severity: "blocking",
					path: "impl.js\u001b[2JFORGED_PATH",
					line: 0,
					message: "finding\nFORGED_TERMINAL_LINE",
				},
			],
		}),
	);

	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr);
	assert.doesNotMatch(`${res.stdout}${res.stderr}`, /FORGED_/);
	assert.ok(!`${res.stdout}${res.stderr}`.includes("\u001b[2J"));
	const ledgerText = fs.readFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "utf8");
	assert.doesNotMatch(ledgerText, /FORGED_/);
	const review = readLedger(dir).find((event) => event.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /malformed reviewer output/);
	assert.equal(review.summary, undefined);
	assert.equal(review.findings, undefined);
});

test("printable reviewer fields persist and print without coercion", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const resultPath = path.join(tmpDir(), "result.json");
	const expected = {
		summary: "Unicode summary ✅",
		findings: [
			{
				severity: "blocking",
				path: "src/über\u200cname.js",
				line: Number.MAX_SAFE_INTEGER,
				message: "Unicode message 👩‍💻",
			},
		],
	};
	fs.writeFileSync(resultPath, JSON.stringify(expected));

	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(
		res.stdout,
		new RegExp(`src/über\u200cname\\.js:${Number.MAX_SAFE_INTEGER} — Unicode message 👩‍💻`),
	);
	const review = readLedger(dir).find((event) => event.event === "review");
	assert.equal(review.summary, expected.summary);
	assert.deepEqual(review.findings, expected.findings);
});

test("review --result with a changed checkout records a stale error", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 3;\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /stale/);
});

test("--timeout rejects non-integer and out-of-range values before any side effect", async () => {
	const { dir } = await tmpGitRepo();
	for (const bad of ["1.5", "0", "-3", "1e9", "nope"]) {
		const res = await run(["review", "--via", "codex", "--timeout", bad], {
			cwd: dir,
		});
		assert.equal(res.code, 1, `--timeout ${bad} must fail at parse time`);
		assert.match(res.stderr, /--timeout/);
	}
	assert.ok(
		!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")),
		"no request may be recorded for an invalid flag",
	);
});

test("review --cleanup rejects every dispatch-only flag before cleanup", async () => {
	const expected =
		"stdd: --cleanup cancels open review requests and cannot be combined with dispatch flags\n";
	for (const dispatchArgs of [
		["--timeout", "1"],
		["--via", "codex"],
		["--force"],
		["--reason", "why"],
	]) {
		const { dir } = await tmpGitRepo();
		const res = await run(["review", "--cleanup", ...dispatchArgs], { cwd: dir });
		assert.equal(res.code, 1, dispatchArgs.join(" "));
		assert.equal(res.stderr, expected, dispatchArgs.join(" "));
	}
});

test("review --result rejects every dispatch-only flag before reading the result", async () => {
	const cases = [
		{
			args: ["--timeout", "1"],
			expected:
				"stdd: --result grades an existing request — --timeout, --force, and --reason belong to the dispatch call\n",
		},
		{
			args: ["--via", "codex"],
			expected: "stdd: --result grades an existing request — --via belongs to the dispatch call\n",
		},
		{
			args: ["--force"],
			expected:
				"stdd: --result grades an existing request — --timeout, --force, and --reason belong to the dispatch call\n",
		},
		{
			args: ["--reason", "why"],
			expected:
				"stdd: --result grades an existing request — --timeout, --force, and --reason belong to the dispatch call\n",
		},
	];
	for (const { args, expected } of cases) {
		const { dir } = await tmpGitRepo();
		const missingResult = path.join(dir, "missing-result.json");
		const res = await run(["review", "--result", missingResult, ...args], { cwd: dir });
		assert.equal(res.code, 1, args.join(" "));
		assert.equal(res.stderr, expected, args.join(" "));
	}
});

test("review rejects an idle task before creating a private brief", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "finished task"], { cwd: dir });
	await run(["task", "finish"], { cwd: dir });
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-idle-"));

	const res = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: privateTmp },
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /no active task/);
	assert.deepEqual(fs.readdirSync(privateTmp), [], "no source-bearing temp directory is allocated");
});

test("a task switch after review capture records no request and reports no subagent success", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-request-task-race-"));
	const hookPath = path.join(tmpDir(), "switch-task-before-request.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const originalLink = fs.linkSync;
let switched = false;
fs.linkSync = function (source, target, ...args) {
  if (!switched && /stdd-ledger-[0-9a-f]+\\.lock$/.test(String(target))) {
    switched = true;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    for (const command of [["task", "finish"], ["task", "start", "replacement task"]]) {
      const run = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...command], {
        cwd: ${JSON.stringify(dir)},
        env,
        encoding: "utf8",
      });
      if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    }
  }
  return originalLink.call(this, source, target, ...args);
};
`,
	);

	const reviewed = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			TMPDIR: privateTmp,
		},
	});
	assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
	assert.match(reviewed.stderr, /active task changed/i);
	assert.doesNotMatch(reviewed.stdout, /brief written|dispatch a fresh/i);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-request"));
	assertAbortedReviewSettled(privateTmp);
});

test("a branch switch after review capture records no request and reports no subagent success", async () => {
	const { dir } = await tmpGitRepo();
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-request-branch-race-"));
	const hookPath = path.join(tmpDir(), "switch-branch-before-request.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const originalLink = fs.linkSync;
let switched = false;
fs.linkSync = function (source, target, ...args) {
  if (!switched && /stdd-ledger-[0-9a-f]+\\.lock$/.test(String(target))) {
    switched = true;
    const run = spawnSync("git", ["-C", ${JSON.stringify(dir)}, "checkout", "-qb", "hijack"], {
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
  }
  return originalLink.call(this, source, target, ...args);
};
`,
	);

	const reviewed = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${hookPath}`,
			TMPDIR: privateTmp,
		},
	});
	assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
	assert.match(reviewed.stderr, /switched branches/i);
	assert.doesNotMatch(reviewed.stdout, /brief written|dispatch a fresh/i);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.ok(
		!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
	);
	assertAbortedReviewSettled(privateTmp);
});

test("review rejects an empty clean-base legacy scope before creating a request", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("checkout", "-q", "main");
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.state, "legacy");
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-empty-clean-base-"));

	const res = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: privateTmp },
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /no active task/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")));
	assert.deepEqual(fs.readdirSync(privateTmp), []);
});

test("review rejects clean-base legacy state before creating an invisible request", async () => {
	const { dir, git } = await tmpGitRepo();
	await git("checkout", "-q", "main");
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			branch: "main",
			event: "note",
			text: "legacy residue",
		})}\n`,
	);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.state, "idle");
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-clean-base-"));

	const res = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: privateTmp },
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /no active task/);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-request"));
	assert.deepEqual(fs.readdirSync(privateTmp), []);
});

test("review --result without an open request fails", async () => {
	const { dir } = await tmpGitRepo();
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "?", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /no open review request/);
});

test("appending ledger events between request and result does not go stale", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	await run(["note", "worker finished"], { cwd: dir });
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 0, res.stdout + res.stderr);
});

test("status --gate: changes-requested fails, approval passes, checked-but-unproven fails", async () => {
	const { dir } = await tmpGitRepo();
	// checked review item, no recorded review at all
	fs.writeFileSync(
		path.join(dir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const unproven = await run(["status", "--gate"], { cwd: dir });
	assert.equal(unproven.code, 1, unproven.stdout);
	assert.match(unproven.stdout, /checked but/i);

	const blocking = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(blocking) });
	const changes = await run(["status", "--gate"], { cwd: dir });
	assert.equal(changes.code, 1);
	assert.match(changes.stdout, /requested changes/i);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	// the approval goes stale as soon as the reviewed work changes
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 4;\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1);
	assert.match(stale.stdout, /stale/i);
});

test("status gate and Stop allow every capability profile when no review is claimed", async () => {
	for (const { name, capabilities, via } of [
		{
			name: "none",
			capabilities: { subagents: false, crossCli: false, worktrees: true },
			via: "subagent",
		},
		{
			name: "subagents",
			capabilities: { subagents: true, crossCli: false, worktrees: true },
			via: "subagent",
		},
		{
			name: "crossCli",
			capabilities: { subagents: false, crossCli: true, worktrees: true },
			via: "codex",
		},
		{ name: "both", capabilities: ALL_CAPS, via: "codex" },
	]) {
		const { dir } = await tmpGitRepo(capabilities, { via });
		fs.writeFileSync(path.join(dir, ".stdd", "plan.md"), "# P\n\n- [x] impl\n- [ ] verify\n");

		const gate = await run(["status", "--gate"], { cwd: dir });
		assert.equal(gate.code, 0, `${name}: ${gate.stdout}${gate.stderr}`);

		const stop = spawnSync(process.execPath, [CLI, "stop-hook"], {
			cwd: dir,
			input: '{"stop_hook_active":false}',
			encoding: "utf8",
		});
		assert.equal(stop.status, 0, `${name}: ${stop.stdout}${stop.stderr}`);
	}
});

test("status gate still rejects unavailable routes needed by a claim or open request", async () => {
	const capabilities = { subagents: false, crossCli: false, worktrees: true };

	const { dir: claimedDir } = await tmpGitRepo(capabilities, { via: "subagent" });
	fs.writeFileSync(
		path.join(claimedDir, ".stdd", "plan.md"),
		"# P\n\n- [x] impl\n- [x] closing review [review:]\n",
	);
	const claimed = await run(["status", "--gate"], { cwd: claimedDir });
	assert.equal(claimed.code, 1, claimed.stdout + claimed.stderr);
	assert.match(claimed.stdout, /subagents capability is off/i);
	const claimedStop = spawnSync(process.execPath, [CLI, "stop-hook"], {
		cwd: claimedDir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(claimedStop.status, 2, claimedStop.stdout + claimedStop.stderr);
	assert.match(claimedStop.stderr, /subagents capability is off/i);

	const { dir: requestedDir } = await tmpGitRepo(capabilities, { via: "subagent" });
	fs.writeFileSync(path.join(requestedDir, ".stdd", "plan.md"), "# P\n\n- [x] impl\n");
	fs.writeFileSync(
		path.join(requestedDir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id: "rev-12345678",
			via: "subagent",
			snapshot: "snapshot",
			briefHash: "hash",
			briefPath: path.join(tmpDir(), "brief.md"),
			branch: "feature",
		})}\n`,
	);
	const requested = await run(["status", "--gate"], { cwd: requestedDir });
	assert.equal(requested.code, 1, requested.stdout + requested.stderr);
	assert.match(requested.stdout, /open review request.*subagents capability is off/i);
	const requestedStop = spawnSync(process.execPath, [CLI, "stop-hook"], {
		cwd: requestedDir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(requestedStop.status, 2, requestedStop.stdout + requestedStop.stderr);
	assert.match(requestedStop.stderr, /open review request.*subagents capability is off/i);
});

test("malformed non-boundary branches cannot hide a newer changes-requested review", async () => {
	for (const { branchMetadata, invalid } of [
		{ branchMetadata: {}, invalid: true },
		{ branchMetadata: { branch: "feature\nforged" }, invalid: true },
		{ branchMetadata: { branch: "other" }, invalid: false },
	]) {
		const { dir } = await tmpGitRepo();
		const clean = stubCodex('{"summary": "sound", "findings": []}');
		const approved = await run(["review", "--via", "codex"], {
			cwd: dir,
			env: envWith(clean),
		});
		assert.equal(approved.code, 0, approved.stdout + approved.stderr);
		assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);

		fs.appendFileSync(
			path.join(dir, ".stdd", "ledger.jsonl"),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				event: "review",
				verdict: "changes-requested",
				via: "codex",
				snapshot: "newer-review",
				summary: "blocking",
				findings: [
					{
						severity: "blocking",
						path: "impl.js",
						line: 1,
						message: "newest review blocks",
					},
				],
				...branchMetadata,
			})}\n`,
		);

		const gate = await run(["status", "--gate"], { cwd: dir });
		assert.equal(gate.code, invalid ? 1 : 0, gate.stdout + gate.stderr);
		if (invalid) {
			assert.match(gate.stdout, /malformed task boundary/i);
			assert.match(gate.stdout, /repair.*ledger\.jsonl/i);
		}
	}
});

test("status --gate and Stop hooks block malformed task state without crashing on primitive events", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), "null\n");

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 1, gate.stdout + gate.stderr);
	assert.match(gate.stdout, /malformed task boundary/i);
	assert.match(gate.stdout, /repair.*ledger\.jsonl/i);

	const claude = spawnSync(process.execPath, [CLI, "stop-hook"], {
		cwd: dir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(claude.status, 2, claude.stdout + claude.stderr);
	assert.match(claude.stderr, /malformed task boundary/i);
	assert.match(claude.stderr, /repair.*ledger\.jsonl/i);

	const codex = spawnSync(process.execPath, [CLI, "stop-hook", "--agent", "codex"], {
		cwd: dir,
		input: '{"stop_hook_active":false}',
		encoding: "utf8",
	});
	assert.equal(codex.status, 0, codex.stdout + codex.stderr);
	const decision = JSON.parse(codex.stdout);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /malformed task boundary/i);
	assert.match(decision.reason, /repair.*ledger\.jsonl/i);
});

test("status, gate, and Stop classify malformed ledger event payloads as invalid", async (t) => {
	for (const scenario of [
		{
			name: "docs.paths",
			event: {
				event: "docs",
				decision: "checked",
				paths: { 0: "docs/domain/pricing.md", length: 1 },
				reason: "malformed array lookalike",
				snapshot: "snapshot",
			},
		},
		{
			name: "review.findings",
			event: {
				event: "review",
				request: "rev-12345678",
				via: "codex",
				verdict: "changes-requested",
				snapshot: "snapshot",
				summary: "malformed findings",
				findings: {
					severity: "blocking",
					path: "impl.js",
					line: 1,
					message: "must be an array",
				},
			},
		},
	]) {
		await t.test(scenario.name, async () => {
			const { dir } = await tmpGitRepo();
			const started = await run(["task", "start", "malformed ledger payload"], { cwd: dir });
			assert.equal(started.code, 0, started.stdout + started.stderr);
			const taskId = readLedger(dir).find((event) => event.event === "task-start").id;
			fs.appendFileSync(
				path.join(dir, ".stdd", "ledger.jsonl"),
				`${JSON.stringify({
					ts: new Date().toISOString(),
					branch: "feature",
					taskId,
					...scenario.event,
				})}\n`,
			);

			const status = await run(["status", "--local", "--json"], { cwd: dir });
			assert.equal(status.code, 0, status.stdout + status.stderr);
			const parsedStatus = JSON.parse(status.stdout);
			assert.equal(parsedStatus.state, "invalid");
			assert.match(parsedStatus.next, /repair.*malformed.*ledger/i);

			const gate = await run(["status", "--gate"], { cwd: dir });
			assert.equal(gate.code, 1, gate.stdout + gate.stderr);
			assert.match(gate.stdout, /malformed task boundary/i);
			assert.match(gate.stdout, /repair.*ledger\.jsonl/i);

			const claude = spawnSync(process.execPath, [CLI, "stop-hook"], {
				cwd: dir,
				input: '{"stop_hook_active":false}',
				encoding: "utf8",
			});
			assert.equal(claude.status, 2, claude.stdout + claude.stderr);
			assert.match(claude.stderr, /malformed task boundary/i);

			const codex = spawnSync(process.execPath, [CLI, "stop-hook", "--agent", "codex"], {
				cwd: dir,
				input: '{"stop_hook_active":false}',
				encoding: "utf8",
			});
			assert.equal(codex.status, 0, codex.stdout + codex.stderr);
			const decision = JSON.parse(codex.stdout);
			assert.equal(decision.decision, "block");
			assert.match(decision.reason, /malformed task boundary/i);
		});
	}
});

test("editing the plan after ledger-derived approval stales it", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);
	fs.appendFileSync(path.join(dir, ".stdd", "plan.md"), "- [ ] a new scope item\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the reviewer never saw the current specification");
	assert.match(stale.stdout, /stale/i);
});

// A commit moves no bytes in the working tree, so it cannot change what the
// reviewer graded. Only the content it read may stale its verdict.
test("committing the reviewed work does not stale its approval", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 3;\n");
	fs.writeFileSync(path.join(dir, "added.js"), "export const added = true;\n");

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	await git("add", "impl.js", "added.js");
	await git("commit", "-qm", "the reviewed work");
	const after = await run(["status", "--gate"], { cwd: dir });
	assert.equal(after.code, 0, `a commit moves no bytes in the working tree: ${after.stdout}`);
});

test("editing the reviewed work after a commit stales the approval", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 3;\n");

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	await git("add", "impl.js");
	await git("commit", "-qm", "the reviewed work");

	fs.appendFileSync(path.join(dir, "impl.js"), "// a rule the reviewer never saw\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "editing the reviewed bytes still reopens the review");
	assert.match(stale.stdout, /stale/i);
});

// The method sends a post-approval finding to `stdd defer` instead of an edit.
// If deferring staled the approval, the prescribed move would destroy the thing
// it exists to protect.
test("recording a scope cut with stdd defer does not stale an approval", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.rmSync(planPath);
	await run(["task", "start", "deferring after approval"], { cwd: dir });
	fs.writeFileSync(planPath, "# P\n\n- [x] impl\n- [ ] closing review [review:]\n");

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	const deferred = await run(["defer", "a cut found after approval"], { cwd: dir });
	assert.equal(deferred.code, 0, deferred.stdout + deferred.stderr);
	const after = await run(["status", "--gate"], { cwd: dir });
	assert.equal(after.code, 0, `deferring is not editing the specification: ${after.stdout}`);
});

// Rename detection reads the index: unstaged, a rename is a deletion plus an
// untracked file; staged, it collapses to the destination. The snapshot must
// see the same two paths either way.
test("staging a rename does not stale an approval", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.renameSync(path.join(dir, "impl.js"), path.join(dir, "renamed.js"));

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	await git("add", "-A", "--", "impl.js", "renamed.js");
	const staged = await run(["status", "--gate"], { cwd: dir });
	assert.equal(staged.code, 0, `the same two paths, the same bytes: ${staged.stdout}`);

	await git("commit", "-qm", "rename the module");
	const committed = await run(["status", "--gate"], { cwd: dir });
	assert.equal(committed.code, 0, `committing it changes nothing either: ${committed.stdout}`);
});

// The plan is a file a human edits, so it may carry CRLF endings. Normalizing
// them only on the branch that finds a Deferred section would make the very
// first `stdd defer` look like an edit.
test("a CRLF plan survives its first recorded scope cut", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.rmSync(planPath);
	await run(["task", "start", "a plan with CRLF endings"], { cwd: dir });
	fs.writeFileSync(planPath, "# P\r\n\r\n- [ ] closing review [review:]\r\n");

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	await run(["defer", "the first cut on a CRLF plan"], { cwd: dir });
	const after = await run(["status", "--gate"], { cwd: dir });
	assert.equal(after.code, 0, `line endings are not specification: ${after.stdout}`);
});

// Creating the section on a plan that ends without a newline makes the writer
// add one. That separator is punctuation, not specification.
test("a plan with no final newline survives its first recorded scope cut", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.rmSync(planPath);
	await run(["task", "start", "a plan with no final newline"], { cwd: dir });
	fs.writeFileSync(planPath, "# P\n\n- [ ] closing review [review:]");

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	await run(["defer", "the first cut on a plan with no final newline"], { cwd: dir });
	const after = await run(["status", "--gate"], { cwd: dir });
	assert.equal(after.code, 0, `a separating newline is not specification: ${after.stdout}`);

	// above the Deferred heading, so this lands in the specification itself
	fs.writeFileSync(
		planPath,
		fs
			.readFileSync(planPath, "utf8")
			.replace(
				"- [ ] closing review [review:]",
				"- [ ] a rule the reviewer never saw\n- [ ] closing review [review:]",
			),
	);
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "an added specification line is still an edit");
});

// Git stores exactly 100644 or 100755 and derives that from the owner execute
// bit alone. The snapshot must compare what git records, no more and no less.
test("a reviewed file's mode counts only the owner execute bit", {
	skip: process.platform === "win32" && "POSIX file modes",
}, async () => {
	const { dir } = await tmpGitRepo();
	const impl = path.join(dir, "impl.js");
	fs.chmodSync(impl, 0o644);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	fs.chmodSync(impl, 0o655); // group and other execute — git records neither
	const ignored = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ignored.code, 0, `git stores no group or other execute bit: ${ignored.stdout}`);

	fs.chmodSync(impl, 0o755); // owner execute — this is 100755
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the reviewed file is executable now and was not before");
	assert.match(stale.stdout, /stale/i);
});

// A gitlink differs from base by the commit it points at. No filesystem
// fingerprint of the directory can see that, so the snapshot reads git's raw
// record for it.
test("a submodule is snapshotted by its pointer, not its directory metadata", async () => {
	const { dir, git } = await tmpGitRepo();
	const sub = tmpDir();
	const subGit = (...args) =>
		exec("git", ["-C", sub, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
	await subGit("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(sub, "dep.js"), "export const dep = 1;\n");
	await subGit("add", ".");
	await subGit("commit", "-qm", "first");
	const first = (await subGit("rev-parse", "HEAD")).stdout.trim();
	fs.writeFileSync(path.join(sub, "dep.js"), "export const dep = 2;\n");
	await subGit("commit", "-qam", "second");

	await git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor");
	await git("commit", "-qm", "vendor the dependency");

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const approved = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(approved.code, 0, approved.stdout + approved.stderr);
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	// Touching the directory changes its metadata and nothing else. A snapshot
	// that fingerprinted the directory instead of the pointer would call this a
	// change; one that reads git's record does not.
	const vendor = path.join(dir, "vendor");
	const later = new Date(Date.now() + 5_000);
	fs.utimesSync(vendor, later, later);
	const untouched = await run(["status", "--gate"], { cwd: dir });
	assert.equal(untouched.code, 0, `the pointer is what counts: ${untouched.stdout}`);

	// The pointer is read from the submodule checkout, so it has one spelling
	// whether or not the superproject has staged it.
	await exec("git", ["-C", vendor, "checkout", "-q", first]);
	await git("add", "vendor");
	await git("commit", "-qm", "move the pointer");
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 2;\n"); // undo the stale edit
	const restaged = await run(["status", "--gate"], { cwd: dir });
	assert.match(restaged.stdout, /stale/i, "the pointer moved, and that is the change");
	assert.equal(restaged.code, 1);
});

// A directory is only a gitlink when git says so. An ordinary one left where a
// tracked file used to be must not resolve through the parent repository.
test("an ordinary directory replacing a tracked file is refused, not read as a gitlink", async () => {
	const { dir } = await tmpGitRepo();
	fs.rmSync(path.join(dir, "impl.js"));
	fs.mkdirSync(path.join(dir, "impl.js"));
	fs.writeFileSync(path.join(dir, "impl.js", "inner.txt"), "not a submodule\n");

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const refused = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.notEqual(refused.code, 0, "a tree that cannot be read is not reviewable");
	assert.match(refused.stderr, /cannot be fingerprinted safely.*impl\.js/i);
});

// The plan is free-form markdown, so `appendDeferred` treats prose between the
// cuts as part of the section and appends after it. The snapshot must normalize
// away exactly that range, or a cut recorded on such a plan still stales.
test("a scope cut recorded after prose in the Deferred section does not stale an approval", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.rmSync(planPath);
	await run(["task", "start", "deferring under prose"], { cwd: dir });
	fs.writeFileSync(
		planPath,
		"# P\n\n- [ ] closing review [review:]\n\n## Deferred\n\nCuts recorded so far:\n\n- an earlier cut\n",
	);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	await run(["defer", "a cut found after approval"], { cwd: dir });
	const after = await run(["status", "--gate"], { cwd: dir });
	assert.equal(after.code, 0, `the writer's whole section is normalized away: ${after.stdout}`);
});

// Only `## Deferred` is bookkeeping. A same-named heading at another level is
// ordinary plan prose and must keep its power to stale.
test("editing bullets under a heading that is not ## Deferred stales an approval", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.rmSync(planPath);
	await run(["task", "start", "a same-named subheading"], { cwd: dir });
	fs.writeFileSync(
		planPath,
		"# P\n\n- [ ] closing review [review:]\n\n### Deferred\n\n- a specification bullet\n",
	);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const ok = await run(["status", "--gate"], { cwd: dir });
	assert.equal(ok.code, 0, ok.stdout);

	fs.appendFileSync(planPath, "- a rule the reviewer never saw\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "a level-3 heading is prose, not the deferred ledger");
	assert.match(stale.stdout, /stale/i);
});

test("a stranded private reset temp does not stale a review snapshot", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const tempPath = path.join(dir, ".stdd", `.ledger-reset-${"b".repeat(32)}.tmp`);
	fs.writeFileSync(tempPath, "interrupted private transaction\n", { mode: 0o600 });

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review.verdict, "approved");
	assert.equal(status.review.stale, false);

	const recovered = await run(["note", "recover stranded reset temp"], { cwd: dir });
	assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
	assert.ok(!fs.existsSync(tempPath));
});

test("exact-name reset artifacts are exempt only with the trusted private-file shape", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const exact = path.join(dir, ".stdd", `.ledger-reset-${"c".repeat(32)}.tmp`);
	const outside = path.join(tmpDir(), "outside");
	fs.writeFileSync(outside, "outside\n");
	const cases = [
		{
			name: "non-private regular file",
			setup: () => fs.writeFileSync(exact, "public\n", { mode: 0o644 }),
			cleanup: () => fs.rmSync(exact),
		},
		{
			name: "symlink",
			setup: () => fs.symlinkSync(outside, exact),
			cleanup: () => fs.rmSync(exact),
		},
		{
			name: "directory",
			setup() {
				fs.mkdirSync(exact);
				fs.writeFileSync(path.join(exact, "child"), "child\n");
			},
			cleanup: () => fs.rmSync(exact, { recursive: true }),
		},
	];
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		cases.push({
			name: "foreign owner",
			setup() {
				fs.writeFileSync(exact, "foreign\n", { mode: 0o600 });
				fs.chownSync(exact, 65534, 65534);
			},
			cleanup: () => fs.rmSync(exact),
		});
	}
	for (const artifact of cases) {
		artifact.setup();
		const stale = await run(["status", "--gate"], { cwd: dir });
		assert.equal(stale.code, 1, `${artifact.name}: ${stale.stdout}${stale.stderr}`);
		assert.match(stale.stdout, /stale/i, artifact.name);
		artifact.cleanup();
		assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0, artifact.name);
	}
});

test("review diff and changed manifest exempt only exact shape-validated ledger temps", async () => {
	const cases = [
		{
			name: `.ledger-prepared-${"d".repeat(32)}.tmp`,
			mode: 0o600,
			visible: false,
		},
		{
			name: `.ledger-recovered-${"d".repeat(31)}.tmp`,
			mode: 0o600,
			visible: true,
		},
		{
			name: `.ledger-recovered-${"e".repeat(32)}.tmp`,
			mode: 0o644,
			visible: true,
		},
	];
	for (const fixture of cases) {
		const { dir, git } = await tmpGitRepo();
		const relative = `.stdd/${fixture.name}`;
		const candidate = path.join(dir, relative);
		fs.writeFileSync(candidate, `review-visible-${fixture.name}\n`, { mode: fixture.mode });
		fs.chmodSync(candidate, fixture.mode);
		await git("add", relative);
		await git("commit", "-qm", `add ${fixture.name}`);

		const prepared = await run(["review", "--via", "subagent"], { cwd: dir });
		assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
		const briefPath = prepared.stdout.match(/brief written to (\S+)/)?.[1];
		const brief = fs.readFileSync(briefPath, "utf8");
		assert.equal(
			brief.includes(fixture.name),
			fixture.visible,
			`${fixture.name} visibility must match its exact basename and private shape`,
		);
	}
});

test("every reset-temp near miss remains visible and stales an approved review", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, ".gitignore"), ".stdd/.ledger-reset-*.tmp\n");
	const initialized = await run(["init", dir, "--tools", "codex"]);
	assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const reviewed = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);

	for (const name of [
		`.ledger-reset-${"a".repeat(31)}.tmp`,
		`.ledger-reset-${"a".repeat(33)}.tmp`,
		`.ledger-reset-${"A".repeat(32)}.tmp`,
		`.ledger-reset-${"g".repeat(32)}.tmp`,
		`.ledger-reset-${"a".repeat(32)}.tmp.extra`,
	]) {
		const candidate = path.join(dir, ".stdd", name);
		fs.writeFileSync(candidate, "near miss\n");
		const stale = await run(["status", "--gate"], { cwd: dir });
		assert.equal(stale.code, 1, `${name}: ${stale.stdout}${stale.stderr}`);
		assert.match(stale.stdout, /stale/i, name);
		fs.rmSync(candidate);
		const restored = await run(["status", "--gate"], { cwd: dir });
		assert.equal(restored.code, 0, `${name}: ${restored.stdout}${restored.stderr}`);
	}
});

test("a committed reset-temp near miss remains in the review diff and manifest", async () => {
	const { dir, git } = await tmpGitRepo();
	const relative = `.stdd/.ledger-reset-${"A".repeat(32)}.tmp`;
	fs.writeFileSync(path.join(dir, relative), "TRACKED_RESET_NEAR_MISS\n");
	await git("add", "-f", relative);
	await git("commit", "-qm", "tracked reset near miss");

	const prepared = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
	const briefPath = prepared.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, new RegExp(relative.replaceAll(".", "\\.")));
	assert.match(brief, /TRACKED_RESET_NEAR_MISS/);
});

test("an unresolvable baseRef aborts the review before recording anything", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({ baseRef: "origin/nowhere", capabilities: ALL_CAPS }),
	);
	const bin = stubCodex('{"summary": "s", "findings": []}');
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /cannot diff/i);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing recorded");
});

test("the brief carries untracked-file contents", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "brand-new.js"), "export const UNTRACKED_MARKER = 42;\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /UNTRACKED_MARKER/);
});

test("the brief carries the quality rubric and names changed governing docs", async () => {
	const { dir, git } = await tmpGitRepo();
	// a canonical doc changed on the branch is the spec delta
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "billing.md"), "# Billing rules\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: billing");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /## Code quality rubric/);
	assert.match(brief, /magic numbers/i);
	assert.match(brief, /type contracts/i);
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/billing\.md/);
});

test("the brief names an untracked governing doc as part of the spec delta", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "draft.md"), "# Draft\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/draft\.md/);
});

test("governing docs survive C-quoting: a non-ASCII doc name is still named", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "платежи.md"), "# Платежи\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: payments");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /- docs\/domain\/платежи\.md/);
	assert.doesNotMatch(brief, /none changed on this branch/);
});

test("governing docs cover renames: both old and new doc paths are named", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "old-name.md"), "# Spec\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: spec");
	await git("checkout", "-q", "main");
	await git("merge", "-q", "--ff-only", "feature");
	await git("checkout", "-q", "feature");
	await git("mv", "docs/domain/old-name.md", "docs/domain/new-name.md");
	await git("commit", "-qm", "docs: rename");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /- docs\/domain\/new-name\.md/);
	assert.match(brief, /- docs\/domain\/old-name\.md/);
});

test("paths with control chars or quotes are presented quoted, never raw", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// a double-quote and a tab are both legal in a Linux pathname; raw
	// interpolation would break the tab-delimited manifest and let a
	// crafted newline inject Markdown into the Governing docs list
	const quoted = 'docs/domain/a"b.md';
	fs.writeFileSync(path.join(dir, "docs", "domain", 'a"b.md'), "# Q\n");
	await git("add", ".");
	await git("commit", "-qm", "docs: quoted");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	// JSON.stringify escapes the quote — the raw path never appears verbatim
	assert.ok(brief.includes(JSON.stringify(quoted)), "governing docs quote the path");
	assert.ok(!brief.includes(`- ${quoted}`), "the raw quote is not interpolated");
});

test("review paths escape every shared non-printable filename scalar", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	const cases = [
		["c1\u0085name.md", "\\u0085"],
		["line\u2028separator.md", "\\u2028"],
		["paragraph\u2029separator.md", "\\u2029"],
		["bidi\u202eoverride.md", "\\u202e"],
		["invisible\u200bspace.md", "\\u200b"],
	];
	for (const [name] of cases) {
		fs.writeFileSync(path.join(dir, "docs", "domain", name), "# Safe display\n");
	}
	await git("add", ".");
	await git("commit", "-qm", "docs: hostile display names");

	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	for (const [name, escaped] of cases) {
		assert.ok(!brief.includes(name), `${JSON.stringify(name)} stayed raw`);
		assert.ok(brief.includes(escaped), `${JSON.stringify(name)} was not visibly escaped`);
	}
});

test("non-UTF-8 doc names stay distinct: byte-safe parsing never collapses paths", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// two distinct filenames that a UTF-8 decode folds to the same U+FFFD
	// string; byte-exact parsing must keep them as two governing docs
	const base = Buffer.from(`${dir}/docs/domain/`);
	fs.writeFileSync(Buffer.concat([base, Buffer.from([0xff]), Buffer.from(".md")]), "# A\n");
	fs.writeFileSync(Buffer.concat([base, Buffer.from([0xfe]), Buffer.from(".md")]), "# B\n");
	await git("add", "-A");
	await git("commit", "-qm", "docs: byte names");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	// byte-distinct not only in matching but in the display: each renders
	// its own escaped bytes, never a shared U+FFFD
	assert.match(brief, /- "docs\/domain\/\\xff\.md"/);
	assert.match(brief, /- "docs\/domain\/\\xfe\.md"/);
});

test("governing-doc globs with a non-ASCII literal match under byte-safe encoding", async () => {
	const { dir, git } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			canonicalDocs: ["docs/über/**/*.md"],
		}),
	);
	fs.mkdirSync(path.join(dir, "docs", "über"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "über", "spec.md"), "# Spec\n");
	await git("add", "-A");
	await git("commit", "-qm", "docs: uber");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/über\/spec\.md/);
	assert.doesNotMatch(brief, /none changed on this branch/);
});

test("an untracked non-UTF-8 doc is fingerprinted byte-safely: a later edit stales the review", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	// a non-UTF-8 untracked file: a UTF-8 decode would look it up under a
	// U+FFFD path, get a null fingerprint, and never notice a content change
	const p = Buffer.concat([Buffer.from(`${dir}/docs/domain/`), Buffer.from([0xff]), Buffer.from(".md")]);
	fs.writeFileSync(p, "# original\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	fs.writeFileSync(p, "# changed after the snapshot was recorded\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr); // stale — snapshot changed
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("a file named __proto__ is fingerprinted: a later edit stales the review", async () => {
	const { dir } = await tmpGitRepo();
	// a plain {} would route this through Object.prototype's __proto__ setter
	// and drop it from the snapshot; a null-prototype object keeps it
	fs.writeFileSync(path.join(dir, "__proto__"), "# original\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	fs.writeFileSync(path.join(dir, "__proto__"), "# changed after the snapshot was recorded\n");
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "sound", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 2, res.stdout + res.stderr); // stale — snapshot changed
	assert.equal(readLedger(dir).find((e) => e.event === "review").verdict, "error");
});

test("an untracked governing doc is named but its content is never inlined", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "docs", "domain"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "domain", "governed.md"), "# Spec\nINLINE_MARKER_XYZ\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /docs\/domain\/governed\.md/); // named
	assert.doesNotMatch(brief, /INLINE_MARKER_XYZ/); // content not inlined (paths-only)
});

test("governing docs without a doc change name the configured globs instead", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
	assert.match(brief, /## Governing docs/);
	assert.match(brief, /docs\/domain\/\*\*\/\*\.md/);
	assert.doesNotMatch(brief, /read these first/);
});

test("review request ids carry real entropy", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	const requests = readLedger(dir).filter((e) => e.event === "review-request");
	assert.equal(requests.length, 2);
	assert.match(requests[0].id, /^rev-[0-9a-f]{32}$/);
	assert.match(requests[1].id, /^rev-[0-9a-f]{32}$/);
	assert.notEqual(requests[0].id, requests[1].id);
});

test("the review diff cap counts raw UTF-8 bytes", async () => {
	const { dir } = await tmpGitRepo();
	fs.appendFileSync(path.join(dir, "impl.js"), `// ${"€".repeat(450_000)}\n`);

	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	const diffSection = brief.split(/## Diff \(against [^)]+\)\n\n/u)[1];
	const [boundedDiff] = diffSection.split("\n[diff truncated at 400000 bytes");

	assert.ok(Buffer.byteLength(boundedDiff, "utf8") <= 400_000);
	assert.doesNotMatch(boundedDiff, /\uFFFD/u, "the byte boundary must not split a UTF-8 sequence");
});

test("tracked .stdd deliverables are under review — changing one stales the approval", async () => {
	const { dir } = await tmpGitRepo();
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	// .stdd/config.json is committed in this fixture — a deliverable, not a
	// working artifact
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			redPattern: "changed",
		}),
	);
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, stale.stdout);
	assert.match(stale.stdout, /stale/i);
});

test("the brief skips symlinks and bounds large untracked files", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "secret.txt");
	fs.writeFileSync(outside, "OUTSIDE_SECRET_MARKER");
	fs.symlinkSync(outside, path.join(dir, "leak.txt"));
	fs.writeFileSync(path.join(dir, "big.txt"), `${"x".repeat(50_000)}END_MARKER`);
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.ok(!brief.includes("OUTSIDE_SECRET_MARKER"), "symlink content leaked into the brief");
	assert.match(brief, /\[truncated\]/);
	assert.ok(!brief.includes("END_MARKER"), "large file was read past the bound");
	// skipped or not, every untracked path is NAMED in the manifest —
	// nothing the reviewer was not told about may exist
	const manifestSection = brief.split("## Changed files")[1].split("## Diff")[0];
	assert.match(manifestSection, /leak\.txt.*skipped/);
	assert.match(manifestSection, /big\.txt/);
});

test("large untracked fingerprints never read an oversized file to EOF and still stale on edits", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "large-sparse.bin");
	const descriptor = fs.openSync(target, "w");
	fs.ftruncateSync(descriptor, 8 * 1024 * 1024);
	fs.writeSync(descriptor, Buffer.from("PREFIX"), 0, 6, 0);
	fs.writeSync(descriptor, Buffer.from("TAIL"), 0, 4, 8 * 1024 * 1024 - 4);
	fs.closeSync(descriptor);
	const auditPath = path.join(tmpDir(), "large-read-audit.json");
	const hookPath = path.join(tmpDir(), "large-read-trap.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalClose = fs.closeSync;
const originalWrite = fs.writeFileSync;
const totals = new Map();
const completed = [];

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
function settle(fd) {
  completed.push(totals.get(fd) ?? 0);
  totals.delete(fd);
}
fs.openSync = function (candidate, flags, ...args) {
  const fd = originalOpen.call(this, candidate, flags, ...args);
  if (isTarget(candidate)) totals.set(fd, 0);
  return fd;
};
fs.readSync = function (fd, ...args) {
  const count = originalRead.call(this, fd, ...args);
  if (totals.has(fd)) totals.set(fd, totals.get(fd) + count);
  return count;
};
fs.closeSync = function (fd, ...args) {
  settle(fd);
  return originalClose.call(this, fd, ...args);
};
process.on("exit", () => {
  for (const fd of totals.keys()) settle(fd);
  originalWrite.call(fs, auditPath, JSON.stringify({ completed }));
});
`,
	);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const env = {
		...envWith(clean),
		NODE_OPTIONS: `--import=${hookPath}`,
	};
	const reviewed = await run(["review", "--via", "codex"], { cwd: dir, env });
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
	const reviewedReads = JSON.parse(fs.readFileSync(auditPath, "utf8")).completed;
	assert.ok(
		reviewedReads.some((bytes) => bytes === 8 * 1024 * 1024),
		"the compatibility snapshot retains the historical whole-file raw hash",
	);
	assert.ok(
		reviewedReads.some((bytes) => bytes > 0 && bytes <= 40_000),
		"brief inspection has its own bounded descriptor read",
	);

	const observed = fs.statSync(target);
	fs.utimesSync(target, observed.atime, new Date(observed.mtimeMs + 60_000));
	const metadataOnly = await run(["status", "--gate"], { cwd: dir, env });
	assert.equal(
		metadataOnly.code,
		0,
		"metadata-only changes preserve the historical raw-byte snapshot contract",
	);

	const edited = fs.openSync(target, "r+");
	fs.writeSync(edited, Buffer.from("MIDDLE_EDIT"), 0, 11, 4 * 1024 * 1024);
	fs.closeSync(edited);
	const stale = await run(["status", "--gate"], { cwd: dir, env });
	assert.equal(stale.code, 1, stale.stdout + stale.stderr);
	assert.match(stale.stdout, /stale/i);
	const staleReads = JSON.parse(fs.readFileSync(auditPath, "utf8")).completed;
	assert.ok(
		staleReads.some((bytes) => bytes === 8 * 1024 * 1024) &&
			staleReads.some((bytes) => bytes > 0 && bytes <= 40_000),
		"stale checking keeps raw compatibility and a bounded inspection fingerprint",
	);
});

test("dirty snapshot never follows a regular file replaced by an outside symlink", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "swap-to-link.txt");
	const outside = path.join(tmpDir(), "outside-secret.txt");
	const auditPath = path.join(tmpDir(), "symlink-read-audit.json");
	fs.writeFileSync(target, "repository bytes\n");
	fs.writeFileSync(outside, "OUTSIDE_BYTES_MUST_NOT_BE_READ\n");
	const hookPath = path.join(tmpDir(), "dirty-symlink-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";

const target = ${JSON.stringify(target)};
const outside = ${JSON.stringify(outside)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const outsideIdentity = fs.lstatSync(outside, { bigint: true });
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalWrite = fs.writeFileSync;
let swapped = false;
let outsideReads = 0;
const outsideDescriptors = new Set();

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (!swapped && isTarget(candidate)) {
    swapped = true;
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }
  const fd = originalOpen.call(this, candidate, flags, ...args);
  const opened = fs.fstatSync(fd, { bigint: true });
  if (opened.dev === outsideIdentity.dev && opened.ino === outsideIdentity.ino) {
    outsideDescriptors.add(fd);
  }
  return fd;
};
fs.readSync = function (fd, ...args) {
  const count = originalRead.call(this, fd, ...args);
  if (outsideDescriptors.has(fd)) outsideReads += count;
  return count;
};
process.on("exit", () => {
  originalWrite.call(fs, auditPath, JSON.stringify({ swapped, outsideReads }));
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
	assert.equal(audit.swapped, true, "the pathname race was injected");
	assert.equal(audit.outsideReads, 0, "the replacement symlink target was never read");
	assert.doesNotMatch(`${prep.stdout}${prep.stderr}`, /OUTSIDE_BYTES_MUST_NOT_BE_READ/);
	const status = await run(["status", "--gate"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
});

test("dirty snapshot opens a raced FIFO nonblocking and rejects it without hanging", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "swap-to-fifo.txt");
	const auditPath = path.join(tmpDir(), "fifo-open-audit.json");
	fs.writeFileSync(target, "repository bytes\n");
	const hookPath = path.join(tmpDir(), "dirty-fifo-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalWrite = fs.writeFileSync;
let swapped = false;
let safeFlags = false;

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (!swapped && isTarget(candidate)) {
    swapped = true;
    fs.rmSync(target);
    const made = spawnSync("mkfifo", [target]);
    if (made.status !== 0) throw new Error(String(made.stderr));
  }
  if (isTarget(candidate)) {
    safeFlags =
      typeof flags === "number" &&
      (flags & fs.constants.O_NONBLOCK) !== 0 &&
      (flags & fs.constants.O_NOFOLLOW) !== 0;
    if (!safeFlags) {
      const err = new Error("test refused a potentially blocking FIFO open");
      err.code = "EINTR";
      throw err;
    }
  }
  return originalOpen.call(this, candidate, flags, ...args);
};
process.on("exit", () => {
  originalWrite.call(fs, auditPath, JSON.stringify({ swapped, safeFlags }));
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		timeout: 5000,
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
	assert.equal(audit.swapped, true, "the FIFO race was injected");
	assert.equal(audit.safeFlags, true, "the raced pathname was opened with nonblocking no-follow flags");
	const status = await run(["status", "--gate"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
});

test("brief inspection opens a raced FIFO nonblocking and classifies it unsafe", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "brief-swap-to-fifo.txt");
	const auditPath = path.join(tmpDir(), "brief-fifo-open-audit.json");
	fs.writeFileSync(target, "repository bytes\n");
	const hookPath = path.join(tmpDir(), "brief-fifo-race.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalWrite = fs.writeFileSync;
let targetOpens = 0;
let swapped = false;
let inspectionSafeFlags = false;

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (isTarget(candidate)) {
    targetOpens++;
    if (targetOpens === 3) {
      swapped = true;
      fs.rmSync(target);
      const made = spawnSync("mkfifo", [target]);
      if (made.status !== 0) throw new Error(String(made.stderr));
      inspectionSafeFlags =
        typeof flags === "number" &&
        (flags & fs.constants.O_NONBLOCK) !== 0 &&
        (flags & fs.constants.O_NOFOLLOW) !== 0;
      if (!inspectionSafeFlags) {
        const err = new Error("test refused a potentially blocking brief FIFO open");
        err.code = "EINTR";
        throw err;
      }
    }
  }
  return originalOpen.call(this, candidate, flags, ...args);
};
process.on("exit", () => {
  originalWrite.call(
    fs,
    auditPath,
    JSON.stringify({ targetOpens, swapped, inspectionSafeFlags }),
  );
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		timeout: 5000,
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
	assert.equal(audit.swapped, true, "the third open raced brief inspection");
	assert.equal(audit.inspectionSafeFlags, true, "brief inspection uses nonblocking no-follow flags");
	assert.doesNotMatch(prep.stdout, /brief written to/);
	assert.match(prep.stderr, /checkout changed|cannot be fingerprinted safely/i);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.ok(
		!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
		"the unsafe brief candidate is rejected before dispatch",
	);
});

test("dirty snapshot rejects hard-linked files without reading their shared inode", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "outside-hardlink.txt");
	const target = path.join(dir, "hardlink.txt");
	const auditPath = path.join(tmpDir(), "hardlink-read-audit.json");
	fs.writeFileSync(outside, "SHARED_OUTSIDE_BYTES\n");
	fs.linkSync(outside, target);
	const hookPath = path.join(tmpDir(), "dirty-hardlink-trap.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";

const target = ${JSON.stringify(target)};
const auditPath = ${JSON.stringify(auditPath)};
const targetBytes = Buffer.from(target);
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalWrite = fs.writeFileSync;
const descriptors = new Set();
let bytesRead = 0;

function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  const fd = originalOpen.call(this, candidate, flags, ...args);
  if (isTarget(candidate)) descriptors.add(fd);
  return fd;
};
fs.readSync = function (fd, ...args) {
  const count = originalRead.call(this, fd, ...args);
  if (descriptors.has(fd)) bytesRead += count;
  return count;
};
process.on("exit", () => {
  originalWrite.call(fs, auditPath, JSON.stringify({ bytesRead }));
});
`,
	);
	const prep = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	assert.match(prep.stderr, /hardlink\.txt/);
	assert.equal(
		JSON.parse(fs.readFileSync(auditPath, "utf8")).bytesRead,
		0,
		"the shared inode was rejected before content reads",
	);
	const status = await run(["status", "--gate"], { cwd: dir });
	assert.equal(status.code, 0, status.stdout + status.stderr);
});

test("untracked brief inspection never follows file or parent swaps at open or read", async () => {
	for (const mode of ["file-open", "parent-open", "file-read"]) {
		const { dir } = await tmpGitRepo();
		const parent = path.join(dir, `untracked-${mode}`);
		const parkedParent = path.join(dir, `parked-${mode}`);
		const outsideParent = path.join(tmpDir(), `outside-${mode}`);
		const target = path.join(parent, "candidate.txt");
		const outside = path.join(outsideParent, "candidate.txt");
		fs.mkdirSync(parent);
		fs.mkdirSync(outsideParent);
		fs.writeFileSync(target, `ORIGINAL_UNTRACKED_${mode}\n`);
		fs.writeFileSync(outside, `OUTSIDE_SECRET_${mode}\n`);
		const hookPath = path.join(tmpDir(), `swap-untracked-${mode}.mjs`);
		fs.writeFileSync(
			hookPath,
			`import fs from "node:fs";
import path from "node:path";
const mode = ${JSON.stringify(mode)};
const target = ${JSON.stringify(target)};
const parent = ${JSON.stringify(parent)};
const parkedParent = ${JSON.stringify(parkedParent)};
const outsideParent = ${JSON.stringify(outsideParent)};
const outside = ${JSON.stringify(outside)};
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalRename = fs.renameSync;
const targetBytes = Buffer.from(target);
let targetOpens = 0;
let inspectionFd = null;
let swapped = false;
function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
function swap() {
  if (swapped) return;
  swapped = true;
  if (mode === "parent-open") {
    originalRename.call(fs, parent, parkedParent);
    fs.symlinkSync(outsideParent, parent, "dir");
  } else {
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }
}
fs.openSync = function (candidate, flags, ...args) {
  const matches = isTarget(candidate);
  if (matches) {
    targetOpens++;
    if (targetOpens === 2 && mode.endsWith("-open")) swap();
  }
  const fd = originalOpen.call(this, candidate, flags, ...args);
  if (matches && targetOpens === 2) inspectionFd = fd;
  return fd;
};
fs.readSync = function (fd, ...args) {
  if (fd === inspectionFd && mode === "file-read") swap();
  return originalRead.call(this, fd, ...args);
};
`,
		);

		const prep = await run(["review", "--via", "subagent"], {
			cwd: dir,
			env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
		});
		assert.equal(prep.code, 1, `${mode}: ${prep.stdout}${prep.stderr}`);
		assert.match(prep.stderr, /checkout changed.*building.*brief|cannot be fingerprinted safely/i, mode);
		assert.doesNotMatch(prep.stdout, /brief written to/, mode);
		const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
		assert.ok(
			!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
			`${mode}: a raced checkout is rejected before dispatch`,
		);
	}
});

test("unsafe or raced canonical docs are named but never offered as governing docs to open", async () => {
	for (const mode of ["symlink", "tracked-symlink", "open-race"]) {
		const { dir, git } = await tmpGitRepo();
		const docsDir = path.join(dir, "docs", "domain");
		const target = path.join(docsDir, `${mode}.md`);
		const outside = path.join(tmpDir(), `${mode}-secret.md`);
		fs.mkdirSync(docsDir, { recursive: true });
		fs.writeFileSync(outside, `CANONICAL_OUTSIDE_SECRET_${mode}\n`);
		if (mode.endsWith("symlink")) {
			fs.symlinkSync(outside, target);
			if (mode === "tracked-symlink") {
				await git("add", "docs/domain/tracked-symlink.md");
				await git("commit", "-qm", "docs: add unsafe canonical link");
			}
		} else fs.writeFileSync(target, "# Safe before inspection\n");

		let env = process.env;
		if (mode === "open-race") {
			const hookPath = path.join(tmpDir(), "swap-canonical-open.mjs");
			fs.writeFileSync(
				hookPath,
				`import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)};
const outside = ${JSON.stringify(outside)};
const originalOpen = fs.openSync;
const targetBytes = Buffer.from(target);
let targetOpens = 0;
function isTarget(candidate) {
  return Buffer.isBuffer(candidate)
    ? candidate.equals(targetBytes)
    : path.resolve(String(candidate)) === target;
}
fs.openSync = function (candidate, flags, ...args) {
  if (isTarget(candidate) && ++targetOpens === 2) {
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }
  return originalOpen.call(this, candidate, flags, ...args);
};
`,
			);
			env = { ...process.env, NODE_OPTIONS: `--import=${hookPath}` };
		}

		const prep = await run(["review", "--via", "subagent"], { cwd: dir, env });
		if (mode === "open-race") {
			assert.equal(prep.code, 1, `${mode}: ${prep.stdout}${prep.stderr}`);
			assert.match(prep.stderr, /checkout changed.*building.*brief|cannot be fingerprinted safely/i);
			assert.doesNotMatch(prep.stdout, /brief written to/);
			assert.doesNotMatch(
				`${prep.stdout}${prep.stderr}`,
				new RegExp(`CANONICAL_OUTSIDE_SECRET_${mode}`),
			);
			const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
			assert.ok(
				!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
				"a raced canonical doc is rejected before dispatch",
			);
			continue;
		}
		assert.equal(prep.code, 0, `${mode}: ${prep.stdout}${prep.stderr}`);
		const brief = fs.readFileSync(prep.stdout.match(/brief written to (\S+)/)?.[1], "utf8");
		assert.doesNotMatch(brief, new RegExp(`CANONICAL_OUTSIDE_SECRET_${mode}`), mode);
		const manifestSection = brief.split("## Changed files")[1].split("## Diff")[0];
		assert.match(manifestSection, new RegExp(`${mode}\\.md.*(?:unsafe|skipped)`, "i"), mode);
		const governingSection = brief.split("## Governing docs")[1].split("## Plan")[0];
		assert.match(governingSection, new RegExp(`${mode}\\.md.*do not open`, "i"), mode);
		assert.doesNotMatch(governingSection, new RegExp(`read these first[^#]*${mode}\\.md`, "i"), mode);
	}
});

test("an unreadable dirty file aborts the review with the path named; status stays alive", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "aa-locked.txt"), "secret", { mode: 0o000 });
	// a review over content that cannot be read proves nothing — abort,
	// name the path, record nothing
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 1, prep.stdout + prep.stderr);
	assert.match(prep.stderr, /aa-locked\.txt/);
	assert.ok(!fs.existsSync(path.join(dir, ".stdd", "ledger.jsonl")), "nothing recorded");
	// the soft callers never crash on it
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout);
});

test("a readable file whose bytes spell the sentinel is still just content", async () => {
	const { dir } = await tmpGitRepo();
	// the sentinel lives outside the content-hash namespace — these exact
	// bytes must never be misclassified as an unreadable file
	fs.writeFileSync(path.join(dir, "odd.txt"), "unreadable:odd.txt");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
});

test("scope: a changed-but-still-unreadable file is never inherited dirt", async () => {
	const { dir } = await tmpGitRepo();
	const locked = path.join(dir, "locked.bin");
	fs.writeFileSync(locked, "v1", { mode: 0o000 });
	await run(["slice", "new", "--allowed", "impl.js"], { cwd: dir });
	// the owner flips the bits, changes the content, relocks
	fs.chmodSync(locked, 0o600);
	fs.writeFileSync(locked, "v2-changed");
	fs.chmodSync(locked, 0o000);
	const res = await run(["scope"], { cwd: dir });
	fs.chmodSync(locked, 0o600);
	assert.equal(res.code, 1, "the change happened outside the allowed scope");
});

test("a file turning unreadable after approval reads as stale", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "data.txt"), "readable\n");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.chmodSync(path.join(dir, "data.txt"), 0o000);
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the approval no longer covers what exists");
	fs.chmodSync(path.join(dir, "data.txt"), 0o600);
});

test("the review budget stops the loop after maxRounds changes-requested; errors never burn it", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			review: { via: "codex", maxRounds: 1 },
		}),
	);
	// an error verdict must not count toward the budget
	const malformed = stubCodex("not json at all");
	await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(malformed),
	});
	const blocking = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	const first = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(blocking),
	});
	assert.equal(first.code, 1, "the error round did not burn the budget");

	const refused = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(blocking),
	});
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /budget/);
	assert.equal(
		readLedger(dir).filter((e) => e.event === "review-request").length,
		2,
		"the refused round records nothing",
	);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const forced = await run(
		["review", "--via", "codex", "--force", "--reason", "one round to settle the parser rewrite"],
		{ cwd: dir, env: envWith(clean) },
	);
	assert.equal(forced.code, 0, forced.stdout + forced.stderr);
});

test("forcing a round past the budget needs a reason, and the reason is recorded with the request", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(
		path.join(dir, ".stdd", "config.json"),
		JSON.stringify({
			baseRef: "main",
			capabilities: ALL_CAPS,
			review: { via: "codex", maxRounds: 1 },
		}),
	);
	const blocking = stubCodex(
		'{"summary": "broken", "findings": [{"severity": "blocking", "path": "impl.js", "line": 1, "message": "wrong"}]}',
	);
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(blocking) });

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const bare = await run(["review", "--via", "codex", "--force"], {
		cwd: dir,
		env: envWith(clean),
	});
	assert.equal(bare.code, 1, bare.stdout + bare.stderr);
	assert.match(bare.stderr, /--reason/);

	const unforced = await run(["review", "--via", "codex", "--reason", "just because"], {
		cwd: dir,
		env: envWith(clean),
	});
	assert.equal(unforced.code, 1, unforced.stdout + unforced.stderr);
	assert.match(unforced.stderr, /--force/);

	assert.equal(
		readLedger(dir).filter((e) => e.event === "review-request").length,
		1,
		"a refused force records nothing",
	);

	const reason = "the remaining finding is cosmetic; one round to confirm the fix";
	const forced = await run(["review", "--via", "codex", "--force", "--reason", reason], {
		cwd: dir,
		env: envWith(clean),
	});
	assert.equal(forced.code, 0, forced.stdout + forced.stderr);
	const requests = readLedger(dir).filter((e) => e.event === "review-request");
	assert.equal(requests.length, 2);
	assert.equal(requests.at(-1).forced, reason, "the forced round records why it was bought");
	assert.equal(requests[0].forced, undefined, "an in-budget round records no reason");
});

test("a stale approval reopens the review in plain status, not only in the gate", async () => {
	const { dir } = await tmpGitRepo();
	await run(["docs", "not-applicable", "--reason", "test fixture"], {
		cwd: dir,
	});
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 5;\n");
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir })).stdout);
	assert.equal(s.review.stale, true);
	assert.equal(s.plan.review.done, false, "a stale approval is not a done review");
	assert.match(s.next, /stdd verify/, "verification stales before the review can be repeated");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const reverified = JSON.parse((await run(["status", "--json"], { cwd: dir })).stdout);
	assert.match(reverified.next, /repair the stale or errored closing review/);
	assert.match(reverified.next, /stdd review/);
	assert.doesNotMatch(reverified.next, /closing review closes/);
});

test("a checkout that changes while the codex reviewer runs records stale", async () => {
	const { dir } = await tmpGitRepo();
	// this stand-in mutates the repo before answering — the approval it
	// returns is about a diff that does not exist anymore
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
printf 'mutated' >> "${path.join(dir, "impl.js")}"
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 2, res.stdout + res.stderr);
	const review = readLedger(dir).find((e) => e.event === "review");
	assert.equal(review.verdict, "error");
	assert.match(review.reason, /stale/);
	const plan = fs.readFileSync(path.join(dir, ".stdd", "plan.md"), "utf8");
	assert.match(plan, /- \[ \] closing review/);
});

test("non-ASCII dirty filenames do not crash the review", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "тест-файл.txt"), "содержимое\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
});

test("binary dirty files are hashed by raw bytes, not lossy text decoding", async () => {
	const { dir } = await tmpGitRepo();
	// both byte sequences decode to the same replacement character — a
	// text-decoded hash cannot tell them apart
	fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0xc3]));
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0xc4]));
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "the binary changed — the approval must go stale");
});

test("committed binary bytes stale approval even when an external display diff is unchanged", async () => {
	const { dir, git } = await tmpGitRepo();
	const externalDiff = path.join(tmpDir(), "constant-external-diff");
	fs.writeFileSync(externalDiff, "#!/bin/sh\nprintf 'constant binary display\\n'\n");
	fs.chmodSync(externalDiff, 0o755);
	await git("config", "diff.external", externalDiff);
	fs.writeFileSync(path.join(dir, "committed.bin"), Buffer.from([0, 0xff, 1, 0xfe]));
	await git("add", "committed.bin");
	await git("commit", "--amend", "-qm", "binary version one");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	const reviewed = await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);

	fs.writeFileSync(path.join(dir, "committed.bin"), Buffer.from([0, 0xfe, 1, 0xff]));
	await git("add", "committed.bin");
	await git("commit", "--amend", "-qm", "binary version two");
	const stale = await run(["status", "--gate"], { cwd: dir });

	assert.equal(stale.code, 1, "changed committed bytes cannot inherit approval from a display diff");
	assert.match(stale.stdout, /stale/i);
});

test("snapshots and brief hashes carry a single sha256: prefix", async () => {
	const { dir } = await tmpGitRepo();
	const bin = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(bin) });
	const request = readLedger(dir).find((e) => e.event === "review-request");
	assert.match(request.snapshot, /^sha256:[0-9a-f]{64}$/);
	assert.match(request.brief, /^sha256:[0-9a-f]{64}$/);
});

test("edits inside a wholly untracked directory stale the approval", async () => {
	const { dir } = await tmpGitRepo();
	fs.mkdirSync(path.join(dir, "newdir"));
	fs.writeFileSync(path.join(dir, "newdir", "mod.js"), "export const a = 1;\n");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	fs.writeFileSync(path.join(dir, "newdir", "mod.js"), "export const a = 2;\n");
	const stale = await run(["status", "--gate"], { cwd: dir });
	assert.equal(stale.code, 1, "untracked work changed — the approval must go stale");
});

test("non-ASCII untracked filenames still reach the brief", async () => {
	const { dir } = await tmpGitRepo();
	fs.writeFileSync(path.join(dir, "данные.txt"), "CYRILLIC_CONTENT_MARKER\n");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const brief = fs.readFileSync(briefPath, "utf8");
	assert.match(brief, /CYRILLIC_CONTENT_MARKER/);
});

test("the brief travels to codex over stdin, not as one huge argv element", async () => {
	const { dir } = await tmpGitRepo();
	const side = path.join(tmpDir(), "stdin-capture.txt");
	const argsCapture = path.join(tmpDir(), "argv-capture.txt");
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > "${side}"
printf '%s\\n' "$@" > "${argsCapture}"
out=""
prev=""
last=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
  last="$a"
done
[ "$last" = "-" ] || { echo "prompt must be stdin (-)" >&2; exit 9; }
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 0, res.stdout + res.stderr);
	const captured = fs.readFileSync(side, "utf8");
	assert.match(captured, /# Independent closing review/);
	const args = fs.readFileSync(argsCapture, "utf8").trimEnd().split("\n");
	assert.deepEqual(args.slice(0, 4), ["exec", "--sandbox", "read-only", "--ephemeral"]);
	assert.equal(args[4], "--output-last-message");
	assert.equal(args.length, 7);
	assert.equal(args.at(-1), "-");
});

test("the brief file is owner-only in a private temp directory", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.equal(fs.statSync(briefPath).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(briefPath)).mode & 0o777, 0o700);
	assert.match(fs.readFileSync(briefPath, "utf8"), /untrusted review data/i);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const submitted = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(submitted.code, 0, submitted.stdout + submitted.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)), "submitted review removes the private brief");
});

test("review requests capture a complete portable v2 private state", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const request = readLedger(dir).find((event) => event.event === "review-request");
	assert.equal(request.privateState.version, 2);
	assert.equal(request.privateState.tempRoot.identity.version, 2);
	assert.equal(request.privateState.tempRoot.identity.kind, "directory");
	assert.equal(request.privateState.directory.identity.kind, "directory");
	assert.deepEqual(Object.keys(request.privateState.artifacts), [`${request.id}.md`]);
	for (const observation of [
		request.privateState.tempRoot,
		request.privateState.directory,
		...Object.values(request.privateState.artifacts),
	]) {
		assert.deepEqual(Object.keys(observation).sort(), ["identity", "linkCount", "owner", "permissions"]);
		assert.deepEqual(Object.keys(observation.identity).sort(), [
			"fileId",
			"kind",
			"platform",
			"version",
			"volume",
		]);
	}
});

test("review --cleanup refuses a same-name directory ABA replacement before mutation", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const briefDir = path.dirname(briefPath);
	const displaced = `${briefDir}.original`;
	const bytes = fs.readFileSync(briefPath);
	fs.renameSync(briefDir, displaced);
	fs.mkdirSync(briefDir, { mode: 0o700 });
	fs.writeFileSync(briefPath, bytes, { mode: 0o600 });

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.deepEqual(fs.readFileSync(briefPath), bytes, "replacement directory remains untouched");
	assert.deepEqual(
		fs.readFileSync(path.join(displaced, path.basename(briefPath))),
		bytes,
		"captured directory remains available for manual remediation",
	);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-cancelled"));
});

test("review --result never accepts or deletes a modified or replaced private brief", async () => {
	for (const mode of ["modified", "replaced"]) {
		const { dir } = await tmpGitRepo();
		const prep = await run(["review", "--via", "subagent"], { cwd: dir });
		assert.equal(prep.code, 0, prep.stdout + prep.stderr);
		const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
		const request = readLedger(dir).find((event) => event.event === "review-request");
		const replacement = `UNTRUSTED_PRIVATE_BRIEF_${mode}\n`;
		if (mode === "replaced") replaceReviewFixtureFile(briefPath, replacement);
		else fs.writeFileSync(briefPath, replacement, { mode: 0o600 });
		if (mode === "replaced") assertReviewFixtureInodeChanged(request, briefPath);
		const resultPath = path.join(tmpDir(), `${mode}-result.json`);
		fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');

		const submitted = await run(["review", "--result", resultPath], { cwd: dir });
		assert.equal(submitted.code, 1, `${mode}: ${submitted.stdout}${submitted.stderr}`);
		assert.match(submitted.stderr, /private review brief.*integrity|integrity.*private review brief/i);
		assert.equal(fs.readFileSync(briefPath, "utf8"), replacement, `${mode}: replacement survives`);
		assert.ok(
			!readLedger(dir).some(
				(event) =>
					(event.event === "review" || event.event === "review-cancelled") &&
					event.request === request.id,
			),
			`${mode}: an unverified brief cannot produce a terminal verdict`,
		);

		const cleaned = await run(["review", "--cleanup"], { cwd: dir });
		if (mode === "modified") {
			assert.equal(cleaned.code, 0, `${mode}: ${cleaned.stdout}${cleaned.stderr}`);
			assert.ok(!fs.existsSync(briefPath), `${mode}: the captured inode can be settled`);
			assert.equal(
				readLedger(dir).filter(
					(event) => event.event === "review-cancelled" && event.request === request.id,
				).length,
				1,
			);
		} else {
			assert.equal(cleaned.code, 1, `${mode}: ${cleaned.stdout}${cleaned.stderr}`);
			assert.equal(fs.readFileSync(briefPath, "utf8"), replacement);
			assert.ok(
				!readLedger(dir).some(
					(event) => event.event === "review-cancelled" && event.request === request.id,
				),
				"an ABA replacement requires manual remediation",
			);
		}
	}
});

test("review dispatch rejects transient reverted bytes read while building the brief", async () => {
	const { dir } = await tmpGitRepo();
	const target = path.join(dir, "transient.txt");
	const original = "ORIGINAL_CAPTURED_BYTES\n";
	const transient = "TRANSIENT_UNBOUND_BYTES\n";
	fs.writeFileSync(target, original);
	const hookPath = path.join(tmpDir(), "transient-review-build.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)};
const original = ${JSON.stringify(original)};
const transient = ${JSON.stringify(transient)};
const originalLstat = fs.lstatSync;
let targetLstats = 0;
function isTarget(candidate) {
  return path.resolve(String(candidate)) === target;
}
fs.lstatSync = function (candidate, ...args) {
  if (!isTarget(candidate)) return originalLstat.call(this, candidate, ...args);
  targetLstats++;
  if (targetLstats !== 2) return originalLstat.call(this, candidate, ...args);
  fs.writeFileSync(target, transient);
  const observed = originalLstat.call(this, candidate, ...args);
  fs.writeFileSync(target, original);
  return observed;
};
`,
	);

	const reviewed = await run(["review", "--via", "subagent"], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(reviewed.code, 1, reviewed.stdout + reviewed.stderr);
	assert.match(
		reviewed.stderr,
		/checkout changed.*building.*brief|brief.*captured snapshot|cannot be fingerprinted safely/i,
	);
	assert.equal(fs.readFileSync(target, "utf8"), original);
	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	assert.ok(
		!fs.existsSync(ledgerPath) || !readLedger(dir).some((event) => event.event === "review-request"),
		"mismatched material is rejected before dispatch",
	);
});

test("concurrent review results record exactly one verdict for the request", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const resultPath = path.join(tmpDir(), "approved.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const results = await Promise.all([
		run(["review", "--result", resultPath], { cwd: dir }),
		run(["review", "--result", resultPath], { cwd: dir }),
	]);

	assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
	assert.match(
		results.find((result) => result.code === 1).stderr,
		/request.*no longer open|private review brief.*(?:integrity|could not be verified and removed)/i,
	);
	const terminal = readLedger(dir).filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminal.length, 1);
	assert.equal(terminal[0].event, "review");
});

test("review result reports the cleanup winner after its open request brief disappears", async () => {
	const { dir } = await tmpGitRepo();
	await run(["review", "--via", "subagent"], { cwd: dir });
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const resultPath = path.join(tmpDir(), "cleanup-wins-approved.json");
	const ready = path.join(tmpDir(), "cleanup-wins-result.ready");
	const release = path.join(tmpDir(), "cleanup-wins-result.release");
	const hookPath = path.join(tmpDir(), "cleanup-wins-result-race.mjs");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";

const resultPath = ${JSON.stringify(resultPath)};
const ready = ${JSON.stringify(ready)};
const release = ${JSON.stringify(release)};
const originalRead = fs.readFileSync;
fs.readFileSync = function (candidate, ...args) {
  if (String(candidate) === resultPath) {
    fs.writeFileSync(ready, "ready");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(release) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (!fs.existsSync(release)) throw new Error("timed out waiting for concurrent cleanup");
  }
  return originalRead.call(this, candidate, ...args);
};
`,
	);

	const resultPromise = run(["review", "--result", resultPath], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	await waitForPath(ready);
	const cleanup = await run(["review", "--cleanup"], { cwd: dir });
	fs.writeFileSync(release, "continue");
	const result = await resultPromise;

	assert.equal(cleanup.code, 0, cleanup.stdout + cleanup.stderr);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /request.*no longer open|another result or cleanup already answered/i);
	assert.doesNotMatch(result.stderr, /ENOENT|request left open|run `stdd review --cleanup`/i);
	const terminal = readLedger(dir).filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminal.length, 1);
	assert.equal(terminal[0].event, "review-cancelled");
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "cleanup settled the private directory");
});

test("concurrent cross-CLI completion and cleanup record one terminal outcome", async () => {
	const { dir } = await tmpGitRepo();
	const controlDir = tmpDir();
	const ready = path.join(controlDir, "ready");
	const release = path.join(controlDir, "release");
	const bin = path.join(controlDir, "codex-waiting-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
: > "${ready}"
while [ ! -e "${release}" ]; do sleep 0.01; done
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);

	const completing = run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	await waitForPath(ready);
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	fs.writeFileSync(release, "go");
	const completed = await completing;

	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.equal(completed.code, 1, completed.stdout + completed.stderr);
	assert.match(completed.stderr, /request.*no longer open/i);
	const terminals = readLedger(dir).filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].event, "review-cancelled");
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "the private brief directory is gone");
});

test("review --cleanup cancels abandoned subagent requests and removes their briefs", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.ok(fs.existsSync(briefPath));
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)));
	assert.ok(readLedger(dir).some((e) => e.event === "review-cancelled"));
});

test("review --cleanup reaches an interrupted cross-CLI request and clears its gate", async () => {
	const { dir } = await tmpGitRepo({
		subagents: false,
		crossCli: false,
		worktrees: true,
	});
	const id = "rev-1234abcd";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	fs.writeFileSync(briefPath, "private cross-CLI brief", { mode: 0o600 });
	const lastMessagePath = path.join(briefDir, "last-message.txt");
	fs.writeFileSync(lastMessagePath, "interrupted reviewer output", { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);

	const blocked = await run(["status", "--gate"], { cwd: dir });
	assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
	assert.match(blocked.stdout, /open review request.*crossCli capability is off/i);

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(briefDir), "cleanup removes every owned private cross-CLI artifact");
	const terminals = readLedger(dir).filter(
		(event) => (event.event === "review" || event.event === "review-cancelled") && event.request === id,
	);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].event, "review-cancelled");

	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
});

test("review --cleanup leaves legacy present artifacts without privateState for manual remediation", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-1234abd0";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	const bytes = "legacy private bytes\n";
	fs.writeFileSync(briefPath, bytes, { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "subagent",
			snapshot: "captured",
			brief: "sha256:legacy",
			briefPath,
			branch: "feature",
		})}\n`,
	);

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.equal(fs.readFileSync(briefPath, "utf8"), bytes);
	assert.ok(!readLedger(dir).some((event) => event.event === "review-cancelled"));
});

test("review --cleanup preserves unknown private siblings and keeps terminal cleanup retryable", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-1234abce";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	const lastMessagePath = path.join(briefDir, "last-message.txt");
	const unknownPath = path.join(briefDir, "user-note.txt");
	fs.writeFileSync(briefPath, "private cross-CLI brief", { mode: 0o600 });
	fs.writeFileSync(lastMessagePath, "interrupted reviewer output", { mode: 0o600 });
	fs.writeFileSync(unknownPath, "unknown sibling survives\n", { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);

	const first = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(first.code, 1, first.stdout + first.stderr);
	assert.match(first.stderr, /could not remove.*request left open/i);
	assert.equal(fs.readFileSync(unknownPath, "utf8"), "unknown sibling survives\n");
	assert.ok(fs.existsSync(briefPath), "unknown siblings stop settlement before owned bytes are touched");
	assert.ok(fs.existsSync(lastMessagePath));
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === id).length,
		0,
	);

	const second = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(second.code, 1, second.stdout + second.stderr);
	assert.equal(fs.readFileSync(unknownPath, "utf8"), "unknown sibling survives\n");
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review-cancelled" && event.request === id).length,
		0,
		"retrying an unsafe namespace never records cancellation",
	);

	fs.rmSync(unknownPath);
	const settled = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(settled.code, 0, settled.stdout + settled.stderr);
	assert.ok(!fs.existsSync(briefDir));
});

test("review --cleanup rejects an unsafe last-message companion without touching its target", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-1234abcf";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	fs.writeFileSync(briefPath, "private cross-CLI brief", { mode: 0o600 });
	const outside = path.join(tmpDir(), "outside-last-message.txt");
	fs.writeFileSync(outside, "outside survives\n");
	fs.symlinkSync(outside, path.join(briefDir, "last-message.txt"));
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.match(cleaned.stderr, /could not remove|unsafe|private/i);
	assert.equal(fs.readFileSync(outside, "utf8"), "outside survives\n");
	assert.ok(fs.existsSync(briefPath), "unsafe preflight leaves the request artifacts intact");
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === id),
	);
});

test("review --cleanup preserves an open request and its brief when cancellation append fails", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const cleaned = await run(["review", "--cleanup"], {
		cwd: dir,
		env: {
			...process.env,
			STDD_NATIVE_FS_PACKAGE_ROOT: path.join(tmpDir(), "missing-native-package"),
		},
	});

	assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
	assert.match(cleaned.stderr, /native filesystem|prebuild|artifact|manifest/i);
	assert.match(cleaned.stderr, /request left open/);
	assert.ok(fs.existsSync(briefPath), "an open request must retain its private brief");
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === request.id),
	);
});

test("review --cleanup rejects primitive ledger events without crashing", async () => {
	for (const primitive of ["null", "42"]) {
		const { dir } = await tmpGitRepo();
		fs.writeFileSync(path.join(dir, ".stdd", "ledger.jsonl"), `${primitive}\n`);

		const cleaned = await run(["review", "--cleanup"], { cwd: dir });
		assert.equal(cleaned.code, 1, cleaned.stdout + cleaned.stderr);
		assert.match(cleaned.stderr, /malformed task boundary/i);
		assert.match(cleaned.stderr, /repair.*ledger\.jsonl/i);
		assert.doesNotMatch(cleaned.stderr, /TypeError/);
	}
});

test("review --cleanup leaves a request open when its private brief cannot be removed", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const original = fs.openSync(briefPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		fs.rmSync(briefPath);
		fs.mkdirSync(briefPath);

		const failed = await run(["review", "--cleanup"], { cwd: dir });
		assert.equal(failed.code, 1, failed.stdout + failed.stderr);
		assert.match(failed.stderr, /could not remove/i);
		assert.ok(
			!readLedger(dir).some(
				(event) => event.event === "review-cancelled" && event.request === request.id,
			),
			"failed deletion must not make the request look answered",
		);

		fs.rmdirSync(briefPath);
		fs.writeFileSync(briefPath, "private brief", { mode: 0o600 });
	} finally {
		fs.closeSync(original);
	}
	assertReviewFixtureInodeChanged(request, briefPath);
	const retried = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(retried.code, 1, retried.stdout + retried.stderr);
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === request.id),
		"a replacement inode cannot inherit the captured cleanup authority",
	);
});

test("review --cleanup never follows a ledger-named symlink directory to delete an outside file", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const realBriefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const outsideDir = tmpDir();
	const victimPath = path.join(outsideDir, `${request.id}.md`);
	fs.writeFileSync(victimPath, "must survive");
	const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.rmdirSync(symlinkDir);
	fs.symlinkSync(outsideDir, symlinkDir, "dir");

	const ledgerPath = path.join(dir, ".stdd", "ledger.jsonl");
	const forgedLedger = fs
		.readFileSync(ledgerPath, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => {
			const event = JSON.parse(line);
			return JSON.stringify(
				event.event === "review-request"
					? { ...event, briefPath: path.join(symlinkDir, `${request.id}.md`) }
					: event,
			);
		})
		.join("\n");
	fs.writeFileSync(ledgerPath, `${forgedLedger}\n`);

	const failed = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /could not remove/i);
	assert.equal(fs.readFileSync(victimPath, "utf8"), "must survive");
	assert.ok(
		!readLedger(dir).some((event) => event.event === "review-cancelled" && event.request === request.id),
		"untrusted deletion target must leave the request open",
	);

	fs.unlinkSync(symlinkDir);
	fs.rmSync(victimPath);
	fs.rmdirSync(outsideDir);
	fs.rmSync(realBriefPath);
	fs.rmdirSync(path.dirname(realBriefPath));
});

test("review --cleanup reaches abandoned briefs after their task is finished", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "abandoned review"], { cwd: dir });
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	assert.ok(fs.existsSync(briefPath));
	await run(["task", "finish"], { cwd: dir });

	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)));
	const request = readLedger(dir).find((event) => event.event === "review-request");
	const cancelled = readLedger(dir).find((event) => event.event === "review-cancelled");
	assert.equal(cancelled.request, request.id);
	assert.equal(cancelled.taskId, request.taskId);
});

test("review --cleanup preserves legacy branch-scoped cancellation provenance", async () => {
	const { dir } = await tmpGitRepo();
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const request = readLedger(dir).find((event) => event.event === "review-request");
	assert.equal(request.taskId, undefined, "fixture request is legacy branch-scoped");

	await run(["task", "start", "newer task"], { cwd: dir });
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(path.dirname(briefPath)));
	const cancelled = readLedger(dir).find((event) => event.event === "review-cancelled");
	assert.equal(cancelled.request, request.id);
	assert.equal(cancelled.taskId, undefined, "cancellation is not attributed to the newer task");
});

test("a branch switch while the reviewer runs cancels the original request without a verdict", async () => {
	const { dir } = await tmpGitRepo();
	const bin = path.join(tmpDir(), "codex-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
git -C "${dir}" checkout -qb hijack
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
exit 0
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /switched branches/i);
	assert.match(res.stderr, /cancelled.*original request/i);
	const events = readLedger(dir);
	const request = events.find((event) => event.event === "review-request");
	const terminals = events.filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminals.length, 1, "the captured request gets exactly one terminal outcome");
	assert.equal(terminals[0].event, "review-cancelled");
	assert.equal(terminals[0].branch, "feature");
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "the private brief is removed");

	await exec("git", ["-C", dir, "checkout", "-q", "feature"]);
	const configPath = path.join(dir, ".stdd", "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.capabilities.crossCli = false;
	fs.writeFileSync(configPath, JSON.stringify(config));
	const gate = await run(["status", "--gate"], { cwd: dir });
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
});

test("a task switch while the reviewer runs cancels the original request, not the new task", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const bin = path.join(tmpDir(), "codex-task-switch-stub");
	fs.writeFileSync(
		bin,
		`#!/bin/sh
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
node "${CLI}" task finish > /dev/null
node "${CLI}" task start "replacement task" > /dev/null
printf '%s' '{"summary": "sound", "findings": []}' > "$out"
`,
	);
	fs.chmodSync(bin, 0o755);
	const res = await run(["review", "--via", "codex"], {
		cwd: dir,
		env: envWith(bin),
	});
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /active task changed/i);
	assert.match(res.stderr, /cancelled.*original request/i);
	const events = readLedger(dir);
	const request = events.find((event) => event.event === "review-request");
	const terminals = events.filter(
		(event) =>
			(event.event === "review" || event.event === "review-cancelled") && event.request === request.id,
	);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].event, "review-cancelled");
	assert.equal(terminals[0].taskId, request.taskId);
	assert.ok(!fs.existsSync(path.dirname(request.briefPath)), "the private brief is removed");
	const replacement = events.find(
		(event) => event.event === "task-start" && event.name === "replacement task",
	);
	assert.ok(replacement, "the replacement task exists");
	assert.equal(typeof replacement.id, "string");
	assert.notEqual(replacement.id, request.taskId);
	assert.notEqual(terminals[0].taskId, replacement.id);
});

test("a task switch while review --result is being read records nothing", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	const briefPath = prep.stdout.match(/brief written to (\S+)/)?.[1];
	const fifo = path.join(tmpDir(), "review-result.fifo");
	const ready = path.join(tmpDir(), "writer-ready");
	const release = path.join(tmpDir(), "writer-release");
	await exec("mkfifo", [fifo]);
	const writer = exec(
		"sh",
		[
			"-c",
			'exec 3>"$1"; : > "$2"; while [ ! -e "$3" ]; do sleep 0.01; done; printf %s "$4" >&3',
			"review-writer",
			fifo,
			ready,
			release,
			'{"summary":"sound","findings":[]}',
		],
		{ cwd: dir },
	);
	const submitted = run(["review", "--result", fifo], { cwd: dir });
	for (let attempts = 0; !fs.existsSync(ready) && attempts < 500; attempts++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(fs.existsSync(ready), "review submit reached the blocking result read");

	await run(["task", "finish"], { cwd: dir });
	await run(["task", "start", "replacement task"], { cwd: dir });
	fs.writeFileSync(release, "");
	await writer;
	const res = await submitted;

	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /active task changed/i);
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review").length,
		0,
		"the replacement task receives no verdict",
	);
	assert.ok(fs.existsSync(briefPath), "the still-open request keeps its private brief for cleanup");
});

test("a task switch after the final result check cannot attach approval to the replacement task", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const planPath = path.join(dir, ".stdd", "plan.md");
	const checkedPlan = "# Replacement plan\n\n- [x] closing review [review:]\n";
	const uncheckedPlan = "# Replacement plan\n\n- [ ] closing review [review:]\n";
	fs.writeFileSync(planPath, checkedPlan);
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);

	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');
	const hookPath = path.join(tmpDir(), "switch-after-check.mjs");
	fs.writeFileSync(
		hookPath,
		`import fs from "node:fs";
import { spawnSync } from "node:child_process";

const originalRead = fs.readFileSync;
let resultRead = false;
let switched = false;
fs.readFileSync = function (target, ...args) {
  const value = originalRead.call(this, target, ...args);
  if (String(target) === ${JSON.stringify(resultPath)}) resultRead = true;
  if (resultRead && !switched && String(target) === ${JSON.stringify(planPath)}) {
    switched = true;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    for (const command of [["task", "finish"], ["task", "start", "replacement task"]]) {
      const run = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...command], {
        cwd: ${JSON.stringify(dir)},
        env,
        encoding: "utf8",
      });
      if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    }
    fs.writeFileSync(${JSON.stringify(planPath)}, ${JSON.stringify(uncheckedPlan)});
  }
  return value;
};
`,
	);

	const submitted = await run(["review", "--result", resultPath], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${hookPath}` },
	});
	assert.equal(submitted.code, 1, submitted.stdout + submitted.stderr);
	assert.match(submitted.stderr, /active task changed/i);
	const events = readLedger(dir);
	const replacement = events.filter((event) => event.event === "task-start").at(-1);
	assert.equal(replacement.name, "replacement task");
	assert.ok(
		!events.some((event) => event.event === "review" && event.taskId === replacement.id),
		"task A's result must never become task B's verdict",
	);
	assert.equal(
		events.filter((event) => event.event === "review").length,
		0,
		"a task switch in the final record window records no verdict",
	);
	assert.equal(fs.readFileSync(planPath, "utf8"), uncheckedPlan);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review, null, "the replacement task has no forged approval");
	assert.equal(status.plan.review.done, false);
});

test("a plan change at the verdict lock records no approval for the old snapshot", async () => {
	const { dir } = await tmpGitRepo();
	await run(["task", "start", "reviewed task"], { cwd: dir });
	const planPath = path.join(dir, ".stdd", "plan.md");
	const prep = await run(["review", "--via", "subagent"], { cwd: dir });
	assert.equal(prep.code, 0, prep.stdout + prep.stderr);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary":"sound","findings":[]}');

	const submitted = await run(["review", "--result", resultPath], {
		cwd: dir,
		env: { ...process.env, ...changePlanAtVerdictLockEnv(resultPath, planPath) },
	});
	assert.equal(submitted.code, 1, submitted.stdout + submitted.stderr);
	assert.match(submitted.stderr, /checkout changed.*nothing recorded/i);
	assert.match(fs.readFileSync(planPath, "utf8"), /injected after final snapshot/);
	assert.equal(
		readLedger(dir).filter((event) => event.event === "review").length,
		0,
		"the old plan snapshot receives no approval",
	);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.review, null);
	assert.equal(status.plan.review.done, false);
});

test("an untracked symlink is hashed by its target path, not the target's content", async () => {
	const { dir } = await tmpGitRepo();
	const outside = path.join(tmpDir(), "target.txt");
	fs.writeFileSync(outside, "v1");
	fs.symlinkSync(outside, path.join(dir, "link.txt"));
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal((await run(["status", "--gate"], { cwd: dir })).code, 0);
	// the file OUTSIDE the repository changes — the review must stay fresh
	fs.writeFileSync(outside, "v2");
	const still = await run(["status", "--gate"], { cwd: dir });
	assert.equal(still.code, 0, still.stdout);
});

test("--result never completes a codex request — no forged provenance", async () => {
	const { dir } = await tmpGitRepo();
	const id = "rev-deadbeef";
	const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-review-"));
	fs.chmodSync(briefDir, 0o700);
	const briefPath = path.join(briefDir, `${id}.md`);
	fs.writeFileSync(briefPath, "private brief for an interrupted CLI request", { mode: 0o600 });
	fs.writeFileSync(
		path.join(dir, ".stdd", "ledger.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			event: "review-request",
			id,
			via: "codex",
			snapshot: "captured",
			brief: "sha256:captured",
			briefPath,
			privateState: privateStateFor(briefDir),
			branch: "feature",
		})}\n`,
	);
	const resultPath = path.join(tmpDir(), "result.json");
	fs.writeFileSync(resultPath, '{"summary": "hand-fed", "findings": []}');
	const res = await run(["review", "--result", resultPath], { cwd: dir });
	assert.equal(res.code, 1, res.stdout + res.stderr);
	assert.match(res.stderr, /codex/);
	assert.equal(readLedger(dir).filter((e) => e.event === "review").length, 0);
	const cleaned = await run(["review", "--cleanup"], { cwd: dir });
	assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
	assert.ok(!fs.existsSync(briefDir));
});

test("ledger-derived approval leaves every parsed plan checkbox unchanged", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	fs.writeFileSync(
		planPath,
		[
			"# P",
			"",
			"```",
			"- [ ] fenced example [review:]",
			"```",
			"",
			"- [x] impl",
			"- [ ] closing review [review:]",
			"",
			"## Deferred",
			"",
			"- [ ] deferred cut [review:]",
			"",
		].join("\n"),
	);
	const before = fs.readFileSync(planPath, "utf8");
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(fs.readFileSync(planPath, "utf8"), before);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("ledger-derived approval recognizes the real tag without rewriting code mentions", async () => {
	const { dir } = await tmpGitRepo();
	const planPath = path.join(dir, ".stdd", "plan.md");
	const before = "# P\n\n- [ ] tests cover the `[review:]` tag\n- [ ] closing review [review:]\n";
	fs.writeFileSync(planPath, before);
	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	assert.equal(fs.readFileSync(planPath, "utf8"), before);
	const status = JSON.parse((await run(["status", "--local", "--json"], { cwd: dir })).stdout);
	assert.equal(status.plan.review.done, true);
});

test("status names stdd review for an open [review:] item and shows the review line", async () => {
	const { dir } = await tmpGitRepo();
	const env = {
		...process.env,
		PATH: `${path.join(dir, "fake-bin")}:${process.env.PATH}`,
	};
	fs.mkdirSync(path.join(dir, "fake-bin"));
	fs.writeFileSync(
		path.join(dir, "fake-bin", "gh"),
		'#!/bin/sh\necho "no pull requests found" >&2; exit 1\n',
	);
	fs.chmodSync(path.join(dir, "fake-bin", "gh"), 0o755);
	await run(["docs", "not-applicable", "--reason", "test fixture"], {
		cwd: dir,
	});
	await run(["red", "--", "node", "-e", "process.exit(1)"], { cwd: dir });
	fs.appendFileSync(path.join(dir, "impl.js"), "// implementation after red\n");
	await run(["verify", "--", "node", "-e", ""], { cwd: dir });
	const s = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.match(s.next, /stdd review/);

	const clean = stubCodex('{"summary": "sound", "findings": []}');
	await run(["review", "--via", "codex"], { cwd: dir, env: envWith(clean) });
	const after = JSON.parse((await run(["status", "--json"], { cwd: dir, env })).stdout);
	assert.equal(after.review.verdict, "approved");
	const human = await run(["status"], { cwd: dir, env });
	assert.match(human.stdout, /review: approved via codex/);
});
