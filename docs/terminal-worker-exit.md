# Terminal worker exit

The ACP worker is the Wave26 lifecycle worker-exit seam. Provider terminal
evidence is a candidate outcome, not model finality. This slice closes
retained ACP and child resources, attempts a bounded WTB handoff while the
sole-writer lock is still held, records that attempt as cleanup evidence,
emits terminal stdout only after that evidence exists, and then exits.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/acp-worker.mjs`
- `plugins/codex-co-engineer/test/v3-acp-worker.test.mjs`
- `plugins/codex-co-engineer/test/r1-terminal-worker-exit.test.mjs`
- `plugins/codex-co-engineer/test/r1-terminal-worker-exit-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-terminal-worker-exit-fixtures.mjs`
- this document

This slice does not own process-boundary inspection, supervisor projection,
P33 run runtime, the MCP server, or the task store.

## Ordering

1. Let the provider turn, CLI fallback, or DSH flow settle. Do not start a
   new prompt. Existing pre-dispatch CLI fallback remains allowed only before
   authoritative prompt dispatch.
2. Close retained ACP stdio clients with `discardPersistentState=false`,
   stop deadline watchers, and terminate retained child trees. Bound: 3s.
   Session identity is preserved; `session/close` is not sent.
3. Attempt a bounded WTB `handoff` while `WORKTREE_BOOTSTRAP_TASK` is set.
   Bound: 5s. Missing task name is `not_applicable`.
4. Persist the existing stored status/result together with
   `cleanup.status=pending` and a content-free close/handoff code if the
   attempt failed. Append terminal and cleanup events.
5. Write `{ task_id, status }` to stdout only after that cleanup record
   exists. Incident receipts with `finished_at` and no cleanup are refused.
6. Exit immediately, with a 1s watchdog `process.exit` if the event loop
   remains occupied by a cancelled close.

## Bounds

| Bound | Value |
| --- | --- |
| ACP / child resource close | 3000 ms |
| WTB handoff | 5000 ms |
| Post-terminal worker exit | 1000 ms |

Timeout or close failure is retained as content-free cleanup evidence. It
never enables replay, fallback, or redispatch. Success, provider failure,
cancellation, timeout, transport loss, handoff, and DSH ACPX dispatch
uncertainty keep their existing stored statuses.

## Cleanup record

Additive `task.cleanup` on existing `codex-co-engineer.task.v1` bytes:

| Field | Values |
| --- | --- |
| status | `pending` (this slice never claims `normal` or `recovered`) |
| acp_close | `closed`, `timeout`, `failed`, `not_applicable` |
| wtb_handoff | `recorded`, `timeout`, `failed`, `not_applicable` |
| code | `acp_resource_close_timeout`, `acp_resource_close_failed`, `worker_exit_timeout`, `lock_release_unproven`, `lock_cleanup_refused`, `cleanup_failed` |

Codes and messages never echo provider output, credentials, paths, or
transcripts. Supervisor lifecycle settlement remains responsible for proving
the exact systemd/cgroup boundary empty and for projecting final public
state.

## Incidents

Two real-host occurrences stored a `completed` receipt with `finished_at`
while `acp-worker.mjs` and the WTB wrapper were still in a populated task
cgroup. At this seam that is `workerSeamIncident`: a stored terminal status
and `finished_at` without recorded cleanup. The worker now refuses terminal
stdout for that shape and persists cleanup only after a bounded close
attempt.

## Non-claims

This slice does not inspect `/proc`, systemd, or cgroupfs; stop units; clean
WTB locks; rewrite accepted Wave25B/P34/R-TRUTH bytes; add a sixth tool;
migrate task schema; change version 3.2.1; or mutate remotes, protected
refs, tags, or releases. Worker remote mutation remains denied.
