// --- managed gitless workers: portable native create and collect ---
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPrintableSingleLine } from "../sdk/text.mjs";
import { openNativeRepoMutation } from "./held-fs.mjs";
import {
	currentBranch,
	isStateExemptPath,
	isStateLedgerEvent,
	ledgerAppendContext,
	loadLedger,
	mutateLedgerWithNativeSession,
	parseStateLedger,
	sameTaskBoundary,
	scopeLedgerForCheckout,
} from "./ledger.mjs";
import { sha256 } from "./lib.mjs";
import { splitNul } from "./path-bytes.mjs";
import { fail, MAX_SUBPROCESS_BUFFER } from "./runtime.mjs";
import { validateScopeDeclaration, workerScopeViolations } from "./scope.mjs";
import { isPlainLedgerRecord } from "./state-validation.mjs";
import {
	preflightPrivateWorkerQuarantine,
	preflightWorkerCreationState,
	preflightWorkerParent,
	publishWorkerFile,
	publishWorkerSymlink,
	quarantineWorkerDeletion,
	readNativeWorkerPath,
	readWorkerDeletionQuarantineState,
	sameWorkerState,
	stateWithPortableIdentity,
	WORKER_DELETIONS_REL,
	workerViewPath,
	writeNewWorkerPath,
} from "./worker-fs.mjs";
import {
	createWorkerId,
	parseWorkerMetadata,
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
		if (
			path.posix.isAbsolute(relative) ||
			relative.includes("\\") ||
			relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
		) {
			fail(`unsafe worker source path ${workerViewPath(relative)}`);
		}
		paths.push(relative);
	}
	return [...new Set(paths)].sort();
}

function trackedModes(cwd) {
	const result = new Map();
	for (const record of splitNul(
		execFileSync("git", ["-C", cwd, "ls-files", "--stage", "-z"], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_SUBPROCESS_BUFFER,
		}),
	)) {
		const tab = record.indexOf(0x09);
		if (tab === -1) continue;
		const header = record.subarray(0, tab).toString("ascii");
		const relative = record.subarray(tab + 1).toString("utf8");
		const mode = header.slice(0, 6) === "100755" ? 0o755 : 0o644;
		result.set(relative, mode);
	}
	return result;
}

function workerSourceHead(cwd) {
	return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function workerCollectionContextError(cwd, metadata, expectedContext) {
	const branch = currentBranch(cwd);
	if (branch !== metadata.source.branch) {
		return `bound worker branch changed: expected ${metadata.source.branch}, found ${branch ?? "none"}`;
	}
	const liveContext = ledgerAppendContext(cwd, { event: "note" });
	if (
		!liveContext.task ||
		liveContext.task.id !== metadata.source.taskId ||
		!sameTaskBoundary(liveContext.taskState, expectedContext.taskState)
	) {
		return "bound worker active task changed or is no longer active";
	}
	if (workerSourceHead(cwd) !== metadata.source.head) return "bound worker source HEAD changed";
	return null;
}

function assertWorkerCollectionContext(cwd, metadata, expectedContext) {
	const error = workerCollectionContextError(cwd, metadata, expectedContext);
	if (error !== null) throw new Error(error);
}

function contextForRoot(context, root, rootPath) {
	return { session: context.session, root, rootPath, close: context.close };
}

function samePortableIdentity(left, right) {
	return (
		left?.version === right?.version &&
		left?.platform === right?.platform &&
		left?.volume === right?.volume &&
		left?.fileId === right?.fileId &&
		left?.kind === right?.kind
	);
}

async function listNativeDirectory(context, directory) {
	const entries = [];
	let cursor = null;
	do {
		const page = await context.session.list(directory.cap, { cursor, limit: 512 });
		entries.push(...page.entries);
		cursor = page.cursor;
	} while (cursor !== null);
	return entries;
}

function gitIgnoredPaths(cwd, relatives) {
	if (relatives.length === 0) return new Set();
	const ignored = new Set();
	const ordinary = relatives.filter((relative) => !/[\r\n]/.test(relative));
	if (ordinary.length > 0) {
		try {
			const output = execFileSync(
				"git",
				["-C", cwd, "-c", "core.quotePath=false", "check-ignore", "--no-index", "--", ...ordinary],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_SUBPROCESS_BUFFER },
			);
			for (const relative of output.split("\n").filter(Boolean)) ignored.add(relative);
		} catch (error) {
			if (error.status !== 1) throw error;
		}
	}
	for (const relative of relatives.filter((candidate) => /[\r\n]/.test(candidate))) {
		try {
			execFileSync("git", ["-C", cwd, "check-ignore", "--no-index", "-q", "--", relative], {
				stdio: "ignore",
			});
			ignored.add(relative);
		} catch (error) {
			if (error.status !== 1) throw error;
		}
	}
	return ignored;
}

