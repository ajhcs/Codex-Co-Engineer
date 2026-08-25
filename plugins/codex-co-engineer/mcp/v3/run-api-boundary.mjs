// RunApiBoundaryV1 — side-effect-free projection of already-produced P30
// protected-ref audit receipts and P31 run-orchestration receipts (P32).
//
// Additive v3 adapter. It consumes values only: it does not call P30 audit
// functions, P31 prepare/dispatch/cancel/restart, Git, filesystem, process,
// network, provider, credential, handoff, workspace, reservation,
// supervisor, server, or release mechanisms. Matching run/base identity and
// declared lane/provider identity are bound without broadening either
// upstream authority. Failed/ref-drift audits and non-clean P31 lifecycles
// remain failed/unresolved. Results are detached, deeply frozen,
// content-free, and JSON-serializable. No public MCP tool/server cutover,
// supervisor change, command execution, release decision, Gate A claim, or
// remote mutation authority.

import { Buffer as NodeBuffer } from 'node:buffer';

import {
  DISCREPANCY_CODES,
  DISCREPANCY_KINDS,
  DISCREPANCY_STATUSES,
  FACT_AUTHORITIES,
  FACT_CODES,
  FACT_KINDS,
  FACT_METHODS,
  FACT_STATUSES,
  MAX_DURATION_MS,
  MAX_SEQUENCE,
} from './evidence-bundle.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  isKnownProvider,
  isModelId,
} from './grammar.mjs';
import { REF_CLASS_VALUES } from './git-authority.mjs';
import { GIT_IDENTITY_SCHEMA_ID } from './protected-identity.mjs';
import {
  COMPARISON_KEYS as PROTECTED_REF_AUDIT_COMPARISON_KEYS,
  MAX_AUDIT_REFS,
  PROTECTED_REF_AUDIT_CHECKS,
  PROTECTED_REF_AUDIT_FAILING_CODES,
  PROTECTED_REF_AUDIT_FINDING_CODES,
  PROTECTED_REF_AUDIT_REPOSITORY_KINDS,
  PROTECTED_REF_AUDIT_SCHEMA_ID,
  PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS,
  PROTECTED_REF_AUDIT_STATUSES,
  PROTECTED_REF_AUDIT_STORAGE_CLASSES,
  PROTECTED_REF_AUDIT_VERSION,
  RECEIPT_KEYS as PROTECTED_REF_AUDIT_RECEIPT_KEYS,
} from './protected-ref-audit.mjs';
import {
  RunContractV1Error,
  assertBaseSha,
  assertRunId,
  isAssignmentId,
  isSha40,
} from './run-manifest.mjs';
import {
  ORCHESTRATION_INTENTS,
  RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS,
  RUN_ORCHESTRATION_CHECKS,
  RUN_ORCHESTRATION_ERROR_CODES,
  RUN_ORCHESTRATION_SCHEMA_ID,
  RUN_ORCHESTRATION_SIDE_EFFECTS,
  RUN_ORCHESTRATION_VERSION,
} from './run-orchestration.mjs';
import {
  PREFLIGHT_MAX_CHILDREN,
  PREFLIGHT_MIN_CHILDREN,
  RUN_PREFLIGHT_CHECKS,
  RUN_PREFLIGHT_ERROR_CODES,
  RUN_PREFLIGHT_SCHEMA_ID,
  RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
  RUN_PREFLIGHT_VERSION,
} from './run-preflight.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';

export const RUN_API_BOUNDARY_SCHEMA_ID = 'codex-co-engineer.run-api-boundary.v1';
export const RUN_API_BOUNDARY_VERSION = 1;

export const MAX_API_OBJECT_KEYS = 32;
export const MAX_API_KEY_BYTES = 128;
export const MAX_API_STRING_BYTES = 256;
export const MAX_DROPPED_STRING_BYTES = 4096;
export const MAX_API_COLLECTION = MAX_AUDIT_REFS;
export const MAX_API_LANES = PREFLIGHT_MAX_CHILDREN;

export const RUN_API_BOUNDARY_STATUSES = capturedFreeze([
  'denied', 'failed', 'ready', 'unresolved',
]);
export const RUN_API_BOUNDARY_ORCHESTRATION_KINDS = capturedFreeze(['denial', 'receipt']);
export const RUN_API_BOUNDARY_CHECKS = capturedFreeze([
  'request_quarantine',
  'p30_receipt_schema',
  'p31_receipt_or_denial_schema',
  'identity_binding',
  'negative_evidence_preservation',
  'content_free_projection',
  'side_effect_free_adapter',
  'remote_mutation_denied',
]);
export const RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS = capturedFreeze([
  'audit_executed',
  'orchestration_executed',
  'git_invoked',
  'filesystem_invoked',
  'process_invoked',
  'network_invoked',
  'provider_invoked',
  'credentials_accessed',
  'env_accessed',
  'argv_accessed',
  'handoff_accessed',
  'workspace_created',
  'reservation_held',
  'remote_mutated',
  'supervisor_cutover',
  'public_api_exposed',
  'release_decided',
  'gate_a_claimed',
]);
export const RUN_API_BOUNDARY_INVARIANT_KEYS = capturedFreeze([
  'read_only_audit',
  'credentials_not_projected',
  'refs_not_mutated',
  'workspace_not_created',
  'reservation_not_held',
  'provider_isolated',
  'cleanup_truthful',
  'remote_mutated',
  'public_api_exposed',
  'gate_a_claimed',
  'release_decided',
  'supervisor_cutover',
]);

