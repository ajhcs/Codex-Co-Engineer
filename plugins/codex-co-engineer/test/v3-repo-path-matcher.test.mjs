import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  filterRepoPathsByGlob,
  GLOB_MATCH_STEP_BUDGET,
  GLOB_PATTERN_MAX_BYTES,
  GLOB_PATTERN_MAX_SEGMENTS,
  REPO_PATH_BATCH_MAX,
  repoGlobMatchesAnyPath,
  REPO_PATH_MAX_BYTES,
  REPO_PATH_MATCHER_ERROR_CODES,
  REPO_PATH_MATCHER_ID,
  RepoPathMatcherError,
  assertRepoRelativePath,
  compileRepoGlob,
  compiledRepoGlobMatchesPath,
  isRepoRelativePath,
  repoGlobMatchesPath,
  utf8ByteLength,
} from '../mcp/v3/repo-path-matcher.mjs';
import {
  scopeStaticPrefix,
  writerScopesOverlap,
} from '../mcp/v3/run-manifest.mjs';

const FIXTURES = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/v3-repo-path-matcher.json', import.meta.url)),
  'utf8',
));

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

test('extglob opener sequences are rejected; braces and bare pipes stay literal', () => {
  for (const opener of ['@(a|b)', '+(a)', '!(a)', '?(a)', '*(a)']) {
    const error = matchError(() => matches(opener, 'a'), 'pattern_extglob');
    assert.equal(error.location, 'pattern.segments[0]');
    assert.ok(!error.message.includes(opener)); // content-free diagnostic
  }
  assert.equal(matchError(() => matches('x/@(y)', 'x/y'), 'pattern_extglob').location,
    'pattern.segments[1]');
  matchError(() => matches('x/+(y)', 'x/y'), 'pattern_extglob');
  matchError(() => matches('x/!(y)', 'x/y'), 'pattern_extglob');
  matchError(() => matches('x/?(y)', 'x/y'), 'pattern_extglob');
  matchError(() => matches('x/*(y)', 'x/y'), 'pattern_extglob');
  // A '(' alone or after any other character is still an ordinary literal.
  assert.equal(matches('(a)', '(a)'), true);
  // Braces are ordinary literals; brace expansion does not exist anywhere in
  // this ingress, and the docs say exactly that.
  assert.equal(matches('{a,b}.txt', '{a,b}.txt'), true);
  assert.equal(matches('{a,b}.txt', 'a.txt'), false);
  assert.equal(matches('{a,b}.txt', 'b.txt'), false);
  // A bare '|' outside extglob remains a literal.
  assert.equal(matches('a|b', 'a|b'), true);
  assert.equal(matches('a|b', 'a'), false);
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

test('compileRepoGlob returns an opaque provenance-authenticated handle', () => {
  const compiled = compileRepoGlob('src/**/*.ts');
  // The handle carries only frozen primitives; no segment/atom/Set/range
  // internal is reachable from it.
  assert.ok(Object.isFrozen(compiled));
  assert.deepEqual([...Object.getOwnPropertyNames(compiled)], ['id', 'pattern']);
  assert.equal(compiled.id, REPO_PATH_MATCHER_ID);
  assert.equal(compiled.pattern, 'src/**/*.ts');
  assert.equal(compiled.segments, undefined);
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'src/a/b.ts'), true);
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'lib/a/b.ts'), false);
});

test('forged handles fail closed without driving matching', () => {
  const genuine = compileRepoGlob('src/**/*.ts');
  const forgeries = [
    undefined,
    null,
    {},
    { id: REPO_PATH_MATCHER_ID },
    { id: REPO_PATH_MATCHER_ID, pattern: 'src/**/*.ts' },
    { id: REPO_PATH_MATCHER_ID, segments: [{ kind: 'segment', atoms: [{ type: 'star' }] }] },
    Object.create(compileRepoGlob('a')),
    JSON.parse(JSON.stringify({ id: REPO_PATH_MATCHER_ID })),
  ];
  for (const forgery of forgeries) {
    matchError(() => compiledRepoGlobMatchesPath(forgery, 'src/a.ts'), 'invalid_type');
    matchError(() => compiledRepoGlobMatchesPath(forgery, 'anything/at/all'), 'invalid_type');
  }
  // A forged segments shape can never be smuggled past provenance: matching
  // reads only module-private IR, so getter-backed atoms never execute.
  let getterRan = false;
  const hostile = {
    id: REPO_PATH_MATCHER_ID,
    get segments() {
      getterRan = true;
      return [{ kind: 'segment', atoms: [{ type: 'star' }] }];
    },
  };
  matchError(() => compiledRepoGlobMatchesPath(hostile, 'x'), 'invalid_type');
  assert.equal(getterRan, false);
  void genuine;
});

test('active and revoked proxies of handles are rejected before any read', () => {
  matchError(() => compiledRepoGlobMatchesPath(new Proxy(compileRepoGlob('a'), {}), 'a'),
    'invalid_type');
  const { proxy, revoke } = Proxy.revocable(compileRepoGlob('a'), {});
  revoke();
  matchError(() => compiledRepoGlobMatchesPath(proxy, 'a'), 'invalid_type');
  const forgedProxy = new Proxy({ id: REPO_PATH_MATCHER_ID }, {});
  matchError(() => compiledRepoGlobMatchesPath(forgedProxy, 'a'), 'invalid_type');
});

test('mutation of every prior public alias has no effect on matching', () => {
  const compiled = compileRepoGlob('src/*.ts');
  const aliases = ['segments', 'segments.0.atoms', 'segments.0.kind'];
  for (const alias of aliases) {
    let cursor = compiled;
    const parts = alias.split('.');
    for (const part of parts.slice(0, -1)) cursor = cursor?.[part];
    try {
      cursor[parts.at(-1)] = [{ type: 'star' }];
    } catch {
      // Frozen surfaces throw; absent surfaces silently ignore. Either way
      // matching must be unchanged.
    }
  }
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'deep/nested/a.ts'), false);
  assert.equal(compiledRepoGlobMatchesPath(compileRepoGlob('src/*.ts'), 'src/a.ts'), true);
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

