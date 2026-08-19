import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const TASK_SCHEMA = 'codex-co-engineer.task.v1';
export const LAUNCH_RESERVATION_GRACE_MS = 15_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout']);
const UPDATE_LOCK_STALE_MS = 2_000;
const LOCAL_UPDATE_TAILS = new Map();

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
