import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { appendTaskEvent, readPrompt, readTask, taskPaths, updateTask } from './task-store.mjs';

process.umask(0o077);

const RUNTIME_URL = new URL('../../assets/acpx-runtime.mjs', import.meta.url);
const SINGLE_TURN_FLOW = fileURLToPath(new URL('./single-turn.flow.mjs', import.meta.url));
const runFile = promisify(execFile);
const PROVIDERS = Object.freeze({
  grok: { agent: 'grok-build' },
  'cursor-local': { agent: 'cursor' },
  dsh: { agent: 'dsh', custom: true },
});
const MAX_ARG_COUNT = 64;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_EVENT_TEXT = 4 * 1024;
const MAX_CLI_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export class AcpWorkerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'AcpWorkerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AcpWorkerError(code, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireAbsoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail('invalid_worktree', 'Task cwd must be an absolute, normalized path.');
  }
  return value;
}

function normalizeArgv(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARG_COUNT) {
    fail('invalid_agent_argv', `agent_argv must contain 1-${MAX_ARG_COUNT} arguments.`);
  }
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.includes('\0'))) {
    fail('invalid_agent_argv', 'agent_argv entries must be non-empty strings without NUL.');
  }
  if (value.reduce((total, entry) => total + Buffer.byteLength(entry), 0) > MAX_ARG_BYTES) {
    fail('invalid_agent_argv', 'agent_argv exceeds its byte limit.');
  }
  return [...value];
}

function providerConfiguration(task) {
  const definition = PROVIDERS[task.provider];
  if (!definition) fail('unsupported_provider', `Unsupported ACP provider: ${task.provider}`);
  if (definition.custom) {
    return { agent: definition.agent, override: normalizeArgv(task.agent_argv) };
  }
  if (task.agent_argv !== undefined) {
    return { agent: definition.agent, override: normalizeArgv(task.agent_argv) };
  }
  return { agent: definition.agent, override: null };
}

function boundedEvent(event) {
  if (!plainObject(event)) return { type: 'status', text: String(event).slice(0, MAX_EVENT_TEXT) };
  const safe = { ...event };
  for (const key of ['text', 'title', 'status']) {
    if (typeof safe[key] === 'string' && safe[key].length > MAX_EVENT_TEXT) {
      safe[key] = `${safe[key].slice(0, MAX_EVENT_TEXT)}…`;
    }
  }
  delete safe.rawInput;
  delete safe.rawOutput;
  delete safe.content;
  delete safe.availableCommands;
  return safe;
}

function publicError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'acp_worker_failed',
    message: error instanceof Error ? error.message.slice(0, MAX_EVENT_TEXT) : 'ACP worker failed.',
  };
}

function sanitizeText(value, prompt) {
  let text = String(value ?? '');
  if (prompt) text = text.replaceAll(prompt, '[REDACTED_PROMPT]');
  return text
    .replace(/\b(?:sk|ghp|xai)[-_][A-Za-z0-9_-]{16,}\b/gu, '[REDACTED_TOKEN]')
    .replace(/\b(api[_-]?key|authorization)\s*[:=]\s*\S+/giu, '$1=[REDACTED]');
}

function processStartTicks(pid) {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] ?? null;
  } catch {
    return null;
  }
}

