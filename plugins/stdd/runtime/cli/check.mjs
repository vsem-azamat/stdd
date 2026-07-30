import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENT_ADAPTERS, getAgentAdapter, MANDATORY_ROUTING_SKILLS } from "../sdk/adapters.mjs";
import { resolveRepoPath } from "../sdk/path.mjs";
import { hasLocalStddBinary } from "./claude-hooks.mjs";
import { loadConfig } from "./config.mjs";
import {
	CLEANUP_JOURNAL_REL,
	readManifestDocument,
	scanGeneratedDrift,
	VERSION,
} from "./generated-files.mjs";
import {
	currentBranch,
	LEDGER_INTERNAL_TEMP_GIT_GLOBS,
	LEDGER_INTERNAL_TEMP_RELATIVE,
} from "./ledger.mjs";
import {
	findEvidenceLines,
	globToRegExp,
	scanTemporal,
	temporalMatchers,
	workflowValidatesStaleBody,
} from "./lib.mjs";
import { fail } from "./runtime.mjs";
import { WORKER_DELETIONS_REL } from "./worker-fs.mjs";
import { WORKER_METADATA_REL } from "./worker-metadata.mjs";

function listTrackedFiles(dir) {
	try {
		const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const files = out.split("\0").filter(Boolean);
		if (files.length > 0) return files;
	} catch {
		// not a git repo — fall through to a filesystem walk
	}
	const files = [];
	const walk = (rel) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), {
			withFileTypes: true,
		})) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(relPath);
			else files.push(relPath);
		}
	};
	walk("");
	return files;
}

/**
 * Shared repository scan for `check` and `doctor`: committed working
 * artifacts, canonical docs and their temporal-narrative hits, and stale
 * generated files (a stale stamp means the CLI was upgraded without
 * re-running `stdd init`).
 */
function scanRepo(targetDir, config) {
	const files = listTrackedFiles(targetDir);

	const projectLogForbidden = config.projectLog.enabled ? null : globToRegExp("docs/project/**");
	const projectLogArtifacts = projectLogForbidden
		? files.filter((file) => projectLogForbidden.test(file))
		: [];
	const projectLogArtifactSet = new Set(projectLogArtifacts);
	const forbidden = config.forbiddenArtifacts.map(globToRegExp);
	const artifacts = files.filter(
		(file) => !projectLogArtifactSet.has(file) && forbidden.some((re) => re.test(file)),
	);

	const canonical = config.canonicalDocs.map(globToRegExp);
	const canonicalFiles = files.filter((file) => canonical.some((re) => re.test(file)));
	const matchers = temporalMatchers(config.temporalPhrases);
	const temporal = [];
	for (const file of canonicalFiles) {
		const lines = fs.readFileSync(path.join(targetDir, file), "utf8").split("\n");
		for (const hit of scanTemporal(lines, matchers)) temporal.push({ file, ...hit });
	}

	const contentHits = [];
	let added = null;
	if (config.contentRules.some((r) => r.newFilesOnly)) {
		added = addedFiles(targetDir, config.baseRef);
	}
	for (const rule of config.contentRules) {
		const fileRe = globToRegExp(rule.files);
		let targets = files.filter((f) => fileRe.test(f));
		if (rule.newFilesOnly && added !== null) {
			targets = targets.filter((f) => added.includes(f));
		}
		for (const file of targets) {
			const content = fs.readFileSync(path.join(targetDir, file), "utf8");
			if (rule.forbid) {
				const re = new RegExp(rule.forbid);
				content.split("\n").forEach((line, i) => {
					if (re.test(line)) contentHits.push({ file, line: i + 1, rule });
				});
			}
			if (rule.require && !new RegExp(rule.require, "m").test(content)) {
				contentHits.push({ file, line: null, rule });
			}
		}
	}

	return {
		artifacts,
		projectLogArtifacts,
		bookkeeping: trackedBookkeeping(targetDir),
		canonicalFiles,
		temporal,
		contentHits,
		stale: scanGeneratedDrift(targetDir, config),
	};
}

/**
 * stdd's own per-checkout bookkeeping (the ledger, the plan) that git
 * tracks anyway. Hardcoded, not config-driven — these files are never
 * legitimate in history. Outside a git repo tracking is unknowable: [].
 */
