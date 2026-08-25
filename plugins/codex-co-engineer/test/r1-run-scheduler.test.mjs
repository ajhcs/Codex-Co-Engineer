// P33 RunSchedulerV1 focused coverage: one-submission 1-8 fanout, exact
// identity, disjoint writers / read-only verifiers, no replay or duplicate
// dispatch, unaffected lanes continue, and bounded attention/cancel/cursor
// evidence over injected task stubs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  RUN_SCHEDULER_CHECKS,
  RUN_SCHEDULER_DEPENDENCY_KEYS,
  RUN_SCHEDULER_METHODS,
  RUN_SCHEDULER_SCHEMA_ID,
  RUN_SCHEDULER_SIDE_EFFECTS,
  RUN_SCHEDULER_VERSION,
  createRunScheduler,
  describeRunSchedulerV1,
} from '../mcp/v3/run-scheduler.mjs';
import {
  ASSIGNMENT_A,
  ASSIGNMENT_B,
  ASSIGNMENT_C,
  BASE_SHA,
  NOW,
  RUN_ID,
  TASK_A,
  TASK_B,
  TASK_C,
  createScopedStubs,
  eightLaneRequest,
  mixedLaneRequest,
  twoWriterRequest,
  verifierAssignment,
  writerAssignment,
} from './fixtures/r1-run-scheduler-fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../mcp/v3/run-scheduler.mjs', import.meta.url));

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertFrozenTree(value) {
  assert.ok(value === null || typeof value !== 'object' || Object.isFrozen(value),
    'returned records must be frozen');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

function assertNonclaims(receipt) {
  assert.equal(receipt.wake, false);
  assert.equal(receipt.remote_mutated, false);
  assert.equal(receipt.side_effects.duplicate_dispatch, false);
  assert.equal(receipt.side_effects.replay, false);
  assert.equal(receipt.side_effects.fallback, false);
  assert.equal(receipt.side_effects.workspace_created, false);
  assert.equal(receipt.side_effects.branch_or_ref_created, false);
  assert.equal(receipt.side_effects.candidate_composed, false);
  assert.equal(receipt.side_effects.server_cutover, false);
  assert.equal(receipt.side_effects.remote_mutated, false);
  for (const check of RUN_SCHEDULER_CHECKS) {
    assert.equal(receipt.checks[check], true, check);
  }
}

test('RunSchedulerV1 is the frozen v1 contract with exact factory exports', () => {
  assert.equal(RUN_SCHEDULER_SCHEMA_ID, 'codex-co-engineer.run-scheduler.v1');
  assert.equal(RUN_SCHEDULER_VERSION, 1);
  assert.deepEqual([...RUN_SCHEDULER_METHODS], [
    'submitAssignments', 'resumeAssignments', 'cancelAssignments',
  ]);
  assert.deepEqual([...RUN_SCHEDULER_DEPENDENCY_KEYS], [
    'delegateTask', 'inspectTask', 'cancelTask', 'clock',
  ]);
  assert.equal(MIN_ASSIGNMENTS, 1);
  assert.equal(MAX_ASSIGNMENTS, 8);
  const inventory = describeRunSchedulerV1();
  assert.equal(inventory.schema, RUN_SCHEDULER_SCHEMA_ID);
  assert.equal(inventory.rule, 'one_submission_idempotent_1_to_8_fanout_no_replay');
  assert.equal(inventory.wake, false);
  assert.equal(inventory.remote_mutated, false);
  assert.deepEqual([...inventory.ownership.forbidden], [
    'run_runtime',
    'artifact_bridge',
    'lifecycle',
    'supervisor',
    'server',
    'candidate_composition',
    'mailbox',
    'provider_driver',
    'task_store',
    'changelog',
    'future_work',
    'gate_a',
    'release',
  ]);
  assert.deepEqual([...inventory.side_effects], [...RUN_SCHEDULER_SIDE_EFFECTS]);
  assertFrozenTree(inventory);
  const first = describeRunSchedulerV1();
  const second = describeRunSchedulerV1();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});

test('the scheduler module does not import runtime, artifact, lifecycle, or server paths', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.match(source, /export function createRunScheduler/u);
  assert.equal(source.includes('run-runtime.mjs'), false);
  assert.equal(source.includes('run-artifact-bridge.mjs'), false);
  assert.equal(source.includes('acp-worker.mjs'), false);
  assert.equal(source.includes('process-boundary.mjs'), false);
  assert.equal(source.includes('supervisor.mjs'), false);
  assert.equal(source.includes('server.mjs'), false);
  assert.equal(source.includes('task-store.mjs'), false);
  assert.equal(source.includes('mailbox.mjs'), false);
  assert.equal(source.includes('run-candidate'), false);
  assert.equal(source.includes('candidate-composer'), false);
});

