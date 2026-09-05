// P23 provider registry — focused coverage of the closed deterministic
// composition authority: slot vocabulary, drift-free inventory, exact
// accepted factory identity, selection mapping, and per-slot composition
// through the one accepted adapter factory.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURSOR_CLOUD_PROVIDER_SLOT,
  bindCursorCloudDriverV1,
  describeCursorCloudDriverV1,
  inspectCursorCloudLaneEvidenceV1,
} from '../mcp/v3/cursor-cloud-driver.mjs';
import {
  CURSOR_LOCAL_PROVIDER,
  createCursorLocalDriverV1,
  describeCursorLocalDriverV1,
} from '../mcp/v3/cursor-local-driver.mjs';
import {
  DSH_ALLOWED_MODELS,
  DSH_PROVIDER,
  createDshApxDriverV1,
  describeDshApxDriverV1,
} from '../mcp/v3/dsh-acpx-driver.mjs';
import {
  GROK_PROVIDER_SLOT,
  bindGrokAcpDriverV1,
  describeGrokAcpAdapterSurfaceV1,
  inspectGrokAcpLaneEvidenceV1,
} from '../mcp/v3/grok-acp-driver.mjs';
import { knownProvidersJoined, knownProvidersList, modelIdGrammarSource } from '../mcp/v3/grammar.mjs';
import {
  PROVIDER_REGISTRY_SCHEMA_ID,
  PROVIDER_REGISTRY_SLOTS,
  REGISTRY_SELECTION_RULE,
  composeProviderDriverV1,
  describeProviderRegistryV1,
  isRegistrySlotV1,
  registryComposeFunctionV1,
  registryEntryV1,
  registrySlotsV1,
  requireRegistrySlotV1,
  resolveRegistrySelectionV1,
} from '../mcp/v3/provider-registry.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  buildCursorLocalFixtureV1,
  createCursorLocalTransportStub,
  cursorLocalDeclaration,
} from './fixtures/r1-cursor-local-transport.mjs';
import { dispatchLane, dshEnvelope, fakeDshTransport } from './fixtures/r1-dsh-acpx-fixtures.mjs';
import {
  buildGrokDriverFixtureV1,
  createScriptedGrokAcpTransportV1,
  grokAcpCallsOf,
} from './fixtures/r1-grok-acp-transport.mjs';
import {
  buildCursorCloudDriverFixtureV1,
  createScriptedCursorCloudTransportV1,
  cursorCloudCallsOf,
} from './fixtures/r1-cursor-cloud-driver-fixtures.mjs';

const GROK_FIXTURE = buildGrokDriverFixtureV1();
const CLOUD_FIXTURE = buildCursorCloudDriverFixtureV1();
const LOCAL_FIXTURE = buildCursorLocalFixtureV1();
const DSH_FIXTURE = dshEnvelope('stealth/ox-alpha');

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error
    && (code === undefined || error.code === code), message);
}

function grokRequest(operation, extras = {}) {
  return {
    schema: `codex-co-engineer.driver-${operation}.v1`,
    version: 1,
    envelope_text: GROK_FIXTURE.envelope_text,
    child_envelope_digest: GROK_FIXTURE.child_envelope_digest,
    ...extras,
  };
}

function cloudRequest(operation, extras = {}) {
  return {
    schema: `codex-co-engineer.driver-${operation}.v1`,
    version: 1,
    envelope_text: CLOUD_FIXTURE.envelope_text,
    child_envelope_digest: CLOUD_FIXTURE.child_envelope_digest,
    ...extras,
  };
}

