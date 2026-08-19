import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { buildGrokArgs, normalizeGrokConfiguration } from './grok-build.mjs';
import {
  normalizeDigest,
  sha256Digest,
  TARGET_SCHEMA_VERSION,
  targetIdentityDigest,
} from './preflight.mjs';

/**
 * Provider-free, fail-closed containment for Grok review/verify jobs.
 *
 * The module intentionally has no connector import and no unwrapped fallback.
 * A provider can be started only from a prepared capability kept in the private
 * WeakMap below.  All host objects are retained as O_NOFOLLOW file descriptors
 * until Bubblewrap has inherited them.
 */

export const GROK_OUTER_SANDBOX_ROLE = 'review-or-verify';
export const GROK_OUTER_SANDBOX_POLICY_VERSION = 2;
export const GROK_OUTER_TARGET_CONTRACT_SCHEMA_VERSION = 'codex-co-engineer.grok-outer-target-contract.v1';
export const GROK_OUTER_JOB_ENV_KEY = 'CODEX_COENGINEER_JOB_ID';
export const GROK_OUTER_SANDBOX_ENV = Object.freeze({
  HOME: '/home/grok',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TMPDIR: '/tmp',
  GROK_CURSOR_MCPS_ENABLED: 'false',
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CODEX_MCPS_ENABLED: 'false',
  GROK_CURSOR_SKILLS_ENABLED: 'false',
  GROK_CLAUDE_SKILLS_ENABLED: 'false',
  GROK_CODEX_SKILLS_ENABLED: 'false',
  GROK_CURSOR_RULES_ENABLED: 'false',
  GROK_CLAUDE_RULES_ENABLED: 'false',
  GROK_CODEX_RULES_ENABLED: 'false',
  GROK_CURSOR_AGENTS_ENABLED: 'false',
  GROK_CLAUDE_AGENTS_ENABLED: 'false',
  GROK_CODEX_AGENTS_ENABLED: 'false',
  GROK_CURSOR_HOOKS_ENABLED: 'false',
  GROK_CLAUDE_HOOKS_ENABLED: 'false',
  GROK_CODEX_HOOKS_ENABLED: 'false',
  GROK_CURSOR_SESSIONS_ENABLED: 'false',
  GROK_CLAUDE_SESSIONS_ENABLED: 'false',
  GROK_CODEX_SESSIONS_ENABLED: 'false',
});
export const GROK_OUTER_SANDBOX_LIMITS = Object.freeze({
  probeTimeoutMs: 3_000,
  probeOutputBytes: 16 * 1024,
  credentialBytes: 256 * 1024,
  nativeEntries: 8_192,
  nativeDepth: 64,
  promptBytes: 96 * 1024,
  ttlMinimumMs: 100,
  ttlMaximumMs: 24 * 60 * 60 * 1_000,
  ttlKillGraceMs: 1_000,
});
export const GROK_OUTER_SPAWN_OPTIONS = Object.freeze({
  detached: true,
  shell: false,
  cwd: '/',
});

const PREPARED = new WeakMap();
const INVOCATIONS = new WeakSet();
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TARGET_HEAD = /^[a-f0-9]{40}$/i;
const TARGET_MODES = new Set(['explicit']);
const TARGET_ROLES = new Set(['review', 'verify']);
const TARGET_ALLOWED_PATH_MAXIMUM = 240;
const GIT_HEAD_OUTPUT_MAXIMUM = 4 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NOFOLLOW = fsConstants.O_NOFOLLOW;
const DIRECTORY = fsConstants.O_DIRECTORY;
const HOSTILE_PROJECT_NAMES = new Set([
  '.grok',
  '.grok.json',
  '.grokrc',
  '.grokrc.json',
  'grok.config.json',
  '.mcp',
  '.mcp.json',
  'mcp.json',
]);
const INVOCATION_CONFIGURATION_FIELDS = Object.freeze([
  'model', 'output_format', 'json_schema', 'verbatim', 'include_partial_messages',
  'session_id', 'resume', 'continue_session', 'reasoning_effort', 'max_turns',
  'sandbox_profile', 'permission_mode', 'rules', 'allowed_tools', 'disallowed_tools',
  'allow_rules', 'deny_rules', 'always_approve', 'no_auto_update', 'no_plan',
  'no_subagents', 'no_memory', 'disable_web_search', 'experimental_memory',
  'fork_session', 'agent', 'delegation',
]);
const SYSTEM_DESTINATIONS = Object.freeze({
  resolver: '/etc/resolv.conf',
  ca: '/etc/ssl/certs/ca-certificates.crt',
  passwd: '/etc/passwd',
  group: '/etc/group',
  services: '/etc/services',
  localtime: '/etc/localtime',
});
const SYSTEM_NAMES = Object.freeze(Object.keys(SYSTEM_DESTINATIONS));
const NATIVE_DEFINITIONS = Object.freeze({
  sessions: Object.freeze({ relative: ['.grok', 'sessions'], writable: true }),
  memory: Object.freeze({ relative: ['.grok', 'memory'], writable: true }),
  bundled: Object.freeze({ relative: ['.grok', 'bundled'], writable: false }),
  agents: Object.freeze({ relative: ['.grok', 'agents'], writable: false }),
  personas: Object.freeze({ relative: ['.grok', 'personas'], writable: false }),
  user_skills: Object.freeze({ relative: ['.grok', 'skills'], writable: false }),
});
const NATIVE_NAMES = Object.freeze(Object.keys(NATIVE_DEFINITIONS));

