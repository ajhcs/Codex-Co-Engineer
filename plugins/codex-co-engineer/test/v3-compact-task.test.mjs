import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COMPACT_STRUCTURED_BYTES_MAX,
  COMPACT_VIEW,
  compactStructuredBytes,
  projectCompactTask,
  resolveTaskView,
  tailText,
  utf8Head,
} from '../mcp/v3/compact-task.mjs';
import { inspectTask, taskStatus } from '../mcp/v3/supervisor.mjs';
import { appendTaskEvent, createLaunchReservation, createTask } from '../mcp/v3/task-store.mjs';
import {
  TASK_COUNTS,
  WAIT_DURATION_MS,
  measureResponse,
  publicPayloads,
} from './fixtures/v3-efficiency-fixtures.mjs';
import { readFileSync } from 'node:fs';

const SHAPES = JSON.parse(readFileSync(new URL('./fixtures/v3-public-response-shapes.json', import.meta.url), 'utf8'));
const FORBIDDEN_COMPACT_KEYS = Object.freeze([
  'prompt',
  'prompt_sha256',
  'agent_argv',
  'cli_argv',
  'cwd',
  'source_repo',
  'worktree_path',
  'provider_process_group',
  'provider_process_start_ticks',
  'pid',
  'ppid',
  'argv',
  'command',
  'runtime',
  'task',
  'last_event',
  'diagnostics',
]);

function keys(value) {
  return Object.keys(value);
}

function collectKeys(value, found = new Set()) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, found);
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    found.add(key);
    collectKeys(entry, found);
  }
  return found;
}

function fixtureProgress(task, { wait_reason } = {}) {
  return {
    event_cursor: '512',
    last_event: task.last_event,
    new_event_count: 0,
    more_events: false,
    waited_ms: WAIT_DURATION_MS,
    wait_reason: wait_reason ?? (task.status === 'running' ? 'timeout' : 'terminal'),
    wait_until: 'progress',
  };
}

function representativeFixtureTasks() {
  const tasks = publicPayloads(54).tasks.tasks;
  return {
    running: tasks.find((task) => task.status === 'running'),
    completed: tasks.find((task) => task.status === 'completed'),
    failed: tasks.find((task) => task.status === 'failed'),
  };
}

function assertCompactCoordinationShape(compact, task) {
  assert.equal(compact.view, COMPACT_VIEW);
  assert.equal(compact.task_id, task.id);
  assert.equal(compact.provider, task.provider);
  assert.equal(compact.status, task.status);
  assert.equal(compact.state, task.state);
  assert.equal(compact.prompt_dispatched, task.prompt_dispatched === true);
  assert.deepEqual(keys(compact.progress), [
    'event_cursor',
    'wait_reason',
    'waited_ms',
    'new_event_count',
    'more_events',
  ]);
  assert.equal(Object.hasOwn(compact, 'task'), false);
  assert.equal(Object.hasOwn(compact, 'runtime'), false);
  assert.equal(Object.hasOwn(compact, 'last_event'), false);
  assert.equal(Object.hasOwn(compact.progress, 'last_event'), false);
  assert.equal(Object.hasOwn(compact.summary, 'last_event'), false);
  assert.equal(Object.hasOwn(compact.diagnostic, 'last_event'), false);
  assert.deepEqual(keys(compact.summary), [
    'message',
    'error_code',
    'failed_stage',
    'retryable',
    'suggested_action',
    'last_successful_stage',
  ]);
  assert.deepEqual(keys(compact.diagnostic), [
    'session_id',
    'question_id',
    'started_at',
    'last_activity_at',
    'alert_at',
    'finished_at',
    'cancellation',
    'dispatch_uncertain',
  ]);
  for (const key of ['message', 'error_code', 'failed_stage', 'retryable', 'suggested_action', 'last_successful_stage']) {
    assert.equal(Object.hasOwn(compact.diagnostic, key), false, `compact diagnostic duplicated ${key}`);
  }
  const found = collectKeys(compact);
  for (const key of FORBIDDEN_COMPACT_KEYS) {
    assert.equal(found.has(key), false, `compact payload leaked ${key}`);
  }
}