test('the registry registers exactly the four accepted slots in frozen grammar order', () => {
  assert.deepEqual([...PROVIDER_REGISTRY_SLOTS], ['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
  assert.deepEqual([...PROVIDER_REGISTRY_SLOTS], [...knownProvidersList()]);
  assert.deepEqual([...registrySlotsV1()], [...knownProvidersList()]);
  assert.ok(Object.isFrozen(PROVIDER_REGISTRY_SLOTS));
  for (const slot of PROVIDER_REGISTRY_SLOTS) {
    assert.equal(isRegistrySlotV1(slot), true, slot);
    assert.equal(requireRegistrySlotV1(slot), slot);
  }
  const description = describeProviderRegistryV1();
  assert.equal(description.schema, PROVIDER_REGISTRY_SCHEMA_ID);
  assert.equal(description.version, 1);
  assert.equal(description.selection_rule, REGISTRY_SELECTION_RULE);
  assert.equal(description.deterministic_selection, true);
  assert.deepEqual([...description.slots], ['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
});

test('inventory entries quote the accepted adapter surfaces without drift', () => {
  const expectedSurfaces = new Map([
    ['grok', describeGrokAcpAdapterSurfaceV1()],
    ['cursor-local', describeCursorLocalDriverV1()],
    ['cursor-cloud', describeCursorCloudDriverV1()],
    ['dsh', describeDshApxDriverV1()],
  ]);
  const expectedSchemaIds = new Map([
    ['grok', 'codex-co-engineer.grok-acp-driver.v1'],
    ['cursor-local', 'codex-co-engineer.cursor-local-driver.v1'],
    ['cursor-cloud', 'codex-co-engineer.cursor-cloud-driver.v1'],
    ['dsh', 'codex-co-engineer.dsh-acpx-driver.v1'],
  ]);
  const expectedComposeNames = new Map([
    ['grok', 'bindGrokAcpDriverV1'],
    ['cursor-local', 'createCursorLocalDriverV1'],
    ['cursor-cloud', 'bindCursorCloudDriverV1'],
    ['dsh', 'createDshApxDriverV1'],
  ]);
  for (const slot of PROVIDER_REGISTRY_SLOTS) {
    const entry = registryEntryV1(slot);
    assert.equal(entry.schema, PROVIDER_REGISTRY_SCHEMA_ID);
    assert.equal(entry.provider, slot);
    assert.equal(entry.adapter_schema_id, expectedSchemaIds.get(slot));
    assert.equal(entry.compose_function_name, expectedComposeNames.get(slot));
    assert.deepEqual(entry.adapter_surface, expectedSurfaces.get(slot));
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.adapter_surface));
    assert.ok(Object.isFrozen(entry.option_contract));
  }
  assert.equal(registryEntryV1('grok').option_contract.mode, 'transport_property');
  assert.equal(registryEntryV1('cursor-cloud').option_contract.mode, 'transport_property');
  assert.equal(registryEntryV1('cursor-local').option_contract.mode, 'options_bag');
  assert.equal(registryEntryV1('dsh').option_contract.mode, 'options_bag');
  assert.deepEqual(
    [...registryEntryV1('grok').option_contract.registry_required_keys], ['transport']);
  assert.deepEqual(
    [...registryEntryV1('cursor-cloud').option_contract.registry_required_keys], ['transport']);
  assert.deepEqual(
    [...registryEntryV1('cursor-local').option_contract.registry_required_keys], []);
  assert.deepEqual([...registryEntryV1('dsh').option_contract.registry_required_keys], []);
});

test('model vocabularies stay owned by the accepted adapters and never widen', () => {
  assert.equal(registryEntryV1('dsh').models.rule, 'closed_list');
  assert.deepEqual([...registryEntryV1('dsh').models.values], [...DSH_ALLOWED_MODELS]);
  for (const slot of ['grok', 'cursor-cloud']) {
    assert.equal(registryEntryV1(slot).models.rule, 'adapter_model_grammar');
    assert.equal(registryEntryV1(slot).models.grammar_source, modelIdGrammarSource());
  }
  assert.equal(registryEntryV1('cursor-local').models.rule, 'adapter_model_grammar');
  assert.equal(registryEntryV1('cursor-local').models.grammar_source, '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$');
});

test('descriptions are deterministic, deeply frozen, and detached from callers', () => {
  const first = describeProviderRegistryV1();
  const second = describeProviderRegistryV1();
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.entries));
  assert.equal(Object.getPrototypeOf(first.entries), null);
  for (const slot of first.slots) {
    assert.ok(Object.isFrozen(first.entries[slot]));
    assert.ok(Object.isFrozen(first.entries[slot].models));
  }
  assert.ok(Object.isFrozen(first.future_harness));
  assert.ok(Object.isFrozen(first.nonclaims));
  // Mutating a returned slots copy cannot reach registry authority.
  const slots = registrySlotsV1();
  assert.throws(() => slots.push('future-harness'), TypeError);
  assert.deepEqual([...describeProviderRegistryV1().slots], [...first.slots]);
});

