---
name: stdd-pr-green
description: A PR is done only when its required checks settle terminal-green on the current head
when: A PR/MR exists, or is about to be opened, for the current branch.
---

# PR Green

The discipline: local verification governs the inner loop; the PR's required
checks govern the definition of done. "CI started" and "pushed" are never
done.

## Definition of done

A PR is done when every required check reports a terminal green state — on
the **current head commit**, not a previous one. Watch to a terminal state
before reporting the PR ready; do not hand the wait to the human.

```
gh pr checks <n> --watch     # GitHub
glab ci status --live        # GitLab
```

## Triaging an apparent failure

Not every red mark is a failure. Before debugging, establish that the signal
is real:

1. **Filter by head SHA.** Results attached to a prior commit are stale, not
   red. Compare the check's SHA with `git rev-parse HEAD`.
2. **A cancelled concurrency twin is not a failure.** When a newer push
   supersedes a run, the old run reports cancelled. Debugging it wastes the
   time the cancellation saved.
3. **A stale required check can block the merge.** When a ruleset waits on a
   check that belongs to a cancelled or superseded run, re-run that check —
   do not debug a phantom.

## After a real red

1. Pull the failed job's log — the actual error, not the job name.
2. Reproduce locally with the narrowest matching command.
3. Fix the root cause, push, and re-watch to a terminal state. A fix-commit
   without a re-watch repeats the original mistake.

## Before opening

Run the local lanes that cover the surfaces the diff touches — not only the
narrowest lane that proved the last edit. CI settlement stays the
authoritative backstop; pre-running the entire CI matrix locally is not the
goal.
