import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import {
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
} from '../mcp/v3/evidence-bundle.mjs';
import {
  GIT_CLOSED_ENV,
  verifyGitIdentityV1,
} from '../mcp/v3/git-identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  MAX_SCOPE_OUTPUT_BYTES,
  parseScopeVerifierRequestV1,
  verifyScopeV1,
} from '../mcp/v3/scope-verifier.mjs';
import {
  OTHER_ASSIGNMENT_ID,
  READ_ONLY_ASSIGNMENT_ID,
  countingProxy,
  createConfusableSeparatorRepo,
  createGitlinkRepo,
  createHistoricalMergeRepo,
  createInScopeWriterRepo,
  createMergeCommitRepo,
  createNonNfcRepo,
  createOutOfScopeWriterRepo,
  createRenameEscapingRepo,
  createSymlinkRepo,
  createTypeChangeRepo,
  createUntrackedOutOfScopeRepo,
  identityRequest,
  scopeRequest,
  trapTotal,
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

function assertContentFree(error, ...needles) {
  const blob = `${error.code}\n${error.path}\n${error.message}`;
  for (const needle of needles) {
    assert.equal(blob.includes(needle), false, needle);
  }
}

async function identityOf(repo, overrides = {}) {
  return verifyGitIdentityV1(identityRequest(repo, overrides));
}

test('live proxies are denied with zero traps on the request surface', async () => {
  const { proxy, counts } = countingProxy({
    identity_request: identityRequest({
      path: '/tmp/cce-r1-scope-repo', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
    }),
    identity: {},
    access: 'writer',
    write_scope: ['src/**'],
    other_write_scopes: [],
  });
  assert.equal((await errorOf(() => parseScopeVerifierRequestV1(proxy))).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);
});

test('revoked proxies fail closed before Array.isArray or Reflect can throw', async () => {
  const { proxy, revoke } = Proxy.revocable({
    identity_request: identityRequest({
      path: '/tmp/cce-r1-scope-repo', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
    }),
    identity: {},
    access: 'writer',
    write_scope: ['src/**'],
    other_write_scopes: [],
  }, {
    get() { throw new Error('revoked get'); },
    ownKeys() { throw new Error('revoked ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('revoked descriptor'); },
  });
  revoke();
  assert.equal(utilTypes.isProxy(proxy), true);
  const error = await errorOf(() => parseScopeVerifierRequestV1(proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);
});

test('accessor properties are rejected and their getters never run', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const input = scopeRequest(repo, identity);
  let reads = 0;
  Object.defineProperty(input, 'access', {
    enumerable: true,
    get() {
      reads += 1;
      return 'writer';
    },
  });
  const error = await errorOf(() => parseScopeVerifierRequestV1(input));
  assert.equal(error.code, 'accessor_property_denied');
  assert.equal(reads, 0);
});

test('unverified or mismatched P14 identity is not treated as authority', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const failed = {
    ...identity,
    status: 'failed',
    discrepancies: [{
      discrepancy_id: 'stale-base',
      discrepancy_kind: 'integrity',
      status: 'recorded',
      code: 'artifact_integrity_failure',
      run_id: identity.facts[0].run_id,
      assignment_id: identity.facts[0].assignment_id,
      sequence: 0,
      claim_ids: [],
      fact_ids: ['git-identity'],
      artifact_digests: [],
    }],
  };
  assert.equal((await errorOf(() => parseScopeVerifierRequestV1(
    scopeRequest(repo, failed),
  ))).code, 'unverified_identity');

  const mismatched = {
    ...identity,
    observation: { ...identity.observation, head_sha: 'c'.repeat(40) },
  };
  assert.equal((await errorOf(() => parseScopeVerifierRequestV1(
    scopeRequest(repo, mismatched),
  ))).code, 'identity_mismatch');
});

test('provider claims cannot be supplied as scope authority', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const error = await errorOf(() => parseScopeVerifierRequestV1({
    ...scopeRequest(repo, identity),
    claims: [{ claim_kind: 'files_changed', path_count: 1 }],
  }));
  assert.equal(error.code, 'unknown_key');
});

test('merge commits and later commits on merged history fail closed', async (t) => {
  const merge = await createMergeCommitRepo();
  t.after(() => merge.cleanup());
  const mergeIdentity = await identityOf(merge);
  const mergeResult = await verifyScopeV1(scopeRequest(merge, mergeIdentity));
  assert.equal(mergeResult.status, 'failed');
  assert.equal(discrepancyIds(mergeResult).includes('merge-commit'), true);
  parseEvidenceDiscrepancyV1({ ...mergeResult.discrepancies[0] });
  parseVerifiedFactV1({ ...mergeResult.facts[1] });

  const historical = await createHistoricalMergeRepo();
  t.after(() => historical.cleanup());
  const historicalIdentity = await identityOf(historical);
  const historicalResult = await verifyScopeV1(scopeRequest(historical, historicalIdentity));
  assert.equal(historicalResult.status, 'failed');
  assert.equal(discrepancyIds(historicalResult).includes('merge-commit'), true);
});

test('symlink, gitlink, and type-change operations fail as security discrepancies', async (t) => {
  const linked = await createSymlinkRepo();
  t.after(() => linked.cleanup());
  const linkedIdentity = await identityOf(linked);
  const linkedResult = await verifyScopeV1(scopeRequest(linked, linkedIdentity));
  assert.equal(linkedResult.status, 'failed');
  assert.equal(discrepancyIds(linkedResult).includes('symlink-change'), true);

  const gitlink = await createGitlinkRepo();
  t.after(() => gitlink.cleanup());
  const gitlinkIdentity = await identityOf(gitlink);
  const gitlinkResult = await verifyScopeV1(scopeRequest(gitlink, gitlinkIdentity));
  assert.equal(gitlinkResult.status, 'failed');
  assert.equal(discrepancyIds(gitlinkResult).includes('submodule-change'), true);

  const typeChange = await createTypeChangeRepo();
  t.after(() => typeChange.cleanup());
  const typeIdentity = await identityOf(typeChange);
  const typeResult = await verifyScopeV1(scopeRequest(typeChange, typeIdentity));
  assert.equal(typeResult.status, 'failed');
  const typeIds = discrepancyIds(typeResult);
  assert.equal(typeIds.includes('type-change') || typeIds.includes('symlink-change'), true);
});

test('renames that escape the owned scope fail as a mismatch', async (t) => {
  const repo = await createRenameEscapingRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  assert.equal(result.status, 'failed');
  assert.equal(discrepancyIds(result).includes('scope-mismatch'), true);
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('escaped.txt'), false);
});

