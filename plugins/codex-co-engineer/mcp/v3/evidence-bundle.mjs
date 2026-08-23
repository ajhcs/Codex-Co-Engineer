// EvidenceBundleV1 — closed canonical bounded immutable evidence record
// separating provider-authored claims from independently verified facts
// (ADR 0001 identifiers `bounded_evidence`, `exact_identities`,
// `raw_evidence_owner_only_local`,
// `sanitized_bounded_evidence_model_facing`,
// `provider_commands_evidence_never_auto_executed`,
// `codex_only_final_acceptance`).
//
// Additive v3 module for W12-P13. It owns schema, validation, canonical
// bytes, framed digest, and the closed acceptance rule. It performs no
// Git inspection, filesystem I/O, command execution, network/provider
// calls, or live routing. Facts cannot be synthesized from claims.
// Artifact links are exact P07 ArtifactRefV1 snapshots.

import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ARTIFACT_REF_SCHEMA_ID,
  compareArtifactRefsV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  capturedDescriptor,
  capturedFreeze,
  capturedIncludes,
  capturedJoin,
  isKnownProvider,
  isModelId,
  knownProvidersJoined,
} from './grammar.mjs';
import {
  IDENTITY_DOMAIN,
  IDENTITY_LABELS,
  IDENTITY_VERSION,
  canonicalJsonStringify,
  identityDigestV1,
} from './identity.mjs';
import {
  RunContractV1Error,
  assertAllowedKeys,
  assertBaseSha,
  assertDenseJsonArray,
  assertRepositoryPath,
  assertRunId,
  isAssignmentId,
  isCommandId,
  isSha40,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  hasOwn,
  optOwn,
} from './selection-json.mjs';

export const EVIDENCE_BUNDLE_SCHEMA_ID = 'codex-co-engineer.evidence-bundle.v1';
export const EVIDENCE_BUNDLE_VERSION = 1;
export const EVIDENCE_DIGEST_LABEL = IDENTITY_LABELS.EVIDENCE_BUNDLE;
export const DIGEST_ALGORITHM = 'sha256';
export const EVIDENCE_DIGEST_HEX_LENGTH = 64;

export const MAX_EVIDENCE_DEPTH = 16;
export const MAX_EVIDENCE_NODES = 1024;
export const MAX_CLAIMS = 32;
export const MAX_FACTS = 64;
export const MAX_DISCREPANCIES = 32;
export const MAX_EVIDENCE_ARTIFACT_REFS = 64;
export const MAX_EVIDENCE_STRING_BYTES = 4096;
export const MAX_BUNDLE_CANONICAL_BYTES = 65_536;
export const MAX_SEQUENCE = 65_535;
export const MAX_ARTIFACT_IDS = 8;
export const MAX_DURATION_MS = 86_400_000;

export const CLAIM_KINDS = capturedFreeze([
  'command_reported', 'files_changed', 'head_reached', 'model_used', 'tests_passed',
]);
export const FACT_KINDS = capturedFreeze([
  'acceptance_results', 'artifact_integrity', 'git_diff', 'git_identity',
  'head_sha', 'model_attested',
]);
export const DISCREPANCY_KINDS = capturedFreeze([
  'integrity', 'mismatch', 'missing', 'security', 'unverifiable',
]);
export const CLAIM_STATUSES = capturedFreeze(['asserted', 'unsupported']);
export const FACT_STATUSES = capturedFreeze([
  'failed', 'partial', 'truncated', 'unknown', 'verified',
]);
export const DISCREPANCY_STATUSES = capturedFreeze(['recorded']);
export const FINAL_STATES = capturedFreeze([
  'accepted', 'failed', 'partial', 'pass', 'unknown', 'verified',
]);
export const ACCEPTED_FINAL_STATES = capturedFreeze(['accepted', 'pass', 'verified']);
export const CLAIM_CODES = capturedFreeze(['provider_reported']);
export const FACT_CODES = capturedFreeze(['host_observed']);
export const DISCREPANCY_CODES = capturedFreeze([
  'artifact_integrity_failure', 'claim_fact_mismatch', 'missing_fact',
  'security_boundary', 'unverifiable_claim',
]);
export const FACT_AUTHORITIES = capturedFreeze([
  'independent_provider_query', 'platform_acceptance_runner', 'platform_git',
  'platform_ref_audit', 'platform_scope',
]);
export const FACT_METHODS = capturedFreeze([
  'ancestry_check', 'approved_command_execution', 'artifact_digest_compare',
  'independent_model_query', 'merge_commit_absence',
  'protected_ref_snapshot_compare', 'read_only_no_changes', 'scope_match',
]);
export const REPORTED_RESULTS = capturedFreeze(['fail', 'not_reported', 'pass']);
export const INTEGRITY_RESULTS = capturedFreeze(['match', 'mismatch']);
export const PROVIDER_DERIVED_ARTIFACT_KINDS = capturedFreeze([
  'cloud_receipt', 'event_segment', 'provider_report',
]);
export const PROOF_ARTIFACT_KINDS = capturedFreeze([
  'acceptance_output', 'git_diff', 'ref_snapshot', 'usage_evidence',
]);

