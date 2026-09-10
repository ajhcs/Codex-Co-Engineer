// OwnedDelegationV1 — derive a fresh bounded correction assignment from a
// completed, clean, exactly identified producer. Never replay an active or
// uncertain task. Provider, model, and write scope are preserved.

import { createHash } from 'node:crypto';

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedOwnKeys,
  capturedTest,
  isKnownProvider,
  isModelId,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import { compileOwnedCorrectionPromptV1 } from './prompt-compiler.mjs';
import {
  PROMPT_MAX_BYTES,
  RunContractV1Error,
  assertBaseSha,
  assertBoundedText,
  assertRunId,
  isAssignmentId,
  isSha40,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  freezeData,
  ownDataValue,
} from './selection-json.mjs';

export const OWNED_DELEGATION_SCHEMA_ID = 'codex-co-engineer.owned-delegation.v1';
export const OWNED_DELEGATION_VERSION = 1;
export const OWNED_REVISION_IDENTITY_DOMAIN = 'codex-co-engineer.owned-revision.v1';
export const OWNED_REVISION_REQUEST_KEYS = capturedFreeze([
  'assignment_id', 'feedback', 'expected_head', 'expected_idempotency_key',
]);
export const MAX_REVISION_FEEDBACK_BYTES = 4_096;
export const MIN_REVISION_FEEDBACK_BYTES = 1;
export const IDEMPOTENCY_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const COMPLETED_PRODUCER_PHASES = capturedFreeze(['completed']);
const ACTIVE_OR_UNCERTAIN_PHASES = capturedFreeze([
  'planned', 'prepared', 'session_ready', 'prompt_dispatched', 'running',
  'needs_attention', 'accepted', 'starting', 'cancelling', 'dispatching',
  'validating', 'preparing_workspaces', 'awaiting_consent',
]);
const UNCERTAIN_CONFIDENCE = capturedFreeze(['uncertain', 'not_sent']);

function revisionError(code, field, message) {
  throw new RunContractV1Error(code, field, message);
}

function sha256Hex(parts) {
  return createHash('sha256')
    .update(OWNED_REVISION_IDENTITY_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJsonStringify(parts), 'utf8')
    .digest('hex');
}

export function parseOwnedRevisionRequestV1(value, field = 'revision') {
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, 'revision');
  assertDirectJsonClosure(value, field);
  for (const key of capturedOwnKeys(value)) {
    if (typeof key !== 'string') revisionError('symbol_key_denied', field);
    if (!capturedIncludes(OWNED_REVISION_REQUEST_KEYS, key)) {
      revisionError('unknown_key', `${field}.${key}`, 'Revision accepts assignment_id, feedback, expected_head, and expected_idempotency_key.');
    }
  }
  if (!capturedHasOwn(value, 'assignment_id')) {
    revisionError('missing_key', `${field}.assignment_id`, 'A revision must name the exact producer assignment.');
  }
  const assignmentId = ownDataValue(value, 'assignment_id', `${field}.assignment_id`);
  if (typeof assignmentId !== 'string' || !isAssignmentId(assignmentId)) {
    revisionError('invalid_format', `${field}.assignment_id`, 'assignment_id is not valid.');
  }
  if (!capturedHasOwn(value, 'feedback')) {
    revisionError('missing_key', `${field}.feedback`, 'A revision must include concise feedback.');
  }
  const feedback = ownDataValue(value, 'feedback', `${field}.feedback`);
  assertBoundedText(feedback, {
    min: MIN_REVISION_FEEDBACK_BYTES,
    max: MAX_REVISION_FEEDBACK_BYTES,
    path: `${field}.feedback`,
    label: `${field}.feedback`,
  });
  if (!capturedHasOwn(value, 'expected_head')) {
    revisionError('missing_key', `${field}.expected_head`, 'A revision must name the exact producer HEAD.');
  }
  const expectedHead = ownDataValue(value, 'expected_head', `${field}.expected_head`);
  assertBaseSha(expectedHead, `${field}.expected_head`);
  if (!capturedHasOwn(value, 'expected_idempotency_key')) {
    revisionError('missing_key', `${field}.expected_idempotency_key`, 'A revision must name the producer request identity.');
  }
  const expectedKey = ownDataValue(value, 'expected_idempotency_key', `${field}.expected_idempotency_key`);
  if (typeof expectedKey !== 'string' || !capturedTest(IDEMPOTENCY_KEY_PATTERN, expectedKey)) {
    revisionError('invalid_format', `${field}.expected_idempotency_key`, 'expected_idempotency_key must be an exact sha256 digest.');
  }
  return freezeData({
    assignment_id: assignmentId,
    feedback,
    expected_head: expectedHead,
    expected_idempotency_key: expectedKey,
  });
}

