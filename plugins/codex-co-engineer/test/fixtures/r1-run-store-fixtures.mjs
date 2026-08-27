// Neutral builders for durable run-store tests. Tests own the assertions.

import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildChildIdentityV1,
  buildDispatchAttemptV1,
  buildProviderRunIdentityV1,
  buildRunIdentityV1,
  buildWorkspaceIdentityV1,
} from '../../mcp/v3/protected-identity.mjs';
import {
  buildDispatchProvenanceV1,
  projectDispatchTelemetryV1,
} from '../../mcp/v3/protected-telemetry.mjs';
import {
  ASSIGNMENT_ID,
  BRANCH_NAME,
  LOCK_ID,
  OPENED_AT,
  REPOSITORY_PATH,
  RUN_ID,
  WORKTREE_PATH,
  fixtureCapabilityDigest,
  fixtureEnvelopeDigest,
  fixtureGit,
  fixtureLaneDigest,
  fixtureManifestDigest,
} from './r1-protected-identity-fixtures.mjs';

export {
  ASSIGNMENT_ID,
  REPOSITORY_PATH,
  RUN_ID,
  fixtureGit,
};

export async function makePrivateRoot(prefix = 'r1-run-store-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

export function makeSubmission({
  runId = RUN_ID,
  assignmentId = ASSIGNMENT_ID,
  attempt = 1,
  counters = { dispatch_calls: 0, wake_events: 0, outcome_events: 0 },
  git = fixtureGit(),
} = {}) {
  const identity = buildRunIdentityV1({
    run_id: runId,
    git,
    manifest_digest: fixtureManifestDigest(),
  });
  const workspace = buildWorkspaceIdentityV1({
    run_id: runId,
    assignment_id: assignmentId,
    git,
    semantics: 'local_managed_worktree',
    starting_point: 'run_base_sha',
    worktree_path: WORKTREE_PATH,
    branch: BRANCH_NAME,
    lock_id: LOCK_ID,
    starting_ref: null,
  });
  const child = buildChildIdentityV1({ run_id: runId, assignment_id: assignmentId });
  const dispatch = buildDispatchAttemptV1({
    run_id: runId,
    assignment_id: assignmentId,
    attempt,
  });
  const providerRun = buildProviderRunIdentityV1({
    run_id: runId,
    assignment_id: assignmentId,
    attempt,
    provider: 'grok',
    model: 'grok-4',
    git,
    manifest_digest: fixtureManifestDigest(),
    prompt_envelope_digest: fixtureEnvelopeDigest(),
    resolved_lane_digest: fixtureLaneDigest(),
    capability_snapshot_digest: fixtureCapabilityDigest(),
    agent_id: null,
    provider_run_id: null,
  });
  const provenance = buildDispatchProvenanceV1({
    revision: 1,
    run: identity,
    child,
    git,
    workspace,
    dispatch,
    provider_run: providerRun,
    requested: { provider: 'grok', model: 'grok-4' },
    resolved: { provider: 'grok', model: 'grok-4', role: 'implement' },
    observed: { provider: null, model: null },
    observation: null,
    model_mismatch: 'served_model_not_observed',
    repository_exposure: 'selected_external_provider_full_repository',
    lineage: {
      manifest_digest: identity.manifest_digest,
      prompt_envelope_digest: providerRun.prompt_envelope_digest,
      resolved_lane_digest: providerRun.resolved_lane_digest,
      capability_snapshot_digest: providerRun.capability_snapshot_digest,
      git_digest: git.digest,
      workspace_digest: workspace.digest,
    },
    timing: {
      opened_at: OPENED_AT,
      dispatched_at: null,
      settled_at: null,
      dispatch_latency_ms: null,
      total_duration_ms: null,
    },
    counters,
    outcome: 'pending',
  });
  return {
    run_id: runId,
    request_idempotency_key: providerRun.request_idempotency_key,
    identity,
    git,
    provenance,
    telemetry: projectDispatchTelemetryV1(provenance),
  };
}
