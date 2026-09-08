import assert from 'node:assert/strict';
import test from 'node:test';

import { openArtifactStoreV1 } from '../mcp/v3/artifact-store.mjs';
import {
  CURSOR_CLOUD_RESULT_SOURCE_FAILURE_KEYS,
  CURSOR_CLOUD_RESULT_SOURCE_FAILURE_MESSAGE,
  CURSOR_CLOUD_RESULT_SOURCE_IDENTITY_MISMATCH_CODES,
  CURSOR_CLOUD_RESULT_SOURCE_SCHEMA_ID,
  assertCursorCloudResultCorrelationV1,
  adaptCursorCloudSdkResultV1,
  contentFreeCloudResultSourceFailureV1,
  cursorCloudResultSourceIdentityFromTaskV1,
  isCursorCloudResultIdentityMismatchV1,
  materializeCursorCloudResultSourceV1,
  projectCursorCloudGitEvidenceV1,
  projectCursorCloudProviderReportV1,
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
  MODEL,
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
  sdkResultFor,
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

test('empty Git evidence {} stays unpublished and does not invent a JSON artifact', async () => {
  await withStore(async (store) => {
    const receipt = await materializeCursorCloudResultSourceV1(store, {
      ...identityFor(),
      git_evidence: {},
    });
    assert.equal(receipt.git_evidence.published, false);
    assert.equal(receipt.git_evidence.empty, true);
    assert.equal(receipt.git_evidence.source_byte_length, 0);
    assert.equal(receipt.git_evidence.raw_ref, null);
    assert.equal(receipt.git_evidence.sanitized_ref, null);
    assert.equal(receipt.published, false);
  });
});

test('SDK projectors reject accessors, proxies, and extra keys without invoking traps', async () => {
  const trap = { ran: 0 };
  const accessorResult = { status: 'finished' };
  Object.defineProperty(accessorResult, 'result', {
    enumerable: true,
    get() {
      trap.ran += 1;
      throw new Error(`must not read ${SECRET}`);
    },
  });
  const accessor = await expectCode(
    () => projectCursorCloudResultSourcesV1(accessorResult),
    'accessor_property_denied',
    'provider_report.result',
  );
  assert.equal(trap.ran, 0);
  assert.equal(String(accessor.message).includes(SECRET), false);

  const live = countingProxy({
    id: PROVIDER_RUN_ID,
    status: 'finished',
    result: 'done',
  });
  const proxied = await expectCode(
    () => projectCursorCloudResultSourcesV1(live.proxy),
    'proxy_denied',
    'result',
  );
  assert.ok(trapTotal(live.counts) <= 2);
  assert.equal(String(proxied.message).includes(SECRET), false);

  const { proxy, revoke } = Proxy.revocable({ status: 'finished', result: 'done' }, {
    get() { throw new Error('revoked getter ran'); },
  });
  revoke();
  try {
    projectCursorCloudResultSourcesV1(proxy);
    assert.fail('expected a typed proxy_denied failure');
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(error.code, 'proxy_denied');
    assert.equal(error instanceof TypeError, false);
  }

  await expectCode(
    () => projectCursorCloudResultSourcesV1({
      status: 'finished',
      result: 'done',
      extra: true,
    }),
    'unknown_key',
    'result.extra',
  );

  const symbolic = { status: 'finished', result: 'done' };
  symbolic[Symbol('hidden')] = SECRET;
  await expectCode(
    () => projectCursorCloudResultSourcesV1(symbolic),
    'unknown_key',
    'result[symbol]',
  );

  const hidden = { status: 'finished', result: 'done' };
  Object.defineProperty(hidden, 'hidden', { value: SECRET, enumerable: false });
  await expectCode(
    () => projectCursorCloudProviderReportV1(hidden),
    'unknown_key',
    'provider_report.hidden',
  );
  const gitHidden = { branch: BRANCH };
  Object.defineProperty(gitHidden, 'hidden', { value: SECRET, enumerable: false });
  await expectCode(
    () => projectCursorCloudGitEvidenceV1(gitHidden),
    'unknown_key',
    'git_evidence.hidden',
  );
});

test('SDK adapter rejects unsafe declared fields while ignoring unknown metadata', async () => {
  for (const key of ['durationMs', 'model', 'usage', 'requestId', 'error', 'git']) {
    const input = sdkResultFor();
    let getterRuns = 0;
    Object.defineProperty(input, key, {
      enumerable: true,
      configurable: true,
      get() {
        getterRuns += 1;
        throw new Error(`must not read ${SECRET}`);
      },
    });
    const error = await expectCode(
      () => adaptCursorCloudSdkResultV1(input),
      'accessor_property_denied',
      `result.${key}`,
    );
    assert.equal(getterRuns, 0);
    assert.equal(String(error.message).includes(SECRET), false);
  }

  const input = sdkResultFor();
  let unknownGetterRuns = 0;
  Object.defineProperty(input, 'futureMetadata', {
    enumerable: true,
    get() {
      unknownGetterRuns += 1;
      throw new Error(`must not read ${SECRET}`);
    },
  });
  const adapted = adaptCursorCloudSdkResultV1(input);
  assert.equal(unknownGetterRuns, 0);
  assert.equal(Object.hasOwn(adapted, 'futureMetadata'), false);
});

test('SDK projectors copy caller-owned output and never freeze the input', () => {
  const output = { text: 'hello', nested: { n: 1 } };
  const error = { message: 'bounded' };
  const input = { status: 'finished', result: output, error };
  const projected = projectCursorCloudProviderReportV1(input);
  assert.notEqual(projected.output, output);
  assert.notEqual(projected.error, error);
  assert.notEqual(projected, input);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(output), false);
  assert.equal(Object.isFrozen(error), false);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.output), true);
  output.text = 'mutated';
  output.nested.n = 2;
  error.message = 'mutated';
  assert.equal(projected.output.text, 'hello');
  assert.equal(projected.output.nested.n, 1);
  assert.equal(projected.error.message, 'bounded');
});

