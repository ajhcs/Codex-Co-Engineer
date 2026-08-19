import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  appendTaskEvent,
  clearTaskLaunchReservation,
  createLaunchReservation,
  createTask,
  launchReservationActive,
  listTasks,
  readRuntimeRecord,
  readTask,
  requireTaskId,
  reserveTaskLaunch,
  stateRoot,
  taskPaths,
  updateTask,
  writeRuntimeRecord,
} from './task-store.mjs';
import {
  cancelCursorCloudTask,
  loadCursorApiKey,
  loadCursorSdk,
  reconcileCursorCloudTask,
} from './cursor-cloud-worker.mjs';
import {
  inspectProcessBoundary,
  launchProcessBoundary,
  restoreProcessBoundary,
  stopProcessBoundary,
} from './process-boundary.mjs';

const execFile = promisify(nodeExecFile);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acp-worker.mjs');
const CLOUD_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cursor-cloud-worker.mjs');
const ACTIVE = new Set(['accepted', 'starting', 'running', 'cancelling', 'transport_lost']);
const PROVIDERS = new Set(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
const WORKSPACE_MODES = new Set(['managed', 'direct']);
const WORKTREE_CREATE_MAX_BUFFER = 16 * 1024 * 1024;
const PUBLIC_STARTUP_MESSAGES = Object.freeze({
  credential_permissions: 'Provider credential configuration is invalid.',
  dsh_acp_not_configured: 'DSH ACP configuration is invalid.',
  invalid_credential_file: 'Provider credential configuration is invalid.',
  invalid_state_dir: 'Co-Engineer state configuration is invalid.',
  invalid_worktree: 'The provider worktree is invalid.',
  worktree_create_failed: 'The managed worktree could not be prepared.',
  worker_boundary_uncertain: 'The worker boundary could not be stopped; reconcile or cancel this task.',
  cancelled: 'The task was cancelled before worker startup.',
  provider_startup_failed: 'Provider startup could not be prepared.',
  task_launch_busy: 'Another worker already owns this task launch.',
  worker_start_failed: 'The worker failed to start.',
});

export class SupervisorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'SupervisorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SupervisorError(code, message);
}

function publicStartupError(error, fallbackCode = 'worker_start_failed') {
  const rawCode = typeof error?.code === 'string' ? error.code : fallbackCode;
  const code = /^[A-Za-z0-9._-]{1,96}$/u.test(rawCode) ? rawCode : fallbackCode;
  const message = PUBLIC_STARTUP_MESSAGES[code] ?? PUBLIC_STARTUP_MESSAGES[fallbackCode] ?? 'The worker failed to start.';
  // Startup failures cross the MCP boundary. Keep the public error bounded and
  // do not retain a provider path, stderr, or credential-bearing cause object.
  return new SupervisorError(code, message);
}

function normalizedAbsolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`invalid_${field}`, `${field} must be an absolute, normalized path.`);
  }
  return value;
}

function providerArgv(provider, env = process.env) {
  if (provider === 'grok') return [env.CODEX_CO_ENGINEER_GROK_COMMAND ?? 'grok', 'agent', '--always-approve', 'stdio'];
  if (provider === 'cursor-local') return [env.CODEX_CO_ENGINEER_CURSOR_COMMAND ?? 'cursor-agent', 'acp'];
  if (provider === 'dsh') {
    const config = env.CODEX_CO_ENGINEER_DSH_ACP_CONFIG ?? path.join(
      env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.config'),
      'codex-co-engineer',
      'dsh-acp.yml',
    );
    if (!path.isAbsolute(config)) fail('dsh_acp_not_configured', 'DSH ACP config path must be absolute.');
    return [env.CODEX_CO_ENGINEER_DSH_ACP_COMMAND ?? 'dsh-acp-demo', '--config', path.resolve(config)];
  }
  fail('unsupported_provider', `Unsupported provider: ${provider}`);
}