test('every golden fixture entry conforms in file order', () => {
  assert.equal(FIXTURES.id, 'codex-co-engineer.repo-path-matcher.v1.fixtures');
  assert.ok(Array.isArray(FIXTURES.matches) && FIXTURES.matches.length >= 30);
  assert.ok(Array.isArray(FIXTURES.rejections) && FIXTURES.rejections.length >= 15);
  for (const entry of FIXTURES.matches) {
    assert.equal(repoGlobMatchesPath(entry.pattern, entry.path), entry.expected,
      `fixture mismatch for ${JSON.stringify(entry)}`);
  }
  for (const entry of FIXTURES.rejections) {
    matchError(() => repoGlobMatchesPath(entry.pattern, 'probe'), entry.code);
  }
});

test('fixtures exercise every pattern-specific typed error code', () => {
  const covered = new Set(FIXTURES.rejections.map((entry) => entry.code));
  for (const code of [
    'pattern_unclosed_class', 'pattern_empty_class', 'pattern_reversed_range',
    'pattern_class_negation', 'pattern_double_star', 'pattern_extglob',
  ]) {
    assert.ok(covered.has(code), `fixture set must cover ${code}`);
    assert.ok(REPO_PATH_MATCHER_ERROR_CODES.includes(code));
  }
});

test('filterRepoPathsByGlob preserves input order and fails closed on any bad element', () => {
  const paths = ['src/a.ts', 'lib/b.ts', 'src/deep/c.ts', 'docs/x.md'];
  assert.deepEqual(filterRepoPathsByGlob('src/**/*.ts', paths),
    ['src/a.ts', 'src/deep/c.ts']);
  assert.deepEqual(filterRepoPathsByGlob('**', paths), paths);
  assert.deepEqual(filterRepoPathsByGlob('**', []), []);
  // A trailing invalid element rejects the whole call; no partial answer.
  matchError(() => filterRepoPathsByGlob('**', ['ok.txt', '/absolute']),
    'invalid_format');
  matchError(() => filterRepoPathsByGlob('**', ['ok.txt', 42]), 'invalid_type');
  matchError(() => filterRepoPathsByGlob('[bad', ['ok.txt']), 'pattern_unclosed_class');
  // The returned array is fresh data; mutating it cannot alias the input.
  const filtered = filterRepoPathsByGlob('**', ['a.md']);
  filtered.push('injected');
  assert.deepEqual(filterRepoPathsByGlob('**', ['a.md']), ['a.md']);
});

test('repoGlobMatchesAnyPath validates the whole batch before answering', () => {
  assert.equal(repoGlobMatchesAnyPath('lib/**', ['src/a.ts', 'lib/b.ts']), true);
  assert.equal(repoGlobMatchesAnyPath('lib/**', ['src/a.ts', 'docs/c.md']), false);
  // Early match must not skip validation of later elements.
  matchError(() => repoGlobMatchesAnyPath('src/*', ['src/a.ts', 'bad//path']),
    'invalid_format');
  matchError(() => repoGlobMatchesAnyPath('*', 'not-an-array'), 'invalid_type');
});

test('batch inputs are plain JSON arrays; traps and exotica are rejected untouched', () => {
  let trapCount = 0;
  const handler = {
    get(target, prop, receiver) {
      trapCount += 1;
      return Reflect.get(target, prop, receiver);
    },
  };
  matchError(() => filterRepoPathsByGlob('src/**', new Proxy(['src/a.ts'], handler)),
    'invalid_array');
  assert.equal(trapCount, 0); // rejected before a single trap dispatch

  matchError(() => { class Sub extends Array {} ; return filterRepoPathsByGlob('src/**', Sub.from(['src/a.ts'])); },
    'invalid_array');
  matchError(() => filterRepoPathsByGlob('src/**', (() => {
    const array = ['src/a.ts'];
    Object.defineProperty(array, '0', { get() { throw new Error('trap dispatched'); }, enumerable: true });
    return array;
  })()), 'invalid_array');
  // Revoked proxies must fail typed, never with a native TypeError from
  // Array.isArray's IsArray operation.
  const { proxy, revoke } = Proxy.revocable(['src/a.ts'], {});
  revoke();
  matchError(() => filterRepoPathsByGlob('src/**', proxy), 'invalid_array');
  matchError(() => repoGlobMatchesAnyPath('src/**', (() => {
    const array = new Array(3);
    array[2] = 'src/a.ts';
    return array;
  })()), 'invalid_array');
  // Expando, symbol-keyed, and inherited decorations are unreachable from
  // the bounded numeric descriptor snapshot; they are ignored without being
  // enumerated, and an attacker-sized key set costs no enumeration work.
  const decorated = ['src/a.ts'];
  decorated[Symbol('extra')] = 1;
  decorated.expando = 'ignored';
  assert.deepEqual(filterRepoPathsByGlob('src/**', decorated), ['src/a.ts']);
  const hugeExpando = ['src/deep/a.ts'];
  for (let i = 0; i < 200_000; i += 1) hugeExpando[`e${i}`] = i;
  const expandoStarted = process.hrtime.bigint();
  assert.deepEqual(filterRepoPathsByGlob('src/**', hugeExpando), ['src/deep/a.ts']);
  const expandoMs = Number(process.hrtime.bigint() - expandoStarted) / 1e6;
  assert.ok(expandoMs < 250, `decoration enumeration leaked: ${expandoMs}ms`);
  // Null-prototype dense string arrays are legitimate JSON data.
  const nullProto = ['src/a.ts'];
  Object.setPrototypeOf(nullProto, null);
  assert.deepEqual(filterRepoPathsByGlob('src/**', nullProto), ['src/a.ts']);
});

test('accessor elements are rejected without dispatching a single trap', () => {
  let reads = 0;
  const getterArray = ['ok.txt'];
  Object.defineProperty(getterArray, '1', {
    get() {
      reads += 1;
      return '/absolute';
    },
    enumerable: true,
  });
  getterArray.length = 2;
  matchError(() => filterRepoPathsByGlob('**', getterArray), 'invalid_array');
  assert.equal(reads, 0); // rejected on the descriptor alone

  // An oversized batch is rejected at the O(1) length cap before any element
  // or descriptor is touched.
  const oversized = new Array(1025);
  Object.defineProperty(oversized, '1024', {
    get() {
      reads += 1;
      throw new Error('element read past the cap');
    },
    enumerable: true,
  });
  matchError(() => filterRepoPathsByGlob('**', oversized), 'out_of_range');
  assert.equal(reads, 0);
});

