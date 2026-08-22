import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_CLASSES,
  ARTIFACT_DIGEST_DOMAIN,
  ARTIFACT_DIGEST_HEX_LENGTH,
  ARTIFACT_DIGEST_VERSION,
  ARTIFACT_KINDS,
  ARTIFACT_REF_DIGEST_LABEL,
  ARTIFACT_REF_SCHEMA_ID,
  ARTIFACT_SHA256_PATTERN,
  CONTENT_ENCODINGS,
  MAX_ARTIFACT_REFS,
  MAX_RAW_ARTIFACT_BYTE_LENGTH,
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
  MEDIA_TYPES,
  MIN_ARTIFACT_BYTE_LENGTH,
  artifactRefDigestV1,
  canonicalArtifactRefJsonV1,
  compareArtifactRefsV1,
  orderArtifactRefsV1,
  parseArtifactRefV1,
  validateArtifactRefV1,
  verifyArtifactRefDigestV1,
} from '../mcp/v3/artifact-ref.mjs';
import {
  ARTIFACT_PATH_MAX_BYTES,
  isArtifactRelativePathV1,
  validateArtifactRelativePathV1,
} from '../mcp/v3/artifact-path.mjs';
import {
  CAPABILITY_ARTIFACT_KINDS,
} from '../mcp/v3/capability-bridge.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { secondRef, validRef } from './fixtures/r1-artifact-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

