import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  initializeAggregateRunAnchorRoot,
  openAggregateRunAnchor,
} from '../mcp/v3/aggregate-run-anchor.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  SELECTION_QUESTION_BATCH_RECEIPT_SCHEMA_ID,
  SELECTION_REPLY_RECEIPT_SCHEMA_ID,
  acceptSelectionReply,
  persistSelectionQuestionBatch,
} from '../mcp/v3/selection-persistence.mjs';
import {
  P27_RUN_ID,
  completeAnswers,
  derivedRequest,
  makePersistenceInputs,
  makePrivateRoot,
  makeSubmitInput,
  structuredReply,
  wrapAnchor,
  withSubmittedAnchor,
} from './fixtures/r1-selection-persistence-fixtures.mjs';

const WORKER = fileURLToPath(new URL('./fixtures/r1-selection-persistence-worker.mjs', import.meta.url));

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

function assertNoLeak(value) {
  const text = canonicalJsonStringify(value);
  assert.doesNotMatch(text, /\/tmp\//u);
  assert.doesNotMatch(text, /repository_path/u);
  assert.doesNotMatch(text, /sk-live/u);
  assert.doesNotMatch(text, /ATTACKER-SECRET/u);
  assert.doesNotMatch(text, /Review lane/u);
}

test('persist derives the exact P05 batch at submitted@0 and returns a detached receipt', async () => {
  await withSubmittedAnchor(async ({ root, anchor, inputs }) => {
    const expected = derivedRequest(inputs);
    const receipt = await persistSelectionQuestionBatch({ anchor, ...inputs });
    assert.equal(receipt.schema, SELECTION_QUESTION_BATCH_RECEIPT_SCHEMA_ID);
    assert.equal(receipt.created, true);
    assert.equal(receipt.disposition, 'awaiting_selection');
    assert.equal(receipt.run_id, P27_RUN_ID);
    assert.equal(receipt.request_id, expected.identity.request_id);
    assert.equal(receipt.digest, expected.identity.digest);
    assert.equal(receipt.question_count, expected.request.question_count);
    assert.equal(receipt.coordination.revision, 1);
    assert.equal(
      canonicalJsonStringify(receipt.selection_request),
      canonicalJsonStringify(expected.request),
    );
    assert.deepEqual(
      receipt.selection_request.questions.map((question) => question.assignment_id),
      expected.request.questions.map((question) => question.assignment_id),
    );
    assertFrozenTree(receipt);
    assertNoLeak(receipt);

    const coordination = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(coordination.phase, 'awaiting_selection');
    assert.equal(coordination.revision, 1);
    assert.equal(coordination.selection_request_binding.request_id, expected.identity.request_id);
    assert.equal(coordination.selection_request_binding.digest, expected.identity.digest);

    const recordPath = path.join(root, 'runs', P27_RUN_ID, 'selection-request.record.json');
    const stored = JSON.parse((await readFile(recordPath, 'utf8')).trim());
    assert.equal(canonicalJsonStringify(stored), canonicalJsonStringify(expected.request));
    assert.equal(typeof receipt.selection_request.questions[0].prompt, 'undefined');
  });
});

test('exact persist replay is created false with byte-identical questions and no revision growth', async () => {
  await withSubmittedAnchor(async ({ root, anchor, inputs }) => {
    const first = await persistSelectionQuestionBatch({ anchor, ...inputs });
    const requestStat = await lstat(path.join(root, 'runs', P27_RUN_ID, 'selection-request.record.json'));
    const coordStat = await lstat(path.join(root, 'runs', P27_RUN_ID, 'coordination.json'));
    const names = (await readdir(path.join(root, 'runs', P27_RUN_ID))).sort();

    const replay = await persistSelectionQuestionBatch({ anchor, ...inputs });
    assert.equal(replay.created, false);
    assert.equal(replay.disposition, 'awaiting_selection');
    assert.equal(replay.digest, first.digest);
    assert.equal(canonicalJsonStringify(replay.selection_request),
      canonicalJsonStringify(first.selection_request));
    assert.equal(canonicalJsonStringify({ ...replay, created: true }),
      canonicalJsonStringify({ ...first, created: true }));
    assert.equal(replay.coordination.state_digest, first.coordination.state_digest);
    assert.equal(replay.coordination.revision, 1);

    const afterRequest = await lstat(path.join(root, 'runs', P27_RUN_ID, 'selection-request.record.json'));
    const afterCoord = await lstat(path.join(root, 'runs', P27_RUN_ID, 'coordination.json'));
    assert.equal(afterRequest.ino, requestStat.ino);
    assert.equal(afterCoord.ino, coordStat.ino);
    assert.deepEqual((await readdir(path.join(root, 'runs', P27_RUN_ID))).sort(), names);
  });
});

test('direct-plan and fully resolved runs fail no_selection_required without commitResolvedPlan', async () => {
  await withSubmittedAnchor(async ({ anchor }) => {
    const complete = makePersistenceInputs({ unresolved: false });
    await anchor.submit(makeSubmitInput(complete));
    let resolvedPlanCalls = 0;
    const wrapped = wrapAnchor(anchor, {});
    const original = wrapped.commitResolvedPlan;
    wrapped.commitResolvedPlan = async (...args) => {
      resolvedPlanCalls += 1;
      return original(...args);
    };
    const error = await errorOf(() => persistSelectionQuestionBatch({
      anchor: wrapped,
      ...complete,
    }));
    assert.equal(error.code, 'no_selection_required');
    assert.equal(resolvedPlanCalls, 0);
    const coordination = await anchor.getCoordination(complete.identity.run_id);
    assert.equal(coordination.phase, 'submitted');
    assert.equal(coordination.revision, 0);
    assert.equal(coordination.selection_request_binding, null);
  }, { runId: 'p27-complete-other' });
});

test('a different or stale manifest or snapshot at the same run fails closed', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const before = await anchor.getCoordination(P27_RUN_ID);

    const mutatedManifest = structuredClone(inputs.manifest);
    mutatedManifest.objective = 'A different authored objective.';
    const staleManifest = await errorOf(() => persistSelectionQuestionBatch({
      anchor,
      ...inputs,
      manifest: mutatedManifest,
      identity: {
        ...inputs.identity,
        manifest_digest: inputs.identity.manifest_digest,
      },
    }));
    assert.equal(staleManifest.code, 'identity_mismatch');

    const driftedAvailability = structuredClone(inputs.availability);
    driftedAvailability.providers.grok.models = ['grok-4', 'grok-4-fast'];
    const staleSnapshot = await errorOf(() => persistSelectionQuestionBatch({
      anchor,
      ...inputs,
      availability: driftedAvailability,
    }));
    assert.equal(staleSnapshot.code, 'stale_selection_request');

    const after = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(after.state_digest, before.state_digest);
    assert.equal(after.revision, 1);
    assert.equal(after.selection_request_binding.digest, before.selection_request_binding.digest);
  });
});