test('batch size is bounded', () => {
  const atCap = Array.from({ length: REPO_PATH_BATCH_MAX }, (_, i) => `dir-${i % 7}/f${i}.txt`);
  assert.equal(filterRepoPathsByGlob('dir-0/*.txt', atCap).length, Math.ceil(REPO_PATH_BATCH_MAX / 7));
  const overCap = [...atCap, 'one-more.txt'];
  matchError(() => filterRepoPathsByGlob('**', overCap), 'out_of_range');
  matchError(() => repoGlobMatchesAnyPath('**', overCap), 'out_of_range');
});

test('matching stays bounded on worst-case-shaped inputs under the caps', () => {
  // A wildcard-heavy 16-segment pattern (the segment cap) against paths at
  // the byte-cap edge fills the largest legal DP matrix yet completes
  // promptly with exact answers in both directions.
  const hostilePattern = Array.from({ length: 16 }, () => '*[a-d]*?').join('/');
  const wideSegment = 'a'.repeat(60);
  const fullPath = Array.from({ length: 16 }, () => wideSegment).join('/');
  const deeperPath = Array.from({ length: 64 }, () => wideSegment).join('/');
  const startedAt = process.hrtime.bigint();
  assert.equal(repoGlobMatchesPath(hostilePattern, fullPath), true); // every pair evaluated
  assert.equal(repoGlobMatchesPath(hostilePattern, deeperPath), false); // full matrix, negative answer
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 2_000, `bounded work violated: ${elapsedMs}ms`);
  // One segment past the pattern's depth still runs the full bounded matrix
  // and answers false; the depth cap rejection is covered by 65-segment paths.
  assert.equal(repoGlobMatchesPath(hostilePattern, `${fullPath}/a`), false);
  // The budget constant exists as defense in depth above the caps' product.
  assert.ok(GLOB_MATCH_STEP_BUDGET > 33_554_432);
});

test('the aggregate batch budget rejects the legal-cap stress before the first match', () => {
  // Every input is individually legal: 1024 paths (batch cap) of 16 segments
  // x 254 bytes each (4079-byte path, under every path cap) against a
  // wildcard-heavy 16-segment pattern.
  const segment = 'a'.repeat(254);
  const stressPath = Array.from({ length: 16 }, () => segment).join('/');
  assert.equal(Buffer.byteLength(stressPath, 'utf8'), 4079);
  const batch = Array.from({ length: REPO_PATH_BATCH_MAX }, () => stressPath);
  const pattern = Array.from({ length: GLOB_PATTERN_MAX_SEGMENTS }, () => '*[a-d]*?').join('/');
  const startedAt = process.hrtime.bigint();
  matchError(() => filterRepoPathsByGlob(pattern, batch), 'match_work_exceeded');
  matchError(() => repoGlobMatchesAnyPath(pattern, batch), 'match_work_exceeded');
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 500, `aggregate rejection was not fast: ${elapsedMs}ms`);
  // The same batch stays answerable when the product fits the budget.
  assert.equal(filterRepoPathsByGlob('**', batch).length, REPO_PATH_BATCH_MAX);
  assert.deepEqual(filterRepoPathsByGlob(pattern, ['src/x.ts']), []); // single-path semantics intact
  // The same pattern/path pair answers exactly on a single call; only the
  // aggregate batch product crosses the budget.
  assert.equal(repoGlobMatchesPath(pattern, stressPath), true);
  // Deterministic typed failure on repeat calls.
  const first = matchError(() => filterRepoPathsByGlob(pattern, batch), 'match_work_exceeded');
  const again = matchError(() => filterRepoPathsByGlob(pattern, batch), 'match_work_exceeded');
  assert.equal(again.code, first.code);
  assert.equal(again.location, first.location);
  assert.equal(again.message, first.message);
});

test('hostile labels collapse to constant bounded locations', () => {
  const hostileLabels = [
    `${'L'.repeat(100_000)}secret`,
    { toString() { throw new Error('label getter must never run'); } },
    42,
    null,
    Symbol('label'),
    ['paths'],
    'bad\u0000control',
    'x'.repeat(129),
  ];
  for (const label of hostileLabels) {
    const error = matchError(() => repoGlobMatchesPath('[bad', 'probe-path', label),
      'pattern_unclosed_class');
    assert.equal(error.location, 'pattern.segments[0]');
    assert.ok(error.message.length < 256);
    assert.ok(!error.message.includes('secret'));
    const batchError = matchError(() => repoGlobMatchesAnyPath('*', 'not-an-array', label),
      'invalid_type');
    assert.equal(batchError.location, 'paths');
  }
  // Safe labels pass through verbatim on their side of the call: pattern
  // diagnostics keep the fixed 'pattern' prefix; path diagnostics use the
  // caller's label. Derived element locations stay bounded.
  const patternSide = matchError(() => repoGlobMatchesPath('[bad', 'probe-path', 'scope-a'),
    'pattern_unclosed_class');
  assert.equal(patternSide.location, 'pattern.segments[0]');
  const pathSide = matchError(() => repoGlobMatchesPath('src/x.ts', '/abs', 'scope-a'),
    'invalid_format');
  assert.equal(pathSide.location, 'scope-a');
  const element = matchError(() => filterRepoPathsByGlob('**', ['a//b'], 'lane-1'),
    'invalid_format');
  assert.equal(element.location, 'lane-1[0].segments[1]');
  const structural = matchError(() => filterRepoPathsByGlob('**', ['/abs'], 'lane-2'),
    'invalid_format');
  assert.equal(structural.location, 'lane-2[0]');
});

