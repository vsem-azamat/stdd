#!/usr/bin/env node
// Publish one package directory from a release tag, safe to rerun.
//
// A tag publishes more than one package, so a failure in a later step must be
// recoverable by rerunning the job. Registry versions are immutable: a plain
// republish of an already-published version fails, which would strand the
// release permanently half-shipped. The exact `name@version` this tag carries
// being on the registry already is the step's success condition, not an error.
//
// The check is deliberately narrow. Only that one spec is treated as done; any
// other outcome — an absent version, an unreachable registry, a refused read —
// falls through to the publish, which then fails loudly rather than silently
// skipping a version nobody shipped.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const directory = process.argv[2];
if (!directory) {
	console.error("usage: publish-package.mjs <package directory>");
	process.exit(2);
}

const manifestPath = path.join(directory, "package.json");
let manifest;
try {
	manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
	console.error(`cannot read ${manifestPath}: ${error.message}`);
	process.exit(2);
}
const { name, version } = manifest;
if (typeof name !== "string" || typeof version !== "string" || !name || !version) {
	console.error(`${manifestPath} names no package version`);
	process.exit(2);
}

const spec = `${name}@${version}`;
const existing = spawnSync("npm", ["view", spec, "version"], { encoding: "utf8" });
if (existing.status === 0 && existing.stdout.trim() === version) {
	console.log(`${spec} is already on the registry — this release step is done`);
	process.exit(0);
}

const published = spawnSync("npm", ["publish", "--access", "public", directory], {
	stdio: "inherit",
});
process.exit(published.status ?? 1);
