// Adversarial P22 future-harness tests: hostile keys, prototypes, accessors,
// identity lies, secret/path leakage, and invented capabilities fail closed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  bindFutureHarnessDriverTemplateV1,
  createFutureHarnessDriverTemplateV1,
  validateFutureHarnessIdentityV1,
} from '../mcp/v3/future-harness.mjs';
import {
  assertFutureHarnessContentFreeV1,
} from '../mcp/v3/provider-driver-conformance.mjs';
import {
  DRIVER_OPERATIONS,
  assertProviderDriverV1,
  bindProviderDriverV1,
  buildDriverOperationRequestV1,
  validateDriverLaunchRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  FUTURE_HARNESS_PATH_CANARY,
  FUTURE_HARNESS_SECRET_CANARY,
  buildFutureHarnessFixtureV1,
  createScriptedFutureHarnessDriverV1,
  futureHarnessSupportedDeclarationV1,
  futureHarnessTemplateOptionsV1,
  scriptedFutureHarnessResultV1,
} from './fixtures/r1-future-harness-conformance.mjs';

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code);
}

test('hostile template options never execute caller code', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh');
  let getterRuns = 0;
  const hostile = { ...packed.options };
  Object.defineProperty(hostile, 'identity', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return packed.options.identity;
    },
  });
  expectCode(() => createFutureHarnessDriverTemplateV1(hostile), 'accessor_property_denied');
  assert.equal(getterRuns, 0);
  expectCode(() => createFutureHarnessDriverTemplateV1(Object.assign(
    Object.create({ inherited: true }), packed.options,
  )), 'exotic_prototype_denied');
  expectCode(() => createFutureHarnessDriverTemplateV1({
    ...packed.options,
    [Symbol('hidden')]: 1,
  }), 'symbol_key_denied');
});

test('a fifth reply/retry/merge operation is not a driver surface', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh');
  const driver = createFutureHarnessDriverTemplateV1(packed.options);
  expectCode(() => assertProviderDriverV1({ ...driver, reply: () => ({}) }), 'invalid_surface');
  expectCode(() => assertProviderDriverV1({ ...driver, retry: () => ({}) }), 'invalid_surface');
  expectCode(() => assertProviderDriverV1({ ...driver, merge: () => ({}) }), 'invalid_surface');
  const incomplete = { ...driver };
  delete incomplete.cancel;
  expectCode(() => assertProviderDriverV1(incomplete), 'invalid_surface');
});

test('foreign launch keys keep fail-closed P02 denial codes', () => {
  const fixture = buildFutureHarnessFixtureV1('dsh');
  const request = buildDriverOperationRequestV1('launch', fixture.envelope);
  expectCode(() => validateDriverLaunchRequestV1({ ...request, fallback: true }),
    'replay_or_fallback_denied');
  expectCode(() => validateDriverLaunchRequestV1({ ...request, create_pr: true }),
    'merge_authority_denied');
  expectCode(() => validateDriverLaunchRequestV1({ ...request, auto_create_pr: true }),
    'merge_authority_denied');
  expectCode(() => validateDriverLaunchRequestV1({ ...request, push: true }),
    'merge_authority_denied');
  expectCode(() => validateDriverLaunchRequestV1({ ...request, credentials: { token: 'x' } }),
    'credential_content_denied');
});

test('scripted identity lies and extra receipt keys are rejected', () => {
  const fixture = buildFutureHarnessFixtureV1('grok');
  const declaration = futureHarnessSupportedDeclarationV1('grok');
  const lying = createScriptedFutureHarnessDriverV1(fixture, { launch: 'dispatched' });
  lying.launch = (request) => ({
    ...scriptedFutureHarnessResultV1('launch', request, fixture, 'dispatched'),
    run_id: 'other-run',
  });
  const bound = bindProviderDriverV1(lying, declaration);
  bound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  expectCode(
    () => bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope)),
    'receipt_identity_mismatch',
  );

  const extra = createScriptedFutureHarnessDriverV1(fixture, { launch: 'dispatched' });
  extra.launch = (request) => ({
    ...scriptedFutureHarnessResultV1('launch', request, fixture, 'dispatched'),
    artifact_ref: 'sha256:deadbeef',
  });
  const extraBound = bindProviderDriverV1(extra, declaration);
  extraBound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  expectCode(
    () => extraBound.launch(buildDriverOperationRequestV1('launch', fixture.envelope)),
    'unknown_key',
  );
});

test('secret and path canaries never appear in template receipts or errors', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh');
  const bound = bindFutureHarnessDriverTemplateV1(packed.options);
  const preflight = bound.preflight(buildDriverOperationRequestV1('preflight', packed.fixture.envelope));
  const launch = bound.launch(buildDriverOperationRequestV1('launch', packed.fixture.envelope));
  assertFutureHarnessContentFreeV1(preflight, 'preflight');
  assertFutureHarnessContentFreeV1(launch, 'launch');
  try {
    bound.cancel(buildDriverOperationRequestV1('cancel', packed.fixture.envelope));
    assert.fail('cancel must fail closed');
  } catch (error) {
    assert.ok(!utilTypes.isProxy(error));
    assert.doesNotMatch(error.message, new RegExp(FUTURE_HARNESS_SECRET_CANARY, 'u'));
    assert.doesNotMatch(error.message, new RegExp(FUTURE_HARNESS_PATH_CANARY.replaceAll('/', '\\/'), 'u'));
    assertFutureHarnessContentFreeV1(error.message, 'cancel.error');
  }
  expectCode(
    () => assertFutureHarnessContentFreeV1(
      { detail_message: `token ${FUTURE_HARNESS_SECRET_CANARY}` },
      'leaky',
    ),
    'credential_content_denied',
  );
  expectCode(
    () => assertFutureHarnessContentFreeV1({ path: FUTURE_HARNESS_PATH_CANARY }, 'leaky-path'),
    'credential_content_denied',
  );
});

test('random IDs and clocks are not accepted as identity substitutes', () => {
  const fixture = buildFutureHarnessFixtureV1('dsh');
  expectCode(() => validateFutureHarnessIdentityV1({
    ...fixture.identity,
    request_id: `${Date.now()}`,
  }), 'invalid_format');
  expectCode(() => validateFutureHarnessIdentityV1({
    ...fixture.identity,
    branch: 'HEAD',
  }), 'invalid_format');
  expectCode(() => validateFutureHarnessIdentityV1({
    ...fixture.identity,
    base_sha: 'MAIN',
  }), 'invalid_format');
});

test('Proxy drivers and accessor operations are denied', () => {
  const packed = futureHarnessTemplateOptionsV1('cursor-local');
  const driver = createFutureHarnessDriverTemplateV1(packed.options);
  expectCode(() => assertProviderDriverV1(new Proxy(driver, {})), 'proxy_denied');
  const accessor = {};
  Object.defineProperty(accessor, 'preflight', { enumerable: true, get: () => () => ({}) });
  for (const operation of DRIVER_OPERATIONS) {
    if (operation !== 'preflight') accessor[operation] = () => ({});
  }
  expectCode(() => assertProviderDriverV1(accessor), 'invalid_object');
});
