# The STDD Method

This is the working contract. It is written for the agent or developer doing
the change, in the order the work happens.

## Sources of truth

Every repository adopting STDD names a **permanent docs tree** (for example
`docs/`) with an explicit hierarchy — typically product intent above domain
rules above implementation layers. When layers disagree, stop and reconcile
before implementing.

Three artifacts make claims about behavior, each in its own way:

- **Docs are the intended contract** — what the system is supposed to do.
- **Tests are the executable contract** — what the system provably does.
- **Code is the observed implementation** — what the system actually does.

A disagreement between them blocks implementation until they are reconciled.
None silently overrides the others: stale docs get corrected, wrong tests get
fixed, accidental behavior gets documented or removed — each resolution is an
explicit decision, not a default in favor of any one artifact.

## The loop

```
classify → read docs → docs edit (the spec) → failing test → implement → verify → PR evidence
```

1. **Classify the change.**
   - *Behavior:* anything a user, operator, or downstream system can observe —
     workflows, pricing, states, permissions, API contracts, copy with
     business meaning.
   - *Implementation-only:* refactors, lint fixes, build plumbing, mechanical
     dependency updates that alter no behavior or architecture contract.
2. **Read the relevant docs first.** For behavior changes, read the matching
   source-of-truth documents before proposing anything.
3. **Edit the docs — that edit is the spec.** If the docs are missing, stale,
   or ambiguous, update them before tests and code. Make the docs edit the
   first reviewable unit — the first commit where commits are used, otherwise
   the opening docs-only diff of the PR — so the behavior contract can be
   reviewed on its own. If the docs already cover the behavior, do not add
   duplicate prose — record that they were checked (see PR evidence).
4. **Write the failing test.** Red before green. Exception below.
5. **Implement** until the test passes, then refactor.
6. **Verify with the narrowest meaningful command.** Never claim "done",
   "fixed", or "clean" without fresh verification evidence. Narrowest
   meaningful governs the inner loop; once a PR exists, verification is
   complete only when its required checks settle terminal-green on the
   current head commit.
7. **State PR evidence.** Every PR carries exactly one of:
   - `Docs updated first:` — list the changed docs;
   - `Docs checked, no change needed:` — list the docs and the reason;
   - `Docs not applicable:` — why the change is implementation-only.

   The line must name its evidence — docs paths or a reason. A bare label
   with nothing after the colon fails `stdd check-pr`, and only a line
   starting at the beginning of a line counts (quoted templates and code
   blocks do not).

   When no valid line exists but a near-miss does — a markdown-formatted
   label, a list or quote marker in front of it, or a wrong sentinel
   wording — `stdd check-pr` points at that line and prints the corrected
   form. The suggestion is advisory: the pass condition does not change.

   With `--base <ref>` the claim is verified against the actual diff:
   every doc path named after `Docs updated first:` must be a file changed
   between the base ref and `HEAD` (and at least one path must be named);
   paths named after `Docs checked, no change needed:` must exist in the
   tree. Claiming a docs update the diff does not contain fails CI.

   With `--pr <number|.>` the live PR is validated exactly as CI will see
   it: the body is fetched from the forge, the base is the PR's own, and
   the diff is taken against the PR's head commit — when the local checkout
   is not on that commit, the head is fetched rather than silently diffing
   the wrong tree. `.` resolves the current branch's PR.

   `stdd evidence --base <ref>` drafts the line from ground truth instead
   of recall. When canonical docs changed against the base, it prints the
   finished `Docs updated first:` line to stdout — safe to embed in a PR
   body via command substitution. When none changed, the remaining two
   sentinels need an authored reason: the templates go to stderr and the
   command exits nonzero, so substitution cannot silently embed a template.
   The base comes from `--base` or the `baseRef` key in `.stdd/config.json`;
   there is no built-in default.

## The frontend exception: design-first

Frontend **visual** work — layout, styling, markup structure, presentation
copy, component composition — is design-first, not test-first. A
failing-test-first loop forces the visual outcome to be specified before it
is explored; brittle rendering assertions then punish every design iteration.

The exception covers presentation, not meaning. Copy with business meaning —
prices, statuses, permissions, legal text, anything a user relies on as a
fact — is **behavior**: it goes through the docs edit and the normal loop.
Only its visual arrangement is design-first.

