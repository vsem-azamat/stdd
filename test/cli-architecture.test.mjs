// Characterization/architecture gate for the CLI decomposition described in
// README.md's "Development" section: an acyclic, flat `cli/*.mjs` module
// graph, with `cli/stdd.mjs` owning argument order and dispatch only.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PKG_ROOT, "cli", "stdd.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;

function tmpRepo() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stdd-arch-test-"));
}

async function run(args, opts = {}) {
	try {
		const { stdout, stderr } = await exec("node", [CLI, ...args], opts);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

// --- golden CLI behavior ---

test("no-arg invocation prints usage and exits 0", async () => {
	const res = await run([], { cwd: tmpRepo() });
	assert.equal(res.code, 0);
	assert.match(res.stdout, /^Usage: stdd </);
	assert.equal(res.stderr, "");
});

test('unknown command "workr" suggests "worker"', async () => {
	const res = await run(["workr"], { cwd: tmpRepo() });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /unknown command "workr"/);
	assert.match(res.stderr, /did you mean "worker"/);
});

test("an unknown generic flag fails fast", async () => {
	const res = await run(["doctor", "--frobnicate"], { cwd: tmpRepo() });
	assert.equal(res.code, 1);
	assert.match(res.stderr, /unknown flag: --frobnicate/);
});

test("version and --version both print the installed package version", async () => {
	const dir = tmpRepo();
	const viaCommand = await run(["version"], { cwd: dir });
	const viaFlag = await run(["--version"], { cwd: dir });
	assert.equal(viaCommand.code, 0);
	assert.equal(viaFlag.code, 0);
	assert.equal(viaCommand.stdout.trim(), VERSION);
	assert.equal(viaFlag.stdout.trim(), VERSION);
});

// --- flat, acyclic module graph invariant ---

test("all runtime cli entries are regular flat .mjs files", () => {
	const cliDir = path.join(PKG_ROOT, "cli");
	const entries = fs.readdirSync(cliDir, { withFileTypes: true });
	assert.ok(entries.length > 0, "cli/ must not be empty");
	for (const entry of entries) {
		assert.ok(entry.isFile(), `cli/${entry.name} must be a regular file, not a directory or symlink`);
		assert.match(entry.name, /\.mjs$/, `cli/${entry.name} must be a flat .mjs module`);
		if (entry.name !== "stdd.mjs") {
			const source = fs.readFileSync(path.join(cliDir, entry.name), "utf8");
			assert.doesNotMatch(source, /process\.argv/, `cli/${entry.name} must be import-pure`);
		}
	}
});

function relativeImportSpecifiers(source) {
	const specifiers = new Set();
	const re = /\bfrom\s+["']([^"']+)["']/g;
	let match = re.exec(source);
	while (match) {
		if (match[1].startsWith(".")) specifiers.add(match[1]);
		match = re.exec(source);
	}
	return [...specifiers];
}

function buildRelativeImportGraph(rootFile) {
	const graph = new Map();
	const visit = (file) => {
		if (graph.has(file)) return;
		const deps = relativeImportSpecifiers(fs.readFileSync(file, "utf8")).map((specifier) =>
			path.resolve(path.dirname(file), specifier),
		);
		graph.set(file, deps);
		for (const dep of deps) visit(dep);
	};
	visit(rootFile);
	return graph;
}

function findImportCycle(graph, rootFile) {
	const color = new Map();
	const stack = [];
	const visit = (node) => {
		color.set(node, "in-progress");
		stack.push(node);
		for (const dep of graph.get(node) ?? []) {
			const state = color.get(dep) ?? "unvisited";
			if (state === "in-progress") return [...stack.slice(stack.indexOf(dep)), dep];
			if (state === "unvisited") {
				const cycle = visit(dep);
				if (cycle) return cycle;
			}
		}
		stack.pop();
		color.set(node, "done");
		return null;
	};
	return visit(rootFile);
}

test("relative-import graph rooted at cli/stdd.mjs is acyclic", () => {
	const graph = buildRelativeImportGraph(CLI);
	assert.ok(graph.size > 1, "the graph must actually traverse imports, not just the root");
	const cycle = findImportCycle(graph, CLI);
	assert.equal(
		cycle,
		null,
		cycle && `import cycle: ${cycle.map((f) => path.relative(PKG_ROOT, f)).join(" -> ")}`,
	);
});

test("cohesive generated-files subsystem owns identity, cleanup, publication, and drift", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "generated-files.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/generated-files.mjs must exist");
	const generatedFiles = await import(pathToFileURL(modulePath).href);
	assert.deepEqual(Object.keys(generatedFiles).sort(), [
		"CLEANUP_JOURNAL_REL",
		"KNOWN_CAPABILITIES",
		"KNOWN_CI",
		"KNOWN_TOOLS",
		"NPM_RUNNER",
		"PKG_ROOT",
		"SOURCE_RUNNER",
		"STAMP",
		"VERSION",
		"finalizeGeneratedFiles",
		"loadLocalPlaybooks",
		"loadPlaybooks",
		"readManifestDocument",
		"readManifestFiles",
		"recoverCleanupJournal",
		"renderInstalledMethod",
		"scanGeneratedDrift",
		"validateAdapterSelection",
	]);

	const source = fs.readFileSync(modulePath, "utf8");
	assert.doesNotMatch(source, /from ["']\.\/stdd\.mjs["']/);

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/generated-files\.mjs["']/);
	assert.doesNotMatch(
		entry,
		/function (validateAdapterSelection|validateManifestTargets|loadPlaybooks|loadLocalPlaybooks|isRecognizedGeneratedOutput|readManifestDocument|readManifestFiles|writeCleanupJournal|readCleanupJournal|openCleanupJournalQuarantine|clearCleanupJournal|inspectCleanupEntryState|cleanupJournalCommitted|rollbackCleanupEntryThroughHeldParent|rollbackCleanupJournal|recoverCleanupJournal|publishManifestDurably|inspectManifestOutput|removeInspectedManifestOutput|renderInstalledMethod|discoverGeneratedOutputs|scanGeneratedDrift)\s*\(/,
	);
	assert.doesNotMatch(
		entry,
		/const (PKG_ROOT|VERSION|KNOWN_TOOLS|KNOWN_CI|KNOWN_CAPABILITIES|CLEANUP_JOURNAL_REL|SHIPPED_PLAYBOOK_FILES|MANAGED_PLAYBOOK_REGISTRY|KNOWN_MANAGED_PLAYBOOK_FILES|STAMP|NPM_RUNNER|SOURCE_RUNNER|CLEANUP_JOURNAL_QUARANTINE_README|MANIFEST_QUARANTINE_BASENAME|NO_PROJECT_LOG_METHOD_PREAMBLE)\s*=/,
	);
	assert.doesNotMatch(entry, /Object\.entries\(oldFiles\)/);
	assert.doesNotMatch(entry, /publishManifestDurably/);
});

test("cohesive init subsystem owns init, configure, and interview orchestration", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "init.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/init.mjs must exist");
	const initModule = await import(pathToFileURL(modulePath).href);
	assert.deepEqual(Object.keys(initModule).sort(), ["configure", "init", "interview"]);
	for (const name of ["configure", "init", "interview"]) {
		assert.equal(typeof initModule[name], "function", `init.mjs must export ${name}`);
	}

	const source = fs.readFileSync(modulePath, "utf8");
	assert.match(source, /from ["']\.\/generated-files\.mjs["']/);
	assert.match(source, /finalizeGeneratedFiles\s*\(/);
	assert.doesNotMatch(source, /from ["']\.\/(check|stdd)\.mjs["']/);

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/init\.mjs["']/);
	assert.doesNotMatch(
		entry,
		/(?:const PRE_PUSH_HEADER\s*=|(?:async )?function (prePushHook|isGeneratedPrePushHook|readConfigForWrite|writeCapabilities|writeReviewVia|makePrompter|askReviewVia|recommendedReviewVia|interview|configure|init)\s*\()/,
	);
});

test("cohesive check subsystem owns repository scanning, readiness, and doctor", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "check.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/check.mjs must exist");
	const checkModule = await import(pathToFileURL(modulePath).href);
	assert.deepEqual(Object.keys(checkModule).sort(), ["check", "doctor"]);
	for (const name of ["check", "doctor"]) {
		assert.equal(typeof checkModule[name], "function", `check.mjs must export ${name}`);
	}

	const source = fs.readFileSync(modulePath, "utf8");
	assert.match(source, /from ["']\.\/generated-files\.mjs["']/);
	assert.doesNotMatch(source, /from ["']\.\/(init|stdd)\.mjs["']/);

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/check\.mjs["']/);
	assert.doesNotMatch(
		entry,
		/function (listTrackedFiles|scanRepo|trackedBookkeeping|addedFiles|check|reportReadiness|doctor)\s*\(/,
	);
});

test("cli/path-bytes.mjs exists and exports the ten path-bytes primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "path-bytes.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/path-bytes.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedExports = [
		"splitNul",
		"pathForMatch",
		"pathForView",
		"latinGlob",
		"absPathBuf",
		"parentPathBuf",
		"realPathBuf",
		"bufferPathIsWithin",
		"displayPath",
		"viewPath",
	];
	for (const name of expectedExports) {
		assert.equal(typeof mod[name], "function", `path-bytes.mjs must export ${name}`);
	}
});

test("cli/held-fs.mjs exists and exports the held-filesystem primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "held-fs.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/held-fs.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedExports = [
		"openHeldLinuxRepoDirectory",
		"openOrCreateHeldGeneratedParent",
		"publishGeneratedFileSafely",
	];
	for (const name of expectedExports) {
		assert.equal(typeof mod[name], "function", `held-fs.mjs must export ${name}`);
	}
});

test("cli/worker-fs.mjs exists and exports the worker path/publication primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "worker-fs.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/worker-fs.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedExports = [
		"workerPathForMatch",
		"workerViewPath",
		"openWorkerPublicationParent",
		"publishWorkerFile",
		"assertHeldWorkerDirectory",
		"publishWorkerSymlink",
		"sameWorkerState",
		"readWorkerPathState",
		"writeNewWorkerPath",
		"quarantineWorkerDeletion",
	];
	for (const name of expectedExports) {
		assert.equal(typeof mod[name], "function", `worker-fs.mjs must export ${name}`);
	}
	assert.equal(
		typeof mod.WORKER_DELETIONS_REL,
		"string",
		"worker-fs.mjs must export WORKER_DELETIONS_REL",
	);
});

test("cli/worker-metadata.mjs exists and exports the managed-worker metadata surface", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "worker-metadata.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/worker-metadata.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	for (const name of ["createWorkerId", "findWorkerRoot", "readWorkerMetadata"]) {
		assert.equal(typeof mod[name], "function", `worker-metadata.mjs must export ${name}`);
	}
	assert.equal(typeof mod.WORKER_METADATA_REL, "string");
	assert.ok(mod.WORKER_ID_PATTERN instanceof RegExp);
	assert.equal(typeof mod.WORKER_METADATA_SCHEMA, "number");
	assert.ok(mod.WORKER_EVIDENCE_EVENTS instanceof Set);
	assert.ok(mod.WORKER_LOCAL_COMMANDS instanceof Set);
	const source = fs.readFileSync(CLI, "utf8");
	assert.match(source, /from ["']\.\/worker-metadata\.mjs["']/);
	assert.doesNotMatch(source, /const WORKER_METADATA_SCHEMA\s*=/);
});

test("cohesive ledger subsystem owns config, validation, and task state outside the entry module", async () => {
	const config = await import(pathToFileURL(path.join(PKG_ROOT, "cli", "config.mjs")).href);
	const validation = await import(
		pathToFileURL(path.join(PKG_ROOT, "cli", "state-validation.mjs")).href
	);
	const ledger = await import(pathToFileURL(path.join(PKG_ROOT, "cli", "ledger.mjs")).href);
	assert.equal(typeof config.loadConfig, "function");
	assert.ok(validation.MANIFEST_HASH_PATTERN instanceof RegExp);
	assert.deepEqual(Object.keys(validation).sort(), [
		"MANIFEST_HASH_PATTERN",
		"isLedgerStringArray",
		"isPlainLedgerRecord",
		"isReviewInodeIdentity",
		"sameReviewPrivateState",
	]);
	for (const name of [
		"isPlainLedgerRecord",
		"isLedgerStringArray",
		"isReviewInodeIdentity",
		"sameReviewPrivateState",
	]) {
		assert.equal(typeof validation[name], "function", `state-validation.mjs must export ${name}`);
	}
	assert.equal(ledger.isReviewInodeIdentity, undefined);
	assert.equal(ledger.sameReviewPrivateState, undefined);
	for (const name of [
		"resolveRepoDir",
		"currentBranch",
		"rawLedger",
		"loadLedger",
		"scopeLedgerForCheckout",
		"ledgerAppendContext",
		"appendLedger",
		"withLedgerLock",
		"withCapturedLedgerIdentity",
		"taskLifecycleState",
		"startTask",
		"finishTask",
		"resetTask",
		"currentTaskPlan",
		"defer",
		"gitChangedPaths",
		"gitWorkingPaths",
	]) {
		assert.equal(typeof ledger[name], "function", `ledger.mjs must export ${name}`);
	}
	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/ledger\.mjs["']/);
	assert.doesNotMatch(entry, /function isPlainLedgerRecord\s*\(/);
	const workerMetadata = fs.readFileSync(path.join(PKG_ROOT, "cli", "worker-metadata.mjs"), "utf8");
	assert.match(workerMetadata, /from ["']\.\/state-validation\.mjs["']/);
	assert.doesNotMatch(workerMetadata, /function isPlainLedgerRecord\s*\(/);
});

test("cohesive snapshot subsystem owns checkout, dirty, worker, and review observations", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "snapshot.mjs");
	const snapshot = await import(pathToFileURL(modulePath).href);
	for (const name of [
		"dirtySnapshot",
		"checkoutSnapshot",
		"reviewSnapshot",
		"captureReviewMaterial",
		"inspectReviewPath",
		"workerCurrentStates",
		"workerDirtySnapshot",
	]) {
		assert.equal(typeof snapshot[name], "function", `snapshot.mjs must export ${name}`);
	}
	assert.equal(snapshot.sameReviewFileObservation, undefined);
	assert.equal(snapshot.DIRTY_FINGERPRINT_READ_LIMIT, 40_000);

	const entry = fs.readFileSync(CLI, "utf8");
	assert.doesNotMatch(
		entry,
		/function (dirtySnapshot|checkoutSnapshot|reviewSnapshot|captureReviewMaterial|inspectReviewPath|fingerprintDirtyPath|fingerprintBoundedReviewDescriptor|sameReviewFileObservation|workerDirtySnapshot|workerTreeFiles)\s*\(/,
	);
	assert.doesNotMatch(entry, /const DIRTY_FINGERPRINT_READ_LIMIT\s*=/);
	assert.doesNotMatch(entry, /const REVIEW_EXEMPT\s*=/);

	const source = fs.readFileSync(modulePath, "utf8");
	assert.doesNotMatch(source, /function sameReviewFileObservation\s*\(/);
	assert.match(source, /from ["']\.\/worker-fs\.mjs["']/);
	assert.match(source, /from ["']\.\/worker-metadata\.mjs["']/);
	assert.doesNotMatch(source, /from ["']\.\/stdd\.mjs["']/);
});

test("cohesive review subsystem owns brief, settlement, and verdict outside the entry", async () => {
	const heldPublication = await import(
		pathToFileURL(path.join(PKG_ROOT, "sdk", "held-publication.mjs")).href
	);
	assert.deepEqual(Object.keys(heldPublication).sort(), [
		"assertHeldDirectoryAttached",
		"atomicWriteFile",
		"closeHeldDirectory",
		"ensureHeldChildDirectory",
		"isHeldDirectorySafetyError",
		"openHeldDirectory",
		"openHeldDirectoryByIdentity",
		"publishHeldParentFile",
		"quarantineStaleSkill",
		"readHeldRegularFile",
		"requireSafeDirectory",
		"requireSafeRegularFile",
		"requireSafeTree",
		"sameFileIdentity",
		"sameHeldFileObservation",
		"samePublicationObservation",
		"samePublicationPayload",
	]);
	const observation = Object.fromEntries(
		["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map((field, index) => [
			field,
			BigInt(index + 1),
		]),
	);
	assert.equal(heldPublication.sameHeldFileObservation(observation, { ...observation }), true);
	for (const field of Object.keys(observation)) {
		assert.equal(
			heldPublication.sameHeldFileObservation(observation, {
				...observation,
				[field]: observation[field] + 1n,
			}),
			false,
			`held observation must bind ${field}`,
		);
	}
	const millisecondObservation = { ...observation, mtimeMs: 6, ctimeMs: 7 };
	delete millisecondObservation.mtimeNs;
	delete millisecondObservation.ctimeNs;
	assert.equal(
		heldPublication.sameHeldFileObservation(millisecondObservation, {
			...millisecondObservation,
		}),
		false,
		"held observations require nanosecond bigint timestamps",
	);
	const reviewFs = await import(pathToFileURL(path.join(PKG_ROOT, "cli", "review-fs.mjs")).href);
	const review = await import(pathToFileURL(path.join(PKG_ROOT, "cli", "review.mjs")).href);
	for (const name of [
		"captureReviewPrivateState",
		"readVerifiedReviewArtifact",
		"removeReviewBrief",
		"reviewPrivateDirectoryExists",
	]) {
		assert.equal(typeof reviewFs[name], "function", `review-fs.mjs must export ${name}`);
	}
	for (const name of ["reviewCleanup", "reviewRequestAnswered", "reviewRun", "reviewSubmit"]) {
		assert.equal(typeof review[name], "function", `review.mjs must export ${name}`);
	}

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/review\.mjs["']/);
	assert.doesNotMatch(
		entry,
		/function (enumerateChangedFiles|enumerateUntracked|governingDocsSection|buildReviewBrief|recordReview|removeReviewBrief|settleReviewPrivateDirectory|captureReviewSettlementBoundary|readVerifiedReviewArtifact|cancelCapturedReviewRequest|reviewCleanup|reviewSubmit|reviewRun)\s*\(/,
	);
	assert.doesNotMatch(
		entry,
		/const (MAX_REVIEW_DIFF_BYTES|REVIEW_REQUEST_ID_PATTERN|REVIEW_REQUEST_RANDOM_BYTES|REVIEW_QUARANTINE_README|REVIEW_PRIVATE_COMPANIONS)\s*=/,
	);
	assert.doesNotMatch(entry, /from ["']\.\/path-bytes\.mjs["']/);

	const source = fs.readFileSync(path.join(PKG_ROOT, "cli", "review.mjs"), "utf8");
	assert.match(source, /from ["']\.\/review-fs\.mjs["']/);
	assert.doesNotMatch(source, /from ["']\.\/stdd\.mjs["']/);
	const fsSource = fs.readFileSync(path.join(PKG_ROOT, "cli", "review-fs.mjs"), "utf8");
	assert.match(fsSource, /openHeldDirectoryByIdentity/);
	assert.match(fsSource, /assertHeldDirectoryAttached/);
	assert.match(fsSource, /closeHeldDirectory/);
	assert.doesNotMatch(fsSource, /from ["']\.\/(ledger|review|snapshot|stdd)\.mjs["']/);
});

test("cohesive CI subsystem owns forge observation and terminal settlement outside the entry", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "ci.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/ci.mjs must exist");
	const ci = await import(pathToFileURL(modulePath).href);
	assert.deepEqual(Object.keys(ci).sort(), ["ciCommand", "statusPr"]);
	assert.equal(typeof ci.statusPr, "function");
	assert.equal(typeof ci.ciCommand, "function");

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/ci\.mjs["']/);
	assert.doesNotMatch(entry, /function (statusPr|normalizeCheck|ghPrChecks|ciCommand)\s*\(/);

	const source = fs.readFileSync(modulePath, "utf8");
	assert.doesNotMatch(source, /from ["']\.\/stdd\.mjs["']/);
});

test("cohesive status subsystem owns derivation, review gate, and Stop-hook protocol", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "status.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/status.mjs must exist");
	const status = await import(pathToFileURL(modulePath).href);
	assert.deepEqual(Object.keys(status).sort(), ["status", "statusGate", "stopHookCmd"]);
	for (const name of ["status", "statusGate", "stopHookCmd"]) {
		assert.equal(typeof status[name], "function", `status.mjs must export ${name}`);
	}

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/status\.mjs["']/);
	assert.doesNotMatch(
		entry,
		/function (status|softGateInputs|unavailableReviewRouteReason|gateReasons|statusGate|stopHookCmd)\s*\(/,
	);

	const source = fs.readFileSync(modulePath, "utf8");
	assert.match(source, /from ["']\.\/ci\.mjs["']/);
	assert.match(source, /from ["']\.\/review\.mjs["']/);
	assert.doesNotMatch(source, /from ["']\.\/stdd\.mjs["']/);
});

test("cohesive evidence subsystem owns generation and PR validation outside the entry", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "evidence.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/evidence.mjs must exist");
	const evidence = await import(pathToFileURL(modulePath).href);
	assert.deepEqual(Object.keys(evidence).sort(), ["checkPr", "evidence"]);
	assert.equal(typeof evidence.evidence, "function");
	assert.equal(typeof evidence.checkPr, "function");

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/evidence\.mjs["']/);
	assert.doesNotMatch(
		entry,
		/function (resolveLivePr|evidence|checkPr|verifyEvidenceAgainstDiff|evidencePath)\s*\(/,
	);

	const source = fs.readFileSync(modulePath, "utf8");
	assert.doesNotMatch(source, /from ["']\.\/stdd\.mjs["']/);
});

test("cohesive worker subsystem owns create, collect, scope, and slice outside the entry", async () => {
	const scope = await import(pathToFileURL(path.join(PKG_ROOT, "cli", "scope.mjs")).href);
	const worker = await import(pathToFileURL(path.join(PKG_ROOT, "cli", "worker.mjs")).href);
	for (const name of ["validateScopeDeclaration", "workerScopeViolations", "sliceNew", "scopeCheck"]) {
		assert.equal(typeof scope[name], "function", `scope.mjs must export ${name}`);
	}
	for (const name of ["workerCreate", "workerCollect"]) {
		assert.equal(typeof worker[name], "function", `worker.mjs must export ${name}`);
	}

	const entry = fs.readFileSync(CLI, "utf8");
	assert.match(entry, /from ["']\.\/worker\.mjs["']/);
	assert.match(entry, /from ["']\.\/scope\.mjs["']/);
	assert.doesNotMatch(
		entry,
		/function (workerCreate|workerCollect|workerVisiblePaths|validateScopeDeclaration|workerScopeViolations|classifyScopePath|sliceNew|workerScopeCheck|scopeCheck)\s*\(/,
	);

	const workerSource = fs.readFileSync(path.join(PKG_ROOT, "cli", "worker.mjs"), "utf8");
	assert.match(workerSource, /from ["']\.\/scope\.mjs["']/);
	assert.doesNotMatch(workerSource, /from ["']\.\/stdd\.mjs["']/);
	const scopeSource = fs.readFileSync(path.join(PKG_ROOT, "cli", "scope.mjs"), "utf8");
	assert.doesNotMatch(scopeSource, /from ["']\.\/(stdd|worker)\.mjs["']/);
});

test("checkout recorders own docs and run recording outside the entry", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "recorders.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/recorders.mjs must exist");
	const recorders = await import(pathToFileURL(modulePath).href);
	assert.deepEqual(Object.keys(recorders).sort(), ["recordDocs", "recordRun"]);
	assert.equal(typeof recorders.recordDocs, "function");
	assert.equal(typeof recorders.recordRun, "function");

	const entry = fs.readFileSync(CLI, "utf8");
	assert.ok(entry.split("\n").length - 1 < 1_000, "cli/stdd.mjs must remain dispatch-only");
	assert.match(entry, /process\.argv/);
	assert.match(entry, /from ["']\.\/recorders\.mjs["']/);
	assert.doesNotMatch(entry, /function (recordDocs|recordRun)\s*\(/);
	assert.doesNotMatch(entry, /const EXCERPT_LIMIT\s*=/);

	const source = fs.readFileSync(modulePath, "utf8");
	assert.match(source, /from ["']\.\/snapshot\.mjs["']/);
	assert.doesNotMatch(source, /from ["']\.\/stdd\.mjs["']/);
});

test("cli/runtime.mjs exists and exports the generic process/error primitives", async () => {
	const modulePath = path.join(PKG_ROOT, "cli", "runtime.mjs");
	assert.ok(fs.existsSync(modulePath), "cli/runtime.mjs must exist");
	const mod = await import(pathToFileURL(modulePath).href);
	const expectedFunctionExports = [
		"fail",
		"statePath",
		"git",
		"subprocessError",
		"requireHeldParentPublicationPlatform",
		"requireReviewSettlementPlatform",
	];
	for (const name of expectedFunctionExports) {
		assert.equal(typeof mod[name], "function", `runtime.mjs must export ${name}`);
	}
	assert.equal(
		typeof mod.MAX_SUBPROCESS_BUFFER,
		"number",
		"runtime.mjs must export MAX_SUBPROCESS_BUFFER",
	);

	const entry = fs.readFileSync(CLI, "utf8");
	assert.doesNotMatch(
		entry,
		/function (fail|statePath|git|requireHeldParentPublicationPlatform|requireReviewSettlementPlatform)\s*\(/,
	);
	assert.doesNotMatch(entry, /const (MAX_SUBPROCESS_BUFFER|subprocessError)\s*=/);
});

test("the entry normalizes attached values without exporting parsing", () => {
	const entry = fs.readFileSync(CLI, "utf8");

	for (const flag of [
		"base",
		"review-via",
		"max-rounds",
		"capabilities",
		"interval",
		"pr",
		"ci",
		"tools",
	]) {
		assert.doesNotMatch(
			entry,
			new RegExp(`arg === "--${flag}" \\|\\| arg\\.startsWith\\("--${flag}="\\)`),
		);
	}
	assert.equal(
		(entry.match(/arg === "--timeout" \|\| arg\.startsWith\("--timeout="\)/g) ?? []).length,
		1,
		"only review's special grammar parses --timeout independently",
	);
	assert.doesNotMatch(entry, /from ["']\.\/(?:parser|commands|dispatch)\.mjs["']/);
});
