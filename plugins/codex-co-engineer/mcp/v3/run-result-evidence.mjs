// RunResultEvidenceV1 — bounded shareable projection of simple run-admission
// receipts onto existing usage-ledger and local-outcome components.
//
// Additive helper. Parent may call the exported seam from real admission
// receipt/projection after runtime wiring. This module is not an MCP tool,
// does not scrape private Codex state, and does not dump a usage ledger
// into every wait. Summary is the default; detail is on-demand.
//
// Completed provider work is not Codex acceptance. Provider PASS is not
// promoted. Missing native/provider tokens and subscription balances stay
// unknown. Bytes stay labeled as bytes. Savings are never inferred.

import { Buffer as NodeBuffer } from 'node:buffer';

import {
  ARTIFACT_CLASSES,
  compareArtifactRefsV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  LOCAL_OUTCOME_SCHEMA_ID,
  LOCAL_OUTCOME_VERSION,
  projectLocalOutcomeCardV1,
} from './final-decision-card.mjs';
import {
  capturedCreate,
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
  'public_mcp', 'review_needed', 'run_id', 'schema', 'text', 'unresolved',
  'usage', 'version', 'view',
]);
export const DETAIL_RESULT_KEYS = capturedFreeze([
  ...SUMMARY_RESULT_KEYS, 'artifacts', 'assignments', 'checks', 'truncation',
]);

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,7}$/u;
const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|~\/|[A-Za-z]:[\\/])/u;
const FAILED_OUTCOMES = capturedFreeze([
  'blocked', 'cancelled', 'environment_blocked', 'failed', 'failed_pre_prompt',
  'timeout', 'timed_out', 'transport_lost', 'unrecoverable_post_prompt',
]);
const UNCERTAIN_OUTCOMES = capturedFreeze([
  'degraded', 'needs_attention', 'partial_handoff', 'unknown',
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

function mapLaneOutcome(lane) {
  const status = typeof lane.status === 'string' ? lane.status : null;
  const phase = typeof lane.phase === 'string' ? lane.phase : null;
  const confidence = typeof lane.dispatch_confidence === 'string' ? lane.dispatch_confidence : null;
  if (confidence === 'uncertain') return 'uncertain';
  const token = status ?? phase;
  if (token === 'completed') return 'completed';
  if (capturedIncludes(FAILED_OUTCOMES, token)) {
    return token === 'cancelled' ? 'cancelled' : 'failed';
  }
  if (capturedIncludes(UNCERTAIN_OUTCOMES, token)) return 'uncertain';
  if (capturedIncludes(UNFINAL_OUTCOMES, token) || token == null) return 'unfinal';
  return 'uncertain';
}

function mapRunOutcome(phase) {
  if (phase === 'completed') return 'completed';
  if (phase === 'failed') return 'failed';
  if (phase === 'cancelled') return 'cancelled';
  if (phase === 'needs_attention' || phase === 'degraded') return 'uncertain';
  return 'unfinal';
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

function selectCandidate(receipt, lanes, override) {
  if (override && typeof override === 'object') {
    return {
      branch: readBranch(override.branch),
      head: readSha(override.head),
      tree: readSha(override.tree),
      composed: override.composed === true,
    };
  }
  let head = null;
  let mixedHead = false;
  for (let i = 0; i < lanes.length; i += 1) {
    if (lanes[i].head == null) continue;
    if (head == null) head = lanes[i].head;
    else if (head !== lanes[i].head) mixedHead = true;
  }
  const git = receipt.git && typeof receipt.git === 'object' ? receipt.git : capturedCreate(null);
  return {
    branch: readBranch(receipt.branch) ?? readBranch(git.branch),
    head: mixedHead ? null : head,
    tree: readSha(receipt.tree) ?? readSha(git.tree),
    composed: false,
  };
}

function deriveChecks(lanes, override) {
  if (capturedIsArray(override)) {
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
  const checks = [];
  for (let i = 0; i < lanes.length; i += 1) {
    if (lanes[i].role !== 'verify') continue;
    const status = lanes[i].outcome === 'completed'
      ? 'provider_pass'
      : (lanes[i].outcome === 'failed' ? 'failed' : 'unknown');
    checks.push({
      id: `verify-${lanes[i].assignment_id}`,
      present: lanes[i].outcome === 'completed' || lanes[i].outcome === 'failed',
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

function projectUsage(value, view) {
  if (value == null) return unknownUsageReportV1(view);
  validateUsageLedgerV1(value);
  return projectUsageReportV1(value, { view });
}

function compactText(outcome, usage) {
  return clipText([
    outcome.assignment_result,
    outcome.codex_accepted === true ? 'codex_accepted' : 'not_accepted',
    outcome.review_needed === true ? 'review_needed' : 'review_not_needed',
    outcome.next_decision,
    usage.present === true ? usage.text : 'usage unknown',
  ].join(' '), MAX_RUN_RESULT_TEXT_BYTES);
}

function boundRecord(record, maxBytes, pathLabel) {
  const encoded = canonicalJsonStringify(record);
  if (BYTE_LENGTH(encoded, 'utf8') > maxBytes) {
    deny('out_of_range', pathLabel, `Run result ${record.view} exceeds ${maxBytes} bytes.`);
  }
  return freezeData(record);
}

export function describeRunResultEvidenceV1() {
  return freezeData(capturedFreeze({
    schema: RUN_RESULT_EVIDENCE_SCHEMA_ID,
    version: RUN_RESULT_EVIDENCE_VERSION,
    api: RUN_RESULT_EVIDENCE_API,
    views: RUN_RESULT_EVIDENCE_VIEWS,
    parent_wiring_required: true,
    public_mcp: 'not exposed',
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
  const candidate = selectCandidate(receipt, lanes, wrapped.candidate);
  const checks = deriveChecks(lanes, wrapped.checks);
  const artifacts = collectArtifacts(runId, lanes, wrapped.artifacts);
  const usage = projectUsage(wrapped.usage_ledger ?? receipt.usage_ledger, view);
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
    })),
    checks,
    artifacts,
    ...(hasOwn(wrapped, 'codex_acceptance') ? { codex_acceptance: wrapped.codex_acceptance } : {}),
  });
  const runOutcome = mapRunOutcome(phase);
  const assignmentResult = runOutcome === 'unfinal' && outcome.assignment_result === 'completed'
    ? 'unfinal'
    : (runOutcome === 'completed' ? outcome.assignment_result : runOutcome);
  const summary = freezeRecord(SUMMARY_RESULT_KEYS, {
    schema: RUN_RESULT_EVIDENCE_SCHEMA_ID,
    version: RUN_RESULT_EVIDENCE_VERSION,
    view,
    public_mcp: 'not exposed',
    run_id: runId,
    assignment_result: assignmentResult,
    codex_accepted: outcome.codex_accepted,
    review_needed: outcome.review_needed,
    unresolved: outcome.unresolved || assignmentResult === 'unfinal' || assignmentResult === 'uncertain',
    next_decision: assignmentResult === 'unfinal'
      ? 'wait_for_completion'
      : outcome.next_decision,
    label: outcome.label,
    candidate: outcome.candidate,
    usage,
    text: compactText(outcome, usage),
  });
  if (view === 'summary') {
    return boundRecord(summary, MAX_RUN_RESULT_SUMMARY_BYTES, 'run_result_summary');
  }
  const detail = freezeRecord(DETAIL_RESULT_KEYS, {
    ...summary,
    assignments: outcome.assignments,
    checks: outcome.checks,
    artifacts: outcome.artifacts,
    truncation: outcome.truncation,
  });
  return boundRecord(detail, MAX_RUN_RESULT_DETAIL_BYTES, 'run_result_detail');
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
