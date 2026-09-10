import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareTrials,
  loadCases,
  loadTrials,
  main,
  parseTrial,
} from './compare-coengineer-runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = path.join(ROOT, 'benchmarks/cases');
const FIXTURE = path.join(ROOT, 'benchmarks/fixtures/analysis-fixture.json');

const BASE = {
  'single-file-bugfix': 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
  'independent-review': 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  'review-driven-correction': 'b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3',
  'failing-check-then-fix': 'b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4',
};

function settings() {
  return { reasoning: 'default', sandbox: 'workspace-write' };
}

function provider(implement = 'grok', review = null) {
  return { implement, review };
}

function metric(value, source = 'host_measured', trust = 'host_authoritative') {
  return { value, source, trust };
}

function trial(overrides = {}) {
  return {
    schema: 'codex-co-engineer.benchmark-trial.v1',
    trial_id: 'trial-one',
    case_id: 'failing-check-then-fix',
    arm: 'candidate-3.4.3',
    base_sha: BASE['failing-check-then-fix'],
    host_model: 'codex-default',
    host_settings: settings(),
    provider_configuration: provider(),
    accepted: false,
    attempts: [{
      attempt_id: 'attempt-one',
      kind: 'initial',
      outcome: 'failed',
      usage: {
        native_input_tokens: metric(10),
        elapsed_ms: metric(1000),
      },
    }],
    ...overrides,
  };
}

test('fixture cases and analysis records load', async () => {
  const cases = await loadCases(CASES_DIR);
  assert.equal(cases.length, 4);
  const ids = cases.map((entry) => entry.id);
  assert.equal(ids.includes('single-file-bugfix'), true);
  const trials = await loadTrials(FIXTURE);
  const comparison = compareTrials(cases, trials);
  assert.equal(comparison.invented_results, false);
  const bugfix = comparison.cases.find((row) => row.case_id === 'single-file-bugfix');
  assert.equal(bugfix.arms['candidate-3.4.3'].status, 'compared');
  assert.equal(bugfix.arms['direct-delegation'].status, 'optional_unrun');
  assert.equal(bugfix.arms['candidate-3.4.3'].failed_attempt_count, 1);
  assert.equal(bugfix.arms['candidate-3.4.3'].correction_count, 1);
  assert.equal(bugfix.arms['native-codex'].native_helper_count, 1);
  assert.equal(bugfix.arms['candidate-3.4.3'].usage.native_input_tokens.value, 40);
});

test('failed attempts remain in usage-per-accepted denominators', async () => {
  const cases = await loadCases(CASES_DIR);
  const comparison = compareTrials(cases, [
    trial({
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
    }),
  ]);
  const row = comparison.cases.find((entry) => entry.case_id === 'failing-check-then-fix')
    .arms['candidate-3.4.3'];
  assert.equal(row.accepted_count, 1);
  assert.equal(row.failed_attempt_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 25);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.value, 25);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.reason, 'includes_failed_attempts');
});

test('native helpers and missing values stay labeled', async () => {
  const cases = await loadCases(CASES_DIR);
  const comparison = compareTrials(cases, [
    trial({
      trial_id: 'native-review',
      case_id: 'independent-review',
      arm: 'native-codex',
      base_sha: BASE['independent-review'],
      accepted: true,
      provider_configuration: { implement: 'native' },
      attempts: [
        {
          attempt_id: 'helper',
          kind: 'native_helper',
          outcome: 'accepted',
          usage: {
            native_helper_calls: metric(2),
            native_input_tokens: { value: null, source: 'unknown', trust: 'unknown' },
            model_facing_bytes: metric(64),
          },
        },
      ],
    }),
  ]);
  const row = comparison.cases.find((entry) => entry.case_id === 'independent-review')
    .arms['native-codex'];
  assert.equal(row.native_helper_count, 1);
  assert.equal(row.usage.native_input_tokens.value, null);
  assert.equal(row.usage.native_input_tokens.source, 'unknown');
  assert.equal(row.usage.model_facing_bytes.value, 64);
  assert.equal(row.usage.model_facing_bytes.unit, 'bytes');
  assert.equal(row.usage.provider_input_tokens.source, 'unknown');
  assert.equal(row.usage_per_accepted_result.native_input_tokens.reason, 'unknown_metric');
});

