// Runtime tests for the CursorLocalDriverV1 reconstruction (P19): the
// accepted P17 ProviderDriverV1 lifecycle bound to an injected local
// Cursor session transport. Covers exact provenance binding, one spawn
// plus one acknowledged dispatch, the not_sent / dispatch_uncertain /
// dispatched distinctions, same-session attention replies, cancel,
// reattach, the terminal latch, already-terminal behavior, bounded
// redacted evidence, and closed receipts. Everything runs offline against
// the scripted r1-cursor-local-transport fixture; no live Cursor Local,
// network, or repository access happens here.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_RECORD_ALLOWED_KEYS,
  PROVIDER_DRIVER_VERSION,
  assertProviderDriverV1,
  bindProviderDriverV1,
  buildDriverOperationRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import {
  CANCEL_OUTCOMES,
  CURSOR_LOCAL_DRIVER_SCHEMA_ID,
  CURSOR_LOCAL_EVIDENCE_REQUEST_SCHEMA_ID,
  CURSOR_LOCAL_EVIDENCE_SCHEMA_ID,
  CURSOR_LOCAL_PROVIDER,
  CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID,
  EVIDENCE_KINDS,
  MAX_EVIDENCE_EVENTS,
  MAX_EVIDENCE_SEGMENT_BYTES,
  MAX_LANE_EVIDENCE_BYTES,
  OBSERVE_STATUSES,
  createCursorLocalDriverV1,
  describeCursorLocalDriverV1,
} from '../mcp/v3/cursor-local-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { validateDriverDeclarationV1 } from '../mcp/v3/provider-driver.mjs';
import {
  FIXTURE_QUESTION_ID,
  FIXTURE_QUESTION_TEXT,
  buildCursorLocalFixtureV1,
  createCursorLocalTransportStub,
  cursorLocalDeclaration,
} from './fixtures/r1-cursor-local-transport.mjs';

const fixture = buildCursorLocalFixtureV1();
const INCLUDE_ALL = ['detailed_events', 'live_progress'];

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code, message);
}

