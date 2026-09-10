// RunResultEvidenceV1 — bounded shareable projection of simple run-admission
// receipts onto existing usage-ledger and local-outcome components.
//
// The admission adapter calls this projection on its measured receipt facts.
// This module is not an MCP tool,
// does not scrape private Codex state, and does not dump a usage ledger
// into every wait. Summary is the default; detail is on-demand.
//
// Completed provider work is not Codex acceptance. Provider PASS is not
// promoted. Missing native/provider tokens and subscription balances stay
// unknown. Bytes stay labeled as bytes. Savings are never inferred.

import { Buffer as NodeBuffer } from 'node:buffer';

import {
  compareArtifactRefsV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  LOCAL_OUTCOME_SCHEMA_ID,
  LOCAL_OUTCOME_VERSION,
  PUBLIC_LABEL_ACCEPTED,
  PUBLIC_LABEL_FAILED,
  PUBLIC_LABEL_IN_PROGRESS,
  PUBLIC_LABEL_REVIEW_NEEDED,
  PUBLIC_LABEL_UNRESOLVED,
  TRUNCATION_KEYS,
  projectLocalOutcomeCardV1,
} from './final-decision-card.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  capturedUtf8ByteLength,
  isKnownProvider,
  isKnownRole,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  assertRunId,
  isAssignmentId,
  isSha40,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
} from './selection-json.mjs';
import {
  MAX_USAGE_DETAIL_BYTES,
  MAX_USAGE_SUMMARY_BYTES,
  MAX_USAGE_SUMMARY_TEXT_BYTES,
  USAGE_REPORT_TRUNCATION_REASON,
  projectUsageReportV1,
  unknownUsageReportV1,
  validateUsageLedgerV1,
} from './usage-ledger.mjs';

export const RUN_RESULT_EVIDENCE_SCHEMA_ID = 'codex-co-engineer.run-result-evidence.v1';
export const RUN_RESULT_EVIDENCE_VERSION = 1;
export const RUN_ADMISSION_RECEIPT_SCHEMA_ID = 'codex-co-engineer.run-admission.v1';
export const RUN_RESULT_EVIDENCE_VIEWS = capturedFreeze(['detail', 'summary']);
export const RUN_RESULT_EVIDENCE_API = capturedFreeze([
  'describeRunResultEvidenceV1',
  'detailRunResultEvidenceV1',
  'projectRunResultEvidenceV1',
  'summarizeRunResultEvidenceV1',
]);
export const MAX_RUN_RESULT_SUMMARY_BYTES = 2048;
export const MAX_RUN_RESULT_DETAIL_BYTES = 16_384;
export const MAX_RUN_RESULT_TEXT_BYTES = 512;
export const MAX_SHAREABLE_STRING_BYTES = 128;
export const WRAPPER_KEYS = capturedFreeze([
  'artifacts', 'candidate', 'checks', 'codex_acceptance', 'receipt', 'usage_ledger',
]);
export const SUMMARY_RESULT_KEYS = capturedFreeze([
  'assignment_result', 'candidate', 'codex_accepted', 'label', 'next_decision',
  'review_needed', 'run_id', 'schema', 'text', 'truncation', 'unresolved',
  'usage', 'version', 'view',
]);
export const DETAIL_RESULT_KEYS = capturedFreeze([
  ...SUMMARY_RESULT_KEYS, 'artifacts', 'assignments', 'checks',
]);
export const RUN_RESULT_REPORT_TRUNCATION_REASON = USAGE_REPORT_TRUNCATION_REASON;

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,7}$/u;
const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|~\/|[A-Za-z]:[\\/])/u;
const FAILED_OUTCOMES = capturedFreeze([
  'blocked', 'cancelled', 'environment_blocked', 'failed', 'failed_pre_prompt',
  'timeout', 'timed_out', 'transport_lost', 'unrecoverable_post_prompt',
]);
const UNCERTAIN_OUTCOMES = capturedFreeze([
  'degraded', 'lifecycle_pending', 'needs_attention', 'partial_handoff',
  'unknown', 'unresolved',
]);
const UNFINAL_OUTCOMES = capturedFreeze([
  'accepted', 'awaiting_consent', 'dispatching', 'dispatched', 'planned',
  'prepared', 'preparing_workspaces', 'prompt_dispatched', 'running',
  'session_ready', 'starting', 'validating', 'verifying',
]);
const DEFINE = Object.defineProperty;
const STRING = String;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);

