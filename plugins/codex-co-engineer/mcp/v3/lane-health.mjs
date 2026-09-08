// Progressive lane-health projection over a DecisionReductionV1 record.
// Projects branch, head, tree (when known), provider, attempt, generation,
// cursor, and lifecycle immediately. Health is derived only from deterministic
// timing and receipt facts: healthy, late, needs_attention, failed, unresolved,
// or terminal. Unknown is preserved; success is never invented. This module
// performs no I/O, reads no ambient clock, and never invokes a model.

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedJoin,
  capturedTest,
} from './grammar.mjs';
import {
  DECISION_REDUCTION_REQUEST_SCHEMA_ID,
  reduceDecisionReceiptsV1,
  reductionFramedDigestV1,
  validateDecisionReductionV1,
} from './decision-reducer.mjs';
import {
  closedObject,
  fail,
  snapshotRecord,
} from './protected-identity.mjs';
import { assertNotProxy } from './selection-json.mjs';

export const LANE_HEALTH_SCHEMA_ID = 'codex-co-engineer.lane-health.v1';
export const LANE_HEALTH_REQUEST_SCHEMA_ID = 'codex-co-engineer.lane-health-request.v1';
export const LANE_HEALTH_DIGEST_DOMAIN = 'codex-co-engineer.lane-health-hash.v1';
export const LANE_HEALTH_VERSION = 1;

export const LANE_HEALTH_STATES = capturedFreeze([
  'healthy', 'late', 'needs_attention', 'failed', 'unresolved', 'terminal',
]);
export const LANE_HEALTH_REASONS = capturedFreeze([
  'healthy',
  'late',
  'needs_attention',
  'failed',
  'timeout',
  'environment_blocked',
  'hidden_failure',
  'contradictory_terminal_facts',
  'unresolved',
  'transport_lost',
  'timing_unknown',
  'lifecycle_unknown',
  'completed',
  'cancelled',
]);

export const HEALTH_REQUEST_KEYS = capturedFreeze(['schema', 'now', 'reduction']);
export const FROM_RECEIPTS_KEYS = capturedFreeze([
  'schema', 'run_id', 'receipts', 'now', 'reduction',
]);
export const FROM_RECEIPTS_REQUIRED_KEYS = capturedFreeze(['run_id', 'receipts', 'now']);
export const LANE_HEALTH_FROM_RECEIPTS_SCHEMA_ID =
  'codex-co-engineer.lane-health-from-receipts.v1';
export const HEALTH_RECORD_KEYS = capturedFreeze([
  'schema', 'version', 'run_id', 'reduction', 'exceptional', 'truncated',
  'now', 'lanes', 'digest',
]);
export const HEALTH_LANE_KEYS = capturedFreeze([
  'assignment_id', 'provider', 'branch', 'head', 'tree', 'attempt', 'generation',
  'cursor', 'lifecycle', 'health', 'reason', 'unknown',
]);
export const HEALTH_UNKNOWN_KEYS = capturedFreeze([
  'provider', 'branch', 'head', 'tree', 'attempt', 'generation', 'cursor',
  'lifecycle', 'timing',
]);

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DATE_PARSE = Date.parse;
const DATE_ISO = Date.prototype.toISOString;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const ARRAY_FROM = Array.from;

