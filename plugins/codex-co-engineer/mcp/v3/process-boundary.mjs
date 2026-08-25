import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile as nodeReadFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  cleanupCredentialHandoff,
  createCredentialHandoff,
  extractCredentialEnv,
  handoffPathFromProcessIdentity,
  isCredentialEnvKey,
  isForbiddenProviderEnvKey,
  omitCredentialEnv,
  systemdClientEnvironment,
} from './credential-boundary.mjs';

/**
 * A deliberately small Linux process boundary for local workers.
 *
 * This is not a provider sandbox: the command, working directory, network,
 * and filesystem capabilities are inherited unchanged. Environment is a
 * closed projection supplied by the caller. systemd-run `--setenv` is
 * additive to the user-manager block, so the unit also UnsetEnvironment's
 * inherited names that are not in the projection and exec's through
 * `env -i` of that same allowlist. Credential values never appear in
 * systemd-run argv; they use an owner-only no-follow regular-file handoff
 * consumed by credential-handoff-loader.mjs, which is always the service
 * command so Cursor Local is never the manager-inherited leader. The extra
 * lifecycle contract is a manager-owned systemd user service with
 * KillMode=control-group, so an owned stop reaches detached descendants as
 * well as the worker leader and the worker survives the launching client.
 * The module is not wired into the MCP surface by itself.
 */

const CREDENTIAL_HANDOFF_LOADER = fileURLToPath(new URL('./credential-handoff-loader.mjs', import.meta.url));

export const PROCESS_BOUNDARY_VERSION = 1;
export const PROCESS_BOUNDARY_DEFAULTS = Object.freeze({
  launchTimeoutMs: 3_000,
  stopTimeoutMs: 5_000,
  pollMs: 25,
});
export const PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS = Object.freeze({
  natural_boundary_and_lock_drain: 2_000,
  exact_unit_stop_and_empty_proof: 5_000,
  cgroup_poll_interval: 25,
});
export const PROCESS_BOUNDARY_STATES = Object.freeze(['inactive_empty', 'active', 'unknown']);

const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const ENV_RESET = '/usr/bin/env';
const CGROUP_ROOT = '/sys/fs/cgroup';
const UNIT = /^codex-co-engineer-[a-f0-9]{32}\.(?:service|scope)$/u;
const SERVICE_UNIT = /^codex-co-engineer-[a-f0-9]{32}\.service$/u;
const SCOPE_UNIT = /^codex-co-engineer-[a-f0-9]{32}\.scope$/u;
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
  if (host.platform !== 'linux') fail('linux_required', 'The process boundary requires Linux systemd user services.');
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
  if (typeof unit !== 'string' || !UNIT.test(unit)) fail('invalid_unit', 'unit is not an owned Co-Engineer process-boundary name.');
  return unit;
}

function requireServiceUnit(unit) {
  if (typeof unit !== 'string' || !SERVICE_UNIT.test(unit)) fail('invalid_unit', 'unit is not an owned Co-Engineer service name.');
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

function requireLogPath(logPath) {
  if (logPath === undefined) return undefined;
  if (typeof logPath !== 'string' || !path.isAbsolute(logPath) || path.resolve(logPath) !== logPath || logPath.includes('\0')) {
    fail('invalid_log_path', 'logPath must be an absolute, normalized path without NUL.');
  }
  return logPath;
}

function requireEnvironment(env, { includeCredentials = false } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('invalid_env', 'env must be an environment object.');
  return Object.entries(env).flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== 'string' || value.includes('\0')) {
      fail('invalid_env', 'env must contain POSIX variable names and NUL-free string values.');
    }
    if (!includeCredentials && isCredentialEnvKey(name)) return [];
    return [`--setenv=${name}=${value}`];
  });
}

function closedEnvAssignments(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('invalid_env', 'env must be an environment object.');
  return Object.entries(env).flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== 'string' || value.includes('\0')) {
      fail('invalid_env', 'env must contain POSIX variable names and NUL-free string values.');
    }
    if (isCredentialEnvKey(name)) return [];
    return [`${name}=${value}`];
  });
}

