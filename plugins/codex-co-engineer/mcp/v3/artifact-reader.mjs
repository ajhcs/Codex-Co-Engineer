// Bounded sanitized artifact reader (ADR 0001 identifiers
// `bounded_evidence`, `sanitized_bounded_evidence_model_facing`,
// Gate A `gate_a_valid_raw_and_sanitized_artifacts`).
//
// Additive v3 module for R1-P10. It is the model-facing contract over the
// P08 store's serialized sanitized range-read hook:
//
//   1. Accept only an exact validated sanitized ArtifactRefV1. Raw refs
//      are denied before any store I/O.
//   2. Validate bounded intrinsic integer offset/range options against
//      fixed range and wire/response caps.
//   3. In one serialized store operation, no-follow open the regular
//      single-link artifact, re-validate sidecar/ref/identity/size/digest,
//      hash the whole file in fixed chunks while retaining only the
//      requested bounded range, and prove before/after stability.
//   4. Return frozen detached JSON-safe metadata plus the bounded
//      selected window as base64. Never expose raw evidence, store roots,
//      paths, OS errors, or a whole-file buffer.
//   5. Distinguish reader/wire clipping from upstream sanitizer
//      truncation. Until P09 provenance exists, source size, redaction
//      count, sanitizer version, and completeness are unknown — never
//      false and never invented as zero.
//
// This module performs no sanitization and does not import P09 internals.
// It reads P08-published sanitized artifacts only.
//
// Out of scope: P09 sanitizer provenance, MCP registration, provider
// sinks, cleanup, supervisor/server wiring, ArtifactRef schema changes,
// and P11/P12.

import { Buffer as NodeBuffer } from 'node:buffer';

import {
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
  artifactRefDigestV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  ARTIFACT_STORE_RANGE_READ_MAX_BYTES,
  ARTIFACT_STORE_SCHEMA_ID,
  readStoredSanitizedRangeV1,
} from './artifact-store.mjs';
import {
  capturedFreeze,
} from './grammar.mjs';
import { assertAllowedKeys } from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  optOwn,
} from './selection-json.mjs';

export const ARTIFACT_READER_SCHEMA_ID = 'codex-co-engineer.artifact-reader.v1';

export const ARTIFACT_READER_MAX_RANGE_BYTES = ARTIFACT_STORE_RANGE_READ_MAX_BYTES;
// Serialized JSON of one reader page, including selected content, must fit.
export const ARTIFACT_READER_MAX_WIRE_BYTES = 12_288;

export const ARTIFACT_READER_OPTION_KEYS = capturedFreeze(['offset', 'max_bytes']);

export const ARTIFACT_READER_PAGE_KEYS = capturedFreeze([
  'schema',
  'artifact_ref',
  'namespace',
  'byte_length',
  'sha256',
  'ref_digest',
  'offset',
  'max_bytes',
  'selected_byte_length',
  'selected_encoding',
  'selected_content',
  'reader_clipped',
  'more',
  'next_offset',
  'source_byte_length',
  'redaction_count',
  'sanitizer_version',
  'complete',
  'upstream_truncated',
]);

export const ARTIFACT_READER_ERROR_CODES = capturedFreeze([
  'raw_artifact_denied',
  'invalid_type',
  'invalid_format',
  'out_of_range',
  'unknown_key',
  'missing_key',
]);

const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const STRING = String;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const BUFFER_TO_STRING = NodeBuffer.prototype.toString;
const JSON_STRINGIFY = JSON.stringify;
const MATH_CEIL = Math.ceil;
const REFLECT_APPLY = Reflect.apply;

function diagnostic(message) {
  const text = STRING(message ?? '');
  return text.length <= 200 ? text : text.slice(0, 200);
}

function failReader(code, field, message) {
  fail(code, field, diagnostic(message));
}

function assertIntrinsicNonNegativeInteger(value, field, min, max) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value)) {
    failReader('invalid_type', field, `${field} must be an intrinsic safe integer.`);
  }
  if (value < min || value > max) {
    failReader('out_of_range', field, `${field} must be an integer in ${min}..${max}.`);
  }
  return value;
}

function parseSanitizedRef(refInput) {
  const snapshot = parseArtifactRefV1(refInput, 'artifact_ref');
  if (snapshot.artifact_class !== 'sanitized') {
    failReader('raw_artifact_denied', 'artifact_ref.artifact_class',
      'The bounded reader accepts only sanitized ArtifactRefV1 values; raw evidence is owner-only and is not read.');
  }
  return snapshot;
}