function deny(code, pathLabel, message) {
  fail(code, pathLabel, message ?? `RunResultEvidenceV1 rejected ${pathLabel}.`);
}

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!capturedHasOwn(values, key)) continue;
    DEFINE(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function freezeList(values) {
  const copy = [];
  for (let i = 0; i < values.length; i += 1) copy[i] = values[i];
  return capturedFreeze(copy);
}

function clipText(text, maxBytes) {
  if (capturedUtf8ByteLength(text) <= maxBytes) return text;
  const encoded = NodeBuffer.from(text, 'utf8');
  let end = maxBytes - 3;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString('utf8')}…`;
}

function isShareableString(value, maxBytes = MAX_SHAREABLE_STRING_BYTES) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (BYTE_LENGTH(value, 'utf8') > maxBytes) return false;
  if (capturedTest(ABSOLUTE_PATH_PATTERN, value)) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  return true;
}

function ownPlain(value, pathLabel) {
  if (value === undefined || value === null) deny('invalid_type', pathLabel);
  assertNotProxy(value, pathLabel);
  if (typeof value !== 'object' || capturedIsArray(value)) deny('invalid_type', pathLabel);
  assertDirectJsonClosure(value, pathLabel);
  return value;
}

function laneToken(lane) {
  const status = typeof lane.status === 'string' ? lane.status : null;
  const phase = typeof lane.phase === 'string' ? lane.phase : null;
  return status ?? phase;
}

function laneIsDirty(lane) {
  if (lane.clean === false) return true;
  const handoff = lane.handoff;
  if (handoff && typeof handoff === 'object' && !capturedIsArray(handoff) && handoff.clean === false) {
    return true;
  }
  return false;
}

function mapLaneOutcome(lane) {
  const token = laneToken(lane);
  const confidence = typeof lane.dispatch_confidence === 'string' ? lane.dispatch_confidence : null;
  if (capturedIncludes(FAILED_OUTCOMES, token)) {
    return token === 'cancelled' ? 'cancelled' : 'failed';
  }
  if (capturedIncludes(UNFINAL_OUTCOMES, token)) return 'unfinal';
  if (token === 'lifecycle_pending') return 'uncertain';
  if (lane.task_final === false) return 'uncertain';
  if (laneIsDirty(lane)) return 'uncertain';
  if (confidence === 'uncertain' || confidence === 'unknown') return 'uncertain';
  if (token === 'completed') {
    return confidence === 'authoritative' && lane.prompt_dispatched === true && lane.task_final === true
      ? 'completed' : 'uncertain';
  }
  if (capturedIncludes(UNCERTAIN_OUTCOMES, token)) return 'uncertain';
  return 'uncertain';
}

function mapRunOutcome(phase) {
  if (phase === 'completed') return 'completed';
  if (phase === 'failed') return 'failed';
  if (phase === 'cancelled') return 'cancelled';
  if (capturedIncludes(FAILED_OUTCOMES, phase)) {
    return phase === 'cancelled' ? 'cancelled' : 'failed';
  }
  if (capturedIncludes(UNFINAL_OUTCOMES, phase)) return 'unfinal';
  if (capturedIncludes(UNCERTAIN_OUTCOMES, phase)) return 'uncertain';
  return 'uncertain';
}

function combineAssignmentResult(runOutcome, laneOutcomes) {
  let hasActive = false;
  let hasFailed = false;
  let hasCancelled = false;
  let hasUncertain = false;
  let completedRequired = 0;
  let requiredCount = 0;
  for (let i = 0; i < laneOutcomes.length; i += 1) {
    const row = laneOutcomes[i];
    if (row.required === true) requiredCount += 1;
    if (row.outcome === 'unfinal') hasActive = true;
    else if (row.outcome === 'failed') hasFailed = true;
    else if (row.outcome === 'cancelled') hasCancelled = true;
    else if (row.outcome === 'uncertain') hasUncertain = true;
    else if (row.outcome === 'completed' && row.required === true) completedRequired += 1;
  }
  if (runOutcome === 'failed' || hasFailed) return 'failed';
  if (runOutcome === 'cancelled' || hasCancelled) return 'cancelled';
  if (hasActive || runOutcome === 'unfinal') return 'unfinal';
  if (runOutcome === 'uncertain' || hasUncertain) return 'uncertain';
  if (runOutcome === 'completed' && requiredCount > 0 && completedRequired === requiredCount) {
    return 'completed';
  }
  return 'uncertain';
}

function resultLabel(result, accepted, reviewNeeded) {
  if (accepted === true && result === 'completed') return PUBLIC_LABEL_ACCEPTED;
  if (result === 'failed' || result === 'cancelled') return PUBLIC_LABEL_FAILED;
  if (result === 'unfinal') return PUBLIC_LABEL_IN_PROGRESS;
  if (result === 'uncertain') return PUBLIC_LABEL_UNRESOLVED;
  if (reviewNeeded === true) return PUBLIC_LABEL_REVIEW_NEEDED;
  return PUBLIC_LABEL_REVIEW_NEEDED;
}

function resultNextDecision(result, reviewNeeded) {
  if (result === 'unfinal') return 'wait_for_completion';
  if (result === 'failed' || result === 'cancelled') return 'resolve_failures';
  if (result === 'uncertain') return 'inspect_unresolved';
  if (reviewNeeded === true) return 'review_candidate';
  return 'none';
}

function readSha(value) {
  return typeof value === 'string' && isSha40(value) ? value : null;
}

function readBranch(value) {
  return typeof value === 'string' && capturedTest(BRANCH_PATTERN, value) && isShareableString(value, 200)
    ? value
    : null;
}

function sanitizeArtifact(value, runId, assignmentIds) {
  let snapshot;
  try {
    snapshot = parseArtifactRefV1(value, 'artifact_ref');
  } catch {
    return null;
  }
  if (snapshot.run_id !== runId) return null;
  if (!assignmentIds.has(snapshot.assignment_id)) return null;
  if (snapshot.artifact_class !== 'sanitized') return null;
  return snapshot;
}

function parseWrapper(source) {
  const object = ownPlain(source, 'source');
  const keys = capturedOwnKeys(object);
  for (let i = 0; i < keys.length; i += 1) {
    if (!capturedIncludes(WRAPPER_KEYS, keys[i])) deny('unknown_key', `source.${STRING(keys[i])}`);
  }
  if (!hasOwn(object, 'receipt')) deny('missing_key', 'source.receipt');
  return object;
}

function asReceipt(source) {
  const object = ownPlain(source, 'source');
  if (object.schema === RUN_ADMISSION_RECEIPT_SCHEMA_ID) return { receipt: object };
  return parseWrapper(object);
}

function parseLane(raw, index) {
  if (raw === null || typeof raw !== 'object' || capturedIsArray(raw)) return null;
  try { assertNotProxy(raw, `lanes[${index}]`); } catch { return null; }
  const assignmentId = raw.assignment_id;
  const provider = raw.provider;
  const role = raw.role;
  if (!isAssignmentId(assignmentId) || !isKnownProvider(provider) || !isKnownRole(role)) {
    return null;
  }
  return {
    assignment_id: assignmentId,
    provider,
    role,
    required: raw.required !== false,
    outcome: mapLaneOutcome(raw),
    head: readSha(raw.head),
    artifact_refs: capturedIsArray(raw.artifact_refs) ? raw.artifact_refs : [],
  };
}

function selectCandidate(lanes, override) {
  if (override && typeof override === 'object') {
    const head = readSha(override.head);
    const tree = readSha(override.tree);
    const composed = override.composed === true && head != null;
    if (lanes.length > 1 && composed !== true) {
      return {
        branch: null,
        head: null,
        tree: null,
        composed: false,
      };
    }
    return {
      branch: readBranch(override.branch),
      head,
      tree,
      composed,
    };
  }
  if (lanes.length === 1) {
    return {
      branch: null,
      head: lanes[0].head,
      tree: null,
      composed: false,
    };
  }
  return {
    branch: null,
    head: null,
    tree: null,
    composed: false,
  };
}

function deriveChecks(override) {
  if (!capturedIsArray(override)) return [];
  const checks = [];
  for (let i = 0; i < override.length && checks.length < 8; i += 1) {
    const row = override[i];
    if (row == null || typeof row !== 'object') continue;
    if (typeof row.id !== 'string' || !capturedTest(CHECK_ID_PATTERN, row.id)) continue;
    const status = row.status;
    if (status !== 'passed' && status !== 'failed' && status !== 'unknown'
      && status !== 'provider_pass' && status !== 'missing') continue;
    checks.push({
      id: row.id,
      present: row.present === true,
      status,
    });
  }
  return checks;
}

function collectArtifacts(runId, lanes, override) {
  const assignmentIds = new Set();
  for (let i = 0; i < lanes.length; i += 1) assignmentIds.add(lanes[i].assignment_id);
  const collected = [];
  const source = capturedIsArray(override) ? override : [];
  if (!capturedIsArray(override)) {
    for (let i = 0; i < lanes.length; i += 1) {
      for (let j = 0; j < lanes[i].artifact_refs.length; j += 1) {
        source.push(lanes[i].artifact_refs[j]);
      }
    }
  }
  for (let i = 0; i < source.length; i += 1) {
    const artifact = sanitizeArtifact(source[i], runId, assignmentIds);
    if (artifact) collected.push(artifact);
  }
  collected.sort((left, right) => compareArtifactRefsV1(left, right));
  const unique = [];
  for (let i = 0; i < collected.length; i += 1) {
    if (i > 0 && compareArtifactRefsV1(collected[i - 1], collected[i]) === 0) continue;
    unique.push(collected[i]);
  }
  return unique;
}

function projectUsage(value, view, maxBytes) {
  if (value == null) return unknownUsageReportV1(view);
  validateUsageLedgerV1(value);
  return projectUsageReportV1(value, { view, max_bytes: maxBytes });
}

function compactText(assignmentResult, accepted, reviewNeeded, usage) {
  const usageText = usage.present === true
    ? usage.text
    : 'No usage recorded. Native token balance is unknown.';
  let lead = 'Completed work needs review; it is not Codex-accepted.';
  if (accepted === true && assignmentResult === 'completed') {
    lead = 'Codex accepted this completed candidate.';
  } else if (assignmentResult === 'failed') {
    lead = 'The run failed; resolve the failures.';
  } else if (assignmentResult === 'cancelled') {
    lead = 'The run was cancelled; resolve the failures.';
  } else if (assignmentResult === 'unfinal') {
    lead = 'Work is still in progress; wait for completion.';
  } else if (assignmentResult === 'uncertain') {
    lead = 'The outcome is unresolved; inspect before deciding.';
  } else if (reviewNeeded !== true) {
    lead = 'Completed work is not Codex-accepted.';
  }
  return clipText(`${lead} ${usageText}`, MAX_RUN_RESULT_TEXT_BYTES);
}

function emptyTruncation(count) {
  return freezeRecord(TRUNCATION_KEYS, {
    truncated: false,
    fields: freezeList([]),
    original_count: count,
    retained: count,
    omitted: 0,
    reason: null,
  });
}

function reportTruncation(fields, originalCount, retained) {
  return freezeRecord(TRUNCATION_KEYS, {
    truncated: true,
    fields: freezeList(fields),
    original_count: originalCount,
    retained,
    omitted: originalCount > retained ? originalCount - retained : 0,
    reason: RUN_RESULT_REPORT_TRUNCATION_REASON,
  });
}

function recordBytes(record) {
  return BYTE_LENGTH(canonicalJsonStringify(record), 'utf8');
}

function mergeTruncation(base, extraFields, originalCount, retained) {
  const fields = [];
  const fromBase = base && capturedIsArray(base.fields) ? base.fields : [];
  for (let i = 0; i < fromBase.length; i += 1) fields.push(fromBase[i]);
  for (let i = 0; i < extraFields.length; i += 1) {
    if (!capturedIncludes(fields, extraFields[i])) fields.push(extraFields[i]);
  }
  const truncated = (base && base.truncated === true) || extraFields.length > 0;
  if (!truncated) {
    return base ?? emptyTruncation(originalCount);
  }
  return reportTruncation(
    fields,
    originalCount,
    retained,
  );
}

function fitRunResult(record, maxBytes, pathLabel) {
  const originalCount = (
    (capturedIsArray(record.assignments) ? record.assignments.length : 0)
    + (capturedIsArray(record.artifacts) ? record.artifacts.length : 0)
    + (capturedIsArray(record.checks) ? record.checks.length : 0)
    + (record.usage && capturedIsArray(record.usage.metrics) ? record.usage.metrics.length : 0)
  );
  if (recordBytes(record) <= maxBytes) return freezeData(record);
  const fields = [];
  let current = { ...record };
  const clipTo = (limit) => {
    const next = clipText(current.text, limit);
    if (next !== current.text) {
      if (!capturedIncludes(fields, 'text')) fields.push('text');
      current = { ...current, text: next };
    }
  };
  clipTo(240);
  if (current.candidate && current.candidate.branch != null) {
    fields.push('candidate');
    current = {
      ...current,
      candidate: {
        branch: null,
        head: current.candidate.head,
        tree: current.candidate.tree,
        composed: current.candidate.composed === true,
      },
    };
  }
  const applyTruncation = (retained) => ({
    ...current,
    truncation: mergeTruncation(current.truncation, fields, originalCount, retained),
  });
  if (recordBytes(applyTruncation(originalCount)) <= maxBytes) {
    return freezeData(applyTruncation(originalCount));
  }
  if (current.usage && capturedIsArray(current.usage.groups) && current.usage.groups.length > 0) {
    fields.push('usage');
    current = { ...current, usage: { ...current.usage, groups: [] } };
  }
  if (capturedIsArray(current.artifacts) && current.artifacts.length > 0) {
    fields.push('artifacts');
    current = { ...current, artifacts: [] };
  }
  if (recordBytes(applyTruncation(originalCount)) <= maxBytes) {
    return freezeData(applyTruncation(originalCount));
  }
  if (current.usage && capturedIsArray(current.usage.metrics) && current.usage.metrics.length > 0) {
    if (!capturedIncludes(fields, 'usage')) fields.push('usage');
    current = {
      ...current,
      usage: {
        ...current.usage,
        metrics: [],
        text: clipText(
          current.usage.present === true
            ? 'Usage recorded; retrieve detail. Native token balance is unknown. Savings are not inferred.'
            : current.usage.text,
          160,
        ),
      },
    };
  }
  clipTo(160);
  if (recordBytes(applyTruncation(
    (capturedIsArray(current.assignments) ? current.assignments.length : 0)
    + (capturedIsArray(current.checks) ? current.checks.length : 0),
  )) <= maxBytes) {
    return freezeData(applyTruncation(
      (capturedIsArray(current.assignments) ? current.assignments.length : 0)
      + (capturedIsArray(current.checks) ? current.checks.length : 0),
    ));
  }
  if (capturedIsArray(current.assignments) && current.assignments.length > 0) {
    fields.push('assignments');
    const kept = [];
    for (let i = 0; i < current.assignments.length; i += 1) {
      kept.push({
        assignment_id: current.assignments[i].assignment_id,
        provider: current.assignments[i].provider,
        role: current.assignments[i].role,
        required: current.assignments[i].required,
        outcome: current.assignments[i].outcome,
        head: current.assignments[i].head ?? null,
      });
    }
    current = { ...current, assignments: kept };
  }
  if (capturedIsArray(current.checks) && current.checks.length > 0) {
    fields.push('checks');
    current = { ...current, checks: [] };
  }
  const retained = capturedIsArray(current.assignments) ? current.assignments.length : 0;
  const fitted = applyTruncation(retained);
  if (recordBytes(fitted) <= maxBytes) return freezeData(fitted);
  const minimal = {
    schema: current.schema,
    version: current.version,
    view: current.view,
    run_id: current.run_id,
    assignment_result: current.assignment_result,
    codex_accepted: current.codex_accepted,
    review_needed: current.review_needed,
    unresolved: current.unresolved,
    next_decision: current.next_decision,
    label: current.label,
    candidate: {
      branch: null,
      head: current.candidate?.head ?? null,
      tree: current.candidate?.tree ?? null,
      composed: current.candidate?.composed === true,
    },
    usage: current.usage
      ? {
        schema: current.usage.schema,
        view: current.usage.view,
        present: current.usage.present,
        identities: current.usage.identities,
        observations: current.usage.observations,
        metrics: [],
        unknown: current.usage.unknown,
        savings: current.usage.savings,
        subscription: current.usage.subscription,
        token_totals: current.usage.token_totals,
        text: clipText('Usage truncated; retrieve detail.', 64),
        truncation: current.usage.truncation ?? emptyTruncation(0),
      }
      : current.usage,
    text: clipText(
      compactText(
        current.assignment_result,
        current.codex_accepted,
        current.review_needed,
        { present: false, text: '' },
      ),
      160,
    ),
    truncation: reportTruncation(
      ['text', 'usage', 'assignments', 'artifacts', 'checks', 'candidate'],
      originalCount,
      0,
    ),
  };
  if (current.view === 'detail') {
    minimal.assignments = capturedIsArray(current.assignments)
      ? current.assignments.map((row) => ({
        assignment_id: row.assignment_id,
        outcome: row.outcome,
        required: row.required,
        provider: row.provider,
        role: row.role,
        head: row.head ?? null,
      }))
      : [];
    minimal.checks = [];
    minimal.artifacts = [];
  }
  if (recordBytes(minimal) <= maxBytes) return freezeData(minimal);
  deny('out_of_range', pathLabel, `Run result ${record.view} exceeds ${maxBytes} bytes.`);
  return freezeData(minimal);
}

export function describeRunResultEvidenceV1() {
  return freezeData(capturedFreeze({
    schema: RUN_RESULT_EVIDENCE_SCHEMA_ID,
    version: RUN_RESULT_EVIDENCE_VERSION,
    api: RUN_RESULT_EVIDENCE_API,
    views: RUN_RESULT_EVIDENCE_VIEWS,
    default_view: 'summary',
    max_summary_bytes: MAX_RUN_RESULT_SUMMARY_BYTES,
    max_detail_bytes: MAX_RUN_RESULT_DETAIL_BYTES,
    max_usage_summary_bytes: MAX_USAGE_SUMMARY_BYTES,
    max_usage_summary_text_bytes: MAX_USAGE_SUMMARY_TEXT_BYTES,
    max_usage_detail_bytes: MAX_USAGE_DETAIL_BYTES,
    savings: 'not_inferred',
    subscription: 'unknown',
    completed_is_not_accepted: true,
    provider_pass_is_not_acceptance: true,
  }));
}

export function projectRunResultEvidenceV1(source, options) {
  const view = options?.view == null ? 'summary' : options.view;
  if (!capturedIncludes(RUN_RESULT_EVIDENCE_VIEWS, view)) {
    deny('invalid_format', 'options.view');
  }
  const wrapped = asReceipt(source);
  const receipt = ownPlain(wrapped.receipt, 'receipt');
  if (receipt.schema !== RUN_ADMISSION_RECEIPT_SCHEMA_ID) {
    deny('invalid_format', 'receipt.schema');
  }
  const runId = receipt.run_id;
  try { assertRunId(runId, 'receipt.run_id'); } catch { deny('invalid_format', 'receipt.run_id'); }
  const phase = typeof receipt.phase === 'string' ? receipt.phase : STRING(receipt.status ?? '');
  const rawLanes = capturedIsArray(receipt.lanes) ? receipt.lanes : [];
  if (rawLanes.length < MIN_ASSIGNMENTS || rawLanes.length > MAX_ASSIGNMENTS) {
    deny('bounds_exceeded', 'receipt.lanes');
  }
  const lanes = [];
  for (let i = 0; i < rawLanes.length; i += 1) {
    const lane = parseLane(rawLanes[i], i);
    if (lane == null) deny('invalid_format', `receipt.lanes[${i}]`);
    lanes.push(lane);
  }
  const candidate = selectCandidate(lanes, wrapped.candidate);
  const checks = deriveChecks(wrapped.checks);
  const artifacts = collectArtifacts(runId, lanes, wrapped.artifacts);
  const usageBudget = view === 'detail' ? MAX_USAGE_DETAIL_BYTES : 1_280;
  const usage = projectUsage(wrapped.usage_ledger ?? receipt.usage_ledger, view, usageBudget);
  const baseSha = readSha(receipt.base_sha) ?? readSha(receipt.git?.base_sha);
  if (baseSha == null) deny('missing_key', 'receipt.base_sha');
  const outcome = projectLocalOutcomeCardV1({
    schema: LOCAL_OUTCOME_SCHEMA_ID,
    version: LOCAL_OUTCOME_VERSION,
    identity: {
      run_id: runId,
      base_sha: baseSha,
    },
    candidate,
    assignments: lanes.map((lane) => ({
      assignment_id: lane.assignment_id,
      provider: lane.provider,
      role: lane.role,
      required: lane.required,
      outcome: lane.outcome,
      head: lane.head,
    })),
    checks,
    artifacts,
    ...(hasOwn(wrapped, 'codex_acceptance') ? { codex_acceptance: wrapped.codex_acceptance } : {}),
  });
  const runOutcome = mapRunOutcome(phase);
  const assignmentResult = combineAssignmentResult(runOutcome, lanes);
  const unresolved = assignmentResult === 'unfinal' || assignmentResult === 'uncertain';
  const reviewNeeded = outcome.codex_accepted !== true && assignmentResult === 'completed';
  const nextDecision = resultNextDecision(assignmentResult, reviewNeeded);
  const label = resultLabel(assignmentResult, outcome.codex_accepted === true, reviewNeeded);
  const truncation = outcome.truncation ?? emptyTruncation(artifacts.length);
  const summary = freezeRecord(SUMMARY_RESULT_KEYS, {
    schema: RUN_RESULT_EVIDENCE_SCHEMA_ID,
    version: RUN_RESULT_EVIDENCE_VERSION,
    view,
    run_id: runId,
    assignment_result: assignmentResult,
    codex_accepted: outcome.codex_accepted === true && assignmentResult === 'completed',
    review_needed: reviewNeeded,
    unresolved,
    next_decision: nextDecision,
    label,
    candidate: outcome.candidate,
    usage,
    text: compactText(
      assignmentResult,
      outcome.codex_accepted === true && assignmentResult === 'completed',
      reviewNeeded,
      usage,
    ),
    truncation,
  });
  if (view === 'summary') {
    return fitRunResult(summary, MAX_RUN_RESULT_SUMMARY_BYTES, 'run_result_summary');
  }
  const detail = freezeRecord(DETAIL_RESULT_KEYS, {
    ...summary,
    assignments: outcome.assignments,
    checks: outcome.checks,
    artifacts: outcome.artifacts,
  });
  return fitRunResult(detail, MAX_RUN_RESULT_DETAIL_BYTES, 'run_result_detail');
}

export function summarizeRunResultEvidenceV1(source) {
  return projectRunResultEvidenceV1(source, { view: 'summary' });
}

export function detailRunResultEvidenceV1(source) {
  return projectRunResultEvidenceV1(source, { view: 'detail' });
}

capturedFreeze(describeRunResultEvidenceV1);
capturedFreeze(projectRunResultEvidenceV1);
capturedFreeze(summarizeRunResultEvidenceV1);
capturedFreeze(detailRunResultEvidenceV1);
