// Runtime tests for the P02R1 diagnostic-partial authorization field
// (`return_contract.allow_diagnostic_partial_candidate`): the sole optional
// return-contract key, an exact primitive boolean whose absence or false
// keeps complete-only behavior and whose true only PERMITS a later P35A
// diagnostic `incomplete_candidate`. The submitted frozen form is preserved,
// so an explicit false stays an own key with its own raw RunManifestV1
// digest, while the flag stays resolution-inert: it never reaches assignment
// prompts, ChildEnvelopeV1 bytes, or child-envelope digests.

import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  RETURN_CONTRACT_ALLOWED_KEYS,
  RETURN_CONTRACT_REQUIRED_KEYS,
  DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY,
} from '../mcp/v3/run-manifest.mjs';
import { parseRunManifestV1 } from '../mcp/v3/run-policy.mjs';
import {
  assignmentPromptDigestV1,
  canonicalJsonStringify,
  childEnvelopeDigestV1,
  runManifestDigestV1,
  verifyRunManifestDigestV1,
} from '../mcp/v3/identity.mjs';
import { compileChildEnvelopesV1 } from '../mcp/v3/prompt-compiler.mjs';

const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const POLICY = Object.freeze({
  max_concurrency: 2,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});

function writer(id, scopes) {
  return {
    assignment_id: id,
    role: 'implement',
    access: 'writer',
    prompt: `Implement lane ${id}.`,
    execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
    write_scope: scopes,
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
  };
}

// Builds the same valid run three ways: the flag truly absent (ABSENT), an
// explicit false, or an explicit true.
const ABSENT = Symbol('absent');
function run(flag) {
  const returnContract = { mode: 'verified_decision', include_artifact_refs: true };
  if (flag !== ABSENT) returnContract[DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY] = flag;
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'diagnostic-partial-run',
    repository: { path: '/repos/demo', base_sha: BASE_SHA },
    objective: 'One explicit authorization stays inert downstream.',
    assignments: [writer('lane-0', ['src/zero/**']), writer('lane-1', ['src/one/**'])],
    policy: { ...POLICY },
    return_contract: returnContract,
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

test('the diagnostic authorization is the sole optional return-contract key', () => {
  assert.deepEqual([...RETURN_CONTRACT_REQUIRED_KEYS], ['mode', 'include_artifact_refs']);
  assert.equal(RETURN_CONTRACT_ALLOWED_KEYS.length, 3);
  for (const variant of [undefined, ABSENT]) {
    validateOrDigest(variant);
  }
  function validateOrDigest(variant) {
    parseRunManifestV1(run(variant === undefined ? ABSENT : variant));
  }
});

test('absent, explicit false, and explicit true all validate; presence is preserved verbatim', () => {
  const absent = run(ABSENT);
  const falseForm = run(false);
  const trueForm = run(true);

  const absentSnapshot = parseRunManifestV1(absent);
  const falseSnapshot = parseRunManifestV1(falseForm);
  const trueSnapshot = parseRunManifestV1(trueForm);

  assert.equal(Object.hasOwn(absentSnapshot.return_contract,
    DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY), false);
  // The submitted frozen form is never normalized away: explicit false stays
  // a present own enumerable data property with exactly the value false.
  for (const [snapshot, value] of [[falseSnapshot, false], [trueSnapshot, true]]) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot.return_contract,
      DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY);
    assert.ok(descriptor, 'expected the flag to remain present');
    assert.equal(descriptor.value, value);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.writable, false);
    assert.equal(typeof descriptor.get, 'undefined');
  }
});

test('only an exact primitive boolean is accepted; nothing is coerced', () => {
  const hostile = [
    ['string true', 'true'], ['string false', 'false'], ['number one', 1],
    ['number zero', 0], ['null', null], ['own undefined', undefined],
    ['empty object', {}], ['array', [true]],
  ];
  for (const [name, value] of hostile) {
    const error = errorOf(() => parseRunManifestV1(
      run(value),
    ));
    assert.equal(error.code, 'invalid_type', name);
    assert.equal(error.path, `return_contract.${DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY}`, name);
    assert.match(error.message, /exact boolean/u, name);
  }
});

test('aliases and duplicates under other vocabularies stay unknown keys', () => {
  const aliased = run(true);
  aliased.return_contract.allow_diagnostic_partial = true;
  const aliases = errorOf(() => parseRunManifestV1(aliased));
  assert.equal(aliases.code, 'unknown_key');
  assert.equal(aliases.path, 'return_contract.allow_diagnostic_partial');

  const policyDuplicate = run(true);
  policyDuplicate.policy[DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY] = true;
  const policyError = errorOf(() => parseRunManifestV1(policyDuplicate));
  assert.equal(policyError.code, 'unknown_key');
  assert.equal(policyError.path, `policy.${DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY}`);

  const assignmentDuplicate = run(true);
  assignmentDuplicate.assignments[0][DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY] = true;
  const assignmentError = errorOf(() => parseRunManifestV1(assignmentDuplicate));
  assert.equal(assignmentError.code, 'unknown_key');
  assert.equal(assignmentError.path, `assignments[0].${DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY}`);
});

