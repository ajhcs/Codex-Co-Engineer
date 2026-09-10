// R-CUTOVER run-tool-adapter focused coverage: five-tool catalog, omitted
// 3.2.1 compatibility, 1-8 lane aggregation, attention/reply, provider
// isolation, unresolved blocking, evidence redaction, lifecycle/cleanup,
// P35 ref authority, and denied remote mutation.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  CANDIDATE_REF_NAMESPACE,
  expectedCandidateRefV1,
  isRunOwnedCandidateRefV1,
} from '../mcp/v3/git-authority.mjs';
import {
  PROVIDER_REGISTRY_SLOTS,
  describeProviderRegistryV1,
} from '../mcp/v3/provider-registry.mjs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  PUBLIC_MCP_CATALOG,
  RUN_TOOL_ADAPTER_ALWAYS_FALSE_SIDE_EFFECTS,
  RUN_TOOL_ADAPTER_SCHEMA_ID,
  SIMPLE_RUN_RECEIPT_STRUCTURED_BYTES_MAX,
  SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX,
  RUN_TOOL_OPERATIONS,
  classifyDeniedGitOperationV1,
  classifyRunToolCall,
  createDurableRunSeams,
  createRunToolAdapter,
  denyRunToolRemoteMutationV1,
  describeRunToolAdapterV1,
  experienceForRunToolResult,
} from '../mcp/v3/run-tool-adapter.mjs';
import {
  ASSIGNMENT_ID,
  RUN_ID,
  TASK_ID,
  createAdapter,
  createDurableAdapter,
  createSeamAdapter,
  makeAssignment,
  makeAttentionItem,
  makeRunArgs,
  makeRunReply,
  makeVerifier,
  trackingSameSessionDeliver,
  zeroWorkPingTimeoutReceipt,
} from './fixtures/r1-run-tool-adapter-fixtures.mjs';
import { PROFILE_SCHEMA } from '../mcp/v3/profile.mjs';
import { createClock, createLifecycleFns, makePrivateRoot } from './fixtures/r1-run-runtime-fixtures.mjs';

const MODULE_SOURCE = await readFile(
  fileURLToPath(new URL('../mcp/v3/run-tool-adapter.mjs', import.meta.url)),
  'utf8',
);
const SERVER_SOURCE = await readFile(
  fileURLToPath(new URL('../mcp/v3/server.mjs', import.meta.url)),
  'utf8',
);

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertDeniedSideEffects(receipt) {
  for (const claim of RUN_TOOL_ADAPTER_ALWAYS_FALSE_SIDE_EFFECTS) {
    assert.equal(receipt.side_effects[claim], false, claim);
  }
  assert.equal(receipt.remote_mutated, false);
  assert.equal(receipt.wake, false);
  assert.equal(receipt.candidate.composed, false);
  assert.equal(receipt.candidate.ready_for_codex_review, false);
}

test('describeRunToolAdapterV1 keeps the five-tool catalog and four-slot registry', () => {
  const first = describeRunToolAdapterV1();
  const second = describeRunToolAdapterV1();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(first.schema, RUN_TOOL_ADAPTER_SCHEMA_ID);
  assert.deepEqual(first.catalog, ['status', 'delegate', 'task', 'tasks', 'cancel']);
  assert.equal(first.sixth_tool, false);
  assert.deepEqual(first.operations, RUN_TOOL_OPERATIONS);
  assert.deepEqual(first.registry_slots, [...PROVIDER_REGISTRY_SLOTS]);
  assert.equal(first.p22.composable, false);
  assert.equal(first.p22.provider_slot, null);
  assert.equal(first.candidate_ref_authority, 'p35');
  assert.equal(first.lifecycle_authority, 'p33');
  assert.equal(first.attention_authority, 'p34');
  assert.equal(first.truth_projection, 'r-truth');
  const registry = describeProviderRegistryV1();
  assert.equal(registry.slots.length, 4);
  assert.equal(registry.future_harness.provider_slot, null);
});

test('omitted additive fields classify as legacy 3.2.1 on every public tool', () => {
  assert.equal(classifyRunToolCall('status', {}).mode, 'legacy');
  assert.equal(classifyRunToolCall('status', { detail: 'compact', include_tasks: false }).mode, 'legacy');
  assert.equal(classifyRunToolCall('delegate', {
    task_id: 't1', provider: 'grok', repo: '/repo', prompt: 'go', expected_duration_ms: 1000,
  }).mode, 'legacy');
  assert.equal(classifyRunToolCall('task', { task_id: 't1', wait_until: 'terminal', reply: {
    session_id: 's', question_id: 'q', response: 'ok',
  } }).mode, 'legacy');
  assert.equal(classifyRunToolCall('tasks', { task_ids: ['a'], wait_until: 'progress' }).mode, 'legacy');
  assert.equal(classifyRunToolCall('cancel', { task_id: 't1' }).mode, 'legacy');
  assert.equal(classifyRunToolCall('task', { task_id: 't1', wait_until: 'decision_or_attention' }).mode, 'run');
  assert.equal(classifyRunToolCall('status', { run_id: RUN_ID }).mode, 'run');
});

test('submit maps delegate.run onto one 1-8 lane runtime submission', async () => {
  const { adapter, calls } = createAdapter();
  const receipt = await adapter.dispatch('delegate', makeRunArgs());
  assert.equal(receipt.mode, 'run');
  assert.equal(receipt.operation, 'submit');
  assert.equal(receipt.tool, 'delegate');
  assert.equal(receipt.run_id, RUN_ID);
  assert.equal(receipt.assignment_count, 1);
  assert.equal(receipt.lanes.length, 1);
  assert.equal(receipt.lanes[0].assignment_id, ASSIGNMENT_ID);
  assert.equal(calls.submit.length, 1);
  assert.equal(Object.hasOwn(calls.submit[0].assignments[0], 'prompt'), false);
  assertDeniedSideEffects(receipt);
  assert.equal(isRunOwnedCandidateRefV1(receipt.candidate.ref, RUN_ID), true);
  assert.equal(receipt.candidate.ref, expectedCandidateRefV1({ run_id: RUN_ID }));
  assert.match(receipt.candidate.ref, new RegExp(`^${CANDIDATE_REF_NAMESPACE}`));
});

