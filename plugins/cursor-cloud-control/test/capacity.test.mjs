import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAgentUsage,
  normalizeTokenUsage,
  parseRateLimitHeaders,
  PERSONAL_CAPACITY_UNAVAILABLE_REASON,
  providerErrorCode,
  retryAfterDelayMs,
} from '../mcp/capacity.mjs';
import { CursorApiClient } from '../mcp/client.mjs';

const agentId = 'bc-00000000-0000-0000-0000-000000000001';
const runId = 'run-00000000-0000-0000-0000-000000000001';

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('normalizes measured tokens without inventing personal allowance or reset data', () => {
  const normalized = normalizeAgentUsage({
    totalUsage: {
      inputTokens: 12,
      outputTokens: 8,
      cacheWriteTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 27,
    },
    runs: [{ id: runId, usageUuid: 'usage-1', usage: {
      inputTokens: 12,
      outputTokens: 8,
      cacheWriteTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 27,
    } }],
  }, { observedAt: '2026-08-17T00:00:00.000Z' });

  assert.deepEqual(normalized.totalUsage, {
    inputTokens: 12,
    outputTokens: 8,
    cacheWriteTokens: 3,
    cacheReadTokens: 4,
    totalTokens: 27,
  });
  assert.equal(normalized.runs[0].usage.outputTokens, 8);
  assert.deepEqual(normalized.capacity, {
    scope: 'agent',
    status: 'measured',
    source: 'cloud_agent_usage',
    observedAt: '2026-08-17T00:00:00.000Z',
    used: normalized.totalUsage,
    account: {
      plan: null,
      remaining: null,
      resetAt: null,
      source: PERSONAL_CAPACITY_UNAVAILABLE_REASON,
    },
  });
  assert.equal('rateWindow' in normalized.capacity, false);
});

test('rate-limit parser returns only observed documented headers', () => {
  assert.equal(parseRateLimitHeaders(new Headers()), null);
  assert.deepEqual(parseRateLimitHeaders(new Headers({
    'X-RateLimit-Limit': '60',
    'X-RateLimit-Remaining': '59',
    'X-RateLimit-Reset': '1787000100',
    'Retry-After': '2',
  })), {
    source: 'response_headers',
    limit: 60,
    remaining: 59,
    reset: '1787000100',
    retryAfter: 2,
  });
  assert.deepEqual(parseRateLimitHeaders(new Headers({
    'X-RateLimit-Limit': 'x'.repeat(129),
  })), null);
});

test('provider error code extraction is bounded and accepts Cursor error envelopes', () => {
  assert.equal(providerErrorCode('{"error":{"code":"usage_limit_exceeded","message":"nope"}}'), 'usage_limit_exceeded');
  assert.equal(providerErrorCode('{"code":"rate_limit_exceeded"}'), 'rate_limit_exceeded');
  assert.equal(providerErrorCode('{"error":{"code":"not safe; expose me"}}'), undefined);
  assert.equal(providerErrorCode('not json'), undefined);
});

test('Retry-After accepts delay-seconds and HTTP-date values', () => {
  assert.equal(retryAfterDelayMs('2', 1_700_000_000_000), 2_000);
  assert.equal(retryAfterDelayMs('2.5', 1_700_000_000_000), 2_500);
  assert.equal(retryAfterDelayMs('Tue, 14 Nov 2023 22:13:22 GMT', 1_700_000_000_000), 2_000);
  assert.equal(retryAfterDelayMs('Tue, 14 Nov 2023 22:13:18 GMT', 1_700_000_000_000), 0);
  assert.equal(retryAfterDelayMs('not-a-retry-delay', 1_700_000_000_000), undefined);
});

test('client adds compact usage capacity and includes rate-window fields only when supplied', async () => {
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    origin: 'https://api.example.test',
    fetchImpl: async (url) => {
      assert.equal(String(url), `https://api.example.test/v1/agents/${agentId}/usage?runId=${runId}`);
      return jsonResponse({
        totalUsage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 2, totalTokens: 17 },
        runs: [{ id: runId, usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 2, totalTokens: 17 } }],
      }, { headers: {
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': '58',
        'X-RateLimit-Reset': '1787000100',
      } });
    },
  });

  const usage = await client.usage(agentId, runId);
  assert.equal(usage.capacity.scope, 'run');
  assert.equal(usage.capacity.used.totalTokens, 17);
  assert.deepEqual(usage.capacity.rateWindow, {
    source: 'response_headers',
    limit: 60,
    remaining: 58,
    reset: '1787000100',
  });
});

