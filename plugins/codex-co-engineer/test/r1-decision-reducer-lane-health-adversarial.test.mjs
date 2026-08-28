import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DECISION_REDUCTION_DIGEST_DOMAIN,
  MAX_DECISIONS_PER_LANE,
  MAX_RECEIPTS,
  MAX_RETRIEVALS_PER_LANE,
  reduceDecisionReceiptsV1,
  reductionFramedDigestV1,
} from '../mcp/v3/decision-reducer.mjs';
import {
  projectLaneHealthFromReceiptsV1,
  projectLaneHealthV1,
  validateDecisionReductionV1,
} from '../mcp/v3/lane-health.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ASSIGNMENT_B,
  BRANCH,
  DIGEST_A,
  HEAD,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  NOW_OK,
  TREE,
  countingProxy,
  decisionReceipt,
  errorReceipt,
  healthFromReceiptsRequest,
  healthRequest,
  identityReceipt,
  lifecycleReceipt,
  outcomeReceipt,
  reductionRequest,
  retrievalReceipt,
  runningLaneReceipts,
  timingReceipt,
  trapTotal,
} from './fixtures/r1-decision-reducer-lane-health-fixtures.mjs';

const REDUCER_PATH = fileURLToPath(new URL('../mcp/v3/decision-reducer.mjs', import.meta.url));
const HEALTH_PATH = fileURLToPath(new URL('../mcp/v3/lane-health.mjs', import.meta.url));

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

test('stale attempts cannot settle a replacement generation', () => {
  const receipts = [
    identityReceipt({ attempt: 2, generation: 1, seq: 1 }),
    lifecycleReceipt('running', { attempt: 2, generation: 1, seq: 2 }),
    outcomeReceipt('completed', { attempt: 1, generation: 1, seq: 4 }),
    identityReceipt({ attempt: 1, generation: 1, seq: 1, cursor: 'stale-cur' }),
  ];
  const reduced = reduceDecisionReceiptsV1(reductionRequest(receipts));
  const lane = reduced.lanes[0];
  assert.equal(lane.attempt, 2);
  assert.equal(lane.generation, 1);
  assert.equal(lane.lifecycle, 'running');
  assert.equal(lane.outcome, null);
  assert.equal(lane.settled, false);
  assert.equal(lane.stale_ignored, 2);
  assert.equal(lane.cursor, 'cur-1');

  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(receipts, NOW_OK));
  assert.equal(projected.lanes[0].health, 'unresolved');
  assert.equal(projected.lanes[0].reason, 'timing_unknown');
  assert.notEqual(projected.lanes[0].health, 'terminal');
});

test('higher generation of the same attempt ignores stale outcomes', () => {
  const receipts = [
    identityReceipt({ generation: 2, seq: 1 }),
    lifecycleReceipt('running', { generation: 2, seq: 2 }),
    outcomeReceipt('completed', { generation: 1, seq: 9 }),
    timingReceipt({ generation: 2, seq: 3 }),
  ];
  const reduced = reduceDecisionReceiptsV1(reductionRequest(receipts));
  assert.equal(reduced.lanes[0].generation, 2);
  assert.equal(reduced.lanes[0].outcome, null);
  assert.equal(reduced.lanes[0].settled, false);
  assert.equal(reduced.lanes[0].stale_ignored, 1);
  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(receipts, NOW_OK));
  assert.equal(projected.lanes[0].health, 'healthy');
});

test('reordered receipts reduce to the identical digest and health', () => {
  const receipts = [
    identityReceipt({ seq: 1 }),
    lifecycleReceipt('running', { seq: 2 }),
    timingReceipt({ seq: 3 }),
    outcomeReceipt('completed', { seq: 4 }),
  ];
  const reversed = [...receipts].reverse();
  const shuffled = [receipts[2], receipts[0], receipts[3], receipts[1]];
  const first = reduceDecisionReceiptsV1(reductionRequest(receipts));
  const second = reduceDecisionReceiptsV1(reductionRequest(reversed));
  const third = reduceDecisionReceiptsV1(reductionRequest(shuffled));
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, third.digest);
  assert.deepEqual(first.lanes, second.lanes);

  const healthA = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(receipts, NOW_OK));
  const healthB = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(reversed, NOW_OK));
  assert.equal(healthA.digest, healthB.digest);
  assert.equal(healthA.lanes[0].health, 'terminal');
});

