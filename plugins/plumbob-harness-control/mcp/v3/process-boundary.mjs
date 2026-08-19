import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile as nodeReadFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * A deliberately small Linux process boundary for local workers.
 *
 * This is not a provider sandbox: the command, environment, working directory,
 * credentials, network, and filesystem capabilities are inherited unchanged.
 * The only extra contract is a systemd user scope with KillMode=control-group,
 * so an owned stop reaches detached descendants as well as the worker leader.
 * The module is provider-free and is not wired into the MCP surface by itself.
 */

export const PROCESS_BOUNDARY_VERSION = 1;
export const PROCESS_BOUNDARY_DEFAULTS = Object.freeze({
  launchTimeoutMs: 3_000,
  stopTimeoutMs: 5_000,
  pollMs: 25,
});

const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const CGROUP_ROOT = '/sys/fs/cgroup';
const UNIT = /^codex-co-engineer-[a-f0-9]{32}\.scope$/u;
const INVOCATION_ID = /^[a-f0-9]{32}$/u;
const CONTROL_GROUP = /^\/user\.slice\/[A-Za-z0-9_.@:/-]+$/u;
const HANDLES = new WeakMap();

const defaultExecFile = promisify(nodeExecFile);

export class ProcessBoundaryError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProcessBoundaryError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ProcessBoundaryError(code, message, options);
}

function defaultAdapter() {
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    spawn: nodeSpawn,
    execFile: defaultExecFile,
    readFile: (file) => nodeReadFile(file, 'utf8'),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

function requireAdapter(adapter) {
  const host = adapter ?? defaultAdapter();
  for (const method of ['spawn', 'execFile', 'readFile', 'sleep']) {
    if (typeof host[method] !== 'function') fail('invalid_adapter', `adapter.${method} is required.`);
  }
  return host;
}

function compact(value, maximum = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function parseProperties(text) {
  const properties = Object.create(null);
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

function requireLinux(host) {
  if (host.platform !== 'linux') fail('linux_required', 'The process boundary requires Linux systemd user scopes.');
  if (!Number.isInteger(host.uid) || host.uid < 0) fail('posix_uid_required', 'The process boundary requires a normal Linux user identity.');
}

function requireCommand(command, field = 'command') {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) {
    fail(`invalid_${field}`, `${field} must be a non-empty string without NUL.`);
  }
  return command;
}

function requireArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    fail('invalid_args', 'args must be an array of strings without NUL.');
  }
  return [...args];
}

function requireCwd(cwd) {
  if (cwd === undefined) return undefined;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd) {
    fail('invalid_cwd', 'cwd must be an absolute, normalized path.');
  }
  return cwd;
}

function requireUnit(unit) {
  if (typeof unit !== 'string' || !UNIT.test(unit)) fail('invalid_unit', 'unit is not an owned Co-Engineer scope name.');
  return unit;
}

function requireDescription(description) {
  if (typeof description !== 'string' || !/^codex-co-engineer-task:[a-f0-9]{32}$/u.test(description)) {
    fail('invalid_description', 'description is not an owned Co-Engineer scope marker.');
  }
  return description;
}

function requireControlGroup(controlGroup) {
  if (typeof controlGroup !== 'string' || !CONTROL_GROUP.test(controlGroup) || controlGroup.includes('..')) {
    fail('invalid_control_group', 'control_group is not a canonical user cgroup path.');
  }
  return controlGroup;
}

function requireInvocationId(invocationId) {
  if (typeof invocationId !== 'string' || !INVOCATION_ID.test(invocationId)) {
    fail('invalid_invocation_id', 'invocation_id is not a systemd generation identifier.');
  }
  return invocationId;
}

function receiptFromRecord(record) {
  return Object.freeze({
    version: PROCESS_BOUNDARY_VERSION,
    boundary: 'systemd-user-scope-cgroup',
    unit: requireUnit(record.unit),
    description: requireDescription(record.description),
    invocation_id: requireInvocationId(record.invocation_id),
    control_group: requireControlGroup(record.control_group),
  });
}

