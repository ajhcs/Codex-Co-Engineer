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
import { cancelCursorCloudTask } from './cursor-cloud-worker.mjs';

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
  const file = env.CODEX_CO_ENGINEER_MODEL_API_KEY_FILE;
  if (!file) return env;
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
    const { stdout } = await execute('worktree-bootstrap', ['create', taskId, '--repo', repo], {
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
  } finally {
    await log.close();
  }
  child.unref();
  const runtime = await writeRuntimeRecord(root, taskId, {
    pid: child.pid,
    process_group: child.pid,
    process_start_ticks: processStartTicks(child.pid),
    command: writer ? 'worktree-bootstrap' : process.execPath,
  });
  await appendTaskEvent(root, taskId, { type: 'worker', state: 'spawned', pid: child.pid });
  return runtime;
}

export async function submitTask(input, dependencies = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request', 'Task input must be an object.');
  const id = requireTaskId(input.task_id);
  if (!PROVIDERS.has(input.provider)) fail('unsupported_provider', `Unsupported provider: ${input.provider}`);
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) fail('invalid_prompt', 'prompt must be non-empty text.');
  const role = input.role ?? 'implement';
  if (!['review', 'implement'].includes(role)) fail('invalid_role', 'role must be review or implement.');
  const root = dependencies.root ?? stateRoot();
  const writer = role === 'implement' && input.provider !== 'cursor-cloud';
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
      ...(agentArgv ? { agent_argv: agentArgv } : {}),
      starting_ref: input.starting_ref,
      timeout_ms: input.timeout_ms,
      create_pr: input.create_pr === true,
    },
  });
  await appendTaskEvent(root, id, { type: 'accepted', provider: input.provider, role });
  const runtime = await (dependencies.launch ?? launchWorker)({
    root,
    taskId: id,
    cwd: task.cwd,
    writer,
    provider: input.provider,
    env: dependencies.env ?? process.env,
  });
  return { task: (await readTask(root, id)).task, runtime };
}

function currentProcessIdentity(runtime) {
  if (!Number.isInteger(runtime?.pid) || runtime.pid < 2) return null;
  const ticks = processStartTicks(runtime.pid);
  if (!ticks || ticks !== runtime.process_start_ticks) return null;
  return { pid: runtime.pid, process_group: runtime.process_group, process_start_ticks: ticks };
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function cancelTask(root, taskId, dependencies = {}) {
  const { task } = await readTask(root, taskId);
  if (!ACTIVE.has(task.status)) return task;
  if (task.provider === 'cursor-cloud' && task.provider_run_id) {
    await updateTask(root, taskId, { status: 'cancelling' });
    return (dependencies.cancelCloud ?? cancelCursorCloudTask)({
      root,
      taskId,
      sdk: dependencies.sdk,
      apiKey: dependencies.apiKey,
    });
  }
  const runtime = await readRuntimeRecord(root, taskId);
  const identity = currentProcessIdentity(runtime);
  await updateTask(root, taskId, { status: 'cancelling' });
  if (!identity) {
    return updateTask(root, taskId, { status: 'transport_lost', error: { code: 'worker_not_running', message: 'Recorded worker is not running.' } });
  }
  try { process.kill(-identity.process_group, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  for (let index = 0; index < 20 && currentProcessIdentity(runtime); index += 1) await wait(100);
  if (currentProcessIdentity(runtime)) {
    try { process.kill(-identity.process_group, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled' });
  return updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
}

export async function taskStatus(root, taskId) {
  return { task: (await readTask(root, taskId)).task, runtime: await readRuntimeRecord(root, taskId) };
}

export async function supervisorStatus(root = stateRoot()) {
  const tasks = await listTasks(root);
  return {
    version: '3.0.0',
    healthy: true,
    active: tasks.filter((task) => ACTIVE.has(task.status)).length,
    providers: ['grok', 'cursor-local', 'dsh', 'cursor-cloud'],
    tasks: tasks.slice(0, 20),
  };
}
