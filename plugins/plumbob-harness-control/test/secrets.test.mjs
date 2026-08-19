import assert from 'node:assert/strict';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadModelApiKey } from '../mcp/secrets.mjs';

test('loads only a current-user owner-only regular key file through an O_NOFOLLOW descriptor', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-model-key-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'model-api-key');
  await writeFile(keyFile, 'fixture-key-without-output\n', { mode: 0o600 });

  const previous = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  try {
    assert.deepEqual(await loadModelApiKey(keyFile), { available: true, source: 'protected_file' });
    assert.equal(typeof process.env.MODEL_API_KEY, 'string');
    assert.ok(process.env.MODEL_API_KEY.length > 0);
  } finally {
    if (previous === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previous;
  }
});

test('rejects symlinked, multiply-linked, and group/world-readable key files', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-model-key-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'model-api-key');
  const target = path.join(root, 'target-key');
  const hardlink = path.join(root, 'hardlink-key');
  const realDirectory = path.join(root, 'real-directory');
  const linkedDirectory = path.join(root, 'linked-directory');
  await writeFile(target, 'fixture-key\n', { mode: 0o600 });
  await symlink(target, keyFile);
  delete process.env.MODEL_API_KEY;
  assert.deepEqual(await loadModelApiKey(keyFile), { available: false, source: null });

  await rm(keyFile);
  await mkdir(realDirectory, { mode: 0o700 });
  await writeFile(path.join(realDirectory, 'model-api-key'), 'fixture-key\n', { mode: 0o600 });
  await symlink(realDirectory, linkedDirectory);
  assert.deepEqual(
    await loadModelApiKey(path.join(linkedDirectory, 'model-api-key')),
    { available: false, source: null },
  );

  await link(target, hardlink);
  assert.deepEqual(await loadModelApiKey(target), { available: false, source: null });

  await rm(hardlink);
  await chmod(target, 0o640);
  assert.deepEqual(await loadModelApiKey(target), { available: false, source: null });
});

test('does not derive a relative credential path when HOME is empty or absent', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-model-key-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwdFallback = path.join(root, '.config', 'codex-co-engineer');
  await mkdir(cwdFallback, { recursive: true, mode: 0o700 });
  await writeFile(path.join(cwdFallback, 'model-api-key'), 'fixture-key\n', { mode: 0o600 });

  const savedHome = process.env.HOME;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedKey = process.env.MODEL_API_KEY;
  delete process.env.HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.MODEL_API_KEY;
  try {
    const moduleUrl = `${new URL('../mcp/secrets.mjs', import.meta.url).href}?empty-home=${Date.now()}`;
    const secrets = await import(moduleUrl);
    assert.equal(secrets.MODEL_API_KEY_FILE, '/dev/null');
    assert.deepEqual(await secrets.loadModelApiKey(), { available: false, source: null });
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = savedKey;
  }
});
