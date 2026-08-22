// Adversarial tests for the P18 Grok ACP adapter: malformed and
// provider-forged receipts, hostile direct-JS inputs, content leaking into
// diagnostics, and post-spawn replay. Injected transport only.

import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  DRIVER_OPERATION_SCHEMA_IDS,
  PROVIDER_DRIVER_VERSION,
  buildDriverOperationRequestV1,
  validateDriverLaunchRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import {
  GROK_ACP_TRANSPORT_OPERATIONS,
  MAX_GROK_ACP_EVENT_TEXT_BYTES,
  MAX_GROK_ACP_TIMING_MS,
  assertGrokAcpTransportV1,
  bindGrokAcpDriverV1,
  createGrokAcpDriverV1,
  grokAcpDriverDeclarationV1,
  inspectGrokAcpLaneEvidenceV1,
} from '../mcp/v3/grok-acp-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  GROK_FIXTURE_MODEL,
  GROK_FIXTURE_SESSION_ID,
  buildGrokDriverFixtureV1,
  createScriptedGrokAcpTransportV1,
  grokAcpCallsOf,
} from './fixtures/r1-grok-acp-transport.mjs';

const fixture = buildGrokDriverFixtureV1();

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code, message);
}

function requestFor(operation, extras = {}) {
  return buildDriverOperationRequestV1(operation, fixture.envelope, extras);
}

function identityFields() {
  return {
    provider: 'grok',
    model: GROK_FIXTURE_MODEL,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    lane_index: fixture.lane_index,
    base_sha: fixture.base_sha,
    child_envelope_digest: fixture.child_envelope_digest,
  };
}

function launchBound(script = {}) {
  const transport = createScriptedGrokAcpTransportV1(script);
  const driver = bindGrokAcpDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  return { driver, transport };
}

test('live and revoked proxies are denied with zero traps', () => {
  const live = countingProxy(createScriptedGrokAcpTransportV1());
  const liveError = errorOf(() => assertGrokAcpTransportV1(live.proxy));
  assert.equal(liveError.code, 'proxy_denied');
  assert.equal(trapTotal(live.counts), 0);

  const { proxy, revoke } = Proxy.revocable(createScriptedGrokAcpTransportV1(), {
    get() { throw new Error('revoked getter ran'); },
  });
  revoke();
  assert.equal(errorOf(() => assertGrokAcpTransportV1(proxy)).code, 'proxy_denied');

  const declarationProxy = countingProxy(grokAcpDriverDeclarationV1());
  assert.equal(
    errorOf(() => inspectGrokAcpLaneEvidenceV1(bindGrokAcpDriverV1(createScriptedGrokAcpTransportV1()), declarationProxy.proxy)).code,
    'proxy_denied',
  );
  assert.equal(trapTotal(declarationProxy.counts), 0);
});

test('hostile transport surfaces fail closed', () => {
  expectCode(() => assertGrokAcpTransportV1({ ...createScriptedGrokAcpTransportV1(), retry: () => ({}) }),
    'invalid_surface');
  const incomplete = { ...createScriptedGrokAcpTransportV1() };
  delete incomplete.reattach;
  expectCode(() => assertGrokAcpTransportV1(incomplete), 'invalid_surface');
  expectCode(() => assertGrokAcpTransportV1({ ...createScriptedGrokAcpTransportV1(), spawn: 1 }),
    'invalid_operation');
  class TransportClass {}
  expectCode(
    () => assertGrokAcpTransportV1(Object.assign(new TransportClass(), createScriptedGrokAcpTransportV1())),
    'exotic_prototype_denied',
  );
  const accessor = {};
  Object.defineProperty(accessor, 'preflight', { enumerable: true, get: () => () => ({}) });
  for (const operation of GROK_ACP_TRANSPORT_OPERATIONS) {
    if (operation === 'preflight') continue;
    accessor[operation] = () => ({});
  }
  expectCode(() => assertGrokAcpTransportV1(accessor), 'invalid_object');
});

