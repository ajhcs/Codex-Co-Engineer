// OwnedDelegationV1 — derive a fresh bounded correction assignment from a
// completed, clean, exactly identified producer. Never replay an active or
// uncertain task. Provider, model, and write scope are preserved.
//
// Correction rounds are a fixed chain-depth ceiling of three, independent of
// each assignment's duration. One admitted correction child per producer;
// different feedback against the same producer is rejected with its child id
// rather than silently dropping feedback or branching a first-round candidate. Exhausted budget rejects before
// provider dispatch and requires a deliberate new bounded assignment. An
// admitted child that later fails does not replenish its consumed round.

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
export const OWNED_CORRECTION_LINEAGE_KEYS = capturedFreeze([
  'schema', 'version', 'lineage', 'producer_run_id', 'producer_assignment_id', 'reviewed_head',
  'original_run_id', 'original_assignment_id', 'round', 'limit',
]);
export const OWNED_CORRECTION_FOLLOW_KEYS = capturedFreeze([
  'child_run_id', 'child_assignment_id', 'identity_digest',
]);
export const OWNED_CORRECTION_ROUND_LIMIT = 3;
export const MAX_REVISION_FEEDBACK_BYTES = 4_096;
export const MIN_REVISION_FEEDBACK_BYTES = 1;
export const IDEMPOTENCY_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const AUTHORITATIVE_DISPATCH_CONFIDENCE = 'authoritative';
export const REVISION_BUDGET_EXHAUSTED_MESSAGE = `Owned correction rounds are exhausted (${OWNED_CORRECTION_ROUND_LIMIT} of ${OWNED_CORRECTION_ROUND_LIMIT}); submit a new bounded assignment. This path does not start that assignment.`;

const COMPLETED_PRODUCER_PHASES = capturedFreeze(['completed']);
const ACTIVE_OR_UNCERTAIN_PHASES = capturedFreeze([
  'planned', 'prepared', 'session_ready', 'prompt_dispatched', 'running',
  'needs_attention', 'accepted', 'starting', 'cancelling', 'dispatching',
  'validating', 'preparing_workspaces', 'awaiting_consent',
]);

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

export function compactOwnedCorrectionLineageV1(value, field = 'correction') {
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, 'correction');
  assertDirectJsonClosure(value, field);
  for (const key of capturedOwnKeys(value)) {
    if (typeof key !== 'string') revisionError('symbol_key_denied', field);
    if (!capturedIncludes(OWNED_CORRECTION_LINEAGE_KEYS, key)) {
      revisionError('unknown_key', `${field}.${key}`, 'Correction lineage is a closed machine record.');
    }
  }
  for (const key of OWNED_CORRECTION_LINEAGE_KEYS) {
    if (!capturedHasOwn(value, key)) {
      revisionError('missing_key', `${field}.${key}`, 'Correction lineage is incomplete.');
    }
  }
  const schema = ownDataValue(value, 'schema', `${field}.schema`);
  if (schema !== OWNED_DELEGATION_SCHEMA_ID) {
    revisionError('invalid_format', `${field}.schema`, 'Correction lineage schema is invalid.');
  }
  const version = ownDataValue(value, 'version', `${field}.version`);
  if (version !== OWNED_DELEGATION_VERSION) {
    revisionError('invalid_format', `${field}.version`, 'Correction lineage version is invalid.');
  }
  const lineage = ownDataValue(value, 'lineage', `${field}.lineage`);
  if (lineage !== 'owned_revision') {
    revisionError('invalid_format', `${field}.lineage`, 'Correction lineage must be owned_revision.');
  }
  const producerRunId = ownDataValue(value, 'producer_run_id', `${field}.producer_run_id`);
  assertRunId(producerRunId, `${field}.producer_run_id`);
  const producerAssignmentId = ownDataValue(value, 'producer_assignment_id', `${field}.producer_assignment_id`);
  if (typeof producerAssignmentId !== 'string' || !isAssignmentId(producerAssignmentId)) {
    revisionError('invalid_format', `${field}.producer_assignment_id`, 'producer_assignment_id is not valid.');
  }
  const reviewedHead = ownDataValue(value, 'reviewed_head', `${field}.reviewed_head`);
  assertBaseSha(reviewedHead, `${field}.reviewed_head`);
  const originalRunId = ownDataValue(value, 'original_run_id', `${field}.original_run_id`);
  assertRunId(originalRunId, `${field}.original_run_id`);
  const originalAssignmentId = ownDataValue(value, 'original_assignment_id', `${field}.original_assignment_id`);
  if (typeof originalAssignmentId !== 'string' || !isAssignmentId(originalAssignmentId)) {
    revisionError('invalid_format', `${field}.original_assignment_id`, 'original_assignment_id is not valid.');
  }
  const round = ownDataValue(value, 'round', `${field}.round`);
  const limit = ownDataValue(value, 'limit', `${field}.limit`);
  if (!Number.isSafeInteger(limit) || limit !== OWNED_CORRECTION_ROUND_LIMIT) {
    revisionError(
      'invalid_format',
      `${field}.limit`,
      `Correction round limit is the fixed ceiling of ${OWNED_CORRECTION_ROUND_LIMIT}.`,
    );
  }
  if (!Number.isSafeInteger(round) || round < 1 || round > limit) {
    revisionError('invalid_format', `${field}.round`, 'Correction round is outside the fixed ceiling.');
  }
  return freezeData({
    schema: OWNED_DELEGATION_SCHEMA_ID,
    version: OWNED_DELEGATION_VERSION,
    lineage: 'owned_revision',
    producer_run_id: producerRunId,
    producer_assignment_id: producerAssignmentId,
    reviewed_head: reviewedHead,
    original_run_id: originalRunId,
    original_assignment_id: originalAssignmentId,
    round,
    limit,
  });
}

