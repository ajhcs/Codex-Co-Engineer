# Codex-Co-Engineer

Codex-Co-Engineer is a public, Codex-first control plane for the standalone
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Codex is
the chief engineer and operator; DeepSeek Harness is the bounded peer worker.
Prime Agent and Prime Lab support are optional adapters, not required for the
main release.

The stable plugin and MCP identifier is `plumbob-harness-control`. The public
product name is **Codex-Co-Engineer**. Keeping the technical identifier stable
allows existing Codex configurations to migrate without a server-name break.

## Release contents

```text
plugins/plumbob-harness-control/   Codex plugin, MCP facade, skill, and tests
config/                            non-secret configuration examples
docs/                              target, preflight, data, and release policy
examples/                          redacted contract and receipt examples
scripts/                           dependency-free release validation
.github/workflows/                 CI and package checks
```

The public tree does not contain a Prime Lab checkout, generated DSH packages,
model registries, session logs, provider credentials, or personal Codex
configuration. Keep those in a separate private checkout or secret manager.
The root ignore policy is intentionally fail-closed for `Secrets/`,
`prime-intellect-lab/`, local state, and generated runtimes.

## Quick start

1. Install Node.js 24 or newer.
2. Install and configure DeepSeek Harness using its upstream documentation.
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
export CODEX_CO_ENGINEER_RUNTIME_WORKSPACE='/absolute/path/to/dsh-runtime-workspace'
export CODEX_CO_ENGINEER_ALLOWED_ROOTS='/absolute/path/to/checkouts'
export CODEX_CO_ENGINEER_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codex-co-engineer"
```

`CODEX_CO_ENGINEER_RUNTIME_WORKSPACE` locates the configured runtime. It is not target
authority. A job must carry one strict target contract with an absolute cwd,
expected Git root and HEAD, allowed paths, role, and caller-supplied expected
fingerprint. Prompt-level `cd` is never authoritative, and an invalid
explicit target never falls back to a default workspace.

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
node scripts/validate-release.mjs
```

Tests use local fixtures and temporary Git repositories. CI must not send
repository contents or prompts to an external model provider.

## License

MIT. See [`LICENSE`](LICENSE).
