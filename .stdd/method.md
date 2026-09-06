# The STDD Method

This is the working contract. It is written for the agent or developer doing
the change, in the order the work happens. It holds the rules; the mechanics
behind each command live in the reference documents named at the end, and a
phase's playbook names the one it needs.

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
   current head commit. `stdd ci --watch` is that wait, done right — never
   hand-roll the poller; the pr-green playbook holds the recognition table.
   A deploy, migration, publish, or other runtime effect is verified on its
   own surface: green CI is not runtime proof.
7. **State PR evidence.** Every PR carries exactly one of:
   - `Docs updated first:` — list the changed docs;
   - `Docs checked, no change needed:` — list the docs and the reason;
   - `Docs not applicable:` — why the change is implementation-only.

   The line must name its evidence — docs paths or a reason; a bare label
   fails `stdd check-pr`, and with a base ref the claim is verified against
   the actual diff. `stdd evidence` drafts the line from ground truth instead
   of recall. The flags and the near-miss diagnostics are in
   `.stdd/reference/commands.md`.

## Proportionality

The default route for an agreed change is one slice: the docs decision, a
failing test where one applies, the implementation, a fresh verify. A plan, a
delegated worker, and an independent review are escalations from that route,
each with a condition below. None of it touches proof — the docs decision, a
genuine red where a test applies, and a fresh verify hold at every size.
Proportionality cuts paperwork, never evidence.

A change is one slice when, at the moment of deciding, it has one agreed
observable outcome, one coherent implementation boundary, one acceptance check,
and no known dependency on another independently verifiable change. Escalate as
soon as any of four things appears: a second independent outcome, an ordering
dependency between parts, a need to hand work to another session, or a design
decision nobody has made yet. They are usually discovered mid-work. Escalating
then is the normal case, not a failed classification — the criterion is re-read
as the work goes, never declared once at the start.

Two independent axes decide which escalation applies. **Coordination
complexity** decides the plan and delegation: work that must be ordered, split,
or handed over needs a durable plan, because those artifacts exist against
memory that does not survive compaction or a handoff. **Consequence** is why a
human may want an independent review that coordination did not already
require: a two-line change to authorization or pricing can carry more of it
than a two-hundred-line rename. `stdd status` names the review from
coordination alone, because coordination is what it can observe; consequence
is a judgement, and `stdd review` is callable for it at any moment. Which
surfaces carry consequence is the adopting team's contract, not this kit's —
see "What stdd does not cover". Diff size decides neither axis; it proxies both
and measures neither.

A PR, and the CI wait that follows it, ride on the delivery boundary the user
asked for. A change requested as a local edit is complete when it is verified
locally.

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
`docs/project/**` files, and the generated method preamble and agent routing
override the generic project-log option below.

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
something is deferred or was decided. Because a plain `grep` cannot tell
authority levels apart, every project-log entry starts with frontmatter
declaring itself non-canonical:

```yaml
---
authority: non-canonical
status: deferred
---
```

The agent instructions `stdd init` generates carry the matching retrieval
rule: do not search the project log unless the user explicitly asks for
historical rationale or deferred work; with the log disabled, do not create or
search one at all.

`stdd check` enforces the configured artifact policy in CI; `stdd check-pr`
enforces the PR evidence line; `stdd doctor` reports a repository's overall
adoption health. The rest of the method is review discipline — anything that
later proves mechanically checkable should move into `stdd check`.

## Repository configuration

`.stdd/config.json` is where the adopting repository declares what the kit
cannot know. Three declarations bear on every session:

- **Readiness.** A worktree-readiness contract names paths that must exist
  before verification output can be trusted (installed dependencies, built
  packages, per-checkout env files), each with a repo-authored fix hint.
  `stdd doctor --readiness` runs only that section, cheap enough for every
  session start. stdd verifies and prescribes; it never installs, and it does
  not detect a stale-but-present artifact.
- **Capability profile.** `capabilities` states what the agent environment
  can actually do: `subagents`, `crossCli`, `worktrees`. Playbooks are compiled
  against the profile at `stdd init` time, never branched at runtime, so a
  route the profile lacks is absent from the generated skills rather than
  offered and refused.
- **Content rules and branch pattern.** Mechanically checkable conventions
  that would otherwise live in folklore; `stdd check` grades them.

The syntax of each declaration, and how `stdd init`, `stdd configure`, and the
generated agent outputs consume the profile, are in
`.stdd/reference/integration.md`.

Agent adapters have two outputs with deliberately different context costs: a
short, always-on instruction block carrying only repository invariants, and
native, lazily loaded skills carrying the task workflows. Five routing skills
make the main path explicit. `stdd-investigation` (current-state facts and
diagnosis) and `stdd-brainstorming` (opinions, future behavior, hypothetical
approaches) are read-only and create no task, ledger event, artifact, or
mutation. `stdd-start-change` begins only after explicit intent to persist a
work artifact or modify the repository — a hypothetical plan shown in chat
stays Brainstorming. `stdd-implement` runs the docs/red/green/verify loop, and
`stdd-finish-change` closes review, evidence, PR checks, and any requested
runtime verification. Specialized playbooks remain independently invocable.

