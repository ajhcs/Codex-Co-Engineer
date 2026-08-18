import {
  BOUNDED_RPC_TIMEOUT_MS,
  BOUNDED_RPC_MAX_LINE_BYTES,
  BOUNDED_RPC_MAX_OUTPUT_BYTES,
  BoundedJsonlRpcTransport,
  BoundedRpcError,
  isRecord,
} from './bounded-jsonl-rpc.mjs';
export const CODEX_APP_SERVER_COMMAND = 'codex';
export const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server']);
export const CODEX_USAGE_TIMEOUT_MS = BOUNDED_RPC_TIMEOUT_MS;
export const CODEX_USAGE_MAX_LINE_BYTES = BOUNDED_RPC_MAX_LINE_BYTES;
export const CODEX_USAGE_MAX_OUTPUT_BYTES = BOUNDED_RPC_MAX_OUTPUT_BYTES;
export const CODEX_USAGE_MAX_STRING_BYTES = 512;
export const CODEX_USAGE_MAX_DAILY_BUCKETS = 366;
export const CODEX_USAGE_MAX_LIMIT_BUCKETS = 32;
export const CODEX_USAGE_STALE_AFTER_MS = 5 * 60 * 1_000;
const CLIENT_INFO = Object.freeze({
  name: 'plumbob-harness-control',
  title: 'Co-Engineer Codex usage reader',
  version: '1',
});
const UNKNOWN_FRESHNESS = Object.freeze({
  state: 'unknown',
  observedAt: null,
  ageMs: null,
});
function boundedString(value, maxBytes = CODEX_USAGE_MAX_STRING_BYTES) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes ? value : null;
}
const validPercent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const validNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const validUnixSeconds = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const validBoolean = (value) => typeof value === 'boolean' ? value : null;
function normalizeWindow(window) {
  if (!isRecord(window)) return null;
  const usedPercent = validPercent(window.usedPercent);
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowDurationMins: validNonNegativeInteger(window.windowDurationMins),
    resetsAt: validUnixSeconds(window.resetsAt),
  };
}
function normalizeCredits(credits) {
  if (!isRecord(credits)) return null;
  return {
    balance: boundedString(credits.balance),
    hasCredits: validBoolean(credits.hasCredits),
    unlimited: validBoolean(credits.unlimited),
  };
}
function normalizeSpendControl(spendControl) {
  if (!isRecord(spendControl)) return null;
  return {
    limit: boundedString(spendControl.limit),
    used: boundedString(spendControl.used),
    remainingPercent: validPercent(spendControl.remainingPercent),
    resetsAt: validUnixSeconds(spendControl.resetsAt),
  };
}
export function normalizeCodexRateLimitSnapshot(snapshot) {
  if (!isRecord(snapshot)) return null;
  const primary = normalizeWindow(snapshot.primary);
  const secondary = normalizeWindow(snapshot.secondary);
  return {
    limitId: boundedString(snapshot.limitId),
    limitName: boundedString(snapshot.limitName),
    planType: boundedString(snapshot.planType),
    usedPercent: primary?.usedPercent ?? null,
    remainingPercent: primary?.remainingPercent ?? null,
    primary,
    secondary,
    credits: normalizeCredits(snapshot.credits),
    individualLimit: normalizeSpendControl(snapshot.individualLimit),
    spendControlReached: validBoolean(snapshot.spendControlReached),
    rateLimitReachedType: boundedString(snapshot.rateLimitReachedType),
  };
}
function normalizeRateLimitsByLimitId(value) {
  if (!isRecord(value)) return { values: null, truncated: false };
  const values = Object.create(null);
  const keys = Object.keys(value).sort();
  const selected = keys.slice(0, CODEX_USAGE_MAX_LIMIT_BUCKETS);
  for (const key of selected) {
    const snapshot = normalizeCodexRateLimitSnapshot(value[key]);
    if (snapshot) values[boundedString(key) ?? 'unknown'] = snapshot;
  }
  return { values, truncated: keys.length > selected.length };
}
function normalizeResetCredits(value) {
  if (!isRecord(value)) return null;
  const normalized = {
    availableCount: validNonNegativeInteger(value.availableCount),
    credits: null,
    creditsTruncated: false,
    creditsObservedCount: null,
  };
  if (Array.isArray(value.credits)) {
    normalized.creditsObservedCount = value.credits.length;
    normalized.creditsTruncated = value.credits.length > CODEX_USAGE_MAX_DAILY_BUCKETS;
    normalized.credits = value.credits.slice(0, CODEX_USAGE_MAX_DAILY_BUCKETS).map((credit) => {
      if (!isRecord(credit)) return null;
      return {
        id: boundedString(credit.id),
        resetType: boundedString(credit.resetType),
        status: boundedString(credit.status),
        grantedAt: validUnixSeconds(credit.grantedAt),
        expiresAt: validUnixSeconds(credit.expiresAt),
        title: boundedString(credit.title),
        description: boundedString(credit.description),
      };
    });
  }
  return normalized;
}
const observationMilliseconds = (now) => {
  const value = typeof now === 'function' ? now() : now;
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
};
function normalizeFreshness(observedAt, nowMs, staleAfterMs) {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return { ...UNKNOWN_FRESHNESS };
  const ageMs = Math.max(0, nowMs - observedMs);
  return {
    state: ageMs > staleAfterMs ? 'stale' : 'fresh',
    observedAt,
    ageMs,
  };
}
function normalizeUsageSummary(summary) {
  const fields = ['currentStreakDays', 'lifetimeTokens', 'longestRunningTurnSec', 'longestStreakDays', 'peakDailyTokens'];
  const normalized = {};
  for (const field of fields) normalized[field] = validNonNegativeInteger(summary?.[field]);
  return normalized;
}
function normalizeDailyUsageBuckets(value) {
  if (!Array.isArray(value)) return { values: null, truncated: false, observedCount: null };
  const observedCount = value.length;
  return {
    values: value.slice(0, CODEX_USAGE_MAX_DAILY_BUCKETS).map((bucket) => {
      if (!isRecord(bucket)) return null;
      return { startDate: boundedString(bucket.startDate), tokens: validNonNegativeInteger(bucket.tokens) };
    }),
    truncated: observedCount > CODEX_USAGE_MAX_DAILY_BUCKETS,
    observedCount,
  };
}
export function normalizeCodexUsageResponse(response) {
  if (!isRecord(response)) return null;
  const dailyUsageBuckets = normalizeDailyUsageBuckets(response.dailyUsageBuckets);
  return {
    summary: normalizeUsageSummary(response.summary),
    dailyUsageBuckets: dailyUsageBuckets.values,
    dailyUsageBucketsTruncated: dailyUsageBuckets.truncated,
    dailyUsageBucketsObservedCount: dailyUsageBuckets.observedCount,
  };
}
export function normalizeCodexCapacitySnapshot(
  response,
  { nowMs = Date.now(), staleAfterMs = CODEX_USAGE_STALE_AFTER_MS } = {},
) {
  const observedMs = observationMilliseconds(nowMs);
  const observedAt = new Date(observedMs).toISOString();
  const rateLimits = isRecord(response) ? response.rateLimits : null;
  const byLimitId = normalizeRateLimitsByLimitId(response?.rateLimitsByLimitId);
  return {
    provider: 'openai',
    surface: 'codex_chatgpt',
    source: 'codex_app_server',
    status: isRecord(rateLimits) ? 'ok' : 'unknown',
    observedAt,
    freshness: normalizeFreshness(observedAt, observedMs, staleAfterMs),
    rateLimits: {
      snapshot: normalizeCodexRateLimitSnapshot(rateLimits),
      byLimitId: byLimitId.values,
      byLimitIdTruncated: byLimitId.truncated,
      resetCredits: normalizeResetCredits(response?.rateLimitResetCredits),
    },
  };
}
function unknownResult(code, includeUsage) {
  return {
    provider: 'openai',
    surface: 'codex_chatgpt',
    source: 'codex_app_server',
    status: 'unknown',
    observedAt: null,
    freshness: { ...UNKNOWN_FRESHNESS },
    rateLimits: null,
    usage: includeUsage ? null : null,
    error: { code },
  };
}
const validInitializeResult = (result) => isRecord(result);
const validRateLimitsResult = (result) => isRecord(result) && isRecord(result.rateLimits);
const validUsageResult = (result) => isRecord(result) && isRecord(result.summary);
export async function readCodexCapacity(options = {}) {
  const includeUsage = options.includeUsage === true;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const transport = new BoundedJsonlRpcTransport({
    provider: 'codex',
    wire: 'codex',
    command: CODEX_APP_SERVER_COMMAND,
    args: CODEX_APP_SERVER_ARGS,
    timeoutMs: Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, CODEX_USAGE_TIMEOUT_MS)
      : CODEX_USAGE_TIMEOUT_MS,
    maxLineBytes: options.maxLineBytes,
    maxOutputBytes: options.maxOutputBytes,
    spawnImpl: options.spawnImpl,
  });
  let result;
  let failure = null;
  try {
    transport.start();
    await transport.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    }, { validateResult: validInitializeResult });
    transport.notify('initialized', {});
    const rateLimits = await transport.request('account/rateLimits/read', undefined, {
      validateResult: validRateLimitsResult,
    });
    let usage = null;
    let usageError = null;
    if (includeUsage) {
      try {
        usage = await transport.request('account/usage/read', undefined, {
          validateResult: validUsageResult,
        });
      } catch (error) {
        if (error instanceof BoundedRpcError && (error.code === 'rpc_error' || error.code === 'protocol_error')) {
          usageError = 'usage_error';
        } else {
          throw error;
        }
      }
    }
    const observedMs = observationMilliseconds(now);
    result = normalizeCodexCapacitySnapshot(rateLimits, { nowMs: observedMs });
    result.usage = includeUsage ? normalizeCodexUsageResponse(usage) : null;
    if (usageError) {
      result.status = 'partial';
      result.error = { code: usageError };
    } else {
      result.error = null;
    }
  } catch (error) {
    failure = unknownResult(error instanceof BoundedRpcError ? error.code : 'capacity_query_failed', includeUsage);
  } finally {
    if (!(await transport.close()) && !failure) failure = unknownResult('process_cleanup', includeUsage);
  }
  return failure ?? result;
}
