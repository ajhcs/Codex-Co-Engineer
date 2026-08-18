/*
 * Local ACP provider registry.
 *
 * This module is deliberately not imported by the MCP server.  It is a small
 * policy/attestation seam for a future ACP session worker: it knows which
 * local ACP command belongs to a profile, validates the typed profile options,
 * and can attest an installed executable without starting a provider
 * session.  Importing this module performs no I/O and has no process-wide
 * side effects.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  open,
  lstat,
  mkdtemp,
  readFile,
  rm,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from 'node:path';

export const ACP_PROFILE_IDS = Object.freeze([
  'grok-local-acp',
  'cursor-local-acp',
]);

export const TARGET_ROLES = Object.freeze([
  'review',
  'verify',
  'implement',
]);

// These are the reasoning values accepted by the existing Grok connector.
// ACP uses them as typed session configuration; they are never interpolated
// into a command string.
export const GROK_REASONING_EFFORTS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export const ACP_LIMITS = Object.freeze({
  maxModelBytes: 128,
  maxAllowedTools: 32,
  maxAllowedToolBytes: 96,
  maxCursorTurns: 64,
  // Grok's distributed Linux binary is currently ~166 MiB.  Keep a finite
  // bound while allowing that canonical layout to be attested and staged.
  maxExecutableBytes: 256 * 1024 * 1024,
  maxProbeOutputBytes: 64 * 1024,
  maxProbeVersionOutputBytes: 8 * 1024,
  minProbeTimeoutMs: 50,
  maxProbeTimeoutMs: 15_000,
  defaultProbeTimeoutMs: 2_000,
});

const PROFILE_DEFINITIONS = Object.freeze({
  'grok-local-acp': Object.freeze({
    id: 'grok-local-acp',
    provider: 'grok',
    transport: 'acp-stdio',
    executable: 'grok',
    argv: Object.freeze(['agent', 'stdio']),
    identityWords: Object.freeze(['grok']),
  }),
  'cursor-local-acp': Object.freeze({
    id: 'cursor-local-acp',
    provider: 'cursor',
    transport: 'acp-stdio',
    executable: 'cursor-agent',
    argv: Object.freeze(['acp']),
    identityWords: Object.freeze(['cursor-agent', 'cursor agent']),
  }),
});

export const ACP_PROVIDER_PROFILES = PROFILE_DEFINITIONS;
// A shorter alias is useful to callers building a static catalog.
export const PROVIDER_PROFILES = PROFILE_DEFINITIONS;

const ROLE_POLICIES = Object.freeze({
  review: Object.freeze({
    role: 'review',
    permission: 'read-only',
    permission_mode: 'read-only',
    write_ceiling: 'read-only',
    writeCeiling: 'read-only',
  }),
  verify: Object.freeze({
    role: 'verify',
    permission: 'read-only',
    permission_mode: 'read-only',
    write_ceiling: 'read-only',
    writeCeiling: 'read-only',
  }),
  implement: Object.freeze({
    role: 'implement',
    permission: 'workspace',
    permission_mode: 'workspace',
    write_ceiling: 'declared-paths',
    writeCeiling: 'declared-paths',
  }),
});

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$/u;
const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,95}$/u;
const VERSION = /\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/u;
const UNSAFE_AMBIENT_VARIABLES = Object.freeze(['NODE_OPTIONS', 'LD_PRELOAD']);
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'find',
  'search',
  'webfetch',
  'websearch',
]);

// No provider credential, home directory, config directory, or user-supplied
// environment is passed to a probe.  PATH is synthesized from the running
// Node executable and fixed system locations so a shebang can resolve without
// inheriting a potentially writable ambient PATH.
const PROBE_ENV_KEYS = Object.freeze(['PATH', 'LANG', 'LC_ALL', 'TZ']);
// Fixed helper: copy the attested source FD into a sealed memfd, close the
// source, and exec only the immutable descriptor.
const PYTHON_LAUNCHER = String.raw`import fcntl, hashlib, os, sys
src = 3
expected_size = int(sys.argv[1])
expected_digest = sys.argv[2]
provider_argv = sys.argv[3:]
seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SEAL
fd = os.memfd_create("acp-provider", os.MFD_ALLOW_SEALING)
os.lseek(src, 0, os.SEEK_SET)
h = hashlib.sha256()
n = 0
while True:
    chunk = os.read(src, 1024 * 1024)
    if not chunk: break
    n += len(chunk)
    if n > expected_size: raise SystemExit(126)
    h.update(chunk)
    view = memoryview(chunk)
    while view:
        written = os.write(fd, view)
        view = view[written:]
if n != expected_size or h.hexdigest() != expected_digest: raise SystemExit(126)
os.close(src)
os.fchmod(fd, 0o500)
fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
if fcntl.fcntl(fd, fcntl.F_GET_SEALS) != seals: raise SystemExit(126)
os.set_inheritable(fd, True)
os.execve("/proc/self/fd/" + str(fd), provider_argv, os.environ)`;
const PYTHON_RUNTIME = '/usr/bin/python3.12';

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeDeep(entry);
    return Object.freeze(value);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function prefixedDigest(value) {
  return `sha256:${value}`;
}

export class AcpProviderRegistryError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = 'AcpProviderRegistryError';
    this.code = code;
    if (field !== null) this.field = field;
  }
}

function fail(code, message, field = null) {
  throw new AcpProviderRegistryError(code, message, field);
}

function requireProfileId(value, field = 'profile') {
  if (typeof value !== 'string' || !ACP_PROFILE_IDS.includes(value)) {
    fail('unsupported_profile', 'profile is not a supported local ACP profile.', field);
  }
  return value;
}

function profileDefinition(profileId) {
  const id = requireProfileId(profileId);
  return PROFILE_DEFINITIONS[id];
}

function requireRole(value, field = 'role') {
  if (typeof value !== 'string' || !TARGET_ROLES.includes(value)) {
    fail('unsupported_role', 'role must be review, verify, or implement.', field);
  }
  return value;
}

function requireAuthoritativeTarget(target) {
  if (!isPlainObject(target) || Object.keys(target).some((key) => key !== 'role')) {
    fail('role_authority_required', 'an authoritative target containing only role is required.', 'target');
  }
  return requireRole(target.role, 'target.role');
}

/**
 * Derive the outer permission and write ceiling from the authoritative target
 * role.  A provider configuration cannot supply either value itself.
 */
