# Provider capability map

Last verified: 2026-08-17

This document defines how Codex should use Grok Build, DeepSeek Harness (DSH),
Cursor Cloud Agents, and Codex-native agents without requiring the user to
operate their CLIs or dashboards.

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

`transport: auto` should use direct headless execution for bounded one-shot work
and ACP for continuation, durable interactive streaming, and richer subagent
observability. Codex should create and attest worktrees; Grok should not create
an unattested worktree behind the control plane.

Built-in Linux sandbox profiles are enforced by Grok with Landlock. Co-Engineer
must not require Bubblewrap for the built-in `workspace`, `devbox`, `read-only`,
or `strict` profiles. Bubblewrap becomes relevant only if a future custom
profile feature specifically requires it.

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
