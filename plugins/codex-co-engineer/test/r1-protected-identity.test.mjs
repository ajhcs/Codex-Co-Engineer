import assert from 'node:assert/strict';
import test from 'node:test';

import { IDENTITY_LABELS, runManifestDigestV1 } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  GIT_IDENTITY_SCHEMA_ID,
  WORKSPACE_IDENTITY_SCHEMA_ID,
  RUN_IDENTITY_SCHEMA_ID,
  CHILD_IDENTITY_SCHEMA_ID,
  DISPATCH_ATTEMPT_SCHEMA_ID,
  PROVIDER_RUN_IDENTITY_SCHEMA_ID,
  assertSharedGitIdentityV1,
  buildChildIdentityV1,
  buildDispatchAttemptV1,
  buildGitIdentityV1,
  buildProviderRunIdentityV1,
  buildRunIdentityV1,
  buildWorkspaceIdentityV1,
  deriveRequestIdempotencyKeyV1,
  validateChildIdentityV1,
  validateGitIdentityV1,
  validateProviderRunIdentityV1,
  validateRunIdentityV1,
  validateWorkspaceIdentityV1,
} from '../mcp/v3/protected-identity.mjs';
import { identityBoundDigest } from '../mcp/v3/selection-json.mjs';
import { resolveRunSelectionV1 } from '../mcp/v3/resolver.mjs';
import { normalizeProviderCapabilitySnapshotV1 } from '../mcp/v3/capability-bridge.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  REPOSITORY_PATH,
  RUN_ID,
  fixtureCapabilityDigest,
  fixtureChild,
  fixtureDispatch,
  fixtureEnvelopeDigest,
  fixtureGit,
  fixtureLaneDigest,
  fixtureManifest,
  fixtureManifestDigest,
  fixtureProviderRun,
  fixtureRun,
  fixtureWorkspace,
  fixtureCloudWorkspace,
} from './fixtures/r1-protected-identity-fixtures.mjs';
import {
  capabilitySnapshot,
  resolveInputs,
} from './fixtures/r1-resolver-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertFrozenTree(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') assertFrozenTree(child);
    }
  }
}

