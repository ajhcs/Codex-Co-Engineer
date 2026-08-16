import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CursorApiClient,
  CursorApiError,
  authHeaderFromKey,
  defaultApiKeyFile,
  loadApiKey,
} from '../mcp/client.mjs';

function jsonResponse(value, { status = 200, type = 'application/json' } = {}) {
  return new Response(value === undefined ? '' : JSON.stringify(value), { status, headers: { 'content-type': type } });
}

test('constructs the documented Bearer and Basic authorization forms', () => {
  assert.equal(authHeaderFromKey('unit-secret-value', 'bearer'), 'Bearer unit-secret-value');
  assert.equal(authHeaderFromKey('unit-secret-value', 'basic'), `Basic ${Buffer.from('unit-secret-value:', 'utf8').toString('base64')}`);
});

test('discovers the default owner-only key file without returning its contents', async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cursor-cloud-home-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  const file = defaultApiKeyFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, 'unit-secret-value\n', { mode: 0o600 });
  await chmod(file, 0o600);
  assert.equal(await loadApiKey(env), 'unit-secret-value');
  await chmod(file, 0o644);
  await assert.rejects(loadApiKey(env), (error) => error.code === 'credential_file_permissions');
});

test('rejects non-TLS production origin overrides', () => {
  assert.throws(() => new CursorApiClient({ apiKey: 'unit-secret-value', origin: 'http://public.example' }), (error) => error.code === 'invalid_origin');
  assert.doesNotThrow(() => new CursorApiClient({ apiKey: 'unit-secret-value', origin: 'http://127.0.0.1:12345' }));
  assert.doesNotThrow(() => new CursorApiClient({ apiKey: 'unit-secret-value', origin: 'http://[::1]:12345' }));
});

test('maps v1 request paths and does not retry non-idempotent mutations', async () => {
  const calls = [];
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    origin: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ agent: { id: 'bc-00000000-0000-0000-0000-000000000001' }, run: { id: 'run-00000000-0000-0000-0000-000000000001' } });
    },
  });
  await client.createAgent({ prompt: { text: 'x' }, mode: 'plan' });
  await client.usage('bc-00000000-0000-0000-0000-000000000001', 'run-00000000-0000-0000-0000-000000000001');
  await client.artifactDownload('bc-00000000-0000-0000-0000-000000000001', 'artifacts/log.txt');
  assert.equal(calls[0].url, 'https://api.example.test/v1/agents');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer unit-secret-value');
  assert.match(calls[1].url, /\/v1\/agents\/bc-[^/]+\/usage\?runId=run-/);
  assert.match(calls[2].url, /\/v1\/agents\/bc-[^/]+\/artifacts\/download\?path=artifacts%2Flog.txt/);
});

test('classifies invalid JSON, content type, response size, timeout, and transport errors', async () => {
  const invalidJson = new CursorApiClient({ apiKey: 'unit-secret-value', fetchImpl: async () => new Response('{', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(invalidJson.me(), (error) => error.code === 'invalid_json');
  const invalidType = new CursorApiClient({ apiKey: 'unit-secret-value', fetchImpl: async () => new Response('not json', { headers: { 'content-type': 'text/plain' } }) });
  await assert.rejects(invalidType.me(), (error) => error.code === 'invalid_content_type');
  const oversized = new CursorApiClient({ apiKey: 'unit-secret-value', maxResponseBytes: 10, fetchImpl: async () => new Response('01234567890', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(oversized.me(), (error) => error.code === 'response_too_large');
  const timedOut = new CursorApiClient({ apiKey: 'unit-secret-value', requestTimeoutMs: 10, fetchImpl: (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  await assert.rejects(timedOut.me(), (error) => error.code === 'request_timeout');
  const bodyTimedOut = new CursorApiClient({
    apiKey: 'unit-secret-value', requestTimeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(bodyTimedOut.me(), (error) => error.code === 'request_timeout');
  let mutationCalls = 0;
  const failed = new CursorApiClient({ apiKey: 'unit-secret-value', fetchImpl: async () => { mutationCalls += 1; throw new Error('offline'); } });
  await assert.rejects(failed.createAgent({ prompt: { text: 'x' } }), (error) => error.code === 'network_error');
  assert.equal(mutationCalls, 1);
});
