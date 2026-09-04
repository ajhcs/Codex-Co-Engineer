import test from 'node:test';
import assert from 'node:assert/strict';

import { compileRunRequestV1 } from '../mcp/v3/run-request-compiler.mjs';
import {
  createRunAdmissionRuntime,
} from '../mcp/v3/run-admission.mjs';

const BASE_SHA = 'a'.repeat(40);
const OBSERVED = Object.freeze({
  base_sha: BASE_SHA,
  head_sha: BASE_SHA,
  tree_sha: 'b'.repeat(40),
  branch: 'main',
  clean: true,
  remote_present: true,
  remote_count: 1,
});

function request(overrides = {}) {
  const assignments = overrides.assignments ?? [
    {
      assignment_id: 'lane-one',
      provider: 'grok',
      role: 'implement',
      access: 'write',
      write_scope: ['src/one/**'],
      prompt: 'Implement lane one.',
      expected_duration_ms: 60_000,
    },
    {
      assignment_id: 'lane-two',
      provider: 'cursor-local',
      role: 'review',
      access: 'read',
      prompt: 'Review lane two.',
      expected_duration_ms: 60_000,
    },
  ];
  return {
    run_id: 'admission-test',
    repo: '/tmp/fixture-repo',
    objective: 'Exercise the admission state machine.',
    ...overrides,
    assignments,
  };
}

function makeCompiled(requestValue) {
  return compileRunRequestV1(requestValue, {
    observeGit: async (_repo, base) => ({ ...OBSERVED, base_sha: base ?? BASE_SHA }),
  });
}

function baseDependencies(overrides = {}) {
  const calls = {
    consent: 0,
    prepare: [],
    dispatch: [],
    cancel: [],
    attention: [],
  };
  const dependencies = {
    compile: makeCompiled,
    requestConsent: async () => {
      calls.consent += 1;
      return { status: 'required' };
    },
    verifyConsent: async () => ({
      approved: true,
      approved_at: '2026-09-01T00:00:00.000Z',
      expires_at: '2026-09-02T00:00:00.000Z',
    }),
    clock: () => '2026-09-01T12:00:00.000Z',
    providerReady: async () => ({ ready: true }),
    processBoundaryReady: async () => ({ ready: true }),
    verifyRepository: async () => ({ verified: true }),
    prepareWorkspace: async ({ assignment }) => {
      calls.prepare.push(assignment.assignment_id);
      return {
        prepared: true,
        workspace: {
          worktree_path: `/tmp/${assignment.assignment_id}`,
          branch: `ce/${assignment.assignment_id}`,
          start_sha: BASE_SHA,
        },
      };
    },
    createSession: async ({ assignment }) => ({ ready: true, session_id: `${assignment.assignment_id}-session` }),
    dispatchPrompt: async ({ assignment }) => {
      calls.dispatch.push(assignment.assignment_id);
      return { dispatched: true, confidence: 'authoritative', cursor: '1' };
    },
    inspectLane: async () => ({ status: 'running', cursor: '1' }),
    replyAttention: async (value) => {
      calls.attention.push(value);
      return { delivered: true };
    },
    inspectWorkspace: async () => ({
      current_head: BASE_SHA,
      clean: true,
      changed_files: [],
      commits: [],
      partial_diff: false,
      last_acknowledged_provider_event: 'prompt_dispatched',
    }),
    verifyRun: async () => ({ verified: true }),
    cancelLane: async ({ assignment_id }) => {
      calls.cancel.push(assignment_id);
      return { confirmed: true, cancelled: true };
    },
    ...overrides,
  };
  return { calls, dependencies };
}

test('consent pauses before workspace export and resumes the same run', async () => {
  const { calls, dependencies } = baseDependencies();
  const runtime = createRunAdmissionRuntime(dependencies);
  const first = await runtime.submitRunRequest(request());

  assert.equal(first.phase, 'awaiting_consent');
  assert.equal(first.consent.status, 'required');
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.dispatch.length, 0);

  const resumed = await runtime.replyRun({ run_id: 'admission-test', approval_ref: 'opaque-approval-ref' });
  assert.equal(resumed.phase, 'running');
  assert.equal(resumed.authoritative_required_dispatch, true);
  assert.deepEqual(calls.dispatch, ['lane-one', 'lane-two']);
  assert.equal(resumed.lanes.every((lane) => lane.prompt_dispatched), true);
  assert.equal(JSON.stringify(resumed).includes('opaque-approval-ref'), false);
});

