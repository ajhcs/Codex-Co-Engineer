# Run tool API (R-CUTOVER)

R-CUTOVER is the additive five-tool wiring of bounded runs onto the
3.2.1 MCP catalog. It does not add a sixth tool. Submit, status, wait,
attention, reply, cancel, and cleanup are parameters and modes on
`status`, `delegate`, `task`, `tasks`, and `cancel`.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-tool-adapter.mjs`
- `plugins/codex-co-engineer/mcp/v3/server.mjs`
- `plugins/codex-co-engineer/mcp/v3/supervisor.mjs`
- `plugins/codex-co-engineer/test/r1-run-tool-adapter.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-tool-adapter-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-tool-adapter-fixtures.mjs`
- this document

## Catalog

The public catalog remains exactly:

`status`, `delegate`, `task`, `tasks`, `cancel`

Omitted additive fields preserve exact 3.2.1 direct/single-task/full-text/
structured/wait/diagnostic/reply/cancel behavior and response shapes.

## Frozen mapping

| Operation | Tool | Additive parameter or mode |
| --- | --- | --- |
| submit | `delegate` | `run` |
| status | `status` or `task` | `run_id` |
| wait | `task` or `tasks` | `run_id` plus `wait_until: "decision_or_attention"` |
| attention | `task` | `run_id` plus `attention` |
| reply | `task` | `run_id` plus `run_reply` |
| cancel | `cancel` | `run_id` plus optional `assignment_ids` |
| cleanup | `cancel` | `run_id` plus `cleanup: true` |

`wait_until` remains `progress` and `terminal` for 3.2.1. The additive
run mode is `decision_or_attention`. Routine progress never wakes.

Mixing a run body with 3.2.1 `task_id` / `workspace_mode` / `create_pr` /
`reply` fields fails closed.

## Bounds and selection

One run submission carries 1–8 lanes. Provider/model is explicit on each
assignment or left unresolved; the adapter never learns, ranks, or
globally routes. The accepted four-slot registry is `grok`,
`cursor-local`, `cursor-cloud`, and `dsh`. P22 future-harness
conformance remains evidence, never a provider slot.

Direct mode, replay, fallback, merge, push, create-PR, GitHub, and
remote keys fail before any provider dispatch, ref creation, or cleanup.

## Authority preserved

| Surface | Owner | Use here |
| --- | --- | --- |
| One-submission runtime, proof-bound cleanup, lifecycle finality | P33 | injected `submitRun` / `inspectRun` / `resumeRun` / `cancelRun` |
| Attention latch and exactly-once reply | P34 | `resumeRun` attention items and injected `attention.reply` |
| Run-owned candidate ref | P35 | projected `refs/codex-co-engineer/runs/<run-id>/candidate`; never composed here |
| Four-slot provider composition | P23 | exact `{provider, model}` lookup; no fallback |
| Terminal false-success projection | R-TRUTH | model-facing lane receipts |
| Remote mutation denial | P29 / P28 | `denyRunToolRemoteMutationV1` |

Unaffected lanes continue. A required unresolved lane blocks a complete
candidate. Decision results are the verified P33/P34 receipts, not caller
prose. MCP output is model-facing: owner-only raw artifacts are stripped.

## API

- `classifyRunToolCall(tool, args)` — pure; `legacy` or `run`
- `createRunToolAdapter({ runtime, attention?, projectLaneTask?, classifyLaneTask?, rememberSubmitContext? })`
- `createInProcessRunSeams({ delegateTask, inspectTask, cancelTask, settleLocalTaskLifecycle, cleanupLocalTaskLifecycle, clock? })`
- `describeRunToolAdapterV1()`
- `denyRunToolRemoteMutationV1(operation)`

## Testing

```
node --no-warnings --test test/r1-run-tool-adapter.test.mjs \
  test/r1-run-tool-adapter-adversarial.test.mjs \
  test/v3-server.test.mjs \
  test/v3-supervisor.test.mjs
```
