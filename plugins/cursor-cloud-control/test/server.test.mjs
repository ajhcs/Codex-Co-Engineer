import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { CursorApiError } from '../mcp/client.mjs';
import { SubmissionLedger } from '../mcp/ledger.mjs';
import { CursorCloudService, TOOLS, handleToolCall, projectIdentity, runStdio } from '../mcp/server.mjs';

const agentId = 'bc-00000000-0000-0000-0000-000000000001';
const runId = 'run-00000000-0000-0000-0000-000000000001';

class FakeClient {
  constructor() {
    this.secrets = ['unit-secret-value'];
    this.calls = [];
    this.failFollowup = false;
    this.failRepositories = null;
    this.requestTimeoutMs = 30_000;
    this.repositoryTimeoutMs = 60_000;
    this.identity = {
      userId: 'cursor-user-0001',
      name: 'Ada Example',
      email: 'ada@example.test',
      avatar: 'https://example.test/avatar.png',
      organization: { name: 'Example Org' },
      apiKey: 'crsr_secret-value',
      unknown: 'must-not-cross-the-boundary',
    };
  }

  async createAgent(body) {
    this.calls.push(['createAgent', body]);
    return { agent: { id: body.agentId, name: 'unit-secret-value', status: 'ACTIVE' }, run: { id: runId, agentId: body.agentId, status: 'CREATING' } };
  }

  async createRun(agent, body) {
    this.calls.push(['createRun', agent, body]);
    if (this.failFollowup) throw new CursorApiError('network_error', 'network failed', { ambiguous: true });
    return { run: { id: runId, agentId: agent, status: 'CREATING' } };
  }

  async repositories() {
    this.calls.push(['repositories']);
    if (this.failRepositories) throw new CursorApiError(this.failRepositories, 'repository inventory unavailable', { retryable: true });
    return { items: [{ url: 'https://github.com/example/repo' }] };
  }

  async me() { this.calls.push(['me']); return this.identity; }

  async listAgents(query) { this.calls.push(['listAgents', query]); return { items: [{ id: agentId }], nextCursor: 'next' }; }
  async getAgent(id) { this.calls.push(['getAgent', id]); return { id, latestRunId: runId }; }
  async listRuns(id, query) { this.calls.push(['listRuns', id, query]); return { items: [{ id: runId, agentId: id, status: 'FINISHED' }] }; }
  async getRun(id, run) { this.calls.push(['getRun', id, run]); return { id: run, agentId: id, status: 'FINISHED', result: 'done' }; }
  async cancelRun(id, run) { this.calls.push(['cancelRun', id, run]); return { id: run }; }
  async usage(id, run) { this.calls.push(['usage', id, run]); return { totalUsage: { totalTokens: 1 }, runs: [{ id: run ?? runId }] }; }
  async archive(id) { this.calls.push(['archive', id]); return { id }; }
  async unarchive(id) { this.calls.push(['unarchive', id]); return { id }; }
  async deleteAgent(id) { this.calls.push(['delete', id]); return { id }; }
}

