// DispatchProvenanceV1 — bounded, content-free run identity and telemetry.
// Pure additive contracts only: runtime integration belongs to later R1 PRs.

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ASSIGNMENT_ID_PATTERN,
  ASSIGNMENT_ROLES,
  EVIDENCE_KINDS,
  MAX_TIMEOUT_MS,
  MODEL_ID_PATTERN,
  PROVIDERS,
  SHA40_PATTERN,
  RunContractV1Error,
  assertBaseSha,
  assertJsonDataObject,
  assertManifestComplexity,
  assertRepositoryPath,
  assertRunId,
} from './run-manifest.mjs';
import { canonicalJsonStringify } from './identity.mjs';

export const RUN_IDENTITY_SCHEMA_ID = 'codex-co-engineer.run-identity.v1';
export const CHILD_IDENTITY_SCHEMA_ID = 'codex-co-engineer.child-identity.v1';
export const DISPATCH_IDENTITY_SCHEMA_ID = 'codex-co-engineer.dispatch-identity.v1';
export const PROVIDER_RUN_IDENTITY_SCHEMA_ID = 'codex-co-engineer.provider-run-identity.v1';
export const DISPATCH_PROVENANCE_SCHEMA_ID = 'codex-co-engineer.dispatch-provenance.v1';
export const DISPATCH_TELEMETRY_SCHEMA_ID = 'codex-co-engineer.dispatch-telemetry.v1';

export const SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY =
  'selected_external_provider_full_repository';
export const REQUEST_IDEMPOTENCY_DOMAIN = 'codex-co-engineer.request-idempotency.v1';
export const REQUEST_IDEMPOTENCY_KEY_PATTERN = /^idem-v1-[0-9a-f]{64}$/u;
export const DIGEST64_PATTERN = /^[0-9a-f]{64}$/u;
export const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/u;
export const MAX_DISPATCH_ATTEMPT = Number.MAX_SAFE_INTEGER;
export const MAX_RECORD_REVISION = Number.MAX_SAFE_INTEGER;
export const MAX_METRIC_COUNTER = Number.MAX_SAFE_INTEGER;
export const MAX_DURATION_MS = MAX_TIMEOUT_MS;
export const MAX_TELEMETRY_BYTES = 4096;

export const PROVIDER_DRIVERS = Object.freeze(Object.assign(Object.create(null), {
  grok: 'acp',
  'cursor-local': 'acp',
  dsh: 'acpx',
  'cursor-cloud': 'cloud-sdk',
}));
export const DISPATCH_OUTCOMES = Object.freeze([
  'pending', 'dispatch_uncertain', 'needs_attention', 'transport_lost',
  'succeeded', 'failed', 'cancelled', 'timed_out', 'environment_blocked',
]);
export const SETTLED_DISPATCH_OUTCOMES = Object.freeze([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'environment_blocked',
]);
export const MODEL_MISMATCH_STATUSES = Object.freeze([
  'none', 'served_model_not_observed', 'observed_model_divergence',
]);
export const ATTESTATION_METHODS = Object.freeze([
  'independent_provider_query', 'provider_runtime_report',
]);

const RUN_KEYS = ['schema', 'run_id', 'repository_path', 'base_sha', 'manifest_digest'];
const CHILD_KEYS = ['schema', 'run_id', 'assignment_id'];
const DISPATCH_KEYS = ['schema', 'run_id', 'assignment_id', 'attempt'];
const PROVIDER_RUN_KEYS = [
  'schema', 'provider', 'driver', 'run_id', 'assignment_id', 'repository_path',
  'base_sha', 'request_idempotency_key', 'agent_id', 'provider_run_id',
];
const IDEMPOTENCY_KEYS = ['run_id', 'assignment_id', 'repository_path', 'base_sha'];

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

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

function detached(value) {
  return deepFreeze(JSON.parse(canonicalJsonStringify(value)));
}

function assertAssignmentId(value, path) {
  if (typeof value !== 'string' || !ASSIGNMENT_ID_PATTERN.test(value)) {
    fail('invalid_format', path, `${path} must match ${ASSIGNMENT_ID_PATTERN.source}.`);
  }
}

function assertDigest(value, path) {
  if (typeof value !== 'string' || !DIGEST64_PATTERN.test(value)) {
    fail('invalid_format', path, `${path} must be a lowercase SHA-256 digest.`);
  }
}

function assertCount(value, path, { min = 0, max = MAX_METRIC_COUNTER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('out_of_range', path, `${path} must be a safe integer in ${min}..${max}.`);
  }
}

function assertNullableRef(value, path) {
  if (value !== null && (typeof value !== 'string' || !PROVIDER_REF_PATTERN.test(value))) {
    fail('invalid_format', path, `${path} must be null or a bounded provider identifier.`);
  }
}

function assertProvider(value, path) {
  if (!PROVIDERS.includes(value)) fail('unknown_provider', path, `${path} names an unknown provider.`);
}

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
  validateRequestIdempotencyKeyV1(value.request_idempotency_key, value, `${path}.request_idempotency_key`);
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
  validateRunIdentityV1(record);
  return detached(record);
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
  validateChildIdentityV1(record);
  return detached(record);
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
  validateDispatchIdentityV1(record);
  return detached(record);
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
  const expected = deriveRequestIdempotencyKeyV1({
    run_id: tuple.run_id,
    assignment_id: tuple.assignment_id,
    repository_path: tuple.repository_path,
    base_sha: tuple.base_sha,
  });
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
  validateProviderRunIdentityV1(record);
  return detached(record);
}

export { ASSIGNMENT_ROLES, ATTESTATION_METHODS as MODEL_ATTESTATION_METHODS, EVIDENCE_KINDS };
