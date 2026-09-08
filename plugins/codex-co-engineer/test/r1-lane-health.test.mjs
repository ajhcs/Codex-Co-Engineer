import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceDecisionReceiptsV1 } from '../mcp/v3/decision-reducer.mjs';
import {
  LANE_HEALTH_SCHEMA_ID,
  LANE_HEALTH_STATES,
  describeLaneHealthV1,
  projectLaneHealthFromReceiptsV1,
  projectLaneHealthV1,
} from '../mcp/v3/lane-health.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ASSIGNMENT_A,
  BRANCH,
  HEAD,
  NOW_LATE,
  NOW_OK,
  RUN_ID,
  TREE,
  attentionReceipt,
  healthFromReceiptsRequest,
  healthRequest,
  identityReceipt,
  lifecycleReceipt,
  outcomeReceipt,
  reductionRequest,
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

test('describe surface lists the six health states and immediate fields', () => {
  const described = describeLaneHealthV1();
  assert.equal(described.schema, LANE_HEALTH_SCHEMA_ID);
  assert.deepEqual(described.health, [...LANE_HEALTH_STATES]);
  assert.match(described.immediate, /branch,head,tree,provider,attempt,generation,cursor,lifecycle/u);
  assert.equal(described.claims.preserves_unknown, true);
  assert.equal(described.claims.never_invents_success, true);
  assert.equal(described.claims.never_invokes_model, true);
  assertFrozenTree(described);
});

test('projects branch, head, tree, provider, attempt, generation, cursor, and lifecycle immediately', () => {
  const projected = projectLaneHealthFromReceiptsV1(
    healthFromReceiptsRequest(runningLaneReceipts(), NOW_OK),
  );
  assert.equal(projected.schema, LANE_HEALTH_SCHEMA_ID);
  assert.equal(projected.run_id, RUN_ID);
  assert.equal(projected.reduction, 'aggregate');
  assert.equal(projected.exceptional, false);
  assert.equal(projected.now, NOW_OK);
  const lane = projected.lanes[0];
  assert.equal(lane.assignment_id, ASSIGNMENT_A);
  assert.equal(lane.branch, BRANCH);
  assert.equal(lane.head, HEAD);
  assert.equal(lane.tree, TREE);
  assert.equal(lane.provider, 'grok');
  assert.equal(lane.attempt, 1);
  assert.equal(lane.generation, 1);
  assert.equal(lane.cursor, 'cur-1');
  assert.equal(lane.lifecycle, 'running');
  assert.equal(lane.health, 'healthy');
  assert.equal(lane.reason, 'healthy');
  assert.equal(lane.unknown.branch, false);
  assert.equal(lane.unknown.timing, false);
  assertFrozenTree(projected);
});

test('identity-only receipts project known git fields before health is knowable', () => {
  const projected = projectLaneHealthFromReceiptsV1(
    healthFromReceiptsRequest([identityReceipt()], NOW_OK),
  );
  const lane = projected.lanes[0];
  assert.equal(lane.branch, BRANCH);
  assert.equal(lane.head, HEAD);
  assert.equal(lane.tree, TREE);
  assert.equal(lane.lifecycle, null);
  assert.equal(lane.health, 'unresolved');
  assert.equal(lane.reason, 'lifecycle_unknown');
  assert.equal(lane.unknown.lifecycle, true);
  assert.equal(lane.unknown.branch, false);
});

test('late is derived from caller now versus deadline facts', () => {
  const projected = projectLaneHealthFromReceiptsV1(
    healthFromReceiptsRequest(runningLaneReceipts(), NOW_LATE),
  );
  assert.equal(projected.lanes[0].health, 'late');
  assert.equal(projected.lanes[0].reason, 'late');
});

test('needs_attention wins over in-progress healthy timing', () => {
  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest([
    ...runningLaneReceipts(),
    attentionReceipt({ seq: 5 }),
  ], NOW_OK));
  assert.equal(projected.lanes[0].health, 'needs_attention');
  assert.equal(projected.lanes[0].reason, 'needs_attention');
});

test('clean completed outcome is terminal, not invented success language', () => {
  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest([
    identityReceipt(),
    lifecycleReceipt('completed', { seq: 2 }),
    outcomeReceipt('completed', { seq: 4 }),
  ], NOW_OK));
  const lane = projected.lanes[0];
  assert.equal(lane.health, 'terminal');
  assert.equal(lane.reason, 'completed');
  assert.equal(lane.lifecycle, 'completed');
});

test('failed outcome projects failed', () => {
  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest([
    identityReceipt(),
    lifecycleReceipt('failed', { seq: 2 }),
    outcomeReceipt('failed', { seq: 4 }),
  ], NOW_OK));
  assert.equal(projected.lanes[0].health, 'failed');
  assert.equal(projected.lanes[0].reason, 'failed');
});

test('projectLaneHealthV1 consumes a reduction record and a caller now', () => {
  const reduction = reduceDecisionReceiptsV1(reductionRequest(runningLaneReceipts()));
  const projected = projectLaneHealthV1(healthRequest(reduction, NOW_OK));
  assert.equal(projected.lanes[0].health, 'healthy');
  const late = projectLaneHealthV1(healthRequest(reduction, NOW_LATE));
  assert.equal(late.lanes[0].health, 'late');
});

test('missing now key fails closed instead of reading a clock', () => {
  const error = errorOf(() => projectLaneHealthFromReceiptsV1({
    schema: 'codex-co-engineer.lane-health-from-receipts.v1',
    run_id: RUN_ID,
    receipts: runningLaneReceipts(),
  }));
  assert.equal(error.code, 'missing_key');
  assert.equal(error.path, 'request.now');
});

test('timing facts without started_at or deadline stay unknown, not healthy', () => {
  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest([
    identityReceipt(),
    lifecycleReceipt('running', { seq: 2 }),
    timingReceipt({
      seq: 3,
      data: { started_at: null, expected_duration_ms: null, deadline_at: null },
    }),
  ], NOW_OK));
  assert.equal(projected.lanes[0].health, 'unresolved');
  assert.equal(projected.lanes[0].reason, 'timing_unknown');
  assert.equal(projected.lanes[0].unknown.timing, true);
});
