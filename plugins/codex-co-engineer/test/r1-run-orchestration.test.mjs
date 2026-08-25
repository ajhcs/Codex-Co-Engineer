// P31 run orchestration — focused coverage: P26 preflight is bound to P29
// closed projection before any launch side effect, prepare is side-effect
// free, dispatch preserves provider isolation, argv is credential-free,
// cleanup runs on cancel/terminal/restart, and remote mutation stays denied.

import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import test from 'node:test';

import {
  CREDENTIAL_BOUNDARY_SCHEMA_ID,
  CredentialBoundaryError,
  collectLaneSecrets,
  inspectArgvForSecrets,
  inspectEnvForSecrets,
} from '../mcp/v3/credential-boundary.mjs';
import {
  RUN_PREFLIGHT_SCHEMA_ID,
  RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
} from '../mcp/v3/run-preflight.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ORCHESTRATION_INTENTS,
  RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS,
  RUN_ORCHESTRATION_CHECKS,
  RUN_ORCHESTRATION_SCHEMA_ID,
  cancelRunDispatchV1,
  completeRunDispatchV1,
  denyRunRemoteMutationV1,
  describeRunOrchestrationV1,
  orchestrateRunDispatchV1,
  restartRunDispatchV1,
} from '../mcp/v3/run-orchestration.mjs';
import {
  DENIED_OPERATIONS,
  HOSTILE_ENV,
  SUFFICIENT_HOST,
  createLinearRepo,
  createRecordingDispatcher,
  createRecordingSpawn,
  handoffPathFromProcessIdentity,
  mixedProviderManifest,
  receiptContainsSecret,
  snapshotState,
  twoLaneOrchestrationManifest,
} from './fixtures/r1-run-orchestration-fixtures.mjs';

const SECRETS = collectLaneSecrets(HOSTILE_ENV);

function assertAlwaysFalse(receipt) {
  for (const claim of RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS) {
    assert.equal(receipt.side_effects[claim], false, claim);
  }
}

async function expectMissing(filePath) {
  await assert.rejects(() => lstat(filePath), { code: 'ENOENT' });
}

test('describeRunOrchestrationV1 is deterministic, frozen, and quotes composed surfaces', () => {
  const first = describeRunOrchestrationV1();
  const second = describeRunOrchestrationV1();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(first.schema, RUN_ORCHESTRATION_SCHEMA_ID);
  assert.equal(first.rule, 'preflight_then_closed_projection_before_any_launch_side_effect');
  assert.deepEqual([...first.intents], [...ORCHESTRATION_INTENTS]);
  assert.deepEqual([...first.checks], [...RUN_ORCHESTRATION_CHECKS]);
  assert.equal(first.composed_surfaces.preflight, RUN_PREFLIGHT_SCHEMA_ID);
  assert.equal(first.composed_surfaces.credential_boundary, CREDENTIAL_BOUNDARY_SCHEMA_ID);
  assert.equal(first.composed_surfaces.protected_ref_audit, 'P30 live-ref audit is not invoked here');
  assert.equal(first.composed_surfaces.public_api, 'not exposed');
  assert.equal(first.composed_surfaces.gate_a, 'not claimed');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.composed_surfaces));
});

test('prepare binds a ready P26 preflight to P29 projection with zero launch side effects', async () => {
  const repo = await createLinearRepo('p31-prepare-');
  const dispatcher = createRecordingDispatcher();
  const recording = createRecordingSpawn();
  try {
    const before = await snapshotState(repo.root);
    const manifest = twoLaneOrchestrationManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha,
    });
    const receipt = await orchestrateRunDispatchV1(
      { manifest, intent: 'prepare' },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, spawn: recording.spawn, dispatch: dispatcher.dispatch },
    );
    assert.equal(receipt.schema, RUN_ORCHESTRATION_SCHEMA_ID);
    assert.equal(receipt.status, 'prepared');
    assert.equal(receipt.intent, 'prepare');
    assert.equal(receipt.preflight.schema, RUN_PREFLIGHT_SCHEMA_ID);
    assert.equal(receipt.preflight.status, 'ready');
    assert.equal(receipt.side_effects.credentials_projected, true);
    assert.equal(receipt.side_effects.task_dispatched, false);
    assert.equal(receipt.side_effects.credential_handoff_created, false);
    assert.equal(receipt.side_effects.provider_process_started, false);
    assertAlwaysFalse(receipt);
    for (const claim of RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS) {
      assert.equal(receipt.preflight.side_effects[claim], false, claim);
    }
    assert.equal(dispatcher.calls.length, 0);
    assert.equal(receiptContainsSecret(receipt, SECRETS), false);
    assert.deepEqual(await snapshotState(repo.root), before);
    for (const lane of receipt.lanes) {
      await expectMissing(handoffPathFromProcessIdentity(lane.identity));
    }
  } finally {
    await repo.cleanup();
  }
});

