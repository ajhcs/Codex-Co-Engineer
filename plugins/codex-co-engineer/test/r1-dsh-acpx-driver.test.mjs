// Runtime tests for the P20 DSH ACPX provider driver: hard provider/model
// binding, the four P17 lifecycle operations over an injected bounded
// one-shot transport port, honest post-spawn uncertainty (no replay,
// retry, or fallback), unsupported same-session reply surfacing, recorded-
// evidence reconcile/restart recovery and cancellation confirmation, exact
// identity/correlation drift denials, bounds, and content-free telemetry.
// No real DSH transport is configured or qualified here.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DSH_ALLOWED_MODELS,
  DSH_ACPX_TRANSPORT_KEYS,
  DSH_CANCEL_OUTCOMES,
  DSH_DETAIL_CODES,
  DSH_EVIDENCE_STATES,
  DSH_EVENT_KINDS,
  DSH_MAX_CURSOR,
  DSH_MAX_EVENT_PAGE_RECORDS,
  DSH_MAX_EVENT_RECORD_BYTES,
  DSH_MAX_LANES,
  DSH_MAX_LAUNCH_ATTEMPTS,
  DSH_MAX_LANE_OPERATIONS,
  DSH_MAX_RECORDED_EVENTS,
  DSH_MODEL_IDENTITIES,
  DSH_PROVIDER,
  DSH_STOP_REASONS,
  assertDshAcpTransportV1,
  createDshApxDriverV1,
  describeDshApxDriverV1,
  validateDshConfigIdentityV1,
} from '../mcp/v3/dsh-acpx-driver.mjs';
import { childEnvelopeDigestV1 } from '../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../mcp/v3/prompt-compiler.mjs';
import {
  DRIVER_DECLARATION_SCHEMA_ID,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  assertCapabilityRequirementV1,
  assertProviderDriverV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { CLOUD_STARTING_REF } from './fixtures/r1-resolver-fixtures.mjs';
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
import { runProviderDriverContractSuiteV1 } from './provider-driver-contract-suite.mjs';

function expectCode(fn, code, message) {
  // A wildcard (undefined) code accepts any typed contract denial.
  assert.throws(fn, (error) => error instanceof RunContractV1Error
    && (code === undefined || error.code === code), message);
}

const CONTENT_FREE_DETAIL = /^[A-Za-z0-9_=.:/ -]+$/u;

test('factory surface is closed, frozen, and hard-bound to dsh with exactly two models', () => {
  const facade = createFixtureDriver(MUSE_MODEL, fakeDshTransport());
  assert.equal(facade.schema, 'codex-co-engineer.dsh-acpx-driver.v1');
  assert.equal(facade.version, 1);
  assert.equal(facade.provider, DSH_PROVIDER);
  assert.deepEqual([...facade.models], [MUSE_MODEL, OX_MODEL]);
  assert.equal(facade.workspace_mode, 'managed');
  assert.equal(facade.workspace_semantics, 'local_managed_worktree');
  assert.equal(facade.workspace_starting_point, 'run_base_sha');
  assert.ok(Object.isFrozen(facade));
  assertProviderDriverV1(facade.driver);
  assert.deepEqual(Object.keys(facade.driver).sort(), ['cancel', 'launch', 'preflight', 'reconcile']);
  assert.equal(facade.declaration.schema, DRIVER_DECLARATION_SCHEMA_ID);
  assert.equal(facade.declaration.capability.schema, PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID);
  assert.equal(facade.declaration.capability.provider, 'dsh');
});

test('the shipped declaration keeps asserting the honest DSH posture', () => {
  const facade = createFixtureDriver(MUSE_MODEL, fakeDshTransport());
  const capability = assertCapabilityRequirementV1(facade.declaration, {
    artifact_kinds: ['provider_report'],
    create_pr_posture: 'prohibited',
    dispatch_certainty: 'uncertain_after_spawn',
    exact_model_selection: 'exact_and_attested',
    merge_authority: 'none_codex_only_integration',
    replay_posture: 'never_replay',
    same_session_reply: 'unsupported_unresolved_attention',
    workspace_semantics: 'local_managed_worktree',
    workspace_starting_point: 'run_base_sha',
  });
  assert.equal(capability.revision, 'p20.dsh-acpx.1');
  assert.deepEqual({ ...facade.features }, {
    cancellation: 'supported',
    detailed_events: 'supported',
    live_progress: 'supported',
    restart: 'reconcile_reattach_only',
  });
});

test('the driver passes the accepted provider-neutral P17 conformance suite unmodified', () => {
  const facade = createFixtureDriver(OX_MODEL, fakeDshTransport());
  runProviderDriverContractSuiteV1(facade.driver, {
    label: 'dsh-acpx-driver',
    declaration: facade.declaration,
  });
});

test('describe reports bounded vocabularies and only false non-claims', () => {
  const description = describeDshApxDriverV1();
  assert.equal(description.transport_mode, 'injected_bounded_one_shot_port');
  assert.deepEqual([...description.models], [...DSH_ALLOWED_MODELS]);
  assert.deepEqual([...description.evidence_states], [...DSH_EVIDENCE_STATES]);
  assert.deepEqual([...description.event_kinds], [...DSH_EVENT_KINDS]);
  assert.deepEqual([...description.cancel_outcomes], [...DSH_CANCEL_OUTCOMES]);
  assert.deepEqual([...description.stop_reasons_placeholder ?? []], []);
  for (const value of Object.values(description.claims)) assert.equal(value, false);
  assert.equal(description.bounds.recorded_events, DSH_MAX_RECORDED_EVENTS);
  assert.equal(description.bounds.lanes, DSH_MAX_LANES);
  assert.ok(DSH_DETAIL_CODES.length >= 12 && new Set(DSH_DETAIL_CODES).size === DSH_DETAIL_CODES.length);
  assert.ok(new Set([...DSH_EVIDENCE_STATES]).size === DSH_EVIDENCE_STATES.length);
  assert.ok(new Set([...DSH_STOP_REASONS]).size === DSH_STOP_REASONS.length);
  assert.ok(new Set([...DSH_EVENT_KINDS]).size === DSH_EVENT_KINDS.length);
});

test('model identity data stays an informational mirror of the supervisor routing', () => {
  assert.deepEqual({ ...DSH_MODEL_IDENTITIES[MUSE_MODEL] }, {
    config_file: 'dsh-acp.yml',
    credential_env: 'MODEL_API_KEY',
    credential_file_env: 'CODEX_CO_ENGINEER_MODEL_API_KEY_FILE',
    credential_file: 'model-api-key',
  });
  assert.deepEqual({ ...DSH_MODEL_IDENTITIES[OX_MODEL] }, {
    config_file: 'dsh-acp-ox-alpha.yml',
    credential_env: 'OPENROUTER_API_KEY',
    credential_file_env: 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
    credential_file: 'openrouter-api-key',
  });
});

test('preflight is ready on a healthy identity and blocked honestly when the port cannot resolve one', () => {
  const healthy = createFixtureDriver(MUSE_MODEL, fakeDshTransport());
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(healthy.driver, fixture);
  assert.equal(lane.preflight.disposition, 'ready');
  assert.equal(lane.preflight.detail_code, undefined);

  const unavailableTransport = fakeDshTransport({ throwOnIdentity: () => new Error('probe blew up') });
  const unavailable = createFixtureDriver(MUSE_MODEL, unavailableTransport);
  const blockedResult = unavailable.driver.preflight({
    schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
    envelope_text: fixture.envelope_text, child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(blockedResult.disposition, 'blocked');
  assert.equal(blockedResult.detail_code, 'dsh_transport_unavailable');
  assert.match(blockedResult.detail_message, CONTENT_FREE_DETAIL);
});

test('a lost identity probe during launch is provably not_sent and may be retried once', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  let identityCalls = 0;
  const transport = fakeDshTransport({
    identity: () => {
      identityCalls += 1;
      if (identityCalls >= 2) throw new Error('config probe lost');
      return readyIdentity();
    },
  });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  driver.driver.preflight({
    schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
    envelope_text: fixture.envelope_text, child_envelope_digest: fixture.child_envelope_digest,
  });
  // The spawn call was never made, so the failure is provably pre-spawn...
  const firstLaunch = driver.driver.launch({
    schema: 'codex-co-engineer.driver-launch.v1', version: 1,
    envelope_text: fixture.envelope_text, child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(firstLaunch.disposition, 'not_sent');
  assert.equal(firstLaunch.detail_code, 'transport_prespawn_denied');
  assert.equal(transport.port ? transport.counts().spawn : transport.counts().spawn, 0);
});

test('preflight maps identity-unavailability reasons to dedicated blocked codes', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  const preflightRequest = () => ({
    schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
    envelope_text: fixture.envelope_text, child_envelope_digest: fixture.child_envelope_digest,
  });
  for (const [identity, code] of [
    [{ ready: false, reason: 'config_unavailable' }, 'dsh_config_unavailable'],
    [{ ready: false, reason: 'credential_unavailable' }, 'dsh_credential_unavailable'],
    [{ ready: false }, 'dsh_config_unavailable'],
  ]) {
    const driver = createFixtureDriver(MUSE_MODEL, fakeDshTransport({ identity }));
    const result = driver.driver.preflight(preflightRequest());
    assert.equal(result.disposition, 'blocked');
    assert.equal(result.detail_code, code);
    assert.match(result.detail_message, CONTENT_FREE_DETAIL);
  }
  // An own-undefined receipt field is malformed data, not probe loss: it must
  // fail closed with its typed code instead of a soft blocked posture.
  const malformed = createFixtureDriver(MUSE_MODEL, fakeDshTransport({
    identity: () => ({ ready: false, reason: undefined }),
  }));
  expectCode(() => malformed.driver.preflight(preflightRequest()), 'own_undefined_denied');
});

test('launch stays dispatch_uncertain after spawn and forwards the exact child payload', () => {
  const transport = fakeDshTransport();
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  assert.equal(lane.launch.disposition, 'dispatch_uncertain');
  assert.equal(lane.launch.detail_code, undefined);
  const payload = transport.calls.spawn[0];
  assert.equal(payload.envelope_text, fixture.envelope_text);
  assert.equal(payload.child_envelope_digest, fixture.child_envelope_digest);
  assert.equal(payload.model, MUSE_MODEL);
  assert.equal(payload.run_id, fixture.run_id);
  assert.equal(payload.assignment_id, fixture.assignment_id);
  assert.equal(payload.lane_index, fixture.lane_index);
  assert.equal(payload.base_sha, fixture.base_sha);
  assert.equal(typeof payload.attempted_at_ms, 'number');
  assert.ok(Number.isSafeInteger(payload.attempted_at_ms));
  assert.equal(Object.isFrozen(payload), true);
});

test('the ox-alpha model drives the identical lifecycle without substitution', () => {
  const transport = fakeDshTransport();
  const driver = createFixtureDriver(OX_MODEL, transport);
  const fixture = dshEnvelope(OX_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  assert.equal(lane.preflight.disposition, 'ready');
  assert.equal(lane.launch.disposition, 'dispatch_uncertain');
  assert.equal(lane.reconcile({ include: ['live_progress'] }).disposition, 'in_progress');
  assert.equal(transport.calls.spawn[0].model, OX_MODEL);
});

test('cross-provider envelopes are refused before any transport call happens', () => {
  for (const provider of ['grok', 'cursor-local', 'cursor-cloud']) {
    const manifest = JSON.parse(JSON.stringify(dshManifest(MUSE_MODEL)));
    manifest.assignments[0].execution.provider = provider;
    if (provider === 'cursor-cloud') manifest.assignments[0].starting_ref = CLOUD_STARTING_REF;
    const envelope = compileChildEnvelopeV1(manifest, 'dsh-lane');
    const transport = fakeDshTransport();
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const request = {
      schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
      envelope_text: envelope.envelope_text,
      child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
    };
    expectCode(() => driver.driver.preflight(request), 'provider_slot_mismatch');
    assert.equal(transport.counts().configIdentity, 0, 'no transport probe may run for foreign providers');
  }
});

test('non-canonical dsh models are denied; both allowed models are accepted verbatim', () => {
  for (const model of ['muse-spark-1.2', 'stealth/ox-alpha-latest', '-', '', 'MUSE-SPARK-1.2-CONTRIBUTOR']) {
    const manifest = JSON.parse(JSON.stringify(dshManifest(MUSE_MODEL)));
    manifest.assignments[0].execution.model = model;
    let envelope;
    try {
      envelope = compileChildEnvelopeV1(manifest, 'dsh-lane');
    } catch {
      continue; // the compiler itself rejects some non-canonical models first
    }
    const driver = createFixtureDriver(MUSE_MODEL, fakeDshTransport());
    expectCode(() => driver.driver.preflight({
      schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
      envelope_text: envelope.envelope_text,
      child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
    }), 'dsh_model_denied', `model ${model} must be denied`);
  }
  assert.deepEqual([...DSH_ALLOWED_MODELS], [MUSE_MODEL, OX_MODEL]);
});

test('reconcile maps recorded evidence onto honest dispositions with content-free details', () => {
  const cases = [
    [{ state: 'accepted' }, 'in_progress', 'live_progress'],
    [{ state: 'running' }, 'in_progress', 'live_progress'],
    [{ state: 'needs_attention', question_ref: `q-${LEAK_MARKER}` }, 'unresolved_attention', 'unresolved_attention'],
    [{ state: 'completed', stop_reason: 'end_turn' }, 'terminal', 'terminal_evidence'],
    [{ state: 'failed', stop_reason: 'error' }, 'terminal', 'terminal_evidence'],
    [{ state: 'cancelled', stop_reason: 'cancelled' }, 'terminal', 'terminal_evidence'],
    [{ state: 'absent' }, 'dispatch_uncertain', 'evidence_absent'],
  ];
  for (const [receipt, disposition, detailCode] of cases) {
    const transport = fakeDshTransport({ polls: [receipt] });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, dshEnvelope(MUSE_MODEL));
    const result = lane.reconcile({ include: ['live_progress'] });
    assert.equal(result.disposition, disposition, `state ${JSON.stringify(receipt.state)}`);
    assert.equal(result.detail_code, detailCode);
    assert.match(result.detail_message, CONTENT_FREE_DETAIL);
    assert.ok(result.detail_message.length <= 512);
    assert.ok(!result.detail_message.includes(LEAK_MARKER), 'question/prompt content must never surface');
  }
});

test('restart_reattach recovers from recorded evidence and never relaunches anything', () => {
  const transport = fakeDshTransport({ polls: [{ state: 'running' }] });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  const recovered = lane.reconcile({ intent: 'restart_reattach', include: ['detailed_events'] });
  assert.equal(recovered.disposition, 'in_progress');
  assert.equal(recovered.detail_code, 'live_progress');
  assert.equal(transport.counts().spawn, 1, 'restart recovery must not spawn again');

  const lost = fakeDshTransport({ polls: [{ state: 'absent' }] });
  const lostDriver = createFixtureDriver(MUSE_MODEL, lost);
  const lostLane = dispatchLane(lostDriver.driver, fixture);
  const uncertain = lostLane.reconcile({ intent: 'restart_reattach' });
  assert.equal(uncertain.disposition, 'dispatch_uncertain');
  assert.equal(lost.counts().spawn, 1, 'missing evidence never authorizes a relaunch');
});

test('cancellation maps confirmed/requested/already_terminal outcomes with bounded details', () => {
  for (const outcome of DSH_CANCEL_OUTCOMES) {
    const expectedDisposition = {
      confirmed: 'cancel_confirmed',
      requested: 'cancel_requested',
      already_terminal: 'already_terminal',
    }[outcome];
    const transport = fakeDshTransport({ cancelReceipts: [{ outcome }] });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, dshEnvelope(MUSE_MODEL));
    const result = lane.cancel();
    assert.equal(result.disposition, expectedDisposition);
    assert.equal(result.detail_code, expectedDisposition);
    assert.match(result.detail_message, CONTENT_FREE_DETAIL);
  }
});

test('duplicate launch after any launch observation fails closed as a replay', () => {
  const transport = fakeDshTransport();
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const lane = dispatchLane(driver.driver, dshEnvelope(MUSE_MODEL));
  expectCode(() => lane.launchAgain(), 'replay_denied');
  expectCode(() => lane.preflightAgain(), 'invalid_transition');
  assert.equal(transport.counts().spawn, 1);
});

test('a provably pre-spawn failure reports not_sent and permits exactly one more attempt', () => {
  const prespawnError = Object.assign(new Error('port denied pre-spawn'), {
    phase: 'prespawn', code: 'port_denied',
  });
  const transport = fakeDshTransport({ throwOnSpawn: () => prespawnError });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  assert.equal(lane.launch.disposition, 'not_sent');
  assert.equal(lane.launch.detail_code, 'transport_prespawn_denied');

  // One retry is allowed because the prompt provably never went out.
  const recovering = fakeDshTransport();
  const recoveringDriver = createFixtureDriver(MUSE_MODEL, recovering);
  const recoveredLane = dispatchLane(recoveringDriver.driver, fixture);
  assert.equal(recoveredLane.launch.disposition, 'dispatch_uncertain');

  const twiceFailed = createFixtureDriver(MUSE_MODEL, fakeDshTransport({ throwOnSpawn: () => prespawnError }));
  const twiceLane = dispatchLane(twiceFailed.driver, fixture);
  twiceLane.launchAgain();
  expectCode(() => twiceLane.launchAgain(), 'launch_budget_exceeded');
});

test('post-spawn exceptions stay dispatch_uncertain forever with no replay or fallback', () => {
  const transport = fakeDshTransport({ throwOnSpawn: () => new Error('process died mid-spawn') });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  assert.equal(lane.launch.disposition, 'dispatch_uncertain');
  expectCode(() => lane.launchAgain(), 'replay_denied');
  expectCode(() => lane.preflightAgain(), 'invalid_transition');
  // An intent-only lane has no session handle: observation stays honestly
  // uncertain, invents no terminality, and never replays the child to
  // recover a handle.
  const observed = lane.reconcile({ intent: 'restart_reattach', include: ['detailed_events'] });
  assert.equal(observed.disposition, 'dispatch_uncertain');
  assert.equal(observed.detail_code, 'evidence_absent');
  expectCode(() => lane.cancel(), 'dsh_cancel_unresolved');
  assert.equal(transport.counts().spawn, 1);
  assert.equal(transport.counts().poll, 0, 'no poll can run without a session handle');
});

test('identity drift between preflight and later operations fails closed before spawn', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  const requestFor = (operation) => ({
    schema: `codex-co-engineer.driver-${operation}.v1`.replace('driver-preflight', 'driver-preflight'),
    version: 1,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  });

  const drifted = fakeDshTransport({
    identity: (callIndex) => (callIndex === 1
      ? readyIdentity()
      : readyIdentity({ credential_sha256: 'c'.repeat(64) })),
  });
  const driver = createFixtureDriver(MUSE_MODEL, drifted);
  driver.driver.preflight(requestFor('preflight'));
  expectCode(() => driver.driver.launch(requestFor('launch')), 'dsh_identity_drift');
  assert.equal(drifted.counts().spawn, 0, 'drift must deny before the spawn intent begins');

  for (const field of ['config_path', 'config_sha256', 'credential_source']) {
    const perField = fakeDshTransport({
      identity: (callIndex) => (callIndex === 1
        ? readyIdentity()
        : readyIdentity({ [field]: field === 'config_path'
          ? '/elsewhere/dsh-acp.yml'
          : field === 'config_sha256' ? 'd'.repeat(64) : 'file' })),
    });
    const fieldDriver = createFixtureDriver(MUSE_MODEL, perField);
    fieldDriver.driver.preflight(requestFor('preflight'));
    // Launch re-probes identity immediately before the spawn intent: drift
    // fails closed before anything can be sent.
    expectCode(() => fieldDriver.driver.launch(requestFor('launch')), 'dsh_identity_drift', field);
    assert.equal(perField.counts().spawn, 0, `drift denies before spawn (${field})`);
  }

  const gone = fakeDshTransport({
    identity: (callIndex) => (callIndex === 1 ? readyIdentity() : { ready: false, reason: 'credential_unavailable' }),
  });
  const goneDriver = createFixtureDriver(MUSE_MODEL, gone);
  goneDriver.driver.preflight(requestFor('preflight'));
  expectCode(() => goneDriver.driver.launch(requestFor('launch')), 'dsh_identity_unavailable');
  assert.equal(gone.counts().spawn, 0, 'unavailable identity denies before spawn');
});

test('task/session correlation drift in recorded evidence fails closed per field', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  for (const field of ['run_id', 'assignment_id', 'lane_index', 'base_sha', 'child_envelope_digest', 'session_ref', 'model']) {
    const wrongValue = field === 'lane_index'
      ? 5
      : field === 'child_envelope_digest'
        ? `${fixture.child_envelope_digest.slice(0, 63)}0`
        : field === 'session_ref'
          ? 'sess-other-9999'
          : `wrong-${field}`;
    const corrupted = (request) => ({
      session_ref: field === 'session_ref' ? wrongValue : request.session_ref,
      ...request.correlation,
      ...(field !== 'session_ref' ? { [field]: wrongValue } : {}),
    });
    const transport = fakeDshTransport({
      polls: [(request) => ({
        ...corrupted(request),
        state: 'running', event_count: 1, cursor: 1, updated_at_ms: 10,
      })],
      cancelReceipts: [(request) => ({ ...corrupted(request), outcome: 'confirmed' })],
    });
    const driver = createFixtureDriver(MUSE_MODEL, transport);
    const lane = dispatchLane(driver.driver, fixture);
    expectCode(() => lane.reconcile(), 'dsh_correlation_mismatch', field);
    expectCode(() => lane.cancel(), 'dsh_correlation_mismatch', field);
  }
});

