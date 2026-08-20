import { createHash, randomUUID } from 'node:crypto';
import { watch as watchDirectory } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  ATTENTION_STATUSES,
  MAX_EVENT_LOG_BYTES,
  MCP_PENDING_CALL_BUDGET_MS,
  PROVIDER_SILENCE_WATCHDOG_MIN_MS,
  STORED_TERMINAL,
  TASK_TERMINAL_WATCH_FALLBACK_MS,
} from './contract.mjs';
import { parseDeadlineAt, remainingDeadlineMs } from './deadline.mjs';

export const TASK_SCHEMA = 'codex-co-engineer.task.v1';
export const LAUNCH_RESERVATION_GRACE_MS = 15_000;
export const MAX_TASK_WAIT_MS = MCP_PENDING_CALL_BUDGET_MS;
export const MAX_WAIT_ANY_TASKS = 8;
export const TEXT_DELTA_COALESCE_MS = 400;
export const TASK_WAIT_WATCH_FALLBACK_MS = 1_000;
export const MAX_EVENT_READ_BYTES = 64 * 1024;
export const EVENT_TAIL_PEEK_BYTES = 16 * 1024;
export const EVENT_CURSOR_PATTERN = /^[0-9]{1,16}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
export const TERMINAL = new Set(STORED_TERMINAL);
export const ATTENTION = new Set(ATTENTION_STATUSES);
const UPDATE_LOCK_STALE_MS = 2_000;
const LOCAL_UPDATE_TAILS = new Map();
const OVERSIZE_EVENT_SCAN_BYTES = 4 * 1024;
const TEXT_DELTA_TYPES = new Set(['text_delta', 'thought_delta', 'message_delta', 'output_text_delta']);
const MAX_PUBLIC_EVENT_TEXT = 4 * 1024;
const MAX_PUBLIC_EVENT_KEYS = 24;
const MAX_PUBLIC_EVENT_DEPTH = 4;
const OMIT_PUBLIC_EVENT_KEYS = new Set([
  'pid', 'ppid', 'process_group', 'provider_process_group', 'provider_process_start_ticks',
  'argv', 'agent_argv', 'cli_argv', 'command', 'rawinput', 'rawoutput', 'content',
  'availablecommands', 'home', 'env', 'stderr', 'stdout', 'prompt',
]);
const SENSITIVE_PUBLIC_EVENT_KEY = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|cookie|credential|private[_-]?key)/iu;

function validLaunchReservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.token)) return false;
  return typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at));
}

export function createLaunchReservation({ now = Date.now(), graceMs = LAUNCH_RESERVATION_GRACE_MS } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 1_000 || graceMs > 5 * 60_000) {
    throw Object.assign(new Error('Launch reservation timing is invalid.'), { code: 'invalid_launch_reservation' });
  }
  return Object.freeze({
    token: randomUUID(),
    expires_at: new Date(now + graceMs).toISOString(),
  });
}

export function launchReservationActive(task, now = Date.now()) {
  const reservation = task?.launch_reservation;
  return validLaunchReservation(reservation) && Date.parse(reservation.expires_at) > now;
}

export function requireTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    throw Object.assign(new Error('task_id must be 1-80 safe characters.'), { code: 'invalid_task_id' });
  }
  return value;
}

export function stateRoot(env = process.env) {
  if (env.CODEX_CO_ENGINEER_STATE_DIR) {
    if (!path.isAbsolute(env.CODEX_CO_ENGINEER_STATE_DIR)) {
      throw Object.assign(new Error('CODEX_CO_ENGINEER_STATE_DIR must be absolute.'), { code: 'invalid_state_dir' });
    }
    return path.resolve(env.CODEX_CO_ENGINEER_STATE_DIR);
  }
  const base = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.local', 'state');
  return path.join(base, 'codex-co-engineer');
}

export function taskPaths(root, taskId) {
  const id = requireTaskId(taskId);
  const directory = path.join(path.resolve(root), 'tasks', id);
  return {
    directory,
    record: path.join(directory, 'task.json'),
    prompt: path.join(directory, 'prompt.txt'),
    events: path.join(directory, 'events.jsonl'),
    request: path.join(directory, 'worker-request.json'),
    runtime: path.join(directory, 'runtime.json'),
    log: path.join(directory, 'worker.log'),
    attention: path.join(directory, 'attention.json'),
    replies: path.join(directory, 'replies'),
    updateLock: path.join(directory, 'update.lock'),
  };
}

async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writeExclusive(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw Object.assign(new Error('Task record is invalid.'), { code: 'invalid_task_record' });
  }
  if (record.schema !== TASK_SCHEMA || record.id !== requireTaskId(record.id)) {
    throw Object.assign(new Error('Task record identity is invalid.'), { code: 'invalid_task_record' });
  }
  return record;
}

export async function createTask({ root = stateRoot(), prompt, record }) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw Object.assign(new Error('prompt must be non-empty text.'), { code: 'invalid_prompt' });
  }
  const now = new Date().toISOString();
  const id = requireTaskId(record.id);
  const paths = taskPaths(root, id);
  await prepareDirectory(path.resolve(root));
  await prepareDirectory(path.dirname(paths.directory));
  await mkdir(paths.directory, { mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const task = normalizeRecord({
    ...record,
    schema: TASK_SCHEMA,
    id,
    prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
    created_at: record.created_at ?? now,
    updated_at: now,
    revision: 1,
  });
  await writeExclusive(paths.prompt, prompt);
  await writeExclusive(paths.events, '');
  await writeExclusive(paths.record, `${JSON.stringify(task, null, 2)}\n`);
  return { task, paths };
}

export async function readTask(root, taskId) {
  const paths = taskPaths(root, taskId);
  const record = normalizeRecord(JSON.parse(await readFile(paths.record, 'utf8')));
  return { task: record, paths };
}

export async function readPrompt(root, taskId) {
  const { paths } = await readTask(root, taskId);
  return readFile(paths.prompt, 'utf8');
}

async function liveLockOwner(lockFile) {
  let raw;
  let metadata;
  try {
    [raw, metadata] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)]);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
  try {
    const value = JSON.parse(raw);
    if (!Number.isInteger(value.pid) || typeof value.start_ticks !== 'string') {
      return Date.now() - metadata.mtimeMs < UPDATE_LOCK_STALE_MS;
    }
    try {
      const proc = await readFile(`/proc/${value.pid}/stat`, 'utf8');
      const ticks = proc.slice(proc.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] ?? null;
      return ticks === value.start_ticks;
    } catch {
      return false;
    }
  } catch {
    return Date.now() - metadata.mtimeMs < UPDATE_LOCK_STALE_MS;
  }
}