test('simple run status and receipts remain within their structured byte caps', async () => {
  const legacy = createAdapter();
  const handoff = {
    schema: 'codex-co-engineer.partial-handoff.v1',
    worktree: '/tmp/worktree',
    branch: 'codex/very-long-branch',
    starting_sha: 'a'.repeat(40),
    current_head: 'b'.repeat(40),
    clean: false,
    changed_files: Array.from({ length: 64 }, (_, index) => `${'src/'.padEnd(1000, 'x')}${index}`),
    commits: Array.from({ length: 64 }, () => 'c'.repeat(40)),
    no_commit: false,
    partial_diff: true,
    last_acknowledged_provider_event: 'file_changed',
    recovery_classification: 'timed_out_with_partial_work',
    safe_next_actions: Array.from({ length: 8 }, () => 'Review the retained worktree and handoff evidence.'.repeat(100)),
  };
  const simpleReceipt = {
    schema: 'codex-co-engineer.run-admission.v1',
    run_id: 'bounded-receipt',
    phase: 'degraded',
    status: 'degraded',
    assignment_count: 8,
    lanes: Array.from({ length: 8 }, (_, index) => ({
      assignment_id: `lane-${index}`,
      task_id: `task-${index}`,
      provider: 'grok',
      model: 'grok-4',
      role: 'implement',
      access: 'writer',
      required: true,
      phase: 'partial_handoff',
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      handoff,
    })),
    attention: null,
    telemetry: { noisy: 'z'.repeat(50_000) },
  };
  const simpleRuntime = {
    submitRunRequest: async () => simpleReceipt,
    inspectRun: async () => simpleReceipt,
    resumeRun: async () => simpleReceipt,
    replyRun: async () => simpleReceipt,
    cancelRun: async () => simpleReceipt,
    waitRun: async () => simpleReceipt,
  };
  const adapter = createRunToolAdapter({ runtime: legacy.runtime, simpleRuntime });
  const request = {
    run_request: {
      run_id: 'bounded-receipt',
      repo: '/tmp/repo',
      objective: 'Bound the receipt.',
      assignments: [{
        assignment_id: 'lane-one',
        provider: 'grok',
        role: 'implement',
        access: 'write',
        prompt: 'Implement the bounded slice.',
        expected_duration_ms: 60_000,
      }],
    },
  };
  const submitted = await adapter.dispatch('delegate', request);
  assert.ok(Buffer.byteLength(JSON.stringify(submitted), 'utf8') <= SIMPLE_RUN_RECEIPT_STRUCTURED_BYTES_MAX);
  const status = await adapter.dispatch('status', { run_id: 'bounded-receipt' });
  assert.ok(Buffer.byteLength(JSON.stringify(status), 'utf8') <= SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX);
});

test('eight-lane submit aggregates and a required unresolved lane blocks the candidate', async () => {
  const assignments = [
    makeAssignment({ assignmentId: 'w1', taskId: 'task-w1', writeScope: ['a/**'] }),
    makeAssignment({ assignmentId: 'w2', taskId: 'task-w2', writeScope: ['b/**'] }),
    makeAssignment({ assignmentId: 'w3', taskId: 'task-w3', writeScope: ['c/**'] }),
    makeAssignment({ assignmentId: 'w4', taskId: 'task-w4', writeScope: ['d/**'] }),
    makeVerifier('r1'),
    makeVerifier('r2'),
    makeVerifier('r3'),
    makeAssignment({
      assignmentId: 'w-fail',
      taskId: 'task-w-fail',
      writeScope: ['z/**'],
    }),
  ];
  const { adapter, scheduler } = createAdapter({
    schedulerOptions: { delegateErrorFor: new Set(['w-fail']) },
  });
  const receipt = await adapter.dispatch('delegate', makeRunArgs({ assignments }));
  assert.equal(receipt.assignment_count, 8);
  assert.equal(receipt.lanes.length, 8);
  assert.equal(scheduler.calls.submit, 1);
  const failed = receipt.lanes.find((lane) => lane.assignment_id === 'w-fail');
  assert.equal(failed.status, 'unresolved');
  assert.equal(failed.required, true);
  assert.equal(receipt.complete_candidate_blocked, true);
  assert.equal(receipt.decision_or_attention.unresolved_required_blocks, true);
  const continued = receipt.lanes.filter((lane) => lane.assignment_id !== 'w-fail');
  assert.equal(continued.every((lane) => lane.status !== 'unresolved' || lane.required === false), true);
});

test('validation failure produces zero provider dispatch, ref creation, or cleanup', async () => {
  const { adapter, calls } = createAdapter();
  const error = await errorOf(() => adapter.dispatch('delegate', {
    run: {
      ...makeRunArgs().run,
      assignments: [makeAssignment({ provider: 'p22', model: 'harness' })],
    },
  }));
  assert.equal(error.code, 'p22_not_a_provider');
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.cancel.length, 0);
  const mix = await errorOf(() => adapter.dispatch('delegate', {
    task_id: 'legacy',
    provider: 'grok',
    repo: '/repo',
    prompt: 'nope',
    expected_duration_ms: 1000,
    ...makeRunArgs(),
  }));
  assert.equal(mix.code, 'mixed_tool_mode');
  assert.equal(calls.submit.length, 0);
  const direct = await errorOf(() => adapter.dispatch('delegate', {
    run: { ...makeRunArgs().run, workspace_mode: 'direct' },
  }));
  assert.equal(direct.code, 'direct_mode_rejected');
  assert.equal(calls.submit.length, 0);
  const nine = await errorOf(() => adapter.dispatch('delegate', makeRunArgs({
    assignments: Array.from({ length: 9 }, (_, index) => makeAssignment({
      assignmentId: `lane-${index}`,
      taskId: `task-${index}`,
      writeScope: [`s${index}/**`],
    })),
  })));
  assert.equal(nine.code, 'out_of_range');
  assert.equal(calls.submit.length, 0);
});