test('natural-language approval cannot cross the repository exposure boundary', async () => {
  const { calls, dependencies } = baseDependencies({
    requestConsent: async () => ({
      status: 'required',
      request: { kind: 'repository_exposure_consent', run_id: 'typed-consent' },
    }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  await runtime.submitRunRequest(request({ run_id: 'typed-consent' }));

  const blocked = await runtime.replyRun({
    run_id: 'typed-consent',
    attention_reply: { reply: 'yes, approved for this repository' },
  });
  assert.equal(blocked.phase, 'awaiting_consent');
  assert.equal(blocked.error.code, 'approval_ref_required');
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.dispatch.length, 0);
});

test('a future-dated approval cannot cross the repository exposure boundary', async () => {
  const { calls, dependencies } = baseDependencies({
    verifyConsent: async () => ({
      approved: true,
      approved_at: '2026-09-02T00:00:00.000Z',
      expires_at: '2026-09-03T00:00:00.000Z',
    }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  await runtime.submitRunRequest(request({ run_id: 'future-consent' }));

  const blocked = await runtime.replyRun({
    run_id: 'future-consent',
    approval_ref: 'future-dated-approval',
  });
  assert.equal(blocked.phase, 'awaiting_consent');
  assert.equal(blocked.error.code, 'approval_ref_invalid_or_expired');
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.dispatch.length, 0);
});

test('one workspace admission failure dispatches zero prompts', async () => {
  const { calls, dependencies } = baseDependencies({
    prepareWorkspace: async ({ assignment }) => {
      calls.prepare.push(assignment.assignment_id);
      if (assignment.assignment_id === 'lane-two') return { prepared: false };
      return { prepared: true, workspace: { worktree_path: `/tmp/${assignment.assignment_id}` } };
    },
    requestConsent: async () => ({ status: 'approved' }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  const receipt = await runtime.submitRunRequest(request());

  assert.equal(receipt.phase, 'failed');
  assert.deepEqual(calls.dispatch, []);
  assert.equal(receipt.lanes.every((lane) => lane.phase === 'failed_pre_prompt'), true);
  assert.equal(receipt.lanes.every((lane) => lane.handoff !== null), true);
});

test('an all-Cursor Cloud run does not require the local process boundary', async () => {
  let boundaryChecks = 0;
  const { calls, dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    processBoundaryReady: async () => {
      boundaryChecks += 1;
      return { ready: false, reason: 'systemd_user_manager_unavailable' };
    },
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  const receipt = await runtime.submitRunRequest(request({
    run_id: 'cloud-only-admission',
    assignments: [{
      assignment_id: 'cloud-review',
      provider: 'cursor-cloud',
      role: 'review',
      access: 'read',
      prompt: 'Review the candidate in Cursor Cloud.',
      expected_duration_ms: 60_000,
    }],
  }));

  assert.equal(boundaryChecks, 0);
  assert.equal(receipt.phase, 'running');
  assert.deepEqual(calls.dispatch, ['cloud-review']);
});

test('a mixed Cloud and local run still requires the local process boundary', async () => {
  let boundaryChecks = 0;
  const { calls, dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    processBoundaryReady: async () => {
      boundaryChecks += 1;
      return { ready: false, reason: 'systemd_user_manager_unavailable' };
    },
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  const receipt = await runtime.submitRunRequest(request({
    run_id: 'mixed-boundary-admission',
    assignments: [
      {
        assignment_id: 'cloud-review', provider: 'cursor-cloud', role: 'review', access: 'read',
        prompt: 'Review in Cursor Cloud.', expected_duration_ms: 60_000,
      },
      {
        assignment_id: 'local-review', provider: 'grok', role: 'review', access: 'read',
        prompt: 'Review locally.', expected_duration_ms: 60_000,
      },
    ],
  }));

  assert.equal(boundaryChecks, 1);
  assert.equal(receipt.phase, 'failed');
  assert.deepEqual(calls.dispatch, []);
});

test('mid-dispatch failure identifies sent and unsent lanes and never says running', async () => {
  const { calls, dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    dispatchPrompt: async ({ assignment }) => {
      calls.dispatch.push(assignment.assignment_id);
      if (assignment.assignment_id === 'lane-two') {
        throw Object.assign(new Error('provider failed'), { code: 'provider_exit' });
      }
      return { dispatched: true, confidence: 'authoritative', cursor: '1' };
    },
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  const receipt = await runtime.submitRunRequest(request({
    run_id: 'mid-dispatch',
    assignments: [
      ...request().assignments,
    {
      assignment_id: 'lane-three',
      provider: 'dsh',
      role: 'review',
      access: 'read',
      prompt: 'Review lane three.',
      expected_duration_ms: 60_000,
    },
    ],
  }));

  assert.equal(receipt.phase, 'degraded');
  assert.deepEqual(receipt.dispatched_assignment_ids, ['lane-one']);
  assert.deepEqual(receipt.undispatched_assignment_ids, ['lane-two', 'lane-three']);
  assert.equal(receipt.authoritative_required_dispatch, false);
  assert.deepEqual(calls.dispatch, ['lane-one', 'lane-two']);
  assert.equal(receipt.lanes[2].phase, 'failed_pre_prompt');
});

test('uncertain dispatch is never replayed and keeps evidence-bearing handoff', async () => {
  let dispatchCount = 0;
  const { dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    dispatchPrompt: async () => {
      dispatchCount += 1;
      return { dispatched: false, dispatch_uncertain: true, confidence: 'uncertain' };
    },
    inspectLane: async () => ({ status: 'transport_lost' }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  const first = await runtime.submitRunRequest(request({ run_id: 'uncertain-dispatch' }));
  const second = await runtime.resumeRun({ run_id: 'uncertain-dispatch' });

  assert.equal(first.phase, 'degraded');
  assert.equal(first.lanes[0].phase, 'unrecoverable_post_prompt');
  assert.equal(first.lanes[0].recovery_classification, 'dispatch_uncertain_no_replay');
  assert.equal(first.lanes[0].handoff !== null, true);
  assert.equal(second.phase, 'degraded');
  assert.equal(dispatchCount, 1);
});

test('cancellation is idempotent and does not resume a cancelled run', async () => {
  const { calls, dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  await runtime.submitRunRequest(request({ run_id: 'cancel-test' }));
  const first = await runtime.cancelRun({ run_id: 'cancel-test' });
  const second = await runtime.cancelRun({ run_id: 'cancel-test' });
  const resumed = await runtime.resumeRun({ run_id: 'cancel-test' });

  assert.equal(first.phase, 'cancelled');
  assert.equal(first.cancel_requested, true);
  assert.equal(second.already_terminal, true);
  assert.equal(second.phase, 'cancelled');
  assert.equal(resumed.phase, 'cancelled');
  assert.equal(calls.cancel.length, 2);
});

test('cancellation before consent or prompt dispatch is provider-free', async () => {
  const { calls, dependencies } = baseDependencies();
  const runtime = createRunAdmissionRuntime(dependencies);
  const pending = await runtime.submitRunRequest(request({ run_id: 'cancel-before-dispatch' }));
  const cancelled = await runtime.cancelRun({ run_id: 'cancel-before-dispatch' });

  assert.equal(pending.phase, 'awaiting_consent');
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.cancel_requested, true);
  assert.deepEqual(calls.cancel, []);
  assert.equal(cancelled.lanes.every((lane) => lane.phase === 'cancelled'), true);
});

test('pre-authorized receipt access is satisfied without user attention and without replay', async () => {
  const { calls, dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    inspectLane: async ({ assignment }) => ({
      status: 'needs_attention',
      attention: {
        session_id: `${assignment.assignment_id}-session`,
        question_id: 'receipt-read',
        capability: 'read_run_receipts',
        resource: 'run_receipt',
        action: 'read',
        prompt: 'Read the release receipt.',
      },
      cursor: '2',
    }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  await runtime.submitRunRequest(request({ run_id: 'safe-attention' }));

  const first = await runtime.inspectRun({ run_id: 'safe-attention' });
  const second = await runtime.inspectRun({ run_id: 'safe-attention' });

  assert.equal(first.phase, 'running');
  assert.equal(second.phase, 'running');
  assert.equal(first.attention, null);
  assert.equal(second.attention, null);
  assert.equal(calls.attention.length, 2, 'each provider question is answered exactly once per lane');
  assert.equal(calls.attention.every((call) => call.capability_satisfied === true), true);
  assert.equal(first.lanes.every((lane) => lane.recovery_classification === 'capability_pre_authorized'), true);
});

test('new equivalent attention questions are grouped once across lanes', async () => {
  const { dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    inspectLane: async ({ assignment }) => ({
      status: 'needs_attention',
      attention: {
        session_id: `${assignment.assignment_id}-session`,
        question_id: 'permission-read',
        prompt: 'May the provider read the release receipt?',
        options: ['allow_once', 'cancel'],
      },
      cursor: '2',
    }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  await runtime.submitRunRequest(request({
    run_id: 'grouped-attention',
    assignments: request().assignments,
  }));

  const receipt = await runtime.inspectRun({ run_id: 'grouped-attention' });
  assert.equal(receipt.phase, 'needs_attention');
  assert.equal(receipt.attention.kind, 'grouped_attention');
  assert.equal(receipt.attention.items.length, 1);
  assert.equal(receipt.attention.items[0].question_id, 'permission-read');
  assert.equal(receipt.attention.items[0].targets.length, 2);
});

test('hostile nested attention evidence fails closed with a partial handoff', async () => {
  const { dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    inspectLane: async () => ({
      status: 'needs_attention',
      attention: {
        session_id: 'lane-one-session',
        question_id: 'hostile-question',
        options: [{ allow: true }],
      },
    }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  await runtime.submitRunRequest(request({ run_id: 'hostile-attention' }));
  const receipt = await runtime.inspectRun({ run_id: 'hostile-attention' });

  assert.equal(receipt.phase, 'degraded');
  assert.equal(receipt.attention, null);
  assert.equal(receipt.lanes[0].phase, 'partial_handoff');
  assert.equal(receipt.lanes[0].error.code, 'attention_evidence_invalid');
  assert.equal(receipt.lanes[0].handoff !== null, true);
});

test('deadline reconciliation returns an evidence-bearing partial handoff', async () => {
  const { dependencies } = baseDependencies({
    requestConsent: async () => ({ status: 'approved' }),
    inspectLane: async () => ({ status: 'timeout', cursor: 'deadline-1' }),
    inspectWorkspace: async ({ assignment_id }) => ({
      worktree: `/tmp/${assignment_id}`,
      branch: `ce/${assignment_id}`,
      starting_sha: BASE_SHA,
      current_head: 'c'.repeat(40),
      clean: false,
      changed_files: ['src/partial.ts'],
      commits: ['d'.repeat(40)],
      partial_diff: true,
      last_acknowledged_provider_event: 'file_changed',
    }),
  });
  const runtime = createRunAdmissionRuntime(dependencies);
  await runtime.submitRunRequest(request({ run_id: 'timeout-handoff' }));

  const receipt = await runtime.inspectRun({ run_id: 'timeout-handoff' });
  const lane = receipt.lanes[0];
  assert.equal(receipt.phase, 'degraded');
  assert.equal(lane.phase, 'partial_handoff');
  assert.equal(lane.handoff.current_head, 'c'.repeat(40));
  assert.deepEqual(lane.handoff.changed_files, ['src/partial.ts']);
  assert.equal(lane.handoff.partial_diff, true);
  assert.equal(lane.handoff.commits[0], 'd'.repeat(40));
  assert.equal(lane.handoff.recovery_classification, 'timed_out_with_partial_work');
  assert.match(lane.handoff.safe_next_actions.join(' '), /review/i);
});
