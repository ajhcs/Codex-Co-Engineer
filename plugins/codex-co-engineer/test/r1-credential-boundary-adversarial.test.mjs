import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import { boundedEvent, publicError, sanitizeText } from '../mcp/v3/acp-worker.mjs';
import {
  CredentialBoundaryError,
  MAX_CREDENTIAL_BYTES,
  assertNoWorkerPushUrl,
  collectLaneSecrets,
  inspectEnvForSecrets,
  loadCredentialFile,
  loadProviderCredential,
  materializeProviderEnvironment,
  projectProviderEnvironment,
  redactExactValues,
} from '../mcp/v3/credential-boundary.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  CONTENT_FREE,
  HOSTILE_ENV,
  withTempDir,
  writeOwnerFile,
} from './fixtures/r1-credential-boundary-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve().then(action).then(
    () => { assert.fail('expected CredentialBoundaryError'); },
    (error) => {
      assert.ok(error instanceof CredentialBoundaryError, error?.stack ?? String(error));
      assert.equal(utilTypes.isProxy(error), false);
      assert.match(error.message, CONTENT_FREE);
      return error;
    },
  );
}

test('proxy accessor symbol and exotic env inputs fail closed without running caller code', async () => {
  const { proxy, counts } = countingProxy({ PATH: '/bin', XAI_API_KEY: 'xai-proxy-secret' });
  const denied = await errorOf(() => projectProviderEnvironment({ provider: 'grok', source: proxy }));
  assert.equal(denied.code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const accessor = {};
  Object.defineProperty(accessor, 'XAI_API_KEY', {
    enumerable: true,
    get() { throw new Error('accessor-ran'); },
  });
  Object.defineProperty(accessor, 'PATH', { enumerable: true, value: '/bin' });
  const accessDenied = await errorOf(() => projectProviderEnvironment({ provider: 'grok', source: accessor }));
  assert.equal(accessDenied.code, 'accessor_property_denied');

  const withSymbol = { PATH: '/bin' };
  withSymbol[Symbol('secret')] = 'symbol-secret';
  await projectProviderEnvironment({ provider: 'grok', source: withSymbol });

  const exotic = Object.create({ PATH: '/bin', GH_TOKEN: 'proto-token' });
  exotic.XAI_API_KEY = 'xai-own';
  const exoticDenied = await errorOf(() => projectProviderEnvironment({ provider: 'grok', source: exotic }));
  assert.equal(exoticDenied.code, 'exotic_prototype_denied');
});

test('symlink fifo directory and in-place swap fail content-free', async () => {
  await withTempDir('cce-p29-adv-', async (root) => {
    const dir = path.join(root, 'dir-key');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { mode: 0o700 });
    const dirError = await errorOf(() => loadCredentialFile(dir));
    assert.equal(['invalid_credential_file', 'credential_unreadable'].includes(dirError.code), true);
    assert.equal(dirError.message.includes(root), false);

    const fifo = path.join(root, 'fifo-key');
    const fifoResult = spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo], { encoding: 'utf8' });
    if (fifoResult.status === 0) {
      const fifoError = await errorOf(() => loadCredentialFile(fifo));
      assert.ok(['invalid_credential_file', 'credential_unreadable', 'credential_symlink_denied'].includes(fifoError.code));
    }

    const file = await writeOwnerFile(path.join(root, 'swap'), 'first-secret-value\n');
    const handle = await open(file, 'r');
    try {
      await writeFile(file, 'second-secret-value-changed\n', { mode: 0o600 });
    } finally {
      await handle.close();
    }
    // Path replacement after a closed handle is a new generation; the live
    // no-follow open still re-stats the descriptor it holds.
    const swapped = await writeOwnerFile(path.join(root, 'live-swap'), 'live-secret-aaaa\n');
    const original = await loadCredentialFile(swapped);
    assert.equal(original, 'live-secret-aaaa');
  });
});

test('readiness children spawned through projection cannot observe stripped secrets', async () => {
  const env = projectProviderEnvironment({
    provider: 'dsh',
    source: HOSTILE_ENV,
    dshModel: 'muse-spark-1.2-contributor',
    operation: 'readiness_probe',
  });
  assert.equal(env.MODEL_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    env,
    encoding: 'utf8',
  });
  const stdout = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.once('error', reject);
    child.once('close', () => resolve(text));
  });
  assert.equal(stdout.includes('ghp_hostile'), false);
  assert.equal(stdout.includes('muse-secret-value'), false);
  assert.equal(stdout.includes('hostile-control-token'), false);
});

test('push URL objects and insteadOf maps are denied', async () => {
  const denied = await errorOf(() => assertNoWorkerPushUrl({ pushurl: 'https://github.com/org/repo.git' }));
  assert.equal(denied.code, 'remote_mutation_denied');
  const instead = await errorOf(() => assertNoWorkerPushUrl({ insteadOf: 'ssh://git@github.com' }));
  assert.equal(instead.code, 'remote_mutation_denied');
});

test('materialize does not copy key-file paths into the child environment', async () => {
  await withTempDir('cce-p29-mat-', async (root) => {
    const keyFile = await writeOwnerFile(path.join(root, 'model-api-key'), 'loaded-muse-secret\n');
    const env = await materializeProviderEnvironment({
      provider: 'dsh',
      dshModel: 'muse-spark-1.2-contributor',
      operation: 'lane',
      source: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        CODEX_CO_ENGINEER_MODEL_API_KEY_FILE: keyFile,
      },
    });
    assert.equal(env.MODEL_API_KEY, 'loaded-muse-secret');
    assert.equal(env.CODEX_CO_ENGINEER_MODEL_API_KEY_FILE, undefined);
    assert.equal(JSON.stringify(env).includes(keyFile), false);
  });
});

