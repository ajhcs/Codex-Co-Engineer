// Local provider result sink (P11; ADR 0001 identifiers
// `bounded_evidence`, `exact_identities`,
// `sanitized_bounded_evidence_model_facing`,
// Gate A `gate_a_valid_raw_and_sanitized_artifacts`,
// `codex_only_final_acceptance`).
//
// Additive v3 module. It is the provider-neutral authority that routes
// final local Grok ACP, Cursor Local ACP, and DSH ACPX/CLI output into
// the accepted P08/P09 raw+sanitized artifact store. It does not sanitize,
// store, or range-read on its own: P09 `sanitizeAndPublishArtifactV1` and
// P08 `verifyStoredArtifactV1` remain the publication/verify authorities.
//
// Contract:
//   - Exact run_id / assignment_id / provider / model / optional child
//     envelope digest identity is bound into the ArtifactRefV1 path and
//     the detached receipt. Identities are never guessed or rewritten.
//   - The complete transport-available result is stored up to the existing
//     raw class cap. Older output is never silently dropped. If the
//     upstream/transport was already clipped, available bytes are persisted
//     and source_truncated/complete are recorded truthfully.
//   - Only sanitized artifacts are model-readable. The return is detached
//     deep-frozen content-free metadata: refs, provenance, digests, counts,
//     truncation. Never raw bytes, secrets, prompt text, or live handles.
//   - Empty output is not published and does not invent an artifact.
//   - Crossing a class cap fails closed rather than clipping toward the cap.
//   - Publication that does not verify is not reported.
//
// Provider completion remains evidence, never acceptance. This module does
// not mark tasks complete, replay provider work, or talk to supervisor,
// server, scheduler, or the cloud worker.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  ARTIFACT_REF_SCHEMA_ID,
  MAX_RAW_ARTIFACT_BYTE_LENGTH,
  MIN_ARTIFACT_BYTE_LENGTH,
  artifactRefDigestV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
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
  capturedTest,
  isKnownProvider,
  isModelId,
  sortedCapturedKeys,
} from './grammar.mjs';
import { DIGEST_HEX_LENGTH } from './identity.mjs';
import {
  RunContractV1Error,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

export const LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID =
  'codex-co-engineer.local-provider-result-sink.v1';
export const LOCAL_PROVIDER_RESULT_SINK_VERSION = 1;
export const LOCAL_PROVIDER_RESULT_ARTIFACT_KIND = 'provider_report';
export const LOCAL_PROVIDER_RESULT_STORE_DIR = 'artifacts';

export const LOCAL_PROVIDER_RESULT_SINK_PROVIDERS = capturedFreeze([
  'grok', 'cursor-local', 'dsh',
]);

export const LOCAL_PROVIDER_RESULT_SINK_OPTION_KEYS = capturedFreeze([
  'run_id',
  'assignment_id',
  'provider',
  'model',
  'child_envelope_digest',
  'source',
  'source_truncated',
  'media_type',
]);

export const LOCAL_PROVIDER_RESULT_SINK_RECEIPT_KEYS = capturedFreeze([
  'schema',
  'version',
  'published',
  'empty',
  'run_id',
  'assignment_id',
  'provider',
  'model',
  'child_envelope_digest',
  'artifact_kind',
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
  'provenance',
]);

export const LOCAL_PROVIDER_RESULT_SINK_FAILURE_KEYS = capturedFreeze([
  'schema',
  'version',
  'published',
  'error',
]);

export const LOCAL_PROVIDER_RESULT_SINK_ERROR_CODES = capturedFreeze([
  'artifact_sink_failed',
  'artifact_sink_not_verified',
  'artifact_stream_invalid_chunk',
  'artifact_stream_invalid_source',
  'artifact_stream_over_cap',
  'invalid_format',
  'invalid_type',
  'local_provider_required',
  'missing_key',
  'unknown_key',
  'unknown_provider',
]);

const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INTRINSIC_VIEW_SURFACE_KEYS = capturedFreeze([
  'buffer',
  'byteOffset',
  'byteLength',
  'subarray',
]);

const CREATE_HASH = createHash;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const BUFFER_ALLOC = NodeBuffer.alloc.bind(NodeBuffer);
const JSON_STRINGIFY = JSON.stringify;
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

function failSink(code, field, message) {
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

function providerReportPath(runId, assignmentId, mediaType) {
  return `runs/${runId}/${assignmentId}/provider-report.${mediaExtension(mediaType)}`;
}

function encodeJsonValue(value) {
  assertDirectJsonClosure(value, 'source');
  try {
    const text = JSON_STRINGIFY(value);
    if (typeof text !== 'string') {
      failSink('invalid_type', 'source',
        'The provider result JSON value could not be serialized.');
    }
    return BUFFER_FROM(text, 'utf8');
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSink('invalid_type', 'source',
      'The provider result JSON value could not be serialized.');
  }
}

function chunkToBytes(chunk, field) {
  if (typeof chunk === 'string') return BUFFER_FROM(chunk, 'utf8');
  if (isIntrinsicBinaryView(chunk)) return snapshotView(chunk);
  failSink('artifact_stream_invalid_chunk', field,
    'Every stream chunk must be a string or an intrinsic Buffer/Uint8Array view.');
}

async function collectStream(iterable) {
  const parts = [];
  let total = 0;
  try {
    for await (const chunk of iterable) {
      const bytes = chunkToBytes(chunk, 'source');
      if (total + bytes.byteLength > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
        failSink('artifact_stream_over_cap', 'source',
          `The provider result exceeded the ${MAX_RAW_ARTIFACT_BYTE_LENGTH}-byte raw class cap; nothing was published.`);
      }
      parts.push(bytes);
      total += bytes.byteLength;
    }
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSink('artifact_sink_failed', 'source',
      'The provider result stream failed before its declared length; nothing was published.');
  }
  if (total === 0) return BUFFER_ALLOC(0);
  if (parts.length === 1) return parts[0];
  return BUFFER_CONCAT(parts, total);
}

function cliJsonCandidate(value) {
  const candidates = typeof value === 'string'
    ? [value]
    : [value?.result, value?.text, value?.message?.content, value?.content?.text, value?.delta?.text];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0)
    ?? candidates.find((candidate) => typeof candidate === 'string');
}

export function collectCliProviderOutputV1(stdout) {
  const raw = STRING(stdout ?? '');
  if (!raw.trim()) return BUFFER_ALLOC(0);
  const lines = raw.split(/\r?\n/u);
  while (lines.at(-1) === '') lines.pop();
  const records = [];
  for (const line of lines) {
    try {
      const candidate = cliJsonCandidate(JSON.parse(line));
      if (typeof candidate === 'string') records.push({ kind: 'structured', text: candidate });
    } catch {
      records.push({ kind: 'plain', text: line });
    }
  }
  if (records.length === 0) return BUFFER_FROM(raw.trim(), 'utf8');
  let joined = '';
  let previousKind = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.kind === 'plain') {
      if (previousKind === 'structured') joined += '\n';
      joined += record.text;
      if (index < records.length - 1) joined += '\n';
    } else {
      joined += record.text;
    }
    previousKind = record.kind;
  }
  return BUFFER_FROM(joined, 'utf8');
}

