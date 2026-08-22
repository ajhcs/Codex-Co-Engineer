import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GLOB_PATTERN_MAX_BYTES,
  REPO_PATH_MATCHER_ERROR_CODES,
  RepoPathMatcherError,
  assertRepoRelativePath,
  compileRepoGlob,
  compiledRepoGlobMatchesPath,
  isRepoRelativePath,
  repoGlobMatchesPath,
} from '../mcp/v3/repo-path-matcher.mjs';

function matchError(invoke, expectedCode) {
  try {
    invoke();
  } catch (error) {
    assert.ok(error instanceof RepoPathMatcherError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'RepoPathMatcherError');
    assert.equal(error.code, expectedCode);
    assert.equal(typeof error.location, 'string');
    assert.ok(error.location.length > 0);
    assert.ok(error.message.length > 0 && error.message.length < 768);
    return error;
  }
  assert.fail(`expected ${expectedCode}`);
}

const matches = (pattern, value) => repoGlobMatchesPath(pattern, value);

test('matcher error vocabulary is a frozen closed set', () => {
  assert.ok(Object.isFrozen(REPO_PATH_MATCHER_ERROR_CODES));
  const sorted = [...REPO_PATH_MATCHER_ERROR_CODES].sort();
  assert.deepEqual([...REPO_PATH_MATCHER_ERROR_CODES], sorted);
});

test('literal patterns are exact and case-sensitive', () => {
  assert.equal(matches('README.md', 'README.md'), true);
  assert.equal(matches('README.md', 'readme.md'), false);
  assert.equal(matches('src/index.ts', 'src/index.ts'), true);
  matchError(() => matches('src/index.ts', 'src/./index.ts'), 'invalid_format'); // alias paths are invalid input
  assert.equal(matches('a/b', 'a/b/c'), false);
  assert.equal(matches('a/b/c', 'a/b'), false);
  // No locale or case folding anywhere; code-point equality only.
  assert.equal(matches('STRASSE', 'straße'), false);
  assert.equal(matches('CAFÉ.md', 'CAFÉ.md'), true);
});

test("'*' matches zero or more code points inside one segment only", () => {
  assert.equal(matches('*', 'a'), true);
  assert.equal(matches('*', 'anything.txt'), true);
  assert.equal(matches('*', 'a/b'), false);
  assert.equal(matches('foo*', 'foo'), true);
  assert.equal(matches('foo*', 'foobar'), true);
  assert.equal(matches('foo*', 'foo/bar'), false);
  assert.equal(matches('*.ts', 'index.ts'), true);
  assert.equal(matches('*.ts', 'a/index.ts'), false);
  assert.equal(matches('a*c', 'abc'), true);
  assert.equal(matches('a*c', 'ac'), true);
});

test("'?' matches exactly one code point, counting astral characters once", () => {
  assert.equal(matches('?.txt', 'a.txt'), true);
  assert.equal(matches('?.txt', '.txt'), false);
  assert.equal(matches('?.txt', 'ab.txt'), false);
  assert.equal(matches('?.md', '\u{1F600}.md'), true); // one astral code point
  assert.equal(matches('??.md', '\u{1F600}\u{1F600}.md'), true);
  assert.equal(matches('?', 'a/b'), false);
});

test('classes match one code point from an explicit closed set', () => {
  assert.equal(matches('[abc].md', 'a.md'), true);
  assert.equal(matches('[abc].md', 'd.md'), false);
  assert.equal(matches('[a-z]+[0-9]', 'x+9'), true); // '+' is a literal here
  assert.equal(matches('[a-z]+[0-9]', 'x9'), false);
  assert.equal(matches('[a-cx-z]m', 'ym'), true);
  assert.equal(matches('[a-cx-z]m', 'dm'), false);
  assert.equal(matches('[α-ω].md', 'λ.md'), true); // ranges are code-point based
  assert.equal(matches('[α-ω].md', 'A.md'), false);
  assert.equal(matches('[A-Z]x', 'ax'), false); // case-sensitive classes
  // '-' is a literal when it cannot form a range.
  assert.equal(matches('[a-]x', '-x'), true);
  assert.equal(matches('[a-]x', 'ax'), true);
  assert.equal(matches('[-a]x', '-x'), true);
  assert.equal(matches('[--0]x', '-x'), true); // 0x2D..0x30 inclusive range
  assert.equal(matches('[--0]x', '0x'), true);
  // '/' can never be matched by a class: it is not a legal path character.
  matchError(() => matches('[--0]x', '/x'), 'invalid_format');
  // Braces are ordinary literals; brace expansion does not exist.
  assert.equal(matches('{a,b}.txt', '{a,b}.txt'), true);
  assert.equal(matches('{a,b}.txt', 'a.txt'), false);
});

