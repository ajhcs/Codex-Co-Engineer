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
  sanitizePublicReceipt,
} from '../mcp/v3/diagnostics.mjs';
import { appendTaskEvent, createTask, taskPaths } from '../mcp/v3/task-store.mjs';

test('sanitizePublicReceipt omits raw prompt content and keeps prompt_dispatched', () => {
  const sanitized = sanitizePublicReceipt({
    prompt: 'raw secret prompt text',
    prompt_dispatched: true,
    result: 'done with sk-result-secret-1234567890',
    last_successful_stage: 'prompt_dispatched',
  });
  assert.equal(Object.hasOwn(sanitized, 'prompt'), false);
  assert.equal(sanitized.prompt_dispatched, true);
  assert.equal(sanitized.last_successful_stage, 'prompt_dispatched');
  assert.equal(sanitized.result.includes('[REDACTED]'), true);
  assert.doesNotMatch(JSON.stringify(sanitized), /raw secret prompt text|sk-result-secret-1234567890/u);
});

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

test('lossless diagnostics pagination reconstructs 250 small events exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-lossless-'));
  try {
    await createTask({
      root,
      prompt: 'lossless 250',
      record: { id: 'diag-lossless', status: 'running', provider: 'grok' },
    });
    const total = 250;
    for (let index = 0; index < total; index += 1) {
      await appendTaskEvent(root, 'diag-lossless', {
        type: 'provider',
        event: { type: 'note', seq: index, text: `event-${index}` },
      });
    }
    const collected = [];
    let cursor = '0';
    let pages = 0;
    let more = true;
    const cursors = [];
    while (more) {
      const page = await readTaskDiagnostics(root, 'diag-lossless', { cursor, max_bytes: 65536 });
      assert.ok(page.events.length > 0, 'page has events');
      assert.ok(page.events.length <= 100, `page capped at 100, got ${page.events.length}`);
      assert.match(page.event_cursor, /^[0-9]{1,16}$/u);
      assert.ok(Number(page.event_cursor) > Number(cursor), 'cursor advances');
      cursors.push(page.event_cursor);
      collected.push(...page.events);
      more = page.more_events;
      cursor = page.event_cursor;
      pages += 1;
      assert.ok(pages < 20, 'bounded pages');
      assert.ok(page.events.length <= 100);
    }
    assert.equal(pages, 3, '250 events with cap 100 yields 3 pages (100+100+50)');
    assert.equal(collected.length, total, 'every event exactly once');
    const seq = (event) => event?.event?.seq ?? event?.seq;
    const seqs = collected.map(seq).filter((value) => typeof value === 'number').sort((a, b) => a - b);
    assert.equal(seqs.length, total);
    for (let index = 0; index < total; index += 1) assert.equal(seqs[index], index, `seq ${index} present`);
    assert.equal(new Set(seqs).size, total);
    const { readFile, stat } = await import('node:fs/promises');
    const raw = await readFile(taskPaths(root, 'diag-lossless').events, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, total);
    const bytes = (await stat(taskPaths(root, 'diag-lossless').events)).size;
    assert.equal(Number(cursor), bytes, 'final cursor equals file size');
    const first100Bytes = Buffer.byteLength(lines.slice(0, 100).join('\n') + '\n', 'utf8');
    assert.equal(Number(cursors[0]), first100Bytes, 'cursor after 100 raw lines');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostics lossless pagination with small max_bytes still reconstructs exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-lossless-small-'));
  try {
    await createTask({
      root,
      prompt: 'small bytes',
      record: { id: 'diag-small-bytes', status: 'running', provider: 'grok' },
    });
    const total = 250;
    for (let index = 0; index < total; index += 1) {
      await appendTaskEvent(root, 'diag-small-bytes', {
        type: 'provider',
        event: { type: 'note', seq: index, text: `event-${index}` },
      });
    }
    const collected = [];
    let cursor = '0';
    let more = true;
    while (more) {
      const page = await readTaskDiagnostics(root, 'diag-small-bytes', { cursor, max_bytes: 1024 });
      assert.ok(page.events.length <= 100);
      assert.ok(page.events.length > 0 || !more);
      collected.push(...page.events);
      more = page.more_events;
      cursor = page.event_cursor;
      assert.match(cursor, /^[0-9]{1,16}$/u);
      if (collected.length > total) throw new Error('collected too many');
    }
    assert.equal(collected.length, total);
    const seq = (event) => event?.event?.seq ?? event?.seq;
    assert.equal(new Set(collected.map(seq).filter((value) => typeof value === 'number')).size, total);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lossless pagination preserves redaction and does not leak secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-lossless-secrets-'));
  try {
    await createTask({
      root,
      prompt: 'secret prompt sk-live-secret-1234567890 should not leak',
      record: { id: 'diag-secrets', status: 'running', provider: 'grok' },
    });
    const total = 120;
    for (let index = 0; index < total; index += 1) {
      await appendTaskEvent(root, 'diag-secrets', {
        type: 'provider',
        event: {
          type: 'tool_call',
          seq: index,
          title: `step-${index}`,
          apiKey: 'sk-live-secret-1234567890',
          bearer: 'Bearer sk-live-secret-99999999',
          text: `chunk-${index} with xai-provider-secret-99999999`,
        },
      });
    }
    const collected = [];
    let cursor = '0';
    let more = true;
    while (more) {
      const page = await readTaskDiagnostics(root, 'diag-secrets', { cursor, max_bytes: 65536 });
      collected.push(...page.events);
      more = page.more_events;
      cursor = page.event_cursor;
    }
    assert.equal(collected.length, total);
    const serialized = JSON.stringify(collected);
    assert.doesNotMatch(serialized, /sk-live-secret|xai-provider-secret|secret prompt/u);
    assert.match(serialized, /\[REDACTED\]/u);
    const seq = (event) => event?.event?.seq ?? event?.seq;
    const seqs = collected.map(seq).filter((value) => typeof value === 'number').sort((a, b) => a - b);
    assert.equal(seqs.length, total);
    assert.equal(new Set(seqs).size, total);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lossless pagination keeps corrupt-line placeholders and bounded recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-lossless-corrupt-'));
  try {
    await createTask({
      root,
      prompt: 'corrupt lines',
      record: { id: 'diag-corrupt', status: 'running', provider: 'grok' },
    });
    for (let index = 0; index < 30; index += 1) {
      await appendTaskEvent(root, 'diag-corrupt', { type: 'provider', event: { type: 'note', seq: index } });
    }
    const eventsPath = taskPaths(root, 'diag-corrupt').events;
    await appendFile(eventsPath, 'not-json-corrupt-line\n', 'utf8');
    await appendFile(eventsPath, '{ also not json }\n', 'utf8');
    for (let index = 30; index < 60; index += 1) {
      await appendTaskEvent(root, 'diag-corrupt', { type: 'provider', event: { type: 'note', seq: index } });
    }
    const collected = [];
    let cursor = '0';
    let more = true;
    while (more) {
      const page = await readTaskDiagnostics(root, 'diag-corrupt', { cursor, max_bytes: 1024 });
      collected.push(...page.events);
      more = page.more_events;
      cursor = page.event_cursor;
    }
    // 60 good + 2 corrupt placeholders = 62
    assert.equal(collected.length, 62);
    assert.equal(collected.filter((event) => event.corrupt === true).length, 2, 'corrupt placeholders preserved');
    const seq = (event) => event?.event?.seq ?? event?.seq;
    const seqs = collected.map(seq).filter((value) => typeof value === 'number').sort((a, b) => a - b);
    assert.equal(seqs.length, 60);
    assert.equal(new Set(seqs).size, 60);
    let probeCursor = '0';
    for (let index = 0; index < 3; index += 1) {
      const page = await readTaskDiagnostics(root, 'diag-corrupt', { cursor: probeCursor, max_bytes: 1024 });
      assert.match(page.event_cursor, /^[0-9]{1,16}$/u);
      if (!page.more_events) break;
      probeCursor = page.event_cursor;
    }
    await assert.rejects(() => readTaskDiagnostics(root, 'diag-corrupt', { cursor: '1', max_bytes: 1024 }), /cursor must land on an event-log line boundary/u);
    await assert.rejects(() => readTaskDiagnostics(root, 'diag-corrupt', { cursor: '999999999', max_bytes: 1024 }), /cursor is beyond/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lossless pagination handles oversized-line truncation markers without loss', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-lossless-oversize-'));
  try {
    await createTask({
      root,
      prompt: 'oversized lines',
      record: { id: 'diag-oversize-lossless', status: 'running', provider: 'grok' },
    });
    const totalGood = 150;
    for (let index = 0; index < 40; index += 1) {
      await appendTaskEvent(root, 'diag-oversize-lossless', { type: 'provider', event: { type: 'note', seq: index } });
    }
    const eventsPath = taskPaths(root, 'diag-oversize-lossless').events;
    await appendFile(eventsPath, `${'x'.repeat(8_000)}\n`, 'utf8');
    for (let index = 40; index < totalGood; index += 1) {
      await appendTaskEvent(root, 'diag-oversize-lossless', { type: 'provider', event: { type: 'note', seq: index } });
    }
    const collected = [];
    let cursor = '0';
    let more = true;
    let sawTruncated = false;
    while (more) {
      const page = await readTaskDiagnostics(root, 'diag-oversize-lossless', { cursor, max_bytes: 1024 });
      assert.ok(page.events.length <= 100, 'bounded by count');
      assert.ok(page.events.length > 0);
      if (page.events.some((event) => event.truncated === true)) sawTruncated = true;
      collected.push(...page.events);
      more = page.more_events;
      cursor = page.event_cursor;
    }
    assert.equal(sawTruncated, true, 'oversized truncation marker present');
    assert.equal(collected.length, totalGood + 1);
    assert.equal(collected.filter((event) => event.truncated === true).length, 1);
    const seq = (event) => event?.event?.seq ?? event?.seq;
    const seqs = collected.map(seq).filter((value) => typeof value === 'number').sort((a, b) => a - b);
    assert.equal(seqs.length, totalGood);
    assert.equal(new Set(seqs).size, totalGood);
    for (let index = 0; index < totalGood; index += 1) assert.equal(seqs[index], index);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostics page is bounded by both bytes and count and survives outer sanitization', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-bound-both-'));
  try {
    await createTask({
      root,
      prompt: 'both bounds',
      record: { id: 'diag-both', status: 'running', provider: 'grok' },
    });
    // 250 tiny events: each ~30 bytes, 250*30=7500 bytes < 65536, so bytes alone would allow all in one page
    // count must truncate to 100
    for (let index = 0; index < 250; index += 1) {
      await appendTaskEvent(root, 'diag-both', { type: 'provider', event: { type: 'note', seq: index, tiny: 'x' } });
    }
    const first = await readTaskDiagnostics(root, 'diag-both', { cursor: '0', max_bytes: 65536 });
    assert.equal(first.events.length, 100, 'first page capped at 100 despite bytes allowing more');
    assert.equal(first.more_events, true);
    // A correctly capped page has at most 100 events, so sanitizePublicReceipt already preserves it.
    const sanitized = sanitizePublicReceipt({ diagnostics: first });
    assert.ok(sanitized.diagnostics, 'sanitized keeps diagnostics');
    assert.equal(sanitized.diagnostics.events.length, 100, 'outer sanitization preserves capped page');
    const second = await readTaskDiagnostics(root, 'diag-both', { cursor: first.event_cursor, max_bytes: 65536 });
    assert.equal(second.events.length, 100);
    assert.equal(second.more_events, true);
    const third = await readTaskDiagnostics(root, 'diag-both', { cursor: second.event_cursor, max_bytes: 65536 });
    assert.equal(third.events.length, 50);
    assert.equal(third.more_events, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