test('mixed-provider prepare isolates each closed route and never shares credentials', async () => {
  const repo = await createLinearRepo('p31-mixed-');
  try {
    const manifest = mixedProviderManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha,
    });
    const receipt = await orchestrateRunDispatchV1(
      { manifest },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV },
    );
    const byId = Object.fromEntries(receipt.lanes.map((lane) => [lane.assignment_id, lane]));
    assert.equal(byId['lane-grok'].provider, 'grok');
    assert.equal(byId['lane-local'].provider, 'cursor-local');
    assert.equal(byId['lane-cloud'].provider, 'cursor-cloud');
    assert.equal(byId['lane-muse'].provider, 'dsh');
    assert.equal(byId['lane-muse'].model, 'muse-spark-1.2-contributor');
    assert.equal(byId['lane-ox'].provider, 'dsh');
    assert.equal(byId['lane-ox'].model, 'stealth/ox-alpha');
    assert.equal(byId['lane-grok'].credential_present, true);
    assert.equal(byId['lane-local'].credential_present, false);
    assert.equal(byId['lane-cloud'].credential_present, true);
    assert.equal(byId['lane-muse'].credential_present, true);
    assert.equal(byId['lane-ox'].credential_present, true);
    assert.ok(byId['lane-grok'].projected_keys.includes('XAI_API_KEY'));
    assert.equal(byId['lane-grok'].projected_keys.includes('MODEL_API_KEY'), false);
    assert.equal(byId['lane-muse'].projected_keys.includes('OPENROUTER_API_KEY'), false);
    assert.equal(byId['lane-ox'].projected_keys.includes('MODEL_API_KEY'), false);
    assert.equal(byId['lane-local'].projected_keys.includes('CURSOR_API_KEY'), false);
    assertAlwaysFalse(receipt);
    assert.equal(receiptContainsSecret(receipt, SECRETS), false);
  } finally {
    await repo.cleanup();
  }
});

test('dispatch uses closed env, never puts secrets in argv, and still creates no workspace', async () => {
  const repo = await createLinearRepo('p31-dispatch-');
  const dispatcher = createRecordingDispatcher();
  try {
    const before = await snapshotState(repo.root);
    const manifest = mixedProviderManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-dispatch',
    });
    const receipt = await orchestrateRunDispatchV1(
      { manifest, intent: 'dispatch' },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
    );
    assert.equal(receipt.status, 'dispatched');
    assert.equal(receipt.side_effects.task_dispatched, true);
    assert.equal(receipt.side_effects.provider_process_started, true);
    assert.equal(receipt.side_effects.credential_handoff_created, true);
    assertAlwaysFalse(receipt);
    assert.equal(dispatcher.calls.length, 5);
    const byProvider = Object.fromEntries(dispatcher.calls.map((call) => [call.provider + ':' + call.model, call]));
    const grok = byProvider['grok:grok-4'];
    const local = byProvider['cursor-local:composer-1'];
    const cloud = byProvider['cursor-cloud:claude-sonnet-4-5'];
    const muse = byProvider['dsh:muse-spark-1.2-contributor'];
    const ox = byProvider['dsh:stealth/ox-alpha'];
    assert.equal(grok.env.XAI_API_KEY, HOSTILE_ENV.XAI_API_KEY);
    assert.equal(Object.hasOwn(grok.env, 'MODEL_API_KEY'), false);
    assert.equal(Object.hasOwn(local.env, 'XAI_API_KEY'), false);
    assert.equal(Object.hasOwn(local.env, 'CURSOR_API_KEY'), false);
    assert.equal(cloud.env.CURSOR_API_KEY, HOSTILE_ENV.CURSOR_API_KEY);
    assert.equal(muse.env.MODEL_API_KEY, HOSTILE_ENV.MODEL_API_KEY);
    assert.equal(Object.hasOwn(muse.env, 'OPENROUTER_API_KEY'), false);
    assert.equal(ox.env.OPENROUTER_API_KEY, HOSTILE_ENV.OPENROUTER_API_KEY);
    assert.equal(Object.hasOwn(ox.env, 'MODEL_API_KEY'), false);
    for (const call of dispatcher.calls) {
      assert.equal(inspectArgvForSecrets(call.argv, SECRETS), false);
      assert.equal(call.env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(Object.hasOwn(call.env, 'GH_TOKEN'), false);
      assert.equal(Object.hasOwn(call.env, 'SSH_AUTH_SOCK'), false);
      assert.equal(Object.hasOwn(call.env, 'NODE_OPTIONS'), false);
      assert.equal(Object.hasOwn(call.env, 'WORKTREE_BOOTSTRAP_TASK'), false);
    }
    assert.equal(inspectEnvForSecrets(grok.env, [
      HOSTILE_ENV.MODEL_API_KEY, HOSTILE_ENV.OPENROUTER_API_KEY, HOSTILE_ENV.CURSOR_API_KEY,
    ]), false);
    assert.deepEqual(await snapshotState(repo.root), before);
    assert.equal(receiptContainsSecret(receipt, SECRETS), false);
    await cancelRunDispatchV1(receipt);
  } finally {
    await repo.cleanup();
  }
});

