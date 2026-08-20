# Codex-Co-Engineer

**Codex-Co-Engineer** is the ACP-first stdio MCP supervisor that lets Codex
delegate real review and implementation work to trusted, authenticated peer
coding agents:

- Grok Build on the local host
- Cursor Local
- Cursor Cloud
- DeepSeek Harness (DSH) with Muse

Codex remains the chief engineer, reviewer, and merge authority. Providers
retain their normal shell, coding, and dependency-installation capabilities.
The package, plugin, and MCP server identifier is `codex-co-engineer`.
This release is 3.2.0.

## Tools

The MCP server exposes five tools:

| Tool | Purpose |
| --- | --- |
| `status` | Supervisor health, provider readiness, and recent task state |
| `delegate` | Start a review or implementation task |
| `task` | Inspect one task receipt, compact live progress, and optional wait |
| `tasks` | List or keyset-page recent receipts, or wait on 1–8 exact tasks |
| `cancel` | Stop one owned local process group or Cursor Cloud run |

`delegate` requires a stable `task_id`, a provider, an absolute Git worktree
path in the property named `repo`, a prompt, and `expected_duration_ms` or a
backwards-compatible `timeout_ms`. Providers are `grok`, `cursor-local`,
`cursor-cloud`, and `dsh`; roles are `review` and `implement`.

The argument name is part of the MCP contract: send
`"repo": "/absolute/path/to/git-worktree"`. Do not substitute `git_root`,
`repository`, or another alias; unknown properties fail schema validation.
Cursor Cloud also requires `repo` for the clean local checkout, while its
pushed immutable commit SHA belongs separately in the Cursor Cloud-only
`starting_ref` property.

`task` always returns a compact `progress` snapshot (`event_cursor`,
`last_event`, `new_event_count`, `more_events`, `waited_ms`,
`wait_reason`) plus a normalized `state` and diagnostic envelope. Pass
`wait_until: "terminal"` to block until success, failure, timeout,
cancellation, transport loss, environment block, or `needs_attention`
without waking on routine text. Omit `wait_ms` in that mode to wait until
the recorded deadline, capped by the advertised 4-hour MCP pending-call
budget. `view: "diagnostics"` is a side-effect-free cursor-paged evidence
page. `reply` delivers a same-session answer exactly once where the
provider supports it. Deadline extensions require `extend_reason`. The
five-tool API is unchanged; unsolicited stdio callbacks across assistant
turns are not available.

### Efficient workflow

The 3.2.0 coordination path keeps the same five tools and the no-argument
`tasks` behavior:

- Call `status` with `detail: "compact"`, `task_limit` from 0 through 20, or
  `include_tasks: false` for a readiness-only check.
- Inspect routine progress with `task` `view: "compact"`. Its structured JSON
  is capped at 8,192 UTF-8 bytes. Use cursor-paged `view: "diagnostics"` only
  for attention and failure evidence.
- List with `tasks` `detail: "compact"`, a `limit` from 1 through 20, and the
  returned opaque `next_cursor`. Provider and state filters are bound into the
  keyset cursor. Full detail remains available explicitly.
- Coordinate 1 through 8 exact task IDs with one `tasks` wait-any call. Supply
  per-task event `cursors` when continuing a wait; use one shared `wait_ms` and
  `wait_until` instead of one polling loop per task. Wait-any options cannot be
  mixed with list filters or pagination options. Its task snapshots and live
  event previews are bounded; when present, `progress.detail_hint` directs the
  caller to `task` for the target's full live event detail.
- Add `response_mode: "structured"` when the client reads authoritative
  `structuredContent`. The text content becomes a bounded fallback. If the
  property is omitted, `content[0].text` remains the exact full JSON
  serialization of `structuredContent` for legacy clients.

Terminal provider results are redacted and bounded, including values returned
as nested objects. When evidence is clipped, the receipt reports
`result_truncated` and reports `result_original_chars` when the source size is
known. These fields describe Unicode code points; structured transport limits
are UTF-8 bytes. The 8,192-byte compact cap is enforced by the MCP server and
is not a measured hard limit of the Codex desktop renderer.

For an end-to-end pattern, see the repository's
[efficient dogfood guide](../../docs/efficient-dogfood.md).

## Provider matrix

