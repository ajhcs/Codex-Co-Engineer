import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      if (String(url).includes('/usage')) {
        return jsonResponse({
          totalUsage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
          runs: [{ id: 'run-00000000-0000-0000-0000-000000000001', usage: {
            inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0,
          } }],
        });
      }
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

test('uses one extended attempt for repository discovery and repository-backed creation', async () => {
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    requestTimeoutMs: 12_345,
    repositoryTimeoutMs: 54_321,
    fetchImpl: async () => jsonResponse({ items: [] }),
  });
  const calls = [];
  client.json = async (pathname, options) => {
    calls.push({ pathname, options });
    return { items: [] };
  };

  await client.repositories();
  await client.createAgent({ prompt: { text: 'repository task' }, repos: [{ url: 'https://github.com/example/repo' }] });
  await client.createAgent({ prompt: { text: 'projectless task' } });

  assert.deepEqual(calls[0], {
    pathname: '/v1/repositories',
    options: { timeoutMs: 54_321, retryRead: false },
  });
  assert.equal(calls[1].options.timeoutMs, 54_321);
  assert.equal(calls[1].options.retryRead, false);
  assert.equal(calls[2].options.timeoutMs, 12_345);
});

test('forwards state and repository timeout overrides through the MCP manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.mcp.json', import.meta.url), 'utf8'));
  assert.ok(manifest.mcpServers['cursor-cloud-control'].env_vars.includes('XDG_STATE_HOME'));
  assert.ok(manifest.mcpServers['cursor-cloud-control'].env_vars.includes('CURSOR_CLOUD_CONTROL_REPOSITORY_TIMEOUT_MS'));
});

test('repository discovery has one absolute deadline and one fetch attempt', async () => {
  let calls = 0;
  let bodyCancelled = false;
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    repositoryTimeoutMs: 40,
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(new ReadableStream({
        start() {},
        cancel() { bodyCancelled = true; },
      }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const started = Date.now();
  await assert.rejects(client.repositories(), (error) => error.code === 'request_timeout');
  const elapsed = Date.now() - started;
  assert.equal(calls, 1);
  assert.equal(bodyCancelled, true, 'the single request deadline must cancel the response body');
  assert.ok(elapsed < 500, `request exceeded a generous absolute deadline bound (elapsed ${elapsed}ms)`);
});

test('repository discovery surfaces HTTP 429 without retrying', async () => {
  let calls = 0;
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ message: 'rate limited' }, { status: 429 });
    },
  });
  await assert.rejects(client.repositories(), (error) => error.code === 'rate_limited' && error.status === 429);
  assert.equal(calls, 1);
});

test('fetches HTTPS presigned artifacts through bounded manual redirects without API authorization', async () => {
  const calls = [];
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/artifacts/log.txt?signature=unit' } });
      return new Response(new Uint8Array([97, 114, 116, 105, 102, 97, 99, 116]), { headers: { 'content-length': '8' } });
    },
  });

  const bytes = await client.fetchPresigned('https://signed.example.test/download?signature=unit', { timeoutMs: 1_000 });
  assert.equal(new TextDecoder().decode(bytes), 'artifact');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.deepEqual(call.init.headers, { Accept: '*/*' });
    assert.equal(call.init.headers.Authorization, undefined);
  }
});

test('rejects unsafe initial and redirected artifact destinations before fetching them', async () => {
  const unsafeUrls = [
    'http://cdn.example.test/artifact',
    'https://user:password@cdn.example.test/artifact',
    'https://127.0.0.1/artifact',
    'https://10.0.0.8/artifact',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/artifact',
    'https://[fd00::8]/artifact',
    'https://metadata.google.internal/artifact',
  ];
  for (const url of unsafeUrls) {
    let calls = 0;
    const client = new CursorApiClient({ apiKey: 'unit-secret-value', fetchImpl: async () => { calls += 1; return new Response('unexpected'); } });
    await assert.rejects(client.fetchPresigned(url), (error) => error.code === 'invalid_artifact_url');
    assert.equal(calls, 0, `unsafe initial URL was fetched: ${url}`);
  }

  for (const location of unsafeUrls) {
    let calls = 0;
    const client = new CursorApiClient({
      apiKey: 'unit-secret-value',
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    await assert.rejects(client.fetchPresigned('https://signed.example.test/download'), (error) => error.code === 'invalid_artifact_url');
    assert.equal(calls, 1, `unsafe redirect was followed: ${location}`);
  }
});

test('bounds presigned artifact redirect hops', async () => {
  const calls = [];
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location: `https://cdn.example.test/hop-${calls.length + 1}` } });
    },
  });
  await assert.rejects(client.fetchPresigned('https://signed.example.test/start', { maxRedirects: 2 }), (error) => error.code === 'artifact_redirect_limit');
  assert.equal(calls.length, 3);
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
