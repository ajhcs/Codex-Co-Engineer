import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, watch as watchDirectory } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  applyClosedProviderTestInjection,
  collectLaneSecrets,
  denyWorkerRemoteMutation,
  projectProviderEnvironment,
  redactExactValues,
} from './credential-boundary.mjs';
import {
  collectCliProviderOutputV1,
  contentFreeSinkFailureV1,
  createLocalProviderResultCollectorV1,
  localProviderResultIdentityFromTaskV1,
  openLocalProviderArtifactStoreV1,
  sinkLocalProviderResultV1,
} from './local-provider-result-sink.mjs';
import {
  elicitationContentFromReply,
  elicitationOptions,
  eventsHaveUnsupportedAskUserQuestion,
  isAskUserQuestionName,
  isStructuredAskUserQuestionUnsupported,
  liveQuestionId,
  questionBridgeUnavailableError,
} from './grok-question-bridge.mjs';
import { recordNeedsAttention, replyDecision, waitForReply } from './mailbox.mjs';
import { boundedProviderResult, boundedProviderValue, createProviderResultAccumulator, providerCharCount } from './provider-result.mjs';
import { RunContractV1Error } from './run-manifest.mjs';
import { BUNDLED_WORKTREE_BOOTSTRAP } from './worktree-bootstrap-runtime.mjs';
import { appendTaskEvent, readPrompt, readRuntimeRecord, readTask, taskPaths, updateTask } from './task-store.mjs';

process.umask(0o077);

const RUNTIME_URL = new URL('../../assets/acpx-runtime.mjs', import.meta.url);
const runFile = promisify(execFile);
const PROVIDERS = Object.freeze({
  grok: { agent: 'grok-build' },
  'cursor-local': { agent: 'cursor' },
  dsh: { agent: 'dsh', custom: true },
});
const MAX_ARG_COUNT = 64;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_EVENT_TEXT = 4 * 1024;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_EVENT_DEPTH = 6;
const MAX_EVENT_KEYS = 64;
const MAX_EVENT_ITEMS = 64;
const MAX_CLI_OUTPUT = 1024 * 1024;
const MAX_ACPX_EXEC_FRAME = 256 * 1024;
const MAX_ACPX_EXEC_STDERR = 64 * 1024;
const MAX_ACPX_EXEC_EVENTS = 256;
const MAX_GROK_FINAL_TOOL_IDS = 512;
const DEFAULT_DSH_MODEL = 'meta/muse-spark-1.3-contributor';

const PROCESS_LIST_MAX_BUFFER = 4 * 1024 * 1024;
const ACPX_TERMINATION_GRACE_MS = 1_000;
const ACPX_TERMINATION_POLL_MS = 25;
export const ACP_RESOURCE_CLOSE_MS = 3_000;
export const WTB_HANDOFF_MS = 5_000;
export const WORKER_EXIT_MS = 1_000;
export const WORKER_CLEANUP_CODES = Object.freeze({
  ACP_RESOURCE_CLOSE_TIMEOUT: 'acp_resource_close_timeout',
  ACP_RESOURCE_CLOSE_FAILED: 'acp_resource_close_failed',
  WORKER_EXIT_TIMEOUT: 'worker_exit_timeout',
  LOCK_RELEASE_UNPROVEN: 'lock_release_unproven',
  LOCK_CLEANUP_REFUSED: 'lock_cleanup_refused',
  CLEANUP_FAILED: 'cleanup_failed',
});
const WORKER_CLEANUP_CODE_SET = new Set(Object.values(WORKER_CLEANUP_CODES));
const ACP_CLOSE_STATES = new Set(['closed', 'timeout', 'failed', 'not_applicable']);
const WTB_HANDOFF_STATES = new Set(['recorded', 'timeout', 'failed', 'not_applicable']);
const OMIT_EVENT_KEYS = new Set(['rawinput', 'rawoutput', 'content', 'availablecommands']);
const SENSITIVE_EVENT_KEY = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|cookie|credential|private[_-]?key)/iu;
const TOKEN_PATTERNS = [
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:[A-Z][A-Z0-9]*_)*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH(?:ORIZATION)?|BEARER|CREDENTIALS?|PRIVATE[_-]?KEY)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;'"&]+)/giu,
  /\b(?:api[_-]?key|authorization|bearer|token|secret|password)\s*[:=]\s*["']?[^,\s"']+/giu,
];
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';

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

export function contentFreeCleanupCode(code) {
  const raw = typeof code === 'string' ? code : '';
  if (WORKER_CLEANUP_CODE_SET.has(raw)) return raw;
  return WORKER_CLEANUP_CODES.CLEANUP_FAILED;
}

export function workerSeamIncident(task) {
  const terminal = ['completed', 'failed', 'cancelled', 'timeout', 'environment_blocked'].includes(task?.status);
  const finished = typeof task?.finished_at === 'string' && task.finished_at.length > 0;
  const closeRecorded = task?.cleanup?.status === 'pending'
    || task?.cleanup?.status === 'normal'
    || task?.cleanup?.status === 'recovered';
  return terminal === true && finished === true && closeRecorded !== true;
}

export function composeWorkerCleanup(closeEvidence = {}, handoffEvidence = {}) {
  const acpClose = ACP_CLOSE_STATES.has(closeEvidence?.acp_close) ? closeEvidence.acp_close : 'not_applicable';
  const wtbHandoff = WTB_HANDOFF_STATES.has(handoffEvidence?.wtb_handoff)
    ? handoffEvidence.wtb_handoff
    : 'not_applicable';
  const codes = [];
  if (acpClose === 'timeout') codes.push(WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT);
  else if (acpClose === 'failed') codes.push(WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_FAILED);
  if (wtbHandoff === 'timeout') codes.push(WORKER_CLEANUP_CODES.LOCK_RELEASE_UNPROVEN);
  else if (wtbHandoff === 'failed') codes.push(WORKER_CLEANUP_CODES.CLEANUP_FAILED);
  if (Array.isArray(closeEvidence?.codes)) {
    for (const code of closeEvidence.codes) {
      const safe = contentFreeCleanupCode(code);
      if (!codes.includes(safe)) codes.push(safe);
    }
  }
  if (handoffEvidence?.code) {
    const safe = contentFreeCleanupCode(handoffEvidence.code);
    if (!codes.includes(safe)) codes.push(safe);
  }
  const cleanup = {
    status: 'pending',
    acp_close: acpClose,
    wtb_handoff: wtbHandoff,
  };
  if (codes[0]) cleanup.code = codes[0];
  return Object.freeze(cleanup);
}