export function deriveRolePolicy(role = 'review') {
  const policy = ROLE_POLICIES[requireRole(role)];
  return freezeDeep(clone(policy));
}

export const permissionForRole = deriveRolePolicy;
export const writeCeilingForRole = (role = 'review') => deriveRolePolicy(role).write_ceiling;

function safeText(value, field, maximum, pattern = null) {
  if (typeof value !== 'string' || value.length < 1 || utf8Bytes(value) > maximum) {
    fail('invalid_config', `${field} must be a non-empty string of at most ${maximum} bytes.`, field);
  }
  if (/\u0000|[\u0001-\u001f\u007f]/u.test(value)) {
    fail('invalid_config', `${field} contains a control character.`, field);
  }
  if (value.startsWith('-')) {
    fail('invalid_config', `${field} must not start with a dash.`, field);
  }
  if (pattern && !pattern.test(value)) {
    fail('invalid_config', `${field} contains unsupported characters.`, field);
  }
  return value;
}

function optionalModel(value) {
  if (value === undefined) return null;
  return safeText(value, 'model', ACP_LIMITS.maxModelBytes, SAFE_MODEL);
}

function optionalReasoningEffort(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !GROK_REASONING_EFFORTS.includes(value)) {
    fail('invalid_config', 'reasoning_effort is not a supported Grok reasoning value.', 'reasoning_effort');
  }
  return value;
}

function optionalDelegation(value) {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    fail('invalid_config', 'delegation must be a boolean.', 'delegation');
  }
  return value;
}

function optionalAllowedTools(value, role = 'implement') {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ACP_LIMITS.maxAllowedTools) {
    fail('invalid_config', `allowed_tools must contain at most ${ACP_LIMITS.maxAllowedTools} values.`, 'allowed_tools');
  }
  const tools = value.map((tool, index) => safeText(
    tool,
    `allowed_tools[${index}]`,
    ACP_LIMITS.maxAllowedToolBytes,
    SAFE_TOOL,
  ));
  if (new Set(tools).size !== tools.length) {
    fail('invalid_config', 'allowed_tools must not contain duplicates.', 'allowed_tools');
  }
  if (role !== 'implement' && tools.some((tool) => !READ_ONLY_TOOLS.has(tool.toLowerCase()))) {
    fail('unsupported_capability', 'review and verify profiles may only allow read-only tools.', 'allowed_tools');
  }
  return tools;
}

function optionalMaxTurns(value) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > ACP_LIMITS.maxCursorTurns) {
    fail('invalid_config', `max_turns must be an integer from 1 to ${ACP_LIMITS.maxCursorTurns}.`, 'max_turns');
  }
  return value;
}

function assertCreateKeys(input, profileId) {
  const common = new Set(['profile', 'role', 'model']);
  const providerKeys = profileId === 'grok-local-acp'
    ? ['reasoning_effort', 'delegation']
    : ['allowed_tools', 'max_turns'];
  const allowed = new Set([...common, ...providerKeys]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      fail('unsupported_config', `${key} is not supported by ${profileId}.`, key);
    }
  }
}

/**
 * Validate one typed provider create configuration.  This function does not
 * touch the filesystem or invoke a provider.
 */
