// UsageLedgerV1 focused coverage: import, unknown-vs-zero, cumulative
// retries+invocations, deterministic rollups, and runtime recording.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  USAGE_LEDGER_SCHEMA_ID,
  USAGE_LEDGER_VERSION,
  appendUsageReceiptV1,
  assertUsageLedgerContinuityV1,
  buildUsageIdentityV1,
  correlateUsageAssignmentV1,
  correlateUsageModelV1,
  evidenceBytesMetricV1,
  hostMeasuredMetricV1,
  openUsageLedgerV1,
  providerReportedMetricV1,
  unknownHostUsageV1,
  unknownProviderUsageV1,
  unknownUsageMetricV1,
  usageIdentityFromTelemetryV1,
  validateUsageLedgerV1,
  MAX_USAGE_SUMMARY_BYTES,
  MAX_USAGE_SUMMARY_TEXT_BYTES,
  detailUsageLedgerV1,
  projectUsageReportV1,
  summarizeUsageLedgerV1,
  unknownUsageReportV1,
} from '../mcp/v3/usage-ledger.mjs';
import { makeSubmission } from './fixtures/r1-run-store-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  createMemoryArtifactBridge,
  createMemoryScheduler,
  createRuntime,
  makeAssignment,
  makeSubmitRequest,
  makeVerifier,
} from './fixtures/r1-run-runtime-fixtures.mjs';

const MODULE_SOURCE = await readFile(
  fileURLToPath(new URL('../mcp/v3/usage-ledger.mjs', import.meta.url)),
  'utf8',
);

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

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

function boundIdentity(telemetry, extra = {}) {
  const efforts = {
    requested_effort: extra.requested_effort ?? null,
    effective_effort: extra.effective_effort ?? 'high',
  };
  if (extra.generation !== undefined) efforts.generation = extra.generation;
  return usageIdentityFromTelemetryV1(telemetry, efforts);
}

function hostUsage(overrides = {}) {
  return { ...unknownHostUsageV1(), ...overrides };
}

function providerUsage(overrides = {}) {
  return { ...unknownProviderUsageV1(), ...overrides };
}

function observation({
  telemetry,
  seq = 1,
  recordedAt = '2026-08-22T12:00:00.000Z',
  identityExtra = {},
  identity,
  provider_usage,
  host_usage,
}) {
  return {
    seq,
    recorded_at: recordedAt,
    identity: identityFields(identity ?? boundIdentity(telemetry, identityExtra)),
    provider_usage: provider_usage ?? unknownProviderUsageV1(),
    host_usage: host_usage ?? unknownHostUsageV1(),
  };
}

function laneIdentity(telemetry, { assignmentId, provider, model, extra = {} }) {
  const base = boundIdentity(telemetry, extra);
  return buildUsageIdentityV1({
    ...identityFields(base),
    assignment_id_digest: correlateUsageAssignmentV1(assignmentId),
    provider,
    requested_model_digest: correlateUsageModelV1(provider, model),
    effective_model_digest: correlateUsageModelV1(provider, model),
  });
}

function latestByIdentity(ledger) {
  const latest = new Map();
  for (const receipt of ledger.receipts) {
    latest.set(receipt.identity.digest, receipt);
  }
  return [...latest.values()];
}

test('usage-ledger is importable without nonexistent telemetry dispatch constants', () => {
  const telemetryBlock = MODULE_SOURCE.slice(
    MODULE_SOURCE.lastIndexOf('import {', MODULE_SOURCE.indexOf("./protected-telemetry.mjs")),
    MODULE_SOURCE.indexOf("./protected-telemetry.mjs") + "./protected-telemetry.mjs".length + 2,
  );
  assert.doesNotMatch(telemetryBlock, /MIN_DISPATCH_ATTEMPT/u);
  assert.doesNotMatch(telemetryBlock, /MAX_DISPATCH_ATTEMPT/u);
  assert.match(MODULE_SOURCE, /MIN_DISPATCH_ATTEMPT/u);
  assert.match(MODULE_SOURCE, /from '\.\/protected-identity\.mjs'/u);
  assert.equal(USAGE_LEDGER_VERSION, 1);
  assert.equal(USAGE_LEDGER_SCHEMA_ID, 'codex-co-engineer.usage-ledger.v1');
});

