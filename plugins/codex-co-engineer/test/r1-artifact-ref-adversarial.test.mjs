import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import {
  ARTIFACT_REF_ERROR_CODES,
  MAX_ARTIFACT_REFS,
  artifactRefDigestV1,
  canonicalArtifactRefJsonV1,
  compareArtifactRefsV1,
  orderArtifactRefsV1,
  parseArtifactRefV1,
  verifyArtifactRefDigestV1,
} from '../mcp/v3/artifact-ref.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, secondRef, trapTotal, validRef } from './fixtures/r1-artifact-fixtures.mjs';

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

function pathError(value, expectedCode, expectedPath = 'artifact_ref.relative_path') {
  const error = errorOf(
    () => parseArtifactRefV1(validRef({ relative_path: value })),
    expectedPath,
  );
  assert.equal(error.code, expectedCode, `path ${JSON.stringify(value)}`);
  return error;
}

test('live proxies are denied with zero traps on every artifact surface', () => {
  const { proxy, counts } = countingProxy(validRef());
  assert.equal(errorOf(() => parseArtifactRefV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const digestCounts = countingProxy(validRef());
  assert.equal(errorOf(() => artifactRefDigestV1(digestCounts.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(digestCounts.counts), 0);

  const listCounts = countingProxy([validRef()]);
  assert.equal(errorOf(() => orderArtifactRefsV1(listCounts.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(listCounts.counts), 0);

  const elementCounts = countingProxy(validRef());
  assert.equal(errorOf(() => orderArtifactRefsV1([elementCounts.proxy])).code, 'proxy_denied');
  assert.equal(trapTotal(elementCounts.counts), 0);

  const leftCounts = countingProxy(validRef());
  assert.equal(errorOf(() => compareArtifactRefsV1(leftCounts.proxy, validRef())).code, 'proxy_denied');
  assert.equal(trapTotal(leftCounts.counts), 0);
});

test('revoked proxies fail closed before Array.isArray or Reflect can throw', () => {
  const { proxy, revoke } = Proxy.revocable(validRef(), {
    get() { throw new Error('revoked get'); },
    ownKeys() { throw new Error('revoked ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('revoked descriptor'); },
  });
  revoke();
  assert.equal(utilTypes.isProxy(proxy), true);
  const error = errorOf(() => parseArtifactRefV1(proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);
});

test('accessor properties are rejected and their getters never run', () => {
  let reads = 0;
  const getterRef = validRef();
  Object.defineProperty(getterRef, 'relative_path', {
    enumerable: true,
    get() {
      reads += 1;
      return 'runs/run-artifact-01/lane-alpha/diff.patch';
    },
  });
  const error = errorOf(() => parseArtifactRefV1(getterRef), 'artifact_ref.relative_path');
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(reads, 0);

  let throwingReads = 0;
  const throwingRef = validRef();
  Object.defineProperty(throwingRef, 'sha256', {
    enumerable: true,
    get() {
      throwingReads += 1;
      throw new Error('getter bomb');
    },
  });
  assert.equal(
    errorOf(() => parseArtifactRefV1(throwingRef)).code,
    'accessor_property_denied',
  );
  assert.equal(throwingReads, 0);
});

test('non-enumerable fields, symbol keys, and exotic prototypes are denied', () => {
  const hidden = validRef();
  Object.defineProperty(hidden, 'byte_length', { enumerable: false, value: 2048 });
  assert.equal(
    errorOf(() => parseArtifactRefV1(hidden)).code,
    'non_enumerable_property_denied',
  );

  const symbolled = validRef();
  symbolled[Symbol('injected')] = 'payload';
  assert.equal(errorOf(() => parseArtifactRefV1(symbolled)).code, 'symbol_key_denied');

  class SpoofedRef {}
  const instance = new SpoofedRef();
  Object.assign(instance, validRef());
  assert.equal(errorOf(() => parseArtifactRefV1(instance)).code, 'invalid_type');
  assert.equal(errorOf(() => parseArtifactRefV1(new Map())).code, 'invalid_type');
  assert.equal(errorOf(() => parseArtifactRefV1(new Date())).code, 'invalid_type');

  // Null-prototype data objects remain acceptable direct JSON.
  const nullProto = Object.create(null);
  Object.assign(nullProto, validRef());
  assert.doesNotThrow(() => parseArtifactRefV1(nullProto));
});

test('own undefined values, boxed values, and coercion hooks never contribute', () => {
  assert.equal(
    errorOf(() => parseArtifactRefV1(validRef({ media_type: undefined }))).code,
    'own_undefined_denied',
  );
  let coerced = 0;
  const sneaky = { valueOf() { coerced += 1; return 2048; } };
  assert.equal(
    errorOf(
      () => parseArtifactRefV1(validRef({ byte_length: sneaky })),
      'artifact_ref.byte_length.valueOf',
    ).code,
    'invalid_json_type',
  );
  assert.equal(coerced, 0);
  const boxed = validRef({ sha256: new String('a'.repeat(64)) });
  assert.equal(errorOf(() => parseArtifactRefV1(boxed)).code, 'exotic_prototype_denied');
});

test('cyclic, aliased, deep, and oversized payloads are rejected before effects', () => {
  const cyclic = validRef();
  cyclic.self = cyclic;
  assert.equal(errorOf(() => parseArtifactRefV1(cyclic)).code, 'aliased_reference_denied');

  const shared = { marker: true };
  const aliased = validRef();
  aliased.first = shared;
  aliased.second = shared;
  assert.equal(errorOf(() => parseArtifactRefV1(aliased)).code, 'aliased_reference_denied');

  let deep = { leaf: 1 };
  for (let index = 0; index < 64; index += 1) deep = { wrapped: deep };
  const deepRef = validRef();
  deepRef.deep = deep;
  assert.equal(errorOf(() => parseArtifactRefV1(deepRef)).code, 'value_depth_exceeded');

  pathError(`${'a'.repeat(2000)}.patch`, 'out_of_range');
});

test('the closure gate precedes the closed vocabulary check', () => {
  const unknownButHostile = validRef();
  unknownButHostile.unknown_key = { nested: unknownButHostile };
  assert.equal(errorOf(() => parseArtifactRefV1(unknownButHostile)).code, 'aliased_reference_denied');
});

test('every artifact-specific denial code stays inside the closed vocabulary', () => {
  const refCodes = new Set(ARTIFACT_REF_ERROR_CODES);
  for (const code of [
    'duplicate_artifact_ref',
    'refs_exceeded',
    'unknown_artifact_kind',
    'unknown_artifact_class',
    'unknown_media_type',
    'unknown_content_encoding',
    'missing_key',
    'invalid_format',
    'invalid_type',
    'out_of_range',
  ]) {
    assert.ok(refCodes.has(code), code);
  }
});

test('orderArtifactRefsV1 rejects every hostile batch shape before sorting', () => {
  assert.equal(errorOf(() => orderArtifactRefsV1([validRef(), validRef()])).code, 'duplicate_artifact_ref');
  const sparse = new Array(2);
  sparse[0] = validRef();
  assert.equal(errorOf(() => orderArtifactRefsV1(sparse)).code, 'invalid_array');
  const extended = [validRef()];
  extended.extraProperty = true;
  assert.equal(errorOf(() => orderArtifactRefsV1(extended)).code, 'invalid_array');
  const accessorElement = validRef();
  Object.defineProperty(accessorElement, 'run_id', { enumerable: true, get() { return 'run-x'; } });
  assert.equal(errorOf(() => orderArtifactRefsV1([accessorElement])).code, 'accessor_property_denied');
  const tooMany = [];
  for (let index = 0; index <= MAX_ARTIFACT_REFS; index += 1) {
    tooMany.push(secondRef({
      assignment_id: `lane-${String(index).padStart(3, '0')}`,
      relative_path: `runs/run-artifact-01/lane-${String(index).padStart(3, '0')}/d.patch`,
      sha256: `${index.toString(16).padStart(2, '0')}`.repeat(32),
    }));
  }
  assert.equal(tooMany.length, MAX_ARTIFACT_REFS + 1);
  assert.equal(errorOf(() => orderArtifactRefsV1(tooMany)).code, 'refs_exceeded');
});

test('mid-call caller mutation cannot disturb an in-flight ordering or digest', () => {
  const refs = [secondRef(), validRef()];
  const orderedOnce = orderArtifactRefsV1(refs);
  refs[1].byte_length = 4096;
  const orderedTwice = orderArtifactRefsV1([secondRef(), validRef()]);
  assert.deepEqual(orderedOnce.map((ref) => ref.assignment_id), orderedTwice.map((ref) => ref.assignment_id));

  const input = validRef();
  const canonical = canonicalArtifactRefJsonV1(input);
  const digest = artifactRefDigestV1(input).digest;
  input.media_type = 'application/json';
  assert.equal(canonicalArtifactRefJsonV1(validRef()), canonical);
  assert.equal(artifactRefDigestV1(validRef()).digest, digest);
  assert.equal(verifyArtifactRefDigestV1(validRef(), digest), true);
});
