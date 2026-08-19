import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  appendTaskEvent,
  createTask,
  listTasks,
  readRuntimeRecord,
  readTask,
  requireTaskId,
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

const execFile = promisify(nodeExecFile);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acp-worker.mjs');
const CLOUD_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cursor-cloud-worker.mjs');
const ACTIVE = new Set(['accepted', 'starting', 'running', 'cancelling', 'transport_lost']);
const PROVIDERS = new Set(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);

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

function parseWorktreeResult(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail('worktree_create_failed', 'worktree-bootstrap did not return JSON.');
  }
  if (value?.status !== 'ready' || typeof value.worktree_path !== 'string' || typeof value.branch !== 'string') {
    fail('worktree_create_failed', 'worktree-bootstrap returned an invalid ready receipt.');
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
      maxBuffer: 1024 * 1024,
    });
    return parseWorktreeResult(stdout);
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw new SupervisorError('worktree_create_failed', error?.stderr?.trim() || error?.message || 'worktree-bootstrap failed.', { cause: error });
  }
}

async function readerWorkspace(repo, execute = execFile) {
  normalizedAbsolute(repo, 'repo');
  const resolved = await realpath(repo);
  const { stdout } = await execute('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = path.resolve(stdout.trim());
  if (root !== resolved) fail('invalid_repo', 'repo must identify the Git worktree root.');
  return { worktree_path: resolved, branch: null, start_sha: null, task: null, status: 'ready' };
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

async function launchWorker({ root, taskId, cwd, writer, provider, env: sourceEnv = process.env, spawn = nodeSpawn }) {
  const paths = await writeRequest(root, taskId);
  const log = await open(paths.log, 'a', 0o600);
  const worker = provider === 'cursor-cloud' ? CLOUD_WORKER : WORKER;
  const workerArgv = [process.execPath, '--no-warnings', worker, '--request', paths.request];
  const command = writer ? 'worktree-bootstrap' : workerArgv.shift();
  const args = writer
    ? ['launch', taskId, '--repo', cwd, '--', ...workerArgv]
    : workerArgv;
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env: await workerEnvironment(provider, sourceEnv),
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } finally {
    await log.close();
  }
  child.unref();
  try {
    const runtime = await writeRuntimeRecord(root, taskId, {
      pid: child.pid,
      process_group: child.pid,
      process_start_ticks: processStartTicks(child.pid),
      command: writer ? 'worktree-bootstrap' : process.execPath,
    });
    await appendTaskEvent(root, taskId, { type: 'worker', state: 'spawned', pid: child.pid });
    return runtime;
  } catch (error) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
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
  const root = dependencies.root ?? stateRoot();
  try {
    await readTask(root, id);
    fail('task_exists', `Task ${id} already exists.`);
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  const launchEnv = await workerEnvironment(input.provider, dependencies.env ?? process.env);
  // Every local provider receives a managed worktree. Review agents retain
  // normal coding capabilities without ever touching the caller's checkout.
  const writer = input.provider !== 'cursor-cloud';
  const workspace = writer
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
      workspace_kind: writer ? 'managed-worktree' : 'provider-managed',
      ...(agentArgv ? { agent_argv: agentArgv } : {}),
      starting_ref: input.starting_ref,
      timeout_ms: input.timeout_ms,
      create_pr: input.create_pr === true,
    },
  });
  await appendTaskEvent(root, id, { type: 'accepted', provider: input.provider, role });
  let runtime;
  try {
    runtime = await (dependencies.launch ?? launchWorker)({
      root,
      taskId: id,
      cwd: task.cwd,
      writer,
      provider: input.provider,
      env: launchEnv,
    });
  } catch (error) {
    await updateTask(root, id, {
      status: 'failed',
      error: { code: error?.code ?? 'worker_start_failed', message: error?.message ?? 'Worker failed to start.' },
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    throw error;
  }
  return { task: (await readTask(root, id)).task, runtime };
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

function currentProviderIdentity(task) {
  return processIdentity(task?.provider_process_group, task?.provider_process_group, task?.provider_process_start_ticks);
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
  const runtime = await readRuntimeRecord(root, taskId);
  const identity = currentProcessIdentity(runtime);
  const providerIdentity = currentProviderIdentity(task);
  await updateTask(root, taskId, { status: 'cancelling' });
  if (!identity && !providerIdentity) {
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
  for (let index = 0; index < 20 && currentProcessIdentity(runtime); index += 1) await wait(100);
  for (let index = 0; index < 20 && currentProviderIdentity(task); index += 1) await wait(100);
  if (currentProcessIdentity(runtime)) {
    try { process.kill(-identity.process_group, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    for (let index = 0; index < 20 && currentProcessIdentity(runtime); index += 1) await wait(100);
  }
  if (currentProviderIdentity(task)) {
    try { process.kill(-providerIdentity.process_group, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    for (let index = 0; index < 20 && currentProviderIdentity(task); index += 1) await wait(100);
  }
  if (currentProcessIdentity(runtime) || currentProviderIdentity(task)) {
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cancel_incomplete', message: 'Owned process group remained after SIGKILL.' },
    });
  }
  await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled' });
  return updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
}

export async function taskStatus(root, taskId) {
  let task = (await readTask(root, taskId)).task;
  const runtime = await readRuntimeRecord(root, taskId);
  if (ACTIVE.has(task.status) && !currentProcessIdentity(runtime)) {
    if (task.provider === 'cursor-cloud' && task.provider_agent_id) {
      task = await reconcileCursorCloudTask({ root, taskId });
    } else {
      task = await updateTask(root, taskId, {
        status: 'transport_lost',
        error: { code: 'worker_not_running', message: 'Recorded worker is not running; inspect or cancel this task without replaying it.' },
      });
    }
  }
  return { task, runtime };
}

export async function supervisorStatus(root = stateRoot()) {
  const tasks = await listTasks(root);
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!ACTIVE.has(task.status)) continue;
    const runtime = await readRuntimeRecord(root, task.id);
    if (currentProcessIdentity(runtime)) continue;
    if (task.provider === 'cursor-cloud' && task.provider_agent_id) {
      try {
        tasks[index] = await reconcileCursorCloudTask({ root, taskId: task.id });
      } catch (error) {
        tasks[index] = await updateTask(root, task.id, {
          status: 'transport_lost',
          error: { code: error?.code ?? 'cursor_reconcile_failed', message: 'Cursor Cloud state could not be reconciled.' },
        });
      }
    } else {
      tasks[index] = await updateTask(root, task.id, {
        status: 'transport_lost',
        error: { code: 'worker_not_running', message: 'Recorded worker is not running; inspect or cancel this task without replaying it.' },
      });
    }
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
