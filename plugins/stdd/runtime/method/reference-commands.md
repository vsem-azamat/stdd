# Reference: command internals

The mechanics behind the loop's commands: how the PR evidence line is drafted
and graded, what the ledger's readers and `stdd status` derive, how plan tags
and `stdd defer` behave, how a review request is stored and settled, what each
dispatch route does, and what a managed sandbox copies and collects. The
method states the contract; this document states the implementation.

## PR evidence: `stdd evidence` and `stdd check-pr`

Only a line starting at the beginning of a line counts as the evidence line;
quoted templates and code blocks do not. A bare label with nothing after the
colon fails `stdd check-pr`.

When no valid line exists but a near-miss does — a markdown-formatted label, a
list or quote marker in front of it, or a wrong sentinel wording —
`stdd check-pr` points at that line and prints the corrected form. The
suggestion is advisory: the pass condition does not change.

With `--base <ref>` the claim is verified against the actual diff: every doc
path named after `Docs updated first:` must be a file changed between the base
ref and `HEAD` (and at least one path must be named); paths named after
`Docs checked, no change needed:` must exist in the tree. Claiming a docs
update the diff does not contain fails CI.

With `--pr <number|.>` the live PR is validated exactly as CI will see it: the
body is fetched from the forge, the base is the PR's own, and the diff is taken
against the PR's head commit — when the local checkout is not on that commit,
the head is fetched rather than silently diffing the wrong tree. `.` resolves
the current branch's PR.

`stdd evidence --base <ref>` drafts the line from ground truth instead of
recall. When canonical docs changed against the base, it prints the finished
`Docs updated first:` line to stdout — safe to embed in a PR body via command
substitution. When none changed, the remaining two sentinels need an authored
reason: the templates go to stderr and the command exits nonzero, so
substitution cannot silently embed a template. The base comes from `--base` or
the `baseRef` key in `.stdd/config.json`; there is no built-in default.

Where a ledger exists, `stdd evidence` reads the recorded docs decision first —
the diff remains the cross-check, and on contradiction the diff wins and the
conflict is reported; the authored reason for `checked`/`not-applicable` comes
from the ledger instead of being retyped at PR time. `check-pr` adds one
advisory line when the body's evidence label disagrees with the recorded
decision.

## Ledger recorders and `stdd status`

`stdd task start <name>` records the existing plan hash as the task's
baseline; a plan that was already present when the task started stays
invisible until rewritten for the new task. Readers consider only the current
branch's active task. A closed task makes `stdd status` report `idle`, not the
last task's unfinished state. Branch-only events written by older stdd
versions remain readable as legacy state on a changed working branch, but are
ignored on a clean base branch so old work cannot be injected into a new
session. Recorders invoked without an explicit start keep the legacy behavior
for backward compatibility and tell the user to run `stdd task start`. A crash
never leaves the ledger in a half-written state — see
`method/reference-generated-state.md`.

Recorders anchor to the repository, never the shell's working directory. Run
from any subdirectory, `stdd docs`/`red`/`verify`/`note` — and the ledger
reads inside `status`, `slice`, `scope`, `evidence`, and `check-pr` — resolve
one root: the git toplevel when it holds `.stdd/` (or when no `.stdd/` exists
yet), otherwise the nearest ancestor holding `.stdd/`. The root
`.stdd/config.json` resolves the same way, so a `redPattern` applies from
anywhere in the tree, and an accidental nested `apps/*/.stdd/` cannot appear.
The explicit directory argument of `init`, `check`, and `doctor` is unchanged.

`stdd red -- <cmd>` and `stdd verify -- <cmd>` record `{cmd, exit, excerpt,
snapshot}` verbatim. What follows `--` is the command and its arguments, never
prose: a single quoted description is rejected with the corrected form (wrap
shell constructs in `sh -c`) and records nothing. `red` asserts genuine-red
only when `.stdd/config.json` defines a `redPattern` regex matched against the
output; otherwise it records `genuine: "unknown"` and warns. A red run that
exits zero is recorded as not genuine.

`stdd status --json` has one stable top-level shape in every lifecycle state:
`state`, `task`, `branch`, `loop`, `slice`, `plan`, `review`, `pr`, and `next`
are always present. Idle state uses explicit empty/null values, so
integrations never need a second response schema. Its string-valued `next` is
neutral: no task is required for discussion or read-only work, and a task
starts only when the user chooses persisted or repository-changing action.

