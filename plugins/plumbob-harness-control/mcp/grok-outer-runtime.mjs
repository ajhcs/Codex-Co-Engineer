import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  realpath,
} from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const PRIVATE = new WeakMap();
const MAX_ENTRIES = 64;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const REQUIRED_COMMANDS = Object.freeze({
  bash: '/usr/bin/bash',
  sh: '/usr/bin/dash',
  git: '/usr/bin/git',
  rg: '/usr/bin/rg',
});
const REQUIRED_HELPERS = Object.freeze({
  'git-upload-pack': '/usr/lib/git-core/git-upload-pack',
  'git-receive-pack': '/usr/lib/git-core/git-receive-pack',
  'git-remote-http': '/usr/lib/git-core/git-remote-http',
  'git-remote-https': '/usr/lib/git-core/git-remote-https',
});
const HOST_SYSTEM_FILES = Object.freeze({
  ca: '/etc/ssl/certs/ca-certificates.crt',
  services: '/etc/services',
  localtime: '/usr/share/zoneinfo/Etc/UTC',
});
const SYSTEM_DESTINATIONS = Object.freeze({
  ca: '/etc/ssl/certs/ca-certificates.crt',
  services: '/etc/services',
  localtime: '/etc/localtime',
});
const SYNTHETIC_SYSTEM_FILES = Object.freeze({
  passwd: Object.freeze({ destination: '/etc/passwd', contents: 'grok:x:10000:10000:Grok Runtime:/home/grok:/usr/bin/sh\n' }),
  group: Object.freeze({ destination: '/etc/group', contents: 'grok:x:10000:\n' }),
});
const LIBRARY_DIRECTORIES = Object.freeze([
  '/lib/x86_64-linux-gnu',
  '/usr/lib/x86_64-linux-gnu',
  '/lib64',
  '/usr/lib64',
]);

export class GrokOuterRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GrokOuterRuntimeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GrokOuterRuntimeError(code, message);
}

function plain(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_configuration', `${field} must be a plain object.`);
  return value;
}

function exact(value, allowed, field) {
  plain(value, field);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('invalid_configuration', `${field}.${key} is not allowed.`);
  }
}

function absolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > 4096) {
    fail('invalid_configuration', `${field} must be a bounded absolute path.`);
  }
  return path.normalize(value);
}

function modeOf(stat) {
  return Number(stat.mode) & 0o7777;
}

function identity(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
    uid: String(stat.uid), gid: String(stat.gid), mode: String(stat.mode),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  });
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function digestHandle(handle, size) {
  const length = Number(size);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES) fail('unsafe_runtime', 'A runtime file has an unsafe size.');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(buffer, 0, Math.min(buffer.length, length - offset), offset);
    if (read.bytesRead <= 0) fail('runtime_changed', 'A runtime file ended while it was being attested.');
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  return hash.digest('hex');
}

async function safeAncestors(canonical) {
  if (!Number.isInteger(process.getuid?.())) fail('unsupported_platform', 'A POSIX uid is required.');
  let current = path.dirname(canonical);
  while (true) {
    const stat = await lstat(current, { bigint: true }).catch(() => fail('missing_runtime', 'A runtime ancestor is unavailable.'));
    const owner = Number(stat.uid);
    const mode = modeOf(stat);
    const stickyRoot = owner === 0 && (mode & 0o1000) !== 0;
    const ownerTrusted = owner === 0;
    if (!stat.isDirectory() || !ownerTrusted || ((mode & 0o022) !== 0 && !stickyRoot)) {
      fail('unsafe_ancestor', 'A runtime ancestor is writable or has an untrusted owner.');
    }
    if (current === '/') break;
    current = path.dirname(current);
  }
}

