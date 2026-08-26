// RunRuntimeV1 — P33 composition over frozen P24/P25/R24A/R25B/P27/P34
// plus injected scheduler, artifact bridge, and lifecycle settlement.
//
// Additive v3 facade. createRunRuntime receives already-constructed
// handles and functions; it does not open roots, import scheduler or
// artifact-bridge implementations, or own worker/boundary/lock recovery.
// Exact P24 identity is the durable one-submission authority. Scheduler
// dispatch happens only when P24 reports created=true. inspect/remember
// recover stored submission identity and never invent a placeholder
// digest. Child terminal journal facts are accepted only after
// settleLocalTaskLifecycle returns final=true and only for
// authoritatively dispatched lanes. Unresolved evidence and unconfirmed
// cancellation never map to a journal terminal outcome.
// cleanupLocalTaskLifecycle is invoked idempotently on
// terminal, cancel, and restart. Artifact cleanup is proof-bound and
// never runs without that finality. P27 is composed as R24A
// resolution_ready (ask-once selection already persisted). R25B is the
// aggregate journal path. P34 latches decision evidence. This module
// never inspects host process tables, unit membership, or managed locks,
// never creates candidate refs, and never claims Gate A, release, or a
// public tool.

import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedTest,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  RunContractV1Error,
  assertBaseSha,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  RUN_JOURNAL_EVENT_KINDS,
  RUN_JOURNAL_GENESIS_PREV,
  RUN_JOURNAL_OUTCOMES,
} from './run-reducer.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

export const RUN_RUNTIME_SCHEMA_ID = 'codex-co-engineer.run-runtime.v1';
export const RUN_RUNTIME_VERSION = 1;
export const RUN_RUNTIME_RECEIPT_SCHEMA_ID = 'codex-co-engineer.run-runtime-receipt.v1';
export const RUN_RUNTIME_HASH_DOMAIN = 'codex-co-engineer.run-runtime-hash.v1';

export const RUN_RUNTIME_METHODS = capturedFreeze([
  'submitRun', 'resumeRun', 'cancelRun', 'inspectRun',
]);
export const RUN_RUNTIME_DEPENDENCY_KEYS = capturedFreeze([
  'aggregateAnchor',
  'artifactBridge',
  'attentionBatch',
  'cleanupLocalTaskLifecycle',
  'clock',
  'runJournal',
  'runStore',
  'scheduler',
  'settleLocalTaskLifecycle',
]);
export const RUN_STORE_METHODS = capturedFreeze(['getByRunId', 'submit']);
export const RUN_JOURNAL_METHODS = capturedFreeze([
  'create', 'createAggregate', 'open', 'openAggregate',
]);
export const AGGREGATE_ANCHOR_METHODS = capturedFreeze(['getCoordination']);
export const ATTENTION_BATCH_METHODS = capturedFreeze(['get', 'latch', 'reply']);
export const SCHEDULER_METHODS = capturedFreeze([
  'cancelAssignments', 'resumeAssignments', 'submitAssignments',
]);
export const ARTIFACT_BRIDGE_METHODS = capturedFreeze([
  'captureAssignmentArtifacts', 'cleanupRunArtifacts', 'projectAssignmentArtifacts',
]);
export const LIFECYCLE_FUNCTION_KEYS = capturedFreeze([
  'cleanupLocalTaskLifecycle', 'settleLocalTaskLifecycle',
]);

export const RUN_RUNTIME_SUBMIT_KEYS = capturedFreeze([
  'assignments', 'git', 'identity', 'provenance', 'request_idempotency_key',
  'run_id', 'telemetry',
]);
export const RUN_RUNTIME_RESUME_KEYS = capturedFreeze([
  'assignment_ids', 'attention_items', 'cursors', 'run_id',
]);
export const RUN_RUNTIME_CANCEL_KEYS = capturedFreeze([
  'assignment_ids', 'cleanup', 'run_id',
]);
export const RUN_RUNTIME_INSPECT_KEYS = capturedFreeze([
  'assignment_id', 'cursor', 'run_id',
]);

export const RUN_RUNTIME_STATUSES = capturedFreeze([
  'submitted', 'idempotent', 'awaiting_selection', 'dispatched', 'partial',
  'inspected', 'cancelled', 'lifecycle_pending',
]);
export const RUN_RUNTIME_LANE_STATUSES = capturedFreeze([
  'dispatched', 'running', 'needs_attention', 'completed', 'failed',
  'cancelled', 'unresolved', 'timeout', 'transport_lost', 'environment_blocked',
  'lifecycle_pending',
]);
export const RUN_RUNTIME_JOURNAL_MODES = capturedFreeze(['legacy', 'aggregate']);
export const RUN_RUNTIME_CLEANUP_STATUSES = capturedFreeze([
  'pending', 'normal', 'recovered', 'unknown', 'failed',
]);
export const RUN_RUNTIME_BOUNDARY_STATUSES = capturedFreeze([
  'pending', 'active', 'inactive_empty', 'unknown', 'not_applicable',
]);
export const RUN_RUNTIME_LOCK_STATUSES = capturedFreeze([
  'pending', 'active', 'unlocked', 'cleaned', 'unknown', 'not_applicable',
]);
export const RUN_RUNTIME_LIFECYCLE_REASONS = capturedFreeze([
  'boundary_visibility_unknown',
  'boundary_identity_mismatch',
  'boundary_not_empty',
  'worker_exit_timeout',
  'lock_release_unproven',
  'lock_cleanup_refused',
  'cleanup_failed',
]);
export const LIFECYCLE_RECORD_KEYS = capturedFreeze([
  'boundary', 'cleanup', 'final', 'lock', 'public_state', 'reason',
  'stored_status', 'task_id', 'version',
]);
export const LIFECYCLE_CLEANUP_KEYS = capturedFreeze(['code', 'status']);
export const LIFECYCLE_PROOF_KEYS = capturedFreeze(['status']);

export const RUN_RUNTIME_LANE_KEYS = capturedFreeze([
  'access', 'assignment_id', 'attention', 'cleanup', 'cursor', 'model',
  'provider', 'required', 'role', 'starting_ref', 'status', 'task_id',
  'unresolved', 'write_scope',
]);
export const RUN_RUNTIME_RECEIPT_KEYS = capturedFreeze([
  'assignment_count', 'attention', 'base_sha', 'checks', 'cleanup',
  'complete_candidate_blocked', 'created', 'cursor', 'journal', 'lanes',
  'observed_at', 'remote_mutated', 'run_id', 'schema', 'side_effects',
  'status', 'version', 'wake',
]);
export const RUN_RUNTIME_JOURNAL_KEYS = capturedFreeze([
  'head_hash', 'mode', 'revision', 'run_opened', 'run_outcome', 'terminal',
]);
export const RUN_RUNTIME_ATTENTION_KEYS = capturedFreeze([
  'batch_id', 'complete_candidate_blocked', 'revision', 'status', 'wake',
]);
export const RUN_RUNTIME_CLEANUP_KEYS = capturedFreeze([
  'cleaned', 'proof_bound', 'remaining', 'removed', 'unresolved',
]);

export const RUN_RUNTIME_CHECKS = capturedFreeze([
  'request_quarantine',
  'exact_identity',
  'idempotent_submission',
  'one_submission',
  'p24_durable_identity',
  'p27_resolution_ready',
  'r25b_aggregate_journal',
  'no_duplicate_dispatch',
  'no_replay',
  'no_fallback',
  'lifecycle_final_before_child_terminal',
  'proof_bound_cleanup',
  'decision_or_attention',
  'remote_mutation_denied',
]);
export const RUN_RUNTIME_SIDE_EFFECTS = capturedFreeze([
  'task_dispatched',
  'task_cancelled',
  'duplicate_dispatch',
  'replay',
  'fallback',
  'workspace_created',
  'branch_or_ref_created',
  'candidate_composed',
  'server_cutover',
  'lifecycle_owned',
  'lock_cleaned',
  'unit_stopped',
  'remote_mutated',
]);
export const RUN_RUNTIME_ALWAYS_FALSE_SIDE_EFFECTS = capturedFreeze([
  'duplicate_dispatch',
  'replay',
  'fallback',
  'workspace_created',
  'branch_or_ref_created',
  'candidate_composed',
  'server_cutover',
  'lifecycle_owned',
  'lock_cleaned',
  'unit_stopped',
  'remote_mutated',
]);

