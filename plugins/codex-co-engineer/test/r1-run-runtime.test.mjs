// P33 run-runtime focused coverage: exact identity, one-submission
// idempotency, restart/cursor/attention evidence, cancellation, and
// proof-bound cleanup. Lifecycle settlement is consumed; worker/boundary
// lock recovery is never owned.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  RUN_RUNTIME_ALWAYS_FALSE_SIDE_EFFECTS,
  RUN_RUNTIME_CHECKS,
  RUN_RUNTIME_DEPENDENCY_KEYS,
  RUN_RUNTIME_METHODS,
  RUN_RUNTIME_RECEIPT_SCHEMA_ID,
  RUN_RUNTIME_SCHEMA_ID,
  RUN_RUNTIME_VERSION,
  createRunRuntime,
  describeRunRuntimeV1,
} from '../mcp/v3/run-runtime.mjs';
import {
  ASSIGNMENT_ID,
  HOSTILE_SECRET,
  TASK_ID,
  createLifecycleFns,
  createMemoryScheduler,
  createRuntime,
  makeAssignment,
  makeSubmitRequest,
  makeVerifier,
} from './fixtures/r1-run-runtime-fixtures.mjs';

const MODULE_SOURCE = await readFile(
  fileURLToPath(new URL('../mcp/v3/run-runtime.mjs', import.meta.url)),
  'utf8',
);

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

function assertDeniedSideEffects(receipt) {
  for (const claim of RUN_RUNTIME_ALWAYS_FALSE_SIDE_EFFECTS) {
    assert.equal(receipt.side_effects[claim], false, claim);
  }
  assert.equal(receipt.remote_mutated, false);
  assert.equal(receipt.wake, false);
}

function assertNoSecret(value) {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value, ['name', 'code', 'path', 'message', 'schema', 'status', 'lanes', 'cleanup']);
  assert.doesNotMatch(text, /sk-live/u);
  assert.doesNotMatch(text, /ATTACKER-SECRET/u);
  assert.doesNotMatch(text, /github_pat/u);
}

test('describeRunRuntimeV1 is deterministic, frozen, and quotes composed surfaces', () => {
  const first = describeRunRuntimeV1();
  const second = describeRunRuntimeV1();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(first.schema, RUN_RUNTIME_SCHEMA_ID);
  assert.equal(first.version, RUN_RUNTIME_VERSION);
  assert.deepEqual([...first.methods], [...RUN_RUNTIME_METHODS]);
  assert.deepEqual([...first.dependencies], [...RUN_RUNTIME_DEPENDENCY_KEYS]);
  assert.deepEqual([...first.checks], [...RUN_RUNTIME_CHECKS]);
  assert.equal(first.composed_surfaces.p24.includes('runStore'), true);
  assert.equal(first.composed_surfaces.p27.includes('resolution_ready'), true);
  assert.equal(first.composed_surfaces.lifecycle.includes('never owns'), true);
  assert.equal(first.composed_surfaces.gate_a, 'not claimed');
  assert.equal(first.remote_mutated, false);
  assertFrozenTree(first);
});

test('createRunRuntime exports exactly submitRun, resumeRun, cancelRun, inspectRun', () => {
  const { runtime } = createRuntime();
  assert.deepEqual(Object.keys(runtime).sort(), [...RUN_RUNTIME_METHODS].sort());
  assert.ok(Object.isFrozen(runtime));
});

test('submitRun persists exact identity, dispatches once, and replays idempotently', async () => {
  const harness = createRuntime();
  const request = makeSubmitRequest();
  const first = await harness.runtime.submitRun(request);
  assert.equal(first.schema, RUN_RUNTIME_RECEIPT_SCHEMA_ID);
  assert.equal(first.status, 'dispatched');
  assert.equal(first.created, true);
  assert.equal(first.run_id, request.run_id);
  assert.equal(first.assignment_count, 1);
  assert.equal(first.lanes[0].assignment_id, ASSIGNMENT_ID);
  assert.equal(first.lanes[0].task_id, TASK_ID);
  assert.equal(first.journal.run_opened, true);
  assert.equal(first.journal.mode, 'legacy');
  assert.equal(first.side_effects.task_dispatched, true);
  assertDeniedSideEffects(first);
  assertFrozenTree(first);
  assert.equal(harness.scheduler.calls.submit, 1);
  assert.deepEqual(harness.scheduler.calls.delegate, [ASSIGNMENT_ID]);

  const replay = await harness.runtime.submitRun(request);
  assert.equal(replay.status, 'idempotent');
  assert.equal(replay.created, false);
  assert.equal(replay.side_effects.task_dispatched, false);
  assert.equal(harness.scheduler.calls.submit, 1);
  assert.deepEqual(harness.scheduler.calls.delegate, [ASSIGNMENT_ID]);
  assert.equal(replay.journal.run_opened, true);
  assertDeniedSideEffects(replay);
});

