import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalJsonStringify } from '../plugins/codex-co-engineer/mcp/v3/identity.mjs';
import {
  compareTrials,
  parseTrial,
} from '../scripts/compare-coengineer-runs.mjs';

const CASE_SCHEMA = 'codex-co-engineer.benchmark-case.v1';
const TRIAL_SCHEMA = 'codex-co-engineer.benchmark-trial.v1';
const BASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CANDIDATE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_COMMIT = 'cccccccccccccccccccccccccccccccccccccccc';
const INPUT_DIGEST_DOMAIN = 'codex-co-engineer.benchmark-input.v1';

function settings() {
  return { reasoning: 'high', sandbox: 'workspace-write' };
}

function metric(value, source = 'host_measured') {
  return {
    value,
    source,
    trust: source === 'provider_report' ? 'provider_untrusted' : 'host_authoritative',
  };
}

function unknownMetric() {
  return { value: null, source: 'unknown', trust: 'unknown' };
}

function frozenCase() {
  const files = { 'TASK.md': '# accounting\n' };
  const acceptance = { checks: [{ id: 'unit' }] };
  return {
    schema: CASE_SCHEMA,
    id: 'accounting-case',
    title: 'accounting',
    summary: 'failed helper cumulative accounting',
    base_sha: BASE_SHA,
    input_digest: createHash('sha256')
      .update(INPUT_DIGEST_DOMAIN, 'utf8')
      .update('\n', 'utf8')
      .update(canonicalJsonStringify({ files, acceptance }), 'utf8')
      .digest('hex'),
    comparable: {
      host_model: 'recorded-host-model',
      host_settings: settings(),
      provider_configuration: { implement: 'grok', review: 'cursor-local' },
    },
    inputs: { files },
    acceptance,
  };
}

function trial(overrides = {}) {
  const arm = overrides.arm ?? 'candidate-3.4.3';
  const caseRecord = frozenCase();
  return {
    schema: TRIAL_SCHEMA,
    trial_id: overrides.trial_id ?? 'trial-one',
    case_id: 'accounting-case',
    arm,
    base_sha: BASE_SHA,
    input_digest: caseRecord.input_digest,
    coengineer_source: arm === 'native-codex'
      ? { kind: 'native', value: 'native-codex' }
      : { kind: 'git_commit', value: CANDIDATE_COMMIT },
    host_model: 'recorded-host-model',
    host_settings: settings(),
    provider_configuration: arm === 'native-codex'
      ? { implement: 'native' }
      : { implement: 'grok', review: 'cursor-local' },
    accepted: true,
    wall_elapsed_ms: metric(1000),
    attempts: [{
      attempt_id: 'attempt-one',
      kind: 'initial',
      outcome: 'accepted',
      usage: { native_input_tokens: metric(10), elapsed_ms: metric(1000) },
    }],
    ...overrides,
  };
}

function armRow(trials, arm = 'candidate-3.4.3') {
  const comparison = compareTrials([frozenCase()], trials);
  return comparison.cases[0].arms[arm];
}

test('failed attempts remain in the usage-per-accepted numerator', () => {
  const row = armRow([trial({
    trial_id: 'fail-then-pass',
    accepted: true,
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
  })]);
  assert.equal(row.accepted_count, 1);
  assert.equal(row.failed_attempt_count, 1);
  assert.equal(row.correction_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 25);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.value, 25);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.numerator, 25);
  assert.match(String(row.usage_per_accepted_result.native_input_tokens.reason), /failed/u);
});

test('mixed known and unknown acceptance leaves usage-per-accepted unknown', () => {
  const missing = structuredClone(trial({ trial_id: 'missing-accept' }));
  delete missing.accepted;
  missing.attempts = [{
    attempt_id: 'maybe',
    kind: 'initial',
    outcome: 'uncertain',
    usage: { native_input_tokens: metric(7) },
  }];
  const compared = armRow([
    trial({ trial_id: 'known-accept' }),
    missing,
  ]);
  assert.equal(compared.accepted_count, 1);
  assert.equal(compared.usage.native_input_tokens.value, 17);
  const per = compared.usage_per_accepted_result.native_input_tokens;
  assert.equal(per.value, null);
  assert.equal(per.reason, 'incomplete_acceptance_coverage');
  assert.equal(per.numerator, 17);
  assert.equal(compared.acceptance_rate.value, null);
});