async function acquireUpdateLock(lockFile) {
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      try {
        let startTicks = null;
        try {
          const proc = await readFile(`/proc/${process.pid}/stat`, 'utf8');
          startTicks = proc.slice(proc.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] ?? null;
        } catch {
          // The age lease below remains a safe fallback on non-/proc hosts.
        }
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, start_ticks: startTicks, nonce })}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockFile).catch(() => {});
        throw error;
      }
      return { handle, nonce };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!(await liveLockOwner(lockFile))) {
        await unlink(lockFile).catch((unlinkError) => {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }
      if (attempt === 199) {
        throw Object.assign(new Error('Timed out waiting for task update lock.'), { code: 'task_update_busy' });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw Object.assign(new Error('Timed out waiting for task update lock.'), { code: 'task_update_busy' });
}

export async function updateTask(root, taskId, changes) {
  const paths = taskPaths(root, taskId);
  let releaseLocal;
  const localGate = new Promise((resolve) => { releaseLocal = resolve; });
  const previousLocal = LOCAL_UPDATE_TAILS.get(paths.record) ?? Promise.resolve();
  const localTail = previousLocal.then(() => localGate, () => localGate);
  LOCAL_UPDATE_TAILS.set(paths.record, localTail);
  await previousLocal.catch(() => {});
  try {
    return await updateTaskWithFileLock(root, paths, taskId, changes);
  } finally {
    releaseLocal();
    if (LOCAL_UPDATE_TAILS.get(paths.record) === localTail) LOCAL_UPDATE_TAILS.delete(paths.record);
  }
}

export async function reserveTaskLaunch(root, taskId, reservation = createLaunchReservation()) {
  if (!validLaunchReservation(reservation)) {
    throw Object.assign(new Error('Launch reservation is invalid.'), { code: 'invalid_launch_reservation' });
  }
  const task = await updateTask(root, taskId, (current) => {
    if (current.status !== 'accepted') return current;
    if (launchReservationActive(current) && current.launch_reservation.token !== reservation.token) return current;
    return { launch_reservation: reservation };
  });
  if (task.launch_reservation?.token !== reservation.token) {
    throw Object.assign(new Error('Another worker already owns the task launch reservation.'), { code: 'task_launch_busy' });
  }
  return reservation;
}

export async function clearTaskLaunchReservation(root, taskId, token) {
  return updateTask(root, taskId, (current) => {
    if (!current.launch_reservation) return current;
    if (token !== undefined && current.launch_reservation.token !== token) return current;
    return { launch_reservation: null };
  });
}

async function updateTaskWithFileLock(root, paths, taskId, changes) {
  const lock = await acquireUpdateLock(paths.updateLock);
  try {
    const { task } = await readTask(root, taskId);
    const nextChanges = typeof changes === 'function' ? await changes({ ...task }) : changes;
    if (!nextChanges || typeof nextChanges !== 'object' || Array.isArray(nextChanges)) {
      throw new TypeError('Task update must be an object.');
    }
    if (TERMINAL.has(task.status) && nextChanges.status && nextChanges.status !== task.status) return task;
    if (task.status === 'cancelling' && nextChanges.status
      && !['cancelling', 'cancelled', 'transport_lost'].includes(nextChanges.status)) {
      return task;
    }
    const next = normalizeRecord({
      ...task,
      ...nextChanges,
      schema: TASK_SCHEMA,
      id: task.id,
      created_at: task.created_at,
      updated_at: new Date().toISOString(),
      revision: task.revision + 1,
    });
    await writeAtomic(paths.record, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } finally {
    await lock.handle.close().catch(() => {});
    try {
      const current = JSON.parse(await readFile(paths.updateLock, 'utf8'));
      if (current.nonce === lock.nonce) await unlink(paths.updateLock);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export async function appendTaskEvent(root, taskId, event) {
  const { paths } = await readTask(root, taskId);
  const entry = {
    at: new Date().toISOString(),
    ...event,
  };
  await appendFile(paths.events, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return entry;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseEventCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !EVENT_CURSOR_PATTERN.test(value)) {
    throw Object.assign(new Error('cursor must be a decimal event-log byte offset.'), { code: 'invalid_event_cursor' });
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw Object.assign(new Error('cursor must be a decimal event-log byte offset.'), { code: 'invalid_event_cursor' });
  }
  return offset;
}

export function parseTaskWaitMs(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0 || value > MAX_TASK_WAIT_MS) {
    throw Object.assign(new Error(`wait_ms must be an integer from 0 to ${MAX_TASK_WAIT_MS}.`), { code: 'invalid_wait_ms' });
  }
  return value;
}

export function parseTaskIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WAIT_ANY_TASKS) {
    throw Object.assign(new Error(`task_ids must contain 1-${MAX_WAIT_ANY_TASKS} task IDs.`), { code: 'invalid_task_ids' });
  }
  const taskIds = value.map((taskId) => requireTaskId(taskId));
  if (new Set(taskIds).size !== taskIds.length) {
    throw Object.assign(new Error('task_ids must not contain duplicates.'), { code: 'duplicate_task_id' });
  }
  return taskIds;
}

export function parseTaskCursors(value, taskIds = []) {
  if (value === undefined || value === null) return new Map();
  if (!plainObject(value)) {
    throw Object.assign(new Error('cursors must be an object keyed by task ID.'), { code: 'invalid_task_cursors' });
  }
  if (Object.keys(value).length > MAX_WAIT_ANY_TASKS) {
    throw Object.assign(new Error(`cursors may contain at most ${MAX_WAIT_ANY_TASKS} task IDs.`), { code: 'invalid_task_cursors' });
  }
  const allowed = new Set(taskIds);
  const cursors = new Map();
  for (const [taskId, cursor] of Object.entries(value)) {
    requireTaskId(taskId);
    if (allowed.size > 0 && !allowed.has(taskId)) {
      throw Object.assign(new Error('cursors may only reference task_ids in this wait.'), { code: 'invalid_task_cursor_target' });
    }
    parseEventCursor(cursor);
    cursors.set(taskId, cursor);
  }
  return cursors;
}

export function parseWaitUntil(value) {
  if (value === undefined || value === null || value === '') return 'progress';
  if (value === 'progress' || value === 'terminal') return value;
  throw Object.assign(new Error('wait_until must be progress or terminal.'), { code: 'invalid_wait_until' });
}

export function resolveTerminalWaitMs(task, now = Date.now()) {
  const remaining = remainingDeadlineMs(task, now);
  if (remaining != null) return Math.min(MAX_TASK_WAIT_MS, remaining);
  if (Number.isInteger(task?.timeout_ms) && task.timeout_ms > 0) {
    return Math.min(MAX_TASK_WAIT_MS, task.timeout_ms);
  }
  return MAX_TASK_WAIT_MS;
}

function sanitizePublicEvent(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, MAX_PUBLIC_EVENT_TEXT);
  if (typeof value !== 'object' || depth >= MAX_PUBLIC_EVENT_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => sanitizePublicEvent(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (OMIT_PUBLIC_EVENT_KEYS.has(normalized) || SENSITIVE_PUBLIC_EVENT_KEY.test(key)) continue;
    const next = sanitizePublicEvent(entry, depth + 1);
    if (next === undefined) continue;
    sanitized[key.slice(0, 64)] = next;
    if (Object.keys(sanitized).length >= MAX_PUBLIC_EVENT_KEYS) break;
  }
  return sanitized;
}

export function publicProgressEvent(entry) {
  if (!plainObject(entry)) return null;
  const at = typeof entry.at === 'string' ? entry.at : undefined;
  const body = entry.type === 'provider' && plainObject(entry.event) ? entry.event : entry;
  const sanitized = sanitizePublicEvent(body);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized) || Object.keys(sanitized).length === 0) {
    return at ? { type: 'status', at } : null;
  }
  if (at && sanitized.at === undefined) sanitized.at = at;
  return sanitized;
}

async function assertEventCursorBoundary(handle, offset, size) {
  if (offset > size) {
    throw Object.assign(new Error('cursor is beyond the event log.'), { code: 'invalid_event_cursor' });
  }
  if (offset === 0) return;
  const boundary = Buffer.alloc(1);
  const { bytesRead } = await handle.read(boundary, 0, 1, offset - 1);
  if (bytesRead !== 1 || boundary[0] !== 0x0a) {
    throw Object.assign(new Error('cursor must land on an event-log line boundary.'), { code: 'invalid_event_cursor' });
  }
}

function emptyProgressParse() {
  return {
    completeBytes: 0,
    lastEvent: null,
    eventCount: 0,
    immediateCount: 0,
    textDeltaCount: 0,
    corruptCount: 0,
  };
}

function eventTypeName(entry) {
  if (!plainObject(entry)) return null;
  if (entry.type === 'provider' && plainObject(entry.event) && typeof entry.event.type === 'string') {
    return entry.event.type;
  }
  return typeof entry.type === 'string' ? entry.type : null;
}

export function isTextDeltaEvent(entry) {
  const type = eventTypeName(entry);
  return type != null && TEXT_DELTA_TYPES.has(type);
}

export function isImmediateProgressEvent(entry) {
  return plainObject(entry) && !isTextDeltaEvent(entry);
}

function parseCompleteEventLines(buffer) {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return emptyProgressParse();
  const complete = buffer.subarray(0, lastNewline + 1).toString('utf8');
  let lastEvent = null;
  let eventCount = 0;
  let immediateCount = 0;
  let textDeltaCount = 0;
  let corruptCount = 0;
  for (const line of complete.split('\n')) {
    if (!line) continue;
    eventCount += 1;
    try {
      lastEvent = JSON.parse(line);
      if (isTextDeltaEvent(lastEvent)) textDeltaCount += 1;
      else immediateCount += 1;
    } catch {
      corruptCount += 1;
      lastEvent = { type: 'status', corrupt: true };
    }
  }
  return { completeBytes: lastNewline + 1, lastEvent, eventCount, immediateCount, textDeltaCount, corruptCount };
}

async function skipOversizedEvent(handle, start, size) {
  const window = Buffer.alloc(OVERSIZE_EVENT_SCAN_BYTES);
  let offset = start;
  while (offset < size) {
    const length = Math.min(window.length, size - offset);
    const { bytesRead } = await handle.read(window, 0, length, offset);
    if (bytesRead === 0) break;
    const newline = window.subarray(0, bytesRead).indexOf(0x0a);
    if (newline !== -1) {
      return {
        completeBytes: (offset - start) + newline + 1,
        lastEvent: { type: 'status', truncated: true },
        eventCount: 1,
        immediateCount: 1,
        textDeltaCount: 0,
        corruptCount: 0,
      };
    }
    offset += bytesRead;
  }
  return emptyProgressParse();
}

function progressSnapshot(start, skipped, parsed, size, requested, { hitBudget = false } = {}) {
  const consumed = start + skipped + parsed.completeBytes;
  return {
    event_cursor: String(consumed),
    new_event_count: requested === null ? 0 : parsed.eventCount,
    last_event: publicProgressEvent(parsed.lastEvent),
    more_events: requested !== null && hitBudget && consumed < size,
    immediate_event_count: requested === null ? 0 : parsed.immediateCount,
    text_delta_count: requested === null ? 0 : parsed.textDeltaCount,
    corrupt_event_count: requested === null ? 0 : parsed.corruptCount,
    event_bytes: size,
    resource_limit: size >= MAX_EVENT_LOG_BYTES,
  };
}

export async function readTaskEventProgress(root, taskId, { cursor } = {}) {
  const { paths } = await readTask(root, taskId);
  const requested = parseEventCursor(cursor);
  const handle = await open(paths.events, 'r');
  try {
    const size = (await handle.stat()).size;
    if (requested !== null) await assertEventCursorBoundary(handle, requested, size);
    const start = requested !== null ? requested : Math.max(0, size - EVENT_TAIL_PEEK_BYTES);
    const budget = requested !== null ? MAX_EVENT_READ_BYTES : EVENT_TAIL_PEEK_BYTES;
    const length = Math.min(Math.max(0, size - start), budget);
    if (length === 0) return progressSnapshot(start, 0, emptyProgressParse(), size, requested);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const hitBudget = bytesRead >= budget;
    let slice = buffer.subarray(0, bytesRead);
    let skipped = 0;
    if (requested === null && start > 0) {
      const firstNewline = slice.indexOf(0x0a);
      if (firstNewline === -1) return progressSnapshot(start, 0, emptyProgressParse(), size, requested);
      skipped = firstNewline + 1;
      slice = slice.subarray(skipped);
    }
    let parsed = parseCompleteEventLines(slice);
    if (parsed.completeBytes === 0 && requested !== null && hitBudget && start + bytesRead < size) {
      parsed = await skipOversizedEvent(handle, start, size);
    }
    const latestSize = (await handle.stat()).size;
    return progressSnapshot(start, skipped, parsed, latestSize, requested, { hitBudget });
  } finally {
    await handle.close();
  }
}

function progressAdvanced(current, baseline) {
  return current.event_cursor !== baseline.event_cursor
    || current.new_event_count > 0
    || Boolean(current.last_event && !baseline.last_event);
}

function receiptAdvanced(current, baseline) {
  return current.status !== baseline.status || current.revision !== baseline.revision;
}

function waitWakeReason(task, progress, initialTask, {
  coalesceFrom,
  coalesceMs,
  clock,
  waitUntil = 'progress',
  wakeOnAttention = true,
  deadlineAt = null,
  silenceTimeoutMs = null,
  lastActivityAt = null,
} = {}) {
  if (TERMINAL.has(task.status)) return 'terminal';
  if (wakeOnAttention && task.status === 'needs_attention') return 'attention';
  if (waitUntil === 'terminal' && wakeOnAttention && ATTENTION.has(task.status)) return 'attention';
  if (deadlineAt != null && clock() >= deadlineAt) return 'deadline';
  if (
    Number.isInteger(silenceTimeoutMs)
    && silenceTimeoutMs >= PROVIDER_SILENCE_WATCHDOG_MIN_MS
    && lastActivityAt != null
    && clock() >= lastActivityAt + silenceTimeoutMs
  ) {
    return 'silence';
  }
  if ((progress.corrupt_event_count ?? 0) > 0) return 'corrupt';
  if (progress.resource_limit) return 'resource_limit';
  if (waitUntil === 'terminal') return null;
  if (receiptAdvanced(task, initialTask)) return 'progress';
  if (progress.immediate_event_count > 0) return 'progress';
  if (progress.more_events && progress.new_event_count > 0) return 'progress';
  if (progress.text_delta_count > 0 && coalesceFrom != null && clock() >= coalesceFrom + coalesceMs) {
    return 'progress';
  }
  return null;
}

export function waitDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('abort');
      return;
    }
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      resolve('timeout');
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('timeout');
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve('abort');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createNotifyGate() {
  let pending = null;
  let resolve = null;
  let token = 0;
  return {
    notify(reason) {
      token += 1;
      pending = { token, reason };
      if (resolve) {
        const deliver = resolve;
        resolve = null;
        deliver(pending);
      }
    },
    take() {
      if (pending) {
        const value = pending;
        pending = null;
        return Promise.resolve(value.reason);
      }
      return new Promise((next) => {
        resolve = (value) => {
          if (pending && pending.token === value.token) pending = null;
          next(value.reason);
        };
      });
    },
    detachWaiter() {
      resolve = null;
    },
  };
}

