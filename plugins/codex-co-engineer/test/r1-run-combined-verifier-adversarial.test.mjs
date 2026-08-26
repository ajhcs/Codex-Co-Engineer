// P35 combined verifier adversarial coverage: hostile containers, identity
// drift, incomplete-ready smuggling, and remote-mutation denial.

import assert from 'node:assert/strict';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { composeRunOwnedCandidateV1 } from '../mcp/v3/run-candidate-composer.mjs';
import {
  parseCombinedCandidateRequestV1,
  verifyCombinedCandidateV1,
} from '../mcp/v3/run-combined-verifier.mjs';
import {
  ASSIGNMENT_A,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  addWriterCommit,
  composeRequest,
  countingProxy,
  createBaseRepo,
  executeVerificationStub,
  trapTotal,
  verifyRequest,
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
