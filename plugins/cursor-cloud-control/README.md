# Cursor Cloud Control and Local Control

Cursor Cloud Control is a typed MCP control plane for the official Cursor
Cloud Agents API v1. It lets Codex discover the authenticated account, models,
and GitHub repositories; return a compact authenticated identity projection;
create durable agents; submit follow-up runs; observe
bounded polling or SSE; cancel runs; read usage; handle artifacts; and archive,
unarchive, or permanently delete agents.

This README documents Cursor Cloud Control `0.4.0`. Its separately exposed
`cursor-local-control` MCP server uses wire identity `0.2.0`.

The same package contains a separate `cursor-local-control` MCP server
for the locally installed Cursor Agent CLI. Its foundation has exactly three
typed contracts—`status`, `run`, and `runs`—and the public/default catalog
exposes only read-only `status` (with `local`, `auth`, and `permissions`
actions). An administrator may explicitly opt into a clearly labeled
host-trusted direct-CLI profile. It is deliberately not a wrapper for the
Cloud API. Local credentials, permission configuration, process lifecycle,
worktrees, logs, IDs, and owner-only receipts are separate from the Cloud
surface and its `submissions.json` ledger.

The implementation is intentionally a control plane, not a generic HTTP
proxy. Every operation is mapped to a documented v1 endpoint and every tool
schema rejects unknown fields. It does not expose a raw HTTP method, JSON
payload, shell command, filesystem root, or credential value. Remote MCP
headers are typed; credential-bearing headers and OAuth values can only be
referenced by administrator-provided environment variable names.

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

Cursor's reference defines remote MCP OAuth as `auth` with `CLIENT_ID`, an
optional `CLIENT_SECRET`, and `scopes`. The tool-facing wrapper uses
`authEnv` and `headerEnv` so callers provide only environment variable names;
the MCP process resolves those values immediately before create/follow-up,
materializes Cursor's official shape, and keeps the resolved values out of
digests, receipts, ledgers, and returned results. Stdio servers cannot use
these remote-only reference fields. Literal credential-bearing headers remain
rejected.

The endpoint-specific mappings are kept literal: usage calls
`GET /v1/agents/{id}/usage` and adds the optional `runId` query parameter,
returning Cursor's `{totalUsage, runs}` response. Artifact listing calls
`GET /v1/agents/{id}/artifacts`; downloading first verifies one returned
`artifacts/...` path, then calls
`GET /v1/agents/{id}/artifacts/download?path=...` and fetches the returned
temporary `url`. The models and repositories references currently document no
pagination query controls, so the plugin does not invent `limit` or `cursor`
arguments for those discovery calls.

That temporary artifact URL is trusted only as an authenticated Cursor API
output for the exact listed artifact; it is never accepted from a tool caller.
The adapter enforces bounded HTTPS redirects and rejects obvious local or
private destinations, but it is not a general-purpose URL fetcher or a complete
SSRF boundary for provider-compromise scenarios.

The API is public beta and may change. Fleet worker administration, worker
token minting, webhooks, and v0 private-worker routes are deliberately outside
this plugin. Cursor currently exposes custom subagent configuration in the
create payload, but nested subagent streams are not independently addressable
through the v1 run routes, so the plugin does not invent a second stream ID.

## Setup and key handling

Register the repository root as a Codex marketplace (see the root
[README](../../README.md)) and install `cursor-cloud-control`. Then configure
the MCP process with one of these administrator-controlled credential sources:

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
MCP process. Credential values are never accepted as literal tool arguments,
prompts, the durable ledger, logs, or error responses. API keys are
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
- `CODEX_TASK_STATE_ROOT`: host-provisioned shared durable state root. When
  `CURSOR_CLOUD_CONTROL_STATE_DIR` is absent, the Cursor ledger uses the
  absolute `${CODEX_TASK_STATE_ROOT}/cursor-cloud-control` directory. An empty
  or relative value is rejected and does not fall through to another state
  location.
- `XDG_STATE_HOME`: forwarded to the MCP server for the standards-based state
  fallback. It must be absolute when non-empty; a relative value fails closed
  instead of falling through to `HOME`.
- `CURSOR_ARTIFACT_ROOT`: required before downloading an artifact. Downloads
  are limited to this administrator-configured root.
