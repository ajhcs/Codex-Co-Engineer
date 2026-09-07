// RunSchedulerV1 — one-submission idempotent 1–8 assignment fanout (P33;
// ADR 0001 identifiers `bounded_run_1_to_8`, `exact_identities`,
// `disjoint_writer_scopes`, `read_only_verification`,
// `no_post_dispatch_fallback_or_replay`, `attention_batch_v1`; Gate A
// `gate_a_idempotent_submission`, `gate_a_no_duplicate_dispatch`,
// `gate_a_assignment_count_1_to_8`, `gate_a_cancellation_restart_cursor`).
//
// Additive v3 module. It owns in-memory scheduling over injected task
// functions: one exact run identity, 1–8 independent lanes, disjoint
// writer scopes, read-only verification lanes, and exactly-once
// delegate/inspect/cancel. Idempotent exact resubmit never redispatches.
// A failed, cancelled, or unsupported lane does not stop unaffected
// lanes. Resume records bounded cursor/attention/restart evidence and
// never replays. This module does not import or own run-runtime,
// artifact-bridge, lifecycle, supervisor, server, candidate, mailbox,
// or provider-driver surfaces.

import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  capturedUtf8ByteLength,
  isKnownAccess,
  isKnownProvider,
  isKnownRole,
  isModelId,
  knownProvidersJoined,
  requiredAccessForRole,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  SCOPE_MAX_PATTERNS,
  assertBaseSha,
  assertRunId,
  assertWriteScopePatterns,
  isAssignmentId,
  isSha40,
  writerScopesOverlap,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

export const RUN_SCHEDULER_SCHEMA_ID = 'codex-co-engineer.run-scheduler.v1';
export const RUN_SCHEDULER_VERSION = 1;
export const RUN_SCHEDULER_RECEIPT_SCHEMA_ID =
  'codex-co-engineer.run-scheduler-receipt.v1';
export const RUN_SCHEDULER_HASH_DOMAIN = 'codex-co-engineer.run-scheduler-hash.v1';

export const RUN_SCHEDULER_METHODS = capturedFreeze([
  'submitAssignments', 'resumeAssignments', 'cancelAssignments',
]);
export const RUN_SCHEDULER_DEPENDENCY_KEYS = capturedFreeze([
  'delegateTask', 'inspectTask', 'cancelTask', 'clock',
]);
export const RUN_SCHEDULER_SUBMIT_KEYS = capturedFreeze([
  'assignments', 'base_sha', 'run_id',
]);
export const RUN_SCHEDULER_RESUME_KEYS = capturedFreeze([
  'assignment_ids', 'cursors', 'run_id',
]);
export const RUN_SCHEDULER_CANCEL_KEYS = capturedFreeze([
  'assignment_ids', 'run_id',
]);
export const RUN_SCHEDULER_ASSIGNMENT_KEYS = capturedFreeze([
  'access', 'assignment_id', 'model', 'provider', 'required', 'role',
  'starting_ref', 'task_id', 'write_scope',
]);
export const RUN_SCHEDULER_CURSOR_KEYS = capturedFreeze([
  'assignment_id', 'event_cursor', 'task_id',
]);
export const RUN_SCHEDULER_LANE_KEYS = capturedFreeze([
  'access', 'assignment_id', 'attention', 'cancel_confirmed', 'cursor',
  'dispatched', 'fallback', 'model', 'provider', 'replayed', 'required',
  'role', 'starting_ref', 'status', 'task_id', 'unresolved', 'write_scope',
]);
export const RUN_SCHEDULER_RECEIPT_KEYS = capturedFreeze([
  'assignment_count', 'base_sha', 'checks', 'complete_candidate_blocked',
  'created', 'lanes', 'observed_at', 'remote_mutated', 'run_id', 'schema',
  'side_effects', 'status', 'version', 'wake',
]);
export const RUN_SCHEDULER_STATUSES = capturedFreeze([
  'dispatched', 'partial', 'idempotent', 'inspected', 'cancelled',
]);
export const RUN_SCHEDULER_LANE_STATUSES = capturedFreeze([
  'dispatched', 'running', 'needs_attention', 'completed', 'failed',
  'cancelled', 'unresolved', 'timeout', 'transport_lost', 'environment_blocked',
]);
export const RUN_SCHEDULER_UNRESOLVED_CODES = capturedFreeze([
  'dispatch_failed',
  'identity_mismatch',
  'same_session_reply_unsupported',
  'safe_cancel_unconfirmed',
  'restart_denied_no_replay',
  'inspect_failed',
  'attention_evidence_invalid',
]);
export const RUN_SCHEDULER_REPLY_CAPABILITIES = capturedFreeze([
  'same_session', 'unsupported',
]);
export const RUN_SCHEDULER_CHECKS = capturedFreeze([
  'request_quarantine',
  'child_bounds',
  'exact_identity',
  'disjoint_writer_scopes',
  'read_only_verification',
  'one_submission',
  'no_duplicate_dispatch',
  'no_replay',
  'no_fallback',
  'unaffected_lanes_continue',
  'bounded_attention',
  'remote_mutation_denied',
]);
export const RUN_SCHEDULER_SIDE_EFFECTS = capturedFreeze([
  'task_dispatched',
  'task_cancelled',
  'duplicate_dispatch',
  'replay',
  'fallback',
  'workspace_created',
  'branch_or_ref_created',
  'candidate_composed',
  'server_cutover',
  'remote_mutated',
]);
export const RUN_SCHEDULER_ALWAYS_FALSE_SIDE_EFFECTS = capturedFreeze([
  'duplicate_dispatch',
  'replay',
  'fallback',
  'workspace_created',
  'branch_or_ref_created',
  'candidate_composed',
  'server_cutover',
  'remote_mutated',
]);