- Build the visual part freely; verify it visually (screenshots reviewed by a
  human).
- Never write tests asserting static copy, class names, or pure rendering
  output.
- After the visual part settles, add tests only for real behavior contracts:
  hooks, formatters, state transitions, eligibility and conditional logic,
  accessibility roles.
- Client-side **logic** follows the normal loop.

## Working artifacts are never committed

Plans, spec files, todo lists, handoff notes, and execution logs are working
artifacts. They help one session and go stale immediately after. Committed,
they outrank fresher docs in code search and become a second source of truth.

Where their content belongs instead:

| Content | Home |
| --- | --- |
| Durable rules (behavior, architecture, conventions) | The permanent docs tree, same PR |
| Design rationale, scope decisions, rejected alternatives | The PR description |
| Designs for deferred (not yet implemented) work | Dated entries in the project log (e.g. `docs/project/`) |
| Task lists, sequencing | Ephemeral: session scratchpad, PR body |

The project log is **not canonical**: its entries are dated records of
decisions and future intentions, never a description of the present. Cite
canonical docs for how the system behaves; cite the project log only for why
something is deferred or was decided.

Because a plain `grep` cannot tell authority levels apart, the boundary is
made machine-readable on both sides. Every project-log entry starts with
frontmatter declaring itself non-canonical:

```yaml
---
authority: non-canonical
status: deferred
---
```

And the agent instructions `stdd init` generates carry a retrieval rule: do
not search the project log unless the user explicitly asks for historical
rationale or deferred work.

`stdd check` enforces the artifact ban in CI; `stdd check-pr` enforces the
PR evidence line; `stdd doctor` reports a repository's overall adoption
health (setup, canonical docs, misleading artifacts, generated-file drift). The rest of the method is review discipline — anything
that later proves mechanically checkable should move into `stdd check`.

