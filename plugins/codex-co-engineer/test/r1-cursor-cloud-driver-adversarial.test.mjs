// Adversarial tests for the P21 Cursor Cloud SDK adapter: hostile direct-JS
// transports, forged receipts, merge/PR/push/replay keys, secret and prompt
// leaks, and post-intent replay. Injected transport only.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURSOR_CLOUD_TRANSPORT_OPERATIONS,
  assertCursorCloudTransportV1,
  bindCursorCloudDriverV1,
  createCursorCloudDriverV1,
  inspectCursorCloudLaneEvidenceV1,
} from '../mcp/v3/cursor-cloud-driver.mjs';
import {
  DRIVER_OPERATION_SCHEMA_IDS,
  buildDriverOperationRequestV1,
  validateDriverLaunchRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  CLOUD_FIXTURE_BRANCH,
  CLOUD_FIXTURE_MODEL,
  CLOUD_FIXTURE_PROVIDER_RUN_ID,
  CLOUD_FIXTURE_REPO_IDENTITY,
  CLOUD_FIXTURE_REPO_URL,
  LEAK_MARKER,
  buildCursorCloudDriverFixtureV1,
  createScriptedCursorCloudTransportV1,
  cursorCloudCallsOf,
} from './fixtures/r1-cursor-cloud-driver-fixtures.mjs';

const fixture = buildCursorCloudDriverFixtureV1();

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code, message);
}

function errorOf(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a typed contract error');
}

function requestFor(operation, extras = {}) {
  return buildDriverOperationRequestV1(operation, fixture.envelope, extras);
}

function identityFields() {
  return {
    provider: 'cursor-cloud',
    model: CLOUD_FIXTURE_MODEL,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    lane_index: fixture.lane_index,
    base_sha: fixture.base_sha,
    child_envelope_digest: fixture.child_envelope_digest,
    starting_sha: fixture.base_sha,
    repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
  };
}

function launchBound(script = {}) {
  const transport = createScriptedCursorCloudTransportV1(script);
  const driver = bindCursorCloudDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  return { driver, transport };
}