test('a valid artifact reference parses into a frozen detached snapshot', () => {
  const input = validRef();
  const snapshot = parseArtifactRefV1(input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(Object.keys(snapshot), [
    'schema', 'run_id', 'assignment_id', 'artifact_kind', 'artifact_class',
    'relative_path', 'byte_length', 'sha256', 'media_type', 'content_encoding',
  ]);
  for (const key of Object.keys(snapshot)) {
    assert.equal(snapshot[key], input[key], key);
    assert.ok(Object.hasOwn(snapshot, key), key);
  }
  const reparsed = validateArtifactRefV1(input);
  assert.notEqual(reparsed, snapshot);
  assert.equal(canonicalArtifactRefJsonV1(reparsed), canonicalArtifactRefJsonV1(snapshot));
});

test('parsed snapshots are detached: later caller mutation cannot drift anything', () => {
  const input = validRef();
  const digest = artifactRefDigestV1(input).digest;
  const snapshot = parseArtifactRefV1(input);
  input.byte_length = 4096;
  input.sha256 = 'f'.repeat(64);
  input.relative_path = 'runs/run-artifact-01/lane-alpha/other.patch';
  assert.equal(snapshot.byte_length, 2048);
  assert.equal(verifyArtifactRefDigestV1(validRef(), digest), true);
  assert.notEqual(artifactRefDigestV1(input).digest, digest);
  assert.throws(() => { 'use strict'; snapshot.byte_length = 1; }, TypeError);
  assert.throws(() => { 'use strict'; snapshot.new_field = 1; }, TypeError);
  assert.equal(Reflect.deleteProperty(snapshot, 'sha256'), false);
});

test('canonical JSON and digests are invariant under caller key order', () => {
  const straight = validRef();
  const shuffled = validRef();
  const reordered = {};
  for (const key of Object.keys(straight).reverse()) reordered[key] = straight[key];
  Object.assign(shuffled, {});
  assert.equal(canonicalArtifactRefJsonV1(straight), canonicalArtifactRefJsonV1(reordered));
  assert.equal(artifactRefDigestV1(straight).digest, artifactRefDigestV1(reordered).digest);
});

test('digest descriptors carry the framed domain, version, label, and byte count', () => {
  const descriptor = artifactRefDigestV1(validRef());
  assert.deepEqual(Object.keys(descriptor), [
    'algorithm', 'domain', 'version', 'label', 'input_bytes', 'digest',
  ]);
  assert.equal(descriptor.algorithm, 'sha256');
  assert.equal(descriptor.domain, ARTIFACT_DIGEST_DOMAIN);
  assert.equal(descriptor.version, ARTIFACT_DIGEST_VERSION);
  assert.equal(descriptor.label, ARTIFACT_REF_DIGEST_LABEL);
  assert.match(descriptor.digest, /^[0-9a-f]{64}$/u);
  assert.equal(descriptor.input_bytes, Buffer.byteLength(canonicalArtifactRefJsonV1(validRef()), 'utf8'));
  assert.equal(Object.isFrozen(descriptor), true);
});

test('every meaningful value change must change the digest', () => {
  const baseline = artifactRefDigestV1(validRef()).digest;
  const variations = [
    { run_id: 'run-artifact-02' },
    { assignment_id: 'lane-beta' },
    { artifact_kind: 'provider_report' },
    { artifact_class: 'raw' },
    { relative_path: `runs/run-artifact-01/lane-alpha/other.patch` },
    { byte_length: 2049 },
    { sha256: 'ab'.repeat(32) },
    { media_type: 'application/json' },
    { content_encoding: 'base64' },
  ];
  for (const variation of variations) {
    assert.notEqual(artifactRefDigestV1(validRef(variation)).digest, baseline, JSON.stringify(variation));
  }
});

test('verification is exact about expected digests and never throws on malformed ones', () => {
  const digest = artifactRefDigestV1(validRef()).digest;
  assert.equal(verifyArtifactRefDigestV1(validRef(), digest), true);
  for (const bad of [undefined, null, 12345, {}, `SHA${digest.slice(3)}`, `${digest}0`, digest.slice(1)]) {
    assert.equal(verifyArtifactRefDigestV1(validRef(), bad), false);
  }
  assert.equal(verifyArtifactRefDigestV1(validRef({ byte_length: 9999 }), digest), false);
});

test('byte length bounds are class-dependent and bounded evidence stays finite', () => {
  assert.equal(MIN_ARTIFACT_BYTE_LENGTH, 1);
  parseArtifactRefV1(validRef({ artifact_class: 'sanitized', byte_length: MAX_SANITIZED_ARTIFACT_BYTE_LENGTH }));
  errorOf(
    () => parseArtifactRefV1(validRef({
      artifact_class: 'sanitized', byte_length: MAX_SANITIZED_ARTIFACT_BYTE_LENGTH + 1,
    })),
    'artifact_ref.byte_length',
  ).code;
  parseArtifactRefV1(validRef({ artifact_class: 'raw', byte_length: MAX_RAW_ARTIFACT_BYTE_LENGTH }));
  assert.equal(
    errorOf(() => parseArtifactRefV1(validRef({
      artifact_class: 'raw', byte_length: MAX_RAW_ARTIFACT_BYTE_LENGTH + 1,
    })), 'artifact_ref.byte_length').code,
    'out_of_range',
  );
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2048', null]) {
    const code = errorOf(() => parseArtifactRefV1(validRef({ byte_length: bad })), 'artifact_ref.byte_length').code;
    assert.ok(['invalid_type', 'out_of_range'].includes(code), `unexpected code ${code}`);
  }
});

test('closed vocabularies are enforced exactly and stay detached', () => {
  assert.deepEqual([...ARTIFACT_KINDS], [...CAPABILITY_ARTIFACT_KINDS]);
  const exportsToProbe = [
    ['ARTIFACT_KINDS', ARTIFACT_KINDS],
    ['ARTIFACT_CLASSES', ARTIFACT_CLASSES],
    ['MEDIA_TYPES', MEDIA_TYPES],
    ['CONTENT_ENCODINGS', CONTENT_ENCODINGS],
  ];
  for (const [name, vocabulary] of exportsToProbe) {
    assert.equal(Object.isFrozen(vocabulary), true, name);
    const mutated = [...vocabulary];
    try {
      vocabulary.push('bogus');
    } catch {
      // Frozen arrays throw in strict mode; acceptance must not change either way.
    }
    assert.deepEqual([...vocabulary], mutated, name);
  }
  parseArtifactRefV1(validRef());
  for (const [key, values, code] of [
    ['artifact_kind', ARTIFACT_KINDS, 'unknown_artifact_kind'],
    ['artifact_class', ARTIFACT_CLASSES, 'unknown_artifact_class'],
    ['media_type', MEDIA_TYPES, 'unknown_media_type'],
    ['content_encoding', CONTENT_ENCODINGS, 'unknown_content_encoding'],
  ]) {
    for (const value of values) {
      assert.doesNotThrow(() => parseArtifactRefV1(validRef({ [key]: value })));
    }
    for (const hostile of ['Git_Diff', 'RAW', 'text/plain ', '', 'bogus']) {
      if (values.includes(hostile)) continue;
      const error = errorOf(
        () => parseArtifactRefV1(validRef({ [key]: hostile })),
        `artifact_ref.${key}`,
      );
      assert.equal(error.code, code, `${key}: ${hostile}`);
    }
  }
});

