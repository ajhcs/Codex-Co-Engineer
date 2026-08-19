import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendTaskEvent,
  clearTaskLaunchReservation,
  createLaunchReservation,
  createTask,
  launchReservationActive,
  listTasks,
  readPrompt,
  readRuntimeRecord,
  readTask,
  requireTaskId,
  reserveTaskLaunch,
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

test('launch reservations are owner-local, bounded, and cannot be stolen while active', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'reserve', record: { id: 'reserve-one', status: 'accepted' } });
  const now = Date.now();
  const first = await reserveTaskLaunch(root, 'reserve-one', createLaunchReservation({ now }));
  const task = (await readTask(root, 'reserve-one')).task;
  assert.equal(task.launch_reservation.token, first.token);
  assert.equal(launchReservationActive(task, now + 1), true);
  assert.equal(launchReservationActive(task, Date.parse(first.expires_at) + 1), false);
  await assert.rejects(
    reserveTaskLaunch(root, 'reserve-one', createLaunchReservation({ now: now + 1 })),
    (error) => error.code === 'task_launch_busy',
  );
  await clearTaskLaunchReservation(root, 'reserve-one', first.token);
  assert.equal((await readTask(root, 'reserve-one')).task.launch_reservation, null);
});

test('concurrent updates serialize and terminal cancellation wins', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-store-race-'));
  await createTask({ root, prompt: 'race', record: { id: 'race-one', status: 'running', provider: 'grok', cwd: root } });
  await Promise.all(Array.from({ length: 12 }, (_, index) => updateTask(root, 'race-one', { marker: index })));
  const afterRace = (await readTask(root, 'race-one')).task;
  assert.equal(afterRace.revision, 13);
  await updateTask(root, 'race-one', { status: 'cancelling' });
  await updateTask(root, 'race-one', { status: 'completed', result: 'late worker result' });
  await updateTask(root, 'race-one', { status: 'cancelled' });
  const terminal = (await readTask(root, 'race-one')).task;
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.result, undefined);
});

test('a lock left by a dead process is recovered', async () => {
  const root = await temporaryRoot();
  const { paths } = await createTask({ root, prompt: 'recover', record: { id: 'stale-lock', status: 'running' } });
  await writeFile(paths.updateLock, `${JSON.stringify({ pid: 999999999, start_ticks: '1', nonce: 'dead' })}\n`, { mode: 0o600 });
  const task = await updateTask(root, 'stale-lock', { recovered: true });
  assert.equal(task.recovered, true);
});

test('an old malformed update lock is recovered', async () => {
  const root = await temporaryRoot();
  const { paths } = await createTask({ root, prompt: 'recover malformed', record: { id: 'malformed-lock', status: 'running' } });
  await writeFile(paths.updateLock, '{partial', { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await utimes(paths.updateLock, old, old);
  const task = await updateTask(root, 'malformed-lock', { recovered: true });
  assert.equal(task.recovered, true);
});

test('uncertain cancellation can remain reconcilable without accepting a late completion', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'cancel', record: { id: 'cancel-uncertain', status: 'running' } });
  await updateTask(root, 'cancel-uncertain', { status: 'cancelling' });
  await updateTask(root, 'cancel-uncertain', { status: 'transport_lost', error: { code: 'cancel_unconfirmed' } });
  const uncertain = (await readTask(root, 'cancel-uncertain')).task;
  assert.equal(uncertain.status, 'transport_lost');
  assert.equal(uncertain.finished_at, undefined);
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
