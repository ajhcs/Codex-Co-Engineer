import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  CODEX_USAGE_MAX_DAILY_BUCKETS,
  CODEX_USAGE_MAX_LINE_BYTES,
  CODEX_USAGE_TIMEOUT_MS,
  normalizeCodexCapacitySnapshot,
  normalizeCodexRateLimitSnapshot,
  normalizeCodexUsageResponse,
  readCodexCapacity,
} from '../mcp/codex-usage.mjs';

function makeStream() {
  return new EventEmitter();
}

function makeFakeSpawn({ onRequest, pid = undefined } = {}) {
  const requests = [];
  const stdout = makeStream();
  const stderr = makeStream();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.stdin = {
    write(text) {
      const message = JSON.parse(text);
      requests.push(message);
      onRequest?.(message, { child, stdout, stderr });
    },
    end() {
      child.stdinEnded = true;
    },
  };
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };

  const spawnImpl = (command, args, options) => {
    child.spawnCall = { command, args, options };
    return child;
  };
  spawnImpl.requests = requests;
  spawnImpl.child = child;
  return spawnImpl;
}

function emitJson(stream, message) {
  stream.emit('data', `${JSON.stringify(message)}\n`);
}

test('normalizes official rate-limit windows without inventing quotas', () => {
  const snapshot = normalizeCodexRateLimitSnapshot({
    limitId: 'codex',
    limitName: 'Codex',
    planType: 'pro',
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 80, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
    credits: { balance: '42', hasCredits: true, unlimited: false },
    individualLimit: { limit: '100', used: '37', remainingPercent: 63, resetsAt: 1_800_000_000 },
    spendControlReached: false,
    rateLimitReachedType: null,
  });

  assert.deepEqual(snapshot.primary, {
    usedPercent: 37,
    remainingPercent: 63,
    windowDurationMins: 300,
    resetsAt: 1_800_000_000,
  });
  assert.equal(snapshot.usedPercent, 37);
  assert.equal(snapshot.remainingPercent, 63);
  assert.equal(snapshot.secondary.remainingPercent, 20);
  assert.equal(snapshot.planType, 'pro');
  assert.deepEqual(snapshot.credits, { balance: '42', hasCredits: true, unlimited: false });
  assert.equal(snapshot.individualLimit.remainingPercent, 63);
  assert.equal('absoluteQuota' in snapshot, false);
});

test('normalizes malformed fields to explicit unknown values', () => {
  const snapshot = normalizeCodexRateLimitSnapshot({
    primary: { usedPercent: 101, windowDurationMins: -1, resetsAt: -4 },
    planType: 123,
    credits: { balance: 42, hasCredits: 'yes', unlimited: null },
  });

  assert.deepEqual(snapshot.primary, {
    usedPercent: null,
    remainingPercent: null,
    windowDurationMins: null,
    resetsAt: null,
  });
  assert.equal(snapshot.planType, null);
  assert.deepEqual(snapshot.credits, { balance: null, hasCredits: null, unlimited: null });
});

test('accepts only safe nonnegative integers and unix seconds at the boundary', () => {
  const safe = Number.MAX_SAFE_INTEGER;
  const unsafe = safe + 1;
  const valid = normalizeCodexCapacitySnapshot({
    rateLimits: {
      primary: { windowDurationMins: safe, resetsAt: safe },
      individualLimit: { resetsAt: safe },
    },
    rateLimitResetCredits: {
      availableCount: safe,
      credits: [{ grantedAt: safe, expiresAt: safe }],
    },
  });
  assert.equal(valid.rateLimits.snapshot.primary.windowDurationMins, safe);
  assert.equal(valid.rateLimits.snapshot.primary.resetsAt, safe);
  assert.equal(valid.rateLimits.snapshot.individualLimit.resetsAt, safe);
  assert.equal(valid.rateLimits.resetCredits.availableCount, safe);
  assert.equal(valid.rateLimits.resetCredits.credits[0].grantedAt, safe);
  assert.equal(valid.rateLimits.resetCredits.credits[0].expiresAt, safe);

  const invalid = normalizeCodexUsageResponse({
    summary: {
      lifetimeTokens: unsafe,
      currentStreakDays: unsafe,
    },
    dailyUsageBuckets: [{ tokens: unsafe }],
  });
  assert.equal(invalid.summary.lifetimeTokens, null);
  assert.equal(invalid.summary.currentStreakDays, null);
  assert.equal(invalid.dailyUsageBuckets[0].tokens, null);
});