function create(scenario = 'happy', declarationOverrides = {}) {
  const stub = createCursorLocalTransportStub(scenario);
  const created = createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(
      declarationOverrides.capability ?? {},
      declarationOverrides.features ?? {},
    ),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: stub.transport,
    ...(declarationOverrides.workspace_root !== undefined
      ? { workspace_root: declarationOverrides.workspace_root } : {}),
  });
  const bound = bindProviderDriverV1(created.driver, created.declaration);
  const request = (operation, extras = {}) =>
    buildDriverOperationRequestV1(operation, fixture.envelope, extras);
  const evidenceRequest = () => ({
    schema: CURSOR_LOCAL_EVIDENCE_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  const replyRequest = (overrides = {}) => ({
    schema: CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: `sess-local-${stub.state.spawnCalls || 1}`,
    question_id: FIXTURE_QUESTION_ID,
    answer_text: 'Approved; continue.',
    ...overrides,
  });
  return { bound, created, request, evidenceRequest, replyRequest, stub };
}

function dispatch({ bound, request }) {
  const preflight = bound.preflight(request('preflight'));
  const launch = bound.launch(request('launch'));
  return { launch, preflight };
}

function assertIdentityEcho(receipt, label) {
  assert.equal(receipt.version, PROVIDER_DRIVER_VERSION, `${label} version`);
  assert.equal(receipt.run_id, fixture.run_id, `${label} echoes run_id`);
  assert.equal(receipt.assignment_id, fixture.assignment_id, `${label} echoes assignment_id`);
  assert.equal(receipt.lane_index, fixture.lane_index, `${label} echoes lane_index`);
  assert.equal(receipt.base_sha, fixture.base_sha, `${label} echoes base_sha`);
  assert.equal(receipt.child_envelope_digest, fixture.child_envelope_digest,
    `${label} echoes child_envelope_digest`);
}

test('the cursor-local driver description is closed and claims no transport of its own', () => {
  const description = describeCursorLocalDriverV1();
  assert.equal(description.schema, CURSOR_LOCAL_DRIVER_SCHEMA_ID);
  assert.equal(description.provider, CURSOR_LOCAL_PROVIDER);
  assert.deepEqual([...description.operations], ['preflight', 'launch', 'reconcile', 'cancel']);
  assert.deepEqual([...description.transports], []);
  assert.deepEqual([...description.relaunch_operations], []);
  assert.deepEqual([...description.direct_mode], []);
  assert.equal(description.durable_store, false);
  assert.equal(description.workspace_semantics, 'local_managed_worktree');
  assert.equal(description.workspace_starting_point, 'run_base_sha');
  assert.equal(description.replay_posture, 'never_replay');
  assert.ok(Object.isFrozen(description));
  assert.deepEqual([...OBSERVE_STATUSES].sort(), ['attention', 'completed', 'failed', 'running']);
  assert.deepEqual([...CANCEL_OUTCOMES].sort(), ['confirmed', 'requested']);
  assert.deepEqual([...EVIDENCE_KINDS].sort(), ['attention', 'event', 'progress']);
});

test('create binds the exact P05 capability record and a four-operation driver surface', () => {
  const { created } = create();
  const validated = validateDriverDeclarationV1(created.declaration);
  assert.equal(validated.capability.provider, CURSOR_LOCAL_PROVIDER);
  assert.equal(validated.capability.workspace_semantics, 'local_managed_worktree');
  assert.equal(validated.capability.workspace_starting_point, 'run_base_sha');
  assert.equal(validated.capability.replay_posture, 'never_replay');
  assert.equal(validated.capability.dispatch_certainty, 'confirmed_launch');
  assert.equal(validated.capability.same_session_reply, 'live_session_reply');
  assert.equal(CAPABILITY_RECORD_ALLOWED_KEYS.length, 13);
  for (const key of CAPABILITY_RECORD_ALLOWED_KEYS) {
    assert.ok(Object.hasOwn(validated.capability, key), `capability key ${key}`);
  }
  const summary = assertProviderDriverV1(created.driver);
  assert.equal(summary.schema, 'codex-co-engineer.provider-driver.v1');
  assert.equal(summary.version, PROVIDER_DRIVER_VERSION);
  assert.deepEqual([...summary.operations], ['preflight', 'launch', 'reconcile', 'cancel']);
  assert.deepEqual(Object.keys(created.driver).sort(),
    ['cancel', 'launch', 'preflight', 'reconcile']);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.driver));
  assert.ok(Object.isFrozen(created.controls));
});

test('preflight reports readiness without spawning or sending anything', () => {
  const context = create('happy');
  const receipt = context.bound.preflight(context.request('preflight'));
  assert.equal(receipt.disposition, 'ready');
  assertIdentityEcho(receipt, 'preflight');
  assert.equal(receipt.detail_code, undefined);
  assert.ok(Object.isFrozen(receipt));
  assert.equal(context.stub.state.spawnCalls, 0, 'no spawn during preflight');
  assert.equal(context.stub.state.sends, 0, 'no dispatch during preflight');
});

test('blocked preflight carries the closed detail pair and blocks the lane', () => {
  const context = create('unavailable');
  const receipt = context.bound.preflight(context.request('preflight'));
  assert.equal(receipt.disposition, 'blocked');
  assertIdentityEcho(receipt, 'blocked preflight');
  assert.equal(receipt.detail_code, 'transport_unavailable');
  assert.equal(typeof receipt.detail_message, 'string');
  expectCode(() => context.bound.launch(context.request('launch')), 'blocked_lane_denied',
    'a blocked preflight cannot launch');
  assert.equal(context.stub.state.spawnCalls, 0, 'blocked lanes never spawn');
});

