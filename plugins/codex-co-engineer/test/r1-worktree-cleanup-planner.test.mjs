// R1-340 proof-bound worktree cleanup planner — focused coverage: identity
// binding, dry-run plan, progressive status, safety refusals, and age is
// never deletion authority. This suite never touches a real worktree or ref.

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  PLAN_ACTIONS,
  WORKTREE_CLEANUP_CHECKS,
  WORKTREE_CLEANUP_PLANNER_SCHEMA_ID,
  WORKTREE_CLEANUP_PLANNER_VERSION,
  WORKTREE_CLEANUP_PLAN_SCHEMA_ID,
  bindWorktreeCleanupProofV1,
  cleanupBindDigestV1,
  describeWorktreeCleanupPlannerV1,
  planWorktreeCleanupV1,
} from '../mcp/v3/worktree-cleanup-planner.mjs';
import {
  ARTIFACT_PATH,
  ARTIFACT_PATH_B,
  CONTENT_FREE,
  HEAD_SHA,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_URL,
  LANE_REF,
  LOCK_ID,
  OTHER_GIT_DIR,
  OTHER_LOCK_ID,
  OTHER_SHA,
  OTHER_TASK_ID,
  TASK_ID,
  validProof,
  validTopology,
} from './fixtures/r1-worktree-cleanup-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value?.message ?? value);
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_URL), false);
  assert.equal(text.includes(HOSTILE_SECRET), false);
  for (const extra of extras) {
    assert.equal(text.includes(extra), false, `must not echo ${extra}`);
  }
}

function assertInvariants(result) {
  assert.equal(result.plan.age_authority, false);
  assert.equal(result.plan.automatic_gc, false);
  assert.equal(result.plan.dependency_graph, false);
  assert.equal(result.plan.dry_run, true);
  assert.equal(result.checks.age_not_authority, true);
  assert.equal(result.checks.ref_cas_only, true);
  assert.equal(result.checks.no_automatic_gc, true);
  assert.equal(result.checks.no_dependency_graph, true);
  assert.equal(result.checks.lock_held_until_complete, true);
  assert.equal(result.plan.lock_held_until_complete, true);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.plan));
  assert.ok(Object.isFrozen(result.statuses));
}

test('WorktreeCleanupPlannerV1 is a closed frozen pure planner', () => {
  assert.equal(WORKTREE_CLEANUP_PLANNER_SCHEMA_ID, 'codex-co-engineer.worktree-cleanup-planner.v1');
  assert.equal(WORKTREE_CLEANUP_PLANNER_VERSION, 1);
  const inventory = describeWorktreeCleanupPlannerV1();
  const again = describeWorktreeCleanupPlannerV1();
  assert.ok(Object.isFrozen(inventory));
  assert.equal(inventory.rule, 'proof_bound_dry_run_plan_without_age_gc');
  assert.equal(inventory.side_effects.filesystem_invoked, false);
  assert.equal(inventory.side_effects.git_invoked, false);
  assert.equal(inventory.side_effects.automatic_gc, false);
  assert.equal(inventory.side_effects.age_authority, false);
  assert.deepEqual([...inventory.checks], [...WORKTREE_CLEANUP_CHECKS]);
  assert.deepEqual([...inventory.plan_actions], [...PLAN_ACTIONS]);
  assert.equal(canonicalJsonStringify(inventory), canonicalJsonStringify(again));
});

test('bindWorktreeCleanupProofV1 freezes the exact identity surface', () => {
  const bound = bindWorktreeCleanupProofV1(validProof());
  assert.equal(bound.run_id, 'run-cleanup-01');
  assert.equal(bound.task_id, TASK_ID);
  assert.equal(bound.ref, LANE_REF);
  assert.equal(bound.lock_id, LOCK_ID);
  assert.equal(bound.dispatch_state, 'inactive');
  assert.deepEqual([...bound.owned_artifact_paths], [ARTIFACT_PATH, ARTIFACT_PATH_B]);
  assert.ok(Object.isFrozen(bound));
  assert.ok(Object.isFrozen(bound.owned_artifact_paths));
});

