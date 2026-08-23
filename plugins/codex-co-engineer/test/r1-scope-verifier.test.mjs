import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import test from 'node:test';

import {
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
} from '../mcp/v3/evidence-bundle.mjs';
import {
  GIT_CLOSED_ENV,
  GIT_EXECUTABLE,
  verifyGitIdentityV1,
} from '../mcp/v3/git-identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  parseScopeVerifierRequestV1,
  SCOPE_VERIFIER_ERROR_CODES,
  SCOPE_VERIFIER_SCHEMA_ID,
  SCOPE_VERIFIER_VERSION,
  verifyScopeV1,
} from '../mcp/v3/scope-verifier.mjs';
import {
  ASSIGNMENT_ID,
  BASE_REF,
  OTHER_ASSIGNMENT_ID,
  OTHER_WRITE_SCOPE,
  READ_ONLY_ASSIGNMENT_ID,
  RUN_ID,
  WRITE_SCOPE,
  createCopyInScopeRepo,
  createDeletionInScopeRepo,
  createInScopeWriterRepo,
  createOutOfScopeWriterRepo,
  createOverlapRepo,
  createReadOnlyUnchangedRepo,
  createRenameInScopeRepo,
  createStagedUntrackedMixRepo,
  createUnicodeNfcRepo,
  createUntrackedInScopeRepo,
  identityRequest,
  scopeRequest,
} from './fixtures/r1-scope-verifier-fixtures.mjs';

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

function gitCommandOf(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-C' || arg === '--git-dir' || arg === '-c') {
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && !arg.startsWith('-')) return arg;
  }
  return undefined;
}

async function identityOf(repo, overrides = {}) {
  return verifyGitIdentityV1(identityRequest(repo, overrides));
}

test('schema identity is additive v1 and does not claim later-wave ownership', () => {
  assert.equal(SCOPE_VERIFIER_SCHEMA_ID, 'codex-co-engineer.scope-verifier.v1');
  assert.equal(SCOPE_VERIFIER_VERSION, 1);
  assert.equal(Object.isFrozen(SCOPE_VERIFIER_ERROR_CODES), true);
  assert.equal(SCOPE_VERIFIER_SCHEMA_ID.includes('4.0.0'), false);
  assert.equal(SCOPE_VERIFIER_SCHEMA_ID.includes('p16'), false);
});

test('a valid request parses into a frozen detached snapshot', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const input = scopeRequest(repo, identity);
  const snapshot = parseScopeVerifierRequestV1(input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.write_scope), true);
  assert.equal(Object.isFrozen(snapshot.identity), true);
  assert.equal(snapshot.access, 'writer');
  assert.deepEqual([...snapshot.write_scope], [...WRITE_SCOPE]);
  input.access = 'read_only';
  input.write_scope.push('docs/**');
  assert.equal(snapshot.access, 'writer');
  assert.deepEqual([...snapshot.write_scope], [...WRITE_SCOPE]);
});

test('required keys, extra keys, and hidden defaults fail closed', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const base = scopeRequest(repo, identity);
  assert.equal(
    (await errorOf(() => parseScopeVerifierRequestV1({ ...base, extra: true }))).code,
    'unknown_key',
  );
  const missing = { ...base };
  delete missing.other_write_scopes;
  assert.equal(
    (await errorOf(
      () => parseScopeVerifierRequestV1(missing), 'scope.other_write_scopes',
    )).code,
    'missing_key',
  );
  assert.equal(
    (await errorOf(() => parseScopeVerifierRequestV1({
      ...base, access: 'read_only', write_scope: ['src/**'],
    }))).code,
    'out_of_range',
  );
});