test('resolveTaskView keeps summary as the default and treats compact as additive', () => {
  assert.equal(resolveTaskView(undefined), 'summary');
  assert.equal(resolveTaskView('summary'), 'summary');
  assert.equal(resolveTaskView('diagnostics'), 'diagnostics');
  assert.equal(resolveTaskView('compact'), 'compact');
  assert.equal(resolveTaskView('other'), 'summary');
});

test('tailText keeps the end of oversized output', () => {
  const text = `HEAD-UNIQUE-${'x'.repeat(4000)}TAIL-UNIQUE-end`;
  const preview = tailText(text, 64);
  assert.match(preview, /^…/u);
  assert.match(preview, /TAIL-UNIQUE-end$/u);
  assert.equal(preview.includes('HEAD-UNIQUE'), false);
  assert.ok(Buffer.byteLength(preview, 'utf8') <= 64);
});

test('utf8Head and tailText honor every nonnegative maxBytes including 0, 1, and 2', () => {
  const ascii = 'abcdef';
  const ellipsisBytes = Buffer.byteLength('…', 'utf8');
  assert.equal(ellipsisBytes, 3);

  assert.equal(utf8Head(ascii, 0), '');
  assert.equal(tailText(ascii, 0), '');
  assert.equal(Buffer.byteLength(utf8Head(ascii, 0), 'utf8'), 0);
  assert.equal(Buffer.byteLength(tailText(ascii, 0), 'utf8'), 0);

  assert.equal(utf8Head(ascii, 1), 'a');
  assert.equal(tailText(ascii, 1), 'f');
  assert.equal(Buffer.byteLength(utf8Head(ascii, 1), 'utf8'), 1);
  assert.equal(Buffer.byteLength(tailText(ascii, 1), 'utf8'), 1);

  assert.equal(utf8Head(ascii, 2), 'ab');
  assert.equal(tailText(ascii, 2), 'ef');
  assert.equal(Buffer.byteLength(utf8Head(ascii, 2), 'utf8'), 2);
  assert.equal(Buffer.byteLength(tailText(ascii, 2), 'utf8'), 2);

  assert.equal(utf8Head(ascii, 3), '…');
  assert.equal(tailText(ascii, 3), '…');
  assert.equal(Buffer.byteLength(utf8Head(ascii, 3), 'utf8'), 3);
  assert.equal(Buffer.byteLength(tailText(ascii, 3), 'utf8'), 3);

  const emoji = '😀😀';
  for (const maxBytes of [0, 1, 2]) {
    const head = utf8Head(emoji, maxBytes);
    const tail = tailText(emoji, maxBytes);
    assert.ok(Buffer.byteLength(head, 'utf8') <= maxBytes, `utf8Head emoji exceeded ${maxBytes}`);
    assert.ok(Buffer.byteLength(tail, 'utf8') <= maxBytes, `tailText emoji exceeded ${maxBytes}`);
    assert.notEqual(head, '…');
    assert.notEqual(tail, '…');
  }
});

test('compact projection covers running, completed, and failed fixture tasks under 8192 bytes', () => {
  const representatives = representativeFixtureTasks();
  assert.ok(representatives.running);
  assert.ok(representatives.completed);
  assert.ok(representatives.failed);
  const measurements = [];
  for (const [label, task] of Object.entries(representatives)) {
    const compact = projectCompactTask({
      task: { ...task, role: 'implement', workspace_kind: 'managed-worktree' },
      progress: fixtureProgress(task),
    });
    assertCompactCoordinationShape(compact, task);
    assert.equal(compact.role, 'implement');
    assert.equal(compact.workspace_kind, 'managed-worktree');
    assert.equal(compact.branch, task.branch);
    assert.equal(compact.start_sha, task.start_sha);
    assert.ok(compact.deadline);
    assert.equal(typeof compact.summary.message, 'string');
    assert.equal(Object.hasOwn(compact.diagnostic, 'message'), false);
    if (label === 'running') {
      assert.equal(Object.hasOwn(compact, 'result'), false);
      assert.equal(Object.hasOwn(compact, 'handoff'), false);
      assert.equal(compact.finished_at, null);
    } else {
      assert.ok(compact.result);
      assert.ok(compact.handoff);
      assert.equal(compact.finished_at, task.finished_at);
      assert.equal(typeof compact.result.output, 'string');
      assert.equal(compact.result.output.endsWith('096'), true);
      assert.equal(compact.handoff.branch, task.handoff.branch);
      assert.equal(compact.handoff.head, task.handoff.head);
    }
    if (label === 'failed') {
      assert.equal(compact.state, 'failed');
      assert.equal(compact.summary.error_code, 'provider_failure');
    }
    const { response, metrics } = measureResponse(compact);
    assert.equal(response.result.structuredContent.view, COMPACT_VIEW);
    assert.ok(metrics.structured_content_bytes <= COMPACT_STRUCTURED_BYTES_MAX, `${label} compact structured JSON was ${metrics.structured_content_bytes}`);
    measurements.push({
      label,
      text_content_bytes: metrics.text_content_bytes,
      structured_content_bytes: metrics.structured_content_bytes,
      jsonrpc_bytes: metrics.jsonrpc_bytes,
    });
  }
  process.stdout.write(`${JSON.stringify({ compact_fixture_measurements: measurements })}\n`);
});

