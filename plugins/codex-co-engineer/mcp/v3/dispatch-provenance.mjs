// DispatchProvenanceV1 — bounded, content-free run identity and telemetry.
// Pure additive contracts only: runtime integration belongs to later R1 PRs.

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ASSIGNMENT_ID_PATTERN, ASSIGNMENT_ROLES, EVIDENCE_KINDS, MAX_TIMEOUT_MS,
  MODEL_ID_PATTERN, PROVIDERS, SHA40_PATTERN, RunContractV1Error, assertBaseSha,
  assertJsonDataObject, assertManifestComplexity, assertRepositoryPath, assertRunId,
} from './run-manifest.mjs';
import { canonicalJsonStringify } from './identity.mjs';

export const RUN_IDENTITY_SCHEMA_ID = 'codex-co-engineer.run-identity.v1', CHILD_IDENTITY_SCHEMA_ID = 'codex-co-engineer.child-identity.v1',
  DISPATCH_IDENTITY_SCHEMA_ID = 'codex-co-engineer.dispatch-identity.v1', PROVIDER_RUN_IDENTITY_SCHEMA_ID = 'codex-co-engineer.provider-run-identity.v1',
  DISPATCH_PROVENANCE_SCHEMA_ID = 'codex-co-engineer.dispatch-provenance.v1', DISPATCH_TELEMETRY_SCHEMA_ID = 'codex-co-engineer.dispatch-telemetry.v1';

export const SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY = 'selected_external_provider_full_repository';
export const REQUEST_IDEMPOTENCY_DOMAIN = 'codex-co-engineer.request-idempotency.v1';
export const REQUEST_IDEMPOTENCY_KEY_PATTERN = /^idem-v1-[0-9a-f]{64}$/u;
export const DIGEST64_PATTERN = /^[0-9a-f]{64}$/u;
export const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/u;
export const MAX_DISPATCH_ATTEMPT = Number.MAX_SAFE_INTEGER, MAX_RECORD_REVISION = Number.MAX_SAFE_INTEGER,
  MAX_METRIC_COUNTER = Number.MAX_SAFE_INTEGER, MAX_DURATION_MS = MAX_TIMEOUT_MS, MAX_TELEMETRY_BYTES = 4096;

export const PROVIDER_DRIVERS = Object.freeze(Object.assign(Object.create(null), {
  grok: 'acp', 'cursor-local': 'acp', dsh: 'acpx', 'cursor-cloud': 'cloud-sdk',
}));
export const DISPATCH_OUTCOMES = Object.freeze(['pending', 'dispatch_uncertain', 'needs_attention',
  'transport_lost', 'succeeded', 'failed', 'cancelled', 'timed_out', 'environment_blocked']);
export const SETTLED_DISPATCH_OUTCOMES = Object.freeze(
  ['succeeded', 'failed', 'cancelled', 'timed_out', 'environment_blocked']);
export const MODEL_MISMATCH_STATUSES = Object.freeze(
  ['none', 'served_model_not_observed', 'observed_model_divergence']);
export const ATTESTATION_METHODS = Object.freeze(['independent_provider_query', 'provider_runtime_report']);

const RUN_KEYS = ['schema', 'run_id', 'repository_path', 'base_sha', 'manifest_digest'];
const CHILD_KEYS = ['schema', 'run_id', 'assignment_id'];
const DISPATCH_KEYS = ['schema', 'run_id', 'assignment_id', 'attempt'];
const PROVIDER_RUN_KEYS = ['schema', 'provider', 'driver', 'run_id', 'assignment_id',
  'repository_path', 'base_sha', 'request_idempotency_key', 'agent_id', 'provider_run_id'];
const IDEMPOTENCY_KEYS = ['run_id', 'assignment_id', 'repository_path', 'base_sha'];

function fail(code, path, message) { throw new RunContractV1Error(code, path, message); }