export const MAX_RUNTIME_DIAGNOSTIC_BYTES = 160;
export const CLOCK_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
export const IDEMPOTENCY_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const HASH_ALGORITHM = 'sha256';
const CREATE_HASH = createHash;
const IS_PROXY = utilTypes.isProxy;
const STRING = String;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const ARRAY_IS_ARRAY = Array.isArray;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const AGGREGATE_READY_PHASE = 'resolution_ready';
const AGGREGATE_MISSING_CODES = capturedFreeze([
  'aggregate_run_not_found',
]);
const JOURNAL_MISSING_CODES = capturedFreeze([
  'run_journal_not_found',
]);
const STORE_MISSING_CODES = capturedFreeze([
  'run_store_not_found',
  'runtime_run_unknown',
]);
const STORE_IDENTITY_CONFLICT_CODES = capturedFreeze([
  'run_identity_conflict',
  'run_idempotency_conflict',
]);
const SCHEDULER_MISSING_CODES = capturedFreeze([
  'scheduler_run_unknown',
  'runtime_run_unknown',
]);
const TERMINAL_LANE_STATUSES = capturedFreeze([
  'completed', 'failed', 'cancelled', 'timeout',
  'transport_lost', 'environment_blocked',
]);
const JOURNAL_TERMINAL_STATUSES = capturedFreeze([
  'completed', 'failed', 'cancelled', 'timeout', 'environment_blocked',
]);
const FORBIDDEN_REQUEST_KEYS = capturedFreeze({
  allow_fallback: 'replay_or_fallback_denied',
  allow_post_dispatch_fallback: 'replay_or_fallback_denied',
  allow_replay: 'replay_or_fallback_denied',
  fallback: 'replay_or_fallback_denied',
  fallback_model: 'replay_or_fallback_denied',
  fallback_provider: 'replay_or_fallback_denied',
  fallbacks: 'replay_or_fallback_denied',
  redrive: 'replay_or_fallback_denied',
  replay: 'replay_or_fallback_denied',
  resend: 'replay_or_fallback_denied',
  retry_dispatch: 'replay_or_fallback_denied',
  direct_mode: 'direct_mode_rejected',
  workspace_mode: 'direct_mode_rejected',
  allow_create_pr: 'merge_authority_denied',
  allow_merge: 'merge_authority_denied',
  allow_push: 'merge_authority_denied',
  create_pr: 'merge_authority_denied',
  create_pull_request: 'merge_authority_denied',
  force_push: 'merge_authority_denied',
  merge: 'merge_authority_denied',
  merge_pr: 'merge_authority_denied',
  merges: 'merge_authority_denied',
  open_pr: 'merge_authority_denied',
  push: 'merge_authority_denied',
  push_branch: 'merge_authority_denied',
  github: 'remote_mutation_denied',
  remote: 'remote_mutation_denied',
  worktree: 'lifecycle_authority_denied',
  branch: 'lifecycle_authority_denied',
  lock: 'lifecycle_authority_denied',
  candidate: 'candidate_authority_denied',
  lifecycle_root: 'lifecycle_authority_denied',
});

const CONTENT_FREE = capturedFreeze({
  accessor_property_denied: 'Accessor properties are denied.',
  aliased_reference_denied: 'Aliased references are denied.',
  candidate_authority_denied: 'Candidate refs are outside this runtime.',
  cursor_identity_mismatch: 'Cursor rows must bind the exact assignment and task.',
  direct_mode_rejected: 'Run submissions reject direct mode.',
  duplicate_assignment_id: 'Assignment ids in a run must be unique.',
  exotic_prototype_denied: 'Exotic prototypes are denied.',
  injected_dependency_invalid: 'createRunRuntime requires the closed injected seams.',
  invalid_clock: 'The injected clock must return a UTC timestamp.',
  invalid_format: 'A runtime field is not in the required format.',
  invalid_type: 'A runtime field is not the required JSON type.',
  lifecycle_authority_denied: 'The runtime does not own worker, boundary, or lock recovery.',
  merge_authority_denied: 'Merge, push, and pull-request authority is denied.',
  missing_key: 'A required runtime field is missing.',
  own_undefined_denied: 'Own undefined values are denied.',
  out_of_range: 'A runtime collection is outside the closed bounds.',
  proxy_denied: 'Proxy values are denied.',
  remote_mutation_denied: 'Remote mutation is denied.',
  replay_or_fallback_denied: 'Replay and fallback are denied.',
  runtime_assignment_unknown: 'The assignment id is not part of this run.',
  runtime_cleanup_unproven: 'Artifact cleanup requires proven run ownership and lifecycle finality.',
  runtime_identity_conflict: 'The run id already binds a different canonical body.',
  runtime_journal_failed: 'The injected journal seam failed closed.',
  runtime_lifecycle_failed: 'The injected lifecycle seam failed closed.',
  runtime_run_unknown: 'The run is not available.',
  runtime_scheduler_failed: 'The injected scheduler seam failed closed.',
  runtime_selection_unresolved: 'Dispatch requires R24A/P27 resolution_ready.',
  runtime_store_failed: 'The injected run store seam failed closed.',
  symbol_key_denied: 'Symbol keys are denied.',
  unknown_key: 'A runtime field is outside the closed vocabulary.',
});

export const RUN_RUNTIME_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'aliased_reference_denied',
  'candidate_authority_denied',
  'cursor_identity_mismatch',
  'direct_mode_rejected',
  'duplicate_assignment_id',
  'exotic_prototype_denied',
  'injected_dependency_invalid',
  'invalid_clock',
  'invalid_format',
  'invalid_type',
  'lifecycle_authority_denied',
  'merge_authority_denied',
  'missing_key',
  'own_undefined_denied',
  'out_of_range',
  'proxy_denied',
  'remote_mutation_denied',
  'replay_or_fallback_denied',
  'runtime_assignment_unknown',
  'runtime_cleanup_unproven',
  'runtime_identity_conflict',
  'runtime_journal_failed',
  'runtime_lifecycle_failed',
  'runtime_run_unknown',
  'runtime_scheduler_failed',
  'runtime_selection_unresolved',
  'runtime_store_failed',
  'symbol_key_denied',
  'unknown_key',
]);

function diagnostic(value) {
  const text = STRING(value ?? '');
  return text.length <= MAX_RUNTIME_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_RUNTIME_DIAGNOSTIC_BYTES);
}

function failRuntime(code, field, message) {
  fail(code, field, diagnostic(message ?? CONTENT_FREE[code] ?? CONTENT_FREE.invalid_format));
}

function isTypedError(error) {
  return error instanceof RunContractV1Error;
}

function errorCodeOf(error) {
  return isTypedError(error) ? error.code : null;
}

async function callInjected(fn, args, code, field) {
  try {
    return await fn(...args);
  } catch (error) {
    if (isTypedError(error)) throw error;
    failRuntime(code, field, CONTENT_FREE[code]);
  }
}

function assertFunction(value, field) {
  assertNotProxy(value, field);
  if (typeof value !== 'function') {
    failRuntime('injected_dependency_invalid', field, CONTENT_FREE.injected_dependency_invalid);
  }
  return value;
}

function assertMethodMap(value, field, methods) {
  assertPlainObject(value, 'injected_dependency_invalid', field, 'The injected seam');
  for (const method of methods) {
    const candidate = value[method];
    if (typeof candidate !== 'function') {
      failRuntime('injected_dependency_invalid', `${field}.${method}`,
        CONTENT_FREE.injected_dependency_invalid);
    }
    assertNotProxy(candidate, `${field}.${method}`);
  }
  return value;
}