async function workerEnvironment(provider, source = process.env) {
  const env = { ...source };
  if (provider !== 'dsh' || env.MODEL_API_KEY) return env;
  const file = env.CODEX_CO_ENGINEER_MODEL_API_KEY_FILE ?? path.join(
    env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.config'),
    'codex-co-engineer',
    'model-api-key',
  );
  const metadata = await stat(file);
  if ((metadata.mode & 0o077) !== 0) fail('credential_permissions', 'DSH credential file must be owner-only.');
  const key = (await readFile(file, 'utf8')).trim();
  if (!key || key.includes('\0') || Buffer.byteLength(key) > 16 * 1024) fail('invalid_credential_file', 'DSH credential file is invalid.');
  env.MODEL_API_KEY = key;
  return env;
}

function parseJsonSuffix(stdout) {
  const text = String(stdout ?? '').trim();
  for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Bootstrap commands may write arbitrary text before the final receipt.
    }
  }
  return null;
}

function parseWorktreeResult(stdout, taskId) {
  const value = parseJsonSuffix(stdout);
  if (value?.status !== 'ready'
    || value.task !== taskId
    || typeof value.worktree_path !== 'string'
    || !path.isAbsolute(value.worktree_path)
    || path.resolve(value.worktree_path) !== value.worktree_path
    || typeof value.branch !== 'string'
    || value.branch.length === 0) {
    fail('worktree_create_failed', 'worktree-bootstrap did not return a valid ready receipt.');
  }
  return value;
}

export async function createWriterWorkspace({ taskId, repo, execute = execFile }) {
  requireTaskId(taskId);
  normalizedAbsolute(repo, 'repo');
  try {
    const { stdout: branchOutput } = await execute('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' });
    const base = branchOutput.trim();
    if (!base) fail('worktree_create_failed', 'Writer source must be attached to a branch.');
    const { stdout } = await execute('worktree-bootstrap', ['create', taskId, '--repo', repo, '--base', base], {
      encoding: 'utf8',
      maxBuffer: WORKTREE_CREATE_MAX_BUFFER,
    });
    return parseWorktreeResult(stdout, taskId);
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw new SupervisorError('worktree_create_failed', error?.stderr?.trim() || error?.message || 'worktree-bootstrap failed.', { cause: error });
  }
}

