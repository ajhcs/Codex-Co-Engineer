// R-CUTOVER adversarial coverage: catalog stability, omission compatibility,
// validation-before-side-effects, learned routing, P22 isolation, proxies,
// mixed operations, evidence leaks, cleanup without proof, and remote
// mutation denial.

import assert from 'node:assert/strict';
import { inspect, types as utilTypes } from 'node:util';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  classifyRunToolCall,
  createRunToolAdapter,
  denyRunToolRemoteMutationV1,
} from '../mcp/v3/run-tool-adapter.mjs';
import { PROFILE_SCHEMA } from '../mcp/v3/profile.mjs';
import {
  ASSIGNMENT_ID,
  HOSTILE_ENV,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  RUN_ID,
  countingProxy,
  createAdapter,
  createDurableAdapter,
  createSeamAdapter,
  makeAssignment,
  makeAttentionItem,
  makeRunArgs,
  makeRunReply,
  trackingSameSessionDeliver,
} from './fixtures/r1-run-tool-adapter-fixtures.mjs';
import { makePrivateRoot } from './fixtures/r1-run-runtime-fixtures.mjs';

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
  const text = inspect({
    name: error.name, code: error.code, path: error.path, message: error.message,
  }, { depth: 4, getters: true });
  assert.equal(text.includes(HOSTILE_SECRET), false);
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_TOKEN), false);
  assert.equal(text.includes(HOSTILE_ENV), false);
  assert.equal(text.includes('/tmp'), false);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0 && error.message.length <= 200);
}

test('unknown sixth tool fails closed without dispatch', async () => {
  const { adapter, calls } = createAdapter();
  const error = await errorOf(() => adapter.dispatch('run', { run_id: RUN_ID }));
  assert.equal(error.code, 'catalog_sixth_tool_denied');
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.inspect.length, 0);
  assertContentFree(error);
});

test('learned routing and fallback keys never dispatch', async () => {
  const { adapter, calls } = createAdapter();
  for (const key of ['router', 'rank', 'score', 'fallback_provider', 'learned']) {
    const args = makeRunArgs();
    args.run[key] = 'grok';
    const error = await errorOf(() => adapter.dispatch('delegate', args));
    assert.ok(error.code === 'learned_routing_denied' || error.code === 'replay_or_fallback_denied',
      key);
    assert.equal(calls.submit.length, 0, key);
    assertContentFree(error);
  }
});

test('P22 and unknown providers are rejected before registry composition', async () => {
  const { adapter, calls } = createAdapter();
  for (const provider of ['p22', 'future-harness', 'conformance', 'openai']) {
    const error = await errorOf(() => adapter.dispatch('delegate', makeRunArgs({
      assignments: [makeAssignment({ provider, model: 'anything' })],
    })));
    assert.ok(error.code === 'p22_not_a_provider' || error.code === 'unknown_provider', provider);
    assert.equal(calls.submit.length, 0, provider);
    assertContentFree(error);
  }
});

