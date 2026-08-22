// Runtime tests for RunIdentityV1 deterministic digests (P03, commit 3 of 3):
// canonical JSON strictness, domain separation and versioning, key-order and
// whitespace equivalence, meaningful-change inequality, opaque prompt
// binding, and rejection of ambiguous or unbounded digest inputs.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_MANIFEST_DEPTH,
  RunContractV1Error,
} from '../mcp/v3/run-manifest.mjs';
import {
  DIGEST_ALGORITHM,
  DIGEST_HEX_LENGTH,
  IDENTITY_DOMAIN,
  IDENTITY_LABELS,
  IDENTITY_VERSION,
  assignmentPromptDigestV1,
  canonicalJsonStringify,
  childEnvelopeDigestV1,
  describeRunIdentityV1,
  runManifestCanonicalJsonV1,
  runManifestDigestV1,
  verifyRunManifestDigestV1,
} from '../mcp/v3/identity.mjs';
import {
  MAX_ENVELOPE_BYTES,
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

function buildManifest(assignments, overrides = {}) {
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'identity-under-test',
    repository: { path: '/run-fixtures/repository', base_sha: BASE_SHA },
    objective: 'Hash canonical validated run identities.',
    assignments,
    policy: { ...POLICY },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
    ...overrides,
  };
}

function defaultManifest() {
  return buildManifest([
    writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} \u00e9.\n' }),
    writerAssignment('frontend-writer', {
      write_scope: ['web/**'],
      execution: { profile: 'fast-implementer' },
      prompt: 'Reviewer prompt.',
    }),
  ]);
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

function reverseKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value !== null && typeof value === 'object') {
    const rebuilt = {};
    for (const key of Object.keys(value).sort().reverse()) rebuilt[key] = reverseKeyOrder(value[key]);
    return rebuilt;
  }
  return value;
}

test('canonical JSON is sorted, minimal, and total', () => {
  assert.equal(canonicalJsonStringify({ b: 1, a: { d: [true, false, null], c: 'x' } }),
    '{"a":{"c":"x","d":[true,false,null]},"b":1}');
  assert.equal(canonicalJsonStringify({ z: 1, a: 2, m: 3, Z: 4 }),
    '{"Z":4,"a":2,"m":3,"z":1}');
  // Minimal escaping: only what JSON requires; non-ASCII stays raw UTF-8.
  assert.equal(canonicalJsonStringify({ s: 'quote" back\\ slash\n\tnewline\u00e9\u{1F98A}' }),
    '{"s":"quote\\" back\\\\ slash\\n\\tnewline\u00e9\u{1F98A}"}');
  assert.equal(canonicalJsonStringify({ zero: -0 }), '{"zero":0}');
  assert.equal(canonicalJsonStringify({ big: 2 ** 53 - 1, small: -(2 ** 53) + 1 }),
    `{"big":${2 ** 53 - 1},"small":${-(2 ** 53) + 1}}`);
  assert.equal(canonicalJsonStringify([]), '[]');
  assert.equal(canonicalJsonStringify({}), '{}');
});