function closed(value, path, allowed, required = allowed) {
  assertManifestComplexity(value);
  const entries = assertJsonDataObject(value, path);
  const allowedSet = new Set(allowed);
  const snapshot = {};
  for (const { key, value: entryValue } of entries) {
    if (!allowedSet.has(key)) fail('unknown_key', `${path}.${key}`, `${path}.${key} is not allowed.`);
    snapshot[key] = entryValue;
  }
  for (const key of required) {
    if (!Object.hasOwn(snapshot, key)) fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
  }
  return snapshot;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function detached(value) { return deepFreeze(JSON.parse(canonicalJsonStringify(value))); }

function assertAssignmentId(value, path) { if (typeof value !== 'string' || !ASSIGNMENT_ID_PATTERN.test(value)) fail('invalid_format', path, `${path} must match ${ASSIGNMENT_ID_PATTERN.source}.`); }

function assertDigest(value, path) {
  if (typeof value !== 'string' || !DIGEST64_PATTERN.test(value)) fail('invalid_format', path, `${path} must be a lowercase SHA-256 digest.`);
}

function assertCount(value, path, { min = 0, max = MAX_METRIC_COUNTER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('out_of_range', path, `${path} must be a safe integer in ${min}..${max}.`);
}

function assertNullableRef(value, path) {
  if (value !== null && (typeof value !== 'string' || !PROVIDER_REF_PATTERN.test(value))) fail('invalid_format', path, `${path} must be null or a bounded provider identifier.`);
}

function assertProvider(value, path) { if (!PROVIDERS.includes(value)) fail('unknown_provider', path, `${path} names an unknown provider.`); }

function assertProviderRunTuple(value, path) {
  assertProvider(value.provider, `${path}.provider`);
  const driver = PROVIDER_DRIVERS[value.provider];
  if (value.driver !== driver) {
    fail('identity_mismatch', `${path}.driver`, `${path}.driver must be ${driver}.`);
  }
  assertRunId(value.run_id, `${path}.run_id`);
  assertAssignmentId(value.assignment_id, `${path}.assignment_id`);
  assertRepositoryPath(value.repository_path, `${path}.repository_path`);
  assertBaseSha(value.base_sha, `${path}.base_sha`);
  assertNullableRef(value.agent_id, `${path}.agent_id`);
  assertNullableRef(value.provider_run_id, `${path}.provider_run_id`);
  validateRequestIdempotencyKeyV1(value.request_idempotency_key, {
    run_id: value.run_id,
    assignment_id: value.assignment_id,
    repository_path: value.repository_path,
    base_sha: value.base_sha,
  }, `${path}.request_idempotency_key`);
}

export function validateRunIdentityV1(value) {
  const record = closed(value, 'run', RUN_KEYS);
  if (record.schema !== RUN_IDENTITY_SCHEMA_ID) fail('invalid_format', 'run.schema', 'Invalid run identity schema.');
  assertRunId(record.run_id, 'run.run_id');
  assertRepositoryPath(record.repository_path, 'run.repository_path');
  assertBaseSha(record.base_sha, 'run.base_sha');
  assertDigest(record.manifest_digest, 'run.manifest_digest');
  return true;
}

export function buildRunIdentityV1(input) {
  const value = closed(input, 'run_input', RUN_KEYS.slice(1));
  const record = { schema: RUN_IDENTITY_SCHEMA_ID, ...value };
  validateRunIdentityV1(record); return detached(record);
}

export function validateChildIdentityV1(value) {
  const record = closed(value, 'child', CHILD_KEYS);
  if (record.schema !== CHILD_IDENTITY_SCHEMA_ID) fail('invalid_format', 'child.schema', 'Invalid child identity schema.');
  assertRunId(record.run_id, 'child.run_id');
  assertAssignmentId(record.assignment_id, 'child.assignment_id');
  return true;
}

export function buildChildIdentityV1(input) {
  const value = closed(input, 'child_input', CHILD_KEYS.slice(1));
  const record = { schema: CHILD_IDENTITY_SCHEMA_ID, ...value };
  validateChildIdentityV1(record); return detached(record);
}

export function validateDispatchIdentityV1(value) {
  const record = closed(value, 'dispatch', DISPATCH_KEYS);
  if (record.schema !== DISPATCH_IDENTITY_SCHEMA_ID) fail('invalid_format', 'dispatch.schema', 'Invalid dispatch identity schema.');
  assertRunId(record.run_id, 'dispatch.run_id');
  assertAssignmentId(record.assignment_id, 'dispatch.assignment_id');
  assertCount(record.attempt, 'dispatch.attempt', { min: 1, max: MAX_DISPATCH_ATTEMPT });
  return true;
}

export function buildDispatchIdentityV1(input) {
  const value = closed(input, 'dispatch_input', DISPATCH_KEYS.slice(1));
  const record = { schema: DISPATCH_IDENTITY_SCHEMA_ID, ...value };
  validateDispatchIdentityV1(record); return detached(record);
}

export function deriveRequestIdempotencyKeyV1(input) {
  const tuple = closed(input, 'idempotency_tuple', IDEMPOTENCY_KEYS);
  assertRunId(tuple.run_id, 'idempotency_tuple.run_id');
  assertAssignmentId(tuple.assignment_id, 'idempotency_tuple.assignment_id');
  assertRepositoryPath(tuple.repository_path, 'idempotency_tuple.repository_path');
  assertBaseSha(tuple.base_sha, 'idempotency_tuple.base_sha');
  const hash = createHash('sha256');
  hash.update(REQUEST_IDEMPOTENCY_DOMAIN, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(canonicalJsonStringify(tuple), 'utf8');
  return `idem-v1-${hash.digest('hex')}`;
}

export function validateRequestIdempotencyKeyV1(key, tuple, path = 'request_idempotency_key') {
  if (typeof key !== 'string' || !REQUEST_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    fail('invalid_format', path, `${path} must be a derived v1 idempotency key.`);
  }
  const expected = deriveRequestIdempotencyKeyV1(
    closed(tuple, 'idempotency_tuple', IDEMPOTENCY_KEYS),
  );
  if (!timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    fail('identity_mismatch', path, `${path} does not bind the exact run, child, repository, and base SHA.`);
  }
  return true;
}

export function validateProviderRunIdentityV1(value) {
  const record = closed(value, 'provider_run', PROVIDER_RUN_KEYS);
  if (record.schema !== PROVIDER_RUN_IDENTITY_SCHEMA_ID) {
    fail('invalid_format', 'provider_run.schema', 'Invalid provider-run identity schema.');
  }
  assertProviderRunTuple(record, 'provider_run');
  return true;
}

export function buildProviderRunIdentityV1(input) {
  const required = PROVIDER_RUN_KEYS.slice(1).filter((key) => !['driver', 'agent_id', 'provider_run_id'].includes(key));
  const value = closed(input, 'provider_run_input', PROVIDER_RUN_KEYS.slice(1).filter((key) => key !== 'driver'), required);
  const record = {
    schema: PROVIDER_RUN_IDENTITY_SCHEMA_ID,
    ...value,
    driver: PROVIDER_DRIVERS[value.provider],
    agent_id: value.agent_id ?? null,
    provider_run_id: value.provider_run_id ?? null,
  };
  validateProviderRunIdentityV1(record); return detached(record);
}

const PROVENANCE_KEYS = ['schema', 'revision', 'run', 'child', 'dispatch', 'provider_run',
  'requested', 'resolved', 'observed', 'model_mismatch', 'model_attestation',
  'repository_exposure', 'lineage', 'timing', 'counters', 'outcome', 'provider_claims', 'verified_facts'];
const REQUESTED_KEYS = ['provider', 'model'];
const RESOLVED_KEYS = ['provider', 'model', 'role'];
const OBSERVED_KEYS = ['provider', 'model'];
const ATTESTATION_KEYS = ['model', 'method'];
const LINEAGE_KEYS = ['manifest_digest', 'resolved_plan_digest', 'prompt_envelope_digest'];
const TIMING_KEYS = ['opened_at', 'dispatched_at', 'settled_at', 'dispatch_latency_ms', 'total_duration_ms'];
const COUNTER_KEYS = ['dispatch_calls', 'wake_events', 'outcome_events'];
const CLAIM_KEYS = ['claimed_model', 'claimed_outcome', 'claimed_head_sha'];
const FACT_KEYS = ['base_sha_observed', 'head_sha_observed', 'evidence_kinds'];
const TELEMETRY_KEYS = ['schema', 'revision', 'run_id', 'assignment_id', 'attempt', 'provider',
  'driver', 'requested_model', 'resolved_model', 'observed_model', 'model_attested',
  'model_mismatch', 'agent_ref', 'request_idempotency_key', 'outcome', 'repository_exposure',
  'lineage', 'timing', 'counters'];
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function assertEnum(value, allowed, path) { if (!allowed.includes(value)) fail('invalid_format', path, `${path} is not an allowed value.`); }

function assertModel(value, path, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !MODEL_ID_PATTERN.test(value)) fail('invalid_format', path, `${path} must be a bounded model identifier${nullable ? ' or null' : ''}.`);
}

function assertNullableSha(value, path) {
  if (value !== null && (typeof value !== 'string' || !SHA40_PATTERN.test(value))) fail('invalid_format', path, `${path} must be an exact lowercase commit SHA or null.`);
}

function assertTimestamp(value, path, nullable = true) {
  if (nullable && value === null) return null;
  let canonical = null;
  try {
    canonical = typeof value === 'string' ? new Date(value).toISOString() : null;
  } catch {
    canonical = null;
  }
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value) || canonical !== value) {
    fail('invalid_format', path, `${path} must be a canonical UTC timestamp${nullable ? ' or null' : ''}.`);
  }
  return Date.parse(value);
}