export function ownedRevisionIdentityV1({ producer, revision }) {
  const digestHex = sha256Hex({
    producer_run_id: producer.run_id,
    producer_assignment_id: producer.assignment_id,
    producer_task_id: producer.task_id ?? null,
    expected_head: revision.expected_head,
    expected_idempotency_key: revision.expected_idempotency_key,
    feedback: revision.feedback,
    provider: producer.provider,
    model: producer.model,
    write_scope: [...(producer.write_scope ?? [])],
  });
  const runId = `rev-${digestHex.slice(0, 16)}`;
  assertRunId(runId, 'owned_revision.run_id');
  return freezeData({
    schema: OWNED_DELEGATION_SCHEMA_ID,
    version: OWNED_DELEGATION_VERSION,
    digest: `sha256:${digestHex}`,
    run_id: runId,
    assignment_id: producer.assignment_id,
    producer_run_id: producer.run_id,
    producer_assignment_id: producer.assignment_id,
  });
}

function producerPhase(producer) {
  return typeof producer?.phase === 'string'
    ? producer.phase
    : (typeof producer?.status === 'string' ? producer.status : null);
}

export function assertOwnedRevisionProducerV1(producer, revision, field = 'revision') {
  if (!producer || typeof producer !== 'object') {
    revisionError('revision_producer_not_found', field, 'The named producer assignment is not known.');
  }
  if (producer.assignment_id !== revision.assignment_id) {
    revisionError('revision_producer_not_found', `${field}.assignment_id`, 'The named producer assignment is not known.');
  }
  const phase = producerPhase(producer);
  const confidence = producer.dispatch_confidence;
  const uncertain = producer.prompt_dispatched !== true
    || capturedIncludes(UNCERTAIN_CONFIDENCE, confidence)
    || capturedIncludes(ACTIVE_OR_UNCERTAIN_PHASES, phase);
  if (uncertain || !capturedIncludes(COMPLETED_PRODUCER_PHASES, phase)) {
    revisionError(
      'revision_producer_active',
      field,
      'A revision requires a completed, certain producer; active or uncertain tasks are never replayed.',
    );
  }
  if (producer.clean !== true) {
    revisionError('revision_producer_dirty', field, 'A revision requires a clean producer worktree.');
  }
  const head = typeof producer.head === 'string' ? producer.head.toLowerCase() : null;
  if (!isSha40(head) || head !== revision.expected_head) {
    revisionError('revision_producer_stale', `${field}.expected_head`, 'expected_head does not match the exact producer HEAD.');
  }
  if (producer.request_idempotency_key !== revision.expected_idempotency_key) {
    revisionError(
      'revision_identity_mismatch',
      `${field}.expected_idempotency_key`,
      'expected_idempotency_key does not match the producer request identity.',
    );
  }
  if (typeof producer.provider !== 'string' || !isKnownProvider(producer.provider)
    || typeof producer.model !== 'string' || !isModelId(producer.model)) {
    revisionError('revision_authority_missing', field, 'The producer provider and model must remain exact.');
  }
  if (!Array.isArray(producer.write_scope)) {
    revisionError('revision_scope_missing', field, 'The producer write scope must remain exact.');
  }
  if (typeof producer.repo !== 'string' || producer.repo.length === 0) {
    revisionError('revision_producer_not_found', field, 'The producer repository path is missing.');
  }
  return producer;
}

export function projectOwnedProducerCandidateV1({
  record,
  assignment,
  lane,
  workspace = {},
} = {}) {
  if (!record || !assignment || !lane) {
    revisionError('revision_producer_not_found', 'producer', 'The named producer assignment is not known.');
  }
  const head = typeof workspace.current_head === 'string'
    ? workspace.current_head.toLowerCase()
    : (typeof lane.handoff?.current_head === 'string' ? lane.handoff.current_head.toLowerCase() : null);
  const clean = workspace.clean === true
    || (workspace.clean !== false && lane.handoff?.clean === true);
  const evidenceRefs = [];
  if (typeof record.compiled?.git_identity?.digest === 'string') {
    evidenceRefs.push({ kind: 'git_identity', digest: record.compiled.git_identity.digest });
  }
  if (typeof assignment.child_identity?.digest === 'string') {
    evidenceRefs.push({
      kind: 'child_identity',
      assignment_id: assignment.assignment_id,
      digest: assignment.child_identity.digest,
    });
  }
  if (typeof assignment.prompt_envelope_digest === 'string') {
    evidenceRefs.push({
      kind: 'prompt_envelope',
      assignment_id: assignment.assignment_id,
      digest: assignment.prompt_envelope_digest,
    });
  }
  if (typeof assignment.provider_run_identity?.digest === 'string') {
    evidenceRefs.push({
      kind: 'provider_run',
      assignment_id: assignment.assignment_id,
      digest: assignment.provider_run_identity.digest,
    });
  }
  return freezeData({
    run_id: record.run_id,
    assignment_id: assignment.assignment_id,
    task_id: assignment.task_id ?? lane.task_id ?? null,
    provider: assignment.provider,
    model: assignment.model,
    role: assignment.role,
    access: assignment.access,
    write_scope: [...(assignment.write_scope ?? [])],
    capabilities: [...(assignment.capabilities ?? [])],
    expected_duration_ms: assignment.expected_duration_ms,
    repo: record.compiled?.repo ?? record.compiled?.git?.repository_path ?? null,
    objective: record.compiled?.objective ?? null,
    request_idempotency_key: record.compiled?.request_idempotency_key ?? null,
    phase: lane.phase ?? lane.status ?? null,
    status: lane.status ?? lane.phase ?? null,
    prompt_dispatched: lane.prompt_dispatched === true,
    dispatch_confidence: lane.dispatch_confidence ?? null,
    head,
    clean,
    evidence_refs: evidenceRefs,
  });
}