export function normalizeCreateConfig(input, expectedProfile = null, roleOverride = undefined) {
  if (!isPlainObject(input)) fail('invalid_config', 'create configuration must be an object.');
  const profileId = requireProfileId(expectedProfile ?? input.profile);
  if (expectedProfile !== null && Object.hasOwn(input, 'profile') && input.profile !== expectedProfile) {
    fail('unsupported_profile', 'configuration profile does not match the selected registry profile.', 'profile');
  }
  assertCreateKeys(input, profileId);
  const requestedRole = roleOverride ?? input.role ?? 'review';
  if (roleOverride === undefined && input.role === 'implement') {
    fail('role_authority_required', 'implement requires an authoritative target role.', 'role');
  }
  if (roleOverride !== undefined && Object.hasOwn(input, 'role') && input.role !== roleOverride) {
    fail('unsupported_role', 'configuration role does not match the authoritative target role.', 'role');
  }
  const role = requireRole(requestedRole);
  const normalized = {
    profile: profileId,
    role,
    model: optionalModel(input.model),
  };
  if (profileId === 'grok-local-acp') {
    normalized.reasoning_effort = optionalReasoningEffort(input.reasoning_effort);
    normalized.delegation = optionalDelegation(input.delegation);
  } else {
    normalized.allowed_tools = optionalAllowedTools(input.allowed_tools, role);
    normalized.max_turns = optionalMaxTurns(input.max_turns);
  }
  return freezeDeep(normalized);
}

export const validateCreateConfig = normalizeCreateConfig;

export function normalizeProviderCreateConfig(profileId, input = {}, roleOverride = undefined) {
  requireProfileId(profileId);
  if (!isPlainObject(input)) fail('invalid_config', 'provider create configuration must be an object.');
  if (Object.hasOwn(input, 'profile') && input.profile !== profileId) {
    fail('unsupported_profile', 'configuration profile does not match the selected registry profile.', 'profile');
  }
  const merged = { ...input, profile: profileId };
  return normalizeCreateConfig(merged, profileId, roleOverride);
}

export const createProviderConfig = normalizeProviderCreateConfig;

function delegationState(requested, supported = 'unknown') {
  return {
    requested: requested === null ? 'unknown' : requested,
    supported,
    effective: 'unknown',
  };
}

function detectDelegationSupport(helpText) {
  const negative = /(?:delegat(?:ion|e|es)|subagents?|child\s+agents?).{0,80}(?:unsupported|not\s+supported|unavailable|disabled)|(?:unsupported|not\s+supported|unavailable|disabled).{0,80}(?:delegat(?:ion|e|es)|subagents?|child\s+agents?)/iu;
  if (negative.test(helpText)) return false;
  const positive = /\b(?:delegat(?:ion|e|es)|subagents?|child\s+agents?)\b/iu;
  return positive.test(helpText) ? true : 'unknown';
}

function makeCapabilities(requested = null, supported = 'unknown') {
  const delegation = delegationState(requested, supported);
  return {
    delegation,
    // `subagents` is an intentionally identical compatibility view.  It does
    // not claim a separate provider capability or a count/limit.
    subagents: clone(delegation),
  };
}

function capabilityBooleanOrUnknown(value) {
  return value === true || value === false || value === 'unknown' ? value : 'unknown';
}

function sanitizeCapabilities(value) {
  const delegation = value?.delegation;
  const requested = delegation?.requested === true || delegation?.requested === false
    ? delegation.requested
    : 'unknown';
  const supported = capabilityBooleanOrUnknown(delegation?.supported);
  // Effective delegation is intentionally never accepted from a caller: only
  // a future session/event probe can prove that a requested capability ran.
  return makeCapabilities(requested, supported);
}

function identityFields(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function identityEqual(left, right) {
  const fields = ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs'];
  return fields.every((field) => Object.is(left[field], right[field]));
}

async function readPinnedContent(fileHandle, stat) {
  const buffer = Buffer.allocUnsafe(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) fail('executable_changed', 'pinned ACP executable could not be read completely.');
    offset += bytesRead;
  }
  return buffer;
}

function identityDigest(identity, contentDigest) {
  return prefixedDigest(sha256(JSON.stringify({ identity, contentDigest })));
}

function requirePosixOwnership() {
  if (typeof process.getuid !== 'function') {
    fail('unsupported_platform', 'local ACP executable attestation requires POSIX ownership checks.');
  }
  return process.getuid();
}

