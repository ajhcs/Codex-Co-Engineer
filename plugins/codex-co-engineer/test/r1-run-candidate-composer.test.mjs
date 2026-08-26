// P35 run-owned candidate composer focused coverage: binary-safe manifest
// order, one-parent candidate ref, blocked/incomplete states, restart
// idempotency, and denied remote mutation.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { expectedCandidateRefV1 } from '../mcp/v3/git-authority.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  CANDIDATE_COMMIT_MESSAGE,
  COMPOSER_STATUSES,
  RUN_CANDIDATE_COMPOSER_SCHEMA_ID,
  RUN_CANDIDATE_COMPOSER_VERSION,
  composeRunOwnedCandidateV1,
  describeRunCandidateComposerV1,
  parseRunCandidateComposeRequestV1,
} from '../mcp/v3/run-candidate-composer.mjs';
import {
  ASSIGNMENT_A,
  ASSIGNMENT_B,
  BINARY_BYTES,
  RUN_ID,
  addModeChangeWriter,
  addRenameWriter,
  addSymlinkWriter,
  addWriterCommit,
  candidateRef,
  composeRequest,
  createBaseRepo,
  fileAt,
  git,
  inspectRepo,
  parentsOf,
  verifyLane,
  writerLane,
} from './fixtures/r1-run-candidate-composer-fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../mcp/v3/run-candidate-composer.mjs', import.meta.url));

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

test('createRunCandidateComposer schema is additive v1 and never ready', () => {
  assert.equal(RUN_CANDIDATE_COMPOSER_SCHEMA_ID, 'codex-co-engineer.run-candidate-composer.v1');
  assert.equal(RUN_CANDIDATE_COMPOSER_VERSION, 1);
  const inventory = describeRunCandidateComposerV1();
  assert.equal(inventory.conflict_repair, false);
  assert.equal(inventory.ready_for_codex_review, false);
  assert.equal(inventory.remote_mutated, false);
  assert.equal(inventory.gate_a_claimed, false);
  assert.equal(inventory.imports_server, false);
  assert.deepEqual([...inventory.statuses], [...COMPOSER_STATUSES]);
  assert.equal(
    inventory.candidate_ref_namespace + '<run-id>/' + inventory.candidate_ref_leaf,
    'refs/codex-co-engineer/runs/<run-id>/candidate',
  );
});

test('P35 composer source does not import server, supervisor, runtime, or scheduler', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  for (const forbidden of [
    'run-runtime.mjs', 'run-scheduler.mjs', 'server.mjs', 'supervisor.mjs',
    'mailbox.mjs', 'acp-worker.mjs', 'process-boundary.mjs', 'provider-registry.mjs',
    'run-artifact-bridge.mjs', 'run-orchestration.mjs',
  ]) {
    assert.equal(source.includes(`from './${forbidden}'`), false, forbidden);
  }
});

test('two verified writers compose in manifest order onto a one-parent candidate', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headB = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_B, relativePath: 'docs/b.md', contents: 'from-b\n',
  });
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'from-a\n',
  });
  const before = inspectRepo(repo);
  const receipt = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_B, ['docs/**'], 'verified', headB),
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
    verifyLane(),
  ]));
  assertFrozenTree(receipt);
  assert.equal(receipt.status, 'composed');
  assert.equal(receipt.ready_for_codex_review, false);
  assert.equal(receipt.parent_count, 1);
  assert.equal(receipt.parent_sha, repo.baseSha);
  assert.equal(receipt.candidate_ref, expectedCandidateRefV1({ run_id: RUN_ID }));
  assert.deepEqual([...receipt.applied_assignment_ids], [ASSIGNMENT_B, ASSIGNMENT_A]);
  assert.equal(parentsOf(repo, receipt.candidate_sha).join(' '), repo.baseSha);
  assert.equal(fileAt(repo, receipt.candidate_sha, 'docs/b.md').toString('utf8'), 'from-b\n');
  assert.equal(fileAt(repo, receipt.candidate_sha, 'src/a.js').toString('utf8'), 'from-a\n');
  const after = inspectRepo(repo);
  assert.equal(after.head, before.head);
  assert.equal(after.main, repo.baseSha);
  assert.equal(after.remotes, '');
  assert.equal(after.candidate, receipt.candidate_sha);
  assert.equal(git(repo.path, ['log', '-1', '--format=%s', receipt.candidate_sha]), CANDIDATE_COMMIT_MESSAGE);
});

