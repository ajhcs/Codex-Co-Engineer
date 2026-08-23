import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAIM_ALLOWED_KEYS,
  CLAIM_KINDS,
  CLAIM_REQUIRED_KEYS,
  EVIDENCE_BUNDLE_SCHEMA_ID,
  EVIDENCE_BUNDLE_VERSION,
  FACT_ALLOWED_KEYS,
  FACT_KINDS,
  FACT_REQUIRED_KEYS,
  canonicalProviderClaimJsonV1,
  canonicalVerifiedFactJsonV1,
  parseProviderClaimV1,
  parseVerifiedFactV1,
} from '../mcp/v3/evidence-bundle.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  MODEL,
  countingProxy,
  payloadDigest,
  trapTotal,
  validClaim,
  validFact,
  validGitIdentityFact,
  validModelClaim,
} from './fixtures/r1-evidence-fixtures.mjs';

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

test('schema identity is additive v1 and does not claim a 4.0.0 major', () => {
  assert.equal(EVIDENCE_BUNDLE_SCHEMA_ID, 'codex-co-engineer.evidence-bundle.v1');
  assert.equal(EVIDENCE_BUNDLE_VERSION, 1);
  assert.equal(EVIDENCE_BUNDLE_SCHEMA_ID.includes('4.0.0'), false);
});

test('a valid provider claim parses into a frozen detached snapshot', () => {
  const input = validClaim();
  const snapshot = parseProviderClaimV1(input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.payload), true);
  assert.equal(Object.isFrozen(snapshot.artifact_digests), true);
  assert.equal(snapshot.claim_kind, 'tests_passed');
  assert.equal(snapshot.status, 'asserted');
  assert.equal(snapshot.payload.result, 'pass');
  assert.equal(snapshot.payload_digest, payloadDigest(snapshot.payload));
  input.payload = { result: 'fail' };
  input.subject = 'other';
  assert.equal(snapshot.payload.result, 'pass');
  assert.equal(snapshot.subject, 'unit-tests');
  assert.throws(() => { 'use strict'; snapshot.status = 'unsupported'; }, TypeError);
});

test('a valid verified fact carries authority, method, input, output, exit, timing, truncation, and digest', () => {
  const snapshot = parseVerifiedFactV1(validFact());
  assert.equal(snapshot.authority, 'platform_acceptance_runner');
  assert.equal(snapshot.method, 'approved_command_execution');
  assert.match(snapshot.input_digest, /^[0-9a-f]{64}$/u);
  assert.match(snapshot.output_digest, /^[0-9a-f]{64}$/u);
  assert.equal(snapshot.exit_code, 0);
  assert.equal(snapshot.duration_ms, 1200);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.payload_digest, payloadDigest(snapshot.payload));
  assert.equal(snapshot.status, 'verified');
});

test('claims and facts remain distinct closed key worlds', () => {
  for (const key of ['authority', 'method', 'input_digest', 'truncated', 'fact_kind']) {
    assert.equal(CLAIM_ALLOWED_KEYS.includes(key), false, key);
  }
  for (const key of ['claim_kind']) {
    assert.equal(FACT_ALLOWED_KEYS.includes(key), false, key);
  }
  assert.equal(
    errorOf(() => parseProviderClaimV1(validClaim({ authority: 'platform_git' })), 'claim.authority').code,
    'unknown_key',
  );
  assert.equal(
    errorOf(() => parseVerifiedFactV1(validFact({ claim_kind: 'tests_passed' })), 'fact.claim_kind').code,
    'unknown_key',
  );
  assert.equal(FACT_KINDS.includes('provider_report'), false);
  assert.equal(CLAIM_KINDS.includes('acceptance_results'), false);
});

test('canonical claim and fact bytes are independent of object key order', () => {
  const claim = validClaim();
  const reordered = {};
  for (const key of Object.keys(claim).reverse()) reordered[key] = claim[key];
  assert.equal(canonicalProviderClaimJsonV1(claim), canonicalProviderClaimJsonV1(reordered));

  const fact = validFact();
  const factReordered = {};
  for (const key of Object.keys(fact).reverse()) factReordered[key] = fact[key];
  assert.equal(canonicalVerifiedFactJsonV1(fact), canonicalVerifiedFactJsonV1(factReordered));
});

test('supplied payload digests must match the canonical payload and never trust-upgrade', () => {
  const claim = validClaim();
  const digest = payloadDigest(claim.payload);
  assert.doesNotThrow(() => parseProviderClaimV1({ ...claim, payload_digest: digest }));
  assert.equal(
    errorOf(() => parseProviderClaimV1({ ...claim, payload_digest: 'ab'.repeat(32) })).code,
    'payload_digest_mismatch',
  );
  const parsed = parseProviderClaimV1(claim);
  const mutated = JSON.parse(canonicalProviderClaimJsonV1(claim));
  mutated.payload.result = 'fail';
  mutated.payload_digest = parsed.payload_digest;
  assert.equal(errorOf(() => parseProviderClaimV1(mutated)).code, 'payload_digest_mismatch');
});

