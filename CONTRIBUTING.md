# Contributing

stdd dogfoods itself. Before opening a PR, read
[`method/README.md`](method/README.md) — the loop applies here too.

## Ground rules

- **Docs first.** A behavior change (CLI semantics, method rules, playbook
  content) updates the relevant markdown in the same PR, as the first
  reviewable commit.
- **Red before green.** CLI changes come with a failing test in `test/`
  first. `node:test` only — no test-framework dependencies.
- **PR evidence.** Every PR body carries exactly one of
  `Docs updated first:` / `Docs checked, no change needed:` /
  `Docs not applicable:`. CI enforces this with `stdd check-pr`.
- **No working artifacts.** Plans and scratchpads stay out of the tree;
  rationale goes in the PR description.
- **Zero runtime dependencies.** The CLI must keep installing instantly.
  Dev-time tooling is limited to Biome.

## Workflow

```bash
npm ci
npm test
npm run check     # Biome lint + format (CI mode)
npm run selfcheck # stdd check on this repo
```

All three must pass locally before pushing; CI runs them on Node 20/22/24.

## Playbook and method edits

Playbooks are agent-neutral: calm imperative prose, no agent-specific
incantations, no all-caps compliance shouting. If a rule needs shouting to
be followed, propose a `stdd check` rule instead.

## Releases

Maintainers publish by tagging: bump `version` in `package.json`, tag
`vX.Y.Z`, push the tag. The release workflow verifies tag↔version, runs the
full gate, and publishes to npm with provenance.