test('whole-segment ** semantics: foo/** matches foo and descendants', () => {
  assert.equal(matches('foo/**', 'foo'), true);
  assert.equal(matches('foo/**', 'foo/bar'), true);
  assert.equal(matches('foo/**', 'foo/bar/baz/qux'), true);
  assert.equal(matches('foo/**', 'foobar'), false);
  assert.equal(matches('foo/**', 'bar/foo'), false);
});

test('whole-segment ** semantics: **/foo matches root and nested foo', () => {
  assert.equal(matches('**/foo', 'foo'), true);
  assert.equal(matches('**/foo', 'a/foo'), true);
  assert.equal(matches('**/foo', 'a/b/c/foo'), true);
  assert.equal(matches('**/foo', 'foo/bar'), false);
  assert.equal(matches('**/foo', 'afoof'), false);
});

test('bare ** matches every valid path; ** may repeat as whole segments', () => {
  assert.equal(matches('**', 'a'), true);
  assert.equal(matches('**', 'a/b/c/deep'), true);
  assert.equal(matches('**', 'file.txt'), true);
  assert.equal(matches('**/**', 'a/b'), true);
  assert.equal(matches('a/**/b', 'a/b'), true); // zero intermediate segments
  assert.equal(matches('a/**/b', 'a/x/y/b'), true);
  assert.equal(matches('a/**/b', 'a/b/c'), false);
  assert.equal(matches('src/**/*.ts', 'src/index.ts'), true);
  assert.equal(matches('src/**/*.ts', 'src/a/b/index.ts'), true);
  assert.equal(matches('src/**/*.ts', 'lib/index.ts'), false);
});

test('embedded double stars fail closed with a typed error', () => {
  matchError(() => matches('a**b', 'ab'), 'pattern_double_star');
  matchError(() => matches('**b', 'b'), 'pattern_double_star');
  matchError(() => matches('a**', 'a'), 'pattern_double_star');
  matchError(() => matches('***', 'a'), 'pattern_double_star');
  matchError(() => matches('a/b**c', 'a/bc'), 'pattern_double_star');
  assert.equal(matchError(() => matches('a**b', 'ab'), 'pattern_double_star').location,
    'pattern.segments[0]');
  assert.equal(matchError(() => matches('x/a**b', 'x/ab'), 'pattern_double_star').location,
    'pattern.segments[1]');
});

test('malformed classes fail closed with stable typed errors', () => {
  matchError(() => matches('[abc', 'a'), 'pattern_unclosed_class');
  matchError(() => matches('[abc/', 'a'), 'invalid_format'); // trailing slash is structural
  matchError(() => matches('x/[ab', 'x/a'), 'pattern_unclosed_class');
  matchError(() => matches('[]', 'x'), 'pattern_empty_class');
  matchError(() => matches('[]a', 'xa'), 'pattern_empty_class');
  matchError(() => matches('[z-a]', 'y'), 'pattern_reversed_range');
  matchError(() => matches('[9-0]', '5'), 'pattern_reversed_range');
  matchError(() => matches('[a-a]', 'a'), 'pattern_reversed_range'); // degenerate range
  matchError(() => matches('[!a]', 'b'), 'pattern_class_negation');
  matchError(() => matches('[^a]', 'b'), 'pattern_class_negation');
});

test('unsupported pattern syntax fails closed as invalid_format', () => {
  matchError(() => matches('a\\*b', 'ab'), 'invalid_format'); // escapes rejected outright
  matchError(() => matches('', ''), 'invalid_format');
  matchError(() => matches('/abs', 'abs'), 'invalid_format');
  matchError(() => matches('trailing/', 'trailing'), 'invalid_format');
  matchError(() => matches('a//b', 'a/b'), 'invalid_format');
  matchError(() => matches('./a', 'a'), 'invalid_format');
  matchError(() => matches('../a', 'a'), 'invalid_format');
  matchError(() => matches('.', '.'), 'invalid_format');
  matchError(() => matches(42, 'a'), 'invalid_type');
  matchError(() => matches(null, 'a'), 'invalid_type');
});

test('paths must be normalized NFC UTF-8 POSIX repository-relative paths', () => {
  matchError(() => matches('a', ''), 'invalid_format');
  matchError(() => matches('a', '/abs'), 'invalid_format');
  matchError(() => matches('a', 'a/'), 'invalid_format');
  matchError(() => matches('a', 'a//b'), 'invalid_format');
  matchError(() => matches('a', './a'), 'invalid_format');
  matchError(() => matches('a', 'a/../b'), 'invalid_format');
  matchError(() => matches('a', '..'), 'invalid_format');
  matchError(() => matches('a\\b', 'a'), 'invalid_format');
  matchError(() => matches('a', 'a\u0000b'), 'invalid_format'); // NUL
  matchError(() => matches('a', 'a\u001Fb'), 'invalid_format'); // C0 control
  matchError(() => matches('a', 'a\u007Fb'), 'invalid_format'); // DEL
  matchError(() => matches('a', 'a\u0085b'), 'invalid_format'); // C1 control
  matchError(() => matches('a', 'a\u202Eb'), 'invalid_format'); // bidi override
  matchError(() => matches('a', 'a\u2066b'), 'invalid_format'); // bidi isolate
  matchError(() => matches('a', 'cafe\u0301.md'), 'invalid_format'); // NFD, not NFC
  matchError(() => matches('a', null), 'invalid_type');
  matchError(() => matches('a', undefined), 'invalid_type');
  matchError(() => matches('a', ['a']), 'invalid_type');
  // A lone surrogate cannot be encoded as UTF-8 and is rejected.
  matchError(() => matches('a', 'bad\uD800path'), 'invalid_format');
});