test('every claim and fact kind in the closed vocabularies parses', () => {
  const claims = [
    validClaim(),
    validModelClaim(),
    validClaim({
      claim_id: 'c-head', claim_kind: 'head_reached', subject: 'head',
      payload: { sha: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0' },
    }),
    validClaim({
      claim_id: 'c-files', claim_kind: 'files_changed', subject: 'diff',
      payload: { path_count: 3 },
    }),
    validClaim({
      claim_id: 'c-cmd', claim_kind: 'command_reported', subject: 'unit-tests',
      payload: { command_id: 'unit-tests', result: 'pass' },
    }),
  ];
  for (const claim of claims) parseProviderClaimV1(claim);
  parseVerifiedFactV1(validFact());
  parseVerifiedFactV1(validGitIdentityFact());
  parseVerifiedFactV1(validFact({
    fact_id: 'f-head', fact_kind: 'head_sha', subject: 'head',
    authority: 'platform_git', method: 'ancestry_check', exit_code: null,
    payload: { sha: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0' },
  }));
  parseVerifiedFactV1(validFact({
    fact_id: 'f-diff', fact_kind: 'git_diff', subject: 'diff',
    authority: 'platform_git', method: 'scope_match', exit_code: null,
    payload: { path_count: 3, path_set_digest: '66'.repeat(32) },
  }));
  parseVerifiedFactV1(validFact({
    fact_id: 'f-model', fact_kind: 'model_attested', subject: 'model',
    authority: 'independent_provider_query', method: 'independent_model_query',
    exit_code: null, payload: { model: MODEL },
  }));
  parseVerifiedFactV1(validFact({
    fact_id: 'f-art', fact_kind: 'artifact_integrity', subject: 'artifact',
    authority: 'platform_ref_audit', method: 'artifact_digest_compare',
    payload: { artifact_sha256: '22'.repeat(32), result: 'match' },
  }));
});

test('unknown kinds, statuses, authorities, and pairings fail closed', () => {
  assert.equal(
    errorOf(() => parseProviderClaimV1(validClaim({ claim_kind: 'git_diff' }))).code,
    'unknown_claim_kind',
  );
  assert.equal(
    errorOf(() => parseVerifiedFactV1(validFact({ fact_kind: 'provider_report' }))).code,
    'unknown_fact_kind',
  );
  assert.equal(
    errorOf(() => parseVerifiedFactV1(validFact({
      fact_kind: 'model_attested',
      authority: 'platform_acceptance_runner',
      method: 'approved_command_execution',
      payload: { model: MODEL },
    }))).code,
    'unsupported_pairing',
  );
  assert.equal(
    errorOf(() => parseVerifiedFactV1(validFact({ truncated: true, status: 'verified' }))).code,
    'truncated_required_fact',
  );
});

test('identity grammars reuse accepted P02 run and assignment ids', () => {
  assert.equal(
    errorOf(() => parseProviderClaimV1(validClaim({ run_id: 'Run-Evidence' })), 'claim.run_id').code,
    'invalid_format',
  );
  assert.equal(
    errorOf(() => parseVerifiedFactV1(validFact({ assignment_id: 'Lane-Alpha' })), 'fact.assignment_id').code,
    'invalid_format',
  );
});

test('required keys, forbidden classes, and non-finite numbers fail closed', () => {
  for (const key of CLAIM_REQUIRED_KEYS) {
    const partial = validClaim();
    delete partial[key];
    assert.equal(errorOf(() => parseProviderClaimV1(partial), `claim.${key}`).code, 'missing_key');
  }
  for (const key of FACT_REQUIRED_KEYS) {
    const partial = validFact();
    delete partial[key];
    assert.equal(errorOf(() => parseVerifiedFactV1(partial), `fact.${key}`).code, 'missing_key');
  }
  assert.equal(errorOf(() => parseProviderClaimV1(validClaim({ secret: 'x' }))).code, 'credential_content_denied');
  assert.equal(errorOf(() => parseVerifiedFactV1(validFact({ argv: ['npm', 'test'] }))).code, 'executable_content_denied');
  assert.equal(errorOf(() => parseVerifiedFactV1(validFact({ duration_ms: Number.NaN }))).code, 'invalid_json_value');
  assert.equal(errorOf(() => parseVerifiedFactV1(validFact({ duration_ms: Infinity }))).code, 'invalid_json_value');
  assert.equal(errorOf(() => parseProviderClaimV1(validClaim({ sequence: 1.5 }))).code, 'invalid_type');
});

test('live proxies and accessors are denied without invoking traps or getters', () => {
  const { proxy, counts } = countingProxy(validClaim());
  assert.equal(errorOf(() => parseProviderClaimV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  let reads = 0;
  const getterClaim = validClaim();
  Object.defineProperty(getterClaim, 'subject', {
    enumerable: true,
    get() {
      reads += 1;
      return 'unit-tests';
    },
  });
  assert.equal(errorOf(() => parseProviderClaimV1(getterClaim)).code, 'accessor_property_denied');
  assert.equal(reads, 0);
});