test('normalizes freshness and optional usage response', () => {
  const capacity = normalizeCodexCapacitySnapshot(
    { rateLimits: { primary: { usedPercent: 5 } } },
    { nowMs: Date.parse('2026-08-17T00:00:00.000Z'), staleAfterMs: 300_000 },
  );
  assert.equal(capacity.status, 'ok');
  assert.equal(capacity.freshness.state, 'fresh');
  assert.equal(capacity.freshness.ageMs, 0);
  assert.equal(capacity.observedAt, '2026-08-17T00:00:00.000Z');

  const usage = normalizeCodexUsageResponse({
    summary: { lifetimeTokens: 10, peakDailyTokens: 8, currentStreakDays: 2 },
    dailyUsageBuckets: [{ startDate: '2026-08-16', tokens: 8 }],
  });
  assert.equal(usage.summary.lifetimeTokens, 10);
  assert.equal(usage.summary.peakDailyTokens, 8);
  assert.equal(usage.summary.longestStreakDays, null);
  assert.deepEqual(usage.dailyUsageBuckets, [{ startDate: '2026-08-16', tokens: 8 }]);
});

test('keeps reset-credit identity and lifecycle fields opaque and bounded', () => {
  const capacity = normalizeCodexCapacitySnapshot({
    rateLimits: {},
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [{
        id: 'opaque-credit-id',
        resetType: 'codexRateLimits',
        status: 'available',
        grantedAt: 1_800_000_000,
        expiresAt: null,
        title: 'Backend display title',
        description: null,
      }],
    },
  });
  assert.deepEqual(capacity.rateLimits.resetCredits, {
    availableCount: 2,
    creditsTruncated: false,
    creditsObservedCount: 1,
    credits: [{
      id: 'opaque-credit-id',
      resetType: 'codexRateLimits',
      status: 'available',
      grantedAt: 1_800_000_000,
      expiresAt: null,
      title: 'Backend display title',
      description: null,
    }],
  });
});

test('marks bounded reset-credit and daily-usage arrays with observed counts', () => {
  const observedCount = CODEX_USAGE_MAX_DAILY_BUCKETS + 3;
  const capacity = normalizeCodexCapacitySnapshot({
    rateLimits: {},
    rateLimitResetCredits: {
      credits: Array.from({ length: observedCount }, (_, index) => ({ id: `credit-${index}` })),
    },
  });
  assert.equal(capacity.rateLimits.resetCredits.credits.length, CODEX_USAGE_MAX_DAILY_BUCKETS);
  assert.equal(capacity.rateLimits.resetCredits.creditsTruncated, true);
  assert.equal(capacity.rateLimits.resetCredits.creditsObservedCount, observedCount);

  const usage = normalizeCodexUsageResponse({
    summary: {},
    dailyUsageBuckets: Array.from({ length: observedCount }, (_, index) => ({
      startDate: `2026-01-${(index % 28) + 1}`,
      tokens: index,
    })),
  });
  assert.equal(usage.dailyUsageBuckets.length, CODEX_USAGE_MAX_DAILY_BUCKETS);
  assert.equal(usage.dailyUsageBucketsTruncated, true);
  assert.equal(usage.dailyUsageBucketsObservedCount, observedCount);
});

test('uses the shared ten-second app-server exchange cap', () => {
  assert.equal(CODEX_USAGE_TIMEOUT_MS, 10_000);
});

test('bounds multi-bucket responses and preserves split UTF-8 JSONL', async () => {
  const buckets = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
    `limit-${index.toString().padStart(2, '0')}`,
    { primary: { usedPercent: index } },
  ]));
  const spawnImpl = makeFakeSpawn({
    onRequest(message, { stdout }) {
      if (message.id === 1) emitJson(stdout, { id: 1, result: {} });
      if (message.id === 2) {
        const line = JSON.stringify({
          id: 2,
          result: {
            rateLimits: { primary: { usedPercent: 1 } },
            rateLimitsByLimitId: buckets,
            planType: 'pro',
            credits: { balance: '€2', hasCredits: true, unlimited: false },
          },
        }) + '\n';
        const bytes = Buffer.from(line);
        const split = bytes.indexOf(0xe2);
        stdout.emit('data', bytes.subarray(0, split + 1));
        stdout.emit('data', bytes.subarray(split + 1));
      }
    },
  });
  const result = await readCodexCapacity({ spawnImpl, timeoutMs: 100 });
  assert.equal(result.status, 'ok');
  assert.equal(result.rateLimits.byLimitIdTruncated, true);
  assert.equal(Object.keys(result.rateLimits.byLimitId).length, 32);
});

