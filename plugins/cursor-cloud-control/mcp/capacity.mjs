// Compact, provider-truthful usage projections for the Cloud Agents API.
//
// Cursor's Cloud Agents usage endpoint reports tokens for one agent (or run),
// but it does not report a personal plan allowance, remaining balance, or
// billing-cycle reset. Keep those fields explicitly unavailable rather than
// estimating them from token counts.

export const PERSONAL_CAPACITY_UNAVAILABLE_REASON = 'not_exposed_by_cloud_agents_api';

const TOKEN_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheWriteTokens',
  'cacheReadTokens',
  'totalTokens',
]);

export class UsageResponseError extends Error {
  constructor(path, reason = 'invalid_shape') {
    super(`Cursor usage response has invalid ${path}.`);
    this.name = 'UsageResponseError';
    this.code = 'invalid_usage_response';
    this.details = { path, reason };
  }
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecord(value, path) {
  if (!isRecord(value)) throw new UsageResponseError(path);
  return value;
}

function requiredCounter(source, field, path) {
  if (!Object.hasOwn(source, field) || !Number.isSafeInteger(source[field]) || source[field] < 0) {
    throw new UsageResponseError(`${path}.${field}`, 'required_non_negative_integer');
  }
  return source[field];
}

export function normalizeTokenUsage(value, path = 'usage') {
  const source = requiredRecord(value, path);
  const usage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, requiredCounter(source, field, path)]));
  const sum = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  if (!Number.isSafeInteger(sum) || usage.totalTokens !== sum) {
    throw new UsageResponseError(`${path}.totalTokens`, 'must_equal_counter_sum');
  }
  return usage;
}

function normalizeRun(value, index, seenIds) {
  const path = `runs[${index}]`;
  const source = requiredRecord(value, path);
  if (typeof source.id !== 'string' || source.id.trim() === '') {
    throw new UsageResponseError(`${path}.id`, 'required_non_empty_string');
  }
  if (seenIds.has(source.id)) throw new UsageResponseError(`${path}.id`, 'duplicate_run_id');
  seenIds.add(source.id);
  const run = {
    id: source.id,
    usage: normalizeTokenUsage(source.usage, `${path}.usage`),
  };
  if (Object.hasOwn(source, 'usageUuid')) {
    if (typeof source.usageUuid !== 'string' || source.usageUuid.trim() === '') {
      throw new UsageResponseError(`${path}.usageUuid`, 'non_empty_string_when_present');
    }
    run.usageUuid = source.usageUuid;
  }
  return run;
}

function sumRunUsage(runs) {
  const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  for (const [index, run] of runs.entries()) {
    for (const field of TOKEN_FIELDS) {
      const next = totals[field] + run.usage[field];
      if (!Number.isSafeInteger(next)) {
        throw new UsageResponseError(`runs[${index}].usage.${field}`, 'sum_overflow');
      }
      totals[field] = next;
    }
  }
  return totals;
}

function assertTotalMatchesRuns(totalUsage, runs) {
  const summedUsage = sumRunUsage(runs);
  for (const field of TOKEN_FIELDS) {
    if (totalUsage[field] !== summedUsage[field]) {
      throw new UsageResponseError(`totalUsage.${field}`, 'must_equal_run_sum');
    }
  }
}

/**
 * Normalize one `/v1/agents/{id}/usage` response into its stable provider
 * fields. `rateWindow` is included only when the HTTP response actually
 * supplied at least one documented rate-limit header.
 */
export function normalizeAgentUsage(payload, {
  scope = 'agent',
  requestedRunId,
  observedAt = new Date().toISOString(),
  rateWindow,
} = {}) {
  const source = requiredRecord(payload, 'response');
  if (scope !== 'agent' && scope !== 'run') throw new UsageResponseError('scope', 'agent_or_run');
  if (scope === 'run' && requestedRunId === undefined) {
    throw new UsageResponseError('requestedRunId', 'required_for_run_scope');
  }
  if (!Object.hasOwn(source, 'totalUsage')) throw new UsageResponseError('totalUsage', 'required');
  if (!Object.hasOwn(source, 'runs') || !Array.isArray(source.runs)) throw new UsageResponseError('runs', 'required_array');
  const totalUsage = normalizeTokenUsage(source.totalUsage, 'totalUsage');
  const seenIds = new Set();
  const runs = source.runs.map((run, index) => normalizeRun(run, index, seenIds));
  if (requestedRunId !== undefined) {
    if (typeof requestedRunId !== 'string' || requestedRunId.trim() === '') {
      throw new UsageResponseError('requestedRunId', 'required_non_empty_string');
    }
    if (runs.length !== 1 || runs[0].id !== requestedRunId) {
      throw new UsageResponseError('runs', 'requested_run_mismatch');
    }
  }
  assertTotalMatchesRuns(totalUsage, runs);
  const capacity = {
    scope: scope === 'run' ? 'run' : 'agent',
    status: 'measured',
    source: 'cloud_agent_usage',
    observedAt,
    used: totalUsage,
    // Cloud Agents API does not expose personal plan allowance or reset data.
    account: {
      plan: null,
      remaining: null,
      resetAt: null,
      source: PERSONAL_CAPACITY_UNAVAILABLE_REASON,
    },
  };
  if (rateWindow && typeof rateWindow === 'object') capacity.rateWindow = rateWindow;

  return {
    totalUsage,
    runs,
    capacity,
  };
}

function headerValue(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  const value = headers.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Response headers are provider-controlled input. Keep the compact usage
  // projection bounded even if an upstream sends an unexpectedly large value.
  return trimmed && trimmed.length <= 128 ? trimmed : null;
}

function numericHeader(value) {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : value;
}

/**
 * Convert a Retry-After delay-seconds value or HTTP-date to milliseconds.
 * `undefined` means the provider value cannot be safely interpreted.
 */
export function retryAfterDelayMs(value, now = Date.now()) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const milliseconds = value * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const seconds = Number(value);
  if (/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

/**
 * Capture only the documented, non-secret rate-limit headers. `reset` is kept
 * as the provider's raw value because the API reference does not specify
 * whether a deployment expresses it as seconds or milliseconds.
 */
export function parseRateLimitHeaders(headers) {
  const limit = headerValue(headers, 'X-RateLimit-Limit');
  const remaining = headerValue(headers, 'X-RateLimit-Remaining');
  const reset = headerValue(headers, 'X-RateLimit-Reset');
  const retryAfter = headerValue(headers, 'Retry-After');
  if (limit === null && remaining === null && reset === null && retryAfter === null) return null;

  const result = { source: 'response_headers' };
  if (limit !== null) result.limit = numericHeader(limit);
  if (remaining !== null) result.remaining = numericHeader(remaining);
  if (reset !== null) result.reset = reset;
  if (retryAfter !== null) result.retryAfter = numericHeader(retryAfter);
  return result;
}

const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Extract only a bounded machine-readable provider error code. */
export function providerErrorCode(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const candidate = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
    ? parsed.error.code
    : parsed.code;
  return typeof candidate === 'string' && PROVIDER_CODE_PATTERN.test(candidate) ? candidate : undefined;
}
