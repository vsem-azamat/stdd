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
};

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
 * blocks do not. Returns `{ label, content }` per hit; a bare label yields
 * empty content.
 */
export function findEvidenceLines(body) {
	const hits = [];
	let inFence = false;
	for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		for (const { label, re } of EVIDENCE_MATCHERS) {
			const m = re.exec(line);
			if (m) hits.push({ label, content: m[1].trim() });
		}
	}
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
	return config;
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
