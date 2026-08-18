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

This release exposes only the local `status` tool. The typed `run`/`runs`
foundation remains packaged for review, but is not in the MCP catalog;
direct calls fail with `foundation_not_exposed` before they can spawn or adopt
Cursor. Do not treat a passing sandbox preflight as host acceptance.

## Before local diagnostics

1. Call `status` with `action: "local"` and confirm the selected executable is
   a real `cursor-agent`/`cursor-local-agent` binary. The generic `agent`
   alias is rejected so an existing Grok `agent` alias cannot be confused with
   Cursor.
2. Call `status` with `action: "auth"` when authentication needs checking. The
   response is a compact state/method projection and never includes account
   identity or credential values.
3. Call `status` with `action: "permissions"` for the administrator-owned
   CLI config. Runs fail closed unless the config is owner-only, schema v1,
   non-unrestricted, and denies all MCP tools. A future read-only execution
   profile additionally requires explicit `Write(**)` and `Shell(*)` deny
   rules; current runs remain deferred regardless of configuration.
4. Use only an absolute workspace that the administrator configured in
   `CURSOR_LOCAL_CLI_WORKSPACE_ROOTS`. Never broaden that allowlist in a tool
   argument.

Status also reports the administrator-pinned `CURSOR_LOCAL_CLI_SHA256` and the
native `bwrap` preflight configured by `CURSOR_LOCAL_CLI_SANDBOX_BIN` plus
`CURSOR_LOCAL_CLI_SANDBOX_SHA256`. Digest drift or an unavailable preflight is
not recoverable by a tool caller.

The local process receives only a sanitized environment. A local API key may
be supplied through the administrator-only `CURSOR_LOCAL_CLI_API_KEY`
environment value; it is never accepted as a tool argument and is not taken
from the Cloud credential file automatically.

## Deferred modes

The foundation `run` contract requires an explicit `mode`, but it is not
advertised by this release:

- `read_only` is specified to use Cursor print/Ask mode and never pass
  `--force` or `--yolo`; it is not enabled in this release.
- `implement` is specified to require explicit `--force` and an isolated
  worktree under the configured local CLI home; it is not enabled in this
  release.

The deferred contract retains bounded `timeoutMs`, `waitMs`, `maxEvents`, and
`maxBytes` fields. `stream-json` events are parsed as bounded NDJSON in the
foundation code, but no provider process is started until a future host
acceptance gate proves the complete boundary.

Acceptance is still blocked on a real Cursor process test: the prototype
Bubblewrap root bind is not by itself a confidentiality or network boundary,
and future lifecycle tests must cover resource limits, TERM-to-KILL
escalation, process-group ownership, and restart recovery. A digest pin alone
is not an execution attestation.

## Authentication and installation

The host owner must install and authenticate Cursor CLI separately. Do not run
the official installer unchanged when another tool owns `~/.local/bin/agent`:
the installer replaces both `agent` and `cursor-agent` links. Keep a dedicated
Cursor executable path and configure `CURSOR_LOCAL_CLI_BIN` explicitly.

The documented browser flow is `cursor-agent login` and `cursor-agent status`;
automation may use the local-only API-key environment value. Never use
`--api-key`, because it exposes the key in process arguments. Do not invoke
`agent update` through this MCP surface; binary upgrades require owner review,
digest capture, and a fresh local status check.

## Receipts and cancellation

The future lifecycle is `accepted -> started -> working -> terminal`, with
terminal states `succeeded`, `failed`, `cancelled`, `timed_out`,
`transport_lost`, `environment_blocked`, `binary_drift`, or
`workspace_changed`. Cancellation will signal only a process group owned by
the current MCP server; an orphaned process is not guessed at or signalled
after a server restart.

Local receipts contain bounded operational metadata, digests, worktree
identity, and compact logs. They do not contain prompts, raw transcripts,
credentials, Cloud IDs, or entries in the Cloud submission ledger.
