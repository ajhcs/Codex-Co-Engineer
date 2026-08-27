// RepoPathMatcherV1 — repository path-matching authority (R1 P02R2 + P02R9).
//
// Answers exactly one question, deterministically and fail closed: does a
// normalized NFC UTF-8 POSIX repository-relative path belong to a repository
// glob pattern? Additive v3 module: imports nothing from the run-manifest
// envelope and edits no existing runtime surface.
//
// Frozen grammar — identical in the ingress (validation) and matching
// directions because both run through one shared validation core, so the two
// directions can never drift apart:
//   - literals: any permitted NFC Unicode code point, case-sensitive;
//     '{' , '}' , ',' and '|' are ordinary literals — brace expansion and
//     alternation do not exist anywhere;
//   - '*' (zero or more code points) and '?' (exactly one code point,
//     astral characters counted once) inside a segment;
//   - '[abc]' / '[a-z0-9_-]': one code point from an explicit closed
//     positive set; ranges are code-point ranges;
//   - '**' is only legal as a whole segment (zero or more whole segments).
// Rejected before any matching work (fail closed): escapes ('\'), the extglob
// opener sequences '@(' '+(' '!(' '?(' '*(', negated classes ('[!..]',
// '[^..]'), embedded double stars ('a**b'), empty ('[]') and unclosed
// ('[ab') classes, reversed or degenerate ranges ('[9-0]', '[a-a]'), '.',
// '..', empty segments, and non-NFC text.
//
// Compiled authority is opaque and provenance-only: compileRepoGlob returns a
// frozen two-primitive handle whose id and pattern are inert documentation.
// The only authority lives in a module-private WeakMap mapping that exact
// object identity to deeply frozen detached intermediate representation.
// Matching never rereads the public fields at all: irOf() consults only the
// WeakMap after a proxy rejection, so copied, serialized, subclassed, leaked
// or getter-backed lookalike shapes confer no authority, mutation of a real
// handle's public fields can neither drive nor disturb matching, and no
// IR/segment/atom/single/range internal is exposed or reachable.
//
// Intrinsic hardening: every dynamic built-in the module needs is captured
// once at initialization, before any caller input exists. Prototype methods
// are materialized as bound functions through captured Reflect.apply +
// Function.prototype.bind/#call, so nothing below the capture block ever
// looks a method up dynamically. Surfaces whose captured form would still
// dispatch into mutable intrinsics are replaced with closed manual logic:
// String#split/includes/startsWith/endsWith (one structural scan),
// for..of/string iteration (manual UTF-16 surrogate pairing), RegExp test on
// labels (printable-ASCII scan), Set membership (class members are frozen
// arrays scanned by index), Array#push/map/fill (indexed assignment and
// fresh rows). A post-import patch of Object reflection/freezing,
// Array checks or methods, String scanning/normalization/iteration,
// RegExp test/exec, Map/Set/WeakMap methods, Uint8Array, Buffer.byteLength,
// Reflect.apply, or Function#call/#bind therefore neither alters acceptance,
// executes caller code, relaxes bounds, nor exposes private authority.
//
// Bounded work, charged honestly: ingress validation is bounded by the
// fixed pattern, path, and batch caps and is not match-matrix work.
// Match-matrix work is bounded twice over — once per single call against
// GLOB_MATCH_STEP_BUDGET and once per batch as an aggregate product
// rejected before any match-matrix DP. Both charges are computed from the
// private IR BEFORE any matching runs, and both charge character-class
// internals: every single adds 1 step and every range adds 2, so
// range-heavy patterns pay for the membership scans they cause and
// hostile range-count/work amplification is rejected deterministically
// instead of hiding behind a naive atom count.
//
// Algorithm: bounded dynamic programming twice over — (pattern-segment x
// path-segment) pairs, then (atom x code point) pairs with correctly seeded
// star transitions. No regular expression is compiled from caller input and
// there is no recursion.
//
// Separation of authorities: deliberately independent of the conservative
// ASCII-case-folded writer-overlap safety check exported by run-manifest.mjs
// (`scopeStaticPrefix` / `writerScopesOverlap`). That check over-approximates
// dispatch-time overlap; it is neither imported nor weakened here. P02
// cardinality and role constraints stay entirely in their own surfaces.

import { Buffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';

export const REPO_PATH_MATCHER_ID = 'codex-co-engineer.repo-path-matcher.v1';

// Bounds mirror the R1 repository-path validator and the R1 write-scope glob
// limits so every manifest-accepted scope pattern stays inside the matchable
// envelope. GLOB_MATCH_STEP_BUDGET sits far above the largest charged
// single-path product the caps allow and is defense in depth for that
// matrix; a legal-cap aggregate batch product can exceed it and is rejected
// before match-matrix DP rather than matched unbounded.
export const REPO_PATH_MAX_BYTES = 4096;
export const REPO_PATH_MAX_SEGMENTS = 64;
export const REPO_PATH_SEGMENT_MAX_BYTES = 255;
export const REPO_PATH_BATCH_MAX = 1024;
export const GLOB_PATTERN_MAX_BYTES = 256;
export const GLOB_PATTERN_MAX_SEGMENTS = 16;
export const GLOB_PATTERN_SEGMENT_MAX_BYTES = 128;
export const GLOB_MATCH_STEP_BUDGET = 67_108_864;

// Stable typed-error vocabulary. Validation runs through one fixed shared
// pipeline, so identical inputs always raise the identical first code,
// location, and message — in both the ingress and matching directions.
export const REPO_PATH_MATCHER_ERROR_CODES = Object.freeze([
  'invalid_array',
  'invalid_format',
  'invalid_type',
  'match_work_exceeded',
  'out_of_range',
  'pattern_class_negation',
  'pattern_double_star',
  'pattern_empty_class',
  'pattern_extglob',
  'pattern_reversed_range',
  'pattern_unclosed_class',
]);

export class RepoPathMatcherError extends Error {
  constructor(code, location, message) {
    super(message);
    // Own data properties are installed with the captured defineProperty so a
    // hostile accessor planted on a prototype can neither observe nor replace
    // them; plain assignment would dispatch inherited setters.
    objectDefineProperty(this, 'name', {
      value: 'RepoPathMatcherError', enumerable: true, writable: true, configurable: true,
    });
    objectDefineProperty(this, 'code', {
      value: code, enumerable: true, writable: true, configurable: true,
    });
    objectDefineProperty(this, 'location', {
      value: location, enumerable: true, writable: true, configurable: true,
    });
  }
}

function fail(code, location, message) {
  throw new RepoPathMatcherError(code, location, message);
}

// ---- Captured intrinsics, taken exactly once at initialization. -----------
// Nothing below this block resolves a dynamic surface: prototype methods are
// bound through captured Reflect.apply + Function.prototype machinery, and
// statics are held directly.
const { apply: reflectApply } = Reflect;
const { bind: functionProtoBind, call: functionProtoCall } = Function.prototype;
// callBound(fn) yields g(thisArg, ...args) === fn.call(thisArg, ...args)
// without any later lookup of call/bind/apply on any prototype.
const callBound = (fn) => reflectApply(functionProtoBind, functionProtoCall, [fn]);
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const arrayProto = Array.prototype;
const arrayIsArray = Array.isArray;
const weakMapGet = callBound(WeakMap.prototype.get);
const weakMapSet = callBound(WeakMap.prototype.set);
const stringCharCodeAt = callBound(String.prototype.charCodeAt);
const stringNormalize = callBound(String.prototype.normalize);
const stringSlice = callBound(String.prototype.slice);
const utf8ByteLengthOf = Buffer.byteLength;
const utilIsProxy = utilTypes.isProxy;
const SafeUint8Array = Uint8Array;

// Labels become error locations, so they follow a fixed <=128-byte printable
// ASCII grammar and anything else collapses to a constant fallback. Errors
// therefore stay bounded and never reflect hostile labels, values, code
// points, or ranges. Manual scan: no RegExp is consulted, so a patch of
// RegExp.prototype.test/exec cannot observe or alter classification.
function guardLabel(label, fallback) {
  if (typeof label !== 'string' || label.length > 128) return fallback;
  for (let i = 0; i < label.length; i += 1) {
    const unit = stringCharCodeAt(label, i);
    if (unit < 0x20 || unit > 0x7e) return fallback;
  }
  return label;
}

export function utf8ByteLength(text) {
  if (typeof text !== 'string') {
    fail('invalid_type', 'utf8ByteLength', 'utf8ByteLength input must be a string.');
  }
  return utf8ByteLengthOf(text, 'utf8');
}

const STAR = 0x2a;
const QUESTION_MARK = 0x3f;
const LEFT_PARENTHESIS = 0x28;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const EXCLAMATION_MARK = 0x21;
const COMMERCIAL_AT = 0x40;
const PLUS_SIGN = 0x2b;
const CIRCUMFLEX_ACCENT = 0x5e;
const RANGE_DASH = 0x2d;
const SOLIDUS = 0x2f;
const FULL_STOP = 0x2e;
const REVERSE_SOLIDUS = 0x5c;

function isForbiddenCodePoint(cp) {
  return (cp >= 0xd800 && cp <= 0xdfff) // lone surrogates: never valid UTF-8
    || cp < 0x20 // C0 controls, including NUL
    || (cp >= 0x7f && cp <= 0x9f) // DEL and C1 controls
    || (cp >= 0x202a && cp <= 0x202e) // bidi embeddings/overrides
    || (cp >= 0x2066 && cp <= 0x2069); // bidi isolates
}

// Manual UTF-16 -> code-point expansion with standard surrogate pairing.
// Replaces string iteration (for..of / spread), whose iterator is a mutable
// prototype surface. Lone surrogates pass through verbatim here and are
// rejected by the forbidden-code-point scan, preserving typed errors.
function codePointsBetween(text, start, end, cps) {
  let i = start;
  while (i < end) {
    const unit = stringCharCodeAt(text, i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < end) {
      const low = stringCharCodeAt(text, i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cps[cps.length] = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        i += 2;
        continue;
      }
    }
    cps[cps.length] = unit;
    i += 1;
  }
  return cps;
}

// Closed structural scan replacing split/includes/startsWith/endsWith: one
// pass over UTF-16 units records backslash hits plus the [start, end) offsets
// of every segment between solidus separators.
function scanStructure(text, length, offsets) {
  let sawBackslash = false;
  let start = 0;
  for (let i = 0; i < length; i += 1) {
    const unit = stringCharCodeAt(text, i);
    if (unit === REVERSE_SOLIDUS) sawBackslash = true;
    if (unit === SOLIDUS) {
      offsets[offsets.length] = start;
      offsets[offsets.length] = i;
      start = i + 1;
    }
  }
  offsets[offsets.length] = start;
  offsets[offsets.length] = length;
  return {
    sawBackslash,
    leadsWithSolidus: length > 0 && stringCharCodeAt(text, 0) === SOLIDUS,
    endsWithSolidus: length > 0 && stringCharCodeAt(text, length - 1) === SOLIDUS,
  };
}

// ---- One shared validation core: the grammar parity guarantee. ------------
// assertRepoRelativePath (ingress direction), compileRepoGlob (compilation)
// and pathToCodePointSegments (matching direction) all consume this exact
// pipeline, so the two directions cannot drift apart — including Unicode/NFC
// handling and literal braces/pipes. `kind` only selects the fixed noun and
// escape sentence; order, codes, and locations are identical everywhere.
function assertValidatedOffsets(value, location, caps, kind) {
  if (typeof value !== 'string') {
    fail('invalid_type', location,
      kind === 'pattern'
        ? `${location} must be a string repository glob.`
        : `${location} must be a string repository-relative path.`);
  }
  const length = value.length; // own instance property, not a prototype surface
  if (length > caps.maxBytes) {
    fail('out_of_range', location,
      `${location} exceeds the ${caps.maxBytes}-byte ${kind} limit.`);
  }
  if (length === 0) {
    fail('invalid_format', location, `${location} must not be empty.`);
  }
  const offsets = [];
  const structure = scanStructure(value, length, offsets);
  if (structure.sawBackslash) {
    fail('invalid_format', location,
      kind === 'pattern'
        ? `${location} uses '\\'; escapes are not part of the grammar and are rejected.`
        : `${location} must use POSIX '/' separators; '\\' is rejected.`);
  }
  if (structure.leadsWithSolidus) {
    fail('invalid_format', location, `${location} must be relative; a leading '/' is rejected.`);
  }
  if (structure.endsWithSolidus) {
    fail('invalid_format', location, `${location} must not end with '/'.`);
  }
  if (utf8ByteLengthOf(value, 'utf8') > caps.maxBytes) {
    fail('out_of_range', location,
      `${location} exceeds the ${caps.maxBytes}-byte ${kind} limit.`);
  }
  if (offsets.length / 2 > caps.maxSegments) {
    fail('out_of_range', location,
      `${location} exceeds the ${caps.maxSegments}-segment ${kind} limit.`);
  }
  return offsets;
}

// Per-segment pipeline order is fixed everywhere: O(1) unit-length cap, byte
// bound, structural aliases, character scan, NFC. The first failure wins,
// which is what makes the typed errors reproducible.
function assertSegmentBasics(text, start, end, location, maxSegmentBytes) {
  const unitLength = end - start;
  if (unitLength > maxSegmentBytes) {
    fail('out_of_range', location, `${location} exceeds the ${maxSegmentBytes}-byte segment limit.`);
  }
  if (unitLength === 0) {
    fail('invalid_format', location, `${location} is an empty path segment.`);
  }
  if (unitLength <= 2 && stringCharCodeAt(text, start) === FULL_STOP
    && (unitLength === 1 || stringCharCodeAt(text, start + 1) === FULL_STOP)) {
    fail('invalid_format', location, `${location} must not contain '.' or '..' path aliases.`);
  }
  if (utf8ByteLengthOf(stringSlice(text, start, end), 'utf8') > maxSegmentBytes) {
    fail('out_of_range', location,
      `${location} exceeds the ${maxSegmentBytes}-byte segment limit.`);
  }
  const cps = codePointsBetween(text, start, end, []);
  for (let i = 0; i < cps.length; i += 1) {
    if (isForbiddenCodePoint(cps[i])) {
      fail('invalid_format', location,
        `${location} contains a control, bidi-control, or lone-surrogate character.`);
    }
  }
  const segment = stringSlice(text, start, end);
  if (stringNormalize(segment, 'NFC') !== segment) {
    fail('invalid_format', location, `${location} must use NFC-normalized text.`);
  }
  return cps;
}

const PATH_CAPS = Object.freeze({
  maxBytes: REPO_PATH_MAX_BYTES,
  maxSegments: REPO_PATH_MAX_SEGMENTS,
});
const PATTERN_CAPS = Object.freeze({
  maxBytes: GLOB_PATTERN_MAX_BYTES,
  maxSegments: GLOB_PATTERN_MAX_SEGMENTS,
});

export function assertRepoRelativePath(value, label = 'path') {
  const location = guardLabel(label, 'path');
  const offsets = assertValidatedOffsets(value, location, PATH_CAPS, 'path');
  for (let i = 0; i < offsets.length; i += 2) {
    assertSegmentBasics(value, offsets[i], offsets[i + 1],
      `${location}.segments[${i / 2}]`, REPO_PATH_SEGMENT_MAX_BYTES);
  }
}

export function isRepoRelativePath(value) {
  try {
    assertRepoRelativePath(value);
    return true;
  } catch {
    return false;
  }
}

// Private detached IR. Only these five atom shapes exist; classes carry their
// closed membership data explicitly as frozen arrays scanned by index, so
// matching never consults locale, case folding, the RegExp engine, or
// set/map internals. Everything below is deeply frozen and never reachable
// from the public handle.
//   segment IR: { kind: 'double_star' } |
//               { kind: 'segment', atoms: [
//                   { type: 'star' } | { type: 'any' } |
//                   { type: 'literal', cp } |
//                   { type: 'class', singles: [cp], ranges: [[lo, hi]] }] }
const DOUBLE_STAR_SEGMENT = objectFreeze({ kind: 'double_star' });

// Module-private authority: only objects this module created are keys here,
// so handle provenance cannot be forged. Accessed only through the captured
// WeakMap bindings. This map is the sole locus of matcher authority.
const IR_BY_HANDLE = new WeakMap();

function compileWildcardSegment(cps, location) {
  const atoms = [];
  let i = 0;
  while (i < cps.length) {
    const cp = cps[i];
    if ((cp === STAR || cp === QUESTION_MARK || cp === EXCLAMATION_MARK
        || cp === COMMERCIAL_AT || cp === PLUS_SIGN)
      && i + 1 < cps.length && cps[i + 1] === LEFT_PARENTHESIS) {
      fail('pattern_extglob', location,
        `${location} opens an extglob group; extglob is not part of the grammar.`);
    }
    if (cp === STAR) {
      if (i + 1 < cps.length && cps[i + 1] === STAR) {
        fail('pattern_double_star', location,
          `${location} embeds '**' inside a segment; '**' is only legal as a whole segment.`);
      }
      atoms[atoms.length] = objectFreeze({ type: 'star' });
      i += 1;
      continue;
    }
    if (cp === QUESTION_MARK) {
      atoms[atoms.length] = objectFreeze({ type: 'any' });
      i += 1;
      continue;
    }
    if (cp === LEFT_BRACKET) {
      i += 1;
      if (i >= cps.length) {
        fail('pattern_unclosed_class', location, `${location} opens '[' without a closing ']'.`);
      }
      if (cps[i] === RIGHT_BRACKET) {
        fail('pattern_empty_class', location, `${location} contains an empty '[]' class.`);
      }
      if (cps[i] === EXCLAMATION_MARK || cps[i] === CIRCUMFLEX_ACCENT) {
        fail('pattern_class_negation', location,
          `${location} negates a character class; negation is not part of the grammar.`);
      }
      const singles = [];
      const ranges = [];
      let closed = false;
      while (i < cps.length) {
        const lo = cps[i];
        if (lo === RIGHT_BRACKET) {
          closed = true;
          i += 1;
          break;
        }
        if (i + 2 < cps.length && cps[i + 1] === RANGE_DASH && cps[i + 2] !== RIGHT_BRACKET) {
          const hi = cps[i + 2];
          if (hi <= lo) {
            fail('pattern_reversed_range', location,
              `${location} contains a reversed or degenerate class range; ranges must be strictly increasing.`);
          }
          ranges[ranges.length] = objectFreeze([lo, hi]);
          i += 3;
          continue;
        }
        singles[singles.length] = lo;
        i += 1;
      }
      if (!closed) {
        fail('pattern_unclosed_class', location, `${location} opens '[' without a closing ']'.`);
      }
      atoms[atoms.length] = objectFreeze({
        type: 'class', singles: objectFreeze(singles), ranges: objectFreeze(ranges),
      });
      continue;
    }
    atoms[atoms.length] = objectFreeze({ type: 'literal', cp });
    i += 1;
  }
  return objectFreeze({ kind: 'segment', atoms: objectFreeze(atoms) });
}

export function compileRepoGlob(pattern, label = 'pattern') {
  const location = guardLabel(label, 'pattern');
  const offsets = assertValidatedOffsets(pattern, location, PATTERN_CAPS, 'pattern');
  const segments = [];
  for (let i = 0; i < offsets.length; i += 2) {
    const segmentLocation = `${location}.segments[${i / 2}]`;
    const start = offsets[i];
    const end = offsets[i + 1];
    const cps = assertSegmentBasics(pattern, start, end, segmentLocation,
      GLOB_PATTERN_SEGMENT_MAX_BYTES);
    segments[segments.length] = end - start === 2
      && stringCharCodeAt(pattern, start) === STAR
      && stringCharCodeAt(pattern, start + 1) === STAR
      ? DOUBLE_STAR_SEGMENT
      : compileWildcardSegment(cps, segmentLocation);
  }
  const handle = objectFreeze({ id: REPO_PATH_MATCHER_ID, pattern });
  weakMapSet(IR_BY_HANDLE, handle, objectFreeze({ segments: objectFreeze(segments) }));
  return handle;
}

// Authority resolution: proxies are rejected first (so the WeakMap probe can
// never dispatch into exotic targets), then provenance is decided by the
// module-private WeakMap alone. The public id/pattern fields are NEVER read:
// they are inert documentation, so forged shapes, copies, serializations,
// subclasses, and mutated handles can neither gain nor lose authority here.
function irOf(compiled) {
  if (!compiled || typeof compiled !== 'object' || utilIsProxy(compiled)) {
    fail('invalid_type', 'compiled', 'compiled must be a compileRepoGlob() result.');
  }
  const ir = weakMapGet(IR_BY_HANDLE, compiled);
  if (!ir) {
    fail('invalid_type', 'compiled', 'compiled must be a compileRepoGlob() result.');
  }
  return ir;
}

function codePointMatchesClass(atom, cp) {
  const singles = atom.singles;
  for (let i = 0; i < singles.length; i += 1) {
    if (singles[i] === cp) return true;
  }
  const ranges = atom.ranges;
  for (let i = 0; i < ranges.length; i += 1) {
    if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
  }
  return false;
}

// Charged pattern work, computed from private IR only. A class atom costs
// its singles plus two steps per range because matching it scans exactly
// those members per code point; everything else costs 1; a whole-segment
// '**' costs 1. Charging happens before any matching runs so hostile
// range-count/work amplification is rejected deterministically.
function chargedPatternSteps(segments) {
  let total = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.kind === 'double_star') {
      total += 1;
      continue;
    }
    total += 1;
    const atoms = segment.atoms;
    for (let a = 0; a < atoms.length; a += 1) {
      const atom = atoms[a];
      total += atom.type === 'class'
        ? atom.singles.length + 2 * atom.ranges.length
        : 1;
    }
  }
  return total;
}

