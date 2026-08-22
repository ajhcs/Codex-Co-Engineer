// Runtime tests for the P18 Grok ACP ProviderDriverV1 adapter: injected
// transport sequences for pre-spawn failure vs post-spawn uncertainty,
// acknowledgement, duplicate launch, attention/reply identity, cancellation
// races, restart reattach, and event/cursor bounds. This is not live Grok
// ACP qualification.

import assert from 'node:assert/strict';
import test from 'node:test';

import { childEnvelopeDigestV1 } from '../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../mcp/v3/prompt-compiler.mjs';
import {
  DRIVER_OPERATION_SCHEMA_IDS,
  DRIVER_RESULT_KEYS,
  PROVIDER_DRIVER_VERSION,
  buildDriverOperationRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import {
  GROK_ACP_AGENT,
  GROK_PROVIDER_SLOT,
  MAX_GROK_ACP_EVENT_PAGE,
  bindGrokAcpDriverV1,
  createGrokAcpDriverV1,
  describeGrokAcpAdapterSurfaceV1,
  grokAcpDriverDeclarationV1,
  inspectGrokAcpLaneEvidenceV1,
} from '../mcp/v3/grok-acp-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  GROK_FIXTURE_MODEL,
  GROK_FIXTURE_SESSION_ID,
  buildGrokDriverFixtureV1,
  createScriptedGrokAcpTransportV1,
  grokAcpCallsOf,
} from './fixtures/r1-grok-acp-transport.mjs';
import { driverDeclaration } from './provider-driver-contract-suite.mjs';

const fixture = buildGrokDriverFixtureV1();

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code, message);
}

function requestFor(operation, extras = {}) {
  return buildDriverOperationRequestV1(operation, fixture.envelope, extras);
}

function launchReady(transport = createScriptedGrokAcpTransportV1()) {
  const driver = bindGrokAcpDriverV1(transport);
  assert.equal(driver.preflight(requestFor('preflight')).disposition, 'ready');
  return { driver, transport };
}

function identityReceipt(extra = {}) {
  return {
    session_id: GROK_FIXTURE_SESSION_ID,
    provider: 'grok',
    model: GROK_FIXTURE_MODEL,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    lane_index: fixture.lane_index,
    base_sha: fixture.base_sha,
    child_envelope_digest: fixture.child_envelope_digest,
    ...extra,
  };
}

function transportCounts(transport) {
  return {
    preflight: grokAcpCallsOf(transport, 'preflight').length,
    spawn: grokAcpCallsOf(transport, 'spawn').length,
    dispatch: grokAcpCallsOf(transport, 'dispatch').length,
    observe: grokAcpCallsOf(transport, 'observe').length,
    cancel: grokAcpCallsOf(transport, 'cancel').length,
    reattach: grokAcpCallsOf(transport, 'reattach').length,
  };
}

function assertLatchedTerminalOrDenial(action) {
  try {
    const receipt = action();
    assert.equal(receipt.disposition, 'terminal');
    assert.notEqual(receipt.disposition, 'in_progress');
    assert.notEqual(receipt.disposition, 'dispatch_uncertain');
    assert.notEqual(receipt.disposition, 'unresolved_attention');
    return receipt;
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error);
    assert.equal(error.code, 'terminal_regression_denied');
    assert.notEqual(error.code, 'in_progress');
    return undefined;
  }
}

