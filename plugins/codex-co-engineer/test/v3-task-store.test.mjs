import assert from 'node:assert/strict';
import { appendFileSync, watch as watchDirectory } from 'node:fs';
import { appendFile, mkdtemp, open, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MCP_PENDING_CALL_BUDGET_MS } from '../mcp/v3/contract.mjs';
import {
  EVENT_TAIL_PEEK_BYTES,
  MAX_EVENT_READ_BYTES,
  MAX_TASK_WAIT_MS,
  TEXT_DELTA_COALESCE_MS,
  appendTaskEvent,
  clearTaskLaunchReservation,
  createLaunchReservation,
  createTask,
  isImmediateProgressEvent,
  isTextDeltaEvent,
  launchReservationActive,
  listTasks,
  parseEventCursor,
  parseTaskWaitMs,
  projectLiveLastEvent,
  readPrompt,
  readRuntimeRecord,
  readTask,
  readTaskEventProgress,
  requireTaskId,
  reserveTaskLaunch,
  taskPaths,
  updateTask,
  waitDelay,
  waitForTaskProgress,
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

test('event cursors reject non-boundary offsets and wait_ms bounds', () => {
  assert.equal(parseEventCursor(undefined), null);
  assert.equal(parseEventCursor('12'), 12);
  assert.throws(() => parseEventCursor('-1'), (error) => error.code === 'invalid_event_cursor');
  assert.throws(() => parseEventCursor('1e2'), (error) => error.code === 'invalid_event_cursor');
  assert.throws(() => parseEventCursor(4), (error) => error.code === 'invalid_event_cursor');
  assert.equal(parseTaskWaitMs(undefined), 0);
  assert.equal(parseTaskWaitMs(25_000), 25_000);
  assert.equal(parseTaskWaitMs(60_001), 60_001);
  assert.equal(MAX_TASK_WAIT_MS, MCP_PENDING_CALL_BUDGET_MS);
  assert.throws(() => parseTaskWaitMs(MAX_TASK_WAIT_MS + 1), (error) => error.code === 'invalid_wait_ms');
  assert.throws(() => parseTaskWaitMs(1.5), (error) => error.code === 'invalid_wait_ms');
});

test('live progress tails events.jsonl without rewriting task.json', async () => {
  const root = await temporaryRoot();
  const { task, paths } = await createTask({
    root,
    prompt: 'hidden prompt must not leak',
    record: { id: 'live-one', status: 'running', provider: 'grok' },
  });
  const first = await appendTaskEvent(root, 'live-one', {
    type: 'provider',
    event: { type: 'text_delta', text: 'chunk-one', pid: 4321, argv: ['grok', '--secret'] },
  });
  const snapshot = await readTaskEventProgress(root, 'live-one');
  assert.equal((await readTask(root, 'live-one')).task.revision, task.revision);
  assert.equal((await readTask(root, 'live-one')).task.last_event, undefined);
  assert.equal(snapshot.last_event.type, 'text_delta');
  assert.equal(snapshot.last_event.text, 'chunk-one');
  assert.equal(snapshot.last_event.pid, undefined);
  assert.equal(snapshot.last_event.argv, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /hidden prompt/u);
  assert.match(snapshot.event_cursor, /^[0-9]+$/u);
  assert.equal(snapshot.new_event_count, 0);

  const delta = await readTaskEventProgress(root, 'live-one', { cursor: '0' });
  assert.equal(delta.new_event_count, 1);
  assert.equal(delta.last_event.text, 'chunk-one');
  await appendTaskEvent(root, 'live-one', {
    type: 'provider',
    event: { type: 'text_delta', text: 'chunk-two', prompt: 'hidden prompt must not leak' },
  });
  const next = await readTaskEventProgress(root, 'live-one', { cursor: snapshot.event_cursor });
  assert.equal(next.new_event_count, 1);
  assert.equal(next.last_event.text, 'chunk-two');
  assert.equal(next.last_event.prompt, undefined);
  assert.equal(first.type, 'provider');
  assert.equal((await readFile(paths.record, 'utf8')).includes('chunk-two'), false);
});

test('partial event lines are not consumed and invalid cursors fail closed', async () => {
  const root = await temporaryRoot();
  const { paths } = await createTask({
    root,
    prompt: 'partial',
    record: { id: 'partial-one', status: 'running' },
  });
  await appendTaskEvent(root, 'partial-one', { type: 'transport', state: 'session_ready' });
  const ready = await readTaskEventProgress(root, 'partial-one');
  await appendFile(paths.events, '{"type":"provider","event":{"type":"text_delta","text":"incomp');
  const midWrite = await readTaskEventProgress(root, 'partial-one', { cursor: ready.event_cursor });
  assert.equal(midWrite.new_event_count, 0);
  assert.equal(midWrite.event_cursor, ready.event_cursor);
  await appendFile(paths.events, 'lete"}}\n');
  const complete = await readTaskEventProgress(root, 'partial-one', { cursor: ready.event_cursor });
  assert.equal(complete.new_event_count, 1);
  assert.equal(complete.last_event.text, 'incomplete');
  await assert.rejects(
    readTaskEventProgress(root, 'partial-one', { cursor: String(Number(complete.event_cursor) + 8) }),
    (error) => error.code === 'invalid_event_cursor',
  );
  await assert.rejects(
    readTaskEventProgress(root, 'partial-one', { cursor: '1' }),
    (error) => error.code === 'invalid_event_cursor',
  );
});

test('wait wakes on appended progress, terminal status, or timeout without leaking internals', async () => {
  const root = await temporaryRoot();
  await createTask({
    root,
    prompt: 'secret waiter prompt',
    record: { id: 'wait-one', status: 'running', provider: 'grok', agent_argv: ['grok', 'agent'] },
  });
  const started = await waitForTaskProgress(root, 'wait-one', { wait_ms: 0 });
  assert.equal(started.progress.wait_reason, 'current');
  assert.equal(started.progress.last_event, null);

  const pending = waitForTaskProgress(root, 'wait-one', {
    cursor: started.progress.event_cursor,
    wait_ms: 1_000,
  });
  setTimeout(() => {
    appendTaskEvent(root, 'wait-one', {
      type: 'provider',
      event: { type: 'tool_call', title: 'read', text: 'live-progress', pid: 99, argv: ['leak'] },
    }).catch(() => {});
  }, 20);
  const woke = await pending;
  assert.equal(woke.progress.wait_reason, 'progress');
  assert.equal(woke.progress.last_event.type, 'tool_call');
  assert.equal(woke.progress.last_event.text, 'live-progress');
  assert.equal(woke.progress.last_event.pid, undefined);
  assert.equal(woke.task.last_event, undefined);
  assert.doesNotMatch(JSON.stringify(woke.progress), /secret waiter prompt|"leak"/u);
  for (const key of ['event_cursor', 'last_event', 'new_event_count', 'more_events', 'waited_ms', 'wait_reason']) {
    assert.ok(key in woke.progress);
  }

  const terminalWait = waitForTaskProgress(root, 'wait-one', {
    cursor: woke.progress.event_cursor,
    wait_ms: 1_000,
  });
  setTimeout(() => {
    updateTask(root, 'wait-one', { status: 'cancelled', finished_at: new Date().toISOString() }).catch(() => {});
  }, 20);
  const cancelled = await terminalWait;
  assert.equal(cancelled.progress.wait_reason, 'terminal');
  assert.equal(cancelled.task.status, 'cancelled');

  const already = await waitForTaskProgress(root, 'wait-one', { wait_ms: 1_000 });
  assert.equal(already.progress.wait_reason, 'terminal');
  assert.ok(already.progress.waited_ms < 200);

  await createTask({
    root,
    prompt: 'still running',
    record: { id: 'wait-timeout', status: 'running' },
  });
  const idle = await readTaskEventProgress(root, 'wait-timeout');
  const timedOut = await waitForTaskProgress(root, 'wait-timeout', {
    cursor: idle.event_cursor,
    wait_ms: 40,
  });
  assert.equal(timedOut.progress.wait_reason, 'timeout');
  assert.ok(timedOut.progress.waited_ms >= 40);
});

test('concurrent readers can wait while another process appends events', async () => {
  const root = await temporaryRoot();
  await createTask({
    root,
    prompt: 'race wait',
    record: { id: 'wait-race', status: 'running' },
  });
  const baseline = await readTaskEventProgress(root, 'wait-race');
  const waiters = Promise.all(Array.from({ length: 4 }, () => waitForTaskProgress(root, 'wait-race', {
    cursor: baseline.event_cursor,
    wait_ms: 1_000,
  })));
  const handle = await open(taskPaths(root, 'wait-race').events, 'a', 0o600);
  try {
    await handle.appendFile(`${JSON.stringify({ at: new Date().toISOString(), type: 'provider', event: { type: 'tool_call', title: 'read', text: 'shared' } })}\n`);
  } finally {
    await handle.close();
  }
  const values = await waiters;
  for (const value of values) {
    assert.equal(value.progress.wait_reason, 'progress');
    assert.equal(value.progress.last_event.text, 'shared');
  }
});

test('projectLiveLastEvent overlays event-log progress onto a stale receipt', async () => {
  const root = await temporaryRoot();
  await createTask({
    root,
    prompt: 'overlay',
    record: { id: 'overlay-one', status: 'running' },
  });
  await appendTaskEvent(root, 'overlay-one', { type: 'provider', event: { type: 'text_delta', text: 'visible' } });
  const projected = await projectLiveLastEvent(root, (await readTask(root, 'overlay-one')).task);
  assert.equal(projected.last_event.text, 'visible');
  assert.equal((await readTask(root, 'overlay-one')).task.last_event, undefined);
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

function createMockWatch() {
  const state = { opened: 0, closed: 0, listener: null, errorHandler: null };
  const watch = (_directory, listener) => {
    state.opened += 1;
    state.listener = listener;
    return {
      close() { state.closed += 1; },
      on(event, handler) {
        if (event === 'error') state.errorHandler = handler;
        return this;
      },
    };
  };
  return { watch, state };
}

function recordingDelay(delays) {
  return (milliseconds, signal) => {
    delays.push(milliseconds);
    return waitDelay(milliseconds, signal);
  };
}

test('progress event classes distinguish coalesced text from immediate boundaries', () => {
  assert.equal(isTextDeltaEvent({ type: 'provider', event: { type: 'text_delta', text: 'x' } }), true);
  assert.equal(isTextDeltaEvent({ type: 'provider', event: { type: 'thought_delta' } }), true);
  assert.equal(isImmediateProgressEvent({ type: 'provider', event: { type: 'tool_call', title: 'read' } }), true);
  assert.equal(isImmediateProgressEvent({ type: 'terminal', status: 'cancelled' }), true);
  assert.equal(isImmediateProgressEvent({ type: 'transport', state: 'session_ready' }), true);
  assert.ok(TEXT_DELTA_COALESCE_MS >= 200 && TEXT_DELTA_COALESCE_MS <= 1_000);
  assert.ok(EVENT_TAIL_PEEK_BYTES <= MAX_EVENT_READ_BYTES);
});

test('wait snapshots stay backward compatible and wait_ms 0 is a non-blocking current view', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'snapshot', record: { id: 'snap-one', status: 'running' } });
  const snap = await waitForTaskProgress(root, 'snap-one', { wait_ms: 0 });
  assert.equal(snap.progress.wait_reason, 'current');
  assert.match(snap.progress.event_cursor, /^[0-9]+$/u);
  assert.equal(snap.progress.last_event, null);
  assert.equal(snap.progress.new_event_count, 0);
  assert.equal(typeof snap.progress.more_events, 'boolean');
  assert.equal(typeof snap.progress.waited_ms, 'number');
  assert.equal(snap.progress.waited_ms < 50, true);
  for (const key of ['event_cursor', 'last_event', 'new_event_count', 'more_events', 'waited_ms', 'wait_reason']) {
    assert.ok(Object.hasOwn(snap.progress, key));
  }
});

