// R1-340 worktree cleanup hostile races: ref moves after plan, lock
// reactivation, worktree reuse, dirty-after-plan, symlink/path escape,
// active task, uncertain dispatch, and partial cleanup truthfulness.
// Injected fakes only — this suite never deletes a real worktree or ref.

import assert from 'node:assert/strict';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  createWorktreeCleanupAdapterV1,
} from '../mcp/v3/worktree-cleanup-adapter.mjs';
import {
  planWorktreeCleanupV1,
} from '../mcp/v3/worktree-cleanup-planner.mjs';
import {
  CONTENT_FREE,
  ESCAPE_PATH,
  GIT_DIR,
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
  WORKTREE_PATH,
  createMemoryCleanupHarness,
  validProof,
  validTopology,
} from './fixtures/r1-worktree-cleanup-fixtures.mjs';

function assertContentFreeError(error, extras = []) {
  assert.ok(error instanceof RunContractV1Error);
  assert.match(error.message, CONTENT_FREE);
  const text = `${error.message}\n${error.path ?? ''}`;
  assert.equal(text.includes(ESCAPE_PATH), false);
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_URL), false);
  assert.equal(text.includes(HOSTILE_SECRET), false);
  for (const extra of extras) {
    assert.equal(text.includes(extra), false, `must not echo ${extra}`);
  }
}

function assertNoMutations(harness) {
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(harness.calls.removeWorktree, 0);
  assert.equal(harness.calls.deleteRefCas, 0);
  assert.equal(harness.calls.removeOwnedArtifact, 0);
}

async function executeWithRace(firstTopology, secondTopology) {
  const harness = createMemoryCleanupHarness(firstTopology);
  harness.queueObserves({}, secondTopology);
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  return { harness, receipt };
}

test('ref move after plan refuses CAS deletion and mutates nothing', async () => {
  const planned = await createWorktreeCleanupAdapterV1(
    createMemoryCleanupHarness().ops,
  ).planCleanup({ proof: validProof() });
  assert.equal(planned.verdict, 'allow');
  assert.equal(planned.plan.operations[2].expected_sha, HEAD_SHA);
  assert.equal(planned.plan.operations.at(-1).action, 'clean_lock');

  const { harness, receipt } = await executeWithRace(
    validTopology(),
    { head_sha: OTHER_SHA, ref_sha: OTHER_SHA },
  );
  assert.equal(receipt.status, 'refused');
  assert.ok(receipt.code === 'identity_mismatch' || receipt.code === 'topology_changed');
  assert.equal(receipt.cleaned, false);
  assert.notEqual(receipt.reread_digest, receipt.topology_digest);
  assert.equal(receipt.adapter_checks.topology_reread_before_cleanup, true);
  assert.equal(receipt.adapter_checks.stale_plan_refused, true);
  assert.ok(receipt.remaining.some((item) => item.startsWith('delete_ref_cas:')));
  assertNoMutations(harness);
});

test('lock reactivation after plan refuses cleanup', async () => {
  const { harness, receipt } = await executeWithRace(
    validTopology(),
    { lock_state: 'active' },
  );
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.code, 'active_target');
  assert.equal(receipt.cleaned, false);
  assertNoMutations(harness);
});

test('worktree reuse after plan refuses the stale identity', async () => {
  const { harness, receipt } = await executeWithRace(
    validTopology(),
    {
      git_dir: OTHER_GIT_DIR,
      lock_id: OTHER_LOCK_ID,
      lock_task_id: OTHER_TASK_ID,
      head_sha: OTHER_SHA,
      ref_sha: OTHER_SHA,
    },
  );
  assert.equal(receipt.status, 'refused');
  assert.ok(['unowned_target', 'identity_mismatch', 'topology_changed'].includes(receipt.code));
  assert.equal(receipt.cleaned, false);
  assertNoMutations(harness);
});

test('dirty-after-plan refuses and does not delete the ref', async () => {
  const { harness, receipt } = await executeWithRace(
    validTopology(),
    { dirty: true },
  );
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.code, 'dirty_worktree');
  assert.equal(receipt.side_effects.ref_deleted, false);
  assertNoMutations(harness);
});

test('symlink and path-escape topology is refused without echoing the escape path', () => {
  const result = planWorktreeCleanupV1({
    proof: validProof(),
    topology: validTopology({
      symlink: true,
      path_escape: true,
      worktree_realpath: ESCAPE_PATH,
    }),
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'path_escape');
  assert.equal(result.plan.operations.length, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ESCAPE_PATH), false);
  assert.equal(result.statuses.at(-1).code, 'path_escape');
});

