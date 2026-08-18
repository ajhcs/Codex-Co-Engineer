# ACP and orchestrator adoption

Status: proposed architecture decision (2026-08-18)

## Decision

Keep Codex desktop as the cockpit and this repository as the small policy,
routing, lifecycle, and receipt control plane. Propose adopting the Agent
Client Protocol (ACP) through a pinned ACPX runtime for local ACP workers. Do
not replace the control plane with ACPX or with a general-purpose fleet
manager. ACPX `0.13.0` is an alpha runtime: optional capabilities are
provider-specific and must be proven by the selected adapter, not inferred
from ACPX's common vocabulary. This proposal does not activate ACPX in the
current release.

The first local ACP profiles are:

| Profile | Transport | Use |
| --- | --- | --- |
| `grok-local-acp` | ACPX -> `grok agent stdio` | Grok Build sessions, streaming, cancel, resume |
| `cursor-local-acp` | ACPX -> `cursor-agent acp` | Cursor Agent on the host/task sandbox |
| `codex-native` | Codex app/native delegation | Luna work and the Codex cockpit itself |
| `dsh-native` | Installed official DSH rc.6 adapter | Muse Spark 1.2 Contributor jobs |
| `cursor-cloud` | Cursor Cloud Control API | Cloud repository/VM/branch/PR work |

`grok-local-acp` means Grok Build's native ACP stdio server, invoked as
`grok agent stdio`; it is not the xAI API, Grok headless JSON mode, or a raw
`--agent` CLI shortcut. The provider's native permission/sandbox profile is
reported as capability evidence while the outer target contract remains
authoritative.

ACPX is the transport and session normalizer. The outer control plane remains
the authority for target identity, worktree, write ceiling, destructive
operations, deadlines, network policy, standing provider credentials, and
durable receipts. A provider capability never widens those limits.
Configured provider credentials are standing authorization for task-scoped
use. Dispatch does not add a per-job egress prompt. Repository, private-data,
production, Git, and PR policies remain explicit control-plane checks.

## Important distinctions

### Local ACP is not Cursor Cloud

`cursor-agent acp` is a local full Cursor harness surface controlled through
ACPX. It shares the local target-bound envelope and receipt ledger. Cursor
Cloud's API/SDK is a separate full Cursor harness surface: Cursor owns its
remote VM, clone, branch, PR, retention, and cloud execution semantics. The
profiles must expose different capabilities and must never be silently
substituted for one another.
Only exact `cursor-agent acp` or an allowlisted `agent acp` profile may run
after bounded `--version`/`--help` and provenance verification; generic
`agent` collisions fail closed. Local ACP never silently falls back to Cloud.

### Installed DSH is not the research project's alternate `dsh`

The installed target is `@deepseek-ai/dsh` `0.1.0-rc.6` from official
`deepseek-ai/deepseek-harness`, and that description is locally accurate. Its
current integration is the native DSH adapter/headless runner; the exact live
usage receipt remains gated until the pending production wiring passes its
release gate. The official project also has an `rc.7` release, but it is a
separate upgrade candidate: pin its exact package/source/provenance and run
independent conformance and receipt tests before making any `rc.7` capability
or usage claim. The similarly named `HenryZ838978/deepseek-harness` is a
different protocol/MCP wrapper and is not a replacement.

An official DSH ACP transport may be added later only after the installed
version, wire behavior, authentication, lifecycle, and sandbox contract are
verified. Do not infer that DSH rc.6 already provides ACP merely because other
providers do.

DSH rc.6 is an official MIT developer preview with compatibility-breaking
changes expected. Pin its package/provenance and adapter version, and report
only capabilities and usage that the installed binary actually proves.

| DSH native capability | Contract |
| --- | --- |
| Delegation/child controls; parallel/pipeline workflows | Probe: `supported`, `unsupported`, or `unknown`; no generic claim |
| Tool filters; child depth/limits | Probe and enforce only proven controls |
| Continuation/fork/follow-up | Probe with exact session evidence |

### ACPX is not the outer sandbox

