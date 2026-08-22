// RepoPathMatcherV1 — repository path-matching authority (R1 P02R2).
//
// Additive v3 module: it imports nothing from the run-manifest envelope and
// edits no existing runtime surface. It answers exactly one question,
// deterministically and fail-closed: does a normalized NFC UTF-8 POSIX
// repository-relative path belong to a repository glob pattern?
//
// Frozen grammar (the pattern is split on '/'):
//   - literals: any permitted Unicode code point, matched case-sensitively
//     by code point;
//   - '*' matches zero or more code points inside one segment;
//   - '?' matches exactly one code point inside one segment;
//   - '[abc]' / '[a-z0-9_-]' matches one code point from an explicit closed
//     set of singles and strictly ascending inclusive ranges;
//   - '**' is only legal as a whole segment. It matches zero or more whole
//     segments: 'foo/**' matches 'foo' and its descendants, '**/foo' matches
//     the root 'foo' and every descendant named 'foo', and a bare '**'
//     matches every valid path.
// Unsupported constructs are rejected before any matching work (fail closed):
//   escapes ('\'), brace expansion, extglob, negated classes ('[!..]',
//   '[^..]'), embedded double stars ('a**b'), empty ('[]') and unclosed
//   ('[ab') classes, reversed or degenerate ranges ('[9-0]', '[a-a]'),
//   '.', '..', empty segments, and non-NFC segments.
//
// Algorithm: bounded dynamic programming twice over — once across
// (pattern-segment x path-segment) pairs, once across (atom x code point)
// pairs inside each such pair. No regular expression is ever compiled from
// caller input, there is no recursion, and total work is
// O((sum of pattern atoms) x (sum of path code points)), a constant bounded
// by the caps below and re-checked against GLOB_MATCH_STEP_BUDGET before any
// character comparison runs.
//
// Separation of authorities: this module is deliberately independent of the
// conservative ASCII-case-folded writer-overlap safety check exported by
// run-manifest.mjs (`scopeStaticPrefix` / `writerScopesOverlap`). That
// check is an over-approximating dispatch-time safety net; it is neither
// imported nor weakened here. This module provides exact case-sensitive
// membership for scope/change-set adjudication and never decides writer
// disjointness on its own.

import { types as utilTypes } from 'node:util';

export const REPO_PATH_MATCHER_ID = 'codex-co-engineer.repo-path-matcher.v1';

// Bounds. Path caps mirror the R1 repository-path validator (4096-byte
// absolute paths) plus NAME_MAX-parity per-segment and depth caps so that a
// hostile path cannot enlarge the DP matrix. Pattern caps mirror the R1
// write-scope glob limits (SCOPE_PATTERN_MAX_BYTES / SCOPE_SEGMENT_MAX_BYTES /
// SCOPE_MAX_SEGMENTS) so every manifest-accepted scope pattern is inside the
// matchable envelope.
export const REPO_PATH_MAX_BYTES = 4096;
export const REPO_PATH_MAX_SEGMENTS = 64;
export const REPO_PATH_SEGMENT_MAX_BYTES = 255;
export const REPO_PATH_BATCH_MAX = 1024;
export const GLOB_PATTERN_MAX_BYTES = 256;
export const GLOB_PATTERN_MAX_SEGMENTS = 16;
export const GLOB_PATTERN_SEGMENT_MAX_BYTES = 128;
// Upper bound of (atom+1)*(code-point+1) products under the caps above is
// ~33.8M; the budget sits above that ceiling and exists purely as defense in
// depth so future cap growth cannot silently unbound the matcher.
export const GLOB_MATCH_STEP_BUDGET = 67_108_864;

// Stable typed-error vocabulary. Validation runs through one fixed pipeline,
// so identical inputs always raise the identical first code, location, and
// message.
export const REPO_PATH_MATCHER_ERROR_CODES = Object.freeze([
  'invalid_array',
  'invalid_format',
  'invalid_type',
  'match_work_exceeded',
  'out_of_range',
  'pattern_class_negation',
  'pattern_double_star',
  'pattern_empty_class',
  'pattern_reversed_range',
  'pattern_unclosed_class',
]);

export class RepoPathMatcherError extends Error {
  constructor(code, location, message) {
    super(message);
    this.name = 'RepoPathMatcherError';
    this.code = code;
    this.location = location;
  }
}

function fail(code, location, message) {
  throw new RepoPathMatcherError(code, location, message);
}

export function utf8ByteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

const STAR = 0x2a;
const QUESTION_MARK = 0x3f;
const BACKSLASH = 0x5c;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const EXCLAMATION_MARK = 0x21;
const CIRCUMFLEX_ACCENT = 0x5e;
const RANGE_DASH = 0x2d;

