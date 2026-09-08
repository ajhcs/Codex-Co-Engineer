// Adversarial runtime tests for the CursorLocalDriverV1 reconstruction
// (P19). Hostile descriptors, proxies, accessors, symbols, non-enumerables,
// exotic prototypes, sparse/cyclic/aliased/unknown-key inputs, provenance
// substitution, replay and fallback attempts, uncorrelated sessions,
// signature recombination, bound overflow, and lying transports must all
// fail closed inside the same content-free quarantine: no caller code runs,
// no hostile name or value escapes, and nothing is ever replayed. Everything
// runs offline against the scripted r1-cursor-local-transport fixture.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_DRIVER_VERSION,
  bindProviderDriverV1,
  buildDriverOperationRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import {
  CURSOR_LOCAL_EVIDENCE_REQUEST_SCHEMA_ID,
  CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID,
  MAX_EVIDENCE_EVENTS,
  MAX_EVIDENCE_SEGMENT_BYTES,
  MAX_LANE_EVIDENCE_BYTES,
  REDACTED_MARKER,
  createCursorLocalDriverV1,
} from '../mcp/v3/cursor-local-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { childEnvelopeDigestV1 } from '../mcp/v3/identity.mjs';
import {
  FIXTURE_QUESTION_ID,
  SECRET_AWS_KEY,
  SECRET_BEARER_TOKEN,
  SECRET_SPLIT_HEAD,
  SECRET_SPLIT_TAIL,
  buildCursorLocalFixtureV1,
  createCursorLocalTransportStub,
  cursorLocalDeclaration,
} from './fixtures/r1-cursor-local-transport.mjs';

const fixture = buildCursorLocalFixtureV1();
const INCLUDE_ALL = ['detailed_events', 'live_progress'];
const HOSTILE_MARKERS = [
  'super-secret-value-1234567890',
  SECRET_BEARER_TOKEN,
  SECRET_AWS_KEY,
  'spawn pipe broke',
  'connection reset mid-write',
  'observe died',
  '__proto__',
  'polluted',
];

function expectCode(fn, code, message) {
  if (code === undefined) {
    assert.throws(fn, (error) => error instanceof RunContractV1Error, message);
    return;
  }
  assert.throws(fn, (error) => {
    if (!(error instanceof RunContractV1Error) || error.code !== code) return false;
    const text = `${error.message}\u0000${String(error.path)}`;
    for (const marker of HOSTILE_MARKERS) {
      assert.equal(text.includes(marker), false,
        `content-free violation: ${marker} escaped into an error surface`);
    }
    return true;
  }, message);
}

function create(scenario = 'happy', options = {}) {
  const stub = createCursorLocalTransportStub(options.scenario ?? scenario);
  // Wraps are installed BEFORE driver construction: the driver detaches its
  // method references at creation, exactly like a real host would.
  for (const [method, wrap] of Object.entries(options.wrap ?? {})) {
    const original = stub.transport[method];
    stub.transport[method] = (request) => wrap(original, request);
  }
  const created = createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: stub.transport,
  });
  const bound = bindProviderDriverV1(created.driver, created.declaration);
  const request = (operation, extras = {}) =>
    buildDriverOperationRequestV1(operation, fixture.envelope, extras);
  return { bound, created, request, stub };
}

function dispatch(context) {
  context.bound.preflight(context.request('preflight'));
  return context.bound.launch(context.request('launch'));
}

function evidenceRequest() {
  return {
    schema: CURSOR_LOCAL_EVIDENCE_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
}

test('hostile option trees are rejected without running any caller code', () => {
  const transport = createCursorLocalTransportStub('happy').transport;
  const base = () => ({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport,
  });

  let getterRuns = 0;
  const accessor = base();
  delete accessor.model;
  Object.defineProperty(accessor, 'model', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return fixture.model;
    },
  });
  expectCode(() => createCursorLocalDriverV1(accessor), 'accessor_property_denied',
    'accessor options are denied');
  assert.equal(getterRuns, 0, 'option getters are never invoked');

  expectCode(() => createCursorLocalDriverV1(new Proxy(base(), {})), 'proxy_denied',
    'proxied options are denied');
  const revocable = Proxy.revocable(base(), {});
  revocable.revoke();
  expectCode(() => createCursorLocalDriverV1(revocable.proxy), 'proxy_denied',
    'revoked proxies are denied');

  class OptionsClass {}
  expectCode(() => createCursorLocalDriverV1(Object.assign(new OptionsClass(), base())),
    'invalid_type', 'exotic option prototypes fail the plain-object gate');

  expectCode(() => createCursorLocalDriverV1(Object.assign(base(), { [Symbol('hidden')]: 1 })),
    'symbol_key_denied', 'symbol keys are denied');
  const hidden = base();
  Object.defineProperty(hidden, 'run_base_sha', {
    value: fixture.base_sha, enumerable: false,
  });
  expectCode(() => createCursorLocalDriverV1(hidden), 'non_enumerable_property_denied',
    'non-enumerable keys are denied');
  expectCode(() => createCursorLocalDriverV1({ ...base(), polluted: '__proto__' }),
    'unknown_key', 'unknown option keys are denied');
  const incompleteNullProto = base();
  const nullProto = Object.assign(Object.create(null), transport);
  delete nullProto.reply;
  incompleteNullProto.transport = nullProto;
  expectCode(() => createCursorLocalDriverV1(incompleteNullProto), 'invalid_surface',
    'null-prototype transports still need the exact method set');
  const completeNullProto = createCursorLocalDriverV1({ ...base(), transport: Object.assign(Object.create(null), transport) });
  assert.equal(completeNullProto.provider, 'cursor-local',
    'a complete null-prototype transport is plain data and is accepted');
});