async function pin(source, {
  executable, allowAlias = false, label, destinations,
}) {
  const requested = absolute(source, label);
  const requestedStat = await lstat(requested, { bigint: true }).catch(() => fail('missing_runtime', `${label} is unavailable.`));
  if (!allowAlias && requestedStat.isSymbolicLink()) fail('non_canonical_runtime', `${label} must not be a symlink.`);
  const canonical = await realpath(requested).catch(() => fail('missing_runtime', `${label} cannot be resolved.`));
  if (!allowAlias && canonical !== requested) fail('non_canonical_runtime', `${label} must be canonical.`);
  await safeAncestors(canonical);
  const before = await lstat(canonical, { bigint: true }).catch(() => fail('missing_runtime', `${label} is unavailable.`));
  if (!before.isFile() || before.isSymbolicLink()) fail('unsafe_runtime', `${label} must resolve to a regular file.`);
  const ownerTrusted = Number(before.uid) === 0;
  if (!ownerTrusted || (modeOf(before) & 0o022) !== 0 || Number(before.nlink) !== 1) {
    fail('unsafe_runtime', `${label} has an unsafe owner, mode, or link count.`);
  }
  if (executable && (modeOf(before) & 0o111) === 0) fail('unsafe_runtime', `${label} is not executable.`);
  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(after))) fail('runtime_changed', `${label} changed while opening.`);
    const digest = await digestHandle(handle, after.size);
    const [postHandle, postPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(canonical, { bigint: true }).catch(() => fail('runtime_changed', `${label} disappeared after hashing.`)),
    ]);
    const sourceIdentity = identity(after);
    if (!sameIdentity(sourceIdentity, identity(postHandle)) || !sameIdentity(sourceIdentity, identity(postPath))) {
      fail('runtime_changed', `${label} changed while being hashed.`);
    }
    return {
      handle,
      canonical,
      pipe: false,
      identity: sourceIdentity,
      digest,
      size: Number(after.size),
      executable,
      destinations: [...destinations],
      dedupeKey: `${sourceIdentity.dev}:${sourceIdentity.ino}`,
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function makeReadPipe(contents, { destination, label }) {
  const bytes = Buffer.from(contents, 'utf8');
  if (bytes.length === 0 || bytes.length > 16 * 1024) fail('unsafe_runtime', `${label} is empty or too large.`);
  const encoded = bytes.toString('base64');
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    'process.stdout.write(Buffer.from(process.argv[1],"base64"));',
    encoded,
  ], {
    cwd: '/',
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stream = child.stdout;
  const pipeHandle = stream?._handle;
  if (!pipeHandle || !Number.isInteger(pipeHandle.fd) || typeof pipeHandle.readStop !== 'function') {
    child.kill('SIGKILL');
    fail('unsupported_platform', 'Node did not expose an anonymous pipe descriptor.');
  }
  pipeHandle.readStop();
  // Detach Node's Readable wrapper so EOF does not close the retained kernel
  // pipe. Only the private native handle below retains the read end.
  stream._handle = null;
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).catch((error) => {
    pipeHandle.close();
    fail('pipe_creation_failed', `${label} pipe writer failed: ${error.message}`);
  });
  if (result.code !== 0 || result.signal !== null || !Number.isInteger(pipeHandle.fd)) {
    pipeHandle.close();
    fail('pipe_creation_failed', `${label} pipe writer did not complete.`);
  }
  return {
    handle: null,
    pipeHandle,
    fd: pipeHandle.fd,
    canonical: null,
    pipe: true,
    identity: null,
    digest: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    executable: false,
    destinations: [destination],
  };
}

async function sanitizedResolverContents() {
  const requested = '/etc/resolv.conf';
  const canonical = await realpath(requested).catch(() => fail('resolver_unavailable', 'Host resolver configuration is unavailable.'));
  const before = await lstat(canonical, { bigint: true }).catch(() => fail('resolver_unavailable', 'Host resolver configuration is unavailable.'));
  if (!before.isFile() || before.isSymbolicLink() || (modeOf(before) & 0o022) !== 0 || Number(before.size) > 64 * 1024) {
    fail('unsafe_resolver', 'Host resolver configuration is not a bounded read-only regular file.');
  }
  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(opened))) fail('runtime_changed', 'Host resolver configuration changed while opening.');
    const raw = await readFile(handle, { encoding: 'utf8' });
    const [postHandle, postPath] = await Promise.all([handle.stat({ bigint: true }), lstat(canonical, { bigint: true })]);
    if (!sameIdentity(identity(opened), identity(postHandle)) || !sameIdentity(identity(opened), identity(postPath))) {
      fail('runtime_changed', 'Host resolver configuration changed while reading.');
    }
    const nameservers = [];
    const options = new Set();
    for (const rawLine of raw.split(/\r?\n/).slice(0, 256)) {
      const line = rawLine.replace(/[;#].*$/, '').trim();
      if (!line) continue;
      const fields = line.split(/\s+/);
      if (fields[0] === 'nameserver' && fields.length === 2 && isIP(fields[1]) && nameservers.length < 3) {
        if (!nameservers.includes(fields[1])) nameservers.push(fields[1]);
      }
      if (fields[0] === 'options') {
        for (const token of fields.slice(1, 17)) {
          if (/^(?:edns0|trust-ad|rotate|single-request|single-request-reopen)$/.test(token)
            || /^(?:attempts:[1-5]|timeout:(?:[1-9]|[12][0-9]|30)|ndots:(?:[0-9]|1[0-5]))$/.test(token)) options.add(token);
        }
      }
    }
    if (nameservers.length === 0) fail('resolver_unavailable', 'Host resolver configuration has no usable nameserver.');
    return `${nameservers.map((value) => `nameserver ${value}`).join('\n')}${options.size ? `\noptions ${[...options].join(' ')}` : ''}\n`;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readAt(handle, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
    fail('unsupported_elf', 'ELF metadata is out of bounds.');
  }
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, offset);
  if (result.bytesRead !== length) fail('unsupported_elf', 'ELF metadata is truncated.');
  return buffer;
}

