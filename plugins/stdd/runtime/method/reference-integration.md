# Reference: installation, agent hosts, and automation

What `stdd init` and `stdd configure` write, what each agent host receives,
and how the optional CI and lifecycle-hook adapters behave. The method states
that these surfaces exist; this document states what they do.

## Choosing the profile: `init` and `configure`

`stdd init
--capabilities <list>` writes the profile without hand-editing JSON
(named capabilities on, the rest off), and `stdd init --interview` asks
one question at a time — recommended answer first — then runs the same
init. The interview also picks the reviewer route (`review.via`) and,
for the selected native agents (Claude Code, Codex, and Pi), offers the
lifecycle integration.
When `crossCli` is selected, the first selected native host is the driver for
the repository-level reviewer default and its opposite CLI is recorded:
Claude → codex, Codex → claude, Pi → claude. Per-host generated skills use the
same opposite-host rule explicitly, so a repository compiling multiple hosts
never teaches Claude Code or Codex to review itself; Pi is a driver host, not a
`stdd review --via` runner. With no dispatch capability, generated skills omit
the `[review:]` claim and review commands entirely; manual self-review is never
presented as an independent-review fallback.

`stdd configure` re-runs the interview over an existing install, with
the **current** values as the defaults. It edits only the capability
profile and the review route — every other config key is preserved —
and recompiles the same generated targets the last init produced (the
manifest remembers them). It does not install or remove CI workflows,
change CI target selection, or remove lifecycle hooks. Stop hooks are the
explicit exception: a remembered Stop-hook target is maintained (and restored
if missing), while `--stop-hook` opts in and may install it for the selected
agents. Configure never adds pre-push or session hooks. Flag forms skip the
questions: `--capabilities <list>`,
`--review-via subagent|codex|claude`, `--max-rounds <n>` (the review
budget; 0 = unlimited), `--stop-hook`. When the profile has a dispatch
capability, an incompatible route (codex or claude without `crossCli`,
subagent without `subagents`) is an error, never a silent downgrade to
self-review. A profile with no dispatch capability may retain a dormant
route because it emits no review claim; invoking or claiming review still
requires an available route.

## Agent host outputs

For Codex (`--tools codex`), init compiles every active playbook to
`.agents/skills/<name>/SKILL.md`, where Codex can select it implicitly from
its description or the user can invoke it explicitly as `$<name>`. Init also
maintains the repo's `AGENTS.md`: the short STDD section is written between
`stdd:begin`/`stdd:end` marker comments. The file is created when absent, the
marked section is replaced in place when present, and content outside the
markers is never touched. The section is also saved to
`.stdd/AGENTS-snippet.md` for manual composition.

For Claude Code (`--tools claude`), the same playbooks compile to
`.claude/skills/<name>/SKILL.md`, invocable as `/<name>` or selected
implicitly. Init maintains the same short invariant block in `CLAUDE.md`,
between the same managed markers, and saves it as
`.stdd/CLAUDE-snippet.md`. `AGENTS.md` and `CLAUDE.md` stay user-owned and
are never manifest-tracked; the generated snippets and native skills are
manifest-tracked. The full method is never injected into every prompt:
always-on files point to `.stdd/method.md`, while skills load their detailed
workflow only when used.

For Pi (`--tools pi`), init uses the Agent Skills standard registry at
`.agents/skills/<name>/SKILL.md`, which Pi discovers natively and invokes as
`/skill:<name>`. That output is byte-identical to Codex's skill files, so a
repository selecting both hosts has one shared generated copy rather than
duplicate skill names. Pi's short router lives in `.pi/APPEND_SYSTEM.md`, not
`AGENTS.md`: this keeps Pi's `/skill:` syntax from overwriting Codex's `$`
syntax when both hosts are selected. The append-system file is user-owned;
init maintains only its marked STDD section and saves the generated source as
`.stdd/PI-snippet.md`.

Every host's managed instructions expose five mandatory routes in native
syntax: Investigation and Brainstorming are direct read-only routes, Start
Change is the explicit boundary for persisted or repository-changing action,
and Implement and Finish Change execute and close that action. The router may
sequence Investigation → Brainstorming only when unknown current facts
materially affect future design. It never sends read-only work through Start
Change or treats ordinary code and docs reading during Brainstorming as a
separate Investigation.

## Adoption modes and the universal bundle

STDD has three cumulative adoption modes. **Personal plugin** use installs the
universal STDD bundle once through Codex, Claude Code, or Pi and changes no
repository; its lazy skills remain available, while lifecycle integrations stay
dormant outside a checkout containing `.stdd/`.
**Shared repository contract** use runs `init` once and commits `.stdd/`, native
agent routing, and repository policy. **Enforced contract** use explicitly adds
repository-owned hooks or a CI adapter; ordinary `init` never creates CI, and
CI reads checkout and review-request facts rather than the private ledger or
agent state.

