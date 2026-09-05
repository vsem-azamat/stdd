---
name: stdd-planning
description: Turn an agreed behavior contract into an executable, verifiable sequence of work
when: The behavior contract is agreed (docs edit drafted or committed) and the change is more than one slice — a second independent outcome, an ordering dependency between parts, work to hand to another session, or an unresolved design decision — before the first implementation edit, to fix the execution mode and delivery boundary.
---

# Planning

A single-slice change goes straight to `stdd-implement`; planning starts
when a second slice appears, usually mid-work.

A plan is a disposable working artifact, never committed: the durable
summary lives in the PR description, the working copy in `.stdd/plan.md`
(per checkout, gitignored, read by `stdd status`, survives compaction).

Write the plan for an executor with zero context: whatever it does not say,
the executor does not know. It states outcomes, not internals — what becomes
observable, which constraints hold, what evidence accepts each step, what is
out of scope. Internal files, functions, and names are the executor's choice,
made against the governing architecture and the representative current code.
Exact interfaces belong in the plan only where something outside the change
commits to them or one step hands them to another.

## Structure

A good plan has, in order:

1. **Intent** — one paragraph: the problem and the agreed direction.
2. **Docs delta** — which permanent docs change and how, named per target
   file and exact enough that the docs edit is mechanical.
3. **Constraints** — the agreement's project-wide requirements (version
   floors, naming and copy rules, platform limits), one line each, exact
   values verbatim, plus the governing architecture docs and representative
   code to follow — and any legacy pattern not to copy. Every step includes
   this section; a delegated worker gets it in the brief.
4. **Steps** — each small enough to verify independently, written as
   checkboxes (`- [ ]`) so `stdd status` can report progress and the next
   open item. Per step:
   - the outcome: what becomes observable, and the boundary it stays inside;
   - the failing test that gates it (or the visual check, for frontend
     visual work — see the design-first exception in the method);
   - the verification command;
   - where they exist, the interfaces it **consumes** from earlier steps and
     **produces** for later ones. A worker sees only its own slice; this is
     how a neighbor's names reach it.

   Tag a step whose gate is a failing test with `[red: <substring of the
   test command>]` — it then closes only when a matching genuine red is
   recorded via `stdd red`, not when the box is ticked.

   The last step of a multi-step plan is always the independent review
   (see "The closing review"). Write it into the plan at planning time —
   the plan must carry the trigger, not the session's memory.
   Tag it `[review:]`: like `[red:]`, the tag closes only through the
   ledger (an approved verdict recorded by `stdd review`), never by
   ticking the box.
5. **Out of scope** — what this change deliberately does not do.
6. **Risks** — what could invalidate the plan and how you would notice.

## Plan failures

These patterns void a step — rewrite it before presenting the plan:

- "TBD", "TODO", "fill in later" in an outcome, constraint, or check.
- "Add appropriate error handling" / "handle edge cases" — name the cases.
- "Write tests for the above" without naming the test and its assertion.
- A check that names no runnable command (a visual check still names the
  command that brings the surface up).
- A consumed interface that neither the repository nor an earlier step
  produces.

Before presenting, re-read the docs delta: every agreed rule maps to a step,
no step carries a pattern above, and consumed interfaces match where they are
produced. Fix findings inline and present once.

## Rules

- Order steps so the system stays green between them.
- Write verification per step, not one "run all tests" at the end.
- A step that cannot fail its check is not a step — merge it into another.
- When execution contradicts the plan, update the plan, do not force the
  plan onto reality. If the *intent* changed, stop and re-enter
  brainstorming.
- The executor decides the internals and reports them. It escalates when an
  outcome, a constraint, a committed interface, or the architecture would
  have to change — never for a routine coding choice.
- Keep durable parts flowing to their homes as you go (rules → docs edit,
  rationale → PR description); the plan must stay deletable without
  information loss.
- Surface plan-invalidating discoveries as one batched question, not one
  interrupt per finding.
- Cut scope explicitly: `stdd defer <text>` appends the cut to the plan's
  `## Deferred` section. Deferred work is carried into the PR
  description's out-of-scope, never silently dropped.

## Executing

Close planning with an explicit execution choice. When `stdd policy show`
reports an execution-mode default, adopt it and state the choice instead of
asking. Otherwise ask it as a closed question to the user, your
recommendation first (**inline** for tightly coupled steps, **delegated**
for independent ones):

> Plan ready (N steps). How should it run?
> 1. **Inline (recommended)** — this session implements the steps itself.
> 2. **Delegated** — independent steps go to workers via delegate-slice;
>    this session orchestrates and reviews.

The modes differ only in who types: the loop and its recording stay
identical. Delegation is a context optimization, never a requirement.
Steps with no interface handed between them are candidates for parallel
delegation — see "Parallel slices" in delegate-slice for the preconditions.

Record the answer as a `Mode: inline|delegated` line at the top of the
plan working copy, so the choice survives compaction.

## The closing review

Every multi-step plan ends the same way, inline or delegated: an
independent review of the cumulative diff, before the evidence line and
the PR. Independence means a fresh context — the reviewer sees the
plan's intent, the docs delta, and the diff, never the implementing
session's history. Two verdicts, in order: spec compliance against the plan
(missing / extra / misunderstood — an internal choice within a step's
outcome and constraints is neither), then code quality on what was built.
Use one of the route-specific commands below. Each builds the brief (plan,
diff, governing docs, quality rubric, output contract), records the request,
derives the verdict from the findings, and closes the `[review:]` item on
approval. After `changes-requested`, fix the findings and repeat the same
command; the next brief carries the prior round's findings so the reviewer
checks their resolution first, and the newest verdict controls the item.
A finding leaves only with its work: an explicit scope cut the user
decided, recorded with `stdd defer`, removes the work it concerned.
`stdd review --via codex` dispatches the other CLI itself, sandboxed
read-only — a reviewer with a genuinely different perspective.
`stdd review --via subagent` prints the brief path: hand it to a fresh
read-only subagent, then feed its JSON back through
`stdd review --result <file>`.

## The final report

When the plan is exhausted, report to the user in their language, for a
human deciding what happens next — not as a second copy of the ledger:

1. **Outcome first** — one or two sentences: what shipped and what
   proves it (tests and gate).
   Include the independent review verdict in that proof.
2. **Deviations from the plan** — deferred cuts, extra work, decisions
   changed mid-flight. If there are none, say so in one line.
3. **The technical trail last** — commands, file:line references,
   round counts.

The machine record already exists; the report earns its place by being
readable — plain sentences over verdict tables, terms spelled out.
