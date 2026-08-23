// Normal P22 future-harness template tests. The scaffold exposes the exact
// P17 DriverV1 surface, fails closed, and never substitutes caller identity.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FUTURE_HARNESS_FAIL_CLOSED_FEATURES,
  bindFutureHarnessDriverTemplateV1,
  createFutureHarnessDriverTemplateV1,
  describeFutureHarnessDriverTemplateV1,
  inspectFutureHarnessTemplateBindingV1,
  validateFutureHarnessIdentityV1,
} from '../mcp/v3/future-harness.mjs';
import {
  DRIVER_OPERATIONS,
  buildDriverOperationRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  buildFutureHarnessFixtureV1,
  futureHarnessFailClosedDeclarationV1,
  futureHarnessTemplateOptionsV1,
} from './fixtures/r1-future-harness-conformance.mjs';

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code);
}

function templateFor(provider = 'dsh') {
  const packed = futureHarnessTemplateOptionsV1(provider);
  return {
    ...packed,
    driver: createFutureHarnessDriverTemplateV1(packed.options),
    bound: bindFutureHarnessDriverTemplateV1(packed.options),
  };
}

test('the template describes an inert P17 surface with no transport', () => {
  const description = describeFutureHarnessDriverTemplateV1();
  assert.deepEqual([...description.operations], [...DRIVER_OPERATIONS]);
  assert.deepEqual([...description.transports], []);
  assert.deepEqual([...description.relaunch_operations], []);
  assert.equal(description.inert, true);
  assert.equal(description.live_transport_qualification, false);
  assert.deepEqual(description.fail_closed_features, FUTURE_HARNESS_FAIL_CLOSED_FEATURES);
  assert.ok(Object.isFrozen(description));
});

test('caller-supplied identities validate through P17 and freeze', () => {
  const fixture = buildFutureHarnessFixtureV1('grok');
  const identity = validateFutureHarnessIdentityV1(fixture.identity);
  assert.equal(identity.provider, 'grok');
  assert.equal(identity.model, 'grok-4');
  assert.equal(identity.request_id, fixture.identity.request_id);
  assert.equal(identity.branch, fixture.identity.branch);
  assert.ok(Object.isFrozen(identity));
  expectCode(() => validateFutureHarnessIdentityV1({
    ...fixture.identity,
    provider: 'unknown-harness',
  }), 'unknown_provider');
  expectCode(() => validateFutureHarnessIdentityV1({
    ...fixture.identity,
    fallback: 'grok',
  }), 'replay_or_fallback_denied');
});

test('template construction requires identity and declaration and rejects extras', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh');
  expectCode(() => createFutureHarnessDriverTemplateV1(), 'missing_key');
  expectCode(() => createFutureHarnessDriverTemplateV1({
    identity: packed.options.identity,
  }), 'missing_key');
  expectCode(() => createFutureHarnessDriverTemplateV1({
    ...packed.options,
    transport: { spawn: true },
  }), 'unknown_key');
  expectCode(() => createFutureHarnessDriverTemplateV1({
    ...packed.options,
    credentials: { token: 'sk-leakedsecretvalue' },
  }), 'credential_content_denied');
  expectCode(() => createFutureHarnessDriverTemplateV1({
    ...packed.options,
    create_pr: true,
  }), 'merge_authority_denied');
  expectCode(() => createFutureHarnessDriverTemplateV1(new Proxy(packed.options, {})),
    'proxy_denied');
});

test('the template exposes exactly the four P17 operations', () => {
  const { driver } = templateFor('dsh');
  assert.deepEqual(Object.keys(driver).sort(), [...DRIVER_OPERATIONS].sort());
  for (const operation of DRIVER_OPERATIONS) {
    assert.equal(typeof driver[operation], 'function');
  }
  assert.ok(Object.isFrozen(driver));
});

test('preflight is required before launch and launch never sends', () => {
  const { bound, fixture } = templateFor('dsh');
  expectCode(
    () => bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope)),
    'not_preflighted',
  );
  const preflight = bound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  assert.equal(preflight.disposition, 'ready');
  assert.equal(preflight.run_id, fixture.identity.run_id);
  assert.equal(preflight.base_sha, fixture.identity.base_sha);
  const launch = bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope));
  assert.equal(launch.disposition, 'not_sent');
  assert.equal(launch.detail_code, 'transport_unavailable');
  expectCode(
    () => bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope)),
    'not_dispatched',
  );
  expectCode(
    () => bound.cancel(buildDriverOperationRequestV1('cancel', fixture.envelope)),
    'unsupported_capability',
  );
});

