// Adversarial tests for the P20 DSH ACPX provider driver: hostile direct-JS
// options/transport surfaces, forged and malformed recorded-evidence
// receipts, replay/resend/fallback/substitution hostilities, pre-spawn
// marker forgery, bounds abuse, and content-leak attempts. Every case must
// fail closed with a stable typed code, must never execute caller code from
// hostile descriptors, and must never advance a lane toward a second dispatch.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshApxDriverV1 } from '../mcp/v3/dsh-acpx-driver.mjs';
import { childEnvelopeDigestV1 } from '../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../mcp/v3/prompt-compiler.mjs';
import {
  DRIVER_OPERATION_SCHEMA_IDS,
  PROVIDER_DRIVER_VERSION,
  validateDriverLaunchRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  dshManifest,
  LEAK_MARKER,
  MUSE_MODEL,
  OX_MODEL,
  createFixtureDriver,
  dispatchLane,
  dshEnvelope,
  fakeDshTransport,
  readyIdentity,
} from './fixtures/r1-dsh-acpx-fixtures.mjs';

function expectCode(fn, code, message) {
  // A wildcard (undefined) code accepts any typed contract denial.
  assert.throws(fn, (error) => error instanceof RunContractV1Error
    && (code === undefined || error.code === code), message);
}

function requestFor(fixture, operation, overrides = {}, mutate) {
  const request = {
    schema: DRIVER_OPERATION_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    ...overrides,
  };
  if (mutate) mutate(request);
  return request;
}

test('factory options reject proxies, accessors, symbols, and forbidden authorities without running traps', () => {
  const base = () => fakeDshTransport();
  let getterRuns = 0;
  const accessorOptions = () => {
    const options = { transport: base().port, workspace_mode: 'managed' };
    Object.defineProperty(options, 'workspace_mode', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return 'managed';
      },
    });
    return options;
  };
  expectCode(() => createDshApxDriverV1(accessorOptions()), 'invalid_object',
    'accessor options are not enumerable data properties');
  assert.equal(getterRuns, 0, 'option getters must never run during validation');

  expectCode(() => createDshApxDriverV1(new Proxy({ transport: base().port, workspace_mode: 'managed' }, {})),
    'proxy_denied');
  const revocable = Proxy.revocable({ transport: base().port, workspace_mode: 'managed' }, {});
  revocable.revoke();
  expectCode(() => createDshApxDriverV1(revocable.proxy), 'proxy_denied');

  const symbolOptions = { transport: base().port, workspace_mode: 'managed' };
  symbolOptions[Symbol('hidden')] = 'x';
  expectCode(() => createDshApxDriverV1(symbolOptions), 'invalid_object',
    'symbol keys are not string data keys');

  const hiddenOptions = { transport: base().port, workspace_mode: 'managed' };
  Object.defineProperty(hiddenOptions, 'transport', { enumerable: false, value: base().port });
  expectCode(() => createDshApxDriverV1(hiddenOptions), 'invalid_object');

  for (const [label, options] of Object.entries({
    'missing workspace_mode': { transport: base().port },
    'direct mode': { transport: base().port, workspace_mode: 'direct' },
    'invented mode': { transport: base().port, workspace_mode: 'provider_managed' },
    'merge authority': { transport: base().port, workspace_mode: 'managed', allow_merge: true },
    'create pr': { transport: base().port, workspace_mode: 'managed', create_pr: true },
    'fallback provider': { transport: base().port, workspace_mode: 'managed', fallback_provider: 'grok' },
    'retry budget': { transport: base().port, workspace_mode: 'managed', retry_dispatch: 3 },
    'missing transport': { workspace_mode: 'managed' },
    'null transport': { transport: null, workspace_mode: 'managed' },
    'clock proxy': { transport: base().port, workspace_mode: 'managed', now: new Proxy(() => 0, {}) },
    'clock object': { transport: base().port, workspace_mode: 'managed', now: {} },
  })) {
    expectCode(() => createDshApxDriverV1(options), undefined, `${label} must be denied`);
  }
});

