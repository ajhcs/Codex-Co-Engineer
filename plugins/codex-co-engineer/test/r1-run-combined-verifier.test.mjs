// P35 combined-candidate verifier focused coverage: P13/P14/P15/P16/P30/P32
// evidence, incomplete/blocked states, one-parent semantics, and Codex-only
// acceptance.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { composeRunOwnedCandidateV1 } from '../mcp/v3/run-candidate-composer.mjs';
import {
  RUN_COMBINED_VERIFIER_SCHEMA_ID,
  RUN_COMBINED_VERIFIER_VERSION,
  describeRunCombinedVerifierV1,
  verifyCombinedCandidateV1,
} from '../mcp/v3/run-combined-verifier.mjs';
import {
  ASSIGNMENT_A,
  ASSIGNMENT_B,
  addWriterCommit,
  composeRequest,
  createBaseRepo,
  executeVerificationStub,
  inspectRepo,
  verificationStub,
  verifyLane,
  verifyRequest,
  writerLane,
} from './fixtures/r1-run-candidate-composer-fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../mcp/v3/run-combined-verifier.mjs', import.meta.url));

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertFrozenTree(value) {
  assert.ok(value === null || typeof value !== 'object' || Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

const verifyOptions = { executeVerification: executeVerificationStub };

async function composed(repo, lanes, overrides = {}) {
  return composeRunOwnedCandidateV1(composeRequest(repo, lanes, overrides));
}

test('combined verifier schema never claims integration or Gate A', () => {
  assert.equal(RUN_COMBINED_VERIFIER_SCHEMA_ID, 'codex-co-engineer.run-combined-verifier.v1');
  assert.equal(RUN_COMBINED_VERIFIER_VERSION, 1);
  const inventory = describeRunCombinedVerifierV1();
  assert.equal(inventory.codex_only_final_acceptance, true);
  assert.equal(inventory.integrated, false);
  assert.equal(inventory.incomplete_never_ready, true);
  assert.equal(inventory.remote_mutated, false);
  assert.equal(inventory.gate_a_claimed, false);
  assert.equal(inventory.imports_server, false);
  assert.equal(inventory.imports_composer_functions, false);
});

test('P35 verifier source does not import server, supervisor, runtime, or scheduler', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  for (const forbidden of [
    'run-runtime.mjs', 'run-scheduler.mjs', 'server.mjs', 'supervisor.mjs',
    'mailbox.mjs', 'acp-worker.mjs', 'process-boundary.mjs', 'provider-registry.mjs',
    'run-artifact-bridge.mjs',
  ]) {
    assert.equal(source.includes(`from './${forbidden}'`), false, forbidden);
  }
  assert.equal(source.includes('composeRunOwnedCandidateV1'), false);
});

test('a complete composed candidate verifies through accepted evidence', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'from-a\n',
  });
  const composition = await composed(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
    verifyLane(),
  ]);
  const receipt = await verifyCombinedCandidateV1(
    verifyRequest(repo, composition), verifyOptions,
  );
  assertFrozenTree(receipt);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.ready_for_codex_review, true);
  assert.equal(receipt.codex_only_final_acceptance, true);
  assert.equal(receipt.integrated, false);
  assert.equal(receipt.parent_count, 1);
  assert.equal(receipt.verification_executed, true);
  assert.equal(receipt.api_boundary_status, 'ready');
  assert.equal(inspectRepo(repo).main, repo.baseSha);
  assert.equal(inspectRepo(repo).remotes, '');
});

test('blocked composition stays blocked and is never ready', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composed(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
    writerLane(ASSIGNMENT_B, ['docs/**'], 'rejected'),
  ]);
  const receipt = await verifyCombinedCandidateV1(
    verifyRequest(repo, composition), verifyOptions,
  );
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.ready_for_codex_review, false);
  assert.equal(receipt.verification_executed, false);
});

test('diagnostic incomplete_candidate can never receive ready_for_codex_review', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composed(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
    writerLane(ASSIGNMENT_B, ['docs/**'], 'unresolved'),
  ], { allow_diagnostic_partial_candidate: true });
  const receipt = await verifyCombinedCandidateV1(
    verifyRequest(repo, composition), verifyOptions,
  );
  assert.equal(receipt.status, 'incomplete_candidate');
  assert.equal(receipt.incomplete, true);
  assert.equal(receipt.ready_for_codex_review, false);
  assert.equal(receipt.codex_only_final_acceptance, true);
});

test('missing P16 evidence blocks ready even when composition is complete', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composed(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]);
  const request = verifyRequest(repo, composition);
  delete request.verification;
  const receipt = await verifyCombinedCandidateV1(request, verifyOptions);
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.ready_for_codex_review, false);
  assert.equal(receipt.verification_executed, false);
});

test('failing P16 evidence fails closed', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composed(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]);
  const receipt = await verifyCombinedCandidateV1(verifyRequest(repo, composition), {
    executeVerification: async () => verificationStub('fail'),
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.ready_for_codex_review, false);
});

test('mismatched composition identity fails closed', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const composition = await composed(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]);
  const request = verifyRequest(repo, composition);
  request.identity = { ...request.identity, run_id: 'run-other-identity-99' };
  const error = await errorOf(() => verifyCombinedCandidateV1(request, verifyOptions));
  assert.equal(error.code, 'identity_mismatch');
});
