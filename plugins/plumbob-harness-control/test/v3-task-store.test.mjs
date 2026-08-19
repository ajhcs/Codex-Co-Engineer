import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendTaskEvent,
  createTask,
  listTasks,
  readPrompt,
  readRuntimeRecord,
  readTask,
  requireTaskId,
  taskPaths,
  updateTask,
  writeRuntimeRecord,
} from '../mcp/v3/task-store.mjs';

async function temporaryRoot() {
  return mkdtemp(path.join(tmpdir(), 'co-engineer-task-store-'));
}

test('task identifiers reject path traversal', () => {
  assert.throws(() => requireTaskId('../escape'), /task_id/u);
  assert.equal(requireTaskId('agent-42.review'), 'agent-42.review');
});

test('task records and prompts are owner-only and prompt text is not in the record', async () => {
  const root = await temporaryRoot();
  const prompt = 'Implement the adapter without leaking this prompt.';
  const { task, paths } = await createTask({
    root,
    prompt,
    record: { id: 'adapter', provider: 'grok', state: 'queued' },
  });

  assert.equal(task.schema, 'codex-co-engineer.task.v1');
  assert.equal(await readPrompt(root, 'adapter'), prompt);
  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.record)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.prompt)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(paths.record, 'utf8'), /without leaking/u);
});

test('updates preserve identity and monotonically advance revision', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'test', record: { id: 'run-1', state: 'queued' } });
  const running = await updateTask(root, 'run-1', { state: 'running', pid: 123 });
  const complete = await updateTask(root, 'run-1', (task) => ({ state: 'completed', pid: task.pid }));

  assert.equal(running.revision, 2);
  assert.equal(complete.revision, 3);
  assert.equal(complete.id, 'run-1');
  assert.equal(complete.pid, 123);
});

test('events are JSONL and listTasks ignores invalid task directories', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'one', record: { id: 'one', state: 'queued' } });
  await createTask({ root, prompt: 'two', record: { id: 'two', state: 'queued' } });
  await appendTaskEvent(root, 'one', { type: 'accepted' });
  const paths = taskPaths(root, 'one');
  const event = JSON.parse((await readFile(paths.events, 'utf8')).trim());

  assert.equal(event.type, 'accepted');
  assert.match(event.at, /^20/u);
  assert.deepEqual(new Set((await listTasks(root)).map((task) => task.id)), new Set(['one', 'two']));
  assert.equal((await readTask(root, 'one')).task.state, 'queued');
});

test('runtime identity is stored separately from the task receipt', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'hello', record: { id: 'runtime', status: 'accepted' } });
  await writeRuntimeRecord(root, 'runtime', { pid: 123, process_start_ticks: '456', process_group: 123 });
  const runtime = await readRuntimeRecord(root, 'runtime');
  assert.equal(runtime.task_id, 'runtime');
  assert.equal(runtime.pid, 123);
  assert.equal(runtime.process_start_ticks, '456');
  assert.equal(runtime.process_group, 123);
  assert.equal((await readTask(root, 'runtime')).task.pid, undefined);
});