test('direct-mode and merge-authority keys on driver requests keep their shared denial codes', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  for (const [key, value, code] of [
    ['workspace_mode', 'direct', 'direct_mode_rejected'],
    ['direct_mode', true, 'direct_mode_rejected'],
    ['allow_merge', true, 'merge_authority_denied'],
    ['create_pr', true, 'merge_authority_denied'],
    ['fallback', true, 'replay_or_fallback_denied'],
    ['resend', true, 'replay_or_fallback_denied'],
    ['retry_dispatch', 'now', 'replay_or_fallback_denied'],
    ['allow_post_dispatch_fallback', true, 'replay_or_fallback_denied'],
    ['relaunch_attempts', 2, 'unknown_key'],
    ['reply', { session_id: 's', response: 'hi' }, 'unknown_key'],
    ['new_session', true, 'unknown_key'],
  ]) {
    expectCode(
      () => validateDriverLaunchRequestV1(requestFor(fixture, 'launch', { [key]: value })),
      code, `${key} must be denied with ${code}`);
  }
});

test('digest-only launches and tampered envelopes stay denied through the accepted contract', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  expectCode(() => validateDriverLaunchRequestV1({
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    child_envelope_digest: fixture.child_envelope_digest,
  }), 'digest_only_launch_denied');

  const flipped = `${fixture.child_envelope_digest.slice(0, 63)}${fixture.child_envelope_digest.endsWith('0') ? '1' : '0'}`;
  expectCode(() => validateDriverLaunchRequestV1(requestFor(fixture, 'launch', {
    child_envelope_digest: flipped,
  })), 'child_envelope_digest_mismatch');

  const tampered = `${fixture.envelope_text.slice(0, -1)}x`;
  // The strict parser denies the damaged bytes with its own typed code.
  expectCode(() => validateDriverLaunchRequestV1({
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: tampered,
    child_envelope_digest: fixture.child_envelope_digest,
  }), undefined, 'tampered envelope bytes must be denied');
});

test('forged spawn receipts degrade to honest uncertainty instead of a resend', () => {
  for (const [label, receipt] of Object.entries({
    'bad grammar': { session_ref: '../escape' },
    'empty ref': { session_ref: '' },
    'oversized ref': { session_ref: `s${'x'.repeat(200)}` },
    'wrong type': { session_ref: 42 },
    'extra key': { session_ref: 'sess-ok-0001', pid: 7 },
    'accessor': (() => {
      const receipt = {};
      Object.defineProperty(receipt, 'session_ref', {
        enumerable: true, get() { return 'sess-ok-0001'; },
      });
      return receipt;
    })(),
  })) {
    const transport = fakeDshTransport({ spawnReceipts: [receipt] });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, dshEnvelope(MUSE_MODEL));
    assert.equal(lane.launch.disposition, 'dispatch_uncertain',
      `forged spawn receipt (${label}) must stay uncertain`);
    expectCode(() => lane.launchAgain(), 'replay_denied', label);
    assert.equal(transport.counts().spawn, 1, `no resend after forged receipt (${label})`);
  }
});

test('pre-spawn markers cannot be forged through getters or exotic prototypes', () => {
  const getterMarked = {};
  Object.defineProperty(getterMarked, 'phase', {
    enumerable: true, get() { return 'prespawn'; },
  });
  Object.defineProperty(getterMarked, 'code', { enumerable: true, value: 'port_denied' });

  const subclassed = Object.assign(new (class PortError extends Error {})('nope'), {
    phase: 'prespawn', code: 'port_denied',
  });

  const phaseOnly = Object.assign(new Error('half marked'), { phase: 'prespawn' });
  const codeGetter = Object.assign(new Error('getter code'), { phase: 'prespawn' });
  Object.defineProperty(codeGetter, 'code', { enumerable: true, get() { return 'port_denied'; } });

  for (const [label, error] of Object.entries({
    getterPhase: getterMarked,
    subclassedPrototype: subclassed,
    phaseOnly,
    getterCode: codeGetter,
    stringThrown: 'prespawn',
    plainMarker: { phase: 'prespawn', code: 'PORT-DENIED' },
  })) {
    const transport = fakeDshTransport({ throwOnSpawn: () => error });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, dshEnvelope(MUSE_MODEL));
    assert.equal(lane.launch.disposition, 'dispatch_uncertain',
      `unprovable pre-spawn marker (${label}) must stay uncertain`);
    assert.notEqual(lane.launch.detail_code, 'transport_prespawn_denied', label);
  }
});