test('canonical JSON rejects ambiguous, hostile, and unbounded forms', () => {
  const rejections = [
    ['undefined value', () => canonicalJsonStringify(undefined), 'invalid_type'],
    ['undefined member', () => canonicalJsonStringify({ a: undefined }), 'invalid_type'],
    ['function value', () => canonicalJsonStringify({ a: () => 1 }), 'invalid_type'],
    ['symbol value', () => canonicalJsonStringify({ a: Symbol('x') }), 'invalid_type'],
    ['symbol key', () => { const o = {}; o[Symbol('k')] = 1; canonicalJsonStringify(o); }, 'invalid_object'],
    ['bigint value', () => canonicalJsonStringify({ a: 1n }), 'invalid_type'],
    ['fractional number', () => canonicalJsonStringify({ a: 1.5 }), 'invalid_type'],
    ['NaN', () => canonicalJsonStringify({ a: Number.NaN }), 'invalid_type'],
    ['Infinity', () => canonicalJsonStringify({ a: Number.POSITIVE_INFINITY }), 'invalid_type'],
    ['lone surrogate', () => canonicalJsonStringify({ a: 'ok \ud800' }), 'invalid_format'],
    ['lone surrogate key', () => canonicalJsonStringify({ ['\udfff']: 1 }), 'invalid_format'],
    ['cycle', () => { const a = {}; a.self = a; canonicalJsonStringify(a); }, 'invalid_json_value'],
    ['alias', () => { const shared = { x: 1 }; canonicalJsonStringify({ a: shared, b: shared }); }, 'invalid_json_value'],
    ['sparse array', () => { const a = [1]; a[2] = 3; canonicalJsonStringify(a); }, 'invalid_array'],
    ['array extra property', () => { const a = [1]; a.extra = true; canonicalJsonStringify(a); }, 'invalid_array'],
    ['class instance', () => class Foo {}, 'invalid_type'],
    ['Map value', () => canonicalJsonStringify({ a: new Map() }), 'invalid_type'],
    ['depth exceeded', () => {
      let node = 1;
      for (let index = 0; index <= MAX_MANIFEST_DEPTH + 1; index += 1) node = [node];
      canonicalJsonStringify(node);
    }, 'depth_exceeded'],
  ];
  for (const [name, action, code] of rejections) {
    if (code === 'invalid_type' && name === 'class instance') {
      const instance = new (class Foo {})();
      assert.equal(errorOf(() => canonicalJsonStringify({ a: instance })).code, 'invalid_type', name);
      continue;
    }
    assert.equal(errorOf(action).code, code, name);
  }
});

test('manifest digests are equivalent across key order and serialization whitespace', () => {
  const manifest = defaultManifest();
  const canonical = runManifestCanonicalJsonV1(manifest);
  const shuffled = runManifestCanonicalJsonV1(reverseKeyOrder(JSON.parse(JSON.stringify(manifest))));
  assert.equal(canonical, shuffled);
  const minified = JSON.stringify(JSON.parse(JSON.stringify(manifest)));
  const pretty = JSON.stringify(JSON.parse(minified), null, 2);
  const digestCompact = runManifestDigestV1(JSON.parse(minified));
  const digestPretty = runManifestDigestV1(JSON.parse(pretty));
  const digestShuffled = runManifestDigestV1(reverseKeyOrder(JSON.parse(minified)));
  assert.equal(digestCompact.digest, digestPretty.digest);
  assert.equal(digestCompact.digest, digestShuffled.digest);
  // Repeated hashing never drifts.
  assert.equal(runManifestDigestV1(manifest).digest, digestCompact.digest);
});

test('manifest digest descriptors expose explicit domain separation and versioning', () => {
  const descriptor = runManifestDigestV1(defaultManifest());
  assert.equal(descriptor.algorithm, DIGEST_ALGORITHM);
  assert.equal(descriptor.domain, IDENTITY_DOMAIN);
  assert.equal(descriptor.version, IDENTITY_VERSION);
  assert.equal(descriptor.label, IDENTITY_LABELS.RUN_MANIFEST);
  assert.match(descriptor.digest, /^[0-9a-f]{64}$/u);
  assert.equal(descriptor.digest.length, DIGEST_HEX_LENGTH);
  assert.equal(descriptor.input_bytes, Buffer.byteLength(runManifestCanonicalJsonV1(defaultManifest()), 'utf8'));
  for (const label of Object.values(IDENTITY_LABELS)) {
    assert.match(label, /^[a-z0-9][a-z0-9.-]{0,63}$/u);
  }
});

