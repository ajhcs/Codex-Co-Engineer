/**
 * Provider-free ACP session resource boundary (currently UNWIRED).
 *
 * This module deliberately does not register an MCP tool or start a provider.
 * Activation requires a controlled Linux acceptance test proving the transient
 * user-scope and cgroup-v2 invariants on the actual host.
 */

import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

export const ACP_RESOURCE_BOUNDARY_VERSION = 1;
export const ACP_RESOURCE_LIMITS = Object.freeze({
  memoryMaxBytes: 512 * 1024 * 1024,
  memorySwapMaxBytes: 0,
  tasksMax: 96,
  nodeMaxOldSpaceMiB: 384,
  runtimeDefaultMs: 30 * 60 * 1000,
  runtimeMinimumMs: 1_000,
  runtimeMaximumMs: 2 * 60 * 60 * 1000,
  stopTimeoutMs: 5_000,
  killGraceMs: 1_000,
  probeTimeoutMs: 3_000,
});
export const ACP_RESOURCE_ENV = Object.freeze({
  HOME: '/nonexistent',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/bin:/bin',
  TMPDIR: '/tmp',
});

const WORKERS = new WeakMap();
const PROBES = new WeakMap();
const PREPARED = new WeakMap();
const RUNNING = new WeakMap();
const OWNERS = new WeakMap();
const TRUSTED_STORES = new WeakMap();
const CONSUMED = new WeakSet();
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ARG = /^[\u0020-\u007e]{1,512}$/u;
const UNIT = /^codex-acp-[a-f0-9]{24}\.scope$/u;
const DESCRIPTION = /^codex-acp-session-v1:[a-f0-9]{24}:[a-f0-9]{32}$/u;
const INVOCATION_ID = /^[a-f0-9]{32}$/u;
const OWNERSHIP_ID = /^[a-f0-9]{32}$/u;
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
// Keep the --eval argument comfortably below Linux MAX_ARG_STRLEN.
const MAX_CAPTURED_WORKER_BYTES = 96 * 1024;

export class AcpResourceBoundaryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AcpResourceBoundaryError';
    this.code = code;
    if (details !== null) this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new AcpResourceBoundaryError(code, message, details);
}