function recordFromHandle(handle, adapter) {
  const record = HANDLES.get(handle);
  if (!record) fail('invalid_handle', 'An owned process-boundary handle is required.');
  if (adapter !== undefined && adapter !== record.host) fail('adapter_mismatch', 'The cleanup adapter must match the launch adapter.');
  return record;
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

async function safeExec(host, executable, args, options = {}) {
  try {
    const result = await host.execFile(executable, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? PROCESS_BOUNDARY_DEFAULTS.launchTimeoutMs,
      maxBuffer: options.maxBuffer ?? 64 * 1024,
    });
    return { ok: true, ...(result ?? {}), stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' };
  } catch (error) {
    return { ok: false, error, stdout: error?.stdout ?? '', stderr: error?.stderr ?? '' };
  }
}

export async function probeProcessBoundary({ adapter } = {}) {
  const host = requireAdapter(adapter);
  if (host.platform !== 'linux') return unavailable('linux_required', 'Use a Linux host with a systemd user manager.');
  if (!Number.isInteger(host.uid) || host.uid < 0) return unavailable('posix_uid_required', 'Run under a normal Linux user identity.');

  let controllers;
  let membership;
  try {
    [controllers, membership] = await Promise.all([
      host.readFile(`${CGROUP_ROOT}/cgroup.controllers`),
      host.readFile('/proc/self/cgroup'),
    ]);
  } catch (error) {
    return unavailable('cgroup_v2_unavailable', `Read unified cgroup v2 metadata (${compact(error.message)}).`);
  }
  if (!/^0::\//mu.test(membership) || !String(controllers).trim()) {
    return unavailable('cgroup_v2_unavailable', 'Use a unified cgroup v2 hierarchy.');
  }

  const manager = await safeExec(host, SYSTEMCTL, [
    '--user', 'show', '--no-pager', '--property=Version', '--property=ControlGroup',
  ]);
  if (!manager.ok) return unavailable('systemd_user_manager_unavailable', `Start a working systemd --user manager (${compact(manager.stderr || manager.error?.message)}).`);
  const properties = parseProperties(manager.stdout);
  if (!properties.Version || !CONTROL_GROUP.test(properties.ControlGroup ?? '')) {
    return unavailable('systemd_user_cgroup_unverifiable', 'The user manager did not expose a canonical user.slice cgroup.');
  }

  const runner = await safeExec(host, SYSTEMD_RUN, ['--version']);
  if (!runner.ok || !/^systemd\s+\d+/mu.test(runner.stdout)) {
    return unavailable('systemd_run_unavailable', `Install a working systemd-run client (${compact(runner.stderr || runner.error?.message)}).`);
  }
  const systemdMajor = Number(/^systemd\s+(\d+)/mu.exec(runner.stdout)?.[1]);
  if (!Number.isInteger(systemdMajor) || systemdMajor < 244) {
    return unavailable('systemd_too_old', 'Use systemd 244 or newer for transient user scopes.');
  }

  return Object.freeze({
    ready: true,
    status: 'prerequisites_ready',
    provider_started: false,
    boundary: 'systemd-user-scope-cgroup',
    manager_version: compact(properties.Version, 80),
    control_group: properties.ControlGroup,
    capabilities: { kill_mode: 'control-group', environment: 'inherited', provider_sandbox: false },
  });
}

export function buildProcessBoundaryArgv({ unit, description, command, args = [], cwd } = {}) {
  requireUnit(unit);
  requireDescription(description);
  requireCommand(command);
  const normalizedArgs = requireArgs(args);
  const workingDirectory = requireCwd(cwd);
  return [
    '--user', '--scope', '--quiet', '--collect', `--unit=${unit}`,
    `--property=Description=${description}`,
    '--property=KillMode=control-group',
    ...(workingDirectory ? [`--working-directory=${workingDirectory}`] : []),
    '--', command, ...normalizedArgs,
  ];
}

function awaitSpawn(child, timeoutMs) {
  if (!child || typeof child.once !== 'function') fail('launch_failed', 'systemd-run did not return a child process handle.');
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off?.('spawn', onSpawn);
      child.off?.('error', onError);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(new ProcessBoundaryError('launch_failed', `systemd-run could not start (${compact(error.message)}).`, { cause: error })); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new ProcessBoundaryError('launch_timeout', 'systemd-run did not start within the bounded deadline.'));
    }, timeoutMs);
  });
}