test('event pages are bounded, cursor-monotonic, and stop at the recorded-event budget', () => {
  const transport = fakeDshTransport();
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  const first = lane.reconcile({ include: ['detailed_events', 'live_progress'] });
  assert.equal(first.detail_code, 'live_progress');
  assert.equal(transport.calls.events[0].max_records, DSH_MAX_EVENT_PAGE_RECORDS);

  const overbound = fakeDshTransport({
    polls: [{ state: 'running' }],
    eventPages: [(request) => ({
      records: Array.from({ length: request.max_records + 1 }, (_, index) => ({
        seq: index + 1, kind: 'status', bytes: 1,
      })),
      next_cursor: request.max_records + 1,
      truncated: true,
    })],
  });
  const overDriver = createFixtureDriver(MUSE_MODEL, overbound);
  const overLane = dispatchLane(overDriver.driver, fixture);
  expectCode(() => overLane.reconcile({ include: ['live_progress'] }), 'event_page_overbound');

  const nonIncreasing = fakeDshTransport({
    polls: [{ state: 'running' }],
    eventPages: [(request) => ({
      records: [{ seq: request.cursor, kind: 'status', bytes: 1 }],
      next_cursor: request.cursor,
      truncated: false,
    })],
  });
  const nonIncreasingDriver = createFixtureDriver(MUSE_MODEL, nonIncreasing);
  const nonIncreasingLane = dispatchLane(nonIncreasingDriver.driver, fixture);
  expectCode(() => nonIncreasingLane.reconcile({ include: ['live_progress'] }), 'invalid_format');

  const missingEvents = fakeDshTransport({ throwOnEvents: () => new Error('evidence dir gone') });
  const missingDriver = createFixtureDriver(MUSE_MODEL, missingEvents);
  const missingLane = dispatchLane(missingDriver.driver, fixture);
  expectCode(() => missingLane.reconcile({ include: ['detailed_events'] }), 'dsh_events_unavailable');
  // Observing without includes stays possible after the diagnostic failure.
  assert.equal(missingLane.reconcile().disposition, 'in_progress');
});