test('meaningful manifest changes always change the digest', () => {
  const baseline = runManifestDigestV1(defaultManifest()).digest;
  const mutations = [
    ['prompt character', buildManifest([
      writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} \u00e9!\n' }),
      writerAssignment('frontend-writer', { write_scope: ['web/**'], execution: { profile: 'fast-implementer' } }),
    ])],
    ['prompt NFC versus NFD', buildManifest([
      writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} e\u0301.\n' }),
      writerAssignment('frontend-writer', { write_scope: ['web/**'], execution: { profile: 'fast-implementer' } }),
    ])],
    ['prompt trailing byte', buildManifest([
      writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} \u00e9.\n\n' }),
      writerAssignment('frontend-writer', { write_scope: ['web/**'], execution: { profile: 'fast-implementer' } }),
    ])],
    ['objective', buildManifest(defaultManifest().assignments, { objective: 'Hash canonical validated run identities!' })],
    ['run id', buildManifest(defaultManifest().assignments, { run_id: 'identity-under-test-2' })],
    ['base SHA', buildManifest(defaultManifest().assignments, {
      repository: { path: '/run-fixtures/repository', base_sha: 'b0a9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1' },
    })],
    ['assignment order', buildManifest([
      writerAssignment('frontend-writer', { write_scope: ['web/**'], execution: { profile: 'fast-implementer' } }),
      writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} \u00e9.\n' }),
    ])],
    ['provider choice', buildManifest([
      writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} \u00e9.\n', execution: { provider: 'grok', model: 'grok-4' } }),
      writerAssignment('frontend-writer', { write_scope: ['web/**'], execution: { profile: 'fast-implementer' } }),
    ])],
    ['scope pattern', buildManifest([
      writerAssignment('backend-writer', { prompt: 'Writer prompt \u{1F98A} \u00e9.\n', write_scope: ['src/**', 'test/**'] }),
      writerAssignment('frontend-writer', { write_scope: ['web/**'], execution: { profile: 'fast-implementer' } }),
    ])],
    ['concurrency policy', buildManifest(defaultManifest().assignments, { policy: { ...POLICY, max_concurrency: 4 } })],
  ];
  const seen = new Set([baseline]);
  for (const [name, mutated] of mutations) {
    const digest = runManifestDigestV1(mutated).digest;
    assert.notEqual(digest, baseline, `${name} did not change the manifest digest`);
    assert.ok(!seen.has(digest), `${name} collided with another mutation`);
    seen.add(digest);
  }
});

test('invalid manifests are never hashed', () => {
  assert.equal(errorOf(() => runManifestDigestV1({})).code, 'missing_key');
  assert.equal(errorOf(() => runManifestDigestV1(buildManifest(defaultManifest().assignments, { extra: true }))).code, 'unknown_key');
  assert.equal(errorOf(() => runManifestDigestV1(buildManifest([
    writerAssignment('backend-writer', { depends_on: ['other'] }),
  ]))).code, 'dependency_not_allowed');
  assert.equal(errorOf(() => runManifestDigestV1(buildManifest([
    writerAssignment('backend-writer'),
    writerAssignment('frontend-writer', { write_scope: ['src/api/**'] }),
  ]))).code, 'overlapping_writer_scope');
});

test('prompt digests bind opaque content to its run and lane', () => {
  const manifest = defaultManifest();
  const writer = assignmentPromptDigestV1(manifest, 'backend-writer');
  assert.equal(writer.label, IDENTITY_LABELS.ASSIGNMENT_PROMPT);
  assert.equal(writer.input_bytes,
    Buffer.byteLength(manifest.run_id, 'utf8')
    + Buffer.byteLength('backend-writer', 'utf8')
    + Buffer.byteLength(manifest.assignments[0].prompt, 'utf8'));

  const sameLaneOtherRun = assignmentPromptDigestV1(
    buildManifest(manifest.assignments, { run_id: 'identity-under-test-2' }), 'backend-writer');
  const otherLaneSameText = assignmentPromptDigestV1(
    buildManifest([
      writerAssignment('frontend-writer', { prompt: manifest.assignments[0].prompt, write_scope: ['web/**'] }),
      writerAssignment('backend-writer', { execution: { profile: 'fast-implementer' }, prompt: 'x' }),
    ]), 'frontend-writer');
  assert.notEqual(writer.digest, sameLaneOtherRun.digest, 'run identity must bind the prompt digest');
  assert.notEqual(writer.digest, otherLaneSameText.digest, 'lane identity must bind the prompt digest');
  assert.equal(errorOf(() => assignmentPromptDigestV1(manifest, 'ghost')).code, 'unknown_assignment_id');
  assert.equal(errorOf(() => assignmentPromptDigestV1(manifest, 0)).code, 'invalid_type');
});