export { MIN_ASSIGNMENTS, MAX_ASSIGNMENTS };
export const MAX_SCHEDULER_ATTENTION_PROMPT_BYTES = 4096;
export const MAX_SCHEDULER_ATTENTION_OPTIONS = 8;
export const MAX_SCHEDULER_ATTENTION_OPTION_BYTES = 128;
export const MAX_SCHEDULER_DIAGNOSTIC_BYTES = 160;

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const EVENT_CURSOR_PATTERN = /^[0-9]{1,16}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLOCK_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const HASH_ALGORITHM = 'sha256';
const CREATE_HASH = createHash;
const IS_PROXY = utilTypes.isProxy;
const STRING = String;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const ARRAY_IS_ARRAY = Array.isArray;
const REFLECT_OWN_KEYS = Reflect.ownKeys;

const TERMINAL_LANE_STATUSES = capturedFreeze([
  'completed', 'failed', 'cancelled', 'unresolved', 'timeout',
  'transport_lost', 'environment_blocked',
]);
const INSPECT_STATUS_MAP = capturedFreeze({
  dispatched: 'dispatched',
  starting: 'running',
  accepted: 'running',
  running: 'running',
  cancelling: 'running',
  needs_attention: 'needs_attention',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  timeout: 'timeout',
  timed_out: 'timeout',
  transport_lost: 'transport_lost',
  environment_blocked: 'environment_blocked',
});

const FORBIDDEN_KEY_CODES = capturedFreeze({
  after: 'dependency_not_allowed',
  before: 'dependency_not_allowed',
  blocked_by: 'dependency_not_allowed',
  blocking: 'dependency_not_allowed',
  children: 'dependency_not_allowed',
  dag: 'dependency_not_allowed',
  dependencies: 'dependency_not_allowed',
  depends_on: 'dependency_not_allowed',
  edges: 'dependency_not_allowed',
  needs: 'dependency_not_allowed',
  parent: 'dependency_not_allowed',
  parents: 'dependency_not_allowed',
  prerequisites: 'dependency_not_allowed',
  requires: 'dependency_not_allowed',
  waits_for: 'dependency_not_allowed',
  fallback: 'replay_or_fallback_denied',
  replay: 'replay_or_fallback_denied',
  redispatch: 'replay_or_fallback_denied',
  retry: 'replay_or_fallback_denied',
  allow_post_dispatch_fallback: 'replay_or_fallback_denied',
  workspace_mode: 'direct_mode_denied',
  direct: 'direct_mode_denied',
  allow_merge: 'merge_authority_denied',
  allow_create_pr: 'merge_authority_denied',
  allow_push: 'merge_authority_denied',
  create_pr: 'merge_authority_denied',
  create_pull_request: 'merge_authority_denied',
  merge: 'merge_authority_denied',
  merge_pr: 'merge_authority_denied',
  open_pr: 'merge_authority_denied',
  push: 'merge_authority_denied',
  force_push: 'merge_authority_denied',
  argv: 'executable_content_denied',
  command: 'executable_content_denied',
  commands: 'executable_content_denied',
  exec: 'executable_content_denied',
  executable: 'executable_content_denied',
  script: 'executable_content_denied',
  shell: 'executable_content_denied',
  api_key: 'credential_content_denied',
  credential: 'credential_content_denied',
  credentials: 'credential_content_denied',
  password: 'credential_content_denied',
  secret: 'credential_content_denied',
  secrets: 'credential_content_denied',
  token: 'credential_content_denied',
  tokens: 'credential_content_denied',
});

const CONTENT_FREE = capturedFreeze({
  accessor_property_denied: 'Scheduler data must be direct JSON values; getters are never invoked.',
  aliased_reference_denied: 'Scheduler inputs must be acyclic trees without shared aliases.',
  assignment_id_unknown: 'The assignment_id is not part of this exact run.',
  clock_invalid: 'The injected clock must return a UTC ISO-8601 timestamp or a safe epoch millisecond count.',
  cursor_identity_mismatch: 'Resume cursors must bind the exact assignment and task identity.',
  dependency_not_allowed: 'Scheduler assignments are independent; dependency edges are denied.',
  direct_mode_denied: 'Run submissions never use direct mode.',
  duplicate_assignment_id: 'Each assignment_id in a run must be unique.',
  duplicate_task_id: 'Each task_id in a run must be unique.',
  executable_content_denied: 'Scheduler requests cannot carry executables, argv, or shell content.',
  credential_content_denied: 'Scheduler requests cannot carry credential material.',
  exotic_prototype_denied: 'Scheduler data must use the standard or null prototype.',
  injected_dependency_invalid: 'createRunScheduler requires injected task functions and a clock.',
  invalid_clock: 'The injected clock must return a UTC ISO-8601 timestamp or a safe epoch millisecond count.',
  invalid_format: 'A scheduler field violates the required exact grammar.',
  invalid_type: 'A scheduler field has the wrong JSON type.',
  merge_authority_denied: 'Scheduler lanes have no merge, push, or create-PR authority.',
  missing_key: 'A required scheduler field is missing; there are no hidden defaults.',
  overlapping_writer_scope: 'Writer scopes of concurrent assignments must be disjoint.',
  own_undefined_denied: 'Own undefined values are denied; omit the field instead.',
  out_of_range: 'A scheduler collection is outside the closed 1–8 bound.',
  proxy_denied: 'Scheduler surfaces accept direct JSON data only.',
  read_only_scope_denied: 'Read-only verification lanes must declare an empty write_scope.',
  replay_or_fallback_denied: 'After dispatch there is no fallback, replay, retry, or redispatch.',
  role_access_mismatch: 'Role and access must match the closed writer/read-only pairing.',
  scheduler_run_conflict: 'The run_id is already bound to a different exact assignment identity.',
  scheduler_run_unknown: 'The run_id is not available to this scheduler.',
  starting_ref_forbidden_local: 'starting_ref is only valid for cursor-cloud lanes.',
  cloud_starting_ref_required: 'Every cursor-cloud lane must pin one exact starting SHA.',
  symbol_key_denied: 'Scheduler data cannot carry symbol keys.',
  unknown_key: 'A scheduler object carries a key outside the closed vocabulary.',
  unknown_provider: 'The provider is not in the closed scheduler vocabulary.',
  unknown_role: 'The role is not in the closed scheduler vocabulary.',
  unknown_access: 'The access mode is not in the closed scheduler vocabulary.',
  writer_scope_required: 'Writer lanes must declare a non-empty write_scope.',
});

