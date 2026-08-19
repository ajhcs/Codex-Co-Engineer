import {
  DEFAULT_TASK_TIMEOUT_MS,
  DURATION_MARGIN,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  publicState,
} from './contract.mjs';
import { STORED_TERMINAL } from './contract.mjs';

const REASON_MAX = 512;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function requireDuration(value, field, code) {
  if (!Number.isInteger(value) || value < MIN_DURATION_MS || value > MAX_DURATION_MS) {
    fail(code, `${field} must be an integer from ${MIN_DURATION_MS} to ${MAX_DURATION_MS}.`);
  }
  return value;
}

export function computeMarginTimeoutMs(expectedDurationMs) {
  const expected = requireDuration(expectedDurationMs, 'expected_duration_ms', 'invalid_expected_duration_ms');
  return Math.min(MAX_DURATION_MS, Math.ceil(expected * DURATION_MARGIN));
}

export function resolveTaskDeadline(input = {}, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) fail('invalid_deadline_clock', 'Deadline clock is invalid.');
  const expected = input.expected_duration_ms;
  const timeout = input.timeout_ms;
  if (expected !== undefined && expected !== null) {
    requireDuration(expected, 'expected_duration_ms', 'invalid_expected_duration_ms');
    const computed = computeMarginTimeoutMs(expected);
    if (timeout !== undefined && timeout !== null) {
      requireDuration(timeout, 'timeout_ms', 'invalid_timeout_ms');
      if (timeout < expected) {
        fail('invalid_timeout_ms', 'timeout_ms must be at least expected_duration_ms.');
      }
      return Object.freeze({
        expected_duration_ms: expected,
        duration_margin: DURATION_MARGIN,
        timeout_ms: timeout,
        deadline_at: new Date(now + timeout).toISOString(),
        deadline_source: timeout === computed ? 'margin' : 'explicit',
      });
    }
    return Object.freeze({
      expected_duration_ms: expected,
      duration_margin: DURATION_MARGIN,
      timeout_ms: computed,
      deadline_at: new Date(now + computed).toISOString(),
      deadline_source: 'margin',
    });
  }
  if (timeout !== undefined && timeout !== null) {
    requireDuration(timeout, 'timeout_ms', 'invalid_timeout_ms');
    return Object.freeze({
      expected_duration_ms: null,
      duration_margin: DURATION_MARGIN,
      timeout_ms: timeout,
      deadline_at: new Date(now + timeout).toISOString(),
      deadline_source: 'explicit',
    });
  }
  return Object.freeze({
    expected_duration_ms: null,
    duration_margin: DURATION_MARGIN,
    timeout_ms: DEFAULT_TASK_TIMEOUT_MS,
    deadline_at: new Date(now + DEFAULT_TASK_TIMEOUT_MS).toISOString(),
    deadline_source: 'default',
  });
}

export function parseDeadlineAt(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function remainingDeadlineMs(task, now = Date.now()) {
  const deadline = parseDeadlineAt(task?.deadline_at);
  if (deadline == null) return null;
  return Math.max(0, deadline - now);
}

export function deadlineReached(task, now = Date.now()) {
  const remaining = remainingDeadlineMs(task, now);
  return remaining === 0;
}

export function nextDeadlineExtension(task, { expected_duration_ms, reason, now = Date.now() } = {}) {
  if (!task || typeof task !== 'object') fail('invalid_task_record', 'Task record is invalid.');
  if (STORED_TERMINAL.includes(task.status)) {
    fail('task_already_terminal', `Cannot extend a ${publicState(task.status)} task.`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    fail('invalid_extend_reason', 'extend_reason must be non-empty text describing why the deadline is changing.');
  }
  const currentDeadline = parseDeadlineAt(task.deadline_at);
  if (currentDeadline != null && now >= currentDeadline) {
    fail('deadline_expired', 'The recorded deadline has already passed; a silent roll-forward is not allowed.');
  }
  const resolved = resolveTaskDeadline({ expected_duration_ms }, { now });
  const previous = task.deadline_at ?? null;
  return Object.freeze({
    expected_duration_ms: resolved.expected_duration_ms,
    duration_margin: DURATION_MARGIN,
    timeout_ms: resolved.timeout_ms,
    deadline_at: resolved.deadline_at,
    deadline_source: 'extended',
    deadline_extensions: Object.freeze([
      ...(Array.isArray(task.deadline_extensions) ? task.deadline_extensions : []),
      Object.freeze({
        at: new Date(now).toISOString(),
        reason: reason.trim().slice(0, REASON_MAX),
        previous_deadline_at: previous,
        previous_expected_duration_ms: task.expected_duration_ms ?? null,
        previous_timeout_ms: task.timeout_ms ?? null,
        expected_duration_ms: resolved.expected_duration_ms,
        timeout_ms: resolved.timeout_ms,
        deadline_at: resolved.deadline_at,
      }),
    ]),
  });
}

export function deadlineProjection(task) {
  if (!task || typeof task !== 'object') return null;
  return Object.freeze({
    expected_duration_ms: task.expected_duration_ms ?? null,
    duration_margin: task.duration_margin ?? DURATION_MARGIN,
    timeout_ms: task.timeout_ms ?? null,
    deadline_at: task.deadline_at ?? null,
    deadline_source: task.deadline_source ?? null,
    extensions: Array.isArray(task.deadline_extensions) ? task.deadline_extensions : [],
    remaining_ms: remainingDeadlineMs(task),
  });
}