test('duplicate attempt IDs keep the latest cumulative snapshot', () => {
  const parsed = parseTrial(trial({
    attempts: [
      {
        attempt_id: 'same',
        kind: 'initial',
        outcome: 'failed',
        usage: { native_input_tokens: metric(10) },
      },
      {
        attempt_id: 'same',
        kind: 'initial',
        outcome: 'failed',
        usage: { native_input_tokens: metric(18) },
      },
    ],
  }));
  assert.equal(parsed.attempts.length, 1);
  assert.equal(parsed.attempts[0].usage.native_input_tokens.value, 18);
  assert.deepEqual(parsed.cumulative_replaced, ['same']);
  assert.throws(() => parseTrial(trial({
    attempts: [
      {
        attempt_id: 'same',
        kind: 'initial',
        outcome: 'failed',
        usage: { native_input_tokens: metric(10) },
      },
      {
        attempt_id: 'same',
        kind: 'correction',
        outcome: 'failed',
        usage: { native_input_tokens: metric(18) },
      },
    ],
  })), { code: 'duplicate_attempt_id' });
});

test('zero acceptance is not zero cost and mismatched settings are unmatched', async () => {
  const cases = await loadCases(CASES_DIR);
  const comparison = compareTrials(cases, [
    trial({
      trial_id: 'zero-accept',
      accepted: false,
      attempts: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'failed',
        usage: {
          native_input_tokens: metric(9),
          provider_cost_millicents: metric(0, 'provider_report', 'provider_untrusted'),
        },
      }],
    }),
    trial({
      trial_id: 'mismatch',
      case_id: 'review-driven-correction',
      base_sha: BASE['review-driven-correction'],
      host_model: 'other-host',
      accepted: true,
    }),
  ]);
  const failed = comparison.cases.find((entry) => entry.case_id === 'failing-check-then-fix')
    .arms['candidate-3.4.3'];
  assert.equal(failed.accepted_count, 0);
  assert.equal(failed.usage.native_input_tokens.value, 9);
  assert.equal(failed.usage_per_accepted_result.native_input_tokens.value, null);
  assert.equal(failed.usage_per_accepted_result.native_input_tokens.reason, 'zero_accepted_not_zero_cost');
  assert.equal(failed.usage.provider_cost_millicents.value, 0);
  assert.notEqual(failed.usage_per_accepted_result.native_input_tokens.reason, 'measured_zero');
  const mismatched = comparison.cases.find((entry) => entry.case_id === 'review-driven-correction')
    .arms['candidate-3.4.3'];
  assert.equal(mismatched.status, 'unmatched');
  assert.equal(mismatched.unmatched[0].reason, 'host_model_mismatch');
  assert.equal(mismatched.trial_count, 0);
});

test('CLI analyzes fixtures and refuses live jobs', async () => {
  const chunks = [];
  const errors = [];
  const io = {
    stdout: { write(text) { chunks.push(text); return true; } },
    stderr: { write(text) { errors.push(text); return true; } },
  };
  const validated = await main(['--validate-cases', '--cases', CASES_DIR], io);
  assert.equal(validated, 0);
  const analyzed = await main([
    '--cases', CASES_DIR,
    '--trials', FIXTURE,
  ], io);
  assert.equal(analyzed, 0);
  const live = await main(['--live'], io);
  assert.equal(live, 2);
  assert.equal(errors.join('').includes('Live provider jobs are not implemented'), true);
  const paid = await main(['--live', '--paid-budget', '1'], io);
  assert.equal(paid, 2);
});
