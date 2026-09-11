#!/usr/bin/env node
// Offline host-accounting importer for sanitized Codex session JSONL.
// Reads only allowlisted paths from an explicit manifest. Never mutates
// session files. Emits benchmark-trial.v1 rows for compare-coengineer-runs.mjs
// plus a separate breakdown and evidence digests. Provider jobs and live
// budget setup are out of scope.

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile, stat } from 'node:fs/promises';
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
const SETTINGS_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 262_144;
const MAX_SESSION_BYTES = 8_388_608;
const MAX_SESSIONS = 32;
const MAX_PHASES = 32;
const MAX_LINES = 200_000;
const BOOLEAN_FLAGS = Object.freeze(['--help']);
const VALUE_FLAGS = Object.freeze(['--manifest', '--write', '--sessions-root']);

const REQUIRED_COUNTERS = Object.freeze([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]);
const OPTIONAL_COUNTERS = Object.freeze(['cache_write_input_tokens']);
const USAGE_COUNTERS = Object.freeze([...REQUIRED_COUNTERS, ...OPTIONAL_COUNTERS]);

const HOST_SETTINGS_KEYS = Object.freeze(['reasoning', 'sandbox']);
const PROVIDER_CONFIGURATION_KEYS = Object.freeze(['implement', 'review']);
const PROVIDER_ROLE_KEYS = Object.freeze(['provider', 'model']);
const AGENT_NAME_PATTERN = /^[a-z0-9_]+$/u;

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
  const out = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  for (const key of OPTIONAL_COUNTERS) out[key] = 0;
  return out;
}

function parseCounters(value, pathLabel) {
  const record = assertPlain(value, pathLabel);
  const out = emptyCounters();
  for (const key of REQUIRED_COUNTERS) {
    if (!Object.hasOwn(record, key)) {
      fail('missing_key', `${pathLabel}.${key} is required.`);
    }
    out[key] = ownInteger(record, key, pathLabel, 0, Number.MAX_SAFE_INTEGER);
  }
  for (const key of OPTIONAL_COUNTERS) {
    if (Object.hasOwn(record, key)) {
      out[key] = ownInteger(record, key, pathLabel, 0, Number.MAX_SAFE_INTEGER);
    }
  }
  for (const key of Object.keys(record)) {
    if (!USAGE_COUNTERS.includes(key)) fail('unknown_key', `${pathLabel}.${key}`);
  }
  // Reasoning is a subset of output; never treat it as an additive summand.
  // Cache counters stay separate from reasoning/output.
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

function cloneCounters(source) {
  return addCounters(emptyCounters(), source);
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

function assertBoundedShareableObject(value, pathLabel, allowedKeys) {
  const record = assertPlain(value, pathLabel);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) fail('unknown_key', `${pathLabel}.${key}`);
    const child = record[key];
    if (child === null) continue;
    if (typeof child === 'boolean') continue;
    if (typeof child === 'number' && Number.isSafeInteger(child)) continue;
    if (typeof child === 'string') {
      if (!SETTINGS_TOKEN.test(child) || child.includes('/') || child.includes('\\')) {
        fail('privacy_leak', `${pathLabel}.${key} must be a bounded shareable token.`);
      }
      continue;
    }
    fail('invalid_type', `${pathLabel}.${key} must be a bounded shareable value.`);
  }
  return record;
}

function assertProviderConfiguration(value, pathLabel) {
  const record = assertPlain(value, pathLabel);
  for (const key of Object.keys(record)) {
    if (!PROVIDER_CONFIGURATION_KEYS.includes(key)) fail('unknown_key', `${pathLabel}.${key}`);
    const child = record[key];
    if (child === null) continue;
    if (typeof child === 'string') {
      if (!SETTINGS_TOKEN.test(child) || child.includes('/') || child.includes('\\')) {
        fail('privacy_leak', `${pathLabel}.${key} must be a bounded shareable token.`);
      }
      continue;
    }
    if (isPlainObject(child)) {
      assertBoundedShareableObject(child, `${pathLabel}.${key}`, PROVIDER_ROLE_KEYS);
      continue;
    }
    fail(
      'invalid_type',
      `${pathLabel}.${key} must be a bounded token or {provider,model} object.`,
    );
  }
  return record;
}