test('swapping prompts between lanes changes every affected digest', () => {
  const manifest = defaultManifest();
  const before = describeRunIdentityV1(manifest);
  const swapped = buildManifest([
    writerAssignment('backend-writer', { prompt: 'Reviewer prompt.' }),
    writerAssignment('frontend-writer', {
      write_scope: ['web/**'],
      execution: { profile: 'fast-implementer' },
      prompt: 'Writer prompt \u{1F98A} \u00e9.\n',
    }),
  ]);
  const after = describeRunIdentityV1(swapped);
  assert.notEqual(before.manifest_digest.digest, after.manifest_digest.digest);
  assert.notEqual(before.assignment_prompt_digests[0].digest, after.assignment_prompt_digests[0].digest);
  assert.notEqual(before.assignment_prompt_digests[1].digest, after.assignment_prompt_digests[1].digest);
  // Digests travel with content, not position: each lane now hashes the other's text.
  // Prompt identity is content bound to its exact run + lane, never lane position.
  const loneBackend = describeRunIdentityV1(
    buildManifest([writerAssignment('backend-writer', { prompt: 'Reviewer prompt.' })]));
  const loneFrontend = describeRunIdentityV1(buildManifest([
    writerAssignment('frontend-writer', {
      write_scope: ['web/**'],
      execution: { profile: 'fast-implementer' },
      prompt: 'Writer prompt \u{1F98A} \u00e9.\n',
    }),
  ]));
  assert.equal(after.assignment_prompt_digests[0].digest, loneBackend.assignment_prompt_digests[0].digest);
  assert.equal(after.assignment_prompt_digests[1].digest, loneFrontend.assignment_prompt_digests[0].digest);
  assert.notEqual(before.assignment_prompt_digests[0].digest, loneBackend.assignment_prompt_digests[0].digest);
});

test('child envelope digests are canonical, stable, and content-bound', () => {
  const manifest = defaultManifest();
  const envelope = compileChildEnvelopeV1(manifest, 'backend-writer');
  const descriptor = childEnvelopeDigestV1(envelope);
  assert.equal(descriptor.label, IDENTITY_LABELS.CHILD_ENVELOPE);
  assert.match(descriptor.digest, /^[0-9a-f]{64}$/u);

  const reordered = reverseKeyOrder(JSON.parse(JSON.stringify(envelope)));
  assert.equal(childEnvelopeDigestV1(reordered).digest, descriptor.digest);
  // A structured form that disagrees with its own envelope_text is rejected
  // outright (see the dedicated adversarial test below), so meaningful
  // content changes must travel through the compiled text itself.
  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.acceptance[0].timeout_ms = 61_000;
  assert.equal(errorOf(() => childEnvelopeDigestV1(tampered)).code, 'envelope_shape_mismatch');
  const retimedManifest = defaultManifest();
  retimedManifest.assignments[0].acceptance[0].timeout_ms = 610_000;
  const retimed = compileChildEnvelopeV1(retimedManifest, 'backend-writer');
  assert.notEqual(retimed.envelope_text, envelope.envelope_text);
  assert.notEqual(childEnvelopeDigestV1(retimed).digest, descriptor.digest);
  const textOnlyChange = JSON.parse(JSON.stringify(envelope));
  textOnlyChange.envelope_text = `${textOnlyChange.envelope_text}`;
  assert.equal(childEnvelopeDigestV1(textOnlyChange).digest, descriptor.digest);

  assert.equal(errorOf(() => childEnvelopeDigestV1({ ...envelope, schema: 'other.schema' })).code, 'invalid_format');
  assert.equal(errorOf(() => childEnvelopeDigestV1({ ...envelope, version: 2 })).code, 'invalid_format');
  assert.equal(errorOf(() => childEnvelopeDigestV1({ schema: CHILD_ENVELOPE_SCHEMA(), version: 1 })).code, 'invalid_type');
  assert.equal(errorOf(() => childEnvelopeDigestV1({ ...envelope, envelope_byte_length: envelope.envelope_byte_length + 1 })).code, 'invalid_format');
  assert.equal(errorOf(() => childEnvelopeDigestV1({
    ...envelope,
    envelope_text: 'x'.repeat(MAX_ENVELOPE_BYTES + 1),
    envelope_byte_length: MAX_ENVELOPE_BYTES + 1,
  })).code, 'out_of_range');
  function CHILD_ENVELOPE_SCHEMA() {
    return 'codex-co-engineer.child-envelope.v1';
  }
});