test('live and revoked proxies are denied with zero traps', () => {
  const live = countingProxy(createScriptedCursorCloudTransportV1());
  assert.equal(errorOf(() => assertCursorCloudTransportV1(live.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(live.counts), 0);

  const { proxy, revoke } = Proxy.revocable(createScriptedCursorCloudTransportV1(), {
    get() { throw new Error('revoked getter ran'); },
  });
  revoke();
  assert.equal(errorOf(() => assertCursorCloudTransportV1(proxy)).code, 'proxy_denied');
});

test('hostile transport surfaces fail closed', () => {
  expectCode(() => assertCursorCloudTransportV1({ ...createScriptedCursorCloudTransportV1(), retry: () => ({}) }),
    'invalid_surface');
  const incomplete = { ...createScriptedCursorCloudTransportV1() };
  delete incomplete.reattach;
  expectCode(() => assertCursorCloudTransportV1(incomplete), 'invalid_surface');
  expectCode(() => assertCursorCloudTransportV1({ ...createScriptedCursorCloudTransportV1(), create: 1 }),
    'invalid_operation');
  class TransportClass {}
  expectCode(
    () => assertCursorCloudTransportV1(Object.assign(new TransportClass(), createScriptedCursorCloudTransportV1())),
    'exotic_prototype_denied',
  );
  const accessor = {};
  Object.defineProperty(accessor, 'preflight', { enumerable: true, get: () => () => ({}) });
  for (const operation of CURSOR_CLOUD_TRANSPORT_OPERATIONS) {
    if (operation === 'preflight') continue;
    accessor[operation] = () => ({});
  }
  expectCode(() => assertCursorCloudTransportV1(accessor), 'invalid_object');
  const symbolTransport = { ...createScriptedCursorCloudTransportV1() };
  symbolTransport[Symbol('hidden')] = () => ({});
  expectCode(() => assertCursorCloudTransportV1(symbolTransport), 'invalid_object');
});

test('getter and own-undefined driver requests never invoke accessors', () => {
  let reads = 0;
  const getterRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  Object.defineProperty(getterRequest, 'version', {
    enumerable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.equal(errorOf(() => validateDriverLaunchRequestV1(getterRequest)).code, 'accessor_property_denied');
  assert.equal(reads, 0);

  const undefinedRequest = {
    schema: DRIVER_OPERATION_SCHEMA_IDS.launch,
    version: undefined,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
  };
  assert.equal(errorOf(() => validateDriverLaunchRequestV1(undefinedRequest)).code, 'own_undefined_denied');
  expectCode(() => validateDriverLaunchRequestV1(new Proxy(requestFor('launch'), {})), 'proxy_denied');
});

test('merge, create-PR, push, and replay keys stay forbidden on the driver request', () => {
  for (const [key, value, code] of [
    ['create_pr', true, 'merge_authority_denied'],
    ['allow_merge', true, 'merge_authority_denied'],
    ['fallback', true, 'replay_or_fallback_denied'],
    ['resend', true, 'replay_or_fallback_denied'],
    ['retry_dispatch', 'now', 'replay_or_fallback_denied'],
    ['allow_post_dispatch_fallback', true, 'replay_or_fallback_denied'],
  ]) {
    expectCode(
      () => validateDriverLaunchRequestV1({ ...requestFor('launch'), [key]: value }),
      code,
      `${key} must fail closed`,
    );
  }
});

test('malformed create receipts after the SDK call are uncertain, not dispatched', () => {
  const { driver, transport } = launchBound({
    create: [{ created: true, agent_id: '!!!', ...identityFields() }],
  });
  const receipt = driver.launch(requestFor('launch'));
  assert.equal(receipt.disposition, 'dispatch_uncertain');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(cursorCloudCallsOf(transport, 'send').length, 0);
});

test('forged send acknowledgements never become dispatched', () => {
  const { driver } = launchBound({
    send: [{
      acknowledged: true,
      agent_id: 'bc-forged',
      provider_run_id: CLOUD_FIXTURE_PROVIDER_RUN_ID,
      request_id: 'ccr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      branch: CLOUD_FIXTURE_BRANCH,
      ...identityFields(),
    }],
  });
  const receipt = driver.launch(requestFor('launch'));
  assert.equal(receipt.disposition, 'dispatch_uncertain');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
});

test('observe PR URLs, prompt fields, and extra keys fail closed', () => {
  const { driver } = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      status: 'completed',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
      linear_history: true,
      pr_url: 'https://github.com/example/codex-co-engineer/pull/1',
    })],
  });
  driver.launch(requestFor('launch'));
  expectCode(() => driver.reconcile(requestFor('reconcile')), 'unknown_key');
});

test('credential-bearing repository URLs fail closed before create', () => {
  const transport = createScriptedCursorCloudTransportV1({
    preflight: [{
      ok: true,
      ...identityFields(),
      requested_model: CLOUD_FIXTURE_MODEL,
      effective_model: CLOUD_FIXTURE_MODEL,
      repository_url: 'https://user:token@github.com/example/codex-co-engineer.git',
      workspace_clean: true,
      starting_ref_visible: true,
      starting_ref_commit: true,
      head_sha: fixture.base_sha,
      duplicate_identities: false,
      credential_bearing: false,
      auto_create_pr: false,
    }],
  });
  const driver = bindCursorCloudDriverV1(transport);
  expectCode(() => driver.preflight(requestFor('preflight')), 'invalid_format');
  assert.equal(cursorCloudCallsOf(transport, 'create').length, 0);
});

test('prompt and secret markers never reach driver results or evidence', () => {
  const { driver, transport } = launchBound();
  driver.launch(requestFor('launch'));
  const launched = driver.reconcile(requestFor('reconcile', { include: ['detailed_events', 'live_progress'] }));
  const evidence = inspectCursorCloudLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  const blob = `${JSON.stringify(launched)}\n${JSON.stringify(evidence)}\n${JSON.stringify(cursorCloudCallsOf(transport, 'observe')[0])}`;
  assert.doesNotMatch(JSON.stringify(launched), new RegExp(LEAK_MARKER, 'u'));
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(LEAK_MARKER, 'u'));
  assert.doesNotMatch(JSON.stringify(launched), /sk-|Bearer |api_key/iu);
  void blob;
});