function assertAgentPath(value, pathLabel) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) {
    fail('invalid_format', `${pathLabel} is not a canonical agent path.`);
  }
  if (value === '/morpheus') return value;
  if (!value.startsWith('/root') || value.endsWith('/')) {
    fail('invalid_format', `${pathLabel} must be /root[/name...] or /morpheus.`);
  }
  const segments = value.slice(1).split('/');
  if (segments[0] !== 'root') {
    fail('invalid_format', `${pathLabel} must start with /root.`);
  }
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === 'root' || !AGENT_NAME_PATTERN.test(segment)) {
      fail('invalid_format', `${pathLabel} has an invalid agent path segment.`);
    }
  }
  return value;
}

function normalizeEffort(value) {
  if (value === null || value === 'default') return 'default';
  return value;
}

function extractStartedChildLink(payload, pathLabel) {
  const record = assertPlain(payload, pathLabel);
  const innerType = ownString(record, 'type', pathLabel);
  let agentThreadId = null;
  let agentPath = null;
  if (innerType === 'sub_agent_activity') {
    if (ownString(record, 'kind', pathLabel) !== 'started') return null;
    agentThreadId = ownString(record, 'agent_thread_id', pathLabel);
    agentPath = assertAgentPath(ownString(record, 'agent_path', pathLabel), `${pathLabel}.agent_path`);
  } else if (innerType === 'item_completed') {
    const item = assertPlain(record.item, `${pathLabel}.item`);
    if (item.type !== 'SubAgentActivity') return null;
    if (ownString(item, 'kind', `${pathLabel}.item`) !== 'started') return null;
    agentThreadId = ownString(item, 'agent_thread_id', `${pathLabel}.item`);
    agentPath = assertAgentPath(
      ownString(item, 'agent_path', `${pathLabel}.item`),
      `${pathLabel}.item.agent_path`,
    );
  } else {
    return null;
  }
  return { agent_thread_id: agentThreadId, agent_path: agentPath };
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

function assertAcyclicParentGraph(sessions, sessionById, pathLabel) {
  for (const session of sessions) {
    const seen = new Set();
    let current = session;
    while (current.parent_id != null) {
      if (seen.has(current.id)) {
        fail('identity_mismatch', `${pathLabel} session parent graph contains a cycle.`);
      }
      seen.add(current.id);
      current = sessionById.get(current.parent_id);
      if (!current) break;
    }
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
  const pathsSeen = new Set();
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
    if (pathsSeen.has(relativePath)) {
      fail('duplicate_id', `${pathLabel}.sessions duplicate path ${relativePath}`);
    }
    pathsSeen.add(relativePath);
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
    const record = { id, role, path: relativePath, parent_id: parentId, agent_path: null, expected_model: null };
    if (Object.hasOwn(entry, 'agent_path') && entry.agent_path != null) {
      record.agent_path = assertAgentPath(
        ownString(entry, 'agent_path', `${pathLabel}.sessions[${index}]`),
        `${pathLabel}.sessions[${index}].agent_path`,
      );
    }
    if (Object.hasOwn(entry, 'expected_model') && entry.expected_model != null) {
      record.expected_model = ownString(
        entry,
        'expected_model',
        `${pathLabel}.sessions[${index}]`,
        SETTINGS_TOKEN,
      );
    }
    if (role === 'parent' && record.expected_model != null) {
      fail('invalid_format', `${pathLabel}.sessions[${index}] parent uses trial.host_model.`);
    }
    sessions.push(record);
    sessionById.set(id, record);
  }
  for (const session of sessions) {
    if (session.parent_id != null && !sessionById.has(session.parent_id)) {
      fail('identity_mismatch', `${pathLabel} session ${session.id} parent_id is not allowlisted.`);
    }
  }
  assertAcyclicParentGraph(sessions, sessionById, pathLabel);

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

  let accepted = undefined;
  let acceptanceKnown = false;
  if (Object.hasOwn(trial, 'accepted') && trial.accepted !== null) {
    accepted = ownBoolean(trial, 'accepted', `${pathLabel}.trial`);
    acceptanceKnown = true;
  }

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
      host_settings: assertBoundedShareableObject(
        trial.host_settings,
        `${pathLabel}.trial.host_settings`,
        HOST_SETTINGS_KEYS,
      ),
      provider_configuration: assertProviderConfiguration(
        trial.provider_configuration,
        `${pathLabel}.trial.provider_configuration`,
      ),
      accepted,
      acceptanceKnown,
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
  let threadId = null;
  let sessionIdField = null;
  if (Object.hasOwn(record, 'thread_id') && record.thread_id != null) {
    threadId = ownString(record, 'thread_id', pathLabel);
  }
  if (Object.hasOwn(record, 'session_id') && record.session_id != null) {
    sessionIdField = ownString(record, 'session_id', pathLabel);
  }
  return {
    response_id: responseId,
    usage,
    thread_token_usage: thread,
    thread_id: threadId,
    session_id: sessionIdField,
  };
}

function responseKey(sessionId, responseId) {
  return `${sessionId}\0${responseId}`;
}

function phaseOwnsTimestamp(phase, timestampMs, phasesOnSession) {
  if (timestampMs < phase.start.ms || timestampMs > phase.end.ms) return false;
  if (timestampMs === phase.end.ms) {
    // Endpoints are closed only when no adjacent same-session phase starts here.
    const claimedByNext = phasesOnSession.some(
      (other) => other.attempt_id !== phase.attempt_id && other.start.ms === phase.end.ms,
    );
    return !claimedByNext;
  }
  return true;
}

async function resolvePathInsideRoot(sessionsRoot, relativePath, pathLabel) {
  let rootReal;
  try {
    rootReal = await realpath(sessionsRoot);
  } catch {
    fail('invalid_format', `${pathLabel} sessions root is not resolvable.`);
  }
  const absolute = path.resolve(sessionsRoot, relativePath);
  let candidateReal;
  try {
    candidateReal = await realpath(absolute);
  } catch {
    // Absent files: resolve the deepest existing ancestor and reject escapes.
    let cursor = path.dirname(absolute);
    let resolvedParent = null;
    while (true) {
      try {
        resolvedParent = await realpath(cursor);
        break;
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
    if (resolvedParent == null) {
      fail('invalid_format', `${pathLabel} resolves outside sessions root.`);
    }
    if (resolvedParent !== rootReal && !resolvedParent.startsWith(rootReal + path.sep)) {
      fail('invalid_format', `${pathLabel} resolves outside sessions root.`);
    }
    return { absolute, real: null, rootReal, present: false };
  }
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) {
    fail('invalid_format', `${pathLabel} resolves outside sessions root.`);
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    // Symlink targets were validated via realpath; keep the real path for reads.
  }
  return { absolute, real: candidateReal, rootReal, present: true };
}

async function readAllowlistedSession(resolved, relativePath, pathLabel) {
  if (!resolved.present) {
    return { status: 'absent', relativePath, bytes: null, digest: null, events: [], text: null, realPath: null };
  }
  let info;
  try {
    info = await stat(resolved.real);
  } catch {
    return { status: 'absent', relativePath, bytes: null, digest: null, events: [], text: null, realPath: null };
  }
  if (!info.isFile()) fail('invalid_type', `${pathLabel} is not a file.`);
  if (info.size > MAX_SESSION_BYTES) fail('bounds_exceeded', `${pathLabel} exceeds ${MAX_SESSION_BYTES} bytes.`);
  const text = await readFile(resolved.real, 'utf8');
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
    realPath: resolved.real,
  };
}

function analyzeSessionEvents(events, window, sessionId, options = {}) {
  const expectedHostModel = options.expectedModel ?? null;
  const expectedHostSettings = options.expectedSettings ?? null;
  let model = null;
  let effort = undefined;
  let sawCollabEffort = false;
  let sandbox = null;
  const responses = new Map();
  const childLinks = [];
  const compactedAt = [];
  let secondaryTotal = null;
  let lastThread = null;
  let preWindowThread = emptyCounters();
  let sawPreWindowUsage = false;
  let primaryComplete = true;
  const notes = [];
  let sessionMetaId = null;
  let attributionUnknown = false;

  for (const event of events) {
    const inWindow = event.timestamp.ms >= window.start.ms && event.timestamp.ms <= window.end.ms;

    if (event.type === 'session_meta') {
      const payload = assertPlain(event.payload, `event:${event.lineNumber}.payload`);
      const metaId = ownString(payload, 'id', `event:${event.lineNumber}.payload`);
      if (sessionMetaId != null && sessionMetaId !== metaId) {
        fail('identity_mismatch', `session ${sessionId} has conflicting session_meta ids.`);
      }
      sessionMetaId = metaId;
      if (Object.hasOwn(payload, 'thread_id') && payload.thread_id != null) {
        const threadId = ownString(payload, 'thread_id', `event:${event.lineNumber}.payload`);
        if (threadId !== metaId && threadId !== sessionId) {
          fail(
            'identity_mismatch',
            `session ${sessionId} session_meta thread_id conflicts with manifest binding.`,
          );
        }
      }
      continue;
    }

    if (event.type === 'turn_context') {
      const payload = assertPlain(event.payload, `event:${event.lineNumber}.payload`);
      const pathLabel = `event:${event.lineNumber}.payload`;
      if (Object.hasOwn(payload, 'model')) {
        const nextModel = ownString(payload, 'model', pathLabel);
        if (model != null && model !== nextModel) {
          fail('identity_mismatch', `session ${sessionId} observes conflicting models.`);
        }
        model = nextModel;
      }
      if (Object.hasOwn(payload, 'sandbox_policy') && payload.sandbox_policy != null) {
        const policy = assertPlain(payload.sandbox_policy, `${pathLabel}.sandbox_policy`);
        const nextSandbox = ownString(policy, 'type', `${pathLabel}.sandbox_policy`);
        if (sandbox != null && sandbox !== nextSandbox) {
          fail('identity_mismatch', `session ${sessionId} observes conflicting sandbox_policy.`);
        }
        sandbox = nextSandbox;
      }
      let eventCollabEffort = false;
      if (Object.hasOwn(payload, 'collaboration_mode') && payload.collaboration_mode != null) {
        const collab = assertPlain(payload.collaboration_mode, `${pathLabel}.collaboration_mode`);
        if (Object.hasOwn(collab, 'settings') && collab.settings != null) {
          const settings = assertPlain(collab.settings, `${pathLabel}.collaboration_mode.settings`);
          if (Object.hasOwn(settings, 'model') && settings.model != null) {
            const collabModel = ownString(settings, 'model', `${pathLabel}.collaboration_mode.settings`);
            if (model != null && model !== collabModel) {
              fail(
                'identity_mismatch',
                `session ${sessionId} collaboration_mode model conflicts with turn_context model.`,
              );
            }
            model = collabModel;
          }
          if (Object.hasOwn(settings, 'reasoning_effort')) {
            const value = settings.reasoning_effort;
            if (typeof value !== 'string' && typeof value !== 'number' && value !== null) {
              fail('invalid_type', `${pathLabel}.collaboration_mode.settings.reasoning_effort`);
            }
            if (effort !== undefined && normalizeEffort(effort) !== normalizeEffort(value)) {
              fail('identity_mismatch', `session ${sessionId} observes conflicting reasoning effort.`);
            }
            effort = value;
            sawCollabEffort = true;
            eventCollabEffort = true;
          }
        }
      }
      // Legacy top-level effort: only when collaboration_mode did not emit reasoning_effort.
      if (!eventCollabEffort && Object.hasOwn(payload, 'effort')) {
        const value = payload.effort;
        if (typeof value !== 'string' && typeof value !== 'number' && value !== null) {
          fail('invalid_type', `${pathLabel}.effort`);
        }
        if (sawCollabEffort && normalizeEffort(effort) !== normalizeEffort(value)) {
          fail('identity_mismatch', `session ${sessionId} legacy effort conflicts with collaboration_mode.`);
        }
        if (effort !== undefined && normalizeEffort(effort) !== normalizeEffort(value)) {
          fail('identity_mismatch', `session ${sessionId} observes conflicting reasoning effort.`);
        }
        effort = value;
      }
      if (expectedHostModel != null && model != null && model !== expectedHostModel) {
        fail(
          'identity_mismatch',
          `session ${sessionId} model ${model} conflicts with expected model ${expectedHostModel}.`,
        );
      }
      continue;
    }

    if (event.type === 'token_usage_record') {
      const record = collectResponseRecord(event.payload, `event:${event.lineNumber}.payload`);
      const boundIds = new Set([sessionId]);
      if (sessionMetaId != null) boundIds.add(sessionMetaId);
      if (record.thread_id != null && !boundIds.has(record.thread_id)) {
        fail(
          'identity_mismatch',
          `session ${sessionId} token_usage_record.thread_id conflicts with session binding.`,
        );
      }
      if (record.session_id != null && !boundIds.has(record.session_id)) {
        fail(
          'identity_mismatch',
          `session ${sessionId} token_usage_record.session_id conflicts with session binding.`,
        );
      }
      if (!inWindow) {
        if (event.timestamp.ms < window.start.ms) {
          preWindowThread = cloneCounters(record.thread_token_usage);
          sawPreWindowUsage = true;
          lastThread = record.thread_token_usage;
        }
        continue;
      }
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
          effort: effort === undefined ? null : effort,
          sandbox,
          duplicate_count: 1,
        });
      }
      lastThread = record.thread_token_usage;
      continue;
    }

    if (event.type === 'compacted') {
      if (inWindow) compactedAt.push(event.timestamp.ms);
      continue;
    }

    if (event.type === 'event_msg') {
      const payload = assertPlain(event.payload, `event:${event.lineNumber}.payload`);
      const started = extractStartedChildLink(payload, `event:${event.lineNumber}.payload`);
      if (started) {
        // Parent graph links are collected outside the usage window too.
        childLinks.push({
          ...started,
          timestamp: event.timestamp,
        });
        continue;
      }
      if (!inWindow) continue;
      const innerType = ownString(payload, 'type', `event:${event.lineNumber}.payload`);
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

  if (sessionMetaId == null) {
    attributionUnknown = true;
    notes.push('missing_session_meta');
  } else if (sessionMetaId !== sessionId) {
    fail(
      'identity_mismatch',
      `session ${sessionId} session_meta id ${sessionMetaId} conflicts with manifest id.`,
    );
  }

  if (expectedHostModel != null && model != null && model !== expectedHostModel) {
    fail(
      'identity_mismatch',
      `session ${sessionId} model ${model} conflicts with expected model ${expectedHostModel}.`,
    );
  }

  if (expectedHostSettings != null) {
    if (effort !== undefined) {
      const expectedEffort = expectedHostSettings.reasoning;
      if (normalizeEffort(effort) !== normalizeEffort(expectedEffort)) {
        fail(
          'identity_mismatch',
          `session ${sessionId} reasoning effort conflicts with host_settings.reasoning.`,
        );
      }
    }
    if (sandbox != null && expectedHostSettings.sandbox != null
      && sandbox !== expectedHostSettings.sandbox) {
      fail(
        'identity_mismatch',
        `session ${sessionId} sandbox_policy conflicts with host_settings.sandbox.`,
      );
    }
  }

  const summed = emptyCounters();
  for (const record of responses.values()) addCounters(summed, record.usage);

  if (responses.size === 0 && !sawPreWindowUsage) {
    primaryComplete = false;
    notes.push('missing_primary_token_usage_records');
  } else if (lastThread) {
    const expected = addCounters(cloneCounters(preWindowThread), summed);
    if (!countersEqual(expected, lastThread)) {
      primaryComplete = false;
      notes.push('response_sum_thread_mismatch');
    }
  }

  if (responses.size > 0 && model == null) {
    primaryComplete = false;
    notes.push('missing_observed_model');
  }

  if (secondaryTotal && lastThread) {
    const expectedSecondary = addCounters(cloneCounters(preWindowThread), summed);
    if (!countersEqual(secondaryTotal, expectedSecondary) && !countersEqual(secondaryTotal, lastThread)) {
      // Secondary cumulative totals may omit compaction; keep primary authoritative.
      notes.push('secondary_token_count_diverges');
    }
  }

  if (attributionUnknown) primaryComplete = false;

  return {
    model,
    effort: effort === undefined ? null : effort,
    sandbox,
    responses,
    childLinks,
    compactedAt,
    compactedCount: compactedAt.length,
    summed,
    lastThread,
    preWindowThread: sawPreWindowUsage ? preWindowThread : emptyCounters(),
    secondaryTotal,
    primaryComplete,
    notes,
    sessionMetaId,
    attributionUnknown,
  };
}

