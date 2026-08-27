import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IDENTITY_DOMAIN, IDENTITY_LABELS } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  DEFAULT_ENVIRONMENT_RECEIPT,
  DEFAULT_MUTATION_RECEIPT,
  DEFAULT_NETWORK_RECEIPT,
  DEFAULT_RESOURCES_RECEIPT,
  DEFAULT_TIMEOUT_MS,
  VERIFICATION_POLICY_SCHEMA_ID,
  VERIFICATION_POLICY_VERSION,
  canonicalVerificationPolicyJsonV1,
  loadOwnerVerificationPolicyV1,
  parseUntrustedCommandReferenceV1,
  parseVerificationCommandDescriptorV1,
  parseVerificationPolicyV1,
  rejectUntrustedExecutableContentV1,
  verificationCommandDigestV1,
  verificationPolicyDigestV1,
  verificationPolicyRoots,
  verifyVerificationPolicyDigestV1,
} from '../mcp/v3/trusted-verification-policy.mjs';
import {
  validCommand,
  validParameterizedCommand,
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

test('schema identity is additive v1 and does not claim a 4.0.0 major', () => {
  assert.equal(VERIFICATION_POLICY_SCHEMA_ID, 'codex-co-engineer.verification-policy.v1');
  assert.equal(VERIFICATION_POLICY_VERSION, 1);
  assert.equal(VERIFICATION_POLICY_SCHEMA_ID.includes('4.0.0'), false);
});

test('a valid owner policy round-trips into a frozen detached snapshot', () => {
  const input = validPolicy();
  const snapshot = parseVerificationPolicyV1(input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.commands), true);
  assert.equal(Object.isFrozen(snapshot.commands[0]), true);
  assert.equal(snapshot.schema, VERIFICATION_POLICY_SCHEMA_ID);
  assert.equal(snapshot.commands[0].command_id, 'unit-tests');
  assert.equal(snapshot.commands[0].executable, '/usr/bin/npm');
  assert.deepEqual(snapshot.commands[0].argv_template, ['test']);
  input.commands[0].command_id = 'other';
  input.commands[0].executable = '/bin/sh';
  assert.equal(snapshot.commands[0].command_id, 'unit-tests');
  assert.equal(snapshot.commands[0].executable, '/usr/bin/npm');
  assert.equal(Object.isFrozen(input), false);
  assert.throws(() => { snapshot.commands[0].command_id = 'mutated'; }, TypeError);
});

test('canonical identity and digest are deterministic across key and command order', () => {
  const left = validPolicy({
    commands: [validParameterizedCommand(), validCommand()],
  });
  const right = {
    version: 1,
    commands: [validCommand(), validParameterizedCommand()],
    schema: VERIFICATION_POLICY_SCHEMA_ID,
  };
  assert.equal(canonicalVerificationPolicyJsonV1(left), canonicalVerificationPolicyJsonV1(right));
  const digest = verificationPolicyDigestV1(left);
  assert.equal(digest.algorithm, 'sha256');
  assert.equal(digest.domain, IDENTITY_DOMAIN);
  assert.equal(digest.label, IDENTITY_LABELS.VERIFICATION_POLICY);
  assert.match(digest.digest, /^[0-9a-f]{64}$/u);
  assert.equal(verificationPolicyDigestV1(right).digest, digest.digest);
  assert.equal(verifyVerificationPolicyDigestV1(right, digest.digest), true);
  assert.equal(verifyVerificationPolicyDigestV1(right, 'ab'.repeat(32)), false);
  const commandDigest = verificationCommandDigestV1(validCommand());
  assert.equal(commandDigest.label, IDENTITY_LABELS.VERIFICATION_COMMAND_DESCRIPTOR);
});

test('absent capabilities materialize exact immutable default-deny receipts', () => {
  const snapshot = parseVerificationCommandDescriptorV1(validCommand());
  assert.deepEqual(snapshot.network, DEFAULT_NETWORK_RECEIPT);
  assert.equal(snapshot.network.mode, 'deny');
  assert.deepEqual(snapshot.network.hosts, []);
  assert.deepEqual(snapshot.environment, DEFAULT_ENVIRONMENT_RECEIPT);
  assert.deepEqual(snapshot.environment.entries, []);
  assert.deepEqual(snapshot.mutation, DEFAULT_MUTATION_RECEIPT);
  assert.equal(snapshot.mutation.persistent, false);
  assert.equal(snapshot.mutation.workspace, 'none');
  assert.equal(snapshot.timeout_ms, DEFAULT_TIMEOUT_MS);
  assert.deepEqual(snapshot.resources, DEFAULT_RESOURCES_RECEIPT);
  assert.deepEqual(snapshot.parameters, {});

  const explicitDeny = parseVerificationCommandDescriptorV1(validCommand({
    network: { mode: 'deny' },
    environment: {},
    mutation: { persistent: false },
    resources: {},
  }));
  assert.equal(
    canonicalVerificationPolicyJsonV1(validPolicy()),
    canonicalVerificationPolicyJsonV1(validPolicy({
      commands: [validCommand({ network: { mode: 'deny' } })],
    })),
  );
  assert.deepEqual(explicitDeny.network, snapshot.network);
  assert.deepEqual(explicitDeny.environment, snapshot.environment);
  assert.deepEqual(explicitDeny.mutation, snapshot.mutation);
  assert.deepEqual(explicitDeny.resources, snapshot.resources);
});