test('the Grok adapter hard-binds grok, the P05/P17 capability record, and managed worktree semantics', () => {
  const declaration = grokAcpDriverDeclarationV1();
  assert.equal(declaration.capability.provider, GROK_PROVIDER_SLOT);
  assert.equal(declaration.capability.dispatch_certainty, 'confirmed_launch');
  assert.equal(declaration.capability.same_session_reply, 'live_session_reply');
  assert.equal(declaration.capability.workspace_semantics, 'local_managed_worktree');
  assert.equal(declaration.capability.workspace_starting_point, 'run_base_sha');
  assert.equal(declaration.capability.merge_authority, 'none_codex_only_integration');
  assert.equal(declaration.capability.create_pr_posture, 'prohibited');
  assert.equal(declaration.capability.replay_posture, 'never_replay');
  assert.equal(declaration.capability.exact_model_selection, 'exact_and_attested');
  assert.deepEqual([...declaration.capability.artifact_kinds], ['event_segment', 'git_diff', 'provider_report']);
  assert.equal(declaration.features.cancellation, 'supported');
  assert.equal(declaration.features.detailed_events, 'supported');
  assert.equal(declaration.features.live_progress, 'supported');
  assert.equal(declaration.features.restart, 'reconcile_reattach_only');
  assert.match(declaration.capability.source_digest, /^sha256:[0-9a-f]{64}$/u);

  const surface = describeGrokAcpAdapterSurfaceV1();
  assert.equal(surface.provider, 'grok');
  assert.equal(surface.agent, GROK_ACP_AGENT);
  assert.equal(surface.live_qualification, false);
  assert.equal(surface.durable_store, false);
  assert.equal(surface.supervisor_cutover, false);
  assert.equal(surface.confirmation_rule, 'launch_dispatched_only_after_authoritative_acp_ack');
  assert.ok(surface.later_real_grok_acp_route.dispatch.includes('ChildEnvelopeV1'));
  assert.ok(surface.later_real_grok_acp_route.forbidden.includes('post_spawn_retry'));
  assert.ok(Object.isFrozen(surface));
  assert.ok(Object.isFrozen(surface.later_real_grok_acp_route));
});

test('preflight ready then authoritative acknowledgement yields dispatched', () => {
  const { driver, transport } = launchReady();
  const receipt = driver.launch(requestFor('launch'));
  assert.equal(receipt.disposition, 'dispatched');
  assert.equal(receipt.run_id, fixture.run_id);
  assert.equal(receipt.assignment_id, fixture.assignment_id);
  assert.equal(receipt.lane_index, fixture.lane_index);
  assert.equal(receipt.base_sha, fixture.base_sha);
  assert.equal(receipt.child_envelope_digest, fixture.child_envelope_digest);
  assert.equal(receipt.detail_code, undefined);
  for (const key of Object.keys(receipt)) {
    assert.ok(DRIVER_RESULT_KEYS.includes(key), `unexpected result key ${key}`);
  }
  const spawn = grokAcpCallsOf(transport, 'spawn')[0].request;
  const dispatch = grokAcpCallsOf(transport, 'dispatch')[0].request;
  assert.equal(spawn.provider, 'grok');
  assert.equal(spawn.model, GROK_FIXTURE_MODEL);
  assert.equal(spawn.envelope_text, undefined);
  assert.equal(dispatch.envelope_text, fixture.envelope_text);
  assert.equal(dispatch.model, GROK_FIXTURE_MODEL);
  assert.equal(dispatch.session_id, GROK_FIXTURE_SESSION_ID);
});

test('pre-spawn failure is not_sent and never calls dispatch', () => {
  const transport = createScriptedGrokAcpTransportV1({
    spawn: { throw: { code: 'spawn_failed', message: 'binary missing' } },
  });
  const { driver } = launchReady(transport);
  const receipt = driver.launch(requestFor('launch'));
  assert.equal(receipt.disposition, 'not_sent');
  assert.equal(receipt.detail_code, 'spawn_failed');
  assert.equal(typeof receipt.detail_message, 'string');
  assert.doesNotMatch(receipt.detail_message, /Implement the Grok ACP lane/u);
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 0);
  const retry = driver.launch(requestFor('launch'));
  assert.equal(retry.disposition, 'not_sent');
  assert.equal(grokAcpCallsOf(transport, 'spawn').length, 2);
});