test('planWorktreeCleanupV1 emits a dry-run CAS plan and progressive status', () => {
  const first = planWorktreeCleanupV1({ proof: validProof(), topology: validTopology() });
  const second = planWorktreeCleanupV1({ proof: validProof(), topology: validTopology() });
  assert.equal(first.status, 'plan_ready');
  assert.equal(first.verdict, 'allow');
  assert.equal(first.code, null);
  assert.equal(first.plan.schema, WORKTREE_CLEANUP_PLAN_SCHEMA_ID);
  assert.equal(first.plan.operations[0].action, 'reread_topology');
  assert.equal(first.plan.operations[1].action, 'remove_worktree');
  assert.equal(first.plan.operations[1].expected_head, HEAD_SHA);
  assert.equal(first.plan.operations[1].lock_id, LOCK_ID);
  assert.equal(first.plan.operations[1].task_id, TASK_ID);
  assert.equal(first.plan.operations[2].action, 'delete_ref_cas');
  assert.equal(first.plan.operations[2].ref, LANE_REF);
  assert.equal(first.plan.operations[2].expected_sha, HEAD_SHA);
  assert.equal(first.plan.operations[3].action, 'remove_owned_artifact');
  assert.equal(first.plan.operations.at(-1).action, 'clean_lock');
  assert.equal(first.plan.operations.at(-1).lock_id, LOCK_ID);
  assert.equal(first.plan.lock_held_until_complete, true);
  assert.equal(first.checks.lock_held_until_complete, true);
  const actions = first.plan.operations.map((op) => op.action);
  assert.ok(actions.indexOf('remove_worktree') < actions.lastIndexOf('clean_lock'));
  assert.ok(actions.indexOf('delete_ref_cas') < actions.lastIndexOf('clean_lock'));
  assert.deepEqual([...PLAN_ACTIONS], [
    'reread_topology', 'remove_worktree', 'delete_ref_cas', 'remove_owned_artifact', 'clean_lock',
  ]);
  assert.equal(first.statuses.map((entry) => entry.phase).join(','),
    'bound,topology_observed,plan_ready');
  assert.equal(first.checks.inactive_task, true);
  assert.equal(first.checks.certain_dispatch, true);
  assert.equal(first.checks.known_task_state, true);
  assert.equal(first.checks.known_lock_state, true);
  assert.equal(first.checks.known_ownership, true);
  assert.equal(first.checks.non_bare_repository, true);
  assertInvariants(first);
  assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(second));
});

test('age_ms is ignored and never becomes deletion authority', () => {
  const youngActive = planWorktreeCleanupV1({
    proof: validProof(),
    topology: validTopology({ age_ms: 1, lock_state: 'active', task_state: 'active' }),
  });
  assert.equal(youngActive.status, 'refused');
  assert.equal(youngActive.code, 'active_target');
  assert.equal(youngActive.plan.operations.length, 0);

  const ancientSafe = planWorktreeCleanupV1({
    proof: validProof(),
    topology: validTopology({ age_ms: 10 ** 12 }),
  });
  assert.equal(ancientSafe.status, 'plan_ready');
  assert.equal(ancientSafe.checks.age_not_authority, true);
  assert.equal(ancientSafe.plan.age_authority, false);
  assert.ok(ancientSafe.plan.operations.some((op) => op.action === 'delete_ref_cas'));
});

test('age and GC keys on the proof fail closed', () => {
  for (const key of ['age_ms', 'max_age_ms', 'stale', 'gc', 'automatic_gc', 'older_than']) {
    const error = errorOf(() => planWorktreeCleanupV1({
      proof: validProof({ [key]: 1 }),
      topology: validTopology(),
    }));
    assert.equal(error.code === 'unknown_key' || error.code === 'invalid_format', true, key);
    assertContentFree(error);
  }
});

test('unknown task, lock, ownership, and bare repositories fail closed without deletion ops', () => {
  const cases = [
    ['unknown_task', validTopology({ task_state: 'unknown' })],
    ['unknown_lock', validTopology({ lock_state: 'unknown' })],
    ['unknown_ownership', validTopology({ lock_state: 'unlocked' })],
    ['bare_repository', validTopology({ repository_kind: 'bare' })],
  ];
  for (const [code, topology] of cases) {
    const result = planWorktreeCleanupV1({ proof: validProof(), topology });
    assert.equal(result.status, 'refused', code);
    assert.equal(result.verdict, 'deny', code);
    assert.equal(result.code, code, code);
    assert.equal(result.plan.operations.length, 0, code);
    assert.equal(result.plan.operations.some((op) => op.action === 'remove_worktree'), false, code);
    assert.equal(result.plan.operations.some((op) => op.action === 'delete_ref_cas'), false, code);
    assert.equal(result.plan.lock_held_until_complete, true, code);
    assertInvariants(result);
  }
});