function defaultWatch(directory, listener) {
  return watchDirectory(directory, { persistent: true }, listener);
}

function attachTaskWatcher(directory, watch, notify) {
  const watcher = watch(directory, (_eventType, _filename) => {
    notify('watch');
  });
  if (typeof watcher?.on === 'function') {
    watcher.on('error', () => notify('watch-error'));
  }
  return watcher;
}

function closeTaskWatcher(watcher) {
  if (!watcher) return;
  try { watcher.close(); } catch { /* already closed or unsupported */ }
}

async function raceWait({
  delay,
  remainingMs,
  coalesceMs,
  fallbackMs,
  notifyTake,
  signal,
}) {
  const local = new AbortController();
  const stop = () => local.abort();
  const linkAbort = () => stop();
  if (signal?.aborted) {
    stop();
    return 'abort';
  }
  signal?.addEventListener('abort', linkAbort, { once: true });
  try {
    const candidates = [
      notifyTake().then((reason) => reason),
      delay(remainingMs, local.signal).then((reason) => (reason === 'abort' ? 'abort' : 'timeout')),
    ];
    if (coalesceMs != null) {
      candidates.push(delay(coalesceMs, local.signal).then((reason) => (reason === 'abort' ? 'abort' : 'coalesce')));
    }
    if (fallbackMs != null) {
      candidates.push(delay(fallbackMs, local.signal).then((reason) => (reason === 'abort' ? 'abort' : 'fallback')));
    }
    return await Promise.race(candidates);
  } finally {
    signal?.removeEventListener('abort', linkAbort);
    stop();
  }
}

