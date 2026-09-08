import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECISION_RECEIPT_SCHEMA_ID,
  DECISION_REDUCTION_SCHEMA_ID,
  DEFAULT_REDUCTION_MODE,
  MAX_RECEIPTS,
  describeDecisionReducerV1,
  reduceDecisionReceiptsV1,
  validateDecisionReceiptV1,
} from '../mcp/v3/decision-reducer.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ASSIGNMENT_A,
  ASSIGNMENT_B,
  BRANCH,
  DEADLINE_AT,
  DIGEST_A,
  HEAD,
  NOW_OK,
  RUN_ID,
  TREE,
  decisionReceipt,
  identityReceipt,
  lifecycleReceipt,
  outcomeReceipt,
  reductionRequest,
  retrievalReceipt,
  runningLaneReceipts,
  timingReceipt,
} from './fixtures/r1-decision-reducer-lane-health-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertFrozenTree(value) {
  assert.ok(value === null || typeof value !== 'object' || Object.isFrozen(value),
    'returned records must be frozen');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

test('describe surface is closed, frozen, and default-aggregates without a model', () => {
  const described = describeDecisionReducerV1();
  assert.equal(described.schema, DECISION_REDUCTION_SCHEMA_ID);
  assert.equal(described.default_reduction, DEFAULT_REDUCTION_MODE);
  assert.equal(described.claims.never_invokes_model, true);
  assert.equal(described.claims.model_synthesis_explicit_only, true);
  assert.equal(described.claims.never_consumes_transcripts, true);
  assertFrozenTree(described);
});

test('default reduction aggregates typed identity and lifecycle without synthesis', () => {
  const reduced = reduceDecisionReceiptsV1(reductionRequest(runningLaneReceipts()));
  assert.equal(reduced.schema, DECISION_REDUCTION_SCHEMA_ID);
  assert.equal(reduced.run_id, RUN_ID);
  assert.equal(reduced.reduction, 'aggregate');
  assert.equal(reduced.exceptional, false);
  assert.equal(reduced.truncated, false);
  assert.equal(reduced.truncation, null);
  assert.equal(reduced.lanes.length, 1);
  const lane = reduced.lanes[0];
  assert.equal(lane.assignment_id, ASSIGNMENT_A);
  assert.equal(lane.provider, 'grok');
  assert.equal(lane.branch, BRANCH);
  assert.equal(lane.head, HEAD);
  assert.equal(lane.tree, TREE);
  assert.equal(lane.attempt, 1);
  assert.equal(lane.generation, 1);
  assert.equal(lane.cursor, 'cur-1');
  assert.equal(lane.lifecycle, 'running');
  assert.equal(lane.outcome, null);
  assert.equal(lane.settled, false);
  assert.equal(lane.unknown_timing, false);
  assert.equal(lane.deadline_at, DEADLINE_AT);
  assert.match(reduced.digest, /^sha256:[0-9a-f]{64}$/u);
  assertFrozenTree(reduced);
});

test('omitted reduction mode is aggregate and never model_synthesis', () => {
  const reduced = reduceDecisionReceiptsV1(reductionRequest([identityReceipt()]));
  assert.equal(reduced.reduction, 'aggregate');
  assert.equal(reduced.exceptional, false);
  assert.equal(Object.hasOwn(reduced, 'summary'), false);
  assert.equal(Object.hasOwn(reduced, 'synthesis'), false);
});

test('explicit model_synthesis is exceptional and still does not synthesize text', () => {
  const reduced = reduceDecisionReceiptsV1(reductionRequest([identityReceipt()], {
    reduction: 'model_synthesis',
  }));
  assert.equal(reduced.reduction, 'model_synthesis');
  assert.equal(reduced.exceptional, true);
  assert.equal(reduced.lanes[0].branch, BRANCH);
  assert.equal(Object.hasOwn(reduced, 'transcript'), false);
  assert.equal(Object.hasOwn(reduced, 'completion'), false);
  assert.equal(typeof reduced.lanes[0].branch, 'string');
});

test('expensive details stay retrieval references', () => {
  const reduced = reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt(),
    retrievalReceipt('diff', { seq: 8 }),
    retrievalReceipt('ci', { seq: 9, data: { kind: 'ci', digest: DIGEST_A, bytes: 64 } }),
  ]));
  const lane = reduced.lanes[0];
  assert.equal(lane.retrievals.length, 2);
  assert.deepEqual(lane.retrievals[0], { kind: 'ci', digest: DIGEST_A, bytes: 64 });
  assert.deepEqual(lane.retrievals[1], { kind: 'diff', digest: DIGEST_A, bytes: 128 });
  assert.equal(Object.hasOwn(lane.retrievals[0], 'payload'), false);
  assert.equal(Object.hasOwn(lane.retrievals[0], 'text'), false);
});

test('typed decisions aggregate uniquely and sorted', () => {
  const reduced = reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt(),
    decisionReceipt('scope_ok', { seq: 7 }),
    decisionReceipt('tests_ok', { seq: 8 }),
    decisionReceipt('scope_ok', { seq: 9 }),
  ]));
  assert.deepEqual(reduced.lanes[0].decisions, ['scope_ok', 'tests_ok']);
});

test('two lanes reduce independently and sort by assignment id', () => {
  const reduced = reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt({ assignment_id: ASSIGNMENT_B, seq: 1, data: {
      provider: 'dsh', branch: 'codex/lane-b', head: HEAD, tree: TREE,
    } }),
    identityReceipt({ assignment_id: ASSIGNMENT_A, seq: 1 }),
  ]));
  assert.equal(reduced.lanes.length, 2);
  assert.equal(reduced.lanes[0].assignment_id, ASSIGNMENT_A);
  assert.equal(reduced.lanes[1].assignment_id, ASSIGNMENT_B);
  assert.equal(reduced.lanes[1].provider, 'dsh');
});

test('identical inputs produce identical digests', () => {
  const request = reductionRequest(runningLaneReceipts());
  const first = reduceDecisionReceiptsV1(request);
  const second = reduceDecisionReceiptsV1(request);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first, second);
});

test('unknown identity fields stay null rather than invented', () => {
  const reduced = reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt({
      data: { provider: 'grok', branch: null, head: null, tree: null },
    }),
  ]));
  const lane = reduced.lanes[0];
  assert.equal(lane.provider, 'grok');
  assert.equal(lane.branch, null);
  assert.equal(lane.head, null);
  assert.equal(lane.tree, null);
});

test('validateDecisionReceiptV1 returns a detached snapshot', () => {
  const input = identityReceipt();
  const parsed = validateDecisionReceiptV1(input);
  assert.equal(parsed.schema, DECISION_RECEIPT_SCHEMA_ID);
  input.assignment_id = 'mutated';
  assert.equal(parsed.assignment_id, ASSIGNMENT_A);
});

test('caller now is not a reducer input', () => {
  const error = errorOf(() => reduceDecisionReceiptsV1(reductionRequest([identityReceipt()], {
    now: NOW_OK,
  })));
  assert.equal(error.code, 'unknown_key');
});

test('receipt bound is a documented finite cap', () => {
  assert.equal(MAX_RECEIPTS, 64);
  const described = describeDecisionReducerV1();
  assert.equal(described.bounds.max_receipts, MAX_RECEIPTS);
});
