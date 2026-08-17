# Codex-Co-Engineer

Codex-Co-Engineer is a public, Codex-first control plane for the standalone
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the
official [Grok Build CLI](https://docs.x.ai/build/cli/headless-scripting). Codex is
the chief engineer and operator; these are bounded peer workers.
The worker kinds are exactly `deepseek_agent` and `grok_build`; version 2 has no
Prime Intellect integration or runtime dependency.

The stable plugin and MCP identifier is `plumbob-harness-control`. The public
product name is **Codex-Co-Engineer**. Keeping the technical identifier stable
allows existing Codex configurations to migrate without a server-name break.

## Release contents

```text
plugins/plumbob-harness-control/   Codex plugin, MCP facade, skill, and tests
plugins/cursor-cloud-control/      Typed Cursor Cloud Agents API v1 control plane
config/                            non-secret configuration examples
docs/                              target, preflight, data, and release policy
examples/                          redacted contract and receipt examples
scripts/                           dependency-free release validation
.github/workflows/                 CI and package checks
```

The public tree does not contain generated DSH packages, model registries,
session logs, provider credentials, or personal Codex configuration. Keep
those in a separate private directory or secret manager. The root ignore
policy is intentionally fail-closed for `Secrets/`, local state, and generated
runtimes.

## Quick start

1. Install Node.js 24 or newer.
2. Install and configure DeepSeek Harness using its upstream documentation when
   using DeepSeek jobs. For Grok Build, install the official CLI and
   authenticate it separately (`grok login` or device auth); the MCP server
   never automates installation/login or accepts xAI credentials as tool
   arguments.
3. Clone this repository and register
   `plugins/plumbob-harness-control` as a local Codex plugin.
4. Set the provider credential and runtime workspace in the MCP server
   environment. A template is in
   [`config/configuration.example.json`](config/configuration.example.json).
5. Run the MCP Inspector preflight for the exact target before dispatching a
   job.

Example environment (replace placeholders locally; never commit the values):

```bash
export MODEL_API_KEY='provided-by-your-secret-manager'
export XAI_API_KEY='optional-xai-key-for-grok-cli'
export DSH_HOME='/absolute/path/to/dsh-profile-home'
export CODEX_CO_ENGINEER_RUNTIME_WORKSPACE='/absolute/path/to/default/git-workspace'
export CODEX_CO_ENGINEER_ALLOWED_ROOTS='/absolute/path/to/checkouts'
export CODEX_CO_ENGINEER_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codex-co-engineer"
```

`CODEX_CO_ENGINEER_RUNTIME_WORKSPACE` is used only when an explicit target
contract selects `mode: "default"`. It is not prompt-derived target authority.
A job must carry one strict target contract with an absolute cwd,
expected Git root and HEAD, allowed paths, role, and caller-supplied expected
fingerprint. Prompt-level `cd` is never authoritative, and an invalid
explicit target never falls back to a default workspace.

For Grok Build, the server invokes the configured `grok` executable directly
(`CODEX_CO_ENGINEER_GROK_COMMAND` may select an administrator-approved binary)
with typed model, session, reasoning, sandbox, permission, tool, and rules
options. Headless prompts use `-p` (the official `--single` alias). It defaults to
`--no-auto-update` and `streaming-json`; raw argv,
shell strings, environment maps, prompt-file/prompt-JSON input,
restore/worktree/ref controls, debug files, leader sockets, login/update
commands, agent bundles, raw output schemas, and system-prompt overrides are
not exposed. Bounded typed `json_schema` input is supported for structured JSON
output; ACP (`grok agent stdio`) is documented but intentionally deferred until
it can preserve the same target and lifecycle guarantees.

## Co-Engineer tools

The plugin exposes six stable MCP tools:

- `preflight` attests the target, configuration digest, protocol, and tool set.
- `status` reports DeepSeek, Grok, credential-presence, UI, and recent-job state.
- `runtime` starts or stops the optional plugin-owned loopback DeepSeek UI.
- `run` dispatches exactly `deepseek_agent` or `grok_build`.
- `jobs` lists, inspects, waits for, or cursor-pages managed jobs.
- `cancel` cancels one exact plugin-owned job.

Every dispatch requires the versioned target contract, caller-supplied target
fingerprint, stable request ID, and bounded timeout. See the
[plugin README](plugins/plumbob-harness-control/README.md#mcp-tool-calls) for
the complete call shapes and examples.

## Reliability contract

Before execution, the MCP Inspector receipt must include:

- target fingerprint
- resolved workspace and cwd
- configuration digest
- transport and protocol version
- server identity
- available tools

Long-running jobs expose exactly one lifecycle:

`accepted → started → working → completed | failed | cancelled | timeout`

Progress notifications are bounded heartbeats approximately every 15 seconds.
An absolute deadline cannot be extended by progress. Client retries reuse a
stable request ID and fingerprint, preventing duplicate dispatch when a
transport is uncertain. Timeout, cancellation, protocol, tool, process-startup,
and client failures remain distinct.

See:

- [`plugins/plumbob-harness-control/README.md`](plugins/plumbob-harness-control/README.md)
- [`plugins/cursor-cloud-control/README.md`](plugins/cursor-cloud-control/README.md)
- [`docs/target-contract.md`](docs/target-contract.md)
- [`docs/preflight-inspector.md`](docs/preflight-inspector.md)
- [`docs/configuration.md`](docs/configuration.md)
- [`docs/data-handling.md`](docs/data-handling.md)
- [`SECURITY.md`](SECURITY.md)

## Development

```bash
cd plugins/plumbob-harness-control
npm test
cd ../..
cd plugins/cursor-cloud-control
npm test
cd ../..
node scripts/validate-release.mjs
```

Tests use local fixtures and temporary Git repositories. CI must not send
repository contents or prompts to an external model provider.

Cursor Cloud Control uses only the official Cursor Cloud Agents API v1 through
typed MCP tools. Credentials stay in the MCP process environment or an
owner-only file; creation defaults to plan mode, a new branch, and no PR.

## License

MIT. See [`LICENSE`](LICENSE).