test('each of the ten keys is required with a precise missing_key denial', () => {
  for (const key of [
    'schema', 'run_id', 'assignment_id', 'artifact_kind', 'artifact_class',
    'relative_path', 'byte_length', 'sha256', 'media_type', 'content_encoding',
  ]) {
    const partial = validRef();
    delete partial[key];
    const error = errorOf(() => parseArtifactRefV1(partial), `artifact_ref.${key}`);
    assert.equal(error.code, 'missing_key');
  }
});

test('unknown keys are rejected and forbidden classes keep their precise denials', () => {
  assert.equal(errorOf(() => parseArtifactRefV1(validRef({ extra: 1 })), 'artifact_ref.extra').code, 'unknown_key');
  const forbidden = [
    ['command', 'executable_content_denied'],
    ['env', 'executable_content_denied'],
    ['secret', 'credential_content_denied'],
    ['token', 'credential_content_denied'],
    ['fallback', 'replay_or_fallback_denied'],
    ['allow_merge', 'merge_authority_denied'],
    ['depends_on', 'dependency_not_allowed'],
  ];
  for (const [key, code] of forbidden) {
    assert.equal(errorOf(() => parseArtifactRefV1(validRef({ [key]: 1 }))).code, code, key);
  }
});

test('identity fields reuse the accepted manifest grammars exactly', () => {
  for (const bad of ['', 'Run-Artifact', 'run_artifact', 'aa', `-run`, `${'a'.repeat(65)}`]) {
    assert.equal(
      errorOf(() => parseArtifactRefV1(validRef({ run_id: bad })), 'artifact_ref.run_id').code,
      'invalid_format',
      bad,
    );
  }
  for (const bad of ['', 'Lane-Alpha', 'lane_alpha', `${'a'.repeat(65)}`]) {
    assert.equal(
      errorOf(() => parseArtifactRefV1(validRef({ assignment_id: bad })), 'artifact_ref.assignment_id').code,
      'invalid_format',
      bad,
    );
  }
  for (const bad of ['A'.repeat(64), 'zz', `${'a'.repeat(63)}g`, null]) {
    assert.equal(
      errorOf(() => parseArtifactRefV1(validRef({ sha256: bad })), 'artifact_ref.sha256').code,
      'invalid_format',
    );
  }
  assert.equal(ARTIFACT_SHA256_PATTERN.test('a'.repeat(64)), true);
  assert.equal(ARTIFACT_SHA256_PATTERN.test('A'.repeat(64)), false);
});

test('relative paths inside references flow through the strict path policy', () => {
  const nested = validRef({
    relative_path: `runs/run-artifact-01/lane-alpha/evidence/provider-report.json`,
  });
  parseArtifactRefV1(nested);
  const descriptor = validateArtifactRelativePathV1(nested.relative_path, 'artifact_ref.relative_path');
  assert.equal(descriptor.segment_count, 5);
  assert.equal(descriptor.byte_length, Buffer.byteLength(nested.relative_path, 'utf8'));
  const escape = validRef({ relative_path: '../../outside/diff.patch' });
  const error = errorOf(() => parseArtifactRefV1(escape), 'artifact_ref.relative_path');
  assert.equal(error.code, 'alias_segment_denied');
  assert.equal(isArtifactRelativePathV1('../../outside/diff.patch'), false);
  assert.equal(isArtifactRelativePathV1(nested.relative_path), true);
  assert.equal(ARTIFACT_PATH_MAX_BYTES > 0, true);
});

