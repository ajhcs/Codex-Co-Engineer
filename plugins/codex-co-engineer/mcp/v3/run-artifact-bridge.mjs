// Run artifact bridge (P33; ADR 0001 identifiers `exact_identities`,
// `bounded_evidence`, `gate_a_valid_raw_and_sanitized_artifacts`,
// `gate_a_safe_per_run_cleanup`, `manual_proof_bound_cleanup`).
//
// Additive v3 facade over injected raw storage, sanitizer, evidence, and
// clock. It is the identity-and-audience authority for one run:
//   - captureAssignmentArtifacts publishes owner-only raw evidence
//   - projectAssignmentArtifacts returns bounded sanitized projections
//   - cleanupRunArtifacts removes only proof-bound artifacts of that run
//
// Raw bytes never become model-facing. Sanitized projections are size-capped
// and credential-scanned. Projection may keep or downgrade truncation and
// completeness; it never upgrades them, and missing redaction, version, or
// completeness evidence stays unknown instead of becoming a reassuring
// default. Capture readback hashes stored bytes and fails closed on
// mismatch, substitution, a partial read, or a stale identity. Cleanup
// cannot name another run, broaden a path, or delete worktrees, branches,
// locks, candidate refs, or task receipts. Restart rereads injected raw
// storage and re-projects; it does not invent captures or claim cleanup
// that the store cannot prove.
//
// This module does not import or own the P08 store, P09 sanitizer, P13
// evidence bundle, run runtime, scheduler, lifecycle, server, or candidate
// surfaces. Callers inject those seams. It does not claim Gate A or release.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { validateArtifactRelativePathV1 } from './artifact-path.mjs';
import {
  ARTIFACT_CLASSES,
  ARTIFACT_KINDS,
  ARTIFACT_REF_SCHEMA_ID,
  CONTENT_ENCODINGS,
  MAX_RAW_ARTIFACT_BYTE_LENGTH,
  MEDIA_TYPES,
  MIN_ARTIFACT_BYTE_LENGTH,
  compareArtifactRefsV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  capturedDescriptor,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  capturedUtf8ByteLength,
  sortedCapturedKeys,
} from './grammar.mjs';
import {
  ASSIGNMENT_ID_PATTERN,
  RunContractV1Error,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  hasOwn,
  optOwn,
  ownDataValue,
  freezeData,
} from './selection-json.mjs';

export const RUN_ARTIFACT_BRIDGE_SCHEMA_ID = 'codex-co-engineer.run-artifact-bridge.v1';
export const RUN_ARTIFACT_BRIDGE_VERSION = 1;
export const RUN_ARTIFACT_BRIDGE_CAPTURE_SCHEMA_ID =
  'codex-co-engineer.run-artifact-bridge-capture.v1';
export const RUN_ARTIFACT_BRIDGE_PROJECTION_SCHEMA_ID =
  'codex-co-engineer.run-artifact-bridge-projection.v1';
export const RUN_ARTIFACT_BRIDGE_CLEANUP_SCHEMA_ID =
  'codex-co-engineer.run-artifact-bridge-cleanup.v1';

export const MAX_ASSIGNMENT_ARTIFACTS = 8;
export const MAX_RUN_ARTIFACTS = 64;
export const MAX_PROJECTION_BYTES = 8_192;
export const MAX_BRIDGE_DIAGNOSTIC_BYTES = 160;
export const MAX_EVIDENCE_KIND_BYTES = 32;

export const RUN_ARTIFACT_BRIDGE_FACTORY_KEYS = capturedFreeze([
  'rawStore', 'sanitizer', 'evidenceBundle', 'clock',
]);
export const RUN_ARTIFACT_BRIDGE_METHODS = capturedFreeze([
  'captureAssignmentArtifacts',
  'projectAssignmentArtifacts',
  'cleanupRunArtifacts',
]);
export const RAW_STORE_METHODS = capturedFreeze(['publish', 'get', 'list', 'remove']);
export const SANITIZER_METHODS = capturedFreeze(['sanitize']);
export const EVIDENCE_BUNDLE_METHODS = capturedFreeze(['append', 'list']);
export const CLOCK_METHODS = capturedFreeze(['now']);

export const CAPTURE_ALLOWED_KEYS = capturedFreeze([
  'assignment_id',
  'artifact_kind',
  'content_encoding',
  'media_type',
  'relative_path',
  'run_id',
  'source',
  'source_truncated',
]);
export const CAPTURE_REQUIRED_KEYS = capturedFreeze([
  'assignment_id',
  'artifact_kind',
  'media_type',
  'relative_path',
  'run_id',
  'source',
]);
export const PROJECT_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'max_bytes', 'offset', 'run_id',
]);
export const PROJECT_REQUIRED_KEYS = capturedFreeze(['assignment_id', 'run_id']);
export const CLEANUP_ALLOWED_KEYS = capturedFreeze(['proof', 'run_id']);
export const CLEANUP_REQUIRED_KEYS = capturedFreeze(['proof', 'run_id']);
export const CLEANUP_PROOF_ALLOWED_KEYS = capturedFreeze(['assignment_ids', 'run_id']);
export const CLEANUP_PROOF_REQUIRED_KEYS = capturedFreeze(['run_id']);

