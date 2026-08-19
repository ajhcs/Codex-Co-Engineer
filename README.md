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

Current public release surfaces are Co-Engineer `2.2.0`, Cursor Cloud Control
`0.4.0`, and the separately advertised `cursor-local-control` wire identity
`0.2.0`. ACPX remains independently pinned and is not versioned with these
plugins.

## Release contents

```text
plugins/plumbob-harness-control/   Codex plugin, MCP facade, skill, and tests
plugins/cursor-cloud-control/      Typed Cursor Cloud and Local CLI control planes
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

### Prerequisites

The fully supported and release-tested host is Linux with Node.js 24.x. The
runtime packages declare Node `>=24.0.0`; the authoritative local gate pins
Node major 24 and additionally requires executable Bubblewrap, static BusyBox,
and MCP Inspector `2.2.0`. Windows is not a supported host for the managed
POSIX process-group and DSH receipt guarantees. A target checkout also needs
Git and a clean, exact commit.

For provider-backed work, install the provider CLIs separately and verify them
before opening Codex. These commands refer to the DeepSeek Harness `dsh` and
Grok Build `grok` CLIs, not MCP tool names:

```bash
node --version                 # 24.x for the authoritative gate
dsh --version                  # tested profile: 0.1.0-rc.6
grok --version                 # local acceptance: Grok Build 1.0.4
grok models                   # read-only auth/readiness probe
```

DeepSeek Harness `0.1.0-rc.6` is the accepted DSH adapter version. A
`deepseek_agent` run requires `MODEL_API_KEY` in the MCP process environment or
an owner-only file. Grok Build must be authenticated through its normal CLI
flow (`grok login` or device auth), or receive `XAI_API_KEY` through the MCP
process environment. The plugin never automates login or accepts credentials
as tool arguments.

For optional local Cursor work, install the official [Cursor Agent CLI](https://cursor.com/docs/cli/reference/authentication)
separately, keep a dedicated `cursor-agent` executable path, and set
`CURSOR_LOCAL_CLI_BIN` when it is not on the MCP process `PATH`. Authenticate
it with `cursor-agent login` (or the administrator-managed local API-key
environment) and verify the account with `cursor-agent status` before opening
Codex. Never put a Cursor key in a tool call or use `--api-key`; the public
local catalog is status-only until an administrator explicitly enables
host-trusted runs.

### Register and activate in Codex

Codex registration is marketplace-based. This repository is itself a
marketplace: its root `.agents/plugins/marketplace.json` points at both plugin
packages. Add the public Git marketplace directly (or use the same command
with an absolute local checkout path), then install either or both entries:

```bash
codex plugin marketplace add ajhcs/Codex-Co-Engineer --ref main
# For a local checkout instead:
# codex plugin marketplace add /absolute/path/to/Codex-Co-Engineer
codex plugin marketplace list --json
codex plugin list --available --json
codex plugin add plumbob-harness-control@codex-co-engineer
codex plugin add cursor-cloud-control@codex-co-engineer
codex plugin list --json
```

Do not use the unsupported `codex plugin add ./plugins/...` form. In the Codex
App, the enabled entries come from the same plugin configuration. After
installing or changing a plugin, fully restart the App and start a fresh task
before expecting its MCP tools or skills in the callable catalog.
`codex plugin list --json` verifies installation and enabled state; it does not
refresh an already-running task.

### Configure and make the first call

Set the provider credential and runtime workspace in the MCP server environment
before the fresh task starts. A template is in
[`config/configuration.example.json`](config/configuration.example.json).
Then use this bounded sequence in the fresh Codex task:

1. Call the Co-Engineer MCP `status` tool with `{}`. It is provider-free unless
   `diagnostics: true` is explicitly requested.
2. Call the Co-Engineer MCP `preflight` tool with `schema_version: "codex-co-engineer.config.v1"`,
   `kind: "preflight"`, `target_binding: "control_plane"`, and one exact
   `target_context`. For a local checkout, use `mode: "explicit"` with its
   absolute `working_directory`, `expected_git_root`, current 40-character
   `expected_head`, `allowed_paths`, and `role: "review"` or `"verify"`.
   `target_binding` lets the connector compute the fingerprint; it does not
   remove the exact-path, HEAD, or postflight checks.
3. Call the Co-Engineer MCP `run` tool with the same target context, a stable `request_id`, and either
   `kind: "deepseek_agent"` or `kind: "grok_build"`. Keep the prompt text-only
   and use only the typed provider fields in the tool schema.
4. Call the Co-Engineer MCP `jobs` tool with `{"action":"wait","job_id":"<returned-id>","until":"terminal"}`,
   then call the same `jobs` tool with `{"action":"get","job_id":"<returned-id>"}`.

For a GitHub review, `target_context.mode: "staged"` with
`source.type: "github"`, an HTTPS `repository`, and an optional `ref` avoids
manual local fingerprint calculation. The connector clones an owner-only,
origin-free checkout and binds its exact commit before dispatch. A private
source requires noninteractive Git credentials already available to the MCP
process (for example, an owner-approved credential helper or askpass/secret
manager integration). Staging sets `GIT_TERMINAL_PROMPT=0`, so an interactive
username/password prompt cannot succeed; keep credentials out of the
repository URL, target context, prompts, and tool arguments.

See the complete MCP call shapes in the
[`Co-Engineer plugin README`](plugins/plumbob-harness-control/README.md) and
the exact Inspector workflow in
[`docs/preflight-inspector.md`](docs/preflight-inspector.md). User-visible
changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).

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
expected Git root and HEAD, allowed paths, and role. Normal callers should set
`target_binding: "control_plane"` so the connector computes and binds the
resolved identity. Advanced callers that hold fingerprint authority may omit
`target_binding` and supply the caller-computed `expected_target_fingerprint`.
Prompt-level `cd` is never authoritative, and an invalid explicit target never
falls back to a default workspace.

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

Configured Grok, DSH, and Cursor credentials or provider sessions are reused as
standing authorization for task-scoped provider work. Provider credentials and
sessions can expire or be revoked and may require ordinary provider
reauthentication; the control planes do not add a per-job data-egress prompt.
Repository writes, destructive Git operations, deployments, and PR creation
retain their normal task authority and safety controls.

## Co-Engineer tools

The plugin exposes seven stable MCP tools:

- Co-Engineer MCP `preflight` attests the target, configuration digest, protocol, and tool set.
- Co-Engineer MCP `status` reports DeepSeek, Grok, credential-presence, UI, and recent-job state.
- Co-Engineer MCP `capacity` reads compact Codex/Grok capacity and exact DSH job-token evidence.
- Co-Engineer MCP `runtime` starts or stops the optional plugin-owned loopback DeepSeek UI.
- Co-Engineer MCP `run` dispatches exactly `deepseek_agent` or `grok_build`.
- Co-Engineer MCP `jobs` lists, inspects, waits for, or cursor-pages managed jobs.
- Co-Engineer MCP `cancel` cancels one exact plugin-owned job.

DSH/Muse dollar spend, account quota remaining, and reset time remain
`unknown`: the installed harness does not prove them. Experimental ACPX session
transport and the Bubblewrap-based Grok outer runtime are packaged only as
gated conformance components. They are not wired to a public MCP `sessions`
tool or to direct `grok_build` dispatch in this release.

Every dispatch requires the versioned target contract, a stable request ID, and
a bounded timeout; target identity is either caller-asserted or explicitly
bound by the control plane. See the
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