test('Git identity is immutable repository/base identity with a P03 workspace-anchor digest', () => {
  const git = fixtureGit();
  assert.equal(git.schema, GIT_IDENTITY_SCHEMA_ID);
  assert.equal(git.repository_path, REPOSITORY_PATH);
  assert.equal(git.base_sha, BASE_SHA);
  assert.match(git.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(git.digest, identityBoundDigest(IDENTITY_LABELS.WORKSPACE_ANCHOR, {
    schema: GIT_IDENTITY_SCHEMA_ID,
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
  }));
  assertFrozenTree(git);
  const again = buildGitIdentityV1({
    base_sha: BASE_SHA,
    repository_path: REPOSITORY_PATH,
  });
  assert.equal(again.digest, git.digest);
  assert.equal(validateGitIdentityV1(git).digest, git.digest);
});

test('assignments share one Git identity and a different base SHA is a different identity', () => {
  const left = buildGitIdentityV1({ repository_path: REPOSITORY_PATH, base_sha: BASE_SHA });
  const right = buildGitIdentityV1({ repository_path: REPOSITORY_PATH, base_sha: BASE_SHA });
  assert.equal(assertSharedGitIdentityV1(left, right).digest, left.digest);
  const drifted = buildGitIdentityV1({
    repository_path: REPOSITORY_PATH,
    base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.notEqual(drifted.digest, left.digest);
  assert.equal(errorOf(() => assertSharedGitIdentityV1(left, drifted)).code, 'identity_mismatch');
});

test('workspace identity binds a managed local worktree and rejects direct-mode shapes', () => {
  const workspace = fixtureWorkspace();
  assert.equal(workspace.schema, WORKSPACE_IDENTITY_SCHEMA_ID);
  assert.equal(workspace.git.digest, fixtureGit().digest);
  assert.equal(workspace.semantics, 'local_managed_worktree');
  assert.equal(workspace.starting_ref, null);
  assert.match(workspace.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(workspace.digest, identityBoundDigest(IDENTITY_LABELS.WORKSPACE_IDENTITY, {
    schema: WORKSPACE_IDENTITY_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    git: fixtureGit(),
    semantics: 'local_managed_worktree',
    starting_point: 'run_base_sha',
    worktree_path: workspace.worktree_path,
    branch: workspace.branch,
    lock_id: workspace.lock_id,
    starting_ref: null,
  }));
  assertFrozenTree(workspace);
  assert.equal(
    errorOf(() => buildWorkspaceIdentityV1({
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
      git: fixtureGit(),
      semantics: 'local_managed_worktree',
      starting_point: 'run_base_sha',
      worktree_path: REPOSITORY_PATH,
      branch: workspace.branch,
      lock_id: workspace.lock_id,
      starting_ref: null,
    })).code,
    'direct_mode_rejected',
  );
});

test('Cloud workspace pins the immutable base SHA and carries no local worktree', () => {
  const cloud = fixtureCloudWorkspace();
  assert.equal(cloud.semantics, 'remote_provider_managed');
  assert.equal(cloud.starting_point, 'pinned_pushed_sha');
  assert.equal(cloud.starting_ref, BASE_SHA);
  assert.equal(cloud.worktree_path, null);
  assert.equal(cloud.branch, null);
  assert.equal(cloud.lock_id, null);
  assert.equal(
    errorOf(() => buildWorkspaceIdentityV1({
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
      git: fixtureGit(),
      semantics: 'remote_provider_managed',
      starting_point: 'pinned_pushed_sha',
      worktree_path: null,
      branch: null,
      lock_id: null,
      starting_ref: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })).code,
    'identity_mismatch',
  );
  assert.equal(
    errorOf(() => buildWorkspaceIdentityV1({
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
      git: fixtureGit(),
      semantics: 'local_managed_worktree',
      starting_point: 'run_base_sha',
      worktree_path: '/run-fixtures/worktrees/backend-writer',
      branch: 'codex-co-engineer/runs/identity-under-test/backend-writer',
      lock_id: 'lock-backend-writer-01',
      starting_ref: BASE_SHA,
    })).code,
    'starting_ref_forbidden_local',
  );
});

test('run and child identities bind P03 manifest digest and P03 identity labels', () => {
  const manifestDigest = fixtureManifestDigest();
  assert.equal(manifestDigest, runManifestDigestV1(fixtureManifest()).digest);
  assert.match(manifestDigest, /^[0-9a-f]{64}$/u);
  const run = fixtureRun();
  assert.equal(run.schema, RUN_IDENTITY_SCHEMA_ID);
  assert.equal(run.manifest_digest, manifestDigest);
  assert.equal(run.git.digest, fixtureGit().digest);
  assert.equal(run.digest, identityBoundDigest(IDENTITY_LABELS.RUN_IDENTITY, {
    schema: RUN_IDENTITY_SCHEMA_ID,
    run_id: RUN_ID,
    git: fixtureGit(),
    manifest_digest: manifestDigest,
  }));
  const child = fixtureChild();
  assert.equal(child.schema, CHILD_IDENTITY_SCHEMA_ID);
  assert.equal(child.digest, identityBoundDigest(IDENTITY_LABELS.CHILD_IDENTITY, {
    schema: CHILD_IDENTITY_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
  }));
  assert.equal(validateRunIdentityV1(run).digest, run.digest);
  assert.equal(validateChildIdentityV1(child).digest, child.digest);
  assertFrozenTree(run);
  assertFrozenTree(child);
});

test('provider-run identity binds the full request tuple and P05 capability digest', () => {
  const capabilities = normalizeProviderCapabilitySnapshotV1(capabilitySnapshot());
  const providerRun = fixtureProviderRun();
  assert.equal(providerRun.schema, PROVIDER_RUN_IDENTITY_SCHEMA_ID);
  assert.equal(providerRun.capability_snapshot_digest, capabilities.digest);
  assert.equal(providerRun.capability_snapshot_digest, fixtureCapabilityDigest());
  assert.match(providerRun.capability_snapshot_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(providerRun.resolved_lane_digest, fixtureLaneDigest());
  assert.match(providerRun.request_idempotency_key, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(providerRun.agent_id, null);
  assert.equal(Object.hasOwn(providerRun, 'driver'), false);
  assert.equal(validateProviderRunIdentityV1(providerRun).digest, providerRun.digest);
  const mutatedKey = { ...providerRun, request_idempotency_key: `${providerRun.request_idempotency_key.slice(0, -1)}0` };
  assert.equal(errorOf(() => validateProviderRunIdentityV1(mutatedKey)).code, 'identity_mismatch');
});

test('request idempotency is attempt-bound and distinct from P05 selection identity', () => {
  const first = fixtureProviderRun({ attempt: 1 });
  const second = fixtureProviderRun({ attempt: 2 });
  assert.notEqual(first.request_idempotency_key, second.request_idempotency_key);
  const resolved = resolveRunSelectionV1(resolveInputs(fixtureManifest()));
  assert.notEqual(first.request_idempotency_key, resolved.capability_snapshot_digest);
  if (resolved.selection_request) {
    assert.notEqual(first.request_idempotency_key, resolved.selection_request.digest);
  }
  const rebuilt = deriveRequestIdempotencyKeyV1({
    schema: 'codex-co-engineer.dispatch-request.v1',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    attempt: 1,
    provider: 'grok',
    model: 'grok-4',
    git_digest: fixtureGit().digest,
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
    manifest_digest: fixtureManifestDigest(),
    prompt_envelope_digest: fixtureEnvelopeDigest(),
    resolved_lane_digest: fixtureLaneDigest(),
    capability_snapshot_digest: fixtureCapabilityDigest(),
  });
  assert.equal(rebuilt, first.request_idempotency_key);
});

test('caller-supplied schema, digest, and driver keys fail closed', () => {
  assert.equal(errorOf(() => buildGitIdentityV1({
    schema: GIT_IDENTITY_SCHEMA_ID,
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
  })).code, 'unknown_key');
  assert.equal(errorOf(() => buildRunIdentityV1({
    run_id: RUN_ID,
    git: fixtureGit(),
    manifest_digest: fixtureManifestDigest(),
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })).code, 'unknown_key');
  assert.equal(errorOf(() => buildProviderRunIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    attempt: 1,
    provider: 'grok',
    model: 'grok-4',
    driver: 'acp',
    git: fixtureGit(),
    manifest_digest: fixtureManifestDigest(),
    prompt_envelope_digest: fixtureEnvelopeDigest(),
    resolved_lane_digest: fixtureLaneDigest(),
    capability_snapshot_digest: fixtureCapabilityDigest(),
  })).code, 'unknown_key');
});

test('built identities detach from caller mutation', () => {
  const input = { repository_path: REPOSITORY_PATH, base_sha: BASE_SHA };
  const git = buildGitIdentityV1(input);
  input.base_sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(git.base_sha, BASE_SHA);
  assert.equal(validateGitIdentityV1(git).base_sha, BASE_SHA);
});

test('dispatch attempt is bounded and labeled through the P03 registry', () => {
  const dispatch = fixtureDispatch(1);
  assert.equal(dispatch.schema, DISPATCH_ATTEMPT_SCHEMA_ID);
  assert.equal(dispatch.digest, identityBoundDigest(IDENTITY_LABELS.DISPATCH_ATTEMPT, {
    schema: DISPATCH_ATTEMPT_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    attempt: 1,
  }));
  assert.equal(errorOf(() => buildDispatchAttemptV1({
    run_id: RUN_ID, assignment_id: ASSIGNMENT_ID, attempt: 0,
  })).code, 'out_of_range');
  assert.equal(errorOf(() => buildDispatchAttemptV1({
    run_id: RUN_ID, assignment_id: ASSIGNMENT_ID, attempt: 5,
  })).code, 'out_of_range');
});
