import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CapacityError,
  createCapacityReader,
} from '../mcp/capacity.mjs';

const start = Date.parse('2026-08-17T00:00:00.000Z');

function codex(now, used = 10) {
  return {
    status: 'ok',
    observedAt: new Date(now).toISOString(),
    rateLimits: { snapshot: { usedPercent: used, remainingPercent: 100 - used } },
    usage: {
      summary: { lifetimeTokens: 42 },
      dailyUsageBuckets: [{ startDate: '2026-08-17', tokens: 1 }],
      dailyUsageBucketsObservedCount: 99,
      dailyUsageBucketsTruncated: true,
    },
  };
}

function grok(now, remaining = 80) {
  return {
    usage_percent: 100 - remaining,
    remaining_percent: remaining,
    provenance: { observed_at: new Date(now).toISOString() },
  };
}

test('reads selected providers in parallel and returns compact version-one entries', async () => {
  let now = start;
  const started = [];
  const reader = createCapacityReader({
    now: () => now,
    readCodex: async () => { started.push('codex'); return codex(now); },
    readGrok: async (options) => {
      started.push(`grok:${options.session_id}`);
      return grok(now);
    },
  });
  const result = await reader({
    providers: ['grok', 'codex'],
    grok_session_id: 'opaque-session',
    include_usage: true,
  });
  assert.equal(result.version, 1);
  assert.deepEqual(result.providers.map(({ provider }) => provider), ['grok', 'codex']);
  assert.deepEqual(started.sort(), ['codex', 'grok:opaque-session']);
  assert.equal(result.providers[0].status, 'available');
  assert.equal(result.providers[0].source, 'grok_build_acp');
  assert.equal(result.providers[0].scope, 'account');
  assert.equal(result.providers[0].capacity.remaining_percent, 80);
  assert.equal(result.providers[1].usage.lifetime_tokens, 42);
  assert.equal(result.providers[1].usage.daily_bucket_count, 99);
  assert.equal(result.providers[1].usage.daily_buckets_truncated, true);
  assert.equal(JSON.stringify(result).includes('opaque-session'), false);
});

test('uses fresh per-provider cache and refresh bypasses it', async () => {
  let now = start;
  let calls = 0;
  const includeUsage = [];
  const reader = createCapacityReader({
    now: () => now,
    readCodex: async ({ includeUsage: requested }) => {
      includeUsage.push(requested);
      calls += 1;
      return codex(now, calls);
    },
    readGrok: async () => grok(now),
  });
  const first = await reader({ providers: ['codex'], max_age_seconds: 60 });
  now += 10_000;
  const cached = await reader({ providers: ['codex'], max_age_seconds: 60 });
  assert.equal(calls, 1);
  assert.equal(cached.providers[0].capacity.used_percent, 1);
  assert.equal(cached.providers[0].usage, null);
  assert.equal(cached.providers[0].freshness.state, 'fresh');
  const refreshed = await reader({ providers: ['codex'], refresh: true, max_age_seconds: 60 });
  assert.equal(calls, 2);
  assert.deepEqual(includeUsage, [false, false]);
  assert.equal(refreshed.providers[0].capacity.used_percent, 2);
  assert.equal(first.providers[0].observed_at, new Date(start).toISOString());

  const detailed = await reader({ providers: ['codex'], include_usage: true, max_age_seconds: 60 });
  assert.equal(calls, 3);
  assert.deepEqual(includeUsage, [false, false, true]);
  assert.equal(detailed.providers[0].usage.lifetime_tokens, 42);
  const routineAgain = await reader({ providers: ['codex'], max_age_seconds: 60 });
  assert.equal(calls, 3);
  assert.equal(routineAgain.providers[0].usage, null);
});

