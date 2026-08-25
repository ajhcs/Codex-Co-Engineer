// RunIdentityV1 — deterministic digests over canonical validated forms
// (P03; ADR 0001 identifiers `exact_identities`, `bounded_evidence`,
// `no_post_dispatch_fallback_or_replay`, `immutable_repo_base_identity`).
//
// Additive v3 module. Every digest input is derived from a canonical,
// validated form and never from caller-formatted text:
//
//   - Canonical JSON: object keys sorted by UTF-16 code-unit order, minimal
//     JSON escaping, well-formed Unicode (lone surrogates rejected), safe
//     integers only (-0 collapses to 0), dense arrays, and the P02 manifest
//     depth/node/size bounds. Key order and serialization whitespace
//     therefore cannot change a digest, while any meaningful value change
//     must.
//   - Explicit domain separation and versioning: every digest frames the
//     identity domain string, a 32-bit big-endian identity version, an
//     explicit per-input label, and each input part behind 4-byte big-endian
//     length prefixes. Different surfaces can never collide, and no input
//     can be concatenated ambiguously or left unbounded.
//   - Closed label registry: the only digest labels are the centrally
//     ratified constants in IDENTITY_LABELS. No runtime registration exists,
//     and every digest path resolves its label through that closed registry,
//     so callers can never hash under an arbitrary or unregistered label.
//     An O(1) code-unit type/length preflight runs before registry lookup,
//     so hostile labels are never hashed, scanned, truncated, or reflected:
//     every unknown or overlength label fails with one constant content-free
//     diagnostic.
//   - Bounded hostile-container preflight: the parts container is resolved
//     as a concrete array with its intrinsic length read in O(1) before any
//     traversal. At most sixteen indexed data descriptors are captured once
//     through precomputed numeric keys; irrelevant extra properties are never
//     enumerated, so huge, sparse, decorated, or proxied containers cannot
//     drive unbounded work or alter a digest.
//   - Detached-backing normalization: every trusted typed-array internal-slot
//     read and the byte snapshot/copy normalize failure to one stable typed
//     RunContractV1Error with a constant content-free message and path, so a
//     Buffer whose ArrayBuffer backing store was detached can never leak the
//     platform's native TypeError and nothing is hashed. SharedArrayBuffer
//     and growable ArrayBuffer backing stores are rejected before any byte
//     is read.
//   - Opaque prompt content: user prompts are hashed as exact UTF-8 bytes
//     bound to their run and assignment identity. They are never trimmed,
//     Unicode-normalized, re-encoded, or otherwise interpreted; two prompts
//     that differ by even one byte digest differently.
//
// P02 identity normalization: absent and explicit-false
// `return_contract.allow_diagnostic_partial_candidate` are semantically
// equivalent complete-only manifests, so under the P03 rule that equivalent
// manifests produce identical digests, the RunManifestV1 identity projection
// (`runManifestCanonicalJsonV1` / `runManifestDigestV1`) omits an exact
// false exactly as it omits absence. Explicit true remains a distinct
// authorization and stays in the canonical form. The parser itself still
// preserves a submitted own false field verbatim for audit/display; only
// this identity projection normalizes it. Manifests without the flag keep
// byte-identical canonical bytes, and prompt/envelope/assignment-prompt/
// child-envelope surfaces stay resolution-inert for absent/false/true.
// Canonicalization walks a fully validated detached snapshot with captured
// private reflection; it never consults caller-mutable Object.keys.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';

import {
  capturedCreate,
  capturedDescriptor,
  capturedFreeze,
  capturedGetPrototypeOf,
  capturedHasOwn,
  capturedIsArray,
  capturedJoin,
  capturedObjectIs,
  capturedOwnKeys,
  capturedTest,
  sortedCapturedKeys,
} from './grammar.mjs';
import {
  DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY,
  MAX_MANIFEST_DEPTH,
  RETURN_CONTRACT_REQUIRED_KEYS,
  RunContractV1Error,
  assertDenseJsonArray,
  assertManifestComplexity,
  isPlainObject,
  utf8ByteLength,
} from './run-manifest.mjs';
import { parseRunManifestV1 } from './run-policy.mjs';
import {
  CHILD_ENVELOPE_SCHEMA_ID,
  CHILD_ENVELOPE_VERSION,
  MAX_ENVELOPE_BYTES,
  parseChildEnvelopeV1,
} from './prompt-compiler.mjs';

