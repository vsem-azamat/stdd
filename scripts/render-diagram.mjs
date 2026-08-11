#!/usr/bin/env node
// Render the README's two schematic diagrams: the loop one change goes through,
// and the three levels at which this kit can be adopted.
//
// Both are diagrams rather than recordings, so nothing here can be compared
// against a command — but they are generated, and the generator is the only
// place their wording lives, so a diagram cannot drift from the page while the
// page still shows an old picture. Each card carries its own dark background:
// one asset reads as intentional in both GitHub themes and on npm, where a
// `<picture>` pair would need two exports and still not track npm's theme.
//
// Monospace, because the frame is fixed and a box has no wrapping to fall back
// on — see scripts/svg-text.mjs for what that buys and what it forbids. No
// dependencies: this repository limits dev tooling to Biome, and a README asset
// is not a reason to widen that. Importing this module renders nothing; only a
// direct invocation writes a file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advance, assertMeasurable, escapeXml, FONT } from "./svg-text.mjs";

const CARD = { background: "#0d1117", border: "#30363d", rule: "#21262d" };
const INK = { bright: "#e6edf3", body: "#c9d1d9", dim: "#8b949e", faint: "#6e7681" };

// One hue per step, chosen so the two steps a reader already has a colour for —
// the failing test and the passing one — get the colour they expect.
const ACCENT = {
	blue: "#58a6ff",
	purple: "#bc8cff",
	red: "#f85149",
	grey: "#8b949e",
	green: "#3fb950",
	teal: "#39c5cf",
	amber: "#d29922",
};

const WIDTH = 900;
const PAD = 24;

/** The text, if it fits `width` at `size`; otherwise an error naming both. */
export function fit(text, width, size) {
	assertMeasurable(text);
	const needed = advance(text, size);
	if (needed > width) {
		throw new Error(
			`render-diagram: ${JSON.stringify(text)} does not fit ${width}px at ${size}px ` +
				`(needs ${Math.ceil(needed)}px) — shorten the label or widen the column`,
		);
	}
	return text;
}

function label({ x, y, text, fill, size, weight, anchor }) {
	const attributes = [`x="${x}"`, `y="${y}"`, `fill="${fill}"`, `font-size="${size}"`];
	if (weight) attributes.push(`font-weight="${weight}"`);
	if (anchor) attributes.push(`text-anchor="${anchor}"`);
	return `  <text ${attributes.join(" ")}>${escapeXml(text)}</text>`;
}

function frame(height) {
	return (
		`  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="7" ` +
		`fill="${CARD.background}" stroke="${CARD.border}"/>`
	);
}

function svg(height, ariaLabel, body) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(ariaLabel)}">
${frame(height)}
  <g font-family="${FONT}" xml:space="preserve">
${body.filter(Boolean).join("\n")}
  </g>