ACPX launches ACP agents on the host and its default child environment is
broad. The adapter must provide an environment allowlist and invoke ACPX
inside the target-bound envelope. Redirect ACPX state to the provisioned task
state root; default `~/.acpx` locations are not durable in ordinary sandboxes.
Provider sandboxing is evidence, not a substitute for outer target, write, and
credential boundaries.
ACPX session state can contain sensitive prompts, transcripts, tool arguments,
and provider events. Store it under an owner-only explicit `sessionStore`,
never return it as routine status, and apply a bounded TTL. Session names are
derived from the managed job ID. There is no implicit auto-resume: resume must
be an explicit operation for the same job, target fingerprint, provider, and
profile digest. Every terminal path calls explicit close; the outer process
group is still killed and orphan-checked after ACPX returns.
The preferred integration is the exported ACPX runtime with an explicit
registry and session store. It must not read global or project configuration.
The conformance spike must reject a malicious `.acpxrc`, unsafe session path,
or configuration that changes the provider command, environment, target, or
permissions.

## Target union

Local workers reuse the existing `codex-co-engineer.target.v1` contract; they
do not receive a new `repoUrl`/`startingRef` abstraction. The caller input is
exactly `schema_version`, `mode` (`default` or `explicit`), and, for an
explicit target, `working_directory`, `expected_git_root`, `expected_head`,
`allowed_paths`, and `role` (`review`, `verify`, or `implement`). The resolved
`TargetContext` additionally carries `resolved_workspace`, `resolved_cwd`,
`git_common_directory`, `observed_head`, `workspace_identity`, `cwd_identity`,
`isolation`, and `target_fingerprint`.
`target_fingerprint` is the existing SHA-256 digest over canonical resolved
workspace/cwd, Git common directory and exact HEAD, plus filesystem
device/inode identities. Dispatch requires the caller-held
`expected_target_fingerprint`; mismatch is fatal. These exact local fields
remain the source of truth for ACPX, Grok, DSH, and Codex-native workers.
`role` is authoritative: review/verify derive `read-only`; implement derives
the declared-path ceiling. Request/profile disagreement is rejected before
I/O and cannot be overridden by a prompt or provider option.
Cursor Cloud uses a separate typed target union because its workspace is
remote: `repos` entries contain `url`, optional `startingRef`, and optional
`prUrl`, alongside Cloud-only `env`, `mode`, branch, PR, and integration
settings. Local absolute paths, local inode identities, and the local target
fingerprint are invalid Cloud fields. Cloud agent-mode repository work still
requires a 40-character immutable `startingRef`; plan-mode branch references
retain their documented exploratory semantics.

## What we copy now

Borrow only the smallest validated patterns from CAO, hcom, CCB, Omnigent,
and Multica; copy them into the existing control plane without importing
their orchestration stacks:

1. ACPX's common registry and session vocabulary: create/ensure, list/show,
   prompt, event stream, cancel, mode/config selection, resume, history,
   close, export/import, and prune; use compact presets and detail-on-demand.
   This vocabulary is not a promise that every adapter optional is supported.
2. ACPX's provider registry for Grok Build and Cursor Agent instead of writing
   bespoke Grok-to-Cursor protocol bridges. Keep the exact provider command,
   version, and capability evidence in the profile.
3. CAO's explicit supervisor/worker ideas: assign a bounded role, hand off a
   result, message workers, isolate work directories, and reconcile after
   cancellation or failure. Implement them in the existing lifecycle ledger,
   rather than adding tmux as a second supervisor.
4. Capability-driven routing and usage receipts. A provider's native usage
   event is evidence; a subscription guess or model name is not.
5. One-writer/multi-reviewer coordination. Fan out independent read-only
   reviews against one immutable candidate digest, then let one authorized
   writer apply changes in one worktree.

Defer two narrow patterns for a later phase: provider-local home/auth
projection (a per-job home with only the provider state and credentials that
the adapter explicitly needs) and a compact admission policy (a cheap,
typed target/capability/capacity preflight that returns admit, reject, or
unknown before dispatch). Both remain subordinate to the control plane and
must not expose a global home, MCP configuration, or provider policy surface.

This keeps the model-facing surface small: a compact preflight/capability
response, a dispatch/continue operation, and bounded stream/wait/detail
operations. Full provider configuration, event histories, and receipts remain
available by exact ID.

## What we do not install wholesale

Do not add a second general-purpose control plane merely because it supports
many CLIs.

* **CAO:** Its repository is Apache-2.0 and its tmux/PTY supervisor is useful
  as a pattern, but it would duplicate our lifecycle, worktree, state, and
  policy authority. Its extra server, terminal sessions, and provider
  processes would introduce another process, socket, environment, and state
  boundary to audit.
* **OpenClaw or a full ACPX host stack:** ACPX itself is the selected MIT
  dependency; its surrounding host runtime and policy/sandbox assumptions are
  not required. Do not treat an ACPX/OpenClaw sandbox as child protection.
