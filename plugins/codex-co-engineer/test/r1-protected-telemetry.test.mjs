import assert from 'node:assert/strict';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  DISPATCH_PROVENANCE_SCHEMA_ID,
  DISPATCH_TELEMETRY_SCHEMA_ID,
  MAX_TELEMETRY_BYTES,
  SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY,
  assertDispatchProvenanceContinuityV1,
  assertDispatchTelemetryContinuityV1,
  buildDispatchProvenanceV1,
  projectDispatchTelemetryV1,
  validateDispatchProvenanceV1,
  validateDispatchTelemetryV1,
} from '../mcp/v3/protected-telemetry.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { resolveRunSelectionV1 } from '../mcp/v3/resolver.mjs';
import {
  DISPATCHED_AT,
  OPENED_AT,
  SETTLED_AT,
  fixtureGit,
  fixtureManifest,
  fixtureProviderRun,
  pendingProvenanceInput,
  succeededProvenanceInput,
} from './fixtures/r1-protected-identity-fixtures.mjs';
import { resolveInputs } from './fixtures/r1-resolver-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertFrozenTree(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') assertFrozenTree(child);
    }
  }
}

test('pending provenance is closed, frozen, and shares one Git identity', () => {
  const record = buildDispatchProvenanceV1(pendingProvenanceInput());
  assert.equal(record.schema, DISPATCH_PROVENANCE_SCHEMA_ID);
  assert.equal(record.git.digest, record.run.git.digest);
  assert.equal(record.workspace.git.digest, record.run.git.digest);
  assert.equal(record.provider_run.git.digest, record.run.git.digest);
  assert.equal(record.repository_exposure, SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY);
  assert.equal(record.outcome, 'pending');
  assert.equal(record.model_mismatch, 'served_model_not_observed');
  assertFrozenTree(record);
  assert.equal(validateDispatchProvenanceV1(record).run.digest, record.run.digest);
});

test('success requires a transport-observed exact model and a provider identifier', () => {
  const record = buildDispatchProvenanceV1(succeededProvenanceInput());
  assert.equal(record.outcome, 'succeeded');
  assert.equal(record.observation.source, 'transport_observation');
  assert.equal(record.model_mismatch, 'none');
  const reportOnly = succeededProvenanceInput({
    observation: { source: 'provider_report' },
  });
  assert.equal(errorOf(() => buildDispatchProvenanceV1(reportOnly)).code, 'model_unverified');
  const noRef = succeededProvenanceInput({
    provider_run: fixtureProviderRun({ agent_id: null, provider_run_id: null }),
  });
  assert.equal(errorOf(() => buildDispatchProvenanceV1(noRef)).code, 'missing_key');
});

test('P05 capability snapshot digest and repository exposure bind without rewriting identity', () => {
  const record = buildDispatchProvenanceV1(pendingProvenanceInput());
  const resolved = resolveRunSelectionV1(resolveInputs(fixtureManifest()));
  assert.equal(record.provider_run.capability_snapshot_digest, resolved.capability_snapshot_digest);
  assert.equal(record.repository_exposure, resolved.repository_exposure);
  assert.equal(record.lineage.capability_snapshot_digest, resolved.capability_snapshot_digest);
});

