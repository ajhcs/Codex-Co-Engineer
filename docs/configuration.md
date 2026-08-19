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

Run the following from the installed plugin package directory—the directory
containing `package.json` and `bin/setup.mjs`:

```bash
npm run setup
npm run setup:check
```

In a source checkout, that directory is
`plugins/codex-co-engineer`. For a Codex-managed installation, use the
package path reported by Codex or its plugin manager instead of assuming a
project-relative path.

The package supports Node.js 24 and newer. The exact release gate is pinned
to Node.js 24 so release receipts are reproducible.

Local worker launch additionally requires Linux with a working
`systemd --user` manager, `systemd-run` 244 or newer, and a unified cgroup
v2 hierarchy. The manager-owned transient systemd user service uses
`KillMode=control-group` only to make cancellation reach detached descendants
and let the worker survive the launching client; it is not a sandbox and does
not restrict environment, network, filesystem, credentials, or provider shell
capabilities. Local dispatch fails closed when this boundary cannot be
verified.

`npm run setup:check` validates the DSH/ACPX composition and CLI, Cursor SDK,
and `worktree-bootstrap` dependency. It does not install or authenticate Grok
or Cursor Local or validate the Cursor Cloud key. Call `status` after setup.
Its `local_boundary` object validates the systemd/cgroup prerequisite in the
MCP process's real environment; Grok, Cursor Local, and DSH are forced to
`ready: false` when the boundary is unavailable. Local delegation repeats the
check before creating any workspace or task artifact. The release gate also
tests a server launched with only the MCP manifest's allowlisted environment.

## Task inputs

Repository paths, prompts, roles, deadlines, and workspace/PR intent are
inputs to `delegate`; they are not global policy. `task` accepts optional
`wait_ms` (0-60000) and `cursor` arguments for a bounded wait. The
result includes a compact `progress` snapshot; text deltas are coalesced
and large logs are paged with `more_events`. It does not stream raw
events or emit unsolicited stdio callbacks across assistant turns.

### Local providers

`workspace_mode: "managed"` is the default. It creates one locked
`worktree-bootstrap` worktree and branch per task. Set
`workspace_mode: "direct"` only when direct mutation of the supplied checkout
is intentional. Direct mode does not create a disposable worktree.

### Cursor Cloud

Cursor Cloud requires a provider-accessible Git origin and an exact immutable
commit SHA in `starting_ref`. The SHA must already be pushed; a local branch
name or unpushed work is not an acceptable cloud starting point.
An exact SHA reachable only from a feature branch can remain invisible to
Cursor until the branch is provider-visible through an open pull request or
the default branch. Create the draft PR (or make the commit reachable from
the default branch) before final Cloud acceptance. Surface an HTTP 400 for an
otherwise-valid SHA as a provider visibility failure and fix reachability
before retrying.
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