test('utf8ByteLength is strictly string-only and typed', () => {
  assert.equal(utf8ByteLength('café'), 5);
  assert.equal(utf8ByteLength('\u{1F600}'), 4);
  for (const hostile of [Symbol('x'), 42, null, undefined, {}, ['x'], { toString() { throw new Error('ran'); } }]) {
    matchError(() => utf8ByteLength(hostile), 'invalid_type');
  }
});

test('new typed errors are deterministic across repeats', () => {
  const probes = [
    [() => matches('@(a)', 'a'), 'pattern_extglob'],
    [() => matches(String.fromCharCode(0), 'x'), 'invalid_format'],
    [() => filterRepoPathsByGlob('**', new Proxy([], {})), 'invalid_array'],
  ];
  for (const [invoke, code] of probes) {
    const first = matchError(invoke, code);
    for (let i = 0; i < 3; i += 1) {
      const repeat = matchError(invoke, code);
      assert.equal(repeat.code, first.code);
      assert.equal(repeat.location, first.location);
      assert.equal(repeat.message, first.message);
    }
  }
});

test('matcher authority stays separate from the writer-overlap safety check', () => {
  // The conservative ASCII-case-folded overlap policy keeps its semantics.
  assert.deepEqual(scopeStaticPrefix('Foo/Bar'), ['foo', 'bar']);
  assert.equal(writerScopesOverlap('FOO/bar', 'foo/baz'), false); // distinct comparable prefixes
  assert.equal(writerScopesOverlap('FOO/bar', 'foo/BAR'), true); // ASCII case folding over-approximates
  assert.equal(writerScopesOverlap('**/x', 'a/y'), true); // empty prefix matches anywhere
  assert.equal(writerScopesOverlap('a/x', 'b/y'), false);
  // The matcher, by contrast, is exact case-sensitive membership: the same
  // pair the overlap policy calls overlapping does not member-match.
  assert.equal(repoGlobMatchesPath('FOO/bar', 'foo/BAR'), false);
  assert.equal(repoGlobMatchesPath('FOO/*', 'foo/bar'), false);
  assert.equal(repoGlobMatchesPath('foo/bar', 'foo/bar'), true);
  assert.equal(repoGlobMatchesPath('foo/**', 'foo/bar/baz'), true);
  // Structural independence: the matcher module never imports run-manifest.
  const matcherSource = readFileSync(
    fileURLToPath(new URL('../mcp/v3/repo-path-matcher.mjs', import.meta.url)),
    'utf8',
  );
  assert.ok(!matcherSource.includes("from './run-manifest"));
  assert.ok(!matcherSource.includes('import('));
});

// ---- P02R9 repair: focused hostile regression matrix. ---------------------

test('matcher authority stays module-private; the export surface leaks nothing', async () => {
  const matcher = await import('../mcp/v3/repo-path-matcher.mjs');
  const exportNames = Object.keys(matcher).sort();
  // The public surface stays closed: no IR, segments, ranges, sets, maps, and
  // no cardinality/role authority ever leaks out of the module.
  assert.deepEqual(exportNames, [
    'GLOB_MATCH_STEP_BUDGET',
    'GLOB_PATTERN_MAX_BYTES',
    'GLOB_PATTERN_MAX_SEGMENTS',
    'GLOB_PATTERN_SEGMENT_MAX_BYTES',
    'REPO_PATH_BATCH_MAX',
    'REPO_PATH_MATCHER_ERROR_CODES',
    'REPO_PATH_MATCHER_ID',
    'REPO_PATH_MAX_BYTES',
    'REPO_PATH_MAX_SEGMENTS',
    'REPO_PATH_SEGMENT_MAX_BYTES',
    'RepoPathMatcherError',
    'assertRepoRelativePath',
    'compileRepoGlob',
    'compiledRepoGlobMatchesPath',
    'filterRepoPathsByGlob',
    'isRepoRelativePath',
    'repoGlobMatchesAnyPath',
    'repoGlobMatchesPath',
    'utf8ByteLength',
  ]);
  // No export is an authority handle: no IR, atom arrays, sets, maps, or
  // cardinality/role surface ever leaves the module.
  for (const name of exportNames) {
    assert.ok(!/^(?:ir|irByHandle|byHandle|segments?|atoms?|singles|ranges?|classMembers|weakMap|.*(?:Role|Cardinality).*)$/i.test(name),
      `leaky export: ${name}`);
  }
});

test('copied, serialized, cloned, or derived handle shapes have zero authority', () => {
  const compiled = compileRepoGlob('src/**/*.ts');
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'src/a.ts'), true);
  // Field-identical copies confer nothing: authority is the private WeakMap
  // object identity, not the visible id/pattern data.
  const spreadCopy = { ...compiled };
  assert.equal(spreadCopy.id, compiled.id);
  assert.equal(spreadCopy.pattern, compiled.pattern);
  matchError(() => compiledRepoGlobMatchesPath(spreadCopy, 'src/a.ts'), 'invalid_type');
  const jsonCopy = JSON.parse(JSON.stringify(compiled));
  matchError(() => compiledRepoGlobMatchesPath(jsonCopy, 'src/a.ts'), 'invalid_type');
  const structuredCopy = structuredClone(compiled);
  matchError(() => compiledRepoGlobMatchesPath(structuredCopy, 'src/a.ts'), 'invalid_type');
  const derived = Object.create(compiled);
  matchError(() => compiledRepoGlobMatchesPath(derived, 'src/a.ts'), 'invalid_type');
  // A mutated copy is equally powerless.
  const mutatedCopy = { ...compiled, pattern: '**' };
  matchError(() => compiledRepoGlobMatchesPath(mutatedCopy, 'src/a.ts'), 'invalid_type');
});

test('mutating a genuine handle cannot disturb matching; its fields are inert', () => {
  const compiled = compileRepoGlob('src/*.ts');
  // The handle is deeply frozen: mutation attempts throw in strict mode...
  assert.throws(() => { compiled.id = 'forged'; }, TypeError);
  assert.throws(() => { compiled.pattern = '**'; }, TypeError);
  assert.equal(compiled.id, REPO_PATH_MATCHER_ID);
  assert.equal(compiled.pattern, 'src/*.ts');
  // ...and matching is untouched either way.
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'src/a.ts'), true);
  assert.equal(compiledRepoGlobMatchesPath(compiled, 'lib/a.ts'), false);
});