test('a conflicting body for the same run id fails closed without a second dispatch', async () => {
  const harness = createRuntime();
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  const conflict = {
    ...request,
    assignments: [makeAssignment({ taskId: 'task-other' })],
  };
  const error = await errorOf(() => harness.runtime.submitRun(conflict));
  assert.equal(error.code, 'runtime_identity_conflict');
  assert.equal(harness.scheduler.calls.submit, 1);
  assertNoSecret(error);
});

test('R24A/P27 awaiting_selection fails closed before scheduler dispatch', async () => {
  const harness = createRuntime();
  harness.aggregateAnchor.phaseByRun.set(makeSubmitRequest().run_id, 'awaiting_selection');
  const error = await errorOf(() => harness.runtime.submitRun(makeSubmitRequest()));
  assert.equal(error.code, 'runtime_selection_unresolved');
  assert.equal(harness.scheduler.calls.submit, 0);
  assert.equal(harness.runStore._byId.size, 0);
});

test('resolution_ready uses the aggregate journal path', async () => {
  const harness = createRuntime();
  const request = makeSubmitRequest();
  harness.aggregateAnchor.phaseByRun.set(request.run_id, 'resolution_ready');
  const receipt = await harness.runtime.submitRun(request);
  assert.equal(receipt.journal.mode, 'aggregate');
  assert.equal(receipt.status, 'dispatched');
  assert.equal(harness.scheduler.calls.submit, 1);
});

test('resumeRun records cursor evidence and accepts child terminal only after lifecycle finality', async () => {
  const harness = createRuntime({
    scheduler: createMemoryScheduler({
      inspectStatusByAssignment: new Map([[ASSIGNMENT_ID, 'completed']]),
    }),
    lifecycle: createLifecycleFns({ final: true, cleanupStatus: 'normal' }),
  });
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  const resumed = await harness.runtime.resumeRun({
    run_id: request.run_id,
    cursors: [{ assignment_id: ASSIGNMENT_ID, task_id: TASK_ID, event_cursor: '4' }],
  });
  assert.equal(resumed.status, 'inspected');
  assert.equal(resumed.lanes[0].status, 'completed');
  assert.equal(resumed.lanes[0].cleanup.final, true);
  assert.equal(resumed.lanes[0].cleanup.status, 'normal');
  assert.equal(resumed.lanes[0].cursor.event_cursor, '4');
  assert.equal(resumed.journal.terminal, true);
  assert.equal(resumed.journal.run_outcome, 'completed');
  assert.equal(harness.lifecycle.cleanupCalls.length, 1);
  assert.equal(harness.lifecycle.settleCalls[0].root, null);
  assert.equal(harness.lifecycle.settleCalls[0].task.id, TASK_ID);
  const handle = harness.runJournal._handles.get(request.run_id);
  const kinds = handle.events.map((event) => event.kind);
  assert.ok(kinds.includes('child_terminal'));
  assert.ok(kinds.includes('child_progress'));
  assert.ok(kinds.includes('run_terminal'));
  assertDeniedSideEffects(resumed);
});