test('contradictory terminal facts stay unresolved and do not invent success', () => {
  const receipts = [
    identityReceipt(),
    lifecycleReceipt('completed', { seq: 2 }),
    outcomeReceipt('completed', { seq: 4 }),
    outcomeReceipt('failed', { seq: 5 }),
  ];
  const reduced = reduceDecisionReceiptsV1(reductionRequest(receipts));
  assert.equal(reduced.lanes[0].contradiction, true);
  assert.equal(reduced.lanes[0].outcome, null);
  assert.equal(reduced.lanes[0].settled, false);
  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(receipts, NOW_OK));
  assert.equal(projected.lanes[0].health, 'unresolved');
  assert.equal(projected.lanes[0].reason, 'contradictory_terminal_facts');
});

test('hidden completed-with-error failures project failed, not terminal', () => {
  const receipts = [
    identityReceipt(),
    lifecycleReceipt('completed', { seq: 2 }),
    outcomeReceipt('completed', { seq: 4 }),
    errorReceipt('terminal_error', { seq: 6 }),
  ];
  const reduced = reduceDecisionReceiptsV1(reductionRequest(receipts));
  assert.equal(reduced.lanes[0].hidden_failure, true);
  assert.equal(reduced.lanes[0].outcome, 'completed');
  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(receipts, NOW_OK));
  assert.equal(projected.lanes[0].health, 'failed');
  assert.equal(projected.lanes[0].reason, 'hidden_failure');
});

test('unknown timing never classifies a running lane as healthy', () => {
  const runningNoTiming = [
    identityReceipt(),
    lifecycleReceipt('running', { seq: 2 }),
  ];
  const noNow = projectLaneHealthFromReceiptsV1(
    healthFromReceiptsRequest(runningLaneReceipts(), null),
  );
  assert.equal(noNow.now, null);
  assert.equal(noNow.lanes[0].health, 'unresolved');
  assert.equal(noNow.lanes[0].reason, 'timing_unknown');
  assert.equal(noNow.lanes[0].unknown.timing, true);
  assert.equal(noNow.lanes[0].branch, 'codex/lane-a');

  const missingFacts = projectLaneHealthFromReceiptsV1(
    healthFromReceiptsRequest(runningNoTiming, NOW_OK),
  );
  assert.equal(missingFacts.lanes[0].health, 'unresolved');
  assert.equal(missingFacts.lanes[0].reason, 'timing_unknown');
});

test('truncation provenance records bound, submitted, kept, and dropped', () => {
  const receipts = [];
  for (let seq = 1; seq <= MAX_RECEIPTS + 3; seq += 1) {
    receipts.push(identityReceipt({
      seq,
      cursor: `cur-${seq}`,
      data: { provider: 'grok', branch: null, head: HEAD, tree: TREE },
    }));
  }
  const reduced = reduceDecisionReceiptsV1(reductionRequest(receipts));
  assert.equal(reduced.truncated, true);
  assert.equal(reduced.truncation.code, 'receipt_bound_exceeded');
  assert.equal(reduced.truncation.bound, MAX_RECEIPTS);
  assert.equal(reduced.truncation.submitted, MAX_RECEIPTS + 3);
  assert.equal(reduced.truncation.kept, MAX_RECEIPTS);
  assert.equal(reduced.truncation.dropped, 3);
  assert.equal(reduced.lanes[0].cursor, `cur-${MAX_RECEIPTS + 3}`);

  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(receipts, NOW_OK));
  assert.equal(projected.truncated, true);
});