- `CURSOR_CLOUD_CONTROL_REQUEST_TIMEOUT_MS`,
  `CURSOR_CLOUD_CONTROL_REPOSITORY_TIMEOUT_MS`,
  `CURSOR_CLOUD_CONTROL_MAX_RESPONSE_BYTES`, and
  `CURSOR_CLOUD_CONTROL_MAX_ARTIFACT_BYTES`: bounded transport limits.

Do not place credentials in a repository, commit, prompt, MCP server
definition, or issue report. Inline MCP stdio environment values and session
environment variables are sent to Cursor only for the requested run and are
represented locally by counts and a configuration digest. For remote MCP
OAuth or credential-bearing headers, use the compact reference form:

```json
{
  "name": "linear",
  "url": "https://mcp.example.test/sse",
  "authEnv": {
    "CLIENT_ID": "MCP_CLIENT_ID",
    "CLIENT_SECRET": "MCP_CLIENT_SECRET",
    "scopes": ["MCP_SCOPE_READ"]
  },
  "headerEnv": { "Authorization": "MCP_AUTHORIZATION" }
}
```

Each reference must be a valid non-reserved environment name with a non-empty
value in the MCP process. References are unique within one server and cannot
conflict with literal headers. OAuth scope values must be one non-whitespace
scope token. The values are never part of the request digest or durable state.

### Durable local state

The local `status` response reports the ledger contract under
`status.state.ready`, `status.state.source`, and, when unavailable,
`status.state.reason`/`reasonCode`. Configure
`CURSOR_CLOUD_CONTROL_STATE_DIR` explicitly when the host needs a known
persistent owner-only location. If it is absent, the process next uses the
absolute `CODEX_TASK_STATE_ROOT/cursor-cloud-control` shared location, then
the host's `XDG_STATE_HOME` or `HOME` state directory. Every non-empty state
root must be absolute; relative explicit, shared, XDG, or HOME values fail
closed rather than being silently resolved relative to the current working
directory. The process never falls back silently to
`/tmp` or another transient location. If the resolved directory or ledger is
missing, not owner-only, corrupt, or not writable, mutation tools fail closed
before calling Cursor. Read-only status and discovery calls remain available
so the state problem can be diagnosed without submitting work.

### Cursor Local Control

The second MCP server, `cursor-local-control`, is a separate local process
adapter. It never imports the Cloud API client, reads `submissions.json`,
accepts Cloud IDs, or writes Cloud receipts. The default catalog is
status-only; run/lifecycle tools appear only when the administrator enables
host-trusted execution.

Provision these administrator-only environment values before using local
status:

- `CURSOR_LOCAL_CLI_BIN`: absolute path to `cursor-agent` or
  `cursor-local-agent`. The generic `agent` alias is rejected so an existing
  Grok alias cannot be shadowed.
- `CURSOR_LOCAL_CLI_SHA256`: administrator-pinned SHA-256 digest for the
  executable. Status reports digest drift. Host-trusted execution remains
  administrator-authorized even when no digest pin is configured; a configured
  pin that drifts still fails closed.
- `CURSOR_LOCAL_CLI_SANDBOX_BIN`: absolute path to the administrator-selected
  native `bwrap` binary. Only `bwrap` is accepted.
- `CURSOR_LOCAL_CLI_SANDBOX_SHA256`: administrator-pinned SHA-256 digest for
  that native sandbox. Status runs a harmless read-only-root preflight and
  reports `sandbox.ready`; host-trusted execution does not invoke this
  foundation and the preflight is not an execution attestation.
- `CURSOR_LOCAL_CLI_API_KEY`: optional local-only API key environment value.
  The adapter maps it to the child process's `CURSOR_API_KEY`; it never takes
  the Cloud key file implicitly and never accepts a key as a tool argument.
- `CURSOR_LOCAL_CLI_HOME`: optional absolute directory for Cursor
  authentication and worktrees. When absent, host-trusted execution uses the
  MCP process `HOME`, matching the locally authenticated CLI.
- `CURSOR_LOCAL_CLI_CONFIG_DIR`: optional absolute Cursor config directory.
  The host-trusted profile inherits Cursor's normal CLI approval configuration;
  the wrapper does not claim that it is a sandbox or silently widen it.
