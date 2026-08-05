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
3. **Edit the docs — that edit is the spec.** Once the intended behavior is
   agreed, update missing, stale, or ambiguous docs before tests and
   production code. Make the docs edit the first reviewable unit — the first
   commit where commits are used, otherwise the opening docs-only diff of the
   PR — so the behavior contract can be reviewed on its own. A throwaway
   exploratory spike may precede this commitment; discard it or explicitly
   reclassify the change before review. If the docs already cover the
   behavior, do not add duplicate prose — record that they were checked (see
   PR evidence). Not every implementation detail deserves canonical prose.
4. **Write the failing test.** Red before green. Exception below.
5. **Implement** until the test passes, then refactor.
6. **Verify with the narrowest meaningful command.** Never claim "done",
   "fixed", or "clean" without fresh verification evidence. Narrowest
   meaningful governs the inner loop; once a PR exists, verification is
   complete only when its required checks settle terminal-green on the
   current head commit. `stdd ci --watch` is that wait, done right: it
   pins the watch to the PR's current head, refuses to settle until the
   check set is stable and fully terminal (a watcher attached right after
   a push sees a partial set — the classic early-settle trap), restarts
   itself when the head moves, and exits nonzero on a terminal failure.
   Duplicate rollup entries for the same check name (re-runs, cancelled
   concurrency twins) collapse to the freshest run, so a superseded
   cancel never reads as a red. Never hand-roll the poller.
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

## Working artifacts are non-canonical by default

Plans, spec files, todo lists, handoff notes, and execution logs are working
artifacts. They help execution but can go stale as soon as the task or
checkout moves. When committed without an authority marker, they can outrank
fresher docs in code search and become a second source of truth.

The default STDD policy therefore keeps them uncommitted. This is a strong
default, not a universal ban: a team that needs an auditable design trail may
retain selected records when each record declares
`authority: non-canonical`, canonical retrieval rules exclude it by default,
and current behavior still has exactly one home in the permanent docs tree.
A repository that requires a strictly current-state-only tree sets
`projectLog.enabled` to `false`; `stdd check` then rejects tracked
`docs/project/**` files, and its generated method preamble and agent routing
override the generic project-log option below. Narrow `forbiddenArtifacts`
deliberately for any additional repository-specific archive paths and enforce
the chosen boundary with `contentRules`; never weaken it accidentally.

Where their content belongs instead:

| Content | Home |
| --- | --- |
| Durable rules (behavior, architecture, conventions) | The permanent docs tree, same PR |
| Design rationale, scope decisions, rejected alternatives | The PR description |
| Designs for deferred (not yet implemented) work | Dated project-log entries only when `projectLog.enabled` is `true`; otherwise outside the tracked tree |
| Task lists, sequencing | The durable plan (`.stdd/plan.md`, per checkout — see below), PR body |

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

When `projectLog.enabled` is `true`, the agent instructions `stdd init`
generates carry a retrieval rule: do not search the project log unless the
user explicitly asks for historical rationale or deferred work. When it is
`false`, generated instructions instead forbid creating or searching a project
log and direct history and rationale to git and PRs. The installed
`.stdd/method.md` begins with the same repository-policy override, so generic
method text cannot silently outrank the adopting repository's stricter rule.

`stdd check` enforces the configured artifact policy in CI; `stdd check-pr`
enforces the PR evidence line; `stdd doctor` reports a repository's overall adoption
health (setup, canonical docs, misleading artifacts, generated-file drift).
The rest of the method is review discipline — anything that later proves mechanically
checkable should move into `stdd check`.