export const CAPTURE_RECEIPT_KEYS = capturedFreeze([
  'assignment_id',
  'captured_at',
  'complete',
  'created',
  'raw_ref',
  'redaction_count',
  'relative_path',
  'run_id',
  'sanitized_ref',
  'sanitizer_version',
  'schema',
  'source_truncated',
  'version',
]);
export const PROJECTION_RECEIPT_KEYS = capturedFreeze([
  'artifacts',
  'assignment_id',
  'projected_at',
  'run_id',
  'schema',
  'version',
]);
export const PROJECTION_ARTIFACT_KEYS = capturedFreeze([
  'artifact_kind',
  'complete',
  'more',
  'next_offset',
  'offset',
  'reader_clipped',
  'redaction_count',
  'relative_path',
  'sanitized_byte_length',
  'sanitized_ref',
  'sanitizer_version',
  'selected',
  'selected_byte_length',
  'selected_encoding',
  'source_truncated',
]);
export const CLEANUP_RECEIPT_KEYS = capturedFreeze([
  'cleaned',
  'cleaned_at',
  'remaining',
  'removed',
  'run_id',
  'schema',
  'unresolved',
  'version',
]);
export const EVIDENCE_EVENT_KEYS = capturedFreeze([
  'artifact_digest',
  'assignment_id',
  'code',
  'kind',
  'recorded_at',
  'relative_path',
  'run_id',
]);
export const EVIDENCE_KINDS = capturedFreeze(['capture', 'cleanup', 'projection']);
export const EVIDENCE_CODES = capturedFreeze([
  'already_cleaned',
  'captured',
  'cleaned',
  'projected',
  'replayed',
]);

export const RUN_ARTIFACT_BRIDGE_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'aliased_reference_denied',
  'artifact_bridge_cleanup_unproven',
  'artifact_bridge_identity_mismatch',
  'artifact_bridge_not_found',
  'artifact_bridge_path_authority_denied',
  'artifact_bridge_projection_denied',
  'artifact_bridge_raw_denied',
  'artifact_bridge_restart_conflict',
  'artifact_bridge_run_escape_denied',
  'artifact_bridge_sanitizer_failed',
  'artifact_bridge_store_failed',
  'credential_leak_denied',
  'exotic_prototype_denied',
  'invalid_array',
  'invalid_format',
  'invalid_object',
  'invalid_type',
  'missing_key',
  'own_undefined_denied',
  'out_of_range',
  'proxy_denied',
  'symbol_key_denied',
  'unknown_artifact_kind',
  'unknown_content_encoding',
  'unknown_key',
  'unknown_media_type',
]);

const CONTENT_FREE = capturedFreeze({
  accessor_property_denied: 'The request used an accessor property; getters are never invoked.',
  aliased_reference_denied: 'The request aliased a value the bridge does not accept.',
  artifact_bridge_cleanup_unproven: 'Cleanup requires an exact identity-bound proof for this run.',
  artifact_bridge_identity_mismatch: 'The supplied identity does not bind this run and assignment.',
  artifact_bridge_not_found: 'No captured artifact exists for the exact identity.',
  artifact_bridge_path_authority_denied:
    'Artifact paths must stay under the exact run and assignment prefix.',
  artifact_bridge_projection_denied:
    'Model-facing projection accepts only bounded sanitized artifacts.',
  artifact_bridge_raw_denied: 'Raw evidence is owner-only and is not a model-facing projection.',
  artifact_bridge_restart_conflict:
    'A different artifact is already captured at this exact identity.',
  artifact_bridge_run_escape_denied:
    'Cleanup cannot name, list, or remove artifacts outside the proven run.',
  artifact_bridge_sanitizer_failed:
    'The sanitizer did not return a bound sanitized projection; nothing is exposed.',
  artifact_bridge_store_failed: 'The injected store failed closed; nothing was mutated.',
  credential_leak_denied:
    'A model-facing projection contained a credential pattern; nothing is exposed.',
  exotic_prototype_denied: 'The request used an exotic prototype; direct JSON is required.',
  invalid_array: 'The request used an array the closed vocabulary does not accept.',
  invalid_format: 'The request used a value outside the closed format vocabulary.',
  invalid_object: 'The request was not a plain data object.',
  invalid_type: 'The request used a type the closed vocabulary does not accept.',
  missing_key: 'The request omitted a required closed key.',
  own_undefined_denied: 'The request wrote undefined; omit the field instead.',
  out_of_range: 'The request exceeded a closed bound.',
  proxy_denied: 'The request was a Proxy; the bridge accepts direct data only.',
  symbol_key_denied: 'The request carried a symbol key; direct JSON is required.',
  unknown_artifact_kind: 'The artifact kind is outside the closed vocabulary.',
  unknown_content_encoding: 'The content encoding is outside the closed vocabulary.',
  unknown_key: 'The request carried a key outside the closed vocabulary.',
  unknown_media_type: 'The media type is outside the closed vocabulary.',
});

const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const SAFE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/u;
const RUN_PATH_PREFIX = 'runs/';
const HASH_ALGORITHM = 'sha256';
const SELECTED_ENCODING = 'base64';
const DEFAULT_CONTENT_ENCODING = 'identity';
const BINARY_CAPTURE_KEYS = capturedFreeze(['source']);

const CREDENTIAL_PATTERNS = capturedFreeze([
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,256}\b/u,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,256}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bcrsr_[A-Za-z0-9_-]{12,256}\b/u,
  /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{8,512}/iu,
  /(?:[a-z][a-z0-9+.-]{0,32}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/iu,
]);

const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_ALLOC = NodeBuffer.alloc.bind(NodeBuffer);
const BUFFER_IS_BUFFER = NodeBuffer.isBuffer.bind(NodeBuffer);
const CREATE_HASH = createHash;
const TIMING_SAFE_EQUAL = timingSafeEqual;
const IS_PROXY = utilTypes.isProxy;
const IS_UINT8_ARRAY = utilTypes.isUint8Array;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const STRING = String;
const OWN_ERRORS = new WeakSet();
const MATH_MIN = Math.min;
const MATH_MAX = Math.max;

function diagnostic(message) {
  const text = STRING(message ?? '');
  return text.length <= MAX_BRIDGE_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_BRIDGE_DIAGNOSTIC_BYTES);
}

function failBridge(code, field, message) {
  const text = CONTENT_FREE[code] ?? diagnostic(message);
  const error = new RunContractV1Error(code, field, text);
  OWN_ERRORS.add(error);
  throw error;
}

function rethrowOwn(error) {
  if (error instanceof RunContractV1Error && OWN_ERRORS.has(error)) throw error;
  if (error instanceof RunContractV1Error) {
    const code = capturedIncludes(RUN_ARTIFACT_BRIDGE_ERROR_CODES, error.code)
      ? error.code
      : 'invalid_type';
    failBridge(code, typeof error.path === 'string' ? error.path : 'options',
      CONTENT_FREE[code]);
  }
}

