import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadCases,
  parseTrial,
} from './compare-coengineer-runs.mjs';
import {
  ASTRA_MODEL,
  ASTRA_PROVIDER,
  CASE_IDS,
  DEADLINE_SOURCE_SHA,
  EVIDENCE_DIGEST_DOMAIN,
  FIVE_TOOLS,
  HOST_USAGE_REPORT_SCHEMA_ID,
  ORDERING_SEED,
  OVERHEAD_REDUCTION,
  PAID_CEILING_USD,
  PLACEHOLDER_HOST_MODEL,
  PUBLISHED_342_SHA,
  QUALIFICATION_ARMS,
  QUALIFICATION_CASE_SCHEMA_ID,
  RESULT_SOURCE_SHA,
  TURNAROUND_REDUCTION,
  checkKnownBad,
  evaluateQualificationCohort,
  extractSource,
  generateSchedule,
  hostUsageTrialDigest,
  loadQualificationCases,
  main,
  materializeQualificationCase,
  packCase,
  parseExecutionManifest,
  parseHostUsageReport,
  parseQualificationTrial,
  protocolRecord,
  scanOverlayLeakage,
} from './prepare-coengineer-qualification.mjs';
import { PUBLIC_MCP_TOOLS } from '../plugins/codex-co-engineer/mcp/v3/response.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXISTING_CASES = path.join(ROOT, 'benchmarks/cases');
const QUAL_CASES = path.join(ROOT, 'benchmarks/qualification/cases');
const QUAL_PROTOCOL = path.join(ROOT, 'benchmarks/qualification/protocol.json');
const QUAL_MANIFEST = path.join(ROOT, 'benchmarks/qualification/operator-manifest.json');
const CANDIDATE_FIXTURE_SHA = 'c0ffeeabc0ffeeabc0ffeeabc0ffeeabc0ffeeab';
const PUBLISHED_FIXTURE_TREE = 'd0ffeeabc0ffeeabc0ffeeabc0ffeeabc0ffeeab';
const HOST_MODEL = ASTRA_MODEL;
const QUAL_FIXTURES = path.join(ROOT, 'benchmarks/qualification/fixtures');

function io() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: { write(text) { stdout.push(text); return true; }, text: () => stdout.join('') },
    stderr: { write(text) { stderr.push(text); return true; }, text: () => stderr.join('') },
    chunks: stdout,
    errors: stderr,
  };
}

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

function caseRoutes() {
  return {
    'acp-deadline-concurrent-cancel': {
      implement: { provider: 'cursor-local', model: 'composer-1' },
      review: { provider: 'grok', model: 'grok-4' },
    },
    'run-result-outcome-acceptance': {
      implement: { provider: 'grok', model: 'grok-4' },
      review: { provider: 'cursor-local', model: 'composer-1' },
    },
    'comparison-failed-helper-cumulative': {
      implement: { provider: 'grok', model: 'grok-4' },
      review: { provider: 'cursor-local', model: 'composer-1' },
    },
  };
}

function recordedManifest(cases) {
  return {
    schema: 'codex-co-engineer.qualification-execution-manifest.v1',
    version: 1,
    status: 'recorded',
    candidate: { sha: CANDIDATE_FIXTURE_SHA, tree: PUBLISHED_FIXTURE_TREE },
    published_3_4_2: { sha: PUBLISHED_342_SHA },
    host: {
      host_model: HOST_MODEL,
      host_settings: settings(),
    },
    astra: { provider: ASTRA_PROVIDER, model: ASTRA_MODEL },
    provider_configuration: caseRoutes(),
    approaches: {
      'native-codex': { external_jobs: false },
      'published-3.4.2': { external_jobs: true },
      'candidate-3.4.3': { external_jobs: true },
      'direct-delegation': { external_jobs: true },
    },
    input_digests: Object.fromEntries(cases.map((entry) => [entry.id, entry.input_digest])),
    check_digests: Object.fromEntries(cases.map((entry) => [entry.id, entry.check_digest])),
  };
}

function makeTrial(plan, caseRecord, manifest, {
  accepted = true,
  nativeOutput = 40,
  wall = 1000,
  failedThenCorrect = false,
  helper = false,
  hostModel = manifest.host.host_model,
  inputDigest = caseRecord.input_digest,
  source = null,
  providerConfiguration = null,
} = {}) {
  const attempts = [];
  if (failedThenCorrect) {
    attempts.push({
      attempt_id: 'initial',
      kind: 'initial',
      outcome: 'failed',
      sequence: 1,
      usage: {
        native_input_tokens: metric(0),
        native_output_tokens: metric(10),
        native_helper_calls: metric(0),
        correction_rounds: metric(0),
        elapsed_ms: metric(400),
      },
    });
    attempts.push({
      attempt_id: 'correction',
      kind: 'correction',
      outcome: accepted ? 'accepted' : 'failed',
      sequence: 2,
      usage: {
        native_input_tokens: metric(0),
        native_output_tokens: metric(Math.max(0, nativeOutput - 10)),
        native_helper_calls: metric(0),
        correction_rounds: metric(1),
        elapsed_ms: metric(800),
      },
    });
  } else {
    attempts.push({
      attempt_id: 'initial',
      kind: 'initial',
      outcome: accepted ? 'accepted' : 'failed',
      sequence: 1,
      usage: {
        native_input_tokens: metric(0),
        native_output_tokens: metric(helper ? Math.max(0, nativeOutput - 8) : nativeOutput),
        native_helper_calls: metric(0),
        correction_rounds: metric(0),
        elapsed_ms: metric(1000),
      },
    });
  }
  if (helper) {
    attempts.push({
      attempt_id: 'helper',
      kind: 'native_helper',
      outcome: 'accepted',
      sequence: attempts.length + 1,
      usage: {
        native_input_tokens: metric(0),
        native_helper_calls: metric(1),
        native_output_tokens: metric(8),
        correction_rounds: metric(0),
        elapsed_ms: metric(200),
      },
    });
  }
  const armSource = source ?? (plan.arm === 'native-codex'
    ? { kind: 'native', value: 'native-codex' }
    : {
      kind: 'git_commit',
      value: plan.arm === 'published-3.4.2' ? manifest.published_3_4_2.sha : manifest.candidate.sha,
    });
  const route = providerConfiguration ?? (plan.arm === 'native-codex'
    ? { implement: 'native' }
    : manifest.provider_configuration[plan.case_id]);
  return {
    schema: 'codex-co-engineer.benchmark-trial.v1',
    trial_id: plan.trial_id,
    case_id: plan.case_id,
    arm: plan.arm,
    base_sha: caseRecord.base_sha,
    input_digest: inputDigest,
    coengineer_source: armSource,
    host_model: hostModel,
    host_settings: manifest.host.host_settings,
    provider_configuration: route,
    accepted,
    wall_elapsed_ms: metric(wall),
    attempts,
    ...(helper ? { native_parent_excludes_helpers: true } : {}),
  };
}

