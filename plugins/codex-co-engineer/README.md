# Codex-Co-Engineer

**Give Codex a team. Keep control of the result.**

Bring Grok, Cursor, and Muse into the same Codex task for implementation,
investigation, or review. Co-Engineer prepares isolated workspaces for up to
eight independent assignments and returns their results for Codex to inspect.
You decide what ships.

[Quickstart](docs/co-engineer-quickstart.md) · [Configuration](docs/configuration.md) ·
[Troubleshooting](docs/co-engineer-troubleshooting.md) · [3.4.3 release notes](docs/releases/v3.4.3.md)

> Use Grok Co-Engineer to review the latest change. Report actionable findings.

Speak naturally; you do not need tool payloads, a profile, or another manager
for an ordinary launch. A separate host panel is optional. The CLI conversation
is a complete workflow. The stable plugin and MCP identifier is `codex-co-engineer`.

## Complete engineering assignments

The revision operation and result reporting below are part of the 3.4.3
candidate; use the PR43 candidate install path below while the public tag is
absent. Verification remains open and no savings claim is made here.

Grok and Cursor can own preparation, implementation, meaningful checks, and
requested corrections. Tell Codex your provider preferences once in the task;
it can reuse them for eligible assignments while you retain final control.
Co-Engineer returns concise candidate evidence and supports bounded revisions
without rebuilding dispatch details. An explicit provider choice takes priority.