test('cancel, terminal, and restart clean credential handoffs and stop children', async () => {
  const repo = await createLinearRepo('p31-cleanup-');
  const dispatcher = createRecordingDispatcher();
  try {
    const manifest = twoLaneOrchestrationManifest({
      repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-cleanup',
    });
    const receipt = await orchestrateRunDispatchV1(
      { manifest, intent: 'dispatch' },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: dispatcher.dispatch },
    );
    const identities = receipt.lanes.map((lane) => lane.identity);
    for (const identity of identities) {
      const metadata = await lstat(handoffPathFromProcessIdentity(identity));
      assert.equal(metadata.isFile(), true);
    }
    const cancelled = await cancelRunDispatchV1(receipt);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cleaned, true);
    assert.deepEqual(dispatcher.stopped, identities);
    for (const identity of identities) {
      await expectMissing(handoffPathFromProcessIdentity(identity));
    }

    const restartDispatcher = createRecordingDispatcher();
    const again = await orchestrateRunDispatchV1(
      { manifest, intent: 'dispatch' },
      { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch: restartDispatcher.dispatch },
    );
    const restarted = await restartRunDispatchV1(again, { dispatch: restartDispatcher.dispatch });
    assert.equal(restarted.status, 'dispatched');
    assert.equal(restarted.restarted, true);
    assert.equal(restartDispatcher.stopped.length, identities.length);
    for (const identity of again.lanes.map((lane) => lane.identity)) {
      const metadata = await lstat(handoffPathFromProcessIdentity(identity));
      assert.equal(metadata.isFile(), true);
    }
    const terminal = await completeRunDispatchV1(again);
    assert.equal(terminal.status, 'terminal');
    for (const identity of again.lanes.map((lane) => lane.identity)) {
      await expectMissing(handoffPathFromProcessIdentity(identity));
    }
  } finally {
    await repo.cleanup();
  }
});

test('dispatch failure cleans any created handoff and does not leave a workspace', async () => {
  const repo = await createLinearRepo('p31-fail-');
  try {
    const before = await snapshotState(repo.root);
    const identities = [];
    const dispatch = async (plan) => {
      identities.push(plan.identity);
      throw new Error('injected dispatcher failure');
    };
    await assert.rejects(
      () => orchestrateRunDispatchV1(
        {
          manifest: twoLaneOrchestrationManifest({
            repositoryPath: repo.root, baseSha: repo.baseSha, runId: 'orchestration-fail',
          }),
          intent: 'dispatch',
        },
        { host: SUFFICIENT_HOST, env: HOSTILE_ENV, dispatch },
      ),
      (error) => error instanceof RunContractV1Error && error.code === 'orchestration_dispatch_failed',
    );
    assert.deepEqual(await snapshotState(repo.root), before);
    for (const identity of identities) {
      await expectMissing(handoffPathFromProcessIdentity(identity));
    }
  } finally {
    await repo.cleanup();
  }
});

test('worker remote mutation stays denied at the orchestration boundary', () => {
  for (const operation of DENIED_OPERATIONS) {
    try {
      denyRunRemoteMutationV1(operation);
      assert.fail(`expected denial for ${operation}`);
    } catch (error) {
      assert.ok(error instanceof CredentialBoundaryError);
      assert.equal(error.code, 'remote_mutation_denied');
      assert.equal(error.message.includes(operation), false);
    }
  }
  assert.equal(denyRunRemoteMutationV1('read_only_inspect'), 'read_only_inspect');
});
