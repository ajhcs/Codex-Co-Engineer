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
const otherAgentId = 'bc-00000000-0000-0000-0000-000000000002';
const otherRunId = 'run-00000000-0000-0000-0000-000000000002';

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
    this.notFoundAgent = false;
    this.notFoundRuns = false;
    this.failRepositories = null;
    this.modelCatalog = {
      items: [{
        id: 'provider-model-dynamic',
        displayName: 'Provider Dynamic',
        aliases: ['provider-latest'],
        parameters: [{ id: 'reasoning', values: [{ value: 'deep' }] }],
        variants: [{ params: [{ id: 'reasoning', value: 'deep' }], displayName: 'Deep', isDefault: true }],
      }],
    };
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
    const assignedAgentId = body.agentId ?? agentId;
    const response = { agent: { id: assignedAgentId, name: 'unit-secret-value', status: 'ACTIVE' }, run: { id: runId, agentId: assignedAgentId, status: 'CREATING' } };
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
  async models(options) { this.calls.push(['models', options]); return this.modelCatalog; }

  async listAgents(query) { this.calls.push(['listAgents', query]); return { items: [{ id: agentId }], nextCursor: 'next' }; }
  async getAgent(id) {
    this.calls.push(['getAgent', id]);
    if (this.notFoundAgent) throw new CursorApiError('not_found', 'Cursor API returned HTTP 404.', { status: 404 });
    return { id, latestRunId: runId };
  }
  async listRuns(id, query) {
    this.calls.push(['listRuns', id, query]);
    if (this.notFoundRuns) throw new CursorApiError('not_found', 'Cursor API returned HTTP 404.', { status: 404 });
    return { items: [{ id: runId, agentId: id, status: 'FINISHED' }] };
  }
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
      return { agent: { id: agentId, detail: secret }, run: { id: runId, agentId, status: 'CREATING' } };
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

test('model status defaults to a compact dynamic summary and preserves truncation truth', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.modelCatalog = {
    items: Array.from({ length: 3 }, (_, index) => ({ id: `provider-${index}`, displayName: `Provider ${index}`, parameters: [{ id: 'mode', values: [{ value: 'fast' }] }] })),
    truncated: true,
  };
  const result = await handleToolCall('status', { action: 'models', limit: 1 }, service);
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.models.items, [{ id: 'provider-0', displayName: 'Provider 0' }]);
  assert.equal(result.structuredContent.models.modelCount, null);
  assert.equal(result.structuredContent.models.truncated, true);
  assert.equal(result.structuredContent.models.pageTruncated, true);
  assert.deepEqual(client.calls.find((call) => call[0] === 'models')[1], { forceRefresh: false });
});

test('model status exposes bounded detail and explicit refresh only when requested', async (context) => {
  const { client, service } = await serviceFixture(context);
  const result = await handleToolCall('status', { action: 'models', detail: true, refresh: true }, service);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.models.items[0].parameters[0].values[0].value, 'deep');
  assert.equal(result.structuredContent.models.items[0].variants[0].isDefault, true);
  assert.deepEqual(client.calls.find((call) => call[0] === 'models')[1], { forceRefresh: true });
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
  assert.equal(second.structuredContent.receipt.effectiveConfiguration.deprecated, true);
  assert.ok(second.structuredContent.receipt.requestedConfiguration);
  assert.equal(second.structuredContent.receipt.providerVerification.verification, 'unverified');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
  const pr = await handleToolCall('agents', { action: 'create', requestId: 'create-pr-request-1', prompt: { text: 'open a PR' }, autoCreatePR: true }, service);
  assert.equal(pr.structuredContent.receipt.effectiveConfiguration.skipReviewerRequest, true);
  const prCall = client.calls.find((call) => call[1]?.autoCreatePR === true);
  assert.equal(prCall[1].skipReviewerRequest, true);
});