function fieldKeyLabel(path, key) {
  if (typeof key === 'symbol') return path;
  if (typeof key === 'string' && capturedTest(SAFE_KEY_PATTERN, key)
    && capturedUtf8ByteLength(key) <= 64) {
    return `${path}.${key}`;
  }
  return path;
}

function assertClosedKeySet(value, allowed, path) {
  assertPlainObject(value, 'invalid_type', path, path);
  let keys;
  try {
    keys = capturedOwnKeys(value);
  } catch {
    failBridge('invalid_object', path, CONTENT_FREE.invalid_object);
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') {
      failBridge('symbol_key_denied', path, CONTENT_FREE.symbol_key_denied);
    }
    if (!capturedIncludes(allowed, key)) {
      failBridge('unknown_key', fieldKeyLabel(path, key), CONTENT_FREE.unknown_key);
    }
  }
}

function assertRequiredKeys(value, required, path) {
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (!hasOwn(value, key)) {
      failBridge('missing_key', `${path}.${key}`, CONTENT_FREE.missing_key);
    }
  }
}

function dataViewWithout(value, excluded, path) {
  const view = {};
  const keys = sortedCapturedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (capturedIncludes(excluded, key)) continue;
    view[key] = ownDataValue(value, key, `${path}.${key}`);
  }
  assertDirectJsonClosure(view, path);
  return view;
}

function requireFunctionMap(value, field, methods) {
  assertNotProxy(value, field);
  if (value === null || typeof value !== 'object' || capturedIsArray(value)) {
    failBridge('invalid_type', field, CONTENT_FREE.invalid_type);
  }
  const bound = {};
  for (let index = 0; index < methods.length; index += 1) {
    const name = methods[index];
    if (!capturedHasOwn(value, name)) {
      failBridge('missing_key', `${field}.${name}`, CONTENT_FREE.missing_key);
    }
    const method = optOwn(value, name);
    if (typeof method !== 'function') {
      failBridge('invalid_type', `${field}.${name}`, CONTENT_FREE.invalid_type);
    }
    if (IS_PROXY(method)) {
      failBridge('proxy_denied', `${field}.${name}`, CONTENT_FREE.proxy_denied);
    }
    bound[name] = method.bind(value);
  }
  return capturedFreeze(bound);
}

function readClock(clock) {
  let stamped;
  try {
    stamped = clock.now();
  } catch (error) {
    rethrowOwn(error);
    failBridge('invalid_format', 'clock', CONTENT_FREE.invalid_format);
  }
  if (typeof stamped !== 'string' || !capturedTest(TIMESTAMP_PATTERN, stamped)) {
    failBridge('invalid_format', 'clock', CONTENT_FREE.invalid_format);
  }
  return stamped;
}

function snapshotSource(source, field) {
  assertNotProxy(source, field);
  if (typeof source === 'string') {
    return BUFFER_FROM(source, 'utf8');
  }
  if (BUFFER_IS_BUFFER(source) || IS_UINT8_ARRAY(source)) {
    return BUFFER_FROM(source);
  }
  failBridge('invalid_type', field, CONTENT_FREE.invalid_type);
}

function digestOf(bytes) {
  return CREATE_HASH(HASH_ALGORITHM).update(bytes).digest('hex');
}

function hashesEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  const leftBytes = BUFFER_FROM(left, 'utf8');
  const rightBytes = BUFFER_FROM(right, 'utf8');
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return TIMING_SAFE_EQUAL(leftBytes, rightBytes);
}

function optionalBoolean(container, key, field, code) {
  if (!hasOwn(container, key)) return null;
  const flag = optOwn(container, key);
  if (flag !== true && flag !== false) {
    failBridge(code, field, CONTENT_FREE[code]);
  }
  return flag === true;
}

function latchTruncation(authoritative, incoming) {
  if (authoritative === true || incoming === true) return true;
  if (authoritative === false) return false;
  if (incoming === false) return false;
  return null;
}

function latchComplete(truncated, incoming) {
  if (truncated === true) return false;
  if (incoming === true || incoming === false) return incoming;
  return null;
}

function copyBytes(bytes, field) {
  assertNotProxy(bytes, field);
  if (BUFFER_IS_BUFFER(bytes) || IS_UINT8_ARRAY(bytes)) {
    return BUFFER_FROM(bytes);
  }
  failBridge('artifact_bridge_sanitizer_failed', field,
    CONTENT_FREE.artifact_bridge_sanitizer_failed);
}

function pathPrefix(runId, assignmentId) {
  return `${RUN_PATH_PREFIX}${runId}/${assignmentId}/`;
}

function assertRunAssignmentPath(relativePath, runId, assignmentId, field) {
  validateArtifactRelativePathV1(relativePath, field);
  const prefix = pathPrefix(runId, assignmentId);
  if (relativePath.length <= prefix.length || relativePath.slice(0, prefix.length) !== prefix) {
    failBridge('artifact_bridge_path_authority_denied', field,
      CONTENT_FREE.artifact_bridge_path_authority_denied);
  }
}

function assertAssignmentId(value, field) {
  if (!isAssignmentId(value) || !capturedTest(ASSIGNMENT_ID_PATTERN, value)) {
    failBridge('invalid_format', field, CONTENT_FREE.invalid_format);
  }
  return value;
}