export const INPUT_ALLOWED_KEYS = capturedFreeze([
  'audit', 'identity', 'lifecycle', 'orchestration', 'schema', 'version',
]);
export const INPUT_REQUIRED_KEYS = capturedFreeze([
  'audit', 'identity', 'orchestration', 'schema', 'version',
]);
export const IDENTITY_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'provider', 'run_id',
]);
export const IDENTITY_REQUIRED_KEYS = capturedFreeze(['base_sha', 'run_id']);
export const AUDIT_FINDING_KEYS = capturedFreeze([
  'code', 'default_branch_target', 'protected', 'ref_class', 'storage',
]);
export const AUDIT_OBSERVATION_KEYS = capturedFreeze([
  'command_count', 'compared_count', 'duration_ms', 'loose_count',
  'missing_count', 'packed_count', 'symbolic_count',
]);
export const AUDIT_FACT_ALLOWED_KEYS = capturedFreeze([
  'artifact_digests', 'assignment_id', 'authority', 'code', 'duration_ms',
  'exit_code', 'fact_id', 'fact_kind', 'input_digest', 'method',
  'output_digest', 'payload', 'payload_digest', 'recorded_at', 'run_id',
  'sequence', 'status', 'subject', 'truncated',
]);
export const AUDIT_FACT_REQUIRED_KEYS = capturedFreeze([
  'artifact_digests', 'assignment_id', 'authority', 'code', 'duration_ms',
  'exit_code', 'fact_id', 'fact_kind', 'input_digest', 'method',
  'output_digest', 'payload', 'run_id', 'sequence', 'status', 'subject',
  'truncated',
]);
export const AUDIT_FACT_PAYLOAD_KEYS = capturedFreeze(['base_sha', 'head_sha']);
export const AUDIT_DISCREPANCY_ALLOWED_KEYS = capturedFreeze([
  'artifact_digests', 'assignment_id', 'claim_ids', 'code', 'discrepancy_id',
  'discrepancy_kind', 'fact_ids', 'recorded_at', 'run_id', 'sequence', 'status',
]);
export const AUDIT_DISCREPANCY_REQUIRED_KEYS = capturedFreeze([
  'artifact_digests', 'assignment_id', 'claim_ids', 'code', 'discrepancy_id',
  'discrepancy_kind', 'fact_ids', 'run_id', 'sequence', 'status',
]);
export const PREFLIGHT_RECEIPT_KEYS = capturedFreeze([
  'capacity', 'checks', 'children', 'git_identity', 'repository', 'run_id',
  'schema', 'side_effects', 'status', 'version',
]);
export const PREFLIGHT_CHILD_KEYS = capturedFreeze([
  'assignment_ids', 'concurrency', 'count', 'independent', 'maximum',
  'minimum', 'scope_pair_checks',
]);
export const PREFLIGHT_CAPACITY_KEYS = capturedFreeze([
  'available_ram_bytes', 'cpu_ok', 'cpu_parallelism', 'ram_ok',
  'required_ram_bytes', 'source', 'total_ram_bytes',
]);
export const PREFLIGHT_REPOSITORY_KEYS = capturedFreeze([
  'base_sha', 'git_dir', 'object_type', 'path',
]);
export const GIT_IDENTITY_ALLOWED_KEYS = capturedFreeze([
  'base_sha', 'digest', 'repository_path', 'schema',
]);
export const ORCHESTRATION_RECEIPT_KEYS = capturedFreeze([
  'checks', 'intent', 'lanes', 'preflight', 'run_id', 'schema',
  'side_effects', 'status', 'version',
]);
export const ORCHESTRATION_LANE_KEYS = capturedFreeze([
  'assignment_id', 'credential_present', 'identity', 'model', 'projected_keys',
  'provider', 'status',
]);
export const ORCHESTRATION_DENIAL_KEYS = capturedFreeze([
  'code', 'run_id', 'schema', 'version',
]);
export const ORCHESTRATION_DENIAL_REQUIRED_KEYS = capturedFreeze([
  'code', 'schema', 'version',
]);
export const LIFECYCLE_ALLOWED_KEYS = capturedFreeze([
  'cleaned', 'missing', 'restarted', 'side_effects', 'status', 'unresolved',
]);
export const LIFECYCLE_REQUIRED_KEYS = capturedFreeze([
  'cleaned', 'status', 'unresolved',
]);
export const LIFECYCLE_STATUSES = capturedFreeze(['cancelled', 'dispatched', 'terminal']);
export const LIFECYCLE_UNRESOLVED_KEYS = capturedFreeze(['assignment_id', 'code']);
export const LIFECYCLE_UNRESOLVED_CODES = capturedFreeze([
  'dispatcher_stop_failed', 'handoff_cleanup_failed',
]);
export const ORCHESTRATION_RECEIPT_STATUSES = capturedFreeze(['dispatched', 'prepared']);
export const ORCHESTRATION_LANE_STATUSES = capturedFreeze([
  'projected', 'selection_unresolved',
]);
export const PREFLIGHT_CAPACITY_SOURCES = capturedFreeze(['ambient', 'injected']);
export const COMPARISON_OUTCOMES = capturedFreeze([
  'aliased_ref', 'match', 'missing_ref', 'moved_ref', 'symbolic_ref',
]);
export const RESULT_KEYS = capturedFreeze([
  'assignment_id', 'audit', 'base_sha', 'checks', 'invariants', 'lifecycle',
  'orchestration', 'provider', 'run_id', 'schema', 'side_effects', 'status',
  'version',
]);

export const RUN_API_BOUNDARY_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'bounds_exceeded',
  'exotic_prototype_denied', 'identity_mismatch', 'invalid_format',
  'invalid_type', 'missing_key', 'non_enumerable_property_denied',
  'out_of_range', 'own_undefined_denied', 'proxy_denied', 'symbol_key_denied',
  'unknown_key', 'value_depth_exceeded',
]);

const DEFINE = Object.defineProperty;
const OBJECT_IS = Object.is;
const IS_INT = Number.isSafeInteger;
const STRING = String;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const IS_ARRAY = capturedIsArray;
const OWN_KEYS = capturedOwnKeys;
const SET_CTOR = Set;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_LABELED_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RECORD_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const LANE_IDENTITY_PATTERN = /^[0-9a-f]{32}$/u;
const PROJECTED_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const DENIAL_CODES = capturedFreeze([
  ...RUN_PREFLIGHT_ERROR_CODES,
  ...RUN_ORCHESTRATION_ERROR_CODES,
]);
const MSG = capturedFreeze({
  accessor_property_denied: 'RunApiBoundaryV1 denies accessor inputs.',
  aliased_reference_denied: 'RunApiBoundaryV1 denies aliased inputs.',
  bounds_exceeded: 'RunApiBoundaryV1 exceeded a closed projection bound.',
  exotic_prototype_denied: 'RunApiBoundaryV1 denies exotic prototypes.',
  identity_mismatch: 'RunApiBoundaryV1 requires matching run, base, lane, and provider identity.',
  invalid_format: 'RunApiBoundaryV1 rejected a value that violates a closed grammar.',
  invalid_type: 'RunApiBoundaryV1 rejected a non-JSON projection value.',
  missing_key: 'RunApiBoundaryV1 requires every canonical projection key.',
  non_enumerable_property_denied: 'RunApiBoundaryV1 denies non-enumerable properties.',
  out_of_range: 'RunApiBoundaryV1 rejected a value outside closed bounds.',
  own_undefined_denied: 'RunApiBoundaryV1 denies own undefined values.',
  proxy_denied: 'RunApiBoundaryV1 denies Proxy inputs.',
  symbol_key_denied: 'RunApiBoundaryV1 denies symbol keys.',
  unknown_key: 'RunApiBoundaryV1 rejects keys outside the closed vocabulary.',
  value_depth_exceeded: 'RunApiBoundaryV1 rejected nested input that exceeds closed depth.',
});
const CLOSURE_REMAP = capturedFreeze({
  accessor_property_denied: 'accessor_property_denied',
  aliased_reference_denied: 'aliased_reference_denied',
  exotic_prototype_denied: 'exotic_prototype_denied',
  invalid_array: 'invalid_type',
  invalid_json_type: 'invalid_type',
  invalid_json_value: 'invalid_type',
  invalid_type: 'invalid_type',
  non_enumerable_property_denied: 'non_enumerable_property_denied',
  own_undefined_denied: 'own_undefined_denied',
  proxy_denied: 'proxy_denied',
  symbol_key_denied: 'symbol_key_denied',
  value_depth_exceeded: 'value_depth_exceeded',
});

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!capturedHasOwn(values, key)) continue;
    DEFINE(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function deny(code, pathLabel) {
  fail(code, pathLabel, MSG[code] ?? MSG.invalid_format);
}

function remapClosure(error, pathLabel) {
  if (error instanceof RunContractV1Error) {
    const mapped = CLOSURE_REMAP[error.code];
    if (typeof mapped === 'string') deny(mapped, pathLabel);
  }
  deny('invalid_type', pathLabel);
}

function assertClosedObject(input, allowed, pathLabel) {
  if (input === undefined || input === null) deny('invalid_type', pathLabel);
  if (typeof input === 'object' || typeof input === 'function') {
    try { assertNotProxy(input, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  }
  if (typeof input !== 'object') deny('invalid_type', pathLabel);
  if (IS_ARRAY(input)) deny('invalid_type', pathLabel);
  try {
    assertDirectJsonClosure(input, pathLabel);
  } catch (error) { remapClosure(error, pathLabel); }
  let keys;
  try { keys = OWN_KEYS(input); } catch { deny('invalid_type', pathLabel); }
  if (keys.length > MAX_API_OBJECT_KEYS) deny('bounds_exceeded', pathLabel);
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (typeof key !== 'string' || BYTE_LENGTH(key, 'utf8') > MAX_API_KEY_BYTES) {
      deny('bounds_exceeded', pathLabel);
    }
    if (!allowedSet.has(key)) deny('unknown_key', pathLabel);
  }
  return input;
}

function requireKeys(input, keys, pathLabel) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasOwn(input, keys[i])) deny('missing_key', pathLabel);
  }
}

