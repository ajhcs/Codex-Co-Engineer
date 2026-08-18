# Provider capability map

Last verified: 2026-08-17

This document defines how Codex should use Grok Build, DeepSeek Harness (DSH),
Cursor Cloud Agents, the local Cursor CLI, and Codex-native agents without
requiring the user to operate their CLIs or dashboards.

## Design rule

Codex is the cockpit. Provider credentials and subscriptions are configured
once and are standing authorization for task-scoped work. The control plugins
should expose all supported harness capabilities through the smallest stable
tool surface, using compact profiles and dynamic catalogs instead of copying
provider configuration into every call.

The wrappers own only:

- exact target and Git identity;
- typed option translation;
- process/API lifecycle, cancellation, and reconciliation;
- bounded redaction and compact receipts;
- write-scope and destructive-operation controls.

They should not reimplement provider agents, add per-run egress approvals, or
hard-code model catalogs that providers can return dynamically.

## Grok Build and Grok 4.6

Installed harness: Grok Build CLI 1.0.4 (`d846eb93d9`).

Official Grok 4.6 properties:

- default coding model in Grok Build;
- 500,000-token context window;
- text and image input, text output;
- reasoning levels `low`, `medium`, `high`, and `xhigh`;
- function calling, web search, X search, and code execution;
- intended for long-running, multi-step agent work.

The CLI exposes model and reasoning selection, streaming and structured output,
sessions/resume/fork, max turns, permission rules, built-in sandbox profiles,
tool filters, rules/system prompts, memory and web controls, subagents, custom
agent definitions, worktrees, MCP, plugins, hooks, skills, workflows, background
tasks, and ACP (`grok agent stdio`).

Grok CLI subagents and xAI's separate multi-agent API models are different
features. Co-Engineer must identify them separately and never imply that
`no_subagents` controls a server-side multi-agent model.

Smallest useful profile:

```json
{
  "model": "grok-4.6",
  "reasoning_effort": "high",
  "transport": "auto",
  "delegation": {"enabled": true, "agent": "general-purpose"},
  "sandbox_profile": "workspace",
  "permission_mode": "auto",
  "memory": "enabled",
  "web_search": "enabled",
  "output_format": "streaming-json"
}
```

The current public transport is direct headless execution. Pinned ACPX and
bounded ACP helpers are packaged as an unwired conformance experiment; there
is no public sessions tool. Codex should create and attest worktrees; Grok
should not create an unattested worktree behind the control plane.

Built-in Linux sandbox profiles remain the boundary for public direct dispatch.
The separate Bubblewrap outer-boundary experiment is unwired, accepts an
attested auth file rather than `XAI_API_KEY`, and still requires real
host/systemd acceptance.

Sources:

- [Grok 4.6](https://docs.x.ai/developers/grok-4-6)
- [Grok Build CLI reference](https://docs.x.ai/build/cli/reference)
- [Headless and ACP scripting](https://docs.x.ai/build/cli/headless-scripting)
- [Sandbox profiles](https://docs.x.ai/build/features/sandbox)
- [Subagents](https://docs.x.ai/build/features/subagents)
- [Worktrees](https://docs.x.ai/build/features/worktrees)

## DSH and Muse Spark 1.2 Contributor

Installed harness: DeepSeek Harness 0.1.0-rc.6.

The installed headless profile declares:

- provider `meta`;
- model `muse-spark-1.2-contributor`;
- 1,048,576-token context window;
- 131,072 maximum output tokens;
- text and image input;
- OpenAI-compatible completions transport.

Those limits are local profile declarations and must not be represented as
independently verified provider guarantees.

DSH itself provides substantially more capability than the current one-shot
Co-Engineer connector exposes:

- spawned, forked, and continuable subagents;
- child follow-up, interrupt, descendant listing, personas, tool filters,
  depth limits, and structured output;
- parallel and pipeline workflows with per-agent model overrides;
- Ralph-style iterative delegation;
- filesystem/search/bash/jobs/plans/goals, token metering, images, and web
  search;
- adapter-level streaming of text, reasoning, tool calls, usage, and finish;
- JSONL sessions;
- read-only, workspace-write, and danger-full-access filesystem modes.

The current headless runner collapses this to one default-model turn and final
text. Co-Engineer should extend it with vetted profile aliases or typed headless
options rather than expose arbitrary patch paths.

Smallest useful DSH profile:

```text
profile, provider, model, optional advertised reasoning,
bounded max_tokens, sandbox_profile,
subagent_mode, max_depth, tool_preset, workflow_preset, timeout
```

Status must distinguish installed modules from features actually presented to
the model. Unknown Muse reasoning, tool-call, pricing, latency, or quota facts
must remain `unknown`; generic adapter support is not proof of model support.
The installed profile reports DSH subagent/fork support and requested policy,
but effectiveness stays `unknown` without provider proof. Trusted receipts can
report exact job tokens; Muse spend, remaining quota, pricing, and reset remain
unknown.

The DSH profile currently tries to materialize composed configuration beneath
its protected home directory. Installation/bootstrap should pre-materialize the
profile or give DSH a stable task-writable profile/state root so ordinary Codex
sandboxes do not fail with `EROFS`.

Source:

- [Meta Muse Spark announcement](https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/)

## Cursor Cloud Agents and its model catalog

Cursor Cloud Agents API v1 is a durable agent/run API, not a raw inference API.
Its authenticated `GET /v1/models` response is the model source of truth. It
returns model IDs, aliases, descriptions, parameters, variants, and defaults for
the configured account.

The plugin must not hard-code Grok 4.6, Composer, Claude, Gemini, or other model
IDs. It should cache and expose the account catalog compactly, pass an explicit
selection unchanged, and report an omitted selection as `account-default`.
The current official API documents no resolved-model response field, so
effective model remains `unknown` for now; do not infer it from the request.
The same rule applies to repository `startingRef` and the remote workspace
head/branch: a create request or receipt acceptance is not checkout
attestation. Cursor Cloud Control therefore records caller input under
`requestedConfiguration` and exposes `providerVerification` as
`unverified` until a documented provider response field proves the effective
ref, model, or workspace. Its 0.3.x `effectiveConfiguration` field is a
deprecated caller-derived compatibility alias, not evidence of provider state.

Cloud API v1 supports:

- prompts with up to five images;
- dynamic model IDs and model parameters;
- cloud or self-hosted environments;
- up to 20 repositories with starting refs and optional PR URLs;
- current/new branch and automatic-PR controls;
- environment variables and inline HTTP/SSE/stdio MCP servers;
- up to 20 custom subagents with inherited or explicit models;
- agent and plan modes;
- durable agents with follow-up runs;
- bounded SSE streaming and `Last-Event-ID` resume;
- cancellation, archive/unarchive, permanent delete;
- artifact listing/download and agent/run usage.

Cursor's SDK and UI expose additional features—local runtimes, skills, hooks,
custom functions, auto-review, custom stores, and nested subagents—that are not
all Cloud API request fields. The control plane must label API, SDK, and UI
capabilities separately.

Keep the existing six-tool surface:

1. `status` — local readiness, compact identity, dynamic models, repositories;
2. `agents` — list/get/create;
3. `runs` — list/get/follow-up/wait/stream/cancel;
4. `artifacts` — list/download;
5. `usage`;
6. `lifecycle` — archive/unarchive/delete.

Normal Codex recipes should need only two or three calls: compact preflight,
create/continue, then bounded stream or wait. Full details remain available by
exact ID.

Sources:

- [Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Cloud Agents OpenAPI](https://cursor.com/docs-static/cloud-agents-openapi.yaml)
- [Cursor API overview](https://cursor.com/docs/api)
- [Cursor SDK release](https://cursor.com/changelog/sdk-release)
- [Cursor SDK subagent/tool updates](https://cursor.com/changelog/sdk-updates-jun-2026)

## Cursor Local CLI

The `cursor-local-control` MCP server is a separately packaged, typed adapter
for the administrator-installed Cursor Agent CLI on Plumbob. Its foundation
retains three contracts (`status`, `run`, and `runs`), but the shipped wire
catalog exposes only `status` (with local/auth/permissions actions): provider
dispatch and process lifecycle are intentionally unexposed and fail-closed
pending real Cursor plus Bubblewrap host acceptance. Local IDs, state,
credentials, permissions, worktrees, and receipts never share the Cursor
Cloud ledger. The local wire identity is versioned independently at 0.1.0
inside Cursor package 0.3.0.

The deferred adapter contract requires an explicit absolute workspace in an
administrator-owned allowlist, an owner-only CLI home and permission
configuration, and a dedicated Cursor executable path. It specifies Ask mode
for read-only work and an isolated worktree for implementation in a future
accepted foundation, but neither provider run mode is operational in this
release. Generic
`agent` aliases, Cloud IDs, arbitrary shell commands, login/update commands,
and arbitrary MCP configuration are rejected. Status may report a pinned,
provider-free native sandbox preflight, but a digest or preflight alone is not
an execution attestation; direct foundation calls return
`foundation_not_exposed` in this release.

Sources:

- [Cursor CLI installation](https://cursor.com/docs/cli/installation)
- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)
- [Cursor CLI headless mode](https://cursor.com/docs/cli/headless)
- [Cursor CLI permissions](https://cursor.com/docs/cli/reference/permissions)

## Codex-native routing

Codex-native subagents remain the lowest-friction option for local independent
analysis, small implementation slices, and review because they share the app's
task context and require no provider translation. The orchestration layer should
select among native Luna executors, Grok, DSH/Muse, and Cursor based on the
requested role, provider-reported capability, latency/cost preference, and
independence—not by hiding any provider's feature set.

Every receipt should record requested versus effective provider, model/profile,
delegation state, target digest, and terminal outcome. It should not include
prompts, credentials, personal identity, or complete provider configuration.
