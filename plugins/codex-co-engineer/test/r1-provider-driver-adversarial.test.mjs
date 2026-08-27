// Adversarial tests for the P17 ProviderDriverV1 contract: the reusable
// provider-neutral conformance kit passes for scripted drivers, rejects
// identity/disposition/feature lies, and keeps hostile direct-JavaScript
// inputs descriptor-first and trap-free. No provider transport is configured.

import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  DRIVER_OPERATION_SCHEMA_IDS,
  PROVIDER_DRIVER_VERSION,
  bindProviderDriverV1,
  validateDriverDeclarationV1,
  validateDriverLaunchRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  countingProxy,
  trapTotal,
} from './fixtures/r1-resolver-fixtures.mjs';
import {
  buildDriverContractFixtureV1,
  driverDeclaration,
  driverResultFor,
  runProviderDriverContractSuiteV1,
  scriptedProviderDriverV1,
} from './provider-driver-contract-suite.mjs';

const fixture = buildDriverContractFixtureV1();
const declaration = driverDeclaration('dsh');

function expectSuiteRejection(driver, name, extra = {}) {
  assert.throws(
    () => runProviderDriverContractSuiteV1(driver, { label: `violator-${name}`, ...extra }),
    (error) => error instanceof Error && !utilTypes.isProxy(error),
    `suite must reject the ${name} violator`,
  );
}

function wrappedDriver(overrideOperation, receiptTransform) {
  const driver = scriptedProviderDriverV1();
  return {
    ...driver,
    [overrideOperation]: (request) => receiptTransform(driver[overrideOperation](request), request),
  };
}

test('the contract suite accepts a conforming scripted driver deterministically', () => {
  const driver = scriptedProviderDriverV1();
  const first = runProviderDriverContractSuiteV1(driver, { label: 'conformance-a' });
  const second = runProviderDriverContractSuiteV1(driver, { label: 'conformance-a' });
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.ok(first.checks >= 10, 'the suite runs its full check list');
  assert.ok(Object.isFrozen(first));
});

test('the contract suite stays neutral across completable closed dispositions', () => {
  const uncertain = runProviderDriverContractSuiteV1(
    scriptedProviderDriverV1({
      launch: 'dispatch_uncertain',
      reconcile: 'unresolved_attention',
      cancel: 'cancel_requested',
    }),
    { label: 'conformance-uncertain' },
  );
  assert.equal(uncertain.ok, true);

  const terminal = runProviderDriverContractSuiteV1(
    scriptedProviderDriverV1({
      reconcile: 'in_progress',
      cancel: 'already_terminal',
    }),
    { label: 'conformance-in-progress' },
  );
  assert.equal(terminal.ok, true);
});

test('the suite rejects drivers that lie about the proven child identity', () => {
  expectSuiteRejection(wrappedDriver('launch', (receipt) => ({ ...receipt, run_id: 'other-run' })), 'run-id');
  expectSuiteRejection(
    wrappedDriver('cancel', (receipt) => ({ ...receipt, lane_index: receipt.lane_index + 1 })),
    'lane-index',
  );
  expectSuiteRejection(wrappedDriver('preflight', (receipt) => ({
    ...receipt,
    base_sha: 'f'.repeat(40),
  })), 'base-sha');
  expectSuiteRejection(wrappedDriver('reconcile', (receipt) => ({
    ...receipt,
    child_envelope_digest: '0'.repeat(64),
  })), 'digest-echo');
});

test('the suite rejects drivers reporting dispositions outside the closed vocabulary', () => {
  expectSuiteRejection(
    wrappedDriver('launch', (receipt) => ({ ...receipt, disposition: 'settled' })),
    'disposition',
  );
});

test('the suite rejects detail-pair rule violations and smuggled evidence keys', () => {
  expectSuiteRejection(wrappedDriver('launch', (receipt) => ({
    ...receipt,
    detail_code: 'why',
    detail_message: 'because',
  })), 'uncertain-with-detail');
  expectSuiteRejection(wrappedDriver('launch', (receipt) => ({
    ...receipt,
    artifact_ref: 'sha256:deadbeef',
  })), 'artifact-vocabulary');
});

test('the suite rejects a driver exposing any fifth operation', () => {
  assert.throws(
    () => runProviderDriverContractSuiteV1(
      { ...scriptedProviderDriverV1(), retry: () => ({}) }, { label: 'violator-retry' },
    ),
    (error) => error instanceof RunContractV1Error && error.code === 'invalid_surface',
  );
});

