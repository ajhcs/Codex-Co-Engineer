import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRunResult } from './project-result.mjs';

const RUN_ID = 'run-result-01';
const BASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
const HOSTILE_PATH = '/tmp/secret-repo-do-not-leak';
const HOSTILE_PROMPT = 'owner-only prompt with secret token';

function writerLane(overrides = {}) {
  return {
    assignment_id: 'lane-writer',
    provider: 'grok',
    role: 'implement',
    required: true,
    phase: 'completed',
    status: 'completed',
    prompt_dispatched: true,
    dispatch_confidence: 'authoritative',
    task_final: true,
    clean: true,
    head: HEAD_SHA,
    result: HOSTILE_PROMPT,
    handoff: {
      worktree: HOSTILE_PATH,
      current_head: HEAD_SHA,
      branch: 'ce/lane-writer',
    },
    ...overrides,
  };
}

function receipt(overrides = {}) {
  const result = {
    run_id: RUN_ID,
    phase: 'completed',
    status: 'completed',
    base_sha: BASE_SHA,
    objective: HOSTILE_PROMPT,
    lanes: [writerLane()],
    ...overrides,
  };
  return result;
}

test('completed admission work is not Codex acceptance', () => {
  const summary = projectRunResult(receipt());
  assert.equal(summary.assignment_result, 'completed');
  assert.equal(summary.codex_accepted, false);
  assert.equal(summary.review_needed, true);
  assert.equal(summary.next_decision, 'review_candidate');
  assert.equal(summary.candidate.head, HEAD_SHA);
  assert.match(summary.text, /needs review/iu);
  assert.equal(summary.text.includes('not_accepted'), false);
});

test('failed, uncertain, and unfinal states stay distinct', () => {
  const failed = projectRunResult(receipt({
    phase: 'failed',
    status: 'failed',
    lanes: [writerLane({
      phase: 'failed_pre_prompt',
      status: 'failed_pre_prompt',
      head: null,
    })],
  }));
  assert.equal(failed.assignment_result, 'failed');
  assert.equal(failed.next_decision, 'resolve_failures');
  assert.equal(failed.codex_accepted, false);

  const uncertain = projectRunResult(receipt({
    phase: 'needs_attention',
    status: 'needs_attention',
    lanes: [writerLane({
      phase: 'needs_attention',
      status: 'needs_attention',
      dispatch_confidence: 'uncertain',
    })],
  }));
  assert.equal(uncertain.assignment_result, 'uncertain');
  assert.equal(uncertain.unresolved, true);
  assert.equal(uncertain.next_decision, 'inspect_unresolved');

  const unfinal = projectRunResult(receipt({
    phase: 'running',
    status: 'running',
    lanes: [writerLane({
      phase: 'running',
      status: 'running',
    })],
  }));
  assert.equal(unfinal.assignment_result, 'unfinal');
  assert.equal(unfinal.next_decision, 'wait_for_completion');
});

test('mismatched run and lane states stay coherent', () => {
  const failedWithOutput = projectRunResult(receipt({
    phase: 'failed',
    status: 'failed',
    lanes: [writerLane()],
  }));
  assert.equal(failedWithOutput.assignment_result, 'failed');
  assert.equal(failedWithOutput.label, 'Failed');
  assert.equal(failedWithOutput.next_decision, 'resolve_failures');
  assert.equal(failedWithOutput.review_needed, false);
  assert.equal(failedWithOutput.assignments[0].outcome, 'completed');
  assert.equal(failedWithOutput.assignments[0].head, HEAD_SHA);

  const pending = projectRunResult(receipt({
    phase: 'lifecycle_pending',
    status: 'lifecycle_pending',
    lanes: [writerLane({ task_final: false })],
  }));
  assert.equal(pending.assignment_result, 'uncertain');
  assert.equal(pending.next_decision, 'inspect_unresolved');

  const unknownProof = projectRunResult(receipt({
    lanes: [writerLane({ dispatch_confidence: 'unknown' })],
  }));
  assert.equal(unknownProof.assignment_result, 'uncertain');

  const dirty = projectRunResult(receipt({
    lanes: [writerLane({ clean: false })],
  }));
  assert.equal(dirty.assignment_result, 'uncertain');

  const stillRunning = projectRunResult(receipt({
    phase: 'running',
    status: 'running',
    lanes: [
      writerLane(),
      {
        assignment_id: 'lane-reviewer',
        provider: 'cursor-local',
        role: 'review',
        required: false,
        phase: 'running',
        status: 'running',
      },
    ],
  }));
  assert.equal(stillRunning.assignment_result, 'unfinal');
  assert.match(stillRunning.text, /in progress/iu);
});

