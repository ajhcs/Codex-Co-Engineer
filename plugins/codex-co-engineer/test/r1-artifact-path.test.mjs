import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_RELATIVE_PATH_ERROR_CODES,
  isArtifactRelativePathV1,
  validateArtifactRelativePathV1,
} from '../mcp/v3/artifact-path.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';

function errorOf(action, expectedPath) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

// Callers embed accepted paths under a schema field, so the pinned denial
// paths below use the same dotted field spelling an embedding contract uses.
function pathError(value, expectedCode, expectedPath = 'artifact_ref.relative_path') {
  const error = errorOf(
    () => validateArtifactRelativePathV1(value, expectedPath),
    expectedPath,
  );
  assert.equal(error.code, expectedCode, `path ${JSON.stringify(value)}`);
  return error;
}

// ---- Relative path policy: full rejection matrix. -------------------------

test('absolute, drive, UNC, device, and traversal forms are all foreclosed', () => {
  pathError('', 'empty_path');
  pathError('/etc/passwd', 'absolute_path_denied');
  pathError('//double/leading', 'absolute_path_denied');
  pathError('C:/Users/diff.patch', 'colon_denied');
  pathError('C:diff.patch', 'colon_denied');
  pathError('\\\\server\\share\\x', 'invalid_separator');
  pathError('runs\\\\diff.patch', 'invalid_separator');
  pathError('file:text/plain', 'colon_denied');
  pathError('report.txt:hidden', 'colon_denied');
  pathError('runs/x/', 'trailing_slash_denied');
  pathError('runs//x', 'empty_segment_denied');
  pathError('./diff.patch', 'alias_segment_denied');
  pathError('../diff.patch', 'alias_segment_denied');
  pathError('runs/../escape', 'alias_segment_denied');
  pathError('...', 'alias_segment_denied');
  pathError('runs/.../x', 'alias_segment_denied');
  for (const reserved of ['CON', 'con.txt', 'Com1', 'lpt0', 'NUL', 'nul', 'PRN', 'aux', 'clock$', 'CLOCK$/token']) {
    pathError(`runs/${reserved}`, 'reserved_device_name_denied', 'artifact_ref.relative_path');
  }
  for (const ordinary of ['concat', 'auxiliary', 'nullify', 'control', 'companion10']) {
    assert.equal(isArtifactRelativePathV1(`runs/${ordinary}.txt`), true, ordinary);
  }
  pathError('runs/name.', 'edge_character_denied');
  pathError('runs/name ', 'edge_character_denied');
  pathError('runs/ name', 'edge_character_denied');
  pathError(`runs/${'a'.repeat(129)}`, 'segment_too_long');
  pathError(Array.from({ length: 17 }, (unused, index) => `s${index}`).join('/'), 'segment_count_exceeded');
  assert.doesNotThrow(() => validateArtifactRelativePathV1(
    Array.from({ length: 16 }, (unused, index) => `s${index}`).join('/'),
  ));
});

test('separator tricks, controls, invisible characters, and encodings are rejected', () => {
  pathError('runs/a\u2044b', 'separator_lookalike_denied');
  pathError('runs/a\u2215b', 'separator_lookalike_denied');
  pathError('runs/a\uFF0Fb', 'separator_lookalike_denied');
  pathError('runs/a\uFF3Cb', 'separator_lookalike_denied');
  pathError('runs/a\u0000b', 'control_character_denied');
  pathError('runs/a\tb', 'control_character_denied');
  pathError('runs/a\nb', 'control_character_denied');
  pathError('runs/a\u007Fb', 'control_character_denied');
  pathError('runs/a\u0085b', 'control_character_denied');
  pathError('runs/a\u00ADb', 'invisible_character_denied');
  pathError('runs/a\u200Bb', 'invisible_character_denied');
  pathError('runs/a\u200Eb', 'invisible_character_denied');
  pathError('runs/\u202Edir/x', 'invisible_character_denied');
  pathError('runs/dir\u202E/x', 'invisible_character_denied');
  pathError('runs/\u2066dir/x', 'invisible_character_denied');
  pathError('\uFEFFruns/x', 'invisible_character_denied');
  pathError('runs/tag\u{E0041}x', 'invisible_character_denied');
  pathError('e\u0301clair.patch', 'invalid_encoding');
  pathError('cafe\u0301.patch', 'invalid_encoding');
  assert.doesNotThrow(() => validateArtifactRelativePathV1('café.patch'));
  // Well-formed astral characters stay legal; only unpaired surrogates fail.
  assert.doesNotThrow(() => validateArtifactRelativePathV1('runs/🙂/diff.patch'));
  assert.equal(validateArtifactRelativePathV1('runs/🙂/diff.patch').byte_length,
    Buffer.byteLength('runs/🙂/diff.patch', 'utf8'));
  assert.throws(() => validateArtifactRelativePathV1('\uD800'), RunContractV1Error);
  assert.throws(() => validateArtifactRelativePathV1('a\uDFFBc'), RunContractV1Error);
  assert.equal(isArtifactRelativePathV1('\uDFFF'), false);
  assert.equal(isArtifactRelativePathV1('\uD83D\uDE00runs'), true);
});

