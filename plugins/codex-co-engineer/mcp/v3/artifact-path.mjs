// ArtifactRelativePathV1 — strict portable relative artifact path policy
// (ADR 0001 identifiers `bounded_evidence`,
// `gate_a_valid_raw_and_sanitized_artifacts`, `exact_identities`).
//
// Additive v3 module for W3-P07. It owns exactly one question, answered
// deterministically and fail closed: is this string a strict portable
// run-relative artifact path? It answers nothing else: it never touches the
// filesystem, network, or process state, and it does NOT claim that artifact
// storage exists. The P08 store, sanitizer/reader, and evidence bundle are
// separate later surfaces; producers declare paths here and only a later
// storage authority may bind them to bytes.
//
// Accepted grammar — POSIX-style, forward-slash separated, case-sensitive,
// NFC-normalized UTF-8, relative and canonical by construction:
//   - 1..ARTIFACT_PATH_MAX_SEGMENTS segments of 1..ARTIFACT_PATH_SEGMENT_MAX_BYTES
//     each, total UTF-8 length 1..ARTIFACT_PATH_MAX_BYTES;
//   - every segment non-empty and not made only of dots, so '.', '..' and
//     '...' style traversal aliases cannot be spelled at all;
//   - no backslash anywhere; no leading, trailing, or doubled '/';
//   - no ':' anywhere, which forecloses drive forms (`C:`), drive-relative
//     spellings, NTFS alternate data streams (`file:ads`), and scheme tricks
//     (`file:`) under one deterministic rule;
//   - no Windows reserved device name as a segment stem (case-insensitive
//     ASCII fold, extension ignored: `con`, `CON.txt`, `com1`, `lpt0`,
//     `clock$` are rejected; whole stems like
//     `concat`, `nullify`, and `auxiliary` are ordinary names and stay
//     accepted);
//   - no leading or trailing ASCII space and no trailing dot in a segment,
//     which Windows tooling silently strips;
//   - well-formed Unicode only (lone surrogates rejected) and exactly NFC:
//     canonically equivalent but differently composed names are distinct
//     byte strings, so the policy refuses to choose between them;
//   - no C0/C1 control characters (NUL included), no invisible/format/
//     bidi-override/line-separator/tag code points, and no solidus
//     look-alikes that render as separators a kernel will not see.
//
// Fixed validation pipeline: identical inputs always raise the identical
// first typed error, independent of how many rules they violate. The order
// is: type, empty, lone surrogates, total byte bound, NFC, backslash,
// leading slash, trailing slash, per-segment structure (count, empty,
// dot-only alias, reserved device stem, edge space/dot, segment bytes),
// then the whole-path character scan, which reports the FIRST offending
// code point in strict left-to-right order across the control,
// invisible/format, separator look-alike, and colon classes. Rejections
// carry stable codes from the closed
// ARTIFACT_RELATIVE_PATH_ERROR_CODES vocabulary and never echo the hostile
// character itself, only its U+ notation and offset.
//
// Intrinsic hardening: every dynamic surface used after caller input exists
// is captured once at clean import. String scanning is a manual indexed walk
// (captured codePointAt/charCodeAt/normalize/split/startsWith/endsWith), so
// a post-import patch of String iteration, RegExp, Array methods, or
// Buffer.byteLength can neither alter acceptance nor execute caller code.

import { Buffer as NodeBuffer } from 'node:buffer';

import {
  capturedFreeze,
  capturedUtf8ByteLength,
} from './grammar.mjs';
import { RunContractV1Error } from './run-manifest.mjs';

export const ARTIFACT_PATH_POLICY_ID = 'codex-co-engineer.artifact-path.v1';

export const ARTIFACT_PATH_MAX_BYTES = 1024;
export const ARTIFACT_PATH_MAX_SEGMENTS = 16;
export const ARTIFACT_PATH_SEGMENT_MAX_BYTES = 128;

export const ARTIFACT_RELATIVE_PATH_ERROR_CODES = capturedFreeze([
  'absolute_path_denied',
  'alias_segment_denied',
  'colon_denied',
  'control_character_denied',
  'edge_character_denied',
  'empty_path',
  'empty_segment_denied',
  'invalid_encoding',
  'invalid_separator',
  'invalid_type',
  'invisible_character_denied',
  'out_of_range',
  'reserved_device_name_denied',
  'segment_count_exceeded',
  'segment_too_long',
  'separator_lookalike_denied',
  'trailing_slash_denied',
]);

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

// ---- Captured intrinsics, taken exactly once at initialization. -----------
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const FUNCTION_CALL = Function.prototype.call;
const callBound = (method) => FUNCTION_CALL.bind(method);
const STRING_CHAR_CODE_AT = callBound(String.prototype.charCodeAt);
const STRING_CODE_POINT_AT = callBound(String.prototype.codePointAt);
const STRING_NORMALIZE = callBound(String.prototype.normalize);
const STRING_SPLIT = callBound(String.prototype.split);
const STRING_STARTS_WITH = callBound(String.prototype.startsWith);
const STRING_ENDS_WITH = callBound(String.prototype.endsWith);
const STRING_FROM_CODE_POINT = String.fromCodePoint;
const STRING = String;

