// R1-340 worktree cleanup adapter — focused coverage: injected observe/mutate
// seams, dry-run plans, reread-before-cleanup, CAS-only ref deletion, and
// truthful partial results. This suite never deletes a real worktree or ref.

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  WORKTREE_CLEANUP_ADAPTER_SCHEMA_ID,
  WORKTREE_CLEANUP_ADAPTER_VERSION,
  createWorktreeCleanupAdapterV1,
  describeWorktreeCleanupAdapterV1,
} from '../mcp/v3/worktree-cleanup-adapter.mjs';
import {
  ARTIFACT_PATH,
  ARTIFACT_PATH_B,
  HEAD_SHA,
  LANE_REF,
  LOCK_ID,
  createMemoryCleanupHarness,
  validProof,
} from './fixtures/r1-worktree-cleanup-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(() => action())
    .then(
      () => assert.fail('expected a typed RunContractV1Error'),
      (error) => {
        assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
        return error;
      },
    );
}

test('WorktreeCleanupAdapterV1 is a closed injected-ops adapter with no default Git mutation', () => {
  const inventory = describeWorktreeCleanupAdapterV1();
  const again = describeWorktreeCleanupAdapterV1();
  assert.equal(WORKTREE_CLEANUP_ADAPTER_SCHEMA_ID, 'codex-co-engineer.worktree-cleanup-adapter.v1');
  assert.equal(WORKTREE_CLEANUP_ADAPTER_VERSION, 1);
  assert.equal(inventory.rule, 'injected_ops_cas_bind_lock_held_until_complete');
  assert.equal(inventory.composed_surfaces.filesystem, 'injected only; no default');
  assert.equal(inventory.composed_surfaces.git, 'injected only; no default');
  assert.equal(inventory.composed_surfaces.automatic_gc, 'forbidden');
  assert.deepEqual([...inventory.always_false_side_effects], [
    'remote_mutated', 'protected_ref_mutated', 'automatic_gc', 'real_git_default',
    'dependency_graph',
  ]);
  assert.equal(canonicalJsonStringify(inventory), canonicalJsonStringify(again));
});

test('planCleanup is a dry-run that never calls mutators', async () => {
  const harness = createMemoryCleanupHarness();
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.planCleanup({ proof: validProof() });
  assert.equal(receipt.mode, 'dry_run');
  assert.equal(receipt.status, 'dry_run');
  assert.equal(receipt.verdict, 'allow');
  assert.equal(receipt.cleaned, false);
  assert.equal(receipt.dry_run, true);
  assert.equal(receipt.proof_bound, true);
  assert.equal(receipt.automatic_gc, false);
  assert.equal(receipt.age_authority, false);
  assert.equal(harness.calls.observe, 1);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(harness.calls.removeWorktree, 0);
  assert.equal(harness.calls.deleteRefCas, 0);
  assert.equal(harness.calls.removeOwnedArtifact, 0);
  assert.equal(receipt.plan.operations[2].action, 'delete_ref_cas');
  assert.equal(receipt.plan.operations[2].expected_sha, HEAD_SHA);
  assert.equal(receipt.plan.operations[2].ref, LANE_REF);
  assert.equal(receipt.plan.operations.at(-1).action, 'clean_lock');
  assert.equal(receipt.plan.lock_held_until_complete, true);
  assert.equal(receipt.statuses.at(-1).phase, 'dry_run');
  assert.equal(receipt.side_effects.real_git_default, false);
  assert.equal(receipt.side_effects.remote_mutated, false);
});

test('executeCleanup rereads topology then applies injected CAS operations', async () => {
  const harness = createMemoryCleanupHarness();
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.mode, 'execute');
  assert.equal(receipt.status, 'cleaned');
  assert.equal(receipt.cleaned, true);
  assert.equal(receipt.verdict, 'allow');
  assert.equal(harness.calls.observe, 7);
  assert.equal(harness.calls.cleanLock, 1);
  assert.equal(harness.calls.removeWorktree, 1);
  assert.equal(harness.calls.deleteRefCas, 1);
  assert.equal(harness.calls.removeOwnedArtifact, 2);
  assert.equal(receipt.adapter_checks.topology_reread_before_cleanup, true);
  assert.equal(receipt.adapter_checks.cas_bind_before_each_mutation, true);
  assert.equal(receipt.adapter_checks.lock_held_until_complete, true);
  assert.equal(receipt.reread_digest, receipt.topology_digest);
  assert.equal(receipt.reread_bind_digest, receipt.bind_digest);
  assert.equal(receipt.plan.operations.at(-1).action, 'clean_lock');
  assert.deepEqual(harness.applied.map((item) => item.kind), [
    'remove_worktree',
    'delete_ref_cas',
    'remove_owned_artifact',
    'remove_owned_artifact',
    'clean_lock',
  ]);
  assert.equal(receipt.side_effects.lock_cleaned, true);
  assert.equal(receipt.side_effects.worktree_removed, true);
  assert.equal(receipt.side_effects.ref_deleted, true);
  assert.equal(receipt.side_effects.artifacts_removed, true);
  assert.equal(receipt.side_effects.protected_ref_mutated, false);
  assert.equal(receipt.remaining.length, 0);
  assert.deepEqual(harness.applied[1], {
    kind: 'delete_ref_cas',
    ref: LANE_REF,
    expected_sha: HEAD_SHA,
  });
  assert.equal(receipt.statuses.map((entry) => entry.phase).includes('topology_reread'), true);
  assert.equal(receipt.statuses.at(-1).phase, 'cleaned');
});