test('post-spawn timeout, exception, and loss are dispatch_uncertain and never retried', () => {
  for (const script of [
    { dispatch: { throw: { code: 'transport_timeout', message: 'ack timed out' } } },
    { dispatch: { throw: { code: 'transport_exception', message: 'stdio reset' } } },
    { dispatch: { throw: { code: 'transport_lost', spawned: true, message: 'child vanished' } } },
    { spawn: { throw: { code: 'transport_lost', spawned: true, message: 'lost after pid' } } },
    { dispatch: { acknowledged: false, session_id: GROK_FIXTURE_SESSION_ID, request_id: 'x',
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest } },
  ]) {
    const transport = createScriptedGrokAcpTransportV1(script);
    const { driver } = launchReady(transport);
    const receipt = driver.launch(requestFor('launch'));
    assert.equal(receipt.disposition, 'dispatch_uncertain', JSON.stringify(script));
    assert.equal(receipt.detail_code, undefined);
    expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
    assert.equal(grokAcpCallsOf(transport, 'dispatch').length <= 1, true);
  }
});

test('duplicate launch after acknowledgement is replay_denied and does not resend', () => {
  const { driver, transport } = launchReady();
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
});

test('same-session attention identity reconciles to unresolved_attention', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'needs_attention',
      session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok',
      model: GROK_FIXTURE_MODEL,
      run_id: fixture.run_id,
      assignment_id: fixture.assignment_id,
      lane_index: fixture.lane_index,
      base_sha: fixture.base_sha,
      child_envelope_digest: fixture.child_envelope_digest,
      attention: { session_id: GROK_FIXTURE_SESSION_ID, question_id: 'q-permission-1' },
    },
  });
  const { driver } = launchReady(transport);
  driver.launch(requestFor('launch'));
  const receipt = driver.reconcile(requestFor('reconcile'));
  assert.equal(receipt.disposition, 'unresolved_attention');
  const evidence = inspectGrokAcpLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(evidence.attention.session_id, GROK_FIXTURE_SESSION_ID);
  assert.equal(evidence.attention.question_id, 'q-permission-1');
  assert.equal(Object.hasOwn(receipt, 'attention'), false);
});

test('cross-session attention identity fails closed', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'needs_attention',
      session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok',
      model: GROK_FIXTURE_MODEL,
      run_id: fixture.run_id,
      assignment_id: fixture.assignment_id,
      lane_index: fixture.lane_index,
      base_sha: fixture.base_sha,
      child_envelope_digest: fixture.child_envelope_digest,
      attention: { session_id: 'sess-other', question_id: 'q-1' },
    },
  });
  const { driver } = launchReady(transport);
  driver.launch(requestFor('launch'));
  expectCode(() => driver.reconcile(requestFor('reconcile')), 'stale_identity_denied');
});

test('cancellation races: confirmed vs already-terminal vs requested', () => {
  const confirmed = launchReady(createScriptedGrokAcpTransportV1({
    cancel: { outcome: 'cancel_confirmed', session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest },
  }));
  confirmed.driver.launch(requestFor('launch'));
  assert.equal(confirmed.driver.cancel(requestFor('cancel')).disposition, 'cancel_confirmed');

  const requested = launchReady(createScriptedGrokAcpTransportV1({
    cancel: { outcome: 'cancel_requested', session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest },
  }));
  requested.driver.launch(requestFor('launch'));
  assert.equal(requested.driver.cancel(requestFor('cancel')).disposition, 'cancel_requested');

  const raced = launchReady(createScriptedGrokAcpTransportV1({
    observe: {
      status: 'completed',
      session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest,
    },
    cancel: { outcome: 'already_terminal', session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest },
  }));
  raced.driver.launch(requestFor('launch'));
  assert.equal(raced.driver.reconcile(requestFor('reconcile')).disposition, 'terminal');
  assert.equal(raced.driver.cancel(requestFor('cancel')).disposition, 'already_terminal');
  assert.equal(grokAcpCallsOf(raced.transport, 'cancel').length, 0);
});

test('restart reattach resumes the exact session and never relaunches', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'running',
      session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest,
    },
  });
  const { driver } = launchReady(transport);
  driver.launch(requestFor('launch'));
  const receipt = driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' }));
  assert.equal(receipt.disposition, 'in_progress');
  assert.equal(grokAcpCallsOf(transport, 'reattach').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
  const reattach = grokAcpCallsOf(transport, 'reattach')[0].request;
  assert.equal(reattach.session_id, GROK_FIXTURE_SESSION_ID);
  assert.equal(reattach.envelope_text, undefined);
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
});

