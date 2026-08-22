// Streaming artifact sanitizer/writer (ADR 0001 identifiers
// `bounded_evidence`, `exact_identities`, Gate A
// `gate_a_valid_raw_and_sanitized_artifacts`).
//
// Additive v3 module for W5-P09. It is a fixed-version writer that accepts
// only a caller-bound intrinsic Buffer/Uint8Array view or a bounded async
// iterable of such views, incrementally UTF-8-decodes the source, applies
// one built-in bounded redaction policy, and publishes BOTH the raw source
// and the sanitized projection through the accepted P08 public store APIs.
// P08 has no raw reader: this module never opens artifact content, never
// walks the store tree, and never invents an unchecked derivation from a
// stored digest. The live caller-bound stream is the only source of bytes.
//
// Contract:
//   - Source hardening matches P08: proxies (live or revoked), subclasses,
//     SharedArrayBuffer-backed views, accessor-dressed iterables, strings,
//     and arbitrary class instances (including Node streams) are denied
//     before a byte is read. Every yielded chunk is re-proved intrinsic.
//   - Only identity-encoded text media types are sanitized
//     (text/plain, text/markdown, application/json, application/x-ndjson).
//     application/octet-stream and base64 are refused.
//   - The source ArtifactRefV1 must be class "raw". Declared length/digest
//     are untrusted claims, hashed from the live stream, and must match
//     before anything is published.
//   - Incremental UTF-8 decode uses a streaming decoder so a multi-byte
//     sequence that straddles ingest chunks is preserved; malformed input
//     becomes U+FFFD deterministically. The raw artifact is never retained
//     as a whole: ingest slices, a finite decoder carry, and a finite
//     redaction overlap are the only live windows.
//   - Redaction is a closed built-in policy (credential formats, bearer
//     credentials, env assignments, URL credentials, bounded prompt
//     removal). Callers cannot supply regex, code, or extra patterns.
//     Secrets that straddle chunk boundaries are detected with a finite
//     overlap; matches are never split across an emit boundary.
//   - Raw 32 MiB and sanitized 256 KiB caps are fail-closed. Crossing
//     either cap throws before P08 can commit; the writer never clips.
//   - source_truncated is caller-declared provenance. This module does
//     not infer truncation from size and does not clip toward the cap.
//   - Publication uses only publishArtifactV1 / verifyStoredArtifactV1.
//     A stream is safely teed: P08 consumes the inspected iterable while
//     the sanitizer hashes, decodes, and redacts the same chunks. A
//     buffer source is sanitized first, then both classes are published.
//     Replay, conflict, digest, length, and class-separation guarantees
//     are exactly P08's.
//   - The return is detached deep-frozen content-free provenance: sanitizer
//     version, source digest/length, sanitized ref/digest/length, bounded
//     redaction counts, and completeness/truncation. Artifact bytes, the
//     store root, and OS errors are never echoed.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  ARTIFACT_REF_SCHEMA_ID,
  CONTENT_ENCODINGS,
  MAX_RAW_ARTIFACT_BYTE_LENGTH,
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
  MIN_ARTIFACT_BYTE_LENGTH,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  publishArtifactV1,
  verifyStoredArtifactV1,
} from './artifact-store.mjs';
import {
  capturedFreeze,
  capturedIncludes,
  capturedTest,
  sortedCapturedKeys,
} from './grammar.mjs';
import { RunContractV1Error } from './run-manifest.mjs';
import {
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

export const ARTIFACT_SANITIZER_SCHEMA_ID = 'codex-co-engineer.artifact-sanitizer.v1';
export const ARTIFACT_SANITIZER_VERSION = 1;
export const ARTIFACT_SANITIZER_POLICY_ID = 'codex-co-engineer.artifact-redaction.v1';

export const SANITIZER_MEDIA_TYPES = capturedFreeze([
  'application/json',
  'application/x-ndjson',
  'text/markdown',
  'text/plain',
]);

export const SANITIZER_CONTENT_ENCODING = 'identity';

export const ARTIFACT_SANITIZER_INGEST_CHUNK_BYTES = 65_536;
export const ARTIFACT_SANITIZER_OVERLAP_CHARS = 8_192;
export const ARTIFACT_SANITIZER_REPLACEMENT = '[REDACTED]';

export const REDACTION_KINDS = capturedFreeze([
  'credential_formats',
  'bearer_credentials',
  'env_assignments',
  'url_credentials',
  'prompts',
]);

export const ARTIFACT_SANITIZER_ERROR_CODES = capturedFreeze([
  'artifact_digest_mismatch',
  'artifact_length_mismatch',
  'artifact_stream_failed',
  'artifact_stream_invalid_chunk',
  'artifact_stream_invalid_source',
  'artifact_stream_over_cap',
  'invalid_type',
  'missing_key',
  'sanitizer_content_encoding_denied',
  'sanitizer_empty_output',
  'sanitizer_media_type_denied',
  'unknown_artifact_class',
  'unknown_key',
]);

const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

// ---- Captured intrinsics, taken exactly once at initialization. -----------
const CREATE_HASH = createHash;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const TEXT_DECODER_CTOR = TextDecoder;
const STRING = String;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const REFLECT_HAS = Reflect.has;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const IS_PROXY = utilTypes.isProxy;
const IS_ARRAY_BUFFER = utilTypes.isArrayBuffer;
const IS_SHARED_ARRAY_BUFFER = utilTypes.isSharedArrayBuffer;
const MATH_MIN = Math.min;
const REGEXP_CTOR = RegExp;

const UINT8ARRAY_PROTOTYPE = Uint8Array.prototype;
const BUFFER_PROTOTYPE = NodeBuffer.prototype;
const OBJECT_PROTOTYPE = Object.prototype;
const ASYNC_GENERATOR_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  Object.getPrototypeOf((async function* () {}).prototype),
);
const SYMBOL_ASYNC_ITERATOR = Symbol.asyncIterator;