test('zero acceptance is not zero cost and unknown is not measured zero', () => {
  const row = armRow([trial({
    trial_id: 'zero-accept',
    accepted: false,
    attempts: [{
      attempt_id: 'only',
      kind: 'initial',
      outcome: 'failed',
      usage: {
        native_input_tokens: metric(9),
        native_output_tokens: unknownMetric(),
      },
    }],
  })]);
  assert.equal(row.accepted_count, 0);
  assert.equal(row.usage.native_input_tokens.value, 9);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.value, null);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.reason, 'zero_accepted_not_zero_cost');
  assert.equal(row.usage.native_output_tokens.value, null);
  assert.equal(row.usage.native_output_tokens.source, 'unknown');
  assert.notEqual(row.usage.native_output_tokens.value, 0);
});

test('native helpers are counted once and parent usage must exclude them', () => {
  assert.throws(() => parseTrial(trial({
    trial_id: 'parent-plus-helper',
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
  })), (error) => error.code === 'identity_mismatch');

  const row = armRow([trial({
    trial_id: 'excluded-parent',
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
  })]);
  assert.equal(row.native_helper_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 15);
  assert.equal(row.usage.elapsed_ms.value, 800);
  assert.equal(row.usage.elapsed_ms.role, 'attempt_duration_sum');
  assert.equal(row.usage.wall_elapsed_ms.value, 800);
  assert.equal(row.usage.wall_elapsed_ms.role, 'trial_wall_elapsed');
});

test('elapsed_ms is attempt sum and wall_elapsed_ms is trial wall time', () => {
  const row = armRow([trial({
    trial_id: 'wall-vs-sum',
    wall_elapsed_ms: metric(4000),
    attempts: [
      {
        attempt_id: 'first',
        kind: 'initial',
        outcome: 'failed',
        usage: { elapsed_ms: metric(1000) },
      },
      {
        attempt_id: 'second',
        kind: 'correction',
        outcome: 'accepted',
        usage: { elapsed_ms: metric(2500) },
      },
    ],
  })]);
  assert.equal(row.usage.elapsed_ms.value, 3500);
  assert.equal(row.usage.elapsed_ms.role, 'attempt_duration_sum');
  assert.equal(row.usage.wall_elapsed_ms.value, 4000);
  assert.equal(row.usage.wall_elapsed_ms.role, 'trial_wall_elapsed');
  assert.notEqual(row.usage.wall_elapsed_ms.value, row.usage.elapsed_ms.value);
});

test('duplicate attempt IDs keep the latest compatible cumulative snapshot', () => {
  const ok = parseTrial(trial({
    trial_id: 'cumulative-ok',
    attempts: [
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
    ],
  }));
  assert.equal(ok.attempts.length, 1);
  assert.equal(ok.attempts[0].usage.native_input_tokens.value, 18);

  assert.throws(() => parseTrial(trial({
    trial_id: 'flip-terminal',
    attempts: [
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
    ],
  })), (error) => error.code === 'incompatible_snapshot' || error.code === 'duplicate_attempt_id');

  assert.throws(() => parseTrial(trial({
    trial_id: 'move-model',
    attempts: [
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
    ],
  })), (error) => error.code === 'incompatible_snapshot' || error.code === 'duplicate_attempt_id');
});

test('mixed providers keep groups and make aggregate tokens non-comparable', () => {
  const row = armRow([trial({
    trial_id: 'two-providers',
    attempts: [
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
    ],
  })]);
  const grouped = row.usage.provider_input_tokens;
  assert.equal(grouped.value, null);
  assert.equal(grouped.reason, 'mixed_providers_non_comparable');
  assert.equal(grouped.groups.length, 2);
});

test('an arm cannot mix coengineer_source identities', () => {
  assert.throws(() => compareTrials([frozenCase()], [
    trial({
      trial_id: 'build-a',
      coengineer_source: { kind: 'git_commit', value: CANDIDATE_COMMIT },
    }),
    trial({
      trial_id: 'build-b',
      coengineer_source: { kind: 'git_commit', value: OTHER_COMMIT },
    }),
  ]), (error) => error.code === 'mixed_candidate_identity');
});
