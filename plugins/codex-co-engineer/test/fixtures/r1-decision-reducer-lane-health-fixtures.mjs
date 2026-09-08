// Construction-only fixtures for the decision reducer and lane-health
// projection. Tests own the assertions. These helpers never invoke a model,
// invent success, or inline expensive evidence bytes.

import {
  DECISION_RECEIPT_SCHEMA_ID,
  DECISION_REDUCTION_REQUEST_SCHEMA_ID,
} from '../../mcp/v3/decision-reducer.mjs';
import {
  LANE_HEALTH_FROM_RECEIPTS_SCHEMA_ID,
  LANE_HEALTH_REQUEST_SCHEMA_ID,
} from '../../mcp/v3/lane-health.mjs';

export const RUN_ID = 'run-lane-health';
export const ASSIGNMENT_A = 'a0';
export const ASSIGNMENT_B = 'a1';
export const BRANCH = 'codex/lane-a';
export const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const TREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const DIGEST_A = `sha256:${'a'.repeat(64)}`;
export const DIGEST_B = `sha256:${'b'.repeat(64)}`;
export const STARTED_AT = '2026-08-28T10:00:00.000Z';
export const DEADLINE_AT = '2026-08-28T11:00:00.000Z';
export const NOW_OK = '2026-08-28T10:30:00.000Z';
export const NOW_LATE = '2026-08-28T11:30:00.000Z';
export const EXPECTED_DURATION_MS = 3_600_000;
export const HOSTILE_SECRET = 'sk-live-ATTACKER-SECRET';
export const HOSTILE_PATH = '/tmp/attacker';

export function countingProxy(target) {
  const counts = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0, apply: 0 };
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      counts.get += 1;
      return Reflect.get(inner, property, receiver);
    },
    ownKeys(inner) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, property) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
    has(inner, property) {
      counts.has += 1;
      return Reflect.has(inner, property);
    },
    apply() {
      counts.apply += 1;
      throw new Error('proxy apply must never run');
    },
  });
  return { proxy, counts };
}

export function trapTotal(counts) {
  return counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has + counts.apply;
}

export function receipt(overrides = {}) {
  return {
    schema: DECISION_RECEIPT_SCHEMA_ID,
    assignment_id: ASSIGNMENT_A,
    attempt: 1,
    generation: 1,
    seq: 1,
    kind: 'identity',
    cursor: 'cur-1',
    observed_at: STARTED_AT,
    data: {
      provider: 'grok',
      branch: BRANCH,
      head: HEAD,
      tree: TREE,
    },
    ...overrides,
    data: overrides.data !== undefined ? overrides.data : {
      provider: 'grok',
      branch: BRANCH,
      head: HEAD,
      tree: TREE,
    },
  };
}

export function identityReceipt(overrides = {}) {
  return receipt({ kind: 'identity', seq: 1, ...overrides });
}

export function lifecycleReceipt(state, overrides = {}) {
  return receipt({
    kind: 'lifecycle',
    seq: 2,
    data: { state },
    ...overrides,
    data: overrides.data ?? { state },
  });
}

export function timingReceipt(overrides = {}) {
  return receipt({
    kind: 'timing',
    seq: 3,
    data: {
      started_at: STARTED_AT,
      expected_duration_ms: EXPECTED_DURATION_MS,
      deadline_at: DEADLINE_AT,
    },
    ...overrides,
    data: overrides.data ?? {
      started_at: STARTED_AT,
      expected_duration_ms: EXPECTED_DURATION_MS,
      deadline_at: DEADLINE_AT,
    },
  });
}

export function outcomeReceipt(outcome, overrides = {}) {
  return receipt({
    kind: 'outcome',
    seq: 4,
    data: { outcome },
    ...overrides,
    data: overrides.data ?? { outcome },
  });
}

export function attentionReceipt(overrides = {}) {
  return receipt({
    kind: 'attention',
    seq: 5,
    data: { question_id: 'q_scope' },
    ...overrides,
    data: overrides.data ?? { question_id: 'q_scope' },
  });
}

export function errorReceipt(code = 'terminal_error', overrides = {}) {
  return receipt({
    kind: 'error',
    seq: 6,
    data: { code },
    ...overrides,
    data: overrides.data ?? { code },
  });
}

export function decisionReceipt(code, overrides = {}) {
  return receipt({
    kind: 'decision',
    seq: 7,
    data: { code },
    ...overrides,
    data: overrides.data ?? { code },
  });
}

export function retrievalReceipt(kind = 'diff', overrides = {}) {
  return receipt({
    kind: 'retrieval',
    seq: 8,
    data: { kind, digest: DIGEST_A, bytes: 128 },
    ...overrides,
    data: overrides.data ?? { kind, digest: DIGEST_A, bytes: 128 },
  });
}

export function reductionRequest(receipts, overrides = {}) {
  return {
    schema: DECISION_REDUCTION_REQUEST_SCHEMA_ID,
    run_id: RUN_ID,
    receipts,
    ...overrides,
  };
}

export function healthFromReceiptsRequest(receipts, now = NOW_OK, overrides = {}) {
  return {
    schema: LANE_HEALTH_FROM_RECEIPTS_SCHEMA_ID,
    run_id: RUN_ID,
    receipts,
    now,
    ...overrides,
  };
}

export function healthRequest(reduction, now = NOW_OK) {
  return {
    schema: LANE_HEALTH_REQUEST_SCHEMA_ID,
    now,
    reduction,
  };
}

export function runningLaneReceipts(overrides = {}) {
  const base = { attempt: 1, generation: 1, ...overrides };
  return [
    identityReceipt(base),
    lifecycleReceipt('running', { ...base, seq: 2 }),
    timingReceipt({ ...base, seq: 3 }),
  ];
}