test('unknown provider usage stays null/unknown and is never a hidden zero', () => {
  const telemetry = makeSubmission().telemetry;
  const opened = openUsageLedgerV1({ budgets: [] });
  assert.equal(opened.totals.provider_usage.input_tokens.value, null);
  assert.equal(opened.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(opened.totals.provider_usage.cost_millicents.value, null);
  assert.equal(opened.totals.host_usage.retrievable_evidence_bytes.source, 'unknown');

  const recorded = appendUsageReceiptV1(opened, observation({
    telemetry,
    host_usage: hostUsage({
      submissions: hostMeasuredMetricV1(1),
      provider_invocations: hostMeasuredMetricV1(1),
    }),
  }));
  assert.equal(recorded.totals.provider_usage.input_tokens.value, null);
  assert.equal(recorded.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(recorded.totals.provider_usage.input_tokens.trust, 'unknown');
  assert.equal(recorded.totals.provider_usage.input_tokens.reported_count, 0);
  assert.equal(recorded.totals.provider_usage.input_tokens.unknown_count, 1);
  assert.notEqual(recorded.totals.provider_usage.input_tokens.value, 0);
  assert.equal(recorded.receipts[0].provider_usage.output_tokens.value, null);
  assert.equal(recorded.totals.host_usage.submissions.value, 1);
  assert.equal(recorded.totals.host_usage.submissions.source, 'host_measured');
});

test('mixed known and unknown provider usage keeps the run total unknown', () => {
  const first = makeSubmission({ assignmentId: ASSIGNMENT_ID });
  const second = makeSubmission({ assignmentId: 'docs-reviewer', runId: first.run_id });
  const opened = openUsageLedgerV1({ budgets: [] });
  const afterKnown = appendUsageReceiptV1(opened, observation({
    telemetry: first.telemetry,
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(11),
      output_tokens: providerReportedMetricV1(5),
    }),
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
  const mixed = appendUsageReceiptV1(afterKnown, observation({
    telemetry: second.telemetry,
    recordedAt: '2026-08-22T12:00:01.000Z',
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
  assert.equal(mixed.totals.provider_usage.input_tokens.value, null);
  assert.equal(mixed.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(mixed.totals.provider_usage.input_tokens.reported_sum, 11);
  assert.equal(mixed.totals.provider_usage.input_tokens.reported_count, 1);
  assert.equal(mixed.totals.provider_usage.input_tokens.unknown_count, 1);
  assert.equal(mixed.totals.host_usage.submissions.value, 2);
});

test('cumulative retry_count and provider_invocations can be recorded together', () => {
  const telemetry = makeSubmission().telemetry;
  const opened = openUsageLedgerV1({ budgets: [] });
  const retried = appendUsageReceiptV1(opened, observation({
    telemetry,
    host_usage: hostUsage({
      retry_count: hostMeasuredMetricV1(2),
      provider_invocations: hostMeasuredMetricV1(0),
      no_replay_count: hostMeasuredMetricV1(0),
    }),
  }));
  const invoked = appendUsageReceiptV1(retried, observation({
    telemetry,
    seq: 2,
    recordedAt: '2026-08-22T12:00:02.000Z',
    host_usage: hostUsage({
      retry_count: hostMeasuredMetricV1(2),
      provider_invocations: hostMeasuredMetricV1(1),
      no_replay_count: hostMeasuredMetricV1(0),
    }),
  }));
  assert.equal(invoked.receipts[1].host_usage.retry_count.value, 2);
  assert.equal(invoked.receipts[1].host_usage.provider_invocations.value, 1);
  assert.equal(assertUsageLedgerContinuityV1(retried, invoked), true);

  const postDispatchRetry = observation({
    telemetry,
    seq: 3,
    recordedAt: '2026-08-22T12:00:03.000Z',
    host_usage: hostUsage({
      retry_count: hostMeasuredMetricV1(3),
      provider_invocations: hostMeasuredMetricV1(1),
      no_replay_count: hostMeasuredMetricV1(0),
    }),
  });
  assert.equal(
    errorOf(() => appendUsageReceiptV1(invoked, postDispatchRetry)).code,
    'replay_or_fallback_denied',
  );
});

test('provider-reported, host-measured, and evidence-byte provenance stay distinct', () => {
  const telemetry = makeSubmission().telemetry;
  const recorded = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry,
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(8),
    }),
    host_usage: hostUsage({
      model_facing_bytes: hostMeasuredMetricV1(128),
      retrievable_evidence_bytes: evidenceBytesMetricV1(64),
      submissions: hostMeasuredMetricV1(1),
    }),
  }));
  assert.equal(recorded.receipts[0].provider_usage.input_tokens.source, 'provider_report');
  assert.equal(recorded.receipts[0].provider_usage.input_tokens.trust, 'provider_untrusted');
  assert.equal(recorded.receipts[0].host_usage.model_facing_bytes.source, 'host_measured');
  assert.equal(recorded.receipts[0].host_usage.retrievable_evidence_bytes.source, 'evidence_bytes');
  assert.equal(recorded.totals.host_usage.retrievable_evidence_bytes.source, 'evidence_bytes');
  assert.equal(recorded.totals.host_usage.retrievable_evidence_bytes.value, 64);

  const forgedEvidence = observation({
    telemetry,
    host_usage: hostUsage({
      retrievable_evidence_bytes: hostMeasuredMetricV1(64),
    }),
  });
  assert.equal(
    errorOf(() => appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), forgedEvidence)).code,
    'forged_provider_usage',
  );
  const forgedProvider = observation({
    telemetry,
    provider_usage: providerUsage({
      input_tokens: hostMeasuredMetricV1(8),
    }),
  });
  assert.equal(
    errorOf(() => appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), forgedProvider)).code,
    'forged_provider_usage',
  );
});