test('decision and retrieval overflows keep provenance instead of silent drop', () => {
  const decisions = [];
  for (let index = 0; index < MAX_DECISIONS_PER_LANE + 2; index += 1) {
    decisions.push(decisionReceipt(`code_${index}`, { seq: 20 + index }));
  }
  const decisionReduced = reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt(),
    ...decisions,
  ]));
  assert.equal(decisionReduced.truncated, true);
  assert.equal(decisionReduced.truncation.code, 'decision_bound_exceeded');
  assert.equal(decisionReduced.lanes[0].decisions.length, MAX_DECISIONS_PER_LANE);

  const retrievals = [];
  for (let index = 0; index < MAX_RETRIEVALS_PER_LANE + 1; index += 1) {
    retrievals.push(retrievalReceipt('logs', {
      seq: 30 + index,
      data: { kind: 'logs', digest: `sha256:${'c'.repeat(63)}${index}`, bytes: 8 + index },
    }));
  }
  const retrievalReduced = reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt(),
    ...retrievals,
  ]));
  assert.equal(retrievalReduced.truncated, true);
  assert.equal(retrievalReduced.truncation.code, 'retrieval_bound_exceeded');
  assert.equal(retrievalReduced.lanes[0].retrievals.length, MAX_RETRIEVALS_PER_LANE);
});

test('no-transcript model invocation: transcripts denied, default never synthesizes, source never calls a model', async () => {
  const transcriptError = errorOf(() => reduceDecisionReceiptsV1(reductionRequest([identityReceipt()], {
    transcripts: [{ role: 'assistant', content: HOSTILE_SECRET }],
  })));
  assert.equal(transcriptError.code, 'transcript_denied');
  assert.equal(transcriptError.message.includes(HOSTILE_SECRET), false);

  const messageError = errorOf(() => reduceDecisionReceiptsV1({
    schema: 'codex-co-engineer.decision-reduction-request.v1',
    run_id: 'run-lane-health',
    receipts: [identityReceipt()],
    messages: [HOSTILE_SECRET],
  }));
  assert.equal(messageError.code, 'transcript_denied');

  const promptError = errorOf(() => reduceDecisionReceiptsV1({
    schema: 'codex-co-engineer.decision-reduction-request.v1',
    run_id: 'run-lane-health',
    receipts: [identityReceipt()],
    prompt: HOSTILE_SECRET,
  }));
  assert.equal(promptError.code, 'transcript_denied');

  const implicit = reduceDecisionReceiptsV1(reductionRequest([identityReceipt()]));
  assert.equal(implicit.reduction, 'aggregate');
  assert.equal(implicit.exceptional, false);

  const exceptional = reduceDecisionReceiptsV1(reductionRequest([identityReceipt()], {
    reduction: 'model_synthesis',
  }));
  assert.equal(exceptional.exceptional, true);
  assert.equal(Object.hasOwn(exceptional, 'completion'), false);
  assert.equal(JSON.stringify(exceptional).includes(HOSTILE_SECRET), false);

  const reducerSource = await readFile(REDUCER_PATH, 'utf8');
  const healthSource = await readFile(HEALTH_PATH, 'utf8');
  for (const source of [reducerSource, healthSource]) {
    assert.doesNotMatch(source, /openai|anthropic|generateContent|chat\.completions/u);
    assert.doesNotMatch(source, /\bfetch\s*\(/u);
    assert.doesNotMatch(source, /http\.request|https\.request/u);
    assert.doesNotMatch(source, /Date\.now\s*\(/u);
  }
});

test('inline diff, logs, CI, and evidence payloads are denied', () => {
  const diffError = errorOf(() => reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt({ diff: HOSTILE_SECRET }),
  ])));
  assert.equal(diffError.code, 'inline_evidence_denied');
  assert.equal(diffError.message.includes(HOSTILE_SECRET), false);

  const logsError = errorOf(() => reduceDecisionReceiptsV1(reductionRequest([
    retrievalReceipt('logs', { data: { kind: 'logs', digest: DIGEST_A, bytes: 8, payload: HOSTILE_PATH } }),
  ])));
  assert.equal(logsError.code, 'inline_evidence_denied');
  assert.equal(logsError.message.includes(HOSTILE_PATH), false);
});

