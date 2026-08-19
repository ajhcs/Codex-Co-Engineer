import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { appendTaskEvent, readPrompt, readRuntimeRecord, readTask, updateTask } from './task-store.mjs';

process.umask(0o077);

const runFile = promisify(execFile);
const DEFAULT_TASK_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 30_000;
const PROVIDER_CALL_TIMEOUT_MS = 5_000;
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const AMBIGUOUS_SEND_CODES = new Set([
  'network_error',
  'request_timeout',
  'timeout',
  'connection_reset',
  'service_unavailable',
]);

function fail(code, message, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  throw error;
}

function timeoutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function remainingUntil(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function boundedPromise(promise, milliseconds, code, message) {
  const operation = Promise.resolve(promise);
  // A timed-out provider promise can reject later. Keep that rejection handled
  // while the worker records the bounded outcome and performs cleanup.
  operation.catch(() => {});
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(code, message)), Math.max(1, milliseconds));
    }),
  ]).finally(() => clearTimeout(timer));
}

function boundedCall(factory, milliseconds, code, message) {
  return boundedPromise(Promise.resolve().then(factory), milliseconds, code, message);
}

function deadlineCall(deadlineAt, factory, label) {
  const milliseconds = remainingUntil(deadlineAt);
  if (milliseconds <= 0) {
    fail('timeout', `Cursor Cloud task exceeded its deadline during ${label}.`);
  }
  return boundedCall(
    factory,
    milliseconds,
    'timeout',
    `Cursor Cloud task exceeded its deadline during ${label}.`,
  );
}

function cleanupCall(factory, label) {
  return boundedCall(
    factory,
    CLEANUP_TIMEOUT_MS,
    'cursor_cleanup_timeout',
    `Cursor Cloud ${label} did not finish within the cleanup deadline.`,
  );
}

function publicError(error) {
  let message = error?.message ?? 'Cursor Cloud task failed.';
  // Provider errors are persisted in the owner-local receipt and returned by
  // the MCP facade. Remove the common credential-bearing URL forms before the
  // bounded message is exposed.
  message = String(message)
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, 'https://[redacted]@')
    .replace(/([?&](?:token|access_token|api[_-]?key|secret|password)=)[^&#\s]*/giu, '$1[redacted]')
    .slice(0, 4096);
  return { code: error?.code ?? 'cursor_cloud_failed', message };
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
  const { stdout } = await runFile('npm', ['root', '--global'], {
    encoding: 'utf8',
    timeout: PROVIDER_CALL_TIMEOUT_MS,
  });
  const module = path.join(stdout.trim(), '@cursor', 'sdk', 'dist', 'esm', 'index.js');
  try { return await import(pathToFileURL(module).href); } catch (error) {
    throw Object.assign(new Error('Install @cursor/sdk@1.0.28 with the Co-Engineer setup command.', { cause: error }), { code: 'cursor_sdk_missing' });
  }
}

async function gitValue(cwd, args) {
  const { stdout } = await runFile('git', ['-C', cwd, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: PROVIDER_CALL_TIMEOUT_MS,
  });
  return stdout.trim();
}

function providerRepoUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u0020]/u.test(value)) {
    fail('cursor_cloud_repo_invalid', 'Cursor Cloud requires a valid repository URL.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('cursor_cloud_repo_invalid', 'Cursor Cloud requires a valid repository URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    fail('cursor_cloud_repo_credentials', 'Cursor Cloud requires an http(s) origin without credentials, query, or fragment data.');
  }
  return parsed.toString();
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForRemoteStop(client, task, runId, key, deadlineAt = Date.now() + CANCEL_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt < 40 && remainingUntil(deadlineAt) > 0; attempt += 1) {
    try {
      const current = await boundedCall(
        () => client.Agent.getRun(runId, {
          runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
        }),
        Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
        'cursor_cancel_unconfirmed',
        `Cursor Cloud run ${runId} could not be checked during cancellation.`,
      );
      if (current && current.status !== 'running') return current;
    } catch (error) {
      lastError = error;
    }
    if (remainingUntil(deadlineAt) <= 0) break;
    await boundedCall(
      () => delay(Math.min(250, remainingUntil(deadlineAt))),
      remainingUntil(deadlineAt),
      'cursor_cancel_unconfirmed',
      `Cursor Cloud run ${runId} could not be confirmed stopped.`,
    ).catch((error) => { lastError = error; });
  }
  fail(
    'cursor_cancel_unconfirmed',
    `Cursor Cloud run ${runId} remained active or unverifiable after cancellation.`,
    { cause: lastError },
  );
}

