import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  GROK_BILLING_METHOD,
  GROK_CAPACITY_SAFE_CWD,
  GROK_SESSION_USAGE_METHOD,
  GrokCapacityError,
  normalizeGrokBilling,
  normalizeGrokSessionUsage,
  readGrokCapacity,
} from '../mcp/grok-capacity.mjs';
import { buildAllowlistedEnvironment } from '../mcp/bounded-jsonl-rpc.mjs';

function now() {
  return Date.parse('2026-08-17T12:00:10.000Z');
}

function fakeChild(handler) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.requests = [];
  child.stopped = [];
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const request = JSON.parse(chunk.toString());
      child.requests.push(request);
      Promise.resolve(handler(request, { child })).then((response) => {
        if (response !== undefined) child.stdout.write(`${JSON.stringify(response)}\n`);
        callback();
      }, callback);
    },
  });
  child.kill = (signal) => {
    child.stopped.push(signal);
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
}

function fakeSpawn(handler, capture = {}) {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    capture.child = fakeChild(handler);
    return capture.child;
  };
}

test('billing normalization prefers credits fields, keeps unknowns, and bounds history', () => {
  const value = normalizeGrokBilling({
    config: {
      creditUsagePercent: 42.5,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-10T00:00:00Z',
        end: '2026-08-17T00:00:00Z',
      },
      onDemandCap: { val: 5000 },
      onDemandUsed: { val: 300 },
      prepaidBalance: { val: 1250 },
      isUnifiedBillingUser: true,
      history: Array.from({ length: 300 }, () => ({ totalUsed: { val: 1 } })),
      productUsage: [{ product: 'PRODUCT_GROK_BUILD', usagePercent: 61.2 }],
    },
    onDemandEnabled: true,
    subscriptionTier: 'SuperGrok Heavy',
  }, { now });

  assert.deepEqual(value, {
    provider: 'grok',
    auth_surface: 'grok_build_oauth',
    usage_percent: 42.5,
    remaining_percent: 57.5,
    subscription_tier: 'SuperGrok Heavy',
    period: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-10T00:00:00Z',
      end: '2026-08-17T00:00:00Z',
    },
    on_demand: { enabled: true, cap_cents: 5000, used_cents: 300 },
    prepaid_balance_cents: 1250,
    unified_billing: true,
    history_count: 300,
    history_truncated: true,
    provenance: {
      source: 'grok_build_acp',
      transport: 'acp_stdio',
      method: GROK_BILLING_METHOD,
      observed_at: '2026-08-17T12:00:10.000Z',
      freshness_seconds: 0,
    },
  });
});

test('billing normalization derives legacy percentage but rejects malformed values', () => {
  const legacy = normalizeGrokBilling({
    config: {
      monthlyLimit: { val: 2000 },
      used: { val: 500 },
      billingPeriodStart: '2026-08-01T00:00:00Z',
      billingPeriodEnd: '2026-09-01T00:00:00Z',
      onDemandCap: { val: 'not-cents' },
      prepaidBalance: { val: -10 },
      currentPeriod: { type: 'bad\u0000period', start: 'not-a-date' },
    },
    onDemandEnabled: 'yes',
  }, { now });

  assert.equal(legacy.usage_percent, 25);
  assert.equal(legacy.remaining_percent, 75);
  assert.deepEqual(legacy.period, {
    type: null,
    start: '2026-08-01T00:00:00Z',
    end: '2026-09-01T00:00:00Z',
  });
  assert.deepEqual(legacy.on_demand, { enabled: null, cap_cents: null, used_cents: null });
  assert.equal(legacy.prepaid_balance_cents, null);
  assert.equal(legacy.provenance.observed_at, '2026-08-17T12:00:10.000Z');
  assert.equal(legacy.provenance.freshness_seconds, 0);
});

