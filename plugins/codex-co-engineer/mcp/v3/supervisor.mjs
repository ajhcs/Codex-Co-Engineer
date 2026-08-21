import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ACTIVE_STATUSES,
  VERSION,
  mcpPendingCallReport,
  providerCapabilities,
  publicState,
} from './contract.mjs';
import { COMPACT_VIEW, projectCompactTask, resolveTaskView } from './compact-task.mjs';
import { deadlineReached, nextDeadlineExtension, resolveTaskDeadline } from './deadline.mjs';
import { compactSummary, compactTaskCard, diagnosticEnvelope, readTaskDiagnostics } from './diagnostics.mjs';
import { submitReply } from './mailbox.mjs';
import {
  appendTaskEvent,
  clearTaskLaunchReservation,
  createLaunchReservation,
  createTask,
  launchReservationActive,
  listTasks,
  listTasksPage,
  parseStatusIncludeTasks,
  parseStatusTaskLimit,
  projectLiveLastEvent,
  readRuntimeRecord,
  readTask,
  requireTaskId,
  reserveTaskLaunch,
  stateRoot,
  taskPaths,
  updateTask,
  waitForTaskProgress,
  writeRuntimeRecord,
} from './task-store.mjs';
import {
  cancelCursorCloudTask,
  loadCursorApiKey,
  loadCursorSdk,
  preflightCursorCloudOrigin,
  reconcileCursorCloudTask,
} from './cursor-cloud-worker.mjs';
import {
  inspectProcessBoundary,
  launchProcessBoundary,
  probeProcessBoundary,
  restoreProcessBoundary,
  stopProcessBoundary,
} from './process-boundary.mjs';