export function parseSanitizedReaderOptionsV1(input, path = 'options') {
  if (input === undefined) {
    return capturedFreeze({
      offset: 0,
      max_bytes: ARTIFACT_READER_MAX_RANGE_BYTES,
    });
  }
  assertPlainObject(input, 'invalid_type', path, 'Reader options');
  assertDirectJsonClosure(input, path);
  assertAllowedKeys(input, ARTIFACT_READER_OPTION_KEYS, path);
  let offset = 0;
  if (hasOwn(input, 'offset')) {
    offset = assertIntrinsicNonNegativeInteger(
      optOwn(input, 'offset'), `${path}.offset`, 0, MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
    );
  }
  let maxBytes = ARTIFACT_READER_MAX_RANGE_BYTES;
  if (hasOwn(input, 'max_bytes')) {
    maxBytes = assertIntrinsicNonNegativeInteger(
      optOwn(input, 'max_bytes'), `${path}.max_bytes`, 0, ARTIFACT_READER_MAX_RANGE_BYTES,
    );
  }
  return capturedFreeze({ offset, max_bytes: maxBytes });
}

function encodeSelected(bytes) {
  return REFLECT_APPLY(BUFFER_TO_STRING, bytes, ['base64']);
}

function decodeSelected(encoded) {
  return BUFFER_FROM(encoded, 'base64');
}

function requestedTake(range, options) {
  const remaining = range.byte_length - range.offset;
  return options.max_bytes < remaining ? options.max_bytes : remaining;
}

function buildPage(range, options, selectedBytes) {
  const selectedLength = selectedBytes.byteLength;
  const end = range.offset + selectedLength;
  const more = end < range.byte_length;
  const clipped = selectedLength < requestedTake(range, options);
  return freezeData({
    schema: ARTIFACT_READER_SCHEMA_ID,
    artifact_ref: range.artifact_ref,
    namespace: 'sanitized',
    byte_length: range.byte_length,
    sha256: range.sha256,
    ref_digest: artifactRefDigestV1(range.artifact_ref, 'artifact_ref').digest,
    offset: range.offset,
    max_bytes: options.max_bytes,
    selected_byte_length: selectedLength,
    selected_encoding: 'base64',
    selected_content: encodeSelected(selectedBytes),
    reader_clipped: clipped === true,
    more: more === true,
    next_offset: more ? end : null,
    source_byte_length: null,
    redaction_count: null,
    sanitizer_version: null,
    complete: null,
    upstream_truncated: null,
  });
}

function fitToWireCap(range, options) {
  let selected = decodeSelected(range.selected_content);
  if (selected.byteLength !== range.selected_byte_length) {
    failReader('invalid_format', 'selected_content',
      'The range primitive returned a selected window whose encoding did not round-trip.');
  }
  while (true) {
    const page = buildPage(range, options, selected);
    const wire = BUFFER_BYTE_LENGTH(JSON_STRINGIFY(page), 'utf8');
    if (wire <= ARTIFACT_READER_MAX_WIRE_BYTES) return page;
    if (selected.byteLength === 0) {
      failReader('out_of_range', 'options',
        'The reader response exceeds the wire cap even with no selected content.');
    }
    const over = wire - ARTIFACT_READER_MAX_WIRE_BYTES;
    let shrink = MATH_CEIL((over * 3) / 4);
    if (shrink < 1) shrink = 1;
    if (shrink > selected.byteLength) shrink = selected.byteLength;
    selected = selected.subarray(0, selected.byteLength - shrink);
  }
}

function assertStoreHandle(store) {
  assertPlainObject(store, 'invalid_type', 'store', 'The artifact store handle');
  if (store.schema !== ARTIFACT_STORE_SCHEMA_ID || typeof store.internalOperate !== 'function') {
    failReader('invalid_type', 'store', 'The artifact store handle was not produced by the artifact store.');
  }
  return store;
}

export async function readSanitizedArtifactV1(store, refInput, options) {
  assertStoreHandle(store);
  const snapshot = parseSanitizedRef(refInput);
  const parsedOptions = parseSanitizedReaderOptionsV1(options);
  const range = await readStoredSanitizedRangeV1(
    store, snapshot, parsedOptions.offset, parsedOptions.max_bytes,
  );
  return fitToWireCap(range, parsedOptions);
}

capturedFreeze(parseSanitizedReaderOptionsV1);
capturedFreeze(readSanitizedArtifactV1);
