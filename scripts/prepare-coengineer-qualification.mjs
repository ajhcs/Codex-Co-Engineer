#!/usr/bin/env node
// Non-provider materialization helper for 3.4.3 retrospective qualification
// cases. Reuses the offline comparator materializer. Live provider jobs are
// not implemented. Paid trials stay opt-in and are still not executed.

import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PUBLIC_MCP_TOOLS } from '../plugins/codex-co-engineer/mcp/v3/response.mjs';
import {
  ALL_ARMS,
  CASE_GIT_IDENTITY,
  CASE_SCHEMA_ID,
  GIT_EXECUTABLE,
  OPTIONAL_ARMS,
  REQUIRED_ARMS,
  computeInputDigest,
  loadCases,
  materializeCase,
  parseCase,
} from './compare-coengineer-runs.mjs';

const execFile = promisify(execFileCallback);

export const QUALIFICATION_PROTOCOL_SCHEMA_ID = 'codex-co-engineer.qualification-protocol.v1';
export const QUALIFICATION_MANIFEST_SCHEMA_ID = 'codex-co-engineer.qualification-manifest.v1';
export const CANDIDATE_SHA = 'c50550e0a12e6ce8f7564d0e384f52c205640ce5';
export const PUBLISHED_342_SHA = 'dede188029aff117c60e9a8c4299cc0ab0838be9';
export const RESULT_SOURCE_SHA = '3131f9ac7f6807eccb2ab68f027f1d98d3db3661';
export const PAID_CEILING_USD = 25;
export const TRIAL_DEADLINE_MS = 60 * 60 * 1000;
export const MAX_CORRECTIONS = 3;
export const REPETITIONS = 2;
export const ORDERING_SEED = 43;
export const FIVE_TOOLS = Object.freeze(['status', 'delegate', 'task', 'tasks', 'cancel']);
export const SOLUTION_SHAS = Object.freeze([
  CANDIDATE_SHA,
  'd2c691f10afb08f35e6826eaeb121428a806cbc5',
  'eed128c3a2033e5d4153d3d97cb0e31f4929e43e',
  '4e2bafd0f5b150b6e68eb6d3847833a5f7dc8433',
  '3d90384d65da38e1e985bbaab06788b5dab29303',
]);
export const SOLUTION_MARKERS = Object.freeze([
  'solution.mjs',
  'AsyncLocalStorage',
  'coEngineerTurnSignalStore',
  'combineAssignmentResult',
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUAL_ROOT = path.join(ROOT, 'benchmarks/qualification');
const INPUTS_ROOT = path.join(QUAL_ROOT, 'inputs');
const CASES_ROOT = path.join(QUAL_ROOT, 'cases');
const PROTOCOL_PATH = path.join(QUAL_ROOT, 'protocol.json');
const MANIFEST_PATH = path.join(QUAL_ROOT, 'operator-manifest.json');
const EXISTING_CASES_ROOT = path.join(ROOT, 'benchmarks/cases');
const SHA40 = /^[0-9a-f]{40}$/u;
const GIT_TIMEOUT_MS = 10_000;
const NODE_TEST_TIMEOUT_MS = 30_000;
const PLACEHOLDER_HOST = Object.freeze({
  host_model: 'codex-default',
  host_settings: Object.freeze({ reasoning: 'default', sandbox: 'workspace-write' }),
});
const BOOLEAN_FLAGS = Object.freeze(['--help', '--live', '--validate', '--pack', '--schedule', '--check-known-bad']);
const VALUE_FLAGS = Object.freeze([
  '--materialize-case', '--destination', '--case', '--paid-budget',
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export const CASE_DEFS = Object.freeze([
  Object.freeze({
    id: 'acp-deadline-concurrent-cancel',
    title: 'Honor deadline extensions and isolate concurrent ACP cancellation',
    summary: 'In-flight turns must follow the current recorded deadline, and overlapping sessions must not steal cancellation or promote timeout partials into completed end_turn.',
    source_sha: PUBLISHED_342_SHA,
    implement: 'cursor-local',
    review: 'grok',
    test_file: 'turn-runner.test.mjs',
    required_files: Object.freeze(['TASK.md', 'turn-runner.mjs', 'turn-runner.test.mjs']),
    forbidden_paths: Object.freeze(['turn-runner.test.mjs', 'TASK.md']),
    allowlist: Object.freeze([
      'plugins/codex-co-engineer/mcp/v3/acp-worker.mjs',
      'plugins/codex-co-engineer/assets/acpx-runtime.mjs',
      'plugins/codex-co-engineer/mcp/v3/deadline.mjs',
    ]),
  }),
  Object.freeze({
    id: 'run-result-outcome-acceptance',
    title: 'Keep run-result outcomes distinct from Codex acceptance',
    summary: 'Completed provider work is not Codex acceptance. Failed, uncertain, and unfinal stay distinct, verify completion is not a passed check, and missing usage stays unknown.',
    source_sha: RESULT_SOURCE_SHA,
    implement: 'grok',
    review: 'cursor-local',
    test_file: 'project-result.test.mjs',
    required_files: Object.freeze(['TASK.md', 'project-result.mjs', 'project-result.test.mjs']),
    forbidden_paths: Object.freeze(['project-result.test.mjs', 'TASK.md']),
    allowlist: Object.freeze([
      'plugins/codex-co-engineer/mcp/v3/run-result-evidence.mjs',
      'plugins/codex-co-engineer/mcp/v3/final-decision-card.mjs',
      'plugins/codex-co-engineer/mcp/v3/usage-ledger.mjs',
    ]),
  }),
  Object.freeze({
    id: 'comparison-failed-helper-cumulative',
    title: 'Count failed attempts, helpers, and compatible cumulative snapshots',
    summary: 'Failed attempts remain in the usage-per-accepted numerator, helpers are not double-counted, mixed providers stay grouped, and cumulative snapshots cannot overwrite a terminal failure.',
    source_sha: RESULT_SOURCE_SHA,
    implement: 'grok',
    review: 'cursor-local',
    test_file: 'account-trials.test.mjs',
    required_files: Object.freeze(['TASK.md', 'account-trials.mjs', 'account-trials.test.mjs']),
    forbidden_paths: Object.freeze(['account-trials.test.mjs', 'TASK.md']),
    allowlist: Object.freeze([
      'scripts/compare-coengineer-runs.mjs',
    ]),
  }),
]);

export const CASE_IDS = Object.freeze(CASE_DEFS.map((entry) => entry.id));

function caseDef(id) {
  const found = CASE_DEFS.find((entry) => entry.id === id);
  if (!found) fail('unknown_case', `Unknown qualification case ${id}.`);
  return found;
}

async function runGit(cwd, args) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
  try {
    const result = await execFile(GIT_EXECUTABLE, args, {
      cwd,
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(result.stdout ?? '');
  } catch (error) {
    const stderr = error instanceof Error ? String(error.stderr ?? error.message) : String(error);
    fail('git_execution_failed', `git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

export async function resolveCommit(sha) {
  if (typeof sha !== 'string' || !SHA40.test(sha)) {
    fail('invalid_format', 'Commit identity must be a 40-character SHA.');
  }
  const resolved = (await runGit(ROOT, ['rev-parse', '--verify', `${sha}^{commit}`])).trim();
  if (resolved !== sha) {
    fail('stale_identity', `Resolved commit ${resolved} does not match recorded SHA ${sha}.`);
  }
  return resolved;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seed) {
  const rng = mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = arr[i];
    arr[i] = arr[j];
    arr[j] = swap;
  }
  return arr;
}

export function generateSchedule(seed = ORDERING_SEED) {
  const canonical = [];
  for (const id of CASE_IDS) {
    for (const arm of ALL_ARMS) {
      for (let rep = 1; rep <= REPETITIONS; rep += 1) {
        const def = caseDef(id);
        canonical.push({
          trial_id: `${id}-${arm}-r${rep}`,
          case_id: id,
          arm,
          rep,
          implement: arm === 'native-codex' ? 'native' : def.implement,
          review: arm === 'native-codex' ? null : def.review,
          status: 'unrun',
          retrospective: true,
        });
      }
    }
  }
  return {
    seed,
    algorithm: 'mulberry32-fisher-yates',
    trial_count: canonical.length,
    canonical,
    ordered: seededShuffle(canonical, seed),
  };
}

async function readInputFiles(id) {
  const def = caseDef(id);
  const dir = path.join(INPUTS_ROOT, id);
  const names = (await readdir(dir)).sort();
  const files = {};
  for (const name of names) {
    if (name.startsWith('.')) continue;
    files[name] = await readFile(path.join(dir, name), 'utf8');
  }
  for (const required of def.required_files) {
    if (!Object.hasOwn(files, required)) {
      fail('missing_key', `${id} is missing required input ${required}.`);
    }
  }
  return files;
}

export function qualificationIdentity(def, inputDigest, baseSha) {
  return {
    retrospective: true,
    status: 'unrun',
    source_sha: def.source_sha,
    candidate_sha: CANDIDATE_SHA,
    source_kind: 'git_commit',
    implement_provider: def.implement,
    review_provider: def.review,
    allowlist: [...def.allowlist],
    host_and_astra: 'record_at_execution',
    invented_backend_ids: false,
    input_digest: inputDigest,
    base_sha: baseSha,
  };
}

export async function buildCaseRecord(id, { baseSha = null } = {}) {
  const def = caseDef(id);
  const files = await readInputFiles(id);
  const acceptance = {
    checks: [{
      id: 'unit',
      command: ['node', '--test', def.test_file],
      expect_exit: 0,
    }],
    required_files: [...def.required_files],
    forbidden_paths: [...def.forbidden_paths],
  };
  const inputDigest = computeInputDigest(files, acceptance);
  const record = {
    schema: CASE_SCHEMA_ID,
    id: def.id,
    title: def.title,
    summary: def.summary,
    input_digest: inputDigest,
    comparable: {
      host_model: PLACEHOLDER_HOST.host_model,
      host_settings: { ...PLACEHOLDER_HOST.host_settings },
      provider_configuration: { implement: def.implement, review: def.review },
    },
    inputs: { files },
    acceptance,
    qualification: qualificationIdentity(def, inputDigest, baseSha),
  };
  if (baseSha != null) record.base_sha = baseSha;
  parseCase(record);
  return record;
}

async function assertEmptyDestination(destination) {
  try {
    const info = await stat(destination);
    if (!info.isDirectory()) fail('invalid_type', 'destination must be an empty directory.');
    const names = await readdir(destination);
    if (names.length > 0) fail('destination_not_empty', 'destination must be empty.');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      await mkdir(destination, { recursive: true });
      return;
    }
    throw error;
  }
}

export function scanWorkerLeakage(files) {
  const leaks = [];
  for (const [rel, text] of Object.entries(files)) {
    const haystack = `${rel}\n${text}`;
    for (const sha of SOLUTION_SHAS) {
      if (haystack.includes(sha)) leaks.push({ path: rel, marker: sha });
    }
    for (const marker of SOLUTION_MARKERS) {
      if (haystack.toLowerCase().includes(marker.toLowerCase())) {
        leaks.push({ path: rel, marker });
      }
    }
  }
  if (leaks.length > 0) {
    fail('solution_leakage', `Worker inputs leak reference material: ${leaks[0].marker}.`);
  }
  return true;
}

export async function listRelativeFiles(rootDir) {
  const out = [];
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else out.push(rel);
    }
  }
  await walk(rootDir, '');
  return out.sort();
}

export async function materializeQualificationCase(record, destination) {
  const parsed = parseCase(record);
  scanWorkerLeakage(parsed.inputs.files);
  if (record.qualification != null) await assertFreshIdentity(record);
  const dest = path.resolve(destination);
  const materialized = await materializeCase(parsed, dest);
  const written = await listRelativeFiles(dest);
  const expected = Object.keys(parsed.inputs.files).sort();
  if (written.join('\n') !== expected.join('\n')) {
    fail('scope_violation', `Materialized files ${written.join(',')} escape frozen inputs.`);
  }
  if (record.qualification != null) {
    if (record.qualification.base_sha != null && record.qualification.base_sha !== materialized.base_sha) {
      fail('stale_identity', 'Materialized base SHA does not match the recorded qualification identity.');
    }
    if (record.qualification.input_digest !== materialized.input_digest) {
      fail('stale_identity', 'Materialized input digest does not match the recorded qualification identity.');
    }
  }
  return materialized;
}

export async function assertFreshIdentity(record) {
  const parsed = parseCase(record);
  const qual = record.qualification;
  if (qual == null || typeof qual !== 'object') {
    fail('missing_key', 'qualification identity is required.');
  }
  if (qual.candidate_sha !== CANDIDATE_SHA) {
    fail('stale_identity', 'qualification.candidate_sha is not the frozen 3.4.3 candidate.');
  }
  if (qual.source_sha === CANDIDATE_SHA) {
    fail('solution_leakage', 'Worker source identity cannot be the corrected candidate.');
  }
  const source = await resolveCommit(qual.source_sha);
  const expectedSource = caseDef(parsed.id).source_sha;
  if (source !== expectedSource) {
    fail('stale_identity', `${parsed.id} source SHA ${source} is not the recorded pre-fix identity ${expectedSource}.`);
  }
  const recomputed = computeInputDigest(parsed.inputs.files, parsed.acceptance);
  if (qual.input_digest !== recomputed || parsed.input_digest !== recomputed) {
    fail('stale_identity', 'input_digest does not match frozen files and acceptance checks.');
  }
  if (parsed.base_sha != null && qual.base_sha != null && parsed.base_sha !== qual.base_sha) {
    fail('stale_identity', 'base_sha does not match qualification identity.');
  }
  return { source_sha: source, candidate_sha: CANDIDATE_SHA, input_digest: recomputed };
}

export async function packCase(id) {
  const partial = await buildCaseRecord(id);
  scanWorkerLeakage(partial.inputs.files);
  const tmp = await mkdtemp(path.join(os.tmpdir(), `ce-qual-pack-${id}-`));
  try {
    const materialized = await materializeQualificationCase(partial, tmp);
    const packed = await buildCaseRecord(id, { baseSha: materialized.base_sha });
    packed.qualification.base_sha = materialized.base_sha;
    parseCase(packed);
    await assertFreshIdentity(packed);
    return packed;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function writePackedCases() {
  await mkdir(CASES_ROOT, { recursive: true });
  const packed = [];
  for (const id of CASE_IDS) {
    const record = await packCase(id);
    await writeFile(
      path.join(CASES_ROOT, `${id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
    packed.push(record);
  }
  return packed;
}

export async function loadQualificationCases() {
  const cases = await loadCases(CASES_ROOT);
  const raw = [];
  for (const id of CASE_IDS) {
    const text = await readFile(path.join(CASES_ROOT, `${id}.json`), 'utf8');
    const record = JSON.parse(text);
    parseCase(record);
    await assertFreshIdentity(record);
    raw.push(record);
  }
  if (cases.length !== CASE_IDS.length) {
    fail('identity_mismatch', 'Packed qualification cases do not match the frozen case list.');
  }
  return { cases, raw };
}

export async function extractSource({ caseId, destination, sha = null }) {
  const def = caseDef(caseId);
  const requested = sha ?? def.source_sha;
  const source = await resolveCommit(requested);
  if (source !== def.source_sha) {
    fail('stale_identity', `Refusing to extract ${source}; case ${caseId} is bound to ${def.source_sha}.`);
  }
  if (source === CANDIDATE_SHA) {
    fail('solution_leakage', 'Extracting the corrected candidate is not allowed.');
  }
  const dest = path.resolve(destination);
  await assertEmptyDestination(dest);
  const written = [];
  for (const rel of def.allowlist) {
    if (rel.split('/').includes('..') || rel.startsWith('/') || rel.includes('\0') || rel.includes('\\')) {
      fail('scope_violation', `${rel} is not an immutable allowlisted path.`);
    }
    const bytes = await runGit(ROOT, ['show', `${source}:${rel}`]);
    const target = path.join(dest, rel);
    const resolved = path.resolve(target);
    if (resolved !== target || !resolved.startsWith(`${dest}${path.sep}`)) {
      fail('scope_violation', `${rel} escapes the destination.`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { encoding: 'utf8', mode: 0o644 });
    written.push(rel);
  }
  const extras = await listRelativeFiles(dest);
  if (extras.join('\n') !== [...def.allowlist].sort().join('\n')) {
    fail('scope_violation', 'Extracted tree is not exactly the immutable allowlist.');
  }
  return {
    case_id: caseId,
    source_sha: source,
    destination: dest,
    files: written,
    worker_context: false,
    contains_solution: false,
  };
}

export async function runFrozenCheck(cwd, command) {
  try {
    await execFile(command[0], command.slice(1), {
      cwd,
      timeout: NODE_TEST_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: os.tmpdir(),
        LANG: 'C',
        LC_ALL: 'C',
      },
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stderr: '', stdout: '' };
  } catch (error) {
    return {
      code: Number.isInteger(error.status) ? error.status : 1,
      stderr: String(error.stderr ?? ''),
      stdout: String(error.stdout ?? ''),
    };
  }
}

export async function checkKnownBad(record) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ce-qual-bad-${record.id}-`));
  try {
    await materializeQualificationCase(record, root);
    const command = record.acceptance.checks[0].command;
    const result = await runFrozenCheck(root, command);
    if (result.code === 0) {
      fail('known_bad_passed', `${record.id} acceptance unexpectedly passed on the known-bad source.`);
    }
    return { case_id: record.id, failed: true, exit: result.code };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function freezeThresholds() {
  return {
    candidate_accepted: '6/6',
    median_case_native_output_per_accepted_vs_native_max: 0.5,
    median_case_native_output_per_accepted_vs_published_342_max: 0.75,
    astra_own_output_decreases_vs_published_342: true,
    median_turnaround_vs_native_max: 2,
    native_overhead_vs_direct_max: 1.25,
    failed_attempts_in_numerator: true,
    missing_primary_evidence: 'inconclusive',
    paid_ceiling_usd: PAID_CEILING_USD,
    max_corrections: MAX_CORRECTIONS,
    entire_trial_deadline_ms: TRIAL_DEADLINE_MS,
  };
}

export function protocolRecord() {
  const schedule = generateSchedule();
  return {
    schema: QUALIFICATION_PROTOCOL_SCHEMA_ID,
    version: 1,
    title: 'Codex-Co-Engineer 3.4.3 retrospective qualification protocol',
    status: 'unrun',
    candidate_sha: CANDIDATE_SHA,
    published_3_4_2_sha: PUBLISHED_342_SHA,
    arms: {
      required: [...REQUIRED_ARMS],
      optional: [...OPTIONAL_ARMS],
    },
    approaches: [...ALL_ARMS],
    cases: CASE_IDS.map((id) => {
      const def = caseDef(id);
      return {
        id,
        status: 'unrun',
        retrospective: true,
        source_sha: def.source_sha,
        implement: def.implement,
        review: def.review,
      };
    }),
    repetitions: REPETITIONS,
    trial_count: schedule.trial_count,
    ordering: { seed: ORDERING_SEED, algorithm: schedule.algorithm },
    deadline: {
      entire_trial_ms: TRIAL_DEADLINE_MS,
      max_corrections: MAX_CORRECTIONS,
    },
    paid_ceiling_usd: PAID_CEILING_USD,
    live_jobs: 'not_implemented',
    host: {
      record_at_execution: true,
      invented_backend_ids: false,
      astra: {
        status: 'unrecorded',
        note: 'Record exact Astra host settings and external model/routes at execution before freezing. Never invent backend IDs.',
      },
      placeholder_until_execution: PLACEHOLDER_HOST,
    },
    freeze_thresholds: freezeThresholds(),
    accounting: {
      failed_attempts_in_numerator: true,
      missing_primary_evidence: 'inconclusive',
      reuse_offline_comparator: true,
    },
    safeguards: {
      public_mcp_tools: [...FIVE_TOOLS],
      do_not_run_release_gate: true,
      do_not_publish: true,
      do_not_mutate_baseline_or_candidate_outside_worktree: true,
      no_live_jobs_in_helper: true,
    },
  };
}

export function operatorManifest() {
  const schedule = generateSchedule();
  return {
    schema: QUALIFICATION_MANIFEST_SCHEMA_ID,
    version: 1,
    status: 'unrun',
    title: 'Operator schedule for 3.4.3 retrospective qualification',
    candidate_sha: CANDIDATE_SHA,
    note: 'All 24 trials are unrun retrospective cases. Do not treat this manifest as measured evidence.',
    assignments: {
      'acp-deadline-concurrent-cancel': { implement: 'cursor-local', review: 'grok' },
      'run-result-outcome-acceptance': { implement: 'grok', review: 'cursor-local' },
      'comparison-failed-helper-cumulative': { implement: 'grok', review: 'cursor-local' },
    },
    paid_ceiling_usd: PAID_CEILING_USD,
    live_jobs: 'not_implemented',
    host_and_astra: 'record_at_execution',
    ordering: {
      seed: ORDERING_SEED,
      algorithm: schedule.algorithm,
      trial_count: schedule.trial_count,
    },
    schedule: schedule.ordered,
    unrun_case_ids: [...CASE_IDS],
  };
}

export async function writeProtocolAndManifest() {
  await mkdir(QUAL_ROOT, { recursive: true });
  await writeFile(PROTOCOL_PATH, `${JSON.stringify(protocolRecord(), null, 2)}\n`, 'utf8');
  await writeFile(MANIFEST_PATH, `${JSON.stringify(operatorManifest(), null, 2)}\n`, 'utf8');
}

export async function validateQualification() {
  if ([...PUBLIC_MCP_TOOLS].join(',') !== FIVE_TOOLS.join(',')) {
    fail('identity_mismatch', 'Public catalog must remain the five tools.');
  }
  const existing = await loadCases(EXISTING_CASES_ROOT);
  if (existing.length !== 4) {
    fail('identity_mismatch', 'Existing four comparator fixtures must remain unchanged.');
  }
  const packed = await loadQualificationCases();
  const protocol = JSON.parse(await readFile(PROTOCOL_PATH, 'utf8'));
  if (protocol.schema !== QUALIFICATION_PROTOCOL_SCHEMA_ID) fail('invalid_format', 'protocol.schema');
  if (protocol.status !== 'unrun') fail('identity_mismatch', 'Protocol must stay labeled unrun until trials execute.');
  if (protocol.candidate_sha !== CANDIDATE_SHA) fail('stale_identity', 'Protocol candidate SHA is stale.');
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const expected = generateSchedule();
  if (JSON.stringify(manifest.schedule) !== JSON.stringify(expected.ordered)) {
    fail('identity_mismatch', 'Operator schedule does not match seed 43 ordering.');
  }
  return {
    valid: true,
    case_count: packed.raw.length,
    ids: packed.raw.map((entry) => entry.id),
    input_digests: Object.fromEntries(packed.raw.map((entry) => [entry.id, entry.input_digest])),
    base_shas: Object.fromEntries(packed.raw.map((entry) => [entry.id, entry.base_sha])),
    source_shas: Object.fromEntries(packed.raw.map((entry) => [entry.id, entry.qualification.source_sha])),
    status: 'unrun',
    live_jobs: 'not_implemented',
  };
}

function printUsage() {
  return `Usage:
  node scripts/prepare-coengineer-qualification.mjs --validate
  node scripts/prepare-coengineer-qualification.mjs --pack
  node scripts/prepare-coengineer-qualification.mjs --schedule
  node scripts/prepare-coengineer-qualification.mjs --materialize-case FILE --destination DIR
  node scripts/prepare-coengineer-qualification.mjs --extract-source --case ID --destination DIR
  node scripts/prepare-coengineer-qualification.mjs --check-known-bad [--case ID]

Non-provider helper. Live provider jobs are not implemented. Paid repeated
trials require --live --paid-budget and are still not executed. Destination
directories must be empty. Host Astra settings are recorded at execution.
`;
}

function parseArgv(argv) {
  const flags = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail('unknown_flag', `Unexpected argument ${arg}.`);
    if (BOOLEAN_FLAGS.includes(arg)) {
      flags[arg] = true;
      continue;
    }
    if (arg === '--extract-source') {
      flags[arg] = true;
      continue;
    }
    if (arg === '--check-known-bad') {
      flags[arg] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(arg)) fail('unknown_flag', `Unknown flag ${arg}.`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) fail('missing_flag', `${arg} requires a value.`);
    flags[arg] = value;
    index += 1;
  }
  return flags;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv.length === 0 || argv.includes('--help')) {
    io.stdout.write(printUsage());
    return 0;
  }
  let flags;
  try {
    flags = parseArgv(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr.write(printUsage());
    return 2;
  }
  if (flags['--live']) {
    io.stderr.write('Live provider jobs are not implemented. Supply sanitized trial records.\n');
    if (flags['--paid-budget'] == null) {
      io.stderr.write(`Paid repeated trials are opt-in, capped at $${PAID_CEILING_USD}, and require --paid-budget.\n`);
    } else {
      io.stderr.write(`Paid ceiling is $${PAID_CEILING_USD}. This helper still does not run jobs.\n`);
    }
    return 2;
  }
  if (flags['--pack']) {
    const packed = await writePackedCases();
    await writeProtocolAndManifest();
    io.stdout.write(`${JSON.stringify({
      packed: packed.map((entry) => ({
        id: entry.id,
        input_digest: entry.input_digest,
        base_sha: entry.base_sha,
        source_sha: entry.qualification.source_sha,
      })),
      status: 'unrun',
    }, null, 2)}\n`);
    return 0;
  }
  if (flags['--schedule']) {
    io.stdout.write(`${JSON.stringify(operatorManifest(), null, 2)}\n`);
    return 0;
  }
  if (flags['--materialize-case'] != null) {
    if (flags['--destination'] == null) {
      io.stderr.write('Missing --destination DIR.\n');
      return 2;
    }
    const record = JSON.parse(await readFile(path.resolve(flags['--materialize-case']), 'utf8'));
    const materialized = await materializeQualificationCase(record, path.resolve(flags['--destination']));
    io.stdout.write(`${JSON.stringify(materialized, null, 2)}\n`);
    return 0;
  }
  if (flags['--extract-source']) {
    if (flags['--case'] == null || flags['--destination'] == null) {
      io.stderr.write('Missing --case ID and/or --destination DIR.\n');
      return 2;
    }
    const extracted = await extractSource({
      caseId: flags['--case'],
      destination: path.resolve(flags['--destination']),
    });
    io.stdout.write(`${JSON.stringify(extracted, null, 2)}\n`);
    return 0;
  }
  if (flags['--check-known-bad']) {
    const packed = await loadQualificationCases();
    const selected = flags['--case']
      ? packed.raw.filter((entry) => entry.id === flags['--case'])
      : packed.raw;
    if (selected.length === 0) fail('unknown_case', `Unknown qualification case ${flags['--case']}.`);
    const results = [];
    for (const record of selected) results.push(await checkKnownBad(record));
    io.stdout.write(`${JSON.stringify({ known_bad_failed: true, results }, null, 2)}\n`);
    return 0;
  }
  if (flags['--validate']) {
    const summary = await validateQualification();
    io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  io.stderr.write('Missing a known command.\n');
  io.stderr.write(printUsage());
  return 2;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