test('non-NFC and confusable separator paths fail closed without echoing bytes', async (t) => {
  const nfd = await createNonNfcRepo();
  t.after(() => nfd.cleanup());
  const nfdIdentity = await identityOf(nfd);
  const nfdError = await errorOf(() => verifyScopeV1(scopeRequest(nfd, nfdIdentity)));
  assert.equal(nfdError.code, 'hostile_name_denied');
  assertContentFree(nfdError, nfd.extra.path, '\u0301', 'cafe');

  const confusable = await createConfusableSeparatorRepo();
  t.after(() => confusable.cleanup());
  const confusableIdentity = await identityOf(confusable);
  const confusableError = await errorOf(
    () => verifyScopeV1(scopeRequest(confusable, confusableIdentity)),
  );
  assert.equal(confusableError.code, 'hostile_name_denied');
  assertContentFree(
    confusableError, confusable.extra.path, String.fromCodePoint(0x2215), 'look',
  );
});

test('untracked files outside the owned scope fail as a mismatch', async (t) => {
  const repo = await createUntrackedOutOfScopeRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity));
  assert.equal(result.status, 'failed');
  assert.equal(discrepancyIds(result).includes('scope-mismatch'), true);
  assert.equal(JSON.stringify(result).includes('scratch.txt'), false);
});

test('pre/post observation races fail closed', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  let statusCount = 0;
  const error = await errorOf(() => verifyScopeV1(scopeRequest(repo, identity), {
    spawn(command, args, options) {
      if (Array.isArray(args) && args.includes('status')) {
        statusCount += 1;
        if (statusCount === 2) {
          writeFileSync(`${repo.path}/src/raced.txt`, 'race\n');
        }
      }
      return nodeSpawn(command, args, options);
    },
  }));
  assert.equal(error.code, 'observation_race');
  assertContentFree(error, 'raced.txt', 'src/raced.txt');
});