test('event pages and cursors are capped; envelope bytes stay off the result and telemetry', () => {
  const events = Array.from({ length: MAX_GROK_ACP_EVENT_PAGE + 8 }, (_, index) => ({
    type: 'text_delta',
    text: `chunk-${index}-${'x'.repeat(80)}`,
  }));
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'running',
      session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest,
      events,
      cursor: '42',
      event_count: events.length,
      elapsed_ms: 1500,
    },
  });
  const { driver } = launchReady(transport);
  const launched = driver.launch(requestFor('launch'));
  assert.equal(launched.disposition, 'dispatched');
  const receipt = driver.reconcile(requestFor('reconcile', {
    include: ['detailed_events', 'live_progress'],
  }));
  assert.equal(receipt.disposition, 'in_progress');
  assert.equal(receipt.detail_message, undefined);
  assert.equal(JSON.stringify(receipt).includes(fixture.envelope_text), false);
  const evidence = inspectGrokAcpLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.ok(evidence.events.length <= MAX_GROK_ACP_EVENT_PAGE);
  assert.equal(evidence.evidence_truncated, true);
  assert.equal(evidence.cursor, '42');
  assert.equal(evidence.progress.elapsed_ms, 1500);
  const observe = grokAcpCallsOf(transport, 'observe')[0].request;
  assert.equal(observe.envelope_text, undefined);
  assert.equal(observe.prompt, undefined);
});

test('preflight and cancel transport requests never carry envelope text', () => {
  const { driver, transport } = launchReady();
  driver.launch(requestFor('launch'));
  driver.cancel(requestFor('cancel'));
  for (const operation of ['preflight', 'spawn', 'observe', 'cancel']) {
    for (const call of grokAcpCallsOf(transport, operation)) {
      assert.equal(call.request.envelope_text, undefined, `${operation} leaked envelope_text`);
    }
  }
});

test('cross-provider and cross-model envelopes fail closed with no substitution', () => {
  const dshEnvelope = compileChildEnvelopeV1({
    ...fixture.manifest,
    assignments: [{
      ...fixture.manifest.assignments[0],
      execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
    }],
  }, fixture.assignment_id);
  const { driver } = launchReady();
  expectCode(() => driver.preflight({
    schema: DRIVER_OPERATION_SCHEMA_IDS.preflight,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: dshEnvelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(dshEnvelope).digest,
  }), 'provider_slot_mismatch');

  const otherModel = compileChildEnvelopeV1({
    ...fixture.manifest,
    assignments: [{
      ...fixture.manifest.assignments[0],
      execution: { provider: 'grok', model: 'grok-code-fast-1' },
    }],
  }, fixture.assignment_id);
  const otherDriver = bindGrokAcpDriverV1(createScriptedGrokAcpTransportV1());
  const otherRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.preflight,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: otherModel.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(otherModel).digest,
  };
  assert.equal(otherDriver.preflight(otherRequest).disposition, 'ready');
  assert.equal(
    grokAcpCallsOf(createScriptedGrokAcpTransportV1(), 'dispatch').length,
    0,
  );
});

test('digest-only, direct-mode, merge, and fallback keys fail closed', () => {
  expectCode(() => createGrokAcpDriverV1(createScriptedGrokAcpTransportV1()).launch({
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    child_envelope_digest: fixture.child_envelope_digest,
  }), 'digest_only_launch_denied');
  const { driver } = launchReady();
  for (const [key, value, code] of [
    ['fallback', true, 'replay_or_fallback_denied'],
    ['resend', true, 'replay_or_fallback_denied'],
    ['retry_dispatch', 1, 'replay_or_fallback_denied'],
    ['create_pr', true, 'merge_authority_denied'],
    ['allow_merge', true, 'merge_authority_denied'],
    ['workspace_mode', 'direct', 'direct_mode_rejected'],
    ['direct_mode', true, 'direct_mode_rejected'],
  ]) {
    expectCode(() => driver.preflight({
      schema: DRIVER_OPERATION_SCHEMA_IDS.preflight,
      version: PROVIDER_DRIVER_VERSION,
      envelope_text: fixture.envelope_text,
      child_envelope_digest: fixture.child_envelope_digest,
      [key]: value,
    }), code);
  }
});

