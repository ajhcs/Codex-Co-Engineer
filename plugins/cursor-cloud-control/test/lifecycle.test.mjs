import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CursorApiClient, CursorApiError } from '../mcp/client.mjs';
import { SubmissionLedger } from '../mcp/ledger.mjs';
import { CursorCloudService, handleToolCall } from '../mcp/server.mjs';

const agentId = 'bc-00000000-0000-0000-0000-000000000001';
const runId = 'run-00000000-0000-0000-0000-000000000001';

function jsonResponse(value = {}, { status = 200 } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mutationMethods() {
  return [
    {
      name: 'createAgent',
      invoke: (client) => client.createAgent({ prompt: { text: 'create' }, mode: 'plan' }),
      path: '/v1/agents',
      method: 'POST',
    },
    {
      name: 'createRun',
      invoke: (client) => client.createRun(agentId, { prompt: { text: 'continue' } }),
      path: `/v1/agents/${agentId}/runs`,
      method: 'POST',
    },
    {
      name: 'cancelRun',
      invoke: (client) => client.cancelRun(agentId, runId),
      path: `/v1/agents/${agentId}/runs/${runId}/cancel`,
      method: 'POST',
    },
    {
      name: 'archive',
      invoke: (client) => client.archive(agentId),
      path: `/v1/agents/${agentId}/archive`,
      method: 'POST',
    },
    {
      name: 'unarchive',
      invoke: (client) => client.unarchive(agentId),
      path: `/v1/agents/${agentId}/unarchive`,
      method: 'POST',
    },
    {
      name: 'deleteAgent',
      invoke: (client) => client.deleteAgent(agentId),
      path: `/v1/agents/${agentId}`,
      method: 'DELETE',
    },
  ];
}

test('Cursor mutation endpoints use exact paths and make exactly one attempt', async () => {
  const calls = [];
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    origin: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return jsonResponse({ message: 'upstream unavailable' }, { status: 503 });
    },
  });

  for (const operation of mutationMethods()) {
    await assert.rejects(operation.invoke(client), (error) => {
      assert.equal(error.code, 'upstream_failure');
      assert.equal(error.retryable, true);
      return true;
    }, operation.name);
  }

  assert.deepEqual(calls, mutationMethods().map(({ path: pathname, method }) => ({ url: `https://api.example.test${pathname}`, method })));
});

test('usage and artifact metadata remain read-only GET operations with exact endpoint mapping', async () => {
  const calls = [];
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    origin: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      if (String(url).endsWith('/usage')) return jsonResponse({ totalUsage: { totalTokens: 3 }, runs: [] });
      if (String(url).includes('/artifacts/download')) return jsonResponse({ url: 'https://signed.example.test/artifact' });
      return jsonResponse({ items: [{ path: 'artifacts/output.txt', sizeBytes: 3 }] });
    },
  });

  await client.usage(agentId);
  await client.usage(agentId, runId);
  await client.artifacts(agentId);
  await client.artifactDownload(agentId, 'artifacts/output.txt');

  assert.deepEqual(calls, [
    { url: `https://api.example.test/v1/agents/${agentId}/usage`, method: 'GET' },
    { url: `https://api.example.test/v1/agents/${agentId}/usage?runId=${runId}`, method: 'GET' },
    { url: `https://api.example.test/v1/agents/${agentId}/artifacts`, method: 'GET' },
    { url: `https://api.example.test/v1/agents/${agentId}/artifacts/download?path=artifacts%2Foutput.txt`, method: 'GET' },
  ]);
});

class LifecycleClient {
  constructor() {
    this.secrets = [];
    this.calls = [];
    this.failMutation = false;
  }

  async cancelRun(id, run) { return this.mutate('cancelRun', id, run); }
  async archive(id) { return this.mutate('archive', id); }
  async unarchive(id) { return this.mutate('unarchive', id); }
  async deleteAgent(id) { return this.mutate('deleteAgent', id); }

  async artifacts(id) {
    this.calls.push(['artifacts', id]);
    return { items: [{ path: 'artifacts/output.txt', sizeBytes: 3 }] };
  }

  async artifactDownload(id, requestedPath) {
    this.calls.push(['artifactDownload', id, requestedPath]);
    return { url: 'https://signed.example.test/artifact' };
  }

  async fetchPresigned(url) {
    this.calls.push(['fetchPresigned', url]);
    return new TextEncoder().encode('out');
  }

