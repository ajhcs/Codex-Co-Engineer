// P23 integration proof: every accepted provider driver (P18 Grok ACP,
// P19 Cursor Local, P20 DSH ACPX, P21 Cursor Cloud) composes behind the
// closed registry and drives its accepted lifecycle with exact identity
// echo. The P22 future harness stays mock/conformance evidence only.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindCursorCloudDriverV1,
  createCursorCloudDriverV1,
  describeCursorCloudDriverV1,
} from '../mcp/v3/cursor-cloud-driver.mjs';
import {
  createCursorLocalDriverV1,
  describeCursorLocalDriverV1,
} from '../mcp/v3/cursor-local-driver.mjs';
import {
  createDshApxDriverV1,
  describeDshApxDriverV1,
} from '../mcp/v3/dsh-acpx-driver.mjs';

import {
  bindGrokAcpDriverV1,
  createGrokAcpDriverV1,
  describeGrokAcpAdapterSurfaceV1,
} from '../mcp/v3/grok-acp-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  PROVIDER_REGISTRY_SLOTS,
  REGISTRY_SELECTION_RULE,
  composeProviderDriverV1,
  describeProviderRegistryV1,
  registryComposeFunctionV1,
} from '../mcp/v3/provider-registry.mjs';
import { createFutureHarnessDriverTemplateV1 } from '../mcp/v3/future-harness.mjs';
import { runFutureHarnessConformanceKitV1 } from '../mcp/v3/provider-driver-conformance.mjs';
import {
  buildCursorLocalFixtureV1,
  createCursorLocalTransportStub,
  cursorLocalDeclaration,
} from './fixtures/r1-cursor-local-transport.mjs';
import {
  dispatchLane,
  dshEnvelope,
  fakeDshTransport,
} from './fixtures/r1-dsh-acpx-fixtures.mjs';
import {
  buildGrokDriverFixtureV1,
  createScriptedGrokAcpTransportV1,
} from './fixtures/r1-grok-acp-transport.mjs';
import {
  buildCursorCloudDriverFixtureV1,
  createScriptedCursorCloudTransportV1,
} from './fixtures/r1-cursor-cloud-driver-fixtures.mjs';
import {
  futureHarnessTemplateOptionsV1,
} from './fixtures/r1-future-harness-conformance.mjs';

const GROK_FIXTURE = buildGrokDriverFixtureV1();
const CLOUD_FIXTURE = buildCursorCloudDriverFixtureV1();
const LOCAL_FIXTURE = buildCursorLocalFixtureV1();
const DSH_FIXTURE = dshEnvelope('stealth/ox-alpha');

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code,
    message);
}

function requestFor(fixture, operation, extras = {}) {
  return {
    schema: `codex-co-engineer.driver-${operation}.v1`,
    version: 1,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    ...extras,
  };
}

function assertIdentityEcho(receipt, fixture, label) {
  assert.equal(receipt.run_id, fixture.run_id, `${label} run_id`);
  assert.equal(receipt.assignment_id, fixture.assignment_id, `${label} assignment_id`);
  assert.equal(receipt.lane_index, fixture.lane_index, `${label} lane_index`);
  assert.equal(receipt.base_sha, fixture.base_sha, `${label} base_sha`);
  assert.equal(receipt.child_envelope_digest, fixture.child_envelope_digest,
    `${label} child_envelope_digest`);
}

test('every registered slot composes the exact accepted factory object', () => {
  assert.equal(registryComposeFunctionV1('grok'), bindGrokAcpDriverV1);
  assert.equal(registryComposeFunctionV1('cursor-local'), createCursorLocalDriverV1);
  assert.equal(registryComposeFunctionV1('cursor-cloud'), bindCursorCloudDriverV1);
  assert.equal(registryComposeFunctionV1('dsh'), createDshApxDriverV1);
  // The raw accepted creators stay reachable through the same authority.
  const description = describeProviderRegistryV1();
  assert.deepEqual(Object.keys(description.entries).sort(),
    ['cursor-cloud', 'cursor-local', 'dsh', 'grok']);
});