function modelRow(model, inputTokens, outputTokens) {
  return {
    model,
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: inputTokens + outputTokens,
  };
}

function makeUsageReport(trial, {
  status = 'complete',
  astraOutput = null,
  helperModel = 'helper-model-x',
} = {}) {
  const attempts = trial.attempts.map((attempt) => {
    const nativeOut = attempt.usage.native_output_tokens?.value ?? 0;
    const nativeIn = attempt.usage.native_input_tokens?.value ?? 0;
    const isHelper = attempt.kind === 'native_helper';
    const byModel = [];
    if (isHelper) {
      byModel.push(modelRow(helperModel, nativeIn, nativeOut));
    } else {
      const astraOut = astraOutput == null ? nativeOut : Math.min(astraOutput, nativeOut);
      byModel.push(modelRow(ASTRA_MODEL, nativeIn, astraOut));
      if (astraOut !== nativeOut) {
        byModel.push(modelRow(helperModel, 0, nativeOut - astraOut));
      }
    }
    return {
      attempt_id: attempt.attempt_id,
      session_id: isHelper ? 'helper-session' : 'parent-session',
      input_tokens: nativeIn,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: nativeOut,
      reasoning_output_tokens: 0,
      compaction_events: 0,
      by_model: byModel,
    };
  });
  const clonedTrial = structuredClone(trial);
  return {
    schema: HOST_USAGE_REPORT_SCHEMA_ID,
    status,
    trial: clonedTrial,
    breakdown: {
      attempts,
      totals: {
        input_tokens: attempts.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: attempts.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
        reasoning_output_tokens: 0,
        compaction_events: 0,
      },
      accounting: {
        response_id_deduped: true,
        response_identity: 'session_and_response',
        phase_endpoints: 'start_inclusive_end_exclusive_unless_terminal',
        compaction_counted_once: true,
        reasoning_included_in_output: true,
        cache_counters_separate: true,
        secondary_token_count: 'non_authoritative',
        native_parent_excludes_helpers: trial.native_parent_excludes_helpers === true,
        walked_sessions: [...new Set(attempts.map((row) => row.session_id))],
        acceptance_unknown: !Object.hasOwn(trial, 'accepted'),
        measurement_incomplete: status !== 'complete',
      },
    },
    evidence: {
      digests: {
        manifest: 'ab'.repeat(32),
        sessions: Object.fromEntries(attempts.map((row) => [row.session_id, '11'.repeat(32)])),
        links: [],
        trial: hostUsageTrialDigest(clonedTrial),
      },
      notes: status === 'inconclusive' ? ['absent_session:helper-session'] : [],
      incomplete_primary_evidence: status !== 'complete',
    },
  };
}

function cohortReports(trials, customize = {}) {
  return trials.map((trial) => {
    const key = `${trial.case_id}:${trial.arm}:r${trial.trial_id.slice(-1)}`;
    const override = customize[key] ?? customize[trial.trial_id] ?? customize[trial.arm] ?? {};
    return makeUsageReport(trial, override);
  });
}

function nullHostCounters(row) {
  row.input_tokens = null;
  row.cached_input_tokens = null;
  row.cache_write_input_tokens = null;
  row.output_tokens = null;
  row.reasoning_output_tokens = null;
  row.compaction_events = null;
}

function importerShapedIncompleteAstra40(trial) {
  const cloned = structuredClone(trial);
  for (const attempt of cloned.attempts) {
    attempt.usage.native_input_tokens = unknownMetric();
    attempt.usage.native_output_tokens = unknownMetric();
  }
  const report = makeUsageReport(cloned, { status: 'inconclusive' });
  report.trial = cloned;
  report.breakdown.accounting.measurement_incomplete = true;
  report.breakdown.totals = {
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    compaction_events: null,
  };
  const parent = report.breakdown.attempts[0];
  nullHostCounters(parent);
  parent.by_model = [modelRow(ASTRA_MODEL, 80, 40)];
  const helper = report.breakdown.attempts.find((row) => row.attempt_id === 'helper');
  if (helper) {
    nullHostCounters(helper);
    helper.by_model = [];
    helper.session_id = 'helper-session';
  }
  report.evidence.notes = ['absent_session:helper-session'];
  report.evidence.incomplete_primary_evidence = true;
  report.evidence.digests.trial = hostUsageTrialDigest(cloned);
  return { trial: cloned, report };
}

function evaluateCohort(packed, manifest, trials, extra = {}) {
  const { reportCustomize, usageReports, ...rest } = extra;
  return evaluateQualificationCohort({
    protocol: protocolRecord(),
    cases: packed.raw,
    trials,
    executionManifest: manifest,
    usageReports: usageReports ?? cohortReports(trials, reportCustomize),
    ...rest,
  });
}

function cohortTrials(cases, manifest, customize = {}) {
  const schedule = generateSchedule();
  const caseById = new Map(cases.map((entry) => [entry.id, entry]));
  return schedule.canonical.map((plan) => {
    const key = `${plan.case_id}:${plan.arm}:r${plan.rep}`;
    const override = customize[key] ?? customize[plan.case_id] ?? customize[plan.arm] ?? {};
    const defaults = {
      accepted: true,
      nativeOutput: plan.arm === 'native-codex' ? 100 : plan.arm === 'published-3.4.2' ? 80 : 40,
      wall: plan.arm === 'candidate-3.4.3' ? 1500 : plan.arm === 'native-codex' ? 1000 : 900,
      failedThenCorrect: plan.arm === 'candidate-3.4.3' && plan.rep === 1,
      helper: plan.arm === 'native-codex' && plan.rep === 1,
    };
    return makeTrial(plan, caseById.get(plan.case_id), manifest, { ...defaults, ...override });
  });
}