test('getter and own-undefined driver requests never invoke accessors', () => {
  let reads = 0;
  const getterRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  Object.defineProperty(getterRequest, 'version', {
    enumerable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.equal(errorOf(() => validateDriverLaunchRequestV1(getterRequest)).code, 'accessor_property_denied');
  assert.equal(reads, 0);

  const undefinedRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: undefined,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  assert.equal(errorOf(() => validateDriverLaunchRequestV1(undefinedRequest)).code, 'own_undefined_denied');

  expectCode(() => validateDriverLaunchRequestV1(new Proxy(requestFor('launch'), {})), 'proxy_denied');
});

test('malformed spawn receipts after a returned call are uncertain, not dispatched', () => {
  const transport = createScriptedGrokAcpTransportV1({
    spawn: { spawned: true, session_id: '!!!', ...identityFields() },
  });
  const driver = bindGrokAcpDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  const receipt = driver.launch(requestFor('launch'));
  assert.equal(receipt.disposition, 'dispatch_uncertain');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 0);
});

test('provider-forged dispatch acknowledgements are never treated as dispatched', () => {
  const cases = [
    { model: 'grok-code-fast-1' },
    { provider: 'dsh' },
    { run_id: 'other-run' },
    { child_envelope_digest: '0'.repeat(64) },
    { session_id: 'sess-forged' },
    { request_id: 'forged-request' },
  ];
  for (const forge of cases) {
    const transport = createScriptedGrokAcpTransportV1({
      dispatch: (request) => ({
        acknowledged: true,
        session_id: request.session_id,
        request_id: request.request_id,
        ...identityFields(),
        ...forge,
      }),
    });
    const driver = bindGrokAcpDriverV1(transport);
    driver.preflight(requestFor('preflight'));
    const receipt = driver.launch(requestFor('launch'));
    assert.equal(receipt.disposition, 'dispatch_uncertain', JSON.stringify(forge));
    expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
    assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
  }
});

test('forged observe, cancel, and reattach identities fail closed', () => {
  const { driver } = launchBound({
    observe: { status: 'running', session_id: 'sess-other', ...identityFields() },
  });
  driver.launch(requestFor('launch'));
  expectCode(() => driver.reconcile(requestFor('reconcile')), 'stale_identity_denied');

  const cancelForge = launchBound({
    cancel: { outcome: 'cancel_confirmed', session_id: 'sess-other', ...identityFields() },
  });
  cancelForge.driver.launch(requestFor('launch'));
  expectCode(() => cancelForge.driver.cancel(requestFor('cancel')), 'stale_identity_denied');

  const reattachForge = launchBound({
    reattach: { reattached: true, session_id: 'sess-other', ...identityFields() },
  });
  reattachForge.driver.launch(requestFor('launch'));
  expectCode(
    () => reattachForge.driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })),
    'stale_identity_denied',
  );
});

test('malformed observe receipts fail closed and do not copy content into the driver result', () => {
  const extraKey = launchBound({
    observe: {
      status: 'running',
      session_id: GROK_FIXTURE_SESSION_ID,
      envelope_text: fixture.envelope_text,
      ...identityFields(),
    },
  });
  extraKey.driver.launch(requestFor('launch'));
  expectCode(() => extraKey.driver.reconcile(requestFor('reconcile')), 'unknown_key');

  const fallbackKey = launchBound({
    observe: {
      status: 'running',
      session_id: GROK_FIXTURE_SESSION_ID,
      fallback: true,
      ...identityFields(),
    },
  });
  fallbackKey.driver.launch(requestFor('launch'));
  expectCode(() => fallbackKey.driver.reconcile(requestFor('reconcile')), 'replay_or_fallback_denied');

  const badCursor = launchBound({
    observe: {
      status: 'running',
      session_id: GROK_FIXTURE_SESSION_ID,
      cursor: 'not-a-cursor',
      ...identityFields(),
    },
  });
  badCursor.driver.launch(requestFor('launch'));
  expectCode(() => badCursor.driver.reconcile(requestFor('reconcile')), 'invalid_format');

  const badTiming = launchBound({
    observe: {
      status: 'running',
      session_id: GROK_FIXTURE_SESSION_ID,
      elapsed_ms: MAX_GROK_ACP_TIMING_MS + 1,
      ...identityFields(),
    },
  });
  badTiming.driver.launch(requestFor('launch'));
  expectCode(() => badTiming.driver.reconcile(requestFor('reconcile')), 'invalid_format');
});