function inheritedUnsetNames(publicEnv, inherited) {
  if (inherited == null) return [];
  if (typeof inherited !== 'object' || Array.isArray(inherited)) fail('invalid_env', 'inherited must be an environment object.');
  const assigned = new Set();
  for (const name of Object.keys(publicEnv ?? {})) {
    if (isCredentialEnvKey(name)) continue;
    assigned.add(name);
  }
  const names = [];
  for (const name of Object.keys(inherited)) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    if (assigned.has(name)) continue;
    names.push(name);
  }
  return names.sort();
}

function receiptFromRecord(record, boundary = 'systemd-user-service-cgroup') {
  const unit = requireUnit(record.unit);
  if ((boundary === 'systemd-user-service-cgroup' && !SERVICE_UNIT.test(unit))
    || (boundary === 'systemd-user-scope-cgroup' && !SCOPE_UNIT.test(unit))) {
    fail('invalid_unit', 'unit type does not match the process-boundary receipt.');
  }
  return Object.freeze({
    version: PROCESS_BOUNDARY_VERSION,
    boundary,
    unit,
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
    return unavailable('systemd_too_old', 'Use systemd 244 or newer for transient user services.');
  }

  return Object.freeze({
    ready: true,
    status: 'prerequisites_ready',
    provider_started: false,
    boundary: 'systemd-user-service-cgroup',
    manager_version: compact(properties.Version, 80),
    control_group: properties.ControlGroup,
    capabilities: { kill_mode: 'control-group', environment: 'closed_projection', provider_sandbox: false, manager_owned: true },
  });
}

export function buildProcessBoundaryArgv({ unit, description, command, args = [], cwd, env = {}, logPath, inherited } = {}) {
  requireServiceUnit(unit);
  requireDescription(description);
  requireCommand(command);
  const normalizedArgs = requireArgs(args);
  const workingDirectory = requireCwd(cwd);
  const outputPath = requireLogPath(logPath);
  const publicAssignments = closedEnvAssignments(env);
  const unset = inheritedUnsetNames(env, inherited);
  return [
    '--user', '--quiet', '--collect', '--no-block', '--service-type=exec', `--unit=${unit}`,
    `--property=Description=${description}`,
    '--property=KillMode=control-group',
    ...(unset.length > 0 ? [`--property=UnsetEnvironment=${unset.join(' ')}`] : []),
    ...(workingDirectory ? [`--working-directory=${workingDirectory}`] : []),
    ...(outputPath ? [`--property=StandardOutput=append:${outputPath}`, `--property=StandardError=append:${outputPath}`] : []),
    ...requireEnvironment(env),
    '--', ENV_RESET, '-i', ...publicAssignments, command, ...normalizedArgs,
  ];
}

function awaitLauncherResult(child, timeoutMs) {
  if (!child || typeof child.once !== 'function') fail('launch_failed', 'systemd-run did not return a child process handle.');
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off?.('spawn', onSpawn);
      child.off?.('error', onError);
      child.off?.('exit', onExit);
    };
    const onSpawn = () => {};
    const onError = (error) => { cleanup(); reject(new ProcessBoundaryError('launch_failed', `systemd-run could not start (${compact(error.message)}).`, { cause: error })); };
    const onExit = (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new ProcessBoundaryError(
        'systemd_run_failed',
        `systemd-run did not queue the transient service (${code === null ? `signal ${compact(signal)}` : `exit ${code}`}).`,
      ));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null) queueMicrotask(() => onExit(child.exitCode, child.signalCode));
    timer = setTimeout(() => {
      cleanup();
      reject(new ProcessBoundaryError('launch_timeout', 'systemd-run did not queue the transient service within the bounded deadline.'));
    }, timeoutMs);
  });
}