function parseCaptureInput(input) {
  assertClosedKeySet(input, CAPTURE_ALLOWED_KEYS, 'options');
  assertRequiredKeys(input, CAPTURE_REQUIRED_KEYS, 'options');
  const data = dataViewWithout(input, BINARY_CAPTURE_KEYS, 'options');
  const runId = data.run_id;
  assertRunId(runId, 'options.run_id');
  const assignmentId = assertAssignmentId(data.assignment_id, 'options.assignment_id');
  const artifactKind = data.artifact_kind;
  if (!capturedIncludes(ARTIFACT_KINDS, artifactKind)) {
    failBridge('unknown_artifact_kind', 'options.artifact_kind',
      CONTENT_FREE.unknown_artifact_kind);
  }
  const relativePath = data.relative_path;
  assertRunAssignmentPath(relativePath, runId, assignmentId, 'options.relative_path');
  const mediaType = data.media_type;
  if (!capturedIncludes(MEDIA_TYPES, mediaType)) {
    failBridge('unknown_media_type', 'options.media_type', CONTENT_FREE.unknown_media_type);
  }
  let contentEncoding = DEFAULT_CONTENT_ENCODING;
  if (hasOwn(data, 'content_encoding')) {
    contentEncoding = data.content_encoding;
    if (!capturedIncludes(CONTENT_ENCODINGS, contentEncoding)
      || contentEncoding !== DEFAULT_CONTENT_ENCODING) {
      failBridge('unknown_content_encoding', 'options.content_encoding',
        CONTENT_FREE.unknown_content_encoding);
    }
  }
  let sourceTruncated = false;
  if (hasOwn(data, 'source_truncated')) {
    const flag = data.source_truncated;
    if (flag !== true && flag !== false) {
      failBridge('invalid_type', 'options.source_truncated', CONTENT_FREE.invalid_type);
    }
    sourceTruncated = flag === true;
  }
  const sourceDescriptor = capturedDescriptor(input, 'source');
  if (!sourceDescriptor || sourceDescriptor.get !== undefined
    || sourceDescriptor.set !== undefined) {
    failBridge('accessor_property_denied', 'options.source', CONTENT_FREE.accessor_property_denied);
  }
  const bytes = snapshotSource(sourceDescriptor.value, 'options.source');
  if (bytes.byteLength < MIN_ARTIFACT_BYTE_LENGTH
    || bytes.byteLength > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
    failBridge('out_of_range', 'options.source', CONTENT_FREE.out_of_range);
  }
  return {
    runId,
    assignmentId,
    artifactKind,
    relativePath,
    mediaType,
    contentEncoding,
    sourceTruncated,
    bytes,
  };
}

function parseProjectInput(input) {
  assertClosedKeySet(input, PROJECT_ALLOWED_KEYS, 'options');
  assertRequiredKeys(input, PROJECT_REQUIRED_KEYS, 'options');
  assertDirectJsonClosure(input, 'options');
  const runId = optOwn(input, 'run_id');
  assertRunId(runId, 'options.run_id');
  const assignmentId = assertAssignmentId(optOwn(input, 'assignment_id'), 'options.assignment_id');
  let offset = 0;
  if (hasOwn(input, 'offset')) {
    offset = optOwn(input, 'offset');
    if (typeof offset !== 'number' || !NUMBER_IS_SAFE_INTEGER(offset)
      || offset < 0 || offset > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
      failBridge('out_of_range', 'options.offset', CONTENT_FREE.out_of_range);
    }
  }
  let maxBytes = MAX_PROJECTION_BYTES;
  if (hasOwn(input, 'max_bytes')) {
    maxBytes = optOwn(input, 'max_bytes');
    if (typeof maxBytes !== 'number' || !NUMBER_IS_SAFE_INTEGER(maxBytes)
      || maxBytes < 0 || maxBytes > MAX_PROJECTION_BYTES) {
      failBridge('out_of_range', 'options.max_bytes', CONTENT_FREE.out_of_range);
    }
  }
  return { runId, assignmentId, offset, maxBytes };
}

function parseAssignmentIds(value, field) {
  if (!capturedIsArray(value)) {
    failBridge('invalid_array', field, CONTENT_FREE.invalid_array);
  }
  if (value.length < 1 || value.length > MAX_ASSIGNMENT_ARTIFACTS) {
    failBridge('out_of_range', field, CONTENT_FREE.out_of_range);
  }
  const seen = new Set();
  const ids = [];
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    assertAssignmentId(id, `${field}[${index}]`);
    if (seen.has(id)) {
      failBridge('invalid_format', `${field}[${index}]`, CONTENT_FREE.invalid_format);
    }
    seen.add(id);
    ids.push(id);
  }
  ids.sort();
  return capturedFreeze(ids);
}

function parseCleanupInput(input) {
  assertClosedKeySet(input, CLEANUP_ALLOWED_KEYS, 'options');
  assertRequiredKeys(input, CLEANUP_REQUIRED_KEYS, 'options');
  const runId = optOwn(input, 'run_id');
  assertRunId(runId, 'options.run_id');
  const proof = optOwn(input, 'proof');
  assertClosedKeySet(proof, CLEANUP_PROOF_ALLOWED_KEYS, 'options.proof');
  assertRequiredKeys(proof, CLEANUP_PROOF_REQUIRED_KEYS, 'options.proof');
  assertDirectJsonClosure(proof, 'options.proof');
  const proofRunId = optOwn(proof, 'run_id');
  assertRunId(proofRunId, 'options.proof.run_id');
  if (proofRunId !== runId) {
    failBridge('artifact_bridge_cleanup_unproven', 'options.proof.run_id',
      CONTENT_FREE.artifact_bridge_cleanup_unproven);
  }
  let assignmentIds = null;
  if (hasOwn(proof, 'assignment_ids')) {
    assignmentIds = parseAssignmentIds(optOwn(proof, 'assignment_ids'),
      'options.proof.assignment_ids');
  }
  return { runId, assignmentIds };
}

function rawRefFrom(fields, bytes) {
  return parseArtifactRefV1({
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: fields.runId,
    assignment_id: fields.assignmentId,
    artifact_kind: fields.artifactKind,
    artifact_class: 'raw',
    relative_path: fields.relativePath,
    byte_length: bytes.byteLength,
    sha256: digestOf(bytes),
    media_type: fields.mediaType,
    content_encoding: fields.contentEncoding,
  }, 'artifact_ref');
}