function resolveLinkedChildren(seedIds, sessionsById, analyzedById, loadedById) {
  const seen = new Set();
  const visiting = new Set();
  const queue = [...seedIds];
  const ordered = [];
  const unlisted = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    if (visiting.has(id)) {
      fail('identity_mismatch', `linked session graph contains a cycle at ${id}.`);
    }
    visiting.add(id);
    seen.add(id);
    ordered.push(id);
    const analysis = analyzedById.get(id);
    if (analysis) {
      for (const link of analysis.childLinks) {
        const matched = sessionsById.get(link.agent_thread_id);
        if (!matched) {
          // Unlisted started children are not basename-resolved; coverage stays inconclusive.
          unlisted.push({ parent_id: id, agent_thread_id: link.agent_thread_id });
          continue;
        }
        // agent_path is canonical agent identity (/root/helper), not a session file path.
        if (matched.agent_path != null && matched.agent_path !== link.agent_path) {
          fail(
            'identity_mismatch',
            `nested child ${link.agent_thread_id} agent_path conflicts with allowlisted identity.`,
          );
        }
        if (matched.parent_id !== id) {
          fail(
            'identity_mismatch',
            `nested child ${link.agent_thread_id} parent graph conflicts with link from ${id}.`,
          );
        }
        const loaded = loadedById.get(matched.id);
        if (!loaded || loaded.status !== 'present') {
          fail(
            'identity_mismatch',
            `missing nested child session file for ${matched.id}.`,
          );
        }
        if (!seen.has(matched.id)) queue.push(matched.id);
      }
    }
    for (const session of sessionsById.values()) {
      if (session.parent_id === id && !seen.has(session.id)) queue.push(session.id);
    }
    visiting.delete(id);
  }
  return { ordered, unlisted };
}