export function compactOwnedCorrectionFollowV1(value, field = 'correction_follow') {
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, 'correction follow');
  assertDirectJsonClosure(value, field);
  for (const key of capturedOwnKeys(value)) {
    if (typeof key !== 'string') revisionError('symbol_key_denied', field);
    if (!capturedIncludes(OWNED_CORRECTION_FOLLOW_KEYS, key)) {
      revisionError('unknown_key', `${field}.${key}`, 'Correction follow is a closed machine record.');
    }
  }
  for (const key of OWNED_CORRECTION_FOLLOW_KEYS) {
    if (!capturedHasOwn(value, key)) {
      revisionError('missing_key', `${field}.${key}`, 'Correction follow is incomplete.');
    }
  }
  const childRunId = ownDataValue(value, 'child_run_id', `${field}.child_run_id`);
  assertRunId(childRunId, `${field}.child_run_id`);
  const childAssignmentId = ownDataValue(value, 'child_assignment_id', `${field}.child_assignment_id`);
  if (typeof childAssignmentId !== 'string' || !isAssignmentId(childAssignmentId)) {
    revisionError('invalid_format', `${field}.child_assignment_id`, 'child_assignment_id is not valid.');
  }
  const identityDigest = ownDataValue(value, 'identity_digest', `${field}.identity_digest`);
  if (typeof identityDigest !== 'string' || !capturedTest(IDEMPOTENCY_KEY_PATTERN, identityDigest)) {
    revisionError('invalid_format', `${field}.identity_digest`, 'identity_digest must be an exact sha256 digest.');
  }
  return freezeData({
    child_run_id: childRunId,
    child_assignment_id: childAssignmentId,
    identity_digest: identityDigest,
  });
}

export function ownedCorrectionPolicyV1(producer, field = 'revision') {
  if (!producer || typeof producer !== 'object') {
    revisionError('revision_producer_not_found', field, 'The named producer assignment is not known.');
  }
  if (typeof producer.run_id !== 'string') {
    revisionError('revision_producer_not_found', field, 'The named producer assignment is not known.');
  }
  assertRunId(producer.run_id, `${field}.run_id`);
  if (typeof producer.assignment_id !== 'string' || !isAssignmentId(producer.assignment_id)) {
    revisionError('invalid_format', `${field}.assignment_id`, 'assignment_id is not valid.');
  }
  if (producer.correction != null) {
    const parent = compactOwnedCorrectionLineageV1(producer.correction, `${field}.correction`);
    return freezeData({
      original_run_id: parent.original_run_id,
      original_assignment_id: parent.original_assignment_id,
      producer_run_id: producer.run_id,
      producer_assignment_id: producer.assignment_id,
      round: parent.round + 1,
      limit: parent.limit,
    });
  }
  return freezeData({
    original_run_id: producer.run_id,
    original_assignment_id: producer.assignment_id,
    producer_run_id: producer.run_id,
    producer_assignment_id: producer.assignment_id,
    round: 1,
    limit: OWNED_CORRECTION_ROUND_LIMIT,
  });
}

