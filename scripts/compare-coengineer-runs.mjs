#!/usr/bin/env node
// Offline comparison of sanitized Co-Engineer trial records against frozen
// benchmark cases. Live provider jobs are not implemented. Paid repeated
// trials remain opt-in and must not run from CI.

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalJsonStringify } from '../plugins/codex-co-engineer/mcp/v3/identity.mjs';

const execFile = promisify(execFileCallback);

export const PROTOCOL_SCHEMA_ID = 'codex-co-engineer.benchmark-protocol.v1';
export const CASE_SCHEMA_ID = 'codex-co-engineer.benchmark-case.v1';
export const TRIAL_SCHEMA_ID = 'codex-co-engineer.benchmark-trial.v1';
export const TRIALS_SCHEMA_ID = 'codex-co-engineer.benchmark-trials.v1';
export const COMPARISON_SCHEMA_ID = 'codex-co-engineer.benchmark-comparison.v1';
export const REQUIRED_ARMS = Object.freeze(['native-codex', 'published-3.4.2', 'candidate-3.4.3']);
export const OPTIONAL_ARMS = Object.freeze(['direct-delegation']);
export const ALL_ARMS = Object.freeze([...REQUIRED_ARMS, ...OPTIONAL_ARMS]);
export const COENGINEER_ARMS = Object.freeze(['published-3.4.2', 'candidate-3.4.3', 'direct-delegation']);
export const ATTEMPT_KINDS = Object.freeze(['initial', 'correction', 'native_helper']);
export const ATTEMPT_OUTCOMES = Object.freeze([
  'accepted', 'completed_unaccepted', 'failed', 'uncertain', 'unfinal',
]);
export const TERMINAL_OUTCOMES = Object.freeze(['accepted', 'completed_unaccepted', 'failed']);
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
export const SOURCE_TRUST = Object.freeze({
  host_measured: 'host_authoritative',
  provider_report: 'provider_untrusted',
  evidence_bytes: 'host_authoritative',
  unknown: 'unknown',
});
export const PROVENANCE_CLASSES = Object.freeze([
  'synthetic_unverified',
  'operator_supplied_unverified',
]);
export const COENGINEER_SOURCE_KINDS = Object.freeze(['git_commit', 'synthetic_label', 'native']);
export const CASE_GIT_IDENTITY = Object.freeze({
  name: 'Co-Engineer Benchmark',
  email: 'benchmark@invalid',
  date: '2026-01-01T00:00:00+0000',
});
export const GIT_EXECUTABLE = '/usr/bin/git';
export const INPUT_DIGEST_DOMAIN = 'codex-co-engineer.benchmark-input.v1';

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SYNTHETIC_LABEL = /^fixture:[a-z0-9.-]{1,64}$/u;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;
const MAX_ATTEMPTS = 32;
const MAX_TRIALS = 256;
const MAX_CASES = 32;
const MAX_CASE_FILES = 16;
const MAX_PATH_SEGMENTS = 4;
const MAX_FILE_BYTES = 16_384;
const MAX_CASE_JSON_BYTES = 131_072;
const MAX_TRIALS_JSON_BYTES = 1_048_576;
const MAX_PROTOCOL_JSON_BYTES = 65_536;
const GIT_TIMEOUT_MS = 10_000;
const BOOLEAN_FLAGS = Object.freeze(['--help', '--live']);
const VALUE_FLAGS = Object.freeze([
  '--cases', '--trials', '--protocol', '--validate-cases',
  '--materialize-case', '--destination', '--paid-budget',
]);

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

function ownInteger(object, key, pathLabel, min, max) {
  const value = object[key];
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('out_of_range', `${pathLabel}.${key} must be a safe integer in ${min}..${max}.`);
  }
  return value;
}

