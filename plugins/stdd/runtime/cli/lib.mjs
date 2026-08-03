import { createHash } from "node:crypto";
import { resolveRepoPath } from "../sdk/path.mjs";
import { assertPrintableSingleLine, isPrintableSingleLine } from "../sdk/text.mjs";

/** Content fingerprint used by the generated-files manifest. */
export function sha256(content) {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function deepFreeze(value) {
	for (const child of Object.values(value)) {
		if (child && typeof child === "object") deepFreeze(child);
	}
	return Object.freeze(value);
}

export const DEFAULT_CONFIG = deepFreeze({
	// Working-artifact paths forbidden by the repository's default authority
	// policy. `stdd check` fails if any tracked file matches. Deliberately
	// narrow — widen or narrow per repo.
	forbiddenArtifacts: ["docs/**/plans/**", "**/*.agent-plan.md", "**/*.agent-spec.md"],
	// Canonical docs describe the present in the repository's chosen
	// language. `stdd check` applies the configured temporal-phrase heuristic;
	// fenced code blocks are skipped.
	canonicalDocs: ["docs/domain/**/*.md", "docs/product/**/*.md"],
	temporalPhrases: ["previously", "no longer", "used to be", "before this change"],
	// Worktree-readiness contract: paths that must exist before verification
	// output can be trusted, each with a repo-authored fix hint. Empty by
	// default — the contract is declared by the adopting repo.
	readiness: { required: [] },
	// Repo-authored content lints: mechanically checkable conventions that
	// would otherwise live in folklore. Empty by default — the adopting
	// repo authors the rules; the kit ships only the mechanism.
	contentRules: [],
	// Authority policy for deferred designs. Repositories that require a
	// strictly current-state-only tracked tree disable the project log; init
	// then compiles that rule into the installed method and agent routing.
	projectLog: { enabled: true },
	// Capability profile: what the agent environment can actually do.
	// Playbooks are compiled against it at init time (cap blocks,
	// `requires:` frontmatter) — never branched at runtime.
	capabilities: { subagents: true, crossCli: false, worktrees: true },
	// The closing review's default route. `stdd review --via` overrides per
	// call; either way the route must be compatible with the capability
	// profile at run time.
	review: { via: "subagent", maxRounds: 0 },
});

/**
 * Parse the session ledger (append-only JSONL). Blank and corrupt lines are
 * skipped — a torn write must never take the whole ledger down.
 */
export function parseLedger(text) {
	const events = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// corrupt line — skip
		}
	}
	return events;
}

/**
 * Was a red run a genuine test failure? Exit 0 is green, never red. Without
 * a configured redPattern the answer is unknowable; with one, the output
 * must show a test-framework failure — anything else (tool missing, config
 * error) is an environment error, not a red.
 */
export function redGenuine(exit, output, redPattern) {
	if (exit === 0) return "no";
	if (!redPattern) return "unknown";
	return new RegExp(redPattern).test(output) ? "yes" : "no";
}

export const EVIDENCE_LABELS = [
	"Docs updated first",
	"Docs checked, no change needed",
	"Docs not applicable",
];

const EVIDENCE_MATCHERS = EVIDENCE_LABELS.map((label) => ({
	label,
	re: new RegExp(`^${label}:[ \\t]*(.*)$`, "i"),
}));

/**
 * Find docs evidence lines in a PR body. Only lines that start at the
 * beginning of a line count — quoted templates (`> Docs …`) and fenced code
 * blocks do not. Returns `{ label, content, line }` per hit (1-indexed
 * lines); a bare label yields empty content.
 */
export function findEvidenceLines(body) {
	const hits = [];
	let inFence = false;
	body
		.replaceAll("\r\n", "\n")
		.split("\n")
		.forEach((line, i) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return;
			}
			if (inFence) return;
			for (const { label, re } of EVIDENCE_MATCHERS) {
				const m = re.exec(line);
				if (m) hits.push({ label, content: m[1].trim(), line: i + 1 });
			}
		});
	return hits;
}

// Truncated label stems, longest-first so "Docs not applicable" wins over a
// hypothetical shorter stem. Each maps a reworded label back to its canonical
// form without a dictionary of previously observed mistakes.
const LABEL_STEMS = [
	{ stem: "docs not applicable", label: "Docs not applicable" },
	{ stem: "docs checked", label: "Docs checked, no change needed" },
	{ stem: "docs updated", label: "Docs updated first" },
];