test('non-final lifecycle suppresses child terminal and projects lifecycle_pending', async () => {
  const harness = createRuntime({
    scheduler: createMemoryScheduler({
      inspectStatusByAssignment: new Map([[ASSIGNMENT_ID, 'completed']]),
    }),
    lifecycle: createLifecycleFns({
      final: false,
      cleanupStatus: 'pending',
      reason: 'boundary_visibility_unknown',
    }),
  });
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  const resumed = await harness.runtime.resumeRun({ run_id: request.run_id });
  assert.equal(resumed.status, 'lifecycle_pending');
  assert.equal(resumed.lanes[0].status, 'lifecycle_pending');
  assert.equal(resumed.lanes[0].cleanup.final, false);
  assert.equal(resumed.lanes[0].cleanup.reason, 'boundary_visibility_unknown');
  const handle = harness.runJournal._handles.get(request.run_id);
  assert.equal(handle.events.some((event) => event.kind === 'child_terminal'), false);
  assert.equal(resumed.complete_candidate_blocked, true);
});

test('resume latches P34 attention and cancels only unsupported lanes', async () => {
  const writer = makeAssignment();
  const cloud = makeAssignment({
    assignmentId: 'cloud-lane',
    taskId: 'task-cloud',
    provider: 'cursor-cloud',
    startingRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    writeScope: ['docs/**'],
  });
  const harness = createRuntime();
  const request = makeSubmitRequest({ assignments: [writer, cloud] });
  await harness.runtime.submitRun(request);
  const resumed = await harness.runtime.resumeRun({
    run_id: request.run_id,
    attention_items: [{
      assignment_id: 'cloud-lane',
      task_id: 'task-cloud',
      provider: 'cursor-cloud',
      required: true,
      session_id: 'sess-cloud',
      question_id: 'q-cloud',
      event_cursor: '0',
      prompt: 'Choose',
      options: ['a', 'b'],
      reply_capability: 'unsupported',
    }],
  });
  assert.equal(resumed.attention.status, 'open');
  assert.equal(resumed.attention.wake, false);
  assert.equal(resumed.attention.complete_candidate_blocked, true);
  assert.deepEqual(harness.attentionBatch.calls.cancelled, ['cloud-lane']);
  assert.equal(harness.scheduler.calls.cancel, 1);
  const cloudLane = resumed.lanes.find((lane) => lane.assignment_id === 'cloud-lane');
  const writerLane = resumed.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID);
  assert.equal(cloudLane.status, 'cancelled');
  assert.equal(writerLane.status, 'dispatched');
});

test('cancelRun cancels only named lanes, settles lifecycle, and proof-binds cleanup', async () => {
  const writer = makeAssignment();
  const reviewer = makeVerifier();
  const harness = createRuntime();
  const request = makeSubmitRequest({ assignments: [writer, reviewer] });
  await harness.runtime.submitRun(request);
  await harness.artifactBridge.captureAssignmentArtifacts({
    run_id: request.run_id,
    assignment_id: ASSIGNMENT_ID,
    relative_path: `runs/${request.run_id}/${ASSIGNMENT_ID}/note.txt`,
  });
  const cancelled = await harness.runtime.cancelRun({
    run_id: request.run_id,
    assignment_ids: [ASSIGNMENT_ID],
    cleanup: true,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID).status,
    'cancelled');
  assert.equal(cancelled.lanes.find((lane) => lane.assignment_id === 'review-lane').status,
    'dispatched');
  assert.equal(cancelled.cleanup.proof_bound, true);
  assert.equal(cancelled.cleanup.cleaned, true);
  assert.equal(cancelled.cleanup.removed, 1);
  assert.equal(harness.lifecycle.cleanupCalls.length, 1);
  assert.equal(harness.artifactBridge.calls.cleanup[0].proof.run_id, request.run_id);
  assertDeniedSideEffects(cancelled);
});

test('cleanup without lifecycle finality is refused and does not remove artifacts', async () => {
  const harness = createRuntime({
    lifecycle: createLifecycleFns({ final: false, cleanupStatus: 'pending' }),
  });
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  await harness.artifactBridge.captureAssignmentArtifacts({
    run_id: request.run_id,
    assignment_id: ASSIGNMENT_ID,
    relative_path: `runs/${request.run_id}/${ASSIGNMENT_ID}/note.txt`,
  });
  const error = await errorOf(() => harness.runtime.cancelRun({
    run_id: request.run_id,
    assignment_ids: [ASSIGNMENT_ID],
    cleanup: true,
  }));
  assert.equal(error.code, 'runtime_cleanup_unproven');
  assert.equal(harness.artifactBridge.calls.cleanup.length, 0);
});