test('bind digest stays stable across presence-only changes and moves when lock identity changes', () => {
  const bound = bindWorktreeCleanupProofV1(validProof());
  const held = cleanupBindDigestV1(bound, validTopology());
  const afterRemove = cleanupBindDigestV1(bound, validTopology({ worktree_present: false }));
  const afterRefGone = cleanupBindDigestV1(bound, validTopology({
    worktree_present: false,
    ref_present: false,
  }));
  assert.equal(held, afterRemove);
  assert.equal(held, afterRefGone);
  assert.notEqual(held, cleanupBindDigestV1(bound, validTopology({ lock_state: 'active' })));
  assert.notEqual(held, cleanupBindDigestV1(bound, validTopology({ git_dir: OTHER_GIT_DIR })));
});

test('refuses active, uncertain, dirty, mismatched, protected, remote, shared, and unowned targets', () => {
  const cases = [
    ['active_target', validTopology({ task_state: 'active' })],
    ['active_target', validTopology({ lock_state: 'active' })],
    ['uncertain_dispatch', validTopology({ dispatch_state: 'uncertain' })],
    ['dirty_worktree', validTopology({ dirty: true })],
    ['identity_mismatch', validTopology({ head_sha: OTHER_SHA, ref_sha: OTHER_SHA })],
    ['protected_ref', validTopology({ ref: 'refs/heads/main', ref_kind: 'local_branch' })],
    ['remote_target', validTopology({ ref: 'refs/remotes/origin/main', ref_kind: 'remote' })],
    ['shared_worktree', validTopology({ shared: true, checkout_count: 2 })],
    ['unowned_target', validTopology({ lock_id: OTHER_LOCK_ID, lock_task_id: OTHER_TASK_ID })],
    ['path_escape', validTopology({ symlink: true, path_escape: true })],
  ];
  for (const [code, topology] of cases) {
    const result = planWorktreeCleanupV1({ proof: validProof(), topology });
    assert.equal(result.status, 'refused', code);
    assert.equal(result.verdict, 'deny', code);
    assert.equal(result.code, code, code);
    assert.equal(result.plan.operations.length, 0, code);
    assert.equal(result.statuses.at(-1).phase, 'refused', code);
    assertInvariants(result);
  }
});

test('bound active or uncertain dispatch refuses even when topology is idle', () => {
  const active = planWorktreeCleanupV1({
    proof: validProof({ dispatch_state: 'active' }),
    topology: validTopology(),
  });
  assert.equal(active.code, 'active_target');
  const uncertain = planWorktreeCleanupV1({
    proof: validProof({ dispatch_state: 'uncertain' }),
    topology: validTopology(),
  });
  assert.equal(uncertain.code, 'uncertain_dispatch');
});

test('candidate and default refs are protected, never CAS-deleted', () => {
  const candidate = planWorktreeCleanupV1({
    proof: validProof(),
    topology: validTopology({
      ref: 'refs/codex-co-engineer/runs/run-cleanup-01/candidate',
      ref_kind: 'candidate',
    }),
  });
  assert.equal(candidate.code, 'protected_ref');
  assert.equal(candidate.plan.operations.some((op) => op.action === 'delete_ref_cas'), false);
});

test('idempotent plans skip missing lock, worktree, or ref without inventing deletion', () => {
  const result = planWorktreeCleanupV1({
    proof: validProof({ owned_artifact_paths: [] }),
    topology: validTopology({
      lock_state: 'unlocked',
      worktree_present: false,
      ref_present: false,
    }),
  });
  assert.equal(result.status, 'plan_ready');
  assert.deepEqual(result.plan.operations.map((op) => op.action), ['reread_topology']);
});

test('hostile proof containers fail closed without echoing secrets', () => {
  const proxy = errorOf(() => planWorktreeCleanupV1(new Proxy({
    proof: validProof(),
    topology: validTopology(),
  }, {})));
  assert.equal(proxy.code, 'proxy_denied');
  assertContentFree(proxy, [HOSTILE_SECRET]);

  const unknown = errorOf(() => planWorktreeCleanupV1({
    proof: validProof({ create_pr: true }),
    topology: validTopology(),
  }));
  assert.ok(['unknown_key', 'invalid_format'].includes(unknown.code));
  assertContentFree(unknown);
});