| Provider | Transport | Workspace | Notes |
| --- | --- | --- | --- |
| `grok` | ACP first | `managed` default, `direct` explicit | CLI fallback only before prompt dispatch; owner-only prompt file |
| `cursor-local` | ACP first | `managed` default, `direct` explicit | Official fallback CLI takes the prompt positionally |
| `dsh` | Official rc.7 ACP via ACPX | `managed` default, `direct` explicit | Marked `dispatch_uncertain` after ACPX spawn; never CLI-replayed |
| `cursor-cloud` | Official Cursor SDK | Remote branch | Requires a pushed immutable `starting_ref` SHA |

Once a prompt is dispatched, Codex-Co-Engineer never replays it through
another transport. ACPX does not provide an authoritative prompt-sent
acknowledgement.

## Execution and safety model

Each local worker runs in a manager-owned transient `systemd --user` service
with `KillMode=control-group` so cancellation reaches detached descendants and
the worker survives the launching client. This is only a lifecycle/cleanup
boundary, not a provider sandbox: the normal environment, credentials,
network, filesystem, and shell capabilities are inherited unchanged. Local
dispatch fails closed when Linux systemd or unified cgroup v2 is unavailable.
Cursor Cloud uses the provider's remote runtime.

Cursor Local and DSH's official fallback CLIs take the prompt positionally, so
it may be visible to other processes running as the same Unix user during that
fallback. Grok fallback uses an owner-only prompt file.

### Local workspace modes

Local tasks accept `workspace_mode`:

- `managed` (default) creates and locks one `worktree-bootstrap` worktree
  and branch per task.
- `direct` runs against the supplied checkout and explicitly permits direct
  mutation of it.

Managed tasks follow:

```text
one task -> one worktree -> one branch -> one writer
```

If bootstrap fails before returning an authoritative receipt and path, the
supervisor cannot safely identify or delete an unknown worktree. Inspect with
`git worktree list` and `worktree-bootstrap` tooling, then clean only an exact
identified task/lock.

Reviews and implementations use the same provider capabilities; managed
reviews inspect an isolated worktree instead of the caller's checkout.

### Cursor Cloud and PRs

Cursor Cloud uses a provider-managed branch, not a local worktree. The
supplied repository must have a provider-accessible origin, and
`starting_ref` must be an exact immutable commit SHA already pushed to that
origin. A local branch name or unpushed work is not a valid cloud starting
point.

An exact SHA reachable only from a feature branch can remain invisible to
Cursor until the branch is provider-visible through an open pull request or
the default branch. Create the draft PR (or make the commit reachable from
the default branch) before final Cloud acceptance. If the provider returns
HTTP 400 for an otherwise-valid SHA, surface it as a visibility failure in
the receipt and fix reachability before retrying; do not blindly replay the
task.

`create_pr` is Cursor Cloud-only and defaults to `false`. Local tasks reject
it. Local implementations return their branch and handoff for Codex to
inspect; Codex may push and open a PR only after verifying real commits.

## Install and authentication

Fresh-visitor install (clone, then Codex plugin, then setup) is documented
in the [repository README](../../README.md). The commands below are the
package-local scripts from this directory.

Requirements:

- Node.js 24 or newer (the release gate is pinned to Node 24)
- Git and `worktree-bootstrap`
- Linux with a working `systemd --user` manager, `systemd-run` 244 or
  newer, and unified cgroup v2 for local providers
- the official Grok Build CLI
- `cursor-agent`
- a Cursor Cloud API key
- a Muse/Meta model API key for DSH

From this package directory—the directory containing `package.json` and
`bin/setup.mjs`:

```bash
npm run setup
npm run setup:check
npm test
```

From a repository clone, the same scripts are:

```bash
npm --prefix plugins/codex-co-engineer run setup
npm --prefix plugins/codex-co-engineer run setup:check
```

Setup installs pinned ACPX `0.13.0`, Cursor SDK `1.0.28`, and the cohesive
official DSH `0.1.0-rc.7` composition. It writes a key-free DSH ACP
configuration and owner-only session directory; it does not perform login.
`npm run setup:check` validates the DSH/ACPX composition and CLI, Cursor SDK,
and `worktree-bootstrap` dependencies. It does not install or authenticate
Grok or Cursor Local or validate the Cursor Cloud key. Call `status` after
setup: `local_boundary` verifies the Linux systemd/cgroup prerequisite from
the MCP process's actual environment, and local providers are reported
unavailable when it fails. Release acceptance also launches the MCP through
the manifest's exact environment allowlist before local dispatch is allowed.

