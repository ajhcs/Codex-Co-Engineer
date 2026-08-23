// Cursor Cloud result source (P12; ADR 0001 identifiers
// `bounded_evidence`, `exact_identities`,
// `sanitized_bounded_evidence_model_facing`,
// Gate A `gate_a_valid_raw_and_sanitized_artifacts`,
// `codex_only_final_acceptance`).
//
// Additive v3 module. It materializes Cursor Cloud provider-reported
// result/output/status and independently observed Git/branch/commit/PR
// evidence as distinct typed sources. It does not sanitize, store, or
// range-read on its own: P09 `sanitizeAndPublishArtifactV1` and P08
// `verifyStoredArtifactV1` remain the publication/verify authorities,
// and P10 `readSanitizedArtifactV1` is the only model-facing tail reader.
//
// Contract:
//   - Provider-reported bytes and independently observed Git facts stay
//     distinct. Trusted Git identity is never synthesized from provider
//     text, JSON output, or status strings.
//   - Exact run/assignment/request/repository/branch/head/base identity
//     is bound into ArtifactRefV1 paths and the detached receipt.
//     Mismatch fails closed with no replay or fallback.
//   - Complete transport-available source bytes are stored up to the
//     existing raw class cap. Receipts expose only bounded sanitized
//     tails, refs, digests, and provenance. Upstream/provider
//     truncation is caller-declared and is never inferred from inline
//     clipping or storage limits.
//   - Empty sources are not published and do not invent an artifact.
//   - Crossing a class cap fails closed rather than clipping toward the cap.
//   - Publication that does not verify is not reported.
//
// Provider completion remains evidence, never acceptance. This module
// does not dispatch Cloud runs, mutate Git, create PRs, or talk to
// supervisor, server, scheduler, or the P21 driver.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  validateArtifactRelativePathV1,
} from './artifact-path.mjs';
import {
  ARTIFACT_REF_SCHEMA_ID,
  MAX_RAW_ARTIFACT_BYTE_LENGTH,
  MIN_ARTIFACT_BYTE_LENGTH,
  artifactRefDigestV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  readSanitizedArtifactV1,
} from './artifact-reader.mjs';
import {
  ARTIFACT_SANITIZER_SCHEMA_ID,
  SANITIZER_CONTENT_ENCODING,
  SANITIZER_MEDIA_TYPES,
  sanitizeAndPublishArtifactV1,
} from './artifact-sanitizer.mjs';
import {
  openArtifactStoreV1,
  verifyStoredArtifactV1,
} from './artifact-store.mjs';
import {
  capturedFreeze,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  isKnownProvider,
  isModelId,
  sortedCapturedKeys,
} from './grammar.mjs';
import { DIGEST_HEX_LENGTH } from './identity.mjs';
import {
  RunContractV1Error,
  SHA40_PATTERN,
  assertRunId,
  isAssignmentId,
  isSha40,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  ownDescriptor,
  ownDataValue,
} from './selection-json.mjs';

export const CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID =
  'codex-co-engineer.cursor-cloud-result-source.v1';
export const CURSOR_CLOUD_RESULT_SOURCE_VERSION = 1;
export const CURSOR_CLOUD_RESULT_SOURCE_PROVIDER = 'cursor-cloud';
export const CURSOR_CLOUD_PROVIDER_REPORT_ARTIFACT_KIND = 'provider_report';
export const CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND = 'git_diff';
export const CURSOR_CLOUD_RESULT_STORE_DIR = 'artifacts';
export const CURSOR_CLOUD_RESULT_SOURCE_INLINE_TAIL_MAX_BYTES = 4_096;

