import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeSse } from '../mcp/sse.mjs';

function responseFromChunks(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function delayedResponse(chunks, delayMs) {
  let index = 0;
  let cancelled = false;
  let pendingTimer;
  const stream = new ReadableStream({
    pull(controller) {
      if (cancelled) return;
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[index++]));
      if (index < chunks.length) {
        return new Promise((resolve) => {
          pendingTimer = setTimeout(resolve, delayMs);
        });
      }
      return undefined;
    },
    cancel() {
      cancelled = true;
      clearTimeout(pendingTimer);
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

test('parses fragmented SSE frames, multiline data, IDs, comments, unknown events, and done', async () => {
  const response = responseFromChunks([
    ': heartbeat\r\n\r\nevent: status\ndata: {"runId":"run-1","status":"RUNNING"}\r\n\r\n',
    'id: opaque-1\r\nevent: assistant\r\ndata: {"text":"hello\r\ndata: world"}\r\n\r\n',
    'event: future\nid: opaque-2\ndata: {"value":"unit-secret-value"}\r\n\r\nevent: heartbeat\ndata: {}\r\n\r\nevent: done\ndata: {}\r\n\r\n',
  ]);
  const result = await consumeSse(response, { secrets: ['unit-secret-value'] });
  assert.equal(result.complete, true);
  assert.equal(result.lastEventId, 'opaque-2');
  assert.deepEqual(result.events.map((event) => event.event), ['status', 'assistant', 'future', 'heartbeat', 'done']);
  assert.equal(result.events[1].id, 'opaque-1');
  assert.equal(result.events[1].data, '{"text":"hello\nworld"}');
  assert.equal(result.events[2].data.value, '[REDACTED]');
});

test('bounds stream output and preserves resume metadata', async () => {
  const response = responseFromChunks(['id: first\nevent: assistant\ndata: {"text":"large"}\n\n', 'id: second\nevent: assistant\ndata: {"text":"later"}\n\n']);
  const result = await consumeSse(response, { maxEvents: 1, maxBytes: 1024 });
  assert.equal(result.truncated, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.lastEventId, 'second');
});

test('deduplicates resumed IDs while preserving the exact latest cursor', async () => {
  const response = responseFromChunks([
    'id: cursor-1\nevent: assistant\ndata: {"text":"replayed"}\n\n',
    'id: cursor-2\nevent: assistant\ndata: {"text":"next"}\n\n',
    'id: cursor-2\nevent: assistant\ndata: {"text":"duplicate"}\n\n',
  ]);
  const result = await consumeSse(response, { lastEventId: 'cursor-1' });
  assert.deepEqual(result.events.map((event) => event.id), ['cursor-2']);
  assert.equal(result.events[0].data.text, 'next');
  assert.equal(result.lastEventId, 'cursor-2');
  assert.equal(result.timedOut, false);
});

test('bounded timeout returns parsed redacted events and resume metadata', async () => {
  const response = delayedResponse([
    'id: cursor-1\nevent: assistant\ndata: {"text":"unit-secret-value"}\n\n',
    'id: cursor-2\nevent: assistant\ndata: {"text":"later"}\n\n',
  ], 100);
  const result = await consumeSse(response, { timeoutMs: 20, secrets: ['unit-secret-value'] });
  assert.equal(result.timedOut, true);
  assert.equal(result.complete, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, 'cursor-1');
  assert.equal(result.events[0].data.text, '[REDACTED]');
  assert.equal(result.lastEventId, 'cursor-1');
});
