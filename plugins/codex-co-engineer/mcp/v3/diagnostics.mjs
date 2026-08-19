import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  ATTENTION_STATUSES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_BYTES_CAP,
  MAX_EVENT_LOG_BYTES,
  MIN_DIAGNOSTIC_BYTES,
  providerCapabilities,
  publicState,
  STORED_TERMINAL,
} from './contract.mjs';
import { deadlineProjection } from './deadline.mjs';
import {
  parseEventCursor,
  publicProgressEvent,
  readTask,
  readTaskEventProgress,
  taskPaths,
} from './task-store.mjs';

const REDACTED = '[REDACTED]';
const TOKEN_PATTERNS = [
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bcrsr_[A-Za-z0-9_-]{12,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:[A-Z][A-Z0-9]*_)*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH(?:ORIZATION)?|BEARER|CREDENTIALS?|PRIVATE[_-]?KEY)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;'"&]+)/giu,
];
const SECRET_KEY = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|cookie|credential|private[_-]?key|prompt)/iu;
const LIFECYCLE_STAGES = [
  'accepted',
  'starting',
  'session_ready',
  'dispatch_uncertain',
  'prompt_dispatched',
  'running',
  'needs_attention',
  'reply_recorded',
  'reply_delivered',
  'validation',
  'handoff',
  'cancelled',
  'terminal',
];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseMaxBytes(value) {
  if (value === undefined || value === null) return MAX_DIAGNOSTIC_BYTES;
  if (!Number.isInteger(value) || value < MIN_DIAGNOSTIC_BYTES || value > MAX_DIAGNOSTIC_BYTES_CAP) {
    fail('invalid_max_bytes', `max_bytes must be an integer from ${MIN_DIAGNOSTIC_BYTES} to ${MAX_DIAGNOSTIC_BYTES_CAP}.`);
  }
  return value;
}

export function redactDiagnosticText(value) {
  let text = String(value ?? '');
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
  return text.slice(0, 4_096);
}

function redactValue(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (typeof value !== 'object' || depth >= 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => redactValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || /^(?:argv|env|stderr|stdout|home|pid|ppid|command)$/iu.test(key)) continue;
    const next = redactValue(entry, depth + 1);
    if (next === undefined) continue;
    out[key.slice(0, 64)] = next;
    if (Object.keys(out).length >= 24) break;
  }
  return out;
}

function errorFields(task) {
  const error = plainObject(task?.error) ? task.error : {};
  if (typeof error.code === 'string') {
    return { code: error.code, message: redactDiagnosticText(error.message ?? defaultMessage(task)) };
  }
  if (task?.status === 'completed' || (!STORED_TERMINAL.includes(task?.status) && !ATTENTION_STATUSES.includes(task?.status))) {
    return { code: 'ok', message: redactDiagnosticText(defaultMessage(task)) };
  }
  return { code: task?.status ?? 'unknown', message: redactDiagnosticText(defaultMessage(task)) };
}

function defaultMessage(task) {
  const state = publicState(task?.status);
  if (state === 'succeeded') return 'The delegated task completed.';
  if (state === 'cancelled') return 'The delegated task was cancelled.';
  if (state === 'timed_out') return 'The delegated task reached its recorded deadline.';
  if (state === 'needs_attention') return 'The provider is waiting for a same-session reply.';
  if (state === 'transport_lost') return 'The provider transport or local worker is no longer running.';
  if (state === 'environment_blocked') return 'The local systemd/cgroup process boundary blocked the task.';
  if (state === 'failed') return 'The delegated task failed.';
  return 'The delegated task is still running.';
}

function failedStage(task) {
  if (task?.failed_stage) return task.failed_stage;
  if (task?.status === 'environment_blocked') return 'process_boundary';
  if (task?.status === 'transport_lost') return 'transport';
  if (task?.status === 'timeout') return 'deadline';
  if (task?.status === 'needs_attention') return 'provider_feedback';
  if (task?.status === 'failed' && task?.fallback_from) return 'provider_startup';
  if (STORED_TERMINAL.includes(task?.status) || ATTENTION_STATUSES.includes(task?.status)) {
    return task?.stop_reason ?? task?.status ?? 'terminal';
  }
  return null;
}

function retryable(task) {
  if (task?.status === 'needs_attention') return true;
  if (task?.status === 'transport_lost') return false;
  if (task?.status === 'timeout' || task?.status === 'environment_blocked') return false;
  if (task?.status === 'failed' && task?.fallback_safe === true) return true;
  return false;
}