test('session usage normalization preserves tokens and marks partial cost unknown', () => {
  const value = normalizeGrokSessionUsage({
    usage: {
      inputTokens: 812,
      outputTokens: 45,
      reasoningTokens: 12,
      cachedInputTokens: 100,
      totalTokens: 857,
      numTurns: 7,
      costUsdTicks: 158500,
      costIsPartial: true,
      modelUsage: {
        'grok-4.6': { inputTokens: 812, outputTokens: 45 },
      },
    },
  }, { now });

  assert.equal(value.input_tokens, 812);
  assert.equal(value.output_tokens, 45);
  assert.equal(value.reasoning_tokens, 12);
  assert.equal(value.total_tokens, 857);
  assert.equal(value.num_turns, 7);
  assert.equal(value.cost_usd_ticks, null);
  assert.equal(value.cost_usd, null);
  assert.equal(value.cost_is_partial, true);
  assert.equal(value.model_usage['grok-4.6'].input_tokens, 812);
  assert.equal(Object.getPrototypeOf(value.model_usage), null);
  assert.equal(value.usage_is_incomplete, null);
  assert.equal(value.provenance.method, GROK_SESSION_USAGE_METHOD);
});

test('session cost is exact only when costIsPartial is explicitly false', () => {
  const value = normalizeGrokSessionUsage({
    usage: {
      costUsdTicks: 20_000_000,
      costIsPartial: null,
      usageIsIncomplete: true,
    },
  }, { now });
  assert.equal(value.cost_usd_ticks, null);
  assert.equal(value.cost_usd, null);
  assert.equal(value.usage_is_incomplete, true);
});

test('accepts omitted authMethods but rejects a present non-array', async () => {
  const spawnProcess = fakeSpawn((request) => {
    if (request.method === 'initialize') {
      return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } };
    }
    if (request.method === GROK_BILLING_METHOD) {
      return { jsonrpc: '2.0', id: request.id, result: { config: { creditUsagePercent: 12 } } };
    }
    throw new Error(`unexpected method ${request.method}`);
  });

  const value = await readGrokCapacity({ spawn_process: spawnProcess, now });
  assert.equal(value.usage_percent, 12);

  const malformed = fakeSpawn((request) => {
    if (request.method === 'initialize') {
      return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, authMethods: null } };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  await assert.rejects(
    readGrokCapacity({ spawn_process: malformed, now }),
    (error) => error instanceof GrokCapacityError && error.code === 'protocol_error',
  );
});

test('keeps capacity environment provider-specific', () => {
  const source = {
    PATH: '/bin',
    HOME: '/home/test',
    CODEX_HOME: '/home/test/.codex',
    XDG_CONFIG_HOME: '/home/test/.config',
    XDG_DATA_HOME: '/home/test/.local/share',
    XDG_STATE_HOME: '/home/test/.local/state',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XAI_API_KEY: 'xai-test',
    MODEL_API_KEY: 'model-secret',
    OPENAI_API_KEY: 'openai-secret',
    CURSOR_API_KEY: 'cursor-secret',
    GH_TOKEN: 'github-secret',
  };
  const grok = buildAllowlistedEnvironment('grok', source);
  assert.equal(grok.CODEX_HOME, undefined);
  assert.equal(grok.XAI_API_KEY, 'xai-test');
  assert.equal(grok.MODEL_API_KEY, undefined);
  assert.equal(grok.OPENAI_API_KEY, undefined);
  assert.equal(grok.CURSOR_API_KEY, undefined);
  assert.equal(grok.GH_TOKEN, undefined);
  assert.equal(grok.XDG_CONFIG_HOME, source.XDG_CONFIG_HOME);
  assert.equal(grok.XDG_RUNTIME_DIR, source.XDG_RUNTIME_DIR);

  const codex = buildAllowlistedEnvironment('codex', source);
  assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
  assert.equal(codex.XAI_API_KEY, undefined);
  assert.equal(codex.MODEL_API_KEY, undefined);
  assert.equal(codex.OPENAI_API_KEY, undefined);
  assert.equal(codex.CURSOR_API_KEY, undefined);
  assert.equal(codex.GH_TOKEN, undefined);
});

