---
name: control-cursor-local-cli
description: Operate the local Cursor CLI through the separate cursor-local-control MCP server with strict workspace, permission, process, and receipt boundaries.
---

# Control Cursor Local CLI

Use the `cursor-local-control` MCP server for the locally installed Cursor
Agent CLI. Do not use the `cursor-cloud-control` server's `agents` or `runs`
tools for local work, and do not pass Cloud `agentId` or `runId` values to the
local server. Local IDs begin with `lrun-`; local state and receipts live in a
different owner-only ledger.
The local server wire identity is `cursor-local-control` `0.2.0`, shipped with
Cursor Cloud Control `0.4.0`; keep the cloud and local ledgers separate.

The public/default catalog exposes only the local `status` tool. An
administrator may explicitly set `CURSOR_LOCAL_CLI_ENABLE_HOST_TRUSTED_RUNS=1`
to expose the typed `run`/`runs` tools. Every `run` call must then include
`execution_profile: "host_trusted"`. This profile invokes the selected
`cursor-agent` directly as the MCP process user; it does not invoke Bubblewrap
and is not a confidentiality, network, or filesystem sandbox.

## Before local diagnostics

1. Call `status` with `action: "local"` and confirm the selected executable is
   a real `cursor-agent`/`cursor-local-agent` binary. The generic `agent`
   alias is rejected so an existing Grok `agent` alias cannot be confused with
   Cursor.
2. Call `status` with `action: "auth"` when authentication needs checking. The
   response is a compact state/method projection and never includes account
   identity or credential values.
3. Call `status` with `action: "permissions"` for the administrator-owned
   CLI config. The host-trusted profile inherits Cursor's normal CLI approval
   configuration; the control plane does not claim that configuration is a
   sandbox or silently widen it. Host-trusted `read_only` additionally
   requires explicit `Write(**)`, `Shell(*)`, and `Mcp(*:*)` deny rules.
4. Use only an absolute workspace that the administrator configured in
   `CURSOR_LOCAL_CLI_WORKSPACE_ROOTS`. Never broaden that allowlist in a tool
   argument.

Status reports the optional administrator-pinned `CURSOR_LOCAL_CLI_SHA256` and
the provider-free native `bwrap` preflight configured by
`CURSOR_LOCAL_CLI_SANDBOX_BIN` plus `CURSOR_LOCAL_CLI_SANDBOX_SHA256`. The
host-trusted run profile does not use that preflight; an unavailable or
unattested bwrap binary never becomes a reason to claim a stronger boundary.

The local process receives only a sanitized environment. A local API key may
be supplied through the administrator-only `CURSOR_LOCAL_CLI_API_KEY`
environment value; it is never accepted as a tool argument and is not taken
from the Cloud credential file automatically.

## Host-trusted execution

Host-trusted execution is an administrator opt-in, not the public default:

```text
CURSOR_LOCAL_CLI_ENABLE_HOST_TRUSTED_RUNS=1
```

After activation, `run` requires an absolute allowlisted workspace, a prompt,
an explicit task `mode`, and `execution_profile: "host_trusted"`:

```json
{
  "workspace": "/absolute/allowlisted/checkout",
  "prompt": "Review the current implementation and report findings.",
  "requestId": "local-review-20260819-0001",
  "mode": "read_only",
  "execution_profile": "host_trusted"
}
```

- `read_only` uses Cursor print/Ask mode and never passes `--force` or
  `--yolo`.
- `implement` is write-capable, requires the explicit `implement` mode, uses
  Cursor's `--force` flag for noninteractive execution, and uses an isolated
  Cursor worktree by default.
- Both modes use the direct `cursor-agent` executable with Cursor's provider
  sandbox disabled. The receipt says `outerSandbox: "none"`,
  `providerSandbox: "disabled"`, and `authority: "mcp_process_user"`.
- The workspace allowlist and bounded timeout/event/log limits remain control
  plane limits. They do not prevent a host-trusted Cursor process from using
  any filesystem or network authority available to its OS user.

The contract retains bounded `timeoutMs`, `waitMs`, `maxEvents`, and `maxBytes`
fields. `stream-json` events are parsed as bounded NDJSON. Cancellation and
timeout send `SIGTERM` to the owned process group, then escalate to `SIGKILL`
after the grace interval when the group remains alive.

The retained Bubblewrap foundation remains separate and unwired. It must not
be described as the boundary for host-trusted runs. A real Cursor process
acceptance check is still required before treating a particular host setup as
operational, including Cursor project-state/trust setup and process cleanup.

## Authentication and installation

The host owner must install and authenticate Cursor CLI separately. Do not run
the official installer unchanged when another tool owns `~/.local/bin/agent`:
the installer replaces both `agent` and `cursor-agent` links. Keep a dedicated
Cursor executable path and configure `CURSOR_LOCAL_CLI_BIN` explicitly.

The documented browser flow is `cursor-agent login` and `cursor-agent status`;
host-trusted execution can use the administrator-selected local Cursor home,
or the MCP process `HOME` when no separate home is configured. Automation may
use the local-only API-key environment value. Never use
`--api-key`, because it exposes the key in process arguments. Do not invoke
`agent update` through this MCP surface; binary upgrades require owner review,
digest capture, and a fresh local status check.

## Receipts and cancellation

The lifecycle is `accepted -> started -> working -> terminal`, with
terminal states `succeeded`, `failed`, `cancelled`, `timed_out`,
`transport_lost`, `environment_blocked`, `binary_drift`, or
`workspace_changed`. Cancellation signals only a process group whose exact PID
start token still matches the durable launch receipt. After an MCP server
restart, reconciliation may terminate a surviving child only when that same
durable token proves it is the originally launched process; a missing or
mismatched token is treated as transport loss and is never signalled.

Local receipts contain bounded operational metadata, digests, worktree
identity, explicit host-trusted boundary/authority fields, and compact logs.
They do not contain prompts, raw transcripts, credentials, Cloud IDs, or
entries in the Cloud submission ledger. Host-trusted receipts deliberately
report `workspaceChanged: null` because this direct process has no outer
filesystem observer; a successful exit is not a proof that the workspace was
unchanged.