async function inspectExecutable(executablePath, { allowWritable = false, strictAncestors = true } = {}) {
  if (typeof executablePath !== 'string' || !isAbsolute(executablePath) || executablePath.includes('\0')) {
    fail('invalid_executable', 'executable path must be absolute.');
  }
  const normalized = resolve(executablePath);
  if (normalized !== executablePath) {
    fail('invalid_executable', 'executable path must be normalized and canonical.');
  }
  const uid = requirePosixOwnership();
  const ancestors = [];
  let ancestor = dirname(executablePath);
  while (true) {
    ancestors.push(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const component of ancestors.reverse()) {
    let ancestorStat;
    try {
      ancestorStat = await lstat(component);
    } catch {
      fail('executable_unavailable', 'canonical ACP executable parent could not be inspected.');
    }
    if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) {
      fail('unsafe_executable', 'canonical ACP executable has an unsafe parent path.');
    }
    if (ancestorStat.uid !== uid && ancestorStat.uid !== 0) {
      fail('unsafe_executable', 'canonical ACP executable parent owner is not current user or root.');
    }
    if (strictAncestors && (ancestorStat.mode & 0o022) !== 0 && (ancestorStat.mode & 0o1000) === 0) {
      fail('unsafe_executable', 'canonical ACP executable has a non-sticky group/world-writable parent.');
    }
  }
  let stat;
  try {
    stat = await lstat(executablePath);
  } catch (error) {
    fail('executable_unavailable', 'canonical ACP executable could not be inspected.');
  }
  if (stat.isSymbolicLink()) fail('unsafe_executable', 'canonical ACP executable must not be a symbolic link.');
  if (!stat.isFile()) fail('unsafe_executable', 'canonical ACP executable must be a regular file.');
  if (stat.nlink !== 1) fail('unsafe_executable', 'canonical ACP executable must have exactly one hard link.');
  if (stat.uid !== uid && stat.uid !== 0) fail('unsafe_executable', 'canonical ACP executable owner is not current user or root.');
  if (!allowWritable && (stat.mode & 0o022) !== 0) {
    fail('unsafe_executable', 'canonical ACP executable is group/world writable.');
  }
  if ((stat.mode & 0o111) === 0) fail('unsafe_executable', 'canonical ACP executable is not executable.');
  if (stat.size < 1 || stat.size > ACP_LIMITS.maxExecutableBytes) {
    fail('unsafe_executable', 'canonical ACP executable size is outside the bounded range.');
  }
  let canonical;
  try {
    canonical = await realpath(executablePath);
  } catch {
    fail('executable_unavailable', 'canonical ACP executable could not be resolved.');
  }
  if (canonical !== executablePath) {
    fail('unsafe_executable', 'canonical ACP executable path resolves through a symlink.');
  }
  let source;
  try {
    source = await readFile(executablePath);
  } catch {
    fail('executable_unavailable', 'canonical ACP executable could not be read for attestation.');
  }
  const beforeIdentity = identityFields(stat);
  const beforeDigest = sha256(source);
  let afterStat;
  try {
    afterStat = await lstat(executablePath);
  } catch {
    fail('executable_changed', 'canonical ACP executable disappeared during attestation.');
  }
  const afterIdentity = identityFields(afterStat);
  if (!identityEqual(beforeIdentity, afterIdentity)) {
    fail('executable_changed', 'canonical ACP executable identity changed during attestation.');
  }
  let afterSource;
  try {
    afterSource = await readFile(executablePath);
  } catch {
    fail('executable_changed', 'canonical ACP executable changed during attestation.');
  }
  const afterDigest = sha256(afterSource);
  if (beforeDigest !== afterDigest) {
    fail('executable_changed', 'canonical ACP executable digest changed during attestation.');
  }
  const identity = beforeIdentity;
  return {
    path: executablePath,
    identity,
    digest: beforeDigest,
    identityDigest: identityDigest(identity, beforeDigest),
    content: afterSource,
  };
}

async function revalidateExecutable(attestation) {
  const current = await inspectExecutable(attestation.path);
  if (current.digest !== attestation.digest || current.identityDigest !== attestation.identityDigest) {
    fail('executable_changed', 'canonical ACP executable identity or digest changed after attestation.');
  }
  if (attestation.fileHandle) {
    const pinnedStat = await attestation.fileHandle.stat();
    const pinnedIdentity = identityFields(pinnedStat);
    if (!identityEqual(pinnedIdentity, attestation.identity)) {
      fail('executable_changed', 'pinned ACP executable identity changed during revalidation.');
    }
    const pinnedContent = await readPinnedContent(attestation.fileHandle, pinnedStat);
    if (sha256(pinnedContent) !== attestation.digest) {
      fail('executable_changed', 'pinned ACP executable digest changed during revalidation.');
    }
  }
  const { content: _currentContent, ...compactCurrent } = current;
  return {
    ...compactCurrent,
    stageDirectory: attestation.stageDirectory,
    sourcePath: attestation.sourcePath,
    fileHandle: attestation.fileHandle,
    fd: attestation.fd,
    launchPath: attestation.launchPath,
  };
}

async function pinExecutable(attestation) {
  const fileHandle = await open(attestation.path, 'r');
  try {
    const pinnedStat = await fileHandle.stat();
    const pinnedIdentity = identityFields(pinnedStat);
    if (!identityEqual(pinnedIdentity, attestation.identity)) {
      fail('executable_changed', 'ACP executable changed before it could be pinned.');
    }
    const pinnedContent = await readPinnedContent(fileHandle, pinnedStat);
    if (sha256(pinnedContent) !== attestation.digest) {
      fail('executable_changed', 'ACP executable digest changed before it could be pinned.');
    }
    return {
      ...attestation,
      fileHandle,
      fd: fileHandle.fd,
      launchPath: '/proc/self/fd/3',
    };
  } catch (error) {
    await fileHandle.close().catch(() => {});
    throw error;
  }
}

