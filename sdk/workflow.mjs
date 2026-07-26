import { isPrintableSingleLine } from "./text.mjs";

function isCanonicalIsoTimestamp(value) {
	if (!isPrintableSingleLine(value)) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function isPlainRecord(value) {
	if (typeof value !== "object" || value === null) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function invalidTaskState(reason, boundary = null) {
	return { state: "invalid", task: null, boundary, reason };
}

function snapshotEventRecord(event, index) {
	if (!isPlainRecord(event)) {
		return {
			invalid: invalidTaskState(`task event at index ${index} must be a plain record object`, event),
		};
	}
	let descriptors;
	try {
		descriptors = Object.getOwnPropertyDescriptors(event);
	} catch {
		return {
			invalid: invalidTaskState(
				`task event at index ${index} could not be safely inspected as a plain record object`,
				event,
			),
		};
	}
	const data = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (!Object.hasOwn(descriptor, "value")) {
			return {
				invalid: invalidTaskState(
					`task event at index ${index} property ${String(key)} is an accessor; accessors are not allowed`,
					event,
				),
			};
		}
		if (typeof key === "string" && descriptor.enumerable) data[key] = descriptor.value;
	}
	return { record: { original: event, data } };
}

function snapshotTaskEvents(events) {
	let array;
	try {
		array = Array.isArray(events);
	} catch {
		return { invalid: invalidTaskState("task events could not be safely inspected as an array") };
	}
	if (!array) return { invalid: invalidTaskState("task events must be an array") };
	let descriptors;
	try {
		descriptors = Object.getOwnPropertyDescriptors(events);
	} catch {
		return { invalid: invalidTaskState("task events could not be safely inspected as an array") };
	}
	const lengthDescriptor = descriptors.length;
	if (
		!lengthDescriptor ||
		!Object.hasOwn(lengthDescriptor, "value") ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0
	) {
		return { invalid: invalidTaskState("task events must expose a safe data length") };
	}
	const records = [];
	for (let index = 0; index < lengthDescriptor.value; index++) {
		const descriptor = descriptors[String(index)];
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
			return {
				invalid: invalidTaskState(
					`task event at index ${index} must be an own enumerable data property`,
				),
			};
		}
		const snapshot = snapshotEventRecord(descriptor.value, index);
		if (snapshot.invalid) return snapshot;
		records.push(snapshot.record);
	}
	return { records };
}

/**
 * Pure loop derivation shared by the CLI and integrations. Snapshots are
 * opaque equality tokens; callers decide how a checkout is fingerprinted.
 */
export function deriveLoopState(events, currentSnapshot, nonDocChanged = false) {
	const lastRedIdx = events.findLastIndex(
		(event) => event.event === "red" && event.exit !== 0 && event.genuine !== "no",
	);
	const redEvent = lastRedIdx === -1 ? null : events[lastRedIdx];
	const recordedVerify =
		events
			.slice(lastRedIdx + 1)
			.filter((event) => event.event === "verify" && event.exit === 0)
			.at(-1) ?? null;
	const redLegacy = Boolean(redEvent && !redEvent.snapshot);
	const implementationObserved = redEvent
		? redLegacy
			? nonDocChanged
			: redEvent.snapshot !== currentSnapshot
		: false;
	const verifyStale = Boolean(recordedVerify?.snapshot && recordedVerify.snapshot !== currentSnapshot);
	const verifyEvent = verifyStale ? null : recordedVerify;
	return {
		lastRedIdx,
		redEvent,
		redLegacy,
		recordedVerify,
		verifyEvent,
		verifyStale,
		implementationObserved,
		loop: {
			red: redEvent
				? {
						done: true,
						genuine: redEvent.genuine,
						cmd: redEvent.cmd,
						exit: redEvent.exit,
						legacy: redLegacy,
					}
				: { done: false },
			impl: { done: implementationObserved },
			verify: verifyEvent
				? {
						done: true,
						cmd: verifyEvent.cmd,
						exit: verifyEvent.exit,
						legacy: !verifyEvent.snapshot,
						stale: false,
					}
				: { done: false, stale: verifyStale },
		},
	};
}