function exactKeySet(input, keys, pathLabel) {
  requireKeys(input, keys, pathLabel);
  const owned = OWN_KEYS(input);
  if (owned.length !== keys.length) deny('unknown_key', pathLabel);
}

function ownString(input, key, pathLabel, maxBytes = MAX_API_STRING_BYTES) {
  const value = ownDataValue(input, key, pathLabel);
  if (typeof value !== 'string') deny('invalid_type', pathLabel);
  if (BYTE_LENGTH(value, 'utf8') > maxBytes) deny('bounds_exceeded', pathLabel);
  return value;
}

function optionalString(input, key, pathLabel, maxBytes = MAX_API_STRING_BYTES) {
  if (!hasOwn(input, key)) return undefined;
  return ownString(input, key, pathLabel, maxBytes);
}

function ownBoolean(input, key, pathLabel) {
  const value = ownDataValue(input, key, pathLabel);
  if (value !== true && value !== false) deny('invalid_type', pathLabel);
  return value;
}

function optionalBoolean(input, key, pathLabel) {
  if (!hasOwn(input, key)) return undefined;
  return ownBoolean(input, key, pathLabel);
}

function ownEnum(input, key, allowed, pathLabel) {
  const value = ownString(input, key, pathLabel);
  if (!capturedIncludes(allowed, value)) deny('invalid_format', pathLabel);
  return value;
}

function ownInt(input, key, pathLabel, min, max) {
  const value = ownDataValue(input, key, pathLabel);
  if (typeof value !== 'number' || !IS_INT(value) || value < min || value > max) {
    deny('out_of_range', pathLabel);
  }
  return value;
}