function unwrapStoreRecord(record, field) {
  if (record === null || record === undefined) return null;
  assertNotProxy(record, field);
  if (typeof record !== 'object' || capturedIsArray(record)) {
    failBridge('artifact_bridge_store_failed', field, CONTENT_FREE.artifact_bridge_store_failed);
  }
  const refInput = hasOwn(record, 'artifact_ref') ? optOwn(record, 'artifact_ref') : record;
  let artifactRef;
  try {
    artifactRef = parseArtifactRefV1(refInput, `${field}.artifact_ref`);
  } catch (error) {
    rethrowOwn(error);
    failBridge('artifact_bridge_store_failed', field, CONTENT_FREE.artifact_bridge_store_failed);
  }
  let bytes = null;
  if (hasOwn(record, 'bytes')) {
    bytes = copyBytes(optOwn(record, 'bytes'), `${field}.bytes`);
  }
  const sourceTruncated = optionalBoolean(record, 'source_truncated',
    `${field}.source_truncated`, 'artifact_bridge_store_failed');
  return { artifact_ref: artifactRef, bytes, source_truncated: sourceTruncated };
}

async function callInjected(method, args, code, field) {
  try {
    return await method(args);
  } catch (error) {
    rethrowOwn(error);
    failBridge(code, field, CONTENT_FREE[code]);
  }
}

function assertSameIdentity(ref, runId, assignmentId, field) {
  if (ref.run_id !== runId || ref.assignment_id !== assignmentId) {
    failBridge('artifact_bridge_identity_mismatch', field,
      CONTENT_FREE.artifact_bridge_identity_mismatch);
  }
}

function assertRawClass(ref, field) {
  if (ref.artifact_class !== 'raw') {
    failBridge('artifact_bridge_raw_denied', field, CONTENT_FREE.artifact_bridge_raw_denied);
  }
}

function assertSanitizedClass(ref, field) {
  if (ref.artifact_class !== 'sanitized') {
    failBridge('artifact_bridge_projection_denied', field,
      CONTENT_FREE.artifact_bridge_projection_denied);
  }
}

function assertNoCredentialLeak(bytes, field) {
  let text;
  try {
    text = BUFFER_FROM(bytes).toString('utf8');
  } catch {
    return;
  }
  for (let index = 0; index < CREDENTIAL_PATTERNS.length; index += 1) {
    CREDENTIAL_PATTERNS[index].lastIndex = 0;
    if (CREDENTIAL_PATTERNS[index].test(text)) {
      failBridge('credential_leak_denied', field, CONTENT_FREE.credential_leak_denied);
    }
  }
}

function parseSanitizedProjection(rawRef, sanitized, field) {
  if (sanitized === null || typeof sanitized !== 'object' || capturedIsArray(sanitized)) {
    failBridge('artifact_bridge_sanitizer_failed', field,
      CONTENT_FREE.artifact_bridge_sanitizer_failed);
  }
  assertNotProxy(sanitized, field);
  if (!hasOwn(sanitized, 'sanitized_ref') || !hasOwn(sanitized, 'bytes')) {
    failBridge('artifact_bridge_sanitizer_failed', field,
      CONTENT_FREE.artifact_bridge_sanitizer_failed);
  }
  let sanitizedRef;
  try {
    sanitizedRef = parseArtifactRefV1(optOwn(sanitized, 'sanitized_ref'), `${field}.sanitized_ref`);
  } catch (error) {
    rethrowOwn(error);
    failBridge('artifact_bridge_sanitizer_failed', field,
      CONTENT_FREE.artifact_bridge_sanitizer_failed);
  }
  assertSanitizedClass(sanitizedRef, `${field}.sanitized_ref.artifact_class`);
  if (sanitizedRef.run_id !== rawRef.run_id
    || sanitizedRef.assignment_id !== rawRef.assignment_id
    || sanitizedRef.artifact_kind !== rawRef.artifact_kind
    || sanitizedRef.relative_path !== rawRef.relative_path
    || sanitizedRef.media_type !== rawRef.media_type) {
    failBridge('artifact_bridge_identity_mismatch', `${field}.sanitized_ref`,
      CONTENT_FREE.artifact_bridge_identity_mismatch);
  }
  const bytes = copyBytes(optOwn(sanitized, 'bytes'), `${field}.bytes`);
  if (bytes.byteLength !== sanitizedRef.byte_length || digestOf(bytes) !== sanitizedRef.sha256) {
    failBridge('artifact_bridge_sanitizer_failed', `${field}.bytes`,
      CONTENT_FREE.artifact_bridge_sanitizer_failed);
  }
  assertNoCredentialLeak(bytes, `${field}.bytes`);
  let redactionCount = null;
  if (hasOwn(sanitized, 'redaction_count')) {
    redactionCount = optOwn(sanitized, 'redaction_count');
    if (typeof redactionCount !== 'number' || !NUMBER_IS_SAFE_INTEGER(redactionCount)
      || redactionCount < 0 || redactionCount > 1_000_000) {
      failBridge('artifact_bridge_sanitizer_failed', `${field}.redaction_count`,
        CONTENT_FREE.artifact_bridge_sanitizer_failed);
    }
  }
  let sanitizerVersion = null;
  if (hasOwn(sanitized, 'sanitizer_version')) {
    sanitizerVersion = optOwn(sanitized, 'sanitizer_version');
    if (typeof sanitizerVersion !== 'number' || !NUMBER_IS_SAFE_INTEGER(sanitizerVersion)
      || sanitizerVersion < 1) {
      failBridge('artifact_bridge_sanitizer_failed', `${field}.sanitizer_version`,
        CONTENT_FREE.artifact_bridge_sanitizer_failed);
    }
  }
  const sourceTruncated = optionalBoolean(sanitized, 'source_truncated',
    `${field}.source_truncated`, 'artifact_bridge_sanitizer_failed');
  const complete = optionalBoolean(sanitized, 'complete', `${field}.complete`,
    'artifact_bridge_sanitizer_failed');
  return {
    sanitized_ref: sanitizedRef,
    bytes,
    redaction_count: redactionCount,
    sanitizer_version: sanitizerVersion,
    source_truncated: sourceTruncated,
    complete,
  };
}

