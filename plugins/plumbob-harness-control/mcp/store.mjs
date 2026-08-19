import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import {
  inspectStateFilePathSync,
  prepareStateFilePathSync,
} from './state.mjs';

/**
 * The public job ledger historically used queued/starting/running and a
 * handful of terminal spellings.  Keep that column readable for old clients,
 * but make lifecycle_state the source of truth for new writers.
 */
export const LIFECYCLE_STATES = Object.freeze([
  'accepted',
  'started',
  'working',
  'completed',
  'failed',
  'cancelled',
  'timeout',
]);
export const TERMINAL_LIFECYCLE_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'timeout',
]);

/**
 * ACP sessions have a deliberately separate lifecycle from the historical
 * job ledger.  In particular, `uncertain` is a durable reconciliation state,
 * not a synonym for failure.  Keep this vocabulary local to the store so
 * callers cannot accidentally map an ambiguous provider result to a
 * definitive terminal outcome.
 */
export const ACP_SESSION_STATES = Object.freeze([
  'creating',
  'ready',
  'prompting',
  'cancelling',
  'uncertain',
  'closed',
  'failed',
]);
export const ACP_TERMINAL_SESSION_STATES = new Set(['closed', 'failed']);
export const ACP_TURN_STATES = Object.freeze([
  'creating',
  'prompting',
  'cancelling',
  'uncertain',
  'completed',
  'closed',
  'failed',
]);
export const ACP_TERMINAL_TURN_STATES = new Set(['completed', 'closed', 'failed']);

export const ACP_SESSION_TRANSITIONS = Object.freeze({
  creating: new Set(['ready', 'uncertain', 'failed']),
  ready: new Set(['prompting', 'cancelling', 'uncertain', 'closed', 'failed']),
  prompting: new Set(['ready', 'cancelling', 'uncertain', 'closed', 'failed']),
  cancelling: new Set(['ready', 'uncertain', 'closed', 'failed']),
  // An uncertain provider operation must be explicitly reconciled.  It can
  // only be sealed by an explicit close/failure decision; it never silently
  // returns to ready or prompting as part of a retry.
  uncertain: new Set(['closed', 'failed']),
  closed: new Set(),
  failed: new Set(),
});

export const ACP_TURN_TRANSITIONS = Object.freeze({
  creating: new Set(['prompting', 'cancelling', 'uncertain', 'completed', 'closed', 'failed']),
  prompting: new Set(['cancelling', 'uncertain', 'completed', 'closed', 'failed']),
  cancelling: new Set(['uncertain', 'completed', 'closed', 'failed']),
  uncertain: new Set(['closed', 'failed']),
  completed: new Set(),
  closed: new Set(),
  failed: new Set(),
});

const STORE_STATE_ROOTS = new WeakMap();

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function acpPathError(field, message) {
  throw new AcpStoreError('invalid_acp_state_path', `${field} ${message}`);
}

function validateAcpStatePath(database, value, field, kind) {
  if (value === null || value === undefined) return null;
  const root = STORE_STATE_ROOTS.get(database);
  if (!root) acpPathError(field, 'cannot be validated without a bound durable state root.');
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
    || !pathIsWithin(root, value)) {
    acpPathError(field, 'must be a canonical absolute path contained beneath the durable state root.');
  }
  const relative = path.relative(root, value).split(path.sep).filter(Boolean);
  const components = [root];
  for (const part of relative) components.push(path.join(components.at(-1), part));
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const snapshots = components.map((component, index) => {
    let metadata;
    try { metadata = lstatSync(component); } catch { acpPathError(field, 'must already be securely provisioned.'); }
    const final = index === components.length - 1;
    if (metadata.isSymbolicLink() || (final && kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())) {
      acpPathError(field, `must contain only real directories and end in a real ${kind}.`);
    }
    if (uid === null || metadata.uid !== uid) acpPathError(field, 'must be owned by the MCP process user.');
    const expectedMode = final && kind === 'file' ? 0o600 : 0o700;
    if ((metadata.mode & 0o7777) !== expectedMode) {
      acpPathError(field, `must have exact owner-only mode ${expectedMode.toString(8).padStart(4, '0')}.`);
    }
    if (final && kind === 'file' && metadata.nlink !== 1) {
      acpPathError(field, 'must have exactly one filesystem link.');
    }
    return { component, dev: metadata.dev, ino: metadata.ino };
  });
  for (const expected of snapshots) {
    let metadata;
    try { metadata = lstatSync(expected.component); } catch {
      acpPathError(field, 'changed while its identity was being validated.');
    }
    if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
      acpPathError(field, 'changed while its identity was being validated.');
    }
  }
  return value;
}

function validateAcpSessionPaths(database, session, { requireProvisioned = false } = {}) {
  const sessionStore = validateAcpStatePath(database, session.session_store_dir, 'session_store_dir', 'directory');
  const eventFile = validateAcpStatePath(database, session.event_file, 'event_file', 'file');
  if ((sessionStore === null) !== (eventFile === null)) {
    acpPathError('ACP session paths', 'must be provisioned together.');
  }
  if (sessionStore && !pathIsWithin(sessionStore, eventFile)) {
    acpPathError('event_file', 'must be contained beneath session_store_dir.');
  }
  if (requireProvisioned && (!sessionStore || !eventFile)) {
    acpPathError('ACP session paths', 'must be securely provisioned before the session can become usable.');
  }
}

const LEGACY_TO_LIFECYCLE = Object.freeze({
  queued: 'accepted',
  starting: 'started',
  running: 'working',
  cancelling: 'working',
  succeeded: 'completed',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timeout',
  timeout: 'timeout',
  uncertain: 'failed',
});

const LIFECYCLE_TO_LEGACY = Object.freeze({
  accepted: 'queued',
  started: 'starting',
  working: 'running',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  timeout: 'timed_out',
});

const COLUMNS = [
  'id',
  'kind',
  'status',
  'summary',
  'created_at',
  'updated_at',
  'started_at',
  'finished_at',
  'exit_code',
  'signal',
  'error',
  'url',
  'request_id',
  'request_fingerprint',
  'runner_pid',
  'child_pid',
  'log_file',
  'cancel_file',
  'output_dir',
  'timeout_seconds',
  'adapter_versions',
  'deadline_at',
  'elapsed_seconds',
  'termination_reason',
  'signal_sent',
  'forced_kill',
  'last_activity_at',
  'partial_output_available',
  'workspace_changed',
  'workspace_tainted',
  'changed_paths',
  'effective_configuration',
  'target_context',
  'heartbeat',
  'stalled',
  'patch_artifact',
  'log_bytes',
  'lifecycle_state',
  'terminal_state',
  'failure_class',
  'last_heartbeat_at',
  'last_output_at',
];
const MUTABLE_COLUMNS = new Set(COLUMNS.filter((column) => column !== 'id'));
const COLUMN_TYPES = {
  deadline_at: 'TEXT',
  elapsed_seconds: 'REAL',
  termination_reason: 'TEXT',
  signal_sent: 'TEXT',
  forced_kill: 'INTEGER',
  last_activity_at: 'TEXT',
  partial_output_available: 'INTEGER',
  workspace_changed: 'INTEGER',
  workspace_tainted: 'INTEGER',
  changed_paths: 'TEXT',
  effective_configuration: 'TEXT',
  target_context: 'TEXT',
  heartbeat: 'TEXT',
  stalled: 'INTEGER',
  patch_artifact: 'TEXT',
  log_bytes: 'INTEGER',
  lifecycle_state: 'TEXT',
  terminal_state: 'TEXT',
  failure_class: 'TEXT',
  last_heartbeat_at: 'TEXT',
  last_output_at: 'TEXT',
};

// These are intentionally metadata-only records.  Do not add prompt,
// transcript, raw-frame, tool-argument, or output-payload columns here:
// provider state lives in the owner-only ACPX session store, while this
// database retains only enough information to reconcile and deduplicate it.
const ACP_SESSION_COLUMNS = [
  'id',
  'job_id',
  'provider',
  'profile',
  'target_fingerprint',
  'target_context',
  'effective_configuration',
  'effective_config',
  'acpx_record_id',
  'state',
  'request_id',
  'request_fingerprint',
  'worker_pid',
  'provider_pid',
  'capability_version',
  'provider_version',
  'capabilities',
  'session_store_dir',
  'event_file',
  'event_cursor',
  'event_count',
  'event_bytes',
  'uncertainty',
  'created_at',
  'updated_at',
  'ready_at',
  'prompting_at',
  'cancelling_at',
  'uncertain_at',
  'closed_at',
  'failed_at',
  'expires_at',
  'ttl_seconds',
  'error_code',
  'error',
];
const ACP_SESSION_MUTABLE_COLUMNS = new Set(
  ACP_SESSION_COLUMNS.filter((column) => !['id', 'job_id', 'created_at'].includes(column)),
);
const ACP_SESSION_COLUMN_TYPES = {
  job_id: 'TEXT',
  provider: 'TEXT',
  profile: 'TEXT',
  target_fingerprint: 'TEXT',
  target_context: 'TEXT',
  effective_configuration: 'TEXT',
  effective_config: 'TEXT',
  acpx_record_id: 'TEXT',
  state: "TEXT DEFAULT 'creating'",
  request_id: 'TEXT',
  request_fingerprint: 'TEXT',
  worker_pid: 'INTEGER',
  provider_pid: 'INTEGER',
  capability_version: 'TEXT',
  provider_version: 'TEXT',
  capabilities: 'TEXT',
  session_store_dir: 'TEXT',
  event_file: 'TEXT',
  event_cursor: 'INTEGER NOT NULL DEFAULT 0',
  event_count: 'INTEGER NOT NULL DEFAULT 0',
  event_bytes: 'INTEGER NOT NULL DEFAULT 0',
  uncertainty: 'TEXT',
  created_at: 'TEXT',
  updated_at: 'TEXT',
  ready_at: 'TEXT',
  prompting_at: 'TEXT',
  cancelling_at: 'TEXT',
  uncertain_at: 'TEXT',
  closed_at: 'TEXT',
  failed_at: 'TEXT',
  expires_at: 'TEXT',
  ttl_seconds: 'INTEGER',
  error_code: 'TEXT',
  error: 'TEXT',
};