test('credential-file overrides reject relative non-normalized and double-separator paths before resolve', async () => {
  await withTempDir('cce-p29-override-', async (root) => {
    const keyFile = await writeOwnerFile(path.join(root, 'model-api-key'), 'muse-from-override\n');
    const loaded = await loadProviderCredential({
      provider: 'dsh',
      dshModel: 'muse-spark-1.2-contributor',
      source: { HOME: root, CODEX_CO_ENGINEER_MODEL_API_KEY_FILE: keyFile },
    });
    assert.equal(loaded.value, 'muse-from-override');

    const overrides = [
      'relative-key',
      `${root}/../${path.basename(root)}/model-api-key`,
      `${root}/./model-api-key`,
      `${root}//model-api-key`,
      `${keyFile}/`,
    ];
    for (const override of overrides) {
      const error = await errorOf(() => loadProviderCredential({
        provider: 'dsh',
        dshModel: 'muse-spark-1.2-contributor',
        source: { HOME: root, CODEX_CO_ENGINEER_MODEL_API_KEY_FILE: override },
      }));
      assert.equal(error.code, 'invalid_credential_path', override);
      assert.equal(error.message.includes(override), false, override);
      assert.equal(error.message.includes(root), false, override);
      assert.equal(error.message.includes('muse-from-override'), false);
    }
  });
});

test('owner denial exact 0600 empty files and in-place identity swap fail content-free', async () => {
  await withTempDir('cce-p29-mode-', async (root) => {
    const empty = await writeOwnerFile(path.join(root, 'empty'), '');
    const emptyError = await errorOf(() => loadCredentialFile(empty));
    assert.equal(emptyError.code, 'credential_empty');
    assert.equal(emptyError.message.includes(root), false);

    const execOnly = await writeOwnerFile(path.join(root, 'exec'), 'exec-secret-value\n', 0o700);
    const execError = await errorOf(() => loadCredentialFile(execOnly));
    assert.equal(execError.code, 'credential_permissions');
    assert.equal(execError.message.includes('exec-secret'), false);

    const owned = await writeOwnerFile(path.join(root, 'owned'), 'owner-secret-value\n');
    const previous = process.geteuid.bind(process);
    process.geteuid = () => previous() + 1;
    try {
      const ownerError = await errorOf(() => loadCredentialFile(owned));
      assert.equal(ownerError.code, 'credential_owner_denied');
      assert.equal(ownerError.message.includes('owner-secret'), false);
      assert.equal(ownerError.message.includes(root), false);
    } finally {
      process.geteuid = previous;
    }

    const live = await writeOwnerFile(path.join(root, 'live-swap'), 'first-secret-value\n');
    let seenStat = 0;
    const swapped = await errorOf(() => loadCredentialFile(live, {
      openFile: async (target, flags) => {
        const handle = await open(target, flags);
        const inner = handle.stat.bind(handle);
        handle.stat = async (options) => {
          const metadata = await inner(options);
          seenStat += 1;
          if (seenStat === 1) {
            await writeFile(target, 'second-secret-value-changed\n', { mode: 0o600 });
          }
          return metadata;
        };
        return handle;
      },
    }));
    assert.equal(swapped.code, 'credential_file_changed');
    assert.equal(seenStat >= 1, true);
    assert.equal(swapped.message.includes('first-secret'), false);
    assert.equal(swapped.message.includes('second-secret'), false);
    assert.equal(swapped.message.includes(root), false);
  });
});

test('exact-value redaction covers lengths 1-3 and 16 KiB splits across chunks events errors and logs', () => {
  const previous = process.env.MODEL_API_KEY;
  try {
    for (const secret of ['a', 'ab', 'xyz']) {
      process.env.MODEL_API_KEY = secret;
      assert.ok(collectLaneSecrets(process.env).includes(secret));
      const logLine = `OUT:${secret}:END`;
      const redacted = redactExactValues(logLine, [secret]);
      assert.equal(redacted.includes(secret), false, secret);
      assert.equal(redacted.startsWith('OUT:'), true, secret);
      assert.equal(redacted.endsWith(':END'), true, secret);
      assert.equal(inspectEnvForSecrets({ note: logLine }, [secret]), true);
      const event = boundedEvent({ type: 'status', text: logLine }, 'prompt');
      const failure = publicError(new Error(`fail ${secret}`), 'prompt');
      assert.equal(JSON.stringify(event).includes(secret), false, secret);
      assert.equal(failure.message.includes(secret), false, secret);
      assert.equal(sanitizeText(`stderr ${secret}`, 'prompt').includes(secret), false, secret);
    }

    const secret = Array.from({ length: MAX_CREDENTIAL_BYTES }, (_, index) => (
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[index % 32]
    )).join('');
    process.env.MODEL_API_KEY = secret;
    const head = secret.slice(0, 8000);
    const tail = secret.slice(8000);
    const chunk = secret.slice(64, 64 + 4000);
    const event = boundedEvent({
      type: 'provider_update',
      text: `log:${chunk}:tail`,
      nested: { head, tail },
    }, 'prompt');
    const failure = publicError(new Error(`${head}\n${tail}`), 'prompt');
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(secret.slice(0, 32)), false);
    assert.equal(serialized.includes(secret.slice(-32)), false);
    assert.equal(serialized.includes(chunk.slice(0, 32)), false);
    assert.equal(failure.message.includes(secret.slice(0, 32)), false);
    assert.equal(sanitizeText(`log:${chunk}:tail`, 'prompt').includes(chunk.slice(0, 32)), false);
  } finally {
    if (previous === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previous;
  }
});