test('proxy and accessor inputs fail before side effects', async () => {
  const { adapter, calls } = createAdapter();
  const { proxy, traps } = countingProxy({ run_id: RUN_ID });
  const classified = classifyRunToolCall('status', proxy);
  assert.equal(classified.mode, 'run');
  const error = await errorOf(() => adapter.dispatch('status', proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.equal(calls.inspect.length, 0);
  assert.ok(traps.get >= 0);
  const accessor = {};
  Object.defineProperty(accessor, 'run', {
    enumerable: true,
    get() { throw new Error(HOSTILE_SECRET); },
  });
  const accessorError = await errorOf(() => adapter.dispatch('delegate', accessor));
  assert.ok(accessorError instanceof RunContractV1Error);
  assert.equal(calls.submit.length, 0);
  assertContentFree(accessorError);
});

test('mixed run operations and mixed 3.2.1 fields fail closed', async () => {
  const { adapter, calls } = createAdapter();
  await adapter.dispatch('delegate', makeRunArgs());
  const mixed = await errorOf(() => adapter.dispatch('task', {
    run_id: RUN_ID,
    attention: { items: [makeAttentionItem()] },
    run_reply: { batch_id: 'att-x', reply: {} },
  }));
  assert.equal(mixed.code, 'mixed_run_operation');
  const withTaskId = await errorOf(() => adapter.dispatch('task', {
    run_id: RUN_ID,
    task_id: 'legacy-task',
  }));
  assert.equal(withTaskId.code, 'mixed_tool_mode');
  const withReply = await errorOf(() => adapter.dispatch('task', {
    run_id: RUN_ID,
    reply: { session_id: 's', question_id: 'q', response: 'x' },
  }));
  assert.equal(withReply.code, 'mixed_tool_mode');
  const listMix = await errorOf(() => adapter.dispatch('tasks', {
    run_id: RUN_ID,
    provider: 'grok',
  }));
  assert.equal(listMix.code, 'mixed_tool_mode');
  assert.equal(calls.resume.length, 0);
  assert.equal(calls.cancel.length, 0);
});

test('omitted provider/model is unresolved and does not invent a route', async () => {
  const { adapter, calls } = createAdapter();
  const assignment = makeAssignment();
  delete assignment.provider;
  delete assignment.model;
  assignment.profile = 'deep-security-review';
  const error = await errorOf(() => adapter.dispatch('delegate', makeRunArgs({
    assignments: [assignment],
    profile: 'deep-security-review',
  })));
  assert.equal(error.code, 'selection_unresolved');
  assert.equal(calls.submit.length, 0);
});

test('merge, push, PR, and remote keys never create refs or mutate remotes', async () => {
  const { adapter, calls } = createAdapter();
  for (const key of ['push', 'merge', 'create_pr', 'github', 'remote', 'candidate']) {
    const args = makeRunArgs();
    args.run[key] = true;
    const error = await errorOf(() => adapter.dispatch('delegate', args));
    assert.ok([
      'remote_mutation_denied',
      'merge_authority_denied',
      'candidate_authority_denied',
    ].includes(error.code), key);
    assert.equal(calls.submit.length, 0, key);
    assertContentFree(error);
  }
  assert.throws(() => denyRunToolRemoteMutationV1('force_push'));
});

test('cleanup is not invoked when the run id is invalid', async () => {
  const { adapter, calls } = createAdapter();
  const error = await errorOf(() => adapter.dispatch('cancel', {
    run_id: 'NOT_A_RUN',
    cleanup: true,
  }));
  assert.equal(error.code, 'invalid_format');
  assert.equal(calls.cancel.length, 0);
  assert.equal(calls.inspect.length, 0);
  assertContentFree(error);
});

test('replay keys on resume/cancel never reach the runtime', async () => {
  const { adapter, calls } = createAdapter();
  await adapter.dispatch('delegate', makeRunArgs());
  const replay = await errorOf(() => adapter.dispatch('task', {
    run_id: RUN_ID,
    wait_until: 'decision_or_attention',
    wait_ms: 0,
    replay: true,
  }));
  assert.equal(replay.code, 'replay_or_fallback_denied');
  const fallback = await errorOf(() => adapter.dispatch('cancel', {
    run_id: RUN_ID,
    fallback_provider: 'grok',
  }));
  assert.equal(fallback.code, 'replay_or_fallback_denied');
  assert.equal(calls.cancel.length, 0);
});

test('invalid attention items fail before scheduler resume', async () => {
  const { adapter, calls } = createAdapter();
  await adapter.dispatch('delegate', makeRunArgs());
  const error = await errorOf(() => adapter.dispatch('task', {
    run_id: RUN_ID,
    attention: {
      items: [{
        assignment_id: ASSIGNMENT_ID,
        task_id: 'task-writer-0',
        provider: 'grok',
        required: true,
      }],
    },
  }));
  assert.ok(error.code === 'missing_key' || error.code === 'invalid_format' || error.code === 'invalid_type');
  assert.equal(calls.resume.length, 0);
  assertContentFree(error);
});

test('explicit provider/model does not ignore a hostile profile name', async () => {
  const { adapter, calls } = createAdapter();
  const assignment = makeAssignment();
  assignment.profile = 'NOT A PROFILE';
  const error = await errorOf(() => adapter.dispatch('delegate', makeRunArgs({
    assignments: [assignment],
  })));
  assert.equal(error.code, 'invalid_format');
  assert.equal(calls.submit.length, 0);
  assertContentFree(error);
});

test('forged same-session identity never delivers and fails closed', async () => {
  const tracker = trackingSameSessionDeliver();
  const { adapter } = createSeamAdapter({
    deliverSameSessionReply: tracker.deliver,
  });
  await adapter.dispatch('delegate', makeRunArgs());
  await adapter.dispatch('task', {
    run_id: RUN_ID,
    attention: { items: [makeAttentionItem()] },
  });
  const forged = makeRunReply({ sessionId: 'sess-forged', questionId: 'q-forged' });
  const error = await errorOf(() => adapter.dispatch('task', {
    run_id: RUN_ID,
    run_reply: {
      batch_id: `att-${RUN_ID}`,
      expected_revision: 1,
      reply: forged,
    },
  }));
  assert.equal(error.code, 'attention_batch_identity_mismatch');
  assert.equal(tracker.calls.length, 0);
  assertContentFree(error);
});

test('thrown cancel stays unresolved/unsafe across durable restart', async () => {
  const first = await createDurableAdapter();
  try {
    await first.adapter.dispatch('delegate', makeRunArgs());
    const restarted = await createDurableAdapter({
      root: first.root,
      cancelTask: async () => {
        throw new Error(HOSTILE_SECRET);
      },
    });
    const receipt = await restarted.adapter.dispatch('cancel', {
      run_id: RUN_ID,
      assignment_ids: [ASSIGNMENT_ID],
    });
    assert.equal(receipt.status, 'unresolved');
    assert.equal(receipt.lanes[0].status, 'unresolved');
    assert.equal(receipt.lanes[0].unresolved.code, 'safe_cancel_unconfirmed');
    assert.equal(receipt.cleanup.cleaned, false);
    const serialized = inspect(receipt);
    assert.equal(serialized.includes(HOSTILE_SECRET), false);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test('crash before dispatch cannot duplicate dispatch after restart', async () => {
  const first = await createDurableAdapter({
    beforeProviderDispatch: async () => {
      throw new RunContractV1Error(
        'durable_state_mismatch',
        'plan',
        'Durable run state is stale, partial, or mismatched.',
      );
    },
  });
  try {
    const crashed = await errorOf(() => first.adapter.dispatch('delegate', makeRunArgs()));
    assert.equal(crashed.code, 'durable_state_mismatch');
    assert.equal(first.dispatchCalls.length, 0);
    const restarted = await createDurableAdapter({ root: first.root });
    const inspected = await restarted.adapter.dispatch('status', { run_id: RUN_ID });
    assert.equal(inspected.run_id, RUN_ID);
    assert.equal(restarted.dispatchCalls.length, 0);
    const resubmit = await restarted.adapter.dispatch('delegate', makeRunArgs());
    assert.equal(resubmit.operation, 'submit');
    assert.equal(restarted.dispatchCalls.length, 0);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test('stale partial and mismatched scheduler plans fail closed', async () => {
  const first = await createDurableAdapter();
  try {
    await first.adapter.dispatch('delegate', makeRunArgs());
    const planPath = path.join(first.root, 'runs', 'scheduler', `${RUN_ID}.json`);
    await writeFile(planPath, '{"run_id":');
    const truncated = await createDurableAdapter({ root: first.root });
    const truncatedError = await errorOf(() => truncated.adapter.dispatch('status', { run_id: RUN_ID }));
    assert.equal(truncatedError.code, 'durable_state_mismatch');
    assertContentFree(truncatedError);

    const mismatched = await createDurableAdapter();
    try {
      await mismatched.adapter.dispatch('delegate', makeRunArgs());
      const otherPlan = path.join(mismatched.root, 'runs', 'scheduler', `${RUN_ID}.json`);
      const parsed = JSON.parse(await readFile(otherPlan, 'utf8'));
      parsed.base_sha = 'b'.repeat(40);
      await writeFile(otherPlan, `${JSON.stringify(parsed)}\n`);
      const reopened = await createDurableAdapter({ root: mismatched.root });
      const mismatchError = await errorOf(() => reopened.adapter.dispatch('status', { run_id: RUN_ID }));
      assert.equal(mismatchError.code, 'durable_state_mismatch');
      assertContentFree(mismatchError);
    } finally {
      await rm(mismatched.root, { recursive: true, force: true });
    }
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test('durable artifacts persist before restart and reject mismatched identity', async () => {
  const first = await createDurableAdapter();
  try {
    await first.adapter.dispatch('delegate', makeRunArgs());
    const relativePath = `runs/${RUN_ID}/${ASSIGNMENT_ID}/provider-report.txt`;
    await first.seams.artifactBridge.captureAssignmentArtifacts({
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
      artifact_kind: 'provider_report',
      media_type: 'text/plain',
      relative_path: relativePath,
      source: 'owner-only report',
    });
    const restarted = await createDurableAdapter({ root: first.root });
    const projected = await restarted.seams.artifactBridge.projectAssignmentArtifacts({
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
    });
    assert.equal(projected.artifacts.length, 1);
    assert.equal(projected.artifacts[0].relative_path, relativePath);
    const artifactFile = path.join(
      first.root,
      'runs',
      'artifacts',
      RUN_ID,
      ASSIGNMENT_ID,
      `${Buffer.from(relativePath).toString('base64url')}.json`,
    );
    const stored = JSON.parse(await readFile(artifactFile, 'utf8'));
    stored.artifact_ref.run_id = 'run-forged-identity-00000000000000000000000000000000';
    await writeFile(artifactFile, `${JSON.stringify(stored)}\n`);
    const hostile = await createDurableAdapter({ root: first.root });
    const mismatch = await errorOf(() => hostile.seams.artifactBridge.projectAssignmentArtifacts({
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
    }));
    assert.ok([
      'durable_state_mismatch',
      'invalid_type',
      'artifact_bridge_restart_conflict',
      'artifact_bridge_identity_mismatch',
    ].includes(mismatch.code), mismatch.code);
    assertContentFree(mismatch);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test('catalog mutation after submit cannot change bound assignment resolution', async () => {
  const workspace = await makePrivateRoot('r1-rcutover-catalog-mut-');
  try {
    const catalogDir = path.join(workspace, '.codex');
    await mkdir(catalogDir, { recursive: true, mode: 0o700 });
    const catalogPath = path.join(catalogDir, 'co-engineer-profiles.json');
    const name = 'writer-profile';
    await writeFile(catalogPath, JSON.stringify({
      [name]: { schema: PROFILE_SCHEMA, provider: 'grok', model: 'grok-4' },
    }));
    const first = makeAssignment({ assignmentId: 'lane-a', taskId: 'task-a', writeScope: ['a/**'] });
    const second = makeAssignment({ assignmentId: 'lane-b', taskId: 'task-b', writeScope: ['b/**'] });
    delete first.provider;
    delete first.model;
    delete second.provider;
    delete second.model;
    first.profile = name;
    second.profile = name;
    const args = makeRunArgs({ assignments: [first, second] });
    args.run.git = { ...args.run.git, repository_path: workspace };
    const { adapter, calls } = createAdapter();
    const submitted = await adapter.dispatch('delegate', args);
    assert.equal(submitted.lanes[0].provider, 'grok');
    assert.equal(submitted.lanes[1].model, 'grok-4');
    await writeFile(catalogPath, JSON.stringify({
      [name]: {
        schema: PROFILE_SCHEMA,
        provider: 'cursor-local',
        model: 'composer-1',
      },
    }));
    const inspected = await adapter.dispatch('status', { run_id: RUN_ID });
    assert.equal(inspected.lanes[0].provider, 'grok');
    assert.equal(inspected.lanes[0].model, 'grok-4');
    assert.equal(inspected.lanes[1].provider, 'grok');
    assert.equal(calls.submit.length, 1);
    assert.equal(calls.submit[0].assignments[0].provider, 'grok');
    assert.equal(calls.submit[0].assignments[1].model, 'grok-4');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