async function readerWorkspace(repo, execute = execFile) {
  normalizedAbsolute(repo, 'repo');
  const resolved = await realpath(repo);
  const [{ stdout: rootOutput }, { stdout: branchOutput }, { stdout: shaOutput }] = await Promise.all([
    execute('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }),
    execute('git', ['-C', resolved, 'branch', '--show-current'], { encoding: 'utf8' }),
    execute('git', ['-C', resolved, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
  ]);
  const root = path.resolve(rootOutput.trim());
  if (root !== resolved) fail('invalid_repo', 'repo must identify the Git worktree root.');
  return {
    worktree_path: resolved,
    branch: branchOutput.trim() || null,
    start_sha: shaOutput.trim() || null,
    task: null,
    status: 'ready',
  };
}

function resolveWorkspaceMode(provider, requested) {
  const value = requested ?? 'managed';
  if (!WORKSPACE_MODES.has(value)) {
    fail('invalid_workspace_mode', 'workspace_mode must be managed or direct.');
  }
  // Cursor Cloud owns the remote workspace/branch. It never receives a local
  // worktree, so normalize its effective mode to direct while retaining the
  // simple managed/direct public vocabulary for local providers.
  return provider === 'cursor-cloud' ? 'direct' : value;
}

function workspaceReference(workspace, taskId) {
  const task = workspace?.task ?? workspace?.worktree_task ?? taskId;
  const worktreePath = workspace?.worktree_path ?? workspace?.cwd;
  if (typeof task !== 'string' || typeof worktreePath !== 'string'
    || !path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath) {
    return null;
  }
  return { task, worktree_path: worktreePath };
}

/**
 * Remove only a provably abandoned worktree-bootstrap writer lock. The
 * worktree and branch are intentionally retained for inspection/merge; this
 * helper never performs destructive Git cleanup and treats every failure as a
 * warning for the task receipt.
 */
export async function cleanupManagedWorkspace({ workspace, taskId, execute = execFile } = {}) {
  const reference = workspaceReference(workspace, taskId);
  if (!reference) return { state: 'unavailable', cleaned: false };
  try {
    const { stdout } = await execute('worktree-bootstrap', [
      'lock', 'inspect', reference.task, '--repo', reference.worktree_path,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const lock = parseJsonSuffix(stdout);
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
      throw Object.assign(new Error('worktree-bootstrap lock inspect did not return a JSON receipt.'), {
        code: 'worktree_cleanup_failed',
      });
    }
    if (lock.state === 'unlocked') return { state: 'unlocked', cleaned: false };
    const health = lock.health;
    if (!health || typeof health !== 'object' || Array.isArray(health) || typeof health.state !== 'string') {
      throw Object.assign(new Error('worktree-bootstrap lock inspect returned an invalid lock receipt.'), {
        code: 'worktree_cleanup_failed',
      });
    }
    if (health.state !== 'abandoned' || typeof lock.lock_id !== 'string' || lock.lock_id.length === 0) {
      return { state: health.state ?? lock.state ?? 'unknown', cleaned: false };
    }
    await execute('worktree-bootstrap', [
      'lock', 'clean', reference.task,
      '--repo', reference.worktree_path,
      '--policy', 'dead-local',
      '--lock-id', lock.lock_id,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return { state: 'cleaned', cleaned: true, lock_id: lock.lock_id };
  } catch (error) {
    return {
      state: 'cleanup_failed',
      cleaned: false,
      error: { code: error?.code ?? 'worktree_cleanup_failed', message: error?.message ?? 'Worktree lock cleanup failed.' },
    };
  }
}

async function recordManagedCleanup(root, task, execute) {
  if (task?.workspace_kind !== 'managed-worktree') return null;
  const result = await cleanupManagedWorkspace({
    workspace: task,
    taskId: task.worktree_task ?? task.id,
    execute,
  });
  if (result.error) {
    await appendTaskEvent(root, task.id, {
      type: 'cleanup_warning',
      code: result.error.code,
    }).catch(() => {});
  }
  return result;
}

async function writeRequest(root, taskId) {
  const paths = taskPaths(root, taskId);
  const handle = await open(paths.request, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ root, task_id: taskId })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return paths;
}

function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] ?? null;
  } catch {
    return null;
  }
}

export async function launchWorker({
  root,
  taskId,
  cwd,
  writer,
  provider,
  env: sourceEnv = process.env,
  spawn = nodeSpawn,
  launchBoundary = launchProcessBoundary,
  stopBoundary = stopProcessBoundary,
  writeRuntime = writeRuntimeRecord,
} = {}) {
  const initial = (await readTask(root, taskId)).task;
  if (initial.status !== 'accepted') {
    fail('cancelled', `Task cannot launch from ${initial.status}.`);
  }
  const launchReservation = launchReservationActive(initial)
    ? initial.launch_reservation
    : await reserveTaskLaunch(root, taskId);
  const paths = await writeRequest(root, taskId);
  const log = await open(paths.log, 'a', 0o600);
  const worker = provider === 'cursor-cloud' ? CLOUD_WORKER : WORKER;
  const workerArgv = [process.execPath, '--no-warnings', worker, '--request', paths.request];
  const command = writer ? 'worktree-bootstrap' : workerArgv.shift();
  const args = writer
    ? ['launch', taskId, '--repo', cwd, '--', ...workerArgv]
    : workerArgv;
  let child;
  let boundary;
  try {
    const env = await workerEnvironment(provider, sourceEnv);
    if (provider === 'cursor-cloud') {
      child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } else {
      boundary = await launchBoundary({
        command,
        args,
        cwd,
        env,
        stdio: ['ignore', log.fd, log.fd],
        taskId,
      });
      child = boundary.child;
    }
  } finally {
    await log.close();
  }
  child.unref();
  try {
    const current = (await readTask(root, taskId)).task;
    if (current.status !== 'accepted' || current.launch_reservation?.token !== launchReservation.token) {
      if (boundary?.handle) await stopBoundary(boundary.handle);
      fail('cancelled', `Task launch reservation is no longer valid (${current.status}).`);
    }
    const runtime = await writeRuntime(root, taskId, {
      pid: child.pid,
      process_group: boundary ? null : child.pid,
      process_start_ticks: processStartTicks(child.pid),
      command: writer ? 'worktree-bootstrap' : process.execPath,
      ...(boundary ? { process_boundary: boundary.receipt } : {}),
    });
    await appendTaskEvent(root, taskId, { type: 'worker', state: 'spawned', pid: child.pid });
    await clearTaskLaunchReservation(root, taskId, launchReservation.token).catch(() => {});
    return runtime;
  } catch (error) {
    if (boundary?.handle) {
      try {
        await stopBoundary(boundary.handle);
      } catch (stopError) {
        const recovery = {
          task_id: taskId,
          pid: child.pid,
          process_group: null,
          process_start_ticks: processStartTicks(child.pid),
          command: writer ? 'worktree-bootstrap' : process.execPath,
          process_boundary: boundary.receipt,
          updated_at: new Date().toISOString(),
        };
        const uncertain = new SupervisorError(
          'worker_boundary_uncertain',
          'Worker launch failed and its owned process boundary could not be stopped; reconcile or cancel this task.',
          { cause: stopError },
        );
        await updateTask(root, taskId, {
          status: 'transport_lost',
          error: { code: uncertain.code, message: uncertain.message },
          runtime_recovery: recovery,
        }).catch(() => {});
        await clearTaskLaunchReservation(root, taskId, launchReservation.token).catch(() => {});
        throw uncertain;
      }
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
    }
    await clearTaskLaunchReservation(root, taskId, launchReservation.token).catch(() => {});
    throw error;
  }
}

export async function submitTask(input, dependencies = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request', 'Task input must be an object.');
  const id = requireTaskId(input.task_id);
  if (!PROVIDERS.has(input.provider)) fail('unsupported_provider', `Unsupported provider: ${input.provider}`);
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) fail('invalid_prompt', 'prompt must be non-empty text.');
  const role = input.role ?? 'implement';
  if (!['review', 'implement'].includes(role)) fail('invalid_role', 'role must be review or implement.');
  if (input.provider !== 'cursor-cloud' && input.create_pr === true) {
    fail('invalid_create_pr', 'create_pr is supported only for Cursor Cloud tasks.');
  }
  if (input.provider !== 'cursor-cloud' && input.starting_ref !== undefined) {
    fail('invalid_starting_ref', 'starting_ref is supported only for Cursor Cloud tasks.');
  }
  const workspaceMode = resolveWorkspaceMode(input.provider, input.workspace_mode);
  const root = dependencies.root ?? stateRoot();
  try {
    await readTask(root, id);
    fail('task_exists', `Task ${id} already exists.`);
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  let launchEnv;
  try {
    launchEnv = await workerEnvironment(input.provider, dependencies.env ?? process.env);
  } catch (error) {
    throw publicStartupError(error, 'provider_startup_failed');
  }
  const managed = input.provider !== 'cursor-cloud' && workspaceMode === 'managed';
  const writer = managed;
  let workspace = null;
  let taskCreated = false;
  try {
    workspace = managed
      ? await (dependencies.createWorkspace ?? createWriterWorkspace)({ taskId: id, repo: input.repo })
      : await readerWorkspace(input.repo, dependencies.execute);
    const agentArgv = input.provider === 'cursor-cloud' ? undefined : providerArgv(input.provider, dependencies.env ?? process.env);
    const { task } = await createTask({
      root,
      prompt: input.prompt,
      record: {
        id,
        status: 'accepted',
        provider: input.provider,
        role,
        source_repo: input.repo,
        cwd: workspace.worktree_path,
        branch: workspace.branch,
        start_sha: workspace.start_sha,
        worktree_task: workspace.task,
        workspace_mode: workspaceMode,
        workspace_kind: input.provider === 'cursor-cloud'
          ? 'provider-managed'
          : managed ? 'managed-worktree' : 'direct',
        ...(agentArgv ? { agent_argv: agentArgv } : {}),
        launch_reservation: createLaunchReservation(),
        starting_ref: input.starting_ref,
        timeout_ms: input.timeout_ms,
        create_pr: input.create_pr === true,
      },
    });
    taskCreated = true;
    await appendTaskEvent(root, id, { type: 'accepted', provider: input.provider, role });
    const runtime = await (dependencies.launch ?? launchWorker)({
      root,
      taskId: id,
      cwd: task.cwd,
      writer,
      provider: input.provider,
      env: launchEnv,
    });
    return { task: (await readTask(root, id)).task, runtime };
  } catch (error) {
    if (taskCreated) {
      const current = (await readTask(root, id)).task;
      if (!['transport_lost', 'cancelling'].includes(current.status)) {
        const safe = publicStartupError(error);
        await updateTask(root, id, {
          status: 'failed',
          error: { code: safe.code, message: safe.message },
          finished_at: new Date().toISOString(),
        }).catch(() => {});
      }
      await clearTaskLaunchReservation(root, id, current.launch_reservation?.token).catch(() => {});
      await recordManagedCleanup(root, (await readTask(root, id)).task, dependencies.execute);
    } else if (managed) {
      await cleanupManagedWorkspace({
        workspace,
        taskId: id,
        execute: dependencies.execute,
      });
    }
    throw taskCreated ? publicStartupError(error) : publicStartupError(error, 'provider_startup_failed');
  }
}

function processIdentity(pid, processGroup, expectedTicks) {
  if (!Number.isInteger(pid) || pid < 2 || !Number.isInteger(processGroup) || processGroup < 2) return null;
  const ticks = processStartTicks(pid);
  if (!ticks || ticks !== expectedTicks) return null;
  return { pid, process_group: processGroup, process_start_ticks: ticks };
}

function currentProcessIdentity(runtime) {
  return processIdentity(runtime?.pid, runtime?.process_group, runtime?.process_start_ticks);
}

function runtimeLeaderAlive(runtime) {
  return Number.isInteger(runtime?.pid)
    && runtime.pid >= 2
    && typeof runtime.process_start_ticks === 'string'
    && processStartTicks(runtime.pid) === runtime.process_start_ticks;
}

async function runtimeActive(runtime) {
  if (runtime?.process_boundary) {
    if (!runtimeLeaderAlive(runtime)) return false;
    try {
      const handle = restoreProcessBoundary(runtime.process_boundary);
      const state = await inspectProcessBoundary(handle);
      return state.found && !state.empty;
    } catch {
      return false;
    }
  }
  return Boolean(currentProcessIdentity(runtime));
}

function taskRuntime(runtime, task) {
  return runtime ?? task?.runtime_recovery ?? null;
}

async function stopRuntimeBoundary(runtime) {
  if (!runtime?.process_boundary) return null;
  const handle = restoreProcessBoundary(runtime.process_boundary);
  return stopProcessBoundary(handle);
}

function currentProviderIdentity(task) {
  return processIdentity(task?.provider_process_group, task?.provider_process_group, task?.provider_process_start_ticks);
}

async function reconcileInactiveTask(root, task, runtime) {
  if (!ACTIVE.has(task.status) || launchReservationActive(task) || await runtimeActive(runtime)) return task;

  if (task.provider === 'cursor-cloud' && task.provider_agent_id) {
    try {
      return await reconcileCursorCloudTask({ root, taskId: task.id });
    } catch (error) {
      return updateTask(root, task.id, {
        status: 'transport_lost',
        launch_reservation: null,
        error: { code: error?.code ?? 'cursor_reconcile_failed', message: 'Cursor Cloud state could not be reconciled.' },
      });
    }
  }

  let boundaryStopped = false;
  if (runtime?.process_boundary) {
    try {
      await stopRuntimeBoundary(runtime);
      boundaryStopped = true;
    } catch {
      // Keep the task reconcilable when exact cgroup cleanup cannot be proven.
    }
  }
  const reconciled = await updateTask(root, task.id, {
    status: 'transport_lost',
    launch_reservation: null,
    error: {
      code: boundaryStopped ? 'worker_not_running' : 'worker_boundary_uncertain',
      message: boundaryStopped
        ? 'Recorded worker stopped; its owned cgroup was emptied without replaying the task.'
        : 'Recorded worker is not running; inspect or cancel this task without replaying it.',
    },
  });
  await recordManagedCleanup(root, reconciled, undefined);
  return reconciled;
}

function processGroupAlive(processGroup) {
  if (!Number.isInteger(processGroup) || processGroup < 2) return false;
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function probeCommand(command, args, authenticatedPattern) {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      cwd: '/tmp', encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024,
    });
    const output = `${stdout}${stderr}`;
    if (/not signed in|not authenticated|log ?in required|unauthori[sz]ed/iu.test(output)) {
      return { installed: true, ready: false, reason: 'needs_login' };
    }
    return { installed: true, ready: authenticatedPattern ? authenticatedPattern.test(output) : true };
  } catch (error) {
    return { installed: error?.code !== 'ENOENT', ready: false, reason: error?.code === 'ENOENT' ? 'not_installed' : 'probe_failed' };
  }
}