test('compact structured JSON stays at or under 8192 bytes across PR1 fixture counts', () => {
  const measurements = [];
  for (const taskCount of TASK_COUNTS) {
    const payloads = publicPayloads(taskCount);
    assert.deepEqual(keys(payloads.task), SHAPES.responses.task);
    assert.equal(payloads.task.view, 'summary');
    for (const task of payloads.tasks.tasks) {
      const compact = projectCompactTask({
        task,
        progress: fixtureProgress(task),
      });
      assertCompactCoordinationShape(compact, task);
      const serialized = JSON.stringify(compact);
      assert.doesNotMatch(serialized, /\/home\/|\/mnt\//u);
      assert.doesNotMatch(serialized, /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/iu);
      assert.doesNotMatch(serialized, /"prompt"\s*:/iu);
      const { metrics } = measureResponse(compact);
      assert.ok(
        metrics.structured_content_bytes <= COMPACT_STRUCTURED_BYTES_MAX,
        `${task.id} compact structured JSON was ${metrics.structured_content_bytes}`,
      );
      assert.equal(compactStructuredBytes(compact) <= COMPACT_STRUCTURED_BYTES_MAX, true);
    }
    const compactTask = projectCompactTask({
      task: payloads.task.task,
      progress: payloads.task.progress,
      extras: { wait_reason: payloads.task.progress.wait_reason, event_cursor: payloads.task.progress.event_cursor },
    });
    const measured = measureResponse(compactTask);
    measurements.push({
      task_count: taskCount,
      structured_content_bytes: measured.metrics.structured_content_bytes,
      jsonrpc_bytes: measured.metrics.jsonrpc_bytes,
    });
  }
  process.stdout.write(`${JSON.stringify({ compact_count_measurements: measurements })}\n`);
});

test('compact terminal preview is tail-preserving and omits duplicate last_event text', () => {
  const head = `HEAD-UNIQUE-MARKER-${'x'.repeat(4000)}`;
  const tail = 'TAIL-UNIQUE-MARKER-end';
  const compact = projectCompactTask({
    task: {
      id: 'compact-tail',
      status: 'completed',
      provider: 'grok',
      role: 'review',
      prompt_dispatched: true,
      created_at: '2026-08-20T00:00:00.000Z',
      updated_at: '2026-08-20T00:00:00.000Z',
      finished_at: '2026-08-20T00:01:00.000Z',
      last_event: { type: 'terminal', text: `${head}\n${tail}` },
      result: {
        summary: 'Synthetic completion.',
        output: `${head}\n${tail}`,
      },
      handoff: {
        branch: 'codex/compact-tail',
        head: 'a'.repeat(40),
        validation: { status: 'passed', checks: ['unit', 'contract'] },
      },
    },
    progress: {
      event_cursor: '99',
      last_event: { type: 'terminal', text: `${head}\n${tail}` },
      new_event_count: 2,
      more_events: false,
      waited_ms: 40,
      wait_reason: 'terminal',
    },
  });
  assert.equal(compact.role, 'review');
  assert.equal(compact.result.output.includes(tail), true);
  assert.equal(compact.result.output.includes('HEAD-UNIQUE-MARKER'), false);
  assert.equal(JSON.stringify(compact).includes('HEAD-UNIQUE-MARKER'), false);
  assert.equal(Object.hasOwn(compact, 'last_event'), false);
  assert.ok(compactStructuredBytes(compact) <= COMPACT_STRUCTURED_BYTES_MAX);
});

test('compact projection redacts secrets and never returns the raw prompt', () => {
  const compact = projectCompactTask({
    task: {
      id: 'compact-secret',
      status: 'failed',
      provider: 'cursor-local',
      role: 'implement',
      prompt: 'do not leak this prompt sk-prompt-secret-1234567890',
      prompt_sha256: 'abc',
      prompt_dispatched: true,
      agent_argv: ['grok', 'agent'],
      cwd: '/mnt/test-user/worktree',
      source_repo: '/home/test-user/repo',
      provider_process_group: 42,
      result: {
        summary: 'failed with sk-result-secret-1234567890',
        output: `boom sk-output-secret-1234567890\n${'z'.repeat(2000)}TAIL-OK`,
      },
      error: { code: 'provider_failure', message: 'provider failed with sk-error-secret-1234567890' },
      handoff: {
        branch: 'codex/compact-secret',
        head: 'b'.repeat(40),
        validation: { status: 'failed', checks: ['secret sk-check-secret-1234567890'] },
      },
    },
    progress: fixtureProgress({ status: 'failed', last_event: { text: 'sk-event-secret-1234567890' } }),
  });
  const serialized = JSON.stringify(compact);
  assert.doesNotMatch(serialized, /sk-(?:prompt|result|output|error|check|event)-secret-1234567890/u);
  assert.doesNotMatch(serialized, /do not leak this prompt/u);
  assert.doesNotMatch(serialized, /\/mnt\/test-user\/worktree|\/home\/test-user\/repo/u);
  assert.equal(Object.hasOwn(compact, 'prompt'), false);
  assert.equal(compact.prompt_dispatched, true);
  assert.match(compact.result.output, /TAIL-OK$/u);
  assert.equal(compact.result.summary.includes('[REDACTED]'), true);
});

test('inspectTask compact view waits unlike diagnostics and keeps default summary unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-compact-inspect-'));
  try {
    await createTask({
      root,
      prompt: 'inspect secret sk-inspect-secret-1234567890',
      record: {
        id: 'compact-inspect',
        status: 'running',
        provider: 'grok',
        role: 'implement',
        prompt_dispatched: true,
        branch: 'codex/compact-inspect',
        start_sha: 'c'.repeat(40),
        workspace_kind: 'managed-worktree',
        agent_argv: ['grok', 'agent'],
        launch_reservation: createLaunchReservation(),
      },
    });
    await appendTaskEvent(root, 'compact-inspect', {
      type: 'provider',
      event: { type: 'text_delta', text: 'visible', pid: 9, argv: ['secret-argv'] },
    });
    const summary = await taskStatus(root, 'compact-inspect');
    assert.equal(summary.view, 'summary');
    assert.equal(summary.task.last_event.text, 'visible');
    assert.equal(typeof summary.runtime === 'object' || summary.runtime == null, true);

    const diagnostics = await inspectTask(root, {
      task_id: 'compact-inspect',
      view: 'diagnostics',
      wait_until: 'terminal',
      wait_ms: 5_000,
    });
    assert.equal(diagnostics.view, 'diagnostics');
    assert.ok(diagnostics.diagnostics);

    const started = Date.now();
    const compact = await inspectTask(root, {
      task_id: 'compact-inspect',
      view: 'compact',
      wait_ms: 40,
      wait_until: 'terminal',
    });
    assert.ok(Date.now() - started >= 25);
    assert.equal(compact.view, 'compact');
    assert.equal(compact.task_id, 'compact-inspect');
    assert.equal(compact.role, 'implement');
    assert.equal(compact.workspace_kind, 'managed-worktree');
    assert.equal(compact.progress.wait_reason, 'timeout');
    assert.equal(Object.hasOwn(compact, 'task'), false);
    assert.equal(Object.hasOwn(compact, 'runtime'), false);
    assert.doesNotMatch(JSON.stringify(compact), /sk-inspect-secret|secret-argv|inspect secret/u);
    assert.ok(compactStructuredBytes(compact) <= COMPACT_STRUCTURED_BYTES_MAX);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspectTask compact view projects terminal and failed receipts without full bodies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-compact-terminal-'));
  try {
    await createTask({
      root,
      prompt: 'completed secret sk-complete-secret-1234567890',
      record: {
        id: 'compact-complete',
        status: 'completed',
        provider: 'dsh',
        role: 'review',
        prompt_dispatched: true,
        finished_at: '2026-08-20T00:01:00.000Z',
        stop_reason: 'completed',
        result: {
          summary: 'done',
          output: `HEAD-UNIQUE-MARKER-${'x'.repeat(4000)}\nTAIL-COMPLETE`,
        },
        handoff: { branch: 'codex/compact-complete', head: 'd'.repeat(40), validation: { status: 'passed', checks: ['unit'] } },
      },
    });
    await createTask({
      root,
      prompt: 'failed secret sk-fail-secret-1234567890',
      record: {
        id: 'compact-fail',
        status: 'failed',
        provider: 'cursor-cloud',
        role: 'implement',
        prompt_dispatched: true,
        finished_at: '2026-08-20T00:02:00.000Z',
        stop_reason: 'provider_failure',
        error: { code: 'provider_failure', message: 'failed with sk-fail-secret-1234567890' },
        result: { summary: 'provider stopped', output: 'partial TAIL-FAIL' },
        handoff: { branch: 'codex/compact-fail', head: 'e'.repeat(40), validation: { status: 'failed', checks: ['contract'] } },
      },
    });
    const completed = await inspectTask(root, { task_id: 'compact-complete', view: 'compact' });
    const failed = await inspectTask(root, { task_id: 'compact-fail', view: 'compact' });
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.result.output.includes('TAIL-COMPLETE'), true);
    assert.equal(completed.result.output.includes('HEAD-UNIQUE-MARKER'), false);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.summary.error_code, 'provider_failure');
    assert.doesNotMatch(JSON.stringify(completed), /sk-complete-secret/u);
    assert.doesNotMatch(JSON.stringify(failed), /sk-fail-secret/u);
    assert.ok(compactStructuredBytes(completed) <= COMPACT_STRUCTURED_BYTES_MAX);
    assert.ok(compactStructuredBytes(failed) <= COMPACT_STRUCTURED_BYTES_MAX);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function secretStraddlingPayload({ secret, verdict, contentBytes, cutIntoSecret, prefixBody, fillerChar }) {
  const prefix = `${prefixBody} `;
  const afterSecret = ' ';
  const fillerLen = contentBytes - (secret.length - cutIntoSecret) - afterSecret.length - Buffer.byteLength(verdict, 'utf8');
  assert.ok(fillerLen > 0, 'straddle filler must be positive');
  const text = `${prefix}${secret}${afterSecret}${fillerChar.repeat(fillerLen)}${verdict}`;
  const start = Buffer.byteLength(text, 'utf8') - contentBytes;
  const secretStart = Buffer.byteLength(prefix, 'utf8');
  assert.ok(start > secretStart, 'cut must start after the secret begins');
  assert.ok(start < secretStart + secret.length, 'cut must start before the secret ends');
  const rawTail = Buffer.from(text, 'utf8').subarray(start).toString('utf8');
  assert.doesNotMatch(rawTail, /\bsk-/u);
  assert.match(rawTail, /1234567890/u);
  return { text, rawTail };
}

