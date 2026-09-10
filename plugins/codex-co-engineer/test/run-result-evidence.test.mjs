import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { ARTIFACT_REF_SCHEMA_ID } from '../mcp/v3/artifact-ref.mjs';
import {
  MAX_RUN_RESULT_SUMMARY_BYTES,
  RUN_ADMISSION_RECEIPT_SCHEMA_ID,
  RUN_RESULT_EVIDENCE_SCHEMA_ID,
  describeRunResultEvidenceV1,
  detailRunResultEvidenceV1,
  projectRunResultEvidenceV1,
  summarizeRunResultEvidenceV1,
} from '../mcp/v3/run-result-evidence.mjs';
import {
  appendUsageReceiptV1,
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
  return {
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
}

test('describe seam is disconnected from MCP and names parent wiring', () => {
  const inventory = describeRunResultEvidenceV1();
  assert.equal(inventory.schema, RUN_RESULT_EVIDENCE_SCHEMA_ID);
  assert.equal(inventory.public_mcp, 'not exposed');
  assert.equal(inventory.parent_wiring_required, true);
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
  assert.equal(summary.public_mcp, 'not exposed');
  assert.equal(summary.view, 'summary');
  assert.equal(summary.candidate.head, HEAD_SHA);
  assert.equal(Object.hasOwn(summary, 'assignments'), false);
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