async function showUnit(host, unit) {
  const result = await safeExec(host, SYSTEMCTL, [
    '--user', 'show', unit, '--no-pager',
    '--property=Id', '--property=Description', '--property=LoadState', '--property=ActiveState',
    '--property=ControlGroup', '--property=KillMode', '--property=InvocationID', '--property=MainPID',
  ]);
  if (!result.ok) {
    const detail = `${result.stderr} ${result.error?.message ?? ''}`;
    if (/not found|could not be found|no such unit/iu.test(detail)) return { found: false, properties: null };
    fail('systemd_inspect_failed', `Cannot inspect owned process boundary (${compact(detail)}).`, { cause: result.error });
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
    fail('ownership_mismatch', 'The systemd process boundary no longer matches its owned generation.');
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

async function cleanupUnverifiedLaunch(host, unit, description, handoffPath) {
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
  if (handoffPath) await cleanupCredentialHandoff(handoffPath).catch(() => {});
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
  if (record.handoffPath) await cleanupCredentialHandoff(record.handoffPath).catch(() => {});
  record.handoffPath = undefined;

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
  if (!empty) fail('cgroup_not_empty', 'Owned systemd process boundary still has descendants after TERM and KILL.');
  record.stopped = true;
  return Object.freeze({ stopped: true, cgroup_empty: true, forced, idempotent: false });
}

export function restoreProcessBoundary(receipt, { adapter } = {}) {
  const legacyScope = receipt?.version === PROCESS_BOUNDARY_VERSION && receipt?.boundary === 'systemd-user-scope-cgroup';
  const managerService = receipt?.version === PROCESS_BOUNDARY_VERSION && receipt?.boundary === 'systemd-user-service-cgroup';
  if (!legacyScope && !managerService) {
    fail('invalid_receipt', 'A process-boundary receipt from this version is required.');
  }
  const normalized = receiptFromRecord(receipt, legacyScope ? 'systemd-user-scope-cgroup' : 'systemd-user-service-cgroup');
  const host = requireAdapter(adapter);
  requireLinux(host);
  const handle = Object.freeze({ kind: 'systemd-user-process-boundary', ...normalized });
  const identity = /^codex-co-engineer-([a-f0-9]{32})\./u.exec(normalized.unit)?.[1];
  let handoffPath;
  try {
    handoffPath = identity ? handoffPathFromProcessIdentity(identity) : undefined;
  } catch {
    handoffPath = undefined;
  }
  HANDLES.set(handle, { host, receipt: normalized, child: null, stopped: false, handoffPath });
  return handle;
}

export async function launchProcessBoundary({ command, args = [], cwd, env = process.env, stdio = 'pipe', logPath, adapter, taskId } = {}) {
  const host = requireAdapter(adapter);
  requireLinux(host);
  requireCommand(command);
  const normalizedArgs = requireArgs(args);
  const workingDirectory = requireCwd(cwd);
  requireEnvironment(env);
  const outputPath = requireLogPath(logPath);
  if (taskId !== undefined && (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/u.test(taskId))) {
    fail('invalid_task_id', 'taskId must contain only safe task identifier characters.');
  }
  const secrets = extractCredentialEnv(env);
  const publicEnv = omitCredentialEnv(env);
  for (const key of Object.keys(publicEnv)) {
    if (isForbiddenProviderEnvKey(key)) delete publicEnv[key];
  }
  requireEnvironment(publicEnv);
  const token = randomUUID().replaceAll('-', '');
  const unit = `codex-co-engineer-${token}.service`;
  const description = `codex-co-engineer-task:${token}`;
  const handoff = await createCredentialHandoff(secrets, { identity: token });
  const handoffPath = handoff.path;
  const serviceCommand = process.execPath;
  const serviceArgs = [CREDENTIAL_HANDOFF_LOADER, handoff.path, '--', command, ...normalizedArgs];
  const child = host.spawn(SYSTEMD_RUN, buildProcessBoundaryArgv({
    unit, description, command: serviceCommand, args: serviceArgs, cwd: workingDirectory, env: publicEnv, logPath: outputPath,
    inherited: process.env,
  }), {
    cwd: workingDirectory,
    // Credential values live in the owner-only handoff file, not in
    // systemd-run argv. The short-lived client receives only D-Bus session
    // keys so a minimal provider environment cannot hide the user manager.
    env: systemdClientEnvironment(process.env),
    detached: false,
    shell: false,
    stdio,
  });
  try {
    await awaitLauncherResult(child, PROCESS_BOUNDARY_DEFAULTS.launchTimeoutMs);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const shown = await showUnit(host, unit);
      if (shown.found && shown.properties.Description === description && shown.properties.Id === unit) {
        if (!INVOCATION_ID.test(shown.properties.InvocationID ?? '') || !CONTROL_GROUP.test(shown.properties.ControlGroup ?? '')) {
          await host.sleep(PROCESS_BOUNDARY_DEFAULTS.pollMs);
          continue;
        }
        if (shown.properties.KillMode !== 'control-group') fail('ownership_mismatch', 'The transient service did not retain KillMode=control-group.');
        const mainPid = Number(shown.properties.MainPID);
        if (!Number.isSafeInteger(mainPid) || mainPid < 2) {
          await host.sleep(PROCESS_BOUNDARY_DEFAULTS.pollMs);
          continue;
        }
        const receipt = receiptFromRecord({
          unit,
          description,
          invocation_id: shown.properties.InvocationID,
          control_group: shown.properties.ControlGroup,
        });
        const worker = Object.freeze({ pid: mainPid, unref() {} });
        const handle = Object.freeze({ kind: 'systemd-user-process-boundary', ...receipt });
        HANDLES.set(handle, { host, receipt, child: worker, launcher: child, stopped: false, handoffPath });
        return { handle, child: worker, receipt };
      }
      await host.sleep(PROCESS_BOUNDARY_DEFAULTS.pollMs);
    }
  } catch (error) {
    await cleanupUnverifiedLaunch(host, unit, description, handoffPath);
    child.kill?.('SIGTERM');
    throw error;
  }
  await cleanupUnverifiedLaunch(host, unit, description, handoffPath);
  child.kill?.('SIGTERM');
  fail('unit_verification_failed', 'The transient service could not be verified before its launch deadline.');
}

const ACTIVE_UNIT_STATES = new Set(['active', 'activating', 'deactivating']);
const INACTIVE_UNIT_STATES = new Set(['inactive', 'failed']);

function freezeBoundaryInspection(inspection) {
  return Object.freeze({
    state: inspection.state,
    found: inspection.found === true,
    empty: inspection.empty ?? null,
    active_state: inspection.active_state ?? null,
    main_pid: inspection.main_pid ?? null,
    populated: inspection.populated ?? null,
    members: Object.freeze([...(inspection.members ?? [])]),
    identity_matched: inspection.identity_matched === true,
    visibility: inspection.visibility ?? 'unknown',
    stop_allowed: inspection.stop_allowed === true,
    code: inspection.code ?? null,
    receipt: inspection.receipt,
  });
}

function parsePopulated(events) {
  const matches = [...String(events ?? '').matchAll(/^populated\s+(\d+)\s*$/gmu)];
  if (matches.length !== 1) return { ok: false, populated: null };
  const value = Number(matches[0][1]);
  if (value !== 0 && value !== 1) return { ok: false, populated: null };
  return { ok: true, populated: value === 1 };
}

function parseProcStat(text) {
  const raw = String(text ?? '');
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  const ppid = Number(fields[1]);
  const startTicks = fields[19];
  if (!Number.isInteger(ppid) || ppid < 0 || !startTicks) return null;
  return { ppid, start_ticks: startTicks };
}

function parseProcCgroup(text) {
  const match = /^0::(\/.*)$/mu.exec(String(text ?? ''));
  return match ? match[1] : null;
}

function parseCgroupProcs(text) {
  const pids = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!/^[0-9]+$/u.test(trimmed)) return null;
    const pid = Number(trimmed);
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    pids.push(pid);
  }
  return pids;
}

