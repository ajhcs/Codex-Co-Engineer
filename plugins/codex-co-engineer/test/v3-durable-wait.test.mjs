import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extendTaskDeadline, inspectTask, taskStatus } from '../mcp/v3/supervisor.mjs';
import {
  appendTaskEvent,
  createTask,
  readTask,
  updateTask,
  waitDelay,
  waitForTaskProgress,
  writeRuntimeRecord,
} from '../mcp/v3/task-store.mjs';
import { readFileSync } from 'node:fs';

function currentRuntime() {
  const proc = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return {
    pid: process.pid,
    process_group: process.pid,
    process_start_ticks: proc.slice(proc.lastIndexOf(')') + 2).trim().split(/\s+/u)[19],
  };
}

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

test('terminal wait ignores text deltas and wakes on success, failure, timeout, and cancellation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-'));
  try {
    await createTask({
      root,
      prompt: 'secret waiter prompt',
      record: {
        id: 'term-one',
        status: 'running',
        provider: 'grok',
        expected_duration_ms: 10_000,
        timeout_ms: 12_000,
        deadline_at: new Date(Date.now() + 12_000).toISOString(),
      },
    });
    const baseline = await waitForTaskProgress(root, 'term-one', { wait_ms: 0, wait_until: 'terminal' });
    const pending = waitForTaskProgress(root, 'term-one', {
      cursor: baseline.progress.event_cursor,
      wait_until: 'terminal',
      wait_ms: 1_000,
    });
    await appendTaskEvent(root, 'term-one', {
      type: 'provider',
      event: { type: 'text_delta', text: 'routine-progress' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await updateTask(root, 'term-one', { status: 'completed', finished_at: new Date().toISOString() });
    const woke = await pending;
    assert.equal(woke.progress.wait_reason, 'terminal');
    assert.equal(woke.task.status, 'completed');
    assert.ok(woke.progress.waited_ms < 1_000);

    await createTask({
      root,
      prompt: 'fail',
      record: { id: 'term-fail', status: 'running', provider: 'grok' },
    });
    const failWait = waitForTaskProgress(root, 'term-fail', { wait_until: 'terminal', wait_ms: 500 });
    setTimeout(() => updateTask(root, 'term-fail', {
      status: 'failed',
      error: { code: 'provider_failed', message: 'provider exited unexpectedly' },
      finished_at: new Date().toISOString(),
    }).catch(() => {}), 15);
    assert.equal((await failWait).progress.wait_reason, 'terminal');

    await createTask({
      root,
      prompt: 'cancel',
      record: { id: 'term-cancel', status: 'running', provider: 'grok' },
    });
    const cancelWait = waitForTaskProgress(root, 'term-cancel', { wait_until: 'terminal', wait_ms: 500 });
    setTimeout(() => updateTask(root, 'term-cancel', {
      status: 'cancelled',
      finished_at: new Date().toISOString(),
    }).catch(() => {}), 15);
    assert.equal((await cancelWait).task.status, 'cancelled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cursorless terminal wait ignores historical progress and still waits for terminal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-cursorless-term-'));
  try {
    await createTask({
      root,
      prompt: 'historical then terminal',
      record: { id: 'term-cursorless', status: 'running', provider: 'grok' },
    });
    await appendTaskEvent(root, 'term-cursorless', {
      type: 'provider',
      event: { type: 'tool_call', title: 'read', text: 'historical' },
    });
    let settled = false;
    const pending = waitForTaskProgress(root, 'term-cursorless', {
      wait_until: 'terminal',
      wait_ms: 1_000,
    }).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
    await appendTaskEvent(root, 'term-cursorless', {
      type: 'provider',
      event: { type: 'text_delta', text: 'still-running' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    await updateTask(root, 'term-cursorless', {
      status: 'completed',
      finished_at: new Date().toISOString(),
    });
    const woke = await pending;
    assert.equal(woke.progress.wait_reason, 'terminal');
    assert.equal(woke.task.status, 'completed');
    assert.ok(woke.progress.waited_ms >= 40);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('needs_attention, silence, deadline, and disconnect wake without owning the worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-wake-'));
  try {
    await createTask({
      root,
      prompt: 'attention',
      record: { id: 'attn-one', status: 'running', provider: 'grok', acp_session_id: 'sess-1' },
    });
    const attentionWait = waitForTaskProgress(root, 'attn-one', { wait_until: 'terminal', wait_ms: 500 });
    setTimeout(() => updateTask(root, 'attn-one', {
      status: 'needs_attention',
      attention: { session_id: 'sess-1', question_id: 'q-1' },
    }).catch(() => {}), 15);
    const attention = await attentionWait;
    assert.equal(attention.progress.wait_reason, 'attention');
    assert.equal(attention.task.status, 'needs_attention');

    const now = Date.now();
    await createTask({
      root,
      prompt: 'deadline',
      record: {
        id: 'dead-one',
        status: 'running',
        provider: 'grok',
        deadline_at: new Date(now + 40).toISOString(),
        silence_timeout_ms: 5_000,
      },
    });
    const deadline = await waitForTaskProgress(root, 'dead-one', { wait_until: 'terminal', wait_ms: 200 });
    assert.equal(deadline.progress.wait_reason, 'deadline');
    assert.ok(deadline.progress.waited_ms < 160);
    assert.equal((await readTask(root, 'dead-one')).task.status, 'running');

    await createTask({
      root,
      prompt: 'omitted deadline',
      record: {
        id: 'dead-omit',
        status: 'running',
        provider: 'grok',
        deadline_at: new Date(Date.now() + 40).toISOString(),
      },
    });
    const omittedDeadline = await waitForTaskProgress(root, 'dead-omit', { wait_until: 'terminal' });
    assert.equal(omittedDeadline.progress.wait_reason, 'deadline');
    assert.ok(omittedDeadline.progress.waited_ms < 160);

    await createTask({
      root,
      prompt: 'silence',
      record: {
        id: 'silent-one',
        status: 'running',
        provider: 'grok',
        silence_timeout_ms: 5_000,
      },
    });
    const silent = await waitForTaskProgress(root, 'silent-one', {
      wait_until: 'terminal',
      wait_ms: 20,
      now: () => Date.now() + 6_000,
    });
    assert.equal(silent.progress.wait_reason, 'silence');

    const { watch, state } = createMockWatch();
    const controller = new AbortController();
    await createTask({
      root,
      prompt: 'disconnect',
      record: { id: 'disc-one', status: 'running', provider: 'grok' },
    });
    const pending = waitForTaskProgress(root, 'disc-one', {
      wait_until: 'terminal',
      wait_ms: 2_000,
      watch,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    controller.abort();
    const disconnected = await pending;
    assert.equal(disconnected.progress.wait_reason, 'disconnected');
    assert.equal((await readTask(root, 'disc-one')).task.status, 'running');
    assert.equal(state.closed, state.opened);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restart recovery preserves cursor and wakes when attention is required', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-restart-'));
  try {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    await createTask({
      root,
      prompt: 'recover me',
      record: {
        id: 'restart-one',
        status: 'needs_attention',
        provider: 'grok',
        acp_session_id: 'sess-9',
        attention: { session_id: 'sess-9', question_id: 'q-9' },
        expected_duration_ms: 10_000,
        timeout_ms: 12_000,
        deadline_at: deadline,
      },
    });
    await appendTaskEvent(root, 'restart-one', { type: 'needs_attention', question_id: 'q-9', session_id: 'sess-9' });
    await writeRuntimeRecord(root, 'restart-one', currentRuntime());
    const first = await taskStatus(root, 'restart-one', { wait_until: 'terminal', wait_ms: 0 });
    assert.equal(first.state, 'needs_attention');
    assert.equal(first.progress.wait_reason, 'attention');
    const again = await taskStatus(root, 'restart-one', {
      cursor: first.progress.event_cursor,
      wait_until: 'terminal',
      wait_ms: 0,
    });
    assert.equal(again.progress.event_cursor, first.progress.event_cursor);
    assert.equal(again.task.deadline_at, deadline);
    assert.equal(again.summary.evidence.files.includes('events.jsonl'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent terminal waiters observe one completion without duplicate ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-conc-'));
  try {
    await createTask({
      root,
      prompt: 'shared',
      record: { id: 'conc-one', status: 'running', provider: 'grok' },
    });
    const baseline = await waitForTaskProgress(root, 'conc-one', { wait_ms: 0 });
    const waiters = Promise.all(Array.from({ length: 3 }, () => waitForTaskProgress(root, 'conc-one', {
      cursor: baseline.progress.event_cursor,
      wait_until: 'terminal',
      wait_ms: 1_000,
    })));
    setTimeout(() => updateTask(root, 'conc-one', {
      status: 'completed',
      finished_at: new Date().toISOString(),
    }).catch(() => {}), 20);
    const values = await waiters;
    for (const value of values) {
      assert.equal(value.progress.wait_reason, 'terminal');
      assert.equal(value.task.status, 'completed');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('watcher failure uses a low-frequency fallback instead of model-driven polling', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-fallback-'));
  try {
    await createTask({
      root,
      prompt: 'fallback',
      record: { id: 'fallback-one', status: 'running', provider: 'grok' },
    });
    const delays = [];
    const { watch, state } = createMockWatch();
    const pending = waitForTaskProgress(root, 'fallback-one', {
      wait_until: 'terminal',
      wait_ms: 80,
      watch,
      delay: (milliseconds, signal) => {
        delays.push(milliseconds);
        return waitDelay(milliseconds, signal);
      },
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
    assert.equal(delays.filter((value) => value > 0 && value <= 20).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('in-flight omitted terminal wait crosses an extended deadline; explicit wait_ms stays capped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-extend-wait-'));
  try {
    const originalMs = 250;
    const startedAt = Date.now();
    await createTask({
      root,
      prompt: 'extend while an omitted terminal wait is pending',
      record: {
        id: 'term-extend',
        status: 'running',
        provider: 'grok',
        expected_duration_ms: 1_000,
        timeout_ms: originalMs,
        deadline_at: new Date(startedAt + originalMs).toISOString(),
        duration_margin: 1.2,
        deadline_source: 'explicit',
        deadline_extensions: [],
      },
    });
    const pending = waitForTaskProgress(root, 'term-extend', { wait_until: 'terminal' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await extendTaskDeadline(root, 'term-extend', {
      expected_duration_ms: 5_000,
      reason: 'provider is still running the test suite',
    });
    const remainingOriginal = Math.max(0, originalMs - (Date.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, remainingOriginal + 40));
    assert.equal((await readTask(root, 'term-extend')).task.status, 'running');
    await updateTask(root, 'term-extend', {
      status: 'completed',
      finished_at: new Date().toISOString(),
    });
    const woke = await pending;
    assert.equal(woke.progress.wait_reason, 'terminal');
    assert.equal(woke.task.status, 'completed');
    assert.equal(woke.task.deadline_source, 'extended');
    assert.ok(Date.now() - startedAt > originalMs);
    assert.ok(woke.progress.waited_ms > originalMs - 20);

    const capMs = 70;
    await createTask({
      root,
      prompt: 'explicit wait_ms must not grow with an extension',
      record: {
        id: 'term-cap',
        status: 'running',
        provider: 'grok',
        expected_duration_ms: 1_000,
        timeout_ms: 5_000,
        deadline_at: new Date(Date.now() + 5_000).toISOString(),
        duration_margin: 1.2,
        deadline_source: 'explicit',
        deadline_extensions: [],
      },
    });
    const capStarted = Date.now();
    const capped = waitForTaskProgress(root, 'term-cap', {
      wait_until: 'terminal',
      wait_ms: capMs,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await extendTaskDeadline(root, 'term-cap', {
      expected_duration_ms: 8_000,
      reason: 'extension must not enlarge an explicit wait_ms cap',
    });
    const timedOut = await capped;
    assert.equal(timedOut.progress.wait_reason, 'timeout');
    assert.equal(timedOut.task.status, 'running');
    assert.ok(timedOut.progress.waited_ms >= capMs - 5);
    assert.ok(timedOut.progress.waited_ms < 400);
    assert.ok(Date.now() - capStarted < 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspectTask diagnostics view does not wait and keeps payloads bounded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-durable-inspect-'));
  try {
    await createTask({
      root,
      prompt: 'inspect secret sk-inspect-secret-1234567890',
      record: { id: 'inspect-one', status: 'running', provider: 'grok', agent_argv: ['grok', 'agent'] },
    });
    await appendTaskEvent(root, 'inspect-one', {
      type: 'provider',
      event: { type: 'tool_call', title: 'read', text: 'visible', pid: 9, argv: ['secret-argv'] },
    });
    const started = Date.now();
    const value = await inspectTask(root, {
      task_id: 'inspect-one',
      view: 'diagnostics',
      wait_until: 'terminal',
      wait_ms: 5_000,
      max_bytes: 1024,
    });
    assert.ok(Date.now() - started < 200);
    assert.equal(value.view, 'diagnostics');
    assert.equal(value.diagnostics.view, 'diagnostics');
    assert.doesNotMatch(JSON.stringify(value), /sk-inspect-secret|secret-argv|inspect secret/u);
    assert.ok(JSON.stringify(value.diagnostics.events).length <= 64 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