test('an in-scope writer verifies independently into P13 git_diff facts', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  assert.equal(result.schema, SCOPE_VERIFIER_SCHEMA_ID);
  assert.equal(result.status, 'verified');
  assert.equal(result.discrepancies.length, 0);
  assert.equal(result.facts.length, 2);
  assert.equal(result.observation.base_sha, repo.baseSha);
  assert.equal(result.observation.head_sha, repo.headSha);
  assert.equal(result.observation.access, 'writer');
  assert.equal(result.observation.parent_count, 1);
  assert.equal(result.observation.path_count >= 1, true);
  assert.equal(result.observation.dirty, false);
  assert.equal(result.facts[0].fact_kind, 'git_diff');
  assert.equal(result.facts[0].status, 'verified');
  assert.equal(result.facts[0].authority, 'platform_git');
  assert.equal(result.facts[0].method, 'scope_match');
  assert.equal(result.facts[0].payload.path_count, result.observation.path_count);
  assert.equal(result.facts[0].payload.path_set_digest, result.observation.path_set_digest);
  assert.equal(result.facts[1].fact_kind, 'head_sha');
  assert.equal(result.facts[1].method, 'merge_commit_absence');
  assert.equal(result.facts[1].payload.sha, repo.headSha);
  assert.deepEqual(parseVerifiedFactV1({ ...result.facts[0] }).payload, result.facts[0].payload);
  parseVerifiedFactV1({ ...result.facts[1] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.facts), true);
  assert.equal(Object.isFrozen(result.observation), true);
});

test('additions, deletions, in-scope renames, and copies stay owned', async (t) => {
  const rename = await createRenameInScopeRepo();
  t.after(() => rename.cleanup());
  const renameIdentity = await identityOf(rename);
  const renameResult = await verifyScopeV1(scopeRequest(rename, renameIdentity));
  assert.equal(renameResult.status, 'verified');
  assert.equal(renameResult.observation.rename_count >= 1, true);

  const copy = await createCopyInScopeRepo();
  t.after(() => copy.cleanup());
  const copyIdentity = await identityOf(copy);
  const copyResult = await verifyScopeV1(scopeRequest(copy, copyIdentity));
  assert.equal(copyResult.status, 'verified');
  assert.equal(copyResult.observation.path_count >= 2, true);
  assert.equal(copyResult.observation.copy_count >= 1, true);

  const deletion = await createDeletionInScopeRepo();
  t.after(() => deletion.cleanup());
  const deletionIdentity = await identityOf(deletion);
  const deletionResult = await verifyScopeV1(scopeRequest(deletion, deletionIdentity));
  assert.equal(deletionResult.status, 'verified');
  assert.equal(deletionResult.observation.path_count >= 1, true);
});

test('changed paths outside the trusted write_scope fail as a discrepancy', async (t) => {
  const repo = await createOutOfScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  assert.equal(result.status, 'failed');
  assert.equal(discrepancyIds(result).includes('scope-mismatch'), true);
  assert.equal(result.facts[0].status, 'failed');
  parseEvidenceDiscrepancyV1({ ...result.discrepancies[0] });
});

test('paths owned by another assignment fail as overlap', async (t) => {
  const repo = await createOverlapRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity, {
    other_write_scopes: [{
      assignment_id: OTHER_ASSIGNMENT_ID,
      write_scope: [...OTHER_WRITE_SCOPE],
    }],
  }));
  assert.equal(result.status, 'failed');
  const ids = discrepancyIds(result);
  assert.equal(ids.includes('scope-overlap'), true);
  assert.equal(ids.includes('scope-mismatch'), true);
});

test('read-only assignments with no candidate mutations verify', async (t) => {
  const repo = await createReadOnlyUnchangedRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo, { assignment_id: READ_ONLY_ASSIGNMENT_ID });
  const result = await verifyScopeV1(scopeRequest(repo, identity, {
    assignment_id: READ_ONLY_ASSIGNMENT_ID,
    access: 'read_only',
    write_scope: [],
  }));
  assert.equal(result.status, 'verified');
  assert.equal(result.observation.path_count, 0);
  assert.equal(result.observation.dirty, false);
  assert.equal(result.facts[0].method, 'read_only_no_changes');
  assert.equal(result.facts[0].payload.path_count, 0);
  assert.equal(result.facts[1].method, 'merge_commit_absence');
});

test('read-only assignments reject candidate mutations', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo, { assignment_id: READ_ONLY_ASSIGNMENT_ID });
  const result = await verifyScopeV1(scopeRequest(repo, identity, {
    assignment_id: READ_ONLY_ASSIGNMENT_ID,
    access: 'read_only',
    write_scope: [],
  }));
  assert.equal(result.status, 'failed');
  assert.equal(discrepancyIds(result).includes('read-only-mutation'), true);
  assert.equal(result.observation.path_count >= 1, true);
});

