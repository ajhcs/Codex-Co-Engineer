import assert from 'node:assert/strict';
import {
  chmod,
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  assertCleanAmbientEnvironment,
  createProviderRegistry,
  deriveRolePolicy,
  normalizeCreateConfig,
  probeProvider,
} from '../mcp/acp-provider-registry.mjs';

async function stageDirectories() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return new Set(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('codex-acp-registry-'))
    .map((entry) => join(tmpdir(), entry.name)));
}

async function fakeCli(directory, name, version, help) {
  const file = join(directory, name);
  const source = `#!/usr/bin/python3
import sys
args = sys.argv[1:]
if args == ['--version']:
    sys.stdout.write(${JSON.stringify(`${name} ${version}\n`)})
elif args in (['agent', 'stdio', '--help'], ['acp', '--help']):
    sys.stdout.write(${JSON.stringify(`${help}\n`)})
elif args == ['--help']:
    sys.stdout.write('top-level delegation capability is not evidence\\n')
else:
    raise SystemExit(64)
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

test('local ACP profiles are fixed and create config is typed', () => {
  const registry = createProviderRegistry({
    executablePaths: {
      grok: '/tmp/fake/grok',
      'cursor-agent': '/tmp/fake/cursor-agent',
    },
  });
  assert.throws(
    () => registry.create({ profile: 'grok-local-acp', role: 'implement' }),
    (error) => error.code === 'role_authority_required',
  );
  assert.deepEqual(registry.listProfiles().map((profile) => ({
    id: profile.id,
    executable: profile.executable,
    argv: profile.argv,
  })), [
    { id: 'grok-local-acp', executable: 'grok', argv: ['agent', 'stdio'] },
    { id: 'cursor-local-acp', executable: 'cursor-agent', argv: ['acp'] },
  ]);
  assert.throws(
    () => normalizeCreateConfig({ profile: 'grok-local-acp', command: 'sh' }),
    (error) => error.code === 'unsupported_config',
  );
  assert.throws(
    () => normalizeCreateConfig({ profile: 'grok-local-acp', raw_config: {} }),
    (error) => error.code === 'unsupported_config',
  );
  assert.throws(
    () => normalizeCreateConfig({ profile: 'unknown' }),
    (error) => error.code === 'unsupported_profile',
  );
  assert.throws(
    () => normalizeCreateConfig({ profile: 'grok-local-acp', reasoning_effort: 'unsafe' }),
    (error) => error.code === 'invalid_config',
  );
  assert.throws(
    () => normalizeCreateConfig({ profile: 'cursor-local-acp', max_turns: 65 }),
    (error) => error.code === 'invalid_config',
  );
  assert.throws(
    () => normalizeCreateConfig({ profile: 'cursor-local-acp', allowed_tools: ['read', 'read'] }),
    (error) => error.code === 'invalid_config',
  );
  assert.throws(
    () => normalizeCreateConfig({ profile: 'cursor-local-acp', role: 'review', allowed_tools: ['shell'] }),
    (error) => error.code === 'unsupported_capability',
  );
  assert.throws(
    () => normalizeCreateConfig({ profile: 'grok-local-acp', role: 'implement' }),
    (error) => error.code === 'role_authority_required',
  );
  assert.deepEqual(deriveRolePolicy('review'), {
    role: 'review',
    permission: 'read-only',
    permission_mode: 'read-only',
    write_ceiling: 'read-only',
    writeCeiling: 'read-only',
  });
  assert.equal(deriveRolePolicy('verify').write_ceiling, 'read-only');
  assert.equal(deriveRolePolicy('implement').write_ceiling, 'declared-paths');
});

test('version/help probing is bounded, shell-free, and omits absolute source paths', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-registry-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const grok = await fakeCli(directory, 'grok', '1.2.3', 'grok agent stdio supports delegation and sessions');
  const cursor = await fakeCli(directory, 'cursor-agent', '4.5.6', 'cursor-agent acp supports tools');
  const registry = createProviderRegistry({ executablePaths: { grok, 'cursor-agent': cursor } });
  context.after(() => registry.close());

  const before = registry.publicSummary('grok-local-acp');
  assert.equal(before.version, null);
  assert.equal(Object.hasOwn(before, 'path'), false);
  assert.equal(JSON.stringify(before).includes(directory), false);

  const descriptor = await registry.probe('grok-local-acp');
  assert.equal(descriptor.version, '1.2.3');
  assert.deepEqual(descriptor.argv, ['agent', 'stdio']);
  assert.equal(descriptor.capabilities.delegation.supported, true);
  assert.equal(descriptor.capabilities.delegation.effective, 'unknown');
  assert.equal(JSON.stringify(descriptor).includes(directory), false);
  assert.equal(Object.hasOwn(descriptor, 'source'), false);
  assert.equal(Object.hasOwn(descriptor, 'path'), false);

  const grokCreate = registry.create({
    profile: 'grok-local-acp',
    role: 'review',
    model: 'grok-4.6',
    reasoning_effort: 'high',
    delegation: true,
  }, { role: 'review' });
  assert.equal(grokCreate.permission, 'read-only');
  assert.equal(grokCreate.write_ceiling, 'read-only');
  assert.deepEqual(grokCreate.capabilities.delegation, {
    requested: true,
    supported: true,
    effective: 'unknown',
  });

  const cursorDescriptor = await registry.probe('cursor-local-acp');
  assert.equal(cursorDescriptor.version, '4.5.6');
  assert.equal(cursorDescriptor.capabilities.delegation.supported, 'unknown');
  const cursorCreate = registry.create({
    profile: 'cursor-local-acp',
    role: 'implement',
    model: 'cursor-default',
    allowed_tools: ['read', 'grep'],
    max_turns: 12,
  }, { role: 'implement' });
  assert.equal(cursorCreate.permission, 'workspace');
  assert.equal(cursorCreate.write_ceiling, 'declared-paths');
  const cursorSpec = await cursorCreate.spawnSpec();
  assert.equal(cursorSpec.file, '/usr/bin/python3.12');
  assert.deepEqual(cursorSpec.argv.slice(0, 3), ['-I', '-S', '-c']);
  assert.equal(cursorSpec.argv[3].includes('F_ADD_SEALS'), true);
  assert.deepEqual(cursorSpec.argv.slice(-2), ['cursor-agent', 'acp']);
  assert.deepEqual(cursorSpec.env, {
    PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  });
  assert.equal(cursorSpec.shell, false);
  assert.equal(cursorSpec.pinned_fd > 2, true);
  assert.deepEqual(cursorSpec.stdio.slice(0, 3), ['ignore', 'pipe', 'pipe']);
  await registry.close();
});

test('real CLI layouts stage symlinked/writable sources but reject hardlinks', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-registry-provenance-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = await fakeCli(directory, 'real-grok', '1.0.0', 'grok delegation');
  const symlinkPath = join(directory, 'grok');
  await symlink(source, symlinkPath);
  const symlinkRegistry = createProviderRegistry({ executablePaths: { grok: symlinkPath } });
  const symlinkDescriptor = await symlinkRegistry.probe('grok-local-acp');
  assert.equal(symlinkDescriptor.version, '1.0.0');
  const symlinkSpec = await symlinkRegistry.create({ profile: 'grok-local-acp' }, { role: 'review' }).spawnSpec();
  assert.notEqual(symlinkSpec.file, symlinkPath);
  await symlinkRegistry.close();

  const hardlinkDirectory = await mkdtemp(join(tmpdir(), 'acp-registry-hardlink-'));
  context.after(() => rm(hardlinkDirectory, { recursive: true, force: true }));
  const hardlinkSource = await fakeCli(hardlinkDirectory, 'grok-source', '1.0.0', 'grok delegation');
  const hardlinkPath = join(hardlinkDirectory, 'grok');
  await link(hardlinkSource, hardlinkPath);
  const hardlinkRegistry = createProviderRegistry({ executablePaths: { grok: hardlinkPath } });
  await assert.rejects(() => hardlinkRegistry.probe('grok-local-acp'), (error) => error.code === 'unsafe_executable');

  const writableDirectory = await mkdtemp(join(tmpdir(), 'acp-registry-writable-'));
  context.after(() => rm(writableDirectory, { recursive: true, force: true }));
  const writable = await fakeCli(writableDirectory, 'grok', '1.0.0', 'grok delegation');
  await chmod(writable, 0o775);
  const writableRegistry = createProviderRegistry({ executablePaths: { grok: writable } });
  assert.equal((await writableRegistry.probe('grok-local-acp')).version, '1.0.0');
  await writableRegistry.close();
});

test('ambient loader injection variables fail closed', () => {
  assert.throws(
    () => assertCleanAmbientEnvironment({ NODE_OPTIONS: '' }),
    (error) => error.code === 'unsafe_environment',
  );
  assert.throws(
    () => assertCleanAmbientEnvironment({ LD_PRELOAD: '/tmp/injected.so' }),
    (error) => error.code === 'unsafe_environment',
  );
  assert.doesNotThrow(() => assertCleanAmbientEnvironment({ PATH: '/usr/bin' }));
});

test('standalone probe closes its exact private stage directory', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-registry-probe-provider-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const grok = await fakeCli(directory, 'grok', '1.2.3', 'grok agent stdio supports delegation');
  const before = await stageDirectories();
  await probeProvider('grok-local-acp', { executablePaths: { grok } });
  const after = await stageDirectories();
  assert.deepEqual([...after].filter((path) => !before.has(path)), []);
});

test('help capability evidence is bounded and descendant probes are group-cleaned', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-registry-hostile-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const oversized = await fakeCli(directory, 'grok', '1.0.0', `grok ${'x'.repeat(70 * 1024)}`);
  const oversizedRegistry = createProviderRegistry({ executablePaths: { grok: oversized } });
  await assert.rejects(
    () => oversizedRegistry.probe('grok-local-acp'),
    (error) => error.code === 'probe_output_limit',
  );

  const pidFile = join(directory, 'descendant.pid');
  const stubborn = join(directory, 'cursor-agent');
  await writeFile(stubborn, `#!/usr/bin/python3
import subprocess, sys, time
args = sys.argv[1:]
if args == ['--version']:
  child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
  with open(${JSON.stringify(pidFile)}, 'w') as output: output.write(str(child.pid))
  print('cursor-agent 1.0.0', flush=True)
  time.sleep(60)
elif args == ['acp', '--help']:
  print('cursor-agent acp')
else: raise SystemExit(64)
`, { mode: 0o755 });
  await chmod(stubborn, 0o755);
  const stubbornRegistry = createProviderRegistry({
    executablePaths: { 'cursor-agent': stubborn },
    probeTimeoutMs: 100,
  });
  const probe = stubbornRegistry.probe('cursor-local-acp');
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(pidFile, 'utf8')).trim()) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await assert.rejects(probe, (error) => error.code === 'probe_timeout');
  const descendantPid = Number((await readFile(pidFile, 'utf8')).trim());
  let gone = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(descendantPid, 0); } catch (error) {
      if (error?.code === 'ESRCH') { gone = true; break; }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(gone, true);
});