const ACP_TURN_COLUMNS = [
  'id',
  'session_id',
  'job_id',
  'request_id',
  'request_fingerprint',
  'state',
  'worker_pid',
  'provider_pid',
  'capability_version',
  'provider_version',
  'event_cursor',
  'event_count',
  'event_bytes',
  'uncertainty',
  'created_at',
  'updated_at',
  'started_at',
  'finished_at',
  'expires_at',
  'ttl_seconds',
  'error_code',
  'error',
  'stop_reason',
];
const ACP_TURN_MUTABLE_COLUMNS = new Set(
  ACP_TURN_COLUMNS.filter((column) => !['id', 'session_id', 'job_id', 'created_at'].includes(column)),
);
const ACP_TURN_COLUMN_TYPES = {
  session_id: 'TEXT',
  job_id: 'TEXT',
  request_id: 'TEXT',
  request_fingerprint: 'TEXT',
  state: "TEXT DEFAULT 'creating'",
  worker_pid: 'INTEGER',
  provider_pid: 'INTEGER',
  capability_version: 'TEXT',
  provider_version: 'TEXT',
  event_cursor: 'INTEGER NOT NULL DEFAULT 0',
  event_count: 'INTEGER NOT NULL DEFAULT 0',
  event_bytes: 'INTEGER NOT NULL DEFAULT 0',
  uncertainty: 'TEXT',
  created_at: 'TEXT',
  updated_at: 'TEXT',
  started_at: 'TEXT',
  finished_at: 'TEXT',
  expires_at: 'TEXT',
  ttl_seconds: 'INTEGER',
  error_code: 'TEXT',
  error: 'TEXT',
  stop_reason: 'TEXT',
};

const ACP_SESSION_CREATE_COLUMNS = [
  'id', 'job_id', 'provider', 'profile', 'target_fingerprint',
  'target_context', 'effective_configuration', 'effective_config',
  'acpx_record_id', 'state', 'request_id', 'request_fingerprint',
  'worker_pid', 'provider_pid', 'capability_version', 'provider_version',
  'capabilities', 'session_store_dir', 'event_file', 'event_cursor',
  'event_count', 'event_bytes', 'uncertainty', 'created_at', 'updated_at',
  'ready_at', 'prompting_at', 'cancelling_at', 'uncertain_at', 'closed_at',
  'failed_at', 'expires_at', 'ttl_seconds', 'error_code', 'error',
];
const ACP_TURN_CREATE_COLUMNS = [...ACP_TURN_COLUMNS];

function nowIso() {
  return new Date().toISOString();
}

const ACP_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACP_PRIVATE_METADATA_KEY = /^(?:prompt|prompts|prompt[_-]?text|raw|raw[_-]?frames?|frames?|transcript|transcripts|messages?|tool[_-]?(?:arguments?|calls?))$/iu;
const ACP_METADATA_MAX_DEPTH = 8;
const ACP_METADATA_MAX_MEMBERS = 128;
const ACP_METADATA_MAX_BYTES = 64 * 1024;
const ACP_METADATA_ALLOWED_KEYS = new Set([
  'schema_version', 'version', 'mode', 'role', 'kind', 'provider', 'profile',
  'model', 'model_id', 'target_fingerprint', 'configuration_digest',
  'capabilities_digest', 'working_directory', 'expected_git_root',
  'expected_head', 'allowed_paths', 'resolved_workspace', 'resolved_cwd',
  'git_common_directory', 'observed_head', 'workspace_identity', 'cwd_identity',
  'isolation', 'transport', 'write_ceiling', 'permissions', 'permission_mode',
  'sandbox', 'requested', 'effective', 'effective_model', 'subagents',
  'provider_state', 'provider_code', 'code', 'reason', 'observed_at',
  'reconciliation_required', 'recovery_reason', 'at', 'status', 'state',
  'requested_mode', 'effective_mode', 'timeout_seconds', 'max_turns',
  'session_mode', 'config_options', 'features', 'controls', 'supported',
  'unsupported', 'unknown', 'name', 'id', 'value', 'source', 'confidence',
]);

export class AcpStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AcpStoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function acpInvalid(field, message) {
  throw new AcpStoreError('invalid_acp_metadata', `${field}: ${message}`);
}

function acpOptionalText(value, field, maximum = 512) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') acpInvalid(field, 'must be text.');
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\u0000\u007f]/u.test(normalized)) {
    acpInvalid(field, `must be at most ${maximum} characters without control characters.`);
  }
  return normalized;
}

function acpRequiredText(value, field, maximum = 512) {
  const normalized = acpOptionalText(value, field, maximum);
  if (!normalized) acpInvalid(field, 'is required.');
  return normalized;
}

function acpOpaqueId(value, field, { generate = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (generate) return `acp-${randomUUID()}`;
    return null;
  }
  if (typeof value !== 'string' || !ACP_OPAQUE_ID_PATTERN.test(value)) {
    throw new AcpStoreError(
      'invalid_acp_id',
      `${field} must be a managed opaque identifier without path separators.`,
    );
  }
  return value;
}

function acpPid(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || value <= 0) acpInvalid(field, 'must be a positive process ID.');
  return value;
}

function acpCounter(value, field, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isSafeInteger(value) || value < 0) acpInvalid(field, 'must be a non-negative integer.');
  return value;
}

function acpCounterSum(base, delta, field) {
  const normalizedBase = acpCounter(base, `${field}_base`);
  const normalizedDelta = acpCounter(delta, `${field}_delta`);
  if (normalizedDelta > Number.MAX_SAFE_INTEGER - normalizedBase) {
    throw new AcpStoreError('invalid_acp_counter', `${field} exceeds the safe integer bound.`);
  }
  return normalizedBase + normalizedDelta;
}

function acpTtl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || value < 0) acpInvalid('ttl_seconds', 'must be a non-negative integer.');
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strip fields that could contain a prompt or raw ACP frame before metadata
 * reaches SQLite.  Target context and effective configuration are retained as
 * bounded JSON metadata, but payload-bearing fields are never persisted.
 */
function validateAcpMetadataValue(value, field, depth = 0) {
  if (depth > ACP_METADATA_MAX_DEPTH) acpInvalid(field, 'exceeds metadata nesting depth.');
  if (Array.isArray(value)) {
    if (value.length > ACP_METADATA_MAX_MEMBERS) acpInvalid(field, 'contains too many members.');
    return value.map((entry) => validateAcpMetadataValue(entry, field, depth + 1));
  }
  if (!isPlainObject(value)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    acpInvalid(field, 'contains an unsupported value.');
  }
  const entries = Object.entries(value);
  if (entries.length > ACP_METADATA_MAX_MEMBERS) acpInvalid(field, 'contains too many members.');
  const result = {};
  for (const [key, nested] of entries) {
    if (!ACP_METADATA_ALLOWED_KEYS.has(key) || ACP_PRIVATE_METADATA_KEY.test(key)) {
      acpInvalid(field, `contains unsupported metadata member ${key}.`);
    }
    result[key] = validateAcpMetadataValue(nested, field, depth + 1);
  }
  return result;
}

function acpMetadata(value, field) {
  if (value === undefined || value === null) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      acpInvalid(field, 'must be a JSON object or valid JSON text.');
    }
  }
  try {
    const validated = validateAcpMetadataValue(parsed, field);
    const serialized = JSON.stringify(validated);
    if (Buffer.byteLength(serialized, 'utf8') > ACP_METADATA_MAX_BYTES) {
      acpInvalid(field, 'serialized metadata exceeds the byte bound.');
    }
    return serialized;
  } catch (error) {
    if (error instanceof AcpStoreError) throw error;
    acpInvalid(field, 'must be JSON-serializable metadata.');
  }
  return null;
}

function acpStoredJson(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function acpPathMetadata(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() !== value || !value.startsWith('/')
    || /[\u0000\u007f]/u.test(value)) {
    acpInvalid(field, 'must be an absolute owner-only metadata path.');
  }
  return value;
}

function acpTimestamp(value, field, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = acpRequiredText(value, field, 64);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) {
    acpInvalid(field, 'must be a valid timestamp in the supported date range.');
  }
  return normalized;
}

function acpExpiry(createdAt, ttlSeconds, explicit) {
  const createdMilliseconds = Date.parse(createdAt ?? '');
  if (!Number.isFinite(createdMilliseconds)) acpInvalid('created_at', 'must be a valid timestamp.');
  if (ttlSeconds === null || ttlSeconds === undefined) {
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      acpInvalid('expires_at', 'requires ttl_seconds for a consistent expiry.');
    }
    return null;
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 0
    || ttlSeconds > Math.floor((8.64e15 - createdMilliseconds) / 1000)) {
    acpInvalid('ttl_seconds', 'would exceed the supported date range.');
  }
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const normalized = acpTimestamp(explicit, 'expires_at');
    const expected = new Date(createdMilliseconds + ttlSeconds * 1000).toISOString();
    if (normalized !== expected) acpInvalid('expires_at', 'must equal created_at plus ttl_seconds.');
    return normalized;
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 0) return null;
  return Number.isFinite(createdMilliseconds)
    ? new Date(createdMilliseconds + ttlSeconds * 1000).toISOString()
    : null;
}

function acpFingerprint(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    acpInvalid('request_fingerprint', 'must be non-empty text of at most 512 characters without control characters.');
  }
  if (!/^(?:sha256:)?[a-f0-9]{64}$/iu.test(value)) {
    acpInvalid('request_fingerprint', 'must be an exact SHA-256 digest.');
  }
  // Fingerprints are compared byte-for-byte after UTF-8 encoding.  Do not
  // trim or otherwise canonicalize them: a replay with a different exact
  // fingerprint must fail closed.
  return value;
}

function validateRequestPair(requestId, fingerprint) {
  if ((requestId === null) !== (fingerprint === null)) {
    acpInvalid('request_id/request_fingerprint', 'must be supplied together as an exact pair.');
  }
}

function acpOptionalDigest(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = acpOptionalText(value, field, 512);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/iu.test(normalized)) {
    acpInvalid(field, 'must be an exact SHA-256 digest.');
  }
  return normalized;
}

function acpSessionState(value) {
  const state = acpOptionalText(value, 'state', 32) ?? 'creating';
  if (!ACP_SESSION_STATES.includes(state)) {
    throw new AcpStoreError('invalid_acp_state', `Unknown ACP session state: ${state}.`);
  }
  return state;
}

function acpTurnState(value) {
  const state = acpOptionalText(value, 'state', 32) ?? 'creating';
  if (!ACP_TURN_STATES.includes(state)) {
    throw new AcpStoreError('invalid_acp_state', `Unknown ACP turn state: ${state}.`);
  }
  return state;
}