export const IDENTITY_DOMAIN = 'codex-co-engineer.identity.v1';
export const IDENTITY_VERSION = 1;
export const DIGEST_ALGORITHM = 'sha256';
export const DIGEST_HEX_LENGTH = 64;
const PRIVATE_IDENTITY_LABEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
export const IDENTITY_LABEL_PATTERN = new RegExp(
  PRIVATE_IDENTITY_LABEL_PATTERN.source, PRIVATE_IDENTITY_LABEL_PATTERN.flags,
);

// Closed central label registry. Every entry is a centrally ratified digest
// label owned by one identity surface; the set is closed at module load and
// can never grow at runtime. Labels follow the repository namespace
// convention: the `codex-co-engineer` namespace is carried by
// IDENTITY_DOMAIN, and each label spells `<kebab-surface>.v1`. Dedicated
// digest functions exist only for the three established RunIdentityV1
// surfaces; the remaining labels are reserved for their owning contracts
// and have no digest function in this module.
const OBJECT_ASSIGN = Object.assign;
export const IDENTITY_LABELS = capturedFreeze(OBJECT_ASSIGN(capturedCreate(null), {
  RUN_MANIFEST: 'run-manifest.v1',
  ASSIGNMENT_PROMPT: 'assignment-prompt.v1',
  CHILD_ENVELOPE: 'child-envelope.v1',
  RUN_IDENTITY: 'run-identity.v1',
  CHILD_IDENTITY: 'child-identity.v1',
  RESOLUTION_SNAPSHOT: 'resolution-snapshot.v1',
  RESOLVED_LANE_BINDING: 'resolved-lane-binding.v1',
  WORKSPACE_ANCHOR: 'workspace-anchor.v1',
  WORKSPACE_IDENTITY: 'workspace-identity.v1',
  DISPATCH_ATTEMPT: 'dispatch-attempt.v1',
  PROVIDER_OPERATION: 'provider-operation.v1',
  PROVIDER_RUN_IDENTITY: 'provider-run-identity.v1',
  REQUEST_IDEMPOTENCY: 'request-idempotency.v1',
  PROVIDER_CAPABILITY: 'provider-capability.v1',
  EVIDENCE_BUNDLE: 'evidence-bundle.v1',
  VERIFICATION_POLICY: 'verification-policy.v1',
  VERIFICATION_COMMAND_DESCRIPTOR: 'verification-command-descriptor.v1',
  VERIFICATION_EXECUTABLE_CLOSURE: 'verification-executable-closure.v1',
  VERIFICATION_COMMAND_PLAN: 'verification-command-plan.v1',
  VERIFICATION_EXECUTION_RECEIPT: 'verification-execution-receipt.v1',
}));

export const MAX_IDENTITY_DIGEST_PARTS = 16;
export const MAX_IDENTITY_DIGEST_INPUT_BYTES = 4_194_304;
export const MAX_IDENTITY_LABEL_CODE_UNITS = 64;

const MAX_FRAMED_INPUT_BYTES = 0xffffffff;
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/u;

// Capture every mutable intrinsic used after validation once, at clean
// import, before caller code can replace globals. Grammar already captured
// the shared reflection leaf; Buffer, typed-array, hash, JSON, and
// collection seams used by the digest authority are captured here.
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_PUSH = ARRAY_PROTOTYPE.push;
const BUFFER_ALLOC = NodeBuffer.alloc.bind(NodeBuffer);
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_PROTOTYPE = NodeBuffer.prototype;
const BUFFER_WRITE_UINT32BE = BUFFER_PROTOTYPE.writeUInt32BE;
const CREATE_HASH = createHash;
const HASH_PROTOTYPE = capturedGetPrototypeOf(CREATE_HASH(DIGEST_ALGORITHM));
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_VALUES = Object.values;
const REFLECT_APPLY = Reflect.apply;
const SET_CTOR = Set;
const SET_HAS = SET_CTOR.prototype.has;
const STRING = String;
const TIMING_SAFE_EQUAL = timingSafeEqual;
const UINT8_ARRAY = Uint8Array;
const UINT8_ARRAY_PROTOTYPE = UINT8_ARRAY.prototype;
const ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const IS_ARRAY_BUFFER = types.isArrayBuffer;
const IS_PROXY = types.isProxy;
const IS_SHARED_ARRAY_BUFFER = types.isSharedArrayBuffer;
const IS_UINT8_ARRAY = types.isUint8Array;