test('existing four comparator fixtures still load unchanged', async () => {
  const cases = await loadCases(EXISTING_CASES);
  assert.equal(cases.length, 4);
  assert.deepEqual(cases.map((entry) => entry.id).sort(), [
    'failing-check-then-fix',
    'independent-review',
    'review-driven-correction',
    'single-file-bugfix',
  ]);
  assert.deepEqual([...PUBLIC_MCP_TOOLS], [...FIVE_TOOLS]);
});

test('packed qualification cases bind real source SHAs without future candidate identity', async () => {
  const packed = await loadQualificationCases();
  assert.equal(packed.raw.length, 3);
  assert.deepEqual(packed.raw.map((entry) => entry.id), [...CASE_IDS]);
  assert.equal(packed.raw[0].source_sha, DEADLINE_SOURCE_SHA);
  assert.equal(packed.raw[0].source_sha, PUBLISHED_342_SHA);
  assert.equal(packed.raw[1].source_sha, RESULT_SOURCE_SHA);
  assert.equal(packed.raw[2].source_sha, RESULT_SOURCE_SHA);
  for (const record of packed.raw) {
    assert.equal(record.schema, QUALIFICATION_CASE_SCHEMA_ID);
    assert.equal(record.status, 'unrun');
    assert.equal(record.retrospective, true);
    assert.equal(Object.hasOwn(record, 'candidate_sha'), false);
    assert.equal(record.comparable == null, true);
    assert.match(record.base_sha, /^[0-9a-f]{40}$/u);
    assert.match(record.input_digest, /^[0-9a-f]{64}$/u);
    assert.match(record.check_digest, /^[0-9a-f]{64}$/u);
    assert.equal(Object.hasOwn(record.overlay.files, 'TASK.md'), true);
    assert.equal(Object.hasOwn(record.overlay.files, record.acceptance.checks[0].command[2]), true);
    assert.equal(Object.hasOwn(record.overlay.files, 'turn-runner.mjs'), false);
    assert.equal(Object.hasOwn(record.overlay.files, 'project-result.mjs'), false);
    assert.equal(Object.hasOwn(record.overlay.files, 'account-trials.mjs'), false);
    scanOverlayLeakage(record.overlay.files);
  }
});