function ownArray(input, key, pathLabel, maxLength) {
  const value = ownDataValue(input, key, pathLabel);
  try { assertNotProxy(value, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  if (!IS_ARRAY(value)) deny('invalid_type', pathLabel);
  if (value.length > maxLength) deny('bounds_exceeded', pathLabel);
  return value;
}

function ownSha256(input, key, pathLabel) {
  const value = ownString(input, key, pathLabel);
  if (!capturedTest(SHA256_PATTERN, value)) deny('invalid_format', pathLabel);
  return value;
}

function ownRecordId(input, key, pathLabel) {
  const value = ownString(input, key, pathLabel);
  if (!capturedTest(RECORD_ID_PATTERN, value)) deny('invalid_format', pathLabel);
  return value;
}

function bindRunId(value, pathLabel) {
  try {
    assertRunId(value, pathLabel);
  } catch (error) {
    if (error instanceof RunContractV1Error) deny('invalid_format', pathLabel);
    deny('invalid_type', pathLabel);
  }
  return value;
}

function bindBaseSha(value, pathLabel) {
  try {
    assertBaseSha(value, pathLabel);
  } catch (error) {
    if (error instanceof RunContractV1Error) deny('invalid_format', pathLabel);
    deny('invalid_type', pathLabel);
  }
  return value;
}

function bindAssignmentId(value, pathLabel) {
  if (!isAssignmentId(value)) deny('invalid_format', pathLabel);
  return value;
}

function sameIdentity(left, right, pathLabel) {
  if (!OBJECT_IS(left, right)) deny('identity_mismatch', pathLabel);
}

function emptySideEffects() {
  const values = {};
  for (let i = 0; i < RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS.length; i += 1) {
    values[RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS[i]] = false;
  }
  return freezeRecord(RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS, values);
}

function parseBooleanMap(input, keys, alwaysFalse, pathLabel) {
  assertClosedObject(input, keys, pathLabel);
  exactKeySet(input, keys, pathLabel);
  const values = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = ownBoolean(input, key, pathLabel);
    if (capturedIncludes(alwaysFalse, key) && value !== false) deny('invalid_format', pathLabel);
    values[key] = value;
  }
  return freezeRecord(keys, values);
}

function parseStringList(input, allowedPattern, pathLabel, maxLength, maxBytes = MAX_API_STRING_BYTES) {
  if (input.length > maxLength) deny('bounds_exceeded', pathLabel);
  const seen = new SET_CTOR();
  const values = [];
  for (let i = 0; i < input.length; i += 1) {
    const itemPath = pathLabel;
    const value = ownDataValue(input, STRING(i), itemPath);
    if (typeof value !== 'string') deny('invalid_type', itemPath);
    if (BYTE_LENGTH(value, 'utf8') > maxBytes) deny('bounds_exceeded', itemPath);
    if (allowedPattern && !capturedTest(allowedPattern, value)) deny('invalid_format', itemPath);
    if (seen.has(value)) deny('invalid_format', itemPath);
    seen.add(value);
    values.push(value);
  }
  return capturedFreeze(values);
}

function parseEnumList(input, allowed, pathLabel, maxLength) {
  if (input.length > maxLength) deny('bounds_exceeded', pathLabel);
  const seen = new SET_CTOR();
  const values = [];
  for (let i = 0; i < input.length; i += 1) {
    const value = ownDataValue(input, STRING(i), pathLabel);
    if (typeof value !== 'string') deny('invalid_type', pathLabel);
    if (!capturedIncludes(allowed, value)) deny('invalid_format', pathLabel);
    if (seen.has(value)) deny('invalid_format', pathLabel);
    seen.add(value);
    values.push(value);
  }
  return capturedFreeze(values);
}

function parseIdentity(input) {
  const pathLabel = 'identity';
  assertClosedObject(input, IDENTITY_ALLOWED_KEYS, pathLabel);
  requireKeys(input, IDENTITY_REQUIRED_KEYS, pathLabel);
  const runId = bindRunId(ownString(input, 'run_id', pathLabel), pathLabel);
  const baseSha = bindBaseSha(ownString(input, 'base_sha', pathLabel), pathLabel);
  const values = { run_id: runId, base_sha: baseSha };
  if (hasOwn(input, 'assignment_id')) {
    values.assignment_id = bindAssignmentId(ownString(input, 'assignment_id', pathLabel), pathLabel);
  }
  if (hasOwn(input, 'provider')) {
    const provider = ownString(input, 'provider', pathLabel);
    if (!isKnownProvider(provider)) deny('invalid_format', pathLabel);
    values.provider = provider;
  }
  return freezeRecord(IDENTITY_ALLOWED_KEYS, values);
}

function parseFactPayload(input, pathLabel, expectedBase) {
  assertClosedObject(input, AUDIT_FACT_PAYLOAD_KEYS, pathLabel);
  requireKeys(input, AUDIT_FACT_PAYLOAD_KEYS, pathLabel);
  const baseSha = bindBaseSha(ownString(input, 'base_sha', pathLabel), pathLabel);
  sameIdentity(baseSha, expectedBase, pathLabel);
  const headSha = ownString(input, 'head_sha', pathLabel);
  if (!isSha40(headSha)) deny('invalid_format', pathLabel);
  return freezeRecord(AUDIT_FACT_PAYLOAD_KEYS, { base_sha: baseSha, head_sha: headSha });
}

function parseDigestList(input, pathLabel) {
  if (input.length > MAX_API_COLLECTION) deny('bounds_exceeded', pathLabel);
  const values = [];
  for (let i = 0; i < input.length; i += 1) {
    const value = ownDataValue(input, STRING(i), pathLabel);
    if (typeof value !== 'string') deny('invalid_type', pathLabel);
    if (!capturedTest(SHA256_LABELED_PATTERN, value) && !capturedTest(SHA256_PATTERN, value)) {
      deny('invalid_format', pathLabel);
    }
    values.push(value);
  }
  return capturedFreeze(values);
}

function parseFact(input, pathLabel, identity) {
  assertClosedObject(input, AUDIT_FACT_ALLOWED_KEYS, pathLabel);
  requireKeys(input, AUDIT_FACT_REQUIRED_KEYS, pathLabel);
  const factKind = ownEnum(input, 'fact_kind', FACT_KINDS, pathLabel);
  const status = ownEnum(input, 'status', FACT_STATUSES, pathLabel);
  const code = ownEnum(input, 'code', FACT_CODES, pathLabel);
  const authority = ownEnum(input, 'authority', FACT_AUTHORITIES, pathLabel);
  const method = ownEnum(input, 'method', FACT_METHODS, pathLabel);
  if (factKind !== 'git_identity' || authority !== 'platform_git'
    || method !== 'protected_ref_snapshot_compare' || code !== 'host_observed') {
    deny('invalid_format', pathLabel);
  }
  const runId = bindRunId(ownString(input, 'run_id', pathLabel), pathLabel);
  sameIdentity(runId, identity.run_id, pathLabel);
  const assignmentId = bindAssignmentId(ownString(input, 'assignment_id', pathLabel), pathLabel);
  sameIdentity(assignmentId, identity.assignment_id, pathLabel);
  const truncated = ownBoolean(input, 'truncated', pathLabel);
  if (truncated === true && status === 'verified') deny('invalid_format', pathLabel);
  const exitRaw = ownDataValue(input, 'exit_code', pathLabel);
  let exitCode = exitRaw;
  if (exitRaw !== null) {
    if (typeof exitRaw !== 'number' || !IS_INT(exitRaw) || exitRaw < 0 || exitRaw > 255) {
      deny('out_of_range', pathLabel);
    }
    exitCode = exitRaw;
  }
  const payload = parseFactPayload(ownDataValue(input, 'payload', pathLabel), pathLabel, identity.base_sha);
  if (hasOwn(input, 'payload_digest')) ownSha256(input, 'payload_digest', pathLabel);
  if (hasOwn(input, 'recorded_at')) {
    const recordedAt = ownString(input, 'recorded_at', pathLabel);
    if (!capturedTest(TIMESTAMP_PATTERN, recordedAt)) deny('invalid_format', pathLabel);
  }
  return freezeRecord(['authority', 'code', 'fact_kind', 'method', 'status', 'truncated'], {
    fact_kind: factKind,
    status,
    code,
    authority,
    method,
    truncated,
    // exit_code is validated so forged verified/failed pairings cannot hide
    // behind an impossible code, then dropped from the public summary.
    _exit_code: exitCode,
    _sequence: ownInt(input, 'sequence', pathLabel, 0, MAX_SEQUENCE),
    _duration_ms: ownInt(input, 'duration_ms', pathLabel, 0, MAX_DURATION_MS),
    _fact_id: ownRecordId(input, 'fact_id', pathLabel),
    _subject: (() => {
      const subject = ownString(input, 'subject', pathLabel);
      if (!capturedTest(SUBJECT_PATTERN, subject)) deny('invalid_format', pathLabel);
      return subject;
    })(),
    _input_digest: ownSha256(input, 'input_digest', pathLabel),
    _output_digest: ownSha256(input, 'output_digest', pathLabel),
    _artifact_digests: parseDigestList(ownArray(input, 'artifact_digests', pathLabel, MAX_API_COLLECTION), pathLabel),
    _payload: payload,
  });
}

function projectFact(parsed) {
  return freezeRecord(
    ['authority', 'code', 'fact_kind', 'method', 'status', 'truncated'],
    {
      fact_kind: parsed.fact_kind,
      status: parsed.status,
      code: parsed.code,
      authority: parsed.authority,
      method: parsed.method,
      truncated: parsed.truncated,
    },
  );
}

function parseDiscrepancy(input, pathLabel, identity) {
  assertClosedObject(input, AUDIT_DISCREPANCY_ALLOWED_KEYS, pathLabel);
  requireKeys(input, AUDIT_DISCREPANCY_REQUIRED_KEYS, pathLabel);
  const kind = ownEnum(input, 'discrepancy_kind', DISCREPANCY_KINDS, pathLabel);
  const status = ownEnum(input, 'status', DISCREPANCY_STATUSES, pathLabel);
  const code = ownEnum(input, 'code', DISCREPANCY_CODES, pathLabel);
  if (kind !== 'security' || code !== 'security_boundary' || status !== 'recorded') {
    deny('invalid_format', pathLabel);
  }
  const runId = bindRunId(ownString(input, 'run_id', pathLabel), pathLabel);
  sameIdentity(runId, identity.run_id, pathLabel);
  const assignmentId = bindAssignmentId(ownString(input, 'assignment_id', pathLabel), pathLabel);
  sameIdentity(assignmentId, identity.assignment_id, pathLabel);
  ownRecordId(input, 'discrepancy_id', pathLabel);
  ownInt(input, 'sequence', pathLabel, 0, MAX_SEQUENCE);
  parseDigestList(ownArray(input, 'artifact_digests', pathLabel, MAX_API_COLLECTION), pathLabel);
  const claimIds = ownArray(input, 'claim_ids', pathLabel, MAX_API_COLLECTION);
  parseStringList(claimIds, RECORD_ID_PATTERN, pathLabel, MAX_API_COLLECTION);
  const factIds = ownArray(input, 'fact_ids', pathLabel, MAX_API_COLLECTION);
  parseStringList(factIds, RECORD_ID_PATTERN, pathLabel, MAX_API_COLLECTION);
  if (hasOwn(input, 'recorded_at')) {
    const recordedAt = ownString(input, 'recorded_at', pathLabel);
    if (!capturedTest(TIMESTAMP_PATTERN, recordedAt)) deny('invalid_format', pathLabel);
  }
  return freezeRecord(['code', 'discrepancy_kind', 'status'], {
    discrepancy_kind: kind,
    status,
    code,
  });
}

function parseComparison(input, pathLabel) {
  assertClosedObject(input, PROTECTED_REF_AUDIT_COMPARISON_KEYS, pathLabel);
  exactKeySet(input, PROTECTED_REF_AUDIT_COMPARISON_KEYS, pathLabel);
  return freezeRecord(PROTECTED_REF_AUDIT_COMPARISON_KEYS, {
    outcome: ownEnum(input, 'outcome', COMPARISON_OUTCOMES, pathLabel),
    storage: ownEnum(input, 'storage', PROTECTED_REF_AUDIT_STORAGE_CLASSES, pathLabel),
    ref_class: ownEnum(input, 'ref_class', REF_CLASS_VALUES, pathLabel),
    protected: ownBoolean(input, 'protected', pathLabel),
    default_branch_target: ownBoolean(input, 'default_branch_target', pathLabel),
  });
}

function parseFinding(input, pathLabel) {
  assertClosedObject(input, AUDIT_FINDING_KEYS, pathLabel);
  exactKeySet(input, AUDIT_FINDING_KEYS, pathLabel);
  return freezeRecord(AUDIT_FINDING_KEYS, {
    code: ownEnum(input, 'code', PROTECTED_REF_AUDIT_FINDING_CODES, pathLabel),
    storage: ownEnum(input, 'storage', PROTECTED_REF_AUDIT_STORAGE_CLASSES, pathLabel),
    ref_class: ownEnum(input, 'ref_class', REF_CLASS_VALUES, pathLabel),
    protected: ownBoolean(input, 'protected', pathLabel),
    default_branch_target: ownBoolean(input, 'default_branch_target', pathLabel),
  });
}

function parseObservation(input, pathLabel, comparedCount) {
  assertClosedObject(input, AUDIT_OBSERVATION_KEYS, pathLabel);
  exactKeySet(input, AUDIT_OBSERVATION_KEYS, pathLabel);
  const compared = ownInt(input, 'compared_count', pathLabel, 0, MAX_AUDIT_REFS);
  if (compared !== comparedCount) deny('invalid_format', pathLabel);
  ownInt(input, 'command_count', pathLabel, 0, 64);
  ownInt(input, 'duration_ms', pathLabel, 0, MAX_DURATION_MS);
  return freezeRecord(
    ['compared_count', 'loose_count', 'missing_count', 'packed_count', 'symbolic_count'],
    {
      compared_count: compared,
      loose_count: ownInt(input, 'loose_count', pathLabel, 0, MAX_AUDIT_REFS),
      missing_count: ownInt(input, 'missing_count', pathLabel, 0, MAX_AUDIT_REFS),
      packed_count: ownInt(input, 'packed_count', pathLabel, 0, MAX_AUDIT_REFS),
      symbolic_count: ownInt(input, 'symbolic_count', pathLabel, 0, MAX_AUDIT_REFS),
    },
  );
}

function parseAudit(input, identity) {
  const pathLabel = 'audit';
  assertClosedObject(input, PROTECTED_REF_AUDIT_RECEIPT_KEYS, pathLabel);
  exactKeySet(input, PROTECTED_REF_AUDIT_RECEIPT_KEYS, pathLabel);
  const schema = ownString(input, 'schema', pathLabel);
  if (schema !== PROTECTED_REF_AUDIT_SCHEMA_ID) deny('invalid_format', pathLabel);
  const version = ownDataValue(input, 'version', pathLabel);
  if (version !== PROTECTED_REF_AUDIT_VERSION) deny('invalid_format', pathLabel);
  const status = ownEnum(input, 'status', PROTECTED_REF_AUDIT_STATUSES, pathLabel);
  const runId = bindRunId(ownString(input, 'run_id', pathLabel), pathLabel);
  sameIdentity(runId, identity.run_id, pathLabel);
  const assignmentId = bindAssignmentId(ownString(input, 'assignment_id', pathLabel), pathLabel);
  if (hasOwn(identity, 'assignment_id')) sameIdentity(assignmentId, identity.assignment_id, pathLabel);
  const baseSha = bindBaseSha(ownString(input, 'base_sha', pathLabel), pathLabel);
  sameIdentity(baseSha, identity.base_sha, pathLabel);
  const boundIdentity = freezeRecord(['assignment_id', 'base_sha', 'run_id'], {
    run_id: runId,
    assignment_id: assignmentId,
    base_sha: baseSha,
  });
  const comparisonsIn = ownArray(input, 'comparisons', pathLabel, MAX_AUDIT_REFS);
  const comparisons = [];
  for (let i = 0; i < comparisonsIn.length; i += 1) {
    comparisons.push(parseComparison(ownDataValue(comparisonsIn, STRING(i), pathLabel), pathLabel));
  }
  const findingsIn = ownArray(input, 'findings', pathLabel, MAX_AUDIT_REFS);
  const findings = [];
  for (let i = 0; i < findingsIn.length; i += 1) {
    findings.push(parseFinding(ownDataValue(findingsIn, STRING(i), pathLabel), pathLabel));
  }
  const observed = parseEnumList(
    ownArray(input, 'observed_classes', pathLabel, MAX_AUDIT_REFS),
    PROTECTED_REF_AUDIT_FINDING_CODES,
    pathLabel,
    MAX_AUDIT_REFS,
  );
  const factsIn = ownArray(input, 'facts', pathLabel, 1);
  if (factsIn.length !== 1) deny('invalid_format', pathLabel);
  const facts = [parseFact(ownDataValue(factsIn, '0', pathLabel), pathLabel, boundIdentity)];
  const discrepanciesIn = ownArray(input, 'discrepancies', pathLabel, 1);
  const discrepancies = [];
  for (let i = 0; i < discrepanciesIn.length; i += 1) {
    discrepancies.push(parseDiscrepancy(ownDataValue(discrepanciesIn, STRING(i), pathLabel), pathLabel, boundIdentity));
  }
  if (status === 'failed' && discrepancies.length !== 1) deny('invalid_format', pathLabel);
  if (status === 'verified' && discrepancies.length !== 0) deny('invalid_format', pathLabel);
  if (facts[0].status !== status) deny('invalid_format', pathLabel);
  return {
    schema,
    version,
    status,
    run_id: runId,
    assignment_id: assignmentId,
    base_sha: baseSha,
    repository_kind: ownEnum(input, 'repository_kind', PROTECTED_REF_AUDIT_REPOSITORY_KINDS, pathLabel),
    comparisons: capturedFreeze(comparisons),
    findings: capturedFreeze(findings),
    observed_classes: observed,
    facts: capturedFreeze(facts.map(projectFact)),
    fact_statuses: capturedFreeze(facts.map((fact) => fact.status)),
    discrepancies: capturedFreeze(discrepancies),
    side_effects: parseBooleanMap(
      ownDataValue(input, 'side_effects', pathLabel),
      PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS,
      PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS,
      pathLabel,
    ),
    observation: parseObservation(
      ownDataValue(input, 'observation', pathLabel),
      pathLabel,
      comparisons.length,
    ),
  };
}

function parseGitIdentity(input, pathLabel, expectedBase) {
  assertClosedObject(input, GIT_IDENTITY_ALLOWED_KEYS, pathLabel);
  requireKeys(input, capturedFreeze(['base_sha', 'digest', 'schema']), pathLabel);
  const schema = ownString(input, 'schema', pathLabel);
  if (schema !== GIT_IDENTITY_SCHEMA_ID) deny('invalid_format', pathLabel);
  const baseSha = bindBaseSha(ownString(input, 'base_sha', pathLabel), pathLabel);
  sameIdentity(baseSha, expectedBase, pathLabel);
  const digest = ownString(input, 'digest', pathLabel, MAX_DROPPED_STRING_BYTES);
  if (!capturedTest(SHA256_PATTERN, digest) && !capturedTest(SHA256_LABELED_PATTERN, digest)) {
    deny('invalid_format', pathLabel);
  }
  if (hasOwn(input, 'repository_path')) {
    ownString(input, 'repository_path', pathLabel, MAX_DROPPED_STRING_BYTES);
  }
}

function parseRepository(input, pathLabel, expectedBase) {
  assertClosedObject(input, PREFLIGHT_REPOSITORY_KEYS, pathLabel);
  requireKeys(input, PREFLIGHT_REPOSITORY_KEYS, pathLabel);
  const baseSha = bindBaseSha(ownString(input, 'base_sha', pathLabel), pathLabel);
  sameIdentity(baseSha, expectedBase, pathLabel);
  const objectType = ownString(input, 'object_type', pathLabel);
  if (objectType !== 'commit') deny('invalid_format', pathLabel);
  ownString(input, 'path', pathLabel, MAX_DROPPED_STRING_BYTES);
  ownString(input, 'git_dir', pathLabel, MAX_DROPPED_STRING_BYTES);
  return baseSha;
}

function parseChildren(input, pathLabel) {
  assertClosedObject(input, PREFLIGHT_CHILD_KEYS, pathLabel);
  exactKeySet(input, PREFLIGHT_CHILD_KEYS, pathLabel);
  const count = ownInt(input, 'count', pathLabel, PREFLIGHT_MIN_CHILDREN, PREFLIGHT_MAX_CHILDREN);
  const minimum = ownInt(input, 'minimum', pathLabel, PREFLIGHT_MIN_CHILDREN, PREFLIGHT_MAX_CHILDREN);
  const maximum = ownInt(input, 'maximum', pathLabel, PREFLIGHT_MIN_CHILDREN, PREFLIGHT_MAX_CHILDREN);
  if (minimum !== PREFLIGHT_MIN_CHILDREN || maximum !== PREFLIGHT_MAX_CHILDREN) {
    deny('invalid_format', pathLabel);
  }
  const assignmentIds = parseStringList(
    ownArray(input, 'assignment_ids', pathLabel, PREFLIGHT_MAX_CHILDREN),
    /^[a-z][a-z0-9-]{0,63}$/u,
    pathLabel,
    PREFLIGHT_MAX_CHILDREN,
  );
  if (assignmentIds.length !== count) deny('invalid_format', pathLabel);
  const independent = ownBoolean(input, 'independent', pathLabel);
  if (independent !== true) deny('invalid_format', pathLabel);
  ownInt(input, 'concurrency', pathLabel, PREFLIGHT_MIN_CHILDREN, PREFLIGHT_MAX_CHILDREN);
  ownInt(input, 'scope_pair_checks', pathLabel, 0, 4096);
  return assignmentIds;
}

function parseCapacity(input, pathLabel) {
  assertClosedObject(input, PREFLIGHT_CAPACITY_KEYS, pathLabel);
  exactKeySet(input, PREFLIGHT_CAPACITY_KEYS, pathLabel);
  ownEnum(input, 'source', PREFLIGHT_CAPACITY_SOURCES, pathLabel);
  ownInt(input, 'cpu_parallelism', pathLabel, 0, 10_000);
  ownInt(input, 'total_ram_bytes', pathLabel, 0, Number.MAX_SAFE_INTEGER);
  ownInt(input, 'available_ram_bytes', pathLabel, 0, Number.MAX_SAFE_INTEGER);
  ownInt(input, 'required_ram_bytes', pathLabel, 0, Number.MAX_SAFE_INTEGER);
  return {
    cpu_ok: ownBoolean(input, 'cpu_ok', pathLabel),
    ram_ok: ownBoolean(input, 'ram_ok', pathLabel),
  };
}

function parseChecks(input, expected, pathLabel) {
  try { assertNotProxy(input, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  if (!IS_ARRAY(input)) deny('invalid_type', pathLabel);
  if (input.length !== expected.length) deny('invalid_format', pathLabel);
  for (let i = 0; i < expected.length; i += 1) {
    const value = ownDataValue(input, STRING(i), pathLabel);
    if (value !== expected[i]) deny('invalid_format', pathLabel);
  }
  return expected;
}

function parsePreflight(input, pathLabel, identity) {
  assertClosedObject(input, PREFLIGHT_RECEIPT_KEYS, pathLabel);
  exactKeySet(input, PREFLIGHT_RECEIPT_KEYS, pathLabel);
  const schema = ownString(input, 'schema', pathLabel);
  if (schema !== RUN_PREFLIGHT_SCHEMA_ID) deny('invalid_format', pathLabel);
  const version = ownDataValue(input, 'version', pathLabel);
  if (version !== RUN_PREFLIGHT_VERSION) deny('invalid_format', pathLabel);
  const status = ownString(input, 'status', pathLabel);
  if (status !== 'ready') deny('invalid_format', pathLabel);
  const runId = bindRunId(ownString(input, 'run_id', pathLabel), pathLabel);
  sameIdentity(runId, identity.run_id, pathLabel);
  const assignmentIds = parseChildren(ownDataValue(input, 'children', pathLabel), pathLabel);
  const capacity = parseCapacity(ownDataValue(input, 'capacity', pathLabel), pathLabel);
  parseRepository(ownDataValue(input, 'repository', pathLabel), pathLabel, identity.base_sha);
  parseGitIdentity(ownDataValue(input, 'git_identity', pathLabel), pathLabel, identity.base_sha);
  parseChecks(ownDataValue(input, 'checks', pathLabel), RUN_PREFLIGHT_CHECKS, pathLabel);
  parseBooleanMap(
    ownDataValue(input, 'side_effects', pathLabel),
    RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
    RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
    pathLabel,
  );
  return {
    status,
    assignment_ids: assignmentIds,
    cpu_ok: capacity.cpu_ok,
    ram_ok: capacity.ram_ok,
  };
}

function parseLane(input, pathLabel, seen) {
  assertClosedObject(input, ORCHESTRATION_LANE_KEYS, pathLabel);
  exactKeySet(input, ORCHESTRATION_LANE_KEYS, pathLabel);
  const assignmentId = bindAssignmentId(ownString(input, 'assignment_id', pathLabel), pathLabel);
  if (seen.has(assignmentId)) deny('invalid_format', pathLabel);
  seen.add(assignmentId);
  const status = ownEnum(input, 'status', ORCHESTRATION_LANE_STATUSES, pathLabel);
  const identity = ownString(input, 'identity', pathLabel);
  if (!capturedTest(LANE_IDENTITY_PATTERN, identity)) deny('invalid_format', pathLabel);
  const projected = ownArray(input, 'projected_keys', pathLabel, 64);
  parseStringList(projected, PROJECTED_KEY_PATTERN, pathLabel, 64, 64);
  const credentialPresent = ownBoolean(input, 'credential_present', pathLabel);
  let provider = ownDataValue(input, 'provider', pathLabel);
  let model = ownDataValue(input, 'model', pathLabel);
  if (status === 'selection_unresolved') {
    if (provider !== null || model !== null) deny('invalid_format', pathLabel);
    provider = null;
    model = null;
  } else {
    if (typeof provider !== 'string' || !isKnownProvider(provider)) deny('invalid_format', pathLabel);
    if (typeof model !== 'string' || !isModelId(model)) deny('invalid_format', pathLabel);
  }
  return freezeRecord(
    ['assignment_id', 'credential_present', 'model', 'provider', 'status'],
    {
      assignment_id: assignmentId,
      provider,
      model,
      status,
      credential_present: credentialPresent,
    },
  );
}

function parseOrchestrationDenial(input, identity) {
  const pathLabel = 'orchestration';
  assertClosedObject(input, ORCHESTRATION_DENIAL_KEYS, pathLabel);
  requireKeys(input, ORCHESTRATION_DENIAL_REQUIRED_KEYS, pathLabel);
  const schema = ownString(input, 'schema', pathLabel);
  if (schema !== RUN_ORCHESTRATION_SCHEMA_ID && schema !== RUN_PREFLIGHT_SCHEMA_ID) {
    deny('invalid_format', pathLabel);
  }
  const version = ownDataValue(input, 'version', pathLabel);
  if (version !== RUN_ORCHESTRATION_VERSION && version !== RUN_PREFLIGHT_VERSION) {
    deny('invalid_format', pathLabel);
  }
  const code = ownString(input, 'code', pathLabel);
  if (!capturedIncludes(DENIAL_CODES, code)) deny('invalid_format', pathLabel);
  if (hasOwn(input, 'run_id')) {
    const runId = bindRunId(ownString(input, 'run_id', pathLabel), pathLabel);
    sameIdentity(runId, identity.run_id, pathLabel);
  }
  return freezeRecord(
    ['code', 'kind', 'schema', 'version'],
    {
      kind: 'denial',
      schema,
      version: RUN_ORCHESTRATION_VERSION,
      code,
    },
  );
}

function parseOrchestrationReceipt(input, identity) {
  const pathLabel = 'orchestration';
  assertClosedObject(input, ORCHESTRATION_RECEIPT_KEYS, pathLabel);
  exactKeySet(input, ORCHESTRATION_RECEIPT_KEYS, pathLabel);
  const schema = ownString(input, 'schema', pathLabel);
  if (schema !== RUN_ORCHESTRATION_SCHEMA_ID) deny('invalid_format', pathLabel);
  const version = ownDataValue(input, 'version', pathLabel);
  if (version !== RUN_ORCHESTRATION_VERSION) deny('invalid_format', pathLabel);
  const status = ownEnum(input, 'status', ORCHESTRATION_RECEIPT_STATUSES, pathLabel);
  const intent = ownEnum(input, 'intent', ORCHESTRATION_INTENTS, pathLabel);
  if (status === 'prepared' && intent !== 'prepare') deny('invalid_format', pathLabel);
  if (status === 'dispatched' && intent !== 'dispatch') deny('invalid_format', pathLabel);
  const runId = bindRunId(ownString(input, 'run_id', pathLabel), pathLabel);
  sameIdentity(runId, identity.run_id, pathLabel);
  const preflight = parsePreflight(ownDataValue(input, 'preflight', pathLabel), pathLabel, identity);
  const lanesIn = ownArray(input, 'lanes', pathLabel, MAX_API_LANES);
  if (lanesIn.length < PREFLIGHT_MIN_CHILDREN) deny('bounds_exceeded', pathLabel);
  const seen = new SET_CTOR();
  const lanes = [];
  for (let i = 0; i < lanesIn.length; i += 1) {
    lanes.push(parseLane(ownDataValue(lanesIn, STRING(i), pathLabel), pathLabel, seen));
  }
  if (lanes.length !== preflight.assignment_ids.length) deny('identity_mismatch', pathLabel);
  for (let i = 0; i < lanes.length; i += 1) {
    if (!capturedIncludes(preflight.assignment_ids, lanes[i].assignment_id)) {
      deny('identity_mismatch', pathLabel);
    }
  }
  if (status === 'dispatched') {
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i].status === 'selection_unresolved') deny('invalid_format', pathLabel);
    }
  }
  const sideEffects = parseBooleanMap(
    ownDataValue(input, 'side_effects', pathLabel),
    RUN_ORCHESTRATION_SIDE_EFFECTS,
    RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS,
    pathLabel,
  );
  parseChecks(ownDataValue(input, 'checks', pathLabel), RUN_ORCHESTRATION_CHECKS, pathLabel);
  return {
    kind: 'receipt',
    schema,
    version,
    status,
    intent,
    preflight_status: preflight.status,
    lanes: capturedFreeze(lanes),
    checks: RUN_ORCHESTRATION_CHECKS,
    side_effects: sideEffects,
    cpu_ok: preflight.cpu_ok,
    ram_ok: preflight.ram_ok,
  };
}