function lastActivityFrom(task, progress, fallback) {
  const eventAt = Date.parse(progress?.last_event?.at ?? '');
  if (Number.isFinite(eventAt)) return eventAt;
  const updated = Date.parse(task?.updated_at ?? task?.created_at ?? '');
  if (Number.isFinite(updated)) return updated;
  return fallback;
}

export async function waitForTaskProgress(root, taskId, {
  cursor,
  wait_ms,
  wait_until,
  wake_on_needs_attention = true,
  signal,
  now = Date.now,
  watch = defaultWatch,
  delay = waitDelay,
  coalesce_ms = TEXT_DELTA_COALESCE_MS,
  fallback_ms,
} = {}) {
  const waitUntil = parseWaitUntil(wait_until);
  const { task: initialTask, paths } = await readTask(root, taskId);
  const started = now();
  const followLiveDeadline = waitUntil === 'terminal' && wait_ms === undefined;
  const waitMs = followLiveDeadline
    ? MAX_TASK_WAIT_MS
    : parseTaskWaitMs(wait_ms);
  const coalesceMs = Number.isInteger(coalesce_ms) && coalesce_ms >= 0 && coalesce_ms <= MAX_TASK_WAIT_MS
    ? coalesce_ms
    : TEXT_DELTA_COALESCE_MS;
  const defaultFallback = waitUntil === 'terminal' ? TASK_TERMINAL_WATCH_FALLBACK_MS : TASK_WAIT_WATCH_FALLBACK_MS;
  const fallbackMs = Number.isInteger(fallback_ms) && fallback_ms >= 1 && fallback_ms <= MAX_TASK_WAIT_MS
    ? fallback_ms
    : defaultFallback;
  const initialProgress = await readTaskEventProgress(root, taskId, { cursor });
  let deadlineAt = parseDeadlineAt(initialTask.deadline_at);
  const silenceTimeoutMs = Number.isInteger(initialTask.silence_timeout_ms) ? initialTask.silence_timeout_ms : null;
  const snapshot = (task, progress, reason) => ({
    task,
    progress: {
      event_cursor: progress.event_cursor,
      last_event: task.last_event ?? progress.last_event,
      new_event_count: progress.new_event_count,
      more_events: Boolean(progress.more_events),
      waited_ms: Math.max(0, now() - started),
      wait_reason: reason,
      wait_until: waitUntil,
    },
  });
  const requestedCursor = parseEventCursor(cursor);
  let waitCursor = cursor;
  const evaluate = (task, progress, coalesceFrom) => waitWakeReason(task, progress, initialTask, {
    coalesceFrom,
    coalesceMs,
    clock: now,
    waitUntil,
    wakeOnAttention: wake_on_needs_attention !== false,
    deadlineAt,
    silenceTimeoutMs,
    lastActivityAt: lastActivityFrom(task, progress, started),
  });

  if (waitMs === 0) {
    return snapshot(initialTask, initialProgress, evaluate(initialTask, initialProgress, null) ?? 'current');
  }
  const immediate = evaluate(initialTask, initialProgress, requestedCursor !== null && initialProgress.text_delta_count > 0 ? started : null);
  if (immediate) return snapshot(initialTask, initialProgress, immediate);
  if (waitUntil === 'progress') {
    if (requestedCursor !== null && initialProgress.immediate_event_count > 0) {
      return snapshot(initialTask, initialProgress, 'progress');
    }
    if (requestedCursor !== null && initialProgress.more_events && initialProgress.new_event_count > 0) {
      return snapshot(initialTask, initialProgress, 'progress');
    }
    if (requestedCursor === null) {
      // Explicit wait_ms>0 with no cursor waits for events newer than the current tail.
      waitCursor = initialProgress.event_cursor;
    }
  }
  if (signal?.aborted) {
    return snapshot(initialTask, initialProgress, 'disconnected');
  }

  let coalesceFrom = requestedCursor !== null && initialProgress.text_delta_count > 0 ? started : null;
  const deadline = started + waitMs;
  const gate = createNotifyGate();
  let watcher = null;
  let watchFailed = false;
  let rewatchAttempted = false;
  const onAbort = () => gate.notify('abort');
  signal?.addEventListener('abort', onAbort, { once: true });

  const armWatch = () => {
    closeTaskWatcher(watcher);
    watcher = null;
    try {
      watcher = attachTaskWatcher(paths.directory, watch, (reason) => gate.notify(reason));
      if (!watcher || typeof watcher.close !== 'function') {
        watchFailed = true;
        watcher = null;
      } else {
        watchFailed = false;
      }
    } catch {
      watchFailed = true;
      watcher = null;
    }
  };

  try {
    armWatch();
    // Snapshot after arming the watcher so an append/rename that raced the
    // first read cannot be lost if inotify also missed it.
    let currentTask = (await readTask(root, taskId)).task;
    let currentProgress = await readTaskEventProgress(root, taskId, { cursor: waitCursor });
    if (currentProgress.text_delta_count > 0 && coalesceFrom == null) coalesceFrom = now();
    const initialLiveDeadline = parseDeadlineAt(currentTask.deadline_at);
    if (initialLiveDeadline != null) deadlineAt = initialLiveDeadline;
    let wake = evaluate(currentTask, currentProgress, coalesceFrom);
    if (wake) return snapshot(currentTask, currentProgress, wake);

    while (now() < deadline) {
      if (signal?.aborted) {
        return snapshot(currentTask, currentProgress, 'disconnected');
      }
      const connectionRemaining = deadline - now();
      if (connectionRemaining <= 0) break;
      const taskDeadlineRemaining = deadlineAt == null ? null : Math.max(0, deadlineAt - now());
      const remaining = taskDeadlineRemaining == null
        ? connectionRemaining
        : Math.min(connectionRemaining, taskDeadlineRemaining);
      const silenceRemaining = silenceTimeoutMs == null
        ? null
        : Math.max(0, lastActivityFrom(currentTask, currentProgress, started) + silenceTimeoutMs - now());
      const coalesceRemaining = waitUntil === 'terminal'
        ? silenceRemaining
        : (coalesceFrom == null ? null : Math.max(0, coalesceFrom + coalesceMs - now()));
      const reason = await raceWait({
        delay,
        remainingMs: remaining,
        coalesceMs: coalesceRemaining,
        fallbackMs: watchFailed ? Math.min(fallbackMs, remaining) : null,
        notifyTake: gate.take,
        signal,
      });
      gate.detachWaiter();
      if (reason === 'abort') {
        return snapshot(currentTask, currentProgress, 'disconnected');
      }
      currentTask = (await readTask(root, taskId)).task;
      currentProgress = await readTaskEventProgress(root, taskId, { cursor: waitCursor });
      if (currentProgress.text_delta_count > 0 && coalesceFrom == null) coalesceFrom = now();
      const parsedDeadline = parseDeadlineAt(currentTask.deadline_at);
      if (parsedDeadline != null) deadlineAt = parsedDeadline;
      wake = evaluate(currentTask, currentProgress, coalesceFrom);
      if (wake) return snapshot(currentTask, currentProgress, wake);
      if (reason === 'timeout' && now() >= deadline) break;
      if (reason === 'watch-error') {
        if (!rewatchAttempted) {
          rewatchAttempted = true;
          armWatch();
        } else {
          closeTaskWatcher(watcher);
          watcher = null;
          watchFailed = true;
        }
      }
    }

    const finalTask = (await readTask(root, taskId)).task;
    const finalProgress = await readTaskEventProgress(root, taskId, { cursor: waitCursor });
    const finalDeadline = parseDeadlineAt(finalTask.deadline_at);
    if (finalDeadline != null) deadlineAt = finalDeadline;
    const finalWake = evaluate(finalTask, finalProgress, coalesceFrom);
    if (finalWake) return snapshot(finalTask, finalProgress, finalWake);
    if (waitUntil === 'progress' && (receiptAdvanced(finalTask, initialTask) || progressAdvanced(finalProgress, initialProgress))) {
      return snapshot(finalTask, finalProgress, 'progress');
    }
    if (signal?.aborted) return snapshot(finalTask, finalProgress, 'disconnected');
    if (waitUntil === 'terminal' && waitMs >= MAX_TASK_WAIT_MS && (remainingDeadlineMs(finalTask, now()) ?? 0) > 0) {
      return snapshot(finalTask, finalProgress, 'transport_budget');
    }
    return snapshot(finalTask, finalProgress, 'timeout');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    closeTaskWatcher(watcher);
  }
}

