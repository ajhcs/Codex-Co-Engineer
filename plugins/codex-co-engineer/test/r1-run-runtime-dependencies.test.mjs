// P33 run-runtime dependency coverage: compose the frozen P24 store, P25
// journal, R24A aggregate anchor, R25B aggregate journal, P27 selection
// persistence, and P34 attention batch through injected scoped stubs for
// scheduler, artifact bridge, and lifecycle.

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { openAttentionRoot } from '../mcp/v3/attention-batch.mjs';
import {
  createAggregateRunJournal,
  createRunJournal,
  openAggregateRunJournal,
  openRunJournal,
} from '../mcp/v3/run-journal.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { createRunRuntime } from '../mcp/v3/run-runtime.mjs';
import { openRunStore } from '../mcp/v3/run-store.mjs';
import {
  acceptSelectionReply,
  persistSelectionQuestionBatch,
} from '../mcp/v3/selection-persistence.mjs';
import { grokItem } from './fixtures/r1-attention-batch-fixtures.mjs';
import {
  makeResolvedAnchor,
} from './fixtures/r1-run-journal-aggregate-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  TASK_ID,
  createClock,
  createLifecycleFns,
  createMemoryArtifactBridge,
  createMemoryScheduler,
  makeAssignment,
  makePrivateRoot,
  makeStoreRoot,
  makeSubmission,
  makeSubmitRequest,
} from './fixtures/r1-run-runtime-fixtures.mjs';
import {
  P27_RUN_ID,
  completeAnswers,
  derivedRequest,
  structuredReply,
  withSubmittedAnchor,
} from './fixtures/r1-selection-persistence-fixtures.mjs';

function wrapJournal({ journalRoot, store, anchor }) {
  return {
    async create(options) {
      return createRunJournal({ root: journalRoot, store, run_id: options.run_id });
    },
    async open(options) {
      return openRunJournal({ root: journalRoot, store, run_id: options.run_id });
    },
    async createAggregate(options) {
      return createAggregateRunJournal({
        root: journalRoot, anchor, run_id: options.run_id,
      });
    },
    async openAggregate(options) {
      return openAggregateRunJournal({
        root: journalRoot, anchor, run_id: options.run_id,
      });
    },
  };
}

function missingAggregateAnchor() {
  return {
    async getCoordination() {
      throw new RunContractV1Error('aggregate_run_not_found', 'run_id', 'missing');
    },
  };
}

function bindLegacyRuntime({
  runStore,
  runJournal,
  attentionBatch,
  scheduler,
  artifactBridge,
  lifecycle,
}) {
  return createRunRuntime({
    runStore,
    runJournal,
    aggregateAnchor: missingAggregateAnchor(),
    attentionBatch,
    scheduler,
    artifactBridge,
    settleLocalTaskLifecycle: lifecycle.settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle: lifecycle.cleanupLocalTaskLifecycle,
    clock: createClock(),
  });
}

async function withLegacyRuntime(fn) {
  const storeRoot = await makeStoreRoot('r1-p33-dep-store-');
  const journalRoot = await makePrivateRoot('r1-p33-dep-journal-');
  const attentionRoot = await makePrivateRoot('r1-p33-dep-attention-');
  try {
    const runStore = await openRunStore(storeRoot);
    const runJournal = wrapJournal({ journalRoot, store: runStore, anchor: missingAggregateAnchor() });
    const attentionBatch = await openAttentionRoot(attentionRoot);
    const scheduler = createMemoryScheduler();
    const artifactBridge = createMemoryArtifactBridge();
    const lifecycle = createLifecycleFns({ final: true });
    const runtime = bindLegacyRuntime({
      runStore, runJournal, attentionBatch, scheduler, artifactBridge, lifecycle,
    });
    return await fn({
      runtime, runStore, runJournal, attentionBatch, scheduler, artifactBridge,
      lifecycle, journalRoot,
    });
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
    await rm(attentionRoot, { recursive: true, force: true });
  }
}