export const CURSOR_CLOUD_RESULT_SOURCE_OPTION_KEYS = capturedFreeze([
  'run_id',
  'assignment_id',
  'provider',
  'model',
  'child_envelope_digest',
  'request_id',
  'agent_id',
  'provider_run_id',
  'repository_identity',
  'repository_url',
  'branch',
  'starting_sha',
  'head_sha',
  'observed',
  'provider_report',
  'git_evidence',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_OBSERVED_KEYS = capturedFreeze([
  'provider_run_id',
  'request_id',
  'agent_id',
  'run_id',
  'assignment_id',
]);

export const CURSOR_CLOUD_PROVIDER_REPORT_INPUT_KEYS = capturedFreeze([
  'status',
  'output',
  'error',
  'source_truncated',
]);

export const CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS = capturedFreeze([
  'repository_identity',
  'repository_url',
  'branch',
  'head_sha',
  'merge_base_sha',
  'starting_sha',
  'linear_history',
  'pr_url',
  'source_truncated',
]);

export const CURSOR_CLOUD_SDK_GIT_KEYS = capturedFreeze(['branches']);
export const CURSOR_CLOUD_SDK_BRANCH_KEYS = capturedFreeze([
  'repoUrl', 'branch', 'prUrl',
]);
const CURSOR_CLOUD_GIT_PROJECTOR_KEYS = capturedFreeze([
  ...CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS,
  ...CURSOR_CLOUD_SDK_GIT_KEYS,
]);

export const CURSOR_CLOUD_SDK_PROVIDER_REPORT_KEYS = capturedFreeze([
  'status',
  'result',
  'output',
  'error',
  'truncated',
  'source_truncated',
]);

export const CURSOR_CLOUD_SDK_RESULT_KEYS = capturedFreeze([
  'id',
  'requestId',
  'agentId',
  'git',
  ...CURSOR_CLOUD_SDK_PROVIDER_REPORT_KEYS,
]);

export const CURSOR_CLOUD_RESULT_CORRELATION_KEYS = capturedFreeze([
  'recorded',
  'observed',
  'git_evidence',
]);

const CURSOR_CLOUD_TASK_IDENTITY_KEYS = capturedFreeze([
  'run_id',
  'assignment_id',
  'provider',
  'model',
  'child_envelope_digest',
  'run_idempotency_key',
  'provider_agent_id',
  'provider_run_id',
  'provider_repo_url',
  'provider_repo_identity',
  'provider_branch',
  'starting_ref',
  'head_sha',
]);

const CURSOR_CLOUD_RECORDED_IDENTITY_KEYS = capturedFreeze([
  'run_id',
  'assignment_id',
  'request_id',
  'provider_run_id',
  'agent_id',
  'branch',
  'repository_identity',
  'repository_url',
  'starting_sha',
  'head_sha',
]);

export const CURSOR_CLOUD_PROVIDER_REPORT_STATUSES = capturedFreeze([
  'finished', 'completed', 'failed', 'cancelled', 'error',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_RECEIPT_KEYS = capturedFreeze([
  'schema',
  'version',
  'published',
  'run_id',
  'assignment_id',
  'provider',
  'model',
  'child_envelope_digest',
  'request_id',
  'agent_id',
  'provider_run_id',
  'provider_report',
  'git_evidence',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_SLOT_KEYS = capturedFreeze([
  'source_kind',
  'artifact_kind',
  'published',
  'empty',
  'relative_path',
  'media_type',
  'raw_ref',
  'sanitized_ref',
  'raw_digest',
  'sanitized_digest',
  'ref_digest_raw',
  'ref_digest_sanitized',
  'source_byte_length',
  'sanitized_byte_length',
  'redaction_counts',
  'sanitizer_version',
  'policy_id',
  'complete',
  'source_truncated',
  'inline_clipped',
  'storage_limited',
  'provenance',
  'inline_tail',
  'status',
  'repository_identity',
  'repository_url',
  'branch',
  'head_sha',
  'merge_base_sha',
  'starting_sha',
  'linear_history',
  'pr_url',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_INLINE_TAIL_KEYS = capturedFreeze([
  'encoding',
  'text',
  'byte_length',
  'offset',
  'max_bytes',
  'inline_clipped',
  'source_truncated',
  'complete',
  'reader_clipped',
  'more',
  'next_offset',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_FAILURE_KEYS = capturedFreeze([
  'schema',
  'version',
  'published',
  'error',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_ERROR_CODES = capturedFreeze([
  'agent_identity_mismatch',
  'artifact_sink_failed',
  'artifact_sink_not_published',
  'artifact_sink_not_verified',
  'artifact_stream_invalid_chunk',
  'artifact_stream_invalid_source',
  'artifact_stream_over_cap',
  'assignment_identity_mismatch',
  'base_identity_mismatch',
  'branch_identity_mismatch',
  'cursor_cloud_provider_required',
  'head_identity_mismatch',
  'invalid_format',
  'invalid_type',
  'malformed_result',
  'missing_key',
  'provider_run_identity_mismatch',
  'proxy_denied',
  'repository_identity_mismatch',
  'request_identity_mismatch',
  'run_identity_mismatch',
  'source_confusion_denied',
  'unknown_key',
  'unknown_provider',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_IDENTITY_MISMATCH_CODES = capturedFreeze([
  'agent_identity_mismatch',
  'assignment_identity_mismatch',
  'base_identity_mismatch',
  'branch_identity_mismatch',
  'head_identity_mismatch',
  'provider_run_identity_mismatch',
  'repository_identity_mismatch',
  'request_identity_mismatch',
  'run_identity_mismatch',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_FAILURE_MESSAGE =
  'The Cursor Cloud result source did not materialize after provider terminal.';

export const CURSOR_CLOUD_RESULT_SOURCE_FAILURE_CODE_ALLOWLIST = capturedFreeze([
  ...CURSOR_CLOUD_RESULT_SOURCE_ERROR_CODES,
  'accessor_property_denied',
  'artifact_content_conflict',
  'artifact_digest_mismatch',
  'artifact_length_mismatch',
  'artifact_metadata_conflict',
  'artifact_stream_failed',
  'non_enumerable_property_denied',
  'own_undefined_denied',
  'sanitizer_content_encoding_denied',
  'sanitizer_empty_output',
  'sanitizer_media_type_denied',
]);

export const CURSOR_CLOUD_RESULT_SOURCE_FAILURE_PATH_ALLOWLIST = capturedFreeze([
  'artifact_ref',
  'git_evidence',
  'inline_tail',
  'observed',
  'options.agent_id',
  'options.assignment_id',
  'options.branch',
  'options.child_envelope_digest',
  'options.head_sha',
  'options.model',
  'options.provider',
  'options.provider_run_id',
  'options.repository_identity',
  'options.repository_url',
  'options.request_id',
  'options.run_id',
  'options.starting_sha',
  'provider_report',
  'provider_report.error',
  'provider_report.output',
  'provider_report.source_truncated',
  'provenance',
  'recorded',
  'result',
  'task',
  'correlation',
  'relative_path',
  'root',
  'source',
]);

const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const REPO_IDENTITY_PATTERN = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/u;
const REPO_URL_PATTERN = /^https:\/\/[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/u;
const PR_URL_PATTERN = /^https:\/\/[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/u;
const DENSE_ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/u;

const INTRINSIC_VIEW_SURFACE_KEYS = capturedFreeze([
  'buffer',
  'byteOffset',
  'byteLength',
  'subarray',
]);

const CREATE_HASH = createHash;
const TIMING_SAFE_EQUAL = cryptoTimingSafeEqual;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const BUFFER_ALLOC = NodeBuffer.alloc.bind(NodeBuffer);
const JSON_STRINGIFY = JSON.stringify;
const JSON_PARSE = JSON.parse;
const STRING = String;
const PATH_JOIN = path.join;
const PATH_RESOLVE = path.resolve;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const MKDIR = mkdir;
const CHMOD = chmod;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const REFLECT_HAS = Reflect.has;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const IS_PROXY = utilTypes.isProxy;
const IS_ARRAY_BUFFER = utilTypes.isArrayBuffer;
const IS_SHARED_ARRAY_BUFFER = utilTypes.isSharedArrayBuffer;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;

const ARRAY_PROTOTYPE = Array.prototype;
const UINT8ARRAY_PROTOTYPE = Uint8Array.prototype;
const BUFFER_PROTOTYPE = NodeBuffer.prototype;
const OBJECT_PROTOTYPE = Object.prototype;
const ASYNC_GENERATOR_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  Object.getPrototypeOf((async function* () {}).prototype),
);
const SYMBOL_ASYNC_ITERATOR = Symbol.asyncIterator;

function diagnostic(message) {
  const text = STRING(message ?? '');
  return text.length <= 200 ? text : text.slice(0, 200);
}

function failSource(code, field, message) {
  fail(code, field, diagnostic(message));
}

function hasOwnIntrinsicViewSurfaceOverride(value) {
  try {
    for (let index = 0; index < INTRINSIC_VIEW_SURFACE_KEYS.length; index += 1) {
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
        value,
        INTRINSIC_VIEW_SURFACE_KEYS[index],
      );
      if (descriptor !== undefined) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isIntrinsicBinaryView(value) {
  if (value === null || typeof value !== 'object') return false;
  if (IS_PROXY(value)) return false;
  const proto = OBJECT_GET_PROTOTYPE_OF(value);
  if (proto !== UINT8ARRAY_PROTOTYPE && proto !== BUFFER_PROTOTYPE) return false;
  if (!ARRAY_BUFFER_IS_VIEW(value)) return false;
  if (hasOwnIntrinsicViewSurfaceOverride(value)) return false;
  const backing = value.buffer;
  if (!IS_ARRAY_BUFFER(backing) || IS_SHARED_ARRAY_BUFFER(backing)) return false;
  return true;
}

function snapshotView(view) {
  const copy = BUFFER_ALLOC(view.byteLength);
  copy.set(view);
  return copy;
}

function isAcceptableAsyncIterable(source) {
  let proto = OBJECT_GET_PROTOTYPE_OF(source);
  for (let depth = 0; depth < 4 && proto !== null; depth += 1) {
    if (IS_PROXY(proto)) return false;
    if (proto === ASYNC_GENERATOR_PROTOTYPE) return true;
    if (proto === OBJECT_PROTOTYPE) break;
    proto = OBJECT_GET_PROTOTYPE_OF(proto);
  }
  if (proto !== null && proto !== OBJECT_PROTOTYPE) return false;
  if (!REFLECT_HAS(source, SYMBOL_ASYNC_ITERATOR)) return false;
  const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(source, SYMBOL_ASYNC_ITERATOR);
  if (descriptor === undefined || descriptor.get !== undefined) return false;
  return typeof descriptor.value === 'function';
}

function digestOf(bytes) {
  return CREATE_HASH('sha256').update(bytes).digest('hex');
}

function mediaExtension(mediaType) {
  if (mediaType === 'application/json') return 'json';
  if (mediaType === 'application/x-ndjson') return 'ndjson';
  if (mediaType === 'text/markdown') return 'md';
  return 'txt';
}

function uint32be(length) {
  const header = BUFFER_ALLOC(4);
  header[0] = (length >>> 24) & 0xff;
  header[1] = (length >>> 16) & 0xff;
  header[2] = (length >>> 8) & 0xff;
  header[3] = length & 0xff;
  return header;
}

function encodePart(value) {
  return BUFFER_FROM(value ?? '', 'utf8');
}

function identityNamespaceDigest(identity) {
  const parts = [
    identity.provider,
    identity.model,
    identity.child_envelope_digest ?? '',
    identity.request_id ?? '',
    identity.provider_run_id ?? '',
  ];
  const hash = CREATE_HASH('sha256');
  for (let index = 0; index < parts.length; index += 1) {
    const encoded = encodePart(parts[index]);
    hash.update(uint32be(encoded.byteLength)).update(encoded);
  }
  return hash.digest('hex');
}

function artifactRelativePath(identity, fileName) {
  const binding = identityNamespaceDigest(identity);
  const relativePath =
    `runs/${identity.run_id}/${identity.assignment_id}/${identity.provider}/${binding}/${fileName}`;
  validateArtifactRelativePathV1(relativePath, 'relative_path');
  return relativePath;
}

export function cursorCloudProviderReportPathV1(identity, mediaType = 'text/plain') {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    failSource('invalid_type', 'identity',
      'A provider-report path requires a bounded identity object.');
  }
  return artifactRelativePath(identity, `provider-report.${mediaExtension(mediaType)}`);
}

export function cursorCloudGitEvidencePathV1(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    failSource('invalid_type', 'identity',
      'A Git-evidence path requires a bounded identity object.');
  }
  return artifactRelativePath(identity, 'git-evidence.json');
}

function exactBytesEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = BUFFER_FROM(left, 'utf8');
  const b = BUFFER_FROM(right, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return TIMING_SAFE_EQUAL(a, b);
}

function assertExactIdentity(recorded, observed, code, field, label) {
  if (recorded == null || observed == null) return;
  if (!exactBytesEqual(recorded, observed)) {
    failSource(code, field, `Cursor Cloud ${label} identity did not match the recorded identity.`);
  }
}

function assertTokenId(value, field, label) {
  if (typeof value !== 'string' || !capturedTest(TOKEN_ID_PATTERN, value)) {
    failSource('invalid_format', field,
      `${label} must be an exact bounded Cursor Cloud identity token.`);
  }
  return value;
}

function assertOptionalToken(input, key, field, label) {
  if (!hasOwn(input, key)) return null;
  return assertTokenId(ownDataValue(input, key, field), field, label);
}

function assertBranch(value, field) {
  if (typeof value !== 'string' || !capturedTest(BRANCH_PATTERN, value)) {
    failSource('invalid_format', field,
      'branch must be an exact independently observed Git branch identity.');
  }
  return value;
}

function assertCommit(value, field) {
  if (typeof value !== 'string' || !isSha40(value) || !capturedTest(SHA40_PATTERN, value)) {
    failSource('invalid_format', field,
      `${field} must be an exact lowercase 40-hex commit SHA.`);
  }
  return value;
}

function assertRepoIdentity(value, field) {
  if (typeof value !== 'string' || !capturedTest(REPO_IDENTITY_PATTERN, value)) {
    failSource('invalid_format', field,
      'repository_identity must be a credential-free host/path identity.');
  }
  return value;
}

function assertRepoUrl(value, field) {
  if (typeof value !== 'string' || !capturedTest(REPO_URL_PATTERN, value)) {
    failSource('invalid_format', field,
      'repository_url must be a credential-free https repository URL.');
  }
  return value;
}

function assertPrUrl(value, field) {
  if (typeof value !== 'string' || !capturedTest(PR_URL_PATTERN, value)) {
    failSource('invalid_format', field,
      'pr_url must be a credential-free https pull-request URL.');
  }
  return value;
}

function parseBooleanFlag(input, key, field) {
  if (!hasOwn(input, key)) return false;
  const flagged = ownDataValue(input, key, field);
  if (flagged !== true && flagged !== false) {
    failSource('invalid_type', field,
      `${field} must be an exact boolean when present.`);
  }
  return flagged === true;
}

function inspectOwnKeys(input, field) {
  try {
    return capturedOwnKeys(input);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSource('proxy_denied', field,
      `${field} keys could not be inspected safely.`);
  }
}

function isDenseArrayIndexKey(key, length) {
  if (typeof key !== 'string' || !capturedTest(DENSE_ARRAY_INDEX_PATTERN, key)) return false;
  const index = Number(key);
  return NUMBER_IS_SAFE_INTEGER(index) && index >= 0 && index < length && STRING(index) === key;
}

function assertConcreteDenseDirectDataArray(value, field) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    assertNotProxy(value, field);
  }
  let isArray = false;
  try {
    isArray = capturedIsArray(value);
  } catch {
    failSource('malformed_result', field,
      'Independently observed Git branches must be a dense array.');
  }
  if (value === null || typeof value !== 'object' || isArray !== true) {
    failSource('malformed_result', field,
      'Independently observed Git branches must be a dense array.');
  }
  let prototype;
  try {
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    failSource('malformed_result', field,
      'Independently observed Git branches must be a dense array.');
  }
  if (prototype !== ARRAY_PROTOTYPE && prototype !== null) {
    failSource('malformed_result', field,
      'Independently observed Git branches must be a dense array.');
  }
  const lengthDescriptor = ownDescriptor(value, 'length');
  if (lengthDescriptor === undefined
    || lengthDescriptor.enumerable
    || lengthDescriptor.get !== undefined
    || lengthDescriptor.set !== undefined
    || typeof lengthDescriptor.value !== 'number'
    || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 0) {
    failSource('malformed_result', field,
      'Independently observed Git branches must be a dense array.');
  }
  const length = lengthDescriptor.value;
  const ownKeys = inspectOwnKeys(value, field);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key === 'symbol') {
      failSource('unknown_key', `${field}[symbol]`,
        'Independently observed Git branches carry a symbol key outside the closed result-source vocabulary.');
    }
    if (key === 'length') continue;
    const descriptor = ownDescriptor(value, key);
    if (!isDenseArrayIndexKey(key, length)) {
      if (descriptor !== undefined && !descriptor.enumerable) {
        failSource('non_enumerable_property_denied', field,
          'Independently observed Git branches carry non-enumerable properties beyond dense indices.');
      }
      failSource('unknown_key', field,
        'Independently observed Git branches carry named properties beyond dense indices.');
    }
    const memberPath = `${field}[${key}]`;
    if (descriptor === undefined || !descriptor.enumerable) {
      failSource('non_enumerable_property_denied', memberPath,
        `${memberPath} could not be described as an own enumerable data property.`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      failSource('accessor_property_denied', memberPath,
        `${memberPath} is an accessor property; result-source data must be direct JSON values and getters are never invoked.`);
    }
    if (descriptor.value === undefined) {
      failSource('own_undefined_denied', memberPath,
        `${memberPath} is an own undefined value; omit the element instead of writing undefined.`);
    }
    if (descriptor.value !== null && (typeof descriptor.value === 'object' || typeof descriptor.value === 'function')) {
      assertNotProxy(descriptor.value, memberPath);
    }
  }
  for (let index = 0; index < length; index += 1) {
    if (!hasOwn(value, STRING(index))) {
      failSource('malformed_result', field,
        'Independently observed Git branches must be a dense array.');
    }
  }
  return length;
}

function rejectRecordedMismatchBypassAliases(recorded) {
  if (hasOwn(recorded, 'requestId')) {
    failSource('unknown_key', 'recorded.requestId',
      'recorded carries a request identity alias outside the closed result-source vocabulary.');
  }
  if (hasOwn(recorded, 'branch_name')) {
    failSource('unknown_key', 'recorded.branch_name',
      'recorded carries a branch identity alias outside the closed result-source vocabulary.');
  }
  if (hasOwn(recorded, 'headSha')) {
    failSource('unknown_key', 'recorded.headSha',
      'recorded carries a head identity alias outside the closed result-source vocabulary.');
  }
}

function closedObject(input, allowed, field, label) {
  assertPlainObject(input, 'invalid_type', field, label);
  const ownKeys = inspectOwnKeys(input, field);
  const names = [];
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key === 'symbol') {
      failSource('unknown_key', `${field}[symbol]`,
        `${field} carries a symbol key outside the closed result-source vocabulary.`);
    }
    if (!capturedIncludes(allowed, key)) {
      failSource('unknown_key', `${field}.${key}`,
        `${field}.${key} is not part of the closed result-source vocabulary.`);
    }
    names.push(key);
  }
  names.sort();
  return names;
}

function ownScalar(input, key, field) {
  const value = ownDataValue(input, key, field);
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    assertNotProxy(value, field);
  }
  return value;
}

function optionalOwnScalar(input, key, field) {
  if (!hasOwn(input, key)) return undefined;
  const descriptor = ownDescriptor(input, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable) {
    failSource('non_enumerable_property_denied', field,
      `${field} could not be described as an own enumerable data property.`);
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    failSource('accessor_property_denied', field,
      `${field} is an accessor property; result-source data must be direct JSON values and getters are never invoked.`);
  }
  const value = descriptor.value;
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    assertNotProxy(value, field);
  }
  return value;
}

function cloneOwnedJson(value, field) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!NUMBER_IS_FINITE(value)) {
      failSource('invalid_type', field, 'JSON number results must be finite.');
    }
    return value;
  }
  if (typeof value !== 'object') {
    failSource('invalid_type', field,
      'The Cursor Cloud JSON value could not be copied into owned data.');
  }
  assertNotProxy(value, field);
  assertDirectJsonClosure(value, field);
  try {
    return JSON_PARSE(JSON_STRINGIFY(value));
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSource('invalid_type', field,
      'The Cursor Cloud JSON value could not be copied into owned data.');
  }
}

function readExactBoolean(input, key, field) {
  const flagged = ownDataValue(input, key, field);
  if (flagged !== true && flagged !== false) {
    failSource('invalid_type', field,
      `${field} must be an exact boolean when present.`);
  }
  return flagged === true;
}

function readTruncationAliases(input, field) {
  const hasTruncated = hasOwn(input, 'truncated');
  const hasSourceTruncated = hasOwn(input, 'source_truncated');
  if (!hasTruncated && !hasSourceTruncated) return false;
  const truncated = hasTruncated
    ? readExactBoolean(input, 'truncated', `${field}.source_truncated`)
    : null;
  const sourceTruncated = hasSourceTruncated
    ? readExactBoolean(input, 'source_truncated', `${field}.source_truncated`)
    : null;
  if (hasTruncated && hasSourceTruncated && truncated !== sourceTruncated) {
    failSource('invalid_format', `${field}.source_truncated`,
      'truncated and source_truncated aliases must match when both are present.');
  }
  return (sourceTruncated ?? truncated) === true;
}

function assertNotProxySurface(value, field, label) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    assertNotProxy(value, field);
  }
  if (value === null || typeof value !== 'object' || capturedIsArray(value)) {
    failSource('malformed_result', field, label);
  }
}

function encodeJsonValue(value, field) {
  assertDirectJsonClosure(value, field);
  try {
    const text = JSON_STRINGIFY(value);
    if (typeof text !== 'string') {
      failSource('invalid_type', field,
        'The Cursor Cloud JSON value could not be serialized.');
    }
    return BUFFER_FROM(text, 'utf8');
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSource('invalid_type', field,
      'The Cursor Cloud JSON value could not be serialized.');
  }
}

function chunkToBytes(chunk, field) {
  if (typeof chunk === 'string') return BUFFER_FROM(chunk, 'utf8');
  if (isIntrinsicBinaryView(chunk)) return snapshotView(chunk);
  failSource('artifact_stream_invalid_chunk', field,
    'Every stream chunk must be a string or an intrinsic Buffer/Uint8Array view.');
}

async function collectStream(iterable, field) {
  const parts = [];
  let total = 0;
  try {
    for await (const chunk of iterable) {
      const bytes = chunkToBytes(chunk, field);
      if (total + bytes.byteLength > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
        failSource('artifact_stream_over_cap', field,
          `The Cursor Cloud result exceeded the ${MAX_RAW_ARTIFACT_BYTE_LENGTH}-byte raw class cap; nothing was published.`);
      }
      parts.push(bytes);
      total += bytes.byteLength;
    }
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSource('artifact_sink_failed', field,
      'The Cursor Cloud result stream failed before its declared length; nothing was published.');
  }
  if (total === 0) return BUFFER_ALLOC(0);
  if (parts.length === 1) return parts[0];
  return BUFFER_CONCAT(parts, total);
}

async function normalizeOutput(source, field) {
  if (source === null || source === undefined) {
    return { bytes: BUFFER_ALLOC(0), mediaType: 'text/plain' };
  }
  if (typeof source === 'string') {
    return { bytes: BUFFER_FROM(source, 'utf8'), mediaType: 'text/plain' };
  }
  if (typeof source === 'number' || typeof source === 'boolean') {
    if (typeof source === 'number' && !NUMBER_IS_FINITE(source)) {
      failSource('invalid_type', field, 'JSON number results must be finite.');
    }
    return { bytes: BUFFER_FROM(JSON_STRINGIFY(source), 'utf8'), mediaType: 'application/json' };
  }
  if (isIntrinsicBinaryView(source)) {
    return { bytes: snapshotView(source), mediaType: 'text/plain' };
  }
  if (source !== null && typeof source === 'object') {
    if (IS_PROXY(source)) {
      failSource('proxy_denied', field, 'The provider result source is a live or revoked Proxy.');
    }
    if (isAcceptableAsyncIterable(source)) {
      return { bytes: await collectStream(source, field), mediaType: 'text/plain' };
    }
    if (Array.isArray(source) || OBJECT_GET_PROTOTYPE_OF(source) === OBJECT_PROTOTYPE
      || OBJECT_GET_PROTOTYPE_OF(source) === null) {
      return { bytes: encodeJsonValue(source, field), mediaType: 'application/json' };
    }
  }
  failSource('artifact_stream_invalid_source', field,
    'The provider result source must be a string, JSON value, intrinsic byte view, or async iterable of such chunks.');
}

function parseObserved(input) {
  if (!hasOwn(input, 'observed')) return freezeData({});
  const observed = ownDataValue(input, 'observed', 'observed');
  closedObject(observed, CURSOR_CLOUD_RESULT_SOURCE_OBSERVED_KEYS, 'observed',
    'The independently observed Cursor Cloud correlation');
  const projected = {};
  if (hasOwn(observed, 'provider_run_id')) {
    projected.provider_run_id = assertTokenId(
      ownDataValue(observed, 'provider_run_id', 'observed.provider_run_id'),
      'observed.provider_run_id', 'provider run',
    );
  }
  if (hasOwn(observed, 'request_id')) {
    projected.request_id = assertTokenId(
      ownDataValue(observed, 'request_id', 'observed.request_id'),
      'observed.request_id', 'request',
    );
  }
  if (hasOwn(observed, 'agent_id')) {
    projected.agent_id = assertTokenId(
      ownDataValue(observed, 'agent_id', 'observed.agent_id'),
      'observed.agent_id', 'agent',
    );
  }
  if (hasOwn(observed, 'run_id')) {
    const runId = ownDataValue(observed, 'run_id', 'observed.run_id');
    assertRunId(runId, 'observed.run_id');
    projected.run_id = runId;
  }
  if (hasOwn(observed, 'assignment_id')) {
    const assignmentId = ownDataValue(observed, 'assignment_id', 'observed.assignment_id');
    if (typeof assignmentId !== 'string' || !isAssignmentId(assignmentId)) {
      failSource('invalid_format', 'observed.assignment_id',
        'observed.assignment_id violates the assignment-id grammar.');
    }
    projected.assignment_id = assignmentId;
  }
  return freezeData(projected);
}

function parseProviderReport(input) {
  if (!hasOwn(input, 'provider_report')) {
    return {
      status: null,
      output: undefined,
      error: null,
      source_truncated: false,
    };
  }
  const report = ownDataValue(input, 'provider_report', 'provider_report');
  closedObject(report, CURSOR_CLOUD_PROVIDER_REPORT_INPUT_KEYS, 'provider_report',
    'The Cursor Cloud provider report');
  let status = null;
  if (hasOwn(report, 'status')) {
    status = ownDataValue(report, 'status', 'provider_report.status');
    if (!capturedIncludes(CURSOR_CLOUD_PROVIDER_REPORT_STATUSES, status)) {
      failSource('invalid_format', 'provider_report.status',
        'provider_report.status must be a closed provider-reported status.');
    }
  }
  return {
    status,
    output: hasOwn(report, 'output') ? ownDataValue(report, 'output', 'provider_report.output') : undefined,
    error: hasOwn(report, 'error') ? ownDataValue(report, 'error', 'provider_report.error') : null,
    source_truncated: parseBooleanFlag(report, 'source_truncated', 'provider_report.source_truncated'),
  };
}

function parseGitEvidence(input) {
  if (!hasOwn(input, 'git_evidence')) return null;
  const git = ownDataValue(input, 'git_evidence', 'git_evidence');
  if (git == null) return null;
  closedObject(git, CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS, 'git_evidence',
    'Independently observed Cursor Cloud Git evidence');
  const projected = {};
  if (hasOwn(git, 'repository_identity')) {
    projected.repository_identity = assertRepoIdentity(
      ownDataValue(git, 'repository_identity', 'git_evidence.repository_identity'),
      'git_evidence.repository_identity',
    );
  }
  if (hasOwn(git, 'repository_url')) {
    projected.repository_url = assertRepoUrl(
      ownDataValue(git, 'repository_url', 'git_evidence.repository_url'),
      'git_evidence.repository_url',
    );
  }
  if (hasOwn(git, 'branch')) {
    projected.branch = assertBranch(
      ownDataValue(git, 'branch', 'git_evidence.branch'),
      'git_evidence.branch',
    );
  }
  if (hasOwn(git, 'head_sha')) {
    projected.head_sha = assertCommit(
      ownDataValue(git, 'head_sha', 'git_evidence.head_sha'),
      'git_evidence.head_sha',
    );
  }
  if (hasOwn(git, 'merge_base_sha')) {
    projected.merge_base_sha = assertCommit(
      ownDataValue(git, 'merge_base_sha', 'git_evidence.merge_base_sha'),
      'git_evidence.merge_base_sha',
    );
  }
  if (hasOwn(git, 'starting_sha')) {
    projected.starting_sha = assertCommit(
      ownDataValue(git, 'starting_sha', 'git_evidence.starting_sha'),
      'git_evidence.starting_sha',
    );
  }
  if (hasOwn(git, 'linear_history')) {
    const linear = ownDataValue(git, 'linear_history', 'git_evidence.linear_history');
    if (linear !== true && linear !== false) {
      failSource('invalid_type', 'git_evidence.linear_history',
        'git_evidence.linear_history must be an exact boolean when present.');
    }
    projected.linear_history = linear;
  }
  if (hasOwn(git, 'pr_url')) {
    projected.pr_url = assertPrUrl(
      ownDataValue(git, 'pr_url', 'git_evidence.pr_url'),
      'git_evidence.pr_url',
    );
  }
  projected.source_truncated = parseBooleanFlag(git, 'source_truncated', 'git_evidence.source_truncated');
  return freezeData(projected);
}

function parseIdentity(input) {
  if (!hasOwn(input, 'run_id')) {
    failSource('missing_key', 'options.run_id',
      'options.run_id is required; the result source binds one exact run identity.');
  }
  if (!hasOwn(input, 'assignment_id')) {
    failSource('missing_key', 'options.assignment_id',
      'options.assignment_id is required; the result source binds one exact child identity.');
  }
  if (!hasOwn(input, 'provider')) {
    failSource('missing_key', 'options.provider',
      'options.provider is required; the result source binds cursor-cloud only.');
  }
  if (!hasOwn(input, 'model')) {
    failSource('missing_key', 'options.model',
      'options.model is required; the result source binds one exact model identity.');
  }

  const runId = ownDataValue(input, 'run_id', 'options.run_id');
  assertRunId(runId, 'options.run_id');
  const assignmentId = ownDataValue(input, 'assignment_id', 'options.assignment_id');
  if (typeof assignmentId !== 'string' || !isAssignmentId(assignmentId)) {
    failSource('invalid_format', 'options.assignment_id',
      'options.assignment_id violates the assignment-id grammar; child artifacts bind one exact child.');
  }
  const provider = ownDataValue(input, 'provider', 'options.provider');
  if (typeof provider !== 'string' || !isKnownProvider(provider)) {
    failSource('unknown_provider', 'options.provider',
      'options.provider must be a known provider.');
  }
  if (provider !== CURSOR_CLOUD_RESULT_SOURCE_PROVIDER) {
    failSource('cursor_cloud_provider_required', 'options.provider',
      'The Cursor Cloud result source accepts only cursor-cloud.');
  }
  const model = ownDataValue(input, 'model', 'options.model');
  if (!isModelId(model)) {
    failSource('invalid_format', 'options.model',
      'options.model must be an exact model identifier.');
  }

  let childEnvelopeDigest = null;
  if (hasOwn(input, 'child_envelope_digest')) {
    const digest = ownDataValue(input, 'child_envelope_digest', 'options.child_envelope_digest');
    if (typeof digest !== 'string'
      || digest.length !== DIGEST_HEX_LENGTH
      || !capturedTest(PRIVATE_SHA256_PATTERN, digest)) {
      failSource('invalid_format', 'options.child_envelope_digest',
        'options.child_envelope_digest must be an exact lowercase SHA-256 hex digest when present.');
    }
    childEnvelopeDigest = digest;
  }

  return freezeData({
    run_id: runId,
    assignment_id: assignmentId,
    provider,
    model,
    child_envelope_digest: childEnvelopeDigest,
    request_id: assertOptionalToken(input, 'request_id', 'options.request_id', 'request'),
    agent_id: assertOptionalToken(input, 'agent_id', 'options.agent_id', 'agent'),
    provider_run_id: assertOptionalToken(input, 'provider_run_id', 'options.provider_run_id', 'provider run'),
    repository_identity: hasOwn(input, 'repository_identity')
      ? assertRepoIdentity(
        ownDataValue(input, 'repository_identity', 'options.repository_identity'),
        'options.repository_identity',
      )
      : null,
    repository_url: hasOwn(input, 'repository_url')
      ? assertRepoUrl(ownDataValue(input, 'repository_url', 'options.repository_url'), 'options.repository_url')
      : null,
    branch: hasOwn(input, 'branch')
      ? assertBranch(ownDataValue(input, 'branch', 'options.branch'), 'options.branch')
      : null,
    starting_sha: hasOwn(input, 'starting_sha')
      ? assertCommit(ownDataValue(input, 'starting_sha', 'options.starting_sha'), 'options.starting_sha')
      : null,
    head_sha: hasOwn(input, 'head_sha')
      ? assertCommit(ownDataValue(input, 'head_sha', 'options.head_sha'), 'options.head_sha')
      : null,
  });
}

export function isCursorCloudResultIdentityMismatchV1(error) {
  return error instanceof RunContractV1Error
    && capturedIncludes(CURSOR_CLOUD_RESULT_SOURCE_IDENTITY_MISMATCH_CODES, error.code);
}

export function assertCursorCloudResultCorrelationV1(input) {
  closedObject(input, CURSOR_CLOUD_RESULT_CORRELATION_KEYS, 'correlation',
    'The Cursor Cloud result correlation');
  const recorded = hasOwn(input, 'recorded')
    ? ownDataValue(input, 'recorded', 'recorded')
    : {};
  assertPlainObject(recorded, 'invalid_type', 'recorded', 'The recorded Cursor Cloud identity');
  rejectRecordedMismatchBypassAliases(recorded);
  closedObject(recorded, CURSOR_CLOUD_RECORDED_IDENTITY_KEYS, 'recorded',
    'The recorded Cursor Cloud identity');
  for (let index = 0; index < CURSOR_CLOUD_RECORDED_IDENTITY_KEYS.length; index += 1) {
    const key = CURSOR_CLOUD_RECORDED_IDENTITY_KEYS[index];
    if (hasOwn(recorded, key)) optionalOwnScalar(recorded, key, `recorded.${key}`);
  }
  const observed = hasOwn(input, 'observed')
    ? parseObserved({ observed: ownDataValue(input, 'observed', 'observed') })
    : freezeData({});
  const git = hasOwn(input, 'git_evidence')
    ? parseGitEvidence({ git_evidence: ownDataValue(input, 'git_evidence', 'git_evidence') })
    : null;

  const recordedRunId = optionalOwnScalar(recorded, 'run_id', 'recorded.run_id');
  if (typeof recordedRunId === 'string' && observed.run_id !== undefined) {
    assertRunId(recordedRunId, 'recorded.run_id');
    assertExactIdentity(recordedRunId, observed.run_id, 'run_identity_mismatch', 'observed.run_id', 'run');
  }
  const recordedAssignmentId = optionalOwnScalar(recorded, 'assignment_id', 'recorded.assignment_id');
  if (typeof recordedAssignmentId === 'string' && observed.assignment_id !== undefined) {
    if (!isAssignmentId(recordedAssignmentId)) {
      failSource('invalid_format', 'recorded.assignment_id',
        'recorded.assignment_id violates the assignment-id grammar.');
    }
    assertExactIdentity(
      recordedAssignmentId, observed.assignment_id, 'assignment_identity_mismatch',
      'observed.assignment_id', 'assignment',
    );
  }
  const recordedRequestId = optionalOwnScalar(recorded, 'request_id', 'recorded.request_id');
  if (typeof recordedRequestId === 'string' && observed.request_id !== undefined) {
    const requestId = assertTokenId(recordedRequestId, 'recorded.request_id', 'request');
    assertExactIdentity(
      requestId, observed.request_id, 'request_identity_mismatch',
      'observed.request_id', 'request',
    );
  }
  const recordedProviderRunId = optionalOwnScalar(recorded, 'provider_run_id', 'recorded.provider_run_id');
  if (typeof recordedProviderRunId === 'string' && observed.provider_run_id !== undefined) {
    const providerRunId = assertTokenId(
      recordedProviderRunId, 'recorded.provider_run_id', 'provider run',
    );
    assertExactIdentity(
      providerRunId, observed.provider_run_id, 'provider_run_identity_mismatch',
      'observed.provider_run_id', 'provider run',
    );
  }
  const recordedAgentId = optionalOwnScalar(recorded, 'agent_id', 'recorded.agent_id');
  if (typeof recordedAgentId === 'string' && observed.agent_id !== undefined) {
    const agentId = assertTokenId(recordedAgentId, 'recorded.agent_id', 'agent');
    assertExactIdentity(
      agentId, observed.agent_id, 'agent_identity_mismatch',
      'observed.agent_id', 'agent',
    );
  }
  if (git !== null) {
    const recordedBranch = optionalOwnScalar(recorded, 'branch', 'recorded.branch');
    if (typeof recordedBranch === 'string' && git.branch !== undefined) {
      const branch = assertBranch(recordedBranch, 'recorded.branch');
      assertExactIdentity(branch, git.branch, 'branch_identity_mismatch', 'git_evidence.branch', 'branch');
    }
    const recordedRepoIdentity = optionalOwnScalar(
      recorded, 'repository_identity', 'recorded.repository_identity',
    );
    if (typeof recordedRepoIdentity === 'string' && git.repository_identity !== undefined) {
      const repo = assertRepoIdentity(recordedRepoIdentity, 'recorded.repository_identity');
      assertExactIdentity(
        repo, git.repository_identity, 'repository_identity_mismatch',
        'git_evidence.repository_identity', 'repository',
      );
    }
    const recordedRepoUrl = optionalOwnScalar(recorded, 'repository_url', 'recorded.repository_url');
    if (typeof recordedRepoUrl === 'string' && git.repository_url !== undefined) {
      const url = assertRepoUrl(recordedRepoUrl, 'recorded.repository_url');
      assertExactIdentity(
        url, git.repository_url, 'repository_identity_mismatch',
        'git_evidence.repository_url', 'repository',
      );
    }
    const recordedStarting = optionalOwnScalar(recorded, 'starting_sha', 'recorded.starting_sha');
    if (typeof recordedStarting === 'string') {
      const starting = assertCommit(recordedStarting, 'recorded.starting_sha');
      if (git.starting_sha !== undefined) {
        assertExactIdentity(
          starting, git.starting_sha, 'base_identity_mismatch',
          'git_evidence.starting_sha', 'starting SHA',
        );
      }
      if (git.merge_base_sha !== undefined
        && !exactBytesEqual(git.merge_base_sha, starting)
        && (git.head_sha === undefined || !exactBytesEqual(git.merge_base_sha, git.head_sha))) {
        failSource('base_identity_mismatch', 'git_evidence.merge_base_sha',
          'Cursor Cloud merge-base identity did not match the recorded starting SHA or observed head.');
      }
    }
    const recordedHead = optionalOwnScalar(recorded, 'head_sha', 'recorded.head_sha');
    if (typeof recordedHead === 'string' && git.head_sha !== undefined) {
      const head = assertCommit(recordedHead, 'recorded.head_sha');
      assertExactIdentity(head, git.head_sha, 'head_identity_mismatch', 'git_evidence.head_sha', 'head');
    }
  }
  return freezeData({ recorded: true, observed, git_evidence: git });
}

function recordedCorrelationIdentity(identity) {
  const recorded = {};
  for (let index = 0; index < CURSOR_CLOUD_RECORDED_IDENTITY_KEYS.length; index += 1) {
    const key = CURSOR_CLOUD_RECORDED_IDENTITY_KEYS[index];
    if (hasOwn(identity, key)) {
      recorded[key] = ownDataValue(identity, key, `recorded.${key}`);
    }
  }
  return recorded;
}

function parseOptions(input) {
  closedObject(input, CURSOR_CLOUD_RESULT_SOURCE_OPTION_KEYS, 'options',
    'The Cursor Cloud result source options');
  const identity = parseIdentity(input);
  const observed = parseObserved(input);
  const providerReport = parseProviderReport(input);
  const gitEvidence = parseGitEvidence(input);
  assertCursorCloudResultCorrelationV1({
    recorded: recordedCorrelationIdentity(identity),
    observed,
    git_evidence: gitEvidence,
  });
  return { identity, observed, providerReport, gitEvidence };
}

function utf8BoundaryStart(bytes, fromOffset) {
  if (fromOffset === 0) return 0;
  let start = 0;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return start;
}

async function readInlineTail(store, provenance) {
  const length = provenance.sanitized_byte_length;
  const maxBytes = CURSOR_CLOUD_RESULT_SOURCE_INLINE_TAIL_MAX_BYTES;
  const offset = length > maxBytes ? length - maxBytes : 0;
  const page = await readSanitizedArtifactV1(store, provenance.sanitized_ref, {
    offset,
    max_bytes: maxBytes,
  });
  const selected = BUFFER_FROM(page.selected_content, 'base64');
  if (selected.byteLength !== page.selected_byte_length) {
    failSource('invalid_format', 'inline_tail',
      'The sanitized reader returned a tail whose encoding did not round-trip.');
  }
  const start = utf8BoundaryStart(selected, offset);
  const aligned = start === 0 ? selected : selected.subarray(start);
  const text = aligned.toString('utf8');
  const tailBytes = BUFFER_FROM(text, 'utf8');
  if (tailBytes.byteLength > maxBytes) {
    failSource('invalid_format', 'inline_tail',
      'The inline tail exceeded the 4096-byte UTF-8 cap after boundary alignment.');
  }
  return freezeData({
    encoding: 'utf8',
    text,
    byte_length: tailBytes.byteLength,
    offset: offset + start,
    max_bytes: maxBytes,
    inline_clipped: (offset + start) > 0 || tailBytes.byteLength < length,
    source_truncated: provenance.source_truncated === true,
    complete: provenance.complete === true,
    reader_clipped: page.reader_clipped === true,
    more: page.more === true,
    next_offset: page.next_offset,
  });
}

async function publishSource(store, identity, artifactKind, relativePath, mediaType, bytes, sourceTruncated) {
  if (bytes.byteLength > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
    failSource('artifact_stream_over_cap', 'source',
      `The Cursor Cloud result exceeded the ${MAX_RAW_ARTIFACT_BYTE_LENGTH}-byte raw class cap; nothing was published.`);
  }
  if (bytes.byteLength < MIN_ARTIFACT_BYTE_LENGTH) {
    return null;
  }
  const rawRef = parseArtifactRefV1({
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    artifact_kind: artifactKind,
    artifact_class: 'raw',
    relative_path: relativePath,
    byte_length: bytes.byteLength,
    sha256: digestOf(bytes),
    media_type: mediaType,
    content_encoding: SANITIZER_CONTENT_ENCODING,
  }, 'artifact_ref');
  const provenance = await sanitizeAndPublishArtifactV1(store, {
    artifact_ref: rawRef,
    source: bytes,
    source_truncated: sourceTruncated,
  });
  if (provenance.schema !== ARTIFACT_SANITIZER_SCHEMA_ID) {
    failSource('artifact_sink_not_verified', 'provenance',
      'The sanitizer returned provenance the result source does not recognize; nothing is reported.');
  }
  const rawVerdict = await verifyStoredArtifactV1(store, provenance.raw_ref);
  const sanitizedVerdict = await verifyStoredArtifactV1(store, provenance.sanitized_ref);
  if (rawVerdict.verified !== true || sanitizedVerdict.verified !== true) {
    failSource('artifact_sink_not_verified', 'artifact_ref',
      'Published Cursor Cloud result artifacts did not verify; nothing is reported.');
  }
  const inlineTail = await readInlineTail(store, provenance);
  return { provenance, inlineTail, relativePath, mediaType };
}

function emptySlot(sourceKind, artifactKind, extra = {}) {
  return freezeData({
    source_kind: sourceKind,
    artifact_kind: artifactKind,
    published: false,
    empty: true,
    relative_path: null,
    media_type: null,
    raw_ref: null,
    sanitized_ref: null,
    raw_digest: null,
    sanitized_digest: null,
    ref_digest_raw: null,
    ref_digest_sanitized: null,
    source_byte_length: 0,
    sanitized_byte_length: 0,
    redaction_counts: null,
    sanitizer_version: null,
    policy_id: null,
    complete: extra.source_truncated !== true,
    source_truncated: extra.source_truncated === true,
    inline_clipped: false,
    storage_limited: false,
    provenance: null,
    inline_tail: null,
    status: extra.status ?? null,
    repository_identity: extra.repository_identity ?? null,
    repository_url: extra.repository_url ?? null,
    branch: extra.branch ?? null,
    head_sha: extra.head_sha ?? null,
    merge_base_sha: extra.merge_base_sha ?? null,
    starting_sha: extra.starting_sha ?? null,
    linear_history: extra.linear_history ?? null,
    pr_url: extra.pr_url ?? null,
  });
}

function publishedSlot(sourceKind, artifactKind, published, extra = {}) {
  const provenance = published.provenance;
  const rawRef = provenance.raw_ref;
  const sanitizedRef = provenance.sanitized_ref;
  return freezeData({
    source_kind: sourceKind,
    artifact_kind: artifactKind,
    published: true,
    empty: false,
    relative_path: published.relativePath,
    media_type: published.mediaType,
    raw_ref: rawRef,
    sanitized_ref: sanitizedRef,
    raw_digest: provenance.source_digest,
    sanitized_digest: provenance.sanitized_digest,
    ref_digest_raw: artifactRefDigestV1(rawRef, 'raw_ref').digest,
    ref_digest_sanitized: artifactRefDigestV1(sanitizedRef, 'sanitized_ref').digest,
    source_byte_length: provenance.source_byte_length,
    sanitized_byte_length: provenance.sanitized_byte_length,
    redaction_counts: provenance.redaction_counts,
    sanitizer_version: provenance.sanitizer_version,
    policy_id: provenance.policy_id,
    complete: provenance.complete === true,
    source_truncated: provenance.source_truncated === true,
    inline_clipped: published.inlineTail.inline_clipped === true,
    storage_limited: false,
    provenance,
    inline_tail: published.inlineTail,
    status: extra.status ?? null,
    repository_identity: extra.repository_identity ?? null,
    repository_url: extra.repository_url ?? null,
    branch: extra.branch ?? null,
    head_sha: extra.head_sha ?? null,
    merge_base_sha: extra.merge_base_sha ?? null,
    starting_sha: extra.starting_sha ?? null,
    linear_history: extra.linear_history ?? null,
    pr_url: extra.pr_url ?? null,
  });
}

function gitTypedFields(git) {
  if (git == null) {
    return {
      repository_identity: null,
      repository_url: null,
      branch: null,
      head_sha: null,
      merge_base_sha: null,
      starting_sha: null,
      linear_history: null,
      pr_url: null,
      source_truncated: false,
    };
  }
  return {
    repository_identity: git.repository_identity ?? null,
    repository_url: git.repository_url ?? null,
    branch: git.branch ?? null,
    head_sha: git.head_sha ?? null,
    merge_base_sha: git.merge_base_sha ?? null,
    starting_sha: git.starting_sha ?? null,
    linear_history: git.linear_history ?? null,
    pr_url: git.pr_url ?? null,
    source_truncated: git.source_truncated === true,
  };
}

function gitStoreRecord(git) {
  const record = {};
  const keys = [
    'repository_identity', 'repository_url', 'branch', 'head_sha',
    'merge_base_sha', 'starting_sha', 'linear_history', 'pr_url',
  ];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (git[key] !== undefined && git[key] !== null) record[key] = git[key];
  }
  return freezeData(record);
}

function optionalCredentialFreeUrl(value, pattern) {
  return typeof value === 'string' && capturedTest(pattern, value) ? value : null;
}

function mapSdkBranchRecord(entry, field) {
  assertPlainObject(entry, 'malformed_result', field, field);
  closedObject(entry, CURSOR_CLOUD_SDK_BRANCH_KEYS, field,
    'Independently observed Cursor Cloud SDK branch evidence');
  const projected = {};
  if (hasOwn(entry, 'repoUrl')) {
    const url = optionalCredentialFreeUrl(
      ownDataValue(entry, 'repoUrl', `${field}.repoUrl`), REPO_URL_PATTERN,
    );
    if (url !== null) projected.repository_url = url;
  }
  if (hasOwn(entry, 'branch')) {
    const branch = ownDataValue(entry, 'branch', `${field}.branch`);
    if (typeof branch === 'string' && capturedTest(BRANCH_PATTERN, branch)) {
      projected.branch = branch;
    }
  }
  if (hasOwn(entry, 'prUrl')) {
    const url = optionalCredentialFreeUrl(
      ownDataValue(entry, 'prUrl', `${field}.prUrl`), PR_URL_PATTERN,
    );
    if (url !== null) projected.pr_url = url;
  }
  return projected;
}

export function projectCursorCloudGitEvidenceV1(git) {
  if (git === null || git === undefined) return null;
  if (typeof git === 'string' || typeof git === 'number' || typeof git === 'boolean') {
    failSource('source_confusion_denied', 'git_evidence',
      'Trusted Git evidence cannot be synthesized from provider text.');
  }
  assertPlainObject(git, 'malformed_result', 'git_evidence',
    'Independently observed Cursor Cloud Git evidence');
  closedObject(git, CURSOR_CLOUD_GIT_PROJECTOR_KEYS, 'git_evidence',
    'Independently observed Cursor Cloud Git evidence');
  const projected = {};
  if (hasOwn(git, 'branches')) {
    const branches = ownDataValue(git, 'branches', 'git_evidence.branches');
    const length = assertConcreteDenseDirectDataArray(branches, 'git_evidence.branches');
    if (length > 0) {
      Object.assign(projected, mapSdkBranchRecord(
        ownDataValue(branches, '0', 'git_evidence.branches[0]'),
        'git_evidence.branches[0]',
      ));
    }
  }
  const typedInput = {};
  for (let index = 0; index < CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS.length; index += 1) {
    const key = CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS[index];
    if (hasOwn(git, key)) typedInput[key] = ownDataValue(git, key, `git_evidence.${key}`);
  }
  if (sortedCapturedKeys(typedInput).length > 0) {
    const typed = parseGitEvidence({ git_evidence: typedInput });
    if (typed !== null) {
      for (let index = 0; index < CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS.length; index += 1) {
        const key = CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS[index];
        if (typed[key] !== undefined && typed[key] !== null && key !== 'source_truncated') {
          projected[key] = typed[key];
        }
      }
      if (typed.source_truncated === true) projected.source_truncated = true;
    }
  }
  if (sortedCapturedKeys(projected).length === 0) return null;
  return freezeData(projected);
}

export function projectCursorCloudProviderReportV1(result) {
  if (result === null || result === undefined) {
    return freezeData({ status: null, output: undefined, error: null, source_truncated: false });
  }
  assertNotProxySurface(
    result,
    'provider_report',
    'A Cursor Cloud provider report must be a plain result object.',
  );
  closedObject(result, CURSOR_CLOUD_SDK_PROVIDER_REPORT_KEYS, 'provider_report',
    'The Cursor Cloud provider report');
  const projected = {
    status: hasOwn(result, 'status') ? ownScalar(result, 'status', 'provider_report.status') : null,
    output: undefined,
    error: null,
    source_truncated: readTruncationAliases(result, 'provider_report'),
  };
  if (hasOwn(result, 'result')) {
    projected.output = cloneOwnedJson(
      ownDataValue(result, 'result', 'provider_report.output'),
      'provider_report.output',
    );
  } else if (hasOwn(result, 'output')) {
    projected.output = cloneOwnedJson(
      ownDataValue(result, 'output', 'provider_report.output'),
      'provider_report.output',
    );
  }
  if (hasOwn(result, 'error')) {
    projected.error = cloneOwnedJson(
      ownDataValue(result, 'error', 'provider_report.error'),
      'provider_report.error',
    );
  }
  if (projected.status !== null && !capturedIncludes(CURSOR_CLOUD_PROVIDER_REPORT_STATUSES, projected.status)) {
    failSource('invalid_format', 'provider_report.status',
      'provider_report.status must be a closed provider-reported status.');
  }
  return freezeData(projected);
}

function ownedProviderReportInput(result) {
  const projected = {};
  for (let index = 0; index < CURSOR_CLOUD_SDK_PROVIDER_REPORT_KEYS.length; index += 1) {
    const key = CURSOR_CLOUD_SDK_PROVIDER_REPORT_KEYS[index];
    if (hasOwn(result, key)) {
      projected[key] = ownDataValue(result, key, `provider_report.${key}`);
    }
  }
  return projected;
}

export function projectCursorCloudResultSourcesV1(result) {
  if (result === null || result === undefined) {
    failSource('malformed_result', 'result',
      'A Cursor Cloud result must be a plain object with distinct provider and Git sources.');
  }
  assertNotProxySurface(
    result,
    'result',
    'A Cursor Cloud result must be a plain object with distinct provider and Git sources.',
  );
  closedObject(result, CURSOR_CLOUD_SDK_RESULT_KEYS, 'result',
    'A Cursor Cloud result');
  const observed = {};
  if (hasOwn(result, 'id')) {
    observed.provider_run_id = assertTokenId(
      ownScalar(result, 'id', 'observed.provider_run_id'),
      'observed.provider_run_id', 'provider run',
    );
  }
  if (hasOwn(result, 'requestId')) {
    observed.request_id = assertTokenId(
      ownScalar(result, 'requestId', 'observed.request_id'),
      'observed.request_id', 'request',
    );
  }
  if (hasOwn(result, 'agentId')) {
    observed.agent_id = assertTokenId(
      ownScalar(result, 'agentId', 'observed.agent_id'),
      'observed.agent_id', 'agent',
    );
  }
  return freezeData({
    observed: freezeData(observed),
    provider_report: projectCursorCloudProviderReportV1(ownedProviderReportInput(result)),
    git_evidence: projectCursorCloudGitEvidenceV1(
      hasOwn(result, 'git') ? ownDataValue(result, 'git', 'git') : null,
    ),
  });
}

export function contentFreeCloudResultSourceFailureV1(error) {
  const fromContract = error instanceof RunContractV1Error;
  const rawCode = fromContract && typeof error.code === 'string'
    ? error.code
    : 'artifact_sink_failed';
  const rawPath = fromContract && typeof error.path === 'string'
    ? error.path
    : 'source';
  const code = capturedIncludes(CURSOR_CLOUD_RESULT_SOURCE_FAILURE_CODE_ALLOWLIST, rawCode)
    ? rawCode
    : 'artifact_sink_failed';
  const field = capturedIncludes(CURSOR_CLOUD_RESULT_SOURCE_FAILURE_PATH_ALLOWLIST, rawPath)
    ? rawPath
    : 'source';
  return freezeData({
    schema: CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID,
    version: CURSOR_CLOUD_RESULT_SOURCE_VERSION,
    published: false,
    error: freezeData({
      code,
      path: field,
      message: CURSOR_CLOUD_RESULT_SOURCE_FAILURE_MESSAGE,
    }),
  });
}

export function cursorCloudResultSourceIdentityFromTaskV1(task) {
  if (task === null || (typeof task !== 'object' && typeof task !== 'function')) return null;
  assertNotProxy(task, 'task');
  if (typeof task !== 'object' || capturedIsArray(task)) return null;
  if (!hasOwn(task, 'run_id') || !hasOwn(task, 'assignment_id') || !hasOwn(task, 'provider')) {
    return null;
  }
  if (!hasOwn(task, 'model')) return null;
  for (let index = 0; index < CURSOR_CLOUD_TASK_IDENTITY_KEYS.length; index += 1) {
    const key = CURSOR_CLOUD_TASK_IDENTITY_KEYS[index];
    if (hasOwn(task, key)) optionalOwnScalar(task, key, `task.${key}`);
  }
  const model = optionalOwnScalar(task, 'model', 'task.model');
  if (model === null || model === undefined) return null;
  const provider = optionalOwnScalar(task, 'provider', 'task.provider');
  if (provider !== CURSOR_CLOUD_RESULT_SOURCE_PROVIDER) return null;
  const identity = {
    run_id: optionalOwnScalar(task, 'run_id', 'task.run_id'),
    assignment_id: optionalOwnScalar(task, 'assignment_id', 'task.assignment_id'),
    provider,
    model,
  };
  if (hasOwn(task, 'child_envelope_digest')) {
    const digest = optionalOwnScalar(task, 'child_envelope_digest', 'task.child_envelope_digest');
    if (digest !== undefined) identity.child_envelope_digest = digest;
  }
  if (hasOwn(task, 'run_idempotency_key')) {
    const requestId = optionalOwnScalar(task, 'run_idempotency_key', 'task.run_idempotency_key');
    if (requestId !== undefined) identity.request_id = requestId;
  }
  if (hasOwn(task, 'provider_agent_id')) {
    const agentId = optionalOwnScalar(task, 'provider_agent_id', 'task.provider_agent_id');
    if (agentId !== undefined) identity.agent_id = agentId;
  }
  if (hasOwn(task, 'provider_run_id')) {
    const providerRunId = optionalOwnScalar(task, 'provider_run_id', 'task.provider_run_id');
    if (providerRunId !== undefined) identity.provider_run_id = providerRunId;
  }
  if (hasOwn(task, 'provider_repo_url')) {
    const url = optionalOwnScalar(task, 'provider_repo_url', 'task.provider_repo_url');
    if (url !== undefined) identity.repository_url = url;
  }
  if (hasOwn(task, 'provider_repo_identity')) {
    const repo = optionalOwnScalar(task, 'provider_repo_identity', 'task.provider_repo_identity');
    if (repo !== undefined) identity.repository_identity = repo;
  }
  if (hasOwn(task, 'provider_branch')) {
    const branch = optionalOwnScalar(task, 'provider_branch', 'task.provider_branch');
    if (branch !== undefined) identity.branch = branch;
  }
  if (hasOwn(task, 'starting_ref')) {
    const starting = optionalOwnScalar(task, 'starting_ref', 'task.starting_ref');
    if (starting !== undefined) identity.starting_sha = starting;
  }
  if (hasOwn(task, 'head_sha')) {
    const head = optionalOwnScalar(task, 'head_sha', 'task.head_sha');
    if (head !== undefined) identity.head_sha = head;
  }
  return freezeData(identity);
}

export async function openCursorCloudResultArtifactStoreV1(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) {
    failSource('invalid_type', 'root',
      'The artifact store state root must be an absolute path string.');
  }
  if (!PATH_IS_ABSOLUTE(stateRoot)) {
    failSource('invalid_format', 'root',
      'The artifact store state root must be an absolute path string.');
  }
  const artifactsRoot = PATH_JOIN(PATH_RESOLVE(stateRoot), CURSOR_CLOUD_RESULT_STORE_DIR);
  try {
    await MKDIR(artifactsRoot, { recursive: true, mode: 0o700 });
    await CHMOD(artifactsRoot, 0o700);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSource('artifact_sink_failed', 'root',
      'The Cursor Cloud result artifact store root could not be prepared.');
  }
  return openArtifactStoreV1({ root: artifactsRoot });
}

export async function materializeCursorCloudResultSourceV1(store, input) {
  const { identity, observed, providerReport, gitEvidence } = parseOptions(input);

  const providerSource = providerReport.output !== undefined
    ? providerReport.output
    : providerReport.error != null
      ? freezeData({ error: providerReport.error })
      : providerReport.status;
  const providerBytes = await normalizeOutput(providerSource, 'provider_report');
  if (providerBytes.bytes.byteLength > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
    failSource('artifact_stream_over_cap', 'provider_report',
      `The Cursor Cloud provider report exceeded the ${MAX_RAW_ARTIFACT_BYTE_LENGTH}-byte raw class cap; nothing was published.`);
  }
  const providerPath = cursorCloudProviderReportPathV1(identity, providerBytes.mediaType);
  const publishedProvider = await publishSource(
    store, identity, CURSOR_CLOUD_PROVIDER_REPORT_ARTIFACT_KIND,
    providerPath, providerBytes.mediaType, providerBytes.bytes,
    providerReport.source_truncated === true,
  );
  const providerSlot = publishedProvider == null
    ? emptySlot('provider_report', CURSOR_CLOUD_PROVIDER_REPORT_ARTIFACT_KIND, {
      status: providerReport.status,
      source_truncated: providerReport.source_truncated === true,
    })
    : publishedSlot('provider_report', CURSOR_CLOUD_PROVIDER_REPORT_ARTIFACT_KIND, publishedProvider, {
      status: providerReport.status,
    });

  const gitFields = gitTypedFields(gitEvidence);
  let gitSlot = emptySlot('git_evidence', CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND, gitFields);
  if (gitEvidence !== null) {
    const record = gitStoreRecord(gitEvidence);
    if (sortedCapturedKeys(record).length === 0) {
      gitSlot = emptySlot('git_evidence', CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND, gitFields);
    } else {
      const gitBytes = encodeJsonValue(record, 'git_evidence');
      const gitPath = cursorCloudGitEvidencePathV1(identity);
      const publishedGit = await publishSource(
        store, identity, CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND,
        gitPath, 'application/json', gitBytes,
        gitEvidence.source_truncated === true,
      );
      gitSlot = publishedGit == null
        ? emptySlot('git_evidence', CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND, gitFields)
        : publishedSlot('git_evidence', CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND, publishedGit, gitFields);
    }
  }

  return freezeData({
    schema: CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID,
    version: CURSOR_CLOUD_RESULT_SOURCE_VERSION,
    published: providerSlot.published === true || gitSlot.published === true,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    provider: identity.provider,
    model: identity.model,
    child_envelope_digest: identity.child_envelope_digest,
    request_id: observed.request_id ?? identity.request_id,
    agent_id: observed.agent_id ?? identity.agent_id,
    provider_run_id: observed.provider_run_id ?? identity.provider_run_id,
    provider_report: providerSlot,
    git_evidence: gitSlot,
  });
}

capturedFreeze(materializeCursorCloudResultSourceV1);
capturedFreeze(openCursorCloudResultArtifactStoreV1);
capturedFreeze(projectCursorCloudResultSourcesV1);
capturedFreeze(projectCursorCloudProviderReportV1);
capturedFreeze(projectCursorCloudGitEvidenceV1);
capturedFreeze(assertCursorCloudResultCorrelationV1);
capturedFreeze(contentFreeCloudResultSourceFailureV1);
capturedFreeze(cursorCloudResultSourceIdentityFromTaskV1);
capturedFreeze(cursorCloudProviderReportPathV1);
capturedFreeze(cursorCloudGitEvidencePathV1);
capturedFreeze(isCursorCloudResultIdentityMismatchV1);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_OPTION_KEYS);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_RECEIPT_KEYS);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_SLOT_KEYS);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_INLINE_TAIL_KEYS);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_FAILURE_KEYS);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_ERROR_CODES);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_IDENTITY_MISMATCH_CODES);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_FAILURE_CODE_ALLOWLIST);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_FAILURE_PATH_ALLOWLIST);
capturedFreeze(CURSOR_CLOUD_PROVIDER_REPORT_INPUT_KEYS);
capturedFreeze(CURSOR_CLOUD_GIT_EVIDENCE_INPUT_KEYS);
capturedFreeze(CURSOR_CLOUD_RESULT_SOURCE_OBSERVED_KEYS);
capturedFreeze(CURSOR_CLOUD_SDK_PROVIDER_REPORT_KEYS);
capturedFreeze(CURSOR_CLOUD_SDK_RESULT_KEYS);
capturedFreeze(CURSOR_CLOUD_RESULT_CORRELATION_KEYS);
capturedFreeze(CURSOR_CLOUD_TASK_IDENTITY_KEYS);
capturedFreeze(CURSOR_CLOUD_RECORDED_IDENTITY_KEYS);