export const RUN_SCHEDULER_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'aliased_reference_denied',
  'assignment_id_unknown',
  'clock_invalid',
  'cloud_starting_ref_required',
  'credential_content_denied',
  'cursor_identity_mismatch',
  'dependency_not_allowed',
  'direct_mode_denied',
  'duplicate_assignment_id',
  'duplicate_task_id',
  'executable_content_denied',
  'exotic_prototype_denied',
  'injected_dependency_invalid',
  'invalid_clock',
  'invalid_format',
  'invalid_json_type',
  'invalid_json_value',
  'invalid_type',
  'merge_authority_denied',
  'missing_key',
  'non_enumerable_property_denied',
  'overlapping_writer_scope',
  'own_undefined_denied',
  'out_of_range',
  'proxy_denied',
  'read_only_scope_denied',
  'replay_or_fallback_denied',
  'role_access_mismatch',
  'scheduler_run_conflict',
  'scheduler_run_unknown',
  'starting_ref_forbidden_local',
  'symbol_key_denied',
  'unknown_access',
  'unknown_key',
  'unknown_provider',
  'unknown_role',
  'value_depth_exceeded',
  'writer_scope_required',
]);

function diagnostic(value) {
  const text = STRING(value ?? '');
  return text.length <= MAX_SCHEDULER_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_SCHEDULER_DIAGNOSTIC_BYTES);
}

function failScheduler(code, path, message) {
  fail(code, path, diagnostic(message ?? CONTENT_FREE[code] ?? 'The scheduler request failed closed.'));
}

function assertClosedKeySet(value, allowedKeys, errorPath) {
  const keys = capturedOwnKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string') {
      failScheduler('symbol_key_denied', errorPath, CONTENT_FREE.symbol_key_denied);
    }
    if (!capturedIncludes(allowedKeys, key)) {
      failScheduler('unknown_key', `${errorPath}.${key}`, CONTENT_FREE.unknown_key);
    }
  }
}

function denyForbiddenKeys(value, path) {
  if (value === null || typeof value !== 'object') return;
  const keys = capturedOwnKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    if (capturedHasOwn(FORBIDDEN_KEY_CODES, key)) {
      failScheduler(FORBIDDEN_KEY_CODES[key], `${path}.${key}`, CONTENT_FREE[FORBIDDEN_KEY_CODES[key]]);
    }
  }
  if (ARRAY_IS_ARRAY(value)) {
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      denyForbiddenKeys(value[index], `${path}[${index}]`);
    }
    return;
  }
  for (const key of keys) {
    if (typeof key === 'string') denyForbiddenKeys(value[key], `${path}.${key}`);
  }
}

function quarantineRequest(request, path, allowedKeys) {
  if (request === undefined || request === null) {
    failScheduler('invalid_type', path, CONTENT_FREE.invalid_type);
  }
  assertNotProxy(request, path);
  if (typeof request !== 'object' || ARRAY_IS_ARRAY(request)) {
    failScheduler('invalid_type', path, CONTENT_FREE.invalid_type);
  }
  assertDirectJsonClosure(request, path);
  denyForbiddenKeys(request, path);
  freezeData(request);
  assertClosedKeySet(request, allowedKeys, path);
  return request;
}

function requiredString(object, key, path, predicate, code) {
  if (!hasOwn(object, key)) failScheduler('missing_key', path, CONTENT_FREE.missing_key);
  const value = ownDataValue(object, key, path);
  if (typeof value !== 'string' || (predicate && !predicate(value))) {
    failScheduler(code ?? 'invalid_format', path, CONTENT_FREE[code] ?? CONTENT_FREE.invalid_format);
  }
  return value;
}

function optionalOwn(object, key, path) {
  if (!hasOwn(object, key)) return undefined;
  return ownDataValue(object, key, path);
}

function assertTaskId(value, path) {
  if (typeof value !== 'string' || !capturedTest(TASK_ID_PATTERN, value)) {
    failScheduler('invalid_format', path, CONTENT_FREE.invalid_format);
  }
  return value;
}

function assertEventCursor(value, path) {
  if (typeof value !== 'string' || !capturedTest(EVENT_CURSOR_PATTERN, value)) {
    failScheduler('invalid_format', path, CONTENT_FREE.invalid_format);
  }
  return value;
}

function expectedReplyCapability(provider) {
  return provider === 'dsh' || provider === 'cursor-cloud'
    ? 'unsupported'
    : 'same_session';
}

function isTerminalStatus(status) {
  return capturedIncludes(TERMINAL_LANE_STATUSES, status);
}