test('execute without injected mutators fails closed and mutates nothing', async () => {
  const harness = createMemoryCleanupHarness();
  const adapter = createWorktreeCleanupAdapterV1({
    observeTopology: harness.ops.observeTopology,
  });
  const error = await errorOf(() => adapter.executeCleanup({ proof: validProof() }));
  assert.equal(error.code, 'cleanup_executor_required');
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(harness.calls.removeWorktree, 0);
  assert.equal(harness.calls.deleteRefCas, 0);
});

test('factory without an observer fails closed', () => {
  assert.throws(
    () => createWorktreeCleanupAdapterV1({}),
    (error) => error instanceof RunContractV1Error && error.code === 'cleanup_observer_required',
  );
});

test('partial cleanup remains truthful when a later mutation fails', async () => {
  const harness = createMemoryCleanupHarness();
  harness.failOn('removeWorktree', 'worktree_remove_failed');
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.cleaned, false);
  assert.equal(receipt.verdict, 'deny');
  assert.equal(receipt.code, 'cleanup_mutation_failed');
  assert.deepEqual(receipt.removed, []);
  assert.ok(receipt.remaining.includes('remove_worktree'));
  assert.ok(receipt.remaining.some((item) => item.startsWith('delete_ref_cas:')));
  assert.ok(receipt.remaining.some((item) => item.startsWith(`clean_lock:${LOCK_ID}`)));
  assert.ok(receipt.unresolved.some((item) => item.action === 'remove_worktree'));
  assert.equal(receipt.side_effects.lock_cleaned, false);
  assert.equal(receipt.side_effects.worktree_removed, false);
  assert.equal(receipt.side_effects.ref_deleted, false);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(harness.calls.deleteRefCas, 0);
  assert.equal(receipt.adapter_checks.partial_cleanup_truthful, true);
  assert.equal(receipt.adapter_checks.lock_held_until_complete, true);
});

test('live observe failure after remove_worktree returns a partial receipt and keeps the lock', async () => {
  const harness = createMemoryCleanupHarness();
  harness.failObserveOn(4);
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.cleaned, false);
  assert.equal(receipt.verdict, 'deny');
  assert.equal(receipt.code, 'cleanup_observer_failed');
  assert.deepEqual(receipt.removed, ['remove_worktree']);
  assert.deepEqual(harness.applied.map((item) => item.kind), ['remove_worktree']);
  assert.deepEqual(receipt.remaining, [
    `delete_ref_cas:${LANE_REF}`,
    `remove_owned_artifact:${ARTIFACT_PATH}`,
    `remove_owned_artifact:${ARTIFACT_PATH_B}`,
    `clean_lock:${LOCK_ID}`,
  ]);
  assert.deepEqual(receipt.unresolved[0], {
    action: 'delete_ref_cas',
    code: 'cleanup_observer_failed',
  });
  assert.equal(receipt.side_effects.lock_cleaned, false);
  assert.equal(receipt.side_effects.worktree_removed, true);
  assert.equal(receipt.side_effects.ref_deleted, false);
  assert.equal(harness.calls.removeWorktree, 1);
  assert.equal(harness.calls.deleteRefCas, 0);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(harness.calls.removeOwnedArtifact, 0);
  assert.equal(receipt.adapter_checks.partial_cleanup_truthful, true);
  assert.equal(receipt.adapter_checks.lock_held_until_complete, true);
  assert.equal(receipt.bound.lock_id, LOCK_ID);
  assert.equal(receipt.bound.expected_head, HEAD_SHA);
  assert.equal(receipt.topology_digest, receipt.reread_digest);
  assert.equal(receipt.bind_digest, receipt.reread_bind_digest);
});

test('observer failure before any mutation returns a bounded failed receipt', async () => {
  const harness = createMemoryCleanupHarness();
  harness.failObserveOn(3);
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.cleaned, false);
  assert.equal(receipt.verdict, 'deny');
  assert.equal(receipt.code, 'cleanup_observer_failed');
  assert.deepEqual(receipt.removed, []);
  assert.ok(receipt.remaining.includes('remove_worktree'));
  assert.ok(receipt.remaining.some((item) => item.startsWith('delete_ref_cas:')));
  assert.ok(receipt.remaining.some((item) => item.startsWith(`clean_lock:${LOCK_ID}`)));
  assert.deepEqual(receipt.unresolved[0], {
    action: 'remove_worktree',
    code: 'cleanup_observer_failed',
  });
  assert.equal(receipt.side_effects.lock_cleaned, false);
  assert.equal(harness.calls.removeWorktree, 0);
  assert.equal(harness.calls.deleteRefCas, 0);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(receipt.adapter_checks.lock_held_until_complete, true);
});

test('execute refuses an already-active target without calling mutators', async () => {
  const harness = createMemoryCleanupHarness();
  harness.setTopology({ task_state: 'active' });
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.code, 'active_target');
  assert.equal(receipt.cleaned, false);
  assert.equal(harness.calls.observe, 1);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(harness.calls.deleteRefCas, 0);
});