test('nested revoked provider output and error fail as typed proxy_denied', () => {
  const revokedOutput = Proxy.revocable({ text: 'x' }, {
    get() { throw new Error('revoked output getter ran'); },
  });
  revokedOutput.revoke();
  try {
    projectCursorCloudProviderReportV1({ status: 'finished', result: revokedOutput.proxy });
    assert.fail('expected a typed proxy_denied failure');
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(error.code, 'proxy_denied');
    assert.notEqual(error.constructor, TypeError);
  }

  const revokedError = Proxy.revocable({ message: 'x' }, {
    get() { throw new Error('revoked error getter ran'); },
  });
  revokedError.revoke();
  try {
    projectCursorCloudProviderReportV1({ status: 'failed', error: revokedError.proxy });
    assert.fail('expected a typed proxy_denied failure');
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(error.code, 'proxy_denied');
  }
});

test('exported correlation and task identity helpers are descriptor-safe', async () => {
  const trap = { ran: 0 };
  const recorded = { request_id: REQUEST_ID, branch: BRANCH };
  Object.defineProperty(recorded, 'run_id', {
    enumerable: true,
    get() {
      trap.ran += 1;
      throw new Error(`must not read ${SECRET}`);
    },
  });
  const correlation = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded,
      observed: { request_id: REQUEST_ID },
    }),
    'accessor_property_denied',
    'recorded.run_id',
  );
  assert.equal(trap.ran, 0);
  assert.equal(String(correlation.message).includes(SECRET), false);

  const { proxy, revoke } = Proxy.revocable({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    provider: 'cursor-cloud',
    model: MODEL,
  }, { get() { throw new Error('revoked task getter ran'); } });
  revoke();
  try {
    cursorCloudResultSourceIdentityFromTaskV1(proxy);
    assert.fail('expected a typed proxy_denied failure');
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(error.code, 'proxy_denied');
  }

  const taskTrap = { ran: 0 };
  const task = {
    id: 'cloud-task',
    role: 'review',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    provider: 'cursor-cloud',
  };
  Object.defineProperty(task, 'model', {
    enumerable: true,
    get() {
      taskTrap.ran += 1;
      return MODEL;
    },
  });
  const identity = await expectCode(
    () => cursorCloudResultSourceIdentityFromTaskV1(task),
    'accessor_property_denied',
    'task.model',
  );
  assert.equal(taskTrap.ran, 0);
  assert.equal(String(identity.message).includes(MODEL), false);

  const bound = cursorCloudResultSourceIdentityFromTaskV1({
    id: 'cloud-task',
    role: 'review',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    provider: 'cursor-cloud',
    model: MODEL,
    provider_branch: BRANCH,
  });
  assert.equal(bound.run_id, RUN_ID);
  assert.equal(bound.model, MODEL);
  assert.equal(bound.branch, BRANCH);
  assert.equal(Object.isFrozen(bound), true);
});