function identityDigest(runId, baseSha, assignments) {
  const canonical = canonicalJsonStringify({
    assignments: assignments.map((lane) => ({
      access: lane.access,
      assignment_id: lane.assignment_id,
      model: lane.model,
      provider: lane.provider,
      required: lane.required,
      role: lane.role,
      starting_ref: lane.starting_ref,
      task_id: lane.task_id,
      write_scope: lane.write_scope,
    })),
    base_sha: baseSha,
    run_id: runId,
  });
  const digest = CREATE_HASH(HASH_ALGORITHM)
    .update(RUN_SCHEDULER_HASH_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(STRING(RUN_SCHEDULER_VERSION), 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function readClock(clock) {
  let value;
  try {
    value = clock();
  } catch {
    failScheduler('invalid_clock', 'clock', CONTENT_FREE.invalid_clock);
  }
  if (typeof value === 'string' && capturedTest(CLOCK_ISO_PATTERN, value)) return value;
  if (typeof value === 'number' && NUMBER_IS_SAFE_INTEGER(value) && value >= 0) {
    return new Date(value).toISOString();
  }
  failScheduler('invalid_clock', 'clock', CONTENT_FREE.invalid_clock);
  return null;
}

function cloneLane(lane) {
  return {
    access: lane.access,
    assignment_id: lane.assignment_id,
    attention: lane.attention === null ? null : { ...lane.attention, options: lane.attention.options === null ? null : [...lane.attention.options] },
    cancel_confirmed: lane.cancel_confirmed,
    cursor: lane.cursor,
    dispatched: lane.dispatched,
    fallback: false,
    model: lane.model,
    provider: lane.provider,
    replayed: false,
    required: lane.required,
    role: lane.role,
    starting_ref: lane.starting_ref,
    status: lane.status,
    task_id: lane.task_id,
    unresolved: lane.unresolved === null ? null : { ...lane.unresolved },
    write_scope: [...lane.write_scope],
  };
}

function requiredUnresolved(lanes) {
  for (const lane of lanes) {
    if (!lane.required) continue;
    if (lane.unresolved !== null) return true;
    if (lane.status === 'failed' || lane.status === 'cancelled' || lane.status === 'unresolved'
      || lane.status === 'timeout' || lane.status === 'transport_lost'
      || lane.status === 'environment_blocked') {
      return true;
    }
  }
  return false;
}

function sideEffects({ dispatched = false, cancelled = false } = {}) {
  const effects = {};
  for (const claim of RUN_SCHEDULER_SIDE_EFFECTS) effects[claim] = false;
  effects.task_dispatched = dispatched === true;
  effects.task_cancelled = cancelled === true;
  return effects;
}

function checks() {
  const result = {};
  for (const name of RUN_SCHEDULER_CHECKS) result[name] = true;
  return result;
}

function receiptFor(record, {
  status, created, dispatched = false, cancelled = false, observedAt,
}) {
  const lanes = record.lanes.map(cloneLane);
  return freezeData({
    schema: RUN_SCHEDULER_SCHEMA_ID,
    version: RUN_SCHEDULER_VERSION,
    run_id: record.run_id,
    base_sha: record.base_sha,
    status,
    created,
    assignment_count: lanes.length,
    lanes,
    checks: checks(),
    side_effects: sideEffects({ dispatched, cancelled }),
    wake: false,
    complete_candidate_blocked: requiredUnresolved(lanes),
    observed_at: observedAt,
    remote_mutated: false,
  });
}

function parseWriteScope(assignment, access, path) {
  if (!hasOwn(assignment, 'write_scope')) {
    failScheduler('missing_key', `${path}.write_scope`, CONTENT_FREE.missing_key);
  }
  const scope = ownDataValue(assignment, 'write_scope', `${path}.write_scope`);
  if (access === 'read_only') {
    if (!ARRAY_IS_ARRAY(scope) || IS_PROXY(scope)) {
      failScheduler('invalid_type', `${path}.write_scope`, CONTENT_FREE.invalid_type);
    }
    if (scope.length !== 0) {
      failScheduler('read_only_scope_denied', `${path}.write_scope`, CONTENT_FREE.read_only_scope_denied);
    }
    return capturedFreeze([]);
  }
  assertWriteScopePatterns(scope, `${path}.write_scope`, { minPatterns: 1, maxPatterns: SCOPE_MAX_PATTERNS });
  if (scope.length === 0) {
    failScheduler('writer_scope_required', `${path}.write_scope`, CONTENT_FREE.writer_scope_required);
  }
  return capturedFreeze([...scope]);
}

function parseStartingRef(assignment, provider, path) {
  const present = hasOwn(assignment, 'starting_ref');
  if (present && provider !== 'cursor-cloud') {
    failScheduler('starting_ref_forbidden_local', `${path}.starting_ref`,
      CONTENT_FREE.starting_ref_forbidden_local);
  }
  if (provider === 'cursor-cloud') {
    if (!present) {
      failScheduler('cloud_starting_ref_required', `${path}.starting_ref`,
        CONTENT_FREE.cloud_starting_ref_required);
    }
    const startingRef = ownDataValue(assignment, 'starting_ref', `${path}.starting_ref`);
    if (!isSha40(startingRef)) {
      failScheduler('invalid_format', `${path}.starting_ref`, CONTENT_FREE.invalid_format);
    }
    return startingRef;
  }
  return null;
}

function parseAssignment(assignment, index) {
  const path = `assignments[${index}]`;
  assertNotProxy(assignment, path);
  if (typeof assignment !== 'object' || assignment === null || ARRAY_IS_ARRAY(assignment)) {
    failScheduler('invalid_type', path, CONTENT_FREE.invalid_type);
  }
  assertClosedKeySet(assignment, RUN_SCHEDULER_ASSIGNMENT_KEYS, path);
  const assignmentId = requiredString(assignment, 'assignment_id', `${path}.assignment_id`, isAssignmentId);
  const taskId = assertTaskId(
    requiredString(assignment, 'task_id', `${path}.task_id`),
    `${path}.task_id`,
  );
  const role = requiredString(assignment, 'role', `${path}.role`);
  if (!isKnownRole(role)) failScheduler('unknown_role', `${path}.role`, CONTENT_FREE.unknown_role);
  const access = requiredString(assignment, 'access', `${path}.access`);
  if (!isKnownAccess(access)) failScheduler('unknown_access', `${path}.access`, CONTENT_FREE.unknown_access);
  if (requiredAccessForRole(role) !== access) {
    failScheduler('role_access_mismatch', `${path}.access`, CONTENT_FREE.role_access_mismatch);
  }
  const provider = requiredString(assignment, 'provider', `${path}.provider`);
  if (!isKnownProvider(provider)) {
    failScheduler('unknown_provider', `${path}.provider`,
      `assignments[${index}].provider is not one of ${knownProvidersJoined()}.`);
  }
  const model = requiredString(assignment, 'model', `${path}.model`, isModelId);
  if (!hasOwn(assignment, 'required')) {
    failScheduler('missing_key', `${path}.required`, CONTENT_FREE.missing_key);
  }
  const required = ownDataValue(assignment, 'required', `${path}.required`);
  if (required !== true && required !== false) {
    failScheduler('invalid_type', `${path}.required`, CONTENT_FREE.invalid_type);
  }
  const writeScope = parseWriteScope(assignment, access, path);
  const startingRef = parseStartingRef(assignment, provider, path);
  return {
    assignment_id: assignmentId,
    task_id: taskId,
    role,
    access,
    provider,
    model,
    required,
    write_scope: writeScope,
    starting_ref: startingRef,
    status: 'dispatched',
    dispatched: false,
    cursor: '0',
    attention: null,
    unresolved: null,
    cancel_confirmed: null,
  };
}

function parseAssignments(value) {
  if (!ARRAY_IS_ARRAY(value) || IS_PROXY(value)) {
    failScheduler('invalid_type', 'assignments', CONTENT_FREE.invalid_type);
  }
  if (value.length < MIN_ASSIGNMENTS || value.length > MAX_ASSIGNMENTS) {
    failScheduler('out_of_range', 'assignments', CONTENT_FREE.out_of_range);
  }
  const parsed = [];
  const assignmentIds = new Set();
  const taskIds = new Set();
  const writers = [];
  for (let index = 0; index < value.length; index += 1) {
    const lane = parseAssignment(value[index], index);
    if (assignmentIds.has(lane.assignment_id)) {
      failScheduler('duplicate_assignment_id', `assignments[${index}].assignment_id`,
        CONTENT_FREE.duplicate_assignment_id);
    }
    if (taskIds.has(lane.task_id)) {
      failScheduler('duplicate_task_id', `assignments[${index}].task_id`,
        CONTENT_FREE.duplicate_task_id);
    }
    assignmentIds.add(lane.assignment_id);
    taskIds.add(lane.task_id);
    if (lane.access === 'writer') {
      writers.push({
        assignment_id: lane.assignment_id,
        index,
        patterns: lane.write_scope,
      });
    }
    parsed.push(lane);
  }
  for (let left = 0; left < writers.length; left += 1) {
    for (let right = left + 1; right < writers.length; right += 1) {
      const leftWriter = writers[left];
      const rightWriter = writers[right];
      for (let leftIndex = 0; leftIndex < leftWriter.patterns.length; leftIndex += 1) {
        for (let rightIndex = 0; rightIndex < rightWriter.patterns.length; rightIndex += 1) {
          if (writerScopesOverlap(leftWriter.patterns[leftIndex], rightWriter.patterns[rightIndex])) {
            failScheduler(
              'overlapping_writer_scope',
              `assignments[${leftWriter.index}].write_scope`,
              CONTENT_FREE.overlapping_writer_scope,
            );
          }
        }
      }
    }
  }
  return parsed;
}

function parseIdList(value, path, knownIds) {
  if (value === undefined) return null;
  if (!ARRAY_IS_ARRAY(value) || IS_PROXY(value)) {
    failScheduler('invalid_type', path, CONTENT_FREE.invalid_type);
  }
  if (value.length < MIN_ASSIGNMENTS || value.length > MAX_ASSIGNMENTS) {
    failScheduler('out_of_range', path, CONTENT_FREE.out_of_range);
  }
  const ids = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const assignmentId = value[index];
    if (!isAssignmentId(assignmentId)) {
      failScheduler('invalid_format', entryPath, CONTENT_FREE.invalid_format);
    }
    if (seen.has(assignmentId)) {
      failScheduler('duplicate_assignment_id', entryPath, CONTENT_FREE.duplicate_assignment_id);
    }
    if (knownIds && !knownIds.has(assignmentId)) {
      failScheduler('assignment_id_unknown', entryPath, CONTENT_FREE.assignment_id_unknown);
    }
    seen.add(assignmentId);
    ids.push(assignmentId);
  }
  return ids;
}

function parseCursors(value, lanesById) {
  if (value === undefined) return new Map();
  if (!ARRAY_IS_ARRAY(value) || IS_PROXY(value)) {
    failScheduler('invalid_type', 'cursors', CONTENT_FREE.invalid_type);
  }
  if (value.length === 0) return new Map();
  if (value.length < MIN_ASSIGNMENTS || value.length > MAX_ASSIGNMENTS) {
    failScheduler('out_of_range', 'cursors', CONTENT_FREE.out_of_range);
  }
  const cursors = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const path = `cursors[${index}]`;
    const entry = value[index];
    assertNotProxy(entry, path);
    if (typeof entry !== 'object' || entry === null || ARRAY_IS_ARRAY(entry)) {
      failScheduler('invalid_type', path, CONTENT_FREE.invalid_type);
    }
    assertClosedKeySet(entry, RUN_SCHEDULER_CURSOR_KEYS, path);
    const assignmentId = requiredString(entry, 'assignment_id', `${path}.assignment_id`, isAssignmentId);
    const taskId = assertTaskId(requiredString(entry, 'task_id', `${path}.task_id`), `${path}.task_id`);
    const eventCursor = assertEventCursor(
      requiredString(entry, 'event_cursor', `${path}.event_cursor`),
      `${path}.event_cursor`,
    );
    const lane = lanesById.get(assignmentId);
    if (!lane || lane.task_id !== taskId) {
      failScheduler('cursor_identity_mismatch', path, CONTENT_FREE.cursor_identity_mismatch);
    }
    if (cursors.has(assignmentId)) {
      failScheduler('duplicate_assignment_id', `${path}.assignment_id`, CONTENT_FREE.duplicate_assignment_id);
    }
    cursors.set(assignmentId, eventCursor);
  }
  return cursors;
}

function pickOwn(object, key) {
  if (object === null || typeof object !== 'object' || IS_PROXY(object)) return undefined;
  if (!capturedHasOwn(object, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
  return descriptor.value;
}

function boundText(value, maxBytes) {
  if (typeof value !== 'string') return null;
  if (capturedUtf8ByteLength(value) > maxBytes) return null;
  return value;
}

function boundOptions(value) {
  if (value === undefined || value === null) return { options: null, invalid: false };
  if (!ARRAY_IS_ARRAY(value) || IS_PROXY(value)) return { options: null, invalid: true };
  const options = [];
  const allowedKeys = new Set(['optionId', 'kind', 'name', 'label', 'description']);
  const limit = Math.min(value.length, MAX_SCHEDULER_ATTENTION_OPTIONS);
  for (let index = 0; index < limit; index += 1) {
    const raw = value[index];
    if (typeof raw === 'string') {
      const option = boundText(raw, MAX_SCHEDULER_ATTENTION_OPTION_BYTES);
      if (option !== null) options.push(option);
      continue;
    }
    if (raw === null || typeof raw !== 'object' || ARRAY_IS_ARRAY(raw) || IS_PROXY(raw)) {
      return { options: null, invalid: true };
    }
    const option = {};
    for (const key of capturedOwnKeys(raw)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) return { options: null, invalid: true };
      const text = boundText(pickOwn(raw, key), MAX_SCHEDULER_ATTENTION_OPTION_BYTES);
      if (text === null || text.length === 0) return { options: null, invalid: true };
      option[key] = text;
    }
    if (typeof option.kind !== 'string') return { options: null, invalid: true };
    options.push(option);
  }
  return { options: options.length === 0 ? null : options, invalid: false };
}

function projectAttention(raw, provider) {
  if (raw === undefined || raw === null) return { attention: null, invalid: false };
  if (typeof raw !== 'object' || ARRAY_IS_ARRAY(raw) || IS_PROXY(raw)) {
    return { attention: null, invalid: true };
  }
  const sessionId = pickOwn(raw, 'session_id');
  const questionId = pickOwn(raw, 'question_id');
  if (typeof sessionId !== 'string' || !capturedTest(SESSION_ID_PATTERN, sessionId)
    || typeof questionId !== 'string' || !capturedTest(QUESTION_ID_PATTERN, questionId)) {
    return { attention: null, invalid: true };
  }
  const boundedOptions = boundOptions(pickOwn(raw, 'options'));
  if (boundedOptions.invalid) return { attention: null, invalid: true };
  return {
    attention: {
      session_id: sessionId,
      question_id: questionId,
      prompt: boundText(pickOwn(raw, 'prompt'), MAX_SCHEDULER_ATTENTION_PROMPT_BYTES),
      options: boundedOptions.options,
      reply_capability: expectedReplyCapability(provider),
    },
    invalid: false,
  };
}

function mapInspectStatus(value) {
  if (typeof value !== 'string') return null;
  if (!capturedHasOwn(INSPECT_STATUS_MAP, value)) return null;
  return INSPECT_STATUS_MAP[value];
}

function setUnresolved(lane, code) {
  if (lane.unresolved === null) {
    lane.unresolved = { assignment_id: lane.assignment_id, code, required: lane.required };
  }
  if (code !== 'safe_cancel_unconfirmed' && lane.status !== 'cancelled') {
    lane.status = 'unresolved';
  }
}

function delegatePlan(record, lane) {
  return freezeData({
    access: lane.access,
    assignment_id: lane.assignment_id,
    model: lane.model,
    provider: lane.provider,
    required: lane.required,
    role: lane.role,
    run_id: record.run_id,
    starting_ref: lane.starting_ref,
    task_id: lane.task_id,
    write_scope: [...lane.write_scope],
  });
}

function inspectPlan(record, lane, cursor) {
  return freezeData({
    assignment_id: lane.assignment_id,
    cursor,
    run_id: record.run_id,
    task_id: lane.task_id,
  });
}

function cancelPlan(record, lane) {
  return freezeData({
    assignment_id: lane.assignment_id,
    run_id: record.run_id,
    task_id: lane.task_id,
  });
}

async function dispatchLane(delegateTask, record, lane) {
  let result;
  try {
    result = await delegateTask(delegatePlan(record, lane));
  } catch {
    setUnresolved(lane, 'dispatch_failed');
    return;
  }
  if (result === null || typeof result !== 'object' || ARRAY_IS_ARRAY(result) || IS_PROXY(result)) {
    setUnresolved(lane, 'identity_mismatch');
    return;
  }
  const taskId = pickOwn(result, 'task_id');
  if (taskId !== lane.task_id) {
    setUnresolved(lane, 'identity_mismatch');
    return;
  }
  const cursor = pickOwn(result, 'cursor');
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !capturedTest(EVENT_CURSOR_PATTERN, cursor)) {
      setUnresolved(lane, 'identity_mismatch');
      return;
    }
    lane.cursor = cursor;
  }
  const status = mapInspectStatus(pickOwn(result, 'status'));
  lane.dispatched = true;
  lane.status = status ?? 'dispatched';
}