function trackedBookkeeping(targetDir) {
	try {
		return execFileSync(
			"git",
			[
				"-C",
				targetDir,
				"ls-files",
				"--",
				".stdd/ledger.jsonl",
				".stdd/plan.md",
				".stdd/worker.json",
				`:(glob)${WORKER_DELETIONS_REL}/**`,
				...LEDGER_INTERNAL_TEMP_GIT_GLOBS.map((glob) => `:(glob)${glob}`),
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		)
			.split("\n")
			.filter(
				(file) =>
					file === ".stdd/ledger.jsonl" ||
					file === ".stdd/plan.md" ||
					file === WORKER_METADATA_REL ||
					file.startsWith(`${WORKER_DELETIONS_REL}/`) ||
					LEDGER_INTERNAL_TEMP_RELATIVE.test(file),
			);
	} catch {
		return [];
	}
}

/** Files added against baseRef, or null when the base is unresolvable. */
function addedFiles(targetDir, baseRef) {
	if (!baseRef) return null;
	try {
		return execFileSync(
			"git",
			[
				"-C",
				targetDir,
				"diff",
				"--diff-filter=A",
				"--name-only",
				"--end-of-options",
				`${baseRef}...HEAD`,
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		)
			.split("\n")
			.filter(Boolean);
	} catch {
		return null;
	}
}

export function check(targetDir) {
	const config = loadConfig(targetDir);
	const { artifacts, projectLogArtifacts, bookkeeping, temporal, contentHits, stale } = scanRepo(
		targetDir,
		config,
	);
	const violations = [
		...artifacts.map((file) => `${file}: committed working artifact (forbiddenArtifacts)`),
		...projectLogArtifacts.map(
			(file) => `${file}: project log is disabled (projectLog.enabled is false)`,
		),
		...bookkeeping.map(
			(file) => `${file}: committed stdd working artifact — per-checkout only; add it to .gitignore`,
		),
		...temporal.map(
			(hit) => `${hit.file}:${hit.line}: temporal narrative in canonical doc ("${hit.phrase}")`,
		),
		...contentHits.map(
			(h) =>
				`${h.file}${h.line ? `:${h.line}` : ""}: ${h.rule.name}` +
				(h.rule.message ? ` — ${h.rule.message}` : h.line ? "" : " — required pattern not found"),
		),
		...stale.map((s) => `${s.file}: ${s.message}`),
	];
	// Enforced locally (the pre-push hook runs stdd check); a detached
	// checkout — CI — has no branch name to validate and skips the rule.
	if (config.branchPattern) {
		const branch = currentBranch(targetDir);
		if (branch && branch !== "HEAD" && !new RegExp(config.branchPattern).test(branch)) {
			violations.push(`branch "${branch}" does not match branchPattern ${config.branchPattern}`);
		}
	}

	if (violations.length > 0) {
		console.error(`stdd check: ${violations.length} violation(s)\n`);
		for (const v of violations) console.error(`  ${v}`);
		process.exit(1);
	}
	console.log("stdd check: OK");
}

/**
 * Config-declared worktree readiness: report each missing required path
 * with its repo-authored fix hint. Purely declarative — existence only,
 * nothing is executed or installed. Returns true when everything passes.
 */
function reportReadiness(targetDir, config, report) {
	const required = config.readiness.required;
	if (required.length === 0) return null;
	const missing = [];
	for (const entry of required) {
		let ready;
		try {
			ready = fs.existsSync(resolveRepoPath(targetDir, entry.path, `readiness path ${entry.path}`));
		} catch (err) {
			fail(`.stdd/config.json: ${err.message}`);
		}
		if (!ready) missing.push(entry);
	}
	for (const entry of missing) {
		report(false, `${entry.path} missing${entry.hint ? ` — ${entry.hint}` : ""}`);
	}
	if (missing.length === 0) {
		report(true, `worktree ready (${required.length}/${required.length} present)`);
	}
	return missing.length === 0;
}

export function doctor(targetDir, readinessOnly = false) {
	const count = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;
	let failed = false;
	const report = (ok, message) => {
		console.log(`${ok ? "✓" : "✗"} ${message}`);
		if (!ok) failed = true;
	};

	if (readinessOnly) {
		if (reportReadiness(targetDir, loadConfig(targetDir), report) === null) {
			console.log("no readiness contract declared (readiness.required in .stdd/config.json)");
		}
		if (failed) process.exit(1);
		return;
	}

	const installed = fs.existsSync(path.join(targetDir, ".stdd", "method.md"));
	report(installed, installed ? ".stdd/ installed" : ".stdd/ is not installed — run stdd init");

	const config = loadConfig(targetDir);
	reportReadiness(targetDir, config, report);
	const { artifacts, projectLogArtifacts, bookkeeping, canonicalFiles, temporal, contentHits, stale } =
		scanRepo(targetDir, config);

	if (config.contentRules.length > 0) {
		report(
			contentHits.length === 0,
			contentHits.length === 0
				? `content rules clean (${count(config.contentRules.length, "rule", "rules")})`
				: `${count(contentHits.length, "content-rule violation", "content-rule violations")} — see stdd check`,
		);
	}

	report(
		canonicalFiles.length > 0,
		canonicalFiles.length > 0
			? `canonical docs present (${count(canonicalFiles.length, "file", "files")})`
			: "no canonical docs found — create docs/domain/ or docs/product/, or adjust canonicalDocs",
	);

	if (projectLogArtifacts.length > 0) {
		report(
			false,
			`${count(projectLogArtifacts.length, "tracked project-log file", "tracked project-log files")} while projectLog.enabled is false — see stdd check`,
		);
	}
	const committed = artifacts.length + bookkeeping.length;
	report(
		committed === 0,
		committed === 0
			? projectLogArtifacts.length > 0
				? "no other committed working artifacts"
				: "no committed working artifacts"
			: `${count(committed, "committed working artifact", "committed working artifacts")} may mislead coding agents`,
	);

	const temporalFiles = new Set(temporal.map((hit) => hit.file)).size;
	report(
		temporalFiles === 0,
		temporalFiles === 0
			? "canonical docs match no configured temporal phrases"
			: `${count(temporalFiles, "canonical doc matches", "canonical docs match")} configured temporal phrases`,
	);

	for (const finding of stale.filter((entry) => entry.file === CLEANUP_JOURNAL_REL)) {
		report(false, `${finding.file}: ${finding.message}`);
	}
	report(
		stale.length === 0,
		stale.length === 0
			? `generated files match stdd v${VERSION}`
			: `${count(stale.length, "generated file is", "generated files are")} stale — re-run stdd init`,
	);

	// informational only — a missing hook is a choice, never a failure
	const hookInstalled = fs.existsSync(path.join(targetDir, ".stdd", "hooks", "pre-push"));
	console.log(
		hookInstalled
			? "· pre-push hook installed (.stdd/hooks/pre-push) — wire via git config core.hooksPath .stdd/hooks"
			: "· no pre-push hook installed — optional: stdd init --hooks",
	);
	let settingsText = "";
	for (const relative of new Set(Object.values(AGENT_ADAPTERS).map((adapter) => adapter.hooksFile))) {
		try {
			settingsText += fs.readFileSync(path.join(targetDir, relative), "utf8");
		} catch {
			// no settings for this agent
		}
	}
	if (
		hookInstalled ||
		/stdd (?:status|stop-hook)|STDD managed Pi lifecycle extension/.test(settingsText)
	) {
		console.log(
			hasLocalStddBinary(targetDir)
				? "· project-local stdd binary is available to hooks"
				: "· project-local stdd binary is missing — install exact @stdd/cli before relying on hooks",
		);
	}

	let selectedInstructionFiles = null;
	try {
		const manifest = readManifestDocument(targetDir);
		if (manifest && Object.hasOwn(manifest, "targets")) {
			const targets = manifest.targets;
			selectedInstructionFiles = new Set(
				targets.tools.map((tool) => getAgentAdapter(tool).instructionsFile),
			);
		}
	} catch (err) {
		const message = err.message.startsWith("targets ")
			? `.stdd/manifest.json targets are invalid — ${err.message.slice("targets ".length)}`
			: `.stdd/manifest.json is invalid — ${err.message}`;
		report(false, `${message}; re-run stdd init`);
		// Do not reinterpret corrupt target metadata as a legacy install.
		selectedInstructionFiles = new Set();
	}
	const instructionAdapters = new Map(
		Object.values(AGENT_ADAPTERS).map((adapter) => [adapter.instructionsFile, adapter]),
	);
	for (const [instructionsFile, adapter] of instructionAdapters) {
		if (selectedInstructionFiles && !selectedInstructionFiles.has(instructionsFile)) continue;
		const instructionsPath = path.join(targetDir, instructionsFile);
		if (!fs.existsSync(instructionsPath)) {
			if (selectedInstructionFiles) {
				report(false, `${instructionsFile} is missing — re-run stdd init for ${adapter.id}`);
			}
			continue;
		}
		const instructions = fs.readFileSync(instructionsPath, "utf8");
		const hasSection = [
			...instructions.matchAll(/<!-- stdd:begin(?:\s[^>]*)?-->\r?\n([\s\S]*?)<!-- stdd:end -->/gu),
		].some((match) => {
			const section = match[1];
			return (
				/^## STDD$/m.test(section) &&
				MANDATORY_ROUTING_SKILLS.every((name) =>
					section.includes(`\`${adapter.explicitPrefix}${name}\``),
				)
			);
		});
		report(
			hasSection,
			hasSection
				? `${instructionsFile} carries the STDD section`
				: `${instructionsFile} has no managed STDD routing contract — re-run stdd init for that agent`,
		);
	}

	const workflowsDir = path.join(targetDir, ".github", "workflows");
	if (fs.existsSync(workflowsDir)) {
		for (const file of fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
			if (workflowValidatesStaleBody(fs.readFileSync(path.join(workflowsDir, file), "utf8"))) {
				report(
					false,
					`.github/workflows/${file} validates the frozen event payload body — ` +
						"body edits will not be re-checked; see stdd init --ci github",
				);
			}
		}
	}

	for (const rel of [
		"pull_request_template.md",
		".github/pull_request_template.md",
		"docs/pull_request_template.md",
	]) {
		const tplPath = path.join(targetDir, ...rel.split("/"));
		if (!fs.existsSync(tplPath)) continue;
		if (findEvidenceLines(fs.readFileSync(tplPath, "utf8")).length > 0) {
			report(
				false,
				`${rel} carries an unquoted evidence label — placeholder residue would pass ` +
					'the gate on every PR; quote template instructions ("> Docs …")',
			);
		}
	}

	if (failed) process.exit(1);
}