test('the event budget stops page reads once the recorded cap is reached', () => {
  let seq = 0;
  const transport = fakeDshTransport({
    polls: [{ state: 'running' }],
    eventPages: [(request) => ({
      records: Array.from({ length: request.max_records }, () => ({ seq: (seq += 1), kind: 'status', bytes: 8 })),
      next_cursor: seq,
      truncated: seq >= DSH_MAX_RECORDED_EVENTS,
    })],
  });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  let last;
  for (let round = 0; round < Math.ceil(DSH_MAX_RECORDED_EVENTS / DSH_MAX_EVENT_PAGE_RECORDS) + 2; round += 1) {
    last = lane.reconcile({ include: ['detailed_events'] });
  }
  assert.equal(last.detail_message.includes(`events=${DSH_MAX_RECORDED_EVENTS}`), true, last.detail_message);
  assert.equal(last.detail_message.includes('truncated=true'), true);
  const readsAtBudget = transport.counts().events;
  lane.reconcile({ include: ['detailed_events'] });
  assert.equal(transport.counts().events, readsAtBudget, 'no further page reads once the budget is exhausted');
});

test('bounds constants stay inside their advertised ranges', () => {
  assert.ok(DSH_MAX_LANES >= 1 && DSH_MAX_LANES <= 1024);
  assert.ok(DSH_MAX_LAUNCH_ATTEMPTS >= 1 && DSH_MAX_LAUNCH_ATTEMPTS <= 8);
  assert.ok(DSH_MAX_LANE_OPERATIONS >= 16);
  assert.ok(DSH_MAX_RECORDED_EVENTS >= DSH_MAX_EVENT_PAGE_RECORDS);
  assert.ok(DSH_MAX_EVENT_RECORD_BYTES >= 1 && DSH_MAX_EVENT_RECORD_BYTES <= 65536);
  assert.ok(DSH_MAX_CURSOR >= DSH_MAX_RECORDED_EVENTS);
  assert.equal(DSH_ACPX_TRANSPORT_KEYS.length, 5);
});

