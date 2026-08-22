// ProtectedTelemetryV1 — monotonic, content-free provenance and telemetry
// (ADR 0001 identifiers `exact_identities`, `bounded_evidence`,
// `no_post_dispatch_fallback_or_replay`; Gate A
// `gate_a_exact_run_child_provider_workspace_git_identity`;
// threat-model `full_repository_provider_exposure`,
// `sanitized_bounded_evidence_model_facing`).
//
// Additive v3 module. It composes ProtectedIdentityV1 records into one
// DispatchProvenanceV1 fact set and a content-free DispatchTelemetryV1 view.
// Protected facts cannot be dropped or rewritten: null-to-value fills are
// allowed once; counters and revisions are monotone; settled outcomes are
// absorbing. Exact journal CAS/stepping belongs to P25; evidence claims
// belong to P13; provider-to-driver mapping belongs to P17.
//
// Telemetry never serializes raw run/child identifiers, models, paths,
// prompts, results, credentials, provider-issued references, or idempotency
// keys. Variable identity appears only as P03 `sha256:<hex>` correlation
// digests. There is no filesystem, network, process, or provider runtime.

import { MAX_TIMEOUT_MS } from './contract.mjs';
import {
  capturedFreeze,
  capturedIncludes,
  capturedJoin,
  capturedTest,
  isKnownProvider,
  isKnownRole,
  isModelId,
  knownProvidersJoined,
  knownRolesJoined,
  modelIdGrammarSource,
} from './grammar.mjs';
import { IDENTITY_LABELS, canonicalJsonStringify } from './identity.mjs';
import {
  CHILD_IDENTITY_SCHEMA_ID,
  DISPATCH_ATTEMPT_SCHEMA_ID,
  GIT_IDENTITY_SCHEMA_ID,
  MAX_DISPATCH_ATTEMPT,
  MIN_DISPATCH_ATTEMPT,
  PROVIDER_RUN_IDENTITY_SCHEMA_ID,
  RUN_IDENTITY_SCHEMA_ID,
  WORKSPACE_IDENTITY_SCHEMA_ID,
  assertBoundDigest,
  assertHexDigest,
  bindDigest,
  closedObject,
  fail,
  snapshotRecord,
  validateChildIdentityV1,
  validateDispatchAttemptV1,
  validateGitIdentityV1,
  validateProviderRunIdentityV1,
  validateRunIdentityV1,
  validateWorkspaceIdentityV1,
} from './protected-identity.mjs';
import { identityBoundDigest } from './selection-json.mjs';

export const DISPATCH_PROVENANCE_SCHEMA_ID = 'codex-co-engineer.dispatch-provenance.v1';
export const DISPATCH_TELEMETRY_SCHEMA_ID = 'codex-co-engineer.dispatch-telemetry.v1';
export const TELEMETRY_CORRELATION_SCHEMA_ID = 'codex-co-engineer.telemetry-correlation.v1';
export const SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY = 'selected_external_provider_full_repository';

export const MIN_RECORD_REVISION = 1;
export const MAX_RECORD_REVISION = 16;
export const MAX_METRIC_COUNTER = 100_000;
export const MAX_DURATION_MS = MAX_TIMEOUT_MS;
export const MAX_TELEMETRY_BYTES = 4096;

export const DISPATCH_OUTCOMES = capturedFreeze([
  'pending', 'dispatch_uncertain', 'needs_attention', 'transport_lost',
  'succeeded', 'failed', 'cancelled', 'timed_out', 'environment_blocked',
]);
export const SETTLED_DISPATCH_OUTCOMES = capturedFreeze([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'environment_blocked',
]);
export const MODEL_MISMATCH_STATUSES = capturedFreeze([
  'none', 'served_model_not_observed', 'observed_model_divergence',
]);
export const OBSERVATION_SOURCES = capturedFreeze([
  'provider_report', 'transport_observation',
]);

