import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    this.blockCreateAgent = false;
    this.createAgentStarted = new Promise((resolve) => { this.resolveCreateAgentStarted = resolve; });
    this.releaseCreateAgent = null;
    this.failCreateAgent = null;
    this.afterCreateAgent = null;
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
    if (this.failCreateAgent) {
      throw new CursorApiError(this.failCreateAgent, 'create rejected', {
        retryable: this.failCreateAgent === 'upstream_failure',
      });
    }
    if (this.blockCreateAgent) {
      this.resolveCreateAgentStarted();
      await new Promise((resolve) => { this.releaseCreateAgent = resolve; });
    }
    const response = { agent: { id: body.agentId, name: 'unit-secret-value', status: 'ACTIVE' }, run: { id: runId, agentId: body.agentId, status: 'CREATING' } };
    if (this.afterCreateAgent) await this.afterCreateAgent();
    return response;
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

class ConcurrentSecretClient extends FakeClient {
  constructor() {
    super();
    this.firstCreateStarted = new Promise((resolve) => { this.resolveFirstCreateStarted = resolve; });
    this.releaseFirstCreate = null;
  }

  async createAgent(body) {
    this.calls.push(['createAgent', body]);
    const secret = body.mcpServers?.[0]?.headers?.Authorization;
    if (secret === 'resolved-secret-a') {
      this.resolveFirstCreateStarted();
      await new Promise((resolve) => { this.releaseFirstCreate = resolve; });
      return { agent: { id: body.agentId, detail: secret }, run: { id: runId, agentId: body.agentId, status: 'CREATING' } };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new CursorApiError('bad_request', `provider rejected ${secret}`);
  }
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

test('local status reports explicit durable-state readiness and source', async (context) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'cursor-cloud-readiness-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const { service } = await serviceFixture(context);
  service.env = { CURSOR_CLOUD_CONTROL_STATE_DIR: path.join(state, 'ledger') };
  service.ledger = new SubmissionLedger({ stateDir: path.join(state, 'ledger'), source: 'environment' });
  const result = await handleToolCall('status', {}, service);
  assert.deepEqual(result.structuredContent.status.state, {
    directory: path.join(state, 'ledger'),
    ready: true,
    source: 'environment',
    durability: 'owner-only-local-ledger',
    durableLedger: true,
    plaintextSensitiveInputs: false,
  });
});

test('local status fails closed without a state-root fallback', async (context) => {
  const { client, service } = await serviceFixture(context);
  service.env = {};
  service.ledger = new SubmissionLedger({ stateDir: null, source: 'unconfigured', reason: 'Set CURSOR_CLOUD_CONTROL_STATE_DIR before using Cursor mutations.' });
  const result = await handleToolCall('status', {}, service);
  assert.equal(result.structuredContent.status.state.ready, false);
  assert.equal(result.structuredContent.status.state.source, 'unconfigured');
  assert.equal(result.structuredContent.status.state.durability, 'owner-only-local-ledger');
  assert.match(result.structuredContent.status.state.reason, /CURSOR_CLOUD_CONTROL_STATE_DIR/);
  assert.equal(result.structuredContent.status.state.reasonCode, 'ledger_unavailable');
  assert.deepEqual(client.calls, []);
});

test('durable-state unavailability blocks mutations before the client but preserves read-only list/get', async (context) => {
  const { client, service } = await serviceFixture(context);
  service.ledger = new SubmissionLedger({
    stateDir: null,
    source: 'unconfigured',
    reason: 'Set CURSOR_CLOUD_CONTROL_STATE_DIR before using Cursor mutations.',
  });

  const readOnlyResults = await Promise.all([
    handleToolCall('agents', { action: 'list', limit: 1 }, service),
    handleToolCall('agents', { action: 'get', agentId }, service),
    handleToolCall('runs', { action: 'list', agentId, limit: 1 }, service),
    handleToolCall('runs', { action: 'get', agentId, runId }, service),
  ]);
  for (const result of readOnlyResults) assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(client.calls.map(([operation]) => operation), ['listAgents', 'getAgent', 'listRuns', 'getRun']);

  const mutationArguments = [
    ['agents', { action: 'create', requestId: 'unavailable-create-1', prompt: { text: 'create' } }],
    ['runs', { action: 'followup', requestId: 'unavailable-followup-1', agentId, prompt: { text: 'continue' } }],
    ['runs', { action: 'cancel', agentId, runId }],
    ['lifecycle', { action: 'archive', agentId }],
    ['lifecycle', { action: 'unarchive', agentId }],
    ['lifecycle', { action: 'delete', agentId, confirmation: `delete:${agentId}` }],
  ];
  for (const [name, arguments_] of mutationArguments) {
    const callsBefore = client.calls.length;
    const result = await handleToolCall(name, arguments_, service);
    assert.equal(result.isError, true, `${name}/${arguments_.action} should fail closed`);
    assert.equal(result.structuredContent.error.code, 'ledger_unavailable');
    assert.match(result.structuredContent.error.message, /CURSOR_CLOUD_CONTROL_STATE_DIR/);
    assert.equal(client.calls.length, callsBefore, `${name}/${arguments_.action} reached the Cursor client`);
  }
  assert.deepEqual(client.calls.map(([operation]) => operation), ['listAgents', 'getAgent', 'listRuns', 'getRun']);
});

test('missing credentials fail before reserving a durable submission record', async (context) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'cursor-cloud-missing-credentials-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const ledger = new SubmissionLedger({ stateDir: path.join(state, 'ledger') });
  const service = new CursorCloudService({
    env: { HOME: state, CURSOR_API_AUTH_SCHEME: 'bearer' },
    ledger,
  });
  const result = await handleToolCall('agents', {
    action: 'create', requestId: 'missing-credentials-1', prompt: { text: 'create' },
  }, service);
  assert.equal(result.structuredContent.error.code, 'credentials_missing');
  await assert.rejects(readFile(path.join(state, 'ledger', 'submissions.json'), 'utf8'), { code: 'ENOENT' });
});

