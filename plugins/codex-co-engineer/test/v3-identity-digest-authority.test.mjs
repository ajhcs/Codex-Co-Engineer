// P03 adversarial suite for the closed domain-separated digest authority in
// identity.mjs: closed label registry (no arbitrary or unregistered labels),
// exact ordinary-Buffer parts with zero-trap rejection, exact 16-part and
// 4 MiB total caps, unambiguous length framing, mutation-proof snapshots,
// stable typed errors, and byte-exact golden stability for every existing
// RunIdentityV1 surface.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  MAX_IDENTITY_DIGEST_INPUT_BYTES,
  MAX_IDENTITY_DIGEST_PARTS,
  MAX_IDENTITY_LABEL_CODE_UNITS,
  IDENTITY_DOMAIN,
  IDENTITY_LABELS,
  IDENTITY_VERSION,
  assignmentPromptDigestV1,
  canonicalJsonStringify,
  childEnvelopeDigestV1,
  describeRunIdentityV1,
  identityDigestV1,
  runManifestCanonicalJsonV1,
  runManifestDigestV1,
  verifyRunManifestDigestV1,
} from '../mcp/v3/identity.mjs';
import {
  RunContractV1Error,
} from '../mcp/v3/run-manifest.mjs';
import { parseRunManifestV1 } from '../mcp/v3/run-policy.mjs';
import {
  compileChildEnvelopeV1,
  parseChildEnvelopeV1,
} from '../mcp/v3/prompt-compiler.mjs';

const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const POLICY = Object.freeze({
  max_concurrency: 8,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});

function writerAssignment(id, overrides = {}) {
  return {
    assignment_id: id,
    role: 'implement',
    access: 'writer',
    prompt: `Prompt for ${id}.`,
    execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
    write_scope: ['src/**'],
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report'],
    ...overrides,
  };
}

function goldenManifest() {
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'golden-run-fixture',
    repository: { path: '/run-fixtures/repository', base_sha: BASE_SHA },
    objective: 'Pin P03 identity goldens.',
    assignments: [
      writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} \u00e9.\n' }),
      writerAssignment('frontend-writer', {
        write_scope: ['web/**'],
        execution: { profile: 'fast-implementer' },
        prompt: 'Reviewer prompt.',
      }),
    ],
    policy: { ...POLICY },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  };
}

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected the action to throw RunContractV1Error');
}

