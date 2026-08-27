// ArtifactRefV1 — closed bounded artifact-reference contract plus its
// canonical serialization and digest authority (ADR 0001 identifiers
// `bounded_evidence`, `exact_identities`,
// `gate_a_valid_raw_and_sanitized_artifacts`).
//
// Additive v3 module for W3-P07. An ArtifactRefV1 is a bounded declaration
// that one run child produced one artifact of one kind in one class at one
// strict portable relative path with one declared byte length, SHA-256
// content digest, and media/content metadata. It binds exactly ten keys:
//
//   schema           exact "codex-co-engineer.artifact-ref.v1"
//   run_id           exact RunManifestV1 run identifier
//   assignment_id    exact AssignmentManifestV1 child identifier
//   artifact_kind    closed enum bound to the P17 capability vocabulary
//                    (CAPABILITY_ARTIFACT_KINDS), detached here
//   artifact_class   "raw" (owner-only local evidence) or "sanitized"
//                    (model-facing bounded projection)
//   relative_path    strict portable relative path per artifact-path.mjs;
//                    the path carries NO class marker — consumers trust the
//                    ref, never the name
//   byte_length      declared artifact size in bytes, 1..cap(class);
//                    sanitized projections face the model and carry the
//                    tighter cap, raw evidence stays host-local under a
//                    larger but finite cap (ADR `bounded_evidence`)
//   sha256           exact 64-character lowercase hex of the artifact bytes
//   media_type       closed enum
//   content_encoding closed enum ("identity" or "base64")
//
// This module is PURE SCHEMA AND PATH POLICY ONLY. It performs no
// filesystem, network, or process I/O and it makes no claim that P08
// artifact storage exists: byte_length and sha256 are producer declarations
// that only a later storage authority may bind to real bytes. There is no
// constructor from bytes, no reader, no sanitizer, and no existence check.
//
// Identity conventions follow the accepted P03 authority shape without
// touching it: digests are computed only over validator-owned canonical
// forms, never caller views, behind explicit domain separation and
// versioning — a domain string, a 32-bit big-endian version, a ratified
// private label, and every part behind a 32-bit big-endian length prefix,
// all framed with SHA-256. Canonical serialization reuses the shared
// canonical JSON writer (sorted keys, minimal escaping, well-formed Unicode,
// safe integers), so key order and whitespace cannot change a digest while
// any meaningful value change must.
//
// Hostile inputs fail closed before any effect: live and revoked Proxies,
// accessor properties (getters are never invoked), symbol keys, exotic
// prototypes, own undefined values, sparse or extended arrays, aliased or
// cyclic graphs, and oversized/deep payloads are rejected with stable typed
// errors before any value is read into the contract. Parsed results are
// deep-frozen detached snapshots built property-by-property, so later
// mutation of the caller object cannot drift a digest or a comparison.
//
// Ordering is deterministic: compareArtifactRefsV1 fixes one total tuple
// order and orderArtifactRefsV1 returns a bounded duplicate-free frozen
// list, so equal sets of references always serialize and hash identically
// regardless of submission order.

import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