test('the transport surface accepts only plain concrete methods', () => {
  const build = (transportOverrides, scenario = 'happy') => createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: { ...createCursorLocalTransportStub(scenario).transport, ...transportOverrides },
  });

  expectCode(() => build({ observe: undefined }).driver, 'invalid_operation',
    'undefined methods are denied');
  expectCode(() => build({ reply: 42 }).driver, 'invalid_operation',
    'non-function methods are denied');
  const accessorTransport = {};
  for (const method of ['availability', 'cancel', 'observe', 'reply', 'send']) {
    accessorTransport[method] = () => ({});
  }
  Object.defineProperty(accessorTransport, 'spawn', {
    enumerable: true, get: () => () => ({}),
  });
  expectCode(() => createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: accessorTransport,
  }), 'invalid_operation', 'accessor methods are denied');
  expectCode(() => build({}, 'happy').driver && createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: new Proxy(createCursorLocalTransportStub('happy').transport, {}),
  }), 'proxy_denied', 'proxied transports are denied');
  const extra = createCursorLocalTransportStub('happy').transport;
  extra.respawn = () => ({});
  expectCode(() => createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: extra,
  }), 'invalid_surface', 'extra transport methods are denied');
});

test('provenance substitution and omitted-field derivation are refused on every surface', () => {
  const dshFixture = buildCursorLocalFixtureV1({
    provider: 'dsh', model: 'meta/muse-spark-1.3-contributor', run_id: 'substituted-dsh-run',
  });
  const grokFixture = buildCursorLocalFixtureV1({
    provider: 'grok', model: 'grok-4', run_id: 'substituted-grok-run',
  });
  const foreignModel = buildCursorLocalFixtureV1({
    model: 'other-model-9', run_id: 'other-model-run',
  });
  const wrongBase = buildCursorLocalFixtureV1({
    base_sha: 'a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c2',
    run_id: 'other-base-run',
  });

  const context = create('happy');
  for (const [label, foreign] of [
    ['dsh envelope', dshFixture],
    ['grok envelope', grokFixture],
    ['foreign model envelope', foreignModel],
    ['foreign base sha envelope', wrongBase],
  ]) {
    const foreignRequest = buildDriverOperationRequestV1('preflight', foreign.envelope);
    expectCode(() => context.bound.preflight(foreignRequest), undefined,
      `${label} is refused by exact binding`);
  }

  // A different child envelope digest over the same lane identity is stale.
  expectCode(() => context.created.controls.readEvidence({
    schema: CURSOR_LOCAL_EVIDENCE_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest.split('')
      .map((c, i) => (i === 3 ? (c === '0' ? '1' : '0') : c)).join(''),
  }), 'unknown_lane', 'a flipped digest never resolves to the lane');

  const truncated = {
    ...evidenceRequest(),
    envelope_text: fixture.envelope_text.slice(0, -2),
  };
  expectCode(() => context.created.controls.readEvidence(truncated),
    undefined, 'tampered envelope text is refused by the strict parse');
});

test('replay and fallback are impossible after a possible send', () => {
  const uncertain = create('ambiguous_send');
  uncertain.bound.preflight(uncertain.request('preflight'));
  assert.equal(uncertain.bound.launch(uncertain.request('launch')).disposition,
    'dispatch_uncertain');
  expectCode(() => uncertain.bound.launch(uncertain.request('launch')), 'replay_denied',
    'a possibly-sent prompt is never sent twice');
  assert.equal(uncertain.stub.state.sends, 1, 'exactly one dispatch attempt happened');

  // Foreign keys on real requests are refused before any state change.
  const dispatched = create('happy');
  dispatched.bound.preflight(dispatched.request('preflight'));
  const foreignKeys = [
    ['fallback', true, 'replay_or_fallback_denied'],
    ['retry_dispatch', 'now', 'replay_or_fallback_denied'],
    ['resend', true, 'replay_or_fallback_denied'],
    ['relaunch_attempts', 1, 'unknown_key'],
  ];
  for (const [key, value, code] of foreignKeys) {
    const tampered = {
      schema: 'codex-co-engineer.driver-launch.v1',
      version: PROVIDER_DRIVER_VERSION,
      envelope_text: fixture.envelope_text,
      child_envelope_digest: fixture.child_envelope_digest,
      [key]: value,
    };
    assert.throws(() => dispatched.bound.launch(tampered), (error) =>
      error instanceof RunContractV1Error && error.code === code,
    `foreign key ${key} must be refused with ${code}`);
  }
  assert.equal(dispatched.stub.state.spawnCalls, 0,
    'refused requests never reach the transport');
});