async function providerReadiness(env = process.env) {
  const grokCommand = env.CODEX_CO_ENGINEER_GROK_COMMAND ?? 'grok';
  const cursorCommand = env.CODEX_CO_ENGINEER_CURSOR_COMMAND ?? 'cursor-agent';
  const dshCommand = env.CODEX_CO_ENGINEER_DSH_COMMAND ?? 'dsh';
  const acpxCommand = env.CODEX_CO_ENGINEER_ACPX_COMMAND ?? 'acpx';
  const dshAcpCommand = env.CODEX_CO_ENGINEER_DSH_ACP_COMMAND ?? 'dsh-acp-demo';
  const [grok, cursorLocal, dshCli, acpx, dshAcp, dshCredential, cursorCloud] = await Promise.all([
    probeCommand(grokCommand, ['models']),
    probeCommand(cursorCommand, ['status'], /logged in|authenticated|access token/iu),
    probeCommand(dshCommand, ['--version']),
    probeCommand(acpxCommand, ['--version']),
    probeCommand('which', [dshAcpCommand]),
    workerEnvironment('dsh', env).then(() => ({ ready: true })).catch((error) => ({ ready: false, reason: error?.code ?? 'credentials_missing' })),
    Promise.all([loadCursorApiKey(env), loadCursorSdk()])
      .then(() => ({ installed: true, ready: true }))
      .catch((error) => ({ installed: error?.code !== 'cursor_sdk_missing', ready: false, reason: error?.code ?? 'not_configured' })),
  ]);
  return {
    grok: { ...grok, transport: 'acp' },
    'cursor-local': { ...cursorLocal, transport: 'acp' },
    dsh: {
      installed: dshCli.installed && acpx.installed && dshAcp.installed,
      ready: dshCli.ready && acpx.ready && dshAcp.ready && dshCredential.ready,
      transport: 'acpx',
      ...(!dshCredential.ready ? { reason: dshCredential.reason } : {}),
    },
    'cursor-cloud': { ...cursorCloud, transport: 'cursor-sdk' },
  };
}