test('tailText redacts a secret that straddles the tail cut and preserves the verdict', () => {
  const secret = 'sk-live-secret-1234567890';
  const verdict = 'VERDICT-END';
  const maxBytes = 64;
  const contentBytes = maxBytes - Buffer.byteLength('…', 'utf8');
  const { text } = secretStraddlingPayload({
    secret,
    verdict,
    contentBytes,
    cutIntoSecret: 10,
    prefixBody: 'x'.repeat(400),
    fillerChar: 'y',
  });
  const preview = tailText(text, maxBytes);
  assert.match(preview, /^…/u);
  assert.match(preview, /VERDICT-END$/u);
  assert.doesNotMatch(preview, /sk-live-secret-1234567890/u);
  assert.doesNotMatch(preview, /live-secret-1234567890/u);
  assert.doesNotMatch(preview, /secret-1234567890/u);
  assert.equal(preview.includes('[REDACTED]'), true);
  assert.ok(Buffer.byteLength(preview, 'utf8') <= maxBytes);
});

test('compact result preview redacts a secret straddling the 1536-byte tail and keeps the verdict', () => {
  const secret = 'sk-live-secret-1234567890';
  const verdict = 'VERDICT-TAIL';
  const previewBytes = 1_536;
  const contentBytes = previewBytes - Buffer.byteLength('…', 'utf8');
  const { text: output } = secretStraddlingPayload({
    secret,
    verdict,
    contentBytes,
    cutIntoSecret: 8,
    prefixBody: `HEAD-UNIQUE-${'x'.repeat(4_000)}`,
    fillerChar: 'z',
  });
  const compact = projectCompactTask({
    task: {
      id: 'compact-straddle',
      status: 'completed',
      provider: 'grok',
      role: 'implement',
      prompt_dispatched: true,
      created_at: '2026-08-20T00:00:00.000Z',
      updated_at: '2026-08-20T00:00:00.000Z',
      finished_at: '2026-08-20T00:01:00.000Z',
      result: { summary: 'done', output },
      handoff: { branch: 'codex/compact-straddle', head: 'f'.repeat(40) },
    },
    progress: fixtureProgress({ status: 'completed' }),
  });
  assert.equal(compact.result.output.endsWith(verdict), true);
  assert.equal(compact.result.output.includes('HEAD-UNIQUE'), false);
  assert.doesNotMatch(compact.result.output, /sk-live-secret-1234567890|live-secret-1234567890|secret-1234567890/u);
  assert.equal(compact.result.output.includes('[REDACTED]'), true);
  assert.ok(compactStructuredBytes(compact) <= COMPACT_STRUCTURED_BYTES_MAX);
});