// Bounded DP over (atom x code point) for one pattern/path segment pair.
// Fresh Uint8Array rows; O(atoms * codePoints) work, no recursion, and no
// prototype-method calls on the rows. The star transition seeds next[0]
// from current[0]: a star matches the empty remainder, which is what keeps
// leading '*' atoms sound.
function segmentMatches(atoms, textCps) {
  const length = textCps.length;
  let current = new SafeUint8Array(length + 1);
  current[0] = 1;
  for (let a = 0; a < atoms.length; a += 1) {
    const next = new SafeUint8Array(length + 1);
    const atom = atoms[a];
    if (atom.type === 'star') {
      next[0] = current[0];
      for (let k = 1; k <= length; k += 1) {
        next[k] = next[k - 1] | current[k];
      }
    } else if (atom.type === 'any') {
      for (let k = 1; k <= length; k += 1) {
        next[k] = current[k - 1];
      }
    } else if (atom.type === 'literal') {
      const cp = atom.cp;
      for (let k = 1; k <= length; k += 1) {
        if (current[k - 1] === 1 && textCps[k - 1] === cp) next[k] = 1;
      }
    } else {
      for (let k = 1; k <= length; k += 1) {
        if (current[k - 1] === 1 && codePointMatchesClass(atom, textCps[k - 1])) next[k] = 1;
      }
    }
    current = next;
  }
  return current[length] === 1;
}