test('returns stale cached value with original observation and redacted error', async () => {
  let now = start;
  let fail = false;
  const reader = createCapacityReader({
    now: () => now,
    readCodex: async () => {
      if (fail) throw Object.assign(new Error('Bearer super-secret-token'), { code: 'rpc_error' });
      return codex(now);
    },
    readGrok: async () => grok(now),
  });
  await reader({ providers: ['codex'], max_age_seconds: 1 });
  now += 10_000;
  fail = true;
  const result = await reader({ providers: ['codex'], max_age_seconds: 1 });
  const entry = result.providers[0];
  assert.equal(entry.status, 'stale');
  assert.equal(entry.freshness.state, 'stale');
  assert.equal(entry.observed_at, new Date(start).toISOString());
  assert.deepEqual(entry.error, { code: 'rpc_error' });
  assert.equal(JSON.stringify(entry).includes('super-secret-token'), false);
});

test('strips detailed Codex usage from stale routine refresh fallbacks', async () => {
  let now = start;
  let fail = false;
  const reader = createCapacityReader({
    now: () => now,
    readCodex: async ({ includeUsage }) => {
      if (fail) throw Object.assign(new Error('private provider detail'), { code: 'rpc_error' });
      return codex(now, includeUsage ? 11 : 12);
    },
    readGrok: async () => grok(now),
  });
  await reader({ providers: ['codex'], include_usage: true });
  now += 61_000;
  fail = true;
  const result = await reader({ providers: ['codex'], refresh: true, max_age_seconds: 60 });
  assert.equal(result.providers[0].status, 'stale');
  assert.equal(result.providers[0].usage, null);
  assert.deepEqual(result.providers[0].error, { code: 'rpc_error' });
});

test('isolates Grok cache by exact session selector', async () => {
  let now = start;
  const sessions = [];
  const reader = createCapacityReader({
    now: () => now,
    readCodex: async () => codex(now),
    readGrok: async ({ session_id }) => {
      sessions.push(session_id);
      return grok(now, session_id === 'one' ? 90 : 70);
    },
  });
  const one = await reader({ providers: ['grok'], grok_session_id: 'one' });
  const two = await reader({ providers: ['grok'], grok_session_id: 'two' });
  const oneAgain = await reader({ providers: ['grok'], grok_session_id: 'one' });
  assert.deepEqual(sessions, ['one', 'two']);
  assert.equal(one.providers[0].capacity.remaining_percent, 90);
  assert.equal(two.providers[0].capacity.remaining_percent, 70);
  assert.equal(oneAgain.providers[0].capacity.remaining_percent, 90);
});

test('does not let Codex include_usage force Grok or DSH cache misses', async () => {
  let grokCalls = 0;
  let dshCalls = 0;
  const reader = createCapacityReader({
    now: () => start,
    readCodex: async () => codex(start),
    readGrok: async () => { grokCalls += 1; return grok(start); },
    readDshReceipt: async () => {
      dshCalls += 1;
      return {
        schemaVersion: 1,
        source: 'dsh-headless-live',
        scope: 'task',
        rootSessionId: 'session-job-one',
        observedAt: new Date(start).toISOString(),
        aggregationComplete: true,
        confidence: 'exact',
        usageSamples: 1,
        counts: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1 },
      };
    },
  });
  await reader({ providers: ['grok', 'dsh'], dsh_job_id: 'job-one' });
  const result = await reader({
    providers: ['grok', 'dsh'], dsh_job_id: 'job-one', include_usage: true,
  });
  assert.equal(grokCalls, 1);
  assert.equal(dshCalls, 1);
  assert.equal(result.providers[0].status, 'available');
  assert.equal(result.providers[1].status, 'available');
});