function assignResponsesToPhases(phases, analyzedById) {
  const byPhase = new Map();
  const compactionByPhase = new Map();
  const unassigned = [];
  for (const phase of phases) {
    byPhase.set(phase.attempt_id, []);
    compactionByPhase.set(phase.attempt_id, 0);
  }

  const phasesBySession = new Map();
  for (const phase of phases) {
    const list = phasesBySession.get(phase.session_id) ?? [];
    list.push(phase);
    phasesBySession.set(phase.session_id, list);
  }

  for (const [sessionId, analysis] of analyzedById.entries()) {
    const sessionPhases = phasesBySession.get(sessionId) ?? [];
    for (const record of analysis.responses.values()) {
      const owning = sessionPhases.filter((phase) => (
        phaseOwnsTimestamp(phase, record.timestamp.ms, sessionPhases)
      ));
      if (owning.length === 0) {
        unassigned.push({
          session_id: sessionId,
          response_id: record.response_id,
          key: responseKey(sessionId, record.response_id),
        });
        continue;
      }
      if (owning.length > 1) {
        fail(
          'identity_mismatch',
          `response ${record.response_id} in session ${sessionId} maps to multiple phases.`,
        );
      }
      byPhase.get(owning[0].attempt_id).push(record);
    }

    const claimedCompaction = new Set();
    for (const stamp of analysis.compactedAt ?? []) {
      const owning = sessionPhases.filter((phase) => phaseOwnsTimestamp(phase, stamp, sessionPhases));
      if (owning.length === 1 && !claimedCompaction.has(stamp)) {
        compactionByPhase.set(
          owning[0].attempt_id,
          (compactionByPhase.get(owning[0].attempt_id) ?? 0) + 1,
        );
        claimedCompaction.add(stamp);
      }
    }
  }

  return { byPhase, compactionByPhase, unassigned };
}