test('materializeQualificationCase is reproducible and rejects a second write', async () => {
  const packed = await loadQualificationCases();
  const record = packed.raw.find((entry) => entry.id === 'run-result-outcome-acceptance');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-qual-mat-'));
  try {
    const dest1 = path.join(root, 'a');
    const dest2 = path.join(root, 'b');
    await mkdir(dest1);
    await mkdir(dest2);
    const first = await materializeQualificationCase(record, dest1);
    const second = await materializeQualificationCase(record, dest2);
    assert.equal(first.base_sha, record.base_sha);
    assert.equal(second.base_sha, record.base_sha);
    assert.equal(first.input_digest, record.input_digest);
    const evidence = await readFile(
      path.join(dest1, 'plugins/codex-co-engineer/mcp/v3/run-result-evidence.mjs'),
      'utf8',
    );
    assert.equal(evidence.includes('projectRunResultEvidenceV1'), true);
    await assert.rejects(() => materializeQualificationCase(record, dest1), { code: 'destination_not_empty' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale source, digest, placeholder, and candidate identities are rejected', async () => {
  const packed = await loadQualificationCases();
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-qual-stale-'));
  try {
    const candidateAsSource = structuredClone(packed.raw[0]);
    candidateAsSource.source_sha = CANDIDATE_FIXTURE_SHA;
    await mkdir(path.join(root, 'candidate'));
    await assert.rejects(
      () => materializeQualificationCase(candidateAsSource, path.join(root, 'candidate')),
      { code: 'stale_identity' },
    );

    const digestTamper = structuredClone(packed.raw[0]);
    digestTamper.input_digest = 'ab'.repeat(32);
    await mkdir(path.join(root, 'digest'));
    await assert.rejects(
      () => materializeQualificationCase(digestTamper, path.join(root, 'digest')),
      { code: 'stale_identity' },
    );

    const shaTamper = structuredClone(packed.raw[1]);
    shaTamper.source_sha = PUBLISHED_342_SHA;
    await mkdir(path.join(root, 'source'));
    await assert.rejects(
      () => materializeQualificationCase(shaTamper, path.join(root, 'source')),
      { code: 'stale_identity' },
    );

    const boundCandidate = structuredClone(packed.raw[0]);
    boundCandidate.candidate_sha = CANDIDATE_FIXTURE_SHA;
    await mkdir(path.join(root, 'future'));
    await assert.rejects(
      () => materializeQualificationCase(boundCandidate, path.join(root, 'future')),
      { code: 'stale_identity' },
    );

    const placeholder = structuredClone(packed.raw[0]);
    placeholder.comparable = { host_model: PLACEHOLDER_HOST_MODEL, host_settings: settings() };
    await mkdir(path.join(root, 'placeholder'));
    await assert.rejects(
      () => materializeQualificationCase(placeholder, path.join(root, 'placeholder')),
      { code: 'identity_mismatch' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance fails on the known-bad source for every retrospective case', { timeout: 180_000 }, async () => {
  const packed = await loadQualificationCases();
  for (const record of packed.raw) {
    const result = await checkKnownBad(record);
    assert.equal(result.failed, true);
    assert.notEqual(result.exit, 0);
  }
});

test('worker overlay does not leak solutions or extra paths', async () => {
  const packed = await loadQualificationCases();
  for (const record of packed.raw) {
    scanOverlayLeakage(record.overlay.files);
    assert.equal(Object.hasOwn(record.overlay.files, 'solution.mjs'), false);
    for (const text of Object.values(record.overlay.files)) {
      assert.equal(text.includes(CANDIDATE_FIXTURE_SHA), false);
      assert.equal(text.includes('AsyncLocalStorage'), false);
      assert.equal(text.includes('timeoutMs: 0'), false);
    }
  }
  const leaked = structuredClone(packed.raw[0].overlay.files);
  leaked['TASK.md'] += '\nSee AsyncLocalStorage in the later fix.\n';
  assert.throws(() => scanOverlayLeakage(leaked), { code: 'solution_leakage' });
});

test('extract-source copies only the immutable allowlist from the pre-fix SHA', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-qual-ex-'));
  try {
    const dest = path.join(root, 'src');
    const extracted = await extractSource({
      caseId: 'comparison-failed-helper-cumulative',
      destination: dest,
    });
    assert.equal(extracted.source_sha, RESULT_SOURCE_SHA);
    assert.equal(extracted.worker_context, false);
    assert.equal(extracted.contains_solution, false);
    assert.deepEqual(extracted.files, [
      'plugins/codex-co-engineer/mcp/v3/assignment-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/contract.mjs',
      'plugins/codex-co-engineer/mcp/v3/grammar.mjs',
      'plugins/codex-co-engineer/mcp/v3/identity.mjs',
      'plugins/codex-co-engineer/mcp/v3/prompt-compiler.mjs',
      'plugins/codex-co-engineer/mcp/v3/repo-path-matcher.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-policy.mjs',
      'scripts/compare-coengineer-runs.mjs',
    ]);
    const text = await readFile(path.join(dest, 'scripts/compare-coengineer-runs.mjs'), 'utf8');
    assert.equal(text.includes('export async function materializeCase'), false);
    await assert.rejects(() => extractSource({
      caseId: 'comparison-failed-helper-cumulative',
      destination: dest,
    }), { code: 'destination_not_empty' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seed 43 schedule has 24 unrun required-arm trials and live jobs are refused', async () => {
  const schedule = generateSchedule(ORDERING_SEED);
  assert.equal(schedule.trial_count, 24);
  assert.equal(schedule.ordered.length, 24);
  assert.equal(schedule.algorithm, 'mulberry32-fisher-yates-grouped-by-case-rep-then-approach-positions');
  assert.equal(schedule.ordered.every((row) => row.status === 'unrun'), true);
  assert.equal(schedule.ordered.every((row) => row.retrospective === true), true);
  assert.equal(new Set(schedule.ordered.map((row) => row.trial_id)).size, 24);
  assert.equal(schedule.ordered.every((row) => row.trial_id.includes('.') === false), true);
  assert.equal(new Set(schedule.canonical.map((row) => row.case_id)).size, 3);
  for (const arm of QUALIFICATION_ARMS) {
    assert.equal(schedule.canonical.filter((row) => row.arm === arm).length, 6);
  }
  const firstFour = schedule.ordered.slice(0, 4);
  assert.equal(new Set(firstFour.map((row) => `${row.case_id}:${row.rep}`)).size, 1);
  assert.deepEqual([...new Set(firstFour.map((row) => row.arm))].sort(), [...QUALIFICATION_ARMS].sort());
  assert.deepEqual([...new Set(schedule.canonical.map((row) => row.arm))].sort(), [...QUALIFICATION_ARMS].sort());
  const groupOrders = [];
  for (let index = 0; index < schedule.ordered.length; index += 4) {
    const group = schedule.ordered.slice(index, index + 4);
    assert.equal(new Set(group.map((row) => `${row.case_id}:${row.rep}`)).size, 1);
    assert.equal(new Set(group.map((row) => row.arm)).size, 4);
    groupOrders.push(group.map((row) => row.arm).join(','));
  }
  assert.ok(new Set(groupOrders).size > 1);
  assert.ok(groupOrders.some((order) => order !== QUALIFICATION_ARMS.join(',')));
  const reshuffled = generateSchedule(ORDERING_SEED);
  assert.deepEqual(reshuffled.ordered, schedule.ordered);
  assert.equal(reshuffled.algorithm, schedule.algorithm);
  assert.notDeepEqual(schedule.ordered.map((row) => row.trial_id), schedule.canonical.map((row) => row.trial_id));
  const writtenProtocol = JSON.parse(await readFile(QUAL_PROTOCOL, 'utf8'));
  const writtenManifest = JSON.parse(await readFile(QUAL_MANIFEST, 'utf8'));
  assert.equal(writtenProtocol.ordering.algorithm, schedule.algorithm);
  assert.equal(writtenManifest.ordering.algorithm, schedule.algorithm);
  assert.deepEqual(writtenManifest.schedule, schedule.ordered);

  const captured = io();
  const live = await main(['--live', '--paid-budget', String(PAID_CEILING_USD)], captured);
  assert.equal(live, 2);
  assert.equal(captured.stderr.text().includes('Live provider jobs are not implemented'), true);
  const unknown = await main(['--bogus'], captured);
  assert.equal(unknown, 2);
});

test('CLI validates packed cases and materializes through the public helper', async () => {
  const captured = io();
  const validated = await main(['--validate'], captured);
  assert.equal(validated, 0);
  assert.equal(captured.stdout.text().includes('acp-deadline-concurrent-cancel'), true);
  const scheduled = await main(['--schedule'], captured);
  assert.equal(scheduled, 0);
  assert.equal(captured.stdout.text().includes('"seed": 43'), true);
  assert.equal(captured.stdout.text().includes('candidate_sha'), false);

  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-qual-cli-'));
  try {
    const dest = path.join(root, 'case');
    const code = await main([
      '--materialize-case',
      path.join(QUAL_CASES, 'acp-deadline-concurrent-cancel.json'),
      '--destination',
      dest,
    ], captured);
    assert.equal(code, 0);
    const task = await readFile(path.join(dest, 'TASK.md'), 'utf8');
    assert.equal(task.includes('checks/deadline-concurrent.test.mjs'), true);
    const check = await readFile(path.join(dest, 'checks/deadline-concurrent.test.mjs'), 'utf8');
    assert.equal(check.includes('runAcpTask'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packCase keeps qualification identity without fictional hashes or future SHAs', async () => {
  const packed = await packCase('acp-deadline-concurrent-cancel');
  assert.equal(packed.source_sha, PUBLISHED_342_SHA);
  assert.match(packed.base_sha, /^[0-9a-f]{40}$/u);
  assert.notEqual(packed.base_sha, packed.source_sha);
  assert.equal(Object.hasOwn(packed, 'candidate_sha'), false);
  assert.equal(packed.schema, QUALIFICATION_CASE_SCHEMA_ID);
  const planned = generateSchedule().canonical.find((row) => row.arm === 'candidate-3.4.3');
  assert.equal(planned.trial_id.includes('.'), false);
  const trialBody = {
    schema: 'codex-co-engineer.benchmark-trial.v1',
    trial_id: planned.trial_id,
    case_id: packed.id,
    arm: 'candidate-3.4.3',
    base_sha: packed.base_sha,
    input_digest: packed.input_digest,
    coengineer_source: { kind: 'git_commit', value: CANDIDATE_FIXTURE_SHA },
    host_model: HOST_MODEL,
    host_settings: settings(),
    provider_configuration: caseRoutes()[packed.id],
    accepted: true,
    wall_elapsed_ms: metric(1000),
    attempts: [{
      attempt_id: 'initial',
      kind: 'initial',
      outcome: 'accepted',
      usage: { native_output_tokens: metric(10) },
    }],
  };
  const parsedTrial = parseQualificationTrial(trialBody);
  assert.equal(parsedTrial.trial_id, planned.trial_id);
  assert.equal(parseTrial(trialBody).trial_id, planned.trial_id);
  assert.throws(() => parseTrial({
    ...trialBody,
    trial_id: `${packed.id}-candidate-3.4.3-r1`,
  }), { code: 'invalid_format' });
});

test('tracked protocol requires all four arms and leaves candidate identity external', async () => {
  const protocol = protocolRecord();
  assert.deepEqual(protocol.approaches, [...QUALIFICATION_ARMS]);
  assert.deepEqual(protocol.arms.required, [...QUALIFICATION_ARMS]);
  assert.deepEqual(protocol.arms.optional, []);
  assert.equal(Object.hasOwn(protocol, 'candidate_sha'), false);
  assert.equal(protocol.execution_identity.bound_in, 'external_execution_manifest');
  const written = JSON.parse(await readFile(QUAL_PROTOCOL, 'utf8'));
  assert.equal(Object.hasOwn(written, 'candidate_sha'), false);
  assert.equal(written.arms.optional.length, 0);
  const manifest = JSON.parse(await readFile(QUAL_MANIFEST, 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'candidate_sha'), false);
  assert.equal(manifest.schedule.length, 24);
  assert.throws(() => parseExecutionManifest({
    schema: 'codex-co-engineer.qualification-execution-manifest.v1',
    status: 'recorded',
    candidate: { sha: CANDIDATE_FIXTURE_SHA },
    published_3_4_2: { sha: PUBLISHED_342_SHA },
    host: { host_model: PLACEHOLDER_HOST_MODEL, host_settings: settings() },
    astra: { provider: ASTRA_PROVIDER, model: ASTRA_MODEL },
    provider_configuration: { implement: 'grok' },
    approaches: {
      'native-codex': { external_jobs: false },
      'published-3.4.2': { external_jobs: true },
      'candidate-3.4.3': { external_jobs: true },
      'direct-delegation': { external_jobs: true },
    },
  }), { code: 'identity_mismatch' });
  const cases = await loadQualificationCases();
  const recorded = recordedManifest(cases.raw);
  delete recorded.candidate.tree;
  assert.throws(() => parseExecutionManifest(recorded), { code: 'missing_key' });
  recorded.candidate.tree = PUBLISHED_FIXTURE_TREE;
  recorded.provider_configuration = {
    implement: { provider: 'grok', model: 'grok-4' },
    review: { provider: 'cursor-local', model: 'composer-1' },
  };
  assert.throws(() => parseExecutionManifest(recorded), { code: 'identity_mismatch' });
});

test('evaluator accepts 6/6 with task-level medians, Astra decrease, failures, corrections, and helpers', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const trials = cohortTrials(packed.raw, manifest);
  const comparison = evaluateCohort(packed, manifest, trials);
  assert.equal(comparison.decision, 'pass');
  assert.equal(comparison.candidate_accepted, '6/6');
  assert.equal(comparison.compared_identities, 24);
  assert.ok(comparison.metrics.task_median_native_output_per_accepted_vs_native <= 0.5);
  assert.ok(comparison.metrics.task_median_native_output_per_accepted_vs_published <= 0.75);
  assert.equal(comparison.metrics.astra_own_native_output.decreased, true);
  assert.ok(comparison.metrics.median_turnaround_vs_native <= 2);
  assert.ok(comparison.metrics.native_overhead_vs_direct <= 1.25);
  assert.equal(comparison.metrics.median_turnaround_reduction, TURNAROUND_REDUCTION);
  assert.equal(comparison.metrics.native_overhead_reduction, OVERHEAD_REDUCTION);
  const candidateArm = comparison.cases[0].arms['candidate-3.4.3'];
  assert.ok(candidateArm.failed_attempt_count >= 1);
  assert.ok(candidateArm.correction_count >= 1);
  const nativeArm = comparison.cases[0].arms['native-codex'];
  assert.ok(nativeArm.native_helper_count >= 1);
  assert.equal(nativeArm.astra_own_native_output.includes_helpers, false);
});

test('evaluator uses task-level median rather than a pooled ratio', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const byCase = {
    'acp-deadline-concurrent-cancel': { nativeOutput: 10, astraOutput: 20 },
    'run-result-outcome-acceptance': { nativeOutput: 60, astraOutput: 20 },
    'comparison-failed-helper-cumulative': { nativeOutput: 70, astraOutput: 20 },
  };
  const trials = cohortTrials(packed.raw, manifest, {
    'candidate-3.4.3': {},
  }).map((trial) => {
    if (trial.arm !== 'candidate-3.4.3') return trial;
    const plan = { trial_id: trial.trial_id, case_id: trial.case_id, arm: trial.arm, rep: 1 };
    const caseRecord = packed.raw.find((entry) => entry.id === trial.case_id);
    return makeTrial(plan, caseRecord, manifest, {
      accepted: true,
      nativeOutput: byCase[trial.case_id].nativeOutput,
      wall: 1500,
      failedThenCorrect: false,
    });
  });
  const comparison = evaluateCohort(packed, manifest, trials);
  assert.equal(comparison.decision, 'fail');
  assert.equal(comparison.reasons.includes('task_median_vs_native_exceeds_0.5'), true);
  assert.ok(comparison.metrics.task_median_native_output_per_accepted_vs_native > 0.5);
  assert.ok(comparison.metrics.pooled_native_output_per_accepted_vs_native <= 0.5);
});

test('missing arms, missing acceptance, missing primary, and mismatched identities are inconclusive', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);

  const omittedDirect = cohortTrials(packed.raw, manifest)
    .filter((trial) => trial.arm !== 'direct-delegation');
  const missingArm = evaluateCohort(packed, manifest, omittedDirect);
  assert.equal(missingArm.decision, 'inconclusive');
  assert.equal(missingArm.reasons.some((reason) => reason.startsWith('omitted:')), true);

  const missingAcceptanceTrials = cohortTrials(packed.raw, manifest);
  delete missingAcceptanceTrials[0].accepted;
  const missingAcceptance = evaluateCohort(packed, manifest, missingAcceptanceTrials);
  assert.equal(missingAcceptance.decision, 'inconclusive');
  assert.equal(missingAcceptance.reasons.some((reason) => reason.startsWith('missing_acceptance:')), true);

  const missingPrimaryTrials = cohortTrials(packed.raw, manifest);
  missingPrimaryTrials[0].wall_elapsed_ms = { value: null, source: 'unknown', trust: 'unknown' };
  const missingPrimary = evaluateCohort(packed, manifest, missingPrimaryTrials);
  assert.equal(missingPrimary.decision, 'inconclusive');
  assert.equal(missingPrimary.reasons.some((reason) => reason.startsWith('missing_primary:')), true);

  const mismatchedTrials = cohortTrials(packed.raw, manifest);
  mismatchedTrials[0].host_model = 'other-host-model';
  const mismatched = evaluateCohort(packed, manifest, mismatchedTrials);
  assert.equal(mismatched.decision, 'inconclusive');
  assert.equal(mismatched.reasons.some((reason) => reason.includes('host_model_mismatch')), true);

  const digestMismatchTrials = cohortTrials(packed.raw, manifest);
  digestMismatchTrials[1].input_digest = 'ab'.repeat(32);
  const digestMismatch = evaluateCohort(packed, manifest, digestMismatchTrials);
  assert.equal(digestMismatch.decision, 'inconclusive');
  assert.equal(digestMismatch.reasons.some((reason) => reason.includes('input_digest_mismatch')), true);

  const wrongRouteTrials = cohortTrials(packed.raw, manifest);
  const acpTrial = wrongRouteTrials.find((trial) => (
    trial.case_id === 'acp-deadline-concurrent-cancel' && trial.arm === 'candidate-3.4.3'
  ));
  acpTrial.provider_configuration = caseRoutes()['run-result-outcome-acceptance'];
  const wrongRoute = evaluateCohort(packed, manifest, wrongRouteTrials);
  assert.equal(wrongRoute.decision, 'inconclusive');
  assert.equal(wrongRoute.reasons.some((reason) => reason.includes('provider_configuration_mismatch')), true);
});

test('candidate not 6/6 accepted fails when identities are otherwise comparable', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  let flipped = false;
  const trials = cohortTrials(packed.raw, manifest).map((trial) => {
    if (!flipped && trial.arm === 'candidate-3.4.3') {
      flipped = true;
      const caseRecord = packed.raw.find((entry) => entry.id === trial.case_id);
      return makeTrial(trial, caseRecord, manifest, {
        accepted: false,
        nativeOutput: 40,
        wall: 1500,
        failedThenCorrect: false,
      });
    }
    return trial;
  });
  const comparison = evaluateCohort(packed, manifest, trials);
  assert.equal(comparison.decision, 'fail');
  assert.equal(comparison.reasons.includes('candidate_not_6_of_6_accepted'), true);
  assert.equal(comparison.candidate_accepted, '5/6');
});

test('unrecorded execution manifest is inconclusive and does not invent identities', async () => {
  const packed = await loadQualificationCases();
  const comparison = evaluateQualificationCohort({
    protocol: protocolRecord(),
    cases: packed.raw,
    trials: [],
    executionManifest: {
      schema: 'codex-co-engineer.qualification-execution-manifest.v1',
      status: 'unrecorded',
      candidate: null,
      host: null,
      astra: null,
    },
  });
  assert.equal(comparison.decision, 'inconclusive');
  assert.deepEqual(comparison.reasons, ['execution_manifest_unrecorded']);
});

test('overhead uses candidate/direct native output, not wall time', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const trials = cohortTrials(packed.raw, manifest, {
    'native-codex': { nativeOutput: 1000, wall: 1000 },
    'published-3.4.2': { nativeOutput: 800, wall: 1000 },
    'candidate-3.4.3': { nativeOutput: 400, wall: 1000, failedThenCorrect: false },
    'direct-delegation': { nativeOutput: 100, wall: 1000 },
  });
  const comparison = evaluateCohort(packed, manifest, trials);
  assert.equal(comparison.metrics.native_overhead_vs_direct, 4);
  assert.equal(comparison.decision, 'fail');
  assert.equal(comparison.reasons.includes('native_overhead_exceeds_1.25x_direct'), true);
  assert.equal(comparison.metrics.median_turnaround_vs_native, 1);
});

test('turnaround is the median of per-trial wall ratios, not the ratio of summed walls', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const schedule = generateSchedule();
  const caseById = new Map(packed.raw.map((entry) => [entry.id, entry]));
  const trials = schedule.canonical.map((plan) => {
    const walls = {
      'native-codex': plan.rep === 1 ? 1000 : 4000,
      'candidate-3.4.3': plan.rep === 1 ? 4000 : 1000,
      'published-3.4.2': 900,
      'direct-delegation': 900,
    };
    return makeTrial(plan, caseById.get(plan.case_id), manifest, {
      accepted: true,
      nativeOutput: plan.arm === 'native-codex' ? 100 : 40,
      wall: walls[plan.arm],
      failedThenCorrect: false,
      helper: false,
    });
  });
  const comparison = evaluateCohort(packed, manifest, trials);
  assert.equal(comparison.metrics.median_turnaround_vs_native, 2.125);
  assert.equal(comparison.decision, 'fail');
  assert.equal(comparison.reasons.includes('median_turnaround_exceeds_2x_native'), true);
  const summedRatio = (4000 + 1000) / (1000 + 4000);
  assert.equal(summedRatio, 1);
  assert.ok(comparison.metrics.median_turnaround_vs_native > summedRatio);
});

test('missing helper usage report stays inconclusive and keeps measured numbers', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const trials = cohortTrials(packed.raw, manifest);
  const reports = cohortReports(trials);
  const helperTrial = trials.find((trial) => trial.attempts.some((attempt) => attempt.kind === 'native_helper'));
  const report = reports.find((entry) => entry.trial.trial_id === helperTrial.trial_id);
  report.status = 'inconclusive';
  report.evidence.incomplete_primary_evidence = true;
  report.evidence.notes = ['absent_session:helper-session'];
  const comparison = evaluateCohort(packed, manifest, trials, { usageReports: reports });
  assert.equal(comparison.decision, 'inconclusive');
  assert.equal(comparison.reasons.some((reason) => reason.startsWith('usage_report_inconclusive:')), true);
  assert.notEqual(comparison.decision, 'pass');
  assert.ok(comparison.metrics.astra_own_native_output.candidate > 0);
  assert.ok(comparison.metrics.task_median_native_output_per_accepted_vs_native != null);
  const nativeUsage = comparison.cases
    .find((row) => row.case_id === helperTrial.case_id)
    .arms['native-codex']
    .usage.native_output_tokens.value;
  assert.ok(nativeUsage > 0);
});

test('importer host-usage-report fixture interoperates with parseTrial and the evaluator', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const fixture = JSON.parse(await readFile(path.join(QUAL_FIXTURES, 'host-usage-report-astra.json'), 'utf8'));
  assert.equal(EVIDENCE_DIGEST_DOMAIN, 'codex-co-engineer.host-usage-evidence.v1');
  assert.equal(fixture.evidence.digests.trial, hostUsageTrialDigest(fixture.trial));
  const parsedReport = parseHostUsageReport(fixture);
  assert.equal(parsedReport.status, 'complete');
  assert.equal(parsedReport.integrity.ok, true);
  assert.equal(parsedReport.evidence.trial_digest_verified, true);
  assert.equal(parsedReport.evidence.digests.trial, fixture.evidence.digests.trial);
  assert.equal(parsedReport.breakdown.attempts[0].by_model[0].model, ASTRA_MODEL);
  assert.equal(parsedReport.breakdown.attempts[0].by_model[0].input_tokens, 80);
  assert.equal(parsedReport.breakdown.attempts[0].output_tokens, 40);
  const parsedTrial = parseTrial(fixture.trial);
  assert.equal(parsedTrial.attempts[0].provider, null);
  assert.equal(parsedTrial.attempts[0].model, null);
  assert.equal(parsedTrial.attempts[0].usage.provider_output_tokens.value, null);
  assert.equal(parsedTrial.attempts[0].usage.native_input_tokens.value, 80);
  assert.equal(parsedTrial.attempts[0].usage.native_output_tokens.value, fixture.trial.attempts[0].usage.native_output_tokens.value);
  assert.equal(parsedTrial.attempts[0].sequence, 1);

  const trials = cohortTrials(packed.raw, manifest);
  const target = trials.find((trial) => trial.trial_id === fixture.trial.trial_id);
  assert.equal(target != null, true);
  const reports = cohortReports(trials);
  const index = reports.findIndex((entry) => entry.trial.trial_id === fixture.trial.trial_id);
  reports[index] = fixture;
  Object.assign(target, fixture.trial);
  const comparison = evaluateCohort(packed, manifest, trials, { usageReports: reports });
  assert.equal(comparison.decision, 'pass');
  const arm = comparison.cases.find((row) => row.case_id === fixture.trial.case_id).arms[fixture.trial.arm];
  assert.equal(arm.astra_own_native_output.value, 80);
  assert.equal(arm.astra_own_native_output.includes_helpers, false);
  assert.equal(arm.astra_own_native_output.coverage_complete, true);
});

test('incomplete importer-shaped reports keep observed Astra 40 when primary counters are null', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const trials = cohortTrials(packed.raw, manifest);
  const targetIndex = trials.findIndex((trial) => (
    trial.arm === 'candidate-3.4.3' && trial.trial_id.endsWith('-r2')
  ));
  const targetCase = packed.raw.find((entry) => entry.id === trials[targetIndex].case_id);
  const helperTrial = makeTrial(trials[targetIndex], targetCase, manifest, {
    accepted: true,
    nativeOutput: 40,
    wall: 1500,
    failedThenCorrect: false,
    helper: true,
  });
  const { trial, report } = importerShapedIncompleteAstra40(helperTrial);
  trials[targetIndex] = trial;

  const parsed = parseHostUsageReport(report);
  assert.equal(parsed.status, 'inconclusive');
  assert.equal(parsed.integrity.ok, true);
  assert.equal(parsed.integrity.reasons.some((reason) => reason.startsWith('by_model_sum:')), false);
  assert.equal(parsed.integrity.reasons.some((reason) => reason.startsWith('native_usage:')), false);
  assert.equal(parsed.breakdown.attempts[0].output_tokens, null);
  assert.equal(parsed.breakdown.attempts[0].by_model[0].output_tokens, 40);
  assert.equal(parsed.breakdown.attempts[0].by_model[0].model, ASTRA_MODEL);
  const helperRow = parsed.breakdown.attempts.find((row) => row.attempt_id === 'helper');
  assert.equal(helperRow != null, true);
  assert.deepEqual(helperRow.by_model, []);
  assert.equal(helperRow.output_tokens, null);

  const reports = cohortReports(trials);
  const reportIndex = reports.findIndex((entry) => entry.trial.trial_id === trial.trial_id);
  reports[reportIndex] = report;
  const comparison = evaluateCohort(packed, manifest, trials, { usageReports: reports });
  assert.equal(comparison.decision, 'inconclusive');
  assert.equal(
    comparison.reasons.some((reason) => reason === `usage_report_inconclusive:${trial.trial_id}`),
    true,
  );
  assert.equal(
    comparison.reasons.some((reason) => reason.startsWith(`usage_report_inconsistent:${trial.trial_id}:`)),
    false,
  );
  const arm = comparison.cases
    .find((row) => row.case_id === trial.case_id)
    .arms['candidate-3.4.3']
    .astra_own_native_output;
  assert.equal(arm.value, 80);
  assert.equal(arm.coverage_complete, false);
  assert.equal(arm.trust, 'unknown');
  assert.equal(comparison.metrics.astra_own_native_output.coverage_complete, false);
  assert.notEqual(comparison.decision, 'pass');

  const knownMismatch = structuredClone(report);
  knownMismatch.breakdown.attempts[0].output_tokens = 100;
  knownMismatch.trial.attempts[0].usage.native_output_tokens = metric(100);
  knownMismatch.evidence.digests.trial = hostUsageTrialDigest(knownMismatch.trial);
  const parsedMismatch = parseHostUsageReport(knownMismatch);
  assert.equal(parsedMismatch.integrity.ok, false);
  assert.equal(
    parsedMismatch.integrity.reasons.includes(`by_model_sum:${trial.attempts[0].attempt_id}:output_tokens`),
    true,
  );

  const duplicated = structuredClone(report);
  duplicated.breakdown.attempts[0].by_model.push(modelRow(ASTRA_MODEL, 0, 1));
  const parsedDuplicate = parseHostUsageReport(duplicated);
  assert.equal(parsedDuplicate.integrity.ok, false);
  assert.equal(
    parsedDuplicate.integrity.reasons.includes(`duplicate_model:${trial.attempts[0].attempt_id}:${ASTRA_MODEL}`),
    true,
  );
});

test('corrupted by_model, mutated trial input, and missing helper rows are inconclusive', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const trials = cohortTrials(packed.raw, manifest);

  const clean = evaluateCohort(packed, manifest, trials);
  assert.equal(clean.decision, 'pass');
  assert.equal(clean.metrics.astra_own_native_output.coverage_complete, true);
  const cleanAstra = clean.metrics.astra_own_native_output.candidate;

  const candidateReport = cohortReports(trials).find((entry) => entry.trial.arm === 'candidate-3.4.3');
  const candidateId = candidateReport.trial.trial_id;
  const candidateAstra = candidateReport.breakdown.attempts
    .flatMap((row) => row.by_model)
    .filter((entry) => entry.model === ASTRA_MODEL)
    .reduce((sum, entry) => sum + (entry.output_tokens ?? 0), 0);

  const mutatedInputReports = cohortReports(trials);
  const mutatedInput = mutatedInputReports.find((entry) => entry.trial.trial_id === candidateId);
  mutatedInput.trial.attempts[0].usage.native_input_tokens.value += 1;
  const mutatedInputResult = evaluateCohort(packed, manifest, trials, { usageReports: mutatedInputReports });
  assert.equal(mutatedInputResult.decision, 'inconclusive');
  assert.equal(
    mutatedInputResult.reasons.some((reason) => reason === `usage_report_mismatch:${candidateId}:canonical_trial`),
    true,
  );
  assert.equal(mutatedInputResult.metrics.astra_own_native_output.coverage_complete, false);
  assert.notEqual(mutatedInputResult.decision, 'pass');

  const modelReports = cohortReports(trials);
  const modelReport = modelReports.find((entry) => entry.trial.trial_id === candidateId);
  const astraRow = modelReport.breakdown.attempts[0].by_model.find((entry) => entry.model === ASTRA_MODEL);
  const originalAstra = astraRow.output_tokens;
  astraRow.output_tokens = 1;
  const modelResult = evaluateCohort(packed, manifest, trials, { usageReports: modelReports });
  assert.equal(modelResult.decision, 'inconclusive');
  assert.equal(
    modelResult.reasons.some((reason) => reason.startsWith(`usage_report_inconsistent:${candidateId}:`)),
    true,
  );
  assert.equal(modelResult.metrics.astra_own_native_output.coverage_complete, false);
  assert.notEqual(modelResult.metrics.astra_own_native_output.candidate, cleanAstra - originalAstra + 1);
  assert.notEqual(modelResult.metrics.astra_own_native_output.candidate, cleanAstra - candidateAstra + 1);
  assert.notEqual(modelResult.decision, 'pass');

  const helperTrials = cohortTrials(packed.raw, manifest);
  const helperIndex = helperTrials.findIndex((trial) => trial.arm === 'candidate-3.4.3');
  const helperCase = packed.raw.find((entry) => entry.id === helperTrials[helperIndex].case_id);
  helperTrials[helperIndex] = makeTrial(helperTrials[helperIndex], helperCase, manifest, {
    accepted: true,
    nativeOutput: 40,
    wall: 1500,
    failedThenCorrect: false,
    helper: true,
  });
  const helperReports = cohortReports(helperTrials);
  const helperId = helperTrials[helperIndex].trial_id;
  const helperReport = helperReports.find((entry) => entry.trial.trial_id === helperId);
  helperReport.breakdown.attempts.pop();
  const helperResult = evaluateCohort(packed, manifest, helperTrials, { usageReports: helperReports });
  assert.equal(helperResult.decision, 'inconclusive');
  assert.equal(
    helperResult.reasons.some((reason) => reason === `usage_report_inconsistent:${helperId}:missing_attempt:helper`),
    true,
  );
  const helperArm = helperResult.cases
    .find((row) => row.case_id === helperTrials[helperIndex].case_id)
    .arms['candidate-3.4.3']
    .astra_own_native_output;
  assert.equal(helperResult.metrics.astra_own_native_output.coverage_complete, false);
  assert.equal(helperArm.coverage_complete, false);
  assert.ok(helperArm.value > 0);
  assert.ok(helperResult.metrics.astra_own_native_output.candidate > 0);
  assert.notEqual(helperResult.decision, 'pass');
});

test('deadline over one hour fails when identities are otherwise comparable', async () => {
  const packed = await loadQualificationCases();
  const manifest = recordedManifest(packed.raw);
  const trials = cohortTrials(packed.raw, manifest, {
    'candidate-3.4.3': { wall: 3_600_001, failedThenCorrect: false },
  });
  const comparison = evaluateCohort(packed, manifest, trials);
  assert.equal(comparison.decision, 'fail');
  assert.equal(comparison.reasons.some((reason) => reason.startsWith('deadline_exceeded:')), true);
});