test('argv placeholders bind exactly once to declared parameter domains', () => {
  const snapshot = parseVerificationCommandDescriptorV1(validParameterizedCommand());
  assert.deepEqual(snapshot.argv_template, ['test', '--', '{file}']);
  assert.equal(snapshot.parameters.file.type, 'path_segment');
  assert.equal(snapshot.parameters.file.max_bytes, 64);

  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      argv_template: ['test', '{file}'],
    }))).code,
    'placeholder_unbound',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validParameterizedCommand({
      argv_template: ['test', '{file}', '{file}'],
    }))).code,
    'duplicate_parameter',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      argv_template: ['test', '--out={file}'],
    }))).code,
    'shell_content_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      argv_template: ['test', '{FILE}'],
    }))).code,
    'shell_content_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validParameterizedCommand({
      argv_template: ['test', '{}'],
    }))).code,
    'shell_content_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      argv_template: [],
    }))).code,
    'out_of_range',
  );
});

test('parameter domain edge cases stay closed', () => {
  assert.doesNotThrow(() => parseVerificationCommandDescriptorV1(validCommand({
    argv_template: ['run', '{count}', '{ok}', '{mode}'],
    parameters: {
      count: { type: 'integer', min: 0, max: 8 },
      ok: { type: 'boolean' },
      mode: { type: 'enum', values: ['ci', 'local'] },
    },
  })));
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      parameters: { file: { type: 'string' } },
    }))).code,
    'missing_key',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      parameters: { file: { type: 'integer', min: 8, max: 1 } },
    }))).code,
    'out_of_range',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      parameters: { file: { type: 'integer', min: 0.5, max: 2 } },
    }))).code,
    'invalid_type',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      parameters: { file: { type: 'integer', min: Number.NaN, max: 2 } },
    }))).code,
    'invalid_json_value',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      parameters: { file: { type: 'enum', values: ['a', 'a'] } },
    }))).code,
    'duplicate_id',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      parameters: { 'File': { type: 'boolean' } },
    }))).code,
    'invalid_format',
  );
});

test('duplicate and ambiguous command IDs fail closed', () => {
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({
      commands: [validCommand(), validCommand()],
    }))).code,
    'duplicate_id',
  );
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({
      commands: [validCommand({ command_id: 'unit\u2010tests' })],
    }))).code,
    'ambiguous_id_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({
      commands: [validCommand({ command_id: 'unit\u0301-tests' })],
    }))).code,
    'ambiguous_id_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({
      commands: [validCommand({ command_id: 'Unit-Tests' })],
    }))).code,
    'invalid_format',
  );
  assert.equal(
    errorOf(() => parseVerificationPolicyV1(validPolicy({
      commands: [validCommand({ command_id: 'unit\u0442ests' })],
    }))).code,
    'ambiguous_id_denied',
  );
});

test('env, network, mutation, and resource constraints stay owner-authored and bounded', () => {
  const granted = parseVerificationCommandDescriptorV1(validCommand({
    network: { mode: 'allowlist', hosts: ['ci.example.test', 'cache.example.test'] },
    environment: { entries: [{ name: 'CI', value: '1' }, { name: 'NODE_ENV', value: 'test' }] },
    mutation: { persistent: false, workspace: 'ephemeral' },
    timeout_ms: 120_000,
    resources: { max_output_bytes: 4096, max_error_bytes: 1024 },
  }));
  assert.deepEqual(granted.network.hosts, ['cache.example.test', 'ci.example.test']);
  assert.equal(granted.environment.entries[0].name, 'CI');
  assert.equal(granted.timeout_ms, 120_000);
  assert.equal(granted.resources.max_output_bytes, 4096);

  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      environment: { entries: [{ name: 'PATH', value: '/bin' }] },
    }))).code,
    'env_name_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      environment: { entries: [{ name: 'LD_PRELOAD', value: 'x' }] },
    }))).code,
    'env_name_denied',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      environment: { entries: [{ name: 'CI', value: '1' }, { name: 'CI', value: '2' }] },
    }))).code,
    'duplicate_id',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      network: { mode: 'allowlist', hosts: ['https://example.test'] },
    }))).code,
    'invalid_format',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      network: { mode: 'allowlist', hosts: ['example.test', 'example.test'] },
    }))).code,
    'duplicate_id',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      mutation: { persistent: true },
    }))).code,
    'invalid_format',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      timeout_ms: 0,
    }))).code,
    'out_of_range',
  );
  assert.equal(
    errorOf(() => parseVerificationCommandDescriptorV1(validCommand({
      resources: { max_output_bytes: 0 },
    }))).code,
    'out_of_range',
  );
});