A repository may declare a worktree-readiness contract in
`.stdd/config.json` — paths that must exist before verification output can
be trusted (installed dependencies, built packages, per-checkout env
files), each with a repo-authored fix hint. `stdd doctor` reports missing
ones; `stdd doctor --readiness` runs only that section, cheap enough for
every session start. The check is purely declarative — stdd verifies and
prescribes, it never installs, and it does not detect a stale-but-present
artifact (freshness belongs to the repo's own build tooling).

A repository may also declare **content rules** in `.stdd/config.json` —
mechanically checkable conventions that would otherwise live in folklore.
Each `contentRules` entry names the rule, a `files` glob, a `forbid`
and/or `require` regex, an optional repo-authored `message`, and
`newFilesOnly: true` to grade only files added against `baseRef`
(without a resolvable base, all matches are graded). `stdd check`
reports hits as violations; `stdd doctor` reports the section's health.
The kit ships the mechanism — the adopting repo authors the rule.

With a `branchPattern` regex in the same config, `stdd check` run on a
branch also validates the branch name — the pre-push hook thus rejects a
doomed name before the forge does. A detached checkout (CI) skips the
rule, and the pattern must match every branch a human pushes, including
long-lived ones (`^(main|dev|feat/|fix/)…`).

A repository also declares a **capability profile** in the same config —
a `capabilities` object stating what the agent environment can actually
do: `subagents` (fresh subagent sessions can be dispatched), `crossCli`
(selected agent CLIs may invoke a second reviewer CLI), `worktrees` (isolated
git worktrees are available). Defaults: `subagents` and `worktrees` on,
`crossCli` off. Playbooks are compiled against the profile at `stdd init`
time, never branched at runtime: a `<!-- cap:NAME --> … <!-- /cap -->`
block survives compilation only when its capability is on (a block
naming alternatives, `cap:a|b`, survives when any of them is on), and a
playbook whose frontmatter declares `requires: NAME` is skipped entirely
when it is off. Edit the profile and re-run `stdd init` — the generated skills
and the AGENTS snippet match the project again, and generated files a
previous init wrote that fall outside the new profile are removed
(only when still byte-identical to what init wrote). `stdd init
--capabilities <list>`, `stdd init --interview`, and `stdd configure` set the
profile without hand-editing JSON — see
`method/reference-integration.md`.

Agent adapters have two outputs with deliberately different context costs:

- a short, always-on instruction block carrying only repository invariants;
- native, lazily loaded skills carrying the task workflows.

Three routing skills make the main path explicit instead of asking an agent
to infer a workflow from a flat list: `stdd-start-change` classifies first,
opens a task only for repository-changing work, and routes read-only questions
without writing state; `stdd-implement` runs the docs/red/green/verify loop, and
`stdd-finish-change` closes review, evidence, PR checks, and any requested
runtime verification. Specialized playbooks remain independently invocable.

## The session ledger and `stdd status`

The loop's state must not live only in the agent's context window — context
is not durable storage. **Compaction is a trust boundary**: anything that
must survive a session lives in a file, never in conversation memory.

The ledger is that file: `.stdd/ledger.jsonl`, append-only JSONL, one event
per line. It is a working artifact — per checkout, never committed
(`stdd init` adds the ignore rule). A branch is not a task identity: base
branches and long-lived feature branches are reused. `stdd task start
<name>` therefore opens a random task ID and records the existing plan hash
as its baseline; subsequent events carry `taskId`. `stdd task finish`
closes the active task without deleting its evidence, and `stdd task reset`
closes it as abandoned and opens a fresh ID. Starting while another task is
active is an error; finish/reset are explicit so a new session cannot
silently discard another session's work. A crash never leaves the ledger in a
half-written state — see
`method/reference-generated-state.md`.

`stdd status --json` has one stable top-level shape in every lifecycle
state: `state`, `task`, `branch`, `loop`, `slice`, `plan`, `review`, `pr`,
and `next` are always present. Idle state uses explicit empty/null values,
so integrations never need a second response schema.

Readers consider only the current branch's active task. A plan that was
already present when the task started stays invisible until rewritten for
the new task. A closed task makes `stdd status` report `idle`, not the last
task's unfinished state. Branch-only events written by older stdd versions
remain readable as legacy state on a changed working branch, but are ignored
on a clean base branch so old work cannot be injected into a new session.
Recorders invoked without an explicit start keep the legacy behavior for
backward compatibility and tell the user to run `stdd task start`.

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
  `{cmd, exit, excerpt, snapshot}` verbatim, and pass the exit code through.
  The snapshot binds the fact to the checkout state that produced it. What
  follows `--` is the command and its arguments, never prose: a single
  quoted description is rejected with the corrected form (wrap shell
  constructs in `sh -c`) and records nothing. `red`
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
a concrete `next:` suggestion; `--json` emits the same for agents.
`--local` omits the forge lookup unconditionally and is the only form
generated lifecycle hooks call. A red
event that exited zero or was classified `genuine: "no"` never closes red.
The latest docs decision is cross-checked too: `updated-first` must still
name docs in the current diff, while `checked` and `not-applicable` are
contradicted by a canonical-doc change; missing checked paths also stale the
decision.
Implementation is observed only when the checkout changes after the red
snapshot. A passing verify becomes stale after any later checkout change;
`status` asks for a fresh verify instead of displaying historical green as
current proof. Older ledger events without snapshots remain readable but
are explicitly reported as legacy evidence. Timing
leaves the prose: run `stdd status` at session start and before opening a
PR. Once the loop is verified and the plan is exhausted, the closing
review is the named next step ahead of the evidence line — when the
capability profile has a dispatch route on (`subagents` or `crossCli`),
`status` says to dispatch the fresh reviewer explicitly; with both off
the suggestion is omitted rather than degraded to self-review.

## The durable plan and `stdd defer`

A multi-step change needs a plan that survives compaction. Its working copy
is `.stdd/plan.md`: markdown with a checkbox list (`- [ ]` / `- [x]`), one
item per verifiable step, free prose around it. Like the ledger it is a
per-checkout working artifact — `stdd init` adds the ignore rule, and
`stdd check` fails when the plan or the ledger is a tracked file,
regardless of config.

An optional `Mode: inline|delegated` line (the first such line outside
code fences, case-insensitive; any other value reads as absent) records
the execution choice made at planning time, so it survives compaction
with the plan.

`stdd status` reads the plan and reports progress ("4/7 done") plus the
first open item, and the declared mode when the line is present (in
`--json`: `plan.mode`, null when absent). The mode is informational —
it never affects the gate or the stop hook. Once the current pass through the loop is verified and
open items remain, continuing the plan is the named next step — ahead of
drafting the evidence line and opening the PR.

A checkbox is a claim; for test-gated steps the ledger is the proof. An
item carrying a `[red: <substring>]` tag closes only when the current
branch's ledger holds a red event whose recorded command contains the
substring — a run recorded `genuine: "no"` (a green exit or an environment
error) never closes it. Until then the item counts as open even when
checked, and `stdd status` flags it as unproven.

A multi-step plan ends with an **independent review** of the cumulative
diff as its last item when the capability profile has a dispatch route
(`subagents` or `crossCli`). The item is written in at planning time so
the trigger travels with the plan rather than the session's memory. The
review is not a property of delegation — it closes inline work and
delegated work alike, and its reviewer is a fresh context (a read-only
subagent or the other CLI, per the capability profile) that sees the plan
and the diff, never the implementing session's history. With both dispatch
capabilities off, capability compilation omits the review item and closing
review guidance entirely; it never substitutes self-review.

The review item carries a `[review:]` tag, and the tag follows the same
claim-vs-proof rule as `[red:]`: the checkbox is a claim, the ledger is
the proof. Both tags are read from prose only — a backticked
`` `[review:]` `` names the tag as a literal and never gates the item. A tagged item closes only when the branch's newest `review`
event carries an `approved` verdict — recorded by `stdd review`, never
by ticking the box. Approval closes the item directly from the ledger without
rewriting the plan; its checkbox remains user-authored and may stay unchecked.
Until approval the item counts as open, and a checked item is flagged as
unproven.

`stdd defer <text>` records a scope cut for the active task: the text is
appended under the plan's `## Deferred` section, created as needed. It rejects
idle, legacy, and malformed task state before touching the plan, captures the
task and branch before reading it, and rechecks both before publishing, so a
concurrent task or branch switch records the cut nowhere. Appending to a plan
that predates `task start` changes its baseline hash and makes the plan,
including the deferred cut, visible to the active task. Deferred entries never
count toward progress; carry them into the PR description's out-of-scope when
the PR is assembled. The plan stays deletable at any moment — durable rules
flow to the docs edit, rationale and scope decisions to the PR description
(see "Working artifacts are non-canonical by default").

## Project policy and `stdd policy`

A repository accumulates standing decisions no kit rule can carry: which
migrations are pre-approved on which branch, which agent owns which area, what
a session should stop asking about. Their home is `.stdd/policy.md` — owned by
the repository, created by `stdd init` when absent, never overwritten
afterwards. Unlike the plan and the ledger it is tracked: a granted authority
must be visible in a diff and reviewable like any other rule.

The file holds two kinds of entries, and they differ in what they grant. A
**note** is free text under `## Notes`, appended by `stdd policy add <text>`.
It records project nuance and grants nothing — free text that reads like a
permission is still only a note. A **permission** is a structured line under
`## Permissions` naming one action and one condition, appended by
`stdd policy allow <action> --when <condition>`. Only permissions carry
authority.

A permission's action comes from a closed set: `merge`, `deploy`, `publish`,
`migrate`, `force-push`, and `external-mutation`. Any other action is rejected,
which is also why policy cannot waive a method gate — the docs edit, a genuine
red, verification, the closing review, and `stdd check` are not actions the
file can name. Policy widens what an agent may do without asking; it never
narrows what the loop must prove.

The set is enforced when the document is read, not only when `stdd policy`
writes it. The file is tracked and hand-editable, so an entry naming an
unknown action is reported as rejected and grants nothing; resting the closed
set on the CLI having been used would leave the guarantee to etiquette. Each
`stdd policy` append republishes the whole document bound to the identity and
bytes it read, so a concurrent edit fails the write instead of overwriting it.

The reader holds the writer's other rules too. An entry is one printable line:
a permission carrying control, bidirectional, or zero-width characters is not
honored, and neither is a bullet with no `— when:` clause. Those are dropped
rather than reported, because repeating unreadable bytes back into a
diagnostic is the thing the rule prevents; only a legible entry naming an
unknown action is echoed as rejected.

A section holds nothing but its own bullets. Any line that is neither blank
nor a well-formed bullet ends it — a heading, a fence, a rule, a paragraph.
Enumerating the constructs that close a section would be a losing game against
a hand-edited file, so a permission-shaped line anywhere else in the document
carries no authority by construction.

None of that binds a session that reads the markdown itself, so policy is
consulted through `stdd policy show`. That view is where the rules are applied:
it lists the grants the kit honors, the advisory notes, and any entry it
ignored with the reason. A guarantee enforced only in a library nobody calls is
not a guarantee, and the raw file is a record, not an authority.

Every permission carries a condition, and the condition is the point. Before
acting, the session verifies it mechanically and states what it verified: a
branch, an environment, a recorded review verdict, a terminal-green check set.
A condition the session cannot verify is not authorization — it asks, exactly
as it would with no policy at all.

Precedence runs live instruction, then policy, then kit default. A word in the
current session outranks the file; the file outranks what the playbooks would
otherwise ask. `stdd policy` writes only from the owning checkout and refuses
inside a managed gitless worker sandbox, so an agent cannot grant itself
authority. Playbooks consult the file before asking a question it may already
answer, and the always-on router names it so a session finds it without loading
a skill.

## The closing review and `stdd review`

`stdd review` runs the closing review and records its verdict as ledger
evidence. The route comes from the capability profile and the `review`
config (`{"review": {"via": "codex"}}`, default `subagent`); `--via`
overrides per call. `--via codex` and `--via claude` require the `crossCli`
capability, `--via subagent` requires `subagents` — an unavailable route is an
error, never a silent fall-back to self-review.

Every run starts the same way: the command snapshots the work under
review — a hash over the content of every path that differs from
`baseRef`, tracked or untracked and whether or not it is committed, plus
the plan's text. The snapshot follows content, never Git's bookkeeping:
staging or committing the reviewed work moves no bytes on disk, so it
cannot stale a verdict about those bytes. Editing them does.
The plan's checkbox marks and its `## Deferred` section are normalized
away — a ticked box is progress and a deferred entry is a recorded scope
cut, and neither is the specification the verdict was a comparison
against, so a session may close an item or defer a late finding without
discarding the approval. Editing the plan's words still stales it.
The session ledger,
the plan file, and only the exact private internal transaction names
described in
`method/reference-generated-state.md` are
exempt. Recording events
must never invalidate a review.
Every other tracked `.stdd/` deliverable (config, generated kit) stays
under review like any other file. An unresolvable base ref aborts the run —
a review of an unavailable diff proves nothing. The command then builds a
**brief** — the plan, the diff and a complete changed-file manifest, the
untracked files the diff cannot show, and the governing canonical docs the
reviewer reads for itself — plus
the review rubric: spec compliance against the
plan first, then code quality graded against named dimensions: needless
duplication where one home for the logic exists, magic numbers and
strings that deserve named constants, loose type contracts at
boundaries, swallowed or blanket-caught errors, tests that assert mocks
instead of behavior, unrequested extras (a finding, not a bonus),
inconsistency with surrounding patterns, and readability: working code
that is badly written is a legitimate blocking finding, not a style
nit — and a strict output contract: a single JSON object with required
`summary` and `findings` fields, each finding carrying
`severity: blocking | advisory`. Any wrong field type or output shape
rejects the whole result; the field-level rules are in
`method/reference-commands.md`, along with how the
brief is stored and settled and what each dispatch route does.

Repository text inside the brief is untrusted review data, never reviewer
instructions. The brief states this boundary explicitly; instructions found
inside plans, diffs, filenames, or source contents cannot replace the review
contract.

An automated reviewer is evidence, not a security boundary or a substitute
for accountable human review. Read-only tool enforcement limits mutation; it
does not make model judgment infallible or eliminate prompt-injection risk.
Teams choose which changes still require human approval.

The verdict is **derived, never self-declared**: no blocking findings
means `approved`, any blocking finding means `changes-requested`, and a
runner failure, timeout, malformed output, or stale snapshot means
`error` — an `error` is never an approval. The `review` event records
the verdict, the findings, the snapshot, and the runner's exit; exit
codes mirror the verdict (0 approved, 1 changes-requested, 2 error).
On `approved`, that one ledger fact closes the `[review:]` item; no
second plan write can leave the verdict and its projection split across a
crash or write failure. After `changes-requested`: fix the findings and run
`stdd review` again; the newest verdict controls the tag.

A repository may declare a **review budget**:
`{"review": {"maxRounds": 3}}`. Once the branch's ledger holds that
many `changes-requested` verdicts, `stdd review` refuses another
dispatch and says to defer the remaining findings; `--force --reason <text>`
spends one more round deliberately, and `error` verdicts (timeouts, malformed
output) never burn budget. The budget ends the **loop**, never the
judgment: the gate still refuses to bless an unproven claim, so the
honest exit past a spent budget is an unchecked review item plus the
open findings deferred into the PR. The default is unlimited; the knob
exists because unbounded re-review does not converge on a large diff —
a fresh reviewer finds one more, ever-smaller truth every round.

Overriding that budget is a decision, so it is recorded like one:
`--force` requires `--reason <text>` and refuses without it, `--reason`
is meaningless without `--force` and is refused there too, and the text
is stored on the `review-request` event as `forced`. A limit that can be
waived silently is not a limit — it is a suggestion nobody has to
account for. The recorded reasons are what later shows whether the loop
kept converging or turned into a treadmill, so they belong in the branch's
ledger next to the round they bought.

A stale approval (the snapshot differs from the current checkout)
reopens the review everywhere, not just in the gate: `stdd status`
counts the tagged item unproven again and names `stdd review` as the
next step — an approval of a diff nobody can see anymore proves
nothing about the diff that exists now. So an approved verdict freezes
the checkout: anything found afterwards is either deferred with
`stdd defer` or costs a fresh round. Editing on top of an approval does
not preserve it, it discards it.

`stdd status --gate` folds the review state into an exit code for hooks
and scripts. It exits non-zero when a `[review:]` item is checked but
unproven, when the newest review verdict is `changes-requested` or
`error`, when an `approved` verdict is stale, or when a review claim or
open request needs a route that the capability profile cannot dispatch.
A configured route is otherwise dormant: a profile with neither
`subagents` nor `crossCli` may keep the default route and passes the gate
when it makes no review claim. An unchecked review item on its own never
fails the gate — work in progress remains pushable; the gate judges
claims, not pace.

## Delegating a slice

When an orchestrating session hands a slice of the work to a worker
session, the roles are fixed: the **orchestrator** owns the docs edit, the
commits, and the PR; the **worker** owns red-green inside a declared scope.
The handoff artifact is the ledger, not prose — a worker's chat summary
does not survive compaction, its recorded events do.

The scope is declared before the worker starts, never after: `stdd slice new`
for an in-checkout worker, `stdd worker create <directory>` for one that must
have no Git authority. Both take `--frozen` (globs the slice must not touch)
and `--allowed` (globs it may touch), and at least one is required — an
undeclared slice cannot be graded.

Both forms record a `scope` event carrying globs and a **baseline**, and
`stdd scope` grades the result against that baseline. The worker records
red/verify/note events as it goes, and the orchestrator assembles the PR body
from the parent ledger. What a managed sandbox
copies, what `stdd worker collect` refuses, and how the postflight reads are in
`method/reference-commands.md`.

The worker asks its blocking questions before the first edit — not
mid-slice — and ends with exactly one status: `DONE`,
`DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT`. Escalating early is
never penalized: bad work is worse than no work. Briefs and reports
travel as files, never pasted prose — pasted context stays resident in
the orchestrator's window for the rest of the session.

The brief, the orchestrator's two review verdicts, and the handling of a
`BLOCKED` slice live in the delegate-slice playbook — the document a session
doing this work has already loaded. One rule lives in one document.

## Bug fixes and refactors

- **Bug fix:** reproduce the symptom in a test before editing. Fix the root
  cause, not the symptom.
- **Refactor:** prove behavior preservation with existing tests, typecheck,
  or focused characterization tests. No docs edit needed when behavior and
  contracts are unchanged.

## Style for docs

Concise. Short, direct sentences. Do not omit words that carry meaning. One
rule lives in one document — link, don't duplicate. Canonical docs use the
repository's declared language and describe the **present**. Configure
`temporalPhrases` in that language to flag likely historical narrative; this
is a deliberately simple heuristic, not semantic proof. History usually
belongs in git and PR descriptions. Fenced code blocks and inline code spans
are exempt: a backticked phrase is a literal being named, not narrative — a
doc may state this very rule without tripping it.

## Reference

This document is what a session reads before a change, so it holds the
contract and nothing else. The mechanisms behind it are canonical too, and
live beside it:

- `method/reference-generated-state.md` — how
  generated files are authenticated, retired, and recovered: manifest hashes,
  the cleanup journal, the bundled `stdd-fs` helper, the printable-text
  boundary, and ledger transaction state.
- `method/reference-integration.md` — what `stdd
  init` and `stdd configure` write: capability profiles, per-host agent
  outputs, adoption modes and the universal bundle, project-local recipes, CI
  adapters, and lifecycle hooks.
- `method/reference-commands.md` — the internals of
  `stdd review` and the worker commands: the review result contract, brief
  storage and settlement, dispatch routes, managed sandboxes, and the scope
  postflight.

## What stdd does not cover

stdd is a process contract, not an engineering standard. Architecture rules,
dependency-injection styles, error-handling policy, tenant/auth/data safety,
and database-migration policy stay in the adopting team's own contract
(typically `AGENTS.md`) and docs tree. stdd tells you *where* such rules
live and *when* they must be written — not what they should say.
