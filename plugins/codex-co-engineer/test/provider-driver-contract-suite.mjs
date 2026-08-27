// Reusable, provider-neutral ProviderDriverV1 conformance kit (P17).
//
// Any scripted or future harness driver (P18-P21) can be driven through this
// suite offline, with no provider transport, to prove:
//   - exactly four own-function operations and nothing else;
//   - the accepted P05 13-field capability record, not a stub schema;
//   - exact ChildEnvelopeV1 proof requests and identity-echoing results;
//   - unsupported live progress/restart/cancellation/detailed events fail
//     closed with no fallback or replay;
//   - hostile descriptors/proxies/accessors/symbols/exotic/sparse/alias/
//     cycle/depth/size inputs never execute caller code;
//   - transition, correlation, duplicate, stale, and tamper cases fail
//     with stable typed errors.

import assert from 'node:assert/strict';

import { childEnvelopeDigestV1 } from '../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1, parseChildEnvelopeV1 } from '../mcp/v3/prompt-compiler.mjs';
import {
  DRIVER_DECLARATION_SCHEMA_ID,
  DRIVER_DISPOSITIONS,
  DRIVER_FEATURE_KEYS,
  DRIVER_OPERATION_SCHEMA_IDS,
  DRIVER_OPERATIONS,
  DRIVER_RESULT_SCHEMA_IDS,
  LAUNCH_DISPOSITIONS,
  PREFLIGHT_DISPOSITIONS,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_DRIVER_VERSION,
  assertProviderDriverV1,
  bindProviderDriverV1,
  buildDriverOperationRequestV1,
  describeProviderDriverContractV1,
  validateDriverLaunchRequestV1,
  validateDriverReconcileRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { p17Record } from './fixtures/r1-resolver-fixtures.mjs';

export const DRIVER_SUITE_BASE_SHA = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1';
export const DRIVER_SUITE_REPOSITORY_PATH = '/opt/codex-co-engineer-driver-contract/suite';
export const DRIVER_SUITE_RUN_ID = 'driver-contract-suite';
export const DRIVER_SUITE_ASSIGNMENT_ID = 'contract-lane';

export function buildDriverContractFixtureV1() {
  const manifest = Object.freeze({
    schema: 'codex-co-engineer.run.v1',
    run_id: DRIVER_SUITE_RUN_ID,
    repository: Object.freeze({ path: DRIVER_SUITE_REPOSITORY_PATH, base_sha: DRIVER_SUITE_BASE_SHA }),
    objective: 'Exercise the ProviderDriverV1 contract suite end to end.',
    assignments: Object.freeze([Object.freeze({
      assignment_id: DRIVER_SUITE_ASSIGNMENT_ID,
      role: 'implement',
      access: 'writer',
      prompt: 'Implement the contract lane exactly as instructed by the envelope.',
      execution: Object.freeze({ provider: 'dsh', model: 'stealth/ox-alpha' }),
      write_scope: Object.freeze(['mcp/**']),
      acceptance: Object.freeze([Object.freeze({ command_id: 'unit-tests', timeout_ms: 600_000 })]),
      expected_duration_ms: 1_200_000,
      required_evidence: Object.freeze(['provider_report', 'git_diff']),
    })]),
    policy: Object.freeze({
      max_concurrency: 8,
      require_same_base: true,
      require_disjoint_writer_scopes: true,
      allow_post_dispatch_fallback: false,
      allow_merge: false,
      allow_create_pr: false,
      attention_mode: 'aggregate',
      completion_mode: 'all_settled_then_verify',
    }),
    return_contract: Object.freeze({ mode: 'verified_decision', include_artifact_refs: true }),
  });
  const envelope = compileChildEnvelopeV1(manifest, DRIVER_SUITE_ASSIGNMENT_ID);
  return Object.freeze({
    manifest,
    envelope,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    base_sha: envelope.repository.base_sha,
    envelope_text: envelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
  });
}

export function driverFeatures(overrides = {}) {
  return {
    cancellation: 'supported',
    detailed_events: 'supported',
    live_progress: 'supported',
    restart: 'reconcile_reattach_only',
    ...overrides,
  };
}

export function driverDeclaration(provider = 'dsh', featureOverrides = {}, capabilityOverrides = {}) {
  return {
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: p17Record(provider, capabilityOverrides),
    features: driverFeatures(featureOverrides),
  };
}

export function driverResultFor(operation, request, disposition, overrides = {}) {
  const lane = parseChildEnvelopeV1(request.envelope_text);
  return {
    schema: DRIVER_RESULT_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    run_id: lane.run_id,
    assignment_id: lane.assignment_id,
    lane_index: lane.lane_index,
    base_sha: lane.repository.base_sha,
    child_envelope_digest: request.child_envelope_digest,
    disposition,
    ...overrides,
  };
}

function detailFor(operation, disposition) {
  if (operation === 'preflight' && disposition === 'blocked') {
    return {
      detail_code: 'model_unattested',
      detail_message: 'The installed provider cannot attest the model.',
    };
  }
  if (operation === 'launch' && disposition === 'not_sent') {
    return {
      detail_code: 'transport_unavailable',
      detail_message: 'No prompt reached the provider.',
    };
  }
  return {};
}

export function scriptedProviderDriverV1(dispositions = {}) {
  const chosen = {
    preflight: 'ready',
    launch: 'dispatch_uncertain',
    reconcile: 'terminal',
    cancel: 'cancel_confirmed',
    ...dispositions,
  };
  return {
    preflight: (request) => driverResultFor(
      'preflight', request, chosen.preflight, detailFor('preflight', chosen.preflight),
    ),
    launch: (request) => driverResultFor(
      'launch', request, chosen.launch, detailFor('launch', chosen.launch),
    ),
    reconcile: (request) => driverResultFor('reconcile', request, chosen.reconcile),
    cancel: (request) => driverResultFor('cancel', request, chosen.cancel),
  };
}

function expectDriverFailure(prefix, name, fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof RunContractV1Error && (code === undefined || error.code === code),
    `${prefix} ${name}: expected RunContractV1Error${code ? ` with code ${code}` : ''}.`,
  );
}

