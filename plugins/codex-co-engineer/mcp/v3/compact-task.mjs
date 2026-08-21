import { STORED_TERMINAL, publicState } from './contract.mjs';
import { deadlineProjection } from './deadline.mjs';
import {
  compactSummary,
  diagnosticEnvelope,
  redactDiagnosticText,
  sanitizePublicReceipt,
} from './diagnostics.mjs';

export const COMPACT_VIEW = 'compact';
export const DEFAULT_TASK_VIEW = 'summary';
export const TASK_VIEWS = Object.freeze(['summary', 'diagnostics', 'compact']);
export const COMPACT_STRUCTURED_BYTES_MAX = 8_192;
/** Smaller per-task cap used when up to eight compact tasks share one wait-any response. */
export const WAIT_ANY_TASK_STRUCTURED_BYTES_MAX = 7_168;
/** Maximum serialized size of one live event retained in wait-any progress. */
export const WAIT_ANY_PROGRESS_EVENT_BYTES_MAX = 768;
/** Maximum serialized size of one wait-any progress envelope. */
export const WAIT_ANY_PROGRESS_STRUCTURED_BYTES_MAX = 1_024;
/** Enforced aggregate structured-content cap for an eight-target wait-any response. */
export const WAIT_ANY_RESPONSE_STRUCTURED_BYTES_MAX = 72 * 1024;
export const WAIT_ANY_PROGRESS_DETAIL_HINT = 'Call task with this task_id for full live event detail.';
const COMPACT_RESULT_PREVIEW_BYTES = 1_536;
const COMPACT_SUMMARY_PREVIEW_BYTES = 512;
const COMPACT_HANDOFF_TEXT_BYTES = 256;
const COMPACT_ID_BYTES = 80;
const COMPACT_SCALAR_BYTES = 64;
const WAIT_ANY_EVENT_SCALAR_BYTES = 48;
const WAIT_ANY_EVENT_REASON_BYTES = 96;
const WAIT_ANY_EVENT_TEXT_BYTES = 320;
const COMPACT_CHECK_LIMIT = 8;
const COMPACT_EXTENSION_LIMIT = 4;
const ELLIPSIS = '…';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (nested === undefined ? null : nested)));
}

