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
//      fixed range and (later) wire caps.
//   3. In one serialized store operation, no-follow open the regular
//      single-link artifact, re-validate sidecar/ref/identity/size/digest,
//      hash the whole file in fixed chunks while retaining only the
//      requested bounded range, and prove before/after stability.
//   4. Return frozen detached JSON-safe metadata plus the bounded
//      selected window as base64. Never expose raw evidence, store roots,
//      paths, OS errors, or a whole-file buffer.
//
// This module performs no sanitization and does not import P09 internals.
// It reads P08-published sanitized artifacts only.
//
// Out of scope: P09 sanitizer provenance, MCP registration, provider
// sinks, cleanup, supervisor/server wiring, ArtifactRef schema changes,
// and P11/P12.

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

export const ARTIFACT_READER_OPTION_KEYS = capturedFreeze(['offset', 'max_bytes']);

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

function pageFromRange(range, options) {
  return freezeData({
    schema: ARTIFACT_READER_SCHEMA_ID,
    artifact_ref: range.artifact_ref,
    namespace: 'sanitized',
    byte_length: range.byte_length,
    sha256: range.sha256,
    ref_digest: artifactRefDigestV1(range.artifact_ref, 'artifact_ref').digest,
    offset: range.offset,
    max_bytes: options.max_bytes,
    selected_byte_length: range.selected_byte_length,
    selected_encoding: 'base64',
    selected_content: range.selected_content,
  });
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
  return pageFromRange(range, parsedOptions);
}

capturedFreeze(parseSanitizedReaderOptionsV1);
capturedFreeze(readSanitizedArtifactV1);