test('event pages reject hostile records and over-bound arrays', () => {
  const { driver } = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
      events: [{ kind: 'prompt', bytes: 12 }],
    })],
  });
  driver.launch(requestFor('launch'));
  expectCode(
    () => driver.reconcile(requestFor('reconcile', { include: ['detailed_events'] })),
    'invalid_format',
  );

  const oversized = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
      events: Array.from({ length: 33 }, () => ({ kind: 'status', bytes: 1 })),
    })],
  });
  oversized.driver.launch(requestFor('launch'));
  expectCode(
    () => oversized.driver.reconcile(requestFor('reconcile', { include: ['detailed_events'] })),
    'invalid_format',
  );
});

test('inspect rejects proxy queries without running traps', () => {
  const { driver } = launchBound();
  driver.launch(requestFor('launch'));
  const query = countingProxy({
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(errorOf(() => inspectCursorCloudLaneEvidenceV1(driver, query.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(query.counts), 0);
});

test('blocked preflight details never copy transport-authored text', () => {
  const transport = createScriptedCursorCloudTransportV1({
    preflight: [{
      ok: false,
      ...identityFields(),
      requested_model: CLOUD_FIXTURE_MODEL,
      effective_model: CLOUD_FIXTURE_MODEL,
      repository_url: CLOUD_FIXTURE_REPO_URL,
      workspace_clean: false,
      starting_ref_visible: true,
      starting_ref_commit: true,
      head_sha: fixture.base_sha,
      duplicate_identities: false,
      credential_bearing: false,
      auto_create_pr: false,
      detail_code: 'workspace_dirty',
      detail_message: `dirty because ${LEAK_MARKER} and Bearer sk-live`,
    }],
  });
  const driver = bindCursorCloudDriverV1(transport);
  const blocked = driver.preflight(requestFor('preflight'));
  assert.equal(blocked.disposition, 'blocked');
  assert.doesNotMatch(blocked.detail_message, new RegExp(LEAK_MARKER, 'u'));
  assert.doesNotMatch(blocked.detail_message, /Bearer|sk-live/u);
});

test('createCursorCloudDriverV1 rejects a proxy transport without constructing lanes', () => {
  const live = countingProxy(createScriptedCursorCloudTransportV1());
  assert.equal(errorOf(() => createCursorCloudDriverV1(live.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(live.counts), 0);
});

function readyPreflightReceipt(overrides = {}) {
  return {
    ok: true,
    ...identityFields(),
    requested_model: CLOUD_FIXTURE_MODEL,
    effective_model: CLOUD_FIXTURE_MODEL,
    repository_url: CLOUD_FIXTURE_REPO_URL,
    workspace_clean: true,
    starting_ref_visible: true,
    starting_ref_commit: true,
    head_sha: fixture.base_sha,
    duplicate_identities: false,
    credential_bearing: false,
    auto_create_pr: false,
    ...overrides,
  };
}

function publicErrorBlob(error) {
  let json = '';
  try {
    json = JSON.stringify(error);
  } catch {
    json = '';
  }
  return [
    error?.name, error?.code, error?.path, error?.message, error?.stack,
    error?.cause, error?.detail, error?.details, error?.errno, error?.syscall,
    error === undefined || error === null ? '' : String(error),
    json,
  ].map((value) => (value === undefined || value === null ? '' : String(value))).join('\n');
}

function assertClosedPublicError(error) {
  assert.ok(error instanceof RunContractV1Error);
  const blob = publicErrorBlob(error);
  assert.doesNotMatch(blob, /Bearer/u);
  assert.doesNotMatch(blob, /sk-live/u);
  assert.doesNotMatch(blob, /Authorization/u);
  assert.doesNotMatch(blob, new RegExp(LEAK_MARKER, 'u'));
  assert.doesNotMatch(blob, /api[_-]?key/iu);
  assert.doesNotMatch(blob, /envelope_text/u);
  assert.equal(error.cause, undefined);
  assert.equal(error.detail, undefined);
  assert.equal(error.details, undefined);
  assert.equal(error.name, 'RunContractV1Error');
}

test('blocker 1: preflight safety booleans missing true or nonboolean fail closed', () => {
  const cases = [
    [{}, 'credential_bearing', undefined],
    [{ credential_bearing: 'false' }, 'credential_bearing', 'false'],
    [{ credential_bearing: 0 }, 'credential_bearing', 0],
    [{ credential_bearing: true }, 'credential_bearing', true],
    [{}, 'duplicate_identities', undefined],
    [{ duplicate_identities: 'no' }, 'duplicate_identities', 'no'],
    [{ auto_create_pr: 'false' }, 'auto_create_pr', 'false'],
    [{ auto_create_pr: true }, 'auto_create_pr', true],
  ];
  for (const [override, key, value] of cases) {
    const receipt = readyPreflightReceipt(override);
    if (value === undefined) delete receipt[key];
    const transport = createScriptedCursorCloudTransportV1({ preflight: [receipt] });
    const driver = bindCursorCloudDriverV1(transport);
    assert.throws(
      () => driver.preflight(requestFor('preflight')),
      (error) => error instanceof RunContractV1Error,
      `${key}=${String(value)} must fail closed`,
    );
    assert.equal(cursorCloudCallsOf(transport, 'create').length, 0, `${key} must not dispatch`);
  }
});

test('blocker 2: repository identity and starting sha bind across every lifecycle receipt', () => {
  const missingShaCreate = launchBound({
    create: [(request) => {
      const receipt = {
        created: true,
        agent_id: request.proposed_agent_id,
        ...identityFields(),
      };
      delete receipt.starting_sha;
      return receipt;
    }],
  });
  const missingShaLaunch = missingShaCreate.driver.launch(requestFor('launch'));
  assert.notEqual(missingShaLaunch.disposition, 'dispatched');
  assert.equal(cursorCloudCallsOf(missingShaCreate.transport, 'send').length, 0);

  const driftedRepo = launchBound({
    create: [(request) => ({
      created: true,
      agent_id: request.proposed_agent_id,
      ...identityFields(),
      repository_identity: 'github.com/other/drifted-cloud',
    })],
  });
  const driftedLaunch = driftedRepo.driver.launch(requestFor('launch'));
  assert.notEqual(driftedLaunch.disposition, 'dispatched');
  assert.equal(cursorCloudCallsOf(driftedRepo.transport, 'send').length, 0);

  const missingShaSend = launchBound({
    send: [(request) => {
      const receipt = {
        acknowledged: true,
        agent_id: request.agent_id,
        provider_run_id: CLOUD_FIXTURE_PROVIDER_RUN_ID,
        request_id: request.request_id,
        branch: CLOUD_FIXTURE_BRANCH,
        ...identityFields(),
      };
      delete receipt.starting_sha;
      return receipt;
    }],
  });
  const sendMissing = missingShaSend.driver.launch(requestFor('launch'));
  assert.notEqual(sendMissing.disposition, 'dispatched');

  const { driver, transport } = launchBound({
    observe: [(request) => {
      const receipt = {
        ...identityFields(),
        agent_id: request.agent_id,
        provider_run_id: request.provider_run_id,
        request_id: request.request_id,
        branch: CLOUD_FIXTURE_BRANCH,
        status: 'running',
        head_sha: fixture.base_sha,
        merge_base_sha: fixture.base_sha,
      };
      delete receipt.starting_sha;
      return receipt;
    }],
  });
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched');
  expectCode(() => driver.reconcile(requestFor('reconcile')), 'malformed_receipt');
  const evidence = inspectCursorCloudLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(evidence.git, null);
  assert.equal(cursorCloudCallsOf(transport, 'create').length, 1);
});

test('blocker 3: observe reattach and cancel require exact recorded run identities including branch', () => {
  const omitRun = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
    })],
  });
  omitRun.driver.launch(requestFor('launch'));
  expectCode(() => omitRun.driver.reconcile(requestFor('reconcile')), 'stale_identity_denied');

  const omitBranch = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
    })],
  });
  omitBranch.driver.launch(requestFor('launch'));
  expectCode(() => omitBranch.driver.reconcile(requestFor('reconcile')), 'stale_identity_denied');

  const omitRequestCancel = launchBound({
    cancel: [(request) => ({
      outcome: 'cancel_confirmed',
      archived: true,
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      ...identityFields(),
    })],
  });
  omitRequestCancel.driver.launch(requestFor('launch'));
  expectCode(() => omitRequestCancel.driver.cancel(requestFor('cancel')), 'stale_identity_denied');

  const omitBranchReattach = launchBound({
    reattach: [(request) => ({
      reattached: true,
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
    })],
  });
  omitBranchReattach.driver.launch(requestFor('launch'));
  expectCode(
    () => omitBranchReattach.driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })),
    'stale_identity_denied',
  );
});