// Independent re-derivation of the documented framing: 4-byte big-endian
// length prefixes over the domain, the big-endian identity version, the
// label, and every part, hashed with SHA-256.
function expectedFramedDigestHex(label, byteParts) {
  const chunks = [];
  const pushLength = (length) => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(length, 0);
    chunks.push(prefix);
  };
  const domain = Buffer.from(IDENTITY_DOMAIN, 'utf8');
  pushLength(domain.length);
  chunks.push(domain);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(IDENTITY_VERSION, 0);
  chunks.push(version);
  const labelBytes = Buffer.from(label, 'utf8');
  pushLength(labelBytes.length);
  chunks.push(labelBytes);
  for (const part of byteParts) {
    pushLength(part.length);
    chunks.push(part);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

// --- Closed central label registry ------------------------------------------

test('the registry is closed, frozen, and exactly the ratified label set', () => {
  assert.deepEqual(Object.assign({}, IDENTITY_LABELS), {
    RUN_MANIFEST: 'run-manifest.v1',
    ASSIGNMENT_PROMPT: 'assignment-prompt.v1',
    CHILD_ENVELOPE: 'child-envelope.v1',
    RUN_IDENTITY: 'run-identity.v1',
    CHILD_IDENTITY: 'child-identity.v1',
    RESOLUTION_SNAPSHOT: 'resolution-snapshot.v1',
    RESOLVED_LANE_BINDING: 'resolved-lane-binding.v1',
    WORKSPACE_ANCHOR: 'workspace-anchor.v1',
    WORKSPACE_IDENTITY: 'workspace-identity.v1',
    DISPATCH_ATTEMPT: 'dispatch-attempt.v1',
    PROVIDER_OPERATION: 'provider-operation.v1',
    PROVIDER_RUN_IDENTITY: 'provider-run-identity.v1',
    REQUEST_IDEMPOTENCY: 'request-idempotency.v1',
    PROVIDER_CAPABILITY: 'provider-capability.v1',
    EVIDENCE_BUNDLE: 'evidence-bundle.v1',
    VERIFICATION_POLICY: 'verification-policy.v1',
    VERIFICATION_COMMAND_DESCRIPTOR: 'verification-command-descriptor.v1',
    VERIFICATION_EXECUTABLE_CLOSURE: 'verification-executable-closure.v1',
    VERIFICATION_COMMAND_PLAN: 'verification-command-plan.v1',
    VERIFICATION_EXECUTION_RECEIPT: 'verification-execution-receipt.v1',
  });
  const values = Object.values(IDENTITY_LABELS);
  assert.equal(new Set(values).size, values.length, 'registry labels must be unique');
  assert.ok(Object.isFrozen(IDENTITY_LABELS));
  assert.equal(Object.getPrototypeOf(IDENTITY_LABELS), null);
  assert.equal(MAX_IDENTITY_DIGEST_PARTS, 16);
  assert.equal(MAX_IDENTITY_DIGEST_INPUT_BYTES, 4_194_304);
  assert.equal(typeof MAX_IDENTITY_DIGEST_PARTS, 'number');
  assert.equal(typeof MAX_IDENTITY_DIGEST_INPUT_BYTES, 'number');
});

test('every registered label digests through the shared framing', () => {
  const payload = Buffer.from('registry payload');
  for (const [key, label] of Object.entries(IDENTITY_LABELS)) {
    const descriptor = identityDigestV1(label, [payload]);
    assert.equal(descriptor.label, label, `${key} must round-trip its label`);
    assert.equal(descriptor.domain, IDENTITY_DOMAIN);
    assert.equal(descriptor.version, IDENTITY_VERSION);
    assert.equal(descriptor.digest, expectedFramedDigestHex(label, [payload]));
    assert.match(descriptor.digest, /^[0-9a-f]{64}$/u);
  }
});

test('unregistered raw labels are rejected without coercion', () => {
  const nearMisses = [
    // Near-miss spellings of ratified labels.
    'run-manifest.v2', 'run-manifest', 'run-manifest.v10', 'manifest.v1',
    'RUN-MANIFEST.V1', 'Run-Manifest.v1', 'run_manifest.v1', 'run-manifest..v1',
    'assignment-prompt.V1', 'child-envelope.v1 ', ' child-envelope.v1',
    'child-envelope.v1\n', 'evidence-bundle.v1.', 'artifact-id', 'artifact-id.v1',
    'resolved-plan.v1', 'request-idempotency.v1x', 'verification-policy.v1\t',
    'provider-capability.v11', 'candidate-composition.v1', 'run-decision.v1',
    'run-identity.v2', 'child-identity', 'resolution-snapshot.v01',
    // Key names are not labels.
    'RUN_MANIFEST', 'EVIDENCE_BUNDLE', 'RUN_IDENTITY', 'RUN_DECISION',
    // The codex-co-engineer namespace lives in the domain, not in the label.
    'codex-co-engineer.run-decision.v1', 'codex-co-engineer.identity.v1',
    // Plausible but never ratified.
    'rogue.v1', 'attacker-controlled.v1', 'toString', 'constructor',
    'hasOwnProperty', 'label.v1',
  ];
  for (const label of nearMisses) {
    const error = errorOf(() => identityDigestV1(label, [Buffer.from('x')]));
    assert.equal(error.code, 'unknown_label', label);
    assert.equal(error.path, 'label');
    assert.ok(error.message.length < 200, `unbounded diagnostic for ${JSON.stringify(label)}`);
  }
  const nonStrings = [undefined, null, 123, 4_194_304, true, false, BigInt(1),
    Symbol('label'), {}, ['run-identity.v1'], new String('run-identity.v1'),
    () => 'run-identity.v1'];
  for (const label of nonStrings) {
    const error = errorOf(() => identityDigestV1(label, [Buffer.from('x')]));
    assert.equal(error.code, 'invalid_format', String(label));
    assert.equal(error.path, 'label');
  }
  // A String object with an exact ratified spelling is still not a constant.
  const boxed = errorOf(() => identityDigestV1(new String(IDENTITY_LABELS.RUN_IDENTITY), []));
  assert.equal(boxed.code, 'invalid_format');
});

test('the registry cannot be extended or spoofed at runtime', () => {
  assert.throws(() => { 'use strict'; IDENTITY_LABELS.ROGUE = 'rogue.v1'; }, TypeError);
  assert.throws(() => {
    Object.defineProperty(IDENTITY_LABELS, 'ROGUE', { value: 'rogue.v1', enumerable: true });
  }, TypeError);
  // Registry membership was fixed at module load; a derived object changes nothing.
  const spoofed = Object.create(IDENTITY_LABELS, { ROGUE: { value: 'rogue.v1', enumerable: true } });
  const error = errorOf(() => identityDigestV1(spoofed.ROGUE, [Buffer.from('x')]));
  assert.equal(error.code, 'unknown_label');
  // A frozen array copy of the values is equally unable to admit new labels.
  const frozen = Object.freeze([...Object.values(IDENTITY_LABELS), 'rogue.v1']);
  assert.equal(errorOf(() => identityDigestV1(frozen.at(-1), [])).code, 'unknown_label');
});

// --- Exact Buffer parts, zero-trap rejection, no coercion --------------------

test('only ordinary Buffer instances are accepted as parts', () => {
  const accepted = [
    ['empty buffer', Buffer.alloc(0)],
    ['ascii buffer', Buffer.from('abc')],
    ['binary buffer', Buffer.from([0, 255, 127, 1])],
    ['subarray view', Buffer.from('abcdefgh').subarray(2, 5)],
    ['shared pool buffer', Buffer.allocUnsafe(8)],
    ['buffer over caller ArrayBuffer', Buffer.from(new ArrayBuffer(4))],
  ];
  for (const [name, part] of accepted) {
    const descriptor = identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [part]);
    assert.equal(descriptor.input_bytes, part.length, name);
  }
});

test('Buffer-backed SharedArrayBuffer parts are rejected before any byte snapshot', () => {
  // An ordinary Buffer over shared storage passes every prior ordinary-Buffer
  // check while its bytes stay concurrently mutable from outside this agent,
  // so accepting it would permit a torn digest snapshot.
  const shared = Buffer.from(new SharedArrayBuffer(8));
  assert.equal(Buffer.isBuffer(shared), true);
  assert.equal(Object.getPrototypeOf(shared), Buffer.prototype);
  shared.write('drift');
  const error = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [shared]));
  assert.equal(error.code, 'invalid_object');
  assert.equal(error.path, 'parts[0]');
  assert.match(error.message, /SharedArrayBuffer/u);
  assert.ok(error.message.length < 200);

  // Rejection stays index-exact in mixed containers: the shared part is named
  // and never hashed even after an ordinary leading part validates.
  const mixed = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE,
    [Buffer.from('ok'), shared]));
  assert.equal(mixed.code, 'invalid_object');
  assert.equal(mixed.path, 'parts[1]');

  // Ordinary, pooled, subarray, empty, and caller-ArrayBuffer-backed Buffers
  // keep their exact acceptance and framing bytes.
  const accepted = [
    ['ordinary', Buffer.from('abc')],
    ['pooled', Buffer.allocUnsafe(4)],
    ['subarray view', Buffer.from('abcdefgh').subarray(2, 5)],
    ['empty', Buffer.alloc(0)],
    ['caller ArrayBuffer-backed', Buffer.from(new ArrayBuffer(4))],
  ];
  for (const [name, part] of accepted) {
    const descriptor = identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [part]);
    assert.equal(descriptor.input_bytes, part.length, name);
    assert.equal(descriptor.digest, expectedFramedDigestHex(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [part]), name);
  }
});