test('live and revoked proxies are denied with zero traps before reflection', () => {
  const live = countingProxy(requestForLaunch());
  const liveError = errorOf(() => validateDriverLaunchRequestV1(live.proxy));
  assert.equal(liveError.code, 'proxy_denied');
  assert.equal(trapTotal(live.counts), 0);
  assert.equal(utilTypes.isProxy(live.proxy), true);

  const { proxy, revoke } = Proxy.revocable(requestForLaunch(), {
    get() { throw new Error('revoked getter ran'); },
    ownKeys() { throw new Error('revoked ownKeys ran'); },
  });
  revoke();
  const revokedError = errorOf(() => validateDriverLaunchRequestV1(proxy));
  assert.equal(revokedError.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);

  const declarationProxy = countingProxy(declaration);
  const declarationError = errorOf(() => validateDriverDeclarationV1(declarationProxy.proxy));
  assert.equal(declarationError.code, 'proxy_denied');
  assert.equal(trapTotal(declarationProxy.counts), 0);
});

test('getters and own undefined on driver requests are denied without invoking accessors', () => {
  let reads = 0;
  const getterRequest = requestForLaunch();
  Object.defineProperty(getterRequest, 'version', {
    enumerable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.equal(errorOf(() => validateDriverLaunchRequestV1(getterRequest)).code, 'accessor_property_denied');
  assert.equal(reads, 0);

  const undefinedRequest = requestForLaunch();
  undefinedRequest.version = undefined;
  assert.equal(errorOf(() => validateDriverLaunchRequestV1(undefinedRequest)).code, 'own_undefined_denied');
});

test('hostile result graphs fail closed through the bound surface', () => {
  const request = requestForLaunch();
  const preflightRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.preflight,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  const goodReceipt = driverResultFor('preflight', preflightRequest, 'ready');

  assert.throws(() => bindProviderDriverV1({
    ...scriptedProviderDriverV1(),
    preflight: () => [goodReceipt],
  }, declaration).preflight(preflightRequest),
  (error) => error instanceof RunContractV1Error && error.code === 'invalid_type');

  assert.throws(() => bindProviderDriverV1({
    ...scriptedProviderDriverV1(),
    preflight: () => new Proxy(goodReceipt, {}),
  }, declaration).preflight(preflightRequest),
  (error) => error instanceof RunContractV1Error && error.code === 'proxy_denied');

  let getterRuns = 0;
  const accessorReceipt = { ...goodReceipt };
  delete accessorReceipt.disposition;
  Object.defineProperty(accessorReceipt, 'disposition', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return 'ready';
    },
  });
  assert.throws(() => bindProviderDriverV1({
    ...scriptedProviderDriverV1(),
    preflight: () => accessorReceipt,
  }, declaration).preflight(preflightRequest),
  (error) => error instanceof RunContractV1Error && error.code === 'accessor_property_denied');
  assert.equal(getterRuns, 0);

  const cyclicReceipt = { ...goodReceipt, extra: {} };
  cyclicReceipt.extra.self = cyclicReceipt.extra;
  assert.throws(() => bindProviderDriverV1({
    ...scriptedProviderDriverV1(),
    preflight: () => cyclicReceipt,
  }, declaration).preflight(preflightRequest),
  (error) => error instanceof RunContractV1Error && error.code === 'aliased_reference_denied');
  void request;
});

test('drivers cannot mutate the validated request they are handed', () => {
  const mutating = scriptedProviderDriverV1();
  const originalLaunch = mutating.launch;
  mutating.launch = (request) => {
    assert.throws(() => { request.child_envelope_digest = 'f'.repeat(64); }, TypeError);
    return originalLaunch(request);
  };
  const bound = bindProviderDriverV1(mutating, declaration);
  bound.preflight({
    schema: DRIVER_OPERATION_SCHEMA_IDS.preflight,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  const receipt = bound.launch({
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(receipt.disposition, 'dispatch_uncertain');
  assert.equal(receipt.child_envelope_digest, fixture.child_envelope_digest);
});

test('a dsh driver that claims confirmed dispatch is rejected by capability honesty', () => {
  expectSuiteRejection(
    scriptedProviderDriverV1({ launch: 'dispatched' }),
    'dsh-confirmed-dispatch',
  );
});

function requestForLaunch() {
  return {
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
}

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}