test('blocker 4: uncertain dispatch never observes or reattaches a substitute run', () => {
  const transport = createScriptedCursorCloudTransportV1({
    send: [{ throw: true, code: 'transport_lost', message: `lost ${LEAK_MARKER}` }],
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id ?? 'bc-adopted-agent',
      provider_run_id: request.provider_run_id ?? 'run-adopted-arbitrary',
      request_id: request.request_id ?? 'ccr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      branch: request.branch ?? 'cursor/adopted-branch',
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
    })],
    reattach: [(request) => ({
      reattached: true,
      ...identityFields(),
      agent_id: request.agent_id ?? 'bc-adopted-agent',
      provider_run_id: request.provider_run_id ?? 'run-adopted-arbitrary',
      request_id: request.request_id ?? 'ccr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      branch: request.branch ?? 'cursor/adopted-branch',
    })],
  });
  const driver = bindCursorCloudDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatch_uncertain');
  const observed = driver.reconcile(requestFor('reconcile'));
  assert.equal(observed.disposition, 'dispatch_uncertain');
  assert.equal(cursorCloudCallsOf(transport, 'observe').length, 0);
  const restarted = driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' }));
  assert.equal(restarted.disposition, 'dispatch_uncertain');
  assert.equal(cursorCloudCallsOf(transport, 'reattach').length, 0);
  const evidence = inspectCursorCloudLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(evidence.provider_run_id, null);
  assert.notEqual(evidence.branch, 'cursor/adopted-branch');
});

