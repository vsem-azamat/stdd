# Adapters

Playbooks are agent-neutral markdown with frontmatter (`name`, `description`,
`when`). Adapters compile them into what each agent consumes. `stdd init`
runs the adapters; re-run it after upgrading stdd to refresh the output.

## Common output

Every init installs `.stdd/` into the target repo:

```
.stdd/
├── method.md          # the STDD contract (copy of method/README.md)
├── playbooks/         # agent-neutral playbooks
├── config.json        # stdd check configuration
└── manifest.json      # generated-file hashes and stdd version
```

The generated method, playbooks, config, and manifest under `.stdd/` are
committed methodology. Per-checkout `.stdd/ledger.jsonl` and
`.stdd/plan.md` are working artifacts and stay ignored by default.

Install `@stdd/cli` as an exact project development dependency when hooks or
agent-session commands are enabled. Generated automation uses
`npm exec --offline --package=@stdd/cli@<generated-version> -- stdd`, resolving
the scoped package offline and never falling back to an unscoped registry
package. This repository's own dogfood output runs its checked-out
`cli/stdd.mjs` directly through the git root, so testing an unpublished source
version never depends on npm cache state.

## claude (Claude Code)

Writes one skill per playbook to `.claude/skills/<name>/SKILL.md`:
frontmatter maps `name` directly; `description` carries the playbook's
description plus its `when:` line ("… Use when: …"), because the
description is the only always-visible routing surface — a trigger
condition that lives only in the body is invisible at the moment the
agent picks its next action. The body is the playbook body. Skills are
self-contained copies — regenerate, never hand-edit. A short managed block in
`CLAUDE.md` carries only always-on invariants and points to the method; its
generated source is `.stdd/CLAUDE-snippet.md`.

## codex

Writes the same skill contract to `.agents/skills/<name>/SKILL.md`. Codex can
select a skill from its description or the user can invoke it as `$<name>`.
The adapter also writes `.stdd/AGENTS-snippet.md` and maintains the repo's
`AGENTS.md` in place. The snippet is written between
`stdd:begin`/`stdd:end` marker comments; content outside the markers is never
touched. `AGENTS.md` is user-owned and never manifest-tracked.

## pi

Pi natively discovers the Agent Skills standard registry under
`.agents/skills/`, so its adapter deliberately shares those generated skill
files with Codex. Both hosts resolve the cross-CLI reviewer token to Claude and
therefore produce byte-identical skills; selecting both does not create a
duplicate registry. Pi exposes them as `/skill:<name>`.

Pi's always-on router is different and stays host-local:
`.pi/APPEND_SYSTEM.md` carries the managed STDD section with `/skill:` routing,
while `.stdd/PI-snippet.md` is its generated source. Using Pi's append-system
file avoids a last-writer-wins conflict with Codex's managed `AGENTS.md`
section.

## Lifecycle hooks

`--session-hook` and `--stop-hook` target every selected native agent:

- Claude: `.claude/settings.json`, with one `SessionStart` hook for
  `startup|resume|clear|compact` and optional `Stop`;
- Codex: `.codex/hooks.json`, with one `SessionStart` hook for
  `startup|resume|clear|compact` and optional `Stop`.
- Pi: `.pi/extensions/stdd.js`, with `session_start` plus `session_compact`
  restore handlers and an optional `agent_settled` gate.

Session hooks run only `stdd status --local`. Stop hooks use an
agent-specific output protocol over the same `status --gate` judgment.
Generated hooks never contain the full method or perform network work. On
re-init, the `compact` source is the single context-restoration path: older
managed Claude `PostCompact` entries are removed, while unrelated user hooks
are preserved.

Pi does not expose a pre-stop veto. When its gate reports broken review claims,
the extension queues one corrective follow-up model turn and then fails open;
it never creates an unbounded continuation loop. A conflicting user-owned
`.pi/extensions/stdd.js` is not overwritten.

## CI

CI adapters only transport provider state into portable CLI commands:

- GitHub writes `.github/workflows/stdd.yml`;
- GitLab writes `.gitlab/stdd.gitlab-ci.yml`; same-project MRs authenticate
  with `CI_JOB_TOKEN`, while a fork source project must be on the target's
  CI job-token allowlist. A trusted controlled fork may instead provide a
  masked and hidden `STDD_GITLAB_READ_API_TOKEN` scoped to target-project
  `read_api`; target secrets must never be exposed to untrusted fork code;
- generic prints the `check` and `check-pr` command contract without writing
  provider configuration.

The public SDK exposes the built-in adapter registry and render functions so
other packages can add a host without importing `cli/` internals.
`defineAgentAdapter()` returns an adapter object accepted directly by
`renderAgentInstructions()`; registration in the immutable built-in registry
is not required for third-party composition.

Host-dependent commands stay as renderer tokens in the shared playbook source.
When the `crossCli` block is active, the agent adapter resolves its reviewer
token to another native host: Claude skills name `--via codex`, while Codex
and Pi skills name `--via claude`. The first selected native host is the driver
for the repository-level `review.via` default, so a cross-CLI init records its
opposite; each host skill still names its own explicit override. A profile
without any dispatch route removes the `[review:]` tag and every review
command — it never substitutes a manual self-review.

The profile-agnostic Codex plugin is built with the conservative default
capabilities (`subagents` on, `crossCli` off). Its planning skill names
`--via subagent`; it never names `--via codex`, emits a renderer token, or
falls back to manual self-review.

## Plugin distribution

`plugins/stdd/` packages the Codex skills and lifecycle hooks for marketplace
distribution. `scripts/build-plugin.mjs` regenerates its skills from
`playbooks/` and removes skill directories whose source playbook no longer
exists; generated plugin skills are never an independent source. Plugin
hooks find and call only the adopting repository's project-local
`@stdd/cli`. Without `.stdd/` or that exact dependency they exit without
effect.

## Design rules for adapters

- One source of truth: adapters copy or point, never fork playbook content.
- Always-on instructions contain invariants and routing only; detailed
  workflows live in lazy skills.
- No agent-specific incantations inside `playbooks/` — if an agent needs
  special framing, that framing lives in the adapter.
- Provider YAML owns transport, never method semantics.
- Calm imperative prose. No all-caps compliance shouting: if a rule needs
  shouting to be followed, it needs a `stdd check` rule instead.
