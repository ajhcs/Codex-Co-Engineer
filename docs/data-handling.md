# Data handling

Provider credentials are accepted only from the server environment or a
protected file outside the repository. They are never valid tool arguments.
Once configured, those credentials are standing authorization for task-scoped
provider calls; the control planes do not ask for per-job data-egress approval.
Writes, destructive Git, deployments, and PR creation remain separately controlled.
For `grok_build`, `MODEL_API_KEY` is not required or passed to the child;
Grok's OAuth/session state remains under the user's normal home and an
administrator may provide `XAI_API_KEY` through the daemon environment. The
official CLI is invoked directly with an argv vector, never through a shell.

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

## Grok Build

Grok `streaming-json` (or `streaming-messages-json`) records are retained only
as bounded, redacted lifecycle logs. Unknown and incomplete future event types
are tolerated; explicit provider/agent error records and nonzero exits fail the
job. A typed JSON Schema object/boolean is capped at 16 KiB and forces JSON
output; arbitrary output contracts are not accepted. The ACP `grok agent stdio`
interface, prompt-file/prompt-JSON modes, system-prompt override, debug files,
leader sockets, restore/worktree/ref commands, agent/agents bundles, and
interactive login/update commands are not proxied by this release because they
would bypass the target, lifecycle, or credential contract. The adapter's
bounded parser owns the durable output contract.

Pinned ACPX, bounded ACP helpers, and a Grok outer-boundary implementation are
packaged only for conformance. They are not connected to a public sessions or
coding-dispatch tool; direct Grok still uses the CLI-managed sandbox. The outer
experiment accepts an attested owner-only auth file, not `XAI_API_KEY`, and
still awaits real host/systemd acceptance. Grok and DSH harness-internal
subagents record compact requested/effective evidence; effectiveness stays
`unknown` unless provider output proves a child ran.

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
