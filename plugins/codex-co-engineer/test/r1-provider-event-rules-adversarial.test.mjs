// Hostile provider-event-rules coverage: accessors, proxies, prototype
// pollution, identity spoofing, and getter non-execution.

import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import {
  applyProviderEventRulesV1,
  compileProviderEventRulesV1,
  createProviderEventRulesEngineV1,
  parseProviderEventIdentityV1,
} from '../mcp/v3/provider-event-rules.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  HOSTILE_SECRET,
  IDENTITY,
  applyInput,
  assistantEvent,
  countingProxy,
  defineAccessor,
  progressRules,
  trapTotal,
} from './fixtures/r1-provider-event-rules-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertContentFree(error) {
  const text = `${error.message}\n${error.path}\n${error.code}`;
  assert.equal(text.includes(HOSTILE_SECRET), false, 'error echoed hostile getter content');
  assert.equal(text.includes('sk-live'), false);
  assert.equal(utilTypes.isProxy(error), false);
}

test('option proxies are denied without dispatching traps', () => {
  const proxied = countingProxy(applyInput());
  const error = errorOf(() => applyProviderEventRulesV1(proxied.proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.equal(trapTotal(proxied.counts), 0);
  assertContentFree(error);
});

test('source proxies are denied without traps', () => {
  const source = countingProxy([assistantEvent()]);
  const error = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: source.proxy,
  })));
  assert.equal(error.code, 'proxy_denied');
  assert.equal(trapTotal(source.counts), 0);
});

test('revoked proxies fail closed as proxy_denied', () => {
  const { proxy, revoke } = Proxy.revocable({ ...applyInput() }, {});
  revoke();
  const error = errorOf(() => applyProviderEventRulesV1(proxy));
  assert.equal(error.code, 'proxy_denied');
});

test('source getters are never executed', () => {
  let reads = 0;
  const options = {
    rules: progressRules(),
    identity: { ...IDENTITY },
  };
  Object.defineProperty(options, 'source', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error(`trap ${HOSTILE_SECRET}`);
    },
  });
  const error = errorOf(() => applyProviderEventRulesV1(options));
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(reads, 0);
  assertContentFree(error);
});

test('nested event getters are rejected from descriptors without running', () => {
  let reads = 0;
  const hostile = defineAccessor(assistantEvent(), 'text', () => {
    reads += 1;
    throw new Error(`trap ${HOSTILE_SECRET}`);
  });
  const error = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: [hostile],
  })));
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(reads, 0);
  assertContentFree(error);
});

test('identity getters never run and cannot spoof attempt fencing', () => {
  let reads = 0;
  const identity = defineAccessor({ ...IDENTITY }, 'attempt', () => {
    reads += 1;
    return 1;
  });
  const applyError = errorOf(() => applyProviderEventRulesV1(applyInput({
    identity,
    rules: progressRules(),
  })));
  assert.equal(applyError.code, 'accessor_property_denied');
  assert.equal(reads, 0);

  const parseError = errorOf(() => parseProviderEventIdentityV1(identity));
  assert.equal(parseError.code, 'accessor_property_denied');
  assert.equal(reads, 0);
});

test('reply-bridge getters are denied before submit can run', () => {
  let reads = 0;
  let submits = 0;
  const options = applyInput({ rules: progressRules() });
  Object.defineProperty(options, 'reply_bridge', {
    enumerable: true,
    get() {
      reads += 1;
      return {
        submit() {
          submits += 1;
          return { ok: true };
        },
      };
    },
  });
  const error = errorOf(() => applyProviderEventRulesV1(options));
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(reads, 0);
  assert.equal(submits, 0);
});

test('prototype keys, symbols, and exotic prototypes fail closed', () => {
  const proto = errorOf(() => compileProviderEventRulesV1({
    schema: 'codex-co-engineer.provider-event-rules.v1',
    version: 1,
    rules: [{
      id: 'assistant-text',
      kind: 'text',
      type: 'assistant',
      type_path: '/type',
      value_path: '/text',
      __proto__: { id: 'pwn' },
    }],
  }));
  assert.ok(['prototype_key_denied', 'invalid_type', 'exotic_prototype_denied'].includes(proto.code), proto.code);

  const withSymbol = applyInput({ rules: progressRules() });
  withSymbol[Symbol('secret')] = HOSTILE_SECRET;
  const symbolError = errorOf(() => applyProviderEventRulesV1(withSymbol));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assertContentFree(symbolError);

  const exotic = Object.assign(Object.create({ inherited: true }), applyInput({
    rules: progressRules(),
  }));
  const exoticError = errorOf(() => applyProviderEventRulesV1(exotic));
  assert.ok(['exotic_prototype_denied', 'invalid_type'].includes(exoticError.code), exoticError.code);
});

test('aliased event graphs and array holes fail closed', () => {
  const shared = { nested: 'x' };
  const aliased = { type: 'assistant', text: 'ok', a: shared, b: shared };
  const aliasError = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: [aliased],
  })));
  assert.equal(aliasError.code, 'aliased_reference_denied');

  const sparse = [];
  sparse[1] = assistantEvent();
  const sparseError = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: sparse,
  })));
  assert.ok(['invalid_array', 'non_enumerable_property_denied', 'accessor_property_denied'].includes(sparseError.code),
    sparseError.code);
});

test('JSON Pointer prototype segments are denied', () => {
  const error = errorOf(() => compileProviderEventRulesV1({
    schema: 'codex-co-engineer.provider-event-rules.v1',
    version: 1,
    rules: [{
      id: 'proto-path',
      kind: 'text',
      type: 'assistant',
      type_path: '/__proto__',
      value_path: '/text',
    }],
  }));
  assert.equal(error.code, 'prototype_key_denied');
});

test('engine apply still fences identity after a prior successful generation', () => {
  const engine = createProviderEventRulesEngineV1({
    rules: progressRules(),
    identity: IDENTITY,
  });
  engine.apply([assistantEvent('ok')]);
  const spoofed = errorOf(() => engine.apply([assistantEvent('nope', {
    provider: 'dsh',
  })]));
  assert.equal(spoofed.code, 'identity_mismatch');
});