function captureReceipt(fields, rawRef, projection, capturedAt, created) {
  return freezeData({
    schema: RUN_ARTIFACT_BRIDGE_CAPTURE_SCHEMA_ID,
    version: RUN_ARTIFACT_BRIDGE_VERSION,
    run_id: fields.runId,
    assignment_id: fields.assignmentId,
    relative_path: fields.relativePath,
    captured_at: capturedAt,
    created,
    raw_ref: rawRef,
    sanitized_ref: projection.sanitized_ref,
    redaction_count: projection.redaction_count,
    sanitizer_version: projection.sanitizer_version,
    source_truncated: fields.sourceTruncated,
    complete: fields.sourceTruncated !== true,
  });
}

function windowProjection(sanitizedBytes, offset, maxBytes) {
  const length = sanitizedBytes.byteLength;
  const start = MATH_MIN(offset, length);
  const take = MATH_MIN(maxBytes, MATH_MAX(0, length - start));
  const selected = take === 0
    ? BUFFER_ALLOC(0)
    : BUFFER_FROM(sanitizedBytes.subarray(start, start + take));
  const readerClipped = take < MATH_MIN(maxBytes, MATH_MAX(0, length - start))
    || (maxBytes < MATH_MAX(0, length - start) && take === maxBytes);
  const more = start + take < length;
  return {
    selected,
    selected_byte_length: take,
    offset: start,
    reader_clipped: readerClipped === true,
    more,
    next_offset: more ? start + take : null,
  };
}

function projectionArtifact(rawRef, projection, offset, maxBytes) {
  const window = windowProjection(projection.bytes, offset, maxBytes);
  return freezeData({
    artifact_kind: rawRef.artifact_kind,
    relative_path: rawRef.relative_path,
    sanitized_ref: projection.sanitized_ref,
    sanitized_byte_length: projection.sanitized_ref.byte_length,
    selected_encoding: SELECTED_ENCODING,
    selected: window.selected.toString(SELECTED_ENCODING),
    selected_byte_length: window.selected_byte_length,
    offset: window.offset,
    redaction_count: projection.redaction_count,
    sanitizer_version: projection.sanitizer_version,
    source_truncated: projection.source_truncated,
    complete: projection.complete,
    reader_clipped: window.reader_clipped,
    more: window.more,
    next_offset: window.next_offset,
  });
}

async function appendEvidence(evidenceBundle, event) {
  const record = freezeData({
    kind: event.kind,
    code: event.code,
    run_id: event.run_id,
    assignment_id: event.assignment_id,
    relative_path: event.relative_path,
    artifact_digest: event.artifact_digest,
    recorded_at: event.recorded_at,
  });
  await callInjected(evidenceBundle.append, record, 'artifact_bridge_store_failed',
    'evidenceBundle');
}

function listedRecords(listed, field) {
  if (listed === null || listed === undefined) return [];
  if (!capturedIsArray(listed)) {
    failBridge('artifact_bridge_store_failed', field, CONTENT_FREE.artifact_bridge_store_failed);
  }
  if (listed.length > MAX_RUN_ARTIFACTS) {
    failBridge('out_of_range', field, CONTENT_FREE.out_of_range);
  }
  const records = [];
  for (let index = 0; index < listed.length; index += 1) {
    const entry = unwrapStoreRecord(listed[index], `${field}[${index}]`);
    if (entry === null) continue;
    records.push(entry);
  }
  return records;
}

function assertListedStayInRun(records, runId, field) {
  for (let index = 0; index < records.length; index += 1) {
    const ref = records[index].artifact_ref;
    if (ref.run_id !== runId) {
      failBridge('artifact_bridge_run_escape_denied', `${field}[${index}]`,
        CONTENT_FREE.artifact_bridge_run_escape_denied);
    }
    assertRawClass(ref, `${field}[${index}].artifact_class`);
    assertRunAssignmentPath(ref.relative_path, ref.run_id, ref.assignment_id,
      `${field}[${index}].relative_path`);
  }
}

async function loadAssignmentRaw(rawStore, runId, assignmentId) {
  const listed = listedRecords(
    await callInjected(rawStore.list, { run_id: runId }, 'artifact_bridge_store_failed',
      'rawStore.list'),
    'rawStore.list',
  );
  assertListedStayInRun(listed, runId, 'rawStore.list');
  const matched = [];
  for (let index = 0; index < listed.length; index += 1) {
    const record = listed[index];
    if (record.artifact_ref.assignment_id !== assignmentId) continue;
    matched.push(record);
  }
  if (matched.length > MAX_ASSIGNMENT_ARTIFACTS) {
    failBridge('out_of_range', 'rawStore.list', CONTENT_FREE.out_of_range);
  }
  matched.sort((left, right) => compareArtifactRefsV1(left.artifact_ref, right.artifact_ref));
  return matched;
}

function bindCapturedReadback(expectedRef, record, field) {
  if (record === null || record.bytes === null) {
    failBridge('artifact_bridge_store_failed', field, CONTENT_FREE.artifact_bridge_store_failed);
  }
  const ref = record.artifact_ref;
  assertSameIdentity(ref, expectedRef.run_id, expectedRef.assignment_id, field);
  assertRawClass(ref, `${field}.artifact_class`);
  if (compareArtifactRefsV1(ref, expectedRef) !== 0) {
    failBridge('artifact_bridge_store_failed', field, CONTENT_FREE.artifact_bridge_store_failed);
  }
  const bytes = record.bytes;
  if (bytes.byteLength !== expectedRef.byte_length) {
    failBridge('artifact_bridge_store_failed', field, CONTENT_FREE.artifact_bridge_store_failed);
  }
  const byteHash = digestOf(bytes);
  if (!hashesEqual(byteHash, expectedRef.sha256) || !hashesEqual(ref.sha256, byteHash)) {
    failBridge('artifact_bridge_store_failed', field, CONTENT_FREE.artifact_bridge_store_failed);
  }
  return {
    artifact_ref: ref,
    bytes: BUFFER_FROM(bytes),
    byte_hash: byteHash,
    source_truncated: record.source_truncated,
  };
}