* **The alternate HenryZ DSH project:** It is not the installed official DSH
  and would conflate incompatible command names, authentication, models, and
  receipts.
* **Omnigent, Multica, CCB, hcom, Claw Orchestrator, tmux bridges, and similar
  fleet managers:** do not install them wholesale. Keep them in the catalog
  and borrow only bounded patterns after reviewing exact source commit,
  license/notices, SBOM, credential/environment handling,
  filesystem/network/socket behavior, state retention, update channel, and
  kill/reconcile semantics. The research index is not installation approval.
* **Model-only routers:** an API model call is not equivalent to a full
  harness. Do not trade away the provider's native tools, skills, context
  manager, session state, agent loop, or permission model for a superficially
  simpler inference route.

The selected components are still pinned and reviewed: ACPX is MIT; the ACP
specification repository and CAO are Apache-2.0; official DSH is MIT and
publishes third-party notices. Licenses permit evaluation, but do not remove
dependency, supply-chain, credential, or sandbox review before shipping.

## Minimal adapter contract

The following TypeScript and JSON are illustrative schema notation, not a
public wire format. The adapter owns protocol translation only; policy stays
above it. Provider profiles are discriminated, typed unions with no arbitrary
`rawConfig` or unvalidated ACP option bag.

```ts
type WorkerAdapter = {
  id: string;                         // e.g. grok-local-acp
  profile: GrokProfile | CursorLocalProfile | DshProfile | CursorCloudProfile;
  capabilities(): Promise<CapabilitySnapshot>;
  start(request: WorkerRequest): Promise<WorkerHandle>;
  events(handle: WorkerHandle): AsyncIterable<WorkerEvent>;
  usage(handle: WorkerHandle): Promise<UsageSnapshot>;
  cancel(handle: WorkerHandle, reason: string): Promise<void>;
  close(handle: WorkerHandle): Promise<void>;
  sessions?: { list(): Promise<SessionSummary[]>; get(id: string): Promise<SessionSummary> };
  resume?: (request: ResumeRequest) => Promise<WorkerHandle>; status?: (handle: WorkerHandle) => Promise<WorkerStatus>;
  setMode?: (handle: WorkerHandle, mode: TypedMode) => Promise<void>; setConfig?: (handle: WorkerHandle, config: TypedProviderConfig) => Promise<void>;
  attachments?: (handle: WorkerHandle, refs: AttachmentRef[]) => Promise<void>; mcp?: (handle: WorkerHandle, servers: TypedMcpServer[]) => Promise<void>;
};
```

Optional methods are callable only when the capability snapshot advertises the
matching operation; otherwise they return `unsupported` before provider I/O.
Those optional capabilities are provider-specific even when ACPX exposes a
shared session vocabulary.
`TypedProviderConfig`, attachments, MCP servers, modes, and model selections
are provider-specific validated schemas. Provider-specific profiles also own
the provider command, environment allowlist, version, and sandbox preset.
There is no generic subagent limit. The scheduler's Luna pool may be capped at
eight independent executors, while Cursor Cloud's API supports up to 20 custom
subagents and Grok, local Cursor, and DSH limits come from their installed
capability/profile probes. An unproven provider limit is `unknown`, not eight.
`WorkerRequest` contains only typed, bounded values; `prompt` is ephemeral and
is never written to the receipt or session ledger by this adapter:

```json
{
  "role": "implement|review|verify", "provider": "typed-profile-id",
  "model": "optional-provider-model-id",
  "target": {"kind": "local", "target_context": "existing v1 object",
    "expected_target_fingerprint": "sha256:..."},
  "prompt": "bounded ephemeral UTF-8 task text",
  "policy": {"writeCeiling": "read-only|workspace|declared-paths",
    "deadlineMs": 600000, "network": "typed-policy",
    "subagents": {"requested": true, "requestedCount": 3}},
  "context": {"promptHash": "sha256:...", "maxEvents": 2000}
}
```
For `cursor-cloud`, `target.kind` is `cursor_cloud` and carries the separate
typed `repos`/Cloud target union described above; local paths and local target
identity fields are rejected. The provider credential is selected by the
daemon/profile, never supplied as a tool argument. A failed target or profile
verification creates no provider job.
All transport bounds are byte-based after UTF-8 encoding. Proposed defaults are
64 KiB and 2,000 lines per ephemeral prompt; 256 KiB per raw ACP line/frame;
64 KiB per normalized event; 2,000 events and 8 MiB total raw output per job;
and 64 KiB per receipt/status object. Oversized control frames fail closed;
oversized text events are bounded with an explicit truncation marker. Raw
payloads are never returned to model context. The prompt hash is retained for
deduplication and audit, while the prompt text is transient; any ACPX/provider
transcript in the sensitive session store follows the TTL and access rules.
The durable receipt is intentionally compact:

```json
{
  "schema": 1, "jobId": "opaque-id", "provider": "grok-local-acp",
  "transport": "acpx-acp", "providerVersion": "installed-version",
  "providerVersionDigest": "sha256:...", "provenanceDigest": "sha256:...",
  "profileDigest": "sha256:...",
  "capabilitiesDigest": "sha256:...",
  "requested": {"model": "...", "role": "review"},
  "effective": {"profile": "..."},
  "effectiveModel": "unknown-unless-provider-proves-it",
  "targetDigest": "sha256:...", "writeCeiling": "read-only",
  "subagents": {"requested": true, "effective": "unknown"},
  "usage": {"inputTokens": null, "outputTokens": null, "totalTokens": null,
    "cost": null, "currency": null, "remaining": null, "resetAt": null,
    "confidence": "unknown", "source": "provider-native"},
  "status": "running|succeeded|failed|cancelled", "startedAt": "...",
  "finishedAt": null, "errorCode": null
}
```

Receipts contain no prompt text, credentials, personal identity, full target
contracts, or complete effective provider configuration.

## Capability and usage-aware routing

Routing first filters on required capability and target policy, then considers
fresh capacity, cost, latency, and independence. Unknown values remain
unknown; they never become `available`, zero cost, or unlimited capacity.
The only Cursor capacity boundary is typed `CursorUsageAdapter`:
```ts
type CursorUsageAdapter = {
  cloud(agentId: string, runId?: string): Promise<CursorUsage>; local(sessionId: string): Promise<CursorUsage>;
};
```
Exclude Cursor from capacity-based routing unless the selected method returns
exact usable usage; Cursor Ultra balance and reset remain `unknown`.

| Provider | Truthful capacity/usage source | Explicit limitation |
| --- | --- | --- |
| Codex/GPT | App Server `account/rateLimits/read`; optional `account/usage/read` | Report account fields returned by the session; do not infer plan balance |
| Grok Build | Native ACP `x.ai/billing` and `x.ai/session/usage` when available | Partial sessions cannot claim complete cost or remaining quota |
| Cursor Cloud | Existing Cursor Cloud Control `usage` action by exact agent/run ID | Per-agent/run tokens are available; personal Ultra plan remaining is not exposed by this API |
| Cursor local ACP | ACP usage events if the agent emits them | Personal Cursor balance and reset remain `unknown` |
| DSH/Muse Spark | Exact live DSH stream/receipt token counts | Spend, account remaining, reset, and pricing remain `unknown` unless DSH proves them |

The catalog reports provider, transport, installed version, model/mode options,
subagents, tools, and usage sources separately. Cloud models come from its
authenticated catalog; local Cursor models require a bounded ACP
initialize/status probe or remain `unknown`. Grok/DSH report only probed
features. An unproven feature fails before dispatch or is `unknown`, never
emulated; `effectiveModel` stays `unknown` unless ACP/provider evidence proves
resolution.

## Phased implementation and acceptance tests

### Phase 0 — pinned ACPX conformance spike

This proposal/conformance spike does not activate ACPX in the current release.
The candidate packages the pinned runtime plus bounded proxy, event-ledger,
session-schema/store, registry, and resource-boundary fixtures, but exposes no
public sessions tool. The Grok outer-runtime experiment is likewise separate
from direct dispatch, accepts an attested auth file rather than `XAI_API_KEY`,
and still requires real host/systemd acceptance.
Prefer the embedded exported runtime with explicit registry/`sessionStore` and
no global/project config; a CLI fallback only measures compatibility.
Pin `acpx@0.13.0`, tag `v0.13.0`, source commit
`47dc1c56b20da3c248a4a1b5c5106f52e65e6594`, and tarball integrity
`sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==`.
Freeze the lock, transitive SBOM, and notices: caret dependencies must not
float, and the ACPX/ACP API is evolving/alpha until accepted. Do not install
from `main` or auto-update. Acceptance:

* A clean temporary install reports exactly `0.13.0` and verifies the pinned
  commit/integrity and MIT notice.
* A fake ACP server passes initialize, job-derived session creation, bounded
  prompt/event parsing, explicit close, graceful cancel, and no implicit
  auto-resume; TTL and safe `sessionStore` cleanup are tested.
