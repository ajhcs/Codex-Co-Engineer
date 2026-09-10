// Compact machine-derived coordination packet for review and correction
// handoffs. Candidate Git identity, existing evidence refs, unresolved work,
// and the exact next action — not a reconstructed prompt or receipt.

import {
  capturedFreeze,
  capturedIncludes,
  capturedTest,
} from './grammar.mjs';
import { freezeData } from './selection-json.mjs';

export const RUN_COORDINATION_RESPONSE_SCHEMA_ID = 'codex-co-engineer.run-coordination-response.v1';
export const RUN_COORDINATION_RESPONSE_VERSION = 1;

const SHA40 = /^[0-9a-fA-F]{40}$/u;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;
const COMPLETED = capturedFreeze(['completed', 'succeeded']);
const FAILED = capturedFreeze([
  'failed', 'failed_pre_prompt', 'timeout', 'timed_out', 'cancelled',
  'transport_lost', 'environment_blocked', 'unrecoverable_post_prompt',
]);
const ATTENTION = capturedFreeze(['needs_attention', 'awaiting_consent']);
const ACTIVE = capturedFreeze([
  'accepted', 'starting', 'running', 'cancelling', 'dispatching',
  'preparing_workspaces', 'validating', 'prompt_dispatched', 'session_ready',
  'prepared', 'planned',
]);
const NEXT_ACTIONS = capturedFreeze([
  'wait', 'reply', 'revision', 'review', 'inspect', 'none', 'resubmit',
]);

function compactSha(value) {
  return typeof value === 'string' && capturedTest(SHA40, value)
    ? value.toLowerCase()
    : null;
}