test('conflicting truncated aliases fail closed and matching aliases normalize', async () => {
  await expectCode(
    () => projectCursorCloudProviderReportV1({
      status: 'finished',
      result: 'done',
      truncated: true,
      source_truncated: false,
    }),
    'invalid_format',
    'provider_report.source_truncated',
  );
  await expectCode(
    () => projectCursorCloudResultSourcesV1({
      status: 'finished',
      result: 'done',
      truncated: false,
      source_truncated: true,
    }),
    'invalid_format',
    'provider_report.source_truncated',
  );

  const matchedTrue = projectCursorCloudProviderReportV1({
    status: 'finished',
    result: 'done',
    truncated: true,
    source_truncated: true,
  });
  assert.equal(matchedTrue.source_truncated, true);
  const matchedFalse = projectCursorCloudResultSourcesV1({
    status: 'finished',
    result: 'done',
    truncated: false,
    source_truncated: false,
  });
  assert.equal(matchedFalse.provider_report.source_truncated, false);
  const truncatedOnly = projectCursorCloudProviderReportV1({
    status: 'finished',
    truncated: true,
  });
  assert.equal(truncatedOnly.source_truncated, true);
});

function sdkBranch(overrides = {}) {
  return { repoUrl: REPO_URL, branch: BRANCH, prUrl: PR_URL, ...overrides };
}

test('SDK git.branches rejects proxies, accessors, extras, and exotic arrays without traps', async () => {
  const live = countingProxy([sdkBranch()]);
  const liveError = await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: live.proxy }),
    'proxy_denied',
    'git_evidence.branches',
  );
  assert.equal(trapTotal(live.counts), 0);
  assert.equal(liveError instanceof TypeError, false);

  const revoked = Proxy.revocable([sdkBranch()], {
    get() { throw new Error(`revoked getter ran ${SECRET}`); },
  });
  revoked.revoke();
  try {
    projectCursorCloudGitEvidenceV1({ branches: revoked.proxy });
    assert.fail('expected a typed proxy_denied failure');
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(error.code, 'proxy_denied');
    assert.equal(error.path, 'git_evidence.branches');
    assert.equal(error instanceof TypeError, false);
    assert.equal(String(error.message).includes(SECRET), false);
    assert.equal(String(error.message).includes('revoked getter ran'), false);
  }

  const indexTrap = { ran: 0 };
  const indexAccessor = [];
  Object.defineProperty(indexAccessor, '0', {
    enumerable: true,
    configurable: true,
    get() {
      indexTrap.ran += 1;
      throw new Error(`must not read ${SECRET}`);
    },
  });
  const accessorError = await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: indexAccessor }),
    'accessor_property_denied',
    'git_evidence.branches[0]',
  );
  assert.equal(indexTrap.ran, 0);
  assert.equal(String(accessorError.message).includes(SECRET), false);

  const ordinaryExtra = [sdkBranch()];
  ordinaryExtra.extra = SECRET;
  const extraError = await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: ordinaryExtra }),
    'unknown_key',
    'git_evidence.branches',
  );
  assert.equal(String(extraError.message).includes(SECRET), false);
  assert.equal(String(extraError.path).includes(SECRET), false);

  const symbolic = [sdkBranch()];
  const hiddenSymbol = Symbol(SECRET);
  symbolic[hiddenSymbol] = SECRET;
  const symbolError = await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: symbolic }),
    'unknown_key',
    'git_evidence.branches[symbol]',
  );
  assert.equal(String(symbolError.message).includes(SECRET), false);
  assert.equal(String(symbolError.path).includes(SECRET), false);

  const hiddenExtra = [sdkBranch()];
  Object.defineProperty(hiddenExtra, 'hidden', { value: SECRET, enumerable: false });
  const hiddenError = await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: hiddenExtra }),
    'non_enumerable_property_denied',
    'git_evidence.branches',
  );
  assert.equal(String(hiddenError.message).includes(SECRET), false);

  const sparse = [];
  sparse[1] = sdkBranch();
  await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: sparse }),
    'malformed_result',
    'git_evidence.branches',
  );

  class HostileArray extends Array {}
  await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: HostileArray.from([sdkBranch()]) }),
    'malformed_result',
    'git_evidence.branches',
  );
  const exotic = [sdkBranch()];
  Object.setPrototypeOf(exotic, Object.prototype);
  await expectCode(
    () => projectCursorCloudGitEvidenceV1({ branches: exotic }),
    'malformed_result',
    'git_evidence.branches',
  );
});

