import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { ARTIFACT_REF_SCHEMA_ID } from '../mcp/v3/artifact-ref.mjs';
import {
  MAX_RUN_RESULT_DETAIL_BYTES,
  MAX_RUN_RESULT_SUMMARY_BYTES,
  RUN_ADMISSION_RECEIPT_SCHEMA_ID,
  RUN_RESULT_EVIDENCE_SCHEMA_ID,
  describeRunResultEvidenceV1,
  detailRunResultEvidenceV1,
  projectRunResultEvidenceV1,
  summarizeRunResultEvidenceV1,
} from '../mcp/v3/run-result-evidence.mjs';
import {
  HOST_USAGE_KEYS,
  PROVIDER_USAGE_KEYS,
  USAGE_BUDGET_METRICS,
  USAGE_TOKEN_TOTALS_NON_COMPARABLE,
  appendUsageReceiptV1,
  buildUsageIdentityV1,
  correlateUsageAssignmentV1,
  correlateUsageModelV1,
  evidenceBytesMetricV1,
  hostMeasuredMetricV1,
  openUsageLedgerV1,
  providerReportedMetricV1,
  unknownHostUsageV1,
  unknownProviderUsageV1,
  usageIdentityFromTelemetryV1,
} from '../mcp/v3/usage-ledger.mjs';
import { makeSubmission } from './fixtures/r1-run-store-fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../mcp/v3/run-result-evidence.mjs', import.meta.url));
const RUN_ID = 'run-result-01';
const BASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HOSTILE_PATH = '/tmp/secret-repo-do-not-leak';
const HOSTILE_PROMPT = 'owner-only prompt with secret token';

function identityFields(identity) {
  return {
    run_id_digest: identity.run_id_digest,
    assignment_id_digest: identity.assignment_id_digest,
    attempt: identity.attempt,
    generation: identity.generation,
    provider: identity.provider,
    requested_model_digest: identity.requested_model_digest,
    effective_model_digest: identity.effective_model_digest,
    requested_effort: identity.requested_effort,
    effective_effort: identity.effective_effort,
  };
}

function measuredLedger() {
  const telemetry = makeSubmission().telemetry;
  return appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), {
    seq: 1,
    recorded_at: '2026-09-10T12:00:00.000Z',
    identity: identityFields(usageIdentityFromTelemetryV1(telemetry, {
      requested_effort: null,
      effective_effort: 'high',
    })),
    provider_usage: {
      ...unknownProviderUsageV1(),
      input_tokens: providerReportedMetricV1(21),
      output_tokens: providerReportedMetricV1(8),
    },
    host_usage: {
      ...unknownHostUsageV1(),
      model_facing_bytes: hostMeasuredMetricV1(256),
      retrievable_evidence_bytes: evidenceBytesMetricV1(96),
      submissions: hostMeasuredMetricV1(1),
    },
  });
}

function artifactRef() {
  return {
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: 'lane-writer',
    artifact_kind: 'git_diff',
    artifact_class: 'sanitized',
    relative_path: `runs/${RUN_ID}/lane-writer/diff-1.patch`,
    byte_length: 128,
    sha256: 'ab'.repeat(32),
    media_type: 'text/plain',
    content_encoding: 'identity',
  };
}

function receipt(overrides = {}) {
  const result = {
    schema: RUN_ADMISSION_RECEIPT_SCHEMA_ID,
    version: 1,
    run_id: RUN_ID,
    phase: 'completed',
    status: 'completed',
    base_sha: BASE_SHA,
    git: { base_sha: BASE_SHA, digest: 'sha256:not-copied' },
    objective: HOSTILE_PROMPT,
    complete_candidate_blocked: false,
    lanes: [{
      assignment_id: 'lane-writer',
      provider: 'grok',
      role: 'implement',
      required: true,
      phase: 'completed',
      status: 'completed',
      head: HEAD_SHA,
      result: HOSTILE_PROMPT,
      handoff: {
        worktree: HOSTILE_PATH,
        current_head: HEAD_SHA,
        branch: 'ce/lane-writer',
      },
      artifact_refs: [artifactRef()],
    }],
    ...overrides,
  };
  return { ...result, lanes: result.lanes.map(lane => ({
    prompt_dispatched: true, dispatch_confidence: 'authoritative', task_final: true, clean: true, ...lane,
  })) };
}

