// UsageLedgerV1 hostile coverage: attempt/generation fencing, digest
// tamper, source forgery, and closed-object denials.

import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
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
  usageIdentityFromTelemetryV1,
  validateUsageIdentityV1,
  validateUsageLedgerV1,
} from '../mcp/v3/usage-ledger.mjs';
import { makeSubmission } from './fixtures/r1-run-store-fixtures.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  createMemoryArtifactBridge,
  createMemoryScheduler,
  createRuntime,
  makeAssignment,
  makeSubmitRequest,
  makeVerifier,
} from './fixtures/r1-run-runtime-fixtures.mjs';

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

function seededLedger(telemetry, identityExtra = {}) {
  return appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry,
    identityExtra,
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
}

test('stale and non-dense attempts are fenced', () => {
  const first = makeSubmission({ attempt: 1 });
  const later = makeSubmission({ attempt: 2 });
  const skip = makeSubmission({ attempt: 4 });
  const opened = openUsageLedgerV1({ budgets: [] });
  const recorded = appendUsageReceiptV1(opened, observation({ telemetry: first.telemetry }));
  assert.equal(
    errorOf(() => appendUsageReceiptV1(recorded, observation({
      telemetry: skip.telemetry,
      recordedAt: '2026-08-22T12:00:01.000Z',
    }))).code,
    'stale_attempt',
  );
  const advanced = appendUsageReceiptV1(recorded, observation({
    telemetry: later.telemetry,
    recordedAt: '2026-08-22T12:00:01.000Z',
  }));
  assert.equal(
    errorOf(() => appendUsageReceiptV1(advanced, observation({
      telemetry: first.telemetry,
      recordedAt: '2026-08-22T12:00:02.000Z',
    }))).code,
    'stale_attempt',
  );
});

test('stale and non-dense generations are fenced independently of attempt', () => {
  const telemetry = makeSubmission().telemetry;
  const opened = openUsageLedgerV1({ budgets: [] });
  const generationOne = appendUsageReceiptV1(opened, observation({
    telemetry,
    identityExtra: { generation: 1 },
  }));
  assert.equal(
    errorOf(() => appendUsageReceiptV1(generationOne, observation({
      telemetry,
      recordedAt: '2026-08-22T12:00:01.000Z',
      identityExtra: { generation: 3 },
    }))).code,
    'stale_generation',
  );
  const generationTwo = appendUsageReceiptV1(generationOne, observation({
    telemetry,
    recordedAt: '2026-08-22T12:00:01.000Z',
    identityExtra: { generation: 2 },
  }));
  assert.notEqual(
    generationTwo.receipts[1].identity.digest,
    generationOne.receipts[0].identity.digest,
  );
  assert.equal(
    errorOf(() => appendUsageReceiptV1(generationTwo, observation({
      telemetry,
      recordedAt: '2026-08-22T12:00:02.000Z',
      identityExtra: { generation: 1 },
    }))).code,
    'stale_generation',
  );
});

test('digest, totals, and receipt tampers fail closed', () => {
  const telemetry = makeSubmission().telemetry;
  const ledger = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry,
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(4),
    }),
    host_usage: hostUsage({
      submissions: hostMeasuredMetricV1(1),
      retrievable_evidence_bytes: evidenceBytesMetricV1(32),
    }),
  }));
  assert.equal(validateUsageLedgerV1(ledger).digest, ledger.digest);

  const digestTamper = {
    ...ledger,
    digest: `sha256:${'ab'.repeat(32)}`,
  };
  assert.equal(errorOf(() => validateUsageLedgerV1(digestTamper)).code, 'identity_mismatch');

  const totalsTamper = {
    ...ledger,
    totals: {
      ...ledger.totals,
      provider_usage: {
        ...ledger.totals.provider_usage,
        input_tokens: {
          ...ledger.totals.provider_usage.input_tokens,
          value: 0,
          source: 'provider_report',
          trust: 'provider_untrusted',
        },
      },
    },
  };
  assert.equal(errorOf(() => validateUsageLedgerV1(totalsTamper)).code, 'identity_mismatch');

  const receiptTamper = {
    ...ledger,
    receipts: [{
      ...ledger.receipts[0],
      host_usage: {
        ...ledger.receipts[0].host_usage,
        submissions: hostMeasuredMetricV1(9),
      },
    }],
  };
  assert.equal(errorOf(() => validateUsageLedgerV1(receiptTamper)).code, 'identity_mismatch');

  const rewrittenPrior = appendUsageReceiptV1(ledger, observation({
    telemetry,
    seq: 2,
    recordedAt: '2026-08-22T12:00:02.000Z',
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(4),
    }),
    host_usage: hostUsage({
      submissions: hostMeasuredMetricV1(1),
      retrievable_evidence_bytes: evidenceBytesMetricV1(32),
      tool_calls: hostMeasuredMetricV1(1),
    }),
  }));
  const mutatedHistory = {
    ...rewrittenPrior,
    receipts: [
      {
        ...rewrittenPrior.receipts[0],
        host_usage: {
          ...rewrittenPrior.receipts[0].host_usage,
          submissions: hostMeasuredMetricV1(2),
        },
      },
      rewrittenPrior.receipts[1],
    ],
  };
  assert.equal(
    errorOf(() => assertUsageLedgerContinuityV1(ledger, mutatedHistory)).code,
    'identity_mismatch',
  );
});