export async function withBound(work, ms, code, message) {
  const timeoutMs = Number.isFinite(ms) && ms >= 1 ? ms : 1;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => (typeof work === 'function' ? work() : work)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new AcpWorkerError(code, message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeRetainedAcpResources({
  runtime = null,
  handle = null,
  child = null,
  stopDeadline = null,
  extraClosers = [],
  timeoutMs = ACP_RESOURCE_CLOSE_MS,
} = {}) {
  try { stopDeadline?.(); } catch { /* already closed */ }
  if (Array.isArray(extraClosers)) {
    for (const closer of extraClosers) {
      try { closer?.(); } catch { /* already closed */ }
    }
  }

  let acpClose = 'not_applicable';
  const codes = [];
  const mark = (state, code) => {
    acpClose = state;
    if (code && !codes.includes(code)) codes.push(code);
  };

  if (runtime && handle) {
    mark('closed', null);
    try {
      await withBound(
        () => runtime.close({ handle, reason: 'worker_exit', discardPersistentState: false }),
        timeoutMs,
        WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT,
        'ACP resource close exceeded 3s.',
      );
    } catch (error) {
      if (error?.code === WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT) {
        mark('timeout', WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT);
      } else {
        mark('failed', WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_FAILED);
      }
    }
  }

  if (child) {
    if (acpClose === 'not_applicable') mark('closed', null);
    try {
      const stopped = await withBound(
        () => Promise.resolve(requestChildTreeTermination(child)),
        timeoutMs,
        WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT,
        'Retained child tree close exceeded 3s.',
      );
      if (stopped === false) mark('failed', WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_FAILED);
    } catch (error) {
      if (error?.code === WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT) {
        mark('timeout', WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT);
      } else {
        mark('failed', WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_FAILED);
      }
    }
  }

  try {
    await secureAcpxSessions();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (acpClose === 'not_applicable') mark('failed', WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_FAILED);
    }
  }

  return Object.freeze({
    acp_close: acpClose,
    codes: Object.freeze([...codes]),
  });
}

export async function persistWorkerTerminal(root, taskId, patch, closeEvidence, handoffEvidence) {
  const cleanup = composeWorkerCleanup(closeEvidence, handoffEvidence);
  const nextPatch = { ...patch, cleanup };
  if (nextPatch.finished_at === undefined) nextPatch.finished_at = new Date().toISOString();
  const terminal = await updateTask(root, taskId, nextPatch);
  await appendTaskEvent(root, taskId, {
    type: 'terminal',
    status: terminal.status,
    ...(nextPatch.stop_reason !== undefined ? { stop_reason: nextPatch.stop_reason } : {}),
    ...(nextPatch.error ? { error: nextPatch.error } : {}),
  }).catch(() => {});
  await appendTaskEvent(root, taskId, {
    type: 'cleanup',
    status: cleanup.status,
    acp_close: cleanup.acp_close,
    wtb_handoff: cleanup.wtb_handoff,
    ...(cleanup.code ? { code: cleanup.code } : {}),
  }).catch(() => {});
  return terminal;
}

export function emitWorkerTerminalStdout(task, write = (chunk) => process.stdout.write(chunk)) {
  if (!plainObject(task) || typeof task.id !== 'string') {
    fail(WORKER_CLEANUP_CODES.CLEANUP_FAILED, 'Terminal stdout requires a recorded task.');
  }
  if (!plainObject(task.cleanup) || task.cleanup.status !== 'pending') {
    fail(WORKER_CLEANUP_CODES.CLEANUP_FAILED, 'Terminal stdout requires recorded close evidence.');
  }
  write(`${JSON.stringify({ task_id: task.id, status: task.status })}\n`);
}

export function requestWorkerExit(code = 0, {
  exitMs = WORKER_EXIT_MS,
  exit = (value) => { process.exit(value); },
  setTimeoutFn = setTimeout,
} = {}) {
  const timer = setTimeoutFn(() => {
    exit(code);
  }, Number.isFinite(exitMs) && exitMs >= 0 ? exitMs : WORKER_EXIT_MS);
  try { timer.unref?.(); } catch { /* ignore */ }
  exit(code);
  return timer;
}

export async function boundedWtbHandoff({
  root,
  taskId,
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = WTB_HANDOFF_MS,
  runFileImpl = runFile,
} = {}) {
  const taskName = env?.WORKTREE_BOOTSTRAP_TASK;
  if (typeof taskName !== 'string' || taskName.length === 0) {
    return Object.freeze({ attempted: false, wtb_handoff: 'not_applicable' });
  }
  const existing = await readTask(root, taskId).catch(() => ({ task: {} }));
  const closeEvidence = {
    acp_close: existing.task?.cleanup?.acp_close ?? 'not_applicable',
    codes: existing.task?.cleanup?.code ? [existing.task.cleanup.code] : [],
  };
  try {
    const { stdout } = await withBound(
      () => runFileImpl(BUNDLED_WORKTREE_BOOTSTRAP, [
        'handoff',
        taskName,
        '--repo',
        cwd,
        '--format',
        'json',
      ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      }),
      timeoutMs,
      WORKER_CLEANUP_CODES.LOCK_RELEASE_UNPROVEN,
      'WTB handoff exceeded 5s.',
    );
    const handoff = JSON.parse(stdout);
    if (!plainObject(handoff)) fail(WORKER_CLEANUP_CODES.CLEANUP_FAILED, 'WTB handoff was not an object.');
    const cleanup = composeWorkerCleanup(closeEvidence, { wtb_handoff: 'recorded' });
    const task = await updateTask(root, taskId, { handoff, cleanup });
    await appendTaskEvent(root, taskId, {
      type: 'cleanup',
      status: cleanup.status,
      acp_close: cleanup.acp_close,
      wtb_handoff: 'recorded',
    }).catch(() => {});
    return Object.freeze({ attempted: true, wtb_handoff: 'recorded', task, handoff });
  } catch (error) {
    const timedOut = error?.code === WORKER_CLEANUP_CODES.LOCK_RELEASE_UNPROVEN
      || error?.code === 'ETIMEDOUT'
      || error?.killed === true;
    const wtbHandoff = timedOut ? 'timeout' : 'failed';
    const cleanup = composeWorkerCleanup(closeEvidence, {
      wtb_handoff: wtbHandoff,
      code: timedOut
        ? WORKER_CLEANUP_CODES.LOCK_RELEASE_UNPROVEN
        : WORKER_CLEANUP_CODES.CLEANUP_FAILED,
    });
    const task = await updateTask(root, taskId, { cleanup }).catch(() => existing.task ?? null);
    await appendTaskEvent(root, taskId, {
      type: 'cleanup',
      status: cleanup.status,
      acp_close: cleanup.acp_close,
      wtb_handoff: wtbHandoff,
      code: cleanup.code,
    }).catch(() => {});
    return Object.freeze({
      attempted: true,
      wtb_handoff: wtbHandoff,
      task,
      code: cleanup.code,
    });
  }
}

export async function attachLocalProviderResultSink(
  root, task, source, sourceTruncated = false, overflow = false,
) {
  const identity = localProviderResultIdentityFromTaskV1(task);
  if (identity == null) return task;
  try {
    if (task?.status !== 'completed') {
      throw new RunContractV1Error('artifact_sink_not_published', 'sink',
        'The local provider result sink did not publish after provider terminal.');
    }
    if (overflow === true) {
      throw new RunContractV1Error('artifact_stream_over_cap', 'source',
        'The provider result exceeded the raw artifact class cap; nothing was published.');
    }
    const store = await openLocalProviderArtifactStoreV1(root);
    const receipt = await sinkLocalProviderResultV1(store, {
      ...identity,
      source,
      source_truncated: sourceTruncated === true,
    });
    return await updateTask(root, task.id, { provider_result_sink: receipt });
  } catch (error) {
    const evidence = contentFreeSinkFailureV1(error);
    try {
      return await updateTask(root, task.id, { provider_result_sink: evidence });
    } catch {
      return task;
    }
  }
}

function taskTimeoutMs(task, now = Date.now()) {
  const deadline = Date.parse(task?.deadline_at ?? '');
  if (Number.isFinite(deadline)) return Math.max(1, deadline - now);
  if (Number.isInteger(task?.timeout_ms) && task.timeout_ms >= 1) return task.timeout_ms;
  fail('invalid_timeout', 'Task is missing a recorded deadline.');
}

export function isUserFacingPermission(params) {
  const explicitQuestion = params?.raw?.question;
  if (typeof explicitQuestion === 'string' && explicitQuestion.trim().length > 0) return true;
  const questionTool = params?.raw?.toolCall;
  if (isAskUserQuestionName(questionTool?.title) || isAskUserQuestionName(questionTool?.toolCallId ?? questionTool?.id)) return true;
  const kind = params?.raw?.toolCall?.kind ?? params?.inferredKind;
  if (typeof kind === 'string' && kind !== 'other') return false;
  const title = String(params?.raw?.toolCall?.title ?? '').trim();
  return /^(?:user input|needs? attention|approval required|fake permission|confirm(?:ation)?(?: required)?)(?:\b|:|\?)/iu.test(title)
    || (title.endsWith('?') && !title.includes('$?'));
}

export function safeQuestionId(value) {
  const source = String(value ?? 'permission');
  const normalized = source.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^[^A-Za-z0-9]+/u, 'q') || 'permission';
  if (source === normalized && normalized.length <= 80) return normalized;
  const suffix = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16);
  return `${normalized.slice(0, 63)}-${suffix}`;
}

export async function handlePermissionRequest(root, taskId, params, signal) {
  if (!isUserFacingPermission(params)) return undefined;
  const { task } = await readTask(root, taskId);
  const sessionId = params.sessionId ?? task.acp_session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const questionId = safeQuestionId(params.raw?.toolCall?.toolCallId ?? randomUUID());
  const explicitQuestion = params.raw?.question;
  await recordNeedsAttention(root, taskId, {
    session_id: sessionId,
    question_id: questionId,
    prompt: typeof explicitQuestion === 'string' && explicitQuestion.trim().length > 0
      ? explicitQuestion
      : typeof params.raw?.toolCall?.title === 'string'
        ? params.raw.toolCall.title
        : 'Provider requested approval.',
    options: Array.isArray(params.raw?.options) ? params.raw.options : null,
    stage: 'provider_feedback',
  });
  const reply = await waitForReply(root, taskId, questionId, { signal });
  return replyDecision(reply, params.raw?.options ?? []);
}

