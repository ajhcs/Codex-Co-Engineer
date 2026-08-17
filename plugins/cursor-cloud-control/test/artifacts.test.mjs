import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveArtifact } from '../mcp/artifacts.mjs';

test('artifact writes are bounded to the configured root, owner-only, atomic, and no-overwrite by default', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-artifact-root-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { CURSOR_ARTIFACT_ROOT: root };
  const first = await saveArtifact(new TextEncoder().encode('hello'), 'run/output.txt', { env });
  assert.equal(await readFile(first.path, 'utf8'), 'hello');
  assert.equal((await lstat(first.path)).mode & 0o077, 0);
  assert.equal(first.bytes, 5);
  assert.equal(first.byteCount, 5);
  assert.equal(first.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  await assert.rejects(saveArtifact(new TextEncoder().encode('again'), 'run/output.txt', { env }), (error) => error.code === 'destination_exists');
  await saveArtifact(new TextEncoder().encode('again'), 'run/output.txt', { env, overwrite: true });
  assert.equal(await readFile(first.path, 'utf8'), 'again');
  await assert.rejects(saveArtifact(new Uint8Array([1]), '../outside.bin', { env }), (error) => error.code === 'unsafe_destination');
});

test('artifact writes reject symlink escape', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-artifact-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cursor-artifact-outside-'));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await symlink(outside, path.join(root, 'escape'));
  await assert.rejects(saveArtifact(new Uint8Array([1]), 'escape/file.bin', { env: { CURSOR_ARTIFACT_ROOT: root } }), (error) => error.code === 'unsafe_destination');
});
