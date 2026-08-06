// The README opens with a picture of real command output. A picture of output
// is worth nothing if the output has since changed, so both halves are checked
// here: that the recorded transcript is still what the CLI prints, and that the
// committed image is still what the renderer makes of that transcript. The
// fixture comes from the recording script so the check and the recording cannot
// describe two different repositories.
//
// What the README's own markup may contain is not tested here — those are
// repository conventions, and this kit already has a mechanism for them:
// `contentRules` in `.stdd/config.json`, enforced by `stdd check` in CI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReadmeFixture, recordDoctorOutput } from "../scripts/record-readme-transcript.mjs";
import { COLUMNS, renderTranscript, wrap } from "../scripts/render-transcript.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "scripts", "render-transcript.mjs");
const TRANSCRIPT = path.join(ROOT, "docs", "assets", "doctor.txt");
const ASSET = path.join(ROOT, "docs", "assets", "doctor.svg");

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