async function stopRemoteRun(run, waitPromise) {
  let stopped = run?.status !== 'running' && run?.status !== undefined;
  let lastError;
  try {
    await cleanupCall(() => run.cancel(), 'run cancellation');
  } catch (error) {
    lastError = error;
  }
  if (run?.status !== 'running' && run?.status !== undefined) stopped = true;
  if (waitPromise) {
    try {
      const result = await cleanupCall(() => waitPromise, 'run stop confirmation');
      if (result?.status && result.status !== 'running') stopped = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!stopped) {
    fail('cursor_cancel_unconfirmed', 'Cursor Cloud run state remained uncertain after cancellation.', { cause: lastError });
  }
  return true;
}

async function awaitSupervisorRegistration(root, taskId, signal) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (signal?.aborted) fail('cancelled', 'Task was cancelled before worker registration.');
    const { task } = await readTask(root, taskId);
    if (task.status !== 'accepted') {
      fail(task.status === 'cancelling' ? 'cancelled' : 'transport_lost', `Task cannot start from ${task.status}.`);
    }
    if (await readRuntimeRecord(root, taskId)) return;
    await delay(25);
  }
  fail('worker_registration_timeout', 'Supervisor did not register the cloud worker before dispatch.');
}

async function assertDispatchable(root, taskId, signal, phase) {
  if (signal?.aborted) fail('cancelled', `Task was cancelled before Cursor Cloud ${phase}.`);
  const { task } = await readTask(root, taskId);
  if (task.status !== 'accepted' && task.status !== 'starting') {
    fail(task.status === 'cancelling' ? 'cancelled' : 'transport_lost', `Task cannot dispatch Cursor Cloud during ${phase} from ${task.status}.`);
  }
  return task;
}

function isAmbiguousSendError(error) {
  return error?.isRetryable === true || AMBIGUOUS_SEND_CODES.has(error?.code);
}

function uncertainDispatchError(cause) {
  return Object.assign(
    new Error('Cursor Cloud accepted state could not be reconciled after the send response was lost.', { cause }),
    { code: 'cursor_cloud_dispatch_uncertain' },
  );
}

async function archiveAgent(client, agentId, key) {
  await cleanupCall(() => client.Agent.archive(agentId, { apiKey: key }), 'agent archival');
  return true;
}