test('isolates provider failures while reading selected providers in parallel', async () => {
  const reader = createCapacityReader({
    now: () => start,
    readCodex: async () => { throw Object.assign(new Error('secret'), { code: 'rpc_error' }); },
    readGrok: async () => grok(start),
    readDshReceipt: async () => ({
      schemaVersion: 1,
      source: 'dsh-headless-live',
      scope: 'task',
      rootSessionId: 'session-job-one',
      observedAt: new Date(start).toISOString(),
      aggregationComplete: true,
      confidence: 'exact',
      usageSamples: 1,
      counts: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1 },
    }),
  });
  const result = await reader({ providers: ['codex', 'grok', 'dsh'], dsh_job_id: 'job-one' });
  assert.deepEqual(result.providers.map(({ status }) => status), ['unavailable', 'available', 'available']);
  assert.deepEqual(result.providers[0].error, { code: 'rpc_error' });
});

test('reports DSH account capacity as explicitly unsupported', async () => {
  let calls = 0;
  const reader = createCapacityReader({
    now: () => start,
    readDshReceipt: async () => { calls += 1; return null; },
  });
  const result = await reader({ providers: ['dsh'] });
  assert.equal(calls, 0);
  assert.deepEqual(result.providers[0], {
    provider: 'dsh',
    source: 'dsh_provider',
    scope: 'account',
    status: 'unsupported',
    observed_at: null,
    freshness: { state: 'unknown', age_seconds: null },
    capacity: { status: 'unsupported', remaining_percent: null, spend_usd: null },
    usage: null,
    error: { code: 'account_capacity_unsupported' },
  });
});

test('accepts an injected exact DSH job receipt without estimating account spend', async () => {
  const jobIds = [];
  const reader = createCapacityReader({
    now: () => start,
    readDshReceipt: async (jobId) => {
      jobIds.push(jobId);
      return {
        schemaVersion: 1,
        source: 'dsh-headless-live',
        scope: 'task',
        rootSessionId: 'session-opaque',
        observedAt: new Date(start).toISOString(),
        aggregationComplete: true,
        confidence: 'exact',
        usageSamples: 1,
        counts: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 18,
        },
        cost_usd: 0.25,
      };
    },
  });
  const entry = (await reader({ providers: ['dsh'], dsh_job_id: 'job-one' })).providers[0];
  assert.equal(entry.status, 'available');
  assert.equal(entry.scope, 'job');
  assert.deepEqual(jobIds, ['job-one']);
  assert.equal(entry.usage.total_tokens, 18);
  assert.equal(entry.usage.cache_read_tokens, 2);
  assert.equal('cost_usd' in entry.usage, false);
  assert.deepEqual(entry.capacity, { status: 'unsupported', remaining_percent: null, spend_usd: null });
});

test('distinguishes a selected DSH job without an installed receipt reader', async () => {
  const reader = createCapacityReader({ now: () => start });
  const entry = (await reader({ providers: ['dsh'], dsh_job_id: 'job-one' })).providers[0];
  assert.equal(entry.status, 'unsupported');
  assert.deepEqual(entry.error, { code: 'dsh_receipt_unsupported' });
});

test('isolates DSH receipts by exact job selector and reuses each job cache', async () => {
  let calls = 0;
  const reader = createCapacityReader({
    now: () => start,
    readDshReceipt: async (jobId) => {
      calls += 1;
      const tokens = jobId === 'job-one' ? 1 : 2;
      return {
        schemaVersion: 1,
        source: 'dsh-headless-live',
        scope: 'task',
        rootSessionId: `session-${jobId}`,
        observedAt: new Date(start).toISOString(),
        aggregationComplete: true,
        confidence: 'exact',
        usageSamples: 1,
        counts: {
          inputTokens: tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: tokens,
        },
      };
    },
  });
  const one = await reader({ providers: ['dsh'], dsh_job_id: 'job-one' });
  const two = await reader({ providers: ['dsh'], dsh_job_id: 'job-two' });
  const oneAgain = await reader({ providers: ['dsh'], dsh_job_id: 'job-one' });
  assert.equal(calls, 2);
  assert.equal(one.providers[0].usage.input_tokens, 1);
  assert.equal(two.providers[0].usage.input_tokens, 2);
  assert.equal(oneAgain.providers[0].usage.input_tokens, 1);
});

