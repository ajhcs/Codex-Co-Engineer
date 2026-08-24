// P23 provider registry — adversarial coverage. Hostile providers,
// selections, and options must fail closed, content-free, and without
// running any caller code; inventory must stay deterministic and frozen
// under prior hostility; P22 must never become composable.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCursorLocalTransportStub } from './fixtures/r1-cursor-local-transport.mjs';
import { fakeDshTransport } from './fixtures/r1-dsh-acpx-fixtures.mjs';
import {
  PROVIDER_REGISTRY_SLOTS,
  composeProviderDriverV1,
  describeProviderRegistryV1,
  isRegistrySlotV1,
  registryEntryV1,
  registrySlotsV1,
  requireRegistrySlotV1,
  resolveRegistrySelectionV1,
} from '../mcp/v3/provider-registry.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';

const PRISTINE_DESCRIPTION = describeProviderRegistryV1();

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error
    && (code === undefined || error.code === code), message);
}

test('accessor options never run their getters for any provider decision', () => {
  let transportRuns = 0;
  let decoyRuns = 0;
  const bag = {};
  Object.defineProperty(bag, 'transport', {
    enumerable: true,
    get() {
      transportRuns += 1;
      return {};
    },
  });
  Object.defineProperty(bag, 'decoy', {
    enumerable: true,
    get() {
      decoyRuns += 1;
      return {};
    },
  });
  expectCode(() => composeProviderDriverV1('grok', bag), 'unknown_key',
    'the closed transport_property bag rejects foreign keys before descriptors are read');
  expectCode(() => resolveRegistrySelectionV1({
    provider: 'dsh',
    model: 'stealth/ox-alpha',
    get extra() {
      throw new Error('getter must not run');
    },
  }), 'unknown_key');
  assert.equal(transportRuns, 0);
  assert.equal(decoyRuns, 0);
});

test('accessor transports are refused without invoking the accessor', () => {
  let runs = 0;
  const bag = {};
  Object.defineProperty(bag, 'transport', {
    enumerable: true,
    get() {
      runs += 1;
      return {};
    },
  });
  for (const slot of ['grok', 'cursor-cloud']) {
    expectCode(() => composeProviderDriverV1(slot, bag), 'accessor_property_denied');
  }
  assert.equal(runs, 0);
});

test('proxies, exotic prototypes, arrays, primitives, and functions are denied', () => {
  const exotic = Object.assign(Object.create({ inherited() {} }), { transport: {} });
  const hostileBags = [
    new Proxy({ transport: {} }, {}),
    exotic,
    [],
    [1, 2],
    'transport',
    7,
    true,
    () => {},
    Symbol('x'),
    10n,
  ];
  for (const slot of ['grok', 'cursor-cloud', 'dsh', 'cursor-local']) {
    for (const bag of hostileBags) {
      assert.throws(() => composeProviderDriverV1(slot, bag),
        (error) => error instanceof RunContractV1Error,
        `${slot} must reject the hostile bag with a typed denial`);
    }
    for (const absent of [null, undefined]) {
      expectCode(() => composeProviderDriverV1(slot, absent), 'invalid_type',
        `${slot} requires an options record`);
    }
  }
});

test('missing, non-enumerable, and symbol-keyed transports fail closed per slot', () => {
  expectCode(() => composeProviderDriverV1('grok', {}), 'missing_key');
  expectCode(() => composeProviderDriverV1('cursor-cloud', {}), 'missing_key');
  const hidden = {};
  Object.defineProperty(hidden, 'transport', { enumerable: false, value: {} });
  expectCode(() => composeProviderDriverV1('grok', hidden), 'non_enumerable_property_denied');
  const symboled = { transport: {} };
  symboled[Symbol('hidden')] = 1;
  expectCode(() => composeProviderDriverV1('cursor-cloud', symboled), 'symbol_key_denied');
  expectCode(() => composeProviderDriverV1('dsh', symboled), 'symbol_key_denied');
  expectCode(() => composeProviderDriverV1('cursor-local', symboled), 'symbol_key_denied');
});

test('options_bag slots forward faithfully so accepted factories keep denying', () => {
  // The registry adds no reinterpretation: adapter denials surface verbatim.
  let getterRuns = 0;
  const accessorBag = {
    get workspace_mode() {
      getterRuns += 1;
      return 'managed';
    },
    transport: fakeDshTransport().port,
  };
  expectCode(() => composeProviderDriverV1('dsh', accessorBag),
    'invalid_object', 'the DSH factory owns its own option closure');
  assert.equal(getterRuns, 0, 'registry forwarding itself never reads values');
  expectCode(() => composeProviderDriverV1('dsh', new Proxy({
    transport: fakeDshTransport().port,
    workspace_mode: 'managed',
  }, {})), 'proxy_denied');
  expectCode(() => composeProviderDriverV1('cursor-local', new Proxy({}, {})), 'proxy_denied');
  expectCode(() => composeProviderDriverV1('cursor-local', Object.create({
    inherited() {},
  }, { transport: { value: createCursorLocalTransportStub('happy').transport, enumerable: true } })),
  'invalid_type');
});