function parseDependencies(dependencies) {
  if (dependencies === undefined || dependencies === null) {
    failRuntime('injected_dependency_invalid', 'dependencies',
      CONTENT_FREE.injected_dependency_invalid);
  }
  assertNotProxy(dependencies, 'dependencies');
  assertPlainObject(dependencies, 'injected_dependency_invalid', 'dependencies',
    'createRunRuntime dependencies');
  const keys = sortedCapturedKeys(dependencies);
  if (REFLECT_OWN_KEYS(dependencies).some((key) => typeof key === 'symbol')) {
    failRuntime('symbol_key_denied', 'dependencies', CONTENT_FREE.symbol_key_denied);
  }
  for (const key of keys) {
    if (!capturedIncludes(RUN_RUNTIME_DEPENDENCY_KEYS, key)) {
      failRuntime('unknown_key', `dependencies.${key}`, CONTENT_FREE.unknown_key);
    }
  }
  for (const key of RUN_RUNTIME_DEPENDENCY_KEYS) {
    if (!capturedHasOwn(dependencies, key)) {
      failRuntime('missing_key', `dependencies.${key}`, CONTENT_FREE.missing_key);
    }
  }
  return capturedFreeze({
    runStore: assertMethodMap(ownDataValue(dependencies, 'runStore', 'dependencies.runStore'),
      'dependencies.runStore', RUN_STORE_METHODS),
    runJournal: assertMethodMap(ownDataValue(dependencies, 'runJournal', 'dependencies.runJournal'),
      'dependencies.runJournal', RUN_JOURNAL_METHODS),
    aggregateAnchor: assertMethodMap(
      ownDataValue(dependencies, 'aggregateAnchor', 'dependencies.aggregateAnchor'),
      'dependencies.aggregateAnchor', AGGREGATE_ANCHOR_METHODS),
    attentionBatch: assertMethodMap(
      ownDataValue(dependencies, 'attentionBatch', 'dependencies.attentionBatch'),
      'dependencies.attentionBatch', ATTENTION_BATCH_METHODS),
    scheduler: assertMethodMap(ownDataValue(dependencies, 'scheduler', 'dependencies.scheduler'),
      'dependencies.scheduler', SCHEDULER_METHODS),
    artifactBridge: assertMethodMap(
      ownDataValue(dependencies, 'artifactBridge', 'dependencies.artifactBridge'),
      'dependencies.artifactBridge', ARTIFACT_BRIDGE_METHODS),
    settleLocalTaskLifecycle: assertFunction(
      ownDataValue(dependencies, 'settleLocalTaskLifecycle',
        'dependencies.settleLocalTaskLifecycle'),
      'dependencies.settleLocalTaskLifecycle'),
    cleanupLocalTaskLifecycle: assertFunction(
      ownDataValue(dependencies, 'cleanupLocalTaskLifecycle',
        'dependencies.cleanupLocalTaskLifecycle'),
      'dependencies.cleanupLocalTaskLifecycle'),
    clock: assertFunction(ownDataValue(dependencies, 'clock', 'dependencies.clock'),
      'dependencies.clock'),
  });
}

function readClock(clock) {
  let value;
  try {
    value = clock();
  } catch (error) {
    if (isTypedError(error)) throw error;
    failRuntime('invalid_clock', 'clock', CONTENT_FREE.invalid_clock);
  }
  if (typeof value === 'number' && NUMBER_IS_SAFE_INTEGER(value) && value >= 0) {
    return new Date(value).toISOString();
  }
  if (typeof value !== 'string' || !capturedTest(CLOCK_ISO_PATTERN, value)) {
    failRuntime('invalid_clock', 'clock', CONTENT_FREE.invalid_clock);
  }
  return value;
}

function denyForbiddenKey(key, field) {
  const code = FORBIDDEN_REQUEST_KEYS[key];
  if (code) failRuntime(code, field, CONTENT_FREE[code]);
}

function quarantineRequest(request, field, allowed) {
  if (request === undefined || request === null) {
    failRuntime('invalid_type', field, CONTENT_FREE.invalid_type);
  }
  assertNotProxy(request, field);
  assertPlainObject(request, 'invalid_type', field, 'The runtime request');
  assertDirectJsonClosure(request, field);
  const ownKeys = REFLECT_OWN_KEYS(request);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      failRuntime('symbol_key_denied', field, CONTENT_FREE.symbol_key_denied);
    }
  }
  for (const key of sortedCapturedKeys(request)) {
    denyForbiddenKey(key, `${field}.${key}`);
    if (!capturedIncludes(allowed, key)) {
      failRuntime('unknown_key', `${field}.${key}`, CONTENT_FREE.unknown_key);
    }
  }
  return request;
}

function requireKey(parsed, key, field) {
  if (!hasOwn(parsed, key)) failRuntime('missing_key', field, CONTENT_FREE.missing_key);
  return ownDataValue(parsed, key, field);
}

function optionalKey(parsed, key, field) {
  if (!hasOwn(parsed, key)) return undefined;
  return ownDataValue(parsed, key, field);
}

function parseAssignments(value) {
  if (!ARRAY_IS_ARRAY(value) && !capturedIsArray(value)) {
    failRuntime('invalid_type', 'assignments', CONTENT_FREE.invalid_type);
  }
  assertNotProxy(value, 'assignments');
  if (value.length < MIN_ASSIGNMENTS || value.length > MAX_ASSIGNMENTS) {
    failRuntime('out_of_range', 'assignments', CONTENT_FREE.out_of_range);
  }
  const seen = new Set();
  const assignments = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const path = `assignments[${index}]`;
    assertPlainObject(item, 'invalid_type', path, 'An assignment');
    for (const key of sortedCapturedKeys(item)) denyForbiddenKey(key, `${path}.${key}`);
    if (!hasOwn(item, 'assignment_id')) {
      failRuntime('missing_key', `${path}.assignment_id`, CONTENT_FREE.missing_key);
    }
    const assignmentId = ownDataValue(item, 'assignment_id', `${path}.assignment_id`);
    if (!isAssignmentId(assignmentId)) {
      failRuntime('invalid_format', `${path}.assignment_id`, CONTENT_FREE.invalid_format);
    }
    if (seen.has(assignmentId)) {
      failRuntime('duplicate_assignment_id', `${path}.assignment_id`,
        CONTENT_FREE.duplicate_assignment_id);
    }
    seen.add(assignmentId);
    assignments.push(item);
  }
  return assignments;
}

function parseIdList(value, field, knownIds) {
  if (value === undefined) return [...knownIds];
  if (!ARRAY_IS_ARRAY(value) && !capturedIsArray(value)) {
    failRuntime('invalid_type', field, CONTENT_FREE.invalid_type);
  }
  if (value.length < 1 || value.length > MAX_ASSIGNMENTS) {
    failRuntime('out_of_range', field, CONTENT_FREE.out_of_range);
  }
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const assignmentId = value[index];
    if (!isAssignmentId(assignmentId)) {
      failRuntime('invalid_format', `${field}[${index}]`, CONTENT_FREE.invalid_format);
    }
    if (!knownIds.has(assignmentId)) {
      failRuntime('runtime_assignment_unknown', `${field}[${index}]`,
        CONTENT_FREE.runtime_assignment_unknown);
    }
    if (seen.has(assignmentId)) {
      failRuntime('duplicate_assignment_id', `${field}[${index}]`,
        CONTENT_FREE.duplicate_assignment_id);
    }
    seen.add(assignmentId);
    selected.push(assignmentId);
  }
  return selected;
}

function parseCursors(value, lanesById) {
  if (value === undefined) return new Map();
  if (!ARRAY_IS_ARRAY(value) && !capturedIsArray(value)) {
    failRuntime('invalid_type', 'cursors', CONTENT_FREE.invalid_type);
  }
  const cursors = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    const path = `cursors[${index}]`;
    assertPlainObject(row, 'invalid_type', path, 'A cursor row');
    for (const key of sortedCapturedKeys(row)) {
      if (!capturedIncludes(['assignment_id', 'event_cursor', 'task_id'], key)) {
        failRuntime('unknown_key', `${path}.${key}`, CONTENT_FREE.unknown_key);
      }
    }
    const assignmentId = requireKey(row, 'assignment_id', `${path}.assignment_id`);
    const taskId = requireKey(row, 'task_id', `${path}.task_id`);
    const eventCursor = requireKey(row, 'event_cursor', `${path}.event_cursor`);
    if (!isAssignmentId(assignmentId)) {
      failRuntime('invalid_format', `${path}.assignment_id`, CONTENT_FREE.invalid_format);
    }
    const lane = lanesById.get(assignmentId);
    if (!lane || lane.task_id !== taskId) {
      failRuntime('cursor_identity_mismatch', path, CONTENT_FREE.cursor_identity_mismatch);
    }
    cursors.set(assignmentId, { assignment_id: assignmentId, task_id: taskId, event_cursor: eventCursor });
  }
  return cursors;
}

function identityDigest(runId, baseSha, idempotencyKey, assignments) {
  const rows = assignments.map((assignment) => ({
    access: assignment.access ?? null,
    assignment_id: assignment.assignment_id,
    model: assignment.model ?? null,
    provider: assignment.provider ?? null,
    required: assignment.required !== false,
    role: assignment.role ?? null,
    starting_ref: assignment.starting_ref ?? null,
    task_id: assignment.task_id ?? null,
    write_scope: assignment.write_scope ?? null,
  }));
  rows.sort((left, right) => (left.assignment_id < right.assignment_id ? -1 : 1));
  const payload = canonicalJsonStringify({
    assignments: rows,
    base_sha: baseSha,
    domain: RUN_RUNTIME_HASH_DOMAIN,
    request_idempotency_key: idempotencyKey,
    run_id: runId,
  });
  return `sha256:${CREATE_HASH(HASH_ALGORITHM).update(payload).digest('hex')}`;
}