const WAIT_ANY_ERROR_MESSAGES = Object.freeze({
  task_not_found: 'The requested task was not found.',
  task_unavailable: 'The requested task could not be inspected.',
  invalid_event_cursor: 'The event cursor is invalid for the requested task.',
});

function publicWaitTargetError(error) {
  if (error?.code === 'invalid_event_cursor') {
    return { code: 'invalid_event_cursor', message: WAIT_ANY_ERROR_MESSAGES.invalid_event_cursor };
  }
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') {
    return { code: 'task_not_found', message: WAIT_ANY_ERROR_MESSAGES.task_not_found };
  }
  return { code: 'task_unavailable', message: WAIT_ANY_ERROR_MESSAGES.task_unavailable };
}

async function readWaitAnyTarget(root, descriptor) {
  try {
    const [{ task, paths }, progress] = await Promise.all([
      readTask(root, descriptor.task_id),
      readTaskEventProgress(root, descriptor.task_id, { cursor: descriptor.cursor }),
    ]);
    return {
      ...descriptor,
      task,
      paths,
      progress,
      error: null,
    };
  } catch (error) {
    return {
      ...descriptor,
      task: null,
      paths: null,
      progress: null,
      error: publicWaitTargetError(error),
    };
  }
}

async function refreshWaitAnyTargets(root, targets) {
  return Promise.all(targets.map(async (target) => {
    if (target.error?.code === 'task_not_found' && !target.task) return target;
    const refreshed = await readWaitAnyTarget(root, target);
    // A short-lived record/read failure should not turn a live wait into a
    // false terminal result. Retry once per refresh; the shared timer/watch
    // remains the only source of subsequent retries.
    if (refreshed.error?.code === 'task_unavailable') {
      return readWaitAnyTarget(root, target);
    }
    return refreshed;
  }));
}

function waitAnyProgressSnapshot(target, waitedMs, waitReason, waitUntil, targetReason = null) {
  if (!target.progress) return null;
  const reason = targetReason ?? (waitReason === 'timeout' || waitReason === 'transport_budget'
    ? waitReason
    : 'current');
  return {
    event_cursor: target.progress.event_cursor,
    last_event: target.progress.last_event ?? target.task?.last_event,
    new_event_count: target.progress.new_event_count,
    more_events: Boolean(target.progress.more_events),
    waited_ms: waitedMs,
    wait_reason: reason,
    wait_until: waitUntil,
  };
}