async function showUnit(host, unit) {
  const result = await safeExec(host, SYSTEMCTL, [
    '--user', 'show', unit, '--no-pager',
    '--property=Id', '--property=Description', '--property=LoadState', '--property=ActiveState',
    '--property=ControlGroup', '--property=KillMode', '--property=InvocationID',
  ]);
  if (!result.ok) {
    const detail = `${result.stderr} ${result.error?.message ?? ''}`;
    if (/not found|could not be found|no such unit/iu.test(detail)) return { found: false, properties: null };
    fail('systemd_inspect_failed', `Cannot inspect owned scope (${compact(detail)}).`, { cause: result.error });
  }
  const properties = parseProperties(result.stdout);
  if (properties.LoadState === 'not-found' || !properties.Id) return { found: false, properties };
  return { found: true, properties };
}

function validateOwnedUnit(receipt, properties) {
  if (properties.Id !== receipt.unit
    || properties.Description !== receipt.description
    || properties.InvocationID !== receipt.invocation_id
    || properties.ControlGroup !== receipt.control_group
    || properties.KillMode !== 'control-group') {
    fail('ownership_mismatch', 'The systemd scope no longer matches its owned generation.');
  }
}

async function cgroupEmpty(host, controlGroup) {
  try {
    const events = await host.readFile(`${CGROUP_ROOT}${controlGroup}/cgroup.events`);
    return /^populated\s+0$/mu.test(events);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw new ProcessBoundaryError('cgroup_inspect_failed', `Cannot inspect the owned cgroup (${compact(error.message)}).`, { cause: error });
  }
}

async function waitForEmpty(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shown = await showUnit(record.host, record.receipt.unit);
    if (!shown.found) return true;
    validateOwnedUnit(record.receipt, shown.properties);
    if (await cgroupEmpty(record.host, record.receipt.control_group)) return true;
    await record.host.sleep(PROCESS_BOUNDARY_DEFAULTS.pollMs);
  }
  return false;
}

async function systemctlAction(host, args, timeoutMs) {
  const result = await safeExec(host, SYSTEMCTL, args, { timeoutMs });
  if (!result.ok) fail('systemd_action_failed', `systemd user action failed (${compact(result.stderr || result.error?.message)}).`, { cause: result.error });
}

async function cleanupUnverifiedLaunch(host, unit, description) {
  try {
    const shown = await showUnit(host, unit);
    if (!shown.found || shown.properties.Id !== unit || shown.properties.Description !== description) return;
    await safeExec(host, SYSTEMCTL, ['--user', 'kill', '--kill-whom=all', '--signal=TERM', unit], {
      timeoutMs: PROCESS_BOUNDARY_DEFAULTS.stopTimeoutMs,
    });
    await host.sleep(PROCESS_BOUNDARY_DEFAULTS.pollMs);
    const afterTerm = await showUnit(host, unit);
    if (afterTerm.found) {
      await safeExec(host, SYSTEMCTL, ['--user', 'kill', '--kill-whom=all', '--signal=KILL', unit], {
        timeoutMs: PROCESS_BOUNDARY_DEFAULTS.stopTimeoutMs,
      });
    }
  } catch {
    // Launch already failed; never replace the original error with cleanup noise.
  }
}

export async function inspectProcessBoundary(handle, { adapter } = {}) {
  const record = recordFromHandle(handle, adapter);
  const shown = await showUnit(record.host, record.receipt.unit);
  if (!shown.found) return Object.freeze({ found: false, empty: true, receipt: record.receipt });
  validateOwnedUnit(record.receipt, shown.properties);
  return Object.freeze({
    found: true,
    empty: await cgroupEmpty(record.host, record.receipt.control_group),
    active_state: shown.properties.ActiveState,
    receipt: record.receipt,
  });
}