function assignmentsFromLanes(lanes) {
  return lanes.map((lane) => ({
    access: lane.access,
    assignment_id: lane.assignment_id,
    model: lane.model,
    provider: lane.provider,
    required: lane.required !== false,
    role: lane.role,
    starting_ref: lane.starting_ref ?? null,
    task_id: lane.task_id,
    write_scope: lane.write_scope,
  }));
}

function storedSubmissionFacts(stored) {
  if (stored === undefined || stored === null || typeof stored !== 'object'
    || ARRAY_IS_ARRAY(stored) || IS_PROXY(stored)) {
    return { durable: false, request_idempotency_key: null, base_sha: null };
  }
  const key = stored.request_idempotency_key;
  const requestKey = typeof key === 'string' && capturedTest(IDEMPOTENCY_KEY_PATTERN, key)
    ? key
    : null;
  let baseSha = null;
  const git = stored.git;
  if (git !== undefined && git !== null && typeof git === 'object' && !ARRAY_IS_ARRAY(git)
    && !IS_PROXY(git) && hasOwn(git, 'base_sha') && typeof git.base_sha === 'string') {
    try {
      assertBaseSha(git.base_sha, 'git.base_sha');
      baseSha = git.base_sha;
    } catch (error) {
      if (!(isTypedError(error) && error.code === 'invalid_format')) throw error;
    }
  }
  return { durable: true, request_idempotency_key: requestKey, base_sha: baseSha };
}

function recoveredIdentityDigest(runId, facts, assignments) {
  if (facts.request_idempotency_key === null || facts.base_sha === null
    || !ARRAY_IS_ARRAY(assignments) || assignments.length === 0) {
    return null;
  }
  return identityDigest(runId, facts.base_sha, facts.request_idempotency_key, assignments);
}

function assertNoIdentityConflict(known, digest, idempotencyKey) {
  if (!known) return;
  if (typeof known.request_idempotency_key === 'string'
    && known.request_idempotency_key !== idempotencyKey) {
    failRuntime('runtime_identity_conflict', 'run_id', CONTENT_FREE.runtime_identity_conflict);
  }
  if (typeof known.digest === 'string' && known.digest !== digest) {
    failRuntime('runtime_identity_conflict', 'run_id', CONTENT_FREE.runtime_identity_conflict);
  }
}

function mapStoreConflict(error) {
  if (isTypedError(error) && capturedIncludes(STORE_IDENTITY_CONFLICT_CODES, error.code)) {
    failRuntime('runtime_identity_conflict', 'run_id', CONTENT_FREE.runtime_identity_conflict);
  }
}

function baseShaFromGit(git) {
  assertPlainObject(git, 'invalid_type', 'git', 'git');
  if (!hasOwn(git, 'base_sha')) failRuntime('missing_key', 'git.base_sha', CONTENT_FREE.missing_key);
  const baseSha = ownDataValue(git, 'base_sha', 'git.base_sha');
  assertBaseSha(baseSha, 'git.base_sha');
  return baseSha;
}

function emptySideEffects() {
  const sideEffects = {};
  for (const claim of RUN_RUNTIME_SIDE_EFFECTS) sideEffects[claim] = false;
  return sideEffects;
}

function emptyChecks() {
  const checks = {};
  for (const check of RUN_RUNTIME_CHECKS) checks[check] = true;
  return checks;
}

function closedString(value, allowed) {
  return typeof value === 'string' && capturedIncludes(allowed, value) ? value : null;
}

function sanitizeCleanup(value) {
  if (typeof value === 'string') {
    const status = closedString(value, RUN_RUNTIME_CLEANUP_STATUSES);
    return freezeData({ status, code: null });
  }
  if (value === undefined || value === null || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) {
    return freezeData({ status: null, code: null });
  }
  const status = closedString(value.status, RUN_RUNTIME_CLEANUP_STATUSES);
  const code = typeof value.code === 'string' && capturedIncludes(RUN_RUNTIME_LIFECYCLE_REASONS, value.code)
    ? value.code
    : (typeof value.code === 'string' && capturedIncludes(RUN_RUNTIME_CLEANUP_STATUSES, value.code)
      ? value.code
      : null);
  return freezeData({ status, code });
}

function sanitizeProof(value, allowed) {
  if (typeof value === 'string') {
    return freezeData({ status: closedString(value, allowed) });
  }
  if (value === undefined || value === null || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) {
    return freezeData({ status: null });
  }
  return freezeData({ status: closedString(value.status, allowed) });
}

function sanitizeLifecycle(raw, expectedTaskId) {
  if (raw === undefined || raw === null || typeof raw !== 'object' || ARRAY_IS_ARRAY(raw)
    || IS_PROXY(raw)) {
    failRuntime('runtime_lifecycle_failed', 'lifecycle', CONTENT_FREE.runtime_lifecycle_failed);
  }
  const taskId = typeof raw.task_id === 'string' ? raw.task_id : expectedTaskId;
  if (typeof taskId !== 'string' || (expectedTaskId && taskId !== expectedTaskId)) {
    failRuntime('runtime_lifecycle_failed', 'lifecycle.task_id',
      CONTENT_FREE.runtime_lifecycle_failed);
  }
  const reason = closedString(raw.reason, RUN_RUNTIME_LIFECYCLE_REASONS);
  return freezeData({
    version: raw.version === 1 || raw.version === '1' ? 1 : 1,
    task_id: taskId,
    stored_status: typeof raw.stored_status === 'string' ? raw.stored_status : null,
    projected_status: typeof raw.projected_status === 'string' ? raw.projected_status : null,
    public_state: typeof raw.public_state === 'string' ? raw.public_state : null,
    final: raw.final === true,
    cleanup: sanitizeCleanup(raw.cleanup),
    boundary: sanitizeProof(raw.boundary, RUN_RUNTIME_BOUNDARY_STATUSES),
    lock: sanitizeProof(raw.lock, RUN_RUNTIME_LOCK_STATUSES),
    reason,
  });
}

function schedulerLaneStatus(lane) {
  const status = typeof lane?.status === 'string' ? lane.status : 'dispatched';
  return capturedIncludes(RUN_RUNTIME_LANE_STATUSES, status) ? status : 'unresolved';
}

function isAuthoritativeDispatch(lane) {
  return lane?.dispatched !== false;
}

function isConfirmedCancelled(lane) {
  return isAuthoritativeDispatch(lane)
    && schedulerLaneStatus(lane) === 'cancelled'
    && lane?.cancel_confirmed === true;
}

function isSchedulerTerminal(status) {
  return capturedIncludes(TERMINAL_LANE_STATUSES, status);
}

function isAcceptableChildTerminal(lane) {
  if (!isAuthoritativeDispatch(lane)) return false;
  const status = schedulerLaneStatus(lane);
  if (status === 'cancelled') return lane?.cancel_confirmed === true;
  return isSchedulerTerminal(status) && status !== 'transport_lost';
}

function authoritativeLaneStatus(lane) {
  if (!isAuthoritativeDispatch(lane)) return 'unresolved';
  const status = schedulerLaneStatus(lane ?? { status: 'dispatched' });
  if (status === 'cancelled' && lane?.cancel_confirmed !== true) return 'unresolved';
  return status;
}

function journalOutcomeFor(status) {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (capturedIncludes(JOURNAL_TERMINAL_STATUSES, status) || status === 'failed'
    || status === 'timeout' || status === 'environment_blocked') {
    return 'failed';
  }
  return null;
}

function cleanupNote(lifecycle) {
  const status = lifecycle?.cleanup?.status;
  if (status === 'normal') return 'cleanup.normal';
  if (status === 'recovered') return 'cleanup.recovered';
  return null;
}

function pickLane(schedulerReceipt, assignmentId) {
  const lanes = ARRAY_IS_ARRAY(schedulerReceipt?.lanes) ? schedulerReceipt.lanes : [];
  for (const lane of lanes) {
    if (lane && lane.assignment_id === assignmentId) return lane;
  }
  return null;
}

