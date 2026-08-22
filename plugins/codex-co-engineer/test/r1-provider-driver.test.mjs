// Runtime tests for the ProviderDriverV1 closed envelope/capability contract
// (P17): P05 13-field capability alignment, exact ChildEnvelopeV1 proof,
// typed results, honest feature/posture failures, and process-local
// status transitions. No provider transport is configured here.

import assert from 'node:assert/strict';
import test from 'node:test';

import { childEnvelopeDigestV1 } from '../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../mcp/v3/prompt-compiler.mjs';
import {
  CAPABILITY_RECORD_ALLOWED_KEYS,
  DRIVER_DECLARATION_SCHEMA_ID,
  DRIVER_DISPOSITIONS,
  DRIVER_OPERATION_SCHEMA_IDS,
  DRIVER_OPERATIONS,
  DRIVER_REQUEST_KEYS,
  DRIVER_RESULT_KEYS,
  DRIVER_RESULT_REQUIRED_KEYS,
  DRIVER_RESULT_SCHEMA_IDS,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_DRIVER_SCHEMA_ID,
  PROVIDER_DRIVER_VERSION,
  assertCapabilityRequirementV1,
  assertDriverFeatureV1,
  assertProviderDriverV1,
  bindProviderDriverV1,
  buildDriverOperationRequestV1,
  describeProviderDriverContractV1,
  validateDriverCancelRequestV1,
  validateDriverCancelResultV1,
  validateDriverDeclarationV1,
  validateDriverLaunchRequestV1,
  validateDriverLaunchResultV1,
  validateDriverPreflightRequestV1,
  validateDriverPreflightResultV1,
  validateDriverReconcileRequestV1,
  validateDriverReconcileResultV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  DRIVER_SUITE_BASE_SHA,
  DRIVER_SUITE_RUN_ID,
  buildDriverContractFixtureV1,
  driverDeclaration,
  driverResultFor,
  scriptedProviderDriverV1,
} from './provider-driver-contract-suite.mjs';

const fixture = buildDriverContractFixtureV1();
const declaration = driverDeclaration('dsh');

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code, message);
}

function requestFor(operation, overrides = {}) {
  const request = {
    schema: DRIVER_OPERATION_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete request[key];
  }
  return request;
}

function resultFor(operation, disposition, overrides = {}) {
  return driverResultFor(operation, requestFor(operation), disposition, overrides);
}

function detailForPreflight(disposition) {
  return disposition === 'blocked'
    ? { detail_code: 'model_unattested', detail_message: 'Provider cannot attest the requested model.' }
    : {};
}

function detailForLaunch(disposition) {
  return disposition === 'not_sent'
    ? { detail_code: 'transport_unavailable', detail_message: 'No prompt reached the provider.' }
    : {};
}

const REQUEST_VALIDATORS = {
  preflight: validateDriverPreflightRequestV1,
  launch: validateDriverLaunchRequestV1,
  reconcile: validateDriverReconcileRequestV1,
  cancel: validateDriverCancelRequestV1,
};

test('the provider driver contract is closed, versioned, and P05-aligned', () => {
  assert.equal(PROVIDER_DRIVER_VERSION, 1);
  assert.deepEqual([...DRIVER_OPERATIONS], ['preflight', 'launch', 'reconcile', 'cancel']);
  assert.equal(CAPABILITY_RECORD_ALLOWED_KEYS.length, 13);
  assert.equal(DRIVER_REQUEST_KEYS.length, new Set(DRIVER_REQUEST_KEYS).size);
  for (const keySet of [DRIVER_REQUEST_KEYS, DRIVER_RESULT_KEYS, DRIVER_RESULT_REQUIRED_KEYS]) {
    assert.ok(Object.isFrozen(keySet));
  }
  const description = describeProviderDriverContractV1();
  assert.equal(description.schema, PROVIDER_DRIVER_SCHEMA_ID);
  assert.equal(description.capability_schema_id, PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID);
  assert.equal(description.capability_record_keys.length, 13);
  assert.deepEqual(description.relaunch_operations, []);
  assert.deepEqual([...description.transports], []);
  assert.deepEqual(description.dispositions, {
    preflight: [...DRIVER_DISPOSITIONS.preflight],
    launch: [...DRIVER_DISPOSITIONS.launch],
    reconcile: [...DRIVER_DISPOSITIONS.reconcile],
    cancel: [...DRIVER_DISPOSITIONS.cancel],
  });
  assert.deepEqual(describeProviderDriverContractV1(), description);
});

