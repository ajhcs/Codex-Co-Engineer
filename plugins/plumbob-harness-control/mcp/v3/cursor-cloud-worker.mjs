import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { appendTaskEvent, readPrompt, readTask, updateTask } from './task-store.mjs';

const runFile = promisify(execFile);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export async function loadCursorApiKey(env = process.env) {
  if (env.CURSOR_API_KEY?.trim()) return env.CURSOR_API_KEY.trim();
  const base = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.config');
  const file = env.CURSOR_API_KEY_FILE?.trim() || path.join(base, 'cursor-cloud-control', 'api-key');
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) fail('cursor_key_permissions', 'Cursor API key file must be owner-only.');
  const key = (await readFile(file, 'utf8')).trim();
  if (!key || key.includes('\0')) fail('cursor_credentials_missing', 'Cursor API key is empty.');
  return key;
}

export async function loadCursorSdk() {
  const { stdout } = await runFile('npm', ['root', '--global'], { encoding: 'utf8' });
  const module = path.join(stdout.trim(), '@cursor', 'sdk', 'dist', 'esm', 'index.js');
  try { return await import(pathToFileURL(module).href); } catch (error) {
    throw Object.assign(new Error('Install @cursor/sdk@1.0.28 with the Co-Engineer setup command.', { cause: error }), { code: 'cursor_sdk_missing' });
  }
}

async function gitValue(cwd, args) {
  const { stdout } = await runFile('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

function publicError(error) {
  return { code: error?.code ?? 'cursor_cloud_failed', message: (error?.message ?? 'Cursor Cloud task failed.').slice(0, 4096) };
}

export async function runCursorCloudTask({ root, taskId, sdk, apiKey, signal } = {}) {
  const { task } = await readTask(root, taskId);
  const prompt = await readPrompt(root, taskId);
  const client = sdk ?? await loadCursorSdk();
  const key = apiKey ?? await loadCursorApiKey();
  const agentId = task.provider_agent_id ?? `bc-${randomUUID()}`;
  let agent;
  let removeAbortListener;
  try {
    const [repoUrl, branch] = await Promise.all([
      gitValue(task.cwd, ['remote', 'get-url', 'origin']),
      gitValue(task.cwd, ['branch', '--show-current']),
    ]);
    const startingRef = task.starting_ref ?? branch;
    if (!repoUrl || !startingRef) fail('cursor_cloud_repo_invalid', 'Cursor Cloud requires an origin and starting ref.');
    await updateTask(root, taskId, {
      status: 'starting',
      transport: 'cursor-sdk',
      provider_agent_id: agentId,
      started_at: new Date().toISOString(),
    });
    agent = await client.Agent.create({
      apiKey: key,
      agentId,
      idempotencyKey: `${task.id}:create`,
      name: task.id,
      mode: task.role === 'review' ? 'plan' : 'agent',
      cloud: {
        repos: [{ url: repoUrl, startingRef }],
        autoCreatePR: task.create_pr === true,
        metadata: { co_engineer_task: task.id },
      },
    });
    const run = await agent.send(prompt, {
      mode: task.role === 'review' ? 'plan' : 'agent',
      idempotencyKey: `${task.id}:run:1`,
    });
    await updateTask(root, taskId, {
      status: 'running',
      prompt_dispatched: true,
      provider_run_id: run.id,
    });
    await appendTaskEvent(root, taskId, { type: 'transport', state: 'prompt_dispatched', transport: 'cursor-sdk', agent_id: agentId, run_id: run.id });
    const cancelRun = () => run.cancel().catch(() => {});
    if (signal?.aborted) await cancelRun();
    else if (signal) {
      signal.addEventListener('abort', cancelRun, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', cancelRun);
    }
    const result = await run.wait();
    const status = result.status === 'finished' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    const branches = result.git?.branches ?? [];
    const terminal = await updateTask(root, taskId, {
      status,
      provider_run_id: result.id,
      result: typeof result.result === 'string' ? result.result.slice(0, 4096) : null,
      provider_error: result.error ?? null,
      branches,
      pr_url: branches.find((entry) => entry.prUrl)?.prUrl ?? null,
      finished_at: new Date().toISOString(),
    });
    await appendTaskEvent(root, taskId, { type: 'terminal', status, run_id: result.id });
    try {
      await client.Agent.archive(agentId, { apiKey: key });
      await updateTask(root, taskId, { provider_agent_archived: true });
    } catch (cleanupError) {
      await appendTaskEvent(root, taskId, {
        type: 'cleanup_warning',
        code: cleanupError?.code ?? 'cursor_archive_failed',
      });
    }
    return terminal;
  } catch (error) {
    const current = (await readTask(root, taskId)).task;
    const failure = publicError(error);
    await updateTask(root, taskId, {
      status: signal?.aborted ? 'cancelled' : 'failed',
      error: failure,
      fallback_safe: current.prompt_dispatched !== true,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'failed', error: failure }).catch(() => {});
    throw error;
  } finally {
    removeAbortListener?.();
    agent?.close();
  }
}

export async function cancelCursorCloudTask({ root, taskId, sdk, apiKey } = {}) {
  const { task } = await readTask(root, taskId);
  const client = sdk ?? await loadCursorSdk();
  const key = apiKey ?? await loadCursorApiKey();
  if (task.provider !== 'cursor-cloud') fail('invalid_provider', 'Task is not a Cursor Cloud task.');
  if (task.provider_run_id) {
    try {
      await client.Agent.cancelRun(task.provider_run_id, {
        runtime: 'cloud',
        agentId: task.provider_agent_id,
        apiKey: key,
      });
    } catch (error) {
      const run = await client.Agent.getRun(task.provider_run_id, {
        runtime: 'cloud',
        agentId: task.provider_agent_id,
        apiKey: key,
      }).catch(() => null);
      if (!run || run.status === 'running') throw error;
    }
  }
  if (task.provider_agent_id) {
    await client.Agent.archive(task.provider_agent_id, { apiKey: key });
  }
  await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', transport: 'cursor-sdk' });
  return updateTask(root, taskId, {
    status: 'cancelled',
    provider_agent_archived: Boolean(task.provider_agent_id),
    finished_at: new Date().toISOString(),
  });
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--request') fail('invalid_request', 'Expected --request PATH.');
  const request = JSON.parse(await readFile(argv[1], 'utf8'));
  await runCursorCloudTask({ root: request.root, taskId: request.task_id });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`cursor-cloud-worker: ${error?.code ?? 'failed'}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
