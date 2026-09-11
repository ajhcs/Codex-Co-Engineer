import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createClock,
  createTask,
  extendDeadline,
  runPromptTurn,
} from './turn-runner.mjs';

function hang() {
  return new Promise(() => {});
}

test('deadline extension is audited and refuses a silent roll after expiry', () => {
  const task = createTask({ expectedDurationMs: 1000, now: 0 });
  assert.equal(task.timeoutMs, 1200);
  assert.equal(task.deadlineAt, 1200);

  const extended = extendDeadline(task, {
    expectedDurationMs: 3000,
    reason: 'provider still making progress on tests',
    now: 200,
  });
  assert.equal(extended.deadlineSource, 'extended');
  assert.equal(extended.timeoutMs, 3600);
  assert.equal(extended.deadlineAt, 3800);
  assert.equal(extended.deadlineExtensions.length, 1);
  assert.equal(extended.deadlineExtensions[0].previousDeadlineAt, 1200);

  assert.throws(
    () => extendDeadline(task, { expectedDurationMs: 5000, reason: 'too late', now: 3800 }),
    (error) => error.code === 'deadline_expired',
  );
  assert.throws(
    () => extendDeadline(task, { expectedDurationMs: 5000, now: 300 }),
    (error) => error.code === 'invalid_extend_reason',
  );
  assert.throws(
    () => extendDeadline(task, {
      expectedDurationMs: 1000,
      reason: 'would shrink the recorded deadline',
      now: 300,
    }),
    (error) => error.code === 'deadline_not_extended',
  );
});

test('an in-flight turn is governed by the extended deadline, not the original inner timer', async () => {
  const clock = createClock(0);
  const task = createTask({ expectedDurationMs: 1000, now: 0 });
  const turn = runPromptTurn({
    task,
    clock,
    prompt: async ({ emit }) => {
      emit('partial-progress');
      await hang();
    },
  });
  let settled = null;
  turn.then((value) => {
    settled = value;
  }, (error) => {
    settled = { error };
  });

  extendDeadline(task, {
    expectedDurationMs: 3000,
    reason: 'tests still running',
    now: 200,
  });
  clock.advance(1200);
  await Promise.resolve();
  assert.equal(settled, null);

  clock.advance(2600);
  const result = await turn;
  assert.notEqual(result.stopReason, 'end_turn');
  assert.equal(['timeout', 'cancelled'].includes(result.stopReason), true);
  assert.equal(result.text.includes('partial-progress'), true);
});

test('timeout after partial output is not promoted to a completed end_turn', async () => {
  const clock = createClock(0);
  const task = createTask({ expectedDurationMs: 100, now: 0 });
  const turn = runPromptTurn({
    task,
    clock,
    prompt: async ({ emit }) => {
      emit('chunk-one');
      await hang();
    },
  });
  clock.advance(120);
  const result = await turn;
  assert.notEqual(result.stopReason, 'end_turn');
  assert.equal(['timeout', 'cancelled'].includes(result.stopReason), true);
  assert.equal(result.source === 'session', false);
  assert.equal(result.text, 'chunk-one');
});

test('concurrent turns keep independent cancellation', async () => {
  const clock = createClock(0);
  const taskA = createTask({ expectedDurationMs: 5000, now: 0 });
  const taskB = createTask({ expectedDurationMs: 5000, now: 0 });
  const abortA = new AbortController();
  const abortB = new AbortController();

  const turnA = runPromptTurn({
    task: taskA,
    clock,
    signal: abortA.signal,
    prompt: () => hang(),
  });
  const turnB = runPromptTurn({
    task: taskB,
    clock,
    signal: abortB.signal,
    prompt: () => hang(),
  });

  let aSettled = null;
  let bSettled = null;
  turnA.then((value) => {
    aSettled = value;
  });
  turnB.then((value) => {
    bSettled = value;
  });
  abortA.abort();
  await Promise.resolve();
  if (aSettled == null) clock.advance(7000);
  const resultA = await turnA;
  await Promise.resolve();
  assert.equal(resultA.stopReason, 'cancelled');
  assert.equal(bSettled, null);

  abortB.abort();
  if (bSettled == null) clock.advance(1);
  const resultB = await turnB;
  assert.equal(resultB.stopReason, 'cancelled');
});

test('a pre-aborted signal cancels and late prompt settlement is observed', async () => {
  const clock = createClock(0);
  const task = createTask({ expectedDurationMs: 1000, now: 0 });
  const abort = new AbortController();
  abort.abort();
  let settledLate = false;
  const prompt = () => new Promise((resolve) => {
    queueMicrotask(() => {
      settledLate = true;
      resolve('late-text');
    });
  });
  const result = await runPromptTurn({
    task,
    clock,
    signal: abort.signal,
    prompt,
  });
  assert.equal(result.stopReason, 'cancelled');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settledLate, true);
});
