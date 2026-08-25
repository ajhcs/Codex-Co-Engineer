// Ask-once selection persistence facade (P27).
//
// Additive v3 module. It derives the exact P05 SelectionRequestV1 from
// immutable manifest/profile/availability/capability inputs, persists that
// one question batch through an already-submitted R24A aggregate run at
// submitted@0, and later accepts one complete structured reply bound to the
// exact run/request/digest. Persistence uses only accepted R24A handle
// methods `commitSelectionRequest`, `getCoordination`, and
// `commitSelectionResolution`. After a successful or identical reply it
// verifies the accepted R25B `bindAggregateResolution` at
// resolution_ready@2 and returns a detached in-memory plan. Direct-plan
// runs fail `no_selection_required` and never call `commitResolvedPlan`.
// This module does not import or invoke provider, supervisor, workspace,
// server, scheduler, or P25 event surfaces. The returned question is
// presentation data, not an AttentionBatchV1.

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify, runManifestDigestV1 } from './identity.mjs';
import {
  assertBoundDigest,
  snapshotRecord,
  validateRunIdentityV1,
} from './protected-identity.mjs';
import {
  MAX_SELECTION_QUESTIONS,
  classifySelectionAnswersV1,
  resolveRunSelectionV1,
  resolveSelectionAnswersV1,
  selectionRequestIdentity,
  validateSelectionRequestV1,
} from './resolver.mjs';
import { bindAggregateResolution } from './run-journal.mjs';
import { MAX_ASSIGNMENTS, assertRunId } from './run-manifest.mjs';
import {
  AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
  AGGREGATE_SELECTION_REPLY_SCHEMA_ID,
} from './aggregate-run-anchor.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';

export const SELECTION_QUESTION_BATCH_RECEIPT_SCHEMA_ID =
  'codex-co-engineer.selection-question-batch-receipt.v1';
export const SELECTION_REPLY_RECEIPT_SCHEMA_ID =
  'codex-co-engineer.selection-reply-receipt.v1';

export const SELECTION_PERSISTENCE_INPUT_KEYS = capturedFreeze([
  'anchor', 'availability', 'capabilities', 'identity', 'manifest', 'profiles',
]);
export const SELECTION_REPLY_INPUT_KEYS = capturedFreeze([
  ...SELECTION_PERSISTENCE_INPUT_KEYS, 'reply',
]);
export const SELECTION_STRUCTURED_REPLY_KEYS = capturedFreeze([
  'answers', 'digest', 'request_id', 'run_id',
]);

const PERSIST_REQUIRED_KEYS = capturedFreeze([
  'anchor', 'availability', 'capabilities', 'identity', 'manifest',
]);
const REPLY_REQUIRED_KEYS = capturedFreeze([
  ...PERSIST_REQUIRED_KEYS, 'reply',
]);
const JSON_INPUT_KEYS = capturedFreeze([
  'availability', 'capabilities', 'identity', 'manifest', 'profiles', 'reply',
]);

const TRUSTED_ANCHOR_METHODS = capturedFreeze([
  'commitSelectionRequest',
  'commitSelectionResolution',
  'getByRunId',
  'getCoordination',
]);

function assertTrustedAnchor(anchor) {
  assertNotProxy(anchor, '$.anchor');
  if (anchor === undefined || anchor === null || typeof anchor !== 'object'
    || capturedIsArray(anchor)) {
    fail('invalid_type', '$.anchor',
      '$.anchor must be a trusted openAggregateRunAnchor(...) handle.');
  }
  if (typeof anchor.root !== 'string' || typeof anchor.marker_digest !== 'string') {
    fail('invalid_type', '$.anchor',
      '$.anchor must expose the accepted R24A root marker identity.');
  }
  assertBoundDigest(anchor.marker_digest, '$.anchor.marker_digest');
  for (const method of TRUSTED_ANCHOR_METHODS) {
    if (typeof anchor[method] !== 'function') {
      fail('invalid_type', `$.anchor.${method}`,
        `$.anchor.${method} must be the accepted R24A handle method.`);
    }
  }
  return anchor;
}

function parseFacadeOptions(options, allowed, required) {
  if (options === undefined || options === null) {
    fail('invalid_type', '$', 'P27 options must be a plain object.');
  }
  assertNotProxy(options, '$');
  if (typeof options !== 'object' || capturedIsArray(options)) {
    fail('invalid_type', '$', 'P27 options must be a plain object.');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', '$[symbol]',
        'P27 options carry a symbol-keyed property; selection data is direct JSON only.');
    }
  }
  for (const key of sortedCapturedKeys(options)) {
    if (!capturedIncludes(allowed, key)) {
      fail('unknown_key', `$.${key}`, `$.${key} is not a closed P27 option.`);
    }
  }
  for (const key of required) {
    if (!capturedHasOwn(options, key)) {
      fail('missing_key', `$.${key}`, `$.${key} is required.`);
    }
  }
  const anchor = assertTrustedAnchor(ownDataValue(options, 'anchor', '$.anchor'));
  const json = {};
  for (const key of JSON_INPUT_KEYS) {
    if (!capturedIncludes(allowed, key) || !capturedHasOwn(options, key)) continue;
    const value = ownDataValue(options, key, `$.${key}`);
    assertDirectJsonClosure(value, `$.${key}`);
    json[key] = snapshotRecord(value);
  }
  return { anchor, json };
}

