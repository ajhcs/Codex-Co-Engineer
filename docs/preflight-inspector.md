# MCP Inspector preflight

Run MCP Inspector `2.2.0` or newer against the exact stdio server that will be
activated. The repository's canonical provider-free check creates a temporary
clean Git target, uses an owner-only temporary state directory, checks the
advertised schema, and verifies the attestation fields:

```bash
node scripts/inspector-preflight.mjs
```

The script is the reproducible integration check used by the local gate and
CI. It does not submit a DSH or Grok job. Install the pinned Inspector for a
manual run with:

```bash
npm install --global @modelcontextprotocol/inspector@2.2.0
```

## Manual exact-target call

For a clean local checkout, fill in the absolute paths and current 40-character
HEAD below. `target_binding: "control_plane"` makes the connector compute and
bind the target fingerprint; omit that field only when supplying the digest
returned by `scripts/target-fingerprint.mjs` yourself.

```bash
TARGET_ROOT=/absolute/path/to/clean/checkout
TARGET_HEAD="$(git -C "$TARGET_ROOT" rev-parse HEAD)"
TARGET_ARGS="$(TARGET_ROOT="$TARGET_ROOT" TARGET_HEAD="$TARGET_HEAD" node --input-type=module -e '
const root = process.env.TARGET_ROOT;
const head = process.env.TARGET_HEAD;
process.stdout.write(JSON.stringify({
  schema_version: "codex-co-engineer.config.v1",
  kind: "preflight",
  target_binding: "control_plane",
  target_context: {
    schema_version: "codex-co-engineer.target.v1",
    mode: "explicit",
    working_directory: root,
    expected_git_root: root,
    expected_head: head,
    allowed_paths: ["."],
    role: "review"
  }
}));
')"

mcp-inspector --cli node plugins/plumbob-harness-control/mcp/server.mjs \
  --method tools/call --tool-name preflight \
  --tool-args-json "$TARGET_ARGS" \
  --format json
```

Set `TARGET_ROOT` to the clean checkout you intend to review. The command
derives its exact HEAD and emits the JSON argument from those values, so the
target contract remains visible and auditable. It must return a result
containing:

- `target_fingerprint`
- absolute `resolved_workspace` and `resolved_cwd`
- `configuration_digest`
- `transport` and `protocol_version`
- `server_identity`
- `available_tools`, including `preflight`, `status`, `capacity`, `runtime`,
  `run`, `jobs`, and `cancel`

To use caller-held fingerprint authority instead, create a target contract
with the same exact values and run:

```bash
node scripts/target-fingerprint.mjs /absolute/path/to/target-context.json
```

Pass the resulting `target_fingerprint` as
`expected_target_fingerprint` and leave out `target_binding`. A changed Git
HEAD, path identity, or configuration must produce a new preflight; never
reuse a stale digest.

For a GitHub review, use `target_context.mode: "staged"` with a GitHub HTTPS
`source` and `target_binding: "control_plane"`; the connector stages an
owner-only, origin-free checkout and attests its resolved commit before a
worker starts. Private sources require a noninteractive Git credential helper
or askpass/secret-manager integration already available to the MCP process;
staging forces `GIT_TERMINAL_PROMPT=0`, and credential-bearing URLs are
rejected.

## Inspector configuration and interpretation

When using a saved Inspector session configuration, pass it explicitly with
`--config /absolute/path/to/config.json`. That file is read-only and must name
the intended server; do not let Inspector's writable default catalog select a
workspace for release automation. The direct `--cli node ...` form above
starts the checked-out server and avoids relying on a previously selected
catalog entry.

Generic `preflight` is target/configuration attestation, not a provider-capacity
query. Use the separate Co-Engineer `capacity` tool for explicit Codex, Grok,
or DSH usage data. Use `status({"diagnostics":true})` only for the bounded,
read-only Grok `models` authentication probe.
