# Data handling

Provider credentials are accepted only from the server environment or a
protected file outside the repository. They are never valid tool arguments.

Job records store prompt hashes and lengths, opaque summaries, canonical
configuration digests, and bounded diagnostics. The runner sanitizes exact
prompt fragments and credential-shaped strings before child output is written
to the connector log. Read APIs apply redaction again as defense in depth.

Do not submit credentials, private keys, protected health information,
production-only data, or unredacted customer payloads to an external model.
Provider-backed jobs are never run in CI.

Local state may still contain repository-derived model output. Keep the state
directory owner-only, apply retention appropriate to the repository, and do
not attach it wholesale to public issues.

## Cursor Cloud Control

The sibling Cursor Cloud Control plugin is an explicit egress boundary for
Cursor Cloud Agents API v1. It sends only fields selected by its typed create
or follow-up schemas: prompt text/images, model selection, repository and
environment targets, and explicitly supplied run integrations. Cursor owns the
durable VM/workspace, repository clone, branch, PR, and cloud retention
semantics. Nested cloud subagent streams are not independently addressable by
the v1 API and are not synthesized locally.

`CURSOR_API_KEY` or the default XDG/HOME owner-only config file is read by the
MCP process. The local submission ledger contains only a request ID, operation
kind, SHA-256 configuration digest, status, and opaque agent/run IDs. Prompt
text, image data, environment-variable values, MCP headers, and transcripts
are not persisted. Error, event, and artifact metadata responses are redacted
before they return to Codex.

Artifact downloads require `CURSOR_ARTIFACT_ROOT` and a safe relative
destination. The plugin verifies the exact listed artifact path, bounds the
response, rejects path traversal and symlink escape, writes atomically with
owner-only permissions, and does not execute or render the result.