function isForbiddenCodePoint(cp) {
  return (cp >= 0xd800 && cp <= 0xdfff) // lone surrogates: never valid UTF-8
    || cp < 0x20 // C0 controls, including NUL
    || (cp >= 0x7f && cp <= 0x9f) // DEL and C1 controls
    || (cp >= 0x202a && cp <= 0x202e) // bidi embeddings/overrides
    || (cp >= 0x2066 && cp <= 0x2069); // bidi isolates
}

// Character-level rejection shared by paths and patterns. Mirrors the exact
// control/bidi/lone-surrogate classes of the R1 repository-path validator so
// both authorities accept the same alphabet.
function assertSegmentCodePoints(segment, location) {
  for (const ch of segment) {
    const cp = ch.codePointAt(0);
    if (isForbiddenCodePoint(cp)) {
      fail('invalid_format', location,
        `${location} contains a control, bidi-control, or lone-surrogate character U+${cp.toString(16).padStart(4, '0')}.`);
    }
  }
}

// Per-segment pipeline order is fixed everywhere: structural aliases, byte
// bound, character scan left-to-right, NFC. The first failure wins, which is
// what makes the typed errors reproducible.
function assertSegmentBasics(segment, location, maxSegmentBytes) {
  if (segment.length === 0) {
    fail('invalid_format', location, `${location} is an empty path segment.`);
  }
  if (segment === '.' || segment === '..') {
    fail('invalid_format', location, `${location} must not contain '.' or '..' path aliases.`);
  }
  if (Buffer.byteLength(segment, 'utf8') > maxSegmentBytes) {
    fail('out_of_range', location,
      `${location} exceeds the ${maxSegmentBytes}-byte segment limit.`);
  }
  assertSegmentCodePoints(segment, location);
  if (segment.normalize('NFC') !== segment) {
    fail('invalid_format', location, `${location} must use NFC-normalized text.`);
  }
}

export function assertRepoRelativePath(value, label = 'path') {
  const location = typeof label === 'string' && label.length > 0 ? label : 'path';
  if (typeof value !== 'string') {
    fail('invalid_type', location, `${location} must be a string repository-relative path.`);
  }
  if (value.length === 0) {
    fail('invalid_format', location, `${location} must not be empty.`);
  }
  if (value.includes('\\')) {
    fail('invalid_format', location, `${location} must use POSIX '/' separators; '\\' is rejected.`);
  }
  if (value.startsWith('/')) {
    fail('invalid_format', location, `${location} must be relative; a leading '/' is rejected.`);
  }
  if (value.endsWith('/')) {
    fail('invalid_format', location, `${location} must not end with '/'.`);
  }
  if (Buffer.byteLength(value, 'utf8') > REPO_PATH_MAX_BYTES) {
    fail('out_of_range', location, `${location} exceeds the ${REPO_PATH_MAX_BYTES}-byte path limit.`);
  }
  const segments = value.split('/');
  if (segments.length > REPO_PATH_MAX_SEGMENTS) {
    fail('out_of_range', location,
      `${location} exceeds the ${REPO_PATH_MAX_SEGMENTS}-segment path limit.`);
  }
  for (let i = 0; i < segments.length; i += 1) {
    assertSegmentBasics(segments[i], `${location}.segments[${i}]`, REPO_PATH_SEGMENT_MAX_BYTES);
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

// Compiled atoms. Only these five shapes exist; classes carry their closed
// membership set explicitly so matching never consults locale, case folding,
// or the RegExp engine.
//   { kind: 'double_star' }
//   { kind: 'segment', atoms: [
//       { type: 'star' } | { type: 'any' } |
//       { type: 'literal', cp } |
//       { type: 'class', singles: Set<cp>, ranges: [[lo, hi]] } ] }

const DOUBLE_STAR_SEGMENT = Object.freeze({ kind: 'double_star' });

function compileWildcardSegment(segment, location) {
  const cps = [];
  for (const ch of segment) cps.push(ch.codePointAt(0));
  const atoms = [];
  let i = 0;
  while (i < cps.length) {
    const cp = cps[i];
    if (cp === STAR) {
      if (i + 1 < cps.length && cps[i + 1] === STAR) {
        fail('pattern_double_star', location,
          `${location} embeds '**' inside a segment; '**' is only legal as a whole segment.`);
      }
      atoms.push({ type: 'star' });
      i += 1;
      continue;
    }
    if (cp === QUESTION_MARK) {
      atoms.push({ type: 'any' });
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
      const singles = new Set();
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
              `${location} contains the class range ${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}; ranges must be strictly increasing.`);
          }
          ranges.push(Object.freeze([lo, hi]));
          i += 3;
          continue;
        }
        singles.add(lo);
        i += 1;
      }
      if (!closed) {
        fail('pattern_unclosed_class', location, `${location} opens '[' without a closing ']'.`);
      }
      atoms.push({ type: 'class', singles, ranges });
      continue;
    }
    atoms.push({ type: 'literal', cp });
    i += 1;
  }
  return { kind: 'segment', atoms };
}

