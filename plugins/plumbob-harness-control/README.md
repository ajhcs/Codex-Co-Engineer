# Codex-Co-Engineer

Codex-Co-Engineer is the Codex-first MCP control plane for the standalone
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the
official [Grok Build CLI](https://docs.x.ai/build/cli/headless-scripting). It
submits bounded background work, reports a durable lifecycle, and lets Codex
inspect or cancel plugin-owned jobs without opening a shell. Version 2 removes
all Prime Intellect adapters and runtime dependencies; the only worker kinds
are `deepseek_agent` and `grok_build`.

The public product name is **Codex-Co-Engineer**. The stable plugin and MCP
identifier remains `plumbob-harness-control` so existing Codex configurations
and automation continue to resolve the same server.

## What it provides

The MCP server exposes six compact tools:

- `preflight`: resolve and attest one strict target/configuration
- `status`: control-plane, adapter, credential-presence, and recent-job state
- `runtime`: start or stop the optional loopback DeepSeek UI
- `run`: accept a target-bound `deepseek_agent` or `grok_build` job
- `jobs`: list, inspect, wait for, or cursor-page a managed job
- `cancel`: request cancellation of one plugin-owned job

The control plane stores only bounded metadata and redacted logs in an
owner-only state directory. It does not accept arbitrary shell commands,
ports, provider URLs, or environment maps as tool arguments.

## Install

1. Install Node.js 24 or newer.
2. Install and authenticate the official Grok Build CLI separately when using
   `grok_build`, following [xAI's headless CLI instructions](https://docs.x.ai/build/cli/headless-scripting).
   Use `grok login` (or `grok login --device-auth` on a remote host), or
   provide `XAI_API_KEY` through the MCP server process environment.
   Codex-Co-Engineer never installs the CLI, opens a browser, or accepts
   credentials as tool arguments.
3. Install and configure DeepSeek Harness separately when using DeepSeek jobs.
4. Clone this repository and register
   `plugins/plumbob-harness-control` as a local Codex plugin.
5. Set the runtime environment described below before Codex starts the MCP
   server.

The plugin has no runtime npm dependencies. DeepSeek Harness and Grok Build are
installed and authenticated independently. The public repository deliberately
does not include generated Harness profiles, session logs, or credentials.

## Configuration

The MCP server receives configuration through its process environment. A
portable example is in [`config/configuration.example.json`](../../config/configuration.example.json).

| Variable | Purpose |
| --- | --- |
| `MODEL_API_KEY` | Provider credential, supplied by the environment or a secret manager. |
| `XAI_API_KEY` | Optional xAI API key for the official Grok CLI; OAuth/session state remains under the normal user home. Never pass it as an MCP argument. |
| `DSH_HOME` | Optional DeepSeek Harness profile home. When omitted, DSH uses its normal per-user default. |
| `CODEX_CO_ENGINEER_RUNTIME_WORKSPACE` | Default Git workspace selected only by an explicit `target_context.mode: "default"`; it is not prompt-derived authority. |
| `CODEX_CO_ENGINEER_ALLOWED_ROOTS` | Optional path-delimited administrator allowlist for local Git roots. |
| `CODEX_CO_ENGINEER_STATE_DIR` | Owner-only state, SQLite ledger, cancellation markers, and redacted logs. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Optional protected file containing only the provider key; keep it outside the clone. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | Optional DeepSeek Harness executable override; defaults to `dsh`; passed to `spawn` without a shell. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Optional direct Grok executable override; defaults to `grok`; passed to `spawn` without a shell. |

Legacy `PLUMBOB_HARNESS_*` names remain compatibility aliases.

## MCP tool calls

The six MCP tools remain stable; removing Prime narrows only the accepted
worker kinds and backend-specific fields.

- `preflight` is read-only. Supply `schema_version`, `target_context`, and the
  caller-computed `expected_target_fingerprint`. Set `kind` to `preflight`,
  `deepseek_agent`, or `grok_build`. A Grok preflight may include the same typed
  Grok options accepted by `run`.
- `status` accepts optional `recent_limit` (`0`–`15`) and `diagnostics`. Recent
  jobs and `jobs` action `list` return bounded summaries only; use `jobs`
  action `get` for one job's effective configuration and lifecycle history.
  The default path performs no provider-auth request. `diagnostics: true` may
  run the official read-only `grok models` authentication probe.
- `runtime` accepts `action: "start"` with the versioned target contract and a
  bounded timeout, or `action: "stop"` to stop only the plugin-owned DeepSeek
  UI job.
- `run` requires `schema_version`, `kind`, `request_id`, `prompt`,
  `target_context`, and `expected_target_fingerprint`. `kind` is exactly
  `deepseek_agent` or `grok_build`; unknown and removed kinds fail closed.
- `jobs` accepts `action: "list"`, `"get"`, `"wait"`, or `"logs"`. Waits are
  bounded to 55 seconds per call and log reads use byte cursors.
- `cancel` requires one exact `job_id` and signals only a process whose
  ownership the plugin can prove.

Minimal DeepSeek dispatch after a successful preflight:

```json
{
  "schema_version": "codex-co-engineer.config.v1",
  "kind": "deepseek_agent",
  "request_id": "review-example-001",
  "prompt": "Review the requested files and report findings.",
  "target_context": {
    "schema_version": "codex-co-engineer.target.v1",
    "mode": "explicit",
    "working_directory": "/absolute/path/to/checkout",
    "expected_git_root": "/absolute/path/to/checkout",
    "expected_head": "0123456789abcdef0123456789abcdef01234567",
    "allowed_paths": ["src", "tests"],
    "role": "review"
  },
  "expected_target_fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

For Grok, change `kind` to `grok_build` and optionally add typed fields such as
`model`, `reasoning_effort`, `max_turns`, `sandbox_profile`, `allowed_tools`,
or the structured-output controls described below. Credentials, executable
paths, raw arguments, shell commands, environment maps, and provider URLs are
never accepted in a tool call.

Prefer a native per-user secret store. If a file is necessary, place it under
the platform's user configuration directory, restrict it to the current user,
and never put it under this repository or a Windows-mounted shared directory.

## Target contract

Every operation that dispatches work must resolve exactly one target before a
worker starts. The target contract contains:

- absolute `working_directory` and `expected_git_root`
- expected Git `HEAD`
- relative `allowed_paths`
- `role`: `review`, `verify`, or `implement`
- the caller's expected target fingerprint

The connector canonicalizes the resolved target and configuration, computes
digests, and fails closed on a mismatch. An explicit malformed target is an
error; it never falls back to a default workspace. A prompt containing `cd`
is descriptive text, not target authority. See
[`docs/target-contract.md`](../../docs/target-contract.md) and
[`examples/target-context.json`](../../examples/target-context.json).

Review and verify roles are read-only. Implement roles are limited to their
allowlist and must produce a recoverable patch only after scope verification.
Never reuse a checkout marked tainted after timeout or cancellation until it
has been inspected independently.

## Preflight and lifecycle

Run the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
against the exact server command before dispatch. The preflight receipt must
include the target fingerprint, resolved workspace and cwd, configuration
digest, transport, protocol version, server identity, and available tools.
The required shape and acceptance checks are documented in
[`docs/preflight-inspector.md`](../../docs/preflight-inspector.md).

Long-running jobs expose one lifecycle:

`accepted → started → working → completed | failed | cancelled | timeout`

Progress is bounded by an absolute deadline. The runner emits a heartbeat at
approximately 15-second intervals (or sooner when state changes), including
the phase, elapsed time, deadline, and last activity timestamp. Progress never
extends the deadline. Client retries must reuse the same `request_id` and
configuration fingerprint so uncertain transport cannot duplicate dispatch.

## Data handling

Prompts, repository excerpts, tool results, and attachments sent to a
configured external model provider leave the local machine. Do not submit
credentials, private keys, protected health information, production-only
material, or unredacted customer data. Logs and job records must contain
digests, bounded summaries, and redacted diagnostics—not full prompts,
credentials, or payloads. Read [`docs/data-handling.md`](../../docs/data-handling.md)
before enabling an external provider.

## Grok Build controls

`grok_build` invokes `grok --no-auto-update -p <prompt> --cwd <target>
--output-format streaming-json` directly by default; the official `--single`
alias is equivalent to `-p`. Typed fields cover model,
output format, UUID session selection, resume/continue/fork, reasoning effort,
max turns, built-in sandbox profile, permission mode, rules, tool allow/deny lists,
repeatable permission rules, automatic approval, bounded JSON Schema structured
output, verbatim prompts, partial message streaming, and safe feature switches.
Prompt text is one argv value; raw arguments, shell strings, executable paths,
environment maps, provider URLs, prompt files, and system-prompt replacement
are not exposed.

`json_schema` accepts a JSON Schema object or boolean, is capped at 16 KiB after
serialization, and forces `output_format: "json"`. `include_partial_messages`
is accepted only with `streaming-messages-json`; `verbatim` is a boolean prompt
transport control.

Permission mode is role-dependent in the advertised MCP schema as well as at
runtime. Review and verify accept only `default` or `plan`, then force a
read-only target preamble, Grok `plan` permission mode, and the `read-only`
sandbox; automatic approval, `no_plan`, and write-capable allow rules are
rejected. Headless implement runs omit the field or use Grok's noninteractive
`auto` permission mode inside the bounded `workspace` sandbox because
interactive approval modes can cancel edits when no approval channel exists.
An implement run that exits without changing an allowed path is reported as a
contract/integrity failure, not a generic provider process failure. The
postflight Git scope verifier remains authoritative for `allowed_paths`.

Sandbox enforcement remains owned by the official Grok CLI ([built-in sandbox
profiles](https://docs.x.ai/build/features/sandbox)). The connector accepts
only Grok's built-in `off`, `workspace`, `devbox`, `read-only`, and
`strict` profiles, records the normalized profile in the effective
configuration, and passes it as the exact `--sandbox <profile>` argument. The
status summary reports `managed_by: "grok_cli"` and
`enforcement: "cli_managed"`; it does not guess at host-specific Landlock or
Seatbelt capabilities and does not attempt to emulate them. The connector
still verifies the configured executable with `grok --version` and records
actual process-start failures from the managed spawn.

The official CLI also provides ACP through `grok agent stdio`. This release
uses the documented headless prompt interface instead of inventing an ACP
JSON-RPC proxy; ACP is reserved for a future integration that can preserve the
same target, deadline, and scope guarantees. Prompt-file/prompt-JSON input,
system-prompt overrides, debug files, leader sockets, restore/worktree/ref
controls, login/update commands, interactive UI commands, and agent/agents
bundle selection are intentionally outside this release: each would bypass
the target-bound prompt contract, lifecycle ownership, or credential boundary.
The connector keeps a fixed bounded streaming parser, so unbounded/raw output
schemas and provider-specific output contracts are not accepted.

## Development

```bash
cd plugins/plumbob-harness-control
npm test
```

From the repository root, the release inventory check is:

```bash
node scripts/validate-release.mjs
```

Do not run provider-backed jobs in CI. Use fixture runners and local temporary
Git repositories for target, lifecycle, timeout, cancellation, and redaction
tests. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and
[`SECURITY.md`](../../SECURITY.md).
