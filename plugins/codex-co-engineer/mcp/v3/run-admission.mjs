// RunAdmissionV1 — the 3.4.1 two-barrier coordinator for SimpleRunRequestV1.
//
// The legacy RunRuntimeV1 remains available for existing full run envelopes.
// This module owns the additive simple-request lifecycle so admission,
// provider dispatch, recovery, consent, cancellation, and terminal handoffs
// have an explicit state machine without changing the 3.4.0 durable schemas.
//
// Barrier A (admission) completes all validation/readiness/workspace work
// before dispatchPrompt is called for any lane. Barrier B records session and
// prompt evidence lane by lane. Provider dispatch is not transactional: a
// later failure is represented as degraded with exact sent/unsent lanes.

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
} from './grammar.mjs';
import {
  compileRunRequestV1,
  RUN_REQUEST_SCHEMA_ID,
  RUN_REQUEST_VERSION,
} from './run-request-compiler.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  RunContractV1Error,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  freezeData,
  identityBoundDigest,
} from './selection-json.mjs';
import { IDENTITY_LABELS } from './identity.mjs';
import { boundProviderResult } from './compact-task.mjs';
import {
  validateChildIdentityV1,
  validateDispatchAttemptV1,
  validateGitIdentityV1,
  validateProviderRunIdentityV1,
  validateRunIdentityV1,
  validateWorkspaceIdentityV1,
} from './protected-identity.mjs';

export const RUN_ADMISSION_SCHEMA_ID = 'codex-co-engineer.run-admission.v1';
export const RUN_ADMISSION_VERSION = 1;
export const RUN_PHASES = capturedFreeze([
  'validating',
  'awaiting_consent',
  'preparing_workspaces',
  'dispatching',
  'running',
  'needs_attention',
  'degraded',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);
export const RUN_TERMINAL_PHASES = capturedFreeze(['completed', 'failed', 'cancelled']);
export const RUN_ATTENTION_PHASES = capturedFreeze(['needs_attention', 'degraded']);
export const LANE_PHASES = capturedFreeze([
  'planned',
  'prepared',
  'session_ready',
  'prompt_dispatched',
  'running',
  'needs_attention',
  'completed',
  'partial_handoff',
  'failed_pre_prompt',
  'unrecoverable_post_prompt',
  'cancelled',
]);
export const LANE_TERMINAL_PHASES = capturedFreeze([
  'completed',
  'partial_handoff',
  'failed_pre_prompt',
  'unrecoverable_post_prompt',
  'cancelled',
]);
export const RUN_ADMISSION_METHODS = capturedFreeze([
  'submitRunRequest', 'inspectRun', 'resumeRun', 'replyRun', 'cancelRun', 'waitRun',
]);
export const RUN_ADMISSION_DEPENDENCIES = capturedFreeze([
  'requestConsent', 'verifyConsent', 'providerReady', 'processBoundaryReady',
  'verifyRepository', 'prepareWorkspace', 'cleanupWorkspace', 'createSession',
  'dispatchPrompt', 'inspectLane', 'reconnectLane', 'replyAttention', 'cancelLane',
  'inspectWorkspace', 'buildHandoff', 'verifyRun', 'clock', 'sleep', 'compile',
  'loadRecord', 'persistRecord', 'waitForProgress',
]);
const MAX_PROVIDER_RESULT_BYTES = 8 * 1024;

export const RUN_ADMISSION_CAPS = capturedFreeze({
  max_lanes: MAX_ASSIGNMENTS,
  max_handoff_bytes: 16_384,
  max_error_bytes: 160,
  max_changed_files: 64,
  max_commits: 64,
  max_next_actions: 8,
  max_provider_result_bytes: MAX_PROVIDER_RESULT_BYTES,
});

const TELEMETRY_DEFAULTS = Object.freeze({
  admission_duration_ms: null,
  admission_failure_stage: null,
  workspace_preparation_duration_ms: null,
  dispatch_duration_ms: null,
  dispatch_confidence: 'not_dispatched',
  time_to_session_ms: null,
  time_to_prompt_dispatch_ms: null,
  time_to_first_event_ms: null,
  last_meaningful_activity_at: null,
  silence_duration_ms: null,
  time_to_terminal_handoff_ms: null,
  recovery_path: null,
  handoff_class: null,
  attention_count: 0,
  attention_deduplicated_count: 0,
  cancel_attempts: 0,
  cancel_confirmed: null,
  response_bytes: null,
  response_truncated: false,
});

const RUN_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const CURSOR_PATTERN = /^\d{1,16}$/u;
const MAX_WAIT_MS = 14_400_000;
const OBSERVATION_BACKOFF_MS = 1_000;
const OBSERVATION_RECOVERY_CLASSIFICATION = 'post_prompt_inspection_failed_no_replay';
const KNOWN_LANE_OBSERVATION_STATUSES = capturedFreeze([
  'running', 'starting', 'accepted', 'cancelling', 'needs_attention',
  'completed', 'succeeded', 'cancelled', 'transport_lost',
  'environment_blocked', 'failed', 'timeout', 'timed_out',
]);
const SAFE_CONSENT_ERROR_CODES = capturedFreeze([
  'consent_host_unavailable',
  'consent_declined',
  'consent_cancelled',
  'consent_timed_out',
  'consent_response_invalid',
  'consent_request_aborted',
]);
const RETRYABLE_CONSENT_ERROR_CODES = capturedFreeze([
  'consent_cancelled',
  'consent_timed_out',
  'consent_request_aborted',
]);
const SAFE_ATTENTION_CAPABILITIES = capturedFreeze([
  'read_run_receipts', 'read_provider_logs', 'read_own_worktree',
]);
const CAPABILITY_RESOURCES = Object.freeze({
  read_run_receipts: 'run_receipt',
  read_provider_logs: 'provider_log',
  read_own_worktree: 'own_worktree',
});

function admissionError(code, field, message = 'The run admission request is invalid.') {
  throw new RunContractV1Error(code, field, message);
}

function asErrorCode(error, fallback = 'provider_failure') {
  return typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : fallback;
}

const ADMISSION_FAILURE_MESSAGES = Object.freeze({
  runtime_install_incomplete: 'The installed Codex-Co-Engineer runtime is incomplete. Reinstall the plugin, then restart Codex.',
});

function errorSummary(error, fallback = 'The run operation failed.') {
  const code = asErrorCode(error, fallback);
  const message = ADMISSION_FAILURE_MESSAGES[code] ?? code;
  return { code, message: message.length > RUN_ADMISSION_CAPS.max_error_bytes
    ? message.slice(0, RUN_ADMISSION_CAPS.max_error_bytes) : message };
}

function ownObject(value, field) {
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, field);
  assertDirectJsonClosure(value, field);
  return value;
}

function assertKeys(value, allowed, field) {
  for (const key of capturedOwnKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      admissionError('unknown_key', `${field}.${String(key)}`, 'The run operation field is outside the closed vocabulary.');
    }
  }
}

function requiredString(value, key, field, predicate = null) {
  if (!capturedHasOwn(value, key)) admissionError('missing_key', field, 'A required run field is missing.');
  const result = value[key];
  if (typeof result !== 'string' || (predicate && !predicate(result))) {
    admissionError('invalid_format', field, 'A run field is not in the required format.');
  }
  return result;
}

function optionalString(value, key, field, predicate = null) {
  if (!capturedHasOwn(value, key)) return undefined;
  const result = value[key];
  if (typeof result !== 'string' || (predicate && !predicate(result))) {
    admissionError('invalid_format', field, 'A run field is not in the required format.');
  }
  return result;
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date().toISOString();
  return typeof value === 'string' ? value : new Date().toISOString();
}

function cloneError(error) {
  return error ? freezeData({
    code: typeof error.code === 'string' ? error.code : 'provider_failure',
    message: typeof error.message === 'string'
      ? error.message.slice(0, RUN_ADMISSION_CAPS.max_error_bytes)
      : 'The provider operation failed.',
  }) : null;
}

const PROVIDER_FAILURE_MESSAGES = Object.freeze({
  provider_billing_required: 'The provider requires billing setup or available credit.',
  authentication_required: 'The provider requires valid authentication.',
  provider_rate_limited: 'The provider rate limit was reached. Retry later.',
});

function terminalLaneError(response, fallbackCode) {
  const code = response.error?.code;
  return cloneError(typeof code === 'string' && capturedHasOwn(PROVIDER_FAILURE_MESSAGES, code)
    ? { code, message: PROVIDER_FAILURE_MESSAGES[code] }
    : { code: fallbackCode });
}

function normalizeAttention(value) {
  if (value === null || value === undefined) return null;
  try {
    assertNotProxy(value, 'attention');
    assertPlainObject(value, 'invalid_type', 'attention', 'attention');
    assertDirectJsonClosure(value, 'attention');
  } catch {
    return { invalid: true };
  }
  const allowed = new Set([
    'session_id', 'question_id', 'capability', 'resource', 'action',
    'prompt', 'options', 'required', 'event_cursor', 'deadline_at', 'stage',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return { invalid: true };
  for (const key of ['session_id', 'question_id', 'capability', 'resource', 'action', 'event_cursor', 'deadline_at']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 256)) {
      return { invalid: true };
    }
  }
  if (value.capability !== undefined && !SAFE_ATTENTION_CAPABILITIES.includes(value.capability)) return { invalid: true };
  if (value.capability !== undefined
    && (value.resource !== CAPABILITY_RESOURCES[value.capability] || value.action !== 'read')) return { invalid: true };
  if (value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length > 4096)) return { invalid: true };
  if (value.stage !== undefined && (typeof value.stage !== 'string' || value.stage.length === 0 || value.stage.length > 128)) return { invalid: true };
  let options;
  if (value.options !== undefined && value.options !== null) {
    if (!Array.isArray(value.options) || value.options.length > 8) return { invalid: true };
    options = [];
    const allowedOptionKeys = new Set(['optionId', 'kind', 'name', 'label', 'description']);
    for (const option of value.options) {
      if (typeof option === 'string') {
        if (option.length > 128) return { invalid: true };
        options.push(option);
        continue;
      }
      try {
        assertNotProxy(option, 'attention.options');
        assertPlainObject(option, 'invalid_type', 'attention.options', 'attention option');
        assertDirectJsonClosure(option, 'attention.options');
      } catch {
        return { invalid: true };
      }
      for (const key of Object.keys(option)) {
        if (!allowedOptionKeys.has(key)
          || typeof option[key] !== 'string'
          || option[key].length === 0
          || option[key].length > 128) return { invalid: true };
      }
      if (typeof option.kind !== 'string') return { invalid: true };
      options.push({ ...option });
    }
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') return { invalid: true };
  return {
    ...value,
    ...(options !== undefined ? { options } : {}),
  };
}