function validateExecutionSections(requestedValue, resolvedValue, observedValue) {
  const requested = closed(requestedValue, 'requested', REQUESTED_KEYS);
  const resolved = closed(resolvedValue, 'resolved', RESOLVED_KEYS);
  const observed = closed(observedValue, 'observed', OBSERVED_KEYS);
  if (requested.provider !== null) assertProvider(requested.provider, 'requested.provider');
  assertModel(requested.model, 'requested.model', true);
  assertProvider(resolved.provider, 'resolved.provider');
  assertModel(resolved.model, 'resolved.model');
  assertEnum(resolved.role, ASSIGNMENT_ROLES, 'resolved.role');
  if (observed.provider !== null) assertProvider(observed.provider, 'observed.provider');
  assertModel(observed.model, 'observed.model', true);
  if (observed.provider === null && observed.model !== null) {
    fail('identity_mismatch', 'observed.model', 'An observed model requires an observed provider.');
  }
  if (requested.provider === null && requested.model !== null) {
    fail('identity_mismatch', 'requested.model', 'A requested model requires a requested provider.');
  }
  if (requested.provider !== null && requested.provider !== resolved.provider) {
    fail('identity_mismatch', 'requested.provider', 'Requested and resolved providers differ.');
  }
  if (requested.model !== null && requested.model !== resolved.model) {
    fail('identity_mismatch', 'requested.model', 'Requested and resolved models differ.');
  }
  if (observed.provider !== null && observed.provider !== resolved.provider) {
    fail('identity_mismatch', 'observed.provider', 'Observed and resolved providers differ.');
  }
  return { requested, resolved, observed };
}

