import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendTaskEvent,
  createTask,
  readTask,
  updateTask,
  waitDelay,
  waitForAnyTaskProgress,
} from '../mcp/v3/task-store.mjs';

async function temporaryRoot() {
  return mkdtemp(path.join(tmpdir(), 'co-engineer-wait-any-'));
}

function mockWatch() {
  const state = { opened: [], closed: 0, listeners: new Map(), errors: new Map() };
  const watch = (directory, listener) => {
    state.opened.push(directory);
    state.listeners.set(directory, listener);
    return {
      close() {
        state.closed += 1;
      },
      on(event, handler) {
        if (event === 'error') state.errors.set(directory, handler);
        return this;
      },
    };
  };
  return { state, watch };
}

test('wait-any wakes on the first target progress and honors per-target cursors', async () => {
  const root = await temporaryRoot();
  try {
    await createTask({ root, prompt: 'one', record: { id: 'wait-a', status: 'running' } });
    await createTask({ root, prompt: 'two', record: { id: 'wait-b', status: 'running' } });
    const initial = await waitForAnyTaskProgress(root, {
      task_ids: ['wait-a', 'wait-b'],
      wait_ms: 0,
    });
    const cursors = Object.fromEntries(initial.tasks.map((entry) => [entry.task_id, entry.progress.event_cursor]));
    const pending = waitForAnyTaskProgress(root, {
      task_ids: ['wait-a', 'wait-b'],
      cursors,
      wait_ms: 1_000,
      wait_until: 'progress',
    });
    setTimeout(() => appendTaskEvent(root, 'wait-b', {
      type: 'provider',
      event: { type: 'tool_call', text: 'first-target' },
    }).catch(() => {}), 20);
    const woke = await pending;
    assert.equal(woke.wait_reason, 'progress');
    assert.equal(woke.triggered_task_id, 'wait-b');
    assert.equal(woke.tasks.find((entry) => entry.task_id === 'wait-b').progress.last_event.text, 'first-target');
    assert.ok(woke.waited_ms < 500);

    const { watch } = mockWatch();
    const current = await waitForAnyTaskProgress(root, {
      task_ids: ['wait-b'],
      cursors: { 'wait-b': woke.tasks.find((entry) => entry.task_id === 'wait-b').progress.event_cursor },
      wait_ms: 35,
      wait_until: 'progress',
      watch,
    });
    assert.equal(current.wait_reason, 'timeout');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('already-terminal and needs-attention targets return immediately', async () => {
  const root = await temporaryRoot();
  try {
    await createTask({ root, prompt: 'done', record: { id: 'wait-done', status: 'completed' } });
    await createTask({ root, prompt: 'attention', record: { id: 'wait-attn', status: 'needs_attention' } });
    const done = await waitForAnyTaskProgress(root, {
      task_ids: ['wait-done', 'wait-attn'],
      wait_until: 'terminal',
      wait_ms: 10_000,
    });
    assert.equal(done.wait_reason, 'terminal');
    assert.equal(done.triggered_task_id, 'wait-done');
    assert.ok(done.waited_ms < 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cursorless progress waits baseline an existing event-log tail', async () => {
  const root = await temporaryRoot();
  try {
    await createTask({ root, prompt: 'tail', record: { id: 'tail-one', status: 'running' } });
    await appendTaskEvent(root, 'tail-one', {
      type: 'provider',
      event: { type: 'tool_call', text: 'existing-progress' },
    });
    const pending = waitForAnyTaskProgress(root, {
      task_ids: ['tail-one'],
      wait_until: 'progress',
      wait_ms: 1_000,
    });
    setTimeout(() => appendTaskEvent(root, 'tail-one', {
      type: 'provider',
      event: { type: 'tool_call', text: 'new-progress' },
    }).catch(() => {}), 20);
    const woke = await pending;
    assert.equal(woke.wait_reason, 'progress');
    assert.equal(woke.triggered_task_id, 'tail-one');
    assert.equal(woke.tasks[0].progress.last_event.text, 'new-progress');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeout uses one shared timer, closes every watcher, and returns every snapshot', async () => {
  const root = await temporaryRoot();
  try {
    await createTask({ root, prompt: 'one', record: { id: 'time-a', status: 'running' } });
    await createTask({ root, prompt: 'two', record: { id: 'time-b', status: 'running' } });
    const { watch, state } = mockWatch();
    let clock = 0;
    let delayCalls = 0;
    const waited = await waitForAnyTaskProgress(root, {
      task_ids: ['time-a', 'time-b'],
      wait_ms: 75,
      wait_until: 'progress',
      now: () => clock,
      watch,
      delay: async (milliseconds) => {
        delayCalls += 1;
        clock += milliseconds;
        return 'timeout';
      },
    });
    assert.equal(waited.wait_reason, 'timeout');
    assert.equal(waited.waited_ms, 75);
    assert.equal(delayCalls, 1);
    assert.equal(state.opened.length, 2);
    assert.equal(state.closed, 2);
    assert.deepEqual(waited.tasks.map((entry) => entry.task_id), ['time-a', 'time-b']);
    assert.deepEqual(waited.tasks.map((entry) => entry.progress.wait_reason), ['timeout', 'timeout']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a target that reaches terminal at the shared budget keeps its authoritative reason', async () => {
  const root = await temporaryRoot();
  try {
    await createTask({ root, prompt: 'budget-a', record: { id: 'budget-a', status: 'running' } });
    await createTask({ root, prompt: 'budget-b', record: { id: 'budget-b', status: 'running' } });
    const { watch } = mockWatch();
    let clock = 0;
    const waited = await waitForAnyTaskProgress(root, {
      task_ids: ['budget-a', 'budget-b'],
      wait_until: 'terminal',
      wait_ms: 14_400_000,
      now: () => clock,
      watch,
      delay: async (milliseconds) => {
        await updateTask(root, 'budget-a', {
          status: 'completed',
          finished_at: new Date().toISOString(),
        });
        clock += milliseconds;
        return 'timeout';
      },
    });
    assert.equal(waited.wait_reason, 'terminal');
    assert.equal(waited.triggered_task_id, 'budget-a');
    assert.equal(waited.tasks.find((entry) => entry.task_id === 'budget-a').progress.wait_reason, 'terminal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing targets are safe and disconnect does not change provider state', async () => {
  const root = await temporaryRoot();
  try {
    await createTask({ root, prompt: 'running', record: { id: 'safe-running', status: 'running' } });
    const missing = await waitForAnyTaskProgress(root, {
      task_ids: ['safe-running', 'does-not-exist'],
      wait_until: 'terminal',
      wait_ms: 10_000,
    });
    const missingTarget = missing.tasks.find((entry) => entry.task_id === 'does-not-exist');
    assert.equal(missing.wait_reason, 'task_not_found');
    assert.deepEqual(missingTarget.error, {
      code: 'task_not_found',
      message: 'The requested task was not found.',
    });
    assert.doesNotMatch(JSON.stringify(missing), /ENOENT|\/tmp\//u);

    const controller = new AbortController();
    const { watch, state } = mockWatch();
    let delayCalls = 0;
    const pending = waitForAnyTaskProgress(root, {
      task_ids: ['safe-running'],
      wait_until: 'terminal',
      wait_ms: 1_000,
      signal: controller.signal,
      watch,
      delay: (milliseconds, signal) => {
        delayCalls += 1;
        return waitDelay(milliseconds, signal);
      },
    });
    setTimeout(() => controller.abort(), 15);
    const disconnected = await pending;
    assert.equal(disconnected.wait_reason, 'disconnected');
    assert.equal(disconnected.tasks[0].task.status, 'running');
    assert.equal(state.closed, state.opened.length);
    assert.equal(delayCalls, 1);
    assert.equal((await readTask(root, 'safe-running')).task.status, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('attention wakes the shared wait before its timeout', async () => {
  const root = await temporaryRoot();
  try {
    await createTask({ root, prompt: 'one', record: { id: 'attention-a', status: 'running' } });
    await createTask({ root, prompt: 'two', record: { id: 'attention-b', status: 'running' } });
    const pending = waitForAnyTaskProgress(root, {
      task_ids: ['attention-a', 'attention-b'],
      wait_until: 'terminal',
      wait_ms: 1_000,
    });
    setTimeout(() => updateTask(root, 'attention-b', {
      status: 'needs_attention',
      attention: { session_id: 'session-1', question_id: 'question-1' },
    }).catch(() => {}), 20);
    const woke = await pending;
    assert.equal(woke.wait_reason, 'attention');
    assert.equal(woke.triggered_task_id, 'attention-b');
    assert.equal(woke.tasks.find((entry) => entry.task_id === 'attention-b').task.status, 'needs_attention');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