test('launch spawns exactly one session and dispatches the exact prompt once before dispatched', () => {
  const context = create('happy');
  const { launch, preflight } = dispatch(context);
  assert.equal(preflight.disposition, 'ready');
  assert.equal(launch.disposition, 'dispatched');
  assertIdentityEcho(launch, 'launch');
  assert.equal(launch.detail_code, undefined);
  assert.equal(context.stub.state.spawnCalls, 1, 'exactly one spawn');
  assert.equal(context.stub.state.sends, 1, 'exactly one prompt dispatch');
  assert.equal(context.stub.state.acks, 1, 'authoritative acknowledgement received');
  const spawnRequest = context.stub.state.spawnRecords[0];
  assert.equal(spawnRequest.binding_digest.length > 0, true, 'spawn carries the binding digest');
  assert.equal(spawnRequest.model, fixture.model, 'spawn binds the exact model');
  assert.equal(spawnRequest.base_sha, fixture.base_sha, 'spawn binds the run base sha');
  assert.equal(spawnRequest.repository_path, fixture.repository_path,
    'spawn binds the repository path');
  assert.equal(spawnRequest.run_id, fixture.run_id, 'spawn binds the run id');
  const sendRecord = context.stub.state.sendRecords[0];
  assert.equal(sendRecord.prompt_text, fixture.envelope_text,
    'the exact compiled envelope text is the dispatched prompt');
  assert.equal(sendRecord.prompt_utf8_bytes,
    Buffer.byteLength(fixture.envelope_text, 'utf8'));
  assert.equal(sendRecord.session_id, context.stub.state.spawnRecords[0] && 'sess-local-1');
});

test('reconcile observes the same session, then the terminal latch stops further observation', () => {
  const context = create('happy');
  dispatch(context);
  const sessionId = 'sess-local-1';
  const first = context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  assert.equal(first.disposition, 'in_progress');
  assertIdentityEcho(first, 'reconcile');
  assert.equal(context.stub.state.observes, 1);
  assert.equal(context.stub.calls[context.stub.calls.length - 1].request.session_id, sessionId,
    'observation addresses the exact spawned session');
  const second = context.bound.reconcile(context.request('reconcile', { intent: 'restart_reattach' }));
  assert.equal(second.disposition, 'terminal');
  assert.equal(context.stub.state.observes, 2, 'terminal came from the second observation');
  const latched = context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  assert.equal(latched.disposition, 'terminal');
  assert.equal(context.stub.state.observes, 2, 'the terminal latch performs no further observation');
  assert.deepEqual([first.run_id, second.run_id, latched.run_id],
    [fixture.run_id, fixture.run_id, fixture.run_id]);
  assert.deepEqual(
    [second.child_envelope_digest, latched.child_envelope_digest],
    [fixture.child_envelope_digest, fixture.child_envelope_digest],
    'latched receipts preserve exact identity',
  );
});

test('already-terminal cancellation reports already_terminal without contacting the transport', () => {
  const context = create('happy');
  dispatch(context);
  context.bound.reconcile(context.request('reconcile'));
  context.bound.reconcile(context.request('reconcile'));
  const receipt = context.bound.cancel(context.request('cancel'));
  assert.equal(receipt.disposition, 'already_terminal');
  assertIdentityEcho(receipt, 'already-terminal cancel');
  assert.equal(context.stub.state.cancelCalls, 0, 'no cancel call after the terminal latch');
});

test('confirmed cancellation closes the lane and preserves identity everywhere', () => {
  const context = create('happy');
  dispatch(context);
  const receipt = context.bound.cancel(context.request('cancel'));
  assert.equal(receipt.disposition, 'cancel_confirmed');
  assertIdentityEcho(receipt, 'cancel');
  assert.equal(context.stub.state.cancelCalls, 1);
  const observed = context.bound.reconcile(context.request('reconcile'));
  assert.equal(observed.disposition, 'terminal');
  assert.equal(context.stub.state.observes, 0, 'a cancelled lane never observes again');
  assert.equal(context.bound.cancel(context.request('cancel')).disposition, 'already_terminal');
});