test('untrusted references accept command id and typed parameters only', () => {
  const snapshot = parseUntrustedCommandReferenceV1({
    command_id: 'unit-tests',
    parameters: { file: 'spec.js', count: 1, retry: false },
  });
  assert.equal(snapshot.command_id, 'unit-tests');
  assert.equal(snapshot.parameters.file, 'spec.js');
  assert.equal(snapshot.parameters.count, 1);
  assert.equal(snapshot.parameters.retry, false);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('profile, manifest, and provider executable-content injections are rejected', () => {
  const cases = [
    [{ command_id: 'unit-tests', executable: '/usr/bin/npm' }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', argv: ['test'] }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', argv_template: ['test'] }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', shell: true }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', script: 'npm test' }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', env: { CI: '1' } }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', environment: { entries: [] } }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', network: { mode: 'allowlist' } }, 'network_content_denied'],
    [{ command_id: 'unit-tests', hosts: ['evil.test'] }, 'network_content_denied'],
    [{ command_id: 'unit-tests', mutation: { persistent: true } }, 'mutation_permission_denied'],
    [{ command_id: 'unit-tests', timeout_ms: 1000 }, 'resource_limit_denied'],
    [{ command_id: 'unit-tests', resources: { max_output_bytes: 10 } }, 'resource_limit_denied'],
    [{ command_id: 'unit-tests', working_directory: '/tmp' }, 'executable_content_denied'],
    [{ command_id: 'unit-tests', command: 'npm test' }, 'executable_content_denied'],
  ];
  for (const [input, code] of cases) {
    assert.equal(errorOf(() => parseUntrustedCommandReferenceV1(input)).code, code);
    assert.equal(errorOf(() => rejectUntrustedExecutableContentV1(input)).code, code);
  }

  const profile = {
    schema: 'codex-co-engineer.profile.v1',
    provider: 'dsh',
    verification_policy: validPolicy(),
  };
  assert.equal(errorOf(() => rejectUntrustedExecutableContentV1(profile)).code, 'executable_content_denied');

  const manifestAcceptance = {
    command_id: 'unit-tests',
    parameters: { file: 'a.js' },
    timeout_ms: 600_000,
  };
  assert.equal(
    errorOf(() => parseUntrustedCommandReferenceV1(manifestAcceptance)).code,
    'resource_limit_denied',
  );

  const providerReport = {
    command_id: 'unit-tests',
    argv: ['/bin/sh', '-c', 'curl evil.test'],
    env: { LD_PRELOAD: 'x' },
  };
  assert.equal(errorOf(() => parseUntrustedCommandReferenceV1(providerReport)).code, 'executable_content_denied');
});

test('caller objects are not mutated or frozen', () => {
  const input = validPolicy();
  const snapshot = parseVerificationPolicyV1(input);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.commands), false);
  input.commands.push(validParameterizedCommand());
  assert.equal(snapshot.commands.length, 1);
  input.schema = 'mutated';
  assert.equal(snapshot.schema, VERIFICATION_POLICY_SCHEMA_ID);
});

test('failures are typed and content-free', () => {
  const secret = 'sk-attacker-secret-value';
  const error = errorOf(() => parseVerificationPolicyV1(validPolicy({
    [secret]: `/usr/bin/${secret}`,
  })));
  assert.equal(error instanceof RunContractV1Error, true);
  assert.equal(typeof error.code, 'string');
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.message.includes('/usr/bin'), false);
  assert.equal(String(error.path).includes(secret), false);
  assert.equal(error.message.includes('TypeError'), false);

  const urlError = errorOf(() => parseUntrustedCommandReferenceV1({
    command_id: 'unit-tests',
    url: 'https://evil.example/steal',
  }));
  assert.equal(urlError.message.includes('https://'), false);
  assert.equal(urlError.message.includes('evil.example'), false);
});