export const BUNDLE_ALLOWED_KEYS = capturedFreeze([
  'schema', 'version', 'run_id', 'request_id', 'assignment_id', 'provider',
  'model', 'repository', 'candidate', 'sequence', 'recorded_at',
  'final_state', 'claims', 'facts', 'discrepancies', 'artifacts',
]);
export const BUNDLE_REQUIRED_KEYS = capturedFreeze([
  'schema', 'version', 'run_id', 'request_id', 'assignment_id', 'provider',
  'model', 'repository', 'sequence', 'final_state', 'claims', 'facts',
  'discrepancies', 'artifacts',
]);
export const REPOSITORY_ALLOWED_KEYS = capturedFreeze(['path', 'base_sha']);
export const CANDIDATE_ALLOWED_KEYS = capturedFreeze(['sha']);
export const CLAIM_ALLOWED_KEYS = capturedFreeze([
  'claim_id', 'claim_kind', 'status', 'code', 'run_id', 'assignment_id',
  'sequence', 'recorded_at', 'subject', 'payload', 'payload_digest',
  'artifact_digests',
]);
export const CLAIM_REQUIRED_KEYS = capturedFreeze([
  'claim_id', 'claim_kind', 'status', 'code', 'run_id', 'assignment_id',
  'sequence', 'subject', 'payload', 'artifact_digests',
]);
export const FACT_ALLOWED_KEYS = capturedFreeze([
  'fact_id', 'fact_kind', 'status', 'code', 'run_id', 'assignment_id',
  'sequence', 'recorded_at', 'subject', 'authority', 'method',
  'input_digest', 'output_digest', 'exit_code', 'duration_ms', 'truncated',
  'payload', 'payload_digest', 'artifact_digests',
]);
export const FACT_REQUIRED_KEYS = capturedFreeze([
  'fact_id', 'fact_kind', 'status', 'code', 'run_id', 'assignment_id',
  'sequence', 'subject', 'authority', 'method', 'input_digest',
  'output_digest', 'exit_code', 'duration_ms', 'truncated', 'payload',
  'artifact_digests',
]);
export const DISCREPANCY_ALLOWED_KEYS = capturedFreeze([
  'discrepancy_id', 'discrepancy_kind', 'status', 'code', 'run_id',
  'assignment_id', 'sequence', 'recorded_at', 'claim_ids', 'fact_ids',
  'artifact_digests',
]);
export const DISCREPANCY_REQUIRED_KEYS = capturedFreeze([
  'discrepancy_id', 'discrepancy_kind', 'status', 'code', 'run_id',
  'assignment_id', 'sequence', 'claim_ids', 'fact_ids', 'artifact_digests',
]);

export const EVIDENCE_ERROR_CODES = capturedFreeze([
  'conflicting_id', 'duplicate_id', 'duplicate_sequence', 'identity_mismatch',
  'invalid_format', 'invalid_type', 'missing_key', 'out_of_range',
  'payload_digest_mismatch', 'provider_proof_rejected', 'stale_fact',
  'truncated_required_fact', 'unknown_authority', 'unknown_claim_kind',
  'unknown_code', 'unknown_discrepancy_kind', 'unknown_fact_kind',
  'unknown_final_state', 'unknown_method', 'unknown_status',
  'unproven_accepted_state', 'unsupported_pairing',
]);

