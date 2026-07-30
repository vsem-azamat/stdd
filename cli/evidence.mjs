import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { resolveRepoPath } from "../sdk/path.mjs";
import { loadConfig } from "./config.mjs";
import {
	currentBranch,
	gitChangedPaths,
	LABEL_TO_DECISION,
	loadLedger,
	resolveRepoDir,
} from "./ledger.mjs";
import {
	extractDocPaths,
	findEvidenceLines,
	globToRegExp,
	nearMissEvidenceLines,
	sentinelSuggestion,
} from "./lib.mjs";
import { fail, git } from "./runtime.mjs";

/**
 * With --pr: fetch the live PR (body, base, head) from the forge, so the
 * validation matches what CI will see — never a diverged local checkout.
 * Returns `{ body, baseRef, headRef, number }`.
 */
function resolveLivePr(pr) {
	const args = [
		"pr",
		"view",
		...(pr === "." ? [] : [pr]),
		"--json",
		"body,baseRefName,headRefOid,number",
	];
	let info;
	try {
		info = JSON.parse(
			execFileSync("gh", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
	} catch (err) {
		if (err.code === "ENOENT") fail("--pr needs the GitHub CLI (gh) on PATH");
		fail(`gh pr view failed: ${err.stderr?.toString().trim().split("\n")[0] || err.message}`);
	}
	const baseRef = `origin/${info.baseRefName}`;
	try {
		git("fetch", "-q", "origin", info.baseRefName);
	} catch (err) {
		fail(
			`could not fetch origin/${info.baseRefName}: ${err.stderr?.toString().trim().split("\n")[0] || err.message}`,
		);
	}
	let headRef = "HEAD";
	if (git("rev-parse", "HEAD") !== info.headRefOid) {
		try {
			git("cat-file", "-e", `${info.headRefOid}^{commit}`);
		} catch {
			try {
				git("fetch", "-q", "origin", `pull/${info.number}/head`);
				git("cat-file", "-e", `${info.headRefOid}^{commit}`);
			} catch {
				fail(
					`local HEAD differs from PR head ${info.headRefOid.slice(0, 7)} and it could not ` +
						"be fetched — push or check out the PR branch",
				);
			}
		}
		headRef = info.headRefOid;
	}
	return { body: info.body, baseRef, headRef, number: info.number };
}

/**
 * Draft the docs evidence line from the actual diff instead of recall.
 * Canonical docs changed → the finished line on stdout (substitution-safe);
 * none changed → the authored-sentinel templates on stderr, nonzero exit.
 */
export function evidence(targetDir, baseRefFlag) {
	const config = loadConfig(targetDir);
	const base = baseRefFlag ?? config.baseRef;
	if (!base) {
		fail('evidence needs a base ref — pass --base <ref> or set "baseRef" in .stdd/config.json');
	}
	let changed;
	try {
		changed = gitChangedPaths(targetDir, `${base}...HEAD`);
	} catch (err) {
		fail(`--base ${base}: git diff failed: ${err.stderr?.toString().trim() || err.message}`);
	}
	const canonical = config.canonicalDocs.map(globToRegExp);
	const docs = changed.filter((file) => canonical.some((re) => re.test(file)));
	// The ledger's recorded decision is read first; the diff is the
	// cross-check, and on contradiction the diff wins and the conflict is
	// reported. loadLedger needs a branch — outside a git repo there is no
	// ledger to consult, so degrade to diff-only.
	const evidenceBranch = currentBranch(targetDir);
	const recorded = evidenceBranch
		? (loadLedger(targetDir, evidenceBranch)
				.filter((e) => e.event === "docs")
				.at(-1) ?? null)
		: null;
	if (docs.length > 0) {
		if (recorded && recorded.decision !== "updated-first") {
			console.error(
				`stdd evidence: the ledger records "${recorded.decision}" but the diff changes ` +
					`canonical docs — the diff wins; the ledger claim is contradicted`,
			);
		}
		console.log(`Docs updated first: ${docs.map(evidencePath).join(", ")}`);
		return;
	}
	if (recorded?.decision === "checked") {
		console.log(`Docs checked, no change needed: ${recorded.paths.join(", ")} — ${recorded.reason}`);
		return;
	}
	if (recorded?.decision === "not-applicable") {
		console.log(`Docs not applicable: ${recorded.reason}`);
		return;
	}
	fail(
		`no canonical docs changed against ${base}${
			recorded ? ` — the ledger claims "updated-first" but the diff is contradicted` : ""
		} — author the evidence line yourself:\n` +
			"  Docs checked, no change needed: <docs + reason>\n" +
			"  Docs not applicable: <why implementation-only>",
	);
}

export function checkPr(prBodyFile, baseRef, pr) {
	let body;
	let headRef = "HEAD";
	let okSuffix = "";
	if (pr) {
		if (prBodyFile) fail(`--pr replaces the <file|-> argument — drop "${prBodyFile}"`);
		if (baseRef) fail("--pr derives the base from the PR — drop --base");
		const live = resolveLivePr(pr);
		body = live.body;
		baseRef = live.baseRef;
		headRef = live.headRef;
		const shortHead = (headRef === "HEAD" ? git("rev-parse", "HEAD") : headRef).slice(0, 7);
		okSuffix = ` (PR #${live.number} body, base ${baseRef}, head ${shortHead})`;
	} else {
		body =
			prBodyFile === "-" || !prBodyFile
				? fs.readFileSync(0, "utf8")
				: fs.readFileSync(prBodyFile, "utf8");
	}
	const matches = findEvidenceLines(body);
	if (matches.length === 0) {
		let message =
			"PR body has no docs evidence line. Add exactly one of:\n" +
			"  Docs updated first: <docs>\n" +
			"  Docs checked, no change needed: <docs + reason>\n" +
			"  Docs not applicable: <why implementation-only>";
		for (const near of nearMissEvidenceLines(body)) {
			message +=
				`\n\nline ${near.line} is a near-miss:\n` +
				`  found: ${near.raw.trim()}\n` +
				`  fix:   ${near.suggestion}\n` +
				"  (the line must start at column 0 with the exact label, no markdown formatting)";
		}
		fail(message);
	}
	if (matches.length > 1) {
		fail(
			`PR body has ${matches.length} docs evidence lines ` +
				`(lines ${matches.map((m) => m.line).join(", ")}) — keep exactly one.`,
		);
	}
	if (matches[0].content === "") {
		fail(`"${matches[0].label}:" names no evidence — list the docs or the reason after the colon.`);
	}
	const repoDir = resolveRepoDir(process.cwd());
	if (baseRef) verifyEvidenceAgainstDiff(matches[0], baseRef, headRef, repoDir, Boolean(pr));
	// Advisory only — a ledger disagreement never changes the pass condition.
	const advisoryBranch = currentBranch(repoDir);
	const recorded = advisoryBranch
		? (loadLedger(repoDir, advisoryBranch)
				.filter((e) => e.event === "docs")
				.at(-1) ?? null)
		: null;
	if (recorded && LABEL_TO_DECISION[matches[0].label] !== recorded.decision) {
		console.error(
			`stdd check-pr: advisory — the ledger records the docs decision as ` +
				`"${recorded.decision}" but the PR body says "${matches[0].label}"`,
		);
	}
	console.log(`stdd check-pr: OK${okSuffix}`);
}

/** With --base: the evidence claim must be backed by the actual git diff. */
function verifyEvidenceAgainstDiff(
	{ label, content },
	baseRef,
	headRef = "HEAD",
	repoDir = process.cwd(),
	fromPr = false,
) {
	const paths = extractDocPaths(content);
	for (const docPath of paths) {
		try {
			resolveRepoPath(repoDir, docPath, `evidence path ${JSON.stringify(docPath)}`);
		} catch (err) {
			fail(err.message);
		}
	}
	if (label === "Docs updated first") {
		if (paths.length === 0) {
			const suggestion = sentinelSuggestion(content);
			fail(
				`"Docs updated first:" names no doc paths — list the changed docs.` +
					(suggestion ? `\nDid you mean:\n  ${suggestion}` : ""),
			);
		}
		let changed;
		try {
			changed = gitChangedPaths(repoDir, `${baseRef}...${headRef}`);
		} catch (err) {
			fail(`--base ${baseRef}: git diff failed: ${err.stderr?.toString().trim() || err.message}`);
		}
		const missing = paths.filter((p) => !changed.includes(p));
		if (missing.length > 0) {
			fail(`claimed as updated but not changed against ${baseRef}: ${missing.join(", ")}`);
		}
	} else if (label === "Docs checked, no change needed") {
		const absent = paths.filter((p) => {
			if (!fromPr) return !fs.existsSync(resolveRepoPath(repoDir, p, "evidence path"));
			try {
				execFileSync("git", ["-C", repoDir, "cat-file", "-e", `${headRef}:${p}`], {
					stdio: ["ignore", "ignore", "ignore"],
				});
				return false;
			} catch {
				return true;
			}
		});
		if (absent.length > 0) {
			fail(
				`claimed as checked but does not exist in ${fromPr ? "the PR head" : "the tree"}: ${absent.join(", ")}`,
			);
		}
	}
}

/** Evidence paths with whitespace are backticked so extraction is reversible. */
function evidencePath(docPath) {
	return /\s/.test(docPath) ? `\`${docPath}\`` : docPath;
}