async function materializeRaw(rawStore, record, runId, assignmentId) {
  const ref = record.artifact_ref;
  assertSameIdentity(ref, runId, assignmentId, 'artifact_ref');
  assertRawClass(ref, 'artifact_ref.artifact_class');
  if (record.bytes !== null) {
    return bindCapturedReadback(ref, record, 'rawStore.list');
  }
  const fetched = unwrapStoreRecord(
    await callInjected(rawStore.get, {
      run_id: runId,
      assignment_id: assignmentId,
      relative_path: ref.relative_path,
    }, 'artifact_bridge_store_failed', 'rawStore.get'),
    'rawStore.get',
  );
  if (fetched === null || fetched.bytes === null) {
    failBridge('artifact_bridge_not_found', 'rawStore.get',
      CONTENT_FREE.artifact_bridge_not_found);
  }
  return bindCapturedReadback(ref, fetched, 'rawStore.get');
}

async function projectOne(sanitizer, rawRecord, sourceTruncated) {
  const request = {
    artifact_ref: rawRecord.artifact_ref,
    source: BUFFER_FROM(rawRecord.bytes),
  };
  if (sourceTruncated === true || sourceTruncated === false) {
    request.source_truncated = sourceTruncated;
  }
  const sanitized = await callInjected(sanitizer.sanitize, request,
    'artifact_bridge_sanitizer_failed', 'sanitizer');
  const projection = parseSanitizedProjection(rawRecord.artifact_ref, sanitized, 'sanitizer');
  const truncated = latchTruncation(sourceTruncated, projection.source_truncated);
  return {
    sanitized_ref: projection.sanitized_ref,
    bytes: projection.bytes,
    redaction_count: projection.redaction_count,
    sanitizer_version: projection.sanitizer_version,
    source_truncated: truncated,
    complete: latchComplete(truncated, projection.complete),
  };
}

export function describeRunArtifactBridgeV1() {
  return freezeData({
    schema: RUN_ARTIFACT_BRIDGE_SCHEMA_ID,
    version: RUN_ARTIFACT_BRIDGE_VERSION,
    methods: [...RUN_ARTIFACT_BRIDGE_METHODS],
    factory_keys: [...RUN_ARTIFACT_BRIDGE_FACTORY_KEYS],
    artifact_classes: [...ARTIFACT_CLASSES],
    artifact_kinds: [...ARTIFACT_KINDS],
    max_assignment_artifacts: MAX_ASSIGNMENT_ARTIFACTS,
    max_projection_bytes: MAX_PROJECTION_BYTES,
    raw_owner_only: true,
    model_facing_sanitized_only: true,
    proof_bound_cleanup: true,
    automatic_gc: false,
    remote_mutated: false,
    imports_runtime: false,
    imports_scheduler: false,
    imports_lifecycle: false,
    imports_server: false,
    imports_candidate: false,
  });
}

