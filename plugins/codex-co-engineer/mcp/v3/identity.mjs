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
//   - Opaque prompt content: user prompts are hashed as exact UTF-8 bytes
//     bound to their run and assignment identity. They are never trimmed,
//     Unicode-normalized, re-encoded, or otherwise interpreted; two prompts
//     that differ by even one byte digest differently.

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  MAX_MANIFEST_DEPTH,
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
export const IDENTITY_LABEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;

export const IDENTITY_LABELS = Object.freeze({
  RUN_MANIFEST: 'run-manifest.v1',
  ASSIGNMENT_PROMPT: 'assignment-prompt.v1',
  CHILD_ENVELOPE: 'child-envelope.v1',
});

const MAX_FRAMED_INPUT_BYTES = 0xffffffff;

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

function truncateForMessage(value) {
  const text = String(value);
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

function toCanonicalBytes(value, path) {
  assertWellFormedText(value, path);
  return Buffer.from(value, 'utf8');
}

function exactJsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!exactJsonEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && exactJsonEqual(left[key], right[key]));
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
  return parts.join('');
}

function emitCanonical(parts, value, path, depth) {
  if (depth > MAX_MANIFEST_DEPTH) {
    fail('depth_exceeded', path, `${path} exceeds the maximum canonical depth of ${MAX_MANIFEST_DEPTH}.`);
  }
  if (value === null) {
    parts.push('null');
    return;
  }
  const kind = typeof value;
  if (kind === 'string') {
    assertWellFormedText(value, path);
    parts.push(JSON.stringify(value));
    return;
  }
  if (kind === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail('invalid_type', path,
        `${path} is ${truncateForMessage(value)}; canonical JSON numbers must be safe integers.`);
    }
    parts.push(String(value));
    return;
  }
  if (kind === 'boolean') {
    parts.push(value ? 'true' : 'false');
    return;
  }
  if (kind !== 'object') {
    fail('invalid_type', path,
      `${path} is not a canonical JSON value (received ${kind === 'undefined' ? 'undefined' : kind}).`);
  }
  if (Array.isArray(value)) {
    assertDenseJsonArray(value, path);
    parts.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) parts.push(',');
      emitCanonical(parts, value[index], `${path}[${index}]`, depth + 1);
    }
    parts.push(']');
    return;
  }
  const keys = Object.keys(value).sort();
  parts.push('{');
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) parts.push(',');
    assertWellFormedText(keys[index], `${path}.<key>`);
    parts.push(JSON.stringify(keys[index]), ':');
    emitCanonical(parts, value[keys[index]], `${path}.${keys[index]}`, depth + 1);
  }
  parts.push('}');
}

function framedUpdate(hash, bytes, path) {
  if (bytes.length > MAX_FRAMED_INPUT_BYTES) {
    fail('unbounded_input', path, `${path} exceeds the ${MAX_FRAMED_INPUT_BYTES}-byte framed-input bound.`);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length, 0);
  hash.update(prefix);
  hash.update(bytes);
}

function identityDigestHex(label, parts) {
  if (typeof label !== 'string' || !IDENTITY_LABEL_PATTERN.test(label)) {
    fail('invalid_format', 'label', `Identity label must match ${IDENTITY_LABEL_PATTERN.source}.`);
  }
  const hash = createHash(DIGEST_ALGORITHM);
  framedUpdate(hash, Buffer.from(IDENTITY_DOMAIN, 'utf8'), 'identity_domain');
  const version = Buffer.alloc(4);
  version.writeUInt32BE(IDENTITY_VERSION, 0);
  hash.update(version);
  framedUpdate(hash, Buffer.from(label, 'utf8'), 'identity_label');
  let inputBytes = 0;
  for (const part of parts) {
    framedUpdate(hash, part, 'identity_input');
    inputBytes += part.length;
  }
  return { digest: hash.digest('hex'), input_bytes: inputBytes };
}

function digestDescriptor(label, parts) {
  const { digest, input_bytes } = identityDigestHex(label, parts);
  return Object.freeze({
    algorithm: DIGEST_ALGORITHM,
    domain: IDENTITY_DOMAIN,
    version: IDENTITY_VERSION,
    label,
    input_bytes,
    digest,
  });
}