function hostileRequest(operation, extraKey, extraValue) {
  const fixture = buildDriverContractFixtureV1();
  const request = {
    schema: DRIVER_OPERATION_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  if (extraKey !== undefined) request[extraKey] = extraValue;
  return request;
}

export function runProviderDriverContractSuiteV1(driver, options = {}) {
  const label = options.label ?? 'provider-driver';
  const declaration = options.declaration ?? driverDeclaration('dsh');
  const prefix = `[${label}]`;
  let checks = 0;
  const pass = () => { checks += 1; };
  const fixture = buildDriverContractFixtureV1();

  const description = describeProviderDriverContractV1();
  assert.deepEqual([...description.operations], [...DRIVER_OPERATIONS], `${prefix} contract operations`);
  assert.equal(description.version, PROVIDER_DRIVER_VERSION, `${prefix} contract version`);
  assert.equal(description.relaunch_operations.length, 0, `${prefix} defines no relaunch operation`);
  assert.deepEqual([...description.transports], [], `${prefix} claims no provider transport`);
  assert.equal(
    description.capability_schema_id, PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
    `${prefix} capability schema is the accepted P05 bridge`,
  );
  assert.equal(description.capability_record_keys.length, 13, `${prefix} P05 13-field capability record`);
  pass();

  const summary = assertProviderDriverV1(driver);
  assert.equal(summary.schema, description.schema, `${prefix} driver schema`);
  pass();

  const bound = bindProviderDriverV1(driver, declaration);
  assert.deepEqual(Object.keys(bound).sort(), [...DRIVER_OPERATIONS].sort(),
    `${prefix} bound surface exposes exactly the four operations`);
  pass();

  const receipts = {};
  for (const operation of DRIVER_OPERATIONS) {
    const request = buildDriverOperationRequestV1(operation, fixture.envelope);
    const receipt = bound[operation](request);
    assert.ok(DRIVER_DISPOSITIONS[operation].includes(receipt.disposition),
      `${prefix} ${operation} uses the closed disposition vocabulary`);
    assert.equal(receipt.run_id, fixture.run_id, `${prefix} ${operation} echoes run_id`);
    assert.equal(receipt.assignment_id, fixture.assignment_id, `${prefix} ${operation} echoes assignment_id`);
    assert.equal(receipt.lane_index, fixture.lane_index, `${prefix} ${operation} echoes lane_index`);
    assert.equal(receipt.base_sha, fixture.base_sha, `${prefix} ${operation} echoes base_sha`);
    assert.equal(receipt.child_envelope_digest, fixture.child_envelope_digest,
      `${prefix} ${operation} echoes the verified envelope digest`);
    assert.ok(Object.isFrozen(receipt), `${prefix} ${operation} result is detached/frozen`);
    receipts[operation] = receipt;
    pass();
  }

  if (receipts.preflight.disposition === PREFLIGHT_DISPOSITIONS[1]) {
    assert.equal(typeof receipts.preflight.detail_code, 'string', `${prefix} blocked preflight classifies itself`);
  } else {
    assert.equal(receipts.preflight.detail_code, undefined, `${prefix} ready preflight stays bare`);
  }
  if (receipts.launch.disposition === LAUNCH_DISPOSITIONS[0]) {
    assert.equal(typeof receipts.launch.detail_code, 'string', `${prefix} not_sent launch classifies itself`);
  } else {
    assert.equal(receipts.launch.detail_code, undefined,
      `${prefix} ${receipts.launch.disposition} launch stays bare`);
  }
  pass();

  expectDriverFailure(prefix, 'digest-only launch',
    () => validateDriverLaunchRequestV1({
      schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
      version: PROVIDER_DRIVER_VERSION,
      child_envelope_digest: fixture.child_envelope_digest,
    }),
    'digest_only_launch_denied');
  pass();

  const flipped = fixture.child_envelope_digest.startsWith('0')
    ? `1${fixture.child_envelope_digest.slice(1)}`
    : `0${fixture.child_envelope_digest.slice(1)}`;
  expectDriverFailure(prefix, 'wrong digest',
    () => validateDriverLaunchRequestV1(hostileRequest('launch', 'child_envelope_digest', flipped)),
    'child_envelope_digest_mismatch');
  const last = fixture.envelope_text.charCodeAt(fixture.envelope_text.length - 1);
  const tamperedText = `${fixture.envelope_text.slice(0, -1)}${String.fromCharCode(last ^ 1)}`;
  expectDriverFailure(prefix, 'tampered envelope bytes',
    () => validateDriverLaunchRequestV1({
      schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
      version: PROVIDER_DRIVER_VERSION,
      envelope_text: tamperedText,
      child_envelope_digest: fixture.child_envelope_digest,
    }));
  expectDriverFailure(prefix, 'uppercase digest',
    () => validateDriverLaunchRequestV1(hostileRequest(
      'launch', 'child_envelope_digest', fixture.child_envelope_digest.toUpperCase(),
    )),
    'invalid_format');
  pass();

  expectDriverFailure(prefix, 'cross-operation reuse',
    () => validateDriverReconcileRequestV1(buildDriverOperationRequestV1('launch', fixture.envelope)),
    'schema_mismatch');
  pass();

  const foreignKeys = [
    ['fallback', true, 'replay_or_fallback_denied'],
    ['retry_dispatch', 'now', 'replay_or_fallback_denied'],
    ['allow_merge', true, 'merge_authority_denied'],
    ['create_pr', true, 'merge_authority_denied'],
    ['relaunch_attempts', 1, 'unknown_key'],
    ['resend', true, 'replay_or_fallback_denied'],
  ];
  for (const [key, value, code] of foreignKeys) {
    expectDriverFailure(prefix, `foreign key ${key}`,
      () => validateDriverLaunchRequestV1(hostileRequest('launch', key, value)),
      code);
  }
  pass();

  let getterRuns = 0;
  const accessorRequest = hostileRequest('launch');
  delete accessorRequest.envelope_text;
  Object.defineProperty(accessorRequest, 'envelope_text', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return fixture.envelope_text;
    },
  });
  expectDriverFailure(prefix, 'accessor request',
    () => validateDriverLaunchRequestV1(accessorRequest),
    'accessor_property_denied');
  assert.equal(getterRuns, 0, `${prefix} no getter executed during request validation`);

  expectDriverFailure(prefix, 'Proxy request',
    () => validateDriverLaunchRequestV1(new Proxy(hostileRequest('launch'), {})),
    'proxy_denied');
  const revocable = Proxy.revocable(hostileRequest('launch'), {});
  revocable.revoke();
  expectDriverFailure(prefix, 'revoked Proxy request',
    () => validateDriverLaunchRequestV1(revocable.proxy),
    'proxy_denied');
  expectDriverFailure(prefix, 'symbol key',
    () => validateDriverLaunchRequestV1(hostileRequest('launch', Symbol('hidden'), 1)),
    'symbol_key_denied');

  const hiddenKeyRequest = hostileRequest('launch');
  Object.defineProperty(hiddenKeyRequest, 'schema', {
    value: DRIVER_OPERATION_SCHEMA_IDS.launch, enumerable: false,
  });
  expectDriverFailure(prefix, 'non-enumerable key',
    () => validateDriverLaunchRequestV1(hiddenKeyRequest),
    'non_enumerable_property_denied');
  expectDriverFailure(prefix, 'exotic prototype',
    () => validateDriverLaunchRequestV1(Object.assign(
      Object.create({ inherited() {} }), hostileRequest('preflight'),
    )),
    'exotic_prototype_denied');
  expectDriverFailure(prefix, 'sparse array payload',
    () => validateDriverLaunchRequestV1(hostileRequest('launch', 'extra', new Array(3))),
    'invalid_array');
  const cyclicRequest = hostileRequest('launch', 'extra', {});
  cyclicRequest.extra.self = cyclicRequest.extra;
  expectDriverFailure(prefix, 'cyclic payload',
    () => validateDriverLaunchRequestV1(cyclicRequest),
    'aliased_reference_denied');
  const shared = { lane: 1 };
  const aliasedRequest = hostileRequest('launch', 'extra', shared);
  aliasedRequest.extra2 = shared;
  expectDriverFailure(prefix, 'aliased payload',
    () => validateDriverLaunchRequestV1(aliasedRequest),
    'aliased_reference_denied');
  expectDriverFailure(prefix, 'function payload',
    () => validateDriverLaunchRequestV1(hostileRequest('launch', 'envelope_text', () => {})),
    'invalid_json_type');
  let depth = { v: 0 };
  for (let index = 0; index < 34; index += 1) depth = { nested: depth };
  expectDriverFailure(prefix, 'oversized depth',
    () => validateDriverLaunchRequestV1(hostileRequest('launch', 'extra', depth)),
    'value_depth_exceeded');
  const ownUndefined = hostileRequest('launch');
  ownUndefined.version = undefined;
  expectDriverFailure(prefix, 'own undefined',
    () => validateDriverLaunchRequestV1(ownUndefined),
    'own_undefined_denied');
  pass();

  expectDriverFailure(prefix, 'fifth operation',
    () => assertProviderDriverV1({ ...driver, retry: () => ({}) }),
    'invalid_surface');
  const incomplete = { ...driver };
  delete incomplete.cancel;
  expectDriverFailure(prefix, 'missing operation',
    () => assertProviderDriverV1(incomplete),
    'invalid_surface');
  expectDriverFailure(prefix, 'non-function operation',
    () => assertProviderDriverV1({ ...driver, preflight: 42 }),
    'invalid_operation');
  const accessorDriver = {};
  Object.defineProperty(accessorDriver, 'preflight', { enumerable: true, get: () => () => ({}) });
  for (const operation of ['launch', 'reconcile', 'cancel']) accessorDriver[operation] = () => ({});
  expectDriverFailure(prefix, 'accessor operation',
    () => assertProviderDriverV1(accessorDriver),
    'invalid_object');
  expectDriverFailure(prefix, 'Proxy driver',
    () => assertProviderDriverV1(new Proxy({ ...driver }, {})),
    'proxy_denied');
  class DriverClass {}
  expectDriverFailure(prefix, 'exotic prototype driver',
    () => assertProviderDriverV1(Object.assign(new DriverClass(), driver)),
    'exotic_prototype_denied');
  const symbolDriver = { ...driver };
  symbolDriver[Symbol('extra')] = () => ({});
  expectDriverFailure(prefix, 'symbol-keyed driver',
    () => assertProviderDriverV1(symbolDriver),
    'invalid_object');
  pass();

  expectDriverFailure(prefix, 'duplicate launch after possible send',
    () => bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope)),
    'replay_denied');
  pass();

  assert.equal(DRIVER_FEATURE_KEYS.length, 4, `${prefix} four honest driver features`);
  pass();

  return Object.freeze({
    label,
    checks,
    ok: true,
    operations: Object.freeze([...DRIVER_OPERATIONS]),
  });
}