test('describe seam keeps the exported projection API', () => {
  const inventory = describeRunResultEvidenceV1();
  assert.equal(inventory.schema, RUN_RESULT_EVIDENCE_SCHEMA_ID);
  assert.equal(Object.hasOwn(inventory, 'public_mcp'), false);
  assert.equal(Object.hasOwn(inventory, 'parent_wiring_required'), false);
  assert.equal(inventory.completed_is_not_accepted, true);
  assert.equal(inventory.default_view, 'summary');
  assert.deepEqual([...inventory.api], [
    'describeRunResultEvidenceV1',
    'detailRunResultEvidenceV1',
    'projectRunResultEvidenceV1',
    'summarizeRunResultEvidenceV1',
  ]);
});

test('completed admission work is not Codex acceptance', () => {
  const summary = summarizeRunResultEvidenceV1(receipt());
  assert.equal(summary.schema, RUN_RESULT_EVIDENCE_SCHEMA_ID);
  assert.equal(summary.assignment_result, 'completed');
  assert.equal(summary.codex_accepted, false);
  assert.equal(summary.review_needed, true);
  assert.equal(summary.next_decision, 'review_candidate');
  assert.equal(Object.hasOwn(summary, 'public_mcp'), false);
  assert.equal(summary.view, 'summary');
  assert.equal(summary.candidate.head, HEAD_SHA);
  assert.equal(Object.hasOwn(summary, 'assignments'), false);
  assert.match(summary.text, /needs review/u);
  assert.equal(summary.text.includes('not_accepted'), false);
});

test('failed, uncertain, and unfinal states stay distinct', () => {
  const failed = summarizeRunResultEvidenceV1(receipt({
    phase: 'failed',
    status: 'failed',
    lanes: [{
      assignment_id: 'lane-writer',
      provider: 'grok',
      role: 'implement',
      required: true,
      phase: 'failed_pre_prompt',
      status: 'failed_pre_prompt',
      head: null,
    }],
  }));
  assert.equal(failed.assignment_result, 'failed');
  assert.equal(failed.next_decision, 'resolve_failures');
  assert.equal(failed.codex_accepted, false);

  const uncertain = summarizeRunResultEvidenceV1(receipt({
    phase: 'needs_attention',
    status: 'needs_attention',
    lanes: [{
      assignment_id: 'lane-writer',
      provider: 'grok',
      role: 'implement',
      required: true,
      phase: 'needs_attention',
      status: 'needs_attention',
      dispatch_confidence: 'uncertain',
    }],
  }));
  assert.equal(uncertain.assignment_result, 'uncertain');
  assert.equal(uncertain.unresolved, true);
  assert.equal(uncertain.next_decision, 'inspect_unresolved');

  const unfinal = summarizeRunResultEvidenceV1(receipt({
    phase: 'running',
    status: 'running',
    lanes: [{
      assignment_id: 'lane-writer',
      provider: 'grok',
      role: 'implement',
      required: true,
      phase: 'running',
      status: 'running',
    }],
  }));
  assert.equal(unfinal.assignment_result, 'unfinal');
  assert.equal(unfinal.next_decision, 'wait_for_completion');
});

test('missing metrics stay unknown and measured facts keep their source', () => {
  const missing = summarizeRunResultEvidenceV1(receipt());
  assert.equal(missing.usage.present, false);
  assert.equal(missing.usage.identities, null);
  assert.equal(missing.usage.metrics.length, 0);
  assert.equal(missing.usage.unknown.includes('input_tokens'), true);
  assert.equal(JSON.stringify(missing.usage).includes('"value":0'), false);

  const detailed = detailRunResultEvidenceV1({
    receipt: receipt(),
    usage_ledger: measuredLedger(),
    artifacts: [artifactRef()],
  });
  assert.equal(detailed.view, 'detail');
  const input = detailed.usage.metrics.find((row) => row.key === 'input_tokens');
  const bytes = detailed.usage.metrics.find((row) => row.key === 'model_facing_bytes');
  const evidence = detailed.usage.metrics.find((row) => row.key === 'retrievable_evidence_bytes');
  assert.equal(input.source, 'provider_report');
  assert.equal(input.trust, 'provider_untrusted');
  assert.equal(input.unit, 'tokens');
  assert.equal(bytes.source, 'host_measured');
  assert.equal(bytes.unit, 'bytes');
  assert.equal(evidence.source, 'evidence_bytes');
  assert.equal(evidence.unit, 'bytes');
  assert.equal(detailed.usage.unknown.includes('cost_millicents'), true);
  assert.equal(detailed.usage.savings, 'not_inferred');
  assert.equal(detailed.usage.subscription, 'unknown');
  assert.equal(detailed.usage.native_tokens, 'unknown');
  assert.equal(detailed.artifacts.length, 1);
  assert.equal(detailed.assignments[0].outcome, 'completed');
  assert.equal(Object.hasOwn(detailed, 'outcome'), false);
});

