#!/usr/bin/env node
// Offline host-accounting importer for sanitized Codex session JSONL.
// Reads only allowlisted paths from an explicit manifest. Never mutates
// session files. Emits benchmark-trial.v1 rows for compare-coengineer-runs.mjs
// plus a separate breakdown and evidence digests. Provider jobs and live
// budget setup are out of scope.

import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTrial,
  TRIAL_SCHEMA_ID,
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
} from './compare-coengineer-runs.mjs';

export const MANIFEST_SCHEMA_ID = 'codex-co-engineer.host-usage-manifest.v1';
export const REPORT_SCHEMA_ID = 'codex-co-engineer.host-usage-report.v1';
export const EVIDENCE_DIGEST_DOMAIN = 'codex-co-engineer.host-usage-evidence.v1';

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 262_144;
const MAX_SESSION_BYTES = 8_388_608;
const MAX_SESSIONS = 32;
const MAX_PHASES = 32;
const MAX_LINES = 200_000;
const BOOLEAN_FLAGS = Object.freeze(['--help']);
const VALUE_FLAGS = Object.freeze(['--manifest', '--write', '--sessions-root']);

const USAGE_COUNTERS = Object.freeze([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]);

// Forbid content-bearing keys in shareable aggregates. Configuration labels
// such as host_settings.reasoning (effort enum) are allowed.
const FORBIDDEN_AGGREGATE_KEYS = Object.freeze([
  'prompt', 'prompts', 'message', 'messages', 'reasoning_text',
  'reasoning_content', 'output_text', 'output_snippet', 'ciphertext',
  'encrypted_content', 'credential', 'credentials', 'api_key', 'authorization',
  'absolute_path', 'source_path',
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

function parseIso(value, pathLabel) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_format', `${pathLabel} must be an ISO-8601 timestamp.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('invalid_format', `${pathLabel} must be an ISO-8601 timestamp.`);
  return { raw: value, ms };
}

function hostMetric(value) {
  if (value == null) return { value: null, source: 'unknown', trust: 'unknown' };
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('out_of_range', 'usage metric must be a non-negative safe integer.');
  }
  return { value, source: 'host_measured', trust: 'host_authoritative' };
}

function unknownMetric() {
  return { value: null, source: 'unknown', trust: 'unknown' };
}

function emptyCounters() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function parseCounters(value, pathLabel) {
  const record = assertPlain(value, pathLabel);
  const out = emptyCounters();
  for (const key of USAGE_COUNTERS) {
    if (!Object.hasOwn(record, key)) {
      fail('missing_key', `${pathLabel}.${key} is required.`);
    }
    out[key] = ownInteger(record, key, pathLabel, 0, Number.MAX_SAFE_INTEGER);
  }
  for (const key of Object.keys(record)) {
    if (!USAGE_COUNTERS.includes(key)) fail('unknown_key', `${pathLabel}.${key}`);
  }
  // Reasoning is a subset of output; never treat it as an additive summand.
  if (out.reasoning_output_tokens > out.output_tokens) {
    fail('identity_mismatch', `${pathLabel} reasoning_output_tokens exceeds output_tokens.`);
  }
  return out;
}

function countersEqual(left, right) {
  return USAGE_COUNTERS.every((key) => left[key] === right[key]);
}

function addCounters(target, source) {
  for (const key of USAGE_COUNTERS) target[key] += source[key];
  return target;
}

function sha256Hex(parts) {
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

function assertSafeRelativeSessionPath(rel, pathLabel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 240) {
    fail('invalid_format', `${pathLabel} is not a safe relative session path.`);
  }
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0')) {
    fail('invalid_format', `${pathLabel} must be a relative path without absolute or drive forms.`);
  }
  const parts = rel.split('/');
  if (parts.length > 12) fail('bounds_exceeded', `${pathLabel} has too many segments.`);
  for (const part of parts) {
    if (part === '.' || part === '..' || part.length === 0) {
      fail('invalid_format', `${pathLabel} is not a safe relative session path.`);
    }
  }
  return rel;
}