test('unknown usage cannot be a recorded zero and identities cannot drop generation', () => {
  const telemetry = makeSubmission().telemetry;
  assert.equal(
    errorOf(() => appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
      telemetry,
      provider_usage: providerUsage({
        input_tokens: { value: 0, source: 'unknown', trust: 'unknown' },
      }),
    }))).code,
    'identity_mismatch',
  );
  assert.equal(
    errorOf(() => appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
      telemetry,
      provider_usage: providerUsage({
        input_tokens: { value: null, source: 'provider_report', trust: 'provider_untrusted' },
      }),
    }))).code,
    'identity_mismatch',
  );
  const identity = boundIdentity(telemetry, { generation: 1 });
  const dropped = {
    ...identityFields(identity),
    generation: identity.generation,
    digest: identity.digest,
    schema: identity.schema,
  };
  const mutated = { ...dropped, generation: 2 };
  assert.equal(errorOf(() => validateUsageIdentityV1(mutated)).code, 'identity_mismatch');
});

test('proxy, billing, and transcript fields fail closed', () => {
  const { proxy, counts } = countingProxy({ budgets: [] });
  assert.equal(errorOf(() => openUsageLedgerV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);
  assert.equal(utilTypes.isProxy(proxy), true);

  const telemetry = makeSubmission().telemetry;
  assert.equal(
    errorOf(() => appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), {
      ...observation({ telemetry }),
      billing: 12,
    })).code,
    'billing_surface_denied',
  );
  assert.equal(
    errorOf(() => appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), {
      ...observation({ telemetry }),
      transcript: 'ATTACKER',
    })).code,
    'prompt_content_denied',
  );
  const error = errorOf(() => appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), {
    ...observation({ telemetry }),
    prompt: 'sk-live-secret',
  }));
  assert.equal(error.code, 'prompt_content_denied');
  assert.doesNotMatch(error.message, /sk-live-secret/u);
});

test('equal revisions require canonical identity and regressions fail closed', () => {
  const telemetry = makeSubmission().telemetry;
  const first = seededLedger(telemetry);
  assert.equal(assertUsageLedgerContinuityV1(first, first), true);
  const next = appendUsageReceiptV1(first, observation({
    telemetry,
    seq: 2,
    recordedAt: '2026-08-22T12:00:02.000Z',
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1), tool_calls: hostMeasuredMetricV1(1) }),
  }));
  assert.equal(assertUsageLedgerContinuityV1(first, next), true);
  assert.equal(
    errorOf(() => assertUsageLedgerContinuityV1(next, first)).code,
    'revision_regressed',
  );
  const sameRevisionDifferent = {
    ...first,
    budgets: [...first.budgets],
  };
  assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(sameRevisionDifferent));
  const rebuilt = buildUsageIdentityV1(identityFields(boundIdentity(telemetry)));
  assert.equal(rebuilt.digest, first.receipts[0].identity.digest);
});

