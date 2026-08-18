import { readCodexCapacity } from './codex-usage.mjs';
import { readGrokCapacity } from './grok-capacity.mjs';

export const CAPACITY_VERSION = 1;
export const CAPACITY_PROVIDERS = Object.freeze(['codex', 'grok', 'dsh']);
export const DEFAULT_MAX_AGE_SECONDS = 60;
const MAX_PROVIDERS = CAPACITY_PROVIDERS.length;
const MAX_TEXT = 160;
const SAFE_ERROR_CODES = new Set([
  'account_capacity_unsupported', 'capacity_query_failed', 'dsh_receipt_unsupported', 'failed', 'invalid_options',
  'invalid_receipt', 'invalid_result', 'line_limit', 'output_limit', 'platform_unsupported',
  'process_cleanup', 'protocol_error', 'rpc_error', 'timeout', 'unavailable', 'usage_error', 'usage_unknown',
]);
const DSH_RECEIPT_VERSION = 1;
const DSH_CONFIDENCES = new Set(['exact', 'observed', 'unknown']);
const DSH_TOKEN_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
]);

export class CapacityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CapacityError';
    this.code = code;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const numberOrNull = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integerOrNull = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const percentOrNull = (value) => numberOrNull(value) !== null && value >= 0 && value <= 100 ? value : null;
const boolOrNull = (value) => typeof value === 'boolean' ? value : null;

function textOrNull(value, maximum = MAX_TEXT) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return null;
  return /[\x00-\x1f\x7f]/.test(value) ? null : value;
}

