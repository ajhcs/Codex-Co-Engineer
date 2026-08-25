# Run runtime (P33)

P33 `RunRuntimeV1` is the dependency-injected composition boundary over
frozen P24/P25/R24A/R25B/P27/P34 contracts. It is the sole writer of
run-level submit/resume/cancel/inspect for this slice. It does not own
the scheduler, artifact bridge, worker, process boundary, supervisor,
lock recovery, server, or candidate composer. Those seams are injected
or forbidden.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-runtime.mjs`
- `plugins/codex-co-engineer/test/r1-run-runtime.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-runtime-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-runtime-dependencies.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-runtime-fixtures.mjs`
- this document

## Factory

```js
createRunRuntime({
  runStore,
  runJournal,
  aggregateAnchor,
  attentionBatch,
  scheduler,
  artifactBridge,
  settleLocalTaskLifecycle,
  cleanupLocalTaskLifecycle,
  clock,
}) -> { submitRun, resumeRun, cancelRun, inspectRun }
```

The options object has exactly those nine keys. Extra keys, proxies,
missing methods, and non-functions fail closed. Tests inject scoped
stubs. Later lead composition injects the accepted scheduler result,
artifact-bridge result, and supervisor lifecycle exports.

`clock()` must return a UTC ISO-8601 timestamp or a safe epoch
millisecond count.

## Exact identity and one submission

`submitRun` requires the closed P24 body (`run_id`,
`request_idempotency_key`, `identity`, `git`, `provenance`, `telemetry`)
plus `assignments` (1–8). `git.base_sha` is the immutable run base.

The first exact body is the only dispatch. Durable P24 identity is the
one-submission authority: `scheduler.submitAssignments` runs only when
`runStore.submit` returns `created: true`. Exact resubmit returns
`status: "idempotent"` and does not call the scheduler again. A different
assignment body for the same `run_id` fails `runtime_identity_conflict`.

`inspectRun` and `rememberFromStore` never invent a placeholder digest or
identity fact. After restart they recover the authoritative stored
submission identity from `runStore.getByRunId` when that record is
durably available. Incomplete or unknown identity stays unknown and
fails closed: no fabricated conflict and no fabricated `created: true`
success. Conflict arbitration then belongs to `runStore.submit`.
Byte-identical resubmission returns `created: false` for inspect-first,
status-first, remember-first, and submit-first order. Every restart
permutation keeps exactly one provider dispatch. A genuinely different
immutable identity still fails `runtime_identity_conflict`.

Replay, fallback, direct-mode, merge/push/create-PR, GitHub/remote,
worktree/branch/lock, candidate, and `lifecycle_root` keys fail closed
with precise codes.

## P27 / R24A / R25B

If `aggregateAnchor.getCoordination(run_id)` exists and is not
`resolution_ready`, dispatch fails `runtime_selection_unresolved` with
zero scheduler calls and no P24 write. That is how this module consumes
ask-once P27 without owning selection persistence. When coordination is
`resolution_ready`, the journal path is R25B aggregate create/open.
When no aggregate run exists, the journal path is legacy P25 bound to
the P24 record.

## Restart, cursor, and attention

`resumeRun` inspects exact stored identities through the injected
scheduler. Cursor rows must bind the exact `assignment_id` and
`task_id`. Optional `attention_items` are latched through P34 at the
current P25 revision/head and task cursors. Routine progress never
wakes (`wake: false`). Unsupported same-session items cancel only the
affected lane through the injected scheduler.

## Lifecycle finality

P33 consumes `settleLocalTaskLifecycle(root, task, runtime, dependencies)`
and `cleanupLocalTaskLifecycle(...)`. It always passes `root = null` and
identity-only `task` / `runtime` objects. It never imports
`acp-worker.mjs` or `process-boundary.mjs`, and it never inspects
`/proc`, systemd, cgroupfs, or WTB locks.

A child terminal scheduler status is accepted into the P25 journal only
when settlement returns `final: true`. Otherwise the lane projects
`lifecycle_pending`, candidate completeness stays blocked, and no
`child_terminal` event is appended. Cleanup status/code and exact
`task_id` are copied into run evidence. `cleanupLocalTaskLifecycle` is
called idempotently on terminal, cancel, and restart.

## Proof-bound cleanup

`cancelRun({ run_id, assignment_ids, cleanup? })` cancels only the named
lanes. Artifact cleanup runs only when `cleanup: true` **and** every
targeted lane has `final: true`. The artifact bridge receives
`proof: { run_id, assignment_ids }`. Missing finality fails
`runtime_cleanup_unproven` without removing artifacts. Worktrees,
branches, locks, task receipts, and candidate refs are never deleted
here.

## Receipts

Receipts are detached and deeply frozen. They carry exact run/assignment
identity, journal revision/head, attention evidence, sanitized lifecycle
cleanup, checks, and an all-false remote-mutation map. They never echo
credentials, paths, raw stub errors, or provider transcripts.

## Composition

| Surface | Owner | Use here |
| --- | --- | --- |
| P24 durable run identity | injected `runStore` | one-submission idempotency |
| P25 six-kind journal | injected `runJournal.create/open` | `run_opened`, `child_started`, `child_progress`, `child_terminal`, `run_terminal` |
| R24A coordination | injected `aggregateAnchor.getCoordination` | `resolution_ready` gate |
| R25B aggregate journal | injected `runJournal.createAggregate/openAggregate` | journal path after P27 |
| P27 ask-once selection | already persisted on R24A | not imported; unresolved phases fail closed |
| P34 attention batch | injected `attentionBatch` | decision evidence |
| Scheduler / artifact bridge | injected results | never imported |
| Supervisor lifecycle | injected functions | finality before child terminal; idempotent cleanup |
| Server / candidate / Gate A | later slices | not imported |

## Non-goals

No scheduler, artifact-bridge, worker, process-boundary, supervisor,
server, candidate-ref, CHANGELOG, future-work, version, release, merge,
rebase, push, PR, tag, or remote mutation implementation. Gate A is not
claimed.

## Testing

```
node --no-warnings --test test/r1-run-runtime.test.mjs \
  test/r1-run-runtime-adversarial.test.mjs \
  test/r1-run-runtime-dependencies.test.mjs
```