async function elfMetadata(entry) {
  const head = await readAt(entry.handle, 0, Math.min(entry.size, 64));
  if (head.length < 64 || !head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    fail('unsupported_format', 'A required executable or library is not ELF64.');
  }
  if (head[4] !== 2 || head[5] !== 1) fail('unsupported_elf', 'Only little-endian ELF64 is supported.');
  const phoff = Number(head.readBigUInt64LE(32));
  const phentsize = head.readUInt16LE(54);
  const phnum = head.readUInt16LE(56);
  if (phentsize < 56 || phnum === 0 || phnum > 1024) fail('unsupported_elf', 'ELF program headers are invalid.');
  const table = await readAt(entry.handle, phoff, phentsize * phnum);
  const loads = [];
  let dynamic = null;
  let interpreter = null;
  for (let index = 0; index < phnum; index += 1) {
    const base = index * phentsize;
    const type = table.readUInt32LE(base);
    const offset = Number(table.readBigUInt64LE(base + 8));
    const virtual = Number(table.readBigUInt64LE(base + 16));
    const fileSize = Number(table.readBigUInt64LE(base + 32));
    const memorySize = Number(table.readBigUInt64LE(base + 40));
    for (const value of [offset, virtual, fileSize, memorySize]) {
      if (!Number.isSafeInteger(value) || value < 0) fail('unsupported_elf', 'ELF program header is out of bounds.');
    }
    if (type === 1) {
      if (fileSize > memorySize || offset + fileSize > entry.size || !Number.isSafeInteger(virtual + memorySize)) {
        fail('unsupported_elf', 'ELF load segment is invalid.');
      }
      loads.push({ offset, virtual, fileSize, memorySize });
    }
    if (type === 2) {
      if (dynamic !== null) fail('ambiguous_elf', 'ELF contains multiple dynamic segments.');
      if (offset + fileSize > entry.size || fileSize % 16 !== 0) fail('unsupported_elf', 'ELF dynamic segment is invalid.');
      dynamic = { offset, virtual, fileSize, memorySize };
    }
    if (type === 3) {
      if (interpreter !== null) fail('ambiguous_elf', 'ELF contains multiple interpreter segments.');
      const bytes = await readAt(entry.handle, offset, fileSize);
      const nul = bytes.indexOf(0);
      interpreter = bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
      if (!path.isAbsolute(interpreter) || interpreter.includes('\0')) fail('unsupported_elf', 'ELF interpreter is unsafe.');
    }
  }
  const sortedLoads = [...loads].sort((left, right) => left.virtual - right.virtual);
  for (let index = 1; index < sortedLoads.length; index += 1) {
    const prior = sortedLoads[index - 1];
    if (prior.virtual + prior.memorySize > sortedLoads[index].virtual) {
      fail('ambiguous_elf', 'ELF load segments overlap.');
    }
  }
  if (dynamic) {
    const dynamicMappings = loads.filter((item) => dynamic.offset >= item.offset
      && dynamic.offset + dynamic.fileSize <= item.offset + item.fileSize
      && dynamic.virtual >= item.virtual
      && dynamic.virtual + dynamic.memorySize <= item.virtual + item.memorySize
      && dynamic.offset - item.offset === dynamic.virtual - item.virtual);
    if (dynamicMappings.length !== 1) {
      fail(dynamicMappings.length > 1 ? 'ambiguous_elf' : 'unsupported_elf', 'ELF dynamic metadata does not have one exact load mapping.');
    }
  }
  if (!dynamic) return { format: interpreter ? 'dynamic-elf' : 'static-elf', interpreter, needed: [], soname: null };
  const bytes = await readAt(entry.handle, dynamic.offset, dynamic.fileSize);
  const neededOffsets = [];
  let sonameOffset = null;
  let stringAddress = null;
  let stringSize = null;
  for (let offset = 0; offset + 16 <= bytes.length; offset += 16) {
    const tag = Number(bytes.readBigInt64LE(offset));
    const value = Number(bytes.readBigUInt64LE(offset + 8));
    if (tag === 0) break;
    if (tag === 1) neededOffsets.push(value);
    if (tag === 14) {
      if (sonameOffset !== null) fail('ambiguous_elf', 'ELF contains multiple SONAME records.');
      sonameOffset = value;
    }
    if (tag === 5) {
      if (stringAddress !== null) fail('ambiguous_elf', 'ELF contains multiple dynamic string tables.');
      stringAddress = value;
    }
    if (tag === 10) {
      if (stringSize !== null) fail('ambiguous_elf', 'ELF contains multiple dynamic string sizes.');
      stringSize = value;
    }
    if (tag === 15 || tag === 29) fail('unsupported_elf', 'ELF RPATH/RUNPATH is not permitted in the fixed runtime closure.');
  }
  if (neededOffsets.length === 0 && sonameOffset === null) {
    return { format: interpreter ? 'dynamic-elf' : 'elf-object', interpreter, needed: [], soname: null };
  }
  if (!Number.isSafeInteger(stringAddress) || !Number.isSafeInteger(stringSize) || stringSize <= 0 || stringSize > 8 * 1024 * 1024) {
    fail('unsupported_elf', 'ELF dynamic strings are invalid.');
  }
  const matchingSegments = loads.filter((item) => stringAddress >= item.virtual
    && Number.isSafeInteger(stringAddress + stringSize)
    && stringAddress + stringSize <= item.virtual + item.memorySize
    && stringAddress - item.virtual + stringSize <= item.fileSize);
  if (matchingSegments.length !== 1) fail(matchingSegments.length > 1 ? 'ambiguous_elf' : 'unsupported_elf', 'ELF dynamic strings do not have one exact file mapping.');
  const [segment] = matchingSegments;
  const strings = await readAt(entry.handle, segment.offset + stringAddress - segment.virtual, stringSize);
  const stringAt = (offset, field) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= strings.length) fail('unsupported_elf', 'ELF dependency offset is invalid.');
    const end = strings.indexOf(0, offset);
    if (end < 0) fail('unsupported_elf', 'ELF dependency is unterminated.');
    const name = strings.subarray(offset, end).toString('utf8');
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(name) || name.includes('/')) fail('unsafe_dependency', `ELF ${field} name is unsafe.`);
    return name;
  };
  const needed = neededOffsets.map((offset) => stringAt(offset, 'dependency'));
  const soname = sonameOffset === null ? null : stringAt(sonameOffset, 'SONAME');
  return { format: interpreter ? 'dynamic-elf' : 'elf-object', interpreter, needed: [...new Set(needed)], soname };
}