const PRIVATE_RECORD_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const PRIVATE_SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PRIVATE_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;

export const EVIDENCE_RECORD_ID_PATTERN = new RegExp(
  PRIVATE_RECORD_ID_PATTERN.source, PRIVATE_RECORD_ID_PATTERN.flags,
);
export const EVIDENCE_SUBJECT_PATTERN = new RegExp(
  PRIVATE_SUBJECT_PATTERN.source, PRIVATE_SUBJECT_PATTERN.flags,
);
export const EVIDENCE_TIMESTAMP_PATTERN = new RegExp(
  PRIVATE_TIMESTAMP_PATTERN.source, PRIVATE_TIMESTAMP_PATTERN.flags,
);

const CLAIM_PAYLOAD_KEYS = {
  command_reported: capturedFreeze(['command_id', 'result']),
  files_changed: capturedFreeze(['path_count']),
  head_reached: capturedFreeze(['sha']),
  model_used: capturedFreeze(['model']),
  tests_passed: capturedFreeze(['result']),
};
const FACT_PAYLOAD_KEYS = {
  acceptance_results: capturedFreeze(['command_id', 'result']),
  artifact_integrity: capturedFreeze(['artifact_sha256', 'result']),
  git_diff: capturedFreeze(['path_count', 'path_set_digest']),
  git_identity: capturedFreeze(['base_sha', 'head_sha']),
  head_sha: capturedFreeze(['sha']),
  model_attested: capturedFreeze(['model']),
};
const KIND_CODES = {
  integrity: 'artifact_integrity_failure',
  mismatch: 'claim_fact_mismatch',
  missing: 'missing_fact',
  security: 'security_boundary',
  unverifiable: 'unverifiable_claim',
};
const CLAIM_FACT_MAP = {
  command_reported: capturedFreeze(['acceptance_results']),
  files_changed: capturedFreeze(['git_diff']),
  head_reached: capturedFreeze(['git_identity', 'head_sha']),
  model_used: capturedFreeze(['model_attested']),
  tests_passed: capturedFreeze(['acceptance_results']),
};

const CRYPTO_CREATE_HASH = createHash;
const TIMING_SAFE_EQUAL = timingSafeEqual;
const HASH_PROTOTYPE = Object.getPrototypeOf(CRYPTO_CREATE_HASH(DIGEST_ALGORITHM));
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const BUFFER_FROM = Buffer.from.bind(Buffer);
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REFLECT_APPLY = Reflect.apply;
const REGEXP_TEST = RegExp.prototype.test;
const STRING = String;

function testPattern(pattern, value) {
  return REFLECT_APPLY(REGEXP_TEST, pattern, [value]) === true;
}

function enumError(code, path, label, allowed) {
  let joined = '';
  for (let index = 0; index < allowed.length; index += 1) {
    joined += index === 0 ? `"${allowed[index]}"` : `, "${allowed[index]}"`;
  }
  fail(code, path, `${path} must be exactly one of ${joined}; received an outside ${label}.`);
}

function assertEnum(value, allowed, code, path, label) {
  if (!capturedIncludes(allowed, value)) enumError(code, path, label, allowed);
  return value;
}

function assertSha256(value, path) {
  if (typeof value !== 'string' || !testPattern(PRIVATE_SHA256_PATTERN, value)) {
    fail('invalid_format', path,
      `${path} must be an exact ${EVIDENCE_DIGEST_HEX_LENGTH}-character lowercase hex SHA-256.`);
  }
  return value;
}

function assertRecordId(value, path) {
  if (typeof value !== 'string' || !testPattern(PRIVATE_RECORD_ID_PATTERN, value)) {
    fail('invalid_format', path, `${path} violates the evidence record-id grammar.`);
  }
  return value;
}

function assertSubject(value, path) {
  if (typeof value !== 'string' || !testPattern(PRIVATE_SUBJECT_PATTERN, value)) {
    fail('invalid_format', path, `${path} violates the closed subject grammar.`);
  }
  return value;
}

function assertSequence(value, path) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value)) {
    fail('invalid_type', path, `${path} must be a safe integer sequence.`);
  }
  if (value < 0 || value > MAX_SEQUENCE) {
    fail('out_of_range', path, `${path} must be an injected sequence in 0..${MAX_SEQUENCE}.`);
  }
  return value;
}