// Canonical validated form of one complete run manifest.
export function runManifestCanonicalJsonV1(manifest) {
  return canonicalJsonStringify(parseRunManifestV1(manifest));
}

// Stable digest of one complete run manifest over its canonical JSON form.
export function runManifestDigestV1(manifest) {
  const canonical = runManifestCanonicalJsonV1(manifest);
  return digestDescriptor(IDENTITY_LABELS.RUN_MANIFEST, [Buffer.from(canonical, 'utf8')]);
}

// Constant-time digest verification against a previously recorded hex value.
// Returns false (never throws) for malformed expectations.
export function verifyRunManifestDigestV1(manifest, expectedDigestHex) {
  if (typeof expectedDigestHex !== 'string'
    || expectedDigestHex.length !== DIGEST_HEX_LENGTH
    || !/^[0-9a-f]{64}$/u.test(expectedDigestHex)) {
    return false;
  }
  const actual = runManifestDigestV1(manifest).digest;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedDigestHex, 'hex'));
}

function promptDigestFromSnapshot(snapshot, assignmentId) {
  if (typeof assignmentId !== 'string') {
    fail('invalid_type', 'assignment_id', 'assignment_id must be the exact declared identifier string.');
  }
  const assignment = snapshot.assignments.find((entry) => entry.assignment_id === assignmentId);
  if (!assignment) {
    fail('unknown_assignment_id', 'assignments',
      `No assignment "${truncateForMessage(assignmentId)}" is declared by run "${snapshot.run_id}".`);
  }
  const parts = [
    Buffer.from(snapshot.run_id, 'utf8'),
    Buffer.from(assignmentId, 'utf8'),
    // The prompt itself stays opaque: exact validated UTF-8 bytes only.
    Buffer.from(assignment.prompt, 'utf8'),
  ];
  return digestDescriptor(IDENTITY_LABELS.ASSIGNMENT_PROMPT, parts);
}

// Stable per-child prompt digest bound to its run and assignment identity.
export function assignmentPromptDigestV1(manifest, assignmentId) {
  return promptDigestFromSnapshot(parseRunManifestV1(manifest), assignmentId);
}

// Stable digest of one compiled child envelope over its canonical form.
export function childEnvelopeDigestV1(envelope) {
  if (!isPlainObject(envelope)) fail('invalid_type', 'envelope', 'A child envelope must be a JSON object.');
  // Inspect the complete direct-JavaScript data graph before reading even one
  // caller property. This rejects accessors, symbols, hidden keys, exotic
  // prototypes, sparse arrays, aliases, and cycles without invoking getters.
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
  // The structured form is never trusted on its own: envelope_text is parsed
  // strictly, the supplied envelope must exactly match the complete parsed
  // canonical shape (closed keys, IDs, nested acceptance, framing offsets,
  // byte length), and the digest is then taken over that validated parsed
  // form. Exact structural comparison distinguishes negative zero from zero
  // before canonical JSON intentionally normalizes that spelling, while
  // remaining indifferent to caller key order. identity.mjs -> prompt-compiler.mjs is
  // the only direction of this dependency; no import cycle exists.
  const parsed = parseChildEnvelopeV1(envelope.envelope_text);
  const canonical = canonicalJsonStringify(parsed);
  if (!exactJsonEqual(envelope, parsed)) {
    fail('envelope_shape_mismatch', 'envelope',
      'Supplied child envelope does not exactly match the strict parse of its own envelope_text.');
  }
  return digestDescriptor(IDENTITY_LABELS.CHILD_ENVELOPE, [Buffer.from(canonical, 'utf8')]);
}

// One bounded, order-stable identity record for a run: the manifest digest
// plus every child prompt digest in manifest order.
export function describeRunIdentityV1(manifest) {
  const snapshot = parseRunManifestV1(manifest);
  const promptDigests = snapshot.assignments.map((assignment) => Object.freeze({
    assignment_id: assignment.assignment_id,
    digest: promptDigestFromSnapshot(snapshot, assignment.assignment_id).digest,
  }));
  return Object.freeze({
    run_id: snapshot.run_id,
    assignment_count: snapshot.assignments.length,
    repository: Object.freeze({
      path: snapshot.repository.path,
      base_sha: snapshot.repository.base_sha,
    }),
    manifest_digest: runManifestDigestV1(snapshot),
    assignment_prompt_digests: Object.freeze(promptDigests),
  });
}
