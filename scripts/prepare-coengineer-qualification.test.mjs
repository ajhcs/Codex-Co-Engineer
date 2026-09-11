import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CASE_SCHEMA_ID,
  loadCases,
  parseCase,
} from './compare-coengineer-runs.mjs';
import {
  CANDIDATE_SHA,
  CASE_IDS,
  FIVE_TOOLS,
  ORDERING_SEED,
  PAID_CEILING_USD,
  PUBLISHED_342_SHA,
  RESULT_SOURCE_SHA,
  checkKnownBad,
  extractSource,
  generateSchedule,
  loadQualificationCases,
  main,
  materializeQualificationCase,
  packCase,
  scanWorkerLeakage,
} from './prepare-coengineer-qualification.mjs';
import { PUBLIC_MCP_TOOLS } from '../plugins/codex-co-engineer/mcp/v3/response.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXISTING_CASES = path.join(ROOT, 'benchmarks/cases');
const QUAL_CASES = path.join(ROOT, 'benchmarks/qualification/cases');

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

test('packed qualification cases bind real source, digest, and materialized base SHA', async () => {
  const packed = await loadQualificationCases();
  assert.equal(packed.raw.length, 3);
  assert.equal(packed.raw[0].qualification.status, 'unrun');
  assert.equal(packed.raw[0].qualification.source_sha, PUBLISHED_342_SHA);
  assert.equal(packed.raw[1].qualification.source_sha, RESULT_SOURCE_SHA);
  assert.equal(packed.raw[2].qualification.source_sha, RESULT_SOURCE_SHA);
  for (const record of packed.raw) {
    assert.equal(record.schema, CASE_SCHEMA_ID);
    assert.equal(record.qualification.candidate_sha, CANDIDATE_SHA);
    assert.match(record.base_sha, /^[0-9a-f]{40}$/u);
    assert.match(record.input_digest, /^[0-9a-f]{64}$/u);
    assert.equal(record.qualification.invented_backend_ids, false);
    parseCase(record);
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
    const written = await readFile(path.join(dest1, 'project-result.mjs'), 'utf8');
    assert.equal(written, record.inputs.files['project-result.mjs']);
    await assert.rejects(() => materializeQualificationCase(record, dest1), { code: 'destination_not_empty' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale source, candidate, and digest identities are rejected', async () => {
  const packed = await loadQualificationCases();
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-qual-stale-'));
  try {
    const candidateAsSource = structuredClone(packed.raw[0]);
    candidateAsSource.qualification.source_sha = CANDIDATE_SHA;
    await assert.rejects(
      () => materializeQualificationCase(candidateAsSource, path.join(root, 'candidate')),
      { code: 'solution_leakage' },
    );

    const digestTamper = structuredClone(packed.raw[0]);
    digestTamper.qualification.input_digest = 'ab'.repeat(32);
    await mkdir(path.join(root, 'digest'));
    await assert.rejects(
      () => materializeQualificationCase(digestTamper, path.join(root, 'digest')),
      { code: 'stale_identity' },
    );

    const shaTamper = structuredClone(packed.raw[1]);
    shaTamper.qualification.source_sha = PUBLISHED_342_SHA;
    await mkdir(path.join(root, 'source'));
    await assert.rejects(
      () => materializeQualificationCase(shaTamper, path.join(root, 'source')),
      { code: 'stale_identity' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance fails on the known-bad source for every retrospective case', async () => {
  const packed = await loadQualificationCases();
  for (const record of packed.raw) {
    const result = await checkKnownBad(record);
    assert.equal(result.failed, true);
    assert.notEqual(result.exit, 0);
  }
});

test('worker materialization does not leak solutions or extra paths', async () => {
  const packed = await loadQualificationCases();
  for (const record of packed.raw) {
    scanWorkerLeakage(record.inputs.files);
    assert.equal(Object.hasOwn(record.inputs.files, 'solution.mjs'), false);
    for (const text of Object.values(record.inputs.files)) {
      assert.equal(text.includes(CANDIDATE_SHA), false);
      assert.equal(text.includes('AsyncLocalStorage'), false);
    }
  }
  const leaked = structuredClone(packed.raw[0].inputs.files);
  leaked['turn-runner.mjs'] += '\nexport const hint = "AsyncLocalStorage";\n';
  assert.throws(() => scanWorkerLeakage(leaked), { code: 'solution_leakage' });
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
    assert.deepEqual(extracted.files, ['scripts/compare-coengineer-runs.mjs']);
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

test('seed 43 schedule has 24 unrun trials and live jobs are refused', async () => {
  const schedule = generateSchedule(ORDERING_SEED);
  assert.equal(schedule.trial_count, 24);
  assert.equal(schedule.ordered.length, 24);
  assert.equal(schedule.ordered.every((row) => row.status === 'unrun'), true);
  assert.equal(schedule.ordered.every((row) => row.retrospective === true), true);
  assert.equal(new Set(schedule.ordered.map((row) => row.trial_id)).size, 24);
  const reshuffled = generateSchedule(ORDERING_SEED);
  assert.deepEqual(reshuffled.ordered, schedule.ordered);
  assert.notDeepEqual(schedule.ordered.map((row) => row.trial_id), schedule.canonical.map((row) => row.trial_id));

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
    assert.equal(task.includes('Repair `turn-runner.mjs`'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packCase keeps comparator-compatible identity without fictional hashes', async () => {
  const packed = await packCase('acp-deadline-concurrent-cancel');
  assert.equal(packed.qualification.source_sha, PUBLISHED_342_SHA);
  assert.equal(packed.base_sha, packed.qualification.base_sha);
  assert.notEqual(packed.base_sha, CANDIDATE_SHA);
  assert.notEqual(packed.base_sha, PUBLISHED_342_SHA);
  const parsed = parseCase(packed);
  assert.equal(parsed.input_digest, packed.input_digest);
});
