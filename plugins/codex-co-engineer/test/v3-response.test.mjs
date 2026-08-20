import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESPONSE_MODE_STRUCTURED,
  TEXT_FALLBACK_MAX_BYTES,
  TEXT_FALLBACK_SCHEMA,
  buildTextFallback,
  buildToolResult,
  resolveTextFallbackMaxBytes,
  sanitizeToolPayload,
  summarizeStructuredContent,
} from '../mcp/v3/response.mjs';

test('summarizeStructuredContent is deterministic for each public tool kind', () => {
  assert.deepEqual(
    summarizeStructuredContent({
      version: '3.1.1',
      healthy: true,
      active: 1,
      providers: ['grok'],
      tasks: [{ id: 'a', status: 'running', state: 'running', provider: 'grok' }],
    }),
    {
      kind: 'status',
      version: '3.1.1',
      healthy: true,
      active: 1,
      providers: ['grok'],
      task_count: 1,
      tasks: [{ id: 'a', status: 'running', state: 'running', provider: 'grok' }],
      tasks_omitted: 0,
    },
  );
  assert.equal(summarizeStructuredContent({
    task: { id: 't1', status: 'running', state: 'running', provider: 'dsh' },
    runtime: null,
    state: 'running',
    deadline: { deadline_at: '2026-01-01T00:00:00.000Z' },
  }).kind, 'delegate');
  assert.equal(summarizeStructuredContent({
    task: { id: 't1', status: 'running', state: 'running', provider: 'dsh' },
    runtime: null,
    progress: { wait_reason: 'timeout', event_cursor: '9' },
    state: 'running',
    summary: { message: 'still running' },
    diagnostic: null,
    diagnostics: null,
    capabilities: {},
    view: 'summary',
  }).kind, 'task');
  assert.equal(summarizeStructuredContent({
    tasks: [{ id: 'a', status: 'completed', state: 'succeeded', provider: 'grok' }],
  }).kind, 'tasks');
  assert.equal(summarizeStructuredContent({
    task: { id: 't1', status: 'cancelled', state: 'cancelled', provider: 'grok' },
  }).kind, 'cancel');
  assert.equal(summarizeStructuredContent({
    error: { code: 'invalid_event_cursor', message: 'bad cursor' },
  }).kind, 'error');
});

test('summarizeStructuredContent previews wait-any wrapper entries', () => {
  assert.deepEqual(summarizeStructuredContent({
    tasks: [{
      task_id: 'wait-any-1',
      task: { status: 'running', state: 'running', provider: 'grok' },
      progress: { last_event: { text: 'fresh progress' } },
      state: 'running',
      error: null,
    }],
  }), {
    kind: 'tasks',
    task_count: 1,
    tasks: [{ id: 'wait-any-1', status: 'running', state: 'running', provider: 'grok' }],
    tasks_omitted: 0,
  });
});

test('buildToolResult default preserves full 3.1.1 text duplication', () => {
  const value = {
    task: { id: 'keep-me', status: 'running', state: 'running', provider: 'grok', prompt_dispatched: true },
    runtime: null,
    state: 'running',
    deadline: { deadline_at: '2026-01-01T00:00:00.000Z', deadline_source: 'margin' },
  };
  const expected = sanitizeToolPayload(value);
  const omitted = buildToolResult(value);
  const explicitLegacy = buildToolResult(value, {});
  assert.deepEqual(omitted.structuredContent, expected);
  assert.equal(omitted.content[0].text, JSON.stringify(expected));
  assert.equal(omitted.content[0].text, JSON.stringify(omitted.structuredContent));
  assert.equal(explicitLegacy.content[0].text, JSON.stringify(expected));
});

test('buildToolResult structured mode bounds text while preserving structuredContent', () => {
  const value = {
    task: { id: 'keep-me', status: 'running', state: 'running', provider: 'grok', prompt_dispatched: true },
    runtime: null,
    state: 'running',
    deadline: { deadline_at: '2026-01-01T00:00:00.000Z', deadline_source: 'margin' },
  };
  const expected = sanitizeToolPayload(value);
  const first = buildToolResult(value, { responseMode: RESPONSE_MODE_STRUCTURED });
  const second = buildToolResult(value, { responseMode: RESPONSE_MODE_STRUCTURED });
  assert.deepEqual(first.structuredContent, expected);
  assert.deepEqual(first.structuredContent, second.structuredContent);
  assert.equal(first.content[0].text, second.content[0].text);
  assert.equal(first.structuredContent.task.id, 'keep-me');
  assert.equal(first.structuredContent.task.prompt_dispatched, true);
  const fallback = JSON.parse(first.content[0].text);
  assert.equal(fallback.schema, TEXT_FALLBACK_SCHEMA);
  assert.equal(fallback.authoritative, 'structuredContent');
  assert.equal(fallback.receipt_in_text, false);
  assert.equal(fallback.text_max_bytes, TEXT_FALLBACK_MAX_BYTES);
  assert.ok(Buffer.byteLength(first.content[0].text, 'utf8') <= TEXT_FALLBACK_MAX_BYTES);
  assert.notEqual(first.content[0].text, JSON.stringify(first.structuredContent));
});

test('buildTextFallback clamps maxBytes and reports the enforced text_max_bytes', () => {
  const huge = {
    version: '3.1.1',
    healthy: true,
    active: 50,
    providers: ['grok', 'cursor-local', 'dsh', 'cursor-cloud'],
    tasks: Array.from({ length: 20 }, (_, index) => ({
      id: `fixture-${index}`,
      status: 'running',
      state: 'running',
      provider: 'grok',
      message: 'y'.repeat(400),
    })),
  };
  const requested = 160;
  const effective = resolveTextFallbackMaxBytes(requested);
  assert.ok(effective >= requested || effective === resolveTextFallbackMaxBytes(1));
  const text = buildTextFallback(huge, { maxBytes: requested });
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(Buffer.byteLength(text, 'utf8') <= effective);
  const parsed = JSON.parse(text);
  assert.equal(parsed.authoritative, 'structuredContent');
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.text_max_bytes, effective);
  assert.equal(Buffer.isEncoding('utf8'), true);
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text);

  assert.equal(resolveTextFallbackMaxBytes(Number.NaN), TEXT_FALLBACK_MAX_BYTES);
  assert.equal(resolveTextFallbackMaxBytes(10_000), TEXT_FALLBACK_MAX_BYTES);
  assert.equal(resolveTextFallbackMaxBytes(-5), resolveTextFallbackMaxBytes(1));
});