const execFile = promisify(nodeExecFile);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acp-worker.mjs');
const CLOUD_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cursor-cloud-worker.mjs');
const ACTIVE = new Set(ACTIVE_STATUSES);
const PROVIDERS = new Set(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
const DEFAULT_DSH_MODEL = 'muse-spark-1.2-contributor';
const DSH_MODELS = Object.freeze({
  [DEFAULT_DSH_MODEL]: Object.freeze({
    configEnv: 'CODEX_CO_ENGINEER_DSH_ACP_CONFIG',
    configFile: 'dsh-acp.yml',
    credentialEnv: 'MODEL_API_KEY',
    credentialFileEnv: 'CODEX_CO_ENGINEER_MODEL_API_KEY_FILE',
    credentialFile: 'model-api-key',
  }),
  'stealth/ox-alpha': Object.freeze({
    configEnv: 'CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG',
    configFile: 'dsh-acp-ox-alpha.yml',
    credentialEnv: 'OPENROUTER_API_KEY',
    credentialFileEnv: 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
    credentialFile: 'openrouter-api-key',
  }),
});
const WORKSPACE_MODES = new Set(['managed', 'direct']);
const WORKTREE_CREATE_MAX_BUFFER = 16 * 1024 * 1024;
const PUBLIC_STARTUP_MESSAGES = Object.freeze({
  credential_permissions: 'Provider credential configuration is invalid.',
  dsh_acp_not_configured: 'DSH ACP configuration is invalid.',
  invalid_credential_file: 'Provider credential configuration is invalid.',
  invalid_state_dir: 'Co-Engineer state configuration is invalid.',
  invalid_worktree: 'The provider worktree is invalid.',
  invalid_repo: 'The supplied repository worktree is invalid.',
  workspace_missing: 'The requested workspace is missing.',
  workspace_invalid: 'The requested workspace is invalid.',
  workspace_branch_missing: 'The requested workspace is not attached to a branch.',
  workspace_branch_mismatch: 'The requested workspace branch does not match its receipt.',
  workspace_start_ref_missing: 'The requested workspace did not provide an immutable starting commit.',
  workspace_start_ref_invalid: 'The requested workspace has an invalid starting commit.',
  workspace_head_mismatch: 'The requested workspace changed before provider launch.',
  workspace_root_mismatch: 'The requested workspace path is not its Git worktree root.',
  workspace_dirty: 'The source worktree has uncommitted changes; clean it before managed delegation.',
  worktree_create_failed: 'The managed worktree could not be prepared.',
  worker_boundary_uncertain: 'The worker boundary could not be stopped; reconcile or cancel this task.',
  cancelled: 'The task was cancelled before worker startup.',
  provider_startup_failed: 'Provider startup could not be prepared.',
  task_launch_busy: 'Another worker already owns this task launch.',
  local_boundary_unavailable: 'The local systemd/cgroup process boundary is unavailable.',
  systemd_user_manager_unavailable: 'The local systemd user manager is unavailable.',
  systemd_user_cgroup_unverifiable: 'The local systemd user-manager cgroup could not be verified.',
  systemd_run_unavailable: 'The local systemd-run client is unavailable.',
  systemd_too_old: 'The local systemd version is too old.',
  cgroup_v2_unavailable: 'The local unified cgroup v2 hierarchy is unavailable.',
  linux_required: 'Local providers require Linux.',
  posix_uid_required: 'Local providers require a normal Linux user identity.',
  boundary_probe_failed: 'The local process boundary could not be checked.',
  systemd_run_failed: 'systemd-run could not queue the local worker service.',
  worker_start_failed: 'The worker failed to start.',
  cursor_cloud_workspace_missing: 'Cursor Cloud requires an existing Git workspace.',
  cursor_cloud_workspace_invalid: 'Cursor Cloud requires a valid Git workspace.',
  cursor_cloud_workspace_dirty: 'Cursor Cloud requires a clean local checkout before dispatch.',
  cursor_cloud_workspace_changed: 'Cursor Cloud checkout state changed after preflight; retry from the pinned commit.',
  cursor_cloud_origin_changed: 'Cursor Cloud origin changed after preflight; retry from the pinned provider origin.',
  cursor_cloud_origin_missing: 'Cursor Cloud requires a provider-visible Git origin or an explicit provider repository override.',
  cursor_cloud_origin_invalid: 'Cursor Cloud requires a valid provider-visible Git origin.',
  cursor_cloud_origin_credentials: 'Cursor Cloud origin credentials are not accepted; configure a credential-free origin or provider repository override.',
  cursor_cloud_origin_unsupported: 'Cursor Cloud does not support this repository origin format.',
  cursor_cloud_repo_invalid: 'Cursor Cloud requires a valid provider repository URL.',
  cursor_cloud_repo_credentials: 'Cursor Cloud provider repository URLs cannot contain credentials, query, or fragment data.',
  cursor_cloud_repo_override_conflict: 'Cursor Cloud accepts one provider repository override.',
  cursor_cloud_repo_identity_invalid: 'Cursor Cloud could not determine a canonical repository identity.',
  cursor_cloud_start_ref_unavailable: 'Cursor Cloud requires an immutable starting commit.',
  cursor_cloud_start_ref_invalid: 'Cursor Cloud requires a full 40-character commit starting reference.',
  invalid_provider_repo: 'provider_repo_url is supported only for Cursor Cloud tasks.',
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

function resolveDshModel(value) {
  const model = value ?? DEFAULT_DSH_MODEL;
  if (!Object.hasOwn(DSH_MODELS, model)) {
    fail('invalid_dsh_model', `dsh_model must be one of ${Object.keys(DSH_MODELS).join(', ')}.`);
  }
  return model;
}

function providerArgv(provider, env = process.env, dshModel) {
  if (provider === 'grok') return [env.CODEX_CO_ENGINEER_GROK_COMMAND ?? 'grok', 'agent', '--always-approve', 'stdio'];
  if (provider === 'cursor-local') return [env.CODEX_CO_ENGINEER_CURSOR_COMMAND ?? 'cursor-agent', 'acp'];
  if (provider === 'dsh') {
    const model = resolveDshModel(dshModel);
    const selection = DSH_MODELS[model];
    const config = env[selection.configEnv] ?? path.join(
      env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.config'),
      'codex-co-engineer',
      selection.configFile,
    );
    if (!path.isAbsolute(config)) fail('dsh_acp_not_configured', 'DSH ACP config path must be absolute.');
    return [env.CODEX_CO_ENGINEER_DSH_ACP_COMMAND ?? 'dsh-acp-demo', '--config', path.resolve(config)];
  }
  fail('unsupported_provider', `Unsupported provider: ${provider}`);
}

async function workerEnvironment(provider, source = process.env, dshModel) {
  const env = { ...source };
  if (provider !== 'dsh') return env;
  const selection = DSH_MODELS[resolveDshModel(dshModel)];
  if (env[selection.credentialEnv]) return env;
  const file = env[selection.credentialFileEnv] ?? path.join(
    env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.config'),
    'codex-co-engineer',
    selection.credentialFile,
  );
  const metadata = await stat(file);
  if ((metadata.mode & 0o077) !== 0) fail('credential_permissions', 'DSH credential file must be owner-only.');
  const key = (await readFile(file, 'utf8')).trim();
  if (!key || key.includes('\0') || Buffer.byteLength(key) > 16 * 1024) fail('invalid_credential_file', 'DSH credential file is invalid.');
  env[selection.credentialEnv] = key;
  return env;
}

async function localBoundaryReadiness(probe = probeProcessBoundary) {
  try {
    const boundary = await probe();
    if (boundary && typeof boundary === 'object' && typeof boundary.ready === 'boolean') return boundary;
  } catch {
    // Return a bounded public result rather than leaking a host command error.
  }
  return Object.freeze({
    ready: false,
    status: 'unavailable',
    reason: 'boundary_probe_failed',
    action: 'Inspect the local systemd user-manager and unified cgroup v2 prerequisites.',
    provider_started: false,
  });
}

function requireLocalBoundary(boundary) {
  if (boundary.ready) return boundary;
  const error = new SupervisorError(
    typeof boundary.reason === 'string' ? boundary.reason : 'local_boundary_unavailable',
    'The local process boundary is unavailable.',
  );
  throw publicStartupError(error, 'local_boundary_unavailable');
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

function managedSourceDirty(stdout) {
  // `git status --porcelain=v1` starts every changed entry with two status
  // columns. Keep the parser deliberately narrow so a mocked or noisy git
  // command cannot turn an unrelated line into a dirty-worktree failure.
  return String(stdout ?? '').split(/\r?\n/u).some((line) => /^[ MADRCU?!]{2}\s*\S/u.test(line));
}

function missingWorkspaceError(error) {
  if (error?.code === 'ENOENT') return true;
  return /(?:no such file|cannot change to|does not exist)/iu.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
}

async function validateManagedSource({ repo, execute = execFile }) {
  normalizedAbsolute(repo, 'repo');
  let branchOutput;
  let statusOutput;
  try {
    ({ stdout: branchOutput } = await execute('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }));
    ({ stdout: statusOutput } = await execute('git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }));
  } catch (error) {
    const code = missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid';
    throw new SupervisorError(code, code === 'workspace_missing'
      ? 'The source workspace does not exist.'
      : 'The source workspace is not a valid Git worktree.', { cause: error });
  }
  const branch = String(branchOutput ?? '').trim();
  if (!branch) fail('workspace_branch_missing', 'The source workspace must be attached to a branch.');
  if (managedSourceDirty(statusOutput)) {
    fail('workspace_dirty', 'The source worktree must be clean before managed delegation.');
  }
  return { branch };
}

async function validateWorkspaceContract(workspace, taskId, {
  execute = execFile,
  checkPath = stat,
} = {}) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    fail('workspace_missing', 'Managed delegation did not return a workspace.');
  }
  if (workspace.status !== undefined && workspace.status !== 'ready') {
    fail('workspace_invalid', 'Managed delegation returned a workspace that is not ready.');
  }
  const workspaceTask = workspace.task ?? workspace.worktree_task;
  const worktreePath = workspace.worktree_path ?? workspace.cwd;
  if (typeof workspaceTask !== 'string' || workspaceTask.length === 0 || workspaceTask !== taskId) {
    fail('workspace_invalid', 'Managed delegation returned an invalid workspace identity.');
  }
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath) {
    fail('workspace_invalid', 'Managed delegation returned an invalid workspace path.');
  }
  if (typeof workspace.branch !== 'string' || workspace.branch.trim().length === 0) {
    fail('workspace_branch_missing', 'Managed delegation returned a workspace without a branch.');
  }
  if (typeof workspace.start_sha !== 'string' || workspace.start_sha.length === 0) {
    fail('workspace_start_ref_missing', 'Managed delegation returned a workspace without an immutable starting commit.');
  }
  if (!/^[0-9a-f]{40}$/iu.test(workspace.start_sha)) {
    fail('workspace_start_ref_invalid', 'Managed delegation returned an invalid starting commit.');
  }
  let metadata;
  try {
    metadata = await checkPath(worktreePath);
  } catch (error) {
    const code = missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid';
    fail(code, code === 'workspace_missing'
      ? 'Managed delegation returned a workspace path that does not exist.'
      : 'Managed delegation returned a workspace path that cannot be inspected.');
  }
  if (typeof metadata?.isDirectory !== 'function' || !metadata.isDirectory()) {
    fail('workspace_invalid', 'Managed delegation returned a workspace path that is not a directory.');
  }
  let outputs;
  try {
    outputs = await Promise.all([
      execute('git', ['-C', worktreePath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }),
      execute('git', ['-C', worktreePath, 'branch', '--show-current'], { encoding: 'utf8' }),
      execute('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
    ]);
  } catch (error) {
    const code = missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid';
    fail(code, code === 'workspace_missing'
      ? 'Managed delegation returned a path that is not an accessible Git worktree.'
      : 'Managed delegation returned a path that is not a valid Git worktree.');
  }
  const [{ stdout: rootOutput }, { stdout: branchOutput }, { stdout: headOutput }] = outputs;
  const root = String(rootOutput ?? '').trim();
  if (!path.isAbsolute(root) || path.resolve(root) !== worktreePath) {
    fail('workspace_root_mismatch', 'Managed delegation returned a path that is not its Git worktree root.');
  }
  const branch = String(branchOutput ?? '').trim();
  if (!branch) fail('workspace_branch_missing', 'Managed delegation returned a detached workspace.');
  if (branch !== workspace.branch.trim()) {
    fail('workspace_branch_mismatch', 'Managed delegation returned a branch that does not match its Git worktree.');
  }
  const head = String(headOutput ?? '').trim();
  if (!/^[0-9a-f]{40}$/iu.test(head) || head.toLowerCase() !== workspace.start_sha.toLowerCase()) {
    fail('workspace_head_mismatch', 'Managed delegation workspace HEAD does not match its recorded starting commit.');
  }
  return {
    ...workspace,
    task: workspaceTask,
    worktree_path: worktreePath,
    branch,
    start_sha: workspace.start_sha.toLowerCase(),
  };
}

export async function createWriterWorkspace({ taskId, repo, execute = execFile, checkPath = stat }) {
  requireTaskId(taskId);
  const source = await validateManagedSource({ repo, execute });
  try {
    const base = source.branch;
    if (!base) fail('workspace_branch_missing', 'Writer source must be attached to a branch.');
    const { stdout } = await execute('worktree-bootstrap', ['create', taskId, '--repo', repo, '--base', base], {
      encoding: 'utf8',
      maxBuffer: WORKTREE_CREATE_MAX_BUFFER,
    });
    return await validateWorkspaceContract(parseWorktreeResult(stdout, taskId), taskId, { execute, checkPath });
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw new SupervisorError('worktree_create_failed', error?.stderr?.trim() || error?.message || 'worktree-bootstrap failed.', { cause: error });
  }
}

async function readerWorkspace(repo, execute = execFile) {
  normalizedAbsolute(repo, 'repo');
  let resolved;
  try {
    resolved = await realpath(repo);
  } catch (error) {
    throw new SupervisorError(missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid',
      missingWorkspaceError(error) ? 'The source workspace does not exist.' : 'The source workspace is invalid.', { cause: error });
  }
  let outputs;
  try {
    outputs = await Promise.all([
      execute('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }),
      execute('git', ['-C', resolved, 'branch', '--show-current'], { encoding: 'utf8' }),
      execute('git', ['-C', resolved, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
    ]);
  } catch (error) {
    throw new SupervisorError('workspace_invalid', 'The source workspace is not a valid Git worktree.', { cause: error });
  }
  const [{ stdout: rootOutput }, { stdout: branchOutput }, { stdout: shaOutput }] = outputs;
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
    const env = await workerEnvironment(provider, sourceEnv, initial.dsh_model);
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
        logPath: paths.log,
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
  if (input.provider !== 'dsh' && input.dsh_model !== undefined) {
    fail('invalid_dsh_model', 'dsh_model is supported only for DSH tasks.');
  }
  const dshModel = input.provider === 'dsh' ? resolveDshModel(input.dsh_model) : undefined;
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) fail('invalid_prompt', 'prompt must be non-empty text.');
  const role = input.role ?? 'implement';
  if (!['review', 'implement'].includes(role)) fail('invalid_role', 'role must be review or implement.');
  if (input.provider !== 'cursor-cloud' && input.create_pr === true) {
    fail('invalid_create_pr', 'create_pr is supported only for Cursor Cloud tasks.');
  }
  if (input.provider !== 'cursor-cloud' && input.starting_ref !== undefined) {
    fail('invalid_starting_ref', 'starting_ref is supported only for Cursor Cloud tasks.');
  }
  if (input.provider !== 'cursor-cloud' && (input.provider_repo_url !== undefined || input.provider_repo !== undefined)) {
    fail('invalid_provider_repo', 'provider_repo_url is supported only for Cursor Cloud tasks.');
  }
  if (input.provider === 'cursor-cloud' && input.provider_repo_url !== undefined
    && input.provider_repo !== undefined && input.provider_repo_url !== input.provider_repo) {
    fail('cursor_cloud_repo_override_conflict', 'Provide only one provider repository override.');
  }
  const workspaceMode = resolveWorkspaceMode(input.provider, input.workspace_mode);
  const deadline = resolveTaskDeadline(input);
  if (input.silence_timeout_ms !== undefined && input.silence_timeout_ms !== null) {
    if (!Number.isInteger(input.silence_timeout_ms) || input.silence_timeout_ms < 5_000 || input.silence_timeout_ms > 86_400_000) {
      fail('invalid_silence_timeout_ms', 'silence_timeout_ms must be an integer from 5000 to 86400000.');
    }
  }
  const root = dependencies.root ?? stateRoot();
  try {
    await readTask(root, id);
    fail('task_exists', `Task ${id} already exists.`);
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  if (input.provider !== 'cursor-cloud') {
    requireLocalBoundary(await localBoundaryReadiness(dependencies.probeBoundary));
  }
  let launchEnv;
  try {
    launchEnv = await workerEnvironment(input.provider, dependencies.env ?? process.env, dshModel);
  } catch (error) {
    throw publicStartupError(error, 'provider_startup_failed');
  }
  const managed = input.provider !== 'cursor-cloud' && workspaceMode === 'managed';
  const writer = managed;
  let workspace = null;
  let cloudPreflight = null;
  let taskCreated = false;
  try {
    workspace = managed
      ? await (dependencies.createWorkspace ?? createWriterWorkspace)({
        taskId: id,
        repo: input.repo,
        ...(dependencies.createWorkspace ? {} : { execute: dependencies.execute, checkPath: dependencies.checkPath }),
      })
      : await readerWorkspace(input.repo, dependencies.execute);
    // The built-in bootstrap already returns a verified contract. Re-verify
    // only injected workspace factories so normal dispatch does not repeat a
    // stat plus three Git subprocesses on every managed task.
    if (managed && dependencies.createWorkspace) workspace = await validateWorkspaceContract(workspace, id, {
      execute: dependencies.execute,
      checkPath: dependencies.checkPath,
    });
    if (input.provider === 'cursor-cloud') {
      const preflight = dependencies.preflightCloudOrigin ?? preflightCursorCloudOrigin;
      const readGit = dependencies.readGit ?? (dependencies.execute
        ? async (cwd, args) => {
          const result = await dependencies.execute('git', ['-C', cwd, ...args], { encoding: 'utf8' });
          return String(result?.stdout ?? '').trim();
        }
        : undefined);
      cloudPreflight = await preflight({
        cwd: workspace.worktree_path,
        providerRepoUrl: input.provider_repo_url ?? input.provider_repo,
        startingRef: input.starting_ref,
        ...(readGit ? { readGit } : {}),
      });
    }
    const agentArgv = input.provider === 'cursor-cloud'
      ? undefined
      : providerArgv(input.provider, dependencies.env ?? process.env, dshModel);
    const { task } = await createTask({
      root,
      prompt: input.prompt,
      record: {
        id,
        status: 'accepted',
        provider: input.provider,
        ...(dshModel ? { dsh_model: dshModel } : {}),
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
        ...(cloudPreflight ? {
          provider_repo_url: cloudPreflight.provider_repo_url,
          provider_repo_source: cloudPreflight.provider_repo_source,
          provider_repo_identity: cloudPreflight.provider_repo_identity,
          provider_origin_kind: cloudPreflight.provider_origin_kind,
        } : {}),
        ...(agentArgv ? { agent_argv: agentArgv } : {}),
        launch_reservation: createLaunchReservation(),
        starting_ref: cloudPreflight?.starting_ref ?? input.starting_ref,
        timeout_ms: deadline.timeout_ms,
        expected_duration_ms: deadline.expected_duration_ms,
        duration_margin: deadline.duration_margin,
        deadline_at: deadline.deadline_at,
        deadline_source: deadline.deadline_source,
        deadline_extensions: [],
        silence_timeout_ms: input.silence_timeout_ms ?? null,
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

export async function extendTaskDeadline(root, taskId, { expected_duration_ms, reason } = {}) {
  const { task } = await readTask(root, taskId);
  const changes = nextDeadlineExtension(task, { expected_duration_ms, reason });
  const next = await updateTask(root, taskId, changes);
  await appendTaskEvent(root, taskId, {
    type: 'deadline_extended',
    reason: reason?.trim?.().slice(0, 512) ?? null,
    previous_deadline_at: task.deadline_at ?? null,
    deadline_at: next.deadline_at,
    expected_duration_ms: next.expected_duration_ms,
  });
  return next;
}

async function reconcileInactiveTask(root, task, runtime) {
  if (!ACTIVE.has(task.status) || launchReservationActive(task) || await runtimeActive(runtime)) return task;
  if (deadlineReached(task)) {
    const timedOut = await updateTask(root, task.id, {
      status: 'timeout',
      launch_reservation: null,
      error: {
        code: 'deadline_reached',
        message: 'The recorded task deadline was reached and the worker is no longer running.',
      },
      failed_stage: 'deadline',
      finished_at: new Date().toISOString(),
    });
    await appendTaskEvent(root, task.id, { type: 'terminal', status: 'timeout', reason: 'deadline_reached' }).catch(() => {});
    await recordManagedCleanup(root, timedOut, undefined);
    return timedOut;
  }

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
  const [grok, cursorLocal, dshCli, acpx, dshAcp, dshMuseCredential, dshOxCredential, cursorCloud] = await Promise.all([
    probeCommand(grokCommand, ['models']),
    probeCommand(cursorCommand, ['status'], /logged in|authenticated|access token/iu),
    probeCommand(dshCommand, ['--version']),
    probeCommand(acpxCommand, ['--version']),
    probeCommand('which', [dshAcpCommand]),
    workerEnvironment('dsh', env, DEFAULT_DSH_MODEL).then(() => ({ ready: true })).catch((error) => ({ ready: false, reason: error?.code ?? 'credentials_missing' })),
    workerEnvironment('dsh', env, 'stealth/ox-alpha').then(() => ({ ready: true })).catch((error) => ({ ready: false, reason: error?.code ?? 'credentials_missing' })),
    Promise.all([loadCursorApiKey(env), loadCursorSdk()])
      .then(() => ({ installed: true, ready: true }))
      .catch((error) => ({ installed: error?.code !== 'cursor_sdk_missing', ready: false, reason: error?.code ?? 'not_configured' })),
  ]);
  return {
    grok: { ...grok, transport: 'acp' },
    'cursor-local': { ...cursorLocal, transport: 'acp' },
    dsh: {
      installed: dshCli.installed && acpx.installed && dshAcp.installed,
      ready: dshCli.ready && acpx.ready && dshAcp.ready && dshMuseCredential.ready,
      transport: 'acpx',
      default_model: DEFAULT_DSH_MODEL,
      model_options: {
        [DEFAULT_DSH_MODEL]: dshMuseCredential,
        'stealth/ox-alpha': dshOxCredential,
      },
      ...(!dshMuseCredential.ready ? { reason: dshMuseCredential.reason } : {}),
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
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', boundary: runtime.process_boundary.boundary });
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

export async function taskStatus(root, taskId, options = {}) {
  const { task: initialTask } = await readTask(root, taskId);
  const runtime = taskRuntime(await readRuntimeRecord(root, taskId), initialTask);
  await reconcileInactiveTask(root, initialTask, runtime);
  const view = resolveTaskView(options.view);
  const waited = await waitForTaskProgress(root, taskId, {
    cursor: options.cursor,
    wait_ms: view === 'diagnostics' ? 0 : options.wait_ms,
    wait_until: options.wait_until,
    wake_on_needs_attention: options.wake_on_needs_attention,
    signal: options.signal,
  });
  const latestRuntime = taskRuntime(await readRuntimeRecord(root, taskId), waited.task);
  const task = await projectLiveLastEvent(
    root,
    await reconcileInactiveTask(root, waited.task, latestRuntime),
  );
  const progress = {
    ...waited.progress,
    last_event: task.last_event ?? waited.progress.last_event,
  };
  const extras = {
    wait_reason: progress.wait_reason,
    last_event: progress.last_event,
    event_cursor: progress.event_cursor,
  };
  if (view === COMPACT_VIEW) {
    return projectCompactTask({
      task,
      progress,
      runtime: latestRuntime,
      extras,
    });
  }
  const result = {
    task,
    runtime: latestRuntime,
    progress,
    state: publicState(task.status),
    summary: compactSummary(task, progress, latestRuntime, extras),
    diagnostic: diagnosticEnvelope(task, latestRuntime, extras),
    capabilities: providerCapabilities(task.provider),
    view,
  };
  if (view === 'diagnostics') {
    result.diagnostics = await readTaskDiagnostics(root, taskId, {
      cursor: options.cursor,
      max_bytes: options.max_bytes,
      runtime: latestRuntime,
      progress,
    });
  }
  return result;
}

export async function inspectTask(root, args = {}, options = {}) {
  if (args.extend_expected_duration_ms != null || args.extend_reason) {
    await extendTaskDeadline(root, args.task_id, {
      expected_duration_ms: args.extend_expected_duration_ms,
      reason: args.extend_reason,
    });
  }
  if (args.reply) {
    await submitReply(root, args.task_id, args.reply);
  }
  return taskStatus(root, args.task_id, { ...args, ...options });
}

export async function supervisorStatus(root = stateRoot(), dependencies = {}, options = {}) {
  // Allow calling as supervisorStatus(root, opts) for backward compat in tests.
  const hasDepsShape = dependencies && typeof dependencies === 'object' && ('probeBoundary' in dependencies || 'readProviderReadiness' in dependencies);
  const looksLikeOpts = dependencies && typeof dependencies === 'object' && ('detail' in dependencies || 'task_limit' in dependencies || 'include_tasks' in dependencies || 'taskLimit' in dependencies || 'includeTasks' in dependencies);
  if (!hasDepsShape && looksLikeOpts) {
    options = dependencies;
    dependencies = {};
  }
  const hasOptions = options && typeof options === 'object' && (options.detail !== undefined || options.task_limit !== undefined || options.taskLimit !== undefined || options.include_tasks !== undefined || options.includeTasks !== undefined);
  // Legacy no-arg path: must preserve exact 3.2 shape and reconcile ALL tasks before slicing (active/task values are durable truth).
  if (!hasOptions) {
    const tasksAll = await listTasks(root);
    for (let index = 0; index < tasksAll.length; index += 1) {
      const task = tasksAll[index];
      if (!ACTIVE.has(task.status)) continue;
      const runtime = taskRuntime(await readRuntimeRecord(root, task.id), task);
      tasksAll[index] = await reconcileInactiveTask(root, task, runtime);
    }
    const boundary = await localBoundaryReadiness(dependencies.probeBoundary);
    const readiness = await (dependencies.readProviderReadiness ?? providerReadiness)();
    for (const provider of ['grok', 'cursor-local', 'dsh']) {
      if (!boundary.ready) readiness[provider] = {
        ...readiness[provider],
        ready: false,
        reason: boundary.reason ?? 'local_boundary_unavailable',
      };
    }
    return {
      version: VERSION,
      healthy: boundary.ready,
      active: tasksAll.filter((task) => ACTIVE.has(task.status)).length,
      providers: ['grok', 'cursor-local', 'dsh', 'cursor-cloud'],
      capabilities: {
        grok: providerCapabilities('grok'),
        'cursor-local': providerCapabilities('cursor-local'),
        dsh: providerCapabilities('dsh'),
        'cursor-cloud': providerCapabilities('cursor-cloud'),
      },
      mcp_pending_call: mcpPendingCallReport(),
      local_boundary: boundary,
      readiness,
      tasks: await Promise.all(tasksAll.slice(0, 20).map((task) => projectLiveLastEvent(root, task))),
    };
  }
  const detail = options.detail ?? 'full';
  if (detail !== 'full' && detail !== 'compact') {
    throw Object.assign(new Error('detail must be full or compact.'), { code: 'invalid_detail' });
  }
  const includeTasksRaw = options.include_tasks !== undefined ? options.include_tasks : options.includeTasks;
  const includeTasks = parseStatusIncludeTasks(includeTasksRaw);
  const taskLimitRaw = options.task_limit !== undefined ? options.task_limit : options.taskLimit;
  let taskLimit;
  if (includeTasks) {
    taskLimit = taskLimitRaw !== undefined ? parseStatusTaskLimit(taskLimitRaw) : 20;
  } else {
    // Deterministic semantics: when include_tasks is false, task_limit is validated if provided but ignored (forced to 0).
    // Documented in tool description: "Ignored when include_tasks is false." Validation ensures caller typos are surfaced.
    if (taskLimitRaw !== undefined) parseStatusTaskLimit(taskLimitRaw);
    taskLimit = 0;
  }
  // Preserve reconciliation semantics: reconcile ALL tasks before slicing. Slice is presentation-only.
  // This ensures legacy active/reconciled values are not skewed by the limit window.
  const allTasks = await listTasks(root);
  const totalTasks = allTasks.length;
  for (let index = 0; index < allTasks.length; index += 1) {
    const task = allTasks[index];
    if (!ACTIVE.has(task.status)) continue;
    const runtime = taskRuntime(await readRuntimeRecord(root, task.id), task);
    allTasks[index] = await reconcileInactiveTask(root, task, runtime);
  }
  const boundary = await localBoundaryReadiness(dependencies.probeBoundary);
  const readiness = await (dependencies.readProviderReadiness ?? providerReadiness)();
  for (const provider of ['grok', 'cursor-local', 'dsh']) {
    if (!boundary.ready) readiness[provider] = {
      ...readiness[provider],
      ready: false,
      reason: boundary.reason ?? 'local_boundary_unavailable',
    };
  }
  const totalActive = allTasks.filter((task) => ACTIVE.has(task.status)).length;
  let windowTasks = [];
  if (includeTasks && taskLimit > 0) {
    windowTasks = allTasks.slice(0, taskLimit);
    // Compact/readiness paths avoid constructing/projecting omitted full public receipts.
    // Full detail projects live last_event (event-log I/O); compact skips that overlay.
    if (detail === 'full') {
      windowTasks = await Promise.all(windowTasks.map((task) => projectLiveLastEvent(root, task)));
    }
  }
  const result = {
    version: VERSION,
    healthy: boundary.ready,
    active: totalActive,
    providers: ['grok', 'cursor-local', 'dsh', 'cursor-cloud'],
    capabilities: {
      grok: providerCapabilities('grok'),
      'cursor-local': providerCapabilities('cursor-local'),
      dsh: providerCapabilities('dsh'),
      'cursor-cloud': providerCapabilities('cursor-cloud'),
    },
    mcp_pending_call: mcpPendingCallReport(),
    local_boundary: boundary,
    readiness,
    detail,
    task_count: totalTasks,
    returned_tasks: windowTasks.length,
    task_limit: taskLimit,
    include_tasks: includeTasks,
    total: totalTasks,
    limit: taskLimit,
    tasks: detail === 'compact' ? windowTasks.map((t) => compactTaskCard(t)) : windowTasks,
  };
  return result;
}