test('blocker 5: hostile cursor count and timing fail closed with content-free evidence', () => {
  const hugeCursor = '7'.repeat(1_000_000);
  const cursorCase = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
      progress: { status: 'running', event_count: 1, elapsed_ms: 20, cursor: hugeCursor },
    })],
  });
  cursorCase.driver.launch(requestFor('launch'));
  const cursorError = errorOf(
    () => cursorCase.driver.reconcile(requestFor('reconcile', { include: ['live_progress'] })),
  );
  assert.equal(cursorError.code, 'invalid_format');
  assert.doesNotMatch(publicErrorBlob(cursorError), /7{32}/u);
  const cursorEvidence = inspectCursorCloudLaneEvidenceV1(cursorCase.driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(cursorEvidence.progress, null);
  assert.doesNotMatch(JSON.stringify(cursorEvidence), /7{32}/u);

  const countCase = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
      progress: { status: 'running', event_count: 1.5, elapsed_ms: 20, cursor: '1' },
    })],
  });
  countCase.driver.launch(requestFor('launch'));
  expectCode(
    () => countCase.driver.reconcile(requestFor('reconcile', { include: ['live_progress'] })),
    'invalid_format',
  );

  const timingCase = launchBound({
    observe: [(request) => ({
      ...identityFields(),
      agent_id: request.agent_id,
      provider_run_id: request.provider_run_id,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      status: 'running',
      head_sha: fixture.base_sha,
      merge_base_sha: fixture.base_sha,
      progress: { status: 'running', event_count: 1, elapsed_ms: -1, cursor: '1' },
    })],
  });
  timingCase.driver.launch(requestFor('launch'));
  expectCode(
    () => timingCase.driver.reconcile(requestFor('reconcile', { include: ['live_progress'] })),
    'invalid_format',
  );
  const timingEvidence = inspectCursorCloudLaneEvidenceV1(timingCase.driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(timingEvidence.progress, null);
});