export class GrokOuterSandboxError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'GrokOuterSandboxError';
    this.code = code;
    if (details !== null) this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new GrokOuterSandboxError(code, message, details);
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('invalid_configuration', `${field} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, allowed, field, required = []) {
  assertPlainObject(value, field);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('unknown_field', `${field}.${key} is not allowed.`);
  }
  for (const key of required) {
    if (!(key in value)) fail('invalid_configuration', `${field}.${key} is required.`);
  }
}

function assertString(value, field, { absolute = false, maximum = 4096 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    fail('invalid_configuration', `${field} must be a non-empty bounded string without NUL bytes.`);
  }
  if (absolute && !path.isAbsolute(value)) fail('invalid_configuration', `${field} must be absolute.`);
  return value;
}

function deepFreezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepFreezeCopy(entry)]),
    ));
  }
  return value;
}

function childFacade(state, stdout, stderr) {
  const child = state.child;
  let facade;
  facade = {
    pid: child.pid,
    stdout,
    stderr,
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    once(event, listener) {
      if (!['exit', 'close', 'error'].includes(event) || typeof listener !== 'function') {
        fail('invalid_child_control', 'Only bounded exit, close, and error observation is exposed.');
      }
      child.once(event, event === 'error'
        ? () => listener(new GrokOuterSandboxError('provider_process_error', 'The provider process failed.'))
        : listener);
      return facade;
    },
    async cancel() {
      state.terminationReason ??= 'cancelled';
      try {
        await terminateChild(state);
      } catch (error) {
        await state.settleCleanupFailure?.(error);
        throw error;
      }
    },
  };
  return Object.freeze(facade);
}

function currentUid() {
  const value = process.getuid?.();
  if (!Number.isInteger(value)) fail('unsupported_platform', 'A POSIX uid is required.');
  return value;
}

function numericMode(entry) {
  return Number(entry.mode) & 0o7777;
}

function isWithin(parent, candidate) {
  const left = path.resolve(parent);
  const right = path.resolve(candidate);
  return right === left || right.startsWith(`${left}${path.sep}`);
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function identity(entry) {
  return Object.freeze({
    dev: String(entry.dev),
    ino: String(entry.ino),
    size: String(entry.size),
    mode: String(entry.mode),
    uid: String(entry.uid),
    gid: String(entry.gid),
    mtimeNs: String(entry.mtimeNs ?? BigInt(Math.trunc(Number(entry.mtimeMs) * 1e6))),
    ctimeNs: String(entry.ctimeNs ?? BigInt(Math.trunc(Number(entry.ctimeMs) * 1e6))),
  });
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function assertLinuxProcfs() {
  if (process.platform !== 'linux' || !Number.isInteger(NOFOLLOW) || !Number.isInteger(DIRECTORY)) {
    fail('unsupported_platform', 'The Grok outer sandbox requires Linux O_NOFOLLOW/O_DIRECTORY and procfs.');
  }
  try {
    const [resolved, procEntry, status, mountInfo] = await Promise.all([
      realpath('/proc'),
      lstat('/proc'),
      readFile('/proc/self/status', 'utf8'),
      readFile('/proc/self/mountinfo', 'utf8'),
    ]);
    if (resolved !== '/proc' || !procEntry.isDirectory() || !/^Name:\s+/m.test(status)
      || !/\s-\sproc\s+proc(?:\s|$)/m.test(mountInfo)) {
      fail('procfs_unavailable', 'Canonical Linux procfs is not available at /proc.');
    }
  } catch (error) {
    if (error instanceof GrokOuterSandboxError) throw error;
    fail('procfs_unavailable', `Linux procfs validation failed: ${error.message}`);
  }
}

async function canonicalDirectory(source, field, { privateMode = false } = {}) {
  assertString(source, field, { absolute: true });
  let entry;
  try {
    entry = await lstat(source, { bigint: true });
  } catch (error) {
    fail('missing_path', `${field} could not be inspected: ${error.message}`);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail('invalid_path', `${field} must be a non-symlink directory.`);
  if (Number(entry.uid) !== currentUid()) fail('untrusted_path', `${field} must be owned by the current uid.`);
  if (privateMode && (numericMode(entry) & 0o077) !== 0) {
    fail('unsafe_permissions', `${field} must be owner-only.`);
  }
  const canonical = await realpath(source).catch((error) => fail('missing_path', `${field}: ${error.message}`));
  if (path.resolve(source) !== canonical) fail('non_canonical_path', `${field} must be its canonical path.`);
  return canonical;
}

async function openPinnedDirectory(source, field, { privateMode = false } = {}) {
  const canonical = await canonicalDirectory(source, field, { privateMode });
  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | NOFOLLOW | DIRECTORY);
    const entry = await handle.stat({ bigint: true });
    if (!entry.isDirectory() || Number(entry.uid) !== currentUid()) fail('untrusted_path', `${field} changed during open.`);
    if (privateMode && (numericMode(entry) & 0o077) !== 0) fail('unsafe_permissions', `${field} changed mode during open.`);
    return { field, source: canonical, handle, identity: identity(entry), directory: true };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof GrokOuterSandboxError) throw error;
    fail('path_open_failed', `${field} could not be pinned: ${error.message}`);
  }
}

async function digestHandle(handle, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = 0;
  const maximum = Number(size);
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail('invalid_source', 'Source size is not safely representable.');
  while (position < maximum) {
    const length = Math.min(buffer.length, maximum - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) fail('source_changed', 'Pinned source ended before its recorded size.');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

async function readHead(handle, length = 4096) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, 0);
  return buffer.subarray(0, bytesRead);
}

async function elfInformation(handle) {
  const head = await readHead(handle, 64);
  if (head.length < 64 || !head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return { elf: false, interpreter: null };
  }
  if (head[4] !== 2 || head[5] !== 1) fail('unsupported_executable', 'Only little-endian ELF64 executables are supported.');
  const phoff = Number(head.readBigUInt64LE(32));
  const phentsize = head.readUInt16LE(54);
  const phnum = head.readUInt16LE(56);
  if (!Number.isSafeInteger(phoff) || phentsize < 56 || phnum > 4096) fail('unsupported_executable', 'Invalid ELF program headers.');
  const table = Buffer.alloc(phentsize * phnum);
  const { bytesRead } = await handle.read(table, 0, table.length, phoff);
  if (bytesRead !== table.length) fail('unsupported_executable', 'Truncated ELF program headers.');
  for (let index = 0; index < phnum; index += 1) {
    const base = index * phentsize;
    if (table.readUInt32LE(base) === 3) {
      const offset = Number(table.readBigUInt64LE(base + 8));
      const length = Number(table.readBigUInt64LE(base + 32));
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 2 || length > 4096) {
        fail('unsupported_executable', 'Invalid ELF interpreter record.');
      }
      const bytes = Buffer.alloc(length);
      const read = await handle.read(bytes, 0, length, offset);
      if (read.bytesRead !== length) fail('unsupported_executable', 'Truncated ELF interpreter record.');
      const terminator = bytes.indexOf(0);
      const interpreter = bytes.subarray(0, terminator >= 0 ? terminator : bytes.length).toString('utf8');
      if (!path.isAbsolute(interpreter) || interpreter.includes('\0')) {
        fail('unsupported_executable', 'ELF interpreter must be an absolute path.');
      }
      return { elf: true, interpreter };
    }
  }
  return { elf: true, interpreter: null };
}

async function inspectFormat(handle, expectedFormat, field) {
  const head = await readHead(handle);
  const elf = await elfInformation(handle);
  if (expectedFormat === 'static-elf') {
    if (!elf.elf || elf.interpreter) fail('unsupported_executable', `${field} must be a static ELF64 executable.`);
    return { format: expectedFormat, interpreter: null };
  }
  if (expectedFormat === 'dynamic-elf') {
    if (!elf.elf || !elf.interpreter) fail('unsupported_executable', `${field} must be a dynamic ELF64 executable.`);
    return { format: expectedFormat, interpreter: elf.interpreter };
  }
  if (expectedFormat === 'elf-object') {
    if (!elf.elf) fail('unsupported_executable', `${field} must be an ELF64 object.`);
    return { format: expectedFormat, interpreter: elf.interpreter };
  }
  if (expectedFormat === 'script') {
    if (elf.elf || head[0] !== 0x23 || head[1] !== 0x21) {
      fail('unsupported_executable', `${field} must be a shebang script.`);
    }
    const firstLine = head.toString('utf8').split(/\r?\n/, 1)[0].slice(2).trim();
    const [scriptInterpreter] = firstLine.split(/\s+/);
    if (!path.isAbsolute(scriptInterpreter)) fail('unsupported_executable', `${field} has a non-absolute interpreter.`);
    return { format: expectedFormat, interpreter: scriptInterpreter };
  }
  fail('unsupported_executable', `${field} has an unsupported format.`);
}

async function openPinnedFile(descriptor, field, {
  owner = 'current', executable = false, allowedFormats = ['static-elf', 'script', 'data'],
} = {}) {
  assertExactKeys(descriptor, ['source', 'sha256', 'version', 'format', 'destination'], field, ['source', 'sha256', 'format']);
  const source = assertString(descriptor.source, `${field}.source`, { absolute: true });
  if (!SHA256.test(descriptor.sha256)) fail('invalid_configuration', `${field}.sha256 must be a lowercase SHA-256 digest.`);
  if (!allowedFormats.includes(descriptor.format)) fail('invalid_configuration', `${field}.format is not supported.`);
  let before;
  try {
    before = await lstat(source, { bigint: true });
  } catch (error) {
    fail('missing_source', `${field}.source could not be inspected: ${error.message}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) fail('invalid_source', `${field}.source must be a non-symlink regular file.`);
  const ownerUid = Number(before.uid);
  // Resolver files may legitimately belong to a dedicated system service
  // account, and root-owned files can appear as the overflow uid in an outer
  // user namespace.  Non-provider closure inputs therefore accept a foreign
  // owner only when the inode is not group/world writable and its exact digest
  // is pinned.  Bwrap and the provider remain exact-current-uid requirements.
  const trustedReadOnlyOwner = ownerUid === currentUid() || (numericMode(before) & 0o022) === 0;
  if (owner === 'current' ? ownerUid !== currentUid() : !trustedReadOnlyOwner) {
    fail('untrusted_source', `${field}.source has an untrusted owner.`, {
      owner: ownerUid, current_uid: currentUid(), mode: numericMode(before), owner_policy: owner,
    });
  }
  if (executable && (numericMode(before) & 0o111) === 0) fail('non_executable', `${field}.source must be executable.`);
  const canonical = await realpath(source).catch((error) => fail('missing_source', `${field}.source: ${error.message}`));
  if (path.resolve(source) !== canonical) fail('non_canonical_path', `${field}.source must be its canonical path.`);

  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | NOFOLLOW);
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile() || !sameIdentity(identity(before), identity(entry))) {
      fail('source_changed', `${field}.source changed while being pinned.`);
    }
    const actualDigest = await digestHandle(handle, entry.size);
    if (actualDigest !== descriptor.sha256) fail('digest_mismatch', `${field}.source does not match its expected digest.`);
    let formatInfo;
    if (descriptor.format === 'data') {
      if (executable) fail('invalid_configuration', `${field} executable cannot have data format.`);
      formatInfo = { format: 'data', interpreter: null };
    } else {
      formatInfo = await inspectFormat(handle, descriptor.format, field);
    }
    return {
      field,
      source: canonical,
      handle,
      identity: identity(entry),
      sha256: actualDigest,
      version: descriptor.version ?? null,
      format: descriptor.format,
      interpreter: formatInfo.interpreter,
      executable,
      destination: descriptor.destination ?? null,
      directory: false,
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof GrokOuterSandboxError) throw error;
    fail('source_open_failed', `${field}.source could not be pinned: ${error.message}`);
  }
}