function projectLane(assignment, schedulerLane, lifecycle) {
  const rawLane = schedulerLane ?? { status: 'dispatched' };
  const status = authoritativeLaneStatus(rawLane);
  const overlay = lifecycle && isAcceptableChildTerminal(rawLane) && lifecycle.final !== true
    ? 'lifecycle_pending'
    : status;
  return freezeData({
    assignment_id: assignment.assignment_id,
    task_id: schedulerLane?.task_id ?? assignment.task_id ?? null,
    role: schedulerLane?.role ?? assignment.role ?? null,
    access: schedulerLane?.access ?? assignment.access ?? null,
    provider: schedulerLane?.provider ?? assignment.provider ?? null,
    model: schedulerLane?.model ?? assignment.model ?? null,
    write_scope: schedulerLane?.write_scope ?? assignment.write_scope ?? null,
    required: schedulerLane?.required ?? assignment.required !== false,
    starting_ref: schedulerLane?.starting_ref ?? assignment.starting_ref ?? null,
    status: overlay,
    unresolved: schedulerLane?.unresolved ?? null,
    cursor: schedulerLane?.cursor ?? null,
    attention: schedulerLane?.attention ?? null,
    cleanup: lifecycle
      ? freezeData({
        task_id: lifecycle.task_id,
        status: lifecycle.cleanup.status,
        code: lifecycle.cleanup.code,
        final: lifecycle.final,
        reason: lifecycle.reason,
      })
      : null,
  });
}

function projectJournal(handle, mode, state) {
  return freezeData({
    mode,
    revision: typeof state?.revision === 'number' ? state.revision : 0,
    head_hash: typeof state?.head_hash === 'string' ? state.head_hash : RUN_JOURNAL_GENESIS_PREV,
    run_opened: state?.run_opened === true,
    terminal: state?.terminal === true,
    run_outcome: capturedIncludes(RUN_JOURNAL_OUTCOMES, state?.run_outcome)
      ? state.run_outcome
      : null,
    handle_bound: handle !== null,
  });
}

function projectAttention(receipt) {
  if (receipt === null || receipt === undefined) {
    return freezeData({
      batch_id: null,
      status: null,
      revision: 0,
      complete_candidate_blocked: false,
      wake: false,
    });
  }
  return freezeData({
    batch_id: typeof receipt.batch_id === 'string' ? receipt.batch_id : receipt.record?.batch_id ?? null,
    status: typeof receipt.status === 'string'
      ? receipt.status
      : receipt.record?.status ?? null,
    revision: typeof receipt.revision === 'number'
      ? receipt.revision
      : receipt.record?.revision ?? 0,
    complete_candidate_blocked: receipt.complete_candidate_blocked === true,
    wake: false,
  });
}

function blockedFrom(schedulerReceipt, attention, lanes) {
  if (schedulerReceipt?.complete_candidate_blocked === true) return true;
  if (attention?.complete_candidate_blocked === true) return true;
  for (const lane of lanes) {
    if (lane.required !== false && (lane.status === 'unresolved' || lane.status === 'failed'
      || lane.status === 'lifecycle_pending' || lane.status === 'transport_lost')) {
      return true;
    }
  }
  return false;
}

function receiptFor(record, extras) {
  const sideEffects = emptySideEffects();
  if (extras.dispatched) sideEffects.task_dispatched = true;
  if (extras.cancelled) sideEffects.task_cancelled = true;
  const lanes = extras.lanes ?? [];
  return freezeData({
    schema: RUN_RUNTIME_RECEIPT_SCHEMA_ID,
    version: RUN_RUNTIME_VERSION,
    status: extras.status,
    run_id: record.run_id,
    base_sha: record.base_sha,
    created: extras.created === true,
    assignment_count: record.assignments.length,
    lanes,
    journal: extras.journal,
    attention: extras.attention ?? projectAttention(null),
    cleanup: extras.cleanup ?? freezeData({
      cleaned: false,
      proof_bound: true,
      removed: 0,
      remaining: null,
      unresolved: [],
    }),
    cursor: extras.cursor ?? null,
    checks: emptyChecks(),
    side_effects: sideEffects,
    complete_candidate_blocked: blockedFrom(extras.schedulerReceipt, extras.attention, lanes),
    observed_at: extras.observedAt,
    wake: false,
    remote_mutated: false,
  });
}

function enqueue(queues, runId, work) {
  const current = queues.get(runId) ?? Promise.resolve();
  const next = current.then(work, work);
  queues.set(runId, next.catch(() => {}));
  return next;
}

async function loadCoordination(anchor, runId) {
  try {
    const coordination = await anchor.getCoordination(runId);
    if (coordination === undefined || coordination === null) return null;
    return coordination;
  } catch (error) {
    if (isTypedError(error) && capturedIncludes(AGGREGATE_MISSING_CODES, errorCodeOf(error))) {
      return null;
    }
    throw error;
  }
}

async function openOrCreateJournal(injected, record, preferCreate) {
  const mode = record.journal_mode;
  const createFn = mode === 'aggregate'
    ? injected.runJournal.createAggregate
    : injected.runJournal.create;
  const openFn = mode === 'aggregate'
    ? injected.runJournal.openAggregate
    : injected.runJournal.open;
  const options = mode === 'aggregate'
    ? { run_id: record.run_id, anchor: injected.aggregateAnchor }
    : { run_id: record.run_id, store: injected.runStore };
  const attempt = async (fn) => callInjected(fn, [options], 'runtime_journal_failed', 'runJournal');
  if (preferCreate) {
    return { handle: await attempt(createFn), created: true };
  }
  try {
    return { handle: await attempt(openFn), created: false };
  } catch (error) {
    if (isTypedError(error) && capturedIncludes(JOURNAL_MISSING_CODES, errorCodeOf(error))) {
      return { handle: await attempt(createFn), created: true };
    }
    throw error;
  }
}

async function journalState(handle) {
  if (handle === null || typeof handle.currentState !== 'function') {
    failRuntime('runtime_journal_failed', 'runJournal', CONTENT_FREE.runtime_journal_failed);
  }
  return callInjected(handle.currentState.bind(handle), [], 'runtime_journal_failed',
    'runJournal.currentState');
}

async function journalCursor(handle, seq) {
  if (handle === null || typeof handle.cursorAfter !== 'function') return null;
  return callInjected(handle.cursorAfter.bind(handle), [seq], 'runtime_journal_failed',
    'runJournal.cursorAfter');
}

async function appendJournal(handle, event) {
  if (handle === null || typeof handle.append !== 'function') {
    failRuntime('runtime_journal_failed', 'runJournal.append', CONTENT_FREE.runtime_journal_failed);
  }
  return callInjected(handle.append.bind(handle), [event], 'runtime_journal_failed',
    'runJournal.append');
}

async function bindJournal(injected, journals, record, preferCreate) {
  const existing = journals.get(record.run_id);
  if (existing) return existing;
  const bound = await openOrCreateJournal(injected, record, preferCreate);
  journals.set(record.run_id, bound.handle);
  return bound.handle;
}

function childStarted(state, assignmentId) {
  const children = ARRAY_IS_ARRAY(state?.children) ? state.children : [];
  return children.some((child) => child && child.assignment_id === assignmentId);
}

function childTerminal(state, assignmentId) {
  const children = ARRAY_IS_ARRAY(state?.children) ? state.children : [];
  for (const child of children) {
    if (child && child.assignment_id === assignmentId && child.outcome) return true;
  }
  return false;
}

async function ensureOpened(handle, state) {
  if (state?.run_opened === true) return state;
  await appendJournal(handle, {
    kind: 'run_opened',
    data: {},
    dedupe_key: 'run_opened',
  });
  return journalState(handle);
}

async function ensureChildStarted(handle, state, assignmentId) {
  if (childStarted(state, assignmentId)) return state;
  await appendJournal(handle, {
    kind: 'child_started',
    data: { assignment_id: assignmentId },
    dedupe_key: `child_started:${assignmentId}`,
  });
  return journalState(handle);
}

async function acceptChildTerminal(handle, state, assignmentId, outcome, lifecycle) {
  let current = state;
  if (childTerminal(current, assignmentId)) return current;
  const note = cleanupNote(lifecycle);
  if (note) {
    await appendJournal(handle, {
      kind: 'child_progress',
      data: { assignment_id: assignmentId, note },
      dedupe_key: `cleanup:${assignmentId}:${note}`,
    });
    current = await journalState(handle);
  }
  if (!capturedIncludes(RUN_JOURNAL_OUTCOMES, outcome)) return current;
  await appendJournal(handle, {
    kind: 'child_terminal',
    data: { assignment_id: assignmentId, outcome },
    dedupe_key: `child_terminal:${assignmentId}`,
  });
  return journalState(handle);
}