export function createLocalProviderResultCollectorV1() {
  const parts = [];
  let total = 0;
  let overflow = false;

  return capturedFreeze({
    append(value) {
      if (overflow || value === null || value === undefined) return;
      const bytes = typeof value === 'string'
        ? BUFFER_FROM(value, 'utf8')
        : isIntrinsicBinaryView(value)
          ? snapshotView(value)
          : null;
      if (bytes === null) {
        failSink('artifact_stream_invalid_chunk', 'source',
          'Collector chunks must be strings or intrinsic Buffer/Uint8Array views.');
      }
      if (total + bytes.byteLength > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
        overflow = true;
        return;
      }
      parts.push(bytes);
      total += bytes.byteLength;
    },
    snapshot() {
      const source = total === 0
        ? BUFFER_ALLOC(0)
        : (parts.length === 1 ? parts[0] : BUFFER_CONCAT(parts, total));
      return capturedFreeze({
        source,
        byte_length: total,
        overflow: overflow === true,
      });
    },
  });
}

async function normalizeSource(source) {
  if (source === null || source === undefined) {
    return { bytes: BUFFER_ALLOC(0), mediaType: 'text/plain' };
  }
  if (typeof source === 'string') {
    return { bytes: BUFFER_FROM(source, 'utf8'), mediaType: 'text/plain' };
  }
  if (typeof source === 'number' || typeof source === 'boolean') {
    if (typeof source === 'number' && !NUMBER_IS_FINITE(source)) {
      failSink('invalid_type', 'source', 'JSON number results must be finite.');
    }
    return { bytes: BUFFER_FROM(JSON_STRINGIFY(source), 'utf8'), mediaType: 'application/json' };
  }
  if (isIntrinsicBinaryView(source)) {
    return { bytes: snapshotView(source), mediaType: 'text/plain' };
  }
  if (source !== null && typeof source === 'object') {
    if (IS_PROXY(source)) {
      failSink('proxy_denied', 'source', 'The provider result source is a live or revoked Proxy.');
    }
    if (isAcceptableAsyncIterable(source)) {
      return { bytes: await collectStream(source), mediaType: 'text/plain' };
    }
    if (Array.isArray(source) || OBJECT_GET_PROTOTYPE_OF(source) === OBJECT_PROTOTYPE
      || OBJECT_GET_PROTOTYPE_OF(source) === null) {
      return { bytes: encodeJsonValue(source), mediaType: 'application/json' };
    }
  }
  failSink('artifact_stream_invalid_source', 'source',
    'The provider result source must be a string, JSON value, intrinsic byte view, or async iterable of such chunks.');
}

