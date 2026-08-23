import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isArtifactRelativePathV1 } from '../mcp/v3/artifact-path.mjs';
import { readSanitizedArtifactV1 } from '../mcp/v3/artifact-reader.mjs';
import { openArtifactStoreV1 } from '../mcp/v3/artifact-store.mjs';
import {
  CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND,
  CURSOR_CLOUD_PROVIDER_REPORT_ARTIFACT_KIND,
  CURSOR_CLOUD_RESULT_SOURCE_ERROR_CODES,
  CURSOR_CLOUD_RESULT_SOURCE_FAILURE_KEYS,
  CURSOR_CLOUD_RESULT_SOURCE_INLINE_TAIL_KEYS,
  CURSOR_CLOUD_RESULT_SOURCE_OPTION_KEYS,
  CURSOR_CLOUD_RESULT_SOURCE_RECEIPT_KEYS,
  CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID,
  CURSOR_CLOUD_RESULT_SOURCE_SLOT_KEYS,
  CURSOR_CLOUD_RESULT_SOURCE_VERSION,
  cursorCloudGitEvidencePathV1,
  cursorCloudProviderReportPathV1,
  materializeCursorCloudResultSourceV1,
  projectCursorCloudGitEvidenceV1,
  projectCursorCloudResultSourcesV1,
} from '../mcp/v3/cursor-cloud-result-source.mjs';
import { ARTIFACT_SANITIZER_VERSION } from '../mcp/v3/artifact-sanitizer.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ASSIGNMENT_ID,
  BRANCH,
  HEAD_SHA,
  HOSTILE_BRANCH,
  HOSTILE_PR_URL,
  HOSTILE_SHA,
  MODEL,
  PR_URL,
  PROVIDER_RUN_ID,
  REPO_URL,
  REQUEST_ID,
  RUN_ID,
  SECRET,
  gitEvidenceFor,
  identityFor,
  makeStoreRoot,
  providerOutput,
  removeRoot,
  sdkResultFor,
} from './fixtures/r1-cursor-cloud-result-source-fixtures.mjs';

async function errorOfAsync(action, expectedCode, expectedPath) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (expectedCode !== undefined) {
      assert.equal(error.code, expectedCode, `expected ${expectedCode}, got ${error.code}: ${error.message}`);
    }
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
    return error;
  }
  assert.fail(`expected a typed ${expectedCode ?? 'RunContractV1Error'} failure`);
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

async function readAllSanitized(store, ref) {
  let offset = 0;
  const parts = [];
  for (;;) {
    const page = await readSanitizedArtifactV1(store, ref, { offset, max_bytes: 8192 });
    parts.push(Buffer.from(page.selected_content, 'base64'));
    if (page.more !== true) {
      return Buffer.concat(parts).toString('utf8');
    }
    offset = page.next_offset;
  }
}

function assertReceiptShape(receipt) {
  assert.equal(receipt.schema, CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID);
  assert.equal(receipt.version, CURSOR_CLOUD_RESULT_SOURCE_VERSION);
  assert.deepEqual(Object.keys(receipt), [...CURSOR_CLOUD_RESULT_SOURCE_RECEIPT_KEYS]);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Object.keys(receipt.provider_report), [...CURSOR_CLOUD_RESULT_SOURCE_SLOT_KEYS]);
  assert.deepEqual(Object.keys(receipt.git_evidence), [...CURSOR_CLOUD_RESULT_SOURCE_SLOT_KEYS]);
}

function assertNoLeak(serialized, root, secrets) {
  assert.equal(serialized.includes(root), false, 'receipt echoed the store root');
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `receipt leaked ${secret}`);
  }
}