test('child envelope digests hash only the validated parse of their envelope text', () => {
  const manifest = defaultManifest();
  const envelope = compileChildEnvelopeV1(manifest, 'backend-writer');
  const descriptor = childEnvelopeDigestV1(envelope);
  const clone = () => JSON.parse(JSON.stringify(envelope));
  const rejectsAs = (name, mutate, code) => {
    const forged = clone();
    mutate(forged);
    const error = errorOf(() => childEnvelopeDigestV1(forged));
    assert.equal(error.code, code, `case "${name}" should fail with ${code}`);
  };

  // Arbitrary text is not an envelope: it must first survive the strict
  // byte-exact ChildEnvelopeV1 parse before any digest exists.
  rejectsAs('arbitrary text instead of an envelope', (forged) => {
    forged.envelope_text = 'arbitrary dispatch instructions\nwith a second line\n';
    forged.envelope_byte_length = Buffer.byteLength(forged.envelope_text);
  }, 'malformed_envelope');
  // Forged identities, framing offsets, nested acceptance data, missing or
  // extra fields: every divergence from the complete parsed canonical shape
  // is rejected instead of hashed.
  rejectsAs('forged assignment_id', (forged) => {
    forged.assignment_id = 'frontend-writer';
  }, 'envelope_shape_mismatch');
  rejectsAs('forged run_id', (forged) => {
    forged.run_id = 'other-run-under-test';
  }, 'envelope_shape_mismatch');
  rejectsAs('forged objective offset', (forged) => {
    forged.framed_blocks.objective.byte_offset += 1;
  }, 'envelope_shape_mismatch');
  rejectsAs('forged prompt length', (forged) => {
    forged.framed_blocks.prompt.byte_length += 2;
  }, 'envelope_shape_mismatch');
  rejectsAs('altered nested acceptance command id', (forged) => {
    forged.acceptance[0].command_id = 'lint-tests';
  }, 'envelope_shape_mismatch');
  rejectsAs('extra nested acceptance parameter', (forged) => {
    forged.acceptance[0].parameters = { injected: 'value' };
  }, 'envelope_shape_mismatch');
  rejectsAs('missing nested execution model', (forged) => {
    delete forged.execution.model;
  }, 'envelope_shape_mismatch');
  rejectsAs('missing envelope_byte_length', (forged) => {
    delete forged.envelope_byte_length;
  }, 'invalid_format');
  rejectsAs('extra top-level key', (forged) => {
    forged.routing_hint = 'cursor-cloud';
  }, 'envelope_shape_mismatch');

  // Valid equivalents keep the exact digest: a fresh strict re-parse of the
  // same text and any key order of the same shape canonicalize identically.
  assert.equal(childEnvelopeDigestV1(parseChildEnvelopeV1(envelope.envelope_text)).digest,
    descriptor.digest);
  assert.equal(childEnvelopeDigestV1(reverseKeyOrder(JSON.parse(JSON.stringify(envelope)))).digest,
    descriptor.digest);
});