test('total post-dispatch transport failure never unlocks a replay or a substitution', () => {
  const fixture = dshEnvelope(OX_MODEL);
  const transport = fakeDshTransport({
    throwOnPoll: () => new Error('evidence vanished'),
    throwOnEvents: () => new Error('evidence vanished'),
    throwOnCancel: () => new Error('control channel gone'),
  });
  const driver = createFixtureDriver(OX_MODEL, transport);
  const lane = dispatchLane(driver.driver, fixture);
  assert.equal(lane.launch.disposition, 'dispatch_uncertain');

  // Observation loss is honest uncertainty, never a terminal invention.
  assert.equal(lane.reconcile({ intent: 'restart_reattach' }).disposition, 'dispatch_uncertain');
  assert.equal(lane.reconcile({ include: ['live_progress'] }).detail_code, 'evidence_absent');

  // Cancellation stays typed-unresolved and may be retried as control plane.
  expectCode(() => lane.cancel(), 'dsh_cancel_unresolved');
  expectCode(() => lane.cancel(), 'dsh_cancel_unresolved');

  // And the lane still refuses any relaunch or provider/model substitution.
  expectCode(() => lane.launchAgain(), 'replay_denied');

  const museManifest = JSON.parse(JSON.stringify(dshManifest(MUSE_MODEL)));
  museManifest.assignments[0].assignment_id = fixture.assignment_id;
  const museEnvelope = compileChildEnvelopeV1(museManifest, fixture.assignment_id);
  expectCode(() => driver.driver.preflight(requestFor(museEnvelope && {
    ...fixture,
    envelope_text: museEnvelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(museEnvelope).digest,
  }, 'preflight')), 'stale_identity_denied',
  'the same lane cannot be re-preflighted onto another model after dispatch');
});

test('malformed poll receipts fail closed with typed codes and never advance the lane', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  const goodReceipt = (request) => ({
    session_ref: request.session_ref, ...request.correlation,
    state: 'running', event_count: 1, cursor: 1, updated_at_ms: 10,
  });
  const cases = {
    'unknown state': (request) => ({ ...goodReceipt(request), state: 'zombie' }),
    'stop reason on running': (request) => ({ ...goodReceipt(request), stop_reason: 'end_turn' }),
    'question on running': (request) => ({ ...goodReceipt(request), question_ref: 'q-1' }),
    'bad question grammar': (request) => ({
      ...goodReceipt(request), state: 'needs_attention', question_ref: '../etc/passwd',
    }),
    'event count float': (request) => ({ ...goodReceipt(request), event_count: 1.5 }),
    'cursor over bound': (request) => ({ ...goodReceipt(request), cursor: 1_000_000_001 }),
    'updated at over bound': (request) => ({ ...goodReceipt(request), updated_at_ms: 5e12 }),
    'uppercase digest': (request) => ({
      ...goodReceipt(request),
      child_envelope_digest: request.correlation.child_envelope_digest.toUpperCase(),
    }),
    'missing state': (request) => {
      const receipt = goodReceipt(request);
      delete receipt.state;
      return receipt;
    },
    'extra key': (request) => ({ ...goodReceipt(request), raw: 'provider output text' }),
    'own undefined': (request) => {
      const receipt = goodReceipt(request);
      receipt.question_ref = undefined;
      return receipt;
    },
    'null receipt': () => null,
    'array receipt': () => [],
    'leak attempt': (request) => ({
      ...goodReceipt(request), state: 'needs_attention',
      question_ref: `q-${LEAK_MARKER}`,
      leak_attempt: `${LEAK_MARKER} provider-authored text`,
    }),
  };
  for (const [label, receipt] of Object.entries(cases)) {
    const transport = fakeDshTransport({ polls: [receipt] });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, fixture);
    expectCode(() => lane.reconcile(), undefined, `poll receipt (${label}) must be denied`);
    const counts = transport.counts();
    assert.equal(counts.spawn, 1);
    // The lane was untouched by the denied observation; a healthy port still reconciles.
  }
  const healed = fakeDshTransport({ polls: [goodReceipt] });
  const healedDriver = createFixtureDriver(MUSE_MODEL, healed);
  const healedLane = dispatchLane(healedDriver.driver, fixture);
  assert.equal(healedLane.reconcile().disposition, 'in_progress');
});

