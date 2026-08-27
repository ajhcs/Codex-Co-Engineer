import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GIT_INSPECT_ENV,
  denyWorkerRemoteMutation,
} from '../mcp/v3/credential-boundary.mjs';
import { parseEvidenceDiscrepancyV1, parseVerifiedFactV1 } from '../mcp/v3/evidence-bundle.mjs';
import {
  DENIED_OPERATIONS,
  classifyGitOperationV1,
  expectedLaneRefV1,
} from '../mcp/v3/git-authority.mjs';
import {
  MAX_AUDIT_REFS,
  PROTECTED_REF_AUDIT_FAILING_CODES,
  PROTECTED_REF_AUDIT_FINDING_CODES,
  PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS,
  PROTECTED_REF_AUDIT_SCHEMA_ID,
  PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS,
  PROTECTED_REF_AUDIT_VERSION,
  auditProtectedRefsV1,
  describeProtectedRefAuditV1,
  parseProtectedRefAuditRequestV1,
} from '../mcp/v3/protected-ref-audit.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { CONTENT_FREE } from './fixtures/r1-git-authority-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  MAIN_REF,
  RUN_ID,
  createBareProtectedRepo,
  createLinkedWorktreeProtectedRepo,
  createLocalProtectedRepo,
  createMissingDefaultRepo,
  createMovedProtectedRepo,
  createPackedProtectedRepo,
  createRecordingSpawn,
  createSymbolicProtectedRepo,
  fixtureGitCommands,
  snapshotRepositoryIdentity,
  validIdentity,
  validRequest,
} from './fixtures/r1-protected-ref-audit-fixtures.mjs';

const LANE_DIGEST = 'ab'.repeat(32);

function errorOf(action) {
  return Promise.resolve()
    .then(() => action())
    .then(
      () => assert.fail('expected a typed RunContractV1Error'),
      (error) => {
        assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
        return error;
      },
    );
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false, 'must not leak repository paths');
  assert.equal(text.includes('https://'), false, 'must not leak URLs');
  assert.equal(text.includes('git@'), false, 'must not leak hosting URLs');
  for (const extra of extras) {
    assert.equal(text.includes(extra), false, `must not echo ${extra}`);
  }
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
}

function assertNoSideEffects(receipt) {
  for (const key of PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS) {
    assert.equal(receipt.side_effects[key], false, key);
  }
}

function assertInspectedEnv(records) {
  assert.ok(records.length >= 1);
  for (const record of records) {
    assert.equal(record.file, '/usr/bin/git');
    assert.equal(record.cwd, '/');
    assert.deepEqual(record.env, { ...GIT_INSPECT_ENV });
    assert.equal(Object.hasOwn(record.env, 'GIT_DIR'), false);
    assert.equal(Object.hasOwn(record.env, 'GH_TOKEN'), false);
    assert.equal(Object.hasOwn(record.env, 'SSH_AUTH_SOCK'), false);
    assert.equal(record.env.GIT_ASKPASS, '');
    assert.equal(record.env.GIT_TERMINAL_PROMPT, '0');
  }
  for (const command of fixtureGitCommands(records)) {
    assert.equal(
      PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS.includes(command),
      true,
      command,
    );
  }
}

test('ProtectedRefAuditV1 is a closed frozen v1 audit and not a 4.0.0 major', () => {
  assert.equal(PROTECTED_REF_AUDIT_SCHEMA_ID, 'codex-co-engineer.protected-ref-audit.v1');
  assert.equal(PROTECTED_REF_AUDIT_VERSION, 1);
  assert.equal(PROTECTED_REF_AUDIT_SCHEMA_ID.includes('4.0.0'), false);
  const inventory = describeProtectedRefAuditV1();
  assert.ok(Object.isFrozen(inventory));
  assert.equal(inventory.rule, 'read_only_live_protected_ref_compare');
  assert.equal(inventory.max_audit_refs, MAX_AUDIT_REFS);
  assert.equal(inventory.composed_surfaces.remote_mutation, 'denied');
  assert.equal(inventory.inspect_env, GIT_INSPECT_ENV);
  assert.deepEqual([...inventory.finding_codes], [...PROTECTED_REF_AUDIT_FINDING_CODES]);
  assert.deepEqual([...inventory.failing_codes], [...PROTECTED_REF_AUDIT_FAILING_CODES]);
});

