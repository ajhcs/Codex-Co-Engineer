#!/usr/bin/env node
// Non-provider materialization and offline cohort helper for 3.4.3
// retrospective qualification. Reuses comparator parsing/accounting primitives
// without inheriting optional-arm policy or the small-case 16-file parser.
// Live provider jobs are not implemented.

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
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

import { canonicalJsonStringify } from '../plugins/codex-co-engineer/mcp/v3/identity.mjs';
import { PUBLIC_MCP_TOOLS } from '../plugins/codex-co-engineer/mcp/v3/response.mjs';
import {
  CASE_GIT_IDENTITY,
  COENGINEER_ARMS,
  GIT_EXECUTABLE,
  aggregateTrials,
  loadCases,
  parseTrial,
} from './compare-coengineer-runs.mjs';

const execFile = promisify(execFileCallback);

export const QUALIFICATION_PROTOCOL_SCHEMA_ID = 'codex-co-engineer.qualification-protocol.v1';
export const QUALIFICATION_MANIFEST_SCHEMA_ID = 'codex-co-engineer.qualification-manifest.v1';
export const QUALIFICATION_CASE_SCHEMA_ID = 'codex-co-engineer.qualification-case.v1';
export const QUALIFICATION_EXECUTION_SCHEMA_ID = 'codex-co-engineer.qualification-execution-manifest.v1';
export const QUALIFICATION_INPUT_DIGEST_DOMAIN = 'codex-co-engineer.qualification-input.v1';
export const DEADLINE_SOURCE_SHA = 'dede188029aff117c60e9a8c4299cc0ab0838be9';
export const PUBLISHED_342_SHA = DEADLINE_SOURCE_SHA;
export const RESULT_SOURCE_SHA = '3131f9ac7f6807eccb2ab68f027f1d98d3db3661';
export const PAID_CEILING_USD = 25;
export const TRIAL_DEADLINE_MS = 60 * 60 * 1000;
export const MAX_CORRECTIONS = 3;
export const REPETITIONS = 2;
export const ORDERING_SEED = 43;
export const FIVE_TOOLS = Object.freeze(['status', 'delegate', 'task', 'tasks', 'cancel']);
export const QUALIFICATION_ARMS = Object.freeze([
  'native-codex',
  'published-3.4.2',
  'candidate-3.4.3',
  'direct-delegation',
]);
export const PLACEHOLDER_HOST_MODEL = 'codex-default';
export const ASTRA_PROVIDER = 'openai';
export const ASTRA_MODEL = 'gpt-6-astra';
export const HOST_USAGE_REPORT_SCHEMA_ID = 'codex-co-engineer.host-usage-report.v1';
export const EVIDENCE_DIGEST_DOMAIN = 'codex-co-engineer.host-usage-evidence.v1';
const HOST_USAGE_COUNTERS = Object.freeze([
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
]);
const HOST_MODEL_COUNTERS = Object.freeze([...HOST_USAGE_COUNTERS, 'total_tokens']);
export const ARM_TRIAL_TOKENS = Object.freeze({
  'native-codex': 'native-codex',
  'published-3.4.2': 'published-3-4-2',
  'candidate-3.4.3': 'candidate-3-4-3',
  'direct-delegation': 'direct-delegation',
});
export const TURNAROUND_REDUCTION = 'median of per-trial candidate/native wall ratios paired by case_id and rep; not the ratio of summed wall durations';
export const OVERHEAD_REDUCTION = 'median of 3 task ratios of candidate native_output_per_accepted / direct native_output_per_accepted';
export const ASTRA_REDUCTION = 'count gpt-6-astra native output once from host-usage-report.v1 by_model; helpers excluded unless observed as Astra';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUAL_ROOT = path.join(ROOT, 'benchmarks/qualification');
const INPUTS_ROOT = path.join(QUAL_ROOT, 'inputs');
const CASES_ROOT = path.join(QUAL_ROOT, 'cases');
const PROTOCOL_PATH = path.join(QUAL_ROOT, 'protocol.json');
const MANIFEST_PATH = path.join(QUAL_ROOT, 'operator-manifest.json');
const PRECOLLECTION_PATH = path.join(QUAL_ROOT, 'precollection-manifest.json');
const EXISTING_CASES_ROOT = path.join(ROOT, 'benchmarks/cases');
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_TIMEOUT_MS = 30_000;
const NODE_TEST_TIMEOUT_MS = 90_000;
const MAX_QUAL_FILES = 80;
const MAX_QUAL_FILE_BYTES = 1024 * 1024;
const MAX_PATH_SEGMENTS = 8;
const QUAL_TRIAL_ID = /^[a-z][a-z0-9-]{1,63}$/u;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;
const BOOLEAN_FLAGS = Object.freeze([
  '--help', '--live', '--validate', '--pack', '--schedule', '--check-known-bad',
  '--extract-source', '--evaluate-cohort',
]);
const VALUE_FLAGS = Object.freeze([
  '--materialize-case', '--destination', '--case', '--paid-budget',
  '--trials', '--execution-manifest',
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hostUsageEvidenceDigest(parts) {
  const hash = createHash('sha256');
  hash.update(EVIDENCE_DIGEST_DOMAIN);
  hash.update('\0');
  for (const part of parts) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part), 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(buffer);
  }
  return hash.digest('hex');
}

export function hostUsageTrialDigest(trial) {
  return hostUsageEvidenceDigest(['trial', JSON.stringify(trial)]);
}

function parseOptionalCounter(value, pathLabel) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('out_of_range', `${pathLabel} must be a non-negative safe integer.`);
  }
  return value;
}

function sumModelCounter(rows, key) {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const row of rows) {
    if (row[key] == null) return null;
    sum += row[key];
  }
  return sum;
}

