import assert from 'node:assert/strict';
import test from 'node:test';

import { openArtifactStoreV1 } from '../mcp/v3/artifact-store.mjs';
import {
  CURSOR_CLOUD_RESULT_SOURCE_FAILURE_KEYS,
  CURSOR_CLOUD_RESULT_SOURCE_FAILURE_MESSAGE,
  CURSOR_CLOUD_RESULT_SOURCE_IDENTITY_MISMATCH_CODES,
  CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID,
  assertCursorCloudResultCorrelationV1,
  contentFreeCloudResultSourceFailureV1,
  isCursorCloudResultIdentityMismatchV1,
  materializeCursorCloudResultSourceV1,
  projectCursorCloudResultSourcesV1,
} from '../mcp/v3/cursor-cloud-result-source.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-artifact-fixtures.mjs';
import {
  AGENT_ID,
  ASSIGNMENT_ID,
  BRANCH,
  HEAD_SHA,
  HOSTILE_BRANCH,
  HOSTILE_PR_URL,
  HOSTILE_REPO_URL,
  HOSTILE_SHA,
  PR_URL,
  PROVIDER_RUN_ID,
  REPO_URL,
  REQUEST_ID,
  RUN_ID,
  SECRET,
  STARTING_SHA,
  gitEvidenceFor,
  identityFor,
  makeStoreRoot,
  providerOutput,
  removeRoot,
} from './fixtures/r1-cursor-cloud-result-source-fixtures.mjs';

async function expectCode(action, code, expectedPath) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (code !== undefined) {
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    }
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
    assert.equal(isCursorCloudResultIdentityMismatchV1(error), CURSOR_CLOUD_RESULT_SOURCE_IDENTITY_MISMATCH_CODES.includes(code));
    assert.equal(error.message.includes(HOSTILE_SHA), false);
    assert.equal(error.message.includes(HOSTILE_BRANCH), false);
    assert.equal(error.message.includes(SECRET), false);
    return error;
  }
  assert.fail(`expected a typed ${code ?? 'RunContractV1Error'} failure`);
}

async function withStore(fn) {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    return await fn(store, root);
  } finally {
    removeRoot(root);
  }
}

test('run, request, and branch identity mismatches fail closed without replay', async () => {
  await withStore(async (store) => {
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        observed: { run_id: 'run-other-cloud' },
        provider_report: { status: 'finished', output: 'done' },
      }),
      'run_identity_mismatch',
      'observed.run_id',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        observed: { assignment_id: 'other-lane' },
        provider_report: { status: 'finished', output: 'done' },
      }),
      'assignment_identity_mismatch',
      'observed.assignment_id',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        observed: { request_id: 'cloud-lane:run:9' },
        provider_report: { status: 'finished', output: 'done' },
      }),
      'request_identity_mismatch',
      'observed.request_id',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        observed: { provider_run_id: 'run-other' },
        provider_report: { status: 'finished', output: 'done' },
      }),
      'provider_run_identity_mismatch',
      'observed.provider_run_id',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        git_evidence: gitEvidenceFor({ branch: HOSTILE_BRANCH }),
      }),
      'branch_identity_mismatch',
      'git_evidence.branch',
    );
  });
});

test('repository, head, and base mismatches fail closed', async () => {
  await withStore(async (store) => {
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        git_evidence: gitEvidenceFor({ repository_url: HOSTILE_REPO_URL }),
      }),
      'repository_identity_mismatch',
      'git_evidence.repository_url',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor({ head_sha: HEAD_SHA }),
        git_evidence: gitEvidenceFor({ head_sha: HOSTILE_SHA }),
      }),
      'head_identity_mismatch',
      'git_evidence.head_sha',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        git_evidence: gitEvidenceFor({ starting_sha: HOSTILE_SHA, merge_base_sha: HOSTILE_SHA }),
      }),
      'base_identity_mismatch',
      'git_evidence.starting_sha',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        git_evidence: gitEvidenceFor({ merge_base_sha: HOSTILE_SHA, head_sha: HEAD_SHA }),
      }),
      'base_identity_mismatch',
      'git_evidence.merge_base_sha',
    );
  });
});

test('correlation rejects request and branch drift without echoing identities', async () => {
  const request = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: { request_id: REQUEST_ID, branch: BRANCH, provider_run_id: PROVIDER_RUN_ID },
      observed: { request_id: 'other-request:run:1' },
      git_evidence: gitEvidenceFor(),
    }),
    'request_identity_mismatch',
  );
  assert.equal(String(request.message).includes(REQUEST_ID), false);
  const branch = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: { branch: BRANCH, repository_url: REPO_URL },
      git_evidence: gitEvidenceFor({ branch: HOSTILE_BRANCH }),
    }),
    'branch_identity_mismatch',
  );
  assert.equal(String(branch.message).includes(HOSTILE_BRANCH), false);
  assert.equal(String(branch.message).includes(PR_URL), false);
});

test('hostile proxies unknown keys and local providers fail closed', async () => {
  await withStore(async (store, root) => {
    const { proxy, counts } = countingProxy({
      ...identityFor(),
      provider_report: { status: 'finished', output: providerOutput() },
    });
    const proxied = await expectCode(() => materializeCursorCloudResultSourceV1(store, proxy), 'proxy_denied');
    assert.ok(trapTotal(counts) <= 2);
    assert.equal(proxied.message.includes(root), false);

    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        replay: true,
        provider_report: { status: 'finished', output: 'done' },
      }),
      'unknown_key',
      'options.replay',
    );
    await expectCode(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor({ provider: 'grok' }),
        provider_report: { status: 'finished', output: 'done' },
      }),
      'cursor_cloud_provider_required',
      'options.provider',
    );
    const failure = contentFreeCloudResultSourceFailureV1(proxied);
    assert.deepEqual(Object.keys(failure), [...CURSOR_CLOUD_RESULT_SOURCE_FAILURE_KEYS]);
    assert.equal(failure.schema, CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID);
    assert.equal(failure.published, false);
    assert.equal(failure.error.message, CURSOR_CLOUD_RESULT_SOURCE_FAILURE_MESSAGE);
    assert.equal(JSON.stringify(failure).includes(SECRET), false);
  });
});

test('SDK projector refuses to treat provider output Git claims as observed identity', () => {
  const projected = projectCursorCloudResultSourcesV1({
    id: PROVIDER_RUN_ID,
    requestId: REQUEST_ID,
    agentId: AGENT_ID,
    status: 'finished',
    result: {
      run_id: 'run-forged',
      assignment_id: ASSIGNMENT_ID,
      request_id: 'forged-request',
      branch: HOSTILE_BRANCH,
      head_sha: HOSTILE_SHA,
      pr_url: HOSTILE_PR_URL,
    },
    git: {
      branches: [{ repoUrl: REPO_URL, branch: BRANCH, prUrl: PR_URL }],
      head_sha: HEAD_SHA,
      starting_sha: STARTING_SHA,
      merge_base_sha: STARTING_SHA,
    },
  });
  assert.equal(projected.observed.request_id, REQUEST_ID);
  assert.equal(projected.observed.provider_run_id, PROVIDER_RUN_ID);
  assert.equal(projected.git_evidence.branch, BRANCH);
  assert.equal(projected.git_evidence.head_sha, HEAD_SHA);
  assert.equal(projected.provider_report.output.branch, HOSTILE_BRANCH);
  assert.equal(projected.provider_report.output.head_sha, HOSTILE_SHA);
});