test('explicit false has a distinct raw RunManifest digest from absence; true differs again', () => {
  const absent = run(ABSENT);
  const falseForm = run(false);
  const trueForm = run(true);

  const absentDescriptor = runManifestDigestV1(absent);
  const falseDescriptor = runManifestDigestV1(falseForm);
  const trueDescriptor = runManifestDigestV1(trueForm);

  assert.notEqual(absentDescriptor.digest, falseDescriptor.digest);
  assert.notEqual(falseDescriptor.digest, trueDescriptor.digest);
  assert.notEqual(absentDescriptor.digest, trueDescriptor.digest);

  // Canonical bytes witness exactly the submitted shape.
  assert.equal(canonicalJsonStringify(parseRunManifestV1(absent)).includes(
    `"${DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY}"`), false);
  assert.ok(canonicalJsonStringify(parseRunManifestV1(falseForm))
    .includes(`"${DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY}":false`));
  assert.ok(canonicalJsonStringify(parseRunManifestV1(trueForm))
    .includes(`"${DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY}":true`));

  assert.equal(verifyRunManifestDigestV1(falseForm, absentDescriptor.digest), false);
  assert.equal(verifyRunManifestDigestV1(absent, falseDescriptor.digest), false);
});

test('the flag is resolution-inert: envelopes and child digests ignore it completely', () => {
  const variants = [
    run(ABSENT),
    run(false),
    run(true),
  ];
  
  const compiled = variants.map((manifest) => compileChildEnvelopesV1(manifest));
  const baselineTexts = compiled[0].map((envelope) => envelope.envelope_text);
  for (let v = 1; v < variants.length; v += 1) {
    for (let i = 0; i < compiled[v].length; i += 1) {
      assert.equal(compiled[v][i].envelope_text, baselineTexts[i]);
      assert.deepEqual(childEnvelopeDigestV1(compiled[v][i]),
        childEnvelopeDigestV1(compiled[0][i]));
    }
    assert.deepEqual(assignmentPromptDigestV1(variants[v], 'lane-0'),
      assignmentPromptDigestV1(variants[0], 'lane-0'));
  }

  // No rendered byte carries the flag, an alias, or any authorization trace.
  const haystack = baselineTexts.join('\n');
  for (const needle of ['allow_diagnostic_partial_candidate',
    'diagnostic_partial_candidate', 'return_contract']) {
    assert.equal(haystack.includes(needle), false, `envelope leaked "${needle}"`);
  }
});

test('hostile direct-JavaScript surfaces on the new field fail closed without executing traps', () => {
  let getterCalls = 0;
  const accessor = run(true);
  Object.defineProperty(accessor.return_contract, DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY, {
    enumerable: true,
    get() { getterCalls += 1; return false; },
  });
  assert.equal(errorOf(() => parseRunManifestV1(accessor)).code, 'invalid_object');
  assert.equal(getterCalls, 0);

  const hidden = run(true);
  delete hidden.return_contract[DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY];
  Object.defineProperty(hidden.return_contract, DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY, {
    value: true, enumerable: false, writable: false, configurable: false,
  });
  assert.equal(errorOf(() => parseRunManifestV1(hidden)).code, 'invalid_object');

  const symbolKeyed = run(true);
  symbolKeyed.return_contract[Symbol(DIAGNOSTIC_PARTIAL_AUTHORIZATION_KEY)] = true;
  assert.equal(errorOf(() => parseRunManifestV1(symbolKeyed)).code, 'invalid_object');

  const proxied = run(true);
  proxied.return_contract = new Proxy(proxied.return_contract, {});
  let trapCalls = 0;
  const watched = new Proxy(proxied.return_contract, {
    get() { trapCalls += 1; return true; },
  });
  assert.ok(utilTypes.isProxy(watched));
  assert.equal(errorOf(() => parseRunManifestV1(proxied)).code, 'invalid_type');
  assert.equal(trapCalls, 0);
});

test('first-error ordering inside return_contract is fixed and deterministic', () => {
  // Unknown sibling keys are rejected before the optional flag is inspected...
  const unknownFirst = run('yes');
  unknownFirst.return_contract.mode_note = 'extra';
  assert.equal(errorOf(() => parseRunManifestV1(unknownFirst)).path, 'return_contract.mode_note');

  // ...required-key presence precedes the flag type...
  const missingArtifactRefs = run('yes');
  delete missingArtifactRefs.return_contract.include_artifact_refs;
  assert.equal(errorOf(() => parseRunManifestV1(missingArtifactRefs)).code, 'missing_key');

  // ...and the exact literals are enforced before the optional flag type.
  const badMode = run('yes');
  badMode.return_contract.mode = 'best_effort';
  assert.equal(errorOf(() => parseRunManifestV1(badMode)).path, 'return_contract.mode');
});