test('shareable projection is bounded and omits owner-only prompts and paths', async () => {
  const summary = projectRunResultEvidenceV1(receipt(), { view: 'summary' });
  const encoded = Buffer.byteLength(JSON.stringify(summary), 'utf8');
  assert.ok(encoded <= MAX_RUN_RESULT_SUMMARY_BYTES, encoded);
  const text = JSON.stringify(summary);
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_PROMPT), false);
  assert.equal(text.includes('/tmp/'), false);
  assert.equal(text.includes('owner-only prompt'), false);
  const source = await readFile(MODULE_PATH, 'utf8');
  assert.equal(source.includes('server.mjs'), false);
  assert.equal(source.includes('run-admission.mjs'), false);
  assert.equal(source.includes('run-runtime.mjs'), false);
});

function writerLane(overrides = {}) {
  return {
    assignment_id: 'lane-writer',
    provider: 'grok',
    role: 'implement',
    required: true,
    phase: 'completed',
    status: 'completed',
    head: HEAD_SHA,
    ...overrides,
  };
}

test('mismatched run and lane states stay coherent', () => {
  const failedWithOutput = summarizeRunResultEvidenceV1(receipt({
    phase: 'failed',
    status: 'failed',
    lanes: [writerLane({
      phase: 'completed',
      status: 'completed',
      head: HEAD_SHA,
    })],
  }));
  assert.equal(failedWithOutput.assignment_result, 'failed');
  assert.equal(failedWithOutput.label, 'Failed');
  assert.equal(failedWithOutput.next_decision, 'resolve_failures');
  assert.equal(failedWithOutput.review_needed, false);
  assert.match(failedWithOutput.text, /failed/iu);
  assert.equal(failedWithOutput.unresolved, false);

  const failedDetail = detailRunResultEvidenceV1(receipt({
    phase: 'failed',
    status: 'failed',
    lanes: [writerLane()],
  }));
  assert.equal(failedDetail.assignment_result, 'failed');
  assert.equal(failedDetail.assignments[0].outcome, 'completed');
  assert.equal(failedDetail.assignments[0].head, HEAD_SHA);

  const pending = summarizeRunResultEvidenceV1(receipt({
    phase: 'lifecycle_pending',
    status: 'lifecycle_pending',
    lanes: [writerLane({
      phase: 'completed',
      status: 'completed',
      task_final: false,
    })],
  }));
  assert.equal(pending.assignment_result, 'uncertain');
  assert.equal(pending.next_decision, 'inspect_unresolved');
  assert.equal(pending.label, 'Unresolved');
  assert.match(pending.text, /inspect/iu);

  const unknownProof = summarizeRunResultEvidenceV1(receipt({
    phase: 'completed',
    status: 'completed',
    lanes: [writerLane({
      dispatch_confidence: 'unknown',
    })],
  }));
  assert.equal(unknownProof.assignment_result, 'uncertain');
  assert.equal(unknownProof.next_decision, 'inspect_unresolved');

  const dirty = summarizeRunResultEvidenceV1(receipt({
    phase: 'completed',
    status: 'completed',
    lanes: [writerLane({
      clean: false,
    })],
  }));
  assert.equal(dirty.assignment_result, 'uncertain');
  assert.equal(dirty.next_decision, 'inspect_unresolved');

  const terminalFailedUncertain = summarizeRunResultEvidenceV1(receipt({
    phase: 'failed',
    status: 'failed',
    lanes: [writerLane({
      phase: 'timeout',
      status: 'timeout',
      dispatch_confidence: 'uncertain',
      head: HEAD_SHA,
    })],
  }));
  assert.equal(terminalFailedUncertain.assignment_result, 'failed');
  assert.equal(terminalFailedUncertain.next_decision, 'resolve_failures');

  const stillRunning = summarizeRunResultEvidenceV1(receipt({
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
  assert.equal(stillRunning.next_decision, 'wait_for_completion');
  assert.match(stillRunning.text, /in progress/iu);
});

test('completed verify work is not treated as a passed check', () => {
  const detailed = detailRunResultEvidenceV1(receipt({
    lanes: [{
      assignment_id: 'lane-verify',
      provider: 'grok',
      role: 'verify',
      required: true,
      phase: 'completed',
      status: 'completed',
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
  const otherHead = 'cccccccccccccccccccccccccccccccccccccccc';
  const missingHead = summarizeRunResultEvidenceV1(receipt({
    lanes: [
      writerLane({ assignment_id: 'lane-writer', head: HEAD_SHA }),
      {
        assignment_id: 'lane-reviewer',
        provider: 'cursor-local',
        role: 'review',
        required: true,
        phase: 'completed',
        status: 'completed',
        head: null,
      },
    ],
  }));
  assert.equal(missingHead.candidate.head, null);
  assert.equal(missingHead.candidate.composed, false);

  const mixed = detailRunResultEvidenceV1(receipt({
    lanes: [
      writerLane({ assignment_id: 'lane-writer', head: HEAD_SHA }),
      {
        assignment_id: 'lane-docs',
        provider: 'cursor-local',
        role: 'implement',
        required: true,
        phase: 'completed',
        status: 'completed',
        head: otherHead,
      },
    ],
  }));
  assert.equal(mixed.candidate.head, null);
  assert.equal(mixed.candidate.composed, false);
  assert.equal(mixed.assignments.find((row) => row.assignment_id === 'lane-writer').head, HEAD_SHA);
  assert.equal(mixed.assignments.find((row) => row.assignment_id === 'lane-docs').head, otherHead);

  const composed = summarizeRunResultEvidenceV1({
    receipt: receipt({
      lanes: [
        writerLane({ assignment_id: 'lane-writer', head: HEAD_SHA }),
        {
          assignment_id: 'lane-docs',
          provider: 'cursor-local',
          role: 'implement',
          required: true,
          phase: 'completed',
          status: 'completed',
          head: otherHead,
        },
      ],
    }),
    candidate: {
      branch: 'ce/composed',
      head: HEAD_SHA,
      tree: BASE_SHA,
      composed: true,
    },
  });
  assert.equal(composed.candidate.head, HEAD_SHA);
  assert.equal(composed.candidate.composed, true);

  const single = summarizeRunResultEvidenceV1(receipt());
  assert.equal(single.candidate.head, HEAD_SHA);
  assert.equal(single.candidate.composed, false);
});

test('unbound or stale Codex acceptance cannot label Accepted', () => {
  const flagOnly = summarizeRunResultEvidenceV1({
    receipt: receipt(),
    codex_acceptance: { accepted: true, authority: 'codex' },
  });
  assert.equal(flagOnly.codex_accepted, false);
  assert.equal(flagOnly.label, 'Review needed');

  const otherHead = 'cccccccccccccccccccccccccccccccccccccccc';
  const stale = summarizeRunResultEvidenceV1({
    receipt: receipt(),
    codex_acceptance: {
      accepted: true,
      authority: 'codex',
      run_id: RUN_ID,
      head: otherHead,
    },
  });
  assert.equal(stale.codex_accepted, false);

  const bound = summarizeRunResultEvidenceV1({
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

  const failed = summarizeRunResultEvidenceV1({
    receipt: receipt({
      phase: 'failed',
      status: 'failed',
      lanes: [writerLane({ phase: 'failed', status: 'failed', head: HEAD_SHA })],
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

function fullUsageGroup() {
  return {
    provider_usage: {
      ...unknownProviderUsageV1(),
      input_tokens: providerReportedMetricV1(120_000_000),
      output_tokens: providerReportedMetricV1(120_000_000),
      cache_tokens: providerReportedMetricV1(120_000_000),
    },
    host_usage: unknownHostUsageV1(),
  };
}

function maxLaneId(index) {
  return `lane-${'x'.repeat(58)}${index}`;
}

function laneUsageIdentity(telemetry, assignmentId, provider, model) {
  const base = usageIdentityFromTelemetryV1(telemetry, {
    requested_effort: 'max',
    effective_effort: 'max',
  });
  return buildUsageIdentityV1({
    ...identityFields(base),
    assignment_id_digest: correlateUsageAssignmentV1(assignmentId),
    provider,
    requested_model_digest: correlateUsageModelV1(provider, model),
    effective_model_digest: correlateUsageModelV1(provider, model),
  });
}

test('maximum eight-lane known-metric outputs stay inside byte caps', () => {
  const runId = `r${'y'.repeat(63)}`;
  const lanes = Array.from({ length: 8 }, (_, index) => ({
    assignment_id: maxLaneId(index),
    provider: index % 2 === 0 ? 'grok' : 'cursor-local',
    role: index === 7 ? 'verify' : 'implement',
    required: true,
    phase: 'completed',
    status: 'completed',
    head: index === 0 ? HEAD_SHA : (index === 1 ? 'd'.repeat(40) : null),
  }));
  const artifacts = lanes.map((lane, index) => ({
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: runId,
    assignment_id: lane.assignment_id,
    artifact_kind: 'git_diff',
    artifact_class: 'sanitized',
    relative_path: `runs/${runId}/${lane.assignment_id}/diff-${index}.patch`,
    byte_length: 128,
    sha256: index.toString(16).padStart(2, '0').repeat(32),
    media_type: 'text/plain',
    content_encoding: 'identity',
  }));
  let ledger = openUsageLedgerV1({ budgets: [] });
  for (let index = 0; index < 8; index += 1) {
    const provider = index % 2 === 0 ? 'grok' : 'cursor-local';
    const model = provider === 'grok' ? 'grok-4' : 'composer-1';
    const assignmentId = maxLaneId(index);
    const telemetry = makeSubmission({ runId, assignmentId }).telemetry;
    const group = fullUsageGroup();
    ledger = appendUsageReceiptV1(ledger, {
      seq: 1,
      recorded_at: `2026-09-10T12:00:0${index}.000Z`,
      identity: identityFields(laneUsageIdentity(telemetry, assignmentId, provider, model)),
      provider_usage: group.provider_usage,
      host_usage: group.host_usage,
    });
  }
  const source = {
    receipt: receipt({
      run_id: runId,
      lanes,
    }),
    usage_ledger: ledger,
    artifacts,
  };
  const summary = projectRunResultEvidenceV1(source, { view: 'summary' });
  const detail = projectRunResultEvidenceV1(source, { view: 'detail' });
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');
  const detailBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');
  assert.ok(summaryBytes <= MAX_RUN_RESULT_SUMMARY_BYTES, summaryBytes);
  assert.ok(detailBytes <= MAX_RUN_RESULT_DETAIL_BYTES, detailBytes);
  assert.equal(summary.run_id, runId);
  assert.equal(summary.assignment_result, 'completed');
  assert.equal(summary.candidate.head, null);
  assert.equal(detail.assignments.length, 8);
  assert.equal(detail.assignments[0].head, HEAD_SHA);
  assert.equal(USAGE_BUDGET_METRICS.length, PROVIDER_USAGE_KEYS.length + HOST_USAGE_KEYS.length);
  assert.equal(detail.usage.token_totals, USAGE_TOKEN_TOTALS_NON_COMPARABLE);
  assert.ok(detail.usage.truncation == null || typeof detail.usage.truncation.truncated === 'boolean');
  assert.equal(JSON.stringify(summary).includes(HOSTILE_PATH), false);
  assert.equal(JSON.stringify(summary).includes(HOSTILE_PROMPT), false);
});

test('completed status alone cannot hide missing dispatch or final-lifecycle proof', () => {
  for (const patch of [
    { dispatch_confidence: undefined }, { dispatch_confidence: 'not_sent' },
    { prompt_dispatched: false }, { task_final: undefined },
  ]) {
    const value = receipt();
    for (const [key, field] of Object.entries(patch)) {
      if (field === undefined) delete value.lanes[0][key];
      else value.lanes[0][key] = field;
    }
    const report = summarizeRunResultEvidenceV1(value);
    assert.equal(report.assignment_result, 'uncertain');
    assert.equal(report.next_decision, 'inspect_unresolved');
    assert.equal(report.codex_accepted, false);
  }
});