test('matching never rereads public handle fields: forged getters stay unread', () => {
  let reads = 0;
  const forge = {};
  for (const field of ['id', 'pattern', 'segments', 'atoms', 'singles', 'ranges']) {
    Object.defineProperty(forge, field, {
      enumerable: true,
      get() {
        reads += 1;
        return field === 'id' ? REPO_PATH_MATCHER_ID : [{ type: 'star' }];
      },
    });
  }
  forge.toString = () => { throw new Error('coercion must never run'); };
  matchError(() => compiledRepoGlobMatchesPath(forge, 'anything/at/all'), 'invalid_type');
  assert.equal(reads, 0); // provenance was decided before a single field read
});

test('the matcher module source stays free of mutable dynamic surfaces', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../mcp/v3/repo-path-matcher.mjs', import.meta.url)),
    'utf8',
  );
  for (const forbidden of [
    '.test(', '.exec(', 'new RegExp', 'new Set', 'new Map', 'SAFE_LABEL_PATTERN',
    '.push(', '.map(', '.fill(', '.sort(', '.splice(',
    '.split(', '.includes(', '.startsWith(', '.endsWith(', '.codePointAt(',
    'for (const ', 'Symbol.iterator', 'JSON.', 'Object.assign', 'structuredClone',
    'globalThis.', 'eval(',
  ]) {
    assert.ok(!source.includes(forbidden), `matcher source must not use ${forbidden}`);
  }
  // The capture block, the shared parity pipeline, and the charged budget
  // must exist verbatim.
  for (const required of [
    'callBound(', 'IR_BY_HANDLE', 'chargedPatternSteps', 'reflectApply(functionProtoBind',
    'snapshotPathBatch', 'assertValidatedOffsets', 'next[0] = current[0]',
  ]) {
    assert.ok(source.includes(required), `matcher source must contain ${required}`);
  }
});

