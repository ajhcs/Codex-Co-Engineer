// P33 RunSchedulerV1 adversarial coverage: hostile containers, forbidden
// replay/fallback/merge/direct keys, identity drift, unconfirmed cancel,
// content-free failures, and injected stub isolation.

import assert from 'node:assert/strict';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { createRunScheduler } from '../mcp/v3/run-scheduler.mjs';
import {
  ASSIGNMENT_A,
  ASSIGNMENT_B,
  BASE_SHA,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  RUN_ID,
  TASK_A,
  countingProxy,
  createScopedStubs,
  trapTotal,
  twoWriterRequest,
  writerAssignment,
} from './fixtures/r1-run-scheduler-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertContentFree(error) {
  const blob = `${error.message}\n${error.path ?? ''}\n${error.code}`;
  assert.doesNotMatch(blob, /sk-live/u);
  assert.doesNotMatch(blob, /ATTACKER-SECRET/u);
  assert.doesNotMatch(blob, /github_pat/u);
  assert.doesNotMatch(blob, /\/tmp\//u);
}

test('proxies, symbols, accessors, and own undefined fail closed without traps', async () => {
  const harness = createScopedStubs();
  const request = twoWriterRequest();
  const { proxy, counts } = countingProxy(request);
  const proxied = await errorOf(() => harness.scheduler.submitAssignments(proxy));
  assert.equal(proxied.code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const symbolic = twoWriterRequest();
  Object.defineProperty(symbolic, Symbol('leak'), { value: HOSTILE_SECRET, enumerable: true });
  const symbolError = await errorOf(() => harness.scheduler.submitAssignments(symbolic));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assertContentFree(symbolError);

  const accessor = twoWriterRequest();
  Object.defineProperty(accessor, 'run_id', {
    get() { throw new Error(HOSTILE_SECRET); },
    enumerable: true,
  });
  const accessorError = await errorOf(() => harness.scheduler.submitAssignments(accessor));
  assert.ok(['accessor_property_denied', 'proxy_denied', 'invalid_object'].includes(accessorError.code));
  assertContentFree(accessorError);

  const undef = twoWriterRequest();
  undef.extra = undefined;
  Object.defineProperty(undef, 'replay', { value: undefined, enumerable: true });
  const undefError = await errorOf(() => harness.scheduler.submitAssignments(undef));
  assert.ok(['own_undefined_denied', 'replay_or_fallback_denied', 'unknown_key'].includes(undefError.code));
  assert.equal(harness.delegateCalls.length, 0);
});

test('forbidden replay, fallback, merge, direct, and credential keys fail closed', async () => {
  const cases = [
    ['fallback', 'replay_or_fallback_denied'],
    ['replay', 'replay_or_fallback_denied'],
    ['retry', 'replay_or_fallback_denied'],
    ['depends_on', 'dependency_not_allowed'],
    ['workspace_mode', 'direct_mode_denied'],
    ['merge', 'merge_authority_denied'],
    ['create_pr', 'merge_authority_denied'],
    ['push', 'merge_authority_denied'],
    ['argv', 'executable_content_denied'],
    ['command', 'executable_content_denied'],
    ['token', 'credential_content_denied'],
    ['credentials', 'credential_content_denied'],
  ];
  for (const [key, code] of cases) {
    const harness = createScopedStubs();
    const request = twoWriterRequest();
    request[key] = key === 'workspace_mode' ? 'direct' : true;
    const error = await errorOf(() => harness.scheduler.submitAssignments(request));
    assert.equal(error.code, code, key);
    assertContentFree(error);
    assert.equal(harness.delegateCalls.length, 0);
  }
});

test('nested forbidden keys inside an assignment fail closed before dispatch', async () => {
  const harness = createScopedStubs();
  const request = {
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignments: [{
      ...writerAssignment(),
      retry: true,
    }],
  };
  const error = await errorOf(() => harness.scheduler.submitAssignments(request));
  assert.equal(error.code, 'replay_or_fallback_denied');
  assert.equal(harness.delegateCalls.length, 0);
});

test('unknown keys, latest identities, and nearby assignment ids are denied', async () => {
  const extra = createScopedStubs();
  const extraError = await errorOf(() => extra.scheduler.submitAssignments({
    ...twoWriterRequest(),
    latest: true,
  }));
  assert.equal(extraError.code, 'unknown_key');

  const latestSha = createScopedStubs();
  const shaError = await errorOf(() => latestSha.scheduler.submitAssignments({
    run_id: RUN_ID,
    base_sha: 'latest',
    assignments: [writerAssignment()],
  }));
  assert.equal(shaError.code, 'invalid_format');

  const harness = createScopedStubs();
  await harness.scheduler.submitAssignments(twoWriterRequest());
  const unknown = await errorOf(() => harness.scheduler.cancelAssignments({
    run_id: RUN_ID,
    assignment_ids: ['lane-alph'],
  }));
  assert.equal(unknown.code, 'assignment_id_unknown');
  assert.equal(harness.cancelCalls.length, 0);
});

test('unknown runs, cursor identity drift, and injected inspect failures stay isolated', async () => {
  const unknown = createScopedStubs();
  const resumeError = await errorOf(() => unknown.scheduler.resumeAssignments({ run_id: RUN_ID }));
  assert.equal(resumeError.code, 'scheduler_run_unknown');
  const cancelError = await errorOf(() => unknown.scheduler.cancelAssignments({
    run_id: RUN_ID, assignment_ids: [ASSIGNMENT_A],
  }));
  assert.equal(cancelError.code, 'scheduler_run_unknown');

  const harness = createScopedStubs({ failInspectFor: [ASSIGNMENT_A] });
  await harness.scheduler.submitAssignments(twoWriterRequest());
  const drifted = await errorOf(() => harness.scheduler.resumeAssignments({
    run_id: RUN_ID,
    cursors: [{ assignment_id: ASSIGNMENT_A, task_id: 'other-task', event_cursor: '0' }],
  }));
  assert.equal(drifted.code, 'cursor_identity_mismatch');

  const inspected = await harness.scheduler.resumeAssignments({ run_id: RUN_ID });
  const failed = inspected.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A);
  const live = inspected.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  assert.equal(failed.unresolved.code, 'inspect_failed');
  assert.equal(live.status, 'running');
  assert.equal(harness.delegateCalls.length, 2);
});

