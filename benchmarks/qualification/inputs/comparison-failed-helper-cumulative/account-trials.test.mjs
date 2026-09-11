import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateArm,
  compareProviderTotals,
  parseAttemptSnapshots,
} from './account-trials.mjs';

function metric(value, source = 'host_measured') {
  return { value, source, trust: source === 'provider_report' ? 'provider_untrusted' : 'host_authoritative' };
}

function unknownMetric() {
  return { value: null, source: 'unknown', trust: 'unknown' };
}

test('failed attempts remain in usage-per-accepted denominators', () => {
  const row = aggregateArm([{
    trial_id: 'fail-then-pass',
    accepted: true,
    wall_elapsed_ms: metric(3000),
    attempts: [
      {
        attempt_id: 'first',
        kind: 'initial',
        outcome: 'failed',
        usage: { native_input_tokens: metric(10), elapsed_ms: metric(1000) },
      },
      {
        attempt_id: 'second',
        kind: 'correction',
        outcome: 'accepted',
        usage: { native_input_tokens: metric(15), elapsed_ms: metric(2000) },
      },
    ],
  }]);
  assert.equal(row.accepted_count, 1);
  assert.equal(row.failed_attempt_count, 1);
  assert.equal(row.correction_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 25);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.value, 25);
  assert.equal(
    row.usage_per_accepted_result.native_input_tokens.reason,
    'includes_failed_attempts_and_corrections',
  );
  assert.equal(row.usage_per_accepted_result.native_input_tokens.numerator, 25);
  assert.equal(row.usage.elapsed_ms.value, 3000);
  assert.equal(row.usage.elapsed_ms.role, 'attempt_duration_sum');
  assert.equal(row.usage.wall_elapsed_ms.value, 3000);
  assert.equal(row.usage.wall_elapsed_ms.role, 'trial_wall_elapsed');
});

test('mixed known and unknown acceptance leaves usage-per-accepted unknown', () => {
  const row = aggregateArm([
    {
      trial_id: 'known-accept',
      accepted: true,
      wall_elapsed_ms: metric(1000),
      attempts: [{
        attempt_id: 'ok',
        kind: 'initial',
        outcome: 'accepted',
        usage: { native_input_tokens: metric(10) },
      }],
    },
    {
      trial_id: 'missing-accept',
      wall_elapsed_ms: metric(700),
      attempts: [{
        attempt_id: 'maybe',
        kind: 'initial',
        outcome: 'uncertain',
        usage: { native_input_tokens: metric(7) },
      }],
    },
  ]);
  assert.equal(row.accepted_count, 1);
  assert.equal(row.accepted_known_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 17);
  const per = row.usage_per_accepted_result.native_input_tokens;
  assert.equal(per.value, null);
  assert.equal(per.reason, 'incomplete_acceptance_coverage');
  assert.equal(per.numerator, 17);
  assert.equal(row.acceptance_rate.value, null);
});

test('zero acceptance is not zero cost and unknown is not measured zero', () => {
  const row = aggregateArm([{
    trial_id: 'zero-accept',
    accepted: false,
    wall_elapsed_ms: metric(900),
    attempts: [{
      attempt_id: 'only',
      kind: 'initial',
      outcome: 'failed',
      usage: {
        native_input_tokens: metric(9),
        native_output_tokens: unknownMetric(),
      },
    }],
  }]);
  assert.equal(row.accepted_count, 0);
  assert.equal(row.usage.native_input_tokens.value, 9);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.value, null);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.reason, 'zero_accepted_not_zero_cost');
  assert.equal(row.usage.native_output_tokens.value, null);
  assert.equal(row.usage.native_output_tokens.source, 'unknown');
  assert.notEqual(row.usage.native_output_tokens.value, 0);
});

test('native helpers are counted once and parent usage must exclude them', () => {
  assert.throws(() => aggregateArm([{
    trial_id: 'parent-plus-helper',
    accepted: true,
    wall_elapsed_ms: metric(800),
    attempts: [
      {
        attempt_id: 'parent',
        kind: 'initial',
        outcome: 'accepted',
        usage: { native_input_tokens: metric(11), elapsed_ms: metric(600) },
      },
      {
        attempt_id: 'helper',
        kind: 'native_helper',
        outcome: 'accepted',
        usage: { native_helper_calls: metric(1), native_input_tokens: metric(4), elapsed_ms: metric(200) },
      },
    ],
  }]), (error) => error.code === 'identity_mismatch');

  const row = aggregateArm([{
    trial_id: 'excluded-parent',
    accepted: true,
    native_parent_excludes_helpers: true,
    wall_elapsed_ms: metric(800),
    attempts: [
      {
        attempt_id: 'parent',
        kind: 'initial',
        outcome: 'accepted',
        usage: { native_input_tokens: metric(11), elapsed_ms: metric(600) },
      },
      {
        attempt_id: 'helper',
        kind: 'native_helper',
        outcome: 'accepted',
        usage: { native_helper_calls: metric(1), native_input_tokens: metric(4), elapsed_ms: metric(200) },
      },
    ],
  }]);
  assert.equal(row.native_helper_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 15);
  assert.equal(row.usage.elapsed_ms.value, 800);
  assert.equal(row.usage.wall_elapsed_ms.value, 800);
  assert.equal(row.usage.elapsed_ms.role, 'attempt_duration_sum');
  assert.equal(row.usage.wall_elapsed_ms.role, 'trial_wall_elapsed');
});