test('idle wait is event-driven and does not busy-poll', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'idle', record: { id: 'wait-idle', status: 'running' } });
  const baseline = await readTaskEventProgress(root, 'wait-idle');
  const delays = [];
  const { watch, state } = createMockWatch();
  const timedOut = await waitForTaskProgress(root, 'wait-idle', {
    cursor: baseline.event_cursor,
    wait_ms: 80,
    watch,
    delay: recordingDelay(delays),
  });
  assert.equal(timedOut.progress.wait_reason, 'timeout');
  assert.ok(timedOut.progress.waited_ms >= 80);
  assert.ok(delays.length <= 2);
  assert.ok(delays.some((value) => value >= 70));
  assert.equal(delays.filter((value) => value <= 50).length, 0);
  assert.equal(state.opened, 1);
  assert.equal(state.closed, state.opened);
});

test('filesystem notify wakes immediately on tool-call boundaries and cleans up the watcher', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'watch', record: { id: 'wait-watch', status: 'running' } });
  const baseline = await readTaskEventProgress(root, 'wait-watch');
  const delays = [];
  const { watch, state } = createMockWatch();
  const pending = waitForTaskProgress(root, 'wait-watch', {
    cursor: baseline.event_cursor,
    wait_ms: 1_000,
    watch,
    delay: recordingDelay(delays),
    coalesce_ms: 400,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await appendTaskEvent(root, 'wait-watch', {
    type: 'provider',
    event: { type: 'tool_call', title: 'read', text: 'boundary' },
  });
  state.listener('change', 'events.jsonl');
  const woke = await pending;
  assert.equal(woke.progress.wait_reason, 'progress');
  assert.equal(woke.progress.last_event.type, 'tool_call');
  assert.ok(woke.progress.waited_ms < 200);
  assert.ok(delays.length <= 2);
  assert.equal(state.closed, state.opened);
});

