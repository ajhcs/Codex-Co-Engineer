import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  ATTENTION_STATUSES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_BYTES_CAP,
  MAX_EVENT_LOG_BYTES,
  MAX_TIMEOUT_MS,
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

export const MAX_DIAGNOSTIC_PAGE_EVENTS = 100;

const REDACTED = '[REDACTED]';
const OVERSIZE_EVENT_SCAN_BYTES = 4 * 1024;
const LAST_ACTIVITY_CHUNK_BYTES = 16 * 1024;
const RAW_PUBLIC_KEYS = /^(?:argv|agent_argv|cli_argv|env|stderr|stdout|home|pid|ppid|command|prompt|provider_process_group|provider_process_start_ticks)$/iu;
const TOKEN_PATTERNS = [
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bcrsr_[A-Za-z0-9_-]{12,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:[A-Z][A-Z0-9]*_)*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH(?:ORIZATION)?|BEARER|CREDENTIALS?|PRIVATE[_-]?KEY)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;'"&]+)/giu,
];
const SECRET_KEY = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|cookie|credential|private[_-]?key|(?<![a-z0-9])prompt(?!_dispatched))/iu;
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

export function redactDiagnosticText(value, options = {}) {
  let text = String(value ?? '');
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
  // clipHead:false redacts the full string so callers can take a UTF-8-safe tail
  // without cutting through a credential. Default remains a 4096-char head clip.
  if (options?.clipHead === false) return text;
  return text.slice(0, 4_096);
}

function redactValue(value, depth = 0, { maxDepth = 4, maxKeys = 24, maxItems = 16 } = {}) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (typeof value !== 'object' || depth >= maxDepth) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((entry) => redactValue(entry, depth + 1, { maxDepth, maxKeys, maxItems })).filter((entry) => entry !== undefined);
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || RAW_PUBLIC_KEYS.test(key)) continue;
    const next = redactValue(entry, depth + 1, { maxDepth, maxKeys, maxItems });
    if (next === undefined) continue;
    out[key.slice(0, 64)] = next;
    if (Object.keys(out).length >= maxKeys) break;
  }
  return out;
}

