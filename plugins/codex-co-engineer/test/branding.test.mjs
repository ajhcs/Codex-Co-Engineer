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

  assert.equal(manifest.name, 'codex-co-engineer');
  assert.equal(manifest.version, '3.0.2');
  assert.equal(manifest.interface.displayName, 'Codex-Co-Engineer');
  assert.equal(manifest.interface.developerName, 'Codex-Co-Engineer');
  assert.equal(manifest.interface.composerIcon, './assets/icon.svg');
  assert.equal(manifest.interface.logo, './assets/co-engineer.png');

  const mcp = JSON.parse(await readFile(path.join(ROOT, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['codex-co-engineer']);
  const environment = mcp.mcpServers['codex-co-engineer'].env_vars;
  assert.ok(environment.includes('XDG_RUNTIME_DIR'));
  assert.ok(environment.includes('DBUS_SESSION_BUS_ADDRESS'));

  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'codex-co-engineer');
  assert.equal(packageJson.version, '3.0.2');

  const skill = await readFile(
    path.join(ROOT, 'skills', 'control-codex-co-engineer-agents', 'SKILL.md'),
    'utf8',
  );
  assert.match(skill, /^name: control-codex-co-engineer-agents$/mu);
  assert.match(skill, /wait_ms/u);
  assert.match(skill, /event_cursor/u);
  assert.match(skill, /Unsolicited stdio callbacks/u);

  const icon = await readFile(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
  assert.match(icon, /aria-label="Co-Engineer"/);

  const logo = await readFile(path.join(ROOT, 'assets', 'co-engineer.png'));
  assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
