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
  'wait', 'reply', 'revision', 'review', 'inspect', 'none',
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
  const key = `${entry.kind}:${entry.assignment_id ?? ''}:${digest}`;
  if (seen.has(key)) return;
  seen.add(key);
  refs.push(freezeData({
    kind: entry.kind,
    digest,
    ...(typeof entry.assignment_id === 'string' ? { assignment_id: entry.assignment_id } : {}),
  }));
}

function collectEvidenceRefs(receipt) {
  const refs = [];
  const seen = new Set();
  const gitDigest = compactDigest(receipt?.git?.digest);
  if (gitDigest) pushRef(refs, seen, { kind: 'git_identity', digest: gitDigest });
  const lanes = Array.isArray(receipt?.lanes) ? receipt.lanes : [];
  for (const lane of lanes) {
    const assignmentId = typeof lane?.assignment_id === 'string' ? lane.assignment_id : undefined;
    pushRef(refs, seen, {
      kind: 'child_identity',
      assignment_id: assignmentId,
      digest: lane?.child_identity_digest ?? lane?.child_identity?.digest,
    });
    pushRef(refs, seen, {
      kind: 'prompt_envelope',
      assignment_id: assignmentId,
      digest: lane?.prompt_envelope_digest,
    });
    pushRef(refs, seen, {
      kind: 'provider_run',
      assignment_id: assignmentId,
      digest: lane?.provider_run_identity_digest ?? lane?.provider_run_identity?.digest,
    });
    const extra = Array.isArray(lane?.evidence_refs) ? lane.evidence_refs : [];
    for (const ref of extra.slice(0, 8)) {
      if (!ref || typeof ref !== 'object') continue;
      pushRef(refs, seen, {
        kind: typeof ref.kind === 'string' ? ref.kind : 'evidence',
        assignment_id: assignmentId,
        digest: ref.digest,
      });
    }
  }
  const top = Array.isArray(receipt?.evidence_refs) ? receipt.evidence_refs : [];
  for (const ref of top.slice(0, 8)) {
    if (!ref || typeof ref !== 'object') continue;
    pushRef(refs, seen, {
      kind: typeof ref.kind === 'string' ? ref.kind : 'evidence',
      digest: ref.digest,
      assignment_id: typeof ref.assignment_id === 'string' ? ref.assignment_id : undefined,
    });
  }
  return refs.slice(0, 16);
}

function collectUnresolved(lanes) {
  const unresolved = [];
  for (const lane of lanes.slice(0, 8)) {
    const status = laneStatus(lane);
    if (status === null || capturedIncludes(COMPLETED, status)) continue;
    const required = lane?.required !== false;
    let reason = 'unresolved';
    if (capturedIncludes(ATTENTION, status)) reason = 'needs_attention';
    else if (capturedIncludes(FAILED, status)) reason = 'failed';
    else if (capturedIncludes(ACTIVE, status)) reason = 'active';
    else if (lane?.dispatch_confidence === 'uncertain') reason = 'uncertain';
    else if (lane?.handoff?.clean === false) reason = 'dirty';
    unresolved.push(freezeData({
      assignment_id: typeof lane?.assignment_id === 'string' ? lane.assignment_id : null,
      status,
      required,
      reason,
    }));
  }
  return unresolved;
}

function chooseNextAction(receipt, lanes, unresolved) {
  const runId = typeof receipt?.run_id === 'string' ? receipt.run_id : null;
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
  const failed = unresolved.find((item) => item.reason === 'failed' || item.reason === 'dirty');
  if (failed) {
    return freezeData({
      tool: 'task',
      operation: 'status',
      run_id: runId,
      assignment_id: failed.assignment_id,
      action: 'inspect',
    });
  }
  const completedWriter = lanes.find((lane) => (
    capturedIncludes(COMPLETED, laneStatus(lane))
    && (lane?.access === 'writer' || lane?.access === 'write' || lane?.role === 'implement')
    && lane?.handoff?.clean !== false
  ));
  if (completedWriter && unresolved.length === 0) {
    return freezeData({
      tool: 'task',
      operation: 'revision',
      run_id: runId,
      assignment_id: completedWriter.assignment_id ?? null,
      action: 'revision',
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

export function projectRunCoordinationResponseV1(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return freezeData({
      schema: RUN_COORDINATION_RESPONSE_SCHEMA_ID,
      version: RUN_COORDINATION_RESPONSE_VERSION,
      run_id: null,
      git: null,
      evidence_refs: [],
      unresolved: [],
      next_action: freezeData({
        tool: 'task',
        operation: 'status',
        run_id: null,
        action: 'none',
      }),
    });
  }
  const lanes = Array.isArray(receipt.lanes) ? receipt.lanes : [];
  const handoff = receipt.handoff && typeof receipt.handoff === 'object' ? receipt.handoff : null;
  const laneHead = lanes
    .map((lane) => compactSha(lane?.handoff?.current_head) ?? compactSha(lane?.handoff?.head))
    .find((value) => value !== null) ?? null;
  const git = freezeData({
    head: compactSha(receipt.git?.head)
      ?? compactSha(handoff?.current_head)
      ?? laneHead,
    base_sha: compactSha(receipt.git?.base_sha) ?? compactSha(receipt.base_sha),
    digest: compactDigest(receipt.git?.digest),
    clean: typeof handoff?.clean === 'boolean'
      ? handoff.clean
      : (typeof receipt.clean === 'boolean' ? receipt.clean : null),
  });
  const unresolved = collectUnresolved(lanes);
  const nextAction = chooseNextAction(receipt, lanes, unresolved);
  return freezeData({
    schema: RUN_COORDINATION_RESPONSE_SCHEMA_ID,
    version: RUN_COORDINATION_RESPONSE_VERSION,
    run_id: typeof receipt.run_id === 'string' ? receipt.run_id : null,
    git,
    evidence_refs: collectEvidenceRefs(receipt),
    unresolved,
    next_action: nextAction,
  });
}

capturedFreeze(projectRunCoordinationResponseV1);
capturedFreeze(NEXT_ACTIONS);