function timestampOrNull(value) {
  const text = textOrNull(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function clockMilliseconds(now) {
  const value = typeof now === 'function' ? now() : now;
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function freshness(observedAt, now, maxAgeSeconds, forceStale = false) {
  const observed = observedAt ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(observed)) return { state: 'unknown', age_seconds: null };
  const ageSeconds = Math.max(0, (clockMilliseconds(now) - observed) / 1000);
  return {
    state: forceStale || ageSeconds > maxAgeSeconds ? 'stale' : 'fresh',
    age_seconds: ageSeconds,
  };
}

function sanitizeError(error, fallback = 'capacity_query_failed') {
  const rawCode = error?.code;
  const code = typeof rawCode === 'string' && SAFE_ERROR_CODES.has(rawCode) ? rawCode : fallback;
  return { code };
}

function validateArgs(args) {
  if (!isRecord(args)) throw new CapacityError('invalid_options', 'Capacity options must be an object.');
  const providers = args.providers === undefined ? [...CAPACITY_PROVIDERS] : args.providers;
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > MAX_PROVIDERS) {
    throw new CapacityError('invalid_options', 'providers must contain one to three providers.');
  }
  const selected = [];
  for (const provider of providers) {
    if (typeof provider !== 'string' || !CAPACITY_PROVIDERS.includes(provider) || selected.includes(provider)) {
      throw new CapacityError('invalid_options', 'providers contains an unsupported or duplicate provider.');
    }
    selected.push(provider);
  }
  const refresh = args.refresh === undefined ? false : args.refresh;
  if (typeof refresh !== 'boolean') throw new CapacityError('invalid_options', 'refresh must be boolean.');
  const maxAge = args.max_age_seconds === undefined ? DEFAULT_MAX_AGE_SECONDS : args.max_age_seconds;
  if (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 3600) {
    throw new CapacityError('invalid_options', 'max_age_seconds must be an integer from 0 to 3600.');
  }
  const sessionId = args.grok_session_id ?? null;
  if (sessionId !== null && !textOrNull(sessionId, 256)) {
    throw new CapacityError('invalid_options', 'grok_session_id is invalid.');
  }
  const dshJobId = args.dsh_job_id ?? null;
  if (dshJobId !== null && !textOrNull(dshJobId, 96)) {
    throw new CapacityError('invalid_options', 'dsh_job_id is invalid.');
  }
  const includeUsage = args.include_usage === undefined ? false : args.include_usage;
  if (typeof includeUsage !== 'boolean') {
    throw new CapacityError('invalid_options', 'include_usage must be boolean.');
  }
  return { providers: selected, refresh, maxAge, sessionId, dshJobId, includeUsage };
}

function compactWindow(value) {
  if (!isRecord(value)) return null;
  return {
    used_percent: percentOrNull(value.usedPercent),
    remaining_percent: percentOrNull(value.remainingPercent),
    duration_minutes: integerOrNull(value.windowDurationMins),
    resets_at: integerOrNull(value.resetsAt),
  };
}

function compactCodex(raw, includeUsage) {
  const snapshot = raw?.rateLimits?.snapshot;
  const capacity = snapshot ? {
    used_percent: percentOrNull(snapshot.usedPercent),
    remaining_percent: percentOrNull(snapshot.remainingPercent),
    plan_type: textOrNull(snapshot.planType),
    primary: compactWindow(snapshot.primary),
    secondary: compactWindow(snapshot.secondary),
    credits: isRecord(snapshot.credits) ? {
      balance: textOrNull(snapshot.credits.balance),
      has_credits: boolOrNull(snapshot.credits.hasCredits),
      unlimited: boolOrNull(snapshot.credits.unlimited),
    } : null,
    individual_limit: isRecord(snapshot.individualLimit) ? {
      limit: textOrNull(snapshot.individualLimit.limit),
      used: textOrNull(snapshot.individualLimit.used),
      remaining_percent: percentOrNull(snapshot.individualLimit.remainingPercent),
      resets_at: integerOrNull(snapshot.individualLimit.resetsAt),
    } : null,
    spend_control_reached: boolOrNull(snapshot.spendControlReached),
    rate_limit_reached_type: textOrNull(snapshot.rateLimitReachedType),
  } : null;
  const summary = includeUsage === true ? raw?.usage?.summary : null;
  const usage = isRecord(summary) ? {
    current_streak_days: integerOrNull(summary.currentStreakDays),
    lifetime_tokens: integerOrNull(summary.lifetimeTokens),
    longest_running_turn_seconds: integerOrNull(summary.longestRunningTurnSec),
    longest_streak_days: integerOrNull(summary.longestStreakDays),
    peak_daily_tokens: integerOrNull(summary.peakDailyTokens),
    daily_bucket_count: integerOrNull(raw.usage.dailyUsageBucketsObservedCount),
    daily_buckets_truncated: boolOrNull(raw.usage.dailyUsageBucketsTruncated),
  } : null;
  return { capacity, usage };
}

function compactGrok(raw) {
  const capacity = {
    used_percent: percentOrNull(raw?.usage_percent),
    remaining_percent: percentOrNull(raw?.remaining_percent),
    subscription_tier: textOrNull(raw?.subscription_tier),
    period: isRecord(raw?.period) ? {
      type: textOrNull(raw.period.type),
      start: timestampOrNull(raw.period.start),
      end: timestampOrNull(raw.period.end),
    } : null,
    on_demand: isRecord(raw?.on_demand) ? {
      enabled: boolOrNull(raw.on_demand.enabled),
      cap_cents: integerOrNull(raw.on_demand.cap_cents),
      used_cents: integerOrNull(raw.on_demand.used_cents),
    } : null,
    prepaid_balance_cents: integerOrNull(raw?.prepaid_balance_cents),
    unified_billing: boolOrNull(raw?.unified_billing),
  };
  const value = raw?.session_usage;
  const usage = isRecord(value) ? {
    input_tokens: integerOrNull(value.input_tokens),
    output_tokens: integerOrNull(value.output_tokens),
    reasoning_tokens: integerOrNull(value.reasoning_tokens),
    cached_input_tokens: integerOrNull(value.cached_input_tokens),
    total_tokens: integerOrNull(value.total_tokens),
    num_turns: integerOrNull(value.num_turns),
    cost_usd_ticks: integerOrNull(value.cost_usd_ticks),
    cost_usd: numberOrNull(value.cost_usd),
    cost_is_partial: boolOrNull(value.cost_is_partial),
    usage_is_incomplete: boolOrNull(value.usage_is_incomplete),
    model_count: isRecord(value.model_usage) ? Object.keys(value.model_usage).length : null,
  } : null;
  return { capacity, usage };
}

function compactDshReceipt(receipt) {
  if (!isRecord(receipt) || receipt.schemaVersion !== DSH_RECEIPT_VERSION
    || receipt.scope !== 'task' || typeof receipt.aggregationComplete !== 'boolean'
    || receipt.source !== 'dsh-headless-live'
    || !DSH_CONFIDENCES.has(receipt.confidence)
    || !Number.isSafeInteger(receipt.usageSamples) || receipt.usageSamples < 0
    || textOrNull(receipt.rootSessionId, 256) === null) return null;
  const complete = receipt.aggregationComplete;
  const confidence = receipt.confidence;
  if ((complete && !['exact', 'unknown'].includes(confidence))
    || (!complete && confidence !== 'observed')) return null;
  if ((confidence === 'exact' && receipt.usageSamples === 0)
    || (confidence === 'unknown' && receipt.usageSamples !== 0)) return null;
  const source = textOrNull(receipt.source);
  const observedAt = timestampOrNull(receipt.observedAt);
  const counts = receipt.counts;
  if (source === null || observedAt === null || !isRecord(counts)) return null;
  const values = [];
  for (const field of DSH_TOKEN_FIELDS) {
    if (!Object.hasOwn(counts, field)) return null;
    const value = integerOrNull(counts[field]);
    if (value === null) return null;
    values.push(value);
  }
  const totalTokens = integerOrNull(counts.totalTokens);
  if (totalTokens === null) return null;
  let expectedTotal = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - expectedTotal) return null;
    expectedTotal += value;
  }
  if (expectedTotal !== totalTokens) return null;
  if (confidence === 'unknown' && totalTokens !== 0) return null;
  return {
    source,
    observedAt,
    usage: {
      input_tokens: values[0],
      output_tokens: values[1],
      cache_read_tokens: values[2],
      cache_write_tokens: values[3],
      total_tokens: totalTokens,
      aggregation_complete: complete,
      confidence,
      usage_samples: receipt.usageSamples,
    },
  };
}

