#!/usr/bin/env node
// Render a captured command transcript to a self-contained SVG terminal card.
//
// The card carries its own dark background, so one asset reads as intentional
// in both GitHub themes and on npm — a `<picture>` pair would need two exports
// and still would not track npm's own theme. No dependencies: this repository
// limits dev tooling to Biome, and a README asset is not a reason to widen that.
//
// Input is the real output of a real command, so the asset can be regenerated
// and compared. Nothing here invents a line. Importing this module renders
// nothing; only a direct invocation writes a file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COLORS = {
	background: "#0d1117",
	border: "#30363d",
	prompt: "#7d8590",
	command: "#e6edf3",
	text: "#c9d1d9",
	pass: "#3fb950",
	fail: "#f85149",
	note: "#6e7681",
};

// Monospace only through a system stack: a pinned family that the reader lacks
// shifts every glyph advance and overflows the viewBox.
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const SIZE = 13.5;
const ADVANCE = SIZE * 0.6;
const LINE = 21;
const PAD_X = 18;
const PAD_Y = 16;

// A terminal wraps a long line rather than widening; so does the card, at a
// width that stays legible on a phone.
export const COLUMNS = 76;

const escapeXml = (text) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Colour a line by the status glyph the CLI already prints, not by guessing. */
function colorFor(line) {
	const glyph = line.trimStart()[0];
	if (glyph === "✓") return COLORS.pass;
	if (glyph === "✗") return COLORS.fail;
	if (glyph === "·") return COLORS.note;
	return COLORS.text;
}

const points = (text) => Array.from(text);
const size = (text) => points(text).length;

// The card commits to a column width, so the renderer has to know what each
// character costs in terminal cells. Deciding that for arbitrary Unicode needs
// East Asian width data and emoji-presentation rules — a table this repository
// would have to hand-roll and keep current, exercised by nothing the generator
// actually produces. So the renderer refuses what it cannot measure instead of
// guessing: printable ASCII plus the glyphs this CLI prints, each one cell. A
// wide character slipping through would silently overflow the frame; this way
// the failure is loud and says what to do.
const MEASURABLE = /^[\x20-\x7E✓✗·—]*$/u;

export function assertMeasurable(line) {
	if (MEASURABLE.test(line)) return;
	const offending = points(line).find((character) => !MEASURABLE.test(character));
	throw new Error(
		`render-transcript: cannot measure ${JSON.stringify(offending)} in terminal cells — ` +
			"add it to MEASURABLE with its width, or the card would overflow its own frame",
	);
}

export function wrap(line) {
	const cells = points(line);
	if (cells.length <= COLUMNS) return [line];
	// Hard-wrapped at the column boundary, exactly as a terminal of this width
	// does it: every character is kept, in order, and nothing is reflowed. Word
	// wrapping with a hanging indent reads a little better and is not what the
	// command printed — and the difference is not the renderer's to invent, since
	// the whole point of the asset is that it shows real output.
	const rows = [];
	for (let index = 0; index < cells.length; index += COLUMNS) {
		rows.push(cells.slice(index, index + COLUMNS).join(""));
	}
	return rows;
}

/** The SVG for one transcript, as bytes-in-a-string; callers decide where it goes. */
export function renderTranscript(transcriptText, prompt) {
	// Colour is decided per source line and inherited by its continuations, so a
	// wrapped failure does not turn grey halfway through.
	const source = transcriptText.replace(/\n+$/, "").split("\n");
	// The prompt is part of the transcript and wraps like the rest of it. Left
	// unwrapped it would set the card's width by itself, which is the one thing
	// the column budget exists to prevent.
	const promptLine = `$ ${prompt}`;
	for (const line of [promptLine, ...source]) assertMeasurable(line);
	const output = source.flatMap((line) => wrap(line).map((text) => ({ text, fill: colorFor(line) })));
	const rows = [
		...wrap(promptLine).map((text, index) => ({
			kind: index === 0 ? "command" : "commandTail",
			text,
			fill: COLORS.command,
		})),
		...output.map((row) => ({ kind: "output", ...row })),
	];

	const columns = Math.max(...rows.map((row) => size(row.text)));
	const width = Math.round(PAD_X * 2 + columns * ADVANCE);
	const height = PAD_Y * 2 + rows.length * LINE;

	const lines = rows.map((row, index) => {
		const y = PAD_Y + LINE * index + SIZE;
		if (row.kind === "command") {
			// `$ ` is dimmed and the command is not, so the first row is drawn in two
			// pieces at the columns the wrap already accounted for.
			return (
				`  <text x="${PAD_X}" y="${y}" fill="${COLORS.prompt}">$</text>\n` +
				`  <text x="${PAD_X + ADVANCE * 2}" y="${y}" fill="${COLORS.command}">${escapeXml(row.text.slice(2))}</text>`
			);
		}
		if (row.text === "") return "";
		return `  <text x="${PAD_X}" y="${y}" fill="${row.fill}">${escapeXml(row.text)}</text>`;
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(`${prompt} — ${output.length} lines of output`)}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="7" fill="${COLORS.background}" stroke="${COLORS.border}"/>
  <g font-family="${FONT}" font-size="${SIZE}" xml:space="preserve">
${lines.filter(Boolean).join("\n")}
  </g>
</svg>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [, , inputPath, outputPath, ...promptParts] = process.argv;
	if (!inputPath || !outputPath || promptParts.length === 0) {
		console.error("usage: render-transcript.mjs <transcript> <output.svg> <prompt words…>");
		process.exit(2);
	}
	const svg = renderTranscript(fs.readFileSync(inputPath, "utf8"), promptParts.join(" "));
	fs.writeFileSync(outputPath, svg);
	console.log(`${outputPath}: ${svg.length} bytes`);
}