test('inspectRun projects journal cursor, attention, artifacts, and lifecycle overlay', async () => {
  const harness = createRuntime({
    scheduler: createMemoryScheduler({
      inspectStatusByAssignment: new Map([[ASSIGNMENT_ID, 'completed']]),
    }),
    lifecycle: createLifecycleFns({ final: false, reason: 'worker_exit_timeout' }),
  });
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  assert.equal(inspected.status, 'lifecycle_pending');
  assert.equal(inspected.lanes[0].status, 'lifecycle_pending');
  assert.equal(inspected.cursor.cursor, 'cursor:2');
  assert.equal(inspected.lanes[0].artifacts.schema,
    'codex-co-engineer.run-artifact-bridge-projection.v1');
  assert.equal(harness.lifecycle.cleanupCalls.length, 0);
  assertDeniedSideEffects(inspected);
});

test('unaffected required-lane failure does not redispatch and blocks a complete candidate', async () => {
  const writer = makeAssignment();
  const other = makeAssignment({
    assignmentId: 'docs-writer',
    taskId: 'task-docs',
    writeScope: ['docs/**'],
  });
  const harness = createRuntime({
    scheduler: createMemoryScheduler({
      delegateErrorFor: new Set(['docs-writer']),
    }),
  });
  const receipt = await harness.runtime.submitRun(makeSubmitRequest({
    assignments: [writer, other],
  }));
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID).status,
    'dispatched');
  assert.equal(receipt.lanes.find((lane) => lane.assignment_id === 'docs-writer').status,
    'unresolved');
  assert.equal(receipt.complete_candidate_blocked, true);
  assert.equal(harness.scheduler.calls.submit, 1);
});

test('createRunRuntime rejects missing or extra injected seams', () => {
  const harness = createRuntime();
  const deps = {
    runStore: harness.runStore,
    runJournal: harness.runJournal,
    aggregateAnchor: harness.aggregateAnchor,
    attentionBatch: harness.attentionBatch,
    scheduler: harness.scheduler,
    artifactBridge: harness.artifactBridge,
    settleLocalTaskLifecycle: harness.lifecycle.settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle: harness.lifecycle.cleanupLocalTaskLifecycle,
    clock: harness.clock,
  };
  assert.throws(() => createRunRuntime({ ...deps, extra: () => {} }), (error) => {
    assert.equal(error.code, 'unknown_key');
    return true;
  });
  const { extra: _ignored, ...rest } = { ...deps, extra: 1 };
  delete rest.clock;
  assert.throws(() => createRunRuntime(rest), (error) => {
    assert.equal(error.code, 'missing_key');
    return true;
  });
});

test('the runtime module does not import worker, boundary, supervisor, server, or GitHub paths', () => {
  const imports = MODULE_SOURCE.split('\n')
    .filter((line) => line.startsWith('import '))
    .join('\n');
  assert.doesNotMatch(imports, /acp-worker\.mjs/u);
  assert.doesNotMatch(imports, /process-boundary\.mjs/u);
  assert.doesNotMatch(imports, /supervisor\.mjs/u);
  assert.doesNotMatch(imports, /server\.mjs/u);
  assert.doesNotMatch(imports, /run-scheduler\.mjs/u);
  assert.doesNotMatch(imports, /run-artifact-bridge\.mjs/u);
  assert.doesNotMatch(imports, /task-store\.mjs/u);
  assert.doesNotMatch(imports, /child_process/u);
  assert.doesNotMatch(MODULE_SOURCE, /github\.com/u);
  assert.doesNotMatch(MODULE_SOURCE, /CHANGELOG/u);
  assert.doesNotMatch(MODULE_SOURCE, /future-work/u);
});

test('lifecycle secret fields are stripped from receipts', async () => {
  const harness = createRuntime({
    scheduler: createMemoryScheduler({
      inspectStatusByAssignment: new Map([[ASSIGNMENT_ID, 'completed']]),
    }),
    lifecycle: createLifecycleFns({ final: true, leakSecret: true }),
  });
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  const resumed = await harness.runtime.resumeRun({ run_id: request.run_id });
  assertNoSecret(resumed);
  assert.equal(Object.hasOwn(resumed.lanes[0].cleanup, 'secret'), false);
});