function validateTimingAndCounters(timingValue, countersValue, outcome, attempt, prefix = 'provenance') {
  const timing = closed(timingValue, `${prefix}.timing`, TIMING_KEYS);
  const counters = closed(countersValue, `${prefix}.counters`, COUNTER_KEYS);
  const openedMs = assertTimestamp(timing.opened_at, `${prefix}.timing.opened_at`, false);
  const dispatchedMs = assertTimestamp(timing.dispatched_at, `${prefix}.timing.dispatched_at`);
  const settledMs = assertTimestamp(timing.settled_at, `${prefix}.timing.settled_at`);
  for (const key of ['dispatch_latency_ms', 'total_duration_ms']) {
    if (timing[key] !== null) assertCount(timing[key], `${prefix}.timing.${key}`, { max: MAX_DURATION_MS });
  }
  assertCount(counters.dispatch_calls, `${prefix}.counters.dispatch_calls`, { max: 1 });
  assertCount(counters.wake_events, `${prefix}.counters.wake_events`);
  assertCount(counters.outcome_events, `${prefix}.counters.outcome_events`);
  if (dispatchedMs !== null && dispatchedMs < openedMs) fail('out_of_range', `${prefix}.timing.dispatched_at`, 'Dispatch precedes open.');
  if (settledMs !== null && settledMs < (dispatchedMs ?? openedMs)) fail('out_of_range', `${prefix}.timing.settled_at`, 'Settlement precedes dispatch.');
  if (timing.dispatch_latency_ms !== null
    && (dispatchedMs === null || timing.dispatch_latency_ms !== dispatchedMs - openedMs)) {
    fail('lifecycle_conflict', `${prefix}.timing.dispatch_latency_ms`, 'Dispatch latency disagrees with its endpoints.');
  }
  if (timing.total_duration_ms !== null
    && (settledMs === null || timing.total_duration_ms !== settledMs - openedMs)) {
    fail('lifecycle_conflict', `${prefix}.timing.total_duration_ms`, 'Total duration disagrees with its endpoints.');
  }
  if (counters.dispatch_calls > attempt) fail('replay_or_fallback_denied', `${prefix}.counters.dispatch_calls`, 'Dispatch calls exceed the recorded attempt.');
  if (dispatchedMs !== null && counters.dispatch_calls !== 1) fail('lifecycle_conflict', `${prefix}.counters.dispatch_calls`, 'A dispatch timestamp requires one call.');
  const settled = SETTLED_DISPATCH_OUTCOMES.includes(outcome);
  if (settled !== (timing.settled_at !== null)) fail('lifecycle_conflict', `${prefix}.timing.settled_at`, 'Settled time and outcome disagree.');
  if (settled && counters.outcome_events < 1) fail('lifecycle_conflict', `${prefix}.counters.outcome_events`, 'A settled outcome requires an outcome event.');
  if (outcome === 'succeeded' && (timing.dispatched_at === null || counters.dispatch_calls !== 1)) {
    fail('lifecycle_conflict', `${prefix}.outcome`, 'Success requires exactly one recorded dispatch.');
  }
  if (outcome === 'dispatch_uncertain' && counters.dispatch_calls !== 1) {
    fail('lifecycle_conflict', `${prefix}.outcome`, 'Dispatch uncertainty requires exactly one attempted dispatch.');
  }
  return { timing, counters };
}