test('duplicate attempt IDs keep the latest compatible cumulative snapshot', () => {
  const parsed = parseAttemptSnapshots([
    {
      attempt_id: 'same',
      kind: 'initial',
      outcome: 'failed',
      sequence: 1,
      usage: { native_input_tokens: metric(10) },
    },
    {
      attempt_id: 'same',
      kind: 'initial',
      outcome: 'failed',
      sequence: 2,
      usage: { native_input_tokens: metric(18) },
    },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].usage.native_input_tokens.value, 18);

  assert.throws(() => parseAttemptSnapshots([
    {
      attempt_id: 'same',
      kind: 'initial',
      outcome: 'failed',
      sequence: 1,
      usage: { native_input_tokens: metric(10) },
    },
    {
      attempt_id: 'same',
      kind: 'correction',
      outcome: 'failed',
      sequence: 2,
      usage: { native_input_tokens: metric(18) },
    },
  ]), (error) => error.code === 'incompatible_snapshot');

  assert.throws(() => parseAttemptSnapshots([
    {
      attempt_id: 'same',
      kind: 'initial',
      outcome: 'failed',
      sequence: 1,
      usage: { native_input_tokens: metric(10) },
    },
    {
      attempt_id: 'same',
      kind: 'initial',
      outcome: 'accepted',
      sequence: 2,
      usage: { native_input_tokens: metric(18) },
    },
  ]), (error) => error.code === 'incompatible_snapshot');

  assert.throws(() => parseAttemptSnapshots([
    {
      attempt_id: 'provider-attempt',
      sequence: 1,
      kind: 'initial',
      outcome: 'unfinal',
      provider: 'grok',
      model: 'model-a',
      usage: { provider_output_tokens: metric(20, 'provider_report') },
    },
    {
      attempt_id: 'provider-attempt',
      sequence: 2,
      kind: 'initial',
      outcome: 'unfinal',
      provider: 'grok',
      model: 'model-b',
      usage: { provider_output_tokens: metric(20, 'provider_report') },
    },
  ]), (error) => error.code === 'incompatible_snapshot');
});

test('mixed providers keep groups and make aggregate tokens non-comparable', () => {
  const attempts = [
    {
      attempt_id: 'grok-arm',
      kind: 'initial',
      outcome: 'completed_unaccepted',
      provider: 'grok',
      model: 'grok-4',
      usage: { provider_input_tokens: metric(40, 'provider_report') },
    },
    {
      attempt_id: 'cursor-arm',
      kind: 'correction',
      outcome: 'accepted',
      provider: 'cursor-local',
      model: 'composer',
      usage: { provider_input_tokens: metric(15, 'provider_report') },
    },
  ];
  const tokens = compareProviderTotals(attempts, 'provider_input_tokens');
  assert.equal(tokens.value, null);
  assert.equal(tokens.reason, 'mixed_providers_non_comparable');
  assert.equal(tokens.reported_sum, 55);
  assert.equal(tokens.groups.length, 2);
  assert.equal(tokens.groups[0].provider, 'cursor-local');
  assert.equal(tokens.groups[0].model, 'composer');
  assert.equal(tokens.groups[0].value, 15);
  assert.equal(tokens.groups[1].provider, 'grok');
  assert.equal(tokens.groups[1].model, 'grok-4');
  assert.equal(tokens.groups[1].value, 40);

  const row = aggregateArm([{
    trial_id: 'two-providers',
    accepted: true,
    wall_elapsed_ms: metric(1000),
    coengineer_source: { kind: 'git_commit', value: '3131f9ac7f6807eccb2ab68f027f1d98d3db3661' },
    attempts,
  }]);
  const grouped = row.usage.provider_input_tokens;
  assert.equal(grouped.value, null);
  assert.equal(grouped.reason, 'mixed_providers_non_comparable');

  assert.throws(() => aggregateArm([
    {
      trial_id: 'build-a',
      accepted: true,
      wall_elapsed_ms: metric(1000),
      coengineer_source: { kind: 'git_commit', value: '3131f9ac7f6807eccb2ab68f027f1d98d3db3661' },
      attempts: [{
        attempt_id: 'only-a',
        kind: 'initial',
        outcome: 'accepted',
        usage: { native_input_tokens: metric(3) },
      }],
    },
    {
      trial_id: 'build-b',
      accepted: true,
      wall_elapsed_ms: metric(1000),
      coengineer_source: { kind: 'synthetic_label', value: 'fixture:candidate-other' },
      attempts: [{
        attempt_id: 'only-b',
        kind: 'initial',
        outcome: 'accepted',
        usage: { native_input_tokens: metric(4) },
      }],
    },
  ]), (error) => error.code === 'mixed_candidate_identity');
});