function suggestedAction(task) {
  const state = publicState(task?.status);
  if (state === 'succeeded') return 'Inspect the receipt, handoff, and resulting commits before merging.';
  if (state === 'needs_attention') {
    return providerCapabilities(task.provider).same_session_reply
      ? 'Call task with reply.session_id, reply.question_id, and reply.response against the live session.'
      : 'Same-session reply is unsupported for this provider; cancel or finish from the current receipt instead of starting a new prompt.';
  }
  if (state === 'transport_lost') return 'Inspect diagnostics and cancel if the owned worker is gone; do not replay a dispatched prompt.';
  if (state === 'environment_blocked') return 'Restore the Linux systemd user-manager and cgroup v2 boundary, then start a new task.';
  if (state === 'timed_out') return 'Review progress and either start a new task with a revised estimate or inspect partial work. Do not silently roll this deadline.';
  if (state === 'cancelled') return 'Confirm the owned process group is empty, then inspect retained worktrees.';
  if (state === 'failed') return 'Open the diagnostics view and use the failed stage plus evidence references; do not replay a dispatched prompt.';
  return 'Wait with wait_until=terminal, or inspect diagnostics if the task appears stuck.';
}

function lastLifecycleStage(task, lastEvent) {
  if (typeof task?.last_lifecycle_stage === 'string') return task.last_lifecycle_stage;
  const type = lastEvent?.type ?? lastEvent?.state;
  if (typeof type === 'string' && LIFECYCLE_STAGES.includes(type)) return type;
  if (task?.prompt_dispatched) return 'prompt_dispatched';
  if (task?.status === 'running') return 'running';
  if (task?.status === 'starting') return 'starting';
  return task?.status ?? 'accepted';
}

function evidenceReferences(taskId) {
  return Object.freeze({
    task_id: taskId,
    files: Object.freeze(['task.json', 'events.jsonl', 'runtime.json', 'worker.log', 'attention.json']),
  });
}

function gitEvidence(task) {
  return Object.freeze({
    source_repo: task.source_repo ?? null,
    cwd: task.cwd ?? null,
    worktree_path: task.cwd ?? null,
    branch: task.branch ?? null,
    start_sha: task.start_sha ?? task.starting_ref ?? null,
    resulting_commit: task.handoff?.head ?? task.result_sha ?? null,
    remote_branch: task.provider_remote_branch ?? task.handoff?.branch ?? null,
    pull_request: task.provider_pr_url ?? task.handoff?.pull_request ?? null,
    validation: task.handoff?.validation ?? task.validation ?? null,
    workspace_kind: task.workspace_kind ?? null,
    workspace_mode: task.workspace_mode ?? null,
  });
}

export function diagnosticEnvelope(task, runtime = null, extras = {}) {
  if (!task || typeof task !== 'object') fail('invalid_task_record', 'Task record is invalid.');
  const lastEvent = extras.last_event ?? task.last_event ?? null;
  const sanitizedLast = lastEvent ? publicProgressEvent(lastEvent) ?? redactValue(lastEvent) : null;
  const errors = errorFields(task);
  const state = publicState(task.status);
  return Object.freeze({
    task_id: task.id,
    provider: task.provider ?? null,
    session_id: task.acp_session_id ?? task.attention?.session_id ?? null,
    provider_run_id: task.provider_run_id ?? null,
    question_id: task.attention?.question_id ?? extras.question_id ?? null,
    state,
    status: task.status,
    error_code: errors.code,
    message: errors.message,
    failed_stage: failedStage(task),
    retryable: retryable(task),
    suggested_action: suggestedAction(task),
    started_at: task.started_at ?? task.created_at ?? null,
    last_activity_at: extras.last_activity_at ?? task.updated_at ?? null,
    alert_at: extras.alert_at ?? ((STORED_TERMINAL.includes(task.status) || ATTENTION_STATUSES.includes(task.status)) ? (task.finished_at ?? task.updated_at) : null),
    finished_at: task.finished_at ?? null,
    last_successful_stage: lastLifecycleStage(task, sanitizedLast),
    last_event: sanitizedLast,
    transport: task.transport ?? null,
    process_boundary: runtime?.process_boundary ?? task.runtime_recovery?.process_boundary ?? null,
    cancellation: {
      status: task.status === 'cancelling' || task.status === 'cancelled' ? task.status : null,
      cancel_requested: task.cancel_requested === true,
    },
    cleanup: task.cleanup ?? null,
    git: gitEvidence(task),
    deadline: deadlineProjection(task),
    capabilities: providerCapabilities(task.provider),
    evidence: evidenceReferences(task.id),
    dispatch_uncertain: task.dispatch_uncertain === true,
    ...(extras.wait_reason ? { wait_reason: extras.wait_reason } : {}),
  });
}

