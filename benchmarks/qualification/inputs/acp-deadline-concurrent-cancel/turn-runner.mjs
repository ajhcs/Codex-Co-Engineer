// Known-bad isolated reproduction of dede188029aff117c60e9a8c4299cc0ab0838be9
// ACP turn behavior: a fixed inner timer can outlive an audited deadline
// extension and settle as completed end_turn, and overlapping turns share one
// module-global cancellation slot.

const DURATION_MARGIN = 1.2;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function createClock(startMs = 0) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map();
  return {
    now() {
      return now;
    },
    setTimeout(fn, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, at: now + delayMs });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      while (timers.size > 0) {
        let chosenId = null;
        let chosen = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (
            chosen == null
            || timer.at < chosen.at
            || (timer.at === chosen.at && id < chosenId)
          ) {
            chosenId = id;
            chosen = timer;
          }
        }
        if (chosen == null) break;
        now = chosen.at;
        timers.delete(chosenId);
        chosen.fn();
      }
      now = target;
    },
  };
}

function delay(clock, ms) {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

export function createTask({ expectedDurationMs, now }) {
  if (!Number.isInteger(expectedDurationMs) || expectedDurationMs < 1) {
    fail('invalid_expected_duration_ms', 'expectedDurationMs must be a positive integer.');
  }
  const timeoutMs = Math.ceil(expectedDurationMs * DURATION_MARGIN);
  return {
    expectedDurationMs,
    timeoutMs,
    deadlineAt: now + timeoutMs,
    deadlineSource: 'margin',
    deadlineExtensions: [],
  };
}

export function extendDeadline(task, { expectedDurationMs, reason, now }) {
  if (!task || typeof task !== 'object') fail('invalid_task_record', 'Task record is invalid.');
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    fail('invalid_extend_reason', 'extend_reason must be non-empty text describing why the deadline is changing.');
  }
  if (now >= task.deadlineAt) {
    fail('deadline_expired', 'The recorded deadline has already passed; a silent roll-forward is not allowed.');
  }
  if (!Number.isInteger(expectedDurationMs) || expectedDurationMs < 1) {
    fail('invalid_expected_duration_ms', 'expectedDurationMs must be a positive integer.');
  }
  const timeoutMs = Math.ceil(expectedDurationMs * DURATION_MARGIN);
  const deadlineAt = now + timeoutMs;
  if (deadlineAt <= task.deadlineAt) {
    fail('deadline_not_extended', 'The new deadline must be strictly later than the recorded deadline.');
  }
  const previous = task.deadlineAt;
  task.expectedDurationMs = expectedDurationMs;
  task.timeoutMs = timeoutMs;
  task.deadlineAt = deadlineAt;
  task.deadlineSource = 'extended';
  task.deadlineExtensions = [
    ...task.deadlineExtensions,
    {
      at: now,
      reason: reason.trim(),
      previousDeadlineAt: previous,
      deadlineAt,
      timeoutMs,
    },
  ];
  return task;
}

let activeTurn = null;

export async function runPromptTurn({ task, signal, prompt, clock }) {
  const innerTimeoutMs = task.timeoutMs;
  let partial = '';
  const emit = (text) => {
    partial += String(text);
  };

  activeTurn = { task, cancelled: false };
  const onAbort = () => {
    if (activeTurn) activeTurn.cancelled = true;
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  const promptPromise = Promise.resolve().then(() => prompt({ emit, signal }));

  try {
    const result = await Promise.race([
      promptPromise,
      delay(clock, innerTimeoutMs).then(() => {
        const error = new Error('timeout');
        error.code = 'timeout';
        throw error;
      }),
    ]);
    if (activeTurn?.cancelled) {
      return { stopReason: 'cancelled', source: 'signal', text: partial };
    }
    return {
      stopReason: 'end_turn',
      source: 'rpc',
      text: result == null ? partial : String(result),
    };
  } catch (error) {
    if (error && error.code === 'timeout') {
      return { stopReason: 'end_turn', source: 'session', text: partial };
    }
    if (activeTurn?.cancelled || signal?.aborted) {
      return { stopReason: 'cancelled', source: 'signal', text: partial };
    }
    throw error;
  } finally {
    activeTurn = null;
  }
}