test('unbound adapter still refuses post-spawn replay', () => {
  const transport = createScriptedGrokAcpTransportV1();
  const driver = createGrokAcpDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
});

test('completed then hostile running stays latched terminal or typed denial', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: [
      identityReceipt({ status: 'completed' }),
      identityReceipt({ status: 'running' }),
    ],
  });
  const { driver } = launchReady(transport);
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
  assert.equal(driver.reconcile(requestFor('reconcile')).disposition, 'terminal');
  const observeAfterLatch = grokAcpCallsOf(transport, 'observe').length;
  assert.equal(observeAfterLatch, 1);
  assertLatchedTerminalOrDenial(() => driver.reconcile(requestFor('reconcile')));
  const counts = transportCounts(transport);
  assert.ok(counts.observe <= observeAfterLatch + 1, 'observe-call count must stay bounded');
  assert.notEqual(counts.observe, Infinity);
  assert.equal(counts.spawn, 1);
  assert.equal(counts.dispatch, 1);
  assert.equal(counts.cancel, 0);
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(transportCounts(transport).spawn, 1);
  assert.equal(transportCounts(transport).dispatch, 1);
});

test('two cancels after cancel_confirmed confirm once then already_terminal', () => {
  const transport = createScriptedGrokAcpTransportV1({
    cancel: identityReceipt({ outcome: 'cancel_confirmed' }),
  });
  const { driver } = launchReady(transport);
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
  assert.equal(driver.cancel(requestFor('cancel')).disposition, 'cancel_confirmed');
  assert.equal(driver.cancel(requestFor('cancel')).disposition, 'already_terminal');
  assert.equal(grokAcpCallsOf(transport, 'cancel').length, 1);
  assert.equal(transportCounts(transport).spawn, 1);
  assert.equal(transportCounts(transport).dispatch, 1);
});

test('terminal source variants latch without extra observe/cancel/spawn/dispatch', () => {
  const sources = [
    { label: 'completed', observe: identityReceipt({ status: 'completed' }) },
    { label: 'failed', observe: identityReceipt({ status: 'failed' }) },
    { label: 'cancelled', observe: identityReceipt({ status: 'cancelled' }) },
    { label: 'cancel_confirmed', cancel: identityReceipt({ outcome: 'cancel_confirmed' }) },
    { label: 'already_terminal', cancel: identityReceipt({ outcome: 'already_terminal' }) },
  ];
  for (const source of sources) {
    const transport = createScriptedGrokAcpTransportV1({
      observe: source.observe ?? identityReceipt({ status: 'running' }),
      cancel: source.cancel ?? identityReceipt({ outcome: 'cancel_confirmed' }),
    });
    const { driver } = launchReady(transport);
    assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched', source.label);
    if (source.observe) {
      assert.equal(driver.reconcile(requestFor('reconcile')).disposition, 'terminal', source.label);
    } else {
      const expected = source.cancel.outcome;
      assert.equal(driver.cancel(requestFor('cancel')).disposition, expected, source.label);
    }
    const afterLatch = transportCounts(transport);
    assert.equal(afterLatch.spawn, 1, source.label);
    assert.equal(afterLatch.dispatch, 1, source.label);
    if (source.cancel) assert.equal(afterLatch.cancel, 1, source.label);
    if (source.observe) assert.equal(afterLatch.observe, 1, source.label);

    assert.equal(driver.cancel(requestFor('cancel')).disposition, 'already_terminal', source.label);
    assert.equal(transportCounts(transport).cancel, afterLatch.cancel, `${source.label} extra cancel`);

    assertLatchedTerminalOrDenial(() => driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })));
    const afterReconcile = transportCounts(transport);
    assert.ok(afterReconcile.observe <= afterLatch.observe + 1, `${source.label} extra observe`);
    assert.equal(afterReconcile.spawn, 1, `${source.label} extra spawn`);
    assert.equal(afterReconcile.dispatch, 1, `${source.label} extra dispatch`);
    assert.equal(afterReconcile.cancel, afterLatch.cancel, `${source.label} extra cancel after reconcile`);
    assert.equal(afterReconcile.reattach, afterLatch.reattach, `${source.label} extra reattach`);

    expectCode(() => driver.launch(requestFor('launch')), 'replay_denied', source.label);
    expectCode(() => driver.preflight(requestFor('preflight')), 'invalid_transition', source.label);
    assert.equal(transportCounts(transport).spawn, 1, source.label);
    assert.equal(transportCounts(transport).dispatch, 1, source.label);
    assert.equal(transportCounts(transport).preflight, 1, source.label);
  }
});

