import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROVIDER_CAPABILITIES, publicState } from '../mcp/v3/contract.mjs';
import {
  compactSummary,
  diagnosticEnvelope,
  lastActivityMs,
  readTaskDiagnostics,
  redactDiagnosticText,
} from '../mcp/v3/diagnostics.mjs';
import { appendTaskEvent, createTask, taskPaths } from '../mcp/v3/task-store.mjs';

test('normalized states map stored receipts onto the public contract', () => {
  assert.equal(publicState('completed'), 'succeeded');
  assert.equal(publicState('timeout'), 'timed_out');
  assert.equal(publicState('needs_attention'), 'needs_attention');
  assert.equal(publicState('environment_blocked'), 'environment_blocked');
});

test('provider capability reporting distinguishes reply, recovery, and evidence', () => {
  assert.equal(PROVIDER_CAPABILITIES.grok.same_session_reply, true);
  assert.equal(PROVIDER_CAPABILITIES['cursor-local'].same_session_reply, true);
  assert.equal(PROVIDER_CAPABILITIES.dsh.same_session_reply, false);
  assert.equal(PROVIDER_CAPABILITIES['cursor-cloud'].same_session_reply, false);
  assert.equal(PROVIDER_CAPABILITIES.dsh.dispatch_confidence, 'uncertain_after_spawn');
  assert.equal(PROVIDER_CAPABILITIES['cursor-cloud'].evidence, 'provider_reported_plus_independent_git');
  assert.equal(PROVIDER_CAPABILITIES.grok.evidence, 'local');
});

test('alerts are descriptive envelopes and never a bare ERROR string', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-diag-'));
  try {
    const { task } = await createTask({
      root,
      prompt: 'secret prompt sk-live-secret-1234567890',
      record: {
        id: 'diag-fail',
        status: 'failed',
        provider: 'grok',
        error: { code: 'provider_startup_failed', message: 'provider failed with sk-live-secret-1234567890' },
        acp_session_id: 'sess-1',
        cwd: '/tmp/worktree',
        branch: 'codex/diag-fail',
        start_sha: 'a'.repeat(40),
      },
    });
    const envelope = diagnosticEnvelope(task);
    assert.equal(envelope.state, 'failed');
    assert.equal(envelope.error_code, 'provider_startup_failed');
    assert.notEqual(envelope.message, 'ERROR');
    assert.ok(envelope.failed_stage);
    assert.equal(typeof envelope.retryable, 'boolean');
    assert.match(envelope.suggested_action, /diagnostics|failed stage/iu);
    assert.ok(envelope.evidence.files.includes('events.jsonl'));
    assert.doesNotMatch(JSON.stringify(envelope), /sk-live-secret|secret prompt/u);
    const summary = compactSummary(task, { event_cursor: '0', wait_reason: 'terminal' });
    assert.equal(summary.state, 'failed');
    assert.ok(summary.message.length > 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostics paging is bounded, cursor-stable, and redacts secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-diag-page-'));
  try {
    await createTask({
      root,
      prompt: 'do not leak this prompt or xai-secret-99999999',
      record: { id: 'diag-page', status: 'running', provider: 'cursor-local' },
    });
    for (let index = 0; index < 40; index += 1) {
      await appendTaskEvent(root, 'diag-page', {
        type: 'provider',
        event: {
          type: 'tool_call',
          title: `step-${index}`,
          apiKey: 'sk-live-secret-1234567890',
          text: `chunk-${index}`,
        },
      });
    }
    const first = await readTaskDiagnostics(root, 'diag-page', { cursor: '0', max_bytes: 1024 });
    assert.equal(first.view, 'diagnostics');
    assert.equal(first.more_events, true);
    assert.ok(first.events.length > 0);
    assert.doesNotMatch(JSON.stringify(first), /sk-live-secret|do not leak this prompt|xai-secret/u);
    const second = await readTaskDiagnostics(root, 'diag-page', {
      cursor: first.event_cursor,
      max_bytes: 1024,
    });
    assert.ok(Number(second.event_cursor) >= Number(first.event_cursor));
    assert.equal(redactDiagnosticText('token sk-live-secret-1234567890'), 'token [REDACTED]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostics paging skips an oversized event line and advances the cursor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-diag-oversize-'));
  try {
    await createTask({
      root,
      prompt: 'page an oversized line',
      record: { id: 'diag-oversize', status: 'running', provider: 'grok' },
    });
    const eventsPath = taskPaths(root, 'diag-oversize').events;
    await appendFile(eventsPath, `${'x'.repeat(8_000)}\n`, 'utf8');
    await appendTaskEvent(root, 'diag-oversize', { type: 'provider', event: { type: 'tool_call', title: 'after-oversize' } });
    const first = await readTaskDiagnostics(root, 'diag-oversize', { cursor: '0', max_bytes: 1024 });
    assert.ok(Number(first.event_cursor) > 0);
    assert.equal(first.more_events, true);
    assert.equal(first.events.some((event) => event?.truncated === true), true);
    const second = await readTaskDiagnostics(root, 'diag-oversize', {
      cursor: first.event_cursor,
      max_bytes: 1024,
    });
    assert.ok(Number(second.event_cursor) > Number(first.event_cursor));
    assert.equal(JSON.stringify(second.events).includes('after-oversize'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lastActivityMs tail-scans a large ledger in bounded chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-diag-tail-'));
  try {
    const { task } = await createTask({
      root,
      prompt: 'scan the tail',
      record: { id: 'diag-tail', status: 'running', provider: 'grok', updated_at: '2026-08-19T00:00:00.000Z' },
    });
    const lastAt = '2026-08-19T12:34:56.000Z';
    const older = '{"at":"2026-08-19T01:00:00.000Z","type":"status"}\n'.repeat(40_000);
    const eventsPath = taskPaths(root, 'diag-tail').events;
    await writeFile(eventsPath, `${older}{"at":"${lastAt}","type":"terminal"}\n`, 'utf8');
    const started = Date.now();
    const activity = await lastActivityMs(root, task);
    assert.equal(activity, Date.parse(lastAt));
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