function normalizedAcpSession(input = {}) {
  if (!isPlainObject(input)) acpInvalid('session', 'must be an object.');
  const createdAt = acpTimestamp(input.created_at ?? input.createdAt, 'created_at', nowIso());
  const ttlSeconds = acpTtl(input.ttl_seconds ?? input.ttlSeconds);
  const targetContext = acpMetadata(
    input.target_context ?? input.targetContext,
    'target_context',
  );
  const effectiveConfiguration = acpMetadata(
    input.effective_configuration
      ?? input.effective_config
      ?? input.effectiveConfiguration
      ?? input.effectiveConfig,
    'effective_configuration',
  );
  const state = acpSessionState(input.state ?? input.status);
  const session = {
    id: acpOpaqueId(input.id ?? input.session_id ?? input.sessionId, 'session_id', { generate: true }),
    job_id: acpOpaqueId(input.job_id ?? input.jobId, 'job_id'),
    provider: acpRequiredText(input.provider, 'provider', 128),
    profile: acpOptionalText(input.profile, 'profile', 128) ?? 'default',
    target_fingerprint: acpOptionalDigest(
      input.target_fingerprint ?? input.targetFingerprint,
      'target_fingerprint',
    ),
    target_context: targetContext,
    effective_configuration: effectiveConfiguration,
    effective_config: effectiveConfiguration,
    acpx_record_id: acpOpaqueId(
      input.acpx_record_id ?? input.acpxRecordId,
      'acpx_record_id',
    ),
    state,
    request_id: acpOpaqueId(input.request_id ?? input.requestId, 'request_id'),
    request_fingerprint: acpFingerprint(input.request_fingerprint ?? input.requestFingerprint),
    worker_pid: acpPid(input.worker_pid ?? input.workerPid, 'worker_pid'),
    provider_pid: acpPid(input.provider_pid ?? input.providerPid, 'provider_pid'),
    capability_version: acpOptionalText(
      input.capability_version ?? input.capabilityVersion,
      'capability_version',
      128,
    ),
    provider_version: acpOptionalText(
      input.provider_version ?? input.providerVersion,
      'provider_version',
      128,
    ),
    capabilities: acpMetadata(input.capabilities, 'capabilities'),
    session_store_dir: acpPathMetadata(
      input.session_store_dir ?? input.sessionStoreDir,
      'session_store_dir',
    ),
    event_file: acpPathMetadata(input.event_file ?? input.eventFile, 'event_file'),
    event_cursor: acpCounter(input.event_cursor ?? input.eventCursor, 'event_cursor'),
    event_count: acpCounter(input.event_count ?? input.eventCount, 'event_count'),
    event_bytes: acpCounter(input.event_bytes ?? input.eventBytes, 'event_bytes'),
    uncertainty: acpMetadata(input.uncertainty, 'uncertainty'),
    created_at: createdAt,
    updated_at: acpTimestamp(input.updated_at ?? input.updatedAt, 'updated_at', createdAt),
    ready_at: acpTimestamp(input.ready_at ?? input.readyAt, 'ready_at'),
    prompting_at: acpTimestamp(input.prompting_at ?? input.promptingAt, 'prompting_at'),
    cancelling_at: acpTimestamp(input.cancelling_at ?? input.cancellingAt, 'cancelling_at'),
    uncertain_at: acpTimestamp(input.uncertain_at ?? input.uncertainAt, 'uncertain_at'),
    closed_at: acpTimestamp(input.closed_at ?? input.closedAt, 'closed_at'),
    failed_at: acpTimestamp(input.failed_at ?? input.failedAt, 'failed_at'),
    expires_at: acpExpiry(createdAt, ttlSeconds, input.expires_at ?? input.expiresAt),
    ttl_seconds: ttlSeconds,
    error_code: acpOptionalText(input.error_code ?? input.errorCode, 'error_code', 128),
    error: acpOptionalText(input.error, 'error', 1024),
  };
  validateRequestPair(session.request_id, session.request_fingerprint);
  if (state === 'uncertain' && !session.uncertainty) {
    acpInvalid('uncertainty', 'is required when inserting an uncertain session.');
  }
  if (state === 'ready' && !session.ready_at) session.ready_at = createdAt;
  if (state === 'prompting' && !session.prompting_at) session.prompting_at = createdAt;
  if (state === 'cancelling' && !session.cancelling_at) session.cancelling_at = createdAt;
  if (state === 'uncertain' && !session.uncertain_at) session.uncertain_at = createdAt;
  if (state === 'closed' && !session.closed_at) session.closed_at = createdAt;
  if (state === 'failed' && !session.failed_at) session.failed_at = createdAt;
  return session;
}

function normalizedAcpSessionPatch(patch = {}) {
  if (!isPlainObject(patch)) acpInvalid('patch', 'must be an object.');
  const source = { ...patch };
  if (source.target_fingerprint === undefined && source.targetFingerprint !== undefined) {
    source.target_fingerprint = source.targetFingerprint;
  }
  if (source.effective_configuration === undefined && source.effectiveConfiguration !== undefined) {
    source.effective_configuration = source.effectiveConfiguration;
  }
  if (source.effective_configuration === undefined && source.effective_config !== undefined) {
    source.effective_configuration = source.effective_config;
  }
  if (source.session_store_dir === undefined && source.sessionStoreDir !== undefined) {
    source.session_store_dir = source.sessionStoreDir;
  }
  if (source.event_file === undefined && source.eventFile !== undefined) source.event_file = source.eventFile;
  if (source.request_id === undefined && source.requestId !== undefined) source.request_id = source.requestId;
  if (source.request_fingerprint === undefined && source.requestFingerprint !== undefined) {
    source.request_fingerprint = source.requestFingerprint;
  }
  if (source.worker_pid === undefined && source.workerPid !== undefined) source.worker_pid = source.workerPid;
  if (source.provider_pid === undefined && source.providerPid !== undefined) source.provider_pid = source.providerPid;
  if (source.capability_version === undefined && source.capabilityVersion !== undefined) {
    source.capability_version = source.capabilityVersion;
  }
  if (source.provider_version === undefined && source.providerVersion !== undefined) {
    source.provider_version = source.providerVersion;
  }
  if (source.event_cursor === undefined && source.eventCursor !== undefined) source.event_cursor = source.eventCursor;
  if (source.event_count === undefined && source.eventCount !== undefined) source.event_count = source.eventCount;
  if (source.event_bytes === undefined && source.eventBytes !== undefined) source.event_bytes = source.eventBytes;
  if (source.ttl_seconds === undefined && source.ttlSeconds !== undefined) source.ttl_seconds = source.ttlSeconds;
  if (source.expires_at === undefined && source.expiresAt !== undefined) source.expires_at = source.expiresAt;
  if (source.error_code === undefined && source.errorCode !== undefined) source.error_code = source.errorCode;
  const result = {};
  for (const column of ACP_SESSION_MUTABLE_COLUMNS) {
    if (source[column] === undefined) continue;
    if (['target_context', 'effective_configuration', 'effective_config', 'capabilities', 'uncertainty'].includes(column)) {
      result[column] = acpMetadata(source[column], column);
    } else if (['session_store_dir', 'event_file'].includes(column)) {
      result[column] = acpPathMetadata(source[column], column);
    } else if (['worker_pid', 'provider_pid'].includes(column)) {
      result[column] = acpPid(source[column], column);
    } else if (['event_cursor', 'event_count', 'event_bytes'].includes(column)) {
      result[column] = acpCounter(source[column], column);
    } else if (column === 'ttl_seconds') {
      result[column] = acpTtl(source[column]);
    } else if (['created_at', 'updated_at', 'ready_at', 'prompting_at', 'cancelling_at', 'uncertain_at', 'closed_at', 'failed_at', 'expires_at'].includes(column)) {
      result[column] = acpTimestamp(source[column], column);
    } else if (['request_id', 'acpx_record_id'].includes(column)) {
      result[column] = acpOpaqueId(source[column], column);
    } else if (column === 'request_fingerprint') {
      result[column] = acpFingerprint(source[column]);
    } else {
      result[column] = acpOptionalText(source[column], column, column === 'error' ? 1024 : 512);
    }
  }
  // Keep the two accepted spellings synchronized for callers that use the
  // concise effective_config name.
  if (result.effective_configuration !== undefined) result.effective_config = result.effective_configuration;
  return result;
}

function normalizedAcpTurn(input = {}, sessionId = null) {
  if (!isPlainObject(input)) acpInvalid('turn', 'must be an object.');
  const createdAt = acpTimestamp(input.created_at ?? input.createdAt, 'created_at', nowIso());
  const ttlSeconds = acpTtl(input.ttl_seconds ?? input.ttlSeconds);
  const turn = {
    id: acpOpaqueId(input.id ?? input.turn_id ?? input.turnId, 'turn_id', { generate: true }),
    session_id: acpOpaqueId(input.session_id ?? input.sessionId ?? sessionId, 'session_id'),
    job_id: acpOpaqueId(input.job_id ?? input.jobId, 'job_id'),
    request_id: acpOpaqueId(input.request_id ?? input.requestId, 'request_id'),
    request_fingerprint: acpFingerprint(input.request_fingerprint ?? input.requestFingerprint),
    state: acpTurnState(input.state ?? input.status),
    worker_pid: acpPid(input.worker_pid ?? input.workerPid, 'worker_pid'),
    provider_pid: acpPid(input.provider_pid ?? input.providerPid, 'provider_pid'),
    capability_version: acpOptionalText(input.capability_version ?? input.capabilityVersion, 'capability_version', 128),
    provider_version: acpOptionalText(input.provider_version ?? input.providerVersion, 'provider_version', 128),
    event_cursor: acpCounter(input.event_cursor ?? input.eventCursor, 'event_cursor'),
    event_count: acpCounter(input.event_count ?? input.eventCount, 'event_count'),
    event_bytes: acpCounter(input.event_bytes ?? input.eventBytes, 'event_bytes'),
    uncertainty: acpMetadata(input.uncertainty, 'uncertainty'),
    created_at: createdAt,
    updated_at: acpTimestamp(input.updated_at ?? input.updatedAt, 'updated_at', createdAt),
    started_at: acpTimestamp(input.started_at ?? input.startedAt, 'started_at'),
    finished_at: acpTimestamp(input.finished_at ?? input.finishedAt, 'finished_at'),
    expires_at: acpExpiry(createdAt, ttlSeconds, input.expires_at ?? input.expiresAt),
    ttl_seconds: ttlSeconds,
    error_code: acpOptionalText(input.error_code ?? input.errorCode, 'error_code', 128),
    error: acpOptionalText(input.error, 'error', 1024),
    stop_reason: acpOptionalText(input.stop_reason ?? input.stopReason, 'stop_reason', 256),
  };
  validateRequestPair(turn.request_id, turn.request_fingerprint);
  if (turn.state === 'uncertain' && !turn.uncertainty) {
    acpInvalid('uncertainty', 'is required when inserting an uncertain turn.');
  }
  if (turn.state === 'prompting' && !turn.started_at) turn.started_at = createdAt;
  if (['completed', 'closed', 'failed'].includes(turn.state) && !turn.finished_at) turn.finished_at = createdAt;
  return turn;
}