function exactObject(value, allowed, required, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('invalid_configuration', `${field} must be a plain object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('unknown_field', `${field}.${key} is not allowed.`);
  }
  for (const key of required) {
    if (!(key in value)) fail('invalid_configuration', `${field}.${key} is required.`);
  }
}

function compact(text, maximum = 240) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function parseProperties(text) {
  const properties = Object.create(null);
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

function unavailable(reason, action) {
  return Object.freeze({
    ready: false,
    status: 'unavailable',
    reason,
    action,
    provider_started: false,
  });
}

function defaultAdapter() {
  const runtimeEnvironment = Object.freeze({
    ...ACP_RESOURCE_ENV,
    XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
  });
  async function run(executable, args, options = {}) {
    return await new Promise((resolve) => {
      const child = spawn(executable, args, {
        cwd: '/', env: runtimeEnvironment, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      const limit = options.maxOutputBytes ?? 32 * 1024;
      const capture = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes <= limit) target.push(Buffer.from(chunk));
      };
      child.stdout.on('data', capture(stdout));
      child.stderr.on('data', capture(stderr));
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? ACP_RESOURCE_LIMITS.probeTimeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ status: null, error, stdout: '', stderr: '' });
      });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
  }
  return Object.freeze({
    platform: process.platform,
    uid: process.getuid?.(),
    readText: (source) => readFile(source, 'utf8'),
    run,
    spawn(executable, args, options) {
      return spawn(executable, args, { ...options, shell: false, windowsHide: true });
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}

function requireAdapter(adapter) {
  const value = adapter ?? defaultAdapter();
  for (const method of ['readText', 'run', 'spawn', 'sleep']) {
    if (typeof value[method] !== 'function') fail('invalid_adapter', `adapter.${method} is required.`);
  }
  return value;
}

export async function probeAcpResourceBoundary({ adapter } = {}) {
  const host = requireAdapter(adapter);
  if (host.platform !== 'linux') {
    return unavailable('linux_required', 'Run ACP sessions on Linux with a cgroup-v2 systemd user manager.');
  }
  if (!Number.isInteger(host.uid) || host.uid < 0) {
    return unavailable('posix_uid_required', 'Run under a normal Linux user identity.');
  }
  let controllers;
  let membership;
  try {
    [controllers, membership] = await Promise.all([
      host.readText('/sys/fs/cgroup/cgroup.controllers'),
      host.readText('/proc/self/cgroup'),
    ]);
  } catch (error) {
    return unavailable('cgroup_v2_unavailable', `Mount cgroup v2 with memory and pids controllers (${compact(error.message)}).`);
  }
  const controllerSet = new Set(controllers.trim().split(/\s+/u));
  if (!controllerSet.has('memory') || !controllerSet.has('pids') || !/^0::\//mu.test(membership)) {
    return unavailable('cgroup_v2_controllers_unavailable', 'Enable unified cgroup v2 memory and pids controllers.');
  }
  const manager = await host.run(SYSTEMCTL, [
    '--user', 'show', '--no-pager',
    '--property=Version', '--property=ControlGroup', '--property=RuntimeDirectory',
  ], { timeoutMs: ACP_RESOURCE_LIMITS.probeTimeoutMs, maxOutputBytes: 16 * 1024 });
  if (manager.status !== 0 || manager.error) {
    return unavailable('systemd_user_manager_unavailable', `Start a working systemd --user manager (${compact(manager.stderr || manager.error?.message)}).`);
  }
  const properties = parseProperties(manager.stdout);
  if (!properties.Version || !properties.ControlGroup?.startsWith('/')) {
    return unavailable('systemd_user_manager_unverifiable', 'The user manager did not return a canonical version and cgroup.');
  }
  if (!properties.ControlGroup.startsWith('/user.slice/')) {
    return unavailable('systemd_user_cgroup_unverifiable', 'The user manager is not attached to a canonical user.slice cgroup.');
  }
  let effectiveControllers;
  try {
    effectiveControllers = await host.readText(`/sys/fs/cgroup${properties.ControlGroup}/cgroup.controllers`);
  } catch (error) {
    return unavailable('user_cgroup_controllers_unverifiable', `Cannot inspect delegated user controllers (${compact(error.message)}).`);
  }
  const effective = new Set(effectiveControllers.trim().split(/\s+/u));
  if (!effective.has('memory') || !effective.has('pids')) {
    return unavailable('user_cgroup_controllers_unavailable', 'Delegate memory and pids controllers to the systemd user manager.');
  }
  const runner = await host.run(SYSTEMD_RUN, ['--version'], {
    timeoutMs: ACP_RESOURCE_LIMITS.probeTimeoutMs, maxOutputBytes: 16 * 1024,
  });
  if (runner.status !== 0 || runner.error || !/^systemd\s+\d+/mu.test(runner.stdout)) {
    return unavailable('systemd_run_unavailable', `Install a matching systemd-run client (${compact(runner.stderr || runner.error?.message)}).`);
  }
  const systemdMajor = Number(/^systemd\s+(\d+)/mu.exec(runner.stdout)?.[1]);
  if (!Number.isInteger(systemdMajor) || systemdMajor < 244) {
    return unavailable('systemd_too_old', 'Install systemd 244 or newer for the required transient-unit controls.');
  }
  const result = Object.freeze({
    ready: true,
    status: 'prerequisites_ready',
    provider_started: false,
    boundary: 'systemd-user-scope-cgroup-v2',
    controlled_acceptance_required: true,
    manager_version: compact(properties.Version, 80),
    limits: ACP_RESOURCE_LIMITS,
  });
  PROBES.set(result, host);
  return result;
}

async function digestFile(source) {
  const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.()
      || (entry.mode & 0o022) !== 0) {
      fail('unsafe_worker', 'Worker must be a current-user-owned, non-writable, single-link regular file.');
    }
    if (entry.size > MAX_CAPTURED_WORKER_BYTES) fail('worker_too_large', 'Captured worker exceeds the fixed 96 KiB bound.');
    const hash = createHash('sha256');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < entry.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, entry.size - position), position);
      if (bytesRead === 0) fail('worker_changed', 'Worker ended before its attested size.');
      hash.update(buffer.subarray(0, bytesRead));
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    let sourceText;
    try {
      sourceText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      fail('invalid_worker', 'Captured worker must be strict UTF-8 module source.');
    }
    return { sha256: hash.digest('hex'), identity: `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}`, sourceText };
  } finally {
    await handle.close();
  }
}

async function executableIdentity(source) {
  const entry = await lstat(source);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o111) === 0 || (entry.mode & 0o022) !== 0) {
    fail('unsafe_worker', 'Node runtime must be a canonical executable not writable by group or others.');
  }
  return `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}`;
}

export async function attestAcpSessionWorker(options) {
  exactObject(options, ['nodePath', 'workerPath', 'workerSha256', 'fixedArgs'],
    ['nodePath', 'workerPath', 'workerSha256', 'fixedArgs'], 'worker');
  if (!SHA256.test(options.workerSha256) || !Array.isArray(options.fixedArgs)
    || options.fixedArgs.length > 16 || !options.fixedArgs.every((arg) => typeof arg === 'string' && SAFE_ARG.test(arg))) {
    fail('invalid_worker', 'Worker digest and fixed arguments are invalid.');
  }
  const [nodePath, workerPath] = await Promise.all([realpath(options.nodePath), realpath(options.workerPath)]);
  for (const [source, field] of [[nodePath, 'nodePath'], [workerPath, 'workerPath']]) {
    if (source !== (field === 'nodePath' ? options.nodePath : options.workerPath)) fail('noncanonical_worker', `${field} must be canonical.`);
    const entry = await lstat(source);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o111) === 0 && field === 'nodePath') {
      fail('invalid_worker', `${field} is not a suitable regular file.`);
    }
  }
  const [attestation, nodeIdentity] = await Promise.all([digestFile(workerPath), executableIdentity(nodePath)]);
  if (attestation.sha256 !== options.workerSha256) fail('worker_digest_mismatch', 'Worker digest does not match the fixed specification.');
  const capability = Object.freeze({ kind: 'acp-worker-capability' });
  WORKERS.set(capability, Object.freeze({
    nodePath, nodeIdentity, workerPath, fixedArgs: Object.freeze([...options.fixedArgs]), ...attestation,
  }));
  return capability;
}

export function createTrustedAcpOwnershipStore(options) {
  exactObject(options, ['save', 'load'], ['save', 'load'], 'ownershipStore');
  if (typeof options.save !== 'function' || typeof options.load !== 'function') {
    fail('invalid_ownership_store', 'Trusted ownership store requires save and load functions.');
  }
  const capability = Object.freeze({ kind: 'trusted-acp-ownership-store' });
  TRUSTED_STORES.set(capability, Object.freeze({ save: options.save, load: options.load }));
  return capability;
}

export function prepareAcpResourceBoundary(options = {}) {
  exactObject(options, ['probe', 'worker', 'runtimeMs', 'ownershipStore'],
    ['probe', 'worker', 'ownershipStore'], 'boundary');
  const { probe, worker, ownershipStore, runtimeMs = ACP_RESOURCE_LIMITS.runtimeDefaultMs } = options;
  if (!PROBES.has(probe)) {
    fail('boundary_unavailable', 'A successful provider-free resource-boundary probe is required.');
  }
  if (!WORKERS.has(worker)) fail('unattested_worker', 'An opaque attested worker capability is required.');
  if (!TRUSTED_STORES.has(ownershipStore)) fail('invalid_ownership_store', 'An opaque trusted durable ownership store is required.');
  if (!Number.isInteger(runtimeMs) || runtimeMs < ACP_RESOURCE_LIMITS.runtimeMinimumMs
    || runtimeMs > ACP_RESOURCE_LIMITS.runtimeMaximumMs) {
    fail('invalid_runtime', 'Runtime deadline is outside the fixed safety envelope.');
  }
  const nonce = randomBytes(12).toString('hex');
  const ownerSecret = randomBytes(32);
  const ownerDigest = createHash('sha256').update(ownerSecret).digest('hex').slice(0, 32);
  const unit = `codex-acp-${nonce}.scope`;
  const description = `codex-acp-session-v1:${nonce}:${ownerDigest}`;
  const host = PROBES.get(probe);
  const owner = Object.freeze({ kind: 'acp-session-owner' });
  const ownershipId = randomBytes(16).toString('hex');
  OWNERS.set(owner, {
    unit, description, host, invocationId: null, controlGroup: null, limitsDigest: null,
    ownerSecret, ownershipId, ownershipStore,
  });
  const prepared = Object.freeze({ kind: 'acp-resource-boundary' });
  PREPARED.set(prepared, Object.freeze({ unit, description, runtimeMs, worker: WORKERS.get(worker), owner, host }));
  return Object.freeze({ prepared, owner });
}

function unitProperties(record) {
  return Object.freeze([
    `Description=${record.description}`,
    `MemoryMax=${ACP_RESOURCE_LIMITS.memoryMaxBytes}`,
    `MemorySwapMax=${ACP_RESOURCE_LIMITS.memorySwapMaxBytes}`,
    `TasksMax=${ACP_RESOURCE_LIMITS.tasksMax}`,
    'KillMode=control-group',
    `TimeoutStopSec=${Math.ceil(ACP_RESOURCE_LIMITS.stopTimeoutMs / 1000)}s`,
    'CollectMode=inactive-or-failed',
    `RuntimeMaxSec=${Math.ceil(record.runtimeMs / 1000)}s`,
  ]);
}

function limitsDigestFor(unit, description) {
  return createHash('sha256').update(JSON.stringify({
    version: ACP_RESOURCE_BOUNDARY_VERSION,
    limits: ACP_RESOURCE_LIMITS,
    unit,
    description,
  })).digest('hex');
}

async function awaitChildSpawn(child, host) {
  if (!child || typeof child.once !== 'function') fail('launch_failed', 'Launcher did not return a child process handle.');
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off?.('spawn', onSpawn);
      child.off?.('error', onError);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(new AcpResourceBoundaryError('launch_failed', `systemd-run could not start (${compact(error.message)}).`)); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new AcpResourceBoundaryError('launch_timeout', 'systemd-run did not start within the bounded deadline.'));
    }, ACP_RESOURCE_LIMITS.probeTimeoutMs);
  });
  let earlyExit = null;
  child.once('exit', (code, signal) => { earlyExit = { code, signal }; });
  return () => earlyExit;
}

async function showUnit(host, unit) {
  const result = await host.run(SYSTEMCTL, [
    '--user', 'show', unit, '--no-pager',
    '--property=Id', '--property=Description', '--property=LoadState', '--property=ActiveState',
    '--property=ControlGroup', '--property=MemoryMax', '--property=MemorySwapMax',
    '--property=TasksMax', '--property=KillMode', '--property=TimeoutStopUSec',
    '--property=CollectMode', '--property=RuntimeMaxUSec', '--property=Delegate',
    '--property=InvocationID',
  ], { timeoutMs: ACP_RESOURCE_LIMITS.probeTimeoutMs, maxOutputBytes: 32 * 1024 });
  return { result, properties: parseProperties(result.stdout) };
}

function validateUnit(record, properties) {
  const expected = {
    Id: record.unit,
    Description: record.description,
    MemoryMax: String(ACP_RESOURCE_LIMITS.memoryMaxBytes),
    MemorySwapMax: '0',
    TasksMax: String(ACP_RESOURCE_LIMITS.tasksMax),
    KillMode: 'control-group',
    CollectMode: 'inactive-or-failed',
    Delegate: 'no',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (properties[key] !== value) fail('spoofed_or_unsafe_unit', `Transient unit ${key} was not the exact requested value.`);
  }
  if (!INVOCATION_ID.test(properties.InvocationID ?? '')) {
    fail('spoofed_or_unsafe_unit', 'Transient unit did not expose a systemd-generated InvocationID.');
  }
  const parseMicros = (value) => {
    const match = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h)?$/u.exec(value ?? '');
    if (!match) return NaN;
    return Number(match[1]) * ({ us: 1, ms: 1_000, s: 1_000_000, min: 60_000_000, h: 3_600_000_000 }[match[2] ?? 'us']);
  };
  if (parseMicros(properties.TimeoutStopUSec) !== ACP_RESOURCE_LIMITS.stopTimeoutMs * 1_000
    || parseMicros(properties.RuntimeMaxUSec) !== Math.ceil(record.runtimeMs / 1000) * 1_000_000) {
    fail('spoofed_or_unsafe_unit', 'Transient unit deadlines were not the exact requested values.');
  }
  if (!properties.ControlGroup?.startsWith('/user.slice/') || properties.ControlGroup.includes('..')) {
    fail('spoofed_or_unsafe_unit', 'Transient unit did not receive an owned user cgroup.');
  }
  if (!['active', 'activating'].includes(properties.ActiveState)) fail('unit_not_active', 'Transient ACP scope is not active.');
}

export async function launchAcpResourceBoundary({ prepared, adapter, stdio = 'pipe' } = {}) {
  const record = PREPARED.get(prepared);
  if (!record) fail('invalid_prepared_state', 'An opaque prepared boundary is required.');
  if (CONSUMED.has(prepared)) fail('prepared_state_consumed', 'Prepared boundary capabilities are single-use.');
  if (!['pipe', 'inherit'].includes(stdio)) fail('invalid_stdio', 'stdio must be pipe or inherit.');
  if (adapter !== undefined && adapter !== record.host) fail('adapter_mismatch', 'The launch adapter must match the probed host capability.');
  const host = record.host;
  CONSUMED.add(prepared);
  const before = await showUnit(host, record.unit);
  if (before.result.status === 0 && before.properties.LoadState !== 'not-found') {
    fail('unit_collision', 'The generated transient scope name is already loaded.');
  }
  const worker = record.worker;
  const currentNodeIdentity = await executableIdentity(worker.nodePath);
  if (currentNodeIdentity !== worker.nodeIdentity) fail('worker_changed', 'Node runtime changed after attestation.');
  const args = [
    '--user', '--scope', '--quiet', '--expand-environment=no', `--unit=${record.unit}`,
    ...unitProperties(record).map((property) => `--property=${property}`),
    '--', worker.nodePath, `--max-old-space-size=${ACP_RESOURCE_LIMITS.nodeMaxOldSpaceMiB}`,
    '--input-type=module', '--eval',
    `import.meta.url=${JSON.stringify(pathToFileURL(worker.workerPath).href)};\n${worker.sourceText}`,
    '--', worker.workerPath, ...worker.fixedArgs,
  ];
  const child = host.spawn(SYSTEMD_RUN, args, {
    cwd: '/', env: Object.freeze({ ...ACP_RESOURCE_ENV, XDG_RUNTIME_DIR: `/run/user/${host.uid}` }),
    detached: false, shell: false, stdio,
  });
  let verified;
  try {
    const getEarlyExit = await awaitChildSpawn(child, host);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const earlyExit = getEarlyExit();
      if (earlyExit) fail('launcher_exited', `systemd-run exited before unit verification (${compact(JSON.stringify(earlyExit))}).`);
      const shown = await showUnit(host, record.unit);
      if (shown.result.status === 0 && shown.properties.LoadState === 'loaded') {
        // systemd can report a newly loaded transient scope before it has
        // assigned the generation marker. Do not treat that short window as
        // a spoofed unit; wait for the marker before validating or mutating
        // the scope. A marker that is present but invalid still fails closed
        // through validateUnit below.
        if (!INVOCATION_ID.test(shown.properties.InvocationID ?? '')) {
          await host.sleep(25);
          continue;
        }
        validateUnit(record, shown.properties);
        verified = shown.properties;
        break;
      }
      await host.sleep(25);
    }
    if (!verified) fail('unit_verification_failed', 'Transient scope could not be verified after launch.');
  } catch (error) {
    child.kill?.('SIGTERM');
    // Never mutate a unit by name until its systemd-generated generation has
    // been verified. RuntimeMaxSec remains the fail-closed orphan bound.
    throw error;
  }
  const handle = Object.freeze({ kind: 'running-acp-resource-boundary' });
  const limitsDigest = limitsDigestFor(record.unit, record.description);
  RUNNING.set(handle, {
    ...record, child, invocationId: verified.InvocationID,
    controlGroup: verified.ControlGroup, limitsDigest, stopped: false, stopPromise: null,
  });
  const ownership = OWNERS.get(record.owner);
  ownership.invocationId = verified.InvocationID;
  ownership.controlGroup = verified.ControlGroup;
  ownership.limitsDigest = limitsDigest;
  const durable = {
    version: ACP_RESOURCE_BOUNDARY_VERSION,
    ownership_id: ownership.ownershipId,
    unit: record.unit,
    description: record.description,
    invocation_id: verified.InvocationID,
    control_group: verified.ControlGroup,
    limits_digest: limitsDigest,
    owner_secret: ownership.ownerSecret.toString('hex'),
  };
  durable.auth_tag = ownershipAuthTag(durable, ownership.ownerSecret);
  try {
    await TRUSTED_STORES.get(ownership.ownershipStore).save(ownership.ownershipId, Object.freeze({ ...durable }));
  } catch (error) {
    await stopAcpResourceBoundary({ handle, adapter: host }).catch(() => {});
    fail('ownership_store_failed', `Trusted ownership receipt could not be persisted (${compact(error.message)}).`);
  }
  return Object.freeze({
    handle,
    receipt: Object.freeze({
      boundary: 'systemd-user-scope-cgroup-v2',
      unit: record.unit,
      limits_digest: limitsDigest,
      limits: ACP_RESOURCE_LIMITS,
      runtime_ms: record.runtimeMs,
      provider_started: true,
      ownership_id: ownership.ownershipId,
    }),
  });
}

async function cgroupEmpty(host, controlGroup) {
  try {
    const events = await host.readText(`/sys/fs/cgroup${controlGroup}/cgroup.events`);
    return /^populated 0$/mu.test(events);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function inspectOwnedGeneration(host, ownership) {
  const shown = await showUnit(host, ownership.unit);
  if (shown.result.status !== 0 || shown.properties.LoadState === 'not-found') {
    return false;
  }
  if (shown.properties.Id !== ownership.unit || shown.properties.Description !== ownership.description
    || shown.properties.InvocationID !== ownership.invocationId
    || shown.properties.ControlGroup !== ownership.controlGroup) {
    fail('ownership_mismatch', 'ACP unit generation changed; refusing to mutate it.');
  }
  return true;
}

export async function stopAcpResourceBoundary({ handle, adapter } = {}) {
  const record = RUNNING.get(handle);
  if (!record) fail('invalid_running_state', 'An opaque running boundary is required.');
  if (record.stopped) return Object.freeze({ stopped: true, cgroup_empty: true, idempotent: true });
  if (record.stopPromise) return await record.stopPromise;
  record.stopPromise = stopRunningBoundary(record, adapter);
  try {
    return await record.stopPromise;
  } finally {
    if (!record.stopped) record.stopPromise = null;
  }
}

async function stopRunningBoundary(record, adapter) {
  if (adapter !== undefined && adapter !== record.host) fail('adapter_mismatch', 'The cleanup adapter must match the launched host capability.');
  const host = record.host;
  const generation = {
    unit: record.unit,
    description: record.description,
    invocationId: record.invocationId,
    controlGroup: record.controlGroup,
  };
  if (!await inspectOwnedGeneration(host, generation)) fail('owned_unit_disappeared', 'Owned ACP unit disappeared before cleanup began.');
  await host.run(SYSTEMCTL, ['--user', 'kill', '--kill-whom=all', '--signal=TERM', record.unit], { timeoutMs: ACP_RESOURCE_LIMITS.killGraceMs });
  if (await inspectOwnedGeneration(host, generation)) {
    await host.run(SYSTEMCTL, ['--user', 'stop', record.unit], { timeoutMs: ACP_RESOURCE_LIMITS.stopTimeoutMs });
  }
  let empty = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await cgroupEmpty(host, record.controlGroup)) { empty = true; break; }
    await host.sleep(25);
  }
  if (!empty) {
    if (!await inspectOwnedGeneration(host, generation)) fail('cgroup_not_empty', 'Unit disappeared while its cgroup remained populated.');
    await host.run(SYSTEMCTL, ['--user', 'kill', '--kill-whom=all', '--signal=KILL', record.unit], { timeoutMs: ACP_RESOURCE_LIMITS.killGraceMs });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await cgroupEmpty(host, record.controlGroup)) { empty = true; break; }
      await host.sleep(25);
    }
  }
  if (!empty) fail('cgroup_not_empty', 'ACP scope still has descendants after TERM, stop, and KILL.');
  record.stopped = true;
  return Object.freeze({ stopped: true, cgroup_empty: true, idempotent: false });
}

export async function reconcileOwnedAcpResourceBoundary({ owner, adapter } = {}) {
  const ownership = OWNERS.get(owner);
  if (!ownership || !UNIT.test(ownership.unit) || !DESCRIPTION.test(ownership.description)) {
    fail('invalid_owner', 'An opaque exact session ownership capability is required.');
  }
  if (!INVOCATION_ID.test(ownership.invocationId ?? '') || !SHA256.test(ownership.limitsDigest ?? '')) {
    fail('invalid_owner', 'Ownership capability has no verified systemd generation receipt.');
  }
  if (adapter !== undefined && adapter !== ownership.host) fail('adapter_mismatch', 'The reconciliation adapter must match the owning host capability.');
  const host = ownership.host;
  const shown = await showUnit(host, ownership.unit);
  if (shown.result.status !== 0 || shown.properties.LoadState === 'not-found') {
    return Object.freeze({ found: false, stopped: false });
  }
  if (shown.properties.Id !== ownership.unit || shown.properties.Description !== ownership.description
    || shown.properties.InvocationID !== ownership.invocationId
    || shown.properties.ControlGroup !== ownership.controlGroup) {
    fail('ownership_mismatch', 'Refusing to reconcile a unit without the exact ownership marker.');
  }
  const controlGroup = shown.properties.ControlGroup;
  if (!controlGroup?.startsWith('/user.slice/') || controlGroup.includes('..')) {
    fail('ownership_mismatch', 'Owned unit did not expose its canonical user cgroup.');
  }
  if (!await inspectOwnedGeneration(host, ownership)) return Object.freeze({ found: false, stopped: false });
  await host.run(SYSTEMCTL, ['--user', 'kill', '--kill-whom=all', '--signal=TERM', ownership.unit], { timeoutMs: ACP_RESOURCE_LIMITS.killGraceMs });
  if (await inspectOwnedGeneration(host, ownership)) {
    await host.run(SYSTEMCTL, ['--user', 'stop', ownership.unit], { timeoutMs: ACP_RESOURCE_LIMITS.stopTimeoutMs });
  }
  if (!await cgroupEmpty(host, controlGroup)) {
    if (!await inspectOwnedGeneration(host, ownership)) fail('cgroup_not_empty', 'Owned unit disappeared while its cgroup remained populated.');
    await host.run(SYSTEMCTL, ['--user', 'kill', '--kill-whom=all', '--signal=KILL', ownership.unit], { timeoutMs: ACP_RESOURCE_LIMITS.killGraceMs });
  }
  let empty = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await cgroupEmpty(host, controlGroup)) { empty = true; break; }
    await host.sleep(25);
  }
  if (!empty) fail('cgroup_not_empty', 'Stale owned ACP scope still has descendants after forced cleanup.');
  return Object.freeze({ found: true, stopped: true });
}

function ownershipAuthTag(receipt, secret) {
  return createHmac('sha256', secret).update(JSON.stringify({
    version: receipt.version,
    ownership_id: receipt.ownership_id,
    unit: receipt.unit,
    description: receipt.description,
    invocation_id: receipt.invocation_id,
    control_group: receipt.control_group,
    limits_digest: receipt.limits_digest,
  })).digest('hex');
}

export async function restoreAcpResourceBoundaryOwner(options = {}) {
  exactObject(options, ['probe', 'ownershipId', 'ownershipStore'],
    ['probe', 'ownershipId', 'ownershipStore'], 'restore');
  const { probe, ownershipId, ownershipStore } = options;
  if (!PROBES.has(probe)) fail('boundary_unavailable', 'A fresh provider-free boundary probe is required for restart reconciliation.');
  if (!OWNERSHIP_ID.test(ownershipId ?? '') || !TRUSTED_STORES.has(ownershipStore)) {
    fail('invalid_owner', 'An opaque ownership id and trusted store capability are required.');
  }
  const receipt = await TRUSTED_STORES.get(ownershipStore).load(ownershipId);
  exactObject(receipt,
    ['version', 'ownership_id', 'unit', 'description', 'invocation_id', 'control_group', 'limits_digest', 'owner_secret', 'auth_tag'],
    ['version', 'ownership_id', 'unit', 'description', 'invocation_id', 'control_group', 'limits_digest', 'owner_secret', 'auth_tag'], 'receipt');
  const secret = Buffer.from(typeof receipt.owner_secret === 'string' ? receipt.owner_secret : '', 'hex');
  const descriptionSecretHash = createHash('sha256').update(secret).digest('hex').slice(0, 32);
  if (receipt.version !== ACP_RESOURCE_BOUNDARY_VERSION || receipt.ownership_id !== ownershipId
    || !UNIT.test(receipt.unit)
    || !DESCRIPTION.test(receipt.description) || !INVOCATION_ID.test(receipt.invocation_id)
    || typeof receipt.control_group !== 'string' || !receipt.control_group.startsWith('/user.slice/')
    || receipt.control_group.includes('..') || receipt.limits_digest !== limitsDigestFor(receipt.unit, receipt.description)
    || secret.length !== 32 || !receipt.description.endsWith(`:${descriptionSecretHash}`)
    || receipt.auth_tag !== ownershipAuthTag(receipt, secret)) {
    fail('invalid_receipt', 'Durable ownership receipt does not match the exact boundary contract.');
  }
  const owner = Object.freeze({ kind: 'restored-acp-session-owner' });
  OWNERS.set(owner, {
    unit: receipt.unit,
    description: receipt.description,
    invocationId: receipt.invocation_id,
    controlGroup: receipt.control_group,
    limitsDigest: receipt.limits_digest,
    ownerSecret: secret,
    ownershipId,
    ownershipStore,
    host: PROBES.get(probe),
  });
  return owner;
}