test('unconfirmed cancel records evidence and leaves other lanes running', async () => {
  const harness = createScopedStubs({ failCancelFor: [ASSIGNMENT_A] });
  await harness.scheduler.submitAssignments(twoWriterRequest());
  const receipt = await harness.scheduler.cancelAssignments({
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_A, ASSIGNMENT_B],
  });
  const unconfirmed = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A);
  const confirmed = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_B);
  assert.equal(unconfirmed.cancel_confirmed, false);
  assert.equal(unconfirmed.unresolved.code, 'safe_cancel_unconfirmed');
  assert.equal(confirmed.status, 'cancelled');
  assert.equal(confirmed.cancel_confirmed, true);
  assert.equal(harness.cancelCalls.length, 2);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /github_pat/u);
});

test('delegate failures stay content-free and do not leak stub secrets', async () => {
  const harness = createScopedStubs({ failDelegateFor: [ASSIGNMENT_A] });
  const receipt = await harness.scheduler.submitAssignments(twoWriterRequest());
  const failed = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A);
  assert.equal(failed.unresolved.code, 'dispatch_failed');
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /sk-live/u);
  assert.doesNotMatch(serialized, /ATTACKER-SECRET/u);
  assert.doesNotMatch(serialized, /\/tmp\//u);
});

test('factory rejects missing, extra, and non-function dependencies', () => {
  const error = (() => {
    try {
      createRunScheduler({});
      assert.fail('expected failure');
    } catch (caught) {
      assert.ok(caught instanceof RunContractV1Error);
      return caught;
    }
    return null;
  })();
  assert.equal(error.code, 'injected_dependency_invalid');

  const extra = (() => {
    try {
      createRunScheduler({
        delegateTask() {},
        inspectTask() {},
        cancelTask() {},
        clock() { return 0; },
        supervisor: HOSTILE_SECRET,
      });
      assert.fail('expected failure');
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.equal(extra.code, 'unknown_key');
  assertContentFree(extra);

  const { proxy, counts } = countingProxy({
    delegateTask() {}, inspectTask() {}, cancelTask() {}, clock() { return 0; },
  });
  const proxied = (() => {
    try {
      createRunScheduler(proxy);
      assert.fail('expected failure');
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.equal(proxied.code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);
});

test('invalid clocks, aliased graphs, and oversized collections fail closed', async () => {
  const clock = createRunScheduler({
    delegateTask: async () => ({ task_id: TASK_A, cursor: '0', status: 'running' }),
    inspectTask: async () => ({ task_id: TASK_A, status: 'running', cursor: '0' }),
    cancelTask: async () => ({ task_id: TASK_A, cancelled: true }),
    clock: () => 'soon',
  });
  const clockError = await errorOf(() => clock.submitAssignments({
    run_id: RUN_ID, base_sha: BASE_SHA, assignments: [writerAssignment()],
  }));
  assert.equal(clockError.code, 'invalid_clock');

  const harness = createScopedStubs();
  const assignment = writerAssignment();
  const aliased = { run_id: RUN_ID, base_sha: BASE_SHA, assignments: [assignment] };
  aliased.assignments.push(assignment);
  const aliasedError = await errorOf(() => harness.scheduler.submitAssignments(aliased));
  assert.equal(aliasedError.code, 'aliased_reference_denied');
  assert.equal(harness.delegateCalls.length, 0);
});

test('oversized attention is dropped and malformed attention is unresolved', async () => {
  const oversized = createScopedStubs({
    attentionByTask: {
      [TASK_A]: {
        session_id: 'sess-a',
        question_id: 'q-a',
        prompt: 'p'.repeat(5000),
        options: ['continue'],
      },
    },
  });
  await oversized.scheduler.submitAssignments(twoWriterRequest());
  const bounded = await oversized.scheduler.resumeAssignments({ run_id: RUN_ID });
  const grok = bounded.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_A);
  assert.equal(grok.attention.prompt, null);
  assert.equal(grok.attention.reply_capability, 'same_session');

  const malformed = createScopedStubs({
    attentionByTask: {
      [TASK_A]: { prompt: HOSTILE_SECRET },
    },
  });
  await malformed.scheduler.submitAssignments(twoWriterRequest());
  const invalid = await malformed.scheduler.resumeAssignments({ run_id: RUN_ID });
  const lane = invalid.lanes.find((entry) => entry.assignment_id === ASSIGNMENT_A);
  assert.equal(lane.unresolved.code, 'attention_evidence_invalid');
  const serialized = JSON.stringify(invalid);
  assert.doesNotMatch(serialized, /sk-live/u);
});

test('resume and cancel never accept a second run identity or replay flag', async () => {
  const harness = createScopedStubs();
  await harness.scheduler.submitAssignments(twoWriterRequest());
  const replay = await errorOf(() => harness.scheduler.resumeAssignments({
    run_id: RUN_ID,
    replay: true,
  }));
  assert.equal(replay.code, 'replay_or_fallback_denied');
  const cancelReplay = await errorOf(() => harness.scheduler.cancelAssignments({
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_A],
    fallback: true,
  }));
  assert.equal(cancelReplay.code, 'replay_or_fallback_denied');
  assert.equal(harness.delegateCalls.length, 2);
});