test('child envelope digests reject hostile direct-JS envelope shapes fail-closed', () => {
  // The exact-shape contract claims a closed direct-JavaScript surface, so
  // extras that canonical JSON cannot witness (non-enumerable or symbol own
  // keys), accessor properties, and custom prototypes must be rejected as
  // invalid objects instead of being silently ignored by the canonical
  // comparison.
  const manifest = defaultManifest();
  const envelope = compileChildEnvelopeV1(manifest, 'backend-writer');
  const rejectsAs = (name, mutate, code) => {
    const forged = JSON.parse(JSON.stringify(envelope));
    mutate(forged);
    const error = errorOf(() => childEnvelopeDigestV1(forged));
    assert.equal(error.code, code, `case "${name}" should fail with ${code}`);
  };

  rejectsAs('non-enumerable extra top-level key', (forged) => {
    Object.defineProperty(forged, 'routing_hint', { value: 'cursor-cloud', enumerable: false });
  }, 'invalid_object');
  rejectsAs('non-enumerable extra execution key', (forged) => {
    Object.defineProperty(forged.execution, 'fallback_provider', { value: 'grok', enumerable: false });
  }, 'invalid_object');
  rejectsAs('non-enumerable framed offset shadow', (forged) => {
    Object.defineProperty(forged.framed_blocks.prompt, 'true_offset', { value: 0, enumerable: false });
  }, 'invalid_object');
  rejectsAs('symbol-keyed extra top-level key', (forged) => {
    forged[Symbol('hidden_route')] = 'cursor-cloud';
  }, 'invalid_object');
  rejectsAs('symbol-keyed nested acceptance key', (forged) => {
    forged.acceptance[0][Symbol('extra')] = true;
  }, 'invalid_object');
  rejectsAs('enumerable accessor masquerading as assignment_id', (forged) => {
    Object.defineProperty(forged, 'assignment_id',
      { get: () => envelope.assignment_id, enumerable: true });
  }, 'invalid_object');
  rejectsAs('non-enumerable accessor inside framed blocks', (forged) => {
    Object.defineProperty(forged.framed_blocks.objective, 'lazy_length', { get: () => 1, enumerable: false });
  }, 'invalid_object');
  rejectsAs('custom prototype on the structured envelope', (forged) => {
    Object.setPrototypeOf(forged.execution, { fallback: 'grok' });
  }, 'invalid_type');

  for (const key of ['schema', 'version', 'envelope_text', 'envelope_byte_length']) {
    const forged = JSON.parse(JSON.stringify(envelope));
    let reads = 0;
    Object.defineProperty(forged, key, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('must not execute');
      },
    });
    assert.equal(errorOf(() => childEnvelopeDigestV1(forged)).code, 'invalid_object');
    assert.equal(reads, 0, `${key} getter must not execute before descriptor validation`);
  }

  // A hidden routing value in the bytes can never be laundered through a
  // clean-looking structured form: the digest parses envelope_text strictly,
  // so the profile-plus-model state fails with its dedicated semantic code
  // before any shape comparison happens.
  const profileEnvelope = compileChildEnvelopeV1(defaultManifest(), 'frontend-writer');
  const laundered = JSON.parse(JSON.stringify(profileEnvelope));
  laundered.envelope_text = profileEnvelope.envelope_text.replace(
    'execution.model: -', 'execution.model: stealth/ox-alpha');
  // Keep the declared byte length consistent so the digest reaches its
  // strict-parse gate instead of failing early on framing bookkeeping.
  laundered.envelope_byte_length = Buffer.byteLength(laundered.envelope_text, 'utf8');
  assert.equal(errorOf(() => childEnvelopeDigestV1(laundered)).code, 'discarded_model_with_profile');
});

test('digest verification is constant-time and fails closed', () => {
  const manifest = defaultManifest();
  const { digest } = runManifestDigestV1(manifest);
  assert.equal(verifyRunManifestDigestV1(manifest, digest), true);
  assert.equal(verifyRunManifestDigestV1(manifest, digest.toUpperCase()), false);
  assert.equal(verifyRunManifestDigestV1(manifest, digest.slice(1)), false);
  assert.equal(verifyRunManifestDigestV1(manifest, 'z'.repeat(DIGEST_HEX_LENGTH)), false);
  assert.equal(verifyRunManifestDigestV1(manifest, undefined), false);
  assert.equal(verifyRunManifestDigestV1(buildManifest(defaultManifest().assignments, { objective: 'Changed.' }), digest), false);
});

test('describeRunIdentityV1 returns one bounded, order-stable identity record', () => {
  const manifest = defaultManifest();
  const identity = describeRunIdentityV1(manifest);
  assert.equal(identity.run_id, manifest.run_id);
  assert.equal(identity.assignment_count, 2);
  assert.deepEqual(identity.repository, { path: manifest.repository.path, base_sha: BASE_SHA });
  assert.deepEqual(identity.manifest_digest, runManifestDigestV1(manifest));
  assert.deepEqual(identity.assignment_prompt_digests.map((entry) => entry.assignment_id),
    manifest.assignments.map((assignment) => assignment.assignment_id));
  for (const [index, assignment] of manifest.assignments.entries()) {
    assert.equal(identity.assignment_prompt_digests[index].digest,
      assignmentPromptDigestV1(manifest, assignment.assignment_id).digest);
  }
  assert.throws(() => { identity.run_id = 'mutated'; }, TypeError);
  assert.throws(() => { identity.assignment_prompt_digests.pop(); }, TypeError);
});