test('cancel_requested stays nonterminal and a later cancel may still reach transport', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: identityReceipt({ status: 'running' }),
    cancel: [
      identityReceipt({ outcome: 'cancel_requested' }),
      identityReceipt({ outcome: 'cancel_confirmed' }),
    ],
  });
  const { driver } = launchReady(transport);
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
  assert.equal(driver.cancel(requestFor('cancel')).disposition, 'cancel_requested');
  assert.equal(driver.reconcile(requestFor('reconcile')).disposition, 'in_progress');
  assert.equal(driver.cancel(requestFor('cancel')).disposition, 'cancel_confirmed');
  assert.equal(grokAcpCallsOf(transport, 'cancel').length, 2);
  assert.equal(driver.cancel(requestFor('cancel')).disposition, 'already_terminal');
  assert.equal(grokAcpCallsOf(transport, 'cancel').length, 2);
});

test('unbound launch then cancel(already_terminal) then preflight cannot resend', () => {
  const transport = createScriptedGrokAcpTransportV1({
    cancel: {
      outcome: 'already_terminal',
      session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok',
      model: GROK_FIXTURE_MODEL,
      run_id: fixture.run_id,
      assignment_id: fixture.assignment_id,
      lane_index: fixture.lane_index,
      base_sha: fixture.base_sha,
      child_envelope_digest: fixture.child_envelope_digest,
    },
  });
  const driver = createGrokAcpDriverV1(transport);
  assert.equal(driver.preflight(requestFor('preflight')).disposition, 'ready');
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
  assert.equal(driver.cancel(requestFor('cancel')).disposition, 'already_terminal');
  expectCode(() => driver.preflight(requestFor('preflight')), 'invalid_transition');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(grokAcpCallsOf(transport, 'preflight').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'spawn').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
});

test('lost observe after uncertain launch stays dispatch_uncertain', () => {
  const transport = createScriptedGrokAcpTransportV1({
    dispatch: { throw: { code: 'transport_timeout' } },
    observe: {
      status: 'lost',
      session_id: GROK_FIXTURE_SESSION_ID,
      provider: 'grok', model: GROK_FIXTURE_MODEL, run_id: fixture.run_id,
      assignment_id: fixture.assignment_id, lane_index: fixture.lane_index,
      base_sha: fixture.base_sha, child_envelope_digest: fixture.child_envelope_digest,
    },
  });
  const { driver } = launchReady(transport);
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatch_uncertain');
  assert.equal(driver.reconcile(requestFor('reconcile')).disposition, 'dispatch_uncertain');
});

test('the grok declaration is not a dsh or cloud stub', () => {
  const grok = grokAcpDriverDeclarationV1();
  const dsh = driverDeclaration('dsh');
  assert.notEqual(grok.capability.dispatch_certainty, dsh.capability.dispatch_certainty);
  assert.notEqual(grok.capability.same_session_reply, dsh.capability.same_session_reply);
  assert.equal(grok.capability.create_pr_posture, 'prohibited');
});