function parseIdentity(input) {
  if (!hasOwn(input, 'run_id')) {
    failSink('missing_key', 'options.run_id',
      'options.run_id is required; the sink binds one exact run identity.');
  }
  if (!hasOwn(input, 'assignment_id')) {
    failSink('missing_key', 'options.assignment_id',
      'options.assignment_id is required; the sink binds one exact child identity.');
  }
  if (!hasOwn(input, 'provider')) {
    failSink('missing_key', 'options.provider',
      'options.provider is required; the sink binds one exact local provider.');
  }
  if (!hasOwn(input, 'model')) {
    failSink('missing_key', 'options.model',
      'options.model is required; the sink binds one exact model identity.');
  }

  const runId = ownDataValue(input, 'run_id', 'options.run_id');
  assertRunId(runId, 'options.run_id');
  const assignmentId = ownDataValue(input, 'assignment_id', 'options.assignment_id');
  if (typeof assignmentId !== 'string' || !isAssignmentId(assignmentId)) {
    failSink('invalid_format', 'options.assignment_id',
      'options.assignment_id violates the assignment-id grammar; child artifacts bind one exact child.');
  }
  const provider = ownDataValue(input, 'provider', 'options.provider');
  if (typeof provider !== 'string' || !isKnownProvider(provider)) {
    failSink('unknown_provider', 'options.provider',
      'options.provider must be a known provider.');
  }
  if (!capturedIncludes(LOCAL_PROVIDER_RESULT_SINK_PROVIDERS, provider)) {
    failSink('local_provider_required', 'options.provider',
      'The local provider result sink accepts only grok, cursor-local, and dsh.');
  }
  const model = ownDataValue(input, 'model', 'options.model');
  if (!isModelId(model)) {
    failSink('invalid_format', 'options.model',
      'options.model must be an exact model identifier.');
  }

  let childEnvelopeDigest = null;
  if (hasOwn(input, 'child_envelope_digest')) {
    const digest = ownDataValue(input, 'child_envelope_digest', 'options.child_envelope_digest');
    if (typeof digest !== 'string'
      || digest.length !== DIGEST_HEX_LENGTH
      || !capturedTest(PRIVATE_SHA256_PATTERN, digest)) {
      failSink('invalid_format', 'options.child_envelope_digest',
        'options.child_envelope_digest must be an exact lowercase SHA-256 hex digest when present.');
    }
    childEnvelopeDigest = digest;
  }

  return capturedFreeze({
    run_id: runId,
    assignment_id: assignmentId,
    provider,
    model,
    child_envelope_digest: childEnvelopeDigest,
  });
}