test('NFC Unicode paths in scope verify without reflecting the bytes', async (t) => {
  const repo = await createUnicodeNfcRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  assert.equal(result.status, 'verified');
  assert.equal(result.observation.path_count >= 1, true);
  assert.equal(JSON.stringify(result).includes(repo.extra.path), false);
});

test('tracked index mutations join the content-free path set', async (t) => {
  const repo = await createStagedUntrackedMixRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  assert.equal(result.status, 'verified');
  assert.equal(result.observation.dirty, true);
  assert.equal(result.observation.path_count >= 2, true);
});

test('untracked in-scope files join ownership without leaking names', async (t) => {
  const repo = await createUntrackedInScopeRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  assert.equal(result.status, 'verified');
  assert.equal(result.observation.dirty, true);
  assert.equal(JSON.stringify(result).includes('scratch.txt'), false);
});

test('git runs as argv without shell and with a closed environment', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const calls = [];
  const previousGitDir = process.env.GIT_DIR;
  const previousConfig = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_DIR = '/tmp/hostile-git-dir';
  process.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath=/tmp/hooks'";
  try {
    const result = await verifyScopeV1(scopeRequest(repo, identity), {
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return nodeSpawn(command, args, options);
      },
    });
    assert.equal(result.status, 'verified');
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    if (previousConfig === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = previousConfig;
  }
  assert.ok(calls.length > 0);
  const mutating = new Set([
    'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit',
    'fetch', 'init', 'merge', 'pull', 'push', 'rebase', 'replace', 'reset',
    'revert', 'rm', 'stash', 'tag', 'update-index', 'worktree',
  ]);
  for (const call of calls) {
    assert.equal(call.command, GIT_EXECUTABLE);
    assert.equal(call.options.cwd, '/');
    assert.equal(call.options.env, GIT_CLOSED_ENV);
    assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(call.options.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(call.options.env.GIT_CONFIG_SYSTEM, '/dev/null');
    assert.equal(call.options.env.GIT_ALLOW_PROTOCOL, '');
    assert.equal(call.options.env.GIT_PROTOCOL_FROM_USER, '0');
    assert.equal(Object.hasOwn(call.options.env, 'GIT_DIR'), false);
    assert.equal(call.options.shell, undefined);
    assert.equal(Array.isArray(call.args), true);
    assert.equal(call.args.some((arg) => arg.includes('&&') || arg.includes('|') || arg.includes(';')), false);
    const command = gitCommandOf(call.args);
    assert.equal(mutating.has(command), false, command);
  }
});

test('independent repositories verify concurrently without sharing observation', async (t) => {
  const left = await createInScopeWriterRepo();
  const right = await createInScopeWriterRepo();
  t.after(() => Promise.all([left.cleanup(), right.cleanup()]));
  const [leftIdentity, rightIdentity] = await Promise.all([
    identityOf(left), identityOf(right),
  ]);
  const [leftResult, rightResult] = await Promise.all([
    verifyScopeV1(scopeRequest(left, leftIdentity)),
    verifyScopeV1(scopeRequest(right, rightIdentity)),
  ]);
  assert.equal(leftResult.status, 'verified');
  assert.equal(rightResult.status, 'verified');
  assert.equal(leftResult.observation.repository_path, left.path);
  assert.equal(rightResult.observation.repository_path, right.path);
  assert.notEqual(left.headSha, right.headSha);
  assert.notEqual(leftResult.facts[0].payload.path_set_digest, undefined);
});

test('facts and discrepancies stay content-free and re-parse as P13 snapshots', async (t) => {
  const repo = await createOutOfScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('secret.txt'), false);
  assert.equal(blob.includes(repo.path), true);
  for (const fact of result.facts) parseVerifiedFactV1({ ...fact });
  for (const discrepancy of result.discrepancies) {
    parseEvidenceDiscrepancyV1({ ...discrepancy });
    assert.equal(discrepancy.claim_ids.length, 0);
  }
  assert.equal(BASE_REF.startsWith('refs/heads/'), true);
  assert.equal(ASSIGNMENT_ID, 'lane-writer');
  assert.equal(RUN_ID.startsWith('run-'), true);
});
