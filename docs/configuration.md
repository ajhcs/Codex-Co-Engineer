# Configuration

Codex-Co-Engineer has no project policy file. Provider authentication is
normal persistent login/session state or an owner-only key file. The setup
command installs the pinned local composition and creates the default DSH
configuration; it never performs login on the user's behalf.

## Host environment

| Variable | Purpose |
| --- | --- |
| `CODEX_CO_ENGINEER_STATE_DIR` | Absolute owner-only task-state root. Defaults to the XDG state directory. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Grok CLI executable. Defaults to `grok`. |
| `CODEX_CO_ENGINEER_CURSOR_COMMAND` | Cursor Local executable. Defaults to `cursor-agent`. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH CLI fallback executable. Defaults to `dsh`. |
| `CODEX_CO_ENGINEER_ACPX_COMMAND` | ACPX executable used for DSH. Defaults to `acpx`. |
| `CODEX_CO_ENGINEER_DSH_ACP_COMMAND` | DSH ACP adapter executable. Defaults to `dsh-acp-demo`. |
| `CODEX_CO_ENGINEER_DSH_ACP_CONFIG` | Absolute DSH ACP YAML path. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Owner-only Muse/DSH model key file. |
| `CURSOR_API_KEY_FILE` | Owner-only Cursor Cloud API key file. |
| `MODEL_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY` | Optional process-level provider credentials. |

The default DSH configuration is
`~/.config/codex-co-engineer/dsh-acp.yml`; its model key defaults to
`~/.config/codex-co-engineer/model-api-key`. Cursor Cloud also recognizes
the existing owner-only `~/.config/cursor-cloud-control/api-key`.

Run the following from the installed plugin directory:

```bash
npm run setup
npm run setup:check
```

The package supports Node.js 24 and newer. The exact release gate is pinned
to Node.js 24 so release receipts are reproducible.

Local worker launch additionally requires Linux with a working
`systemd --user` manager, `systemd-run` 244 or newer, and a unified cgroup
v2 hierarchy. The transient systemd scope uses
`KillMode=control-group` only to make cancellation reach detached
descendants; it is not a sandbox and does not restrict environment, network,
filesystem, credentials, or provider shell capabilities. Local dispatch fails
closed when this boundary cannot be verified.

`npm run setup:check` validates the provider CLIs, ACPX/DSH composition,
Cursor SDK, and `worktree-bootstrap` dependency. It does not prove the
systemd/cgroup prerequisite. The release gate and live host acceptance must
validate that Linux process boundary before local agents run.

## Task inputs

Repository paths, prompts, roles, deadlines, and workspace/PR intent are
inputs to `delegate`; they are not global policy.

### Local providers

`workspace_mode: "managed"` is the default. It creates one locked
`worktree-bootstrap` worktree and branch per task. Set
`workspace_mode: "direct"` only when direct mutation of the supplied checkout
is intentional. Direct mode does not create a disposable worktree.

### Cursor Cloud

Cursor Cloud requires a provider-accessible Git origin and an exact immutable
commit SHA in `starting_ref`. The SHA must already be pushed; a local branch
name or unpushed work is not an acceptable cloud starting point.
`create_pr` is supported only for Cursor Cloud and defaults to `false`.
Local tasks reject `create_pr`; Codex inspects their handoff and commits
before deciding whether to push or open a PR.

## Authentication

Authenticate Grok and Cursor Local with their normal CLIs. DSH uses the
owner-only model key, and Cursor Cloud uses its normal API key. Credentials
must not be placed in MCP arguments, prompts, receipts, fixtures, or Git.
Provider login state persists in the provider's normal user configuration
between Codex tasks.

## State and retention

Task records, prompts, events, worker logs, runtime identities, and session
data live under the owner-only state root
`$XDG_STATE_HOME/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. Task directories are `0700`; files are
`0600`. Terminal task state is retained until the operator removes that
exact task directory after handoff and review. Never delete the whole state
root or another task's state as cleanup.
