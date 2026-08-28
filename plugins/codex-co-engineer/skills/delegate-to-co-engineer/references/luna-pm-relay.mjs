// Skill-owned Luna Max PM TaskPort policy. Codex is the host executor
// that calls create_thread, send_message_to_thread, wait_threads or
// read_thread, set_thread_archived, and set_thread_pinned. The JS adapter
// in mcp/v3/luna-pm-host-adapter.mjs is a deterministic request/validation
// layer; it does not invoke host callbacks or simulate the Desktop host.
// Co-Engineer MCP does not import or run this file, cannot invoke
// host-only thread tools, and must not grow a sixth tool for that host.
// The Co-Engineer event store remains source of truth: one meaningful
// event becomes one bounded envelope; routine progress does not wake a
// model. This skill guarantees policy. It does not itself create Desktop
// threads.

import { createHash } from 'node:crypto';

import { classifyGitOperationV1 } from '../../../mcp/v3/git-authority.mjs';
import {
  FICTIONAL_HOST_ALIASES,
  HOST_TASK_EXECUTOR,
  HOST_TASK_OPTIONAL_TOOLS,
  HOST_TASK_REQUIRED_TOOLS,
  HOST_TASK_SEQUENCE,
  HOST_TASK_TOOL_ACTIONS,
  HOST_TASK_WAIT_TOOLS,
  LIVE_HOST_CALL_SCHEMAS,
  LIVE_WAIT_THREADS_TARGET_SCHEMA,
  bindCreateThreadResult,
  detectHostTaskTools as detectHostAdapterTools,
  denyMessageGitOverride,
  hostApiGap,
  materializeBoundCalls,
  planCreateThread,
  planMessageAndWait,
  planSetThreadPinned,
  planSolMergeReady,
} from '../../../mcp/v3/luna-pm-host-adapter.mjs';

export {
  FICTIONAL_HOST_ALIASES,
  HOST_TASK_EXECUTOR,
  HOST_TASK_OPTIONAL_TOOLS,
  HOST_TASK_REQUIRED_TOOLS,
  HOST_TASK_SEQUENCE,
  HOST_TASK_TOOL_ACTIONS,
  HOST_TASK_WAIT_TOOLS,
  LIVE_HOST_CALL_SCHEMAS,
  LIVE_WAIT_THREADS_TARGET_SCHEMA,
  materializeBoundCalls,
};

export const LUNA_PM_SCHEMA = 'codex-co-engineer.taskport.v1';
export const LUNA_PM_MESSAGE_SCHEMA = 'codex-co-engineer.taskport-envelope.v1';
export const LUNA_PM_VERSION = 1;

export const DEFAULT_PM_MODEL = 'luna-max';
export const SOL_ADJUDICATOR_MODELS = Object.freeze(['sol-high', 'sol-xhigh']);
export const FORBIDDEN_DEFAULT_PM_MODELS = Object.freeze([
  'sol-medium',
  'sol-high',
  'sol-xhigh',
]);

export const ENVELOPE_KINDS = Object.freeze([
  'completed', 'blocked', 'failed', 'question', 'timeout', 'user_update',
  'merge_ready', 'progress',
]);
export const COMPACT_EVENT_TYPES = ENVELOPE_KINDS;
export const WAKING_KINDS = Object.freeze([
  'completed', 'blocked', 'failed', 'question', 'timeout', 'user_update',
  'merge_ready',
]);
export const ROUTINE_PROGRESS_KIND = 'progress';

export const SOL_ESCALATION_CRITERIA = Object.freeze([
  'conflicting_exact_evidence_or_reviewer_verdicts',
  'security_or_protected_ref_risk',
  'composition_ambiguity',
  'repeated_deterministic_rejection',
  'release_authority_decision',
  'explicit_user_escalation',
]);

export const LANE_CEILING = 8;
export const LUNA_NATIVE_SUBAGENT_MAX_DEPTH = 2;
export const LUNA_NATIVE_SUBAGENT_ROLE = 'local_analysis';
export const LUNA_NATIVE_SUBAGENT_ACCESS = 'read_only';
export const EVIDENCE_REF_MAX = 8;
export const EVIDENCE_PATH_MAX_BYTES = 256;
export const RELAY_MESSAGE_MAX_BYTES = 4_096;
export const EVENT_SUMMARY_MAX_BYTES = 1_024;
export const BODY_SPILL_MAX_BYTES = 512;
export const RECENT_ID_WINDOW = 16;
export const COORDINATION = Object.freeze({
  submissions: 1,
  aggregate_wait: 'decision_or_attention',
  aggregate_wait_count: 1,
  verified_final_decisions: 1,
  merge_actor: 'sol',
  publisher: 'publisher',
  luna_merges: false,
});

export const USER_REPORTS = Object.freeze({
  luna_pinned: 'Luna Max is the project manager for this Co-Engineer run.',
  degraded_inline: 'Luna Max project-manager messaging is unavailable, so I am continuing in this Codex task.',
  no_sol_substitute: 'I am not substituting Sol',
  completed_no_sol: 'Normal completion does not wake Sol.',
  unauthorized_sol: 'Sol is not authorized for this event.',
  merge_ready_sol: 'A publication-ready packet may wake Sol High or Sol XHigh once.',
});

const RUN_ID = /^[a-z][a-z0-9-]{2,63}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR = /^[0-9]{1,16}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const SECRET_KEY = /(?:secret|token|password|credential|transcript|stdout|stderr|prompt|raw|bytes|api[_-]?key)/iu;
const SECRET_VALUE = /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu;
const ASSIGNMENT_STATES = new Set(['running', 'blocked', 'failed', 'complete', 'cancelled', 'timeout']);
const ENVELOPE_KEYS = Object.freeze([
  'schema', 'message_id', 'run_id', 'assignment_id', 'attempt_id',
  'from_task_id', 'to_task_id', 'parent_message_id', 'reply_to',
  'correlation_id', 'kind', 'generation', 'event_cursor', 'created_at',
  'payload_digest', 'event_summary', 'artifact_ref',
]);
const QUESTION_IDENTITY_KEYS = Object.freeze([
  'task_id', 'assignment_id', 'attempt', 'generation', 'session_id',
  'question_id', 'provider', 'correlation_id', 'question_digest',
]);
const STRUCTURED_ANSWER_KEYS = Object.freeze([
  'assignment_id', 'question_id', 'response', 'session_id', 'task_id',
]);
const STRUCTURED_RESPONSE_KEYS = Object.freeze(['answers', ...STRUCTURED_ANSWER_KEYS]);
const MERGE_READY_REQUIRED = Object.freeze([
  'candidate_head', 'candidate_tree', 'expected_head', 'current_head',
  'current_tree', 'ci_green', 'ci_current', 'failed_check_count',
  'hidden_failed_checks', 'verifier_accepted', 'merge_topology_ok',
]);

