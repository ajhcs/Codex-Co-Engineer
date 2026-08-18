---
name: control-plumbob-agents
description: Use Codex-Co-Engineer to control and monitor target-bound DeepSeek Harness or Grok Build jobs from Codex through compact MCP tools, and to read explicit provider capacity. Use when the user asks to preflight a target, run a bounded task, follow lifecycle progress, inspect redacted logs, cancel a managed job, or route work using usage data.
---

# Codex-Co-Engineer

Use the plugin tools instead of shell commands for dispatch, monitoring, and
cancellation. The stable MCP server identifier is `plumbob-harness-control`.

1. Run `status` when adapter or control-plane state is unknown.
2. Complete the MCP Inspector preflight before dispatching work.
3. Validate one strict target contract for every dispatch.
4. Call `run` with a stable `request_id` and the caller's expected fingerprint.
   Select `kind: "grok_build"` for the official Grok CLI; use only the typed
   Grok fields in its schema, including bounded `json_schema` only with JSON
   output and `include_partial_messages` only with Messages-format streaming.
   The server passes OAuth/session state through Grok's normal user environment
   and does not accept xAI credentials.
5. Use `jobs` with `until: "terminal"` to monitor a long-running job.
6. Use `cancel` only after the user explicitly requests cancellation.
7. Use the explicit read-only `capacity` tool when provider capacity or usage
   affects routing. Select `codex`, `grok`, and/or `dsh`; use `include_usage`
   for optional Codex usage, `grok_session_id` for exact Grok session usage,
   and `dsh_job_id` for an exact DSH receipt.

Configured provider sessions and credentials are standing authorization for
task-scoped calls. Do not ask for a separate data-egress approval. Preserve the
ordinary authorization boundaries for writes, destructive Git, deployments,
and PR creation.

## Target authority

The target is a structured contract, never prompt prose. It must include the
absolute working directory, expected Git root and HEAD, relative allowlisted
paths, operation role, and expected target fingerprint. Resolve real paths and
the effective configuration before starting a worker. A malformed explicit
target is fatal; do not substitute a default workspace. A mismatch between
the caller-supplied and resolved fingerprint is fatal.

The preflight receipt records:

- target fingerprint
- resolved workspace and cwd
- configuration digest
- transport and protocol version
- server identity
- available tools

Review and verify roles are read-only. Their advertised permission modes accept
omitted/default/plan compatibility values and explicit `auto`, while the
runtime normalizes the effective receipt and argv to noninteractive `auto`
inside the hard `read-only` sandbox. Blocked tool calls fail back to the model;
the sandbox still blocks repository writes. Implement roles may omit
permission_mode or must use Grok's noninteractive `auto` mode inside the
bounded workspace sandbox. They must change at least one allowlisted path and
be independently checked after execution. A successful implement process that
does not produce a net allowlisted workspace change is a contract/integrity
failure. Do not reuse a checkout after timeout or cancellation until its taint
and partial changes are inspected.

Sandbox enforcement is owned by the official Grok CLI ([sandbox profiles](https://docs.x.ai/build/features/sandbox)). Use only its built-in
`off`, `workspace`, `devbox`, `read-only`, and `strict` profiles; the connector
passes the selected profile as `--sandbox <profile>` and reports the effective
profile rather than probing or emulating host-specific Landlock/Seatbelt
capabilities. Status verifies `grok --version`; dispatch reports actual
managed-process startup failures if the CLI cannot be spawned.

## Lifecycle and data handling

Long jobs follow `accepted → started → working → completed|failed|cancelled|timeout`.
Expect a bounded heartbeat approximately every 15 seconds. The absolute
deadline cannot be extended by progress. Distinguish client, transport,
protocol, process-startup, tool, timeout, and cancellation failures.

Use cursor-based logs and compact summaries. Never put credentials, full
prompts, protected health information, or unredacted tool payloads in prompts,
tool arguments, logs, or job metadata. The configured model provider is an
external service; follow the repository data-handling policy before sending
private material.

## Capacity and provider boundaries

`status` remains a compact provider-free health check on its normal path.
`capacity` is the sole explicit provider-read surface. It uses the official
Codex App Server rate-limit/credit endpoints and Grok ACP billing/session
usage methods. Results are compact and cached independently per provider and
selector; the default 60-second cache can be bypassed with `refresh: true`.
A failed refresh returns the last observed snapshot as `stale` when available.

Cursor exact per-agent/run usage remains in the separate Cursor Cloud Control
`usage` tool. Personal Cursor plan remaining/reset data is not exposed by that
API and must remain `unknown`/unsupported. DSH/Muse account remaining,
reset-time, and dollar-spend data are also unsupported and must never be
inferred. DSH token counts are exact only when a validated trusted receipt is
available for the requested job.

Capacity uses already configured provider sessions/environment and never
accepts credentials or asks for a per-call egress/authorization prompt.

Grok Build coding dispatch uses its documented direct headless prompt
interface. The ACP `grok agent stdio` interface is used only for the
read-only `capacity` billing and session-usage calls; it is not a coding
dispatch transport. Grok and DSH may use their own internal subagent tools.
Record delegation as supported/requested/effective and keep `effective:
unknown` unless runtime evidence proves it; do not present those
provider-internal children as Codex-native subagents.
Codex remains the chief control-plane agent; external runtimes are bounded
peer workers.

Do not call or advertise a public ACP session surface. The packaged ACPX,
bounded-proxy, and Grok outer-runtime modules are gated experimental
conformance components and are not wired into `run`. Direct Grok dispatch still
uses the official CLI-managed sandbox. The outer experiment supports an
attested auth file, not `XAI_API_KEY`, and still requires real host/systemd
acceptance.
