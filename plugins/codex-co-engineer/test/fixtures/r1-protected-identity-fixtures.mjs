// Neutral builders for ProtectedIdentityV1 / ProtectedTelemetryV1 tests.
// Tests own the assertions. These helpers never rank, default, or substitute.

import { IDENTITY_LABELS, runManifestDigestV1 } from '../../mcp/v3/identity.mjs';
import {
  buildChildIdentityV1,
  buildDispatchAttemptV1,
  buildGitIdentityV1,
  buildProviderRunIdentityV1,
  buildRunIdentityV1,
  buildWorkspaceIdentityV1,
} from '../../mcp/v3/protected-identity.mjs';
import { identityBoundDigest } from '../../mcp/v3/selection-json.mjs';
import {
  BASE_SHA,
  capabilitySnapshot,
  runManifest,
  writer,
} from './r1-resolver-fixtures.mjs';
import { normalizeProviderCapabilitySnapshotV1 } from '../../mcp/v3/capability-bridge.mjs';

export { BASE_SHA };

export const RUN_ID = 'identity-under-test';
export const ASSIGNMENT_ID = 'backend-writer';
export const REPOSITORY_PATH = '/run-fixtures/repository';
export const WORKTREE_PATH = '/run-fixtures/worktrees/backend-writer';
export const BRANCH_NAME = 'codex-co-engineer/runs/identity-under-test/backend-writer';
export const LOCK_ID = 'lock-backend-writer-01';
export const OPENED_AT = '2026-08-22T12:00:00.000Z';
export const DISPATCHED_AT = '2026-08-22T12:00:01.000Z';
export const SETTLED_AT = '2026-08-22T12:00:05.000Z';

export function fixtureManifest() {
  return runManifest([
    writer(ASSIGNMENT_ID, ['src/**'], { provider: 'grok', model: 'grok-4' }),
  ], { run_id: RUN_ID, repository: { path: REPOSITORY_PATH, base_sha: BASE_SHA } });
}

export function fixtureManifestDigest() {
  return runManifestDigestV1(fixtureManifest()).digest;
}

export function fixtureCapabilityDigest() {
  return normalizeProviderCapabilitySnapshotV1(capabilitySnapshot()).digest;
}

export function fixtureLaneDigest() {
  return identityBoundDigest(IDENTITY_LABELS.RESOLVED_LANE_BINDING, {
    schema: 'codex-co-engineer.resolved-lane-binding.v1',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    provider: 'grok',
    model: 'grok-4',
    role: 'implement',
  });
}

export function fixtureEnvelopeDigest() {
  return identityBoundDigest(IDENTITY_LABELS.CHILD_ENVELOPE, {
    schema: 'codex-co-engineer.child-envelope.v1',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
  }).slice('sha256:'.length);
}

export function fixtureGit() {
  return buildGitIdentityV1({
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
  });
}

export function fixtureWorkspace(overrides = {}) {
  return buildWorkspaceIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    git: fixtureGit(),
    semantics: 'local_managed_worktree',
    starting_point: 'run_base_sha',
    worktree_path: WORKTREE_PATH,
    branch: BRANCH_NAME,
    lock_id: LOCK_ID,
    starting_ref: null,
    ...overrides,
  });
}

export function fixtureCloudWorkspace() {
  return buildWorkspaceIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    git: fixtureGit(),
    semantics: 'remote_provider_managed',
    starting_point: 'pinned_pushed_sha',
    worktree_path: null,
    branch: null,
    lock_id: null,
    starting_ref: BASE_SHA,
  });
}

export function fixtureRun() {
  return buildRunIdentityV1({
    run_id: RUN_ID,
    git: fixtureGit(),
    manifest_digest: fixtureManifestDigest(),
  });
}

export function fixtureChild() {
  return buildChildIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
  });
}

export function fixtureDispatch(attempt = 1) {
  return buildDispatchAttemptV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    attempt,
  });
}

export function fixtureProviderRun(overrides = {}) {
  return buildProviderRunIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    attempt: 1,
    provider: 'grok',
    model: 'grok-4',
    git: fixtureGit(),
    manifest_digest: fixtureManifestDigest(),
    prompt_envelope_digest: fixtureEnvelopeDigest(),
    resolved_lane_digest: fixtureLaneDigest(),
    capability_snapshot_digest: fixtureCapabilityDigest(),
    agent_id: null,
    provider_run_id: null,
    ...overrides,
  });
}

export function pendingProvenanceInput(overrides = {}) {
  const run = fixtureRun();
  const workspace = fixtureWorkspace();
  const providerRun = fixtureProviderRun();
  return {
    revision: 1,
    run,
    child: fixtureChild(),
    git: fixtureGit(),
    workspace,
    dispatch: fixtureDispatch(),
    provider_run: providerRun,
    requested: { provider: 'grok', model: 'grok-4' },
    resolved: { provider: 'grok', model: 'grok-4', role: 'implement' },
    observed: { provider: null, model: null },
    observation: null,
    model_mismatch: 'served_model_not_observed',
    repository_exposure: 'selected_external_provider_full_repository',
    lineage: {
      manifest_digest: run.manifest_digest,
      prompt_envelope_digest: providerRun.prompt_envelope_digest,
      resolved_lane_digest: providerRun.resolved_lane_digest,
      capability_snapshot_digest: providerRun.capability_snapshot_digest,
      git_digest: run.git.digest,
      workspace_digest: workspace.digest,
    },
    timing: {
      opened_at: OPENED_AT,
      dispatched_at: null,
      settled_at: null,
      dispatch_latency_ms: null,
      total_duration_ms: null,
    },
    counters: { dispatch_calls: 0, wake_events: 0, outcome_events: 0 },
    outcome: 'pending',
    ...overrides,
  };
}

export function succeededProvenanceInput(overrides = {}) {
  const providerRun = fixtureProviderRun({ agent_id: 'agent-grok-01' });
  return pendingProvenanceInput({
    provider_run: providerRun,
    observed: { provider: 'grok', model: 'grok-4' },
    observation: { source: 'transport_observation' },
    model_mismatch: 'none',
    timing: {
      opened_at: OPENED_AT,
      dispatched_at: DISPATCHED_AT,
      settled_at: SETTLED_AT,
      dispatch_latency_ms: 1000,
      total_duration_ms: 5000,
    },
    counters: { dispatch_calls: 1, wake_events: 1, outcome_events: 1 },
    outcome: 'succeeded',
    lineage: {
      manifest_digest: fixtureManifestDigest(),
      prompt_envelope_digest: providerRun.prompt_envelope_digest,
      resolved_lane_digest: providerRun.resolved_lane_digest,
      capability_snapshot_digest: providerRun.capability_snapshot_digest,
      git_digest: fixtureGit().digest,
      workspace_digest: fixtureWorkspace().digest,
    },
    ...overrides,
  });
}
