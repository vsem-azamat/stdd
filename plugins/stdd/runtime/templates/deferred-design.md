# Deferred Design Template

A design for work that is agreed but not yet scheduled. Lives as a **dated
entry** in the project log (e.g. `docs/project/`), never as a spec file next
to canonical docs. Delete the entry when the work ships or is abandoned.

The frontmatter is mandatory: it is the machine-readable marker that keeps
agent retrieval authority-aware — canonical docs never carry
`authority: non-canonical`, project-log entries always do.

```markdown
---
authority: non-canonical
status: deferred
---

# <Title>

Last updated: <YYYY-MM-DD>

- Status: Deferred | Decision needed | Ready | Blocked
- Priority: High | Medium | Low

## Problem

<What hurts and who it hurts. Impact if never done.>

## Agreed direction

<The design, as rules precise enough to implement from. Note explicitly that
this describes FUTURE behavior — canonical docs still describe the present.>

## Why deferred

<The reason it is not being done now.>

## Resume condition

<The concrete trigger that should restart this work.>

## Acceptance criteria

<How we will know it is done.>
```