test('a successful create response without a provider agent ID remains uncertain and is never retried', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.createAgent = async (body) => {
    client.calls.push(['createAgent', body]);
    return { run: { id: runId, status: 'CREATING' } };
  };
  const args = { action: 'create', requestId: 'create-empty-success-1', prompt: { text: 'response body is incomplete' } };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');
  const second = await handleToolCall('agents', args, service);
  assert.equal(second.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('an explicit create ID does not turn an ID-less 2xx response into a completed receipt', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.createAgent = async (body) => {
    client.calls.push(['createAgent', body]);
    return { run: { id: runId, status: 'CREATING' } };
  };
  const args = {
    action: 'create', requestId: 'create-explicit-id-empty-success-1', agentId,
    prompt: { text: 'provider response omits its ID' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  const record = await service.ledger.lookup(args.requestId);
  assert.equal(record.status, 'uncertain');
  assert.equal(record.providerAgentId, agentId);
  assert.equal(record.agentId, null);
  const second = await handleToolCall('agents', args, service);
  assert.equal(second.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('provider-assigned create reconciliation never attributes a pre-existing fingerprint match', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.createAgent = async (body) => {
    client.calls.push(['createAgent', body]);
    return {};
  };
  client.listAgents = async (query) => {
    client.calls.push(['listAgents', query]);
    return { items: [{ id: agentId, name: 'recoverable-agent', prompt: 'recover this exact task', model: { id: 'provider-model' } }] };
  };
  const args = {
    action: 'create', requestId: 'create-fingerprint-recovery-1', name: 'recoverable-agent',
    model: { id: 'provider-model' }, prompt: { text: 'recover this exact task' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  const reconciled = await handleToolCall('agents', { action: 'reconcile', requestId: args.requestId }, service);
  assert.equal(reconciled.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('explicit create ID mismatch remains uncertain and never finalizes the returned agent', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.createAgent = async (body) => {
    client.calls.push(['createAgent', body]);
    return { agent: { id: 'bc-00000000-0000-0000-0000-000000000002' }, run: { id: runId, status: 'CREATING' } };
  };
  const args = {
    action: 'create', requestId: 'create-provider-id-mismatch-1', agentId,
    prompt: { text: 'provider must honor exact requested ID' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  const record = await service.ledger.lookup(args.requestId);
  assert.equal(record.status, 'uncertain');
  assert.equal(record.providerAgentId, agentId);
  assert.equal(record.providerReturnedAgentId, 'bc-00000000-0000-0000-0000-000000000002');
  const second = await handleToolCall('agents', args, service);
  assert.equal(second.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('create does not finalize a run returned for a different agent', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.createAgent = async (body) => {
    client.calls.push(['createAgent', body]);
    return { agent: { id: agentId }, run: { id: runId, agentId: otherAgentId, status: 'CREATING' } };
  };
  const args = {
    action: 'create', requestId: 'create-provider-run-mismatch-1', agentId,
    prompt: { text: 'do not bind a cross-agent run' },
  };
  const result = await handleToolCall('agents', args, service);
  assert.equal(result.structuredContent.error.code, 'uncertain_submission');
  const record = await service.ledger.lookup(args.requestId);
  assert.equal(record.status, 'uncertain');
  assert.equal(record.providerReturnedRunAgentId, otherAgentId);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('create receipts separate requested model while leaving effective model unknown', async (context) => {
  const { client, service } = await serviceFixture(context);
  const requested = { id: 'provider-requested', params: [{ id: 'reasoning', value: 'deep' }] };
  const result = await handleToolCall('agents', {
    action: 'create', requestId: 'create-model-unknown-effective', prompt: { text: 'use the requested model' }, model: requested,
  }, service);
  assert.deepEqual(result.structuredContent.receipt.effectiveConfiguration.model, {
    requested,
    requestedSource: 'caller',
    effective: null,
    effectiveKnown: false,
    effectiveSource: 'unknown',
  });
  assert.deepEqual(client.calls.find((call) => call[0] === 'createAgent')[1].model, requested);
});

test('create receipts keep requested refs separate from unverified provider state', async (context) => {
  const { client, service } = await serviceFixture(context);
  const requestedRef = '4b516f55149bccb0936e20da4c4bcb6c8cc2e95c';
  const result = await handleToolCall('agents', {
    action: 'create',
    requestId: 'create-ref-verification-1',
    prompt: { text: 'inspect the requested revision' },
    model: { id: 'provider-requested' },
    repos: [{ url: 'https://github.com/example/repo', startingRef: requestedRef }],
    mode: 'plan',
  }, service);

  const receipt = result.structuredContent.receipt;
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(receipt.requestedConfiguration.repositories, [{
    url: 'https://github.com/example/repo',
    startingRef: requestedRef,
  }]);
  assert.equal(receipt.effectiveConfiguration.provenance, 'caller-derived');
  assert.equal(receipt.effectiveConfiguration.deprecated, true);
  assert.match(receipt.effectiveConfiguration.deprecation, /requestedConfiguration/);

  assert.equal(receipt.providerVerification.verification, 'unverified');
  assert.equal(receipt.providerVerification.source, 'provider-response-unavailable');
  assert.equal(receipt.providerVerification.model.effectiveKnown, false);
  assert.equal(receipt.providerVerification.workspace.effectiveKnown, false);
  assert.deepEqual(receipt.providerVerification.repositories[0].startingRef, {
    requested: requestedRef,
    requestedSource: 'caller',
    effective: null,
    effectiveKnown: false,
    effectiveSource: 'unknown',
    verification: 'unverified',
  });
  assert.deepEqual(client.calls.find((call) => call[0] === 'createAgent')[1].repos, [{
    url: 'https://github.com/example/repo',
    startingRef: requestedRef,
  }]);
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

test('concurrent identical provider-assigned creates share one submission and preserve duplicate receipt', async (context) => {
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
  assert.equal(Object.hasOwn(client.calls[0][1], 'agentId'), false, 'generated reservation IDs must not be sent to Cursor');
  assert.equal(first.structuredContent.ok, true);
  assert.equal(first.structuredContent.receipt.duplicate, false);
  assert.equal(first.structuredContent.receipt.agentId, agentId);

  const duplicate = await handleToolCall('agents', args, service);
  assert.equal(duplicate.structuredContent.ok, true);
  assert.equal(duplicate.structuredContent.receipt.duplicate, true);
  assert.equal(duplicate.structuredContent.receipt.agentId, first.structuredContent.receipt.agentId);
  assert.equal(duplicate.structuredContent.receipt.requestDigest, first.structuredContent.receipt.requestDigest);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('provider-assigned creates omit local IDs and keep different request IDs independent', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'upstream_failure';
  const args = { action: 'create', requestId: 'reconcile-assigned-1', prompt: { text: 'provider assigns the ID' } };

  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  const record = await service.ledger.lookup(args.requestId);
  assert.equal(record.providerAgentId, null);
  assert.equal(Object.hasOwn(client.calls[0][1], 'agentId'), false);

  client.failCreateAgent = null;
  const newRequest = await handleToolCall('agents', {
    action: 'create', requestId: 'reconcile-assigned-2', envVars: {}, prompt: { text: 'do not duplicate' },
  }, service);
  assert.equal(newRequest.structuredContent.ok, true);
  const missingTarget = await handleToolCall('agents', { action: 'reconcile', requestId: args.requestId }, service);
  assert.equal(missingTarget.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'getAgent').length, 0);
  const attemptedBinding = await handleToolCall('agents', {
    action: 'reconcile', requestId: args.requestId, agentId,
  }, service);
  assert.equal(attemptedBinding.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'getAgent').length, 0);
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

test('known Cursor agent-id conflicts are definitive and preserve the provider code', async (context) => {
  const { client, service } = await serviceFixture(context);
  const originalCreate = client.createAgent.bind(client);
  client.createAgent = async (body) => {
    client.calls.push(['createAgent', body]);
    if (client.calls.filter((call) => call[0] === 'createAgent').length === 1) {
      throw new CursorApiError('conflict', 'Cursor rejected the requested agent ID.', {
        status: 409,
        providerCode: 'agent_id_conflict',
      });
    }
    return originalCreate(body);
  };
  const args = {
    action: 'create', requestId: 'agent-id-conflict-1', agentId,
    prompt: { text: 'retry after definitive conflict' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'conflict');
  const failed = await service.ledger.lookup(args.requestId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.providerCode, 'agent_id_conflict');
  const retry = await handleToolCall('agents', args, service);
  assert.equal(retry.structuredContent.ok, true);
  assert.equal(retry.structuredContent.receipt.duplicate, false);
});

test('HTTP 429 rate limits are definitive and preserve the provider code', async (context) => {
  const { client, service } = await serviceFixture(context);
  const originalCreate = client.createAgent.bind(client);
  let attempts = 0;
  client.createAgent = async (body) => {
    attempts += 1;
    if (attempts === 1) {
      throw new CursorApiError('rate_limited', 'Cursor rate limit reached.', {
        status: 429,
        retryable: true,
        providerCode: 'rate_limit_exceeded',
      });
    }
    return originalCreate(body);
  };
  const args = {
    action: 'create', requestId: 'rate-limit-definitive-1', agentId,
    prompt: { text: 'retry after definitive rate limit' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'rate_limited');
  const failed = await service.ledger.lookup(args.requestId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.providerCode, 'rate_limit_exceeded');

  const retry = await handleToolCall('agents', args, service);
  assert.equal(retry.structuredContent.ok, true);
  assert.equal(retry.structuredContent.receipt.duplicate, false);
  assert.equal(attempts, 2);
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

test('explicit provider-404 reconciliation releases an uncertain create reservation without duplicating it', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'upstream_failure';
  const args = {
    action: 'create', requestId: 'reconcile-create-1', agentId,
    prompt: { text: 'submit once, then reconcile' },
  };

  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');

  const sameRequest = await handleToolCall('agents', args, service);
  assert.equal(sameRequest.structuredContent.error.code, 'uncertain_submission');

  const newRequestSameAgent = await handleToolCall('agents', {
    ...args, requestId: 'reconcile-create-2',
  }, service);
  assert.equal(newRequestSameAgent.structuredContent.error.code, 'uncertain_submission');
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);

  client.notFoundAgent = true;
  client.notFoundRuns = true;
  const reconciled = await handleToolCall('agents', {
    action: 'reconcile', requestId: args.requestId,
  }, service);
  assert.equal(reconciled.structuredContent.ok, true);
  assert.deepEqual(reconciled.structuredContent.provider, {
    agent: 'not_found', runs: 'not_found', reservation: 'released',
  });
  assert.equal(reconciled.structuredContent.status, 'failed');
  assert.equal(reconciled.structuredContent.agentId, agentId);
  assert.equal((await service.ledger.lookup(args.requestId)).reconciliationReason, 'provider_not_found');
  assert.deepEqual(client.calls.slice(-4), [
    ['getAgent', agentId], ['listRuns', agentId, {}],
    ['getAgent', agentId], ['listRuns', agentId, {}],
  ]);

  client.failCreateAgent = null;
  client.notFoundAgent = false;
  client.notFoundRuns = false;
  const retry = await handleToolCall('agents', args, service);
  assert.equal(retry.structuredContent.ok, true);
  assert.equal(retry.structuredContent.receipt.duplicate, false);
  const newRequestAfterReconcile = await handleToolCall('agents', {
    ...args, requestId: 'reconcile-create-2',
  }, service);
  assert.equal(newRequestAfterReconcile.structuredContent.ok, true);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 3);
});

test('one provider 404 is not enough to release an uncertain create reservation', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'upstream_failure';
  const args = {
    action: 'create', requestId: 'reconcile-create-3', agentId,
    prompt: { text: 'confirm both provider paths' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');

  client.notFoundAgent = true;
  const incomplete = await handleToolCall('agents', {
    action: 'reconcile', requestId: args.requestId,
  }, service);
  assert.equal(incomplete.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');
  assert.deepEqual(client.calls.slice(-4), [
    ['getAgent', agentId], ['listRuns', agentId, {}],
    ['getAgent', agentId], ['listRuns', agentId, {}],
  ]);
});

test('reconciliation of a provider-visible agent finalizes completed without resubmitting', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'upstream_failure';
  const args = {
    action: 'create', requestId: 'reconcile-create-4', agentId,
    prompt: { text: 'agent may already exist' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  client.failCreateAgent = null;

  const reconciled = await handleToolCall('agents', {
    action: 'reconcile', requestId: args.requestId,
  }, service);
  assert.equal(reconciled.structuredContent.ok, true);
  assert.equal(reconciled.structuredContent.provider.agent, 'found');
  assert.equal(reconciled.structuredContent.status, 'completed');
  assert.equal(reconciled.structuredContent.runId, runId);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
  const duplicate = await handleToolCall('agents', args, service);
  assert.equal(duplicate.structuredContent.ok, true);
  assert.equal(duplicate.structuredContent.receipt.duplicate, true);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('agent reconciliation rejects a mismatched provider object without releasing', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'upstream_failure';
  const args = {
    action: 'create', requestId: 'reconcile-agent-identity-mismatch-1', agentId,
    prompt: { text: 'reconcile one exact agent' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  client.getAgent = async (requestedAgentId) => {
    client.calls.push(['getAgent', requestedAgentId]);
    return { id: otherAgentId, latestRunId: runId };
  };
  const mismatch = await handleToolCall('agents', { action: 'reconcile', requestId: args.requestId }, service);
  assert.equal(mismatch.structuredContent.error.code, 'uncertain_submission');
  const record = await service.ledger.lookup(args.requestId);
  assert.equal(record.status, 'uncertain');
  assert.equal(mismatch.structuredContent.error.details.providerReturnedAgentId, otherAgentId);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('reconciliation retries a transient pair of 404s before releasing or completing', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failCreateAgent = 'upstream_failure';
  const args = {
    action: 'create', requestId: 'reconcile-create-5', agentId,
    prompt: { text: 'wait through eventual consistency' },
  };
  const first = await handleToolCall('agents', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');

  let lookups = 0;
  client.getAgent = async (id) => {
    client.calls.push(['getAgent', id]);
    lookups += 1;
    if (lookups === 1) throw new CursorApiError('not_found', 'Cursor API returned HTTP 404.', { status: 404 });
    return { id, latestRunId: runId };
  };
  const reconciled = await handleToolCall('agents', { action: 'reconcile', requestId: args.requestId }, service);
  assert.equal(reconciled.structuredContent.ok, true);
  assert.equal(reconciled.structuredContent.provider.agent, 'found');
  assert.equal(lookups, 2);
  assert.deepEqual(client.calls.slice(-3), [
    ['getAgent', agentId], ['listRuns', agentId, {}], ['getAgent', agentId],
  ]);
  assert.equal(client.calls.filter((call) => call[0] === 'createAgent').length, 1);
});

test('agent reconciliation rejects follow-up reservations instead of binding a caller target', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failFollowup = true;
  const followup = await handleToolCall('runs', {
    action: 'followup', requestId: 'reconcile-followup-1', agentId, prompt: { text: 'continue once' },
  }, service);
  assert.equal(followup.structuredContent.error.code, 'uncertain_submission');
  const result = await handleToolCall('agents', {
    action: 'reconcile', requestId: 'reconcile-followup-1', agentId,
  }, service);
  assert.equal(result.structuredContent.error.code, 'reconciliation_not_supported');
  assert.equal(client.calls.filter((call) => call[0] === 'getAgent').length, 0);
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

test('changed create intent conflicts after a provider-assigned create', async (context) => {
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

test('follow-up success without a provider run ID remains uncertain for every incomplete response shape', async (context) => {
  const { client, service } = await serviceFixture(context);
  const responses = [{}, { run: {} }, { run: { status: 'CREATING' } }];
  const agentTargets = [agentId, 'bc-00000000-0000-0000-0000-000000000002', 'bc-00000000-0000-0000-0000-000000000003'];
  let responseIndex = 0;
  client.createRun = async (agent, body) => {
    client.calls.push(['createRun', agent, body]);
    return responses[responseIndex++];
  };

  for (let index = 0; index < responses.length; index += 1) {
    const requestId = `followup-empty-response-${index + 1}`;
    const result = await handleToolCall('runs', {
      action: 'followup', requestId, agentId: agentTargets[index], prompt: { text: `missing run ${index}` },
    }, service);
    assert.equal(result.structuredContent.error.code, 'uncertain_submission');
    assert.equal((await service.ledger.lookup(requestId)).status, 'uncertain');
  }
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, responses.length);
});

test('uncertain follow-up can be reconciled by an observed run or explicitly released without resubmission', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failFollowup = true;
  const args = { action: 'followup', requestId: 'followup-reconcile-1', agentId, prompt: { text: 'continue once' } };
  const first = await handleToolCall('runs', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  const reconciled = await handleToolCall('runs', { action: 'reconcile', requestId: args.requestId, agentId, runId }, service);
  assert.equal(reconciled.structuredContent.ok, true);
  assert.equal(reconciled.structuredContent.provider.state, 'found');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'completed');
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, 1);

  client.failFollowup = true;
  const releaseArgs = { action: 'followup', requestId: 'followup-release-1', agentId, prompt: { text: 'release me' } };
  await handleToolCall('runs', releaseArgs, service);
  const released = await handleToolCall('runs', {
    action: 'reconcile', requestId: releaseArgs.requestId, release: true, confirmation: `release:${releaseArgs.requestId}`,
  }, service);
  assert.equal(released.structuredContent.ok, true);
  assert.equal(released.structuredContent.provider.reservation, 'released');
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, 2);
});

test('follow-up does not finalize a provider run returned for a different agent', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.createRun = async (requestedAgentId, body) => {
    client.calls.push(['createRun', requestedAgentId, body]);
    return { run: { id: runId, agentId: otherAgentId, status: 'CREATING' } };
  };
  const args = { action: 'followup', requestId: 'followup-provider-identity-mismatch-1', agentId, prompt: { text: 'exact agent only' } };
  const result = await handleToolCall('runs', args, service);
  assert.equal(result.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, 1);
});

test('follow-up reconciliation rejects a mismatched run object without releasing', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failFollowup = true;
  const args = { action: 'followup', requestId: 'followup-reconcile-identity-mismatch-1', agentId, prompt: { text: 'reconcile one exact run' } };
  const first = await handleToolCall('runs', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');
  client.getRun = async (requestedAgentId, requestedRunId) => {
    client.calls.push(['getRun', requestedAgentId, requestedRunId]);
    return { id: requestedRunId, agentId: otherAgentId, status: 'FINISHED' };
  };
  const mismatch = await handleToolCall('runs', { action: 'reconcile', requestId: args.requestId, agentId, runId }, service);
  assert.equal(mismatch.structuredContent.error.code, 'uncertain_submission');
  const record = await service.ledger.lookup(args.requestId);
  assert.equal(record.status, 'uncertain');
  assert.equal(mismatch.structuredContent.error.details.providerReturnedRunAgentId, otherAgentId);
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, 1);
});

test('follow-up reconciliation requires repeated exact 404s before releasing', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.failFollowup = true;
  const args = { action: 'followup', requestId: 'followup-reconcile-404-confirmation-1', agentId, prompt: { text: 'confirm one exact run absence' } };
  const first = await handleToolCall('runs', args, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');

  let lookups = 0;
  client.getRun = async (requestedAgentId, requestedRunId) => {
    client.calls.push(['getRun', requestedAgentId, requestedRunId]);
    lookups += 1;
    throw new CursorApiError('not_found', 'missing run', { status: 404 });
  };
  const oneMiss = await handleToolCall('runs', {
    action: 'reconcile', requestId: args.requestId, agentId, runId,
  }, service);
  assert.equal(oneMiss.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');
  assert.equal((await service.ledger.lookup(args.requestId)).providerNotFoundConfirmations, 1);
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, 1);

  const confirmed = await handleToolCall('runs', {
    action: 'reconcile', requestId: args.requestId, agentId, runId,
  }, service);
  assert.equal(confirmed.structuredContent.ok, true);
  assert.equal(confirmed.structuredContent.provider.reservation, 'released');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'failed');
  assert.equal(lookups, 2);
  assert.equal(client.calls.filter((call) => call[0] === 'createRun').length, 1);
});

test('uncertain cancellation requires a terminal cancelled provider run and safely releases on exact 404', async (context) => {
  const { client, service } = await serviceFixture(context);
  const cancelRequest = { action: 'cancel', requestId: 'cancel-reconcile-status-1', agentId, runId };
  client.cancelRun = async (id, run) => {
    client.calls.push(['cancelRun', id, run]);
    throw new CursorApiError('network_error', 'response lost', { ambiguous: true });
  };
  const first = await handleToolCall('runs', cancelRequest, service);
  assert.equal(first.structuredContent.error.code, 'uncertain_submission');

  client.getRun = async (id, run) => {
    client.calls.push(['getRun', id, run]);
    return { id: run, agentId: otherAgentId, status: 'CANCELED' };
  };
  const mismatched = await handleToolCall('runs', { action: 'reconcile', requestId: cancelRequest.requestId, agentId, runId }, service);
  assert.equal(mismatched.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(cancelRequest.requestId)).status, 'uncertain');

  client.getRun = async (id, run) => {
    client.calls.push(['getRun', id, run]);
    return { id: run, agentId: id, status: 'RUNNING' };
  };
  const stillRunning = await handleToolCall('runs', { action: 'reconcile', requestId: cancelRequest.requestId, agentId, runId }, service);
  assert.equal(stillRunning.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(cancelRequest.requestId)).status, 'uncertain');

  client.getRun = async (id, run) => {
    client.calls.push(['getRun', id, run]);
    return { id: run, agentId: id, status: 'CANCELED' };
  };
  const canceled = await handleToolCall('runs', { action: 'reconcile', requestId: cancelRequest.requestId, agentId, runId }, service);
  assert.equal(canceled.structuredContent.ok, true);
  assert.equal(canceled.structuredContent.provider.reservation, 'completed');
  assert.equal((await service.ledger.lookup(cancelRequest.requestId)).status, 'completed');
  assert.equal(client.calls.filter((call) => call[0] === 'cancelRun').length, 1);

  const missingRequest = { action: 'cancel', requestId: 'cancel-reconcile-404-1', agentId, runId: 'run-00000000-0000-0000-0000-000000000002' };
  const secondCancel = await handleToolCall('runs', missingRequest, service);
  assert.equal(secondCancel.structuredContent.error.code, 'uncertain_submission');
  client.getRun = async (id, run) => {
    client.calls.push(['getRun', id, run]);
    throw new CursorApiError('not_found', 'missing run', { status: 404 });
  };
  const oneMiss = await handleToolCall('runs', { action: 'reconcile', requestId: missingRequest.requestId, agentId, runId: missingRequest.runId }, service);
  assert.equal(oneMiss.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(missingRequest.requestId)).status, 'uncertain');
  const released = await handleToolCall('runs', { action: 'reconcile', requestId: missingRequest.requestId, agentId, runId: missingRequest.runId }, service);
  assert.equal(released.structuredContent.ok, true);
  assert.equal(released.structuredContent.provider.reservation, 'released');
  assert.equal((await service.ledger.lookup(missingRequest.requestId)).providerAgentId, agentId);
});

test('cancel does not finalize a mismatched provider acknowledgement', async (context) => {
  const { client, service } = await serviceFixture(context);
  client.cancelRun = async (requestedAgentId, requestedRunId) => {
    client.calls.push(['cancelRun', requestedAgentId, requestedRunId]);
    return { id: otherRunId, agentId: otherAgentId };
  };
  const args = { action: 'cancel', requestId: 'cancel-provider-identity-mismatch-1', agentId, runId };
  const result = await handleToolCall('runs', args, service);
  assert.equal(result.structuredContent.error.code, 'uncertain_submission');
  assert.equal((await service.ledger.lookup(args.requestId)).status, 'uncertain');
  assert.equal(client.calls.filter((call) => call[0] === 'cancelRun').length, 1);
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

test('runs.wait forwards each remaining deadline to provider reads', async (context) => {
  const { client, service } = await serviceFixture(context);
  const timeouts = [];
  let reads = 0;
  client.getRun = async (id, run, options) => {
    client.calls.push(['getRun', id, run, options]);
    timeouts.push(options?.timeoutMs);
    reads += 1;
    return reads > 1 ? { id: run, status: 'FINISHED' } : { id: run, status: 'CREATING' };
  };
  const result = await handleToolCall('runs', { action: 'wait', agentId, runId, timeoutMs: 600, pollMs: 250 }, service);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.timedOut, false);
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[0] <= 600 && timeouts[0] > 0);
  assert.ok(timeouts[1] <= timeouts[0] && timeouts[1] > 0);
});

test('runs.wait converts provider request timeouts into bounded timedOut receipts with the latest run', async (context) => {
  const { client, service } = await serviceFixture(context);
  let reads = 0;
  client.getRun = async (id, run, options) => {
    client.calls.push(['getRun', id, run, options]);
    reads += 1;
    if (reads === 1) return { id: run, status: 'CREATING', progress: 'partial' };
    throw new CursorApiError('request_timeout', 'provider read exceeded its remaining bound', {
      details: { partial: { id: run, status: 'CREATING', progress: 'latest' } },
    });
  };
  const result = await handleToolCall('runs', { action: 'wait', agentId, runId, timeoutMs: 600, pollMs: 250 }, service);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.timedOut, true);
  assert.deepEqual(result.structuredContent.run, { id: runId, status: 'CREATING', progress: 'latest' });
  assert.equal(reads, 2);
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
