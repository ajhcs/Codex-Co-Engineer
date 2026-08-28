import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEvidenceDiscrepancyV1, parseVerifiedFactV1 } from '../mcp/v3/evidence-bundle.mjs';
import {
  GIT_AUTHORITY_POLICY_SCHEMA_ID,
  GIT_AUTHORITY_POLICY_V1,
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  GitAuthorityPolicyV1,
  assertAuthorityPostureV1,
  bindAuthorityIdentityV1,
  classifyGitOperationV1,
  classifyLaneHistoryV1,
  classifyRefV1,
  expectedCandidateRefV1,
  expectedLaneRefV1,
  expectedRunBranchNameV1,
  isProtectedRefV1,
  isRunOwnedCandidateRefV1,
  isValidRunBranchNameV1,
  parseGitAuthorityPolicyV1,
  projectAuthorityEvidenceV1,
} from '../mcp/v3/git-authority.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  CONTENT_FREE,
  MANIFEST_DIGEST_HEX,
  RUN_ID,
  operationRequest,
  parentCounts,
  validIdentity,
  withDisposableRepo,
  writeDefaultBranchTarget,
  writeLinearHistory,
  writeMergeHistory,
  writeOctopusHistory,
} from './fixtures/r1-git-authority-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false, 'must not leak repository paths');
  assert.equal(text.includes('https://'), false, 'must not leak URLs');
  assert.equal(text.includes('git@'), false, 'must not leak hosting URLs');
  for (const extra of extras) {
    assert.equal(text.includes(extra), false, `must not echo ${extra}`);
  }
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
}

const laneName = expectedRunBranchNameV1({
  run_id: RUN_ID, assignment_id: ASSIGNMENT_ID, manifest_digest_hex: MANIFEST_DIGEST_HEX,
});
const laneRef = expectedLaneRefV1({
  run_id: RUN_ID, assignment_id: ASSIGNMENT_ID, manifest_digest_hex: MANIFEST_DIGEST_HEX,
});
const candidateRef = expectedCandidateRefV1({ run_id: RUN_ID });

test('GitAuthorityPolicyV1 is a closed frozen v1 policy and not a 4.0.0 major', () => {
  assert.equal(GIT_AUTHORITY_SCHEMA_ID, 'codex-co-engineer.git-authority.v1');
  assert.equal(GIT_AUTHORITY_POLICY_SCHEMA_ID, 'codex-co-engineer.git-authority-policy.v1');
  assert.equal(GIT_AUTHORITY_VERSION, 1);
  assert.equal(GIT_AUTHORITY_SCHEMA_ID.includes('4.0.0'), false);
  assert.equal(parseGitAuthorityPolicyV1(GIT_AUTHORITY_POLICY_V1), GitAuthorityPolicyV1);
  assert.ok(Object.isFrozen(GIT_AUTHORITY_POLICY_V1));
  assert.ok(Object.isFrozen(GIT_AUTHORITY_POLICY_V1.default_branch_names));
  assert.deepEqual(GIT_AUTHORITY_POLICY_V1.default_branch_names, ['main', 'master']);
  const customized = {
    ...GIT_AUTHORITY_POLICY_V1,
    default_branch_names: ['main'],
    user_protected_ref_prefixes: [...GIT_AUTHORITY_POLICY_V1.user_protected_ref_prefixes],
  };
  assert.equal(errorOf(() => parseGitAuthorityPolicyV1(customized)).code, 'invalid_format');
});

test('credential-free identity binds without echoing the repository path', () => {
  const bound = bindAuthorityIdentityV1(validIdentity({ head_sha: BASE_SHA }));
  assert.equal(bound.repository_bound, true);
  assert.equal(bound.base_sha, BASE_SHA);
  assert.equal(bound.run_id, RUN_ID);
  assert.equal('repository_path' in bound, false);
  assertContentFree(bound);
  const mutated = validIdentity();
  mutated.repository_path = '/tmp/other';
  assert.equal(bound.assignment_id, ASSIGNMENT_ID);
});

test('lane namespace generator and candidate ref stay git-ref-safe', () => {
  assert.equal(laneName, `codex/run-${MANIFEST_DIGEST_HEX.slice(0, 16)}/${ASSIGNMENT_ID}`);
  assert.equal(isValidRunBranchNameV1(laneName), true);
  assert.equal(isValidRunBranchNameV1('codex/run-nothex/lane-alpha'), false);
  assert.equal(isValidRunBranchNameV1('main'), false);
  assert.equal(isRunOwnedCandidateRefV1(candidateRef, RUN_ID), true);
  assert.equal(isRunOwnedCandidateRefV1(candidateRef, 'run-other-99'), false);
  assert.equal(laneRef.startsWith('refs/heads/'), true);
});