test('status/wait/attention/reply/cancel/cleanup map through frozen additive parameters', async () => {
  const { adapter, calls, attentionBatch } = createAdapter();
  await adapter.dispatch('delegate', makeRunArgs());
  const status = await adapter.dispatch('status', { run_id: RUN_ID });
  assert.equal(status.operation, 'status');
  assert.equal(status.audience, 'model');
  const wait = await adapter.dispatch('task', {
    run_id: RUN_ID,
    wait_until: 'decision_or_attention',
    wait_ms: 0,
  });
  assert.equal(wait.operation, 'wait');
  assert.equal(wait.decision_or_attention.wake, false);
  const aggregate = await adapter.dispatch('tasks', {
    run_id: RUN_ID,
    wait_until: 'decision_or_attention',
    wait_ms: 0,
  });
  assert.equal(aggregate.operation, 'wait');
  assert.equal(aggregate.assignment_count, 1);
  const attention = await adapter.dispatch('task', {
    run_id: RUN_ID,
    attention: {
      items: [makeAttentionItem()],
    },
  });
  assert.equal(attention.operation, 'attention');
  assert.equal(calls.resume.length, 1);
  const reply = await adapter.dispatch('task', {
    run_id: RUN_ID,
    run_reply: {
      batch_id: `att-${RUN_ID}`,
      expected_revision: 1,
      reply: { round: 1, batch_id: `att-${RUN_ID}`, answers: [{
        assignment_id: ASSIGNMENT_ID, question_id: 'q-1', session_id: 'sess-1',
        task_id: TASK_ID, response: 'ship-it',
      }] },
    },
  });
  assert.equal(reply.operation, 'reply');
  assert.equal(attentionBatch.calls.reply, 1);
  const cancel = await adapter.dispatch('cancel', {
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_ID],
  });
  assert.equal(cancel.operation, 'cancel');
  const cleanup = await adapter.dispatch('cancel', {
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_ID],
    cleanup: true,
  });
  assert.equal(cleanup.operation, 'cleanup');
  assert.equal(cleanup.cleanup.proof_bound, true);
});

test('model-facing receipts redact nested raw artifacts and R-TRUTH-correct false success', async () => {
  const { adapter } = createAdapter({
    decorateInspect: (receipt) => ({
      ...receipt,
      lanes: receipt.lanes.map((lane) => ({
        ...lane,
        artifacts: {
          raw: 'sk-live-ATTACKER-SECRET',
          bytes: [1, 2, 3],
          projection: 'ok',
          nested: {
            owner: { raw: 'sk-live-NESTED-SECRET', secret: 'github_pat_hostile' },
            bytes: Buffer.from('hidden'),
          },
        },
        task: zeroWorkPingTimeoutReceipt({ id: lane.task_id ?? TASK_ID }),
      })),
    }),
  });
  await adapter.dispatch('delegate', makeRunArgs());
  const inspected = await adapter.dispatch('status', { run_id: RUN_ID });
  const lane = inspected.lanes[0];
  assert.equal(Object.hasOwn(lane.artifacts, 'raw'), false);
  assert.equal(Object.hasOwn(lane.artifacts, 'bytes'), false);
  assert.equal(Object.hasOwn(lane.artifacts.nested, 'bytes'), false);
  assert.equal(Object.hasOwn(lane.artifacts.nested.owner, 'raw'), false);
  assert.equal(Object.hasOwn(lane.artifacts.nested.owner, 'secret'), false);
  assert.equal(lane.task.status, 'failed');
  assert.equal(lane.truth.corrected, true);
  const serialized = JSON.stringify(inspected);
  assert.doesNotMatch(serialized, /sk-live/u);
  assert.doesNotMatch(serialized, /ATTACKER-SECRET/u);
  assert.doesNotMatch(serialized, /NESTED-SECRET/u);
  assert.doesNotMatch(serialized, /github_pat/u);
});

test('unsupported same-session providers cancel only the affected lane', async () => {
  const dsh = makeAssignment({
    assignmentId: 'dsh-lane',
    taskId: 'task-dsh',
    provider: 'dsh',
    model: 'meta/muse-spark-1.3-contributor',
    writeScope: ['docs/**'],
  });
  const writer = makeAssignment();
  const { adapter } = createAdapter();
  await adapter.dispatch('delegate', makeRunArgs({ assignments: [writer, dsh] }));
  const receipt = await adapter.dispatch('task', {
    run_id: RUN_ID,
    attention: {
      items: [
        makeAttentionItem({
          assignmentId: 'dsh-lane',
          taskId: 'task-dsh',
          provider: 'dsh',
          sessionId: 'sess-dsh',
          questionId: 'q-dsh',
          prompt: 'DSH cannot host a same-session reply',
        }),
      ],
    },
  });
  assert.equal(receipt.complete_candidate_blocked, true);
  const dshLane = receipt.lanes.find((lane) => lane.assignment_id === 'dsh-lane');
  const other = receipt.lanes.find((lane) => lane.assignment_id === ASSIGNMENT_ID);
  assert.ok(other);
  assert.ok(dshLane);
});

test('P35 candidate namespace is preserved and remote mutation stays denied', () => {
  const receipt = classifyDeniedGitOperationV1(RUN_ID, 'push');
  assert.equal(receipt.verdict, 'denied');
  assert.throws(() => denyRunToolRemoteMutationV1('push'), (error) => error.code === 'remote_mutation_denied');
  assert.throws(() => denyRunToolRemoteMutationV1('create_pr'), (error) => error.code === 'remote_mutation_denied');
  assert.throws(() => denyRunToolRemoteMutationV1('merge'), (error) => error.code === 'remote_mutation_denied');
  const ref = expectedCandidateRefV1({ run_id: RUN_ID });
  assert.equal(isRunOwnedCandidateRefV1(ref, RUN_ID), true);
});

test('server source still advertises exactly five public tools', () => {
  const names = [...SERVER_SOURCE.matchAll(/name: '([^']+)'/gu)].map((match) => match[1]).slice(0, 5);
  assert.deepEqual(names, [...PUBLIC_MCP_CATALOG]);
  assert.match(SERVER_SOURCE, /decision_or_attention/u);
  assert.match(MODULE_SOURCE, /Sol-frozen additive/u);
  assert.doesNotMatch(MODULE_SOURCE, /sixth tool/iu);
});

test('createRunToolAdapter rejects extra injected seams before dispatch', async () => {
  const { runtime, attentionBatch } = createAdapter();
  assert.throws(
    () => createRunToolAdapter({ runtime, attention: attentionBatch, scheduler: {} }),
    (error) => error.code === 'unknown_key',
  );
});

test('decision_or_attention wait polls until an actionable attention decision', async () => {
  let inspections = 0;
  const { adapter } = createAdapter({
    decorateInspect: (receipt) => {
      inspections += 1;
      if (inspections < 3) return receipt;
      return {
        ...receipt,
        lanes: receipt.lanes.map((lane) => ({ ...lane, status: 'needs_attention' })),
      };
    },
  });
  await adapter.dispatch('delegate', makeRunArgs());
  const wait = await adapter.dispatch('task', {
    run_id: RUN_ID,
    wait_until: 'decision_or_attention',
    wait_ms: 400,
  });
  assert.equal(wait.operation, 'wait');
  assert.equal(wait.wake, true);
  assert.equal(wait.decision_or_attention.wake, true);
  assert.ok(inspections >= 3);
});