test('complementary missing input and output cannot become one complete total', () => {
  const first = makeSubmission({ assignmentId: ASSIGNMENT_ID });
  const second = makeSubmission({ assignmentId: 'docs-reviewer', runId: first.run_id });
  const afterInput = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry: first.telemetry,
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(11),
    }),
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
  const mixed = appendUsageReceiptV1(afterInput, observation({
    telemetry: second.telemetry,
    recordedAt: '2026-08-22T12:00:01.000Z',
    provider_usage: providerUsage({
      output_tokens: providerReportedMetricV1(7),
    }),
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
  assert.equal(mixed.receipts.length, 2);
  assert.notEqual(mixed.receipts[0].identity.digest, mixed.receipts[1].identity.digest);
  assert.equal(mixed.receipts[0].provider_usage.input_tokens.value, 11);
  assert.equal(mixed.receipts[0].provider_usage.output_tokens.value, null);
  assert.equal(mixed.receipts[1].provider_usage.input_tokens.value, null);
  assert.equal(mixed.receipts[1].provider_usage.output_tokens.value, 7);
  assert.equal(mixed.totals.provider_usage.input_tokens.value, null);
  assert.equal(mixed.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(mixed.totals.provider_usage.input_tokens.reported_sum, 11);
  assert.equal(mixed.totals.provider_usage.input_tokens.unknown_count, 1);
  assert.equal(mixed.totals.provider_usage.output_tokens.value, null);
  assert.equal(mixed.totals.provider_usage.output_tokens.reported_sum, 7);
  assert.equal(mixed.totals.provider_usage.output_tokens.unknown_count, 1);
  assert.notEqual(mixed.totals.provider_usage.input_tokens.value, 11);
  assert.notEqual(mixed.totals.provider_usage.output_tokens.value, 7);
});

test('runtime complementary missing tokens stay lane-bound and incomplete', async () => {
  const writer = makeAssignment();
  const reviewer = makeVerifier();
  const harness = createRuntime();
  const request = makeSubmitRequest({ assignments: [writer, reviewer] });
  await harness.runtime.submitRun(request);
  const lanes = harness.scheduler._runs.get(request.run_id).lanes;
  lanes.find((lane) => lane.assignment_id === writer.assignment_id).usage = {
    input_tokens: 11,
  };
  lanes.find((lane) => lane.assignment_id === reviewer.assignment_id).usage = {
    output_tokens: 7,
  };
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  const identities = latestByIdentity(inspected.usage);
  assert.equal(identities.length, 2);
  const writerReceipt = identities.find((row) => (
    row.identity.assignment_id_digest === correlateUsageAssignmentV1(writer.assignment_id)
  ));
  const reviewerReceipt = identities.find((row) => (
    row.identity.assignment_id_digest === correlateUsageAssignmentV1(reviewer.assignment_id)
  ));
  assert.equal(writerReceipt.provider_usage.input_tokens.value, 11);
  assert.equal(writerReceipt.provider_usage.output_tokens.value, null);
  assert.equal(reviewerReceipt.provider_usage.input_tokens.value, null);
  assert.equal(reviewerReceipt.provider_usage.output_tokens.value, 7);
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.value, null);
  assert.equal(inspected.usage.totals.provider_usage.output_tokens.value, null);
  assert.notEqual(inspected.usage.totals.provider_usage.input_tokens.value, 11);
  assert.notEqual(inspected.usage.totals.provider_usage.output_tokens.value, 7);
});

test('Grok and Cursor token reports cannot share one run telemetry identity', async () => {
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
  assert.equal(new Set(identities.map((row) => row.identity.digest)).size, 2);
  assert.equal(new Set(identities.map((row) => row.identity.provider)).size, 2);
  const grok = identities.find((row) => row.identity.provider === 'grok');
  const cursorReceipt = identities.find((row) => row.identity.provider === 'cursor-local');
  assert.equal(grok.provider_usage.input_tokens.value, 21);
  assert.equal(cursorReceipt.provider_usage.input_tokens.value, 13);
  assert.equal(grok.provider_usage.input_tokens.source, 'provider_report');
  assert.equal(cursorReceipt.provider_usage.input_tokens.trust, 'provider_untrusted');
  assert.notEqual(grok.provider_usage.input_tokens.trust, 'host_authoritative');
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.value, null);
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.source, 'unknown');
  assert.notEqual(inspected.usage.totals.provider_usage.input_tokens.value, 34);
});

