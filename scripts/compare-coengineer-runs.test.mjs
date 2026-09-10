import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compareTrials,
  computeInputDigest,
  loadCases,
  loadTrials,
  main,
  materializeCase,
  parseCase,
  parseTrial,
  parseUsageMetric,
} from './compare-coengineer-runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = path.join(ROOT, 'benchmarks/cases');
const FIXTURE = path.join(ROOT, 'benchmarks/fixtures/analysis-fixture.json');
const PROTOCOL = path.join(ROOT, 'benchmarks/protocol.json');

function settings() {
  return { reasoning: 'default', sandbox: 'workspace-write' };
}

function provider(implement = 'grok', review = null) {
  return { implement, review };
}

function metric(value, source = 'host_measured', trust = 'host_authoritative') {
  return { value, source, trust };
}

function caseById(cases, id) {
  return cases.find((entry) => entry.id === id);
}

function trial(caseRecord, overrides = {}) {
  const arm = overrides.arm ?? 'candidate-3.4.3';
  return {
    schema: 'codex-co-engineer.benchmark-trial.v1',
    trial_id: 'trial-one',
    case_id: caseRecord.id,
    arm,
    base_sha: caseRecord.base_sha,
    input_digest: caseRecord.input_digest,
    coengineer_source: arm === 'native-codex'
      ? { kind: 'native', value: 'native-codex' }
      : { kind: 'synthetic_label', value: `fixture:${arm}` },
    host_model: 'codex-default',
    host_settings: settings(),
    provider_configuration: arm === 'native-codex' ? { implement: 'native' } : provider(),
    accepted: false,
    wall_elapsed_ms: metric(1000),
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
    case_id: overrides.case_id ?? caseRecord.id,
    base_sha: overrides.base_sha ?? caseRecord.base_sha,
    input_digest: overrides.input_digest ?? caseRecord.input_digest,
  };
}

test('fixture cases and analysis records load as synthetic unverified', async () => {
  const cases = await loadCases(CASES_DIR);
  assert.equal(cases.length, 4);
  const ids = cases.map((entry) => entry.id);
  assert.equal(ids.includes('single-file-bugfix'), true);
  const loaded = await loadTrials(FIXTURE);
  const comparison = compareTrials(cases, loaded.trials, { provenance: loaded.provenance });
  assert.equal(comparison.provenance.class, 'synthetic_unverified');
  assert.equal(comparison.provenance.independently_verified, false);
  assert.equal(comparison.provenance.synthetic, true);
  assert.equal(Object.hasOwn(comparison, 'invented_results'), false);
  const bugfix = comparison.cases.find((row) => row.case_id === 'single-file-bugfix');
  assert.equal(bugfix.arms['candidate-3.4.3'].status, 'compared');
  assert.equal(bugfix.arms['direct-delegation'].status, 'optional_unrun');
  assert.equal(bugfix.arms['candidate-3.4.3'].failed_attempt_count, 1);
  assert.equal(bugfix.arms['candidate-3.4.3'].correction_count, 1);
  assert.equal(bugfix.arms['native-codex'].native_helper_count, 1);
  assert.equal(bugfix.arms['candidate-3.4.3'].usage.native_input_tokens.value, 40);
  assert.equal(bugfix.arms['native-codex'].usage.elapsed_ms.value, 4900);
  assert.equal(bugfix.arms['native-codex'].usage.elapsed_ms.role, 'attempt_duration_sum');
  assert.equal(bugfix.arms['native-codex'].usage.wall_elapsed_ms.value, 4000);
  assert.equal(bugfix.arms['native-codex'].usage.wall_elapsed_ms.role, 'trial_wall_elapsed');
});

