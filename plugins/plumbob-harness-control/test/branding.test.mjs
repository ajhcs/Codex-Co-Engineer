import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('plugin presents the Co-Engineer brand with usable icon assets', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'),
  );

  assert.equal(manifest.name, 'plumbob-harness-control');
  assert.equal(manifest.version, '3.0.0');
  assert.equal(manifest.interface.displayName, 'Codex-Co-Engineer');
  assert.equal(manifest.interface.composerIcon, './assets/icon.svg');
  assert.equal(manifest.interface.logo, './assets/co-engineer.png');

  const icon = await readFile(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
  assert.match(icon, /aria-label="Co-Engineer"/);

  const logo = await readFile(path.join(ROOT, 'assets', 'co-engineer.png'));
  assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