// Bounded DP over (pattern-segment x path-segment). dp[i][j] is true iff
// segments[i..] match pathSegments[j..]; whole-segment '**' reduces to
// dp[i+1][j] (consume nothing) || dp[i][j+1] (consume one more segment).
// The charged matrix product is checked against GLOB_MATCH_STEP_BUDGET
// before any character comparison runs.
function irMatchesPathSegments(ir, pathCpSegments, stepBudgetLocation) {
  const patternSegments = ir.segments;
  const patternCount = patternSegments.length;
  const pathCount = pathCpSegments.length;
  let pathSteps = 0;
  for (let j = 0; j < pathCount; j += 1) {
    pathSteps += pathCpSegments[j].length + 1;
  }
  if (chargedPatternSteps(patternSegments) * pathSteps > GLOB_MATCH_STEP_BUDGET) {
    fail('match_work_exceeded', stepBudgetLocation,
      `${stepBudgetLocation} would exceed the ${GLOB_MATCH_STEP_BUDGET}-step match budget; reject rather than match unbounded.`);
  }
  const dp = [];
  for (let i = 0; i <= patternCount; i += 1) {
    dp[i] = new SafeUint8Array(pathCount + 1);
  }
  dp[patternCount][pathCount] = 1;
  for (let i = patternCount - 1; i >= 0; i -= 1) {
    const segment = patternSegments[i];
    for (let j = pathCount; j >= 0; j -= 1) {
      if (segment.kind === 'double_star') {
        dp[i][j] = ((dp[i + 1][j] === 1) || (j < pathCount && dp[i][j + 1] === 1)) ? 1 : 0;
      } else if (j < pathCount && segmentMatches(segment.atoms, pathCpSegments[j])) {
        dp[i][j] = dp[i + 1][j + 1];
      } else {
        dp[i][j] = 0;
      }
    }
  }
  return dp[0][0] === 1;
}