function capabilityQuestionKey(attention) {
  if (!attention?.capability || !attention.resource || !attention.action) return null;
  return `${attention.capability}\u0000${attention.resource}\u0000${attention.action}`;
}

function attentionDedupKey(attention) {
  return capabilityQuestionKey(attention)
    ?? (attention?.question_id ? `question\u0000${attention.question_id}` : null);
}

function attentionTarget(lane, attention) {
  return {
    assignment_id: lane.assignment_id,
    task_id: lane.task_id,
    provider: lane.provider,
    session_id: attention.session_id ?? lane.session_id ?? null,
    question_id: attention.question_id ?? null,
  };
}

function isCapabilityCovered(assignment, attention) {
  const capability = attention?.capability;
  if (!SAFE_ATTENTION_CAPABILITIES.includes(capability)) return false;
  return attention.resource === CAPABILITY_RESOURCES[capability]
    && attention.action === 'read'
    && Array.isArray(assignment?.capabilities)
    && assignment.capabilities.includes(capability);
}

function mergeAttention(record, lane, assignment, attention) {
  const key = attentionDedupKey(attention);
  const capabilityKey = capabilityQuestionKey(attention);
  const target = attentionTarget(lane, attention);
  const item = {
    assignment_id: lane.assignment_id,
    task_id: lane.task_id,
    provider: lane.provider,
    required: lane.required,
    ...attention,
    ...(capabilityKey ? { capability_key: capabilityKey } : {}),
    ...(key ? { attention_key: key } : {}),
    targets: [target],
  };
  if (!Array.isArray(record.attention_questions)) record.attention_questions = [];
  if (key && record.attention?.status === 'open') {
    const existingIndex = record.attention_questions.findIndex((entry) => entry.attention_key === key);
    if (existingIndex >= 0) {
      const existing = record.attention_questions[existingIndex];
      const existingTargets = Array.isArray(existing.targets) && existing.targets.length > 0
        ? existing.targets
        : [attentionTarget(existing, existing)];
      const targetKey = JSON.stringify(target);
      const hasTarget = existingTargets.some((entry) => JSON.stringify(entry) === targetKey);
      const updated = {
        ...existing,
        ...(hasTarget ? {} : { targets: [...existingTargets, target] }),
      };
      const questions = record.attention_questions.slice();
      questions[existingIndex] = updated;
      record.attention_questions = questions;
      const items = record.attention_questions.slice(-MAX_ASSIGNMENTS);
      return {
        ...record.attention,
        revision: record.revision,
        items,
      };
    }
  }
  record.attention_questions.push(item);
  const items = record.attention_questions.slice(-MAX_ASSIGNMENTS);
  return {
    kind: 'grouped_attention',
    status: 'open',
    batch_id: `att-${identityBoundDigest(IDENTITY_LABELS.RUN_IDENTITY, {
      run_id: record.run_id,
      items: items.map((entry) => ({
        assignment_id: entry.assignment_id,
        attention_key: entry.attention_key ?? null,
        question_id: entry.question_id ?? null,
      })),
    }).slice(7, 39)}`,
    revision: record.revision,
    items,
  };
}

function attentionWasSatisfied(lane, key) {
  return key !== null && Array.isArray(lane.attention_satisfied_keys)
    && lane.attention_satisfied_keys.includes(key);
}

function publicConsentRequest(compiled) {
  const providers = [];
  for (const assignment of compiled.assignments) {
    if (!providers.includes(assignment.provider)) providers.push(assignment.provider);
  }
  const repositoryIdentity = compiled.git_identity?.digest
    ?? compiled.run_identity?.digest
    ?? identityBoundDigest(IDENTITY_LABELS.RUN_IDENTITY, {
      run_id: compiled.run_id,
      base_sha: compiled.git?.base_sha ?? null,
    });
  return freezeData({
    kind: 'repository_exposure_consent',
    run_id: compiled.run_id,
    repository_identity: repositoryIdentity,
    providers,
    scope: 'full_repository',
    duration: 'this_run_only',
    remote_mutation: false,
  });
}

function bindingForConsent(compiled) {
  return freezeData({
    run_id: compiled.run_id,
    repository_identity: compiled.git_identity?.digest ?? compiled.run_identity?.digest ?? null,
    providers: [...new Set(compiled.assignments.map((assignment) => assignment.provider))].sort(),
    scope: 'full_repository',
    duration: 'this_run_only',
    remote_mutation: false,
  });
}

function validateCompiled(compiled) {
  assertNotProxy(compiled, 'compiled_run');
  assertPlainObject(compiled, 'invalid_type', 'compiled_run', 'compiled_run');
  if (compiled.schema !== RUN_REQUEST_SCHEMA_ID || compiled.version !== RUN_REQUEST_VERSION) {
    admissionError('durable_state_mismatch', 'compiled_run', 'Compiled run schema or version is invalid.');
  }
  const runId = requiredString(compiled, 'run_id', 'compiled_run.run_id', (value) => RUN_ID_PATTERN.test(value));
  let gitIdentity;
  let runIdentity;
  try {
    gitIdentity = validateGitIdentityV1(compiled.git_identity, 'compiled_run.git_identity');
    runIdentity = validateRunIdentityV1(compiled.run_identity, 'compiled_run.run_identity');
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    admissionError('durable_state_mismatch', 'compiled_run.identity', 'Compiled run identity is invalid.');
  }
  if (gitIdentity.repository_path !== compiled.git?.repository_path
    || gitIdentity.base_sha !== compiled.git?.base_sha
    || runIdentity.run_id !== runId
    || runIdentity.git.digest !== gitIdentity.digest
    || runIdentity.manifest_digest !== compiled.manifest_digest) {
    admissionError('durable_state_mismatch', 'compiled_run.identity', 'Compiled run identity does not match its Git or manifest binding.');
  }
  const assignments = compiled.assignments;
  if (!capturedIsArray(assignments) || assignments.length < MIN_ASSIGNMENTS || assignments.length > MAX_ASSIGNMENTS) {
    admissionError('invalid_format', 'compiled_run.assignments', 'Compiled run assignments are outside the supported bound.');
  }
  const ids = new Set();
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = ownObject(assignments[index], `compiled_run.assignments[${index}]`);
    const assignmentId = requiredString(assignment, 'assignment_id', `compiled_run.assignments[${index}].assignment_id`, isAssignmentId);
    const taskId = requiredString(assignment, 'task_id', `compiled_run.assignments[${index}].task_id`, (value) => TASK_ID_PATTERN.test(value));
    if (ids.has(assignmentId)) admissionError('duplicate_assignment_id', 'compiled_run.assignments', 'Compiled assignment IDs must be unique.');
    ids.add(assignmentId);
    if (typeof assignment.provider !== 'string' || typeof assignment.model !== 'string') {
      admissionError('invalid_format', `compiled_run.assignments[${index}]`, 'Compiled provider selection is incomplete.');
    }
    try {
      const child = validateChildIdentityV1(assignment.child_identity, `compiled_run.assignments[${index}].child_identity`);
      const dispatch = validateDispatchAttemptV1(assignment.dispatch_identity, `compiled_run.assignments[${index}].dispatch_identity`);
      const providerRun = validateProviderRunIdentityV1(assignment.provider_run_identity, `compiled_run.assignments[${index}].provider_run_identity`);
      if (child.run_id !== runId || child.assignment_id !== assignmentId
        || dispatch.run_id !== runId || dispatch.assignment_id !== assignmentId || dispatch.attempt !== 1
        || providerRun.run_id !== runId || providerRun.assignment_id !== assignmentId
        || providerRun.attempt !== 1 || providerRun.provider !== assignment.provider
        || providerRun.model !== assignment.model || providerRun.git.digest !== gitIdentity.digest
        || providerRun.manifest_digest !== compiled.manifest_digest
        || providerRun.prompt_envelope_digest !== assignment.prompt_envelope_digest
        || providerRun.resolved_lane_digest !== assignment.lane_digest
        || providerRun.capability_snapshot_digest !== assignment.capability_digest) {
        admissionError('durable_state_mismatch', `compiled_run.assignments[${index}]`, 'Compiled lane identity does not match its assignment binding.');
      }
    } catch (error) {
      if (error instanceof RunContractV1Error) throw error;
      admissionError('durable_state_mismatch', `compiled_run.assignments[${index}]`, 'Compiled lane identity is invalid.');
    }
    void taskId;
  }
  return { runId, assignments };
}

function rejectNestedKey(value, forbiddenKey, field = 'persisted_run') {
  if (value === null || typeof value !== 'object') return;
  for (const key of capturedOwnKeys(value)) {
    if (key === forbiddenKey) {
      admissionError('durable_state_mismatch', `${field}.${String(key)}`,
        'Persisted run state contains a forbidden secret-bearing field.');
    }
    rejectNestedKey(value[key], forbiddenKey, `${field}.${String(key)}`);
  }
}