async function handleElicitationRequest(root, taskId, params, signal) {
  const raw = params?.raw ?? params ?? {};
  const sessionId = params?.sessionId ?? raw.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { action: 'cancel' };
  }
  const questionId = safeQuestionId(
    raw.toolCallId ?? raw.elicitationId ?? raw.toolCall?.toolCallId ?? randomUUID(),
  );
  await recordNeedsAttention(root, taskId, {
    session_id: sessionId,
    question_id: questionId,
    prompt: typeof raw.message === 'string' ? raw.message : 'Provider requested a decision.',
    options: elicitationOptions(raw.requestedSchema),
    stage: 'provider_feedback',
  });
  const reply = await waitForReply(root, taskId, questionId, { signal });
  return {
    action: 'accept',
    content: elicitationContentFromReply(reply, raw.requestedSchema),
  };
}

function startDeadlineWatch(root, taskId, onTimeout) {
  let timer;
  let watcher;
  const arm = async () => {
    const { task } = await readTask(root, taskId);
    const remaining = taskTimeoutMs(task);
    clearTimeout(timer);
    if (remaining <= 1) {
      onTimeout();
      return;
    }
    timer = setTimeout(onTimeout, remaining);
  };
  try {
    watcher = watchDirectory(taskPaths(root, taskId).directory, { persistent: true }, () => {
      arm().catch(() => {});
    });
  } catch {
    watcher = null;
  }
  arm().catch(() => {});
  return () => {
    clearTimeout(timer);
    try { watcher?.close?.(); } catch { /* already closed */ }
  };
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

function rejectWorkerPushArgv(argv) {
  if (!Array.isArray(argv)) return argv;
  for (const arg of argv) {
    if (typeof arg === 'string' && /(?:pushurl|insteadof|--push-url|git\s+push|gh\s+pr)/iu.test(arg)) {
      denyWorkerRemoteMutation('push');
    }
  }
  return argv;
}

function providerConfiguration(task) {
  const definition = PROVIDERS[task.provider];
  if (!definition) fail('unsupported_provider', `Unsupported ACP provider: ${task.provider}`);
  if (task.create_pr === true) denyWorkerRemoteMutation('create_pr');
  if (definition.custom) {
    return { agent: definition.agent, override: rejectWorkerPushArgv(normalizeArgv(task.agent_argv)) };
  }
  if (task.agent_argv !== undefined) {
    return { agent: definition.agent, override: rejectWorkerPushArgv(normalizeArgv(task.agent_argv)) };
  }
  return { agent: definition.agent, override: null };
}

function boundedText(value, prompt, budget) {
  let text = sanitizeText(value, prompt);
  if (text.length > MAX_EVENT_TEXT) text = `${text.slice(0, MAX_EVENT_TEXT)}…`;
  if (text.length <= budget.remaining) {
    budget.remaining -= text.length;
    return text;
  }
  if (budget.remaining <= 0) return TRUNCATED;
  const clipped = text.slice(0, Math.max(0, budget.remaining - 1));
  budget.remaining = 0;
  return `${clipped}…`;
}

function boundedValue(value, prompt, budget, depth = 0, ancestors = new WeakSet()) {
  if (budget.remaining <= 0) return TRUNCATED;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return boundedText(value, prompt, budget);
  if (typeof value !== 'object') return boundedText(String(value), prompt, budget);
  if (ancestors.has(value)) return REDACTED;
  if (depth >= MAX_EVENT_DEPTH) return TRUNCATED;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const bounded = value
        .slice(0, MAX_EVENT_ITEMS)
        .map((entry) => boundedValue(entry, prompt, budget, depth + 1, ancestors));
      if (value.length > MAX_EVENT_ITEMS) bounded.push(TRUNCATED);
      return bounded;
    }
    const bounded = {};
    const entries = Object.entries(value);
    for (const [key, entry] of entries.slice(0, MAX_EVENT_KEYS)) {
      const normalizedKey = key.toLowerCase();
      if (OMIT_EVENT_KEYS.has(normalizedKey)) continue;
      const safeKey = key.slice(0, 128);
      if (SENSITIVE_EVENT_KEY.test(key)) bounded[safeKey] = REDACTED;
      else bounded[safeKey] = boundedValue(entry, prompt, budget, depth + 1, ancestors);
      if (budget.remaining <= 0) break;
    }
    if (entries.length > MAX_EVENT_KEYS && budget.remaining > 0) bounded._truncated = true;
    return bounded;
  } finally {
    ancestors.delete(value);
  }
}

export function boundedEvent(event, prompt = '') {
  const budget = { remaining: MAX_EVENT_BYTES };
  if (!plainObject(event)) return { type: 'status', text: boundedText(String(event), prompt, budget) };
  const safe = boundedValue(event, prompt, budget);
  return plainObject(safe) ? safe : { type: 'status', text: boundedText(safe, prompt, budget) };
}

/**
 * Follow Grok's native Messages reducer boundary: a completed client-tool
 * round closes the assistant frame and the final frame becomes `result`.
 * Source: https://github.com/xai-org/grok-build
 * Grok pager: src/headless/reducer/messages/mod.rs
 *
 * This projection is deliberately more conservative than xAI's formatter:
 * ambiguous/interleaved tool streams and every WebSearch fall back to the
 * complete provider stream because ACPX does not forward Grok's `_meta.backend`.
 */
export function createGrokFinalResponseReducerV1({ sanitize = (text) => text } = {}) {
  let currentOutput = createProviderResultAccumulator({ sanitize });
  let currentComplete = createLocalProviderResultCollectorV1();
  let currentHasNonWhitespace = false;
  const pendingToolIds = new Set();
  let sawSettledRound = false;
  let reliable = true;

  const resetCurrent = () => {
    currentOutput = createProviderResultAccumulator({ sanitize });
    currentComplete = createLocalProviderResultCollectorV1();
    currentHasNonWhitespace = false;
  };
  const toolId = (event) => (
    typeof event?.toolCallId === 'string' && event.toolCallId.length > 0 && event.toolCallId.length <= 512
      ? event.toolCallId
      : null
  );

  return {
    append(event) {
      if (event?.type === 'text_delta' && event.stream !== 'thought' && typeof event.text === 'string') {
        if (event.text.length > 0 && pendingToolIds.size > 0) reliable = false;
        currentOutput.append(event.text);
        currentComplete.append(event.text);
        currentHasNonWhitespace ||= /\S/u.test(event.text);
        return;
      }
      if (event?.type !== 'tool_call') return;
      if (event?.rawInput?.variant === 'WebSearch') reliable = false;
      const id = toolId(event);
      if (event.tag === 'tool_call') {
        if (id === null || pendingToolIds.has(id) || pendingToolIds.size >= MAX_GROK_FINAL_TOOL_IDS) {
          reliable = false;
          return;
        }
        pendingToolIds.add(id);
        return;
      }
      if (event.tag !== 'tool_call_update' || !['completed', 'failed'].includes(event.status)) return;
      if (id === null || !pendingToolIds.delete(id)) {
        reliable = false;
        return;
      }
      if (pendingToolIds.size > 0) {
        return;
      }
      sawSettledRound = true;
      resetCurrent();
    },
    finish({ turnResult, fullSnapshot }) {
      const eligible = reliable
        && sawSettledRound
        && pendingToolIds.size === 0
        && currentHasNonWhitespace
        && turnResult?.status === 'completed'
        && turnResult?.stopReason === 'end_turn'
        && fullSnapshot?.overflow !== true;
      if (!eligible) return null;
      const snapshot = currentComplete.snapshot();
      if (snapshot.overflow === true) return null;
      return Object.freeze({ bounded: currentOutput.finish(), snapshot });
    },
  };
}

export function publicError(error, prompt = '') {
  const rawCode = typeof error?.code === 'string' ? error.code : 'acp_worker_failed';
  const code = /^[A-Za-z0-9._-]{1,128}$/u.test(rawCode) ? rawCode : 'acp_worker_failed';
  const message = error instanceof Error ? error.message : 'ACP worker failed.';
  return {
    code,
    message: boundedText(message, prompt, { remaining: MAX_EVENT_TEXT }),
  };
}

export function sanitizeText(value, prompt) {
  let text = String(value ?? '');
  if (prompt) text = text.replaceAll(prompt, '[REDACTED_PROMPT]');
  text = redactExactValues(text, collectLaneSecrets(process.env));
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
  return text;
}

