import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DSH_PATCH_FILE,
  DSH_CONTEXT_WINDOW_TOKENS,
  DSH_MAX_OUTPUT_TOKENS,
  DSH_MODEL,
  DSH_MAX_RALPH_ROUNDS,
  dshBaseEnvironment,
  dshChildEnvironment,
  dshCapabilityProfile,
  dshVersionProbe,
  inspectDsh,
  normalizeDshOptions,
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
  assert.deepEqual(dshChildEnvironment('/tmp/custom-dsh'), {
    DSH_HOME: '/tmp/custom-dsh',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TOOLS_MODE: 'native',
    CODEX_CO_ENGINEER_DSH_MODEL: DSH_MODEL,
    CODEX_CO_ENGINEER_DSH_MAX_TOKENS: String(DSH_MAX_OUTPUT_TOKENS),
  });
  assert.equal(dshChildEnvironment('/tmp/custom-dsh').MODEL_API_KEY, undefined);
  assert.deepEqual(dshBaseEnvironment('/tmp/custom-dsh'), {
    DSH_HOME: '/tmp/custom-dsh',
    DSH_TELEMETRY_MODE: 'DISABLED',
  });
});

test('DSH capability profile exposes only enforced Muse/headless features', () => {
  const profile = dshCapabilityProfile({ tool_mode: 'both', max_tokens: 4096 });
  assert.deepEqual(profile.model, {
    provider: 'meta',
    id: DSH_MODEL,
    name: 'Muse Spark 1.2 Contributor',
    context_window_tokens: DSH_CONTEXT_WINDOW_TOKENS,
    max_output_tokens: DSH_MAX_OUTPUT_TOKENS,
    model_input_modalities: ['text', 'image'],
    connector_input_modalities: ['text'],
    effective_max_output_tokens: 4096,
  });
  assert.deepEqual(profile.tools, {
    default_mode: 'native',
    modes: ['native', 'code', 'both'],
    code_runtime: 'typescript',
    effective_mode: 'both',
  });
  assert.deepEqual(profile.delegation.subagent, {
    available: true,
    tool_name: 'subagent',
    background_mode: 'continuable',
    foreground_override: true,
    external_followup: false,
    survives_headless_exit: false,
  });
  assert.deepEqual(profile.delegation.fork, {
    available: true,
    tool_name: 'subagent_fork',
    background_mode: 'one-shot',
    foreground_default: true,
    inherits_parent_context: true,
    survives_headless_exit: false,
  });
  assert.deepEqual(profile.delegation.workflow, {
    available: true,
    tool_name: 'workflow',
    foreground_only: true,
  });
  assert.deepEqual(profile.delegation.ralph, {
    available: true,
    tool_name: 'ralph',
    foreground_only: true,
    max_rounds: DSH_MAX_RALPH_ROUNDS,
  });
  assert.deepEqual(profile.execution, {
    runner: 'one-shot',
    interactive_followup: false,
    external_child_collection: false,
    image_input_exposed: false,
  });
  // The returned profile is detached from the adapter constants.
  profile.tools.modes.push('invalid');
  assert.deepEqual(dshCapabilityProfile().tools.modes, ['native', 'code', 'both']);
});

test('DSH options are bounded to the managed route and tool modes', () => {
  assert.deepEqual(normalizeDshOptions({ model: DSH_MODEL, tool_mode: 'code', max_tokens: 2048 }), {
    model: DSH_MODEL,
    tool_mode: 'code',
    max_tokens: 2048,
  });
  assert.throws(() => normalizeDshOptions({ model: 'other-model' }), /supports only/);
  assert.throws(() => normalizeDshOptions({ tool_mode: 'shell' }), /tool mode/);
  assert.throws(() => normalizeDshOptions({ max_tokens: 0 }), /max_tokens/);
  assert.throws(() => normalizeDshOptions({ max_tokens: DSH_MAX_OUTPUT_TOKENS + 1 }), /max_tokens/);
  assert.throws(() => normalizeDshOptions({ workflow: true }), /workflow.*not supported/);
  assert.deepEqual(dshChildEnvironment('/tmp/custom-dsh', { tool_mode: 'code', max_tokens: 2048 }), {
    DSH_HOME: '/tmp/custom-dsh',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TOOLS_MODE: 'code',
    CODEX_CO_ENGINEER_DSH_MODEL: DSH_MODEL,
    CODEX_CO_ENGINEER_DSH_MAX_TOKENS: '2048',
  });
});

test('installed DSH dump confirms the managed headless delegation rows without a provider call', async (context) => {
  const version = dshVersionProbe();
  if (!version.compatible) return context.skip('compatible dsh executable is not installed');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-dump-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync('dsh', [
    '--profile', 'headless',
    '--patch', DEFAULT_DSH_PATCH_FILE,
    '--dump-config',
  ], {
    cwd: directory,
    env: {
      ...process.env,
      ...dshChildEnvironment(directory, { tool_mode: 'both', max_tokens: 4096 }),
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /id: agent-default-model[\s\S]*provider: meta/);
  assert.match(result.stdout, /id: tool-subagent[\s\S]*backgroundMode: continuable/);
  assert.match(result.stdout, /id: tool-subagent-fork[\s\S]*backgroundMode: one-shot/);
  assert.match(result.stdout, /id: tool-workflow/);
  assert.match(result.stdout, /id: tool-ralph[\s\S]*maxRounds: 64/);
  assert.match(result.stdout, /id: tools[\s\S]*DSH_TOOLS_MODE/);
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
