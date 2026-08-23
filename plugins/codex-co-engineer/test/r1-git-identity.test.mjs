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
  GIT_IDENTITY_ERROR_CODES,
  GIT_IDENTITY_SCHEMA_ID,
  GIT_IDENTITY_VERSION,
  MAX_GIT_OUTPUT_BYTES,
  parseGitIdentityRequestV1,
  verifyGitIdentityV1,
} from '../mcp/v3/git-identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ASSIGNMENT_ID,
  BASE_REF,
  RUN_ID,
  createLinearRepo,
  createMissingRepoPath,
  createNonGitDirectory,
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

test('schema identity is additive v1 and does not claim later-wave ownership', () => {
  assert.equal(GIT_IDENTITY_SCHEMA_ID, 'codex-co-engineer.git-identity.v1');
  assert.equal(GIT_IDENTITY_VERSION, 1);
  assert.equal(GIT_EXECUTABLE, '/usr/bin/git');
  assert.equal(Object.isFrozen(GIT_IDENTITY_ERROR_CODES), true);
  assert.equal(GIT_IDENTITY_SCHEMA_ID.includes('4.0.0'), false);
});

test('a valid request parses into a frozen detached snapshot', () => {
  const input = validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  });
  const snapshot = parseGitIdentityRequestV1(input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.repository), true);
  assert.equal(snapshot.expected_base_ref, BASE_REF);
  assert.equal(snapshot.run_id, RUN_ID);
  assert.equal(snapshot.assignment_id, ASSIGNMENT_ID);
  input.expected_base_ref = 'refs/heads/other';
  input.repository.base_sha = 'c'.repeat(40);
  assert.equal(snapshot.expected_base_ref, BASE_REF);
  assert.equal(snapshot.repository.base_sha, 'a'.repeat(40));
});

test('required keys, extra keys, and hostile base refs fail closed', async () => {
  const base = validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  });
  assert.equal(
    (await errorOf(() => parseGitIdentityRequestV1({ ...base, extra: true }))).code,
    'unknown_key',
  );
  const missing = { ...base };
  delete missing.candidate_head_sha;
  assert.equal(
    (await errorOf(() => parseGitIdentityRequestV1(missing), 'git_identity.candidate_head_sha')).code,
    'missing_key',
  );
  for (const name of [
    'HEAD', 'refs/heads/HEAD', '-n', '--upload-pack=evil', 'refs/replace/x',
    'refs/heads/foo..bar', 'refs/heads/foo.lock', 'refs/heads/@{u}',
    'main', 'refs/tags/v1', 'refs/heads/foo^2', 'refs/heads/foo:path',
  ]) {
    const error = await errorOf(() => parseGitIdentityRequestV1({
      ...base, expected_base_ref: name,
    }), 'git_identity.expected_base_ref');
    assert.ok(
      error.code === 'hostile_name_denied' || error.code === 'invalid_format',
      name,
    );
    assert.equal(error.message.includes(name), false, name);
  }
});

test('a linear descendant verifies independently into P13 git facts', async (t) => {
  const repo = await createLinearRepo();
  t.after(() => repo.cleanup());
  const result = await verifyGitIdentityV1(validRequest({
    path: repo.path,
    base_sha: repo.baseSha,
    head_sha: repo.headSha,
  }));
  assert.equal(result.schema, GIT_IDENTITY_SCHEMA_ID);
  assert.equal(result.status, 'verified');
  assert.equal(result.discrepancies.length, 0);
  assert.equal(result.facts.length, 2);
  assert.equal(result.observation.base_sha, repo.baseSha);
  assert.equal(result.observation.head_sha, repo.headSha);
  assert.equal(result.observation.merge_base_sha, repo.baseSha);
  assert.equal(result.observation.ancestor, true);
  assert.equal(result.observation.base_object_type, 'commit');
  assert.equal(result.observation.head_object_type, 'commit');
  assert.equal(result.facts[0].fact_kind, 'git_identity');
  assert.equal(result.facts[0].status, 'verified');
  assert.equal(result.facts[0].authority, 'platform_git');
  assert.equal(result.facts[0].method, 'ancestry_check');
  assert.equal(result.facts[0].payload.base_sha, repo.baseSha);
  assert.equal(result.facts[0].payload.head_sha, repo.headSha);
  assert.equal(result.facts[1].fact_kind, 'head_sha');
  assert.equal(result.facts[1].payload.sha, repo.headSha);
  assert.deepEqual(parseVerifiedFactV1({ ...result.facts[0] }).payload, result.facts[0].payload);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.facts), true);
  assert.equal(Object.isFrozen(result.observation), true);
});

