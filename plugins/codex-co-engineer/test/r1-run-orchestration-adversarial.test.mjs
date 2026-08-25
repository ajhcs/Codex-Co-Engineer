// P31 run orchestration — adversarial coverage: hostile preflight and
// capacity denials create zero side effects, env/argv isolation holds,
// getters and proxies never run, dispatch is not a hidden default,
// concurrent identical runs cannot share a handoff, forged receipts cannot
// cancel live lanes, cleanup failures stay truthful, and remote mutation
// remains denied.

import assert from 'node:assert/strict';
import { Buffer as NodeBuffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import test from 'node:test';

import {
  CredentialBoundaryError,
  collectLaneSecrets,
} from '../mcp/v3/credential-boundary.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  cancelRunDispatchV1,
  completeRunDispatchV1,
  denyRunRemoteMutationV1,
  orchestrateRunDispatchV1,
  restartRunDispatchV1,
} from '../mcp/v3/run-orchestration.mjs';
import {
  ASSIGNMENT_ID_A,
  ASSIGNMENT_ID_B,
  HOSTILE_ENV,
  SUFFICIENT_HOST,
  createLinearRepo,
  createRecordingDispatcher,
  createRecordingSpawn,
  handoffPathFromProcessIdentity,
  hostFacts,
  injectHandoffUnlinkFailure,
  laneManifestsForCount,
  restoreInjectedHandoffUnlinkFailure,
  snapshotState,
  twoLaneOrchestrationManifest,
  writerLane,
  preflightManifest,
  receiptContainsSecret,
} from './fixtures/r1-run-orchestration-fixtures.mjs';

const SECRETS = collectLaneSecrets(HOSTILE_ENV);

