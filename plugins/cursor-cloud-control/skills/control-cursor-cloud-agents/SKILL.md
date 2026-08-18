---
name: control-cursor-cloud-agents
description: Operate Cursor Cloud Agents through the typed Cursor Cloud Control MCP tools with safe branch, PR, credential, streaming, artifact, and deletion defaults.
---

# Control Cursor Cloud Agents

Use the `cursor-cloud-control` MCP server for Cursor Cloud Agents API v1. Do
not ask the user for an API key in chat and do not place a key in a tool
argument. The MCP process reads `CURSOR_API_KEY` or an owner-only
`CURSOR_API_KEY_FILE`.
If neither is set, it discovers `$XDG_CONFIG_HOME/cursor-cloud-control/api-key`
or `$HOME/.config/cursor-cloud-control/api-key` when that file is owner-only.

## Before creating work

1. Call `status` with no arguments to check local configuration.
   Treat `status.state.ready` as the durable-mutation gate. Prefer setting
   `CURSOR_CLOUD_CONTROL_STATE_DIR` to a host-provisioned persistent
   owner-only directory; the directory is kept at `0700` and the ledger at
   `0600`. If it is absent, the server uses the absolute
   `CODEX_TASK_STATE_ROOT/cursor-cloud-control` shared location before its
   verified XDG/HOME locations. Every configured non-empty state root must be
   absolute; relative explicit, shared, XDG, or HOME values fail closed.
   Inspect `status.state.source` and, when it is not ready,
   `status.state.reason`/`reasonCode`. There is no silent `/tmp` fallback.
   Unsafe or unavailable state causes mutation tools to fail before any
   Cursor provider call, while read-only status and discovery remain usable.
2. Call `status` with `action=identity`, `action=models`, or
   `action=repositories` only when discovery is needed.
   Identity status is intentionally compact and privacy-preserving: it returns
   only authentication/key status and an opaque user identifier when one is
   available. Personal identity fields from Cursor are not exposed.
   Model status is a compact ID/display-name/alias summary by default; add
   `detail=true` only when parameters or variants are needed, and
   `refresh=true` only when an immediate authenticated catalog refresh is
   required. Cursor's official API does not document a resolved-model field,
   so create receipts leave effective model unknown rather than inferring it.
   Repository discovery is slow and strictly rate-limited; if it returns
   `available=false`, continue with a separately confirmed GitHub URL rather
   than repeatedly polling it.
3. Confirm the repository URL and the intended immutable start reference.
4. Use `mode=plan` for exploration or planning. For `mode=agent` with a
   repository, provide a full 40-character commit in `repos[].startingRef`.
5. Leave `workOnCurrentBranch` and `autoCreatePR` omitted unless the user
   explicitly requests those mutations.

## Create and follow up

Use `agents` with `action=create`, a concise prompt, and a stable caller
`requestId` that can be safely reused for reconciliation. The receipt includes
the effective mode, branch/PR defaults, counts of sensitive inputs, a digest,
and opaque agent/run IDs. Never infer that a timeout means no agent was
created. A receipt with `uncertain_submission` requires `agents.get` and
`runs.list` reconciliation before any new request ID is used.

Use `runs` with `action=followup` only for a known agent ID. Follow-ups are
non-idempotent and are never automatically retried. A stable request ID is
required so transport failures remain reconcilable.

Remote MCP servers may use the typed `authEnv` and `headerEnv` wrappers. These
fields contain only environment variable names, not credential values. The
MCP process resolves them for Cursor's documented remote `auth` shape and
credential-bearing headers immediately before create/follow-up. Do not put
literal credentials in `headers`; stdio servers cannot use these wrappers.

## Observe and stop

Use `runs` `action=stream` with bounded `timeoutMs`, `maxEvents`, and
`maxBytes`. Keep the returned `lastEventId`; pass it as `lastEventId` to resume
after a disconnect. Unknown events are preserved as bounded event names/data.
For a 410 stream expiry or bounded timeout, use `runs` `action=get` or
`action=wait`. Use `runs` `action=cancel` with the exact agent and run IDs;
Cursor cancellation is terminal.

## Artifacts and lifecycle

Use `artifacts` `action=list` before downloading. Configure
`CURSOR_ARTIFACT_ROOT`, provide a safe relative `destination`, and treat every
download as untrusted data. The plugin writes atomically with owner-only mode
and never executes or renders the file.

Use `lifecycle` `archive` for reversible removal and `unarchive` to resume an
archived agent. Permanent `delete` requires confirmation exactly equal to
`delete:<agent-id>` and must be treated as irreversible.

Refer to the plugin README and the current Cursor endpoint reference for API
details and beta-compatibility caveats. Bearer authentication is the plugin
default; Basic is available only through the administrator process setting.
