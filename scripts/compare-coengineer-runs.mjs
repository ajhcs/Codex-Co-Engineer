#!/usr/bin/env node
// Offline comparison of sanitized Co-Engineer trial records against frozen
// benchmark cases. Live provider jobs are not implemented. Paid repeated
// trials remain opt-in and must not run from CI.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonStringify } from '../plugins/codex-co-engineer/mcp/v3/identity.mjs';

export const PROTOCOL_SCHEMA_ID = 'codex-co-engineer.benchmark-protocol.v1';
export const CASE_SCHEMA_ID = 'codex-co-engineer.benchmark-case.v1';
export const TRIAL_SCHEMA_ID = 'codex-co-engineer.benchmark-trial.v1';
export const COMPARISON_SCHEMA_ID = 'codex-co-engineer.benchmark-comparison.v1';
export const REQUIRED_ARMS = Object.freeze(['native-codex', 'published-3.4.2', 'candidate-3.4.3']);
export const OPTIONAL_ARMS = Object.freeze(['direct-delegation']);
export const ALL_ARMS = Object.freeze([...REQUIRED_ARMS, ...OPTIONAL_ARMS]);
export const COENGINEER_ARMS = Object.freeze(['published-3.4.2', 'candidate-3.4.3', 'direct-delegation']);
export const ATTEMPT_KINDS = Object.freeze(['initial', 'correction', 'native_helper']);
export const ATTEMPT_OUTCOMES = Object.freeze([
  'accepted', 'completed_unaccepted', 'failed', 'uncertain', 'unfinal',
]);
export const METRIC_KEYS = Object.freeze([
  'native_input_tokens', 'native_output_tokens', 'native_helper_calls',
  'correction_rounds', 'elapsed_ms', 'provider_input_tokens', 'provider_output_tokens',
  'provider_cost_millicents', 'model_facing_bytes', 'evidence_bytes',
]);
export const BYTE_METRICS = Object.freeze(['model_facing_bytes', 'evidence_bytes']);
export const PROVIDER_METRICS = Object.freeze([
  'provider_input_tokens', 'provider_output_tokens', 'provider_cost_millicents',
]);
export const USAGE_SOURCES = Object.freeze(['evidence_bytes', 'host_measured', 'provider_report', 'unknown']);
export const USAGE_TRUST = Object.freeze(['host_authoritative', 'provider_untrusted', 'unknown']);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA40 = /^[0-9a-f]{40}$/u;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const MAX_ATTEMPTS = 32;
const MAX_TRIALS = 256;
const MAX_CASES = 32;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlain(value, pathLabel) {
  if (!isPlainObject(value)) fail('invalid_type', `${pathLabel} must be a JSON object.`);
  return value;
}

function ownString(object, key, pathLabel, pattern = null) {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_format', `${pathLabel}.${key} must be a non-empty string.`);
  }
  if (pattern && !pattern.test(value)) {
    fail('invalid_format', `${pathLabel}.${key} is not an allowed identifier.`);
  }
  return value;
}

function ownBoolean(object, key, pathLabel) {
  const value = object[key];
  if (value !== true && value !== false) fail('invalid_type', `${pathLabel}.${key} must be a boolean.`);
  return value;
}

function metricUnit(key) {
  if (BYTE_METRICS.includes(key)) return 'bytes';
  if (key === 'elapsed_ms') return 'milliseconds';
  if (key === 'provider_cost_millicents') return 'millicents';
  if (key.endsWith('_tokens')) return 'tokens';
  return 'count';
}

function metricSourceExpected(key) {
  if (PROVIDER_METRICS.includes(key)) return 'provider_report';
  if (key === 'evidence_bytes') return 'evidence_bytes';
  return 'host_measured';
}

