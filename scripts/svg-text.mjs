// What the README's generated assets are allowed to say, and how wide it is.
//
// Both renderers draw text into a fixed frame — a terminal card of N columns, a
// diagram box of N pixels — so both need to know what a string costs before
// drawing it. Neither can ask a font. So the rule lives here once: monospace
// only, one cell per character, and a refusal for anything this cannot measure.
// Duplicating that in two files is how one of them ends up with a stale table.

// Monospace only through a system stack: a pinned family the reader lacks shifts
// every glyph advance and overflows the frame it was measured against.
export const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

// The widest advance among the stack above; Consolas is narrower, none is wider,
// so measuring at 0.6em never underestimates a string.
export const ADVANCE_RATIO = 0.6;

// Deciding a character's width for arbitrary Unicode needs East Asian width data
// and emoji-presentation rules — a table this repository would have to hand-roll
// and keep current, exercised by nothing the generators actually produce. So they
// refuse what they cannot measure instead of guessing: printable ASCII plus the
// glyphs this CLI prints, each one cell. A wide character slipping through would
// silently overflow the frame; this way the failure is loud and says what to do.
const MEASURABLE = /^[\x20-\x7E✓✗·—→]*$/u;

export const cells = (text) => Array.from(text);

export const cellCount = (text) => cells(text).length;

export const escapeXml = (text) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function assertMeasurable(line) {
	if (MEASURABLE.test(line)) return;
	const offending = cells(line).find((character) => !MEASURABLE.test(character));
	throw new Error(
		`svg-text: cannot measure ${JSON.stringify(offending)} in terminal cells — ` +
			"add it to MEASURABLE with its width, or the asset would overflow its own frame",
	);
}

/** How wide `text` draws at `size`, in pixels, as an upper bound. */
export const advance = (text, size) => cellCount(text) * size * ADVANCE_RATIO;