function assertTimestamp(value, path) {
  if (typeof value !== 'string' || !testPattern(PRIVATE_TIMESTAMP_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be an exact UTC timestamp YYYY-MM-DDTHH:MM:SSZ.`);
  }
  return value;
}

function assertSafeInt(value, path, min, max) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value)) {
    fail('invalid_type', path, `${path} must be a safe integer.`);
  }
  if (value < min || value > max) {
    fail('out_of_range', path, `${path} is outside ${min}..${max}.`);
  }
  return value;
}

function requiredKeys(input, keys, path) {
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!hasOwn(input, key)) {
      fail('missing_key', `${path}.${key}`,
        `${path}.${key} is required (${EVIDENCE_BUNDLE_SCHEMA_ID}); evidence records have no hidden defaults.`);
    }
  }
}

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!Object.hasOwn(values, key)) continue;
    OBJECT_DEFINE_PROPERTY(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function payloadDigestOf(payload) {
  const canonical = canonicalJsonStringify(payload);
  const hash = CRYPTO_CREATE_HASH(DIGEST_ALGORITHM);
  HASH_UPDATE.call(hash, BUFFER_FROM(canonical, 'utf8'));
  return HASH_DIGEST.call(hash, 'hex');
}

function bindPayloadDigest(input, payload, path) {
  const digest = payloadDigestOf(payload);
  if (hasOwn(input, 'payload_digest')) {
    const provided = optOwn(input, 'payload_digest');
    assertSha256(provided, `${path}.payload_digest`);
    if (provided !== digest) {
      fail('payload_digest_mismatch', `${path}.payload_digest`,
        `${path}.payload_digest does not match the canonical payload digest.`);
    }
  }
  return digest;
}

function parseArtifactDigestList(input, path) {
  const value = optOwn(input, 'artifact_digests');
  assertNotProxy(value, `${path}.artifact_digests`);
  assertDenseJsonArray(value, `${path}.artifact_digests`);
  if (value.length > MAX_ARTIFACT_IDS) {
    fail('out_of_range', `${path}.artifact_digests`,
      `${path}.artifact_digests exceeds ${MAX_ARTIFACT_IDS} entries.`);
  }
  const seen = new Set();
  const snapshots = [];
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}.artifact_digests[${index}]`;
    const digest = optOwn(value, STRING(index));
    assertSha256(digest, entryPath);
    if (seen.has(digest)) {
      fail('duplicate_id', entryPath, `${entryPath} repeats an artifact digest.`);
    }
    seen.add(digest);
    snapshots.push(digest);
  }
  return capturedFreeze(snapshots);
}

function parseClosedPayload(input, path, kind, table) {
  const payload = optOwn(input, 'payload');
  const keys = table[kind];
  assertPlainObject(payload, 'invalid_type', `${path}.payload`, `${path}.payload`);
  assertDirectJsonClosure(payload, `${path}.payload`);
  assertAllowedKeys(payload, keys, `${path}.payload`);
  requiredKeys(payload, keys, `${path}.payload`);
  const values = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    values[key] = optOwn(payload, key);
  }
  if (hasOwn(values, 'model') && !isModelId(values.model)) {
    fail('invalid_format', `${path}.payload.model`,
      `${path}.payload.model violates the accepted model-id grammar.`);
  }
  if (hasOwn(values, 'command_id') && !isCommandId(values.command_id)) {
    fail('invalid_format', `${path}.payload.command_id`,
      `${path}.payload.command_id violates the accepted command-id grammar.`);
  }
  if (hasOwn(values, 'sha') && !isSha40(values.sha)) {
    fail('invalid_format', `${path}.payload.sha`,
      `${path}.payload.sha must be an exact immutable 40-character lowercase hex commit SHA.`);
  }
  if (hasOwn(values, 'base_sha')) assertBaseSha(values.base_sha, `${path}.payload.base_sha`);
  if (hasOwn(values, 'head_sha') && !isSha40(values.head_sha)) {
    fail('invalid_format', `${path}.payload.head_sha`,
      `${path}.payload.head_sha must be an exact immutable 40-character lowercase hex commit SHA.`);
  }
  if (hasOwn(values, 'result')) {
    const allowed = kind === 'artifact_integrity' ? INTEGRITY_RESULTS : REPORTED_RESULTS;
    assertEnum(values.result, allowed, 'unknown_status', `${path}.payload.result`, 'result');
  }
  if (hasOwn(values, 'path_count')) {
    values.path_count = assertSafeInt(values.path_count, `${path}.payload.path_count`, 0, 65_536);
  }
  if (hasOwn(values, 'path_set_digest')) {
    assertSha256(values.path_set_digest, `${path}.payload.path_set_digest`);
  }
  if (hasOwn(values, 'artifact_sha256')) {
    assertSha256(values.artifact_sha256, `${path}.payload.artifact_sha256`);
  }
  return freezeRecord(keys, values);
}