test('uses the documented app-server handshake and account methods', async () => {
  const spawnImpl = makeFakeSpawn({
    onRequest(message, { child, stdout }) {
      if (message.id === 1) {
        emitJson(stdout, { id: 1, result: {} });
      } else if (message.id === 2) {
        emitJson(stdout, {
          id: 2,
          result: {
            rateLimits: {
              limitId: 'codex',
              planType: 'pro',
              primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            },
            rateLimitsByLimitId: {},
          },
        });
        // An unrelated notification must not affect the read response.
        emitJson(stdout, { method: 'account/rateLimits/updated', params: {} });
      } else if (message.id === 3) {
        emitJson(stdout, {
          id: 3,
          result: { summary: { lifetimeTokens: 99 }, dailyUsageBuckets: null },
        });
        child.exitCode = 0;
      }
    },
  });

  const result = await readCodexCapacity({ includeUsage: true, spawnImpl, timeoutMs: 100 });
  assert.equal(result.status, 'ok');
  assert.equal(result.rateLimits.snapshot.usedPercent, 12);
  assert.equal(result.rateLimits.snapshot.remainingPercent, 88);
  assert.equal(result.usage.summary.lifetimeTokens, 99);
  assert.equal(result.error, null);
  assert.equal(spawnImpl.child.spawnCall.command, 'codex');
  assert.deepEqual(spawnImpl.child.spawnCall.args, ['app-server']);
  assert.equal(spawnImpl.child.spawnCall.options.detached, true);
  assert.equal(spawnImpl.child.spawnCall.options.env.MODEL_API_KEY, undefined);
  assert.equal(spawnImpl.child.spawnCall.options.env.CURSOR_API_KEY, undefined);
  assert.deepEqual(spawnImpl.requests.map(({ method }) => method), [
    'initialize',
    'initialized',
    'account/rateLimits/read',
    'account/usage/read',
  ]);
  assert.equal(spawnImpl.requests[0].params.capabilities.experimentalApi, true);
});

test('keeps rate limits available when optional usage is unsupported', async () => {
  const spawnImpl = makeFakeSpawn({
    onRequest(message, { stdout }) {
      if (message.id === 1) emitJson(stdout, { id: 1, result: {} });
      if (message.id === 2) emitJson(stdout, {
        id: 2,
        result: { rateLimits: { primary: { usedPercent: 21 } } },
      });
      if (message.id === 3) emitJson(stdout, {
        id: 3,
        error: { code: -32601, message: 'method unavailable' },
      });
    },
  });
  const result = await readCodexCapacity({ includeUsage: true, spawnImpl, timeoutMs: 100 });
  assert.equal(result.status, 'partial');
  assert.equal(result.rateLimits.snapshot.remainingPercent, 79);
  assert.equal(result.usage, null);
  assert.deepEqual(result.error, { code: 'usage_error' });
});

test('returns unknown on malformed protocol output and cleans up the child', async () => {
  const spawnImpl = makeFakeSpawn({
    onRequest(message, { stdout }) {
      if (message.id === 1) stdout.emit('data', '{not-json}\n');
    },
  });
  const result = await readCodexCapacity({ spawnImpl, timeoutMs: 100 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error.code, 'protocol_error');
  assert.ok(spawnImpl.child.kills.length >= 1);
});

test('fails closed when Codex returns a JSON-RPC envelope on its native wire', async () => {
  const spawnImpl = makeFakeSpawn({
    onRequest(message, { stdout }) {
      if (message.id === 1) emitJson(stdout, { jsonrpc: '2.0', id: 1, result: {} });
    },
  });
  const result = await readCodexCapacity({ spawnImpl, timeoutMs: 100 });
  assert.equal(result.error.code, 'protocol_error');
});

test('handles asynchronous stdout errors without exposing provider details', async () => {
  const spawnImpl = makeFakeSpawn({
    onRequest(message, { stdout }) {
      if (message.id === 1) queueMicrotask(() => stdout.emit('error', new Error('private stream detail')));
    },
  });
  const result = await readCodexCapacity({ spawnImpl, timeoutMs: 100 });
  assert.equal(result.error.code, 'stdout_error');
});

test('returns unknown on timeout and terminates the app-server', async () => {
  const spawnImpl = makeFakeSpawn();
  const result = await readCodexCapacity({ spawnImpl, timeoutMs: 20 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error.code, 'timeout');
  assert.ok(spawnImpl.child.kills.length >= 1);
});

test('enforces bounded protocol output', async () => {
  const spawnImpl = makeFakeSpawn({
    onRequest(message, { stdout }) {
      if (message.id === 1) stdout.emit('data', `${'x'.repeat(CODEX_USAGE_MAX_LINE_BYTES + 1)}\n`);
    },
  });
  const result = await readCodexCapacity({ spawnImpl, timeoutMs: 100 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error.code, 'output_limit');
});

test('returns unknown on a spawn failure without exposing process details', async () => {
  const result = await readCodexCapacity({
    spawnImpl: () => {
      throw new Error('credentials should never appear in a returned error');
    },
  });
  assert.deepEqual(result.error, { code: 'spawn_error' });
  assert.equal(result.observedAt, null);
});