test('pre-spawn not_sent stays distinct from post-spawn dispatch_uncertain', () => {
  const spawnFailed = create('spawn_failure');
  spawnFailed.bound.preflight(spawnFailed.request('preflight'));
  const notSentSpawn = spawnFailed.bound.launch(spawnFailed.request('launch'));
  assert.equal(notSentSpawn.disposition, 'not_sent');
  assert.equal(notSentSpawn.detail_code, 'spawn_unavailable');
  assert.equal(typeof notSentSpawn.detail_message, 'string');
  assert.ok(!notSentSpawn.detail_message.includes(SECRET_BEARER_TOKEN),
    'the transport failure message never leaks');
  assert.equal(spawnFailed.stub.state.sends, 0, 'no dispatch follows a failed spawn');
  expectCode(() => spawnFailed.bound.reconcile(spawnFailed.request('reconcile')),
    'not_dispatched', 'reconcile cannot invent a dispatch');
  expectCode(() => spawnFailed.bound.cancel(spawnFailed.request('cancel')),
    'not_dispatched', 'cancel cannot invent a dispatch');
  // A pre-write send failure is still honestly not_sent.
  const preWrite = create('pre_write_failure');
  preWrite.bound.preflight(preWrite.request('preflight'));
  const notSentWrite = preWrite.bound.launch(preWrite.request('launch'));
  assert.equal(notSentWrite.disposition, 'not_sent');
  assert.equal(notSentWrite.detail_code, 'dispatch_not_written');
  expectCode(() => preWrite.bound.reconcile(preWrite.request('reconcile')), 'not_dispatched',
    'nothing was written, so there is nothing to reconcile');

  // Post-spawn uncertainty is distinct: no detail pair, reconcile allowed.
  const ambiguous = create('ambiguous_send');
  ambiguous.bound.preflight(ambiguous.request('preflight'));
  const uncertain = ambiguous.bound.launch(ambiguous.request('launch'));
  assert.equal(uncertain.disposition, 'dispatch_uncertain');
  assert.equal(uncertain.detail_code, undefined,
    'dispatch_uncertain carries no detail pair');
  const observed = ambiguous.bound.reconcile(ambiguous.request('reconcile'));
  assert.ok(['in_progress', 'terminal'].includes(observed.disposition),
    'reconcile may correlate the possibly-dispatched lane');
});

test('uncorrelated sessions are never bound anywhere', () => {
  const lostSession = create('session_lost');
  lostSession.bound.preflight(lostSession.request('preflight'));
  lostSession.bound.launch(lostSession.request('launch'));
  expectCode(() => lostSession.bound.reconcile(
    lostSession.request('reconcile', { include: INCLUDE_ALL }),
  ), 'uncorrelated_session', 'a corrupted binding echo is refused');
  const stillCancellable = lostSession.bound.cancel(lostSession.request('cancel'));
  assert.equal(stillCancellable.disposition, 'cancel_confirmed',
    'cancellation keeps addressing the exact original session');
  assert.equal(stillCancellable.run_id, fixture.run_id);
  expectCode(() => lostSession.created.controls.submitAttentionReply({
    schema: CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: 'sess-unrelated-77',
    question_id: 'q-any',
    answer_text: 'nope',
  }), 'no_attention_question', 'an unrelated session has no outstanding question here');

  const wrongEcho = create('wrong_binding_echo');
  wrongEcho.bound.preflight(wrongEcho.request('preflight'));
  wrongEcho.bound.launch(wrongEcho.request('launch'));
  expectCode(() => wrongEcho.bound.reconcile(wrongEcho.request('reconcile')),
    'uncorrelated_session', 'a substituted binding digest is refused');
});

test('lying transports produce content-free typed failures only', () => {
  const observeBomb = create('observe_throws');
  observeBomb.bound.preflight(observeBomb.request('preflight'));
  observeBomb.bound.launch(observeBomb.request('launch'));
  expectCode(() => observeBomb.bound.reconcile(
    observeBomb.request('reconcile', { include: INCLUDE_ALL }),
  ), 'observe_failed', 'a throwing observation fails closed without leaking stderr');

  const sendBomb = create('send_getter_bomb');
  sendBomb.bound.preflight(sendBomb.request('preflight'));
  const receipt = sendBomb.bound.launch(sendBomb.request('launch'));
  assert.equal(receipt.disposition, 'dispatch_uncertain',
    'unclassifiable send failures become honest post-spawn uncertainty');
  assert.ok(!receipt.disposition.includes('boom'));

  const getterCounter = { reads: 0 };
  const poisoned = createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: {
      availability: () => ({ available: true }),
      cancel: () => ({}),
      observe: () => ({}),
      reply: () => ({}),
      send: () => ({}),
      spawn: () => {
        const result = { session_id: 'sess-x', binding_digest: 'sha256:x' };
        Object.defineProperty(result, 'binding_digest', {
          enumerable: true,
          get() {
            getterCounter.reads += 1;
            return 'sha256:x';
          },
        });
        return result;
      },
    },
  });
  // After a successful spawn launch may never throw: a getter-bearing spawn
  // result leaves a live session with an unusable proof, which is honest
  // dispatch_uncertain — and the getter itself is still never invoked.
  const poisonedBound = bindProviderDriverV1(poisoned.driver, poisoned.declaration);
  poisonedBound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  const poisonedReceipt =
    poisonedBound.launch(buildDriverOperationRequestV1('launch', fixture.envelope));
  assert.equal(poisonedReceipt.disposition, 'dispatch_uncertain',
    'getter-bearing spawn results become post-spawn uncertainty, never a throw');
  assert.equal(poisonedReceipt.child_envelope_digest, fixture.child_envelope_digest,
    'the uncertain receipt keeps the exact child identity');
  assert.equal(getterCounter.reads, 0, 'result getters are never invoked');
});

