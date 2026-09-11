// UsageLedgerV1 — compact truthful usage receipts with explicit
// source/trust/unknown semantics (ADR 0001 identifiers `exact_identities`,
// `bounded_evidence`, `no_post_dispatch_fallback_or_replay`,
// `sanitized_bounded_evidence_model_facing`; Gate C
// `gate_c_advisory_credit_economics` remains advisory).
//
// Additive v3 module. It records provider-reported input/output/cache tokens
// and cost only when a provider actually reported them, plus deterministic
// host-measured model-facing bytes, retrievable evidence bytes, submissions,
// provider invocations, aggregate waits, attention rounds, tool calls,
// elapsed time, retry/no-replay counts, and Luna/Sol wake events.
// Unknown stays unknown and is never coerced to zero. Receipts are
// append-only, lane-bound to one exact assignment/provider/model/attempt/
// generation/run identity, and monotone. Totals and budget-threshold
// events are derived separately from those receipts: a metric stays
// null/unknown when any included lane lacks it, when attribution cannot
// be proven, or when provider/model token reports are heterogeneous.
// Provider-reported values stay provider-untrusted and are never promoted
// to host-authoritative. Evidence bytes follow the same completeness rule
// — partial lane coverage cannot become an authoritative skip-and-sum
// total. Threshold facts are not wakes: routine deltas never emit events
// and never increment Luna/Sol counters.
//
// This is not a billing system, learned router, sampler, private quota
// scraper, or mutable fail-open counter. There is no filesystem, network,
// clock, process, or provider runtime. Outputs are detached and deeply
// frozen. Secret, transcript, raw identifier, and billing fields are denied.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { MAX_TIMEOUT_MS } from './contract.mjs';
import {
  capturedCreate,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedTest,
  isKnownProvider,
  isModelId,
  knownProvidersJoined,
  sortedCapturedKeys,
} from './grammar.mjs';
import { IDENTITY_LABELS, canonicalExtendedJsonStringify } from './identity.mjs';
import {
  MAX_METRIC_COUNTER,
  TELEMETRY_CORRELATION_SCHEMA_ID,
  correlateTelemetryFieldV1,
  validateDispatchTelemetryV1,
} from './protected-telemetry.mjs';
import {
  MAX_DISPATCH_ATTEMPT,
  MIN_DISPATCH_ATTEMPT,
  assertBoundDigest,
  closedObject,
  fail,
  snapshotRecord,
} from './protected-identity.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  freezeData,
} from './selection-json.mjs';

export const USAGE_LEDGER_SCHEMA_ID = 'codex-co-engineer.usage-ledger.v1';
export const USAGE_RECEIPT_SCHEMA_ID = 'codex-co-engineer.usage-receipt.v1';
export const USAGE_IDENTITY_SCHEMA_ID = 'codex-co-engineer.usage-identity.v1';
export const USAGE_THRESHOLD_EVENT_SCHEMA_ID = 'codex-co-engineer.usage-threshold-event.v1';
export const USAGE_AGGREGATE_SCHEMA_ID = 'codex-co-engineer.usage-aggregate.v1';
export const USAGE_LEDGER_HASH_DOMAIN = 'codex-co-engineer.usage-ledger-hash.v1';
export const USAGE_LEDGER_VERSION = 1;

export const USAGE_SOURCES = capturedFreeze([
  'host_measured', 'provider_report', 'evidence_bytes', 'unknown',
]);
export const USAGE_TRUST_LEVELS = capturedFreeze([
  'host_authoritative', 'provider_untrusted', 'unknown',
]);
export const USAGE_EFFORTS = capturedFreeze(['low', 'high', 'max']);
export const USAGE_AGGREGATE_SCOPES = capturedFreeze([
  'identity', 'run', 'assignment', 'provider',
  'requested_model', 'effective_model', 'requested_effort', 'effective_effort',
]);
export const USAGE_THRESHOLD_SCOPES = capturedFreeze(['identity', 'run']);

export const PROVIDER_USAGE_KEYS = capturedFreeze([
  'input_tokens', 'output_tokens', 'cache_tokens', 'cost_millicents',
]);
export const HOST_USAGE_KEYS = capturedFreeze([
  'model_facing_bytes', 'retrievable_evidence_bytes', 'submissions',
  'provider_invocations', 'aggregate_waits', 'attention_rounds', 'tool_calls',
  'elapsed_ms', 'retry_count', 'no_replay_count', 'luna_wake_events',
  'sol_wake_events',
]);
export const USAGE_BUDGET_METRICS = capturedFreeze([
  ...PROVIDER_USAGE_KEYS, ...HOST_USAGE_KEYS,
]);
export const USAGE_METRIC_KEYS = capturedFreeze(['value', 'source', 'trust']);
export const USAGE_AGGREGATE_METRIC_KEYS = capturedFreeze([
  'value', 'source', 'trust', 'reported_sum', 'reported_count', 'unknown_count',
]);
export const USAGE_IDENTITY_KEYS = capturedFreeze([
  'schema', 'run_id_digest', 'assignment_id_digest', 'attempt', 'generation',
  'provider', 'requested_model_digest', 'effective_model_digest',
  'requested_effort', 'effective_effort', 'digest',
]);
export const USAGE_IDENTITY_INPUT_KEYS = capturedFreeze(
  USAGE_IDENTITY_KEYS.filter((key) => key !== 'schema' && key !== 'digest'),
);
export const USAGE_RECEIPT_KEYS = capturedFreeze([
  'schema', 'seq', 'recorded_at', 'identity', 'provider_usage', 'host_usage', 'digest',
]);
export const USAGE_RECEIPT_INPUT_KEYS = capturedFreeze(
  USAGE_RECEIPT_KEYS.filter((key) => key !== 'schema' && key !== 'digest'),
);
export const USAGE_BUDGET_KEYS = capturedFreeze(['metric', 'threshold']);
export const USAGE_LEDGER_KEYS = capturedFreeze([
  'schema', 'revision', 'budgets', 'receipts', 'totals', 'aggregates',
  'threshold_events', 'digest',
]);
export const USAGE_LEDGER_INPUT_KEYS = capturedFreeze(['budgets']);
export const USAGE_THRESHOLD_EVENT_KEYS = capturedFreeze([
  'schema', 'scope', 'key_digest', 'metric', 'threshold', 'observed',
  'trigger_identity_digest', 'receipt_seq',
]);
export const USAGE_AGGREGATE_ROW_KEYS = capturedFreeze([
  'schema', 'scope', 'key', 'key_digest', 'identity_count',
  'provider_usage', 'host_usage',
]);
export const USAGE_TOTALS_KEYS = capturedFreeze([
  'identity_count', 'observation_count', 'provider_usage', 'host_usage',
]);
export const USAGE_SUMMARY_SCHEMA_ID = 'codex-co-engineer.usage-summary.v1';
export const USAGE_DETAIL_SCHEMA_ID = 'codex-co-engineer.usage-detail.v1';
export const USAGE_REPORT_VIEWS = capturedFreeze(['summary', 'detail']);
export const MAX_USAGE_SUMMARY_BYTES = 1536;
export const MAX_USAGE_SUMMARY_TEXT_BYTES = 512;
export const MAX_USAGE_DETAIL_BYTES = 8192;
export const USAGE_SAVINGS_NONCLAIM = 'not_inferred';
export const USAGE_SUBSCRIPTION_UNKNOWN = 'unknown';
export const USAGE_NATIVE_TOKENS_UNKNOWN = 'unknown';
export const USAGE_TOKEN_TOTALS_COMPARABLE = 'comparable';
export const USAGE_TOKEN_TOTALS_NON_COMPARABLE = 'non_comparable';
export const USAGE_TOKEN_TOTALS_UNKNOWN = 'unknown';
export const USAGE_REPORT_TRUNCATION_REASON = 'report_bound';
export const USAGE_REPORT_TRUNCATION_KEYS = capturedFreeze([
  'fields', 'omitted', 'original_count', 'reason', 'retained', 'truncated',
]);
export const USAGE_SUMMARY_METRIC_KEYS = capturedFreeze([
  'input_tokens', 'output_tokens', 'cache_tokens', 'cost_millicents',
  'model_facing_bytes', 'retrievable_evidence_bytes', 'submissions', 'elapsed_ms',
]);
export const USAGE_METRIC_UNITS = capturedFreeze(Object.assign(capturedCreate(null), {
  input_tokens: 'tokens',
  output_tokens: 'tokens',
  cache_tokens: 'tokens',
  cost_millicents: 'millicents',
  model_facing_bytes: 'bytes',
  retrievable_evidence_bytes: 'bytes',
  submissions: 'count',
  provider_invocations: 'count',
  aggregate_waits: 'count',
  attention_rounds: 'count',
  tool_calls: 'count',
  elapsed_ms: 'milliseconds',
  retry_count: 'count',
  no_replay_count: 'count',
  luna_wake_events: 'count',
  sol_wake_events: 'count',
}));