function providerChildEnvironment(task, extra = {}) {
  const env = projectProviderEnvironment({
    provider: task.provider,
    dshModel: task.dsh_model,
    source: process.env,
    operation: 'lane',
  });
  return Object.assign(env, extra);
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

function pidAlive(pid, expectedStartTicks) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  if (expectedStartTicks && processStartTicks(pid) !== expectedStartTicks) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function listDescendantPids(rootPid) {
  if (process.platform === 'win32' || !Number.isInteger(rootPid)) return [];
  try {
    const { stdout } = await runFile('ps', ['-eo', 'pid=,ppid='], {
      encoding: 'utf8',
      maxBuffer: PROCESS_LIST_MAX_BUFFER,
    });
    const childrenByParent = new Map();
    for (const line of stdout.split(/\r?\n/u)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
      if (!match) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(parent) || pid < 2 || parent < 2) continue;
      const children = childrenByParent.get(parent) ?? [];
      children.push(pid);
      childrenByParent.set(parent, children);
    }
    const descendants = [];
    const pending = [...(childrenByParent.get(rootPid) ?? [])];
    for (let index = 0; index < pending.length; index += 1) {
      const pid = pending[index];
      descendants.push(pid);
      pending.push(...(childrenByParent.get(pid) ?? []));
    }
    return descendants;
  } catch {
    return [];
  }
}

async function rememberDescendantPids(child, descendants) {
  for (const pid of await listDescendantPids(child?.pid)) {
    if (!descendants.has(pid)) descendants.set(pid, processStartTicks(pid));
  }
}

function childTreeAlive(child, descendants) {
  if (childGroupAlive(child)) return true;
  for (const [pid, startTicks] of descendants) {
    if (pidAlive(pid, startTicks)) return true;
    descendants.delete(pid);
  }
  return false;
}

async function signalChildTree(child, descendants, signalName) {
  await rememberDescendantPids(child, descendants);
  signalChildGroup(child, signalName);
  for (const [pid, startTicks] of descendants) {
    if (!pidAlive(pid, startTicks)) continue;
    try { process.kill(pid, signalName); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

async function waitForChildTreeExit(child, descendants, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (childTreeAlive(child, descendants)) {
    await rememberDescendantPids(child, descendants);
    if (Date.now() >= deadline) return !childTreeAlive(child, descendants);
    await new Promise((resolve) => setTimeout(resolve, ACPX_TERMINATION_POLL_MS));
  }
  return true;
}

async function terminateChildTree(child) {
  const descendants = new Map();
  await signalChildTree(child, descendants, 'SIGTERM');
  if (await waitForChildTreeExit(child, descendants, ACPX_TERMINATION_GRACE_MS)) return true;
  await signalChildTree(child, descendants, 'SIGKILL');
  return waitForChildTreeExit(child, descendants, ACPX_TERMINATION_GRACE_MS);
}

function requestChildTreeTermination(child) {
  return terminateChildTree(child).catch(() => false);
}

async function secureAcpxSessions(home = undefined) {
  const homeDirectory = home
    ? path.resolve(home)
    : process.env.HOME ? path.resolve(process.env.HOME) : homedir();
  const directory = path.join(homeDirectory, '.acpx', 'sessions');
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

async function removeAcpxTaskHome(root, taskId, home) {
  try {
    await rm(home, { recursive: true, force: true });
  } catch (error) {
    await appendTaskEvent(root, taskId, {
      type: 'cleanup_warning',
      transport: 'acp',
      code: 'acpx_artifact_cleanup_failed',
      error: { code: error?.code ?? 'cleanup_failed' },
    }).catch(() => {});
  }
}

function acpxTaskEnvironment(home, task) {
  const env = providerChildEnvironment(task, { HOME: home });
  if (process.platform === 'win32') env.USERPROFILE = home;
  return applyClosedProviderTestInjection(env);
}

async function awaitSupervisorRegistration(root, taskId, signal) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (signal?.aborted) fail('cancelled', 'Task was cancelled before worker registration.');
    const { task } = await readTask(root, taskId);
    if (task.status !== 'accepted') {
      fail(task.status === 'cancelling' || task.status === 'cancelled' ? 'cancelled' : 'transport_lost', `Task cannot start from ${task.status}.`);
    }
    if (await readRuntimeRecord(root, taskId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fail('worker_registration_timeout', 'Supervisor did not register the worker before dispatch.');
}

async function removeStalePromptTransports(root, taskId) {
  const directory = taskPaths(root, taskId).directory;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:cli-prompt-|flow-input-)/u.test(entry.name)) {
      await rm(path.join(directory, entry.name), { force: true });
    }
  }
}

function authenticationFailure(error) {
  const detail = `${error?.code ?? ''} ${error?.message ?? error} ${error?.stderrSummary ?? ''} ${error?.cause?.message ?? ''}`;
  return /not signed in|not authenticated|needs[_ -]?login|log ?in|unauthori[sz]ed|forbidden|credential|api[_ -]?key|\b40[13]\b/iu.test(detail);
}

function fallbackStartAllowed(task) {
  return ['accepted', 'starting'].includes(task?.status)
    && task.prompt_dispatched !== true
    && task.dispatch_intent !== true
    && task.dispatch_uncertain !== true;
}

function cliFallbackMatchesTask(task) {
  return task?.provider !== 'dsh'
    || task.dsh_model == null
    || task.dsh_model === DEFAULT_DSH_MODEL;
}

function rejectFallbackStart(task) {
  if (fallbackStartAllowed(task)) return;
  fail(task?.status === 'cancelling' || task?.status === 'cancelled' ? 'cancelled' : 'transport_lost',
    `Task cannot start a fallback worker from ${task?.status ?? 'unknown'}.`);
}

async function fallbackToCliIfSafe({ root, task, prompt, signal, error }) {
  const failure = publicError(error, prompt);
  const current = (await readTask(root, task.id)).task;
  if (!fallbackStartAllowed(current) || !cliFallbackMatchesTask(task) || !cliFallbackMatchesTask(current)) {
    return null;
  }
  const fallbackTask = await updateTask(root, task.id, (latest) => (
    fallbackStartAllowed(latest) && cliFallbackMatchesTask(latest)
      ? { status: 'starting', fallback_from: 'acp', acp_error: failure }
      : latest
  ));
  if (!cliFallbackMatchesTask(fallbackTask) || fallbackTask.fallback_from !== 'acp') return null;
  rejectFallbackStart(fallbackTask);
  await appendTaskEvent(root, task.id, {
    type: 'transport',
    state: 'acp_failed_before_dispatch',
    fallback: 'cli',
    error: failure,
  }).catch(() => {});
  return runCliFallback({ root, task: { ...task, ...fallbackTask }, prompt, signal });
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

function cliJsonCandidate(value) {
  const candidates = typeof value === 'string'
    ? [value]
    : [value?.result, value?.text, value?.message?.content, value?.content?.text, value?.delta?.text];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0)
    ?? candidates.find((candidate) => typeof candidate === 'string');
}

function countCliChunkChars(text, previousHighSurrogate) {
  let count = providerCharCount(text);
  if (previousHighSurrogate && text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) count -= 1;
  return count;
}

export function extractedCliResult(stdout, prompt, { originalChars, sourceTruncated = false } = {}) {
  const raw = String(stdout ?? '');
  if (!raw.trim()) return { value: null };
  const lines = raw.split(/\r?\n/u);
  while (lines.at(-1) === '') lines.pop();
  const records = [];
  for (const [index, line] of lines.entries()) {
    try {
      const candidate = cliJsonCandidate(JSON.parse(line));
      if (typeof candidate === 'string') records.push({ kind: 'structured', text: candidate });
    } catch {
      // A transport buffer can begin in the middle of a JSONL record. Do not
      // let that partial prefix displace a later final plaintext verdict.
      if (!(sourceTruncated && index === 0 && lines.length > 1)) {
        records.push({ kind: 'plain', text: line });
      }
    }
  }
  if (records.length > 0) {
    const structured = createProviderResultAccumulator({ sanitize: (text) => sanitizeText(text, prompt) });
    let previousKind = null;
    records.forEach((record, index) => {
      if (record.kind === 'plain') {
        if (previousKind === 'structured') structured.append('\n');
        structured.append(record.text);
        if (index < records.length - 1) structured.append('\n');
      } else {
        structured.append(record.text);
      }
      previousKind = record.kind;
    });
    return structured.finish({ sourceTruncated });
  }
  return boundedProviderResult(raw.trim(), {
    sanitize: (text) => sanitizeText(text, prompt),
    originalChars: originalChars ?? providerCharCount(raw),
    sourceTruncated,
  });
}

export async function runCliFallback({ root, task, prompt, signal } = {}) {
  const promptFile = path.join(taskPaths(root, task.id).directory, `cli-prompt-${randomUUID()}.txt`);
  let child;
  let stdout = '';
  let stderr = '';
  let stdoutOriginalChars = 0;
  let stdoutTruncated = false;
  let stdoutPreviousHighSurrogate = false;
  let timer;
  let stopDeadline;
  let termination;
  let cancel;
  let timedOut = false;
  let closePromise;
  const closeOnce = () => {
    closePromise ??= closeRetainedAcpResources({
      child,
      stopDeadline,
      extraClosers: [
        () => { clearTimeout(timer); },
        () => { if (cancel) signal?.removeEventListener('abort', cancel); },
      ],
    }).then((evidence) => {
      stopDeadline = undefined;
      if (child) termination ??= Promise.resolve(true);
      return evidence;
    });
    return closePromise;
  };
  try {
    if (signal?.aborted) fail('cancelled', 'CLI fallback was cancelled before startup.');
    rejectFallbackStart((await readTask(root, task.id)).task);
    await writeFile(promptFile, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (signal?.aborted) fail('cancelled', 'CLI fallback was cancelled before startup.');
    rejectFallbackStart((await readTask(root, task.id)).task);
    const argv = cliCommand(task, promptFile, prompt);
    child = spawn(argv[0], argv.slice(1), {
      cwd: task.cwd,
      env: providerChildEnvironment(task),
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
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutOriginalChars += countCliChunkChars(text, stdoutPreviousHighSurrogate);
      stdoutPreviousHighSurrogate = text.length > 0
        && text.charCodeAt(text.length - 1) >= 0xd800
        && text.charCodeAt(text.length - 1) <= 0xdbff;
      stdout = `${stdout}${text}`;
      if (stdout.length > MAX_CLI_OUTPUT) {
        stdout = stdout.slice(-MAX_CLI_OUTPUT);
        stdoutTruncated = true;
      }
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_CLI_OUTPUT / 4); });
    cancel = () => {
      termination ??= requestChildTreeTermination(child);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    await spawned;
    if (signal?.aborted) fail('cancelled', 'CLI fallback was cancelled before startup.');
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
    await updateTask(root, task.id, { dispatch_evidence: 'authoritative' });
    stopDeadline = startDeadlineWatch(root, task.id, () => {
      timedOut = true;
      cancel();
    });
    const exit = await closed;
    await termination;
    signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) fail('cancelled', 'CLI fallback was cancelled.');
    if (timedOut) fail('timeout', 'CLI fallback exceeded its task deadline.');
    const bounded = extractedCliResult(stdout, prompt, {
      originalChars: stdoutOriginalChars,
      sourceTruncated: stdoutTruncated,
    });
    const result = bounded.value;
    if (exit.code !== 0) {
      const detail = sanitizeText(stderr || stdout || `CLI exited ${exit.code ?? exit.signal}.`, prompt).slice(-MAX_EVENT_TEXT);
      fail(authenticationFailure(detail) ? 'needs_login' : 'cli_failed', detail);
    }
    const compact = { type: 'text_delta', text: result ?? 'CLI fallback completed.' };
    await appendTaskEvent(root, task.id, { type: 'provider', event: compact });
    const closeEvidence = await closeOnce();
    const terminal = await persistWorkerTerminal(root, task.id, {
      status: 'completed',
      result,
      ...Object.fromEntries(Object.entries(bounded).filter(([key]) => key.startsWith('result_'))),
      last_event: compact,
      provider_process_group: null,
      provider_process_start_ticks: null,
      fallback_safe: false,
    }, closeEvidence, { wtb_handoff: 'not_applicable' });
    return attachLocalProviderResultSink(
      root, terminal, collectCliProviderOutputV1(stdout), stdoutTruncated,
    );
  } catch (error) {
    const failure = publicError(error, prompt);
    const terminalStatus = signal?.aborted || error?.code === 'cancelled'
      ? 'cancelled'
      : error?.code === 'timeout' || timedOut ? 'timeout' : 'failed';
    const closeEvidence = await closeOnce();
    await persistWorkerTerminal(root, task.id, {
      status: terminalStatus,
      error: failure,
      provider_process_group: null,
      provider_process_start_ticks: null,
      fallback_safe: false,
    }, closeEvidence, { wtb_handoff: 'not_applicable' }).catch(() => {});
    throw error;
  } finally {
    await closeOnce();
    await rm(promptFile, { force: true });
  }
}

function commandString(argv) {
  return argv.map((entry) => `'${entry.replaceAll("'", "'\\''")}'`).join(' ');
}

function acpRpcIdKey(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return `string:${value}`;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return `number:${value}`;
  return null;
}

const ACP_PROVIDER_ERROR_MESSAGES = Object.freeze({
  provider_billing_required: 'The provider billing configuration is unavailable.',
  authentication_required: 'The provider authentication failed.',
  provider_rate_limited: 'The provider rate limit was reached.',
  provider_failed: 'The provider request failed.',
});

function classifyAcpProviderError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  const detail = `${code} ${message}`.trim();
  const normalized = detail.toLowerCase();
  let stableCode = 'provider_failed';
  if (/provider_billing_required|provider_billing|billing|payment|credit|quota|insufficient\s+funds|\b402\b/iu.test(normalized)) {
    stableCode = 'provider_billing_required';
  } else if (/authentication_required|provider_auth|auth(?:entication|orization)?|credential|api[_ -]?key|not\s+signed\s+in|needs?[_ -]?login|\b40[13]\b|forbidden|unauthori[sz]ed/iu.test(normalized)) {
    stableCode = 'authentication_required';
  } else if (/provider_rate_limited|rate[_ -]?limit|too\s+many\s+requests|throttl|\b429\b/iu.test(normalized)) {
    stableCode = 'provider_rate_limited';
  }
  // Provider text is useful for local diagnostics but is not safe to expose
  // through a native run receipt. Keep this error's public message fixed;
  // callers can retain only the bounded, separately sanitized transport
  // detail when they explicitly need it.
  return new AcpWorkerError(stableCode, ACP_PROVIDER_ERROR_MESSAGES[stableCode]);
}

function acpTextValue(value) {
  if (typeof value === 'string') return value;
  if (!plainObject(value)) return null;
  for (const key of ['text', 'delta', 'output', 'answer']) {
    if (typeof value[key] === 'string') return value[key];
  }
  if (plainObject(value.content)) return acpTextValue(value.content);
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter((entry) => plainObject(entry) && (entry.type === 'text' || entry.type === 'text_delta'))
      .map((entry) => acpTextValue(entry))
      .filter((entry) => typeof entry === 'string')
      .join('');
    if (text.length > 0) return text;
  }
  if (plainObject(value.message)) return acpTextValue(value.message);
  return null;
}

function acpStopReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^[A-Za-z0-9._-]{1,64}$/u.test(value)) return value;
  return null;
}

/**
 * Collect the JSON-RPC transcript produced by `acpx exec --file -`.
 *
 * ACPX's JSON formatter prints both directions of the protocol. Outbound
 * frames are inspected only long enough to correlate their ids; their params
 * are deliberately never retained, because the prompt is inside one of
 * those params. Only bounded provider text and correlated response metadata
 * leave this collector.
 */
function createAcpExecCollector({ prompt, onSession, onAuthoritative, onText } = {}) {
  const pending = new Map();
  const output = createProviderResultAccumulator({ sanitize: (text) => sanitizeText(text, prompt) });
  const decoder = new StringDecoder('utf8');
  let lineBuffer = '';
  let sessionId = null;
  let promptRequestId = null;
  let promptAttempted = false;
  let promptResponded = false;
  let authoritative = false;
  let stopReason = 'end_turn';
  let promptError = null;
  let resultError = null;
  let transportError = null;
  let structuredResult;
  let structuredResultSet = false;
  let protocolError = null;
  let textEventCount = 0;

  const protocolFailure = (message) => {
    const error = new AcpWorkerError('acpx_protocol_invalid', message);
    protocolError ??= error;
    throw error;
  };
  const markAuthoritative = () => {
    if (authoritative) return;
    authoritative = true;
    try { onAuthoritative?.(); } catch { /* evidence is persisted by the caller */ }
  };
  const appendText = (text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    output.append(text);
    if (textEventCount >= MAX_ACPX_EXEC_EVENTS) return;
    textEventCount += 1;
    try { onText?.(text); } catch { /* output remains available in the bounded accumulator */ }
  };
  const processFrame = (frame) => {
    if (!plainObject(frame) || frame.jsonrpc !== '2.0') protocolFailure('ACPX returned an invalid JSON-RPC frame.');
    const idKey = acpRpcIdKey(frame.id);
    if (typeof frame.method === 'string') {
      if (frame.method === 'initialize' || frame.method === 'session/new' || frame.method === 'session/prompt') {
        if (idKey === null) protocolFailure('ACPX returned an uncorrelatable outbound request.');
        if (pending.has(idKey)) protocolFailure('ACPX reused an outstanding JSON-RPC request id.');
        if (!pending.has(idKey) && pending.size >= MAX_ACPX_EXEC_EVENTS) {
          protocolFailure('ACPX returned too many pending JSON-RPC requests.');
        }
        pending.set(idKey, frame.method);
        if (frame.method === 'session/prompt') {
          const outboundSessionId = frame.params?.sessionId;
          if (typeof outboundSessionId !== 'string' || outboundSessionId.length === 0 || outboundSessionId !== sessionId) {
            protocolFailure('ACPX prompt request did not match the established session.');
          }
          promptRequestId = idKey;
          promptAttempted = true;
        }
        return;
      }
      if (frame.method === 'session/update') {
        const incomingSessionId = frame.params?.sessionId;
        if (typeof incomingSessionId !== 'string' || incomingSessionId.length === 0 || incomingSessionId !== sessionId) return;
        if (!promptAttempted) return;
        markAuthoritative();
        if (frame.params?.update?.sessionUpdate !== 'agent_message_chunk') return;
        const text = acpTextValue(frame.params?.update?.content);
        if (text !== null) appendText(text);
        return;
      }
      // Permission requests and formatter metadata are not provider output.
      return;
    }

    const method = idKey === null ? null : pending.get(idKey);
    if (method) pending.delete(idKey);
    if (plainObject(frame.error)) {
      if (method === 'session/prompt') {
        promptResponded = true;
        markAuthoritative();
        promptError ??= classifyAcpProviderError(frame.error);
      } else if (idKey === null || method) {
        transportError ??= classifyAcpProviderError(frame.error);
      }
      return;
    }
    if (!method) return;
    if (method === 'session/new') {
      const candidate = frame.result?.sessionId;
      if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256) {
        sessionId = candidate;
        try { onSession?.(candidate); } catch { /* terminal receipt carries the session id */ }
      }
      return;
    }
    if (method === 'session/prompt') {
      if (!plainObject(frame.result)) {
        resultError ??= new AcpWorkerError('acpx_invalid_result', 'ACPX prompt response was missing a result.');
        return;
      }
      const reason = acpStopReason(frame.result.stopReason);
      if (reason === null) {
        resultError ??= new AcpWorkerError('acpx_invalid_result', 'ACPX prompt response had no valid stop reason.');
        return;
      }
      if (frame.result.sessionId !== undefined && frame.result.sessionId !== sessionId) {
        resultError ??= new AcpWorkerError('acpx_invalid_result', 'ACPX prompt response did not match the established session.');
        return;
      }
      promptResponded = true;
      markAuthoritative();
      stopReason = reason;
      if (Object.hasOwn(frame.result, 'output') && frame.result.output !== null
        && typeof frame.result.output === 'object') {
        structuredResult = frame.result.output;
        structuredResultSet = true;
      }
      const text = acpTextValue(frame.result);
      if (text !== null) appendText(text);
    }
  };
  const feed = (chunk) => {
    if (protocolError) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
    lineBuffer += decoder.write(buffer);
    let newline;
    while ((newline = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/u, '');
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_ACPX_EXEC_FRAME) {
        protocolFailure('ACPX returned an overlarge JSON-RPC frame.');
      }
      let frame;
      try { frame = JSON.parse(line); } catch { protocolFailure('ACPX returned malformed JSON-RPC output.'); }
      processFrame(frame);
      if (protocolError) return;
    }
    if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_ACPX_EXEC_FRAME) {
      protocolFailure('ACPX returned an overlarge JSON-RPC frame.');
    }
  };
  const finish = () => {
    if (protocolError) throw protocolError;
    lineBuffer += decoder.end();
    if (lineBuffer.trim().length > 0) {
      if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_ACPX_EXEC_FRAME) {
        protocolFailure('ACPX returned an overlarge JSON-RPC frame.');
      }
      let frame;
      try { frame = JSON.parse(lineBuffer); } catch { protocolFailure('ACPX returned malformed JSON-RPC output.'); }
      lineBuffer = '';
      processFrame(frame);
    }
    if (protocolError) throw protocolError;
    const streamed = output.finish();
    return {
      output: structuredResultSet
        ? boundedProviderValue(structuredResult, { sanitize: (text) => sanitizeText(text, prompt) })
        : streamed,
      sessionId,
      promptRequestId,
      promptAttempted,
      promptResponded,
      authoritative,
      stopReason,
      promptError,
      resultError,
      transportError,
    };
  };
  return { feed, finish };
}

