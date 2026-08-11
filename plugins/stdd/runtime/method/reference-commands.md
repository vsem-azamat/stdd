# Reference: review and worker command internals

The mechanics behind `stdd review` and the worker commands: how a request is
stored and settled, what each dispatch route does, and what a managed sandbox
copies and collects. The method states the contract; this document states the
implementation.

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
are never inlined).

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