async function inspectLane(inspectTask, record, lane, requestedCursor) {
  if (!lane.dispatched) return;
  if (lane.status === 'cancelled') {
    setUnresolved(lane, 'restart_denied_no_replay');
    lane.status = 'cancelled';
    return;
  }
  if (isTerminalStatus(lane.status) && lane.status !== 'needs_attention') return;
  let result;
  try {
    result = await inspectTask(inspectPlan(record, lane, requestedCursor ?? lane.cursor));
  } catch {
    setUnresolved(lane, 'inspect_failed');
    return;
  }
  if (result === null || typeof result !== 'object' || ARRAY_IS_ARRAY(result) || IS_PROXY(result)) {
    setUnresolved(lane, 'inspect_failed');
    return;
  }
  if (pickOwn(result, 'task_id') !== lane.task_id) {
    setUnresolved(lane, 'identity_mismatch');
    return;
  }
  const cursor = pickOwn(result, 'cursor');
  if (typeof cursor === 'string' && capturedTest(EVENT_CURSOR_PATTERN, cursor)) {
    lane.cursor = cursor;
  }
  const mapped = mapInspectStatus(pickOwn(result, 'status'));
  if (mapped !== null) lane.status = mapped;
  const projected = projectAttention(pickOwn(result, 'attention'), lane.provider);
  if (projected.invalid) {
    setUnresolved(lane, 'attention_evidence_invalid');
    return;
  }
  lane.attention = projected.attention;
  if (projected.attention !== null && projected.attention.reply_capability === 'unsupported') {
    setUnresolved(lane, 'same_session_reply_unsupported');
  }
}