test('client captures provider code and rate-window fields without retrying exhausted usage', async () => {
  let calls = 0;
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    origin: 'https://api.example.test',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { code: 'usage_limit_exceeded', message: 'limit reached' } }, {
        status: 429,
        headers: {
          'Retry-After': '30',
          'X-RateLimit-Limit': '60',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1787000100',
        },
      });
    },
  });

  await assert.rejects(client.usage(agentId), (error) => {
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.providerCode, 'usage_limit_exceeded');
    assert.equal(error.retryable, false);
    assert.deepEqual(error.rateWindow, {
      source: 'response_headers',
      limit: 60,
      remaining: 0,
      reset: '1787000100',
      retryAfter: 30,
    });
    assert.deepEqual(error.details, {
      providerCode: 'usage_limit_exceeded',
      rateWindow: error.rateWindow,
    });
    return true;
  });
  assert.equal(calls, 1);
});

test('usage normalization rejects malformed shapes instead of fabricating measured zero', () => {
  assert.throws(() => normalizeAgentUsage([]), (error) => error.details.path === 'response');
  assert.throws(() => normalizeTokenUsage({ inputTokens: -1 }), (error) => {
    assert.equal(error.code, 'invalid_usage_response');
    assert.deepEqual(error.details, { path: 'usage.inputTokens', reason: 'required_non_negative_integer' });
    return true;
  });
  assert.throws(() => normalizeAgentUsage({ totalUsage: {}, runs: [] }), (error) => error.code === 'invalid_usage_response');
  assert.throws(() => normalizeTokenUsage({ inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 }), (error) => {
    assert.equal(error.details.reason, 'must_equal_counter_sum');
    return true;
  });
  assert.throws(() => normalizeAgentUsage({ totalUsage: {
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0,
  }, runs: [{ id: runId, usage: {
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
  } }] }), (error) => error.code === 'invalid_usage_response');
});

test('run-scoped usage requires exactly the requested run', () => {
  const counters = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  assert.throws(() => normalizeAgentUsage({ totalUsage: counters, runs: [{ id: 'run-other', usage: counters }] }, {
    scope: 'run', requestedRunId: runId,
  }), (error) => error.details.reason === 'requested_run_mismatch');
  assert.throws(() => normalizeAgentUsage({ totalUsage: counters, runs: [] }, { scope: 'run' }), (error) => error.details.reason === 'required_for_run_scope');
});

test('agent totals and run-scoped totals must match returned run usage', () => {
  const zero = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  const one = { inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 1 };
  assert.throws(() => normalizeAgentUsage({ totalUsage: one, runs: [{ id: runId, usage: zero }] }), (error) => error.details.reason === 'must_equal_run_sum');
  assert.throws(() => normalizeAgentUsage({ totalUsage: zero, runs: [{ id: runId, usage: one }] }, {
    scope: 'run', requestedRunId: runId,
  }), (error) => error.details.reason === 'must_equal_run_sum');
});

test('usage aggregation fails closed on safe-integer overflow', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const usage = { inputTokens: max, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: max };
  assert.throws(() => normalizeAgentUsage({
    totalUsage: usage,
    runs: [{ id: 'run-one', usage }, { id: 'run-two', usage }],
  }), (error) => {
    assert.equal(error.details.path, 'runs[1].usage.inputTokens');
    assert.equal(error.details.reason, 'sum_overflow');
    return true;
  });
});

test('provider error messages redact API secrets before model-visible errors', async () => {
  const secret = 'unit-secret-value';
  let calls = 0;
  const client = new CursorApiClient({
    apiKey: secret,
    origin: 'https://api.example.test',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { code: 'rate_limit_exceeded', message: `Bearer ${secret}` } }, {
        status: 429,
        headers: { 'Retry-After': '3600' },
      });
    },
    requestTimeoutMs: 250,
  });
  await assert.rejects(client.usage(agentId), (error) => {
    assert.equal(error.providerCode, 'rate_limit_exceeded');
    assert.equal(error.details.rateWindow.retryAfter, 3600);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(calls, 1, 'an unfit Retry-After must not trigger an immediate retry');
});