function parseSourceTruncated(input) {
  if (!hasOwn(input, 'source_truncated')) return false;
  const flagged = ownDataValue(input, 'source_truncated', 'options.source_truncated');
  if (flagged !== true && flagged !== false) {
    failSink('invalid_type', 'options.source_truncated',
      'options.source_truncated must be an exact boolean when present.');
  }
  return flagged === true;
}

function parseMediaType(input, inferred) {
  if (!hasOwn(input, 'media_type')) return inferred;
  const mediaType = ownDataValue(input, 'media_type', 'options.media_type');
  if (!capturedIncludes(SANITIZER_MEDIA_TYPES, mediaType)) {
    failSink('invalid_format', 'options.media_type',
      'options.media_type must be an identity-encoded text media type.');
  }
  return mediaType;
}

function parseOptions(input) {
  assertPlainObject(input, 'invalid_type', 'options', 'The local provider result sink options');
  const keys = sortedCapturedKeys(input);
  for (let index = 0; index < keys.length; index += 1) {
    if (!capturedIncludes(LOCAL_PROVIDER_RESULT_SINK_OPTION_KEYS, keys[index])) {
      failSink('unknown_key', `options.${keys[index]}`,
        `options.${keys[index]} is not part of the closed sink vocabulary.`);
    }
  }
  if (!hasOwn(input, 'source')) {
    failSink('missing_key', 'options.source',
      'options.source is required; the sink never reads stored artifacts to recover a result.');
  }
  const identity = parseIdentity(input);
  const sourceTruncated = parseSourceTruncated(input);
  const source = ownDataValue(input, 'source', 'options.source');
  return { identity, sourceTruncated, source, input };
}

function emptyReceipt(identity, sourceTruncated) {
  return freezeData({
    schema: LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID,
    version: LOCAL_PROVIDER_RESULT_SINK_VERSION,
    published: false,
    empty: true,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    provider: identity.provider,
    model: identity.model,
    child_envelope_digest: identity.child_envelope_digest,
    artifact_kind: LOCAL_PROVIDER_RESULT_ARTIFACT_KIND,
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
    complete: sourceTruncated !== true,
    source_truncated: sourceTruncated === true,
    provenance: null,
  });
}

function publishedReceipt(identity, mediaType, relativePath, provenance) {
  const rawRef = provenance.raw_ref;
  const sanitizedRef = provenance.sanitized_ref;
  return freezeData({
    schema: LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID,
    version: LOCAL_PROVIDER_RESULT_SINK_VERSION,
    published: true,
    empty: false,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    provider: identity.provider,
    model: identity.model,
    child_envelope_digest: identity.child_envelope_digest,
    artifact_kind: LOCAL_PROVIDER_RESULT_ARTIFACT_KIND,
    relative_path: relativePath,
    media_type: mediaType,
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
    provenance,
  });
}

export function contentFreeSinkFailureV1(error) {
  const fromContract = error instanceof RunContractV1Error;
  const code = fromContract && typeof error.code === 'string'
    ? error.code
    : 'artifact_sink_failed';
  const field = fromContract && typeof error.path === 'string'
    ? error.path
    : 'sink';
  const message = fromContract
    ? diagnostic(error.message)
    : 'The local provider result sink failed after provider terminal publication.';
  return freezeData({
    schema: LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID,
    version: LOCAL_PROVIDER_RESULT_SINK_VERSION,
    published: false,
    error: freezeData({
      code,
      path: diagnostic(field),
      message,
    }),
  });
}