async function cancelLane(cancelTask, record, lane) {
  if (!lane.dispatched) {
    lane.status = 'cancelled';
    lane.cancel_confirmed = true;
    return { called: false, confirmed: true };
  }
  if (lane.status === 'cancelled' && lane.cancel_confirmed === true) {
    return { called: false, confirmed: true };
  }
  if (isTerminalStatus(lane.status) && lane.status !== 'unresolved' && lane.status !== 'needs_attention') {
    return { called: false, confirmed: lane.status === 'cancelled' };
  }
  let result;
  try {
    result = await cancelTask(cancelPlan(record, lane));
  } catch {
    lane.cancel_confirmed = false;
    setUnresolved(lane, 'safe_cancel_unconfirmed');
    return { called: true, confirmed: false };
  }
  const confirmed = result !== null && typeof result === 'object' && !ARRAY_IS_ARRAY(result)
    && !IS_PROXY(result)
    && pickOwn(result, 'task_id') === lane.task_id
    && pickOwn(result, 'cancelled') === true;
  if (!confirmed) {
    lane.cancel_confirmed = false;
    setUnresolved(lane, 'safe_cancel_unconfirmed');
    return { called: true, confirmed: false };
  }
  lane.status = 'cancelled';
  lane.cancel_confirmed = true;
  lane.attention = null;
  if (lane.unresolved !== null && lane.unresolved.code === 'safe_cancel_unconfirmed') {
    lane.unresolved = null;
  }
  return { called: true, confirmed: true };
}