function metricUnit(key) {
  if (BYTE_METRICS.includes(key)) return 'bytes';
  if (key === 'elapsed_ms' || key === 'wall_elapsed_ms' || key === 'attempt_elapsed_ms') {
    return 'milliseconds';
  }
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
  if (SOURCE_TRUST[source] !== trust) {
    fail('identity_mismatch', `${pathLabel} source/trust pair is not allowed.`);
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

function parseProviderAttribution(attempt, usage, pathLabel) {
  const recorded = PROVIDER_METRICS.some((key) => usage[key].value !== null);
  if (!recorded) {
    return { provider: null, model: null };
  }
  const provider = ownString(attempt, 'provider', pathLabel, PROVIDER_ID);
  const model = ownString(attempt, 'model', pathLabel, MODEL_ID);
  return { provider, model };
}

function parseAttempt(value, pathLabel, index) {
  const attempt = assertPlain(value, pathLabel);
  const kind = ownString(attempt, 'kind', pathLabel);
  if (!ATTEMPT_KINDS.includes(kind)) fail('invalid_format', `${pathLabel}.kind`);
  const outcome = ownString(attempt, 'outcome', pathLabel);
  if (!ATTEMPT_OUTCOMES.includes(outcome)) fail('invalid_format', `${pathLabel}.outcome`);
  const usage = parseAttemptUsage(attempt.usage, `${pathLabel}.usage`);
  const attribution = parseProviderAttribution(attempt, usage, pathLabel);
  const sequence = Object.hasOwn(attempt, 'sequence')
    ? ownInteger(attempt, 'sequence', pathLabel, 1, MAX_ATTEMPTS)
    : index + 1;
  return {
    attempt_id: ownString(attempt, 'attempt_id', pathLabel, ID_PATTERN),
    kind,
    outcome,
    sequence,
    provider: attribution.provider,
    model: attribution.model,
    usage,
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

function compatibleSnapshot(previous, next) {
  if (previous.kind !== next.kind) return false;
  if (next.sequence <= previous.sequence) return false;
  if (TERMINAL_OUTCOMES.includes(previous.outcome) && previous.outcome !== next.outcome) {
    return false;
  }
  return monotoneOrEqual(previous, next);
}

function dedupeAttempts(attempts, pathLabel) {
  const latest = new Map();
  const replaced = [];
  for (const attempt of attempts) {
    const previous = latest.get(attempt.attempt_id);
    if (!previous) {
      latest.set(attempt.attempt_id, attempt);
      continue;
    }
    if (!compatibleSnapshot(previous, attempt)) {
      fail(
        'incompatible_snapshot',
        `${pathLabel} duplicate attempt_id ${attempt.attempt_id} is not a compatible cumulative snapshot.`,
      );
    }
    latest.set(attempt.attempt_id, attempt);
    replaced.push(attempt.attempt_id);
  }
  return { attempts: [...latest.values()], cumulative_replaced: replaced };
}

function parseCoengineerSource(value, pathLabel, arm) {
  if (value == null) {
    fail('missing_key', `${pathLabel} must record coengineer_source identity.`);
  }
  const source = assertPlain(value, pathLabel);
  const kind = ownString(source, 'kind', pathLabel);
  const recorded = ownString(source, 'value', pathLabel);
  if (!COENGINEER_SOURCE_KINDS.includes(kind)) {
    fail('invalid_format', `${pathLabel}.kind`);
  }
  if (COENGINEER_ARMS.includes(arm)) {
    if (kind === 'native') {
      fail('identity_mismatch', `${pathLabel} Co-Engineer arms cannot use native identity.`);
    }
    if (kind === 'git_commit' && !SHA40.test(recorded)) {
      fail('invalid_format', `${pathLabel}.value must be a 40-character commit SHA.`);
    }
    if (kind === 'synthetic_label' && !SYNTHETIC_LABEL.test(recorded)) {
      fail('invalid_format', `${pathLabel}.value must be a fixture: label.`);
    }
  } else if (kind !== 'native' || recorded !== 'native-codex') {
    fail('identity_mismatch', `${pathLabel} native arm identity must be native:native-codex.`);
  }
  return { kind, value: recorded, key: `${kind}:${recorded}` };
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
  const parsedAttempts = attemptsInput.map((entry, index) => (
    parseAttempt(entry, `${pathLabel}.attempts[${index}]`, index)
  ));
  const deduped = dedupeAttempts(parsedAttempts, pathLabel);
  const accepted = Object.hasOwn(trial, 'accepted') ? ownBoolean(trial, 'accepted', pathLabel) : null;
  const hasHelpers = deduped.attempts.some((attempt) => attempt.kind === 'native_helper');
  const hasParent = deduped.attempts.some((attempt) => attempt.kind !== 'native_helper');
  let nativeParentExcludesHelpers = false;
  if (hasHelpers && hasParent) {
    if (trial.native_parent_excludes_helpers !== true) {
      fail(
        'identity_mismatch',
        `${pathLabel} native parent usage must explicitly exclude separately recorded helpers.`,
      );
    }
    nativeParentExcludesHelpers = true;
  } else if (Object.hasOwn(trial, 'native_parent_excludes_helpers')) {
    nativeParentExcludesHelpers = ownBoolean(trial, 'native_parent_excludes_helpers', pathLabel);
  }
  return {
    schema: TRIAL_SCHEMA_ID,
    trial_id: ownString(trial, 'trial_id', pathLabel, ID_PATTERN),
    case_id: ownString(trial, 'case_id', pathLabel, ID_PATTERN),
    arm,
    base_sha: ownString(trial, 'base_sha', pathLabel, SHA40),
    input_digest: ownString(trial, 'input_digest', pathLabel, SHA256),
    coengineer_source: parseCoengineerSource(
      trial.coengineer_source,
      `${pathLabel}.coengineer_source`,
      arm,
    ),
    host_model: ownString(trial, 'host_model', pathLabel),
    host_settings: assertPlain(trial.host_settings, `${pathLabel}.host_settings`),
    provider_configuration: assertPlain(
      trial.provider_configuration,
      `${pathLabel}.provider_configuration`,
    ),
    accepted,
    wall_elapsed_ms: parseUsageMetric(trial.wall_elapsed_ms, `${pathLabel}.wall_elapsed_ms`, 'elapsed_ms'),
    native_parent_excludes_helpers: nativeParentExcludesHelpers,
    attempts: deduped.attempts,
    cumulative_replaced: deduped.cumulative_replaced,
  };
}

export function assertSafeRelativePath(rel, pathLabel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 200) {
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
    if (part === '.' || part === '..' || part === '.git' || !PATH_SEGMENT.test(part)) {
      fail('invalid_format', `${pathLabel} is not a safe relative path.`);
    }
  }
  return rel;
}

function parseFiles(value, pathLabel) {
  const files = assertPlain(value, pathLabel);
  const keys = Object.keys(files);
  if (keys.length < 1 || keys.length > MAX_CASE_FILES) {
    fail('bounds_exceeded', `${pathLabel} must contain 1..${MAX_CASE_FILES} files.`);
  }
  const parsed = {};
  for (const key of keys) {
    assertSafeRelativePath(key, `${pathLabel}.${key}`);
    const text = files[key];
    if (typeof text !== 'string') fail('invalid_type', `${pathLabel}.${key} must be a string.`);
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      fail('bounds_exceeded', `${pathLabel}.${key} exceeds ${MAX_FILE_BYTES} bytes.`);
    }
    parsed[key] = text;
  }
  return parsed;
}

function parseAcceptance(value, pathLabel) {
  const acceptance = assertPlain(value, pathLabel);
  const checks = acceptance.checks;
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 16) {
    fail('bounds_exceeded', `${pathLabel}.checks`);
  }
  for (let index = 0; index < checks.length; index += 1) {
    const check = assertPlain(checks[index], `${pathLabel}.checks[${index}]`);
    ownString(check, 'id', `${pathLabel}.checks[${index}]`, ID_PATTERN);
    if (Object.hasOwn(check, 'command')) {
      const command = check.command;
      if (!Array.isArray(command) || command.length < 1 || command.some((part) => typeof part !== 'string')) {
        fail('invalid_format', `${pathLabel}.checks[${index}].command must be a frozen argv array.`);
      }
    }
  }
  return acceptance;
}

export function computeInputDigest(files, acceptance) {
  const canonical = canonicalJsonStringify({ files, acceptance });
  return createHash('sha256')
    .update(INPUT_DIGEST_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

export function parseCase(value, pathLabel = 'case') {
  const record = assertPlain(value, pathLabel);
  if (record.schema !== CASE_SCHEMA_ID) fail('invalid_format', `${pathLabel}.schema`);
  const comparable = assertPlain(record.comparable, `${pathLabel}.comparable`);
  const inputs = assertPlain(record.inputs, `${pathLabel}.inputs`);
  const files = parseFiles(inputs.files, `${pathLabel}.inputs.files`);
  const acceptance = parseAcceptance(record.acceptance, `${pathLabel}.acceptance`);
  const inputDigest = computeInputDigest(files, acceptance);
  if (Object.hasOwn(record, 'input_digest')) {
    const claimed = ownString(record, 'input_digest', pathLabel, SHA256);
    if (claimed !== inputDigest) {
      fail('identity_mismatch', `${pathLabel}.input_digest does not match frozen files and acceptance checks.`);
    }
  }
  let baseSha = null;
  if (Object.hasOwn(record, 'base_sha') && record.base_sha != null) {
    baseSha = ownString(record, 'base_sha', pathLabel, SHA40);
  }
  return {
    schema: CASE_SCHEMA_ID,
    id: ownString(record, 'id', pathLabel, ID_PATTERN),
    title: ownString(record, 'title', pathLabel),
    summary: ownString(record, 'summary', pathLabel),
    base_sha: baseSha,
    input_digest: inputDigest,
    comparable: {
      host_model: ownString(comparable, 'host_model', `${pathLabel}.comparable`),
      host_settings: assertPlain(comparable.host_settings, `${pathLabel}.comparable.host_settings`),
      provider_configuration: assertPlain(
        comparable.provider_configuration,
        `${pathLabel}.comparable.provider_configuration`,
      ),
    },
    inputs: { files },
    acceptance,
  };
}

function settingsDigest(settings) {
  return canonicalJsonStringify(settings);
}

function comparableMatch(trial, caseRecord) {
  if (trial.case_id !== caseRecord.id) return 'case_mismatch';
  if (trial.input_digest !== caseRecord.input_digest) return 'input_digest_mismatch';
  if (caseRecord.base_sha != null && trial.base_sha !== caseRecord.base_sha) return 'base_sha_mismatch';
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

function attributionKey(attempt) {
  if (attempt.provider == null || attempt.model == null) return 'unattributed';
  return `${attempt.provider}\n${attempt.model}`;
}

function rollupProviderMetric(attempts, key) {
  const result = rollupMetric(attempts.map((attempt) => attempt.usage[key]), key);
  const groups = new Map();
  for (const attempt of attempts) {
    const metric = attempt.usage[key];
    if (metric.source === 'unknown' || metric.value === null) continue;
    if (attempt.provider == null || attempt.model == null) continue;
    const mapKey = attributionKey(attempt);
    const current = groups.get(mapKey) ?? {
      provider: attempt.provider,
      model: attempt.model,
      value: 0,
      source: metric.source,
      trust: metric.trust,
      unit: metric.unit,
    };
    current.value += metric.value;
    groups.set(mapKey, current);
  }
  result.groups = [...groups.values()].sort((left, right) => {
    if (left.provider === right.provider) return left.model.localeCompare(right.model);
    return left.provider.localeCompare(right.provider);
  });
  if (result.groups.length > 1) {
    result.value = null;
    result.source = 'unknown';
    result.trust = 'unknown';
    result.reason = 'mixed_providers_non_comparable';
  }
  return result;
}

function usagePerAccepted(metric, context) {
  const coverage = {
    accepted_known: context.acceptedKnown,
    accepted_count: context.acceptedCount,
    trial_count: context.trialCount,
    metric_reported: metric.reported_count,
    metric_unknown: metric.unknown_count,
  };
  if (context.acceptanceComplete !== true) {
    return {
      value: null,
      source: 'unknown',
      trust: 'unknown',
      reason: 'incomplete_acceptance_coverage',
      numerator: metric.value,
      known_accepted_count: context.acceptedCount,
      coverage,
      unit: metric.unit,
    };
  }
  if (context.acceptedCount === 0) {
    return {
      value: null,
      source: 'unknown',
      trust: 'unknown',
      reason: 'zero_accepted_not_zero_cost',
      numerator: metric.value,
      known_accepted_count: 0,
      coverage,
      unit: metric.unit,
    };
  }
  if (metric.value === null || metric.source === 'unknown') {
    return {
      value: null,
      source: 'unknown',
      trust: 'unknown',
      reason: 'unknown_metric',
      numerator: metric.value,
      known_accepted_count: context.acceptedCount,
      coverage,
      unit: metric.unit,
    };
  }
  return {
    value: metric.value / context.acceptedCount,
    source: metric.source,
    trust: metric.trust,
    reason: 'includes_failed_attempts_and_corrections',
    numerator: metric.value,
    known_accepted_count: context.acceptedCount,
    coverage,
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
  const acceptanceComplete = trials.length > 0 && acceptedKnown === trials.length;
  const perAcceptedContext = {
    acceptedCount,
    acceptedKnown,
    trialCount: trials.length,
    acceptanceComplete,
  };
  const metrics = {};
  const perAccepted = {};
  for (const key of METRIC_KEYS) {
    const rolled = PROVIDER_METRICS.includes(key)
      ? rollupProviderMetric(attemptRows, key)
      : rollupMetric(attemptRows.map((attempt) => attempt.usage[key]), key);
    if (key === 'elapsed_ms') {
      rolled.role = 'attempt_duration_sum';
    }
    metrics[key] = rolled;
    perAccepted[key] = usagePerAccepted(rolled, perAcceptedContext);
  }
  const wall = rollupMetric(trials.map((trial) => trial.wall_elapsed_ms), 'wall_elapsed_ms');
  wall.role = 'trial_wall_elapsed';
  metrics.wall_elapsed_ms = wall;
  perAccepted.wall_elapsed_ms = usagePerAccepted(wall, perAcceptedContext);
  const acceptanceCoverage = trials.length === 0 ? 0 : acceptedKnown / trials.length;
  const acceptanceRate = acceptanceComplete
    ? { value: acceptedCount / trials.length, coverage: 1 }
    : { value: null, coverage: acceptanceCoverage, reason: 'missing_acceptance' };
  return {
    trial_count: trials.length,
    accepted_count: acceptedCount,
    accepted_known_count: acceptedKnown,
    failed_attempt_count: failedAttempts,
    correction_count: corrections,
    native_helper_count: nativeHelpers,
    acceptance_rate: acceptanceRate,
    usage: metrics,
    usage_per_accepted_result: perAccepted,
  };
}

function parseProvenance(value, pathLabel = 'provenance') {
  if (value == null) {
    return {
      class: 'synthetic_unverified',
      independently_verified: false,
      paid_live_jobs: false,
    };
  }
  const provenance = assertPlain(value, pathLabel);
  const recordedClass = ownString(provenance, 'class', pathLabel);
  if (!PROVENANCE_CLASSES.includes(recordedClass)) {
    fail('invalid_format', `${pathLabel}.class`);
  }
  const independentlyVerified = Object.hasOwn(provenance, 'independently_verified')
    ? ownBoolean(provenance, 'independently_verified', pathLabel)
    : false;
  if (independentlyVerified === true) {
    fail(
      'identity_mismatch',
      `${pathLabel} this command does not independently verify supplied measurements.`,
    );
  }
  const paidLiveJobs = Object.hasOwn(provenance, 'paid_live_jobs')
    ? ownBoolean(provenance, 'paid_live_jobs', pathLabel)
    : false;
  return {
    class: recordedClass,
    independently_verified: false,
    paid_live_jobs: paidLiveJobs,
  };
}

export function compareTrials(cases, trials, options = {}) {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > MAX_CASES) {
    fail('bounds_exceeded', 'cases must contain 1..32 frozen case definitions.');
  }
  if (!Array.isArray(trials) || trials.length > MAX_TRIALS) {
    fail('bounds_exceeded', `trials exceed ${MAX_TRIALS}.`);
  }
  const parsedCases = cases.map((entry, index) => parseCase(entry, `cases[${index}]`));
  const seenCaseIds = new Set();
  for (const caseRecord of parsedCases) {
    if (seenCaseIds.has(caseRecord.id)) {
      fail('duplicate_id', `duplicate case id ${caseRecord.id}`);
    }
    seenCaseIds.add(caseRecord.id);
  }
  const parsedTrials = trials.map((entry, index) => parseTrial(entry, `trials[${index}]`));
  const seenTrials = new Set();
  for (const trial of parsedTrials) {
    if (seenTrials.has(trial.trial_id)) fail('duplicate_id', `duplicate trial_id ${trial.trial_id}`);
    seenTrials.add(trial.trial_id);
  }
  const caseById = new Map(parsedCases.map((entry) => [entry.id, entry]));
  const provenance = parseProvenance(options.provenance);
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
      const identities = new Set(matched.map((trial) => trial.coengineer_source.key));
      if (identities.size > 1) {
        fail(
          'mixed_candidate_identity',
          `arm ${arm} for case ${caseRecord.id} mixes coengineer_source identities.`,
        );
      }
      const bases = new Set(matched.map((trial) => trial.base_sha));
      if (bases.size > 1) {
        fail(
          'mixed_base_sha',
          `arm ${arm} for case ${caseRecord.id} mixes materialized base SHAs.`,
        );
      }
      const hostModels = new Set(matched.map((trial) => trial.host_model));
      const hostSettings = new Set(matched.map((trial) => settingsDigest(trial.host_settings)));
      if (hostModels.size > 1 || hostSettings.size > 1) {
        fail(
          'identity_mismatch',
          `arm ${arm} for case ${caseRecord.id} mixes host model or settings.`,
        );
      }
      if (COENGINEER_ARMS.includes(arm)) {
        const providers = new Set(matched.map((trial) => settingsDigest(trial.provider_configuration)));
        if (providers.size > 1) {
          fail(
            'identity_mismatch',
            `arm ${arm} for case ${caseRecord.id} mixes provider configuration.`,
          );
        }
      }
      const required = REQUIRED_ARMS.includes(arm);
      let status = 'compared';
      if (matched.length === 0 && unmatched.length === 0) status = required ? 'unrun' : 'optional_unrun';
      else if (matched.length === 0) status = 'unmatched';
      arms[arm] = {
        arm,
        status,
        unmatched,
        coengineer_source: matched[0]?.coengineer_source ?? null,
        ...aggregateTrials(matched),
      };
    }
    rows.push({
      case_id: caseRecord.id,
      title: caseRecord.title,
      input_digest: caseRecord.input_digest,
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
    provenance: {
      class: provenance.class,
      independently_verified: false,
      synthetic: provenance.class === 'synthetic_unverified',
      paid_live_jobs: provenance.paid_live_jobs,
    },
    paid_live_jobs: 'not_implemented',
    unknown_case_trials: unknownCases,
    cases: rows,
  };
}

async function readJsonBounded(filePath, maxBytes, pathLabel) {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    fail('bounds_exceeded', `${pathLabel} exceeds ${maxBytes} bytes.`);
  }
  const text = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    fail('bounds_exceeded', `${pathLabel} exceeds ${maxBytes} bytes.`);
  }
  return JSON.parse(text);
}

export async function loadCases(directory) {
  const entries = await readdir(directory);
  const files = entries.filter((name) => name.endsWith('.json')).sort();
  if (files.length < 1 || files.length > MAX_CASES) {
    fail('bounds_exceeded', `cases directory must contain 1..${MAX_CASES} JSON files.`);
  }
  const cases = [];
  for (const file of files) {
    const parsed = await readJsonBounded(path.join(directory, file), MAX_CASE_JSON_BYTES, file);
    cases.push(parseCase(parsed, file));
  }
  const seen = new Set();
  for (const caseRecord of cases) {
    if (seen.has(caseRecord.id)) fail('duplicate_id', `duplicate case id ${caseRecord.id}`);
    seen.add(caseRecord.id);
  }
  return cases;
}

export async function loadTrials(filePath) {
  const parsed = await readJsonBounded(filePath, MAX_TRIALS_JSON_BYTES, path.basename(filePath));
  if (Array.isArray(parsed)) {
    return {
      trials: parsed,
      provenance: parseProvenance(null),
    };
  }
  assertPlain(parsed, 'trials');
  if (parsed.schema != null && parsed.schema !== TRIALS_SCHEMA_ID) {
    fail('invalid_format', 'trials.schema');
  }
  const rows = parsed.trials;
  if (!Array.isArray(rows)) fail('invalid_type', 'trials must be a JSON array or { trials: [] }.');
  return {
    trials: rows,
    provenance: parseProvenance(parsed.provenance),
  };
}

export async function loadProtocol(filePath) {
  const protocol = await readJsonBounded(filePath, MAX_PROTOCOL_JSON_BYTES, 'protocol');
  if (protocol.schema !== PROTOCOL_SCHEMA_ID) fail('invalid_format', 'protocol.schema');
  return protocol;
}

export function caseCommitMessage(caseId) {
  return `${CASE_SCHEMA_ID}:${caseId}`;
}

async function runGit(cwd, args) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: cwd,
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
      maxBuffer: 64 * 1024,
    });
    return String(result.stdout ?? '');
  } catch (error) {
    const stderr = error instanceof Error ? String(error.stderr ?? error.message) : String(error);
    fail('git_execution_failed', `git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

async function assertEmptyDestination(destination) {
  try {
    const info = await stat(destination);
    if (!info.isDirectory()) {
      fail('invalid_type', 'destination must be an empty directory.');
    }
    const names = await readdir(destination);
    if (names.length > 0) {
      fail('destination_not_empty', 'destination must be empty.');
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await mkdir(destination);
      return;
    }
    throw error;
  }
}

export async function materializeCase(caseRecord, destination) {
  const parsed = parseCase(caseRecord, 'case');
  const dest = path.resolve(destination);
  await assertEmptyDestination(dest);
  for (const relative of Object.keys(parsed.inputs.files)) {
    assertSafeRelativePath(relative, `inputs.files.${relative}`);
    const target = path.join(dest, relative);
    const resolved = path.resolve(dest, relative);
    if (resolved !== target || !resolved.startsWith(`${dest}${path.sep}`)) {
      fail('invalid_format', `${relative} escapes the destination.`);
    }
    const parent = path.dirname(target);
    if (parent !== dest) await mkdir(parent, { recursive: true });
    await writeFile(target, parsed.inputs.files[relative], { encoding: 'utf8', mode: 0o644 });
  }
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
    'commit', '--no-gpg-sign', '-m', caseCommitMessage(parsed.id),
  ]);
  const head = (await runGit(dest, ['rev-parse', 'HEAD'])).trim();
  if (!SHA40.test(head)) fail('git_execution_failed', 'materialized HEAD is not a 40-character SHA.');
  if (parsed.base_sha != null && parsed.base_sha !== head) {
    fail(
      'identity_mismatch',
      `materialized base SHA ${head} does not match case.base_sha ${parsed.base_sha}.`,
    );
  }
  return {
    case_id: parsed.id,
    destination: dest,
    base_sha: head,
    input_digest: parsed.input_digest,
    git_identity: { ...CASE_GIT_IDENTITY, message: caseCommitMessage(parsed.id) },
  };
}

function printUsage() {
  return `Usage:
  node scripts/compare-coengineer-runs.mjs --validate-cases DIR
  node scripts/compare-coengineer-runs.mjs --materialize-case FILE --destination DIR
  node scripts/compare-coengineer-runs.mjs --cases DIR --trials FILE [--protocol FILE]

Offline analysis of sanitized trial records. Live provider jobs are not
implemented. Paid repeated trials require --live --paid-budget and are still
not executed by this command. Synthetic fixtures are labeled unverified.
Unknown flags are rejected. Case and trial files are size-bounded.
`;
}

function parseArgv(argv) {
  const flags = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '--live') {
      flags[arg] = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail('unknown_flag', `Unexpected argument ${arg}.`);
    }
    if (BOOLEAN_FLAGS.includes(arg)) {
      flags[arg] = true;
      continue;
    }
    if (arg === '--validate-cases') {
      const nested = argv[index + 1];
      if (nested != null && !nested.startsWith('--')) {
        flags[arg] = nested;
        index += 1;
      } else {
        flags[arg] = true;
      }
      continue;
    }
    if (!VALUE_FLAGS.includes(arg)) {
      fail('unknown_flag', `Unknown flag ${arg}.`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      fail('missing_flag', `${arg} requires a value.`);
    }
    flags[arg] = value;
    index += 1;
  }
  return flags;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv.includes('--help') || argv.length === 0) {
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
      io.stderr.write('Paid repeated trials are opt-in and require --paid-budget.\n');
    }
    return 2;
  }
  if (flags['--materialize-case'] != null) {
    if (flags['--destination'] == null) {
      io.stderr.write('Missing --destination DIR.\n');
      io.stderr.write(printUsage());
      return 2;
    }
    const record = await readJsonBounded(
      path.resolve(flags['--materialize-case']),
      MAX_CASE_JSON_BYTES,
      'materialize-case',
    );
    const materialized = await materializeCase(parseCase(record), path.resolve(flags['--destination']));
    io.stdout.write(`${JSON.stringify(materialized, null, 2)}\n`);
    return 0;
  }
  if (Object.hasOwn(flags, '--validate-cases')) {
    const casesDir = typeof flags['--validate-cases'] === 'string'
      ? flags['--validate-cases']
      : flags['--cases'];
    if (casesDir == null) {
      io.stderr.write('Missing --validate-cases DIR.\n');
      io.stderr.write(printUsage());
      return 2;
    }
    if (flags['--protocol'] != null) await loadProtocol(path.resolve(flags['--protocol']));
    const cases = await loadCases(path.resolve(casesDir));
    io.stdout.write(`${JSON.stringify({
      valid: true,
      case_count: cases.length,
      ids: cases.map((entry) => entry.id),
      input_digests: Object.fromEntries(cases.map((entry) => [entry.id, entry.input_digest])),
    }, null, 2)}\n`);
    return 0;
  }
  if (flags['--cases'] == null || flags['--trials'] == null) {
    io.stderr.write('Missing --cases DIR and/or --trials FILE. This command analyzes sanitized records only.\n');
    io.stderr.write(printUsage());
    return 2;
  }
  if (flags['--protocol'] != null) await loadProtocol(path.resolve(flags['--protocol']));
  const cases = await loadCases(path.resolve(flags['--cases']));
  const loaded = await loadTrials(path.resolve(flags['--trials']));
  const comparison = compareTrials(cases, loaded.trials, { provenance: loaded.provenance });
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