test('non-Buffer byte shapes are rejected with stable typed errors', () => {
  const cases = [
    ['plain object', {}],
    ['length-shaped object', { length: 4 }],
    ['index-shaped object', { 0: 104, 1: 105, length: 2 }],
    ['isBuffer-spoofed object', { _isBuffer: true }],
    ['Uint8Array view', new Uint8Array(8)],
    ['Uint8Array over SharedArrayBuffer', new Uint8Array(new SharedArrayBuffer(8))],
    ['Float64Array view', new Float64Array(2)],
    ['DataView view', new DataView(new ArrayBuffer(8))],
    ['ArrayBuffer', new ArrayBuffer(8)],
    ['SharedArrayBuffer', new SharedArrayBuffer(8)],
    ['string', 'bytes'],
    ['number', 104],
    ['bigint', BigInt(8)],
    ['boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['symbol', Symbol('bytes')],
    ['array of byte numbers', [104, 105]],
    ['nested parts array', [[Buffer.from('x')]]],
    ['function', () => {}],
    ['Date', new Date()],
    ['Map', new Map([[0, Buffer.from('x')]])],
    ['Set', new Set([Buffer.from('x')])],
    ['RegExp', /bytes/u],
    ['Error', new Error('bytes')],
    ['Promise', Promise.resolve()],
    ['web ReadableStream', new ReadableStream()],
    ['node PassThrough stream', new PassThrough()],
    ['Buffer-returning Number wrapper', Object(4)],
  ];
  for (const [name, part] of cases) {
    const error = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part]));
    assert.equal(error.code, 'invalid_type', name);
    assert.equal(error.path, 'parts[0]', name);
  }
  // A brand-less object wearing Buffer.prototype passes the Uint8Array
  // instance chain but fails the exact-prototype check.
  const branded = errorOf(() =>
    identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [Object.create(Buffer.prototype)]));
  assert.equal(branded.code, 'invalid_object');
});

test('custom prototypes and Proxies never reach byte reads', () => {
  // Live Proxy over a real Buffer: rejected before any trap dispatch.
  const buffer = Buffer.from('proxied');
  const trapCounts = { get: 0, has: 0, set: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
  const counted = new Proxy(buffer, {
    get: (target, key, receiver) => (trapCounts.get += 1, Reflect.get(target, key, receiver)),
    has: (target, key) => (trapCounts.has += 1, Reflect.has(target, key)),
    set: (target, key, value) => (trapCounts.set += 1, Reflect.set(target, key, value)),
    ownKeys: (target) => (trapCounts.ownKeys += 1, Reflect.ownKeys(target)),
    getOwnPropertyDescriptor: (target, key) => (
      trapCounts.getOwnPropertyDescriptor += 1, Reflect.getOwnPropertyDescriptor(target, key)),
    getPrototypeOf: (target) => (trapCounts.getPrototypeOf += 1, Reflect.getPrototypeOf(target)),
  });
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [counted])).code,
    'invalid_object');
  assert.deepEqual(trapCounts, { get: 0, has: 0, set: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 });

  // Revoked Proxy: rejected fail-closed instead of surfacing a TypeError.
  const { proxy, revoke } = Proxy.revocable(buffer, {});
  revoke();
  const revokedError = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [proxy]));
  assert.equal(revokedError.code, 'invalid_object');

  // Proxy containers are equally rejected before any element is touched.
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE,
    new Proxy([buffer], {}))).code, 'invalid_array');
  const { proxy: revokedParts, revoke: revokeParts } = Proxy.revocable([buffer], {});
  revokeParts();
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, revokedParts)).code,
    'invalid_array');
});

test('Buffer prototype proxies cannot execute traps or swap the validated part', () => {
  const original = Buffer.from('x');
  const replacement = Buffer.alloc(MAX_IDENTITY_DIGEST_INPUT_BYTES + 1, 0x61);
  const parts = [original];
  let prototypeTrapRuns = 0;
  const hostilePrototype = new Proxy(Buffer.prototype, {
    getPrototypeOf() {
      prototypeTrapRuns += 1;
      parts[0] = replacement;
      Object.setPrototypeOf(original, Buffer.prototype);
      return Buffer.prototype;
    },
  });
  Object.setPrototypeOf(original, hostilePrototype);

  const error = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, parts));
  assert.equal(error.code, 'invalid_object');
  assert.equal(error.path, 'parts[0]');
  assert.equal(prototypeTrapRuns, 0);
  assert.equal(parts[0], original);
  assert.doesNotMatch(error.message, /replacement|prototype trap/iu);
});

test('non-byte typed arrays cannot acquire Buffer authority by prototype spoofing', () => {
  for (const value of [new Uint16Array([0x6162]), new Float64Array([42])]) {
    Object.setPrototypeOf(value, Buffer.prototype);
    const error = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [value]));
    assert.equal(error.code, 'invalid_object');
    assert.equal(error.path, 'parts[0]');
  }
});

test('digest copying uses module-captured Buffer and Uint8Array intrinsics', () => {
  const nativeBuffer = globalThis.Buffer;
  const nativeUint8Array = globalThis.Uint8Array;
  const part = nativeBuffer.from('captured');
  const expected = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part]);
  let hostileRuns = 0;
  try {
    globalThis.Buffer = {
      isBuffer() {
        hostileRuns += 1;
        throw new Error('hostile Buffer.isBuffer ran');
      },
    };
    globalThis.Uint8Array = class HostileUint8Array {
      constructor() {
        hostileRuns += 1;
        throw new Error('hostile Uint8Array constructor ran');
      }
    };
    const actual = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part]);
    assert.deepEqual(actual, expected);
  } finally {
    globalThis.Buffer = nativeBuffer;
    globalThis.Uint8Array = nativeUint8Array;
  }
  assert.equal(hostileRuns, 0);
});

test('hostile getters and coercion hooks never run', () => {
  let getterReads = 0;
  const getterPart = {
    get length() {
      getterReads += 1;
      return 4;
    },
    get 0() {
      getterReads += 1;
      return 104;
    },
  };
  const coercionCounts = { valueOf: 0, toString: 0, toPrimitive: 0 };
  const coercingPart = {
    valueOf() {
      coercionCounts.valueOf += 1;
      return Buffer.from('spoofed');
    },
    toString() {
      coercionCounts.toString += 1;
      return Buffer.from('spoofed');
    },
    [Symbol.toPrimitive]() {
      coercionCounts.toPrimitive += 1;
      return Buffer.from('spoofed');
    },
  };
  const throwingPart = {
    get poisoned() {
      throw new Error('getter must never run');
    },
  };
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [getterPart])).code,
    'invalid_type');
  assert.equal(getterReads, 0);
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [coercingPart])).code,
    'invalid_type');
  assert.deepEqual(coercionCounts, { valueOf: 0, toString: 0, toPrimitive: 0 });
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [throwingPart])).code,
    'invalid_type');
});

