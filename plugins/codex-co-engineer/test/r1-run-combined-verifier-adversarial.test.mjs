// P35 combined verifier adversarial coverage: hostile containers, identity
// drift, incomplete-ready smuggling, and remote-mutation denial.

import assert from 'node:assert/strict';
import test from 'node:test';

import { expectedCandidateRefV1 } from '../mcp/v3/git-authority.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { composeRunOwnedCandidateV1 } from '../mcp/v3/run-candidate-composer.mjs';
import {
  parseCombinedCandidateRequestV1,
  verifyCombinedCandidateV1,
} from '../mcp/v3/run-combined-verifier.mjs';
import {
  ASSIGNMENT_A,
  DENY_VERIFIER_GIT_OPTIONS,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  RUN_ID,
  addWriterCommit,
  candidateRef,
  composeRequest,
  countingProxy,
  createBaseRepo,
  executeVerificationStub,
  inspectRepo,
  trapTotal,
  verifyRequest,
  withCandidateRef,
  writerLane,
} from './fixtures/r1-run-candidate-composer-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertContentFree(error) {
  assert.doesNotMatch(error.message, /sk-live/u);
  assert.doesNotMatch(error.message, /github_pat/u);
  assert.doesNotMatch(error.message, /\/tmp\/secret-repo/u);
}

test('proxy verifier requests fail closed without traps', async () => {
  const proxied = countingProxy({ schema: 'x' });
  const error = await errorOf(() => parseCombinedCandidateRequestV1(proxied.proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.equal(trapTotal(proxied.counts), 0);
  assertContentFree(error);
});

test('unknown keys and accessors fail closed without leaking secrets', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]));
  const base = verifyRequest(repo, composition);
  assert.equal((await errorOf(() => parseCombinedCandidateRequestV1({
    ...base, create_pr: true,
  }))).code, 'unknown_key');
  const accessor = { ...base };
  Object.defineProperty(accessor, 'version', {
    enumerable: true, get() { return HOSTILE_TOKEN; },
  });
  const error = await errorOf(() => parseCombinedCandidateRequestV1(accessor));
  assert.equal(error.code, 'accessor_property_denied');
  assertContentFree(error);
  assert.equal(error.message.includes(HOSTILE_SECRET), false);
});

test('proxy options fail closed without invoking injected seams', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]));
  const proxied = countingProxy({ executeVerification: executeVerificationStub });
  const error = await errorOf(() => verifyCombinedCandidateV1(
    verifyRequest(repo, composition), proxied.proxy,
  ));
  assert.equal(error.code, 'proxy_denied');
  assert.equal(trapTotal(proxied.counts), 0);
});

test('smuggling ready_for_codex_review onto a blocked composition cannot upgrade it', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const composition = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'missing'),
  ]));
  assert.equal(composition.status, 'blocked');
  const forged = {
    ...composition,
    ready_for_codex_review: true,
    status: 'composed',
    candidate_sha: repo.baseSha,
    parent_count: 1,
  };
  const error = await errorOf(() => parseCombinedCandidateRequestV1(
    verifyRequest(repo, forged),
  ));
  assert.ok(['invalid_format', 'invalid_type'].includes(error.code));
});

test('unauthorized candidate_ref tampers fail closed with frozen evidence', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]));
  const authorized = candidateRef();
  const otherRun = expectedCandidateRefV1({ run_id: 'run-other-99' });
  const cases = [
    ['exact-main', 'refs/heads/main'],
    ['cross-run', otherRun],
    ['heads-master', 'refs/heads/master'],
    ['heads-develop', 'refs/heads/develop'],
    ['tag', 'refs/tags/v1.0.0'],
    ['remote', 'refs/remotes/origin/main'],
    ['notes', 'refs/notes/commits'],
    ['nested', `${authorized}/nested`],
    ['escaped', 'refs/codex-co-engineer/runs/run-candidate-01/%2e%2e/candidate'],
    ['traversal', 'refs/codex-co-engineer/runs/run-candidate-01/../candidate'],
    ['dotdot-main', 'refs/codex-co-engineer/runs/run-candidate-01/../../heads/main'],
    ['symbolic-HEAD', 'HEAD'],
    ['symbolic-at', `${authorized}@{0}`],
    ['aliased-peel', `${authorized}^{}`],
    ['missing-empty', ''],
    ['contradictory-leaf', 'refs/codex-co-engineer/runs/run-candidate-01/HEAD'],
  ];

  for (const [label, ref] of cases) {
    const receipt = await verifyCombinedCandidateV1(
      verifyRequest(repo, withCandidateRef(composition, ref)),
      DENY_VERIFIER_GIT_OPTIONS,
    );
    assert.equal(Object.isFrozen(receipt), true, label);
    assert.equal(receipt.status, 'failed', label);
    assert.equal(receipt.ready_for_codex_review, false, label);
    assert.equal(receipt.verification_executed, false, label);
    assert.equal(receipt.integrated, false, label);
    assert.equal(receipt.side_effects.remote_mutated, false, label);
    assert.equal(receipt.side_effects.push_performed, false, label);
    assert.equal(receipt.candidate_ref, authorized, label);
    assert.equal(receipt.discrepancies.length > 0, true, label);
    assert.equal(receipt.facts.length > 0, true, label);
    assert.equal(receipt.facts[0].status, 'failed', label);
    assert.equal(receipt.facts[0].run_id, RUN_ID, label);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(HOSTILE_SECRET), false, label);
    if (ref.length > 0 && ref !== authorized) {
      assert.equal(serialized.includes(ref), false, label);
    }
    assert.equal(inspectRepo(repo).main, repo.baseSha, label);
    assert.equal(inspectRepo(repo).remotes, '', label);
  }

  const control = await verifyCombinedCandidateV1(
    verifyRequest(repo, withCandidateRef(composition, authorized)),
    { executeVerification: executeVerificationStub },
  );
  assert.equal(control.status, 'verified');
  assert.equal(control.ready_for_codex_review, true);
  assert.equal(control.candidate_ref, authorized);
  assert.equal(inspectRepo(repo).main, repo.baseSha);
  assert.equal(inspectRepo(repo).remotes, '');
  assert.equal(inspectRepo(repo).candidate, composition.candidate_sha);
});