test('promise-returning transports fail closed instead of hiding an ambiguous send', () => {
  const asyncTransport = {};
  for (const method of ['availability', 'cancel', 'observe', 'reply', 'send', 'spawn']) {
    asyncTransport[method] = async () => ({});
  }
  const created = createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: asyncTransport,
  });
  const bound = bindProviderDriverV1(created.driver, created.declaration);
  const preflightRequest = buildDriverOperationRequestV1('preflight', fixture.envelope);
  assert.equal(bound.preflight(preflightRequest).disposition, 'blocked',
    'async availability is treated as unavailable');
});

test('signature recombination across chunks and reconciliations is prevented', () => {
  const context = create('secret_chunks');
  context.bound.preflight(context.request('preflight'));
  context.bound.launch(context.request('launch'));
  context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  const drained = context.created.controls.readEvidence(evidenceRequest());
  const allText = drained.events.map((segment) => segment.text).join('\u0001');
  assert.equal(allText.includes('[REDACTED]'), true, 'signatures were redacted wholesale');
  assert.equal(allText.includes('sk-live-9988776655443322'), false,
    'the split bearer token never recombines across calls');
  assert.equal(allText.includes(SECRET_SPLIT_TAIL.replace(/^ve-/, '')), false,
    'the split token body is absent');
  assert.equal(allText.includes('AKIAIOSFODNN7EXAMPLE'), false, 'aws-shaped keys are redacted');
  assert.equal(allText.includes('super-secret-value-1234567890'), false,
    'key/value assignments are redacted');
  assert.equal(/Bearer\s+[A-Za-z0-9]/u.test(allText), false,
    'bearer signatures are redacted even in fragments');
  for (const segment of drained.events) {
    assert.ok(segment.bytes <= MAX_EVIDENCE_SEGMENT_BYTES, 'segment byte bound holds');
    assert.ok(Buffer.byteLength(segment.text, 'utf8') === segment.bytes,
      'byte accounting is UTF-8 accurate');
    assert.equal(Buffer.from(segment.text, 'utf8').toString('utf8'), segment.text,
      'segments survive a UTF-8 round trip intact');
  }
});

test('multi-byte characters survive bounding without corruption', () => {
  const emoji = '\u{1F600}'.repeat(4000); // ~16000 bytes, one segment boundary
  let getterRuns = 0;
  const stub = createCursorLocalTransportStub('happy');
  const originalObserve = stub.transport.observe;
  stub.transport.observe = (request) => {
    const result = originalObserve(request);
    if (Array.isArray(request.include) && request.include.includes('live_progress')) {
      const withoutEvents = { ...result };
      delete withoutEvents.events;
      return { ...withoutEvents, progress_text: emoji };
    }
    return result;
  };
  const created = createCursorLocalDriverV1({
    declaration: cursorLocalDeclaration(),
    model: fixture.model,
    run_base_sha: fixture.base_sha,
    transport: stub.transport,
  });
  const bound = bindProviderDriverV1(created.driver, created.declaration);
  bound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope));
  bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope, { include: INCLUDE_ALL }));
  created.controls.readEvidence(evidenceRequest());
  // Drive to terminal to flush the window, then check every segment is valid UTF-8.
  bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope));
  const drained = created.controls.readEvidence(evidenceRequest());
  assert.ok(drained.total_bytes > 0, 'flushed evidence exists');
  for (const segment of drained.events) {
    assert.equal(segment.text.includes('\uFFFD'), false,
      'truncation never introduces replacement characters');
    assert.equal(Buffer.from(segment.text, 'utf8').toString('utf8'), segment.text,
      'every bounded segment round trips as valid UTF-8');
  }
  assert.equal(getterRuns, 0);
});

test('bound overflow sets truncated and drops further input silently', () => {
  const context = create('flood');
  context.bound.preflight(context.request('preflight'));
  context.bound.launch(context.request('launch'));
  context.bound.reconcile(context.request('reconcile', { include: INCLUDE_ALL }));
  const drained = context.created.controls.readEvidence(evidenceRequest());
  assert.equal(drained.truncated, true, 'overflow is reported as truncated');
  assert.ok(drained.total_bytes <= MAX_LANE_EVIDENCE_BYTES, 'lane byte cap holds exactly');
  assert.ok(drained.events.length <= MAX_EVIDENCE_EVENTS, 'event count cap holds');
  const allText = drained.events.map((segment) => segment.text).join('');
  assert.equal(allText.includes('sk-live-abcdef0123456789'), false,
    'even flooded evidence stays redacted');
});