function omittedIdentityProperties(properties, { requireControlGroup }) {
  if (!properties || typeof properties !== 'object') return true;
  for (const key of ['Id', 'Description', 'LoadState', 'ActiveState', 'KillMode', 'InvocationID']) {
    if (typeof properties[key] !== 'string' || properties[key].length === 0) return true;
  }
  if (requireControlGroup && (typeof properties.ControlGroup !== 'string' || properties.ControlGroup.length === 0)) {
    return true;
  }
  return false;
}

function generationMatches(receipt, properties, { requireControlGroup }) {
  if (properties.Id !== receipt.unit) return false;
  if (properties.Description !== receipt.description) return false;
  if (properties.InvocationID !== receipt.invocation_id) return false;
  if (properties.KillMode !== 'control-group') return false;
  if (requireControlGroup && properties.ControlGroup !== receipt.control_group) return false;
  if (!requireControlGroup && properties.ControlGroup && properties.ControlGroup !== receipt.control_group) return false;
  return true;
}

async function inspectCgroupPath(host, controlGroup) {
  const eventsPath = `${CGROUP_ROOT}${controlGroup}/cgroup.events`;
  const procsPath = `${CGROUP_ROOT}${controlGroup}/cgroup.procs`;
  let events;
  try {
    events = await host.readFile(eventsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, populated: false, members: [], visibility: 'complete' };
    return { present: true, populated: null, members: null, visibility: 'unknown', code: 'worker_boundary_inspect_failed' };
  }
  const parsed = parsePopulated(events);
  if (!parsed.ok) {
    return { present: true, populated: null, members: null, visibility: 'unknown', code: 'worker_boundary_inspect_failed' };
  }
  let procsText;
  try {
    procsText = await host.readFile(procsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return parsed.populated
        ? { present: true, populated: true, members: null, visibility: 'unknown', code: 'worker_boundary_membership_unknown' }
        : { present: false, populated: false, members: [], visibility: 'complete' };
    }
    return { present: true, populated: parsed.populated, members: null, visibility: 'unknown', code: 'worker_boundary_membership_unknown' };
  }
  const members = parseCgroupProcs(procsText);
  if (members == null) {
    return { present: true, populated: parsed.populated, members: null, visibility: 'unknown', code: 'worker_boundary_membership_unknown' };
  }
  if (parsed.populated && members.length === 0) {
    return { present: true, populated: true, members: null, visibility: 'unknown', code: 'worker_boundary_membership_unknown' };
  }
  if (!parsed.populated && members.length > 0) {
    return { present: true, populated: null, members, visibility: 'unknown', code: 'worker_boundary_inspect_failed' };
  }
  return { present: true, populated: parsed.populated, members, visibility: 'complete' };
}