function pathToCodePointSegments(value, location) {
  const offsets = assertValidatedOffsets(value, location, PATH_CAPS, 'path');
  const cpSegments = [];
  for (let i = 0; i < offsets.length; i += 2) {
    cpSegments[cpSegments.length] =
      assertSegmentBasics(value, offsets[i], offsets[i + 1],
        `${location}.segments[${i / 2}]`, REPO_PATH_SEGMENT_MAX_BYTES);
  }
  return cpSegments;
}

// Aggregate batch budget: charged compiled pattern work times the sum of
// every path's work, computed from validated strings alone and rejected
// before the first match, so a full legal-cap batch can never burn seconds
// synchronously.
function assertAggregateBatchBudget(ir, totalPathWork, location) {
  if (chargedPatternSteps(ir.segments) * totalPathWork > GLOB_MATCH_STEP_BUDGET) {
    fail('match_work_exceeded', location,
      `${location} exceeds the ${GLOB_MATCH_STEP_BUDGET}-step aggregate batch match budget; chunk the batch.`);
  }
}

// Code points plus segment count: exactly the per-path DP work factor.
// Manual surrogate-aware scan; no string iteration.
function pathWorkOf(value) {
  let work = 1;
  let codePoints = 0;
  const length = value.length;
  let i = 0;
  while (i < length) {
    const unit = stringCharCodeAt(value, i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < length
      && stringCharCodeAt(value, i + 1) >= 0xdc00
      && stringCharCodeAt(value, i + 1) <= 0xdfff) {
      i += 2;
    } else {
      i += 1;
    }
    if (unit === SOLIDUS) work += 1;
    else codePoints += 1;
  }
  return codePoints + work;
}

