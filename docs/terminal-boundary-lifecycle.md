# Terminal boundary lifecycle

Local worker finality is not the provider receipt. A stored
`completed`/`failed`/`cancelled`/`timeout`/`environment_blocked` status is a
candidate outcome. Model-facing finality requires exact systemd/cgroup proof
and, for managed worktrees, an identity-bound lock disposition.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/process-boundary.mjs`
- `plugins/codex-co-engineer/mcp/v3/supervisor.mjs`
- `plugins/codex-co-engineer/test/v3-process-boundary.test.mjs`
- `plugins/codex-co-engineer/test/v3-supervisor.test.mjs`
- `plugins/codex-co-engineer/test/r1-terminal-boundary-lifecycle.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-terminal-boundary-lifecycle-fixtures.mjs`
- this document

## Exports

`settleLocalTaskLifecycle(root, task, runtime, dependencies)` and
`cleanupLocalTaskLifecycle(root, task, runtime, dependencies)` return the same
frozen `LocalTaskLifecycleV1` object:

`version`, `task_id`, `stored_status`, `projected_status`, `public_state`,
`final`, `cleanup`, `boundary`, `lock`, `reason`.

`cleanupLocalTaskLifecycle` is the idempotent form of settlement. Neither
export deletes a worktree, branch, or evidence file.

## Tri-state boundary

Exact systemd user-unit generation plus unified cgroup v2 is the authority.
Namespace-relative `/proc` or WTB `health.state=abandoned` is never death
proof.

| State | Meaning |
| --- | --- |
| `inactive_empty` | Exact unit absent and exact cgroup path absent, or exact generation inactive with `populated 0` |
| `active` | Exact generation `active`/`activating`/`deactivating`, `populated 1`, and complete task-owned membership |
| `unknown` | Inspection unavailable, identity mismatch, incomplete PID/member visibility, or contradictory evidence |

Unknown refuses stop and lock cleanup. An identity mismatch never addresses
another task's unit.

## Settlement

For a stored-terminal local task with a process-boundary receipt:

1. Wait the drain grace.
2. Inspect the exact unit and cgroup.
3. If still `active` and identities match, snapshot Git and unrelated
   Co-Engineer units, then `systemctl --user stop` only that unit. Never kill
   an individual PID.
4. Prove `inactive_empty`, unchanged Git identity, and unchanged unrelated
   units.
5. Allow the wrapper to release its lock. If the exact lock remains, invoke
   supported `dead-local` cleanup only after that proof and exact lock
   identity. Never edit or delete a lock file.

`cleanup.status` is `normal` for a natural drain and `recovered` after an
authorized exact stop. Repeated settlement of `normal`/`recovered` performs no
further stop or lock clean.

## Projection

Accepted R-TRUTH classification runs only after lifecycle finality. While
cleanup is `pending`, `unknown`, or `failed`, public projection uses existing
`transport_lost` vocabulary and omits `result`, `handoff`, `stop_reason`, and
`finished_at`. Stored `codex-co-engineer.task.v1` bytes keep their original
terminal status; cleanup is optional and additive. Pre-contract receipts
without a local boundary stay on the R-TRUTH seam with no backfill.

## Tests

T1–T7 and both Wave25B live-cgroup/held-lock incidents are reproduced in
`r1-terminal-boundary-lifecycle.test.mjs`. Gate A remains ineligible until
those tests and independent review pass on the host boundary.