test('valid dense Git branch arrays keep empty, one-entry, and first-branch projection', () => {
  assert.equal(projectCursorCloudGitEvidenceV1({ branches: [] }), null);

  const one = projectCursorCloudGitEvidenceV1({ branches: [sdkBranch()] });
  assert.equal(one.branch, BRANCH);
  assert.equal(one.repository_url, REPO_URL);
  assert.equal(one.pr_url, PR_URL);

  const multi = projectCursorCloudGitEvidenceV1({
    branches: [
      sdkBranch(),
      sdkBranch({ repoUrl: HOSTILE_REPO_URL, branch: HOSTILE_BRANCH, prUrl: HOSTILE_PR_URL }),
    ],
  });
  assert.equal(multi.branch, BRANCH);
  assert.equal(multi.repository_url, REPO_URL);
  assert.equal(multi.pr_url, PR_URL);
  assert.equal(JSON.stringify(multi).includes(HOSTILE_BRANCH), false);
  assert.equal(JSON.stringify(multi).includes(HOSTILE_REPO_URL), false);

  const nullPrototype = [sdkBranch()];
  Object.setPrototypeOf(nullPrototype, null);
  const fromNull = projectCursorCloudGitEvidenceV1({ branches: nullPrototype });
  assert.equal(fromNull.branch, BRANCH);
  assert.equal(fromNull.repository_url, REPO_URL);
});

test('correlation enforces recorded identity keys and closes mismatch-bypass aliases', async () => {
  const ordinary = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: { request_id: REQUEST_ID, extra: true },
      observed: { request_id: REQUEST_ID },
    }),
    'unknown_key',
    'recorded.extra',
  );
  assert.equal(String(ordinary.message).includes(SECRET), false);

  const symbolic = { request_id: REQUEST_ID, branch: BRANCH };
  symbolic[Symbol(SECRET)] = SECRET;
  const symbolError = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: symbolic,
      observed: { request_id: REQUEST_ID },
    }),
    'unknown_key',
    'recorded[symbol]',
  );
  assert.equal(String(symbolError.message).includes(SECRET), false);
  assert.equal(String(symbolError.path).includes(SECRET), false);

  const hidden = { request_id: REQUEST_ID };
  Object.defineProperty(hidden, 'hidden', { value: SECRET, enumerable: false });
  const hiddenError = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: hidden,
      observed: { request_id: REQUEST_ID },
    }),
    'unknown_key',
    'recorded.hidden',
  );
  assert.equal(String(hiddenError.message).includes(SECRET), false);

  const trap = { ran: 0 };
  const accessor = { request_id: REQUEST_ID };
  Object.defineProperty(accessor, 'extra', {
    enumerable: true,
    get() {
      trap.ran += 1;
      throw new Error(`must not read ${SECRET}`);
    },
  });
  const accessorError = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: accessor,
      observed: { request_id: REQUEST_ID },
    }),
    'unknown_key',
    'recorded.extra',
  );
  assert.equal(trap.ran, 0);
  assert.equal(String(accessorError.message).includes(SECRET), false);

  const requestBypass = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: { requestId: REQUEST_ID, branch: BRANCH, provider_run_id: PROVIDER_RUN_ID },
      observed: { request_id: 'other-request:run:1' },
      git_evidence: gitEvidenceFor(),
    }),
    'unknown_key',
    'recorded.requestId',
  );
  assert.equal(String(requestBypass.message).includes(REQUEST_ID), false);
  assert.equal(String(requestBypass.message).includes('other-request:run:1'), false);

  const matchingRequestAlias = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: { requestId: REQUEST_ID },
      observed: { request_id: REQUEST_ID },
    }),
    'unknown_key',
    'recorded.requestId',
  );
  assert.equal(String(matchingRequestAlias.message).includes(REQUEST_ID), false);

  const branchBypass = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: { branch_name: BRANCH },
      git_evidence: gitEvidenceFor({ branch: HOSTILE_BRANCH }),
    }),
    'unknown_key',
    'recorded.branch_name',
  );
  assert.equal(String(branchBypass.message).includes(HOSTILE_BRANCH), false);
  assert.equal(String(branchBypass.message).includes(BRANCH), false);

  const headBypass = await expectCode(
    () => assertCursorCloudResultCorrelationV1({
      recorded: { headSha: HEAD_SHA },
      git_evidence: gitEvidenceFor({ head_sha: HOSTILE_SHA }),
    }),
    'unknown_key',
    'recorded.headSha',
  );
  assert.equal(String(headBypass.message).includes(HOSTILE_SHA), false);
  assert.equal(String(headBypass.message).includes(HEAD_SHA), false);

  const bound = assertCursorCloudResultCorrelationV1({
    recorded: { request_id: REQUEST_ID, branch: BRANCH, provider_run_id: PROVIDER_RUN_ID },
    observed: { request_id: REQUEST_ID },
    git_evidence: gitEvidenceFor(),
  });
  assert.equal(bound.recorded, true);
  assert.equal(bound.observed.request_id, REQUEST_ID);
  assert.equal(bound.git_evidence.branch, BRANCH);
});