test('symlink escape on reread refuses execute without mutation', async () => {
  const { harness, receipt } = await executeWithRace(
    validTopology(),
    {
      symlink: true,
      path_escape: true,
      worktree_realpath: ESCAPE_PATH,
    },
  );
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.code, 'path_escape');
  assertNoMutations(harness);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(ESCAPE_PATH), false);
});

test('active task is refused by both planner and adapter', async () => {
  const planned = planWorktreeCleanupV1({
    proof: validProof(),
    topology: validTopology({ task_state: 'active' }),
  });
  assert.equal(planned.code, 'active_target');
  const harness = createMemoryCleanupHarness(validTopology({ task_state: 'active' }));
  const receipt = await createWorktreeCleanupAdapterV1(harness.ops)
    .executeCleanup({ proof: validProof() });
  assert.equal(receipt.code, 'active_target');
  assert.equal(receipt.cleaned, false);
  assertNoMutations(harness);
});

test('uncertain dispatch is refused and never inferred from age', () => {
  const result = planWorktreeCleanupV1({
    proof: validProof(),
    topology: validTopology({
      dispatch_state: 'uncertain',
      age_ms: 86_400_000,
    }),
  });
  assert.equal(result.code, 'uncertain_dispatch');
  assert.equal(result.plan.age_authority, false);
  assert.equal(result.checks.age_not_authority, true);
});

test('partial cleanup truthfulness: lock stays held, later steps remain, cleaned is false', async () => {
  const harness = createMemoryCleanupHarness();
  harness.failOn('deleteRefCas', 'ref_cas_mismatch');
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.cleaned, false);
  assert.equal(receipt.proof_bound, true);
  assert.equal(receipt.removed.includes(`clean_lock:${LOCK_ID}`), false);
  assert.ok(receipt.removed.includes('remove_worktree'));
  assert.equal(receipt.removed.some((item) => item.startsWith('delete_ref_cas:')), false);
  assert.ok(receipt.remaining.some((item) => item.startsWith('delete_ref_cas:')));
  assert.ok(receipt.remaining.some((item) => item.startsWith('remove_owned_artifact:')));
  assert.ok(receipt.remaining.some((item) => item.startsWith(`clean_lock:${LOCK_ID}`)));
  assert.deepEqual(receipt.unresolved[0], { action: 'delete_ref_cas', code: 'ref_cas_mismatch' });
  assert.equal(receipt.side_effects.lock_cleaned, false);
  assert.equal(receipt.side_effects.worktree_removed, true);
  assert.equal(receipt.side_effects.ref_deleted, false);
  assert.equal(receipt.side_effects.artifacts_removed, false);
  assert.equal(harness.calls.deleteRefCas, 1);
  assert.equal(harness.calls.removeOwnedArtifact, 0);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(receipt.adapter_checks.partial_cleanup_truthful, true);
  assert.equal(receipt.adapter_checks.lock_held_until_complete, true);
});

function assertNoDestructiveOps(result) {
  const actions = (result.plan?.operations ?? []).map((op) => op.action);
  assert.equal(actions.includes('remove_worktree'), false);
  assert.equal(actions.includes('delete_ref_cas'), false);
}

test('unknown task, lock, and ownership fail closed with no worktree or ref deletion', async () => {
  const cases = [
    ['unknown_task', validTopology({ task_state: 'unknown' })],
    ['unknown_lock', validTopology({ lock_state: 'unknown' })],
    ['unknown_ownership', validTopology({ lock_state: 'unlocked' })],
  ];
  for (const [code, topology] of cases) {
    const planned = planWorktreeCleanupV1({ proof: validProof(), topology });
    assert.equal(planned.code, code, code);
    assert.equal(planned.status, 'refused', code);
    assertNoDestructiveOps(planned);

    const harness = createMemoryCleanupHarness(topology);
    const receipt = await createWorktreeCleanupAdapterV1(harness.ops)
      .executeCleanup({ proof: validProof() });
    assert.equal(receipt.status, 'refused', code);
    assert.equal(receipt.code, code, code);
    assert.equal(receipt.cleaned, false, code);
    assertNoDestructiveOps(receipt);
    assertNoMutations(harness);
  }
});

test('bare repositories fail closed and never emit worktree or ref deletion', async () => {
  const topology = validTopology({ repository_kind: 'bare' });
  const planned = planWorktreeCleanupV1({ proof: validProof(), topology });
  assert.equal(planned.code, 'bare_repository');
  assert.equal(planned.status, 'refused');
  assertNoDestructiveOps(planned);

  const harness = createMemoryCleanupHarness(topology);
  const receipt = await createWorktreeCleanupAdapterV1(harness.ops)
    .executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.code, 'bare_repository');
  assert.equal(receipt.cleaned, false);
  assertNoDestructiveOps(receipt);
  assertNoMutations(harness);
});