test('blocker 6: observe cancel and reattach transport exceptions collapse to closed detail', () => {
  const hostile = `Authorization: Bearer sk-live ${LEAK_MARKER} prompt=envelope_text api_key=secret`;
  const observeCase = launchBound({
    observe: [() => {
      throw new Error(hostile);
    }],
  });
  observeCase.driver.launch(requestFor('launch'));
  const observeError = errorOf(() => observeCase.driver.reconcile(requestFor('reconcile')));
  assertClosedPublicError(observeError);
  assert.equal(observeError.code, 'transport_exception');

  const cancelCase = launchBound({
    cancel: [() => {
      const error = new Error(hostile);
      error.code = 'ECONNRESET';
      error.stack = `${hostile}\n    at transport`;
      throw error;
    }],
  });
  cancelCase.driver.launch(requestFor('launch'));
  const cancelError = errorOf(() => cancelCase.driver.cancel(requestFor('cancel')));
  assertClosedPublicError(cancelError);

  const reattachCase = launchBound({
    reattach: [() => {
      throw Object.assign(new Error(hostile), { code: 'provider_unauthorized' });
    }],
  });
  reattachCase.driver.launch(requestFor('launch'));
  const reattachError = errorOf(
    () => reattachCase.driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })),
  );
  assertClosedPublicError(reattachError);
});

test('blocker 7: accepted truncated events store evidence_truncated true never false', () => {
  const transport = createScriptedCursorCloudTransportV1({
    observe: [
      (request) => ({
        ...identityFields(),
        agent_id: request.agent_id,
        provider_run_id: request.provider_run_id,
        request_id: request.request_id,
        branch: CLOUD_FIXTURE_BRANCH,
        status: 'running',
        head_sha: fixture.base_sha,
        merge_base_sha: fixture.base_sha,
        events: [{ kind: 'truncated', bytes: 8 }, { kind: 'status', bytes: 4 }],
        progress: { status: 'truncated', event_count: 2, elapsed_ms: 9, cursor: '2' },
      }),
      (request) => ({
        ...identityFields(),
        agent_id: request.agent_id,
        provider_run_id: request.provider_run_id,
        request_id: request.request_id,
        branch: CLOUD_FIXTURE_BRANCH,
        status: 'running',
        head_sha: fixture.base_sha,
        merge_base_sha: fixture.base_sha,
        events: [{ kind: 'status', bytes: 4 }],
        progress: { status: 'running', event_count: 3, elapsed_ms: 12, cursor: '3' },
      }),
    ],
  });
  const driver = bindCursorCloudDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  driver.launch(requestFor('launch'));
  driver.reconcile(requestFor('reconcile', { include: ['detailed_events', 'live_progress'] }));
  const first = inspectCursorCloudLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(first.evidence_truncated, true);
  driver.reconcile(requestFor('reconcile', { include: ['detailed_events', 'live_progress'] }));
  const second = inspectCursorCloudLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(second.evidence_truncated, true);
});

const HOSTILE_PROVIDER_TEXT = 'Authorization: Bearer sk-live SECRET prompt=envelope_text api_key=secret';
const HOSTILE_UNKNOWN_KEY = `hostile_${HOSTILE_PROVIDER_TEXT}`;
const HOSTILE_ERROR_MARKERS = [
  HOSTILE_PROVIDER_TEXT, HOSTILE_UNKNOWN_KEY, 'Bearer', 'sk-live', 'SECRET',
  'envelope_text', 'api_key', LEAK_MARKER, CLOUD_FIXTURE_MODEL, CLOUD_FIXTURE_BRANCH,
  CLOUD_FIXTURE_PROVIDER_RUN_ID, CLOUD_FIXTURE_REPO_IDENTITY,
];

function assertContentFreeError(error, label) {
  const blob = publicErrorBlob(error);
  for (const marker of HOSTILE_ERROR_MARKERS) {
    assert.equal(blob.includes(marker), false, `${label} leaked ${marker}`);
  }
}

function observeReceipt(request, overrides = {}) {
  return {
    ...identityFields(),
    agent_id: request.agent_id,
    provider_run_id: request.provider_run_id,
    request_id: request.request_id,
    branch: CLOUD_FIXTURE_BRANCH,
    status: 'running',
    head_sha: fixture.base_sha,
    merge_base_sha: fixture.base_sha,
    linear_history: true,
    events: [],
    progress: { status: 'running', event_count: 0, elapsed_ms: 1, cursor: '1' },
    cursor: '1',
    elapsed_ms: 1,
    event_count: 0,
    ...overrides,
  };
}

function cancelReceipt(request, overrides = {}) {
  return {
    outcome: 'cancel_confirmed',
    archived: true,
    agent_id: request.agent_id,
    provider_run_id: request.provider_run_id,
    request_id: request.request_id,
    branch: CLOUD_FIXTURE_BRANCH,
    ...identityFields(),
    ...overrides,
  };
}