function waitAnyTargetReason(target, initial, {
  now,
  waitUntil,
  wakeOnAttention,
  coalesceFrom,
  coalesceMs,
} = {}) {
  if (target.error) return target.error.code === 'task_not_found' ? 'task_not_found' : null;
  if (!target.task || !target.progress) return 'target_error';
  if (waitUntil === 'progress' && target.cursor === null
    && initial?.progress?.event_cursor !== target.progress.event_cursor) {
    const coalescingFrom = coalesceFrom?.get?.(target.task_id) ?? null;
    if (target.progress.text_delta_count === 0
      || (coalescingFrom != null && now() >= coalescingFrom + coalesceMs)) {
      return 'progress';
    }
  }
  return waitWakeReason(target.task, target.progress, initial.task, {
    coalesceFrom: coalesceFrom?.get?.(target.task_id) ?? null,
    coalesceMs,
    clock: now,
    waitUntil,
    wakeOnAttention,
    deadlineAt: parseDeadlineAt(target.task.deadline_at),
    silenceTimeoutMs: Number.isInteger(target.task.silence_timeout_ms)
      ? target.task.silence_timeout_ms
      : null,
    lastActivityAt: lastActivityFrom(target.task, target.progress, initial.started),
  });
}

function earliestWaitAnyTimer(targets, {
  now,
  waitUntil,
  deadline,
  coalesceFrom,
} = {}) {
  let remaining = Math.max(0, deadline - now());
  for (const target of targets) {
    if (target.error || !target.task || !target.progress) continue;
    const taskDeadline = parseDeadlineAt(target.task.deadline_at);
    if (taskDeadline != null) remaining = Math.min(remaining, Math.max(0, taskDeadline - now()));
    if (waitUntil === 'terminal' && Number.isInteger(target.task.silence_timeout_ms)
      && target.task.silence_timeout_ms >= PROVIDER_SILENCE_WATCHDOG_MIN_MS) {
      const activity = lastActivityFrom(target.task, target.progress, now());
      remaining = Math.min(remaining, Math.max(0, activity + target.task.silence_timeout_ms - now()));
    }
    if (waitUntil === 'progress' && coalesceFrom.get(target.task_id) != null) {
      remaining = Math.min(remaining, Math.max(0, coalesceFrom.get(target.task_id) + TEXT_DELTA_COALESCE_MS - now()));
    }
  }
  return remaining;
}

function waitAnyResult(targets, {
  started,
  now,
  waitReason,
  waitUntil,
  triggeredTaskId = null,
  targetReasons = new Map(),
} = {}) {
  const waitedMs = Math.max(0, now() - started);
  return {
    tasks: targets.map((target) => ({
      task_id: target.task_id,
      task: target.task,
      progress: waitAnyProgressSnapshot(
        target,
        waitedMs,
        waitReason,
        waitUntil,
        targetReasons.get(target.task_id) ?? null,
      ),
      error: target.error,
    })),
    wait_reason: waitReason,
    wait_until: waitUntil,
    waited_ms: waitedMs,
    triggered_task_id: triggeredTaskId,
  };
}

function waitAnyCandidate(targets, initialById, options) {
  const targetReasons = new Map();
  for (const target of targets) {
    const initial = initialById.get(target.task_id);
    const reason = waitAnyTargetReason(target, initial, options);
    if (reason) targetReasons.set(target.task_id, reason);
  }
  const candidate = targets.find((target) => targetReasons.has(target.task_id));
  if (!candidate) return null;
  return {
    target: candidate,
    reason: targetReasons.get(candidate.task_id),
    targetReasons,
  };
}

/**
 * Wait on several task receipts with one shared deadline and concurrent
 * filesystem watchers. This is deliberately separate from the single-task
 * waiter so the legacy `tasks({})` list remains byte-for-byte unchanged.
 */