test('independent ledgers with the same receipts serialize to one canonical digest', () => {
  const telemetry = makeSubmission().telemetry;
  const payload = observation({
    telemetry,
    provider_usage: providerUsage({
      cache_tokens: providerReportedMetricV1(3),
    }),
    host_usage: hostUsage({
      tool_calls: hostMeasuredMetricV1(2),
      retrievable_evidence_bytes: evidenceBytesMetricV1(16),
    }),
  });
  const left = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), payload);
  const right = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), {
    ...payload,
    identity: { ...payload.identity },
  });
  assert.equal(left.digest, right.digest);
  assert.equal(canonicalJsonStringify(left), canonicalJsonStringify(right));
  assert.equal(validateUsageLedgerV1(JSON.parse(canonicalJsonStringify(left))).digest, left.digest);
  assert.equal(left.revision, 1);
  assert.equal(left.aggregates.length > 0, true);
});

test('run-runtime records unknown provider usage and host measurements on submit', async () => {
  const harness = createRuntime();
  const request = makeSubmitRequest();
  const submitted = await harness.runtime.submitRun(request);
  assert.equal(submitted.usage.schema, USAGE_LEDGER_SCHEMA_ID);
  assert.equal(submitted.usage.totals.provider_usage.input_tokens.value, null);
  assert.equal(submitted.usage.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(submitted.usage.totals.host_usage.submissions.value, 1);
  assert.equal(submitted.usage.totals.host_usage.submissions.source, 'host_measured');
  assert.equal(submitted.usage.totals.host_usage.provider_invocations.value, 1);
  assert.equal(submitted.usage.totals.host_usage.retry_count.value, 0);
  assert.equal(submitted.usage.receipts[0].identity.attempt, 1);
  assert.equal(submitted.usage.receipts[0].identity.generation, 1);
  const replay = await harness.runtime.submitRun(request);
  assert.equal(replay.usage.revision, submitted.usage.revision);
  assert.equal(replay.usage.digest, submitted.usage.digest);
});

test('run-runtime records provider-reported tokens and evidence bytes on inspect', async () => {
  const scheduler = createMemoryScheduler();
  const artifactBridge = createMemoryArtifactBridge();
  const originalProject = artifactBridge.projectAssignmentArtifacts.bind(artifactBridge);
  artifactBridge.projectAssignmentArtifacts = async (input) => {
    const projected = await originalProject(input);
    return {
      ...projected,
      artifacts: [{
        ...((projected.artifacts ?? [])[0] ?? {}),
        byte_length: 80,
        sanitized_byte_length: 48,
      }],
    };
  };
  const harness = createRuntime({ scheduler, artifactBridge });
  const request = makeSubmitRequest({
    submission: makeSubmission({ attempt: 2 }),
  });
  const submitted = await harness.runtime.submitRun(request);
  assert.equal(submitted.usage.totals.host_usage.retry_count.value, 1);
  assert.equal(submitted.usage.totals.host_usage.provider_invocations.value, 1);
  scheduler._runs.get(request.run_id).lanes[0].usage = {
    input_tokens: 21,
    output_tokens: 8,
  };
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.value, 21);
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.source, 'provider_report');
  assert.equal(inspected.usage.totals.provider_usage.cache_tokens.value, null);
  assert.equal(inspected.usage.totals.provider_usage.cache_tokens.source, 'unknown');
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.value, 48);
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.source, 'evidence_bytes');
  assert.equal(inspected.usage.totals.host_usage.retry_count.value, 1);
  assert.equal(inspected.usage.totals.host_usage.provider_invocations.value, 1);
});