function reattachReceipt(request, overrides = {}) {
  return {
    reattached: true,
    agent_id: request.agent_id,
    provider_run_id: request.provider_run_id,
    request_id: request.request_id,
    branch: CLOUD_FIXTURE_BRANCH,
    ...identityFields(),
    ...overrides,
  };
}

test('reconstruction: eight identity-value and unknown-key receipt cases stay content-free', () => {
  const cases = [
    {
      label: 'preflight-identity',
      operation: 'preflight',
      code: 'stale_identity_denied',
      script: { preflight: [readyPreflightReceipt({ provider: HOSTILE_PROVIDER_TEXT })] },
      act: (driver) => driver.preflight(requestFor('preflight')),
    },
    {
      label: 'preflight-unknown-key',
      operation: 'preflight',
      code: 'unknown_key',
      script: { preflight: [readyPreflightReceipt({ [HOSTILE_UNKNOWN_KEY]: true })] },
      act: (driver) => driver.preflight(requestFor('preflight')),
    },
    {
      label: 'observe-identity',
      operation: 'observe',
      code: 'stale_identity_denied',
      script: { observe: [(request) => observeReceipt(request, { provider: HOSTILE_PROVIDER_TEXT })] },
      act: (driver) => driver.reconcile(requestFor('reconcile')),
    },
    {
      label: 'observe-unknown-key',
      operation: 'observe',
      code: 'unknown_key',
      script: { observe: [(request) => observeReceipt(request, { [HOSTILE_UNKNOWN_KEY]: true })] },
      act: (driver) => driver.reconcile(requestFor('reconcile')),
    },
    {
      label: 'cancel-identity',
      operation: 'cancel',
      code: 'stale_identity_denied',
      script: { cancel: [(request) => cancelReceipt(request, { provider: HOSTILE_PROVIDER_TEXT })] },
      act: (driver) => driver.cancel(requestFor('cancel')),
    },
    {
      label: 'cancel-unknown-key',
      operation: 'cancel',
      code: 'unknown_key',
      script: { cancel: [(request) => cancelReceipt(request, { [HOSTILE_UNKNOWN_KEY]: true })] },
      act: (driver) => driver.cancel(requestFor('cancel')),
    },
    {
      label: 'reattach-identity',
      operation: 'reattach',
      code: 'stale_identity_denied',
      script: { reattach: [(request) => reattachReceipt(request, { provider: HOSTILE_PROVIDER_TEXT })] },
      act: (driver) => driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })),
    },
    {
      label: 'reattach-unknown-key',
      operation: 'reattach',
      code: 'unknown_key',
      script: { reattach: [(request) => reattachReceipt(request, { [HOSTILE_UNKNOWN_KEY]: true })] },
      act: (driver) => driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' })),
    },
  ];

  for (const testCase of cases) {
    const transport = createScriptedCursorCloudTransportV1(testCase.script);
    const driver = bindCursorCloudDriverV1(transport);
    if (testCase.operation !== 'preflight') {
      driver.preflight(requestFor('preflight'));
      assert.equal(driver.launch(requestFor('launch')).disposition, 'dispatched', testCase.label);
    }
    const thrown = errorOf(() => testCase.act(driver));
    assert.equal(thrown.code, testCase.code, testCase.label);
    assert.equal(thrown.path, `cursor_cloud_transport.${testCase.operation}`, testCase.label);
    assert.equal(thrown.name, 'RunContractV1Error', testCase.label);
    assertClosedPublicError(thrown);
    assertContentFreeError(thrown, testCase.label);
    if (testCase.operation === 'preflight') {
      assert.equal(cursorCloudCallsOf(transport, 'create').length, 0, testCase.label);
    } else {
      const evidence = inspectCursorCloudLaneEvidenceV1(driver, {
        run_id: fixture.run_id,
        assignment_id: fixture.assignment_id,
        child_envelope_digest: fixture.child_envelope_digest,
      });
      const evidenceJson = JSON.stringify(evidence);
      assert.equal(evidenceJson.includes(HOSTILE_PROVIDER_TEXT), false, testCase.label);
      assert.equal(evidenceJson.includes(HOSTILE_UNKNOWN_KEY), false, testCase.label);
      assert.equal(evidenceJson.includes('sk-live'), false, testCase.label);
    }
  }
});