test('lengths are read through trusted internal slots, never spoofable properties', () => {
  // Spoofed long length must not trip the cap or lie in input_bytes.
  const long = Buffer.from('abcd');
  Object.defineProperty(long, 'length', { value: MAX_IDENTITY_DIGEST_INPUT_BYTES + 1 });
  const longDescriptor = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [long]);
  assert.equal(longDescriptor.input_bytes, 4);
  assert.equal(longDescriptor.digest,
    identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [Buffer.from('abcd')]).digest);
  // Spoofed short length must not hide real bytes from the digest.
  const short = Buffer.from('abcd');
  Object.defineProperty(short, 'length', { value: 1 });
  const shortDescriptor = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [short]);
  assert.equal(shortDescriptor.input_bytes, 4);
  assert.equal(shortDescriptor.digest,
    identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [Buffer.from('abcd')]).digest);
  // Shrinking a container's length property truncates the array (JS
  // semantics), so a spoofed length can never smuggle hidden parts past the
  // cap: only the elements the container honestly exposes are ever hashed.
  const parts = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS + 1 }, () => Buffer.from('x'));
  Object.defineProperty(parts, 'length', { value: 1 });
  const truncated = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, parts);
  assert.equal(truncated.input_bytes, 1);
  assert.equal(truncated.digest,
    identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [Buffer.from('x')]).digest);
  // A non-writable, non-configurable length spoof attempt is a plain TypeError
  // from the platform, never a digest over spoofed bounds.
  const frozenParts = Object.freeze(Array.from({ length: 2 }, () => Buffer.from('x')));
  assert.throws(() => Object.defineProperty(frozenParts, 'length', { value: 99 }), TypeError);
  assert.equal(identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, frozenParts).input_bytes, 2);
});

// --- Hostile parts containers ------------------------------------------------

test('parts containers must be bounded ordinary arrays with dense indexed data slots', () => {
  const part = Buffer.from('x');
  const containers = [
    ['undefined', undefined],
    ['null', null],
    ['number', 4],
    ['string', 'x'],
    ['plain object', {}],
    ['length-shaped object', { length: 1, 0: part }],
    ['Map', new Map()],
    ['Set', new Set([part])],
    ['Array subclass', (() => {
      class Parts extends Array {}
      return Parts.of(part);
    })()],
    ['sparse array', (() => {
      const sparse = new Array(2);
      sparse[1] = part;
      return sparse;
    })()],
  ];
  for (const [name, container] of containers) {
    const error = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, container));
    assert.ok(['invalid_type', 'invalid_array'].includes(error.code), `${name}: ${error.code}`);
    assert.equal(error.path, 'parts', name);
  }
  // Data-only hardening is fine: frozen arrays remain valid.
  const descriptor = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, Object.freeze([part]));
  assert.equal(descriptor.input_bytes, 1);
});

test('irrelevant array decorations are not enumerated or included in the digest', () => {
  const part = Buffer.from('x');
  const decorated = [part];
  let getterRuns = 0;
  Object.defineProperty(decorated, 'poison', {
    enumerable: true,
    get() {
      getterRuns += 1;
      throw new Error('decoration getter ran');
    },
  });
  Object.defineProperty(decorated, Symbol('poison'), {
    enumerable: true,
    get() {
      getterRuns += 1;
      throw new Error('symbol decoration getter ran');
    },
  });
  for (let index = 0; index < 50_000; index += 1) {
    decorated[`extra_${index}`] = index;
  }
  const nativeOwnKeys = Reflect.ownKeys;
  let ownKeysCalls = 0;
  Reflect.ownKeys = (...args) => {
    ownKeysCalls += 1;
    return nativeOwnKeys(...args);
  };
  let actual;
  try {
    actual = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, decorated);
  } finally {
    Reflect.ownKeys = nativeOwnKeys;
  }
  assert.equal(getterRuns, 0);
  assert.equal(ownKeysCalls, 0);
  assert.deepEqual(actual, identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part]));
});

// --- Detached backing, hostile labels, and bounded containers (P03R4) --------

const UNREADABLE_PART_DIAGNOSTIC =
  'A digest part could not be snapshotted through trusted typed-array internal slots.';
const UNKNOWN_LABEL_DIAGNOSTIC =
  'Identity label is not a ratified identity label; pass an IDENTITY_LABELS constant.';

function detachBackingStore(backing) {
  const view = Buffer.from(backing);
  structuredClone(backing, { transfer: [backing] });
  assert.equal(backing.detached, true);
  return view;
}

test('detached-backing Buffers fail with one stable content-free typed error', () => {
  const detached = detachBackingStore(new ArrayBuffer(8));
  detached.write('drift');
  // Every structural ordinary-Buffer check still passes; only the trusted
  // snapshot can discover the detachment.
  assert.equal(Buffer.isBuffer(detached), true);
  assert.equal(Object.getPrototypeOf(detached), Buffer.prototype);

  const single = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [detached]));
  assert.equal(single.code, 'invalid_object');
  assert.equal(single.path, 'parts');
  assert.equal(single.message, UNREADABLE_PART_DIAGNOSTIC);
  assert.ok(single instanceof RunContractV1Error);
  // No platform TypeError text and no reflected caller content escapes.
  assert.ok(!single.message.includes('Cannot perform Construct'));
  assert.ok(!single.message.includes('drift'));

  // The diagnostic is one stable error everywhere: mixed containers, other
  // surfaces, repeated calls, and zero-length detached stores all agree on
  // the same constant code, path, and message.
  const mixed = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE,
    [Buffer.from('ok'), detached]));
  assert.deepEqual(
    { code: mixed.code, path: mixed.path, message: mixed.message },
    { code: single.code, path: single.path, message: single.message },
  );
  const zeroView = detachBackingStore(new ArrayBuffer(0));
  const zero = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, [zeroView]));
  assert.deepEqual(
    { code: zero.code, path: zero.path, message: zero.message },
    { code: single.code, path: single.path, message: single.message },
  );
  assert.equal(
    errorOf(() => identityDigestV1(IDENTITY_LABELS.PROVIDER_CAPABILITY, [detached])).message,
    UNREADABLE_PART_DIAGNOSTIC,
  );

  // Ordinary, pooled, subarray, empty, and caller-ArrayBuffer-backed Buffers
  // remain accepted and byte exact.
  const accepted = [
    Buffer.from('abc'),
    Buffer.allocUnsafe(4),
    Buffer.from('abcdefgh').subarray(2, 5),
    Buffer.alloc(0),
    Buffer.from(new ArrayBuffer(4)),
  ];
  for (const part of accepted) {
    const descriptor = identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [part]);
    assert.equal(descriptor.digest, expectedFramedDigestHex(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [part]));
  }
});