export async function cancelTask(root, taskId, dependencies = {}) {
  const { task } = await readTask(root, taskId);
  if (!ACTIVE.has(task.status)) return task;
  if (task.provider === 'cursor-cloud' && task.provider_agent_id) {
    const runtime = await readRuntimeRecord(root, taskId);
    await updateTask(root, taskId, { status: 'cancelling' });
    await clearTaskLaunchReservation(root, taskId, task.launch_reservation?.token).catch(() => {});
    const terminal = await (dependencies.cancelCloud ?? cancelCursorCloudTask)({
      root,
      taskId,
      sdk: dependencies.sdk,
      apiKey: dependencies.apiKey,
    });
    const identity = currentProcessIdentity(runtime);
    if (identity) {
      try { process.kill(-identity.process_group, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
    return terminal;
  }
  const runtime = taskRuntime(await readRuntimeRecord(root, taskId), task);
  const identity = currentProcessIdentity(runtime);
  const providerIdentity = currentProviderIdentity(task);
  await updateTask(root, taskId, { status: 'cancelling' });
  await clearTaskLaunchReservation(root, taskId, task.launch_reservation?.token).catch(() => {});
  if (runtime?.process_boundary) {
    try {
      await (dependencies.stopBoundary ?? stopRuntimeBoundary)(runtime);
    } catch (error) {
      await recordManagedCleanup(root, task, dependencies.execute);
      return updateTask(root, taskId, {
        status: 'transport_lost',
        error: { code: error?.code ?? 'cancel_incomplete', message: 'The owned local task cgroup could not be proven empty.' },
      });
    }
    await recordManagedCleanup(root, task, dependencies.execute);
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', boundary: 'systemd-user-scope-cgroup' });
    return updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
  }
  if (!identity && !providerIdentity) {
    await recordManagedCleanup(root, task, dependencies.execute);
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', reason: 'worker_not_running' });
    return updateTask(root, taskId, {
      status: 'cancelled',
      error: { code: 'worker_not_running', message: 'Recorded worker was not running; no owned process remained to signal.' },
      finished_at: new Date().toISOString(),
    });
  }
  for (const owned of [providerIdentity, identity].filter(Boolean)) {
    try { process.kill(-owned.process_group, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  for (let index = 0; index < 20 && identity && processGroupAlive(identity.process_group); index += 1) await wait(100);
  for (let index = 0; index < 20 && providerIdentity && processGroupAlive(providerIdentity.process_group); index += 1) await wait(100);
  if (identity && processGroupAlive(identity.process_group)) {
    try { process.kill(-identity.process_group, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    for (let index = 0; index < 20 && processGroupAlive(identity.process_group); index += 1) await wait(100);
  }
  if (providerIdentity && processGroupAlive(providerIdentity.process_group)) {
    try { process.kill(-providerIdentity.process_group, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    for (let index = 0; index < 20 && processGroupAlive(providerIdentity.process_group); index += 1) await wait(100);
  }
  if ((identity && processGroupAlive(identity.process_group)) || (providerIdentity && processGroupAlive(providerIdentity.process_group))) {
    await recordManagedCleanup(root, task, dependencies.execute);
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cancel_incomplete', message: 'Owned process group remained after SIGKILL.' },
    });
  }
  await recordManagedCleanup(root, task, dependencies.execute);
  await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled' });
  return updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
}

export async function taskStatus(root, taskId) {
  const { task: initialTask } = await readTask(root, taskId);
  const runtime = taskRuntime(await readRuntimeRecord(root, taskId), initialTask);
  const task = await reconcileInactiveTask(root, initialTask, runtime);
  return { task, runtime };
}

export async function supervisorStatus(root = stateRoot()) {
  const tasks = await listTasks(root);
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!ACTIVE.has(task.status)) continue;
    const runtime = taskRuntime(await readRuntimeRecord(root, task.id), task);
    tasks[index] = await reconcileInactiveTask(root, task, runtime);
  }
  return {
    version: '3.0.0',
    healthy: true,
    active: tasks.filter((task) => ACTIVE.has(task.status)).length,
    providers: ['grok', 'cursor-local', 'dsh', 'cursor-cloud'],
    readiness: await providerReadiness(),
    tasks: tasks.slice(0, 20),
  };
}