export async function runCursorCloudTask({ root, taskId, sdk, apiKey, signal } = {}) {
  const { task } = await readTask(root, taskId);
  const prompt = await readPrompt(root, taskId);
  const taskTimeoutMs = validTimeout(task.timeout_ms, DEFAULT_TASK_TIMEOUT_MS);
  const deadlineAt = Date.now() + taskTimeoutMs;
  const runIdempotencyKey = task.run_idempotency_key ?? `${task.id}:run:1`;
  const agentId = task.provider_agent_id ?? `bc-${randomUUID()}`;
  let client;
  let key;
  let agent;
  let run;
  let waitPromise;
  let stopPromise;
  let removeAbortListener;
  let timedOut = false;
  let dispatchAttempted = false;
  let dispatchUncertain = false;
  try {
    if (signal?.aborted) fail('cancelled', 'Cursor Cloud task was cancelled before startup.');
    client = sdk ?? await deadlineCall(deadlineAt, () => loadCursorSdk(), 'SDK loading');
    key = apiKey ?? await deadlineCall(deadlineAt, () => loadCursorApiKey(), 'credential loading');
    const [rawRepoUrl, branch, head] = await Promise.all([
      deadlineCall(deadlineAt, () => gitValue(task.cwd, ['remote', 'get-url', 'origin']), 'origin discovery'),
      deadlineCall(deadlineAt, () => gitValue(task.cwd, ['branch', '--show-current']), 'branch discovery'),
      task.role === 'implement'
        ? deadlineCall(deadlineAt, () => gitValue(task.cwd, ['rev-parse', 'HEAD']), 'immutable head discovery')
        : Promise.resolve(null),
    ]);
    const repoUrl = providerRepoUrl(rawRepoUrl);
    const startingRef = task.role === 'implement'
      ? task.starting_ref ?? head
      : task.starting_ref ?? branch;
    if (!startingRef) fail('cursor_cloud_start_ref_unavailable', 'Cursor Cloud requires a starting reference.');
    if (task.role === 'implement' && !COMMIT_SHA.test(startingRef)) {
      fail('cursor_cloud_start_ref_invalid', 'Cursor Cloud implementation tasks require a full 40-character commit startingRef.');
    }
    await assertDispatchable(root, taskId, signal, 'startup');
    const started = await updateTask(root, taskId, {
      status: 'starting',
      transport: 'cursor-sdk',
      provider_agent_id: agentId,
      starting_ref: startingRef,
      started_at: new Date().toISOString(),
    });
    if (started.status !== 'starting' || started.provider_agent_id !== agentId) {
      fail('cancelled', 'Task cancellation won the Cursor Cloud startup race.');
    }
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
      agent = await deadlineCall(deadlineAt, () => client.Agent.create(createOptions), 'agent creation');
    } catch (createError) {
      const existing = await deadlineCall(deadlineAt, () => client.Agent.get(agentId, { apiKey: key }), 'agent recovery').catch(() => null);
      if (!existing) throw createError;
      agent = await deadlineCall(deadlineAt, () => client.Agent.resume(agentId, { apiKey: key }), 'agent resume');
    }
    await assertDispatchable(root, taskId, signal, 'dispatch');
    const dispatch = await updateTask(root, taskId, {
      dispatch_intent: true,
      prompt_dispatched: true,
      fallback_safe: false,
      run_idempotency_key: runIdempotencyKey,
    });
    if (dispatch.status !== 'starting') fail('cancelled', 'Task cancellation won the Cursor Cloud dispatch race.');
    await assertDispatchable(root, taskId, signal, 'prompt dispatch');
    try {
      run = await deadlineCall(
        deadlineAt,
        () => {
          dispatchAttempted = true;
          return agent.send(prompt, {
            mode: task.role === 'review' ? 'plan' : 'agent',
            idempotencyKey: runIdempotencyKey,
          });
        },
        'prompt dispatch',
      );
    } catch (sendError) {
      if (!isAmbiguousSendError(sendError)) throw sendError;
      dispatchUncertain = true;
      let listed;
      try {
        listed = await deadlineCall(deadlineAt, () => client.Agent.listRuns(agentId, { runtime: 'cloud', apiKey: key }), 'dispatch reconciliation');
      } catch (recoveryError) {
        throw uncertainDispatchError(recoveryError);
      }
      if (!Array.isArray(listed?.items)) throw uncertainDispatchError(new Error('Cursor Cloud returned an invalid run listing.'));
      const expectedRequestIds = new Set([runIdempotencyKey, sendError?.requestId].filter(Boolean));
      const matches = listed.items.filter((entry) => expectedRequestIds.has(entry?.requestId));
      if (matches.length !== 1) throw uncertainDispatchError(sendError);
      run = matches[0];
    }
    if (!run || typeof run.id !== 'string' || typeof run.wait !== 'function') {
      throw uncertainDispatchError(new Error('Cursor Cloud did not return a usable run handle.'));
    }
    const registered = await updateTask(root, taskId, { provider_run_id: run.id });
    if (signal?.aborted || registered.status === 'cancelling') {
      fail('cancelled', 'Task cancellation won the Cursor Cloud run-registration race.');
    }
    const running = await updateTask(root, taskId, {
      status: 'running',
      provider_run_id: run.id,
    });
    if (running.status !== 'running') fail('transport_lost', 'Cursor Cloud run could not be registered in the task receipt.');
    await appendTaskEvent(root, taskId, { type: 'transport', state: 'prompt_dispatched', transport: 'cursor-sdk', agent_id: agentId, run_id: run.id });
    const stopRemote = () => {
      if (!stopPromise) stopPromise = stopRemoteRun(run, waitPromise);
      return stopPromise;
    };
    if (signal?.aborted) await stopRemote();
    else if (signal) {
      const cancelListener = () => { void stopRemote().catch(() => {}); };
      signal.addEventListener('abort', cancelListener, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', cancelListener);
    }
    const rawWait = Promise.resolve().then(() => run.wait());
    rawWait.catch(() => {});
    waitPromise = rawWait;
    const result = await deadlineCall(deadlineAt, () => rawWait, 'run completion');
    const status = result.status === 'finished' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    const branches = result.git?.branches ?? [];
    let archived = false;
    try {
      archived = await archiveAgent(client, agentId, key);
    } catch (cleanupError) {
      await appendTaskEvent(root, taskId, {
        type: 'cleanup_warning',
        code: cleanupError?.code ?? 'cursor_archive_failed',
      });
    }
    const terminal = await updateTask(root, taskId, {
      status,
      provider_run_id: result.id,
      result: typeof result.result === 'string' ? result.result.slice(0, 4096) : null,
      provider_error: result.error ?? null,
      branches,
      pr_url: branches.find((entry) => entry.prUrl)?.prUrl ?? null,
      provider_agent_archived: archived,
      finished_at: new Date().toISOString(),
    });
    await appendTaskEvent(root, taskId, { type: 'terminal', status, run_id: result.id });
    return terminal;
  } catch (error) {
    timedOut ||= error?.code === 'timeout';
    let current = (await readTask(root, taskId)).task;
    let remoteStopped = !dispatchAttempted || !dispatchUncertain;
    let stopError;
    if (run) {
      try {
        if (stopPromise) await stopPromise;
        else await stopRemoteRun(run, waitPromise);
        remoteStopped = true;
      } catch (cleanupError) {
        stopError = cleanupError;
        remoteStopped = false;
      }
    }
    let archived = false;
    if (agent && remoteStopped) {
      try {
        archived = await archiveAgent(client, agentId, key);
      } catch (cleanupError) {
        await appendTaskEvent(root, taskId, {
          type: 'cleanup_warning',
          code: cleanupError?.code ?? 'cursor_archive_failed',
        }).catch(() => {});
      }
    }
    current = (await readTask(root, taskId)).task;
    const uncertain = dispatchUncertain || (dispatchAttempted && !remoteStopped);
    const status = uncertain
      ? 'transport_lost'
      : signal?.aborted || current.status === 'cancelling'
        ? 'cancelled'
        : timedOut
          ? 'timeout'
          : 'failed';
    const failure = uncertain
      ? publicError(Object.assign(new Error('Cursor Cloud remote state could not be confirmed; reconcile or cancel this task before retrying.', { cause: stopError ?? error }), { code: 'cursor_cloud_remote_state_uncertain' }))
      : publicError(error);
    const changes = {
      status,
      error: failure,
      fallback_safe: current.prompt_dispatched !== true,
      ...(agent && remoteStopped ? { provider_agent_archived: archived } : {}),
      ...(!uncertain ? { finished_at: new Date().toISOString() } : {}),
    };
    await updateTask(root, taskId, changes).catch(() => {});
    await appendTaskEvent(root, taskId, {
      type: uncertain ? 'transport_lost' : 'terminal',
      status,
      error: failure,
    }).catch(() => {});
    throw error;
  } finally {
    removeAbortListener?.();
    agent?.close();
  }
}