  async usage(id, run) {
    this.calls.push(['usage', id, run]);
    return { totalUsage: { totalTokens: 3 }, runs: [{ id: run ?? runId }] };
  }

  async mutate(operation, ...args) {
    this.calls.push([operation, ...args]);
    if (this.failMutation) throw new CursorApiError('upstream_failure', 'provider unavailable', { retryable: true });
    return { id: args.at(-1) };
  }
}

async function serviceFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-lifecycle-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts');
  await mkdir(artifactRoot, { mode: 0o700 });
  const client = new LifecycleClient();
  const service = new CursorCloudService({
    env: {
      HOME: root,
      CURSOR_ARTIFACT_ROOT: artifactRoot,
      CURSOR_API_AUTH_SCHEME: 'bearer',
    },
    client,
    ledger: new SubmissionLedger({ stateDir: path.join(root, 'state') }),
  });
  return { client, service, artifactRoot };
}

test('service dispatches archive, unarchive, cancel, and delete once with exact target IDs', async (context) => {
  const { client, service } = await serviceFixture(context);

  const archived = await handleToolCall('lifecycle', { action: 'archive', agentId }, service);
  const unarchived = await handleToolCall('lifecycle', { action: 'unarchive', agentId }, service);
  const cancelled = await handleToolCall('runs', { action: 'cancel', agentId, runId }, service);
  const deleted = await handleToolCall('lifecycle', { action: 'delete', agentId, confirmation: `delete:${agentId}` }, service);

  assert.equal(archived.structuredContent.ok, true);
  assert.equal(unarchived.structuredContent.ok, true);
  assert.equal(cancelled.structuredContent.ok, true);
  assert.equal(deleted.structuredContent.ok, true);
  assert.equal(deleted.structuredContent.irreversible, true);
  assert.deepEqual(client.calls, [
    ['archive', agentId],
    ['unarchive', agentId],
    ['cancelRun', agentId, runId],
    ['deleteAgent', agentId],
  ]);
});

test('lifecycle delete requires exact confirmation and never contacts Cursor on rejection', async (context) => {
  const { client, service } = await serviceFixture(context);
  for (const confirmation of [agentId, `delete:${agentId}:extra`, `delete:bc-00000000-0000-0000-0000-000000000002`]) {
    const result = await handleToolCall('lifecycle', { action: 'delete', agentId, confirmation }, service);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'confirmation_required');
  }
  assert.deepEqual(client.calls, []);
});

test('service exposes usage and artifact list/download lifecycle without mutation retry', async (context) => {
  const { client, service } = await serviceFixture(context);
  const usage = await handleToolCall('usage', { agentId }, service);
  const listed = await handleToolCall('artifacts', { action: 'list', agentId }, service);
  const downloaded = await handleToolCall('artifacts', {
    action: 'download', agentId, path: 'artifacts/output.txt', destination: 'run/output.txt',
  }, service);

  assert.equal(usage.structuredContent.usage.totalUsage.totalTokens, 3);
  assert.deepEqual(listed.structuredContent.artifacts.items, [{ path: 'artifacts/output.txt', sizeBytes: 3 }]);
  assert.equal(downloaded.structuredContent.artifact.path, 'artifacts/output.txt');
  assert.equal(downloaded.structuredContent.artifact.downloadedBytes, 3);
  assert.deepEqual(client.calls, [
    ['usage', agentId, undefined],
    ['artifacts', agentId],
    ['artifacts', agentId],
    ['artifactDownload', agentId, 'artifacts/output.txt'],
    ['fetchPresigned', 'https://signed.example.test/artifact'],
  ]);
});

test('service does not auto-retry failed lifecycle mutations', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failMutation = true;

  const operations = [
    ['runs', { action: 'cancel', agentId, runId }, 'cancelRun'],
    ['lifecycle', { action: 'archive', agentId }, 'archive'],
    ['lifecycle', { action: 'unarchive', agentId }, 'unarchive'],
    ['lifecycle', { action: 'delete', agentId, confirmation: `delete:${agentId}` }, 'deleteAgent'],
  ];
  for (const [tool, arguments_, operation] of operations) {
    const result = await handleToolCall(tool, arguments_, service);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'upstream_failure');
    assert.equal(client.calls.filter(([name]) => name === operation).length, 1, `${operation} was retried`);
  }
});