export const PROVENANCE_KEYS = capturedFreeze([
  'schema', 'revision', 'run', 'child', 'git', 'workspace', 'dispatch',
  'provider_run', 'requested', 'resolved', 'observed', 'observation',
  'model_mismatch', 'repository_exposure', 'lineage', 'timing', 'counters',
  'outcome',
]);
export const PROVENANCE_INPUT_KEYS = capturedFreeze(PROVENANCE_KEYS.filter((key) => key !== 'schema'));
export const REQUESTED_KEYS = capturedFreeze(['provider', 'model']);
export const RESOLVED_KEYS = capturedFreeze(['provider', 'model', 'role']);
export const OBSERVED_KEYS = capturedFreeze(['provider', 'model']);
export const OBSERVATION_KEYS = capturedFreeze(['source']);
export const LINEAGE_KEYS = capturedFreeze([
  'manifest_digest', 'prompt_envelope_digest', 'resolved_lane_digest',
  'capability_snapshot_digest', 'git_digest', 'workspace_digest',
]);
export const TIMING_KEYS = capturedFreeze([
  'opened_at', 'dispatched_at', 'settled_at', 'dispatch_latency_ms', 'total_duration_ms',
]);
export const COUNTER_KEYS = capturedFreeze(['dispatch_calls', 'wake_events', 'outcome_events']);
export const TELEMETRY_KEYS = capturedFreeze([
  'schema', 'revision', 'run_id_digest', 'assignment_id_digest', 'attempt',
  'provider', 'requested_model_digest', 'resolved_model_digest', 'observed_model_digest',
  'observation_source', 'model_mismatch', 'agent_ref_digest', 'run_ref_digest',
  'outcome', 'repository_exposure', 'lineage', 'timing', 'counters',
]);

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTINUITY_SECTIONS = capturedFreeze([
  'run', 'child', 'git', 'workspace', 'dispatch', 'requested', 'resolved', 'lineage',
]);
const TELEMETRY_IMMUTABLE_KEYS = capturedFreeze([
  'schema', 'run_id_digest', 'assignment_id_digest', 'attempt', 'provider',
  'requested_model_digest', 'resolved_model_digest', 'repository_exposure', 'lineage',
]);
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const DATE_PARSE = Date.parse;
const DATE_ISO = Date.prototype.toISOString;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;

function assertEnum(value, allowed, path) {
  if (!capturedIncludes(allowed, value)) {
    fail('invalid_format', path, `${path} is not an allowed value.`);
  }
}

function assertCount(value, path, { min = 0, max = MAX_METRIC_COUNTER } = {}) {
  if (!NUMBER_IS_SAFE_INTEGER(value) || value < min || value > max) {
    fail('out_of_range', path, `${path} must be a safe integer in ${min}..${max}.`);
  }
}

function assertTimestamp(value, path, required = false) {
  if (value === null) {
    if (required) fail('invalid_format', path, `${path} must be a canonical UTC timestamp.`);
    return null;
  }
  if (typeof value !== 'string' || !capturedTest(TIMESTAMP_PATTERN, value)) {
    fail('invalid_format', path,
      `${path} must be a canonical UTC timestamp${required ? '' : ' or null'}.`);
  }
  const parsed = DATE_PARSE(value);
  if (!NUMBER_IS_SAFE_INTEGER(parsed) || DATE_ISO.call(new Date(parsed)) !== value) {
    fail('invalid_format', path,
      `${path} must be a canonical UTC timestamp${required ? '' : ' or null'}.`);
  }
  return parsed;
}

function assertNullableProvider(value, path) {
  if (value === null) return;
  if (!isKnownProvider(value)) {
    fail('unknown_provider', path, `${path} must be null or exactly one of ${knownProvidersJoined()}.`);
  }
}

function assertNullableModel(value, path) {
  if (value === null) return;
  if (!isModelId(value)) {
    fail('invalid_format', path, `${path} must be a bounded model identifier or null.`);
  }
}

function same(left, right, path) {
  if (left !== right) fail('identity_mismatch', path, `${path} does not match the bound identity.`);
}