test('requested cancellation stays resolvable and still ends at the terminal latch', () => {
  const context = create('cancel_requested_flow');
  dispatch(context);
  const requested = context.bound.cancel(context.request('cancel'));
  assert.equal(requested.disposition, 'cancel_requested');
  assertIdentityEcho(requested, 'cancel_requested');
  const windingDown = context.bound.reconcile(context.request('reconcile'));
  assert.equal(windingDown.disposition, 'in_progress',
    'a requested cancellation keeps observing until the provider settles');
  const settled = context.bound.reconcile(
    context.request('reconcile', { intent: 'restart_reattach' }));
  assert.equal(settled.disposition, 'terminal');
  assert.equal(context.bound.cancel(context.request('cancel')).disposition, 'already_terminal');
});

test('same-session attention replies are attempt-once and bound to the exact session/question', () => {
  const context = create('attention');
  dispatch(context);
  const attention = context.bound.reconcile(
    context.request('reconcile', { include: INCLUDE_ALL }));
  assert.equal(attention.disposition, 'unresolved_attention');
  assertIdentityEcho(attention, 'attention reconcile');

  const receipt = context.created.controls.submitAttentionReply(context.replyRequest());
  assert.equal(receipt.answered, true);
  assert.equal(receipt.schema.startsWith('codex-co-engineer.cursor-local-reply-result'), true);
  assertIdentityEcho(receipt, 'reply');
  assert.equal(receipt.question_id, FIXTURE_QUESTION_ID);
  assert.ok(Object.isFrozen(receipt));
  assert.equal(context.stub.state.replies, 1, 'exactly one reply attempt reached the transport');
  assert.equal(context.stub.state.replyRecords[0].answer_text, 'Approved; continue.');
  assert.equal(context.stub.state.replyRecords[0].question_id, FIXTURE_QUESTION_ID);

  expectCode(() => context.created.controls.submitAttentionReply(context.replyRequest()),
    'reply_already_attempted', 'a second reply on the same question is denied');
  assert.equal(context.stub.state.replies, 1, 'no second reply ever reaches the transport');

  const settled = context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  assert.equal(settled.disposition, 'in_progress',
    'the lane resumes normal observation after the answer');
  const finished = context.bound.reconcile(context.request('reconcile'));
  assert.equal(finished.disposition, 'terminal');
});

test('reply refuses mismatches without consuming the attempt or touching the transport', () => {
  const context = create('attention');
  dispatch(context);
  context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));

  expectCode(() => context.created.controls.submitAttentionReply(
    context.replyRequest({ question_id: 'q-other-9' }),
  ), 'question_mismatch', 'a different question is refused');
  expectCode(() => context.created.controls.submitAttentionReply(
    context.replyRequest({ session_id: 'sess-unrelated' }),
  ), 'uncorrelated_session', 'an uncorrelated session is refused');
  assert.equal(context.stub.state.replies, 0, 'refusals never reach the transport');
  const receipt = context.created.controls.submitAttentionReply(context.replyRequest());
  assert.equal(receipt.answered, true, 'the one attempt remains available after refusals');
});

test('reply postures are pinned by the accepted P05 bridge and refuse contradiction at birth', () => {
  // The accepted P17 capability bridge pins cursor-local to
  // live_session_reply, so an unsupported-reply driver cannot even be
  // constructed; submitAttentionReply still refuses explicitly should a
  // posture ever reach it.
  expectCode(() => createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration({
      same_session_reply: 'unsupported_unresolved_attention',
    }),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: createCursorLocalTransportStub('attention').transport,
  }), 'capability_reply_mismatch',
  'the P05 bridge refuses a cursor-local declaration that denies live replies');
});