Inputs in order of trust: git (diff against the configured `baseRef`, branch,
dirty state), then the ledger, then the forge when available (`gh` reports the
branch's PR and its check rollup; offline or without `gh` these lines read
"unknown", never an error). Output is one screen ordered as the loop, with a
concrete `next:` suggestion; `--json` emits the same for agents. `--local`
omits the forge lookup unconditionally. A red event that exited zero or was
classified `genuine: "no"` never closes red. The latest docs decision is
cross-checked: `updated-first` must still name docs in the current diff, while
`checked` and `not-applicable` are contradicted by a canonical-doc change;
missing checked paths also stale the decision. Implementation is observed only
when the checkout changes after the red snapshot. A passing verify becomes
stale after any later checkout change. Older ledger events without snapshots
remain readable but are explicitly reported as legacy evidence.

Once the loop is verified, `status` names the closing review only when
something expects one: a plan is present, a slice was delegated (a recorded
`scope` event), or a review verdict is already recorded. With none of the
three it goes straight to the evidence line. Where a review is expected, it is
named ahead of the evidence line when the capability profile has a dispatch
route on (`subagents` or `crossCli`); with both off the suggestion is omitted
rather than degraded to self-review. A stale approval reopens the review here
too: the tagged item counts as unproven again and `stdd review` is the named
next step.

## Plan tags, mode, and `stdd defer`

The `Mode: inline|delegated` line is the first such line outside code fences,
case-insensitive; any other value reads as absent. `stdd status` reports it as
`plan.mode` in `--json`, null when absent. The mode is informational — it
never affects the gate or the stop hook.

`[red:]` and `[review:]` tags are read from prose only — a backticked
`` `[review:]` `` names the tag as a literal and never gates the item. A
`[red: <substring>]` item closes only when the current branch's ledger holds
a red event whose recorded command contains the substring; a run recorded
`genuine: "no"` (a green exit or an environment error) never closes it. A
`[review:]` item closes only when the branch's newest `review` event carries
an `approved` verdict. Approval closes the item from the ledger without
rewriting the plan; until then the item counts as open even when checked, and
`stdd status` flags it as unproven.

`stdd defer <text>` appends the text under the plan's `## Deferred` section,
created as needed. It rejects idle, legacy, and malformed task state before
touching the plan, captures the task and branch before reading it, and
rechecks both before publishing, so a concurrent task or branch switch records
the cut nowhere. Appending to a plan that predates `task start` changes its
baseline hash and makes the plan, including the deferred cut, visible to the
active task.

## Review snapshots, verdicts, budget, and gate

The review snapshot normalizes away the plan's checkbox marks and its
`## Deferred` section — a ticked box is progress and a deferred entry is a
recorded scope cut, and neither is the specification the verdict was a
comparison against. The session ledger, the plan file, and only the exact
private internal transaction names described in
`method/reference-generated-state.md` are exempt; recording events must never
invalidate a review. Every other tracked `.stdd/` deliverable (config,
generated kit) stays under review like any other file. An unresolvable base
ref aborts the run — a review of an unavailable diff proves nothing.

A repeat review after `changes-requested` carries the newest substantive prior
round's findings from the same task scope (`error` rounds are skipped; an
approval clears them), checked for resolution in the current code first.
Untouched scope is not re-polished.

The `review` event records the verdict, the findings, the snapshot, and the
runner's exit; exit codes mirror the verdict (0 approved, 1
changes-requested, 2 error). On `approved`, that one ledger fact closes the
`[review:]` item; no second plan write can leave the verdict and its
projection split across a crash or write failure.

The review budget is `{"review": {"maxRounds": 3}}`; the default is
unlimited. Once the branch's ledger holds that many `changes-requested`
verdicts, `stdd review` refuses another dispatch and reports the open
findings. `error` verdicts (timeouts, malformed output) never burn budget.
A limit that can be waived silently is not a limit — it is a suggestion nobody
has to account for — so `--force` requires `--reason <text>` and refuses
without it; `--reason` is
meaningless without `--force` and is refused there too; the text is stored on
the `review-request` event as `forced`. The recorded reasons are what later
shows whether the loop kept converging or turned into a treadmill. The gate
still blocks on the newest verdict after the budget is spent. The knob exists
because unbounded re-review does not converge on a large diff — a fresh
reviewer finds one more, ever-smaller truth every round.