function compactDigest(value) {
  if (typeof value !== 'string' || !capturedTest(DIGEST, value)) return null;
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function laneStatus(lane) {
  if (typeof lane?.status === 'string' && lane.status.length > 0) return lane.status;
  if (typeof lane?.phase === 'string' && lane.phase.length > 0) return lane.phase;
  return null;
}

function pushRef(refs, seen, entry) {
  const digest = compactDigest(entry.digest);
  if (digest === null) return;
  const relativePath = typeof entry.relative_path === 'string' ? entry.relative_path : null;
  const key = `${entry.kind}:${entry.assignment_id ?? ''}:${relativePath ?? ''}:${digest}`;
  if (seen.has(key)) return;
  seen.add(key);
  refs.push(freezeData({
    kind: entry.kind,
    digest,
    ...(typeof entry.assignment_id === 'string' ? { assignment_id: entry.assignment_id } : {}),
    ...(typeof entry.artifact_kind === 'string' ? { artifact_kind: entry.artifact_kind } : {}),
    ...(relativePath ? { relative_path: relativePath } : {}),
  }));
}

function isRetrievableArtifactRef(ref) {
  if (!ref || typeof ref !== 'object') return false;
  const kind = typeof ref.artifact_kind === 'string' ? ref.artifact_kind : null;
  const relativePath = typeof ref.relative_path === 'string' ? ref.relative_path : null;
  const digest = compactDigest(ref.sha256 ?? ref.digest);
  return kind !== null && relativePath !== null && digest !== null;
}

function collectEvidenceRefs(receipt) {
  const refs = [];
  const seen = new Set();
  const lanes = Array.isArray(receipt?.lanes) ? receipt.lanes : [];
  for (const lane of lanes) {
    const assignmentId = typeof lane?.assignment_id === 'string' ? lane.assignment_id : undefined;
    const extra = [
      ...(Array.isArray(lane?.artifact_refs) ? lane.artifact_refs : []),
      ...(Array.isArray(lane?.evidence_refs) ? lane.evidence_refs : []),
    ];
    for (const ref of extra.slice(0, 8)) {
      if (!isRetrievableArtifactRef(ref)) continue;
      pushRef(refs, seen, {
        kind: 'artifact',
        assignment_id: assignmentId,
        digest: ref.sha256 ?? ref.digest,
        artifact_kind: ref.artifact_kind,
        relative_path: ref.relative_path,
      });
    }
  }
  const top = [
    ...(Array.isArray(receipt?.artifact_refs) ? receipt.artifact_refs : []),
    ...(Array.isArray(receipt?.evidence_refs) ? receipt.evidence_refs : []),
  ];
  for (const ref of top.slice(0, 8)) {
    if (!isRetrievableArtifactRef(ref)) continue;
    pushRef(refs, seen, {
      kind: 'artifact',
      digest: ref.sha256 ?? ref.digest,
      assignment_id: typeof ref.assignment_id === 'string' ? ref.assignment_id : undefined,
      artifact_kind: ref.artifact_kind,
      relative_path: ref.relative_path,
    });
  }
  return refs.slice(0, 16);
}

function laneClean(lane) {
  if (typeof lane?.clean === 'boolean') return lane.clean;
  if (typeof lane?.handoff?.clean === 'boolean') return lane.handoff.clean;
  return null;
}

function laneCleanupIncomplete(lane, receipt) {
  if (lane?.task_final === false && capturedIncludes(COMPLETED, laneStatus(lane))) return true;
  if (lane?.status === 'lifecycle_pending' || lane?.phase === 'lifecycle_pending') return true;
  const cleanup = receipt?.cleanup;
  if (cleanup?.proof_bound === false) return true;
  if (Array.isArray(cleanup?.unresolved) && cleanup.unresolved.length > 0) return true;
  if (receipt?.blockers?.cleanup === true) return true;
  return false;
}

function collectUnresolved(lanes, receipt) {
  const unresolved = [];
  for (const lane of lanes.slice(0, 8)) {
    const status = laneStatus(lane);
    const required = lane?.required !== false;
    const clean = laneClean(lane);
    let reason = null;
    if (laneCleanupIncomplete(lane, receipt)) reason = 'cleanup';
    else if (clean === false) reason = 'dirty';
    else if (lane?.dispatch_confidence === 'uncertain' || lane?.dispatch_confidence === 'not_sent') {
      reason = 'uncertain';
    } else if (status === null) reason = 'unresolved';
    else if (capturedIncludes(ATTENTION, status)) reason = 'needs_attention';
    else if (capturedIncludes(FAILED, status)) reason = 'failed';
    else if (capturedIncludes(ACTIVE, status)) reason = 'active';
    else if (capturedIncludes(COMPLETED, status)) {
      if (clean !== true || lane?.dispatch_confidence !== 'authoritative' || lane?.prompt_dispatched !== true) {
        reason = 'unresolved';
      } else {
        continue;
      }
    } else reason = 'unresolved';
    unresolved.push(freezeData({
      assignment_id: typeof lane?.assignment_id === 'string' ? lane.assignment_id : null,
      status,
      required,
      reason,
    }));
  }
  return unresolved;
}

function isProvenCompletedCleanWriter(lane) {
  return capturedIncludes(COMPLETED, laneStatus(lane))
    && (lane?.access === 'writer' || lane?.access === 'write' || lane?.role === 'implement')
    && laneClean(lane) === true
    && lane?.dispatch_confidence === 'authoritative'
    && lane?.prompt_dispatched === true;
}

function chooseNextAction(receipt, lanes, unresolved) {
  const runId = typeof receipt?.run_id === 'string' ? receipt.run_id : null;
  if (receipt?.persisted === false) {
    return freezeData({
      tool: 'delegate',
      operation: 'submit',
      run_id: null,
      action: 'resubmit',
    });
  }
  if (receipt?.attention?.status === 'open' || unresolved.some((item) => item.reason === 'needs_attention')) {
    return freezeData({
      tool: 'task',
      operation: 'reply',
      run_id: runId,
      action: 'reply',
    });
  }
  if (unresolved.some((item) => item.reason === 'active' || item.reason === 'uncertain')) {
    return freezeData({
      tool: 'task',
      operation: 'wait',
      run_id: runId,
      action: 'wait',
    });
  }
  const failed = unresolved.find((item) => (
    item.reason === 'failed'
    || item.reason === 'dirty'
    || item.reason === 'cleanup'
    || item.reason === 'unresolved'
  ));
  if (failed) {
    return freezeData({
      tool: 'task',
      operation: 'status',
      run_id: runId,
      assignment_id: failed.assignment_id,
      action: 'inspect',
    });
  }
  if (unresolved.length === 0 && lanes.some((lane) => capturedIncludes(COMPLETED, laneStatus(lane)))) {
    return freezeData({
      tool: 'task',
      operation: 'status',
      run_id: runId,
      action: 'review',
    });
  }
  return freezeData({
    tool: 'task',
    operation: 'status',
    run_id: runId,
    action: 'none',
  });
}

function collectProducers(receipt, lanes) {
  const requestKey = compactDigest(receipt?.request_idempotency_key);
  return lanes.slice(0, 8).map((lane) => freezeData({
    assignment_id: typeof lane?.assignment_id === 'string' ? lane.assignment_id : null,
    status: laneStatus(lane),
    head: compactSha(lane?.head)
      ?? compactSha(lane?.handoff?.current_head)
      ?? compactSha(lane?.handoff?.head),
    clean: laneClean(lane),
    request_idempotency_key: compactDigest(lane?.request_idempotency_key) ?? requestKey,
    role: typeof lane?.role === 'string' ? lane.role : null,
    access: typeof lane?.access === 'string' ? lane.access : null,
  }));
}

function collectAvailableActions(nextAction, lanes, unresolved) {
  const actions = [];
  if (typeof nextAction?.action === 'string' && capturedIncludes(NEXT_ACTIONS, nextAction.action)
    && nextAction.action !== 'none') {
    actions.push(nextAction.action);
  }
  const completedCleanWriter = unresolved.length === 0 && lanes.some(isProvenCompletedCleanWriter);
  if (completedCleanWriter && !actions.includes('revision')) {
    actions.push('revision');
  }
  return actions;
}

export function projectRunCoordinationResponseV1(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return freezeData({
      schema: RUN_COORDINATION_RESPONSE_SCHEMA_ID,
      version: RUN_COORDINATION_RESPONSE_VERSION,
      run_id: null,
      persisted: false,
      request_idempotency_key: null,
      git: null,
      producers: [],
      evidence_refs: [],
      unresolved: [],
      next_action: freezeData({
        tool: 'task',
        operation: 'status',
        run_id: null,
        action: 'none',
      }),
      available_actions: [],
    });
  }
  const lanes = Array.isArray(receipt.lanes) ? receipt.lanes : [];
  const git = freezeData({
    head: compactSha(receipt.git?.head) ?? compactSha(receipt.candidate?.head) ?? null,
    base_sha: compactSha(receipt.git?.base_sha) ?? compactSha(receipt.base_sha),
    digest: compactDigest(receipt.git?.digest),
    clean: typeof receipt.candidate?.clean === 'boolean'
      ? receipt.candidate.clean
      : (typeof receipt.git?.clean === 'boolean' ? receipt.git.clean : null),
  });
  const unresolved = collectUnresolved(lanes, receipt);
  const nextAction = chooseNextAction(receipt, lanes, unresolved);
  return freezeData({
    schema: RUN_COORDINATION_RESPONSE_SCHEMA_ID,
    version: RUN_COORDINATION_RESPONSE_VERSION,
    run_id: receipt.persisted === false
      ? null
      : (typeof receipt.run_id === 'string' ? receipt.run_id : null),
    persisted: receipt.persisted !== false,
    request_idempotency_key: compactDigest(receipt.request_idempotency_key),
    git,
    producers: collectProducers(receipt, lanes),
    evidence_refs: collectEvidenceRefs(receipt),
    unresolved,
    next_action: nextAction,
    available_actions: collectAvailableActions(nextAction, lanes, unresolved),
  });
}

capturedFreeze(projectRunCoordinationResponseV1);
capturedFreeze(NEXT_ACTIONS);