test('validation order is fixed so identical inputs always raise identical first errors', () => {
  // Encoding beats NFC, NFC beats traversal, absolute beats control,
  // backslash beats colon, alias beats invisible.
  pathError('e\u0301/../x', 'invalid_encoding');
  pathError('../\u202Ex', 'alias_segment_denied');
  pathError('/x\u0000', 'absolute_path_denied');
  pathError('C:\\x', 'invalid_separator');
  pathError('\u202E/../x', 'alias_segment_denied');
  // The character scan is strictly positional: the first offending code
  // point decides, whichever class it belongs to.
  pathError('C:\u0000', 'colon_denied');
  pathError('\u0000a:b', 'control_character_denied');
  const twice = () => pathError('e\u0301/../..', 'invalid_encoding').message;
  assert.equal(twice(), twice());
});

test('non-string inputs and predicate parity behave without ever throwing', () => {
  for (const bad of [undefined, null, 42, true, {}, ['a'], Symbol('path')]) {
    assert.equal(
      errorOf(() => validateArtifactRelativePathV1(bad, 'p')).code,
      'invalid_type',
    );
    assert.equal(isArtifactRelativePathV1(bad), false);
  }
  const samples = [
    '', '/', '//', '.', '..', 'a', 'a/b', '/abs', 'a/', 'a//b', 'C:/x',
    'ok/deep/path.txt', 'bad\u0000', 'e\u0301', 'café', 'a/con', 'CON',
    `${'a'.repeat(1024)}`, `${'a'.repeat(1025)}`,
  ];
  for (const sample of samples) {
    let threw = false;
    try {
      validateArtifactRelativePathV1(sample, 'p');
    } catch {
      threw = true;
    }
    assert.equal(isArtifactRelativePathV1(sample), !threw, JSON.stringify(sample));
  }
});

test('accepted path descriptors are detached and frozen', () => {
  const descriptor = validateArtifactRelativePathV1('runs/run-a/lane-b/diff.patch', 'p');
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.segments), true);
  assert.deepEqual([...descriptor.segments], ['runs', 'run-a', 'lane-b', 'diff.patch']);
  assert.equal(descriptor.byte_length, Buffer.byteLength('runs/run-a/lane-b/diff.patch', 'utf8'));
});

test('every raised path code stays inside the closed vocabulary', () => {
  const codes = new Set(ARTIFACT_RELATIVE_PATH_ERROR_CODES);
  const attempts = [
    '', '/x', 'a\\b', 'a/../b', 'a//b', 'a/', '...', 'a/CON', 'a/b.',
    'a\u0000b', 'a\u200Bb', 'a\u2044b', 'a:b', `${'a'.repeat(2000)}`,
    `${Array.from({ length: 20 }, (_v, i) => `s${i}`).join('/')}`,
    '\uD800', 'e\u0301', 42, null,
  ];
  for (const attempt of attempts) {
    try {
      validateArtifactRelativePathV1(attempt, 'p');
    } catch (error) {
      assert.ok(error instanceof RunContractV1Error);
      assert.ok(codes.has(error.code), `unexpected code ${error.code}`);
    }
  }});