const SEGMENT_SEPARATOR = '/';
const EMPTY_STRING = '';
const FULL_STOP = '.';
const SPACE = ' ';
const BACKSLASH_CODE_POINT = 0x5c;
const COLON_CODE_POINT = 0x3a;
const FULL_STOP_CODE_POINT = 0x2e;
const SPACE_CODE_POINT = 0x20;

// Closed invisible/format/bidi/line-separator/tag ranges. Anything here can
// change how a path renders or resolves while surviving casual review, so it
// is refused outright instead of being interpreted.
const INVISIBLE_RANGES = capturedFreeze([
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width series and LRM/RLM
  [0x2028, 0x202e], // line/paragraph separators and bidi overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xfff9, 0xfffb], // interlinear annotation anchors
  [0x1d173, 0x1d17a], // musical formatting controls
  [0xe0001, 0xe0001], // language tag
  [0xe0020, 0xe007f], // tag characters
]);

// Solidus look-alikes: code points that display as slashes or backslashes on
// common platforms while remaining ordinary letters to a POSIX kernel, so a
// reviewer sees more separators than the resolver does.
const SEPARATOR_LOOKALIKES = capturedFreeze([
  0x2044, // fraction slash
  0x2215, // division slash
  0x27cb, // mathematical rising diagonal
  0x27cd, // mathematical falling diagonal
  0x29f8, // big solidus
  0xfe68, // small reverse solidus
  0xff0f, // fullwidth solidus
  0xff3c, // fullwidth reverse solidus
]);

// Windows reserved device names, compared case-insensitively against the
// stem before the first dot so `CON.txt` is caught exactly like `CON`.
const RESERVED_DEVICE_STEMS = capturedFreeze((() => {
  const stems = ['AUX', 'CLOCK$', 'CON', 'NUL', 'PRN'];
  for (let digit = 0; digit <= 9; digit += 1) {
    const suffix = STRING(digit);
    stems.push(`COM${suffix}`, `LPT${suffix}`);
  }
  return stems.sort();
})());

function asciiUpperFold(text) {
  let folded = EMPTY_STRING;
  for (let index = 0; index < text.length; index += 1) {
    const unit = STRING_CHAR_CODE_AT(text, index);
    folded += unit >= 0x61 && unit <= 0x7a
      ? STRING_FROM_CODE_POINT(unit - 0x20)
      : text[index];
  }
  return folded;
}

function deviceStemOf(segment) {
  const dot = segment.indexOf(FULL_STOP);
  const stem = dot === -1 ? segment : segment.slice(0, dot);
  if (stem.length === 0) return null;
  const folded = asciiUpperFold(stem);
  for (let index = 0; index < RESERVED_DEVICE_STEMS.length; index += 1) {
    if (RESERVED_DEVICE_STEMS[index] === folded) return folded;
  }
  return null;
}

function isDotOnlySegment(segment) {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] !== FULL_STOP) return false;
  }
  return segment.length > 0;
}

function containsBackslash(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (STRING_CHAR_CODE_AT(value, index) === BACKSLASH_CODE_POINT) return true;
  }
  return false;
}