test('createRunScheduler returns exactly the three injected methods', () => {
  const harness = createScopedStubs();
  assert.deepEqual(Object.keys(harness.scheduler), [...RUN_SCHEDULER_METHODS]);
  assert.equal(typeof harness.scheduler.submitAssignments, 'function');
  assert.equal(typeof harness.scheduler.resumeAssignments, 'function');
  assert.equal(typeof harness.scheduler.cancelAssignments, 'function');
  assert.ok(Object.isFrozen(harness.scheduler));
});

test('one submission dispatches an independent 1-8 fanout exactly once', async () => {
  const harness = createScopedStubs();
  const receipt = await harness.scheduler.submitAssignments(twoWriterRequest());
  assert.equal(receipt.schema, RUN_SCHEDULER_SCHEMA_ID);
  assert.equal(receipt.status, 'dispatched');
  assert.equal(receipt.created, true);
  assert.equal(receipt.run_id, RUN_ID);
  assert.equal(receipt.base_sha, BASE_SHA);
  assert.equal(receipt.assignment_count, 2);
  assert.equal(receipt.observed_at, NOW);
  assert.equal(receipt.complete_candidate_blocked, false);
  assert.equal(harness.delegateCalls.length, 2);
  assert.deepEqual(harness.delegateCalls.map((call) => call.assignment_id).sort(), [
    ASSIGNMENT_A, ASSIGNMENT_B,
  ]);
  for (const call of harness.delegateCalls) {
    assert.equal(call.run_id, RUN_ID);
    assert.equal(Object.hasOwn(call, 'prompt'), false);
    assert.equal(call.fallback, undefined);
  }
  for (const lane of receipt.lanes) {
    assert.equal(lane.dispatched, true);
    assert.equal(lane.replayed, false);
    assert.equal(lane.fallback, false);
    assert.equal(lane.status, 'running');
  }
  assertNonclaims(receipt);
  assertFrozenTree(receipt);
});

test('exact resubmit is idempotent and never redispatches', async () => {
  const harness = createScopedStubs();
  const request = twoWriterRequest();
  const first = await harness.scheduler.submitAssignments(request);
  const second = await harness.scheduler.submitAssignments(request);
  assert.equal(first.status, 'dispatched');
  assert.equal(second.status, 'idempotent');
  assert.equal(second.created, false);
  assert.equal(second.side_effects.task_dispatched, false);
  assert.equal(harness.delegateCalls.length, 2);
  assert.deepEqual(second.lanes.map((lane) => lane.task_id), first.lanes.map((lane) => lane.task_id));
  assertNonclaims(second);
});