export function assertOwnedCorrectionBudgetV1(policy, field = 'revision') {
  if (!policy || typeof policy !== 'object'
    || !Number.isSafeInteger(policy.round)
    || !Number.isSafeInteger(policy.limit)
    || policy.limit !== OWNED_CORRECTION_ROUND_LIMIT) {
    revisionError('invalid_format', field, 'Correction round policy is invalid.');
  }
  if (policy.round > policy.limit) {
    revisionError('revision_budget_exhausted', field, REVISION_BUDGET_EXHAUSTED_MESSAGE);
  }
  if (policy.round < 1) {
    revisionError('invalid_format', `${field}.round`, 'Correction round is outside the fixed ceiling.');
  }
  return policy;
}

export function ownedCorrectionBudgetRemainingV1(correction) {
  if (correction == null) return true;
  if (typeof correction !== 'object') return false;
  const round = correction.round;
  const limit = correction.limit;
  if (!Number.isSafeInteger(round) || !Number.isSafeInteger(limit) || limit !== OWNED_CORRECTION_ROUND_LIMIT) {
    return false;
  }
  return round < limit;
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
  const unproven = producer.prompt_dispatched !== true
    || confidence !== AUTHORITATIVE_DISPATCH_CONFIDENCE
    || capturedIncludes(ACTIVE_OR_UNCERTAIN_PHASES, phase);
  if (unproven || !capturedIncludes(COMPLETED_PRODUCER_PHASES, phase)) {
    revisionError(
      'revision_producer_active',
      field,
      'A revision requires a completed, certain producer; active or uncertain tasks are never replayed.',
    );
  }
  if (typeof producer.task_id !== 'string' || producer.task_id.length === 0) {
    revisionError(
      'revision_lifecycle_unfinal',
      field,
      'A revision requires proven terminal lifecycle; a missing task is not a completed producer.',
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

function collectRetrievableArtifactRefs(value, assignmentId, refs) {
  if (!Array.isArray(value)) return;
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.relative_path !== 'string' || typeof entry.artifact_kind !== 'string') continue;
    const digest = typeof entry.sha256 === 'string'
      ? entry.sha256
      : (typeof entry.digest === 'string' ? entry.digest : null);
    if (typeof digest !== 'string') continue;
    refs.push(freezeData({
      kind: 'artifact',
      artifact_kind: entry.artifact_kind,
      relative_path: entry.relative_path,
      digest: digest.startsWith('sha256:') ? digest : `sha256:${digest}`,
      ...(typeof assignmentId === 'string' ? { assignment_id: assignmentId } : {}),
    }));
  }
}

export function projectOwnedProducerCandidateV1({
  record,
  assignment,
  lane,
  workspace = null,
} = {}) {
  if (!record || !assignment || !lane) {
    revisionError('revision_producer_not_found', 'producer', 'The named producer assignment is not known.');
  }
  if (assignment.provider === 'cursor-cloud') {
    revisionError(
      'revision_workspace_unsupported',
      'revision',
      'Remote candidate revision is not supported; a local inspectable HEAD is required.',
    );
  }
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    revisionError(
      'revision_workspace_uninspectable',
      'workspace',
      'A revision requires a fresh successful workspace inspection.',
    );
  }
  const head = typeof workspace.current_head === 'string'
    ? workspace.current_head.toLowerCase()
    : null;
  if (!isSha40(head)) {
    revisionError(
      'revision_workspace_uninspectable',
      'workspace.current_head',
      'A revision requires a fresh exact HEAD from a successful workspace inspection.',
    );
  }
  if (workspace.clean !== true && workspace.clean !== false) {
    revisionError(
      'revision_workspace_uninspectable',
      'workspace.clean',
      'A revision requires fresh clean proof from a successful workspace inspection.',
    );
  }
  const manifestAssignment = Array.isArray(record.compiled?.manifest?.assignments)
    ? record.compiled.manifest.assignments.find((entry) => entry?.assignment_id === assignment.assignment_id)
    : null;
  const evidenceRefs = [];
  collectRetrievableArtifactRefs(lane.artifact_refs, assignment.assignment_id, evidenceRefs);
  collectRetrievableArtifactRefs(record.artifact_refs, assignment.assignment_id, evidenceRefs);
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
    prompt: typeof assignment.prompt === 'string' ? assignment.prompt : null,
    acceptance: Array.isArray(manifestAssignment?.acceptance) ? [...manifestAssignment.acceptance] : [],
    required_evidence: Array.isArray(manifestAssignment?.required_evidence)
      ? [...manifestAssignment.required_evidence]
      : [],
    request_idempotency_key: record.compiled?.request_idempotency_key ?? null,
    phase: lane.phase ?? lane.status ?? null,
    status: lane.status ?? lane.phase ?? null,
    prompt_dispatched: lane.prompt_dispatched === true,
    dispatch_confidence: lane.dispatch_confidence ?? null,
    head,
    clean: workspace.clean === true,
    evidence_refs: evidenceRefs,
    ...(record.correction ? { correction: record.correction } : {}),
  });
}