// Batch inputs are validated through a bounded numeric snapshot taken with
// the captured descriptor intrinsics only: proxies are rejected before
// array checks, the O(1) length cap runs before any element work, and only
// own enumerable data index properties 0..length-1 are inspected through
// captured Object.getOwnPropertyDescriptor. Neither `length` nor any element
// is ever read through dynamic [[Get]] on the caller's array, so accessor
// elements, expando/symbol/inherited decorations, and a patched descriptor
// intrinsic can neither execute, be matched, nor relax the bounds. The
// snapshot is module-owned: after validation the caller's array is never
// touched again. Returns the elements plus the summed path work for the
// aggregate budget check.
function snapshotPathBatch(paths, location) {
  if (utilIsProxy(paths)) {
    fail('invalid_array', location, `${location} must be a concrete JSON array, not a Proxy.`);
  }
  if (!arrayIsArray(paths)) {
    fail('invalid_type', location, `${location} must be an array of repository-relative paths.`);
  }
  let prototype;
  try {
    prototype = objectGetPrototypeOf(paths);
  } catch {
    fail('invalid_array', location, `${location} prototype could not be inspected safely.`);
  }
  if (prototype !== arrayProto && prototype !== null) {
    fail('invalid_array', location, `${location} must use the standard or null array prototype.`);
  }
  const lengthDescriptor = objectGetOwnPropertyDescriptor(paths, 'length');
  if (!lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number' || !(lengthDescriptor.value >= 0)) {
    fail('invalid_array', location, `${location} length must be a plain data property.`);
  }
  const batchLength = lengthDescriptor.value;
  if (batchLength > REPO_PATH_BATCH_MAX) {
    fail('out_of_range', location, `${location} exceeds the ${REPO_PATH_BATCH_MAX}-path batch limit.`);
  }
  const elements = [];
  let totalPathWork = 0;
  for (let i = 0; i < batchLength; i += 1) {
    const elementLocation = `${location}[${i}]`;
    let descriptor;
    try {
      descriptor = objectGetOwnPropertyDescriptor(paths, i);
    } catch {
      fail('invalid_array', elementLocation, `${elementLocation} descriptor could not be inspected safely.`);
    }
    if (!descriptor || descriptor.enumerable !== true || !objectHasOwn(descriptor, 'value')) {
      fail('invalid_array', elementLocation, `${elementLocation} must be an enumerable data element.`);
    }
    const element = descriptor.value;
    if (typeof element !== 'string') {
      fail('invalid_type', elementLocation, `${elementLocation} must be a string repository-relative path.`);
    }
    assertRepoRelativePath(element, elementLocation);
    totalPathWork += pathWorkOf(element);
    elements[elements.length] = element;
  }
  return { elements, totalPathWork };
}