test('hostile digest labels are stopped by the O(1) content-free preflight', () => {
  const hostiles = [
    // Overlength with embedded credential-shaped material.
    `sk-live-${'A'.repeat(4096)}-9f27c4d8e5b2SECRET`,
    `${'token '.repeat(1024)}ghp_0123456789abcdefghijklmnopqrstuvwxyz`,
    `${'x'.repeat(MAX_IDENTITY_LABEL_CODE_UNITS + 1)}\u0000secret`,
    // Control-bearing shapes.
    'run-manifest.v1\u0000\u0007\n\r\t',
    '\u0000'.repeat(MAX_IDENTITY_LABEL_CODE_UNITS),
    // Exact preflight boundaries: at the bound and one over it.
    'b'.repeat(MAX_IDENTITY_LABEL_CODE_UNITS),
    'c'.repeat(MAX_IDENTITY_LABEL_CODE_UNITS + 1),
    // Ordinary unknown labels receive the identical constant diagnostic.
    'rogue.v1', 'run-manifest.v2', '',
  ];
  for (const label of hostiles) {
    const error = errorOf(() => identityDigestV1(label, [Buffer.from('x')]));
    assert.equal(error.code, 'unknown_label');
    assert.equal(error.path, 'label');
    assert.equal(error.message, UNKNOWN_LABEL_DIAGNOSTIC);
    if (label.length > 0) {
      assert.ok(!error.message.includes(label));
      assert.ok(!UNKNOWN_LABEL_DIAGNOSTIC.includes(label.slice(0, 64)));
    }
  }
  assert.equal(MAX_IDENTITY_LABEL_CODE_UNITS, 64);
  // Registered constants still resolve through the same entry point.
  assert.equal(identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, []).label, 'run-identity.v1');
});

test('active and revoked proxy containers are rejected before cap and traversal', () => {
  const overCap = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS + 1 }, () => Buffer.from('x'));
  const trapCounts = {
    get: 0, has: 0, set: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0,
  };
  const counted = new Proxy(overCap, {
    get: (target, key, receiver) => (trapCounts.get += 1, Reflect.get(target, key, receiver)),
    has: (target, key) => (trapCounts.has += 1, Reflect.has(target, key)),
    set: (target, key, value) => (trapCounts.set += 1, Reflect.set(target, key, value)),
    ownKeys: (target) => (trapCounts.ownKeys += 1, Reflect.ownKeys(target)),
    getOwnPropertyDescriptor: (target, key) => (
      trapCounts.getOwnPropertyDescriptor += 1, Reflect.getOwnPropertyDescriptor(target, key)),
    getPrototypeOf: (target) => (trapCounts.getPrototypeOf += 1, Reflect.getPrototypeOf(target)),
  });
  // An over-cap active Proxy is rejected as a Proxy first, never as a count
  // error, and no trap ever runs.
  const active = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, counted));
  assert.equal(active.code, 'invalid_array');
  assert.equal(active.path, 'parts');
  assert.deepEqual(trapCounts, {
    get: 0, has: 0, set: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0,
  });

  // A revoked Proxy must not leak the platform IsArray TypeError even though
  // its target would also exceed the cap; under-cap revoked Proxies fail
  // identically.
  const { proxy, revoke } = Proxy.revocable(overCap, {});
  revoke();
  const revoked = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, proxy));
  assert.equal(revoked.code, 'invalid_array');
  assert.equal(revoked.path, 'parts');
  assert.ok(revoked instanceof RunContractV1Error);
  const { proxy: small, revoke: revokeSmall } = Proxy.revocable([Buffer.from('x')], {});
  revokeSmall();
  const smallError = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, small));
  assert.deepEqual(
    { code: smallError.code, path: smallError.path },
    { code: revoked.code, path: revoked.path },
  );
});

test('over-cap containers fail on the exact cap before any deep traversal', () => {
  // Sparse over-cap: the huge length is judged O(1); holes are never walked.
  const sparse = [];
  sparse.length = 50_000;
  sparse[49_999] = Buffer.from('x');
  const sparseError = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, sparse));
  assert.equal(sparseError.code, 'parts_exceeded');
  assert.equal(sparseError.path, 'parts');
  assert.match(sparseError.message, /at most 16 parts/u);
  assert.match(sparseError.message, /received 50000/u);

  // Huge length-only container: rejected without materializing anything.
  const hugeError = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, new Array(2 ** 28)));
  assert.equal(hugeError.code, 'parts_exceeded');

  // Dense over-cap of hostile non-Buffer elements: the cap wins before any
  // element type validation runs.
  const hostileDense = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS + 1 }, () => null);
  assert.equal(
    errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, hostileDense)).code,
    'parts_exceeded',
  );

  // Decorated over-cap: extra and symbol properties cannot turn the cap
  // error into a density error, because the cap is enforced first.
  const decorated = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS + 1 }, () => Buffer.from('x'));
  decorated.extra = 'decoration';
  decorated[Symbol('extra')] = true;
  assert.equal(
    errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, decorated)).code,
    'parts_exceeded',
  );

  // Under-cap decorations are outside the bounded semantic surface and do
  // not affect the indexed part list or its digest.
  const underCapDecorated = [Buffer.from('x')];
  underCapDecorated.extra = true;
  assert.deepEqual(
    identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, underCapDecorated),
    identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, [Buffer.from('x')]),
  );
});