export const CASE_DEFS = Object.freeze([
  Object.freeze({
    id: 'acp-deadline-concurrent-cancel',
    title: 'Honor deadline extensions and isolate concurrent ACP cancellation',
    summary: 'In-flight turns must follow the current recorded deadline, and overlapping sessions must not steal cancellation or promote timeout partials into completed end_turn.',
    source_sha: DEADLINE_SOURCE_SHA,
    implement: 'cursor-local',
    review: 'grok',
    test_file: 'checks/deadline-concurrent.test.mjs',
    overlay_files: Object.freeze(['TASK.md', 'checks/deadline-concurrent.test.mjs']),
    primary_paths: Object.freeze([
      'plugins/codex-co-engineer/mcp/v3/acp-worker.mjs',
      'plugins/codex-co-engineer/mcp/v3/deadline.mjs',
    ]),
    allowlist: Object.freeze([
      'plugins/codex-co-engineer/assets/acpx-runtime.mjs',
      'plugins/codex-co-engineer/mcp/v3/acp-worker.mjs',
      'plugins/codex-co-engineer/mcp/v3/aggregate-run-anchor.mjs',
      'plugins/codex-co-engineer/mcp/v3/artifact-path.mjs',
      'plugins/codex-co-engineer/mcp/v3/artifact-reader.mjs',
      'plugins/codex-co-engineer/mcp/v3/artifact-ref.mjs',
      'plugins/codex-co-engineer/mcp/v3/artifact-sanitizer.mjs',
      'plugins/codex-co-engineer/mcp/v3/artifact-store.mjs',
      'plugins/codex-co-engineer/mcp/v3/assignment-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/attention-batch.mjs',
      'plugins/codex-co-engineer/mcp/v3/capability-bridge.mjs',
      'plugins/codex-co-engineer/mcp/v3/compact-task.mjs',
      'plugins/codex-co-engineer/mcp/v3/contract.mjs',
      'plugins/codex-co-engineer/mcp/v3/credential-boundary.mjs',
      'plugins/codex-co-engineer/mcp/v3/cursor-cloud-driver.mjs',
      'plugins/codex-co-engineer/mcp/v3/cursor-cloud-result-source.mjs',
      'plugins/codex-co-engineer/mcp/v3/cursor-cloud-worker.mjs',
      'plugins/codex-co-engineer/mcp/v3/cursor-local-driver.mjs',
      'plugins/codex-co-engineer/mcp/v3/deadline.mjs',
      'plugins/codex-co-engineer/mcp/v3/diagnostics.mjs',
      'plugins/codex-co-engineer/mcp/v3/dsh-acpx-driver.mjs',
      'plugins/codex-co-engineer/mcp/v3/evidence-bundle.mjs',
      'plugins/codex-co-engineer/mcp/v3/future-harness.mjs',
      'plugins/codex-co-engineer/mcp/v3/git-authority.mjs',
      'plugins/codex-co-engineer/mcp/v3/git-identity.mjs',
      'plugins/codex-co-engineer/mcp/v3/grammar.mjs',
      'plugins/codex-co-engineer/mcp/v3/grok-acp-driver.mjs',
      'plugins/codex-co-engineer/mcp/v3/grok-question-bridge.mjs',
      'plugins/codex-co-engineer/mcp/v3/identity.mjs',
      'plugins/codex-co-engineer/mcp/v3/local-provider-result-sink.mjs',
      'plugins/codex-co-engineer/mcp/v3/mailbox.mjs',
      'plugins/codex-co-engineer/mcp/v3/process-boundary.mjs',
      'plugins/codex-co-engineer/mcp/v3/profile.mjs',
      'plugins/codex-co-engineer/mcp/v3/prompt-compiler.mjs',
      'plugins/codex-co-engineer/mcp/v3/protected-identity.mjs',
      'plugins/codex-co-engineer/mcp/v3/protected-telemetry.mjs',
      'plugins/codex-co-engineer/mcp/v3/provider-driver-conformance.mjs',
      'plugins/codex-co-engineer/mcp/v3/provider-driver-template.mjs',
      'plugins/codex-co-engineer/mcp/v3/provider-driver.mjs',
      'plugins/codex-co-engineer/mcp/v3/provider-registry.mjs',
      'plugins/codex-co-engineer/mcp/v3/provider-result.mjs',
      'plugins/codex-co-engineer/mcp/v3/readiness-snapshot.mjs',
      'plugins/codex-co-engineer/mcp/v3/repo-path-matcher.mjs',
      'plugins/codex-co-engineer/mcp/v3/resolver.mjs',
      'plugins/codex-co-engineer/mcp/v3/response.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-admission-store.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-admission.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-artifact-bridge.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-journal.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-orchestration.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-policy.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-preflight.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-reducer.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-request-compiler.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-runtime.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-scheduler.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-store.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-tool-adapter.mjs',
      'plugins/codex-co-engineer/mcp/v3/runtime-entrypoints.mjs',
      'plugins/codex-co-engineer/mcp/v3/selection-json.mjs',
      'plugins/codex-co-engineer/mcp/v3/supervisor.mjs',
      'plugins/codex-co-engineer/mcp/v3/task-store.mjs',
      'plugins/codex-co-engineer/mcp/v3/usage-ledger.mjs',
      'plugins/codex-co-engineer/mcp/v3/worktree-bootstrap-runtime.mjs',
      'plugins/codex-co-engineer/vendor/worktree-bootstrap/worktree-bootstrap',
    ]),
  }),
  Object.freeze({
    id: 'run-result-outcome-acceptance',
    title: 'Keep run-result outcomes distinct from Codex acceptance',
    summary: 'Completed provider work is not Codex acceptance. Failed, uncertain, and unfinal stay distinct, verify completion is not a passed check, and missing usage stays unknown.',
    source_sha: RESULT_SOURCE_SHA,
    implement: 'grok',
    review: 'cursor-local',
    test_file: 'checks/run-result-outcome.test.mjs',
    overlay_files: Object.freeze(['TASK.md', 'checks/run-result-outcome.test.mjs']),
    primary_paths: Object.freeze([
      'plugins/codex-co-engineer/mcp/v3/run-result-evidence.mjs',
      'plugins/codex-co-engineer/mcp/v3/final-decision-card.mjs',
      'plugins/codex-co-engineer/mcp/v3/usage-ledger.mjs',
    ]),
    allowlist: Object.freeze([
      'plugins/codex-co-engineer/mcp/v3/artifact-path.mjs',
      'plugins/codex-co-engineer/mcp/v3/artifact-ref.mjs',
      'plugins/codex-co-engineer/mcp/v3/assignment-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/capability-bridge.mjs',
      'plugins/codex-co-engineer/mcp/v3/contract.mjs',
      'plugins/codex-co-engineer/mcp/v3/final-decision-card.mjs',
      'plugins/codex-co-engineer/mcp/v3/grammar.mjs',
      'plugins/codex-co-engineer/mcp/v3/identity.mjs',
      'plugins/codex-co-engineer/mcp/v3/prompt-compiler.mjs',
      'plugins/codex-co-engineer/mcp/v3/protected-identity.mjs',
      'plugins/codex-co-engineer/mcp/v3/protected-telemetry.mjs',
      'plugins/codex-co-engineer/mcp/v3/repo-path-matcher.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-policy.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-result-evidence.mjs',
      'plugins/codex-co-engineer/mcp/v3/selection-json.mjs',
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
    test_file: 'checks/failed-helper-cumulative.test.mjs',
    overlay_files: Object.freeze(['TASK.md', 'checks/failed-helper-cumulative.test.mjs']),
    primary_paths: Object.freeze(['scripts/compare-coengineer-runs.mjs']),
    allowlist: Object.freeze([
      'plugins/codex-co-engineer/mcp/v3/assignment-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/contract.mjs',
      'plugins/codex-co-engineer/mcp/v3/grammar.mjs',
      'plugins/codex-co-engineer/mcp/v3/identity.mjs',
      'plugins/codex-co-engineer/mcp/v3/prompt-compiler.mjs',
      'plugins/codex-co-engineer/mcp/v3/repo-path-matcher.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-manifest.mjs',
      'plugins/codex-co-engineer/mcp/v3/run-policy.mjs',
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

export function assertQualificationPath(rel, pathLabel = 'path') {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 240) {
    fail('invalid_format', `${pathLabel} is not a safe relative path.`);
  }
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) {
    fail('invalid_format', `${pathLabel} is not a safe relative path.`);
  }
  const parts = rel.split('/');
  if (parts.length > MAX_PATH_SEGMENTS) {
    fail('bounds_exceeded', `${pathLabel} exceeds ${MAX_PATH_SEGMENTS} path segments.`);
  }
  for (const part of parts) {
    if (part === '.' || part === '..' || part === '.git' || part.length === 0) {
      fail('invalid_format', `${pathLabel} is not a safe relative path.`);
    }
  }
  return rel;
}

async function runGit(cwd, args, { encoding = 'utf8', maxBuffer = 2 * 1024 * 1024 } = {}) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: CASE_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: CASE_GIT_IDENTITY.email,
    GIT_AUTHOR_DATE: CASE_GIT_IDENTITY.date,
    GIT_COMMITTER_NAME: CASE_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: CASE_GIT_IDENTITY.email,
    GIT_COMMITTER_DATE: CASE_GIT_IDENTITY.date,
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
      maxBuffer,
      encoding,
    });
    return result.stdout;
  } catch (error) {
    const stderr = error instanceof Error ? String(error.stderr ?? error.message) : String(error);
    fail('git_execution_failed', `git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

export async function resolveCommit(sha) {
  if (typeof sha !== 'string' || !SHA40.test(sha)) {
    fail('invalid_format', 'Commit identity must be a 40-character SHA.');
  }
  const resolved = String(await runGit(ROOT, ['rev-parse', '--verify', `${sha}^{commit}`])).trim();
  if (resolved !== sha) {
    fail('stale_identity', `Resolved commit ${resolved} does not match recorded SHA ${sha}.`);
  }
  return resolved;
}

export async function readGitBytes(sha, rel) {
  assertQualificationPath(rel, rel);
  await resolveCommit(sha);
  const bytes = await runGit(ROOT, ['show', `${sha}:${rel}`], { encoding: 'buffer' });
  if (!Buffer.isBuffer(bytes)) fail('git_execution_failed', `git show ${sha}:${rel} did not return bytes.`);
  if (bytes.length > MAX_QUAL_FILE_BYTES) {
    fail('bounds_exceeded', `${rel} exceeds ${MAX_QUAL_FILE_BYTES} bytes.`);
  }
  return bytes;
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

export function qualificationTrialId(caseId, arm, rep) {
  const token = ARM_TRIAL_TOKENS[arm];
  if (token == null) fail('invalid_format', `Unknown qualification arm ${arm}.`);
  const trialId = `${caseId}-${token}-r${rep}`;
  if (!QUAL_TRIAL_ID.test(trialId)) {
    fail('invalid_format', `Qualification trial id ${trialId} is not hyphen-only.`);
  }
  return trialId;
}

function plannedTrial(id, arm, rep) {
  const def = caseDef(id);
  return {
    trial_id: qualificationTrialId(id, arm, rep),
    case_id: id,
    arm,
    rep,
    implement: arm === 'native-codex' ? 'native' : def.implement,
    review: arm === 'native-codex' ? null : def.review,
    status: 'unrun',
    retrospective: true,
  };
}

export function generateSchedule(seed = ORDERING_SEED) {
  const canonical = [];
  const groups = [];
  for (const id of CASE_IDS) {
    for (let rep = 1; rep <= REPETITIONS; rep += 1) {
      const group = QUALIFICATION_ARMS.map((arm) => plannedTrial(id, arm, rep));
      groups.push(group);
      canonical.push(...group);
    }
  }
  const ordered = seededShuffle(groups, seed).flat();
  const armCounts = Object.fromEntries(QUALIFICATION_ARMS.map((arm) => [
    arm,
    canonical.filter((row) => row.arm === arm).length,
  ]));
  if (canonical.length !== 24 || new Set(canonical.map((row) => row.trial_id)).size !== 24) {
    fail('identity_mismatch', 'Planned identities must be exactly 24 unique hyphen-only trial ids.');
  }
  if (Object.values(armCounts).some((count) => count !== 6) || new Set(canonical.map((row) => row.case_id)).size !== 3) {
    fail('identity_mismatch', 'Schedule must cover 3 distinct cases and exactly 6 trials per arm.');
  }
  const firstGroup = ordered.slice(0, 4);
  if (new Set(firstGroup.map((row) => `${row.case_id}:${row.rep}`)).size !== 1
    || new Set(firstGroup.map((row) => row.arm)).size !== 4) {
    fail('identity_mismatch', 'Seeded ordering must start with one matched group of 4 same task/rep arms.');
  }
  return {
    seed,
    algorithm: 'mulberry32-fisher-yates-grouped-by-case-rep',
    trial_count: canonical.length,
    canonical,
    ordered,
  };
}

async function readOverlayFiles(id) {
  const def = caseDef(id);
  const dir = path.join(INPUTS_ROOT, id);
  const files = {};
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      assertQualificationPath(rel, `${id}/${rel}`);
      files[rel] = await readFile(full, 'utf8');
    }
  }
  await walk(dir, '');
  for (const required of def.overlay_files) {
    if (!Object.hasOwn(files, required)) {
      fail('missing_key', `${id} is missing required overlay ${required}.`);
    }
  }
  const extras = Object.keys(files).filter((name) => !def.overlay_files.includes(name));
  if (extras.length > 0) {
    fail('scope_violation', `${id} overlay contains unexpected ${extras[0]}.`);
  }
  return files;
}

export function computeQualificationInputDigest({ sourceSha, allowlist, overlay, acceptance }) {
  const canonical = canonicalJsonStringify({
    source_sha: sourceSha,
    allowlist,
    overlay,
    acceptance,
  });
  return createHash('sha256')
    .update(QUALIFICATION_INPUT_DIGEST_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

export function computeCheckDigest(acceptance) {
  return createHash('sha256')
    .update('codex-co-engineer.qualification-check.v1', 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJsonStringify(acceptance), 'utf8')
    .digest('hex');
}

export async function measureAllowlist(def) {
  if (def.allowlist.length < 1 || def.allowlist.length > MAX_QUAL_FILES) {
    fail('bounds_exceeded', `${def.id} allowlist must contain 1..${MAX_QUAL_FILES} files.`);
  }
  const measured = [];
  for (const rel of def.allowlist) {
    assertQualificationPath(rel, rel);
    const bytes = await readGitBytes(def.source_sha, rel);
    measured.push({
      path: rel,
      git_sha256: sha256Bytes(bytes),
      bytes: bytes.length,
    });
  }
  return measured;
}

function qualificationAcceptance(def) {
  return {
    checks: [{
      id: 'unit',
      command: ['node', '--test', def.test_file],
      expect_exit: 0,
    }],
    required_files: [...def.overlay_files, ...def.primary_paths],
    forbidden_paths: [...def.overlay_files],
  };
}

export function scanOverlayLeakage(files) {
  const leaks = [];
  for (const [rel, text] of Object.entries(files)) {
    const haystack = `${rel}\n${text}`;
    if (haystack.includes('solution.mjs')) leaks.push({ path: rel, marker: 'solution.mjs' });
    if (/\bAsyncLocalStorage\b/u.test(haystack)) leaks.push({ path: rel, marker: 'AsyncLocalStorage' });
    if (/\btimeoutMs:\s*0\b/u.test(haystack) && rel.endsWith('.mjs')) {
      leaks.push({ path: rel, marker: 'timeoutMs:0' });
    }
  }
  if (leaks.length > 0) {
    fail('solution_leakage', `Worker overlay leaks reference material: ${leaks[0].marker}.`);
  }
  return true;
}

export function scanWorkerLeakage(files) {
  return scanOverlayLeakage(files);
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

async function writeRelativeFile(dest, rel, contents) {
  assertQualificationPath(rel, rel);
  const target = path.join(dest, rel);
  const resolved = path.resolve(target);
  if (resolved !== target || !resolved.startsWith(`${dest}${path.sep}`)) {
    fail('scope_violation', `${rel} escapes the destination.`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  const base = path.posix.basename(rel);
  const mode = base.includes('.') ? 0o644 : 0o755;
  if (Buffer.isBuffer(contents)) {
    await writeFile(target, contents, { mode });
  } else {
    await writeFile(target, contents, { encoding: 'utf8', mode });
  }
}

async function commitMaterializedTree(dest, caseId) {
  await runGit(dest, ['-c', 'init.defaultBranch=main', 'init', '--initial-branch=main']);
  await runGit(dest, [
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'core.safecrlf=false',
    'add', '-A',
  ]);
  await runGit(dest, [
    '-c', `user.name=${CASE_GIT_IDENTITY.name}`,
    '-c', `user.email=${CASE_GIT_IDENTITY.email}`,
    '-c', 'commit.gpgsign=false',
    'commit', '--no-gpg-sign', '-m', `${QUALIFICATION_CASE_SCHEMA_ID}:${caseId}`,
  ]);
  const head = String(await runGit(dest, ['rev-parse', 'HEAD'])).trim();
  if (!SHA40.test(head)) fail('git_execution_failed', 'materialized HEAD is not a 40-character SHA.');
  return head;
}

export async function materializeHistoricalFiles(def, destination, { overlay = {}, expectedAllowlist = null } = {}) {
  const dest = path.resolve(destination);
  await assertEmptyDestination(dest);
  const source = await resolveCommit(def.source_sha);
  const writtenAllowlist = [];
  for (const rel of def.allowlist) {
    const bytes = await readGitBytes(source, rel);
    const digest = sha256Bytes(bytes);
    if (expectedAllowlist != null) {
      const recorded = expectedAllowlist.find((entry) => entry.path === rel);
      if (recorded == null) fail('stale_identity', `${rel} is not in the frozen allowlist.`);
      if (recorded.git_sha256 !== digest || recorded.bytes !== bytes.length) {
        fail('stale_identity', `${rel} git bytes do not match the frozen allowlist digest.`);
      }
    }
    await writeRelativeFile(dest, rel, bytes);
    writtenAllowlist.push(rel);
  }
  for (const [rel, text] of Object.entries(overlay)) {
    if (def.allowlist.includes(rel)) {
      fail('scope_violation', `Overlay ${rel} collides with historical source.`);
    }
    await writeRelativeFile(dest, rel, text);
  }
  const written = await listRelativeFiles(dest);
  const expected = [...def.allowlist, ...Object.keys(overlay)].sort();
  if (written.join('\n') !== expected.join('\n')) {
    fail('scope_violation', `Materialized files escape frozen allowlist and overlay.`);
  }
  return { destination: dest, source_sha: source, files: written };
}

export async function materializeQualificationCase(record, destination) {
  const parsed = parseQualificationCase(record);
  scanOverlayLeakage(parsed.overlay);
  const dest = path.resolve(destination);
  const materialized = await materializeHistoricalFiles(caseDef(parsed.id), dest, {
    overlay: parsed.overlay,
    expectedAllowlist: parsed.allowlist,
  });
  const baseSha = await commitMaterializedTree(dest, parsed.id);
  if (parsed.base_sha != null && parsed.base_sha !== baseSha) {
    fail('stale_identity', `Materialized base SHA ${baseSha} does not match recorded ${parsed.base_sha}.`);
  }
  if (parsed.input_digest !== computeQualificationInputDigest({
    sourceSha: parsed.source_sha,
    allowlist: parsed.allowlist,
    overlay: parsed.overlay,
    acceptance: parsed.acceptance,
  })) {
    fail('stale_identity', 'input_digest does not match frozen files and acceptance checks.');
  }
  return {
    case_id: parsed.id,
    destination: dest,
    base_sha: baseSha,
    input_digest: parsed.input_digest,
    source_sha: parsed.source_sha,
    git_identity: { ...CASE_GIT_IDENTITY, message: `${QUALIFICATION_CASE_SCHEMA_ID}:${parsed.id}` },
  };
}

export function parseQualificationCase(value, pathLabel = 'case') {
  if (!isPlainObject(value)) fail('invalid_type', `${pathLabel} must be a JSON object.`);
  if (value.schema !== QUALIFICATION_CASE_SCHEMA_ID) fail('invalid_format', `${pathLabel}.schema`);
  const id = value.id;
  const def = caseDef(id);
  if (value.source_sha !== def.source_sha) {
    fail('stale_identity', `${id} source SHA is not the recorded pre-fix identity.`);
  }
  if (!Array.isArray(value.allowlist) || value.allowlist.length !== def.allowlist.length) {
    fail('identity_mismatch', `${id} allowlist does not match the frozen path list.`);
  }
  const allowlist = value.allowlist.map((entry, index) => {
    if (!isPlainObject(entry)) fail('invalid_type', `${pathLabel}.allowlist[${index}]`);
    const rel = assertQualificationPath(entry.path, `${pathLabel}.allowlist[${index}].path`);
    if (rel !== def.allowlist[index]) {
      fail('identity_mismatch', `${id} allowlist path order does not match the frozen list.`);
    }
    if (typeof entry.git_sha256 !== 'string' || !SHA256.test(entry.git_sha256)) {
      fail('invalid_format', `${pathLabel}.allowlist[${index}].git_sha256`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_QUAL_FILE_BYTES) {
      fail('out_of_range', `${pathLabel}.allowlist[${index}].bytes`);
    }
    return { path: rel, git_sha256: entry.git_sha256, bytes: entry.bytes };
  });
  if (!isPlainObject(value.overlay) || !isPlainObject(value.overlay.files)) {
    fail('invalid_type', `${pathLabel}.overlay.files`);
  }
  const overlay = {};
  for (const rel of def.overlay_files) {
    const text = value.overlay.files[rel];
    if (typeof text !== 'string' || text.length === 0) {
      fail('missing_key', `${pathLabel}.overlay.files.${rel}`);
    }
    overlay[rel] = text;
  }
  if (Object.keys(value.overlay.files).sort().join('\n') !== [...def.overlay_files].sort().join('\n')) {
    fail('identity_mismatch', `${id} overlay files do not match the frozen overlay list.`);
  }
  const acceptance = value.acceptance;
  if (!isPlainObject(acceptance) || !Array.isArray(acceptance.checks) || acceptance.checks.length < 1) {
    fail('invalid_format', `${pathLabel}.acceptance`);
  }
  const inputDigest = computeQualificationInputDigest({
    sourceSha: def.source_sha,
    allowlist,
    overlay,
    acceptance,
  });
  if (typeof value.input_digest === 'string') {
    if (!SHA256.test(value.input_digest) || value.input_digest !== inputDigest) {
      fail('stale_identity', `${pathLabel}.input_digest does not match frozen files and acceptance checks.`);
    }
  }
  let baseSha = null;
  if (Object.hasOwn(value, 'base_sha') && value.base_sha != null) {
    if (typeof value.base_sha !== 'string' || !SHA40.test(value.base_sha)) {
      fail('invalid_format', `${pathLabel}.base_sha`);
    }
    baseSha = value.base_sha;
  }
  if (value.retrospective !== true || value.status !== 'unrun') {
    fail('identity_mismatch', `${id} must remain an unrun retrospective case.`);
  }
  if (Object.hasOwn(value, 'candidate_sha')) {
    fail('stale_identity', 'Tracked qualification cases must not bind a future candidate SHA.');
  }
  if (value.comparable != null) {
    const hostModel = value.comparable.host_model;
    if (hostModel === PLACEHOLDER_HOST_MODEL) {
      fail('identity_mismatch', 'codex-default placeholders are not comparable truth.');
    }
  }
  return {
    schema: QUALIFICATION_CASE_SCHEMA_ID,
    id,
    title: def.title,
    summary: def.summary,
    source_sha: def.source_sha,
    allowlist,
    overlay,
    acceptance,
    input_digest: inputDigest,
    check_digest: computeCheckDigest(acceptance),
    base_sha: baseSha,
    implement: def.implement,
    review: def.review,
    retrospective: true,
    status: 'unrun',
  };
}

export function parseQualificationTrial(value, pathLabel = 'trial') {
  if (!isPlainObject(value)) fail('invalid_type', `${pathLabel} must be a JSON object.`);
  const trialId = value.trial_id;
  if (typeof trialId !== 'string' || !QUAL_TRIAL_ID.test(trialId)) {
    fail('invalid_format', `${pathLabel}.trial_id is not a hyphen-only qualification trial identity.`);
  }
  return parseTrial(value, pathLabel);
}

export async function assertFreshIdentity(record) {
  const parsed = parseQualificationCase(record);
  const source = await resolveCommit(parsed.source_sha);
  if (source !== caseDef(parsed.id).source_sha) {
    fail('stale_identity', `${parsed.id} source SHA ${source} is not the recorded pre-fix identity.`);
  }
  const measured = await measureAllowlist(caseDef(parsed.id));
  for (let index = 0; index < measured.length; index += 1) {
    if (measured[index].git_sha256 !== parsed.allowlist[index].git_sha256) {
      fail('stale_identity', `${parsed.allowlist[index].path} git bytes do not match the frozen digest.`);
    }
  }
  return { source_sha: source, input_digest: parsed.input_digest };
}

export async function buildCaseRecord(id, { baseSha = null } = {}) {
  const def = caseDef(id);
  const overlay = await readOverlayFiles(id);
  scanOverlayLeakage(overlay);
  const allowlist = await measureAllowlist(def);
  const acceptance = qualificationAcceptance(def);
  const inputDigest = computeQualificationInputDigest({
    sourceSha: def.source_sha,
    allowlist,
    overlay,
    acceptance,
  });
  const record = {
    schema: QUALIFICATION_CASE_SCHEMA_ID,
    id: def.id,
    title: def.title,
    summary: def.summary,
    input_digest: inputDigest,
    check_digest: computeCheckDigest(acceptance),
    source_sha: def.source_sha,
    retrospective: true,
    status: 'unrun',
    implement: def.implement,
    review: def.review,
    allowlist,
    overlay: { files: overlay },
    acceptance,
  };
  if (baseSha != null) record.base_sha = baseSha;
  parseQualificationCase(record);
  return record;
}

export async function packCase(id) {
  const partial = await buildCaseRecord(id);
  const tmp = await mkdtemp(path.join(os.tmpdir(), `ce-qual-pack-${id}-`));
  try {
    const materialized = await materializeQualificationCase(partial, tmp);
    const packed = await buildCaseRecord(id, { baseSha: materialized.base_sha });
    parseQualificationCase(packed);
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
  const raw = [];
  for (const id of CASE_IDS) {
    const text = await readFile(path.join(CASES_ROOT, `${id}.json`), 'utf8');
    const record = JSON.parse(text);
    parseQualificationCase(record);
    await assertFreshIdentity(record);
    raw.push(record);
  }
  return { raw };
}

export async function extractSource({ caseId, destination, sha = null }) {
  const def = caseDef(caseId);
  const requested = sha ?? def.source_sha;
  const source = await resolveCommit(requested);
  if (source !== def.source_sha) {
    fail('stale_identity', `Refusing to extract ${source}; case ${caseId} is bound to ${def.source_sha}.`);
  }
  const dest = path.resolve(destination);
  await materializeHistoricalFiles(def, dest);
  return {
    case_id: caseId,
    source_sha: source,
    destination: dest,
    files: [...def.allowlist],
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

export async function checkReferencePrivately(record, candidateSha) {
  const def = caseDef(record.id);
  const root = await mkdtemp(path.join(os.tmpdir(), `ce-qual-ref-${record.id}-`));
  try {
    await assertEmptyDestination(root);
    for (const rel of def.allowlist) {
      let bytes;
      try {
        bytes = await readGitBytes(candidateSha, rel);
      } catch {
        bytes = await readGitBytes(def.source_sha, rel);
      }
      await writeRelativeFile(root, rel, bytes);
    }
    const overlay = record.overlay?.files ?? parseQualificationCase(record).overlay;
    for (const [rel, text] of Object.entries(overlay)) {
      await writeRelativeFile(root, rel, text);
    }
    const result = await runFrozenCheck(root, record.acceptance.checks[0].command);
    return { case_id: record.id, exit: result.code, worker_context: false };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function freezeThresholds() {
  return {
    candidate_accepted: '6/6',
    task_median_native_output_per_accepted_vs_native_max: 0.5,
    task_median_native_output_per_accepted_vs_published_342_max: 0.75,
    astra_own_output_decreases_vs_published_342: true,
    median_turnaround_vs_native_max: 2,
    native_overhead_vs_direct_max: 1.25,
    failed_attempts_in_numerator: true,
    missing_primary_evidence: 'inconclusive',
    paid_ceiling_usd: PAID_CEILING_USD,
    max_corrections: MAX_CORRECTIONS,
    entire_trial_deadline_ms: TRIAL_DEADLINE_MS,
    turnaround_reduction: TURNAROUND_REDUCTION,
    native_overhead_reduction: OVERHEAD_REDUCTION,
    astra_own_output_reduction: ASTRA_REDUCTION,
  };
}

export function protocolRecord() {
  const schedule = generateSchedule();
  return {
    schema: QUALIFICATION_PROTOCOL_SCHEMA_ID,
    version: 1,
    title: 'Codex-Co-Engineer 3.4.3 retrospective qualification protocol',
    status: 'unrun',
    arms: {
      required: [...QUALIFICATION_ARMS],
      optional: [],
    },
    approaches: [...QUALIFICATION_ARMS],
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
    planned_identities: 24,
    ordering: {
      seed: ORDERING_SEED,
      algorithm: schedule.algorithm,
      first_matched_group: 'same-case-and-rep-all-four-arms',
    },
    deadline: {
      entire_trial_ms: TRIAL_DEADLINE_MS,
      max_corrections: MAX_CORRECTIONS,
    },
    paid_ceiling_usd: PAID_CEILING_USD,
    live_jobs: 'not_implemented',
    execution_identity: {
      bound_in: 'external_execution_manifest',
      host_placeholders_forbidden: true,
      candidate_sha_not_tracked_here: true,
    },
    freeze_thresholds: freezeThresholds(),
    accounting: {
      failed_attempts_in_numerator: true,
      missing_primary_evidence: 'inconclusive',
      reuse_offline_comparator_parsing: true,
      task_median_not_pooled: true,
      helpers_in_total_not_astra_unless_astra: true,
      all_four_approaches_required: true,
      routes_bound_per_case: true,
      turnaround_reduction: TURNAROUND_REDUCTION,
      native_overhead_reduction: OVERHEAD_REDUCTION,
      astra_own_output_reduction: ASTRA_REDUCTION,
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
    note: 'All 24 trials are unrun retrospective cases. Do not treat this manifest as measured evidence. Candidate and published SHAs are bound in the external execution manifest, not here.',
    assignments: Object.fromEntries(CASE_DEFS.map((def) => [def.id, {
      implement: { provider: def.implement },
      review: { provider: def.review },
    }])),
    paid_ceiling_usd: PAID_CEILING_USD,
    live_jobs: 'not_implemented',
    ordering: {
      seed: ORDERING_SEED,
      algorithm: schedule.algorithm,
      trial_count: schedule.trial_count,
    },
    schedule: schedule.ordered,
    unrun_case_ids: [...CASE_IDS],
  };
}

export function precollectionManifestTemplate() {
  return {
    schema: QUALIFICATION_EXECUTION_SCHEMA_ID,
    version: 1,
    status: 'unrecorded',
    note: 'Record actual Astra host model gpt-6-astra, effective settings, and exact per-case {provider,model} routes before collection. Native has no external jobs but uses the same planned host config. Never invent backend IDs. Bind immutable candidate commit SHA and tree SHA, published 3.4.2 SHA, and frozen input/check digests here so later results cannot change tracked files. Do not omit candidate.tree.',
    candidate: null,
    published_3_4_2: null,
    host: null,
    astra: null,
    provider_configuration: null,
    approaches: {
      'native-codex': { external_jobs: false },
      'published-3.4.2': { external_jobs: true },
      'candidate-3.4.3': { external_jobs: true },
      'direct-delegation': { external_jobs: true },
    },
    input_digests: {},
    check_digests: {},
  };
}

export async function writeProtocolAndManifest() {
  await mkdir(QUAL_ROOT, { recursive: true });
  await writeFile(PROTOCOL_PATH, `${JSON.stringify(protocolRecord(), null, 2)}\n`, 'utf8');
  await writeFile(MANIFEST_PATH, `${JSON.stringify(operatorManifest(), null, 2)}\n`, 'utf8');
  await writeFile(PRECOLLECTION_PATH, `${JSON.stringify(precollectionManifestTemplate(), null, 2)}\n`, 'utf8');
}

function settingsDigest(settings) {
  return canonicalJsonStringify(settings);
}

function ownSha(value, pathLabel) {
  if (typeof value !== 'string' || !SHA40.test(value)) {
    fail('invalid_format', `${pathLabel} must be a 40-character SHA.`);
  }
  return value;
}

function ownDigest(value, pathLabel) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('invalid_format', `${pathLabel} must be a 64-character SHA-256 digest.`);
  }
  return value;
}

function parseProviderModel(value, pathLabel, expectedProvider = null) {
  if (!isPlainObject(value)) {
    fail('invalid_type', `${pathLabel} must be a {provider, model} object.`);
  }
  const extra = Object.keys(value).filter((key) => key !== 'provider' && key !== 'model');
  if (extra.length > 0) fail('unknown_key', `${pathLabel}.${extra[0]}`);
  const provider = value.provider;
  const model = value.model;
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) {
    fail('invalid_format', `${pathLabel}.provider`);
  }
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    fail('invalid_format', `${pathLabel}.model`);
  }
  if (expectedProvider != null && provider !== expectedProvider) {
    fail('identity_mismatch', `${pathLabel}.provider must be ${expectedProvider}.`);
  }
  return { provider, model };
}

function parseCaseRoutes(value, pathLabel) {
  if (!isPlainObject(value)) fail('invalid_type', `${pathLabel} must be a JSON object.`);
  const expectedIds = [...CASE_IDS].sort().join(',');
  if (Object.keys(value).sort().join(',') !== expectedIds) {
    fail('identity_mismatch', `${pathLabel} must bind exact routes for all three cases.`);
  }
  const routes = {};
  for (const def of CASE_DEFS) {
    const row = value[def.id];
    if (!isPlainObject(row)) fail('missing_key', `${pathLabel}.${def.id}`);
    routes[def.id] = {
      implement: parseProviderModel(row.implement, `${pathLabel}.${def.id}.implement`, def.implement),
      review: parseProviderModel(row.review, `${pathLabel}.${def.id}.review`, def.review),
    };
  }
  return routes;
}

function parseBoundDigests(value, pathLabel) {
  if (!isPlainObject(value)) fail('missing_key', pathLabel);
  const expectedIds = [...CASE_IDS].sort().join(',');
  if (Object.keys(value).sort().join(',') !== expectedIds) {
    fail('identity_mismatch', `${pathLabel} must record every frozen case digest.`);
  }
  const out = {};
  for (const id of CASE_IDS) {
    out[id] = ownDigest(value[id], `${pathLabel}.${id}`);
  }
  return out;
}

export function parseExecutionManifest(value, pathLabel = 'execution_manifest') {
  if (!isPlainObject(value)) fail('invalid_type', `${pathLabel} must be a JSON object.`);
  if (value.schema !== QUALIFICATION_EXECUTION_SCHEMA_ID) fail('invalid_format', `${pathLabel}.schema`);
  const status = value.status;
  if (status !== 'unrecorded' && status !== 'recorded') {
    fail('invalid_format', `${pathLabel}.status`);
  }
  if (status === 'unrecorded') {
    if (value.candidate != null || value.host != null || value.astra != null) {
      fail('identity_mismatch', 'Unrecorded execution manifest must not invent identities.');
    }
    return { status, recorded: false };
  }
  if (!isPlainObject(value.candidate)) fail('missing_key', `${pathLabel}.candidate`);
  if (!isPlainObject(value.published_3_4_2)) fail('missing_key', `${pathLabel}.published_3_4_2`);
  if (!isPlainObject(value.host)) fail('missing_key', `${pathLabel}.host`);
  if (!isPlainObject(value.astra)) fail('missing_key', `${pathLabel}.astra`);
  if (!isPlainObject(value.approaches)) fail('missing_key', `${pathLabel}.approaches`);
  const hostModel = value.host.host_model;
  if (typeof hostModel !== 'string' || hostModel.length === 0) {
    fail('missing_key', `${pathLabel}.host.host_model`);
  }
  if (hostModel === PLACEHOLDER_HOST_MODEL) {
    fail('identity_mismatch', 'codex-default placeholders are not comparable truth.');
  }
  if (hostModel !== ASTRA_MODEL) {
    fail('identity_mismatch', `Recorded host_model must be the Astra host ${ASTRA_MODEL}.`);
  }
  if (!isPlainObject(value.host.host_settings)) fail('missing_key', `${pathLabel}.host.host_settings`);
  const astra = parseProviderModel(value.astra, `${pathLabel}.astra`, ASTRA_PROVIDER);
  if (astra.model !== ASTRA_MODEL || astra.model !== hostModel) {
    fail('identity_mismatch', `Astra model must be ${ASTRA_MODEL} and match host.host_model.`);
  }
  const candidateSha = ownSha(value.candidate.sha, `${pathLabel}.candidate.sha`);
  if (!Object.hasOwn(value.candidate, 'tree') || value.candidate.tree == null) {
    fail('missing_key', `${pathLabel}.candidate.tree`);
  }
  const candidateTree = ownSha(value.candidate.tree, `${pathLabel}.candidate.tree`);
  const publishedSha = ownSha(value.published_3_4_2.sha, `${pathLabel}.published_3_4_2.sha`);
  if (publishedSha !== PUBLISHED_342_SHA) {
    fail('identity_mismatch', 'published_3_4_2.sha must be the frozen 3.4.2 baseline.');
  }
  if (candidateSha === publishedSha) {
    fail('identity_mismatch', 'Candidate SHA cannot equal published SHA.');
  }
  const providerConfiguration = parseCaseRoutes(
    value.provider_configuration,
    `${pathLabel}.provider_configuration`,
  );
  const approaches = {};
  for (const arm of QUALIFICATION_ARMS) {
    const row = value.approaches[arm];
    if (!isPlainObject(row)) fail('missing_key', `${pathLabel}.approaches.${arm}`);
    if (row.external_jobs !== (arm !== 'native-codex')) {
      fail('identity_mismatch', `${arm} external_jobs must be ${arm !== 'native-codex'}.`);
    }
    if (row.host_model != null && row.host_model !== hostModel) {
      fail('identity_mismatch', `${arm} planned host_model conflicts with host.host_model.`);
    }
    if (row.host_settings != null && settingsDigest(row.host_settings) !== settingsDigest(value.host.host_settings)) {
      fail('identity_mismatch', `${arm} planned host_settings conflict with host.host_settings.`);
    }
    if (arm === 'native-codex') {
      approaches[arm] = {
        external_jobs: false,
        coengineer_source: { kind: 'native', value: 'native-codex' },
      };
    } else {
      const sourceValue = arm === 'published-3.4.2' ? publishedSha : candidateSha;
      const recorded = row.coengineer_source;
      if (recorded != null) {
        if (!isPlainObject(recorded) || recorded.kind !== 'git_commit' || recorded.value !== sourceValue) {
          fail('identity_mismatch', `${arm} coengineer_source conflicts with bound SHA.`);
        }
      }
      approaches[arm] = {
        external_jobs: true,
        coengineer_source: { kind: 'git_commit', value: sourceValue },
      };
    }
  }
  if (Object.keys(value.approaches).sort().join(',') !== [...QUALIFICATION_ARMS].slice().sort().join(',')) {
    fail('identity_mismatch', 'Execution manifest must record exactly the four required approaches.');
  }
  return {
    status: 'recorded',
    recorded: true,
    candidate_sha: candidateSha,
    candidate_tree: candidateTree,
    published_sha: publishedSha,
    host_model: hostModel,
    host_settings: value.host.host_settings,
    astra,
    provider_configuration: providerConfiguration,
    approaches,
    input_digests: parseBoundDigests(value.input_digests, `${pathLabel}.input_digests`),
    check_digests: parseBoundDigests(value.check_digests, `${pathLabel}.check_digests`),
  };
}

function emptyAstraMetric(astra = null) {
  return {
    value: null,
    source: 'unknown',
    trust: 'unknown',
    reported_sum: null,
    reported_count: 0,
    unknown_count: 0,
    unit: 'tokens',
    model: astra?.model ?? null,
    provider: astra?.provider ?? null,
    includes_helpers: false,
    coverage_complete: false,
    reason: 'missing_usage_report',
  };
}

function parseHostUsageModelRow(row, pathLabel) {
  if (!isPlainObject(row)) fail('invalid_type', pathLabel);
  const model = row.model;
  if (typeof model !== 'string' || model.length === 0) {
    fail('invalid_format', `${pathLabel}.model`);
  }
  const parsed = { model };
  for (const key of HOST_MODEL_COUNTERS) {
    parsed[key] = parseOptionalCounter(row[key], `${pathLabel}.${key}`);
  }
  return parsed;
}

function parseHostUsageAttemptRow(entry, pathLabel) {
  if (!isPlainObject(entry)) fail('invalid_type', pathLabel);
  const attemptId = entry.attempt_id;
  if (typeof attemptId !== 'string' || !QUAL_TRIAL_ID.test(attemptId)) {
    fail('invalid_format', `${pathLabel}.attempt_id`);
  }
  const byModelInput = Array.isArray(entry.by_model) ? entry.by_model : [];
  const parsed = {
    attempt_id: attemptId,
    session_id: typeof entry.session_id === 'string' ? entry.session_id : null,
    compaction_events: parseOptionalCounter(entry.compaction_events, `${pathLabel}.compaction_events`),
    by_model: byModelInput.map((row, rowIndex) => (
      parseHostUsageModelRow(row, `${pathLabel}.by_model[${rowIndex}]`)
    )),
  };
  for (const key of HOST_USAGE_COUNTERS) {
    parsed[key] = parseOptionalCounter(entry[key], `${pathLabel}.${key}`);
  }
  return parsed;
}

function reconcileHostUsageAttempt(row, trialAttempt) {
  const reasons = [];
  const seenModels = new Set();
  for (const entry of row.by_model) {
    if (seenModels.has(entry.model)) {
      reasons.push(`duplicate_model:${row.attempt_id}:${entry.model}`);
    }
    seenModels.add(entry.model);
  }
  const uniqueModels = seenModels.size === row.by_model.length;
  if (uniqueModels) {
    for (const key of HOST_USAGE_COUNTERS) {
      const summed = sumModelCounter(row.by_model, key);
      if (row[key] !== summed) reasons.push(`by_model_sum:${row.attempt_id}:${key}`);
    }
  }
  if (trialAttempt != null) {
    if (row.input_tokens !== trialAttempt.usage.native_input_tokens.value) {
      reasons.push(`native_usage:${row.attempt_id}:native_input_tokens`);
    }
    if (row.output_tokens !== trialAttempt.usage.native_output_tokens.value) {
      reasons.push(`native_usage:${row.attempt_id}:native_output_tokens`);
    }
  }
  return reasons;
}

function reconcileHostUsageReport(report, claimedTrialDigest, computedTrialDigest) {
  const reasons = [];
  if (claimedTrialDigest == null || claimedTrialDigest !== computedTrialDigest) {
    reasons.push('trial_digest');
  }
  const trialAttempts = new Map(report.trial.attempts.map((attempt) => [attempt.attempt_id, attempt]));
  const seenAttemptIds = new Set();
  const totals = report.breakdown.totals;
  const summedTotals = Object.fromEntries(HOST_USAGE_COUNTERS.map((key) => [key, 0]));
  let compactionSum = 0;
  let totalsMeasurable = true;
  for (const row of report.breakdown.attempts) {
    if (seenAttemptIds.has(row.attempt_id)) reasons.push(`duplicate_attempt_id:${row.attempt_id}`);
    seenAttemptIds.add(row.attempt_id);
    const trialAttempt = trialAttempts.get(row.attempt_id);
    if (trialAttempt == null) reasons.push(`extra_attempt:${row.attempt_id}`);
    reasons.push(...reconcileHostUsageAttempt(row, trialAttempt));
    for (const key of HOST_USAGE_COUNTERS) {
      if (row[key] == null || summedTotals[key] == null) {
        summedTotals[key] = null;
        totalsMeasurable = false;
      } else {
        summedTotals[key] += row[key];
      }
    }
    if (row.compaction_events == null) compactionSum = null;
    else if (compactionSum != null) compactionSum += row.compaction_events;
  }
  for (const attempt of report.trial.attempts) {
    if (!seenAttemptIds.has(attempt.attempt_id)) reasons.push(`missing_attempt:${attempt.attempt_id}`);
  }
  const totalsPresent = HOST_USAGE_COUNTERS.some((key) => totals[key] != null)
    || totals.compaction_events != null;
  if (totalsPresent && totalsMeasurable) {
    for (const key of HOST_USAGE_COUNTERS) {
      if (totals[key] !== summedTotals[key]) reasons.push(`totals:${key}`);
    }
    if (totals.compaction_events != null && totals.compaction_events !== compactionSum) {
      reasons.push('totals:compaction_events');
    }
  }
  return [...new Set(reasons)];
}

export function parseHostUsageReport(value, pathLabel = 'usage_report') {
  if (!isPlainObject(value)) fail('invalid_type', `${pathLabel} must be a JSON object.`);
  if (value.schema !== HOST_USAGE_REPORT_SCHEMA_ID) fail('invalid_format', `${pathLabel}.schema`);
  const status = value.status;
  if (status !== 'complete' && status !== 'inconclusive') {
    fail('invalid_format', `${pathLabel}.status`);
  }
  const computedTrialDigest = isPlainObject(value.trial) ? hostUsageTrialDigest(value.trial) : null;
  const trial = parseQualificationTrial(value.trial, `${pathLabel}.trial`);
  const breakdown = value.breakdown;
  if (!isPlainObject(breakdown) || !Array.isArray(breakdown.attempts)) {
    fail('invalid_format', `${pathLabel}.breakdown.attempts`);
  }
  const attempts = breakdown.attempts.map((entry, index) => (
    parseHostUsageAttemptRow(entry, `${pathLabel}.breakdown.attempts[${index}]`)
  ));
  const evidence = isPlainObject(value.evidence) ? value.evidence : {};
  const digests = isPlainObject(evidence.digests) ? evidence.digests : {};
  const claimedTrialDigest = typeof digests.trial === 'string' && SHA256.test(digests.trial)
    ? digests.trial
    : null;
  const incompletePrimary = evidence.incomplete_primary_evidence === true || status !== 'complete';
  const parsed = {
    schema: HOST_USAGE_REPORT_SCHEMA_ID,
    status,
    trial,
    breakdown: {
      attempts,
      totals: isPlainObject(breakdown.totals) ? breakdown.totals : {},
      accounting: isPlainObject(breakdown.accounting) ? breakdown.accounting : {},
    },
    evidence: {
      digests: {
        manifest: typeof digests.manifest === 'string' ? digests.manifest : null,
        sessions: isPlainObject(digests.sessions) ? digests.sessions : {},
        links: Array.isArray(digests.links) ? digests.links : [],
        trial: claimedTrialDigest,
      },
      notes: Array.isArray(evidence.notes) ? evidence.notes : [],
      incomplete_primary_evidence: incompletePrimary,
      trial_digest_verified: claimedTrialDigest != null && claimedTrialDigest === computedTrialDigest,
    },
    measured_numbers_retained: true,
    bound_mismatch: null,
  };
  parsed.integrity = {
    reasons: reconcileHostUsageReport(parsed, claimedTrialDigest, computedTrialDigest),
  };
  parsed.integrity.ok = parsed.integrity.reasons.length === 0;
  return parsed;
}

function reportMatchesTrial(report, trial) {
  if (canonicalJsonStringify(report.trial) !== canonicalJsonStringify(trial)) {
    return 'canonical_trial';
  }
  return null;
}

function astraOutputFromReport(report, astra, trial) {
  const empty = {
    value: null,
    includesHelpers: false,
    observed: false,
    coverageComplete: false,
    untrusted: true,
  };
  if (astra == null || typeof astra.model !== 'string') return empty;
  if (report.bound_mismatch) return empty;
  const duplicateAttempts = report.integrity.reasons.some((reason) => reason.startsWith('duplicate_attempt_id:'));
  const duplicateModels = report.integrity.reasons.some((reason) => reason.startsWith('duplicate_model:'));
  if (duplicateAttempts || duplicateModels) return empty;

  const byAttemptId = new Map();
  for (const row of report.breakdown.attempts) {
    if (byAttemptId.has(row.attempt_id)) return empty;
    byAttemptId.set(row.attempt_id, row);
  }

  let sum = 0;
  let observed = false;
  let includesHelpers = false;
  let coverageComplete = report.integrity.ok && report.status === 'complete'
    && report.evidence.incomplete_primary_evidence !== true;
  let untrusted = false;

  for (const attempt of trial.attempts) {
    const row = byAttemptId.get(attempt.attempt_id);
    if (row == null) {
      coverageComplete = false;
      continue;
    }
    const rowReasons = report.integrity.reasons.filter((reason) => reason.includes(`:${attempt.attempt_id}:`)
      || reason === `extra_attempt:${attempt.attempt_id}`
      || reason === `duplicate_attempt_id:${attempt.attempt_id}`
      || reason === `missing_attempt:${attempt.attempt_id}`);
    const rowUntrusted = rowReasons.some((reason) => (
      reason.startsWith('by_model_sum:')
      || reason.startsWith('native_usage:')
      || reason.startsWith('duplicate_model:')
      || reason.startsWith('duplicate_attempt_id:')
    ));
    if (rowUntrusted) {
      untrusted = true;
      coverageComplete = false;
      continue;
    }
    const matching = row.by_model.filter((entry) => entry.model === astra.model);
    if (matching.length === 0) continue;
    let attemptSum = 0;
    let missing = false;
    for (const entry of matching) {
      if (entry.output_tokens == null) {
        missing = true;
        break;
      }
      attemptSum += entry.output_tokens;
    }
    if (missing) {
      coverageComplete = false;
      continue;
    }
    sum += attemptSum;
    observed = true;
    if (attempt.kind === 'native_helper') includesHelpers = true;
  }
  for (const attemptId of byAttemptId.keys()) {
    if (!trial.attempts.some((attempt) => attempt.attempt_id === attemptId)) {
      coverageComplete = false;
      untrusted = true;
    }
  }
  if (untrusted && !observed) {
    return { value: null, includesHelpers, observed: false, coverageComplete: false, untrusted: true };
  }
  return {
    value: observed ? sum : null,
    includesHelpers,
    observed,
    coverageComplete: coverageComplete && !untrusted && observed,
    untrusted,
  };
}

function accountAstraOwnNativeOutput(trials, astra, reportsByTrialId) {
  const result = emptyAstraMetric(astra);
  if (astra == null || trials.length === 0) return result;
  let sum = 0;
  let known = 0;
  let unknown = 0;
  let includesHelpers = false;
  let coverageComplete = true;
  for (const trial of trials) {
    const report = reportsByTrialId.get(trial.trial_id);
    if (report == null) {
      unknown += 1;
      coverageComplete = false;
      continue;
    }
    if (report.status !== 'complete'
      || report.evidence.incomplete_primary_evidence === true
      || report.integrity.ok !== true
      || report.bound_mismatch) {
      coverageComplete = false;
    }
    const observed = astraOutputFromReport(report, astra, trial);
    if (observed.untrusted && !observed.observed) {
      unknown += 1;
      coverageComplete = false;
      continue;
    }
    if (!observed.coverageComplete) coverageComplete = false;
    if (!observed.observed || observed.value == null) {
      unknown += 1;
      continue;
    }
    sum += observed.value;
    known += 1;
    if (observed.includesHelpers) includesHelpers = true;
  }
  result.reported_sum = known > 0 ? sum : null;
  result.reported_count = known;
  result.unknown_count = unknown;
  result.includes_helpers = includesHelpers;
  result.coverage_complete = coverageComplete && unknown === 0 && known === trials.length;
  if (known > 0) {
    result.value = sum;
    result.source = 'host_measured';
    result.trust = result.coverage_complete ? 'host_authoritative' : 'unknown';
  }
  if (!coverageComplete || unknown > 0 || !result.coverage_complete) {
    result.reason = 'incomplete_primary_coverage';
  } else {
    result.reason = 'observed_native_model';
  }
  return result;
}

export function accountArm(trials, astra = null, reportsByTrialId = new Map()) {
  const aggregated = aggregateTrials(trials);
  let missingPrimary = 0;
  for (const trial of trials) {
    if (trial.accepted !== true && trial.accepted !== false) missingPrimary += 1;
  }
  return {
    ...aggregated,
    missing_primary_count: missingPrimary,
    astra_own_native_output: accountAstraOwnNativeOutput(trials, astra, reportsByTrialId),
  };
}

function median(values) {
  if (values.length === 0 || values.some((value) => value == null || Number.isNaN(value))) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function ratio(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

function comparableMismatch(trial, caseRecord, manifest, arm) {
  if (trial.case_id !== caseRecord.id) return 'case_mismatch';
  if (trial.input_digest !== caseRecord.input_digest) return 'input_digest_mismatch';
  if (caseRecord.base_sha != null && trial.base_sha !== caseRecord.base_sha) return 'base_sha_mismatch';
  if (trial.host_model !== manifest.host_model) return 'host_model_mismatch';
  if (settingsDigest(trial.host_settings) !== settingsDigest(manifest.host_settings)) {
    return 'host_settings_mismatch';
  }
  if (trial.host_model === PLACEHOLDER_HOST_MODEL) return 'placeholder_host_model';
  const expectedSource = manifest.approaches[arm].coengineer_source;
  if (trial.coengineer_source.kind !== expectedSource.kind || trial.coengineer_source.value !== expectedSource.value) {
    return 'source_mismatch';
  }
  if (COENGINEER_ARMS.includes(arm)) {
    const expectedRoute = manifest.provider_configuration[caseRecord.id];
    if (expectedRoute == null) return 'provider_configuration_mismatch';
    if (settingsDigest(trial.provider_configuration) !== settingsDigest(expectedRoute)) {
      return 'provider_configuration_mismatch';
    }
  }
  return null;
}

function indexUsageReports(usageReports, parsedTrials, mark) {
  const reportsByTrialId = new Map();
  if (usageReports == null) return reportsByTrialId;
  if (!Array.isArray(usageReports)) fail('invalid_type', 'usage_reports must be an array.');
  const trialById = new Map(parsedTrials.map((trial) => [trial.trial_id, trial]));
  for (let index = 0; index < usageReports.length; index += 1) {
    const report = parseHostUsageReport(usageReports[index], `usage_reports[${index}]`);
    if (reportsByTrialId.has(report.trial.trial_id)) {
      fail('duplicate_id', `duplicate usage report for ${report.trial.trial_id}`);
    }
    const trial = trialById.get(report.trial.trial_id);
    if (trial == null) {
      mark('inconclusive', `usage_report_unknown_trial:${report.trial.trial_id}`);
      reportsByTrialId.set(report.trial.trial_id, report);
      continue;
    }
    const mismatch = reportMatchesTrial(report, trial);
    report.bound_mismatch = mismatch;
    if (mismatch) {
      mark('inconclusive', `usage_report_mismatch:${report.trial.trial_id}:${mismatch}`);
    }
    if (report.integrity.ok !== true) {
      mark(
        'inconclusive',
        `usage_report_inconsistent:${report.trial.trial_id}:${report.integrity.reasons[0]}`,
      );
    }
    reportsByTrialId.set(report.trial.trial_id, report);
  }
  return reportsByTrialId;
}

export function evaluateQualificationCohort({
  protocol,
  cases,
  trials,
  executionManifest,
  usageReports = null,
}) {
  const parsedProtocol = protocol ?? protocolRecord();
  if (!Array.isArray(parsedProtocol.approaches)
    || parsedProtocol.approaches.join(',') !== QUALIFICATION_ARMS.join(',')) {
    fail('identity_mismatch', 'Qualification protocol must require all four approaches.');
  }
  if (parsedProtocol.arms?.optional?.length) {
    fail('identity_mismatch', 'Qualification protocol must not inherit OPTIONAL_ARMS.');
  }
  const manifest = parseExecutionManifest(executionManifest);
  const schedule = generateSchedule();
  if (schedule.trial_count !== 24 || new Set(schedule.canonical.map((row) => row.trial_id)).size !== 24) {
    fail('identity_mismatch', 'Planned identities must be exactly 24 unique trial ids.');
  }
  const parsedCases = cases.map((entry) => parseQualificationCase(entry));
  const reasons = [];
  let decision = 'pass';
  function mark(status, reason) {
    reasons.push(reason);
    if (status === 'inconclusive') {
      if (decision !== 'inconclusive') decision = 'inconclusive';
    } else if (status === 'fail' && decision === 'pass') {
      decision = 'fail';
    }
  }

  if (!manifest.recorded) {
    mark('inconclusive', 'execution_manifest_unrecorded');
    return {
      schema: 'codex-co-engineer.qualification-cohort.v1',
      decision: 'inconclusive',
      reasons,
      planned_identities: 24,
      compared_identities: 0,
    };
  }
  for (const caseRecord of parsedCases) {
    const expectedInput = manifest.input_digests[caseRecord.id];
    const expectedCheck = manifest.check_digests[caseRecord.id];
    if (expectedInput !== caseRecord.input_digest) mark('inconclusive', `input_digest_mismatch:${caseRecord.id}`);
    if (expectedCheck !== caseRecord.check_digest) mark('inconclusive', `check_digest_mismatch:${caseRecord.id}`);
  }

  const parsedTrials = trials.map((entry, index) => parseQualificationTrial(entry, `trials[${index}]`));
  const byId = new Map(parsedTrials.map((trial) => [trial.trial_id, trial]));
  if (byId.size !== parsedTrials.length) fail('duplicate_id', 'duplicate trial_id');
  const reportsByTrialId = indexUsageReports(usageReports, parsedTrials, mark);

  const matchedByKey = new Map();
  const taskRows = [];
  let comparedIdentities = 0;
  let omitted = 0;
  let mismatched = 0;
  let missingEvidence = 0;

  for (const caseRecord of parsedCases) {
    const arms = {};
    for (const arm of QUALIFICATION_ARMS) {
      const planned = schedule.canonical.filter((row) => row.case_id === caseRecord.id && row.arm === arm);
      const matched = [];
      const unmatched = [];
      for (const plan of planned) {
        const trial = byId.get(plan.trial_id);
        if (trial == null) {
          omitted += 1;
          unmatched.push({ trial_id: plan.trial_id, reason: 'omitted_arm_or_trial' });
          mark('inconclusive', `omitted:${plan.trial_id}`);
          continue;
        }
        const mismatch = comparableMismatch(trial, caseRecord, manifest, arm);
        if (mismatch) {
          mismatched += 1;
          unmatched.push({ trial_id: plan.trial_id, reason: mismatch });
          mark('inconclusive', `mismatch:${plan.trial_id}:${mismatch}`);
          continue;
        }
        if (trial.accepted !== true && trial.accepted !== false) {
          missingEvidence += 1;
          mark('inconclusive', `missing_acceptance:${plan.trial_id}`);
        }
        if (trial.wall_elapsed_ms?.value == null) {
          missingEvidence += 1;
          mark('inconclusive', `missing_primary:${plan.trial_id}`);
        }
        const trialCorrections = trial.attempts.filter((attempt) => attempt.kind === 'correction').length;
        if (trialCorrections > MAX_CORRECTIONS) {
          mark('fail', `too_many_corrections:${plan.trial_id}`);
        }
        if (trial.wall_elapsed_ms?.value != null && trial.wall_elapsed_ms.value > TRIAL_DEADLINE_MS) {
          mark('fail', `deadline_exceeded:${plan.trial_id}`);
        }
        const report = reportsByTrialId.get(plan.trial_id);
        if (report == null) {
          missingEvidence += 1;
          mark('inconclusive', `missing_usage_report:${plan.trial_id}`);
        } else if (report.status !== 'complete' || report.evidence.incomplete_primary_evidence === true) {
          missingEvidence += 1;
          mark('inconclusive', `usage_report_inconclusive:${plan.trial_id}`);
        }
        matched.push(trial);
        matchedByKey.set(`${plan.case_id}:${plan.arm}:${plan.rep}`, trial);
        comparedIdentities += 1;
      }
      arms[arm] = {
        arm,
        status: matched.length === planned.length && unmatched.length === 0 ? 'compared' : (planned.length === unmatched.length && matched.length === 0 ? 'omitted' : 'partial'),
        unmatched,
        ...accountArm(matched, manifest.astra, reportsByTrialId),
      };
    }
    taskRows.push({
      case_id: caseRecord.id,
      input_digest: caseRecord.input_digest,
      base_sha: caseRecord.base_sha,
      arms,
    });
  }

  const candidateAccepted = taskRows.reduce((sum, row) => sum + row.arms['candidate-3.4.3'].accepted_count, 0);
  const candidateKnown = taskRows.reduce((sum, row) => sum + row.arms['candidate-3.4.3'].accepted_known_count, 0);
  const candidateTrials = taskRows.reduce((sum, row) => sum + row.arms['candidate-3.4.3'].trial_count, 0);

  const taskNativeRatios = [];
  const taskPublishedRatios = [];
  const taskOverheadRatios = [];
  const trialTurnaroundRatios = [];
  let pooledCandidateNumerator = 0;
  let pooledCandidateAccepted = 0;
  let pooledNativeNumerator = 0;
  let pooledNativeAccepted = 0;

  for (const row of taskRows) {
    const candidate = row.arms['candidate-3.4.3'].usage_per_accepted_result.native_output_tokens;
    const native = row.arms['native-codex'].usage_per_accepted_result.native_output_tokens;
    const published = row.arms['published-3.4.2'].usage_per_accepted_result.native_output_tokens;
    const direct = row.arms['direct-delegation'].usage_per_accepted_result.native_output_tokens;
    taskNativeRatios.push(ratio(candidate.value, native.value));
    taskPublishedRatios.push(ratio(candidate.value, published.value));
    taskOverheadRatios.push(ratio(candidate.value, direct.value));
    if (candidate.numerator != null && native.numerator != null) {
      pooledCandidateNumerator += candidate.numerator;
      pooledCandidateAccepted += candidate.known_accepted_count;
      pooledNativeNumerator += native.numerator;
      pooledNativeAccepted += native.known_accepted_count;
    }
    for (let rep = 1; rep <= REPETITIONS; rep += 1) {
      const candidateTrial = matchedByKey.get(`${row.case_id}:candidate-3.4.3:${rep}`);
      const nativeTrial = matchedByKey.get(`${row.case_id}:native-codex:${rep}`);
      const candidateWall = candidateTrial?.wall_elapsed_ms?.value ?? null;
      const nativeWall = nativeTrial?.wall_elapsed_ms?.value ?? null;
      trialTurnaroundRatios.push(ratio(candidateWall, nativeWall));
    }
  }

  const taskMedianVsNative = median(taskNativeRatios);
  const taskMedianVsPublished = median(taskPublishedRatios);
  const pooledVsNative = ratio(
    pooledCandidateAccepted === 0 ? null : pooledCandidateNumerator / pooledCandidateAccepted,
    pooledNativeAccepted === 0 ? null : pooledNativeNumerator / pooledNativeAccepted,
  );
  const medianTurnaround = median(trialTurnaroundRatios);
  const nativeOverhead = median(taskOverheadRatios);

  let astraCandidate = 0;
  let astraPublished = 0;
  let astraMeasured = false;
  let astraCoverageComplete = true;
  for (const row of taskRows) {
    const cand = row.arms['candidate-3.4.3'].astra_own_native_output;
    const pub = row.arms['published-3.4.2'].astra_own_native_output;
    if (cand.coverage_complete !== true || pub.coverage_complete !== true) astraCoverageComplete = false;
    if (cand.value != null) {
      astraCandidate += cand.value;
      astraMeasured = true;
    }
    if (pub.value != null) {
      astraPublished += pub.value;
      astraMeasured = true;
    }
    if (cand.value == null || pub.value == null) astraCoverageComplete = false;
  }

  for (const arm of QUALIFICATION_ARMS) {
    const count = taskRows.reduce((sum, row) => sum + row.arms[arm].trial_count, 0);
    if (count !== 6) mark('inconclusive', `arm_count_not_6:${arm}`);
  }
  if (candidateTrials !== 6 || candidateKnown !== 6) {
    mark('inconclusive', 'candidate_acceptance_coverage_incomplete');
  } else if (candidateAccepted !== 6) {
    mark('fail', 'candidate_not_6_of_6_accepted');
  }
  if (taskMedianVsNative == null) mark('inconclusive', 'task_median_vs_native_unknown');
  else if (taskMedianVsNative > 0.5) mark('fail', 'task_median_vs_native_exceeds_0.5');
  if (taskMedianVsPublished == null) mark('inconclusive', 'task_median_vs_published_unknown');
  else if (taskMedianVsPublished > 0.75) mark('fail', 'task_median_vs_published_exceeds_0.75');
  if (!astraCoverageComplete) mark('inconclusive', 'astra_own_output_unknown');
  else if (!(astraCandidate < astraPublished)) mark('fail', 'astra_own_output_did_not_decrease');
  if (medianTurnaround == null) mark('inconclusive', 'median_turnaround_unknown');
  else if (medianTurnaround > 2) mark('fail', 'median_turnaround_exceeds_2x_native');
  if (nativeOverhead == null) mark('inconclusive', 'native_overhead_unknown');
  else if (nativeOverhead > 1.25) mark('fail', 'native_overhead_exceeds_1.25x_direct');

  const uniqueUnknown = parsedTrials.filter((trial) => !schedule.canonical.some((row) => row.trial_id === trial.trial_id));
  if (uniqueUnknown.length > 0) mark('inconclusive', 'unknown_trial_identity');

  return {
    schema: 'codex-co-engineer.qualification-cohort.v1',
    version: 1,
    decision,
    reasons,
    planned_identities: 24,
    compared_identities: comparedIdentities,
    omitted,
    mismatched,
    missing_evidence: missingEvidence,
    candidate_accepted: `${candidateAccepted}/${candidateTrials}`,
    thresholds: freezeThresholds(),
    metrics: {
      task_median_native_output_per_accepted_vs_native: taskMedianVsNative,
      task_median_native_output_per_accepted_vs_published: taskMedianVsPublished,
      pooled_native_output_per_accepted_vs_native: pooledVsNative,
      astra_own_native_output: {
        candidate: astraMeasured ? astraCandidate : null,
        published: astraMeasured ? astraPublished : null,
        decreased: astraCoverageComplete ? astraCandidate < astraPublished : null,
        coverage_complete: astraCoverageComplete,
      },
      median_turnaround_vs_native: medianTurnaround,
      median_turnaround_reduction: TURNAROUND_REDUCTION,
      native_overhead_vs_direct: nativeOverhead,
      native_overhead_reduction: OVERHEAD_REDUCTION,
      astra_own_output_reduction: ASTRA_REDUCTION,
    },
    cases: taskRows,
  };
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
  if (Object.hasOwn(protocol, 'candidate_sha')) {
    fail('stale_identity', 'Tracked protocol must not bind a future candidate SHA.');
  }
  if (protocol.arms.required.join(',') !== QUALIFICATION_ARMS.join(',') || protocol.arms.optional.length !== 0) {
    fail('identity_mismatch', 'All four approaches are required; OPTIONAL_ARMS must not be inherited.');
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const expected = generateSchedule();
  if (JSON.stringify(manifest.schedule) !== JSON.stringify(expected.ordered)) {
    fail('identity_mismatch', 'Operator schedule does not match seed 43 ordering.');
  }
  if (Object.hasOwn(manifest, 'candidate_sha')) {
    fail('stale_identity', 'Operator manifest must not bind a future candidate SHA.');
  }
  const precollection = JSON.parse(await readFile(PRECOLLECTION_PATH, 'utf8'));
  parseExecutionManifest(precollection);
  if (precollection.status !== 'unrecorded') {
    fail('identity_mismatch', 'Tracked precollection manifest must remain unrecorded.');
  }
  return {
    valid: true,
    case_count: packed.raw.length,
    ids: packed.raw.map((entry) => entry.id),
    input_digests: Object.fromEntries(packed.raw.map((entry) => [entry.id, entry.input_digest])),
    check_digests: Object.fromEntries(packed.raw.map((entry) => [entry.id, entry.check_digest])),
    base_shas: Object.fromEntries(packed.raw.map((entry) => [entry.id, entry.base_sha])),
    source_shas: Object.fromEntries(packed.raw.map((entry) => [entry.id, entry.source_sha])),
    status: 'unrun',
    live_jobs: 'not_implemented',
    planned_identities: 24,
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
  node scripts/prepare-coengineer-qualification.mjs --evaluate-cohort --trials FILE --execution-manifest FILE

Non-provider helper. Live provider jobs are not implemented. Paid repeated
trials require --live --paid-budget and are still not executed. Destination
directories must be empty. Host Astra settings are recorded in an external
execution manifest before collection. Never invent backend IDs.
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
        source_sha: entry.source_sha,
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
  if (flags['--evaluate-cohort']) {
    if (flags['--trials'] == null || flags['--execution-manifest'] == null) {
      io.stderr.write('Missing --trials FILE and/or --execution-manifest FILE.\n');
      return 2;
    }
    const packed = await loadQualificationCases();
    const trialsJson = JSON.parse(await readFile(path.resolve(flags['--trials']), 'utf8'));
    const trials = Array.isArray(trialsJson) ? trialsJson : trialsJson.trials;
    const usageReports = Array.isArray(trialsJson) ? null : (trialsJson.usage_reports ?? null);
    const executionManifest = JSON.parse(await readFile(path.resolve(flags['--execution-manifest']), 'utf8'));
    const comparison = evaluateQualificationCohort({
      protocol: protocolRecord(),
      cases: packed.raw,
      trials,
      executionManifest,
      usageReports,
    });
    io.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    if (comparison.decision === 'pass') return 0;
    if (comparison.decision === 'fail') return 1;
    return 2;
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