export function compileRepoGlob(pattern, label = 'pattern') {
  const location = typeof label === 'string' && label.length > 0 ? label : 'pattern';
  if (typeof pattern !== 'string') {
    fail('invalid_type', location, `${location} must be a string repository glob.`);
  }
  if (pattern.length === 0) {
    fail('invalid_format', location, `${location} must not be empty.`);
  }
  if (pattern.includes('\\')) {
    fail('invalid_format', location,
      `${location} uses '\\'; escapes are not part of the grammar and are rejected.`);
  }
  if (pattern.startsWith('/')) {
    fail('invalid_format', location, `${location} must be relative; a leading '/' is rejected.`);
  }
  if (pattern.endsWith('/')) {
    fail('invalid_format', location, `${location} must not end with '/'.`);
  }
  if (Buffer.byteLength(pattern, 'utf8') > GLOB_PATTERN_MAX_BYTES) {
    fail('out_of_range', location,
      `${location} exceeds the ${GLOB_PATTERN_MAX_BYTES}-byte pattern limit.`);
  }
  const rawSegments = pattern.split('/');
  if (rawSegments.length > GLOB_PATTERN_MAX_SEGMENTS) {
    fail('out_of_range', location,
      `${location} exceeds the ${GLOB_PATTERN_MAX_SEGMENTS}-segment pattern limit.`);
  }
  const segments = [];
  for (let i = 0; i < rawSegments.length; i += 1) {
    const segmentLocation = `${location}.segments[${i}]`;
    const raw = rawSegments[i];
    assertSegmentBasics(raw, segmentLocation, GLOB_PATTERN_SEGMENT_MAX_BYTES);
    segments.push(raw === '**' ? DOUBLE_STAR_SEGMENT : compileWildcardSegment(raw, segmentLocation));
  }
  return Object.freeze({
    id: REPO_PATH_MATCHER_ID,
    pattern,
    segments: Object.freeze(segments),
  });
}

function assertCompiledRepoGlob(value) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || value.id !== REPO_PATH_MATCHER_ID) {
    fail('invalid_type', 'compiled', 'compiled must be a compileRepoGlob() result.');
  }
  if (!Array.isArray(value.segments)) {
    fail('invalid_type', 'compiled', 'compiled must be a compileRepoGlob() result.');
  }
}

function codePointMatchesClass(atom, cp) {
  if (atom.singles.has(cp)) return true;
  const ranges = atom.ranges;
  for (let i = 0; i < ranges.length; i += 1) {
    if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
  }
  return false;
}

// Bounded DP over (atom x code point) for one pattern/path segment pair.
// Rolling Uint8Array rows; O(atoms * codePoints) work, no recursion.
function segmentMatches(atoms, textCps) {
  const atomCount = atoms.length;
  const length = textCps.length;
  let current = new Uint8Array(length + 1);
  let next = new Uint8Array(length + 1);
  current[0] = 1;
  for (let a = 0; a < atomCount; a += 1) {
    next.fill(0);
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
    const swap = current;
    current = next;
    next = swap;
  }
  return current[length] === 1;
}