test('the lane budget denies the 65th distinct lane while existing lanes keep working', () => {
  const transport = fakeDshTransport();
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  for (let index = 0; index < DSH_MAX_LANES; index += 1) {
    const fixture = dshEnvelope(MUSE_MODEL, `lane-${String(index).padStart(2, '0')}`);
    const result = driver.driver.preflight({
      schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
      envelope_text: fixture.envelope_text, child_envelope_digest: fixture.child_envelope_digest,
    });
    assert.equal(result.disposition, 'ready');
  }
  const extra = dshEnvelope(MUSE_MODEL, 'lane-overflows');
  expectCode(() => driver.driver.preflight({
    schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
    envelope_text: extra.envelope_text, child_envelope_digest: extra.child_envelope_digest,
  }), 'lane_budget_exceeded');
});

test('the operation budget caps work per lane and clock regressions fail closed', () => {
  let now = 10_000;
  const transport = fakeDshTransport({ polls: [{ state: 'running' }] });
  const driver = createFixtureDriver(MUSE_MODEL, transport, { now: () => (now += 1) });
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  const remaining = DSH_MAX_LANE_OPERATIONS - 2;
  for (let index = 0; index < remaining; index += 1) {
    lane.reconcile();
  }
  expectCode(() => lane.reconcile(), 'operation_budget_exceeded');

  let backwardsClock = 20_000;
  let dispatchedBackwards = false;
  const backwards = createFixtureDriver(MUSE_MODEL, fakeDshTransport(), {
    now: () => {
      if (!dispatchedBackwards) {
        backwardsClock += 1;
        return backwardsClock;
      }
      backwardsClock -= 5_000;
      return backwardsClock;
    },
  });
  const backFixture = dshEnvelope(MUSE_MODEL, 'clock-lane');
  const backLane = dispatchLane(backwards.driver, backFixture);
  dispatchedBackwards = true;
  expectCode(() => backLane.reconcile(), 'timing_regression_denied');
});