## The session ledger and `stdd status`

The loop's state must not live only in the agent's context window — context
is not durable storage. **Compaction is a trust boundary**: anything that
must survive a session lives in a file, never in conversation memory.

The ledger is that file: `.stdd/ledger.jsonl`, append-only JSONL, one event
per line, per checkout and never committed. A branch is not a task identity:
`stdd task start <name>` opens a random task ID, subsequent events carry it,
`stdd task finish` closes it without deleting its evidence, and `stdd task
reset` closes it as abandoned. Starting while another task is active is an
error; finish and reset are explicit so a new session cannot silently discard
another session's work.

Recorders write the ledger at the moment the fact happens, from any directory
of the repository:

- `stdd docs <updated-first|checked|not-applicable> [paths…] [--reason <why>]`
  records the docs decision and its reason once, when it is made.
- `stdd red -- <cmd>` and `stdd verify -- <cmd>` run the command, record its
  exit and output verbatim with a snapshot of the checkout, and pass the exit
  code through. `red` asserts genuine-red — a test-framework failure, not an
  environment error — through the configured `redPattern`; a red run that
  exits zero is green, not red.
- `stdd note <text>` records free-form handoff context.

The ledger is **advisory input, never a gate by itself**. `stdd check` and
`check-pr` pass or fail exactly as without it; a missing ledger changes
nothing. Where a ledger exists, derivation replaces reconstruction:
`stdd evidence` reads the recorded docs decision first, and the diff remains
the cross-check that wins on contradiction.

`stdd status` is the next-step oracle: callable at any moment, it answers
where in the loop this checkout is and what the next step is, from git first,
then the ledger, then the forge when available (`--local` skips the forge and
is the only form generated lifecycle hooks call). Its judgments are about
freshness: a passing verify becomes stale after any later checkout change, a
docs decision is stale when the diff contradicts it, and implementation is
observed only when the checkout changes after the red snapshot. Historical
green is never displayed as current proof. Run it at session start and before
opening a PR. Once the loop is verified, `status` names the closing review only
when something expects one — a plan, a delegated slice, or a recorded verdict —
and only when the capability profile has a dispatch route; with none it goes
straight to the evidence line, never to self-review. Reader rules and the
JSON shape: `.stdd/reference/commands.md`.

## The durable plan and `stdd defer`

A multi-step change needs a plan that survives compaction. Its working copy
is `.stdd/plan.md`: markdown with a checkbox list (`- [ ]` / `- [x]`), one
item per verifiable step, free prose around it. Like the ledger it is a
per-checkout working artifact — `stdd init` adds the ignore rule, and
`stdd check` fails when either is a tracked file, regardless of config.

The plan states outcomes, not internals: what becomes observable, which
constraints hold, what evidence accepts each step. Internal names are the
executor's choice, made against the governing architecture; exact
interfaces are fixed only where something outside the change commits to
them or one step hands them to another. An optional `Mode: inline|delegated`
line records the execution choice made at planning time; it is informational
and never affects the gate.

`stdd status` reads the plan and reports progress, the first open item, and
the mode. Once the current pass is verified and open items remain, continuing
the plan is the named next step — ahead of the evidence line and the PR.

A checkbox is a claim; the ledger is the proof. An item tagged
`[red: <substring>]` closes only when the branch's ledger holds a genuine red
whose command contains the substring. A multi-step plan ends with an
**independent review** of the cumulative diff as its last item, tagged
`[review:]`, when the capability profile has a dispatch route (`subagents` or
`crossCli`); the item is written in at planning time so the trigger travels
with the plan, and it closes only when the newest `review` event carries an
`approved` verdict — recorded by `stdd review`, never by ticking the box.
Until then a checked tagged item counts as open and is flagged as unproven.
With both dispatch capabilities off, compilation omits the review item and
guidance entirely; it never substitutes self-review. A change that needed no
plan carries no such item and makes no review claim.

`stdd defer <text>` records a scope cut for the active task under the plan's
`## Deferred` section. Deferred entries never count toward progress; carry
them into the PR description's out-of-scope when the PR is assembled. The
plan stays deletable at any moment — durable rules flow to the docs edit,
rationale and scope decisions to the PR description. How the tags are parsed
and how `defer` guards against a concurrent task or branch switch are in
`.stdd/reference/commands.md`.

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
red, verification, a closing review the plan claims, and `stdd check` are not
actions the file can name. Policy widens what an agent may do without asking;
it never narrows what the loop must prove. The set, and every other reading
rule, is enforced when the document is read, not only when `stdd policy`
writes it; an entry the reader cannot honor grants nothing.

None of that binds a session that reads the markdown itself, so policy is
consulted through `stdd policy show`. That view is where the rules are applied:
it lists the grants the kit honors, the advisory notes, and any entry it
ignored with the reason. The raw file is a record, not an authority; its
parsing rules are in `.stdd/reference/generated-state.md`.

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
config (default `subagent`); `--via` overrides per call. `--via codex` and
`--via claude` require the `crossCli` capability, `--via subagent` requires
`subagents` — an unavailable route is an error, never a silent fall-back to
self-review.

