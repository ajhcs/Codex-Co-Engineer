import assert from 'node:assert/strict';
import fs, { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  closeGrokOuterRuntime,
  consumeGrokOuterRuntime,
  GrokOuterRuntimeError,
  inspectGrokOuterElfFixtureForTest,
  prepareGrokOuterRuntime,
} from '../mcp/grok-outer-runtime.mjs';

function readFd(fd, length) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(length);
    fs.read(fd, buffer, 0, buffer.length, null, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(buffer.subarray(0, bytesRead).toString('utf8'));
    });
  });
}

function writeFd(fd) {
  return new Promise((resolve, reject) => fs.write(fd, Buffer.from('x'), (error) => (error ? reject(error) : resolve())));
}

function chmodFd(fd) {
  return new Promise((resolve, reject) => fs.fchmod(fd, 0o700, (error) => (error ? reject(error) : resolve())));
}

const HOST_COMMANDS = Object.freeze({
  bash: '/usr/bin/bash',
  sh: '/usr/bin/dash',
  git: '/usr/bin/git',
  rg: '/usr/bin/rg',
});

const CLASSIFIED_HOST_PREREQUISITE_FAILURES = new Set([
  'missing_runtime',
  'resolver_unavailable',
  'unsafe_ancestor',
  'unsafe_resolver',
  'unsafe_runtime',
  'unresolved_dependency',
  'unsupported_format',
  'unsupported_platform',
]);

