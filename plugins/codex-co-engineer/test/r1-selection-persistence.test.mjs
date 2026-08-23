import assert from 'node:assert/strict';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  initializeAggregateRunAnchorRoot,
  openAggregateRunAnchor,
} from '../mcp/v3/aggregate-run-anchor.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  SELECTION_QUESTION_BATCH_RECEIPT_SCHEMA_ID,
  persistSelectionQuestionBatch,
} from '../mcp/v3/selection-persistence.mjs';
import {
  P27_RUN_ID,
  derivedRequest,
  makePersistenceInputs,
  makePrivateRoot,
  makeSubmitInput,
  wrapAnchor,
  withSubmittedAnchor,
} from './fixtures/r1-selection-persistence-fixtures.mjs';

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