async function nativeWorkerCurrentStates(context, metadata, sourceCwd) {
	const baselinePaths = Object.keys(metadata.baseline.files);
	const baselinePrefixes = new Set();
	for (const baseline of baselinePaths) {
		let prefix = path.posix.dirname(baseline);
		while (prefix !== ".") {
			baselinePrefixes.add(prefix);
			prefix = path.posix.dirname(prefix);
		}
	}
	const discovered = new Set();
	const walk = async (directory, prefix = "") => {
		const entries = await listNativeDirectory(context, directory);
		const relatives = entries.map((entry) => (prefix ? `${prefix}/${entry.name}` : entry.name));
		const ignored = gitIgnoredPaths(sourceCwd, relatives);
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			const relative = relatives[index];
			if (!isPrintableSingleLine(entry.name)) {
				throw new Error(`worker path ${workerViewPath(relative)} contains unsupported characters`);
			}
			const carriesBaseline =
				Object.hasOwn(metadata.baseline.files, relative) || baselinePrefixes.has(relative);
			if (ignored.has(relative) && !carriesBaseline) continue;
			if (relative.split("/").includes(".git")) {
				throw new Error(`managed worker sandbox must not contain .git: ${workerViewPath(relative)}`);
			}
			if (isStateExemptPath(metadata.root, relative) || relative === WORKER_METADATA_REL) continue;
			if (entry.observation.identity.kind === "directory") {
				const child = await context.session.openChild(directory.cap, entry.name);
				try {
					await walk(child, relative);
				} finally {
					await context.session.closeCapability(child.cap).catch(() => {});
				}
			} else {
				discovered.add(relative);
			}
		}
	};
	await walk(context.root);
	const states = Object.create(null);
	const observations = Object.create(null);
	for (const relative of new Set([...baselinePaths, ...discovered])) {
		const baseline = metadata.baseline.files[relative];
		const hint = baseline?.mode ?? 0o644;
		const result = await readNativeWorkerPath(context, relative, {
			modeHint: hint,
			legacyMode: metadata.schema === 1 ? (baseline?.mode ?? null) : null,
		});
		states[relative] = result.state;
		observations[relative] = result.observation;
		if (
			metadata.schema === 2 &&
			baseline !== undefined &&
			sameWorkerState(result.state, baseline) &&
			!samePortableIdentity(result.observation?.identity, baseline.portable.sandbox)
		) {
			throw new Error(
				`worker path ${workerViewPath(relative)} identity changed without a content change`,
			);
		}
		if (states[relative] === null) {
			delete states[relative];
			delete observations[relative];
		}
	}
	return { states, observations };
}

async function openAdditionalRoot(context, absolute, label) {
	if (!path.isAbsolute(absolute)) throw new Error(`${label} must be absolute`);
	const root = await context.session.openRoot(absolute);
	await context.session.probe(root.cap);
	return contextForRoot(context, root, absolute);
}

