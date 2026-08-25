import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  GIT_INSPECT_ENV,
  denyWorkerRemoteMutation,
} from '../mcp/v3/credential-boundary.mjs';
import { DENIED_OPERATIONS } from '../mcp/v3/git-authority.mjs';
import {
  MAX_AUDIT_REFS,
  PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS,
  auditProtectedRefsV1,
  parseProtectedRefAuditRequestV1,
} from '../mcp/v3/protected-ref-audit.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { CONTENT_FREE } from './fixtures/r1-git-authority-fixtures.mjs';
import {
  MAIN_REF,
  countingProxy,
  createAliasedLooseProtectedRepo,
  createGraftsProtectedRepo,
  createLocalProtectedRepo,
  createRecordingSpawn,
  createReplaceProtectedRepo,
  createSymlinkAliasPathRepo,
  fixtureGitCommands,
  git,
  snapshotRepositoryIdentity,
  trapTotal,
  validIdentity,
  validRequest,
} from './fixtures/r1-protected-ref-audit-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(() => action())
    .then(
      () => assert.fail('expected a typed RunContractV1Error'),
      (error) => {
        assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
        assert.equal(utilTypes.isProxy(error), false);
        return error;
      },
    );
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false);
  assert.equal(text.includes('https://'), false);
  assert.equal(text.includes('git@'), false);
  for (const extra of extras) {
    assert.equal(text.includes(extra), false, `leaked ${JSON.stringify(extra)}`);
  }
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
}

test('parent-failing hostile policy probes deny namespace escape without echoing attacker bytes', async () => {
  const repo = await createLocalProtectedRepo();
  try {
    const probes = [
      'refs/heads/codex/run-abababababababab/../main',
      'refs/heads/main.lock',
      'refs/heads/foo@{bar}',
      'refs/heads/\uFF4D\uFF41\uFF49\uFF4E',
      'refs/heads/\u0430lpha',
      'HEAD',
      'main',
      '-C',
      'refs/heads/main\0evil',
    ];
    for (const ref of probes) {
      const error = await errorOf(() => parseProtectedRefAuditRequestV1(validRequest(
        repo.path, repo.baseSha, { expected_refs: [{ ref, sha: repo.baseSha }] },
      )));
      assert.ok(
        error.code === 'hostile_name_denied' || error.code === 'invalid_type'
          || error.code === 'invalid_format' || error.code === 'authority_identity_invalid',
        `${ref} -> ${error.code}`,
      );
      assertContentFree(error, [ref, repo.path, '/tmp']);
    }
  } finally {
    await repo.cleanup();
  }
});

test('proxy accessor symbol unknown-key and exotic inputs fail closed before git', async () => {
  const repo = await createLocalProtectedRepo();
  const recording = createRecordingSpawn();
  try {
    const base = validRequest(repo.path, repo.baseSha);
    const { proxy, counts } = countingProxy(base);
    const proxied = await errorOf(() => auditProtectedRefsV1(proxy, { spawn: recording.spawn }));
    assert.equal(proxied.code, 'proxy_denied');
    assert.equal(trapTotal(counts) > 0 || proxied.code === 'proxy_denied', true);

    const symbolled = { ...base, [Symbol('steal')]: 'secret' };
    const symbolError = await errorOf(() => auditProtectedRefsV1(symbolled, { spawn: recording.spawn }));
    assert.equal(symbolError.code, 'symbol_key_denied');

    const accessor = {};
    for (const [key, value] of Object.entries(base)) {
      Object.defineProperty(accessor, key, { enumerable: true, get() { return value; } });
    }
    const accessError = await errorOf(() => auditProtectedRefsV1(accessor, { spawn: recording.spawn }));
    assert.ok(
      accessError.code === 'accessor_property_denied' || accessError.code === 'own_undefined_denied'
        || accessError.code === 'invalid_type',
    );

    const unknown = { ...base, push_url: 'https://evil.example/x' };
    const unknownError = await errorOf(() => auditProtectedRefsV1(unknown, { spawn: recording.spawn }));
    assert.equal(unknownError.code, 'unknown_key');
    assertContentFree(unknownError, ['https://evil.example/x', 'push_url']);

    const exotic = Object.assign(Object.create({ stolen: true }), base);
    const exoticError = await errorOf(() => auditProtectedRefsV1(exotic, { spawn: recording.spawn }));
    assert.ok(
      exoticError.code === 'exotic_prototype_denied' || exoticError.code === 'invalid_type',
    );

    const spawnProxy = await errorOf(() => auditProtectedRefsV1(base, {
      spawn: countingProxy(() => {}).proxy,
    }));
    assert.equal(spawnProxy.code, 'proxy_denied');
    assert.equal(recording.records.length, 0);
    assertContentFree(proxied);
    assertContentFree(symbolError);
    assertContentFree(unknownError);
  } finally {
    await repo.cleanup();
  }
});

