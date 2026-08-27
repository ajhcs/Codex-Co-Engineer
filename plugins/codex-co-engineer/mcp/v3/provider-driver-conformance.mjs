// Reusable ProviderDriverV1 future-harness conformance kit (P22).
//
// Future adapters import this runner with their own driver. It is
// deterministic, inert, and captured-intrinsic: no ambient network, clocks,
// random IDs, credentials, or processes. Passing this kit does not qualify a
// live transport.

import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';

import {
  capturedFreeze,
  capturedIncludes,
  capturedTest,
} from './grammar.mjs';
import {
  DRIVER_FEATURE_KEYS,
  DRIVER_OPERATION_SCHEMA_IDS,
  DRIVER_OPERATIONS,
  DRIVER_RESULT_KEYS,
  LAUNCH_DISPOSITIONS,
  PREFLIGHT_DISPOSITIONS,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_DRIVER_VERSION,
  assertProviderDriverV1,
  bindProviderDriverV1,
  buildDriverOperationRequestV1,
  describeProviderDriverContractV1,
  validateDriverDeclarationV1,
  validateDriverLaunchRequestV1,
} from './provider-driver.mjs';
import { RunContractV1Error } from './run-manifest.mjs';
import { freezeData, hasOwn } from './selection-json.mjs';

export const FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID = 'codex-co-engineer.future-harness-conformance.v1';
export const FUTURE_HARNESS_CONFORMANCE_VERSION = 1;

export const FUTURE_HARNESS_LEAK_PATTERN = new RegExp(
  [
    'api[_-]?key',
    'password',
    'passphrase',
    'private[_-]?key',
    'secret',
    'bearer\\s+[a-z0-9._+/-]+=*',
    '(?:sk|xai)-[a-z0-9_-]{8,}',
    '/home/',
    '/opt/',
    '/tmp/',
    '/var/',
    '[a-z]:\\\\',
  ].join('|'),
  'iu',
);

const FOREIGN_LAUNCH_KEYS = capturedFreeze([
  capturedFreeze(['fallback', true, 'replay_or_fallback_denied']),
  capturedFreeze(['retry_dispatch', 'now', 'replay_or_fallback_denied']),
  capturedFreeze(['allow_merge', true, 'merge_authority_denied']),
  capturedFreeze(['create_pr', true, 'merge_authority_denied']),
  capturedFreeze(['auto_create_pr', true, 'merge_authority_denied']),
  capturedFreeze(['push', true, 'merge_authority_denied']),
  capturedFreeze(['resend', true, 'replay_or_fallback_denied']),
  capturedFreeze(['credentials', { token: true }, 'credential_content_denied']),
]);

const IS_PROXY = utilTypes.isProxy;

function expectDriverFailure(prefix, name, fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof RunContractV1Error && (code === undefined || error.code === code),
    `${prefix} ${name}: expected RunContractV1Error${code ? ` with code ${code}` : ''}.`,
  );
}

export function assertFutureHarnessContentFreeV1(value, path) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return;
  if (capturedTest(FUTURE_HARNESS_LEAK_PATTERN, text)) {
    throw new RunContractV1Error(
      'credential_content_denied',
      path,
      `${path} leaks secret, credential, or filesystem-path content.`,
    );
  }
}

function hostileRequest(fixture, extraKey, extraValue) {
  const request = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  if (extraKey !== undefined) request[extraKey] = extraValue;
  return request;
}

function assertReceiptIdentity(prefix, receipt, fixture, operation) {
  assert.equal(receipt.run_id, fixture.identity.run_id, `${prefix} ${operation} echoes run_id`);
  assert.equal(receipt.assignment_id, fixture.identity.assignment_id,
    `${prefix} ${operation} echoes assignment_id`);
  assert.equal(receipt.lane_index, fixture.identity.lane_index,
    `${prefix} ${operation} echoes lane_index`);
  assert.equal(receipt.base_sha, fixture.identity.base_sha, `${prefix} ${operation} echoes base_sha`);
  assert.equal(receipt.child_envelope_digest, fixture.child_envelope_digest,
    `${prefix} ${operation} echoes the proven digest`);
  assert.ok(Object.isFrozen(receipt), `${prefix} ${operation} result is frozen`);
  for (const key of Object.keys(receipt)) {
    assert.ok(capturedIncludes(DRIVER_RESULT_KEYS, key),
      `${prefix} ${operation} result key "${key}" is outside the closed P17 receipt vocabulary`);
  }
  assertFutureHarnessContentFreeV1(receipt, `driver.${operation}.result`);
}