test('hostile control requests stay inside the content-free quarantine', () => {
  const context = create('happy');
  dispatch(context);
  const replyBase = () => ({
    schema: CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: 'sess-local-1',
    question_id: 'q-attn-1',
    answer_text: 'Approved.',
  });

  let getterRuns = 0;
  const accessorReply = replyBase();
  delete accessorReply.answer_text;
  Object.defineProperty(accessorReply, 'answer_text', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return 'Approved.';
    },
  });
  expectCode(() => context.created.controls.submitAttentionReply(accessorReply),
    'accessor_property_denied', 'accessor replies are denied');
  assert.equal(getterRuns, 0, 'reply getters are never invoked');

  expectCode(() => context.created.controls.submitAttentionReply(new Proxy(replyBase(), {})),
    'proxy_denied', 'proxied replies are denied');
  // Extra keys are rejected content-free BEFORE any value inspection, so
  // hostility is exercised through closed keys below.
  const cyclic = replyBase();
  cyclic.answer_text = cyclic;
  expectCode(() => context.created.controls.submitAttentionReply(cyclic),
    'aliased_reference_denied', 'cyclic replies are denied inside a closed key');
  const aliased = replyBase();
  const shared = { lane: 1 };
  aliased.envelope_text = shared;
  aliased.child_envelope_digest = shared;
  expectCode(() => context.created.controls.submitAttentionReply(aliased),
    'aliased_reference_denied', 'aliased replies are denied inside the same quarantine');
  let depth = { v: 0 };
  for (let index = 0; index < 40; index += 1) depth = { nested: depth };
  expectCode(() => context.created.controls.submitAttentionReply(
    { ...replyBase(), answer_text: depth },
  ), 'value_depth_exceeded', 'oversized depth is denied');
  expectCode(() => context.created.controls.readEvidence(
    new Proxy(evidenceRequest(), {}),
  ), 'proxy_denied', 'proxied evidence requests are denied');

  // Extra control-request keys are refused content-free: fixed code, fixed
  // path, fixed message — and the hostile value is never inspected at all,
  // so accessors never run and proxy traps never fire.
  let extraGetterRuns = 0;
  const getterValue = {};
  Object.defineProperty(getterValue, 'polluted', {
    enumerable: true,
    get() {
      extraGetterRuns += 1;
      return '__proto__';
    },
  });
  let trapCount = 0;
  const trappedValue = new Proxy({}, {
    get() {
      trapCount += 1;
      return undefined;
    },
    has() {
      trapCount += 1;
      return true;
    },
    ownKeys() {
      trapCount += 1;
      return [];
    },
    getOwnPropertyDescriptor() {
      trapCount += 1;
      return undefined;
    },
  });
  expectCode(() => context.created.controls.submitAttentionReply(
    { ...replyBase(), polluted: getterValue },
  ), 'unknown_key', 'extra reply keys are rejected content-free');
  assert.equal(extraGetterRuns, 0, 'extra-key values are never read');
  expectCode(() => context.created.controls.readEvidence(
    { ...evidenceRequest(), polluted: trappedValue },
  ), 'unknown_key', 'extra evidence keys are rejected content-free');
  assert.equal(trapCount, 0, 'extra-key proxies are never trapped');
  const protoNamed = replyBase();
  Object.defineProperty(protoNamed, '__proto__', {
    enumerable: true,
    value: { polluted: true },
  });
  expectCode(() => context.created.controls.submitAttentionReply(protoNamed),
    'unknown_key', 'prototype-shaped extra key names stay content-free');
});

test('terminal receipts keep exact identity under repetition and hostile echoes', () => {
  const context = create('happy');
  dispatch(context);
  const first = context.bound.reconcile(context.request('reconcile'));
  const second = context.bound.reconcile(
    context.request('reconcile', { intent: 'restart_reattach' }));
  const identityOf = (receipt) => ({
    run_id: receipt.run_id, assignment_id: receipt.assignment_id,
    lane_index: receipt.lane_index, base_sha: receipt.base_sha,
    child_envelope_digest: receipt.child_envelope_digest,
  });
  assert.deepEqual(identityOf(first), identityOf(second),
    'identity is preserved across state changes');
  const third = context.bound.reconcile(context.request('reconcile'));
  assert.deepEqual(
    { ...identityOf(second), disposition: second.disposition },
    { ...identityOf(third), disposition: third.disposition },
    'latched reconciles repeat the identical terminal receipt',
  );
  const cancelReceipt = context.bound.cancel(context.request('cancel'));
  assert.equal(cancelReceipt.disposition, 'already_terminal');
  assert.equal(cancelReceipt.run_id, fixture.run_id);
  assert.equal(cancelReceipt.child_envelope_digest, fixture.child_envelope_digest);
});

function assertExactIdentity(receipt, label) {
  assert.equal(receipt.run_id, fixture.run_id, `${label} echoes run_id`);
  assert.equal(receipt.assignment_id, fixture.assignment_id, `${label} echoes assignment_id`);
  assert.equal(receipt.lane_index, fixture.lane_index, `${label} echoes lane_index`);
  assert.equal(receipt.base_sha, fixture.base_sha, `${label} echoes base_sha`);
  assert.equal(receipt.child_envelope_digest, fixture.child_envelope_digest,
    `${label} echoes child_envelope_digest`);
}