async function prepareHostRuntimeOrSkip(t) {
  const capability = await prepareGrokOuterRuntime({ commands: HOST_COMMANDS });
  if (capability.ready) return capability;
  assert.deepEqual(Object.keys(capability).sort(), ['entry_count', 'manifest_sha256', 'ready', 'reason']);
  assert.equal(capability.entry_count, 0);
  assert.equal(capability.manifest_sha256, null);
  assert.doesNotMatch(JSON.stringify(capability), /\/(?:usr|etc|lib|home)\//);
  assert.equal(
    CLASSIFIED_HOST_PREREQUISITE_FAILURES.has(capability.reason),
    true,
    `unexpected Grok outer runtime failure: ${capability.reason}`,
  );
  t.skip(`classified: real Grok outer runtime prerequisite is unavailable (${capability.reason})`);
  return null;
}

async function temporaryTree(mode = 0o700) {
  const root = await mkdtemp('/tmp/grok-runtime-test-');
  const safe = path.join(root, 'safe');
  await mkdir(safe, { mode });
  await chmod(safe, mode);
  return { root, safe };
}

function repeatedConfig(source, extra = {}) {
  return {
    commands: { bash: source, sh: source, git: source, rg: source },
    gitHelpers: {
      'git-upload-pack': source,
      'git-receive-pack': source,
      'git-remote-http': source,
      'git-remote-https': source,
    },
    systemFiles: {
      ca: source,
      services: source,
      localtime: source,
    },
    ...extra,
  };
}

async function hostileElfCopy(source, destination, mutation) {
  const bytes = await readFile(source);
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  const phnum = bytes.readUInt16LE(56);
  const headers = Array.from({ length: phnum }, (_, index) => phoff + index * phentsize);
  mutation(bytes, headers);
  await writeFile(destination, bytes, { mode: 0o700 });
  await chmod(destination, 0o700);
  return destination;
}

test('provider-free host capability probe attests a bounded path-free runtime', async (t) => {
  const capability = await prepareHostRuntimeOrSkip(t);
  if (capability === null) return;
  try {
    assert.equal(capability.ready, true, capability.reason);
    assert.equal(capability.reason, null);
    assert.ok(capability.entry_count > 10 && capability.entry_count <= 64);
    assert.match(capability.manifest_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(capability).sort(), ['entry_count', 'manifest_sha256', 'ready', 'reason']);
    assert.doesNotMatch(JSON.stringify(capability), /\/(?:usr|etc|lib|home)\//);

    const [first, second] = await Promise.allSettled([
      consumeGrokOuterRuntime(capability),
      consumeGrokOuterRuntime(capability),
    ]);
    const fulfilled = [first, second].filter((result) => result.status === 'fulfilled');
    const rejected = [first, second].filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'invalid_runtime_handle');
    const handoff = fulfilled[0].value;
    assert.equal(handoff.manifest_sha256, capability.manifest_sha256);
    assert.equal(handoff.entries.length, capability.entry_count);
    assert.ok(handoff.entries.every((entry) => Number.isInteger(entry.fd) && entry.fd >= 0));
    assert.ok(handoff.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
    assert.ok(handoff.entries.some((entry) => entry.version?.startsWith('dynamic-elf-sha256:')));
    const passwd = handoff.entries.find((entry) => entry.destinations.includes('/etc/passwd'));
    const group = handoff.entries.find((entry) => entry.destinations.includes('/etc/group'));
    const resolver = handoff.entries.find((entry) => entry.destinations.includes('/etc/resolv.conf'));
    const bash = handoff.entries.find((entry) => entry.destinations.includes('/usr/bin/bash'));
    const passwdText = await readFd(passwd.fd, passwd.size);
    assert.equal(passwdText, 'grok:x:10000:10000:Grok Runtime:/home/grok:/usr/bin/sh\n');
    assert.equal(await readFd(group.fd, group.size), 'grok:x:10000:\n');
    const resolverText = await readFd(resolver.fd, resolver.size);
    assert.match(resolverText, /^nameserver (?:[0-9a-f:.]+)\n/m);
    assert.doesNotMatch(resolverText, /^(?:search|domain)\s|[#;]/m);
    assert.doesNotMatch(passwdText, /plumbob|\/home\/(?!grok)/);
    assert.equal((await stat(`/proc/self/fd/${bash.fd}`)).uid, 0);
    await assert.rejects(writeFd(passwd.fd), (error) => ['EBADF', 'EPIPE'].includes(error?.code));
    // Linux permits metadata-only fchmod on a pipe inode. It cannot create a
    // write endpoint or make the anonymous pipe reopenable.
    await chmodFd(passwd.fd);
    await assert.rejects(writeFd(passwd.fd), (error) => ['EBADF', 'EPIPE'].includes(error?.code));
    await assert.rejects(open(`/proc/self/fd/${passwd.fd}`, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK), (error) => error?.code === 'ENXIO');
    await assert.rejects(open(`/proc/self/fd/${passwd.fd}`, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK), (error) => error?.code === 'ENXIO');
    await assert.rejects(
      consumeGrokOuterRuntime(capability),
      (error) => error instanceof GrokOuterRuntimeError && error.code === 'invalid_runtime_handle',
    );
  } finally {
    await closeGrokOuterRuntime(capability);
  }
});

test('raw host identity and resolver paths cannot be configured into the closure', async () => {
  for (const name of ['passwd', 'group', 'resolver']) {
    const result = await prepareGrokOuterRuntime({ systemFiles: { [name]: `/etc/${name === 'resolver' ? 'resolv.conf' : name}` } });
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'invalid_configuration');
  }
});

test('explicit command paths must be canonical non-symlinks and safe ancestors fail closed', async () => {
  const tree = await temporaryTree();
  const alias = path.join(tree.safe, 'bash-link');
  await symlink('/usr/bin/bash', alias);
  const symlinked = await prepareGrokOuterRuntime({ commands: { ...HOST_COMMANDS, bash: alias } });
  assert.deepEqual(symlinked, {
    ready: false, reason: 'non_canonical_runtime', entry_count: 0, manifest_sha256: null,
  });

  const unsafeTree = await temporaryTree(0o770);
  const copied = path.join(unsafeTree.safe, 'bash');
  await copyFile('/usr/bin/bash', copied);
  await chmod(copied, 0o700);
  const unsafe = await prepareGrokOuterRuntime(repeatedConfig(copied));
  assert.equal(unsafe.ready, false);
  assert.equal(unsafe.reason, 'unsafe_ancestor');
  assert.doesNotMatch(JSON.stringify(unsafe), new RegExp(unsafeTree.root));
});

test('ELF closure rejects unresolved dependencies and malformed synthetic ELF metadata', async (t) => {
  const host = await prepareHostRuntimeOrSkip(t);
  if (host === null) return;
  await closeGrokOuterRuntime(host);
  const tree = await temporaryTree();
  const emptyLibraries = path.join(tree.safe, 'libraries');
  await mkdir(emptyLibraries, { mode: 0o700 });
  const unresolved = await prepareGrokOuterRuntime({
    commands: HOST_COMMANDS,
    libraryDirectories: [emptyLibraries],
  });
  assert.equal(unresolved.ready, false);
  assert.equal(unresolved.reason, 'unresolved_dependency');

  const malformed = path.join(tree.safe, 'malformed-elf');
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  await writeFile(malformed, bytes, { mode: 0o700 });
  await chmod(malformed, 0o700);
  await assert.rejects(
    inspectGrokOuterElfFixtureForTest(malformed),
    (error) => error instanceof GrokOuterRuntimeError && error.code === 'unsupported_elf',
  );
});

test('ELF parser rejects duplicate control headers and overlapping load mappings', async () => {
  const tree = await temporaryTree();
  const mutations = {
    duplicate_interp(bytes, headers) {
      const original = headers.findIndex((base) => bytes.readUInt32LE(base) === 3);
      const later = headers.findIndex((base, index) => index > original && bytes.readUInt32LE(base) !== 1);
      assert.ok(original >= 0 && later > original);
      bytes.writeUInt32LE(3, headers[later]);
    },
    duplicate_dynamic(bytes, headers) {
      const original = headers.findIndex((base) => bytes.readUInt32LE(base) === 2);
      const later = headers.findIndex((base, index) => index > original && ![1, 3].includes(bytes.readUInt32LE(base)));
      assert.ok(original >= 0 && later > original);
      bytes.writeUInt32LE(2, headers[later]);
    },
    overlapping_loads(bytes, headers) {
      const loads = headers.filter((base) => bytes.readUInt32LE(base) === 1);
      assert.ok(loads.length >= 2);
      bytes.writeBigUInt64LE(bytes.readBigUInt64LE(loads[0] + 16), loads[1] + 16);
    },
  };
  for (const [name, mutation] of Object.entries(mutations)) {
    const executable = await hostileElfCopy('/usr/bin/bash', path.join(tree.safe, name), mutation);
    await assert.rejects(
      inspectGrokOuterElfFixtureForTest(executable),
      (error) => error instanceof GrokOuterRuntimeError && error.code === 'ambiguous_elf',
      name,
    );
  }
});

test('distinct duplicate dependency candidates are rejected instead of using directory order', async (t) => {
  const host = await prepareHostRuntimeOrSkip(t);
  if (host === null) return;
  await closeGrokOuterRuntime(host);
  const tree = await temporaryTree();
  const duplicateDirectory = path.join(tree.safe, 'duplicate-libs');
  await mkdir(duplicateDirectory, { mode: 0o700 });
  await copyFile('/usr/lib/x86_64-linux-gnu/libc.so.6', path.join(duplicateDirectory, 'libc.so.6'));
  await chmod(path.join(duplicateDirectory, 'libc.so.6'), 0o600);
  const result = await prepareGrokOuterRuntime({
    commands: HOST_COMMANDS,
    libraryDirectories: ['/usr/lib/x86_64-linux-gnu', duplicateDirectory],
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'ambiguous_dependency');
});

test('entry limit is enforced after inode deduplication without leaking paths', async (t) => {
  const host = await prepareHostRuntimeOrSkip(t);
  if (host === null) return;
  await closeGrokOuterRuntime(host);
  const result = await prepareGrokOuterRuntime({ commands: HOST_COMMANDS, maxEntries: 1 });
  assert.deepEqual(result, {
    ready: false, reason: 'runtime_too_large', entry_count: 0, manifest_sha256: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /\/(?:usr|etc|lib|home)\//);
});

test('synthetic pipe overflow closes its descriptor across repeated maxEntries failures', async (t) => {
  const host = await prepareHostRuntimeOrSkip(t);
  if (host === null) return;
  await closeGrokOuterRuntime(host);
  const config = repeatedConfig('/usr/bin/bash', { maxEntries: 1 });
  const baseline = (await readdir('/proc/self/fd')).length;
  for (let index = 0; index < 16; index += 1) {
    const result = await prepareGrokOuterRuntime(config);
    assert.deepEqual(result, {
      ready: false, reason: 'runtime_too_large', entry_count: 0, manifest_sha256: null,
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readdir('/proc/self/fd')).length, baseline);
});

test('current-owned configurable closure input is rejected even when otherwise safe', async () => {
  const tree = await temporaryTree();
  const executable = path.join(tree.safe, 'runtime');
  await copyFile('/usr/bin/bash', executable);
  await chmod(executable, 0o700);
  const canonical = await realpath(executable);
  const capability = await prepareGrokOuterRuntime(repeatedConfig(canonical));
  assert.equal(capability.ready, false);
  assert.equal(capability.reason, 'unsafe_ancestor');
});