test('the P22 future harness stays conformance evidence and never a fifth slot', () => {
  const description = describeProviderRegistryV1();
  assert.equal(isRegistrySlotV1('future-harness'), false);
  assert.equal(description.future_harness.surface, 'conformance_evidence');
  assert.equal(description.future_harness.provider_slot, null);
  assert.equal(description.future_harness.composable, false);
  assert.equal(description.future_harness.live_transport_qualification, false);
  assert.equal(description.future_harness.template_schema_id,
    'codex-co-engineer.future-harness-template.v1');
  assert.equal(description.future_harness.conformance_schema_id,
    'codex-co-engineer.future-harness-conformance.v1');
});

test('every nonclaim is explicit and false', () => {
  const nonclaims = describeProviderRegistryV1().nonclaims;
  for (const key of Object.keys(nonclaims)) {
    assert.equal(nonclaims[key], false, key);
  }
  for (const key of [
    'ambient_discovery', 'fallback', 'replay', 'provider_substitution', 'fifth_provider',
    'supervisor_cutover', 'live_transport_qualification', 'dynamic_import',
  ]) {
    assert.ok(Object.hasOwn(nonclaims, key), key);
  }
});

test('slot gating fails closed and content-free on near misses', () => {
  for (const hostile of [
    '', ' ', 'cursor', 'cursors-local', 'cursor-LocaL', 'grok ', ' grok', 'dshx', 'GROK',
    'Dsh', 'cursor_cloud', 'future-harness', 'template', 'provider/registry',
    'grok;drop table users', 'grok\n', String.fromCharCode(0x0047, 0x0072, 0x066F, 0x06B8),
    'x'.repeat(4096),
  ]) {
    expectCode(() => requireRegistrySlotV1(hostile), 'unknown_provider', hostile);
    assert.equal(isRegistrySlotV1(hostile), false);
    try {
      requireRegistrySlotV1(hostile);
      assert.fail('expected typed denial');
    } catch (error) {
      assert.ok(error instanceof RunContractV1Error);
      assert.equal(error.code, 'unknown_provider');
      // Hostile values stay out of the error surface unless they are a
      // substring of the fixed closed-vocabulary listing itself.
      const fixed = `provider_registry.provider must be an exact registered provider slot: ${knownProvidersJoined()}.`;
      if (!fixed.includes(hostile)) {
        assert.ok(!error.message.includes(hostile), 'hostile value must not leak');
      }
      assert.equal(error.path, 'provider_registry.provider');
    }
  }
});

test('non-string providers fail closed before any option byte is read', () => {
  let getterRuns = 0;
  const getterBomb = {};
  Object.defineProperty(getterBomb, 'transport', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return {};
    },
  });
  for (const hostile of [123, null, undefined, true, Symbol('s'), 10n,
    { transport: {} }, ['grok'], () => {}, getterBomb]) {
    expectCode(() => composeProviderDriverV1(hostile, getterBomb), 'unknown_provider');
  }
  assert.equal(getterRuns, 0, 'registry gating never runs caller code');
});

test('registryComposeFunctionV1 exposes exactly the accepted factories', () => {
  assert.equal(registryComposeFunctionV1('grok'), bindGrokAcpDriverV1);
  assert.equal(registryComposeFunctionV1('cursor-local'), createCursorLocalDriverV1);
  assert.equal(registryComposeFunctionV1('cursor-cloud'), bindCursorCloudDriverV1);
  assert.equal(registryComposeFunctionV1('dsh'), createDshApxDriverV1);
  for (const hostile of ['future-harness', 'toString', '__proto__', 'constructor']) {
    expectCode(() => registryComposeFunctionV1(hostile), 'unknown_provider');
    expectCode(() => registryEntryV1(hostile), 'unknown_provider');
  }
});