function parseOrchestration(input, identity) {
  if (input === undefined || input === null) deny('invalid_type', 'orchestration');
  try { assertNotProxy(input, 'orchestration'); } catch (error) { remapClosure(error, 'orchestration'); }
  if (typeof input !== 'object') deny('invalid_type', 'orchestration');
  const keys = (() => {
    try { return OWN_KEYS(input); } catch { deny('invalid_type', 'orchestration'); return []; }
  })();
  let hasCode = false;
  let hasLanes = false;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] === 'code') hasCode = true;
    if (keys[i] === 'lanes') hasLanes = true;
  }
  if (hasCode && hasLanes) deny('invalid_format', 'orchestration');
  if (hasCode) return parseOrchestrationDenial(input, identity);
  if (hasLanes) return parseOrchestrationReceipt(input, identity);
  deny('invalid_format', 'orchestration');
}

function parseUnresolvedEntry(input, pathLabel, seen) {
  assertClosedObject(input, LIFECYCLE_UNRESOLVED_KEYS, pathLabel);
  exactKeySet(input, LIFECYCLE_UNRESOLVED_KEYS, pathLabel);
  const assignmentId = bindAssignmentId(ownString(input, 'assignment_id', pathLabel), pathLabel);
  const code = ownEnum(input, 'code', LIFECYCLE_UNRESOLVED_CODES, pathLabel);
  const fingerprint = `${assignmentId}:${code}`;
  if (seen.has(fingerprint)) deny('invalid_format', pathLabel);
  seen.add(fingerprint);
  return freezeRecord(LIFECYCLE_UNRESOLVED_KEYS, { assignment_id: assignmentId, code });
}