function statusFromRaw(raw) {
  if (raw?.status === 'partial') return 'partial';
  if (raw?.status === 'ok' || raw?.status === 'available') return 'available';
  if (raw?.status === 'unsupported') return 'unsupported';
  return 'unavailable';
}

function makeEntry(provider, source, scope, status, observedAt, now, maxAge, capacity, usage, error = null) {
  return {
    provider,
    source,
    scope,
    status,
    observed_at: observedAt,
    freshness: freshness(observedAt, now, maxAge, status === 'stale'),
    capacity,
    usage,
    error,
  };
}

function codexEntry(raw, now, maxAge, includeUsage) {
  const compact = compactCodex(raw, includeUsage);
  return makeEntry(
    'codex', 'codex_app_server', 'account', statusFromRaw(raw),
    timestampOrNull(raw?.observedAt), now, maxAge, compact.capacity, compact.usage,
    raw?.error ? sanitizeError(raw.error) : null,
  );
}

function grokEntry(raw, now, maxAge) {
  const compact = compactGrok(raw);
  const sessionStatus = raw?.session_usage_status;
  const sessionError = sessionStatus === 'unavailable'
    ? { code: 'unavailable' }
    : sessionStatus === 'failed' ? { code: 'failed' }
      : raw?.error ? sanitizeError(raw.error) : null;
  const readerError = raw?.error ? sanitizeError(raw.error) : sessionError;
  const sessionPartial = sessionStatus === 'partial'
    || sessionStatus === 'unavailable' || sessionStatus === 'failed';
  const status = raw?.status === undefined
    ? (sessionPartial ? 'partial' : 'available')
    : statusFromRaw(raw);
  return makeEntry(
    'grok', 'grok_build_acp', 'account', status,
    timestampOrNull(raw?.provenance?.observed_at), now, maxAge, compact.capacity, compact.usage,
    readerError,
  );
}

function unsupportedDshEntry(now, maxAge, scope = 'account', code = 'account_capacity_unsupported') {
  return makeEntry(
    'dsh', 'dsh_provider', scope, 'unsupported', null, now, maxAge,
    { status: 'unsupported', remaining_percent: null, spend_usd: null }, null,
    { code },
  );
}

function cacheable(entry) {
  return entry.observed_at !== null && entry.status !== 'unavailable' && entry.status !== 'unsupported';
}