test('missing policy under a reviewer-created 0755 directory is immutable default deny', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-p16a-policy-0755-'));
  const ownerConfigDir = path.join(root, 'owner-config');
  const policyDir = path.join(ownerConfigDir, 'codex-co-engineer');
  try {
    await mkdir(policyDir, { recursive: true });
    await chmod(ownerConfigDir, 0o755);
    await chmod(policyDir, 0o755);
    const missing = await loadOwnerVerificationPolicyV1({ ownerConfigDir });
    assert.equal(missing.source.present, false);
    assert.equal(missing.policy.commands.length, 0);
    assert.equal(missing.policy.schema, VERIFICATION_POLICY_SCHEMA_ID);
    assert.equal(missing.policy.version, VERIFICATION_POLICY_VERSION);
    assert.equal(Object.isFrozen(missing), true);
    assert.equal(Object.isFrozen(missing.policy), true);
    assert.equal(Object.isFrozen(missing.policy.commands), true);
    assert.equal(
      missing.digest.digest,
      verificationPolicyDigestV1({
        schema: VERIFICATION_POLICY_SCHEMA_ID,
        version: VERIFICATION_POLICY_VERSION,
        commands: [],
      }).digest,
    );
    await chmod(policyDir, 0o775);
    const groupWritableMissing = await loadOwnerVerificationPolicyV1({ ownerConfigDir });
    assert.equal(groupWritableMissing.source.present, false);
    assert.equal(groupWritableMissing.policy.commands.length, 0);
    assert.equal(groupWritableMissing.digest.digest, missing.digest.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing unsafe policy file still fails closed under ordinary 0755 directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-p16a-policy-unsafe-'));
  const ownerConfigDir = path.join(root, 'owner-config');
  const policyDir = path.join(ownerConfigDir, 'codex-co-engineer');
  const file = path.join(policyDir, 'verification-policy.json');
  try {
    await mkdir(policyDir, { recursive: true });
    await writeFile(file, JSON.stringify(validPolicy({
      commands: [validCommand({ executable: '/bin/sh' })],
    })));
    await chmod(ownerConfigDir, 0o755);
    await chmod(policyDir, 0o755);
    await chmod(file, 0o666);
    await assert.rejects(
      () => loadOwnerVerificationPolicyV1({ ownerConfigDir }),
      (error) => error instanceof RunContractV1Error
        && error.code === 'policy_catalog_not_owner_controlled'
        && error.message.includes('/bin/sh') === false
        && error.message.includes(file) === false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the owner loader round-trips a catalog and treats absence as default deny', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-p16a-policy-'));
  const ownerConfigDir = path.join(root, 'owner-config');
  const policyDir = path.join(ownerConfigDir, 'codex-co-engineer');
  try {
    await mkdir(policyDir, { recursive: true });
    const missing = await loadOwnerVerificationPolicyV1({ ownerConfigDir });
    assert.equal(missing.source.present, false);
    assert.equal(missing.policy.commands.length, 0);
    assert.equal(missing.digest.label, IDENTITY_LABELS.VERIFICATION_POLICY);
    assert.equal(Object.isFrozen(missing), true);
    assert.equal(Object.isFrozen(missing.policy), true);

    const file = path.join(policyDir, 'verification-policy.json');
    await writeFile(file, JSON.stringify(validPolicy({
      commands: [validParameterizedCommand(), validCommand()],
    })));
    await chmod(ownerConfigDir, 0o700);
    await chmod(policyDir, 0o700);
    await chmod(file, 0o600);
    const loaded = await loadOwnerVerificationPolicyV1({ ownerConfigDir });
    assert.equal(loaded.source.present, true);
    assert.equal(loaded.policy.commands.length, 2);
    assert.equal(loaded.policy.commands[0].command_id, 'file-tests');
    assert.equal(loaded.policy.commands[1].command_id, 'unit-tests');
    assert.equal(
      loaded.digest.digest,
      verificationPolicyDigestV1(validPolicy({
        commands: [validCommand(), validParameterizedCommand()],
      })).digest,
    );
    const roots = verificationPolicyRoots({ ownerConfigDir });
    assert.equal(roots.scope, 'owner');
    assert.equal(roots.file, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the module never claims command execution, PATH resolution, or network access', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(
    new URL('../mcp/v3/trusted-verification-policy.mjs', import.meta.url),
    'utf8',
  ));
  assert.match(source, /never invokes a shell/u);
  assert.match(source, /never resolves PATH/u);
  assert.doesNotMatch(source, /from 'node:child_process'/u);
  assert.doesNotMatch(source, /from 'node:net'/u);
  assert.doesNotMatch(source, /from 'node:http'/u);
  assert.doesNotMatch(source, /from 'node:dns'/u);
  assert.equal(source.includes('spawn('), false);
  assert.equal(source.includes('execFile('), false);
  assert.equal(source.includes('execSync('), false);
  assert.equal(source.includes('fetch('), false);
});