test('driver declarations project the complete P05 13-field capability record', () => {
  const validated = validateDriverDeclarationV1(declaration);
  for (const key of CAPABILITY_RECORD_ALLOWED_KEYS) {
    assert.ok(Object.hasOwn(validated.capability, key), `missing ${key}`);
  }
  assert.equal(validated.capability.schema, PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID);
  assert.equal(validated.capability.provider, 'dsh');
  assert.equal(validated.capability.same_session_reply, 'unsupported_unresolved_attention');
  assert.equal(validated.capability.dispatch_certainty, 'uncertain_after_spawn');
  assert.equal(validated.capability.replay_posture, 'never_replay');
  assert.match(validated.capability.source_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.capability.artifact_kinds));
});

test('four-field capability stubs and cross-field mismatches fail closed', () => {
  const stub = {
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: {
      schema: PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
      provider: 'grok',
      same_session_reply: 'live_session_reply',
      dispatch_certainty: 'confirmed_launch',
      workspace_semantics: 'local_managed_worktree',
    },
    features: declaration.features,
  };
  expectCode(() => validateDriverDeclarationV1(stub), 'invalid_capability_revision');

  expectCode(() => validateDriverDeclarationV1(driverDeclaration('grok', {}, {
    same_session_reply: 'unsupported_unresolved_attention',
  })), 'capability_reply_mismatch');
  expectCode(() => validateDriverDeclarationV1(driverDeclaration('dsh', {}, {
    dispatch_certainty: 'confirmed_launch',
  })), 'capability_dispatch_certainty_mismatch');
});

test('every operation accepts its exact compiled-envelope proof request', () => {
  for (const operation of DRIVER_OPERATIONS) {
    const view = REQUEST_VALIDATORS[operation](requestFor(operation));
    assert.equal(view.operation, operation);
    assert.equal(view.envelope.run_id, DRIVER_SUITE_RUN_ID);
    assert.equal(view.envelope.repository.base_sha, DRIVER_SUITE_BASE_SHA);
    assert.equal(view.child_envelope_digest, fixture.child_envelope_digest);
    assert.match(view.operation_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(Object.isFrozen(view.request));
  }
});

test('requests carry their own operation schema and reject reuse across operations', () => {
  for (const operation of DRIVER_OPERATIONS) {
    for (const [other, validate] of Object.entries(REQUEST_VALIDATORS)) {
      if (other === operation) {
        assert.doesNotThrow(() => validate(requestFor(operation)));
        continue;
      }
      expectCode(() => validate(requestFor(operation)), 'schema_mismatch');
    }
  }
});

test('a digest-only launch is forbidden and other operations still demand bytes', () => {
  expectCode(() => validateDriverLaunchRequestV1({
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    child_envelope_digest: fixture.child_envelope_digest,
  }), 'digest_only_launch_denied');
  expectCode(() => validateDriverReconcileRequestV1({
    schema: DRIVER_OPERATION_SCHEMA_IDS.reconcile,
    version: PROVIDER_DRIVER_VERSION,
    child_envelope_digest: fixture.child_envelope_digest,
  }), 'missing_key');
});

test('results use the closed disposition vocabulary and P05 honesty rules', () => {
  for (const disposition of DRIVER_DISPOSITIONS.preflight) {
    assert.doesNotThrow(() => validateDriverPreflightResultV1(
      resultFor('preflight', disposition, detailForPreflight(disposition)),
      requestFor('preflight'), declaration,
    ));
  }
  for (const disposition of DRIVER_DISPOSITIONS.launch) {
    if (disposition === 'dispatched') {
      expectCode(() => validateDriverLaunchResultV1(
        resultFor('launch', disposition, detailForLaunch(disposition)),
        requestFor('launch'), declaration,
      ), 'capability_dispatch_certainty_mismatch');
      continue;
    }
    assert.doesNotThrow(() => validateDriverLaunchResultV1(
      resultFor('launch', disposition, detailForLaunch(disposition)),
      requestFor('launch'), declaration,
    ));
  }
  const grok = driverDeclaration('grok');
  const grokEnvelope = compileChildEnvelopeV1({
    ...fixture.manifest,
    assignments: [{
      ...fixture.manifest.assignments[0],
      execution: { provider: 'grok', model: 'grok-4' },
    }],
  }, fixture.assignment_id);
  const grokRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: grokEnvelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(grokEnvelope).digest,
  };
  assert.doesNotThrow(() => validateDriverLaunchResultV1(
    driverResultFor('launch', grokRequest, 'dispatched'), grokRequest, grok,
  ));
  expectCode(() => validateDriverReconcileResultV1(
    resultFor('reconcile', 'settled'), requestFor('reconcile'), declaration,
  ), 'invalid_format');
});

