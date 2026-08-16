# Security policy

Codex-Co-Engineer controls processes that can read or modify a local Git
checkout and can send selected prompts and repository excerpts to an external
model provider. Treat it as an operator-plane integration, not as a security
sandbox.

## Supported versions

Security fixes target the latest release on the default branch. The stable
MCP compatibility identifier is `plumbob-harness-control`; report it together
with the public package version when describing an affected installation.

## Report privately

Do not open a public issue for an undisclosed vulnerability. Use the
repository's GitHub **Security** tab to create a private vulnerability report
or contact the repository maintainers through the private channel configured
there. Include a minimal reproduction, affected version, impact, and the
smallest safe log excerpt. Never attach credentials, full prompts, private
repository contents, or unredacted payloads.

## Security invariants

- Every dispatch validates one strict target and resolves an absolute cwd.
- Explicit target failures never select a default workspace.
- The caller's expected target fingerprint must match the resolved target.
- MCP Inspector preflight records target, configuration, transport, protocol,
  server identity, and tool-set evidence before work begins.
- Absolute deadlines cannot be extended by progress notifications.
- Heartbeats are bounded and include last activity; terminal state is emitted
  exactly once.
- Credentials arrive through the process environment or an external secret
  manager, never through tool arguments, prompts, logs, or Git.
- Logs retain bounded redacted diagnostics, not full prompts or payloads.
- Implement jobs are limited to declared relative paths and independently
  checked before a patch artifact is released.

If an invariant is violated, stop using the affected checkout, preserve only
the minimum redacted evidence, and report it privately.

## Cursor Cloud Control boundary

The sibling `cursor-cloud-control` plugin sends explicitly selected prompts,
repository references, model settings, and requested run inputs to the
administrator-selected Cursor Cloud Agents API origin. Its default origin is
the official `https://api.cursor.com` service; HTTP overrides are accepted only
for loopback or `.test` test origins. It does not expose a generic HTTP or
shell tool.

Cursor Cloud Control credentials are process-level only (`CURSOR_API_KEY` or a
protected owner-only config file). Its ledger stores request/configuration
hashes and opaque lifecycle IDs, never prompt text, image bytes, environment
variable values, MCP credentials, or full transcripts. Cloud artifacts are
untrusted: downloads require an administrator-configured root, reject
traversal and symlink escape, default to no overwrite, and are never executed.
Permanent agent deletion is irreversible and requires an exact ID-bound
confirmation value; archive is the reversible alternative.