test('the closed result-source vocabulary is exported frozen', () => {
  assert.equal(CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID, 'codex-co-engineer.cursor-cloud-result-source.v1');
  assert.equal(CURSOR_CLOUD_RESULT_SOURCE_VERSION, 1);
  assert.equal(Object.isFrozen(CURSOR_CLOUD_RESULT_SOURCE_OPTION_KEYS), true);
  assert.equal(Object.isFrozen(CURSOR_CLOUD_RESULT_SOURCE_RECEIPT_KEYS), true);
  assert.equal(Object.isFrozen(CURSOR_CLOUD_RESULT_SOURCE_SLOT_KEYS), true);
  assert.equal(Object.isFrozen(CURSOR_CLOUD_RESULT_SOURCE_INLINE_TAIL_KEYS), true);
  assert.equal(Object.isFrozen(CURSOR_CLOUD_RESULT_SOURCE_FAILURE_KEYS), true);
  assert.equal(Object.isFrozen(CURSOR_CLOUD_RESULT_SOURCE_ERROR_CODES), true);
  assert.ok(CURSOR_CLOUD_RESULT_SOURCE_ERROR_CODES.includes('source_confusion_denied'));
  assert.ok(CURSOR_CLOUD_RESULT_SOURCE_RECEIPT_KEYS.includes('provider_report'));
  assert.ok(CURSOR_CLOUD_RESULT_SOURCE_RECEIPT_KEYS.includes('git_evidence'));
});

test('the result-source module uses P09/P10/P08 authorities and does not import protected seams', () => {
  const source = readFileSync(fileURLToPath(new URL('../mcp/v3/cursor-cloud-result-source.mjs', import.meta.url)), 'utf8');
  assert.match(source, /sanitizeAndPublishArtifactV1/u);
  assert.match(source, /readSanitizedArtifactV1/u);
  assert.match(source, /verifyStoredArtifactV1/u);
  assert.equal(source.includes('task-store.mjs'), false);
  assert.equal(source.includes('acp-worker.mjs'), false);
  assert.equal(source.includes('supervisor.mjs'), false);
  assert.equal(source.includes('server.mjs'), false);
  assert.equal(source.includes('provider-driver.mjs'), false);
  assert.equal(source.includes('cursor-cloud-driver.mjs'), false);
  assert.equal(source.includes('cursor-cloud-worker.mjs'), false);
  assert.equal(source.includes('run-manifest.mjs'), true);
});

test('provider report and independently observed Git evidence stay distinct typed sources', async () => {
  await withStore(async (store, root) => {
    const output = providerOutput();
    const receipt = await materializeCursorCloudResultSourceV1(store, {
      ...identityFor(),
      observed: { provider_run_id: PROVIDER_RUN_ID, request_id: REQUEST_ID },
      provider_report: { status: 'finished', output },
      git_evidence: gitEvidenceFor(),
    });
    assertReceiptShape(receipt);
    assert.equal(receipt.run_id, RUN_ID);
    assert.equal(receipt.assignment_id, ASSIGNMENT_ID);
    assert.equal(receipt.provider, 'cursor-cloud');
    assert.equal(receipt.model, MODEL);
    assert.equal(receipt.provider_report.source_kind, 'provider_report');
    assert.equal(receipt.provider_report.artifact_kind, CURSOR_CLOUD_PROVIDER_REPORT_ARTIFACT_KIND);
    assert.equal(receipt.git_evidence.source_kind, 'git_evidence');
    assert.equal(receipt.git_evidence.artifact_kind, CURSOR_CLOUD_GIT_EVIDENCE_ARTIFACT_KIND);
    assert.equal(receipt.provider_report.published, true);
    assert.equal(receipt.git_evidence.published, true);
    assert.equal(receipt.provider_report.status, 'finished');
    assert.equal(receipt.provider_report.head_sha, null);
    assert.equal(receipt.provider_report.branch, null);
    assert.equal(receipt.provider_report.pr_url, null);
    assert.equal(receipt.git_evidence.status, null);
    assert.equal(receipt.git_evidence.branch, BRANCH);
    assert.equal(receipt.git_evidence.head_sha, HEAD_SHA);
    assert.equal(receipt.git_evidence.pr_url, PR_URL);
    assert.equal(receipt.git_evidence.relative_path, cursorCloudGitEvidencePathV1(identityFor()));
    assert.equal(receipt.provider_report.relative_path, cursorCloudProviderReportPathV1(identityFor(), 'application/json'));
    assert.equal(isArtifactRelativePathV1(receipt.provider_report.relative_path), true);
    assert.equal(isArtifactRelativePathV1(receipt.git_evidence.relative_path), true);
    assert.notEqual(receipt.provider_report.relative_path, receipt.git_evidence.relative_path);
    assert.equal(receipt.provider_report.sanitizer_version, ARTIFACT_SANITIZER_VERSION);

    const providerBytes = await readAllSanitized(store, receipt.provider_report.sanitized_ref);
    const gitBytes = await readAllSanitized(store, receipt.git_evidence.sanitized_ref);
    assert.match(providerBytes, /VERDICT: CLOUD PASS/u);
    assert.match(providerBytes, new RegExp(HOSTILE_SHA, 'u'));
    assert.equal(gitBytes.includes(HOSTILE_SHA), false);
    assert.equal(gitBytes.includes(HOSTILE_PR_URL), false);
    assert.equal(gitBytes.includes(HOSTILE_BRANCH), false);
    assert.match(gitBytes, new RegExp(HEAD_SHA, 'u'));
    assert.match(gitBytes, new RegExp(BRANCH, 'u'));
    assertNoLeak(JSON.stringify(receipt), root, [SECRET]);
  });
});