export async function stopProcessBoundary(handle, { adapter, timeoutMs = PROCESS_BOUNDARY_DEFAULTS.stopTimeoutMs } = {}) {
  const record = recordFromHandle(handle, adapter);
  if (record.stopped) return Object.freeze({ stopped: true, cgroup_empty: true, idempotent: true });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) fail('invalid_timeout', 'timeoutMs must be at least 100ms.');

  const initial = await showUnit(record.host, record.receipt.unit);
  if (!initial.found) {
    record.stopped = true;
    return Object.freeze({ stopped: true, cgroup_empty: true, idempotent: true });
  }
  validateOwnedUnit(record.receipt, initial.properties);
  await systemctlAction(record.host, ['--user', 'kill', '--kill-whom=all', '--signal=TERM', record.receipt.unit], timeoutMs);
  let empty = await waitForEmpty(record, timeoutMs);
  let forced = false;
  if (!empty) {
    const beforeKill = await showUnit(record.host, record.receipt.unit);
    if (!beforeKill.found) {
      empty = true;
    } else {
      validateOwnedUnit(record.receipt, beforeKill.properties);
      await systemctlAction(record.host, ['--user', 'kill', '--kill-whom=all', '--signal=KILL', record.receipt.unit], timeoutMs);
      forced = true;
      empty = await waitForEmpty(record, timeoutMs);
    }
  }
  if (!empty) fail('cgroup_not_empty', 'Owned systemd scope still has descendants after TERM and KILL.');
  record.stopped = true;
  return Object.freeze({ stopped: true, cgroup_empty: true, forced, idempotent: false });
}

export function restoreProcessBoundary(receipt, { adapter } = {}) {
  if (!receipt || receipt.version !== PROCESS_BOUNDARY_VERSION || receipt.boundary !== 'systemd-user-scope-cgroup') {
    fail('invalid_receipt', 'A process-boundary receipt from this version is required.');
  }
  const normalized = receiptFromRecord(receipt);
  const host = requireAdapter(adapter);
  requireLinux(host);
  const handle = Object.freeze({ kind: 'systemd-user-process-boundary', ...normalized });
  HANDLES.set(handle, { host, receipt: normalized, child: null, stopped: false });
  return handle;
}

export async function launchProcessBoundary({ command, args = [], cwd, env = process.env, stdio = 'pipe', adapter, taskId } = {}) {
  const host = requireAdapter(adapter);
  requireLinux(host);
  requireCommand(command);
  const normalizedArgs = requireArgs(args);
  const workingDirectory = requireCwd(cwd);
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('invalid_env', 'env must be an environment object.');
  if (taskId !== undefined && (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/u.test(taskId))) {
    fail('invalid_task_id', 'taskId must contain only safe task identifier characters.');
  }
  const token = randomUUID().replaceAll('-', '');
  const unit = `codex-co-engineer-${token}.scope`;
  const description = `codex-co-engineer-task:${token}`;
  const child = host.spawn(SYSTEMD_RUN, buildProcessBoundaryArgv({
    unit, description, command, args: normalizedArgs, cwd: workingDirectory,
  }), {
    cwd: workingDirectory,
    env,
    detached: false,
    shell: false,
    stdio,
  });
  try {
    await awaitSpawn(child, PROCESS_BOUNDARY_DEFAULTS.launchTimeoutMs);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const shown = await showUnit(host, unit);
      if (shown.found && shown.properties.Description === description && shown.properties.Id === unit) {
        if (!INVOCATION_ID.test(shown.properties.InvocationID ?? '') || !CONTROL_GROUP.test(shown.properties.ControlGroup ?? '')) {
          await host.sleep(PROCESS_BOUNDARY_DEFAULTS.pollMs);
          continue;
        }
        if (shown.properties.KillMode !== 'control-group') fail('ownership_mismatch', 'The transient scope did not retain KillMode=control-group.');
        const receipt = receiptFromRecord({
          unit,
          description,
          invocation_id: shown.properties.InvocationID,
          control_group: shown.properties.ControlGroup,
        });
        const handle = Object.freeze({ kind: 'systemd-user-process-boundary', ...receipt });
        HANDLES.set(handle, { host, receipt, child, stopped: false });
        return { handle, child, receipt };
      }
      await host.sleep(PROCESS_BOUNDARY_DEFAULTS.pollMs);
    }
  } catch (error) {
    await cleanupUnverifiedLaunch(host, unit, description);
    child.kill?.('SIGTERM');
    throw error;
  }
  await cleanupUnverifiedLaunch(host, unit, description);
  child.kill?.('SIGTERM');
  fail('unit_verification_failed', 'The transient scope could not be verified before its launch deadline.');
}