function assertInjectedFunction(dependencies, key) {
  const path = key;
  if (!hasOwn(dependencies, key)) {
    failScheduler('injected_dependency_invalid', path, CONTENT_FREE.injected_dependency_invalid);
  }
  const value = ownDataValue(dependencies, key, path);
  if (typeof value !== 'function' || IS_PROXY(value)) {
    failScheduler('injected_dependency_invalid', path, CONTENT_FREE.injected_dependency_invalid);
  }
  return value;
}

function parseDependencies(dependencies) {
  if (dependencies === undefined || dependencies === null) {
    failScheduler('injected_dependency_invalid', 'dependencies', CONTENT_FREE.injected_dependency_invalid);
  }
  assertNotProxy(dependencies, 'dependencies');
  if (typeof dependencies !== 'object' || ARRAY_IS_ARRAY(dependencies)) {
    failScheduler('injected_dependency_invalid', 'dependencies', CONTENT_FREE.injected_dependency_invalid);
  }
  let keys;
  try {
    keys = REFLECT_OWN_KEYS(dependencies);
  } catch {
    failScheduler('injected_dependency_invalid', 'dependencies', CONTENT_FREE.injected_dependency_invalid);
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      failScheduler('symbol_key_denied', 'dependencies', CONTENT_FREE.symbol_key_denied);
    }
    if (!capturedIncludes(RUN_SCHEDULER_DEPENDENCY_KEYS, key)) {
      failScheduler('unknown_key', `dependencies.${key}`, CONTENT_FREE.unknown_key);
    }
  }
  return capturedFreeze({
    delegateTask: assertInjectedFunction(dependencies, 'delegateTask'),
    inspectTask: assertInjectedFunction(dependencies, 'inspectTask'),
    cancelTask: assertInjectedFunction(dependencies, 'cancelTask'),
    clock: assertInjectedFunction(dependencies, 'clock'),
  });
}

function enqueue(queues, runId, work) {
  const current = queues.get(runId) ?? Promise.resolve();
  const next = current.then(work, work);
  queues.set(runId, next.catch(() => {}));
  return next;
}

export function describeRunSchedulerV1() {
  return freezeData({
    schema: RUN_SCHEDULER_SCHEMA_ID,
    version: RUN_SCHEDULER_VERSION,
    receipt_schema: RUN_SCHEDULER_RECEIPT_SCHEMA_ID,
    methods: RUN_SCHEDULER_METHODS,
    dependencies: RUN_SCHEDULER_DEPENDENCY_KEYS,
    statuses: RUN_SCHEDULER_STATUSES,
    lane_statuses: RUN_SCHEDULER_LANE_STATUSES,
    unresolved_codes: RUN_SCHEDULER_UNRESOLVED_CODES,
    checks: RUN_SCHEDULER_CHECKS,
    side_effects: RUN_SCHEDULER_SIDE_EFFECTS,
    error_codes: RUN_SCHEDULER_ERROR_CODES,
    bounds: capturedFreeze({
      assignments: capturedFreeze({ min: MIN_ASSIGNMENTS, max: MAX_ASSIGNMENTS }),
      attention_prompt_bytes: MAX_SCHEDULER_ATTENTION_PROMPT_BYTES,
      attention_options: MAX_SCHEDULER_ATTENTION_OPTIONS,
    }),
    rule: 'one_submission_idempotent_1_to_8_fanout_no_replay',
    wake: false,
    remote_mutated: false,
    ownership: capturedFreeze({
      scheduler: 'in-memory one-submission fanout, exact identity, disjoint writers, read-only verifiers, bounded attention/cancel/restart/cursor evidence',
      injected: 'delegateTask, inspectTask, cancelTask, clock',
      forbidden: capturedFreeze([
        'run_runtime',
        'artifact_bridge',
        'lifecycle',
        'supervisor',
        'server',
        'candidate_composition',
        'mailbox',
        'provider_driver',
        'task_store',
        'changelog',
        'future_work',
        'gate_a',
        'release',
      ]),
    }),
    composed_surfaces: capturedFreeze({
      run_runtime: 'not imported; later P33 runtime injects this scheduler',
      artifact_bridge: 'not imported',
      lifecycle: 'not imported',
      attention_batch: 'not imported; this surface only records bounded attention evidence',
      public_api: 'not exposed',
      gate_a: 'not claimed',
    }),
  });
}

