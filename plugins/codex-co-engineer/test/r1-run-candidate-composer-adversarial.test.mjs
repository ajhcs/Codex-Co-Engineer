// P35 composer adversarial coverage: hostile containers, remote mutation,
// protected-ref writes, credential leaks, and conflict-repair attempts.

import assert from 'node:assert/strict';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  composeRunOwnedCandidateV1,
  parseRunCandidateComposeRequestV1,
} from '../mcp/v3/run-candidate-composer.mjs';
import { GIT_EXECUTABLE } from '../mcp/v3/git-identity.mjs';
import {
  ASSIGNMENT_A,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  addWriterCommit,
  composeRequest,
  countingProxy,
  createBaseRepo,
  inspectRepo,
  trapTotal,
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
  assert.doesNotMatch(error.message, /Bearer /u);
}

test('proxy requests fail closed without traps', async () => {
  const proxied = countingProxy({ schema: 'x' });
  const error = await errorOf(() => parseRunCandidateComposeRequestV1(proxied.proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.equal(trapTotal(proxied.counts), 0);
  assertContentFree(error);
});

test('unknown keys, missing keys, and accessors fail closed', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const base = composeRequest(repo, [writerLane(ASSIGNMENT_A, ['src/**'], 'missing')]);
  assert.equal((await errorOf(() => parseRunCandidateComposeRequestV1({ ...base, merge: true }))).code,
    'unknown_key');
  const missing = { ...base };
  delete missing.lanes;
  assert.equal((await errorOf(() => parseRunCandidateComposeRequestV1(missing))).code, 'missing_key');
  const accessor = { ...base };
  Object.defineProperty(accessor, 'version', {
    enumerable: true, get() { return HOSTILE_SECRET; },
  });
  const error = await errorOf(() => parseRunCandidateComposeRequestV1(accessor));
  assert.equal(error.code, 'accessor_property_denied');
  assertContentFree(error);
});

test('smuggled ready_for_codex_review and remote operations are unknown keys', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const base = composeRequest(repo, [writerLane(ASSIGNMENT_A, ['src/**'], 'missing')]);
  for (const extra of ['ready_for_codex_review', 'push', 'create_pr', 'rebase', 'tag']) {
    const error = await errorOf(() => parseRunCandidateComposeRequestV1({ ...base, [extra]: true }));
    assert.equal(error.code, 'unknown_key', extra);
  }
});

test('composer spawn never issues push merge rebase or remote commands', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const headA = await addWriterCommit(repo, {
    assignmentId: ASSIGNMENT_A, relativePath: 'src/a.js', contents: 'a\n',
  });
  const { spawn: nodeSpawn } = await import('node:child_process');
  const seen = [];
  const wrapped = (executable, args, options) => {
    seen.push([executable, ...args]);
    return nodeSpawn(executable, args, options);
  };
  const receipt = await composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', headA),
  ]), { spawn: wrapped });
  assert.equal(receipt.status, 'composed');
  const flat = seen.flat().join('\0');
  assert.equal(flat.includes('\0push\0') || flat.endsWith('\0push') || flat.startsWith('push\0'), false);
  for (const command of ['push', 'fetch', 'merge', 'rebase', 'pull', 'remote']) {
    assert.equal(seen.some((args) => args.includes(command)), false, command);
  }
  assert.equal(seen.every((args) => args[0] === GIT_EXECUTABLE || args[0] !== undefined), true);
});

test('hostile secrets in repository paths never appear in typed errors', async () => {
  const error = await errorOf(() => parseRunCandidateComposeRequestV1({
    schema: 'codex-co-engineer.run-candidate-composer.v1',
    version: 1,
    identity: {
      repository_path: HOSTILE_PATH,
      base_sha: '0123456789abcdef0123456789abcdef01234567',
      run_id: 'run-candidate-01',
      assignment_id: ASSIGNMENT_A,
    },
    expected_base_ref: 'refs/heads/main',
    expected_protected_refs: [{
      ref: 'refs/heads/main', sha: '0123456789abcdef0123456789abcdef01234567',
    }],
    lanes: [writerLane(ASSIGNMENT_A, ['src/**'], 'missing')],
    token: HOSTILE_TOKEN,
  }));
  assert.equal(error.code, 'unknown_key');
  assertContentFree(error);
  assert.equal(error.message.includes(HOSTILE_SECRET), false);
});

test('failed composition leaves HEAD main and remotes untouched', async (t) => {
  const repo = await createBaseRepo();
  t.after(() => repo.cleanup());
  const before = inspectRepo(repo);
  const error = await errorOf(() => composeRunOwnedCandidateV1(composeRequest(repo, [
    writerLane(ASSIGNMENT_A, ['src/**'], 'verified', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ])));
  assert.ok(['unverified_delta_denied', 'git_execution_failed'].includes(error.code));
  const after = inspectRepo(repo);
  assert.equal(after.head, before.head);
  assert.equal(after.main, before.main);
  assert.equal(after.remotes, '');
  assert.equal(after.candidate, null);
});