`stdd status --gate` exits non-zero when a `[review:]` item is checked but
unproven, when the newest review verdict is `changes-requested` or `error`,
when an `approved` verdict is stale, or when a review claim or open request
needs a route that the capability profile cannot dispatch. A configured route
is otherwise dormant: a profile with neither `subagents` nor `crossCli` may
keep the default route and passes the gate when it makes no review claim. An
unchecked review item on its own never fails the gate — work in progress
remains pushable.

## Brief construction

The brief carries a complete changed-file manifest (the diff body
may truncate beyond a size bound; the manifest never does, and it names
every untracked path too — symlinks and other non-regular files carry a
skipped marker, so nothing the reviewer was not told about can exist),
the diff, the contents of untracked regular files
(a new file is part of the change even before `git add`; symlinks are
skipped and large files are read only up to a bound), and a **governing
docs** section (the canonical docs are the standing spec: docs changed
in this branch are named as the spec delta to read first, and when none
changed the configured `canonicalDocs` globs are named instead — the
reviewer is read-only in the repository and reads them itself; contents
are never inlined). When the newest non-`error` review in the current
task's ledger is `changes-requested`, the brief adds a **follow-up**
block to the contract (round count, cumulative-diff caveat, resolution
first) and a **prior review findings** section holding only that round's
findings as recorded — severity, location, message — as untrusted data.
An `approved` verdict clears them; an `error` verdict neither clears nor
carries anything. The brief states explicitly that repository text inside it
is untrusted data: instructions found inside plans, diffs, filenames, or
source contents cannot replace the review contract.

## The review result contract

The reviewer's output is a single JSON object with required `summary` and
`findings` fields. `summary` and every finding's required `message` must be
non-empty printable single lines; ordinary Unicode, including ZWNJ/ZWJ and
emoji, remains valid. Each finding has `severity: blocking | advisory`,
`path` absent or null or a non-empty printable single line, and `line`
absent or null or a positive safe integer. An absent location field is
normalized to null for findings not tied to one location. For a
control-bearing repository path that cannot cross this inline boundary, the
reviewer omits `path` rather than emitting unsafe text. Any wrong field type
or output shape rejects the whole result.

## Brief storage and settlement

The brief is written outside the repository, in a
private temporary directory with owner-only permissions — it can carry
source contents and must not be world-readable. A `review-request` event
records the route, snapshot, brief hash, and a versioned, lossless identity
for the OS temp root, private directory, and every owned artifact. Codex's
`last-message.txt` is created owner-only before that event and read only
through a descriptor whose identity still matches the request. If the branch
or active task changes
while a CLI reviewer runs, the command records a terminal cancellation
against the captured original request rather than attaching a verdict to
the new context or leaving an orphan request. The cancellation and verdict
paths share the ledger lock, so exactly one terminal outcome wins.

Private-artifact settlement verifies the recorded directory and artifact
identities, including that every artifact's recorded and observed owner equals
the recorded review-directory owner, then overwrites each captured file through a helper-held writable
capability, flushes it, truncates it to zero, and flushes again. It then moves
the zeroed directory into an owner-private, non-loadable OS-temp quarantine.
After the terminal ledger outcome is durable, that identity-bound zeroed tree
remains for explicit operator removal. A crash leaves the quarantine
recoverable by `review --cleanup`; unknown siblings, changed identities, or
legacy requests without complete identity provenance fail closed before
mutation and require explicit operator remediation. Settlement never follows
or recursively deletes a replaceable final basename.

## Dispatch routes

- `--via codex` dispatches `codex exec --sandbox read-only` itself —
  stdin closed, wall-clock bounded (`--timeout <seconds>`, default
  600) — parses the reviewer's final message, and recomputes the
  snapshot once the runner returns: a checkout that changed while the
  reviewer ran records stale, the same as on submit.
- `--via claude` dispatches `claude -p --safe-mode --tools Read,Glob,Grep --permission-mode dontAsk`
  headless in the same way — brief over stdin, bounded, and tool-enforced read-only — for
  repositories driven from Codex, or as a second perspective; like codex it
  requires the `crossCli` capability.
