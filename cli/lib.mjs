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