test('rejects incomplete or inconsistent DSH receipts without exposing provider cost', async () => {
  const receipt = {
    schemaVersion: 1,
    source: 'dsh-headless-live',
    scope: 'task',
    rootSessionId: 'session-opaque',
    observedAt: new Date(start).toISOString(),
    aggregationComplete: true,
    confidence: 'exact',
    usageSamples: 1,
    counts: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 999,
    },
    cost_usd: 123,
  };
  const reader = createCapacityReader({ now: () => start, readDshReceipt: async () => receipt });
  const entry = (await reader({ providers: ['dsh'], dsh_job_id: 'job-one' })).providers[0];
  assert.equal(entry.status, 'unavailable');
  assert.deepEqual(entry.error, { code: 'invalid_receipt' });
  assert.equal(JSON.stringify(entry).includes('123'), false);

  delete receipt.aggregationComplete;
  const missingFlag = (await reader({ providers: ['dsh'], dsh_job_id: 'job-two', refresh: true })).providers[0];
  assert.equal(missingFlag.status, 'unavailable');
  assert.deepEqual(missingFlag.error, { code: 'invalid_receipt' });
});

test('requires the trusted DSH source and preserves unknown-confidence semantics', async () => {
  const unknownReceipt = {
    schemaVersion: 1,
    source: 'dsh-headless-live',
    scope: 'task',
    rootSessionId: 'session-opaque',
    observedAt: new Date(start).toISOString(),
    aggregationComplete: true,
    confidence: 'unknown',
    usageSamples: 0,
    counts: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  };
  const unknownReader = createCapacityReader({ now: () => start, readDshReceipt: async () => unknownReceipt });
  const unknown = (await unknownReader({ providers: ['dsh'], dsh_job_id: 'job-unknown' })).providers[0];
  assert.equal(unknown.status, 'partial');
  assert.deepEqual(unknown.error, { code: 'usage_unknown' });
  assert.equal(unknown.usage.confidence, 'unknown');

  const untrustedReader = createCapacityReader({
    now: () => start,
    readDshReceipt: async () => ({ ...unknownReceipt, source: 'untrusted-receipt' }),
  });
  const untrusted = (await untrustedReader({ providers: ['dsh'], dsh_job_id: 'job-untrusted' })).providers[0];
  assert.equal(untrusted.status, 'unavailable');
  assert.deepEqual(untrusted.error, { code: 'invalid_receipt' });
});

test('promotes Grok partial session telemetry to partial without leaking errors', async () => {
  const reader = createCapacityReader({
    now: () => start,
    readCodex: async () => codex(start),
    readGrok: async () => ({
      usage_percent: 20,
      remaining_percent: 80,
      provenance: { observed_at: new Date(start).toISOString() },
      session_usage_status: 'partial',
      session_usage: { input_tokens: 4 },
    }),
  });
  const entry = (await reader({ providers: ['grok'], grok_session_id: 'session' })).providers[0];
  assert.equal(entry.status, 'partial');
  assert.equal(entry.error, null);
});

test('validates bounded unique provider input and max age', async () => {
  const reader = createCapacityReader();
  await assert.rejects(reader({ providers: ['codex', 'codex'] }), (error) => {
    assert(error instanceof CapacityError);
    assert.equal(error.code, 'invalid_options');
    return true;
  });
  await assert.rejects(reader({ providers: ['cursor'] }), /unsupported or duplicate/);
  await assert.rejects(reader({ max_age_seconds: 3601 }), /max_age_seconds/);
  await assert.rejects(reader({ refresh: 'yes' }), /refresh/);
  await assert.rejects(reader({ dsh_job_id: '' }), /dsh_job_id/);
  await assert.rejects(reader({ include_usage: 'yes' }), /include_usage/);
});