test('after-watch snapshot catches an append that raced watcher arming', async () => {
  const root = await temporaryRoot();
  const { paths } = await createTask({
    root,
    prompt: 'race arm',
    record: { id: 'wait-arm-race', status: 'running' },
  });
  const baseline = await readTaskEventProgress(root, 'wait-arm-race');
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    type: 'provider',
    event: { type: 'tool_call', title: 'read', text: 'raced' },
  })}\n`;
  const watch = (directory, listener) => {
    appendFileSync(paths.events, line);
    return watchDirectory(directory, { persistent: true }, listener);
  };
  const woke = await waitForTaskProgress(root, 'wait-arm-race', {
    cursor: baseline.event_cursor,
    wait_ms: 1_000,
    watch,
  });
  assert.equal(woke.progress.wait_reason, 'progress');
  assert.equal(woke.progress.last_event.text, 'raced');
});

test('status replacement and abort both settle without leaking watchers', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'status', record: { id: 'wait-status', status: 'running' } });
  const baseline = await readTaskEventProgress(root, 'wait-status');
  const statusWait = waitForTaskProgress(root, 'wait-status', {
    cursor: baseline.event_cursor,
    wait_ms: 1_000,
  });
  setTimeout(() => {
    updateTask(root, 'wait-status', { status: 'cancelling' }).catch(() => {});
  }, 15);
  const statusWoke = await statusWait;
  assert.equal(statusWoke.progress.wait_reason, 'progress');
  assert.equal(statusWoke.task.status, 'cancelling');

  const { watch, state } = createMockWatch();
  const controller = new AbortController();
  const pending = waitForTaskProgress(root, 'wait-status', {
    cursor: statusWoke.progress.event_cursor,
    wait_ms: 2_000,
    watch,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.progress.wait_reason, 'disconnected');
  assert.ok(aborted.progress.waited_ms < 200);
  assert.equal(state.closed, state.opened);
});

test('watcher errors re-arm once, then fall back without leaking handles', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'error', record: { id: 'wait-error', status: 'running' } });
  const baseline = await readTaskEventProgress(root, 'wait-error');
  const delays = [];
  const { watch, state } = createMockWatch();
  const pending = waitForTaskProgress(root, 'wait-error', {
    cursor: baseline.event_cursor,
    wait_ms: 90,
    watch,
    delay: recordingDelay(delays),
    fallback_ms: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  state.errorHandler(new Error('watch failed'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  state.errorHandler(new Error('watch failed again'));
  const timedOut = await pending;
  assert.equal(timedOut.progress.wait_reason, 'timeout');
  assert.equal(state.closed, state.opened);
  assert.ok(state.opened >= 2);
  assert.ok(delays.length <= 4);
  assert.equal(delays.filter((value) => value > 0 && value <= 50).length, 0);
});

test('text deltas are coalesced while tool-call boundaries preempt the hold', async () => {
  const root = await temporaryRoot();
  await createTask({ root, prompt: 'coalesce', record: { id: 'wait-coalesce', status: 'running' } });
  const baseline = await readTaskEventProgress(root, 'wait-coalesce');
  const held = waitForTaskProgress(root, 'wait-coalesce', {
    cursor: baseline.event_cursor,
    wait_ms: 1_000,
    coalesce_ms: 70,
  });
  await appendTaskEvent(root, 'wait-coalesce', {
    type: 'provider',
    event: { type: 'text_delta', text: 'delta-one' },
  });
  await appendTaskEvent(root, 'wait-coalesce', {
    type: 'provider',
    event: { type: 'text_delta', text: 'delta-two' },
  });
  const coalesced = await held;
  assert.equal(coalesced.progress.wait_reason, 'progress');
  assert.equal(coalesced.progress.last_event.text, 'delta-two');
  assert.ok(coalesced.progress.new_event_count >= 2);
  assert.ok(coalesced.progress.waited_ms >= 60);

  const already = await waitForTaskProgress(root, 'wait-coalesce', {
    cursor: baseline.event_cursor,
    wait_ms: 500,
    coalesce_ms: 50,
  });
  assert.equal(already.progress.wait_reason, 'progress');
  assert.ok(already.progress.waited_ms >= 40);

  const pre = await readTaskEventProgress(root, 'wait-coalesce');
  const preempt = waitForTaskProgress(root, 'wait-coalesce', {
    cursor: pre.event_cursor,
    wait_ms: 1_000,
    coalesce_ms: 400,
  });
  await appendTaskEvent(root, 'wait-coalesce', {
    type: 'provider',
    event: { type: 'text_delta', text: 'still-holding' },
  });
  await appendTaskEvent(root, 'wait-coalesce', {
    type: 'provider',
    event: { type: 'tool_call', title: 'edit', text: 'boundary' },
  });
  const woke = await preempt;
  assert.equal(woke.progress.wait_reason, 'progress');
  assert.equal(woke.progress.last_event.type, 'tool_call');
  assert.ok(woke.progress.waited_ms < 200);
});

test('large event logs page with bounded reads and skip oversized lines', async () => {
  const root = await temporaryRoot();
  const { paths } = await createTask({
    root,
    prompt: 'large',
    record: { id: 'big-log', status: 'running' },
  });
  const line = `${JSON.stringify({
    at: '2026-01-01T00:00:00.000Z',
    type: 'provider',
    event: { type: 'text_delta', text: 'n'.repeat(64) },
  })}\n`;
  const handle = await open(paths.events, 'a');
  const block = line.repeat(256);
  try {
    for (let index = 0; index < 120; index += 1) await handle.appendFile(block);
  } finally {
    await handle.close();
  }
  const bytes = (await stat(paths.events)).size;
  assert.ok(bytes > 2 * 1024 * 1024);

  const first = await readTaskEventProgress(root, 'big-log', { cursor: '0' });
  assert.equal(first.more_events, true);
  assert.ok(first.new_event_count > 0);
  assert.ok(Number(first.event_cursor) > 0);
  assert.ok(Number(first.event_cursor) <= MAX_EVENT_READ_BYTES);

  let cursor = first.event_cursor;
  let pages = 1;
  let events = first.new_event_count;
  while (true) {
    const next = await readTaskEventProgress(root, 'big-log', { cursor });
    assert.ok(Number(next.event_cursor) - Number(cursor) <= MAX_EVENT_READ_BYTES);
    events += next.new_event_count;
    cursor = next.event_cursor;
    pages += 1;
    if (!next.more_events) break;
    assert.ok(pages < 500);
  }
  assert.ok(pages > 10);
  assert.ok(events > 10_000);
  assert.equal(Number(cursor), bytes);

  const paged = await waitForTaskProgress(root, 'big-log', {
    cursor: '0',
    wait_ms: 5_000,
    coalesce_ms: 400,
  });
  assert.equal(paged.progress.wait_reason, 'progress');
  assert.equal(paged.progress.more_events, true);
  assert.ok(paged.progress.waited_ms < 200);
  assert.ok(Number(paged.progress.event_cursor) <= MAX_EVENT_READ_BYTES);

  await createTask({ root, prompt: 'oversize', record: { id: 'oversize-one', status: 'running' } });
  const oversizePaths = taskPaths(root, 'oversize-one');
  const start = await readTaskEventProgress(root, 'oversize-one');
  await appendFile(oversizePaths.events, `{"type":"provider","event":{"type":"text_delta","text":"${'Z'.repeat(200_000)}"}}\n`);
  await appendTaskEvent(root, 'oversize-one', { type: 'terminal', status: 'completed' });
  const skipped = await readTaskEventProgress(root, 'oversize-one', { cursor: start.event_cursor });
  assert.equal(skipped.last_event.type, 'status');
  assert.equal(skipped.last_event.truncated, true);
  assert.equal(skipped.new_event_count, 1);
  assert.ok(Number(skipped.event_cursor) - Number(start.event_cursor) > MAX_EVENT_READ_BYTES);
  const rest = await readTaskEventProgress(root, 'oversize-one', { cursor: skipped.event_cursor });
  assert.equal(rest.last_event.type, 'terminal');
  assert.equal(rest.more_events, false);
});

test('cursor catch-up stays on line boundaries and rejects unsafe offsets', async () => {
  const root = await temporaryRoot();
  const { paths } = await createTask({
    root,
    prompt: 'cursor',
    record: { id: 'cursor-bound', status: 'running' },
  });
  await appendTaskEvent(root, 'cursor-bound', { type: 'accepted' });
  const first = await readTaskEventProgress(root, 'cursor-bound', { cursor: '0' });
  const atEnd = await readTaskEventProgress(root, 'cursor-bound', { cursor: first.event_cursor });
  assert.equal(atEnd.new_event_count, 0);
  assert.equal(atEnd.more_events, false);
  assert.equal(atEnd.event_cursor, first.event_cursor);
  await assert.rejects(
    readTaskEventProgress(root, 'cursor-bound', { cursor: String((await stat(paths.events)).size + 1) }),
    (error) => error.code === 'invalid_event_cursor',
  );
  assert.throws(() => parseEventCursor('9007199254740993'), (error) => error.code === 'invalid_event_cursor');
});