export function createRunArtifactBridge(options) {
  assertPlainObject(options, 'invalid_type', 'options', 'The artifact bridge options');
  assertClosedKeySet(options, RUN_ARTIFACT_BRIDGE_FACTORY_KEYS, 'options');
  assertRequiredKeys(options, RUN_ARTIFACT_BRIDGE_FACTORY_KEYS, 'options');
  const rawStore = requireFunctionMap(optOwn(options, 'rawStore'), 'options.rawStore',
    RAW_STORE_METHODS);
  const sanitizer = requireFunctionMap(optOwn(options, 'sanitizer'), 'options.sanitizer',
    SANITIZER_METHODS);
  const evidenceBundle = requireFunctionMap(optOwn(options, 'evidenceBundle'),
    'options.evidenceBundle', EVIDENCE_BUNDLE_METHODS);
  const clock = requireFunctionMap(optOwn(options, 'clock'), 'options.clock', CLOCK_METHODS);

  async function captureAssignmentArtifacts(input) {
    const fields = parseCaptureInput(input);
    const now = readClock(clock);
    const rawRef = rawRefFrom(fields, fields.bytes);
    const existing = unwrapStoreRecord(
      await callInjected(rawStore.get, {
        run_id: fields.runId,
        assignment_id: fields.assignmentId,
        relative_path: fields.relativePath,
      }, 'artifact_bridge_store_failed', 'rawStore.get'),
      'rawStore.get',
    );
    if (existing !== null) {
      assertSameIdentity(existing.artifact_ref, fields.runId, fields.assignmentId, 'rawStore.get');
      assertRawClass(existing.artifact_ref, 'rawStore.get.artifact_class');
      if (existing.artifact_ref.sha256 !== rawRef.sha256
        || existing.artifact_ref.byte_length !== rawRef.byte_length
        || existing.artifact_ref.artifact_kind !== rawRef.artifact_kind
        || existing.artifact_ref.media_type !== rawRef.media_type) {
        failBridge('artifact_bridge_restart_conflict', 'options.source',
          CONTENT_FREE.artifact_bridge_restart_conflict);
      }
      const bound = bindCapturedReadback(existing.artifact_ref, existing, 'rawStore.get');
      if (!hashesEqual(bound.byte_hash, rawRef.sha256)) {
        failBridge('artifact_bridge_restart_conflict', 'options.source',
          CONTENT_FREE.artifact_bridge_restart_conflict);
      }
      const latchedTruncated = latchTruncation(bound.source_truncated, fields.sourceTruncated);
      const projection = await projectOne(sanitizer, bound, latchedTruncated);
      await appendEvidence(evidenceBundle, {
        kind: 'capture',
        code: 'replayed',
        run_id: fields.runId,
        assignment_id: fields.assignmentId,
        relative_path: fields.relativePath,
        artifact_digest: rawRef.sha256,
        recorded_at: now,
      });
      return captureReceipt({
        ...fields,
        sourceTruncated: latchedTruncated === true,
      }, existing.artifact_ref, projection, now, false);
    }

    const siblings = await loadAssignmentRaw(rawStore, fields.runId, fields.assignmentId);
    if (siblings.length >= MAX_ASSIGNMENT_ARTIFACTS) {
      failBridge('out_of_range', 'options.relative_path', CONTENT_FREE.out_of_range);
    }

    await callInjected(rawStore.publish, {
      artifact_ref: rawRef,
      bytes: BUFFER_FROM(fields.bytes),
      source_truncated: fields.sourceTruncated === true,
    }, 'artifact_bridge_store_failed', 'rawStore.publish');

    const verified = unwrapStoreRecord(
      await callInjected(rawStore.get, {
        run_id: fields.runId,
        assignment_id: fields.assignmentId,
        relative_path: fields.relativePath,
      }, 'artifact_bridge_store_failed', 'rawStore.get'),
      'rawStore.get',
    );
    const bound = bindCapturedReadback(rawRef, verified, 'rawStore.get');
    const latchedTruncated = latchTruncation(bound.source_truncated, fields.sourceTruncated);
    const projection = await projectOne(sanitizer, bound, latchedTruncated);
    await appendEvidence(evidenceBundle, {
      kind: 'capture',
      code: 'captured',
      run_id: fields.runId,
      assignment_id: fields.assignmentId,
      relative_path: fields.relativePath,
      artifact_digest: rawRef.sha256,
      recorded_at: now,
    });
    return captureReceipt({
      ...fields,
      sourceTruncated: latchedTruncated === true,
    }, bound.artifact_ref, projection, now, true);
  }

  async function projectAssignmentArtifacts(input) {
    const fields = parseProjectInput(input);
    const now = readClock(clock);
    const listed = await loadAssignmentRaw(rawStore, fields.runId, fields.assignmentId);
    const artifacts = [];
    for (let index = 0; index < listed.length; index += 1) {
      const rawRecord = await materializeRaw(rawStore, listed[index], fields.runId,
        fields.assignmentId);
      const projection = await projectOne(sanitizer, rawRecord, rawRecord.source_truncated);
      artifacts.push(projectionArtifact(rawRecord.artifact_ref, projection, fields.offset,
        fields.maxBytes));
    }
    await appendEvidence(evidenceBundle, {
      kind: 'projection',
      code: 'projected',
      run_id: fields.runId,
      assignment_id: fields.assignmentId,
      relative_path: null,
      artifact_digest: null,
      recorded_at: now,
    });
    return freezeData({
      schema: RUN_ARTIFACT_BRIDGE_PROJECTION_SCHEMA_ID,
      version: RUN_ARTIFACT_BRIDGE_VERSION,
      run_id: fields.runId,
      assignment_id: fields.assignmentId,
      projected_at: now,
      artifacts,
    });
  }

  async function cleanupRunArtifacts(input) {
    const fields = parseCleanupInput(input);
    const now = readClock(clock);
    const listed = listedRecords(
      await callInjected(rawStore.list, { run_id: fields.runId },
        'artifact_bridge_store_failed', 'rawStore.list'),
      'rawStore.list',
    );
    assertListedStayInRun(listed, fields.runId, 'rawStore.list');

    const targeted = [];
    const allowedAssignments = fields.assignmentIds === null
      ? null
      : new Set(fields.assignmentIds);
    for (let index = 0; index < listed.length; index += 1) {
      const record = listed[index];
      if (allowedAssignments !== null
        && !allowedAssignments.has(record.artifact_ref.assignment_id)) {
        continue;
      }
      targeted.push(record);
    }

    let removed = 0;
    for (let index = 0; index < targeted.length; index += 1) {
      const ref = targeted[index].artifact_ref;
      if (ref.run_id !== fields.runId) {
        failBridge('artifact_bridge_run_escape_denied', 'rawStore.remove',
          CONTENT_FREE.artifact_bridge_run_escape_denied);
      }
      await callInjected(rawStore.remove, {
        run_id: ref.run_id,
        assignment_id: ref.assignment_id,
        relative_path: ref.relative_path,
        sha256: ref.sha256,
      }, 'artifact_bridge_store_failed', 'rawStore.remove');
      removed += 1;
    }

    const remainingListed = listedRecords(
      await callInjected(rawStore.list, { run_id: fields.runId },
        'artifact_bridge_store_failed', 'rawStore.list'),
      'rawStore.list',
    );
    assertListedStayInRun(remainingListed, fields.runId, 'rawStore.list');
    let remainingTargeted = 0;
    for (let index = 0; index < remainingListed.length; index += 1) {
      const ref = remainingListed[index].artifact_ref;
      if (allowedAssignments !== null && !allowedAssignments.has(ref.assignment_id)) continue;
      remainingTargeted += 1;
    }
    const cleaned = remainingTargeted === 0;
    const code = removed === 0 ? 'already_cleaned' : 'cleaned';
    await appendEvidence(evidenceBundle, {
      kind: 'cleanup',
      code,
      run_id: fields.runId,
      assignment_id: fields.assignmentIds && fields.assignmentIds.length === 1
        ? fields.assignmentIds[0]
        : null,
      relative_path: null,
      artifact_digest: null,
      recorded_at: now,
    });
    return freezeData({
      schema: RUN_ARTIFACT_BRIDGE_CLEANUP_SCHEMA_ID,
      version: RUN_ARTIFACT_BRIDGE_VERSION,
      run_id: fields.runId,
      cleaned_at: now,
      cleaned,
      removed,
      remaining: remainingListed.length,
      unresolved: [],
    });
  }

  return capturedFreeze({
    captureAssignmentArtifacts: capturedFreeze(captureAssignmentArtifacts),
    projectAssignmentArtifacts: capturedFreeze(projectAssignmentArtifacts),
    cleanupRunArtifacts: capturedFreeze(cleanupRunArtifacts),
  });
}

capturedFreeze(createRunArtifactBridge);
capturedFreeze(describeRunArtifactBridgeV1);
capturedFreeze(RUN_ARTIFACT_BRIDGE_ERROR_CODES);
capturedFreeze(RUN_ARTIFACT_BRIDGE_METHODS);
