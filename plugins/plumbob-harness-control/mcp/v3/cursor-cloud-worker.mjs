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

function redactedString(value, sensitiveValues = []) {
  let message = String(value ?? 'Cursor Cloud task failed.');
  for (const secret of [...sensitiveValues]
    .filter((entry) => typeof entry === 'string' && entry.length >= 3)
    .sort((left, right) => right.length - left.length)) {
    message = message.split(secret).join('[redacted]');
  }
  // Provider errors are persisted in the owner-local receipt and returned by
  // the MCP facade. Remove common credential-bearing URL and header forms
  // before anything reaches a task receipt or worker log.
  return message
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, 'https://[redacted]@')
    .replace(/([?&](?:token|access_token|api[_-]?key|secret|password)=)[^&#\s]*/giu, '$1[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[redacted]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|token)\s*[:=]\s*["']?)[^\s,"'}]+/giu, '$1[redacted]')
    .slice(0, 4096);
}

function publicError(error, sensitiveValues = []) {
  return {
    code: error?.code ?? 'cursor_cloud_failed',
    message: redactedString(error?.message ?? 'Cursor Cloud task failed.', sensitiveValues),
  };
}

function sanitizedThrown(error, codeOverride, sensitiveValues = []) {
  const safe = publicError(error, sensitiveValues);
  return Object.assign(
    new Error(safe.message, { cause: error }),
    { code: codeOverride ?? safe.code },
  );
}

const SENSITIVE_PROVIDER_FIELDS = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|credential|password|secret|token|prompt)$/iu;

function sanitizeProviderValue(value, sensitiveValues = [], depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactedString(value, sensitiveValues);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return '[redacted]';
  if (depth >= 6) return '[redacted]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: redactedString(value.name, sensitiveValues),
      ...(value.code ? { code: redactedString(value.code, sensitiveValues) } : {}),
      message: redactedString(value.message, sensitiveValues),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeProviderValue(entry, sensitiveValues, depth + 1, seen));
  }
  if (value instanceof Date) return value.toISOString();
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_PROVIDER_FIELDS.test(key)
      ? '[redacted]'
      : sanitizeProviderValue(entry, sensitiveValues, depth + 1, seen);
  }
  return output;
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
      if (current?.id !== runId) {
        lastError = new Error(`Cursor Cloud returned a different run identity while checking ${runId}.`);
        lastError.code = 'cursor_cancel_unconfirmed';
        break;
      }
      if (current.status !== 'running') return current;
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

