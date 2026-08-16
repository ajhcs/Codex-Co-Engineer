import { DatabaseSync } from 'node:sqlite';

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

function nowIso() {
  return new Date().toISOString();
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
  const database = new DatabaseSync(file);
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
  backfillLifecycleEvents(database);
  return database;
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

export function findStoredRequest(database, requestId) {
  return database.prepare('SELECT * FROM jobs WHERE request_id = ?').get(requestId) ?? null;
}

export const __testing = Object.freeze({
  lifecycleFromStatus,
  lifecycleOf,
  legacyFromLifecycle,
  terminalOf,
});