test('explicit provider/model plus a conflicting named profile fails closed', async () => {
  const workspace = await makePrivateRoot('r1-rcutover-profile-');
  try {
    const catalogDir = path.join(workspace, '.codex');
    await mkdir(catalogDir, { recursive: true, mode: 0o700 });
    const definition = {
      schema: PROFILE_SCHEMA,
      provider: 'dsh',
      model: 'meta/muse-spark-1.3-contributor',
    };
    const name = 'writer-profile';
    const catalog = {
      [name]: definition,
    };
    await writeFile(path.join(catalogDir, 'co-engineer-profiles.json'), JSON.stringify(catalog));
    const assignment = makeAssignment();
    assignment.profile = name;
    const args = makeRunArgs({ assignments: [assignment] });
    args.run.git = { ...args.run.git, repository_path: workspace };
    args.run.profile = name;
    const { adapter, calls } = createAdapter();
    const error = await errorOf(() => adapter.dispatch('delegate', args));
    assert.equal(error.code, 'selection_unresolved');
    assert.equal(calls.submit.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('named profile fills omitted provider/model from the catalog', async () => {
  const workspace = await makePrivateRoot('r1-rcutover-profile-fill-');
  try {
    const catalogDir = path.join(workspace, '.codex');
    await mkdir(catalogDir, { recursive: true, mode: 0o700 });
    const name = 'writer-profile';
    const definition = {
      schema: PROFILE_SCHEMA,
      provider: 'grok',
      model: 'grok-4',
    };
    await writeFile(path.join(catalogDir, 'co-engineer-profiles.json'), JSON.stringify({
      [name]: definition,
    }));
    const assignment = makeAssignment();
    delete assignment.provider;
    delete assignment.model;
    assignment.profile = name;
    const args = makeRunArgs({ assignments: [assignment] });
    args.run.git = { ...args.run.git, repository_path: workspace };
    const { adapter, calls } = createAdapter();
    const receipt = await adapter.dispatch('delegate', args);
    assert.equal(receipt.operation, 'submit');
    assert.equal(calls.submit.length, 1);
    assert.equal(calls.submit[0].assignments[0].provider, 'grok');
    assert.equal(calls.submit[0].assignments[0].model, 'grok-4');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('default in-process attention reply rejects a conflicting second round', async () => {
  const { adapter, seams } = createSeamAdapter();
  await adapter.dispatch('delegate', makeRunArgs());
  await adapter.dispatch('task', {
    run_id: RUN_ID,
    attention: { items: [makeAttentionItem()] },
  });
  const replyBody = {
    round: 1,
    batch_id: `att-${RUN_ID}`,
    answers: [{
      assignment_id: ASSIGNMENT_ID, question_id: 'q-1', session_id: 'sess-1',
      task_id: TASK_ID, response: 'ship-it',
    }],
  };
  const first = await adapter.dispatch('task', {
    run_id: RUN_ID,
    run_reply: {
      batch_id: `att-${RUN_ID}`,
      expected_revision: 1,
      reply: replyBody,
    },
  });
  assert.equal(first.operation, 'reply');
  const conflict = await errorOf(() => adapter.dispatch('task', {
    run_id: RUN_ID,
    run_reply: {
      batch_id: `att-${RUN_ID}`,
      expected_revision: 2,
      reply: { ...replyBody, answers: [{ ...replyBody.answers[0], response: 'overwrite' }] },
    },
  }));
  assert.equal(conflict.code, 'attention_batch_reply_conflict');
  const forged = await errorOf(() => seams.attention.reply({
    run_id: RUN_ID,
    batch_id: 'forged-batch',
    expected_revision: 2,
    reply: replyBody,
  }));
  assert.equal(forged.code, 'attention_batch_identity_mismatch');
});

test('durable P33/P34 seams recover identity after a fresh reopen', async () => {
  const root = await makePrivateRoot('r1-rcutover-durable-');
  const lifecycle = createLifecycleFns({ final: true });
  const taskFns = {
    delegateTask: async (plan) => ({ task_id: plan.task_id, status: 'dispatched', cursor: '0' }),
    inspectTask: async (plan) => ({ task_id: plan.task_id, status: 'running', cursor: plan.cursor ?? '0' }),
    cancelTask: async (plan) => ({ task_id: plan.task_id, status: 'cancelled', cancelled: true }),
    settleLocalTaskLifecycle: lifecycle.settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle: lifecycle.cleanupLocalTaskLifecycle,
    clock: createClock(),
  };
  try {
    const first = await createDurableRunSeams({ root, ...taskFns });
    const adapter = createRunToolAdapter({ runtime: first.runtime, attention: first.attention });
    const submitted = await adapter.dispatch('delegate', makeRunArgs());
    assert.equal(submitted.operation, 'submit');
    const second = await createDurableRunSeams({ root, ...taskFns });
    const restarted = createRunToolAdapter({
      runtime: second.runtime, attention: second.attention,
    });
    const inspected = await restarted.dispatch('status', { run_id: RUN_ID });
    assert.equal(inspected.run_id, RUN_ID);
    assert.equal(inspected.assignment_count, 1);
    assert.equal(inspected.lanes[0].assignment_id, ASSIGNMENT_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same-session reply proves exact task/session/question identity and delivers once', async () => {
  const tracker = trackingSameSessionDeliver();
  const { adapter } = createSeamAdapter({
    deliverSameSessionReply: tracker.deliver,
  });
  await adapter.dispatch('delegate', makeRunArgs());
  await adapter.dispatch('task', {
    run_id: RUN_ID,
    attention: { items: [makeAttentionItem()] },
  });
  const replyBody = makeRunReply();
  const first = await adapter.dispatch('task', {
    run_id: RUN_ID,
    run_reply: {
      batch_id: replyBody.batch_id,
      expected_revision: 1,
      reply: replyBody,
    },
  });
  assert.equal(first.operation, 'reply');
  assert.equal(first.attention.status, 'resolved');
  assert.equal(tracker.calls.length, 1);
  assert.equal(tracker.calls[0].task_id, TASK_ID);
  assert.equal(tracker.calls[0].session_id, 'sess-1');
  assert.equal(tracker.calls[0].question_id, 'q-1');
  const second = await adapter.dispatch('task', {
    run_id: RUN_ID,
    run_reply: {
      batch_id: replyBody.batch_id,
      expected_revision: 2,
      reply: replyBody,
    },
  });
  assert.equal(second.attention.status, 'resolved');
  assert.equal(tracker.calls.length, 1);
});

test('unconfirmed cancellation stays unresolved/unsafe and never projects cancelled', async () => {
  const { adapter } = createSeamAdapter({
    cancelTask: async (plan) => ({ task_id: plan.task_id, status: 'running', cancelled: false }),
  });
  await adapter.dispatch('delegate', makeRunArgs());
  const receipt = await adapter.dispatch('cancel', {
    run_id: RUN_ID,
    assignment_ids: [ASSIGNMENT_ID],
  });
  assert.equal(receipt.operation, 'cancel');
  assert.equal(receipt.status, 'unresolved');
  assert.equal(receipt.lanes[0].status, 'unresolved');
  assert.equal(receipt.lanes[0].unresolved.code, 'safe_cancel_unconfirmed');
  assert.equal(receipt.complete_candidate_blocked, true);
  assert.equal(receipt.cleanup.cleaned, false);
  assert.equal(receipt.cleanup.proof_bound, true);
});

test('named profile snapshot is bound once and survives catalog mutation after submit', async () => {
  const workspace = await makePrivateRoot('r1-rcutover-snapshot-');
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
    assert.equal(submitted.operation, 'submit');
    assert.equal(submitted.lanes[0].provider, 'grok');
    assert.equal(submitted.lanes[0].model, 'grok-4');
    assert.equal(submitted.lanes[1].provider, 'grok');
    assert.equal(submitted.lanes[1].model, 'grok-4');
    await writeFile(catalogPath, JSON.stringify({
      [name]: {
        schema: PROFILE_SCHEMA,
        provider: 'dsh',
        model: 'meta/muse-spark-1.3-contributor',
      },
    }));
    const inspected = await adapter.dispatch('status', { run_id: RUN_ID });
    assert.equal(inspected.lanes[0].provider, 'grok');
    assert.equal(inspected.lanes[1].model, 'grok-4');
    assert.equal(calls.submit.length, 1);
    assert.equal(calls.submit[0].assignments[0].provider, 'grok');
    assert.equal(calls.submit[0].assignments[1].provider, 'grok');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('durable restart fallback keeps unconfirmed cancel unresolved/unsafe', async () => {
  const first = await createDurableAdapter();
  try {
    await first.adapter.dispatch('delegate', makeRunArgs());
    const restarted = await createDurableAdapter({
      root: first.root,
      cancelTask: async (plan) => ({ task_id: plan.task_id, status: 'running', cancelled: false }),
    });
    const receipt = await restarted.adapter.dispatch('cancel', {
      run_id: RUN_ID,
      assignment_ids: [ASSIGNMENT_ID],
    });
    assert.equal(receipt.status, 'unresolved');
    assert.equal(receipt.lanes[0].status, 'unresolved');
    assert.equal(receipt.lanes[0].unresolved.code, 'safe_cancel_unconfirmed');
    assert.equal(receipt.cleanup.cleaned, false);
    assert.equal(receipt.complete_candidate_blocked, true);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});


test('simple receipts preserve cursor/revision and wait metadata through the bounded adapter', async () => {
  const runId = 'adapter-continuity';
  const makeReceipt = ({
    status = 'running',
    phase = status,
    revision = 11,
    cursor = '11',
    wait_until,
    waited_ms,
  } = {}) => ({
    schema: 'codex-co-engineer.run-admission.v1',
    version: 1,
    run_id: runId,
    phase,
    status,
    revision,
    cursor,
    assignment_count: 1,
    lanes: [{
      assignment_id: 'adapter-lane',
      task_id: 'adapter-task',
      provider: 'grok',
      model: 'grok-4',
      role: 'implement',
      access: 'write',
      required: true,
      phase,
      status,
      prompt_dispatched: true,
    }],
    complete_candidate_blocked: false,
    attention: null,
    consent: null,
    admission: null,
    dispatched_assignment_ids: ['adapter-lane'],
    undispatched_assignment_ids: [],
    dispatch_uncertain_assignment_ids: [],
    authoritative_required_dispatch: true,
    ...(wait_until === undefined ? {} : { wait_until }),
    ...(waited_ms === undefined ? {} : { waited_ms }),
  });
  const replyCalls = [];
  const legacy = createAdapter();
  const simpleRuntime = {
    hasRun: (value) => value === runId,
    submitRunRequest: async () => makeReceipt(),
    inspectRun: async () => makeReceipt(),
    resumeRun: async () => makeReceipt(),
    replyRun: async (value, options) => {
      replyCalls.push({ value, options });
      return makeReceipt();
    },
    cancelRun: async () => makeReceipt({ status: 'cancelled', phase: 'cancelled' }),
    waitRun: async (value) => makeReceipt({
      wait_until: value.wait_until,
      waited_ms: 17,
    }),
  };
  const adapter = createRunToolAdapter({ runtime: legacy.runtime, simpleRuntime });

  const status = await adapter.dispatch('status', { run_id: runId });
  assert.equal(status.revision, 11);
  assert.equal(status.cursor, '11');
  assert.equal(Object.hasOwn(status, 'blockers'), false);

  const waited = await adapter.dispatch('task', {
    run_id: runId,
    cursor: '10',
    wait_until: 'terminal',
    wait_ms: 0,
  });
  assert.equal(waited.revision, 11);
  assert.equal(waited.cursor, '11');
  assert.equal(waited.wait_until, 'terminal');
  assert.equal(waited.waited_ms, 17);

  const controller = new AbortController();
  await adapter.dispatch('task', {
    run_id: runId,
    run_reply: { request_consent: true },
  }, { signal: controller.signal });
  assert.deepEqual(replyCalls[0].value, {
    run_id: runId,
    request_consent: true,
  });
  assert.equal(replyCalls[0].options.signal, controller.signal);

  const invalid = await errorOf(() => adapter.dispatch('task', {
    run_id: runId,
    run_reply: { request_consent: false },
  }));
  assert.equal(invalid.code, 'invalid_format');

  const mixed = await errorOf(() => adapter.dispatch('task', {
    run_id: runId,
    run_reply: { request_consent: true, approval_ref: 'ambiguous' },
  }));
  assert.equal(mixed.code, 'mixed_run_operation');
});

test('undefined simple runtime receipts fail closed as blocked unresolved output', async () => {
  const runId = 'malformed-runtime-receipt';
  const legacy = createAdapter();
  const simpleRuntime = {
    hasRun: (value) => value === runId,
    submitRunRequest: async () => undefined,
    inspectRun: async () => undefined,
    resumeRun: async () => undefined,
    replyRun: async () => undefined,
    cancelRun: async () => undefined,
    waitRun: async () => undefined,
  };
  const adapter = createRunToolAdapter({ runtime: legacy.runtime, simpleRuntime });
  const submitted = await adapter.dispatch('delegate', {
    run_request: {
      run_id: runId,
      repo: '/tmp/repo',
      objective: 'Defend malformed receipts.',
      assignments: [{
        assignment_id: 'malformed-lane',
        provider: 'grok',
        role: 'implement',
        access: 'read',
        prompt: 'Synthetic only.',
      }],
    },
  });
  const inspected = await adapter.dispatch('status', { run_id: runId });

  for (const receipt of [submitted, inspected]) {
    assert.equal(receipt.run_id, runId);
    assert.equal(receipt.status, 'unresolved');
    assert.equal(receipt.phase, 'unresolved');
    assert.equal(receipt.blockers.verification, true);
    assert.equal(receipt.error.code, 'durable_state_mismatch');
    assert.deepEqual(receipt.lanes, []);
    assert.deepEqual(receipt.diagnostics, { view: 'diagnostics' });
  }
});

test('large multi-assignment results retain bounded useful previews without inventing acceptance', async () => {
  const runId = 'bounded-answer-results';
  const lanes = Array.from({ length: 8 }, (_, index) => ({
    assignment_id: `lane-${index}`, task_id: `task-${index}`, provider: 'grok',
    phase: 'completed', status: 'completed', required: true, prompt_dispatched: true,
    dispatch_confidence: 'authoritative', result: `Answer ${index}: ` + '🙂'.repeat(5000),
  }));
  const receipt = { schema: 'codex-co-engineer.run-admission.v1', run_id: runId,
    phase: 'completed', status: 'completed', lanes, assignment_count: 8, cursor: '9', revision: 9 };
  const simpleRuntime = { hasRun: () => true };
  for (const name of ['submitRunRequest', 'inspectRun', 'resumeRun', 'replyRun', 'cancelRun', 'waitRun']) {
    simpleRuntime[name] = async () => receipt;
  }
  const { runtime } = createAdapter();
  const adapter = createRunToolAdapter({ runtime, simpleRuntime });
  for (const [tool, cap] of [['status', SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX], ['task', SIMPLE_RUN_RECEIPT_STRUCTURED_BYTES_MAX]]) {
    const result = await adapter.dispatch(tool, { run_id: runId, wait_ms: 0 });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= cap);
    assert.equal(result.lanes.length, 8);
    for (let index = 0; index < 8; index += 1) {
      assert.ok(JSON.stringify(result.lanes[index].result).includes(`Answer ${index}`));
      assert.equal(result.lanes[index].result_truncated, true);
    }
    for (const omitted of ['candidate', 'checks', 'telemetry', 'experience', 'side_effects', 'admission']) {
      assert.equal(Object.hasOwn(result, omitted), false, `compact receipt included ${omitted}`);
    }
    assert.equal(Object.hasOwn(result, 'blockers'), false);
    assert.deepEqual(result.diagnostics, { view: 'diagnostics' });
  }
});

test('adversarial semantic metadata stays within caps and marks retrievable omissions', async () => {
  const runId = 'bounded-adversarial-metadata';
  const huge = '🙂'.repeat(30_000);
  const lanes = Array.from({ length: 8 }, (_, index) => ({
    assignment_id: `lane-${index}`,
    task_id: `task-${index}`,
    provider: 'grok',
    role: index === 0 ? 'review' : 'implement',
    phase: 'needs_attention',
    status: 'needs_attention',
    required: true,
    prompt_dispatched: true,
    dispatch_confidence: 'authoritative',
    result: `result-${index}-${huge}`,
    error: { code: 'provider_error', message: huge, detail: huge },
    handoff: { worktree: `/workspace/${huge}`, branch: `codex/${huge}` },
  }));
  const items = lanes.map((lane, index) => ({
    assignment_id: lane.assignment_id,
    task_id: lane.task_id,
    question_id: `question-${index}`,
    session_id: `session-${index}`,
    question: `Choose for lane ${index}: ${huge}`,
    options: Array.from({ length: 8 }, (_, option) => `choice-${index}-${option}-${huge}`),
    event_cursor: String(index + 1),
  }));
  const receipt = {
    schema: 'codex-co-engineer.run-admission.v1',
    version: 1,
    run_id: runId,
    phase: 'needs_attention',
    status: 'needs_attention',
    cursor: '9',
    revision: 9,
    assignment_count: 8,
    lanes,
    attention: { status: 'open', batch_id: 'batch-adversarial', revision: 9, items },
    cleanup: { cleaned: false, proof_bound: false, unresolved: [huge], remaining: 8 },
    error: { code: 'run_error', message: huge, detail: huge },
  };
  const simpleRuntime = { hasRun: () => true };
  for (const name of ['submitRunRequest', 'inspectRun', 'resumeRun', 'replyRun', 'cancelRun', 'waitRun']) {
    simpleRuntime[name] = async () => receipt;
  }
  const { runtime } = createAdapter();
  const adapter = createRunToolAdapter({ runtime, simpleRuntime });
  for (const [tool, cap] of [
    ['status', SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX],
    ['task', SIMPLE_RUN_RECEIPT_STRUCTURED_BYTES_MAX],
  ]) {
    const result = await adapter.dispatch(tool, { run_id: runId });
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= cap, tool);
    assert.equal(result.diagnostics.view, 'diagnostics');
    assert.equal(result.diagnostics.details_omitted, true);
    assert.equal(result.diagnostics.reason, 'response_size_limit');
    assert.equal(result.attention.details_omitted, true);
    assert.equal(result.attention.reply_blocked, true);
    assert.equal(Object.hasOwn(result.attention, 'items'), false);
    assert.equal(result.lanes.every((lane) => lane.result_omitted === true), true);
    assert.equal(result.error.code, 'run_error');
    assert.equal(result.blockers.cleanup, true);
    assert.equal(Object.hasOwn(result, 'cleanup'), false);
    assert.match(result.diagnostics.instruction, /view="diagnostics"/u);
  }

  const topReceipt = {
    ...receipt,
    phase: 'completed',
    status: 'completed',
    lanes: lanes.map(({ result: _result, error: _error, ...lane }) => ({
      ...lane, phase: 'completed', status: 'completed',
    })),
    attention: null,
    cleanup: { cleaned: true, proof_bound: true, unresolved: [], remaining: 0 },
    error: null,
    result: huge,
  };
  const topRuntime = { hasRun: () => true };
  for (const name of ['submitRunRequest', 'inspectRun', 'resumeRun', 'replyRun', 'cancelRun', 'waitRun']) {
    topRuntime[name] = async () => topReceipt;
  }
  const top = await createRunToolAdapter({ runtime, simpleRuntime: topRuntime })
    .dispatch('status', { run_id: runId });
  assert.ok(Buffer.byteLength(JSON.stringify(top), 'utf8') <= SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX);
  assert.equal(top.result_truncated, true);

  const overflowReceipt = { ...receipt, status: huge, phase: huge };
  const overflowRuntime = { hasRun: () => true };
  for (const name of ['submitRunRequest', 'inspectRun', 'resumeRun', 'replyRun', 'cancelRun', 'waitRun']) {
    overflowRuntime[name] = async () => overflowReceipt;
  }
  const overflow = await createRunToolAdapter({ runtime, simpleRuntime: overflowRuntime })
    .dispatch('status', { run_id: runId });
  assert.ok(Buffer.byteLength(JSON.stringify(overflow), 'utf8') <= SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX);
  assert.equal(overflow.status, 'unresolved');
  assert.equal(overflow.phase, 'unresolved');
  assert.equal(overflow.error.code, 'response_projection_overflow');
});

test('simple run defaults to compact semantics and exposes detailed diagnostics explicitly', async () => {
  const runId = 'compact-with-diagnostics';
  const runtimeReceipt = {
    schema: 'codex-co-engineer.run-admission.v1', version: 1, run_id: runId,
    phase: 'running', status: 'running', cursor: '7', revision: 7,
    assignment_count: 1, authoritative_required_dispatch: true,
    lanes: [{
      assignment_id: 'worker', task_id: 'worker-task', provider: 'grok',
      status: 'running', phase: 'running', required: true,
      prompt_dispatched: true, dispatch_confidence: 'authoritative',
    }],
    telemetry: { admission_duration_ms: 123 },
    checks: { catalog_five_tools: true },
  };
  const simpleRuntime = { hasRun: () => true };
  for (const name of ['submitRunRequest', 'inspectRun', 'resumeRun', 'replyRun', 'cancelRun', 'waitRun']) {
    simpleRuntime[name] = async () => runtimeReceipt;
  }
  const { runtime } = createAdapter();
  const adapter = createRunToolAdapter({ runtime, simpleRuntime });

  const compact = await adapter.dispatch('task', { run_id: runId });
  assert.deepEqual(Object.keys(compact), [
    'schema', 'version', 'mode', 'tool', 'operation', 'run_id', 'status', 'phase',
    'cursor', 'revision', 'assignment_count', 'authoritative_required_dispatch',
    'lanes', 'coordination', 'diagnostics',
  ]);
  assert.equal(compact.lanes[0].prompt_dispatched, true);
  assert.equal(compact.diagnostics.view, 'diagnostics');

  const detailed = await adapter.dispatch('task', { run_id: runId, view: 'diagnostics' });
  assert.equal(detailed.telemetry.admission_duration_ms, 123);
  assert.equal(detailed.checks.catalog_five_tools, true);
  assert.equal(detailed.experience.schema, 'codex-co-engineer.experience-projection.v1');
});

test('compact semantic finals retain actual candidate, verification, and top-level-only result', async () => {
  const runId = 'compact-review-artifact';
  const runtimeReceipt = {
    schema: 'codex-co-engineer.run-admission.v1', version: 1, run_id: runId,
    phase: 'completed', status: 'completed', cursor: '8', revision: 8,
    assignment_count: 1, authoritative_required_dispatch: true,
    complete_candidate_blocked: false,
    lanes: [{
      assignment_id: 'worker', task_id: 'worker-task', provider: 'grok',
      role: 'review', status: 'completed', phase: 'completed', required: true,
      prompt_dispatched: true, dispatch_confidence: 'authoritative', task_final: true,
      handoff: {
        branch: 'codex/compact-review-artifact',
        current_head: 'b'.repeat(40),
        tree_sha: 'c'.repeat(40),
      },
    }],
    result: { summary: 'Integrated candidate is ready.' },
    candidate: {
      ref: expectedCandidateRefV1({ run_id: runId }),
      head: 'b'.repeat(40), tree: 'c'.repeat(40),
      ready_for_codex_review: true, accepted: true, authority: 'p35',
    },
    verification: { status: 'passed', authority: 'p35', tests: ['node --test'] },
    evidence: {
      facts: [{ fact_kind: 'git_identity' }],
      claims: [{ claim_kind: 'tests_passed' }],
      digest: `sha256:${'d'.repeat(64)}`,
    },
  };
  const simpleRuntime = { hasRun: () => true };
  for (const name of ['submitRunRequest', 'inspectRun', 'resumeRun', 'replyRun', 'cancelRun', 'waitRun']) {
    simpleRuntime[name] = async () => runtimeReceipt;
  }
  const { runtime } = createAdapter();
  const compact = await createRunToolAdapter({ runtime, simpleRuntime })
    .dispatch('task', { run_id: runId });

  assert.deepEqual(compact.result, { summary: 'Integrated candidate is ready.' });
  assert.equal(compact.candidate.ref, expectedCandidateRefV1({ run_id: runId }));
  assert.equal(compact.candidate.head, 'b'.repeat(40));
  assert.equal(compact.candidate.tree, 'c'.repeat(40));
  assert.equal(compact.candidate.ready_for_codex_review, true);
  assert.deepEqual(compact.verification, {
    status: 'passed', authority: 'p35', tests: ['node --test'],
  });
  const uiExperience = experienceForRunToolResult(compact);
  assert.equal(uiExperience.final.reviews.present, true);
  assert.deepEqual(uiExperience.final.reviews.lanes, ['worker']);
  assert.equal(uiExperience.final.git.head, 'b'.repeat(40));
  assert.deepEqual(uiExperience.final.evidence.kinds, ['git_identity', 'tests_passed']);
  assert.equal(Object.hasOwn(compact, 'experience'), false);
  assert.equal(Object.hasOwn(compact, 'blockers'), false);
});

test('unknown preferred providers return attention and do not dispatch', async () => {
  const submitCalls = [];
  const legacy = createAdapter();
  const simpleRuntime = {
    submitRunRequest: async (value) => {
      submitCalls.push(value);
      return { schema: 'codex-co-engineer.run-admission.v1', run_id: value.run_id, phase: 'running', status: 'running', lanes: [] };
    },
    inspectRun: async () => ({ schema: 'codex-co-engineer.run-admission.v1', run_id: 'ignored', phase: 'running', status: 'running', lanes: [{ assignment_id: 'x', task_id: 'y', status: 'running' }] }),
    resumeRun: async () => ({}),
    replyRun: async () => ({}),
    cancelRun: async () => ({}),
    waitRun: async () => ({}),
  };
  const adapter = createRunToolAdapter({ runtime: legacy.runtime, simpleRuntime });
  const receipt = await adapter.dispatch('delegate', {
    run_request: {
      run_id: 'vale-hardening',
      repo: '/tmp/repo',
      objective: 'Implement the slice.',
      preferences: { implement: { provider: 'claude' } },
      assignments: [{
        assignment_id: 'social-implementation',
        role: 'implement',
        prompt: 'Implement the slice.',
      }],
    },
  });
  assert.equal(receipt.persisted, false);
  assert.equal(receipt.phase, 'not_admitted');
  assert.equal(receipt.attention.code, 'preferred_provider_unavailable');
  assert.equal(receipt.coordination.next_action.action, 'resubmit');
  assert.equal(receipt.coordination.persisted, false);
  assert.equal(receipt.coordination.run_id, null);
  assert.equal(submitCalls.length, 0);
  assert.equal(receipt.lanes.length, 0);
});

test('unused unknown preferences and exact assignment overrides still dispatch', async () => {
  const submitCalls = [];
  const legacy = createAdapter();
  const simpleRuntime = {
    submitRunRequest: async (value) => {
      submitCalls.push(value);
      return {
        schema: 'codex-co-engineer.run-admission.v1',
        version: 1,
        run_id: value.run_id,
        phase: 'running',
        status: 'running',
        assignment_count: 1,
        lanes: [{
          assignment_id: value.assignments[0].assignment_id,
          task_id: 'ce-social',
          provider: 'grok',
          status: 'running',
          phase: 'running',
          prompt_dispatched: true,
        }],
      };
    },
    inspectRun: async () => ({}),
    resumeRun: async () => ({}),
    replyRun: async () => ({}),
    cancelRun: async () => ({}),
    waitRun: async () => ({}),
  };
  const adapter = createRunToolAdapter({ runtime: legacy.runtime, simpleRuntime });
  const unused = await adapter.dispatch('delegate', {
    run_request: {
      run_id: 'vale-unused-review',
      repo: '/tmp/repo',
      objective: 'Implement the slice.',
      preferences: {
        implement: { provider: 'grok' },
        review: { provider: 'claude' },
      },
      assignments: [{
        assignment_id: 'social-implementation',
        role: 'implement',
        prompt: 'Implement the slice.',
      }],
    },
  });
  assert.equal(unused.phase, 'running');
  const overridden = await adapter.dispatch('delegate', {
    run_request: {
      run_id: 'vale-explicit-override',
      repo: '/tmp/repo',
      objective: 'Implement the slice.',
      preferences: { implement: { provider: 'claude' } },
      assignments: [{
        assignment_id: 'social-implementation',
        role: 'implement',
        provider: 'grok',
        prompt: 'Implement the slice.',
      }],
    },
  });
  assert.equal(overridden.phase, 'running');
  assert.equal(submitCalls.length, 2);
});

test('task revision without reviseRun reports unsupported instead of reconstructing stale receipts', async () => {
  const HEAD = 'b'.repeat(40);
  const IDEMPOTENCY = `sha256:${'d'.repeat(64)}`;
  const submitCalls = [];
  const legacy = createAdapter();
  const simpleRuntime = {
    submitRunRequest: async (value) => {
      submitCalls.push(value);
      return value;
    },
    inspectRun: async () => ({
      schema: 'codex-co-engineer.run-admission.v1',
      run_id: 'vale-hardening',
      phase: 'completed',
      status: 'completed',
      lanes: [{ assignment_id: 'social-implementation', task_id: 'ce-social', status: 'completed' }],
    }),
    resumeRun: async () => ({}),
    replyRun: async () => ({}),
    cancelRun: async () => ({}),
    waitRun: async () => ({}),
  };
  const adapter = createRunToolAdapter({ runtime: legacy.runtime, simpleRuntime });
  const error = await errorOf(() => adapter.dispatch('task', {
    run_id: 'vale-hardening',
    revision: {
      assignment_id: 'social-implementation',
      feedback: 'Fix the failing unit tests.',
      expected_head: HEAD,
      expected_idempotency_key: IDEMPOTENCY,
    },
  }));
  assert.equal(error.code, 'revision_unsupported');
  assert.equal(submitCalls.length, 0);
});

test('dirty or active revision requests fail closed without a new dispatch', async () => {
  const HEAD = 'b'.repeat(40);
  const IDEMPOTENCY = `sha256:${'d'.repeat(64)}`;
  const submitCalls = [];
  const legacy = createAdapter();
  const simpleRuntime = {
    submitRunRequest: async (value) => {
      submitCalls.push(value);
      return value;
    },
    inspectRun: async () => ({}),
    resumeRun: async () => ({}),
    replyRun: async () => ({}),
    cancelRun: async () => ({}),
    waitRun: async () => ({}),
    reviseRun: async () => {
      throw Object.assign(new RunContractV1Error(
        'revision_producer_dirty',
        'revision',
        'A revision requires a clean producer worktree.',
      ), { code: 'revision_producer_dirty' });
    },
  };
  const adapter = createRunToolAdapter({ runtime: legacy.runtime, simpleRuntime });
  const error = await errorOf(() => adapter.dispatch('task', {
    run_id: 'vale-hardening',
    revision: {
      assignment_id: 'social-implementation',
      feedback: 'Fix tests.',
      expected_head: HEAD,
      expected_idempotency_key: IDEMPOTENCY,
    },
  }));
  assert.equal(error.code, 'revision_producer_dirty');
  assert.equal(submitCalls.length, 0);
});

test('omitted revision and preferences keep legacy 3.2.1 classification', () => {
  assert.equal(classifyRunToolCall('task', { task_id: 't1' }).mode, 'legacy');
  assert.equal(classifyRunToolCall('delegate', {
    task_id: 't1', provider: 'grok', repo: '/repo', prompt: 'go', expected_duration_ms: 1000,
  }).mode, 'legacy');
  assert.equal(classifyRunToolCall('task', { run_id: RUN_ID, revision: { assignment_id: 'a' } }).mode, 'run');
});