function assertNullableTimestamp(value, path) {
  if (value === null) return null;
  if (typeof value !== 'string' || !capturedTest(TIMESTAMP_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a canonical UTC timestamp or null.`);
  }
  const parsed = DATE_PARSE(value);
  if (!NUMBER_IS_SAFE_INTEGER(parsed) || DATE_ISO.call(new Date(parsed)) !== value) {
    fail('invalid_format', path, `${path} must be a canonical UTC timestamp or null.`);
  }
  return value;
}

function deadlineMs(lane) {
  if (typeof lane.deadline_at === 'string') return DATE_PARSE(lane.deadline_at);
  if (typeof lane.started_at === 'string' && NUMBER_IS_SAFE_INTEGER(lane.expected_duration_ms)) {
    return DATE_PARSE(lane.started_at) + lane.expected_duration_ms;
  }
  return null;
}

function deriveHealth(lane, now) {
  if (lane.contradiction === true) {
    return { health: 'unresolved', reason: 'contradictory_terminal_facts' };
  }
  if (lane.hidden_failure === true) {
    return { health: 'failed', reason: 'hidden_failure' };
  }
  if (lane.outcome === 'failed' || lane.lifecycle === 'failed') {
    return { health: 'failed', reason: 'failed' };
  }
  if (lane.outcome === 'timeout' || lane.lifecycle === 'timeout') {
    return { health: 'failed', reason: 'timeout' };
  }
  if (lane.outcome === 'environment_blocked' || lane.lifecycle === 'environment_blocked') {
    return { health: 'failed', reason: 'environment_blocked' };
  }
  if (lane.outcome === 'unresolved' || lane.lifecycle === 'unresolved') {
    return { health: 'unresolved', reason: 'unresolved' };
  }
  if (lane.lifecycle === 'transport_lost') {
    return { health: 'unresolved', reason: 'transport_lost' };
  }
  if (lane.attention === true || lane.lifecycle === 'needs_attention') {
    return { health: 'needs_attention', reason: 'needs_attention' };
  }
  if (lane.outcome === 'completed' || lane.lifecycle === 'completed') {
    return { health: 'terminal', reason: 'completed' };
  }
  if (lane.outcome === 'cancelled' || lane.lifecycle === 'cancelled') {
    return { health: 'terminal', reason: 'cancelled' };
  }

  const inProgress = lane.lifecycle === null
    || capturedIncludes(['accepted', 'starting', 'dispatched', 'running'], lane.lifecycle);
  if (!inProgress) {
    return { health: 'unresolved', reason: 'lifecycle_unknown' };
  }
  if (lane.lifecycle === null) {
    return { health: 'unresolved', reason: 'lifecycle_unknown' };
  }
  if (now === null || lane.unknown_timing === true || deadlineMs(lane) === null) {
    return { health: 'unresolved', reason: 'timing_unknown' };
  }
  const nowMs = DATE_PARSE(now);
  if (nowMs > deadlineMs(lane)) {
    return { health: 'late', reason: 'late' };
  }
  return { health: 'healthy', reason: 'healthy' };
}

function projectUnknown(lane, now) {
  return {
    provider: lane.provider === null,
    branch: lane.branch === null,
    head: lane.head === null,
    tree: lane.tree === null,
    attempt: lane.attempt === null,
    generation: lane.generation === null,
    cursor: lane.cursor === null,
    lifecycle: lane.lifecycle === null,
    timing: now === null || lane.unknown_timing === true || deadlineMs(lane) === null,
  };
}

export { validateDecisionReductionV1 };

function projectLane(lane, now) {
  const { health, reason } = deriveHealth(lane, now);
  return {
    assignment_id: lane.assignment_id,
    provider: lane.provider,
    branch: lane.branch,
    head: lane.head,
    tree: lane.tree,
    attempt: lane.attempt,
    generation: lane.generation,
    cursor: lane.cursor,
    lifecycle: lane.lifecycle,
    health,
    reason,
    unknown: projectUnknown(lane, now),
  };
}

export function projectLaneHealthV1(input) {
  assertNotProxy(input, 'request');
  const fields = closedObject(input, 'request', HEALTH_REQUEST_KEYS);
  if (fields.schema !== LANE_HEALTH_REQUEST_SCHEMA_ID) {
    fail('invalid_format', 'request.schema',
      `request.schema must be exactly "${LANE_HEALTH_REQUEST_SCHEMA_ID}".`);
  }
  const now = assertNullableTimestamp(fields.now, 'request.now');
  const reduction = validateDecisionReductionV1(fields.reduction, 'request.reduction');
  const lanes = [];
  for (const lane of reduction.lanes) lanes.push(projectLane(lane, now));
  const payload = {
    schema: LANE_HEALTH_SCHEMA_ID,
    version: LANE_HEALTH_VERSION,
    run_id: reduction.run_id,
    reduction: reduction.reduction,
    exceptional: reduction.exceptional,
    truncated: reduction.truncated,
    now,
    lanes,
  };
  const digest = reductionFramedDigestV1(LANE_HEALTH_DIGEST_DOMAIN, payload);
  return snapshotRecord({ ...payload, digest });
}

export function projectLaneHealthFromReceiptsV1(input) {
  assertNotProxy(input, 'request');
  const fields = closedObject(input, 'request', FROM_RECEIPTS_KEYS, FROM_RECEIPTS_REQUIRED_KEYS);
  if (capturedHasOwn(fields, 'schema') && fields.schema !== LANE_HEALTH_FROM_RECEIPTS_SCHEMA_ID) {
    fail('invalid_format', 'request.schema',
      `request.schema must be exactly "${LANE_HEALTH_FROM_RECEIPTS_SCHEMA_ID}".`);
  }
  const reductionInput = {
    schema: DECISION_REDUCTION_REQUEST_SCHEMA_ID,
    run_id: fields.run_id,
    receipts: fields.receipts,
    ...(capturedHasOwn(fields, 'reduction') ? { reduction: fields.reduction } : {}),
  };
  const reduction = reduceDecisionReceiptsV1(reductionInput);
  return projectLaneHealthV1({
    schema: LANE_HEALTH_REQUEST_SCHEMA_ID,
    now: fields.now,
    reduction,
  });
}

export function describeLaneHealthV1() {
  return snapshotRecord({
    schema: LANE_HEALTH_SCHEMA_ID,
    version: LANE_HEALTH_VERSION,
    health: ARRAY_FROM(LANE_HEALTH_STATES),
    reasons: ARRAY_FROM(LANE_HEALTH_REASONS),
    immediate: capturedJoin([
      'branch', 'head', 'tree', 'provider', 'attempt', 'generation', 'cursor', 'lifecycle',
    ], ','),
    api: [
      'describeLaneHealthV1',
      'projectLaneHealthV1',
      'projectLaneHealthFromReceiptsV1',
      'validateDecisionReductionV1',
    ],
    claims: {
      projects_known_identity_immediately: true,
      preserves_unknown: true,
      never_invents_success: true,
      never_invokes_model: true,
      uses_caller_now_only: true,
    },
  });
}

capturedFreeze(projectLaneHealthV1);
capturedFreeze(projectLaneHealthFromReceiptsV1);
capturedFreeze(validateDecisionReductionV1);
capturedFreeze(describeLaneHealthV1);