test('telemetry is content-free, byte-capped, and omits idempotency and raw identifiers', () => {
  const record = buildDispatchProvenanceV1(succeededProvenanceInput());
  const view = projectDispatchTelemetryV1(record);
  assert.equal(view.schema, DISPATCH_TELEMETRY_SCHEMA_ID);
  assert.match(view.run_id_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(view.assignment_id_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(view.resolved_model_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(view.provider, 'grok');
  const encoded = canonicalJsonStringify(view);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= MAX_TELEMETRY_BYTES);
  assert.doesNotMatch(encoded, /identity-under-test/u);
  assert.doesNotMatch(encoded, /backend-writer/u);
  assert.doesNotMatch(encoded, /grok-4/u);
  assert.doesNotMatch(encoded, /\/run-fixtures\/repository/u);
  assert.doesNotMatch(encoded, /agent-grok-01/u);
  assert.doesNotMatch(encoded, /request_idempotency_key/u);
  assert.doesNotMatch(encoded, /Prompt for/u);
  assert.doesNotMatch(encoded, /sk-/u);
  assert.equal(Object.hasOwn(view, 'request_idempotency_key'), false);
  assertFrozenTree(view);
  assert.equal(validateDispatchTelemetryV1(view).revision, view.revision);
});

test('monotonic provenance can fill unknown facts once and cannot drop or rewrite them', () => {
  const pending = buildDispatchProvenanceV1(pendingProvenanceInput());
  const dispatched = buildDispatchProvenanceV1(pendingProvenanceInput({
    revision: 2,
    observed: { provider: 'grok', model: 'grok-4' },
    observation: { source: 'transport_observation' },
    model_mismatch: 'none',
    timing: {
      opened_at: OPENED_AT,
      dispatched_at: DISPATCHED_AT,
      settled_at: null,
      dispatch_latency_ms: 1000,
      total_duration_ms: null,
    },
    counters: { dispatch_calls: 1, wake_events: 0, outcome_events: 0 },
    outcome: 'needs_attention',
  }));
  assert.equal(assertDispatchProvenanceContinuityV1(pending, dispatched), true);

  const dropObservation = buildDispatchProvenanceV1(pendingProvenanceInput({
    revision: 3,
    timing: dispatched.timing,
    counters: dispatched.counters,
    outcome: 'needs_attention',
  }));
  // Rebuild as a next record that forgets the observation.
  assert.equal(
    errorOf(() => assertDispatchProvenanceContinuityV1(dispatched, dropObservation)).code,
    'identity_mismatch',
  );

  const rewriteOpened = {
    ...dispatched,
    revision: 3,
    timing: {
      ...dispatched.timing,
      opened_at: '2026-08-22T11:00:00.000Z',
      dispatch_latency_ms: 3_601_000,
    },
  };
  assert.equal(
    errorOf(() => assertDispatchProvenanceContinuityV1(dispatched, rewriteOpened)).code,
    'identity_mismatch',
  );
});

test('equal revisions require byte identity and settled outcomes are absorbing', () => {
  const first = buildDispatchProvenanceV1(succeededProvenanceInput());
  assert.equal(assertDispatchProvenanceContinuityV1(first, first), true);
  const sameRevision = buildDispatchProvenanceV1(succeededProvenanceInput({
    revision: 1,
    counters: { dispatch_calls: 1, wake_events: 2, outcome_events: 1 },
  }));
  assert.equal(
    errorOf(() => assertDispatchProvenanceContinuityV1(first, sameRevision)).code,
    'identity_mismatch',
  );
  const reopened = buildDispatchProvenanceV1(succeededProvenanceInput({
    revision: 2,
    outcome: 'failed',
    observed: { provider: 'grok', model: 'grok-4' },
    observation: { source: 'transport_observation' },
    model_mismatch: 'none',
    provider_run: first.provider_run,
    timing: first.timing,
    counters: { dispatch_calls: 1, wake_events: 1, outcome_events: 2 },
  }));
  assert.equal(
    errorOf(() => assertDispatchProvenanceContinuityV1(first, reopened)).code,
    'terminal_outcome_changed',
  );
});

test('counters cannot decrease and telemetry continuity mirrors protected facts', () => {
  const pending = buildDispatchProvenanceV1(pendingProvenanceInput());
  const dispatched = buildDispatchProvenanceV1(pendingProvenanceInput({
    revision: 2,
    timing: {
      opened_at: OPENED_AT,
      dispatched_at: DISPATCHED_AT,
      settled_at: null,
      dispatch_latency_ms: 1000,
      total_duration_ms: null,
    },
    counters: { dispatch_calls: 1, wake_events: 0, outcome_events: 0 },
    outcome: 'needs_attention',
    observed: { provider: 'grok', model: 'grok-4' },
    observation: { source: 'transport_observation' },
    model_mismatch: 'none',
  }));
  const later = buildDispatchProvenanceV1(pendingProvenanceInput({
    revision: 3,
    timing: dispatched.timing,
    counters: { dispatch_calls: 1, wake_events: 2, outcome_events: 0 },
    outcome: 'needs_attention',
    observed: { provider: 'grok', model: 'grok-4' },
    observation: { source: 'transport_observation' },
    model_mismatch: 'none',
  }));
  assert.equal(assertDispatchProvenanceContinuityV1(pending, dispatched), true);
  assert.equal(assertDispatchProvenanceContinuityV1(dispatched, later), true);
  const down = buildDispatchProvenanceV1(pendingProvenanceInput({
    revision: 4,
    timing: later.timing,
    counters: { dispatch_calls: 1, wake_events: 1, outcome_events: 0 },
    outcome: 'needs_attention',
    observed: { provider: 'grok', model: 'grok-4' },
    observation: { source: 'transport_observation' },
    model_mismatch: 'none',
  }));
  assert.equal(
    errorOf(() => assertDispatchProvenanceContinuityV1(later, down)).code,
    'counter_regressed',
  );

  const pendingView = projectDispatchTelemetryV1(pending);
  const laterView = projectDispatchTelemetryV1(later);
  assert.equal(assertDispatchTelemetryContinuityV1(pendingView, laterView), true);
  assert.equal(
    errorOf(() => assertDispatchTelemetryContinuityV1(laterView, projectDispatchTelemetryV1(down))).code,
    'counter_regressed',
  );
});

test('shared Git identity drift and unknown telemetry keys fail closed', () => {
  const driftedGit = { ...fixtureGit(), repository_path: '/run-fixtures/other' };
  assert.equal(
    errorOf(() => buildDispatchProvenanceV1(pendingProvenanceInput({ git: driftedGit }))).code,
    'identity_mismatch',
  );
  const view = projectDispatchTelemetryV1(buildDispatchProvenanceV1(pendingProvenanceInput()));
  assert.equal(
    errorOf(() => validateDispatchTelemetryV1({ ...view, prompt: 'ATTACKER' })).code,
    'prompt_content_denied',
  );
});

test('agent identifier fill is a monotone continuation of the provider-run tuple', () => {
  const pending = buildDispatchProvenanceV1(pendingProvenanceInput());
  const filled = buildDispatchProvenanceV1(pendingProvenanceInput({
    revision: 2,
    provider_run: fixtureProviderRun({ agent_id: 'agent-grok-01' }),
    timing: {
      opened_at: OPENED_AT,
      dispatched_at: DISPATCHED_AT,
      settled_at: SETTLED_AT,
      dispatch_latency_ms: 1000,
      total_duration_ms: 5000,
    },
    counters: { dispatch_calls: 1, wake_events: 1, outcome_events: 1 },
    observed: { provider: 'grok', model: 'grok-4' },
    observation: { source: 'transport_observation' },
    model_mismatch: 'none',
    outcome: 'succeeded',
  }));
  assert.equal(assertDispatchProvenanceContinuityV1(pending, filled), true);
  assert.equal(filled.provider_run.agent_id, 'agent-grok-01');
  assert.notEqual(filled.provider_run.digest, pending.provider_run.digest);
  assert.equal(filled.provider_run.request_idempotency_key, pending.provider_run.request_idempotency_key);
});