export function parseUsageMetric(value, pathLabel, key) {
  if (value == null) {
    return { value: null, source: 'unknown', trust: 'unknown', unit: metricUnit(key) };
  }
  const metric = assertPlain(value, pathLabel);
  const source = metric.source;
  const trust = metric.trust;
  if (!USAGE_SOURCES.includes(source) || !USAGE_TRUST.includes(trust)) {
    fail('invalid_format', `${pathLabel} has an unknown source or trust.`);
  }
  if (metric.value === null) {
    if (source !== 'unknown' || trust !== 'unknown') {
      fail('identity_mismatch', `${pathLabel} unknown usage must not hide a recorded value.`);
    }
    return { value: null, source: 'unknown', trust: 'unknown', unit: metricUnit(key) };
  }
  if (!Number.isSafeInteger(metric.value) || metric.value < 0) {
    fail('out_of_range', `${pathLabel}.value must be a non-negative safe integer.`);
  }
  if (source === 'unknown' || trust === 'unknown') {
    fail('identity_mismatch', `${pathLabel} recorded values cannot be marked unknown.`);
  }
  const expected = metricSourceExpected(key);
  if (source !== expected) {
    fail('forged_provider_usage', `${pathLabel} mixes provider-reported and host-measured authority.`);
  }
  return { value: metric.value, source, trust, unit: metricUnit(key) };
}

function parseAttemptUsage(value, pathLabel) {
  const usage = value == null ? {} : assertPlain(value, pathLabel);
  const parsed = {};
  for (const key of Object.keys(usage)) {
    if (!METRIC_KEYS.includes(key)) fail('unknown_key', `${pathLabel}.${key}`);
  }
  for (const key of METRIC_KEYS) {
    parsed[key] = parseUsageMetric(usage[key], `${pathLabel}.${key}`, key);
  }
  return parsed;
}

function parseAttempt(value, pathLabel) {
  const attempt = assertPlain(value, pathLabel);
  const kind = ownString(attempt, 'kind', pathLabel);
  if (!ATTEMPT_KINDS.includes(kind)) fail('invalid_format', `${pathLabel}.kind`);
  const outcome = ownString(attempt, 'outcome', pathLabel);
  if (!ATTEMPT_OUTCOMES.includes(outcome)) fail('invalid_format', `${pathLabel}.outcome`);
  return {
    attempt_id: ownString(attempt, 'attempt_id', pathLabel, ID_PATTERN),
    kind,
    outcome,
    usage: parseAttemptUsage(attempt.usage, `${pathLabel}.usage`),
  };
}

function monotoneOrEqual(previous, next) {
  for (const key of METRIC_KEYS) {
    const left = previous.usage[key];
    const right = next.usage[key];
    if (left.source === 'unknown' && right.source === 'unknown') continue;
    if (left.source === 'unknown' && right.source !== 'unknown') continue;
    if (left.source !== 'unknown' && right.source === 'unknown') return false;
    if (left.source !== right.source || left.trust !== right.trust) return false;
    if (right.value < left.value) return false;
  }
  return true;
}

function dedupeAttempts(attempts, pathLabel) {
  const latest = new Map();
  const replaced = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const previous = latest.get(attempt.attempt_id);
    if (!previous) {
      latest.set(attempt.attempt_id, attempt);
      continue;
    }
    if (previous.kind !== attempt.kind) {
      fail('duplicate_attempt_id', `${pathLabel} duplicate attempt_id ${attempt.attempt_id} has conflicting kinds.`);
    }
    if (!monotoneOrEqual(previous, attempt)) {
      fail('duplicate_attempt_id', `${pathLabel} duplicate attempt_id ${attempt.attempt_id} is not a cumulative snapshot.`);
    }
    latest.set(attempt.attempt_id, attempt);
    replaced.push(attempt.attempt_id);
  }
  return { attempts: [...latest.values()], cumulative_replaced: replaced };
}