test('reconstruction: create and send malformed receipts are content-free dispatch_uncertain', () => {
  const createHostile = launchBound({
    create: [(request) => ({
      created: true,
      agent_id: request.proposed_agent_id,
      ...identityFields(),
      provider: HOSTILE_PROVIDER_TEXT,
    })],
  });
  const created = createHostile.driver.launch(requestFor('launch'));
  assert.equal(created.disposition, 'dispatch_uncertain');
  assert.equal(created.detail_code, undefined);
  assert.equal(created.detail_message, undefined);
  assert.equal(JSON.stringify(created).includes(HOSTILE_PROVIDER_TEXT), false);
  assert.equal(JSON.stringify(created).includes('SECRET'), false);
  expectCode(() => createHostile.driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(cursorCloudCallsOf(createHostile.transport, 'send').length, 0);
  assert.equal(cursorCloudCallsOf(createHostile.transport, 'create').length, 1);
  const createEvidence = inspectCursorCloudLaneEvidenceV1(createHostile.driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(JSON.stringify(createEvidence).includes(HOSTILE_PROVIDER_TEXT), false);
  assert.equal(JSON.stringify(createEvidence).includes(HOSTILE_UNKNOWN_KEY), false);

  const createUnknown = launchBound({
    create: [(request) => ({
      created: true,
      agent_id: request.proposed_agent_id,
      ...identityFields(),
      [HOSTILE_UNKNOWN_KEY]: HOSTILE_PROVIDER_TEXT,
    })],
  });
  const createdUnknown = createUnknown.driver.launch(requestFor('launch'));
  assert.equal(createdUnknown.disposition, 'dispatch_uncertain');
  assert.equal(JSON.stringify(createdUnknown).includes(HOSTILE_UNKNOWN_KEY), false);
  assert.equal(JSON.stringify(createdUnknown).includes('api_key'), false);
  expectCode(() => createUnknown.driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(cursorCloudCallsOf(createUnknown.transport, 'send').length, 0);

  const sendHostile = launchBound({
    send: [(request) => ({
      acknowledged: true,
      agent_id: request.agent_id,
      provider_run_id: CLOUD_FIXTURE_PROVIDER_RUN_ID,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      ...identityFields(),
      provider: HOSTILE_PROVIDER_TEXT,
    })],
  });
  const sent = sendHostile.driver.launch(requestFor('launch'));
  assert.equal(sent.disposition, 'dispatch_uncertain');
  assert.equal(JSON.stringify(sent).includes(HOSTILE_PROVIDER_TEXT), false);
  expectCode(() => sendHostile.driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(cursorCloudCallsOf(sendHostile.transport, 'send').length, 1);
  const sendEvidence = inspectCursorCloudLaneEvidenceV1(sendHostile.driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(JSON.stringify(sendEvidence).includes(HOSTILE_PROVIDER_TEXT), false);

  const sendUnknown = launchBound({
    send: [(request) => ({
      acknowledged: true,
      agent_id: request.agent_id,
      provider_run_id: CLOUD_FIXTURE_PROVIDER_RUN_ID,
      request_id: request.request_id,
      branch: CLOUD_FIXTURE_BRANCH,
      ...identityFields(),
      [HOSTILE_UNKNOWN_KEY]: true,
    })],
  });
  const sentUnknown = sendUnknown.driver.launch(requestFor('launch'));
  assert.equal(sentUnknown.disposition, 'dispatch_uncertain');
  assert.equal(JSON.stringify(sentUnknown).includes(HOSTILE_UNKNOWN_KEY), false);
  expectCode(() => sendUnknown.driver.launch(requestFor('launch')), 'replay_denied');
});

test('reconstruction: caller-request validation is not collapsed to the receipt boundary', () => {
  const { driver } = launchBound();
  driver.launch(requestFor('launch'));
  const replay = errorOf(() => driver.launch(requestFor('launch')));
  assert.equal(replay.code, 'replay_denied');
  assert.equal(replay.path, 'driver.launch.request');
  assert.match(replay.message, /never replayed/u);
});