test('runtime same-provider different models stay lane-bound and unsummed', async () => {
  const writer = makeAssignment({ provider: 'grok', model: 'grok-4' });
  const reviewer = makeVerifier();
  reviewer.model = 'grok-code-fast-1';
  const harness = createRuntime();
  const request = makeSubmitRequest({ assignments: [writer, reviewer] });
  await harness.runtime.submitRun(request);
  const lanes = harness.scheduler._runs.get(request.run_id).lanes;
  lanes.find((lane) => lane.assignment_id === writer.assignment_id).usage = {
    input_tokens: 9,
    output_tokens: 3,
  };
  lanes.find((lane) => lane.assignment_id === reviewer.assignment_id).usage = {
    input_tokens: 6,
    output_tokens: 2,
  };
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  const identities = latestByIdentity(inspected.usage);
  assert.equal(identities.length, 2);
  assert.equal(identities.every((row) => row.identity.provider === 'grok'), true);
  assert.notEqual(
    identities[0].identity.effective_model_digest,
    identities[1].identity.effective_model_digest,
  );
  assert.equal(
    identities.find((row) => (
      row.identity.assignment_id_digest === correlateUsageAssignmentV1(writer.assignment_id)
    )).provider_usage.input_tokens.value,
    9,
  );
  assert.equal(
    identities.find((row) => (
      row.identity.assignment_id_digest === correlateUsageAssignmentV1(reviewer.assignment_id)
    )).provider_usage.input_tokens.value,
    6,
  );
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.value, null);
  assert.equal(inspected.usage.totals.provider_usage.input_tokens.source, 'unknown');
  assert.notEqual(inspected.usage.totals.provider_usage.input_tokens.value, 15);
});

test('same-provider different models cannot share one token identity', () => {
  const first = makeSubmission({ assignmentId: ASSIGNMENT_ID });
  const second = makeSubmission({ assignmentId: 'docs-reviewer', runId: first.run_id });
  const afterGrok4 = appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
    telemetry: first.telemetry,
    identity: laneIdentity(first.telemetry, {
      assignmentId: ASSIGNMENT_ID,
      provider: 'grok',
      model: 'grok-4',
    }),
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(9),
      output_tokens: providerReportedMetricV1(3),
    }),
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
  const both = appendUsageReceiptV1(afterGrok4, observation({
    telemetry: second.telemetry,
    recordedAt: '2026-08-22T12:00:01.000Z',
    identity: laneIdentity(second.telemetry, {
      assignmentId: 'docs-reviewer',
      provider: 'grok',
      model: 'grok-code-fast-1',
    }),
    provider_usage: providerUsage({
      input_tokens: providerReportedMetricV1(6),
      output_tokens: providerReportedMetricV1(2),
    }),
    host_usage: hostUsage({ submissions: hostMeasuredMetricV1(1) }),
  }));
  assert.equal(both.receipts[0].identity.provider, 'grok');
  assert.equal(both.receipts[1].identity.provider, 'grok');
  assert.notEqual(
    both.receipts[0].identity.effective_model_digest,
    both.receipts[1].identity.effective_model_digest,
  );
  assert.equal(both.receipts[0].provider_usage.input_tokens.value, 9);
  assert.equal(both.receipts[1].provider_usage.input_tokens.value, 6);
  assert.equal(both.totals.provider_usage.input_tokens.value, null);
  assert.equal(both.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(both.totals.provider_usage.input_tokens.trust, 'unknown');
  assert.equal(both.totals.provider_usage.input_tokens.reported_sum, 15);
  assert.notEqual(both.totals.provider_usage.input_tokens.value, 15);
  const grokProvider = both.aggregates.find((row) => row.scope === 'provider' && row.key === 'grok');
  assert.equal(grokProvider.identity_count, 2);
  assert.equal(grokProvider.provider_usage.input_tokens.value, null);
});

