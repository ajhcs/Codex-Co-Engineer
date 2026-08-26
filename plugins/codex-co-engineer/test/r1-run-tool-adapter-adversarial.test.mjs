// R-CUTOVER adversarial coverage: catalog stability, omission compatibility,
// validation-before-side-effects, learned routing, P22 isolation, proxies,
// mixed operations, evidence leaks, cleanup without proof, and remote
// mutation denial.

import assert from 'node:assert/strict';
import { inspect, types as utilTypes } from 'node:util';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  classifyRunToolCall,
  createRunToolAdapter,
  denyRunToolRemoteMutationV1,
} from '../mcp/v3/run-tool-adapter.mjs';
import {
  ASSIGNMENT_ID,
  HOSTILE_ENV,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  RUN_ID,
  countingProxy,
  createAdapter,
  makeAssignment,
  makeRunArgs,
} from './fixtures/r1-run-tool-adapter-fixtures.mjs';

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
    attention: { items: [{ assignment_id: ASSIGNMENT_ID }] },
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