test('resolveRegistrySelectionV1 maps exact pairs deterministically without constructing', () => {
  const plan = resolveRegistrySelectionV1({ provider: 'dsh', model: 'stealth/ox-alpha' });
  assert.equal(plan.schema, 'codex-co-engineer.registry-selection.v1');
  assert.equal(plan.provider, 'dsh');
  assert.equal(plan.model, 'stealth/ox-alpha');
  assert.equal(plan.selection_rule, REGISTRY_SELECTION_RULE);
  assert.equal(plan.deterministic, true);
  assert.equal(plan.adapter_schema_id, 'codex-co-engineer.dsh-acpx-driver.v1');
  assert.equal(plan.compose_function_name, 'createDshApxDriverV1');
  assert.equal(plan.model_rule, 'closed_list');
  assert.ok(Object.isFrozen(plan));
  assert.deepEqual(resolveRegistrySelectionV1({ provider: 'dsh', model: 'stealth/ox-alpha' }), plan);

  const grammarPlan = resolveRegistrySelectionV1({
    provider: 'cursor-local', model: LOCAL_FIXTURE.model,
  });
  assert.equal(grammarPlan.model_rule, 'adapter_model_grammar');
  assert.equal(grammarPlan.compose_function_name, 'createCursorLocalDriverV1');

  expectCode(() => resolveRegistrySelectionV1({
    provider: 'dsh', model: 'not-a-dsh-model',
  }), 'unknown_model', 'closed dsh model list is enforced against the accepted constant');
  expectCode(() => resolveRegistrySelectionV1({
    provider: 'dsh', model: 'meta/muse-spark-1.3-contributor ',
  }), 'unknown_model');
  expectCode(() => resolveRegistrySelectionV1({ provider: 'dsh' }), 'missing_key');
  expectCode(() => resolveRegistrySelectionV1({ model: 'm' }), 'missing_key');
  expectCode(() => resolveRegistrySelectionV1({ provider: 'dsh', model: 'm', extra: 1 }),
    'unknown_key');
  expectCode(() => resolveRegistrySelectionV1({ provider: 'dsh', model: 5 }), 'invalid_model');
});

test('composition drives the accepted Grok lane end to end behind the registry', () => {
  const transport = createScriptedGrokAcpTransportV1();
  const driver = composeProviderDriverV1('grok', { transport });
  const preflight = driver.preflight(grokRequest('preflight'));
  assert.equal(preflight.disposition, 'ready');
  const launch = driver.launch(grokRequest('launch'));
  assert.equal(launch.disposition, 'dispatched');
  assert.equal(launch.run_id, GROK_FIXTURE.run_id);
  assert.equal(launch.assignment_id, GROK_FIXTURE.assignment_id);
  assert.equal(launch.lane_index, GROK_FIXTURE.lane_index);
  assert.equal(launch.base_sha, GROK_FIXTURE.base_sha);
  assert.equal(launch.child_envelope_digest, GROK_FIXTURE.child_envelope_digest);
  const observe = driver.reconcile(grokRequest('reconcile'));
  assert.equal(observe.disposition, 'terminal');
  const cancel = driver.cancel(grokRequest('cancel'));
  assert.equal(cancel.disposition, 'already_terminal');
  assert.equal(grokAcpCallsOf(transport, 'spawn').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'cancel').length, 0,
    'terminal cancel absorbs without touching the transport');
  // No wrapper layer: accepted evidence inspection works on the composed object.
  const evidence = inspectGrokAcpLaneEvidenceV1(driver, {
    run_id: GROK_FIXTURE.run_id,
    assignment_id: GROK_FIXTURE.assignment_id,
    child_envelope_digest: GROK_FIXTURE.child_envelope_digest,
  });
  assert.equal(evidence.child_envelope_digest, GROK_FIXTURE.child_envelope_digest);
});