Repo-local generated skills remain a valid team contract and need no plugin.
The optional universal bundle at `plugins/stdd/` distributes one generated set
of conservative-profile skills and one CLI runtime through native Codex and
Claude Code plugin manifests or the `@stdd/plugin` Pi package. The runtime is
generated from the same source and version as `@stdd/cli`; the adopting
repository does not install that CLI package.

The adoption modes are cumulative, and for Pi they overlap by name. Codex and
Claude Code namespace a plugin's skills under the plugin, but Pi registers the
bundle's skills into the same flat `.agents/skills` registry an initialized
repository generates into, so every skill name exists twice. The repository's
definition wins: it is generated for that checkout's selected hosts, while the
bundle ships the conservative profile that assumes none of them. The bundle
still supplies its lifecycle extension and runtime. Pi reports the overlap on
interactive startup only, so a contract that watched a non-interactive run for
that report would be watching a stream the host never writes to. The bundle never owns repository
state: its lifecycle integration acts only when the checkout contains
`.stdd/`; init, task state, policy, and optional CI stay with the repository.

A host installs a plugin from a marketplace catalog, not from a bundle
directory, so this repository root carries one catalog per host — Codex reads
`.agents/plugins/marketplace.json` and Claude Code reads
`.claude-plugin/marketplace.json`. Both list the single plugin `stdd`, sourced
from the `plugins/stdd/` directory of the same checkout. Neither catalog names
a version: `npm run build:plugin` aligns the bundle manifests and nothing above
them, so a version restated in a catalog would be a second place to bump that
no build touches. Each host resolves the installed version from the bundle
manifest its entry sources.

Codex and Claude Code use the bundle's fail-open SessionStart and Stop command
hooks. If the bundled runtime cannot read an adopting checkout, SessionStart
reports fixed update-or-reinitialize guidance and exits successfully; Stop
returns the host's allow response without forwarding runtime output. Pi loads
the same skills plus a package extension. On `session_start` and
`session_compact`, that extension queues successful local status output for
the next model turn; on `agent_settled`, it queues at most one corrective
follow-up when the gate blocks. Runtime errors remain fail-open and are never
sent into a model turn. The installed bundle version governs all three hosts'
lifecycle commands.

Repository-generated pre-push/session/stop hooks are a separate integration and continue to require the exact project-local package
for pinned offline execution. The source-checkout command
`npm run build:plugin` validates every host manifest and publishes the shared
skills, Pi extension, runtime, and all six native mutation helpers through the
same capability boundary as the CLI. Retired stale skills move to an
identity-bound, non-loadable quarantine that remains available for explicit
operator removal; subsequent builds keep recognized quarantines stable.

## Project-local recipes

Project-specific recipes live in `.stdd/playbooks/local/` — markdown
playbooks with the same frontmatter contract (`name`, `description`,
`when`, optional `requires`), owned by the repository and never
overwritten by `stdd init`. They compile through the same pipeline as
the kit's playbooks — capability blocks included — into each selected host's
native skill registry. Always-on AGENTS/CLAUDE blocks remain a fixed, minimal
router: they name the method, the project-local runner, and `.stdd/policy.md`,
and do not enumerate either kit or project skills. A local recipe that
reuses a kit playbook's `name` replaces it: project knowledge outranks the kit.
Local recipe names must otherwise be unique; init rejects duplicates before
writing generated state and names both conflicting source files.
The five skills named by that router (`stdd-investigation`,
`stdd-brainstorming`, `stdd-start-change`, `stdd-implement`, and
`stdd-finish-change`) are mandatory; init rejects a profile or local override
that would make one inactive. Other inactive local overrides still shadow
their kit playbook intentionally.

## CI adapters

CI integration is an explicit, optional transport adapter around
provider-neutral CLI contracts. `init` without `--ci` creates no provider file;
a team may instead place the printed generic commands in an existing quality
job. Every configured provider runs `stdd check`; a review pipeline pipes its
live PR/MR description to `stdd check-pr - --base <ref>`. CI uses read-only
repository and review-request access. It never attempts to prove the agent's
reasoning, consume the ignored ledger, dispatch workers, or mutate Git: it
grades only facts derivable from the checkout and review request.

On GitHub, `stdd init --ci github` writes the canonical workflow for these
gates and installs an explicit supported Node runtime. It fetches the PR body
live from the API and re-runs on body edits —
a workflow reading `github.event.pull_request.body` validates a payload
frozen at trigger time, so an edited body is never re-checked and a re-run
replays the stale text. The fetch uses node, not the gh CLI — node is
already required to run stdd, while self-hosted runners often lack gh —
and the step sets `pipefail`, so a failed fetch fails the gate as a fetch
error instead of feeding check-pr an empty body that misreports as a
missing evidence line. `stdd doctor` flags the frozen-payload form, and flags a PR
template carrying an unquoted evidence label at the start of a line, since
its placeholder residue would pass the gate on every PR.