async function inspectProcMember(host, pid, controlGroup) {
  try {
    const [statText, cgroupText] = await Promise.all([
      host.readFile(`/proc/${pid}/stat`),
      host.readFile(`/proc/${pid}/cgroup`),
    ]);
    const parsed = parseProcStat(statText);
    const cgroup = parseProcCgroup(cgroupText);
    if (!parsed || !cgroup) {
      return { pid, visible: false, unknown: true, code: 'worker_boundary_pid_visibility_unknown' };
    }
    if (cgroup !== controlGroup) {
      return { pid, visible: true, unknown: false, identity_mismatch: true, start_ticks: parsed.start_ticks, ppid: parsed.ppid, cgroup };
    }
    return { pid, visible: true, unknown: false, start_ticks: parsed.start_ticks, ppid: parsed.ppid, cgroup };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
      return { pid, visible: false, missing: true };
    }
    return { pid, visible: false, unknown: true, code: 'worker_boundary_pid_visibility_unknown' };
  }
}

function leaderFromRuntime(expectedLeader) {
  if (!expectedLeader || typeof expectedLeader !== 'object' || Array.isArray(expectedLeader)) return null;
  const pid = Number(expectedLeader.pid);
  const ticks = expectedLeader.process_start_ticks;
  if (!Number.isSafeInteger(pid) || pid < 2 || typeof ticks !== 'string' || ticks.length === 0) return null;
  return { pid, process_start_ticks: ticks };
}

function membersRootedInLeader(members, leaderPid) {
  const byPid = new Map(members.map((member) => [member.pid, member]));
  for (const member of members) {
    if (member.pid === leaderPid) continue;
    const seen = new Set();
    let current = member;
    let rooted = false;
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (current.pid === leaderPid) {
        rooted = true;
        break;
      }
      const parent = byPid.get(current.ppid);
      if (!parent) {
        // Reparented descendants remain task-owned when they still sit in the
        // exact cgroup; they are not proof of a foreign identity.
        rooted = true;
        break;
      }
      current = parent;
    }
    if (!rooted) return false;
  }
  return true;
}

