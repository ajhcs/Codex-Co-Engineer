import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  MAX_HISTORY_COMMITS,
  MAX_REF_BYTES,
  bindAuthorityIdentityV1,
  classifyGitOperationV1,
  classifyLaneHistoryV1,
  classifyRefV1,
  expectedLaneRefV1,
  projectAuthorityEvidenceV1,
} from '../mcp/v3/git-authority.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  CONTENT_FREE,
  MANIFEST_DIGEST_HEX,
  RUN_ID,
  operationRequest,
  validIdentity,
} from './fixtures/r1-git-authority-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(utilTypes.isProxy(error), false);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false);
  assert.equal(text.includes('https://'), false);
  for (const extra of extras) assert.equal(text.includes(extra), false, `leaked ${JSON.stringify(extra)}`);
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
}

const laneRef = expectedLaneRefV1({
  run_id: RUN_ID, assignment_id: ASSIGNMENT_ID, manifest_digest_hex: MANIFEST_DIGEST_HEX,
});

test('parent-failing hostile policy probes deny namespace escape without echoing attacker bytes', () => {
  const probes = [
    'refs/heads/codex/run-abababababababab/../main',
    'refs/heads/main.lock',
    'refs/heads/foo@{bar}',
    'refs/heads/codex/run-abababababababab/lane-alpha/',
    'refs/heads/\uFF4D\uFF41\uFF49\uFF4E',
    'refs/heads/\u0430lpha',
    'refs/heads/codex/run-abababababababab/\u200Blane-alpha',
    'refs/heads/codex/run-ABABABABABABABAB/lane-alpha',
    `refs/heads/${'a'.repeat(MAX_REF_BYTES)}`,
    'refs/heads/codex/run-abababababababab/LANE-ALPHA',
    'heads/main',
    'refs/heads/codex/run-ab/lane-alpha',
  ];
  for (const ref of probes) {
    const classified = classifyRefV1({ ref, identity: validIdentity(), manifest_digest_hex: MANIFEST_DIGEST_HEX });
    assert.equal(classified.protected, true, ref);
    assert.notEqual(classified.code, 'authority_ok', ref);
    assertContentFree(classified, [ref, '/tmp', 'https://']);
    const verdict = classifyGitOperationV1(operationRequest({
      operation: 'create_lane_branch',
      ref,
    }));
    assert.equal(verdict.verdict, 'denied');
    assertContentFree(verdict, [ref]);
    assertContentFree(verdict.message, [ref]);
  }
});

test('proxy accessor symbol and unknown-key inputs fail closed without running caller traps', () => {
  const { proxy, counts } = countingProxy(operationRequest({ ref: laneRef }));
  assert.equal(errorOf(() => classifyGitOperationV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const accessor = operationRequest({ ref: laneRef });
  Object.defineProperty(accessor, 'operation', {
    get() { throw new Error('accessor ran'); }, enumerable: true,
  });
  const accessorError = errorOf(() => classifyGitOperationV1(accessor));
  assert.ok(['accessor_property_denied', 'invalid_type'].includes(accessorError.code), accessorError.code);

  const symbolKeyed = operationRequest({ ref: laneRef });
  symbolKeyed[Symbol('push')] = true;
  assert.equal(errorOf(() => classifyGitOperationV1(symbolKeyed)).code, 'symbol_key_denied');

  const unknown = operationRequest({ ref: laneRef, extra: true });
  assert.equal(errorOf(() => classifyGitOperationV1(unknown)).code, 'unknown_key');
});

test('credential URL and remote-mutation material cannot bind as identity', () => {
  const cases = [
    { token: 'secret-token' },
    { authorization: 'Bearer abc' },
    { credentials: { password: 'x' } },
    { push_url: 'https://example.invalid/repo.git' },
  ];
  for (const extra of cases) {
    const error = errorOf(() => bindAuthorityIdentityV1(validIdentity(extra)));
    assert.ok(
      error.code === 'credential_content_denied' || error.code === 'unknown_key' || error.code === 'merge_authority_denied',
      extra,
    );
    assertContentFree(error.message);
  }
  const urlPath = errorOf(() => bindAuthorityIdentityV1(validIdentity({
    repository_path: 'https://example.invalid/repo.git',
  })));
  assert.equal(urlPath.code, 'authority_identity_invalid');
  assert.equal(urlPath.message.includes('https://'), false);
});

test('unknown operations capability lies and actor mismatches fail closed', () => {
  assert.equal(errorOf(() => classifyGitOperationV1(operationRequest({
    operation: 'squash',
  }))).code, 'unknown_git_operation');

  const posture = errorOf(() => classifyGitOperationV1(operationRequest({
    operation: 'commit_on_lane_branch',
    ref: laneRef,
    capability: {
      merge_authority: 'provider_may_merge',
      create_pr_posture: 'prohibited',
    },
  })));
  assert.equal(posture.code, 'authority_posture_mismatch');

  const cloudLocal = errorOf(() => classifyGitOperationV1(operationRequest({
    operation: 'read_only_inspect',
    capability: {
      merge_authority: 'none_codex_only_integration',
      create_pr_posture: 'non_authoritative_cloud_only',
      provider: 'grok',
    },
  })));
  assert.equal(cloudLocal.code, 'authority_posture_mismatch');

  const platformCommit = classifyGitOperationV1(operationRequest({
    actor: 'platform',
    operation: 'commit_on_lane_branch',
    ref: laneRef,
  }));
  assert.equal(platformCommit.code, 'authority_posture_mismatch');
});

test('bounds abuse of history arrays refs and keys is rejected', () => {
  const hugeHistory = classifyLaneHistoryV1;
  const tooMany = Array.from({ length: MAX_HISTORY_COMMITS + 1 }, () => 1);
  assert.equal(errorOf(() => hugeHistory({ parent_counts: tooMany })).code, 'out_of_range');
  assert.equal(errorOf(() => hugeHistory({ parent_counts: [99] })).code, 'out_of_range');
  assert.equal(errorOf(() => hugeHistory({ parent_counts: [] })).code, 'out_of_range');

  const longRef = `refs/heads/${'a'.repeat(MAX_REF_BYTES)}`;
  const classified = classifyRefV1({ ref: longRef });
  assert.equal(classified.code, 'branch_namespace_violation');
  assertContentFree(classified, [longRef]);

  const bulky = operationRequest({ ref: laneRef });
  for (let i = 0; i < 40; i += 1) bulky[`k${i}`] = i;
  assert.equal(errorOf(() => classifyGitOperationV1(bulky)).code, 'out_of_range');
});

test('policy customization and evidence projection stay closed and content-free', () => {
  const evidence = projectAuthorityEvidenceV1(classifyGitOperationV1(operationRequest({
    operation: 'push',
  })), { fact_id: 'f-push', discrepancy_id: 'd-push', sequence: 3 });
  assert.equal(evidence.facts[0].fact_id, 'f-push');
  assert.equal(evidence.discrepancies[0].code, 'security_boundary');
  assertContentFree(evidence, ['refs/heads', 'https://', 'secret']);
  assert.equal(errorOf(() => projectAuthorityEvidenceV1(classifyGitOperationV1(operationRequest({
    operation: 'push',
  })), { fact_id: 'F-PUSH' })).code, 'invalid_format');
});