test('persist never generates a second batch and preserves 1- and 8-question order', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    const one = await persistSelectionQuestionBatch({ anchor, ...inputs });
    assert.equal(one.question_count, 1);
    assert.deepEqual(one.selection_request.questions.map((question) => question.assignment_id), ['lane-0']);
  });

  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    const eight = await persistSelectionQuestionBatch({ anchor, ...inputs });
    assert.equal(eight.question_count, 8);
    assert.deepEqual(
      eight.selection_request.questions.map((question) => question.assignment_id),
      ['lane-0', 'lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5', 'lane-6', 'lane-7'],
    );
  }, { assignmentCount: 8, runId: 'p27-eight-lane-run' });
});

test('persist crash before commit leaves submitted@0; restart creates the batch once', async () => {
  const inputs = makePersistenceInputs();
  const root = await makePrivateRoot('r1-p27-crash-before-');
  try {
    const anchor = await initializeAggregateRunAnchorRoot(root);
    await anchor.submit(makeSubmitInput(inputs));
    const wrapped = wrapAnchor(anchor, {
      beforeCommitRequest: async () => {
        throw new RunContractV1Error('injected_before_commit', 'commit', 'injected before persist');
      },
    });
    const injected = await errorOf(() => persistSelectionQuestionBatch({ anchor: wrapped, ...inputs }));
    assert.equal(injected.code, 'injected_before_commit');
    const coordination = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(coordination.phase, 'submitted');
    assert.equal(coordination.revision, 0);

    const reopened = await openAggregateRunAnchor(root);
    const created = await persistSelectionQuestionBatch({ anchor: reopened, ...inputs });
    assert.equal(created.created, true);
    assert.equal(created.disposition, 'awaiting_selection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function spawnWorker({ root, mode, runId = P27_RUN_ID, assignmentCount = 1 }) {
  const child = spawn(process.execPath, [WORKER, root, mode, runId, String(assignmentCount)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => {
      try {
        const line = stdout.trim().split('\n').filter(Boolean).at(-1);
        assert.ok(line, `worker produced no JSON (${stderr.trim()})`);
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });
  return { done, child };
}

test('acceptSelectionReply persists one complete reply and binds resolution_ready@2', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const derived = derivedRequest(inputs);
    const receipt = await acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request),
    });
    assert.equal(receipt.schema, SELECTION_REPLY_RECEIPT_SCHEMA_ID);
    assert.equal(receipt.created, true);
    assert.equal(receipt.disposition, 'resolution_ready');
    assert.equal(receipt.coordination.revision, 2);
    assert.equal(receipt.plan.complete, true);
    assert.equal(receipt.plan.selection_request, null);
    assert.equal(receipt.aggregate_binding.phase, 'resolution_ready');
    assert.equal(receipt.aggregate_binding.revision, 2);
    assert.equal(receipt.digest, derived.identity.digest);
    assertFrozenTree(receipt);
    assertNoLeak(receipt);
    assert.equal(receipt.plan.assignments[0].provider, 'grok');
  });
});

