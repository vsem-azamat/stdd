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
└── config.json        # stdd check configuration
```

`.stdd/` is committed — it is methodology, not a working artifact.

## claude (Claude Code)

Writes one skill per playbook to `.claude/skills/<name>/SKILL.md`:
frontmatter maps `name` directly; `description` carries the playbook's
description plus its `when:` line ("… Use when: …"), because the
description is the only always-visible routing surface — a trigger
condition that lives only in the body is invisible at the moment the
agent picks its next action. The body is the playbook body. Skills are
self-contained copies — regenerate, never hand-edit.

## codex (and any agent that reads AGENTS.md)

Writes `.stdd/AGENTS-snippet.md` and maintains the repo's `AGENTS.md` in
place: the snippet is written between `stdd:begin`/`stdd:end` marker
comments — the file is created when absent, the marked section replaced
when present, content outside the markers never touched. `AGENTS.md` is
user-owned (never manifest-tracked). The snippet is short: it points the
agent at `.stdd/method.md` and lists the playbooks with their `when` lines.

## Design rules for adapters

- One source of truth: adapters copy or point, never fork playbook content.
- No agent-specific incantations inside `playbooks/` — if an agent needs
  special framing, that framing lives in the adapter.
- Calm imperative prose. No all-caps compliance shouting: if a rule needs
  shouting to be followed, it needs a `stdd check` rule instead.