/**
 * Find near-miss evidence lines in a PR body: lines that carry an evidence
 * label but fail the strict column-0/exact-label match — markdown emphasis,
 * list or quote markers, leading whitespace, or a reworded label. Meant for
 * the zero-hits failure path of `check-pr`; strictly valid lines and fenced
 * code are never near-misses. Returns `{ line, raw, suggestion }` per hit
 * (1-indexed lines), where `suggestion` is the full corrected line.
 */
export function nearMissEvidenceLines(body) {
	const hits = [];
	let inFence = false;
	body
		.replaceAll("\r\n", "\n")
		.split("\n")
		.forEach((raw, i) => {
			if (/^\s*(```|~~~)/.test(raw)) {
				inFence = !inFence;
				return;
			}
			if (inFence) return;
			if (EVIDENCE_MATCHERS.some(({ re }) => re.test(raw))) return;
			// Normalize: strip leading whitespace, quote and list markers, then
			// markdown emphasis and backticks around the label and content.
			const normalized = raw
				.replace(/^[\s>]*/, "")
				.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
				.replaceAll(/[*_`]/g, "")
				.trim();
			let suggestion = null;
			for (const { label, re } of EVIDENCE_MATCHERS) {
				const m = re.exec(normalized);
				if (m) {
					suggestion = `${label}: ${m[1].trim()}`.trimEnd();
					break;
				}
			}
			if (!suggestion) {
				const lower = normalized.toLowerCase();
				const stem = LABEL_STEMS.find((s) => lower.startsWith(s.stem));
				if (stem) {
					const colon = normalized.indexOf(":");
					const content = colon === -1 ? "" : normalized.slice(colon + 1).trim();
					suggestion = `${stem.label}: ${content}`.trimEnd();
				}
			}
			if (suggestion) hits.push({ line: i + 1, raw, suggestion });
		});
	return hits;
}

/**
 * When a `Docs updated first:` line names no doc paths, its content is often
 * a sentinel that belongs to another label. Returns the corrected line
 * template, or null when the content is not a recognizable sentinel.
 */
export function sentinelSuggestion(content) {
	const c = content.trim().toLowerCase();
	if (/^(not applicable|n\/?a)\b/.test(c)) {
		return "Docs not applicable: <why implementation-only>";
	}
	if (/^no (docs )?change needed\b/.test(c)) {
		return "Docs checked, no change needed: <docs + reason>";
	}
	return null;
}

/**
 * True when a workflow validates the PR body from the frozen event payload
 * without an `edited` trigger: `github.event.pull_request.body` piped into
 * `check-pr` means a body-only fix is never re-checked and a re-run replays
 * the stale text. Heuristic on the raw YAML text — no YAML parser by design.
 */
export function workflowValidatesStaleBody(content) {
	return (
		content.includes("github.event.pull_request.body") &&
		content.includes("check-pr") &&
		!/\bedited\b/.test(content)
	);
}

/**
 * Tiny glob dialect: `*` matches within a path segment, `**` matches across
 * segments. No `?`, braces, or character classes — by design.
 */
export function globToRegExp(glob) {
	const segments = glob.split("/");
	const parts = segments.map((segment, i) => {
		const last = i === segments.length - 1;
		if (segment === "**") return last ? ".*" : "(?:[^/]+/)*";
		const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
		return escaped + (last ? "" : "/");
	});
	return new RegExp(`^${parts.join("")}$`);
}

/** Parse a `---`-fenced frontmatter block. CRLF-tolerant. */
export function parseFrontmatter(source) {
	const normalized = source.replaceAll("\r\n", "\n");
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
	if (!match) return { meta: {}, body: normalized };
	const meta = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { meta, body: normalized.slice(match[0].length) };
}

/**
 * Merge a parsed user config over the defaults and validate shape.
 * Throws with an actionable message on invalid input.
 */