- `CURSOR_LOCAL_CLI_WORKSPACE_ROOTS`: absolute, colon-separated workspace
  allowlist. Tool callers cannot broaden it.
- `CURSOR_LOCAL_CLI_ENABLE_HOST_TRUSTED_RUNS`: set exactly to `1` by the
  administrator to expose local `run` and `runs`. It is unset by default and
  is never accepted as a tool argument.
- `CURSOR_LOCAL_CONTROL_STATE_DIR`: owner-only (`0700`) local ledger root;
  absent this, the adapter uses an absolute `XDG_STATE_HOME` or `HOME` local
  state path ending in `cursor-local-control`. The ledger retains every
  requestId/request digest reservation (including terminal tombstones) up to
  10,000 records and the 8 MiB file bound; it fails closed before spawning a
  new process when either capacity is reached, rather than evicting a tombstone.

The local `status` tool is always available for binary, compact auth,
permission, and sandbox diagnostics. To expose execution, set
`CURSOR_LOCAL_CLI_ENABLE_HOST_TRUSTED_RUNS=1`. Every `run` request must include
`execution_profile: "host_trusted"`, an explicit `mode` (`read_only` or
`implement`), and an absolute allowlisted workspace.

Host-trusted read-only execution invokes `cursor-agent --print --mode ask`;
it never passes `--force` and requires explicit `Write(**)`, `Shell(*)`, and
`Mcp(*:*)` deny rules in the administrator Cursor config. Explicit implement
execution invokes Cursor with `--force` and an isolated Cursor worktree. Both
use the direct selected binary,
disable Cursor's provider sandbox, and do not invoke Bubblewrap. Receipts
identify the boundary as `host_trusted`, the authority as
`mcp_process_user`, the outer sandbox as `none`, and `workspaceChanged` as
`null` because a direct host process has no outer filesystem observer.

This is a normal local coding-agent authority surface, not a confidentiality,
network, or filesystem sandbox. The process can use any authority available to
the MCP OS user; the workspace allowlist and bounded timeout/event/log fields
are control-plane limits only. Timeout and cancellation signal the owned
process group with TERM and escalate to KILL after the grace interval.

Host-trusted pathname, home, and Cursor-config authority is the same-user
authority of the MCP process: owner-only checks and descriptor identity
attestations reduce accidental swaps, but there is no separate filesystem or
credential boundary. On restart, a child is signalled only when its durable
PID start token freshly matches immediately before each TERM/KILL. If the
leader has exited or the token cannot be matched, post-leader descendants are
left untouched and the run is reported as `transport_lost` rather than risking
a signal to a reused PID or unrelated process group.

The retained Bubblewrap code remains a separately packaged foundation and is
not the host-trusted boundary. A real host acceptance check is still required
for each local installation, including Cursor project-state/trust setup and
process cleanup. The adapter still does not expose `login`, `logout`,
`update`, ACP, workers, arbitrary shell commands, or arbitrary MCP
configuration.