async function resolveLibrary(name, directories) {
  const matches = [];
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try {
      await lstat(candidate);
      const canonical = await realpath(candidate);
      if (!matches.some((match) => match.canonical === canonical)) {
        matches.push({ source: candidate, destination: candidate, canonical });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') fail('unsafe_dependency', 'A dependency could not be inspected safely.');
    }
  }
  if (matches.length > 1) fail('ambiguous_dependency', 'A dependency has multiple distinct fixed candidates.');
  if (matches.length === 1) return Object.freeze({ source: matches[0].source, destination: matches[0].destination });
  fail('unresolved_dependency', 'A required ELF dependency is unavailable.');
}

async function closeEntry(entry) {
  if (entry.pipe) entry.pipeHandle.close();
  else await entry.handle.close();
}

async function closeEntries(entries) {
  await Promise.allSettled(entries.map((entry) => closeEntry(entry)));
}

function normalizeConfig(config) {
  exact(config, ['commands', 'gitHelpers', 'systemFiles', 'libraryDirectories', 'maxEntries'], 'config');
  const commands = { ...REQUIRED_COMMANDS, ...(config.commands ?? {}) };
  const gitHelpers = { ...REQUIRED_HELPERS, ...(config.gitHelpers ?? {}) };
  const systemFiles = { ...HOST_SYSTEM_FILES, ...(config.systemFiles ?? {}) };
  exact(commands, Object.keys(REQUIRED_COMMANDS), 'config.commands');
  exact(gitHelpers, Object.keys(REQUIRED_HELPERS), 'config.gitHelpers');
  exact(systemFiles, Object.keys(HOST_SYSTEM_FILES), 'config.systemFiles');
  const directories = config.libraryDirectories ?? LIBRARY_DIRECTORIES;
  if (!Array.isArray(directories) || directories.length === 0 || directories.length > 16) fail('invalid_configuration', 'libraryDirectories is invalid.');
  const maxEntries = config.maxEntries ?? MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) fail('invalid_configuration', 'maxEntries is invalid.');
  return {
    commands: Object.fromEntries(Object.entries(commands).map(([key, value]) => [key, absolute(value, `commands.${key}`)])),
    gitHelpers: Object.fromEntries(Object.entries(gitHelpers).map(([key, value]) => [key, absolute(value, `gitHelpers.${key}`)])),
    systemFiles: Object.fromEntries(Object.entries(systemFiles).map(([key, value]) => [key, absolute(value, `systemFiles.${key}`)])),
    directories: directories.map((value, index) => absolute(value, `libraryDirectories[${index}]`)),
    maxEntries,
  };
}