export function sanitizePublicReceipt(value) {
  return redactValue(value, 0, { maxDepth: 6, maxKeys: 64, maxItems: 100 });
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
    validation: sanitizePublicReceipt(task.handoff?.validation ?? task.validation ?? null) ?? null,
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
    ...(task.provider === 'dsh' ? { dsh_model: task.dsh_model ?? 'muse-spark-1.2-contributor' } : {}),
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

// Bounds to enforce claimed JSON-RPC byte targets under worst valid values.
const COMPACT_FIELD_LIMITS = Object.freeze({
  // Task IDs are coordination keys, not display labels. Preserve the full
  // public TASK_ID contract so compact cards can be fed back to task/cancel.
  id: 80,
  provider: 32,
  branch: 200,
  start_sha: 40,
  timestamp: 64,
  state: 32,
});
const COMPACT_MAX_BRANCH_LEN = 24;
// Compact status shell bounds: keep readiness/model identity, clamp host-variable
// strings and omit long capability/mcp prose so 20-card JSON-RPC stays ≤24,576.
const COMPACT_STATUS_STRING_LIMITS = Object.freeze({
  reason: 64,
  action: 96,
  status: 48,
  boundary: 64,
  manager_version: 32,
  control_group: 96,
  transport: 32,
  evidence: 64,
  model: 64,
});

function boundString(value, maxLen, fallback = null) {
  if (value == null) return fallback;
  const s = String(value);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function boundDeadline(deadline) {
  if (!deadline || typeof deadline !== 'object') return null;
  // Only allow-list deadline fields; trim any strings to tight bounds.
  const out = {};
  if (Number.isInteger(deadline.expected_duration_ms)) out.expected_duration_ms = deadline.expected_duration_ms;
  if (typeof deadline.deadline_at === 'string') out.deadline_at = boundString(deadline.deadline_at, 64, null);
  if (typeof deadline.deadline_source === 'string') out.deadline_source = boundString(deadline.deadline_source, 32, null);
  if (Number.isInteger(deadline.remaining_ms) || typeof deadline.remaining_ms === 'number') {
    // Clamp so clock skew / far-future fixtures cannot inflate digit width.
    const remaining = Math.trunc(deadline.remaining_ms);
    if (Number.isFinite(remaining)) {
      out.remaining_ms = Math.max(0, Math.min(MAX_TIMEOUT_MS, remaining));
    }
  }
  return Object.keys(out).length ? out : null;
}

function projectCompactCapability(entry) {
  if (!entry || typeof entry !== 'object') return entry ?? null;
  const out = {
    live_progress: entry.live_progress === true,
    same_session_reply: entry.same_session_reply === true,
    restart_recovery: entry.restart_recovery === true,
    cancellation_confirmation: entry.cancellation_confirmation === true,
    detailed_tool_events: entry.detailed_tool_events === true,
    evidence: boundString(entry.evidence ?? 'unknown', COMPACT_STATUS_STRING_LIMITS.evidence, 'unknown'),
  };
  if (typeof entry.dispatch_confidence === 'string') {
    out.dispatch_confidence = boundString(entry.dispatch_confidence, COMPACT_STATUS_STRING_LIMITS.evidence, null);
  }
  // Omit long provider prose notes from compact status; full detail retains them.
  return out;
}

function projectCompactLocalBoundary(boundary) {
  if (!boundary || typeof boundary !== 'object') {
    return Object.freeze({
      ready: false,
      status: 'unavailable',
      reason: 'boundary_probe_failed',
      provider_started: false,
    });
  }
  const out = {
    ready: boundary.ready === true,
    status: boundString(boundary.status ?? 'unavailable', COMPACT_STATUS_STRING_LIMITS.status, 'unavailable'),
    provider_started: boundary.provider_started === true,
  };
  if (typeof boundary.boundary === 'string') {
    out.boundary = boundString(boundary.boundary, COMPACT_STATUS_STRING_LIMITS.boundary, null);
  }
  if (typeof boundary.manager_version === 'string') {
    out.manager_version = boundString(boundary.manager_version, COMPACT_STATUS_STRING_LIMITS.manager_version, null);
  }
  if (typeof boundary.control_group === 'string') {
    out.control_group = boundString(boundary.control_group, COMPACT_STATUS_STRING_LIMITS.control_group, null);
  }
  if (typeof boundary.reason === 'string') {
    out.reason = boundString(boundary.reason, COMPACT_STATUS_STRING_LIMITS.reason, null);
  }
  if (typeof boundary.action === 'string') {
    out.action = boundString(boundary.action, COMPACT_STATUS_STRING_LIMITS.action, null);
  }
  if (boundary.capabilities && typeof boundary.capabilities === 'object') {
    out.capabilities = {
      kill_mode: boundString(boundary.capabilities.kill_mode, 32, null),
      environment: boundString(boundary.capabilities.environment, 32, null),
      provider_sandbox: boundary.capabilities.provider_sandbox === true,
      manager_owned: boundary.capabilities.manager_owned === true,
    };
  }
  return out;
}

function projectCompactModelOption(entry) {
  if (!entry || typeof entry !== 'object') return { ready: false };
  const out = { ready: entry.ready === true };
  if (typeof entry.reason === 'string') {
    out.reason = boundString(entry.reason, COMPACT_STATUS_STRING_LIMITS.reason, null);
  }
  return out;
}

function projectCompactReadinessEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry ?? null;
  const out = {
    installed: entry.installed === true,
    ready: entry.ready === true,
    transport: boundString(entry.transport, COMPACT_STATUS_STRING_LIMITS.transport, null),
  };
  if (typeof entry.reason === 'string') {
    out.reason = boundString(entry.reason, COMPACT_STATUS_STRING_LIMITS.reason, null);
  }
  if (typeof entry.default_model === 'string') {
    out.default_model = boundString(entry.default_model, COMPACT_STATUS_STRING_LIMITS.model, null);
  }
  if (entry.model_options && typeof entry.model_options === 'object') {
    out.model_options = Object.fromEntries(
      Object.entries(entry.model_options).slice(0, 8).map(([model, option]) => [
        boundString(model, COMPACT_STATUS_STRING_LIMITS.model, model),
        projectCompactModelOption(option),
      ]),
    );
  }
  return out;
}

function projectCompactMcpPending(report) {
  if (!report || typeof report !== 'object') return report ?? null;
  // Keep budget identity; drop the long explanatory notes from compact shells.
  return {
    advertised_budget_ms: Number.isFinite(report.advertised_budget_ms) ? report.advertised_budget_ms : null,
    tool_timeout_sec: Number.isFinite(report.tool_timeout_sec) ? report.tool_timeout_sec : null,
    measured_desktop_limit_ms: report.measured_desktop_limit_ms ?? null,
    measured_desktop_limit: boundString(report.measured_desktop_limit, 32, 'unmeasured'),
    reconnect_on_budget: report.reconnect_on_budget === true,
  };
}

/**
 * Explicit bounded projection for status detail=compact / readiness-only.
 * Preserves readiness and DSH model identity while clamping host-variable
 * strings and omitting long capability/mcp prose so worst-case JSON-RPC with
 * 20 compact cards stays within the 24,576-byte ceiling with margin.
 */
export function projectCompactStatus(status) {
  if (!status || typeof status !== 'object') fail('invalid_status', 'Status payload is invalid.');
  const capabilities = status.capabilities && typeof status.capabilities === 'object'
    ? Object.fromEntries(
      Object.entries(status.capabilities).map(([provider, entry]) => [provider, projectCompactCapability(entry)]),
    )
    : status.capabilities;
  const readiness = status.readiness && typeof status.readiness === 'object'
    ? Object.fromEntries(
      Object.entries(status.readiness).map(([provider, entry]) => [provider, projectCompactReadinessEntry(entry)]),
    )
    : status.readiness;
  const projected = {
    ...status,
    capabilities,
    readiness,
    local_boundary: projectCompactLocalBoundary(status.local_boundary),
    mcp_pending_call: projectCompactMcpPending(status.mcp_pending_call),
    tasks: Array.isArray(status.tasks) ? status.tasks : [],
  };
  return freezeCompactDeep(projected);
}

function freezeCompactDeep(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeCompactDeep(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) freezeCompactDeep(entry);
  return Object.freeze(value);
}

export function compactTaskCard(task) {
  if (!task || typeof task !== 'object') fail('invalid_task_record', 'Task record is invalid.');
  const fullDeadline = deadlineProjection(task);
  const deadline = boundDeadline(fullDeadline ? {
    expected_duration_ms: fullDeadline.expected_duration_ms,
    deadline_at: fullDeadline.deadline_at,
    deadline_source: fullDeadline.deadline_source,
    remaining_ms: fullDeadline.remaining_ms,
  } : null);
  const rawBranch = task.branch ?? null;
  const rawSha = task.start_sha ?? task.starting_ref ?? null;
  const card = {
    id: boundString(task.id, COMPACT_FIELD_LIMITS.id, null),
    state: boundString(publicState(task.status), COMPACT_FIELD_LIMITS.state, null),
    provider: boundString(task.provider ?? null, COMPACT_FIELD_LIMITS.provider, null),
    created_at: boundString(task.created_at ?? null, COMPACT_FIELD_LIMITS.timestamp, null),
    updated_at: boundString(task.updated_at ?? null, COMPACT_FIELD_LIMITS.timestamp, null),
    deadline,
    branch: boundString(rawBranch, COMPACT_MAX_BRANCH_LEN, null),
    start_sha: boundString(rawSha, 40, null),
  };
  // Defensive: ensure no oversized strings escape even if sanitizer truncates differently.
  // Compact cards are built from allow-listed tiny fields only; never project omitted full receipt bodies.
  const sanitized = sanitizePublicReceipt(card);
  // Enforce hard JSON length cap per card (upper bound). Worst-case card JSON is < 700 bytes.
  // We assert via JSON stringify in tests; here we ensure field slicing already guarantees it.
  const frozen = freezeCompact(sanitized);
  return frozen;
}

function freezeCompact(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    Object.freeze(value);
    if (value.deadline && typeof value.deadline === 'object') Object.freeze(value.deadline);
  }
  return Object.freeze(value);
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

async function skipOversizedEventLine(handle, start, size) {
  const window = Buffer.alloc(OVERSIZE_EVENT_SCAN_BYTES);
  let offset = start;
  while (offset < size) {
    const length = Math.min(window.length, size - offset);
    const { bytesRead } = await handle.read(window, 0, length, offset);
    if (bytesRead === 0) break;
    const newline = window.subarray(0, bytesRead).indexOf(0x0a);
    if (newline !== -1) return offset + newline + 1;
    offset += bytesRead;
  }
  return size;
}

function parseEventLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(redactValue(JSON.parse(line)));
    } catch {
      events.push({ type: 'status', corrupt: true });
    }
  }
  return events;
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
    if (lastNewline === -1) {
      const hitBudget = bytesRead >= maxBytes;
      if (hitBudget || requested + bytesRead < size) {
        const consumed = await skipOversizedEventLine(handle, requested, size);
        return {
          events: [{ type: 'status', truncated: true }],
          event_cursor: String(consumed),
          more_events: consumed < size,
          bytes: size,
        };
      }
      return { events: [], event_cursor: String(requested), more_events: false, bytes: size };
    }
    const completeSlice = slice.subarray(0, lastNewline + 1);
    // Bound by both byte budget and public event-count cap before finalizing cursor.
    // Scan completeSlice for newlines and enforce MAX_DIAGNOSTIC_PAGE_EVENTS.
    let eventCount = 0;
    let lineStart = 0;
    let truncatedByCount = false;
    let truncatedOffset = -1;
    for (let index = 0; index < completeSlice.length; index += 1) {
      if (completeSlice[index] === 0x0a) {
        const lineBuf = completeSlice.subarray(lineStart, index);
        const lineText = lineBuf.toString('utf8');
        if (lineText) eventCount += 1;
        else {
          // Empty lines produce no event but still advance cursor; do not count toward cap.
          lineStart = index + 1;
          continue;
        }
        if (eventCount === MAX_DIAGNOSTIC_PAGE_EVENTS) {
          // Check if more complete lines remain beyond this newline within completeSlice
          if (index < completeSlice.length - 1) {
            truncatedByCount = true;
            truncatedOffset = index;
          }
          break;
        }
        lineStart = index + 1;
      }
    }
    if (truncatedByCount) {
      const consumed = requested + truncatedOffset + 1;
      const effectiveText = completeSlice.subarray(0, truncatedOffset + 1).toString('utf8');
      return {
        events: parseEventLines(effectiveText),
        event_cursor: String(consumed),
        more_events: consumed < size,
        bytes: size,
      };
    }
    const complete = completeSlice.toString('utf8');
    const consumed = requested + completeSlice.length;
    const events = parseEventLines(complete);
    // Defensive: if completeSlice somehow still yields > cap due to empty-line handling, slice again.
    if (events.length > MAX_DIAGNOSTIC_PAGE_EVENTS) {
      // Find byte offset of MAX-th event line to keep cursor accurate.
      let countForCursor = 0;
      let cursorOffset = 0;
      let scanStart = 0;
      for (let index = 0; index < completeSlice.length; index += 1) {
        if (completeSlice[index] === 0x0a) {
          const lineText = completeSlice.subarray(scanStart, index).toString('utf8');
          if (lineText) countForCursor += 1;
          scanStart = index + 1;
          if (countForCursor === MAX_DIAGNOSTIC_PAGE_EVENTS) {
            cursorOffset = index + 1;
            break;
          }
        }
      }
      const consumed2 = requested + cursorOffset;
      const effectiveText2 = completeSlice.subarray(0, cursorOffset).toString('utf8');
      return {
        events: parseEventLines(effectiveText2),
        event_cursor: String(consumed2),
        more_events: consumed2 < size,
        bytes: size,
      };
    }
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
  const fallback = Number.isFinite(updated) ? updated : Date.parse(task?.created_at ?? '') || 0;
  const eventsPath = path.join(taskPaths(root, task.id).events);
  let handle;
  try {
    handle = await open(eventsPath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - LAST_ACTIVITY_CHUNK_BYTES);
      const length = end - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const slice = buffer.subarray(0, bytesRead);
      let textStart = 0;
      if (start > 0) {
        const firstNewline = slice.indexOf(0x0a);
        if (firstNewline === -1) {
          end = start;
          continue;
        }
        textStart = firstNewline + 1;
      }
      const lines = slice.subarray(textStart).toString('utf8').split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]);
          const at = Date.parse(parsed?.at ?? '');
          if (Number.isFinite(at)) return at;
        } catch {
          // Keep scanning older complete lines.
        }
      }
      end = start;
    }
  } finally {
    await handle.close();
  }
  return fallback;
}