export function mergeConfig(parsed) {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("config must be a JSON object");
	}
	const config = { ...DEFAULT_CONFIG, ...parsed };
	for (const key of ["forbiddenArtifacts", "canonicalDocs", "temporalPhrases"]) {
		if (!Array.isArray(config[key]) || config[key].some((v) => typeof v !== "string")) {
			throw new Error(`"${key}" must be an array of strings`);
		}
		for (const [index, value] of config[key].entries()) {
			assertPrintableSingleLine(value, `${key}[${index}]`);
		}
	}
	if ("baseRef" in config && typeof config.baseRef !== "string") {
		throw new Error(`"baseRef" must be a string, e.g. "origin/main"`);
	}
	if ("baseRef" in config) {
		assertPrintableSingleLine(config.baseRef, "baseRef");
	}
	if ("redPattern" in config && config.redPattern != null) {
		if (typeof config.redPattern !== "string") {
			throw new Error(`"redPattern" must be a string regex, e.g. "\\\\d+ failing"`);
		}
		try {
			new RegExp(config.redPattern);
		} catch (err) {
			throw new Error(`"redPattern" is not a valid regex: ${err.message}`);
		}
	}
	if ("branchPattern" in config && config.branchPattern != null) {
		if (typeof config.branchPattern !== "string") {
			throw new Error(`"branchPattern" must be a string regex, e.g. "^(main|dev|feat/|fix/)"`);
		}
		assertPrintableSingleLine(config.branchPattern, "branchPattern");
		try {
			new RegExp(config.branchPattern);
		} catch (err) {
			throw new Error(`"branchPattern" is not a valid regex: ${err.message}`);
		}
	}
	const ruleShapeOk = (r) =>
		typeof r === "object" &&
		r !== null &&
		typeof r.name === "string" &&
		typeof r.files === "string" &&
		(typeof r.forbid === "string" || typeof r.require === "string") &&
		(!("forbid" in r) || typeof r.forbid === "string") &&
		(!("require" in r) || typeof r.require === "string") &&
		(!("message" in r) || typeof r.message === "string") &&
		(!("newFilesOnly" in r) || typeof r.newFilesOnly === "boolean");
	if (!Array.isArray(config.contentRules) || !config.contentRules.every(ruleShapeOk)) {
		throw new Error(
			`"contentRules" must be an array of { name, files, forbid and/or require, ` +
				`message?, newFilesOnly? } entries (forbid or require is required)`,
		);
	}
	for (const [index, rule] of config.contentRules.entries()) {
		assertPrintableSingleLine(rule.name, `contentRules[${index}].name`);
		if ("message" in rule) {
			assertPrintableSingleLine(rule.message, `contentRules[${index}].message`);
		}
		for (const key of ["forbid", "require"]) {
			if (rule[key] == null) continue;
			try {
				new RegExp(rule[key]);
			} catch (err) {
				throw new Error(`contentRules "${rule.name}": ${key} is not a valid regex: ${err.message}`);
			}
		}
	}
	const projectLog = config.projectLog;
	if (
		typeof projectLog !== "object" ||
		projectLog === null ||
		Array.isArray(projectLog) ||
		Object.keys(projectLog).some((key) => key !== "enabled") ||
		("enabled" in projectLog && typeof projectLog.enabled !== "boolean")
	) {
		throw new Error(`"projectLog" must be an object with an optional boolean "enabled" field`);
	}
	config.projectLog = { ...DEFAULT_CONFIG.projectLog, ...projectLog };
	const capsKnown = Object.keys(DEFAULT_CONFIG.capabilities);
	if ("capabilities" in config) {
		const caps = config.capabilities;
		if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
			throw new Error(`"capabilities" must be an object of booleans (${capsKnown.join(", ")})`);
		}
		for (const [key, value] of Object.entries(caps)) {
			if (!capsKnown.includes(key)) {
				throw new Error(`capabilities: unknown capability "${key}" (known: ${capsKnown.join(", ")})`);
			}
			if (typeof value !== "boolean") {
				throw new Error(`capabilities: "${key}" must be a boolean`);
			}
		}
	}
	config.capabilities = { ...DEFAULT_CONFIG.capabilities, ...config.capabilities };
	if ("review" in config) {
		const review = config.review;
		if (typeof review !== "object" || review === null || Array.isArray(review)) {
			throw new Error(`"review" must be an object, e.g. {"via": "codex"}`);
		}
		if ("via" in review && !["subagent", "codex", "claude"].includes(review.via)) {
			throw new Error(`review.via must be "subagent", "codex", or "claude"`);
		}
		if ("maxRounds" in review && (!Number.isSafeInteger(review.maxRounds) || review.maxRounds < 0)) {
			throw new Error(`review.maxRounds must be a non-negative integer (0 = unlimited)`);
		}
	}
	config.review = { ...DEFAULT_CONFIG.review, ...config.review };
	const readiness = config.readiness;
	const entryOk = (e) =>
		typeof e === "object" &&
		e !== null &&
		typeof e.path === "string" &&
		(!("hint" in e) || typeof e.hint === "string");
	if (
		typeof readiness !== "object" ||
		readiness === null ||
		!Array.isArray(readiness.required) ||
		!readiness.required.every(entryOk)
	) {
		throw new Error(`"readiness.required" must be an array of { path, hint? } string entries`);
	}
	for (const entry of readiness.required) {
		assertPrintableSingleLine(entry.path, "readiness path");
		if ("hint" in entry) assertPrintableSingleLine(entry.hint, "readiness hint");
		resolveRepoPath("/", entry.path, `readiness path ${JSON.stringify(entry.path)}`);
	}
	config.forbiddenArtifacts = [...config.forbiddenArtifacts];
	config.canonicalDocs = [...config.canonicalDocs];
	config.temporalPhrases = [...config.temporalPhrases];
	config.contentRules = config.contentRules.map((rule) => ({ ...rule }));
	config.readiness = {
		required: config.readiness.required.map((entry) => ({ ...entry })),
	};
	return config;
}