async function listRunsForCancellation(client, task, key, deadlineAt) {
  if (!task.provider_agent_id) return [];
  if (!task.provider_run_id) {
    fail('cursor_cancel_unconfirmed', 'Cursor Cloud cancellation requires the exact recorded run identity; refusing to cancel an arbitrary run.');
  }
  let listed;
  try {
    listed = await boundedCall(
      () => client.Agent.listRuns(task.provider_agent_id, { runtime: 'cloud', apiKey: key }),
      Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
      'cursor_cancel_unconfirmed',
      'Cursor Cloud run listing did not finish during cancellation.',
    );
  } catch (listError) {
    let exact;
    try {
      exact = await boundedCall(
        () => client.Agent.getRun(task.provider_run_id, {
          runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
        }),
        Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
        'cursor_cancel_unconfirmed',
        'Cursor Cloud exact run lookup did not finish during cancellation.',
      );
    } catch (exactError) {
      fail('cursor_cancel_unconfirmed', 'Cursor Cloud run state could not be listed or checked during cancellation.', { cause: exactError });
    }
    if (exact?.id !== task.provider_run_id) {
      fail('cursor_cancel_unconfirmed', 'Cursor Cloud returned no exact run for the recorded cancellation identity.');
    }
    return [exact];
  }
  if (!Array.isArray(listed?.items)) fail('cursor_cancel_unconfirmed', 'Cursor Cloud returned an invalid run listing.');
  const runs = listed.items.filter((entry) => entry?.id === task.provider_run_id);
  if (runs.length === 0) {
    const exact = await boundedCall(
      () => client.Agent.getRun(task.provider_run_id, {
        runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
      }),
      Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
      'cursor_cancel_unconfirmed',
      'Cursor Cloud exact run lookup did not finish during cancellation.',
    );
    if (exact?.id !== task.provider_run_id) {
      fail('cursor_cancel_unconfirmed', 'Cursor Cloud returned no exact run for the recorded cancellation identity.');
    }
    runs.push(exact);
  }
  return runs;
}