test('composition drives the accepted Cursor Cloud lane end to end behind the registry', () => {
  const transport = createScriptedCursorCloudTransportV1();
  const driver = composeProviderDriverV1('cursor-cloud', { transport });
  assert.equal(driver.preflight(cloudRequest('preflight')).disposition, 'ready');
  const launch = driver.launch(cloudRequest('launch'));
  assert.equal(launch.disposition, 'dispatched');
  assert.equal(launch.run_id, CLOUD_FIXTURE.run_id);
  assert.equal(launch.child_envelope_digest, CLOUD_FIXTURE.child_envelope_digest);
  const observed = driver.reconcile(cloudRequest('reconcile'));
  assert.equal(observed.disposition, 'in_progress');
  const evidence = inspectCursorCloudLaneEvidenceV1(driver, {
    run_id: CLOUD_FIXTURE.run_id,
    assignment_id: CLOUD_FIXTURE.assignment_id,
    child_envelope_digest: CLOUD_FIXTURE.child_envelope_digest,
  });
  assert.equal(evidence.status, 'running');
  assert.equal(cursorCloudCallsOf(transport, 'create').length, 1);
  assert.equal(cursorCloudCallsOf(transport, 'send').length, 1);
});

test('composition builds the accepted DSH facade and its honest uncertain posture', () => {
  const facade = composeProviderDriverV1('dsh', {
    transport: fakeDshTransport().port,
    workspace_mode: 'managed',
  });
  assert.equal(facade.provider, DSH_PROVIDER);
  assert.equal(facade.workspace_mode, 'managed');
  const lane = dispatchLane(facade.driver, DSH_FIXTURE);
  assert.equal(lane.preflight.disposition, 'ready');
  assert.equal(lane.launch.disposition, 'dispatch_uncertain');
  assert.equal(lane.reconcile().disposition, 'in_progress');
});

test('composition builds the accepted Cursor Local facade behind the registry', () => {
  const stub = createCursorLocalTransportStub('happy');
  const facade = composeProviderDriverV1('cursor-local', {
    declaration: cursorLocalDeclaration(),
    model: LOCAL_FIXTURE.model,
    run_base_sha: LOCAL_FIXTURE.base_sha,
    transport: stub.transport,
  });
  assert.equal(facade.provider, CURSOR_LOCAL_PROVIDER);
  const request = (operation) => ({
    schema: `codex-co-engineer.driver-${operation}.v1`,
    version: 1,
    envelope_text: LOCAL_FIXTURE.envelope_text,
    child_envelope_digest: LOCAL_FIXTURE.child_envelope_digest,
  });
  assert.equal(facade.driver.preflight(request('preflight')).disposition, 'ready');
  assert.equal(facade.driver.launch(request('launch')).disposition, 'dispatched');
  assert.equal(stub.state.spawnCalls, 1);
  assert.equal(stub.state.sends, 1);
});

test('compositions are independent and never share lanes or state', () => {
  const first = composeProviderDriverV1('grok', { transport: createScriptedGrokAcpTransportV1() });
  const second = composeProviderDriverV1('grok', { transport: createScriptedGrokAcpTransportV1() });
  assert.notEqual(first, second);
  assert.equal(second.preflight(grokRequest('preflight')).disposition, 'ready',
    'a fresh composition starts from its own absent state');
  first.preflight(grokRequest('preflight'));
  first.launch(grokRequest('launch'));
  // The second lane was never touched by the first lane's lifecycle.
  expectCode(() => second.reconcile(grokRequest('reconcile')), 'not_dispatched');
});

test('accepted adapter failures pass through unwrapped with no substitution', () => {
  expectCode(() => composeProviderDriverV1('dsh', {
    transport: fakeDshTransport().port,
    workspace_mode: 'direct',
  }), 'direct_mode_rejected',
  'the adapter\'s own typed denial surfaces unchanged; no other provider is tried');
  expectCode(() => composeProviderDriverV1('cursor-local', {
    declaration: cursorLocalDeclaration({ provider: 'grok' }),
    model: LOCAL_FIXTURE.model,
    run_base_sha: LOCAL_FIXTURE.base_sha,
    transport: createCursorLocalTransportStub('happy').transport,
  }), 'provider_mismatch');
});