</svg>
`;
}

// --- the loop ---

const STEP = { height: 58, top: 62 };
const COLUMN = {
	rail: 42,
	title: { x: 68, width: 170, size: 13 },
	plain: { x: 250, width: 310, size: 12 },
	command: { x: 580, width: 296, size: 12 },
	records: { x: 580, width: 296, size: 11 },
};

export const LOOP = [
	{
		title: "agree what changes",
		accent: "blue",
		plain: ["You and the agent settle the behaviour", "first. No code is written yet."],
		command: 'stdd task start "gross pricing"',
		records: "one task boundary, in the ledger",
	},
	{
		title: "write the spec",
		accent: "purple",
		plain: ["Edit the docs that describe it. That", "edit is the spec, and it comes first."],
		command: "stdd docs updated-first pricing.md",
		records: "which docs the change is based on",
	},
	{
		title: "watch it fail",
		accent: "red",
		plain: ["Run the new test and watch it fail for", "the reason you meant — the red step."],
		command: "stdd red -- npm test",
		records: "the failure, and that it was genuine",
	},
	{
		title: "make it pass",
		accent: "grey",
		plain: ["Only now write code, and only enough", "to satisfy that one test."],
		command: "",
		records: "nothing yet — the diff is the record",
	},
	{
		title: "prove it passes",
		accent: "green",
		plain: ["Run it again, green this time. Editing", "afterwards makes this stale, on purpose."],
		command: "stdd verify -- npm test",
		records: "the green run, against that checkout",
	},
	{
		title: "get it reviewed",
		accent: "teal",
		plain: ["A reviewer that never saw your chat log", "reads the diff and the plan."],
		// Plain `stdd review`, not `--via codex`: the route comes from the project's
		// configured profile, and a default install has `crossCli` off, so a diagram
		// teaching the other CLI would teach a command that install refuses.
		command: "stdd review",
		records: "the verdict, and what it reviewed",
	},
	{
		title: "state the evidence",
		accent: "amber",
		// Not "names the docs it changed": a change with no docs edit states that
		// instead, and `stdd evidence` prints the finished line only for the
		// docs-changed case. Promising the wrong one of the three sentinels here
		// would contradict rule 5 on the same page.
		plain: ["The PR body carries one evidence line:", "which docs changed, or why none did."],
		command: "stdd evidence --base origin/main",
		records: "the line CI checks against the diff",
	},
	{
		// Green twice on purpose: the same fact has to hold locally and then on the
		// head being merged, and the second one is the only one anybody else sees.
		title: "wait for green",
		accent: "green",
		plain: ["A PR is done when its checks settle", "green on the head you are merging."],
		command: "stdd ci --watch",
		records: "CI refuses a claim the diff denies",
	},
];

const LOOP_HEADING = "one change, from the ask to a green pull request";
// Precise about who reads what. Steps 1-6 append to the session ledger; step 7
// derives a line from that ledger and the diff, and step 8 polls the forge. The
// ledger is private and CI never consumes it — CI reads the diff and the PR body.
// Calling steps 7 and 8 "the gates reading those files" got both halves wrong.
const LOOP_FOOTER =
	"Steps 1-6 record what happened in a ledger on your machine. CI never reads it; it checks the diff and the PR body.";

export function renderLoop() {
	const railTop = STEP.top + 10;
	const railBottom = STEP.top + (LOOP.length - 1) * STEP.height + 10;
	const rulesAt = STEP.top + LOOP.length * STEP.height + 8;
	const height = rulesAt + 40;

	const body = [
		label({
			x: PAD,
			y: 36,
			text: fit(LOOP_HEADING, WIDTH - PAD * 2, 13),
			fill: INK.bright,
			size: 13,
			weight: "bold",
		}),
		`  <line x1="${COLUMN.rail}" y1="${railTop}" x2="${COLUMN.rail}" y2="${railBottom}" stroke="${CARD.border}" stroke-width="2"/>`,
	];

	LOOP.forEach((step, index) => {
		const top = STEP.top + index * STEP.height;
		const accent = ACCENT[step.accent];
		body.push(
			`  <circle cx="${COLUMN.rail}" cy="${top + 10}" r="11" fill="${accent}"/>`,
			// The step number sits on its own accent, so it is drawn in the card's
			// background colour rather than in ink.
			label({
				x: COLUMN.rail,
				y: top + 14,
				text: fit(String(index + 1), 22, 12),
				fill: CARD.background,
				size: 12,
				weight: "bold",
				anchor: "middle",
			}),
			label({
				x: COLUMN.title.x,
				y: top + 14,
				text: fit(step.title, COLUMN.title.width, COLUMN.title.size),
				fill: accent,
				size: COLUMN.title.size,
				weight: "bold",
			}),
			...step.plain.map((line, row) =>
				label({
					x: COLUMN.plain.x,
					y: top + 12 + row * 15,
					text: fit(line, COLUMN.plain.width, COLUMN.plain.size),
					fill: INK.body,
					size: COLUMN.plain.size,
				}),
			),
			step.command === ""
				? ""
				: label({
						x: COLUMN.command.x,
						y: top + 12,
						text: fit(step.command, COLUMN.command.width, COLUMN.command.size),
						fill: INK.bright,
						size: COLUMN.command.size,
					}),
			label({
				x: COLUMN.records.x,
				// With no command to run, the line about what gets recorded takes the
				// row's first line rather than floating under an empty slot.
				y: step.command === "" ? top + 12 : top + 28,
				text: fit(`→ ${step.records}`, COLUMN.records.width, COLUMN.records.size),
				fill: INK.dim,
				size: COLUMN.records.size,
			}),
		);
	});

	body.push(
		`  <line x1="${PAD}" y1="${rulesAt}" x2="${WIDTH - PAD}" y2="${rulesAt}" stroke="${CARD.rule}"/>`,
		label({
			x: PAD,
			y: rulesAt + 24,
			text: fit(LOOP_FOOTER, WIDTH - PAD * 2, 11),
			fill: INK.dim,
			size: 11,
		}),
	);

	return svg(height, `${LOOP_HEADING}: ${LOOP.map((step) => step.title).join(", ")}`, body);
}

// --- the adoption levels ---

const LEVEL = { top: 58, height: 178, gap: 21, pad: 16 };
const LEVEL_WIDTH = (WIDTH - PAD * 2 - LEVEL.gap * 2) / 3;

export const LEVELS = [
	{
		title: "my agent only",
		accent: "blue",
		// One entry per command, each a list of the lines it is drawn on: a command too
		// wide for the card is wrapped for display, and only the data knows that two
		// lines are one command rather than two.
		commands: [["/plugin install stdd@stdd"], ["pi install npm:@stdd/plugin"]],
		body: [
			"Skills load on demand and the",
			"lifecycle runtime rides along.",
			"Nothing is written to a repo.",
		],
	},
	{
		title: "my team's repository",
		accent: "teal",
		commands: [["stdd init", "  --tools claude,codex,pi"]],
		// "Writes", not "commits": init generates files and stages nothing. A reader
		// who expects a commit would go looking for one that never happened.
		body: [
			"Writes .stdd/ — the method, the",
			"policy, and native routing for",
			"each agent. You commit it.",
		],
	},
	{
		title: "every pull request",
		accent: "amber",
		// Two commands you add to a job you already have — stdd generates no
		// provider workflow, so the card names the contract, not an installer.
		commands: [["stdd check ."], ["stdd check-pr -", "  --base origin/main"]],
		body: [
			"CI reads the diff and the PR",
			"body. A docs claim the diff",
			"does not back fails the check.",
		],
	},
];

const LEVELS_HEADING = "three levels of adoption — cumulative, and none of them requires the next";
const LEVELS_FOOTER = "Start where the problem is. A team can add the layer above it later, or never.";

export function renderLevels() {
	const height = LEVEL.top + LEVEL.height + 42;
	const body = [
		label({
			x: PAD,
			y: 36,
			text: fit(LEVELS_HEADING, WIDTH - PAD * 2, 13),
			fill: INK.bright,
			size: 13,
			weight: "bold",
		}),
	];

	LEVELS.forEach((level, index) => {
		const x = PAD + index * (LEVEL_WIDTH + LEVEL.gap);
		const inner = x + LEVEL.pad;
		const innerWidth = LEVEL_WIDTH - LEVEL.pad * 2;
		const accent = ACCENT[level.accent];
		body.push(
			`  <rect x="${x}" y="${LEVEL.top}" width="${LEVEL_WIDTH}" height="${LEVEL.height}" rx="6" fill="#161b22" stroke="${CARD.border}"/>`,
			// The accent bar carries the level's identity, so the eyebrow above the
			// title can stay quiet.
			`  <rect x="${x}" y="${LEVEL.top}" width="${LEVEL_WIDTH}" height="3" rx="1.5" fill="${accent}"/>`,
			label({
				x: inner,
				y: LEVEL.top + 30,
				text: fit(`LEVEL ${index + 1}`, innerWidth, 10),
				fill: accent,
				size: 10,
				weight: "bold",
			}),
			label({
				x: inner,
				y: LEVEL.top + 52,
				text: fit(level.title, innerWidth, 13),
				fill: INK.bright,
				size: 13,
				weight: "bold",
			}),
			...level.commands.flat().map((line, row) =>
				label({
					x: inner,
					y: LEVEL.top + 84 + row * 16,
					text: fit(line, innerWidth, 11),
					fill: accent,
					size: 11,
				}),
			),
			...level.body.map((line, row) =>
				label({
					x: inner,
					y: LEVEL.top + 134 + row * 16,
					text: fit(line, innerWidth, 11),
					fill: INK.dim,
					size: 11,
				}),
			),
			// A plus sign in each gap, because the levels add up rather than replace
			// one another — the one thing a reader has to take from this picture.
			index === 0
				? ""
				: label({
						x: x - LEVEL.gap / 2,
						y: LEVEL.top + LEVEL.height / 2 + 5,
						text: fit("+", LEVEL.gap, 15),
						fill: INK.dim,
						size: 15,
						weight: "bold",
						anchor: "middle",
					}),
		);
	});

	body.push(
		label({
			x: PAD,
			y: LEVEL.top + LEVEL.height + 28,
			text: fit(LEVELS_FOOTER, WIDTH - PAD * 2, 11),
			fill: INK.dim,
			size: 11,
		}),
	);

	return svg(height, `${LEVELS_HEADING}: ${LEVELS.map((level) => level.title).join(", ")}`, body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets");
	for (const [name, render] of [
		["loop.svg", renderLoop],
		["levels.svg", renderLevels],
	]) {
		const target = path.join(assets, name);
		const rendered = render();
		fs.writeFileSync(target, rendered);
		console.log(`${path.relative(process.cwd(), target)}: ${rendered.length} bytes`);
	}
}
