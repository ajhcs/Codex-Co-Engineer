---
name: control-plumbob-agents
description: Use Codex-Co-Engineer to control and monitor target-bound DeepSeek Harness or Grok Build jobs from Codex through compact MCP tools. Use when the user asks to preflight a target, run a bounded task, follow lifecycle progress, inspect redacted logs, or cancel a managed job.
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

Review and verify roles are read-only. Their advertised permission modes are
limited to `default`/`plan` and the runtime forces `plan`; implement roles may
omit permission_mode or must use Grok's noninteractive `auto` mode inside the
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

Grok Build uses its documented headless prompt interface. The ACP
`grok agent stdio` interface is intentionally deferred until a proxy can
preserve the same target and lifecycle guarantees. Do not present DeepSeek
Harness or Grok Build as Codex subagents.
Codex remains the chief control-plane agent; external runtimes are bounded
peer workers.