test('compact projection stays within 8192 bytes for maximal messages, actions, extensions, and handoff', () => {
  const fourByte = '\u{1F600}';
  const maxMessage = `${fourByte.repeat(4_096)} sk-max-secret-1234567890 VERDICT-MESSAGE`;
  const maxAction = `${'A'.repeat(8_000)} VERDICT-ACTION`;
  const maxCheck = `${'C'.repeat(4_000)} sk-check-secret-1234567890 VERDICT-CHECK`;
  const maxOutput = `${'H'.repeat(20_000)} sk-output-secret-1234567890 ${'T'.repeat(1_200)}VERDICT-OUTPUT`;
  const extensions = Array.from({ length: 20 }, (_, index) => ({
    at: '2026-08-20T00:00:00.000Z',
    reason: `${'R'.repeat(512)}-ext-${index}`,
    previous_deadline_at: '2026-08-19T00:00:00.000Z',
    previous_expected_duration_ms: 60_000,
    previous_timeout_ms: 72_000,
    expected_duration_ms: 120_000,
    timeout_ms: 144_000,
    deadline_at: '2026-08-21T00:00:00.000Z',
    extra_junk: fourByte.repeat(2_000),
    nested: { blob: 'N'.repeat(4_000), token: 'sk-ext-secret-1234567890' },
  }));
  const compact = projectCompactTask({
    task: {
      id: `compact-max-${'i'.repeat(120)}`,
      status: 'failed',
      provider: `cursor-cloud-${'p'.repeat(1_000)}`,
      role: 'implement',
      prompt: 'do not leak this prompt sk-prompt-secret-1234567890',
      prompt_dispatched: true,
      created_at: '2026-08-20T00:00:00.000Z',
      updated_at: '2026-08-20T00:00:00.000Z',
      started_at: '2026-08-20T00:00:01.000Z',
      finished_at: '2026-08-20T00:02:00.000Z',
      branch: `codex/${'b'.repeat(2_000)}`,
      start_sha: 's'.repeat(4_000),
      workspace_kind: `managed-worktree-${'w'.repeat(2_000)}`,
      failed_stage: `provider_failure_${'f'.repeat(4_000)}`,
      last_lifecycle_stage: `handoff_${'l'.repeat(4_000)}`,
      acp_session_id: `sess-${'q'.repeat(4_000)}`,
      attention: { session_id: `sess-${'q'.repeat(4_000)}`, question_id: `q-${'u'.repeat(4_000)}` },
      expected_duration_ms: 60_000,
      duration_margin: 1.20,
      timeout_ms: 72_000,
      deadline_at: '2026-08-21T00:00:00.000Z',
      deadline_source: 'extended',
      deadline_extensions: extensions,
      error: { code: `provider_failure_${'e'.repeat(2_000)}`, message: maxMessage },
      suggested_action: maxAction,
      result: {
        summary: `${'S'.repeat(4_000)}VERDICT-SUMMARY`,
        output: maxOutput,
      },
      handoff: {
        branch: `codex/${'h'.repeat(2_000)}`,
        head: 'd'.repeat(4_000),
        pull_request: `https://example.invalid/${'p'.repeat(2_000)}`,
        validation: {
          status: 'failed',
          checks: [
            ...Array.from({ length: 40 }, (_, index) => `${maxCheck}-${index}`),
            { extra: 'E'.repeat(4_000), nested: { token: 'sk-handoff-secret-1234567890' } },
          ],
        },
      },
      cancellation: {
        status: `cancelling-${'c'.repeat(2_000)}`,
        cancel_requested: true,
        extra: fourByte.repeat(2_000),
      },
    },
    progress: {
      event_cursor: '9'.repeat(4_000),
      last_event: { type: 'terminal', text: `${maxOutput}` },
      new_event_count: 99,
      more_events: true,
      waited_ms: 40,
      wait_reason: `timeout-${'w'.repeat(2_000)}`,
    },
    extras: { question_id: `q-${'u'.repeat(4_000)}` },
  });

  assert.equal(compact.view, COMPACT_VIEW);
  assert.ok(compact.summary);
  assert.ok(compact.diagnostic);
  assert.equal(typeof compact.summary.message, 'string');
  assert.equal(Object.hasOwn(compact.diagnostic, 'message'), false);
  assert.equal(Object.hasOwn(compact.diagnostic, 'error_code'), false);
  assert.equal(Object.hasOwn(compact.diagnostic, 'suggested_action'), false);
  assert.equal(Object.hasOwn(compact, 'task'), false);
  assert.equal(Object.hasOwn(compact, 'runtime'), false);
  const serialized = JSON.stringify(compact);
  assert.doesNotMatch(serialized, /sk-(?:max|output|check|ext|handoff|prompt)-secret-1234567890/u);
  assert.doesNotMatch(serialized, /do not leak this prompt/u);
  const projectionBytes = compactStructuredBytes(compact);
  const { metrics } = measureResponse(compact);
  assert.ok(projectionBytes <= COMPACT_STRUCTURED_BYTES_MAX, `worst-case compact projection was ${projectionBytes}`);
  assert.ok(
    metrics.structured_content_bytes <= COMPACT_STRUCTURED_BYTES_MAX,
    `worst-case compact structured JSON was ${metrics.structured_content_bytes}`,
  );
  process.stdout.write(`${JSON.stringify({
    compact_worst_case_measurements: {
      projection_bytes: projectionBytes,
      structured_content_bytes: metrics.structured_content_bytes,
      jsonrpc_bytes: metrics.jsonrpc_bytes,
      text_content_bytes: metrics.text_content_bytes,
    },
  })}\n`);
});