async function runDshExec({ root, task, prompt, cwd, configuration, timeoutMs, signal }) {
  const taskDirectory = taskPaths(root, task.id).directory;
  const acpxHome = path.join(taskDirectory, 'acpx-home');
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const argv = [
    '--agent', commandString(configuration.override),
    '--cwd', cwd,
    '--approve-all',
    '--format', 'json',
    '--json-strict',
    '--timeout', String(timeoutSeconds),
    'exec', '--file', '-',
  ];
  let child;
  let stderr = '';
  let termination;
  let timer;
  let stopDeadline;
  let timedOut = false;
  let cancel;
  let dispatchUncertain = false;
  let evidenceReady = false;
  let evidencePersisted = false;
  let evidenceObserved = false;
  let eventWrites = Promise.resolve();
  let sessionObserved = null;
  let parserError = null;
  let collector;
  let closePromise;
  const closeOnce = () => {
    closePromise ??= closeRetainedAcpResources({
      child,
      stopDeadline,
      extraClosers: [
        () => { clearTimeout(timer); },
        () => { if (cancel) signal?.removeEventListener('abort', cancel); },
        () => { child?.stdin?.destroy(); },
      ],
    }).then((evidence) => {
      stopDeadline = undefined;
      if (child) termination ??= Promise.resolve(true);
      return evidence;
    });
    return closePromise;
  };
  try {
    if (signal?.aborted) fail('cancelled', 'DSH ACP task was cancelled before startup.');
    await mkdir(acpxHome, { recursive: true, mode: 0o700 });
    await chmod(acpxHome, 0o700);
    await updateTask(root, task.id, { status: 'starting', transport: 'acp', acp_client: 'acpx-cli', started_at: new Date().toISOString() });
    const persistEvidence = () => {
      if (!evidenceObserved || !evidenceReady || evidencePersisted) return;
      evidencePersisted = true;
      eventWrites = eventWrites.then(async () => {
        await updateTask(root, task.id, {
          prompt_dispatched: true,
          dispatch_evidence: 'authoritative',
          dispatch_uncertain: false,
        });
        await appendTaskEvent(root, task.id, {
          type: 'transport',
          state: 'prompt_dispatched',
          transport: 'acp',
          client: 'acpx-cli',
          dispatch_evidence: 'authoritative',
        });
      });
    };
    collector = createAcpExecCollector({
      prompt,
      onSession: (value) => {
        sessionObserved = value;
        eventWrites = eventWrites.then(async () => {
          await updateTask(root, task.id, { acp_session_id: value });
          await appendTaskEvent(root, task.id, { type: 'transport', state: 'session_ready', transport: 'acp' });
        });
      },
      onAuthoritative: () => {
        evidenceObserved = true;
        persistEvidence();
      },
      onText: (value) => {
        const compact = { type: 'text_delta', text: boundedText(value, prompt, { remaining: MAX_EVENT_TEXT }) };
        eventWrites = eventWrites.then(() => appendTaskEvent(root, task.id, { type: 'provider', event: compact }));
      },
    });
    child = spawn(process.env.CODEX_CO_ENGINEER_ACPX_COMMAND ?? 'acpx', argv, {
      cwd,
      env: acpxTaskEnvironment(acpxHome, task),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const spawned = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const closed = new Promise((resolve) => {
      child.once('close', (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    child.stdout.on('data', (chunk) => {
      if (parserError) return;
      try {
        collector.feed(chunk);
        persistEvidence();
      } catch (error) {
        parserError ??= error;
        cancel?.();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_ACPX_EXEC_STDERR) stderr = stderr.slice(-MAX_ACPX_EXEC_STDERR);
    });
    child.stdin.on('error', () => {});
    cancel = () => {
      termination ??= requestChildTreeTermination(child);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    stopDeadline = startDeadlineWatch(root, task.id, () => {
      timedOut = true;
      cancel();
    });
    await spawned;
    // ACPX has spawned, but an outbound transcript frame only proves an
    // attempt. Treat all later failures as non-replayable even before the
    // correlated inbound session/update or prompt response arrives.
    dispatchUncertain = true;
    const requestId = task.request_id ?? randomUUID();
    await updateTask(root, task.id, {
      status: 'running',
      dispatch_intent: true,
      dispatch_uncertain: true,
      fallback_safe: false,
      request_id: requestId,
      provider_process_group: child.pid,
      provider_process_start_ticks: processStartTicks(child.pid),
    });
    await appendTaskEvent(root, task.id, {
      type: 'transport',
      state: 'dispatch_uncertain',
      transport: 'acp',
      client: 'acpx-cli',
      reason: 'ACPX does not provide an authoritative prompt-sent acknowledgement.',
    });
    evidenceReady = true;
    persistEvidence();
    if (parserError) throw parserError;
    child.stdin.end(prompt);
    if (signal?.aborted) fail('cancelled', 'DSH ACP task was cancelled before dispatch acknowledgement.');
    if (timedOut) fail('timeout', 'DSH ACP task exceeded its independent deadline.');
    const exit = await closed;
    const treeStopped = await (termination ??= terminateChildTree(child));
    signal?.removeEventListener('abort', cancel);
    if (parserError) throw parserError;
    const collected = collector.finish();
    // finish() can consume a final frame without a trailing newline and thus
    // enqueue the last evidence/event writes. Drain only after parsing it.
    await eventWrites;
    if (signal?.aborted) fail('cancelled', 'DSH ACP task was cancelled.');
    if (timedOut) fail('timeout', 'DSH ACP task exceeded its independent deadline.');
    if (!treeStopped) fail('acpx_cleanup_incomplete', 'ACPX process tree remained after termination.');
    if (collected.transportError) throw collected.transportError;
    if (collected.resultError) throw collected.resultError;
    if (collected.promptError) throw collected.promptError;
    if (exit.code !== 0) {
      const detail = sanitizeText(stderr.trim(), prompt).replace(/[\r\n\t]+/gu, ' ').trim()
        || `ACPX exited ${exit.code ?? exit.signal}`;
      fail('acpx_failed', detail.slice(-MAX_EVENT_TEXT));
    }
    if (!collected.authoritative || !collected.promptResponded) {
      fail('acpx_invalid_result', 'ACPX did not return a correlated prompt response.');
    }
    if (collected.stopReason === 'cancelled') fail('cancelled', 'DSH ACP task was cancelled by the provider.');
    const bounded = collected.output;
    const output = bounded.value;
    const compact = { type: 'text_delta', text: typeof output === 'string' ? output : 'DSH ACP task completed.' };
    const closeEvidence = await closeOnce();
    const terminal = await persistWorkerTerminal(root, task.id, {
      status: 'completed',
      error: null,
      stop_reason: collected.stopReason,
      last_event: compact,
      result: output,
      ...Object.fromEntries(Object.entries(bounded).filter(([key]) => key.startsWith('result_'))),
      provider_process_group: null,
      provider_process_start_ticks: null,
      acp_session_id: collected.sessionId ?? sessionObserved,
      prompt_dispatched: true,
      dispatch_evidence: 'authoritative',
      dispatch_uncertain: false,
      dispatch_intent: true,
    }, closeEvidence, { wtb_handoff: 'not_applicable' });
    return attachLocalProviderResultSink(root, terminal, output, bounded.result_truncated === true);
  } catch (error) {
    if (!dispatchUncertain && !authenticationFailure(error)) {
      const fallback = await fallbackToCliIfSafe({ root, task, prompt, signal, error });
      if (fallback) return fallback;
    }
    await eventWrites.catch(() => {});
    const current = (await readTask(root, task.id)).task;
    const status = signal?.aborted || error?.code === 'cancelled'
      ? 'cancelled' : (error?.code === 'timeout' || timedOut ? 'timeout' : 'failed');
    const failure = publicError(error, prompt);
    const closeEvidence = await closeOnce();
    await persistWorkerTerminal(root, task.id, {
      status,
      error: failure,
      provider_process_group: null,
      provider_process_start_ticks: null,
      fallback_safe: fallbackStartAllowed(current) && cliFallbackMatchesTask(current) && cliFallbackMatchesTask(task),
    }, closeEvidence, { wtb_handoff: 'not_applicable' }).catch(() => {});
    throw error;
  } finally {
    await closeOnce();
    await removeAcpxTaskHome(root, task.id, acpxHome);
  }
}

async function makeRuntime({ root, cwd, configuration, timeoutMs, taskId, signal, env }) {
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
    closedProviderEnv: env,
    onPermissionRequest: (params, extra = {}) => handlePermissionRequest(root, taskId, params, extra.signal ?? signal),
    onElicitationRequest: (params, extra = {}) => handleElicitationRequest(root, taskId, params, extra.signal ?? signal),
  });
}

/**
 * Reattach to an already acknowledged persistent ACP session. This path is
 * intentionally observation-only: it calls ensureSession with the recorded
 * session identity and never starts a new turn, so a worker restart cannot
 * replay the acknowledged prompt.
 */
export async function reconnectAcpTask({ root, taskId, signal, runtimeFactory } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('invalid_state_dir', 'root must be absolute.');
  const { task } = await readTask(root, taskId);
  if (!['grok', 'cursor-local'].includes(task.provider)
    || task.prompt_dispatched !== true
    || task.dispatch_evidence !== 'authoritative'
    || typeof task.acp_session_id !== 'string'
    || task.acp_session_id.length === 0
    || ['cancelled', 'cancelling', 'completed', 'failed', 'timeout'].includes(task.status)) {
    return Object.freeze({ reconnected: false, reason: 'session_resume_not_available' });
  }
  if (signal?.aborted) return Object.freeze({ reconnected: false, reason: 'cancelled' });
  const cwd = requireAbsoluteDirectory(task.cwd);
  const configuration = providerConfiguration(task);
  const timeoutMs = taskTimeoutMs(task);
  const childEnv = providerChildEnvironment(task);
  const runtime = await (typeof runtimeFactory === 'function'
    ? runtimeFactory({ root, task, cwd, configuration, timeoutMs, signal, env: childEnv })
    : makeRuntime({ root, cwd, configuration, timeoutMs, taskId, signal, env: childEnv }));
  let handle = null;
  try {
    handle = await runtime.ensureSession({
      sessionKey: task.session_key ?? `${task.provider}:${task.id}`,
      agent: configuration.agent,
      mode: 'persistent',
      cwd,
      resumeSessionId: task.acp_session_id,
    });
    // getStatus is deliberately used only to prove that the attached session
    // is observable. Its provider payload is not copied into the receipt.
    if (typeof runtime.getStatus === 'function') await runtime.getStatus({ handle });
    const sessionId = handle.backendSessionId ?? handle.agentSessionId ?? task.acp_session_id;
    await updateTask(root, taskId, {
      status: 'running',
      transport: 'acp',
      acp_session_id: sessionId,
      runtime_recovery: 'same_session_reconnected',
    });
    await appendTaskEvent(root, taskId, {
      type: 'transport',
      state: 'session_reconnected',
      transport: 'acp',
      prompt_replayed: false,
    });
    return Object.freeze({ reconnected: true, session_id: sessionId, prompt_replayed: false });
  } catch {
    return Object.freeze({ reconnected: false, reason: 'session_reconnect_failed' });
  } finally {
    try { await runtime.close?.({ handle, discardPersistentState: false }); } catch { /* retain evidence for later reconciliation */ }
  }
}

/**
 * Run one task through ACP. The task prompt is read from the owner-only task
 * store, so it never appears in argv or the public task record.
 */
export async function runAcpTask({ root, taskId, signal } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('invalid_state_dir', 'root must be absolute.');
  const { task } = await readTask(root, taskId);
  if (task.status !== 'accepted') {
    fail(task.status === 'cancelling' || task.status === 'cancelled' ? 'cancelled' : 'transport_lost', `Task ${taskId} cannot start from ${task.status}.`);
  }
  const cwd = requireAbsoluteDirectory(task.cwd);
  const prompt = await readPrompt(root, taskId);
  const configuration = providerConfiguration(task);
  // Session startup / reconnect keep a bounded timeout. The turn itself is
  // owned by startDeadlineWatch + AbortSignal so audited extensions re-arm.
  const startupTimeoutMs = taskTimeoutMs(task);
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1) {
    fail('invalid_timeout', 'timeout_ms must be at least 1000.');
  }

  if (task.provider === 'dsh') {
    return runDshExec({ root, task, prompt, cwd, configuration, timeoutMs: startupTimeoutMs, signal });
  }

  const childEnv = providerChildEnvironment(task);
  const runtime = await makeRuntime({
    root, cwd, configuration, timeoutMs: startupTimeoutMs, taskId, signal, env: childEnv,
  });
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason ?? new AcpWorkerError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'ACP task exceeded its recorded deadline.' : 'Task cancelled.'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let stopDeadline = startDeadlineWatch(root, taskId, () => {
    timedOut = true;
    abort();
  });

  let turn;
  let handle;
  let closePromise;
  const closeOnce = () => {
    closePromise ??= closeRetainedAcpResources({
      runtime,
      handle,
      stopDeadline,
      extraClosers: [
        () => signal?.removeEventListener('abort', abort),
      ],
    }).then((evidence) => {
      stopDeadline = undefined;
      return evidence;
    });
    return closePromise;
  };
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
      // Disable the fixed inner turn timer; the worker deadline AbortSignal is
      // the sole extensible execution bound for this prompt.
      timeoutMs: 0,
      signal: controller.signal,
    });
    // From this point onward the provider may have accepted the prompt. A
    // supervisor must reconcile this task, never replay it through CLI.
    await updateTask(root, taskId, { prompt_dispatched: true });
    await appendTaskEvent(root, taskId, { type: 'transport', state: 'prompt_dispatched', transport: 'acp' });
    await updateTask(root, taskId, { dispatch_evidence: 'authoritative' });
    const cancel = () => turn.cancel({ reason: 'signal' }).catch(() => {});
    controller.signal.addEventListener('abort', cancel, { once: true });
    let lastEvent = null;
    let observedUnsupportedQuestion = false;
    const output = createProviderResultAccumulator({ sanitize: (text) => sanitizeText(text, prompt) });
    const complete = createLocalProviderResultCollectorV1();
    const grokFinal = task.provider === 'grok'
      ? createGrokFinalResponseReducerV1({ sanitize: (text) => sanitizeText(text, prompt) })
      : null;
    try {
      for await (const event of turn.events) {
        observedUnsupportedQuestion ||= isStructuredAskUserQuestionUnsupported(event);
        if (event?.type === 'text_delta' && event.stream !== 'thought' && typeof event.text === 'string') {
          output.append(event.text);
          complete.append(event.text);
        }
        grokFinal?.append(event);
        const compact = boundedEvent(event, prompt);
        await appendTaskEvent(root, taskId, { type: 'provider', event: compact });
        lastEvent = compact;
      }
    } finally {
      controller.signal.removeEventListener('abort', cancel);
    }

    const result = await turn.result;
    // Authoritative deadline / cancel outcomes beat any runtime settlement,
    // including partial text that upstream historically treated as end_turn.
    if (timedOut) fail('timeout', 'ACP task exceeded its recorded deadline.');
    if (result.status === 'cancelled' || controller.signal.aborted) {
      fail('cancelled', 'ACP task was cancelled.');
    }
    const current = (await readTask(root, taskId)).task;
    const unsupportedQuestion = isStructuredAskUserQuestionUnsupported(lastEvent)
      || observedUnsupportedQuestion;
    const latchedQuestion = liveQuestionId(current.attention);
    let status = result.status === 'completed' ? 'completed' : result.status;
    let terminalError;
    if (result.status === 'failed') {
      terminalError = publicError(result.error, prompt);
    } else if (status === 'completed' && unsupportedQuestion && !latchedQuestion) {
      status = 'failed';
      terminalError = questionBridgeUnavailableError();
    }
    const fullBounded = output.finish();
    const fullSnapshot = complete.snapshot();
    const reduced = grokFinal?.finish({ turnResult: { ...result, status }, fullSnapshot });
    const bounded = reduced?.bounded ?? fullBounded;
    const closeEvidence = await closeOnce();
    const terminal = await persistWorkerTerminal(root, taskId, {
      status,
      stop_reason: result.stopReason ?? null,
      last_event: lastEvent,
      result: bounded.value,
      ...Object.fromEntries(Object.entries(bounded).filter(([key]) => key.startsWith('result_'))),
      ...(unsupportedQuestion && !latchedQuestion ? { question_bridge: 'unavailable' } : {}),
      ...(terminalError ? { error: terminalError, fallback_safe: false } : {}),
    }, closeEvidence, { wtb_handoff: 'not_applicable' });
    const snapshot = reduced?.snapshot ?? fullSnapshot;
    return attachLocalProviderResultSink(
      root, terminal, snapshot.source, false,
      fullSnapshot.overflow === true || snapshot.overflow === true,
    );
  } catch (error) {
    const failure = publicError(error, prompt);
    const current = (await readTask(root, taskId)).task;
    if (!authenticationFailure(error)) {
      const fallback = await fallbackToCliIfSafe({ root, task, prompt, signal, error });
      if (fallback) return fallback;
    }
    const status = timedOut || error?.code === 'timeout'
      ? 'timeout'
      : controller.signal.aborted ? 'cancelled' : 'failed';
    const closeEvidence = await closeOnce();
    await persistWorkerTerminal(root, taskId, {
      status,
      error: failure,
      fallback_safe: fallbackStartAllowed(current),
    }, closeEvidence, { wtb_handoff: 'not_applicable' }).catch(() => {});
    throw error;
  } finally {
    await closeOnce();
  }
}

export async function runAcpWorkerCli(argv, {
  env = process.env,
  cwd = process.cwd(),
  readFileImpl = readFile,
  runAcpTaskImpl = runAcpTask,
  handoffImpl = boundedWtbHandoff,
  runFileImpl = runFile,
  stdoutWrite = (chunk) => process.stdout.write(chunk),
  stderrWrite = (chunk) => process.stderr.write(chunk),
  exit = (code) => { process.exit(code); },
  exitMs = WORKER_EXIT_MS,
} = {}) {
  if (argv.length !== 2 || argv[0] !== '--request') {
    stderrWrite('Usage: node acp-worker.mjs --request /absolute/path/to/request.json\n');
    requestWorkerExit(2, { exit, exitMs });
    return;
  }
  const requestPath = argv[1];
  if (!path.isAbsolute(requestPath)) fail('invalid_request', 'Request path must be absolute.');
  const request = JSON.parse(await readFileImpl(requestPath, 'utf8'));
  const controller = new AbortController();
  const cancel = () => controller.abort(new AcpWorkerError('cancelled', 'Worker signal received.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  const finish = async (task, code) => {
    const handoff = await handoffImpl({
      root: request.root,
      taskId: request.task_id,
      env,
      cwd,
      runFileImpl,
    }).catch(() => ({ attempted: false, wtb_handoff: 'not_applicable', task }));
    const recorded = handoff.task ?? task ?? (await readTask(request.root, request.task_id)).task;
    emitWorkerTerminalStdout(recorded, stdoutWrite);
    requestWorkerExit(code, { exit, exitMs });
    return recorded;
  };

  try {
    await awaitSupervisorRegistration(request.root, request.task_id, controller.signal);
    await removeStalePromptTransports(request.root, request.task_id);
    if (env.WORKTREE_BOOTSTRAP_TASK) {
      await runFileImpl(BUNDLED_WORKTREE_BOOTSTRAP, [
        'verify',
        env.WORKTREE_BOOTSTRAP_TASK,
        '--repo',
        cwd,
        '--require-writer',
      ]);
    }
    const task = await runAcpTaskImpl({ root: request.root, taskId: request.task_id, signal: controller.signal });
    await finish(task, 0);
  } catch (error) {
    const latest = await readTask(request.root, request.task_id).catch(() => null);
    if (latest?.task?.cleanup?.status === 'pending') {
      await finish(latest.task, 1).catch(() => {
        requestWorkerExit(1, { exit, exitMs });
      });
      return;
    }
    const failure = publicError(error);
    stderrWrite(`acp-worker: ${failure.code}: ${failure.message}\n`);
    requestWorkerExit(1, { exit, exitMs });
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAcpWorkerCli(process.argv.slice(2)).catch((error) => {
    const failure = publicError(error);
    process.stderr.write(`acp-worker: ${failure.code}: ${failure.message}\n`);
    requestWorkerExit(1);
  });
}