export function deriveOwnedRevisionRequestV1(producer, revisionInput) {
  const revision = parseOwnedRevisionRequestV1(revisionInput);
  assertOwnedRevisionProducerV1(producer, revision);
  const identity = ownedRevisionIdentityV1({ producer, revision });
  const prompt = compileOwnedCorrectionPromptV1({
    producer_run_id: producer.run_id,
    producer_assignment_id: producer.assignment_id,
    feedback: revision.feedback,
    write_scope: producer.write_scope,
    provider: producer.provider,
    model: producer.model,
  });
  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > PROMPT_MAX_BYTES) {
    revisionError('invalid_format', 'revision.feedback', 'The derived correction prompt is outside the assignment bound.');
  }
  const objective = `Correct ${producer.assignment_id}: ${revision.feedback}`.slice(0, 4096);
  const assignment = {
    assignment_id: producer.assignment_id,
    provider: producer.provider,
    model: producer.model,
    role: producer.role ?? 'implement',
    prompt,
    expected_duration_ms: producer.expected_duration_ms,
    write_scope: [...producer.write_scope],
    required: true,
    ...(Array.isArray(producer.capabilities) && producer.capabilities.length > 0
      ? { capabilities: [...producer.capabilities] }
      : {}),
  };
  if (producer.access !== undefined) assignment.access = producer.access === 'writer' ? 'write' : producer.access;
  return freezeData({
    schema: OWNED_DELEGATION_SCHEMA_ID,
    version: OWNED_DELEGATION_VERSION,
    identity,
    producer_run_id: producer.run_id,
    run_request: freezeData({
      run_id: identity.run_id,
      repo: producer.repo,
      objective,
      base_sha: revision.expected_head,
      assignments: [freezeData(assignment)],
    }),
  });
}

export function producerFromRunReceiptV1(receipt, assignmentId, field = 'revision') {
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.lanes)) {
    revisionError('revision_producer_not_found', field, 'The named producer assignment is not known.');
  }
  if (typeof assignmentId !== 'string' || !isAssignmentId(assignmentId)) {
    revisionError('invalid_format', `${field}.assignment_id`, 'assignment_id is not valid.');
  }
  const lane = receipt.lanes.find((entry) => entry && entry.assignment_id === assignmentId);
  if (!lane) {
    revisionError('revision_producer_not_found', `${field}.assignment_id`, 'The named producer assignment is not known.');
  }
  const head = typeof lane.handoff?.current_head === 'string'
    ? lane.handoff.current_head.toLowerCase()
    : (typeof receipt.git?.head === 'string' ? receipt.git.head.toLowerCase() : (typeof lane.head === 'string' ? lane.head.toLowerCase() : null));
  const clean = lane.clean === true
    || lane.handoff?.clean === true
    || (lane.handoff?.clean !== false && receipt.clean === true);
  return freezeData({
    run_id: receipt.run_id,
    assignment_id: lane.assignment_id,
    task_id: lane.task_id ?? null,
    provider: lane.provider,
    model: lane.model,
    role: lane.role,
    access: lane.access,
    write_scope: Array.isArray(lane.write_scope)
      ? [...lane.write_scope]
      : (Array.isArray(receipt.write_scope) ? [...receipt.write_scope] : []),
    capabilities: Array.isArray(lane.capabilities) ? [...lane.capabilities] : [],
    expected_duration_ms: lane.expected_duration_ms ?? receipt.expected_duration_ms,
    repo: receipt.repo ?? receipt.repository_path ?? lane.repo ?? null,
    objective: receipt.objective ?? null,
    request_idempotency_key: receipt.request_idempotency_key
      ?? lane.request_idempotency_key
      ?? null,
    phase: lane.phase ?? lane.status ?? null,
    status: lane.status ?? lane.phase ?? null,
    prompt_dispatched: lane.prompt_dispatched === true,
    dispatch_confidence: lane.dispatch_confidence ?? null,
    head,
    clean,
    evidence_refs: Array.isArray(lane.evidence_refs) ? lane.evidence_refs : [],
  });
}

capturedFreeze(parseOwnedRevisionRequestV1);
capturedFreeze(ownedRevisionIdentityV1);
capturedFreeze(assertOwnedRevisionProducerV1);
capturedFreeze(projectOwnedProducerCandidateV1);
capturedFreeze(deriveOwnedRevisionRequestV1);
capturedFreeze(producerFromRunReceiptV1);