async function maybeRunTerminal(handle, state, record, lanes) {
  if (state?.terminal === true) return state;
  const required = record.assignments.filter((assignment) => assignment.required !== false);
  const requiredIds = required.length > 0
    ? required.map((assignment) => assignment.assignment_id)
    : record.assignments.map((assignment) => assignment.assignment_id);
  const byId = new Map(lanes.map((lane) => [lane.assignment_id, lane]));
  const outcomes = [];
  for (const assignmentId of requiredIds) {
    const lane = byId.get(assignmentId);
    if (!lane || !lane.cleanup?.final) return state;
    const outcome = journalOutcomeFor(lane.status === 'lifecycle_pending' ? null : lane.status);
    if (outcome === null) return state;
    outcomes.push(outcome);
  }
  let runOutcome = 'completed';
  if (outcomes.includes('failed')) runOutcome = 'failed';
  else if (outcomes.includes('cancelled')) runOutcome = 'cancelled';
  await appendJournal(handle, {
    kind: 'run_terminal',
    data: { outcome: runOutcome },
    dedupe_key: 'run_terminal',
  });
  return journalState(handle);
}

async function invokeLifecycle(fn, record, assignment, taskId, reason, field) {
  const task = freezeData({
    id: taskId,
    run_id: record.run_id,
    assignment_id: assignment.assignment_id,
  });
  const runtime = freezeData({
    task_id: taskId,
    run_id: record.run_id,
    assignment_id: assignment.assignment_id,
  });
  const dependencies = freezeData({ reason });
  const raw = await callInjected(fn, [null, task, runtime, dependencies],
    'runtime_lifecycle_failed', field);
  return sanitizeLifecycle(raw, taskId);
}

async function settleAndCleanup(injected, record, assignment, schedulerLane, reason) {
  const taskId = schedulerLane?.task_id ?? assignment.task_id;
  const settled = await invokeLifecycle(injected.settleLocalTaskLifecycle, record, assignment,
    taskId, reason, 'settleLocalTaskLifecycle');
  const cleaned = await invokeLifecycle(injected.cleanupLocalTaskLifecycle, record, assignment,
    taskId, reason, 'cleanupLocalTaskLifecycle');
  return sanitizeLifecycle({
    ...settled,
    final: settled.final === true && cleaned.final === true ? true : settled.final,
    cleanup: cleaned.cleanup?.status ? cleaned.cleanup : settled.cleanup,
    boundary: cleaned.boundary?.status ? cleaned.boundary : settled.boundary,
    lock: cleaned.lock?.status ? cleaned.lock : settled.lock,
    reason: cleaned.reason ?? settled.reason,
  }, taskId);
}

async function loadAttention(injected, runId) {
  try {
    const receipt = await callInjected(injected.attentionBatch.get, [runId],
      'runtime_journal_failed', 'attentionBatch.get');
    if (receipt === undefined || receipt === null) return null;
    return receipt;
  } catch (error) {
    if (isTypedError(error) && (error.code === 'attention_batch_not_found'
      || error.code === 'runtime_run_unknown')) {
      return null;
    }
    throw error;
  }
}

function attentionItemsFrom(value) {
  if (value === undefined) return null;
  if (!ARRAY_IS_ARRAY(value) && !capturedIsArray(value)) {
    failRuntime('invalid_type', 'attention_items', CONTENT_FREE.invalid_type);
  }
  if (value.length < 1 || value.length > MAX_ASSIGNMENTS) {
    failRuntime('out_of_range', 'attention_items', CONTENT_FREE.out_of_range);
  }
  return value;
}

async function latchAttention(injected, record, handle, items) {
  const state = await journalState(handle);
  const cursors = items.map((item) => ({
    assignment_id: item.assignment_id,
    task_id: item.task_id,
    event_cursor: STRING(item.event_cursor),
  }));
  const source = freezeData({
    journal_revision: state.revision ?? 0,
    journal_head_hash: state.head_hash ?? RUN_JOURNAL_GENESIS_PREV,
    task_cursors: cursors,
  });
  const cancel = async (target) => {
    const assignmentId = target?.assignment_id;
    if (typeof assignmentId !== 'string') return { confirmed: false };
    const receipt = await callInjected(injected.scheduler.cancelAssignments, [{
      run_id: record.run_id,
      assignment_ids: [assignmentId],
    }], 'runtime_scheduler_failed', 'scheduler.cancelAssignments');
    return { confirmed: receipt !== null };
  };
  return callInjected(injected.attentionBatch.latch, [{
    run_id: record.run_id,
    source,
    items,
    expected_revision: 0,
    cancel,
  }], 'runtime_journal_failed', 'attentionBatch.latch');
}

async function projectArtifacts(injected, record, assignmentId) {
  return callInjected(injected.artifactBridge.projectAssignmentArtifacts, [{
    run_id: record.run_id,
    assignment_id: assignmentId,
  }], 'runtime_journal_failed', 'artifactBridge.projectAssignmentArtifacts');
}

async function cleanupArtifacts(injected, record, assignmentIds, lanes) {
  const targeted = lanes.filter((lane) => assignmentIds.includes(lane.assignment_id));
  for (const lane of targeted) {
    if (lane.cleanup?.final !== true) {
      failRuntime('runtime_cleanup_unproven', 'cleanup', CONTENT_FREE.runtime_cleanup_unproven);
    }
  }
  const receipt = await callInjected(injected.artifactBridge.cleanupRunArtifacts, [{
    run_id: record.run_id,
    proof: freezeData({
      run_id: record.run_id,
      assignment_ids: assignmentIds,
    }),
  }], 'runtime_cleanup_unproven', 'artifactBridge.cleanupRunArtifacts');
  return freezeData({
    cleaned: receipt?.cleaned === true,
    proof_bound: true,
    removed: typeof receipt?.removed === 'number' ? receipt.removed : 0,
    remaining: typeof receipt?.remaining === 'number' ? receipt.remaining : 0,
    unresolved: ARRAY_IS_ARRAY(receipt?.unresolved) ? receipt.unresolved : [],
  });
}

function storeInputFrom(parsed) {
  return {
    run_id: ownDataValue(parsed, 'run_id', 'run_id'),
    request_idempotency_key: ownDataValue(parsed, 'request_idempotency_key',
      'request_idempotency_key'),
    identity: ownDataValue(parsed, 'identity', 'identity'),
    git: ownDataValue(parsed, 'git', 'git'),
    provenance: ownDataValue(parsed, 'provenance', 'provenance'),
    telemetry: ownDataValue(parsed, 'telemetry', 'telemetry'),
  };
}

export function describeRunRuntimeV1() {
  return freezeData({
    schema: RUN_RUNTIME_SCHEMA_ID,
    version: RUN_RUNTIME_VERSION,
    receipt_schema: RUN_RUNTIME_RECEIPT_SCHEMA_ID,
    methods: RUN_RUNTIME_METHODS,
    dependencies: RUN_RUNTIME_DEPENDENCY_KEYS,
    statuses: RUN_RUNTIME_STATUSES,
    lane_statuses: RUN_RUNTIME_LANE_STATUSES,
    journal_modes: RUN_RUNTIME_JOURNAL_MODES,
    journal_event_kinds: RUN_JOURNAL_EVENT_KINDS,
    checks: RUN_RUNTIME_CHECKS,
    side_effects: RUN_RUNTIME_SIDE_EFFECTS,
    error_codes: RUN_RUNTIME_ERROR_CODES,
    bounds: capturedFreeze({
      assignments: capturedFreeze({ min: MIN_ASSIGNMENTS, max: MAX_ASSIGNMENTS }),
    }),
    rule: 'p24_one_submission_lifecycle_final_before_child_terminal_proof_bound_cleanup',
    wake: false,
    remote_mutated: false,
    ownership: capturedFreeze({
      runtime: 'exact identity, idempotent submission, restart/cursor/attention evidence, cancellation, proof-bound cleanup',
      injected: RUN_RUNTIME_DEPENDENCY_KEYS,
      forbidden: capturedFreeze([
        'scheduler_implementation',
        'artifact_bridge_implementation',
        'acp_worker',
        'process_boundary',
        'supervisor',
        'server',
        'lock_recovery',
        'candidate_composition',
        'changelog',
        'future_work',
        'gate_a',
        'release',
      ]),
    }),
    composed_surfaces: capturedFreeze({
      p24: 'injected runStore.submit / getByRunId; durable one-submission identity',
      p25: 'injected runJournal.create / open; six-kind fact store only',
      r24a: 'injected aggregateAnchor.getCoordination',
      r25b: 'injected runJournal.createAggregate / openAggregate after resolution_ready',
      p27: 'composed as R24A resolution_ready; this module does not persist selection questions',
      p34: 'injected attentionBatch.latch / reply / get',
      scheduler: 'injected createRunScheduler result; never imported',
      artifact_bridge: 'injected createRunArtifactBridge result; never imported',
      lifecycle: 'injected settleLocalTaskLifecycle / cleanupLocalTaskLifecycle; never owns worker/boundary/lock recovery',
      public_api: 'not exposed',
      gate_a: 'not claimed',
    }),
  });
}