test('the composed Grok ACP driver runs the accepted lifecycle with identity echo', () => {
  const transport = createScriptedGrokAcpTransportV1();
  const driver = composeProviderDriverV1('grok', { transport });
  const preflight = driver.preflight(requestFor(GROK_FIXTURE, 'preflight'));
  assert.equal(preflight.disposition, 'ready');
  assertIdentityEcho(preflight, GROK_FIXTURE, 'grok preflight');
  const launch = driver.launch(requestFor(GROK_FIXTURE, 'launch'));
  assert.equal(launch.disposition, 'dispatched',
    'launch confirms only after the authoritative acknowledgement');
  assertIdentityEcho(launch, GROK_FIXTURE, 'grok launch');
  assert.equal(driver.reconcile(requestFor(GROK_FIXTURE, 'reconcile')).disposition, 'terminal');
  const cancel = driver.cancel(requestFor(GROK_FIXTURE, 'cancel'));
  assert.equal(cancel.disposition, 'already_terminal');
  assertIdentityEcho(cancel, GROK_FIXTURE, 'grok cancel');
});

test('the composed Cursor Local driver runs the accepted lifecycle with one spawn and ack', () => {
  const stub = createCursorLocalTransportStub('happy');
  const facade = composeProviderDriverV1('cursor-local', {
    declaration: cursorLocalDeclaration(),
    model: LOCAL_FIXTURE.model,
    run_base_sha: LOCAL_FIXTURE.base_sha,
    transport: stub.transport,
  });
  assert.equal(facade.provider, 'cursor-local');
  const driver = facade.driver;
  const preflight = driver.preflight(requestFor(LOCAL_FIXTURE, 'preflight'));
  assert.equal(preflight.disposition, 'ready');
  assertIdentityEcho(preflight, LOCAL_FIXTURE, 'cursor-local preflight');
  const launch = driver.launch(requestFor(LOCAL_FIXTURE, 'launch'));
  assert.equal(launch.disposition, 'dispatched');
  assertIdentityEcho(launch, LOCAL_FIXTURE, 'cursor-local launch');
  assert.equal(stub.state.spawnCalls, 1);
  assert.equal(stub.state.sends, 1);
  assert.equal(stub.state.acks, 1);
  const observed = driver.reconcile(requestFor(LOCAL_FIXTURE, 'reconcile'));
  assert.equal(observed.disposition, 'in_progress');
  const cancelled = driver.cancel(requestFor(LOCAL_FIXTURE, 'cancel'));
  assert.equal(cancelled.disposition, 'cancel_confirmed');
});

test('the composed DSH ACPX driver keeps honest post-spawn uncertainty', () => {
  const facade = composeProviderDriverV1('dsh', {
    transport: fakeDshTransport().port,
    workspace_mode: 'managed',
  });
  const lane = dispatchLane(facade.driver, DSH_FIXTURE);
  assert.equal(lane.preflight.disposition, 'ready');
  assertIdentityEcho(lane.launch, DSH_FIXTURE, 'dsh launch');
  assert.equal(lane.launch.disposition, 'dispatch_uncertain');
  expectCode(() => lane.launchAgain(), 'replay_denied',
    'an uncertain launch is never replayed through the registry-composed driver');
  const observed = lane.reconcile({ include: ['live_progress'] });
  assert.equal(observed.disposition, 'in_progress');
  assertIdentityEcho(observed, DSH_FIXTURE, 'dsh reconcile');
  const cancelled = lane.cancel();
  assert.equal(cancelled.disposition, 'cancel_confirmed');
});

test('the composed Cursor Cloud driver never authorizes merge or PR work', () => {
  const transport = createScriptedCursorCloudTransportV1();
  const driver = composeProviderDriverV1('cursor-cloud', { transport });
  const preflight = driver.preflight(requestFor(CLOUD_FIXTURE, 'preflight'));
  assert.equal(preflight.disposition, 'ready');
  assertIdentityEcho(preflight, CLOUD_FIXTURE, 'cursor-cloud preflight');
  const launch = driver.launch(requestFor(CLOUD_FIXTURE, 'launch'));
  assert.equal(launch.disposition, 'dispatched');
  assertIdentityEcho(launch, CLOUD_FIXTURE, 'cursor-cloud launch');
  const observed = driver.reconcile(
    requestFor(CLOUD_FIXTURE, 'reconcile', { include: ['live_progress'] }));
  assert.equal(observed.disposition, 'in_progress');
  const cancelled = driver.cancel(requestFor(CLOUD_FIXTURE, 'cancel'));
  assert.equal(cancelled.disposition, 'cancel_confirmed');
});