export const MIN_USAGE_SEQ = 1;
export const MIN_USAGE_GENERATION = 1;
export const MAX_USAGE_RECEIPTS = 128;
export const MAX_USAGE_GENERATION = MAX_USAGE_RECEIPTS;
export const MAX_USAGE_SEQ = MAX_USAGE_RECEIPTS;
export const MAX_USAGE_BUDGETS = 16;
export const MAX_USAGE_THRESHOLD_EVENTS = 64;
export const MAX_USAGE_RECEIPT_BYTES = 2048;
export const MAX_USAGE_LEDGER_BYTES = 131_072;
export const MAX_TOKEN_COUNT = 1_000_000_000;
export const MAX_COST_MILLICENTS = 1_000_000_000_000;
export const MAX_USAGE_BYTES = 1_073_741_824;
export const MAX_USAGE_DURATION_MS = MAX_TIMEOUT_MS;
export const MAX_USAGE_COUNTER = MAX_METRIC_COUNTER;
export const MAX_USAGE_REVISION = MAX_USAGE_RECEIPTS;
export const UNKNOWN_AGGREGATE_KEY = 'unknown';

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CLOCK_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const PROVIDER_METRIC_SOURCES = capturedFreeze(['provider_report', 'unknown']);
const PROVIDER_METRIC_TRUST = capturedFreeze(['provider_untrusted', 'unknown']);
const HOST_METRIC_SOURCES = capturedFreeze(['host_measured', 'unknown']);
const HOST_METRIC_TRUST = capturedFreeze(['host_authoritative', 'unknown']);
const EVIDENCE_METRIC_SOURCES = capturedFreeze(['evidence_bytes', 'unknown']);
const EVIDENCE_METRIC_TRUST = capturedFreeze(['host_authoritative', 'unknown']);
const PROVIDER_METRIC_MAX = capturedFreeze(Object.assign(capturedCreate(null), {
  input_tokens: MAX_TOKEN_COUNT,
  output_tokens: MAX_TOKEN_COUNT,
  cache_tokens: MAX_TOKEN_COUNT,
  cost_millicents: MAX_COST_MILLICENTS,
}));
const HOST_METRIC_MAX = capturedFreeze(Object.assign(capturedCreate(null), {
  model_facing_bytes: MAX_USAGE_BYTES,
  retrievable_evidence_bytes: MAX_USAGE_BYTES,
  submissions: MAX_USAGE_COUNTER,
  provider_invocations: MAX_USAGE_COUNTER,
  aggregate_waits: MAX_USAGE_COUNTER,
  attention_rounds: MAX_USAGE_COUNTER,
  tool_calls: MAX_USAGE_COUNTER,
  elapsed_ms: MAX_USAGE_DURATION_MS,
  retry_count: MAX_USAGE_COUNTER,
  no_replay_count: MAX_USAGE_COUNTER,
  luna_wake_events: MAX_USAGE_COUNTER,
  sol_wake_events: MAX_USAGE_COUNTER,
}));
const PROVIDER_METRIC_SPEC = capturedFreeze(Object.assign(capturedCreate(null), {
  allowedSources: PROVIDER_METRIC_SOURCES,
  allowedTrust: PROVIDER_METRIC_TRUST,
}));
const HOST_MEASURED_SPEC = capturedFreeze(Object.assign(capturedCreate(null), {
  allowedSources: HOST_METRIC_SOURCES,
  allowedTrust: HOST_METRIC_TRUST,
}));
const EVIDENCE_METRIC_SPEC = capturedFreeze(Object.assign(capturedCreate(null), {
  allowedSources: EVIDENCE_METRIC_SOURCES,
  allowedTrust: EVIDENCE_METRIC_TRUST,
}));
const HOST_METRIC_SPEC = capturedFreeze(Object.assign(capturedCreate(null), {
  model_facing_bytes: HOST_MEASURED_SPEC,
  retrievable_evidence_bytes: EVIDENCE_METRIC_SPEC,
  submissions: HOST_MEASURED_SPEC,
  provider_invocations: HOST_MEASURED_SPEC,
  aggregate_waits: HOST_MEASURED_SPEC,
  attention_rounds: HOST_MEASURED_SPEC,
  tool_calls: HOST_MEASURED_SPEC,
  elapsed_ms: HOST_MEASURED_SPEC,
  retry_count: HOST_MEASURED_SPEC,
  no_replay_count: HOST_MEASURED_SPEC,
  luna_wake_events: HOST_MEASURED_SPEC,
  sol_wake_events: HOST_MEASURED_SPEC,
}));
const LOCAL_CONTENT_DENIALS = capturedFreeze(Object.assign(capturedCreate(null), {
  transcript: 'prompt_content_denied',
  transcripts: 'prompt_content_denied',
  rawtranscript: 'prompt_content_denied',
  prompt: 'prompt_content_denied',
  prompts: 'prompt_content_denied',
  secret: 'credential_content_denied',
  billing: 'billing_surface_denied',
  bill: 'billing_surface_denied',
  quota: 'billing_surface_denied',
  invoice: 'billing_surface_denied',
  price: 'billing_surface_denied',
  credit: 'billing_surface_denied',
  credits: 'billing_surface_denied',
  sampler: 'sampler_denied',
  router: 'learned_router_denied',
  raw: 'result_content_denied',
}));

const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const DATE_PARSE = Date.parse;
const DATE_ISO = Date.prototype.toISOString;
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const CREATE_HASH = createHash;
const JSON_PARSE = JSON.parse;
const STRING = String;
const ARRAY_FROM = Array.from;
const MIN_ATTEMPT = MIN_DISPATCH_ATTEMPT;
const MAX_ATTEMPT = MAX_DISPATCH_ATTEMPT;