function validateLineage(value, path = 'lineage') {
  const lineage = closed(value, path, LINEAGE_KEYS);
  for (const key of LINEAGE_KEYS) assertDigest(lineage[key], `${path}.${key}`);
  return lineage;
}

function validateModelEvidence(record, resolved, observed) {
  assertEnum(record.model_mismatch, MODEL_MISMATCH_STATUSES, 'provenance.model_mismatch');
  let attestation = null;
  if (record.model_attestation !== null) {
    attestation = closed(record.model_attestation, 'model_attestation', ATTESTATION_KEYS);
    assertModel(attestation.model, 'model_attestation.model');
    assertEnum(attestation.method, ATTESTATION_METHODS, 'model_attestation.method');
    if (observed.model === null || attestation.model !== observed.model) {
      fail('identity_mismatch', 'model_attestation.model', 'Attestation must bind the observed model.');
    }
  }
  if (record.model_mismatch === 'served_model_not_observed'
    && (observed.model !== null || attestation !== null)) {
    fail('identity_mismatch', 'provenance.model_mismatch', 'Unobserved status requires null observation and attestation.');
  }
  if (record.model_mismatch === 'observed_model_divergence'
    && (observed.model === null || observed.model === resolved.model || attestation === null)) {
    fail('identity_mismatch', 'provenance.model_mismatch', 'Divergence requires an attested, different observed model.');
  }
  if (record.model_mismatch === 'none'
    && (observed.model !== resolved.model || attestation === null)) {
    fail('identity_mismatch', 'provenance.model_mismatch', 'No mismatch requires the exact attested resolved model.');
  }
  if (record.outcome === 'succeeded' && record.model_mismatch !== 'none') {
    fail('model_unverified', 'provenance.outcome', 'Success requires an exact attested model match.');
  }
  return attestation;
}