async function stageExecutable(definition, sourcePath, sourceAttestation) {
  const stageDirectory = await mkdtemp(join(tmpdir(), 'codex-acp-registry-'));
  try {
    await chmod(stageDirectory, 0o700);
    const stagedPath = join(stageDirectory, definition.executable);
    await writeFile(stagedPath, sourceAttestation.content, { mode: 0o500 });
    await chmod(stagedPath, 0o500);
    const staged = await inspectExecutable(stagedPath);
    if (staged.digest !== sourceAttestation.digest) {
      fail('executable_changed', 'staged ACP executable digest does not match the verified source.');
    }
    const { content: _stagedContent, ...compactStaged } = staged;
    await chmod(stageDirectory, 0o500);
    return { ...compactStaged, stageDirectory, sourcePath };
  } catch (error) {
    await removeStageDirectory(stageDirectory);
    throw error;
  }
}

async function removeStageDirectory(stageDirectory) {
  if (typeof stageDirectory !== 'string') return;
  await chmod(stageDirectory, 0o700).catch(() => {});
  await rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
}

async function closeAttestation(attestation) {
  if (attestation?.fileHandle) await attestation.fileHandle.close().catch(() => {});
}

function safeProbePath() {
  const nodeDirectory = dirname(process.execPath);
  return [nodeDirectory, '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
}

function assertCleanAmbientEnvironment(environment = process.env) {
  if (!environment || typeof environment !== 'object') {
    fail('unsafe_environment', 'probe environment must be an object.');
  }
  for (const key of UNSAFE_AMBIENT_VARIABLES) {
    if (Object.hasOwn(environment, key)) {
      fail('unsafe_environment', `${key} must not be present in the ACP launcher environment.`);
    }
  }
  return true;
}

export { assertCleanAmbientEnvironment };

function cleanProbeEnvironment(environment = process.env) {
  assertCleanAmbientEnvironment(environment);
  const clean = {
    PATH: safeProbePath(),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
  // Keep this explicit rather than spreading process.env.  The loop makes the
  // allowlist visible to future maintainers and prevents accidental widening.
  for (const key of PROBE_ENV_KEYS) {
    if (key === 'PATH' || key === 'LANG' || key === 'LC_ALL' || key === 'TZ') continue;
    if (Object.hasOwn(environment, key) && typeof environment[key] === 'string') {
      clean[key] = environment[key];
    }
  }
  return clean;
}

function boundedOutputAppend(buffer, chunk, maximum) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const next = buffer.length + bytes.length;
  if (next > maximum) return null;
  return Buffer.concat([buffer, bytes]);
}

function signalProbeProcess(child, signal) {
  if (child?.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child signal when the group has already
      // exited or the platform refuses a negative PID.
    }
  }
  try { child?.kill(signal); } catch {}
}

function runBoundedProbe(executablePath, args, {
  environment,
  timeoutMs,
  outputLimit,
  pinnedFd = null,
  digest = null,
  size = null,
  providerName = null,
  pythonRuntime = PYTHON_RUNTIME,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      const command = pinnedFd === null ? executablePath : pythonRuntime;
      const commandArgs = pinnedFd === null
        ? args
        : ['-I', '-S', '-c', PYTHON_LAUNCHER, String(size), digest, providerName, ...args];
      child = spawn(command, commandArgs, {
        cwd: parse(executablePath).root,
        env: environment,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: pinnedFd === null ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', pinnedFd],
      });
    } catch {
      rejectPromise(new AcpProviderRegistryError('probe_failed', 'canonical ACP executable could not be started.'));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTooLarge = false;
    let settled = false;
    let forcedError = null;
    let stopping = false;
    let timer;
    let killTimer;
    let hardStopTimer;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(hardStopTimer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const terminate = (error) => {
      if (stopping) return;
      stopping = true;
      forcedError = error;
      signalProbeProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalProbeProcess(child, 'SIGKILL');
        hardStopTimer = setTimeout(() => finish(forcedError), 500);
        hardStopTimer.unref?.();
      }, 150);
      killTimer.unref?.();
    };
    const cleanupSuccessfulGroup = (result) => {
      if (stopping) return;
      stopping = true;
      signalProbeProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalProbeProcess(child, 'SIGKILL');
        hardStopTimer = setTimeout(() => finish(null, result), 50);
      }, 150);
    };
    child.stdout.on('data', (chunk) => {
      const next = boundedOutputAppend(stdout, chunk, outputLimit);
      if (next === null || next.length + stderr.length > outputLimit) {
        outputTooLarge = true;
        terminate(new AcpProviderRegistryError('probe_output_limit', 'canonical ACP executable probe output exceeded the bound.'));
      } else {
        stdout = next;
      }
    });
    child.stderr.on('data', (chunk) => {
      const next = boundedOutputAppend(stderr, chunk, outputLimit);
      if (next === null || stdout.length + next.length > outputLimit) {
        outputTooLarge = true;
        terminate(new AcpProviderRegistryError('probe_output_limit', 'canonical ACP executable probe output exceeded the bound.'));
      } else {
        stderr = next;
      }
    });
    child.once('error', () => {
      terminate(new AcpProviderRegistryError('probe_failed', 'canonical ACP executable probe failed.'));
    });
    child.once('close', (code, signal) => {
      if (forcedError) return terminate(forcedError);
      if (outputTooLarge) return terminate(new AcpProviderRegistryError('probe_output_limit', 'canonical ACP executable probe output exceeded the bound.'));
      if (signal !== null || code !== 0) {
        return terminate(new AcpProviderRegistryError('probe_failed', 'canonical ACP executable probe did not exit successfully.'));
      }
      cleanupSuccessfulGroup({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });
    timer = setTimeout(() => {
      terminate(new AcpProviderRegistryError('probe_timeout', 'canonical ACP executable probe exceeded its time bound.'));
    }, timeoutMs);
    timer.unref?.();
  });
}

