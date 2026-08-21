import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');

test('plugin presents the Co-Engineer brand with usable icon assets', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'),
  );

  assert.equal(manifest.name, 'codex-co-engineer');
  assert.equal(manifest.version, '3.2.1');
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
  assert.equal(packageJson.version, '3.2.1');

  const skill = await readFile(
    path.join(ROOT, 'skills', 'control-codex-co-engineer-agents', 'SKILL.md'),
    'utf8',
  );
  assert.match(skill, /^name: control-codex-co-engineer-agents$/mu);
  assert.match(skill, /wait_ms/u);
  assert.match(skill, /event_cursor/u);
  assert.match(skill, /Unsolicited stdio\s+callbacks/u);
  assert.match(skill, /property named `repo`/u);
  assert.match(skill, /"repo": "\/absolute\/path\/to\/git-worktree"/u);
  assert.match(skill, /Do not rename `repo` to `git_root`/u);
  assert.match(skill, /Cursor Cloud-only `starting_ref`/u);

  const icon = await readFile(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
  assert.match(icon, /aria-label="Co-Engineer"/);

  const logo = await readFile(path.join(ROOT, 'assets', 'co-engineer.png'));
  assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('visitor README leads with the product shot and copy/paste install', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  const productShot = 'docs/assets/codex-co-engineer-3.1.0.jpg';
  const flowShot = 'docs/assets/codex-co-engineer-3.1.0.svg';
  assert.ok(readme.includes(productShot));
  assert.ok(readme.includes(flowShot));
  assert.ok(readme.indexOf(productShot) < readme.indexOf(flowShot));
  assert.doesNotMatch(readme.slice(0, readme.indexOf('## What Codex-Co-Engineer is for')), /co-engineer\.png/u);

  assert.match(readme, /git clone https:\/\/github\.com\/ajhcs\/Codex-Co-Engineer\.git/u);
  assert.match(readme, /codex plugin marketplace add "\$PWD"/u);
  assert.match(readme, /codex plugin add codex-co-engineer@codex-co-engineer/u);
  assert.match(readme, /npm --prefix plugins\/codex-co-engineer run setup/u);
  assert.match(readme, /npm --prefix plugins\/codex-co-engineer run setup:check/u);
  assert.match(readme, /wait_until": "terminal"/u);
  assert.match(readme, /property `repo`/u);
  assert.match(readme, /"repo": "\/absolute\/path\/to\/git-worktree"/u);
  assert.match(readme, /docs\/releases\/v3\.2\.1\.md/u);
  assert.doesNotMatch(readme, /upcoming,?\s+unreleased/iu);
});

test('repository marketplace catalogs Codex-Co-Engineer 3.2.1', async () => {
  const marketplace = JSON.parse(
    await readFile(path.join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );
  assert.equal(marketplace.name, 'codex-co-engineer');
  assert.equal(marketplace.interface.displayName, 'Codex-Co-Engineer');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'codex-co-engineer');
  assert.equal(marketplace.plugins[0].version, '3.2.1');
  assert.equal(marketplace.plugins[0].source.path, './plugins/codex-co-engineer');

  const notes = await readFile(path.join(REPO, 'docs', 'releases', 'v3.2.1.md'), 'utf8');
  assert.match(notes, /Codex-Co-Engineer 3\.2\.1/u);
  assert.match(notes, /"dsh_model": "stealth\/ox-alpha"/u);
  assert.match(notes, /"repo": "\/absolute\/path\/to\/git-worktree"/u);
  assert.match(notes, /gh release create v3\.2\.1/u);
  assert.match(notes, /EXACT_REVIEWED_MAIN_SHA/u);
});