The [autonomous ownership guide](skills/delegate-to-co-engineer/references/autonomous-ownership.md)
explains coordination for Astra and other autonomous agents. Compare total
native-agent work per accepted result, including native helpers; provider
readiness does not establish a subscription balance.
See the [result guide](docs/run-results.md) and the public repository’s
[contribution guide](https://github.com/ajhcs/Codex-Co-Engineer/blob/main/CONTRIBUTING.md),
[support routes](https://github.com/ajhcs/Codex-Co-Engineer/blob/main/SUPPORT.md),
and the candidate
[first-outcome example](https://github.com/ajhcs/Codex-Co-Engineer/tree/codex/coengineer-autonomous-ownership-20260910/examples/first-outcome)
(PR43 tree only; absent from current `main` and published `v3.4.2`).

## Install and authentication

### Requirements

- Node.js 24+, Git, Python 3.11+ for bundled setup, and a current Codex CLI with plugin support.
- For local providers: Linux, `systemd --user`, `systemd-run` 244+, unified
  cgroup v2.
- Install and authenticate only the provider routes you intend to use.

The worktree tool is bundled; no separate `worktree-bootstrap` installation is needed.

### Install published 3.4.2 (stable)

While the public `v3.4.3` tag is absent, install the **stable** published release.
This path does not include the 3.4.3 candidate onboarding example or ownership
package.

```bash
git clone --branch v3.4.2 --single-branch https://github.com/ajhcs/Codex-Co-Engineer.git Codex-Co-Engineer-3.4.2
cd Codex-Co-Engineer-3.4.2
npm --prefix plugins/codex-co-engineer run setup
codex plugin marketplace add "$PWD"
codex plugin add codex-co-engineer@codex-co-engineer
npm --prefix plugins/codex-co-engineer run setup:check
```

### Install the 3.4.3 candidate from public PR43

The public candidate keeps the stable marketplace identity
`codex-co-engineer`. Prefer a clean Codex installation. If Co-Engineer is
already installed, finish or cancel active runs, then follow the supported
remove/re-add workflow, or keep the candidate in a separate clean Codex
environment. Do not rename the shipped marketplace manifest to work around a
local collision.

```bash
git clone https://github.com/ajhcs/Codex-Co-Engineer.git Codex-Co-Engineer-pr43
cd Codex-Co-Engineer-pr43
git fetch origin pull/43/head:pr-43
git switch --detach pr-43
git rev-parse HEAD
git remote get-url origin
git status --short
npm --prefix plugins/codex-co-engineer run setup
codex plugin marketplace add "$PWD"
codex plugin add codex-co-engineer@codex-co-engineer
npm --prefix plugins/codex-co-engineer run setup:check
```

Equivalent branch: `codex/coengineer-autonomous-ownership-20260910`. Parent tip
`c50550e0a12e6ce8f7564d0e384f52c205640ce5` is historical development evidence
from PR43; an external execution manifest binds the final integrated candidate
SHA after integration.

Keep each clone as its registered marketplace source. Setup installs pinned ACPX
0.13.0, Cursor SDK 1.0.28, and the DSH 0.1.0-rc.7 composition globally. Use a
user-writable npm global prefix on your `PATH`; a Node version manager is one
way to provide it. Setup creates key-free DSH profiles and owner-only session
storage. It preserves compatible profiles and reports incompatible ones.

From an installed package directory containing `package.json`, the equivalent
commands are `npm run setup` and `npm run setup:check`.

### Connect one or more providers

| Route | Authentication |
| --- | --- |
| Grok | Install the official Grok Build CLI, then `grok login` |
| Cursor Local | Install Cursor CLI, then `cursor-agent login` |
| Cursor Cloud | `CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, or its owner-only key file |
| Muse / DSH | From the clone, run `plugins/codex-co-engineer/bin/set-model-api-key` for OpenRouter |

Muse defaults to Muse Spark 1.3 Contributor with XHigh reasoning through
OpenRouter. The optional Ox Alpha route has a separate DSH profile.
Authentication persists in normal provider login state or owner-only key files;
never include credentials in prompts or tool arguments. See
[configuration](docs/configuration.md#authentication) for locations and variables.

### Verify and start

Start a new Codex session. For a first route, use **one** provider—Grok is the
default walkthrough—and ask: **Show Co-Engineer status.** Then name that
provider and describe its first assignment. Setup checks dependencies and DSH
profiles; the live `status` tool checks provider readiness and the MCP process's
local Linux boundary. Setup does not install or authenticate Grok or Cursor.

### Upgrade

Finish or cancel active runs, then update the matching clean registered clone.

**Published 3.4.2 (stable `codex-co-engineer`):**

```bash
git fetch origin tag v3.4.2
git switch --detach v3.4.2
npm --prefix plugins/codex-co-engineer run setup
codex plugin remove codex-co-engineer@codex-co-engineer
codex plugin add codex-co-engineer@codex-co-engineer
npm --prefix plugins/codex-co-engineer run setup:check
```

**3.4.3 candidate (stable marketplace `codex-co-engineer`; prefer a clean Codex
environment or finish/cancel then remove/re-add):**

```bash
git fetch origin pull/43/head:pr-43
git switch --detach pr-43
git rev-parse HEAD
npm --prefix plugins/codex-co-engineer run setup
codex plugin remove codex-co-engineer@codex-co-engineer
codex plugin add codex-co-engineer@codex-co-engineer
npm --prefix plugins/codex-co-engineer run setup:check
```

Restart the Codex session. Use the identity from `codex plugin list` if your
marketplace name differs. Preserve dirty source clones and existing task state.
Direct Meta Muse profiles need the [OpenRouter migration](docs/releases/v3.4.2.md#upgrading).
Historical 3.4.2 upgrade detail remains in those notes.

## Execution and safety model

Each local worker runs in a manager-owned transient `systemd --user`
service with `KillMode=control-group` so cancellation reaches detached
descendants and the worker survives the launching client. This is only a
lifecycle/cleanup boundary, not a provider sandbox: the normal
environment, credentials, network, filesystem, and shell capabilities
are inherited unchanged. Local dispatch fails closed when Linux systemd
or unified cgroup v2 is unavailable. Cursor Cloud uses the provider's
remote runtime.

Cursor Local and DSH's official fallback CLIs take the prompt
positionally, so it may be visible to other processes running as the
same Unix user during that fallback. Grok fallback uses an owner-only
prompt file.

Managed local work follows:

```text
one task -> one worktree -> one branch -> one writer
```

`managed` (default) creates and locks one `worktree-bootstrap` worktree
and branch per assignment. `direct` runs against the supplied checkout
and is a 3.2.1 single-task choice only. Bounded-run submissions do not
use direct mode.

If bootstrap fails before returning an authoritative receipt and path,
the supervisor cannot safely identify or delete an unknown worktree.
Inspect with `git worktree list` and `worktree-bootstrap` tooling, then
clean only an exact identified task/lock.

Cursor Cloud uses a provider-managed branch, not a local worktree. A
bounded-run Cloud lane requires a provider-accessible origin and an
exact immutable commit SHA already pushed to that origin. A local branch
name or unpushed work is not a valid cloud starting point. An exact SHA
reachable only from a feature branch can remain invisible to Cursor
until the branch is provider-visible through an open pull request or the
default branch. Create the draft PR (or make the commit reachable from
the default branch) before final Cloud acceptance. If the provider
returns HTTP 400 for an otherwise-valid SHA, treat it as a visibility
failure and fix reachability before retrying; do not blindly replay the
work.

`create_pr` is Cursor Cloud-only and defaults to `false`. Local tasks
reject it. Local implementations return their branch and handoff for
Codex to inspect; Codex may push and open a PR only after verifying real
commits.

## Troubleshooting

**Which identifier should Codex, npm, and MCP configs use?**
Use `codex-co-engineer`. The human-facing product name is
Codex-Co-Engineer. Skill configs use the lowercase
`control-codex-co-engineer-agents` name.

**Why are local providers marked not ready after setup?**
`setup:check` validates pinned CLIs and packages. `status.local_boundary`
validates the MCP process environment. Local dispatch stays fail-closed
until Linux `systemd --user`, `systemd-run` 244+, and unified cgroup v2
are visible to that process.

**Where should I run setup?**
From this package directory (`plugins/codex-co-engineer` in a clone), or
with `npm --prefix plugins/codex-co-engineer run setup` from the
repository root. Registration from the repository root uses the stable
marketplace identity `codex-co-engineer` for both published 3.4.2 and the
3.4.3 candidate:

```bash
codex plugin marketplace add "$PWD"
codex plugin add codex-co-engineer@codex-co-engineer
```

Prefer a clean Codex installation for the candidate. If you already have
Co-Engineer installed, finish or cancel active runs, then remove/re-add through
the supported plugin CLI, or keep the candidate in a separate clean environment.
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
Use the headless Delegating/Chatting conversation. Missing UI is not a
failed package install.

More cases: [troubleshooting](docs/co-engineer-troubleshooting.md).

## Data handling

Prompts and selected repository content may leave the machine for the
chosen provider. Private repositories are supported when that provider
is authorized to review them. Do not include credentials in prompts or
repository files. Task receipts contain bounded output, provider/session
identifiers, branch and PR information, lifecycle state, and runtime
identity; they do not contain credentials or the full prompt.

## Remembered repository consent

The native repository consent form treats the host's **Accept** action as the
approval. Its required selector defaults, as disclosed in the form, to
remembering the canonical repository and selected providers; **This run only**
keeps the approval one-time. Adding a provider or changing repository identity
asks again. Existing run-only approvals are never promoted automatically.

```bash
node /absolute/path/to/plugin/bin/consent-grants.mjs list
node /absolute/path/to/plugin/bin/consent-grants.mjs revoke --repo /absolute/path/to/repository
node /absolute/path/to/plugin/bin/consent-grants.mjs revoke --grant-id GRANT_ID_FROM_LIST
```

An npm installation also exposes `codex-co-engineer-consent`. A plugin install
does not place package bins on the global `PATH`, so use the explicit script
path shown above. If an interrupted update leaves `.consent-grants.lock`,
verify that no MCP server or consent command is running before removing that
one owner-only lock file from the Co-Engineer state directory.

The grant file is owner-only state. It contains repository identity, normalized
credential-free origin identity, provider IDs, and grant time, never prompts or
credentials. Revocation is observed by an already-running MCP server on its
next request.

## Advanced Co-Engineer Control/API

This section is for operators and Codex internals. Normal users do not
construct these payloads.

The MCP server exposes five tools:

| Tool | Purpose |
| --- | --- |
| `status` | Supervisor health, provider readiness, and recent task state |
| `delegate` | Start a review or implementation task, or one bounded run |
| `task` | Inspect one task receipt, compact live progress, and optional wait |
| `tasks` | List or keyset-page recent receipts, or wait on 1–8 exact tasks |
| `cancel` | Stop one owned local process group, Cursor Cloud run, or run |

The catalog is still those five tools. Bounded runs use additive
parameters (`run_request`, legacy `run`, `run_id`, `attention`, `run_reply`, `cleanup`, and
`wait_until: "decision_or_attention"`) on the same tools. Omit them to
keep exact 3.2.1 single-task behavior. Run wait is a bounded
`decision_or_attention` wait. See
[the run tool API](docs/run-tool-api.md).

For a bounded 3.4.3 run, `delegate` accepts the small semantic
`run_request` body. The server derives the clean Git identity, provider
model, task/workspace/dispatch identities, prompt and manifest digests, and
managed-workspace policy. Do not construct the legacy full `run` envelope or
derived provenance; it remains accepted only for compatibility. Providers
are `grok`, `cursor-local`, `cursor-cloud`, and `dsh`; roles are
`review` and `implement`.

Legacy single-task `delegate` still requires a stable `task_id`, a provider,
an absolute Git worktree path in the property named `repo`, a prompt, and
`expected_duration_ms` or a backwards-compatible `timeout_ms`.
DSH defaults to `meta/muse-spark-1.3-contributor` with xhigh reasoning. Set
`dsh_model: "stealth/ox-alpha"` to select the separate OpenRouter-backed
Ox Alpha configuration for that task.

The argument name is part of the MCP contract: send
`"repo": "/absolute/path/to/git-worktree"`. Do not substitute `git_root`,
`repository`, or another alias; unknown properties fail schema
validation. Cursor Cloud also requires `repo` for the clean local
checkout, while its pushed immutable commit SHA belongs separately in
the Cursor Cloud-only `starting_ref` property.

`task` always returns a compact `progress` snapshot (`event_cursor`,
`last_event`, `new_event_count`, `more_events`, `waited_ms`,
`wait_reason`) plus a normalized `state` and diagnostic envelope. Pass
`wait_until: "terminal"` to block until success, failure, timeout,
cancellation, transport loss, environment block, or `needs_attention`
without waking on routine text. Omit `wait_ms` in that mode to wait
until the recorded deadline, capped by the advertised 4-hour MCP
pending-call budget. `view: "diagnostics"` is a side-effect-free
cursor-paged evidence page. `reply` delivers a same-session answer
exactly once where the provider supports it. Deadline extensions require
`extend_reason`. The five-tool API is unchanged; unsolicited stdio
callbacks across assistant turns are not available.

### Efficient workflow

The coordination path keeps the same five tools and the no-argument
`tasks` behavior:

- Call `status` with `detail: "compact"`, `task_limit` from 0 through 20,
  or `include_tasks: false` for a readiness-only check.
- Inspect routine progress with `task` `view: "compact"`. Its structured
  JSON is capped at 8,192 UTF-8 bytes. Use cursor-paged
  `view: "diagnostics"` only for attention and failure evidence.
- List with `tasks` `detail: "compact"`, a `limit` from 1 through 20, and
  the returned opaque `next_cursor`. Provider and state filters are bound
  into the keyset cursor. Full detail remains available explicitly.
- Coordinate 1 through 8 exact task IDs with one `tasks` wait-any call.
  Supply per-task event `cursors` when continuing a wait; use one shared
  `wait_ms` and `wait_until` instead of one polling loop per task.
  Wait-any options cannot be mixed with list filters or pagination
  options. Its task snapshots and live event previews are bounded; when
  present, `progress.detail_hint` directs the caller to `task` for the
  target's full live event detail.
- Capable clients default to structured-first bounded responses. Add
  `response_mode: "structured"` explicitly when the client advertises
  authoritative `structuredContent`; text-only clients may omit it for the
  compatible full JSON text receipt. Simple-run status is capped at 24 KiB
  and other simple-run receipts at 72 KiB.

Terminal provider results are redacted and bounded, including values
returned as nested objects. When evidence is clipped, the receipt
reports `result_truncated` and reports `result_original_chars` when the
source size is known. These fields describe Unicode code points;
structured transport limits are UTF-8 bytes. The 8,192-byte compact cap
is enforced by the MCP server and is not a measured hard limit of the
Codex desktop renderer.

For an end-to-end pattern, see the repository's
[efficient dogfood guide](docs/efficient-dogfood.md).

### Provider matrix

| Provider | Transport | Workspace | Notes |
| --- | --- | --- | --- |
| `grok` | ACP first | `managed` default, `direct` explicit on 3.2.1 | CLI fallback only before prompt dispatch; owner-only prompt file |
| `cursor-local` | ACP first | `managed` default, `direct` explicit on 3.2.1 | Official fallback CLI takes the prompt positionally |
| `dsh` | Official rc.7 ACP via ACPX | `managed` default, `direct` explicit on 3.2.1 | Muse default; optional `stealth/ox-alpha`; marked `dispatch_uncertain` after ACPX spawn and never CLI-replayed |
| `cursor-cloud` | Official Cursor SDK | Remote branch | Requires a pushed immutable `starting_ref` SHA on bounded-run Cloud lanes |

Once a prompt is dispatched, Codex-Co-Engineer never replays it through
another transport. ACPX does not provide an authoritative prompt-sent
acknowledgement.

### Configuration variables

| Variable | Purpose |
| --- | --- |
| `CODEX_CO_ENGINEER_STATE_DIR` | Owner-only task-state root. |
| `CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE` | Owner-only OpenRouter key file for DSH Muse and Ox Alpha. |
| `CODEX_CO_ENGINEER_DSH_ACP_CONFIG` | Absolute DSH ACP YAML path. |
| `CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG` | Absolute Ox Alpha DSH ACP YAML path. |
| `CURSOR_API_KEY_FILE` | Owner-only Cursor Cloud key file. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Grok executable override. |
| `CODEX_CO_ENGINEER_CURSOR_COMMAND` | Cursor Local executable override. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH CLI fallback executable override. |
| `CODEX_CO_ENGINEER_DSH_ACP_COMMAND` | DSH ACP server override. |
| `CODEX_CO_ENGINEER_ACPX_COMMAND` | ACPX executable override. |

The default state directory is `${XDG_STATE_HOME}/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. Task directories are `0700`; files
are `0600`. Prompts, events, logs, and ACP/DSH session data remain
owner-only until the operator removes the exact terminal task state.

### Handoff and cleanup

Terminal managed tasks retain their worktree and branch for inspection.
Watch with `task` (`wait_until: "terminal"` and optional `cursor`), then
run:

```bash
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Use the exact lock ID; never delete a lock by hand. Remove only the
matching branch and terminal task-state directory after the receipt is
no longer needed. Direct-mode tasks have no managed worktree. Cursor
Cloud agents are archived after terminal completion where supported;
their remote branch or PR remains for Codex review.

### Examples

Preferred bounded-run submission (the server compiles the protected
identities and provenance):

```json
{
  "run_request": {
    "run_id": "auth-hardening",
    "repo": "/absolute/path/to/git-worktree",
    "objective": "Implement and review the auth hardening change.",
    "assignments": [
      {
        "assignment_id": "auth-implementation",
        "provider": "grok",
        "role": "implement",
        "access": "write",
        "prompt": "Implement the auth hardening slice and commit it.",
        "expected_duration_ms": 900000
      }
    ]
  }
}
```

The following single-task and Cloud examples are legacy compatibility
examples. New skills and callers should use `run_request` for bounded runs.

Local review:

```json
{
  "task_id": "review-auth-1",
  "provider": "grok",
  "role": "review",
  "repo": "/absolute/path/to/git-worktree",
  "workspace_mode": "managed",
  "prompt": "Review authentication changes and report actionable findings.",
  "expected_duration_ms": 600000
}
```

Cursor Cloud implementation:

```json
{
  "task_id": "cloud-auth-1",
  "provider": "cursor-cloud",
  "role": "implement",
  "repo": "/absolute/path/to/clean-checkout",
  "starting_ref": "0123456789abcdef0123456789abcdef01234567",
  "prompt": "Implement the requested change, run tests, and commit the result.",
  "expected_duration_ms": 3600000,
  "create_pr": true
}
```

Watch a running task until it finishes or needs attention:

```json
{
  "task_id": "review-auth-1",
  "wait_until": "terminal",
  "cursor": "184"
}
```

Use the `event_cursor` from the previous `task` result. A terminal wait
returns when the task succeeds, fails, times out, is cancelled, loses
transport, needs a reply, or hits the advertised MCP pending-call
budget. Routine text deltas do not wake Codex. Disconnecting the waiter
does not stop provider work. Unsolicited stdio callbacks across
assistant turns are not available.

For an implementation, use `role: "implement"`. A local managed task
creates and locks its worktree before the provider starts.

## Development

```bash
npm test
node ../../scripts/inspector-preflight.mjs
npm pack . --dry-run --ignore-scripts --offline --json
```

Live provider checks are opt-in host acceptance tests and do not run in
GitHub CI. See the repository release documentation for the exact-tree
gate.
