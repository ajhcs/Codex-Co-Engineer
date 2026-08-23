import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_REF_SCHEMA_ID,
  CLAIM_ALLOWED_KEYS,
  CLAIM_KINDS,
  CLAIM_REQUIRED_KEYS,
  DISCREPANCY_KINDS,
  EVIDENCE_BUNDLE_SCHEMA_ID,
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_DIGEST_LABEL,
  FACT_ALLOWED_KEYS,
  FACT_KINDS,
  FACT_REQUIRED_KEYS,
  canonicalEvidenceBundleJsonV1,
  canonicalProviderClaimJsonV1,
  canonicalVerifiedFactJsonV1,
  evidenceBundleDigestV1,
  parseEvidenceBundleV1,
  parseEvidenceDiscrepancyV1,
  parseProviderClaimV1,
  parseVerifiedFactV1,
  verifyEvidenceBundleDigestV1,
} from '../mcp/v3/evidence-bundle.mjs';
import { IDENTITY_DOMAIN, IDENTITY_LABELS } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { parseArtifactRefV1 } from '../mcp/v3/artifact-ref.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  MODEL,
  RUN_ID,
  SHA_ACCEPT,
  SHA_REPORT,
  acceptanceRef,
  countingProxy,
  payloadDigest,
  reportRef,
  trapTotal,
  validArtifactRef,
  validBundle,
  validClaim,
  validDiscrepancy,
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

test('a valid bundle freezes exact P07 artifact snapshots and detaches from the caller', () => {
  const input = validBundle();
  const snapshot = parseEvidenceBundleV1(input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.claims), true);
  assert.equal(Object.isFrozen(snapshot.facts), true);
  assert.equal(Object.isFrozen(snapshot.artifacts), true);
  assert.equal(snapshot.artifacts.length, 3);
  assert.equal(snapshot.artifacts[0].schema, ARTIFACT_REF_SCHEMA_ID);
  for (const ref of snapshot.artifacts) {
    assert.deepEqual(Object.keys(ref), Object.keys(parseArtifactRefV1(validArtifactRef())));
    assert.equal(ref.run_id, RUN_ID);
    assert.equal(ref.assignment_id, ASSIGNMENT_ID);
  }
  input.final_state = 'failed';
  input.artifacts.push(validArtifactRef({ relative_path: 'runs/run-evidence-01/lane-alpha/other.patch' }));
  assert.equal(snapshot.final_state, 'pass');
  assert.equal(snapshot.artifacts.length, 3);
  assert.throws(() => { 'use strict'; snapshot.final_state = 'failed'; }, TypeError);
});

test('discrepancies link claim and fact identities without erasing either source', () => {
  const claim = validClaim({ payload: { result: 'pass' } });
  const fact = validFact({ payload: { command_id: 'unit-tests', result: 'fail' }, status: 'failed' });
  const discrepancy = validDiscrepancy();
  parseEvidenceDiscrepancyV1(discrepancy);
  const snapshot = parseEvidenceBundleV1(validBundle({
    final_state: 'failed',
    claims: [claim],
    facts: [fact, validGitIdentityFact()],
    discrepancies: [discrepancy],
  }));
  assert.equal(snapshot.claims[0].payload.result, 'pass');
  assert.equal(snapshot.facts.find((entry) => entry.fact_id === 'f-accept').payload.result, 'fail');
  assert.equal(snapshot.discrepancies[0].discrepancy_kind, 'mismatch');
  assert.deepEqual([...snapshot.discrepancies[0].claim_ids], ['c-tests']);
  assert.deepEqual([...snapshot.discrepancies[0].fact_ids], ['f-accept']);
  assert.equal(DISCREPANCY_KINDS.includes('mismatch'), true);
});

test('raw paths, URLs, and inline blobs are never accepted as artifact links', () => {
  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      artifacts: ['runs/run-evidence-01/lane-alpha/diff.patch'],
    }))).code,
    'invalid_type',
  );
  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      artifacts: ['https://example.invalid/report'],
    }))).code,
    'invalid_type',
  );
  const blob = validArtifactRef({ body: 'inline' });
  assert.equal(errorOf(() => parseEvidenceBundleV1(validBundle({ artifacts: [blob] }))).code, 'unknown_key');
  const extraPath = validArtifactRef({ url: '/tmp/secret' });
  assert.equal(errorOf(() => parseEvidenceBundleV1(validBundle({ artifacts: [extraPath] }))).code, 'unknown_key');
});

test('artifact identity drift and non-P07 snapshots fail closed', () => {
  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      artifacts: [validArtifactRef({ assignment_id: 'lane-beta' })],
    }))).code,
    'identity_mismatch',
  );
  const incomplete = validArtifactRef();
  delete incomplete.sha256;
  assert.equal(errorOf(() => parseEvidenceBundleV1(validBundle({ artifacts: [incomplete] }))).code, 'missing_key');
});