export async function waitForAnyTaskProgress(root, {
  task_ids,
  cursors,
  wait_ms,
  wait_until,
  wake_on_needs_attention = true,
  signal,
  now = Date.now,
  watch = defaultWatch,
  delay = waitDelay,
  fallback_ms,
} = {}) {
  const taskIds = parseTaskIds(task_ids);
  const cursorMap = parseTaskCursors(cursors, taskIds);
  const waitUntil = parseWaitUntil(wait_until);
  const followLiveDeadline = waitUntil === 'terminal' && wait_ms === undefined;
  const waitMs = followLiveDeadline ? MAX_TASK_WAIT_MS : parseTaskWaitMs(wait_ms);
  const fallbackMs = Number.isInteger(fallback_ms) && fallback_ms >= 1 && fallback_ms <= MAX_TASK_WAIT_MS
    ? fallback_ms
    : (waitUntil === 'terminal' ? TASK_TERMINAL_WATCH_FALLBACK_MS : TASK_WAIT_WATCH_FALLBACK_MS);
  const started = now();
  const descriptors = taskIds.map((task_id) => ({ task_id, cursor: cursorMap.get(task_id) ?? null }));
  let targets = await Promise.all(descriptors.map((descriptor) => readWaitAnyTarget(root, descriptor)));
  const initialById = new Map(targets.map((target) => [target.task_id, {
    task: target.task,
    progress: target.progress,
    started,
  }]));
  const coalesceFrom = new Map();
  for (const target of targets) {
    if (target.progress?.text_delta_count > 0 && target.cursor !== null) coalesceFrom.set(target.task_id, started);
  }
  const options = {
    now,
    waitUntil,
    wakeOnAttention: wake_on_needs_attention !== false,
    coalesceFrom,
    coalesceMs: TEXT_DELTA_COALESCE_MS,
  };
  const finish = (waitReason, triggeredTaskId = null, targetReasons = new Map()) => waitAnyResult(targets, {
    started,
    now,
    waitReason,
    waitUntil,
    triggeredTaskId,
    targetReasons,
  });

  if (waitMs === 0) {
    const immediate = waitAnyCandidate(targets, initialById, options);
    if (immediate) return finish(immediate.reason, immediate.target.task_id, immediate.targetReasons);
    return finish('current');
  }

  const immediate = waitAnyCandidate(targets, initialById, options);
  if (immediate) return finish(immediate.reason, immediate.target.task_id, immediate.targetReasons);
  if (signal?.aborted) return finish('disconnected');

  const deadline = started + waitMs;
  const gate = createNotifyGate();
  const watchers = new Map();
  const rewatchAttempts = new Set();
  let watchFailed = false;
  const closeAllWatchers = () => {
    for (const watcher of watchers.values()) closeTaskWatcher(watcher);
    watchers.clear();
  };
  const armWatcher = (target) => {
    closeTaskWatcher(watchers.get(target.task_id));
    watchers.delete(target.task_id);
    if (target.error || !target.paths) return;
    try {
      const watcher = attachTaskWatcher(target.paths.directory, watch, (reason) => gate.notify({
        reason,
        task_id: target.task_id,
      }));
      if (!watcher || typeof watcher.close !== 'function') {
        watchFailed = true;
        return;
      }
      watchers.set(target.task_id, watcher);
    } catch {
      watchFailed = true;
    }
  };
  const onAbort = () => gate.notify({ reason: 'abort' });
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (const target of targets) armWatcher(target);
    // Re-read after arming all watchers. The concurrent reads close the race
    // between the initial snapshot and an append/receipt rename.
    targets = await refreshWaitAnyTargets(root, targets);
    for (const target of targets) {
      if (target.progress?.text_delta_count > 0 && coalesceFrom.get(target.task_id) == null) {
        coalesceFrom.set(target.task_id, now());
      }
    }
    let candidate = waitAnyCandidate(targets, initialById, options);
    if (candidate) return finish(candidate.reason, candidate.target.task_id, candidate.targetReasons);

    while (now() < deadline) {
      if (signal?.aborted) return finish('disconnected');
      const remaining = earliestWaitAnyTimer(targets, {
        now,
        waitUntil,
        deadline,
        coalesceFrom,
      });
      if (remaining <= 0) break;
      const reason = await raceWait({
        delay,
        remainingMs: remaining,
        fallbackMs: watchFailed ? Math.min(fallbackMs, remaining) : null,
        coalesceMs: waitUntil === 'progress'
          ? (() => {
            const values = [...coalesceFrom.values()];
            return values.length > 0
              ? Math.min(...values.map((at) => Math.max(0, at + TEXT_DELTA_COALESCE_MS - now())))
              : null;
          })()
          : null,
        notifyTake: gate.take,
        signal,
      });
      gate.detachWaiter();
      const wakeReason = reason?.reason ?? reason;
      if (wakeReason === 'abort' || signal?.aborted) return finish('disconnected');
      targets = await refreshWaitAnyTargets(root, targets);
      for (const target of targets) {
        if (target.progress?.text_delta_count > 0 && coalesceFrom.get(target.task_id) == null) {
          coalesceFrom.set(target.task_id, now());
        }
      }
      candidate = waitAnyCandidate(targets, initialById, options);
      if (candidate) return finish(candidate.reason, candidate.target.task_id, candidate.targetReasons);
      if (wakeReason === 'watch-error') {
        const taskId = reason?.task_id;
        if (taskId && !rewatchAttempts.has(taskId)) {
          rewatchAttempts.add(taskId);
          const target = targets.find((entry) => entry.task_id === taskId);
          if (target) armWatcher(target);
        } else {
          watchFailed = true;
          if (taskId) {
            closeTaskWatcher(watchers.get(taskId));
            watchers.delete(taskId);
          }
        }
      }
      if (reason === 'fallback') watchFailed = true;
    }

    targets = await refreshWaitAnyTargets(root, targets);
    for (const target of targets) {
      if (target.progress?.text_delta_count > 0 && coalesceFrom.get(target.task_id) == null) {
        coalesceFrom.set(target.task_id, now());
      }
    }
    candidate = waitAnyCandidate(targets, initialById, options);
    if (candidate) return finish(candidate.reason, candidate.target.task_id, candidate.targetReasons);
    if (signal?.aborted) return finish('disconnected');
    if (waitUntil === 'terminal' && waitMs >= MAX_TASK_WAIT_MS
      && targets.some((target) => target.task && (remainingDeadlineMs(target.task, now()) ?? 0) > 0)) {
      return finish('transport_budget');
    }
    return finish('timeout');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    closeAllWatchers();
  }
}

export async function projectLiveLastEvent(root, task) {
  if (task?.last_event) return task;
  try {
    const progress = await readTaskEventProgress(root, task.id);
    return progress.last_event ? { ...task, last_event: progress.last_event } : task;
  } catch {
    return task;
  }
}

