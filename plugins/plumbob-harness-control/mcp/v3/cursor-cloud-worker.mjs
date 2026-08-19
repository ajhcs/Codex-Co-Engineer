import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { appendTaskEvent, readPrompt, readTask, updateTask } from './task-store.mjs';

process.umask(0o077);

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

function providerRepoUrl(value) {
  if (/^https?:\/\//iu.test(value)) {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      fail('cursor_cloud_repo_credentials', 'Cursor Cloud refuses an origin URL containing embedded credentials.');
    }
  }
  return value;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitBounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRemoteStop(client, task, runId, key) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await client.Agent.getRun(runId, {
      runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
    }).catch(() => null);
    if (current && current.status !== 'running') return current;
    await delay(250);
  }
  fail('cursor_cancel_unconfirmed', `Cursor Cloud run ${runId} remained active after cancellation.`);
}

export async function runCursorCloudTask({ root, taskId, sdk, apiKey, signal } = {}) {
  const { task } = await readTask(root, taskId);
  const prompt = await readPrompt(root, taskId);
  const client = sdk ?? await loadCursorSdk();
  const key = apiKey ?? await loadCursorApiKey();
  const agentId = task.provider_agent_id ?? `bc-${randomUUID()}`;
  let agent;
  let run;
  let waitPromise;
  let removeAbortListener;
  let deadline;
  let timedOut = false;
  try {
    if (signal?.aborted) fail('cancelled', 'Cursor Cloud task was cancelled before startup.');
    const [rawRepoUrl, branch] = await Promise.all([
      gitValue(task.cwd, ['remote', 'get-url', 'origin']),
      gitValue(task.cwd, ['branch', '--show-current']),
    ]);
    const repoUrl = providerRepoUrl(rawRepoUrl);
    const startingRef = task.starting_ref ?? branch;
    if (!repoUrl || !startingRef) fail('cursor_cloud_repo_invalid', 'Cursor Cloud requires an origin and starting ref.');
    await updateTask(root, taskId, {
      status: 'starting',
      transport: 'cursor-sdk',
      provider_agent_id: agentId,
      started_at: new Date().toISOString(),
    });
    const createOptions = {
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
    };
    try {
      agent = await client.Agent.create(createOptions);
    } catch (createError) {
      const existing = await client.Agent.get(agentId, { apiKey: key }).catch(() => null);
      if (!existing) throw createError;
      agent = await client.Agent.resume(agentId, { apiKey: key });
    }
    await updateTask(root, taskId, {
      dispatch_intent: true,
      prompt_dispatched: true,
      fallback_safe: false,
      run_idempotency_key: `${task.id}:run:1`,
    });
    try {
      run = await agent.send(prompt, {
        mode: task.role === 'review' ? 'plan' : 'agent',
        idempotencyKey: `${task.id}:run:1`,
      });
    } catch (sendError) {
      const runs = await client.Agent.listRuns(agentId, { runtime: 'cloud', apiKey: key }).catch(() => null);
      run = runs?.items?.find((entry) => entry.status === 'running') ?? runs?.items?.[0];
      if (!run) throw sendError;
    }
    await updateTask(root, taskId, {
      status: 'running',
      provider_run_id: run.id,
    });
    await appendTaskEvent(root, taskId, { type: 'transport', state: 'prompt_dispatched', transport: 'cursor-sdk', agent_id: agentId, run_id: run.id });
    const cancelRun = async () => {
      await run.cancel();
      if (waitPromise) await waitBounded(waitPromise.catch(() => null), 10_000);
    };
    if (signal?.aborted) await cancelRun();
    else if (signal) {
      const cancelListener = () => { void cancelRun().catch(() => {}); };
      signal.addEventListener('abort', cancelListener, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', cancelListener);
    }
    const timeoutMs = task.timeout_ms ?? 8 * 60 * 60 * 1000;
    waitPromise = run.wait();
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => {
        timedOut = true;
        void cancelRun().catch(() => {});
        reject(Object.assign(new Error('Cursor Cloud task exceeded its deadline.'), { code: 'timeout' }));
      }, timeoutMs);
    });
    const result = await Promise.race([waitPromise, timeout]);
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
    let remoteStopped = !run;
    if (run) {
      try {
        await run.cancel();
        if (waitPromise) await waitBounded(waitPromise.then(() => { remoteStopped = true; }), 10_000);
      } catch {
        remoteStopped = false;
      }
    }
    if (agent && remoteStopped) {
      await client.Agent.archive(agentId, { apiKey: key }).catch(() => {});
      await updateTask(root, taskId, { provider_agent_archived: true }).catch(() => {});
    }
    const current = (await readTask(root, taskId)).task;
    const failure = publicError(error);
    const status = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'failed';
    await updateTask(root, taskId, {
      status,
      error: failure,
      fallback_safe: current.prompt_dispatched !== true,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    await appendTaskEvent(root, taskId, { type: 'terminal', status, error: failure }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
    removeAbortListener?.();
    agent?.close();
  }
}

export async function cancelCursorCloudTask({ root, taskId, sdk, apiKey } = {}) {
  const { task } = await readTask(root, taskId);
  const client = sdk ?? await loadCursorSdk();
  const key = apiKey ?? await loadCursorApiKey();
  if (task.provider !== 'cursor-cloud') fail('invalid_provider', 'Task is not a Cursor Cloud task.');
  let runs = [];
  if (task.provider_agent_id) {
    const listed = await client.Agent.listRuns(task.provider_agent_id, { runtime: 'cloud', apiKey: key }).catch(() => null);
    runs = listed?.items ?? [];
  }
  if (task.provider_run_id && !runs.some((run) => run.id === task.provider_run_id)) {
    const exact = await client.Agent.getRun(task.provider_run_id, {
      runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
    }).catch(() => null);
    if (exact) runs.unshift(exact);
  }
  for (const run of runs.filter((entry) => entry.status === 'running')) {
    try {
      await client.Agent.cancelRun(run.id, {
        runtime: 'cloud',
        agentId: task.provider_agent_id,
        apiKey: key,
      });
    } catch (error) {
      const current = await client.Agent.getRun(run.id, {
        runtime: 'cloud',
        agentId: task.provider_agent_id,
        apiKey: key,
      }).catch(() => null);
      if (!current || current.status === 'running') throw error;
    }
    await waitForRemoteStop(client, task, run.id, key);
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

export async function reconcileCursorCloudTask({ root, taskId, sdk, apiKey } = {}) {
  const { task } = await readTask(root, taskId);
  if (task.provider !== 'cursor-cloud' || !task.provider_agent_id) return task;
  const client = sdk ?? await loadCursorSdk();
  const key = apiKey ?? await loadCursorApiKey();
  const listed = await client.Agent.listRuns(task.provider_agent_id, { runtime: 'cloud', apiKey: key });
  const run = listed.items.find((entry) => entry.id === task.provider_run_id)
    ?? listed.items.find((entry) => entry.status === 'running')
    ?? listed.items[0];
  if (!run) return task;
  if (run.status === 'running') {
    return updateTask(root, taskId, { status: 'running', provider_run_id: run.id });
  }
  const result = await run.wait();
  const status = result.status === 'finished' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
  const branches = result.git?.branches ?? [];
  await client.Agent.archive(task.provider_agent_id, { apiKey: key }).catch(() => {});
  return updateTask(root, taskId, {
    status,
    provider_run_id: result.id,
    result: typeof result.result === 'string' ? result.result.slice(0, 4096) : null,
    provider_error: result.error ?? null,
    branches,
    pr_url: branches.find((entry) => entry.prUrl)?.prUrl ?? null,
    provider_agent_archived: true,
    finished_at: new Date().toISOString(),
  });
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--request') fail('invalid_request', 'Expected --request PATH.');
  const request = JSON.parse(await readFile(argv[1], 'utf8'));
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Worker signal received.'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    await runCursorCloudTask({ root: request.root, taskId: request.task_id, signal: controller.signal });
  } finally {
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`cursor-cloud-worker: ${error?.code ?? 'failed'}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