test('after spawn success launch never throws: unusable spawn proofs stay dispatch_uncertain', () => {
  // Row 1 of the bound-driver rejection: a transport that returns from
  // spawn but then lies, omits, adds keys, or hides accessors leaves a live
  // session with an unusable proof. Launch must never throw past spawn; it
  // reports dispatch_uncertain exactly once and can never respawn.
  const spawnVariants = [
    ['missing session id', () => ({}), 0],
    ['extra key beside the spawn proof',
      () => ({ binding_digest: `sha256:${'7'.repeat(64)}`, polluted: { x: 1 }, session_id: 'sess-x' }), 0],
    ['garbage session id',
      () => ({ binding_digest: `sha256:${'7'.repeat(64)}`, session_id: '../etc/passwd' }), 0],
    ['wrong binding echo',
      () => ({ binding_digest: `sha256:${'0'.repeat(64)}`, session_id: 'sess-x' }), 0],
    ['accessor session id', () => {
      const result = { binding_digest: `sha256:${'7'.repeat(64)}` };
      Object.defineProperty(result, 'session_id', {
        enumerable: true,
        get() {
          getterReads.spawn += 1;
          return 'sess-x';
        },
      });
      return result;
    }, 0],
  ];
  const getterReads = { spawn: 0 };
  for (const [label, mutate] of spawnVariants) {
    const context = create('happy', { wrap: { spawn: (original, request) => mutate(original(request)) } });
    context.bound.preflight(context.request('preflight'));
    let receipt;
    try {
      receipt = context.bound.launch(context.request('launch'));
    } catch (error) {
      assert.fail(`${label}: launch threw after a successful spawn: ${error}`);
    }
    assert.equal(receipt.disposition, 'dispatch_uncertain', `${label}: honest uncertainty`);
    assertExactIdentity(receipt, `${label}: uncertain receipt`);
    assert.equal(JSON.stringify(receipt).includes('polluted'), false,
      `${label}: no hostile name in the receipt`);
    assert.equal(context.stub.state.spawnCalls, 1, `${label}: at most one spawn ever`);
    expectCode(() => context.bound.launch(context.request('launch')), 'replay_denied',
      `${label}: a possibly-spawned lane is never respawned or fallen back`);
    assert.equal(context.stub.state.spawnCalls, 1,
      `${label}: relaunch attempts spawn nothing`);
    assert.equal(context.stub.state.sends, 0, `${label}: nothing is dispatched on a dead proof`);
    expectCode(() => context.bound.reconcile(context.request('reconcile')), 'not_dispatched',
      `${label}: no prompt was attempted, so there is nothing to reconcile`);
    expectCode(() => context.bound.cancel(context.request('cancel')), 'not_dispatched',
      `${label}: no prompt was attempted, so there is nothing to cancel`);
  }
  assert.equal(getterReads.spawn, 0, 'spawn-result getters are never invoked');
});

test('a live session without acknowledgement is dispatch_uncertain, never thrown and never resent', () => {
  // Row 1 continuation: the send itself ran against a live session but its
  // result cannot prove delivery — missing/false acknowledgement, lying
  // echoes, extra keys, and accessor bombs all stay honest uncertainty.
  const sendVariants = [
    ['acknowledgement missing', (result) => {
      const { acknowledged, ...rest } = result;
      void acknowledged;
      return rest;
    }],
    ['acknowledgement false', (result) => ({ ...result, acknowledged: false })],
    ['extra key beside acknowledgement', (result) => ({ ...result, polluted: { deep: '__proto__' } })],
    ['session echo substituted',
      (result) => ({ ...result, session_id: `${result.session_id}-reborn` })],
    ['binding echo corrupted', (result) => ({ ...result, binding_digest: `sha256:${'f'.repeat(64)}` })],
    ['accessor acknowledgement', (result) => {
      const forged = { ...result };
      delete forged.acknowledged;
      Object.defineProperty(forged, 'acknowledged', {
        enumerable: true,
        get() {
          getterReads.send += 1;
          return true;
        },
      });
      return forged;
    }],
  ];
  const getterReads = { send: 0 };
  for (const [label, mutate] of sendVariants) {
    const context = create('happy', { wrap: { send: (original, request) => mutate(original(request)) } });
    context.bound.preflight(context.request('preflight'));
    let receipt;
    try {
      receipt = context.bound.launch(context.request('launch'));
    } catch (error) {
      assert.fail(`${label}: launch threw after a successful spawn: ${error}`);
    }
    assert.equal(receipt.disposition, 'dispatch_uncertain', `${label}: honest uncertainty`);
    assertExactIdentity(receipt, `${label}: uncertain receipt`);
    assert.equal(receipt.detail_code, undefined,
      `${label}: uncertainty carries no detail pair`);
    assert.equal(context.stub.state.spawnCalls, 1, `${label}: exactly one spawn`);
    assert.equal(context.stub.state.sends, 1, `${label}: exactly one dispatch attempt`);
    expectCode(() => context.bound.launch(context.request('launch')), 'replay_denied',
      `${label}: an unacknowledged live session is never resent`);
    assert.equal(context.stub.state.sends, 1, `${label}: relaunch attempts send nothing`);
    assert.equal(context.stub.state.spawnCalls, 1, `${label}: relaunch spawns nothing`);
  }
  assert.equal(getterReads.send, 0, 'send-result getters are never invoked');
});