test('legacy P24/P25 submit is durable, idempotent, and reopens the journal after restart', async () => {
  await withLegacyRuntime(async ({ runtime, runStore, scheduler }) => {
    const request = makeSubmitRequest();
    const first = await runtime.submitRun(request);
    assert.equal(first.status, 'dispatched');
    assert.equal(first.created, true);
    assert.equal(first.journal.mode, 'legacy');
    assert.equal(first.journal.run_opened, true);
    const stored = await runStore.getByRunId(request.run_id);
    assert.equal(stored.run_id, request.run_id);
    assert.equal(stored.request_idempotency_key, request.request_idempotency_key);

    const replay = await runtime.submitRun(request);
    assert.equal(replay.status, 'idempotent');
    assert.equal(replay.created, false);
    assert.equal(scheduler.calls.submit, 1);
    assert.equal(scheduler.calls.delegate.length, 1);

    const inspected = await runtime.inspectRun({ run_id: request.run_id });
    assert.equal(inspected.journal.run_opened, true);
    assert.equal(inspected.remote_mutated, false);
  });
});

test('A submits, fresh B inspects then identical submits, fresh C submit-first against P24', async () => {
  await withLegacyRuntime(async (harness) => {
    const request = makeSubmitRequest();
    const first = await harness.runtime.submitRun(request);
    assert.equal(first.created, true);
    assert.equal(harness.scheduler.calls.submit, 1);
    const stored = await harness.runStore.getByRunId(request.run_id);
    assert.equal(stored.request_idempotency_key, request.request_idempotency_key);

    const runtimeB = bindLegacyRuntime(harness);
    const inspected = await runtimeB.inspectRun({ run_id: request.run_id });
    assert.equal(inspected.created, false);
    const replayB = await runtimeB.submitRun(request);
    assert.equal(replayB.created, false);
    assert.equal(replayB.status, 'idempotent');
    assert.equal(harness.scheduler.calls.submit, 1);

    const runtimeC = bindLegacyRuntime(harness);
    const replayC = await runtimeC.submitRun(request);
    assert.equal(replayC.created, false);
    assert.equal(replayC.status, 'idempotent');
    assert.equal(harness.scheduler.calls.submit, 1);
    assert.equal(harness.scheduler.calls.delegate.length, 1);
    assert.equal(replayC.side_effects.replay, false);
    assert.equal(replayC.side_effects.fallback, false);
    assert.equal(replayC.side_effects.duplicate_dispatch, false);

    const conflict = makeSubmitRequest({
      submission: makeSubmission({ attempt: 2 }),
    });
    await assert.rejects(() => bindLegacyRuntime(harness).submitRun(conflict), (error) => {
      assert.equal(error.code, 'runtime_identity_conflict');
      return true;
    });
    assert.equal(harness.scheduler.calls.submit, 1);
    const afterConflict = await harness.runStore.getByRunId(request.run_id);
    assert.equal(afterConflict.canonical_digest, stored.canonical_digest);
    assert.equal(afterConflict.request_idempotency_key, stored.request_idempotency_key);
  });
});

test('resume against a real P25 journal accepts terminal only after injected lifecycle finality', async () => {
  await withLegacyRuntime(async ({ runtime, scheduler, lifecycle }) => {
    const request = makeSubmitRequest();
    await runtime.submitRun(request);
    scheduler.inspectStatusByAssignment.set(ASSIGNMENT_ID, 'completed');
    const resumed = await runtime.resumeRun({
      run_id: request.run_id,
      cursors: [{ assignment_id: ASSIGNMENT_ID, task_id: TASK_ID, event_cursor: '2' }],
    });
    assert.equal(resumed.lanes[0].status, 'completed');
    assert.equal(resumed.lanes[0].cleanup.final, true);
    assert.equal(resumed.journal.terminal, true);
    assert.equal(resumed.journal.run_outcome, 'completed');
    assert.equal(lifecycle.cleanupCalls.length, 1);
    assert.equal(lifecycle.settleCalls[0].runtime.task_id, TASK_ID);
  });
});

