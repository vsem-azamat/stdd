import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "stdd.mjs");

async function renderTemplate() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-gitlab-template-"));
	const { stderr } = await exec(
		process.execPath,
		[CLI, "init", repo, "--tools", "codex", "--ci", "gitlab"],
		{ cwd: ROOT },
	);
	assert.equal(stderr, "");
	return fs.readFileSync(path.join(repo, ".gitlab", "stdd.gitlab-ci.yml"), "utf8");
}

function extractDescriptionFetcher(rendered) {
	const match = rendered.match(/node --input-type=module -e '\n([\s\S]*?)\n {6}' \|/);
	assert.ok(match, "the rendered job carries an inline GitLab API fetcher");
	return match[1];
}

async function runDescriptionFetcher(script, overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stdd-gitlab-fetch-"));
	const preload = path.join(dir, "fetch-mock.mjs");
	const capture = path.join(dir, "capture.json");
	fs.writeFileSync(
		preload,
		`import fs from "node:fs";
globalThis.fetch = async (url, options) => {
  fs.writeFileSync(process.env.STDD_FETCH_CAPTURE, JSON.stringify({
    url: String(url),
    headers: options?.headers ?? {}
  }));
  const status = Number(process.env.STDD_FETCH_STATUS);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { description: process.env.STDD_FETCH_DESCRIPTION ?? "" };
    }
  };
};
`,
	);
	const env = {
		...process.env,
		NODE_OPTIONS: `--import=${preload}`,
		STDD_FETCH_CAPTURE: capture,
		STDD_FETCH_STATUS: "200",
		STDD_FETCH_DESCRIPTION: "Docs updated first: method/README.md",
		CI_API_V4_URL: "https://gitlab.example/api/v4",
		CI_PROJECT_ID: "11",
		CI_MERGE_REQUEST_PROJECT_ID: "11",
		CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "11",
		CI_MERGE_REQUEST_IID: "7",
		CI_JOB_TOKEN: "job-token",
		STDD_GITLAB_READ_API_TOKEN: "",
		...overrides,
	};
	try {
		const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "-e", script], {
			env,
		});
		return {
			code: 0,
			stdout,
			stderr,
			request: JSON.parse(fs.readFileSync(capture, "utf8")),
		};
	} catch (err) {
		return {
			code: err.code ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			request: JSON.parse(fs.readFileSync(capture, "utf8")),
		};
	}
}

test("GitLab adapter renders a universally valid default stage and a consumer override", async () => {
	const rendered = await renderTemplate();
	assert.ok(
		rendered.includes(
			"# The job defaults to GitLab's reserved .pre stage, so this include stays valid\n" +
				'# when a consumer defines custom stages without "test". To run STDD in an\n' +
				"# existing consumer stage, override the included job in the root .gitlab-ci.yml.\n" +
				"# The override must name a stage declared by that pipeline:\n#\n" +
				"# stdd:\n#   stage: verify",
		),
	);
	assert.ok(rendered.includes("stdd:\n  stage: .pre\n"));
	assert.doesNotMatch(rendered, /__(?:STAMP|VERSION)__/);
});

test("GitLab description fetch uses safe same-project and explicit fork authentication paths", async () => {
	const script = extractDescriptionFetcher(await renderTemplate());

	const sameProject = await runDescriptionFetcher(script, {
		STDD_GITLAB_READ_API_TOKEN: "must-not-replace-same-project-job-token",
	});
	assert.equal(sameProject.code, 0, sameProject.stderr);
	assert.equal(sameProject.stdout, "Docs updated first: method/README.md");
	assert.equal(sameProject.request.url, "https://gitlab.example/api/v4/projects/11/merge_requests/7");
	assert.deepEqual(sameProject.request.headers, {
		"JOB-TOKEN": "job-token",
		accept: "application/json",
	});

	const forkDenied = await runDescriptionFetcher(script, {
		CI_PROJECT_ID: "22",
		CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "22",
		STDD_FETCH_STATUS: "403",
	});
	assert.equal(forkDenied.code, 1);
	assert.deepEqual(forkDenied.request.headers, {
		"JOB-TOKEN": "job-token",
		accept: "application/json",
	});
	assert.match(forkDenied.stderr, /pipeline project 22[\s\S]*target project 11/i);
	assert.match(forkDenied.stderr, /job token allowlist/i);
	assert.match(forkDenied.stderr, /STDD_GITLAB_READ_API_TOKEN/);
	assert.match(forkDenied.stderr, /trusted/i);

	const trustedFork = await runDescriptionFetcher(script, {
		CI_PROJECT_ID: "22",
		CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "22",
		STDD_GITLAB_READ_API_TOKEN: "target-read-api-token",
	});
	assert.equal(trustedFork.code, 0, trustedFork.stderr);
	assert.deepEqual(trustedFork.request.headers, {
		"PRIVATE-TOKEN": "target-read-api-token",
		accept: "application/json",
	});
});