async function serviceFixture(context) {
  const state = await mkdtemp(path.join(os.tmpdir(), 'cursor-cloud-state-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const client = new FakeClient();
  return { client, service: new CursorCloudService({ env: { HOME: state, CURSOR_API_AUTH_SCHEME: 'bearer' }, client, ledger: new SubmissionLedger({ stateDir: state }) }) };
}

test('MCP initialize/tools/list/call exposes the compact typed surface', async (context) => {
  const { service } = await serviceFixture(context);
  const output = [];
  const writable = new Writable({ write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); } });
  await runStdio({
    input: Readable.from([
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } })}\n`,
    ]),
    output: writable,
    service,
  });
  const responses = output.map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'cursor-cloud-control');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['status', 'agents', 'runs', 'artifacts', 'usage', 'lifecycle']);
  assert.equal(responses[2].result.structuredContent.ok, true);
  assert.equal(TOOLS.length, 6);
});

test('local status discovers the prepared default owner-only config key without exposing it', async (context) => {
  const { service } = await serviceFixture(context);
  const keyDirectory = path.join(service.env.HOME, '.config', 'cursor-cloud-control');
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(keyDirectory, 'api-key');
  await writeFile(keyFile, 'unit-secret-value\n', { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const result = await handleToolCall('status', {}, service);
  assert.equal(result.structuredContent.status.credentials.configured, true);
  assert.equal(result.structuredContent.status.credentials.source, 'owner-only-file');
  assert.equal(JSON.stringify(result).includes('unit-secret-value'), false);
});

test('local status treats an empty default key file as unconfigured', async (context) => {
  const { service } = await serviceFixture(context);
  const keyDirectory = path.join(service.env.HOME, '.config', 'cursor-cloud-control');
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(keyDirectory, 'api-key');
  await writeFile(keyFile, '', { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const result = await handleToolCall('status', {}, service);
  assert.equal(result.structuredContent.status.credentials.configured, false);
  assert.equal(result.structuredContent.status.credentials.source, 'none');
});

test('identity status emits only the compact opaque identity projection', async (context) => {
  const { client, service } = await serviceFixture(context);
  const result = await handleToolCall('status', { action: 'identity' }, service);
  assert.deepEqual(result.structuredContent.identity, {
    authenticated: true,
    userId: 'cursor-user-0001',
    keyStatus: 'valid',
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of ['Ada Example', 'ada@example.test', 'avatar', 'Example Org', 'crsr_secret-value', 'must-not-cross-the-boundary']) {
    assert.equal(serialized.includes(forbidden), false, `identity leaked ${forbidden}`);
  }
  assert.deepEqual(client.calls, [['me']]);
});

test('identity projection fails closed when upstream has no safe opaque identifier', () => {
  assert.deepEqual(projectIdentity({ id: 'person@example.test', name: 'Ada Example', secret: 'hidden' }), {
    authenticated: true,
    userId: null,
    keyStatus: 'valid',
  });
  assert.deepEqual(projectIdentity({ id: { value: 'nested' }, email: 'ada@example.test' }), {
    authenticated: true,
    userId: null,
    keyStatus: 'valid',
  });
});

test('transient repository discovery failure degrades without retries or blocking direct repository use', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failRepositories = 'network_error';
  const result = await handleToolCall('status', { action: 'repositories' }, service);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.available, false);
  assert.equal(result.structuredContent.reason, 'network_error');
  assert.deepEqual(result.structuredContent.repositories.items, []);
  assert.equal(client.calls.filter((call) => call[0] === 'repositories').length, 1);
});

test('successful repository discovery is explicitly marked available', async (context) => {
  const { client, service } = await serviceFixture(context);
  const result = await handleToolCall('status', { action: 'repositories' }, service);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.available, true);
  assert.deepEqual(result.structuredContent.repositories.items, [{ url: 'https://github.com/example/repo' }]);
  assert.equal(client.calls.filter((call) => call[0] === 'repositories').length, 1);
});

test('HTTP 429 repository discovery remains a compact unavailable result', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failRepositories = 'rate_limited';
  const result = await handleToolCall('status', { action: 'repositories' }, service);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.available, false);
  assert.equal(result.structuredContent.reason, 'rate_limited');
  assert.deepEqual(result.structuredContent.repositories.items, []);
  assert.equal(client.calls.filter((call) => call[0] === 'repositories').length, 1);
});

test('repository discovery failure does not block direct immutable repository creation', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failRepositories = 'network_error';
  const discovery = await handleToolCall('status', { action: 'repositories' }, service);
  assert.equal(discovery.structuredContent.available, false);

  client.failRepositories = null;
  const startingRef = '0123456789abcdef0123456789abcdef01234567';
  const created = await handleToolCall('agents', {
    action: 'create',
    requestId: 'create-after-discovery-failure',
    prompt: { text: 'inspect the confirmed repository' },
    repos: [{ url: 'https://github.com/example/repo', startingRef }],
    mode: 'agent',
  }, service);
  assert.equal(created.structuredContent.ok, true);
  assert.equal(created.structuredContent.receipt.status, 'submitted');
  assert.deepEqual(client.calls.find((call) => call[0] === 'createAgent')[1].repos, [{ url: 'https://github.com/example/repo', startingRef }]);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('create maps official fields, safe defaults, redacted receipts, and deduplicates', async (context) => {
  const { client, service } = await serviceFixture(context);
  const args = { action: 'create', requestId: 'create-request-1', prompt: { text: 'unit-secret-value' }, envVars: { DEMO_VALUE: 'unit-secret-value' } };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.ok, true);
  assert.equal(first.structuredContent.agent.name, '[REDACTED]');
  assert.equal(first.structuredContent.receipt.effectiveConfiguration.mode, 'plan');
  assert.equal(first.structuredContent.receipt.effectiveConfiguration.workOnCurrentBranch, false);
  assert.equal(first.structuredContent.receipt.effectiveConfiguration.autoCreatePR, false);
  const createCall = client.calls.find((call) => call[0] === 'createAgent');
  assert.equal(createCall[1].workOnCurrentBranch, false);
  assert.equal(createCall[1].autoCreatePR, false);
  assert.equal(createCall[1].agentId, undefined, 'envVars create must omit client agentId');
  assert.equal(createCall[1].envVars.DEMO_VALUE, 'unit-secret-value');
  const second = await handleToolCall('agents', args, service);
  assert.equal(second.structuredContent.receipt.duplicate, true);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
  const pr = await handleToolCall('agents', { action: 'create', requestId: 'create-pr-request-1', prompt: { text: 'open a PR' }, autoCreatePR: true }, service);
  assert.equal(pr.structuredContent.receipt.effectiveConfiguration.skipReviewerRequest, true);
  const prCall = client.calls.find((call) => call[1]?.autoCreatePR === true);
  assert.equal(prCall[1].skipReviewerRequest, true);
});

test('uncertain follow-up is ledgered and cannot be silently duplicated', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failFollowup = true;
  const args = { action: 'followup', requestId: 'followup-request-1', agentId, prompt: { text: 'continue' } };
  const first = await handleToolCall('runs', args, service);
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  const second = await handleToolCall('runs', args, service);
  assert.equal(second.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, 1);
});

test('list, usage, cancellation, and deletion use exact typed endpoint operations', async (context) => {
  const { client, service } = await serviceFixture(context);
  const listed = await handleToolCall('agents', { action: 'list', limit: 1, includeArchived: false }, service);
  assert.equal(listed.structuredContent.agents.items.length, 1);
  const usage = await handleToolCall('usage', { agentId }, service);
  assert.equal(usage.structuredContent.usage.totalUsage.totalTokens, 1);
  const cancelled = await handleToolCall('runs', { action: 'cancel', agentId, runId }, service);
  assert.equal(cancelled.structuredContent.cancelled.id, runId);
  const deleted = await handleToolCall('lifecycle', { action: 'delete', agentId, confirmation: `delete:${agentId}` }, service);
  assert.equal(deleted.structuredContent.irreversible, true);
  assert.ok(client.calls.some((call) => call[0] === 'usage' && call[2] === undefined));
});
