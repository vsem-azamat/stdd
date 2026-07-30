import { execFileSync } from "node:child_process";
import { dedupeChecks } from "./lib.mjs";
import { fail, git } from "./runtime.mjs";

/**
 * The branch's PR as `stdd status` reports it. Degrades, never errors:
 * no gh on PATH or an unexpected gh failure → state "unknown".
 */
export function statusPr(cwd) {
	let raw;
	try {
		raw = execFileSync("gh", ["pr", "view", "--json", "number,url,statusCheckRollup"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		if (err.code === "ENOENT") return { state: "unknown", reason: "gh unavailable" };
		const stderr = err.stderr?.toString() ?? "";
		if (/no pull requests found/i.test(stderr)) return { state: "none" };
		return {
			state: "unknown",
			reason: stderr.trim().split("\n")[0] || "gh failed",
		};
	}
	let info;
	try {
		info = JSON.parse(raw);
	} catch {
		return { state: "unknown", reason: "gh returned unparseable output" };
	}
	const checks = { success: 0, failure: 0, pending: 0 };
	for (const check of info.statusCheckRollup ?? []) {
		const conclusion = (check.conclusion ?? "").toUpperCase();
		if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
			checks.success++;
		} else if (conclusion === "") {
			checks.pending++;
		} else {
			checks.failure++;
		}
	}
	return { state: "open", number: info.number, url: info.url, checks };
}

/** One rollup entry → { name, terminal, ok }, for check runs and statuses. */
function normalizeCheck(entry) {
	const startedAt = entry.startedAt ?? entry.createdAt ?? "";
	if (entry.state !== undefined && entry.status === undefined) {
		const state = (entry.state ?? "").toUpperCase();
		return {
			name: entry.context ?? "unknown",
			terminal: state !== "" && state !== "EXPECTED" && state !== "PENDING",
			ok: state === "SUCCESS",
			startedAt,
		};
	}
	const conclusion = (entry.conclusion ?? "").toUpperCase();
	return {
		name: entry.name ?? "unknown",
		terminal: (entry.status ?? "").toUpperCase() === "COMPLETED",
		ok: conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED",
		startedAt,
	};
}

/** The PR's checks for its current head, straight from the forge. */
function ghPrChecks(pr) {
	const args = ["pr", "view", ...(pr ? [pr] : []), "--json", "number,url,headRefOid,statusCheckRollup"];
	let raw;
	try {
		raw = execFileSync("gh", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		if (err.code === "ENOENT") fail("stdd ci needs the GitHub CLI (gh) on PATH");
		const stderr = err.stderr?.toString() ?? "";
		if (/no pull requests found/i.test(stderr)) {
			fail("no PR for the current branch — open it first, then watch it settle");
		}
		fail(`gh pr view failed: ${stderr.trim().split("\n")[0] || err.message}`);
	}
	let info;
	try {
		info = JSON.parse(raw);
	} catch {
		fail("gh returned unparseable output");
	}
	return {
		number: info.number,
		url: info.url,
		head: info.headRefOid,
		checks: dedupeChecks((info.statusCheckRollup ?? []).map(normalizeCheck)),
	};
}

/**
 * `stdd ci [pr] [--watch]` — the PR's checks on its **current head**. The
 * watch settles only when the check set is stable (two consecutive polls
 * with the same names) and fully terminal: a watcher attached right after
 * a push sees a partial set — the classic early-settle trap. A terminal
 * failure exits immediately; a head move (amend, force-push) restarts the
 * watch on the new head.
 */
export async function ciCommand(pr, watch, intervalSec, timeoutSec) {
	const render = (c) => `  ${c.terminal ? (c.ok ? "✓" : "✗") : "…"} ${c.name}`;
	let localHead = null;
	try {
		localHead = git("rev-parse", "HEAD");
	} catch {
		// outside a git repo gh still resolves an explicit PR number
	}
	let lastHead = null;
	let lastNames = null;
	let lastProgress = null;
	let stable = 0;
	const deadline = Date.now() + timeoutSec * 1000;
	for (;;) {
		const view = ghPrChecks(pr);
		if (view.head !== lastHead) {
			if (lastHead === null) {
				console.log(`PR #${view.number} — checks on head ${view.head.slice(0, 7)} (${view.url})`);
				if (localHead && localHead !== view.head) {
					console.error(
						`stdd ci: local HEAD ${localHead.slice(0, 7)} differs from the PR head — ` +
							"watching the PR head; push if you meant your local commit",
					);
				}
			} else {
				console.log(`head moved to ${view.head.slice(0, 7)} — restarting the watch`);
			}
			lastHead = view.head;
			lastNames = null;
			stable = 0;
		}
		const failed = view.checks.filter((c) => c.terminal && !c.ok);
		const allTerminal = view.checks.every((c) => c.terminal);
		const names = view.checks
			.map((c) => c.name)
			.sort()
			.join("\n");

		if (!watch) {
			for (const c of view.checks) console.log(render(c));
			if (view.checks.length === 0) console.log("  (no checks reported)");
			if (failed.length > 0) {
				console.error(`stdd ci: ${failed.length} failing on ${view.head.slice(0, 7)}`);
				process.exit(1);
			}
			if (allTerminal && view.checks.length > 0) {
				console.log(`stdd ci: green (${view.checks.length} checks) on ${view.head.slice(0, 7)}`);
				return;
			}
			console.error(
				"stdd ci: not settled — checks pending or not yet registered; `stdd ci --watch` waits it out",
			);
			process.exit(1);
		}

		if (failed.length > 0) {
			for (const c of view.checks) console.log(render(c));
			console.error(`stdd ci: ${failed.length} failing check(s) on ${view.head.slice(0, 7)}`);
			process.exit(1);
		}
		stable = allTerminal && view.checks.length > 0 && names === lastNames ? stable + 1 : 0;
		lastNames = names;
		if (stable >= 1 && allTerminal) {
			// second consecutive all-terminal poll with an unchanged set
			for (const c of view.checks) console.log(render(c));
			console.log(
				`stdd ci: green (${view.checks.length} checks) on ${view.head.slice(0, 7)} — terminal`,
			);
			return;
		}
		const progress = `  ${view.checks.filter((c) => c.terminal).length}/${view.checks.length} terminal`;
		if (progress !== lastProgress) {
			console.log(progress);
			lastProgress = progress;
		}
		if (Date.now() > deadline) {
			const open = view.checks.filter((c) => !c.terminal).map((c) => c.name);
			fail(
				`timed out after ${timeoutSec}s — still not terminal: ` +
					(open.join(", ") || "check set still settling"),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
	}
}