function freeze(value) {
  if (value !== null && typeof value === 'object') Object.freeze(value);
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function requireExact(pattern, value, code) {
  if (typeof value !== 'string' || !pattern.test(value)) return code;
  return null;
}

function result(fields) {
  return freeze({
    schema: LUNA_PM_SCHEMA,
    version: LUNA_PM_VERSION,
    ok: fields.ok === true,
    action: fields.action,
    code: fields.code ?? null,
    mode: fields.mode,
    pm: fields.pm ?? null,
    sol: fields.sol ?? null,
    wake_luna: fields.wake_luna === true,
    wake_sol: fields.wake_sol === true,
    host_calls: Object.freeze([...(fields.host_calls ?? [])].map(freeze)),
    message: fields.message ? freeze(fields.message) : null,
    native_subagents: Object.freeze([...(fields.native_subagents ?? [])].map(freeze)),
    host_api_gap: fields.host_api_gap ? freeze(fields.host_api_gap) : null,
    user_report: fields.user_report ?? null,
    session: fields.session ? freeze(fields.session) : null,
    preserved: fields.preserved ? freeze(fields.preserved) : null,
    resume_needed: fields.resume_needed === true,
    structured_response: fields.structured_response ? freeze(fields.structured_response) : null,
  });
}

function snapshotSession(session) {
  if (!plainObject(session)) return null;
  return freeze({
    mode: session.mode,
    pm: session.pm,
    model: session.model ?? null,
    thread_id: session.thread_id ?? null,
    host_id: session.host_id ?? null,
    thread_binding: session.thread_binding ?? null,
    queued_thread: session.queued_thread === true,
    client_thread_id: session.client_thread_id ?? null,
    host_bound: session.host_bound === true,
    run_id: session.run_id ?? null,
    pm_task_id: session.pm_task_id ?? null,
    last_cursor: session.last_cursor ?? null,
    generation: session.generation ?? '0',
    attempt_id: session.attempt_id ?? '0',
    recent_ids: Object.freeze([...(session.recent_ids ?? [])].slice(-RECENT_ID_WINDOW)),
    recent_digest: session.recent_digest ?? sha256('[]'),
    luna_authorized: session.luna_authorized === true,
    luna_available: session.luna_available === true,
    host_api_gap: session.host_api_gap ?? null,
    wait_tool: session.wait_tool ?? null,
    optional_tools: Object.freeze([...(session.optional_tools ?? [])]),
    native_subagents: Object.freeze([...(session.native_subagents ?? [])]),
    sol_merge_ready_sent: session.sol_merge_ready_sent === true,
    preserved: session.preserved ?? null,
  });
}

function denied(session, code, action, extras = {}) {
  return result({
    ok: false,
    action,
    code,
    mode: extras.mode ?? session?.mode ?? 'degraded_inline',
    pm: extras.pm ?? session?.pm ?? 'current_codex_task',
    sol: extras.sol ?? null,
    wake_luna: false,
    wake_sol: false,
    host_calls: extras.host_calls ?? [],
    message: extras.message ?? null,
    native_subagents: extras.native_subagents ?? session?.native_subagents ?? [],
    host_api_gap: extras.host_api_gap ?? session?.host_api_gap ?? null,
    user_report: extras.user_report ?? null,
    session: extras.session ?? snapshotSession(session),
    preserved: extras.preserved ?? session?.preserved ?? null,
    resume_needed: extras.resume_needed === true,
    structured_response: extras.structured_response ?? null,
  });
}

export function detectHostTaskTools(available) {
  return detectHostAdapterTools(available);
}

export function isEnvelopeKind(value) {
  return ENVELOPE_KINDS.includes(value);
}

export function isSolEscalationCriterion(value) {
  return SOL_ESCALATION_CRITERIA.includes(value);
}

function preserveUserChoices(input) {
  const source = plainObject(input) ? input : {};
  return freeze({
    user_model_override: typeof source.user_model_override === 'string' ? source.user_model_override : null,
    provider_selection: source.provider_selection == null
      ? null
      : JSON.parse(JSON.stringify(source.provider_selection)),
    merge_actor: 'sol',
    publisher: 'publisher',
    user_authorized_publication: source.user_authorized_publication === true,
    automatic_merge: false,
    learned_routing: false,
    semantic_memory: false,
    submissions: 1,
    aggregate_wait: 'decision_or_attention',
  });
}

export function sanitizeEvidenceRefs(refs) {
  if (refs == null) return Object.freeze([]);
  if (!Array.isArray(refs)) {
    return Object.freeze([{ denied: true, code: 'secret_or_transcript_evidence' }]);
  }
  const cleaned = [];
  for (const ref of refs.slice(0, EVIDENCE_REF_MAX)) {
    if (!plainObject(ref)) continue;
    if (ref.artifact_class === 'raw' || ref.class === 'raw') {
      return Object.freeze([{ denied: true, code: 'secret_or_transcript_evidence' }]);
    }
    for (const [key, value] of Object.entries(ref)) {
      if (SECRET_KEY.test(key)) {
        return Object.freeze([{ denied: true, code: 'secret_or_transcript_evidence' }]);
      }
      if (typeof value === 'string' && SECRET_VALUE.test(value)) {
        return Object.freeze([{ denied: true, code: 'secret_or_transcript_evidence' }]);
      }
    }
    if (typeof ref.relative_path === 'string' && utf8Bytes(ref.relative_path) > EVIDENCE_PATH_MAX_BYTES) {
      continue;
    }
    const digest = typeof ref.sha256 === 'string' ? ref.sha256 : (typeof ref.digest === 'string' ? ref.digest : null);
    if (digest && !DIGEST.test(digest) && !SHA.test(digest)) continue;
    cleaned.push(freeze({
      kind: typeof ref.kind === 'string' ? ref.kind : 'sanitized_ref',
      artifact_class: 'sanitized',
      relative_path: typeof ref.relative_path === 'string' ? ref.relative_path : null,
      sha256: digest,
      byte_length: Number.isInteger(ref.byte_length) ? ref.byte_length : null,
    }));
  }
  return Object.freeze(cleaned);
}

function writerOverlap(left, right) {
  const a = String(left);
  const b = String(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function widenAttempt(item) {
  return item.writer === true
    || item.merge === true
    || item.git_write === true
    || item.filesystem_write === true
    || (item.access != null && item.access !== LUNA_NATIVE_SUBAGENT_ACCESS)
    || (item.role != null && item.role !== LUNA_NATIVE_SUBAGENT_ROLE)
    || (Array.isArray(item.providers) && item.providers.length > 0);
}

export function planLunaNativeSubagents(proposed, externalWriters, extras = {}) {
  const writers = Array.isArray(externalWriters) ? externalWriters : [];
  const requested = Array.isArray(proposed) ? proposed : [];
  const parentDepth = Number.isInteger(extras.parent_depth) ? extras.parent_depth : 1;
  const laneCount = Number.isInteger(extras.external_lane_count)
    ? extras.external_lane_count
    : writers.length;
  if (parentDepth >= LUNA_NATIVE_SUBAGENT_MAX_DEPTH) {
    return freeze({ ok: false, code: 'native_subagent_depth', subagents: Object.freeze([]) });
  }
  const budget = LANE_CEILING - laneCount;
  if (budget < 0 || requested.length > budget) {
    return freeze({ ok: false, code: 'native_subagent_bound', subagents: Object.freeze([]) });
  }
  const accepted = [];
  for (const item of requested) {
    if (!plainObject(item) || widenAttempt(item)) {
      return freeze({ ok: false, code: 'duplicate_writer_assignment', subagents: Object.freeze([]) });
    }
    const scopes = Array.isArray(item.write_scope) ? item.write_scope : (item.scope ? [item.scope] : []);
    for (const scope of scopes) {
      for (const writer of writers) {
        const writerScopes = Array.isArray(writer) ? writer : [writer];
        if (writerScopes.some((path) => writerOverlap(scope, path))) {
          return freeze({ ok: false, code: 'duplicate_writer_assignment', subagents: Object.freeze([]) });
        }
      }
    }
    accepted.push(freeze({
      id: typeof item.id === 'string' ? item.id : `luna-analysis-${accepted.length + 1}`,
      role: LUNA_NATIVE_SUBAGENT_ROLE,
      access: LUNA_NATIVE_SUBAGENT_ACCESS,
      depth: parentDepth + 1,
      inherited: true,
      scope: Object.freeze(scopes.map(String)),
    }));
  }
  return freeze({ ok: true, code: null, subagents: Object.freeze(accepted) });
}

function compactAssignmentState(source) {
  if (!plainObject(source)) return null;
  const state = typeof source.state === 'string' && ASSIGNMENT_STATES.has(source.state)
    ? source.state
    : null;
  if (state == null && source.assignment_id == null) return null;
  return freeze({
    assignment_id: typeof source.assignment_id === 'string' ? source.assignment_id : null,
    state,
  });
}

function compactQuestionIdentity(summary, envelope = {}) {
  const assignmentId = typeof summary.assignment_id === 'string'
    ? summary.assignment_id
    : (typeof envelope.assignment_id === 'string' ? envelope.assignment_id : null);
  const taskId = typeof summary.task_id === 'string'
    ? summary.task_id
    : (typeof envelope.from_task_id === 'string' ? envelope.from_task_id : null);
  const attempt = typeof summary.attempt === 'string'
    ? summary.attempt
    : (typeof envelope.attempt_id === 'string' ? envelope.attempt_id : null);
  const generation = typeof summary.generation === 'string'
    ? summary.generation
    : (typeof envelope.generation === 'string' ? envelope.generation : null);
  const sessionId = typeof summary.session_id === 'string' ? summary.session_id : null;
  const questionId = typeof summary.question_id === 'string' ? summary.question_id : null;
  const provider = typeof summary.provider === 'string' ? summary.provider.slice(0, 32) : null;
  const correlation = typeof summary.correlation_id === 'string'
    ? summary.correlation_id
    : (typeof envelope.correlation_id === 'string' ? envelope.correlation_id : null);
  const digest = typeof summary.question_digest === 'string'
    ? summary.question_digest
    : (typeof envelope.payload_digest === 'string' ? envelope.payload_digest : null);
  return freeze({
    task_id: taskId,
    assignment_id: assignmentId,
    attempt,
    generation,
    session_id: sessionId,
    question_id: questionId,
    provider,
    correlation_id: correlation,
    question_digest: digest,
  });
}

function questionIdentityComplete(identity) {
  if (!plainObject(identity)) return false;
  return QUESTION_IDENTITY_KEYS.every((key) => {
    const value = identity[key];
    return typeof value === 'string' && value.length > 0;
  });
}

function compactQuestionIdentities(summary, envelope, questionIds) {
  const unique = [];
  const seen = new Set();
  for (const questionId of questionIds) {
    if (seen.has(questionId)) {
      return { ok: false, code: 'grouped_attention_identity_mismatch' };
    }
    seen.add(questionId);
    unique.push(questionId);
  }
  const provided = Array.isArray(summary.question_identities)
    ? summary.question_identities
    : (Array.isArray(summary.questions) ? summary.questions : null);
  if (Array.isArray(provided)) {
    if (provided.length !== unique.length) {
      return { ok: false, code: 'grouped_attention_identity_mismatch' };
    }
    const providedIds = [];
    const providedSeen = new Set();
    for (const item of provided) {
      if (!plainObject(item) || typeof item.question_id !== 'string' || providedSeen.has(item.question_id)) {
        return { ok: false, code: 'grouped_attention_identity_mismatch' };
      }
      providedSeen.add(item.question_id);
      providedIds.push(item.question_id);
    }
    if (providedIds.some((id) => !seen.has(id))) {
      return { ok: false, code: 'grouped_attention_identity_mismatch' };
    }
  }
  const identities = [];
  for (const questionId of unique) {
    const override = Array.isArray(provided)
      ? provided.find((item) => item.question_id === questionId)
      : null;
    const identity = compactQuestionIdentity({
      ...summary,
      ...(override ?? {}),
      question_id: questionId,
    }, envelope);
    if (!questionIdentityComplete(identity) || identity.question_id !== questionId) {
      return { ok: false, code: 'grouped_attention_missing_identity' };
    }
    identities.push(identity);
  }
  return { ok: true, identities: Object.freeze(identities) };
}

function normalizeStructuredAnswers(response, identities) {
  if (Array.isArray(response?.answers)) return response.answers;
  if (plainObject(response) && identities.length === 1 && !Array.isArray(response.answers)) {
    return [response];
  }
  return null;
}

export function mergeReadyFactsPass(summary) {
  if (!plainObject(summary)) return false;
  for (const key of MERGE_READY_REQUIRED) {
    if (!Object.hasOwn(summary, key) && summary[key] == null) return false;
  }
  if (!SHA.test(summary.candidate_head) || !SHA.test(summary.candidate_tree)) return false;
  if (!SHA.test(summary.expected_head) || !SHA.test(summary.current_head)) return false;
  if (!SHA.test(summary.current_tree)) return false;
  if (summary.expected_head !== summary.current_head) return false;
  if (summary.current_head !== summary.candidate_head) return false;
  if (summary.current_tree !== summary.candidate_tree) return false;
  if (summary.verifier_accepted !== true) return false;
  if (summary.ci_green !== true || summary.ci_current !== true) return false;
  if (summary.failed_check_count !== 0 || summary.hidden_failed_checks === true) return false;
  if (summary.merge_topology_ok !== true) return false;
  return true;
}

function sanitizeEventSummary(summary, kind, envelope = {}) {
  if (summary == null) return { ok: true, summary: null };
  if (!plainObject(summary)) return { ok: false, code: 'secret_or_transcript_evidence' };
  for (const [key, value] of Object.entries(summary)) {
    if (SECRET_KEY.test(key) || (typeof value === 'string' && SECRET_VALUE.test(value))) {
      return { ok: false, code: 'secret_or_transcript_evidence' };
    }
  }
  const questionIds = Array.isArray(summary.question_ids)
    ? summary.question_ids.filter((id) => typeof id === 'string' && MESSAGE_ID.test(id)).slice(0, 16)
    : [];
  const compact = {
    assignment_state: compactAssignmentState(summary.assignment_state ?? summary),
    question_ids: questionIds,
    question_schema: typeof summary.question_schema === 'string' ? summary.question_schema.slice(0, 64) : null,
    unresolved_reason: typeof summary.unresolved_reason === 'string'
      ? summary.unresolved_reason.slice(0, 160) : null,
    deadline: typeof summary.deadline === 'string' ? summary.deadline.slice(0, 40) : null,
    candidate_head: typeof summary.candidate_head === 'string' && SHA.test(summary.candidate_head)
      ? summary.candidate_head : null,
    candidate_tree: typeof summary.candidate_tree === 'string' && SHA.test(summary.candidate_tree)
      ? summary.candidate_tree : null,
  };
  if (kind === 'merge_ready') {
    compact.expected_head = typeof summary.expected_head === 'string' && SHA.test(summary.expected_head)
      ? summary.expected_head : compact.candidate_head;
    compact.current_head = typeof summary.current_head === 'string' && SHA.test(summary.current_head)
      ? summary.current_head : compact.candidate_head;
    compact.current_tree = typeof summary.current_tree === 'string' && SHA.test(summary.current_tree)
      ? summary.current_tree : compact.candidate_tree;
    compact.ci_green = summary.ci_green === true;
    compact.ci_current = summary.ci_current === true;
    compact.hidden_failed_checks = summary.hidden_failed_checks === true;
    compact.failed_check_count = Number.isInteger(summary.failed_check_count)
      ? summary.failed_check_count : 0;
    compact.verifier_accepted = summary.verifier_accepted === true;
    compact.merge_topology_ok = summary.merge_topology_ok === true;
  }
  if (kind === 'question') {
    if (questionIds.length === 0 && typeof summary.question_id === 'string' && MESSAGE_ID.test(summary.question_id)) {
      questionIds.push(summary.question_id);
    }
    if (questionIds.length === 0) {
      return { ok: false, code: 'grouped_attention_missing_ids' };
    }
    const identitiesResult = compactQuestionIdentities(summary, envelope, questionIds);
    if (!identitiesResult.ok) return identitiesResult;
    compact.question_identities = identitiesResult.identities;
    compact.question_identity = identitiesResult.identities.length === 1
      ? identitiesResult.identities[0]
      : null;
  }
  const frozen = freeze({
    ...compact,
    question_ids: Object.freeze(questionIds),
    question_identity: compact.question_identity ?? null,
    question_identities: Object.freeze([...(compact.question_identities ?? [])]),
  });
  if (utf8Bytes(JSON.stringify(frozen)) > EVENT_SUMMARY_MAX_BYTES) {
    return { ok: false, code: 'summary_over_bound' };
  }
  return { ok: true, summary: frozen };
}

function spillArtifact(body, digest) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return freeze({
    kind: 'spilled_body',
    artifact_class: 'sanitized',
    relative_path: null,
    sha256: DIGEST.test(digest) ? digest : sha256(payload),
    byte_length: utf8Bytes(payload),
  });
}

export function buildEnvelope(input = {}) {
  if (!plainObject(input)) {
    return { ok: false, code: 'invalid_envelope', envelope: null };
  }
  for (const key of Object.keys(input)) {
    if (!ENVELOPE_KEYS.includes(key) && key !== 'body' && key !== 'evidence_refs') {
      if (SECRET_KEY.test(key)) return { ok: false, code: 'secret_or_transcript_evidence', envelope: null };
    }
  }
  if (!isEnvelopeKind(input.kind)) return { ok: false, code: 'invalid_kind', envelope: null };
  const identity = [
    requireExact(MESSAGE_ID, input.message_id, 'invalid_envelope'),
    requireExact(RUN_ID, input.run_id, 'wrong_run_identity'),
    requireExact(TASK_ID, input.from_task_id, 'wrong_thread_identity'),
    requireExact(TASK_ID, input.to_task_id, 'wrong_thread_identity'),
    requireExact(CURSOR, input.attempt_id, 'stale_attempt'),
    requireExact(CURSOR, input.generation, 'stale_generation'),
    requireExact(CURSOR, input.event_cursor, 'stale_event'),
    requireExact(ISO_TIME, input.created_at, 'invalid_envelope'),
  ].find(Boolean);
  if (identity) return { ok: false, code: identity, envelope: null };
  if (input.assignment_id != null && requireExact(RUN_ID, input.assignment_id, 'wrong_run_identity')) {
    return { ok: false, code: 'wrong_run_identity', envelope: null };
  }
  const parent = input.parent_message_id ?? input.reply_to ?? null;
  if (parent != null && requireExact(MESSAGE_ID, parent, 'invalid_envelope')) {
    return { ok: false, code: 'invalid_envelope', envelope: null };
  }
  const correlation = input.correlation_id ?? input.message_id;
  if (requireExact(MESSAGE_ID, correlation, 'invalid_envelope')) {
    return { ok: false, code: 'invalid_envelope', envelope: null };
  }
  const summaryResult = sanitizeEventSummary(input.event_summary, input.kind, input);
  if (!summaryResult.ok) return { ok: false, code: summaryResult.code, envelope: null };
  const evidence = sanitizeEvidenceRefs(input.evidence_refs);
  if (evidence.some((item) => item?.denied === true)) {
    return { ok: false, code: 'secret_or_transcript_evidence', envelope: null };
  }

  let eventSummary = summaryResult.summary;
  let artifactRef = input.artifact_ref ? sanitizeEvidenceRefs([input.artifact_ref])[0] : null;
  const bodyBytes = input.body == null ? 0 : utf8Bytes(typeof input.body === 'string' ? input.body : JSON.stringify(input.body));
  if (bodyBytes > BODY_SPILL_MAX_BYTES) {
    artifactRef = spillArtifact(input.body, input.payload_digest);
    eventSummary = eventSummary && utf8Bytes(JSON.stringify(eventSummary)) <= EVENT_SUMMARY_MAX_BYTES
      ? eventSummary
      : freeze({ assignment_state: eventSummary?.assignment_state ?? null, question_ids: Object.freeze([]) });
  }
  const canonical = {
    schema: LUNA_PM_MESSAGE_SCHEMA,
    message_id: input.message_id,
    run_id: input.run_id,
    assignment_id: input.assignment_id ?? null,
    attempt_id: input.attempt_id,
    from_task_id: input.from_task_id,
    to_task_id: input.to_task_id,
    parent_message_id: parent,
    reply_to: parent,
    correlation_id: correlation,
    kind: input.kind,
    generation: input.generation,
    event_cursor: input.event_cursor,
    created_at: input.created_at,
    event_summary: eventSummary,
    artifact_ref: artifactRef ?? null,
  };
  canonical.payload_digest = DIGEST.test(input.payload_digest)
    ? input.payload_digest
    : sha256(JSON.stringify({
      kind: canonical.kind,
      event_summary: canonical.event_summary,
      artifact_ref: canonical.artifact_ref,
    }));
  if (utf8Bytes(JSON.stringify(canonical)) > RELAY_MESSAGE_MAX_BYTES) {
    canonical.event_summary = null;
    canonical.artifact_ref = spillArtifact(input.body ?? canonical, canonical.payload_digest);
    canonical.payload_digest = sha256(JSON.stringify({
      kind: canonical.kind, artifact_ref: canonical.artifact_ref,
    }));
  }
  return { ok: true, code: null, envelope: freeze(canonical) };
}

function hostGap(host) {
  return hostApiGap(host);
}

function sessionFrom(input, host, native, mode, extras) {
  const recent = Object.freeze([...(extras.recent_ids ?? [])].slice(-RECENT_ID_WINDOW));
  return freeze({
    mode,
    pm: extras.pm,
    model: extras.model ?? null,
    thread_id: extras.thread_id ?? null,
    host_id: extras.host_id ?? null,
    thread_binding: extras.thread_binding ?? null,
    queued_thread: extras.queued_thread === true,
    client_thread_id: extras.client_thread_id ?? null,
    host_bound: extras.host_bound === true,
    run_id: input.run_id,
    pm_task_id: extras.pm_task_id ?? null,
    last_cursor: extras.last_cursor ?? null,
    generation: extras.generation ?? '0',
    attempt_id: extras.attempt_id ?? '0',
    recent_ids: recent,
    recent_digest: sha256(JSON.stringify(recent)),
    luna_authorized: input.luna_authorized === true,
    luna_available: input.luna_available === true,
    host_api_gap: extras.host_api_gap ?? hostGap(host),
    wait_tool: host.resolved.wait ?? null,
    optional_tools: host.optional,
    native_subagents: native.subagents,
    sol_merge_ready_sent: extras.sol_merge_ready_sent === true,
    preserved: preserveUserChoices(input),
  });
}

export function createLunaPmSession(input = {}) {
  const preserved = preserveUserChoices(input);
  const host = detectHostTaskTools(input.host_tools);
  const native = planLunaNativeSubagents(
    input.native_subagents,
    input.external_writer_scopes,
    {
      parent_depth: 1,
      external_lane_count: Array.isArray(input.external_writer_scopes)
        ? input.external_writer_scopes.length
        : 0,
    },
  );
  if (requireExact(RUN_ID, input.run_id, 'wrong_run_identity')) {
    return denied(null, 'wrong_run_identity', 'reject_identity', {
      mode: 'degraded_inline',
      pm: 'current_codex_task',
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
      preserved,
      host_api_gap: hostGap(host),
    });
  }
  if (!native.ok) {
    const session = sessionFrom(input, host, native, 'degraded_inline', { pm: 'current_codex_task' });
    return denied(session, native.code, 'reject_duplicate_writer', {
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
      preserved,
    });
  }
  const override = typeof input.user_model_override === 'string' ? input.user_model_override : null;
  if (override && FORBIDDEN_DEFAULT_PM_MODELS.includes(override) && input.explicit_sol_adjudication !== true) {
    const session = sessionFrom(input, host, native, 'degraded_inline', { pm: 'current_codex_task' });
    return denied(session, 'unauthorized_sol_escalation', 'reject_sol_escalation', {
      user_report: `${USER_REPORTS.unauthorized_sol} ${USER_REPORTS.no_sol_substitute}.`,
      preserved,
    });
  }
  if (input.default_pm && FORBIDDEN_DEFAULT_PM_MODELS.includes(input.default_pm)) {
    const session = sessionFrom(input, host, native, 'degraded_inline', { pm: 'current_codex_task' });
    return denied(session, 'unauthorized_sol_escalation', 'reject_sol_escalation', {
      user_report: `${USER_REPORTS.unauthorized_sol} ${USER_REPORTS.no_sol_substitute}.`,
      preserved,
    });
  }

  const lunaReady = input.luna_authorized === true && input.luna_available === true;
  if (!host.complete || !lunaReady) {
    const code = !host.complete
      ? (host.rejected_aliases.length > 0 && host.present.length === 0
        ? 'fictional_host_alias'
        : 'missing_host_task_tools')
      : (input.luna_authorized === true ? 'luna_max_unavailable' : 'luna_unauthorized');
    const session = sessionFrom(input, host, native, 'degraded_inline', { pm: 'current_codex_task' });
    return result({
      ok: true,
      action: 'degraded_inline',
      code,
      mode: 'degraded_inline',
      pm: 'current_codex_task',
      host_api_gap: session.host_api_gap,
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
      session,
      preserved,
      native_subagents: native.subagents,
    });
  }

  const boundThread = input.host_bound === true && typeof input.thread_id === 'string'
    ? input.thread_id
    : null;
  if (boundThread && requireExact(TASK_ID, boundThread, 'wrong_thread_identity')) {
    const session = sessionFrom(input, host, native, 'degraded_inline', { pm: 'current_codex_task' });
    return denied(session, 'wrong_thread_identity', 'reject_identity', {
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
      preserved,
    });
  }

  const session = sessionFrom(input, host, native, 'luna_max_pinned', {
    pm: DEFAULT_PM_MODEL,
    model: DEFAULT_PM_MODEL,
    thread_id: boundThread,
    host_id: typeof input.host_id === 'string' ? input.host_id : (input.hostId ?? null),
    thread_binding: typeof input.thread_binding === 'string' ? input.thread_binding : 'threadId',
    queued_thread: input.queued_thread === true,
    host_bound: boundThread != null,
    pm_task_id: boundThread,
    last_cursor: boundThread ? (input.last_cursor ?? input.afterCursor ?? null) : null,
  });
  const createdCall = boundThread
    ? { ok: true, host_calls: [] }
    : planCreateThread({ model: DEFAULT_PM_MODEL });
  if (!createdCall.ok) {
    return denied(session, createdCall.code, 'reject_host_call', {
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
      preserved,
    });
  }
  return result({
    ok: true,
    action: boundThread ? 'continue_bound_thread' : 'create_thread',
    mode: 'luna_max_pinned',
    pm: DEFAULT_PM_MODEL,
    host_calls: createdCall.host_calls,
    user_report: USER_REPORTS.luna_pinned,
    session,
    preserved,
    native_subagents: native.subagents,
  });
}

export function bindHostThread(sessionInput, hostResult) {
  const created = plainObject(sessionInput) && sessionInput.schema === LUNA_PM_SCHEMA
    ? sessionInput
    : null;
  const session = created?.session ?? snapshotSession(sessionInput);
  if (!plainObject(session) || session.mode !== 'luna_max_pinned') {
    return denied(session, 'wrong_thread_identity', 'reject_identity');
  }
  const source = plainObject(hostResult) ? hostResult : {};
  const adapted = bindCreateThreadResult({
    threadId: source.threadId ?? source.thread_id ?? null,
    clientThreadId: source.clientThreadId ?? source.client_thread_id ?? null,
    hostId: source.hostId ?? source.host_id ?? null,
    afterCursor: source.afterCursor ?? source.cursor ?? source.event_cursor,
  });
  if (!adapted.ok) {
    const pending = adapted.code === 'setup_pending';
    const queued = freeze({
      ...session,
      thread_id: null,
      host_id: adapted.hostId ?? null,
      thread_binding: pending ? 'setup_pending' : session.thread_binding,
      queued_thread: pending,
      client_thread_id: adapted.clientThreadId ?? null,
      host_bound: false,
      pm_task_id: null,
    });
    return denied(session, adapted.code, adapted.action ?? 'reject_identity', {
      session: queued,
      resume_needed: pending,
    });
  }
  const boundId = adapted.binding.threadId;
  const optional = [];
  if ((session.optional_tools ?? []).includes('set_thread_pinned')) {
    const pin = planSetThreadPinned({ threadId: boundId, pinned: true });
    if (pin.ok) optional.push(...pin.host_calls);
  }
  const bound = freeze({
    ...session,
    thread_id: boundId,
    host_id: adapted.binding.hostId,
    thread_binding: adapted.binding.binding,
    queued_thread: false,
    client_thread_id: null,
    pm_task_id: boundId,
    host_bound: true,
    last_cursor: adapted.binding.afterCursor,
  });
  return result({
    ok: true,
    action: adapted.action,
    mode: 'luna_max_pinned',
    pm: DEFAULT_PM_MODEL,
    host_calls: optional,
    user_report: USER_REPORTS.luna_pinned,
    session: bound,
    preserved: session.preserved,
    native_subagents: session.native_subagents,
  });
}

function cursorValue(cursor) {
  return BigInt(cursor);
}

function acceptCursor(session, envelope) {
  const recent = session.recent_ids ?? [];
  if (recent.includes(envelope.message_id)) return 'duplicate_event';
  if (session.last_cursor == null) return null;
  const incoming = cursorValue(envelope.event_cursor);
  const last = cursorValue(session.last_cursor);
  if (incoming < last) return 'stale_event';
  if (incoming === last && recent.length > 0) return 'stale_event';
  if (cursorValue(envelope.generation) < cursorValue(session.generation ?? '0')) return 'stale_generation';
  if (cursorValue(envelope.attempt_id) < cursorValue(session.attempt_id ?? '0')) return 'stale_attempt';
  return null;
}

function nextSession(session, envelope, extras = {}) {
  const recent = [...(session.recent_ids ?? []), envelope.message_id].slice(-RECENT_ID_WINDOW);
  return freeze({
    ...snapshotSession(session),
    last_cursor: envelope.event_cursor,
    generation: envelope.generation,
    attempt_id: envelope.attempt_id,
    recent_ids: Object.freeze(recent),
    recent_digest: sha256(JSON.stringify(recent)),
    sol_merge_ready_sent: extras.sol_merge_ready_sent === true
      ? true
      : session.sol_merge_ready_sent === true,
  });
}

export function shouldEscalateToSol(event) {
  if (!plainObject(event)) return false;
  if (event.kind === 'merge_ready') return mergeReadyFactsPass(event.event_summary ?? event);
  if (event.kind === 'completed' || event.kind === 'progress') return false;
  const criterion = event.sol_criterion ?? event.escalation;
  if (!isSolEscalationCriterion(criterion)) return false;
  if (criterion === 'explicit_user_escalation' && event.user_escalation !== true) return false;
  return true;
}

export function shouldWakeLuna(kind) {
  return WAKING_KINDS.includes(kind) && kind !== 'merge_ready' && kind !== ROUTINE_PROGRESS_KIND;
}

export function shouldWake(kind) {
  if (kind === ROUTINE_PROGRESS_KIND) return freeze({ luna: false, sol: false });
  if (kind === 'merge_ready') return freeze({ luna: false, sol: true });
  return freeze({ luna: shouldWakeLuna(kind), sol: false });
}

function envelopePrompt(envelope) {
  return JSON.stringify(envelope);
}

export function routeStructuredAttentionResponse(envelope, response) {
  if (!plainObject(envelope) || envelope.kind !== 'question') {
    return freeze({ ok: false, code: 'grouped_attention_missing_identity', response: null });
  }
  const identities = envelope.event_summary?.question_identities;
  if (!Array.isArray(identities) || identities.length === 0 || !identities.every(questionIdentityComplete)) {
    return freeze({ ok: false, code: 'grouped_attention_missing_identity', response: null });
  }
  const answersIn = normalizeStructuredAnswers(response, identities);
  if (answersIn == null) {
    return freeze({ ok: false, code: 'invalid_structured_response', response: null });
  }
  if (answersIn.length !== identities.length) {
    return freeze({ ok: false, code: 'grouped_attention_identity_mismatch', response: null });
  }
  const seen = new Set();
  const answers = [];
  for (const identity of identities) {
    const match = answersIn.find((row) => plainObject(row) && row.question_id === identity.question_id);
    if (!plainObject(match) || seen.has(identity.question_id)) {
      return freeze({ ok: false, code: 'grouped_attention_identity_mismatch', response: null });
    }
    seen.add(identity.question_id);
    for (const key of Object.keys(match)) {
      if (!STRUCTURED_ANSWER_KEYS.includes(key)) {
        return freeze({ ok: false, code: 'invalid_structured_response', response: null });
      }
    }
    const expected = {
      assignment_id: identity.assignment_id,
      question_id: identity.question_id,
      session_id: identity.session_id,
      task_id: identity.task_id,
    };
    for (const key of Object.keys(expected)) {
      if (match[key] !== expected[key]) {
        return freeze({ ok: false, code: 'grouped_attention_identity_mismatch', response: null });
      }
    }
    if (typeof match.response !== 'string' || match.response.length === 0) {
      return freeze({ ok: false, code: 'invalid_structured_response', response: null });
    }
    answers.push(freeze({ ...expected, response: match.response }));
  }
  if (seen.size !== identities.length) {
    return freeze({ ok: false, code: 'grouped_attention_identity_mismatch', response: null });
  }
  return freeze({
    ok: true,
    code: null,
    response: freeze({ answers: Object.freeze(answers) }),
  });
}

function plannedHostCalls(session, envelope) {
  return planMessageAndWait(session, envelopePrompt(envelope), {
    afterCursor: envelope.event_cursor,
    wait_tool: session.wait_tool,
  });
}

export function relayEvent(sessionInput, eventInput) {
  const created = plainObject(sessionInput) && sessionInput.schema === LUNA_PM_SCHEMA
    ? sessionInput
    : null;
  const session = created?.session ?? snapshotSession(sessionInput);
  if (!plainObject(session) || typeof session.run_id !== 'string') {
    return denied(null, 'wrong_run_identity', 'reject_identity', {
      mode: 'degraded_inline',
      pm: 'current_codex_task',
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
    });
  }
  if (session.mode === 'degraded_inline' || session.pm === 'current_codex_task') {
    return result({
      ok: true,
      action: 'degraded_inline',
      code: session.host_api_gap
        ? (session.host_api_gap.rejected_aliases?.length && session.host_api_gap.present?.length === 0
          ? 'fictional_host_alias'
          : 'missing_host_task_tools')
        : 'luna_max_unavailable',
      mode: 'degraded_inline',
      pm: 'current_codex_task',
      host_api_gap: session.host_api_gap,
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
      session,
      preserved: session.preserved,
    });
  }
  if (eventInput?.luna_failed === true) {
    const failed = freeze({ ...session, mode: 'degraded_inline', pm: 'current_codex_task' });
    return result({
      ok: true,
      action: 'degraded_inline',
      code: 'luna_failed',
      mode: 'degraded_inline',
      pm: 'current_codex_task',
      user_report: `${USER_REPORTS.degraded_inline} ${USER_REPORTS.no_sol_substitute}.`,
      session: failed,
      preserved: session.preserved,
    });
  }
  if (session.queued_thread === true || session.host_bound !== true || typeof session.thread_id !== 'string') {
    const pending = session.queued_thread === true || session.thread_binding === 'setup_pending';
    return denied(session, pending ? 'setup_pending' : 'wrong_thread_identity', pending ? 'resume_needed' : 'reject_identity', {
      session,
      resume_needed: pending,
    });
  }
  if (eventInput?.git_operation != null) {
    const deniedGit = denyMessageGitOverride(eventInput.git_operation);
    if (deniedGit?.ok === false) {
      return denied(session, deniedGit.code ?? 'git_override_denied', 'reject_git_override', { session });
    }
  }

  const packed = buildEnvelope({
    ...eventInput,
    run_id: eventInput?.run_id ?? session.run_id,
    from_task_id: eventInput?.from_task_id ?? session.pm_task_id ?? session.thread_id,
    to_task_id: eventInput?.to_task_id ?? session.thread_id,
    attempt_id: eventInput?.attempt_id ?? session.attempt_id ?? '1',
    generation: eventInput?.generation ?? session.generation ?? '1',
    event_cursor: eventInput?.event_cursor ?? eventInput?.cursor,
    created_at: eventInput?.created_at ?? '2026-08-28T00:00:00Z',
    message_id: eventInput?.message_id ?? eventInput?.event_id,
    kind: eventInput?.kind ?? eventInput?.event_type,
  });
  if (!packed.ok) {
    return denied(session, packed.code, packed.code === 'invalid_kind' ? 'ignore_duplicate' : 'reject_identity', {
      session,
    });
  }
  const envelope = packed.envelope;
  if (envelope.run_id !== session.run_id) {
    return denied(session, 'wrong_run_identity', 'reject_identity', { session });
  }
  if (envelope.to_task_id !== session.thread_id) {
    return denied(session, 'wrong_thread_identity', 'reject_identity', { session });
  }

  const cursorCode = acceptCursor(session, envelope);
  if (cursorCode) {
    return denied(session, cursorCode, 'ignore_duplicate', {
      user_report: USER_REPORTS.luna_pinned,
      session,
    });
  }

  if (envelope.kind === ROUTINE_PROGRESS_KIND) {
    const advanced = nextSession(session, envelope);
    return result({
      ok: true,
      action: 'append_progress',
      mode: session.mode,
      pm: DEFAULT_PM_MODEL,
      wake_luna: false,
      wake_sol: false,
      session: advanced,
      preserved: session.preserved,
      user_report: USER_REPORTS.luna_pinned,
      message: envelope,
      host_calls: [],
    });
  }

  const parentOnly = envelope.from_task_id === session.pm_task_id;
  const wantSolException = shouldEscalateToSol({
    ...eventInput,
    kind: envelope.kind,
    event_summary: envelope.event_summary,
  });
  if (envelope.kind === 'merge_ready') {
    if (!parentOnly) {
      return denied(session, 'unauthorized_sol_escalation', 'reject_sol_escalation', {
        user_report: `${USER_REPORTS.unauthorized_sol} ${USER_REPORTS.no_sol_substitute}.`,
        session,
      });
    }
    if (session.sol_merge_ready_sent === true) {
      return denied(session, 'duplicate_event', 'ignore_duplicate', {
        user_report: USER_REPORTS.luna_pinned,
        session,
      });
    }
    if (!mergeReadyFactsPass(envelope.event_summary)) {
      return denied(session, 'merge_ready_incomplete', 'reject_identity', { session });
    }
    const adjudicator = SOL_ADJUDICATOR_MODELS.includes(eventInput?.sol_model)
      ? eventInput.sol_model
      : 'sol-high';
    const advanced = nextSession(session, envelope, { sol_merge_ready_sent: true });
    const planned = planSolMergeReady(adjudicator, envelopePrompt(envelope), envelope.event_cursor);
    if (!planned.ok) {
      return denied(session, planned.code, 'reject_host_call', { session });
    }
    return result({
      ok: true,
      action: 'wake_sol_merge_ready',
      mode: session.mode,
      pm: DEFAULT_PM_MODEL,
      sol: adjudicator,
      wake_luna: false,
      wake_sol: true,
      host_calls: planned.host_calls,
      message: envelope,
      session: advanced,
      preserved: session.preserved,
      user_report: `${USER_REPORTS.luna_pinned} ${USER_REPORTS.merge_ready_sol}`,
    });
  }

  if (envelope.kind === 'completed' && (eventInput?.wake_sol === true || eventInput?.sol_criterion)) {
    const advanced = nextSession(session, envelope);
    const completedCalls = plannedHostCalls(session, envelope);
    if (!completedCalls.ok) {
      return denied(session, completedCalls.code, 'reject_host_call', { session });
    }
    return result({
      ok: true,
      action: 'complete_no_sol',
      mode: session.mode,
      pm: DEFAULT_PM_MODEL,
      wake_luna: true,
      wake_sol: false,
      session: advanced,
      preserved: session.preserved,
      user_report: `${USER_REPORTS.luna_pinned} ${USER_REPORTS.completed_no_sol}`,
      message: envelope,
      host_calls: completedCalls.host_calls,
    });
  }

  let structuredResponse = null;
  if (envelope.kind === 'question' && eventInput?.structured_response != null) {
    const routed = routeStructuredAttentionResponse(envelope, eventInput.structured_response);
    if (!routed.ok) {
      return denied(session, routed.code, 'reject_identity', { session });
    }
    structuredResponse = routed.response;
  }

  if (eventInput?.wake_sol === true && !wantSolException) {
    return denied(session, 'unauthorized_sol_escalation', 'reject_sol_escalation', {
      user_report: `${USER_REPORTS.unauthorized_sol} ${USER_REPORTS.no_sol_substitute}.`,
      session,
    });
  }
  if (wantSolException && eventInput?.sol_authorized !== true && eventInput?.user_escalation !== true) {
    return denied(session, 'unauthorized_sol_escalation', 'reject_sol_escalation', {
      user_report: `${USER_REPORTS.unauthorized_sol} ${USER_REPORTS.no_sol_substitute}.`,
      session,
    });
  }
  if (wantSolException && !parentOnly) {
    return denied(session, 'unauthorized_sol_escalation', 'reject_sol_escalation', {
      user_report: `${USER_REPORTS.unauthorized_sol} ${USER_REPORTS.no_sol_substitute}.`,
      session,
    });
  }

  const advanced = nextSession(session, envelope);
  const planned = plannedHostCalls(session, envelope);
  if (!planned.ok) {
    return denied(session, planned.code, 'reject_host_call', { session });
  }
  const hostCalls = planned.host_calls;
  if (wantSolException && parentOnly) {
    const adjudicator = SOL_ADJUDICATOR_MODELS.includes(eventInput?.sol_model)
      ? eventInput.sol_model
      : 'sol-high';
    return result({
      ok: true,
      action: 'sol_adjudicate',
      mode: session.mode,
      pm: DEFAULT_PM_MODEL,
      sol: adjudicator,
      wake_luna: true,
      wake_sol: true,
      host_calls: hostCalls,
      message: envelope,
      session: advanced,
      preserved: session.preserved,
      user_report: USER_REPORTS.luna_pinned,
    });
  }

  return result({
    ok: true,
    action: 'bind_and_forward',
    mode: session.mode,
    pm: DEFAULT_PM_MODEL,
    wake_luna: true,
    wake_sol: false,
    host_calls: hostCalls,
    message: envelope,
    session: advanced,
    preserved: session.preserved,
    user_report: USER_REPORTS.luna_pinned,
    structured_response: structuredResponse,
  });
}

export function classifyTaskPortGitOperation(request) {
  return classifyGitOperationV1(request);
}

export function skillRequiredPhrases() {
  return Object.freeze([
    'Luna Max',
    'current Codex task',
    'I am not substituting Sol',
    'Sol Medium',
    'Sol High',
    'create_thread',
    'send_message_to_thread',
    'wait_threads',
    'read_thread',
    'merge_ready',
    'progress',
    'set_thread_archived',
    'set_thread_pinned',
    'same run cursor',
    'decision_or_attention',
    'setup_pending',
    'threadId',
  ]);
}
