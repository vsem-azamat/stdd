---
name: stdd-delegate-slice
description: Hand a slice of work to a worker session with a declared scope and a ledger handoff
when: An orchestrating session delegates implementation work to a worker session (subagent, second CLI, teammate).
---

# Delegate a Slice

Roles are fixed. The orchestrator owns the docs edit, the commits, and the
PR. The worker owns red-green inside a declared scope. The handoff artifact
is the ledger — chat summaries do not survive compaction; recorded events
do.

## Before the worker starts (orchestrator)

1. Make the docs decision yourself and record it:
   `stdd docs <decision> [paths…] [--reason <why>]`.
2. Declare the scope — this also snapshots the checkout baseline:

   ```bash
   stdd slice new --frozen "docs/**,migrations/**" --allowed "src/billing/**,test/billing/**"
   ```

   `--frozen`: globs the slice must not touch. `--allowed`: globs the slice
   may touch — anything outside is a violation. At least one is required.
3. Write the brief from this template — short, the contract lives in files:

   > **Task**: <one sentence>
   > **Spec**: read <canonical doc paths> — the docs edit is already made.
   > **Scope**: declared via `stdd slice new`; check yours with `stdd scope`.
   > **Loop**: failing test first — record it with `stdd red -- <cmd>`;
   > verify with `stdd verify -- <narrowest command>`.
   > **Do not**: commit, push, or edit docs — the orchestrator owns those.

## While the worker runs (worker)

- Record the red before implementing: `stdd red -- <cmd>` (a genuine test
  failure, not an environment error — the recorder tells you which).
- Record every meaningful verification: `stdd verify -- <cmd>`.
- Leave handoff context in the file, not the chat: `stdd note <text>`.

## After the worker finishes (orchestrator)

1. `stdd scope` — session-introduced changes to frozen paths or outside the
   allowed paths fail; inherited dirt is reported separately and never
   blamed on the slice.
2. `stdd status` — confirm the loop is complete (docs, genuine red, passing
   verify).
3. Assemble the PR body from the ledger, not from the worker's summary:
   `stdd evidence` drafts the docs line from the recorded decision and the
   diff.
