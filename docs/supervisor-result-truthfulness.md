# Supervisor result truthfulness

The supervisor projects stored `codex-co-engineer.task.v1` receipts into
public status, task, tasks, and cancel results. One deterministic
terminal-receipt classifier sits at that projection seam, immediately
before `publicState` mapping. Later run runtime may consume the same
classifier; this slice does not cut over run orchestration.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/supervisor.mjs`
- `plugins/codex-co-engineer/test/v3-supervisor.test.mjs`
- `plugins/codex-co-engineer/test/r1-supervisor-result-truthfulness.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-supervisor-result-truthfulness-fixtures.mjs`
- this document

## Projection seam

`classifySupervisorTerminalReceipt(task)` inspects a stored receipt and
returns a frozen classification:

| Field | Meaning |
| --- | --- |
| `stored_status` | The receipt's stored status, unmodified |
| `projected_status` | Stored-vocabulary status to feed `publicState` |
| `public_state` | `publicState(projected_status)` |
| `corrected` | True only when a completed success claim is demonstrably false |
| `reason` / `error` | Bounded content-free false-success reason, or null |

`projectSupervisorTerminalReceipt` overlays `projected_status` and the
bounded reason onto the in-memory receipt used by status, task, tasks, and
cancel. It does not call `updateTask`, rewrite `task.json`, or migrate
schema `codex-co-engineer.task.v1` stored bytes.

Public `state` is still produced by `publicState` after classification.
The classifier never introduces a sixth tool, a new stored status, or a
new public state.

## Vocabularies

Stored status remains:

`completed`, `failed`, `cancelled`, `timeout`, `environment_blocked`,
`transport_lost`, `needs_attention`, `accepted`, `starting`, `running`,
`cancelling`.

Public state remains:

`succeeded`, `failed`, `cancelled`, `timed_out`, `environment_blocked`,
`transport_lost`, `needs_attention`, `accepted`, `starting`, `running`,
`cancelling`.

`succeeded` is projected only for `completed` receipts that carry neither
an explicit terminal error envelope nor a whole-result terminal
transport/provider error. A demonstrable false-success projects
`projected_status=failed` / `state=failed` with reason
`completed_with_terminal_error`. The reason never echoes provider text,
paths, URLs, or secrets.

`transport_lost` stays nonterminal reconciliation uncertainty. The
classifier does not promote it to `failed` or any stored terminal status.

## Authoritative false-success

A zero-work terminal `RetriableError [unavailable] PING timed out` stored
as `completed` is the authoritative counterexample. Whether that failure
arrives as `task.error` or as the whole `task.result`, the projection
must not report `state=succeeded`. A successful result that merely quotes
the phrase in a larger transcript remains `succeeded`.

## 3.2.1 shapes

Legacy omitted-mode `supervisorStatus(root)` keeps the 3.2.1 key set:
`version`, `healthy`, `active`, `providers`, `capabilities`,
`mcp_pending_call`, `local_boundary`, `readiness`, `tasks`. Compact
`include_tasks: false` still returns an empty `tasks` window and does not
construct omitted full receipts. Response-mode and server/tool wrappers
are unchanged.

## Non-claims

This slice does not rewrite stored bytes, migrate task schema, change
provider adapters, dispatch policy, P31 run orchestration, P32 run API,
P34 attention batching, the MCP server, tool catalog, Gate A, version, or
release. It does not mutate remotes, push, rebase, merge, tag, or open a
PR. Worker remote mutation remains denied by the accepted credential
boundary.