function outputText(result) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function expectedIdentityPresent(text, definition) {
  const normalized = text.toLowerCase();
  return definition.identityWords.some((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(normalized);
  });
}

function parseVersion(text, definition) {
  if (!expectedIdentityPresent(text, definition)) {
    fail('invalid_provenance', `version probe did not identify the canonical ${definition.executable} executable.`);
  }
  const match = text.match(VERSION);
  if (!match) fail('invalid_version', 'version probe did not return a bounded semantic version.');
  return match[0];
}

function publicDescriptor(definition, attestation = null, version = null, helpDigest = null, capabilities = null) {
  const result = {
    id: definition.id,
    provider: definition.provider,
    transport: definition.transport,
    executable: definition.executable,
    argv: [...definition.argv],
    version,
    executable_digest: attestation ? prefixedDigest(attestation.digest) : null,
    identity_digest: attestation ? attestation.identityDigest : null,
    help_digest: helpDigest,
    provenance: attestation ? 'canonical-local-executable' : 'unprobed',
    capabilities: capabilities ?? makeCapabilities(),
  };
  result.provenance_digest = prefixedDigest(sha256(JSON.stringify({
    id: result.id,
    executable: result.executable,
    argv: result.argv,
    version: result.version,
    executable_digest: result.executable_digest,
    identity_digest: result.identity_digest,
    help_digest: result.help_digest,
    provenance: result.provenance,
  })));
  return freezeDeep(result);
}

function sourcePathFor(definition, executablePaths) {
  const supplied = executablePaths?.[definition.executable];
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !isAbsolute(supplied) || basenameOf(supplied) !== definition.executable) {
      fail('invalid_executable', `configured ${definition.executable} path must be an absolute canonical executable path.`);
    }
    return resolve(supplied) === supplied ? supplied : fail('invalid_executable', 'configured executable path must be normalized.');
  }
  fail('executable_unavailable', `no canonical ${definition.executable} executable was found.`);
}

function basenameOf(value) {
  const normalized = value.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

async function findExecutable(definition, executablePaths, pathValue) {
  const configured = executablePaths?.[definition.executable];
  if (configured !== undefined) return sourcePathFor(definition, executablePaths);
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    fail('executable_unavailable', `no canonical ${definition.executable} executable was configured or found.`);
  }
  let firstCandidate = null;
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    const candidate = join(entry, definition.executable);
    if (firstCandidate === null) firstCandidate = candidate;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.  inspectExecutable will fail closed for an
      // existing but unsafe selected candidate.
    }
  }
  if (firstCandidate !== null) {
    // Preserve the useful unavailable error rather than invoking a generic
    // command or falling back to another executable name.
    fail('executable_unavailable', `no canonical ${definition.executable} executable was found.`);
  }
  fail('executable_unavailable', `no absolute PATH entry contains canonical ${definition.executable}.`);
}

async function attestAndStage(definition, candidatePath) {
  let sourcePath;
  try {
    sourcePath = await realpath(candidatePath);
  } catch {
    fail('executable_unavailable', 'canonical ACP executable could not be resolved.');
  }
  const sourceBefore = await inspectExecutable(sourcePath, { allowWritable: true, strictAncestors: false });
  let staged = null;
  try {
    staged = await stageExecutable(definition, sourcePath, sourceBefore);
    const sourceAfter = await inspectExecutable(sourcePath, { allowWritable: true, strictAncestors: false });
    if (sourceAfter.digest !== sourceBefore.digest
      || sourceAfter.identityDigest !== sourceBefore.identityDigest) {
      fail('executable_changed', 'canonical ACP executable changed while being staged.');
    }
    return await pinExecutable(staged);
  } catch (error) {
    await closeAttestation(staged);
    await removeStageDirectory(staged?.stageDirectory);
    throw error;
  }
}