function parseLifecycle(input) {
  if (input === undefined) return null;
  const pathLabel = 'lifecycle';
  assertClosedObject(input, LIFECYCLE_ALLOWED_KEYS, pathLabel);
  requireKeys(input, LIFECYCLE_REQUIRED_KEYS, pathLabel);
  const status = ownEnum(input, 'status', LIFECYCLE_STATUSES, pathLabel);
  const cleaned = ownBoolean(input, 'cleaned', pathLabel);
  const unresolvedIn = ownArray(input, 'unresolved', pathLabel, MAX_API_LANES);
  const seen = new SET_CTOR();
  const unresolved = [];
  for (let i = 0; i < unresolvedIn.length; i += 1) {
    unresolved.push(parseUnresolvedEntry(ownDataValue(unresolvedIn, STRING(i), pathLabel), pathLabel, seen));
  }
  const values = {
    status,
    cleaned,
    unresolved: capturedFreeze(unresolved),
  };
  if (hasOwn(input, 'missing')) values.missing = ownBoolean(input, 'missing', pathLabel);
  if (hasOwn(input, 'restarted')) values.restarted = ownBoolean(input, 'restarted', pathLabel);
  if (hasOwn(input, 'side_effects')) {
    parseBooleanMap(
      ownDataValue(input, 'side_effects', pathLabel),
      RUN_ORCHESTRATION_SIDE_EFFECTS,
      RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS,
      pathLabel,
    );
  }
  return freezeRecord(LIFECYCLE_ALLOWED_KEYS, values);
}