test('mutation operations and credential material never spawn git', async () => {
  const repo = await createLocalProtectedRepo();
  const recording = createRecordingSpawn();
  try {
    for (const operation of DENIED_OPERATIONS) {
      const error = await errorOf(() => auditProtectedRefsV1(
        validRequest(repo.path, repo.baseSha, { operation }),
        { spawn: recording.spawn },
      ));
      assert.equal(error.code, 'remote_mutation_denied', operation);
      assertContentFree(error, [operation, repo.path]);
      assert.throws(() => denyWorkerRemoteMutation(operation));
    }
    const commit = await errorOf(() => auditProtectedRefsV1(
      validRequest(repo.path, repo.baseSha, { operation: 'commit_on_lane_branch' }),
      { spawn: recording.spawn },
    ));
    assert.equal(commit.code, 'audit_operation_denied');
    const credential = await errorOf(() => parseProtectedRefAuditRequestV1(validRequest(
      repo.path, repo.baseSha, {
        identity: {
          ...validIdentity(repo.path, repo.baseSha),
          token: 'secret-token',
        },
      },
    )));
    assert.ok(credential.code === 'unknown_key' || credential.code === 'credential_content_denied');
    assertContentFree(credential, ['secret-token']);
    assert.equal(recording.records.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test('aliased loose refs, replace refs, grafts, and symlink paths fail closed', async () => {
  const aliased = await createAliasedLooseProtectedRepo();
  try {
    const before = await snapshotRepositoryIdentity(aliased.path);
    const receipt = await auditProtectedRefsV1(validRequest(aliased.path, aliased.baseSha));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.findings[0].code, 'aliased_ref');
    assertContentFree(receipt, [aliased.path]);
    const after = await snapshotRepositoryIdentity(aliased.path);
    assert.deepEqual(after, before);
  } finally {
    await aliased.cleanup();
  }

  const replaced = await createReplaceProtectedRepo();
  try {
    const error = await errorOf(() => auditProtectedRefsV1(validRequest(replaced.path, replaced.baseSha)));
    assert.equal(error.code, 'replace_refs_denied');
    assertContentFree(error, [replaced.path, replaced.baseSha]);
  } finally {
    await replaced.cleanup();
  }

  const grafted = await createGraftsProtectedRepo();
  try {
    const error = await errorOf(() => auditProtectedRefsV1(validRequest(grafted.path, grafted.baseSha)));
    assert.equal(error.code, 'grafts_denied');
    assertContentFree(error, [grafted.path]);
  } finally {
    await grafted.cleanup();
  }

  const linked = await createSymlinkAliasPathRepo();
  try {
    const error = await errorOf(() => auditProtectedRefsV1(validRequest(linked.aliasPath, linked.baseSha)));
    assert.ok(error.code === 'repository_invalid' || error.code === 'authority_identity_invalid');
    assertContentFree(error, [linked.aliasPath, linked.path]);
  } finally {
    await linked.cleanup();
  }
});

test('duplicate aliased expected-ref objects and overlong lists fail closed', async () => {
  const repo = await createLocalProtectedRepo();
  try {
    const entry = { ref: MAIN_REF, sha: repo.baseSha };
    const aliased = await errorOf(() => parseProtectedRefAuditRequestV1(validRequest(
      repo.path, repo.baseSha, { expected_refs: [entry, entry] },
    )));
    assert.equal(aliased.code, 'aliased_reference_denied');
    const duplicateName = await errorOf(() => parseProtectedRefAuditRequestV1(validRequest(
      repo.path, repo.baseSha, {
        expected_refs: [
          { ref: MAIN_REF, sha: repo.baseSha },
          { ref: MAIN_REF, sha: repo.baseSha },
        ],
      },
    )));
    assert.equal(duplicateName.code, 'invalid_format');
    const tooMany = [];
    for (let i = 0; i < MAX_AUDIT_REFS + 1; i += 1) {
      tooMany.push({ ref: `refs/tags/t${i}`, sha: repo.baseSha });
    }
    const range = await errorOf(() => parseProtectedRefAuditRequestV1(validRequest(
      repo.path, repo.baseSha, { expected_refs: tooMany },
    )));
    assert.equal(range.code, 'out_of_range');
    assertContentFree(aliased);
    assertContentFree(duplicateName);
  } finally {
    await repo.cleanup();
  }
});

test('live race between snapshots fails closed and the audit argv stays read-only', async () => {
  const repo = await createLocalProtectedRepo();
  try {
    const movedSha = git(repo.path, ['commit', '--allow-empty', '-m', 'race-side']);
    git(repo.path, ['update-ref', MAIN_REF, repo.baseSha]);
    const recording = createRecordingSpawn(() => {
      writeFileSync(path.join(repo.path, '.git', 'refs', 'heads', 'main'), `${movedSha}\n`);
    });
    const receipt = await auditProtectedRefsV1(
      validRequest(repo.path, repo.baseSha),
      { spawn: recording.spawn },
    );
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.observed_classes.includes('race_detected'), true);
    assert.equal(receipt.discrepancies[0].discrepancy_kind, 'security');
    assertContentFree(receipt, [repo.path, movedSha]);
    for (const command of fixtureGitCommands(recording.records)) {
      assert.equal(PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS.includes(command), true, command);
    }
    for (const record of recording.records) {
      assert.deepEqual(record.env, { ...GIT_INSPECT_ENV });
      assert.equal(record.args.includes('update-ref'), false);
      assert.equal(record.args.includes('commit'), false);
      assert.equal(record.args.includes('push'), false);
    }
  } finally {
    await repo.cleanup();
  }
});

test('two concurrent read-only audits leave a stable repository byte-identical', async () => {
  const repo = await createLocalProtectedRepo();
  try {
    const before = await snapshotRepositoryIdentity(repo.path);
    const request = validRequest(repo.path, repo.baseSha);
    const [left, right] = await Promise.all([
      auditProtectedRefsV1(request),
      auditProtectedRefsV1({ ...request, expected_refs: [{ ref: MAIN_REF, sha: repo.baseSha }] }),
    ]);
    assert.equal(left.status, 'verified');
    assert.equal(right.status, 'verified');
    const after = await snapshotRepositoryIdentity(repo.path);
    assert.deepEqual(after, before);
  } finally {
    await repo.cleanup();
  }
});