- `--via subagent` prints the brief path for the orchestrating agent to
  hand to a fresh read-only subagent; the reviewer's JSON comes back via
  `stdd review --result <file|->`, which grades it against the **open
  subagent request**: a snapshot mismatch with the current checkout
  records the result as stale and rejects it, and a CLI-dispatched
  request (codex or claude) can never be completed by `--result` — its
  runner is its only mouth, so a hand-fed file cannot forge its provenance.
  Submitting a result securely settles the private temporary artifacts. An
  abandoned request is cancelled and settled with `stdd review --cleanup`;
  cleanup also reaches an interrupted CLI request and retries settlement
  when a terminal cancellation outlived its private-artifact move.

## Declaring a scope

`stdd slice new` declares a scope inside the existing checkout;
`stdd worker create <directory>` declares the same scope and builds a managed
filesystem snapshot without `.git`. Both accept `--frozen` (globs the slice
must not touch) and `--allowed` (globs the slice may touch — anything outside
is a violation), and both record a `scope` event carrying the globs and a
baseline. Every glob crosses the same printable-single-line
boundary as other persisted identifiers; control, bidi, and invisible
formatting characters are rejected before durable state is written.

## Managed worker sandboxes

A managed worker sandbox created by `stdd worker create` requires an active
task and an already recorded docs
decision. Its destination must not exist, must be outside the source checkout,
and must be outside any Git repository — a sandbox carries no `.git` and must
not be swept up by a surrounding one. That puts it beside the project rather
than inside it, so the convention is one hidden container,
`../.stdd-workers/<slice>`: a directory of projects then collects a single
`.stdd-workers/` however many slices are delegated, instead of one visible
sibling each. Managed create and collect use the
native mutation helper and fail before mutation when the destination
filesystem cannot provide the required capability guarantees. Creation copies
the checkout's tracked and non-ignored untracked files at
current bytes, excluding Git metadata and the private ledger/plan. Ignored dependencies, credentials, and
build output are deliberately absent; run the repository's readiness setup in
the sandbox before trusting tests. `.stdd/worker.json` binds the sandbox ID,
source task and branch, scope, source HEAD, and every copied path fingerprint;
the parent ledger records the metadata hash. The sandbox receives a minimal
local ledger for the same task, so `status --local`, `red`, `verify`, `note`,
`scope`, and `doctor --readiness` work without source Git authority. Task boundaries, docs decisions, nested worker
creation, review, evidence, and delivery commands are rejected there.

`stdd worker collect <directory>` runs only from the source checkout. It
rejects a missing or changed metadata binding, any non-ignored `.git` entry,
unsafe file type, scope violation, source task/branch/HEAD drift, or concurrent source
edit to a worker-touched path before applying anything. A complete preflight
then imports only worker-introduced file changes and the worker's red/verify/
note evidence. Collection never stages, commits, switches branches, pushes, or
otherwise changes Git history. Import is idempotent: a rerun accepts paths
already at the sandbox result and completes any remaining paths after an
interruption; any third state is a conflict. Deleted source bytes move into an
owner-private, Git-ignored `.stdd/worker-deletions/` recovery quarantine.
Interrupted collection reuses exact deletion baselines for the next idempotent
run; completed baselines remain recognizable for explicit operator removal.
A readable metadata-v1 sandbox may replace file content while retaining its
exact validated baseline mode, including a legacy mode such as `0664`; this
compatibility authority never permits a sandbox-selected mode change and does
not relax metadata-v2 creation modes. The orchestrator still runs fresh
verification and review in the source checkout. STDD never removes the
sandbox automatically; the orchestrator deletes it explicitly only after
reviewing the collected result.

## The scope postflight

`stdd scope` is the postflight check against the recorded baseline rather than
a ref: Git checkouts compare HEAD plus dirty paths, while managed sandboxes
compare their bound file manifest. Only **worker-introduced** changes count — a
change to a frozen path, or outside the allowed paths, fails. Dirt inherited
from before the slice (a file already modified at baseline, byte-identical
now) is reported separately and never blamed on the slice. A declared slice
exempts only the ledger, plan, and exact shape-validated private internal
transaction names;
tracked config, generated files, and reset-name near misses under `.stdd/`
remain ordinary scope inputs. The same exact exemption boundary applies to
checkout and review snapshots. A declared slice appears in `stdd status`,
which names the postflight as the next step once the loop is complete.