async function nativeWorkerMetadata(context, sandbox) {
	const result = await readNativeWorkerPath(context, WORKER_METADATA_REL, {
		bytes: true,
		modeHint: 0o600,
	});
	if (result.state === null) throw new Error("not a managed gitless worker sandbox");
	return parseWorkerMetadata(
		result.bytes.toString("utf8"),
		sandbox,
		path.join(sandbox, ...WORKER_METADATA_REL.split("/")),
	);
}

function ledgerRecord(event, branch) {
	return JSON.stringify({ ts: new Date().toISOString(), ...event, branch });
}

export async function workerCreate(cwd, destinationInput, frozenPaths, allowedPaths, dependencies = {}) {
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
	} catch (error) {
		fail(`worker destination parent is unavailable: ${error.message}`);
	}
	const destination = path.join(destinationParent, path.basename(destinationLexical));
	const source = fs.realpathSync(cwd);
	if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
		fail("worker destination must be outside the source checkout");
	}
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
	const head = workerSourceHead(cwd);
	const visible = workerVisiblePaths(cwd);
	const modes = trackedModes(cwd);
	const untracked = visible.filter((relative) => !modes.has(relative)).length;
	const workerId = createWorkerId();
	let mutation;
	let ownsDestination = false;
	try {
		const openMutation = dependencies.openNativeRepoMutation ?? openNativeRepoMutation;
		mutation = await openMutation(source, "worker creation native filesystem helper");
		const destinationParentContext = await openAdditionalRoot(
			mutation,
			destinationParent,
			"worker destination parent",
		);
		const destinationName = path.basename(destination);
		try {
			await mutation.session.stat(destinationParentContext.root.cap, destinationName);
			throw new Error("worker destination must not exist");
		} catch (error) {
			if (error?.code !== "not-found") throw error;
		}

		// Complete source preflight, including every mode and symlink target,
		// before the destination namespace receives its first inode.
		const prepared = [];
		for (const relative of visible) {
			const result = await readNativeWorkerPath(mutation, relative, {
				bytes: true,
				modeHint: modes.get(relative) ?? 0o644,
			});
			if (result.state === null)
				throw new Error(`worker source path ${workerViewPath(relative)} vanished`);
			preflightWorkerCreationState(relative, result.state, null, result.observation.identity.platform);
			prepared.push({ relative, result });
		}
		if (prepared.some(({ result }) => result.state.type === "symlink")) {
			await mutation.session.preflightSymlink(destinationParentContext.root.cap);
		}
		const destinationRoot = await mutation.session.createDirectory(
			destinationParentContext.root.cap,
			destinationName,
			0o700,
		);
		ownsDestination = true;
		await mutation.session.flush(
			destinationParentContext.root.cap,
			"namespace",
			destinationParentContext.root.observation.identity,
		);
		const destinationContext = contextForRoot(mutation, destinationRoot, destination);
		const files = Object.create(null);
		for (const item of prepared) {
			const written = await writeNewWorkerPath(destinationContext, item.relative, item.result);
			files[item.relative] = stateWithPortableIdentity(
				item.result.state,
				item.result.observation,
				written.observation,
			);
		}
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
		const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
		const bootstrap = [
			{
				ts: new Date().toISOString(),
				event: "task-start",
				id: context.task.id,
				name: context.task.name,
				planBaseline: null,
				branch: context.branch,
			},
			{ ...docs, ts: new Date().toISOString(), branch: context.branch, taskId: context.task.id },
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
		for (const [relative, bytes] of [
			[WORKER_METADATA_REL, metadataBytes],
			[".stdd/ledger.jsonl", Buffer.from(`${bootstrap.map(JSON.stringify).join("\n")}\n`)],
		]) {
			await writeNewWorkerPath(destinationContext, relative, {
				state: { type: "file", mode: 0o600, hash: sha256(bytes) },
				bytes,
			});
		}
		if (
			currentBranch(cwd) !== context.branch ||
			workerSourceHead(cwd) !== head ||
			!sameTaskBoundary(ledgerAppendContext(cwd, { event: "note" }).taskState, context.taskState)
		) {
			throw new Error("source checkout changed during worker creation");
		}
		await mutateLedgerWithNativeSession(mutation, [
			ledgerRecord(
				{
					event: "worker-create",
					workerId,
					metadataHash: sha256(metadataBytes),
					sourceHead: head,
					taskId: context.task.id,
				},
				context.branch,
			),
		]);
		console.log(
			`stdd worker: gitless worker ${workerId} created at ${destination} ` +
				`(${visible.length} files, ${untracked} untracked)`,
		);
	} catch (error) {
		throw new Error(
			`${error.message}${
				ownsDestination
					? ` — partial sandbox remains at ${destination}; inspect and remove it explicitly`
					: ""
			}`,
			{ cause: error },
		);
	} finally {
		if (mutation) await mutation.close().catch(() => {});
	}
}