async function stopRemoteRun(client, task, key, run, waitPromise) {
  let stopped = false;
  let lastError;
  try {
    await cleanupCall(() => run.cancel(), 'run cancellation');
  } catch (error) {
    lastError = error;
  }
  if (waitPromise) {
    try {
      await cleanupCall(() => waitPromise, 'run stop confirmation');
    } catch (error) {
      lastError = error;
    }
  }
  try {
    const current = await cleanupCall(
      () => client.Agent.getRun(run.id, {
        runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
      }),
      'provider run stop confirmation',
    );
    if (current?.id !== run.id) {
      const identityError = new Error(`Cursor Cloud returned a different run identity while confirming ${run.id}.`);
      identityError.code = 'cursor_cancel_unconfirmed';
      throw identityError;
    }
    stopped = ['finished', 'cancelled', 'error'].includes(current.status);
    if (!stopped) {
      const activeError = new Error(`Cursor Cloud run ${run.id} remains active after cancellation.`);
      activeError.code = 'cursor_cancel_unconfirmed';
      lastError = activeError;
    }
  } catch (error) {
    lastError = error;
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

function cloudCreateOptions(task, { apiKey, agentId, repoUrl, startingRef } = {}) {
  return {
    apiKey,
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
}

function assertExactRunIdentity(run, agentId, expectedRequestId) {
  if (!run || typeof run.id !== 'string' || run.id.length === 0 || typeof run.wait !== 'function') {
    fail('cursor_cloud_dispatch_uncertain', 'Cursor Cloud did not return a usable run handle.');
  }
  if (run.agentId !== undefined && run.agentId !== agentId) {
    fail('cursor_run_identity_mismatch', 'Cursor Cloud returned a run for a different agent identity.');
  }
  if (expectedRequestId && run.requestId !== undefined && run.requestId !== expectedRequestId) {
    fail('cursor_run_identity_mismatch', 'Cursor Cloud returned a run for a different idempotency identity.');
  }
  return run;
}

/**
 * The public SDK exposes Idempotency-Key on Agent.create. Replaying the exact
 * create request with the same agent and run key is the only supported lookup
 * for a response lost after provider acceptance. Never fall back to a latest
 * run or an unkeyed list match: those are not deterministic identities.
 */
async function recoverExactRun({ client, task, key, prompt, deadlineAt }) {
  if (!task.provider_agent_id || !task.run_idempotency_key) {
    fail('cursor_run_identity_missing', 'Cursor Cloud cannot recover a dispatch without its exact agent and idempotency identities.');
  }
  if (typeof client?.Agent?.listRuns === 'function') {
    let listed;
    try {
      listed = await deadlineCall(
        deadlineAt,
        () => client.Agent.listRuns(task.provider_agent_id, { runtime: 'cloud', apiKey: key, limit: 100 }),
        'dispatch identity lookup',
      );
    } catch {
      listed = null;
    }
    if (listed !== null) {
      if (!Array.isArray(listed?.items)) {
        fail('cursor_cloud_dispatch_uncertain', 'Cursor Cloud returned an invalid run listing during dispatch recovery.');
      }
      const matches = listed.items.filter((entry) => entry?.requestId === task.run_idempotency_key);
      if (matches.length > 1) {
        fail('cursor_run_identity_ambiguous', 'Cursor Cloud returned multiple runs for the exact dispatch idempotency key.');
      }
      if (matches.length === 1) {
        const candidate = matches[0];
        if (candidate.agentId !== undefined && candidate.agentId !== task.provider_agent_id) {
          fail('cursor_run_identity_mismatch', 'Cursor Cloud returned a run for a different agent identity.');
        }
        if (typeof client.Agent.getRun === 'function') {
          try {
            const exact = await deadlineCall(
              deadlineAt,
              () => client.Agent.getRun(candidate.id, {
                runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
              }),
              'dispatch exact run confirmation',
            );
            return { agent: null, run: assertExactRunIdentity(exact, task.provider_agent_id, task.run_idempotency_key) };
          } catch {
            // Fall through to the same-key idempotent replay below. A failed
            // confirmation must never turn a partial list entry into a run.
          }
        } else {
          return { agent: null, run: assertExactRunIdentity(candidate, task.provider_agent_id, task.run_idempotency_key) };
        }
      }
    }
  }
  if (!task.provider_repo_url || !task.starting_ref) {
    fail('cursor_run_identity_missing', 'Cursor Cloud cannot replay a dispatch without its exact repository and commit identities.');
  }
  if (typeof client?.Agent?.create !== 'function') {
    fail('cursor_cloud_dispatch_uncertain', 'The installed Cursor SDK does not expose deterministic idempotent dispatch recovery.');
  }
  const recoveryAgent = await deadlineCall(
    deadlineAt,
    () => client.Agent.create(cloudCreateOptions(task, {
      apiKey: key,
      agentId: task.provider_agent_id,
      repoUrl: task.provider_repo_url,
      startingRef: task.starting_ref,
    })),
    'dispatch recovery agent creation',
  );
  try {
    if (!recoveryAgent || typeof recoveryAgent.send !== 'function') {
      fail('cursor_cloud_dispatch_uncertain', 'Cursor Cloud recovery did not return a send-capable agent.');
    }
    const recovered = await deadlineCall(
      deadlineAt,
      () => recoveryAgent.send(prompt, {
        mode: task.role === 'review' ? 'plan' : 'agent',
        idempotencyKey: task.run_idempotency_key,
      }),
      'dispatch recovery send',
    );
    return { agent: recoveryAgent, run: assertExactRunIdentity(recovered, task.provider_agent_id, task.run_idempotency_key) };
  } catch (error) {
    try { recoveryAgent.close?.(); } catch {}
    throw error;
  }
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
    const [rawRepoUrl, head] = await Promise.all([
      deadlineCall(deadlineAt, () => gitValue(task.cwd, ['remote', 'get-url', 'origin']), 'origin discovery'),
      deadlineCall(deadlineAt, () => gitValue(task.cwd, ['rev-parse', 'HEAD']), 'immutable head discovery'),
    ]);
    const repoUrl = providerRepoUrl(rawRepoUrl);
    const startingRef = task.starting_ref ?? head;
    if (!startingRef) fail('cursor_cloud_start_ref_unavailable', 'Cursor Cloud requires a starting reference.');
    if (!COMMIT_SHA.test(startingRef)) {
      fail('cursor_cloud_start_ref_invalid', 'Cursor Cloud tasks require a full 40-character commit startingRef.');
    }
    await assertDispatchable(root, taskId, signal, 'startup');
    const started = await updateTask(root, taskId, {
      status: 'starting',
      transport: 'cursor-sdk',
      provider_agent_id: agentId,
      provider_repo_url: repoUrl,
      starting_ref: startingRef,
      started_at: new Date().toISOString(),
    });
    if (started.status !== 'starting' || started.provider_agent_id !== agentId) {
      fail('cancelled', 'Task cancellation won the Cursor Cloud startup race.');
    }
    const createOptions = cloudCreateOptions(task, {
      apiKey: key,
      agentId,
      repoUrl,
      startingRef,
    });
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
      try {
        const recovered = await recoverExactRun({
          client,
          task: {
            ...task,
            provider_agent_id: agentId,
            provider_repo_url: repoUrl,
            starting_ref: startingRef,
            run_idempotency_key: runIdempotencyKey,
          },
          key,
          prompt,
          deadlineAt,
        });
        if (agent && agent !== recovered.agent) {
          try { agent.close?.(); } catch {}
        }
        agent = recovered.agent;
        run = recovered.run;
        dispatchUncertain = false;
      } catch (recoveryError) {
        throw uncertainDispatchError(recoveryError);
      }
    }
    assertExactRunIdentity(run, agentId);
    const registered = await updateTask(root, taskId, { provider_run_id: run.id });
    if (signal?.aborted || ['cancelling', 'transport_lost', 'cancelled', 'completed', 'failed', 'timeout'].includes(registered.status)) {
      fail('cancelled', 'Task cancellation won the Cursor Cloud run-registration race.');
    }
    const running = await updateTask(root, taskId, {
      status: 'running',
      provider_run_id: run.id,
    });
    if (running.status !== 'running') fail('transport_lost', 'Cursor Cloud run could not be registered in the task receipt.');
    await appendTaskEvent(root, taskId, { type: 'transport', state: 'prompt_dispatched', transport: 'cursor-sdk', agent_id: agentId, run_id: run.id });
    const stopRemote = () => {
      if (!stopPromise) stopPromise = stopRemoteRun(client, { ...task, provider_agent_id: agentId }, key, run, waitPromise);
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
    if (result?.id !== undefined && result.id !== run.id) {
      fail('cursor_run_identity_mismatch', 'Cursor Cloud returned a different run identity at completion.');
    }
    const status = result.status === 'finished' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    const providerSecrets = [key, prompt];
    const sanitizedBranches = sanitizeProviderValue(result.git?.branches ?? [], providerSecrets);
    const branches = Array.isArray(sanitizedBranches) ? sanitizedBranches : [];
    const providerResult = sanitizeProviderValue(
      typeof result.result === 'string' ? result.result.slice(0, 4096) : null,
      providerSecrets,
    );
    const providerError = sanitizeProviderValue(result.error ?? null, providerSecrets);
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
      result: providerResult,
      provider_error: providerError,
      branches,
      pr_url: branches.find((entry) => entry?.prUrl)?.prUrl ?? null,
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
        if (current.provider_run_cancelled === true && current.provider_run_id === run.id) {
          remoteStopped = true;
        } else {
          if (stopPromise) await stopPromise;
          else await stopRemoteRun(client, current, key, run, waitPromise);
          remoteStopped = true;
        }
      } catch (cleanupError) {
        stopError = cleanupError;
        remoteStopped = false;
      }
    }
    let archived = false;
    if (agent && remoteStopped && current.provider_agent_archived !== true) {
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
    const preservedStatus = new Set(['completed', 'failed', 'cancelled', 'timeout', 'transport_lost']);
    const status = uncertain
      ? 'transport_lost'
      : preservedStatus.has(current.status)
        ? current.status
        : signal?.aborted || current.status === 'cancelling'
          ? 'cancelled'
          : timedOut
            ? 'timeout'
            : 'failed';
    const providerSecrets = [key, prompt];
    const existingFailure = current.status === 'transport_lost' && current.error
      ? current.error
      : null;
    const failure = uncertain
      ? publicError(Object.assign(new Error('Cursor Cloud remote state could not be confirmed; reconcile or cancel this task before retrying.', { cause: stopError ?? error }), { code: 'cursor_cloud_remote_state_uncertain' }), providerSecrets)
      : existingFailure ?? publicError(error, providerSecrets);
    const changes = {
      status,
      error: failure,
      fallback_safe: current.prompt_dispatched !== true,
      ...(agent && remoteStopped && current.provider_agent_archived !== true ? { provider_agent_archived: archived } : {}),
      ...(!uncertain && status !== 'transport_lost' ? { finished_at: new Date().toISOString() } : {}),
    };
    await updateTask(root, taskId, changes).catch(() => {});
    await appendTaskEvent(root, taskId, {
      type: uncertain || status === 'transport_lost' ? 'transport_lost' : 'terminal',
      status,
      error: failure,
    }).catch(() => {});
    throw sanitizedThrown(error, undefined, providerSecrets);
  } finally {
    removeAbortListener?.();
    try { agent?.close?.(); } catch {}
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

export async function cancelCursorCloudTask({ root, taskId, sdk, apiKey, loadSdk = loadCursorSdk, loadKey = loadCursorApiKey } = {}) {
  const { task: initialTask } = await readTask(root, taskId);
  let task = initialTask;
  if (task.provider !== 'cursor-cloud') fail('invalid_provider', 'Task is not a Cursor Cloud task.');
  if (!task.provider_agent_id) {
    if (task.prompt_dispatched) {
      const failure = { code: 'cursor_cancel_unconfirmed', message: 'Cursor Cloud dispatch was recorded without an agent identity; the task must be reconciled before retrying.' };
      await updateTask(root, taskId, { status: 'transport_lost', cancel_requested: true, error: failure }).catch(() => {});
      fail(failure.code, failure.message);
    }
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', transport: 'cursor-sdk' });
    return updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
  }
  const deadlineAt = Date.now() + CANCEL_TIMEOUT_MS;
  let client;
  let key;
  try {
    client = sdk ?? await boundedCall(() => loadSdk(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_cancel_unconfirmed', 'Cursor SDK loading did not finish during cancellation.');
    key = apiKey ?? await boundedCall(() => loadKey(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_cancel_unconfirmed', 'Cursor credential loading did not finish during cancellation.');
  } catch (error) {
    const safe = sanitizedThrown(error, 'cursor_cancel_unconfirmed');
    await updateTask(root, taskId, {
      status: 'transport_lost',
      cancel_requested: true,
      error: { code: safe.code, message: safe.message },
    }).catch(() => {});
    throw safe;
  }
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
  if (!task.provider_run_id && task.prompt_dispatched) {
    let prompt = '';
    try {
      prompt = await readPrompt(root, taskId);
      const recovered = await recoverExactRun({ client, task, key, prompt, deadlineAt });
      const registered = await updateTask(root, taskId, {
        provider_run_id: recovered.run.id,
        provider_agent_id: task.provider_agent_id,
      });
      task = { ...task, ...registered, provider_run_id: recovered.run.id };
      try { recovered.agent.close?.(); } catch {}
    } catch (error) {
      const failure = publicError(Object.assign(
        new Error('Cursor Cloud dispatch could not be recovered by its exact idempotency key.', { cause: error }),
        { code: 'cursor_cancel_unconfirmed' },
      ), [key, prompt]);
      await updateTask(root, taskId, {
        status: 'transport_lost',
        cancel_requested: true,
        error: failure,
      }).catch(() => {});
      throw sanitizedThrown(error, 'cursor_cancel_unconfirmed', [key, prompt]);
    }
  }
  let runs;
  const promptSecret = await readPrompt(root, taskId).catch(() => '');
  try {
    runs = await listRunsForCancellation(client, task, key, deadlineAt);
    for (const run of runs) {
      if (run?.agentId !== undefined && run.agentId !== task.provider_agent_id) {
        fail('cursor_cancel_unconfirmed', 'Cursor Cloud returned a run for a different agent identity.');
      }
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
    ), [key, promptSecret]);
    await updateTask(root, taskId, { status: 'transport_lost', cancel_requested: true, error: failure }).catch(() => {});
    throw sanitizedThrown(error, 'cursor_cancel_unconfirmed', [key, promptSecret]);
  }
  await updateTask(root, taskId, { provider_run_cancelled: true }).catch(() => {});
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
    provider_run_cancelled: true,
    provider_agent_archived: archived,
    finished_at: new Date().toISOString(),
  });
}

export async function reconcileCursorCloudTask({ root, taskId, sdk, apiKey, loadSdk = loadCursorSdk, loadKey = loadCursorApiKey } = {}) {
  let { task } = await readTask(root, taskId);
  if (task.provider !== 'cursor-cloud') return task;
  const deadlineAt = Date.now() + CANCEL_TIMEOUT_MS;
  let client;
  let key;
  try {
    client = sdk ?? await boundedCall(() => loadSdk(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_reconcile_failed', 'Cursor SDK loading did not finish during reconciliation.');
    key = apiKey ?? await boundedCall(() => loadKey(), PROVIDER_CALL_TIMEOUT_MS, 'cursor_reconcile_failed', 'Cursor credential loading did not finish during reconciliation.');
  } catch (error) {
    const safe = sanitizedThrown(error, 'cursor_reconcile_failed');
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: safe.code, message: safe.message },
    });
  }
  if (!task.provider_agent_id) {
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cursor_run_identity_missing', message: 'Cursor Cloud run identity is missing; do not replay this task. Cancel it or inspect the provider manually.' },
    });
  }
  const prompt = await readPrompt(root, taskId).catch(() => '');
  let recoveryAgent;
  let run;
  try {
    if (task.provider_run_id) {
      run = await boundedCall(
        () => client.Agent.getRun(task.provider_run_id, {
          runtime: 'cloud', agentId: task.provider_agent_id, apiKey: key,
        }),
        Math.min(PROVIDER_CALL_TIMEOUT_MS, remainingUntil(deadlineAt)),
        'cursor_reconcile_failed',
        'Cursor Cloud exact run lookup did not finish during reconciliation.',
      );
    } else {
      if (!task.prompt_dispatched || !task.run_idempotency_key) {
        return updateTask(root, taskId, {
          status: 'transport_lost',
          error: { code: 'cursor_run_identity_missing', message: 'Cursor Cloud run identity is missing; do not replay this task. Cancel it or inspect the provider manually.' },
        });
      }
      const recovered = await recoverExactRun({ client, task, key, prompt, deadlineAt });
      recoveryAgent = recovered.agent;
      run = recovered.run;
      const registered = await updateTask(root, taskId, { provider_run_id: run.id });
      task = { ...task, ...registered, provider_run_id: run.id };
    }
  } catch (error) {
    try { recoveryAgent?.close?.(); } catch {}
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: publicError(Object.assign(new Error('Cursor Cloud run could not be reconciled by its exact recorded identity.', { cause: error }), { code: 'cursor_reconcile_failed' }), [key, prompt]),
    });
  }
  if (!run) {
    try { recoveryAgent?.close?.(); } catch {}
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cursor_reconcile_failed', message: 'Cursor Cloud returned no exact run for the recorded run identity.' },
    });
  }
  if (run.id !== task.provider_run_id || (run.agentId && run.agentId !== task.provider_agent_id)) {
    try { recoveryAgent?.close?.(); } catch {}
    return updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cursor_run_identity_mismatch', message: 'Cursor Cloud returned a different run identity; do not replay this task.' },
    });
  }
  try {
    if (task.cancel_requested === true || task.status === 'cancelling') {
      try {
        await stopRemoteRun(client, task, key, run);
      } catch (error) {
        return updateTask(root, taskId, {
          status: 'transport_lost',
          error: publicError(Object.assign(new Error('Cursor Cloud cancellation could not be confirmed during reconciliation.', { cause: error }), { code: 'cursor_cancel_unconfirmed' }), [key, prompt]),
        });
      }
      await updateTask(root, taskId, { provider_run_cancelled: true }).catch(() => {});
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
        provider_run_id: run.id,
        provider_run_cancelled: true,
        provider_agent_archived: archived,
        finished_at: new Date().toISOString(),
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
        error: publicError(Object.assign(new Error('Cursor Cloud run completion could not be reconciled.', { cause: error }), { code: 'cursor_reconcile_failed' }), [key, prompt]),
      });
    }
    if (result?.id !== undefined && result.id !== run.id) {
      return updateTask(root, taskId, {
        status: 'transport_lost',
        error: { code: 'cursor_run_identity_mismatch', message: 'Cursor Cloud returned a different run identity at reconciliation completion.' },
      });
    }
    const status = result.status === 'finished' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    const providerSecrets = [key, prompt];
    const sanitizedBranches = sanitizeProviderValue(result.git?.branches ?? [], providerSecrets);
    const branches = Array.isArray(sanitizedBranches) ? sanitizedBranches : [];
    const providerResult = sanitizeProviderValue(
      typeof result.result === 'string' ? result.result.slice(0, 4096) : null,
      providerSecrets,
    );
    const providerError = sanitizeProviderValue(result.error ?? null, providerSecrets);
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
      result: providerResult,
      provider_error: providerError,
      branches,
      pr_url: branches.find((entry) => entry?.prUrl)?.prUrl ?? null,
      provider_agent_archived: archived,
      finished_at: new Date().toISOString(),
    });
  } finally {
    try { recoveryAgent?.close?.(); } catch {}
  }
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