test('materializeCase writes a reproducible git commit under TMPDIR', async () => {
  const cases = await loadCases(CASES_DIR);
  const bugfix = caseById(cases, 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-bench-'));
  try {
    const dest1 = path.join(root, 'a');
    const dest2 = path.join(root, 'b');
    await mkdir(dest1);
    await mkdir(dest2);
    const first = await materializeCase(bugfix, dest1);
    const second = await materializeCase(bugfix, dest2);
    assert.equal(first.base_sha, bugfix.base_sha);
    assert.equal(second.base_sha, bugfix.base_sha);
    assert.equal(first.input_digest, bugfix.input_digest);
    const written = await readFile(path.join(dest1, 'sum.mjs'), 'utf8');
    assert.equal(written, bugfix.inputs.files['sum.mjs']);
    await assert.rejects(() => materializeCase(bugfix, dest1), { code: 'destination_not_empty' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changed frozen acceptance checks are rejected', async () => {
  const cases = await loadCases(CASES_DIR);
  const bugfix = caseById(cases, 'single-file-bugfix');
  const mutated = structuredClone({
    schema: bugfix.schema,
    id: bugfix.id,
    title: bugfix.title,
    summary: bugfix.summary,
    input_digest: bugfix.input_digest,
    base_sha: bugfix.base_sha,
    comparable: bugfix.comparable,
    inputs: bugfix.inputs,
    acceptance: {
      ...bugfix.acceptance,
      checks: [{ id: 'unit', command: ['node', '--test', 'other.test.mjs'], expect_exit: 0 }],
    },
  });
  assert.throws(() => parseCase(mutated), { code: 'identity_mismatch' });
  const recomputed = computeInputDigest(bugfix.inputs.files, mutated.acceptance);
  assert.notEqual(recomputed, bugfix.input_digest);
});

test('unsafe case paths and duplicate case ids are rejected', () => {
  const raw = {
    schema: 'codex-co-engineer.benchmark-case.v1',
    id: 'single-file-bugfix',
    title: 'x',
    summary: 'y',
    comparable: {
      host_model: 'codex-default',
      host_settings: settings(),
      provider_configuration: provider(),
    },
    inputs: { files: { '../escape.mjs': 'no\n' } },
    acceptance: { checks: [{ id: 'unit', command: ['node', '--test', 'sum.test.mjs'], expect_exit: 0 }] },
  };
  assert.throws(() => parseCase(raw), { code: 'invalid_format' });
  const cases = [
    {
      schema: 'codex-co-engineer.benchmark-case.v1',
      id: 'single-file-bugfix',
      title: 'a',
      summary: 'a',
      comparable: raw.comparable,
      inputs: { files: { 'sum.mjs': 'export {}\n' } },
      acceptance: raw.acceptance,
    },
    {
      schema: 'codex-co-engineer.benchmark-case.v1',
      id: 'single-file-bugfix',
      title: 'b',
      summary: 'b',
      comparable: raw.comparable,
      inputs: { files: { 'sum.mjs': 'export {}\n' } },
      acceptance: raw.acceptance,
    },
  ];
  assert.throws(() => compareTrials(cases, []), { code: 'duplicate_id' });
});

test('parseUsageMetric rejects mismatched source/trust pairs', () => {
  assert.throws(() => parseUsageMetric({
    value: 3,
    source: 'provider_report',
    trust: 'host_authoritative',
  }, 'usage.provider_input_tokens', 'provider_input_tokens'), { code: 'identity_mismatch' });
  const ok = parseUsageMetric({
    value: 3,
    source: 'provider_report',
    trust: 'provider_untrusted',
  }, 'usage.provider_input_tokens', 'provider_input_tokens');
  assert.equal(ok.value, 3);
});

test('failed attempts remain in usage-per-accepted denominators', async () => {
  const cases = await loadCases(CASES_DIR);
  const failing = caseById(cases, 'failing-check-then-fix');
  const comparison = compareTrials(cases, [
    trial(failing, {
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
    }),
  ]);
  const row = comparison.cases.find((entry) => entry.case_id === 'failing-check-then-fix')
    .arms['candidate-3.4.3'];
  assert.equal(row.accepted_count, 1);
  assert.equal(row.failed_attempt_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 25);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.value, 25);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.reason, 'includes_failed_attempts_and_corrections');
  assert.equal(row.usage_per_accepted_result.native_input_tokens.numerator, 25);
});

test('mixed known and unknown acceptance leaves usage-per-accepted unknown', async () => {
  const cases = await loadCases(CASES_DIR);
  const failing = caseById(cases, 'failing-check-then-fix');
  const comparison = compareTrials(cases, [
    trial(failing, {
      trial_id: 'known-accept',
      accepted: true,
      attempts: [{
        attempt_id: 'ok',
        kind: 'initial',
        outcome: 'accepted',
        usage: { native_input_tokens: metric(10) },
      }],
    }),
    (() => {
      const missing = trial(failing, {
        trial_id: 'missing-accept',
        attempts: [{
          attempt_id: 'maybe',
          kind: 'initial',
          outcome: 'uncertain',
          usage: { native_input_tokens: metric(7) },
        }],
      });
      delete missing.accepted;
      return missing;
    })(),
  ]);
  const row = comparison.cases.find((entry) => entry.case_id === 'failing-check-then-fix')
    .arms['candidate-3.4.3'];
  assert.equal(row.accepted_count, 1);
  assert.equal(row.accepted_known_count, 1);
  assert.equal(row.usage.native_input_tokens.value, 17);
  const per = row.usage_per_accepted_result.native_input_tokens;
  assert.equal(per.value, null);
  assert.equal(per.reason, 'incomplete_acceptance_coverage');
  assert.equal(per.numerator, 17);
  assert.equal(per.known_accepted_count, 1);
  assert.equal(per.coverage.trial_count, 2);
  assert.equal(row.acceptance_rate.value, null);
});

test('native helpers and missing values stay labeled', async () => {
  const cases = await loadCases(CASES_DIR);
  const review = caseById(cases, 'independent-review');
  const comparison = compareTrials(cases, [
    trial(review, {
      trial_id: 'native-review',
      arm: 'native-codex',
      accepted: true,
      provider_configuration: { implement: 'native' },
      coengineer_source: { kind: 'native', value: 'native-codex' },
      wall_elapsed_ms: metric(800),
      attempts: [
        {
          attempt_id: 'helper',
          kind: 'native_helper',
          outcome: 'accepted',
          usage: {
            native_helper_calls: metric(2),
            native_input_tokens: { value: null, source: 'unknown', trust: 'unknown' },
            model_facing_bytes: metric(64),
            elapsed_ms: metric(200),
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
  assert.equal(row.usage.elapsed_ms.value, 200);
  assert.equal(row.usage.wall_elapsed_ms.value, 800);
  assert.equal(row.usage_per_accepted_result.native_input_tokens.reason, 'unknown_metric');
});

test('native parent usage must exclude separately recorded helpers', async () => {
  const cases = await loadCases(CASES_DIR);
  const review = caseById(cases, 'independent-review');
  assert.throws(() => parseTrial(trial(review, {
    arm: 'native-codex',
    provider_configuration: { implement: 'native' },
    coengineer_source: { kind: 'native', value: 'native-codex' },
    attempts: [
      {
        attempt_id: 'parent',
        kind: 'initial',
        outcome: 'failed',
        usage: { native_input_tokens: metric(11) },
      },
      {
        attempt_id: 'helper',
        kind: 'native_helper',
        outcome: 'accepted',
        usage: { native_helper_calls: metric(1) },
      },
    ],
  })), { code: 'identity_mismatch' });
});

test('duplicate attempt IDs keep the latest compatible cumulative snapshot', async () => {
  const cases = await loadCases(CASES_DIR);
  const failing = caseById(cases, 'failing-check-then-fix');
  const parsed = parseTrial(trial(failing, {
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
  assert.equal(parsed.attempts.length, 1);
  assert.equal(parsed.attempts[0].usage.native_input_tokens.value, 18);
  assert.deepEqual(parsed.cumulative_replaced, ['same']);
  assert.throws(() => parseTrial(trial(failing, {
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
        kind: 'correction',
        outcome: 'failed',
        sequence: 2,
        usage: { native_input_tokens: metric(18) },
      },
    ],
  })), { code: 'incompatible_snapshot' });
  assert.throws(() => parseTrial(trial(failing, {
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
  })), { code: 'incompatible_snapshot' });
});

test('zero acceptance is not zero cost and mismatched settings are unmatched', async () => {
  const cases = await loadCases(CASES_DIR);
  const failing = caseById(cases, 'failing-check-then-fix');
  const correction = caseById(cases, 'review-driven-correction');
  const comparison = compareTrials(cases, [
    trial(failing, {
      trial_id: 'zero-accept',
      accepted: false,
      attempts: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'failed',
        provider: 'grok',
        model: 'grok-4',
        usage: {
          native_input_tokens: metric(9),
          provider_cost_millicents: metric(0, 'provider_report', 'provider_untrusted'),
        },
      }],
    }),
    trial(correction, {
      trial_id: 'mismatch',
      accepted: true,
      host_model: 'other-host',
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

test('mixed providers keep groups and make aggregate tokens non-comparable', async () => {
  const cases = await loadCases(CASES_DIR);
  const failing = caseById(cases, 'failing-check-then-fix');
  const comparison = compareTrials(cases, [
    trial(failing, {
      trial_id: 'two-providers',
      accepted: true,
      attempts: [
        {
          attempt_id: 'grok-arm',
          kind: 'initial',
          outcome: 'completed_unaccepted',
          provider: 'grok',
          model: 'grok-4',
          usage: {
            provider_input_tokens: metric(40, 'provider_report', 'provider_untrusted'),
            provider_cost_millicents: metric(12, 'provider_report', 'provider_untrusted'),
          },
        },
        {
          attempt_id: 'cursor-arm',
          kind: 'correction',
          outcome: 'accepted',
          provider: 'cursor-local',
          model: 'composer',
          usage: {
            provider_input_tokens: metric(15, 'provider_report', 'provider_untrusted'),
            provider_cost_millicents: metric(4, 'provider_report', 'provider_untrusted'),
          },
        },
      ],
    }),
  ]);
  const row = comparison.cases.find((entry) => entry.case_id === 'failing-check-then-fix')
    .arms['candidate-3.4.3'];
  const tokens = row.usage.provider_input_tokens;
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
  assert.equal(row.usage.provider_cost_millicents.groups.length, 2);
});

test('arm labels cannot mix coengineer source identities', async () => {
  const cases = await loadCases(CASES_DIR);
  const failing = caseById(cases, 'failing-check-then-fix');
  assert.throws(() => compareTrials(cases, [
    trial(failing, {
      trial_id: 'build-a',
      accepted: true,
      coengineer_source: { kind: 'synthetic_label', value: 'fixture:candidate-3.4.3' },
    }),
    trial(failing, {
      trial_id: 'build-b',
      accepted: true,
      coengineer_source: { kind: 'synthetic_label', value: 'fixture:candidate-other' },
    }),
  ]), { code: 'mixed_candidate_identity' });
});

test('CLI validates DIR, analyzes fixtures, and rejects unknown flags', async () => {
  const chunks = [];
  const errors = [];
  const io = {
    stdout: { write(text) { chunks.push(text); return true; } },
    stderr: { write(text) { errors.push(text); return true; } },
  };
  const validated = await main(['--validate-cases', CASES_DIR], io);
  assert.equal(validated, 0);
  assert.equal(chunks.join('').includes('single-file-bugfix'), true);
  const validatedAlias = await main(['--validate-cases', '--cases', CASES_DIR], io);
  assert.equal(validatedAlias, 0);
  const analyzed = await main([
    '--cases', CASES_DIR,
    '--trials', FIXTURE,
    '--protocol', PROTOCOL,
  ], io);
  assert.equal(analyzed, 0);
  assert.equal(chunks.join('').includes('synthetic_unverified'), true);
  const live = await main(['--live'], io);
  assert.equal(live, 2);
  assert.equal(errors.join('').includes('Live provider jobs are not implemented'), true);
  const paid = await main(['--live', '--paid-budget', '1'], io);
  assert.equal(paid, 2);
  const unknown = await main(['--cases', CASES_DIR, '--bogus'], io);
  assert.equal(unknown, 2);
  assert.equal(errors.join('').includes('Unknown flag --bogus'), true);
  const missing = await main(['--trials', FIXTURE], io);
  assert.equal(missing, 2);

  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-cli-'));
  try {
    const dest = path.join(root, 'case');
    const materialized = await main([
      '--materialize-case', path.join(CASES_DIR, 'single-file-bugfix.json'),
      '--destination', dest,
    ], io);
    assert.equal(materialized, 0);
    assert.equal(chunks.join('').includes('df49c63059159a79646258358850bef0590ca583'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI bounds reject oversized trial files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-bound-'));
  const errors = [];
  const io = {
    stdout: { write() { return true; } },
    stderr: { write(text) { errors.push(text); return true; } },
  };
  try {
    const huge = path.join(root, 'huge.json');
    await writeFile(huge, `${'a'.repeat(1_048_577)}`);
    await assert.rejects(
      () => main(['--cases', CASES_DIR, '--trials', huge], io),
      { code: 'bounds_exceeded' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
