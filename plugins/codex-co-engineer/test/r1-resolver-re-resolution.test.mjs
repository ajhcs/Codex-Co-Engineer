import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  ANSWERED_RUN_SCHEMA_ID,
  classifySelectionAnswersV1,
  resolveRunSelectionV1,
  resolveSelectionAnswersV1,
} from '../mcp/v3/resolver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  BASE_SHA,
  countingProxy,
  resolveInputs,
  reviewer,
  runManifest,
  trapTotal,
  writer,
} from './fixtures/r1-resolver-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function outstandingPlan() {
  const manifest = runManifest([reviewer('lane-0', 'omitted')]);
  const frozenManifest = structuredClone(manifest);
  const inputs = resolveInputs(manifest);
  const plan = resolveRunSelectionV1(inputs);
  return { manifest, frozenManifest, inputs, plan, request: plan.selection_request };
}

function replyOf(request) {
  return {
    run_id: request.run_id,
    request_id: request.request_id,
    digest: request.digest,
  };
}

test('an accepted answer batch re-resolves completely and echoes the outstanding identity', () => {
  const { manifest, frozenManifest, inputs, plan, request } = outstandingPlan();
  const answers = [{ assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' }];
  const classified = classifySelectionAnswersV1(request, answers, replyOf(request));
  assert.equal(classified.ok, true);

  const answered = resolveSelectionAnswersV1({
    ...inputs,
    request,
    answers,
    replyIdentity: replyOf(request),
  });
  assert.equal(answered.schema, ANSWERED_RUN_SCHEMA_ID);
  assert.equal(answered.request_id, request.request_id);
  assert.equal(answered.digest, request.digest);
  assert.equal(answered.plan.complete, true);
  assert.equal(answered.plan.selection_request, null);
  assert.deepEqual([...answered.answered_assignment_ids], ['lane-0']);
  assert.equal(answered.plan.assignments[0].provider, 'grok');
  assert.equal(answered.plan.assignments[0].requested_model, 'grok-4');
  assert.equal(answered.availability_digest, plan.availability_digest);
  assert.equal(answered.capability_snapshot_digest, plan.capability_snapshot_digest);
  assert.equal(canonicalJsonStringify(manifest), canonicalJsonStringify(frozenManifest));
});

test('pure re-resolution is byte-identical across equivalent snapshot spellings and repeated calls', () => {
  const { inputs, request } = outstandingPlan();
  const answers = [{ assignment_id: 'lane-0', provider: 'dsh', model: 'stealth/ox-alpha' }];
  const replyIdentity = replyOf(request);
  const first = resolveSelectionAnswersV1({ ...inputs, request, answers, replyIdentity });
  const second = resolveSelectionAnswersV1({ ...inputs, request, answers, replyIdentity });
  assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(second));
  assert.equal(first.request_id, request.request_id);
});

test('answers replace only execution; starting_ref and non-execution fields survive', () => {
  const manifest = runManifest([
    {
      ...reviewer('lane-0', 'omitted'),
      starting_ref: BASE_SHA,
    },
  ]);
  const originalPrompt = manifest.assignments[0].prompt;
  const inputs = resolveInputs(manifest);
  const plan = resolveRunSelectionV1(inputs);
  const request = plan.selection_request;
  assert.equal(request.questions[0].answer_scope, 'provider_and_model');
  assert.deepEqual([...request.questions[0].selectable_providers], ['cursor-cloud']);

  const answered = resolveSelectionAnswersV1({
    ...inputs,
    request,
    answers: [{ assignment_id: 'lane-0', provider: 'cursor-cloud', model: 'claude-sonnet-4-5' }],
    replyIdentity: replyOf(request),
  });
  assert.equal(answered.plan.complete, true);
  assert.equal(answered.plan.assignments[0].provider, 'cursor-cloud');
  assert.equal(manifest.assignments[0].prompt, originalPrompt);
  assert.equal(manifest.assignments[0].starting_ref, BASE_SHA);
  assert.equal(manifest.assignments[0].execution, undefined);
});

test('the answered run has no outstanding question and cannot be asked again', () => {
  const { inputs, request } = outstandingPlan();
  const answered = resolveSelectionAnswersV1({
    ...inputs,
    request,
    answers: [{ assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' }],
    replyIdentity: replyOf(request),
  });
  assert.equal(answered.plan.selection_request, null);
  assert.equal(
    errorOf(() => resolveSelectionAnswersV1({
      manifest: {
        ...inputs.manifest,
        assignments: [{
          ...inputs.manifest.assignments[0],
          execution: { provider: 'grok', model: 'grok-4' },
        }],
      },
      availability: inputs.availability,
      capabilities: inputs.capabilities,
      request,
      answers: [{ assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' }],
      replyIdentity: replyOf(request),
    })).code,
    'no_outstanding_selection_request',
  );
});

test('ambiguous, duplicate, missing, and unexpected answers are rejected', () => {
  const { inputs, request } = outstandingPlan();
  const replyIdentity = replyOf(request);

  const missing = classifySelectionAnswersV1(request, [], replyIdentity);
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.code === 'missing_answer'));

  const duplicate = classifySelectionAnswersV1(request, [
    { assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' },
    { assignment_id: 'lane-0', provider: 'dsh', model: 'stealth/ox-alpha' },
  ], replyIdentity);
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.problems.some((problem) => problem.code === 'duplicate_answer'));

  const unexpected = classifySelectionAnswersV1(request, [
    { assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' },
    { assignment_id: 'lane-9', provider: 'grok', model: 'grok-4' },
  ], replyIdentity);
  assert.equal(unexpected.ok, false);
  assert.ok(unexpected.problems.some((problem) => problem.code === 'unexpected_answer'));

  assert.equal(
    errorOf(() => resolveSelectionAnswersV1({
      ...inputs,
      request,
      answers: [{ assignment_id: 'lane-0', provider: 'unknown', model: 'grok-4' }],
      replyIdentity,
    })).code,
    'selection_answers_rejected',
  );
});

test('model_only answers reject any present provider property', () => {
  const manifest = runManifest([
    writer('lane-0', ['src/**'], { provider: 'grok', model: 'not-offered' }),
  ]);
  const inputs = resolveInputs(manifest, {
    availability: {
      schema: 'codex-co-engineer.provider-availability.v1',
      providers: {
        grok: { status: 'available', models: ['grok-4'] },
        dsh: { status: 'available', models: null },
        'cursor-local': { status: 'available', models: ['composer-1'] },
        'cursor-cloud': { status: 'available', models: ['claude-sonnet-4-5'] },
      },
    },
  });
  const plan = resolveRunSelectionV1(inputs);
  assert.equal(plan.assignments[0].reason, 'model_unavailable');
  assert.equal(plan.selection_request.questions[0].answer_scope, 'model_only');
  const withProvider = classifySelectionAnswersV1(
    plan.selection_request,
    [{ assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' }],
    replyOf(plan.selection_request),
  );
  assert.equal(withProvider.ok, false);
  assert.ok(withProvider.problems.some((problem) => problem.code === 'provider_rejected_for_model_only'));

  const ok = classifySelectionAnswersV1(
    plan.selection_request,
    [{ assignment_id: 'lane-0', model: 'grok-4' }],
    replyOf(plan.selection_request),
  );
  assert.equal(ok.ok, true);

  const answered = resolveSelectionAnswersV1({
    ...inputs,
    request: plan.selection_request,
    answers: [{ assignment_id: 'lane-0', model: 'grok-4' }],
    replyIdentity: replyOf(plan.selection_request),
  });
  assert.equal(answered.plan.complete, true);
  assert.equal(answered.plan.assignments[0].provider, 'grok');
});

test('answer re-resolution denies proxies on the answer batch with zero traps', () => {
  const { inputs, request } = outstandingPlan();
  const answers = countingProxy([{ assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' }]);
  assert.equal(
    errorOf(() => resolveSelectionAnswersV1({
      ...inputs,
      request,
      answers: answers.proxy,
      replyIdentity: replyOf(request),
    })).code,
    'proxy_denied',
  );
  assert.equal(trapTotal(answers.counts), 0);
});