function validateRegistryOptions(options) {
  if (!isPlainObject(options)) fail('invalid_options', 'registry options must be an object.');
  for (const key of Object.keys(options)) {
    if (!['executablePaths', 'path', 'probeTimeoutMs'].includes(key)) {
      fail('unsupported_options', `${key} is not a supported registry option.`, key);
    }
  }
  if (options.executablePaths !== undefined) {
    if (!isPlainObject(options.executablePaths)) fail('invalid_options', 'executablePaths must be an object.');
    for (const [key, value] of Object.entries(options.executablePaths)) {
      if (!['grok', 'cursor-agent'].includes(key)) fail('unsupported_options', 'executablePaths contains an unsupported command.', key);
      if (typeof value !== 'string' || !isAbsolute(value)) fail('invalid_options', 'executablePaths values must be absolute paths.', key);
      if (basenameOf(value) !== key) fail('invalid_options', 'executablePaths values must use the canonical executable basename.', key);
    }
  }
  if (options.path !== undefined && (typeof options.path !== 'string' || options.path.length > 8192)) {
    fail('invalid_options', 'path must be a bounded PATH string.', 'path');
  }
  if (options.probeTimeoutMs !== undefined && (!Number.isSafeInteger(options.probeTimeoutMs)
    || options.probeTimeoutMs < ACP_LIMITS.minProbeTimeoutMs
    || options.probeTimeoutMs > ACP_LIMITS.maxProbeTimeoutMs)) {
    fail('invalid_options', `probeTimeoutMs must be from ${ACP_LIMITS.minProbeTimeoutMs} to ${ACP_LIMITS.maxProbeTimeoutMs}.`, 'probeTimeoutMs');
  }
}

function createHandle(registry, config, descriptor) {
  const policy = deriveRolePolicy(config.role);
  const requested = config.profile === 'grok-local-acp' ? config.delegation : null;
  const supported = descriptor.capabilities?.delegation?.supported ?? 'unknown';
  if (requested === true && supported === false) {
    fail('unsupported_capability', 'requested delegation is not supported by the attested provider.', 'delegation');
  }
  const capabilities = makeCapabilities(requested, supported);
  const handleDescriptor = freezeDeep({
    ...clone(descriptor),
    argv: [...descriptor.argv],
    capabilities,
  });
  const handle = {
    profile: config.profile,
    id: config.profile,
    provider: descriptor.provider,
    transport: descriptor.transport,
    executable: descriptor.executable,
    argv: [...descriptor.argv],
    config,
    role: policy.role,
    permission: policy.permission,
    permission_mode: policy.permission_mode,
    write_ceiling: policy.write_ceiling,
    writeCeiling: policy.writeCeiling,
    policy,
    permissions: {
      mode: policy.permission_mode,
      permission: policy.permission,
      write_ceiling: policy.write_ceiling,
    },
    capabilities,
    descriptor: handleDescriptor,
    toPublicSummary() {
      return clone(this.descriptor);
    },
    async spawnSpec() {
      return registry.spawnSpec(config.profile);
    },
  };
  return freezeDeep(handle);
}

/**
 * Create an unwired registry.  The constructor only validates options and
 * stores no provider state; executable probing happens only through probe().
 */
