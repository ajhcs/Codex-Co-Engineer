# Codex-Co-Engineer

Give Codex a team of external co-engineers without giving up control.

[![Codex-Co-Engineer CI status](https://github.com/ajhcs/Codex-Co-Engineer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ajhcs/Codex-Co-Engineer/actions/workflows/ci.yml)
[![Latest Codex-Co-Engineer release](https://img.shields.io/github/v/release/ajhcs/Codex-Co-Engineer?sort=semver)](https://github.com/ajhcs/Codex-Co-Engineer/releases/latest)
[![Node.js 24 or newer](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Codex remains chief engineer, reviewer, and merge authority. External
co-engineers do isolated assigned work. You keep control. The honest
shape is up to eight isolated external co-engineers, one bounded run,
one coordinated wait, one verified decision.

`Delegating to Co-Engineer` starts that one bounded run. `Chatting with
Co-Engineer` inspects, continues, answers grouped attention, or cancels
the run that already exists. If you ask to chat and nothing is running,
Codex says chatting needs existing work and offers to delegate. It does
not silently submit.

The public co-engineer names are `Using Grok Co-Engineer`, `Using Cursor
Co-Engineer`, and `Using Muse Co-Engineer`. Cursor on this computer and
Cursor Cloud both stay Cursor Co-Engineer in public speech.

Any extra Co-Engineer panel is optional, feature-detected, and
host-specific. The same conversation works headless in Codex CLI. This
documentation does not claim a Co-Engineer UI on every Codex Desktop
host.

The stable machine identifier is `codex-co-engineer`. Published package
notes: [docs/releases/v3.3.0.md](docs/releases/v3.3.0.md).

## Visual demo

The static Co-Engineer architecture illustration is the authoritative
GitHub-compatible visual. It uses the approved Co-Engineer identity. It
is not a live-run screenshot. GitHub README Markdown cannot guarantee
video playback or reduced-motion behavior. There is no autoplay audio.
Optional silent animation is linked explicitly.

<!-- README_ART_SLOT: hero-demo -->

![Give Codex a team of external co-engineers without giving up control.](docs/assets/co-engineer-3.4.0/final/hero-architecture.png)

Optional silent architecture animation:
[MP4](docs/assets/co-engineer-3.4.0/final/hero-architecture-silent.mp4) or
[WebM](docs/assets/co-engineer-3.4.0/final/hero-architecture-silent.webm).

## First 60 seconds

After [install and authentication](#install-and-authentication), start a
**new** Codex session and speak in ordinary language. You do not write
tool payloads.

### Your first delegation

> Delegating to Co-Engineer: review the auth change with Grok Co-Engineer.

Codex:

> I am delegating this to Co-Engineer. Using Grok Co-Engineer.
> Co-Engineer is running 1 independent assignment.

That is the only submission. Codex waits once. When the work is
complete, Codex inspects it:

> Co-Engineer finished, and I verified the candidate.

<!-- README_ART_SLOT: first-delegation -->

![Conceptual illustration of a first Co-Engineer delegation: one explicit Grok assignment, one submission, and one verified candidate.](docs/assets/co-engineer-3.4.0/final/first-delegation.jpg)

You still decide whether to keep, change, or discard the result.

### Several independent assignments

If you want several independent assignments in one run:

> Split this into three isolated independent assignments: API
> validation, the operator guide, and a review of both diffs.

Codex:

> I am delegating this to Co-Engineer. Co-Engineer is running 3
> independent assignments.

<!-- README_ART_SLOT: multi-lane-run -->

The supplied multi-lane static is malformed and is not published. Any
supplemental multi-lane motion is conceptual only and is published only
when `docs/assets/co-engineer-3.4.0/final/manifest.json` records
`publishable=true` for that asset.

If you have no saved profile and name no co-engineers, Codex asks once
which co-engineers should take the independent assignments: Grok,
Cursor, or Muse. It does not keep asking and does not invent a default
router.

A longer walkthrough lives in
[docs/co-engineer-quickstart.md](docs/co-engineer-quickstart.md).

## How a run works

A run is one submission, one coordinated wait, and one verified
decision. Independent means the assignments do not share a writer path.
The bound is eight.

Codex speech during a run uses these utterances:

- `I am delegating this to Co-Engineer`
- `Co-Engineer is running N independent assignments` (`assignment` when
  N is 1)
- `Co-Engineer needs one decision from you`
- `Co-Engineer finished, and I verified the candidate.`

The verified-final sentence includes its period. Codex uses it only
after it has inspected a complete candidate. Failure, cancel, and
unresolved outcomes must not use it.

Use Codex-Co-Engineer when you want Codex to keep control while isolated
external co-engineers do assigned review or implementation work. Do not
use it as a security sandbox, a credential broker, or a replacement for
the provider's own login and approval flow.

The bundled skill is `control-codex-co-engineer-agents`. Normal-user
journeys: [docs/co-engineer-user-journeys.md](docs/co-engineer-user-journeys.md).

## Provider choices

Provider and model are explicit, chosen by you, or filled from one named
profile. Missing selection is one ask, not a router. Codex never ranks,
predicts cost, or substitutes a different co-engineer.

| You say | Codex says |
| --- | --- |
| Grok Co-Engineer | Using Grok Co-Engineer |
| Cursor Co-Engineer | Using Cursor Co-Engineer |
| Muse Co-Engineer | Using Muse Co-Engineer |

- **Using Grok Co-Engineer** runs an explicitly selected Grok assignment.
- **Using Cursor Co-Engineer** covers Cursor on this computer or Cursor
  Cloud; Codex keeps the location and immutable starting commit explicit.
- **Using Muse Co-Engineer** runs the explicitly selected Muse profile and
  model. It does not silently become another provider.

You may name the Cursor place in plain language. Public speech still
stays `Using Cursor Co-Engineer`. Muse is the public name for that
route. Optional Ox Alpha stays a Muse-route model choice, not a separate
public co-engineer name.

Example:

> Use Grok Co-Engineer for the API change and Muse Co-Engineer for the
> docs. Keep the review on Cursor Co-Engineer.

Codex:

> I am delegating this to Co-Engineer. Using Grok Co-Engineer.
> Using Muse Co-Engineer. Using Cursor Co-Engineer. Co-Engineer is
> running 3 independent assignments.

<!-- README_ART_SLOT: provider-choices -->

![Conceptual illustration of explicit Grok, Cursor, and Muse Co-Engineer choices, with no learned or global router.](docs/assets/co-engineer-3.4.0/final/provider-choices.jpg)

## Codex authority and safety

Codex remains the chief engineer. You remain the merge authority.
External co-engineers stay isolated. One bounded run is in flight at a
time for this work. Chatting never becomes a second submission. Failure
stays visible.

Selecting a provider authorizes the assignment prompt and repository
content to be sent to that provider. Private repositories are supported
when the configured provider is authorized to review them. Provider
children inherit the user's normal authenticated environment because
they are trusted peer coding agents.

Local workers are launched as manager-owned transient `systemd --user`
services with `KillMode=control-group` solely so cancellation reaches
detached descendants and the worker survives the launching client. This
is a lifecycle/cleanup boundary, not a sandbox: providers inherit the
normal environment, network, filesystem, credentials, and shell
capabilities. Local dispatch fails closed when the Linux systemd/cgroup
prerequisite is not available. The check occurs before Codex-Co-Engineer
creates a managed worktree, task receipt, or prompt file. Cursor Cloud
runs in the provider's remote environment and does not depend on the
local process boundary.

Cursor Local and DSH's official fallback CLIs take the prompt
positionally, so it may be visible to other processes running as the
same Unix user for the duration of that fallback. Grok fallback uses an
owner-only prompt file.

Managed local work uses one locked `worktree-bootstrap` worktree and
branch per assignment:

```text
one task → one worktree → one branch → one writer
```

Direct mutation of a supplied checkout is an explicit 3.2.1 single-task
choice only. Bounded-run submissions do not use direct mode.

If `worktree-bootstrap` fails before returning an authoritative receipt
and path, Codex-Co-Engineer does not guess at or delete an unknown
worktree. Inspect the repository with `git worktree list` and the
`worktree-bootstrap` lock tooling; clean only an exact task/lock that
the tooling identifies.

Cursor Cloud does not use a local worktree. The supplied repository must
have an origin that Cursor can access. A bounded-run Cloud lane needs an
exact, immutable commit SHA that has already been pushed to that origin.
An exact SHA that is reachable only from a feature branch can still be
invisible to Cursor until that branch is provider-visible through an
open pull request or the default branch. Create the draft PR (or make
the commit reachable from the default branch) before final Cloud
acceptance. If Cursor returns HTTP 400 for an otherwise-valid SHA, treat
it as a provider visibility failure and fix reachability before
retrying; do not blindly replay the work.

Local implementations return a branch and handoff for Codex to inspect.
Codex may push and open a PR only after confirming that real commits
exist. Codex controls the final merge.

Task prompts, events, logs, runtime identities, local paths, branch
names, and opaque provider IDs are stored under the owner-only state
directory, normally `$XDG_STATE_HOME/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. Task directories are `0700`; files
are `0600`. See [data handling](docs/data-handling.md).

## Chatting, grouped attention, and the final decision

Chatting with Co-Engineer during a live run is not a second delegation.
It can inspect the current run, continue from its recorded cursor, answer
one grouped decision, or cancel the existing run. It never creates
unlimited persistent chat and never silently starts new work.

The run is already in its one coordinated wait. More than one assignment
needs a choice. Codex groups those questions into one decision.
Unaffected assignments keep working.

Codex:

> Co-Engineer needs one decision from you.

You:

> Use the stricter validator and keep the docs change as written.

<!-- README_ART_SLOT: grouped-attention -->

This image slot is held. No supplied source shows grouped questions,
affected and unaffected lanes, one structured response, and same-cursor
resume together.

That answer is chatting: answer grouped attention. It is not a debate
loop. Codex continues the same run with the same single wait.

After the wait, Codex inspects the candidate. Only then may it say:

> Co-Engineer finished, and I verified the candidate.

<!-- README_ART_SLOT: verified-final-decision -->

This image slot is held. Conceptual outcome art lacks branch, head, and
tree identities plus the scope, tests, reviews, candidate, and
sanitized-evidence contract.

Verification is Codex's review of the candidate, not automatic merge.
You keep control.

If a required assignment fails, cannot be answered, or stays unresolved,
Codex reports that honestly. It does not say Co-Engineer finished, and I
verified the candidate. A required gap blocks a complete candidate.
Cancel is chatting with Co-Engineer, not a new delegation.

<!-- README_ART_SLOT: failure-unresolved -->

![Conceptual illustration of a required Co-Engineer assignment that failed or stayed unresolved, so no verified candidate is claimed.](docs/assets/co-engineer-3.4.0/final/failure-unresolved.jpg)

## Install and authentication

Requires Node.js 24+, Git, and Codex CLI. Local providers also need
Linux `systemd --user`, `systemd-run` 244 or newer, unified cgroup v2,
and `worktree-bootstrap` on `PATH`.

```bash
git clone https://github.com/ajhcs/Codex-Co-Engineer.git
cd Codex-Co-Engineer
codex plugin marketplace add "$PWD"
codex plugin add codex-co-engineer@codex-co-engineer
npm --prefix plugins/codex-co-engineer run setup
npm --prefix plugins/codex-co-engineer run setup:check
```

<!-- README_ART_SLOT: install-auth -->

![Conceptual illustration of a clean Codex-Co-Engineer install and provider sign-in, with credentials and private paths omitted.](docs/assets/co-engineer-3.4.0/final/install-auth.jpg)

`npm run setup` installs pinned ACPX `0.13.0`, Cursor SDK `1.0.28`, and
the cohesive DSH `0.1.0-rc.7` composition. It does not log you into
Grok, Cursor Local, or Cursor Cloud. `setup:check` verifies those pinned
packages plus `worktree-bootstrap`. Start a **new** Codex session after
the plugin add.

Sign in once for only the providers you will use:

```bash
grok login
cursor-agent login
plugins/codex-co-engineer/bin/set-model-api-key
```

Cursor Cloud uses `CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, or the
owner-only `~/.config/cursor-cloud-control/api-key`. DSH uses
`MODEL_API_KEY`, `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE`, or
`~/.config/codex-co-engineer/model-api-key` for Muse. The optional Ox
Alpha route uses `OPENROUTER_API_KEY`,
`CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE`, or
`~/.config/codex-co-engineer/openrouter-api-key`. Never put credentials
in MCP arguments or prompts.

Host variables, profiles, and package-local setup live in
[docs/configuration.md](docs/configuration.md) and the
[plugin README](plugins/codex-co-engineer/README.md).

The older `cursor-cloud-control` package remains in this repository as a
compatibility plugin for existing installations. New installations need
only Codex-Co-Engineer.

## Migrating from 3.2.1

The public catalog is still five tools. Bounded runs are additive. If
you omit run fields, exact 3.2.1 single-task behavior remains, including
direct mode on that path only.

The normal 3.2.1 habit of writing a tool payload is no longer the
visitor path. Say `Delegating to Co-Engineer` and name Grok, Cursor, or
Muse Co-Engineer. Codex submits once and waits once.

Details: [docs/co-engineer-migration-3.2.1.md](docs/co-engineer-migration-3.2.1.md).

## Troubleshooting

**How do I check whether Codex-Co-Engineer can dispatch locally?**
Ask Codex: `Show Codex-Co-Engineer status.` Local providers are ready
only when `local_boundary.ready` is true. If it is false, the MCP
process is missing Linux `systemd --user`, `systemd-run` 244+, unified
cgroup v2, or the forwarded user-session locators (`XDG_RUNTIME_DIR`,
`DBUS_SESSION_BUS_ADDRESS`).

**Setup passed, but local providers are unavailable.**
`setup:check` does not prove the MCP environment. Re-run status from the
actual MCP server process, then confirm the plugin `.mcp.json` allowlist
forwards `HOME`, `PATH`, `XDG_*`, and `DBUS_SESSION_BUS_ADDRESS`.

**Where is the installed plugin?**
After `codex plugin add codex-co-engineer@codex-co-engineer`, Codex
reports the cached install path. The source package in this repository
is `plugins/codex-co-engineer`. Run `npm run setup` from that source
package (or with `npm --prefix plugins/codex-co-engineer`) rather than
guessing a cache path.

**A managed worktree appeared without a receipt.**
Do not guess or delete it. Inspect `git worktree list` and
`worktree-bootstrap lock inspect`, then clean only an exact identified
task/lock.

**Cursor Cloud returned HTTP 400 for a valid SHA.**
Treat it as a provider visibility failure. Make the commit reachable
from an open PR or the default branch, then retry. Do not replay a
prompt that was already dispatched.

**Can I put API keys in the MCP tool arguments?**
No. Use normal provider login or the owner-only key files. Credentials
must not appear in MCP arguments, prompts, receipts, fixtures, or Git.

**There is no Co-Engineer panel in this host.**
That is expected on hosts that do not expose one. The headless
Delegating/Chatting conversation is complete. Missing UI is not a failed
install.

**Chatting did nothing.**
Chatting with Co-Engineer needs an existing run. Codex should offer to
delegate instead of silently submitting.

More cases: [docs/co-engineer-troubleshooting.md](docs/co-engineer-troubleshooting.md).

## Advanced Co-Engineer Control/API

This section is for operators and Codex internals. Normal users do not
construct these payloads.

The catalog remains exactly `status`, `delegate`, `task`, `tasks`, and
`cancel`. There is no sixth tool. Bounded runs use additive `run`,
`run_id`, `attention`, `run_reply`, `cleanup`, and
`wait_until: "decision_or_attention"` on those tools; omitting them
keeps exact 3.2.1 single-task behavior.

| Coordination step | Tool | Additive mode |
| --- | --- | --- |
| one submission | `delegate` | `run` with 1–8 isolated assignments |
| inspect | `status` or `task` | `run_id` |
| one aggregate wait | `task` or `tasks` | `wait_until: "decision_or_attention"` |
| answer grouped attention | `task` | one reply for the grouped decision |
| cancel | `cancel` | `run_id` |

The repository argument is the literal MCP property `repo`. Always send
it as `"repo": "/absolute/path/to/git-worktree"`; `git_root`,
`repository`, and other aliases are unknown properties and fail schema
validation. Cursor Cloud also requires `repo` for the clean local
checkout. Its pushed immutable commit SHA is a separate, Cursor
Cloud-only `starting_ref` property.

`delegate` records `expected_duration_ms` or `timeout_ms` and a 20%
deadline margin. `task` can wait with `wait_until: "terminal"` until the
recorded deadline, inspect summary/compact/diagnostics views, extend a
deadline with an explicit reason, and deliver a same-session reply. It
does not push unsolicited stdio callbacks across assistant turns.

Local 3.2.1 review:

```json
{
  "task_id": "review-auth-refactor",
  "provider": "grok",
  "repo": "/absolute/path/to/git-worktree",
  "role": "review",
  "workspace_mode": "managed",
  "prompt": "Review the current branch and report concrete correctness risks.",
  "expected_duration_ms": 600000
}
```

```json
{
  "task_id": "review-auth-refactor",
  "wait_until": "terminal"
}
```

Inspect the receipt before Codex pushes, opens a PR, or merges.

Cursor Cloud implementation:

```json
{
  "task_id": "cloud-auth-refactor",
  "provider": "cursor-cloud",
  "repo": "/absolute/path/to/clean-checkout",
  "role": "implement",
  "starting_ref": "0123456789abcdef0123456789abcdef01234567",
  "prompt": "Implement the requested change, run tests, and commit the result.",
  "expected_duration_ms": 3600000,
  "create_pr": true
}
```

Wait on a bounded run without waking on routine text:

```json
{
  "run_id": "auth-split",
  "wait_until": "decision_or_attention"
}
```

Internal provider slots remain `grok`, `cursor-local`, `cursor-cloud`,
and `dsh`. Roles are `review` and `implement`. An accepted prompt is
never replayed through another transport. ACPX does not provide an
authoritative prompt-sent acknowledgement, so a DSH task is marked
`dispatch_uncertain` as soon as ACPX spawns and is never replayed
through CLI.

`create_pr` is a Cursor Cloud-only option and defaults to `false`. Local
tasks reject it.

For parallel 3.2.1 tasks, coordinate the result set with one `tasks`
wait-any call instead of polling every task. Use `status` and `task`
compact views for routine decisions; open diagnostics pages only when a
task needs attention or fails. Clients that consume `structuredContent`
can opt into `response_mode: "structured"`. Text-only clients should
omit it. The compact single-task projection is capped at 8,192 UTF-8
bytes by the MCP server. That is a server payload guarantee, not a
measured or claimed hard limit in the Codex desktop renderer. See the
[efficient dogfood workflow](docs/efficient-dogfood.md).

Terminal managed tasks retain their worktree and branch for Codex
inspection; they are not silently deleted. Watch with `task`
(`wait_until: "terminal"` plus optional `cursor`), then run the
authoritative handoff from the recorded worktree:

```bash
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
```

Inspect commits, diff, tests, and ownership evidence before pushing or
opening a PR. After merge or deliberate discard:

```bash
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Clean only the exact corresponding branch and terminal task-state
directory after its receipt is no longer needed. Direct tasks have no
managed worktree; review their caller checkout explicitly. Cursor Cloud
agents are archived after terminal completion where supported, while
their remote branch/PR remains for Codex review.

```bash
npm --prefix plugins/codex-co-engineer test
node scripts/validate-release.mjs
node scripts/inspector-preflight.mjs
```

The authoritative release gate runs against one exact local candidate
using Node 24. GitHub Actions is a credential-free mirror; live Grok,
Cursor, Cursor Cloud, and DSH acceptance is recorded separately because
CI must not send repository content to model providers.

This repository does not create the GitHub Release, tag, or remote from
the published notes file.

## License

MIT. See [LICENSE](LICENSE).