test('unsafe ledger state blocks create, follow-up, cancel, and lifecycle before the client', async (context) => {
  const { client, service } = await serviceFixture(context);
  const target = path.join(service.ledger.stateDir, 'unsafe-target');
  await mkdir(target, { mode: 0o700 });
  const unsafe = path.join(service.ledger.stateDir, 'unsafe-link');
  await symlink(target, unsafe);
  service.ledger = new SubmissionLedger({ stateDir: unsafe, source: 'environment' });

  const create = await handleToolCall('agents', {
    action: 'create', requestId: 'unsafe-create-1', prompt: { text: 'create' },
  }, service);
  const followup = await handleToolCall('runs', {
    action: 'followup', requestId: 'unsafe-follow-1', agentId, prompt: { text: 'continue' },
  }, service);
  const cancel = await handleToolCall('runs', { action: 'cancel', agentId, runId }, service);
  const lifecycle = await handleToolCall('lifecycle', { action: 'archive', agentId }, service);
  for (const result of [create, followup, cancel, lifecycle]) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'ledger_permissions');
  }
  assert.deepEqual(client.calls, []);
});

test('corrupt or group-readable ledger blocks mutations before network', async (context) => {
  const { client, service } = await serviceFixture(context);
  const file = path.join(service.ledger.stateDir, 'submissions.json');
  await writeFile(file, '{not-json', { mode: 0o600 });
  await chmod(file, 0o600);
  const corrupt = await handleToolCall('agents', {
    action: 'create', requestId: 'corrupt-create-1', prompt: { text: 'create' },
  }, service);
  assert.equal(corrupt.structuredContent.error.code, 'ledger_corrupt');
  assert.deepEqual(client.calls, []);

  await rm(file, { force: true });
  await writeFile(file, JSON.stringify({ version: 1, records: [] }), { mode: 0o640 });
  await chmod(file, 0o640);
  const readable = await handleToolCall('lifecycle', { action: 'archive', agentId }, service);
  assert.equal(readable.structuredContent.error.code, 'ledger_permissions');
  assert.deepEqual(client.calls, []);
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

test('create forwards explicit empty repositories and image dimensions unchanged', async (context) => {
  const { client, service } = await serviceFixture(context);
  const args = {
    action: 'create',
    requestId: 'create-image-repo-contract',
    prompt: {
      text: 'inspect this image',
      images: [{ data: 'abcd', mimeType: 'image/png', dimension: { width: 640, height: 480 } }],
    },
    repos: [],
  };

  const result = await handleToolCall('agents', args, service);
  assert.equal(result.structuredContent.ok, true);
  const createCall = client.calls.find((call) => call[0] === 'createAgent');
  assert.ok(createCall, 'createAgent should receive the validated request');
  assert.ok(Object.hasOwn(createCall[1], 'repos'), 'explicit empty repos must remain present');
  assert.deepEqual(createCall[1].repos, []);
  assert.deepEqual(createCall[1].prompt, args.prompt);
  assert.deepEqual(createCall[1].prompt.images[0].dimension, { width: 640, height: 480 });
});

test('remote MCP env references materialize official auth and credential headers without leaking values', async (context) => {
  const { client, service } = await serviceFixture(context);
  service.env = {
    ...service.env,
    MCP_CLIENT_ID: 'client-id-value',
    MCP_CLIENT_SECRET: 'client-secret-value',
    MCP_SCOPE_READ: 'file_content:read',
    MCP_AUTHORIZATION: 'Bearer remote-secret-value',
  };
  const args = {
    action: 'create', requestId: 'mcp-materialize-create-1', prompt: { text: 'use the remote server' },
    mcpServers: [{
      name: 'remote', type: 'http', url: 'https://example.test/mcp',
      headers: { 'X-Trace': 'safe-trace' },
      headerEnv: { Authorization: 'MCP_AUTHORIZATION' },
      authEnv: { CLIENT_ID: 'MCP_CLIENT_ID', CLIENT_SECRET: 'MCP_CLIENT_SECRET', scopes: ['MCP_SCOPE_READ'] },
    }],
  };
  const result = await handleToolCall('agents', args, service);
  assert.equal(result.structuredContent.ok, true);
  const body = client.calls.find((call) => call[0] === 'createAgent')[1];
  assert.deepEqual(body.mcpServers, [{
    name: 'remote', type: 'http', url: 'https://example.test/mcp',
    headers: { 'X-Trace': 'safe-trace', Authorization: 'Bearer remote-secret-value' },
    auth: { CLIENT_ID: 'client-id-value', CLIENT_SECRET: 'client-secret-value', scopes: ['file_content:read'] },
  }]);
  const serialized = JSON.stringify(result);
  for (const secret of ['client-id-value', 'client-secret-value', 'file_content:read', 'Bearer remote-secret-value']) {
    assert.equal(serialized.includes(secret), false, `result leaked ${secret}`);
  }
  const ledger = await readFile(path.join(service.ledger.stateDir, 'submissions.json'), 'utf8');
  for (const secret of ['client-id-value', 'client-secret-value', 'file_content:read', 'Bearer remote-secret-value']) {
    assert.equal(ledger.includes(secret), false, `ledger leaked ${secret}`);
  }
  assert.equal(result.structuredContent.receipt.requestDigest.length, 64);
  assert.equal(result.structuredContent.receipt.effectiveConfiguration.mcpServerCount, 1);
  const digest = result.structuredContent.receipt.requestDigest;
  service.env.MCP_AUTHORIZATION = 'Bearer changed-secret-value';
  const duplicate = await handleToolCall('agents', args, service);
  assert.equal(duplicate.structuredContent.receipt.duplicate, true);
  assert.equal(duplicate.structuredContent.receipt.requestDigest, digest);
  assert.equal(JSON.stringify(duplicate).includes('changed-secret-value'), false);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('missing or invalid MCP secret references fail before reservation and provider calls', async (context) => {
  const { client, service } = await serviceFixture(context);
  const result = await handleToolCall('agents', {
    action: 'create', requestId: 'mcp-materialize-missing-1', prompt: { text: 'use the remote server' },
    mcpServers: [{ name: 'remote', url: 'https://example.test/mcp', headerEnv: { Authorization: 'MCP_MISSING' } }],
  }, service);
  assert.equal(result.structuredContent.error.code, 'invalid_input');
  assert.match(result.structuredContent.error.message, /missing or empty/);
  assert.deepEqual(client.calls, []);
  await assert.rejects(readFile(path.join(service.ledger.stateDir, 'submissions.json'), 'utf8'), { code: 'ENOENT' });

  service.env.MCP_BAD_CLIENT_ID = 'client-id-for-invalid-scope';
  service.env.MCP_BAD_SCOPE = 'scope with spaces';
  const invalidScope = await handleToolCall('agents', {
    action: 'create', requestId: 'mcp-materialize-invalid-scope', prompt: { text: 'use the remote server' },
    mcpServers: [{ name: 'remote', url: 'https://example.test/mcp', authEnv: { CLIENT_ID: 'MCP_BAD_CLIENT_ID', scopes: ['MCP_BAD_SCOPE'] } }],
  }, service);
  assert.equal(invalidScope.structuredContent.error.code, 'invalid_input');
  assert.match(invalidScope.structuredContent.error.message, /invalid OAuth scope/);
  assert.deepEqual(client.calls, []);
});

test('follow-up MCP env references are materialized while the digest retains only caller references', async (context) => {
  const { client, service } = await serviceFixture(context);
  service.env.MCP_FOLLOWUP_AUTH = 'Bearer followup-secret-value';
  const args = {
    action: 'followup', requestId: 'mcp-materialize-followup-1', agentId,
    prompt: { text: 'continue with the remote server' },
    mcpServers: [{ name: 'remote', url: 'https://example.test/mcp', headerEnv: { Authorization: 'MCP_FOLLOWUP_AUTH' } }],
  };
  const result = await handleToolCall('runs', args, service);
  assert.equal(result.structuredContent.ok, true);
  const body = client.calls.find((call) => call[0] === 'createRun')[2];
  assert.deepEqual(body.mcpServers[0].headers, { Authorization: 'Bearer followup-secret-value' });
  assert.equal(JSON.stringify(result).includes('followup-secret-value'), false);
  const ledger = await readFile(path.join(service.ledger.stateDir, 'submissions.json'), 'utf8');
  assert.equal(ledger.includes('followup-secret-value'), false);
  assert.equal(result.structuredContent.receipt.requestDigest.length, 64);
});

test('concurrent MCP secret resolution cannot cross-contaminate delayed success and error redaction', async (context) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'cursor-cloud-concurrent-secrets-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const client = new ConcurrentSecretClient();
  const service = new CursorCloudService({
    env: {
      HOME: state,
      CURSOR_API_AUTH_SCHEME: 'bearer',
      MCP_SECRET_A: 'resolved-secret-a',
      MCP_SECRET_B: 'resolved-secret-b',
    },
    client,
    ledger: new SubmissionLedger({ stateDir: state }),
  });
  const args = (requestId, envName) => ({
    action: 'create', requestId, prompt: { text: 'submit once' },
    mcpServers: [{ name: 'remote', type: 'http', url: 'https://example.test/mcp', headerEnv: { Authorization: envName } }],
  });

  const firstPromise = handleToolCall('agents', args('concurrent-secret-a', 'MCP_SECRET_A'), service);
  await client.firstCreateStarted;
  const second = await handleToolCall('agents', args('concurrent-secret-b', 'MCP_SECRET_B'), service);
  client.releaseFirstCreate();
  const first = await firstPromise;

  for (const result of [first, second]) {
    const structured = JSON.stringify(result.structuredContent);
    const text = result.content.map((entry) => entry.text ?? '').join('\n');
    assert.equal(structured.includes('resolved-secret-a'), false, 'structured response leaked secret A');
    assert.equal(structured.includes('resolved-secret-b'), false, 'structured response leaked secret B');
    assert.equal(text.includes('resolved-secret-a'), false, 'text response leaked secret A');
    assert.equal(text.includes('resolved-secret-b'), false, 'text response leaked secret B');
  }
  assert.equal(first.structuredContent.ok, true);
  assert.equal(second.structuredContent.error.message, 'provider rejected [REDACTED]');
});

test('concurrent identical generated-ID creates share one submission and preserve duplicate receipt', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.blockCreateAgent = true;
  const args = { action: 'create', requestId: 'concurrent-create-1', prompt: { text: 'same caller intent' } };

  const firstPromise = handleToolCall('agents', args, service);
  await client.createAgentStarted;
  const concurrent = await handleToolCall('agents', args, service);
  assert.equal(concurrent.isError, true);
  assert.equal(concurrent.structuredContent.error.code, 'submission_in_progress');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);

  client.releaseCreateAgent();
  const first = await firstPromise;
  assert.equal(first.structuredContent.ok, true);
  assert.equal(first.structuredContent.receipt.duplicate, false);
  assert.match(first.structuredContent.receipt.agentId, /^bc-/);

  const duplicate = await handleToolCall('agents', args, service);
  assert.equal(duplicate.structuredContent.ok, true);
  assert.equal(duplicate.structuredContent.receipt.duplicate, true);
  assert.equal(duplicate.structuredContent.receipt.agentId, first.structuredContent.receipt.agentId);
  assert.equal(duplicate.structuredContent.receipt.requestDigest, first.structuredContent.receipt.requestDigest);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('definitive create failure leaves a retryable reservation', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'bad_request';
  const args = { action: 'create', requestId: 'definitive-create-failure-1', prompt: { text: 'retry me' } };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'bad_request');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'failed');

  client.failCreateAgent = null;
  const retry = await handleToolCall('agents', args, service);
  assert.equal(retry.structuredContent.ok, true);
  assert.equal(retry.structuredContent.receipt.duplicate, false);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 2);
});