export function parseTrial(value, pathLabel = 'trial') {
  const trial = assertPlain(value, pathLabel);
  if (trial.schema !== TRIAL_SCHEMA_ID) fail('invalid_format', `${pathLabel}.schema`);
  const arm = ownString(trial, 'arm', pathLabel);
  if (!ALL_ARMS.includes(arm)) fail('invalid_format', `${pathLabel}.arm`);
  const attemptsInput = trial.attempts;
  if (!Array.isArray(attemptsInput) || attemptsInput.length < 1 || attemptsInput.length > MAX_ATTEMPTS) {
    fail('bounds_exceeded', `${pathLabel}.attempts`);
  }
  const parsedAttempts = attemptsInput.map((entry, index) => parseAttempt(entry, `${pathLabel}.attempts[${index}]`));
  const deduped = dedupeAttempts(parsedAttempts, pathLabel);
  const accepted = Object.hasOwn(trial, 'accepted') ? ownBoolean(trial, 'accepted', pathLabel) : null;
  return {
    schema: TRIAL_SCHEMA_ID,
    trial_id: ownString(trial, 'trial_id', pathLabel, ID_PATTERN),
    case_id: ownString(trial, 'case_id', pathLabel, ID_PATTERN),
    arm,
    base_sha: ownString(trial, 'base_sha', pathLabel, SHA40),
    host_model: ownString(trial, 'host_model', pathLabel),
    host_settings: assertPlain(trial.host_settings, `${pathLabel}.host_settings`),
    provider_configuration: assertPlain(
      trial.provider_configuration,
      `${pathLabel}.provider_configuration`,
    ),
    accepted,
    attempts: deduped.attempts,
    cumulative_replaced: deduped.cumulative_replaced,
  };
}

export function parseCase(value, pathLabel = 'case') {
  const record = assertPlain(value, pathLabel);
  if (record.schema !== CASE_SCHEMA_ID) fail('invalid_format', `${pathLabel}.schema`);
  const comparable = assertPlain(record.comparable, `${pathLabel}.comparable`);
  return {
    schema: CASE_SCHEMA_ID,
    id: ownString(record, 'id', pathLabel, ID_PATTERN),
    title: ownString(record, 'title', pathLabel),
    summary: ownString(record, 'summary', pathLabel),
    base_sha: ownString(record, 'base_sha', pathLabel, SHA40),
    comparable: {
      host_model: ownString(comparable, 'host_model', `${pathLabel}.comparable`),
      host_settings: assertPlain(comparable.host_settings, `${pathLabel}.comparable.host_settings`),
      provider_configuration: assertPlain(
        comparable.provider_configuration,
        `${pathLabel}.comparable.provider_configuration`,
      ),
    },
    inputs: assertPlain(record.inputs, `${pathLabel}.inputs`),
    acceptance: assertPlain(record.acceptance, `${pathLabel}.acceptance`),
  };
}

function settingsDigest(settings) {
  return canonicalJsonStringify(settings);
}

function comparableMatch(trial, caseRecord) {
  if (trial.case_id !== caseRecord.id) return 'case_mismatch';
  if (trial.base_sha !== caseRecord.base_sha) return 'base_sha_mismatch';
  if (trial.host_model !== caseRecord.comparable.host_model) return 'host_model_mismatch';
  if (settingsDigest(trial.host_settings) !== settingsDigest(caseRecord.comparable.host_settings)) {
    return 'host_settings_mismatch';
  }
  if (COENGINEER_ARMS.includes(trial.arm)) {
    if (settingsDigest(trial.provider_configuration)
      !== settingsDigest(caseRecord.comparable.provider_configuration)) {
      return 'provider_configuration_mismatch';
    }
  }
  return null;
}

function emptyMetric() {
  return {
    value: null,
    source: 'unknown',
    trust: 'unknown',
    reported_sum: null,
    reported_count: 0,
    unknown_count: 0,
    unit: null,
  };
}

