# Codex-Co-Engineer

Codex-Co-Engineer is a small stdio MCP supervisor that lets Codex delegate
real review and implementation work to authenticated peer coding agents:

- Grok Build on the local host
- Cursor Local
- Cursor Cloud
- DeepSeek Harness (DSH) with Muse

Codex remains the chief engineer, reviewer, and merge authority.

## Tools

The MCP server exposes five tools:

- `status` — supervisor health, provider readiness, and recent tasks
- `delegate` — start a review or implementation task
- `task` — inspect one task receipt and runtime identity
- `tasks` — list recent task receipts
- `cancel` — stop one owned process group or Cursor Cloud run

`delegate` requires a stable `task_id`, a `provider`, an absolute Git `repo`,
and a `prompt`. Providers are `grok`, `cursor-local`, `cursor-cloud`, and `dsh`.
Roles are `review` and `implement`.

## Execution model

Grok and Cursor Local use ACP as their primary transport. DSH uses the official
rc7 ACP composition through ACPX. Cursor Cloud uses the official Cursor SDK.

Local ACP falls back to the same provider's headless CLI only when ACP fails
before prompt acceptance. Once `prompt_dispatched` is true, Co-Engineer never
replays the task through another transport.

Every local task, including a review, follows the `worktree-bootstrap` invariant:

```text
one task -> one worktree -> one branch -> one writer
```

Reviews inspect an isolated managed worktree, not the caller's checkout.
Cursor Cloud implementations use a provider-managed branch. `create_pr` is false by default; Codex decides when a
task with real commits should open a PR, reviews it, and controls merging.

## Install

Requirements:

- Node.js 24 or newer
- Git and `worktree-bootstrap`
- the official Grok Build CLI for Grok tasks
- `cursor-agent` for Cursor Local tasks
- a Cursor Cloud API key for cloud tasks
- a Muse/Meta model API key for DSH tasks

From the plugin directory:

```bash
npm run setup
npm run setup:check
npm test
```

The setup command installs pinned ACPX `0.13.0`, Cursor SDK `1.0.28`, and the
cohesive official DSH `0.1.0-rc.7` composition. It writes a key-free DSH ACP
configuration beneath the normal user configuration directory.

Authenticate providers normally so sessions persist across Codex tasks:

```bash
grok login
cursor-agent login
```

Store the DSH/Muse key with `bin/set-model-api-key`, or provide
`MODEL_API_KEY`/`CODEX_CO_ENGINEER_MODEL_API_KEY_FILE`. Cursor Cloud uses
`CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, or the existing owner-only
`~/.config/cursor-cloud-control/api-key` file.

Credentials are never MCP arguments and are not written to task receipts.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CODEX_CO_ENGINEER_STATE_DIR` | Owner-only task state root. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Owner-only DSH/Muse key file. |
| `CODEX_CO_ENGINEER_DSH_ACP_CONFIG` | DSH ACP YAML path. |
| `CURSOR_API_KEY_FILE` | Owner-only Cursor Cloud key file. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Grok executable override. |
| `CODEX_CO_ENGINEER_CURSOR_COMMAND` | Cursor Local executable override. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH CLI fallback executable override. |
| `CODEX_CO_ENGINEER_DSH_ACP_COMMAND` | DSH ACP server override. |
| `CODEX_CO_ENGINEER_ACPX_COMMAND` | ACPX executable override. |

The default state directory is `${XDG_STATE_HOME}/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. State and task directories are owner-only.
Prompts are stored separately from public task receipts.

## Example

```json
{
  "task_id": "review-auth-1",
  "provider": "grok",
  "role": "review",
  "repo": "/absolute/path/to/repository",
  "prompt": "Review authentication changes and report actionable findings."
}
```

For an implementation, use `role: "implement"`. Co-Engineer creates and locks
the local task worktree before the provider starts.

## Data handling

Prompts and selected repository content may leave the machine for the chosen
provider. Do not include credentials or material that provider is not allowed
to process. Private repositories are supported when the configured provider is
authorized to review them.

Task receipts contain bounded output, provider/session identifiers, branch and
PR information, lifecycle state, and runtime identity. They do not contain
credentials or the full prompt.

## Development

```bash
npm test
node ../../scripts/inspector-preflight.mjs
npm pack . --dry-run --ignore-scripts --offline --json
```

Live provider checks are host acceptance tests and do not run in GitHub CI.
See the repository release documentation for the exact-tree gate.