test('proxy and accessor transport receipts fail closed without running getters', () => {
  const proxyTransport = createScriptedGrokAcpTransportV1({
    preflight: () => new Proxy({ ok: true, ...identityFields() }, {}),
  });
  expectCode(
    () => bindGrokAcpDriverV1(proxyTransport).preflight(requestFor('preflight')),
    'proxy_denied',
  );

  let getterRuns = 0;
  const accessorTransport = createScriptedGrokAcpTransportV1({
    preflight: () => {
      const receipt = { ok: true, ...identityFields() };
      delete receipt.ok;
      Object.defineProperty(receipt, 'ok', {
        enumerable: true,
        get() {
          getterRuns += 1;
          return true;
        },
      });
      return receipt;
    },
  });
  expectCode(
    () => bindGrokAcpDriverV1(accessorTransport).preflight(requestFor('preflight')),
    'accessor_property_denied',
  );
  assert.equal(getterRuns, 0);
});

test('needs_attention without a reply identity fails closed', () => {
  const { driver } = launchBound({
    observe: { status: 'needs_attention', session_id: GROK_FIXTURE_SESSION_ID, ...identityFields() },
  });
  driver.launch(requestFor('launch'));
  expectCode(() => driver.reconcile(requestFor('reconcile')), 'capability_reply_mismatch');
});

test('inspect rejects hostile queries and stale child identities', () => {
  const { driver } = launchBound();
  driver.launch(requestFor('launch'));
  expectCode(() => inspectGrokAcpLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: '0'.repeat(64),
  }), 'stale_identity_denied');
  expectCode(() => inspectGrokAcpLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
    fallback: true,
  }), 'replay_or_fallback_denied');
  const getterQuery = {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  let reads = 0;
  Object.defineProperty(getterQuery, 'cursor', {
    enumerable: true,
    get() {
      reads += 1;
      return '1';
    },
  });
  expectCode(() => inspectGrokAcpLaneEvidenceV1(driver, getterQuery), 'accessor_property_denied');
  assert.equal(reads, 0);
});

test('oversized event text is clipped and omitted keys never appear on evidence', () => {
  const { driver } = launchBound({
    observe: {
      status: 'running',
      session_id: GROK_FIXTURE_SESSION_ID,
      ...identityFields(),
      events: [{
        type: 'tool',
        text: 'y'.repeat(MAX_GROK_ACP_EVENT_TEXT_BYTES + 64),
        prompt: fixture.envelope_text,
        envelope_text: fixture.envelope_text,
        api_key: 'sk-abcdefghijklmnop',
        content: { raw: fixture.envelope_text },
      }],
    },
  });
  driver.launch(requestFor('launch'));
  driver.reconcile(requestFor('reconcile', { include: ['detailed_events'] }));
  const evidence = inspectGrokAcpLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(evidence.events.length, 1);
  assert.equal(evidence.events[0].envelope_text, undefined);
  assert.equal(evidence.events[0].content, undefined);
  assert.equal(evidence.events[0].api_key, '[redacted]');
  assert.ok(String(evidence.events[0].text).length <= MAX_GROK_ACP_EVENT_TEXT_BYTES + 1);
  assert.equal(JSON.stringify(evidence).includes(fixture.envelope_text), false);
});

test('stale workspace and model drift on reattach fail closed', () => {
  const { driver } = launchBound({
    reattach: {
      reattached: true,
      session_id: GROK_FIXTURE_SESSION_ID,
      ...identityFields(),
      model: 'grok-code-fast-1',
      repository_path: '/tmp/other-worktree',
    },
  });
  driver.launch(requestFor('launch'));
  expectCode(
    () => driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })),
    'stale_identity_denied',
  );
});

test('cyclic and aliased receipts fail closed', () => {
  const cyclic = identityFields();
  cyclic.status = 'running';
  cyclic.session_id = GROK_FIXTURE_SESSION_ID;
  cyclic.progress = {};
  cyclic.progress.self = cyclic.progress;
  const { driver } = launchBound({ observe: cyclic });
  driver.launch(requestFor('launch'));
  expectCode(() => driver.reconcile(requestFor('reconcile')), 'aliased_reference_denied');
});

test('createGrokAcpDriverV1 captures operations so later mutation cannot swap dispatch', () => {
  const transport = createScriptedGrokAcpTransportV1();
  const driver = createGrokAcpDriverV1(transport);
  transport.dispatch = () => {
    throw new Error('mutated dispatch must never run');
  };
  driver.preflight(requestFor('preflight'));
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
});

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(utilTypes.isProxy(error), false);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}