function rollupMetric(rows, key) {
  const result = emptyMetric();
  result.unit = metricUnit(key);
  let source = null;
  let trust = null;
  for (const row of rows) {
    if (row.source === 'unknown' || row.value === null) {
      result.unknown_count += 1;
      continue;
    }
    if (source === null) {
      source = row.source;
      trust = row.trust;
    } else if (source !== row.source || trust !== row.trust) {
      result.unknown_count += 1;
      continue;
    }
    result.reported_count += 1;
    result.reported_sum = result.reported_sum == null ? row.value : result.reported_sum + row.value;
  }
  const complete = result.unknown_count === 0 && result.reported_count > 0;
  if (complete) {
    result.value = result.reported_sum;
    result.source = source;
    result.trust = trust;
  }
  return result;
}

function usagePerAccepted(metric, acceptedCount) {
  if (acceptedCount === 0) {
    return {
      value: null,
      source: 'unknown',
      trust: 'unknown',
      reason: 'zero_accepted_not_zero_cost',
      unit: metric.unit,
    };
  }
  if (metric.value === null || metric.source === 'unknown') {
    return {
      value: null,
      source: 'unknown',
      trust: 'unknown',
      reason: 'unknown_metric',
      unit: metric.unit,
      coverage: {
        reported: metric.reported_count,
        unknown: metric.unknown_count,
      },
    };
  }
  return {
    value: metric.value / acceptedCount,
    source: metric.source,
    trust: metric.trust,
    reason: 'includes_failed_attempts',
    unit: metric.unit,
  };
}

function aggregateTrials(trials) {
  const attemptRows = [];
  let acceptedCount = 0;
  let acceptedKnown = 0;
  let failedAttempts = 0;
  let corrections = 0;
  let nativeHelpers = 0;
  for (const trial of trials) {
    if (trial.accepted === true) acceptedCount += 1;
    if (trial.accepted === true || trial.accepted === false) acceptedKnown += 1;
    for (const attempt of trial.attempts) {
      attemptRows.push(attempt);
      if (attempt.outcome === 'failed') failedAttempts += 1;
      if (attempt.kind === 'correction') corrections += 1;
      if (attempt.kind === 'native_helper') nativeHelpers += 1;
    }
  }
  const metrics = {};
  const perAccepted = {};
  for (const key of METRIC_KEYS) {
    const rolled = rollupMetric(attemptRows.map((attempt) => attempt.usage[key]), key);
    metrics[key] = rolled;
    perAccepted[key] = usagePerAccepted(rolled, acceptedCount);
  }
  const acceptanceCoverage = trials.length === 0 ? 0 : acceptedKnown / trials.length;
  const acceptanceRate = acceptanceCoverage === 1
    ? { value: acceptedCount / trials.length, coverage: 1 }
    : { value: null, coverage: acceptanceCoverage, reason: 'missing_acceptance' };
  return {
    trial_count: trials.length,
    accepted_count: acceptedCount,
    failed_attempt_count: failedAttempts,
    correction_count: corrections,
    native_helper_count: nativeHelpers,
    acceptance_rate: acceptanceRate,
    usage: metrics,
    usage_per_accepted_result: perAccepted,
  };
}