test('exact provider model workspace run request branch and base stay frozen', () => {
  const packed = futureHarnessTemplateOptionsV1('cursor-local');
  const mutableIdentity = { ...packed.fixture.identity };
  const driver = createFutureHarnessDriverTemplateV1({
    identity: mutableIdentity,
    declaration: packed.options.declaration,
  });
  mutableIdentity.model = 'substituted-model';
  mutableIdentity.branch = 'main';
  mutableIdentity.request_id = 'req-other';
  const bound = bindFutureHarnessDriverTemplateV1(packed.options);
  bound.preflight(buildDriverOperationRequestV1('preflight', packed.fixture.envelope));
  const binding = inspectFutureHarnessTemplateBindingV1(driver);
  assert.equal(binding.identity.model, 'composer-1');
  assert.equal(binding.identity.branch, packed.fixture.identity.branch);
  assert.equal(binding.identity.request_id, packed.fixture.identity.request_id);
  assert.ok(Object.isFrozen(binding.identity));
});

test('mismatched envelope identities fail closed and are never substituted', () => {
  const packed = futureHarnessTemplateOptionsV1('grok');
  const other = buildFutureHarnessFixtureV1('dsh');
  const bound = bindFutureHarnessDriverTemplateV1(packed.options);
  expectCode(
    () => bound.preflight(buildDriverOperationRequestV1('preflight', other.envelope)),
    'provider_slot_mismatch',
  );
  const mutatedIdentity = { ...packed.fixture.identity, model: 'grok-code-fast-1' };
  const mismatched = createFutureHarnessDriverTemplateV1({
    identity: mutatedIdentity,
    declaration: packed.options.declaration,
  });
  expectCode(
    () => mismatched.preflight(buildDriverOperationRequestV1('preflight', packed.fixture.envelope)),
    'invalid_exact_model_selection',
  );
});

test('cursor-cloud template keeps the pinned starting SHA and never creates a PR', () => {
  const packed = futureHarnessTemplateOptionsV1('cursor-cloud');
  assert.equal(packed.fixture.envelope.starting_ref, packed.fixture.identity.base_sha);
  assert.equal(packed.options.declaration.capability.create_pr_posture, 'prohibited');
  const bound = bindFutureHarnessDriverTemplateV1(packed.options);
  const preflight = bound.preflight(buildDriverOperationRequestV1('preflight', packed.fixture.envelope));
  assert.equal(preflight.disposition, 'ready');
  const launch = bound.launch(buildDriverOperationRequestV1('launch', packed.fixture.envelope));
  assert.equal(launch.disposition, 'not_sent');
});

test('unattested exact-model posture blocks preflight', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh', {
    exact_model_selection: 'exact_unattested',
  });
  const bound = bindFutureHarnessDriverTemplateV1(packed.options);
  const preflight = bound.preflight(buildDriverOperationRequestV1('preflight', packed.fixture.envelope));
  assert.equal(preflight.disposition, 'blocked');
  assert.equal(preflight.detail_code, 'model_unattested');
  expectCode(
    () => bound.launch(buildDriverOperationRequestV1('launch', packed.fixture.envelope)),
    'blocked_lane_denied',
  );
});

test('unsupported cancel reattach and events fail closed after a possible send is still denied', () => {
  const { bound, fixture } = templateFor('grok');
  bound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope));
  expectCode(
    () => bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope, {
      intent: 'restart_reattach',
    })),
    'unsupported_capability',
  );
  expectCode(
    () => bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope, {
      include: ['detailed_events'],
    })),
    'unsupported_capability',
  );
});

test('the template source stays inert: no clocks, random IDs, network, or processes', () => {
  const source = readFileSync(fileURLToPath(new URL('../mcp/v3/provider-driver-template.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /Date\.now|performance\.now|Math\.random|randomUUID|setTimeout|setInterval|fetch\(|createConnection|child_process|spawn\(|execFile|net\.|http\.|https\.|process\.env/u);
  assert.match(source, /No provider transport is configured/u);
});

test('provider/declaration workspace mismatch fails closed', () => {
  const fixture = buildFutureHarnessFixtureV1('dsh');
  expectCode(() => createFutureHarnessDriverTemplateV1({
    identity: fixture.identity,
    declaration: futureHarnessFailClosedDeclarationV1('grok'),
  }), 'provider_slot_mismatch');
});