export function deriveOwnedRevisionRequestV1(producer, revisionInput) {
  const revision = parseOwnedRevisionRequestV1(revisionInput);
  assertOwnedRevisionProducerV1(producer, revision);
  const policy = assertOwnedCorrectionBudgetV1(ownedCorrectionPolicyV1(producer));
  const identity = ownedRevisionIdentityV1({ producer, revision });
  const prompt = compileOwnedCorrectionPromptV1({
    producer_run_id: producer.run_id,
    producer_assignment_id: producer.assignment_id,
    feedback: revision.feedback,
    write_scope: producer.write_scope,
    provider: producer.provider,
    model: producer.model,
    access: producer.access,
    capabilities: producer.capabilities,
    objective: producer.objective,
    original_prompt: producer.prompt,
    acceptance: producer.acceptance,
    required_evidence: producer.required_evidence,
    expected_head: revision.expected_head,
  });
  const objective = `Correct the reviewed ${producer.assignment_id} candidate.`;
  const assignment = {
    assignment_id: producer.assignment_id,
    provider: producer.provider,
    model: producer.model,
    role: producer.role ?? 'implement',
    prompt,
    expected_duration_ms: producer.expected_duration_ms,
    write_scope: [...producer.write_scope],
    required: true,
    ...(Array.isArray(producer.capabilities)
      ? { capabilities: [...producer.capabilities] }
      : {}),
  };
  if (producer.access !== undefined) assignment.access = producer.access === 'writer' ? 'write' : producer.access;
  const correction = compactOwnedCorrectionLineageV1({
    schema: OWNED_DELEGATION_SCHEMA_ID,
    version: OWNED_DELEGATION_VERSION,
    lineage: 'owned_revision',
    producer_run_id: producer.run_id,
    producer_assignment_id: producer.assignment_id,
    reviewed_head: revision.expected_head,
    original_run_id: policy.original_run_id,
    original_assignment_id: policy.original_assignment_id,
    round: policy.round,
    limit: policy.limit,
  });
  return freezeData({
    schema: OWNED_DELEGATION_SCHEMA_ID,
    version: OWNED_DELEGATION_VERSION,
    identity,
    producer_run_id: producer.run_id,
    correction,
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
    ...(receipt.correction ? { correction: receipt.correction } : {}),
  });
}

capturedFreeze(parseOwnedRevisionRequestV1);
capturedFreeze(ownedRevisionIdentityV1);
capturedFreeze(compactOwnedCorrectionLineageV1);
capturedFreeze(compactOwnedCorrectionFollowV1);
capturedFreeze(ownedCorrectionPolicyV1);
capturedFreeze(assertOwnedCorrectionBudgetV1);
capturedFreeze(ownedCorrectionBudgetRemainingV1);
capturedFreeze(assertOwnedRevisionProducerV1);
capturedFreeze(projectOwnedProducerCandidateV1);
capturedFreeze(deriveOwnedRevisionRequestV1);
capturedFreeze(producerFromRunReceiptV1);
