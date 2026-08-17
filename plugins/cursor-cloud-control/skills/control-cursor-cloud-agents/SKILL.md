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
2. Call `status` with `action=identity`, `action=models`, or
   `action=repositories` only when discovery is needed.
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
