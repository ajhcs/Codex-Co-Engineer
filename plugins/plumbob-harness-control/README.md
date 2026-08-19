# Codex-Co-Engineer

Codex-Co-Engineer is a small stdio MCP supervisor that lets Codex delegate
real review and implementation work to trusted, authenticated peer coding
agents:

- Grok Build on the local host
- Cursor Local
- Cursor Cloud
- DeepSeek Harness (DSH) with Muse

Codex remains the chief engineer, reviewer, and merge authority. Providers
retain their normal shell, coding, and dependency-installation capabilities.

## Tools

The MCP server exposes five tools:

- `status` — supervisor health, provider readiness, and recent task state
- `delegate` — start a review or implementation task
- `task` — inspect one task receipt and runtime identity
- `tasks` — list recent task receipts
- `cancel` — stop one owned local process group or Cursor Cloud run

`delegate` requires a stable `task_id`, a provider, an absolute Git
repository root, and a prompt. Providers are `grok`, `cursor-local`,
`cursor-cloud`, and `dsh`; roles are `review` and `implement`.

## Execution model

Grok and Cursor Local use ACP as their primary transport. DSH uses the
official rc.7 ACP composition through ACPX. Cursor Cloud uses the official
Cursor SDK. A local CLI fallback is allowed only when ACP fails before prompt
dispatch. Once a prompt is dispatched, Co-Engineer never replays it through
another transport. ACPX does not provide an authoritative prompt-sent
acknowledgement, so DSH receipts use `dispatch_uncertain` after ACPX spawns and
never fall back to CLI from that point.

Cursor Local and DSH's official fallback CLIs take the prompt positionally,
so it may be visible to other processes running as the same Unix user during
that fallback. Grok fallback uses an owner-only prompt file.

Each local worker runs in a manager-owned transient `systemd --user` service
with `KillMode=control-group` so cancellation reaches detached descendants and
the worker survives the launching client. This
is only a lifecycle/cleanup boundary, not a provider sandbox: the normal
environment, credentials, network, filesystem, and shell capabilities are
inherited unchanged. Local dispatch fails closed when Linux systemd or unified
cgroup v2 is unavailable. Cursor Cloud uses the provider's remote runtime.

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

Requirements:

- Node.js 24 or newer (the release gate is pinned to Node 24)
- Git and `worktree-bootstrap`
- Linux with a working `systemd --user` manager, `systemd-run` 244 or
  newer, and unified cgroup v2 for local providers
- the official Grok Build CLI
- `cursor-agent`
- a Cursor Cloud API key
- a Muse/Meta model API key for DSH

From the installed plugin package directory—the directory containing
`package.json` and `bin/setup.mjs`:

```bash
npm run setup
npm run setup:check
npm test
```

In a source checkout, that directory is
`plugins/plumbob-harness-control`. For a Codex-managed installation, use the
package path reported by Codex or its plugin manager instead of assuming a
project-relative path.

Setup installs pinned ACPX `0.13.0`, Cursor SDK `1.0.28`, and the cohesive
official DSH `0.1.0-rc.7` composition. It writes a key-free DSH ACP
configuration and owner-only session directory; it does not perform login.
`npm run setup:check` validates the DSH/ACPX composition and CLI, Cursor SDK,
and `worktree-bootstrap` dependencies. It does not install or authenticate
Grok or Cursor Local, validate their CLIs, validate the Cursor Cloud key, or
validate the Linux systemd/cgroup process boundary. Call the `status` tool
after setup to check provider readiness; release and live host acceptance
perform the process-boundary check before local dispatch.

Authenticate providers normally so sessions persist across Codex tasks:

```bash
grok login
cursor-agent login
bin/set-model-api-key
```

DSH uses `MODEL_API_KEY`,
`CODEX_CO_ENGINEER_MODEL_API_KEY_FILE`, or the default owner-only
`~/.config/codex-co-engineer/model-api-key`. Cursor Cloud uses
`CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, or the existing owner-only
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

The default state directory is
`${XDG_STATE_HOME}/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. Task directories are `0700`; files are
`0600`. Prompts, events, logs, and ACP/DSH session data remain owner-only
until the operator removes the exact terminal task state.

## Handoff and cleanup

Terminal managed tasks retain their worktree and branch for inspection. Poll
`task`, then run:

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

## Example

```json
{
  "task_id": "review-auth-1",
  "provider": "grok",
  "role": "review",
  "repo": "/absolute/path/to/repository",
  "workspace_mode": "managed",
  "prompt": "Review authentication changes and report actionable findings."
}
```

For an implementation, use `role: "implement"`. A local managed task creates
and locks its worktree before the provider starts.

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
