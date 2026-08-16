# Codex-Co-Engineer

Codex-Co-Engineer is the Codex-first MCP control plane for the standalone
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the
official [Grok Build CLI](https://docs.x.ai/build/cli/headless-scripting). It
submits bounded background work, reports a durable lifecycle, and lets Codex
inspect or cancel plugin-owned jobs without opening a shell. Prime Agent and
Prime Lab remain optional adapters.

The public product name is **Codex-Co-Engineer**. The stable plugin and MCP
identifier remains `plumbob-harness-control` so existing Codex configurations
and automation continue to resolve the same server.

## What it provides

The MCP server exposes six compact tools:

- `preflight`: resolve and attest one strict target/configuration
- `status`: control-plane, adapter, credential-presence, and recent-job state
- `runtime`: start or stop the optional loopback DeepSeek UI
- `run`: accept a target-bound DeepSeek, Prime Agent, Prime evaluation, or
  `grok_build` job
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

The plugin has no runtime npm dependencies. The public repository deliberately
does not include a Prime Lab checkout, generated Harness packages, model
registries, session logs, or credentials.

## Configuration

The MCP server receives configuration through its process environment. A
portable example is in [`config/configuration.example.json`](../../config/configuration.example.json).

| Variable | Purpose |
| --- | --- |
| `MODEL_API_KEY` | Provider credential, supplied by the environment or a secret manager. |
| `XAI_API_KEY` | Optional xAI API key for the official Grok CLI; OAuth/session state remains under the normal user home. Never pass it as an MCP argument. |
| `CODEX_CO_ENGINEER_RUNTIME_WORKSPACE` | Runtime workspace containing the configured DSH/Prime adapters. It is not target authority. |
| `CODEX_CO_ENGINEER_ALLOWED_ROOTS` | Optional path-delimited administrator allowlist for local Git roots. |
| `CODEX_CO_ENGINEER_STATE_DIR` | Owner-only state, SQLite ledger, cancellation markers, and redacted logs. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Optional protected file containing only the provider key; keep it outside the clone. |
| `CODEX_CO_ENGINEER_ENABLE_PRIME_AGENT` | Set to `1` only when the optional Prime Agent adapter is intentionally enabled. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Optional direct Grok executable override; defaults to `grok`; passed to `spawn` without a shell. |

Legacy `PLUMBOB_HARNESS_*` names remain compatibility aliases.

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

Review and verify force a read-only target preamble, Grok `plan` permission mode,
and the `read-only` sandbox; automatic approval, `no_plan`, and write-capable
allow rules are rejected. Implement may narrow the default `workspace` sandbox
and permission mode, and may explicitly request `--always-approve`; this is an
implement-only CLI flag, not a separate connector permission mode. The
postflight Git scope verifier remains authoritative for `allowed_paths`.

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