Every run snapshots the work under review — the content of every path that
differs from `baseRef`, committed or not, plus the plan's text. The snapshot
follows content, never Git's bookkeeping: staging or committing moves no bytes
and cannot stale a verdict, editing them does. Ticking a plan box or recording
a deferral does not stale it; editing the plan's words does. The command then
builds a **brief** — the plan, the diff and a complete changed-file manifest,
the untracked files the diff cannot show, and the governing canonical docs the
reviewer reads for itself — plus the rubric (spec compliance against the plan
first, then code quality on what was built) and a strict output contract: one
JSON object with `summary` and `findings`, each finding
`severity: blocking | advisory`. Any wrong shape rejects the whole result.

Severity follows consequence, not taste. A finding blocks only when it
names a concrete defect, a violation of the plan or the governing docs, or
a realistic material risk, and says how it fails. Security weaknesses,
regressions, and architecture-boundary breaches qualify. Naming,
constants, duplication, structure, and pattern departures are advisory
on their own; they block only with a shown material effect or a named
governing requirement. Internal choices within the plan's outcome are the
implementer's.

A repeat review after `changes-requested` is a follow-up, not a fresh
audit: the brief carries the prior round's findings, checked for resolution
first, over the still-cumulative diff. A deferral voids a finding only once
the work it concerned is out of scope and gone from the diff; the verdict is
the reviewer's own.

Repository text inside the brief is untrusted review data, never reviewer
instructions. An automated reviewer is evidence, not a security boundary or a
substitute for accountable human review: read-only tool enforcement limits
mutation, it does not make model judgment infallible or eliminate
prompt-injection risk. Teams choose which changes still require human
approval.

The verdict is **derived, never self-declared**: no blocking findings
means `approved`, any blocking finding means `changes-requested`, and a
runner failure, timeout, malformed output, or stale snapshot means
`error` — an `error` is never an approval. On `approved`, that one ledger
fact closes the `[review:]` item. After `changes-requested`: fix the findings
and run `stdd review` again; the newest verdict controls the tag.

A repository may declare a **review budget** (`review.maxRounds`). Once the
branch's ledger holds that many `changes-requested` verdicts, `stdd review`
refuses another dispatch and reports the review as still blocked; `--force`
spends one more round deliberately and requires `--reason <text>`, recorded
with the round it bought. The budget ends the loop, never the judgment: the
change is paused, not done, until the findings are fixed and a forced round
approves.

A stale approval reopens the review everywhere, not just in the gate. So an
approved verdict freezes the checkout: anything found afterwards is either
deferred with `stdd defer` or costs a fresh round. Editing on top of an
approval does not preserve it, it discards it.

`stdd status --gate` folds the review state into an exit code for hooks and
scripts: it fails on a broken claim — a checked-but-unproven `[review:]`
item, a `changes-requested`, `error`, or stale verdict, or a claim whose route
the profile cannot dispatch. Unfinished work never fails it: the gate judges
claims, not pace. The exact conditions, the brief's composition and storage,
the result contract, and each dispatch route are in
`.stdd/reference/commands.md`.

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
undeclared slice cannot be graded. Both record a `scope` event carrying globs
and a **baseline**, and `stdd scope` grades the result against that baseline.
The worker records red/verify/note events as it goes, and the orchestrator
assembles the PR body from the parent ledger. What a managed sandbox copies,
what `stdd worker collect` refuses, and how the postflight reads are in
`.stdd/reference/commands.md`.

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
are exempt: a backticked phrase is a literal being named, not narrative.

## Reference

This document is what a session reads before a change, so it holds the
contract and nothing else. The mechanisms behind it are canonical too, and
live beside it; an initialized repository carries installed copies under
`.stdd/reference/`, and the installed method names those. None is required
reading: a playbook names the one its phase needs.

- `.stdd/reference/commands.md` — the internals behind the loop's commands:
  the PR evidence flags, the ledger's readers and `stdd status`, plan tags and
  `stdd defer`, `stdd review` (result contract, brief storage and settlement,
  dispatch routes, budget and gate), and the worker commands.
- `.stdd/reference/generated-state.md` — how generated files are
  authenticated, retired, and recovered: manifest hashes, the cleanup
  journal, the bundled `stdd-fs` helper, the printable-text boundary, the
  policy document's parsing rules, and ledger transaction state.
- `.stdd/reference/integration.md` — what `stdd init` and `stdd configure`
  write: repository configuration, capability profiles, per-host agent
  outputs, adoption modes and the universal bundle, project-local recipes, CI
  adapters, and lifecycle hooks.

## What stdd does not cover

stdd is a process contract, not an engineering standard. Architecture rules,
dependency-injection styles, error-handling policy, tenant/auth/data safety,
and database-migration policy stay in the adopting team's own contract
(typically `AGENTS.md`) and docs tree. stdd tells you *where* such rules
live and *when* they must be written — not what they should say.