test('concurrent exact submits dispatch each lane once', async () => {
  const harness = createScopedStubs();
  const request = twoWriterRequest();
  const [left, right] = await Promise.all([
    harness.scheduler.submitAssignments(request),
    harness.scheduler.submitAssignments(request),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, ['dispatched', 'idempotent']);
  assert.equal(harness.delegateCalls.length, 2);
});

test('a different body for the same run_id fails closed without a second dispatch', async () => {
  const harness = createScopedStubs();
  await harness.scheduler.submitAssignments(twoWriterRequest());
  const error = await errorOf(() => harness.scheduler.submitAssignments(mixedLaneRequest()));
  assert.equal(error.code, 'scheduler_run_conflict');
  assert.equal(harness.delegateCalls.length, 2);
});

test('fanout 1 and 8 are accepted and 0 and 9 are denied before dispatch', async () => {
  const one = createScopedStubs();
  const oneReceipt = await one.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [writerAssignment()],
  });
  assert.equal(oneReceipt.assignment_count, 1);
  assert.equal(one.delegateCalls.length, 1);

  const eight = createScopedStubs();
  const eightReceipt = await eight.scheduler.submitAssignments(eightLaneRequest());
  assert.equal(eightReceipt.assignment_count, 8);
  assert.equal(eight.delegateCalls.length, 8);

  const empty = createScopedStubs();
  const emptyError = await errorOf(() => empty.scheduler.submitAssignments({
    run_id: RUN_ID, base_sha: BASE_SHA, assignments: [],
  }));
  assert.equal(emptyError.code, 'out_of_range');
  assert.equal(empty.delegateCalls.length, 0);

  const nine = createScopedStubs();
  const assignments = eightLaneRequest().assignments.concat(writerAssignment({
    assignmentId: 'lane-08', taskId: 'task-08', writeScope: ['src/area-8/**'],
  }));
  const nineError = await errorOf(() => nine.scheduler.submitAssignments({
    run_id: RUN_ID, base_sha: BASE_SHA, assignments,
  }));
  assert.equal(nineError.code, 'out_of_range');
  assert.equal(nine.delegateCalls.length, 0);
});

test('overlapping writer scopes fail closed; disjoint writers plus a read-only verifier pass', async () => {
  const overlap = createScopedStubs();
  const overlapError = await errorOf(() => overlap.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [
      writerAssignment({ writeScope: ['src/shared/**'] }),
      writerAssignment({
        assignmentId: ASSIGNMENT_B, taskId: TASK_B, writeScope: ['src/shared/util/**'],
      }),
    ],
  }));
  assert.equal(overlapError.code, 'overlapping_writer_scope');
  assert.equal(overlap.delegateCalls.length, 0);

  const mixed = createScopedStubs();
  const receipt = await mixed.scheduler.submitAssignments(mixedLaneRequest());
  assert.equal(receipt.assignment_count, 3);
  const verifier = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_C);
  assert.equal(verifier.access, 'read_only');
  assert.deepEqual([...verifier.write_scope], []);
  assert.equal(mixed.delegateCalls.length, 3);
});

test('writer/read-only pairing is exact and verification scopes stay empty', async () => {
  const role = createScopedStubs();
  const roleError = await errorOf(() => role.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [{
      ...writerAssignment(),
      role: 'verify',
    }],
  }));
  assert.equal(roleError.code, 'role_access_mismatch');

  const scopedVerifier = createScopedStubs();
  const scopeError = await errorOf(() => scopedVerifier.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [{
      ...verifierAssignment(),
      write_scope: ['src/alpha/**'],
    }],
  }));
  assert.equal(scopeError.code, 'read_only_scope_denied');

  const emptyWriter = createScopedStubs();
  const emptyError = await errorOf(() => emptyWriter.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [writerAssignment({ writeScope: [] })],
  }));
  assert.ok(emptyError.code === 'writer_scope_required' || emptyError.code === 'out_of_range');
  assert.equal(role.delegateCalls.length, 0);
  assert.equal(scopedVerifier.delegateCalls.length, 0);
  assert.equal(emptyWriter.delegateCalls.length, 0);
});

test('a failed lane does not replay and does not stop unaffected lanes', async () => {
  const harness = createScopedStubs({ failDelegateFor: [ASSIGNMENT_B] });
  const receipt = await harness.scheduler.submitAssignments(mixedLaneRequest());
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.complete_candidate_blocked, true);
  assert.equal(harness.delegateCalls.length, 3);
  const failed = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  const live = receipt.lanes.filter((lane) => lane.assignment_id !== ASSIGNMENT_B);
  assert.equal(failed.dispatched, false);
  assert.equal(failed.unresolved.code, 'dispatch_failed');
  assert.equal(failed.replayed, false);
  for (const lane of live) {
    assert.equal(lane.dispatched, true);
    assert.equal(lane.status, 'running');
  }

  const again = await harness.scheduler.submitAssignments(mixedLaneRequest());
  assert.equal(again.status, 'idempotent');
  assert.equal(harness.delegateCalls.length, 3);
});