test('canonical bundle bytes and digests are stable under key permutation and use the reserved identity label', () => {
  const straight = validBundle();
  const reordered = {};
  for (const key of Object.keys(straight).reverse()) reordered[key] = straight[key];
  reordered.claims = [{ ...straight.claims[0] }];
  const reversedClaim = {};
  for (const key of Object.keys(straight.claims[0]).reverse()) {
    reversedClaim[key] = straight.claims[0][key];
  }
  reordered.claims = [reversedClaim];
  reordered.facts = [...straight.facts].reverse();
  reordered.artifacts = [...straight.artifacts].reverse();
  assert.equal(canonicalEvidenceBundleJsonV1(straight), canonicalEvidenceBundleJsonV1(reordered));
  const descriptor = evidenceBundleDigestV1(straight);
  assert.equal(descriptor.domain, IDENTITY_DOMAIN);
  assert.equal(descriptor.label, IDENTITY_LABELS.EVIDENCE_BUNDLE);
  assert.equal(descriptor.label, EVIDENCE_DIGEST_LABEL);
  assert.equal(verifyEvidenceBundleDigestV1(reordered, descriptor.digest), true);
  assert.equal(verifyEvidenceBundleDigestV1(straight, 'zz'.repeat(32)), false);
  assert.equal(verifyEvidenceBundleDigestV1(straight, 1), false);
  const mutated = validBundle({ sequence: 1 });
  assert.notEqual(evidenceBundleDigestV1(mutated).digest, descriptor.digest);
});

test('facts cannot be synthesized from provider-derived artifacts', () => {
  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      facts: [validFact({ artifact_digests: ['11'.repeat(32)] })],
    }))).code,
    'provider_proof_rejected',
  );
});

test('model_attested facts require independent proof, not provider-report reuse', () => {
  const modelFact = (artifactDigests) => validFact({
    fact_id: 'f-model',
    fact_kind: 'model_attested',
    sequence: 2,
    subject: 'model',
    authority: 'independent_provider_query',
    method: 'independent_model_query',
    exit_code: null,
    payload: { model: MODEL },
    artifact_digests: artifactDigests,
  });

  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      facts: [validFact(), validGitIdentityFact(), modelFact([SHA_REPORT])],
    }))).code,
    'provider_proof_rejected',
  );

  assert.doesNotThrow(() => parseEvidenceBundleV1(validBundle({
    facts: [validFact(), validGitIdentityFact(), modelFact([SHA_ACCEPT])],
  })));

  const usageSha = '77'.repeat(32);
  assert.doesNotThrow(() => parseEvidenceBundleV1(validBundle({
    facts: [validFact(), validGitIdentityFact(), modelFact([usageSha])],
    artifacts: [
      reportRef(),
      acceptanceRef(),
      validArtifactRef(),
      validArtifactRef({
        artifact_kind: 'usage_evidence',
        relative_path: `runs/${RUN_ID}/${ASSIGNMENT_ID}/usage.json`,
        sha256: usageSha,
        media_type: 'application/json',
      }),
    ],
  })));
});

test('stale git identity facts fail closed against the bundle base', () => {
  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      facts: [
        validFact(),
        validGitIdentityFact({
          payload: { base_sha: 'c'.repeat(40), head_sha: BASE_SHA },
        }),
      ],
    }))).code,
    'stale_fact',
  );
});

test('duplicate and conflicting identities fail closed', () => {
  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      claims: [validClaim(), validClaim({ sequence: 1 })],
    }))).code,
    'duplicate_id',
  );
  assert.equal(
    errorOf(() => parseEvidenceBundleV1(validBundle({
      facts: [validFact(), validFact({ fact_id: 'f-other', sequence: 0 })],
    }))).code,
    'duplicate_sequence',
  );
});

test('accepted states reject forged PASS, incomplete facts, unsupported claims, and discrepancies', () => {
  for (const finalState of ['pass', 'accepted', 'verified']) {
    assert.doesNotThrow(() => parseEvidenceBundleV1(validBundle({ final_state: finalState })));
  }

  const forgedPass = validBundle({ facts: [validGitIdentityFact()] });
  assert.equal(errorOf(() => parseEvidenceBundleV1(forgedPass)).code, 'unproven_accepted_state');

  const incompleteFact = validBundle({
    facts: [validFact({ status: 'partial' }), validGitIdentityFact()],
  });
  assert.equal(errorOf(() => parseEvidenceBundleV1(incompleteFact)).code, 'unproven_accepted_state');

  const truncatedFact = validBundle({
    facts: [validFact({ status: 'truncated', truncated: true }), validGitIdentityFact()],
  });
  assert.equal(errorOf(() => parseEvidenceBundleV1(truncatedFact)).code, 'truncated_required_fact');

  const unsupportedClaim = validBundle({ claims: [validClaim({ status: 'unsupported' })] });
  assert.equal(errorOf(() => parseEvidenceBundleV1(unsupportedClaim)).code, 'unproven_accepted_state');

  const blockingDiscrepancy = validBundle({
    facts: [
      validFact({ payload: { command_id: 'unit-tests', result: 'fail' }, status: 'failed' }),
      validGitIdentityFact(),
    ],
    discrepancies: [validDiscrepancy()],
  });
  assert.equal(errorOf(() => parseEvidenceBundleV1(blockingDiscrepancy)).code, 'unproven_accepted_state');
});