function canonicalEqual(left, right) {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function correlate(label, field, value, extra = {}) {
  if (value === null) return null;
  return identityBoundDigest(label, {
    schema: TELEMETRY_CORRELATION_SCHEMA_ID,
    field,
    value,
    ...extra,
  });
}

function validateExecution(requestedValue, resolvedValue, observedValue) {
  const requested = closedObject(requestedValue, 'requested', REQUESTED_KEYS);
  const resolved = closedObject(resolvedValue, 'resolved', RESOLVED_KEYS);
  const observed = closedObject(observedValue, 'observed', OBSERVED_KEYS);
  assertNullableProvider(requested.provider, 'requested.provider');
  assertNullableModel(requested.model, 'requested.model');
  if (!isKnownProvider(resolved.provider)) {
    fail('unknown_provider', 'resolved.provider',
      `resolved.provider must be exactly one of ${knownProvidersJoined()}.`);
  }
  if (!isModelId(resolved.model)) {
    fail('invalid_format', 'resolved.model', `resolved.model must match ${modelIdGrammarSource()}.`);
  }
  if (!isKnownRole(resolved.role)) {
    fail('invalid_format', 'resolved.role', `resolved.role must be exactly one of ${knownRolesJoined()}.`);
  }
  assertNullableProvider(observed.provider, 'observed.provider');
  assertNullableModel(observed.model, 'observed.model');
  if (requested.model !== null && requested.provider === null) {
    fail('identity_mismatch', 'requested.model', 'A requested model requires a requested provider.');
  }
  if (observed.model !== null && observed.provider === null) {
    fail('identity_mismatch', 'observed.model', 'An observed model requires an observed provider.');
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

function validateObservation(observationValue, observed) {
  if (observed.model === null) {
    if (observationValue !== null) {
      fail('identity_mismatch', 'observation', 'Observation provenance requires an observed model.');
    }
    return null;
  }
  const observation = closedObject(observationValue, 'observation', OBSERVATION_KEYS);
  assertEnum(observation.source, OBSERVATION_SOURCES, 'observation.source');
  return observation;
}

function learnedMismatch(resolved, observed) {
  if (observed.model === null) return 'served_model_not_observed';
  return observed.model === resolved.model ? 'none' : 'observed_model_divergence';
}

function validateLineage(value, path = 'lineage') {
  const lineage = closedObject(value, path, LINEAGE_KEYS);
  assertHexDigest(lineage.manifest_digest, `${path}.manifest_digest`);
  assertHexDigest(lineage.prompt_envelope_digest, `${path}.prompt_envelope_digest`);
  assertBoundDigest(lineage.resolved_lane_digest, `${path}.resolved_lane_digest`);
  assertBoundDigest(lineage.capability_snapshot_digest, `${path}.capability_snapshot_digest`);
  assertBoundDigest(lineage.git_digest, `${path}.git_digest`);
  assertBoundDigest(lineage.workspace_digest, `${path}.workspace_digest`);
  return lineage;
}

function validateTimingAndCounters(timingValue, countersValue, outcome, attempt, prefix) {
  const timing = closedObject(timingValue, `${prefix}.timing`, TIMING_KEYS);
  const counters = closedObject(countersValue, `${prefix}.counters`, COUNTER_KEYS);
  const openedMs = assertTimestamp(timing.opened_at, `${prefix}.timing.opened_at`, true);
  const dispatchedMs = assertTimestamp(timing.dispatched_at, `${prefix}.timing.dispatched_at`);
  const settledMs = assertTimestamp(timing.settled_at, `${prefix}.timing.settled_at`);
  for (const key of ['dispatch_latency_ms', 'total_duration_ms']) {
    if (timing[key] !== null) assertCount(timing[key], `${prefix}.timing.${key}`, { max: MAX_DURATION_MS });
  }
  assertCount(counters.dispatch_calls, `${prefix}.counters.dispatch_calls`, { max: 1 });
  assertCount(counters.wake_events, `${prefix}.counters.wake_events`);
  assertCount(counters.outcome_events, `${prefix}.counters.outcome_events`);
  if (dispatchedMs !== null && dispatchedMs < openedMs) {
    fail('out_of_range', `${prefix}.timing.dispatched_at`, 'Dispatch precedes open.');
  }
  if (settledMs !== null && settledMs < (dispatchedMs ?? openedMs)) {
    fail('out_of_range', `${prefix}.timing.settled_at`, 'Settlement precedes dispatch.');
  }
  if (timing.dispatch_latency_ms !== null
    && (dispatchedMs === null || timing.dispatch_latency_ms !== dispatchedMs - openedMs)) {
    fail('lifecycle_conflict', `${prefix}.timing.dispatch_latency_ms`,
      'Dispatch latency disagrees with its endpoints.');
  }
  if (timing.total_duration_ms !== null
    && (settledMs === null || timing.total_duration_ms !== settledMs - openedMs)) {
    fail('lifecycle_conflict', `${prefix}.timing.total_duration_ms`,
      'Total duration disagrees with its endpoints.');
  }
  if (counters.dispatch_calls > attempt) {
    fail('replay_or_fallback_denied', `${prefix}.counters.dispatch_calls`,
      'Dispatch calls exceed the recorded attempt.');
  }
  if (dispatchedMs !== null && counters.dispatch_calls !== 1) {
    fail('lifecycle_conflict', `${prefix}.counters.dispatch_calls`,
      'A dispatch timestamp requires one call.');
  }
  const settled = capturedIncludes(SETTLED_DISPATCH_OUTCOMES, outcome);
  if (settled !== (timing.settled_at !== null)) {
    fail('lifecycle_conflict', `${prefix}.timing.settled_at`, 'Settled time and outcome disagree.');
  }
  if (settled && counters.outcome_events < 1) {
    fail('lifecycle_conflict', `${prefix}.counters.outcome_events`,
      'A settled outcome requires an outcome event.');
  }
  if (outcome === 'succeeded' && (timing.dispatched_at === null || counters.dispatch_calls !== 1)) {
    fail('lifecycle_conflict', `${prefix}.outcome`, 'Success requires exactly one recorded dispatch.');
  }
  if (outcome === 'dispatch_uncertain' && counters.dispatch_calls !== 1) {
    fail('lifecycle_conflict', `${prefix}.outcome`,
      'Dispatch uncertainty requires exactly one attempted dispatch.');
  }
  return { timing, counters };
}

function parseProvenance(value, path = 'provenance') {
  const record = closedObject(value, path, PROVENANCE_KEYS);
  if (record.schema !== DISPATCH_PROVENANCE_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `Provenance schema must be exactly "${DISPATCH_PROVENANCE_SCHEMA_ID}".`);
  }
  assertCount(record.revision, `${path}.revision`, { min: MIN_RECORD_REVISION, max: MAX_RECORD_REVISION });
  const run = validateRunIdentityV1(record.run, `${path}.run`);
  const child = validateChildIdentityV1(record.child, `${path}.child`);
  const git = validateGitIdentityV1(record.git, `${path}.git`);
  const workspace = validateWorkspaceIdentityV1(record.workspace, `${path}.workspace`);
  const dispatch = validateDispatchAttemptV1(record.dispatch, `${path}.dispatch`);
  const providerRun = validateProviderRunIdentityV1(record.provider_run, `${path}.provider_run`);
  const { requested, resolved, observed } = validateExecution(
    record.requested, record.resolved, record.observed,
  );
  const observation = validateObservation(record.observation, observed);
  assertEnum(record.outcome, DISPATCH_OUTCOMES, `${path}.outcome`);
  const { timing, counters } = validateTimingAndCounters(
    record.timing, record.counters, record.outcome, dispatch.attempt, path,
  );
  const lineage = validateLineage(record.lineage, `${path}.lineage`);
  const mismatch = learnedMismatch(resolved, observed);
  if (record.model_mismatch !== mismatch) {
    fail('identity_mismatch', `${path}.model_mismatch`,
      'Mismatch status must follow the recorded observation.');
  }
  if (record.outcome === 'succeeded'
    && (mismatch !== 'none' || observation?.source !== 'transport_observation')) {
    fail('model_unverified', `${path}.outcome`,
      'Success requires an exact model match observed on the transport.');
  }
  if (record.repository_exposure !== SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY) {
    fail('invalid_format', `${path}.repository_exposure`,
      'Repository exposure is fixed by the R1 threat model.');
  }
  same(run.schema, RUN_IDENTITY_SCHEMA_ID, `${path}.run.schema`);
  same(child.schema, CHILD_IDENTITY_SCHEMA_ID, `${path}.child.schema`);
  same(git.schema, GIT_IDENTITY_SCHEMA_ID, `${path}.git.schema`);
  same(workspace.schema, WORKSPACE_IDENTITY_SCHEMA_ID, `${path}.workspace.schema`);
  same(dispatch.schema, DISPATCH_ATTEMPT_SCHEMA_ID, `${path}.dispatch.schema`);
  same(providerRun.schema, PROVIDER_RUN_IDENTITY_SCHEMA_ID, `${path}.provider_run.schema`);
  same(child.run_id, run.run_id, `${path}.child.run_id`);
  same(workspace.run_id, run.run_id, `${path}.workspace.run_id`);
  same(workspace.assignment_id, child.assignment_id, `${path}.workspace.assignment_id`);
  same(dispatch.run_id, run.run_id, `${path}.dispatch.run_id`);
  same(dispatch.assignment_id, child.assignment_id, `${path}.dispatch.assignment_id`);
  same(providerRun.run_id, run.run_id, `${path}.provider_run.run_id`);
  same(providerRun.assignment_id, child.assignment_id, `${path}.provider_run.assignment_id`);
  same(providerRun.attempt, dispatch.attempt, `${path}.provider_run.attempt`);
  same(providerRun.provider, resolved.provider, `${path}.provider_run.provider`);
  same(providerRun.model, resolved.model, `${path}.provider_run.model`);
  same(git.digest, run.git.digest, `${path}.git.digest`);
  same(git.repository_path, run.git.repository_path, `${path}.git.repository_path`);
  same(git.base_sha, run.git.base_sha, `${path}.git.base_sha`);
  same(workspace.git.digest, run.git.digest, `${path}.workspace.git.digest`);
  same(providerRun.git.digest, run.git.digest, `${path}.provider_run.git.digest`);
  same(providerRun.manifest_digest, run.manifest_digest, `${path}.provider_run.manifest_digest`);
  same(lineage.manifest_digest, run.manifest_digest, `${path}.lineage.manifest_digest`);
  same(lineage.git_digest, run.git.digest, `${path}.lineage.git_digest`);
  same(lineage.workspace_digest, workspace.digest, `${path}.lineage.workspace_digest`);
  same(lineage.prompt_envelope_digest, providerRun.prompt_envelope_digest,
    `${path}.lineage.prompt_envelope_digest`);
  same(lineage.resolved_lane_digest, providerRun.resolved_lane_digest,
    `${path}.lineage.resolved_lane_digest`);
  same(lineage.capability_snapshot_digest, providerRun.capability_snapshot_digest,
    `${path}.lineage.capability_snapshot_digest`);
  if (record.outcome === 'succeeded'
    && providerRun.agent_id === null && providerRun.provider_run_id === null) {
    fail('missing_key', `${path}.provider_run`, 'Success requires a provider-issued identifier.');
  }
  return {
    schema: DISPATCH_PROVENANCE_SCHEMA_ID,
    revision: record.revision,
    run,
    child,
    git,
    workspace,
    dispatch,
    provider_run: providerRun,
    requested,
    resolved,
    observed,
    observation,
    model_mismatch: mismatch,
    repository_exposure: record.repository_exposure,
    lineage,
    timing,
    counters,
    outcome: record.outcome,
  };
}

export function validateDispatchProvenanceV1(value) {
  return snapshotRecord(parseProvenance(value, 'provenance'));
}

export function buildDispatchProvenanceV1(input) {
  const fields = closedObject(input, 'provenance_input', PROVENANCE_INPUT_KEYS);
  return validateDispatchProvenanceV1({ schema: DISPATCH_PROVENANCE_SCHEMA_ID, ...fields });
}

function stableProviderRun(record) {
  return {
    schema: record.schema,
    run_id: record.run_id,
    assignment_id: record.assignment_id,
    attempt: record.attempt,
    provider: record.provider,
    model: record.model,
    git: record.git,
    manifest_digest: record.manifest_digest,
    prompt_envelope_digest: record.prompt_envelope_digest,
    resolved_lane_digest: record.resolved_lane_digest,
    capability_snapshot_digest: record.capability_snapshot_digest,
    request_idempotency_key: record.request_idempotency_key,
  };
}

export function assertDispatchProvenanceContinuityV1(previousValue, nextValue) {
  const previous = validateDispatchProvenanceV1(previousValue);
  const next = validateDispatchProvenanceV1(nextValue);
  if (next.revision === previous.revision) {
    if (!canonicalEqual(previous, next)) {
      fail('identity_mismatch', 'provenance.revision',
        'An equal revision demands canonical byte identity.');
    }
    return true;
  }
  if (next.revision < previous.revision) {
    fail('revision_regressed', 'provenance.revision', 'Revision regressed.');
  }
  for (const section of CONTINUITY_SECTIONS) {
    if (!canonicalEqual(previous[section], next[section])) {
      fail('identity_mismatch', `provenance.${section}`,
        'Protected facts are immutable across continuations.');
    }
  }
  if (previous.repository_exposure !== next.repository_exposure) {
    fail('identity_mismatch', 'provenance.repository_exposure', 'Repository exposure is immutable.');
  }
  if (previous.timing.opened_at !== next.timing.opened_at) {
    fail('identity_mismatch', 'provenance.timing.opened_at', 'The opened instant is immutable.');
  }
  for (const key of ['dispatched_at', 'settled_at']) {
    if (previous.timing[key] !== null && previous.timing[key] !== next.timing[key]) {
      fail('identity_mismatch', `provenance.timing.${key}`, 'A recorded instant is immutable.');
    }
  }
  if (!canonicalEqual(stableProviderRun(previous.provider_run), stableProviderRun(next.provider_run))) {
    fail('identity_mismatch', 'provenance.provider_run',
      'A continuation cannot change the provider-run tuple.');
  }
  for (const key of ['agent_id', 'provider_run_id']) {
    if (previous.provider_run[key] !== null && next.provider_run[key] !== previous.provider_run[key]) {
      fail('identity_mismatch', `provenance.provider_run.${key}`,
        'A reconciled provider identifier is immutable.');
    }
  }
  for (const key of COUNTER_KEYS) {
    if (next.counters[key] < previous.counters[key]) {
      fail('counter_regressed', `provenance.counters.${key}`, 'Counters cannot decrease.');
    }
  }
  if (previous.observed.provider !== null && previous.observed.provider !== next.observed.provider) {
    fail('identity_mismatch', 'provenance.observed.provider',
      'A learned observation source is immutable.');
  }
  if (previous.observed.model !== null && previous.observed.model !== next.observed.model) {
    fail('identity_mismatch', 'provenance.observed.model',
      'A learned observation cannot be forgotten or changed.');
  }
  if (previous.observation !== null && !canonicalEqual(previous.observation, next.observation)) {
    fail('identity_mismatch', 'provenance.observation',
      'Recorded observation provenance is immutable.');
  }
  if (previous.model_mismatch !== 'served_model_not_observed'
    && previous.model_mismatch !== next.model_mismatch) {
    fail('identity_mismatch', 'provenance.model_mismatch',
      'A learned mismatch status cannot be forgotten.');
  }
  if (capturedIncludes(SETTLED_DISPATCH_OUTCOMES, previous.outcome)) {
    if (next.outcome !== previous.outcome) {
      fail('terminal_outcome_changed', 'provenance.outcome', 'A settled outcome is absorbing.');
    }
    if (next.timing.settled_at !== previous.timing.settled_at) {
      fail('terminal_outcome_changed', 'provenance.timing.settled_at',
        'A settled instant is immutable.');
    }
  }
  return true;
}

function parseTelemetry(value, path = 'telemetry') {
  const view = closedObject(value, path, TELEMETRY_KEYS);
  if (view.schema !== DISPATCH_TELEMETRY_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`, `Telemetry schema must be exactly "${DISPATCH_TELEMETRY_SCHEMA_ID}".`);
  }
  assertCount(view.revision, `${path}.revision`, { min: MIN_RECORD_REVISION, max: MAX_RECORD_REVISION });
  assertBoundDigest(view.run_id_digest, `${path}.run_id_digest`);
  assertBoundDigest(view.assignment_id_digest, `${path}.assignment_id_digest`);
  assertCount(view.attempt, `${path}.attempt`, {
    min: MIN_DISPATCH_ATTEMPT, max: MAX_DISPATCH_ATTEMPT,
  });
  if (!isKnownProvider(view.provider)) {
    fail('unknown_provider', `${path}.provider`,
      `${path}.provider must be exactly one of ${knownProvidersJoined()}.`);
  }
  assertBoundDigest(view.resolved_model_digest, `${path}.resolved_model_digest`);
  for (const key of ['requested_model_digest', 'observed_model_digest', 'agent_ref_digest', 'run_ref_digest']) {
    if (view[key] !== null) assertBoundDigest(view[key], `${path}.${key}`);
  }
  if (view.requested_model_digest !== null
    && view.requested_model_digest !== view.resolved_model_digest) {
    fail('identity_mismatch', `${path}.requested_model_digest`,
      'A recorded requested model must be the resolver-bound model.');
  }
  const unobserved = view.observed_model_digest === null;
  if ((view.observation_source === null) !== unobserved) {
    fail('identity_mismatch', `${path}.observation_source`,
      'Observation metadata must pair with the observation.');
  }
  if (view.observation_source !== null) {
    assertEnum(view.observation_source, OBSERVATION_SOURCES, `${path}.observation_source`);
  }
  assertEnum(view.model_mismatch, MODEL_MISMATCH_STATUSES, `${path}.model_mismatch`);
  if (unobserved !== (view.model_mismatch === 'served_model_not_observed')) {
    fail('identity_mismatch', `${path}.observed_model_digest`,
      'Observed digest must pair with the mismatch status.');
  }
  if ((view.model_mismatch === 'none') !== (view.observed_model_digest === view.resolved_model_digest)) {
    fail('identity_mismatch', `${path}.observed_model_digest`,
      'The observed digest must equal the resolved digest exactly when the status is a match.');
  }
  assertEnum(view.outcome, DISPATCH_OUTCOMES, `${path}.outcome`);
  if (view.repository_exposure !== SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY) {
    fail('invalid_format', `${path}.repository_exposure`, 'Invalid repository exposure.');
  }
  validateLineage(view.lineage, `${path}.lineage`);
  validateTimingAndCounters(view.timing, view.counters, view.outcome, view.attempt, path);
  if (BUFFER_BYTE_LENGTH(canonicalJsonStringify(view), 'utf8') > MAX_TELEMETRY_BYTES) {
    fail('out_of_range', path, `Telemetry exceeds ${MAX_TELEMETRY_BYTES} bytes.`);
  }
  return view;
}

export function validateDispatchTelemetryV1(value) {
  return snapshotRecord(parseTelemetry(value, 'telemetry'));
}

export function projectDispatchTelemetryV1(record) {
  const provenance = validateDispatchProvenanceV1(record);
  const observedPresent = provenance.observed.model !== null;
  const view = snapshotRecord({
    schema: DISPATCH_TELEMETRY_SCHEMA_ID,
    revision: provenance.revision,
    run_id_digest: correlate(IDENTITY_LABELS.RUN_IDENTITY, 'run_id', provenance.run.run_id),
    assignment_id_digest: correlate(IDENTITY_LABELS.CHILD_IDENTITY, 'assignment_id',
      provenance.child.assignment_id),
    attempt: provenance.dispatch.attempt,
    provider: provenance.resolved.provider,
    requested_model_digest: provenance.requested.model === null ? null
      : correlate(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, 'model', provenance.requested.model,
        { provider: provenance.requested.provider }),
    resolved_model_digest: correlate(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, 'model',
      provenance.resolved.model, { provider: provenance.resolved.provider }),
    observed_model_digest: observedPresent
      ? correlate(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, 'model', provenance.observed.model,
        { provider: provenance.observed.provider })
      : null,
    observation_source: observedPresent ? provenance.observation.source : null,
    model_mismatch: provenance.model_mismatch,
    agent_ref_digest: correlate(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, 'agent_id',
      provenance.provider_run.agent_id, { provider: provenance.resolved.provider }),
    run_ref_digest: correlate(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, 'provider_run_id',
      provenance.provider_run.provider_run_id, { provider: provenance.resolved.provider }),
    outcome: provenance.outcome,
    repository_exposure: provenance.repository_exposure,
    lineage: provenance.lineage,
    timing: provenance.timing,
    counters: provenance.counters,
  });
  return validateDispatchTelemetryV1(view);
}

export function assertDispatchTelemetryContinuityV1(previousValue, nextValue) {
  const previous = validateDispatchTelemetryV1(previousValue);
  const next = validateDispatchTelemetryV1(nextValue);
  if (next.revision === previous.revision) {
    if (!canonicalEqual(previous, next)) {
      fail('identity_mismatch', 'telemetry.revision',
        'An equal revision demands canonical byte identity.');
    }
    return true;
  }
  if (next.revision < previous.revision) {
    fail('revision_regressed', 'telemetry.revision', 'Revision regressed.');
  }
  for (const key of TELEMETRY_IMMUTABLE_KEYS) {
    if (!canonicalEqual(previous[key], next[key])) {
      fail('identity_mismatch', `telemetry.${key}`,
        'Protected telemetry facts are immutable across continuations.');
    }
  }
  for (const key of COUNTER_KEYS) {
    if (next.counters[key] < previous.counters[key]) {
      fail('counter_regressed', `telemetry.counters.${key}`, 'Counters cannot decrease.');
    }
  }
  for (const key of ['opened_at', 'dispatched_at', 'settled_at']) {
    if (previous.timing[key] !== null && previous.timing[key] !== next.timing[key]) {
      fail('identity_mismatch', `telemetry.timing.${key}`, 'A recorded instant is immutable.');
    }
  }
  for (const key of ['observed_model_digest', 'observation_source', 'agent_ref_digest', 'run_ref_digest']) {
    if (previous[key] !== null && previous[key] !== next[key]) {
      fail('identity_mismatch', `telemetry.${key}`, 'Learned telemetry facts are immutable.');
    }
  }
  if (capturedIncludes(SETTLED_DISPATCH_OUTCOMES, previous.outcome)
    && next.outcome !== previous.outcome) {
    fail('terminal_outcome_changed', 'telemetry.outcome', 'A settled outcome is absorbing.');
  }
  return true;
}

export { bindDigest, IDENTITY_LABELS };

capturedFreeze(validateDispatchProvenanceV1);
capturedFreeze(buildDispatchProvenanceV1);
capturedFreeze(assertDispatchProvenanceContinuityV1);
capturedFreeze(validateDispatchTelemetryV1);
capturedFreeze(projectDispatchTelemetryV1);
capturedFreeze(assertDispatchTelemetryContinuityV1);