export function createProviderRegistry(options = {}) {
  validateRegistryOptions(options);
  const executablePaths = clone(options.executablePaths ?? {});
  const pathValue = options.path ?? process.env.PATH ?? '';
  const probeTimeoutMs = options.probeTimeoutMs ?? ACP_LIMITS.defaultProbeTimeoutMs;
  const records = new Map();

  const registry = {
    listProfiles() {
      return ACP_PROFILE_IDS.map((id) => publicDescriptor(PROFILE_DEFINITIONS[id]));
    },

    getProfile(profileId) {
      return publicDescriptor(profileDefinition(profileId));
    },

    validateCreate(input, target = undefined) {
      const role = requireAuthoritativeTarget(target);
      const config = normalizeCreateConfig(input, null, role);
      const record = records.get(config.profile);
      const descriptor = record?.descriptor ?? publicDescriptor(PROFILE_DEFINITIONS[config.profile]);
      return createHandle(registry, config, descriptor);
    },

    create(input, target = undefined) {
      return this.validateCreate(input, target);
    },

    createForTarget(input, target) {
      return this.validateCreate(input, target);
    },

    createProfile(profileId, input = {}, target = undefined) {
      const role = requireAuthoritativeTarget(target);
      const config = normalizeProviderCreateConfig(profileId, input, role);
      return this.validateCreate(config, target);
    },

    async probe(profileId) {
      const definition = profileDefinition(profileId);
      assertCleanAmbientEnvironment(process.env);
      // Python is a fixed, attested runtime prerequisite for sealed memfd
      // launching; no PATH lookup or caller-selected interpreter is allowed.
      await inspectExecutable(PYTHON_RUNTIME);
      const candidatePath = await findExecutable(definition, executablePaths, pathValue);
      let attestation = null;
      try {
        attestation = await attestAndStage(definition, candidatePath);
        const environment = cleanProbeEnvironment(process.env);
        const versionResult = await runBoundedProbe(
          attestation.path,
          ['--version'],
          {
            environment,
            timeoutMs: probeTimeoutMs,
            outputLimit: ACP_LIMITS.maxProbeVersionOutputBytes,
            pinnedFd: attestation.fd,
            digest: attestation.digest,
            size: attestation.identity.size,
            providerName: definition.executable,
          },
        );
        attestation = await revalidateExecutable(attestation);
        const versionText = outputText(versionResult);
        const version = parseVersion(versionText, definition);
        const helpResult = await runBoundedProbe(
          attestation.path,
          [...definition.argv, '--help'],
          {
            environment,
            timeoutMs: probeTimeoutMs,
            outputLimit: ACP_LIMITS.maxProbeOutputBytes,
            pinnedFd: attestation.fd,
            digest: attestation.digest,
            size: attestation.identity.size,
            providerName: definition.executable,
          },
        );
        attestation = await revalidateExecutable(attestation);
        const helpText = outputText(helpResult);
        if (helpText.length === 0) fail('invalid_capability', 'help probe returned no capability text.');
        const helpDigest = prefixedDigest(sha256(Buffer.from(helpText, 'utf8')));
        const capabilities = makeCapabilities(null, detectDelegationSupport(helpText));
        const descriptor = publicDescriptor(definition, attestation, version, helpDigest, capabilities);
        const previous = records.get(profileId);
        if (previous?.stageDirectory && previous.stageDirectory !== attestation.stageDirectory) {
          await closeAttestation(previous.attestation);
          await removeStageDirectory(previous.stageDirectory);
        }
        records.set(profileId, {
          path: attestation.path,
          stageDirectory: attestation.stageDirectory,
          attestation,
          descriptor,
        });
        return clone(descriptor);
      } catch (error) {
        if (attestation?.stageDirectory && records.get(profileId)?.stageDirectory !== attestation.stageDirectory) {
          await closeAttestation(attestation);
          await removeStageDirectory(attestation.stageDirectory);
        }
        throw error;
      }
    },

    async probeAll() {
      const result = [];
      for (const profileId of ACP_PROFILE_IDS) {
        // Keep probes sequential so a future worker has one clear attestation
        // record per profile and no provider process overlap.
        // eslint-disable-next-line no-await-in-loop
        result.push(await this.probe(profileId));
      }
      return result;
    },

    probeProfile(profileId) {
      return this.probe(profileId);
    },

    attest(profileId) {
      return this.probe(profileId);
    },

    async revalidate(profileId) {
      const id = requireProfileId(profileId);
      const record = records.get(id);
      if (!record) fail('not_probed', 'profile must be probed before executable revalidation.');
      const attestation = await revalidateExecutable(record.attestation);
      const next = { ...record, attestation };
      records.set(id, next);
      return clone(record.descriptor);
    },

    async spawnSpec(profileId) {
      const id = requireProfileId(profileId);
      const record = records.get(id);
      if (!record) fail('not_probed', 'profile must be probed before obtaining a spawn specification.');
      const attestation = await revalidateExecutable(record.attestation);
      records.set(id, { ...record, attestation });
      return {
        file: PYTHON_RUNTIME,
        argv: [
          '-I', '-S', '-c', PYTHON_LAUNCHER,
          String(attestation.identity.size),
          attestation.digest,
          PROFILE_DEFINITIONS[id].executable,
          ...PROFILE_DEFINITIONS[id].argv,
        ],
        env: cleanProbeEnvironment(process.env),
        shell: false,
        pinned_fd: attestation.fd,
        stdio: ['ignore', 'pipe', 'pipe', attestation.fd],
      };
    },

    publicSummary(profileId) {
      const id = requireProfileId(profileId);
      const record = records.get(id);
      return clone(record?.descriptor ?? publicDescriptor(PROFILE_DEFINITIONS[id]));
    },

    async close() {
      for (const record of records.values()) {
        await closeAttestation(record.attestation);
        if (record.stageDirectory) await removeStageDirectory(record.stageDirectory);
      }
      records.clear();
    },
  };
  return Object.freeze(registry);
}

export const createRegistry = createProviderRegistry;

export async function probeProvider(profileId, options = {}) {
  const registry = createProviderRegistry(options);
  try {
    return await registry.probe(profileId);
  } finally {
    await registry.close();
  }
}

export function publicProfileSummary(profileId, descriptor = null) {
  const definition = profileDefinition(profileId);
  if (!descriptor) return clone(publicDescriptor(definition));
  const result = publicDescriptor(
    definition,
    null,
    descriptor.version ?? null,
    descriptor.help_digest ?? descriptor.helpDigest ?? null,
    sanitizeCapabilities(descriptor.capabilities),
  );
  return clone(result);
}