export function compareTrials(cases, trials) {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > MAX_CASES) {
    fail('bounds_exceeded', 'cases must contain 1..32 frozen case definitions.');
  }
  if (!Array.isArray(trials) || trials.length > MAX_TRIALS) {
    fail('bounds_exceeded', `trials exceed ${MAX_TRIALS}.`);
  }
  const parsedCases = cases.map((entry, index) => parseCase(entry, `cases[${index}]`));
  const parsedTrials = trials.map((entry, index) => parseTrial(entry, `trials[${index}]`));
  const seenTrials = new Set();
  for (const trial of parsedTrials) {
    if (seenTrials.has(trial.trial_id)) fail('duplicate_id', `duplicate trial_id ${trial.trial_id}`);
    seenTrials.add(trial.trial_id);
  }
  const caseById = new Map(parsedCases.map((entry) => [entry.id, entry]));
  const rows = [];
  for (const caseRecord of parsedCases) {
    const arms = {};
    for (const arm of ALL_ARMS) {
      const matched = [];
      const unmatched = [];
      for (const trial of parsedTrials) {
        if (trial.case_id !== caseRecord.id || trial.arm !== arm) continue;
        const mismatch = comparableMatch(trial, caseRecord);
        if (mismatch) unmatched.push({ trial_id: trial.trial_id, reason: mismatch });
        else matched.push(trial);
      }
      const required = REQUIRED_ARMS.includes(arm);
      let status = 'compared';
      if (matched.length === 0 && unmatched.length === 0) status = required ? 'unrun' : 'optional_unrun';
      else if (matched.length === 0) status = 'unmatched';
      arms[arm] = {
        arm,
        status,
        unmatched,
        ...aggregateTrials(matched),
      };
    }
    rows.push({
      case_id: caseRecord.id,
      title: caseRecord.title,
      base_sha: caseRecord.base_sha,
      arms,
    });
  }
  const unknownCases = parsedTrials
    .filter((trial) => !caseById.has(trial.case_id))
    .map((trial) => trial.trial_id);
  return {
    schema: COMPARISON_SCHEMA_ID,
    version: 1,
    invented_results: false,
    paid_live_jobs: 'not_implemented',
    unknown_case_trials: unknownCases,
    cases: rows,
  };
}

export async function loadCases(directory) {
  const entries = await readdir(directory);
  const files = entries.filter((name) => name.endsWith('.json')).sort();
  const cases = [];
  for (const file of files) {
    const text = await readFile(path.join(directory, file), 'utf8');
    cases.push(JSON.parse(text));
  }
  return cases.map((entry, index) => parseCase(entry, files[index]));
}

export async function loadTrials(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.trials;
  if (!Array.isArray(rows)) fail('invalid_type', 'trials must be a JSON array or { trials: [] }.');
  return rows;
}

export async function loadProtocol(filePath) {
  const protocol = JSON.parse(await readFile(filePath, 'utf8'));
  if (protocol.schema !== PROTOCOL_SCHEMA_ID) fail('invalid_format', 'protocol.schema');
  return protocol;
}

function printUsage() {
  return `Usage:
  node scripts/compare-coengineer-runs.mjs --cases DIR --trials FILE
  node scripts/compare-coengineer-runs.mjs --validate-cases DIR

Offline analysis of sanitized trial records. Live provider jobs are not
implemented. Paid repeated trials require --paid-budget and are still not
executed by this command.
`;
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv.includes('--help') || argv.length === 0) {
    io.stdout.write(printUsage());
    return 0;
  }
  if (argv.includes('--live')) {
    io.stderr.write('Live provider jobs are not implemented. Supply sanitized trial records.\n');
    if (!argv.includes('--paid-budget')) {
      io.stderr.write('Paid repeated trials are opt-in and require --paid-budget.\n');
    }
    return 2;
  }
  const casesDir = readArg(argv, '--cases') ?? path.join(ROOT, 'benchmarks/cases');
  const protocolPath = readArg(argv, '--protocol') ?? path.join(ROOT, 'benchmarks/protocol.json');
  await loadProtocol(protocolPath);
  const cases = await loadCases(casesDir);
  if (argv.includes('--validate-cases')) {
    io.stdout.write(`${JSON.stringify({ valid: true, case_count: cases.length, ids: cases.map((entry) => entry.id) }, null, 2)}\n`);
    return 0;
  }
  const trialsPath = readArg(argv, '--trials');
  if (trialsPath == null) {
    io.stderr.write('Missing --trials FILE. This command analyzes sanitized records only.\n');
    io.stderr.write(printUsage());
    return 2;
  }
  const trials = await loadTrials(path.resolve(trialsPath));
  const comparison = compareTrials(cases, trials);
  io.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  return 0;
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
