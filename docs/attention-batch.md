# Attention batch (P34)

P34 is the closed `AttentionBatchV1` persistence boundary. It latches one
immutable run-level question set at one accepted P25 revision/head/cursor
boundary, accepts exactly one durable reply round, and stores delivery plus
unresolved evidence in a separate owner-only root. It does not append P25
events, encode questions in `child_progress.note`, dispatch providers,
compose a candidate, or expose a server/tool.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/attention-batch.mjs`
- `plugins/codex-co-engineer/test/r1-attention-batch.test.mjs`
- `plugins/codex-co-engineer/test/r1-attention-batch-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-attention-batch-fixtures.mjs`
- this document

## Storage

The caller supplies an existing private directory. The durable file is
always `runs/<run_id>/attention-batch.v1.json`. Directories are `0700` and
the record is `0600`. Opens are no-follow and owner-mode identity checked.
Publication uses a same-directory temporary, a complete write, file fsync,
atomic rename, and directory fsync. Mutating calls take `expected_revision`
compare-and-swap. The attention root must not be a P25 journal root and
must not contain P25 files (`journal.jsonl`, `state.json`, `created.json`,
`lock`).

## Record

Schema `codex-co-engineer.attention-batch.v1`, version `1`. Exact keys:

`schema`, `version`, `run_id`, `batch_id`, `revision`, `status`, `source`,
`items`, `reply`, `unresolved`.

Status is `open`, `reply_committed`, or `resolved`. `source` carries
`journal_revision`, `journal_head_hash`, and `task_cursors`. Each cursor and
item binds `assignment_id`, `task_id`, and `event_cursor`. Items are 1..8
unique rows sorted by `assignment_id`. Prompt is `null` or sanitized UTF-8
at most 4096 bytes; options are at most eight; the reply round is exactly
one; each response is at most 16384 bytes.

Closed vocabularies:

| Field | Values |
| --- | --- |
| provider | `grok`, `cursor-local`, `cursor-cloud`, `dsh` |
| reply_capability | `same_session`, `unsupported` |
| disposition | `pending`, `answered`, `unresolved` |
| unresolved code | `same_session_reply_unsupported`, `late_attention_after_latch`, `reply_delivery_failed`, `reply_deadline_expired`, `safe_cancel_unconfirmed` |

Grok and Cursor Local are `same_session`. DSH and Cursor Cloud are
`unsupported`. A capability mismatch fails closed.

## Transitions

1. The first durable snapshot latches one immutable question set at one P25
   revision/head and cursor boundary (`status: open`, `revision: 1`).
2. Later questions cannot create a second round. They become
   `late_attention_after_latch` and cancel only those late lanes.
3. Unsupported DSH/Cursor Cloud items become unresolved and cancel only the
   affected lane. An unconfirmed cancel also records
   `safe_cancel_unconfirmed`.
4. The reply is durable (`status: reply_committed`) before injected mailbox
   delivery. Restart retries only the exact latched
   run/assignment/task/session/question identities.
5. `resolved` is terminal when every item is `answered` or `unresolved`. A
   required unresolved item, including required late attention, blocks a
   complete candidate. Routine progress never wakes.

## API

- `openAttentionRoot(root)` — existing private directory; returns a handle.
- `handle.latch({ run_id, source, items, expected_revision, cancel?, now? })`
- `handle.reply({ run_id, batch_id, expected_revision, reply, deliver?, cancel?, now? })`
- `handle.get(run_id)`
- `describeAttentionBatchV1()`, `validateAttentionBatchRecordV1(record)`,
  `attentionQuestionDigestV1(item)`, `deriveAttentionBatchIdV1(...)`

Receipts are detached and deeply frozen. They carry the exact record plus
`created`, `complete_candidate_blocked`, `wake: false`, and
`remote_mutated: false`. Errors are typed `RunContractV1Error` values with
content-free diagnostics.

`cancel` and `deliver` are injected seams. This module does not import
mailbox, drivers, scheduler, supervisor, server, or P25.

## Ownership

| Surface | Owner | Use here |
| --- | --- | --- |
| Six P25 event kinds, hash chain, cursor, derived state | P25 | source boundary values only; never written |
| Attention snapshots, batch identity, one reply, delivery disposition, unresolved evidence | P34 | this module |

## Non-goals

No P25 event kind or schema change. No question encoding in
`child_progress.note`. No foreign P25 journal files. No scheduler, provider
dispatch, candidate composition, server/tool wiring, cleanup
implementation, Gate A, or release claim. Remote mutation stays denied.

## Testing

```
node --no-warnings --test test/r1-attention-batch.test.mjs \
  test/r1-attention-batch-adversarial.test.mjs
```