test('own lane refs are writable; default and protected refs are not', () => {
  const own = classifyRefV1({
    ref: laneRef, identity: validIdentity(), manifest_digest_hex: MANIFEST_DIGEST_HEX,
  });
  assert.equal(own.ref_class, 'worker_lane');
  assert.equal(own.protected, false);
  assert.equal(own.code, 'authority_ok');
  assert.equal(isProtectedRefV1({
    ref: laneRef, identity: validIdentity(), manifest_digest_hex: MANIFEST_DIGEST_HEX,
  }), false);

  const main = classifyRefV1({ ref: 'refs/heads/main' });
  assert.equal(main.default_branch_target, true);
  assert.equal(main.code, 'default_branch_target_denied');
  assert.equal(isProtectedRefV1({ ref: 'refs/heads/main' }), true);

  const master = classifyRefV1({ ref: 'refs/heads/master' });
  assert.equal(master.code, 'default_branch_target_denied');

  const develop = classifyRefV1({ ref: 'refs/heads/develop', origin_head_branch: 'develop' });
  assert.equal(develop.default_branch_target, true);
  assert.equal(develop.code, 'default_branch_target_denied');

  const tags = classifyRefV1({ ref: 'refs/tags/v1.0.0' });
  assert.equal(tags.ref_class, 'user_protected');
  assert.equal(tags.code, 'protected_ref_write_denied');

  const candidate = classifyRefV1({
    ref: candidateRef, identity: validIdentity(), manifest_digest_hex: MANIFEST_DIGEST_HEX,
  });
  assert.equal(candidate.ref_class, 'platform_run_owned');
  assert.equal(candidate.protected, true);
  assertContentFree(own);
  assertContentFree(main);
});

test('worker commit on the lane is allowed; merge push create-PR rebase and tags are not', () => {
  const commit = classifyGitOperationV1(operationRequest({
    operation: 'commit_on_lane_branch',
    ref: laneRef,
    history: { parent_counts: [0, 1] },
  }));
  assert.equal(commit.verdict, 'allowed');
  assert.equal(commit.ref_class, 'worker_lane');
  assertContentFree(commit);

  const denials = [
    ['merge', 'merge_authority_denied'],
    ['rebase', 'merge_authority_denied'],
    ['create_pr', 'merge_authority_denied'],
    ['merge_pr', 'merge_authority_denied'],
    ['push', 'push_authority_denied'],
    ['force_push', 'push_authority_denied'],
    ['fetch', 'push_authority_denied'],
    ['tag_create', 'protected_ref_write_denied'],
    ['release_create', 'protected_ref_write_denied'],
    ['credential_helper', 'credential_content_denied'],
  ];
  for (const [operation, code] of denials) {
    const verdict = classifyGitOperationV1(operationRequest({ operation }));
    assert.equal(verdict.verdict, 'denied', operation);
    assert.equal(verdict.code, code, operation);
    assertContentFree(verdict);
  }
});

test('Cursor Cloud create-PR posture still cannot create a PR in an R1 run lane', () => {
  assertAuthorityPostureV1({
    merge_authority: 'none_codex_only_integration',
    create_pr_posture: 'non_authoritative_cloud_only',
    provider: 'cursor-cloud',
  });
  const verdict = classifyGitOperationV1(operationRequest({
    operation: 'create_pr',
    capability: {
      merge_authority: 'none_codex_only_integration',
      create_pr_posture: 'non_authoritative_cloud_only',
      provider: 'cursor-cloud',
    },
  }));
  assert.equal(verdict.code, 'merge_authority_denied');
});

test('platform composition of the run-owned candidate is allowed and is not a merge', () => {
  const verdict = classifyGitOperationV1(operationRequest({
    actor: 'platform',
    operation: 'compose_candidate_non_authoritative',
    ref: candidateRef,
    history: { parent_counts: [1] },
  }));
  assert.equal(verdict.verdict, 'allowed');
  assert.equal(verdict.ref_class, 'platform_run_owned');
  const worker = classifyGitOperationV1(operationRequest({
    actor: 'worker',
    operation: 'compose_candidate_non_authoritative',
    ref: candidateRef,
  }));
  assert.equal(worker.code, 'authority_posture_mismatch');
});

test('linear history is allowed and merge histories are denied', () => {
  const linear = classifyLaneHistoryV1({ parent_counts: [0, 1, 1] });
  assert.equal(linear.verdict, 'allowed');
  const merge = classifyLaneHistoryV1({ parent_counts: [0, 1, 2] });
  assert.equal(merge.code, 'merge_history_denied');
  const octopus = classifyLaneHistoryV1({ parent_counts: [3] });
  assert.equal(octopus.code, 'merge_history_denied');
  const rootMerge = classifyLaneHistoryV1({ parent_counts: [2] });
  assert.equal(rootMerge.code, 'merge_history_denied');
  const throughOp = classifyGitOperationV1(operationRequest({
    operation: 'commit_on_lane_branch',
    ref: laneRef,
    history: { parent_counts: [0, 2] },
  }));
  assert.equal(throughOp.code, 'merge_history_denied');
  assertContentFree(merge);
});