test('patched intrinsics after import cannot alter acceptance or bounds', async (t) => {
  const m = await import('../mcp/v3/repo-path-matcher.mjs');
  const { Buffer: NodeBuffer } = await import('node:buffer');
  // Captured BEFORE any poisoning so install/restore always work.
  const realDefineProperty = Object.defineProperty;
  const realGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

  const patch = (owner, prop, replacement) => {
    const original = realGetOwnPropertyDescriptor(owner, prop);
    realDefineProperty(owner, prop, {
      value: replacement, writable: true, enumerable: false, configurable: true,
    });
    return () => {
      if (original) realDefineProperty(owner, prop, original);
      else delete owner[prop];
    };
  };

  // Everything here runs inside a patch window; only plain values leave it.
  const standardProbe = () => {
    const codeOf = (invoke) => {
      try {
        invoke();
        return 'accepted';
      } catch (error) {
        return error instanceof RepoPathMatcherError ? error.code : `foreign:${error.name}`;
      }
    };
    return {
      literal: m.repoGlobMatchesPath('café.md', 'café.md'),
      star: m.repoGlobMatchesPath('src/*.ts', 'src/a.ts'),
      starNegative: m.repoGlobMatchesPath('src/*.ts', 'src/deep/b.ts'),
      cls: m.repoGlobMatchesPath('[a-c]t', 'bt'),
      doubleStar: m.repoGlobMatchesPath('src/**/*.ts', 'src/x/y.ts'),
      astral: m.repoGlobMatchesPath('?.md', '\u{1F600}.md'),
      batch: m.filterRepoPathsByGlob('**', ['x.md', 'y.ts']),
      nfdCode: codeOf(() => m.repoGlobMatchesPath('a', 'cafe\u0301')),
      aliasCode: codeOf(() => m.repoGlobMatchesPath('a', 'a//b')),
      escapeCode: codeOf(() => m.compileRepoGlob('a\\b')),
      proxyCode: codeOf(() => m.filterRepoPathsByGlob('**', new Proxy([], {}))),
    };
  };

  const cases = [
    ['String.prototype.normalize lies about NFC',
      () => patch(String.prototype, 'normalize', () => 'XX')],
    ['String.prototype.charCodeAt collapses every unit',
      () => patch(String.prototype, 'charCodeAt', () => 65)],
    ['String.prototype.slice blanks every read',
      () => patch(String.prototype, 'slice', () => '')],
    ['String.prototype.split is poisoned',
      () => patch(String.prototype, 'split', () => ['pwned'])],
    ['String.prototype.includes lies true',
      () => patch(String.prototype, 'includes', () => true)],
    ['String.prototype.startsWith/endsWith lie true', () => {
      const undoStart = patch(String.prototype, 'startsWith', () => true);
      const undoEnd = patch(String.prototype, 'endsWith', () => true);
      return () => { undoEnd(); undoStart(); };
    }],
    ['string @@iterator throws', () => patch(String.prototype, Symbol.iterator,
      () => { throw new Error('iteration must not run'); })],
    ['array @@iterator throws', () => patch(Array.prototype, Symbol.iterator,
      () => { throw new Error('iteration must not run'); })],
    ['Array.prototype mutators are poisoned', () => {
      const undoPush = patch(Array.prototype, 'push', () => 0);
      const undoMap = patch(Array.prototype, 'map', () => { throw new Error('ran'); });
      const undoSort = patch(Array.prototype, 'sort', () => { throw new Error('ran'); });
      return () => { undoSort(); undoMap(); undoPush(); };
    }],
    ['Array.isArray lies true', () => patch(Array, 'isArray', () => true)],
    ['Object.getOwnPropertyDescriptor lies benignly', () => patch(Object,
      'getOwnPropertyDescriptor',
      () => ({ value: 'pwned', enumerable: true, writable: true, configurable: true }))],
    ['Object.hasOwn denies everything', () => patch(Object, 'hasOwn', () => false)],
    ['Object.getPrototypeOf hides the array prototype',
      () => patch(Object, 'getPrototypeOf', () => ({}))],
    ['Object.freeze is a no-op', () => patch(Object, 'freeze', (value) => value)],
    ['Object.defineProperty throws', () => patch(Object, 'defineProperty',
      () => { throw new Error('defineProperty must not run'); })],
    ['RegExp.prototype.test/exec throw', () => {
      const undoTest = patch(RegExp.prototype, 'test',
        () => { throw new Error('regexp must not run'); });
      const undoExec = patch(RegExp.prototype, 'exec',
        () => { throw new Error('regexp must not run'); });
      return () => { undoExec(); undoTest(); };
    }],
    ['Set membership and Map reads lie', () => {
      const undoHas = patch(Set.prototype, 'has', () => true);
      const undoGet = patch(Map.prototype, 'get', () => ({ segments: [] }));
      return () => { undoGet(); undoHas(); };
    }],
    ['WeakMap.get hands out forged IR to any key', () => patch(WeakMap.prototype, 'get',
      () => ({ segments: [{ kind: 'segment', atoms: [{ type: 'star' }] }] }))],
    ['WeakMap.set drops every registration',
      () => patch(WeakMap.prototype, 'set', () => null)],
    ['Function.prototype.call/bind and Reflect.apply throw', () => {
      const undoCall = patch(Function.prototype, 'call',
        () => { throw new Error('call must not run'); });
      const undoBind = patch(Function.prototype, 'bind',
        () => { throw new Error('bind must not run'); });
      const undoApply = patch(Reflect, 'apply',
        () => { throw new Error('apply must not run'); });
      return () => { undoApply(); undoBind(); undoCall(); };
    }],
    ['Uint8Array constructor is poisoned', () => patch(globalThis, 'Uint8Array',
      class Broken { constructor() { throw new Error('ctor must not run'); } })],
    ['Buffer.byteLength inflates every count',
      () => patch(NodeBuffer, 'byteLength', () => 999_999)],
  ];

  for (const [name, applyPatch] of cases) {
    await t.test(`hostile patch: ${name}`, () => {
      let probe;
      let extra;
      const undo = applyPatch();
      try {
        probe = standardProbe();
        if (name.includes('getOwnPropertyDescriptor')) {
          const getterArray = ['ok.txt'];
          Object.defineProperty(getterArray, '1', { get: () => '/abs', enumerable: true });
          getterArray.length = 2;
          extra = {
            accessorCode: (() => {
              try { m.filterRepoPathsByGlob('**', getterArray); return 'accepted'; }
              catch (error) { return error.code; }
            })(),
          };
        } else if (name === 'Object.hasOwn denies everything'
          || name === 'Object.getPrototypeOf hides the array prototype') {
          class Sub extends Array {}
          extra = {
            subclassCode: (() => {
              try { m.filterRepoPathsByGlob('**', Sub.from(['src/a.ts'])); return 'accepted'; }
              catch (error) { return error.code; }
            })(),
          };
        } else if (name === 'Object.freeze is a no-op') {
          const patchProbe = {};
          Object.freeze(patchProbe); // patched freeze: silently does nothing
          const handle = m.compileRepoGlob('a/b');
          extra = {
            patchActive: !Object.isFrozen(patchProbe),
            // The captured freeze ignores the patch, so IR/handles stay frozen.
            handleFrozen: Object.isFrozen(handle),
            answer: m.compiledRepoGlobMatchesPath(handle, 'a/b'),
          };
        } else if (name === 'Object.defineProperty throws') {
          let shape;
          try {
            m.repoGlobMatchesPath('[bad', 'probe');
            shape = 'accepted';
          } catch (error) {
            shape = `${error.name}:${error.code}:${typeof error.location}`;
          }
          extra = { typedShape: shape };
        } else if (name === 'RegExp.prototype.test/exec throw') {
          const hostileLabel = `${'L'.repeat(100_000)}secret`;
          const labelError = (() => {
            try { m.repoGlobMatchesPath('[bad', 'probe', hostileLabel); return null; }
            catch (caught) { return caught; }
          })();
          const safeLabel = (() => {
            try { m.repoGlobMatchesPath('src/x.ts', '/abs', 'scope-a'); return 'accepted'; }
            catch (caught) { return caught.location; }
          })();
          extra = { labelFallback: labelError?.location, safeLabel };
        } else if (name.startsWith('WeakMap.get')) {
          const forged = { id: REPO_PATH_MATCHER_ID, pattern: '**' };
          const forgedOutcome = (() => {
            try { m.compiledRepoGlobMatchesPath(forged, 'x'); return 'accepted'; }
            catch (error) { return error.code; }
          })();
          extra = {
            forgedOutcome,
            genuineStillExact: [
              m.compiledRepoGlobMatchesPath(m.compileRepoGlob('src/*.ts'), 'src/a.ts'),
              m.compiledRepoGlobMatchesPath(m.compileRepoGlob('src/*.ts'), 'lib/a.ts'),
            ],
          };
        } else if (name.startsWith('WeakMap.set')) {
          const handle = m.compileRepoGlob('a/b');
          extra = { registeredAnswer: m.compiledRepoGlobMatchesPath(handle, 'a/b') };
        } else if (name === 'Buffer.byteLength inflates every count') {
          const segmentCap = (() => {
            try { m.compileRepoGlob(`${'q'.repeat(129)}/b`); return 'accepted'; }
            catch (error) { return error.code; }
          })();
          extra = { cafeBytes: m.utf8ByteLength('café'), segmentCap };
        }
      } finally {
        undo();
      }

      // Standard expectations hold under every patch: the captured
      // intrinsics win, the manual scans win, bounds stay enforced.
      assert.equal(probe.literal, true);
      assert.equal(probe.star, true);
      assert.equal(probe.starNegative, false);
      assert.equal(probe.cls, true);
      assert.equal(probe.doubleStar, true);
      assert.equal(probe.astral, true);
      assert.deepEqual(probe.batch, ['x.md', 'y.ts']);
      assert.equal(probe.nfdCode, 'invalid_format');
      assert.equal(probe.aliasCode, 'invalid_format');
      assert.equal(probe.escapeCode, 'invalid_format');
      assert.equal(probe.proxyCode, 'invalid_array');

      if (extra?.accessorCode !== undefined) assert.equal(extra.accessorCode, 'invalid_array');
      if (extra?.subclassCode !== undefined) assert.equal(extra.subclassCode, 'invalid_array');
      if (extra?.patchActive !== undefined) {
        assert.equal(extra.patchActive, true); // the patch really was active...
        assert.equal(extra.handleFrozen, true); // ...the captured freeze ignored it...
        assert.equal(extra.answer, true); // ...and matching stayed correct anyway
      }
      if (extra?.typedShape !== undefined) {
        assert.equal(extra.typedShape, 'RepoPathMatcherError:pattern_unclosed_class:string');
      }
      if (extra?.labelFallback !== undefined) {
        assert.equal(extra.labelFallback, 'pattern.segments[0]');
        assert.equal(extra.safeLabel, 'scope-a');
      }
      if (extra?.forgedOutcome !== undefined) {
        assert.equal(extra.forgedOutcome, 'invalid_type');
        assert.deepEqual(extra.genuineStillExact, [true, false]);
      }
      if (extra?.registeredAnswer !== undefined) assert.equal(extra.registeredAnswer, true);
      if (extra?.cafeBytes !== undefined) {
        assert.equal(extra.cafeBytes, 5); // captured byteLength ignores the lie
        assert.equal(extra.segmentCap, 'out_of_range');
      }
    });
  }

  await t.test('restoration left no residue', () => {
    assert.equal(m.repoGlobMatchesPath('*', 'plain.txt'), true);
    assert.deepEqual(m.filterRepoPathsByGlob('**', ['a.md']), ['a.md']);
  });
});