A repository may declare a worktree-readiness contract in
`.stdd/config.json` — paths that must exist before verification output can
be trusted (installed dependencies, built packages, per-checkout env
files), each with a repo-authored fix hint. `stdd doctor` reports missing
ones; `stdd doctor --readiness` runs only that section, cheap enough for
every session start. The check is purely declarative — stdd verifies and
prescribes, it never installs, and it does not detect a stale-but-present
artifact (freshness belongs to the repo's own build tooling).

On GitHub, `stdd init --ci github` writes the canonical workflow for these
gates. It fetches the PR body live from the API and re-runs on body edits —
a workflow reading `github.event.pull_request.body` validates a payload
frozen at trigger time, so an edited body is never re-checked and a re-run
replays the stale text. The fetch uses node, not the gh CLI — node is
already required to run stdd, while self-hosted runners often lack gh —
and the step sets `pipefail`, so a failed fetch fails the gate as a fetch
error instead of feeding check-pr an empty body that misreports as a
missing evidence line. `stdd doctor` flags the frozen-payload form, and flags a PR
template carrying an unquoted evidence label at the start of a line, since
its placeholder residue would pass the gate on every PR.

Locally, `stdd init --hooks` writes a pre-push hook that runs exactly one
fast, offline command: `stdd check`. Nothing network-bound belongs in a
hook — a flaky gate's false positives train `--no-verify`. The hook file
is user-owned after generation (like `config.json`, it is not
manifest-tracked and never overwritten), so teams append their own steps.
stdd never touches `.git/`: install it via
`git config core.hooksPath .stdd/hooks`, or call `stdd check` from an
existing hook manager. `stdd doctor` reports whether the hook is wired
up — informationally, never as a failure.

## The session ledger and `stdd status`

The loop's state must not live only in the agent's context window — context
is not durable storage. **Compaction is a trust boundary**: anything that
must survive a session lives in a file, never in conversation memory.

The ledger is that file: `.stdd/ledger.jsonl`, append-only JSONL, one event
per line. It is a working artifact — per checkout, never committed
(`stdd init` adds the ignore rule). One worktree = one task = one ledger;
every event carries `ts`, `branch`, and event-specific fields, and readers
consider only the current branch's events.

Recorders anchor to the repository, never the shell's working directory.
Run from any subdirectory, `stdd docs`/`red`/`verify`/`note` — and the
ledger reads inside `status`, `slice`, `scope`, `evidence`, and
`check-pr` — resolve one root: the git toplevel when it holds `.stdd/`
(or when no `.stdd/` exists yet), otherwise the nearest ancestor holding
`.stdd/`. The root `.stdd/config.json` resolves the same way, so a
`redPattern` applies from anywhere in the tree, and an accidental nested
`apps/*/.stdd/` cannot appear. The explicit directory argument of
`init`, `check`, and `doctor` is unchanged.

Recorders write it at the moment the fact happens:

- `stdd docs <updated-first|checked|not-applicable> [paths…] [--reason <why>]`
  records the docs decision and its reason once, when it is made.
- `stdd red -- <cmd>` and `stdd verify -- <cmd>` run the command, record
  `{cmd, exit, excerpt}` verbatim, and pass the exit code through. `red`
  asserts genuine-red (a test-framework failure, not an environment error)
  only when `.stdd/config.json` defines a `redPattern` regex matched against
  the output; otherwise it records `genuine: "unknown"` and warns. A red run
  that exits zero is recorded as not genuine — that is green, not red.
- `stdd note <text>` records free-form handoff context.

The ledger is **advisory input, never a gate by itself**. `stdd check` and
`check-pr` pass or fail exactly as without it; a missing ledger changes
nothing. Derivation replaces reconstruction where a ledger exists:
`stdd evidence` reads the recorded docs decision first — the diff remains
the cross-check, and on contradiction the diff wins and the conflict is
reported; the authored reason for `checked`/`not-applicable` comes from the
ledger instead of being retyped at PR time. `check-pr` adds one advisory
line when the body's evidence label disagrees with the recorded decision.

`stdd status` is the next-step oracle: callable at any moment, it answers
where in the loop this checkout is and what the next step is. Inputs in
order of trust: git (diff against the configured `baseRef`, branch, dirty
state), then the ledger, then the forge when available (`gh` reports the
branch's PR and its check rollup; offline or without `gh` these lines read
"unknown", never an error). Output is one screen ordered as the loop, with
a concrete `next:` suggestion; `--json` emits the same for agents. Timing
leaves the prose: run `stdd status` at session start and before opening a
PR.

## Delegating a slice

When an orchestrating session hands a slice of the work to a worker
session, the roles are fixed: the **orchestrator** owns the docs edit, the
commits, and the PR; the **worker** owns red-green inside a declared scope.
The handoff artifact is the ledger, not prose — a worker's chat summary
does not survive compaction, its recorded events do.

The scope is declared before the worker starts: `stdd slice new` with
`--frozen` (globs the slice must not touch) and/or `--allowed` (globs the
slice may touch — anything outside is a violation) writes a `scope` event
carrying the globs and a **baseline** of the checkout at slice start (the
current head plus content hashes of dirty files). The brief itself follows
the delegate-slice playbook; the worker records `docs`/`red`/`verify`
events as it goes, and the orchestrator assembles the PR body from the
ledger.

`stdd scope` is the postflight check, against the baseline rather than a
ref: only **session-introduced** changes count — a change to a frozen
path, or outside the allowed paths, fails. Dirt inherited from before the
slice (a file already modified at baseline, byte-identical now) is
reported separately and never blamed on the slice.

## Bug fixes and refactors

- **Bug fix:** reproduce the symptom in a test before editing. Fix the root
  cause, not the symptom.
- **Refactor:** prove behavior preservation with existing tests, typecheck,
  or focused characterization tests. No docs edit needed when behavior and
  contracts are unchanged.

## Style for docs

Concise. Short, direct sentences. Do not omit words that carry meaning. One
rule lives in one document — link, don't duplicate. Canonical docs are
written in English and describe the **present**: temporal narrative
("previously", "no longer") belongs in git history and PR descriptions —
`stdd check` flags it.

## What stdd does not cover

stdd is a process contract, not an engineering standard. Architecture rules,
dependency-injection styles, error-handling policy, tenant/auth/data safety,
and database-migration policy stay in the adopting team's own contract
(typically `AGENTS.md`) and docs tree. stdd tells you *where* such rules
live and *when* they must be written — not what they should say.