test('missing evidence bytes cannot skip-and-sum an authoritative total', async () => {
  const writer = makeAssignment();
  const reviewer = makeVerifier();
  const scheduler = createMemoryScheduler();
  const artifactBridge = createMemoryArtifactBridge();
  const originalProject = artifactBridge.projectAssignmentArtifacts.bind(artifactBridge);
  artifactBridge.projectAssignmentArtifacts = async (input) => {
    const projected = await originalProject(input);
    if (input.assignment_id !== writer.assignment_id) {
      return { ...projected, artifacts: [] };
    }
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
  const request = makeSubmitRequest({ assignments: [writer, reviewer] });
  await harness.runtime.submitRun(request);
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  const identities = latestByIdentity(inspected.usage);
  assert.equal(identities.length, 2);
  const writerReceipt = identities.find((row) => (
    row.identity.assignment_id_digest === correlateUsageAssignmentV1(writer.assignment_id)
  ));
  const reviewerReceipt = identities.find((row) => (
    row.identity.assignment_id_digest === correlateUsageAssignmentV1(reviewer.assignment_id)
  ));
  assert.equal(writerReceipt.host_usage.retrievable_evidence_bytes.value, 48);
  assert.equal(writerReceipt.host_usage.retrievable_evidence_bytes.source, 'evidence_bytes');
  assert.equal(reviewerReceipt.host_usage.retrievable_evidence_bytes.value, null);
  assert.equal(reviewerReceipt.host_usage.retrievable_evidence_bytes.source, 'unknown');
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.value, null);
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.source, 'unknown');
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.reported_sum, 48);
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.unknown_count, 1);
  assert.notEqual(inspected.usage.totals.host_usage.retrievable_evidence_bytes.value, 48);
});

test('incomplete sibling artifacts cannot skip-and-sum an authoritative evidence total', async () => {
  const scheduler = createMemoryScheduler();
  const artifactBridge = createMemoryArtifactBridge();
  const originalProject = artifactBridge.projectAssignmentArtifacts.bind(artifactBridge);
  artifactBridge.projectAssignmentArtifacts = async (input) => {
    const projected = await originalProject(input);
    const base = (projected.artifacts ?? [])[0] ?? {};
    return {
      ...projected,
      artifacts: [
        { ...base, sanitized_byte_length: 48 },
        { ...base },
      ],
    };
  };
  const harness = createRuntime({ scheduler, artifactBridge });
  const request = makeSubmitRequest();
  await harness.runtime.submitRun(request);
  const inspected = await harness.runtime.inspectRun({ run_id: request.run_id });
  const identities = latestByIdentity(inspected.usage);
  assert.equal(identities.length, 1);
  const evidence = identities[0].host_usage.retrievable_evidence_bytes;
  assert.equal(evidence.value, null);
  assert.equal(evidence.source, 'unknown');
  assert.equal(evidence.trust, 'unknown');
  assert.notEqual(evidence.trust, 'host_authoritative');
  assert.notEqual(evidence.value, 48);
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.value, null);
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.source, 'unknown');
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.trust, 'unknown');
  assert.equal(inspected.usage.totals.host_usage.retrievable_evidence_bytes.unknown_count, 1);
  assert.notEqual(inspected.usage.totals.host_usage.retrievable_evidence_bytes.trust, 'host_authoritative');
  assert.notEqual(inspected.usage.totals.host_usage.retrievable_evidence_bytes.value, 48);
});

test('partial lane attribution cannot mint a host-authoritative token total', () => {
  const first = makeSubmission({ assignmentId: ASSIGNMENT_ID });
  const second = makeSubmission({ assignmentId: 'docs-reviewer', runId: first.run_id });
  const ledger = appendUsageReceiptV1(
    appendUsageReceiptV1(openUsageLedgerV1({ budgets: [] }), observation({
      telemetry: first.telemetry,
      identity: laneIdentity(first.telemetry, {
        assignmentId: ASSIGNMENT_ID,
        provider: 'grok',
        model: 'grok-4',
      }),
      provider_usage: providerUsage({
        input_tokens: providerReportedMetricV1(4),
      }),
    })),
    observation({
      telemetry: second.telemetry,
      recordedAt: '2026-08-22T12:00:01.000Z',
      identity: laneIdentity(second.telemetry, {
        assignmentId: 'docs-reviewer',
        provider: 'cursor-local',
        model: 'composer-1',
      }),
    }),
  );
  assert.equal(ledger.totals.provider_usage.input_tokens.value, null);
  assert.equal(ledger.totals.provider_usage.input_tokens.source, 'unknown');
  assert.equal(ledger.totals.provider_usage.input_tokens.trust, 'unknown');
  assert.notEqual(ledger.totals.provider_usage.input_tokens.trust, 'host_authoritative');
  assert.equal(ledger.totals.provider_usage.input_tokens.reported_sum, 4);
  assert.equal(ledger.totals.provider_usage.input_tokens.unknown_count, 1);
});