// Bounded DP over (pattern-segment x path-segment). dp[i][j] is true iff
// segments[i..] match pathSegments[j..]; whole-segment '**' reduces to
// dp[i+1][j] (consume nothing) || dp[i][j+1] (consume one more segment).
function compiledMatchesPathSegments(compiled, pathCpSegments, stepBudgetLocation) {
  const patternSegments = compiled.segments;
  const patternCount = patternSegments.length;
  const pathCount = pathCpSegments.length;

  // Fail closed before any character work if the derived matrix would exceed
  // the fixed step budget. Under the shipped caps this can never fire; it
  // keeps the matcher bounded if the caps ever grow.
  let patternSteps = 0;
  for (let i = 0; i < patternCount; i += 1) {
    patternSteps += patternSegments[i].kind === 'double_star' ? 1 : patternSegments[i].atoms.length + 1;
  }
  let pathSteps = 0;
  for (let j = 0; j < pathCount; j += 1) {
    pathSteps += pathCpSegments[j].length + 1;
  }
  if (patternSteps * pathSteps > GLOB_MATCH_STEP_BUDGET) {
    fail('match_work_exceeded', stepBudgetLocation,
      `${stepBudgetLocation} would exceed the ${GLOB_MATCH_STEP_BUDGET}-step match budget; reject rather than match unbounded.`);
  }

  const dp = new Array(patternCount + 1);
  for (let i = 0; i <= patternCount; i += 1) {
    dp[i] = new Uint8Array(pathCount + 1);
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

function pathToCodePointSegments(value, label) {
  assertRepoRelativePath(value, label);
  const pathSegments = value.split('/');
  const cpSegments = [];
  for (let i = 0; i < pathSegments.length; i += 1) {
    const cps = [];
    for (const ch of pathSegments[i]) cps.push(ch.codePointAt(0));
    cpSegments.push(cps);
  }
  return cpSegments;
}

export function compiledRepoGlobMatchesPath(compiled, value, label = 'path') {
  assertCompiledRepoGlob(compiled);
  return compiledMatchesPathSegments(compiled, pathToCodePointSegments(value, label), label);
}

export function repoGlobMatchesPath(pattern, value, label = 'path') {
  const compiled = compileRepoGlob(pattern, 'pattern');
  return compiledMatchesPathSegments(compiled, pathToCodePointSegments(value, label), label);
}

// Batch inputs are plain JSON data: Proxies, exotic prototypes, sparse or
// decorated arrays are rejected without dispatching a single trap, mirroring
// the run-envelope array discipline.
function assertPathBatch(paths, label) {
  const location = typeof label === 'string' && label.length > 0 ? label : 'paths';
  if (!Array.isArray(paths)) {
    fail('invalid_type', location, `${location} must be an array of repository-relative paths.`);
  }
  if (utilTypes.isProxy(paths)) {
    fail('invalid_array', location, `${location} must be a concrete JSON array, not a Proxy.`);
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(paths);
  } catch {
    fail('invalid_array', location, `${location} prototype could not be inspected safely.`);
  }
  if (prototype !== Array.prototype && prototype !== null) {
    fail('invalid_array', location, `${location} must use the standard or null array prototype.`);
  }
  // Inherited enumerable properties are unreachable from JSON; reject them
  // without reading any element so accessor traps stay undispatched.
  for (const key in paths) {
    if (!Object.hasOwn(paths, key)) {
      fail('invalid_array', location, `${location} must not inherit enumerable array properties.`);
    }
  }
  if (paths.length > REPO_PATH_BATCH_MAX) {
    fail('out_of_range', location, `${location} exceeds the ${REPO_PATH_BATCH_MAX}-path batch limit.`);
  }
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(paths);
  } catch {
    fail('invalid_array', location, `${location} keys could not be inspected safely.`);
  }
  let indexCount = 0;
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') {
      fail('invalid_array', location, `${location} must be a dense JSON array without extra or symbol properties.`);
    }
    const asNumber = Number(key);
    if (!Number.isInteger(asNumber) || asNumber < 0 || asNumber >= paths.length || String(asNumber) !== key) {
      fail('invalid_array', location, `${location} must be a dense JSON array without extra or symbol properties.`);
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(paths, key);
    } catch {
      fail('invalid_array', `${location}[${key}]`, `${location}[${key}] descriptor could not be inspected safely.`);
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid_array', `${location}[${key}]`, `${location}[${key}] must be an enumerable data element.`);
    }
    indexCount += 1;
  }
  if (indexCount !== paths.length) {
    fail('invalid_array', location, `${location} must be dense; sparse arrays are not path batches.`);
  }
  // Validate every element before answering anything: a typed failure on the
  // last element must not leave a partially filtered answer behind.
  for (let i = 0; i < paths.length; i += 1) {
    if (typeof paths[i] !== 'string') {
      fail('invalid_type', `${location}[${i}]`, `${location}[${i}] must be a string repository-relative path.`);
    }
    assertRepoRelativePath(paths[i], `${location}[${i}]`);
  }
}

export function filterRepoPathsByGlob(pattern, paths, label = 'paths') {
  const compiled = compileRepoGlob(pattern, 'pattern');
  const location = typeof label === 'string' && label.length > 0 ? label : 'paths';
  assertPathBatch(paths, location);
  const matched = [];
  for (let i = 0; i < paths.length; i += 1) {
    if (compiledMatchesPathSegments(compiled, pathToCodePointSegments(paths[i], `${location}[${i}]`), `${location}[${i}]`)) {
      matched.push(paths[i]);
    }
  }
  return matched;
}

export function repoGlobMatchesAnyPath(pattern, paths, label = 'paths') {
  const compiled = compileRepoGlob(pattern, 'pattern');
  const location = typeof label === 'string' && label.length > 0 ? label : 'paths';
  assertPathBatch(paths, location);
  for (let i = 0; i < paths.length; i += 1) {
    if (compiledMatchesPathSegments(compiled, pathToCodePointSegments(paths[i], `${location}[${i}]`), `${location}[${i}]`)) {
      return true;
    }
  }
  return false;
}