export async function writeRuntimeRecord(root, taskId, record) {
  const { paths } = await readTask(root, taskId);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Runtime record must be an object.');
  const value = { task_id: requireTaskId(taskId), ...record, updated_at: new Date().toISOString() };
  await writeAtomic(paths.runtime, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export async function readRuntimeRecord(root, taskId) {
  const { paths } = await readTask(root, taskId);
  try {
    return JSON.parse(await readFile(paths.runtime, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listTasks(root = stateRoot()) {
  const tasksDirectory = path.join(path.resolve(root), 'tasks');
  let entries;
  try {
    entries = await readdir(tasksDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
    try {
      records.push((await readTask(root, entry.name)).task);
    } catch {
      // A corrupt record remains on disk for operator inspection but is not
      // projected as a valid task.
    }
  }
  return records.sort((left, right) => {
    const byTime = right.created_at.localeCompare(left.created_at);
    if (byTime !== 0) return byTime;
    return right.id.localeCompare(left.id);
  });
}

export const STATUS_TASK_LIMIT_MAX = 20;
export const TASKS_PAGE_LIMIT_MAX = 20;
export const TASKS_PAGE_LIMIT_MIN = 1;

const VALID_PROVIDERS = new Set(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
const VALID_PUBLIC_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'transport_lost', 'environment_blocked', 'needs_attention', 'accepted', 'starting', 'running', 'cancelling']);
const VALID_DETAIL = new Set(['full', 'compact']);

function failCompact(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function parseDetail(value) {
  if (value === undefined || value === null) return 'full';
  if (typeof value !== 'string' || !VALID_DETAIL.has(value)) {
    failCompact('invalid_detail', 'detail must be full or compact.');
  }
  return value;
}

export function parseStatusTaskLimit(value) {
  if (value === undefined || value === null) return STATUS_TASK_LIMIT_MAX;
  if (!Number.isInteger(value) || value < 0 || value > STATUS_TASK_LIMIT_MAX) {
    failCompact('invalid_task_limit', `task_limit must be an integer from 0 to ${STATUS_TASK_LIMIT_MAX}.`);
  }
  return value;
}

export function parseStatusIncludeTasks(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'boolean') failCompact('invalid_include_tasks', 'include_tasks must be a boolean.');
  return value;
}

export function parseTasksLimit(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < TASKS_PAGE_LIMIT_MIN || value > TASKS_PAGE_LIMIT_MAX) {
    failCompact('invalid_limit', `limit must be an integer from ${TASKS_PAGE_LIMIT_MIN} to ${TASKS_PAGE_LIMIT_MAX}.`);
  }
  return value;
}

export function parseTasksProvider(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !VALID_PROVIDERS.has(value)) {
    failCompact('invalid_provider', 'provider must be one of grok, cursor-local, cursor-cloud, dsh.');
  }
  return value;
}

export function parseTasksState(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    failCompact('invalid_state', 'state must be a valid public state.');
  }
  if (!VALID_PUBLIC_STATES.has(value) && !new Set(['completed','failed','timeout','cancelled','environment_blocked','transport_lost','needs_attention','accepted','starting','running','cancelling','succeeded','timed_out']).has(value)) {
    failCompact('invalid_state', 'state must be a valid public state.');
  }
  return value;
}

// Keyset cursor: opaque base64 of JSON {v, ca, id, p, s, d}
// Ordered by created_at DESC then id DESC. Cursor binds canonical provider/state/detail.
function compareTaskToAnchor(task, anchor) {
  const byTime = task.created_at.localeCompare(anchor.ca);
  if (byTime !== 0) return byTime;
  return task.id.localeCompare(anchor.id);
}

function isAfterAnchor(task, anchor) {
  // Returns true if task should appear AFTER anchor in DESC order (i.e., smaller key)
  // DESC: larger created_at first. So after means created_at < anchor.ca OR equal and id < anchor.id
  if (task.created_at < anchor.ca) return true;
  if (task.created_at > anchor.ca) return false;
  return task.id < anchor.id;
}

export function encodeTasksCursor(anchor) {
  if (!anchor || typeof anchor !== 'object') failCompact('invalid_cursor', 'cursor payload is invalid.');
  if (typeof anchor.ca !== 'string' || typeof anchor.id !== 'string') failCompact('invalid_cursor', 'cursor anchor is invalid.');
  if (!TASK_ID.test(anchor.id)) failCompact('invalid_cursor', 'cursor anchor id is invalid.');
  // ca must be ISO-like; basic check
  if (Number.isNaN(Date.parse(anchor.ca))) failCompact('invalid_cursor', 'cursor anchor timestamp is invalid.');
  const payload = {
    v: 1,
    ca: anchor.ca,
    id: anchor.id,
    p: anchor.p ?? null,
    s: anchor.s ?? null,
    d: anchor.d ?? 'full',
  };
  // Validate provider/state/detail canonical
  if (payload.p !== null && !VALID_PROVIDERS.has(payload.p)) failCompact('invalid_cursor', 'cursor provider is invalid.');
  if (payload.s !== null && !VALID_PUBLIC_STATES.has(payload.s) && !new Set(['completed','failed','timeout','cancelled','environment_blocked','transport_lost','needs_attention','accepted','starting','running','cancelling','succeeded','timed_out']).has(payload.s)) {
    failCompact('invalid_cursor', 'cursor state is invalid.');
  }
  if (!VALID_DETAIL.has(payload.d)) failCompact('invalid_cursor', 'cursor detail is invalid.');
  const json = JSON.stringify(payload);
  if (json.length > 1024) failCompact('invalid_cursor', 'cursor is too long.');
  return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeTasksCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string') failCompact('invalid_cursor', 'cursor must be an opaque base64 string.');
  if (cursor.length > 2048) failCompact('invalid_cursor', 'cursor is too long.');
  let json;
  try {
    json = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    failCompact('invalid_cursor', 'cursor must be an opaque base64 string.');
  }
  // Canonical check: re-encode must match
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    failCompact('invalid_cursor', 'cursor must be an opaque base64 pagination cursor.');
  }
  if (!payload || typeof payload !== 'object' || payload.v !== 1 || typeof payload.ca !== 'string' || typeof payload.id !== 'string') {
    failCompact('invalid_cursor', 'cursor must be an opaque base64 pagination cursor.');
  }
  if (!TASK_ID.test(payload.id)) failCompact('invalid_cursor', 'cursor anchor id is invalid.');
  if (Number.isNaN(Date.parse(payload.ca))) failCompact('invalid_cursor', 'cursor anchor timestamp is invalid.');
  if (payload.p !== null && payload.p !== undefined && !VALID_PROVIDERS.has(payload.p)) failCompact('invalid_cursor', 'cursor provider is invalid.');
  if (payload.s !== null && payload.s !== undefined && payload.s !== null && !VALID_PUBLIC_STATES.has(payload.s) && !new Set(['completed','failed','timeout','cancelled','environment_blocked','transport_lost','needs_attention','accepted','starting','running','cancelling','succeeded','timed_out']).has(payload.s)) {
    failCompact('invalid_cursor', 'cursor state is invalid.');
  }
  if (!VALID_DETAIL.has(payload.d)) failCompact('invalid_cursor', 'cursor detail is invalid.');
  // Canonical re-encode check
  const canonicalPayload = { v: 1, ca: payload.ca, id: payload.id, p: payload.p ?? null, s: payload.s ?? null, d: payload.d };
  const canonicalJson = JSON.stringify(canonicalPayload);
  const canonical = Buffer.from(canonicalJson, 'utf8').toString('base64');
  if (canonical !== cursor) {
    failCompact('invalid_cursor', 'cursor must be a canonical opaque cursor.');
  }
  return canonicalPayload;
}

// Legacy offset support removed: only keyset cursors are valid.

export async function listTasksPage(root = stateRoot(), options = {}) {
  const detail = parseDetail(options.detail);
  const limit = parseTasksLimit(options.limit);
  const provider = parseTasksProvider(options.provider);
  const stateFilter = parseTasksState(options.state ?? options.status);
  const effectiveLimit = limit ?? (detail === 'compact' ? 20 : null);
  // Decode and validate cursor binding filters
  let anchor = decodeTasksCursor(options.cursor ?? null);
  if (anchor) {
    const anchorProvider = anchor.p ?? null;
    const anchorState = anchor.s ?? null;
    const anchorDetail = anchor.d ?? 'full';
    if ((anchorProvider ?? null) !== (provider ?? null) || (anchorState ?? null) !== (stateFilter ?? null) || anchorDetail !== detail) {
      failCompact('invalid_cursor', 'cursor does not match requested filters.');
    }
  }
  let tasks = await listTasks(root);
  if (provider) tasks = tasks.filter((t) => t.provider === provider);
  if (stateFilter) {
    const { publicState: ps } = await import('./contract.mjs');
    tasks = tasks.filter((t) => ps(t.status) === stateFilter || t.status === stateFilter);
  }
  const total = tasks.length;
  // Apply keyset pagination
  let remaining = tasks;
  if (anchor) {
    remaining = tasks.filter((t) => isAfterAnchor(t, anchor));
  }
  let sliced;
  if (effectiveLimit == null) {
    sliced = remaining;
  } else {
    sliced = remaining.slice(0, effectiveLimit);
  }
  const hasMore = sliced.length < remaining.length;
  let next_cursor = null;
  if (hasMore && sliced.length > 0) {
    const last = sliced[sliced.length - 1];
    next_cursor = encodeTasksCursor({ ca: last.created_at, id: last.id, p: provider ?? null, s: stateFilter ?? null, d: detail });
  } else if (effectiveLimit != null && remaining.length > sliced.length) {
    const last = sliced[sliced.length - 1];
    if (last) next_cursor = encodeTasksCursor({ ca: last.created_at, id: last.id, p: provider ?? null, s: stateFilter ?? null, d: detail });
  }
  // If not hasMore, next_cursor remains null
  return {
    tasks: sliced,
    next_cursor,
    has_more: hasMore,
    total,
    limit: effectiveLimit,
    detail,
  };
}

export async function listTasksFiltered(root = stateRoot(), options = {}) {
  return listTasksPage(root, options);
}