function unavailable(error) {
  return Object.freeze({
    ready: false,
    reason: error instanceof GrokOuterRuntimeError ? error.code : 'runtime_probe_failed',
    entry_count: 0,
    manifest_sha256: null,
  });
}

export async function prepareGrokOuterRuntime(config = {}) {
  const entries = [];
  try {
    if (process.platform !== 'linux' || !Number.isInteger(fsConstants.O_NOFOLLOW)) fail('unsupported_platform', 'Linux O_NOFOLLOW is required.');
    const normalized = normalizeConfig(config);
    const byInode = new Map();
    const add = async (source, options) => {
      const entry = await pin(source, options);
      const inodeKey = entry.dedupeKey;
      const prior = byInode.get(inodeKey);
      if (prior) {
        prior.destinations.push(...entry.destinations.filter((item) => !prior.destinations.includes(item)));
        await entry.handle.close();
        return prior;
      }
      if (entries.length >= normalized.maxEntries) {
        await entry.handle.close();
        fail('runtime_too_large', 'The runtime closure exceeds its entry bound.');
      }
      entries.push(entry);
      byInode.set(inodeKey, entry);
      return entry;
    };
    const addPipe = async (definition, name) => {
      const entry = await makeReadPipe(definition.contents, {
        destination: definition.destination,
        label: `synthetic.${name}`,
      });
      entry.dedupeKey = `synthetic:${name}`;
      if (entries.length >= normalized.maxEntries) {
        await closeEntry(entry);
        fail('runtime_too_large', 'The runtime closure exceeds its entry bound.');
      }
      entries.push(entry);
    };

    const executableQueue = [];
    for (const [name, source] of Object.entries(normalized.commands)) {
      executableQueue.push(await add(source, {
        executable: true,
        label: `command.${name}`,
        destinations: [`/usr/bin/${name}`],
      }));
    }
    for (const [name, source] of Object.entries(normalized.gitHelpers)) {
      executableQueue.push(await add(source, {
        executable: true,
        allowAlias: true,
        label: `git-helper.${name}`,
        destinations: [`/usr/lib/git-core/${name}`],
      }));
    }
    for (const [name, source] of Object.entries(normalized.systemFiles)) {
      await add(source, {
        executable: false,
        allowAlias: true,
        label: `system.${name}`,
        destinations: [SYSTEM_DESTINATIONS[name]],
      });
    }
    await addPipe({ destination: '/etc/resolv.conf', contents: await sanitizedResolverContents() }, 'resolver');
    for (const [name, definition] of Object.entries(SYNTHETIC_SYSTEM_FILES)) {
      await addPipe(definition, name);
    }

    const scanned = new Set();
    const sonames = new Map();
    while (executableQueue.length > 0) {
      const entry = executableQueue.shift();
      const inodeKey = entry.dedupeKey;
      if (scanned.has(inodeKey)) continue;
      scanned.add(inodeKey);
      const metadata = await elfMetadata(entry);
      if (metadata.soname) {
        const prior = sonames.get(metadata.soname);
        if (prior && prior !== entry.dedupeKey) fail('ambiguous_dependency', 'One SONAME resolves to distinct runtime inodes.');
        sonames.set(metadata.soname, entry.dedupeKey);
      }
      entry.format = metadata.format;
      entry.version = `${metadata.format}-sha256:${entry.digest.slice(0, 16)}`;
      const dependencies = metadata.interpreter ? [metadata.interpreter, ...metadata.needed] : metadata.needed;
      for (const dependency of dependencies) {
        const resolved = path.isAbsolute(dependency)
          ? Object.freeze({ source: dependency, destination: dependency })
          : await resolveLibrary(dependency, normalized.directories);
        const dependencyEntry = await add(resolved.source, {
          executable: path.isAbsolute(dependency),
          allowAlias: true,
          label: 'elf-dependency',
          destinations: [resolved.destination],
        });
        executableQueue.push(dependencyEntry);
      }
    }

    const records = entries.map((entry) => ({
      digest: entry.digest, size: entry.size, format: entry.format ?? 'data',
      destinations: [...entry.destinations].sort(), version: entry.version ?? null,
    })).sort((left, right) => left.digest.localeCompare(right.digest) || left.size - right.size);
    const manifestDigest = createHash('sha256').update(JSON.stringify(records)).digest('hex');
    const capability = Object.freeze({
      ready: true,
      reason: null,
      entry_count: entries.length,
      manifest_sha256: manifestDigest,
    });
    PRIVATE.set(capability, { entries, manifestDigest, consumed: false, closed: false });
    return capability;
  } catch (error) {
    await closeEntries(entries);
    return unavailable(error);
  }
}