function resolverOptions(json) {
  const options = {
    availability: json.availability,
    capabilities: json.capabilities,
    manifest: json.manifest,
  };
  if (json.profiles !== undefined) options.profiles = json.profiles;
  return options;
}

function deriveOutstandingRequest(json) {
  const identity = validateRunIdentityV1(json.identity);
  assertRunId(identity.run_id, '$.identity.run_id');
  const plan = resolveRunSelectionV1(resolverOptions(json));
  const manifestDigest = runManifestDigestV1(json.manifest).digest;
  if (plan.run_id !== identity.run_id) {
    fail('identity_mismatch', '$.manifest.run_id',
      'The manifest run id does not match the supplied run identity.');
  }
  if (manifestDigest !== identity.manifest_digest) {
    fail('identity_mismatch', '$.identity.manifest_digest',
      'The supplied run identity does not bind this exact manifest digest.');
  }
  if (plan.complete === true || plan.selection_request === null
    || plan.selection_request === undefined) {
    fail('no_selection_required', '$.manifest',
      'This run has no outstanding SelectionRequestV1; P27 does not persist a direct plan.');
  }
  validateSelectionRequestV1(plan.selection_request);
  const requestIdentity = selectionRequestIdentity(plan.selection_request);
  if (requestIdentity.run_id !== identity.run_id) {
    fail('identity_mismatch', '$.selection_request.run_id',
      'The derived selection request does not bind the supplied run identity.');
  }
  const questionCount = plan.selection_request.question_count;
  if (typeof questionCount !== 'number' || questionCount < 1) {
    fail('no_selection_required', '$.selection_request.questions',
      'P27 requires one nonempty SelectionRequestV1.');
  }
  if (questionCount > MAX_SELECTION_QUESTIONS || questionCount > MAX_ASSIGNMENTS) {
    fail('invalid_selection_request', '$.selection_request.questions',
      `P27 persists at most ${MAX_SELECTION_QUESTIONS} selection questions.`);
  }
  return {
    identity,
    plan,
    request: plan.selection_request,
    requestIdentity,
  };
}

function assertSubmittedIdentity(record, identity) {
  if (record.run_id !== identity.run_id) {
    fail('identity_mismatch', '$.identity.run_id',
      'The durable aggregate run id does not match the supplied run identity.');
  }
  if (record.manifest_digest !== identity.manifest_digest) {
    fail('identity_mismatch', '$.identity.manifest_digest',
      'The durable aggregate run binds a different manifest digest.');
  }
  const submittedIdentity = validateRunIdentityV1(record.identity);
  if (submittedIdentity.digest !== identity.digest) {
    fail('identity_mismatch', '$.identity',
      'The durable aggregate run identity does not match the supplied identity.');
  }
}

function sameRequestTriple(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined
    && left.run_id === right.run_id
    && left.request_id === right.request_id
    && left.digest === right.digest;
}

function projectCoordination(coordination) {
  return snapshotRecord({
    phase: coordination.phase,
    revision: coordination.revision,
    run_id: coordination.run_id,
    anchor_digest: coordination.anchor_digest,
    state_digest: coordination.state_digest,
    selection_request_binding: coordination.selection_request_binding,
    selection_reply_digest: coordination.selection_reply_digest,
    resolved_plan_digest: coordination.resolved_plan_digest,
  });
}

function questionBatchReceipt({ created, request, requestIdentity, coordination }) {
  return freezeData({
    schema: SELECTION_QUESTION_BATCH_RECEIPT_SCHEMA_ID,
    run_id: requestIdentity.run_id,
    request_id: requestIdentity.request_id,
    digest: requestIdentity.digest,
    availability_digest: request.availability_digest,
    capability_snapshot_digest: request.capability_snapshot_digest,
    created: created === true,
    disposition: coordination.phase,
    question_count: request.question_count,
    selection_request: snapshotRecord(request),
    coordination: projectCoordination(coordination),
  });
}