function auditIsNegative(audit) {
  if (audit.status === 'failed') return true;
  for (let i = 0; i < audit.findings.length; i += 1) {
    if (capturedIncludes(PROTECTED_REF_AUDIT_FAILING_CODES, audit.findings[i].code)) return true;
  }
  for (let i = 0; i < audit.observed_classes.length; i += 1) {
    if (capturedIncludes(PROTECTED_REF_AUDIT_FAILING_CODES, audit.observed_classes[i])) return true;
  }
  for (let i = 0; i < audit.fact_statuses.length; i += 1) {
    if (audit.fact_statuses[i] !== 'verified') return true;
  }
  if (audit.discrepancies.length > 0) return true;
  return false;
}

function lifecycleIsUnresolved(lifecycle) {
  if (lifecycle == null) return false;
  if (lifecycle.missing === true) return true;
  if (lifecycle.unresolved.length > 0) return true;
  if (lifecycle.restarted === true) return false;
  return lifecycle.cleaned !== true;
}

function bindLaneProvider(identity, orchestration, auditAssignmentId) {
  if (orchestration.kind !== 'receipt') {
    if (hasOwn(identity, 'assignment_id')) {
      sameIdentity(identity.assignment_id, auditAssignmentId, 'identity.assignment_id');
    }
    return;
  }
  const lanes = orchestration.lanes;
  if (hasOwn(identity, 'assignment_id')) {
    sameIdentity(identity.assignment_id, auditAssignmentId, 'identity.assignment_id');
    let found = false;
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i].assignment_id === identity.assignment_id) found = true;
    }
    if (!found) deny('identity_mismatch', 'identity.assignment_id');
  }
  if (hasOwn(identity, 'provider')) {
    let found = false;
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i].provider === identity.provider) found = true;
    }
    if (!found) deny('identity_mismatch', 'identity.provider');
  }
}