export function compactSummary(task, progress, runtime, extras = {}) {
  const envelope = diagnosticEnvelope(task, runtime, {
    ...extras,
    last_event: progress?.last_event ?? task.last_event,
  });
  return Object.freeze({
    task_id: envelope.task_id,
    state: envelope.state,
    status: envelope.status,
    provider: envelope.provider,
    message: envelope.message,
    error_code: envelope.error_code === 'ok' ? null : envelope.error_code,
    failed_stage: envelope.failed_stage,
    retryable: envelope.retryable,
    suggested_action: envelope.suggested_action,
    last_successful_stage: envelope.last_successful_stage,
    last_event: envelope.last_event,
    deadline: envelope.deadline,
    event_cursor: progress?.event_cursor ?? extras.event_cursor ?? null,
    wait_reason: progress?.wait_reason ?? extras.wait_reason ?? null,
    capabilities: envelope.capabilities,
    evidence: envelope.evidence,
  });
}

async function readPagedEvents(eventsPath, cursor, maxBytes) {
  const requested = parseEventCursor(cursor) ?? 0;
  const handle = await open(eventsPath, 'r');
  try {
    const size = (await handle.stat()).size;
    if (requested > size) fail('invalid_event_cursor', 'cursor is beyond the event log.');
    if (requested > 0) {
      const boundary = Buffer.alloc(1);
      const { bytesRead } = await handle.read(boundary, 0, 1, requested - 1);
      if (bytesRead !== 1 || boundary[0] !== 0x0a) fail('invalid_event_cursor', 'cursor must land on an event-log line boundary.');
    }
    const length = Math.min(Math.max(0, size - requested), maxBytes);
    if (length === 0) {
      return { events: [], event_cursor: String(requested), more_events: false, bytes: size };
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, requested);
    const slice = buffer.subarray(0, bytesRead);
    const lastNewline = slice.lastIndexOf(0x0a);
    const complete = lastNewline === -1 ? '' : slice.subarray(0, lastNewline + 1).toString('utf8');
    const events = [];
    for (const line of complete.split('\n')) {
      if (!line) continue;
      try {
        events.push(redactValue(JSON.parse(line)));
      } catch {
        events.push({ type: 'status', corrupt: true });
      }
    }
    const consumed = requested + (lastNewline === -1 ? 0 : lastNewline + 1);
    return {
      events,
      event_cursor: String(consumed),
      more_events: consumed < size,
      bytes: size,
    };
  } finally {
    await handle.close();
  }
}

export async function readTaskDiagnostics(root, taskId, { cursor, max_bytes, runtime = null, progress = null } = {}) {
  const { task, paths } = await readTask(root, taskId);
  const maxBytes = parseMaxBytes(max_bytes);
  const page = await readPagedEvents(paths.events, cursor, maxBytes);
  const live = progress ?? await readTaskEventProgress(root, taskId, { cursor });
  let logBytes = 0;
  try {
    logBytes = (await stat(paths.log)).size;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const envelope = diagnosticEnvelope(task, runtime, {
    last_event: live.last_event,
    last_activity_at: task.updated_at,
  });
  return Object.freeze({
    view: 'diagnostics',
    envelope,
    events: page.events,
    event_cursor: page.event_cursor,
    more_events: page.more_events,
    log_bytes: logBytes,
    event_bytes: page.bytes,
    resource_limit: page.bytes >= MAX_EVENT_LOG_BYTES || logBytes >= MAX_EVENT_LOG_BYTES,
    evidence: evidenceReferences(task.id),
    capabilities: envelope.capabilities,
  });
}

export async function lastActivityMs(root, task) {
  const updated = Date.parse(task?.updated_at ?? '');
  try {
    const raw = await readFile(path.join(taskPaths(root, task.id).events), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]);
        const at = Date.parse(parsed?.at ?? '');
        if (Number.isFinite(at)) return at;
      } catch {
        // Keep scanning older complete lines.
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return Number.isFinite(updated) ? updated : Date.parse(task?.created_at ?? '') || 0;
}
