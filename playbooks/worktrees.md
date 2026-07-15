---
name: stdd-worktrees
description: Work in an isolated workspace without fighting the platform's native isolation
when: Starting implementation work that should not disturb the user's current checkout.
---

# Isolated Workspaces

## Order of preference

1. **Detect existing isolation.** If you are already in a linked worktree or
   a platform-managed sandbox, use it. Never nest worktrees. (Check:
   `git rev-parse --git-dir` differs from `--git-common-dir`, and you are not
   in a submodule.)
2. **Use the platform's native worktree tool** if one exists. Manual
   `git worktree add` alongside a native tool creates state the platform
   cannot see or clean up.
3. **Fall back to `git worktree add`** only when neither applies:
   - Put worktrees in a dedicated ignored directory (`.worktrees/` at the
     repo root by default).
   - Verify the directory is git-ignored **before** creating the worktree;
     add it to `.gitignore` first if not.
   - Branch from the repository's integration branch unless told otherwise.

## After creating

- Run the project's dependency setup (install, build) so the workspace is
  self-sufficient.
- Run `stdd doctor --readiness` before trusting any verification output in
  a fresh worktree — a missing install or unbuilt package produces phantom
  failures that look like your change broke something.
- Untracked and gitignored files (env files, credentials, build output)
  exist per checkout — a fresh worktree never has them.
- Run the narrowest baseline verification before changing anything. If the
  baseline is already red, report it and ask before proceeding — otherwise
  you cannot tell your breakage from pre-existing breakage.

## Shared state warnings

- The git stash stack is shared across all worktrees of one repository.
  Prefer a temporary WIP commit over stashing; if you must stash, tag the
  entry and apply (not pop) by its SHA.
- Never `cd` out of your assigned worktree into the main checkout to "fix
  something quickly" — open work there belongs to someone else.