test('four accepted lanes coexist without cross-talk through the registry', () => {
  const grok = composeProviderDriverV1('grok', { transport: createScriptedGrokAcpTransportV1() });
  const cloudTransport = createScriptedCursorCloudTransportV1();
  const cloud = composeProviderDriverV1('cursor-cloud', { transport: cloudTransport });
  const localStub = createCursorLocalTransportStub('happy');
  const local = composeProviderDriverV1('cursor-local', {
    declaration: cursorLocalDeclaration(),
    model: LOCAL_FIXTURE.model,
    run_base_sha: LOCAL_FIXTURE.base_sha,
    transport: localStub.transport,
  });
  const dshFacade = composeProviderDriverV1('dsh', {
    transport: fakeDshTransport().port,
    workspace_mode: 'managed',
  });
  // Dispatch each lane; each stays bound to its own exact child identity.
  assert.equal(grok.preflight(requestFor(GROK_FIXTURE, 'preflight')).disposition, 'ready');
  assert.equal(cloud.preflight(requestFor(CLOUD_FIXTURE, 'preflight')).disposition, 'ready');
  assert.equal(local.driver.preflight(requestFor(LOCAL_FIXTURE, 'preflight')).disposition,
    'ready');
  assert.equal(
    dshFacade.driver.preflight({
      schema: 'codex-co-engineer.driver-preflight.v1',
      version: 1,
      envelope_text: DSH_FIXTURE.envelope_text,
      child_envelope_digest: DSH_FIXTURE.child_envelope_digest,
    }).disposition, 'ready');
  // Cross-provider digests are stale everywhere else.
  assert.notEqual(GROK_FIXTURE.child_envelope_digest, CLOUD_FIXTURE.child_envelope_digest);
  assert.notEqual(GROK_FIXTURE.child_envelope_digest, LOCAL_FIXTURE.child_envelope_digest);
  assert.notEqual(DSH_FIXTURE.child_envelope_digest, LOCAL_FIXTURE.child_envelope_digest);
  assert.equal(localStub.state.spawnCalls, 0, 'no provider spawns during preflight phase');
});

test('inventory surfaces stay byte-faithful to every accepted adapter description', () => {
  const entries = describeProviderRegistryV1().entries;
  assert.deepEqual(entries.grok.adapter_surface, describeGrokAcpAdapterSurfaceV1());
  assert.deepEqual(entries['cursor-local'].adapter_surface, describeCursorLocalDriverV1());
  assert.deepEqual(entries['cursor-cloud'].adapter_surface, describeCursorCloudDriverV1());
  assert.deepEqual(entries.dsh.adapter_surface, describeDshApxDriverV1());
});

test('the P22 kit still passes against the inert template as evidence only', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh');
  const driver = createFutureHarnessDriverTemplateV1(packed.options);
  const report = runFutureHarnessConformanceKitV1(driver, {
    label: 'registry-inventory-template-dsh',
    declaration: packed.options.declaration,
    fixture: packed.fixture,
    expect: { launch_disposition: 'not_sent' },
  });
  assert.equal(report.ok, true);
  assert.equal(report.live_transport_qualification, false,
    'the registered P22 surface proves contract evidence, never a live route');

  // The registry inventory is the only composition authority: exactly four
  // slots, one accepted adapter each, selection rule pinned.
  const description = describeProviderRegistryV1();
  assert.equal(PROVIDER_REGISTRY_SLOTS.length, 4);
  assert.equal(description.selection_rule, REGISTRY_SELECTION_RULE);
  assert.deepEqual([...description.slots], [...PROVIDER_REGISTRY_SLOTS]);
  for (const slot of description.slots) {
    const entry = description.entries[slot];
    assert.equal(entry.provider, slot);
    assert.ok(entry.adapter_surface.live_qualification === false
      || entry.adapter_surface.claims?.live_transport_qualification === false
      || entry.adapter_surface.transport_mode !== undefined, slot);
  }
});