function assertWellFormed(value, path) {
  // Walk code points, not code units: every astral character is two UTF-16
  // code units and both units live in the surrogate block, so a naive
  // unit scan would condemn perfectly well-formed emoji or CJK extensions.
  // Only an unpaired surrogate (which codePointAt reports as itself) fails.
  let index = 0;
  while (index < value.length) {
    const codePoint = STRING_CODE_POINT_AT(value, index);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      fail('invalid_encoding', path,
        `${path} contains a lone surrogate at code-unit index ${index}; `
        + 'artifact paths must be well-formed Unicode.');
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
}

function assertTotalBytes(value, path) {
  const bytes = capturedUtf8ByteLength(value);
  if (bytes < 1 || bytes > ARTIFACT_PATH_MAX_BYTES) {
    fail('out_of_range', path,
      `${path} is ${bytes} UTF-8 bytes; allowed range is 1..${ARTIFACT_PATH_MAX_BYTES}.`);
  }
  return bytes;
}

function assertNormalized(value, path) {
  if (STRING_NORMALIZE(value, 'NFC') !== value) {
    fail('invalid_encoding', path, `${path} is not NFC-normalized; artifact paths must use exactly NFC.`);
  }
}

function assertSlashShape(value, path) {
  if (containsBackslash(value)) {
    fail('invalid_separator', path,
      `${path} must use '${SEGMENT_SEPARATOR}' separators; a backslash is not portable.`);
  }
  if (STRING_STARTS_WITH(value, SEGMENT_SEPARATOR)) {
    fail('absolute_path_denied', path,
      `${path} must be relative to the run's artifact root; absolute paths are denied.`);
  }
  if (STRING_ENDS_WITH(value, SEGMENT_SEPARATOR)) {
    fail('trailing_slash_denied', path,
      `${path} must name an artifact, not end with '${SEGMENT_SEPARATOR}'.`);
  }
}

function assertSegmentStructure(segments, path) {
  if (segments.length > ARTIFACT_PATH_MAX_SEGMENTS) {
    fail('segment_count_exceeded', path,
      `${path} spans ${segments.length} segments; at most ${ARTIFACT_PATH_MAX_SEGMENTS} are allowed.`);
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0) {
      fail('empty_segment_denied', path, `${path} contains an empty segment at position ${index}.`);
    }
    if (isDotOnlySegment(segment)) {
      fail('alias_segment_denied', path,
        `${path} segment ${index} is made only of dots; '.' and '..' style aliases are denied.`);
    }
    const reserved = deviceStemOf(segment);
    if (reserved !== null) {
      fail('reserved_device_name_denied', path,
        `${path} segment ${index} uses reserved device name ${reserved}; device names are denied.`);
    }
    const last = segment.length - 1;
    if (STRING_CHAR_CODE_AT(segment, last) === FULL_STOP_CODE_POINT
      || STRING_CHAR_CODE_AT(segment, last) === SPACE_CODE_POINT
      || STRING_CHAR_CODE_AT(segment, 0) === SPACE_CODE_POINT) {
      fail('edge_character_denied', path,
        `${path} segment ${index} has a leading space or a trailing dot/space that Windows tooling strips.`);
    }
    if (BUFFER_BYTE_LENGTH(segment, 'utf8') > ARTIFACT_PATH_SEGMENT_MAX_BYTES) {
      fail('segment_too_long', path,
        `${path} segment ${index} exceeds ${ARTIFACT_PATH_SEGMENT_MAX_BYTES} UTF-8 bytes.`);
    }
  }
}

function codePointInRanges(codePoint, ranges) {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (codePoint >= range[0] && codePoint <= range[1]) return true;
  }
  return false;
}

function listContainsCodePoint(list, codePoint) {
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === codePoint) return true;
  }
  return false;
}

function uNotation(codePoint) {
  return `U+${codePoint.toString(16).padStart(4, '0')}`;
}

function assertCharacterLegality(value, path) {
  let offset = 0;
  while (offset < value.length) {
    const codePoint = STRING_CODE_POINT_AT(value, offset);
    const width = codePoint > 0xffff ? 2 : 1;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      fail('control_character_denied', path,
        `${path} contains control character ${uNotation(codePoint)} at code-point offset ${offset}.`);
    }
    if (codePointInRanges(codePoint, INVISIBLE_RANGES)) {
      fail('invisible_character_denied', path,
        `${path} contains invisible formatting character ${uNotation(codePoint)} at code-point offset ${offset}.`);
    }
    if (listContainsCodePoint(SEPARATOR_LOOKALIKES, codePoint)) {
      fail('separator_lookalike_denied', path,
        `${path} contains solidus look-alike ${uNotation(codePoint)} at code-point offset ${offset}.`);
    }
    if (codePoint === COLON_CODE_POINT) {
      fail('colon_denied', path,
        `${path} contains ':' at code-point offset ${offset}; colons are denied to foreclose drive, `
        + 'alternate-data-stream, and scheme spellings.');
    }
    offset += width;
  }
}

// Validate one strict portable relative artifact path and return a detached,
// frozen descriptor over the accepted canonical form. The accepted form is
// exactly the submitted string: no trimming, case folding, separator
// rewriting, or Unicode re-encoding ever occurs, so two distinct accepted
// inputs always stay distinct.
export function validateArtifactRelativePathV1(value, path = 'relative_path') {
  if (typeof value !== 'string') {
    fail('invalid_type', path, `${path} must be a string.`);
  }
  if (value.length === 0) {
    fail('empty_path', path, `${path} must not be empty.`);
  }
  assertWellFormed(value, path);
  const bytes = assertTotalBytes(value, path);
  assertNormalized(value, path);
  assertSlashShape(value, path);
  const segments = STRING_SPLIT(value, SEGMENT_SEPARATOR);
  assertSegmentStructure(segments, path);
  assertCharacterLegality(value, path);
  return capturedFreeze({
    path: value,
    segments: capturedFreeze([...segments]),
    byte_length: bytes,
    segment_count: segments.length,
  });
}

// Boolean predicate twin of the validator: never throws, never partially
// accepts, and agrees with validateArtifactRelativePathV1 on every input.
export function isArtifactRelativePathV1(value) {
  try {
    validateArtifactRelativePathV1(value, 'relative_path');
    return true;
  } catch {
    return false;
  }
}
