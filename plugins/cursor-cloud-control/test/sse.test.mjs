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

test('stream timeout is bounded', async () => {
  const response = new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(consumeSse(response, { timeoutMs: 10 }), (error) => error.code === 'stream_timeout');
});
