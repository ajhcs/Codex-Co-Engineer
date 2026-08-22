// RepoPathMatcherV1 — repository path-matching authority (R1 P02R2).
//
// Answers exactly one question, deterministically and fail closed: does a
// normalized NFC UTF-8 POSIX repository-relative path belong to a repository
// glob pattern? Additive v3 module: imports nothing from the run-manifest
// envelope and edits no existing runtime surface.
//
// Frozen grammar (the pattern is split on '/'):
//   - literals: any permitted Unicode code point, matched case-sensitively;
//     '{' and '}' are ordinary literals — brace expansion does not exist;
//   - '*' (zero or more code points) and '?' (exactly one) inside a segment;
//   - '[abc]' / '[a-z0-9_-]': one code point from an explicit closed set;
//   - '**' is only legal as a whole segment (zero or more whole segments);
//   - '|' outside extglob is an ordinary literal.
// Rejected before any matching work (fail closed): escapes ('\'), the extglob
// opener sequences '@(' '+(' '!(' '?(' '*(', negated classes ('[!..]',
// '[^..]'), embedded double stars ('a**b'), empty ('[]') and unclosed
// ('[ab') classes, reversed or degenerate ranges ('[9-0]', '[a-a]'), '.',
// '..', empty segments, and non-NFC text.
//
// Compiled authorities are opaque: compileRepoGlob returns a frozen
// two-primitive handle whose provenance is authenticated by a module-private
// WeakMap mapping it to deeply frozen detached intermediate representation.
// Matching reads only that private IR, so forged id/segments shapes, getters,
// active or revoked proxies, and mutation of public aliases can neither drive
// nor observe matching, and no segment/atom/Set/range internal is exposed.
//
// Algorithm: bounded dynamic programming twice over — (pattern-segment x
// path-segment) pairs, then (atom x code point) pairs. No regular expression
// is compiled from caller input and there is no recursion. Every public call
// is bounded: single-path work is checked against GLOB_MATCH_STEP_BUDGET
// per match, and batch calls against one aggregate budget of compiled pattern
// work times the sum of all path work, rejected before the first match.
//
// Separation of authorities: deliberately independent of the conservative
// ASCII-case-folded writer-overlap safety check exported by run-manifest.mjs
// (`scopeStaticPrefix` / `writerScopesOverlap`). That check over-approximates
// dispatch-time overlap; it is neither imported nor weakened here.

import { types as utilTypes } from 'node:util';

export const REPO_PATH_MATCHER_ID = 'codex-co-engineer.repo-path-matcher.v1';

// Bounds mirror the R1 repository-path validator and the R1 write-scope glob
// limits so every manifest-accepted scope pattern stays inside the matchable
// envelope. GLOB_MATCH_STEP_BUDGET sits far above the largest product the
// caps allow and exists purely as defense in depth for both the single-path
// matrix and the aggregate batch product.
export const REPO_PATH_MAX_BYTES = 4096;
export const REPO_PATH_MAX_SEGMENTS = 64;
export const REPO_PATH_SEGMENT_MAX_BYTES = 255;
export const REPO_PATH_BATCH_MAX = 1024;
export const GLOB_PATTERN_MAX_BYTES = 256;
export const GLOB_PATTERN_MAX_SEGMENTS = 16;
export const GLOB_PATTERN_SEGMENT_MAX_BYTES = 128;
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
  'pattern_extglob',
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

// Labels become error locations, so they follow a fixed <=128-byte printable
// ASCII grammar and anything else collapses to a constant fallback. Errors
// therefore stay bounded and never reflect hostile labels, values, code
// points, or ranges.
const SAFE_LABEL_PATTERN = /^[\x20-\x7e]{1,128}$/u;

function guardLabel(label, fallback) {
  if (typeof label !== 'string' || label.length > 128 || !SAFE_LABEL_PATTERN.test(label)) {
    return fallback;
  }
  return label;
}