function assertNoPrivacyLeak(value, pathLabel = 'report') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivacyLeak(entry, `${pathLabel}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'string') {
      if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) {
        fail('privacy_leak', `${pathLabel} must not embed absolute source paths.`);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_AGGREGATE_KEYS.includes(lower)) {
      fail('privacy_leak', `${pathLabel}.${key} is not allowed in shareable aggregates.`);
    }
    if (lower.endsWith('_path') && lower !== 'agent_path_digest' && typeof child === 'string') {
      if (path.isAbsolute(child) || child.includes('\\') || child.startsWith('/')) {
        fail('privacy_leak', `${pathLabel}.${key} must not embed absolute source paths.`);
      }
    }
    assertNoPrivacyLeak(child, `${pathLabel}.${key}`);
  }
}

export function parseManifest(value, pathLabel = 'manifest') {
  const manifest = assertPlain(value, pathLabel);
  if (manifest.schema !== MANIFEST_SCHEMA_ID) {
    fail('invalid_format', `${pathLabel}.schema`);
  }
  const trial = assertPlain(manifest.trial, `${pathLabel}.trial`);
  const window = assertPlain(manifest.window, `${pathLabel}.window`);
  const start = parseIso(window.start, `${pathLabel}.window.start`);
  const end = parseIso(window.end, `${pathLabel}.window.end`);
  if (end.ms < start.ms) fail('invalid_format', `${pathLabel}.window end precedes start.`);

  const sessionsInput = manifest.sessions;
  if (!Array.isArray(sessionsInput) || sessionsInput.length < 1 || sessionsInput.length > MAX_SESSIONS) {
    fail('bounds_exceeded', `${pathLabel}.sessions`);
  }
  const sessions = [];
  const sessionById = new Map();
  for (let index = 0; index < sessionsInput.length; index += 1) {
    const entry = assertPlain(sessionsInput[index], `${pathLabel}.sessions[${index}]`);
    const id = ownString(entry, 'id', `${pathLabel}.sessions[${index}]`, SESSION_ID_PATTERN);
    if (sessionById.has(id)) fail('duplicate_id', `${pathLabel}.sessions duplicate id ${id}`);
    const role = ownString(entry, 'role', `${pathLabel}.sessions[${index}]`);
    if (role !== 'parent' && role !== 'native_helper') {
      fail('invalid_format', `${pathLabel}.sessions[${index}].role`);
    }
    const relativePath = assertSafeRelativeSessionPath(
      ownString(entry, 'path', `${pathLabel}.sessions[${index}]`),
      `${pathLabel}.sessions[${index}].path`,
    );
    let parentId = null;
    if (Object.hasOwn(entry, 'parent_id') && entry.parent_id != null) {
      parentId = ownString(entry, 'parent_id', `${pathLabel}.sessions[${index}]`, SESSION_ID_PATTERN);
    }
    if (role === 'native_helper' && parentId == null) {
      fail('invalid_format', `${pathLabel}.sessions[${index}] native_helper requires parent_id.`);
    }
    if (role === 'parent' && parentId != null) {
      fail('invalid_format', `${pathLabel}.sessions[${index}] parent cannot declare parent_id.`);
    }
    const record = { id, role, path: relativePath, parent_id: parentId };
    sessions.push(record);
    sessionById.set(id, record);
  }
  for (const session of sessions) {
    if (session.parent_id != null && !sessionById.has(session.parent_id)) {
      fail('identity_mismatch', `${pathLabel} session ${session.id} parent_id is not allowlisted.`);
    }
  }

  const phasesInput = manifest.phases;
  if (!Array.isArray(phasesInput) || phasesInput.length < 1 || phasesInput.length > MAX_PHASES) {
    fail('bounds_exceeded', `${pathLabel}.phases`);
  }
  const phases = [];
  const attemptIds = new Set();
  for (let index = 0; index < phasesInput.length; index += 1) {
    const entry = assertPlain(phasesInput[index], `${pathLabel}.phases[${index}]`);
    const attemptId = ownString(entry, 'attempt_id', `${pathLabel}.phases[${index}]`, ID_PATTERN);
    if (attemptIds.has(attemptId)) {
      fail('duplicate_id', `${pathLabel}.phases duplicate attempt_id ${attemptId}`);
    }
    attemptIds.add(attemptId);
    const kind = ownString(entry, 'kind', `${pathLabel}.phases[${index}]`);
    if (!ATTEMPT_KINDS.includes(kind)) fail('invalid_format', `${pathLabel}.phases[${index}].kind`);
    const outcome = ownString(entry, 'outcome', `${pathLabel}.phases[${index}]`);
    if (!ATTEMPT_OUTCOMES.includes(outcome)) {
      fail('invalid_format', `${pathLabel}.phases[${index}].outcome`);
    }
    const sequence = Object.hasOwn(entry, 'sequence')
      ? ownInteger(entry, 'sequence', `${pathLabel}.phases[${index}]`, 1, MAX_PHASES)
      : index + 1;
    const phaseStart = parseIso(entry.start, `${pathLabel}.phases[${index}].start`);
    const phaseEnd = parseIso(entry.end, `${pathLabel}.phases[${index}].end`);
    if (phaseEnd.ms < phaseStart.ms) {
      fail('invalid_format', `${pathLabel}.phases[${index}] end precedes start.`);
    }
    if (phaseStart.ms < start.ms || phaseEnd.ms > end.ms) {
      fail('identity_mismatch', `${pathLabel}.phases[${index}] escapes the trial window.`);
    }
    const sessionId = ownString(entry, 'session_id', `${pathLabel}.phases[${index}]`, SESSION_ID_PATTERN);
    if (!sessionById.has(sessionId)) {
      fail('identity_mismatch', `${pathLabel}.phases[${index}].session_id is not allowlisted.`);
    }
    const session = sessionById.get(sessionId);
    if (kind === 'native_helper' && session.role !== 'native_helper') {
      fail('identity_mismatch', `${pathLabel}.phases[${index}] helper phase requires helper session.`);
    }
    if (kind !== 'native_helper' && session.role !== 'parent') {
      fail('identity_mismatch', `${pathLabel}.phases[${index}] non-helper phase requires parent session.`);
    }
    let provider = null;
    let model = null;
    if (Object.hasOwn(entry, 'provider') || Object.hasOwn(entry, 'model')) {
      provider = ownString(entry, 'provider', `${pathLabel}.phases[${index}]`);
      model = ownString(entry, 'model', `${pathLabel}.phases[${index}]`);
    }
    phases.push({
      attempt_id: attemptId,
      kind,
      outcome,
      sequence,
      start: phaseStart,
      end: phaseEnd,
      session_id: sessionId,
      provider,
      model,
    });
  }

  for (let i = 0; i < phases.length; i += 1) {
    for (let j = i + 1; j < phases.length; j += 1) {
      const left = phases[i];
      const right = phases[j];
      if (left.session_id !== right.session_id) continue;
      // Adjacent boundaries may touch; interior overlap is rejected.
      const overlap = left.start.ms < right.end.ms && right.start.ms < left.end.ms;
      if (overlap) {
        fail(
          'identity_mismatch',
          `${pathLabel}.phases ${left.attempt_id} and ${right.attempt_id} overlap on one session.`,
        );
      }
    }
  }

  const accepted = Object.hasOwn(trial, 'accepted')
    ? (trial.accepted === null ? null : ownBoolean(trial, 'accepted', `${pathLabel}.trial`))
    : null;

  return {
    schema: MANIFEST_SCHEMA_ID,
    trial: {
      trial_id: ownString(trial, 'trial_id', `${pathLabel}.trial`, ID_PATTERN),
      case_id: ownString(trial, 'case_id', `${pathLabel}.trial`, ID_PATTERN),
      arm: ownString(trial, 'arm', `${pathLabel}.trial`),
      base_sha: ownString(trial, 'base_sha', `${pathLabel}.trial`, SHA40),
      input_digest: ownString(trial, 'input_digest', `${pathLabel}.trial`, SHA256),
      coengineer_source: assertPlain(trial.coengineer_source, `${pathLabel}.trial.coengineer_source`),
      host_model: ownString(trial, 'host_model', `${pathLabel}.trial`),
      host_settings: assertPlain(trial.host_settings, `${pathLabel}.trial.host_settings`),
      provider_configuration: assertPlain(
        trial.provider_configuration,
        `${pathLabel}.trial.provider_configuration`,
      ),
      accepted,
    },
    window: { start, end },
    sessions,
    phases,
  };
}

function parseEventLine(line, pathLabel, lineNumber) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail('invalid_format', `${pathLabel}:${lineNumber} is not JSON.`);
  }
  const event = assertPlain(parsed, `${pathLabel}:${lineNumber}`);
  const timestamp = parseIso(ownString(event, 'timestamp', `${pathLabel}:${lineNumber}`), `${pathLabel}:${lineNumber}.timestamp`);
  const type = ownString(event, 'type', `${pathLabel}:${lineNumber}`);
  const payload = Object.hasOwn(event, 'payload') ? event.payload : {};
  return { timestamp, type, payload, lineNumber };
}

function collectResponseRecord(payload, pathLabel) {
  const record = assertPlain(payload, pathLabel);
  const responseId = ownString(record, 'response_id', pathLabel);
  const usage = parseCounters(record.usage, `${pathLabel}.usage`);
  const thread = parseCounters(record.thread_token_usage, `${pathLabel}.thread_token_usage`);
  return { response_id: responseId, usage, thread_token_usage: thread };
}

async function readAllowlistedSession(absolutePath, relativePath, pathLabel) {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return { status: 'absent', relativePath, bytes: null, digest: null, events: [], text: null };
  }
  if (!info.isFile()) fail('invalid_type', `${pathLabel} is not a file.`);
  if (info.size > MAX_SESSION_BYTES) fail('bounds_exceeded', `${pathLabel} exceeds ${MAX_SESSION_BYTES} bytes.`);
  const text = await readFile(absolutePath, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSION_BYTES) {
    fail('bounds_exceeded', `${pathLabel} exceeds ${MAX_SESSION_BYTES} bytes.`);
  }
  const digest = sha256Hex(['session-bytes', relativePath, text]);
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length > MAX_LINES) fail('bounds_exceeded', `${pathLabel} has too many events.`);
  const events = lines.map((line, index) => parseEventLine(line, pathLabel, index + 1));
  return {
    status: 'present',
    relativePath,
    bytes: Buffer.byteLength(text, 'utf8'),
    digest,
    events,
    text,
  };
}

function analyzeSessionEvents(events, window) {
  let model = null;
  let effort = null;
  const responses = new Map();
  const childLinks = [];
  const compactedAt = [];
  let secondaryTotal = null;
  let lastThread = null;
  let primaryComplete = true;
  const notes = [];

  for (const event of events) {
    if (event.timestamp.ms < window.start.ms || event.timestamp.ms > window.end.ms) {
      continue;
    }
    if (event.type === 'turn_context') {
      const payload = assertPlain(event.payload, `event:${event.lineNumber}.payload`);
      if (Object.hasOwn(payload, 'model')) {
        model = ownString(payload, 'model', `event:${event.lineNumber}.payload`);
      }
      if (Object.hasOwn(payload, 'effort')) {
        const value = payload.effort;
        if (typeof value !== 'string' && typeof value !== 'number' && value !== null) {
          fail('invalid_type', `event:${event.lineNumber}.payload.effort`);
        }
        effort = value;
      }
      continue;
    }
    if (event.type === 'token_usage_record') {
      const record = collectResponseRecord(event.payload, `event:${event.lineNumber}.payload`);
      const previous = responses.get(record.response_id);
      if (previous) {
        if (!countersEqual(previous.usage, record.usage)
          || !countersEqual(previous.thread_token_usage, record.thread_token_usage)) {
          fail(
            'identity_mismatch',
            `conflicting duplicate response_id ${record.response_id}`,
          );
        }
        previous.duplicate_count += 1;
      } else {
        responses.set(record.response_id, {
          ...record,
          timestamp: event.timestamp,
          model,
          effort,
          duplicate_count: 1,
        });
      }
      lastThread = record.thread_token_usage;
      continue;
    }
    if (event.type === 'compacted') {
      // Compaction outputs already appear inside token_usage_record rows.
      compactedAt.push(event.timestamp.ms);
      continue;
    }
    if (event.type === 'event_msg') {
      const payload = assertPlain(event.payload, `event:${event.lineNumber}.payload`);
      const innerType = ownString(payload, 'type', `event:${event.lineNumber}.payload`);
      if (innerType === 'item_completed') {
        const item = assertPlain(payload.item, `event:${event.lineNumber}.payload.item`);
        if (item.type === 'SubAgentActivity' && item.kind === 'started') {
          childLinks.push({
            agent_thread_id: ownString(item, 'agent_thread_id', `event:${event.lineNumber}.payload.item`),
            agent_path: ownString(item, 'agent_path', `event:${event.lineNumber}.payload.item`),
            timestamp: event.timestamp,
          });
        }
        continue;
      }
      if (innerType === 'token_count') {
        const info = payload.info == null ? null : assertPlain(payload.info, `event:${event.lineNumber}.payload.info`);
        if (info && Object.hasOwn(info, 'total_token_usage')) {
          secondaryTotal = parseCounters(
            info.total_token_usage,
            `event:${event.lineNumber}.payload.info.total_token_usage`,
          );
        }
      }
    }
  }

  const summed = emptyCounters();
  for (const record of responses.values()) addCounters(summed, record.usage);

  if (responses.size === 0) {
    primaryComplete = false;
    notes.push('missing_primary_token_usage_records');
  } else if (lastThread && !countersEqual(summed, lastThread)) {
    primaryComplete = false;
    notes.push('response_sum_thread_mismatch');
  }

  if (secondaryTotal && lastThread && !countersEqual(secondaryTotal, lastThread)) {
    // Secondary cumulative totals may omit compaction; keep primary authoritative.
    notes.push('secondary_token_count_diverges');
  }

  return {
    model,
    effort,
    responses,
    childLinks,
    compactedCount: compactedAt.length,
    summed,
    lastThread,
    secondaryTotal,
    primaryComplete,
    notes,
  };
}

function resolveLinkedChildren(seedIds, sessionsById, analyzedById) {
  const seen = new Set();
  const queue = [...seedIds];
  const ordered = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    const analysis = analyzedById.get(id);
    if (!analysis) continue;
    for (const link of analysis.childLinks) {
      for (const session of sessionsById.values()) {
        if (session.id === link.agent_thread_id
          || session.path === link.agent_path
          || session.path.endsWith(`/${link.agent_path}`)
          || path.basename(session.path) === path.basename(link.agent_path)) {
          if (!seen.has(session.id)) queue.push(session.id);
        }
      }
    }
    for (const session of sessionsById.values()) {
      if (session.parent_id === id && !seen.has(session.id)) queue.push(session.id);
    }
  }
  return ordered;
}

function assignResponsesToPhases(phases, analyzedById) {
  const byPhase = new Map();
  const unassigned = [];
  for (const phase of phases) byPhase.set(phase.attempt_id, []);

  for (const phase of phases) {
    const analysis = analyzedById.get(phase.session_id);
    if (!analysis) continue;
    for (const record of analysis.responses.values()) {
      if (record.timestamp.ms < phase.start.ms || record.timestamp.ms > phase.end.ms) continue;
      byPhase.get(phase.attempt_id).push(record);
    }
  }

  const claimed = new Set();
  for (const records of byPhase.values()) {
    for (const record of records) claimed.add(record.response_id);
  }
  for (const phase of phases) {
    const analysis = analyzedById.get(phase.session_id);
    if (!analysis) continue;
    for (const record of analysis.responses.values()) {
      if (claimed.has(record.response_id)) continue;
      if (record.timestamp.ms < phase.start.ms || record.timestamp.ms > phase.end.ms) {
        // outside this phase; may belong to another phase on same session
        continue;
      }
    }
  }
  for (const [sessionId, analysis] of analyzedById.entries()) {
    for (const record of analysis.responses.values()) {
      if (claimed.has(record.response_id)) continue;
      const owning = phases.filter((phase) => (
        phase.session_id === sessionId
        && record.timestamp.ms >= phase.start.ms
        && record.timestamp.ms <= phase.end.ms
      ));
      if (owning.length === 0) unassigned.push({ session_id: sessionId, response_id: record.response_id });
    }
  }
  return { byPhase, unassigned };
}

function buildAttemptUsage(phase, records, sessionAnalysis, options) {
  const inconclusive = options.inconclusive;
  const sums = emptyCounters();
  const models = new Map();
  for (const record of records) {
    addCounters(sums, record.usage);
    const key = record.model ?? 'unknown';
    const bucket = models.get(key) ?? emptyCounters();
    addCounters(bucket, record.usage);
    models.set(key, bucket);
  }

  const elapsed = phase.end.ms - phase.start.ms;
  const helperCalls = phase.kind === 'native_helper' ? 1 : 0;
  const correctionRounds = phase.kind === 'correction' ? 1 : 0;

  // A fully observed empty phase is zero, not unknown. Incomplete primary
  // evidence stays unknown and is never coerced to zero.
  const measured = !inconclusive && sessionAnalysis?.primaryComplete === true;
  const usage = {
    native_input_tokens: measured ? hostMetric(sums.input_tokens) : unknownMetric(),
    native_output_tokens: measured ? hostMetric(sums.output_tokens) : unknownMetric(),
    native_helper_calls: hostMetric(helperCalls),
    correction_rounds: hostMetric(correctionRounds),
    elapsed_ms: hostMetric(elapsed),
    provider_input_tokens: unknownMetric(),
    provider_output_tokens: unknownMetric(),
    provider_cost_millicents: unknownMetric(),
    model_facing_bytes: unknownMetric(),
    // Session byte sizes stay in evidence digests; per-attempt evidence_bytes
    // would double-count shared session files across phases.
    evidence_bytes: unknownMetric(),
  };

  return {
    usage,
    breakdown: {
      input_tokens: measured ? sums.input_tokens : null,
      cached_input_tokens: measured ? sums.cached_input_tokens : null,
      output_tokens: measured ? sums.output_tokens : null,
      reasoning_output_tokens: measured ? sums.reasoning_output_tokens : null,
      compaction_events: sessionAnalysis?.compactedCount ?? null,
      by_model: [...models.entries()].map(([model, counters]) => ({
        model,
        ...counters,
      })),
    },
  };
}

export async function collectTrialUsage(manifestInput, options = {}) {
  const manifest = parseManifest(manifestInput);
  const sessionsRoot = options.sessionsRoot
    ? path.resolve(options.sessionsRoot)
    : process.cwd();

  const sessionsById = new Map(manifest.sessions.map((session) => [session.id, session]));
  const loadedById = new Map();
  const analyzedById = new Map();
  const evidence = {
    session_digests: {},
    link_digests: [],
    notes: [],
  };
  let incomplete = false;

  for (const session of manifest.sessions) {
    const absolute = path.resolve(sessionsRoot, session.path);
    if (!absolute.startsWith(sessionsRoot + path.sep) && absolute !== sessionsRoot) {
      fail('invalid_format', `session ${session.id} resolves outside sessions root.`);
    }
    const loaded = await readAllowlistedSession(absolute, session.path, `session:${session.id}`);
    loadedById.set(session.id, loaded);
    if (loaded.status === 'absent') {
      incomplete = true;
      evidence.notes.push(`absent_session:${session.id}`);
      analyzedById.set(session.id, {
        model: null,
        effort: null,
        responses: new Map(),
        childLinks: [],
        compactedCount: 0,
        summed: emptyCounters(),
        lastThread: null,
        secondaryTotal: null,
        primaryComplete: false,
        notes: ['absent_session'],
        bytes: null,
        digest: null,
      });
      continue;
    }
    evidence.session_digests[session.id] = loaded.digest;
    const analysis = analyzeSessionEvents(loaded.events, manifest.window);
    analysis.bytes = loaded.bytes;
    analysis.digest = loaded.digest;
    analyzedById.set(session.id, analysis);
    if (!analysis.primaryComplete) {
      incomplete = true;
      evidence.notes.push(...analysis.notes.map((note) => `${session.id}:${note}`));
    } else if (analysis.notes.length > 0) {
      evidence.notes.push(...analysis.notes.map((note) => `${session.id}:${note}`));
    }
    for (const link of analysis.childLinks) {
      evidence.link_digests.push(sha256Hex([
        'child-link',
        session.id,
        link.agent_thread_id,
        path.basename(link.agent_path),
      ]));
      const matched = [...sessionsById.values()].some((candidate) => (
        candidate.id === link.agent_thread_id
        || candidate.path === link.agent_path
        || path.basename(candidate.path) === path.basename(link.agent_path)
      ));
      if (!matched) {
        // Linked helper observed but not allowlisted: do not scan; mark incomplete.
        incomplete = true;
        evidence.notes.push(`unallowlisted_child_link:${session.id}`);
      }
    }
  }

  const parentIds = manifest.sessions.filter((session) => session.role === 'parent').map((s) => s.id);
  const walkOrder = resolveLinkedChildren(parentIds, sessionsById, analyzedById);
  for (const session of manifest.sessions) {
    if (!walkOrder.includes(session.id) && session.role === 'native_helper') {
      // Explicitly allowlisted helpers are still included even without a live link event.
      walkOrder.push(session.id);
    }
  }

  const assignment = assignResponsesToPhases(manifest.phases, analyzedById);
  if (assignment.unassigned.length > 0) {
    incomplete = true;
    evidence.notes.push(`unassigned_responses:${assignment.unassigned.length}`);
  }

  const hasHelpers = manifest.phases.some((phase) => phase.kind === 'native_helper');
  const hasParent = manifest.phases.some((phase) => phase.kind !== 'native_helper');
  if (hasHelpers && hasParent) {
    // Parent rows must exclude separately reported helper usage.
  }

  const attempts = [];
  const breakdownAttempts = [];
  for (const phase of manifest.phases) {
    const records = assignment.byPhase.get(phase.attempt_id) ?? [];
    const analysis = analyzedById.get(phase.session_id);
    const phaseIncomplete = incomplete
      || analysis?.primaryComplete !== true
      || (phase.kind === 'native_helper' && loadedById.get(phase.session_id)?.status === 'absent');
    const built = buildAttemptUsage(phase, records, analysis, { inconclusive: phaseIncomplete });
    const attempt = {
      attempt_id: phase.attempt_id,
      kind: phase.kind,
      outcome: phase.outcome,
      sequence: phase.sequence,
      usage: built.usage,
    };
    if (phase.provider != null) {
      attempt.provider = phase.provider;
      attempt.model = phase.model;
    }
    attempts.push(attempt);
    breakdownAttempts.push({
      attempt_id: phase.attempt_id,
      session_id: phase.session_id,
      ...built.breakdown,
    });
  }

  const wall = manifest.window.end.ms - manifest.window.start.ms;
  const trial = {
    schema: TRIAL_SCHEMA_ID,
    trial_id: manifest.trial.trial_id,
    case_id: manifest.trial.case_id,
    arm: manifest.trial.arm,
    base_sha: manifest.trial.base_sha,
    input_digest: manifest.trial.input_digest,
    coengineer_source: manifest.trial.coengineer_source,
    host_model: manifest.trial.host_model,
    host_settings: manifest.trial.host_settings,
    provider_configuration: manifest.trial.provider_configuration,
    accepted: manifest.trial.accepted,
    wall_elapsed_ms: hostMetric(wall),
    attempts,
  };
  if (hasHelpers && hasParent) {
    trial.native_parent_excludes_helpers = true;
  }

  const parsedTrial = parseTrial(trial);
  // Re-emit the analyzer-accepted trial shape without internal-only fields.
  const emittedTrial = {
    schema: parsedTrial.schema,
    trial_id: parsedTrial.trial_id,
    case_id: parsedTrial.case_id,
    arm: parsedTrial.arm,
    base_sha: parsedTrial.base_sha,
    input_digest: parsedTrial.input_digest,
    coengineer_source: {
      kind: parsedTrial.coengineer_source.kind,
      value: parsedTrial.coengineer_source.value,
    },
    host_model: parsedTrial.host_model,
    host_settings: parsedTrial.host_settings,
    provider_configuration: parsedTrial.provider_configuration,
    accepted: parsedTrial.accepted,
    wall_elapsed_ms: {
      value: parsedTrial.wall_elapsed_ms.value,
      source: parsedTrial.wall_elapsed_ms.source,
      trust: parsedTrial.wall_elapsed_ms.trust,
    },
    attempts: parsedTrial.attempts.map((attempt) => {
      const row = {
        attempt_id: attempt.attempt_id,
        kind: attempt.kind,
        outcome: attempt.outcome,
        sequence: attempt.sequence,
        usage: Object.fromEntries(
          Object.entries(attempt.usage).map(([key, metric]) => [key, {
            value: metric.value,
            source: metric.source,
            trust: metric.trust,
          }]),
        ),
      };
      if (attempt.provider != null) {
        row.provider = attempt.provider;
        row.model = attempt.model;
      }
      return row;
    }),
  };
  if (parsedTrial.native_parent_excludes_helpers) {
    emittedTrial.native_parent_excludes_helpers = true;
  }

  const totals = {
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    compaction_events: 0,
  };
  if (!incomplete) {
    for (const key of [
      'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens',
    ]) {
      totals[key] = 0;
    }
    for (const row of breakdownAttempts) {
      for (const key of [
        'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens',
      ]) {
        if (row[key] == null) totals[key] = null;
        else if (totals[key] != null) totals[key] += row[key];
      }
      totals.compaction_events += row.compaction_events ?? 0;
    }
  } else {
    totals.compaction_events = null;
  }

  const report = {
    schema: REPORT_SCHEMA_ID,
    status: incomplete ? 'inconclusive' : 'complete',
    trial: emittedTrial,
    breakdown: {
      attempts: breakdownAttempts,
      totals,
      accounting: {
        response_id_deduped: true,
        compaction_counted_once: true,
        reasoning_included_in_output: true,
        secondary_token_count: 'non_authoritative',
        native_parent_excludes_helpers: Boolean(emittedTrial.native_parent_excludes_helpers),
        walked_sessions: walkOrder,
      },
    },
    evidence: {
      digests: {
        manifest: sha256Hex(['manifest', JSON.stringify(manifestInput)]),
        sessions: evidence.session_digests,
        links: evidence.link_digests,
        trial: sha256Hex(['trial', JSON.stringify(emittedTrial)]),
      },
      notes: evidence.notes,
      incomplete_primary_evidence: incomplete,
    },
  };

  assertNoPrivacyLeak(report);
  return report;
}

function parseArgs(argv) {
  const flags = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (BOOLEAN_FLAGS.includes(arg)) {
      flags[arg] = true;
      continue;
    }
    if (VALUE_FLAGS.includes(arg)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) {
        fail('invalid_format', `${arg} requires a value.`);
      }
      flags[arg] = value;
      index += 1;
      continue;
    }
    fail('invalid_format', `Unknown flag ${arg}.`);
  }
  return flags;
}

function printHelp(stdout) {
  stdout.write(`Usage:
  node scripts/collect-coengineer-trial-usage.mjs --manifest FILE [--sessions-root DIR] [--write FILE]

Offline host accounting from an explicit allowlisted session manifest.
Session files are read-only. Output defaults to stdout. --write is required
to persist a report. Budget and paid-run setup are separate and unsupported
here. Unknown is never coerced to zero.
`);
}

export async function main(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
}) {
  const flags = parseArgs(argv);
  if (flags['--help']) {
    printHelp(io.stdout);
    return 0;
  }
  if (flags['--manifest'] == null) {
    io.stderr.write('Missing --manifest FILE.\n');
    return 2;
  }
  const manifestPath = path.resolve(io.cwd ?? process.cwd(), flags['--manifest']);
  const info = await stat(manifestPath);
  if (info.size > MAX_MANIFEST_BYTES) fail('bounds_exceeded', 'manifest exceeds size bound.');
  const text = await readFile(manifestPath, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    fail('bounds_exceeded', 'manifest exceeds size bound.');
  }
  const manifest = JSON.parse(text);
  const sessionsRoot = flags['--sessions-root']
    ? path.resolve(io.cwd ?? process.cwd(), flags['--sessions-root'])
    : (io.cwd ?? process.cwd());
  const report = await collectTrialUsage(manifest, { sessionsRoot });
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  if (flags['--write']) {
    const outPath = path.resolve(io.cwd ?? process.cwd(), flags['--write']);
    await writeFile(outPath, payload, 'utf8');
    io.stdout.write(`wrote ${path.basename(outPath)} status=${report.status}\n`);
  } else {
    io.stdout.write(payload);
  }
  return report.status === 'complete' ? 0 : 0;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const code = error?.code ?? 'internal_error';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
