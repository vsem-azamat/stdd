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
