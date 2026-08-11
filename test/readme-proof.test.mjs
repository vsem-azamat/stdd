// The README carries three generated images: one of real command output, and two
// schematic diagrams. A picture of output is worth nothing if the output has
// since changed, so both halves are checked here — that the recorded transcript
// is still what the CLI prints, and that the committed image is still what the
// renderer makes of that transcript. The fixture comes from the recording script
// so the check and the recording cannot describe two different repositories.
//
// The diagrams have no output to compare against, so what is checked of them is
// what can be: that each asset is what its generator produces, that no label
// outgrows the box it is drawn in, and that every command word, subcommand, and
// flag they teach is one the CLI names itself. Whether the plain-English wording
// beside a command is true of it stays a review concern.
//
// What the README's own markup may contain is not tested here — those are
// repository conventions, and this kit already has a mechanism for them:
// `contentRules` in `.stdd/config.json`, enforced by `stdd check` in CI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReadmeFixture, recordDoctorOutput } from "../scripts/record-readme-transcript.mjs";
import { fit, LEVELS, LOOP, renderLevels, renderLoop } from "../scripts/render-diagram.mjs";
import { COLUMNS, renderTranscript, wrap } from "../scripts/render-transcript.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "scripts", "render-transcript.mjs");
const TRANSCRIPT = path.join(ROOT, "docs", "assets", "doctor.txt");
const ASSET = path.join(ROOT, "docs", "assets", "doctor.svg");
const DIAGRAMS = [
	["loop.svg", renderLoop],
	["levels.svg", renderLevels],
];