const REGISTERED_IDENTITY_LABELS = new SET_CTOR(OBJECT_VALUES(IDENTITY_LABELS));

const IDENTITY_PART_INDEX_KEYS = capturedFreeze([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);
const IDENTITY_PART_PATHS = capturedFreeze([
  'parts[0]', 'parts[1]', 'parts[2]', 'parts[3]',
  'parts[4]', 'parts[5]', 'parts[6]', 'parts[7]',
  'parts[8]', 'parts[9]', 'parts[10]', 'parts[11]',
  'parts[12]', 'parts[13]', 'parts[14]', 'parts[15]',
]);

const UNKNOWN_IDENTITY_LABEL_MESSAGE =
  'Identity label is not a ratified identity label; pass an IDENTITY_LABELS constant.';
const UNREADABLE_PART_CODE = 'invalid_object';
const UNREADABLE_PART_PATH = 'parts';
const UNREADABLE_PART_MESSAGE =
  'A digest part could not be snapshotted through trusted typed-array internal slots.';
const ORDINARY_BUFFER_PART_MESSAGE =
  'must be an ordinary Node Buffer; plain objects, arrays, strings, numbers, typed-array views, DataViews, ArrayBuffers, SharedArrayBuffers, streams, and getter-bearing values are not byte parts.';

const TYPED_ARRAY_PROTOTYPE = capturedGetPrototypeOf(UINT8_ARRAY_PROTOTYPE);
const TYPED_ARRAY_LENGTH_GETTER = capturedDescriptor(TYPED_ARRAY_PROTOTYPE, 'length')?.get;
const TYPED_ARRAY_BUFFER_GETTER = capturedDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')?.get;
const ARRAY_BUFFER_RESIZABLE_GETTER = capturedDescriptor(ARRAY_BUFFER_PROTOTYPE, 'resizable')?.get;
const ARRAY_BUFFER_DETACHED_GETTER = capturedDescriptor(ARRAY_BUFFER_PROTOTYPE, 'detached')?.get;

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

function failUnreadablePart() {
  fail(UNREADABLE_PART_CODE, UNREADABLE_PART_PATH, UNREADABLE_PART_MESSAGE);
}

function truncateForMessage(value) {
  const text = STRING(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function assertWellFormedText(value, path) {
  if (typeof value !== 'string') fail('invalid_type', path, `${path} must be a string.`);
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      fail('invalid_format', path,
        `${path} contains a lone surrogate; canonical inputs must be well-formed Unicode.`);
    }
  }
}

function exactJsonEqual(left, right) {
  if (capturedObjectIs(left, right)) return true;
  if (capturedIsArray(left)) {
    if (!capturedIsArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!exactJsonEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = sortedCapturedKeys(left);
    const rightKeys = sortedCapturedKeys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index];
      if (key !== rightKeys[index] || !capturedHasOwn(right, key)
        || !exactJsonEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// Deterministic canonical JSON serialization. The complexity pre-pass
// rejects cycles, aliased objects, sparse/extended arrays, exotic
// prototypes, accessor properties, and unbounded shapes before emission;
// emission then rejects the scalar forms JSON cannot carry canonically.
export function canonicalJsonStringify(value) {
  assertManifestComplexity(value);
  const parts = [];
  emitCanonical(parts, value, '$', 0);
  return capturedJoin(parts, '');
}

function emitCanonical(parts, value, path, depth) {
  if (depth > MAX_MANIFEST_DEPTH) {
    fail('depth_exceeded', path, `${path} exceeds the maximum canonical depth of ${MAX_MANIFEST_DEPTH}.`);
  }
  if (value === null) {
    ARRAY_PUSH.call(parts, 'null');
    return;
  }
  const kind = typeof value;
  if (kind === 'string') {
    assertWellFormedText(value, path);
    ARRAY_PUSH.call(parts, JSON_STRINGIFY(value));
    return;
  }
  if (kind === 'number') {
    if (!IS_SAFE_INTEGER(value)) {
      fail('invalid_type', path,
        `${path} is ${truncateForMessage(value)}; canonical JSON numbers must be safe integers.`);
    }
    ARRAY_PUSH.call(parts, JSON_STRINGIFY(value));
    return;
  }
  if (kind === 'boolean') {
    ARRAY_PUSH.call(parts, value ? 'true' : 'false');
    return;
  }
  if (kind !== 'object') {
    fail('invalid_type', path,
      `${path} is not a canonical JSON value (received ${kind === 'undefined' ? 'undefined' : kind}).`);
  }
  if (capturedIsArray(value)) {
    assertDenseJsonArray(value, path);
    ARRAY_PUSH.call(parts, '[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) ARRAY_PUSH.call(parts, ',');
      emitCanonical(parts, value[index], `${path}[${index}]`, depth + 1);
    }
    ARRAY_PUSH.call(parts, ']');
    return;
  }
  const keys = sortedCapturedKeys(value);
  ARRAY_PUSH.call(parts, '{');
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) ARRAY_PUSH.call(parts, ',');
    assertWellFormedText(keys[index], `${path}.<key>`);
    ARRAY_PUSH.call(parts, JSON_STRINGIFY(keys[index]));
    ARRAY_PUSH.call(parts, ':');
    emitCanonical(parts, value[keys[index]], `${path}.${keys[index]}`, depth + 1);
  }
  ARRAY_PUSH.call(parts, '}');
}

function typedArrayLength(bytes) {
  if (typeof TYPED_ARRAY_LENGTH_GETTER !== 'function') failUnreadablePart();
  try {
    return REFLECT_APPLY(TYPED_ARRAY_LENGTH_GETTER, bytes, []);
  } catch {
    failUnreadablePart();
  }
}

function framedUpdate(hash, bytes, path) {
  const length = typedArrayLength(bytes);
  if (length > MAX_FRAMED_INPUT_BYTES) {
    fail('unbounded_input', path, `${path} exceeds the ${MAX_FRAMED_INPUT_BYTES}-byte framed-input bound.`);
  }
  const prefix = BUFFER_ALLOC(4);
  BUFFER_WRITE_UINT32BE.call(prefix, length, 0);
  HASH_UPDATE.call(hash, prefix);
  HASH_UPDATE.call(hash, bytes);
}

function resolveRegisteredIdentityLabel(value) {
  if (typeof value !== 'string') {
    fail('invalid_format', 'label', 'Identity label must be an exact IDENTITY_LABELS constant string.');
  }
  if (value.length > MAX_IDENTITY_LABEL_CODE_UNITS
    || !REFLECT_APPLY(SET_HAS, REGISTERED_IDENTITY_LABELS, [value])) {
    fail('unknown_label', 'label', UNKNOWN_IDENTITY_LABEL_MESSAGE);
  }
  return value;
}

function intrinsicArrayLength(value) {
  let descriptor;
  try {
    descriptor = capturedDescriptor(value, 'length');
  } catch {
    return null;
  }
  if (!descriptor || !capturedHasOwn(descriptor, 'value')) return null;
  const length = descriptor.value;
  if (typeof length !== 'number' || !IS_SAFE_INTEGER(length) || length < 0) return null;
  return length;
}

function captureBoundedIdentityParts(value) {
  if (IS_PROXY(value)) {
    fail('invalid_array', 'parts', 'parts must be a concrete JSON array, not a Proxy.');
  }
  if (!capturedIsArray(value)) fail('invalid_type', 'parts', 'parts must be an array.');
  let prototype;
  try {
    prototype = capturedGetPrototypeOf(value);
  } catch {
    fail('invalid_array', 'parts', 'parts prototype could not be inspected safely.');
  }
  if (prototype !== ARRAY_PROTOTYPE) {
    fail('invalid_array', 'parts', 'parts must use the exact Array.prototype.');
  }
  const intrinsicLength = intrinsicArrayLength(value);
  if (intrinsicLength === null) {
    fail('invalid_array', 'parts', 'parts must expose an ordinary array length.');
  }
  if (intrinsicLength > MAX_IDENTITY_DIGEST_PARTS) {
    fail('parts_exceeded', 'parts',
      `Identity digest accepts at most ${MAX_IDENTITY_DIGEST_PARTS} parts; received ${intrinsicLength}.`);
  }
  const captured = capturedCreate(null);
  captured.length = intrinsicLength;
  for (let index = 0; index < intrinsicLength; index += 1) {
    const key = IDENTITY_PART_INDEX_KEYS[index];
    let descriptor;
    try {
      descriptor = capturedDescriptor(value, key);
    } catch {
      fail('invalid_array', IDENTITY_PART_PATHS[index],
        `${IDENTITY_PART_PATHS[index]} could not be inspected safely.`);
    }
    if (!descriptor) {
      fail('invalid_array', 'parts', 'parts must be dense; sparse arrays are not digest part lists.');
    }
    if (!descriptor.enumerable || !capturedHasOwn(descriptor, 'value')) {
      fail('invalid_array', IDENTITY_PART_PATHS[index],
        `${IDENTITY_PART_PATHS[index]} must be an enumerable data element.`);
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function assertExactBufferPart(part, path) {
  if ((typeof part !== 'object' && typeof part !== 'function') || part === null) {
    fail('invalid_type', path, `${path} ${ORDINARY_BUFFER_PART_MESSAGE}`);
  }
  if (IS_PROXY(part)) {
    fail('invalid_object', path, `${path} must be an ordinary Buffer, not a Proxy.`);
  }
  const hasUint8ArrayBrand = IS_UINT8_ARRAY(part);
  let prototype;
  try {
    prototype = capturedGetPrototypeOf(part);
  } catch {
    fail('invalid_object', path, `${path} prototype could not be inspected safely.`);
  }
  if (!hasUint8ArrayBrand) {
    if (prototype === BUFFER_PROTOTYPE) {
      fail('invalid_object', path, `${path} has Buffer.prototype without the Uint8Array byte brand.`);
    }
    fail('invalid_type', path, `${path} ${ORDINARY_BUFFER_PART_MESSAGE}`);
  }
  if (prototype !== BUFFER_PROTOTYPE) {
    if (prototype === UINT8_ARRAY_PROTOTYPE) {
      fail('invalid_type', path, `${path} ${ORDINARY_BUFFER_PART_MESSAGE}`);
    }
    fail('invalid_object', path, `${path} must use the exact Buffer.prototype.`);
  }
  if (typeof TYPED_ARRAY_BUFFER_GETTER !== 'function') {
    fail('invalid_object', path, `${path} backing store could not be read through trusted typed-array slots.`);
  }
  let viewed;
  try {
    viewed = REFLECT_APPLY(TYPED_ARRAY_BUFFER_GETTER, part, []);
  } catch {
    failUnreadablePart();
  }
  if (IS_SHARED_ARRAY_BUFFER(viewed) || !IS_ARRAY_BUFFER(viewed)) {
    fail('invalid_object', path,
      `${path} must be backed by an ordinary ArrayBuffer; SharedArrayBuffer-backed Buffers cannot yield an immutable digest snapshot.`);
  }
  try {
    if (typeof ARRAY_BUFFER_RESIZABLE_GETTER === 'function'
      && REFLECT_APPLY(ARRAY_BUFFER_RESIZABLE_GETTER, viewed, []) === true) {
      fail('invalid_object', path,
        `${path} must be backed by a fixed-length ArrayBuffer; growable ArrayBuffer-backed Buffers cannot yield an immutable digest snapshot.`);
    }
    if (typeof ARRAY_BUFFER_DETACHED_GETTER === 'function'
      && REFLECT_APPLY(ARRAY_BUFFER_DETACHED_GETTER, viewed, []) === true) {
      failUnreadablePart();
    }
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    failUnreadablePart();
  }
  return typedArrayLength(part);
}

function identityDigestHex(label, parts) {
  const registeredLabel = resolveRegisteredIdentityLabel(label);
  const capturedParts = captureBoundedIdentityParts(parts);
  const snapshots = capturedCreate(null);
  let inputBytes = 0;
  for (let index = 0; index < capturedParts.length; index += 1) {
    const key = IDENTITY_PART_INDEX_KEYS[index];
    const path = IDENTITY_PART_PATHS[index];
    const length = assertExactBufferPart(capturedParts[key], path);
    inputBytes += length;
    if (inputBytes > MAX_IDENTITY_DIGEST_INPUT_BYTES) {
      fail('unbounded_input', 'parts',
        `Identity digest input exceeds the ${MAX_IDENTITY_DIGEST_INPUT_BYTES}-byte total bound at ${path}.`);
    }
    try {
      const snapshot = new UINT8_ARRAY(capturedParts[key]);
      if (typedArrayLength(snapshot) !== length) failUnreadablePart();
      snapshots[key] = snapshot;
    } catch {
      failUnreadablePart();
    }
  }
  const hash = CREATE_HASH(DIGEST_ALGORITHM);
  framedUpdate(hash, BUFFER_FROM(IDENTITY_DOMAIN, 'utf8'), 'identity_domain');
  const version = BUFFER_ALLOC(4);
  BUFFER_WRITE_UINT32BE.call(version, IDENTITY_VERSION, 0);
  HASH_UPDATE.call(hash, version);
  framedUpdate(hash, BUFFER_FROM(registeredLabel, 'utf8'), 'identity_label');
  for (let index = 0; index < capturedParts.length; index += 1) {
    framedUpdate(hash, snapshots[IDENTITY_PART_INDEX_KEYS[index]], 'identity_input');
  }
  return { digest: HASH_DIGEST.call(hash, 'hex'), input_bytes: inputBytes };
}

function digestDescriptor(label, parts) {
  const { digest, input_bytes } = identityDigestHex(label, parts);
  return capturedFreeze({
    algorithm: DIGEST_ALGORITHM,
    domain: IDENTITY_DOMAIN,
    version: IDENTITY_VERSION,
    label,
    input_bytes,
    digest,
  });
}

export function identityDigestV1(label, parts) {
  return digestDescriptor(label, parts);
}

function projectReturnContractForIdentity(contract) {
  const projected = capturedCreate(null);
  for (const key of RETURN_CONTRACT_REQUIRED_KEYS) {
    projected[key] = contract[key];
  }
  if (capturedHasOwn(contract, DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY)
    && contract[DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY] === true) {
    projected[DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY] = true;
  }
  return capturedFreeze(projected);
}

function manifestIdentityForm(manifest) {
  const snapshot = parseRunManifestV1(manifest);
  const contract = snapshot.return_contract;
  if (!capturedHasOwn(contract, DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY)
    || contract[DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY] !== false) {
    return snapshot;
  }
  const projected = capturedCreate(null);
  const keys = capturedOwnKeys(snapshot);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') continue;
    projected[key] = key === 'return_contract'
      ? projectReturnContractForIdentity(contract)
      : snapshot[key];
  }
  return capturedFreeze(projected);
}

export function runManifestCanonicalJsonV1(manifest) {
  return canonicalJsonStringify(manifestIdentityForm(manifest));
}

export function runManifestDigestV1(manifest) {
  const canonical = runManifestCanonicalJsonV1(manifest);
  return digestDescriptor(IDENTITY_LABELS.RUN_MANIFEST, [BUFFER_FROM(canonical, 'utf8')]);
}

export function verifyRunManifestDigestV1(manifest, expectedDigestHex) {
  if (typeof expectedDigestHex !== 'string'
    || expectedDigestHex.length !== DIGEST_HEX_LENGTH
    || !capturedTest(DIGEST_HEX_PATTERN, expectedDigestHex)) {
    return false;
  }
  const actual = runManifestDigestV1(manifest).digest;
  return TIMING_SAFE_EQUAL(BUFFER_FROM(actual, 'hex'), BUFFER_FROM(expectedDigestHex, 'hex'));
}

function promptDigestFromSnapshot(snapshot, assignmentId) {
  if (typeof assignmentId !== 'string') {
    fail('invalid_type', 'assignment_id', 'assignment_id must be the exact declared identifier string.');
  }
  const assignments = snapshot.assignments;
  let assignment;
  for (let index = 0; index < assignments.length; index += 1) {
    if (assignments[index].assignment_id === assignmentId) {
      assignment = assignments[index];
      break;
    }
  }
  if (!assignment) {
    fail('unknown_assignment_id', 'assignments',
      `No assignment "${truncateForMessage(assignmentId)}" is declared by run "${snapshot.run_id}".`);
  }
  return digestDescriptor(IDENTITY_LABELS.ASSIGNMENT_PROMPT, [
    BUFFER_FROM(snapshot.run_id, 'utf8'),
    BUFFER_FROM(assignmentId, 'utf8'),
    BUFFER_FROM(assignment.prompt, 'utf8'),
  ]);
}

export function assignmentPromptDigestV1(manifest, assignmentId) {
  return promptDigestFromSnapshot(parseRunManifestV1(manifest), assignmentId);
}

export function childEnvelopeDigestV1(envelope) {
  if (!isPlainObject(envelope)) fail('invalid_type', 'envelope', 'A child envelope must be a JSON object.');
  assertManifestComplexity(envelope);
  if (envelope.schema !== CHILD_ENVELOPE_SCHEMA_ID) {
    fail('invalid_format', 'envelope.schema', `Envelope schema must be exactly "${CHILD_ENVELOPE_SCHEMA_ID}".`);
  }
  if (envelope.version !== CHILD_ENVELOPE_VERSION) {
    fail('invalid_format', 'envelope.version', `Envelope version must be exactly ${CHILD_ENVELOPE_VERSION}.`);
  }
  assertWellFormedText(envelope.envelope_text, 'envelope.envelope_text');
  const textBytes = utf8ByteLength(envelope.envelope_text);
  if (textBytes < 1 || textBytes > MAX_ENVELOPE_BYTES) {
    fail('out_of_range', 'envelope.envelope_text',
      `Envelope text is ${textBytes} bytes; allowed range is 1..${MAX_ENVELOPE_BYTES}.`);
  }
  if (envelope.envelope_byte_length !== textBytes) {
    fail('invalid_format', 'envelope.envelope_byte_length',
      'envelope_byte_length must be present and equal the UTF-8 byte length of envelope_text.');
  }
  const parsed = parseChildEnvelopeV1(envelope.envelope_text);
  const canonical = canonicalJsonStringify(parsed);
  if (!exactJsonEqual(envelope, parsed)) {
    fail('envelope_shape_mismatch', 'envelope',
      'Supplied child envelope does not exactly match the strict parse of its own envelope_text.');
  }
  return digestDescriptor(IDENTITY_LABELS.CHILD_ENVELOPE, [BUFFER_FROM(canonical, 'utf8')]);
}

export function describeRunIdentityV1(manifest) {
  const snapshot = parseRunManifestV1(manifest);
  const promptDigests = [];
  for (let index = 0; index < snapshot.assignments.length; index += 1) {
    const assignment = snapshot.assignments[index];
    promptDigests[index] = capturedFreeze({
      assignment_id: assignment.assignment_id,
      digest: promptDigestFromSnapshot(snapshot, assignment.assignment_id).digest,
    });
  }
  return capturedFreeze({
    run_id: snapshot.run_id,
    assignment_count: snapshot.assignments.length,
    repository: capturedFreeze({
      path: snapshot.repository.path,
      base_sha: snapshot.repository.base_sha,
    }),
    manifest_digest: runManifestDigestV1(snapshot),
    assignment_prompt_digests: capturedFreeze(promptDigests),
  });
}