async function revalidatePinned(record, { digest = !record.directory } = {}) {
  let current;
  let sourceEntry;
  try {
    [current, sourceEntry] = await Promise.all([
      record.handle.stat({ bigint: true }),
      lstat(record.source, { bigint: true }),
    ]);
  } catch (error) {
    fail('source_changed', `${record.field} could not be revalidated: ${error.message}`);
  }
  const currentIdentity = identity(current);
  if (sourceEntry.isSymbolicLink() || !sameIdentity(record.identity, currentIdentity)
    || !sameIdentity(record.identity, identity(sourceEntry))) {
    fail('source_changed', `${record.field} identity changed after preparation.`);
  }
  if (digest) {
    const currentDigest = await digestHandle(record.handle, current.size);
    if (currentDigest !== record.sha256) fail('source_changed', `${record.field} content changed after preparation.`);
  }
}

function cleanProbeOutput(result, field) {
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
  if (result.error || result.signal || result.status !== 0) {
    fail('executable_probe_failed', `${field} bounded probe failed.`, {
      status: result.status,
      signal: result.signal,
      error: result.error?.code ?? null,
      output: `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`
        .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1024),
    });
  }
  if (stdout.length > GROK_OUTER_SANDBOX_LIMITS.probeOutputBytes
    || stderr.length > GROK_OUTER_SANDBOX_LIMITS.probeOutputBytes) {
    fail('probe_output_limit', `${field} probe exceeded its output limit.`);
  }
  return `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function probePinnedBwrap(record) {
  if (typeof record.version !== 'string' || record.version.length === 0) {
    fail('invalid_configuration', 'bwrap.version is required.');
  }
  await revalidatePinned(record);
  const result = spawnSync('/proc/self/fd/3', ['--version'], {
    cwd: '/',
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    shell: false,
    timeout: GROK_OUTER_SANDBOX_LIMITS.probeTimeoutMs,
    maxBuffer: GROK_OUTER_SANDBOX_LIMITS.probeOutputBytes + 1,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe', record.handle.fd],
  });
  const output = cleanProbeOutput(result, 'bwrap');
  if (output !== record.version) fail('version_mismatch', 'bwrap version output did not match expected provenance.');
  return output;
}

function assertSafeDestination(destination, field, { executable = false } = {}) {
  assertString(destination, field, { absolute: true });
  if (destination !== path.posix.normalize(destination)) fail('invalid_destination', `${field} must be normalized.`);
  const forbidden = ['/home', '/root', '/run', '/proc', '/dev', '/tmp', '/var/tmp', '/workspace', '/sys', '/mnt'];
  if (forbidden.some((prefix) => destination === prefix || destination.startsWith(`${prefix}/`))) {
    fail('invalid_destination', `${field} overlaps a protected sandbox path.`);
  }
  if (destination === '/opt/grok/bin/grok') fail('invalid_destination', `${field} collides with the provider.`);
  if (executable && !isWithin('/opt/tools', destination) && !isWithin('/usr/bin', destination)) {
    fail('invalid_destination', `${field} executable must live under /opt/tools or /usr/bin.`);
  }
  return destination;
}

function directoryParents(destination, includeSelf) {
  const result = [];
  let current = includeSelf ? destination : path.posix.dirname(destination);
  while (current !== '/') {
    result.push(current);
    current = path.posix.dirname(current);
  }
  return result;
}

function mountArguments({ resources, environment, chdir, providerArgs, providerProbe = false }) {
  const bwrap = resources[0];
  const childFds = new Map(resources.map((record, index) => [record, index + 3]));
  const mounts = resources.slice(1);
  const directories = new Set(['/proc', '/dev', '/tmp', '/var', '/var/tmp', '/run', '/home', '/home/grok']);
  for (const mount of mounts) {
    for (const parent of directoryParents(mount.destination, mount.directory)) directories.add(parent);
  }
  const args = [
    '--die-with-parent',
    '--unshare-all',
    // Codex's bwrap requires this explicit spelling before --disable-userns,
    // even though --unshare-all semantically includes the user namespace.
    '--unshare-user',
    '--share-net',
    '--disable-userns',
    '--assert-userns-disabled',
    '--clearenv',
    '--tmpfs', '/',
  ];
  for (const directory of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    args.push('--dir', directory);
  }
  args.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/var/tmp',
    '--tmpfs', '/run',
  );
  if (providerProbe) args.push('--tmpfs', '/home/grok');
  for (const mount of mounts) {
    args.push(mount.writable ? '--bind-fd' : '--ro-bind-fd', String(childFds.get(mount)), mount.destination);
  }
  // The synthetic root itself must not remain a catch-all writable tmpfs.
  // Child mounts (/tmp, /run, the private home) retain their explicit modes.
  args.push('--remount-ro', '/');
  for (const [key, value] of Object.entries(environment)) args.push('--setenv', key, value);
  args.push('--chdir', chdir, '--', '/opt/grok/bin/grok', ...providerArgs);
  return {
    command: `/proc/self/fd/${childFds.get(bwrap)}`,
    argv: args,
    stdio: ['ignore', 'pipe', 'pipe', ...resources.map((record) => record.handle.fd)],
  };
}

function providerPathEnvironment(runtimeClosure) {
  const paths = new Set(['/opt/grok/bin']);
  for (const item of runtimeClosure) {
    if (item.executable) paths.add(path.posix.dirname(item.destination));
  }
  return [...paths].sort().join(':');
}

async function probePinnedProvider({ bwrap, provider, systemFiles, runtimeClosure }) {
  if (typeof provider.version !== 'string' || provider.version.length === 0) {
    fail('invalid_configuration', 'provider.version is required.');
  }
  for (const record of [bwrap, provider, ...systemFiles, ...runtimeClosure]) await revalidatePinned(record);
  const resources = [
    bwrap,
    Object.assign(provider, { destination: '/opt/grok/bin/grok', writable: false }),
    ...systemFiles.map((record) => Object.assign(record, { writable: false })),
    ...runtimeClosure.map((record) => Object.assign(record, { writable: false })),
  ];
  const plan = mountArguments({
    resources,
    environment: { ...GROK_OUTER_SANDBOX_ENV, PATH: providerPathEnvironment(runtimeClosure), PWD: '/' },
    chdir: '/',
    providerArgs: ['--version'],
    providerProbe: true,
  });
  const result = spawnSync(plan.command, plan.argv, {
    cwd: '/',
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    shell: false,
    timeout: GROK_OUTER_SANDBOX_LIMITS.probeTimeoutMs,
    maxBuffer: GROK_OUTER_SANDBOX_LIMITS.probeOutputBytes + 1,
    encoding: null,
    stdio: plan.stdio,
  });
  const output = cleanProbeOutput(result, 'provider');
  if (output !== provider.version) fail('version_mismatch', 'Provider version output did not match expected provenance.');
  return output;
}

async function assertNoHostileProjectConfig(root, workingDirectory) {
  const relative = path.relative(root, workingDirectory);
  const segments = relative === '' ? [] : relative.split(path.sep);
  const ancestors = [root];
  for (let index = 1; index <= segments.length; index += 1) {
    ancestors.push(path.join(root, ...segments.slice(0, index)));
  }
  for (const directory of ancestors) {
    for (const name of HOSTILE_PROJECT_NAMES) {
      try {
        await lstat(path.join(directory, name));
        fail('hostile_project_config', `Project-local provider/config/hook path is forbidden: ${path.join(directory, name)}`);
      } catch (error) {
        if (error instanceof GrokOuterSandboxError) throw error;
        if (error.code !== 'ENOENT') fail('project_config_check_failed', `Could not inspect project config: ${error.message}`);
      }
    }
  }
}

async function validateNativeTree(root, name) {
  const queue = [{ directory: root, depth: 0 }];
  let entries = 0;
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    if (depth > GROK_OUTER_SANDBOX_LIMITS.nativeDepth) fail('native_mount_limit', `${name} exceeds the native tree depth limit.`);
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > GROK_OUTER_SANDBOX_LIMITS.nativeEntries) fail('native_mount_limit', `${name} exceeds the native entry limit.`);
      const childPath = path.join(directory, child.name);
      const entry = await lstat(childPath, { bigint: true });
      // The native root itself is owner-only.  Grok may create 0664 session
      // files under the caller's umask; those remain unreachable to other
      // users through the 0700 root.  Ownership, link type, and hard links are
      // the security-sensitive properties for descendants.
      if (entry.isSymbolicLink() || Number(entry.uid) !== currentUid()) {
        fail('invalid_native_mount', `${name} contains a symlink or foreign-owned entry.`, {
          path: childPath, owner: Number(entry.uid), current_uid: currentUid(), mode: numericMode(entry),
        });
      }
      if (entry.isDirectory()) queue.push({ directory: childPath, depth: depth + 1 });
      else if (!entry.isFile() || Number(entry.nlink) !== 1) {
        fail('invalid_native_mount', `${name} contains a special or multiply-linked file.`);
      }
    }
  }
}

async function copyCredential(source, destination, name) {
  let sourceHandle;
  let destinationHandle;
  try {
    const entry = await lstat(source, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isFile() || Number(entry.uid) !== currentUid()
      || (numericMode(entry) & 0o077) !== 0 || Number(entry.nlink) !== 1
      || Number(entry.size) > GROK_OUTER_SANDBOX_LIMITS.credentialBytes) {
      fail('unsafe_credential', `${name} must be a small, owner-only, singly-linked regular file.`);
    }
    sourceHandle = await open(source, fsConstants.O_RDONLY | NOFOLLOW);
    const pinned = await sourceHandle.stat({ bigint: true });
    if (!sameIdentity(identity(entry), identity(pinned))) fail('source_changed', `${name} changed during open.`);
    const bytes = Buffer.alloc(Number(pinned.size));
    const { bytesRead } = await sourceHandle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) fail('source_changed', `${name} was truncated during copy.`);
    const afterRead = await sourceHandle.stat({ bigint: true });
    if (!sameIdentity(identity(pinned), identity(afterRead))) fail('source_changed', `${name} changed during copy.`);
    destinationHandle = await open(destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    await destinationHandle.writeFile(bytes);
    await destinationHandle.sync();
    await chmod(destination, 0o600);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error instanceof GrokOuterSandboxError) throw error;
    fail('credential_copy_failed', `${name} could not be copied safely: ${error.message}`);
  } finally {
    await sourceHandle?.close().catch(() => {});
    await destinationHandle?.close().catch(() => {});
  }
  return true;
}

async function assertPrivateHomeShape(privateHome, enabledNativeNames) {
  const homeEntries = await readdir(privateHome);
  if (homeEntries.length !== 1 || homeEntries[0] !== '.grok') {
    fail('private_home_tampered', 'Private provider home contains an unexpected startup path.');
  }
  const grokRoot = path.join(privateHome, '.grok');
  const grokEntry = await lstat(grokRoot, { bigint: true });
  if (grokEntry.isSymbolicLink() || !grokEntry.isDirectory() || Number(grokEntry.uid) !== currentUid()
    || (numericMode(grokEntry) & 0o077) !== 0) {
    fail('private_home_tampered', 'Private .grok root lost its owner-only directory identity.');
  }
  const allowed = new Set(['auth.json', 'agent_id']);
  for (const name of enabledNativeNames) allowed.add(NATIVE_DEFINITIONS[name].relative[1]);
  for (const name of await readdir(grokRoot)) {
    if (!allowed.has(name)) fail('private_home_tampered', `Unexpected private .grok startup path: ${name}`);
    const entryPath = path.join(grokRoot, name);
    const entry = await lstat(entryPath, { bigint: true });
    if (entry.isSymbolicLink() || Number(entry.uid) !== currentUid()) {
      fail('private_home_tampered', `${name} lost its pinned private-home identity.`);
    }
    if (['auth.json', 'agent_id'].includes(name)) {
      if (!entry.isFile() || Number(entry.nlink) !== 1 || (numericMode(entry) & 0o077) !== 0) {
        fail('private_home_tampered', `${name} is no longer an owner-only regular credential file.`);
      }
    } else if (!entry.isDirectory() || (await readdir(entryPath)).length !== 0) {
      fail('private_home_tampered', `${name} private mountpoint must remain an empty directory before launch.`);
    }
  }
}

async function closeRecords(records) {
  await Promise.allSettled([...new Set(records)].map((record) => record?.handle?.close()));
}

function childIsRunning(child) {
  return Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
}

function observeChildExit(state, timeoutMs = null) {
  const child = state.child;
  if (!child) return Promise.resolve(true);
  if (!state.exitObservation) {
    state.exitObservation = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      child.once('exit', finish);
      child.once('error', finish);
      if (!childIsRunning(child)) finish();
    });
  }
  if (timeoutMs === null) return state.exitObservation;
  return Promise.race([
    state.exitObservation,
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function processGroupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function childGroupNeedsTermination(child) {
  return Boolean(child?.pid && (childIsRunning(child) || processGroupExists(child.pid)));
}

function waitForProcessGroupExit(pid, timeoutMs) {
  if (!processGroupExists(pid)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (!processGroupExists(pid) || Date.now() - started >= timeoutMs) {
        resolve(!processGroupExists(pid));
        return;
      }
      setTimeout(poll, Math.min(25, timeoutMs));
    };
    poll();
  });
}

async function terminateChildNow(state) {
  const child = state.child;
  if (!child?.pid) {
    await observeChildExit(state);
    return;
  }
  const groupExists = processGroupExists(child.pid);
  if (!childIsRunning(child) && !groupExists) {
    await observeChildExit(state);
    return;
  }
  const signalOwnedTree = (signal) => {
    let unexpected = null;
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error?.code !== 'ESRCH') unexpected = error;
    }
    try { child.kill(signal); } catch (error) {
      if (error?.code !== 'ESRCH' && unexpected === null) unexpected = error;
    }
    if (unexpected) throw unexpected;
  };
  signalOwnedTree('SIGTERM');
  const groupExitedAfterTerm = await waitForProcessGroupExit(
    child.pid, GROK_OUTER_SANDBOX_LIMITS.ttlKillGraceMs,
  );
  if (!groupExitedAfterTerm || childIsRunning(child)) {
    signalOwnedTree('SIGKILL');
  }
  let [childExited, groupExited] = await Promise.all([
    observeChildExit(state, GROK_OUTER_SANDBOX_LIMITS.ttlKillGraceMs),
    waitForProcessGroupExit(child.pid, GROK_OUTER_SANDBOX_LIMITS.ttlKillGraceMs),
  ]);
  if (!childExited || !groupExited || childIsRunning(child)) {
    signalOwnedTree('SIGKILL');
    [childExited, groupExited] = await Promise.all([
      observeChildExit(state, GROK_OUTER_SANDBOX_LIMITS.ttlKillGraceMs),
      waitForProcessGroupExit(child.pid, GROK_OUTER_SANDBOX_LIMITS.ttlKillGraceMs),
    ]);
  }
  if (!childExited || !groupExited || childIsRunning(child)) {
    fail('sandbox_cleanup_failed', 'The owned Grok sandbox process tree did not drain after SIGKILL.');
  }
}

function terminateChild(state) {
  if (!state.terminationPromise) state.terminationPromise = terminateChildNow(state);
  return state.terminationPromise;
}

async function removePrivateHome(privateHome) {
  if (privateHome) await rm(privateHome, { recursive: true, force: true });
}

function normalizeTargetAllowedPath(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > TARGET_ALLOWED_PATH_MAXIMUM
    || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    fail('invalid_target', `${field} must contain short, relative paths.`);
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    fail('invalid_target', `${field} cannot escape the expected Git root.`);
  }
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '');
}

function validateTargetIdentity(value, expected, field) {
  assertExactKeys(value, ['device', 'inode'], field, ['device', 'inode']);
  if (typeof value.device !== 'string' || typeof value.inode !== 'string'
    || value.device !== expected.device || value.inode !== expected.inode) {
    fail('target_identity_mismatch', `${field} does not match the canonical target directory identity.`);
  }
  return Object.freeze({ device: expected.device, inode: expected.inode });
}

async function targetDirectoryIdentity(source, field) {
  try {
    const entry = await lstat(source, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('invalid_target', `${field} must resolve to a directory.`);
    }
    return Object.freeze({ device: String(entry.dev), inode: String(entry.ino) });
  } catch (error) {
    if (error instanceof GrokOuterSandboxError) throw error;
    fail('target_identity_failed', `Could not inspect ${field}: ${error.message}`);
  }
}

function observeGitHead(workingDirectory) {
  const result = spawnSync('git', [
    '-C', workingDirectory,
    'rev-parse', '--verify', 'HEAD',
  ], {
    cwd: '/',
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    },
    shell: false,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: GIT_HEAD_OUTPUT_MAXIMUM,
  });
  if (result.signal || result.status !== 0 || (result.error && result.status === null)) {
    fail('target_head_unavailable', 'The canonical target Git HEAD could not be independently observed.', {
      status: result.status,
      signal: result.signal,
      error: result.error?.code ?? null,
    });
  }
  const observedHead = result.stdout.trim();
  if (!TARGET_HEAD.test(observedHead)) {
    fail('target_head_unavailable', 'The canonical target Git HEAD was not a full 40-character revision.');
  }
  return observedHead.toLowerCase();
}

function targetContractDigest({ mode, expectedHead, allowedPaths, role, targetFingerprint }) {
  return sha256Digest({
    schema_version: GROK_OUTER_TARGET_CONTRACT_SCHEMA_VERSION,
    target_schema_version: TARGET_SCHEMA_VERSION,
    mode,
    expected_head: expectedHead,
    allowed_paths: allowedPaths,
    role,
    target_fingerprint: targetFingerprint,
  });
}

function validateTargetInput(target) {
  assertExactKeys(target, [
    'schema_version', 'mode', 'working_directory', 'expected_git_root', 'git_common_directory',
    'expected_head', 'allowed_paths', 'role', 'target_fingerprint',
    'resolved_workspace', 'resolved_cwd', 'observed_head', 'workspace_identity', 'cwd_identity',
    'isolation', 'target_origin',
  ], 'target', [
    'working_directory', 'expected_git_root', 'git_common_directory',
    'expected_head', 'allowed_paths', 'role', 'target_fingerprint',
  ]);
  if (target.schema_version !== undefined && target.schema_version !== TARGET_SCHEMA_VERSION) {
    fail('invalid_target', `target.schema_version must be ${TARGET_SCHEMA_VERSION}.`);
  }
  if (target.mode !== undefined && !TARGET_MODES.has(target.mode)) {
    fail('invalid_target', 'target.mode must be explicit for the Grok outer sandbox.');
  }
  if (typeof target.expected_head !== 'string' || !TARGET_HEAD.test(target.expected_head)) {
    fail('invalid_target', 'target.expected_head must be a full 40-character Git revision.');
  }
  if (!Array.isArray(target.allowed_paths) || target.allowed_paths.length < 1 || target.allowed_paths.length > 200) {
    fail('invalid_target', 'target.allowed_paths must contain 1 to 200 relative paths.');
  }
  const allowedPaths = target.allowed_paths.map((value, index) =>
    normalizeTargetAllowedPath(value, `target.allowed_paths[${index}]`));
  if (new Set(allowedPaths).size !== allowedPaths.length) {
    fail('invalid_target', 'target.allowed_paths must not contain duplicates.');
  }
  if (allowedPaths.length !== 1 || allowedPaths[0] !== '.') {
    fail('unsupported_allowed_paths',
      'The Grok outer sandbox currently accepts only allowed_paths=["."]; selective visibility is not yet implemented.');
  }
  if (typeof target.role !== 'string' || !TARGET_ROLES.has(target.role)) {
    fail('unsupported_role', 'target.role must be review or verify for the Grok outer sandbox.');
  }
  const targetFingerprint = normalizeDigest(target.target_fingerprint);
  if (!targetFingerprint) {
    fail('invalid_target_fingerprint', 'target.target_fingerprint must be a SHA-256 digest.');
  }
  return {
    mode: target.mode ?? 'explicit',
    expectedHead: target.expected_head.toLowerCase(),
    allowedPaths,
    role: target.role,
    targetFingerprint,
  };
}

async function prepareTarget(target) {
  const validated = validateTargetInput(target);
  const root = await canonicalDirectory(target.expected_git_root, 'target.expected_git_root');
  const working = await canonicalDirectory(target.working_directory, 'target.working_directory');
  const common = await canonicalDirectory(target.git_common_directory, 'target.git_common_directory');
  if (!isWithin(root, working)) fail('target_mismatch', 'working_directory must be inside expected_git_root.');
  if (!isWithin(root, common)) {
    fail('unsupported_git_layout', 'git_common_directory outside expected_git_root is not supported by this minimal-root policy.');
  }
  const workspaceIdentity = await targetDirectoryIdentity(root, 'target.expected_git_root');
  const cwdIdentity = await targetDirectoryIdentity(working, 'target.working_directory');
  const observedHead = observeGitHead(working);
  if (observedHead !== validated.expectedHead) {
    fail('target_head_mismatch', 'target.expected_head does not match the independently observed Git HEAD.', {
      expected: validated.expectedHead,
      observed: observedHead,
    });
  }
  const expectedFingerprint = targetIdentityDigest({
    mode: validated.mode,
    resolved_workspace: root,
    resolved_cwd: working,
    git_common_directory: common,
    git_head: observedHead,
    allowed_paths: validated.allowedPaths,
    role: validated.role,
    workspace_identity: workspaceIdentity,
    cwd_identity: cwdIdentity,
  });
  if (validated.targetFingerprint !== expectedFingerprint) {
    fail('target_fingerprint_mismatch', 'target.target_fingerprint does not match the canonical target identity.', {
      expected: expectedFingerprint,
      received: validated.targetFingerprint,
    });
  }
  if (target.resolved_workspace !== undefined && target.resolved_workspace !== root) {
    fail('target_identity_mismatch', 'target.resolved_workspace does not match expected_git_root.');
  }
  if (target.resolved_cwd !== undefined && target.resolved_cwd !== working) {
    fail('target_identity_mismatch', 'target.resolved_cwd does not match working_directory.');
  }
  if (target.observed_head !== undefined
    && (typeof target.observed_head !== 'string' || target.observed_head.toLowerCase() !== observedHead)) {
    fail('target_head_mismatch', 'target.observed_head does not match expected_head.');
  }
  if (target.workspace_identity !== undefined) {
    validateTargetIdentity(target.workspace_identity, workspaceIdentity, 'target.workspace_identity');
  }
  if (target.cwd_identity !== undefined) {
    validateTargetIdentity(target.cwd_identity, cwdIdentity, 'target.cwd_identity');
  }
  if (target.isolation !== undefined && target.isolation !== 'read-only-process-contract') {
    fail('invalid_target', 'target.isolation must be read-only-process-contract.');
  }
  const relativeWorking = path.relative(root, working).split(path.sep).join('/');
  const relativeCommon = path.relative(root, common).split(path.sep).join('/');
  const contractDigest = targetContractDigest({
    mode: validated.mode,
    expectedHead: observedHead,
    allowedPaths: validated.allowedPaths,
    role: validated.role,
    targetFingerprint: expectedFingerprint,
  });
  return {
    schema_version: TARGET_SCHEMA_VERSION,
    mode: validated.mode,
    working_directory: working,
    expected_git_root: root,
    resolved_workspace: root,
    resolved_cwd: working,
    git_common_directory: common,
    expected_head: observedHead,
    observed_head: observedHead,
    allowed_paths: Object.freeze([...validated.allowedPaths]),
    role: validated.role,
    target_fingerprint: expectedFingerprint,
    target_contract_digest: contractDigest,
    workspace_identity: workspaceIdentity,
    cwd_identity: cwdIdentity,
    isolation: 'read-only-process-contract',
    sandbox_working_directory: relativeWorking ? `/workspace/${relativeWorking}` : '/workspace',
    sandbox_git_common_directory: relativeCommon ? `/workspace/${relativeCommon}` : '/workspace',
  };
}

function assertNoWritableOverlap(target, writableSources) {
  const targetPaths = [target.working_directory, target.expected_git_root, target.git_common_directory];
  for (const targetPath of targetPaths) {
    for (const writable of writableSources) {
      if (pathsOverlap(targetPath, writable.path)) {
        fail('target_writable_overlap', `${targetPath} overlaps writable mount ${writable.name} in one direction.`);
      }
    }
  }
}

function validateTtl(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs < GROK_OUTER_SANDBOX_LIMITS.ttlMinimumMs
    || ttlMs > GROK_OUTER_SANDBOX_LIMITS.ttlMaximumMs) {
    fail('invalid_configuration', 'ttlMs must be an integer within the bounded cleanup interval.');
  }
  return ttlMs;
}

/** Create the only accepted, adapter-shaped provider invocation. */
export function createGrokReviewInvocation(input) {
  assertExactKeys(input, ['operation', 'prompt', ...INVOCATION_CONFIGURATION_FIELDS],
    'invocation', ['operation', 'prompt']);
  if (!['review', 'verify'].includes(input.operation)) fail('invalid_invocation', 'operation must be review or verify.');
  const prompt = assertString(input.prompt, 'invocation.prompt', { maximum: GROK_OUTER_SANDBOX_LIMITS.promptBytes });
  if (Buffer.byteLength(prompt) > GROK_OUTER_SANDBOX_LIMITS.promptBytes) fail('invalid_invocation', 'prompt exceeds its byte limit.');
  const requested = Object.fromEntries(INVOCATION_CONFIGURATION_FIELDS
    .filter((field) => Object.hasOwn(input, field))
    .map((field) => [field, input[field]]));
  if (requested.model !== undefined
    && (typeof requested.model !== 'string' || !SAFE_TOKEN.test(requested.model) || requested.model.includes('*'))) {
    fail('invalid_invocation', 'model must be a safe non-wildcard token.');
  }
  let normalized;
  try {
    normalized = normalizeGrokConfiguration({
      ...requested,
      no_auto_update: true,
      sandbox_profile: 'read-only',
      permission_mode: 'auto',
    }, input.operation);
  } catch (error) {
    fail('invalid_invocation', error.message);
  }
  const invocation = deepFreezeCopy({
    operation: input.operation,
    prompt,
    configuration: normalized,
    contract: {
      requested: Object.keys(requested).sort(),
      supported: [...INVOCATION_CONFIGURATION_FIELDS],
      effective: {
        output_format: normalized.output_format,
        model: normalized.model,
        reasoning_effort: normalized.reasoning_effort,
        session: Boolean(normalized.session_id || normalized.resume || normalized.continue_session),
        fork_session: normalized.fork_session,
        agent: normalized.agent ?? null,
        delegation: normalized.no_subagents ? 'disabled' : 'enabled',
        memory: normalized.no_memory ? 'disabled' : normalized.experimental_memory ? 'experimental' : 'default',
      },
      forced: {
        no_auto_update: true,
        sandbox_profile: 'read-only',
        permission_mode: 'auto',
        denied_tools: ['MCPTool'],
      },
    },
  });
  INVOCATIONS.add(invocation);
  return invocation;
}

function invocationArgs(invocation, sandboxCwd) {
  if (!INVOCATIONS.has(invocation)) fail('invalid_invocation', 'Only createGrokReviewInvocation output is accepted.');
  return buildGrokArgs({
    prompt: invocation.prompt,
    cwd: sandboxCwd,
    configuration: invocation.configuration,
  });
}

export async function prepareGrokOuterSandbox(options) {
  assertExactKeys(options, [
    'bwrap', 'provider', 'runtimeClosure', 'systemFiles', 'target', 'jobsRoot',
    'hostHome', 'nativeState', 'xaiApiKey', 'jobId', 'ttlMs',
  ], 'options', ['bwrap', 'provider', 'runtimeClosure', 'systemFiles', 'target', 'jobsRoot', 'hostHome', 'jobId', 'ttlMs']);
  if (options.xaiApiKey !== undefined) {
    fail('unsupported_credential_projection',
      'xaiApiKey projection is disabled; use the private owner-only Grok auth file.');
  }
  await assertLinuxProcfs();
  const target = await prepareTarget(options.target);
  const jobsRoot = await canonicalDirectory(options.jobsRoot, 'jobsRoot', { privateMode: true });
  const hostHome = await canonicalDirectory(options.hostHome, 'hostHome');
  let hostGrokRoot = null;
  try {
    hostGrokRoot = await canonicalDirectory(path.join(hostHome, '.grok'), 'hostHome/.grok', { privateMode: true });
  } catch (error) {
    if (!(error instanceof GrokOuterSandboxError) || error.code !== 'missing_path') throw error;
  }
  if (!SAFE_JOB_ID.test(options.jobId)) fail('invalid_configuration', 'jobId is not a safe bounded path component.');
  const ttlMs = validateTtl(options.ttlMs);
  assertExactKeys(options.bwrap, ['source', 'sha256', 'version', 'format'], 'bwrap',
    ['source', 'sha256', 'version', 'format']);
  assertExactKeys(options.provider, ['source', 'sha256', 'version', 'format'], 'provider',
    ['source', 'sha256', 'version', 'format']);
  const nativeState = options.nativeState ?? {};
  assertExactKeys(nativeState, NATIVE_NAMES, 'nativeState');
  for (const value of Object.values(nativeState)) {
    if (typeof value !== 'boolean') fail('invalid_configuration', 'nativeState values must be boolean.');
  }
  await assertNoHostileProjectConfig(target.expected_git_root, target.working_directory);

  const privateHome = path.join(jobsRoot, options.jobId, 'home');
  const jobRoot = path.dirname(privateHome);
  const writableSources = [{ name: 'private job state', path: jobRoot }];
  const nativeSources = [];
  for (const name of NATIVE_NAMES) {
    if (!nativeState[name]) continue;
    if (!hostGrokRoot) fail('missing_path', `nativeState.${name} requires a canonical owner-only host .grok directory.`);
    const definition = NATIVE_DEFINITIONS[name];
    const source = path.join(hostGrokRoot, ...definition.relative.slice(1));
    const canonical = await canonicalDirectory(source, `nativeState.${name}`, { privateMode: true });
    await validateNativeTree(canonical, name);
    nativeSources.push({ name, source: canonical, writable: definition.writable });
    if (definition.writable) writableSources.push({ name: `native ${name}`, path: canonical });
  }
  assertNoWritableOverlap(target, writableSources);

  let state;
  const opened = [];
  let createdJobRoot = false;
  try {
    await mkdir(jobRoot, { mode: 0o700 });
    createdJobRoot = true;
    await chmod(jobRoot, 0o700);
    await mkdir(privateHome, { mode: 0o700 });
    await chmod(privateHome, 0o700);
    await mkdir(path.join(privateHome, '.grok'), { mode: 0o700 });
    if (hostGrokRoot) {
      await copyCredential(path.join(hostGrokRoot, 'auth.json'), path.join(privateHome, '.grok', 'auth.json'), 'auth.json');
      await copyCredential(path.join(hostGrokRoot, 'agent_id'), path.join(privateHome, '.grok', 'agent_id'), 'agent_id');
    }
    for (const native of nativeSources) {
      await mkdir(path.join(privateHome, ...NATIVE_DEFINITIONS[native.name].relative), { recursive: true, mode: 0o700 });
    }
    await assertPrivateHomeShape(privateHome, nativeSources.map(({ name }) => name));

    const bwrap = await openPinnedFile(options.bwrap, 'bwrap', { owner: 'current', executable: true, allowedFormats: ['static-elf'] });
    opened.push(bwrap);
    const provider = await openPinnedFile(options.provider, 'provider', {
      owner: 'current', executable: true, allowedFormats: ['static-elf', 'dynamic-elf', 'script'],
    });
    opened.push(provider);

    assertPlainObject(options.systemFiles, 'systemFiles');
    if (Object.keys(options.systemFiles).sort().join(',') !== [...SYSTEM_NAMES].sort().join(',')) {
      fail('invalid_configuration', 'systemFiles must provide exactly resolver, ca, passwd, group, services, and localtime.');
    }
    const systemFiles = [];
    for (const name of SYSTEM_NAMES) {
      assertExactKeys(options.systemFiles[name], ['source', 'sha256', 'format'], `systemFiles.${name}`,
        ['source', 'sha256', 'format']);
      const descriptor = { ...options.systemFiles[name], destination: SYSTEM_DESTINATIONS[name] };
      const record = await openPinnedFile(descriptor, `systemFiles.${name}`, { owner: 'root-or-current', allowedFormats: ['data'] });
      record.destination = SYSTEM_DESTINATIONS[name];
      systemFiles.push(record);
      opened.push(record);
    }

    if (!Array.isArray(options.runtimeClosure) || options.runtimeClosure.length > 64) {
      fail('invalid_configuration', 'runtimeClosure must be a bounded array.');
    }
    const runtimeClosure = [];
    const destinations = new Set();
    for (let index = 0; index < options.runtimeClosure.length; index += 1) {
      const descriptor = options.runtimeClosure[index];
      assertExactKeys(descriptor, ['source', 'sha256', 'format', 'destination'], `runtimeClosure[${index}]`,
        ['source', 'sha256', 'format', 'destination']);
      const runtimeExecutable = ['static-elf', 'dynamic-elf', 'script'].includes(descriptor.format);
      if (!['static-elf', 'dynamic-elf', 'script', 'elf-object', 'data'].includes(descriptor.format)) {
        fail('invalid_configuration', `runtimeClosure[${index}].format is not supported.`);
      }
      const destination = assertSafeDestination(descriptor.destination, `runtimeClosure[${index}].destination`, {
        executable: runtimeExecutable,
      });
      if (destinations.has(destination)) fail('invalid_configuration', 'runtimeClosure destinations must be unique.');
      destinations.add(destination);
      const record = await openPinnedFile(descriptor, `runtimeClosure[${index}]`, {
        owner: 'root-or-current', executable: runtimeExecutable,
        allowedFormats: [descriptor.format],
      });
      record.destination = destination;
      runtimeClosure.push(record);
      opened.push(record);
    }
    const closureByDestination = new Map(runtimeClosure.map((record) => [record.destination, record]));
    for (const record of [provider, ...runtimeClosure]) {
      if (!record.interpreter) continue;
      const interpreter = closureByDestination.get(record.interpreter);
      if (!interpreter) {
        fail('missing_runtime_closure', `${record.field} interpreter is absent from the exact runtime closure.`);
      }
      if (record.format === 'dynamic-elf' && interpreter.format !== 'elf-object') {
        fail('missing_runtime_closure', `${record.field} dynamic loader must be an exact ELF object closure entry.`);
      }
      if (record.format === 'script' && !interpreter.executable) {
        fail('missing_runtime_closure', `${record.field} script interpreter is not an executable closure entry.`);
      }
    }

    const rootRecord = await openPinnedDirectory(target.expected_git_root, 'target.expected_git_root');
    rootRecord.destination = '/workspace';
    rootRecord.writable = false;
    opened.push(rootRecord);
    const commonRecord = await openPinnedDirectory(target.git_common_directory, 'target.git_common_directory');
    commonRecord.destination = target.sandbox_git_common_directory;
    commonRecord.writable = false;
    opened.push(commonRecord);
    const homeRecord = await openPinnedDirectory(privateHome, 'privateHome', { privateMode: true });
    homeRecord.destination = '/home/grok';
    homeRecord.writable = true;
    opened.push(homeRecord);
    const nativeRecords = [];
    for (const native of nativeSources) {
      const record = await openPinnedDirectory(native.source, `nativeState.${native.name}`);
      record.destination = `/home/grok/${NATIVE_DEFINITIONS[native.name].relative.join('/')}`;
      record.writable = native.writable;
      record.name = native.name;
      nativeRecords.push(record);
      opened.push(record);
    }

    await probePinnedBwrap(bwrap);
    await probePinnedProvider({ bwrap, provider, systemFiles, runtimeClosure });

    const prepared = Object.freeze({
      policy_version: GROK_OUTER_SANDBOX_POLICY_VERSION,
      role: GROK_OUTER_SANDBOX_ROLE,
      job_id: options.jobId,
      target: Object.freeze({ ...target }),
      target_contract_digest: target.target_contract_digest,
      private_home: privateHome,
      native_mounts: Object.freeze(nativeRecords.map((record) => Object.freeze({
        name: record.name, destination: record.destination, writable: record.writable,
      }))),
      provenance: Object.freeze({
        bwrap: Object.freeze({ sha256: bwrap.sha256, version: bwrap.version, format: bwrap.format }),
        provider: Object.freeze({ sha256: provider.sha256, version: provider.version, format: provider.format }),
      }),
    });
    state = {
      prepared,
      privateHome,
      jobRoot,
      target,
      bwrap,
      provider,
      systemFiles,
      runtimeClosure,
      rootRecord,
      commonRecord,
      homeRecord,
      nativeRecords,
      nativeNames: nativeSources.map(({ name }) => name),
      records: opened,
      spawned: false,
      launching: false,
      cleaned: false,
      child: null,
      timer: null,
      completion: null,
      settleCleanupFailure: null,
      cleanupPromise: null,
      terminationPromise: null,
      exitObservation: null,
      terminationReason: null,
    };
    PREPARED.set(prepared, state);
    state.timer = setTimeout(() => {
      expireState(state).catch(() => {});
    }, ttlMs);
    state.timer.unref?.();
    return prepared;
  } catch (error) {
    await closeRecords(opened);
    if (createdJobRoot) await removePrivateHome(jobRoot);
    throw error;
  }
}

function stateFor(prepared) {
  const state = PREPARED.get(prepared);
  if (!state || state.cleaned) fail('invalid_prepared_state', 'Prepared sandbox state is absent or already cleaned.');
  return state;
}

function finalResources(state) {
  state.provider.destination = '/opt/grok/bin/grok';
  state.provider.writable = false;
  return [
    state.bwrap,
    state.provider,
    ...state.systemFiles.map((record) => Object.assign(record, { writable: false })),
    ...state.runtimeClosure.map((record) => Object.assign(record, { writable: false })),
    state.rootRecord,
    state.commonRecord,
    state.homeRecord,
    ...state.nativeRecords,
  ];
}

function executionPlan(state, invocation) {
  if (!INVOCATIONS.has(invocation)) fail('invalid_invocation', 'Only createGrokReviewInvocation output is accepted.');
  if (invocation.operation !== state.target.role) {
    fail('target_role_mismatch', 'invocation.operation must match the authoritative target.role.');
  }
  const config = invocation.configuration;
  const native = new Set(state.nativeNames);
  if ((config.session_id || config.resume || config.continue_session || config.fork_session)
    && !native.has('sessions')) {
    fail('unsupported_native_feature',
      'Session selection/resume/fork requires a securely proven nativeState.sessions mount.');
  }
  if (config.experimental_memory && !native.has('memory')) {
    fail('unsupported_native_feature',
      'experimental_memory requires a securely proven nativeState.memory mount.');
  }
  if (config.agent && !native.has('agents')) {
    fail('unsupported_native_feature',
      'A named agent requires a securely proven nativeState.agents mount.');
  }
  const environment = {
    ...GROK_OUTER_SANDBOX_ENV,
    [GROK_OUTER_JOB_ENV_KEY]: state.prepared.job_id,
    PATH: providerPathEnvironment(state.runtimeClosure),
    PWD: state.target.sandbox_working_directory,
  };
  return mountArguments({
    resources: finalResources(state),
    environment,
    chdir: state.target.sandbox_working_directory,
    providerArgs: invocationArgs(invocation, state.target.sandbox_working_directory),
  });
}

export function buildGrokOuterSandboxArgv(options) {
  assertExactKeys(options, ['prepared', 'invocation'], 'buildOptions', ['prepared', 'invocation']);
  const { prepared, invocation } = options;
  return [...executionPlan(stateFor(prepared), invocation).argv];
}

async function cleanupState(state) {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleaned = true;
  clearTimeout(state.timer);
  state.cleanupPromise = (async () => {
    // Drop the lifecycle state's optional secret reference. A running output
    // redactor owns only its bounded match buffer until the stream closes; the
    // value is never copied into prepared state or receipts.
    await closeRecords(state.records);
    await removePrivateHome(state.jobRoot);
  })();
  return state.cleanupPromise;
}

async function expireState(state) {
  if (state.cleaned) {
    try {
      if (childGroupNeedsTermination(state.child)) await terminateChild(state);
    } catch {}
    await state.cleanupPromise;
    return;
  }
  try {
    if (childGroupNeedsTermination(state.child)) state.terminationReason ??= 'ttl_expired';
    if (childGroupNeedsTermination(state.child)) await terminateChild(state);
  } catch (error) {
    await state.settleCleanupFailure?.(error);
    throw error;
  } finally {
    await cleanupState(state);
  }
}

export async function cleanupGrokOuterSandbox(prepared) {
  const state = PREPARED.get(prepared);
  if (!state) return;
  if (state.cleaned) {
    try {
      if (childGroupNeedsTermination(state.child)) await terminateChild(state);
    } catch {}
    await state.cleanupPromise;
    return;
  }
  try {
    if (childGroupNeedsTermination(state.child)) state.terminationReason ??= 'cancelled';
    if (childGroupNeedsTermination(state.child)) await terminateChild(state);
  } catch (error) {
    await state.settleCleanupFailure?.(error);
    throw error;
  } finally {
    await cleanupState(state);
  }
}

export async function spawnGrokOuterSandbox(options) {
  const prepared = options?.prepared;
  const state = stateFor(prepared);
  if (state.spawned || state.launching) fail('already_spawned', 'A prepared sandbox is single-use.');
  state.launching = true;
  let invocation;
  let plan;
  try {
    assertExactKeys(options, ['prepared', 'invocation'], 'spawnOptions', ['prepared', 'invocation']);
    invocation = options.invocation;
    if (!INVOCATIONS.has(invocation)) fail('invalid_invocation', 'Only createGrokReviewInvocation output is accepted.');
    await assertNoHostileProjectConfig(state.target.expected_git_root, state.target.working_directory);
    await assertPrivateHomeShape(state.privateHome, state.nativeNames);
    for (const record of state.records) await revalidatePinned(record);
    plan = executionPlan(state, invocation);
  } catch (error) {
    await cleanupState(state);
    throw error;
  }
  state.spawned = true;
  let child;
  try {
    child = spawn(plan.command, plan.argv, {
      ...GROK_OUTER_SPAWN_OPTIONS,
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: plan.stdio,
    });
  } catch (error) {
    await cleanupState(state);
    fail('sandbox_spawn_failed', `Bubblewrap could not be spawned: ${error.message}`);
  }
  // Own the raw process and its lifecycle before performing any fallible
  // facade setup. No raw ChildProcess reference leaves this module.
  state.child = child;
  state.launching = false;
  state.exitObservation = null;
  const completion = new Promise((resolve) => {
    let settled = false;
    const finish = async (code, signal, error = null, forcedCleanupFailure = null) => {
      if (settled) return;
      settled = true;
      let cleanupFailure = forcedCleanupFailure;
      if (!cleanupFailure) {
        try {
          if (childGroupNeedsTermination(child)) await terminateChild(state);
        } catch (cleanupError) {
          cleanupFailure = cleanupError;
        }
      }
      try {
        await cleanupState(state);
      } catch (cleanupError) {
        cleanupFailure ??= cleanupError;
      }
      const outcome = cleanupFailure
        ? 'cleanup_failed'
        : state.terminationReason
        ?? (error ? 'spawn_error' : signal ? 'signalled' : 'exited');
      resolve(Object.freeze({
        code,
        signal,
        error: cleanupFailure?.code ?? error?.code ?? null,
        outcome,
        cleaned: cleanupFailure === null,
      }));
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal));
    state.settleCleanupFailure = (error) => finish(null, null, null, error);
  });
  state.completion = completion;
  const publicChild = childFacade(state, child.stdout, child.stderr);
  const receipt = Object.freeze({
    policy_version: GROK_OUTER_SANDBOX_POLICY_VERSION,
    real_boundary_exercised: true,
    root: 'synthetic-tmpfs-remounted-read-only',
    network_namespace: 'shared',
    nested_user_namespaces: 'disabled-and-asserted',
    provider_policy: Object.freeze({ sandbox: 'read-only', permission_mode: 'auto', denied_tools: Object.freeze(['MCPTool']) }),
    target: prepared.target,
    target_contract_digest: prepared.target_contract_digest,
    invocation_contract: invocation.contract,
    provenance: prepared.provenance,
    spawn_contract: Object.freeze({ detached: true, process_group: 'child-pid', shell: false, die_with_parent: true }),
    native_mounts: prepared.native_mounts,
  });
  return Object.freeze({ child: publicChild, completion, receipt });
}