function persistableAnswers(request, answers) {
  const questions = optOwn(request, 'questions');
  const byId = new Map();
  for (let index = 0; index < questions.length; index += 1) {
    const question = ownDataValue(questions, String(index), `$.questions[${index}]`);
    byId.set(optOwn(question, 'assignment_id'), question);
  }
  const stored = [];
  for (let index = 0; index < answers.length; index += 1) {
    const answer = ownDataValue(answers, String(index), `$.reply.answers[${index}]`);
    const assignmentId = optOwn(answer, 'assignment_id');
    const question = byId.get(assignmentId);
    const provider = optOwn(question, 'answer_scope') === 'model_only'
      ? optOwn(optOwn(question, 'requested'), 'provider')
      : optOwn(answer, 'provider');
    stored.push({
      assignment_id: assignmentId,
      model: optOwn(answer, 'model'),
      provider,
    });
  }
  return stored;
}

function replyReceipt({
  created, requestIdentity, request, plan, coordination, binding,
}) {
  return freezeData({
    schema: SELECTION_REPLY_RECEIPT_SCHEMA_ID,
    run_id: requestIdentity.run_id,
    request_id: requestIdentity.request_id,
    digest: requestIdentity.digest,
    availability_digest: request.availability_digest,
    capability_snapshot_digest: request.capability_snapshot_digest,
    created: created === true,
    disposition: coordination.phase,
    plan: snapshotRecord(plan),
    aggregate_binding: snapshotRecord(binding),
    coordination: projectCoordination(coordination),
  });
}

export async function persistSelectionQuestionBatch(options = {}) {
  const { anchor, json } = parseFacadeOptions(
    options, SELECTION_PERSISTENCE_INPUT_KEYS, PERSIST_REQUIRED_KEYS,
  );
  const derived = deriveOutstandingRequest(json);
  const submitted = await anchor.getByRunId(derived.identity.run_id);
  assertSubmittedIdentity(submitted, derived.identity);
  const coordination = await anchor.getCoordination(derived.identity.run_id);
  if (coordination.phase === 'awaiting_selection') {
    if (!sameRequestTriple(coordination.selection_request_binding, derived.requestIdentity)) {
      fail('stale_selection_request', '$.manifest',
        'A different selection request is already bound to this run; P27 never generates a second batch.');
    }
  } else if (coordination.phase !== 'submitted' || coordination.revision !== 0) {
    fail('aggregate_run_revision_conflict', 'coordination',
      'persistSelectionQuestionBatch requires submitted@0 or an identical awaiting_selection replay.');
  }
  const committed = await anchor.commitSelectionRequest({
    run_id: derived.identity.run_id,
    expected_revision: 0,
    request_identity: derived.requestIdentity,
    record: derived.request,
  });
  const receipt = questionBatchReceipt({
    created: committed.created,
    request: derived.request,
    requestIdentity: derived.requestIdentity,
    coordination: committed.coordination,
  });
  if (receipt.disposition !== 'awaiting_selection' || receipt.coordination.revision !== 1) {
    fail('aggregate_run_revision_conflict', 'coordination',
      'Persisting a selection question must settle at awaiting_selection@1.');
  }
  if (!sameRequestTriple(receipt.coordination.selection_request_binding, derived.requestIdentity)) {
    fail('stale_selection_request', 'coordination',
      'The durable selection binding does not match the derived request identity.');
  }
  if (canonicalJsonStringify(receipt.selection_request)
    !== canonicalJsonStringify(derived.request)) {
    fail('stale_selection_request', 'selection_request',
      'The returned question batch is not byte-identical to the derived SelectionRequestV1.');
  }
  return receipt;
}

function parseStructuredReply(reply, requestIdentity) {
  const fields = {};
  for (const key of sortedCapturedKeys(reply)) {
    if (!capturedIncludes(SELECTION_STRUCTURED_REPLY_KEYS, key)) {
      fail('unknown_key', `$.reply.${key}`, `$.reply.${key} is not a structured reply field.`);
    }
  }
  for (const key of SELECTION_STRUCTURED_REPLY_KEYS) {
    if (!hasOwn(reply, key)) {
      fail('missing_key', `$.reply.${key}`, `$.reply.${key} is required.`);
    }
    fields[key] = ownDataValue(reply, key, `$.reply.${key}`);
  }
  assertRunId(fields.run_id, '$.reply.run_id');
  if (fields.run_id !== requestIdentity.run_id
    || fields.request_id !== requestIdentity.request_id
    || fields.digest !== requestIdentity.digest) {
    fail('stale_selection_request', '$.reply',
      'The structured reply does not bind the exact derived run/request/digest identity.');
  }
  assertNotProxy(fields.answers, '$.reply.answers');
  assertDirectJsonClosure(fields.answers, '$.reply.answers');
  if (!capturedIsArray(fields.answers)) {
    fail('invalid_type', '$.reply.answers', '$.reply.answers must be a dense JSON array.');
  }
  return fields;
}

