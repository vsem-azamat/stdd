# STDD universal plugin

This directory is the self-contained STDD distribution for Codex, Claude Code,
and Pi. Every host loads the same conservative-profile skills and bundled CLI
runtime; adopting repositories do not need a local `@stdd/cli` dependency.

## Install

- **Codex:** install `stdd` from a Codex marketplace that points at this
  directory.
- **Claude Code:** install `stdd` from a Claude Code marketplace that points at
  this directory.
- **Pi:** `pi install npm:@stdd/plugin@<version>`. For a source checkout, use
  `pi install ./plugins/stdd`.

The source tree is a distribution input, not proof that a registry release has
occurred. Publishers must run the repository build and verification commands
before releasing it.

## Activation and ownership

Installing the bundle changes no repository. Skills are available globally,
but lifecycle integration stays dormant unless the current checkout contains
`.stdd/`. Run `stdd init` separately when a repository adopts the shared
contract. Repository state, policy, generated native routing, and optional CI
remain repository-owned.

Codex and Claude Code use fail-open SessionStart and Stop command hooks. Pi
restores successful local status output at session start and after compaction,
and may queue one corrective follow-up after a blocked settled turn. Runtime
errors do not trap the host or enter model context. If the bundle cannot read
an adopted contract, update the bundle or re-run initialization with a
compatible STDD CLI.

## Build

From the STDD source root:

```bash
npm run build:plugin
npm pack --dry-run --json ./plugins/stdd
```

The build regenerates skills, the Pi extension, and the bundled runtime;
version-aligns all host manifests; and rejects unsafe or stale publication
paths. Building currently requires Linux held-directory support. The generated
bundle itself remains portable to supported Codex, Claude Code, and Pi hosts.
