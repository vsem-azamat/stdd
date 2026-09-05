---
name: stdd-delegate-slice
description: Hand a slice of work to a worker session with a declared scope, a ledger handoff, and a reviewed result
when: Before implementing a multi-step change whose steps are independent — hand slices to worker sessions (subagent, second CLI, teammate) instead of implementing everything inline; also whenever a worker's result comes back for review.
---

# Delegate a Slice

Roles are fixed. The orchestrator owns the docs edit, the commits, and the
PR. The worker owns red-green inside a declared scope. The handoff artifact
is the ledger, not prose: recorded events survive compaction, chat
summaries do not.

## Before the worker starts (orchestrator)

1. Make the docs decision yourself and record it:
   `stdd docs <decision> [paths…] [--reason <why>]`.
2. Choose the worker boundary and declare the scope. Prefer a managed gitless
   sandbox when the worker does not need Git authority:

   ```bash
   mkdir -p ../.stdd-workers
   stdd worker create ../.stdd-workers/billing \
     --frozen "docs/**,migrations/**" \
     --allowed "src/billing/**,test/billing/**"
   ```

   A sandbox cannot live inside the checkout or any Git repository, so it
   goes beside the project in one hidden `.stdd-workers/` container, never
   as a visible sibling per slice; deleting the container removes every
   sandbox.

   Use `stdd slice new --frozen ... --allowed ...` only when the worker must
   operate in an existing isolated checkout. `--frozen` names globs the worker
   must not touch, `--allowed` the only paths it may change; at least one is
   required. A managed sandbox has no `.git`, dependencies, credentials, or
   build output; run the repository's readiness setup there.
3. Write the brief **to a file** (session scratchpad, never the repo) and
   point the worker at it — a file, unlike pasted context, does not stay
   resident in your window. Template:

   > **Task**: <one sentence>
   > **Spec**: read <canonical doc paths> — the docs edit is already made.
   > **Outcome**: what must be observably true when the slice is done, the
   > constraints and architecture to follow, what proves it, and any
   > interface something else commits to. Internals are yours.
   > **Scope**: declared by `stdd worker create` or `stdd slice new`; check
   > yours with `stdd scope`.
   > **Loop**: failing test first — record it with `stdd red -- <cmd>`;
   > verify with `stdd verify -- <narrowest command>`.
   > **Do not**: commit, push, or edit docs — the orchestrator owns those.
   > **Policy**: copy the `stdd policy show` notes that govern this area —
   > a worker reads the brief, not the repository's standing decisions.
   > **Questions**: ask them now, before starting — not mid-slice.
   > **Report**: write it to <file>; end with exactly one status:
   > `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`.

4. Name the worker's model explicitly in the dispatch — an omitted model
   silently inherits the orchestrator's tier. Mechanical transcription
   tolerates a cheap tier; judgment does not.

5. The worker may be the other CLI: dispatch it headless with the brief
   file (`codex exec` from Claude Code, `claude -p` from Codex) when the
   slice benefits from a second perspective or a different toolchain.

## Parallel slices

Serial dispatch is the default; parallelism is safe only when every
precondition holds:

- **Independence** — no interface handed between the steps: neither
  slice consumes something the other produces.
- **Isolation** — each worker runs in its own managed gitless sandbox or
  worktree (see the worktrees playbook); two workers in one directory race on
  files and test state.
- **Disjoint scopes** — the slices' `--allowed` globs must not overlap;
  an overlap forces serialization, it is never "probably fine".

Dispatch the workers concurrently and review results as they land.
Integration stays serial: merge one slice at a time into the orchestrator's
checkout and re-run its verification after each merge, so a conflict names
the slice that caused it.

While workers run, the orchestrator works too: review a landed slice,
prepare the next brief, draft the PR body. If there is truly nothing to do
until the worker returns, the slice was too big.

## While the worker runs (worker)

- Ask blocking questions before the first edit, then run without
  "should I continue?" pauses.
- Record the red before implementing: `stdd red -- <cmd>` (a genuine test
  failure, not an environment error — the recorder tells you which).
- Record every meaningful verification: `stdd verify -- <cmd>`.
- Leave handoff context in the file, not the chat: `stdd note <text>`.
- End with one status. `BLOCKED` and `NEEDS_CONTEXT` are good outcomes —
  escalating is never penalized.

## After the worker finishes (orchestrator)

1. Run `stdd scope` in the worker environment. For a managed sandbox, then run
   `stdd worker collect <directory>` from the source checkout. Collection
   fails before import on scope, identity, source-drift, or path conflicts,
   never stages or commits, and imports the worker's ledger evidence — the
   orchestrator still verifies the collected checkout freshly.
2. `stdd status` — confirm the loop is complete (docs, genuine red, passing
   verify).
3. **Review the diff, never the report alone.** The report is a claim, and
   a stated rationale never downgrades a finding. Two verdicts, in order:
   - *Spec compliance*: anything **missing** from the brief, anything
     **extra** beyond it (unrequested work is a finding, not a bonus; an
     internal choice within the brief's outcome is not), anything
     **misunderstood**.
   - *Code quality* on what was built.

   With subagents available, dispatch a fresh reviewer that sees the brief,
   the diff, and the report — never your session history — and reviews
   read-only.

   Route the verdict through `stdd review` so it lands in the ledger
   instead of evaporating with the chat.

4. A `BLOCKED` or `NEEDS_CONTEXT` slice is not retried unchanged: add
   context, split the slice, or take it inline.
5. Assemble the PR body from the ledger, not from the worker's summary:
   `stdd evidence` drafts the docs line from the recorded decision and the
   diff. STDD never removes a managed sandbox automatically; delete it
   explicitly only after reviewing the collected result.
