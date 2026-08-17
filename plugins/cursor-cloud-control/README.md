# Cursor Cloud Control

Cursor Cloud Control is a typed MCP control plane for the official Cursor
Cloud Agents API v1. It lets Codex discover the authenticated account, models,
and GitHub repositories; return a compact authenticated identity projection;
create durable agents; submit follow-up runs; observe
bounded polling or SSE; cancel runs; read usage; handle artifacts; and archive,
unarchive, or permanently delete agents.

The implementation is intentionally a control plane, not a generic HTTP
proxy. Every operation is mapped to a documented v1 endpoint and every tool
schema rejects unknown fields. There is no tool argument for a URL, method,
headers, raw JSON payload, shell command, filesystem root, or environment map.

## API contract checked

The current primary reference was checked on 2026-08-16:

- [Cloud Agents API endpoint reference](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Cursor API authentication and limits](https://cursor.com/docs/api)

The plugin uses the v1 routes documented there: `/v1/me`, `/v1/models`,
`/v1/repositories`, agent and run lifecycle routes, run SSE, usage, and agent
artifacts. Cursor documents both Basic (`base64(api_key:)`) and Bearer
authentication for Cloud Agents; Bearer is the default and Basic can be chosen
by an administrator with `CURSOR_API_AUTH_SCHEME=basic`.

Cursor's `/v1/me` response is projected through an explicit allowlist before it
reaches Codex. Identity status contains only `authenticated`, an opaque
`userId` when Cursor provides one, and `keyStatus`; names, email addresses,
avatars, organizations, unknown fields, and credential-shaped fields are never
returned. There is no model-facing full-identity escape hatch.

Cursor's reference names an OAuth `auth` option for remote MCP servers but does
not define a safe secret-reference schema there. This plugin therefore exposes
credential-free remote headers and stdio environment inputs only after its
strict checks, and rejects an `auth` escape hatch until Cursor documents its
shape and secret handling.

The endpoint-specific mappings are kept literal: usage calls
`GET /v1/agents/{id}/usage` and adds the optional `runId` query parameter,
returning Cursor's `{totalUsage, runs}` response. Artifact listing calls
`GET /v1/agents/{id}/artifacts`; downloading first verifies one returned
`artifacts/...` path, then calls
`GET /v1/agents/{id}/artifacts/download?path=...` and fetches the returned
temporary `url`. The models and repositories references currently document no
pagination query controls, so the plugin does not invent `limit` or `cursor`
arguments for those discovery calls.

The API is public beta and may change. Fleet worker administration, worker
token minting, webhooks, and v0 private-worker routes are deliberately outside
this plugin. Cursor currently exposes custom subagent configuration in the
create payload, but nested subagent streams are not independently addressable
through the v1 run routes, so the plugin does not invent a second stream ID.

## Setup and key handling

Register this directory as a local Codex plugin and configure the MCP process
with one of these administrator-controlled credential sources:

```text
CURSOR_API_KEY=<value supplied by a secret manager>
```

or:

```text
CURSOR_API_KEY_FILE=/absolute/path/to/owner-only/cursor-key
```

When neither setting is provided, the process checks the prepared default
`$XDG_CONFIG_HOME/cursor-cloud-control/api-key` or
`$HOME/.config/cursor-cloud-control/api-key` path. The file must be a regular
owner-only file (mode `0600` or stricter), and the value is read only by the
MCP process. Credentials are never accepted in tool
arguments, prompts, the durable ledger, logs, or error responses. API keys are
created in the Cursor Dashboard API Keys page; account and repository access
remain governed by Cursor and GitHub.

Optional administrator settings:

- `CURSOR_API_AUTH_SCHEME`: `bearer` (default) or `basic`.
- `CURSOR_API_ORIGIN`: defaults to `https://api.cursor.com`. This is an
  administrator-only origin override for tests or a private compatible
  deployment; it is not a tool argument and must be an origin without a path,
  credentials, query, or fragment. HTTPS is required for production; HTTP is
  accepted only for loopback or `.test` test origins.
- `CURSOR_CLOUD_CONTROL_STATE_DIR`: owner-only durable submission ledger
  location. Prefer a host-provisioned path that survives MCP restarts. The
  directory is created or checked as owner-only (`0700`), and its
  `submissions.json` ledger is written owner-only (`0600`). It stores request
  IDs, hashes, status, and opaque agent/run IDs; it does not store prompts,
  environment-variable values, images, MCP header values, or full transcripts.
- `CURSOR_ARTIFACT_ROOT`: required before downloading an artifact. Downloads
  are limited to this administrator-configured root.
- `CURSOR_CLOUD_CONTROL_REQUEST_TIMEOUT_MS`,
  `CURSOR_CLOUD_CONTROL_REPOSITORY_TIMEOUT_MS`,
  `CURSOR_CLOUD_CONTROL_MAX_RESPONSE_BYTES`, and
  `CURSOR_CLOUD_CONTROL_MAX_ARTIFACT_BYTES`: bounded transport limits.

Do not place credentials in a repository, commit, prompt, MCP server
definition, or issue report. Inline MCP stdio environment values and session
environment variables are sent to Cursor only for the requested run and are
represented locally by counts and a configuration digest.

### Durable local state

The local `status` response reports the ledger contract under
`status.state.ready`, `status.state.source`, and, when unavailable,
`status.state.reason`/`reasonCode`. Configure
`CURSOR_CLOUD_CONTROL_STATE_DIR` explicitly when the host needs a known
persistent owner-only location; the process may otherwise resolve the host's
`XDG_STATE_HOME` or `HOME` state directory. It never falls back silently to
`/tmp` or another transient location. If the resolved directory or ledger is
missing, not owner-only, corrupt, or not writable, mutation tools fail closed
before calling Cursor. Read-only status and discovery calls remain available
so the state problem can be diagnosed without submitting work.

## Safe operating model

Create defaults are deliberately conservative:

- `mode` defaults to `plan`.
- `workOnCurrentBranch` defaults to `false`, so Cursor uses a generated branch.
- `autoCreatePR` defaults to `false`.
- reviewer requests are not enabled by default and
  `skipReviewerRequest` is accepted only when `autoCreatePR` is explicitly
  `true`.
- write-mode (`mode=agent`) repository dispatch requires a 40-character
  immutable `startingRef`; a loose branch name is rejected. Plan-mode dispatch
  can use a branch reference for exploration.
- create and follow-up requests require a stable caller request ID and receive a SHA-256
  configuration digest. Mutations are never automatically retried. If a
  network or timeout leaves acceptance uncertain, the ledger marks the
  submission `uncertain` and the same request ID cannot silently create a
  duplicate.

Cursor Cloud Agents run on a durable Cursor-managed VM/workspace. A durable
agent persists conversation and workspace state across runs. Repository URLs,
starting references, current-branch behavior, PR creation, environment
variables, MCP servers, and custom subagents are sent to Cursor exactly as
requested within the documented bounds. The plugin does not mutate the local
checkout and does not merge or execute returned artifacts.

## Tools and recipes

`status` returns local configuration without contacting Cursor by default.
Use `{"action":"identity"}`, `{"action":"models"}`, or
`{"action":"repositories"}` for explicit safe discovery.
Identity discovery returns only the compact, privacy-preserving projection
described above; it does not return the upstream account object.
Cursor documents repository discovery as both strictly rate-limited and
potentially tens of seconds long. The plugin therefore makes one bounded
60-second attempt, never retries that endpoint, and returns
`available=false` on a timeout or rate limit so a confirmed repository URL can
be used directly. Repository-backed creation receives the same longer
one-attempt transport bound.

`agents` supports `list`, `get`, and `create`. A create call supplies a
prompt and may select a model, environment, repositories, prompt images,
session environment variables, inline MCP servers, custom subagents, and
`agent`/`plan` mode. The result includes an effective configuration and opaque
agent/run receipts rather than plaintext sensitive inputs.

`runs` supports `list`, `get`, `followup`, `wait`, `stream`, and `cancel`.
`stream` parses fragmented SSE chunks, multiline data, comments, heartbeats,
event IDs, unknown future event types, and the documented
`status`/`assistant`/`thinking`/`tool_call`/`interaction_update`/`result`/
`error`/`done` events. Pass the returned `lastEventId` as `lastEventId` on a
later call to resume. A documented HTTP 410 stream expiry is reconciled by
fetching the run status. `wait` is always bounded and returns `timedOut` with
the latest bounded run record instead of waiting indefinitely.

`artifacts` lists metadata and downloads one exact path returned by Cursor.
Downloads require `CURSOR_ARTIFACT_ROOT`, reject traversal and symlinks, never
overwrite unless `overwrite=true` is explicit, write atomically with mode
`0600`, and are never executed or rendered automatically.

`usage` reads the documented per-agent token totals and per-run breakdown.
`lifecycle` archives or unarchives an exact agent. Permanent deletion is
irreversible and requires `confirmation` exactly equal to
`delete:<agent-id>`; archive is the reversible alternative.

## Monitoring and cancellation

Prefer `runs.stream` for bounded progress and retain its opaque event ID for
resume. Use `runs.wait` or `runs.get` to reconcile a stream expiry, timeout,
or an uncertain client disconnect. Cancellation is run-scoped and terminal in
Cursor; after cancellation, submit a new follow-up run if continuation is
intended. The plugin never assumes that a transport timeout means a mutation
failed.

## Data egress and deletion

Prompts, repository references, selected model parameters, and explicitly
requested sensitive run inputs are sent to the configured Cursor API origin.
Cursor controls cloud VM, repository, branch, PR, and retention semantics.
The local ledger contains only bounded operational metadata and hashes. API
errors, SSE events, artifact metadata, and identity responses are bounded or
redacted again before returning to Codex. Identity responses use the explicit
allowlist projection above. Permanent deletion is sent directly to Cursor only
after the exact agent ID confirmation barrier; it cannot be undone by this
plugin.

## Development

```bash
npm test
python3 <plugin-creator-skill-root>/scripts/validate_plugin.py .
```

Tests use an injected fetch or a local fake HTTP server and never contact
Cursor or require a real credential.