test('invalid injected clocks fail closed before any transport interaction', () => {
  const fixture = dshEnvelope(MUSE_MODEL);
  for (const clock of [() => Number.NaN, () => -1, () => 5e12, () => null]) {
    const transport = fakeDshTransport();
    const driver = createFixtureDriver(MUSE_MODEL, transport, { now: clock });
    expectCode(() => driver.driver.preflight({
      schema: 'codex-co-engineer.driver-preflight.v1', version: 1,
      envelope_text: fixture.envelope_text, child_envelope_digest: fixture.child_envelope_digest,
    }), 'invalid_format');
    assert.equal(transport.counts().configIdentity, 0);
  }
});

test('detail telemetry never carries prompt, question, or event content', () => {
  const transport = fakeDshTransport({
    polls: [{ state: 'needs_attention', question_ref: `q-${LEAK_MARKER}-payload` }],
    eventPages: [(request) => ({
      records: Array.from({ length: request.max_records }, (_, index) => ({
        seq: index + 1, kind: 'text_delta', bytes: DSH_MAX_EVENT_RECORD_BYTES,
      })),
      next_cursor: request.max_records,
      truncated: true,
    })],
  });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  for (const operation of ['reconcile', 'cancel']) {
    const result = operation === 'reconcile'
      ? lane.reconcile({ include: ['detailed_events', 'live_progress'], intent: 'restart_reattach' })
      : lane.cancel();
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(LEAK_MARKER), `${operation} leaked content`);
    if (result.detail_message !== undefined) {
      assert.match(result.detail_message, CONTENT_FREE_DETAIL);
      assert.ok(result.detail_message.length <= 512);
    }
  }
});

