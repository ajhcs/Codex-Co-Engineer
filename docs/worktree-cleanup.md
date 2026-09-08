# Proof-bound worktree cleanup planner (R1-340)

Lightweight planner and injected-ops adapter for manual, proof-bound
cleanup of one identified local managed worktree. This is operator
cleanup, not automatic GC. Age is never deletion authority.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/worktree-cleanup-planner.mjs`
- `plugins/codex-co-engineer/mcp/v3/worktree-cleanup-adapter.mjs`
- `plugins/codex-co-engineer/test/r1-worktree-cleanup-planner.test.mjs`
- `plugins/codex-co-engineer/test/r1-worktree-cleanup-adapter.test.mjs`
- `plugins/codex-co-engineer/test/r1-worktree-cleanup-planner-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-worktree-cleanup-fixtures.mjs`
- this document

## What it binds

One proof names the exact cleanup target:

- repository identity (`repository_path`, `base_sha`)
- task (`run_id`, `assignment_id`, `task_id`)
- worktree path
- branch/ref (owned lane ref only)
- expected HEAD and tree SHAs
- lock identity
- dispatch state (`inactive` / `active` / `uncertain`)
- owned artifact paths (P07 relative paths)

The planner is pure. Topology is a snapshot. The adapter injects
filesystem/Git operations and has no default `git` or
`worktree-bootstrap` mutation.

## Dry-run, reread, and CAS bind

`planCleanup` / `planWorktreeCleanupV1` emit progressive machine-readable
status (`bound` → `topology_observed` → `plan_ready` or `refused`) and a
dry-run plan. Ref deletion is expressed only as `delete_ref_cas` with
`expected_sha`.

Cleanup operations are ordered so the exact ownership lock stays held
until destructive work finishes:

1. `reread_topology`
2. `remove_worktree`
3. `delete_ref_cas`
4. `remove_owned_artifact`
5. `clean_lock` (last)

`executeCleanup` observes, plans, then immediately rereads worktree,
lock, and ref topology. A digest change refuses the stale plan. Before
every mutation it reobserves and CAS-binds the exact
task/lock/repository/worktree/ref/head/tree/topology digest. No actor
may reacquire or reuse the target between `clean_lock` and worktree/ref
operations because `clean_lock` cannot run while those operations remain.
Tests must inject fakes; they must not delete real worktrees or refs.

## Refusals

Cleanup is refused for active, uncertain, unknown task/lock/ownership,
bare, dirty, mismatched, protected, remote, shared, unowned, or
symlink/path-escape targets. Unknown `task_state`, unknown `lock_state`,
unknown ownership topology, and `repository_kind` `bare` fail closed and
never produce `remove_worktree` or `delete_ref_cas`. A later mutation
failure is `partial`: `cleaned` stays false, `removed` / `remaining` /
`unresolved` stay truthful and in plan order, and the ownership lock is
not released if later steps did not finish. If per-operation live
topology observation or revalidation fails after injected mutations,
`executeCleanup` halts without further mutations and returns that
partial receipt with typed `cleanup_observer_failed` instead of throwing
away applied state. Observer failure before any mutation returns a
bounded failed receipt with `cleaned` false and the lock still held.

## Non-goals

No dependency graph, no global GC, no MCP cutover, no Gate A claim, no
protected-ref mutation, and no merge/push/PR/tag/release authority.
