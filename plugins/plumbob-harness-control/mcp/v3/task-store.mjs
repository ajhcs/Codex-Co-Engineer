import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const TASK_SCHEMA = 'codex-co-engineer.task.v1';
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;

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

export async function updateTask(root, taskId, changes) {
  const { task, paths } = await readTask(root, taskId);
  const nextChanges = typeof changes === 'function' ? await changes({ ...task }) : changes;
  if (!nextChanges || typeof nextChanges !== 'object' || Array.isArray(nextChanges)) {
    throw new TypeError('Task update must be an object.');
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