test('results echo the exact child identity and arrive detached and frozen', () => {
  const transport = fakeDshTransport({ polls: [{ state: 'completed', stop_reason: 'end_turn' }] });
  const driver = createFixtureDriver(MUSE_MODEL, transport);
  const fixture = dshEnvelope(MUSE_MODEL);
  const lane = dispatchLane(driver.driver, fixture);
  const seen = [lane.preflight, lane.launch, lane.reconcile({ include: ['live_progress'] }), lane.cancel()];
  for (const result of seen) {
    assert.equal(result.run_id, fixture.run_id);
    assert.equal(result.assignment_id, fixture.assignment_id);
    assert.equal(result.lane_index, fixture.lane_index);
    assert.equal(result.base_sha, fixture.base_sha);
    assert.equal(result.child_envelope_digest, fixture.child_envelope_digest);
    assert.ok(Object.isFrozen(result));
  }
});

test('transport validation rejects wrong surfaces and accepts the canonical five', () => {
  assertDshAcpTransportV1(fakeDshTransport().port);
  for (const [label, port] of Object.entries({
    'missing op': (() => { const p = fakeDshTransport().port; delete p.poll; return p; })(),
    'extra op': (() => { const p = fakeDshTransport().port; p.heal = () => {}; return p; })(),
    'non-function op': (() => { const p = fakeDshTransport().port; p.poll = 42; return p; })(),
    'proxy op': (() => { const p = fakeDshTransport().port; p.poll = new Proxy(() => {}, {}); return p; })(),
    'proxy record': new Proxy(fakeDshTransport().port, {}),
    'exotic record': (() => class Weird extends Object { })(),
    null: null,
    array: [],
  })) {
    assert.throws(() => assertDshAcpTransportV1(port),
      (error) => error instanceof RunContractV1Error,
      `transport ${label} must be denied`);
  }
});