export function createRunScheduler(dependencies) {
  const injected = parseDependencies(dependencies);
  const runs = new Map();
  const queues = new Map();

  async function submitAssignments(request) {
    const parsed = quarantineRequest(request, 'request', RUN_SCHEDULER_SUBMIT_KEYS);
    if (!hasOwn(parsed, 'run_id')) failScheduler('missing_key', 'run_id', CONTENT_FREE.missing_key);
    if (!hasOwn(parsed, 'base_sha')) failScheduler('missing_key', 'base_sha', CONTENT_FREE.missing_key);
    if (!hasOwn(parsed, 'assignments')) failScheduler('missing_key', 'assignments', CONTENT_FREE.missing_key);
    const runId = ownDataValue(parsed, 'run_id', 'run_id');
    assertRunId(runId, 'run_id');
    const baseSha = ownDataValue(parsed, 'base_sha', 'base_sha');
    assertBaseSha(baseSha, 'base_sha');
    const lanes = parseAssignments(ownDataValue(parsed, 'assignments', 'assignments'));
    const digest = identityDigest(runId, baseSha, lanes);

    return enqueue(queues, runId, async () => {
      const observedAt = readClock(injected.clock);
      const existing = runs.get(runId);
      if (existing) {
        if (existing.digest !== digest) {
          failScheduler('scheduler_run_conflict', 'run_id', CONTENT_FREE.scheduler_run_conflict);
        }
        return receiptFor(existing, {
          status: 'idempotent', created: false, dispatched: false, observedAt,
        });
      }
      const record = {
        run_id: runId,
        base_sha: baseSha,
        digest,
        lanes,
      };
      runs.set(runId, record);
      await Promise.all(lanes.map((lane) => dispatchLane(injected.delegateTask, record, lane)));
      const dispatchedCount = lanes.reduce((count, lane) => count + (lane.dispatched ? 1 : 0), 0);
      const failed = lanes.some((lane) => !lane.dispatched);
      return receiptFor(record, {
        status: failed ? 'partial' : 'dispatched',
        created: true,
        dispatched: dispatchedCount > 0,
        observedAt,
      });
    });
  }

  async function resumeAssignments(request) {
    const parsed = quarantineRequest(request, 'request', RUN_SCHEDULER_RESUME_KEYS);
    if (!hasOwn(parsed, 'run_id')) failScheduler('missing_key', 'run_id', CONTENT_FREE.missing_key);
    const runId = ownDataValue(parsed, 'run_id', 'run_id');
    assertRunId(runId, 'run_id');

    return enqueue(queues, runId, async () => {
      const observedAt = readClock(injected.clock);
      const record = runs.get(runId);
      if (!record) failScheduler('scheduler_run_unknown', 'run_id', CONTENT_FREE.scheduler_run_unknown);
      const knownIds = new Set(record.lanes.map((lane) => lane.assignment_id));
      const lanesById = new Map(record.lanes.map((lane) => [lane.assignment_id, lane]));
      const selected = parseIdList(optionalOwn(parsed, 'assignment_ids', 'assignment_ids'), 'assignment_ids', knownIds)
        ?? [...knownIds];
      const cursors = parseCursors(optionalOwn(parsed, 'cursors', 'cursors'), lanesById);
      for (const assignmentId of cursors.keys()) {
        if (!selected.includes(assignmentId)) {
          failScheduler('cursor_identity_mismatch', 'cursors', CONTENT_FREE.cursor_identity_mismatch);
        }
      }
      const targets = record.lanes.filter((lane) => selected.includes(lane.assignment_id));
      await Promise.all(targets.map(async (lane) => {
        await inspectLane(injected.inspectTask, record, lane, cursors.get(lane.assignment_id));
        if (lane.unresolved !== null && lane.unresolved.code === 'same_session_reply_unsupported') {
          await cancelLane(injected.cancelTask, record, lane);
        }
      }));
      return receiptFor(record, {
        status: 'inspected', created: false, dispatched: false, observedAt,
      });
    });
  }

  async function cancelAssignments(request) {
    const parsed = quarantineRequest(request, 'request', RUN_SCHEDULER_CANCEL_KEYS);
    if (!hasOwn(parsed, 'run_id')) failScheduler('missing_key', 'run_id', CONTENT_FREE.missing_key);
    if (!hasOwn(parsed, 'assignment_ids')) {
      failScheduler('missing_key', 'assignment_ids', CONTENT_FREE.missing_key);
    }
    const runId = ownDataValue(parsed, 'run_id', 'run_id');
    assertRunId(runId, 'run_id');

    return enqueue(queues, runId, async () => {
      const observedAt = readClock(injected.clock);
      const record = runs.get(runId);
      if (!record) failScheduler('scheduler_run_unknown', 'run_id', CONTENT_FREE.scheduler_run_unknown);
      const knownIds = new Set(record.lanes.map((lane) => lane.assignment_id));
      const selected = parseIdList(
        ownDataValue(parsed, 'assignment_ids', 'assignment_ids'),
        'assignment_ids',
        knownIds,
      );
      const targets = record.lanes.filter((lane) => selected.includes(lane.assignment_id));
      let called = false;
      await Promise.all(targets.map(async (lane) => {
        const result = await cancelLane(injected.cancelTask, record, lane);
        if (result.called) called = true;
      }));
      return receiptFor(record, {
        status: 'cancelled', created: false, cancelled: called, observedAt,
      });
    });
  }

  return capturedFreeze({
    submitAssignments,
    resumeAssignments,
    cancelAssignments,
  });
}
