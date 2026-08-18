# MCP Inspector preflight

Use MCP Inspector 2.2 or newer against the stdio server. First calculate the
expected fingerprint from a reviewed target file:

```bash
node scripts/target-fingerprint.mjs examples/target-context.json
```

Then call `preflight` with `schema_version`, the same `target_context`, and the
caller-held fingerprint:

```bash
mcp-inspector --cli node plugins/plumbob-harness-control/mcp/server.mjs \
  --method tools/call --tool-name preflight \
  --tool-args-json '{"schema_version":"codex-co-engineer.config.v1","kind":"preflight","target_context":{...},"expected_target_fingerprint":"sha256:..."}' \
  --format json
```

Accept only a result containing the matching `target_fingerprint`, absolute
`resolved_workspace` and `resolved_cwd`, `configuration_digest`, `transport`,
`protocol_version`, `server_identity`, and `available_tools`. The repository
integration fixture runs the same assertion end to end:

```bash
node scripts/inspector-preflight.mjs
```

Preflight remains target/configuration attestation and does not query provider
capacity. A current candidate should advertise the explicit read-only
`capacity` tool in `available_tools`; call it separately when routing needs
Codex, Grok, or DSH usage data.

Inspector configuration files should be passed with `--config`; a missing or
malformed explicit config must fail. Do not permit Inspector's writable
default catalog to select a workspace for release automation.
