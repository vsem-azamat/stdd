#!/usr/bin/env node
// Record the README's proof transcript, and render it.
//
// The README opens with a picture of `stdd doctor` finding real problems. The
// fixture it runs against is defined here rather than in the test, so the
// recording and the check that the recording is current cannot describe two
// different repositories: `test/readme-proof.test.mjs` imports this builder.
//
// Run after any change to doctor's output, including a version bump — the
// version stamp is part of what doctor prints.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "stdd.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const RENDERER = path.join(ROOT, "scripts", "render-transcript.mjs");
const TRANSCRIPT = path.join(ROOT, "docs", "assets", "doctor.txt");
const ASSET = path.join(ROOT, "docs", "assets", "doctor.svg");

const git = (dir, ...args) =>
	execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		stdio: "pipe",
	});

/**
 * A repository that adopted stdd and kept the plan files from whatever it used
 * before, plus the workflow mistake `doctor` can name: a PR gate reading the
 * event payload's frozen body. Every finding in the README's image comes from
 * here, so nothing in that image is invented.
 */
export function buildReadmeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-readme-"));
	// The caller only owns the directory once this returns, so anything that
	// throws during setup has to remove it here — otherwise a failed run leaves a
	// temporary repository behind and no caller's cleanup block is ever reached.
	try {
		populateFixture(dir);
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	return dir;
}

function populateFixture(dir) {
	git(dir, "init", "-q", "-b", "main");
	execFileSync(process.execPath, [CLI, "init", dir, "--tools", "claude"], { stdio: "pipe" });
	const files = {
		"docs/domain/billing.md": "# Billing\n\nInvoices are issued monthly.\n",
		"docs/domain/auth.md": "# Auth\n\nSessions expire after 30 days.\n",
		"docs/architecture/plans/migrate-billing.md": "# Plan: migrate billing\n\n- [ ] step 1\n",
		"docs/architecture/plans/split-api.md": "# Plan: split the API\n\n- [x] design\n",
		"payments.agent-plan.md": "# Auth rework\n",
		"search.agent-spec.md": "# Search spec\n",
		// A minimal stub, not a model of a correct workflow — the `## CI`
		// section of `method/reference-integration.md` states what one has to
		// get right. All this file has to do is carry the frozen-event-payload
		// pattern `doctor` detects. Its invocation is still scoped and version-pinned, so the
		// fixture never demonstrates resolving the unrelated unscoped `stdd`
		// package.
		".github/workflows/ci.yml":
			"name: CI\non: pull_request\njobs:\n  docs:\n    runs-on: ubuntu-latest\n    steps:\n" +
			`      - run: echo "\${{ github.event.pull_request.body }}" | npx --yes @stdd/cli@${VERSION} check-pr -\n`,
	};
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(dir, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "fixture");
}

/**
 * `doctor` exits 1 when it has findings, which is the whole point of the image.
 * The CLI also exits 1 on an operational failure, so the shape of the expected
 * failure is asserted rather than assumed: accepting a partial stdout would
 * record a truncated transcript that the check then compares against itself and
 * passes.
 */
export function recordDoctorOutput(dir) {
	const run = spawnSync(process.execPath, [CLI, "doctor", dir], { encoding: "utf8" });
	if (run.error) throw run.error;
	if (run.signal) throw new Error(`stdd doctor was killed by ${run.signal}`);
	if (run.status !== 1) {
		throw new Error(`stdd doctor exited ${run.status}; findings are reported with 1`);
	}
	if (run.stderr !== "") throw new Error(`stdd doctor wrote to stderr: ${run.stderr.trim()}`);
	if (!run.stdout.endsWith("\n")) throw new Error("stdd doctor output ends mid-line");
	// The fixture is built to produce exactly these two findings. Requiring both
	// by name is what distinguishes a complete report from a run that died after
	// printing the first one — a count of "at least one" would accept that.
	for (const finding of ["committed working artifacts", "frozen event payload body"]) {
		if (!run.stdout.includes(finding)) {
			throw new Error(`stdd doctor did not report ${finding} — the fixture no longer models it`);
		}
	}
	return run.stdout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dir = buildReadmeFixture();
	try {
		fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
		fs.writeFileSync(TRANSCRIPT, recordDoctorOutput(dir));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	execFileSync(process.execPath, [RENDERER, TRANSCRIPT, ASSET, "stdd", "doctor"], {
		stdio: "inherit",
	});
	console.log(`recorded ${path.relative(ROOT, TRANSCRIPT)}`);
}