function normalizedAcpTurnPatch(patch = {}) {
  if (!isPlainObject(patch)) acpInvalid('patch', 'must be an object.');
  const source = { ...patch };
  for (const [from, to] of [
    ['requestId', 'request_id'], ['requestFingerprint', 'request_fingerprint'],
    ['workerPid', 'worker_pid'], ['providerPid', 'provider_pid'],
    ['capabilityVersion', 'capability_version'], ['providerVersion', 'provider_version'],
    ['eventCursor', 'event_cursor'], ['eventCount', 'event_count'], ['eventBytes', 'event_bytes'],
    ['ttlSeconds', 'ttl_seconds'], ['startedAt', 'started_at'], ['finishedAt', 'finished_at'],
    ['expiresAt', 'expires_at'], ['errorCode', 'error_code'], ['stopReason', 'stop_reason'],
  ]) {
    if (source[to] === undefined && source[from] !== undefined) source[to] = source[from];
  }
  const result = {};
  for (const column of ACP_TURN_MUTABLE_COLUMNS) {
    if (source[column] === undefined || ['state', 'status'].includes(column)) continue;
    if (column === 'uncertainty') result[column] = acpMetadata(source[column], column);
    else if (['worker_pid', 'provider_pid'].includes(column)) result[column] = acpPid(source[column], column);
    else if (['event_cursor', 'event_count', 'event_bytes'].includes(column)) result[column] = acpCounter(source[column], column);
    else if (column === 'ttl_seconds') result[column] = acpTtl(source[column]);
    else if (['created_at', 'updated_at', 'started_at', 'finished_at', 'expires_at'].includes(column)) result[column] = acpTimestamp(source[column], column);
    else if (['request_id'].includes(column)) result[column] = acpOpaqueId(source[column], column);
    else if (column === 'request_fingerprint') result[column] = acpFingerprint(source[column]);
    else result[column] = acpOptionalText(source[column], column, column === 'error' ? 1024 : 512);
  }
  return result;
}

function migrateTableColumns(database, table, columns) {
  const existing = new Set(
    database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
  );
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Additive ACP schema migration.  This deliberately uses CREATE/ALTER only:
 * opening a newer store must not reinterpret or rewrite historical jobs (or
 * any pre-existing ACP rows from an earlier schema revision).
 */
function migrateAcpSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS acp_sessions (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      provider TEXT,
      profile TEXT,
      target_fingerprint TEXT,
      target_context TEXT,
      effective_configuration TEXT,
      effective_config TEXT,
      acpx_record_id TEXT,
      state TEXT DEFAULT 'creating' CHECK (state IN ('creating', 'ready', 'prompting', 'cancelling', 'uncertain', 'closed', 'failed')),
      request_id TEXT,
      request_fingerprint TEXT,
      worker_pid INTEGER,
      provider_pid INTEGER,
      capability_version TEXT,
      provider_version TEXT,
      capabilities TEXT,
      session_store_dir TEXT,
      event_file TEXT,
      event_cursor INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      event_bytes INTEGER NOT NULL DEFAULT 0,
      uncertainty TEXT,
      created_at TEXT,
      updated_at TEXT,
      ready_at TEXT,
      prompting_at TEXT,
      cancelling_at TEXT,
      uncertain_at TEXT,
      closed_at TEXT,
      failed_at TEXT,
      expires_at TEXT,
      ttl_seconds INTEGER,
      error_code TEXT,
      error TEXT,
      CHECK (state <> 'uncertain' OR uncertainty IS NOT NULL),
      CHECK (state NOT IN ('closed', 'failed') OR closed_at IS NOT NULL OR failed_at IS NOT NULL),
      CHECK ((request_id IS NULL) = (request_fingerprint IS NULL)),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS acp_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      job_id TEXT,
      request_id TEXT,
      request_fingerprint TEXT,
      state TEXT DEFAULT 'creating' CHECK (state IN ('creating', 'prompting', 'cancelling', 'uncertain', 'completed', 'closed', 'failed')),
      worker_pid INTEGER,
      provider_pid INTEGER,
      capability_version TEXT,
      provider_version TEXT,
      event_cursor INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      event_bytes INTEGER NOT NULL DEFAULT 0,
      uncertainty TEXT,
      created_at TEXT,
      updated_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      expires_at TEXT,
      ttl_seconds INTEGER,
      error_code TEXT,
      error TEXT,
      stop_reason TEXT,
      CHECK (state <> 'uncertain' OR uncertainty IS NOT NULL),
      CHECK (state NOT IN ('completed', 'closed', 'failed') OR finished_at IS NOT NULL),
      CHECK ((request_id IS NULL) = (request_fingerprint IS NULL)),
      FOREIGN KEY (session_id) REFERENCES acp_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
    );
  `);
  migrateTableColumns(database, 'acp_sessions', ACP_SESSION_COLUMN_TYPES);
  migrateTableColumns(database, 'acp_turns', ACP_TURN_COLUMN_TYPES);
  database.exec(`
    CREATE INDEX IF NOT EXISTS acp_sessions_created_at_idx
      ON acp_sessions(created_at DESC);
    CREATE INDEX IF NOT EXISTS acp_sessions_state_idx
      ON acp_sessions(state);
    CREATE INDEX IF NOT EXISTS acp_sessions_request_idx
      ON acp_sessions(request_id);
    CREATE UNIQUE INDEX IF NOT EXISTS acp_sessions_request_unique_idx
      ON acp_sessions(request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acp_sessions_acpx_record_idx
      ON acp_sessions(acpx_record_id);
    CREATE INDEX IF NOT EXISTS acp_sessions_job_idx
      ON acp_sessions(job_id);
    CREATE INDEX IF NOT EXISTS acp_turns_session_idx
      ON acp_turns(session_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS acp_turns_request_idx
      ON acp_turns(request_id);
    CREATE UNIQUE INDEX IF NOT EXISTS acp_turns_request_unique_idx
      ON acp_turns(request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acp_turns_state_idx
      ON acp_turns(state);
    CREATE TRIGGER IF NOT EXISTS acp_sessions_request_cross_kind_insert
      BEFORE INSERT ON acp_sessions
      WHEN NEW.request_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM acp_turns WHERE request_id = NEW.request_id)
      BEGIN SELECT RAISE(ABORT, 'ACP request ID is already reserved by a turn'); END;
    CREATE TRIGGER IF NOT EXISTS acp_sessions_request_cross_kind_update
      BEFORE UPDATE OF request_id ON acp_sessions
      WHEN NEW.request_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM acp_turns WHERE request_id = NEW.request_id)
      BEGIN SELECT RAISE(ABORT, 'ACP request ID is already reserved by a turn'); END;
    CREATE TRIGGER IF NOT EXISTS acp_turns_request_cross_kind_insert
      BEFORE INSERT ON acp_turns
      WHEN NEW.request_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM acp_sessions WHERE request_id = NEW.request_id)
      BEGIN SELECT RAISE(ABORT, 'ACP request ID is already reserved by a session'); END;
    CREATE TRIGGER IF NOT EXISTS acp_turns_request_cross_kind_update
      BEFORE UPDATE OF request_id ON acp_turns
      WHEN NEW.request_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM acp_sessions WHERE request_id = NEW.request_id)
      BEGIN SELECT RAISE(ABORT, 'ACP request ID is already reserved by a session'); END;
    CREATE TRIGGER IF NOT EXISTS acp_sessions_uncertain_child_close
      BEFORE UPDATE OF state ON acp_sessions
      WHEN NEW.state = 'closed'
       AND EXISTS (SELECT 1 FROM acp_turns WHERE session_id = OLD.id AND state = 'uncertain')
      BEGIN SELECT RAISE(ABORT, 'ACP session has an uncertain child turn'); END;
    CREATE TRIGGER IF NOT EXISTS acp_sessions_uncertain_child_delete
      BEFORE DELETE ON acp_sessions
      WHEN EXISTS (SELECT 1 FROM acp_turns WHERE session_id = OLD.id AND state = 'uncertain')
      BEGIN SELECT RAISE(ABORT, 'ACP session has an uncertain child turn'); END;
    CREATE TRIGGER IF NOT EXISTS acp_sessions_authority_immutable_update
      BEFORE UPDATE OF provider, profile, target_fingerprint, target_context, acpx_record_id,
        session_store_dir, event_file ON acp_sessions
      WHEN NOT (NEW.provider IS OLD.provider)
        OR NOT (NEW.profile IS OLD.profile)
        OR NOT (NEW.target_fingerprint IS OLD.target_fingerprint)
        OR NOT (NEW.target_context IS OLD.target_context)
        OR (OLD.acpx_record_id IS NOT NULL AND NOT (NEW.acpx_record_id IS OLD.acpx_record_id))
        OR (OLD.session_store_dir IS NOT NULL AND NOT (NEW.session_store_dir IS OLD.session_store_dir))
        OR (OLD.event_file IS NOT NULL AND NOT (NEW.event_file IS OLD.event_file))
      BEGIN SELECT RAISE(ABORT, 'ACP authority fields are immutable after provisioning'); END;
  `);
}

function lifecycleFromStatus(status) {
  return LEGACY_TO_LIFECYCLE[status] ?? 'accepted';
}

function legacyFromLifecycle(state) {
  return LIFECYCLE_TO_LEGACY[state] ?? 'queued';
}

function lifecycleOf(job) {
  const state = job?.lifecycle_state ?? lifecycleFromStatus(job?.status);
  return LIFECYCLE_STATES.includes(state) ? state : 'accepted';
}

function terminalOf(job) {
  const state = lifecycleOf(job);
  return TERMINAL_LIFECYCLE_STATES.has(state) ? state : null;
}

function withTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function lifecyclePath(state) {
  if (state === 'accepted') return ['accepted'];
  if (state === 'started') return ['accepted', 'started'];
  if (state === 'working') return ['accepted', 'started', 'working'];
  if (TERMINAL_LIFECYCLE_STATES.has(state)) return ['accepted', 'started', 'working', state];
  return [];
}

function eventPayload(value) {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); } catch { return JSON.stringify({ note: 'unserializable' }); }
}

function appendLifecycleEvent(database, jobId, lifecycleState, eventType, occurredAt, payload = null) {
  const row = database.prepare(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM job_events WHERE job_id = ?',
  ).get(jobId);
  database.prepare(`
    INSERT INTO job_events
      (job_id, sequence, lifecycle_state, event_type, occurred_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(jobId, row.next_sequence, lifecycleState, eventType, occurredAt, eventPayload(payload));
}