test('proxies, symbols, and accessors fail closed without traps', () => {
  const { proxy, counts } = countingProxy(reductionRequest(runningLaneReceipts()));
  const proxied = errorOf(() => reduceDecisionReceiptsV1(proxy));
  assert.equal(proxied.code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const symbolic = reductionRequest([identityReceipt()]);
  Object.defineProperty(symbolic, Symbol('leak'), { value: HOSTILE_SECRET, enumerable: true });
  const symbolError = errorOf(() => reduceDecisionReceiptsV1(symbolic));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assert.equal(symbolError.message.includes(HOSTILE_SECRET), false);

  const accessor = reductionRequest([identityReceipt()]);
  Object.defineProperty(accessor, 'run_id', {
    enumerable: true,
    get() { throw new Error(HOSTILE_SECRET); },
  });
  const accessorError = errorOf(() => reduceDecisionReceiptsV1(accessor));
  assert.equal(accessorError.code, 'accessor_property_denied');
});

test('replacement attempt resets identity so stale heads cannot linger', () => {
  const receipts = [
    identityReceipt({
      attempt: 1,
      seq: 1,
      data: { provider: 'grok', branch: 'codex/old', head: HEAD, tree: TREE },
    }),
    outcomeReceipt('completed', { attempt: 1, seq: 4 }),
    lifecycleReceipt('running', { attempt: 2, seq: 2, cursor: 'cur-2' }),
  ];
  const reduced = reduceDecisionReceiptsV1(reductionRequest(receipts));
  assert.equal(reduced.lanes[0].attempt, 2);
  assert.equal(reduced.lanes[0].branch, null);
  assert.equal(reduced.lanes[0].head, null);
  assert.equal(reduced.lanes[0].outcome, null);
  assert.equal(reduced.lanes[0].lifecycle, 'running');
});

function cloneReduction(reduction, overrides = {}) {
  return {
    schema: reduction.schema,
    version: reduction.version,
    run_id: reduction.run_id,
    reduction: reduction.reduction,
    exceptional: reduction.exceptional,
    truncated: reduction.truncated,
    truncation: reduction.truncation,
    lanes: reduction.lanes.map((lane) => ({
      ...lane,
      decisions: [...lane.decisions],
      retrievals: lane.retrievals.map((item) => ({ ...item })),
    })),
    digest: reduction.digest,
    ...overrides,
  };
}

function bindReductionDigest(payload) {
  return {
    ...payload,
    digest: reductionFramedDigestV1(DECISION_REDUCTION_DIGEST_DOMAIN, payload),
  };
}

test('forged lifecycle/outcome cannot fabricate terminal success without a matching digest', () => {
  const reduction = reduceDecisionReceiptsV1(reductionRequest(runningLaneReceipts()));
  assert.equal(validateDecisionReductionV1(reduction).digest, reduction.digest);

  const forged = cloneReduction(reduction, {
    lanes: [{
      ...reduction.lanes[0],
      lifecycle: 'completed',
      outcome: 'completed',
      settled: true,
    }],
  });
  const digestError = errorOf(() => validateDecisionReductionV1(forged));
  assert.equal(digestError.code, 'reduction_digest_mismatch');
  const projectedError = errorOf(() => projectLaneHealthV1(healthRequest(forged, NOW_OK)));
  assert.equal(projectedError.code, 'reduction_digest_mismatch');

  const unsortedDecisions = bindReductionDigest({
    schema: reduction.schema,
    version: reduction.version,
    run_id: reduction.run_id,
    reduction: reduction.reduction,
    exceptional: reduction.exceptional,
    truncated: reduction.truncated,
    truncation: reduction.truncation,
    lanes: [{
      ...reduction.lanes[0],
      decisions: ['tests_ok', 'scope_ok'],
    }],
  });
  const orderError = errorOf(() => validateDecisionReductionV1(unsortedDecisions));
  assert.equal(orderError.code, 'invalid_format');

  const twoLane = reduceDecisionReceiptsV1(reductionRequest([
    identityReceipt({ seq: 1 }),
    identityReceipt({
      assignment_id: ASSIGNMENT_B,
      seq: 1,
      data: { provider: 'dsh', branch: 'codex/lane-b', head: HEAD, tree: TREE },
    }),
  ]));
  const swapped = bindReductionDigest({
    schema: twoLane.schema,
    version: twoLane.version,
    run_id: twoLane.run_id,
    reduction: twoLane.reduction,
    exceptional: twoLane.exceptional,
    truncated: twoLane.truncated,
    truncation: twoLane.truncation,
    lanes: [twoLane.lanes[1], twoLane.lanes[0]],
  });
  const laneOrderError = errorOf(() => projectLaneHealthV1(healthRequest(swapped, NOW_OK)));
  assert.equal(laneOrderError.code, 'invalid_format');

  const truncatedMismatch = bindReductionDigest({
    schema: reduction.schema,
    version: reduction.version,
    run_id: reduction.run_id,
    reduction: reduction.reduction,
    exceptional: reduction.exceptional,
    truncated: true,
    truncation: null,
    lanes: reduction.lanes.map((lane) => ({ ...lane })),
  });
  const truncationError = errorOf(() => validateDecisionReductionV1(truncatedMismatch));
  assert.equal(truncationError.code, 'invalid_format');
});

test('conflicting same-coordinate receipts reduce identically and never overwrite by caller order', () => {
  const identity = identityReceipt({ seq: 1 });
  const completed = lifecycleReceipt('completed', { seq: 2 });
  const running = lifecycleReceipt('running', { seq: 2 });
  const completedLast = [identity, running, completed];
  const runningLast = [identity, completed, running];

  const first = reduceDecisionReceiptsV1(reductionRequest(completedLast));
  const second = reduceDecisionReceiptsV1(reductionRequest(runningLast));
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.lanes, second.lanes);
  assert.equal(first.lanes[0].contradiction, true);
  assert.equal(first.lanes[0].settled, false);

  const healthA = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(completedLast, NOW_OK));
  const healthB = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(runningLast, NOW_OK));
  assert.equal(healthA.digest, healthB.digest);
  assert.equal(healthA.lanes[0].health, 'unresolved');
  assert.equal(healthA.lanes[0].reason, 'contradictory_terminal_facts');
  assert.notEqual(healthA.lanes[0].health, 'terminal');

  const headB = 'cccccccccccccccccccccccccccccccccccccccc';
  const identityA = identityReceipt({
    seq: 1,
    data: { provider: 'grok', branch: BRANCH, head: HEAD, tree: TREE },
  });
  const identityB = identityReceipt({
    seq: 1,
    data: { provider: 'grok', branch: BRANCH, head: headB, tree: TREE },
  });
  const headsFirst = reduceDecisionReceiptsV1(reductionRequest([identityA, identityB]));
  const headsSecond = reduceDecisionReceiptsV1(reductionRequest([identityB, identityA]));
  assert.equal(headsFirst.digest, headsSecond.digest);
  assert.deepEqual(headsFirst.lanes, headsSecond.lanes);
  assert.equal(headsFirst.lanes[0].contradiction, true);
});