test('pre_write_failure is not_sent only under a confirmed teardown, else dispatch_uncertain', () => {
  // Row 2 of the bound-driver rejection: not_sent requires proof that no
  // session survives. The confirmed-teardown path keeps the honest closed
  // detail pair; every unproven teardown stays dispatch_uncertain.
  const confirmed = create('pre_write_failure');
  confirmed.bound.preflight(confirmed.request('preflight'));
  const notSent = confirmed.bound.launch(confirmed.request('launch'));
  assert.equal(notSent.disposition, 'not_sent');
  assert.equal(notSent.detail_code, 'dispatch_not_written');
  assert.equal(typeof notSent.detail_message, 'string');
  assert.ok(!notSent.detail_message.includes('nothing was written'),
    'transport failure text never leaks into the closed detail pair');
  assertExactIdentity(notSent, 'confirmed-teardown not_sent');
  assert.equal(confirmed.stub.state.spawnCalls, 1, 'exactly one spawn');
  assert.equal(confirmed.stub.state.sends, 1, 'exactly one dispatch attempt');
  assert.equal(confirmed.stub.state.cancelCalls, 1, 'teardown was proven via one cancel');
  expectCode(() => confirmed.bound.launch(confirmed.request('launch')), 'replay_denied',
    'not_sent lanes are never relaunched');
  assert.equal(confirmed.stub.state.spawnCalls, 1);
  assert.equal(confirmed.stub.state.sends, 1);

  const teardownVariants = [
    ['cancelling throws', () => {
      throw new Error(`teardown exploded ${SECRET_BEARER_TOKEN}`);
    }],
    ['cancellation only requested', () => ({
      binding_digest: `sha256:${'7'.repeat(64)}`,
      outcome: 'requested',
      session_id: 'sess-local-1',
    })],
    ['teardown echo corrupted', () => ({
      binding_digest: `sha256:${'0'.repeat(64)}`,
      outcome: 'confirmed',
      session_id: 'sess-local-1',
    })],
    ['teardown carries an extra key', () => ({
      binding_digest: `sha256:${'7'.repeat(64)}`,
      outcome: 'confirmed',
      polluted: true,
      session_id: 'sess-local-1',
    })],
    ['teardown result malformed', () => 'confirmed'],
  ];
  for (const [label, cancelBehavior] of teardownVariants) {
    let teardownAttempts = 0;
    const context = create('pre_write_failure', { wrap: { cancel: () => {
      teardownAttempts += 1;
      return cancelBehavior();
    } } });
    context.bound.preflight(context.request('preflight'));
    let receipt;
    try {
      receipt = context.bound.launch(context.request('launch'));
    } catch (error) {
      assert.fail(`${label}: launch threw after a successful spawn: ${error}`);
    }
    assert.equal(receipt.disposition, 'dispatch_uncertain',
      `${label}: unproven teardown stays uncertain`);
    assert.equal(receipt.detail_code, undefined, `${label}: no detail pair on uncertainty`);
    assertExactIdentity(receipt, `${label}: uncertain receipt`);
    assert.equal(teardownAttempts, 1, `${label}: teardown was attempted once`);
    assert.equal(context.stub.state.spawnCalls, 1, `${label}: exactly one spawn`);
    assert.equal(context.stub.state.sends, 1, `${label}: exactly one dispatch attempt`);
    expectCode(() => context.bound.launch(context.request('launch')), 'replay_denied',
      `${label}: a possibly-sent prompt is never sent twice`);
    assert.equal(context.stub.state.sends, 1, `${label}: no redispatch after relaunch attempt`);
  }
});

test('every transport result obeys its closed key vocabulary content-free', () => {
  const extraKey = { polluted: { leaked: '__proto__' } };

  const withExtra = (result) => ({ ...result, ...extraKey });

  const availability = create('happy', { wrap: { availability: (original) => withExtra(original()) } });
  expectCode(() => availability.bound.preflight(availability.request('preflight')),
    'invalid_transport_result', 'availability results reject extra keys');
  assert.equal(availability.stub.state.spawnCalls, 0,
    'refused availability results never spawn');

  const observe = create('happy', { wrap: { observe: (original, request) => withExtra(original(request)) } });
  observe.bound.preflight(observe.request('preflight'));
  observe.bound.launch(observe.request('launch'));
  expectCode(() => observe.bound.reconcile(
    observe.request('reconcile', { include: INCLUDE_ALL }),
  ), 'invalid_transport_result', 'observe results reject extra keys');

  const cancellation = create('happy', { wrap: { cancel: (original, request) => withExtra(original(request)) } });
  cancellation.bound.preflight(cancellation.request('preflight'));
  cancellation.bound.launch(cancellation.request('launch'));
  expectCode(() => cancellation.bound.cancel(cancellation.request('cancel')),
    'invalid_transport_result', 'cancel results reject extra keys');
  assert.equal(cancellation.stub.state.cancelCalls, 1,
    'the refused cancellation still reached the transport exactly once');

  const reply = create('attention', { wrap: { reply: (original, request) => withExtra(original(request)) } });
  dispatch(reply);
  reply.bound.reconcile(reply.request('reconcile', { include: INCLUDE_ALL }));
  expectCode(() => reply.created.controls.submitAttentionReply({
    schema: CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: 'sess-local-1',
    question_id: FIXTURE_QUESTION_ID,
    answer_text: 'Approved.',
  }), 'invalid_transport_result', 'reply results reject extra keys');
  assert.equal(reply.stub.state.replies, 1, 'the refused reply consumed the one attempt');
  expectCode(() => reply.created.controls.submitAttentionReply({
    schema: CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: 'sess-local-1',
    question_id: FIXTURE_QUESTION_ID,
    answer_text: 'Approved again.',
  }), 'reply_already_attempted', 'replies stay attempt-once across refusals');
});