test('all-complete homogeneous lane receipts roll up to a proven token total', () => {
  const first = makeSubmission({ assignmentId: ASSIGNMENT_ID });
  const second = makeSubmission({ assignmentId: 'docs-reviewer', runId: first.run_id });
  const afterFirst = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry: first.telemetry,
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(10),
      output_tokens: providerReportedMetricV1(4),
    }),
    host_usage: hostUsage({
      submissions: hostMeasuredMetricV1(1),
      retrievable_evidence_bytes: evidenceBytesMetricV1(16),
    }),
  }));
  const both = appendUsageReceiptV1(afterFirst, observation({
    telemetry: second.telemetry,
    recordedAt: '2026-08-22T12:00:01.000Z',
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(5),
      output_tokens: providerReportedMetricV1(2),
    }),
    host_usage: hostUsage({
      submissions: hostMeasuredMetricV1(1),
      retrievable_evidence_bytes: evidenceBytesMetricV1(8),
    }),
  }));
  assert.equal(both.receipts.length, 2);
  assert.notEqual(both.receipts[0].identity.digest, both.receipts[1].identity.digest);
  assert.equal(both.receipts[0].identity.provider, 'grok');
  assert.equal(both.receipts[1].identity.provider, 'grok');
  assert.equal(
    both.receipts[0].identity.effective_model_digest,
    both.receipts[1].identity.effective_model_digest,
  );
  assert.equal(both.totals.provider_usage.input_tokens.value, 15);
  assert.equal(both.totals.provider_usage.input_tokens.source, 'provider_report');
  assert.equal(both.totals.provider_usage.input_tokens.trust, 'provider_untrusted');
  assert.notEqual(both.totals.provider_usage.input_tokens.trust, 'host_authoritative');
  assert.equal(both.totals.provider_usage.output_tokens.value, 6);
  assert.equal(both.totals.host_usage.retrievable_evidence_bytes.value, 24);
  assert.equal(both.totals.host_usage.retrievable_evidence_bytes.source, 'evidence_bytes');
  const runRow = both.aggregates.find((row) => row.scope === 'run');
  assert.equal(runRow.identity_count, 2);
  assert.equal(runRow.provider_usage.input_tokens.value, 15);
});