function requireAwaitingOrReplay(coordination, requestIdentity) {
  if (coordination.phase === 'awaiting_selection' && coordination.revision === 1) {
    if (!sameRequestTriple(coordination.selection_request_binding, requestIdentity)) {
      fail('stale_selection_request', 'coordination',
        'Durable coordination is awaiting a different selection request identity.');
    }
    return;
  }
  if (coordination.phase === 'resolution_ready' && coordination.revision === 2) {
    if (!sameRequestTriple(coordination.selection_request_binding, requestIdentity)) {
      fail('stale_selection_request', 'coordination',
        'A different selection request already settled this run.');
    }
    return;
  }
  if (coordination.phase === 'submitted' || coordination.selection_request_binding === null) {
    fail('selection_not_awaiting', 'coordination',
      'acceptSelectionReply requires a durable awaiting_selection@1 question; it does not create one.');
  }
  if (coordination.phase === 'resolution_ready' && coordination.revision === 1) {
    fail('no_selection_required', 'coordination',
      'Direct-plan resolution_ready@1 is outside P27 and cannot accept a selection reply.');
  }
  fail('aggregate_run_revision_conflict', 'coordination',
    'acceptSelectionReply requires awaiting_selection@1 or an identical resolution_ready@2 replay.');
}

export async function acceptSelectionReply(options = {}) {
  const { anchor, json } = parseFacadeOptions(
    options, SELECTION_REPLY_INPUT_KEYS, REPLY_REQUIRED_KEYS,
  );
  const derived = deriveOutstandingRequest(json);
  const submitted = await anchor.getByRunId(derived.identity.run_id);
  assertSubmittedIdentity(submitted, derived.identity);
  const coordination = await anchor.getCoordination(derived.identity.run_id);
  requireAwaitingOrReplay(coordination, derived.requestIdentity);
  const reply = parseStructuredReply(json.reply, derived.requestIdentity);
  const classification = classifySelectionAnswersV1(
    derived.request, reply.answers, {
      digest: reply.digest,
      request_id: reply.request_id,
      run_id: reply.run_id,
    },
  );
  if (classification.ok !== true) {
    const codes = classification.problems.map((problem) => problem.code).join(', ');
    fail('selection_answers_rejected', '$.reply.answers',
      `The structured reply was not an acceptable complete answer batch (${codes}).`);
  }
  const answered = resolveSelectionAnswersV1({
    ...resolverOptions(json),
    answers: reply.answers,
    replyIdentity: {
      digest: reply.digest,
      request_id: reply.request_id,
      run_id: reply.run_id,
    },
    request: derived.request,
  });
  if (answered.plan.complete !== true || answered.plan.selection_request !== null) {
    fail('answered_run_incomplete', '$.reply',
      'Re-resolution did not produce a complete plan; P27 refuses a partial reply.');
  }
  if (answered.availability_digest !== derived.plan.availability_digest
    || answered.capability_snapshot_digest !== derived.plan.capability_snapshot_digest
    || answered.digest !== derived.requestIdentity.digest) {
    fail('selection_snapshot_mismatch', '$.reply',
      'Answer re-resolution moved snapshot or request identity; refusing.');
  }
  const committed = await anchor.commitSelectionResolution({
    run_id: derived.identity.run_id,
    expected_revision: 1,
    request_identity: derived.requestIdentity,
    reply_record: {
      schema: AGGREGATE_SELECTION_REPLY_SCHEMA_ID,
      run_id: derived.identity.run_id,
      request_id: derived.requestIdentity.request_id,
      answers: persistableAnswers(derived.request, reply.answers),
    },
    resolved_plan_record: {
      schema: AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
      run_id: derived.identity.run_id,
      complete: true,
    },
  });
  if (committed.coordination.phase !== 'resolution_ready'
    || committed.coordination.revision !== 2) {
    fail('aggregate_run_revision_conflict', 'coordination',
      'Selection reply settlement must land at resolution_ready@2.');
  }
  const binding = await bindAggregateResolution(anchor, derived.identity.run_id);
  if (binding.phase !== 'resolution_ready' || binding.revision !== 2) {
    fail('run_journal_aggregate_not_ready', 'aggregate_binding',
      'P27 requires the accepted R25B resolution_ready revision 2 binding before returning.');
  }
  if (binding.run_id !== derived.identity.run_id
    || binding.resolved_plan_digest !== committed.coordination.resolved_plan_digest) {
    fail('run_journal_aggregate_mismatch', 'aggregate_binding',
      'The aggregate binding does not match the settled selection resolution.');
  }
  return replyReceipt({
    created: committed.created,
    requestIdentity: derived.requestIdentity,
    request: derived.request,
    plan: answered.plan,
    coordination: committed.coordination,
    binding,
  });
}

capturedFreeze(persistSelectionQuestionBatch);
capturedFreeze(acceptSelectionReply);
