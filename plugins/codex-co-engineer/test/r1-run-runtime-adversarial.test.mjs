// P33 run-runtime adversarial coverage: hostile keys, proxies, accessors,
// replay/fallback/direct-mode/merge authority, leaked secrets, forged
// receipts, and denied remote mutation.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { createRunRuntime } from '../mcp/v3/run-runtime.mjs';
import {
  ASSIGNMENT_ID,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  TASK_ID,
  createClock,
  createLifecycleFns,
  createMemoryAggregateAnchor,
  createMemoryArtifactBridge,
  createMemoryAttentionBatch,
  createMemoryRunJournal,
  createMemoryRunStore,
  createMemoryScheduler,
  createRuntime,
  makeAssignment,
  makeSubmitRequest,
} from './fixtures/r1-run-runtime-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      assert.equal(utilTypes.isProxy(error), false);
      return error;
    });
}

function assertContentFree(error) {
  const text = `${error.code}|${error.path}|${error.message}`;
  assert.equal(text.includes(HOSTILE_SECRET), false);
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_TOKEN), false);
  assert.equal(text.includes('/tmp'), false);
  assert.equal(text.includes('github.com'), false);
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= 200);
}

function countingProxy(target) {
  let gets = 0;
  return {
    proxy: new Proxy(target, {
      get(object, key, receiver) {
        gets += 1;
        return Reflect.get(object, key, receiver);
      },
    }),
    gets: () => gets,
  };
}

test('proxy, symbol, and accessor inputs fail closed without invoking traps', async () => {
  const { runtime } = createRuntime();
  const proxy = countingProxy(makeSubmitRequest());
  const proxyError = await errorOf(() => runtime.submitRun(proxy.proxy));
  assert.equal(proxyError.code, 'proxy_denied');
  assert.equal(proxy.gets(), 0);
  assertContentFree(proxyError);

  const symbolled = makeSubmitRequest();
  Object.defineProperty(symbolled, Symbol('secret'), { value: HOSTILE_SECRET, enumerable: true });
  const symbolError = await errorOf(() => runtime.submitRun(symbolled));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assertContentFree(symbolError);

  const accessor = makeSubmitRequest();
  Object.defineProperty(accessor, 'trap', {
    enumerable: true,
    get() { throw new Error(HOSTILE_SECRET); },
  });
  const accessorError = await errorOf(() => runtime.submitRun(accessor));
  assert.ok(['accessor_property_denied', 'unknown_key', 'exotic_prototype_denied']
    .includes(accessorError.code));
  assertContentFree(accessorError);
});

test('replay, fallback, direct-mode, merge, and GitHub keys fail with precise codes', async () => {
  const { runtime } = createRuntime();
  const request = makeSubmitRequest();
  const cases = [
    ['fallback', 'replay_or_fallback_denied'],
    ['replay', 'replay_or_fallback_denied'],
    ['workspace_mode', 'direct_mode_rejected'],
    ['direct_mode', 'direct_mode_rejected'],
    ['merge', 'merge_authority_denied'],
    ['push', 'merge_authority_denied'],
    ['create_pr', 'merge_authority_denied'],
    ['github', 'remote_mutation_denied'],
    ['remote', 'remote_mutation_denied'],
    ['worktree', 'lifecycle_authority_denied'],
    ['lock', 'lifecycle_authority_denied'],
    ['candidate', 'candidate_authority_denied'],
    ['lifecycle_root', 'lifecycle_authority_denied'],
  ];
  for (const [key, code] of cases) {
    const error = await errorOf(() => runtime.submitRun({ ...request, [key]: true }));
    assert.equal(error.code, code, key);
    assertContentFree(error);
  }
});

test('unknown assignment, cursor mismatch, and unknown run fail closed', async () => {
  const harness = createRuntime();
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);

  const unknownRun = await errorOf(() => harness.runtime.inspectRun({ run_id: 'missing-run-id' }));
  assert.equal(unknownRun.code, 'runtime_run_unknown');
  assertContentFree(unknownRun);

  const unknownAssignment = await errorOf(() => harness.runtime.cancelRun({
    run_id: request.run_id,
    assignment_ids: ['not-in-run'],
  }));
  assert.equal(unknownAssignment.code, 'runtime_assignment_unknown');
  assertContentFree(unknownAssignment);

  const cursor = await errorOf(() => harness.runtime.resumeRun({
    run_id: request.run_id,
    cursors: [{ assignment_id: ASSIGNMENT_ID, task_id: 'forged-task', event_cursor: '1' }],
  }));
  assert.equal(cursor.code, 'cursor_identity_mismatch');
  assertContentFree(cursor);
});