test('binary bytes survive composition without text recoding', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A,
    relativePath: 'src/data.bin',
    contents: BINARY_BYTES,
    binary: true,
  });
  const receipt = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]));
  assert.equal(receipt.status, 'composed');
  assert.deepEqual(fileAt(repo, receipt.candidate_sha, 'src/data.bin'), BINARY_BYTES);
});

test('required missing rejected or unresolved writers block without writing a ref', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  for (const state of ['missing', 'rejected', 'unresolved']) {
    const receipt = await composeRunOwnedCandidateV1(composeRequest(repo, [
      writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
      writerLane(ASSIGNMENT_B, ['docs/**'], state),
    ]));
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.candidate_sha, null);
    assert.equal(receipt.ready_for_codex_review, false);
    assert.equal(inspectRepo(repo).candidate, null);
    assert.deepEqual([...receipt.blocked_assignment_ids], [ASSIGNMENT_B]);
  }
});

test('diagnostic partial composes verified writers as incomplete_candidate', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const receipt = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
    writerLane(ASSIGNMENT_B, ['docs/**'], 'unresolved'),
  ], { allow_diagnostic_partial_candidate: true }));
  assert.equal(receipt.status, 'incomplete_candidate');
  assert.equal(receipt.incomplete, true);
  assert.equal(receipt.ready_for_codex_review, false);
  assert.equal(receipt.applied_assignment_ids[0], ASSIGNMENT_A);
  assert.equal(inspectRepo(repo).candidate, receipt.candidate_sha);
});

test('optional advisory lanes do not block a complete candidate', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const receipt = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
    verifyLane('rejected'),
  ]));
  assert.equal(receipt.status, 'composed');
  assert.equal(receipt.blocked_assignment_ids.length, 0);
});

test('restart of the same frozen deltas is idempotent', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const request = composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]);
  const first = await composeRunOwnedCandidateV1(request);
  const second = await composeRunOwnedCandidateV1(request);
  assert.equal(second.idempotent, true);
  assert.equal(second.candidate_sha, first.candidate_sha);
  assert.equal(inspectRepo(repo).candidate, first.candidate_sha);
});

test('overlapping writer paths fail closed without merge repair', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/shared.txt', contents: 'a\n',
  });
  const headB = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_B, relativePath: 'src/shared.txt', contents: 'b\n',
  });
  const error = await errorOf(() => composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
    writerLane(ASSIGNMENT_B, ['src/**'], 'verified', headB),
  ])));
  assert.equal(error.code, 'path_ownership_denied');
  assert.equal(inspectRepo(repo).candidate, null);
  assert.equal(inspectRepo(repo).main, repo.baseSha);
});

test('symlink rename and mode-change deltas are rejected', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const symlinkSha = await addSymlinkWriter(repo);
  const renameSha = await addRenameWriter(repo);
  const modeSha = await addModeChangeWriter(repo);
  assert.equal((await errorOf(() => composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', symlinkSha),
  ])))).code, 'delta_policy_denied');
  assert.equal((await errorOf(() => composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', renameSha),
  ])))).code, 'delta_policy_denied');
  assert.equal((await errorOf(() => composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', modeSha),
  ])))).code, 'delta_policy_denied');
  assert.equal(inspectRepo(repo).candidate, null);
});

test('out of scope paths fail closed', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'docs/escape.md', contents: 'nope\n',
  });
  const error = await errorOf(() => composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ])));
  assert.equal(error.code, 'path_ownership_denied');
});

test('parsed requests are detached snapshots', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const input = composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'missing'),
    verifyLane(),
  ]);
  const snapshot = parseRunCandidateComposeRequestV1(input);
  assert.equal(Object.isFrozen(snapshot), true);
  input.lanes.push(writerLane(ASSIGNMENT_B, ['docs/**'], 'missing'));
  assert.equal(snapshot.lanes.length, 2);
  assert.equal(snapshot.candidate_ref, candidateRef());
});

test('legacy 3.2.1 compatibility: composer does not claim a sixth tool or version bump', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  assert.equal(source.includes('4.0.0'), false);
  assert.equal(source.includes('ready_for_codex_review: true'), false);
  assert.match(source, /Codex retains sole final acceptance/u);
});