test('bounded detail pairs follow the per-disposition rules', () => {
  expectCode(() => validateDriverPreflightResultV1(
    resultFor('preflight', 'blocked'), requestFor('preflight'), declaration,
  ), 'missing_key');
  expectCode(() => validateDriverPreflightResultV1(
    resultFor('preflight', 'ready', { detail_code: 'why', detail_message: 'no' }),
    requestFor('preflight'), declaration,
  ), 'detail_pair_denied');
  expectCode(() => validateDriverLaunchResultV1(
    resultFor('launch', 'not_sent'), requestFor('launch'), declaration,
  ), 'missing_key');
  expectCode(() => validateDriverLaunchResultV1(
    resultFor('launch', 'dispatch_uncertain', { detail_code: 'why', detail_message: 'no' }),
    requestFor('launch'), declaration,
  ), 'detail_pair_denied');
});

test('results must echo the exact child identity proven by the request', () => {
  for (const override of [
    { run_id: 'other-run' },
    { assignment_id: 'other-lane' },
    { lane_index: 1 },
    { base_sha: 'ffffffffffffffffffffffffffffffffffffffff' },
  ]) {
    expectCode(() => validateDriverLaunchResultV1(
      resultFor('launch', 'dispatch_uncertain', override), requestFor('launch'), declaration,
    ), 'receipt_identity_mismatch');
  }
});

test('the bound surface enforces preflight, no-replay, and feature gates', () => {
  const bound = bindProviderDriverV1(scriptedProviderDriverV1(), declaration);
  expectCode(() => bound.launch(requestFor('launch')), 'not_preflighted');
  assert.equal(bound.preflight(requestFor('preflight')).disposition, 'ready');
  assert.equal(bound.launch(requestFor('launch')).disposition, 'dispatch_uncertain');
  expectCode(() => bound.launch(requestFor('launch')), 'replay_denied');
  assert.equal(bound.reconcile(requestFor('reconcile')).disposition, 'terminal');
  assert.equal(bound.cancel(requestFor('cancel')).disposition, 'cancel_confirmed');
});

test('blocked preflight cannot launch and not_sent cannot be reconciled', () => {
  const blocked = bindProviderDriverV1(scriptedProviderDriverV1({ preflight: 'blocked' }), declaration);
  assert.equal(blocked.preflight(requestFor('preflight')).disposition, 'blocked');
  expectCode(() => blocked.launch(requestFor('launch')), 'blocked_lane_denied');

  const notSent = bindProviderDriverV1(
    scriptedProviderDriverV1({ launch: 'not_sent' }), declaration,
  );
  notSent.preflight(requestFor('preflight'));
  assert.equal(notSent.launch(requestFor('launch')).disposition, 'not_sent');
  expectCode(() => notSent.reconcile(requestFor('reconcile')), 'not_dispatched');
  notSent.preflight(requestFor('preflight'));
  assert.equal(notSent.launch(requestFor('launch')).disposition, 'not_sent');
});

test('unsupported cancellation, restart, live progress, and events fail closed', () => {
  const unsupported = driverDeclaration('dsh', {
    cancellation: 'unsupported',
    detailed_events: 'unsupported',
    live_progress: 'unsupported',
    restart: 'unsupported',
  });
  const bound = bindProviderDriverV1(scriptedProviderDriverV1(), unsupported);
  bound.preflight(requestFor('preflight'));
  bound.launch(requestFor('launch'));
  expectCode(() => bound.cancel(requestFor('cancel')), 'unsupported_capability');
  expectCode(() => bound.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })),
    'unsupported_capability');
  expectCode(() => bound.reconcile(requestFor('reconcile', { include: ['live_progress'] })),
    'unsupported_capability');
  expectCode(() => bound.reconcile(requestFor('reconcile', { include: ['detailed_events'] })),
    'unsupported_capability');
  expectCode(() => assertDriverFeatureV1(unsupported, 'live_progress'), 'unsupported_capability');
});