function deriveStatus(audit, orchestration, lifecycle) {
  if (auditIsNegative(audit)) return 'failed';
  if (orchestration.kind === 'denial') return 'denied';
  if (orchestration.cpu_ok !== true || orchestration.ram_ok !== true) return 'denied';
  if (lifecycleIsUnresolved(lifecycle)) return 'unresolved';
  return 'ready';
}

function projectAudit(audit) {
  return freezeRecord(
    [
      'comparisons', 'discrepancies', 'facts', 'findings', 'observed_classes',
      'observation', 'repository_kind', 'schema', 'side_effects', 'status',
      'version',
    ],
    {
      schema: audit.schema,
      version: audit.version,
      status: audit.status,
      repository_kind: audit.repository_kind,
      comparisons: audit.comparisons,
      findings: audit.findings,
      observed_classes: audit.observed_classes,
      facts: audit.facts,
      discrepancies: audit.discrepancies,
      side_effects: audit.side_effects,
      observation: audit.observation,
    },
  );
}

function projectOrchestration(orchestration) {
  if (orchestration.kind === 'denial') {
    return freezeRecord(['code', 'kind', 'schema', 'version'], {
      kind: 'denial',
      schema: orchestration.schema,
      version: orchestration.version,
      code: orchestration.code,
    });
  }
  return freezeRecord(
    ['checks', 'intent', 'kind', 'lanes', 'preflight_status', 'schema', 'side_effects', 'status', 'version'],
    {
      kind: 'receipt',
      schema: orchestration.schema,
      version: orchestration.version,
      status: orchestration.status,
      intent: orchestration.intent,
      preflight_status: orchestration.preflight_status,
      lanes: orchestration.lanes,
      checks: orchestration.checks,
      side_effects: orchestration.side_effects,
    },
  );
}

function projectLifecycle(lifecycle) {
  if (lifecycle == null) return null;
  const values = {
    status: lifecycle.status,
    cleaned: lifecycle.cleaned,
    unresolved: lifecycle.unresolved,
  };
  if (hasOwn(lifecycle, 'missing')) values.missing = lifecycle.missing;
  if (hasOwn(lifecycle, 'restarted')) values.restarted = lifecycle.restarted;
  return freezeRecord(['cleaned', 'missing', 'restarted', 'status', 'unresolved'], values);
}

function projectInvariants(lifecycle) {
  return freezeRecord(RUN_API_BOUNDARY_INVARIANT_KEYS, {
    read_only_audit: true,
    credentials_not_projected: true,
    refs_not_mutated: true,
    workspace_not_created: true,
    reservation_not_held: true,
    provider_isolated: true,
    cleanup_truthful: true,
    remote_mutated: false,
    public_api_exposed: false,
    gate_a_claimed: false,
    release_decided: false,
    supervisor_cutover: false,
  });
}

export function projectRunApiBoundaryV1(input) {
  const pathLabel = 'run_api_boundary';
  if (input === undefined || input === null) deny('invalid_type', pathLabel);
  assertClosedObject(input, INPUT_ALLOWED_KEYS, pathLabel);
  requireKeys(input, INPUT_REQUIRED_KEYS, pathLabel);
  const schema = ownString(input, 'schema', pathLabel);
  if (schema !== RUN_API_BOUNDARY_SCHEMA_ID) deny('invalid_format', pathLabel);
  const version = ownDataValue(input, 'version', pathLabel);
  if (version !== RUN_API_BOUNDARY_VERSION) deny('invalid_format', pathLabel);
  const identity = parseIdentity(ownDataValue(input, 'identity', pathLabel));
  const audit = parseAudit(ownDataValue(input, 'audit', pathLabel), identity);
  const orchestration = parseOrchestration(ownDataValue(input, 'orchestration', pathLabel), identity);
  const lifecycle = parseLifecycle(optOwn(input, 'lifecycle'));
  bindLaneProvider(identity, orchestration, audit.assignment_id);
  const status = deriveStatus(audit, orchestration, lifecycle);
  const resultValues = {
    schema: RUN_API_BOUNDARY_SCHEMA_ID,
    version: RUN_API_BOUNDARY_VERSION,
    status,
    run_id: identity.run_id,
    base_sha: identity.base_sha,
    assignment_id: hasOwn(identity, 'assignment_id') ? identity.assignment_id : audit.assignment_id,
    checks: RUN_API_BOUNDARY_CHECKS,
    audit: projectAudit(audit),
    orchestration: projectOrchestration(orchestration),
    lifecycle: projectLifecycle(lifecycle),
    invariants: projectInvariants(lifecycle),
    side_effects: emptySideEffects(),
  };
  if (hasOwn(identity, 'provider')) resultValues.provider = identity.provider;
  return freezeData(freezeRecord(RESULT_KEYS, resultValues));
}

export function describeRunApiBoundaryV1() {
  return freezeData(capturedFreeze({
    schema: RUN_API_BOUNDARY_SCHEMA_ID,
    version: RUN_API_BOUNDARY_VERSION,
    rule: 'pure_projection_of_accepted_p30_p31_receipts',
    api: capturedFreeze(['describeRunApiBoundaryV1', 'projectRunApiBoundaryV1']),
    statuses: RUN_API_BOUNDARY_STATUSES,
    checks: RUN_API_BOUNDARY_CHECKS,
    error_codes: RUN_API_BOUNDARY_ERROR_CODES,
    side_effect_nonclaims: RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS,
    max_object_keys: MAX_API_OBJECT_KEYS,
    max_key_bytes: MAX_API_KEY_BYTES,
    max_string_bytes: MAX_API_STRING_BYTES,
    max_collection: MAX_API_COLLECTION,
    max_lanes: MAX_API_LANES,
    composed_surfaces: capturedFreeze({
      protected_ref_audit: PROTECTED_REF_AUDIT_SCHEMA_ID,
      run_orchestration: RUN_ORCHESTRATION_SCHEMA_ID,
      run_preflight: RUN_PREFLIGHT_SCHEMA_ID,
      audit_checks: PROTECTED_REF_AUDIT_CHECKS,
      orchestration_checks: RUN_ORCHESTRATION_CHECKS,
      audit_lifecycle: 'not invoked; receipts are consumed as values',
      orchestration_lifecycle: 'not invoked; receipts are consumed as values',
      git: 'not invoked',
      filesystem: 'not invoked',
      process: 'not invoked',
      network: 'not invoked',
      provider: 'not invoked',
      credentials: 'not accessed',
      environment: 'not accessed',
      argv: 'not accessed',
      handoff: 'not accessed',
      workspace: 'not created',
      reservation: 'not held',
      supervisor_server: 'no cutover',
      public_mcp: 'not exposed',
      release: 'not decided',
      gate_a: 'not claimed',
      remote_mutation: 'denied',
    }),
  }));
}

capturedFreeze(projectRunApiBoundaryV1);
capturedFreeze(describeRunApiBoundaryV1);
