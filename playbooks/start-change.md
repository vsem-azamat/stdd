---
name: stdd-start-change
description: Open durable task state and route work after explicit intent to persist or modify the repository
when: The user explicitly wants a persisted work artifact or repository change.
---

# Start change

Start Change is the action boundary. Invoke it only after explicit intent to
persist a work artifact or modify the repository. Read-only factual diagnosis
routes directly to `stdd-investigation`; opinions, future behavior, and
hypothetical implementation approaches route directly to `stdd-brainstorming`.
Neither needs a task. A hypothetical plan shown only in chat remains
Brainstorming.

Run `stdd policy show` before asking anything: it may already answer which
agent owns this area, which standing permission covers the work, and what this
repository treats as routine rather than a decision. Read it through the
command, never as raw markdown — the command is where the rules are applied.

Open one task boundary before carrying action state across prompts:

```bash
stdd task start "<short change name>"
stdd status --local
```

If another task is active, do not reset it silently. Finish it, continue it,
or ask the user which task owns the checkout.

Then route. The default is one slice: invoke `stdd-implement` directly. A
change is one slice when, at the moment of deciding, it has one agreed
observable outcome, one coherent implementation boundary, one acceptance check,
and no known dependency on another independently verifiable change.

Escalate from that default only on a named trigger:

- a second independent outcome or an ordering dependency between parts →
  invoke `stdd-planning`;
- work to hand to another session → invoke `stdd-planning`, then
  `stdd-delegate-slice`;
- a design decision nobody has made yet → invoke `stdd-brainstorming` within
  the active change boundary;
- a known defect without a diagnosis → invoke `stdd-debugging`.

Any of them may appear mid-work. Escalating then is the normal case, not a
failed classification.

Read `.stdd/method.md` and the canonical docs governing the touched behavior.
The classification is a routing decision, not ceremony: skip workflows that do
not apply, but never skip a mechanical contract that does.