test('readGrokCapacity uses only bounded ACP requests and optional session telemetry', async () => {
  const capture = {};
  const spawnProcess = fakeSpawn((request) => {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] },
      };
    }
    if (request.method === 'authenticate') {
      return { jsonrpc: '2.0', id: request.id, result: {} };
    }
    if (request.method === GROK_BILLING_METHOD) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          config: { creditUsagePercent: 10, currentPeriod: { type: 'WEEKLY' } },
          onDemandEnabled: false,
          subscriptionTier: 'SuperGrok',
        },
      };
    }
    if (request.method === GROK_SESSION_USAGE_METHOD) {
      assert.deepEqual(request.params, { sessionId: 'session-123' });
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { usage: {
          inputTokens: 10,
          outputTokens: 2,
          costUsdTicks: 20_000_000,
          costIsPartial: false,
          usageIsIncomplete: false,
        } },
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  }, capture);

  const value = await readGrokCapacity({
    command: '/fake/grok',
    cwd: '/tmp/safe-target',
    session_id: 'session-123',
    include_session_usage: true,
    now,
    spawn_process: spawnProcess,
  });

  assert.equal(capture.command, '/fake/grok');
  assert.deepEqual(capture.args, ['agent', 'stdio']);
  assert.deepEqual(capture.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(capture.options.detached, true);
  assert.equal(capture.options.env.MODEL_API_KEY, undefined);
  assert.equal(capture.options.env.CURSOR_API_KEY, undefined);
  assert.equal(capture.options.env.XAI_API_KEY, process.env.XAI_API_KEY ?? undefined);
  assert.deepEqual(capture.child.requests.map((request) => request.method), [
    'initialize', 'authenticate', GROK_BILLING_METHOD, GROK_SESSION_USAGE_METHOD,
  ]);
  assert.equal(capture.child.requests.some((request) => request.method === 'session/prompt'), false);
  assert.equal(value.remaining_percent, 90);
  assert.equal(value.session_usage_status, 'available');
  assert.equal(value.session_usage.cost_usd, 0.002);
  assert.deepEqual(capture.child.stopped, ['SIGTERM']);
});

test('readGrokCapacity never inherits a repository cwd by default', async () => {
  const capture = {};
  const spawnProcess = fakeSpawn((request) => {
    if (request.method === 'initialize') {
      return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } };
    }
    if (request.method === GROK_BILLING_METHOD) {
      return { jsonrpc: '2.0', id: request.id, result: { config: { creditUsagePercent: 1 } } };
    }
    throw new Error(`unexpected method ${request.method}`);
  }, capture);

  await readGrokCapacity({ spawn_process: spawnProcess, now });
  assert.equal(capture.options.cwd, GROK_CAPACITY_SAFE_CWD);
  assert.notEqual(capture.options.cwd, process.cwd());
});

test('optional session usage failure does not discard a valid billing snapshot', async () => {
  const spawnProcess = fakeSpawn((request) => {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: 1, authMethods: [] },
      };
    }
    if (request.method === GROK_BILLING_METHOD) {
      return { jsonrpc: '2.0', id: request.id, result: { config: { creditUsagePercent: 20 } } };
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'method unavailable with private detail' },
    };
  });

  const value = await readGrokCapacity({
    include_session_usage: true,
    session_id: 'session-123',
    spawn_process: spawnProcess,
    now,
  });
  assert.equal(value.usage_percent, 20);
  assert.equal(value.session_usage, null);
  assert.equal(value.session_usage_status, 'unavailable');
});