export async function cancelCursorCloudTask({ root, taskId, sdk, apiKey } = {}) {
  const { task } = await readTask(root, taskId);
  if (task.provider !== 'cursor-cloud') fail('invalid_provider', 'Task is not a Cursor Cloud task.');
  if (!task.provider_agent_id) {
    if (task.prompt_dispatched) {
      const failure = { code: 'cursor_cancel_unconfirmed', message: 'Cursor Cloud dispatch was recorded without an agent identity; the task must be reconciled before retrying.' };
      await updateTask(root, taskId, { status: 'transport_lost', error: failure }).catch(() => {});
      fail(failure.code, failure.message);
    }
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', transport: 'cursor-sdk' });
    return updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
  }
  const deadlineAt = Date.now() + CANCEL_TIMEOUT_MS;
  const client = sdk ?? await boundedCall(() => loadCursorSdk(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_cancel_unconfirmed', 'Cursor SDK loading did not finish during cancellation.');
  const key = apiKey ?? await boundedCall(() => loadCursorApiKey(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_cancel_unconfirmed', 'Cursor credential loading did not finish during cancellation.');
  if (!task.provider_run_id && !task.prompt_dispatched) {
    let archived = false;
    try {
      archived = await archiveAgent(client, task.provider_agent_id, key);
    } catch (cleanupError) {
      await appendTaskEvent(root, taskId, {
        type: 'cleanup_warning',
        code: cleanupError?.code ?? 'cursor_archive_failed',
      }).catch(() => {});
    }
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', transport: 'cursor-sdk' });
    return updateTask(root, taskId, {
      status: 'cancelled',
      provider_agent_archived: archived,
      finished_at: new Date().toISOString(),
    });
  }
  let runs;
  try {
    runs = await listRunsForCancellation(client, task, key, deadlineAt);
    for (const run of runs) {
      if (!['running', 'finished', 'cancelled', 'error'].includes(run?.status)) {
        fail('cursor_cancel_unconfirmed', `Cursor Cloud returned an unknown status for the recorded run ${task.provider_run_id}.`);
      }
      if (run.status !== 'running') continue;
      try {
        await boundedCall(
          () => client.Agent.cancelRun(run.id, {
            runtime: 'cloud',
            agentId: task.provider_agent_id,
            apiKey: key,
          }),
          Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
          'cursor_cancel_unconfirmed',
          `Cursor Cloud run ${run.id} cancellation did not finish.`,
        );
      } catch (error) {
        const current = await boundedCall(
          () => client.Agent.getRun(run.id, {
            runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
          }),
          Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
          'cursor_cancel_unconfirmed',
          `Cursor Cloud run ${run.id} could not be checked after cancellation failed.`,
        ).catch(() => null);
        if (!current || current.status === 'running') throw error;
      }
      await waitForRemoteStop(client, task, run.id, key, deadlineAt);
    }
  } catch (error) {
    const failure = publicError(Object.assign(
      new Error('Cursor Cloud cancellation state could not be confirmed; the task must be reconciled before retrying.', { cause: error }),
      { code: 'cursor_cancel_unconfirmed' },
    ));
    await updateTask(root, taskId, { status: 'transport_lost', error: failure }).catch(() => {});
    throw Object.assign(error, { code: 'cursor_cancel_unconfirmed' });
  }
  let archived = false;
  try {
    archived = await archiveAgent(client, task.provider_agent_id, key);
  } catch (cleanupError) {
    await appendTaskEvent(root, taskId, {
      type: 'cleanup_warning',
      code: cleanupError?.code ?? 'cursor_archive_failed',
    }).catch(() => {});
  }
  await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', transport: 'cursor-sdk' });
  return updateTask(root, taskId, {
    status: 'cancelled',
    provider_agent_archived: archived,
    finished_at: new Date().toISOString(),
  });
}

export async function reconcileCursorCloudTask({ root, taskId, sdk, apiKey } = {}) {
  const { task } = await readTask(root, taskId);
  if (task.provider !== 'cursor-cloud') return task;
  if (!task.provider_agent_id || !task.provider_run_id) {
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cursor_run_identity_missing', message: 'Cursor Cloud run identity is missing; do not replay this task. Cancel it or inspect the provider manually.' },
    });
  }
  const deadlineAt = Date.now() + CANCEL_TIMEOUT_MS;
  const client = sdk ?? await boundedCall(() => loadCursorSdk(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_reconcile_failed', 'Cursor SDK loading did not finish during reconciliation.');
  const key = apiKey ?? await boundedCall(() => loadCursorApiKey(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_reconcile_failed', 'Cursor credential loading did not finish during reconciliation.');
  let run;
  try {
    run = await boundedCall(
      () => client.Agent.getRun(task.provider_run_id, {
        runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
      }),
      Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
      'cursor_reconcile_failed',
      'Cursor Cloud exact run lookup did not finish during reconciliation.',
    );
  } catch (error) {
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: publicError(Object.assign(new Error('Cursor Cloud run could not be reconciled.', { cause: error }), { code: 'cursor_reconcile_failed' })),
    });
  }
  if (!run) {
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cursor_reconcile_failed', message: 'Cursor Cloud returned no exact run for the recorded run identity.' },
    });
  }
  if (run.status === 'running') {
    return updateTask(root, taskId, { status: 'running', provider_run_id: run.id });
  }
  if (!['finished', 'cancelled', 'error'].includes(run.status)) {
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cursor_reconcile_failed', message: 'Cursor Cloud returned an unknown run status; do not replay this task.' },
    });
  }
  let result;
  try {
    result = await boundedCall(() => run.wait(), Math.min(CLEANUP_TIMEOUT_MS, remainingUntil(deadlineAt)), 'cursor_reconcile_failed', 'Cursor Cloud run completion did not finish during reconciliation.');
  } catch (error) {
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: publicError(Object.assign(new Error('Cursor Cloud run completion could not be reconciled.', { cause: error }), { code: 'cursor_reconcile_failed' })),
    });
  }
  const status = result.status === 'finished' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
  const branches = result.git?.branches ?? [];
  let archived = false;
  try {
    archived = await archiveAgent(client, task.provider_agent_id, key);
  } catch (cleanupError) {
    await appendTaskEvent(root, taskId, {
      type: 'cleanup_warning',
      code: cleanupError?.code ?? 'cursor_archive_failed',
    }).catch(() => {});
  }
  return updateTask(root, taskId, {
    status,
    provider_run_id: result.id,
    result: typeof result.result === 'string' ? result.result.slice(0, 4096) : null,
    provider_error: result.error ?? null,
    branches,
    pr_url: branches.find((entry) => entry.prUrl)?.prUrl ?? null,
    provider_agent_archived: archived,
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
    await awaitSupervisorRegistration(request.root, request.task_id, controller.signal);
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
