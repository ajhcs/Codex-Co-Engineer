import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_PROFILES_PER_CATALOG,
  PROFILE_SCHEMA,
  canonicalProfileJson,
  findProfile,
  loadProfiles,
  profileProvenanceDigest,
  profileRoots,
  validateProfileDefinition,
} from '../mcp/v3/profile.mjs';

// Adversarial ProfileV1 suite (P01 profiles_data_only). Every case here is a
// rejection: profiles are data-only selection records, and nothing below may
// become loadable configuration.

const base = () => ({ schema: PROFILE_SCHEMA, provider: 'dsh' });
const withSchema = (extra) => ({ ...base(), ...extra });

const catalogCases = (name, extra) => ({ [name]: withSchema(extra) });

// Returns { options, write, cleanup }; callers wrap bodies in try/finally.
async function rejectingWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-profile-adv-'));
  const options = {
    repositoryPath: path.join(root, 'repo'),
    ownerConfigDir: path.join(root, 'owner-config'),
  };
  await mkdir(options.repositoryPath, { recursive: true });
  await mkdir(options.ownerConfigDir, { recursive: true });
  const catalogPath = path.join(options.repositoryPath, '.codex', 'co-engineer-profiles.json');
  const write = async (value) => {
    await mkdir(path.dirname(catalogPath), { recursive: true });
    const target = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    await writeFile(catalogPath, target);
    return catalogPath;
  };
  return {
    root,
    options,
    catalogPath,
    write,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const expectCode = (code, label) => (error) => {
  assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}: ${error.message}`);
  return true;
};

test('credential keys and secret-shaped values are rejected', async () => {
  const workspace = await rejectingWorkspace();
  try {
const cases = [
  ['api_key key', catalogCases('leak', { api_key: 'x' }), 'profile_credential_key_rejected'],
  ['API-KEY folding', catalogCases('leak', { 'API-KEY': 'x' }), 'profile_credential_key_rejected'],
  ['token key', catalogCases('leak', { token: 'x' }), 'profile_credential_key_rejected'],
  ['secret key', catalogCases('leak', { client_secret: 'x' }), 'profile_credential_key_rejected'],
  ['password key', catalogCases('leak', { password: 'x' }), 'profile_credential_key_rejected'],
  ['private key', catalogCases('leak', { private_key_pem: 'x' }), 'profile_credential_key_rejected'],
  ['authorization key', catalogCases('leak', { Authorization: 'Bearer x' }), 'profile_credential_key_rejected'],
  ['sk- value', catalogCases('leak', { model: 'sk-proj-abcdefgh' }), 'profile_secret_value_rejected'],
  ['xox value', catalogCases('leak', { model: 'xoxb-1234567890' }), 'profile_secret_value_rejected'],
  ['github token value', catalogCases('leak', { model: 'ghp_1234567890abcdef12' }), 'profile_secret_value_rejected'],
  ['bearer value', catalogCases('leak', { model: 'Bearer abcdefghijklmno' }), 'profile_secret_value_rejected'],
  ['hex digest value', catalogCases('leak', { model: 'a'.repeat(64) }), 'profile_secret_value_rejected'],
  ['base64 value', catalogCases('leak', { model: `${'Aa1/'.repeat(15)}Aa1` }), 'profile_secret_value_rejected'],
  ['nested secret value', catalogCases('leak', { role: 'review', metadata: { token: 'sk-abcdefgh' } }), 'profile_secret_value_rejected'],
  ['nested unknown field', catalogCases('leak', { role: 'review', metadata: { anything: 'x' } }), 'unknown_profile_field'],
];
for (const [label, catalog, code] of cases) {
  await workspace.write(catalog);
  await assert.rejects(() => loadProfiles(workspace.options), expectCode(code, label), label);
}
  } finally {
    await workspace.cleanup();
  }
});

test('environment interpolation and env catalogs are rejected', async () => {
  const workspace = await rejectingWorkspace();
  try {
const cases = [
  ['braced variable', catalogCases('env', { model: '${DSH_MODEL}' })],
  ['bare variable', catalogCases('env', { model: '$HOME/models' })],
  ['windows variable', catalogCases('env', { model: '%PATH%models' })],
  ['command substitution', catalogCases('env', { model: 'a$(whoami)b' })],
  ['backtick substitution', catalogCases('env', { model: 'a`whoami`b' })],
  ['env key', catalogCases('env', { env: { MODEL_API_KEY: 'x' } }), 'profile_environment_key_rejected'],
  ['environment key', catalogCases('env', { environment: ['CI'] }), 'profile_environment_key_rejected'],
  ['dotenv key', catalogCases('env', { env_file: '.env' }), 'profile_environment_key_rejected'],
  ['policy env allowlist', catalogCases('env', { policy: { environment_allowlist: ['CI'] } }), 'profile_executable_key_rejected'],
];
for (const [label, catalog, code = 'profile_environment_value_rejected'] of cases) {
  await workspace.write(catalog);
  await assert.rejects(() => loadProfiles(workspace.options), expectCode(code, label), label);
}
  } finally {
    await workspace.cleanup();
  }
});

test('argv, executables, shell strings, and command catalogs are rejected', async () => {
  const workspace = await rejectingWorkspace();
  try {
const verificationPolicyShape = {
  commands: [{
    command_id: 'unit-tests',
    executable: '/usr/bin/npm',
    argv_template: ['test'],
    working_directory: 'candidate_root',
    timeout_ms: 600000,
    environment_allowlist: ['CI'],
    network: 'deny',
  }],
};
const cases = [
  ['executable key', catalogCases('exec', { executable: '/usr/bin/npm' }), 'profile_executable_key_rejected'],
  ['command key', catalogCases('exec', { command: 'npm test' }), 'profile_executable_key_rejected'],
  ['argv key', catalogCases('exec', { argv: ['npm', 'test'] }), 'profile_executable_key_rejected'],
  ['args key', catalogCases('exec', { args: '--run' }), 'profile_executable_key_rejected'],
  ['argv_template key', catalogCases('exec', { argv_template: ['test', '{file}'] }), 'profile_executable_key_rejected'],
  ['shell key', catalogCases('exec', { shell: true }), 'profile_executable_key_rejected'],
  ['shell string value', catalogCases('exec', { role: 'review', model: '/bin/bash' }), 'profile_shell_value_rejected'],
  ['script key', catalogCases('exec', { script: 'echo hi' }), 'profile_executable_key_rejected'],
  ['entrypoint key', catalogCases('exec', { entrypoint: true }), 'profile_executable_key_rejected'],
  ['entrypoint shell value', catalogCases('exec', { role: 'review', model: '/bin/sh -c ls' }), 'profile_shell_value_rejected'],
  ['runner key', catalogCases('exec', { runner_command: ['x'] }), 'profile_executable_key_rejected'],
  ['timeout key', catalogCases('exec', { timeout_ms: 1000 }), 'profile_executable_key_rejected'],
  ['network key', catalogCases('exec', { network: 'allow' }), 'profile_executable_key_rejected'],
  ['verification policy key', catalogCases('exec', { verification_policy: verificationPolicyShape }), 'profile_executable_key_rejected'],
  ['folded VerificationPolicyV1 shape', catalogCases('exec', { 'verification-policy': verificationPolicyShape }), 'profile_executable_key_rejected'],
  ['policy command catalog', catalogCases('exec', { policy: { commands: verificationPolicyShape.commands } }), 'profile_executable_key_rejected'],
  ['policy command id', catalogCases('exec', { policy: { command_catalog: { 'unit-tests': {} } } }), 'profile_executable_key_rejected'],
  ['shell metachar value', catalogCases('exec', { model: 'a && b' }), 'profile_shell_value_rejected'],
  ['pipe value', catalogCases('exec', { model: 'a | b' }), 'profile_shell_value_rejected'],
  ['redirect value', catalogCases('exec', { model: '> /tmp/out' }), 'profile_shell_value_rejected'],
  ['shell word value', catalogCases('exec', { model: 'run with bash -c' }), 'profile_shell_value_rejected'],
  ['shebang value', catalogCases('exec', { model: '#!/bin/sh' }), 'profile_shell_value_rejected'],
  ['sudo value', catalogCases('exec', { model: 'sudo npm i' }), 'profile_shell_value_rejected'],
];
for (const [label, catalog, code] of cases) {
  await workspace.write(catalog);
  await assert.rejects(() => loadProfiles(workspace.options), expectCode(code, label), label);
}
  } finally {
    await workspace.cleanup();
  }
});

test('direct-mode configuration and merge/push/PR authority are rejected', async () => {
  const workspace = await rejectingWorkspace();
  try {
const cases = [
  ['workspace_mode direct', catalogCases('auth', { workspace_mode: 'direct' }), 'profile_direct_mode_key_rejected'],
  ['workspace_mode managed', catalogCases('auth', { workspace_mode: 'managed' }), 'profile_direct_mode_key_rejected'],
  ['workspace key', catalogCases('auth', { workspace: '/tmp/x' }), 'profile_direct_mode_key_rejected'],
  ['worktree key', catalogCases('auth', { worktree: '/tmp/wt' }), 'profile_direct_mode_key_rejected'],
  ['merge key', catalogCases('auth', { merge: true }), 'profile_authority_key_rejected'],
  ['allow_merge key', catalogCases('auth', { allow_merge: true }), 'profile_authority_key_rejected'],
  ['push key', catalogCases('auth', { push: 'origin' }), 'profile_authority_key_rejected'],
  ['create_pr key', catalogCases('auth', { create_pr: true }), 'profile_authority_key_rejected'],
  ['auto_create_pr key', catalogCases('auth', { auto_create_pr: false }), 'profile_authority_key_rejected'],
  ['protected refs key', catalogCases('auth', { protected_refs: [] }), 'profile_authority_key_rejected'],
  ['default branch key', catalogCases('auth', { default_branch: 'release' }), 'profile_authority_key_rejected'],
];
for (const [label, catalog, code] of cases) {
  await workspace.write(catalog);
  await assert.rejects(() => loadProfiles(workspace.options), expectCode(code, label), label);
}
  } finally {
    await workspace.cleanup();
  }
});

test('moving refs and embedded prompt/result content are rejected', async () => {
  const workspace = await rejectingWorkspace();
  try {
const cases = [
  ['refs value', catalogCases('ref', { model: 'refs/heads/main' }), 'profile_moving_ref_value_rejected'],
  ['origin value', catalogCases('ref', { model: 'origin/main' }), 'profile_moving_ref_value_rejected'],
  ['HEAD value', catalogCases('ref', { model: 'HEAD' }), 'profile_moving_ref_value_rejected'],
  ['latest value', catalogCases('ref', { model: 'latest' }), 'profile_moving_ref_value_rejected'],
  ['main value', catalogCases('ref', { model: 'main' }), 'profile_moving_ref_value_rejected'],
  ['ref key', catalogCases('ref', { starting_ref: 'abc' }), 'profile_moving_ref_key_rejected'],
  ['branch key', catalogCases('ref', { branch: 'release' }), 'profile_moving_ref_key_rejected'],
  ['remote key', catalogCases('ref', { remote: 'origin' }), 'profile_moving_ref_key_rejected'],
  ['prompt key', catalogCases('content', { prompt: 'Review the diff.' }), 'profile_embedded_content_key_rejected'],
  ['prompt_template key', catalogCases('content', { prompt_template: 'Review {x}' }), 'profile_embedded_content_key_rejected'],
  ['messages key', catalogCases('content', { messages: [] }), 'profile_embedded_content_key_rejected'],
  ['system key', catalogCases('content', { system: 'You are a reviewer.' }), 'profile_embedded_content_key_rejected'],
  ['instructions key', catalogCases('content', { instructions: 'Do X.' }), 'profile_embedded_content_key_rejected'],
  ['result key', catalogCases('content', { result: 'PASS' }), 'profile_embedded_content_key_rejected'],
  ['output key', catalogCases('content', { output: 'logs' }), 'profile_embedded_content_key_rejected'],
  ['response key', catalogCases('content', { response: 'text' }), 'profile_embedded_content_key_rejected'],
  ['notes key', catalogCases('content', { notes: 'why' }), 'profile_embedded_content_key_rejected'],
];
for (const [label, catalog, code] of cases) {
  await workspace.write(catalog);
  await assert.rejects(() => loadProfiles(workspace.options), expectCode(code, label), label);
}
  } finally {
    await workspace.cleanup();
  }
});

test('catalog-level attacks stay fail-closed', async () => {
  const workspace = await rejectingWorkspace();
  try {
const { options, write, cleanup } = workspace;

const dupJson = `{"ok-profile":{"schema":"${PROFILE_SCHEMA}"},"ok-profile":{"schema":"${PROFILE_SCHEMA}"}}`;
await write(dupJson);
await assert.rejects(() => loadProfiles(options), expectCode('duplicate_profile_key', 'literal duplicate keys'));

await write(`\uFEFF{"ok-profile":{"schema":"${PROFILE_SCHEMA}"}}`);
await assert.rejects(() => loadProfiles(options), expectCode('invalid_profile_catalog_json', 'BOM-prefixed JSON'));

const protoJson = `{"__proto__":${JSON.stringify(base())},"ok-profile":${JSON.stringify(base())}}`;
await write(protoJson);
await assert.rejects(() => loadProfiles(options), expectCode('invalid_profile_name', 'proto key'));

const ownerDir = path.join(options.ownerConfigDir, 'codex-co-engineer');
const ownerCatalog = path.join(ownerDir, 'profiles.json');
await mkdir(ownerDir, { recursive: true });
await writeFile(ownerCatalog, JSON.stringify({ 'owner-profile': base() }));
await chmod(ownerDir, 0o700);
await chmod(ownerCatalog, 0o600);
await symlink(ownerCatalog, `${ownerCatalog}.link`);
await rm(ownerCatalog);
await symlink(ownerCatalog, ownerCatalog);
await assert.rejects(() => loadProfiles(options), expectCode('profile_catalog_not_regular', 'symlinked owner catalog'));
await rm(ownerCatalog);

await rm(ownerDir, { recursive: true });
await symlink(path.join(options.ownerConfigDir, 'elsewhere'), ownerDir);
await assert.rejects(() => loadProfiles(options), expectCode('profile_catalog_not_regular', 'symlinked owner directory'));
await rm(ownerDir);

await cleanup();
  } finally {
    await workspace.cleanup();
  }
});

test('validateProfileDefinition is a pure fail-closed gate', () => {
  const validated = validateProfileDefinition('gate-check', withSchema({
    role: 'review',
    policy: { pre_dispatch_provider_preference: ['grok', 'dsh'] },
  }));
  assert.deepEqual(validated,
    withSchema({ role: 'review', policy: { pre_dispatch_provider_preference: ['grok', 'dsh'] } }));
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.policy));
  assert.ok(Object.isFrozen(validated.policy.pre_dispatch_provider_preference));
  assert.throws(() => validated.policy.pre_dispatch_provider_preference.push('cursor-local'), TypeError);
  assert.throws(() => validateProfileDefinition('Gate-Check', base()), expectCode('invalid_profile_name', 'uppercase name'));
  assert.doesNotThrow(() => validateProfileDefinition('x'.repeat(64), base()));
  assert.throws(() => validateProfileDefinition('x'.repeat(65), base()), expectCode('invalid_profile_name', 'over-long name'));
  for (const bad of [null, [], 'profile', 7]) {
    assert.throws(
      () => validateProfileDefinition('gate-check', bad),
      expectCode('invalid_profile_definition', typeof bad),
    );
  }
});

test('value-scan diagnostics identify the offending nested field', () => {
  assert.throws(
    () => validateProfileDefinition('diagnostic-path', withSchema({
      policy: { nested: { token_value: 'sk-abcdefghijk' } },
    })),
    (error) => error.code === 'profile_secret_value_rejected'
      && error.message.includes('field profile.policy.nested.token_value'),
  );
});

test('direct validation rejects active properties, exotic prototypes, aliases, and malformed arrays', () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'schema', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return PROFILE_SCHEMA;
    },
  });
  assert.throws(
    () => validateProfileDefinition('accessor', accessor),
    expectCode('invalid_profile_definition', 'accessor'),
  );
  assert.equal(getterCalls, 0, 'validation must inspect descriptors without invoking getters');

  const customPrototype = Object.assign(Object.create({ inherited: true }), base());
  assert.throws(
    () => validateProfileDefinition('custom-prototype', customPrototype),
    expectCode('invalid_profile_definition', 'custom prototype'),
  );

  const symbolProperty = base();
  symbolProperty[Symbol('secret')] = 'hidden';
  assert.throws(
    () => validateProfileDefinition('symbol-property', symbolProperty),
    expectCode('invalid_profile_definition', 'symbol property'),
  );

  const sparsePreference = new Array(1);
  assert.throws(
    () => validateProfileDefinition('sparse-array', withSchema({
      policy: { pre_dispatch_provider_preference: sparsePreference },
    })),
    expectCode('invalid_profile_data_value', 'sparse preference'),
  );

  const shared = {};
  const aliased = withSchema({ first: shared, second: shared });
  assert.throws(
    () => validateProfileDefinition('aliased', aliased),
    expectCode('invalid_profile_data_graph', 'shared object identity'),
  );

  const nullPrototype = Object.assign(Object.create(null), base());
  assert.deepEqual(validateProfileDefinition('null-prototype', nullPrototype), base());
});

test('canonical profile encoding rejects unsupported graphs and values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalProfileJson(cyclic),
    expectCode('invalid_profile_canonical_data', 'canonical cycle'),
  );
  assert.throws(
    () => canonicalProfileJson(undefined),
    expectCode('invalid_profile_canonical_data', 'canonical undefined'),
  );
  const secretName = `INVALID-${'s'.repeat(10_000)}`;
  assert.throws(
    () => validateProfileDefinition(secretName, base()),
    (error) => error.code === 'invalid_profile_name' && !error.message.includes('ssssssss'),
  );
});

// ---------------------------------------------------------------------------
// P04 remediation: the direct-JavaScript Proxy boundary. Every exported
// surface must consume static data only. Live Proxies are rejected before any
// handler trap fires, revoked Proxies never reach Array.isArray or other
// target-inspecting builtins, and every failure carries a typed code.

const TRAP_NAMES = Object.freeze([
  'apply', 'construct', 'defineProperty', 'deleteProperty', 'get',
  'getOwnPropertyDescriptor', 'getPrototypeOf', 'has', 'isExtensible',
  'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf',
]);

// Module-global so the closing test can assert the exact total.
const observedTraps = Object.fromEntries(TRAP_NAMES.map((trap) => [trap, 0]));
let proxyCallsObserved = 0;

function countingHandler() {
  const handler = {};
  for (const trap of TRAP_NAMES) {
    handler[trap] = (...args) => {
      observedTraps[trap] += 1;
      proxyCallsObserved += 1;
      return Reflect[trap](...args);
    };
  }
  return handler;
}

const transparentProxyOf = (target) => new Proxy(target, countingHandler());

function rejectTyped(run, label) {
  try {
    run();
  } catch (error) {
    assert.equal(error.code, 'profile_proxy_rejected', `${label}: expected the typed proxy code`);
    assert.ok(!(error instanceof TypeError), `${label}: must never surface a native TypeError`);
    assert.doesNotMatch(error.message, /trap-boom/u, `${label}: trap errors must not escape`);
    assert.match(error.message, /Proxy/u, `${label}: the message must name the rejected view`);
    return;
  }
  assert.fail(`${label}: expected a typed rejection`);
}

test('live Proxies are rejected before a single trap fires on every direct-JS surface', async () => {
  const proxyDefinition = transparentProxyOf(withSchema({ role: 'review' }));

  const syncSurfaces = [
    ['validateProfileDefinition', () => validateProfileDefinition('transparent', proxyDefinition)],
    ['canonicalProfileJson', () => canonicalProfileJson(proxyDefinition)],
    ['profileProvenanceDigest', () => profileProvenanceDigest({ name: 'transparent', definition: proxyDefinition })],
    ['findProfile(loaded)', () => findProfile(transparentProxyOf({ profiles: [] }), 'anything')],
    ['findProfile(list)', () => findProfile({ profiles: transparentProxyOf([]) }, 'anything')],
    ['findProfile(record)', () => findProfile({ profiles: [transparentProxyOf(withSchema({}))] }, 'x')],
    ['profileRoots(options)', () => profileRoots(transparentProxyOf({ repositoryPath: '/repo' }))],
    ['profileRoots(env)', () => profileRoots({ repositoryPath: '/repo', env: transparentProxyOf(process.env) })],
    ['nested proxy array', () => validateProfileDefinition('nested-array', withSchema({
      policy: { pre_dispatch_provider_preference: transparentProxyOf(['dsh']) },
    }))],
    ['nested proxy policy object', () => validateProfileDefinition('nested-object', withSchema({
      policy: transparentProxyOf({ pre_dispatch_provider_preference: ['dsh'] }),
    }))],
    ['deeply nested proxy element', () => validateProfileDefinition('deep-nested', withSchema({
      policy: { pre_dispatch_provider_preference: [transparentProxyOf({})] },
    }))],
  ];
  for (const [label, run] of syncSurfaces) rejectTyped(run, label);

  await assert.rejects(
    () => loadProfiles(transparentProxyOf({ repositoryPath: '/repo', ownerConfigDir: '/owner-config' })),
    expectCode('profile_proxy_rejected', 'loadProfiles(options)'),
  );

  // Transparent forwarding still exists for ordinary consumers elsewhere:
  // the boundary scopes profile surfaces, not a global Proxy ban. This probe
  // deliberately uses an uncounted proxy so the zero-trap ledger above stays exact.
  assert.equal(new Proxy({ profiles: [] }, {}).profiles.length, 0);
});

test('stateful descriptor-forging views cannot hide credentials, argv, or merge authority', () => {
  // If any trap were consulted, this view alternates between a clean facade
  // and a credential-bearing reality, and its descriptors disagree with what
  // later property reads return - exactly the behavior that hid content from
  // validation while serving it to dispatch.
  let phase = 0;
  const forged = new Proxy({}, {
    ownKeys() {
      phase += 1;
      return phase % 2 === 1
        ? ['schema', 'provider']
        : ['schema', 'provider', 'api_key', 'argv', 'merge_authority'];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (phase % 2 === 1 && (key === 'schema' || key === 'provider')) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: key === 'schema' ? PROFILE_SCHEMA : 'dsh',
        };
      }
      return { configurable: true, enumerable: true, writable: true, value: 'sk-hidden-secret' };
    },
    get(_target, key) {
      if (key === 'schema') return PROFILE_SCHEMA;
      if (key === 'provider') return 'dsh';
      return 'sk-hidden-secret';
    },
    getPrototypeOf() { return Object.prototype; },
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    rejectTyped(() => validateProfileDefinition('forging', forged), `forging validation ${attempt}`);
    rejectTyped(() => canonicalProfileJson(forged), `forging canonical ${attempt}`);
    rejectTyped(() => profileProvenanceDigest({ name: 'forging', definition: forged }),
      `forging digest ${attempt}`);
  }
  // Every attempt saw the same typed rejection because no observation ever
  // reached the view - which also means phase stayed untouched by the module.
});

test('throwing-trap and revoked Proxies fail typed, and never reach native TypeErrors', () => {
  const hostile = new Proxy(withSchema({ role: 'review' }), {
    getPrototypeOf() { throw new Error('trap-boom'); },
    ownKeys() { throw new Error('trap-boom'); },
    getOwnPropertyDescriptor() { throw new Error('trap-boom'); },
    get() { throw new Error('trap-boom'); },
    has() { throw new Error('trap-boom'); },
    isExtensible() { throw new Error('trap-boom'); },
  });
  rejectTyped(() => validateProfileDefinition('hostile', hostile), 'hostile definition');
  rejectTyped(() => canonicalProfileJson(hostile), 'hostile canonical');
  rejectTyped(() => profileProvenanceDigest({ name: 'hostile', definition: hostile }), 'hostile digest');

  const revokedObject = Proxy.revocable(withSchema({ role: 'review' }), {});
  revokedObject.revoke();
  const revokedArray = Proxy.revocable(['dsh'], {});
  revokedArray.revoke();

  rejectTyped(() => validateProfileDefinition('revoked', revokedObject.proxy), 'revoked definition');
  rejectTyped(() => canonicalProfileJson(revokedObject.proxy), 'revoked canonical root');
  rejectTyped(() => profileProvenanceDigest({ name: 'revoked', definition: revokedObject.proxy }),
    'revoked digest input');
  rejectTyped(() => validateProfileDefinition('revoked-preference', withSchema({
    policy: { pre_dispatch_provider_preference: revokedArray.proxy },
  })), 'revoked nested array');
  rejectTyped(() => findProfile(Object.freeze({ profiles: revokedArray.proxy }), 'any'),
    'revoked profile list');
  // Matching lookup records are revalidated and detached; a caller cannot
  // smuggle a revoked or live nested definition through a fabricated
  // loadProfiles-shaped record and trigger it downstream.
  const fabricatedRecord = Object.freeze({
    name: 'any',
    scope: 'project',
    source: '/repo/.codex/co-engineer-profiles.json',
    definition: revokedObject.proxy,
    digest: `sha256:${'0'.repeat(64)}`,
  });
  rejectTyped(() => findProfile({ profiles: [fabricatedRecord] }, 'any'),
    'revoked matching record definition');

  let nestedDefinitionTraps = 0;
  const trappedDefinition = new Proxy(withSchema({}), {
    getPrototypeOf() { nestedDefinitionTraps += 1; throw new Error('trap-boom'); },
    ownKeys() { nestedDefinitionTraps += 1; throw new Error('trap-boom'); },
    getOwnPropertyDescriptor() { nestedDefinitionTraps += 1; throw new Error('trap-boom'); },
    get() { nestedDefinitionTraps += 1; throw new Error('trap-boom'); },
  });
  rejectTyped(() => findProfile({ profiles: [{
    name: 'any',
    scope: 'project',
    source: '/repo/.codex/co-engineer-profiles.json',
    definition: trappedDefinition,
    digest: `sha256:${'0'.repeat(64)}`,
  }] }, 'any'), 'live matching record definition');
  assert.equal(nestedDefinitionTraps, 0,
    'nested definition rejection must occur before a single handler trap fires');
  rejectTyped(() => profileRoots((() => {
    const options = Proxy.revocable({ repositoryPath: '/repo' }, {});
    options.revoke();
    return options.proxy;
  })()), 'revoked roots arguments');

  // The hazard this ordering defends against: these operations really do
  // throw natively on revoked targets.
  assert.throws(() => Array.isArray(revokedArray.proxy), TypeError);
  assert.throws(() => Object.getOwnPropertyDescriptors(revokedObject.proxy), TypeError);
});

test('hidden non-enumerable, accessor, and symbol-keyed content cannot reach a digest', () => {
  const hiddenProperty = withSchema({});
  Object.defineProperty(hiddenProperty, 'api_key', { enumerable: false, value: 'sk-hidden' });
  assert.throws(
    () => validateProfileDefinition('hidden', hiddenProperty),
    expectCode('invalid_profile_definition', 'non-enumerable key'),
  );
  assert.throws(
    () => profileProvenanceDigest({ name: 'hidden', definition: hiddenProperty }),
    expectCode('invalid_profile_definition', 'non-enumerable key digest'),
  );

  let accessorReads = 0;
  const accessorView = withSchema({});
  Object.defineProperty(accessorView, 'role', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'review';
    },
  });
  assert.throws(
    () => profileProvenanceDigest({ name: 'accessor', definition: accessorView }),
    expectCode('invalid_profile_definition', 'accessor key'),
  );
  assert.equal(accessorReads, 0, 'digest gating must inspect descriptors without invoking getters');

  const symbolKeyed = withSchema({});
  symbolKeyed[Symbol('merge_authority')] = true;
  assert.throws(
    () => profileProvenanceDigest({ name: 'symbolic', definition: symbolKeyed }),
    expectCode('invalid_profile_definition', 'symbol key'),
  );

  // Arbitrary content is never digestible: full ProfileV1 validation gates
  // the provenance identity.
  assert.throws(
    () => profileProvenanceDigest({ name: 'laundered', definition: withSchema({ api_key: 'sk-x' }) }),
    expectCode('profile_credential_key_rejected', 'credential laundering'),
  );
  assert.throws(
    () => profileProvenanceDigest({
      name: 'laundered',
      definition: withSchema({ unknown_field: 1 }),
    }),
    expectCode('unknown_profile_field', 'unknown-field laundering'),
  );

  // Payload bags themselves are snapshotted too: an accessor payload is
  // rejected instead of dereferenced.
  let payloadReads = 0;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'name', {
    enumerable: true,
    get() {
      payloadReads += 1;
      return 'stable';
    },
  });
  Object.defineProperty(accessorPayload, 'definition', { enumerable: true, value: withSchema({}) });
  assert.throws(
    () => profileProvenanceDigest(accessorPayload),
    expectCode('invalid_profile_provenance_payload', 'accessor payload'),
  );
  assert.equal(payloadReads, 0);
});

test('digests stay stable across static views of identical validated data', () => {
  const definition = withSchema({
    role: 'implement',
    expected_duration_ms: 1_200_000,
    policy: { pre_dispatch_provider_preference: ['grok', 'dsh'] },
  });
  const baseline = profileProvenanceDigest({ name: 'stable', definition });
  assert.match(baseline, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(baseline,
    profileProvenanceDigest({ name: 'stable', definition: structuredClone(definition) }));
  assert.equal(baseline,
    profileProvenanceDigest({ name: 'stable', definition: JSON.parse(JSON.stringify(definition)) }));
  assert.equal(baseline,
    profileProvenanceDigest({ name: 'stable', definition: deepFrozenClone(definition) }));
  // Key order stays irrelevant.
  assert.equal(baseline, profileProvenanceDigest({
    name: 'stable',
    definition: {
      policy: { pre_dispatch_provider_preference: ['grok', 'dsh'] },
      expected_duration_ms: 1_200_000,
      role: 'implement',
      provider: 'dsh',
      schema: PROFILE_SCHEMA,
    },
  }));

  function deepFrozenClone(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(deepFrozenClone));
    if (value !== null && typeof value === 'object') {
      return Object.freeze(Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, deepFrozenClone(entry)]),
      ));
    }
    return value;
  }
});

test('findProfile consumes load results as one bounded static snapshot', async () => {
  const workspace = await rejectingWorkspace();
  try {
    await workspace.write({ 'find-me': withSchema({ role: 'review' }) });
    const loaded = await loadProfiles(workspace.options);
    const record = findProfile(loaded, 'find-me');
    assert.equal(record.scope, 'project');
    assert.equal(findProfile(loaded, 'missing'), undefined);

    // Accessor results fail typed without reading through getters.
    let getterReads = 0;
    const accessorLoaded = {};
    Object.defineProperty(accessorLoaded, 'profiles', {
      enumerable: true,
      get() {
        getterReads += 1;
        return [];
      },
    });
    assert.throws(
      () => findProfile(accessorLoaded, 'find-me'),
      expectCode('invalid_profile_load_result', 'accessor profiles'),
    );
    assert.equal(getterReads, 0);

    // Malformed records fail closed instead of matching partially.
    for (const badList of [[{ provider: 'dsh' }], [{ name: 7 }], [null], new Array(8)]) {
      assert.throws(
        () => findProfile({ profiles: badList }, 'find-me'),
        expectCode('invalid_profile_load_result', 'malformed record'),
      );
    }

    // The merged two-scope catalog bound is enforced as a typed failure.
    const overSized = Array.from({ length: MAX_PROFILES_PER_CATALOG * 2 + 1 },
      (_unused, index) => ({ name: `filler-${index}` }));
    assert.throws(
      () => findProfile({ profiles: overSized }, 'filler-0'),
      expectCode('profile_structure_too_complex', 'over-large profile list'),
    );
    // At the bound, lookup still works on static records.
    const atBound = Array.from({ length: MAX_PROFILES_PER_CATALOG * 2 },
      (_unused, index) => ({ name: `filler-${index}` }));
    const terminalDefinition = withSchema({ role: 'review' });
    atBound[127] = {
      name: 'filler-127',
      scope: 'project',
      source: '/repo/.codex/co-engineer-profiles.json',
      definition: terminalDefinition,
      digest: profileProvenanceDigest({ name: 'filler-127', definition: terminalDefinition }),
    };
    assert.equal(findProfile({ profiles: atBound }, 'missing'), undefined);
    assert.equal(findProfile({ profiles: atBound }, 'filler-127').name, 'filler-127');
  } finally {
    await workspace.cleanup();
  }
});

test('profileRoots rejects hostile argument views while keeping documented fallback order', async () => {
  const workspace = await rejectingWorkspace();
  try {
    // Accessor-bearing arguments fail typed without dereferencing.
    let optionReads = 0;
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, 'repositoryPath', {
      enumerable: true,
      get() {
        optionReads += 1;
        return '/repo';
      },
    });
    assert.throws(
      () => profileRoots(accessorOptions),
      expectCode('invalid_profile_options', 'accessor options'),
    );
    assert.equal(optionReads, 0);

    // Non-object argument bags stay typed failures, never native TypeErrors.
    assert.throws(() => profileRoots(null), expectCode('invalid_profile_options', 'null options'));
    assert.throws(() => profileRoots(7), expectCode('invalid_profile_options', 'numeric options'));
    assert.throws(
      () => profileRoots({ repositoryPath: '/repo', env: null }),
      expectCode('invalid_profile_environment', 'null environment'),
    );

    let envReads = 0;
    const countingEnv = {
      get XDG_CONFIG_HOME() {
        envReads += 1;
        return '/xdg';
      },
    };
    assert.throws(
      () => profileRoots({ repositoryPath: '/repo', env: countingEnv }),
      expectCode('invalid_profile_environment', 'accessor environment'),
    );
    assert.equal(envReads, 0);

    const loaded = await loadProfiles(workspace.options);
    assert.deepEqual(loaded.profiles.map(({ name }) => name), [],
      'ordinary file loading behavior is unchanged by the boundary');
  } finally {
    await workspace.cleanup();
  }
});

test('the whole Proxy battery observes exactly zero trap calls', () => {
  for (const trap of TRAP_NAMES) {
    assert.equal(observedTraps[trap], 0, `${trap} must never be dispatched`);
  }
  assert.equal(proxyCallsObserved, 0);
});