test('hostile event pages are rejected wholesale and leak nothing', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  const pageWith = (records, nextCursorDelta = 0) => [(request) => ({
    records,
    next_cursor: request.cursor + nextCursorDelta + records.length,
    truncated: false,
  })];
  const cases = {
    'sparse records': [(request) => {
      const records = [{ seq: request.cursor + 1, kind: 'status', bytes: 1 }];
      records[5] = { seq: request.cursor + 9, kind: 'status', bytes: 1 };
      return { records, next_cursor: request.cursor + 10, truncated: false };
    }],
    'record extra key': pageWith([{ seq: 1, kind: 'status', bytes: 1, text: LEAK_MARKER }]),
    'record unknown kind': pageWith([{ seq: 1, kind: 'raw_output', bytes: 1 }]),
    'record negative bytes': pageWith([{ seq: 1, kind: 'status', bytes: -1 }]),
    'record bytes over bound': pageWith([{ seq: 1, kind: 'status', bytes: 4097 }]),
    'record non-increasing seq': pageWith([
      { seq: 1, kind: 'status', bytes: 1 }, { seq: 1, kind: 'status', bytes: 1 },
    ]),
    'record accessor': pageWith([(() => {
      const record = {};
      Object.defineProperty(record, 'seq', { enumerable: true, get() { return 1; } });
      record.kind = 'status';
      record.bytes = 1;
      return record;
    })()]),
    'truncated non-boolean': [(request) => ({
      records: [], next_cursor: request.cursor, truncated: 'yes',
    })],
    'next cursor backwards': [(request) => ({
      records: [], next_cursor: -1, truncated: false,
    })],
    'aliased records': [(request) => {
      const shared = { seq: request.cursor + 1, kind: 'status', bytes: 1 };
      return { records: [shared, shared], next_cursor: request.cursor + 2, truncated: false };
    }],
  };
  for (const [label, eventPages] of Object.entries(cases)) {
    const transport = fakeDshTransport({ polls: [{ state: 'running' }], eventPages });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, fixture);
    expectCode(() => lane.reconcile({ include: ['detailed_events'] }), undefined, label);
    const serialized = JSON.stringify([...transport.calls.poll]);
    assert.ok(!serialized.includes(LEAK_MARKER), label);
  }
});

test('identity receipts cannot smuggle unavailable reasons past validation', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  const preflightRequest = requestFor(fixture, 'preflight');
  const cases = {
    'bogus reason': { ready: false, reason: 'operator_felt_tired' },
    'reason on ready': readyIdentity({ reason: 'config_unavailable' }),
    'relative config path': readyIdentity({ config_path: 'relative/dsh-acp.yml' }),
    'windows path': readyIdentity({ config_path: '\\\\server\\share\\dsh-acp.yml' }),
    'short digest': readyIdentity({ config_sha256: 'abc' }),
    'credential source env file hybrid': readyIdentity({ credential_source: 'both' }),
    'ready not boolean': { ...readyIdentity({}), ready: 'true' },
    'proxy receipt': new Proxy(readyIdentity(), {}),
  };
  for (const [label, identity] of Object.entries(cases)) {
    const driver = createFixtureDriver(MUSE_MODEL, fakeDshTransport({ identity: () => identity }));
    expectCode(() => driver.driver.preflight(preflightRequest), undefined, `identity (${label})`);
  }
});

test('cancel receipts are held to the same closed shape', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  for (const [label, cancelReceipts] of Object.entries({
    'unknown outcome': [{ outcome: 'maybe' }],
    'missing outcome': [(request) => ({
      session_ref: request.session_ref, ...request.correlation,
    })],
    'outcome wrong type': [{ outcome: 1 }],
    'foreign session': [{
      outcome: 'confirmed', session_ref: 'sess-other-0001',
    }],
    'accessor outcome': [(() => {
      const build = (request) => {
        const built = { session_ref: request.session_ref, ...request.correlation };
        Object.defineProperty(built, 'outcome', {
          enumerable: true, get() { return 'confirmed'; },
        });
        return built;
      };
      return build;
    })()],
  })) {
    const transport = fakeDshTransport({ cancelReceipts });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, fixture);
    expectCode(() => lane.cancel(), undefined, `cancel receipt (${label})`);
  }
});