function updateColumns(database, id, patch) {
  const columns = Object.keys(patch).filter((column) => MUTABLE_COLUMNS.has(column));
  if (columns.length === 0) return;
  database.prepare(
    `UPDATE jobs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
  ).run(...columns.map((column) => patch[column]), id);
}

function appendLifecyclePath(database, jobId, state, occurredAt, payload = null) {
  for (const phase of lifecyclePath(state)) {
    appendLifecycleEvent(
      database,
      jobId,
      phase,
      TERMINAL_LIFECYCLE_STATES.has(phase) ? 'terminal' : 'transition',
      occurredAt,
      phase === state ? payload : null,
    );
  }
}

function normalizedJob(job) {
  const normalized = { ...job };
  const state = lifecycleOf(normalized);
  normalized.lifecycle_state = state;
  normalized.status = normalized.status ?? legacyFromLifecycle(state);
  if (TERMINAL_LIFECYCLE_STATES.has(state)) {
    normalized.terminal_state = normalized.terminal_state ?? state;
    normalized.failure_class = normalized.failure_class
      ?? (state === 'completed' ? null : state);
  }
  if (!normalized.created_at) normalized.created_at = nowIso();
  if (normalized.deadline_at === undefined
    && Number.isFinite(normalized.timeout_seconds)
    && normalized.timeout_seconds > 0) {
    const created = Date.parse(normalized.created_at);
    if (Number.isFinite(created)) {
      normalized.deadline_at = new Date(created + normalized.timeout_seconds * 1000).toISOString();
    }
  }
  return normalized;
}

function backfillLifecycleEvents(database) {
  const rows = database.prepare(`
    SELECT j.* FROM jobs j
    WHERE NOT EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = j.id)
  `).all();
  for (const row of rows) {
    withTransaction(database, () => {
      const state = lifecycleOf(row);
      const occurredAt = row.updated_at ?? row.created_at ?? nowIso();
      appendLifecyclePath(database, row.id, state, occurredAt, {
        migrated: true,
        legacy_status: row.status ?? null,
      });
      const patch = {};
      if (!row.lifecycle_state) patch.lifecycle_state = state;
      if (TERMINAL_LIFECYCLE_STATES.has(state) && !row.terminal_state) {
        patch.terminal_state = state;
      }
      if (state === 'failed' && !row.failure_class) patch.failure_class = 'process_failure';
      if (Object.keys(patch).length > 0) updateColumns(database, row.id, patch);
    });
  }
}

export function openStore(file) {
  const databaseIdentity = prepareStateFilePathSync(file);
  const sidecars = [`${file}-wal`, `${file}-shm`];
  for (const sidecar of sidecars) {
    inspectStateFilePathSync(sidecar, { required: false });
  }

  let database;
  try {
    database = new DatabaseSync(file);
    STORE_STATE_ROOTS.set(database, path.dirname(file));
    inspectStateFilePathSync(file, { expectedIdentity: databaseIdentity });
    database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      signal TEXT,
      error TEXT,
      url TEXT,
      request_id TEXT UNIQUE,
      request_fingerprint TEXT,
      runner_pid INTEGER,
      child_pid INTEGER,
      log_file TEXT NOT NULL,
      cancel_file TEXT NOT NULL,
      output_dir TEXT,
      timeout_seconds INTEGER,
      adapter_versions TEXT,
      deadline_at TEXT,
      elapsed_seconds REAL,
      termination_reason TEXT,
      signal_sent TEXT,
      forced_kill INTEGER,
      last_activity_at TEXT,
      partial_output_available INTEGER,
      workspace_changed INTEGER,
      workspace_tainted INTEGER,
      changed_paths TEXT,
      effective_configuration TEXT,
      target_context TEXT,
      heartbeat TEXT,
      stalled INTEGER,
      patch_artifact TEXT,
      log_bytes INTEGER,
      lifecycle_state TEXT,
      terminal_state TEXT,
      failure_class TEXT,
      last_heartbeat_at TEXT,
      last_output_at TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
    `);
    const columns = new Set(
      database.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name),
    );
    for (const [name, type] of Object.entries(COLUMN_TYPES)) {
      if (!columns.has(name)) database.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    }
    database.exec('CREATE INDEX IF NOT EXISTS jobs_lifecycle_state_idx ON jobs(lifecycle_state)');
    database.exec(`
    CREATE TABLE IF NOT EXISTS job_events (
      job_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload TEXT,
      PRIMARY KEY (job_id, sequence),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, sequence);
    `);
    migrateAcpSchema(database);
    backfillLifecycleEvents(database);
    inspectStateFilePathSync(file, { expectedIdentity: databaseIdentity });
    for (const sidecar of sidecars) {
      inspectStateFilePathSync(sidecar, { required: false });
    }
    return database;
  } catch (error) {
    try { database?.close(); } catch {}
    throw error;
  }
}

export function insertJob(database, job) {
  const normalized = normalizedJob(job);
  const columns = COLUMNS.filter((column) => normalized[column] !== undefined);
  const placeholders = columns.map(() => '?').join(', ');
  withTransaction(database, () => {
    database.prepare(
      `INSERT INTO jobs (${columns.join(', ')}) VALUES (${placeholders})`,
    ).run(...columns.map((column) => normalized[column]));
    appendLifecyclePath(
      database,
      normalized.id,
      normalized.lifecycle_state,
      normalized.created_at,
      { accepted_at: normalized.created_at },
    );
  });
}

export function updateJob(database, id, patch) {
  // Lifecycle and terminal fields are written only through transition helpers.
  // This keeps legacy callers able to update operational metadata without
  // allowing an unconditional UPDATE to rewrite a sealed outcome.
  const safePatch = { ...patch };
  delete safePatch.lifecycle_state;
  delete safePatch.terminal_state;
  delete safePatch.failure_class;
  const current = getStoredJob(database, id);
  if (!current) return;
  if (terminalOf(current)) {
    delete safePatch.status;
  }
  updateColumns(database, id, safePatch);
}

export function transitionJob(database, id, nextState, patch = {}, payload = null) {
  if (!LIFECYCLE_STATES.includes(nextState)) throw new Error(`Unknown lifecycle state: ${nextState}`);
  if (TERMINAL_LIFECYCLE_STATES.has(nextState)) {
    return terminalizeJob(database, id, nextState, patch, payload);
  }
  return withTransaction(database, () => {
    const current = getStoredJob(database, id);
    if (!current) throw new Error(`No job named ${id}.`);
    const currentState = lifecycleOf(current);
    if (TERMINAL_LIFECYCLE_STATES.has(currentState)) {
      return { changed: false, job: current };
    }
    if (currentState === nextState) return { changed: false, job: current };
    const allowed = (currentState === 'accepted' && (nextState === 'started' || nextState === 'working'))
      || (currentState === 'started' && nextState === 'working');
    if (!allowed) throw new Error(`Invalid lifecycle transition ${currentState} -> ${nextState}.`);
    const occurredAt = patch.updated_at ?? nowIso();
    const phases = lifecyclePath(nextState).slice(lifecyclePath(currentState).length);
    for (const phase of phases) {
      appendLifecycleEvent(database, id, phase, 'transition', occurredAt, phase === nextState ? payload : null);
    }
    updateColumns(database, id, {
      ...patch,
      lifecycle_state: nextState,
      status: legacyFromLifecycle(nextState),
      updated_at: occurredAt,
    });
    return { changed: true, job: getStoredJob(database, id) };
  });
}

export function terminalizeJob(database, id, outcome, patch = {}, payload = null) {
  if (!TERMINAL_LIFECYCLE_STATES.has(outcome)) {
    throw new Error(`Invalid terminal lifecycle state: ${outcome}.`);
  }
  return withTransaction(database, () => {
    const current = getStoredJob(database, id);
    if (!current) throw new Error(`No job named ${id}.`);
    const currentState = lifecycleOf(current);
    if (TERMINAL_LIFECYCLE_STATES.has(currentState)) {
      if (currentState === outcome) return { changed: false, job: current };
      throw new Error(`Terminal lifecycle state is immutable: ${currentState}.`);
    }
    if (!['accepted', 'started', 'working'].includes(currentState)) {
      throw new Error(`Invalid lifecycle state before terminalization: ${currentState}.`);
    }
    const occurredAt = patch.finished_at ?? nowIso();
    const phases = currentState === 'working'
      ? [outcome]
      : lifecyclePath(outcome).slice(lifecyclePath(currentState).length);
    for (const phase of phases) {
      appendLifecycleEvent(
        database,
        id,
        phase,
        phase === outcome ? 'terminal' : 'transition',
        occurredAt,
        phase === outcome ? payload : null,
      );
    }
    const failureClass = patch.failure_class
      ?? (outcome === 'completed' ? null : outcome);
    updateColumns(database, id, {
      ...patch,
      lifecycle_state: outcome,
      terminal_state: outcome,
      status: legacyFromLifecycle(outcome),
      failure_class: failureClass,
      finished_at: patch.finished_at ?? occurredAt,
      updated_at: occurredAt,
    });
    return { changed: true, job: getStoredJob(database, id) };
  });
}

export function recordHeartbeat(database, id, heartbeat = {}) {
  return withTransaction(database, () => {
    const current = getStoredJob(database, id);
    if (!current || terminalOf(current)) return { changed: false, job: current };
    const at = heartbeat.at ?? nowIso();
    const outputAt = heartbeat.output_at ?? current.last_output_at ?? null;
    const lifecycleState = lifecycleOf(current);
    updateColumns(database, id, {
      last_heartbeat_at: at,
      last_activity_at: at,
      last_output_at: outputAt,
      heartbeat: JSON.stringify({
        phase: lifecycleState,
        at,
        last_output_at: outputAt,
        deadline_at: current.deadline_at ?? null,
        ...(heartbeat.details ?? {}),
      }),
      stalled: 0,
      updated_at: at,
      ...(heartbeat.log_bytes === undefined ? {} : {
        log_bytes: heartbeat.log_bytes,
        partial_output_available: heartbeat.log_bytes > 0 ? 1 : 0,
      }),
    });
    appendLifecycleEvent(database, id, lifecycleState, 'heartbeat', at, {
      output_at: outputAt,
      log_bytes: heartbeat.log_bytes ?? null,
    });
    return { changed: true, job: getStoredJob(database, id) };
  });
}

export function listLifecycleEvents(database, id) {
  return database.prepare(
    'SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence ASC',
  ).all(id);
}