test('injected lifecycle throws are mapped to content-free runtime_lifecycle_failed', async () => {
  const harness = createRuntime({
    scheduler: createMemoryScheduler({
      inspectStatusByAssignment: new Map([[ASSIGNMENT_ID, 'completed']]),
    }),
    lifecycle: createLifecycleFns({ failSettle: true }),
  });
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  const error = await errorOf(() => harness.runtime.resumeRun({ run_id: request.run_id }));
  assert.equal(error.code, 'runtime_lifecycle_failed');
  assertContentFree(error);
  assert.equal(error.message.includes(HOSTILE_SECRET), false);
});

test('invalid clocks and missing assignment bounds fail closed', async () => {
  const harness = createRuntime({ clock: () => 'not-a-timestamp' });
  const error = await errorOf(() => harness.runtime.submitRun(makeSubmitRequest()));
  assert.equal(error.code, 'invalid_clock');
  assertContentFree(error);

  const empty = await errorOf(() => createRuntime().runtime.submitRun({
    ...makeSubmitRequest(),
    assignments: [],
  }));
  assert.equal(empty.code, 'out_of_range');

  const nine = Array.from({ length: 9 }, (_, index) => makeAssignment({
    assignmentId: `lane-${index}`,
    taskId: `task-${index}`,
    writeScope: [`src/${index}/**`],
  }));
  const overflow = await errorOf(() => createRuntime().runtime.submitRun({
    ...makeSubmitRequest(),
    assignments: nine,
  }));
  assert.equal(overflow.code, 'out_of_range');
});

test('duplicate assignment ids are denied before dispatch', async () => {
  const error = await errorOf(() => createRuntime().runtime.submitRun({
    ...makeSubmitRequest(),
    assignments: [makeAssignment(), makeAssignment()],
  }));
  assert.equal(error.code, 'duplicate_assignment_id');
  assertContentFree(error);
});

test('injected objects missing required methods fail at factory time', () => {
  const store = createMemoryRunStore();
  const journal = createMemoryRunJournal();
  const anchor = createMemoryAggregateAnchor();
  const attention = createMemoryAttentionBatch();
  const scheduler = createMemoryScheduler();
  const artifacts = createMemoryArtifactBridge();
  const lifecycle = createLifecycleFns();
  assert.throws(() => createRunRuntime({
    runStore: { submit: store.submit },
    runJournal: journal,
    aggregateAnchor: anchor,
    attentionBatch: attention,
    scheduler,
    artifactBridge: artifacts,
    settleLocalTaskLifecycle: lifecycle.settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle: lifecycle.cleanupLocalTaskLifecycle,
    clock: createClock(),
  }), (error) => error.code === 'injected_dependency_invalid');
});

test('remote git mutation stays denied after a successful submit', async () => {
  const harness = createRuntime();
  const receipt = await harness.runtime.submitRun(makeSubmitRequest());
  assert.equal(receipt.remote_mutated, false);
  assert.equal(receipt.side_effects.remote_mutated, false);
  const gitPush = spawnSync('git', ['push', '--dry-run'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.notEqual(gitPush.status, 0);
});

test('forged inspect receipts cannot broaden path or candidate authority', async () => {
  const harness = createRuntime();
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  for (const key of ['worktree', 'branch', 'lock', 'candidate', 'github']) {
    const error = await errorOf(() => harness.runtime.inspectRun({
      run_id: request.run_id,
      [key]: HOSTILE_PATH,
    }));
    assert.ok([
      'unknown_key',
      'lifecycle_authority_denied',
      'candidate_authority_denied',
      'remote_mutation_denied',
    ].includes(error.code), key);
    assertContentFree(error);
  }
});

test('resume of a cancelled lane does not redispatch', async () => {
  const harness = createRuntime();
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  await harness.runtime.cancelRun({
    run_id: request.run_id,
    assignment_ids: [ASSIGNMENT_ID],
  });
  harness.scheduler.inspectStatusByAssignment.set(ASSIGNMENT_ID, 'cancelled');
  const resumed = await harness.runtime.resumeRun({ run_id: request.run_id });
  assert.equal(harness.scheduler.calls.submit, 1);
  assert.equal(resumed.lanes[0].status, 'cancelled');
  assert.equal(resumed.side_effects.replay, false);
  assert.equal(resumed.side_effects.duplicate_dispatch, false);
});