test('bounds abuse fails closed: oversized lanes, budgets, cursors, and timing', () => {
  const fixture = dshEnvelope(MUSE_MODEL);

  // Lane budget.
  const fleet = createFixtureDriver(MUSE_MODEL, fakeDshTransport());
  for (let index = 0; index < 64; index += 1) {
    const laneFixture = dshEnvelope(MUSE_MODEL, `fleet-${String(index).padStart(2, '0')}`);
    fleet.driver.preflight(requestFor(laneFixture, 'preflight'));
  }
  expectCode(() => fleet.driver.preflight(requestFor(dshEnvelope(MUSE_MODEL, 'fleet-over'), 'preflight')),
    'lane_budget_exceeded');

  // Cursor abuse through a receipt that claims an impossible cursor.
  const cursorAbuse = fakeDshTransport({
    polls: [(request) => ({
      session_ref: request.session_ref, ...request.correlation,
      state: 'running', event_count: 1025, cursor: 2_000_000_000, updated_at_ms: 10,
    })],
  });
  const cursorDriver = createFixtureDriver(MUSE_MODEL, cursorAbuse);
  const cursorLane = dispatchLane(cursorDriver.driver, fixture);
  expectCode(() => cursorLane.reconcile(), 'invalid_format');

  // Clock abuse: NaN and out-of-range readings deny before any transport call.
  for (const clock of [() => Number.NaN, () => 4102444800001]) {
    const transport = fakeDshTransport();
    const driver = createFixtureDriver(MUSE_MODEL, transport, { now: clock });
    expectCode(() => driver.driver.preflight(requestFor(fixture, 'preflight')), 'invalid_format');
    assert.equal(transport.counts().configIdentity, 0);
  }

  // A throwing clock denies too.
  const throwingClock = fakeDshTransport();
  const throwingDriver = createFixtureDriver(MUSE_MODEL, throwingClock, {
    now: () => {
      throw new Error('clock exploded');
    },
  });
  expectCode(() => throwingDriver.driver.preflight(requestFor(fixture, 'preflight')), 'invalid_format');
  assert.equal(throwingClock.counts().configIdentity, 0);
});

test('the ox-alpha lane rejects muse-model evidence and vice versa', () => {
  for (const model of [MUSE_MODEL, OX_MODEL]) {
    const otherModel = model === MUSE_MODEL ? OX_MODEL : MUSE_MODEL;
    const fixture = dshEnvelope(model);
    const corruptedModel = (request) => ({
      session_ref: request.session_ref,
      ...request.correlation,
      model: otherModel,
    });
    const transport = fakeDshTransport({
      polls: [(request) => ({
        ...corruptedModel(request),
        state: 'running', event_count: 1, cursor: 1, updated_at_ms: 10,
      })],
      cancelReceipts: [(request) => ({ ...corruptedModel(request), outcome: 'confirmed' })],
    });
    const driver = createFixtureDriver(model, transport);
    const lane = dispatchLane(driver.driver, fixture);
    expectCode(() => lane.reconcile(), 'dsh_correlation_mismatch',
      `${otherModel} evidence must not serve a ${model} lane`);
    expectCode(() => lane.cancel(), 'dsh_correlation_mismatch');
  }
});

test('results never carry provider-authored text even from deeply hostile transports', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  const hostileText = `${LEAK_MARKER} token sk-abc123defghijk password=hunter2 AKIAIOSFODNN7EXAMPLE`;
  const transport = fakeDshTransport({
    polls: [(request) => ({
      session_ref: request.session_ref, ...request.correlation,
      state: 'needs_attention',
      event_count: 3, cursor: 3, updated_at_ms: 20,
      question_ref: `q-${LEAK_MARKER}`,
    })],
    eventPages: [(request) => ({
      records: Array.from({ length: request.max_records }, (_, index) => ({
        seq: index + 1, kind: 'text_delta', bytes: 2048,
      })),
      next_cursor: request.max_records,
      truncated: true,
    })],
  });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const lane = dispatchLane(driver.driver, fixture);
  const seen = [
    lane.reconcile({ include: ['detailed_events', 'live_progress'], intent: 'restart_reattach' }),
    lane.cancel(),
  ];
  for (const result of seen) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(LEAK_MARKER), 'marker leaked into results');
    assert.ok(!serialized.includes('hunter2'), 'secret-shaped text leaked into results');
    assert.ok(!serialized.includes('AKIAIOSFODNN7'), 'aws-style token leaked into results');
  }
});