test('all-complete heterogeneous lane receipts keep the run token total unknown', () => {
  const grok = makeSubmission({ assignmentId: ASSIGNMENT_ID });
  const cursor = makeSubmission({ assignmentId: 'docs-reviewer', runId: grok.run_id });
  const afterGrok = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry: grok.telemetry,
    identity: laneIdentity(grok.telemetry, {
      assignmentId: ASSIGNMENT_ID,
      provider: 'grok',
      model: 'grok-4',
    }),
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(21),
      output_tokens: providerReportedMetricV1(8),
    }),
    host_usage: hostUsage({
      submissions: hostMeasuredMetricV1(1),
      retrievable_evidence_bytes: evidenceBytesMetricV1(16),
    }),
  }));
  const both = appendUsageReceiptV1(afterGrok, observation({
    telemetry: cursor.telemetry,
    recordedAt: '2026-08-22T12:00:01.000Z',
    identity: laneIdentity(cursor.telemetry, {
      assignmentId: 'docs-reviewer',
      provider: 'cursor-local',
      model: 'composer-1',
    }),
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(13),
      output_tokens: providerReportedMetricV1(5),
    }),
    host_usage: hostUsage({
      submissions: hostMeasuredMetricV1(1),
      retrievable_evidence_bytes: evidenceBytesMetricV1(8),
    }),
  }));
  assert.equal(both.receipts.length, 2);
  assert.equal(both.receipts[0].identity.provider, 'grok');
  assert.equal(both.receipts[1].identity.provider, 'cursor-local');
  assert.notEqual(
    both.receipts[0].identity.effective_model_digest,
    both.receipts[1].identity.effective_model_digest,
  );
  assert.equal(both.receipts[0].provider_usage.input_tokens.value, 21);
  assert.equal(both.receipts[1].provider_usage.input_tokens.value, 13);
  assert.equal(both.totals.provider_usage.input_tokens.value, null);
  assert.equal(both.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(both.totals.provider_usage.input_tokens.trust, 'unknown');
  assert.equal(both.totals.provider_usage.input_tokens.reported_sum, 34);
  assert.equal(both.totals.provider_usage.input_tokens.reported_count, 2);
  assert.equal(both.totals.provider_usage.input_tokens.unknown_count, 0);
  assert.notEqual(both.totals.provider_usage.input_tokens.trust, 'host_authoritative');
  assert.equal(both.totals.provider_usage.output_tokens.value, null);
  assert.equal(both.totals.host_usage.retrievable_evidence_bytes.value, 24);
  const grokRow = both.aggregates.find((row) => row.scope === 'provider' && row.key === 'grok');
  const cursorRow = both.aggregates.find((row) => (
    row.scope === 'provider' && row.key === 'cursor-local'
  ));
  assert.equal(grokRow.provider_usage.input_tokens.value, 21);
  assert.equal(cursorRow.provider_usage.input_tokens.value, 13);
});

test('run-runtime records Grok and Cursor tokens on separate lane identities', async () => {
  const writer = makeAssignment({ provider: 'grok', model: 'grok-4' });
  const cursor = makeVerifier();
  cursor.provider = 'cursor-local';
  cursor.model = 'composer-1';
  const harness = createRuntime();
  const request = makeSubmitRequest({ assignments: [writer, cursor] });
  await harness.runtime.submitRun(request);
  const lanes = harness.scheduler._runs.get(request.run_id).lanes;
  lanes.find((lane) => lane.assignment_id === writer.assignment_id).usage = {
    input_tokens: 21,
    output_tokens: 8,
  };
  lanes.find((lane) => lane.assignment_id === cursor.assignment_id).usage = {
    input_tokens: 13,
    output_tokens: 5,
  };
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  const identities = latestByIdentity(inspected.usage);
  assert.equal(identities.length, 2);
  const grok = identities.find((row) => row.identity.provider === 'grok');
  const cursorReceipt = identities.find((row) => row.identity.provider === 'cursor-local');
  assert.equal(grok.provider_usage.input_tokens.value, 21);
  assert.equal(cursorReceipt.provider_usage.input_tokens.value, 13);
  assert.notEqual(grok.identity.digest, cursorReceipt.identity.digest);
  assert.notEqual(inspected.usage.totals.provider_usage.input_tokens.value, 34);
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.value, null);
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.trust, 'unknown');
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.reported_sum, 34);
  assert.equal(inspected.usage.receipts.every((row) => (
    row.provider_usage.input_tokens.trust !== 'host_authoritative'
  )), true);
});

test('run-runtime homogeneous complete lanes roll up provider-reported tokens', async () => {
  const writer = makeAssignment({ provider: 'grok', model: 'grok-4' });
  const reviewer = makeVerifier();
  const harness = createRuntime();
  const request = makeSubmitRequest({ assignments: [writer, reviewer] });
  await harness.runtime.submitRun(request);
  const lanes = harness.scheduler._runs.get(request.run_id).lanes;
  lanes.find((lane) => lane.assignment_id === writer.assignment_id).usage = {
    input_tokens: 10,
    output_tokens: 4,
  };
  lanes.find((lane) => lane.assignment_id === reviewer.assignment_id).usage = {
    input_tokens: 5,
    output_tokens: 2,
  };
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  const identities = latestByIdentity(inspected.usage);
  assert.equal(identities.length, 2);
  assert.equal(identities.every((row) => row.identity.provider === 'grok'), true);
  assert.equal(
    identities[0].identity.effective_model_digest,
    identities[1].identity.effective_model_digest,
  );
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.value, 15);
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.source, 'provider_report');
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.trust, 'provider_untrusted');
  assert.equal(inspected.usage.totals.provider_usage.output_tokens.value, 6);
  assert.notEqual(inspected.usage.totals.provider_usage.input_tokens.trust, 'host_authoritative');
});

