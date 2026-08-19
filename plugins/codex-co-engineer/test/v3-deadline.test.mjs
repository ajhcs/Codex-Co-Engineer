import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DURATION_MARGIN } from '../mcp/v3/contract.mjs';
import {
  computeMarginTimeoutMs,
  nextDeadlineExtension,
  remainingDeadlineMs,
  resolveTaskDeadline,
} from '../mcp/v3/deadline.mjs';
import { extendTaskDeadline, submitTask } from '../mcp/v3/supervisor.mjs';
import { createTask, readTask } from '../mcp/v3/task-store.mjs';

const SHA = 'a'.repeat(40);
const readyBoundary = async () => ({
  ready: true,
  status: 'prerequisites_ready',
  provider_started: false,
  boundary: 'systemd-user-service-cgroup',
});

test('recorded deadline is ceil(expected_duration_ms * 1.20) and never a silent roll', () => {
  assert.equal(DURATION_MARGIN, 1.20);
  assert.equal(computeMarginTimeoutMs(10 * 60_000), 720_000);
  assert.equal(computeMarginTimeoutMs(1_000), 1_200);
  const now = Date.parse('2026-08-19T00:00:00.000Z');
  const resolved = resolveTaskDeadline({ expected_duration_ms: 600_000 }, { now });
  assert.equal(resolved.expected_duration_ms, 600_000);
  assert.equal(resolved.timeout_ms, 720_000);
  assert.equal(resolved.deadline_source, 'margin');
  assert.equal(resolved.deadline_at, new Date(now + 720_000).toISOString());

  const explicit = resolveTaskDeadline({ expected_duration_ms: 600_000, timeout_ms: 900_000 }, { now });
  assert.equal(explicit.deadline_source, 'explicit');
  assert.equal(explicit.timeout_ms, 900_000);
  assert.throws(
    () => resolveTaskDeadline({ expected_duration_ms: 600_000, timeout_ms: 500_000 }),
    (error) => error.code === 'invalid_timeout_ms',
  );
});

test('short, medium, and multi-hour fixtures use estimate plus 20%', () => {
  const cases = [
    ['short', 30_000, 36_000],
    ['medium', 30 * 60_000, 36 * 60_000],
    ['multi-hour', 4 * 60 * 60_000, 4.8 * 60 * 60_000],
  ];
  for (const [, expected, timeout] of cases) {
    assert.equal(computeMarginTimeoutMs(expected), timeout);
  }
});

test('deadline extension is audited and refuses a silent roll after expiry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-deadline-'));
  const now = Date.parse('2026-08-19T12:00:00.000Z');
  try {
    const deadline = resolveTaskDeadline({ expected_duration_ms: 10_000 }, { now });
    await createTask({
      root,
      prompt: 'extend me',
      record: { id: 'extend-one', status: 'running', provider: 'grok', ...deadline, deadline_extensions: [] },
    });
    const extended = nextDeadlineExtension((await readTask(root, 'extend-one')).task, {
      expected_duration_ms: 20_000,
      reason: 'provider still making progress on tests',
      now: now + 5_000,
    });
    assert.equal(extended.deadline_source, 'extended');
    assert.equal(extended.timeout_ms, 24_000);
    assert.equal(extended.deadline_extensions.length, 1);
    assert.equal(extended.deadline_extensions[0].reason, 'provider still making progress on tests');
    assert.equal(extended.deadline_extensions[0].previous_deadline_at, deadline.deadline_at);

    const stored = (await readTask(root, 'extend-one')).task;
    assert.throws(
      () => nextDeadlineExtension(stored, {
        expected_duration_ms: 20_000,
        reason: 'too late',
        now: Date.parse(deadline.deadline_at) + 1,
      }),
      (error) => error.code === 'deadline_expired',
    );
    assert.throws(
      () => nextDeadlineExtension(stored, {
        expected_duration_ms: 20_000,
        now: now + 1,
      }),
      (error) => error.code === 'invalid_extend_reason',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delegate persists estimate, margin, and deadline on the receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-deadline-submit-'));
  const repo = path.join(root, 'repo');
  try {
    await mkdir(repo);
    const value = await submitTask({
      task_id: 'estimate-one',
      provider: 'grok',
      repo,
      prompt: 'review quickly',
      workspace_mode: 'direct',
      expected_duration_ms: 50_000,
    }, {
      root,
      env: {},
      probeBoundary: readyBoundary,
      execute: async (_command, args) => {
        if (args.includes('--show-toplevel')) return { stdout: `${repo}\n` };
        if (args.includes('--show-current')) return { stdout: 'main\n' };
        if (args.includes('HEAD')) return { stdout: `${SHA}\n` };
        return { stdout: '' };
      },
      launch: async () => ({ pid: 42, process_group: 42, process_start_ticks: '1' }),
    });
    assert.equal(value.task.expected_duration_ms, 50_000);
    assert.equal(value.task.duration_margin, 1.2);
    assert.equal(value.task.timeout_ms, 60_000);
    assert.equal(value.task.deadline_source, 'margin');
    assert.ok(Date.parse(value.task.deadline_at) > Date.now());
    assert.equal(remainingDeadlineMs(value.task) > 0, true);

    const next = await extendTaskDeadline(root, 'estimate-one', {
      expected_duration_ms: 80_000,
      reason: 'test suite is still running',
    });
    assert.equal(next.deadline_source, 'extended');
    assert.equal(next.timeout_ms, 96_000);
    assert.equal(next.deadline_extensions[0].reason, 'test suite is still running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