test('hostile provider strings never reach codes, paths, or messages', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '${process.env.API_KEY}',
    '../../etc/passwd',
    'grok\x00admin',
    'A'.repeat(5000),
    '🦛'.repeat(300),
    'grok"or"1"="1',
    'cursor-local\nHTTP/1.1',
  ];
  for (const payload of payloads) {
    try {
      requireRegistrySlotV1(payload);
      assert.fail('expected typed denial');
    } catch (error) {
      assert.ok(error instanceof RunContractV1Error);
      assert.notEqual(error.code, payload);
      assert.ok(!error.code.includes(payload) && !error.path.includes(payload)
        && !error.message.includes(payload), 'content-free denial required');
    }
    expectCode(() => resolveRegistrySelectionV1({ provider: payload, model: 'm' }),
      'unknown_provider');
    expectCode(() => composeProviderDriverV1(payload, { transport: {} }), 'unknown_provider');
  }
});

test('prototype members and forged keys can never resolve as slots or entries', () => {
  for (const forged of [
    'toString', 'constructor', 'hasOwnProperty', 'isPrototypeOf', '__proto__',
    'propertyIsEnumerable', 'toLocaleString', 'valueOf',
  ]) {
    assert.equal(isRegistrySlotV1(forged), false);
    expectCode(() => requireRegistrySlotV1(forged), 'unknown_provider');
    expectCode(() => registryEntryV1(forged), 'unknown_provider');
    expectCode(() => composeProviderDriverV1(forged, { transport: {} }), 'unknown_provider');
  }
});

test('selection records reject proxies, accessors, symbols, sparse arrays, and cycles', () => {
  let getterRuns = 0;
  const accessorSelection = {};
  Object.defineProperty(accessorSelection, 'provider', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return 'dsh';
    },
  });
  accessorSelection.model = 'stealth/ox-alpha';
  expectCode(() => resolveRegistrySelectionV1(accessorSelection), 'accessor_property_denied');
  assert.equal(getterRuns, 0);

  expectCode(() => resolveRegistrySelectionV1(new Proxy({
    provider: 'dsh', model: 'm',
  }, {})), 'proxy_denied');

  const symboled = { provider: 'dsh', model: 'm' };
  symboled[Symbol('extra')] = 1;
  expectCode(() => resolveRegistrySelectionV1(symboled), 'symbol_key_denied');

  const sparse = [];
  sparse[3] = 'x';
  expectCode(() => resolveRegistrySelectionV1(sparse), 'invalid_type');

  const forgedProto = { provider: 'dsh', model: 'm' };
  Object.defineProperty(forgedProto, '__proto__', { value: {}, enumerable: true });
  expectCode(() => resolveRegistrySelectionV1(forgedProto), 'unknown_key');

  const cyclic = { model: 'm' };
  cyclic.provider = cyclic;
  expectCode(() => resolveRegistrySelectionV1(cyclic), 'unknown_provider',
    'a cyclic alias is not a closed slot and never walks values');
});

test('exported snapshots are frozen and detached from gating authority', () => {
  assert.ok(Object.isFrozen(PROVIDER_REGISTRY_SLOTS));
  assert.throws(() => PROVIDER_REGISTRY_SLOTS.push('future-harness'), TypeError);
  const slotsCopy = registrySlotsV1();
  assert.ok(Object.isFrozen(slotsCopy));
  assert.throws(() => slotsCopy.push('x'), TypeError);
  // Mutating a returned entry fails and cannot poison later lookups.
  const entry = registryEntryV1('grok');
  assert.throws(() => {
    entry.adapter_schema_id = 'codex-co-engineer.evil.v1';
  }, TypeError);
  assert.equal(registryEntryV1('grok').adapter_schema_id,
    PRISTINE_DESCRIPTION.entries.grok.adapter_schema_id);
});

test('inventory stays deterministic after a gauntlet of hostile failures', () => {
  for (const hostile of ['nope', 42, null]) {
    try {
      composeProviderDriverV1(hostile, undefined);
    } catch {
      // expected typed denials; ignore which code fired
    }
    try {
      composeProviderDriverV1('grok', new Proxy({}, {}));
    } catch {
      // expected
    }
    try {
      resolveRegistrySelectionV1({ provider: 'dsh', model: Symbol('x') });
    } catch {
      // expected
    }
  }
  assert.deepEqual(describeProviderRegistryV1(), PRISTINE_DESCRIPTION,
    'failed hostilities must leave the closed inventory byte-identical');
});

test('the P22 template surface can never be selected or composed as a provider', () => {
  for (const pseudo of [
    'future-harness', 'future_harness', 'template', 'conformance', 'harness',
    'codex-co-engineer.future-harness-template.v1',
  ]) {
    expectCode(() => requireRegistrySlotV1(pseudo), 'unknown_provider');
    expectCode(() => composeProviderDriverV1(pseudo, { identity: {}, declaration: {} }),
      'unknown_provider');
    expectCode(() => resolveRegistrySelectionV1({ provider: pseudo, model: 'm' }),
      'unknown_provider');
  }
  const description = describeProviderRegistryV1();
  assert.deepEqual([...description.slots], [...PRISTINE_DESCRIPTION.slots]);
});

test('registry exports are frozen function surfaces', () => {
  assert.ok(Object.isFrozen(composeProviderDriverV1));
  assert.ok(Object.isFrozen(describeProviderRegistryV1));
  assert.ok(Object.isFrozen(resolveRegistrySelectionV1));
  assert.ok(Object.isFrozen(requireRegistrySlotV1));
});