test('disposable linear merge and default-target repositories feed the policy', async () => {
  await withDisposableRepo(async (root) => {
    const linear = await writeLinearHistory(root);
    assert.deepEqual(linear, [0, 1]);
    assert.equal(classifyLaneHistoryV1({ parent_counts: linear }).verdict, 'allowed');
  });
  await withDisposableRepo(async (root) => {
    const merge = await writeMergeHistory(root);
    assert.ok(merge.some((count) => count >= 2), `expected a merge parent count, got ${merge}`);
    assert.equal(classifyLaneHistoryV1({ parent_counts: merge }).code, 'merge_history_denied');
  });
  await withDisposableRepo(async (root) => {
    const octopus = await writeOctopusHistory(root);
    assert.ok(octopus.some((count) => count >= 3), `expected octopus, got ${octopus}`);
    assert.equal(classifyLaneHistoryV1({ parent_counts: octopus }).code, 'merge_history_denied');
  });
  await withDisposableRepo(async (root) => {
    const { defaultBranch, counts } = await writeDefaultBranchTarget(root);
    assert.equal(defaultBranch, 'main');
    assert.equal(parentCounts(root).length, counts.length);
    const verdict = classifyGitOperationV1(operationRequest({
      operation: 'create_lane_branch',
      ref: `refs/heads/${defaultBranch}`,
      default_branch: defaultBranch,
    }));
    assert.equal(verdict.code, 'default_branch_target_denied');
    assert.equal(verdict.default_branch_target, true);
    assertContentFree(verdict);
  });
});

test('denied verdicts project content-free P13-compatible facts and discrepancies', () => {
  const verdict = classifyGitOperationV1(operationRequest({
    operation: 'commit_on_lane_branch',
    ref: laneRef,
    history: { parent_counts: [2] },
  }));
  const projection = projectAuthorityEvidenceV1(verdict);
  const fact = parseVerifiedFactV1(projection.facts[0]);
  const discrepancy = parseEvidenceDiscrepancyV1(projection.discrepancies[0]);
  assert.equal(fact.fact_kind, 'git_identity');
  assert.equal(fact.status, 'failed');
  assert.equal(fact.method, 'merge_commit_absence');
  assert.equal(fact.authority, 'platform_git');
  assert.equal(discrepancy.discrepancy_kind, 'security');
  assert.equal(discrepancy.code, 'security_boundary');
  assertContentFree(projection);
  const allowed = projectAuthorityEvidenceV1(classifyGitOperationV1(operationRequest({
    operation: 'commit_on_lane_branch',
    ref: laneRef,
    history: { parent_counts: [1] },
  })));
  parseVerifiedFactV1(allowed.facts[0]);
  assert.equal(allowed.discrepancies.length, 0);
});

function publicationFields(overrides = {}) {
  return {
    user_authorized_publication: true,
    draft: true,
    force: false,
    expected_head: BASE_SHA,
    current_head: BASE_SHA,
    current_tree: BASE_SHA,
    candidate_tree: BASE_SHA,
    ci_green: true,
    ci_current: true,
    failed_check_count: 0,
    hidden_failed_checks: false,
    verifier_accepted: true,
    merge_topology_ok: true,
    ...overrides,
  };
}

test('publisher may non-force push the owned unprotected Codex lane and open a draft PR', () => {
  const push = classifyGitOperationV1(operationRequest({
    actor: 'publisher',
    operation: 'push',
    ref: laneRef,
    publication: publicationFields(),
  }));
  assert.equal(push.verdict, 'allowed');
  assert.equal(push.actor, 'publisher');
  assertContentFree(push);

  const draft = classifyGitOperationV1(operationRequest({
    actor: 'publisher',
    operation: 'create_pr',
    ref: laneRef,
    publication: publicationFields(),
  }));
  assert.equal(draft.verdict, 'allowed');
  assertContentFree(draft);
});

test('Sol may regular-merge after expected-head CAS, current green CI, and verifier receipts', () => {
  const merge = classifyGitOperationV1(operationRequest({
    actor: 'sol',
    operation: 'merge_pr',
    ref: laneRef,
    identity: validIdentity({ head_sha: BASE_SHA }),
    publication: publicationFields(),
  }));
  assert.equal(merge.verdict, 'allowed');
  assert.equal(merge.actor, 'sol');
  assertContentFree(merge);
});

test('Luna remains read-only for Git and cannot merge', () => {
  const inspect = classifyGitOperationV1(operationRequest({
    actor: 'luna',
    operation: 'read_only_inspect',
  }));
  assert.equal(inspect.verdict, 'allowed');
  const merge = classifyGitOperationV1(operationRequest({
    actor: 'luna',
    operation: 'merge_pr',
    ref: laneRef,
  }));
  assert.equal(merge.verdict, 'denied');
  assert.equal(merge.code, 'merge_authority_denied');
});