export async function workerCollect(cwd, sandboxInput, dependencies = {}) {
	if (readWorkerMetadata(cwd)) {
		fail("worker collect is source-checkout-owned and unavailable in a managed gitless worker");
	}
	const sandbox = path.resolve(cwd, sandboxInput);
	const source = fs.realpathSync(cwd);
	let mutation;
	try {
		const openMutation = dependencies.openNativeRepoMutation ?? openNativeRepoMutation;
		mutation = await openMutation(source, "worker collection native filesystem helper");
		const sandboxContext = await openAdditionalRoot(mutation, sandbox, "worker sandbox root");
		const metadata = await nativeWorkerMetadata(sandboxContext, sandbox);
		if (source !== metadata.source.root) {
			throw new Error("worker collect must run from the bound source checkout");
		}
		const branch = currentBranch(cwd);
		if (branch !== metadata.source.branch) {
			throw new Error(
				`bound worker branch changed: expected ${metadata.source.branch}, found ${branch ?? "none"}`,
			);
		}
		const collectionContext = ledgerAppendContext(cwd, { event: "note" });
		if (!collectionContext.task || collectionContext.task.id !== metadata.source.taskId) {
			throw new Error("bound worker active task changed or is no longer active");
		}
		if (workerSourceHead(cwd) !== metadata.source.head) {
			throw new Error("bound worker source HEAD changed");
		}
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
			throw new Error("worker metadata hash does not match its source-ledger binding");
		}

		const currentSnapshot = await nativeWorkerCurrentStates(sandboxContext, metadata, cwd);
		const current = currentSnapshot.states;
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
			throw new Error(
				`worker scope violation: ${workerViewPath(scopeViolation.relative)} is ` +
					(scopeViolation.kind === "frozen" ? "frozen" : "outside allowed paths"),
			);
		}
		if (
			touched.some((change) => change.before !== null && !sameWorkerState(change.before, change.after))
		) {
			try {
				execFileSync(
					"git",
					["-C", cwd, "check-ignore", "--no-index", "-q", `${WORKER_DELETIONS_REL}/probe`],
					{ stdio: "ignore" },
				);
			} catch {
				throw new Error(
					"worker deletion quarantine is not Git-ignored — rerun stdd init before collecting deletions",
				);
			}
		}

		// Complete publication preflight for every path and every evidence event
		// before the source checkout receives its first namespace mutation.
		if (touched.some((change) => change.after?.type === "symlink")) {
			await mutation.session.preflightSymlink(mutation.root.cap);
		}
		const prepared = [];
		for (const change of touched) {
			const inheritedLegacyMode =
				metadata.schema === 1 && change.before?.type === "file" ? change.before.mode : null;
			preflightWorkerCreationState(change.relative, change.after, inheritedLegacyMode);
			if (change.after !== null) await preflightWorkerParent(mutation, change.relative);
			if (change.before !== null) {
				await preflightPrivateWorkerQuarantine(mutation, change.relative, metadata.workerId);
			}
			const sourceResult = await readNativeWorkerPath(mutation, change.relative, {
				modeHint: change.before?.mode ?? change.after?.mode ?? null,
				legacyMode: metadata.schema === 1 ? (change.before?.mode ?? null) : null,
			});
			const quarantinedState = await readWorkerDeletionQuarantineState(
				mutation,
				change.relative,
				metadata.workerId,
			);
			const sourcePrepared =
				change.before !== null &&
				sourceResult.state === null &&
				sameWorkerState(quarantinedState, change.before);
			if (
				metadata.schema === 2 &&
				change.before !== null &&
				sameWorkerState(sourceResult.state, change.before) &&
				!samePortableIdentity(sourceResult.observation?.identity, change.before.portable.source)
			) {
				throw new Error(
					`worker collect conflict at ${workerViewPath(change.relative)}: source identity changed since sandbox creation`,
				);
			}
			if (
				!sameWorkerState(sourceResult.state, change.before) &&
				!sameWorkerState(sourceResult.state, change.after) &&
				!sourcePrepared
			) {
				throw new Error(
					`worker collect conflict at ${workerViewPath(change.relative)}: source changed since sandbox creation`,
				);
			}
			let finalBytes = null;
			if (change.after?.type === "file") {
				const final = await readNativeWorkerPath(sandboxContext, change.relative, {
					bytes: true,
					modeHint: change.after.mode,
					legacyMode: metadata.schema === 1 ? change.after.mode : null,
				});
				if (!sameWorkerState(final.state, change.after)) {
					throw new Error(
						`worker path ${workerViewPath(change.relative)} changed during collection preflight`,
					);
				}
				finalBytes = final.bytes;
			}
			prepared.push({
				...change,
				sourceState: sourceResult.state,
				sourceObservation: sourceResult.observation,
				sourcePrepared,
				sandboxObservation: currentSnapshot.observations[change.relative] ?? null,
				finalBytes,
				finalSourceObservation: sameWorkerState(sourceResult.state, change.after)
					? sourceResult.observation
					: null,
			});
		}

		const sandboxLedgerResult = await readNativeWorkerPath(sandboxContext, ".stdd/ledger.jsonl", {
			bytes: true,
			modeHint: 0o600,
		});
		const sandboxLedger =
			sandboxLedgerResult.state === null
				? []
				: parseStateLedger(sandboxLedgerResult.bytes.toString("utf8"), metadata.source.branch);
		const invalidIndex = sandboxLedger.findIndex(
			(event) => !isPlainLedgerRecord(event) || !isStateLedgerEvent(event),
		);
		if (invalidIndex !== -1) throw new Error(`invalid event at worker ledger line ${invalidIndex + 1}`);
		const workerEvents = sandboxLedger.filter(
			(event) => event.taskId === metadata.source.taskId && WORKER_EVIDENCE_EVENTS.has(event.event),
		);
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

		const assertFinalStates = async () => {
			for (const change of prepared) {
				const sandboxLive = await readNativeWorkerPath(sandboxContext, change.relative, {
					modeHint: change.after?.mode ?? null,
					legacyMode: metadata.schema === 1 ? (change.after?.mode ?? null) : null,
				});
				if (
					!sameWorkerState(sandboxLive.state, change.after) ||
					!samePortableIdentity(sandboxLive.observation?.identity, change.sandboxObservation?.identity)
				) {
					throw new Error(`worker path ${workerViewPath(change.relative)} changed before final sweep`);
				}
				const sourceLive = await readNativeWorkerPath(mutation, change.relative, {
					modeHint: change.after?.mode ?? null,
					legacyMode: metadata.schema === 1 ? (change.after?.mode ?? null) : null,
				});
				if (
					!sameWorkerState(sourceLive.state, change.after) ||
					(change.after !== null &&
						!samePortableIdentity(
							sourceLive.observation?.identity,
							change.finalSourceObservation?.identity,
						))
				) {
					throw new Error(
						`worker collect conflict at ${workerViewPath(change.relative)}: final source state changed`,
					);
				}
			}
		};

		let applied = 0;
		for (const change of prepared) {
			assertWorkerCollectionContext(cwd, metadata, collectionContext);
			const sandboxLive = await readNativeWorkerPath(sandboxContext, change.relative, {
				bytes: change.after?.type === "file",
				modeHint: change.after?.mode ?? null,
				legacyMode: metadata.schema === 1 ? (change.after?.mode ?? null) : null,
			});
			if (
				!sameWorkerState(sandboxLive.state, change.after) ||
				!samePortableIdentity(sandboxLive.observation?.identity, change.sandboxObservation?.identity)
			) {
				throw new Error(
					`worker path ${workerViewPath(change.relative)} changed after collection preflight`,
				);
			}
			const live = await readNativeWorkerPath(mutation, change.relative, {
				modeHint: change.sourceState?.mode ?? change.after?.mode ?? null,
				legacyMode: metadata.schema === 1 ? (change.sourceState?.mode ?? null) : null,
			});
			if (!samePortableIdentity(live.observation?.identity, change.sourceObservation?.identity)) {
				throw new Error(
					`worker collect conflict at ${workerViewPath(change.relative)}: source identity changed after preflight`,
				);
			}
			if (sameWorkerState(change.sourceState, change.after)) {
				if (!sameWorkerState(live.state, change.after)) {
					throw new Error(
						`worker collect conflict at ${workerViewPath(change.relative)}: source changed after preflight`,
					);
				}
				change.finalSourceObservation = live.observation;
				continue;
			}
			if (!sameWorkerState(live.state, change.sourceState)) {
				throw new Error(
					`worker collect conflict at ${workerViewPath(change.relative)}: source changed after preflight`,
				);
			}
			const assertContext = async () => assertWorkerCollectionContext(cwd, metadata, collectionContext);
			if (change.after === null) {
				await quarantineWorkerDeletion(
					mutation,
					change.relative,
					metadata.workerId,
					change.sourceState,
					live.observation,
					assertContext,
					change.relative,
					metadata.schema === 1 ? (change.sourceState?.mode ?? null) : null,
				);
			} else {
				if (!change.sourcePrepared && change.sourceState !== null) {
					await quarantineWorkerDeletion(
						mutation,
						change.relative,
						metadata.workerId,
						change.sourceState,
						live.observation,
						assertContext,
						change.relative,
						metadata.schema === 1 ? (change.sourceState?.mode ?? null) : null,
					);
				}
				if (change.after.type === "symlink") {
					change.finalSourceObservation = await publishWorkerSymlink(
						mutation,
						change.relative,
						change.after,
						metadata.workerId,
						null,
						assertContext,
					);
				} else {
					change.finalSourceObservation = await publishWorkerFile(
						mutation,
						change.relative,
						sandboxLive.bytes,
						change.after.mode,
						null,
						assertContext,
						metadata.workerId,
						metadata.schema === 1 && change.before?.type === "file" ? change.before.mode : null,
					);
				}
			}
			applied += 1;
		}

		assertWorkerCollectionContext(cwd, metadata, collectionContext);
		await assertFinalStates();
		const records = pendingEvidence.map(({ workerEvent, workerEventHash }) => {
			const { ts: _ts, branch: _branch, snapshot: _snapshot, ...evidence } = workerEvent;
			return ledgerRecord(
				{
					...evidence,
					taskId: metadata.source.taskId,
					workerId: metadata.workerId,
					workerEventHash,
				},
				collectionContext.branch,
			);
		});
		if (records.length > 0) {
			await mutateLedgerWithNativeSession(mutation, records, {
				beforeCommit: async () => {
					assertWorkerCollectionContext(cwd, metadata, collectionContext);
					await assertFinalStates();
				},
			});
		}
		assertWorkerCollectionContext(cwd, metadata, collectionContext);
		await assertFinalStates();
		console.log(
			`stdd worker: collected ${applied} file change(s) and ${records.length} evidence event(s) ` +
				`from ${metadata.workerId}${applied === 0 && records.length === 0 ? " (already collected)" : ""}`,
		);
	} finally {
		if (mutation) await mutation.close().catch(() => {});
	}
}