test('missing and non-git repositories fail closed without echoing paths', async (t) => {
  const missing = await createMissingRepoPath();
  t.after(() => missing.cleanup());
  const missingError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: missing.path,
    base_sha: missing.baseSha,
    head_sha: missing.headSha,
  })));
  assert.equal(missingError.code, 'repository_missing');
  assert.equal(missingError.message.includes(missing.path), false);

  const nongit = await createNonGitDirectory();
  t.after(() => nongit.cleanup());
  const invalid = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: nongit.path,
    base_sha: nongit.baseSha,
    head_sha: nongit.headSha,
  })));
  assert.equal(invalid.code, 'repository_invalid');
  assert.equal(invalid.message.includes(nongit.path), false);
});

test('git runs as argv without shell and with a closed environment', async (t) => {
  const repo = await createLinearRepo();
  t.after(() => repo.cleanup());
  const calls = [];
  const previousGitDir = process.env.GIT_DIR;
  const previousConfig = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_DIR = '/tmp/hostile-git-dir';
  process.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath=/tmp/hooks'";
  try {
    const result = await verifyGitIdentityV1(validRequest({
      path: repo.path,
      base_sha: repo.baseSha,
      head_sha: repo.headSha,
    }), {
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
  for (const call of calls) {
    assert.equal(call.command, GIT_EXECUTABLE);
    assert.equal(call.options.cwd, '/');
    assert.equal(call.options.env, GIT_CLOSED_ENV);
    assert.equal(Object.hasOwn(call.options.env, 'GIT_DIR'), false);
    assert.equal(Object.hasOwn(call.options.env, 'GIT_CONFIG_PARAMETERS'), false);
    assert.equal(call.options.shell, undefined);
    assert.equal(Array.isArray(call.args), true);
    assert.equal(call.args.some((arg) => arg.includes('&&') || arg.includes('|') || arg.includes(';')), false);
  }
});

test('independent repositories verify concurrently without sharing observation', async (t) => {
  const left = await createLinearRepo();
  const right = await createLinearRepo();
  t.after(() => Promise.all([left.cleanup(), right.cleanup()]));
  const [leftResult, rightResult] = await Promise.all([
    verifyGitIdentityV1(validRequest({
      path: left.path, base_sha: left.baseSha, head_sha: left.headSha,
    })),
    verifyGitIdentityV1(validRequest({
      path: right.path, base_sha: right.baseSha, head_sha: right.headSha,
    })),
  ]);
  assert.equal(leftResult.status, 'verified');
  assert.equal(rightResult.status, 'verified');
  assert.equal(leftResult.observation.repository_path, left.path);
  assert.equal(rightResult.observation.repository_path, right.path);
  assert.notEqual(left.baseSha, right.baseSha);
  assert.notEqual(leftResult.facts[0].payload.base_sha, rightResult.facts[0].payload.base_sha);
});

test('output bounds kill hostile git writers without reflecting content', async (t) => {
  const repo = await createLinearRepo();
  t.after(() => repo.cleanup());
  const error = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: repo.path,
    base_sha: repo.baseSha,
    head_sha: repo.headSha,
  }), {
    spawn() {
      return nodeSpawn('/usr/bin/yes', ['x'.repeat(64)], {
        cwd: '/',
        env: GIT_CLOSED_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  }));
  assert.equal(error.code, 'bounds_exceeded');
  assert.equal(error.message.includes('x'.repeat(16)), false);
  assert.ok(MAX_GIT_OUTPUT_BYTES > 0);
});

test('verified facts stay EvidenceBundle-compatible without proof artifacts', async (t) => {
  const repo = await createLinearRepo();
  t.after(() => repo.cleanup());
  const result = await verifyGitIdentityV1(validRequest({
    path: repo.path,
    base_sha: repo.baseSha,
    head_sha: repo.headSha,
  }));
  const identity = parseVerifiedFactV1(result.facts[0]);
  const head = parseVerifiedFactV1(result.facts[1]);
  assert.equal(identity.fact_kind, 'git_identity');
  assert.equal(head.fact_kind, 'head_sha');
  assert.equal(identity.artifact_digests.length, 0);
  assert.equal(result.discrepancies.length, 0);
  assert.equal(typeof parseEvidenceDiscrepancyV1, 'function');
});
