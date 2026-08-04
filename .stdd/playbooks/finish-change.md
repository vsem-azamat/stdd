---
name: stdd-finish-change
description: Close an implemented change with independent review, PR evidence, terminal CI, and runtime verification when required
when: Implementation is locally verified and the change is ready for review, delivery, or handoff.
---

# Finish change

Close the current checkout in this order:

1. Run the complete affected local verification.
2. Finish every plan item and run the independent closing review when the
   capability profile supports it.
   `stdd review --via codex` dispatches the other CLI
   read-only and records the verdict in the ledger.
   `stdd review --via subagent` prints the brief path for a fresh read-only
   subagent; feed its JSON back with `stdd review --result <file>`.
3. Generate the PR evidence with `stdd evidence`; never hand-author a claim
   contradicted by the diff.
4. Open or update the PR/MR and wait for terminal checks. On GitHub use
   `stdd ci --watch`; on another forge use its adapter's equivalent.
5. If the change includes a deploy, migration, package publish, or other
   runtime effect, verify that surface separately. Green CI is not runtime
   proof.
6. Run `stdd task finish` only after the requested delivery boundary is
   actually complete.

An `approved` verdict freezes the checkout. Anything you notice afterwards —
a stale comment, a better name, one more edge case — is deferred with
`stdd defer`, not edited in. Editing discards the approval rather than
improving on it, and buys a round that found nothing. Past the review
budget, `--force` needs `--reason <text>`: write what the extra round is
expected to settle, not that the reviewer asked again.

Do not merge, deploy, publish, or mutate an external system unless the user
has authorized that action. A permission that `stdd policy show` reports is
that authorization, but only once this session has verified the entry's
condition and said what it verified; an unverifiable condition leaves the rule
exactly as it stands. An entry the command lists as ignored grants nothing.