test('character-class singles and ranges are charged before matching', () => {
  // 25 ranges per class, two classes per pattern: the charged pattern work is
  // 2 * (1 + 25 * 2) = 102 steps, not the naive 2 * 26 = 52 atom steps.
  const denseSegment = '[a-c]'.repeat(25);
  const densePattern = `${denseSegment}/${denseSegment}`;
  assert.equal(Buffer.byteLength(densePattern), GLOB_PATTERN_MAX_BYTES - 5);
  // Each segment carries exactly one code point per class atom: 25 of them,
  // all inside [a-c]. Charging never bends semantics either way.
  const member25 = 'abc'.repeat(8) + 'a'; // exactly 25 code points
  assert.equal(matches(densePattern, `${member25}/${member25}`), true);
  assert.equal(matches(densePattern, `${member25}/d${'abc'.repeat(8)}`), false); // 'd' outside [a-c]
  assert.equal(matches(densePattern, member25), false); // segment count differs
  // A legal-cap path (16 x 255 bytes = 4095 < the 4096-byte path cap) still
  // answers normally under charged accounting.
  const widePath = Array.from({ length: 16 }, () => 'a'.repeat(255)).join('/');
  assert.equal(Buffer.byteLength(widePath), REPO_PATH_MAX_BYTES - 1);
  assert.equal(matches(densePattern, widePath), false); // 16 segments vs 2
});

test('hostile range-count amplification is rejected deterministically before matching', () => {
  // Same shape as the legal-cap stress, but the pattern's work is hidden in
  // class ranges: naive atom counting would let the batch through (52 x
  // 999424 = 51,970,048 < budget), while charged counting rejects it (102 x
  // 999424 = 101,941,248 > budget). Every individual input is legal.
  const denseSegment = '[a-c]'.repeat(25);
  const densePattern = `${denseSegment}/${denseSegment}`;
  const stressPath = Array.from({ length: 16 }, () => 'a'.repeat(60)).join('/');
  const batch = Array.from({ length: REPO_PATH_BATCH_MAX }, () => stressPath);
  const naiveSteps = 2 * 26;
  const chargedSteps = 2 * (1 + 25 * 2);
  const totalPathWork = REPO_PATH_BATCH_MAX * (16 * 61);
  assert.ok(naiveSteps * totalPathWork < GLOB_MATCH_STEP_BUDGET,
    'test lost its point: naive accounting would now reject too');
  assert.ok(chargedSteps * totalPathWork > GLOB_MATCH_STEP_BUDGET,
    'test lost its point: charged accounting no longer rejects');

  const startedAt = process.hrtime.bigint();
  const first = matchError(() => filterRepoPathsByGlob(densePattern, batch), 'match_work_exceeded');
  const second = matchError(() => repoGlobMatchesAnyPath(densePattern, batch), 'match_work_exceeded');
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 500, `amplification rejection was not fast: ${elapsedMs}ms`);
  assert.equal(second.code, first.code);
  assert.equal(second.location, first.location);
  assert.equal(second.message, first.message);
  assert.equal(first.location, 'paths');
  // The same inputs stay answerable when the charged product fits: a small
  // batch of genuinely matching paths is returned intact.
  const member25 = 'abc'.repeat(8) + 'a'; // exactly one code point per class
  const matchingBatch = Array.from({ length: 64 }, () => `${member25}/${member25}`);
  assert.deepEqual(filterRepoPathsByGlob(densePattern, matchingBatch), matchingBatch);
  assert.equal(repoGlobMatchesAnyPath(densePattern, matchingBatch), true);
});