test('compact result preview sanitizes arrays and nested objects before serializing short credential keys', () => {
  const leaked = [
    'short-api-key',
    'short-pass',
    'short-auth',
    'nest-key',
    'nest-pass',
    'nest-auth',
    'arr-key',
    'arr-pass',
    'obj-api-key',
    'obj-pass',
    'obj-auth',
    'nested-api',
    'nested-pass',
    'nested-auth',
    'only-api-key',
    'only-pass',
    'only-auth',
  ];
  const arrayCompact = projectCompactTask({
    task: {
      id: 'compact-array-secrets',
      status: 'completed',
      provider: 'grok',
      prompt_dispatched: true,
      result: [
        {
          apiKey: 'short-api-key',
          password: 'short-pass',
          authorization: 'short-auth',
          nested: {
            apiKey: 'nest-key',
            password: 'nest-pass',
            authorization: 'nest-auth',
            ok: 'visible-ok',
          },
        },
        { apiKey: 'arr-key', password: 'arr-pass' },
      ],
    },
    progress: fixtureProgress({ status: 'completed' }),
  });
  const objectCompact = projectCompactTask({
    task: {
      id: 'compact-object-secrets',
      status: 'completed',
      provider: 'grok',
      prompt_dispatched: true,
      result: {
        summary: 'done',
        output: 'TAIL-OK',
        apiKey: 'obj-api-key',
        password: 'obj-pass',
        authorization: 'obj-auth',
        nested: {
          apiKey: 'nested-api',
          password: 'nested-pass',
          authorization: 'nested-auth',
        },
      },
    },
    progress: fixtureProgress({ status: 'completed' }),
  });
  const nestedOnlyCompact = projectCompactTask({
    task: {
      id: 'compact-nested-only-secrets',
      status: 'failed',
      provider: 'cursor-local',
      prompt_dispatched: true,
      result: {
        nested: {
          apiKey: 'only-api-key',
          password: 'only-pass',
          authorization: 'only-auth',
          note: 'public-note',
        },
      },
    },
    progress: fixtureProgress({ status: 'failed' }),
  });

  for (const compact of [arrayCompact, objectCompact, nestedOnlyCompact]) {
    const serialized = JSON.stringify(compact);
    for (const secret of leaked) {
      assert.equal(serialized.includes(secret), false, `compact leaked ${secret}`);
    }
    assert.doesNotMatch(serialized, /"apiKey"|"password"|"authorization"/u);
    assert.ok(compactStructuredBytes(compact) <= COMPACT_STRUCTURED_BYTES_MAX);
  }
  assert.equal(objectCompact.result.output, 'TAIL-OK');
  assert.equal(objectCompact.result.summary, 'done');
  const arraySerialized = JSON.stringify(arrayCompact);
  assert.match(arraySerialized, /visible-ok/u);
  const nestedSerialized = JSON.stringify(nestedOnlyCompact);
  assert.match(nestedSerialized, /public-note/u);
});