function utf8Slice(buffer, maxBytes, fromEnd) {
  if (maxBytes <= 0) return '';
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  if (fromEnd) {
    let start = buffer.length - maxBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString('utf8');
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function utf8Head(value, maxBytes) {
  if (value == null) return null;
  const raw = String(value);
  if (!Number.isInteger(maxBytes) || maxBytes < 0) return raw;
  const buffer = Buffer.from(raw, 'utf8');
  if (buffer.length <= maxBytes) return raw;
  const ellipsis = Buffer.from(ELLIPSIS, 'utf8');
  if (maxBytes < ellipsis.length) return utf8Slice(buffer, maxBytes, false);
  let end = maxBytes - ellipsis.length;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString('utf8')}${ELLIPSIS}`;
}

function boundedString(value, maxBytes, { tail = false } = {}) {
  if (typeof value !== 'string') return null;
  return tail ? tailText(value, maxBytes) : utf8Head(value, maxBytes);
}

export function resolveTaskView(view) {
  if (view === 'diagnostics' || view === COMPACT_VIEW) return view;
  return DEFAULT_TASK_VIEW;
}

export function tailText(value, maxBytes) {
  if (value == null) return null;
  const raw = String(value);
  if (!Number.isInteger(maxBytes) || maxBytes < 0) return redactDiagnosticText(raw);
  const redacted = redactDiagnosticText(raw, { clipHead: false });
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.length <= maxBytes) return redacted;
  const ellipsis = Buffer.from(ELLIPSIS, 'utf8');
  if (maxBytes < ellipsis.length) return utf8Slice(buffer, maxBytes, true);
  let start = buffer.length - (maxBytes - ellipsis.length);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return `${ELLIPSIS}${buffer.subarray(start).toString('utf8')}`;
}

function compactProgress(progress) {
  const source = plainObject(progress) ? progress : {};
  return Object.freeze({
    event_cursor: typeof source.event_cursor === 'string' ? source.event_cursor : null,
    wait_reason: typeof source.wait_reason === 'string' ? source.wait_reason : null,
    waited_ms: Number.isFinite(source.waited_ms) ? source.waited_ms : 0,
    new_event_count: Number.isFinite(source.new_event_count) ? source.new_event_count : 0,
    more_events: source.more_events === true,
  });
}

function compactDeadlineExtension(entry) {
  if (!plainObject(entry)) return null;
  return {
    at: entry.at ?? null,
    reason: entry.reason ?? null,
    previous_deadline_at: entry.previous_deadline_at ?? null,
    previous_expected_duration_ms: entry.previous_expected_duration_ms ?? null,
    previous_timeout_ms: entry.previous_timeout_ms ?? null,
    expected_duration_ms: entry.expected_duration_ms ?? null,
    timeout_ms: entry.timeout_ms ?? null,
    deadline_at: entry.deadline_at ?? null,
  };
}

function compactDeadline(task) {
  const deadline = deadlineProjection(task);
  if (!deadline) return null;
  const extensions = Array.isArray(deadline.extensions)
    ? deadline.extensions.slice(-COMPACT_EXTENSION_LIMIT).map(compactDeadlineExtension).filter(Boolean)
    : [];
  return Object.freeze({
    expected_duration_ms: deadline.expected_duration_ms ?? null,
    duration_margin: deadline.duration_margin ?? null,
    timeout_ms: deadline.timeout_ms ?? null,
    deadline_at: deadline.deadline_at ?? null,
    deadline_source: deadline.deadline_source ?? null,
    extensions,
    remaining_ms: deadline.remaining_ms ?? null,
  });
}

function compactCoordinationSummary(summary) {
  if (!plainObject(summary)) return null;
  return Object.freeze({
    message: typeof summary.message === 'string' ? summary.message : null,
    error_code: typeof summary.error_code === 'string' ? summary.error_code : null,
    failed_stage: typeof summary.failed_stage === 'string' ? summary.failed_stage : null,
    retryable: summary.retryable === true,
    suggested_action: typeof summary.suggested_action === 'string' ? summary.suggested_action : null,
    last_successful_stage: typeof summary.last_successful_stage === 'string' ? summary.last_successful_stage : null,
  });
}

function compactCancellation(cancellation) {
  if (!plainObject(cancellation)) return null;
  return Object.freeze({
    status: typeof cancellation.status === 'string' ? cancellation.status : null,
    cancel_requested: cancellation.cancel_requested === true,
  });
}

function compactCoordinationDiagnostic(envelope) {
  if (!plainObject(envelope)) return null;
  return Object.freeze({
    session_id: typeof envelope.session_id === 'string' ? envelope.session_id : null,
    question_id: typeof envelope.question_id === 'string' ? envelope.question_id : null,
    started_at: typeof envelope.started_at === 'string' ? envelope.started_at : null,
    last_activity_at: typeof envelope.last_activity_at === 'string' ? envelope.last_activity_at : null,
    alert_at: typeof envelope.alert_at === 'string' ? envelope.alert_at : null,
    finished_at: typeof envelope.finished_at === 'string' ? envelope.finished_at : null,
    cancellation: compactCancellation(envelope.cancellation),
    dispatch_uncertain: envelope.dispatch_uncertain === true,
  });
}

function boundedJsonPreview(value) {
  if (value == null) return null;
  if (typeof value === 'string') return tailText(value, COMPACT_RESULT_PREVIEW_BYTES);
  try {
    return tailText(JSON.stringify(value), COMPACT_RESULT_PREVIEW_BYTES);
  } catch {
    return null;
  }
}

function compactResultPreview(result) {
  if (result == null) return null;
  if (typeof result === 'string') return tailText(result, COMPACT_RESULT_PREVIEW_BYTES);
  if (plainObject(result)) {
    const preview = {};
    if (typeof result.summary === 'string') {
      preview.summary = tailText(result.summary, COMPACT_SUMMARY_PREVIEW_BYTES);
    }
    if (typeof result.output === 'string') {
      preview.output = tailText(result.output, COMPACT_RESULT_PREVIEW_BYTES);
    }
    if (Object.keys(preview).length > 0) return preview;
  }
  // Arrays and other structured values are sanitized before serialization so
  // short credential-key objects cannot leak through JSON.stringify.
  const sanitized = sanitizePublicReceipt(result);
  if (sanitized == null) return null;
  return boundedJsonPreview(sanitized);
}

function compactHandoffPreview(handoff) {
  if (!plainObject(handoff)) return null;
  const preview = {};
  if (typeof handoff.branch === 'string') preview.branch = tailText(handoff.branch, COMPACT_HANDOFF_TEXT_BYTES);
  if (typeof handoff.head === 'string') preview.head = tailText(handoff.head, COMPACT_SCALAR_BYTES);
  if (typeof handoff.pull_request === 'string') {
    preview.pull_request = tailText(handoff.pull_request, COMPACT_HANDOFF_TEXT_BYTES);
  }
  if (plainObject(handoff.validation)) {
    const validation = {};
    if (typeof handoff.validation.status === 'string') validation.status = handoff.validation.status;
    if (Array.isArray(handoff.validation.checks)) {
      validation.checks = handoff.validation.checks.slice(-COMPACT_CHECK_LIMIT).map((check) => {
        if (typeof check === 'string') return tailText(check, COMPACT_HANDOFF_TEXT_BYTES);
        const sanitized = sanitizePublicReceipt(check);
        if (sanitized == null || typeof sanitized !== 'object') return sanitized ?? null;
        boundDeepStringsInPlace(sanitized, COMPACT_HANDOFF_TEXT_BYTES);
        return sanitized;
      });
    }
    if (Object.keys(validation).length > 0) preview.validation = validation;
  }
  return Object.keys(preview).length > 0 ? preview : null;
}

function withinBudget(value, maxBytes = COMPACT_STRUCTURED_BYTES_MAX) {
  return byteLength(value) <= maxBytes;
}

function boundDeepStringsInPlace(value, maxBytes, depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 6) return;
  if (Array.isArray(value)) {
    if (value.length > COMPACT_CHECK_LIMIT) value.splice(COMPACT_CHECK_LIMIT);
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string' && Buffer.byteLength(value[index], 'utf8') > maxBytes) {
        value[index] = tailText(value[index], maxBytes);
      } else {
        boundDeepStringsInPlace(value[index], maxBytes, depth + 1);
      }
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && Buffer.byteLength(entry, 'utf8') > maxBytes) {
      value[key] = tailText(entry, maxBytes);
    } else {
      boundDeepStringsInPlace(entry, maxBytes, depth + 1);
    }
  }
}

function essentialCompactEnvelope(payload) {
  const summary = plainObject(payload.summary) ? payload.summary : {};
  const diagnostic = plainObject(payload.diagnostic) ? payload.diagnostic : {};
  const progress = plainObject(payload.progress) ? payload.progress : {};
  const cancellation = compactCancellation(diagnostic.cancellation);
  return {
    view: COMPACT_VIEW,
    task_id: boundedString(payload.task_id, COMPACT_ID_BYTES) ?? utf8Head('unknown', COMPACT_ID_BYTES),
    provider: boundedString(payload.provider, COMPACT_SCALAR_BYTES),
    ...(payload.provider === 'dsh' ? {
      dsh_model: boundedString(payload.dsh_model, COMPACT_SCALAR_BYTES) ?? 'muse-spark-1.2-contributor',
    } : {}),
    role: payload.role === 'review' || payload.role === 'implement' ? payload.role : null,
    status: boundedString(payload.status, COMPACT_SCALAR_BYTES),
    state: boundedString(payload.state, COMPACT_SCALAR_BYTES),
    created_at: boundedString(payload.created_at, COMPACT_SCALAR_BYTES),
    updated_at: boundedString(payload.updated_at, COMPACT_SCALAR_BYTES),
    started_at: boundedString(payload.started_at, COMPACT_SCALAR_BYTES),
    finished_at: boundedString(payload.finished_at, COMPACT_SCALAR_BYTES),
    prompt_dispatched: payload.prompt_dispatched === true,
    progress: {
      event_cursor: boundedString(progress.event_cursor, COMPACT_ID_BYTES),
      wait_reason: boundedString(progress.wait_reason, COMPACT_SCALAR_BYTES),
      waited_ms: Number.isFinite(progress.waited_ms) ? progress.waited_ms : 0,
      new_event_count: Number.isFinite(progress.new_event_count) ? progress.new_event_count : 0,
      more_events: progress.more_events === true,
    },
    summary: {
      message: boundedString(summary.message, COMPACT_SUMMARY_PREVIEW_BYTES, { tail: true }),
      error_code: boundedString(summary.error_code, COMPACT_SCALAR_BYTES),
      failed_stage: boundedString(summary.failed_stage, COMPACT_SCALAR_BYTES),
      retryable: summary.retryable === true,
      suggested_action: boundedString(summary.suggested_action, COMPACT_HANDOFF_TEXT_BYTES, { tail: true }),
      last_successful_stage: boundedString(summary.last_successful_stage, COMPACT_SCALAR_BYTES),
    },
    diagnostic: {
      session_id: boundedString(diagnostic.session_id, COMPACT_SCALAR_BYTES),
      question_id: boundedString(diagnostic.question_id, COMPACT_SCALAR_BYTES),
      started_at: boundedString(diagnostic.started_at, COMPACT_SCALAR_BYTES),
      last_activity_at: boundedString(diagnostic.last_activity_at, COMPACT_SCALAR_BYTES),
      alert_at: boundedString(diagnostic.alert_at, COMPACT_SCALAR_BYTES),
      finished_at: boundedString(diagnostic.finished_at, COMPACT_SCALAR_BYTES),
      cancellation: cancellation == null ? null : {
        status: boundedString(cancellation.status, COMPACT_SCALAR_BYTES),
        cancel_requested: cancellation.cancel_requested === true,
      },
      dispatch_uncertain: diagnostic.dispatch_uncertain === true,
    },
  };
}

function lastResortEnvelope(payload) {
  return {
    view: COMPACT_VIEW,
    task_id: boundedString(payload.task_id, COMPACT_ID_BYTES) ?? utf8Head('unknown', COMPACT_ID_BYTES),
    provider: payload.provider === 'dsh' ? 'dsh' : null,
    ...(payload.provider === 'dsh' ? {
      dsh_model: boundedString(payload.dsh_model, COMPACT_SCALAR_BYTES) ?? 'muse-spark-1.2-contributor',
    } : {}),
    role: payload.role === 'review' || payload.role === 'implement' ? payload.role : null,
    status: boundedString(payload.status, COMPACT_SCALAR_BYTES),
    state: boundedString(payload.state, COMPACT_SCALAR_BYTES),
    prompt_dispatched: payload.prompt_dispatched === true,
    progress: {
      event_cursor: null,
      wait_reason: null,
      waited_ms: 0,
      new_event_count: 0,
      more_events: false,
    },
    summary: {
      message: ELLIPSIS,
      error_code: null,
      failed_stage: null,
      retryable: false,
      suggested_action: ELLIPSIS,
      last_successful_stage: null,
    },
    diagnostic: {
      session_id: null,
      question_id: null,
      started_at: null,
      last_activity_at: null,
      alert_at: null,
      finished_at: null,
      cancellation: null,
      dispatch_uncertain: false,
    },
  };
}

function shrinkEssentialToBudget(payload, maxBytes) {
  const essential = essentialCompactEnvelope(payload);
  if (withinBudget(essential, maxBytes)) return essential;
  // Halve a nonnegative budget and stop at zero so the loop always progresses.
  let budget = COMPACT_SUMMARY_PREVIEW_BYTES;
  while (true) {
    if (typeof essential.summary.message === 'string') {
      essential.summary.message = tailText(essential.summary.message, budget);
    }
    if (typeof essential.summary.suggested_action === 'string') {
      essential.summary.suggested_action = tailText(
        essential.summary.suggested_action,
        Math.min(budget, COMPACT_HANDOFF_TEXT_BYTES),
      );
    }
    if (withinBudget(essential, maxBytes)) return essential;
    if (budget === 0) break;
    const nextBudget = Math.floor(budget / 2);
    budget = nextBudget < budget ? nextBudget : 0;
  }
  essential.summary.message = ELLIPSIS;
  essential.summary.suggested_action = ELLIPSIS;
  boundDeepStringsInPlace(essential, COMPACT_SCALAR_BYTES);
  if (withinBudget(essential, maxBytes)) return essential;
  return lastResortEnvelope(payload);
}

function enforceCompactBudget(payload, maxBytes) {
  const safe = cloneJson(payload);
  if (withinBudget(safe, maxBytes)) return safe;

  if (plainObject(safe.result) && typeof safe.result.output === 'string') {
    const overflow = byteLength(safe) - maxBytes;
    const nextBytes = Math.max(0, Buffer.byteLength(safe.result.output, 'utf8') - overflow - Buffer.byteLength(ELLIPSIS, 'utf8'));
    safe.result.output = tailText(safe.result.output, nextBytes);
    if (withinBudget(safe, maxBytes)) return safe;
    delete safe.result.output;
    if (Object.keys(safe.result).length === 0) delete safe.result;
    if (withinBudget(safe, maxBytes)) return safe;
  }
  if (safe.result !== undefined) {
    delete safe.result;
    if (withinBudget(safe, maxBytes)) return safe;
  }
  if (safe.handoff !== undefined) {
    delete safe.handoff;
    if (withinBudget(safe, maxBytes)) return safe;
  }
  if (plainObject(safe.deadline) && Array.isArray(safe.deadline.extensions) && safe.deadline.extensions.length > 0) {
    safe.deadline.extensions = [];
    if (withinBudget(safe, maxBytes)) return safe;
  }
  if (plainObject(safe.summary)) {
    if (typeof safe.summary.message === 'string') {
      safe.summary.message = tailText(safe.summary.message, COMPACT_SUMMARY_PREVIEW_BYTES);
      if (withinBudget(safe, maxBytes)) return safe;
    }
    if (typeof safe.summary.suggested_action === 'string') {
      safe.summary.suggested_action = tailText(safe.summary.suggested_action, COMPACT_HANDOFF_TEXT_BYTES);
      if (withinBudget(safe, maxBytes)) return safe;
    }
  }
  boundDeepStringsInPlace(safe, COMPACT_HANDOFF_TEXT_BYTES);
  if (withinBudget(safe, maxBytes)) return safe;
  for (const key of ['deadline', 'branch', 'start_sha', 'workspace_kind']) {
    if (safe[key] !== undefined) {
      delete safe[key];
      if (withinBudget(safe, maxBytes)) return safe;
    }
  }
  return shrinkEssentialToBudget(safe, maxBytes);
}

function resolveCompactMaxBytes(maxBytes) {
  const resolved = maxBytes ?? COMPACT_STRUCTURED_BYTES_MAX;
  if (!Number.isInteger(resolved) || resolved < 1_024 || resolved > COMPACT_STRUCTURED_BYTES_MAX) {
    fail('invalid_compact_max_bytes', `compact maxBytes must be an integer from 1024 to ${COMPACT_STRUCTURED_BYTES_MAX}.`);
  }
  return resolved;
}

/**
 * Project one live event into the small coordination envelope used by
 * wait-any. The single-task task view remains the path for full event detail.
 */
export function projectWaitAnyProgressEvent(event) {
  if (!plainObject(event)) return null;
  const compact = {};
  for (const key of ['type', 'at', 'state', 'status']) {
    if (typeof event[key] === 'string') compact[key] = tailText(event[key], WAIT_ANY_EVENT_SCALAR_BYTES);
  }
  if (typeof event.reason === 'string') compact.reason = tailText(event.reason, WAIT_ANY_EVENT_REASON_BYTES);
  const text = typeof event.text === 'string'
    ? event.text
    : (typeof event.message === 'string' ? event.message : null);
  if (text !== null) compact.text = tailText(text, WAIT_ANY_EVENT_TEXT_BYTES);
  const sanitized = sanitizePublicReceipt(compact) ?? {};
  if (withinBudget(sanitized, WAIT_ANY_PROGRESS_EVENT_BYTES_MAX)) return sanitized;
  // The allow-listed fields above are already bounded. Keep a deterministic
  // fail-closed fallback if future additions accidentally exceed the cap.
  const fallback = {
    ...(typeof compact.type === 'string' ? { type: compact.type } : { type: 'progress' }),
    ...(typeof compact.at === 'string' ? { at: compact.at } : {}),
    ...(typeof compact.text === 'string' ? { text: tailText(compact.text, 256) } : {}),
  };
  if (withinBudget(fallback, WAIT_ANY_PROGRESS_EVENT_BYTES_MAX)) return fallback;
  return { type: 'progress', text: ELLIPSIS };
}

/** Project and enforce the bounded wait-any progress envelope. */
export function projectWaitAnyProgress(progress) {
  if (!plainObject(progress)) return null;
  const event = projectWaitAnyProgressEvent(progress.last_event);
  const projected = {
    event_cursor: typeof progress.event_cursor === 'string' ? progress.event_cursor : null,
    last_event: event,
    new_event_count: Number.isFinite(progress.new_event_count) ? progress.new_event_count : 0,
    more_events: progress.more_events === true,
    waited_ms: Number.isFinite(progress.waited_ms) ? progress.waited_ms : 0,
    wait_reason: typeof progress.wait_reason === 'string' ? progress.wait_reason : null,
    wait_until: typeof progress.wait_until === 'string' ? progress.wait_until : null,
    ...(event ? { detail_hint: WAIT_ANY_PROGRESS_DETAIL_HINT } : {}),
  };
  const sanitized = sanitizePublicReceipt(projected) ?? {};
  if (withinBudget(sanitized, WAIT_ANY_PROGRESS_STRUCTURED_BYTES_MAX)) return sanitized;
  // A future progress field must never turn one target into an unbounded
  // aggregate response; retain wake metadata and the compact event only.
  return {
    event_cursor: projected.event_cursor,
    last_event: event,
    new_event_count: projected.new_event_count,
    more_events: projected.more_events,
    waited_ms: projected.waited_ms,
    wait_reason: projected.wait_reason,
    wait_until: projected.wait_until,
    ...(event ? { detail_hint: WAIT_ANY_PROGRESS_DETAIL_HINT } : {}),
  };
}

/** Fail closed if the eight-target aggregate would exceed its documented cap. */
export function enforceWaitAnyResponseBudget(value) {
  const sanitized = sanitizePublicReceipt(value) ?? {};
  if (withinBudget(sanitized, WAIT_ANY_RESPONSE_STRUCTURED_BYTES_MAX)) return sanitized;
  fail('wait_any_response_too_large', `wait-any structured response exceeds ${WAIT_ANY_RESPONSE_STRUCTURED_BYTES_MAX} bytes.`);
}

export function projectCompactTask({ task, progress = null, runtime = null, extras = {}, maxBytes } = {}) {
  if (!task || typeof task !== 'object') fail('invalid_task_record', 'Task record is invalid.');
  const compactMaxBytes = resolveCompactMaxBytes(maxBytes);
  const extraFields = plainObject(extras) ? extras : {};
  const lastEvent = extraFields.last_event ?? progress?.last_event ?? task.last_event ?? null;
  const summaryExtras = {
    ...extraFields,
    wait_reason: progress?.wait_reason ?? extraFields.wait_reason,
    event_cursor: progress?.event_cursor ?? extraFields.event_cursor,
    last_event: lastEvent,
  };
  const summary = compactSummary(task, progress, runtime, summaryExtras);
  const diagnostic = diagnosticEnvelope(task, runtime, summaryExtras);
  const payload = {
    view: COMPACT_VIEW,
    task_id: typeof task.id === 'string' ? task.id : 'unknown',
    provider: typeof task.provider === 'string' ? task.provider : null,
    ...(task.provider === 'dsh' ? {
      dsh_model: typeof task.dsh_model === 'string' ? task.dsh_model : 'muse-spark-1.2-contributor',
    } : {}),
    role: task.role === 'review' || task.role === 'implement' ? task.role : null,
    status: typeof task.status === 'string' ? task.status : null,
    state: publicState(task.status),
    created_at: typeof task.created_at === 'string' ? task.created_at : null,
    updated_at: typeof task.updated_at === 'string' ? task.updated_at : null,
    started_at: typeof task.started_at === 'string' ? task.started_at : null,
    finished_at: typeof task.finished_at === 'string' ? task.finished_at : null,
    deadline: compactDeadline(task),
    branch: typeof task.branch === 'string' ? task.branch : null,
    start_sha: typeof task.start_sha === 'string' ? task.start_sha : (typeof task.starting_ref === 'string' ? task.starting_ref : null),
    workspace_kind: typeof task.workspace_kind === 'string' ? task.workspace_kind : null,
    prompt_dispatched: task.prompt_dispatched === true,
    progress: compactProgress(progress),
    summary: compactCoordinationSummary(summary),
    diagnostic: compactCoordinationDiagnostic(diagnostic),
  };
  if (STORED_TERMINAL.includes(task.status)) {
    const resultPreview = compactResultPreview(task.result);
    const handoffPreview = compactHandoffPreview(task.handoff);
    if (resultPreview != null) payload.result = resultPreview;
    if (handoffPreview != null) payload.handoff = handoffPreview;
  }
  // Sanitize first so budget enforcement measures the returned bytes, then
  // shrink in a fixed order. The essential envelope is the last-resort cap.
  return Object.freeze(enforceCompactBudget(sanitizePublicReceipt(payload), compactMaxBytes));
}

export function compactStructuredBytes(value) {
  return byteLength(value);
}
