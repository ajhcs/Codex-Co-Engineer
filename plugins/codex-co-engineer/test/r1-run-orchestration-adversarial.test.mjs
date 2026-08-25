// P31 run orchestration — adversarial coverage: hostile preflight and
// capacity denials create zero side effects, env/argv isolation holds,
// getters and proxies never run, dispatch is not a hidden default, and
// remote mutation remains denied.

import assert from 'node:assert/strict';
import { Buffer as NodeBuffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import test from 'node:test';

import { CredentialBoundaryError } from '../mcp/v3/credential-boundary.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  denyRunRemoteMutationV1,
  orchestrateRunDispatchV1,
} from '../mcp/v3/run-orchestration.mjs';
import {
  HOSTILE_ENV,
  SUFFICIENT_HOST,
  createLinearRepo,
  createRecordingDispatcher,
  createRecordingSpawn,
  handoffPathFromProcessIdentity,
  hostFacts,
  laneManifestsForCount,
  snapshotState,
  twoLaneOrchestrationManifest,
  writerLane,
  preflightManifest,
} from './fixtures/r1-run-orchestration-fixtures.mjs';

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