export function validateDispatchProvenanceV1(value) {
  const record = closed(value, 'provenance', PROVENANCE_KEYS);
  if (record.schema !== DISPATCH_PROVENANCE_SCHEMA_ID) fail('invalid_format', 'provenance.schema', 'Invalid provenance schema.');
  assertCount(record.revision, 'provenance.revision', { min: 1, max: MAX_RECORD_REVISION });
  validateRunIdentityV1(record.run);
  validateChildIdentityV1(record.child);
  validateDispatchIdentityV1(record.dispatch);
  validateProviderRunIdentityV1(record.provider_run);
  const { resolved, observed } = validateExecutionSections(record.requested, record.resolved, record.observed);
  assertEnum(record.outcome, DISPATCH_OUTCOMES, 'provenance.outcome');
  validateTimingAndCounters(record.timing, record.counters, record.outcome, record.dispatch.attempt);
  const lineage = validateLineage(record.lineage);
  validateModelEvidence(record, resolved, observed);
  if (record.repository_exposure !== SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY) {
    fail('invalid_format', 'provenance.repository_exposure', 'Repository exposure is fixed by the R1 threat model.');
  }
  const claims = closed(record.provider_claims, 'provider_claims', CLAIM_KEYS);
  assertModel(claims.claimed_model, 'provider_claims.claimed_model', true);
  if (claims.claimed_outcome !== null) assertEnum(claims.claimed_outcome, DISPATCH_OUTCOMES, 'provider_claims.claimed_outcome');
  assertNullableSha(claims.claimed_head_sha, 'provider_claims.claimed_head_sha');
  const facts = closed(record.verified_facts, 'verified_facts', FACT_KEYS);
  assertNullableSha(facts.base_sha_observed, 'verified_facts.base_sha_observed');
  assertNullableSha(facts.head_sha_observed, 'verified_facts.head_sha_observed');
  if (!Array.isArray(facts.evidence_kinds) || new Set(facts.evidence_kinds).size !== facts.evidence_kinds.length
    || facts.evidence_kinds.some((kind) => !EVIDENCE_KINDS.includes(kind))) {
    fail('invalid_format', 'verified_facts.evidence_kinds', 'Evidence kinds must be a unique closed list.');
  }
  const same = (left, right, path) => {
    if (left !== right) fail('identity_mismatch', path, `${path} does not match the bound identity.`);
  };
  same(record.child.run_id, record.run.run_id, 'child.run_id');
  same(record.dispatch.run_id, record.run.run_id, 'dispatch.run_id');
  same(record.dispatch.assignment_id, record.child.assignment_id, 'dispatch.assignment_id');
  same(record.provider_run.run_id, record.run.run_id, 'provider_run.run_id');
  same(record.provider_run.assignment_id, record.child.assignment_id, 'provider_run.assignment_id');
  same(record.provider_run.repository_path, record.run.repository_path, 'provider_run.repository_path');
  same(record.provider_run.base_sha, record.run.base_sha, 'provider_run.base_sha');
  same(record.provider_run.provider, resolved.provider, 'provider_run.provider');
  same(lineage.manifest_digest, record.run.manifest_digest, 'lineage.manifest_digest');
  if (facts.base_sha_observed !== null) same(facts.base_sha_observed, record.run.base_sha, 'verified_facts.base_sha_observed');
  if (record.outcome === 'succeeded'
    && record.provider_run.agent_id === null && record.provider_run.provider_run_id === null) {
    fail('missing_key', 'provider_run', 'Success requires a provider-issued identifier.');
  }
  return true;
}

export function buildDispatchProvenanceV1(input) {
  const value = closed(input, 'provenance_input', PROVENANCE_KEYS.slice(1));
  const record = { schema: DISPATCH_PROVENANCE_SCHEMA_ID, ...value };
  validateDispatchProvenanceV1(record); return detached(record);
}

export function assertDispatchProvenanceRevisionProgressionV1(previous, next) {
  validateDispatchProvenanceV1(previous);
  validateDispatchProvenanceV1(next);
  for (const key of ['run', 'child', 'dispatch']) {
    if (canonicalJsonStringify(previous[key]) !== canonicalJsonStringify(next[key])) {
      fail('identity_mismatch', `provenance.${key}`, 'A revision cannot change protected identity.');
    }
  }
  const stableProviderRun = ({ agent_id: _agentId, provider_run_id: _runId, ...identity }) => identity;
  if (canonicalJsonStringify(stableProviderRun(previous.provider_run))
    !== canonicalJsonStringify(stableProviderRun(next.provider_run))) {
    fail('identity_mismatch', 'provenance.provider_run', 'A revision cannot change the provider-run tuple.');
  }
  for (const key of ['agent_id', 'provider_run_id']) {
    if (previous.provider_run[key] !== null && next.provider_run[key] !== previous.provider_run[key]) {
      fail('identity_mismatch', `provenance.provider_run.${key}`, 'A reconciled provider identifier is immutable.');
    }
  }
  if (next.revision < previous.revision) fail('revision_regressed', 'provenance.revision', 'Revision regressed.');
  if (next.revision === previous.revision
    && canonicalJsonStringify(previous) !== canonicalJsonStringify(next)) {
    fail('revision_conflict', 'provenance.revision', 'The same revision must be byte-identical.');
  }
  if (SETTLED_DISPATCH_OUTCOMES.includes(previous.outcome) && next.outcome !== previous.outcome) {
    fail('terminal_outcome_changed', 'provenance.outcome', 'A settled outcome is absorbing.');
  }
  if (SETTLED_DISPATCH_OUTCOMES.includes(previous.outcome)
    && next.timing.settled_at !== previous.timing.settled_at) {
    fail('terminal_outcome_changed', 'provenance.timing.settled_at', 'A settled instant is immutable.');
  }
  return true;
}