export function getStoredJob(database, id) {
  return database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

export function listStoredJobs(database, limit) {
  return database.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

/**
 * Return every non-terminal job without applying the bounded recent-jobs
 * presentation limit.  Lifecycle state is authoritative for new rows while
 * the legacy status fallback keeps older ledgers visible to the control plane.
 */
export function listActiveStoredJobs(database, limit = null) {
  const query = `
    SELECT * FROM jobs
    WHERE lifecycle_state IN ('accepted', 'started', 'working')
       OR (lifecycle_state IS NULL AND status IN ('queued', 'starting', 'running', 'cancelling'))
    ORDER BY created_at DESC${limit === null ? '' : ' LIMIT ?'}
  `;
  return limit === null
    ? database.prepare(query).all()
    : database.prepare(query).all(limit);
}

export function findStoredRequest(database, requestId) {
  return database.prepare('SELECT * FROM jobs WHERE request_id = ?').get(requestId) ?? null;
}

function updateAcpColumns(database, table, idColumn, id, patch, mutableColumns) {
  const columns = Object.keys(patch).filter((column) => mutableColumns.has(column));
  if (columns.length === 0) return;
  database.prepare(
    `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${idColumn} = ?`,
  ).run(...columns.map((column) => patch[column]), id);
}

function requestFingerprintConflict(requestId, existing, requestedFingerprint) {
  throw new AcpStoreError(
    'request_id_conflict',
    `Request ID ${requestId} was already used with a different exact request fingerprint.`,
    {
      request_id: requestId,
      existing_fingerprint: existing?.request_fingerprint ?? null,
      requested_fingerprint: requestedFingerprint ?? null,
    },
  );
}

function sameRequestFingerprint(existing, requestedFingerprint) {
  return (existing?.request_fingerprint ?? null) === (requestedFingerprint ?? null);
}

function preserveRequestIdentity(current, patch) {
  for (const column of ['request_id', 'request_fingerprint']) {
    if (patch[column] === undefined) continue;
    const currentValue = current?.[column] ?? null;
    const requestedValue = patch[column] ?? null;
    if (column === 'request_fingerprint' && current?.request_id
      && requestedValue !== currentValue) {
      requestFingerprintConflict(current.request_id, current, requestedValue);
    }
    if (requestedValue !== currentValue) {
      throw new AcpStoreError(
        'request_id_conflict',
        `The durable ACP request identity cannot be changed after creation (${column}).`,
        { request_id: current?.request_id ?? null },
      );
    }
    delete patch[column];
  }
}

function preserveUncertainty(current, patch) {
  if (current?.state === 'uncertain' && patch.uncertainty !== undefined
    && (patch.uncertainty === null || patch.uncertainty === 'null')) {
    throw new AcpStoreError(
      'uncertainty_required',
      'Uncertainty metadata cannot be cleared while an ACP record is uncertain.',
    );
  }
}

function preserveAcpAuthority(current, patch) {
  for (const column of ['provider', 'profile', 'target_fingerprint', 'target_context']) {
    if (patch[column] === undefined) continue;
    if (patch[column] !== current?.[column]) {
      throw new AcpStoreError(
        'acp_authority_immutable',
        `ACP authority field ${column} cannot change after session creation.`,
      );
    }
    delete patch[column];
  }
  // ACPX's record ID and owner-only path metadata are provisioned once after
  // creation, then become immutable. Clearing or swapping them is forbidden.
  for (const column of ['acpx_record_id', 'session_store_dir', 'event_file']) {
    if (patch[column] === undefined) continue;
    const currentValue = current?.[column] ?? null;
    if (currentValue !== null && patch[column] !== currentValue) {
      throw new AcpStoreError(
        'acp_authority_immutable',
        `ACP authority field ${column} cannot change after provisioning.`,
      );
    }
    if (currentValue !== null && patch[column] === null) {
      throw new AcpStoreError(
        'acp_authority_immutable',
        `ACP authority field ${column} cannot be cleared after provisioning.`,
      );
    }
    // A null -> value provisioning write is the only permitted mutation.
    if (currentValue === null && patch[column] !== null) continue;
    delete patch[column];
  }
}

function reconcileTtlPatch(current, patch) {
  if (patch.ttl_seconds !== undefined) {
    patch.expires_at = acpExpiry(current.created_at, patch.ttl_seconds, patch.expires_at);
  } else if (patch.expires_at !== undefined) {
    patch.expires_at = acpExpiry(current.created_at, current.ttl_seconds, patch.expires_at);
  }
}

function acpSessionInsertResult(session, duplicate = false) {
  return {
    ...(session ?? {}),
    duplicate,
    changed: !duplicate,
    id: session?.id ?? null,
    session_id: session?.id ?? null,
    session,
  };
}

function acpTurnInsertResult(turn, duplicate = false) {
  return {
    ...(turn ?? {}),
    duplicate,
    changed: !duplicate,
    id: turn?.id ?? null,
    turn_id: turn?.id ?? null,
    turn,
  };
}

export function findStoredAcpSessionByRequest(database, requestId) {
  if (requestId === undefined || requestId === null) return null;
  return hydrateAcpSession(database.prepare(
    'SELECT * FROM acp_sessions WHERE request_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
  ).get(requestId) ?? null);
}

export const findAcpSessionByRequest = findStoredAcpSessionByRequest;

/** Return the durable ACP record (session first, then turn) for one request. */
export function findStoredAcpRequest(database, requestId) {
  const session = findStoredAcpSessionByRequest(database, requestId);
  if (session) return session;
  if (requestId === undefined || requestId === null) return null;
  const turn = database.prepare(
    'SELECT * FROM acp_turns WHERE request_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
  ).get(requestId);
  return turn ? hydrateAcpTurn(turn) : null;
}

export const findAcpRequest = findStoredAcpRequest;

export function getStoredAcpSession(database, id) {
  const sessionId = acpOpaqueId(id, 'session_id');
  if (!sessionId) return null;
  return hydrateAcpSession(database.prepare('SELECT * FROM acp_sessions WHERE id = ?').get(sessionId) ?? null);
}

function hydrateAcpSession(row) {
  if (!row) return null;
  return {
    ...row,
    // The SQL primary key follows the existing jobs ledger's `id` convention;
    // the protocol-facing alias keeps ACP callers on the familiar name.
    session_id: row.id,
    effective_config: row.effective_config ?? row.effective_configuration ?? null,
  };
}

export const getAcpSession = getStoredAcpSession;

export function listStoredAcpSessions(database, limit = null) {
  if (limit === null || limit === undefined) {
    return database.prepare('SELECT * FROM acp_sessions ORDER BY created_at DESC, id DESC').all().map(hydrateAcpSession);
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new AcpStoreError('invalid_limit', 'ACP session limit must be a non-negative integer.');
  }
  return database.prepare(
    'SELECT * FROM acp_sessions ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(limit).map(hydrateAcpSession);
}

export const listAcpSessions = listStoredAcpSessions;

export function insertAcpSession(database, input) {
  const normalized = normalizedAcpSession(input);
  validateAcpSessionPaths(database, normalized, {
    requireProvisioned: ['ready', 'prompting', 'cancelling'].includes(normalized.state),
  });
  return withTransaction(database, () => {
    if (normalized.request_id) {
      const existing = findStoredAcpSessionByRequest(database, normalized.request_id);
      if (existing) {
        if (!sameRequestFingerprint(existing, normalized.request_fingerprint)) {
          requestFingerprintConflict(normalized.request_id, existing, normalized.request_fingerprint);
        }
        return acpSessionInsertResult(existing, true);
      }
      const existingTurn = findStoredAcpTurnByRequestGlobal(database, normalized.request_id);
      if (existingTurn) {
        throw new AcpStoreError(
          'request_id_conflict',
          `Request ID ${normalized.request_id} is already reserved by an ACP turn; session and turn request identities cannot be reused across kinds.`,
          { request_id: normalized.request_id, existing_kind: 'turn' },
        );
      }
    }
    const existingId = getStoredAcpSession(database, normalized.id);
    if (existingId) {
      throw new AcpStoreError('acp_id_conflict', `ACP session ID ${normalized.id} already exists.`);
    }
    database.prepare(
      `INSERT INTO acp_sessions (${ACP_SESSION_CREATE_COLUMNS.join(', ')})
       VALUES (${ACP_SESSION_CREATE_COLUMNS.map(() => '?').join(', ')})`,
    ).run(...ACP_SESSION_CREATE_COLUMNS.map((column) => normalized[column]));
    return acpSessionInsertResult(getStoredAcpSession(database, normalized.id), false);
  });
}

export const createAcpSession = insertAcpSession;
export const ensureAcpSession = insertAcpSession;
export const reserveAcpSession = insertAcpSession;

export function updateAcpSession(database, id, patch = {}) {
  const sessionId = acpOpaqueId(id, 'session_id');
  if (!sessionId) return null;
  return withTransaction(database, () => {
    const current = getStoredAcpSession(database, sessionId);
    if (!current) return null;
    const safePatch = normalizedAcpSessionPatch(patch);
    // Lifecycle state is intentionally not an ordinary mutable column.  A
    // caller attempting to smuggle state/status through this helper cannot
    // overwrite uncertain or terminal outcomes.
    delete safePatch.state;
    delete safePatch.status;
    preserveRequestIdentity(current, safePatch);
    preserveUncertainty(current, safePatch);
    preserveAcpAuthority(current, safePatch);
    validateAcpSessionPaths(database, { ...current, ...safePatch }, {
      requireProvisioned: ['ready', 'prompting', 'cancelling'].includes(current.state),
    });
    reconcileTtlPatch(current, safePatch);
    delete safePatch.updated_at;
    const updatedAt = acpTimestamp(patch.updated_at ?? patch.updatedAt, 'updated_at', nowIso());
    if (Object.keys(safePatch).length > 0) {
      safePatch.updated_at = updatedAt;
      updateAcpColumns(database, 'acp_sessions', 'id', sessionId, safePatch, ACP_SESSION_MUTABLE_COLUMNS);
    }
    return getStoredAcpSession(database, sessionId);
  });
}

function sessionTransitionPatch(nextState, current, patch = {}, occurredAt) {
  const safePatch = normalizedAcpSessionPatch(patch);
  delete safePatch.state;
  delete safePatch.status;
  delete safePatch.created_at;
  preserveRequestIdentity(current, safePatch);
  preserveUncertainty(current, safePatch);
  preserveAcpAuthority(current, safePatch);
  reconcileTtlPatch(current, safePatch);
  safePatch.updated_at = occurredAt;
  if (nextState === 'ready' && !current.ready_at) safePatch.ready_at = occurredAt;
  if (nextState === 'prompting' && !current.prompting_at) safePatch.prompting_at = occurredAt;
  if (nextState === 'cancelling' && !current.cancelling_at) safePatch.cancelling_at = occurredAt;
  if (nextState === 'uncertain') {
    if (safePatch.uncertainty === undefined) {
      safePatch.uncertainty = current.uncertainty ?? JSON.stringify({ reason: 'provider_outcome_uncertain' });
    }
    if (!current.uncertain_at) safePatch.uncertain_at = occurredAt;
  }
  if (nextState === 'closed' && !current.closed_at) safePatch.closed_at = occurredAt;
  if (nextState === 'failed' && !current.failed_at) safePatch.failed_at = occurredAt;
  return safePatch;
}

export function transitionAcpSession(database, id, nextState, patch = {}, _payload = null) {
  const sessionId = acpOpaqueId(id, 'session_id');
  const targetState = acpSessionState(nextState);
  return withTransaction(database, () => {
    const current = getStoredAcpSession(database, sessionId);
    if (!current) throw new AcpStoreError('acp_session_not_found', `No ACP session named ${sessionId}.`);
    const currentState = acpSessionState(current.state);
    if (currentState === targetState) return { changed: false, session: current };
    if (targetState === 'closed' && database.prepare(
      "SELECT 1 FROM acp_turns WHERE session_id = ? AND state = 'uncertain' LIMIT 1",
    ).get(sessionId)) {
      throw new AcpStoreError(
        'acp_uncertain_child',
        `ACP session ${sessionId} cannot close while an uncertain turn requires reconciliation.`,
      );
    }
    if (!ACP_SESSION_TRANSITIONS[currentState]?.has(targetState)) {
      throw new AcpStoreError(
        'invalid_acp_transition',
        `Invalid ACP session transition ${currentState} -> ${targetState}.`,
      );
    }
    const occurredAt = acpTimestamp(patch.updated_at ?? patch.updatedAt, 'updated_at', nowIso());
    const safePatch = sessionTransitionPatch(targetState, current, patch, occurredAt);
    validateAcpSessionPaths(database, { ...current, ...safePatch }, {
      requireProvisioned: ['ready', 'prompting', 'cancelling'].includes(targetState),
    });
    safePatch.state = targetState;
    updateAcpColumns(database, 'acp_sessions', 'id', sessionId, safePatch, new Set([...ACP_SESSION_MUTABLE_COLUMNS, 'state']));
    return { changed: true, session: getStoredAcpSession(database, sessionId) };
  });
}

export const transitionAcpSessionState = transitionAcpSession;

export function terminalizeAcpSession(database, id, outcome, patch = {}, payload = null) {
  if (!ACP_TERMINAL_SESSION_STATES.has(outcome)) {
    throw new AcpStoreError('invalid_acp_state', `Invalid ACP terminal state: ${outcome}.`);
  }
  return transitionAcpSession(database, id, outcome, patch, payload);
}

export function markAcpSessionUncertain(database, id, uncertainty = {}, patch = {}) {
  const merged = { ...patch, uncertainty };
  return transitionAcpSession(database, id, 'uncertain', merged);
}

export const uncertainAcpSession = markAcpSessionUncertain;

export function closeAcpSession(database, id, patch = {}) {
  return terminalizeAcpSession(database, id, 'closed', patch);
}

export function recordAcpSessionEvent(database, id, event = {}) {
  const sessionId = acpOpaqueId(id, 'session_id');
  return withTransaction(database, () => {
    const current = getStoredAcpSession(database, sessionId);
    if (!current) throw new AcpStoreError('acp_session_not_found', `No ACP session named ${sessionId}.`);
    const cursorInput = event.event_cursor ?? event.cursor;
    const countInput = event.event_count;
    const bytesInput = event.event_bytes;
    const countDelta = event.count === undefined ? 1 : acpCounter(event.count, 'count');
    const bytesDelta = event.bytes === undefined ? 0 : acpCounter(event.bytes, 'bytes');
    const currentCursor = acpCounter(current.event_cursor, 'event_cursor');
    const currentCount = acpCounter(current.event_count, 'event_count');
    const currentBytes = acpCounter(current.event_bytes, 'event_bytes');
    const cursor = Math.max(currentCursor, cursorInput === undefined
      ? acpCounterSum(currentCursor, 1, 'event_cursor')
      : acpCounter(cursorInput, 'event_cursor'));
    const count = Math.max(currentCount, countInput === undefined
      ? acpCounterSum(currentCount, countDelta, 'event_count')
      : acpCounter(countInput, 'event_count'));
    const bytes = Math.max(currentBytes, bytesInput === undefined
      ? acpCounterSum(currentBytes, bytesDelta, 'event_bytes')
      : acpCounter(bytesInput, 'event_bytes'));
    const at = acpTimestamp(event.at ?? event.updated_at ?? event.updatedAt, 'updated_at', nowIso());
    updateAcpColumns(database, 'acp_sessions', 'id', sessionId, {
      event_cursor: cursor,
      event_count: count,
      event_bytes: bytes,
      updated_at: at,
    }, ACP_SESSION_MUTABLE_COLUMNS);
    return { changed: true, session: getStoredAcpSession(database, sessionId) };
  });
}

function findStoredAcpTurnByRequest(database, sessionId, requestId) {
  if (!requestId) return null;
  return database.prepare(
    'SELECT * FROM acp_turns WHERE session_id = ? AND request_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
  ).get(sessionId, requestId) ?? null;
}

function findStoredAcpTurnByRequestGlobal(database, requestId) {
  if (!requestId) return null;
  return database.prepare(
    'SELECT * FROM acp_turns WHERE request_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
  ).get(requestId) ?? null;
}

export function getStoredAcpTurn(database, id) {
  const turnId = acpOpaqueId(id, 'turn_id');
  if (!turnId) return null;
  return hydrateAcpTurn(database.prepare('SELECT * FROM acp_turns WHERE id = ?').get(turnId) ?? null);
}

function hydrateAcpTurn(row) {
  if (!row) return null;
  return { ...row, turn_id: row.id };
}

export const getAcpTurn = getStoredAcpTurn;

export function listStoredAcpTurns(database, sessionId, limit = null) {
  const normalizedSessionId = acpOpaqueId(sessionId, 'session_id');
  if (!normalizedSessionId) return [];
  if (limit === null || limit === undefined) {
    return database.prepare(
      'SELECT * FROM acp_turns WHERE session_id = ? ORDER BY created_at ASC, id ASC',
    ).all(normalizedSessionId).map(hydrateAcpTurn);
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new AcpStoreError('invalid_limit', 'ACP turn limit must be a non-negative integer.');
  }
  return database.prepare(
    'SELECT * FROM acp_turns WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
  ).all(normalizedSessionId, limit).map(hydrateAcpTurn);
}

export const listAcpTurns = listStoredAcpTurns;

export function insertAcpTurn(database, sessionId, input = {}) {
  if (isPlainObject(sessionId)) {
    input = sessionId;
    sessionId = input.session_id ?? input.sessionId;
  }
  const normalizedSessionId = acpOpaqueId(sessionId ?? input.session_id ?? input.sessionId, 'session_id');
  if (!normalizedSessionId) throw new AcpStoreError('invalid_acp_id', 'session_id is required for an ACP turn.');
  const normalized = normalizedAcpTurn({ ...input, session_id: normalizedSessionId }, normalizedSessionId);
  return withTransaction(database, () => {
    const parentSession = getStoredAcpSession(database, normalizedSessionId);
    if (!parentSession) {
      throw new AcpStoreError('acp_session_not_found', `No ACP session named ${normalizedSessionId}.`);
    }
    if (normalized.state === 'uncertain') {
      promoteAcpSessionUncertainInTransaction(
        database,
        parentSession,
        normalized.uncertainty,
        normalized.updated_at ?? nowIso(),
      );
    } else if (parentSession.state !== 'ready') {
      throw new AcpStoreError(
        parentSession.state === 'uncertain' ? 'acp_session_uncertain' : 'acp_session_not_ready',
        `ACP session ${normalizedSessionId} is ${parentSession.state}; new turns require an explicitly ready session.`,
      );
    }
    if (normalized.request_id) {
      const existingSession = findStoredAcpSessionByRequest(database, normalized.request_id);
      if (existingSession) {
        throw new AcpStoreError(
          'request_id_conflict',
          `Request ID ${normalized.request_id} is already reserved by an ACP session; session and turn request identities cannot be reused across kinds.`,
          { request_id: normalized.request_id, existing_kind: 'session' },
        );
      }
      const existing = findStoredAcpTurnByRequestGlobal(database, normalized.request_id);
      if (existing) {
        if (!sameRequestFingerprint(existing, normalized.request_fingerprint)) {
          requestFingerprintConflict(normalized.request_id, existing, normalized.request_fingerprint);
        }
        return acpTurnInsertResult(existing, true);
      }
    }
    if (getStoredAcpTurn(database, normalized.id)) {
      throw new AcpStoreError('acp_id_conflict', `ACP turn ID ${normalized.id} already exists.`);
    }
    database.prepare(
      `INSERT INTO acp_turns (${ACP_TURN_CREATE_COLUMNS.join(', ')})
       VALUES (${ACP_TURN_CREATE_COLUMNS.map(() => '?').join(', ')})`,
    ).run(...ACP_TURN_CREATE_COLUMNS.map((column) => normalized[column]));
    return acpTurnInsertResult(getStoredAcpTurn(database, normalized.id), false);
  });
}

export const createAcpTurn = insertAcpTurn;

export function updateAcpTurn(database, id, patch = {}) {
  const turnId = acpOpaqueId(id, 'turn_id');
  if (!turnId) return null;
  return withTransaction(database, () => {
    const current = getStoredAcpTurn(database, turnId);
    if (!current) return null;
    const safePatch = normalizedAcpTurnPatch(patch);
    delete safePatch.state;
    delete safePatch.status;
    preserveRequestIdentity(current, safePatch);
    preserveUncertainty(current, safePatch);
    reconcileTtlPatch(current, safePatch);
    const updatedAt = acpTimestamp(patch.updated_at ?? patch.updatedAt, 'updated_at', nowIso());
    safePatch.updated_at = updatedAt;
    updateAcpColumns(database, 'acp_turns', 'id', turnId, safePatch, ACP_TURN_MUTABLE_COLUMNS);
    return getStoredAcpTurn(database, turnId);
  });
}

function turnTransitionPatch(nextState, current, patch = {}, occurredAt) {
  const safePatch = normalizedAcpTurnPatch(patch);
  delete safePatch.state;
  delete safePatch.status;
  preserveRequestIdentity(current, safePatch);
  preserveUncertainty(current, safePatch);
  reconcileTtlPatch(current, safePatch);
  safePatch.updated_at = occurredAt;
  if (nextState === 'prompting' && !current.started_at) safePatch.started_at = occurredAt;
  if (nextState === 'uncertain') {
    if (safePatch.uncertainty === undefined) {
      safePatch.uncertainty = current.uncertainty ?? JSON.stringify({ reason: 'provider_outcome_uncertain' });
    }
  }
  if (['completed', 'closed', 'failed'].includes(nextState) && !current.finished_at) safePatch.finished_at = occurredAt;
  return safePatch;
}

function promoteAcpSessionUncertainInTransaction(database, parent, uncertainty, occurredAt) {
  if (parent.state === 'uncertain') return parent;
  if (!ACP_SESSION_TRANSITIONS[parent.state]?.has('uncertain')) {
    throw new AcpStoreError(
      'invalid_acp_transition',
      `Cannot mark turn uncertain while parent session is ${parent.state}.`,
    );
  }
  const parentPatch = sessionTransitionPatch('uncertain', parent, {
    uncertainty,
    updated_at: occurredAt,
  }, occurredAt);
  parentPatch.state = 'uncertain';
  updateAcpColumns(
    database,
    'acp_sessions',
    'id',
    parent.id,
    parentPatch,
    new Set([...ACP_SESSION_MUTABLE_COLUMNS, 'state']),
  );
  return getStoredAcpSession(database, parent.id);
}

export function transitionAcpTurn(database, id, nextState, patch = {}, _payload = null) {
  const turnId = acpOpaqueId(id, 'turn_id');
  const targetState = acpTurnState(nextState);
  if (targetState === 'uncertain') {
    return markAcpTurnUncertain(database, turnId, patch.uncertainty ?? {}, patch);
  }
  return withTransaction(database, () => {
    const current = getStoredAcpTurn(database, turnId);
    if (!current) throw new AcpStoreError('acp_turn_not_found', `No ACP turn named ${turnId}.`);
    const currentState = acpTurnState(current.state);
    if (currentState === targetState) return { changed: false, turn: current };
    if (!ACP_TURN_TRANSITIONS[currentState]?.has(targetState)) {
      throw new AcpStoreError(
        'invalid_acp_transition',
        `Invalid ACP turn transition ${currentState} -> ${targetState}.`,
      );
    }
    const occurredAt = acpTimestamp(patch.updated_at ?? patch.updatedAt, 'updated_at', nowIso());
    const safePatch = turnTransitionPatch(targetState, current, patch, occurredAt);
    safePatch.state = targetState;
    updateAcpColumns(database, 'acp_turns', 'id', turnId, safePatch, new Set([...ACP_TURN_MUTABLE_COLUMNS, 'state']));
    return { changed: true, turn: getStoredAcpTurn(database, turnId) };
  });
}

export const transitionAcpTurnState = transitionAcpTurn;

export function terminalizeAcpTurn(database, id, outcome, patch = {}, payload = null) {
  if (!ACP_TERMINAL_TURN_STATES.has(outcome)) {
    throw new AcpStoreError('invalid_acp_state', `Invalid ACP turn terminal state: ${outcome}.`);
  }
  return transitionAcpTurn(database, id, outcome, patch, payload);
}

export function markAcpTurnUncertain(database, id, uncertainty = {}, patch = {}) {
  const turnId = acpOpaqueId(id, 'turn_id');
  return withTransaction(database, () => {
    const current = getStoredAcpTurn(database, turnId);
    if (!current) throw new AcpStoreError('acp_turn_not_found', `No ACP turn named ${turnId}.`);
    const parent = getStoredAcpSession(database, current.session_id);
    if (!parent) throw new AcpStoreError('acp_session_not_found', `No ACP session named ${current.session_id}.`);
    const occurredAt = acpTimestamp(patch.updated_at ?? patch.updatedAt, 'updated_at', nowIso());

    // The turn and its parent are fenced under one BEGIN IMMEDIATE transaction.
    // A restart can therefore observe either the fully reconciliable pair or
    // neither mutation, never a prompting turn under a ready session.
    const promotedParent = promoteAcpSessionUncertainInTransaction(
      database,
      parent,
      uncertainty,
      occurredAt,
    );

    const safePatch = turnTransitionPatch('uncertain', current, {
      ...patch,
      uncertainty,
      updated_at: occurredAt,
    }, occurredAt);
    safePatch.state = 'uncertain';
    updateAcpColumns(
      database,
      'acp_turns',
      'id',
      turnId,
      safePatch,
      new Set([...ACP_TURN_MUTABLE_COLUMNS, 'state']),
    );
    return {
      changed: current.state !== 'uncertain' || parent.state !== 'uncertain',
      turn: getStoredAcpTurn(database, turnId),
      session: promotedParent,
    };
  });
}

export function recordAcpTurnEvent(database, id, event = {}) {
  const turnId = acpOpaqueId(id, 'turn_id');
  return withTransaction(database, () => {
    const current = getStoredAcpTurn(database, turnId);
    if (!current) throw new AcpStoreError('acp_turn_not_found', `No ACP turn named ${turnId}.`);
    const cursorInput = event.event_cursor ?? event.cursor;
    const countInput = event.event_count;
    const bytesInput = event.event_bytes;
    const countDelta = event.count === undefined ? 1 : acpCounter(event.count, 'count');
    const bytesDelta = event.bytes === undefined ? 0 : acpCounter(event.bytes, 'bytes');
    const currentCursor = acpCounter(current.event_cursor, 'event_cursor');
    const currentCount = acpCounter(current.event_count, 'event_count');
    const currentBytes = acpCounter(current.event_bytes, 'event_bytes');
    const cursor = Math.max(currentCursor, cursorInput === undefined
      ? acpCounterSum(currentCursor, 1, 'event_cursor')
      : acpCounter(cursorInput, 'event_cursor'));
    const count = Math.max(currentCount, countInput === undefined
      ? acpCounterSum(currentCount, countDelta, 'event_count')
      : acpCounter(countInput, 'event_count'));
    const bytes = Math.max(currentBytes, bytesInput === undefined
      ? acpCounterSum(currentBytes, bytesDelta, 'event_bytes')
      : acpCounter(bytesInput, 'event_bytes'));
    const at = acpTimestamp(event.at ?? event.updated_at ?? event.updatedAt, 'updated_at', nowIso());
    updateAcpColumns(database, 'acp_turns', 'id', turnId, {
      event_cursor: cursor,
      event_count: count,
      event_bytes: bytes,
      updated_at: at,
    }, ACP_TURN_MUTABLE_COLUMNS);
    return { changed: true, turn: getStoredAcpTurn(database, turnId) };
  });
}

/** Select only definitively closed, expired sessions with no recorded process. */
export function listAcpSessionsForCleanup(database, at = nowIso(), limit = 100) {
  const timestamp = acpTimestamp(at, 'at');
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new AcpStoreError('invalid_limit', 'ACP cleanup limit must be a non-negative integer.');
  }
  return database.prepare(`
    SELECT * FROM acp_sessions
    WHERE state = 'closed'
      AND uncertainty IS NULL
      AND expires_at IS NOT NULL
      AND expires_at <= ?
      AND worker_pid IS NULL
      AND provider_pid IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM acp_turns t
        WHERE t.session_id = acp_sessions.id AND t.state = 'uncertain'
      )
    ORDER BY expires_at ASC, created_at ASC, id ASC
    LIMIT ?
  `).all(timestamp, limit).map(hydrateAcpSession);
}

export const selectAcpSessionsForCleanup = listAcpSessionsForCleanup;

export function cleanupAcpSessions(database, at = nowIso(), limit = 100) {
  return withTransaction(database, () => {
    const eligible = listAcpSessionsForCleanup(database, at, limit);
    for (const session of eligible) {
      database.prepare(`DELETE FROM acp_sessions
        WHERE id = ? AND state = 'closed' AND uncertainty IS NULL
          AND worker_pid IS NULL AND provider_pid IS NULL
          AND NOT EXISTS (SELECT 1 FROM acp_turns t WHERE t.session_id = acp_sessions.id AND t.state = 'uncertain')`).run(session.id);
    }
    return { deleted: eligible.length, sessions: eligible };
  });
}

export const pruneAcpSessions = cleanupAcpSessions;

function publicToken(value, maximum = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value) || /\s/u.test(value) || /[\\/]/u.test(value)) return null;
  return value;
}