async function expectCode(promise, code, ErrorType = RunContractV1Error) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}, got ${error}`);
    assert.equal(error.code, code, error.message);
    assert.ok(NodeBuffer.byteLength(error.message, 'utf8') <= 200);
    return error;
  }
  throw new Error(`expected failure with code ${code}`);
}

test('capacity denial fails closed without projection, dispatch, or workspace mutation', async () => {
  const repo = await createLinearRepo('p31-cpu-');
  const dispatcher = createRecordingDispatcher();
  const recording = createRecordingSpawn();
  let envReads = 0;
  const env = new Proxy(HOSTILE_ENV, {
    get(target, property, receiver) {
      envReads += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) {
      envReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  try {
    const before = await snapshotState(repo.root);
    const error = await expectCode(
      orchestrateRunDispatchV1(
        {
          manifest: twoLaneOrchestrationManifest({
            repositoryPath: repo.root, baseSha: repo.baseSha,
          }),
          intent: 'dispatch',
        },
        {
          host: hostFacts({ cpu_parallelism: 0 }),
          env,
          spawn: recording.spawn,
          dispatch: dispatcher.dispatch,
        },
      ),
      'host_cpu_capacity_exceeded',
    );
    assert.ok(error instanceof RunContractV1Error);
    assert.equal(dispatcher.calls.length, 0);
    assert.equal(recording.records.length, 0);
    assert.equal(envReads, 0);
    assert.deepEqual(await snapshotState(repo.root), before);
  } finally {
    await repo.cleanup();
  }
});

test('RAM capacity denial does not read env or invoke dispatch', async () => {
  const repo = await createLinearRepo('p31-ram-');
  const dispatcher = createRecordingDispatcher();
  let envAccessed = false;
  const options = {
    host: hostFacts({ available_ram_bytes: 1 }),
    dispatch: dispatcher.dispatch,
  };
  Object.defineProperty(options, 'env', {
    enumerable: true,
    get() {
      envAccessed = true;
      throw new Error('env getter must never run');
    },
  });
  try {
    const before = await snapshotState(repo.root);
    await expectCode(
      orchestrateRunDispatchV1(
        {
          manifest: twoLaneOrchestrationManifest({
            repositoryPath: repo.root, baseSha: repo.baseSha,
          }),
          intent: 'dispatch',
        },
        options,
      ),
      'host_ram_capacity_exceeded',
    );
    assert.equal(envAccessed, false);
    assert.equal(dispatcher.calls.length, 0);
    assert.deepEqual(await snapshotState(repo.root), before);
  } finally {
    await repo.cleanup();
  }
});

test('hostile preflight inputs fail before dispatch and leave the world identical', async () => {
  const repo = await createLinearRepo('p31-hostile-');
  const dispatcher = createRecordingDispatcher();
  try {
    const before = await snapshotState(repo.root);
    const base = twoLaneOrchestrationManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha,
    });
    await expectCode(
      orchestrateRunDispatchV1(
        { manifest: new Proxy(base, {}), intent: 'dispatch' },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
      ),
      'proxy_denied',
    );
    const withSymbol = { manifest: structuredClone(base), intent: 'prepare' };
    Object.defineProperty(withSymbol, Symbol('poison'), {
      enumerable: true,
      get() { throw new Error('symbol getter must never run'); },
    });
    await expectCode(
      orchestrateRunDispatchV1(withSymbol, { host: SUFFICIENT_HOST, dispatch: dispatcher.dispatch }),
      'symbol_key_denied',
    );
    await expectCode(
      orchestrateRunDispatchV1(
        {
          manifest: laneManifestsForCount(9, {
            repositoryPath: repo.root, baseSha: repo.baseSha,
          }),
          intent: 'dispatch',
        },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
      ),
      'preflight_child_count_exceeded',
    );
    await expectCode(
      orchestrateRunDispatchV1(
        {
          manifest: preflightManifest([
            writerLane('lane-overlap-a', ['src/shared/**']),
            writerLane('lane-overlap-b', ['src/shared/nested/**']),
          ], { repositoryPath: repo.root, baseSha: repo.baseSha }),
          intent: 'dispatch',
        },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
      ),
      'overlapping_writer_scope',
    );
    assert.equal(dispatcher.calls.length, 0);
    assert.deepEqual(await snapshotState(repo.root), before);
  } finally {
    await repo.cleanup();
  }
});

test('unknown intent and missing dispatcher fail closed without a handoff', async () => {
  const repo = await createLinearRepo('p31-intent-');
  try {
    const before = await snapshotState(repo.root);
    await expectCode(
      orchestrateRunDispatchV1(
        {
          manifest: twoLaneOrchestrationManifest({
            repositoryPath: repo.root, baseSha: repo.baseSha,
          }),
          intent: 'launch',
        },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV },
      ),
      'orchestration_intent_invalid',
    );
    const error = await expectCode(
      orchestrateRunDispatchV1(
        {
          manifest: twoLaneOrchestrationManifest({
            repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-no-dispatch',
          }),
          intent: 'dispatch',
        },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV },
      ),
      'orchestration_dispatcher_required',
    );
    assert.equal(error.message.includes(repo.root), false);
    assert.deepEqual(await snapshotState(repo.root), before);
  } finally {
    await repo.cleanup();
  }
});

test('unresolved lanes may prepare but cannot dispatch', async () => {
  const repo = await createLinearRepo('p31-unresolved-');
  const dispatcher = createRecordingDispatcher();
  try {
    const manifest = twoLaneOrchestrationManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-unresolved',
    });
    delete manifest.assignments[0].execution;
    const prepared = await orchestrateRunDispatchV1(
      { manifest, intent: 'prepare' },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
    );
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.lanes[0].status, 'selection_unresolved');
    assert.equal(dispatcher.calls.length, 0);
    await expectCode(
      orchestrateRunDispatchV1(
        { manifest, intent: 'dispatch' },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
      ),
      'orchestration_selection_unresolved',
    );
    assert.equal(dispatcher.calls.length, 0);
    await assert.rejects(
      () => lstat(handoffPathFromProcessIdentity(prepared.lanes[0].identity)),
      { code: 'ENOENT' },
    );
  } finally {
    await repo.cleanup();
  }
});

function assertNoSecret(value) {
  assert.equal(receiptContainsSecret(value, SECRETS), false);
}

async function expectMissing(filePath) {
  await assert.rejects(() => lstat(filePath), { code: 'ENOENT' });
}

test('concurrent identical run_id+assignment_id executions never share a handoff', async () => {
  const repo = await createLinearRepo('p31-adv-collide-');
  const firstDispatcher = createRecordingDispatcher();
  const secondDispatcher = createRecordingDispatcher();
  try {
    const manifest = twoLaneOrchestrationManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-hostile-collide',
    });
    const [first, second] = await Promise.all([
      orchestrateRunDispatchV1(
        { manifest, intent: 'dispatch' },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: firstDispatcher.dispatch },
      ),
      orchestrateRunDispatchV1(
        { manifest, intent: 'dispatch' },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: secondDispatcher.dispatch },
      ),
    ]);
    const firstIdentities = first.lanes.map((lane) => lane.identity);
    const secondIdentities = second.lanes.map((lane) => lane.identity);
    assert.equal(new Set([...firstIdentities, ...secondIdentities]).size, 4);
    for (const identity of firstIdentities) {
      assert.equal(secondIdentities.includes(identity), false);
    }
    const cancelledFirst = await cancelRunDispatchV1(first);
    assert.equal(cancelledFirst.cleaned, true);
    for (const identity of firstIdentities) {
      await expectMissing(handoffPathFromProcessIdentity(identity));
    }
    for (const identity of secondIdentities) {
      const metadata = await lstat(handoffPathFromProcessIdentity(identity));
      assert.equal(metadata.isFile(), true);
    }
    const cancelledSecond = await cancelRunDispatchV1(second);
    assert.equal(cancelledSecond.cleaned, true);
    for (const identity of secondIdentities) {
      await expectMissing(handoffPathFromProcessIdentity(identity));
    }
  } finally {
    await repo.cleanup();
  }
});

test('cross-cancel of one concurrent run cannot delete the other run handoff', async () => {
  const repo = await createLinearRepo('p31-cross-cancel-');
  try {
    const manifest = twoLaneOrchestrationManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-cross-cancel',
    });
    const first = await orchestrateRunDispatchV1(
      { manifest, intent: 'dispatch' },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: createRecordingDispatcher().dispatch },
    );
    const second = await orchestrateRunDispatchV1(
      { manifest, intent: 'dispatch' },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: createRecordingDispatcher().dispatch },
    );
    const survivor = second.lanes.map((lane) => lane.identity);
    await cancelRunDispatchV1(first);
    for (const identity of survivor) {
      const metadata = await lstat(handoffPathFromProcessIdentity(identity));
      assert.equal(metadata.isFile(), true);
    }
    await cancelRunDispatchV1(second);
  } finally {
    await repo.cleanup();
  }
});

test('forged and unknown receipts cannot touch live handoffs', async () => {
  const repo = await createLinearRepo('p31-forged-receipt-');
  const dispatcher = createRecordingDispatcher();
  try {
    const receipt = await orchestrateRunDispatchV1(
      {
        manifest: twoLaneOrchestrationManifest({
          repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-forged',
        }),
        intent: 'dispatch',
      },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
    );
    const liveIdentities = receipt.lanes.map((lane) => lane.identity);
    const stolenIdentity = liveIdentities[0];
    const cloned = JSON.parse(JSON.stringify(receipt));
    const forged = {
      schema: receipt.schema,
      version: receipt.version,
      status: receipt.status,
      run_id: receipt.run_id,
      lanes: receipt.lanes.map((lane) => ({
        assignment_id: lane.assignment_id,
        identity: lane.identity,
      })),
    };
    const pathInjected = {
      ...cloned,
      lanes: [
        {
          assignment_id: ASSIGNMENT_ID_A,
          identity: '/tmp/cce-p29-deadbeefdeadbeefdeadbeefdeadbeef/env.json',
        },
      ],
    };
    await expectCode(cancelRunDispatchV1(cloned), 'orchestration_session_unknown');
    await expectCode(completeRunDispatchV1(forged), 'orchestration_session_unknown');
    await expectCode(restartRunDispatchV1(pathInjected), 'orchestration_session_unknown');
    await expectCode(cancelRunDispatchV1({}), 'orchestration_session_unknown');
    await expectCode(cancelRunDispatchV1(null), 'orchestration_session_unknown');
    await expectCode(
      cancelRunDispatchV1(new Proxy(receipt, {})),
      'proxy_denied',
    );
    for (const identity of liveIdentities) {
      const metadata = await lstat(handoffPathFromProcessIdentity(identity));
      assert.equal(metadata.isFile(), true);
    }
    assert.equal(stolenIdentity.length, 32);
    const cancelled = await cancelRunDispatchV1(receipt);
    assert.equal(cancelled.cleaned, true);
  } finally {
    await repo.cleanup();
  }
});

test('injected handoff unlink failure stays unresolved and does not skip sibling lanes', async () => {
  const repo = await createLinearRepo('p31-unlink-fail-');
  const dispatcher = createRecordingDispatcher();
  let injected = null;
  try {
    const receipt = await orchestrateRunDispatchV1(
      {
        manifest: twoLaneOrchestrationManifest({
          repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-unlink-fail',
        }),
        intent: 'dispatch',
      },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
    );
    const failedLane = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID_A);
    const sibling = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID_B);
    injected = await injectHandoffUnlinkFailure(failedLane.identity);
    const cancelled = await cancelRunDispatchV1(receipt);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cleaned, false);
    assert.deepEqual([...cancelled.unresolved], [
      { assignment_id: ASSIGNMENT_ID_A, code: 'handoff_cleanup_failed' },
    ]);
    assertNoSecret(cancelled);
    assert.equal(JSON.stringify(cancelled).includes(injected.filePath), false);
    const trap = await lstat(injected.filePath);
    assert.equal(trap.isDirectory(), true);
    await expectMissing(handoffPathFromProcessIdentity(sibling.identity));
  } finally {
    if (injected) await restoreInjectedHandoffUnlinkFailure(injected.filePath);
    await repo.cleanup();
  }
});

test('cancel terminal and restart stay truthful when stop or unlink fails', async () => {
  const repo = await createLinearRepo('p31-truthful-');
  try {
    const stopDispatcher = createRecordingDispatcher({ failStopFor: ASSIGNMENT_ID_A });
    const stopReceipt = await orchestrateRunDispatchV1(
      {
        manifest: twoLaneOrchestrationManifest({
          repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-stop-fail',
        }),
        intent: 'dispatch',
      },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: stopDispatcher.dispatch },
    );
    const cancelled = await cancelRunDispatchV1(stopReceipt);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cleaned, false);
    assert.deepEqual([...cancelled.unresolved], [
      { assignment_id: ASSIGNMENT_ID_A, code: 'dispatcher_stop_failed' },
    ]);
    assertNoSecret(cancelled);
    for (const lane of stopReceipt.lanes) {
      await expectMissing(handoffPathFromProcessIdentity(lane.identity));
    }

    const terminalDispatcher = createRecordingDispatcher({ failStopFor: ASSIGNMENT_ID_B });
    const terminalReceipt = await orchestrateRunDispatchV1(
      {
        manifest: twoLaneOrchestrationManifest({
          repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-terminal-fail',
        }),
        intent: 'dispatch',
      },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: terminalDispatcher.dispatch },
    );
    const terminal = await completeRunDispatchV1(terminalReceipt);
    assert.equal(terminal.status, 'terminal');
    assert.equal(terminal.cleaned, false);
    assert.deepEqual([...terminal.unresolved], [
      { assignment_id: ASSIGNMENT_ID_B, code: 'dispatcher_stop_failed' },
    ]);
    assertNoSecret(terminal);

    const restartDispatcher = createRecordingDispatcher();
    const restartReceipt = await orchestrateRunDispatchV1(
      {
        manifest: twoLaneOrchestrationManifest({
          repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-restart-fail',
        }),
        intent: 'dispatch',
      },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: restartDispatcher.dispatch },
    );
    const failedLane = restartReceipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID_A);
    const sibling = restartReceipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID_B);
    const injected = await injectHandoffUnlinkFailure(failedLane.identity);
    try {
      const restarted = await restartRunDispatchV1(restartReceipt, {
        dispatch: restartDispatcher.dispatch,
      });
      assert.equal(restarted.restarted, false);
      assert.equal(restarted.cleaned, false);
      assert.deepEqual([...restarted.unresolved], [
        { assignment_id: ASSIGNMENT_ID_A, code: 'handoff_cleanup_failed' },
      ]);
      assertNoSecret(restarted);
      assert.equal(restartDispatcher.calls.length, 2);
      await expectMissing(handoffPathFromProcessIdentity(sibling.identity));
    } finally {
      await restoreInjectedHandoffUnlinkFailure(injected.filePath);
    }
  } finally {
    await repo.cleanup();
  }
});

test('content-free errors never echo secrets, paths, or denied operations', async () => {
  const repo = await createLinearRepo('p31-redact-');
  try {
    const error = await expectCode(
      orchestrateRunDispatchV1(
        {
          manifest: twoLaneOrchestrationManifest({
            repositoryPath: repo.root, baseSha: repo.baseSha,
          }),
        },
        { host: hostFacts({ cpu_parallelism: 0 }), env: HOSTILE_ENV },
      ),
      'host_cpu_capacity_exceeded',
    );
    assert.equal(error.message.includes(HOSTILE_ENV.XAI_API_KEY), false);
    assert.equal(error.message.includes(repo.root), false);
    try {
      denyRunRemoteMutationV1('push');
    } catch (denied) {
      assert.ok(denied instanceof CredentialBoundaryError);
      assert.equal(denied.message.includes('push'), false);
      assert.match(denied.message, /^[A-Za-z0-9_=.:/\[\]()";', -]+$/u);
    }
  } finally {
    await repo.cleanup();
  }
});