export function utf8ByteLength(text) {
  if (typeof text !== 'string') {
    fail('invalid_type', 'utf8ByteLength', 'utf8ByteLength input must be a string.');
  }
  return Buffer.byteLength(text, 'utf8');
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

function isForbiddenCodePoint(cp) {
  return (cp >= 0xd800 && cp <= 0xdfff) // lone surrogates: never valid UTF-8
    || cp < 0x20 // C0 controls, including NUL
    || (cp >= 0x7f && cp <= 0x9f) // DEL and C1 controls
    || (cp >= 0x202a && cp <= 0x202e) // bidi embeddings/overrides
    || (cp >= 0x2066 && cp <= 0x2069); // bidi isolates
}

function assertSegmentCodePoints(segment, location) {
  for (const ch of segment) {
    if (isForbiddenCodePoint(ch.codePointAt(0))) {
      fail('invalid_format', location,
        `${location} contains a control, bidi-control, or lone-surrogate character.`);
    }
  }
}

// Per-segment pipeline order is fixed everywhere: O(1) unit-length cap, byte
// bound, structural aliases, character scan, NFC. The first failure wins,
// which is what makes the typed errors reproducible.
function assertSegmentBasics(segment, location, maxSegmentBytes) {
  if (segment.length > maxSegmentBytes) {
    fail('out_of_range', location, `${location} exceeds the ${maxSegmentBytes}-byte segment limit.`);
  }
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
  const location = guardLabel(label, 'path');
  if (typeof value !== 'string') {
    fail('invalid_type', location, `${location} must be a string repository-relative path.`);
  }
  if (value.length > REPO_PATH_MAX_BYTES) {
    fail('out_of_range', location, `${location} exceeds the ${REPO_PATH_MAX_BYTES}-byte path limit.`);
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

// Private detached IR. Only these five atom shapes exist; classes carry their
// closed membership data explicitly so matching never consults locale, case
// folding, or the RegExp engine. Everything below is deeply frozen and never
// reachable from the public handle.
//   segment IR: { kind: 'double_star' } |
//               { kind: 'segment', atoms: [
//                   { type: 'star' } | { type: 'any' } |
//                   { type: 'literal', cp } |
//                   { type: 'class', singles: Set<cp>, ranges: [[lo, hi]] }] }
const DOUBLE_STAR_SEGMENT = Object.freeze({ kind: 'double_star' });

// Module-private authority: only objects this module created are keys here,
// so handle provenance cannot be forged.
const IR_BY_HANDLE = new WeakMap();

function freezeAtom(atom) {
  if (atom.type === 'class') {
    return Object.freeze({ type: 'class', singles: atom.singles, ranges: Object.freeze(atom.ranges.map(Object.freeze)) });
  }
  return Object.freeze(atom);
}

function compileWildcardSegment(segment, location) {
  const cps = [];
  for (const ch of segment) cps.push(ch.codePointAt(0));
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
              `${location} contains a reversed or degenerate class range; ranges must be strictly increasing.`);
          }
          ranges.push([lo, hi]);
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
  return Object.freeze({ kind: 'segment', atoms: Object.freeze(atoms.map(freezeAtom)) });
}

export function compileRepoGlob(pattern, label = 'pattern') {
  const location = guardLabel(label, 'pattern');
  if (typeof pattern !== 'string') {
    fail('invalid_type', location, `${location} must be a string repository glob.`);
  }
  if (pattern.length > GLOB_PATTERN_MAX_BYTES) {
    fail('out_of_range', location,
      `${location} exceeds the ${GLOB_PATTERN_MAX_BYTES}-byte pattern limit.`);
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
  const handle = Object.freeze({ id: REPO_PATH_MATCHER_ID, pattern });
  IR_BY_HANDLE.set(handle, Object.freeze({ segments: Object.freeze(segments) }));
  return handle;
}

function irOf(compiled) {
  if (!compiled || typeof compiled !== 'object' || utilTypes.isProxy(compiled)) {
    fail('invalid_type', 'compiled', 'compiled must be a compileRepoGlob() result.');
  }
  const ir = IR_BY_HANDLE.get(compiled);
  if (!ir || compiled.id !== REPO_PATH_MATCHER_ID) {
    fail('invalid_type', 'compiled', 'compiled must be a compileRepoGlob() result.');
  }
  return ir;
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
// The derived matrix is checked against GLOB_MATCH_STEP_BUDGET before any
// character comparison runs.
function irMatchesPathSegments(ir, pathCpSegments, stepBudgetLocation) {
  const patternSegments = ir.segments;
  const patternCount = patternSegments.length;
  const pathCount = pathCpSegments.length;
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

function pathToCodePointSegments(value, location) {
  assertRepoRelativePath(value, location);
  const pathSegments = value.split('/');
  const cpSegments = [];
  for (let i = 0; i < pathSegments.length; i += 1) {
    const cps = [];
    for (const ch of pathSegments[i]) cps.push(ch.codePointAt(0));
    cpSegments.push(cps);
  }
  return cpSegments;
}

// Aggregate batch budget: compiled pattern work times the sum of every
// path's work, computed from validated strings alone and rejected before the
// first match, so a full legal-cap batch can never burn seconds synchronously.
function assertAggregateBatchBudget(ir, totalPathWork, location) {
  let patternSteps = 0;
  for (let i = 0; i < ir.segments.length; i += 1) {
    const segment = ir.segments[i];
    patternSteps += segment.kind === 'double_star' ? 1 : segment.atoms.length + 1;
  }
  if (patternSteps * totalPathWork > GLOB_MATCH_STEP_BUDGET) {
    fail('match_work_exceeded', location,
      `${location} exceeds the ${GLOB_MATCH_STEP_BUDGET}-step aggregate batch match budget; chunk the batch.`);
  }
}

// Batch inputs are validated through a bounded numeric snapshot: proxies are
// rejected before Array.isArray, the length cap runs before any descriptor
// walk, and only index descriptors 0..length-1 are inspected. Expando,
// symbol-keyed, or inherited decorations are unreachable from that snapshot
// and are ignored without ever being enumerated or invoked, so attacker-sized
// key sets cost nothing. Accessor elements are rejected unread.
// Returns the summed path work for the aggregate budget check.
function assertPathBatch(paths, location) {
  if (utilTypes.isProxy(paths)) {
    fail('invalid_array', location, `${location} must be a concrete JSON array, not a Proxy.`);
  }
  if (!Array.isArray(paths)) {
    fail('invalid_type', location, `${location} must be an array of repository-relative paths.`);
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
  if (paths.length > REPO_PATH_BATCH_MAX) {
    fail('out_of_range', location, `${location} exceeds the ${REPO_PATH_BATCH_MAX}-path batch limit.`);
  }
  let totalPathWork = 0;
  for (let i = 0; i < paths.length; i += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(paths, i);
    } catch {
      fail('invalid_array', `${location}[${i}]`, `${location}[${i}] descriptor could not be inspected safely.`);
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid_array', `${location}[${i}]`, `${location}[${i}] must be an enumerable data element.`);
    }
    if (typeof paths[i] !== 'string') {
      fail('invalid_type', `${location}[${i}]`, `${location}[${i}] must be a string repository-relative path.`);
    }
    assertRepoRelativePath(paths[i], `${location}[${i}]`);
    totalPathWork += pathWorkOf(paths[i]);
  }
  return totalPathWork;
}

// Code points plus segment count: exactly the per-path DP work factor.
function pathWorkOf(value) {
  let work = 1;
  let codePoints = 0;
  for (const ch of value) {
    if (ch === '/') work += 1;
    else codePoints += 1;
  }
  return codePoints + work;
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
  const totalPathWork = assertPathBatch(paths, location);
  assertAggregateBatchBudget(ir, totalPathWork, location);
  const matched = [];
  for (let i = 0; i < paths.length; i += 1) {
    const elementLocation = `${location}[${i}]`;
    if (irMatchesPathSegments(ir, pathToCodePointSegments(paths[i], elementLocation), elementLocation)) {
      matched.push(paths[i]);
    }
  }
  return matched;
}

export function repoGlobMatchesAnyPath(pattern, paths, label = 'paths') {
  const location = guardLabel(label, 'paths');
  const ir = irOf(compileRepoGlob(pattern, 'pattern'));
  const totalPathWork = assertPathBatch(paths, location);
  assertAggregateBatchBudget(ir, totalPathWork, location);
  for (let i = 0; i < paths.length; i += 1) {
    const elementLocation = `${location}[${i}]`;
    if (irMatchesPathSegments(ir, pathToCodePointSegments(paths[i], elementLocation), elementLocation)) {
      return true;
    }
  }
  return false;
}