import {
  capturedDescriptor,
  capturedFreeze,
  capturedIncludes,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import { validateArtifactRelativePathV1 } from './artifact-path.mjs';
import { CAPABILITY_ARTIFACT_KINDS } from './capability-bridge.mjs';
import {
  RunContractV1Error,
  assertAllowedKeys,
  assertDenseJsonArray,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  hasOwn,
  optOwn,
} from './selection-json.mjs';

export const ARTIFACT_REF_SCHEMA_ID = 'codex-co-engineer.artifact-ref.v1';

export const ARTIFACT_DIGEST_DOMAIN = 'codex-co-engineer.artifact.v1';
export const ARTIFACT_DIGEST_VERSION = 1;
export const ARTIFACT_REF_DIGEST_LABEL = 'artifact-ref.v1';
export const DIGEST_ALGORITHM = 'sha256';
export const ARTIFACT_DIGEST_HEX_LENGTH = 64;

// Closed vocabularies. artifact_kind stays bound to the P17 capability
// record vocabulary so a lane cannot reference an artifact kind its provider
// capability could never declare; the copy is detached, so later mutation of
// either exported array cannot change what this module accepts.
export const ARTIFACT_KINDS = capturedFreeze([...CAPABILITY_ARTIFACT_KINDS]);
export const ARTIFACT_CLASSES = capturedFreeze(['raw', 'sanitized']);
export const MEDIA_TYPES = capturedFreeze([
  'application/json',
  'application/octet-stream',
  'application/x-ndjson',
  'text/markdown',
  'text/plain',
]);
export const CONTENT_ENCODINGS = capturedFreeze(['base64', 'identity']);

export const ARTIFACT_REF_ALLOWED_KEYS = capturedFreeze([
  'schema',
  'run_id',
  'assignment_id',
  'artifact_kind',
  'artifact_class',
  'relative_path',
  'byte_length',
  'sha256',
  'media_type',
  'content_encoding',
]);

export const MIN_ARTIFACT_BYTE_LENGTH = 1;
export const MAX_RAW_ARTIFACT_BYTE_LENGTH = 33_554_432;
export const MAX_SANITIZED_ARTIFACT_BYTE_LENGTH = 262_144;
export const MAX_ARTIFACT_REFS = 64;

const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const ARTIFACT_SHA256_PATTERN = new RegExp(
  PRIVATE_SHA256_PATTERN.source, PRIVATE_SHA256_PATTERN.flags,
);

// Stable artifact-specific denial codes. Shared vocabulary codes
// (proxy_denied, accessor_property_denied, symbol_key_denied,
// exotic_prototype_denied, aliased_reference_denied, own_undefined_denied,
// unknown_key, forbidden-class denials, and every artifact-path code) pass
// through unchanged from their owning modules.
export const ARTIFACT_REF_ERROR_CODES = capturedFreeze([
  'duplicate_artifact_ref',
  'invalid_format',
  'invalid_type',
  'missing_key',
  'out_of_range',
  'refs_exceeded',
  'unknown_artifact_class',
  'unknown_artifact_kind',
  'unknown_content_encoding',
  'unknown_media_type',
]);

// ---- Captured intrinsics, taken exactly once at initialization. -----------
const CRYPTO_CREATE_HASH = createHash;
const TIMING_SAFE_EQUAL = timingSafeEqual;
const HASH_PROTOTYPE = Object.getPrototypeOf(CRYPTO_CREATE_HASH(DIGEST_ALGORITHM));
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const BUFFER_ALLOC = Buffer.alloc.bind(Buffer);
const BUFFER_FROM = Buffer.from.bind(Buffer);
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_APPLY = Reflect.apply;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REGEXP_TEST = RegExp.prototype.test;
const STRING = String;

function sha256HexPatternMatch(value) {
  return REFLECT_APPLY(REGEXP_TEST, PRIVATE_SHA256_PATTERN, [value]) === true;
}

function maxByteLengthForClass(artifactClass) {
  return artifactClass === 'raw'
    ? MAX_RAW_ARTIFACT_BYTE_LENGTH
    : MAX_SANITIZED_ARTIFACT_BYTE_LENGTH;
}

function enumError(code, path, label, allowed) {
  let joined = '';
  for (let index = 0; index < allowed.length; index += 1) {
    joined += index === 0 ? `"${allowed[index]}"` : `, "${allowed[index]}"`;
  }
  fail(code, path, `${path} must be exactly one of ${joined}; received an outside ${label}.`);
}

// Validate one ArtifactRefV1 direct-JS value and return a deep-frozen,
// detached snapshot built property-by-property from validated scalars. The
// fixed pipeline order means identical inputs always raise the identical
// first typed error.
export function parseArtifactRefV1(input, path = 'artifact_ref') {
  assertPlainObject(input, 'invalid_type', path, `${path}`);
  // Closure gate first: proxies, accessors, symbols, exotic prototypes,
  // sparse arrays, aliases/cycles, undefined values, depth, and hostile
  // shapes are rejected here before any field is interpreted.
  assertDirectJsonClosure(input, path);
  assertAllowedKeys(input, ARTIFACT_REF_ALLOWED_KEYS, path);
  for (let index = 0; index < ARTIFACT_REF_ALLOWED_KEYS.length; index += 1) {
    const key = ARTIFACT_REF_ALLOWED_KEYS[index];
    if (!hasOwn(input, key)) {
      fail('missing_key', `${path}.${key}`,
        `${path}.${key} is required (${ARTIFACT_REF_SCHEMA_ID}); artifact references have no hidden defaults.`);
    }
  }

  const schema = optOwn(input, 'schema');
  if (schema !== ARTIFACT_REF_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `${path}.schema must be exactly "${ARTIFACT_REF_SCHEMA_ID}".`);
  }
  const runId = optOwn(input, 'run_id');
  assertRunId(runId, `${path}.run_id`);
  const assignmentId = optOwn(input, 'assignment_id');
  if (!isAssignmentId(assignmentId)) {
    fail('invalid_format', `${path}.assignment_id`,
      `${path}.assignment_id violates the assignment-id grammar; child artifacts bind one exact child.`);
  }
  const artifactKind = optOwn(input, 'artifact_kind');
  if (!capturedIncludes(ARTIFACT_KINDS, artifactKind)) {
    enumError('unknown_artifact_kind', `${path}.artifact_kind`, 'artifact kind', ARTIFACT_KINDS);
  }
  const artifactClass = optOwn(input, 'artifact_class');
  if (!capturedIncludes(ARTIFACT_CLASSES, artifactClass)) {
    enumError('unknown_artifact_class', `${path}.artifact_class`, 'artifact class', ARTIFACT_CLASSES);
  }
  const relativePath = optOwn(input, 'relative_path');
  validateArtifactRelativePathV1(relativePath, `${path}.relative_path`);

  const byteLength = optOwn(input, 'byte_length');
  if (typeof byteLength !== 'number' || !NUMBER_IS_SAFE_INTEGER(byteLength)) {
    fail('invalid_type', `${path}.byte_length`, `${path}.byte_length must be an integer number of bytes.`);
  }
  const cap = maxByteLengthForClass(artifactClass);
  if (byteLength < MIN_ARTIFACT_BYTE_LENGTH || byteLength > cap) {
    fail('out_of_range', `${path}.byte_length`,
      `${path}.byte_length is ${byteLength} bytes; a ${artifactClass} artifact declares `
      + `${MIN_ARTIFACT_BYTE_LENGTH}..${cap} bytes (ADR bounded_evidence).`);
  }
  const sha256 = optOwn(input, 'sha256');
  if (typeof sha256 !== 'string' || !sha256HexPatternMatch(sha256)) {
    fail('invalid_format', `${path}.sha256`,
      `${path}.sha256 must be an exact ${ARTIFACT_DIGEST_HEX_LENGTH}-character lowercase hex SHA-256.`);
  }
  const mediaType = optOwn(input, 'media_type');
  if (!capturedIncludes(MEDIA_TYPES, mediaType)) {
    enumError('unknown_media_type', `${path}.media_type`, 'media type', MEDIA_TYPES);
  }
  const contentEncoding = optOwn(input, 'content_encoding');
  if (!capturedIncludes(CONTENT_ENCODINGS, contentEncoding)) {
    enumError('unknown_content_encoding', `${path}.content_encoding`, 'content encoding', CONTENT_ENCODINGS);
  }

  // Detached snapshot: fresh ordinary object, every field installed as a
  // frozen enumerable data property copied from the validated value, then
  // frozen as a whole. No alias to the caller object survives.
  const snapshot = {};
  for (let index = 0; index < ARTIFACT_REF_ALLOWED_KEYS.length; index += 1) {
    const key = ARTIFACT_REF_ALLOWED_KEYS[index];
    const value = key === 'byte_length' ? byteLength : capturedDescriptor(input, key).value;
    OBJECT_DEFINE_PROPERTY(snapshot, key, {
      value, enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

export function validateArtifactRefV1(input, path = 'artifact_ref') {
  return parseArtifactRefV1(input, path);
}

// Canonical serialization of the validator-owned form. The caller view is
// never serialized: parsing happens first, so accessor-shaped lookalikes and
// late-mutating views cannot launder bytes into the canonical text.
export function canonicalArtifactRefJsonV1(input, path = 'artifact_ref') {
  return canonicalJsonStringify(parseArtifactRefV1(input, path));
}

function framedUpdate(hash, bytes) {
  const prefix = BUFFER_ALLOC(4);
  prefix.writeUInt32BE(bytes.length, 0);
  HASH_UPDATE.call(hash, prefix);
  HASH_UPDATE.call(hash, bytes);
}

// Domain-separated digest over the canonical validated form, following the
// accepted P03 framing conventions (domain, big-endian version, label, and
// each part behind a big-endian length prefix) without extending the P03
// closed label registry: the artifact label is ratified here and nowhere
// else, so cross-surface digest collision is structurally impossible.
export function artifactRefDigestV1(input, path = 'artifact_ref') {
  const snapshot = parseArtifactRefV1(input, path);
  const canonical = canonicalJsonStringify(snapshot);
  const canonicalBytes = BUFFER_FROM(canonical, 'utf8');
  const hash = CRYPTO_CREATE_HASH(DIGEST_ALGORITHM);
  framedUpdate(hash, BUFFER_FROM(ARTIFACT_DIGEST_DOMAIN, 'utf8'));
  const version = BUFFER_ALLOC(4);
  version.writeUInt32BE(ARTIFACT_DIGEST_VERSION, 0);
  HASH_UPDATE.call(hash, version);
  framedUpdate(hash, BUFFER_FROM(ARTIFACT_REF_DIGEST_LABEL, 'utf8'));
  framedUpdate(hash, canonicalBytes);
  return capturedFreeze({
    algorithm: DIGEST_ALGORITHM,
    domain: ARTIFACT_DIGEST_DOMAIN,
    version: ARTIFACT_DIGEST_VERSION,
    label: ARTIFACT_REF_DIGEST_LABEL,
    input_bytes: canonicalBytes.length,
    digest: HASH_DIGEST.call(hash, 'hex'),
  });
}

// Timing-safe verification. Malformed expected values return false instead
// of throwing; invalid references still fail closed with their typed errors.
export function verifyArtifactRefDigestV1(input, expectedDigestHex, path = 'artifact_ref') {
  if (typeof expectedDigestHex !== 'string'
    || expectedDigestHex.length !== ARTIFACT_DIGEST_HEX_LENGTH
    || !sha256HexPatternMatch(expectedDigestHex)) {
    return false;
  }
  const actual = artifactRefDigestV1(input, path).digest;
  return TIMING_SAFE_EQUAL(BUFFER_FROM(actual, 'hex'), BUFFER_FROM(expectedDigestHex, 'hex')) === true;
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// Deterministic total order over parsed references. The tuple order is:
// run_id, assignment_id, artifact_class, artifact_kind, relative_path,
// media_type, content_encoding, sha256, byte_length. Two references compare
// equal only when every field matches, i.e. when they are the same reference.
export function compareArtifactRefsV1(leftInput, rightInput) {
  const left = parseArtifactRefV1(leftInput, 'left');
  const right = parseArtifactRefV1(rightInput, 'right');
  let verdict = compareStrings(left.run_id, right.run_id);
  if (verdict !== 0) return verdict;
  verdict = compareStrings(left.assignment_id, right.assignment_id);
  if (verdict !== 0) return verdict;
  verdict = compareStrings(left.artifact_class, right.artifact_class);
  if (verdict !== 0) return verdict;
  verdict = compareStrings(left.artifact_kind, right.artifact_kind);
  if (verdict !== 0) return verdict;
  verdict = compareStrings(left.relative_path, right.relative_path);
  if (verdict !== 0) return verdict;
  verdict = compareStrings(left.media_type, right.media_type);
  if (verdict !== 0) return verdict;
  verdict = compareStrings(left.content_encoding, right.content_encoding);
  if (verdict !== 0) return verdict;
  verdict = compareStrings(left.sha256, right.sha256);
  if (verdict !== 0) return verdict;
  return left.byte_length === right.byte_length ? 0 : left.byte_length < right.byte_length ? -1 : 1;
}

// Deterministic, duplicate-free ordering of a bounded batch of references.
// Every element is fully revalidated and detached BEFORE sorting, so caller
// mutation during or after the call can neither disturb the order nor leak
// into the result. Duplicate references (identical validated content, which
// includes two aliases of one object) reject rather than silently collapse.
export function orderArtifactRefsV1(inputs, path = 'artifact_refs') {
  assertNotProxy(inputs, path);
  assertDenseJsonArray(inputs, path);
  if (inputs.length > MAX_ARTIFACT_REFS) {
    fail('refs_exceeded', path,
      `${path} carries ${inputs.length} references; at most ${MAX_ARTIFACT_REFS} are allowed.`);
  }
  const snapshots = [];
  const seenCanonical = new Set();
  for (let index = 0; index < inputs.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    assertNotProxy(inputs[index], entryPath);
    const snapshot = parseArtifactRefV1(inputs[index], entryPath);
    const key = canonicalJsonStringify(snapshot);
    if (seenCanonical.has(key)) {
      fail('duplicate_artifact_ref', entryPath,
        `${entryPath} repeats an identical artifact reference; duplicates are denied instead of collapsed.`);
    }
    seenCanonical.add(key);
    snapshots.push(snapshot);
  }
  snapshots.sort(compareArtifactRefsV1);
  return capturedFreeze(snapshots);
}