function deriveTaskStateFromRecords(records) {
	const boundaries = records.filter(
		({ data }) =>
			data.event === "task-start" || data.event === "task-finish" || data.event === "task-reset",
	);
	if (boundaries.length === 0) return { state: "legacy", task: null };
	let state = { state: "idle", task: null, boundary: null };
	const seenTaskIds = new Set();
	for (const { original, data: boundary } of boundaries) {
		const boundaryId = boundary.event === "task-start" ? boundary.id : boundary.taskId;
		if (!isPrintableSingleLine(boundaryId)) {
			return {
				state: "invalid",
				task: null,
				boundary: original,
				reason: `${boundary.event} needs a non-empty ${
					boundary.event === "task-start" ? "id" : "taskId"
				} that is a single printable line`,
			};
		}
		if (boundary.branch !== undefined && !isPrintableSingleLine(boundary.branch)) {
			return {
				state: "invalid",
				task: null,
				boundary: original,
				reason: `${boundary.event} branch must be a non-empty single printable line when present`,
			};
		}
		if (boundary.ts !== undefined && !isCanonicalIsoTimestamp(boundary.ts)) {
			return {
				state: "invalid",
				task: null,
				boundary: original,
				reason: `${boundary.event} timestamp must be a canonical ISO timestamp when present`,
			};
		}
		if (boundary.event === "task-start") {
			if (seenTaskIds.has(boundaryId)) {
				return {
					state: "invalid",
					task: null,
					boundary: original,
					reason: `task-start reuses task ID ${boundaryId}`,
				};
			}
			if (state.state === "active") {
				return {
					state: "invalid",
					task: null,
					boundary: original,
					reason: `task-start ${boundaryId} cannot replace active task ${state.task.id}`,
				};
			}
			if (!isPrintableSingleLine(boundary.name)) {
				return {
					state: "invalid",
					task: null,
					boundary: original,
					reason: "task-start name is required and must be a non-empty single printable line",
				};
			}
			if (
				!Object.hasOwn(boundary, "planBaseline") ||
				(boundary.planBaseline !== null &&
					(typeof boundary.planBaseline !== "string" ||
						!/^sha256:[0-9a-f]{64}$/u.test(boundary.planBaseline)))
			) {
				return {
					state: "invalid",
					task: null,
					boundary: original,
					reason: "task-start planBaseline is required and must be a sha256 snapshot or null",
				};
			}
			state = {
				state: "active",
				task: {
					id: boundaryId,
					name: boundary.name,
					branch: boundary.branch,
					startedAt: boundary.ts,
					planBaseline: boundary.planBaseline ?? null,
				},
				boundary: original,
			};
			seenTaskIds.add(boundaryId);
			continue;
		}
		if (state.state !== "active") {
			return {
				state: "invalid",
				task: null,
				boundary: original,
				reason: `${boundary.event} ${boundaryId} has no active task to close`,
			};
		}
		if (boundaryId !== state.task.id) {
			return {
				state: "invalid",
				task: null,
				boundary: original,
				reason: `${boundary.event} names ${boundaryId}, but ${state.task.id} is active`,
			};
		}
		state = { state: "idle", task: null, boundary: original };
	}
	return state;
}

/** Derive the active task boundary without reading files or git state. */
export function deriveTaskState(events) {
	const snapshot = snapshotTaskEvents(events);
	if (snapshot.invalid) return snapshot.invalid;
	return deriveTaskStateFromRecords(snapshot.records);
}

/** Keep only the active task's events; legacy branch-only ledgers pass through. */
export function scopeTaskEvents(events) {
	const snapshot = snapshotTaskEvents(events);
	if (snapshot.invalid) return { state: snapshot.invalid, events: [] };
	const state = deriveTaskStateFromRecords(snapshot.records);
	if (state.state === "legacy") {
		return { state, events: snapshot.records.map(({ original }) => original) };
	}
	if (state.state === "idle" || state.state === "invalid") return { state, events: [] };
	const boundaryIndex = snapshot.records.findLastIndex(({ original }) => original === state.boundary);
	return {
		state,
		events: snapshot.records
			.slice(boundaryIndex)
			.filter(
				({ data: event }) =>
					(event.event === "task-start" && event.id === state.task.id) || event.taskId === state.task.id,
			)
			.map(({ original }) => original),
	};
}