test('generation advance fences stale identity, cursor, branch, head, and tree', () => {
  const receipts = [
    identityReceipt({
      generation: 1,
      seq: 1,
      cursor: 'stale-cur',
      data: { provider: 'grok', branch: 'codex/old', head: HEAD, tree: TREE },
    }),
    outcomeReceipt('completed', { generation: 1, seq: 4, cursor: 'stale-cur' }),
    lifecycleReceipt('running', { generation: 2, seq: 2, cursor: null }),
    timingReceipt({ generation: 2, seq: 3, cursor: null }),
  ];
  const reduced = reduceDecisionReceiptsV1(reductionRequest(receipts));
  const lane = reduced.lanes[0];
  assert.equal(lane.generation, 2);
  assert.equal(lane.attempt, 1);
  assert.equal(lane.provider, null);
  assert.equal(lane.branch, null);
  assert.equal(lane.head, null);
  assert.equal(lane.tree, null);
  assert.equal(lane.cursor, null);
  assert.equal(lane.outcome, null);
  assert.equal(lane.lifecycle, 'running');
  assert.equal(lane.stale_ignored, 2);

  const projected = projectLaneHealthFromReceiptsV1(healthFromReceiptsRequest(receipts, NOW_OK));
  assert.equal(projected.lanes[0].branch, null);
  assert.equal(projected.lanes[0].head, null);
  assert.equal(projected.lanes[0].tree, null);
  assert.equal(projected.lanes[0].cursor, null);
  assert.equal(projected.lanes[0].unknown.branch, true);
  assert.equal(projected.lanes[0].unknown.head, true);
  assert.equal(projected.lanes[0].unknown.tree, true);
  assert.equal(projected.lanes[0].unknown.cursor, true);
  assert.notEqual(projected.lanes[0].health, 'terminal');
});