test('lock reacquisition after the first mutation halts remaining worktree/ref/lock ops', async () => {
  const harness = createMemoryCleanupHarness();
  harness.mutateAfter('removeWorktree', {
    lock_state: 'active',
  });
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.cleaned, false);
  assert.deepEqual(receipt.removed, ['remove_worktree']);
  assert.ok(receipt.remaining.some((item) => item.startsWith('delete_ref_cas:')));
  assert.ok(receipt.remaining.some((item) => item.startsWith(`clean_lock:${LOCK_ID}`)));
  assert.ok(['active_target', 'unowned_target', 'topology_changed'].includes(receipt.unresolved[0].code));
  assert.equal(receipt.unresolved[0].action, 'delete_ref_cas');
  assert.equal(harness.calls.removeWorktree, 1);
  assert.equal(harness.calls.deleteRefCas, 0);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(receipt.side_effects.lock_cleaned, false);
  assert.equal(receipt.side_effects.ref_deleted, false);
  assert.equal(receipt.adapter_checks.cas_bind_before_each_mutation, true);
  assert.equal(receipt.adapter_checks.lock_held_until_complete, true);
  assert.equal(receipt.adapter_checks.partial_cleanup_truthful, true);
});

test('worktree reuse after the first mutation does not delete the new identity', async () => {
  const harness = createMemoryCleanupHarness();
  harness.mutateAfter('removeWorktree', {
    worktree_present: true,
    git_dir: OTHER_GIT_DIR,
    lock_id: OTHER_LOCK_ID,
    lock_task_id: OTHER_TASK_ID,
    head_sha: OTHER_SHA,
    ref_sha: OTHER_SHA,
  });
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.cleaned, false);
  assert.deepEqual(receipt.removed, ['remove_worktree']);
  assert.ok(receipt.remaining.some((item) => item.startsWith('delete_ref_cas:')));
  assert.ok(['unowned_target', 'identity_mismatch', 'topology_changed'].includes(receipt.unresolved[0].code));
  assert.equal(harness.calls.deleteRefCas, 0);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(receipt.side_effects.ref_deleted, false);
  assert.equal(receipt.side_effects.lock_cleaned, false);
});

test('failure midway keeps lock held and reports remaining work in plan order', async () => {
  const harness = createMemoryCleanupHarness();
  harness.failOn('removeOwnedArtifact', 'artifact_remove_failed');
  const adapter = createWorktreeCleanupAdapterV1(harness.ops);
  const receipt = await adapter.executeCleanup({ proof: validProof() });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.cleaned, false);
  assert.ok(receipt.removed.includes('remove_worktree'));
  assert.ok(receipt.removed.some((item) => item.startsWith('delete_ref_cas:')));
  assert.equal(receipt.removed.some((item) => item.startsWith(`clean_lock:${LOCK_ID}`)), false);
  assert.ok(receipt.remaining.some((item) => item.startsWith('remove_owned_artifact:')));
  assert.ok(receipt.remaining.some((item) => item.startsWith(`clean_lock:${LOCK_ID}`)));
  assert.equal(receipt.unresolved[0].action, 'remove_owned_artifact');
  assert.equal(receipt.side_effects.worktree_removed, true);
  assert.equal(receipt.side_effects.ref_deleted, true);
  assert.equal(receipt.side_effects.lock_cleaned, false);
  assert.equal(harness.calls.cleanLock, 0);
  assert.equal(receipt.adapter_checks.partial_cleanup_truthful, true);
});

test('proxies, getters, and secret-bearing keys never run or leak', () => {
  let got = 0;
  const proof = validProof();
  Object.defineProperty(proof, 'token', {
    enumerable: true,
    get() {
      got += 1;
      return HOSTILE_SECRET;
    },
  });
  assert.throws(
    () => planWorktreeCleanupV1({ proof, topology: validTopology() }),
    (error) => {
      assertContentFreeError(error, [HOSTILE_SECRET, WORKTREE_PATH, LANE_REF, GIT_DIR]);
      return error instanceof RunContractV1Error;
    },
  );
  assert.equal(got, 0);

  assert.throws(
    () => createWorktreeCleanupAdapterV1(new Proxy({ observeTopology() {} }, {})),
    (error) => error instanceof RunContractV1Error && error.code === 'proxy_denied',
  );
});