test('Git facts that exist only in provider text are never trusted Git evidence', async () => {
  await withStore(async (store) => {
    const output = providerOutput();
    const identity = identityFor();
    delete identity.branch;
    delete identity.head_sha;
    delete identity.repository_url;
    delete identity.repository_identity;
    const receipt = await materializeCursorCloudResultSourceV1(store, {
      ...identity,
      provider_report: {
        status: 'finished',
        output: {
          text: output,
          git: { head_sha: HOSTILE_SHA, branch: HOSTILE_BRANCH, pr_url: HOSTILE_PR_URL },
        },
      },
    });
    assert.equal(receipt.provider_report.published, true);
    assert.equal(receipt.git_evidence.published, false);
    assert.equal(receipt.git_evidence.empty, true);
    assert.equal(receipt.git_evidence.head_sha, null);
    assert.equal(receipt.git_evidence.branch, null);
    assert.equal(receipt.git_evidence.pr_url, null);
    const stored = await readAllSanitized(store, receipt.provider_report.sanitized_ref);
    assert.match(stored, new RegExp(HOSTILE_SHA, 'u'));
  });
});

test('the SDK projector never copies provider output into Git evidence', () => {
  const projected = projectCursorCloudResultSourcesV1(sdkResultFor({
    result: {
      text: providerOutput(),
      git: { head_sha: HOSTILE_SHA, branch: HOSTILE_BRANCH, prUrl: HOSTILE_PR_URL },
    },
  }));
  assert.equal(projected.git_evidence.branch, BRANCH);
  assert.equal(projected.git_evidence.pr_url, PR_URL);
  assert.equal(projected.git_evidence.head_sha, undefined);
  assert.equal(JSON.stringify(projected.git_evidence).includes(HOSTILE_SHA), false);
  assert.equal(JSON.stringify(projected.git_evidence).includes(HOSTILE_BRANCH), false);
  assert.equal(projected.provider_report.status, 'finished');
  assert.equal(projected.provider_report.output.git.head_sha, HOSTILE_SHA);
});

test('provider text cannot be supplied as Git evidence', async () => {
  await withStore(async (store) => {
    await errorOfAsync(
      () => projectCursorCloudGitEvidenceV1(providerOutput()),
      'source_confusion_denied',
      'git_evidence',
    );
    await errorOfAsync(
      () => materializeCursorCloudResultSourceV1(store, {
        ...identityFor(),
        git_evidence: providerOutput(),
      }),
      'invalid_type',
      'git_evidence',
    );
  });
});