* Registry/command probing uses absolute validated executables, detects an
  unrelated installed `agent` collision, rejects raw user command/`--agent`
  overrides, rejects a malicious `.acpxrc`, and proves Grok `grok agent stdio`
  versus exact `cursor-agent acp` or an allowlisted `agent acp` profile.
* Child environment/cwd/state root, byte/line/event/raw-payload limits,
  timeout, outer process-group cleanup, and orphan detection are asserted;
  missing binaries and unsafe roots fail closed. Real provider smoke tests are
  read-only and run only after this proposal is accepted.

### Phase 1 — adapters and profile catalog

Implement `grok-local-acp` and `cursor-local-acp` behind `WorkerAdapter`.
Keep the official DSH rc.6 adapter and Cursor Cloud adapter separate. Add
typed profiles for review, verify, implement, and parallel-review. Acceptance:

* Every dispatch has requested/effective profile and capability evidence.
* Target, write ceiling, deadline, network policy, and provider allowlist are
  inherited by every child; a child cannot widen any value.
* Session continuation and cancellation reconcile to one terminal receipt;
  DSH fixtures exercise delegation, workflows, tool filters, child controls,
  and continuation, mapping each unproven field to `unsupported`/`unknown`.
* Cursor local and Cursor Cloud jobs cannot be confused by IDs, transport, or
  target semantics.

### Phase 2 — routing, capacity, and compact context

Use the native readers and the existing capacity aggregator. Add a small
router that selects only from capability-compatible profiles and returns a
compact decision plus exact receipt ID. Keep full configuration and event
history under exact job retrieval. Acceptance:

* A stale, partial, or unavailable provider is not selected when the requested
  policy requires fresh capacity.
* Codex, Grok, Cursor, and DSH usage fields preserve unknown/partial semantics.
* A fixture invokes `CursorUsageAdapter` through the router for both an exact
  Cloud run and an unavailable local ACP usage source; the latter is excluded
  rather than treated as zero or unlimited capacity.
* Conflicting request role or write-ceiling fields are rejected against the
  authoritative `TargetContext.role` before any provider call.
* Three recent jobs and a routing decision stay within the compact response
  budget; details remain retrievable by ID.
* No routing operation requests a new provider authorization prompt.

### Phase 3 — supervisor/worker coordination

Add bounded assign/handoff/message primitives to the lifecycle ledger. Use one
writer per worktree. Stop the writer before shared-checkout reviews, or give
each reviewer an isolated read-only worktree at the same immutable digest.
Luna, Grok, DSH, and Cursor may all be reviewers when their profiles prove the
required capability. Acceptance:

* Concurrent reviewer receipts share a candidate digest and cannot mutate the
  writer's checkout.
* Two writers for one worktree are rejected before provider submission.
* A reviewer attempting a tracked, untracked, Git-admin, or out-of-scope write
  ends as `read_only_violation`.
* Cancellation, crash, timeout, and retry preserve parent/child receipts and
  never create an orphan provider process.

### Phase 4 — rollout and regression gate

Run sequential live smoke tests for Grok local ACP, local Cursor when installed,
official DSH rc.6, Cursor Cloud, and Codex-native workers with independent
fixtures. Add conformance/receipt tests to the release gate; DSH additionally
requires exact package/source, provenance, and adapter digests in its receipt.
Acceptance:

* A normal Codex task can preflight, dispatch, stream/wait, cancel, and inspect
  a receipt using the compact tool surface.
* Restarting the MCP process preserves durable state under the provisioned
  task root; an unwritable root fails before dispatch.
* Logs and model-visible responses redact credentials, PII, prompts, and full
  provider configuration.
* A failed provider or capacity reader is isolated and cannot make another
  provider appear ready.

## Upstream references

* [ACPX repository](https://github.com/openclaw/acpx), [v0.13.0 release and verification](https://github.com/openclaw/acpx/releases/tag/v0.13.0), and [pinned CLI/session documentation](https://github.com/openclaw/acpx/blob/v0.13.0/docs/CLI.md)
* [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) and [protocol updates](https://agentclientprotocol.com/updates)
* [AWS CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator)
* [Official DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
* [Grok Build headless/ACP scripting](https://docs.x.ai/build/cli/headless-scripting) and [CLI reference](https://docs.x.ai/build/cli/reference)
* [Cursor Cloud Agent API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints), [OpenAPI specification](https://cursor.com/docs-static/cloud-agents-openapi.yaml), and [Cursor API overview](https://cursor.com/docs/api)
