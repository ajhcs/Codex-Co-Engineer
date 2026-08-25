import assert from 'node:assert/strict';
import { link, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CREDENTIAL_BOUNDARY_SCHEMA_ID,
  CREDENTIAL_BOUNDARY_VERSION,
  CredentialBoundaryError,
  DEFAULT_DSH_MODEL,
  DSH_OX_MODEL,
  MAX_CREDENTIAL_BYTES,
  assertCredentialFreeRemote,
  collectLaneSecrets,
  createCredentialHandoff,
  cleanupCredentialHandoff,
  consumeCredentialHandoff,
  credentialRedactionFragments,
  denyWorkerRemoteMutation,
  extractCredentialEnv,
  inspectArgvForSecrets,
  inspectEnvForSecrets,
  loadCredentialFile,
  materializeProviderEnvironment,
  omitCredentialEnv,
  projectProviderEnvironment,
  redactExactValues,
  systemdClientEnvironment,
} from '../mcp/v3/credential-boundary.mjs';
import { DENIED_OPERATIONS } from '../mcp/v3/git-authority.mjs';
import {
  HOSTILE_ENV,
  withTempDir,
  writeOwnerFile,
} from './fixtures/r1-credential-boundary-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve().then(action).then(
    () => { assert.fail('expected CredentialBoundaryError'); },
    (error) => {
      assert.ok(error instanceof CredentialBoundaryError, error?.stack ?? String(error));
      return error;
    },
  );
}

test('credential boundary is a frozen v1 additive module and not a 4.0.0 major', () => {
  assert.equal(CREDENTIAL_BOUNDARY_SCHEMA_ID, 'codex-co-engineer.credential-boundary.v1');
  assert.equal(CREDENTIAL_BOUNDARY_VERSION, 1);
  assert.equal(CREDENTIAL_BOUNDARY_SCHEMA_ID.includes('4.0.0'), false);
  assert.equal(MAX_CREDENTIAL_BYTES, 16 * 1024);
});

test('service projection keeps operational and command keys without ambient secrets', () => {
  const service = projectProviderEnvironment({
    source: {
      ...HOSTILE_ENV,
      CODEX_CO_ENGINEER_GROK_COMMAND: '/usr/bin/grok',
      CODEX_CO_ENGINEER_CURSOR_COMMAND: '/usr/bin/cursor-agent',
    },
    operation: 'service',
  });
  assert.equal(service.PATH, HOSTILE_ENV.PATH);
  assert.equal(service.HOME, HOSTILE_ENV.HOME);
  assert.equal(service.CODEX_CO_ENGINEER_GROK_COMMAND, '/usr/bin/grok');
  assert.equal(service.GIT_TERMINAL_PROMPT, '0');
  assert.equal(service.XAI_API_KEY, undefined);
  assert.equal(service.CURSOR_API_KEY, undefined);
  assert.equal(service.SSH_AUTH_SOCK, undefined);
  assert.equal(service.GH_TOKEN, undefined);
  assert.equal(service.NODE_OPTIONS, undefined);
});

test('closed projection strips Git SSH hosting control tokens and key-file paths', () => {
  const grok = projectProviderEnvironment({ provider: 'grok', source: HOSTILE_ENV, operation: 'lane' });
  assert.equal(grok.XAI_API_KEY, HOSTILE_ENV.XAI_API_KEY);
  assert.equal(grok.PATH, HOSTILE_ENV.PATH);
  assert.equal(grok.GIT_TERMINAL_PROMPT, '0');
  assert.equal(grok.GIT_ASKPASS, '');
  for (const key of [
    'GIT_SSH', 'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN',
    'GITLAB_TOKEN', 'WORKTREE_BOOTSTRAP_TASK', 'MODEL_API_KEY', 'OPENROUTER_API_KEY',
    'CURSOR_API_KEY', 'CODEX_CO_ENGINEER_MODEL_API_KEY_FILE', 'CURSOR_API_KEY_FILE',
    'NODE_OPTIONS',
  ]) {
    assert.equal(Object.hasOwn(grok, key), false, key);
  }
});

test('Muse Ox Grok and Cursor Cloud routes do not share credentials', async () => {
  const muse = await materializeProviderEnvironment({
    provider: 'dsh', source: HOSTILE_ENV, dshModel: DEFAULT_DSH_MODEL, operation: 'lane',
  });
  const ox = await materializeProviderEnvironment({
    provider: 'dsh', source: HOSTILE_ENV, dshModel: DSH_OX_MODEL, operation: 'lane',
  });
  const grok = await materializeProviderEnvironment({
    provider: 'grok', source: HOSTILE_ENV, operation: 'lane',
  });
  const cloud = await materializeProviderEnvironment({
    provider: 'cursor-cloud', source: HOSTILE_ENV, operation: 'lane',
  });
  const local = await materializeProviderEnvironment({
    provider: 'cursor-local', source: HOSTILE_ENV, operation: 'lane',
  });
  assert.equal(muse.MODEL_API_KEY, HOSTILE_ENV.MODEL_API_KEY);
  assert.equal(muse.OPENROUTER_API_KEY, undefined);
  assert.equal(ox.OPENROUTER_API_KEY, HOSTILE_ENV.OPENROUTER_API_KEY);
  assert.equal(ox.MODEL_API_KEY, undefined);
  assert.equal(grok.XAI_API_KEY, HOSTILE_ENV.XAI_API_KEY);
  assert.equal(grok.MODEL_API_KEY, undefined);
  assert.equal(cloud.CURSOR_API_KEY, HOSTILE_ENV.CURSOR_API_KEY);
  assert.equal(cloud.XAI_API_KEY, undefined);
  assert.equal(local.CURSOR_API_KEY, undefined);
  assert.equal(local.XAI_API_KEY, undefined);
});