function validatePersistedRecord(record, runId) {
  ownObject(record, 'persisted_run');
  if (record.schema !== RUN_ADMISSION_SCHEMA_ID
    || record.version !== RUN_ADMISSION_VERSION
    || record.run_id !== runId) {
    admissionError('durable_state_mismatch', 'persisted_run',
      'Persisted run schema or identity is invalid.');
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 0
    || !RUN_PHASES.includes(record.phase)
    || !capturedIsArray(record.lanes)
    || record.lanes.length < MIN_ASSIGNMENTS
    || record.lanes.length > MAX_ASSIGNMENTS) {
    admissionError('durable_state_mismatch', 'persisted_run',
      'Persisted run lifecycle state is invalid.');
  }
  const { assignments } = validateCompiled(record.compiled);
  const assignmentsById = new Map(assignments.map((assignment) => [assignment.assignment_id, assignment]));
  const seen = new Set();
  for (let index = 0; index < record.lanes.length; index += 1) {
    const lane = ownObject(record.lanes[index], `persisted_run.lanes[${index}]`);
    const assignment = assignmentsById.get(lane.assignment_id);
    if (!assignment || seen.has(lane.assignment_id)
      || lane.task_id !== assignment.task_id
      || lane.provider !== assignment.provider
      || lane.model !== assignment.model
      || lane.role !== assignment.role
      || lane.access !== assignment.access
      || lane.required !== assignment.required
      || !LANE_PHASES.includes(lane.phase)) {
      admissionError('durable_state_mismatch', `persisted_run.lanes[${index}]`,
        'Persisted lane identity or phase is invalid.');
    }
    seen.add(lane.assignment_id);
    if (lane.child_identity?.digest !== assignment.child_identity?.digest
      || lane.dispatch_identity?.digest !== assignment.dispatch_identity?.digest
      || lane.provider_run_identity?.digest !== assignment.provider_run_identity?.digest) {
      admissionError('durable_state_mismatch', `persisted_run.lanes[${index}]`,
        'Persisted lane identities do not match the compiled assignment.');
    }
    for (const key of ['prepared', 'session_ready', 'prompt_attempted', 'prompt_dispatched']) {
      if (typeof lane[key] !== 'boolean') {
        admissionError('durable_state_mismatch', `persisted_run.lanes[${index}].${key}`,
          'Persisted lane evidence is invalid.');
      }
    }
    if (!['not_sent', 'authoritative', 'uncertain'].includes(lane.dispatch_confidence)) {
      admissionError('durable_state_mismatch', `persisted_run.lanes[${index}].dispatch_confidence`,
        'Persisted dispatch confidence is invalid.');
    }
    if (lane.prompt_dispatched && (!lane.prompt_attempted || lane.dispatch_confidence !== 'authoritative')) {
      admissionError('durable_state_mismatch', `persisted_run.lanes[${index}]`,
        'Persisted dispatch evidence violates the no-replay boundary.');
    }
    if (lane.result_truncated !== undefined && typeof lane.result_truncated !== 'boolean') {
      admissionError('durable_state_mismatch', `persisted_run.lanes[${index}].result_truncated`,
        'Persisted result truncation state is invalid.');
    }
    if (lane.cancel_confirmed !== undefined && lane.cancel_confirmed !== null
      && typeof lane.cancel_confirmed !== 'boolean') {
      admissionError('durable_state_mismatch', `persisted_run.lanes[${index}].cancel_confirmed`,
        'Persisted cancellation state is invalid.');
    }
    if (!capturedIsArray(lane.attention_satisfied_keys)) {
      admissionError('durable_state_mismatch', `persisted_run.lanes[${index}].attention_satisfied_keys`,
        'Persisted attention state is invalid.');
    }
    if (lane.workspace_identity !== null) {
      try {
        const workspace = validateWorkspaceIdentityV1(lane.workspace_identity, `persisted_run.lanes[${index}].workspace_identity`);
        if (workspace.run_id !== runId || workspace.assignment_id !== lane.assignment_id) {
          admissionError('durable_state_mismatch', `persisted_run.lanes[${index}].workspace_identity`,
            'Persisted workspace identity is bound to another run or assignment.');
        }
      } catch (error) {
        if (error instanceof RunContractV1Error) throw error;
        admissionError('durable_state_mismatch', `persisted_run.lanes[${index}].workspace_identity`,
          'Persisted workspace identity is invalid.');
      }
    }
  }
  if (seen.size !== assignments.length) {
    admissionError('durable_state_mismatch', 'persisted_run.lanes',
      'Persisted run does not contain every compiled assignment exactly once.');
  }
  if (!capturedIsArray(record.attention_questions)
    || record.attention_questions.length > MAX_ASSIGNMENTS
    || (record.consent_status !== 'pending'
      && record.consent_status !== 'required'
      && record.consent_status !== 'approved'
      && record.consent_status !== 'blocked')) {
    admissionError('durable_state_mismatch', 'persisted_run',
      'Persisted consent or attention state is invalid.');
  }
  rejectNestedKey(record, 'approval_ref');
  return record;
}

function ensureTelemetry(record) {
  if (record.telemetry !== undefined
    && (record.telemetry === null || typeof record.telemetry !== 'object' || Array.isArray(record.telemetry))) {
    admissionError('durable_state_mismatch', 'persisted_run.telemetry', 'Persisted telemetry is invalid.');
  }
  record.telemetry = { ...TELEMETRY_DEFAULTS, ...(record.telemetry ?? {}) };
  for (const key of ['attention_count', 'attention_deduplicated_count', 'cancel_attempts']) {
    if (!Number.isSafeInteger(record.telemetry[key]) || record.telemetry[key] < 0) {
      admissionError('durable_state_mismatch', `persisted_run.telemetry.${key}`, 'Persisted telemetry counter is invalid.');
    }
  }
  if (!['not_dispatched', 'authoritative', 'partially_authoritative', 'uncertain']
    .includes(record.telemetry.dispatch_confidence)) {
    admissionError('durable_state_mismatch', 'persisted_run.telemetry.dispatch_confidence', 'Persisted dispatch telemetry is invalid.');
  }
  if (typeof record.telemetry.response_truncated !== 'boolean') {
    admissionError('durable_state_mismatch', 'persisted_run.telemetry.response_truncated', 'Persisted response telemetry is invalid.');
  }
  return record;
}

function laneStatus(phase) {
  if (phase === 'prompt_dispatched' || phase === 'running') return 'running';
  if (phase === 'needs_attention') return 'needs_attention';
  if (phase === 'completed') return 'completed';
  if (phase === 'cancelled') return 'cancelled';
  if (phase === 'failed_pre_prompt') return 'failed_pre_prompt';
  if (phase === 'partial_handoff') return 'partial_handoff';
  if (phase === 'unrecoverable_post_prompt') return 'unrecoverable_post_prompt';
  return phase;
}

function isTerminalLane(lane) {
  if (lane.phase === 'partial_handoff' || lane.phase === 'unrecoverable_post_prompt') {
    return ['post_prompt_failure_no_replay', 'post_prompt_environment_blocked_no_replay',
      'timed_out_with_partial_work', 'timed_out_no_changes',
      'terminal_dispatch_uncertain_no_replay'].includes(lane.recovery_classification);
  }
  return capturedIncludes(LANE_TERMINAL_PHASES, lane.phase);
}

function isTerminalRun(record) {
  return capturedIncludes(RUN_TERMINAL_PHASES, record.phase);
}

function authoritativeRequiredDispatch(record) {
  return record.lanes
    .filter((lane) => lane.required !== false)
    .every((lane) => lane.prompt_dispatched === true && lane.dispatch_confidence === 'authoritative');
}


function allLanesTerminal(record) {
  return record.lanes.length > 0 && record.lanes.every(isTerminalLane);
}

function laneNeedsObservation(lane) {
  return lane.prompt_attempted === true && !isTerminalLane(lane);
}

function laneHasPendingDispatchEvidence(lane) {
  return lane.prompt_attempted === true
    && lane.prompt_dispatched !== true
    && lane.dispatch_confidence === 'uncertain'
    && ['session_ready', 'running'].includes(lane.phase)
    && ['dispatch_pending_no_replay', 'post_prompt_session_reconnected'].includes(lane.recovery_classification)
    && !isTerminalLane(lane);
}

function completeCandidateBlocked(record) {
  return record.phase !== 'completed'
    || record.lanes.some((lane) => !isTerminalLane(lane)
      || (lane.required !== false && lane.phase !== 'completed'));
}

function hasPromptEvidence(record) {
  return record.lanes.some((lane) => lane.prompt_attempted === true
    || lane.prompt_dispatched === true
    || lane.dispatch_confidence === 'uncertain');
}