test('optional failed lanes do not block a complete candidate', async () => {
  const harness = createScopedStubs({ failDelegateFor: [ASSIGNMENT_B] });
  const receipt = await harness.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [
      writerAssignment(),
      writerAssignment({
        assignmentId: ASSIGNMENT_B,
        taskId: TASK_B,
        writeScope: ['src/beta/**'],
        required: false,
      }),
    ],
  });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.complete_candidate_blocked, false);
  assert.equal(receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A).dispatched, true);
});

test('cancel names exact lanes and leaves unaffected lanes running', async () => {
  const harness = createScopedStubs();
  await harness.scheduler.submitAssignments(mixedLaneRequest());
  const receipt = await harness.scheduler.cancelAssignments({
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_B],
  });
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.side_effects.task_cancelled, true);
  assert.equal(harness.cancelCalls.length, 1);
  assert.equal(harness.cancelCalls[0].assignment_id, ASSIGNMENT_B);
  assert.equal(harness.cancelCalls[0].task_id, TASK_B);
  const cancelled = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  const live = receipt.lanes.filter((lane) => lane.assignment_id !== ASSIGNMENT_B);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancel_confirmed, true);
  for (const lane of live) {
    assert.equal(lane.status, 'running');
    assert.equal(lane.cancel_confirmed, null);
  }
  assert.equal(receipt.wake, false);
  assert.equal(receipt.complete_candidate_blocked, true);
});

test('resume projects cursor evidence and never redispatches', async () => {
  const harness = createScopedStubs();
  await harness.scheduler.submitAssignments(twoWriterRequest());
  const receipt = await harness.scheduler.resumeAssignments({
    run_id: RUN_ID,
    cursors: [
      { assignment_id: ASSIGNMENT_A, task_id: TASK_A, event_cursor: '1' },
    ],
  });
  assert.equal(receipt.status, 'inspected');
  assert.equal(harness.delegateCalls.length, 2);
  assert.equal(harness.inspectCalls.length, 2);
  assert.equal(harness.inspectCalls.find((call) => call.assignment_id === ASSIGNMENT_A).cursor, '1');
  for (const lane of receipt.lanes) {
    assert.match(lane.cursor, /^[0-9]+$/u);
    assert.equal(lane.replayed, false);
    assert.equal(lane.dispatched, true);
  }
  assertNonclaims(receipt);
});

test('resume of a cancelled lane records restart evidence and does not replay', async () => {
  const harness = createScopedStubs();
  await harness.scheduler.submitAssignments(twoWriterRequest());
  await harness.scheduler.cancelAssignments({
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_A],
  });
  const receipt = await harness.scheduler.resumeAssignments({
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_A, ASSIGNMENT_B],
  });
  const cancelled = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A);
  const live = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.unresolved.code, 'restart_denied_no_replay');
  assert.equal(live.status, 'running');
  assert.equal(harness.delegateCalls.length, 2);
  assert.equal(harness.inspectCalls.some((call) => call.assignment_id === ASSIGNMENT_A), false);
});

test('unsupported DSH or Cloud attention cancels only the affected lane', async () => {
  const harness = createScopedStubs({
    attentionByTask: {
      [TASK_B]: {
        session_id: 'sess-dsh',
        question_id: 'q-dsh',
        prompt: 'DSH cannot host a same-session reply',
        options: null,
      },
    },
  });
  await harness.scheduler.submitAssignments(mixedLaneRequest());
  const receipt = await harness.scheduler.resumeAssignments({ run_id: RUN_ID });
  const dsh = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  const others = receipt.lanes.filter((lane) => lane.assignment_id !== ASSIGNMENT_B);
  assert.equal(dsh.unresolved.code, 'same_session_reply_unsupported');
  assert.equal(dsh.status, 'cancelled');
  assert.equal(dsh.cancel_confirmed, true);
  assert.equal(harness.cancelCalls.length, 1);
  assert.equal(harness.cancelCalls[0].assignment_id, ASSIGNMENT_B);
  for (const lane of others) {
    assert.equal(lane.status, 'running');
    assert.equal(lane.cancel_confirmed, null);
  }
  assert.equal(receipt.wake, false);
  assert.equal(receipt.complete_candidate_blocked, true);
});