test('exact reply replay is created false and returns the same completed plan and binding', async () => {
  await withSubmittedAnchor(async ({ root, anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const derived = derivedRequest(inputs);
    const reply = structuredReply(derived.request);
    const first = await acceptSelectionReply({ anchor, ...inputs, reply });
    const replyStat = await lstat(path.join(root, 'runs', P27_RUN_ID, 'selection-reply.record.json'));
    const planStat = await lstat(path.join(root, 'runs', P27_RUN_ID, 'resolved-plan.record.json'));

    const replay = await acceptSelectionReply({
      anchor,
      ...structuredClone(inputs),
      reply: structuredClone(reply),
    });
    assert.equal(replay.created, false);
    assert.equal(replay.disposition, 'resolution_ready');
    assert.equal(canonicalJsonStringify(replay.plan), canonicalJsonStringify(first.plan));
    assert.equal(canonicalJsonStringify(replay.aggregate_binding),
      canonicalJsonStringify(first.aggregate_binding));
    assert.equal(replay.coordination.state_digest, first.coordination.state_digest);
    assert.equal((await lstat(path.join(root, 'runs', P27_RUN_ID, 'selection-reply.record.json'))).ino,
      replyStat.ino);
    assert.equal((await lstat(path.join(root, 'runs', P27_RUN_ID, 'resolved-plan.record.json'))).ino,
      planStat.ino);
  });
});

test('accept does not create a missing question and rejects a different reply after settlement', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    const derived = derivedRequest(inputs);
    const missing = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request),
    }));
    assert.equal(missing.code, 'selection_not_awaiting');
    const coordination = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(coordination.phase, 'submitted');
    assert.equal(coordination.selection_request_binding, null);

    await persistSelectionQuestionBatch({ anchor, ...inputs });
    await acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request),
    });
    const settled = await anchor.getCoordination(P27_RUN_ID);
    const different = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, completeAnswers(derived.request, 'dsh', 'stealth/ox-alpha')),
    }));
    assert.ok(['aggregate_run_revision_conflict', 'stale_selection_request'].includes(different.code),
      different.code);
    const after = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(after.state_digest, settled.state_digest);
  });
});

test('partial extra duplicate and scoped-invalid answers fail closed with no mutation', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const derived = derivedRequest(inputs);
    const before = await anchor.getCoordination(P27_RUN_ID);

    const partial = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, []),
    }));
    assert.equal(partial.code, 'selection_answers_rejected');

    const extra = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, [
        ...completeAnswers(derived.request),
        { assignment_id: 'lane-9', provider: 'grok', model: 'grok-4' },
      ]),
    }));
    assert.equal(extra.code, 'selection_answers_rejected');

    const duplicate = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, [
        { assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' },
        { assignment_id: 'lane-0', provider: 'dsh', model: 'stealth/ox-alpha' },
      ]),
    }));
    assert.equal(duplicate.code, 'selection_answers_rejected');

    const scoped = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, [
        { assignment_id: 'lane-0', provider: 'unknown', model: 'grok-4' },
      ]),
    }));
    assert.equal(scoped.code, 'selection_answers_rejected');

    const after = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(after.state_digest, before.state_digest);
    assert.equal(after.phase, 'awaiting_selection');
  });
});