test('R24A resolution_ready plus R25B aggregate journal is the dispatch path', async () => {
  const prepared = await makeResolvedAnchor({ runId: 'p33-aggregate-run' });
  const storeRoot = await makeStoreRoot('r1-p33-agg-store-');
  const journalRoot = await makePrivateRoot('r1-p33-agg-journal-');
  const attentionRoot = await makePrivateRoot('r1-p33-agg-attention-');
  try {
    const runStore = await openRunStore(storeRoot);
    const attentionBatch = await openAttentionRoot(attentionRoot);
    const scheduler = createMemoryScheduler();
    const lifecycle = createLifecycleFns({ final: true });
    const runtime = createRunRuntime({
      runStore,
      runJournal: wrapJournal({
        journalRoot, store: runStore, anchor: prepared.anchor,
      }),
      aggregateAnchor: prepared.anchor,
      attentionBatch,
      scheduler,
      artifactBridge: createMemoryArtifactBridge(),
      settleLocalTaskLifecycle: lifecycle.settleLocalTaskLifecycle,
      cleanupLocalTaskLifecycle: lifecycle.cleanupLocalTaskLifecycle,
      clock: createClock(),
    });
    const request = makeSubmitRequest({
      runId: 'p33-aggregate-run',
      assignments: [makeAssignment({ assignmentId: ASSIGNMENT_ID })],
      submission: makeSubmission({ runId: 'p33-aggregate-run' }),
    });
    const receipt = await runtime.submitRun(request);
    assert.equal(receipt.journal.mode, 'aggregate');
    assert.equal(receipt.status, 'dispatched');
    const coordination = await prepared.anchor.getCoordination('p33-aggregate-run');
    assert.equal(coordination.phase, 'resolution_ready');
    assert.equal(scheduler.calls.submit, 1);
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
    await rm(attentionRoot, { recursive: true, force: true });
  }
});

test('P27 ask-once selection must reach resolution_ready before runtime dispatch', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    const storeRoot = await makeStoreRoot('r1-p33-p27-store-');
    const journalRoot = await makePrivateRoot('r1-p33-p27-journal-');
    const attentionRoot = await makePrivateRoot('r1-p33-p27-attention-');
    try {
      const runStore = await openRunStore(storeRoot);
      const scheduler = createMemoryScheduler();
      const runtime = createRunRuntime({
        runStore,
        runJournal: wrapJournal({ journalRoot, store: runStore, anchor }),
        aggregateAnchor: anchor,
        attentionBatch: await openAttentionRoot(attentionRoot),
        scheduler,
        artifactBridge: createMemoryArtifactBridge(),
        settleLocalTaskLifecycle: createLifecycleFns().settleLocalTaskLifecycle,
        cleanupLocalTaskLifecycle: createLifecycleFns().cleanupLocalTaskLifecycle,
        clock: createClock(),
      });
      const awaiting = makeSubmitRequest({
        runId: P27_RUN_ID,
        assignments: [makeAssignment({ assignmentId: 'lane-0', taskId: 'task-lane-0' })],
        submission: makeSubmission({ runId: P27_RUN_ID, assignmentId: 'lane-0' }),
      });
      await assert.rejects(() => runtime.submitRun(awaiting), (error) => {
        assert.equal(error.code, 'runtime_selection_unresolved');
        return true;
      });
      assert.equal(scheduler.calls.submit, 0);

      await persistSelectionQuestionBatch({ anchor, ...inputs });
      const derived = derivedRequest(inputs);
      await acceptSelectionReply({
        anchor,
        ...inputs,
        reply: structuredReply(derived.request, completeAnswers(derived.request)),
      });
      const coordination = await anchor.getCoordination(P27_RUN_ID);
      assert.equal(coordination.phase, 'resolution_ready');

      const dispatched = await runtime.submitRun(awaiting);
      assert.equal(dispatched.status, 'dispatched');
      assert.equal(dispatched.journal.mode, 'aggregate');
      assert.equal(scheduler.calls.submit, 1);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
      await rm(journalRoot, { recursive: true, force: true });
      await rm(attentionRoot, { recursive: true, force: true });
    }
  }, { runId: P27_RUN_ID });
});

test('P34 latch through the runtime uses the live journal revision as the source boundary', async () => {
  await withLegacyRuntime(async ({ runtime, scheduler }) => {
    const request = makeSubmitRequest();
    await runtime.submitRun(request);
    const item = grokItem({
      assignmentId: ASSIGNMENT_ID,
      taskId: TASK_ID,
    });
    const resumed = await runtime.resumeRun({
      run_id: request.run_id,
      attention_items: [item],
    });
    assert.equal(resumed.attention.status, 'open');
    assert.equal(resumed.attention.wake, false);
    assert.equal(typeof resumed.attention.batch_id, 'string');
    assert.equal(scheduler.calls.submit, 1);
  });
});
