import {
  BOUNDED_RPC_MAX_LINES,
  BOUNDED_RPC_MAX_OUTPUT_BYTES,
  BoundedJsonlRpcTransport,
  BoundedRpcError,
  isRecord,
} from './bounded-jsonl-rpc.mjs';
export const GROK_BILLING_METHOD = 'x.ai/billing';
export const GROK_SESSION_USAGE_METHOD = 'x.ai/session/usage';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = BOUNDED_RPC_MAX_OUTPUT_BYTES;
const DEFAULT_MAX_LINES = BOUNDED_RPC_MAX_LINES;
const MAX_HISTORY_COUNT = 256;
const MAX_MODELS = 32;
const MAX_MODEL_NAME = 128;
const COST_TICKS_PER_USD = 10_000_000_000;
export class GrokCapacityError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GrokCapacityError';
    this.code = code;
  }
}
function unwrapRpcResult(value) {
  if (isRecord(value) && Object.hasOwn(value, 'jsonrpc')) {
    return value.jsonrpc === '2.0' && Object.hasOwn(value, 'result') ? value.result : null;
  }
  return value;
}
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}
function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function percent(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}
function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}
function textOrNull(value, maximum = MAX_MODEL_NAME) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= maximum && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}
function cents(value) {
  const wrapped = isRecord(value) ? value.val : value;
  return nonNegativeInteger(wrapped);
}
function isoTimestamp(value) {
  const text = textOrNull(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}
function observationMilliseconds(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  return finiteNumber(value) ?? Date.now();
}
function observedTimestamp(now) {
  return new Date(observationMilliseconds(now)).toISOString();
}
function freshnessSeconds(observedAt, now) {
  const observed = Date.parse(observedAt);
  const current = observationMilliseconds(now);
  return Number.isFinite(observed) ? Math.max(0, (current - observed) / 1000) : null;
}
function provenance(method, options = {}) {
  const observedAt = observedTimestamp(options.now);
  return {
    source: 'grok_build_acp',
    transport: 'acp_stdio',
    method,
    observed_at: observedAt,
    freshness_seconds: freshnessSeconds(observedAt, options.now),
  };
}
function period(config) {
  const current = isRecord(config?.currentPeriod ?? config?.current_period)
    ? config.currentPeriod ?? config.current_period
    : {};
  return {
    type: textOrNull(current.type ?? current.periodType ?? current.period_type, 128),
    start: isoTimestamp(current.start)
      ?? isoTimestamp(config?.billingPeriodStart ?? config?.billing_period_start),
    end: isoTimestamp(current.end)
      ?? isoTimestamp(config?.billingPeriodEnd ?? config?.billing_period_end),
  };
}
function usagePercent(config) {
  const explicit = percent(config?.creditUsagePercent ?? config?.credit_usage_percent);
  if (explicit !== null) return explicit;
  const limit = cents(config?.monthlyLimit ?? config?.monthly_limit);
  const used = cents(config?.used);
  if (limit === null || used === null || limit <= 0) return null;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}
function compactHistory(config) {
  if (!Array.isArray(config?.history)) return { count: null, truncated: false };
  return {
    count: config.history.length,
    truncated: config.history.length > MAX_HISTORY_COUNT,
  };
}
export function normalizeGrokBilling(payload, options = {}) {
  const response = unwrapRpcResult(payload);
  const root = isRecord(response) ? response : {};
  const config = isRecord(root.config) ? root.config : {};
  const usedPercent = usagePercent(config);
  const history = compactHistory(config);
  const tier = textOrNull(root.subscriptionTier ?? root.subscription_tier, 160);
  const onDemandEnabled = boolOrNull(root.onDemandEnabled ?? root.on_demand_enabled);
  return {
    provider: 'grok',
    auth_surface: 'grok_build_oauth',
    usage_percent: usedPercent,
    remaining_percent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    subscription_tier: tier,
    period: period(config),
    on_demand: {
      enabled: onDemandEnabled,
      cap_cents: cents(config.onDemandCap ?? config.on_demand_cap),
      used_cents: cents(config.onDemandUsed ?? config.on_demand_used),
    },
    prepaid_balance_cents: cents(config.prepaidBalance ?? config.prepaid_balance),
    unified_billing: boolOrNull(config.isUnifiedBillingUser ?? config.is_unified_billing_user),
    history_count: history.count,
    history_truncated: history.truncated,
    provenance: provenance(GROK_BILLING_METHOD, options),
  };
}
function tokenFields(value) {
  const source = isRecord(value) ? value : {};
  return {
    input_tokens: nonNegativeInteger(source.inputTokens ?? source.input_tokens ?? source.promptTokens),
    output_tokens: nonNegativeInteger(source.outputTokens ?? source.output_tokens ?? source.completionTokens),
    reasoning_tokens: nonNegativeInteger(source.reasoningTokens ?? source.reasoning_tokens),
    cached_input_tokens: nonNegativeInteger(
      source.cachedInputTokens ?? source.cached_input_tokens ?? source.cacheReadInputTokens,
    ),
    cache_creation_input_tokens: nonNegativeInteger(
      source.cacheCreationInputTokens ?? source.cache_creation_input_tokens,
    ),
    total_tokens: nonNegativeInteger(source.totalTokens ?? source.total_tokens),
  };
}
function normalizeModelUsage(value) {
  if (!isRecord(value)) return null;
  const models = Object.create(null);
  for (const [name, usage] of Object.entries(value).slice(0, MAX_MODELS)) {
    const model = textOrNull(name);
    if (model) models[model] = tokenFields(usage);
  }
  return models;
}
export function normalizeGrokSessionUsage(payload, options = {}) {
  const response = unwrapRpcResult(payload);
  const root = isRecord(response) ? response : {};
  const usage = isRecord(root.usage) ? root.usage : root;
  const costPartial = boolOrNull(usage.costIsPartial ?? usage.cost_is_partial);
  const usageIsIncomplete = boolOrNull(usage.usageIsIncomplete ?? usage.usage_is_incomplete);
  const costTicks = costPartial === false
    ? nonNegativeInteger(usage.costUsdTicks ?? usage.cost_usd_ticks)
    : null;
  const costUsd = costTicks === null ? null : costTicks / COST_TICKS_PER_USD;
  return {
    input_tokens: nonNegativeInteger(usage.inputTokens ?? usage.input_tokens),
    output_tokens: nonNegativeInteger(usage.outputTokens ?? usage.output_tokens),
    reasoning_tokens: nonNegativeInteger(usage.reasoningTokens ?? usage.reasoning_tokens),
    cached_input_tokens: nonNegativeInteger(usage.cachedInputTokens ?? usage.cached_input_tokens),
    total_tokens: nonNegativeInteger(usage.totalTokens ?? usage.total_tokens),
    num_turns: nonNegativeInteger(usage.numTurns ?? usage.num_turns),
    cost_usd_ticks: costTicks,
    cost_usd: costUsd,
    cost_is_partial: costPartial,
    usage_is_incomplete: usageIsIncomplete,
    model_usage: normalizeModelUsage(usage.modelUsage ?? usage.model_usage),
    provenance: provenance(GROK_SESSION_USAGE_METHOD, options),
  };
}
function controlSafe(value, maximum, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || /[\x00-\x1f\x7f]/.test(value)) {
    throw new GrokCapacityError('invalid_options', `${field} is invalid.`);
  }
  return value;
}
function boundedInteger(value, field, minimum, maximum, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GrokCapacityError('invalid_options', `${field} is outside its bounded range.`);
  }
  return value;
}
function authMethodIds(result) {
  const methods = Array.isArray(result?.authMethods) ? result.authMethods : [];
  return methods.map((method) => typeof method === 'string' ? method : method?.id).filter(Boolean);
}
function validInitializeResult(result) {
  return isRecord(result)
    && result.protocolVersion === 1
    && (!Object.hasOwn(result, 'authMethods') || Array.isArray(result.authMethods));
}
function validObjectResult(result) {
  return isRecord(result);
}
function validBillingResult(result) {
  return isRecord(result) && isRecord(result.config);
}
function validUsageResult(result) {
  return isRecord(result) && isRecord(result.usage);
}
function asGrokError(error) {
  if (error instanceof GrokCapacityError) return error;
  if (error instanceof BoundedRpcError) return new GrokCapacityError(error.code, `Grok ACP ${error.code}.`);
  return new GrokCapacityError('capacity_query_failed', 'Grok ACP capacity query failed.');
}
export async function readGrokCapacity(options = {}) {
  const command = controlSafe(options.command ?? 'grok', 256, 'command');
  const timeoutMs = boundedInteger(options.timeout_ms, 'timeout_ms', 100, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = boundedInteger(
    options.max_output_bytes,
    'max_output_bytes',
    1,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const maxLines = boundedInteger(options.max_lines, 'max_lines', 1, DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
  const sessionId = options.session_id === undefined || options.session_id === null
    ? null
    : controlSafe(options.session_id, 256, 'session_id');
  const includeSessionUsage = options.include_session_usage === true && sessionId !== null;
  const transport = new BoundedJsonlRpcTransport({
    provider: 'grok',
    wire: 'jsonrpc2',
    command,
    args: ['agent', 'stdio'],
    cwd: options.cwd ? controlSafe(options.cwd, 4096, 'cwd') : undefined,
    timeoutMs,
    maxOutputBytes,
    maxLines,
    spawnImpl: options.spawn_process,
  });
  let result;
  let failure = null;
  try {
    transport.start();
    const initialize = await transport.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }, { validateResult: validInitializeResult });
    if (options.authenticate_cached !== false && authMethodIds(initialize).includes('cached_token')) {
      await transport.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } }, {
        validateResult: validObjectResult,
      });
    }
    const billing = await transport.request(GROK_BILLING_METHOD, undefined, {
      validateResult: validBillingResult,
    });
    let sessionUsage = null;
    let sessionUsageError = null;
    if (includeSessionUsage) {
      try {
        sessionUsage = await transport.request(GROK_SESSION_USAGE_METHOD, { sessionId }, {
          validateResult: validUsageResult,
        });
      } catch (error) {
        if (error instanceof BoundedRpcError && error.code === 'rpc_error') {
          sessionUsageError = 'unavailable';
        } else {
          sessionUsageError = 'failed';
        }
      }
    }
    const observedMs = observationMilliseconds(options.now ?? Date.now);
    const observationClock = () => observedMs;
    const baseOptions = { now: observationClock };
    const normalizedSessionUsage = sessionUsage === null
      ? null
      : normalizeGrokSessionUsage(sessionUsage, baseOptions);
    const sessionUsageComplete = normalizedSessionUsage !== null
      && normalizedSessionUsage.usage_is_incomplete === false
      && normalizedSessionUsage.cost_is_partial === false;
    result = {
      ...normalizeGrokBilling(billing, baseOptions),
      session_usage: normalizedSessionUsage,
      session_usage_status: includeSessionUsage
        ? (sessionUsageError ?? (sessionUsage === null
          ? 'unknown'
          : sessionUsageComplete ? 'available' : 'partial'))
        : 'not_requested',
    };
  } catch (error) {
    failure = asGrokError(error);
  } finally {
    const drained = await transport.close();
    if (!failure && !drained) failure = new GrokCapacityError('process_cleanup', 'Grok ACP process cleanup failed.');
  }
  if (failure) throw failure;
  return result;
}