function buildAttemptUsage(phase, records, compactionEvents, sessionAnalysis, options) {
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
      cache_write_input_tokens: measured ? sums.cache_write_input_tokens : null,
      output_tokens: measured ? sums.output_tokens : null,
      reasoning_output_tokens: measured ? sums.reasoning_output_tokens : null,
      compaction_events: measured ? compactionEvents : null,
      by_model: [...models.entries()].map(([model, counters]) => ({
        model,
        ...counters,
      })),
    },
  };
}

function emitTrial(parsedTrial) {
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
  if (parsedTrial.accepted !== null) {
    emittedTrial.accepted = parsedTrial.accepted;
  }
  if (parsedTrial.native_parent_excludes_helpers) {
    emittedTrial.native_parent_excludes_helpers = true;
  }
  return emittedTrial;
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
  let measurementIncomplete = false;
  let coverageIncomplete = false;
  const acceptanceUnknown = !manifest.trial.acceptanceKnown;
  if (acceptanceUnknown) {
    coverageIncomplete = true;
    evidence.notes.push('acceptance_unknown');
  }

  for (const session of manifest.sessions) {
    const resolved = await resolvePathInsideRoot(
      sessionsRoot,
      session.path,
      `session:${session.id}`,
    );
    const loaded = await readAllowlistedSession(resolved, session.path, `session:${session.id}`);
    loadedById.set(session.id, loaded);
    if (loaded.status === 'absent') {
      measurementIncomplete = true;
      coverageIncomplete = true;
      evidence.notes.push(`absent_session:${session.id}`);
      analyzedById.set(session.id, {
        model: null,
        effort: null,
        sandbox: null,
        responses: new Map(),
        childLinks: [],
        compactedAt: [],
        compactedCount: 0,
        summed: emptyCounters(),
        lastThread: null,
        preWindowThread: emptyCounters(),
        secondaryTotal: null,
        primaryComplete: false,
        notes: ['absent_session'],
        bytes: null,
        digest: null,
        sessionMetaId: null,
        attributionUnknown: true,
      });
      continue;
    }
    evidence.session_digests[session.id] = loaded.digest;
    const expectedModel = session.role === 'parent'
      ? manifest.trial.host_model
      : session.expected_model;
    const expectedSettings = session.role === 'parent'
      ? manifest.trial.host_settings
      : null;
    const analysis = analyzeSessionEvents(
      loaded.events,
      manifest.window,
      session.id,
      { expectedModel, expectedSettings },
    );
    analysis.bytes = loaded.bytes;
    analysis.digest = loaded.digest;
    analyzedById.set(session.id, analysis);
    if (!analysis.primaryComplete) {
      measurementIncomplete = true;
      coverageIncomplete = true;
      evidence.notes.push(...analysis.notes.map((note) => `${session.id}:${note}`));
    } else if (analysis.notes.length > 0) {
      evidence.notes.push(...analysis.notes.map((note) => `${session.id}:${note}`));
    }
    for (const link of analysis.childLinks) {
      evidence.link_digests.push(sha256Hex([
        'child-link',
        session.id,
        link.agent_thread_id,
        link.agent_path,
      ]));
    }
  }

  const parentIds = manifest.sessions.filter((session) => session.role === 'parent').map((s) => s.id);
  const walk = resolveLinkedChildren(parentIds, sessionsById, analyzedById, loadedById);
  const walkOrder = walk.ordered;
  if (walk.unlisted.length > 0) {
    coverageIncomplete = true;
    for (const entry of walk.unlisted) {
      evidence.notes.push(`unlisted_nested_child:${entry.parent_id}->${entry.agent_thread_id}`);
    }
  }
  for (const session of manifest.sessions) {
    if (!walkOrder.includes(session.id) && session.role === 'native_helper') {
      // Explicitly allowlisted helpers are still included even without a live link event.
      walkOrder.push(session.id);
    }
  }

  const assignment = assignResponsesToPhases(manifest.phases, analyzedById);
  if (assignment.unassigned.length > 0) {
    measurementIncomplete = true;
    coverageIncomplete = true;
    evidence.notes.push(`unassigned_responses:${assignment.unassigned.length}`);
  }

  const hasHelpers = manifest.phases.some((phase) => phase.kind === 'native_helper');
  const hasParent = manifest.phases.some((phase) => phase.kind !== 'native_helper');

  const attempts = [];
  const breakdownAttempts = [];
  for (const phase of manifest.phases) {
    const records = assignment.byPhase.get(phase.attempt_id) ?? [];
    const analysis = analyzedById.get(phase.session_id);
    if (phase.model != null && analysis?.model != null && phase.model !== analysis.model) {
      fail(
        'identity_mismatch',
        `phase ${phase.attempt_id} model conflicts with observed session model.`,
      );
    }
    const phaseIncomplete = measurementIncomplete
      || analysis?.primaryComplete !== true
      || (phase.kind === 'native_helper' && loadedById.get(phase.session_id)?.status === 'absent');
    const built = buildAttemptUsage(
      phase,
      records,
      assignment.compactionByPhase.get(phase.attempt_id) ?? 0,
      analysis,
      { inconclusive: phaseIncomplete },
    );
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
    wall_elapsed_ms: hostMetric(wall),
    attempts,
  };
  if (manifest.trial.acceptanceKnown) {
    trial.accepted = manifest.trial.accepted;
  }
  if (hasHelpers && hasParent) {
    trial.native_parent_excludes_helpers = true;
  }

  const parsedTrial = parseTrial(trial);
  const emittedTrial = emitTrial(parsedTrial);

  const totals = {
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    compaction_events: 0,
  };
  // Unknown acceptance / unlisted-child coverage keeps the report inconclusive but
  // retains fully measured usage/by_model/cache/compaction totals.
  if (!measurementIncomplete) {
    for (const key of [
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
    ]) {
      totals[key] = 0;
    }
    for (const row of breakdownAttempts) {
      for (const key of [
        'input_tokens',
        'cached_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
        'reasoning_output_tokens',
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
    status: coverageIncomplete ? 'inconclusive' : 'complete',
    trial: emittedTrial,
    breakdown: {
      attempts: breakdownAttempts,
      totals,
      accounting: {
        response_id_deduped: true,
        response_identity: 'session_and_response',
        phase_endpoints: 'start_inclusive_end_exclusive_unless_terminal',
        compaction_counted_once: true,
        reasoning_included_in_output: true,
        cache_counters_separate: true,
        secondary_token_count: 'non_authoritative',
        native_parent_excludes_helpers: Boolean(emittedTrial.native_parent_excludes_helpers),
        walked_sessions: walkOrder,
        acceptance_unknown: acceptanceUnknown,
        measurement_incomplete: measurementIncomplete,
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
      incomplete_primary_evidence: coverageIncomplete,
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

async function assertWriteTargetSafe(outPath, manifestPath, sessionsRoot, manifest) {
  let outReal;
  try {
    outReal = await realpath(outPath);
  } catch {
    try {
      outReal = await realpath(path.dirname(outPath));
      outReal = path.join(outReal, path.basename(outPath));
    } catch {
      outReal = path.resolve(outPath);
    }
  }
  let manifestReal;
  try {
    manifestReal = await realpath(manifestPath);
  } catch {
    manifestReal = path.resolve(manifestPath);
  }
  if (outReal === manifestReal) {
    fail('invalid_format', '--write must not overwrite the manifest.');
  }
  for (const session of manifest.sessions) {
    const resolved = await resolvePathInsideRoot(sessionsRoot, session.path, `session:${session.id}`);
    if (resolved.real && resolved.real === outReal) {
      fail('invalid_format', '--write must not overwrite an input session file.');
    }
    if (path.resolve(sessionsRoot, session.path) === path.resolve(outPath)) {
      fail('invalid_format', '--write must not overwrite an input session file.');
    }
  }
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
    await assertWriteTargetSafe(outPath, manifestPath, sessionsRoot, parseManifest(manifest));
    await writeFile(outPath, payload, 'utf8');
    io.stdout.write(`wrote ${path.basename(outPath)} status=${report.status}\n`);
  } else {
    io.stdout.write(payload);
  }
  return report.status === 'complete' ? 0 : 1;
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