test('the exact 16/17 part boundary is exact under hostile shapes', () => {
  const oneByte = Buffer.from('x');
  const atCap = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS }, () => oneByte);
  const atCapDescriptor = identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, atCap);
  assert.equal(atCapDescriptor.input_bytes, MAX_IDENTITY_DIGEST_PARTS);
  assert.equal(atCapDescriptor.digest, expectedFramedDigestHex(IDENTITY_LABELS.RUN_IDENTITY, atCap));

  const detached = detachBackingStore(new ArrayBuffer(4));
  // At 16 parts the cap passes, so the detached part is discovered by the
  // trusted snapshot and normalizes to the stable detached diagnostic.
  const sixteenWithDetached = errorOf(() => identityDigestV1(
    IDENTITY_LABELS.RUN_IDENTITY, [...atCap.slice(0, -1), detached]));
  assert.equal(sixteenWithDetached.code, 'invalid_object');
  assert.equal(sixteenWithDetached.path, 'parts');
  assert.equal(sixteenWithDetached.message, UNREADABLE_PART_DIAGNOSTIC);

  // At 17 parts the cap fires before any element is read, even when a later
  // element is detached or hostile.
  const seventeen = [...atCap, oneByte];
  assert.equal(
    errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, seventeen)).code,
    'parts_exceeded',
  );
  const seventeenWithDetached = [...atCap, detached];
  assert.equal(
    errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, seventeenWithDetached)).code,
    'parts_exceeded',
  );

  // Under the cap, accessor elements still fail the exact existing density
  // check at the exact part index, and the getter never runs.
  let getterRuns = 0;
  const accessor = atCap.slice();
  Object.defineProperty(accessor, 7, {
    enumerable: true,
    configurable: true,
    get() {
      getterRuns += 1;
      return oneByte;
    },
  });
  const accessorError = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, accessor));
  assert.equal(accessorError.code, 'invalid_array');
  assert.equal(accessorError.path, 'parts[7]');
  assert.equal(getterRuns, 0);
});

// --- Exact caps and deterministic first errors -------------------------------

test('the part-count cap is exact and fails closed', () => {
  const oneByte = Buffer.from('x');
  const atCap = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS }, () => Buffer.from('x'));
  const overCap = [...atCap, oneByte];
  const descriptor = identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, atCap);
  assert.equal(descriptor.input_bytes, MAX_IDENTITY_DIGEST_PARTS);
  const error = errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, overCap));
  assert.equal(error.code, 'parts_exceeded');
  assert.equal(error.path, 'parts');
  assert.match(error.message, /at most 16 parts/u);
  // Count is checked before element contents: a hostile element cannot change
  // which error an oversized container produces.
  const hostileOverCap = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS + 1 }, (_, index) => (
    index === 3 ? 'not-a-buffer' : Buffer.from('x')));
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, hostileOverCap)).code,
    'parts_exceeded');
});

test('the total-input cap is exact and fails closed', () => {
  const partBytes = MAX_IDENTITY_DIGEST_INPUT_BYTES / MAX_IDENTITY_DIGEST_PARTS;
  const exact = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS }, () => Buffer.alloc(partBytes));
  const descriptor = identityDigestV1(IDENTITY_LABELS.PROVIDER_CAPABILITY, exact);
  assert.equal(descriptor.input_bytes, MAX_IDENTITY_DIGEST_INPUT_BYTES);
  assert.equal(descriptor.digest,
    expectedFramedDigestHex(IDENTITY_LABELS.PROVIDER_CAPABILITY, exact));

  const oneOver = [...exact.slice(0, -1), Buffer.alloc(partBytes + 1)];
  const overError = errorOf(() => identityDigestV1(IDENTITY_LABELS.PROVIDER_CAPABILITY, oneOver));
  assert.equal(overError.code, 'unbounded_input');
  assert.match(overError.message, /4194304-byte total bound at parts\[15\]/u);

  const singleOver = [Buffer.alloc(MAX_IDENTITY_DIGEST_INPUT_BYTES + 1)];
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.PROVIDER_CAPABILITY, singleOver)).code,
    'unbounded_input');
  // Bytes are checked in index order: the first crossing part is reported.
  const half = Buffer.alloc(MAX_IDENTITY_DIGEST_INPUT_BYTES / 2);
  const crossError = errorOf(() => identityDigestV1(
    IDENTITY_LABELS.PROVIDER_CAPABILITY, [half, Buffer.alloc((MAX_IDENTITY_DIGEST_INPUT_BYTES / 2) + 1)]));
  assert.equal(crossError.code, 'unbounded_input');
  assert.match(crossError.message, /parts\[1\]/u);
  // Byte accumulation precedes any later element's type validation.
  const firstCrossing = errorOf(() => identityDigestV1(
    IDENTITY_LABELS.PROVIDER_CAPABILITY,
    [Buffer.alloc(MAX_IDENTITY_DIGEST_INPUT_BYTES + 1), 'hostile-later']));
  assert.equal(firstCrossing.code, 'unbounded_input');
  assert.match(firstCrossing.message, /parts\[0\]/u);
  const exactlyAtCapThenHostile = errorOf(() => identityDigestV1(
    IDENTITY_LABELS.PROVIDER_CAPABILITY, [Buffer.alloc(MAX_IDENTITY_DIGEST_INPUT_BYTES), 'hostile-later']));
  assert.equal(exactlyAtCapThenHostile.code, 'invalid_type');
});

test('validation order is fixed: label, container, count, then parts in index order', () => {
  assert.equal(errorOf(() => identityDigestV1('rogue.v1', 'nope')).code, 'unknown_label');
  assert.equal(errorOf(() => identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, 'nope')).code, 'invalid_type');
  assert.equal(errorOf(() => identityDigestV1(
    IDENTITY_LABELS.RUN_IDENTITY, Array.from({ length: 17 }, () => 'hostile'))).code, 'parts_exceeded');
  assert.equal(errorOf(() => identityDigestV1(
    IDENTITY_LABELS.RUN_IDENTITY, [Buffer.from('ok'), 'hostile'])).code, 'invalid_type');
  // An empty parts list is valid data, not an error.
  const empty = identityDigestV1(IDENTITY_LABELS.RUN_IDENTITY, []);
  assert.equal(empty.input_bytes, 0);
});