export async function inspectExactProcessBoundary(receipt, { adapter, expectedLeader } = {}) {
  const host = requireAdapter(adapter);
  let normalized;
  try {
    requireLinux(host);
    const legacyScope = receipt?.boundary === 'systemd-user-scope-cgroup';
    normalized = receiptFromRecord(receipt, legacyScope ? 'systemd-user-scope-cgroup' : 'systemd-user-service-cgroup');
  } catch (error) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: false,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: error?.code === 'linux_required' || error?.code === 'posix_uid_required'
        ? 'worker_boundary_inspect_failed'
        : (error?.code ?? 'invalid_receipt'),
      receipt,
    });
  }

  let shown;
  try {
    shown = await showUnit(host, normalized.unit);
  } catch {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: false,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_inspect_failed',
      receipt: normalized,
    });
  }

  const cgroup = await inspectCgroupPath(host, normalized.control_group);
  if (cgroup.visibility === 'unknown') {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: shown.found,
      empty: null,
      active_state: shown.properties?.ActiveState ?? null,
      populated: cgroup.populated,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: cgroup.code ?? 'worker_boundary_inspect_failed',
      receipt: normalized,
    });
  }

  if (!shown.found) {
    if (!cgroup.present && cgroup.populated === false) {
      return freezeBoundaryInspection({
        state: 'inactive_empty',
        found: false,
        empty: true,
        populated: false,
        members: [],
        identity_matched: true,
        visibility: 'complete',
        stop_allowed: false,
        receipt: normalized,
      });
    }
    return freezeBoundaryInspection({
      state: 'unknown',
      found: false,
      empty: false,
      populated: cgroup.populated,
      members: cgroup.members ?? [],
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_inspect_failed',
      receipt: normalized,
    });
  }

  const activeState = shown.properties.ActiveState;
  const live = ACTIVE_UNIT_STATES.has(activeState);
  const idle = INACTIVE_UNIT_STATES.has(activeState);
  if (!live && !idle) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      active_state: activeState,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_inspect_failed',
      receipt: normalized,
    });
  }
  if (omittedIdentityProperties(shown.properties, { requireControlGroup: live })) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      active_state: activeState,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_identity_mismatch',
      receipt: normalized,
    });
  }
  if (!generationMatches(normalized, shown.properties, { requireControlGroup: live })) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      active_state: activeState,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_identity_mismatch',
      receipt: normalized,
    });
  }

  if (idle) {
    if (cgroup.present && cgroup.populated) {
      return freezeBoundaryInspection({
        state: 'unknown',
        found: true,
        empty: false,
        active_state: activeState,
        populated: true,
        identity_matched: true,
        visibility: 'unknown',
        stop_allowed: false,
        code: 'worker_boundary_not_empty',
        receipt: normalized,
      });
    }
    return freezeBoundaryInspection({
      state: 'inactive_empty',
      found: true,
      empty: true,
      active_state: activeState,
      main_pid: Number(shown.properties.MainPID) || 0,
      populated: false,
      members: [],
      identity_matched: true,
      visibility: 'complete',
      stop_allowed: false,
      receipt: normalized,
    });
  }

  if (!cgroup.populated) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      empty: true,
      active_state: activeState,
      populated: false,
      identity_matched: true,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_inspect_failed',
      receipt: normalized,
    });
  }

  const leader = leaderFromRuntime(expectedLeader);
  const mainPid = Number(shown.properties.MainPID);
  if (!leader || !Number.isSafeInteger(mainPid) || mainPid < 2 || mainPid !== leader.pid) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      empty: false,
      active_state: activeState,
      main_pid: Number.isSafeInteger(mainPid) ? mainPid : null,
      populated: true,
      members: cgroup.members,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: leader && Number.isSafeInteger(mainPid) && mainPid >= 2 && mainPid !== leader.pid
        ? 'worker_boundary_identity_mismatch'
        : 'worker_boundary_pid_visibility_unknown',
      receipt: normalized,
    });
  }
  if (!Array.isArray(cgroup.members) || !cgroup.members.includes(leader.pid)) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      empty: false,
      active_state: activeState,
      main_pid: mainPid,
      populated: true,
      members: cgroup.members,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_membership_unknown',
      receipt: normalized,
    });
  }

  const inspectedMembers = [];
  for (const pid of cgroup.members) {
    const member = await inspectProcMember(host, pid, normalized.control_group);
    if (member.unknown || member.missing) {
      return freezeBoundaryInspection({
        state: 'unknown',
        found: true,
        empty: false,
        active_state: activeState,
        main_pid: mainPid,
        populated: true,
        members: cgroup.members,
        identity_matched: false,
        visibility: 'unknown',
        stop_allowed: false,
        code: member.code ?? 'worker_boundary_pid_visibility_unknown',
        receipt: normalized,
      });
    }
    if (member.identity_mismatch) {
      return freezeBoundaryInspection({
        state: 'unknown',
        found: true,
        empty: false,
        active_state: activeState,
        main_pid: mainPid,
        populated: true,
        members: cgroup.members,
        identity_matched: false,
        visibility: 'unknown',
        stop_allowed: false,
        code: 'worker_boundary_identity_mismatch',
        receipt: normalized,
      });
    }
    inspectedMembers.push(member);
  }

  const leaderMember = inspectedMembers.find((member) => member.pid === leader.pid);
  if (!leaderMember || leaderMember.start_ticks !== leader.process_start_ticks) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      empty: false,
      active_state: activeState,
      main_pid: mainPid,
      populated: true,
      members: cgroup.members,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_identity_mismatch',
      receipt: normalized,
    });
  }
  if (!membersRootedInLeader(inspectedMembers, leader.pid)) {
    return freezeBoundaryInspection({
      state: 'unknown',
      found: true,
      empty: false,
      active_state: activeState,
      main_pid: mainPid,
      populated: true,
      members: cgroup.members,
      identity_matched: false,
      visibility: 'unknown',
      stop_allowed: false,
      code: 'worker_boundary_identity_mismatch',
      receipt: normalized,
    });
  }

  return freezeBoundaryInspection({
    state: 'active',
    found: true,
    empty: false,
    active_state: activeState,
    main_pid: mainPid,
    populated: true,
    members: cgroup.members,
    identity_matched: true,
    visibility: 'complete',
    stop_allowed: true,
    receipt: normalized,
  });
}