test('compareArtifactRefsV1 fixes one deterministic total tuple order', () => {
  const base = validRef();
  const other = secondRef();
  const forward = compareArtifactRefsV1(base, other);
  assert.equal(forward, -compareArtifactRefsV1(other, base));
  assert.equal(compareArtifactRefsV1(base, validRef()), 0);
  // assignment_id dominates everything below it; at equal identity fields
  // the code-unit order of media_type decides ('application/json' sorts first).
  assert.equal(compareArtifactRefsV1(base, validRef({ media_type: 'application/json' })), 1);
  // artifact_class outranks artifact_kind at equal run/child.
  const classOrder = compareArtifactRefsV1(
    validRef({ artifact_class: 'raw' }),
    validRef({ artifact_kind: 'provider_report' }),
  );
  assert.equal(classOrder, -1);
});

test('orderArtifactRefsV1 is deterministic, duplicate-free, and bounded', () => {
  const refs = [];
  for (let index = 0; index < MAX_ARTIFACT_REFS; index += 1) {
    refs.push(secondRef({
      assignment_id: `lane-${String(index).padStart(2, '0')}`,
      relative_path: `runs/run-artifact-01/lane-${String(index).padStart(2, '0')}/diff.patch`,
    }));
  }
  const ordered = orderArtifactRefsV1(refs);
  const reshuffled = orderArtifactRefsV1([...refs].reverse());
  assert.deepEqual(JSON.parse(canonicalArtifactRefJsonV1(ordered[0])), JSON.parse(canonicalArtifactRefJsonV1(reshuffled[0])));
  assert.deepEqual(ordered.map((ref) => ref.assignment_id), reshuffled.map((ref) => ref.assignment_id));
  assert.equal(Object.isFrozen(ordered), true);
  assert.ok(ordered.every((ref) => Object.isFrozen(ref)));
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareArtifactRefsV1(ordered[index - 1], ordered[index]), -1);
  }

  assert.deepEqual(orderArtifactRefsV1([]), []);
  const single = orderArtifactRefsV1([secondRef()]);
  assert.equal(single.length, 1);

  assert.equal(
    errorOf(() => orderArtifactRefsV1([validRef(), validRef()])).code,
    'duplicate_artifact_ref',
  );
  const aliasSource = validRef();
  assert.equal(
    errorOf(() => orderArtifactRefsV1([aliasSource, aliasSource])).code,
    'duplicate_artifact_ref',
  );
  assert.equal(
    errorOf(() => orderArtifactRefsV1([...refs, validRef()])).code,
    'refs_exceeded',
  );
});

test('the modules are pure schema/path policy: no I/O surface and no process access', async () => {
  const allowedSpecifiers = new Set([
    'node:buffer', 'node:crypto', 'node:util',
    './grammar.mjs', './run-manifest.mjs', './identity.mjs',
    './artifact-path.mjs', './capability-bridge.mjs', './selection-json.mjs',
    './contract.mjs', './assignment-manifest.mjs', './repo-path-matcher.mjs',
  ]);
  for (const relative of ['artifact-ref.mjs', 'artifact-path.mjs']) {
    const source = await readFile(path.join(HERE, '..', 'mcp', 'v3', relative), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1]);
    assert.ok(specifiers.length >= 3, `${relative} should import its dependencies`);
    for (const specifier of specifiers) {
      assert.ok(allowedSpecifiers.has(specifier), `${relative} imports ${specifier}`);
    }
    assert.doesNotMatch(source, /node:(fs|fs\/promises|net|http|https|child_process|os|dns|tls|stream|worker_threads|process)/u);
    assert.doesNotMatch(source, /\bprocess\./u);
    assert.doesNotMatch(source, /\brequire\(/u);
    assert.doesNotMatch(source, /\beval\(/u);
    // The modules address artifacts; they must not claim that P08 storage exists.
    assert.match(source, /P08/u);
  }
});