export function compiledRepoGlobMatchesPath(compiled, value, label = 'path') {
  const location = guardLabel(label, 'path');
  return irMatchesPathSegments(irOf(compiled), pathToCodePointSegments(value, location), location);
}

export function repoGlobMatchesPath(pattern, value, label = 'path') {
  const location = guardLabel(label, 'path');
  const ir = irOf(compileRepoGlob(pattern, 'pattern'));
  return irMatchesPathSegments(ir, pathToCodePointSegments(value, location), location);
}

// Validate every element before answering anything: a typed failure on the
// last element must not leave a partially filtered answer behind.
export function filterRepoPathsByGlob(pattern, paths, label = 'paths') {
  const location = guardLabel(label, 'paths');
  const ir = irOf(compileRepoGlob(pattern, 'pattern'));
  const { elements, totalPathWork } = snapshotPathBatch(paths, location);
  assertAggregateBatchBudget(ir, totalPathWork, location);
  const matched = [];
  for (let i = 0; i < elements.length; i += 1) {
    const elementLocation = `${location}[${i}]`;
    if (irMatchesPathSegments(ir, pathToCodePointSegments(elements[i], elementLocation), elementLocation)) {
      matched[matched.length] = elements[i];
    }
  }
  return matched;
}

export function repoGlobMatchesAnyPath(pattern, paths, label = 'paths') {
  const location = guardLabel(label, 'paths');
  const ir = irOf(compileRepoGlob(pattern, 'pattern'));
  const { elements, totalPathWork } = snapshotPathBatch(paths, location);
  assertAggregateBatchBudget(ir, totalPathWork, location);
  for (let i = 0; i < elements.length; i += 1) {
    const elementLocation = `${location}[${i}]`;
    if (irMatchesPathSegments(ir, pathToCodePointSegments(elements[i], elementLocation), elementLocation)) {
      return true;
    }
  }
  return false;
}
