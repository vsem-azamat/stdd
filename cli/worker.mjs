// --- managed gitless workers: create and collect ---
//
// Owns the sandbox lifecycle bound to one task: the source enumeration and
// baseline snapshot `worker create` publishes, and the preflight/import/evidence
// transaction `worker collect` runs against that binding. Both are
// source-checkout-owned. It has no dependency on the entry module.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoPath } from "../sdk/path.mjs";
import {
	appendLedger,
	currentBranch,
	isStateExemptPath,
	isStateLedgerEvent,
	ledgerAppendContext,
	loadLedger,
	rawLedger,
	scopeLedgerForCheckout,
	withCapturedLedgerIdentity,
} from "./ledger.mjs";
import { sha256 } from "./lib.mjs";
import { splitNul } from "./path-bytes.mjs";
import { fail, MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { validateScopeDeclaration, workerScopeViolations } from "./scope.mjs";
import { workerCurrentStates } from "./snapshot.mjs";
import { isPlainLedgerRecord } from "./state-validation.mjs";
import {
	publishWorkerFile,
	publishWorkerSymlink,
	quarantineWorkerDeletion,
	readWorkerPathState,
	sameWorkerState,
	WORKER_DELETIONS_REL,
	workerViewPath,
	writeNewWorkerPath,
} from "./worker-fs.mjs";
import {
	createWorkerId,
	readWorkerMetadata,
	WORKER_EVIDENCE_EVENTS,
	WORKER_METADATA_REL,
	WORKER_METADATA_SCHEMA,
} from "./worker-metadata.mjs";

function workerVisiblePaths(cwd) {
	const output = splitNul(
		execFileSync("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		}),
	);
	const paths = [];
	for (const raw of output) {
		if (raw.length === 0) continue;
		const relative = raw.toString("utf8");
		if (!Buffer.from(relative, "utf8").equals(raw)) {
			fail("worker create does not support a non-UTF-8 Git path");
		}
		if (
			relative.split("/").includes(".git") ||
			isStateExemptPath(cwd, relative) ||
			relative === WORKER_METADATA_REL
		) {
			continue;
		}
		try {
			resolveRepoPath(cwd, relative, `worker source path ${JSON.stringify(relative)}`);
		} catch (err) {
			fail(err.message);
		}
		paths.push(relative);
	}
	return [...new Set(paths)].sort();
}

export function workerCreate(cwd, destinationInput, frozenPaths, allowedPaths) {
	if (process.platform !== "linux") fail("worker create requires Linux held-parent support");
	validateScopeDeclaration("worker create", frozenPaths, allowedPaths);
	const context = ledgerAppendContext(cwd, { event: "worker-create" });
	if (!context.task) fail('worker create needs an active task — run `stdd task start "<name>"`');
	const scoped = scopeLedgerForCheckout(cwd, context.branch);
	const docs = scoped.events.filter((event) => event.event === "docs").at(-1);
	if (!docs) fail("worker create needs a recorded docs decision");
	const destinationLexical = path.resolve(cwd, destinationInput);
	let destinationParent;
	try {
		destinationParent = fs.realpathSync(path.dirname(destinationLexical));
	} catch (err) {
		fail(`worker destination parent is unavailable: ${err.message}`);
	}
	const destination = path.join(destinationParent, path.basename(destinationLexical));
	const source = fs.realpathSync(cwd);
	if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
		fail("worker destination must be outside the source checkout");
	}
	if (fs.existsSync(destination)) fail("worker destination must not exist");
	let enclosingGitRoot = null;
	try {
		enclosingGitRoot = fs.realpathSync(
			execFileSync("git", ["-C", destinationParent, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim(),
		);
	} catch {}
	if (
		enclosingGitRoot &&
		(destination === enclosingGitRoot || destination.startsWith(`${enclosingGitRoot}${path.sep}`))
	) {
		fail("worker destination must not be inside any Git checkout");
	}
	const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	const visible = workerVisiblePaths(cwd);
	const tracked = new Set(
		splitNul(
			execFileSync("git", ["-C", cwd, "ls-files", "--cached", "-z"], {
				stdio: ["ignore", "pipe", "pipe"],
			}),
		).map((entry) => entry.toString("utf8")),
	);
	const untracked = visible.filter((relative) => !tracked.has(relative)).length;
	const files = Object.create(null);
	let ownsDestination = false;
	try {
		fs.mkdirSync(destination, { mode: 0o700 });
		ownsDestination = true;
		for (const relative of visible) {
			const result = readWorkerPathState(cwd, relative, { bytes: true });
			files[relative] = result.state;
			writeNewWorkerPath(destination, relative, result);
		}
		const workerId = createWorkerId();
		const metadata = {
			schema: WORKER_METADATA_SCHEMA,
			workerId,
			source: {
				root: source,
				branch: context.branch,
				taskId: context.task.id,
				taskName: context.task.name,
				head,
			},
			scope: { frozenPaths, allowedPaths },
			baseline: { files },
		};
		const metadataBytes = `${JSON.stringify(metadata, null, 2)}\n`;
		fs.mkdirSync(path.join(destination, ".stdd"), { recursive: true });
		fs.writeFileSync(path.join(destination, WORKER_METADATA_REL), metadataBytes, {
			flag: "wx",
			mode: 0o600,
		});
		const bootstrap = [
			{
				ts: new Date().toISOString(),
				event: "task-start",
				id: context.task.id,
				name: context.task.name,
				planBaseline: null,
				branch: context.branch,
			},
			{
				...docs,
				ts: new Date().toISOString(),
				branch: context.branch,
				taskId: context.task.id,
			},
			{
				ts: new Date().toISOString(),
				event: "scope",
				frozenPaths,
				allowedPaths,
				baseline: { head, dirty: {} },
				branch: context.branch,
				taskId: context.task.id,
			},
		];
		fs.writeFileSync(
			path.join(destination, ".stdd", "ledger.jsonl"),
			`${bootstrap.map((event) => JSON.stringify(event)).join("\n")}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		withCapturedLedgerIdentity(
			cwd,
			{
				expectedBranch: context.branch,
				expectedTaskState: context.taskState,
				subject: "worker creation",
				retry: "stdd worker create",
			},
			() =>
				appendLedger(
					cwd,
					{
						event: "worker-create",
						workerId,
						metadataHash: sha256(metadataBytes),
						sourceHead: head,
						taskId: context.task.id,
					},
					{
						preserveTaskScope: true,
						lockHeld: true,
						expectedBranch: context.branch,
					},
				),
		);
		console.log(
			`stdd worker: gitless worker ${workerId} created at ${destination} ` +
				`(${visible.length} files, ${untracked} untracked)`,
		);
	} catch (err) {
		fail(
			`${err.message}${ownsDestination ? ` — partial sandbox remains at ${destination}; inspect and remove it explicitly` : ""}`,
		);
	}
}

export function workerCollect(cwd, sandboxInput) {
	if (process.platform !== "linux") fail("worker collect requires Linux held-parent support");
	if (readWorkerMetadata(cwd)) {
		fail("worker collect is source-checkout-owned and unavailable in a managed gitless worker");
	}
	const sandbox = path.resolve(cwd, sandboxInput);
	let metadata;
	try {
		metadata = readWorkerMetadata(sandbox, { required: true });
	} catch (err) {
		fail(err.message);
	}
	const source = fs.realpathSync(cwd);
	if (source !== metadata.source.root) fail("worker collect must run from the bound source checkout");
	const branch = currentBranch(cwd);
	if (branch !== metadata.source.branch) {
		fail(`bound worker branch changed: expected ${metadata.source.branch}, found ${branch ?? "none"}`);
	}
	const collectionContext = ledgerAppendContext(cwd, { event: "note" });
	if (!collectionContext.task || collectionContext.task.id !== metadata.source.taskId) {
		fail("bound worker active task changed or is no longer active");
	}
	const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (head !== metadata.source.head) fail("bound worker source HEAD changed");
	const sourceEvents = loadLedger(cwd, branch);
	const binding = sourceEvents
		.filter(
			(event) =>
				event.event === "worker-create" &&
				event.workerId === metadata.workerId &&
				event.taskId === metadata.source.taskId,
		)
		.at(-1);
	if (!binding || binding.metadataHash !== sha256(metadata.metadataBytes)) {
		fail("worker metadata hash does not match its source-ledger binding");
	}

	let current;
	try {
		current = workerCurrentStates(metadata.root, metadata);
	} catch (err) {
		fail(err.message);
	}
	const touched = [];
	for (const relative of new Set([...Object.keys(metadata.baseline.files), ...Object.keys(current)])) {
		const before = metadata.baseline.files[relative] ?? null;
		const after = current[relative] ?? null;
		if (!sameWorkerState(before, after)) touched.push({ relative, before, after });
	}
	const scopeViolation = workerScopeViolations(
		metadata.scope,
		touched.map((change) => change.relative),
	)[0];
	if (scopeViolation) {
		fail(
			`worker scope violation: ${workerViewPath(scopeViolation.relative)} is ` +
				(scopeViolation.kind === "frozen" ? "frozen" : "outside allowed paths"),
		);
	}

	if (touched.some((change) => change.after === null)) {
		try {
			execFileSync(
				"git",
				["-C", cwd, "check-ignore", "--no-index", "-q", `${WORKER_DELETIONS_REL}/probe`],
				{ stdio: "ignore" },
			);
		} catch {
			fail(
				`worker deletion quarantine is not Git-ignored — rerun stdd init before collecting deletions`,
			);
		}
	}

	const prepared = [];
	for (const change of touched) {
		if (
			change.after?.type === "file" &&
			(change.after.mode & 0o022) !== 0 &&
			(change.before?.type !== "file" || change.after.mode !== change.before.mode)
		) {
			fail(`worker path ${workerViewPath(change.relative)} has unsafe group/other write permissions`);
		}
		let sourceState;
		try {
			sourceState = readWorkerPathState(cwd, change.relative).state;
		} catch (err) {
			fail(err.message);
		}
		if (!sameWorkerState(sourceState, change.before) && !sameWorkerState(sourceState, change.after)) {
			fail(
				`worker collect conflict at ${workerViewPath(change.relative)}: source changed since sandbox creation`,
			);
		}
		let finalBytes = null;
		if (change.after?.type === "file") {
			const final = readWorkerPathState(metadata.root, change.relative, { bytes: true });
			if (!sameWorkerState(final.state, change.after)) {
				fail(`worker path ${workerViewPath(change.relative)} changed during collection preflight`);
			}
			finalBytes = final.bytes;
		}
		prepared.push({ ...change, sourceState, finalBytes });
	}

	let workerEvents;
	try {
		const sandboxLedger = rawLedger(metadata.root, metadata.source.branch);
		const invalidIndex = sandboxLedger.findIndex(
			(event) => !isPlainLedgerRecord(event) || !isStateLedgerEvent(event),
		);
		if (invalidIndex !== -1) {
			throw new Error(`invalid event at worker ledger line ${invalidIndex + 1}`);
		}
		workerEvents = sandboxLedger.filter(
			(event) => event.taskId === metadata.source.taskId && WORKER_EVIDENCE_EVENTS.has(event.event),
		);
	} catch (err) {
		fail(`worker evidence is invalid: ${err.message}`);
	}
	const imported = new Set(
		sourceEvents
			.filter(
				(event) => event.workerId === metadata.workerId && typeof event.workerEventHash === "string",
			)
			.map((event) => event.workerEventHash),
	);
	const pendingEvidence = [];
	for (const workerEvent of workerEvents) {
		const workerEventHash = sha256(JSON.stringify(workerEvent));
		if (!imported.has(workerEventHash)) {
			pendingEvidence.push({ workerEvent, workerEventHash });
			imported.add(workerEventHash);
		}
	}

	let applied = 0;
	for (const change of prepared) {
		if (sameWorkerState(change.sourceState, change.after)) continue;
		let liveSource;
		try {
			liveSource = readWorkerPathState(cwd, change.relative).state;
		} catch (err) {
			fail(err.message);
		}
		if (!sameWorkerState(liveSource, change.sourceState)) {
			fail(
				`worker collect conflict at ${workerViewPath(change.relative)}: source changed after preflight`,
			);
		}
		try {
			if (change.after === null) {
				quarantineWorkerDeletion(cwd, change.relative, metadata.workerId, change.sourceState);
			} else if (change.after.type === "symlink") {
				publishWorkerSymlink(cwd, change.relative, change.after.target, metadata.workerId);
			} else {
				publishWorkerFile(cwd, change.relative, change.finalBytes, change.after.mode);
			}
		} catch (err) {
			fail(err.message);
		}
		applied++;
	}

	let evidenceCount = 0;
	if (pendingEvidence.length > 0) {
		try {
			withCapturedLedgerIdentity(
				cwd,
				{
					expectedBranch: collectionContext.branch,
					expectedTaskState: collectionContext.taskState,
					subject: "worker evidence collection",
					retry: "stdd worker collect",
				},
				() => {
					for (const { workerEvent, workerEventHash } of pendingEvidence) {
						const { ts: _ts, branch: _branch, snapshot: _snapshot, ...evidence } = workerEvent;
						appendLedger(
							cwd,
							{
								...evidence,
								taskId: metadata.source.taskId,
								workerId: metadata.workerId,
								workerEventHash,
							},
							{
								preserveTaskScope: true,
								lockHeld: true,
								expectedBranch: collectionContext.branch,
							},
						);
						evidenceCount++;
					}
				},
			);
		} catch (err) {
			fail(err.message);
		}
	}
	console.log(
		`stdd worker: collected ${applied} file change(s) and ${evidenceCount} evidence event(s) ` +
			`from ${metadata.workerId}${applied === 0 && evidenceCount === 0 ? " (already collected)" : ""}`,
	);
}
