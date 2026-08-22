import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_PROFILES_PER_CATALOG,
  PROFILE_SCHEMA,
  canonicalProfileJson,
  loadProfiles,
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