test('additional hostile grammar forms fail closed exactly', async (t) => {
  const grammarCases = [
    // '[' as a class member is an ordinary single.
    ['[[]', '[', true, null],
    // '-' between ranges degrades to singles; ranges stay strictly increasing.
    ['[a-b-c]', '-', true, null],
    ['[a-b-c]', 'c', true, null],
    ['[a-b-c]', 'd', false, null],
    // Astral code points are single class members and legal range bounds.
    ['[\u{1F600}-\u{1F601}]', '\u{1F600}', true, null],
    ['[\u{1F600}-\u{1F601}]', '\u{1F602}', false, null],
    ['[\u{1F601}-\u{1F600}]', '\u{1F601}', null, 'pattern_reversed_range'],
    ['[\u{1F600}', '\u{1F600}', null, 'pattern_unclosed_class'],
    // Negation is checked before closure, so '[!' negates first.
    ['[!', 'x', null, 'pattern_class_negation'],
    // '[]]' is an empty class in this grammar, not a literal ']'.
    ['[]]', ']', null, 'pattern_empty_class'],
    // extglob detection is code-point based, after any literal prefix.
    ['x/\u00e9?(y)', 'x/\u00e9y', null, 'pattern_extglob'],
    ['\u{1F600}*(y)', '\u{1F600}y', null, 'pattern_extglob'],
    // Embedded '**' between astral literals is still embedded.
    ['\u{1F600}**\u{1F600}', '\u{1F600}x\u{1F600}', null, 'pattern_double_star'],
    // Dots are literals except the exact '.' and '..' aliases.
    ['...', '...', true, null],
    ['a..b', 'a..b', true, null],
    ['....a', '....a', true, null],
    // Leading empty segments are structural rejections.
    ['//x', 'x', null, 'invalid_format'],
    ['x//', 'x', null, 'invalid_format'],
    // extglob openers stay literal unless immediately followed by '('.
    ['a+b', 'a+b', true, null],
    ['x@y', 'x@y', true, null],
    // Bare '|' is a literal, including inside a class.
    ['[a|b]', '|', true, null],
    ['a|b', 'a|b', true, null],
    ['a|b', 'a', false, null],
  ];
  for (const [pattern, value, expected, code] of grammarCases) {
    await t.test(`grammar: ${JSON.stringify(pattern)} vs ${JSON.stringify(value)}`, () => {
      if (code !== null) {
        matchError(() => matches(pattern, value), code);
        return;
      }
      assert.equal(matches(pattern, value), expected);
    });
  }
});

test('ingress validation and compilation share one grammar: three-direction parity', () => {
  // [text, validAsPath, patternOutcome] — patternOutcome is 'ok' or a code.
  // Strings within the shared caps must classify identically through the
  // ingress validator, the pattern compiler, and the matcher's path ingress;
  // the only permitted directional difference is pattern-specific syntax.
  const corpus = [
    ['README.md', true, 'ok'],
    ['{a,b}.txt', true, 'ok'],
    ['x|y', true, 'ok'],
    ['-', true, 'ok'],
    ['#', true, 'ok'],
    ['a b', true, 'ok'],
    ['.hidden', true, 'ok'],
    ['a..b', true, 'ok'],
    ['...', true, 'ok'],
    ['\u{1F600}.md', true, 'ok'],
    ['caf\u00e9', true, 'ok'],
    ['\u65e5\u4ec8/2026.log', true, 'ok'],
    // Valid paths whose text is pattern-hostile: the directional difference.
    ['[ab', true, 'pattern_unclosed_class'],
    ['a**b', true, 'pattern_double_star'],
    ['***', true, 'pattern_double_star'],
    ['@(x)', true, 'pattern_extglob'],
    ['[!a]', true, 'pattern_class_negation'],
    ['[^a]', true, 'pattern_class_negation'],
    ['[z-a]', true, 'pattern_reversed_range'],
    ['[a-a]', true, 'pattern_reversed_range'],
    ['[]', true, 'pattern_empty_class'],
    // Shared structural gates reject all three directions identically.
    ['', false, 'invalid_format'],
    ['.', false, 'invalid_format'],
    ['..', false, 'invalid_format'],
    ['a//b', false, 'invalid_format'],
    ['/abs', false, 'invalid_format'],
    ['trailing/', false, 'invalid_format'],
    ['a\\b', false, 'invalid_format'],
    ['cafe\u0301', false, 'invalid_format'], // NFD
    ['bad\uD800path', false, 'invalid_format'], // lone surrogate
    ['a\u0000b', false, 'invalid_format'], // NUL
    ['a\u001Fb', false, 'invalid_format'], // C0
    ['a\u007Fb', false, 'invalid_format'], // DEL
    ['a\u0085b', false, 'invalid_format'], // C1
    ['a\u202Eb', false, 'invalid_format'], // bidi override
    ['a\u2066b', false, 'invalid_format'], // bidi isolate
  ];
  for (const [text, validAsPath, patternOutcome] of corpus) {
    assert.equal(isRepoRelativePath(text), validAsPath, `ingress: ${JSON.stringify(text)}`);
    let compileCode = 'ok';
    try {
      compileRepoGlob(text);
    } catch (error) {
      compileCode = error.code;
    }
    assert.equal(compileCode, patternOutcome, `compile: ${JSON.stringify(text)}`);
    let matcherPathCode = 'ok';
    try {
      repoGlobMatchesPath('**', text);
    } catch (error) {
      matcherPathCode = error.code;
    }
    if (!validAsPath) {
      assert.equal(matcherPathCode, compileCode === 'ok' ? 'invalid_format' : compileCode,
        `matcher path ingress: ${JSON.stringify(text)}`);
      assert.equal(isRepoRelativePath(text), false);
    } else {
      assert.equal(matcherPathCode, 'ok', `matcher path ingress: ${JSON.stringify(text)}`);
    }
  }
});

test('wildcard-free valid paths literally self-match under their own grammar', () => {
  const literals = [
    'README.md', '{a,b}.txt', 'x|y', '-', '#', 'a b', '.hidden', 'a..b', '...',
    '\u{1F600}.md', 'caf\u00e9', '\u65e5\u4ec8/2026.log', '(a)', 'a+b', 'x@y',
  ];
  for (const text of literals) {
    assert.equal(matches(text, text), true, `self-match: ${JSON.stringify(text)}`);
  }
  // NFC-equivalent but byte-different text never cross-matches.
  matchError(() => matches('caf\u00e9', 'cafe\u0301'), 'invalid_format');
  matchError(() => matches('cafe\u0301', 'caf\u00e9'), 'invalid_format');
});

test('NFC is enforced symmetrically in every direction with one typed code', () => {
  const nfd = 'cafe\u0301';
  const nfc = 'caf\u00e9';
  for (const invoke of [
    () => assertRepoRelativePath(nfd),
    () => compileRepoGlob(nfd),
    () => repoGlobMatchesPath('**', nfd),
    () => repoGlobMatchesPath(nfd, nfc),
    () => repoGlobMatchesPath(nfc, nfd),
  ]) {
    matchError(invoke, 'invalid_format');
  }
  assert.equal(isRepoRelativePath(nfc), true);
  assert.equal(matches(nfc, nfc), true);
});