const OPTION_KEYS = capturedFreeze(['artifact_ref', 'source', 'source_truncated']);

// Bounded built-in policy. Every value-consuming pattern is length-capped so
// the finite overlap is sufficient to catch a split token and no caller
// pattern can expand the scan.
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]{0,32}:\/\/)([^\s/@:]{1,256}):([^\s/@]{1,256})@/gi;
const BEARER_PATTERN = /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{8,512}/gi;
const CREDENTIAL_FORMAT_PATTERN = /\b(?:sk|xai)-[A-Za-z0-9_-]{8,256}\b|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,256}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bcrsr_[A-Za-z0-9_-]{12,256}\b/g;
const ENV_ASSIGNMENT_PATTERN = /\b((?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|credential|password|secret|token|private[_-]?key))(\s*[:=]\s*)(?:"[^"]{0,512}"|'[^']{0,512}'|[^\s,;'"&]{1,512})/gi;
const PROMPT_PATTERN = /((?:["']prompt["']|\bprompt)(\s*[:=]\s*))(?:"(?:\\.|[^"\\]){0,4096}"|'(?:\\.|[^'\\]){0,4096}'|[^\s,;{}"']{1,4096})/gi;

const POLICY = capturedFreeze([
  capturedFreeze({
    kind: 'url_credentials',
    pattern: URL_CREDENTIAL_PATTERN,
    replace(match) { return `${match[1]}${ARTIFACT_SANITIZER_REPLACEMENT}@`; },
  }),
  capturedFreeze({
    kind: 'bearer_credentials',
    pattern: BEARER_PATTERN,
    replace(match) { return `${match[0].split(/[ \t]/u, 1)[0]} ${ARTIFACT_SANITIZER_REPLACEMENT}`; },
  }),
  capturedFreeze({
    kind: 'credential_formats',
    pattern: CREDENTIAL_FORMAT_PATTERN,
    replace() { return ARTIFACT_SANITIZER_REPLACEMENT; },
  }),
  capturedFreeze({
    kind: 'env_assignments',
    pattern: ENV_ASSIGNMENT_PATTERN,
    replace(match) { return `${match[1]}${match[2]}${ARTIFACT_SANITIZER_REPLACEMENT}`; },
  }),
  capturedFreeze({
    kind: 'prompts',
    pattern: PROMPT_PATTERN,
    replace(match) { return `${match[1]}${ARTIFACT_SANITIZER_REPLACEMENT}`; },
  }),
]);

function diagnostic(message) {
  const text = STRING(message ?? '');
  return text.length <= 200 ? text : text.slice(0, 200);
}

function failSanitizer(code, field, message) {
  fail(code, field, diagnostic(message));
}

function emptyCounts() {
  return {
    credential_formats: 0,
    bearer_credentials: 0,
    env_assignments: 0,
    url_credentials: 0,
    prompts: 0,
  };
}

function addCounts(target, extra) {
  target.credential_formats += extra.credential_formats;
  target.bearer_credentials += extra.bearer_credentials;
  target.env_assignments += extra.env_assignments;
  target.url_credentials += extra.url_credentials;
  target.prompts += extra.prompts;
}

function makeDecoder() {
  return new TEXT_DECODER_CTOR('utf-8', { fatal: false, ignoreBOM: false });
}

function flagsWithGlobal(pattern) {
  return capturedTest(/g/u, pattern.flags) ? pattern.flags : `${pattern.flags}g`;
}

function findAllMatches(text) {
  const matches = [];
  for (let index = 0; index < POLICY.length; index += 1) {
    const policy = POLICY[index];
    const regex = new REGEXP_CTOR(policy.pattern.source, flagsWithGlobal(policy.pattern));
    regex.lastIndex = 0;
    let matched = regex.exec(text);
    while (matched !== null) {
      if (matched[0].length === 0) {
        regex.lastIndex += 1;
        matched = regex.exec(text);
        continue;
      }
      matches.push({
        index: matched.index,
        length: matched[0].length,
        end: matched.index + matched[0].length,
        kind: policy.kind,
        replacement: policy.replace(matched),
        priority: index,
      });
      matched = regex.exec(text);
    }
  }
  return matches;
}

// Overlapping matches keep the higher-priority policy (URL > bearer >
// credential format > env > prompt) so `Authorization: Bearer …` redacts
// as a bearer credential instead of an env assignment that would leave
// the token behind the first space.
function selectMatches(matches) {
  const ordered = matches.slice();
  ordered.sort((left, right) => (left.index - right.index) || (left.priority - right.priority));
  const selected = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const match = ordered[index];
    let conflict = false;
    for (let cursor = selected.length - 1; cursor >= 0; cursor -= 1) {
      const previous = selected[cursor];
      if (previous.end <= match.index) continue;
      if (match.priority < previous.priority) {
        selected.splice(cursor, 1);
      } else {
        conflict = true;
        break;
      }
    }
    if (!conflict) selected.push(match);
  }
  selected.sort((left, right) => left.index - right.index);
  return selected;
}

function redactRegion(text) {
  const counts = emptyCounts();
  const selected = selectMatches(findAllMatches(text));
  let output = '';
  let from = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const match = selected[index];
    output += text.slice(from, match.index);
    output += match.replacement;
    counts[match.kind] += 1;
    from = match.end;
  }
  output += text.slice(from);
  return { text: output, counts };
}

// ---- Binary source hardening (same discipline as P08, local copy). ---------

function isIntrinsicBinaryView(value) {
  if (value === null || typeof value !== 'object') return false;
  if (IS_PROXY(value)) return false;
  const proto = OBJECT_GET_PROTOTYPE_OF(value);
  if (proto !== UINT8ARRAY_PROTOTYPE && proto !== BUFFER_PROTOTYPE) return false;
  if (!ARRAY_BUFFER_IS_VIEW(value)) return false;
  const backing = value.buffer;
  if (!IS_ARRAY_BUFFER(backing) || IS_SHARED_ARRAY_BUFFER(backing)) return false;
  return true;
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

function classifySource(source) {
  if (isIntrinsicBinaryView(source)) return { kind: 'bytes', value: source };
  if (source !== null && typeof source === 'object') {
    if (IS_PROXY(source)) {
      failSanitizer('proxy_denied', 'source', 'The artifact source is a live or revoked Proxy.');
    }
    if (isAcceptableAsyncIterable(source)) return { kind: 'stream', value: source };
  }
  failSanitizer('artifact_stream_invalid_source', 'source',
    'The artifact source must be an intrinsic Buffer/Uint8Array view or a bounded '
    + 'async iterable of such views.');
}

function createSession(declaredLength) {
  return {
    decoder: makeDecoder(),
    hash: CREATE_HASH('sha256'),
    received: 0,
    declaredLength,
    pending: '',
    sanitizedChunks: [],
    sanitizedBytes: 0,
    counts: emptyCounts(),
  };
}

function emitSanitized(session, text) {
  if (text.length === 0) return;
  const bytes = BUFFER_FROM(text, 'utf8');
  if (session.sanitizedBytes + bytes.byteLength > MAX_SANITIZED_ARTIFACT_BYTE_LENGTH) {
    failSanitizer('artifact_stream_over_cap', 'sanitized',
      `The sanitized projection exceeds the ${MAX_SANITIZED_ARTIFACT_BYTE_LENGTH}-byte class cap; nothing was published.`);
  }
  session.sanitizedChunks.push(bytes);
  session.sanitizedBytes += bytes.byteLength;
}

function commitPending(session) {
  const text = session.pending;
  if (text.length === 0) return;
  const redacted = redactRegion(text);
  addCounts(session.counts, redacted.counts);
  emitSanitized(session, redacted.text);
  session.pending = '';
}

function feedDecoded(session, decoded) {
  if (decoded.length === 0) return;
  session.pending += decoded;
  commitPending(session);
}

function feedView(session, view) {
  const size = view.byteLength;
  if (size > MAX_RAW_ARTIFACT_BYTE_LENGTH - session.received) {
    failSanitizer('artifact_stream_over_cap', 'source',
      `The artifact stream exceeded the ${MAX_RAW_ARTIFACT_BYTE_LENGTH}-byte class cap; nothing was published.`);
  }
  if (session.received + size > session.declaredLength) {
    failSanitizer('artifact_length_mismatch', 'source',
      'The artifact stream grew past its declared byte length; publication is refused.');
  }
  let offset = 0;
  while (offset < size) {
    const end = MATH_MIN(offset + ARTIFACT_SANITIZER_INGEST_CHUNK_BYTES, size);
    const slice = view.subarray(offset, end);
    if (slice.byteLength > 0) session.hash.update(slice);
    const decoded = session.decoder.decode(slice, { stream: true });
    feedDecoded(session, decoded);
    offset = end;
  }
  session.received += size;
}

function finishSession(session) {
  const tail = session.decoder.decode();
  feedDecoded(session, tail);
  if (session.received !== session.declaredLength) {
    failSanitizer('artifact_length_mismatch', 'artifact_ref.byte_length',
      'Actual artifact length does not match the declared byte length; nothing was published.');
  }
  const digest = session.hash.digest('hex');
  session.digest = digest;
  if (session.sanitizedBytes < MIN_ARTIFACT_BYTE_LENGTH) {
    failSanitizer('sanitizer_empty_output', 'sanitized',
      'The sanitized projection is empty; nothing was published.');
  }
  session.sanitized = session.sanitizedChunks.length === 1
    ? session.sanitizedChunks[0]
    : BUFFER_CONCAT(session.sanitizedChunks, session.sanitizedBytes);
  // Drop live windows so the raw source cannot be reconstructed later.
  session.pending = '';
  session.sanitizedChunks = [];
  session.decoder = null;
  return digest;
}

async function* inspectAndForward(iterable, session) {
  try {
    for await (const chunk of iterable) {
      if (!isIntrinsicBinaryView(chunk)) {
        failSanitizer('artifact_stream_invalid_chunk', 'source',
          'Every stream chunk must be an intrinsic Buffer/Uint8Array view.');
      }
      feedView(session, chunk);
      yield chunk;
    }
    finishSession(session);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSanitizer('artifact_stream_failed', 'source',
      'The artifact stream failed before its declared length; nothing was published.');
  }
}

function parseOptions(input) {
  assertPlainObject(input, 'invalid_type', 'options', 'The artifact sanitizer options');
  const keys = sortedCapturedKeys(input);
  for (let index = 0; index < keys.length; index += 1) {
    if (!capturedIncludes(OPTION_KEYS, keys[index])) {
      failSanitizer('unknown_key', `options.${keys[index]}`,
        `options.${keys[index]} is not part of the closed sanitizer vocabulary.`);
    }
  }
  if (!hasOwn(input, 'artifact_ref')) {
    failSanitizer('missing_key', 'options.artifact_ref',
      'options.artifact_ref is required; the sanitizer binds one raw ArtifactRefV1.');
  }
  if (!hasOwn(input, 'source')) {
    failSanitizer('missing_key', 'options.source',
      'options.source is required; the sanitizer never reads stored raw artifacts.');
  }

  const snapshot = parseArtifactRefV1(ownDataValue(input, 'artifact_ref', 'options.artifact_ref'),
    'artifact_ref');
  if (snapshot.artifact_class !== 'raw') {
    failSanitizer('unknown_artifact_class', 'artifact_ref.artifact_class',
      'The sanitizer source reference must be artifact_class "raw".');
  }
  if (!capturedIncludes(SANITIZER_MEDIA_TYPES, snapshot.media_type)) {
    failSanitizer('sanitizer_media_type_denied', 'artifact_ref.media_type',
      'The sanitizer accepts only identity-encoded text media types.');
  }
  if (snapshot.content_encoding !== SANITIZER_CONTENT_ENCODING) {
    failSanitizer('sanitizer_content_encoding_denied', 'artifact_ref.content_encoding',
      `The sanitizer accepts only content_encoding "${SANITIZER_CONTENT_ENCODING}".`);
  }
  if (!capturedIncludes(CONTENT_ENCODINGS, snapshot.content_encoding)) {
    failSanitizer('sanitizer_content_encoding_denied', 'artifact_ref.content_encoding',
      'The sanitizer accepts only identity encoding.');
  }

  let sourceTruncated = false;
  if (hasOwn(input, 'source_truncated')) {
    const flagged = ownDataValue(input, 'source_truncated', 'options.source_truncated');
    if (flagged !== true && flagged !== false) {
      failSanitizer('invalid_type', 'options.source_truncated',
        'options.source_truncated must be an exact boolean when present.');
    }
    sourceTruncated = flagged === true;
  }

  const source = ownDataValue(input, 'source', 'options.source');
  const classified = classifySource(source);
  return { snapshot, classified, source, sourceTruncated };
}

function buildSanitizedRef(rawSnapshot, sanitizedBytes, digest) {
  return parseArtifactRefV1({
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: rawSnapshot.run_id,
    assignment_id: rawSnapshot.assignment_id,
    artifact_kind: rawSnapshot.artifact_kind,
    artifact_class: 'sanitized',
    relative_path: rawSnapshot.relative_path,
    byte_length: sanitizedBytes.byteLength,
    sha256: digest,
    media_type: rawSnapshot.media_type,
    content_encoding: SANITIZER_CONTENT_ENCODING,
  }, 'sanitized_ref');
}

function provenanceFor(rawSnapshot, session, sanitizedRef, sourceTruncated) {
  return freezeData({
    schema: ARTIFACT_SANITIZER_SCHEMA_ID,
    sanitizer_version: ARTIFACT_SANITIZER_VERSION,
    policy_id: ARTIFACT_SANITIZER_POLICY_ID,
    source_digest: session.digest,
    source_byte_length: session.received,
    raw_ref: rawSnapshot,
    sanitized_ref: sanitizedRef,
    sanitized_digest: sanitizedRef.sha256,
    sanitized_byte_length: sanitizedRef.byte_length,
    redaction_counts: freezeData({ ...session.counts }),
    complete: sourceTruncated !== true,
    source_truncated: sourceTruncated === true,
  });
}

function assertDeclaredDigest(session, snapshot) {
  if (session.digest !== snapshot.sha256) {
    failSanitizer('artifact_digest_mismatch', 'artifact_ref.sha256',
      'Actual artifact bytes do not hash to the declared SHA-256; nothing was published.');
  }
  if (typeof snapshot.sha256 !== 'string' || !capturedTest(PRIVATE_SHA256_PATTERN, snapshot.sha256)) {
    failSanitizer('artifact_digest_mismatch', 'artifact_ref.sha256',
      'The declared source digest is not a SHA-256.');
  }
}

async function publishPair(store, rawSnapshot, rawSource, sanitizedRef, sanitizedBytes) {
  await publishArtifactV1(store, rawSnapshot, rawSource);
  await publishArtifactV1(store, sanitizedRef, sanitizedBytes);
  await verifyStoredArtifactV1(store, rawSnapshot);
  await verifyStoredArtifactV1(store, sanitizedRef);
}

export async function sanitizeAndPublishArtifactV1(store, input) {
  const { snapshot, classified, source, sourceTruncated } = parseOptions(input);
  const session = createSession(snapshot.byte_length);

  if (classified.kind === 'bytes') {
    feedView(session, classified.value);
    finishSession(session);
    assertDeclaredDigest(session, snapshot);
    const sanitizedDigest = CREATE_HASH('sha256').update(session.sanitized).digest('hex');
    const sanitizedRef = buildSanitizedRef(snapshot, session.sanitized, sanitizedDigest);
    await publishPair(store, snapshot, source, sanitizedRef, session.sanitized);
    return provenanceFor(snapshot, session, sanitizedRef, sourceTruncated);
  }

  const inspected = inspectAndForward(classified.value, session);
  try {
    await publishArtifactV1(store, snapshot, inspected);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failSanitizer('artifact_stream_failed', 'source',
      'The artifact stream failed before its declared length; nothing was published.');
  }
  if (typeof session.digest !== 'string') {
    failSanitizer('artifact_stream_failed', 'source',
      'The artifact stream ended before sanitizer finish; nothing was published.');
  }
  assertDeclaredDigest(session, snapshot);
  const sanitizedDigest = CREATE_HASH('sha256').update(session.sanitized).digest('hex');
  const sanitizedRef = buildSanitizedRef(snapshot, session.sanitized, sanitizedDigest);
  await publishArtifactV1(store, sanitizedRef, session.sanitized);
  await verifyStoredArtifactV1(store, snapshot);
  await verifyStoredArtifactV1(store, sanitizedRef);
  return provenanceFor(snapshot, session, sanitizedRef, sourceTruncated);
}

capturedFreeze(sanitizeAndPublishArtifactV1);
capturedFreeze(SANITIZER_MEDIA_TYPES);
capturedFreeze(REDACTION_KINDS);
capturedFreeze(ARTIFACT_SANITIZER_ERROR_CODES);