test('retryable upstream mutation failures remain uncertain and are never resubmitted', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'upstream_failure';
  const args = { action: 'create', requestId: 'upstream-create-failure-1', prompt: { text: 'submit once' } };

  const first = await handleToolCall('agents', args, service);
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');

  client.failCreateAgent = null;
  const retry = await handleToolCall('agents', args, service);
  assert.equal(retry.isError, true);
  assert.equal(retry.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('a missing reservation after provider success fails uncertain and prevents resubmission', async (context) => {
  const { client, service } = await serviceFixture(context);
  const args = { action: 'create', requestId: 'missing-final-record-1', prompt: { text: 'create once' } };
  client.afterCreateAgent = () => rm(path.join(service.ledger.stateDir, 'submissions.json'));

  const first = await handleToolCall('agents', args, service);
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);

  client.afterCreateAgent = null;
  const second = await handleToolCall('agents', args, service);
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('changed create intent conflicts even when the first request generated its agent ID', async (context) => {
  const { client, service } = await serviceFixture(context);
  const first = await handleToolCall('agents', {
    action: 'create', requestId: 'changed-create-1', prompt: { text: 'original intent' },
  }, service);
  assert.equal(first.structuredContent.ok, true);

  const changed = await handleToolCall('agents', {
    action: 'create', requestId: 'changed-create-1', prompt: { text: 'changed intent' },
  }, service);
  assert.equal(changed.isError, true);
  assert.equal(changed.structuredContent.error.code, 'request_id_conflict');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
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

test('expired streams reconcile the exact run without resubmitting', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.streamRun = async (agent, run, options) => {
    client.calls.push(['streamRun', agent, run, options]);
    throw new CursorApiError('stream_expired', 'stream cursor expired', { status: 410 });
  };

  const result = await handleToolCall('runs', {
    action: 'stream', agentId, runId, lastEventId: 'cursor-7',
  }, service);

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.streamExpired, true);
  assert.equal(result.structuredContent.reconciled, true);
  assert.equal(result.structuredContent.run.id, runId);
  assert.deepEqual(client.calls, [
    ['streamRun', agentId, runId, { lastEventId: 'cursor-7', timeoutMs: 30_000 }],
    ['getRun', agentId, runId],
  ]);
  assert.equal(client.calls.some((call) => call[0] === 'createRun'), false);
});

test('stream timeouts preserve partial progress and non-expiry errors', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.streamRun = async (agent, run, options) => {
    client.calls.push(['streamRun', agent, run, options]);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'id: cursor-7\nevent: replay\ndata: {"text":"replayed"}\n\n'
          + 'id: cursor-8\nevent: assistant\ndata: {"text":"partial"}\n\n',
        ));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };

  const partial = await handleToolCall('runs', {
    action: 'stream', agentId, runId, lastEventId: 'cursor-7', timeoutMs: 250,
  }, service);

  assert.equal(partial.structuredContent.ok, true);
  assert.equal(partial.structuredContent.stream.timedOut, true);
  assert.deepEqual(partial.structuredContent.stream.events.map((event) => event.id), ['cursor-8']);
  assert.equal(partial.structuredContent.stream.lastEventId, 'cursor-8');
  assert.equal(partial.structuredContent.resumedFrom, 'cursor-7');

  client.streamRun = async () => {
    throw new CursorApiError('network_error', 'stream failed');
  };
  const failure = await handleToolCall('runs', { action: 'stream', agentId, runId }, service);
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code, 'network_error');
  assert.equal(client.calls.filter((call) => call[0] === 'getRun').length, 0);
});