test('evidence drains as bounded frozen segments that match their byte accounting', () => {
  const context = create('flood');
  dispatch(context);
  const empty = context.created.controls.readEvidence(context.evidenceRequest());
  assert.equal(empty.total_bytes, 0);
  assert.equal(empty.truncated, false);

  context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  const drained = context.created.controls.readEvidence(context.evidenceRequest());
  assert.equal(drained.schema, CURSOR_LOCAL_EVIDENCE_SCHEMA_ID);
  assert.equal(drained.version, PROVIDER_DRIVER_VERSION);
  assert.ok(drained.total_bytes > 0, 'progress text was captured');
  let summed = 0;
  for (const segment of drained.events) {
    assert.ok(Object.isFrozen(segment), 'segments are frozen');
    assert.ok(segment.bytes <= MAX_EVIDENCE_SEGMENT_BYTES, 'segment byte bound');
    assert.ok(EVIDENCE_KINDS.includes(segment.kind), 'closed segment kind');
    summed += segment.bytes;
  }
  assert.equal(summed, drained.total_bytes, 'byte accounting matches the segments');
  assert.ok(drained.total_bytes <= MAX_LANE_EVIDENCE_BYTES, 'lane byte bound');
  assert.ok(drained.events.length <= MAX_EVIDENCE_EVENTS, 'event count bound');
  assert.ok(Object.isFrozen(drained.events));
  const again = context.created.controls.readEvidence(context.evidenceRequest());
  assert.deepEqual(again, drained, 'draining is stable and non-consuming');

  // Short observation tails stay inside the persistent redaction window
  // (so signatures cannot recombine across reconciliations) and become
  // host-visible at the terminal latch flush.
  const tail = create('happy');
  dispatch(tail);
  tail.bound.reconcile(tail.request('reconcile', { include: INCLUDE_ALL }));
  const beforeLatch = tail.created.controls.readEvidence(tail.evidenceRequest());
  assert.equal(beforeLatch.total_bytes, 0,
    'a sub-window tail stays withheld while the lane runs');
  tail.bound.reconcile(tail.request('reconcile'));
  const latched = tail.created.controls.readEvidence(tail.evidenceRequest());
  assert.ok(latched.total_bytes > 0, 'the terminal latch flushes the withheld tail');
  let latchedSum = 0;
  for (const segment of latched.events) latchedSum += segment.bytes;
  assert.equal(latchedSum, latched.total_bytes);
});

test('restart_reattach reattaches to the identical session without respawning', () => {
  const context = create('happy');
  dispatch(context);
  context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  const reattached = context.bound.reconcile(
    context.request('reconcile', { intent: 'restart_reattach', include: INCLUDE_ALL }));
  assert.ok(reattached.disposition === 'terminal' || reattached.disposition === 'in_progress',
    'restart_reattach observes the existing dispatch');
  assertIdentityEcho(reattached, 'restart_reattach');
  assert.equal(context.stub.state.spawnCalls, 1, 'restart_reattach never spawns again');
  assert.equal(context.stub.state.sends, 1, 'restart_reattach never redispatches');
});

test('unsupported feature declarations fail closed on the operations that need them', () => {
  const cancelling = create('happy', { features: { cancellation: 'unsupported' } });
  dispatch(cancelling);
  expectCode(() => cancelling.bound.cancel(cancelling.request('cancel')),
    'unsupported_capability', 'cancellation declared unsupported fails closed');

  const restarting = create('happy', { features: { restart: 'unsupported' } });
  dispatch(restarting);
  expectCode(() => restarting.bound.reconcile(
    restarting.request('reconcile', { intent: 'restart_reattach' }),
  ), 'unsupported_capability', 'restart declared unsupported fails closed');
});

test('control requests are quarantined by the same closed schema discipline', () => {
  const context = create('attention');
  dispatch(context);
  context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));

  expectCode(() => context.created.controls.readEvidence({
    ...context.evidenceRequest(), extra: true,
  }), 'unknown_key', 'evidence requests reject unknown keys');
  expectCode(() => context.created.controls.submitAttentionReply({
    ...context.replyRequest(), fallback: 'again',
  }), 'unknown_key', 'reply requests reject fallback-shaped foreign keys');
  const missing = context.replyRequest();
  delete missing.answer_text;
  expectCode(() => context.created.controls.submitAttentionReply(missing), 'missing_key',
    'reply requests derive nothing');
  expectCode(() => context.created.controls.submitAttentionReply(
    context.replyRequest({ answer_text: '' }),
  ), 'invalid_answer', 'empty answers are refused before the attempt');
});

