# Privacy

STDD runs on your machine. It ships no telemetry and contacts no service
operated by its author.

Neither published package declares a dependency that installing it would fetch —
no runtime, optional, peer, or bundled dependency — and neither runs an install
lifecycle script, so an install pulls nothing beyond the package itself.
(Biome is this repository's only npm devDependency, and a devDependency is never
installed for package consumers; building the native helpers additionally needs
a Rust toolchain.)
The packages do carry prebuilt native filesystem helpers, compiled from this
repository's Rust source together with the third-party crates listed in
`native/stdd-fs/Cargo.toml`. Those helpers run locally and do filesystem work,
with one exception: on Windows one of them reads the machine-wide Developer Mode
registry setting, because whether it may create a link depends on it.

## What it stores, and where

STDD's durable record lives in the repository you point it at:

- `.stdd/` holds the task ledger, the plan working copy, and this project's
  configuration, method, policy, and playbook files. The ledger is worth
  understanding: besides the docs decisions, review requests, and verdicts, a
  `red` or `verify` event stores the command you ran — its arguments joined by
  spaces, so quoting and argument boundaries are not preserved — together with an
  excerpt of its output, and `stdd note` stores whatever text you pass it. If a
  test prints a secret, that secret is in the ledger. `.stdd/ledger.jsonl` and
  `.stdd/plan.md` are gitignored, so they stay on your machine instead of
  travelling with a commit.
- `stdd init` also writes host integration files elsewhere in that repository:
  skill directories under `.claude/skills/` and `.agents/skills/`, Pi's
  `.pi/APPEND_SYSTEM.md` and its optional lifecycle extension, lifecycle hook
  configuration in `.claude/settings.json` and `.codex/hooks.json`, a short STDD
  section maintained between markers inside your own `AGENTS.md` and
  `CLAUDE.md`, and — only when you ask for them — CI configuration and git
  hooks. `.stdd/manifest.json` inventories the files init owns outright; the
  ones it only maintains a section of — `AGENTS.md`, `CLAUDE.md`, and
  `.pi/APPEND_SYSTEM.md` — stay yours, deliberately kept out of that manifest so
  init never claims ownership of a file you also edit.

Outside the repository, STDD uses your operating system's temporary directory
for ledger lock files, staging directories used to publish generated files
atomically, a bare Git directory used while checking managed-worker state, and
review briefs. A brief can carry source contents — the active plan, the diff
under review, and the contents of untracked files — so it is created owner-only.
The staging and bare-Git directories are removed as their work finishes, but an
abrupt termination can leave one behind.

A managed worker sandbox is the other thing written outside the repository, and
only if you run `stdd worker create <directory>`. At the destination you name it
writes a copy of the checkout's tracked and non-ignored untracked files, a
`.stdd/worker.json` binding recording the sandbox ID, the source task and
branch, the declared scope, the source HEAD, and a fingerprint for every copied
path, and its own minimal ledger — which accumulates command text and output
excerpts exactly as the one in your repository does.

### State that is kept on purpose

STDD prefers retaining state to deleting it silently, so several things persist
until you remove them deliberately, including:

- the `worker-deletions/` quarantine under `.stdd/`, holding source bytes a
  worker collection removed, and `.stdd/ledger-quarantines/`, holding ledger
  payload bytes;
- generated trees that a later `stdd init` replaced, moved to identity-bound
  quarantines outside their former load paths and journaled in
  `.stdd/cleanup-transaction.json`;
- the worker sandbox above, which `stdd worker collect` leaves in place after
  importing its result;
- a settled review's brief, which is overwritten, truncated to zero, and moved
  into an owner-private quarantine in your temporary directory. What remains
  there has been zeroed, but it remains.

So deleting `.stdd/` does not by itself remove every trace.
`method/reference-generated-state.md` specifies the init quarantines and the
cleanup journal, `method/reference-commands.md` specifies the worker and review
ones, and `stdd doctor` inventories the retained quarantines it recognizes.

## What leaves your machine

The CLI contains no HTTP client and speaks to no server directly. It reaches the
network by invoking programs you already have installed, and only where the
command you ran calls for it:

- **`git`** — local repository operations, with one exception: `stdd check-pr
  --pr` fetches that pull request's base ref from `origin`, and its head commit
  too if your checkout does not already have it. Pushing happens only when you
  run it, to the remote you configured.
- **`gh`** — reading pull-request and check state, under your existing GitHub
  CLI credentials. This happens in `stdd ci`, in `stdd status` unless you pass
  `--local`, and in `stdd check-pr --pr`.
- **`codex`, `claude`** — only when you route a review through one of them, with
  `stdd review --via codex` or `--via claude`. What travels is the brief: the
  active plan, the changed-file manifest, the diff, and the contents of
  untracked regular files. The canonical documents that govern the change are
  referred to by path, so the reviewer reads them itself in your repository,
  read-only — but a canonical document the change touched appears in the diff
  like any other changed file, and an untracked one is sent in full. The brief is
  also not the whole of it: the reviewer runs with read access to your
  repository, so every file it opens to check a claim comes back to the hosted
  model as a tool result. All of this goes to that vendor under your own
  credentials and subject to that vendor's terms and privacy policy.
  `--via subagent` sends nothing: it writes the brief to a file and prints the
  path for you to hand to a reviewer yourself.

STDD adds no recipient of its own to any of those flows, and inserts nothing
into them beyond what the command you ran is for.

One more path is yours, not STDD's. `stdd red -- <command>` and
`stdd verify -- <command>` run the command you give them, unmodified and
unsandboxed. If that command reaches the network — a test suite hitting a
service, a package manager fetching a lockfile — STDD neither prevents it nor
knows about it, and what it records is the command line and an excerpt of the
output.

STDD writes no CI configuration. If you add `stdd check` and `stdd check-pr` to
a job of your own, that job runs on your CI runner under your credentials, and
what it sends is what you wrote: installing the CLI contacts whatever registry
your install command names, and feeding `check-pr` the live pull request
description means your job reads that description from your forge's API. STDD
receives none of it. `check-pr` itself reads the description from standard
input or a file — it opens no network connection of its own.

## Contact

Questions and reports: <https://github.com/vsem-azamat/stdd/issues>