test('marks session usage partial until both completion markers are explicit', async () => {
  const cases = [
    { usageIsIncomplete: true, costIsPartial: false },
    { usageIsIncomplete: false, costIsPartial: true },
    { usageIsIncomplete: false },
    { costIsPartial: false },
  ];

  for (const usage of cases) {
    const spawnProcess = fakeSpawn((request) => {
      if (request.method === 'initialize') {
        return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } };
      }
      if (request.method === GROK_BILLING_METHOD) {
        return { jsonrpc: '2.0', id: request.id, result: { config: { creditUsagePercent: 20 } } };
      }
      if (request.method === GROK_SESSION_USAGE_METHOD) {
        return { jsonrpc: '2.0', id: request.id, result: { usage } };
      }
      throw new Error(`unexpected method ${request.method}`);
    });
    const value = await readGrokCapacity({
      include_session_usage: true,
      session_id: 'session-123',
      spawn_process: spawnProcess,
      now,
    });
    assert.equal(value.session_usage_status, 'partial');
  }
});

test('rejects malformed billing results and invalid negotiated JSON-RPC envelopes', async () => {
  const malformedBilling = fakeSpawn((request) => {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: 1, authMethods: [] },
      };
    }
    return { jsonrpc: '2.0', id: request.id, result: { config: null } };
  });
  await assert.rejects(
    readGrokCapacity({ spawn_process: malformedBilling, now }),
    (error) => error instanceof GrokCapacityError && error.code === 'protocol_error',
  );

  const wrongEnvelope = fakeSpawn((request) => ({
    jsonrpc: '1.0',
    id: request.id,
    result: { protocolVersion: 1, authMethods: [] },
  }));
  await assert.rejects(
    readGrokCapacity({ spawn_process: wrongEnvelope, now }),
    (error) => error instanceof GrokCapacityError && error.code === 'protocol_error',
  );

  const responseWithMethod = fakeSpawn((request) => ({
    jsonrpc: '2.0',
    id: request.id,
    method: 'unexpected-response-method',
    result: { protocolVersion: 1, authMethods: [] },
  }));
  await assert.rejects(
    readGrokCapacity({ spawn_process: responseWithMethod, now }),
    (error) => error instanceof GrokCapacityError && error.code === 'protocol_error',
  );

  const notificationWithResult = fakeSpawn(() => ({
    jsonrpc: '2.0',
    method: 'unexpected-notification-result',
    result: { protocolVersion: 1, authMethods: [] },
  }));
  await assert.rejects(
    readGrokCapacity({ spawn_process: notificationWithResult, now }),
    (error) => error instanceof GrokCapacityError && error.code === 'protocol_error',
  );
});

test('surfaces asynchronous stderr and stdin failures as bounded errors', async () => {
  const stderrFailure = fakeSpawn((request, capture) => {
    if (request.method === 'initialize') queueMicrotask(() => capture.child.stderr.emit('error', new Error('private stderr')));
  });
  await assert.rejects(
    readGrokCapacity({ spawn_process: stderrFailure, now }),
    (error) => error instanceof GrokCapacityError && error.code === 'stderr_error',
  );

  const stdinFailure = fakeSpawn((request, capture) => {
    if (request.method === 'initialize') queueMicrotask(() => capture.child.stdin.emit('error', new Error('private stdin')));
  });
  await assert.rejects(
    readGrokCapacity({ spawn_process: stdinFailure, now }),
    (error) => error instanceof GrokCapacityError && error.code === 'stdin_error',
  );
});

test('capacity helper fails closed on bounded output and wall-clock timeout', async () => {
  const noisySpawn = fakeSpawn((request) => {
    if (request.method !== 'initialize') return undefined;
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {},
      ignored: 'x'.repeat(2048),
    };
  });
  await assert.rejects(
    readGrokCapacity({ spawn_process: noisySpawn, max_output_bytes: 1024 }),
    (error) => error instanceof GrokCapacityError && error.code === 'output_limit',
  );

  const silentSpawn = fakeSpawn(() => undefined);
  await assert.rejects(
    readGrokCapacity({ spawn_process: silentSpawn, timeout_ms: 100 }),
    (error) => error instanceof GrokCapacityError && error.code === 'timeout',
  );
});