test('compact projection terminates on adversarial records and stays within 8192 bytes', () => {
  const blob = 'x'.repeat(20_000);
  const toxic = Array.from({ length: 2_000 }, (_, index) => ({
    apiKey: 'ak',
    password: 'pw',
    authorization: 'az',
    blob,
    nested: { apiKey: 'nk', password: 'np', items: [blob, { authorization: 'na' }] },
    index,
  }));
  const started = Date.now();
  const compact = projectCompactTask({
    task: {
      id: toxic,
      status: 'completed',
      provider: toxic,
      role: toxic,
      created_at: toxic,
      updated_at: blob,
      started_at: toxic,
      finished_at: toxic,
      prompt_dispatched: toxic,
      result: toxic,
      handoff: {
        branch: toxic,
        head: blob,
        pull_request: toxic,
        apiKey: 'hk',
        password: 'hp',
        validation: { status: toxic, checks: toxic },
      },
      error: toxic,
      suggested_action: toxic,
      failed_stage: toxic,
      last_lifecycle_stage: toxic,
      acp_session_id: toxic,
      attention: toxic,
      deadline_extensions: toxic,
      cancellation: toxic,
      last_event: toxic,
      branch: toxic,
      start_sha: toxic,
      workspace_kind: toxic,
    },
    progress: toxic,
    extras: toxic,
    runtime: toxic,
  });
  const elapsed = Date.now() - started;
  const projectionBytes = compactStructuredBytes(compact);
  const { metrics } = measureResponse(compact);
  assert.ok(elapsed < 2_000, `adversarial compact projection took ${elapsed}ms`);
  assert.equal(compact.view, COMPACT_VIEW);
  assert.equal(typeof compact.task_id, 'string');
  assert.equal(typeof compact.summary.message, 'string');
  assert.equal(Array.isArray(compact.provider), false);
  assert.equal(Array.isArray(compact.status), false);
  assert.ok(projectionBytes <= COMPACT_STRUCTURED_BYTES_MAX, `adversarial compact JSON was ${projectionBytes}`);
  assert.ok(
    metrics.structured_content_bytes <= COMPACT_STRUCTURED_BYTES_MAX,
    `adversarial compact structured JSON was ${metrics.structured_content_bytes}`,
  );
  const serialized = JSON.stringify(compact);
  assert.doesNotMatch(serialized, /"apiKey"|"password"|"authorization"/u);
  assert.doesNotMatch(serialized, /"ak"|"pw"|"az"|"nk"|"np"|"na"|"hk"|"hp"/u);
  process.stdout.write(`${JSON.stringify({
    compact_adversarial_measurements: {
      elapsed_ms: elapsed,
      projection_bytes: projectionBytes,
      structured_content_bytes: metrics.structured_content_bytes,
      jsonrpc_bytes: metrics.jsonrpc_bytes,
    },
  })}\n`);
});