function parseOptionalTimestamp(input, path) {
  if (!hasOwn(input, 'recorded_at')) return undefined;
  return assertTimestamp(optOwn(input, 'recorded_at'), `${path}.recorded_at`);
}

function parseIdentityPair(input, path) {
  const runId = optOwn(input, 'run_id');
  assertRunId(runId, `${path}.run_id`);
  const assignmentId = optOwn(input, 'assignment_id');
  if (!isAssignmentId(assignmentId)) {
    fail('invalid_format', `${path}.assignment_id`,
      `${path}.assignment_id violates the assignment-id grammar.`);
  }
  return { run_id: runId, assignment_id: assignmentId };
}

function parseIdList(input, key, path) {
  const value = optOwn(input, key);
  const field = `${path}.${key}`;
  assertNotProxy(value, field);
  assertDenseJsonArray(value, field);
  if (value.length > MAX_ARTIFACT_IDS) {
    fail('out_of_range', field, `${field} exceeds ${MAX_ARTIFACT_IDS} entries.`);
  }
  const seen = new Set();
  const snapshots = [];
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${field}[${index}]`;
    const id = optOwn(value, STRING(index));
    assertRecordId(id, entryPath);
    if (seen.has(id)) fail('duplicate_id', entryPath, `${entryPath} repeats an identity.`);
    seen.add(id);
    snapshots.push(id);
  }
  return capturedFreeze(snapshots);
}

function compatibleAuthority(factKind, authority, method) {
  if (factKind === 'model_attested') {
    return authority === 'independent_provider_query' && method === 'independent_model_query';
  }
  if (factKind === 'acceptance_results') {
    return authority === 'platform_acceptance_runner' && method === 'approved_command_execution';
  }
  if (factKind === 'artifact_integrity') {
    return (authority === 'platform_ref_audit' || authority === 'platform_git')
      && method === 'artifact_digest_compare';
  }
  if (factKind === 'git_diff' || factKind === 'git_identity' || factKind === 'head_sha') {
    return authority === 'platform_git'
      && (method === 'ancestry_check' || method === 'merge_commit_absence'
        || method === 'scope_match' || method === 'read_only_no_changes'
        || method === 'protected_ref_snapshot_compare' || method === 'artifact_digest_compare');
  }
  return false;
}

export function parseProviderClaimV1(input, path = 'claim') {
  assertPlainObject(input, 'invalid_type', path, `${path}`);
  assertDirectJsonClosure(input, path);
  assertAllowedKeys(input, CLAIM_ALLOWED_KEYS, path);
  requiredKeys(input, CLAIM_REQUIRED_KEYS, path);
  const identity = parseIdentityPair(input, path);
  const claimKind = assertEnum(
    optOwn(input, 'claim_kind'), CLAIM_KINDS, 'unknown_claim_kind', `${path}.claim_kind`, 'claim kind',
  );
  const status = assertEnum(
    optOwn(input, 'status'), CLAIM_STATUSES, 'unknown_status', `${path}.status`, 'claim status',
  );
  const code = assertEnum(
    optOwn(input, 'code'), CLAIM_CODES, 'unknown_code', `${path}.code`, 'claim code',
  );
  const payload = parseClosedPayload(input, path, claimKind, CLAIM_PAYLOAD_KEYS);
  const values = {
    claim_id: assertRecordId(optOwn(input, 'claim_id'), `${path}.claim_id`),
    claim_kind: claimKind,
    status,
    code,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    sequence: assertSequence(optOwn(input, 'sequence'), `${path}.sequence`),
    subject: assertSubject(optOwn(input, 'subject'), `${path}.subject`),
    payload,
    payload_digest: bindPayloadDigest(input, payload, path),
    artifact_digests: parseArtifactDigestList(input, path),
  };
  const recordedAt = parseOptionalTimestamp(input, path);
  if (recordedAt !== undefined) values.recorded_at = recordedAt;
  return freezeRecord(CLAIM_ALLOWED_KEYS, values);
}

export function parseVerifiedFactV1(input, path = 'fact') {
  assertPlainObject(input, 'invalid_type', path, `${path}`);
  assertDirectJsonClosure(input, path);
  assertAllowedKeys(input, FACT_ALLOWED_KEYS, path);
  requiredKeys(input, FACT_REQUIRED_KEYS, path);
  const identity = parseIdentityPair(input, path);
  const factKind = assertEnum(
    optOwn(input, 'fact_kind'), FACT_KINDS, 'unknown_fact_kind', `${path}.fact_kind`, 'fact kind',
  );
  const status = assertEnum(
    optOwn(input, 'status'), FACT_STATUSES, 'unknown_status', `${path}.status`, 'fact status',
  );
  const code = assertEnum(
    optOwn(input, 'code'), FACT_CODES, 'unknown_code', `${path}.code`, 'fact code',
  );
  const authority = assertEnum(
    optOwn(input, 'authority'), FACT_AUTHORITIES, 'unknown_authority', `${path}.authority`, 'authority',
  );
  const method = assertEnum(
    optOwn(input, 'method'), FACT_METHODS, 'unknown_method', `${path}.method`, 'method',
  );
  if (!compatibleAuthority(factKind, authority, method)) {
    fail('unsupported_pairing', `${path}.authority`,
      `${path} pairs a fact kind with an authority or method the closed table does not allow.`);
  }
  const truncated = optOwn(input, 'truncated');
  if (truncated !== true && truncated !== false) {
    fail('invalid_type', `${path}.truncated`, `${path}.truncated must be a boolean.`);
  }
  if (truncated === true && status === 'verified') {
    fail('truncated_required_fact', `${path}.status`,
      `${path} cannot be verified while truncated is true.`);
  }
  if (status === 'truncated' && truncated !== true) {
    fail('invalid_format', `${path}.truncated`,
      `${path}.truncated must be true when status is truncated.`);
  }
  const payload = parseClosedPayload(input, path, factKind, FACT_PAYLOAD_KEYS);
  const values = {
    fact_id: assertRecordId(optOwn(input, 'fact_id'), `${path}.fact_id`),
    fact_kind: factKind,
    status,
    code,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    sequence: assertSequence(optOwn(input, 'sequence'), `${path}.sequence`),
    subject: assertSubject(optOwn(input, 'subject'), `${path}.subject`),
    authority,
    method,
    input_digest: assertSha256(optOwn(input, 'input_digest'), `${path}.input_digest`),
    output_digest: assertSha256(optOwn(input, 'output_digest'), `${path}.output_digest`),
    exit_code: (() => {
      const exitCode = optOwn(input, 'exit_code');
      if (exitCode === null) return null;
      return assertSafeInt(exitCode, `${path}.exit_code`, 0, 255);
    })(),
    duration_ms: assertSafeInt(optOwn(input, 'duration_ms'), `${path}.duration_ms`, 0, MAX_DURATION_MS),
    truncated,
    payload,
    payload_digest: bindPayloadDigest(input, payload, path),
    artifact_digests: parseArtifactDigestList(input, path),
  };
  const recordedAt = parseOptionalTimestamp(input, path);
  if (recordedAt !== undefined) values.recorded_at = recordedAt;
  return freezeRecord(FACT_ALLOWED_KEYS, values);
}

export function canonicalProviderClaimJsonV1(input, path = 'claim') {
  return canonicalJsonStringify(parseProviderClaimV1(input, path));
}

export function canonicalVerifiedFactJsonV1(input, path = 'fact') {
  return canonicalJsonStringify(parseVerifiedFactV1(input, path));
}

export { RunContractV1Error as EvidenceContractV1Error };
export { ARTIFACT_REF_SCHEMA_ID };