test('config identity receipts are validated strictly', () => {
  assert.equal(validateDshConfigIdentityV1(readyIdentity(), MUSE_MODEL).ready, true);
  assert.deepEqual(validateDshConfigIdentityV1({ ready: false }, MUSE_MODEL), {
    ready: false, reason: null,
  });
  expectCode(() => validateDshConfigIdentityV1(readyIdentity(), 'claude-3'), 'dsh_model_denied');
  expectCode(() => validateDshConfigIdentityV1(readyIdentity({ config_path: 'relative/path.yml' }), MUSE_MODEL),
    'invalid_format');
  expectCode(() => validateDshConfigIdentityV1(readyIdentity({ config_sha256: 'SHA256' }), MUSE_MODEL),
    'invalid_format');
  expectCode(() => validateDshConfigIdentityV1(readyIdentity({ credential_source: 'keychain' }), MUSE_MODEL),
    'invalid_format');
  expectCode(() => validateDshConfigIdentityV1(readyIdentity({ ready: true, reason: 'config_unavailable' }), MUSE_MODEL),
    'invalid_format');
  expectCode(() => validateDshConfigIdentityV1({ ready: true, config_path: '/x.yml' }, MUSE_MODEL), 'missing_key');
  expectCode(() => validateDshConfigIdentityV1(readyIdentity({ credential_sha256: undefined }), MUSE_MODEL),
    'own_undefined_denied');
});