test('sha256 and bare 64-hex signatures redact across chunks and reconciliations while receipts keep identity', () => {
  const sha256Secret = `sha256:${'d4f10e2a'.repeat(8)}`;
  const bareSecret = 'deadbeef'.repeat(8);
  const upperSecret = `SHA256:${'ABCDEF01'.repeat(8)}`;
  // Every hostile signature is split into two ADJACENT stream pieces; the
  // sha256 pair additionally straddles a reconciliation boundary, which the
  // persistent per-lane window must survive.
  const shaHead = sha256Secret.slice(0, 35);
  const shaTail = sha256Secret.slice(35);
  const bareHead = bareSecret.slice(0, 32);
  const bareTail = bareSecret.slice(32);
  let observes = 0;
  const scriptedObserve = (request) => {
    observes += 1;
    if (observes === 1) {
      return {
        binding_digest: request.binding_digest,
        events: [`${shaTail} rotated`, `sum ${bareHead}`],
        progress_text: `hashing ${shaHead}`,
        session_id: request.session_id,
        status: 'running',
      };
    }
    if (observes === 2) {
      return {
        binding_digest: request.binding_digest,
        events: ['x'.repeat(400), `upper ${upperSecret} end`],
        progress_text: `${bareTail} sealed`,
        session_id: request.session_id,
        status: 'running',
      };
    }
    return {
      binding_digest: request.binding_digest,
      session_id: request.session_id,
      status: 'completed',
    };
  };
  const context = create('happy', { wrap: { observe: (original, request) => {
    void original;
    return scriptedObserve(request);
  } } });

  context.bound.preflight(context.request('preflight'));
  const launched = context.bound.launch(context.request('launch'));
  assert.equal(launched.disposition, 'dispatched');
  const first = context.bound.reconcile(
    context.request('reconcile', { include: INCLUDE_ALL }));
  assert.equal(first.disposition, 'in_progress');
  const second = context.bound.reconcile(
    context.request('reconcile', { include: INCLUDE_ALL }));
  assert.equal(second.disposition, 'in_progress');

  // Redaction happens at emission, not only at the terminal flush.
  const midStream = context.created.controls.readEvidence(evidenceRequest());
  const midText = midStream.events.map((segment) => segment.text).join('\u0001');
  assert.ok(midText.includes(REDACTED_MARKER),
    'signatures crossing chunks were redacted before the latch');
  assert.equal(/[0-9a-f]{64}/iu.test(midText), false,
    'no 64-hex signature survives in mid-stream evidence');

  const terminal = context.bound.reconcile(
    context.request('reconcile', { intent: 'restart_reattach' }));
  assert.equal(terminal.disposition, 'terminal');
  const receipts = [launched, first, second, terminal];
  for (const receipt of receipts) {
    // P17 identity receipts stay byte-exact even when the same digest
    // shapes arrive inside provider evidence.
    assertExactIdentity(receipt, 'hostile-digest receipt');
  }

  const drained = context.created.controls.readEvidence(evidenceRequest());
  assert.equal(drained.truncated, false, 'nothing here needs truncation');
  const allText = drained.events.map((segment) => segment.text).join('\u0001');
  assert.ok(allText.includes(REDACTED_MARKER), 'digest signatures were redacted wholesale');
  assert.equal(/[0-9a-f]{64}/iu.test(allText), false, 'no 64-hex signature survives anywhere');
  assert.equal(allText.includes('d4f10e2a'), false, 'the sha256 body never recombines');
  assert.equal(allText.includes('deadbeef'), false,
    'the bare digest never recombines across reconciliations');
  assert.equal(allText.includes('ABCDEF01'), false, 'uppercase digests never survive');
  assert.equal(allText.includes('sha256:'), false, 'no digest prefix survives');
  for (const segment of drained.events) {
    assert.ok(segment.bytes <= MAX_EVIDENCE_SEGMENT_BYTES, 'segment byte bound holds');
    assert.equal(Buffer.byteLength(segment.text, 'utf8'), segment.bytes,
      'byte accounting stays UTF-8 exact');
  }
});