export function createCapacityReader({
  readCodex = readCodexCapacity,
  readGrok = readGrokCapacity,
  readDshReceipt = null,
  now = () => Date.now(),
} = {}) {
  if (typeof readCodex !== 'function' || typeof readGrok !== 'function'
    || (readDshReceipt !== null && typeof readDshReceipt !== 'function')) {
    throw new CapacityError('invalid_options', 'Capacity readers must be functions.');
  }
  const cache = new Map();
  const readOne = async (provider, options) => {
    const selector = provider === 'grok'
      ? options.sessionId ?? ''
      : provider === 'dsh' ? options.dshJobId ?? '' : '';
    const key = `${provider}\u0000${selector}`;
    const cachedRecord = cache.get(key);
    const cached = cachedRecord?.entry;
    const current = clockMilliseconds(now);
    const cachedFresh = cached && !options.refresh && cached.observed_at
      && (provider !== 'codex' || !options.includeUsage || cachedRecord.includeUsage)
      && options.maxAge > 0 && Number.isFinite(Date.parse(cached.observed_at))
      && current - Date.parse(cached.observed_at) <= options.maxAge * 1000;
    if (cachedFresh) {
      const entry = structuredClone(cached);
      if (provider === 'codex' && !options.includeUsage) entry.usage = null;
      entry.freshness = freshness(entry.observed_at, now, options.maxAge);
      return entry;
    }
    try {
      if (provider === 'dsh' && options.dshJobId === null) {
        return unsupportedDshEntry(now, options.maxAge);
      }
      if (provider === 'dsh' && readDshReceipt === null) {
        return unsupportedDshEntry(now, options.maxAge, 'job', 'dsh_receipt_unsupported');
      }
      let raw;
      let entry;
      if (provider === 'codex') {
        raw = await readCodex({ includeUsage: options.includeUsage, now });
        entry = codexEntry(raw, now, options.maxAge, options.includeUsage);
      } else if (provider === 'grok') {
        raw = await readGrok({
          include_session_usage: options.sessionId !== null,
          session_id: options.sessionId,
          now,
        });
        entry = grokEntry(raw, now, options.maxAge);
      } else {
        raw = await readDshReceipt(options.dshJobId, { now });
        const compact = compactDshReceipt(raw);
        if (!compact) throw new CapacityError('invalid_receipt', 'DSH receipt is invalid.');
        const usageUnknown = compact.usage.confidence === 'unknown';
        const complete = compact.usage.aggregation_complete;
        entry = makeEntry(
          'dsh', compact.source, 'job', complete && !usageUnknown ? 'available' : 'partial',
          compact.observedAt, now, options.maxAge,
          { status: 'unsupported', remaining_percent: null, spend_usd: null }, compact.usage,
          complete && !usageUnknown ? null : { code: usageUnknown ? 'usage_unknown' : 'unavailable' },
        );
      }
      if (entry.status === 'unavailable') {
        throw new CapacityError(entry.error?.code ?? 'capacity_query_failed', 'Capacity reader was unavailable.');
      }
      if (cacheable(entry)) cache.set(key, {
        entry: structuredClone(entry),
        includeUsage: options.includeUsage,
      });
      return entry;
    } catch (error) {
      if (cached) {
        const entry = structuredClone(cached);
        if (provider === 'codex' && !options.includeUsage) entry.usage = null;
        entry.status = 'stale';
        entry.freshness = freshness(entry.observed_at, now, options.maxAge, true);
        entry.error = sanitizeError(error);
        return entry;
      }
      const source = provider === 'codex' ? 'codex_app_server'
        : provider === 'grok' ? 'grok_build_acp' : 'dsh_provider';
      return makeEntry(provider, source, provider === 'dsh' ? 'job' : 'account', 'unavailable', null,
        now, options.maxAge, null, null, sanitizeError(error));
    }
  };

  return async function readCapacity(args = {}) {
    const options = validateArgs(args);
    const providers = await Promise.all(options.providers.map((provider) => readOne(provider, options)));
    return { version: CAPACITY_VERSION, providers };
  };
}

const defaultCapacityReader = createCapacityReader();
export const readCapacity = (args = {}) => defaultCapacityReader(args);
