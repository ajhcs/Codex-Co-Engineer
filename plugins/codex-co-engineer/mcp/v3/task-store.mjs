import { createHash, randomUUID } from 'node:crypto';
import { watch as watchDirectory } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const TASK_SCHEMA = 'codex-co-engineer.task.v1';
export const LAUNCH_RESERVATION_GRACE_MS = 15_000;
export const MAX_TASK_WAIT_MS = 60_000;
export const TEXT_DELTA_COALESCE_MS = 400;
export const TASK_WAIT_WATCH_FALLBACK_MS = 1_000;
export const MAX_EVENT_READ_BYTES = 64 * 1024;
export const EVENT_TAIL_PEEK_BYTES = 16 * 1024;
export const EVENT_CURSOR_PATTERN = /^[0-9]{1,16}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout']);
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
  for (const line of complete.split('\n')) {
    if (!line) continue;
    eventCount += 1;
    try {
      lastEvent = JSON.parse(line);
      if (isTextDeltaEvent(lastEvent)) textDeltaCount += 1;
      else immediateCount += 1;
    } catch {
      // A corrupt complete line is skipped for projection but still consumed
      // so waiters cannot get stuck on it.
    }
  }
  return { completeBytes: lastNewline + 1, lastEvent, eventCount, immediateCount, textDeltaCount };
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

function waitWakeReason(task, progress, initialTask, { coalesceFrom, coalesceMs, clock }) {
  if (TERMINAL.has(task.status)) return 'terminal';
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

export async function waitForTaskProgress(root, taskId, {
  cursor,
  wait_ms,
  signal,
  now = Date.now,
  watch = defaultWatch,
  delay = waitDelay,
  coalesce_ms = TEXT_DELTA_COALESCE_MS,
  fallback_ms = TASK_WAIT_WATCH_FALLBACK_MS,
} = {}) {
  const waitMs = parseTaskWaitMs(wait_ms);
  const coalesceMs = Number.isInteger(coalesce_ms) && coalesce_ms >= 0 && coalesce_ms <= MAX_TASK_WAIT_MS
    ? coalesce_ms
    : TEXT_DELTA_COALESCE_MS;
  const fallbackMs = Number.isInteger(fallback_ms) && fallback_ms >= 1 && fallback_ms <= MAX_TASK_WAIT_MS
    ? fallback_ms
    : TASK_WAIT_WATCH_FALLBACK_MS;
  const started = now();
  const { task: initialTask, paths } = await readTask(root, taskId);
  const initialProgress = await readTaskEventProgress(root, taskId, { cursor });
  const snapshot = (task, progress, reason) => ({
    task,
    progress: {
      event_cursor: progress.event_cursor,
      last_event: task.last_event ?? progress.last_event,
      new_event_count: progress.new_event_count,
      more_events: Boolean(progress.more_events),
      waited_ms: Math.max(0, now() - started),
      wait_reason: reason,
    },
  });
  const terminal = (task) => TERMINAL.has(task.status);
  const requestedCursor = parseEventCursor(cursor);
  const evaluate = (task, progress, coalesceFrom) => waitWakeReason(task, progress, initialTask, {
    coalesceFrom,
    coalesceMs,
    clock: now,
  });

  if (waitMs === 0) {
    return snapshot(initialTask, initialProgress, terminal(initialTask) ? 'terminal' : 'current');
  }
  if (terminal(initialTask)) {
    return snapshot(initialTask, initialProgress, 'terminal');
  }
  if (requestedCursor !== null && initialProgress.immediate_event_count > 0) {
    return snapshot(initialTask, initialProgress, 'progress');
  }
  if (requestedCursor !== null && initialProgress.more_events && initialProgress.new_event_count > 0) {
    return snapshot(initialTask, initialProgress, 'progress');
  }
  if (requestedCursor === null && initialProgress.last_event) {
    return snapshot(initialTask, initialProgress, 'current');
  }
  if (signal?.aborted) {
    return snapshot(initialTask, initialProgress, 'timeout');
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
    let currentProgress = await readTaskEventProgress(root, taskId, { cursor });
    if (currentProgress.text_delta_count > 0 && coalesceFrom == null) coalesceFrom = now();
    let wake = evaluate(currentTask, currentProgress, coalesceFrom);
    if (wake) return snapshot(currentTask, currentProgress, wake);

    while (now() < deadline) {
      if (signal?.aborted) break;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const coalesceRemaining = coalesceFrom == null ? null : Math.max(0, coalesceFrom + coalesceMs - now());
      const reason = await raceWait({
        delay,
        remainingMs: remaining,
        coalesceMs: coalesceRemaining,
        fallbackMs: watchFailed ? Math.min(fallbackMs, remaining) : null,
        notifyTake: gate.take,
        signal,
      });
      gate.detachWaiter();
      if (reason === 'abort') break;
      currentTask = (await readTask(root, taskId)).task;
      currentProgress = await readTaskEventProgress(root, taskId, { cursor });
      if (currentProgress.text_delta_count > 0 && coalesceFrom == null) coalesceFrom = now();
      wake = evaluate(currentTask, currentProgress, coalesceFrom);
      if (wake) return snapshot(currentTask, currentProgress, wake);
      if (reason === 'timeout') break;
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
    const finalProgress = await readTaskEventProgress(root, taskId, { cursor });
    if (terminal(finalTask)) return snapshot(finalTask, finalProgress, 'terminal');
    if (receiptAdvanced(finalTask, initialTask) || progressAdvanced(finalProgress, initialProgress)) {
      return snapshot(finalTask, finalProgress, 'progress');
    }
    return snapshot(finalTask, finalProgress, 'timeout');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    closeTaskWatcher(watcher);
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
  return records.sort((left, right) => right.created_at.localeCompare(left.created_at));
}