test("the README's recorded transcript is what doctor prints today", () => {
	const dir = buildReadmeFixture();
	try {
		assert.equal(
			recordDoctorOutput(dir),
			fs.readFileSync(TRANSCRIPT, "utf8"),
			"docs/assets/doctor.txt no longer matches doctor's output — re-run scripts/record-readme-transcript.mjs",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the README's asset is what the renderer makes of that transcript", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-render-"));
	const out = path.join(directory, "doctor.svg");
	try {
		execFileSync(process.execPath, [RENDERER, TRANSCRIPT, out, "stdd", "doctor"], { stdio: "pipe" });
		assert.deepEqual(
			fs.readFileSync(out),
			fs.readFileSync(ASSET),
			"docs/assets/doctor.svg is stale — re-run scripts/record-readme-transcript.mjs",
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("no output line can widen the card, however long one word is", () => {
	// The card's width is a design constraint, so a path or URL longer than the
	// line limit has to be split rather than allowed to decide the image's size.
	const word = "a".repeat(COLUMNS * 2 + 5);
	for (const line of [
		word,
		`✗ ${word}`,
		`✗ finding about ${word} and more text after it`,
		// Aligned output: the run of spaces has to survive the wrap.
		`loop:   docs ✓   red ✓   ${"verify ".repeat(12)}✓`,
		// Leading indentation is part of the line like anything else.
		`        ${"x".repeat(COLUMNS * 2)}`,
		// No word to break at: the line must still survive, not vanish.
		" ".repeat(COLUMNS + 10),
	]) {
		const rows = wrap(line);
		for (const row of rows) {
			const columns = Array.from(row).length;
			assert.ok(columns <= COLUMNS, `row of ${columns} columns exceeds ${COLUMNS}`);
		}
		// The whole contract, in one line: a hard wrap reflows nothing, so the rows
		// concatenate back to exactly what the command printed. Spacing, alignment,
		// and every character survive because none of them is the renderer's to
		// reinterpret.
		assert.equal(rows.join(""), line, "wrapping altered the line");
	}
});

test("the renderer refuses text whose terminal width it cannot determine", () => {
	// A wide character counted as one cell would push the text past the frame the
	// card draws around it. Since the renderer has no East Asian width table, the
	// only honest options are refusing and misrepresenting; it refuses.
	for (const line of ["✗ docs/看板/plan.md", "✗ status 🙂", "✗ width\ttab"]) {
		assert.throws(
			() => renderTranscript(`${line}\n`, "stdd doctor"),
			/cannot measure .* in terminal cells/,
			line,
		);
	}
	// And still renders what the CLI actually prints, glyphs included.
	assert.match(renderTranscript("✓ ok\n· note — optional\n", "stdd doctor"), /^<svg /);
});

test("a long command cannot widen the card either", () => {
	// The prompt is transcript too. Unwrapped it would set the width by itself,
	// which is exactly what the column budget exists to prevent.
	const widthOf = (svg) => Number(svg.match(/^<svg [^>]*\bwidth="(\d+)"/)[1]);
	const atBudget = renderTranscript("✓ ok\n", "x".repeat(COLUMNS - 2));
	const wellOver = renderTranscript("✓ ok\n", `stdd verify -- ${"x".repeat(COLUMNS * 3)}`);
	assert.equal(widthOf(wellOver), widthOf(atBudget), "a long command widened the card");
	// Capped width must not mean truncated content: every character of the command
	// is still drawn, across as many rows as it takes. Only text nodes are counted
	// — the `x` in each element's coordinate attribute is not content.
	const drawn = [...wellOver.matchAll(/>([^<]*)<\/text>/g)].map((match) => match[1]).join("");
	assert.equal((drawn.match(/x/g) ?? []).length, COLUMNS * 3, "wrapping the command dropped part of it");
});

test("the README's diagrams are what the renderer makes of their data", () => {
	// The diagrams are schematic rather than recorded, so there is no command to
	// compare them against — but they are still generated, and a generated file
	// committed to the tree is checked against its generator here for the same
	// reason the plugin bundle and the native prebuilds are.
	for (const [name, render] of DIAGRAMS) {
		const asset = path.join(ROOT, "docs", "assets", name);
		assert.ok(fs.existsSync(asset), `docs/assets/${name} is missing — run scripts/render-diagram.mjs`);
		assert.equal(
			fs.readFileSync(asset, "utf8"),
			render(),
			`docs/assets/${name} is stale — re-run scripts/render-diagram.mjs`,
		);
	}
});

test("a label too wide for its box is refused rather than drawn over the frame", () => {
	// A diagram has no wrapping to fall back on: its columns are fixed by the
	// layout, so a label that outgrows one either overlaps its neighbour or spills
	// past the card. Neither is something to discover by looking at the picture.
	assert.throws(() => fit("stdd docs updated-first docs/domain/pricing.md", 120, 12), /does not fit/);
	assert.equal(fit("stdd red -- npm test", 300, 12), "stdd red -- npm test");
});

test("every command word, subcommand, and flag the diagrams name is one the CLI states", () => {
	// The diagrams teach commands, so a rename that leaves them behind teaches a
	// command that no longer exists. Running them is not an option — they would
	// mutate a repository, spawn a reviewer, or poll a forge — so what is checked
	// is every token the CLI names itself: the command words and flags it prints in
	// its usage, and, for a command that enumerates subcommands when refusing a
	// bogus one, that set. Argument order and option values are not covered here;
	// they are what the closing review reads the diagram for.
	const run = (...args) =>
		spawnSync(process.execPath, [path.join(ROOT, "cli", "stdd.mjs"), ...args], { encoding: "utf8" });

	const refusal = run("no-such-command");
	const usage = refusal.stdout.match(/Usage: stdd <([^>]+)>/);
	assert.ok(usage, `stdd stopped printing its usage line: ${refusal.stdout.trim()}`);
	const commands = usage[1].split("|");

	/** The subcommands a command lists when it refuses one, in either shape it prints. */
	const enumerated = (command) => {
		const text = Object.values(run(command, "zzz-not-a-subcommand"))
			.filter((value) => typeof value === "string")
			.join("\n");
		const listed = text.match(/— use (.+)$/m)?.[1] ?? "";
		const spelled = [...text.matchAll(new RegExp(`stdd ${command} ([a-z][a-z-]*)`, "g"))].map(
			(match) => match[1],
		);
		// "start, finish, or reset" — the conjunction is a separator too, or the last
		// subcommand would arrive as "or reset" and never match.
		return [...listed.split(/,|\bor\b/), ...spelled].map((word) => word.trim()).filter(Boolean);
	};

	// A level's command is a list of the lines it is drawn on, so a wrapped command
	// is reassembled before parsing — otherwise its continuation, and every flag on
	// it, is dropped from this check without a word.
	const taught = [...LOOP.map((step) => [step.command]), ...LEVELS.flatMap((level) => level.commands)]
		.map((lines) => lines.join(" ").split(/\s+/).filter(Boolean))
		.filter((tokens) => tokens[0] === "stdd");
	assert.ok(taught.length >= 6, "the diagrams stopped naming commands, so this proves nothing");

	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-diagram-"));
	let subcommandsChecked = 0;
	let flagsChecked = 0;
	try {
		for (const [, command, ...rest] of taught) {
			assert.ok(
				commands.includes(command),
				`the diagrams name "stdd ${command}", which the CLI does not accept`,
			);
			// A first argument that is a flag, the `--` separator, or a path is not a
			// subcommand, and probing anyway would run the command for real.
			const positionalPath = (token) => token === "." || token.includes("/");
			if (rest[0] && !rest[0].startsWith("-") && !positionalPath(rest[0])) {
				const accepted = enumerated(command);
				assert.ok(
					accepted.length > 0,
					`stdd ${command} no longer enumerates its subcommands when refusing one`,
				);
				assert.ok(
					accepted.includes(rest[0]),
					`the diagrams name "stdd ${command} ${rest[0]}", but ${command} takes only ${accepted.join(", ")}`,
				);
				subcommandsChecked += 1;
			}

			const flags = rest.filter((token) => /^--[a-z]/.test(token));
			if (flags.length === 0) continue;
			// The usage line is global, so finding `--watch` in it proves nothing about
			// `stdd ci`. Argument parsing is strict and runs before any command does work,
			// which gives a safe way to ask this exact command line whether it parses:
			// append a flag nothing accepts and require the refusal to name that one. Had
			// it named a taught flag instead, parsing stopped at ours. Run from an empty
			// directory, so a future parser that tolerated the bogus flag would execute
			// somewhere harmless and fail this assertion rather than touch the repository.
			const bogus = "--zzz-not-a-flag";
			const separator = rest.indexOf("--");
			const argv =
				separator === -1
					? [...rest, bogus]
					: [...rest.slice(0, separator), bogus, ...rest.slice(separator)];
			const probe = spawnSync(process.execPath, [path.join(ROOT, "cli", "stdd.mjs"), command, ...argv], {
				encoding: "utf8",
				cwd: workspace,
			});
			assert.notEqual(
				probe.status,
				0,
				`stdd ${command} accepted ${bogus}, so this proves nothing about its flags`,
			);
			assert.ok(
				probe.stderr.includes(bogus),
				`stdd ${command} refused before reaching ${bogus}: ${probe.stderr.trim()}`,
			);
			for (const flag of flags) {
				assert.ok(
					!probe.stderr.includes(flag),
					`the diagrams pass ${flag} to stdd ${command}, and it was refused: ${probe.stderr.trim()}`,
				);
				flagsChecked += 1;
			}
		}
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
	assert.ok(subcommandsChecked > 0 && flagsChecked > 0, "neither a subcommand nor a flag was reached");
});