test('matching local protected and default refs verify with content-free evidence', async () => {
  const repo = await createLocalProtectedRepo();
  const recording = createRecordingSpawn();
  try {
    const before = await snapshotRepositoryIdentity(repo.path);
    const receipt = await auditProtectedRefsV1(
      validRequest(repo.path, repo.baseSha, {
        expected_refs: [
          { ref: MAIN_REF, sha: repo.baseSha },
          { ref: 'refs/tags/v1', sha: repo.tagSha },
        ],
      }),
      { spawn: recording.spawn },
    );
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.repository_kind, 'local');
    assert.equal(receipt.run_id, RUN_ID);
    assert.equal(receipt.assignment_id, ASSIGNMENT_ID);
    assert.equal(receipt.comparisons.length, 2);
    assert.equal(receipt.comparisons[0].outcome, 'match');
    assert.equal(receipt.comparisons[0].default_branch_target, true);
    assert.equal(receipt.comparisons[1].ref_class, 'user_protected');
    assert.equal(receipt.findings.length, 0);
    const fact = parseVerifiedFactV1(receipt.facts[0]);
    assert.equal(fact.method, 'protected_ref_snapshot_compare');
    assert.equal(fact.authority, 'platform_git');
    assert.equal(fact.status, 'verified');
    assert.equal(receipt.discrepancies.length, 0);
    assertNoSideEffects(receipt);
    assertContentFree(receipt, [repo.path, 'https://', 'git@']);
    assertInspectedEnv(recording.records);
    const after = await snapshotRepositoryIdentity(repo.path);
    assert.deepEqual(after, before);
  } finally {
    await repo.cleanup();
  }
});

test('packed protected refs still match expected identities', async () => {
  const repo = await createPackedProtectedRepo();
  try {
    const before = await snapshotRepositoryIdentity(repo.path);
    const receipt = await auditProtectedRefsV1(validRequest(repo.path, repo.baseSha));
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.comparisons[0].storage, 'packed');
    assert.equal(receipt.observed_classes.includes('packed_ref'), true);
    assert.equal(receipt.observation.packed_count, 1);
    assertNoSideEffects(receipt);
    const after = await snapshotRepositoryIdentity(repo.path);
    assert.deepEqual(after, before);
  } finally {
    await repo.cleanup();
  }
});

test('bare repositories compare declared protected refs without mutation', async () => {
  const repo = await createBareProtectedRepo();
  try {
    const before = await snapshotRepositoryIdentity(repo.path);
    const receipt = await auditProtectedRefsV1(validRequest(repo.path, repo.baseSha));
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.repository_kind, 'bare');
    assertNoSideEffects(receipt);
    const after = await snapshotRepositoryIdentity(repo.path);
    assert.deepEqual(after, before);
  } finally {
    await repo.cleanup();
  }
});

test('linked worktrees audit shared protected refs through the worktree path', async () => {
  const repo = await createLinkedWorktreeProtectedRepo();
  try {
    const beforeRoot = await snapshotRepositoryIdentity(repo.path);
    const beforeWt = await snapshotRepositoryIdentity(repo.worktreePath);
    const receipt = await auditProtectedRefsV1(validRequest(repo.worktreePath, repo.baseSha));
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.repository_kind, 'linked_worktree');
    assertContentFree(receipt, [repo.path, repo.worktreePath]);
    const afterRoot = await snapshotRepositoryIdentity(repo.path);
    const afterWt = await snapshotRepositoryIdentity(repo.worktreePath);
    assert.deepEqual(afterRoot, beforeRoot);
    assert.deepEqual(afterWt, beforeWt);
  } finally {
    await repo.cleanup();
  }
});