function changedFiles(value) {
  if (!capturedIsArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string').slice(0, RUN_ADMISSION_CAPS.max_changed_files);
}

function commitList(value) {
  if (!capturedIsArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string').slice(0, RUN_ADMISSION_CAPS.max_commits);
}

function observedResult(response) {
  if (response === null || typeof response !== 'object' || capturedIsArray(response)) {
    return { present: false, value: null };
  }
  if (capturedHasOwn(response, 'result')) return { present: true, value: response.result };
  if (capturedHasOwn(response, 'provider_result')) return { present: true, value: response.provider_result };
  return { present: false, value: null };
}

function handoffFallback(record, lane, workspace = null, inspection = null) {
  const worktree = workspace?.worktree_path
    ?? workspace?.path
    ?? inspection?.worktree_path
    ?? inspection?.worktree
    ?? null;
  const retainedWorktree = typeof worktree === 'string' && worktree.length > 0;
  return {
    schema: 'codex-co-engineer.partial-handoff.v1',
    assignment_id: lane.assignment_id,
    worktree: retainedWorktree ? worktree : null,
    branch: workspace?.branch ?? null,
    starting_sha: workspace?.start_sha ?? workspace?.starting_sha ?? record.compiled.git?.base_sha ?? null,
    current_head: inspection?.current_head ?? inspection?.head_sha ?? workspace?.current_head ?? null,
    clean: typeof inspection?.clean === 'boolean' ? inspection.clean : null,
    changed_files: changedFiles(inspection?.changed_files),
    commits: commitList(inspection?.commits),
    no_commit: !(commitList(inspection?.commits).length > 0),
    partial_diff: inspection?.partial_diff === true || changedFiles(inspection?.changed_files).length > 0,
    last_acknowledged_provider_event: inspection?.last_acknowledged_provider_event ?? null,
    recovery_classification: lane.recovery_classification ?? 'no_recovery_needed',
    safe_next_actions: retainedWorktree
      ? ['Review the retained worktree and handoff evidence.']
      : ['Review the run receipt and provider outcome.'],
  };
}

function boundedHandoff(value, fallback) {
  const candidate = value && typeof value === 'object' ? { ...fallback, ...value } : fallback;
  const retainedWorktree = typeof fallback?.worktree === 'string' && fallback.worktree.length > 0;
  if (!retainedWorktree) candidate.worktree = null;
  candidate.changed_files = changedFiles(candidate.changed_files);
  candidate.commits = commitList(candidate.commits);
  candidate.no_commit = candidate.no_commit === true || candidate.commits.length === 0;
  candidate.partial_diff = candidate.partial_diff === true;
  candidate.safe_next_actions = capturedIsArray(candidate.safe_next_actions)
    ? candidate.safe_next_actions.filter((entry) => typeof entry === 'string').slice(0, RUN_ADMISSION_CAPS.max_next_actions)
    : fallback.safe_next_actions;
  if (!retainedWorktree) {
    // The fallback is the only authoritative description of what remains
    // when admission stopped before a workspace was retained.
    candidate.safe_next_actions = fallback.safe_next_actions;
  }
  const text = JSON.stringify(candidate);
  if (Buffer.byteLength(text, 'utf8') <= RUN_ADMISSION_CAPS.max_handoff_bytes) return freezeData(candidate);
  candidate.changed_files = candidate.changed_files.slice(0, 16);
  candidate.commits = candidate.commits.slice(0, 16);
  candidate.safe_next_actions = candidate.safe_next_actions.slice(0, 3);
  return freezeData(candidate);
}

function laneReceipt(lane) {
  return {
    assignment_id: lane.assignment_id,
    task_id: lane.task_id,
    provider: lane.provider,
    model: lane.model,
    role: lane.role,
    access: lane.access,
    required: lane.required,
    phase: lane.phase,
    status: laneStatus(lane.phase),
    prepared: lane.prepared === true,
    session_ready: lane.session_ready === true,
    prompt_attempted: lane.prompt_attempted === true,
    prompt_dispatched: lane.prompt_dispatched === true,
    dispatch_confidence: lane.dispatch_confidence,
    session_id: lane.session_id ?? null,
    cursor: lane.cursor ?? null,
    last_event: lane.last_event ?? null,
    result: lane.result ?? null,
    result_truncated: lane.result_truncated === true,
    cancel_confirmed: lane.cancel_confirmed ?? null,
    task_final: isTerminalLane(lane),
    child_identity_digest: lane.child_identity?.digest ?? null,
    dispatch_identity_digest: lane.dispatch_identity?.digest ?? null,
    provider_run_identity_digest: lane.provider_run_identity?.digest ?? null,
    workspace_identity_digest: lane.workspace_identity?.digest ?? null,
    workspace_identity: lane.workspace_identity ?? null,
    error: lane.error ?? null,
    recovery_classification: lane.recovery_classification ?? null,
    handoff: lane.handoff ?? null,
  };
}

function receipt(record, extras = {}) {
  const dispatched = record.lanes.filter((lane) => lane.prompt_dispatched === true).map((lane) => lane.assignment_id);
  const undispatched = record.lanes.filter((lane) => lane.prompt_attempted !== true).map((lane) => lane.assignment_id);
  const uncertain = record.lanes
    .filter((lane) => lane.dispatch_confidence === 'uncertain')
    .map((lane) => lane.assignment_id);
  return freezeData({
    schema: RUN_ADMISSION_SCHEMA_ID,
    version: RUN_ADMISSION_VERSION,
    run_id: record.run_id,
    phase: record.phase,
    status: record.phase,
    revision: record.revision,
    cursor: String(record.revision),
    objective: record.compiled.objective,
    base_sha: record.compiled.git.base_sha,
    git: {
      base_sha: record.compiled.git.base_sha,
      digest: record.compiled.git_identity.digest,
    },
    assignment_count: record.lanes.length,
    lanes: record.lanes.map(laneReceipt),
    consent: record.consent_request
      ? { status: record.consent_status, request: record.consent_request }
      : { status: record.consent_status },
    admission: record.admission,
    dispatched_assignment_ids: dispatched,
    undispatched_assignment_ids: undispatched,
    dispatch_uncertain_assignment_ids: uncertain,
    authoritative_required_dispatch: authoritativeRequiredDispatch(record),
    cancel_requested: record.cancel_requested === true,
    already_terminal: extras.already_terminal === true,
    error: record.error ?? null,
    attention: record.attention ?? null,
    handoff: record.handoff ?? null,
    complete_candidate_blocked: completeCandidateBlocked(record),
    // Never hand the mutable internal telemetry object to freezeData: receipts
    // are immutable snapshots, while later cancellation/reconciliation still
    // needs to update the record's counters.
    telemetry: { ...record.telemetry },
    ...extras,
  });
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function serializeConsentResponse(value) {
  if (value === true) return { approved: true };
  if (!value || typeof value !== 'object') return { approved: false };
  return {
    approved: value.approved === true || value.status === 'approved',
    expires_at: typeof value.expires_at === 'string' ? value.expires_at : null,
    approved_at: typeof value.approved_at === 'string' ? value.approved_at : null,
  };
}

function consentErrorCode(value, fallback = 'consent_response_invalid') {
  const candidates = [
    value?.code,
    value?.reason,
    value?.error?.code,
    value?.error?.reason,
  ];
  for (const candidate of candidates) {
    if (SAFE_CONSENT_ERROR_CODES.includes(candidate)) return candidate;
  }
  return fallback;
}

function consentRequestValue(compiled, value) {
  if (value === undefined || value === null) return publicConsentRequest(compiled);
  try {
    assertNotProxy(value, 'consent.request');
    assertPlainObject(value, 'invalid_type', 'consent.request', 'Consent request');
    assertDirectJsonClosure(value, 'consent.request');
    return freezeData(value);
  } catch {
    return publicConsentRequest(compiled);
  }
}

function isConsentApproved(value) {
  return value?.approved === true || value?.status === 'approved';
}

function isConsentPending(value) {
  return value?.status === 'required'
    || value?.status === 'pending'
    || value?.status === 'awaiting_consent';
}

function validConsentWindow(consent, clock) {
  if (consent?.approved !== true
    || typeof consent.approved_at !== 'string'
    || typeof consent.expires_at !== 'string') return false;
  const approvedAt = Date.parse(consent.approved_at);
  const expiresAt = Date.parse(consent.expires_at);
  const now = Date.parse(nowIso(clock));
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) return false;
  const current = Number.isFinite(now) ? now : Date.now();
  return approvedAt <= current && expiresAt > current && expiresAt > approvedAt;
}

function createDefaultDependencies(overrides) {
  const dependencies = {
    requestConsent: async (compiled) => ({ status: 'required', request: publicConsentRequest(compiled) }),
    verifyConsent: async () => ({ approved: false }),
    providerReady: async () => ({ ready: true }),
    processBoundaryReady: async () => ({ ready: true }),
    verifyRepository: async () => ({ verified: true }),
    prepareWorkspace: async () => ({ prepared: true, workspace: null }),
    cleanupWorkspace: async () => ({ cleaned: true }),
    createSession: async ({ assignment }) => ({ ready: true, session_id: `${assignment.task_id}-session` }),
    dispatchPrompt: async () => ({ dispatched: true, confidence: 'authoritative' }),
    inspectLane: async () => ({ status: 'running', cursor: '0' }),
    reconnectLane: async () => ({ reconnected: true }),
    replyAttention: async () => ({ delivered: true }),
    cancelLane: async () => ({ confirmed: true, cancelled: true }),
    inspectWorkspace: async () => ({}),
    buildHandoff: async ({ fallback }) => fallback,
    verifyRun: async () => ({ verified: true }),
    clock: () => new Date().toISOString(),
    sleep: defaultSleep,
    waitForProgress: async ({ wait_ms, signal }) => defaultSleep(wait_ms, signal),
    compile: compileRunRequestV1,
    loadRecord: async () => null,
    persistRecord: async () => {},
  };
  for (const key of RUN_ADMISSION_DEPENDENCIES) {
    if (capturedHasOwn(overrides ?? {}, key)) {
      if (typeof overrides[key] !== 'function') admissionError('injected_dependency_invalid', `dependencies.${key}`);
      dependencies[key] = overrides[key];
    }
  }
  return dependencies;
}

export function createRunAdmissionRuntime(overrides = {}) {
  assertNotProxy(overrides, 'dependencies');
  assertPlainObject(overrides, 'injected_dependency_invalid', 'dependencies', 'Run admission dependencies');
  assertDirectJsonClosure(Object.fromEntries(
    capturedOwnKeys(overrides).filter((key) => typeof key === 'string').map((key) => [key, null]),
  ), 'dependencies');
  for (const key of capturedOwnKeys(overrides)) {
    if (typeof key !== 'string' || !capturedIncludes(RUN_ADMISSION_DEPENDENCIES, key)) {
      admissionError('unknown_key', `dependencies.${String(key)}`, 'Run admission dependencies are closed.');
    }
  }
  const injected = createDefaultDependencies(overrides);
  const records = new Map();
  const chains = new Map();

  async function loadRecord(runId) {
    const existing = records.get(runId);
    if (existing) return existing;
    const loaded = await injected.loadRecord(runId);
    if (loaded === null || loaded === undefined) return null;
    try {
      validatePersistedRecord(loaded, runId);
      ensureTelemetry(loaded);
    } catch (error) {
      if (error instanceof RunContractV1Error) throw error;
      admissionError('durable_state_mismatch', 'persisted_run', 'Persisted run state is invalid.');
    }
    records.set(runId, loaded);
    return loaded;
  }

  async function persist(record) {
    try {
      await injected.persistRecord(record);
    } catch {
      admissionError('run_persistence_failed', 'run_id', 'The run state could not be durably persisted.');
    }
  }

  function enqueue(runId, operation) {
    const previous = chains.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    chains.set(runId, current);
    current.finally(() => {
      if (chains.get(runId) === current) chains.delete(runId);
    }).catch(() => {});
    return current;
  }

  function bump(record) {
    record.revision += 1;
    record.updated_at = nowIso(injected.clock);
  }

  function makeRecord(compiled) {
    return {
      schema: RUN_ADMISSION_SCHEMA_ID,
      version: RUN_ADMISSION_VERSION,
      run_id: compiled.run_id,
      compiled,
      phase: 'validating',
      revision: 0,
      created_at: nowIso(injected.clock),
      updated_at: nowIso(injected.clock),
      consent_status: 'pending',
      consent_request: null,
      consent_binding: bindingForConsent(compiled),
      admission: null,
      error: null,
      attention: null,
      attention_questions: [],
      handoff: null,
      cancel_requested: false,
      telemetry: { ...TELEMETRY_DEFAULTS },
      lanes: compiled.assignments.map((assignment) => ({
        assignment_id: assignment.assignment_id,
        task_id: assignment.task_id,
        provider: assignment.provider,
        model: assignment.model,
        role: assignment.role,
        access: assignment.access,
        required: assignment.required !== false,
        child_identity: assignment.child_identity,
        dispatch_identity: assignment.dispatch_identity,
        provider_run_identity: assignment.provider_run_identity,
        phase: 'planned',
        prepared: false,
        workspace: null,
        session_ready: false,
        session_id: null,
        prompt_attempted: false,
        prompt_dispatched: false,
        dispatch_confidence: 'not_sent',
        cursor: null,
        error: null,
        recovery_classification: null,
        handoff: null,
        workspace_identity: null,
        last_event: null,
        attention_satisfied_keys: [],
        result: null,
        result_truncated: false,
        cancel_confirmed: null,
      })),
    };
  }

  async function finishLane(record, lane, inspection = null) {
    // A handoff may describe partial work while provider termination is still unknown.
    if (!capturedIncludes(LANE_TERMINAL_PHASES, lane.phase)) return;
    let workspaceInspection = inspection;
    if (workspaceInspection === null) {
      try {
        workspaceInspection = await injected.inspectWorkspace({
          run_id: record.run_id,
          assignment_id: lane.assignment_id,
          task_id: lane.task_id,
          workspace: lane.workspace,
        });
      } catch {
        workspaceInspection = {};
      }
    }
    if (lane.error?.code === 'timeout') {
      const hasPartialWork = workspaceInspection?.partial_diff === true
        || changedFiles(workspaceInspection?.changed_files).length > 0
        || commitList(workspaceInspection?.commits).length > 0;
      lane.recovery_classification = hasPartialWork
        ? 'timed_out_with_partial_work'
        : 'timed_out_no_changes';
    }
    const fallback = handoffFallback(record, lane, lane.workspace, workspaceInspection);
    try {
      lane.handoff = boundedHandoff(await injected.buildHandoff({
        run_id: record.run_id,
        assignment: record.compiled.assignments.find((assignment) => assignment.assignment_id === lane.assignment_id),
        lane,
        workspace: lane.workspace,
        inspection: workspaceInspection,
        fallback,
      }), fallback);
    } catch {
      lane.handoff = boundedHandoff(null, fallback);
    }
    record.telemetry.handoff_class = lane.phase;
    if (record.telemetry.time_to_terminal_handoff_ms === null) {
      const createdAt = Date.parse(record.created_at);
      if (Number.isFinite(createdAt)) {
        record.telemetry.time_to_terminal_handoff_ms = Math.max(0, Date.now() - createdAt);
      }
    }
  }

  async function failAdmission(record, stage, error, startedAt = null) {
    record.phase = 'failed';
    record.error = cloneError(errorSummary(error, `admission_${stage}_failed`));
    record.telemetry.admission_failure_stage = stage;
    if (Number.isFinite(startedAt)) record.telemetry.admission_duration_ms = Math.max(0, Date.now() - startedAt);
    for (const lane of record.lanes) {
      if (lane.phase !== 'completed' && lane.phase !== 'cancelled') {
        lane.phase = 'failed_pre_prompt';
        lane.error = record.error;
      }
      await finishLane(record, lane);
    }
    bump(record);
    await persist(record);
    return receipt(record);
  }

  async function requestConsent(record, options = {}) {
    const signal = options?.signal;
    // Establish the pending state before entering a host callback. Native
    // form callbacks may wait for a user decision or outlive this MCP call;
    // the durable record must therefore expose the exact request first.
    record.consent_request = publicConsentRequest(record.compiled);
    record.consent_status = 'required';
    record.phase = 'awaiting_consent';
    record.error = null;
    bump(record);
    await persist(record);

    if (signal?.aborted) {
      record.consent_status = 'blocked';
      record.error = cloneError({ code: 'consent_request_aborted' });
      bump(record);
      await persist(record);
      return false;
    }

    let response;
    try {
      response = await injected.requestConsent(record.compiled, { signal });
    } catch (error) {
      const code = signal?.aborted
        ? 'consent_request_aborted'
        : consentErrorCode(error, 'consent_host_unavailable');
      record.consent_status = 'blocked';
      record.error = cloneError({ code });
      // A transport/host failure leaves the run reopenable. An abort is also
      // request scoped, so both retain the pending consent request.
      bump(record);
      await persist(record);
      return false;
    }

    // A callback can resolve with approval after its owning MCP request was
    // cancelled. Never cross the admission barrier after that cancellation.
    if (signal?.aborted) {
      record.consent_status = 'blocked';
      record.error = cloneError({ code: 'consent_request_aborted' });
      bump(record);
      await persist(record);
      return false;
    }

    if (isConsentApproved(response)) {
      record.consent_status = 'approved';
      record.consent_request = null;
      record.error = null;
      return true;
    }
    if (isConsentPending(response)) {
      record.consent_request = consentRequestValue(record.compiled, response?.request);
      record.consent_status = 'required';
      record.phase = 'awaiting_consent';
      const code = consentErrorCode(response, null);
      record.error = code === null ? null : cloneError({ code });
      bump(record);
      await persist(record);
      return false;
    }

    const code = consentErrorCode(response);
    record.consent_status = 'blocked';
    record.error = cloneError({ code });
    if (RETRYABLE_CONSENT_ERROR_CODES.includes(code)) {
      // Dismissal, timeout, and request-scoped abort leave the same run
      // reopenable. Preserve the blocked reason while retaining the pending
      // public request for an explicit native retry.
      record.phase = 'awaiting_consent';
      bump(record);
      await persist(record);
      return false;
    }
    // Explicit decline/host responses are terminal admission failures. Keep
    // their safe reason code on the authoritative receipt.
    await failAdmission(record, 'consent', { code });
    return false;
  }

  async function admit(record) {
    const started = Date.now();
    record.phase = 'preparing_workspaces';
    bump(record);
    await persist(record);
    let readiness;
    try {
      const providerChecks = await Promise.all(record.lanes.map(async (lane) => {
        const result = await injected.providerReady({
          run_id: record.run_id,
          assignment: record.compiled.assignments.find((assignment) => assignment.assignment_id === lane.assignment_id),
        });
        return result?.ready === true;
      }));
      // Cursor Cloud owns its remote process boundary. Requiring the local
      // systemd/cgroup boundary for an all-Cloud run incorrectly blocks a
      // valid dispatch on hosts where only the Cloud provider is available.
      // Mixed and local-only runs still fail closed on the local boundary.
      const needsLocalBoundary = record.lanes.some((lane) => lane.provider !== 'cursor-cloud');
      const boundary = needsLocalBoundary
        ? await injected.processBoundaryReady({ run_id: record.run_id })
        : { ready: true };
      const repository = await injected.verifyRepository({
        run_id: record.run_id,
        git: record.compiled.git,
        repository_identity: record.compiled.git_identity,
      });
      readiness = providerChecks.every(Boolean) && boundary?.ready === true && repository?.verified === true;
      if (!readiness) return failAdmission(record, 'readiness', { code: 'admission_not_ready' }, started);
    } catch (error) {
      return failAdmission(record, 'readiness', error, started);
    }
    const preparedAt = Date.now();
    const prepared = await Promise.all(record.lanes.map(async (lane) => {
      try {
        const assignment = record.compiled.assignments.find((entry) => entry.assignment_id === lane.assignment_id);
        const result = await injected.prepareWorkspace({
          run_id: record.run_id,
          assignment,
          git: record.compiled.git,
          managed_workspace_policy: record.compiled.managed_workspace_policy,
        });
        if (result?.prepared !== true) throw Object.assign(new Error('workspace not ready'), { code: 'workspace_not_ready' });
        return { lane, result };
      } catch (error) {
        return { lane, error };
      }
    }));
    record.telemetry.workspace_preparation_duration_ms = Date.now() - preparedAt;
    const failed = prepared.find((entry) => entry.error || entry.result?.prepared !== true);
    if (failed) {
      for (const entry of prepared) {
        if (!entry.error && entry.result?.workspace) {
          await injected.cleanupWorkspace({ run_id: record.run_id, assignment_id: entry.lane.assignment_id, workspace: entry.result.workspace }).catch(() => {});
        }
      }
      return failAdmission(record, 'workspace_preparation', failed.error ?? { code: 'workspace_not_ready' }, started);
    }
    for (const entry of prepared) {
      entry.lane.prepared = true;
      entry.lane.workspace = entry.result.workspace ?? null;
      entry.lane.phase = 'prepared';
    }
    record.admission = freezeData({
      status: 'admitted',
      stage: 'all_lanes_prepared',
      duration_ms: Date.now() - started,
      prompt_count_before_dispatch: 0,
    });
    record.telemetry.admission_duration_ms = Date.now() - started;
    bump(record);
    await persist(record);
    return dispatch(record);
  }

  async function dispatch(record) {
    record.phase = 'dispatching';
    const started = Date.now();
    bump(record);
    await persist(record);
    for (let index = 0; index < record.lanes.length; index += 1) {
      const lane = record.lanes[index];
      if (record.cancel_requested) {
        lane.phase = 'cancelled';
        lane.error = cloneError({ code: 'cancel_requested' });
        await finishLane(record, lane);
        continue;
      }
      const assignment = record.compiled.assignments[index];
      try {
        const session = await injected.createSession({
          run_id: record.run_id,
          assignment,
          lane,
          workspace: lane.workspace,
          git: record.compiled.git,
        });
        if (session?.ready !== true) throw Object.assign(new Error('provider session not ready'), { code: 'session_not_ready' });
        lane.session_ready = true;
        lane.session_id = typeof session.session_id === 'string' ? session.session_id : null;
        lane.phase = 'session_ready';
        if (record.telemetry.time_to_session_ms === null) {
          const createdAt = Date.parse(record.created_at);
          if (Number.isFinite(createdAt)) record.telemetry.time_to_session_ms = Math.max(0, Date.now() - createdAt);
        }
        bump(record);
        await persist(record);
        const result = await injected.dispatchPrompt({
          run_id: record.run_id,
          assignment,
          lane,
          workspace: lane.workspace,
          session,
          git: record.compiled.git,
          managed_workspace_policy: record.compiled.managed_workspace_policy,
          prompt: assignment.prompt,
          attempt: 1,
        });
        const confidence = result?.confidence === 'uncertain' || result?.dispatch_uncertain === true
          ? 'uncertain' : 'authoritative';
        if (result?.session_ready === true || typeof result?.session_id === 'string') {
          lane.session_ready = true;
          if (typeof result.session_id === 'string') lane.session_id = result.session_id;
        }
        let workspaceIdentityInvalid = false;
        if (result?.workspace_identity !== undefined) {
          try {
            lane.workspace_identity = validateWorkspaceIdentityV1(
              result.workspace_identity,
              `dispatch.${lane.assignment_id}.workspace_identity`,
            );
          } catch (error) {
            lane.workspace_identity = null;
            workspaceIdentityInvalid = true;
          }
        }
        if (workspaceIdentityInvalid) {
          const promptEvidence = result?.dispatched === true || result?.prompt_dispatched === true
            || result?.sent === true || confidence === 'uncertain';
          lane.prompt_attempted = promptEvidence;
          lane.prompt_dispatched = result?.dispatched === true || result?.prompt_dispatched === true;
          lane.dispatch_confidence = confidence;
          lane.phase = promptEvidence ? 'unrecoverable_post_prompt' : 'failed_pre_prompt';
          lane.recovery_classification = promptEvidence
            ? 'workspace_identity_invalid_no_replay'
            : 'workspace_identity_invalid_pre_prompt';
          lane.error = cloneError({ code: 'workspace_identity_invalid' });
          await finishLane(record, lane);
          record.phase = promptEvidence ? 'degraded' : (hasPromptEvidence(record) ? 'degraded' : 'failed');
          await persist(record);
          break;
        }
        if (result?.dispatched !== true && result?.prompt_dispatched !== true) {
          if (confidence === 'uncertain' || result?.sent === true) {
            const pending = result?.dispatch_pending === true && result?.terminal !== true;
            lane.prompt_attempted = true;
            lane.dispatch_confidence = 'uncertain';
            lane.phase = pending ? 'session_ready' : 'unrecoverable_post_prompt';
            lane.recovery_classification = result?.terminal === true
              ? 'terminal_dispatch_uncertain_no_replay'
              : pending ? 'dispatch_pending_no_replay' : 'dispatch_uncertain_no_replay';
            lane.error = pending ? null : terminalLaneError(result, 'dispatch_uncertain');
            if (!pending) await finishLane(record, lane);
            await persist(record);
            if (pending) continue;
            record.phase = 'degraded';
            break;
          }
          lane.phase = 'failed_pre_prompt';
          lane.error = cloneError({ code: 'prompt_dispatch_failed' });
          await finishLane(record, lane);
          record.phase = hasPromptEvidence(record) ? 'degraded' : 'failed';
          await persist(record);
          break;
        }
        if (confidence === 'uncertain') {
          // The provider may have accepted the prompt before its durable
          // acknowledgement became observable. Keep observing this same task;
          // never convert the bounded acknowledgement wait into a replay.
          const pending = result?.dispatch_pending === true && result?.terminal !== true;
          lane.prompt_attempted = true;
          lane.dispatch_confidence = 'uncertain';
          lane.phase = pending ? 'session_ready' : 'unrecoverable_post_prompt';
          lane.recovery_classification = result?.terminal === true
            ? 'terminal_dispatch_uncertain_no_replay'
            : pending ? 'dispatch_pending_no_replay' : 'dispatch_uncertain_no_replay';
          lane.error = pending ? null : terminalLaneError(result, 'dispatch_uncertain');
          if (!pending) await finishLane(record, lane);
          await persist(record);
          if (pending) continue;
          record.phase = 'degraded';
          break;
        }
        lane.prompt_attempted = true;
        lane.prompt_dispatched = true;
        lane.dispatch_confidence = confidence;
        lane.cursor = typeof result.cursor === 'string' ? result.cursor : '0';
        lane.phase = 'prompt_dispatched';
        lane.last_event = 'prompt_dispatched';
        if (record.telemetry.time_to_prompt_dispatch_ms === null) {
          const createdAt = Date.parse(record.created_at);
          if (Number.isFinite(createdAt)) record.telemetry.time_to_prompt_dispatch_ms = Math.max(0, Date.now() - createdAt);
        }
        bump(record);
        await persist(record);
      } catch (error) {
        const uncertain = error?.dispatch_uncertain === true || error?.sent === true || error?.code === 'dispatch_uncertain';
        if (uncertain) {
          lane.prompt_attempted = true;
          lane.dispatch_confidence = 'uncertain';
          lane.phase = 'unrecoverable_post_prompt';
          lane.recovery_classification = error?.terminal === true
            ? 'terminal_dispatch_uncertain_no_replay'
            : 'dispatch_uncertain_no_replay';
          lane.error = cloneError({ code: 'dispatch_uncertain' });
        } else {
          lane.phase = 'failed_pre_prompt';
          lane.error = cloneError(errorSummary(error, 'prompt_dispatch_failed'));
        }
        await finishLane(record, lane);
        record.phase = hasPromptEvidence(record) ? 'degraded' : 'failed';
        await persist(record);
        break;
      }
    }
    for (const lane of record.lanes) {
      if (lane.phase === 'prepared' || lane.phase === 'planned') {
        lane.phase = 'failed_pre_prompt';
        lane.error = cloneError({ code: 'dispatch_not_attempted' });
        await finishLane(record, lane);
      }
    }
    record.telemetry.dispatch_duration_ms = Date.now() - started;
    record.telemetry.dispatch_confidence = record.lanes.some((lane) => lane.dispatch_confidence === 'uncertain')
      ? 'uncertain'
      : authoritativeRequiredDispatch(record)
        ? 'authoritative'
        : record.lanes.some((lane) => lane.prompt_dispatched === true)
          ? 'partially_authoritative'
          : 'not_dispatched';
    const recovery = record.lanes.map((lane) => lane.recovery_classification).find(Boolean);
    if (recovery) record.telemetry.recovery_path = recovery;
    if (record.phase === 'dispatching') {
      record.phase = authoritativeRequiredDispatch(record)
        ? 'running'
        : record.lanes.some(laneHasPendingDispatchEvidence)
          ? 'dispatching'
          : (hasPromptEvidence(record) ? 'degraded' : 'failed');
    }
    bump(record);
    await persist(record);
    return receipt(record);
  }

  async function reconcile(record) {
    const before = JSON.stringify(record);
    // Inspection is a read operation and must always return the authoritative
    // snapshot, including durable terminal and consent-pending records. An
    // undefined result here makes waiters lose their cursor/phase and lets the
    // adapter manufacture an empty success receipt.
    if (isTerminalRun(record) || record.phase === 'awaiting_consent') return receipt(record);
    const active = record.lanes.filter(laneNeedsObservation);
    for (const lane of active) {
      try {
        const assignment = record.compiled.assignments.find((entry) => entry.assignment_id === lane.assignment_id);
        const response = await injected.inspectLane({
          run_id: record.run_id,
          assignment_id: lane.assignment_id,
          task_id: lane.task_id,
          assignment,
          lane,
        });
        const status = response?.status ?? response?.phase;
        if (!KNOWN_LANE_OBSERVATION_STATUSES.includes(status)) {
          throw Object.assign(new Error('Supervisor returned an invalid lane observation.'), {
            code: 'lane_observation_invalid',
          });
        }
        if (response?.task_id !== undefined && response.task_id !== lane.task_id) {
          throw Object.assign(new Error('Supervisor lane observation identity did not match the requested task.'), {
            code: 'lane_observation_identity_mismatch',
          });
        }
        const authoritativeDispatchEvidence = response?.dispatch_evidence === 'authoritative'
          && response?.prompt_dispatched === true;
        if (authoritativeDispatchEvidence && lane.prompt_dispatched !== true) {
          lane.prompt_attempted = true;
          lane.prompt_dispatched = true;
          lane.dispatch_confidence = 'authoritative';
          if (typeof response.session_id === 'string') lane.session_id = response.session_id;
          if (['dispatch_pending_no_replay', 'dispatch_uncertain_no_replay'].includes(lane.recovery_classification)) {
            lane.recovery_classification = null;
            if (lane.error?.code === 'dispatch_uncertain') lane.error = null;
          }
          if (lane.phase === 'session_ready' || lane.phase === 'unrecoverable_post_prompt') {
            lane.phase = 'prompt_dispatched';
          }
          if (record.telemetry.time_to_prompt_dispatch_ms === null) {
            const createdAt = Date.parse(record.created_at);
            if (Number.isFinite(createdAt)) record.telemetry.time_to_prompt_dispatch_ms = Math.max(0, Date.now() - createdAt);
          }
        }
        const previousLastEvent = lane.last_event;
        const recoveringObservation = lane.recovery_classification === OBSERVATION_RECOVERY_CLASSIFICATION;
        if (recoveringObservation && !['failed', 'timeout', 'environment_blocked'].includes(status)) {
          lane.phase = lane.phase === 'partial_handoff' ? 'running' : lane.phase;
          lane.recovery_classification = null;
          lane.error = null;
        }
        const eventChanged = typeof response?.last_event === 'string'
          && response.last_event !== previousLastEvent;
        if (typeof response?.cursor === 'string' && CURSOR_PATTERN.test(response.cursor)) lane.cursor = response.cursor;
        if (typeof response?.last_event === 'string' && eventChanged) {
          lane.last_event = response.last_event;
          if (record.telemetry.time_to_first_event_ms === null) {
            const createdAt = Date.parse(record.created_at);
            if (Number.isFinite(createdAt)) record.telemetry.time_to_first_event_ms = Math.max(0, Date.now() - createdAt);
          }
          record.telemetry.last_meaningful_activity_at = nowIso(injected.clock);
        }
        if (Number.isSafeInteger(response?.silence_duration_ms) && response.silence_duration_ms >= 0
          && (eventChanged || status === 'needs_attention'
            || ['completed', 'succeeded', 'cancelled', 'failed', 'timeout'].includes(status))) {
          record.telemetry.silence_duration_ms = response.silence_duration_ms;
        }
        const result = observedResult(response);
        if (result.present) {
          const bounded = boundProviderResult(result.value, MAX_PROVIDER_RESULT_BYTES);
          lane.result = bounded.value;
          lane.result_truncated = bounded.truncated;
          record.telemetry.response_truncated = record.telemetry.response_truncated || bounded.truncated;
        }
        if (status === 'needs_attention') {
          const attention = normalizeAttention(response.attention);
          if (!attention || attention.invalid === true) {
            lane.phase = 'partial_handoff';
            lane.recovery_classification = 'attention_evidence_invalid_no_replay';
            lane.error = cloneError({ code: 'attention_evidence_invalid' });
            await finishLane(record, lane, response.workspace_inspection ?? null);
            record.phase = 'degraded';
            continue;
          }
          const key = capabilityQuestionKey(attention);
          const dedupKey = attentionDedupKey(attention);
          const targetKey = JSON.stringify(attentionTarget(lane, attention));
          const alreadyOpen = record.attention?.status === 'open'
            && record.attention_questions.some((entry) => entry.attention_key === dedupKey
              && entry.targets?.some((target) => JSON.stringify(target) === targetKey));
          if (alreadyOpen) {
            lane.phase = 'needs_attention';
            continue;
          }
          if (attentionWasSatisfied(lane, key)) {
            lane.phase = 'running';
            continue;
          }
          record.telemetry.attention_count += 1;
          if (dedupKey && record.attention_questions.some((entry) => entry.attention_key === dedupKey)) {
            record.telemetry.attention_deduplicated_count += 1;
          }
          if (isCapabilityCovered(assignment, attention)) {
            if (attentionWasSatisfied(lane, key)) {
              lane.phase = 'running';
              continue;
            }
            let delivered = null;
            try {
              delivered = await injected.replyAttention({
                run_id: record.run_id,
                task_id: lane.task_id,
                assignment,
                lane,
                attention,
                capability_satisfied: true,
                reply: {
                  session_id: attention.session_id ?? lane.session_id,
                  question_id: attention.question_id,
                  response: {
                    outcome: 'allow_once',
                    capability: attention.capability,
                    resource: attention.resource,
                    action: attention.action,
                  },
                },
              });
            } catch {
              delivered = null;
            }
            if (delivered?.delivered !== false) {
              lane.attention_satisfied_keys = [...new Set([
                ...(lane.attention_satisfied_keys ?? []), key,
              ])].slice(-8);
              lane.phase = 'running';
              lane.last_event = 'capability_satisfied';
              lane.recovery_classification = 'capability_pre_authorized';
              continue;
            }
          }
          lane.phase = 'needs_attention';
          record.phase = 'needs_attention';
          record.attention = mergeAttention(record, lane, assignment, attention);
        } else if (status === 'completed' || status === 'succeeded') {
          if (lane.prompt_dispatched === true && lane.dispatch_confidence === 'authoritative') {
            lane.phase = 'completed';
          } else {
            lane.phase = 'unrecoverable_post_prompt';
            lane.recovery_classification = 'terminal_dispatch_uncertain_no_replay';
            lane.error = cloneError({ code: 'dispatch_uncertain' });
          }
          await finishLane(record, lane, response.workspace_inspection ?? null);
        } else if (status === 'cancelled') {
          lane.phase = 'cancelled';
          lane.cancel_confirmed = true;
          lane.error = null;
          lane.recovery_classification = null;
          await finishLane(record, lane, response.workspace_inspection ?? null);
        } else if (status === 'transport_lost') {
          let reconnected = null;
          try {
            reconnected = await injected.reconnectLane({
              run_id: record.run_id,
              assignment_id: lane.assignment_id,
              task_id: lane.task_id,
              assignment,
              lane,
              response,
            });
          } catch {
            reconnected = null;
          }
          if (reconnected?.reconnected === true) {
            lane.phase = 'running';
            lane.recovery_classification = 'post_prompt_session_reconnected';
            lane.error = null;
            if (typeof reconnected.session_id === 'string') lane.session_id = reconnected.session_id;
            if (typeof reconnected.cursor === 'string' && CURSOR_PATTERN.test(reconnected.cursor)) lane.cursor = reconnected.cursor;
            lane.last_event = 'session_reconnected';
            record.telemetry.recovery_path = 'post_prompt_session_reconnected';
          } else {
            lane.phase = 'running';
            lane.recovery_classification = 'post_prompt_session_reconnect_required';
            lane.error = cloneError({ code: 'transport_lost' });
            record.telemetry.recovery_path = 'post_prompt_session_reconnect_required';
          }
        } else if (status === 'environment_blocked') {
          if (laneHasPendingDispatchEvidence(lane)) {
            lane.phase = 'unrecoverable_post_prompt';
            lane.recovery_classification = 'terminal_dispatch_uncertain_no_replay';
            lane.error = terminalLaneError(response, 'environment_blocked');
            await finishLane(record, lane, response.workspace_inspection ?? null);
            continue;
          }
          lane.phase = lane.prompt_dispatched ? 'partial_handoff' : 'failed_pre_prompt';
          lane.recovery_classification = 'post_prompt_environment_blocked_no_replay';
          lane.error = cloneError({ code: 'environment_blocked' });
          await finishLane(record, lane, response.workspace_inspection ?? null);
        } else if (status === 'failed' || status === 'timeout' || status === 'timed_out') {
          if (laneHasPendingDispatchEvidence(lane)) {
            lane.phase = 'unrecoverable_post_prompt';
            lane.recovery_classification = 'terminal_dispatch_uncertain_no_replay';
            lane.error = terminalLaneError(response, status === 'timed_out' ? 'timeout' : status);
            await finishLane(record, lane, response.workspace_inspection ?? null);
            continue;
          }
          lane.phase = lane.prompt_dispatched ? 'partial_handoff' : 'failed_pre_prompt';
          lane.recovery_classification = 'post_prompt_failure_no_replay';
          lane.error = terminalLaneError(response, status === 'timed_out' ? 'timeout' : status);
          record.telemetry.recovery_path = 'post_prompt_failure_no_replay';
          await finishLane(record, lane, response.workspace_inspection ?? null);
        } else if (lane.phase === 'prompt_dispatched') {
          lane.phase = 'running';
        }
      } catch (error) {
        // A failed read is not proof that the provider stopped. Keep the
        // canonical task ID and retry on a later inspect/wait/cancel request.
        if (!isTerminalLane(lane) || lane.recovery_classification === OBSERVATION_RECOVERY_CLASSIFICATION) {
          if (lane.recovery_classification === OBSERVATION_RECOVERY_CLASSIFICATION) {
            // A legacy partial handoff is only terminal because its old
            // inspection failed. Make it active again before retrying.
            lane.phase = 'running';
          } else {
            lane.phase = lane.phase === 'prompt_dispatched' ? 'running' : lane.phase;
          }
          lane.recovery_classification = OBSERVATION_RECOVERY_CLASSIFICATION;
          lane.error = cloneError(errorSummary(error, 'lane_observation_unavailable'));
        }
      }
    }
    record.telemetry.dispatch_confidence = record.lanes.some(laneHasPendingDispatchEvidence)
      ? 'uncertain'
      : authoritativeRequiredDispatch(record)
        ? 'authoritative'
        : record.lanes.some((lane) => lane.prompt_dispatched === true)
          ? 'partially_authoritative'
          : 'not_dispatched';
    if (record.cancel_requested && record.lanes.every((lane) => lane.phase === 'cancelled' || isTerminalLane(lane))) {
      record.phase = 'cancelled';
      record.telemetry.cancel_confirmed = record.lanes.every((lane) => lane.phase === 'cancelled' || lane.phase === 'completed');
    } else if (record.lanes.some((lane) => lane.phase === 'needs_attention')) {
      record.phase = 'needs_attention';
    } else if (record.lanes.some((lane) => lane.phase === 'partial_handoff' || lane.phase === 'unrecoverable_post_prompt'
      || (laneNeedsObservation(lane) && lane.error !== null))) {
      record.phase = 'degraded';
    } else if (allLanesTerminal(record)) {
      record.phase = 'verifying';
      try {
        const verification = await injected.verifyRun({ run_id: record.run_id, compiled: record.compiled, lanes: record.lanes });
        record.phase = verification?.verified === true
          && authoritativeRequiredDispatch(record)
          && record.lanes.filter((lane) => lane.required !== false).every((lane) => lane.phase === 'completed')
          ? 'completed' : 'failed';
        if (record.phase === 'failed') record.error = cloneError({ code: 'verification_failed' });
      } catch (error) {
        record.phase = 'failed';
        record.error = cloneError(errorSummary(error, 'verification_failed'));
      }
    } else if (authoritativeRequiredDispatch(record)) {
      record.phase = 'running';
    } else if (record.lanes.some(laneHasPendingDispatchEvidence)) {
      record.phase = 'dispatching';
    }
    const after = JSON.stringify(record);
    if (after !== before) {
      bump(record);
      await persist(record);
    }
    return receipt(record);
  }

  async function submitRunRequest(request, options = {}) {
    const compiled = await injected.compile(request, options.compile_options ?? {});
    const { runId } = validateCompiled(compiled);
    return enqueue(runId, async () => {
      const existing = await loadRecord(runId);
      if (existing) {
        if (existing.compiled.request_idempotency_key !== compiled.request_idempotency_key) {
          admissionError('run_identity_conflict', 'run_request.run_id', 'run_id is already bound to a different semantic request.');
        }
        return receipt(existing, { idempotent: true });
      }
      const record = makeRecord(compiled);
      records.set(runId, record);
      bump(record);
      await persist(record);
      const consented = await requestConsent(record, options);
      await persist(record);
      if (!consented) return receipt(record);
      return admit(record);
    });
  }

  async function inspectRun(request) {
    const parsed = ownObject(request, 'request');
    assertKeys(parsed, ['run_id'], 'request');
    const runId = requiredString(parsed, 'run_id', 'run_id', (value) => RUN_ID_PATTERN.test(value));
    const record = await loadRecord(runId);
    if (!record) admissionError('run_not_found', 'run_id', 'The requested run is not known to this server.');
    // A native consent callback may keep submitRunRequest queued while the
    // durable record is already awaiting a decision. Read snapshots directly
    // so status/wait remain usable during that host interaction.
    if (isTerminalRun(record) || record.phase === 'awaiting_consent') return receipt(record);
    return enqueue(runId, async () => reconcile(record));
  }

  async function resumeRun(request) {
    const parsed = ownObject(request, 'request');
    assertKeys(parsed, ['run_id'], 'request');
    const runId = requiredString(parsed, 'run_id', 'run_id', (value) => RUN_ID_PATTERN.test(value));
    const record = await loadRecord(runId);
    if (!record) admissionError('run_not_found', 'run_id', 'The requested run is not known to this server.');
    return enqueue(runId, async () => {
      if (record.cancel_requested || record.phase === 'cancelled') return receipt(record);
      if (record.phase === 'awaiting_consent') return receipt(record);
      return reconcile(record);
    });
  }

  async function replyRun(request, options = {}) {
    const parsed = ownObject(request, 'request');
    assertKeys(parsed, ['run_id', 'approval_ref', 'attention_reply', 'request_consent'], 'request');
    const runId = requiredString(parsed, 'run_id', 'run_id', (value) => RUN_ID_PATTERN.test(value));
    const record = await loadRecord(runId);
    if (!record) admissionError('run_not_found', 'run_id', 'The requested run is not known to this server.');
    return enqueue(runId, async () => {
      const requestConsentAgain = capturedHasOwn(parsed, 'request_consent');
      if (requestConsentAgain && parsed.request_consent !== true) {
        admissionError('invalid_format', 'request_consent', 'A consent continuation must be exactly true.');
      }
      if (requestConsentAgain && (capturedHasOwn(parsed, 'approval_ref')
        || capturedHasOwn(parsed, 'attention_reply'))) {
        admissionError('mixed_run_operation', 'request', 'Consent continuation cannot be combined with another reply.');
      }
      if (record.cancel_requested || record.phase === 'cancelled') return receipt(record);
      const approvalRef = optionalString(parsed, 'approval_ref', 'approval_ref');
      if (record.phase === 'awaiting_consent') {
        if (requestConsentAgain) {
          const consented = await requestConsent(record, options);
          if (!consented) return receipt(record);
          return admit(record);
        }
        if (!approvalRef) {
          record.error = cloneError({ code: 'approval_ref_required' });
          bump(record);
          await persist(record);
          return receipt(record);
        }
        let verified;
        try {
          verified = serializeConsentResponse(await injected.verifyConsent({
            approval_ref: approvalRef,
            binding: record.consent_binding,
          }));
        } catch {
          verified = { approved: false };
        }
        if (!validConsentWindow(verified, injected.clock)) {
          record.error = cloneError({ code: 'approval_ref_invalid_or_expired' });
          bump(record);
          await persist(record);
          return receipt(record);
        }
        record.consent_status = 'approved';
        record.consent_request = null;
        record.consent_binding = freezeData({
          ...record.consent_binding,
          approved_at: verified.approved_at,
          expires_at: verified.expires_at,
        });
        record.error = null;
        return admit(record);
      }
      if (requestConsentAgain) return receipt(record);
      if (capturedHasOwn(parsed, 'attention_reply')) {
        let delivered = false;
        try {
          const response = await injected.replyAttention({
            run_id: runId,
            reply: parsed.attention_reply,
            attention: record.attention,
          });
          delivered = response?.delivered !== false;
        } catch (error) {
          record.error = cloneError(errorSummary(error, 'attention_reply_failed'));
        }
        if (delivered) {
          record.attention = null;
          for (const lane of record.lanes) {
            if (lane.phase === 'needs_attention') {
              lane.phase = 'running';
              lane.last_event = 'attention_reply_dispatched';
            }
          }
        }
        await persist(record);
        return reconcile(record);
      }
      return reconcile(record);
    });
  }

  async function cancelRun(request) {
    const parsed = ownObject(request, 'request');
    assertKeys(parsed, ['run_id'], 'request');
    const runId = requiredString(parsed, 'run_id', 'run_id', (value) => RUN_ID_PATTERN.test(value));
    const record = await loadRecord(runId);
    if (!record) admissionError('run_not_found', 'run_id', 'The requested run is not known to this server.');
    return enqueue(runId, async () => {
      if (isTerminalRun(record)) return receipt(record, { already_terminal: true, cancel_requested: record.cancel_requested });
      record.cancel_requested = true;
      record.telemetry.cancel_attempts += 1;
      await persist(record);
      const noPromptHasBeenAttempted = record.lanes.every((lane) => lane.prompt_attempted !== true);
      if (record.phase === 'awaiting_consent' || noPromptHasBeenAttempted) {
        for (const lane of record.lanes) {
          if (isTerminalLane(lane) && lane.recovery_classification !== OBSERVATION_RECOVERY_CLASSIFICATION) continue;
          lane.phase = 'cancelled';
          lane.cancel_confirmed = true;
          lane.error = cloneError({ code: 'cancel_requested' });
          await finishLane(record, lane);
        }
        record.telemetry.cancel_confirmed = true;
        record.phase = 'cancelled';
        bump(record);
        await persist(record);
        return receipt(record);
      }
      for (const lane of record.lanes) {
        if (isTerminalLane(lane) && lane.recovery_classification !== OBSERVATION_RECOVERY_CLASSIFICATION) continue;
        try {
          const result = await injected.cancelLane({
            run_id: runId,
            assignment_id: lane.assignment_id,
            task_id: lane.task_id,
            lane,
          });
          if (result?.confirmed === true || result?.cancelled === true) {
            lane.phase = 'cancelled';
            lane.cancel_confirmed = true;
            lane.error = null;
          } else {
            lane.phase = lane.prompt_attempted ? 'running' : 'failed_pre_prompt';
            lane.recovery_classification = 'cancel_unconfirmed';
            lane.cancel_confirmed = false;
            lane.error = cloneError({ code: 'cancel_unconfirmed' });
          }
        } catch (error) {
          lane.phase = lane.prompt_attempted ? 'running' : 'failed_pre_prompt';
          lane.recovery_classification = 'cancel_unconfirmed';
          lane.cancel_confirmed = false;
          lane.error = cloneError(errorSummary(error, 'cancel_unconfirmed'));
        }
        await finishLane(record, lane);
      }
      record.telemetry.cancel_confirmed = record.lanes.every((lane) => lane.phase === 'cancelled' || lane.phase === 'completed');
      record.phase = record.telemetry.cancel_confirmed ? 'cancelled' : 'degraded';
      bump(record);
      await persist(record);
      return receipt(record);
    });
  }

  async function waitRun(request, options = {}) {
    const parsed = ownObject(request, 'request');
    assertKeys(parsed, ['run_id', 'wait_until', 'wait_ms', 'cursor'], 'request');
    const runId = requiredString(parsed, 'run_id', 'run_id', (value) => RUN_ID_PATTERN.test(value));
    const waitUntil = parsed.wait_until ?? 'decision_or_attention';
    const waitMs = parsed.wait_ms ?? MAX_WAIT_MS;
    if (!['progress', 'terminal', 'decision_or_attention'].includes(waitUntil)) admissionError('invalid_format', 'wait_until');
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) admissionError('invalid_format', 'wait_ms');
    const started = Date.now();
    let current = await inspectRun({ run_id: runId });
    const initialCursor = parsed.cursor ?? current.cursor;
    const actionable = (value) => RUN_TERMINAL_PHASES.includes(value.phase)
      || (waitUntil !== 'progress' && RUN_ATTENTION_PHASES.includes(value.phase))
      || (waitUntil === 'progress' && value.cursor !== initialCursor);
    if (actionable(current) || waitMs === 0) return freezeData({ ...current, wait_until: waitUntil, waited_ms: 0 });
    while (Date.now() - started < waitMs) {
      if (options.signal?.aborted) break;
      const remaining = Math.max(0, waitMs - (Date.now() - started));
      const taskLanes = current.lanes.filter(laneNeedsObservation);
      const taskIds = taskLanes.map((lane) => lane.task_id);
      const cursors = Object.fromEntries(taskLanes
        .filter((lane) => typeof lane.cursor === 'string' && CURSOR_PATTERN.test(lane.cursor))
        .map((lane) => [lane.task_id, lane.cursor]));
      try {
        await injected.waitForProgress({
          run_id: runId,
          task_ids: taskIds,
          cursors,
          wait_ms: remaining,
          wait_until: waitUntil === 'terminal' ? 'terminal' : 'progress',
          signal: options.signal,
        });
      } catch {
        // A wait provider failure is an observation uncertainty, so use a
        // bounded backoff before retrying the authoritative read.
        await injected.sleep(Math.min(250, remaining), options.signal);
      }
      if (options.signal?.aborted) break;
      const previousCursor = current.cursor;
      current = await inspectRun({ run_id: runId });
      if (actionable(current)) break;
      // Task-store waits can wake immediately for a terminal task whose
      // cleanup boundary is still unfinal, or for a temporarily missing task.
      // If admission made no progress, avoid turning that wake into a hot loop.
      const remainingAfterWait = Math.max(0, waitMs - (Date.now() - started));
      if (remainingAfterWait > 0 && current.cursor === previousCursor) {
        await injected.sleep(Math.min(OBSERVATION_BACKOFF_MS, remainingAfterWait), options.signal);
      }
    }
    return freezeData({ ...current, wait_until: waitUntil, waited_ms: Date.now() - started });
  }

  return capturedFreeze({
    submitRunRequest,
    inspectRun,
    resumeRun,
    replyRun,
    cancelRun,
    waitRun,
    hasRun: (runId) => records.has(runId),
    hasRunAsync: async (runId) => (await loadRecord(runId)) !== null,
    records,
  });
}