On GitLab, `stdd init --ci gitlab` writes an includeable
`.gitlab/stdd.gitlab-ci.yml` job. It uses the merge-request API to fetch the
live description, pipes it to `check-pr -`, and passes
`CI_MERGE_REQUEST_DIFF_BASE_SHA` as the base. The job enables `pipefail`, so
an API failure fails the gate instead of being mistaken for an empty body.
Same-project pipelines authenticate with the short-lived `CI_JOB_TOKEN`.
Because fork merge-request pipelines normally run in the source project, the
target must allowlist that source for job-token access. A controlled trusted
fork may instead supply a masked and hidden target-project
`STDD_GITLAB_READ_API_TOKEN` with only `read_api`; target credentials are
never safe in an untrusted fork pipeline. Authentication failure names the
required setup instead of pretending fork access is automatic.
`stdd init --ci generic` writes no provider file; it prints and records the
portable command contract for teams to compose into Jenkins, Buildkite, or an
existing pipeline. Provider templates are adapters, never dependencies of
the method or public SDK.

## Local hooks

Locally, `stdd init --hooks` writes a pre-push hook that runs exactly one
fast, offline command: `stdd check`. Nothing network-bound belongs in a
hook — a flaky gate's false positives train `--no-verify`. The hook file
is user-owned after generation (like `config.json`, it is not
manifest-tracked and never overwritten), so teams append their own steps.
stdd never touches `.git/`: install it via
`git config core.hooksPath .stdd/hooks`, or call `stdd check` from an
existing hook manager. `stdd doctor` reports whether the hook is wired
up — informationally, never as a failure.

Generated hooks invoke the project-local package offline and name the scoped
package explicitly:
`npm exec --offline --package=@stdd/cli@<generated-version> -- stdd`. They
never ask npm to resolve the unrelated unscoped package `stdd`. Install
`@stdd/cli` as an exact development dependency before wiring hooks. The
`@stdd/cli` source repository is the one dogfood exception: its generated
automation invokes `node "$(git rev-parse --show-toplevel)/cli/stdd.mjs"`
directly, because the checkout being tested is the package source and may not
exist in npm's offline cache yet.

For selected native agents, `stdd init --session-hook` wires the session-start
ritual mechanically. Claude Code and Codex each get one `SessionStart` hook
(`startup|resume|clear|compact`) in their native settings. Pi gets a
project-local `.pi/extensions/stdd.js` extension that runs the same command on
`session_start` and `session_compact`, then queues its output for the next
model turn. The `compact` source is the single context-restoration path;
re-init removes older managed Claude `PostCompact` entries to avoid running the
ritual twice, while preserving unrelated user hooks. Each integration runs
`stdd status --local`, which never calls a forge or the network, so every fresh
context opens with local loop state and the next step already in it — recorded
state instead of recall. When that state is idle, the injected human or JSON
output is neutral: it says that discussion and read-only work require no task
instead of prompting task creation. Hook entries are merged into existing valid
files without duplication. A conflicting Pi extension or invalid JSON settings are
left untouched and a manual instruction is printed instead. Codex hooks and
Pi project extensions remain subject to their host's repository trust review.

`stdd init --stop-hook` (opt-in, also offered by the interview and
`stdd configure`) wires the other end of the selected native agents. Claude
Code and Codex receive a `Stop` hook running the agent-specific
`stdd stop-hook` protocol, which applies the same judgment as `status --gate`
when the agent tries to finish. Pi has no pre-stop veto event; its project
extension checks the same gate at `agent_settled` and queues at most one
corrective follow-up turn when blocked. It then fails open rather than creating
an unbounded feedback loop, so this is visible corrective continuation, not a
hard stop guarantee. Broken claims — a
checked-but-unproven `[review:]` item, a changes-requested or stale
verdict — block the stop with the reasons fed back; unfinished work
never does, the same as the gate. The command respects
`stop_hook_active` (a blocked stop is never re-blocked into a loop) and
fails open: an internal error exits zero, because a broken hook must
not trap the session. Claude blocks with exit 2 and stderr; Codex exits 0
with its documented `Stop` continuation JSON (`decision: "block"` plus
`reason`); an empty JSON object allows a clean stop. The Codex boundary accepts
exactly `{}`, or exactly the two keys `decision` and `reason`, where the
decision is `"block"` and the reason is a string with non-whitespace content.
It emits compact JSON without changing valid reason text. Extra or missing
keys, whitespace-only reasons, arrays, primitives, malformed or empty output,
and nonzero child results all fail open as `{}`.
Pi treats command failures as fail-open and never sends their output into a
model turn. Merging rules match the session hook.