function usageDigest(label, value) {
  const canonical = canonicalExtendedJsonStringify(value);
  const digest = CREATE_HASH('sha256')
    .update(USAGE_LEDGER_HASH_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(STRING(USAGE_LEDGER_VERSION), 'utf8')
    .update('\n', 'utf8')
    .update(label, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function canonicalEqual(left, right) {
  return canonicalExtendedJsonStringify(left) === canonicalExtendedJsonStringify(right);
}

function assertCount(value, path, { min = 0, max }) {
  if (!NUMBER_IS_SAFE_INTEGER(value) || value < min || value > max) {
    fail('out_of_range', path, `${path} must be a safe integer in ${min}..${max}.`);
  }
}

function assertTimestamp(value, path) {
  if (typeof value !== 'string' || !capturedTest(TIMESTAMP_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a canonical UTC timestamp.`);
  }
  const parsed = DATE_PARSE(value);
  if (!NUMBER_IS_SAFE_INTEGER(parsed) || DATE_ISO.call(new Date(parsed)) !== value) {
    fail('invalid_format', path, `${path} must be a canonical UTC timestamp.`);
  }
  return parsed;
}

function assertEnum(value, allowed, path) {
  if (!capturedIncludes(allowed, value)) {
    fail('invalid_format', path, `${path} is not an allowed value.`);
  }
}

function denyLocalUsageKey(key, path, allowed) {
  if (capturedIncludes(allowed, key)) return;
  const lower = STRING(key).toLowerCase();
  const collapsed = lower.replace(/[^a-z0-9]+/gu, '');
  const code = LOCAL_CONTENT_DENIALS[lower] ?? LOCAL_CONTENT_DENIALS[collapsed];
  if (code) {
    fail(code, `${path}.${key}`,
      `${path}.${key} is denied (${code}); usage records carry counts and digests only.`);
  }
  const tokens = lower.match(/[a-z0-9]+/gu) ?? [];
  for (const token of tokens) {
    const tokenCode = LOCAL_CONTENT_DENIALS[token];
    if (tokenCode) {
      fail(tokenCode, `${path}.${key}`,
        `${path}.${key} is denied (${tokenCode}); usage records carry counts and digests only.`);
    }
  }
}

function closedUsageObject(value, path, allowed, required = allowed) {
  if (value === undefined || value === null) {
    fail('invalid_type', path, `${path} must be a plain JSON data object.`);
  }
  assertDirectJsonClosure(value, path);
  for (const key of sortedCapturedKeys(value)) {
    denyLocalUsageKey(key, path, allowed);
  }
  return closedObject(value, path, allowed, required);
}

function assertDenseArray(value, path, max) {
  assertNotProxy(value, path);
  if (!capturedIsArray(value)) {
    fail('invalid_type', path, `${path} must be a JSON array.`);
  }
  assertDirectJsonClosure(value, path);
  if (value.length > max) {
    fail('out_of_range', path, `${path} exceeds ${max} entries.`);
  }
  return value;
}

function addBounded(left, right, path, max) {
  if (!NUMBER_IS_SAFE_INTEGER(left) || !NUMBER_IS_SAFE_INTEGER(right)) {
    fail('out_of_range', path, `${path} overflowed the safe integer bound.`);
  }
  const sum = left + right;
  if (!NUMBER_IS_SAFE_INTEGER(sum) || sum > max || sum < 0) {
    fail('out_of_range', path, `${path} exceeds ${max}.`);
  }
  return sum;
}

function parseMetric(value, path, spec) {
  const metric = closedUsageObject(value, path, USAGE_METRIC_KEYS);
  const unknown = metric.value === null;
  if (unknown) {
    if (metric.source !== 'unknown' || metric.trust !== 'unknown') {
      fail('identity_mismatch', path,
        'Unknown usage must carry source and trust "unknown"; unknown is never a hidden zero.');
    }
    return { value: null, source: 'unknown', trust: 'unknown' };
  }
  assertCount(metric.value, `${path}.value`, { max: spec.max });
  if (metric.source === 'unknown' || metric.trust === 'unknown') {
    fail('identity_mismatch', path, 'A recorded value cannot be marked unknown.');
  }
  if (!capturedIncludes(spec.allowedSources, metric.source)
    || !capturedIncludes(spec.allowedTrust, metric.trust)) {
    fail('forged_provider_usage', path,
      `${path} mixes provider-reported and host-measured authority.`);
  }
  return {
    value: metric.value,
    source: metric.source,
    trust: metric.trust,
  };
}

function parseUsageGroup(value, path, keys, maxByKey, specByKey) {
  const group = closedUsageObject(value, path, keys);
  const parsed = capturedCreate(null);
  for (const key of keys) {
    const spec = specByKey[key] ?? specByKey;
    parsed[key] = parseMetric(group[key], `${path}.${key}`, {
      allowedSources: spec.allowedSources,
      allowedTrust: spec.allowedTrust,
      max: maxByKey[key],
    });
  }
  return parsed;
}

function parseNullableEffort(value, path) {
  if (value === null) return null;
  assertEnum(value, USAGE_EFFORTS, path);
  return value;
}

function parseNullableDigest(value, path) {
  if (value === null) return null;
  assertBoundDigest(value, path);
  return value;
}

function identityPayload(fields) {
  return {
    schema: USAGE_IDENTITY_SCHEMA_ID,
    run_id_digest: fields.run_id_digest,
    assignment_id_digest: fields.assignment_id_digest,
    attempt: fields.attempt,
    generation: fields.generation,
    provider: fields.provider,
    requested_model_digest: fields.requested_model_digest,
    effective_model_digest: fields.effective_model_digest,
    requested_effort: fields.requested_effort,
    effective_effort: fields.effective_effort,
  };
}

function parseUsageIdentity(value, path = 'identity') {
  const record = closedUsageObject(value, path, USAGE_IDENTITY_KEYS);
  if (record.schema !== USAGE_IDENTITY_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `Usage identity schema must be exactly "${USAGE_IDENTITY_SCHEMA_ID}".`);
  }
  assertBoundDigest(record.run_id_digest, `${path}.run_id_digest`);
  assertBoundDigest(record.assignment_id_digest, `${path}.assignment_id_digest`);
  assertCount(record.attempt, `${path}.attempt`, { min: MIN_ATTEMPT, max: MAX_ATTEMPT });
  assertCount(record.generation, `${path}.generation`, {
    min: MIN_USAGE_GENERATION, max: MAX_USAGE_GENERATION,
  });
  if (!isKnownProvider(record.provider)) {
    fail('unknown_provider', `${path}.provider`,
      `${path}.provider must be exactly one of ${knownProvidersJoined()}.`);
  }
  parseNullableDigest(record.requested_model_digest, `${path}.requested_model_digest`);
  assertBoundDigest(record.effective_model_digest, `${path}.effective_model_digest`);
  parseNullableEffort(record.requested_effort, `${path}.requested_effort`);
  parseNullableEffort(record.effective_effort, `${path}.effective_effort`);
  const payload = identityPayload(record);
  const digest = usageDigest('identity.v1', payload);
  if (record.digest !== digest) {
    fail('identity_mismatch', `${path}.digest`,
      'Usage identity digest does not match the bound identity tuple.');
  }
  return { ...payload, digest };
}

export function validateUsageIdentityV1(value) {
  return snapshotRecord(parseUsageIdentity(value, 'identity'));
}

export function buildUsageIdentityV1(input) {
  const fields = closedUsageObject(input, 'usage_identity_input', USAGE_IDENTITY_INPUT_KEYS);
  const payload = identityPayload({
    run_id_digest: fields.run_id_digest,
    assignment_id_digest: fields.assignment_id_digest,
    attempt: fields.attempt,
    generation: fields.generation,
    provider: fields.provider,
    requested_model_digest: fields.requested_model_digest,
    effective_model_digest: fields.effective_model_digest,
    requested_effort: fields.requested_effort,
    effective_effort: fields.effective_effort,
  });
  return validateUsageIdentityV1({ ...payload, digest: usageDigest('identity.v1', payload) });
}

function parseProviderUsage(value, path) {
  return parseUsageGroup(value, path, PROVIDER_USAGE_KEYS, PROVIDER_METRIC_MAX, PROVIDER_METRIC_SPEC);
}

function parseHostUsage(value, path) {
  return parseUsageGroup(value, path, HOST_USAGE_KEYS, HOST_METRIC_MAX, HOST_METRIC_SPEC);
}

function receiptPayload(fields) {
  return {
    schema: USAGE_RECEIPT_SCHEMA_ID,
    seq: fields.seq,
    recorded_at: fields.recorded_at,
    identity: fields.identity,
    provider_usage: fields.provider_usage,
    host_usage: fields.host_usage,
  };
}

function parseUsageReceipt(value, path = 'receipt') {
  const record = closedUsageObject(value, path, USAGE_RECEIPT_KEYS);
  if (record.schema !== USAGE_RECEIPT_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `Usage receipt schema must be exactly "${USAGE_RECEIPT_SCHEMA_ID}".`);
  }
  assertCount(record.seq, `${path}.seq`, { min: MIN_USAGE_SEQ, max: MAX_USAGE_SEQ });
  assertTimestamp(record.recorded_at, `${path}.recorded_at`);
  const identity = parseUsageIdentity(record.identity, `${path}.identity`);
  const providerUsage = parseProviderUsage(record.provider_usage, `${path}.provider_usage`);
  const hostUsage = parseHostUsage(record.host_usage, `${path}.host_usage`);
  const payload = receiptPayload({
    seq: record.seq,
    recorded_at: record.recorded_at,
    identity,
    provider_usage: providerUsage,
    host_usage: hostUsage,
  });
  const digest = usageDigest('receipt.v1', payload);
  if (record.digest !== digest) {
    fail('identity_mismatch', `${path}.digest`,
      'Usage receipt digest does not match its identity-bound canonical form.');
  }
  const encoded = canonicalExtendedJsonStringify({ ...payload, digest });
  if (BUFFER_BYTE_LENGTH(encoded, 'utf8') > MAX_USAGE_RECEIPT_BYTES) {
    fail('out_of_range', path, `Usage receipt exceeds ${MAX_USAGE_RECEIPT_BYTES} bytes.`);
  }
  return { ...payload, digest };
}

export function validateUsageReceiptV1(value) {
  return snapshotRecord(parseUsageReceipt(value, 'receipt'));
}

export function buildUsageReceiptV1(input) {
  const fields = closedUsageObject(input, 'usage_receipt_input', USAGE_RECEIPT_INPUT_KEYS);
  const identity = buildUsageIdentityV1(fields.identity);
  const providerUsage = parseProviderUsage(fields.provider_usage, 'usage_receipt_input.provider_usage');
  const hostUsage = parseHostUsage(fields.host_usage, 'usage_receipt_input.host_usage');
  const payload = receiptPayload({
    seq: fields.seq,
    recorded_at: fields.recorded_at,
    identity,
    provider_usage: providerUsage,
    host_usage: hostUsage,
  });
  return validateUsageReceiptV1({ ...payload, digest: usageDigest('receipt.v1', payload) });
}

function parseBudget(value, path) {
  const budget = closedUsageObject(value, path, USAGE_BUDGET_KEYS);
  assertEnum(budget.metric, USAGE_BUDGET_METRICS, `${path}.metric`);
  assertCount(budget.threshold, `${path}.threshold`, { min: 1, max: budgetMax(budget.metric) });
  return { metric: budget.metric, threshold: budget.threshold };
}

function budgetMax(metric) {
  return PROVIDER_METRIC_MAX[metric] ?? HOST_METRIC_MAX[metric];
}

function parseBudgets(value, path) {
  const rows = assertDenseArray(value, path, MAX_USAGE_BUDGETS);
  const parsed = [];
  const seen = capturedCreate(null);
  for (let index = 0; index < rows.length; index += 1) {
    const budget = parseBudget(rows[index], `${path}[${index}]`);
    const key = `${budget.metric}:${budget.threshold}`;
    if (seen[key]) {
      fail('duplicate_id', `${path}[${index}]`, 'Budget thresholds must be unique per metric.');
    }
    seen[key] = true;
    parsed.push(budget);
  }
  return parsed;
}

function emptyAggregateMetric() {
  return {
    value: null,
    source: 'unknown',
    trust: 'unknown',
    reported_sum: null,
    reported_count: 0,
    unknown_count: 0,
  };
}

function tokenAttributionKey(identity) {
  return `${identity.provider}\n${identity.effective_model_digest}`;
}

function rollupMetrics(metrics, path, spec, attributionKeys = null) {
  let unknownCount = 0;
  let reportedCount = 0;
  let reportedSum = null;
  let source = null;
  let trust = null;
  let attribution = null;
  let heterogeneous = false;
  for (let index = 0; index < metrics.length; index += 1) {
    const metric = metrics[index];
    if (metric.source === 'unknown') {
      unknownCount += 1;
      continue;
    }
    if (source === null) {
      source = metric.source;
      trust = metric.trust;
    } else if (source !== metric.source || trust !== metric.trust) {
      fail('forged_provider_usage', path,
        `${path} mixes provider-reported and host-measured authority.`);
    }
    if (attributionKeys !== null) {
      const key = attributionKeys[index];
      if (attribution === null) attribution = key;
      else if (attribution !== key) heterogeneous = true;
    }
    reportedCount += 1;
    reportedSum = reportedSum === null
      ? metric.value
      : addBounded(reportedSum, metric.value, path, spec.max);
  }
  const complete = unknownCount === 0 && reportedCount > 0 && heterogeneous === false;
  return {
    value: complete ? reportedSum : null,
    source: complete ? source : 'unknown',
    trust: complete ? trust : 'unknown',
    reported_sum: reportedSum,
    reported_count: reportedCount,
    unknown_count: unknownCount,
  };
}

function rollupUsage(receipts, path) {
  if (receipts.length === 0) {
    const providerUsage = capturedCreate(null);
    const hostUsage = capturedCreate(null);
    for (const key of PROVIDER_USAGE_KEYS) providerUsage[key] = emptyAggregateMetric();
    for (const key of HOST_USAGE_KEYS) hostUsage[key] = emptyAggregateMetric();
    return { provider_usage: providerUsage, host_usage: hostUsage };
  }
  const attributionKeys = receipts.map((receipt) => tokenAttributionKey(receipt.identity));
  const providerUsage = capturedCreate(null);
  const hostUsage = capturedCreate(null);
  for (const key of PROVIDER_USAGE_KEYS) {
    providerUsage[key] = rollupMetrics(
      receipts.map((receipt) => receipt.provider_usage[key]),
      `${path}.provider_usage.${key}`,
      { max: PROVIDER_METRIC_MAX[key] },
      attributionKeys,
    );
  }
  for (const key of HOST_USAGE_KEYS) {
    hostUsage[key] = rollupMetrics(
      receipts.map((receipt) => receipt.host_usage[key]),
      `${path}.host_usage.${key}`,
      { max: HOST_METRIC_MAX[key] },
    );
  }
  return { provider_usage: providerUsage, host_usage: hostUsage };
}

function compareMetric(previous, next, path) {
  if (previous.source !== 'unknown') {
    if (next.source === 'unknown' || next.trust === 'unknown' || next.value === null) {
      fail('identity_mismatch', path, 'A recorded usage fact cannot be forgotten.');
    }
    if (previous.source !== next.source || previous.trust !== next.trust) {
      fail('identity_mismatch', path, 'Usage source and trust are immutable once recorded.');
    }
    if (next.value < previous.value) {
      fail('counter_regressed', path, 'Usage counters cannot decrease.');
    }
  } else if (next.source !== 'unknown' && (next.value === null || next.value < 0)) {
    fail('out_of_range', path, `${path} must be a non-negative recorded value.`);
  }
}

function assertReceiptContinuation(previous, next) {
  if (previous.identity.digest !== next.identity.digest) {
    fail('identity_mismatch', 'receipt.identity',
      'Continuations must keep the exact usage identity tuple.');
  }
  if (next.seq !== previous.seq + 1) {
    if (next.seq <= previous.seq) {
      fail('duplicate_receipt', 'receipt.seq',
        'A usage identity cannot accept a duplicate or earlier sequence.');
    }
    fail('identity_mismatch', 'receipt.seq', 'Usage sequences are dense and append-only.');
  }
  const previousMs = DATE_PARSE(previous.recorded_at);
  const nextMs = DATE_PARSE(next.recorded_at);
  if (nextMs < previousMs) {
    fail('out_of_range', 'receipt.recorded_at', 'Receipt timestamps cannot move backwards.');
  }
  for (const key of PROVIDER_USAGE_KEYS) {
    compareMetric(previous.provider_usage[key], next.provider_usage[key], `provider_usage.${key}`);
  }
  for (const key of HOST_USAGE_KEYS) {
    compareMetric(previous.host_usage[key], next.host_usage[key], `host_usage.${key}`);
  }
  if (previous.host_usage.provider_invocations.source !== 'unknown'
    && previous.host_usage.provider_invocations.value > 0
    && next.host_usage.retry_count.source !== 'unknown'
    && previous.host_usage.retry_count.source !== 'unknown'
    && next.host_usage.retry_count.value > previous.host_usage.retry_count.value) {
    fail('replay_or_fallback_denied', 'host_usage.retry_count',
      'Post-dispatch retries are denied; increment no-replay instead.');
  }
}

function assignmentKey(identity) {
  return `${identity.run_id_digest}\n${identity.assignment_id_digest}`;
}

function visibleKey(scope, identity) {
  switch (scope) {
    case 'identity': return identity.digest;
    case 'run': return identity.run_id_digest;
    case 'assignment': return identity.assignment_id_digest;
    case 'provider': return identity.provider;
    case 'requested_model': return identity.requested_model_digest ?? UNKNOWN_AGGREGATE_KEY;
    case 'effective_model': return identity.effective_model_digest;
    case 'requested_effort': return identity.requested_effort ?? UNKNOWN_AGGREGATE_KEY;
    case 'effective_effort': return identity.effective_effort ?? UNKNOWN_AGGREGATE_KEY;
    default:
      fail('invalid_format', 'aggregates.scope', 'Unknown aggregate scope.');
      return UNKNOWN_AGGREGATE_KEY;
  }
}

function aggregateKeyDigest(scope, identity) {
  return usageDigest('aggregate-key.v1', {
    schema: USAGE_AGGREGATE_SCHEMA_ID,
    scope,
    run_id_digest: identity.run_id_digest,
    assignment_id_digest: scope === 'run' || scope === 'provider'
      || scope === 'requested_model' || scope === 'effective_model'
      || scope === 'requested_effort' || scope === 'effective_effort'
      ? null
      : identity.assignment_id_digest,
    attempt: scope === 'identity' ? identity.attempt : null,
    generation: scope === 'identity' ? identity.generation : null,
    provider: scope === 'identity' || scope === 'provider' ? identity.provider : null,
    requested_model_digest: scope === 'identity' || scope === 'requested_model'
      ? identity.requested_model_digest : null,
    effective_model_digest: scope === 'identity' || scope === 'effective_model'
      ? identity.effective_model_digest : null,
    requested_effort: scope === 'identity' || scope === 'requested_effort'
      ? identity.requested_effort : null,
    effective_effort: scope === 'identity' || scope === 'effective_effort'
      ? identity.effective_effort : null,
  });
}

function compareDigest(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function latestByIdentity(receipts) {
  const latest = new Map();
  for (const receipt of receipts) {
    latest.set(receipt.identity.digest, receipt);
  }
  return ARRAY_FROM(latest.values()).sort((left, right) => (
    compareDigest(left.identity.digest, right.identity.digest)
  ));
}

function groupLatest(latest, scope) {
  const groups = new Map();
  for (const receipt of latest) {
    const keyDigest = aggregateKeyDigest(scope, receipt.identity);
    const current = groups.get(keyDigest);
    if (current) {
      current.receipts.push(receipt);
    } else {
      groups.set(keyDigest, {
        key: visibleKey(scope, receipt.identity),
        key_digest: keyDigest,
        receipts: [receipt],
      });
    }
  }
  return ARRAY_FROM(groups.values()).sort((left, right) => (
    compareDigest(left.key_digest, right.key_digest)
  ));
}

function deriveAggregates(latest) {
  const rows = [];
  for (const scope of USAGE_AGGREGATE_SCOPES) {
    for (const group of groupLatest(latest, scope)) {
      const rolled = rollupUsage(group.receipts, `aggregates.${scope}`);
      rows.push({
        schema: USAGE_AGGREGATE_SCHEMA_ID,
        scope,
        key: group.key,
        key_digest: group.key_digest,
        identity_count: group.receipts.length,
        provider_usage: rolled.provider_usage,
        host_usage: rolled.host_usage,
      });
    }
  }
  return rows;
}

function metricFromUsage(usage, metric) {
  if (capturedIncludes(PROVIDER_USAGE_KEYS, metric)) return usage.provider_usage[metric];
  return usage.host_usage[metric];
}

function deriveThresholdEvents(budgets, receipts) {
  const events = [];
  const seen = capturedCreate(null);
  const latestMap = new Map();
  for (const receipt of receipts) {
    latestMap.set(receipt.identity.digest, receipt);
    const latest = ARRAY_FROM(latestMap.values()).sort((left, right) => (
      compareDigest(left.identity.digest, right.identity.digest)
    ));
    const identityRolled = rollupUsage([receipt], 'threshold.identity');
    const runGroups = new Map();
    for (const current of latest) {
      const runDigest = current.identity.run_id_digest;
      const group = runGroups.get(runDigest);
      if (group) group.push(current);
      else runGroups.set(runDigest, [current]);
    }
    for (const budget of budgets) {
      maybeEmitThreshold(events, seen, budget, 'identity',
        aggregateKeyDigest('identity', receipt.identity), identityRolled, receipt);
      const runReceipts = runGroups.get(receipt.identity.run_id_digest) ?? [receipt];
      const runRolled = rollupUsage(runReceipts, 'threshold.run');
      maybeEmitThreshold(events, seen, budget, 'run',
        aggregateKeyDigest('run', receipt.identity), runRolled, receipt);
    }
  }
  if (events.length > MAX_USAGE_THRESHOLD_EVENTS) {
    fail('out_of_range', 'threshold_events',
      `Usage threshold events exceed ${MAX_USAGE_THRESHOLD_EVENTS}.`);
  }
  return events;
}

function maybeEmitThreshold(events, seen, budget, scope, keyDigest, usage, receipt) {
  const metric = metricFromUsage(usage, budget.metric);
  if (metric.value === null) return;
  if (metric.value < budget.threshold) return;
  const dedupe = `${scope}|${keyDigest}|${budget.metric}|${budget.threshold}`;
  if (seen[dedupe]) return;
  seen[dedupe] = true;
  events.push({
    schema: USAGE_THRESHOLD_EVENT_SCHEMA_ID,
    scope,
    key_digest: keyDigest,
    metric: budget.metric,
    threshold: budget.threshold,
    observed: metric.value,
    trigger_identity_digest: receipt.identity.digest,
    receipt_seq: receipt.seq,
  });
}

function deriveTotals(latest, observationCount) {
  const rolled = rollupUsage(latest, 'totals');
  return {
    identity_count: latest.length,
    observation_count: observationCount,
    provider_usage: rolled.provider_usage,
    host_usage: rolled.host_usage,
  };
}

function snapshotUsageLedger(record) {
  return freezeData(JSON_PARSE(canonicalExtendedJsonStringify(record)));
}

function deriveLedger(revision, budgets, receipts) {
  const latest = latestByIdentity(receipts);
  const aggregates = deriveAggregates(latest);
  const totals = deriveTotals(latest, receipts.length);
  const thresholdEvents = deriveThresholdEvents(budgets, receipts);
  const payload = {
    schema: USAGE_LEDGER_SCHEMA_ID,
    revision,
    budgets,
    receipts,
    totals,
    aggregates,
    threshold_events: thresholdEvents,
  };
  const digest = usageDigest('ledger.v1', payload);
  const record = { ...payload, digest };
  const encoded = canonicalExtendedJsonStringify(record);
  if (BUFFER_BYTE_LENGTH(encoded, 'utf8') > MAX_USAGE_LEDGER_BYTES) {
    fail('out_of_range', 'ledger', `Usage ledger exceeds ${MAX_USAGE_LEDGER_BYTES} bytes.`);
  }
  return record;
}

function assertAttemptOrder(receipts, next) {
  let maxAttempt = 0;
  for (const receipt of receipts) {
    if (assignmentKey(receipt.identity) !== assignmentKey(next.identity)) continue;
    if (receipt.identity.attempt > maxAttempt) maxAttempt = receipt.identity.attempt;
  }
  if (maxAttempt === 0) {
    return;
  }
  if (next.identity.attempt < maxAttempt) {
    fail('stale_attempt', 'identity.attempt',
      'A lower dispatch attempt cannot be recorded after a newer attempt.');
  }
  if (next.identity.attempt > maxAttempt + 1) {
    fail('stale_attempt', 'identity.attempt', 'Dispatch attempts must be dense.');
  }
}

function assertGenerationOrder(receipts, next) {
  let maxGeneration = 0;
  for (const receipt of receipts) {
    if (assignmentKey(receipt.identity) !== assignmentKey(next.identity)) continue;
    if (receipt.identity.generation > maxGeneration) maxGeneration = receipt.identity.generation;
  }
  if (maxGeneration === 0) {
    return;
  }
  if (next.identity.generation < maxGeneration) {
    fail('stale_generation', 'identity.generation',
      'A lower usage generation cannot be recorded after a newer generation.');
  }
  if (next.identity.generation > maxGeneration + 1) {
    fail('stale_generation', 'identity.generation', 'Usage generations must be dense.');
  }
}

function assertReceiptAppend(previousReceipts, next) {
  assertAttemptOrder(previousReceipts, next);
  assertGenerationOrder(previousReceipts, next);
  let previousForIdentity = null;
  for (const receipt of previousReceipts) {
    if (receipt.digest === next.digest) {
      fail('duplicate_receipt', 'receipt.digest', 'Usage receipts are append-only and unique.');
    }
    if (receipt.identity.digest === next.identity.digest) previousForIdentity = receipt;
  }
  if (previousForIdentity === null) {
    if (next.seq !== MIN_USAGE_SEQ) {
      fail('identity_mismatch', 'receipt.seq',
        'The first receipt for a usage identity must start at sequence 1.');
    }
    return;
  }
  assertReceiptContinuation(previousForIdentity, next);
}

function parseUsageLedger(value, path = 'ledger') {
  // Apply the ledger's fixed extended complexity cap before any schema walk.
  canonicalExtendedJsonStringify(value);
  const record = closedUsageObject(value, path, USAGE_LEDGER_KEYS);
  if (record.schema !== USAGE_LEDGER_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `Usage ledger schema must be exactly "${USAGE_LEDGER_SCHEMA_ID}".`);
  }
  assertCount(record.revision, `${path}.revision`, {
    min: 0, max: MAX_USAGE_REVISION,
  });
  const budgets = parseBudgets(record.budgets, `${path}.budgets`);
  const receiptRows = assertDenseArray(record.receipts, `${path}.receipts`, MAX_USAGE_RECEIPTS);
  if (record.revision !== receiptRows.length) {
    fail('identity_mismatch', `${path}.revision`,
      'Ledger revision must equal the append-only receipt count.');
  }
  const receipts = [];
  for (let index = 0; index < receiptRows.length; index += 1) {
    const receipt = parseUsageReceipt(receiptRows[index], `${path}.receipts[${index}]`);
    assertReceiptAppend(receipts, receipt);
    receipts.push(receipt);
  }
  const derived = deriveLedger(record.revision, budgets, receipts);
  if (!canonicalEqual(derived.totals, record.totals)
    || !canonicalEqual(derived.aggregates, record.aggregates)
    || !canonicalEqual(derived.threshold_events, record.threshold_events)) {
    fail('identity_mismatch', path,
      'Ledger totals, aggregates, and threshold events must match the receipts.');
  }
  if (record.digest !== derived.digest) {
    fail('identity_mismatch', `${path}.digest`,
      'Usage ledger digest does not match its canonical derived form.');
  }
  return derived;
}

export function validateUsageLedgerV1(value) {
  return snapshotUsageLedger(parseUsageLedger(value, 'ledger'));
}

export function openUsageLedgerV1(input) {
  const fields = closedUsageObject(input, 'usage_ledger_input', USAGE_LEDGER_INPUT_KEYS);
  const budgets = parseBudgets(fields.budgets, 'usage_ledger_input.budgets');
  return snapshotUsageLedger(deriveLedger(0, budgets, []));
}

export function appendUsageReceiptV1(previousValue, observation) {
  const previous = validateUsageLedgerV1(previousValue);
  const nextReceipt = buildUsageReceiptV1(observation);
  if (previous.receipts.length > 0) {
    const head = previous.receipts[previous.receipts.length - 1];
    if (canonicalEqual(head, nextReceipt)) return previous;
  }
  if (previous.receipts.length >= MAX_USAGE_RECEIPTS) {
    fail('out_of_range', 'receipts', `Usage ledger exceeds ${MAX_USAGE_RECEIPTS} receipts.`);
  }
  assertReceiptAppend(previous.receipts, nextReceipt);
  const receipts = [...previous.receipts, nextReceipt];
  return snapshotUsageLedger(deriveLedger(previous.revision + 1, previous.budgets, receipts));
}

export function assertUsageLedgerContinuityV1(previousValue, nextValue) {
  const previous = validateUsageLedgerV1(previousValue);
  const next = validateUsageLedgerV1(nextValue);
  if (next.revision === previous.revision) {
    if (!canonicalEqual(previous, next)) {
      fail('identity_mismatch', 'ledger.revision',
        'An equal revision demands canonical byte identity.');
    }
    return true;
  }
  if (next.revision !== previous.revision + 1) {
    if (next.revision < previous.revision) {
      fail('revision_regressed', 'ledger.revision', 'Usage ledger revision regressed.');
    }
    fail('identity_mismatch', 'ledger.revision', 'Usage ledger revisions increase by one.');
  }
  if (!canonicalEqual(previous.budgets, next.budgets)) {
    fail('identity_mismatch', 'ledger.budgets', 'Usage budgets are immutable.');
  }
  if (next.receipts.length !== previous.receipts.length + 1) {
    fail('identity_mismatch', 'ledger.receipts', 'Usage receipts are append-only.');
  }
  for (let index = 0; index < previous.receipts.length; index += 1) {
    if (!canonicalEqual(previous.receipts[index], next.receipts[index])) {
      fail('identity_mismatch', `ledger.receipts[${index}]`,
        'Prior usage receipts cannot be rewritten.');
    }
  }
  if (next.threshold_events.length < previous.threshold_events.length) {
    fail('counter_regressed', 'ledger.threshold_events',
      'Threshold events are append-only.');
  }
  for (let index = 0; index < previous.threshold_events.length; index += 1) {
    if (!canonicalEqual(previous.threshold_events[index], next.threshold_events[index])) {
      fail('identity_mismatch', `ledger.threshold_events[${index}]`,
        'Prior threshold events cannot be rewritten.');
    }
  }
  return true;
}

export function usageIdentityFromTelemetryV1(telemetryValue, efforts) {
  const telemetry = validateDispatchTelemetryV1(telemetryValue);
  const fields = closedUsageObject(efforts, 'usage_efforts', capturedFreeze([
    'requested_effort', 'effective_effort', 'generation',
  ]), capturedFreeze(['requested_effort', 'effective_effort']));
  return buildUsageIdentityV1({
    run_id_digest: telemetry.run_id_digest,
    assignment_id_digest: telemetry.assignment_id_digest,
    attempt: telemetry.attempt,
    generation: fields.generation === undefined ? MIN_USAGE_GENERATION : fields.generation,
    provider: telemetry.provider,
    requested_model_digest: telemetry.requested_model_digest,
    effective_model_digest: telemetry.resolved_model_digest,
    requested_effort: fields.requested_effort,
    effective_effort: fields.effective_effort,
  });
}

export function assertUsageMatchesTelemetryV1(telemetryValue, identityValue) {
  const telemetry = validateDispatchTelemetryV1(telemetryValue);
  const identity = validateUsageIdentityV1(identityValue);
  const expected = usageIdentityFromTelemetryV1(telemetry, {
    requested_effort: identity.requested_effort,
    effective_effort: identity.effective_effort,
    generation: identity.generation,
  });
  if (identity.digest !== expected.digest
    || identity.run_id_digest !== telemetry.run_id_digest
    || identity.assignment_id_digest !== telemetry.assignment_id_digest
    || identity.attempt !== telemetry.attempt
    || identity.generation !== expected.generation
    || identity.provider !== telemetry.provider
    || identity.requested_model_digest !== telemetry.requested_model_digest
    || identity.effective_model_digest !== telemetry.resolved_model_digest) {
    fail('identity_mismatch', 'usage.identity',
      'Usage identity does not match the bound dispatch telemetry.');
  }
  return true;
}

export function unknownUsageMetricV1() {
  return { value: null, source: 'unknown', trust: 'unknown' };
}

export function providerReportedMetricV1(value) {
  if (value === null || value === undefined) return unknownUsageMetricV1();
  return { value, source: 'provider_report', trust: 'provider_untrusted' };
}

export function hostMeasuredMetricV1(value) {
  if (value === null || value === undefined) return unknownUsageMetricV1();
  return { value, source: 'host_measured', trust: 'host_authoritative' };
}

export function evidenceBytesMetricV1(value) {
  if (value === null || value === undefined) return unknownUsageMetricV1();
  return { value, source: 'evidence_bytes', trust: 'host_authoritative' };
}

export function unknownProviderUsageV1() {
  const group = capturedCreate(null);
  for (const key of PROVIDER_USAGE_KEYS) group[key] = unknownUsageMetricV1();
  return group;
}

export function unknownHostUsageV1() {
  const group = capturedCreate(null);
  for (const key of HOST_USAGE_KEYS) group[key] = unknownUsageMetricV1();
  return group;
}

export function canonicalUsageTimestampV1(value, path = 'recorded_at') {
  if (typeof value === 'number' && NUMBER_IS_SAFE_INTEGER(value) && value >= 0) {
    const iso = DATE_ISO.call(new Date(value));
    assertTimestamp(iso, path);
    return iso;
  }
  if (typeof value === 'string') {
    if (capturedTest(TIMESTAMP_PATTERN, value)) {
      assertTimestamp(value, path);
      return value;
    }
    if (capturedTest(CLOCK_SECONDS_PATTERN, value)) {
      const iso = `${value.slice(0, -1)}.000Z`;
      assertTimestamp(iso, path);
      return iso;
    }
  }
  fail('invalid_format', path, `${path} must be a canonical UTC timestamp.`);
}

export function correlateUsageModelV1(provider, model) {
  if (model === null) return null;
  return correlateTelemetryFieldV1(
    IDENTITY_LABELS.PROVIDER_RUN_IDENTITY,
    'model',
    model,
    { provider },
  );
}

export function correlateUsageAssignmentV1(assignmentId) {
  return correlateTelemetryFieldV1(
    IDENTITY_LABELS.CHILD_IDENTITY,
    'assignment_id',
    assignmentId,
  );
}

function latestReceiptForIdentity(receipts, digest) {
  let latest = null;
  for (const receipt of receipts) {
    if (receipt.identity.digest === digest) latest = receipt;
  }
  return latest;
}

function wrapProviderPatch(value) {
  if (value === undefined) return undefined;
  if (value === null) return unknownUsageMetricV1();
  if (value && typeof value === 'object') return value;
  return providerReportedMetricV1(value);
}

function wrapHostPatch(value, key) {
  if (value === undefined) return undefined;
  if (value === null) return unknownUsageMetricV1();
  if (value && typeof value === 'object') return value;
  if (key === 'retrievable_evidence_bytes') return evidenceBytesMetricV1(value);
  return hostMeasuredMetricV1(value);
}

function mergeUsageGroup(previous, patch, keys, wrap) {
  const merged = capturedCreate(null);
  const source = previous ?? capturedCreate(null);
  const overlay = patch ?? capturedCreate(null);
  for (const key of keys) {
    const next = capturedHasOwn(overlay, key) ? wrap(overlay[key], key) : undefined;
    merged[key] = next === undefined ? (source[key] ?? unknownUsageMetricV1()) : next;
  }
  return merged;
}

const RUNTIME_USAGE_OBSERVATION_KEYS = capturedFreeze([
  'telemetry', 'recorded_at', 'requested_effort', 'effective_effort', 'generation',
  'assignment_id', 'provider', 'model', 'provider_usage', 'host_usage',
]);
const RUNTIME_USAGE_OBSERVATION_REQUIRED = capturedFreeze(['telemetry', 'recorded_at']);

function parseLaneAttribution(fields, path) {
  const hasAssignment = fields.assignment_id !== undefined;
  const hasProvider = fields.provider !== undefined;
  const hasModel = fields.model !== undefined;
  if (!hasAssignment && !hasProvider && !hasModel) return null;
  if (!hasAssignment || !hasProvider || !hasModel) {
    fail('identity_mismatch', path,
      'Lane usage attribution requires exact assignment_id, provider, and model.');
  }
  if (typeof fields.assignment_id !== 'string' || fields.assignment_id.length < 1) {
    fail('invalid_format', `${path}.assignment_id`,
      `${path}.assignment_id must be a non-empty assignment identifier.`);
  }
  if (!isKnownProvider(fields.provider)) {
    fail('unknown_provider', `${path}.provider`,
      `${path}.provider must be exactly one of ${knownProvidersJoined()}.`);
  }
  if (!isModelId(fields.model)) {
    fail('invalid_format', `${path}.model`,
      `${path}.model must be a bounded model identifier.`);
  }
  return {
    assignment_id: fields.assignment_id,
    provider: fields.provider,
    model: fields.model,
  };
}

function usageIdentityFromRuntimeObservation(telemetry, efforts, lane) {
  const base = usageIdentityFromTelemetryV1(telemetry, efforts);
  if (lane === null) return base;
  return buildUsageIdentityV1({
    run_id_digest: base.run_id_digest,
    assignment_id_digest: correlateUsageAssignmentV1(lane.assignment_id),
    attempt: base.attempt,
    generation: base.generation,
    provider: lane.provider,
    requested_model_digest: correlateUsageModelV1(lane.provider, lane.model),
    effective_model_digest: correlateUsageModelV1(lane.provider, lane.model),
    requested_effort: base.requested_effort,
    effective_effort: base.effective_effort,
  });
}

export function recordRuntimeUsageObservationV1(previousValue, observation) {
  const previous = previousValue == null
    ? openUsageLedgerV1({ budgets: [] })
    : validateUsageLedgerV1(previousValue);
  const fields = closedUsageObject(
    observation,
    'runtime_usage_observation',
    RUNTIME_USAGE_OBSERVATION_KEYS,
    RUNTIME_USAGE_OBSERVATION_REQUIRED,
  );
  const efforts = {
    requested_effort: fields.requested_effort ?? null,
    effective_effort: fields.effective_effort ?? null,
  };
  if (fields.generation !== undefined) efforts.generation = fields.generation;
  const identity = usageIdentityFromRuntimeObservation(
    fields.telemetry,
    efforts,
    parseLaneAttribution(fields, 'runtime_usage_observation'),
  );
  const latest = latestReceiptForIdentity(previous.receipts, identity.digest);
  const providerUsage = mergeUsageGroup(
    latest?.provider_usage, fields.provider_usage, PROVIDER_USAGE_KEYS, wrapProviderPatch,
  );
  const hostUsage = mergeUsageGroup(
    latest?.host_usage, fields.host_usage, HOST_USAGE_KEYS, wrapHostPatch,
  );
  if (latest
    && canonicalEqual(latest.provider_usage, providerUsage)
    && canonicalEqual(latest.host_usage, hostUsage)) {
    return previous;
  }
  return appendUsageReceiptV1(previous, {
    seq: latest === null ? MIN_USAGE_SEQ : latest.seq + 1,
    recorded_at: canonicalUsageTimestampV1(
      fields.recorded_at, 'runtime_usage_observation.recorded_at',
    ),
    identity: {
      run_id_digest: identity.run_id_digest,
      assignment_id_digest: identity.assignment_id_digest,
      attempt: identity.attempt,
      generation: identity.generation,
      provider: identity.provider,
      requested_model_digest: identity.requested_model_digest,
      effective_model_digest: identity.effective_model_digest,
      requested_effort: identity.requested_effort,
      effective_effort: identity.effective_effort,
    },
    provider_usage: providerUsage,
    host_usage: hostUsage,
  });
}

function metricUnit(key) {
  return USAGE_METRIC_UNITS[key] ?? 'count';
}

function metricFromTotals(totals, key) {
  if (capturedIncludes(PROVIDER_USAGE_KEYS, key)) return totals.provider_usage[key];
  return totals.host_usage[key];
}

function labeledMetric(key, metric) {
  const unknown = metric == null || metric.source === 'unknown' || metric.value === null;
  return {
    key,
    value: unknown ? null : metric.value,
    unit: metricUnit(key),
    source: unknown ? 'unknown' : metric.source,
    trust: unknown ? 'unknown' : metric.trust,
  };
}

function detailedMetric(key, metric) {
  const labeled = labeledMetric(key, metric);
  return {
    ...labeled,
    reported_sum: metric?.reported_sum ?? null,
    reported_count: NUMBER_IS_SAFE_INTEGER(metric?.reported_count) ? metric.reported_count : 0,
    unknown_count: NUMBER_IS_SAFE_INTEGER(metric?.unknown_count) ? metric.unknown_count : 0,
  };
}

function clipUsageText(text, maxBytes) {
  if (BUFFER_BYTE_LENGTH(text, 'utf8') <= maxBytes) return text;
  const encoded = NodeBuffer.from(text, 'utf8');
  let end = maxBytes - 3;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString('utf8')}…`;
}

function formatMetricPhrase(metric) {
  const value = STRING(metric.value);
  if (metric.key === 'submissions') return `${value} submission${metric.value === 1 ? '' : 's'}`;
  if (metric.key === 'elapsed_ms') return `${value} ms elapsed`;
  if (metric.key === 'input_tokens') return `${value} input tokens`;
  if (metric.key === 'output_tokens') return `${value} output tokens`;
  if (metric.key === 'cache_tokens') return `${value} cached tokens`;
  const label = STRING(metric.key).split('_').join(' ');
  const unit = metric.unit === 'count' ? '' : ` ${metric.unit}`;
  return `${label}: ${value}${unit}`;
}

function tokenComparability(totals) {
  let reportedGroups = 0;
  let knownTotal = false;
  for (const key of PROVIDER_USAGE_KEYS) {
    const metric = totals.provider_usage[key];
    if (metric.value !== null) knownTotal = true;
    if (NUMBER_IS_SAFE_INTEGER(metric.reported_count) && metric.reported_count > 0) {
      if (metric.value === null && metric.unknown_count === 0 && metric.reported_count > 1) {
        reportedGroups = metric.reported_count;
      }
    }
  }
  if (knownTotal) return USAGE_TOKEN_TOTALS_COMPARABLE;
  if (reportedGroups > 1) return USAGE_TOKEN_TOTALS_NON_COMPARABLE;
  return USAGE_TOKEN_TOTALS_UNKNOWN;
}

function compactProviderGroups(aggregates) {
  if (!capturedIsArray(aggregates)) return [];
  const groups = [];
  for (let index = 0; index < aggregates.length; index += 1) {
    const row = aggregates[index];
    if (row == null || row.scope !== 'provider') continue;
    const metrics = [];
    for (const key of PROVIDER_USAGE_KEYS) {
      metrics.push(labeledMetric(key, row.provider_usage?.[key]));
    }
    groups.push({
      scope: 'provider',
      key: row.key,
      identity_count: NUMBER_IS_SAFE_INTEGER(row.identity_count) ? row.identity_count : 0,
      metrics,
    });
  }
  return groups;
}

function compactUsageText(metrics, unknownKeys, present, comparability) {
  const closing = 'Native token balance is unknown. Savings are not inferred.';
  if (present !== true) {
    return `No usage recorded. ${closing}`;
  }
  const parts = [];
  if (comparability === USAGE_TOKEN_TOTALS_NON_COMPARABLE) {
    parts.push('Provider token totals are not comparable across providers.');
  }
  const providerKnown = [];
  const hostKnown = [];
  for (const metric of metrics) {
    if (metric.value === null || metric.source === 'unknown') continue;
    if (metric.source === 'provider_report') providerKnown.push(metric);
    else hostKnown.push(metric);
  }
  if (providerKnown.length > 0 && comparability !== USAGE_TOKEN_TOTALS_NON_COMPARABLE) {
    parts.push(`Provider-reported ${providerKnown.map(formatMetricPhrase).join(', ')}.`);
  } else if (providerKnown.length === 0 && unknownKeys.some((key) => capturedIncludes(PROVIDER_USAGE_KEYS, key))) {
    parts.push('Provider-reported tokens are unknown.');
  }
  if (hostKnown.length > 0) {
    parts.push(`Host-measured ${hostKnown.map(formatMetricPhrase).join(', ')}.`);
  }
  parts.push(closing);
  return parts.join(' ');
}

function collectMetrics(totals, keys, detailed) {
  const metrics = [];
  const unknown = [];
  for (const key of keys) {
    const metric = metricFromTotals(totals, key);
    const row = detailed ? detailedMetric(key, metric) : labeledMetric(key, metric);
    if (row.source === 'unknown' || row.value === null) {
      unknown.push(key);
      if (detailed) metrics.push(row);
    } else {
      metrics.push(row);
    }
  }
  return { metrics, unknown };
}

function emptyTruncation(count) {
  return {
    truncated: false,
    fields: [],
    original_count: count,
    retained: count,
    omitted: 0,
    reason: null,
  };
}

function reportTruncation(fields, originalCount, retained) {
  return {
    truncated: true,
    fields,
    original_count: originalCount,
    retained,
    omitted: originalCount > retained ? originalCount - retained : 0,
    reason: USAGE_REPORT_TRUNCATION_REASON,
  };
}

function usageReportBytes(record) {
  return BUFFER_BYTE_LENGTH(canonicalExtendedJsonStringify(record), 'utf8');
}

function compactMetricRow(row) {
  return {
    key: row.key,
    value: row.value,
    unit: row.unit,
    source: row.source,
    trust: row.trust,
  };
}

function fitUsageReport(record, maxBytes) {
  const originalMetricCount = capturedIsArray(record.metrics) ? record.metrics.length : 0;
  const originalGroupCount = capturedIsArray(record.groups) ? record.groups.length : 0;
  const originalCount = originalMetricCount + originalGroupCount;
  if (usageReportBytes(record) <= maxBytes) {
    return record.truncation == null
      ? { ...record, truncation: emptyTruncation(originalCount) }
      : record;
  }
  const fields = [];
  let current = { ...record };
  const clipTo = (limit) => {
    const nextText = clipUsageText(current.text, limit);
    if (nextText !== current.text) {
      if (!capturedIncludes(fields, 'text')) fields.push('text');
      current = { ...current, text: nextText };
    }
  };
  clipTo(240);
  if (usageReportBytes({
    ...current,
    truncation: reportTruncation(fields.length > 0 ? fields : ['text'], originalCount, originalCount),
  }) <= maxBytes) {
    return {
      ...current,
      truncation: reportTruncation(fields, originalCount, originalCount),
    };
  }
  if (capturedIsArray(current.groups) && current.groups.length > 0) {
    fields.push('groups');
    current = { ...current, groups: [] };
  }
  clipTo(120);
  const compactMetrics = [];
  for (let index = 0; index < current.metrics.length; index += 1) {
    compactMetrics.push(compactMetricRow(current.metrics[index]));
  }
  if (compactMetrics.length !== current.metrics.length
    || (current.metrics[0] && current.metrics[0].reported_sum !== undefined)) {
    fields.push('metrics');
  }
  current = { ...current, metrics: compactMetrics };
  const tryRecord = (next, retained) => {
    const truncation = reportTruncation(
      fields.length > 0 ? fields : ['metrics'],
      originalCount,
      retained,
    );
    const candidate = { ...next, truncation };
    return usageReportBytes(candidate) <= maxBytes ? candidate : null;
  };
  const fittedCompact = tryRecord(current, originalCount);
  if (fittedCompact) return fittedCompact;
  const known = [];
  for (let index = 0; index < current.metrics.length; index += 1) {
    if (current.metrics[index].value !== null && current.metrics[index].source !== 'unknown') {
      known.push(current.metrics[index]);
    }
  }
  if (!capturedIncludes(fields, 'metrics')) fields.push('metrics');
  while (known.length > 0) {
    const retainedRows = current.view === 'detail'
      ? [...known, ...current.metrics.filter((row) => row.value === null || row.source === 'unknown')]
      : known;
    const fitted = tryRecord({ ...current, metrics: retainedRows }, retainedRows.length);
    if (fitted) return fitted;
    known.pop();
  }
  const unknownOnly = current.view === 'detail'
    ? current.metrics.filter((row) => row.value === null || row.source === 'unknown')
    : [];
  current = {
    ...current,
    metrics: unknownOnly,
    text: clipUsageText(current.text, 80),
  };
  if (!capturedIncludes(fields, 'text')) fields.push('text');
  const minimal = tryRecord(current, unknownOnly.length);
  if (minimal) return minimal;
  const lastResort = {
    schema: current.schema,
    view: current.view,
    present: current.present,
    identities: current.identities,
    observations: current.observations,
    metrics: [],
    unknown: current.unknown,
    savings: current.savings,
    subscription: current.subscription,
    token_totals: current.token_totals,
    text: clipUsageText(
      current.present === true
        ? 'Usage recorded; retrieve detail. Native token balance is unknown. Savings are not inferred.'
        : 'No usage recorded. Native token balance is unknown. Savings are not inferred.',
      120,
    ),
    truncation: reportTruncation(['metrics', 'text', 'groups'], originalCount, 0),
  };
  if (current.view === 'detail') lastResort.native_tokens = USAGE_NATIVE_TOKENS_UNKNOWN;
  if (usageReportBytes(lastResort) <= maxBytes) return lastResort;
  lastResort.text = clipUsageText('Usage truncated. Native tokens unknown.', 48);
  if (usageReportBytes(lastResort) <= maxBytes) return lastResort;
  lastResort.unknown = current.unknown.slice(0, 8);
  lastResort.truncation = reportTruncation(['metrics', 'text', 'groups', 'unknown'], originalCount, 0);
  return lastResort;
}

function snapshotUsageReport(record, maxBytes, path) {
  const fitted = fitUsageReport(record, maxBytes);
  const encoded = canonicalExtendedJsonStringify(fitted);
  if (BUFFER_BYTE_LENGTH(encoded, 'utf8') > maxBytes) {
    fail('out_of_range', path, `Usage ${record.view} report exceeds ${maxBytes} bytes.`);
  }
  return freezeData(JSON_PARSE(encoded));
}

function emptyUnknownTotals() {
  const providerUsage = capturedCreate(null);
  const hostUsage = capturedCreate(null);
  for (const key of PROVIDER_USAGE_KEYS) providerUsage[key] = emptyAggregateMetric();
  for (const key of HOST_USAGE_KEYS) hostUsage[key] = emptyAggregateMetric();
  return { provider_usage: providerUsage, host_usage: hostUsage };
}

function buildUsageReport(view, totals, aggregates, present) {
  const detailed = view === 'detail';
  const keys = detailed ? USAGE_BUDGET_METRICS : USAGE_SUMMARY_METRIC_KEYS;
  const { metrics, unknown } = collectMetrics(totals, keys, detailed);
  const comparability = present === true ? tokenComparability(totals) : USAGE_TOKEN_TOTALS_UNKNOWN;
  const groups = detailed && present === true ? compactProviderGroups(aggregates) : [];
  const knownForText = metrics.filter((row) => row.value !== null && row.source !== 'unknown');
  const record = {
    schema: detailed ? USAGE_DETAIL_SCHEMA_ID : USAGE_SUMMARY_SCHEMA_ID,
    view,
    present,
    identities: present === true ? totals.identity_count : null,
    observations: present === true ? totals.observation_count : null,
    metrics,
    unknown,
    savings: USAGE_SAVINGS_NONCLAIM,
    subscription: USAGE_SUBSCRIPTION_UNKNOWN,
    token_totals: comparability,
    text: clipUsageText(
      compactUsageText(knownForText, unknown, present, comparability),
      detailed ? 480 : MAX_USAGE_SUMMARY_TEXT_BYTES,
    ),
  };
  if (detailed) {
    record.native_tokens = USAGE_NATIVE_TOKENS_UNKNOWN;
    record.groups = groups;
  }
  return record;
}

export function unknownUsageReportV1(view = 'summary') {
  assertEnum(view, USAGE_REPORT_VIEWS, 'usage_report.view');
  return snapshotUsageReport(
    buildUsageReport(view, emptyUnknownTotals(), [], false),
    view === 'detail' ? MAX_USAGE_DETAIL_BYTES : MAX_USAGE_SUMMARY_BYTES,
    'usage_report',
  );
}

export function summarizeUsageLedgerV1(ledgerValue) {
  if (ledgerValue == null) return unknownUsageReportV1('summary');
  const ledger = validateUsageLedgerV1(ledgerValue);
  return snapshotUsageReport(
    buildUsageReport('summary', ledger.totals, ledger.aggregates, true),
    MAX_USAGE_SUMMARY_BYTES,
    'usage_summary',
  );
}

export function detailUsageLedgerV1(ledgerValue) {
  if (ledgerValue == null) return unknownUsageReportV1('detail');
  const ledger = validateUsageLedgerV1(ledgerValue);
  return snapshotUsageReport(
    buildUsageReport('detail', ledger.totals, ledger.aggregates, true),
    MAX_USAGE_DETAIL_BYTES,
    'usage_detail',
  );
}

export function projectUsageReportV1(ledgerValue, options) {
  const view = options == null ? 'summary' : options.view;
  const selected = view == null ? 'summary' : view;
  assertEnum(selected, USAGE_REPORT_VIEWS, 'usage_report.view');
  if (ledgerValue == null) return unknownUsageReportV1(selected);
  const ledger = validateUsageLedgerV1(ledgerValue);
  const maxBytes = selected === 'detail'
    ? (NUMBER_IS_SAFE_INTEGER(options?.max_bytes) ? options.max_bytes : MAX_USAGE_DETAIL_BYTES)
    : (NUMBER_IS_SAFE_INTEGER(options?.max_bytes) ? options.max_bytes : MAX_USAGE_SUMMARY_BYTES);
  const bound = selected === 'detail' ? MAX_USAGE_DETAIL_BYTES : MAX_USAGE_SUMMARY_BYTES;
  return snapshotUsageReport(
    buildUsageReport(selected, ledger.totals, ledger.aggregates, true),
    maxBytes < 1 ? bound : (maxBytes > bound ? bound : maxBytes),
    selected === 'detail' ? 'usage_detail' : 'usage_summary',
  );
}

capturedFreeze(validateUsageIdentityV1);
capturedFreeze(buildUsageIdentityV1);
capturedFreeze(validateUsageReceiptV1);
capturedFreeze(buildUsageReceiptV1);
capturedFreeze(validateUsageLedgerV1);
capturedFreeze(openUsageLedgerV1);
capturedFreeze(appendUsageReceiptV1);
capturedFreeze(assertUsageLedgerContinuityV1);
capturedFreeze(usageIdentityFromTelemetryV1);
capturedFreeze(assertUsageMatchesTelemetryV1);
capturedFreeze(unknownUsageMetricV1);
capturedFreeze(providerReportedMetricV1);
capturedFreeze(hostMeasuredMetricV1);
capturedFreeze(evidenceBytesMetricV1);
capturedFreeze(unknownProviderUsageV1);
capturedFreeze(unknownHostUsageV1);
capturedFreeze(canonicalUsageTimestampV1);
capturedFreeze(correlateUsageModelV1);
capturedFreeze(correlateUsageAssignmentV1);
capturedFreeze(recordRuntimeUsageObservationV1);
capturedFreeze(unknownUsageReportV1);
capturedFreeze(summarizeUsageLedgerV1);
capturedFreeze(detailUsageLedgerV1);
capturedFreeze(projectUsageReportV1);

export { IDENTITY_LABELS, TELEMETRY_CORRELATION_SCHEMA_ID };
