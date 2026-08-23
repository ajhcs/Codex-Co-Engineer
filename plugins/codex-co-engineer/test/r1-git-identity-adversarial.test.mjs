import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import {
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
} from '../mcp/v3/evidence-bundle.mjs';
import {
  parseGitIdentityRequestV1,
  verifyGitIdentityV1,
} from '../mcp/v3/git-identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  countingProxy,
  createDetachedHeadRepo,
  createGraftsRepo,
  createNonCommitHeadRepo,
  createReplaceRefRepo,
  createRewrittenHistoryRepo,
  createStaleBaseRepo,
  createSymbolicRefDriftRepo,
  createUnbornRepo,
  createUnreachableHeadRepo,
  createWrongMergeBaseRepo,
  trapTotal,
  validRequest,
} from './fixtures/r1-git-identity-fixtures.mjs';

function errorOf(action, expectedPath) {
  return Promise.resolve()
    .then(() => action())
    .then(
      () => assert.fail('expected a typed RunContractV1Error'),
      (error) => {
        assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
        if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
        return error;
      },
    );
}

function discrepancyIds(result) {
  return result.discrepancies.map((entry) => entry.discrepancy_id);
}

test('live proxies are denied with zero traps on the request surface', async () => {
  const { proxy, counts } = countingProxy(validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  }));
  assert.equal((await errorOf(() => parseGitIdentityRequestV1(proxy))).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);
  assert.equal((await errorOf(() => verifyGitIdentityV1(proxy))).code, 'proxy_denied');
});

test('revoked proxies fail closed before Array.isArray or Reflect can throw', async () => {
  const { proxy, revoke } = Proxy.revocable(validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  }), {
    get() { throw new Error('revoked get'); },
    ownKeys() { throw new Error('revoked ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('revoked descriptor'); },
  });
  revoke();
  assert.equal(utilTypes.isProxy(proxy), true);
  const error = await errorOf(() => parseGitIdentityRequestV1(proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);
});

test('accessor properties are rejected and their getters never run', async () => {
  let reads = 0;
  const input = validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  });
  Object.defineProperty(input, 'expected_base_ref', {
    enumerable: true,
    get() {
      reads += 1;
      return 'refs/heads/main';
    },
  });
  const error = await errorOf(() => parseGitIdentityRequestV1(input));
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(reads, 0);
});

test('detached, unborn, non-commit, and symbolic-ref drift fail closed', async (t) => {
  const detached = await createDetachedHeadRepo();
  t.after(() => detached.cleanup());
  assert.equal((await errorOf(() => verifyGitIdentityV1(validRequest({
    path: detached.path, base_sha: detached.baseSha, head_sha: detached.headSha,
  })))).code, 'detached_ref_denied');

  const unborn = await createUnbornRepo();
  t.after(() => unborn.cleanup());
  assert.equal((await errorOf(() => verifyGitIdentityV1(validRequest({
    path: unborn.path, base_sha: unborn.baseSha, head_sha: unborn.headSha,
  })))).code, 'unborn_ref_denied');

  const treeHead = await createNonCommitHeadRepo();
  t.after(() => treeHead.cleanup());
  assert.equal((await errorOf(() => verifyGitIdentityV1(validRequest({
    path: treeHead.path, base_sha: treeHead.baseSha, head_sha: treeHead.extra.treeSha,
  })))).code, 'non_commit_object');

  const drift = await createSymbolicRefDriftRepo();
  t.after(() => drift.cleanup());
  assert.equal((await errorOf(() => verifyGitIdentityV1(validRequest({
    path: drift.path,
    base_sha: drift.baseSha,
    head_sha: drift.headSha,
    expected_base_ref: 'refs/heads/alias',
  })))).code, 'symbolic_ref_drift');
});

test('replace refs and grafts fail closed as poisoned observations', async (t) => {
  const replaced = await createReplaceRefRepo();
  t.after(() => replaced.cleanup());
  assert.equal((await errorOf(() => verifyGitIdentityV1(validRequest({
    path: replaced.path, base_sha: replaced.baseSha, head_sha: replaced.headSha,
  })))).code, 'replace_refs_denied');

  const grafted = await createGraftsRepo();
  t.after(() => grafted.cleanup());
  assert.equal((await errorOf(() => verifyGitIdentityV1(validRequest({
    path: grafted.path, base_sha: grafted.baseSha, head_sha: grafted.headSha,
  })))).code, 'grafts_denied');
});

test('stale base history is parent-failing and records an integrity discrepancy', async (t) => {
  const repo = await createStaleBaseRepo();
  t.after(() => repo.cleanup());
  const result = await verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(discrepancyIds(result).includes('stale-base'), true);
  assert.equal(result.observation.base_sha, repo.extra.currentBaseSha);
  assert.notEqual(result.observation.base_sha, repo.baseSha);
  assert.equal(result.facts[0].status, 'failed');
  assert.equal(result.facts[0].payload.base_sha, repo.baseSha);
  parseVerifiedFactV1(result.facts[0]);
  parseEvidenceDiscrepancyV1(result.discrepancies[0]);
});

test('rewritten history is parent-failing and does not verify ancestry', async (t) => {
  const repo = await createRewrittenHistoryRepo();
  t.after(() => repo.cleanup());
  const result = await verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  }));
  assert.equal(result.status, 'failed');
  const ids = discrepancyIds(result);
  assert.equal(ids.includes('rewritten-history'), true);
  assert.equal(result.observation.ancestor, false);
  assert.equal(result.facts[0].status, 'failed');
  parseVerifiedFactV1(result.facts[0]);
  parseVerifiedFactV1(result.facts[1]);
});

test('unreachable heads and wrong merge bases fail closed with P13 discrepancies', async (t) => {
  const unreachable = await createUnreachableHeadRepo();
  t.after(() => unreachable.cleanup());
  const unreachableResult = await verifyGitIdentityV1(validRequest({
    path: unreachable.path, base_sha: unreachable.baseSha, head_sha: unreachable.headSha,
  }));
  assert.equal(unreachableResult.status, 'failed');
  assert.equal(discrepancyIds(unreachableResult).includes('unreachable-head'), true);
  assert.equal(unreachableResult.observation.ancestor, false);

  const diverged = await createWrongMergeBaseRepo();
  t.after(() => diverged.cleanup());
  const divergedResult = await verifyGitIdentityV1(validRequest({
    path: diverged.path, base_sha: diverged.baseSha, head_sha: diverged.headSha,
  }));
  assert.equal(divergedResult.status, 'failed');
  const ids = discrepancyIds(divergedResult);
  assert.equal(ids.includes('wrong-merge-base'), true);
  assert.equal(ids.includes('unreachable-head'), true);
  assert.notEqual(divergedResult.observation.merge_base_sha, diverged.baseSha);
  parseEvidenceDiscrepancyV1(divergedResult.discrepancies[0]);
});