export function createRunRuntime(dependencies) {
  const injected = parseDependencies(dependencies);
  const runs = new Map();
  const queues = new Map();
  const journals = new Map();

  async function recoverDurableRecord(runId, requireLanes) {
    // Recover authoritative stored identity only. Never invent a digest.
    const existing = runs.get(runId);
    if (existing) return existing;
    let stored = null;
    try {
      stored = await callInjected(injected.runStore.getByRunId, [runId], 'runtime_store_failed',
        'runStore.getByRunId');
    } catch (error) {
      if (isTypedError(error) && capturedIncludes(STORE_MISSING_CODES, error.code)) {
        if (requireLanes) {
          failRuntime('runtime_run_unknown', 'run_id', CONTENT_FREE.runtime_run_unknown);
        }
        return null;
      }
      throw error;
    }
    const facts = storedSubmissionFacts(stored);
    if (!facts.durable) {
      if (requireLanes) {
        failRuntime('runtime_run_unknown', 'run_id', CONTENT_FREE.runtime_run_unknown);
      }
      return null;
    }
    let schedulerReceipt = null;
    try {
      schedulerReceipt = await callInjected(injected.scheduler.resumeAssignments, [{
        run_id: runId,
      }], 'runtime_scheduler_failed', 'scheduler.resumeAssignments');
    } catch (error) {
      if (!(isTypedError(error) && capturedIncludes(SCHEDULER_MISSING_CODES, error.code))) {
        throw error;
      }
    }
    const lanes = ARRAY_IS_ARRAY(schedulerReceipt?.lanes) ? schedulerReceipt.lanes : [];
    if (requireLanes && lanes.length === 0) {
      failRuntime('runtime_run_unknown', 'run_id', CONTENT_FREE.runtime_run_unknown);
    }
    const assignments = assignmentsFromLanes(lanes);
    const coordination = await loadCoordination(injected.aggregateAnchor, runId);
    const record = {
      run_id: runId,
      base_sha: facts.base_sha
        ?? (typeof schedulerReceipt?.base_sha === 'string' ? schedulerReceipt.base_sha : null),
      digest: recoveredIdentityDigest(runId, facts, assignments),
      assignments,
      request_idempotency_key: facts.request_idempotency_key,
      journal_mode: coordination !== null ? 'aggregate' : 'legacy',
      dispatched: true,
      durable: true,
    };
    runs.set(runId, record);
    return record;
  }

  async function rememberFromStore(runId) {
    return recoverDurableRecord(runId, true);
  }

  async function submitRun(request) {
    const parsed = quarantineRequest(request, 'request', RUN_RUNTIME_SUBMIT_KEYS);
    const runId = requireKey(parsed, 'run_id', 'run_id');
    assertRunId(runId, 'run_id');
    const idempotencyKey = requireKey(parsed, 'request_idempotency_key',
      'request_idempotency_key');
    if (typeof idempotencyKey !== 'string' || !capturedTest(IDEMPOTENCY_KEY_PATTERN, idempotencyKey)) {
      failRuntime('invalid_format', 'request_idempotency_key', CONTENT_FREE.invalid_format);
    }
    requireKey(parsed, 'identity', 'identity');
    const git = requireKey(parsed, 'git', 'git');
    requireKey(parsed, 'provenance', 'provenance');
    requireKey(parsed, 'telemetry', 'telemetry');
    const assignments = parseAssignments(requireKey(parsed, 'assignments', 'assignments'));
    const baseSha = baseShaFromGit(git);
    const digest = identityDigest(runId, baseSha, idempotencyKey, assignments);

    return enqueue(queues, runId, async () => {
      const observedAt = readClock(injected.clock);
      const coordination = await loadCoordination(injected.aggregateAnchor, runId);
      if (coordination !== null) {
        if (coordination.phase !== AGGREGATE_READY_PHASE) {
          failRuntime('runtime_selection_unresolved', 'aggregateAnchor',
            CONTENT_FREE.runtime_selection_unresolved);
        }
      }
      const known = await recoverDurableRecord(runId, false);
      assertNoIdentityConflict(known, digest, idempotencyKey);

      let stored;
      try {
        stored = await callInjected(injected.runStore.submit, [storeInputFrom(parsed)],
          'runtime_store_failed', 'runStore.submit');
      } catch (error) {
        mapStoreConflict(error);
        throw error;
      }
      const created = stored?.created === true;
      if (created && known?.durable === true) {
        failRuntime('runtime_store_failed', 'runStore.submit', CONTENT_FREE.runtime_store_failed);
      }
      assertNoIdentityConflict(known, digest, idempotencyKey);
      if (!created && known && typeof known.digest === 'string' && known.digest === digest) {
        const handle = await bindJournal(injected, journals, known, false);
        const state = await journalState(handle);
        const schedulerReceipt = await callInjected(injected.scheduler.resumeAssignments, [{
          run_id: runId,
        }], 'runtime_scheduler_failed', 'scheduler.resumeAssignments');
        const lanes = known.assignments.map((assignment) => projectLane(assignment,
          pickLane(schedulerReceipt, assignment.assignment_id), null));
        const attention = projectAttention(await loadAttention(injected, runId));
        const cursor = await journalCursor(handle, state.revision ?? 0);
        return receiptFor(known, {
          status: 'idempotent',
          created: false,
          dispatched: false,
          observedAt,
          lanes,
          journal: projectJournal(handle, known.journal_mode, state),
          attention,
          cursor,
          schedulerReceipt,
        });
      }

      const record = {
        run_id: runId,
        base_sha: baseSha,
        digest,
        assignments,
        request_idempotency_key: idempotencyKey,
        journal_mode: coordination !== null ? 'aggregate' : 'legacy',
        dispatched: false,
      };
      if (!created) {
        // Durable P24 identity already exists. Never redispatch.
        runs.set(runId, record);
        const handle = await bindJournal(injected, journals, record, false);
        let state = await journalState(handle);
        state = await ensureOpened(handle, state);
        const attention = projectAttention(await loadAttention(injected, runId));
        const cursor = await journalCursor(handle, state.revision ?? 0);
        const lanes = assignments.map((assignment) => projectLane(assignment, {
          status: 'dispatched',
          task_id: assignment.task_id,
        }, null));
        return receiptFor(record, {
          status: 'idempotent',
          created: false,
          dispatched: false,
          observedAt,
          lanes,
          journal: projectJournal(handle, record.journal_mode, state),
          attention,
          cursor,
        });
      }

      runs.set(runId, record);
      const handle = await bindJournal(injected, journals, record, true);
      let state = await journalState(handle);
      state = await ensureOpened(handle, state);
      const schedulerReceipt = await callInjected(injected.scheduler.submitAssignments, [{
        run_id: runId,
        base_sha: baseSha,
        assignments,
      }], 'runtime_scheduler_failed', 'scheduler.submitAssignments');
      record.dispatched = true;
      const lanes = [];
      for (const assignment of assignments) {
        const schedulerLane = pickLane(schedulerReceipt, assignment.assignment_id);
        if (schedulerLane?.dispatched !== false && schedulerLaneStatus(schedulerLane) !== 'unresolved') {
          state = await ensureChildStarted(handle, state, assignment.assignment_id);
        }
        lanes.push(projectLane(assignment, schedulerLane, null));
      }
      const failed = lanes.some((lane) => lane.status === 'unresolved');
      const cursor = await journalCursor(handle, state.revision ?? 0);
      return receiptFor(record, {
        status: failed ? 'partial' : 'dispatched',
        created: true,
        dispatched: true,
        observedAt,
        lanes,
        journal: projectJournal(handle, record.journal_mode, state),
        attention: projectAttention(null),
        cursor,
        schedulerReceipt,
      });
    });
  }

  async function resumeRun(request) {
    const parsed = quarantineRequest(request, 'request', RUN_RUNTIME_RESUME_KEYS);
    const runId = requireKey(parsed, 'run_id', 'run_id');
    assertRunId(runId, 'run_id');

    return enqueue(queues, runId, async () => {
      const observedAt = readClock(injected.clock);
      const record = await rememberFromStore(runId);
      const knownIds = new Set(record.assignments.map((assignment) => assignment.assignment_id));
      const lanesById = new Map(record.assignments.map((assignment) => [assignment.assignment_id, assignment]));
      const selected = parseIdList(optionalKey(parsed, 'assignment_ids', 'assignment_ids'),
        'assignment_ids', knownIds);
      const cursors = parseCursors(optionalKey(parsed, 'cursors', 'cursors'), lanesById);
      for (const assignmentId of cursors.keys()) {
        if (!selected.includes(assignmentId)) {
          failRuntime('cursor_identity_mismatch', 'cursors', CONTENT_FREE.cursor_identity_mismatch);
        }
      }
      const handle = await bindJournal(injected, journals, record, false);
      let state = await journalState(handle);
      const schedulerReceipt = await callInjected(injected.scheduler.resumeAssignments, [{
        run_id: runId,
        assignment_ids: selected,
        cursors: [...cursors.values()],
      }], 'runtime_scheduler_failed', 'scheduler.resumeAssignments');

      const attentionItems = attentionItemsFrom(optionalKey(parsed, 'attention_items',
        'attention_items'));
      let attentionReceipt = await loadAttention(injected, runId);
      if (attentionItems !== null) {
        attentionReceipt = await latchAttention(injected, record, handle, attentionItems);
      }

      const lanes = [];
      let pending = false;
      for (const assignment of record.assignments) {
        const schedulerLane = pickLane(schedulerReceipt, assignment.assignment_id);
        let lifecycle = null;
        if (selected.includes(assignment.assignment_id)
          && isAcceptableChildTerminal(schedulerLane)) {
          lifecycle = await settleAndCleanup(injected, record, assignment, schedulerLane,
            'resume');
          if (lifecycle.final === true) {
            const outcome = journalOutcomeFor(authoritativeLaneStatus(schedulerLane));
            if (outcome !== null) {
              state = await ensureChildStarted(handle, state, assignment.assignment_id);
              state = await acceptChildTerminal(handle, state, assignment.assignment_id,
                outcome, lifecycle);
            }
          } else {
            pending = true;
          }
        }
        lanes.push(projectLane(assignment, schedulerLane, lifecycle));
      }
      state = await maybeRunTerminal(handle, state, record, lanes);
      const cursor = await journalCursor(handle, state.revision ?? 0);
      return receiptFor(record, {
        status: pending ? 'lifecycle_pending' : 'inspected',
        created: false,
        dispatched: false,
        observedAt,
        lanes,
        journal: projectJournal(handle, record.journal_mode, state),
        attention: projectAttention(attentionReceipt),
        cursor,
        schedulerReceipt,
      });
    });
  }

  async function cancelRun(request) {
    const parsed = quarantineRequest(request, 'request', RUN_RUNTIME_CANCEL_KEYS);
    const runId = requireKey(parsed, 'run_id', 'run_id');
    assertRunId(runId, 'run_id');
    const cleanupRequested = optionalKey(parsed, 'cleanup', 'cleanup');
    if (cleanupRequested !== undefined && typeof cleanupRequested !== 'boolean') {
      failRuntime('invalid_type', 'cleanup', CONTENT_FREE.invalid_type);
    }

    return enqueue(queues, runId, async () => {
      const observedAt = readClock(injected.clock);
      const record = await rememberFromStore(runId);
      const knownIds = new Set(record.assignments.map((assignment) => assignment.assignment_id));
      const selected = parseIdList(requireKey(parsed, 'assignment_ids', 'assignment_ids'),
        'assignment_ids', knownIds);
      const handle = await bindJournal(injected, journals, record, false);
      let state = await journalState(handle);
      const schedulerReceipt = await callInjected(injected.scheduler.cancelAssignments, [{
        run_id: runId,
        assignment_ids: selected,
      }], 'runtime_scheduler_failed', 'scheduler.cancelAssignments');

      const lanes = [];
      let pending = false;
      for (const assignment of record.assignments) {
        const schedulerLane = pickLane(schedulerReceipt, assignment.assignment_id);
        let lifecycle = null;
        if (selected.includes(assignment.assignment_id) && isConfirmedCancelled(schedulerLane)) {
          lifecycle = await settleAndCleanup(injected, record, assignment, schedulerLane,
            'cancel');
          if (lifecycle.final === true) {
            state = await ensureChildStarted(handle, state, assignment.assignment_id);
            state = await acceptChildTerminal(handle, state, assignment.assignment_id,
              'cancelled', lifecycle);
          } else {
            pending = true;
          }
        }
        lanes.push(projectLane(assignment, schedulerLane, lifecycle));
      }
      state = await maybeRunTerminal(handle, state, record, lanes);
      let cleanup = freezeData({
        cleaned: false,
        proof_bound: true,
        removed: 0,
        remaining: null,
        unresolved: [],
      });
      if (cleanupRequested === true) {
        cleanup = await cleanupArtifacts(injected, record, selected, lanes);
      }
      const cursor = await journalCursor(handle, state.revision ?? 0);
      return receiptFor(record, {
        status: pending ? 'lifecycle_pending' : 'cancelled',
        created: false,
        cancelled: true,
        observedAt,
        lanes,
        journal: projectJournal(handle, record.journal_mode, state),
        attention: projectAttention(await loadAttention(injected, runId)),
        cleanup,
        cursor,
        schedulerReceipt,
      });
    });
  }

  async function inspectRun(request) {
    const parsed = quarantineRequest(request, 'request', RUN_RUNTIME_INSPECT_KEYS);
    const runId = requireKey(parsed, 'run_id', 'run_id');
    assertRunId(runId, 'run_id');
    const assignmentFilter = optionalKey(parsed, 'assignment_id', 'assignment_id');
    if (assignmentFilter !== undefined && !isAssignmentId(assignmentFilter)) {
      failRuntime('invalid_format', 'assignment_id', CONTENT_FREE.invalid_format);
    }

    return enqueue(queues, runId, async () => {
      const observedAt = readClock(injected.clock);
      const record = await rememberFromStore(runId);
      if (assignmentFilter !== undefined
        && !record.assignments.some((assignment) => assignment.assignment_id === assignmentFilter)) {
        failRuntime('runtime_assignment_unknown', 'assignment_id',
          CONTENT_FREE.runtime_assignment_unknown);
      }
      const handle = await bindJournal(injected, journals, record, false);
      const state = await journalState(handle);
      const schedulerReceipt = await callInjected(injected.scheduler.resumeAssignments, [{
        run_id: runId,
      }], 'runtime_scheduler_failed', 'scheduler.resumeAssignments');
      const lanes = [];
      for (const assignment of record.assignments) {
        if (assignmentFilter !== undefined && assignment.assignment_id !== assignmentFilter) {
          continue;
        }
        const schedulerLane = pickLane(schedulerReceipt, assignment.assignment_id);
        let lifecycle = null;
        if (isAcceptableChildTerminal(schedulerLane)) {
          lifecycle = await invokeLifecycle(injected.settleLocalTaskLifecycle, record, assignment,
            schedulerLane?.task_id ?? assignment.task_id, 'inspect',
            'settleLocalTaskLifecycle');
        }
        let artifacts = null;
        try {
          artifacts = await projectArtifacts(injected, record, assignment.assignment_id);
        } catch (error) {
          if (!(isTypedError(error) && (error.code === 'artifact_bridge_not_found'
            || error.code === 'runtime_run_unknown'))) {
            throw error;
          }
        }
        lanes.push(freezeData({
          ...projectLane(assignment, schedulerLane, lifecycle),
          artifacts,
        }));
      }
      const cursorToken = optionalKey(parsed, 'cursor', 'cursor');
      const cursor = cursorToken !== undefined
        ? cursorToken
        : await journalCursor(handle, state.revision ?? 0);
      return receiptFor(record, {
        status: lanes.some((lane) => lane.status === 'lifecycle_pending')
          ? 'lifecycle_pending'
          : 'inspected',
        created: false,
        observedAt,
        lanes,
        journal: projectJournal(handle, record.journal_mode, state),
        attention: projectAttention(await loadAttention(injected, runId)),
        cursor,
        schedulerReceipt,
      });
    });
  }

  return capturedFreeze({
    submitRun,
    resumeRun,
    cancelRun,
    inspectRun,
  });
}

capturedFreeze(createRunRuntime);
capturedFreeze(describeRunRuntimeV1);
capturedFreeze(RUN_RUNTIME_ERROR_CODES);
capturedFreeze(RUN_RUNTIME_METHODS);
capturedFreeze(RUN_RUNTIME_DEPENDENCY_KEYS);