export async function stopExactProcessBoundary(receipt, {
  adapter,
  expectedLeader,
  timeoutMs = PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS.exact_unit_stop_and_empty_proof,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) fail('invalid_timeout', 'timeoutMs must be at least 100ms.');
  const host = requireAdapter(adapter);
  const initial = await inspectExactProcessBoundary(receipt, { adapter: host, expectedLeader });
  if (initial.state === 'inactive_empty') {
    return Object.freeze({
      stopped: true,
      cgroup_empty: true,
      state: 'inactive_empty',
      forced: false,
      idempotent: true,
    });
  }
  if (initial.state !== 'active' || initial.stop_allowed !== true) {
    fail(initial.code ?? 'worker_boundary_inspect_failed', 'Exact process-boundary stop is refused without complete task-owned identity.');
  }
  await systemctlAction(host, ['--user', 'stop', initial.receipt.unit], timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let latest = initial;
  while (Date.now() < deadline) {
    latest = await inspectExactProcessBoundary(initial.receipt, { adapter: host, expectedLeader });
    if (latest.state === 'inactive_empty') {
      return Object.freeze({
        stopped: true,
        cgroup_empty: true,
        state: 'inactive_empty',
        forced: false,
        idempotent: false,
      });
    }
    if (latest.state !== 'active' && latest.state !== 'inactive_empty') {
      fail(latest.code ?? 'worker_boundary_inspect_failed', 'Exact process-boundary stop lost identity or visibility before empty proof.');
    }
    await host.sleep(PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS.cgroup_poll_interval);
  }
  fail('cgroup_not_empty', 'Owned systemd process boundary still has descendants after exact unit stop.');
}
