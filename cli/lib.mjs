import { createHash } from "node:crypto";

/** Content fingerprint used by the generated-files manifest. */
export function sha256(content) {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export const DEFAULT_CONFIG = {
	// Working-artifact paths that must never be committed. `stdd check` fails
	// if any tracked file matches. Deliberately narrow — widen per repo.
	forbiddenArtifacts: ["docs/**/plans/**", "**/*.agent-plan.md", "**/*.agent-spec.md"],
	// Canonical docs must describe the present, in English. `stdd check`
	// flags temporal narrative that belongs in git history or a PR
	// description. Fenced code blocks are skipped.
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
	// Capability profile: what the agent environment can actually do.
	// Playbooks are compiled against it at init time (cap blocks,
	// `requires:` frontmatter) — never branched at runtime.
	capabilities: { subagents: true, crossCli: false, worktrees: true },
};

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
	const config = { ...DEFAULT_CONFIG, ...parsed };
	for (const key of ["forbiddenArtifacts", "canonicalDocs", "temporalPhrases"]) {
		if (!Array.isArray(config[key]) || config[key].some((v) => typeof v !== "string")) {
			throw new Error(`"${key}" must be an array of strings`);
		}
	}
	if ("baseRef" in config && typeof config.baseRef !== "string") {
		throw new Error(`"baseRef" must be a string, e.g. "origin/main"`);
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
	for (const rule of config.contentRules) {
		for (const key of ["forbid", "require"]) {
			if (rule[key] == null) continue;
			try {
				new RegExp(rule[key]);
			} catch (err) {
				throw new Error(`contentRules "${rule.name}": ${key} is not a valid regex: ${err.message}`);
			}
		}
	}
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
	return config;
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
		const opener = /^\s*<!--\s*cap:([A-Za-z]+)\s*-->\s*$/.exec(line);
		const closer = /^\s*<!--\s*\/cap\s*-->\s*$/.test(line);
		if (opener) {
			if (open) throw new Error(`nested cap block "${opener[1]}" inside "${open}"`);
			if (!(opener[1] in capabilities)) {
				throw new Error(`unknown capability "${opener[1]}" in cap block`);
			}
			open = opener[1];
			continue;
		}
		if (closer) {
			if (!open) throw new Error("<!-- /cap --> without an open cap block");
			open = null;
			continue;
		}
		if (open && !capabilities[open]) continue;
		out.push(line);
	}
	if (open) throw new Error(`unclosed cap block "${open}"`);
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Parse the durable plan (`.stdd/plan.md`): checkbox items with an optional
 * `[red: <substring>]` gate tag, plus entries of a `## Deferred` section.
 * Fenced code blocks are skipped; checkboxes inside Deferred are cuts, not
 * items. Returns `{ items: [{ line, checked, text, red }], deferred }`
 * (1-indexed lines).
 */
export function parsePlan(text) {
	const items = [];
	const deferred = [];
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
			const heading = /^#{1,6}\s+(.*)$/.exec(line);
			if (heading) {
				inDeferred = /^deferred\b/i.test(heading[1].trim());
				return;
			}
			if (inDeferred) {
				const d = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
				if (d && d[1].trim()) deferred.push(d[1].trim());
				return;
			}
			const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
			if (!m) return;
			const tag = /\[red:\s*([^\]]+)\]/.exec(m[2]);
			items.push({
				line: i + 1,
				checked: m[1] !== " ",
				text: m[2].trim(),
				red: tag ? tag[1].trim() : null,
			});
		});
	return { items, deferred };
}

/**
 * Grade the plan against the branch's red events. A checkbox is a claim;
 * for `[red:]`-tagged items the ledger is the proof: the item is done only
 * when a red event's recorded command contains the tag's substring and the
 * run was not recorded `genuine: "no"`. A checked-but-unproven item stays
 * open. Returns `{ total, done, next, unproven }` where `next` is the
 * first open item (or null) and `unproven` lists checked-unproven items.
 */
export function planProgress(plan, redEvents) {
	const proven = (item) =>
		item.red === null ||
		redEvents.some((e) => e.genuine !== "no" && typeof e.cmd === "string" && e.cmd.includes(item.red));
	const graded = plan.items.map((item) => ({ ...item, done: item.checked && proven(item) }));
	return {
		total: graded.length,
		done: graded.filter((i) => i.done).length,
		next: graded.find((i) => !i.done) ?? null,
		unproven: graded.filter((i) => i.checked && !i.done),
	};
}

/**
 * Append a scope cut under the plan's `## Deferred` section, creating the
 * section (or the whole content) as needed. Inserts after the section's
 * last non-blank line, before any following heading.
 */
export function appendDeferred(content, text) {
	const lines = content.replaceAll("\r\n", "\n").split("\n");
	const idx = lines.findIndex((l) => /^##\s+Deferred\s*$/i.test(l));
	if (idx === -1) {
		const base = content === "" ? "" : content.endsWith("\n") ? content : `${content}\n`;
		return `${base}${base === "" ? "" : "\n"}## Deferred\n\n- ${text}\n`;
	}
	let end = lines.length;
	for (let i = idx + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	let insert = end;
	while (insert > idx + 1 && lines[insert - 1].trim() === "") insert--;
	if (insert === idx + 1) lines.splice(insert, 0, "", `- ${text}`);
	else lines.splice(insert, 0, `- ${text}`);
	return lines.join("\n");
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
	return content.match(/[A-Za-z0-9_][A-Za-z0-9_./-]*\.md\b/g) ?? [];
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
 * Scan markdown lines for temporal narrative, skipping fenced code blocks.
 * Returns `{ line, phrase }` hits (1-indexed lines).
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
		for (const { phrase, re } of matchers) {
			if (re.test(line)) hits.push({ line: i + 1, phrase });
		}
	});
	return hits;
}