The CLI invocation is based on Cursor's documented [headless](https://cursor.com/docs/cli/headless),
[parameter](https://cursor.com/docs/cli/reference/parameters),
[authentication](https://cursor.com/docs/cli/reference/authentication), and
[permission](https://cursor.com/docs/cli/reference/permissions) contracts.
The adapter intentionally does not expose `login`, `logout`, `update`, ACP,
workers, arbitrary shell commands, or arbitrary MCP configuration.

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
- cancellation and agent lifecycle mutations also receive a durable request
  receipt. If a request ID is omitted for those target-scoped operations, the
  plugin derives a stable target/action key; callers should provide an explicit
  request ID when they need an independently addressable receipt.
- Cursor HTTP 409 conflicts and HTTP 429 rate limits are recorded as definitive
  failed submissions (with a safe provider error code when available), not as
  transport-uncertain mutations.
- create receipts separate caller-requested configuration from provider
  verification. Repository starting refs, the effective model, and the remote
  workspace head/branch remain explicitly unverified unless Cursor returns a
  documented attestation. The legacy `effectiveConfiguration` field is retained
  as a deprecated caller-derived alias and must not be treated as provider
  evidence.

Cursor Cloud Agents run on a durable Cursor-managed VM/workspace. A durable
agent persists conversation and workspace state across runs. Repository URLs,
starting references, current-branch behavior, PR creation, environment
variables, MCP servers (including safe `authEnv` and `headerEnv` references),
and custom subagents are sent to Cursor exactly as requested within the
documented bounds. The plugin does not mutate the local
checkout and does not merge or execute returned artifacts.

## Tools and recipes

`status` returns local configuration without contacting Cursor by default.
Use `{"action":"identity"}`, `{"action":"models"}`, or
`{"action":"repositories"}` for explicit safe discovery.
Identity discovery returns only the compact, privacy-preserving projection
described above; it does not return the upstream account object.
Model discovery returns a compact identity summary by default (dynamic model
IDs, display names, and aliases). Add `"detail":true` for the bounded
provider parameters and variants, or `"refresh":true` to force a fresh
authenticated `/v1/models` read. Catalog and page truncation are reported
explicitly; Cursor's official API currently documents no resolved-model field,
so effective selection remains unknown.
Cursor documents repository discovery as both strictly rate-limited and
potentially tens of seconds long. The plugin therefore makes one bounded
60-second attempt, never retries that endpoint, and returns
`available=false` on a timeout or rate limit so a confirmed repository URL can
be used directly. Repository-backed creation receives the same longer
one-attempt transport bound.

`agents` supports `list`, `get`, `create`, and explicit `reconcile`. A create call supplies a
prompt and may select a model, environment, repositories, prompt images,
session environment variables, inline MCP servers (including remote `authEnv`
and `headerEnv` references), custom subagents, and `agent`/`plan` mode. The
result includes `requestedConfiguration`, a `providerVerification` block, and
opaque agent/run receipts rather than plaintext sensitive inputs. The
`providerVerification` block reports repository starting refs, model
resolution, and remote workspace identity as `unverified` when the provider
does not attest them. For 0.2.x compatibility, `effectiveConfiguration` is
still present with `provenance: "caller-derived"` and `deprecated: true`; it is
only a legacy alias for the requested configuration.

When `agentId` is omitted, the plugin does not send its local reservation ID
to Cursor; Cursor may mint the provider ID. A transport-uncertain create in
that mode may inspect a bounded provider listing using a hash-only fingerprint,
but even a unique exact match is not reservation-time evidence: an identical
agent may predate the request. The reservation therefore remains uncertain;
the plugin never guesses an ID, finalizes a listing match, or resubmits. Use
`{"action":"reconcile","requestId":"..."}` for the bounded diagnostic, or
use the explicit typed release confirmation `release:<requestId>` only after
accepting that provider state could not be proven. For a caller-supplied provider ID,
reconciliation performs bounded, repeated `agents.get` and `runs.list` checks
and releases the retryable local reservation only after both provider paths
consistently return HTTP 404.

`runs` supports `list`, `get`, `followup`, `wait`, `stream`, `cancel`, and
`reconcile`. Follow-up and cancellation mutations return durable receipts;
an otherwise successful follow-up response without an opaque provider run ID,
or a cancellation response whose run is not terminal `CANCELLED`/`CANCELED`,
remains uncertain. A caller-supplied create ID must also match the provider ID
returned by Cursor; mismatches remain uncertain. `runs.wait` converts a
provider `request_timeout` into a bounded `timedOut: true` receipt while
retaining the latest confirmed run when available. Uncertain reservations can
be reconciled with the exact provider run ID when one is known, or explicitly
released with `release:<requestId>`. A provider run HTTP 404 is only treated as
absence after bounded repeated exact 404 observations; one miss remains
uncertain. No reconciliation path resubmits the mutation.
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
`lifecycle` archives or unarchives an exact agent and supports
`reconcile` for uncertain lifecycle receipts. Permanent deletion is
irreversible and requires `confirmation` exactly equal to
`delete:<agent-id>`; archive is the reversible alternative. Every lifecycle
mutation is durably keyed and never blindly retried. If provider state cannot
be proven, use the typed lifecycle reconciliation or the explicit
`release:<requestId>` confirmation; release records a terminal local receipt
and does not claim that the provider mutation failed.

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
