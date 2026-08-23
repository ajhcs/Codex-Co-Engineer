// Neutral builders for aggregate pre-dispatch run-anchor tests.
// Tests own the assertions. These helpers never rank, default, or substitute.

import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IDENTITY_LABELS, runManifestDigestV1 } from '../../mcp/v3/identity.mjs';
import {
  AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
  AGGREGATE_SELECTION_REPLY_SCHEMA_ID,
} from '../../mcp/v3/aggregate-run-anchor.mjs';
import {
  buildGitIdentityV1,
  buildRunIdentityV1,
} from '../../mcp/v3/protected-identity.mjs';
import {
  resolveRunSelectionV1,
  selectionRequestIdentity,
} from '../../mcp/v3/resolver.mjs';
import { identityBoundDigest } from '../../mcp/v3/selection-json.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  REPOSITORY_PATH,
  RUN_ID,
} from './r1-protected-identity-fixtures.mjs';
import {
  resolveInputs,
  reviewer,
  runManifest,
  writer,
} from './r1-resolver-fixtures.mjs';

export {
  ASSIGNMENT_ID,
  BASE_SHA,
  REPOSITORY_PATH,
  RUN_ID,
};

export const AGGREGATE_RUN_ID = 'aggregate-run-under-test';

export async function makePrivateRoot(prefix = 'r1-r24a-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

export function makeIdentity({
  runId = AGGREGATE_RUN_ID,
  assignmentCount = 1,
  unresolved = false,
} = {}) {
  const assignments = [];
  for (let index = 0; index < assignmentCount; index += 1) {
    const assignmentId = assignmentCount === 1 ? ASSIGNMENT_ID : `lane-${index}`;
    if (unresolved) {
      assignments.push(reviewer(assignmentId, 'omitted'));
    } else {
      assignments.push(writer(assignmentId, [`src/${assignmentId}/**`], {
        provider: 'grok',
        model: 'grok-4',
      }));
    }
  }
  const manifest = runManifest(assignments, {
    run_id: runId,
    repository: { path: REPOSITORY_PATH, base_sha: BASE_SHA },
  });
  const manifestDigest = runManifestDigestV1(manifest).digest;
  const git = buildGitIdentityV1({
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
  });
  const identity = buildRunIdentityV1({
    run_id: runId,
    git,
    manifest_digest: manifestDigest,
  });
  return {
    run_id: runId,
    identity,
    git,
    manifest_digest: manifestDigest,
    assignment_count: assignmentCount,
    manifest,
  };
}

export function makeSubmitInput(options) {
  const built = makeIdentity(options);
  return {
    run_id: built.run_id,
    identity: built.identity,
    git: built.git,
    manifest_digest: built.manifest_digest,
  };
}

export function makeSelectionRequest(options = {}) {
  const built = makeIdentity({ unresolved: true, assignmentCount: 1, ...options });
  const plan = resolveRunSelectionV1(resolveInputs(built.manifest));
  const record = plan.selection_request;
  if (record === null || record === undefined) {
    throw new Error('fixture expected an unresolved SelectionRequestV1');
  }
  return {
    record,
    identity: selectionRequestIdentity(record),
    plan,
  };
}

export function makeReplyInput(runId, requestId, answers) {
  return {
    schema: AGGREGATE_SELECTION_REPLY_SCHEMA_ID,
    run_id: runId,
    request_id: requestId,
    answers,
  };
}

export function makeStoredReply(runId, requestId, answers) {
  const payload = makeReplyInput(runId, requestId, answers);
  return {
    ...payload,
    canonical_digest: identityBoundDigest(IDENTITY_LABELS.AGGREGATE_SELECTION_REPLY, payload),
  };
}

export function makePlanInput(runId, complete = true) {
  return {
    schema: AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
    run_id: runId,
    complete,
  };
}

export function makeStoredPlan(runId) {
  const payload = makePlanInput(runId, true);
  return {
    ...payload,
    canonical_digest: identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RESOLVED_PLAN, payload),
  };
}

export function defaultAnswers(assignmentCount = 1) {
  const answers = [];
  for (let index = 0; index < assignmentCount; index += 1) {
    answers.push({
      assignment_id: assignmentCount === 1 ? ASSIGNMENT_ID : `lane-${index}`,
      model: 'grok-4',
      provider: 'grok',
    });
  }
  return answers;
}