export function localProviderResultIdentityFromTaskV1(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return null;
  if (IS_PROXY(task)) return null;
  if (!hasOwn(task, 'run_id') || !hasOwn(task, 'assignment_id') || !hasOwn(task, 'provider')) {
    return null;
  }
  let model;
  if (hasOwn(task, 'model')) model = task.model;
  else if (task.provider === 'dsh' && hasOwn(task, 'dsh_model')) model = task.dsh_model;
  if (model === null || model === undefined) return null;
  const identity = {
    run_id: task.run_id,
    assignment_id: task.assignment_id,
    provider: task.provider,
    model,
  };
  if (hasOwn(task, 'child_envelope_digest')) {
    identity.child_envelope_digest = task.child_envelope_digest;
  }
  return freezeData(identity);
}

export async function openLocalProviderArtifactStoreV1(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) {
    failSink('invalid_type', 'root',
      'The artifact store state root must be an absolute path string.');
  }
  if (!PATH_IS_ABSOLUTE(stateRoot)) {
    failSink('invalid_format', 'root',
      'The artifact store state root must be an absolute path string.');
  }
  const artifactsRoot = PATH_JOIN(PATH_RESOLVE(stateRoot), LOCAL_PROVIDER_RESULT_STORE_DIR);
  try {
    await MKDIR(artifactsRoot, { recursive: true, mode: 0o700 });
    await CHMOD(artifactsRoot, 0o700);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSink('artifact_sink_failed', 'root',
      'The local provider artifact store root could not be prepared.');
  }
  return openArtifactStoreV1({ root: artifactsRoot });
}

export async function sinkLocalProviderResultV1(store, input) {
  const { identity, sourceTruncated, source, input: options } = parseOptions(input);
  const normalized = await normalizeSource(source);
  const mediaType = parseMediaType(options, normalized.mediaType);
  const bytes = normalized.bytes;

  if (bytes.byteLength > MAX_RAW_ARTIFACT_BYTE_LENGTH) {
    failSink('artifact_stream_over_cap', 'source',
      `The provider result exceeded the ${MAX_RAW_ARTIFACT_BYTE_LENGTH}-byte raw class cap; nothing was published.`);
  }
  if (bytes.byteLength < MIN_ARTIFACT_BYTE_LENGTH) {
    return emptyReceipt(identity, sourceTruncated);
  }

  const relativePath = providerReportPath(identity.run_id, identity.assignment_id, mediaType);
  const rawRef = parseArtifactRefV1({
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    artifact_kind: LOCAL_PROVIDER_RESULT_ARTIFACT_KIND,
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
    failSink('artifact_sink_not_verified', 'provenance',
      'The sanitizer returned provenance the sink does not recognize; nothing is reported.');
  }

  const rawVerdict = await verifyStoredArtifactV1(store, provenance.raw_ref);
  const sanitizedVerdict = await verifyStoredArtifactV1(store, provenance.sanitized_ref);
  if (rawVerdict.verified !== true || sanitizedVerdict.verified !== true) {
    failSink('artifact_sink_not_verified', 'artifact_ref',
      'Published provider-result artifacts did not verify; nothing is reported.');
  }

  return publishedReceipt(identity, mediaType, relativePath, provenance);
}

capturedFreeze(sinkLocalProviderResultV1);
capturedFreeze(openLocalProviderArtifactStoreV1);
capturedFreeze(createLocalProviderResultCollectorV1);
capturedFreeze(collectCliProviderOutputV1);
capturedFreeze(contentFreeSinkFailureV1);
capturedFreeze(localProviderResultIdentityFromTaskV1);
capturedFreeze(LOCAL_PROVIDER_RESULT_SINK_PROVIDERS);
capturedFreeze(LOCAL_PROVIDER_RESULT_SINK_OPTION_KEYS);
capturedFreeze(LOCAL_PROVIDER_RESULT_SINK_RECEIPT_KEYS);
capturedFreeze(LOCAL_PROVIDER_RESULT_SINK_FAILURE_KEYS);
capturedFreeze(LOCAL_PROVIDER_RESULT_SINK_ERROR_CODES);