test('run-runtime accepts and reopens the maximum eight-lane usage ledger', async () => {
  const assignments = Array.from({ length: 8 }, (_, index) => makeAssignment({
    assignmentId: `usage-lane-${index + 1}`,
    taskId: `usage-task-${index + 1}`,
    writeScope: [`usage-${index + 1}/**`],
  }));
  const harness = createRuntime();
  const request = makeSubmitRequest({ assignments });
  const submitted = await harness.runtime.submitRun(request);
  assert.equal(submitted.usage.receipts.length, 8);
  assert.equal(submitted.usage.totals.identity_count, 8);
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  assert.equal(inspected.usage.receipts.length, 8);
  assert.equal(inspected.usage.digest, submitted.usage.digest);
  assert.equal(inspected.usage.totals.identity_count, 8);
});

test('usage summary stays bounded, omits receipts, and does not infer savings', () => {
  const telemetry = makeSubmission().telemetry;
  const recorded = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry,
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(11),
      output_tokens: providerReportedMetricV1(5),
    }),
    host_usage: hostUsage({
      model_facing_bytes: hostMeasuredMetricV1(128),
      retrievable_evidence_bytes: evidenceBytesMetricV1(64),
      submissions: hostMeasuredMetricV1(1),
    }),
  }));
  const summary = summarizeUsageLedgerV1(recorded);
  const encoded = Buffer.byteLength(JSON.stringify(summary), 'utf8');
  assert.equal(summary.view, 'summary');
  assert.equal(summary.present, true);
  assert.ok(encoded <= MAX_USAGE_SUMMARY_BYTES, encoded);
  assert.ok(Buffer.byteLength(summary.text, 'utf8') <= MAX_USAGE_SUMMARY_TEXT_BYTES);
  assert.equal(Object.hasOwn(summary, 'receipts'), false);
  assert.equal(summary.savings, 'not_inferred');
  assert.equal(summary.subscription, 'unknown');
  assert.equal(Object.hasOwn(summary, 'native_tokens'), false);
  const input = summary.metrics.find((row) => row.key === 'input_tokens');
  const bytes = summary.metrics.find((row) => row.key === 'model_facing_bytes');
  const evidence = summary.metrics.find((row) => row.key === 'retrievable_evidence_bytes');
  assert.equal(input.source, 'provider_report');
  assert.equal(input.trust, 'provider_untrusted');
  assert.equal(input.unit, 'tokens');
  assert.equal(bytes.source, 'host_measured');
  assert.equal(bytes.unit, 'bytes');
  assert.equal(evidence.source, 'evidence_bytes');
  assert.equal(evidence.unit, 'bytes');
  assert.equal(summary.unknown.includes('cost_millicents'), true);
  assert.equal(projectUsageReportV1(recorded).view, 'summary');
});

test('missing metrics stay unknown and are never hidden zeros', () => {
  const missing = unknownUsageReportV1('summary');
  assert.equal(missing.present, false);
  assert.equal(missing.identities, null);
  assert.equal(missing.observations, null);
  assert.equal(missing.metrics.length, 0);
  assert.equal(missing.unknown.includes('input_tokens'), true);
  assert.equal(JSON.stringify(missing).includes('"value":0'), false);
  const empty = summarizeUsageLedgerV1(openUsageLedgerV1({ budgets: [] }));
  assert.equal(empty.present, true);
  assert.equal(empty.identities, 0);
  assert.equal(empty.metrics.length, 0);
  assert.equal(empty.unknown.includes('input_tokens'), true);
  const telemetry = makeSubmission().telemetry;
  const recorded = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry,
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
  const summary = summarizeUsageLedgerV1(recorded);
  assert.equal(summary.metrics.find((row) => row.key === 'submissions').value, 1);
  assert.equal(summary.unknown.includes('input_tokens'), true);
  assert.equal(summary.metrics.some((row) => row.key === 'input_tokens'), false);
  const detailed = detailUsageLedgerV1(recorded);
  const input = detailed.metrics.find((row) => row.key === 'input_tokens');
  assert.equal(input.value, null);
  assert.equal(input.source, 'unknown');
  assert.equal(input.trust, 'unknown');
  assert.equal(detailed.unknown.includes('input_tokens'), true);
  assert.equal(detailed.view, 'detail');
});