test('crash after each commit plus reopen uses only durable R24A records', async () => {
  const inputs = makePersistenceInputs();
  const root = await makePrivateRoot('r1-p27-crash-after-');
  try {
    const live = await initializeAggregateRunAnchorRoot(root);
    await live.submit(makeSubmitInput(inputs));
    const afterRequest = wrapAnchor(live, {
      afterCommitRequest: async () => {
        throw new RunContractV1Error('injected_after_request', 'commit', 'injected after request');
      },
    });
    const requestInjected = await errorOf(() => persistSelectionQuestionBatch({
      anchor: afterRequest,
      ...inputs,
    }));
    assert.equal(requestInjected.code, 'injected_after_request');

    const reopened = await openAggregateRunAnchor(root);
    const replayed = await persistSelectionQuestionBatch({ anchor: reopened, ...inputs });
    assert.equal(replayed.created, false);
    assert.equal(replayed.disposition, 'awaiting_selection');

    const derived = derivedRequest(inputs);
    const afterResolution = wrapAnchor(reopened, {
      afterCommitResolution: async () => {
        throw new RunContractV1Error('injected_after_resolution', 'commit', 'injected after resolution');
      },
    });
    const resolutionInjected = await errorOf(() => acceptSelectionReply({
      anchor: afterResolution,
      ...inputs,
      reply: structuredReply(derived.request),
    }));
    assert.equal(resolutionInjected.code, 'injected_after_resolution');

    const settled = await openAggregateRunAnchor(root);
    const completed = await acceptSelectionReply({
      anchor: settled,
      ...inputs,
      reply: structuredReply(derived.request),
    });
    assert.equal(completed.created, false);
    assert.equal(completed.disposition, 'resolution_ready');
    assert.equal(completed.aggregate_binding.revision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent identical persist and reply requests converge; different replies have one winner', async () => {
  const inputs = makePersistenceInputs({ runId: 'p27-concurrent-run' });
  const root = await makePrivateRoot('r1-p27-conc-');
  try {
    const anchor = await initializeAggregateRunAnchorRoot(root);
    await anchor.submit(makeSubmitInput(inputs));

    const persistWorkers = [
      spawnWorker({ root, mode: 'persist', runId: 'p27-concurrent-run' }),
      spawnWorker({ root, mode: 'persist', runId: 'p27-concurrent-run' }),
    ];
    const persistResults = await Promise.all(persistWorkers.map((worker) => worker.done));
    assert.equal(persistResults.filter((item) => item.ok).length, 2);
    assert.equal(persistResults.filter((item) => item.created).length, 1);
    assert.equal(persistResults.filter((item) => item.ok && item.created === false).length, 1);

    const sameReply = [
      spawnWorker({ root, mode: 'reply', runId: 'p27-concurrent-run' }),
      spawnWorker({ root, mode: 'reply', runId: 'p27-concurrent-run' }),
    ];
    const sameResults = await Promise.all(sameReply.map((worker) => worker.done));
    assert.equal(sameResults.filter((item) => item.ok).length, 2);
    assert.equal(sameResults.filter((item) => item.created).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const mixedRoot = await makePrivateRoot('r1-p27-conc-diff-');
  const mixedInputs = makePersistenceInputs({ runId: 'p27-concurrent-diff' });
  try {
    const mixedAnchor = await initializeAggregateRunAnchorRoot(mixedRoot);
    await mixedAnchor.submit(makeSubmitInput(mixedInputs));
    await persistSelectionQuestionBatch({ anchor: mixedAnchor, ...mixedInputs });
    const mixed = await Promise.all([
      spawnWorker({ root: mixedRoot, mode: 'reply', runId: 'p27-concurrent-diff' }).done,
      spawnWorker({ root: mixedRoot, mode: 'reply-alt', runId: 'p27-concurrent-diff' }).done,
    ]);
    const winners = mixed.filter((item) => item.ok);
    const losers = mixed.filter((item) => !item.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(winners[0].created, true);
    assert.ok([
      'aggregate_run_revision_conflict',
      'aggregate_run_binding_conflict',
      'stale_selection_request',
    ].includes(losers[0].code), losers[0].code);
    const coordination = await mixedAnchor.getCoordination('p27-concurrent-diff');
    assert.equal(coordination.phase, 'resolution_ready');
    assert.equal(coordination.revision, 2);
  } finally {
    await rm(mixedRoot, { recursive: true, force: true });
  }
});