test('missing and moved protected refs fail closed with deterministic findings', async () => {
  const missingRepo = await createMissingDefaultRepo();
  try {
    const before = await snapshotRepositoryIdentity(missingRepo.path);
    const missing = await auditProtectedRefsV1(validRequest(missingRepo.path, missingRepo.baseSha, {
      expected_refs: [{ ref: 'refs/heads/master', sha: missingRepo.baseSha }],
    }));
    assert.equal(missing.status, 'failed');
    assert.equal(missing.findings[0].code, 'missing_ref');
    assert.equal(missing.observed_classes.includes('missing_ref'), true);
    parseEvidenceDiscrepancyV1(missing.discrepancies[0]);
    assert.equal(missing.discrepancies[0].discrepancy_kind, 'security');
    assertContentFree(missing, [missingRepo.path, 'refs/heads/master']);
    const after = await snapshotRepositoryIdentity(missingRepo.path);
    assert.deepEqual(after, before);
  } finally {
    await missingRepo.cleanup();
  }

  const movedRepo = await createMovedProtectedRepo();
  try {
    const before = await snapshotRepositoryIdentity(movedRepo.path);
    const moved = await auditProtectedRefsV1(validRequest(movedRepo.path, movedRepo.baseSha));
    assert.equal(moved.status, 'failed');
    assert.equal(moved.findings[0].code, 'moved_ref');
    assert.equal(moved.facts[0].status, 'failed');
    assertContentFree(moved, [movedRepo.path]);
    const after = await snapshotRepositoryIdentity(movedRepo.path);
    assert.deepEqual(after, before);
  } finally {
    await movedRepo.cleanup();
  }
});

test('symbolic protected refs fail closed without rewriting refs', async () => {
  const repo = await createSymbolicProtectedRepo();
  try {
    const before = await snapshotRepositoryIdentity(repo.path);
    const receipt = await auditProtectedRefsV1(validRequest(repo.path, repo.baseSha, {
      expected_refs: [{ ref: repo.aliasRef, sha: repo.baseSha }],
      default_branch: 'release',
    }));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.findings[0].code, 'symbolic_ref');
    assert.equal(receipt.comparisons[0].storage, 'symbolic');
    assert.equal(receipt.discrepancies[0].discrepancy_kind, 'security');
    assertContentFree(receipt, [repo.path, 'release']);
    const after = await snapshotRepositoryIdentity(repo.path);
    assert.deepEqual(after, before);
  } finally {
    await repo.cleanup();
  }
});

test('worker-lane refs are not protected-audit targets', async () => {
  const repo = await createLocalProtectedRepo();
  try {
    const lane = expectedLaneRefV1({
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
      manifest_digest_hex: LANE_DIGEST,
    });
    const error = await errorOf(() => auditProtectedRefsV1(validRequest(repo.path, repo.baseSha, {
      expected_refs: [{ ref: lane, sha: repo.baseSha }],
      identity: validIdentity(repo.path, repo.baseSha),
      manifest_digest_hex: LANE_DIGEST,
    })));
    assert.equal(error.code, 'expected_ref_not_protected');
    assertContentFree(error, [lane, repo.path]);
  } finally {
    await repo.cleanup();
  }
});

test('parse rejects empty or oversized expected-ref lists before any git spawn', async () => {
  const repo = await createLocalProtectedRepo();
  const recording = createRecordingSpawn();
  try {
    const empty = await errorOf(() => parseProtectedRefAuditRequestV1(validRequest(
      repo.path, repo.baseSha, { expected_refs: [] },
    )));
    assert.equal(empty.code, 'out_of_range');
    const oversized = [];
    for (let i = 0; i < MAX_AUDIT_REFS + 1; i += 1) {
      oversized.push({ ref: `refs/heads/extra${i}`, sha: repo.baseSha });
    }
    const many = await errorOf(() => auditProtectedRefsV1(
      validRequest(repo.path, repo.baseSha, { expected_refs: oversized }),
      { spawn: recording.spawn },
    ));
    assert.equal(many.code, 'out_of_range');
    assert.equal(recording.records.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test('accepted P28 and P29 mutation denials remain closed through the audit', () => {
  for (const operation of DENIED_OPERATIONS) {
    const verdict = classifyGitOperationV1({
      schema: 'codex-co-engineer.git-authority.v1',
      version: 1,
      actor: 'worker',
      operation,
      identity: validIdentity('/tmp/cce-r1-authority-repo', 'a'.repeat(40)),
    });
    assert.equal(verdict.verdict, 'denied', operation);
    assert.throws(() => denyWorkerRemoteMutation(operation));
  }
});