function publicAcpUncertainty(row) {
  if (row?.state !== 'uncertain') return null;
  const uncertainty = acpStoredJson(row.uncertainty, null);
  const code = publicToken(uncertainty?.code ?? uncertainty?.reason, 128);
  return code ? { present: true, code } : { present: true };
}

/**
 * Compact/public ACP projection.  Deliberately omits target context,
 * effective configuration, owner-only session paths, and all provider
 * payloads.  Callers needing those private fields must use the exact-session
 * store boundary rather than routine status/list responses.
 */
export function compactAcpSession(row) {
  if (!row) return null;
  const sessionId = row.id ?? row.session_id;
  return {
    id: publicToken(sessionId),
    session_id: publicToken(sessionId),
    provider: publicToken(row.provider, 128),
    profile: publicToken(row.profile, 128),
    acpx_record_id: publicToken(row.acpx_record_id, 256),
    state: ACP_SESSION_STATES.includes(row.state) ? row.state : 'creating',
    request_id: publicToken(row.request_id, 128),
    worker_pid: Number.isSafeInteger(row.worker_pid) && row.worker_pid > 0 ? row.worker_pid : null,
    provider_pid: Number.isSafeInteger(row.provider_pid) && row.provider_pid > 0 ? row.provider_pid : null,
    capability_version: publicToken(row.capability_version, 128),
    provider_version: publicToken(row.provider_version, 128),
    event_cursor: Number.isSafeInteger(row.event_cursor) ? row.event_cursor : 0,
    event_count: Number.isSafeInteger(row.event_count) ? row.event_count : 0,
    event_bytes: Number.isSafeInteger(row.event_bytes) ? row.event_bytes : 0,
    uncertain: row.state === 'uncertain',
    uncertainty: publicAcpUncertainty(row),
    created_at: publicToken(row.created_at, 64),
    updated_at: publicToken(row.updated_at, 64),
    ready_at: publicToken(row.ready_at, 64),
    prompting_at: publicToken(row.prompting_at, 64),
    cancelling_at: publicToken(row.cancelling_at, 64),
    uncertain_at: publicToken(row.uncertain_at, 64),
    closed_at: publicToken(row.closed_at, 64),
    failed_at: publicToken(row.failed_at, 64),
    expires_at: publicToken(row.expires_at, 64),
    ttl_seconds: Number.isSafeInteger(row.ttl_seconds) && row.ttl_seconds >= 0 ? row.ttl_seconds : null,
    error_code: publicToken(row.error_code, 128),
  };
}