/**
 * Collapse duplicate same-named check entries (re-runs, cancelled
 * concurrency twins) to the freshest run: the latest `startedAt` wins,
 * array order breaks ties (later wins). A superseded cancel must never
 * read as a red.
 */
export function dedupeChecks(entries) {
	const byName = new Map();
	for (const entry of entries) {
		const prev = byName.get(entry.name);
		if (!prev || (entry.startedAt ?? "") >= (prev.startedAt ?? "")) {
			byName.set(entry.name, entry);
		}
	}
	return [...byName.values()];
}

/**
 * Compile a playbook against the capability profile. `<!-- cap:NAME -->`
 * … `<!-- /cap -->` blocks survive only when the capability is on; the
 * markers themselves never survive. Blocks do not nest, and an unknown
 * capability name, an unclosed block, or a stray close is an authoring
 * error — thrown, never silently passed through.
 */
export function compileCapabilities(body, capabilities) {
	const out = [];
	let open = null;
	for (const line of body.split("\n")) {
		const opener = /^\s*<!--\s*cap:([A-Za-z|]+)\s*-->\s*$/.exec(line);
		const closer = /^\s*<!--\s*\/cap\s*-->\s*$/.test(line);
		if (opener) {
			if (open) throw new Error(`nested cap block "${opener[1]}" inside "${open}"`);
			// cap:a|b names alternatives — the block survives when ANY is on
			for (const name of opener[1].split("|")) {
				if (!(name in capabilities)) {
					throw new Error(`unknown capability "${name}" in cap block`);
				}
			}
			open = opener[1];
			continue;
		}
		if (closer) {
			if (!open) throw new Error("<!-- /cap --> without an open cap block");
			open = null;
			continue;
		}
		if (open && !open.split("|").some((name) => capabilities[name])) continue;
		out.push(line);
	}
	if (open) throw new Error(`unclosed cap block "${open}"`);
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Parse the durable plan (`.stdd/plan.md`): checkbox items with an optional
 * `[red: <substring>]` gate tag, plus entries of a `## Deferred` section
 * and an optional `Mode: inline|delegated` line (first recognized match
 * outside fences; any other value reads as absent). Fenced code blocks are
 * skipped; checkboxes inside Deferred are cuts, not items. Returns
 * `{ items: [{ line, checked, text, red, review }], deferred, mode }`
 * (1-indexed lines; `mode` is `"inline"`, `"delegated"`, or null).
 */
export function parsePlan(text) {
	const items = [];
	const deferred = [];
	let mode = null;
	let inFence = false;
	let inDeferred = false;
	text
		.replaceAll("\r\n", "\n")
		.split("\n")
		.forEach((line, i) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return;
			}
			if (inFence) return;
			// the execution choice made at planning time; only the first
			// recognized value counts, unknown values never match
			const modeLine = /^\s*mode:\s*(inline|delegated)\s*$/i.exec(line);
			if (modeLine && mode === null) mode = modeLine[1].toLowerCase();
			const heading = /^#{1,6}\s+(.*)$/.exec(line);
			if (heading) {
				inDeferred = /^deferred\b/i.test(heading[1].trim());
				return;
			}
			if (inDeferred) {
				const d = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
				if (d?.[1].trim()) deferred.push(d[1].trim());
				return;
			}
			const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
			if (!m) return;
			// tags are read from prose only — a backticked `[red:]`/`[review:]`
			// names the tag as a literal and never gates the item
			const prose = m[2].replace(/(`+).*?\1/g, "");
			const tag = /\[red:\s*([^\]]+)\]/.exec(prose);
			items.push({
				line: i + 1,
				checked: m[1] !== " ",
				text: m[2].trim(),
				red: tag ? tag[1].trim() : null,
				review: /\[review:\s*[^\]]*\]/.test(prose),
			});
		});
	return { items, deferred, mode };
}

/**
 * Grade the plan against the branch's red events. A checkbox is a claim;
 * for `[red:]`-tagged items the ledger is the proof: the item is done only
 * when a red event's recorded command contains the tag's substring and the
 * run was not recorded `genuine: "no"`. A review item is derived directly
 * from the newest verdict and may close while its checkbox stays open; a
 * checked item without proof stays open. Returns
 * `{ total, done, next, unproven }` where `next` is the first open item (or
 * null) and `unproven` lists checked-unproven items.
 */
export function planProgress(plan, redEvents, reviewEvents = []) {
	// a [review:] item is proven by the branch's NEWEST review verdict —
	// an approval followed by changes-requested reopens the claim
	const latestReview = reviewEvents.at(-1) ?? null;
	const proven = (item) => {
		if (item.review) return latestReview?.verdict === "approved";
		return (
			item.red === null ||
			redEvents.some((e) => e.genuine !== "no" && typeof e.cmd === "string" && e.cmd.includes(item.red))
		);
	};
	const graded = plan.items.map((item) => ({
		...item,
		// Review is a ledger-derived transition, not a plan projection:
		// approval closes the item even when its user-authored box stays open.
		done: item.review ? proven(item) : item.checked && proven(item),
	}));
	return {
		total: graded.length,
		done: graded.filter((i) => i.done).length,
		next: graded.find((i) => !i.done) ?? null,
		unproven: graded.filter((i) => i.checked && !i.done),
	};
}

/**
 * Parse and validate a reviewer's complete raw output. The boundary accepts
 * exactly one JSON object with optional surrounding whitespace; prose,
 * fences, wrappers, trailing values, and multiple objects all reject.
 * Returns null on any syntax or schema failure, so malformed output can
 * never be recovered into an approval.
 */
export function parseReviewResult(text) {
	if (typeof text !== "string") return null;
	const candidate = text.trim();
	if (candidate === "") return null;
	return gradeReviewCandidate(candidate);
}

const REVIEW_RESULT_REQUIRED_KEYS = ["summary", "findings"];
const REVIEW_RESULT_KEYS = new Set(REVIEW_RESULT_REQUIRED_KEYS);
const REVIEW_FINDING_REQUIRED_KEYS = ["severity", "message"];
const REVIEW_FINDING_KEYS = new Set([...REVIEW_FINDING_REQUIRED_KEYS, "path", "line"]);

function hasOwnContractShape(value, requiredKeys, allowedKeys) {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype &&
		requiredKeys.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowedKeys.has(key))
	);
}

function gradeReviewCandidate(candidate) {
	let parsed;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}
	if (!hasOwnContractShape(parsed, REVIEW_RESULT_REQUIRED_KEYS, REVIEW_RESULT_KEYS)) return null;
	if (!isPrintableSingleLine(parsed.summary)) return null;
	if (!Array.isArray(parsed.findings)) return null;
	const findings = [];
	for (const f of parsed.findings) {
		if (!hasOwnContractShape(f, REVIEW_FINDING_REQUIRED_KEYS, REVIEW_FINDING_KEYS)) return null;
		if (f.severity !== "blocking" && f.severity !== "advisory") return null;
		if (!isPrintableSingleLine(f.message)) return null;
		// absent path/line are legitimate ("missing behavior" findings);
		// a wrongly typed field rejects the whole result — never coerce
		const findingPath = Object.hasOwn(f, "path") ? f.path : null;
		const findingLine = Object.hasOwn(f, "line") ? f.line : null;
		if (findingPath != null && !isPrintableSingleLine(findingPath)) return null;
		if (findingLine != null && (!Number.isSafeInteger(findingLine) || findingLine <= 0)) return null;
		findings.push({
			severity: f.severity,
			path: findingPath,
			line: findingLine,
			message: f.message,
		});
	}
	return { summary: parsed.summary, findings };
}

/** The verdict is derived from findings, never self-declared. */
export function deriveReviewVerdict(findings) {
	return findings.some((f) => f.severity === "blocking") ? "changes-requested" : "approved";
}

// An ATX heading as Markdown defines it: up to three leading spaces, one to six
// hashes, then either whitespace and a title or nothing at all. `#hashtag` is
// not a heading. Group 1 is the level, group 2 the title when present.
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

// A setext underline (`Appendix` over `--------`) is a heading too. A run of
// `=` or `-` on its own line is also a thematic break; either way it ends the
// section, and closing early only ever grants less.
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/**
 * Append `- <line>` under `## <heading>`, creating the section when absent and
 * inserting at the end of an existing one rather than at file end. Shared by
 * the durable plan's `## Deferred` and the policy document's two sections.
 */
function appendUnderHeading(content, heading, line) {
	const lines = content.replaceAll("\r\n", "\n").split("\n");
	const idx = lines.findIndex((l) => {
		const match = l.match(ATX_HEADING);
		return match?.[1].length === 2 && (match[2] ?? "").trim().toLowerCase() === heading.toLowerCase();
	});
	if (idx === -1) {
		const base = content === "" ? "" : content.endsWith("\n") ? content : `${content}\n`;
		return `${base}${base === "" ? "" : "\n"}## ${heading}\n\n- ${line}\n`;
	}
	let end = lines.length;
	for (let i = idx + 1; i < lines.length; i++) {
		if (ATX_HEADING.test(lines[i])) {
			end = i;
			break;
		}
	}
	let insert = end;
	while (insert > idx + 1 && lines[insert - 1].trim() === "") insert--;
	if (insert === idx + 1) lines.splice(insert, 0, "", `- ${line}`);
	else lines.splice(insert, 0, `- ${line}`);
	return lines.join("\n");
}

export function appendDeferred(content, text) {
	return appendUnderHeading(content, "Deferred", assertPrintableSingleLine(text, "deferred cut"));
}

/**
 * The outward, irreversible effects a policy permission may pre-authorize.
 * Closed on purpose: an action absent from this set cannot be granted, which
 * is what stops a policy file from waiving a gate the loop must prove.
 */
export const POLICY_ACTIONS = deepFreeze([
	"merge",
	"deploy",
	"publish",
	"migrate",
	"force-push",
	"external-mutation",
]);

export function appendPolicyNote(content, text) {
	return appendUnderHeading(content, "Notes", assertPrintableSingleLine(text, "policy note"));
}

export function assertPolicyAction(action) {
	if (!POLICY_ACTIONS.includes(action)) {
		throw new Error(
			`unknown policy action ${JSON.stringify(action)} (known: ${POLICY_ACTIONS.join(", ")})`,
		);
	}
	return action;
}

export function appendPolicyPermission(content, action, condition) {
	const safeAction = assertPolicyAction(assertPrintableSingleLine(action, "policy action"));
	const safeCondition = assertPrintableSingleLine(condition, "policy condition");
	return appendUnderHeading(content, "Permissions", `${safeAction} — when: ${safeCondition}`);
}

/**
 * Read the policy document. Only `## Permissions` entries are permissions — an
 * item under any other heading is a note however much it reads like a grant.
 *
 * The document is tracked and hand-editable, so the closed action set is
 * enforced here as well as on the write path: an entry naming an action the
 * kit does not know is reported as `rejected` and grants nothing. Validating
 * only `stdd policy allow` would rest the guarantee on the CLI being used.
 */
export function parsePolicy(text) {
	const notes = [];
	const permissions = [];
	const rejected = [];
	let section = null;
	for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
		// Any heading closes the current section — a level-one `# Appendix`
		// after `## Permissions` must not leave later bullets inside it.
		// Markdown allows up to three leading spaces and an empty heading, so
		// both count; `#hashtag` is not a heading and closes nothing.
		const heading = raw.match(ATX_HEADING);
		if (heading) {
			const name = heading[1].length === 2 ? (heading[2] ?? "").trim().toLowerCase() : null;
			section = name === "permissions" || name === "notes" ? name : null;
			continue;
		}
		if (SETEXT_UNDERLINE.test(raw)) {
			section = null;
			continue;
		}
		const item = raw.match(/^-\s+(.*\S)\s*$/);
		// The document is hand-editable, so the reader holds the writer's line
		// rule too: a bidi or zero-width entry never becomes a grant. Such a
		// line is dropped rather than reported in `rejected` — echoing
		// unprintable bytes into a diagnostic is what that rule exists to
		// prevent. `rejected` is for entries that name an action outside the
		// closed set: a legible grant someone meant, and must be told was
		// ignored.
		if (!item || !isPrintableSingleLine(item[1])) continue;
		if (section === "permissions") {
			const entry = item[1].match(/^(\S+)\s+—\s+when:\s+(.+)$/);
			if (!entry) continue;
			if (POLICY_ACTIONS.includes(entry[1])) {
				permissions.push({ action: entry[1], condition: entry[2] });
			} else {
				rejected.push(item[1]);
			}
		} else if (section === "notes") {
			notes.push(item[1]);
		}
	}
	return { notes, permissions, rejected };
}

function levenshtein(a, b) {
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

/**
 * Closest known name for a mistyped one, or null. Containment wins
 * ("light-ci-status" carries "status"); otherwise a small edit distance
 * (≤2) catches plain typos without matching arbitrary words.
 */
export function didYouMean(input, candidates) {
	const lower = input.toLowerCase();
	const contained = candidates
		.filter((c) => c.length >= 4 && (lower.includes(c) || c.includes(lower)))
		.sort((a, b) => b.length - a.length)[0];
	if (contained) return contained;
	let best = null;
	let bestDist = 3;
	for (const c of candidates) {
		const d = levenshtein(lower, c);
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return best;
}

/**
 * Extract repo-relative markdown paths from an evidence line's content.
 * Prose (reasons, dashes, backticks) around the paths is ignored.
 */
export function extractDocPaths(content) {
	const quoted = [];
	const withoutQuoted = content.replace(/(`+)(.*?)\1/g, (_whole, _ticks, value) => {
		const candidate = value.trim();
		if (candidate.endsWith(".md")) quoted.push(candidate);
		return " ";
	});
	const bare = withoutQuoted.match(/[\p{L}\p{N}_][\p{L}\p{N}_./-]*\.md(?=$|[\s,;:)\]}])/gu) ?? [];
	return [...new Set([...quoted, ...bare])];
}

/**
 * Build a temporal-phrase matcher. Word-ish boundaries on both sides so
 * hyphenated compounds ("no longer-lived") do not match.
 */
export function temporalMatchers(phrases) {
	return phrases.map((phrase) => ({
		phrase,
		re: new RegExp(`(?<![\\w-])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i"),
	}));
}

/**
 * Scan markdown lines for temporal narrative, skipping fenced code blocks
 * and inline code spans — a backticked phrase is a literal being named,
 * not narrative. Returns `{ line, phrase }` hits (1-indexed lines).
 */
export function scanTemporal(lines, matchers) {
	const hits = [];
	let inFence = false;
	lines.forEach((line, i) => {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			return;
		}
		if (inFence) return;
		// A span opens and closes with backtick runs of the same length
		// (CommonMark), so `x`, ``x`` … all strip; a stray backtick strips
		// nothing.
		const prose = line.replace(/(`+).*?\1/g, "");
		for (const { phrase, re } of matchers) {
			if (re.test(prose)) hits.push({ line: i + 1, phrase });
		}
	});
	return hits;
}