test('supported restart_reattach is reconcile-only and never a relaunch', () => {
  const bound = bindProviderDriverV1(scriptedProviderDriverV1(), declaration);
  bound.preflight(requestFor('preflight'));
  bound.launch(requestFor('launch'));
  const receipt = bound.reconcile(requestFor('reconcile', { intent: 'restart_reattach' }));
  assert.equal(receipt.disposition, 'terminal');
  expectCode(() => bound.launch(requestFor('launch')), 'replay_denied');
});

test('P05 capability requirements fail closed without fallback', () => {
  expectCode(() => assertCapabilityRequirementV1(declaration, {
    same_session_reply: 'live_session_reply',
  }), 'capability_reply_mismatch');
  expectCode(() => assertCapabilityRequirementV1(declaration, {
    dispatch_certainty: 'confirmed_launch',
  }), 'capability_dispatch_certainty_mismatch');
  const capability = assertCapabilityRequirementV1(declaration, {
    replay_posture: 'never_replay',
    same_session_reply: 'unsupported_unresolved_attention',
  });
  assert.equal(capability.provider, 'dsh');
});

test('handlers are captured at bind time so later mutation cannot swap an operation', () => {
  const driver = scriptedProviderDriverV1();
  const bound = bindProviderDriverV1(driver, declaration);
  driver.launch = () => {
    throw new Error('a swapped handler must never run');
  };
  bound.preflight(requestFor('preflight'));
  assert.equal(bound.launch(requestFor('launch')).disposition, 'dispatch_uncertain');
  assert.ok(Object.isFrozen(bound));
});

test('buildDriverOperationRequestV1 packages only proven envelope pairs', () => {
  for (const operation of DRIVER_OPERATIONS) {
    const request = buildDriverOperationRequestV1(operation, fixture.envelope);
    assert.equal(request.schema, DRIVER_OPERATION_SCHEMA_IDS[operation]);
    assert.equal(request.child_envelope_digest, fixture.child_envelope_digest);
    assert.ok(Object.isFrozen(request));
  }
  expectCode(() => buildDriverOperationRequestV1('relaunch', fixture.envelope), 'unknown_operation');
  const tamperedEnvelope = JSON.parse(JSON.stringify(fixture.envelope));
  tamperedEnvelope.write_scope.push('extra/**');
  expectCode(() => buildDriverOperationRequestV1('launch', tamperedEnvelope), 'envelope_shape_mismatch');
});

test('stale envelope correlation and provider slot mismatch fail closed', () => {
  const bound = bindProviderDriverV1(scriptedProviderDriverV1(), declaration);
  bound.preflight(requestFor('preflight'));
  bound.launch(requestFor('launch'));
  const otherEnvelope = compileChildEnvelopeV1({
    ...fixture.manifest,
    assignments: [{
      ...fixture.manifest.assignments[0],
      prompt: 'A different prompt for the same lane identity.',
    }],
  }, fixture.assignment_id);
  const otherRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.reconcile,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: otherEnvelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(otherEnvelope).digest,
  };
  expectCode(() => bound.reconcile(otherRequest), 'stale_identity_denied');
  expectCode(
    () => bindProviderDriverV1(scriptedProviderDriverV1(), driverDeclaration('grok'))
      .preflight(requestFor('preflight')),
    'provider_slot_mismatch',
  );
});

test('driver shape validation accepts exactly the four own-function operations', () => {
  const driver = scriptedProviderDriverV1();
  const summary = assertProviderDriverV1(driver);
  assert.deepEqual(summary.operations, [...DRIVER_OPERATIONS]);
  expectCode(() => assertProviderDriverV1({ ...driver, retry: () => ({}) }), 'invalid_surface');
  expectCode(() => validateDriverCancelResultV1(
    resultFor('cancel', 'cancel_confirmed', { schema: DRIVER_RESULT_SCHEMA_IDS.reconcile }),
    requestFor('cancel'), declaration,
  ), 'schema_mismatch');
});