export function runFutureHarnessConformanceKitV1(driver, options = {}) {
  const label = options.label ?? 'future-harness';
  const prefix = `[${label}]`;
  const declaration = options.declaration;
  const fixture = options.fixture;
  if (declaration === undefined || fixture === undefined) {
    throw new RunContractV1Error(
      'missing_key',
      'future_harness.conformance',
      'Conformance kit requires a P17 declaration and a frozen fixture.',
    );
  }
  const expectedPreflight = options.expect?.preflight_disposition ?? 'ready';
  const expectedLaunch = options.expect?.launch_disposition ?? 'not_sent';
  if (!capturedIncludes(PREFLIGHT_DISPOSITIONS, expectedPreflight)
    || !capturedIncludes(LAUNCH_DISPOSITIONS, expectedLaunch)) {
    throw new RunContractV1Error(
      'invalid_format',
      'future_harness.conformance.expect',
      'Expected dispositions must be closed P17 values.',
    );
  }

  let checks = 0;
  const pass = () => { checks += 1; };

  const description = describeProviderDriverContractV1();
  assert.deepEqual([...description.operations], [...DRIVER_OPERATIONS], `${prefix} four operations`);
  assert.equal(description.relaunch_operations.length, 0, `${prefix} no relaunch`);
  assert.deepEqual([...description.transports], [], `${prefix} contract claims no transport`);
  assert.equal(description.capability_schema_id, PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
    `${prefix} P05 capability schema`);
  pass();

  const summary = assertProviderDriverV1(driver);
  assert.deepEqual([...summary.operations], [...DRIVER_OPERATIONS], `${prefix} driver surface`);
  pass();

  const validatedDeclaration = validateDriverDeclarationV1(declaration);
  assert.equal(validatedDeclaration.capability.provider, fixture.identity.provider,
    `${prefix} declaration provider is the frozen caller identity`);
  assert.equal(validatedDeclaration.capability.replay_posture, 'never_replay',
    `${prefix} replay posture is never_replay`);
  assert.equal(validatedDeclaration.capability.merge_authority, 'none_codex_only_integration',
    `${prefix} merge authority is Codex-only`);
  pass();

  const bound = bindProviderDriverV1(driver, declaration);
  expectDriverFailure(prefix, 'launch before preflight',
    () => bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope)),
    'not_preflighted');
  pass();

  const preflight = bound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  assert.equal(preflight.disposition, expectedPreflight, `${prefix} preflight disposition`);
  assertReceiptIdentity(prefix, preflight, fixture, 'preflight');
  pass();

  if (expectedPreflight === 'blocked') {
    expectDriverFailure(prefix, 'launch after blocked preflight',
      () => bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope)),
      'blocked_lane_denied');
    pass();
    return freezeData({
      schema: FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID,
      version: FUTURE_HARNESS_CONFORMANCE_VERSION,
      label,
      checks,
      ok: true,
      mode: 'blocked',
      operations: capturedFreeze([...DRIVER_OPERATIONS]),
      live_transport_qualification: false,
    });
  }

  const launch = bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope));
  assert.equal(launch.disposition, expectedLaunch, `${prefix} launch disposition`);
  assertReceiptIdentity(prefix, launch, fixture, 'launch');
  if (expectedLaunch === 'not_sent') {
    assert.equal(typeof launch.detail_code, 'string', `${prefix} not_sent classifies itself`);
    expectDriverFailure(prefix, 'reconcile after not_sent',
      () => bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope)),
      'not_dispatched');
    const cancelCode = validatedDeclaration.features.cancellation === 'unsupported'
      ? 'unsupported_capability'
      : 'not_dispatched';
    expectDriverFailure(prefix, 'cancel after not_sent',
      () => bound.cancel(buildDriverOperationRequestV1('cancel', fixture.envelope)),
      cancelCode);
  } else {
    assert.equal(launch.detail_code, undefined, `${prefix} ${expectedLaunch} launch stays bare`);
    expectDriverFailure(prefix, 'duplicate launch after possible send',
      () => bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope)),
      'replay_denied');
    const observe = bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope));
    assertReceiptIdentity(prefix, observe, fixture, 'reconcile');
    if (validatedDeclaration.features.cancellation === 'unsupported') {
      expectDriverFailure(prefix, 'unsupported cancel',
        () => bound.cancel(buildDriverOperationRequestV1('cancel', fixture.envelope)),
        'unsupported_capability');
    } else if (observe.disposition === 'terminal') {
      const cancel = bound.cancel(buildDriverOperationRequestV1('cancel', fixture.envelope));
      assert.equal(cancel.disposition, 'already_terminal', `${prefix} terminal cancel is absorbed`);
      assertReceiptIdentity(prefix, cancel, fixture, 'cancel');
    } else {
      const cancel = bound.cancel(buildDriverOperationRequestV1('cancel', fixture.envelope));
      assertReceiptIdentity(prefix, cancel, fixture, 'cancel');
    }
    if (validatedDeclaration.features.restart === 'unsupported') {
      expectDriverFailure(prefix, 'unsupported reattach',
        () => bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope, {
          intent: 'restart_reattach',
        })),
        'unsupported_capability');
    }
    if (validatedDeclaration.features.detailed_events === 'unsupported') {
      expectDriverFailure(prefix, 'unsupported detailed events',
        () => bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope, {
          include: ['detailed_events'],
        })),
        'unsupported_capability');
    }
    if (validatedDeclaration.features.live_progress === 'unsupported') {
      expectDriverFailure(prefix, 'unsupported live progress',
        () => bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope, {
          include: ['live_progress'],
        })),
        'unsupported_capability');
    }
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

  for (const [key, value, code] of FOREIGN_LAUNCH_KEYS) {
    expectDriverFailure(prefix, `foreign key ${key}`,
      () => validateDriverLaunchRequestV1(hostileRequest(fixture, key, value)),
      code);
  }
  pass();

  let getterRuns = 0;
  const accessorRequest = hostileRequest(fixture);
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
  assert.equal(getterRuns, 0, `${prefix} getters never run`);
  expectDriverFailure(prefix, 'Proxy request',
    () => validateDriverLaunchRequestV1(new Proxy(hostileRequest(fixture), {})),
    'proxy_denied');
  expectDriverFailure(prefix, 'symbol key',
    () => validateDriverLaunchRequestV1(hostileRequest(fixture, Symbol('hidden'), 1)),
    'symbol_key_denied');
  expectDriverFailure(prefix, 'exotic prototype',
    () => validateDriverLaunchRequestV1(Object.assign(
      Object.create({ inherited() {} }), hostileRequest(fixture),
    )),
    'exotic_prototype_denied');
  pass();

  expectDriverFailure(prefix, 'fifth operation',
    () => assertProviderDriverV1({ ...driver, reply: () => ({}) }),
    'invalid_surface');
  expectDriverFailure(prefix, 'Proxy driver',
    () => assertProviderDriverV1(new Proxy({ ...driver }, {})),
    'proxy_denied');
  pass();

  assert.equal(DRIVER_FEATURE_KEYS.length, 4, `${prefix} four honest features`);
  assert.equal(validatedDeclaration.capability.same_session_reply === 'live_session_reply'
    || validatedDeclaration.capability.same_session_reply === 'unsupported_unresolved_attention',
  true, `${prefix} reply posture is closed`);
  pass();

  return freezeData({
    schema: FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID,
    version: FUTURE_HARNESS_CONFORMANCE_VERSION,
    label,
    checks,
    ok: true,
    mode: expectedLaunch,
    operations: capturedFreeze([...DRIVER_OPERATIONS]),
    live_transport_qualification: false,
  });
}

export function describeFutureHarnessConformanceKitV1() {
  return capturedFreeze({
    schema: FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID,
    version: FUTURE_HARNESS_CONFORMANCE_VERSION,
    operations: capturedFreeze([...DRIVER_OPERATIONS]),
    live_transport_qualification: false,
    proves: capturedFreeze([
      'required_methods_and_capabilities',
      'preflight_before_spawn',
      'dispatch_certainty_and_never_replay',
      'exact_identity_binding',
      'terminal_absorption',
      'cancel_reattach_reply_supported_versus_unsupported',
      'content_free_bounded_errors_and_evidence',
      'hostile_extra_keys_prototypes_accessors',
      'bounded_events_and_receipts',
      'no_secret_or_path_leakage',
      'no_remote_pr_merge_authority',
    ]),
  });
}

capturedFreeze(assertFutureHarnessContentFreeV1);
capturedFreeze(runFutureHarnessConformanceKitV1);
capturedFreeze(describeFutureHarnessConformanceKitV1);
