import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DSH_PATCH_FILE,
  dshChildEnvironment,
  inspectDsh,
  resolveDshHome,
} from '../mcp/dsh.mjs';

test('DSH home resolution never falls back to the protected user home', () => {
  assert.deepEqual(
    resolveDshHome({ env: {}, stateDirectory: '/tmp/codex-task-state' }),
    {
      path: '/tmp/codex-task-state/dsh-home',
      source: 'managed-state',
      reason: null,
    },
  );
  assert.equal(
    resolveDshHome({ env: { DSH_HOME: '/tmp/custom-dsh' }, stateDirectory: '/tmp/state' }).path,
    '/tmp/custom-dsh',
  );
  assert.equal(
    resolveDshHome({ env: { CODEX_CO_ENGINEER_DSH_HOME: 'relative-dsh' }, stateDirectory: '/tmp/state' }).reason,
    'configured DSH_HOME must be absolute.',
  );
  assert.equal(dshChildEnvironment('/tmp/custom-dsh').MODEL_API_KEY, undefined);
});

test('DSH readiness materializes a managed headless profile without provider calls', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-readiness-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fake = path.join(directory, 'dsh');
  await writeFile(fake, `#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) {
  process.stdout.write('dsh 0.1.0-rc.6\\n');
} else if (process.argv.includes('--dump-config')) {
  const profile = path.join(process.env.DSH_HOME, 'profiles', 'headless');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(process.env.DSH_HOME, 0o700);
  chmodSync(path.join(process.env.DSH_HOME, 'profiles'), 0o700);
  chmodSync(profile, 0o700);
  writeFileSync(path.join(profile, 'package.json'), '{}\\n', { mode: 0o600 });
} else {
  process.exitCode = 64;
}
  `, { mode: 0o755 });
  const home = path.join(directory, 'managed-dsh');
  const result = inspectDsh({
    command: process.execPath,
    commandPrefix: [fake],
    home,
    source: 'managed-state',
    patchFile: DEFAULT_DSH_PATCH_FILE,
    cwd: directory,
    env: { HOME: '/home/should-not-be-used', PATH: process.env.PATH },
  });
  assert.equal(result.ok, true);
  assert.equal(result.usable, true);
  assert.equal(result.reason, null);
  assert.equal(result.home, home);
  assert.match(await readFile(path.join(home, 'profiles', 'headless', 'package.json'), 'utf8'), /\{\}/);

  const revalidated = inspectDsh({
    command: process.execPath,
    commandPrefix: [fake],
    home,
    source: 'managed-state',
    patchFile: DEFAULT_DSH_PATCH_FILE,
    cwd: directory,
    env: { HOME: '/home/should-not-be-used', PATH: process.env.PATH },
    initialize: false,
    expectedIdentity: result.identity,
  });
  assert.equal(revalidated.ok, true);
  assert.deepEqual(revalidated.identity, result.identity);
});

test('DSH readiness rejects symlinked and non-owner-only homes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-home-safety-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fake = path.join(directory, 'dsh');
  await writeFile(fake, '#!/bin/sh\nprintf "dsh 0.1.0-rc.6\\n"\n', { mode: 0o755 });
  const target = path.join(directory, 'target');
  const linked = path.join(directory, 'linked');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linked);

  const linkedResult = inspectDsh({
    command: fake, home: linked, source: 'explicit-dsh',
    patchFile: DEFAULT_DSH_PATCH_FILE, cwd: directory, env: { PATH: process.env.PATH },
  });
  assert.equal(linkedResult.ok, false);
  assert.equal(linkedResult.reason, 'home_symlink');

  await chmod(target, 0o755);
  const permissiveResult = inspectDsh({
    command: fake, home: target, source: 'explicit-dsh',
    patchFile: DEFAULT_DSH_PATCH_FILE, cwd: directory, env: { PATH: process.env.PATH },
  });
  assert.equal(permissiveResult.ok, false);
  assert.equal(permissiveResult.reason, 'home_permissions');
});

test('DSH readiness reports an unwritable managed root before profile dispatch', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-unwritable-test-'));
  context.after(async () => {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });
  await chmod(directory, 0o500);
  const result = inspectDsh({
    command: '/definitely/missing/dsh',
    home: path.join(directory, 'dsh-home'),
    source: 'managed-state',
    patchFile: DEFAULT_DSH_PATCH_FILE,
    cwd: directory,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'executable_missing');
  await chmod(directory, 0o700);
});