test('empty parts lists and empty parts are distinct, stable frames', () => {
  const noParts = identityDigestV1(IDENTITY_LABELS.VERIFICATION_POLICY, []);
  const emptyPart = identityDigestV1(IDENTITY_LABELS.VERIFICATION_POLICY, [Buffer.alloc(0)]);
  assert.equal(noParts.input_bytes, 0);
  assert.equal(emptyPart.input_bytes, 0);
  assert.notEqual(noParts.digest, emptyPart.digest);
  assert.equal(noParts.digest, expectedFramedDigestHex(IDENTITY_LABELS.VERIFICATION_POLICY, []));
  assert.equal(emptyPart.digest,
    expectedFramedDigestHex(IDENTITY_LABELS.VERIFICATION_POLICY, [Buffer.alloc(0)]));
  assert.equal(identityDigestV1(IDENTITY_LABELS.VERIFICATION_POLICY, []).digest, noParts.digest);
  const sixteenEmpty = Array.from({ length: MAX_IDENTITY_DIGEST_PARTS }, () => Buffer.alloc(0));
  const sixteenDescriptor = identityDigestV1(IDENTITY_LABELS.VERIFICATION_POLICY, sixteenEmpty);
  assert.equal(sixteenDescriptor.input_bytes, 0);
  assert.notEqual(sixteenDescriptor.digest, noParts.digest);
});

// --- Unambiguous framing and domain separation -------------------------------

test('framing makes every part splitting a unique preimage', () => {
  const splittings = [
    [Buffer.from('abc')],
    [Buffer.from('ab'), Buffer.from('c')],
    [Buffer.from('a'), Buffer.from('bc')],
    [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')],
    [Buffer.from(''), Buffer.from('abc')],
    [Buffer.from('abc'), Buffer.from('')],
    [Buffer.from('a'), Buffer.from(''), Buffer.from('bc')],
    [Buffer.from(''), Buffer.from(''), Buffer.from('abc')],
  ];
  const digests = new Set();
  for (const splitting of splittings) {
    const descriptor = identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, splitting);
    digests.add(descriptor.digest);
    assert.equal(descriptor.digest, expectedFramedDigestHex(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, splitting));
  }
  assert.equal(digests.size, splittings.length, 'distinct splittings must never share a digest');

  // The naive concatenation these splittings collapse into.
  const naive = (parts) => createHash('sha256').update(Buffer.concat(parts)).digest('hex');
  assert.equal(naive([Buffer.from('ab'), Buffer.from('c')]), naive([Buffer.from('a'), Buffer.from('bc')]));
  assert.notEqual(
    identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [Buffer.from('ab'), Buffer.from('c')]).digest,
    identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [Buffer.from('a'), Buffer.from('bc')]).digest,
  );
});

test('identical bytes under different labels never share a digest', () => {
  const payload = Buffer.from('same bytes');
  const labels = Object.values(IDENTITY_LABELS);
  const digests = new Set();
  for (const label of labels) {
    const descriptor = identityDigestV1(label, [payload]);
    assert.equal(descriptor.digest, expectedFramedDigestHex(label, [payload]));
    assert.ok(!digests.has(descriptor.digest), `${label} collided with another label`);
    digests.add(descriptor.digest);
  }
  assert.equal(digests.size, labels.length);
});

// --- Mutation-proof, detached descriptors ------------------------------------

test('later caller mutation cannot drift an already-taken digest', () => {
  const mutable = Buffer.from('one');
  const before = identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [mutable]);
  mutable.write('two');
  const after = identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [mutable]);
  assert.notEqual(before.digest, after.digest);
  assert.equal(before.digest, identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [Buffer.from('one')]).digest);
  assert.equal(after.digest, identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [Buffer.from('two')]).digest);

  // Subarray views stay pinned to the bytes they exposed at digest time.
  const parent = Buffer.from('0123456789');
  const view = parent.subarray(2, 6);
  const viewDigest = identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [view]).digest;
  parent.fill('x');
  assert.equal(identityDigestV1(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, [Buffer.from('2345')]).digest, viewDigest);
});

test('descriptors are deeply frozen, primitive-only, and detached', () => {
  const descriptor = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [Buffer.from('detach')]);
  assert.ok(Object.isFrozen(descriptor));
  assert.deepEqual([...Object.keys(descriptor)].sort(),
    ['algorithm', 'digest', 'domain', 'input_bytes', 'label', 'version']);
  assert.equal(descriptor.algorithm, 'sha256');
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), { ...descriptor });
  assert.throws(() => { 'use strict'; descriptor.digest = '00'; }, TypeError);
  assert.equal(descriptor.input_bytes, 6);
});

// --- Golden stability for the existing RunIdentityV1 surfaces ----------------

test('manifest, prompt, envelope, and run-identity goldens keep their exact bytes', () => {
  const manifest = goldenManifest();
  const envelope = compileChildEnvelopeV1(manifest, 'backend-writer');
  // Pinned against the accepted product-foundation identity bytes for this
  // fixture; the authority refactor must not move one byte.
  assert.deepEqual(runManifestDigestV1(manifest), {
    algorithm: 'sha256',
    domain: 'codex-co-engineer.identity.v1',
    version: 1,
    label: 'run-manifest.v1',
    input_bytes: 1178,
    digest: '636efc2ef2d5496c273cffccb05540343ec4468755903eae0a22f320abd65522',
  });
  assert.deepEqual(assignmentPromptDigestV1(manifest, 'backend-writer'), {
    algorithm: 'sha256',
    domain: 'codex-co-engineer.identity.v1',
    version: 1,
    label: 'assignment-prompt.v1',
    input_bytes: 55,
    digest: 'cf3673907687460df58957149361aaa4ffb63ba31d15f32ca40a4f63c59fcc88',
  });
  assert.deepEqual(assignmentPromptDigestV1(manifest, 'frontend-writer'), {
    algorithm: 'sha256',
    domain: 'codex-co-engineer.identity.v1',
    version: 1,
    label: 'assignment-prompt.v1',
    input_bytes: 49,
    digest: 'f64f9226311397247d575d4544a400ad00da7281d3504f4cba4383d87f2e0ccb',
  });
  assert.deepEqual(childEnvelopeDigestV1(envelope), {
    algorithm: 'sha256',
    domain: 'codex-co-engineer.identity.v1',
    version: 1,
    label: 'child-envelope.v1',
    input_bytes: 1519,
    digest: '61359b14dcaf7dcf5015ea1242ecdbd49540f125a75942f5bd31527ee4b85f30',
  });
  const identity = describeRunIdentityV1(manifest);
  assert.deepEqual(identity.assignment_prompt_digests.map((entry) => entry.digest), [
    'cf3673907687460df58957149361aaa4ffb63ba31d15f32ca40a4f63c59fcc88',
    'f64f9226311397247d575d4544a400ad00da7281d3504f4cba4383d87f2e0ccb',
  ]);
  assert.equal(identity.manifest_digest.digest,
    '636efc2ef2d5496c273cffccb05540343ec4468755903eae0a22f320abd65522');
  assert.ok(verifyRunManifestDigestV1(manifest, identity.manifest_digest.digest));
});