export const publicAcpSession = compactAcpSession;
export const projectAcpSession = compactAcpSession;

export function compactAcpTurn(row) {
  if (!row) return null;
  const turnId = row.id ?? row.turn_id;
  return {
    id: publicToken(turnId),
    turn_id: publicToken(turnId),
    session_id: publicToken(row.session_id),
    request_id: publicToken(row.request_id, 128),
    state: ACP_TURN_STATES.includes(row.state) ? row.state : 'creating',
    worker_pid: Number.isSafeInteger(row.worker_pid) && row.worker_pid > 0 ? row.worker_pid : null,
    provider_pid: Number.isSafeInteger(row.provider_pid) && row.provider_pid > 0 ? row.provider_pid : null,
    capability_version: publicToken(row.capability_version, 128),
    provider_version: publicToken(row.provider_version, 128),
    event_cursor: Number.isSafeInteger(row.event_cursor) ? row.event_cursor : 0,
    event_count: Number.isSafeInteger(row.event_count) ? row.event_count : 0,
    event_bytes: Number.isSafeInteger(row.event_bytes) ? row.event_bytes : 0,
    uncertain: row.state === 'uncertain',
    uncertainty: publicAcpUncertainty(row),
    created_at: publicToken(row.created_at, 64),
    updated_at: publicToken(row.updated_at, 64),
    started_at: publicToken(row.started_at, 64),
    finished_at: publicToken(row.finished_at, 64),
    expires_at: publicToken(row.expires_at, 64),
    ttl_seconds: Number.isSafeInteger(row.ttl_seconds) && row.ttl_seconds >= 0 ? row.ttl_seconds : null,
    error_code: publicToken(row.error_code, 128),
    stop_reason: publicToken(row.stop_reason, 256),
  };
}

export const publicAcpTurn = compactAcpTurn;

export const __testing = Object.freeze({
  lifecycleFromStatus,
  lifecycleOf,
  legacyFromLifecycle,
  terminalOf,
  validateAcpMetadataValue,
  normalizedAcpSession,
  normalizedAcpTurn,
});