test('systemd client environment is D-Bus only', () => {
  const client = systemdClientEnvironment({
    ...HOSTILE_ENV,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_SESSION_ID: '1',
  });
  assert.deepEqual(Object.keys(client).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_SESSION_ID']);
  assert.equal(inspectEnvForSecrets(client, Object.values(HOSTILE_ENV)), false);
});

test('credential file reads require owner-only no-follow regular files', async () => {
  await withTempDir('cce-p29-cred-', async (root) => {
    const file = await writeOwnerFile(path.join(root, 'key'), 'muse-from-file\n');
    assert.equal(await loadCredentialFile(file), 'muse-from-file');

    const relative = errorOf(() => loadCredentialFile('relative-key'));
    assert.equal((await relative).code, 'invalid_credential_path');
    assert.equal((await relative).message.includes(root), false);

    const linked = path.join(root, 'link-key');
    await symlink(file, linked);
    assert.equal((await errorOf(() => loadCredentialFile(linked))).code, 'credential_symlink_denied');

    const hard = path.join(root, 'hard-key');
    await link(file, hard);
    assert.equal((await errorOf(() => loadCredentialFile(hard))).code, 'credential_hardlink_denied');

    const wide = await writeOwnerFile(path.join(root, 'wide'), 'wide-secret\n', 0o644);
    assert.equal((await errorOf(() => loadCredentialFile(wide))).code, 'credential_permissions');

    const huge = path.join(root, 'huge');
    await writeFile(huge, `${'a'.repeat(MAX_CREDENTIAL_BYTES + 1)}\n`, { mode: 0o600 });
    assert.equal((await errorOf(() => loadCredentialFile(huge))).code, 'credential_too_large');
  });
});

test('handoff round-trip never stores secrets in argv helpers and cleans up', async () => {
  const secrets = { MODEL_API_KEY: 'handoff-secret-value' };
  const created = await createCredentialHandoff(secrets);
  const argv = ['--setenv=HOME=/tmp', created.path, '--', '/usr/bin/node'];
  assert.equal(inspectArgvForSecrets(argv, ['handoff-secret-value']), false);
  const consumed = await consumeCredentialHandoff(created.path);
  assert.equal(consumed.MODEL_API_KEY, 'handoff-secret-value');
  const second = await cleanupCredentialHandoff(created.path);
  assert.equal(second.cleaned, true);
  await assert.rejects(() => consumeCredentialHandoff(created.path), (error) => (
    error instanceof CredentialBoundaryError && error.code === 'invalid_credential_file'
  ));
});

test('exact-value redaction covers 16 KiB credentials split across events', () => {
  const secret = Array.from({ length: MAX_CREDENTIAL_BYTES }, (_, index) => (
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[index % 32]
  )).join('');
  assert.equal(secret.length, MAX_CREDENTIAL_BYTES);
  const fragments = credentialRedactionFragments(secret);
  assert.ok(fragments.includes(secret));
  const chunk = secret.slice(100, 100 + 4000);
  const redacted = redactExactValues(`log:${chunk}:tail`, [secret]);
  assert.equal(redacted.includes(chunk.slice(0, 32)), false);
  assert.equal(redacted.startsWith('log:'), true);
  assert.equal(redacted.endsWith(':tail'), true);
  const combined = redactExactValues(`${secret.slice(0, 8000)}\n${secret.slice(8000)}`, [secret]);
  assert.equal(combined.includes(secret.slice(0, 32)), false);
  assert.equal(combined.includes(secret.slice(-32)), false);
  assert.ok(collectLaneSecrets({ MODEL_API_KEY: secret }).includes(secret));
});

test('worker remote mutation and push URLs are denied content-free', () => {
  for (const operation of DENIED_OPERATIONS) {
    const error = (() => {
      try { denyWorkerRemoteMutation(operation); } catch (caught) { return caught; }
    })();
    assert.equal(error instanceof CredentialBoundaryError, true, operation);
    assert.equal(error.code, 'remote_mutation_denied');
    assert.equal(error.message.includes('github'), false);
  }
  const push = (() => {
    try { assertCredentialFreeRemote('https://user:token@github.com/org/repo.git'); } catch (caught) { return caught; }
  })();
  assert.equal(push.code, 'push_url_denied');
  assert.equal(push.message.includes('token'), false);
  assert.equal(assertCredentialFreeRemote('https://github.com/org/repo.git'), 'https://github.com/org/repo.git');
});

test('omitCredentialEnv removes secret keys before process-argument construction', () => {
  const publicEnv = omitCredentialEnv({ HOME: '/tmp/home', PATH: '/bin', MODEL_API_KEY: 'hidden-secret' });
  assert.equal(publicEnv.HOME, '/tmp/home');
  assert.equal(publicEnv.MODEL_API_KEY, undefined);
  const extracted = extractCredentialEnv({ HOME: '/tmp/home', MODEL_API_KEY: 'hidden-secret' });
  assert.equal(extracted.MODEL_API_KEY, 'hidden-secret');
  assert.equal(Object.keys(extracted).join(','), 'MODEL_API_KEY');
});