test('the generic helper shares one framing with every dedicated surface', () => {
  const manifest = goldenManifest();
  const envelope = compileChildEnvelopeV1(manifest, 'backend-writer');
  const canonicalManifest = runManifestCanonicalJsonV1(manifest);
  assert.deepEqual(
    identityDigestV1(IDENTITY_LABELS.RUN_MANIFEST, [Buffer.from(canonicalManifest, 'utf8')]),
    runManifestDigestV1(manifest),
  );
  const assignment = parseRunManifestV1(manifest).assignments[0];
  assert.deepEqual(
    identityDigestV1(IDENTITY_LABELS.ASSIGNMENT_PROMPT, [
      Buffer.from(manifest.run_id, 'utf8'),
      Buffer.from(assignment.assignment_id, 'utf8'),
      Buffer.from(assignment.prompt, 'utf8'),
    ]),
    assignmentPromptDigestV1(manifest, assignment.assignment_id),
  );
  assert.deepEqual(
    identityDigestV1(IDENTITY_LABELS.CHILD_ENVELOPE, [
      Buffer.from(canonicalJsonStringify(parseChildEnvelopeV1(envelope.envelope_text)), 'utf8'),
    ]),
    childEnvelopeDigestV1(envelope),
  );
});

test('growable ArrayBuffer-backed Buffers are rejected before any byte snapshot', () => {
  const growable = new ArrayBuffer(8, { maxByteLength: 16 });
  const part = Buffer.from(growable);
  assert.equal(Buffer.isBuffer(part), true);
  assert.equal(Object.getPrototypeOf(part), Buffer.prototype);
  part.write('drift');
  const error = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part]));
  assert.equal(error.code, 'invalid_object');
  assert.equal(error.path, 'parts[0]');
  assert.match(error.message, /growable/u);
  assert.ok(error.message.length < 200);
  const mixed = errorOf(() => identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE,
    [Buffer.from('ok'), part]));
  assert.equal(mixed.code, 'invalid_object');
  assert.equal(mixed.path, 'parts[1]');
  const fixed = Buffer.from(new ArrayBuffer(8));
  const descriptor = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [fixed]);
  assert.equal(descriptor.digest, expectedFramedDigestHex(IDENTITY_LABELS.EVIDENCE_BUNDLE, [fixed]));
});

test('digest framing captures writeUInt32BE, hash, JSON, and String at import', () => {
  const part = Buffer.from('captured-seams');
  const second = Buffer.from('two');
  const expectedOne = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part]);
  const expectedTwo = expectedFramedDigestHex(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part, second]);
  const expectedJson = '{"a":"x","z":1}';
  const nativeWrite = Buffer.prototype.writeUInt32BE;
  const hashPrototype = Object.getPrototypeOf(createHash('sha256'));
  const nativeUpdate = hashPrototype.update;
  const nativeDigest = hashPrototype.digest;
  const nativeStringify = JSON.stringify;
  const nativeString = globalThis.String;
  let hostileRuns = 0;
  const boom = () => {
    hostileRuns += 1;
    throw new Error('hostile intrinsic ran');
  };
  try {
    Buffer.prototype.writeUInt32BE = function writeUInt32BEHostile() { return boom(); };
    hashPrototype.update = function updateHostile() { return boom(); };
    hashPrototype.digest = function digestHostile() { return boom(); };
    JSON.stringify = function stringifyHostile() { return boom(); };
    globalThis.String = function StringHostile() { return boom(); };
    const actual = identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part, second]);
    assert.equal(actual.digest, expectedTwo);
    assert.equal(canonicalJsonStringify({ z: 1, a: 'x' }), expectedJson);
  } finally {
    Buffer.prototype.writeUInt32BE = nativeWrite;
    hashPrototype.update = nativeUpdate;
    hashPrototype.digest = nativeDigest;
    JSON.stringify = nativeStringify;
    globalThis.String = nativeString;
  }
  assert.equal(hostileRuns, 0);
  assert.deepEqual(identityDigestV1(IDENTITY_LABELS.EVIDENCE_BUNDLE, [part]), expectedOne);
});

test('unratified historical labels never become registry members', () => {
  for (const label of [
    'resolved-plan.v1', 'artifact-id.v1', 'candidate-composition.v1', 'run-decision.v1',
  ]) {
    const error = errorOf(() => identityDigestV1(label, [Buffer.from('x')]));
    assert.equal(error.code, 'unknown_label');
    assert.equal(error.path, 'label');
    assert.equal(error.message, UNKNOWN_LABEL_DIAGNOSTIC);
  }
  assert.equal(Object.hasOwn(IDENTITY_LABELS, 'RESOLVED_PLAN'), false);
  assert.equal(Object.hasOwn(IDENTITY_LABELS, 'ARTIFACT_ID'), false);
  assert.equal(Object.hasOwn(IDENTITY_LABELS, 'CANDIDATE_COMPOSITION'), false);
  assert.equal(Object.hasOwn(IDENTITY_LABELS, 'RUN_DECISION'), false);
});