function signalChildGroup(child, signalName) {
  if (!Number.isInteger(child?.pid)) return;
  try { process.kill(-child.pid, signalName); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function childGroupAlive(child) {
  if (!Number.isInteger(child?.pid)) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function terminateChildGroup(child) {
  signalChildGroup(child, 'SIGTERM');
  for (let attempt = 0; attempt < 20 && childGroupAlive(child); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (childGroupAlive(child)) signalChildGroup(child, 'SIGKILL');
}

async function secureAcpxSessions() {
  const directory = path.join(process.env.HOME ? path.resolve(process.env.HOME) : homedir(), '.acpx', 'sessions');
  try {
    await chmod(path.dirname(directory), 0o700);
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile()) await chmod(path.join(directory, entry.name), 0o600);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function authenticationFailure(error) {
  const detail = `${error?.code ?? ''} ${error?.message ?? error} ${error?.stderrSummary ?? ''} ${error?.cause?.message ?? ''}`;
  return /not signed in|not authenticated|needs[_ -]?login|log ?in|unauthori[sz]ed|forbidden|credential|api[_ -]?key|\b40[13]\b/iu.test(detail);
}

function cliCommand(task, promptFile, prompt) {
  if (task.cli_argv) {
    return normalizeArgv(task.cli_argv).map((entry) => entry
      .replaceAll('${prompt_file}', promptFile)
      .replaceAll('${prompt}', prompt)
      .replaceAll('${cwd}', task.cwd));
  }
  if (task.provider === 'grok') return [
    process.env.CODEX_CO_ENGINEER_GROK_COMMAND ?? 'grok',
    '--cwd', task.cwd,
    '--always-approve',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'json',
    '--prompt-file', promptFile,
  ];
  if (task.provider === 'cursor-local') return [
    process.env.CODEX_CO_ENGINEER_CURSOR_COMMAND ?? 'cursor-agent',
    '-p',
    '--output-format', 'stream-json',
    '--stream-partial-output',
    '--force',
    '--sandbox', 'disabled',
    '--trust',
    '--workspace', task.cwd,
    prompt,
  ];
  if (task.provider === 'dsh') return [
    process.env.CODEX_CO_ENGINEER_DSH_COMMAND ?? 'dsh',
    '--profile', process.env.CODEX_CO_ENGINEER_DSH_PROFILE ?? 'headless',
    prompt,
  ];
  fail('unsupported_provider', `Unsupported CLI fallback provider: ${task.provider}`);
}

function extractedCliResult(stdout, prompt) {
  const safe = sanitizeText(stdout, prompt).trim();
  if (!safe) return null;
  const lines = safe.split(/\r?\n/u).filter(Boolean);
  let collected = '';
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      const candidates = [value.result, value.text, value.message?.content, value.content?.text, value.delta?.text];
      for (const candidate of candidates) {
        if (typeof candidate === 'string') collected = `${collected}${candidate}`.slice(-MAX_EVENT_TEXT);
      }
    } catch {
      collected = line.slice(-MAX_EVENT_TEXT);
    }
  }
  return (collected || safe).slice(-MAX_EVENT_TEXT);
}

export async function runCliFallback({ root, task, prompt, signal } = {}) {
  if (signal?.aborted) fail('cancelled', 'CLI fallback was cancelled before startup.');
  const promptFile = path.join(taskPaths(root, task.id).directory, `cli-prompt-${randomUUID()}.txt`);
  await writeFile(promptFile, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const argv = cliCommand(task, promptFile, prompt);
  let child;
  let stdout = '';
  let stderr = '';
  let timer;
  let termination;
  let timedOut = false;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: task.cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const spawned = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const closed = new Promise((resolve) => {
      child.once('close', (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_CLI_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_CLI_OUTPUT / 4); });
    const cancel = () => {
      termination ??= terminateChildGroup(child);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    await spawned;
    await updateTask(root, task.id, {
      status: 'running',
      transport: 'cli',
      fallback_from: 'acp',
      prompt_dispatched: true,
      provider_process_group: child.pid,
      provider_process_start_ticks: processStartTicks(child.pid),
      started_at: new Date().toISOString(),
    });
    await appendTaskEvent(root, task.id, { type: 'transport', state: 'prompt_dispatched', transport: 'cli', fallback_from: 'acp' });
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, task.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    const exit = await closed;
    await termination;
    signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) fail('cancelled', 'CLI fallback was cancelled.');
    if (timedOut) fail('timeout', 'CLI fallback exceeded its task deadline.');
    const result = extractedCliResult(stdout, prompt);
    if (exit.code !== 0) {
      const detail = sanitizeText(stderr || stdout || `CLI exited ${exit.code ?? exit.signal}.`, prompt).slice(-MAX_EVENT_TEXT);
      fail(authenticationFailure(detail) ? 'needs_login' : 'cli_failed', detail);
    }
    const compact = { type: 'text_delta', text: result ?? 'CLI fallback completed.' };
    await appendTaskEvent(root, task.id, { type: 'provider', event: compact });
    await appendTaskEvent(root, task.id, { type: 'terminal', status: 'completed' });
    return updateTask(root, task.id, {
      status: 'completed',
      result,
      last_event: compact,
      provider_process_group: null,
      provider_process_start_ticks: null,
      fallback_safe: false,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    const failure = publicError(error);
    await appendTaskEvent(root, task.id, { type: 'terminal', status: signal?.aborted ? 'cancelled' : 'failed', error: failure }).catch(() => {});
    await updateTask(root, task.id, {
      status: signal?.aborted ? 'cancelled' : 'failed',
      error: failure,
      provider_process_group: null,
      provider_process_start_ticks: null,
      fallback_safe: false,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    if (child && childGroupAlive(child)) await terminateChildGroup(child);
    await rm(promptFile, { force: true });
  }
}

function commandString(argv) {
  return argv.map((entry) => `'${entry.replaceAll("'", "'\\''")}'`).join(' ');
}

function parseFlowResult(stdout) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value?.action === 'flow_run_result') return value;
    } catch {
      // Ignore non-JSON progress; --json-strict should normally prevent it.
    }
  }
  fail('acpx_invalid_result', 'ACPX did not return a flow result.');
}

async function runDshFlow({ root, task, prompt, cwd, configuration, timeoutMs, signal }) {
  if (signal?.aborted) fail('cancelled', 'DSH ACP task was cancelled before startup.');
  const inputFile = path.join(taskPaths(root, task.id).directory, `flow-input-${randomUUID()}.json`);
  await writeFile(inputFile, `${JSON.stringify({ prompt })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const argv = [
    '--agent', commandString(configuration.override),
    '--cwd', cwd,
    '--approve-all',
    '--format', 'json',
    '--json-strict',
    '--timeout', String(timeoutSeconds),
    'flow', 'run', SINGLE_TURN_FLOW,
    '--input-file', inputFile,
  ];
  let child;
  let stdout = '';
  let stderr = '';
  let termination;
  try {
    await updateTask(root, task.id, { status: 'starting', transport: 'acp', acp_client: 'acpx-cli', started_at: new Date().toISOString() });
    child = spawn(process.env.CODEX_CO_ENGINEER_ACPX_COMMAND ?? 'acpx', argv, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const spawned = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const closed = new Promise((resolve) => {
      child.once('close', (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-256 * 1024); });
    const cancel = () => {
      termination ??= terminateChildGroup(child);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    await spawned;
    await updateTask(root, task.id, {
      status: 'running',
      dispatch_intent: true,
      prompt_dispatched: true,
      fallback_safe: false,
      request_id: randomUUID(),
      provider_process_group: child.pid,
      provider_process_start_ticks: processStartTicks(child.pid),
    });
    await appendTaskEvent(root, task.id, { type: 'transport', state: 'prompt_dispatched', transport: 'acp', client: 'acpx-cli' });
    const exit = await closed;
    await termination;
    signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) fail('cancelled', 'DSH ACP task was cancelled.');
    if (exit.code !== 0) {
      const detail = stderr.trim() || stdout.trim() || `ACPX exited ${exit.code ?? exit.signal}`;
      fail('acpx_failed', detail.slice(-MAX_EVENT_TEXT));
    }
    const flow = parseFlowResult(stdout);
    if (flow.status !== 'completed') fail('acpx_failed', `ACPX flow ended in ${flow.status}.`);
    const rawOutput = flow.outputs?.delegate;
    const outputValue = typeof rawOutput === 'string'
      ? rawOutput
      : rawOutput?.text ?? rawOutput?.result ?? rawOutput?.output;
    const output = typeof outputValue === 'string' ? outputValue.slice(0, MAX_EVENT_TEXT) : null;
    const compact = { type: 'text_delta', text: output ?? 'DSH ACP task completed.' };
    await appendTaskEvent(root, task.id, { type: 'provider', event: compact });
    await appendTaskEvent(root, task.id, { type: 'terminal', status: 'completed', stop_reason: 'end_turn' });
    return updateTask(root, task.id, {
      status: 'completed',
      stop_reason: 'end_turn',
      last_event: compact,
      result: output,
      provider_process_group: null,
      provider_process_start_ticks: null,
      acp_session_id: Object.values(flow.sessionBindings ?? {})[0]?.acpSessionId ?? null,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    const current = (await readTask(root, task.id)).task;
    if (current.prompt_dispatched !== true && current.dispatch_intent !== true && !authenticationFailure(error)) {
      await updateTask(root, task.id, {
        status: 'starting',
        acp_error: publicError(error),
        fallback_safe: true,
        provider_process_group: null,
        provider_process_start_ticks: null,
      }).catch(() => {});
      throw error;
    }
    const status = signal?.aborted ? 'cancelled' : 'failed';
    const failure = publicError(error);
    await appendTaskEvent(root, task.id, { type: 'terminal', status, error: failure }).catch(() => {});
    await updateTask(root, task.id, {
      status,
      error: failure,
      provider_process_group: null,
      provider_process_start_ticks: null,
      fallback_safe: current.prompt_dispatched !== true,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    throw error;
  } finally {
    if (child && childGroupAlive(child)) await terminateChildGroup(child);
    await secureAcpxSessions();
    await rm(inputFile, { force: true });
  }
}

async function makeRuntime({ root, cwd, configuration, timeoutMs }) {
  const stateDir = path.join(path.resolve(root), 'acp');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = await import(RUNTIME_URL.href);
  const overrides = configuration.override ? { [configuration.agent]: configuration.override } : undefined;
  return createAcpRuntime({
    cwd,
    sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry(overrides ? { overrides } : {}),
    mcpServers: [],
    permissionMode: 'approve-all',
    timeoutMs,
  });
}

/**
 * Run one task through ACP. The task prompt is read from the owner-only task
 * store, so it never appears in argv or the public task record.
 */
export async function runAcpTask({ root, taskId, signal } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('invalid_state_dir', 'root must be absolute.');
  const { task } = await readTask(root, taskId);
  if (!['accepted', 'transport_lost'].includes(task.status)) {
    fail('invalid_task_state', `Task ${taskId} cannot start from ${task.status}.`);
  }
  const cwd = requireAbsoluteDirectory(task.cwd);
  const prompt = await readPrompt(root, taskId);
  const configuration = providerConfiguration(task);
  const timeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) fail('invalid_timeout', 'timeout_ms must be at least 1000.');

  if (task.provider === 'dsh') {
    try {
      return await runDshFlow({ root, task, prompt, cwd, configuration, timeoutMs, signal });
    } catch (error) {
      const current = (await readTask(root, taskId)).task;
      if (current.prompt_dispatched !== true && current.dispatch_intent !== true && !authenticationFailure(error)) {
        await appendTaskEvent(root, taskId, {
          type: 'transport',
          state: 'acp_failed_before_dispatch',
          fallback: 'cli',
          error: publicError(error),
        }).catch(() => {});
        await updateTask(root, taskId, { status: 'starting', fallback_from: 'acp', acp_error: publicError(error) });
        return runCliFallback({ root, task: { ...task, ...current }, prompt, signal });
      }
      throw error;
    }
  }

  const runtime = await makeRuntime({ root, cwd, configuration, timeoutMs });
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new AcpWorkerError('cancelled', 'Task cancelled.'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  let turn;
  let handle;
  try {
    await updateTask(root, taskId, { status: 'starting', transport: 'acp', started_at: new Date().toISOString() });
    handle = await runtime.ensureSession({
      sessionKey: task.session_key ?? `${task.provider}:${task.id}`,
      agent: configuration.agent,
      mode: 'persistent',
      cwd,
    });
    await updateTask(root, taskId, {
      status: 'running',
      acp_session_id: handle.backendSessionId ?? handle.agentSessionId ?? null,
    });
    await appendTaskEvent(root, taskId, { type: 'transport', state: 'session_ready', transport: 'acp' });

    const requestId = task.request_id ?? randomUUID();
    await updateTask(root, taskId, { dispatch_intent: true, fallback_safe: false, request_id: requestId });
    turn = runtime.startTurn({
      handle,
      text: prompt,
      mode: 'prompt',
      requestId,
      timeoutMs,
      signal: controller.signal,
    });
    // From this point onward the provider may have accepted the prompt. A
    // supervisor must reconcile this task, never replay it through CLI.
    await updateTask(root, taskId, { prompt_dispatched: true });
    const cancel = () => turn.cancel({ reason: 'signal' }).catch(() => {});
    controller.signal.addEventListener('abort', cancel, { once: true });
    let lastEvent = null;
    let output = '';
    try {
      for await (const event of turn.events) {
        const compact = boundedEvent(event);
        await appendTaskEvent(root, taskId, { type: 'provider', event: compact });
        lastEvent = compact;
        if (compact.type === 'text_delta' && compact.stream !== 'thought' && typeof compact.text === 'string') {
          output = `${output}${compact.text}`.slice(-MAX_EVENT_TEXT);
        }
      }
    } finally {
      controller.signal.removeEventListener('abort', cancel);
    }

    const result = await turn.result;
    const status = result.status === 'completed' ? 'completed' : result.status;
    const terminal = await updateTask(root, taskId, {
      status,
      stop_reason: result.stopReason ?? null,
      last_event: lastEvent,
      result: output || null,
      ...(result.status === 'failed' ? { error: publicError(result.error), fallback_safe: false } : {}),
      finished_at: new Date().toISOString(),
    });
    await appendTaskEvent(root, taskId, { type: 'terminal', status, stop_reason: result.stopReason ?? null });
    return terminal;
  } catch (error) {
    const failure = publicError(error);
    const current = (await readTask(root, taskId)).task;
    if (current.prompt_dispatched !== true && current.dispatch_intent !== true && !authenticationFailure(error)) {
      await appendTaskEvent(root, taskId, {
        type: 'transport',
        state: 'acp_failed_before_dispatch',
        fallback: 'cli',
        error: failure,
      }).catch(() => {});
      await updateTask(root, taskId, {
        status: 'starting',
        fallback_from: 'acp',
        acp_error: failure,
      });
      return runCliFallback({ root, task: { ...task, ...current }, prompt, signal });
    }
    const status = controller.signal.aborted ? 'cancelled' : 'failed';
    await updateTask(root, taskId, {
      status,
      error: failure,
      finished_at: new Date().toISOString(),
      fallback_safe: current.prompt_dispatched !== true,
    }).catch(() => {});
    await appendTaskEvent(root, taskId, { type: 'terminal', status, error: failure }).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    // This closes the retained stdio client but does not send session/close or
    // discard the persisted ACP identity. A later worker can resume it.
    if (handle) await runtime.close({ handle, reason: 'worker_exit' }).catch(() => {});
    await secureAcpxSessions();
  }
}

async function runCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--request') {
    process.stderr.write('Usage: node acp-worker.mjs --request /absolute/path/to/request.json\n');
    process.exitCode = 2;
    return;
  }
  const requestPath = argv[1];
  if (!path.isAbsolute(requestPath)) fail('invalid_request', 'Request path must be absolute.');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  if (process.env.WORKTREE_BOOTSTRAP_TASK) {
    await runFile('worktree-bootstrap', [
      'verify',
      process.env.WORKTREE_BOOTSTRAP_TASK,
      '--repo',
      process.cwd(),
      '--require-writer',
    ]);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new AcpWorkerError('cancelled', 'Worker signal received.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    let task = await runAcpTask({ root: request.root, taskId: request.task_id, signal: controller.signal });
    if (process.env.WORKTREE_BOOTSTRAP_TASK) {
      try {
        const { stdout } = await runFile('worktree-bootstrap', [
          'handoff',
          process.env.WORKTREE_BOOTSTRAP_TASK,
          '--repo',
          process.cwd(),
          '--format',
          'json',
        ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
        const handoff = JSON.parse(stdout);
        task = await updateTask(request.root, request.task_id, { handoff });
      } catch (error) {
        await appendTaskEvent(request.root, request.task_id, {
          type: 'cleanup_warning',
          code: error?.code ?? 'handoff_failed',
        }).catch(() => {});
      }
    }
    process.stdout.write(`${JSON.stringify({ task_id: task.id, status: task.status })}\n`);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    const failure = publicError(error);
    process.stderr.write(`acp-worker: ${failure.code}: ${failure.message}\n`);
    process.exitCode = 1;
  });
}