test('path and pattern byte/segment bounds fail closed as out_of_range', () => {
  matchError(() => matches('a', `${'s'.repeat(4097)}`), 'out_of_range');
  matchError(() => matches('a', `${'s/'.repeat(64)}end`), 'out_of_range'); // 65 segments
  matchError(() => matches('a', `${'s'.repeat(256)}.md`), 'out_of_range'); // segment > 255 bytes
  // Two NAME_MAX-sized segments are legal; a single 4096-byte segment is not.
  assert.equal(isRepoRelativePath(`${'s'.repeat(255)}/${'t'.repeat(255)}`), true);
  matchError(() => matches('a', `${'s'.repeat(4096)}`), 'out_of_range');
  matchError(() => matches(`${'p'.repeat(257)}`, 'a'), 'out_of_range');
  matchError(() => matches(Array.from({ length: 17 }, (_, i) => `s${i}`).join('/'), 'a'), 'out_of_range');
  matchError(() => matches(`${'q'.repeat(129)}/b`, 'a'), 'out_of_range');
  assert.equal(matches('a*a*a*/x', 'abacax/x'), true); // separated single '*' atoms are legal
  matchError(() => matches('****/x', 'aaaa/x'), 'pattern_double_star');
});

test('NFC-normalized unicode paths and patterns match by code point', () => {
  assert.equal(matches('café/naïve.md', 'café/naïve.md'), true);
  assert.equal(matches('[áéíóú]/x', 'é/x'), true);
  assert.equal(matches('日付/*.log', '日付/2026-08-22.log'), true);
  matchError(() => matches('cafe\u0301/x', 'café/x'), 'invalid_format'); // non-NFC pattern
});

test('validation pipeline order is fixed so first errors are deterministic', () => {
  // Pattern errors precede path errors in repoGlobMatchesPath.
  const patternFirst = matchError(() => matches('[unclosed', '/also/bad'), 'pattern_unclosed_class');
  // Identical inputs produce identical code, location, and message every time.
  for (let i = 0; i < 3; i += 1) {
    const again = matchError(() => matches('[unclosed', '/also/bad'), 'pattern_unclosed_class');
    assert.equal(again.code, patternFirst.code);
    assert.equal(again.location, patternFirst.location);
    assert.equal(again.message, patternFirst.message);
  }
  // Per-segment scan order: the leftmost bad segment wins.
  assert.equal(
    matchError(() => matches('ok/../later', 'x'), 'invalid_format').location,
    'pattern.segments[1]',
  );
  // Structural checks precede character scans within one pipeline.
  assert.equal(matchError(() => matches('..', 'x'), 'invalid_format').location, 'pattern.segments[0]');
});

test('compileRepoGlob returns a frozen reusable compilation', () => {
  const compiled = compileRepoGlob('src/**/*.ts');
  assert.ok(Object.isFrozen(compiled));
  assert.ok(Object.isFrozen(compiled.segments));
  assert.equal(compiled.pattern, 'src/**/*.ts');
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'src/a/b.ts'), true);
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'lib/a/b.ts'), false);
  matchError(() => compiledRepoGlobMatchesPath({}, 'src/a.ts'), 'invalid_type');
  matchError(() => compiledRepoGlobMatchesPath(new Proxy(compileRepoGlob('a'), {}), 'a'),
    'invalid_type');
});

test('isRepoRelativePath classifies without throwing', () => {
  assert.equal(isRepoRelativePath('src/index.ts'), true);
  assert.equal(isRepoRelativePath('/etc/passwd'), false);
  assert.equal(isRepoRelativePath('a\nb'), false);
  assert.equal(isRepoRelativePath(42), false);
  assert.equal(isRepoRelativePath(null), false);
});

test('a pattern at the exact byte cap is still matchable', () => {
  assert.equal(GLOB_PATTERN_MAX_BYTES, 256);
  const left = 'a'.repeat(126);
  const right = 'b'.repeat(127);
  const atCap = `${left}/${right}/x`;
  assert.equal(Buffer.byteLength(atCap, 'utf8'), GLOB_PATTERN_MAX_BYTES);
  assert.equal(matches(atCap, `${left}/${right}/x`), true);
  assert.equal(matches(atCap, 'a/x'), false);
});