test('output bounds kill hostile git writers without reflecting content', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  let calls = 0;
  const error = await errorOf(() => verifyScopeV1(scopeRequest(repo, identity), {
    spawn(command, args, options) {
      calls += 1;
      if (Array.isArray(args) && args.includes('diff-tree')) {
        return nodeSpawn('/usr/bin/yes', ['x'.repeat(64)], {
          cwd: '/',
          env: GIT_CLOSED_ENV,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
      return nodeSpawn(command, args, options);
    },
  }));
  assert.equal(error.code, 'bounds_exceeded');
  assert.equal(error.message.includes('x'.repeat(16)), false);
  assert.ok(MAX_SCOPE_OUTPUT_BYTES > 4096);
  assert.ok(calls > 0);
});

test('injected child stream accessors fail closed without native errors', async (t) => {
  const repo = await createOutOfScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const request = scopeRequest(repo, identity);
  function afterIdentity(hostileChild) {
    let calls = 0;
    return (command, args, options) => {
      calls += 1;
      if (calls < 8) return nodeSpawn(command, args, options);
      if (Array.isArray(args) && args.includes('diff-tree')) return hostileChild;
      return nodeSpawn(command, args, options);
    };
  }
  const accessorError = await errorOf(() => verifyScopeV1(request, {
    spawn: afterIdentity({
      stdout: {
        get on() { throw new Error('https://evil.example/steal?token=SECRET'); },
      },
      stderr: { on() { return this; } },
      kill() {},
      once() {},
    }),
  }));
  assert.ok(
    accessorError.code === 'git_execution_failed' || accessorError.code === 'proxy_denied'
      || accessorError.code === 'observation_race',
  );
  assertContentFree(accessorError, 'SECRET', 'evil.example', 'steal');
});

test('read-only untracked dirt is a mutation, not a silent pass', async (t) => {
  const repo = await createUntrackedOutOfScopeRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo, { assignment_id: READ_ONLY_ASSIGNMENT_ID });
  const result = await verifyScopeV1(scopeRequest(repo, identity, {
    assignment_id: READ_ONLY_ASSIGNMENT_ID,
    access: 'read_only',
    write_scope: [],
  }));
  assert.equal(result.status, 'failed');
  assert.equal(discrepancyIds(result).includes('read-only-mutation'), true);
});

test('other_write_scopes cannot alias this assignment or carry extra keys', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const self = await errorOf(() => parseScopeVerifierRequestV1(scopeRequest(repo, identity, {
    other_write_scopes: [{
      assignment_id: identity.facts[0].assignment_id,
      write_scope: ['docs/**'],
    }],
  })));
  assert.equal(self.code, 'conflicting_id');
  const extra = await errorOf(() => parseScopeVerifierRequestV1(scopeRequest(repo, identity, {
    other_write_scopes: [{
      assignment_id: OTHER_ASSIGNMENT_ID,
      write_scope: ['docs/**'],
      extra: true,
    }],
  })));
  assert.equal(extra.code, 'unknown_key');
});

test('closed protocol and config env is forced on every P15 git spawn', async (t) => {
  const repo = await createInScopeWriterRepo();
  t.after(() => repo.cleanup());
  const identity = await identityOf(repo);
  const result = await verifyScopeV1(scopeRequest(repo, identity), {
    spawn(command, args, options) {
      assert.equal(options.env, GIT_CLOSED_ENV);
      assert.equal(options.env.GIT_ALLOW_PROTOCOL, '');
      assert.equal(options.env.GIT_PROTOCOL_FROM_USER, '0');
      assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(options.env.GIT_CONFIG_SYSTEM, '/dev/null');
      assert.equal(Object.hasOwn(options.env, 'GIT_CONFIG'), false);
      return nodeSpawn(command, args, options);
    },
  });
  assert.equal(result.status, 'verified');
});
