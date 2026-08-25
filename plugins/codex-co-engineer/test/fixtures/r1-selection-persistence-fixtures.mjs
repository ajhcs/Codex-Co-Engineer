// Isolated P27 selection-persistence fixtures. Tests own the assertions.
// Helpers never rank, default, dispatch, or persist a second question batch.

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initializeAggregateRunAnchorRoot } from '../../mcp/v3/aggregate-run-anchor.mjs';
import { runManifestDigestV1 } from '../../mcp/v3/identity.mjs';
import { buildGitIdentityV1, buildRunIdentityV1 } from '../../mcp/v3/protected-identity.mjs';
import { resolveRunSelectionV1, selectionRequestIdentity } from '../../mcp/v3/resolver.mjs';
import {
  BASE_SHA,
  availabilitySnapshot,
  capabilitySnapshot,
  resolveInputs,
  reviewer,
  runManifest,
  writer,
} from './r1-resolver-fixtures.mjs';

export const P27_RUN_ID = 'p27-selection-run';
export const P27_REPOSITORY_PATH = '/repos/p27-selection';

export {
  BASE_SHA,
  availabilitySnapshot,
  capabilitySnapshot,
  resolveInputs,
  reviewer,
  runManifest,
  writer,
};

export async function makePrivateRoot(prefix = 'r1-p27-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

export function unresolvedAssignments(assignmentCount = 1) {
  const assignments = [];
  for (let index = 0; index < assignmentCount; index += 1) {
    assignments.push(reviewer(assignmentCount === 1 ? 'lane-0' : `lane-${index}`, 'omitted'));
  }
  return assignments;
}

export function completeAssignments(assignmentCount = 1) {
  const assignments = [];
  for (let index = 0; index < assignmentCount; index += 1) {
    const assignmentId = assignmentCount === 1 ? 'lane-0' : `lane-${index}`;
    assignments.push(writer(assignmentId, [`src/${assignmentId}/**`], {
      provider: 'grok',
      model: 'grok-4',
    }));
  }
  return assignments;
}

export function makeManifest({
  runId = P27_RUN_ID,
  assignmentCount = 1,
  unresolved = true,
  assignments = null,
} = {}) {
  return runManifest(
    assignments ?? (unresolved
      ? unresolvedAssignments(assignmentCount)
      : completeAssignments(assignmentCount)),
    {
      run_id: runId,
      repository: { path: P27_REPOSITORY_PATH, base_sha: BASE_SHA },
    },
  );
}

export function makeRunIdentity(manifest) {
  const git = buildGitIdentityV1({
    repository_path: manifest.repository.path,
    base_sha: manifest.repository.base_sha,
  });
  return buildRunIdentityV1({
    run_id: manifest.run_id,
    git,
    manifest_digest: runManifestDigestV1(manifest).digest,
  });
}

export function makePersistenceInputs({
  runId = P27_RUN_ID,
  assignmentCount = 1,
  unresolved = true,
  assignments = null,
  extra = {},
} = {}) {
  const manifest = makeManifest({ runId, assignmentCount, unresolved, assignments });
  const identity = makeRunIdentity(manifest);
  return {
    availability: availabilitySnapshot(),
    capabilities: capabilitySnapshot(),
    identity,
    manifest,
    ...extra,
  };
}

export function makeSubmitInput(inputs) {
  return {
    run_id: inputs.identity.run_id,
    identity: structuredClone(inputs.identity),
    git: structuredClone(inputs.identity.git),
    manifest_digest: inputs.identity.manifest_digest,
  };
}

export async function withSubmittedAnchor(fn, options = {}) {
  const inputs = makePersistenceInputs(options);
  const root = await makePrivateRoot();
  try {
    const anchor = await initializeAggregateRunAnchorRoot(root);
    await anchor.submit(makeSubmitInput(inputs));
    return await fn({ root, anchor, inputs });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function derivedRequest(inputs) {
  const plan = resolveRunSelectionV1({
    availability: inputs.availability,
    capabilities: inputs.capabilities,
    manifest: inputs.manifest,
    ...(inputs.profiles === undefined ? {} : { profiles: inputs.profiles }),
  });
  if (plan.selection_request === null || plan.selection_request === undefined) {
    throw new Error('fixture expected an outstanding SelectionRequestV1');
  }
  return {
    plan,
    request: plan.selection_request,
    identity: selectionRequestIdentity(plan.selection_request),
  };
}

export function completeAnswers(request, provider = 'grok', model = 'grok-4') {
  return request.questions.map((question) => {
    if (question.answer_scope === 'model_only') {
      return {
        assignment_id: question.assignment_id,
        model,
      };
    }
    return {
      assignment_id: question.assignment_id,
      model,
      provider,
    };
  });
}

export function structuredReply(request, answers = completeAnswers(request)) {
  return {
    run_id: request.run_id,
    request_id: request.request_id,
    digest: request.digest,
    answers,
  };
}

export function wrapAnchor(anchor, hooks = {}) {
  return {
    root: anchor.root,
    marker_digest: anchor.marker_digest,
    submit: (...args) => anchor.submit(...args),
    getByRunId: (...args) => anchor.getByRunId(...args),
    getCoordination: (...args) => {
      if (typeof hooks.getCoordination === 'function') return hooks.getCoordination(...args);
      return anchor.getCoordination(...args);
    },
    commitSelectionRequest: async (...args) => {
      if (typeof hooks.beforeCommitRequest === 'function') await hooks.beforeCommitRequest(...args);
      const result = await anchor.commitSelectionRequest(...args);
      if (typeof hooks.afterCommitRequest === 'function') await hooks.afterCommitRequest(result, ...args);
      return result;
    },
    commitSelectionResolution: async (...args) => {
      if (typeof hooks.beforeCommitResolution === 'function') {
        await hooks.beforeCommitResolution(...args);
      }
      const result = await anchor.commitSelectionResolution(...args);
      if (typeof hooks.afterCommitResolution === 'function') {
        await hooks.afterCommitResolution(result, ...args);
      }
      return result;
    },
    commitResolvedPlan: async () => {
      throw new Error('P27 must never call commitResolvedPlan');
    },
  };
}