test('same-session Grok attention is bounded evidence and does not wake', async () => {
  const harness = createScopedStubs({
    attentionByTask: {
      [TASK_A]: {
        session_id: 'sess-a',
        question_id: 'q-a',
        prompt: 'Choose the next writer step',
        options: ['continue', 'stop'],
      },
    },
    inspectStatusByTask: { [TASK_A]: 'needs_attention' },
  });
  await harness.scheduler.submitAssignments(twoWriterRequest());
  const receipt = await harness.scheduler.resumeAssignments({ run_id: RUN_ID });
  const grok = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A);
  const other = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  assert.equal(grok.status, 'needs_attention');
  assert.equal(grok.attention.reply_capability, 'same_session');
  assert.equal(grok.attention.prompt, 'Choose the next writer step');
  assert.equal(other.status, 'running');
  assert.equal(receipt.wake, false);
  assert.equal(harness.cancelCalls.length, 0);
});

test('cursor-cloud lanes require an exact starting SHA; local lanes forbid one', async () => {
  const local = createScopedStubs();
  const localError = await errorOf(() => local.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [writerAssignment({ startingRef: BASE_SHA })],
  }));
  assert.equal(localError.code, 'starting_ref_forbidden_local');

  const missing = createScopedStubs();
  const missingError = await errorOf(() => missing.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [writerAssignment({
      provider: 'cursor-cloud', model: 'claude-sonnet-4-5', writeScope: ['src/cloud/**'],
    })],
  }));
  assert.equal(missingError.code, 'cloud_starting_ref_required');

  const cloud = createScopedStubs();
  const receipt = await cloud.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [writerAssignment({
      provider: 'cursor-cloud',
      model: 'claude-sonnet-4-5',
      writeScope: ['src/cloud/**'],
      startingRef: BASE_SHA,
    })],
  });
  assert.equal(receipt.lanes[0].starting_ref, BASE_SHA);
  assert.equal(receipt.lanes[0].provider, 'cursor-cloud');
});

test('duplicate assignment or task identities fail closed', async () => {
  const duplicateAssignment = createScopedStubs();
  const assignmentError = await errorOf(() => duplicateAssignment.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [
      writerAssignment(),
      writerAssignment({ taskId: TASK_B, writeScope: ['src/beta/**'] }),
    ],
  }));
  assert.equal(assignmentError.code, 'duplicate_assignment_id');

  const duplicateTask = createScopedStubs();
  const taskError = await errorOf(() => duplicateTask.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [
      writerAssignment(),
      writerAssignment({ assignmentId: ASSIGNMENT_B, writeScope: ['src/beta/**'] }),
    ],
  }));
  assert.equal(taskError.code, 'duplicate_task_id');
  assert.equal(duplicateAssignment.delegateCalls.length, 0);
  assert.equal(duplicateTask.delegateCalls.length, 0);
});

test('injected identity mismatch is per-lane and is never retried', async () => {
  const harness = createScopedStubs({ mismatchDelegateFor: [ASSIGNMENT_A] });
  const receipt = await harness.scheduler.submitAssignments(twoWriterRequest());
  const mismatched = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A);
  const live = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  assert.equal(mismatched.unresolved.code, 'identity_mismatch');
  assert.equal(mismatched.dispatched, false);
  assert.equal(live.dispatched, true);
  const again = await harness.scheduler.submitAssignments(twoWriterRequest());
  assert.equal(again.status, 'idempotent');
  assert.equal(harness.delegateCalls.length, 2);
});