Authenticate providers normally so sessions persist across Codex tasks:

```bash
grok login
cursor-agent login
bin/set-model-api-key
```

DSH uses `MODEL_API_KEY`, `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE`, or the
default owner-only `~/.config/codex-co-engineer/model-api-key`. Cursor Cloud
uses `CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, or the existing owner-only
`~/.config/cursor-cloud-control/api-key`. Credentials are never MCP
arguments or task receipts.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CODEX_CO_ENGINEER_STATE_DIR` | Owner-only task-state root. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Owner-only DSH/Muse key file. |
| `CODEX_CO_ENGINEER_DSH_ACP_CONFIG` | Absolute DSH ACP YAML path. |
| `CURSOR_API_KEY_FILE` | Owner-only Cursor Cloud key file. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Grok executable override. |
| `CODEX_CO_ENGINEER_CURSOR_COMMAND` | Cursor Local executable override. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH CLI fallback executable override. |
| `CODEX_CO_ENGINEER_DSH_ACP_COMMAND` | DSH ACP server override. |
| `CODEX_CO_ENGINEER_ACPX_COMMAND` | ACPX executable override. |

The default state directory is `${XDG_STATE_HOME}/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. Task directories are `0700`; files are
`0600`. Prompts, events, logs, and ACP/DSH session data remain owner-only
until the operator removes the exact terminal task state.

## Handoff and cleanup

Terminal managed tasks retain their worktree and branch for inspection. Watch
with `task` (`wait_until: "terminal"` and optional `cursor`), then run:

```bash
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Use the exact lock ID; never delete a lock by hand. Remove only the matching
branch and terminal task-state directory after the receipt is no longer
needed. Direct-mode tasks have no managed worktree. Cursor Cloud agents are
archived after terminal completion where supported; their remote branch or PR
remains for Codex review.

## Examples

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
transport, needs a reply, or hits the advertised MCP pending-call budget.
Routine text deltas do not wake Codex. Disconnecting the waiter does not
stop provider work. Unsolicited stdio callbacks across assistant turns are
not available.

For an implementation, use `role: "implement"`. A local managed task creates
and locks its worktree before the provider starts.

## Troubleshooting

**Which identifier should Codex, npm, and MCP configs use?**
Use `codex-co-engineer`. The human-facing product name is Codex-Co-Engineer.
Skill configs use the lowercase `control-codex-co-engineer-agents` name.

**Why are local providers marked not ready after setup?**
`setup:check` validates pinned CLIs and packages. `status.local_boundary`
validates the MCP process environment. Local dispatch stays fail-closed until
Linux `systemd --user`, `systemd-run` 244+, and unified cgroup v2 are visible
to that process.

**Where should I run setup?**
From this package directory (`plugins/codex-co-engineer` in a clone), or
with `npm --prefix plugins/codex-co-engineer run setup` from the
repository root. See the repository README for the copy/paste Codex
plugin install.

**A managed worktree appeared without a receipt.**
Do not guess or delete it. Inspect `git worktree list` and
`worktree-bootstrap lock inspect`, then clean only an exact identified
task/lock.

**Cursor Cloud returned HTTP 400 for a valid SHA.**
Treat it as a provider visibility failure. Make the commit reachable from an
open PR or the default branch, then retry. Do not replay a prompt that was
already dispatched.

**Can I put API keys in the MCP tool arguments?**
No. Use normal provider login or the owner-only key files. Credentials must
not appear in MCP arguments, prompts, receipts, fixtures, or Git.

## Data handling

Prompts and selected repository content may leave the machine for the chosen
provider. Private repositories are supported when that provider is authorized
to review them. Do not include credentials in prompts or repository files.
Task receipts contain bounded output, provider/session identifiers, branch and
PR information, lifecycle state, and runtime identity; they do not contain
credentials or the full prompt.

## Development

```bash
npm test
node ../../scripts/inspector-preflight.mjs
npm pack . --dry-run --ignore-scripts --offline --json
```

Live provider checks are opt-in host acceptance tests and do not run in
GitHub CI. See the repository release documentation for the exact-tree gate.