export function projectDispatchTelemetryV1(record) {
  validateDispatchProvenanceV1(record);
  const view = detached({
    schema: DISPATCH_TELEMETRY_SCHEMA_ID,
    revision: record.revision,
    run_id: record.run.run_id,
    assignment_id: record.child.assignment_id,
    attempt: record.dispatch.attempt,
    provider: record.resolved.provider,
    driver: record.provider_run.driver,
    requested_model: record.requested.model,
    resolved_model: record.resolved.model,
    observed_model: record.observed.model,
    model_attested: record.model_attestation !== null,
    model_mismatch: record.model_mismatch,
    agent_ref: record.provider_run.provider_run_id ?? record.provider_run.agent_id,
    request_idempotency_key: record.provider_run.request_idempotency_key,
    outcome: record.outcome,
    repository_exposure: record.repository_exposure,
    lineage: record.lineage,
    timing: record.timing,
    counters: record.counters,
  });
  validateDispatchTelemetryV1(view);
  return view;
}

export function validateDispatchTelemetryV1(value) {
  const view = closed(value, 'telemetry', TELEMETRY_KEYS);
  if (view.schema !== DISPATCH_TELEMETRY_SCHEMA_ID) fail('invalid_format', 'telemetry.schema', 'Invalid telemetry schema.');
  assertCount(view.revision, 'telemetry.revision', { min: 1, max: MAX_RECORD_REVISION });
  assertRunId(view.run_id, 'telemetry.run_id');
  assertAssignmentId(view.assignment_id, 'telemetry.assignment_id');
  assertCount(view.attempt, 'telemetry.attempt', { min: 1, max: MAX_DISPATCH_ATTEMPT });
  assertProvider(view.provider, 'telemetry.provider');
  if (view.driver !== PROVIDER_DRIVERS[view.provider]) fail('identity_mismatch', 'telemetry.driver', 'Telemetry driver disagrees with provider.');
  assertModel(view.requested_model, 'telemetry.requested_model', true);
  assertModel(view.resolved_model, 'telemetry.resolved_model');
  assertModel(view.observed_model, 'telemetry.observed_model', true);
  if (typeof view.model_attested !== 'boolean') fail('invalid_type', 'telemetry.model_attested', 'model_attested must be boolean.');
  assertEnum(view.model_mismatch, MODEL_MISMATCH_STATUSES, 'telemetry.model_mismatch');
  assertNullableRef(view.agent_ref, 'telemetry.agent_ref');
  if (typeof view.request_idempotency_key !== 'string' || !REQUEST_IDEMPOTENCY_KEY_PATTERN.test(view.request_idempotency_key)) {
    fail('invalid_format', 'telemetry.request_idempotency_key', 'Invalid telemetry idempotency key.');
  }
  assertEnum(view.outcome, DISPATCH_OUTCOMES, 'telemetry.outcome');
  if (view.repository_exposure !== SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY) fail('invalid_format', 'telemetry.repository_exposure', 'Invalid repository exposure.');
  validateLineage(view.lineage, 'telemetry.lineage');
  validateTimingAndCounters(view.timing, view.counters, view.outcome, view.attempt, 'telemetry');
  if (view.model_attested !== (view.observed_model !== null)
    || (view.model_mismatch === 'none' && view.observed_model !== view.resolved_model)
    || (view.model_mismatch === 'served_model_not_observed' && view.observed_model !== null)
    || (view.model_mismatch === 'observed_model_divergence'
      && (view.observed_model === null || view.observed_model === view.resolved_model))) {
    fail('identity_mismatch', 'telemetry.model_mismatch', 'Telemetry model evidence is inconsistent.');
  }
  if (Buffer.byteLength(canonicalJsonStringify(view), 'utf8') > MAX_TELEMETRY_BYTES) {
    fail('out_of_range', 'telemetry', `Telemetry exceeds ${MAX_TELEMETRY_BYTES} bytes.`);
  }
  return true;
}

export { ASSIGNMENT_ROLES, ATTESTATION_METHODS as MODEL_ATTESTATION_METHODS, EVIDENCE_KINDS };