test('completed verify work is not treated as a passed check', () => {
  const detailed = projectRunResult(receipt({
    lanes: [{
      assignment_id: 'lane-verify',
      provider: 'grok',
      role: 'verify',
      required: true,
      phase: 'completed',
      status: 'completed',
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      task_final: true,
      clean: true,
      head: HEAD_SHA,
    }],
  }));
  assert.equal(detailed.assignment_result, 'completed');
  assert.equal(detailed.assignments[0].role, 'verify');
  assert.equal(detailed.assignments[0].outcome, 'completed');
  assert.equal(detailed.checks.length, 0);
  assert.equal(detailed.codex_accepted, false);
  assert.equal(detailed.review_needed, true);
});

test('candidate heads stay unambiguous and composition must be explicit', () => {
  const mixed = projectRunResult(receipt({
    lanes: [
      writerLane(),
      {
        assignment_id: 'lane-docs',
        provider: 'cursor-local',
        role: 'implement',
        required: true,
        phase: 'completed',
        status: 'completed',
        prompt_dispatched: true,
        dispatch_confidence: 'authoritative',
        task_final: true,
        clean: true,
        head: OTHER_HEAD,
      },
    ],
  }));
  assert.equal(mixed.candidate.head, null);
  assert.equal(mixed.candidate.composed, false);
  assert.equal(mixed.assignments.find((row) => row.assignment_id === 'lane-writer').head, HEAD_SHA);
  assert.equal(mixed.assignments.find((row) => row.assignment_id === 'lane-docs').head, OTHER_HEAD);

  const composed = projectRunResult({
    receipt: receipt({
      lanes: [
        writerLane(),
        {
          assignment_id: 'lane-docs',
          provider: 'cursor-local',
          role: 'implement',
          required: true,
          phase: 'completed',
          status: 'completed',
          prompt_dispatched: true,
          dispatch_confidence: 'authoritative',
          task_final: true,
          clean: true,
          head: OTHER_HEAD,
        },
      ],
    }),
    candidate: {
      head: HEAD_SHA,
      composed: true,
    },
  });
  assert.equal(composed.candidate.head, HEAD_SHA);
  assert.equal(composed.candidate.composed, true);
});

test('missing metrics stay unknown and shareable text omits owner-only data', () => {
  const missing = projectRunResult(receipt());
  assert.equal(missing.usage.present, false);
  assert.equal(Object.hasOwn(missing.usage, 'native_output_tokens') && missing.usage.native_output_tokens === 0, false);
  assert.equal(JSON.stringify(missing.usage).includes('"value":0') || missing.usage.input_tokens === 0, false);
  assert.equal(missing.text.includes(HOSTILE_PATH), false);
  assert.equal(missing.text.includes(HOSTILE_PROMPT), false);
  assert.equal(missing.text.includes('/tmp/'), false);
});

test('unbound or stale Codex acceptance cannot label Accepted', () => {
  const flagOnly = projectRunResult({
    receipt: receipt(),
    codex_acceptance: { accepted: true, authority: 'codex' },
  });
  assert.equal(flagOnly.codex_accepted, false);
  assert.equal(flagOnly.label, 'Review needed');

  const stale = projectRunResult({
    receipt: receipt(),
    codex_acceptance: {
      accepted: true,
      authority: 'codex',
      run_id: RUN_ID,
      head: OTHER_HEAD,
    },
  });
  assert.equal(stale.codex_accepted, false);

  const bound = projectRunResult({
    receipt: receipt(),
    codex_acceptance: {
      accepted: true,
      authority: 'codex',
      run_id: RUN_ID,
      head: HEAD_SHA,
    },
  });
  assert.equal(bound.codex_accepted, true);
  assert.equal(bound.label, 'Accepted');

  const failed = projectRunResult({
    receipt: receipt({
      phase: 'failed',
      status: 'failed',
      lanes: [writerLane({ phase: 'failed', status: 'failed' })],
    }),
    codex_acceptance: {
      accepted: true,
      authority: 'codex',
      run_id: RUN_ID,
      head: HEAD_SHA,
    },
  });
  assert.equal(failed.codex_accepted, false);
  assert.equal(failed.label, 'Failed');
});