export async function consumeGrokOuterRuntime(capability) {
  const state = PRIVATE.get(capability);
  if (!state || state.closed || state.consumed) fail('invalid_runtime_handle', 'The runtime handle is invalid or already consumed.');
  // Claim synchronously before the first await so two callers cannot both
  // pass validation and receive the same descriptor authority.
  state.consumed = true;
  try {
    for (const entry of state.entries) {
      if (entry.pipe) {
        if (!Number.isInteger(entry.pipeHandle.fd) || entry.pipeHandle.fd !== entry.fd) {
          fail('runtime_changed', 'A synthetic runtime pipe closed before handoff.');
        }
        continue;
      }
      const pinned = await entry.handle.stat({ bigint: true });
      if (!sameIdentity(entry.identity, identity(pinned))) {
        fail('runtime_changed', 'A runtime path changed after attestation.');
      }
      const current = await lstat(entry.canonical, { bigint: true }).catch(() => fail('runtime_changed', 'A runtime path disappeared.'));
      if (!sameIdentity(entry.identity, identity(current))) fail('runtime_changed', 'A runtime path changed after attestation.');
      if (await digestHandle(entry.handle, pinned.size) !== entry.digest) fail('runtime_changed', 'A runtime digest changed after attestation.');
    }
    return Object.freeze({
      manifest_sha256: state.manifestDigest,
      entries: Object.freeze(state.entries.map((entry) => Object.freeze({
        fd: entry.pipe ? entry.fd : entry.handle.fd,
        mount_kind: entry.pipe ? 'file' : 'ro-bind-fd',
        destinations: Object.freeze([...entry.destinations]),
        sha256: entry.digest,
        size: entry.size,
        format: entry.format ?? 'data',
        version: entry.version ?? null,
      }))),
    });
  } catch (error) {
    await closeEntries(state.entries);
    state.closed = true;
    throw error;
  }
}

export async function closeGrokOuterRuntime(capability) {
  const state = PRIVATE.get(capability);
  if (!state || state.closed) return false;
  state.closed = true;
  await closeEntries(state.entries);
  return true;
}

// Parser-only fixture hook: it returns no descriptor, path, or execution
// authority and exists so hostile ELF ambiguity cases remain deterministic.
export async function inspectGrokOuterElfFixtureForTest(source) {
  const canonical = await realpath(absolute(source, 'fixture')).catch(() => fail('missing_runtime', 'ELF fixture is unavailable.'));
  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.size) > MAX_FILE_BYTES) fail('unsafe_runtime', 'ELF fixture is invalid.');
    return Object.freeze(await elfMetadata({ handle, size: Number(stat.size) }));
  } finally {
    await handle?.close().catch(() => {});
  }
}
