// Bounded deterministic decision reducer. Default reduction aggregates typed
// decisions and receipts without feeding worker transcripts through another
// model. Model synthesis is an explicit exceptional state, never implicit.
// Attempt/generation fences prevent stale results from settling replacements.
// Expensive diff, CI, logs, and evidence stay retrieval references only.
// This module is pure: no I/O, no clock, no randomness, no model invocation.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  capturedCreate,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedTest,
  capturedUtf8ByteLength,
  isKnownProvider,
  knownProvidersJoined,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  BRANCH_NAME_MAX_BYTES,
  BRANCH_NAME_PATTERN,
  MAX_DISPATCH_ATTEMPT,
  MIN_DISPATCH_ATTEMPT,
  closedObject,
  fail,
  snapshotRecord,
} from './protected-identity.mjs';
import {
  MAX_ASSIGNMENTS,
  MAX_EXPECTED_DURATION_MS,
  MIN_DURATION_MS,
  ASSIGNMENT_ID_PATTERN,
  RunContractV1Error,
  assertDenseJsonArray,
  assertRunId,
  isAssignmentId,
  isSha40,
  utf8ByteLength,
} from './run-manifest.mjs';
import {
  SHA256_DIGEST_PATTERN,
  assertNotProxy,
  hasOwn,
} from './selection-json.mjs';

export const DECISION_RECEIPT_SCHEMA_ID = 'codex-co-engineer.decision-receipt.v1';
export const DECISION_REDUCTION_SCHEMA_ID = 'codex-co-engineer.decision-reduction.v1';
export const DECISION_REDUCTION_REQUEST_SCHEMA_ID =
  'codex-co-engineer.decision-reduction-request.v1';
export const DECISION_REDUCTION_DIGEST_DOMAIN = 'codex-co-engineer.decision-reduction-hash.v1';
export const DECISION_REDUCTION_VERSION = 1;

export const REDUCTION_MODES = capturedFreeze(['aggregate', 'model_synthesis']);
export const DEFAULT_REDUCTION_MODE = 'aggregate';
export const RECEIPT_KINDS = capturedFreeze([
  'identity', 'lifecycle', 'timing', 'decision', 'outcome', 'attention', 'error', 'retrieval',
]);
export const LIFECYCLE_STATES = capturedFreeze([
  'accepted', 'starting', 'dispatched', 'running', 'needs_attention', 'completed', 'failed',
  'cancelled', 'unresolved', 'timeout', 'transport_lost', 'environment_blocked',
]);
export const TERMINAL_OUTCOMES = capturedFreeze([
  'completed', 'failed', 'cancelled', 'timeout', 'environment_blocked', 'unresolved',
]);
export const RETRIEVAL_KINDS = capturedFreeze(['diff', 'ci', 'logs', 'evidence']);
export const TRUNCATION_CODES = capturedFreeze([
  'receipt_bound_exceeded', 'decision_bound_exceeded', 'retrieval_bound_exceeded',
]);

export const MIN_GENERATION = 1;
export const MAX_GENERATION = 16;
export const MAX_RECEIPTS = 64;
export const MAX_DECISIONS_PER_LANE = 16;
export const MAX_RETRIEVALS_PER_LANE = 8;
export const MAX_CURSOR_BYTES = 128;
export const MAX_CODE_BYTES = 64;
export const MAX_REDUCTION_CANONICAL_BYTES = 65_536;

export const RECEIPT_KEYS = capturedFreeze([
  'schema', 'assignment_id', 'attempt', 'generation', 'seq', 'kind', 'cursor',
  'observed_at', 'data',
]);
export const REQUEST_KEYS = capturedFreeze(['schema', 'run_id', 'receipts', 'reduction']);
export const REQUEST_REQUIRED_KEYS = capturedFreeze(['schema', 'run_id', 'receipts']);
export const LANE_REDUCTION_KEYS = capturedFreeze([
  'assignment_id', 'provider', 'branch', 'head', 'tree', 'attempt', 'generation',
  'cursor', 'lifecycle', 'outcome', 'attention', 'error', 'hidden_failure',
  'contradiction', 'unknown_timing', 'settled', 'stale_ignored', 'started_at',
  'deadline_at', 'expected_duration_ms', 'decisions', 'retrievals',
]);
export const REDUCTION_KEYS = capturedFreeze([
  'schema', 'version', 'run_id', 'reduction', 'exceptional', 'truncated',
  'truncation', 'lanes', 'digest',
]);
export const TRUNCATION_KEYS = capturedFreeze([
  'code', 'bound', 'submitted', 'kept', 'dropped',
]);
export const IDENTITY_DATA_KEYS = capturedFreeze(['provider', 'branch', 'head', 'tree']);
export const LIFECYCLE_DATA_KEYS = capturedFreeze(['state']);
export const TIMING_DATA_KEYS = capturedFreeze([
  'started_at', 'expected_duration_ms', 'deadline_at',
]);
export const DECISION_DATA_KEYS = capturedFreeze(['code']);
export const OUTCOME_DATA_KEYS = capturedFreeze(['outcome']);
export const ATTENTION_DATA_KEYS = capturedFreeze(['question_id']);
export const ERROR_DATA_KEYS = capturedFreeze(['code']);
export const RETRIEVAL_DATA_KEYS = capturedFreeze(['kind', 'digest', 'bytes']);
export const RETRIEVAL_REF_KEYS = capturedFreeze(['kind', 'digest', 'bytes']);

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const DATE_PARSE = Date.parse;
const DATE_ISO = Date.prototype.toISOString;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_ALLOC = NodeBuffer.alloc.bind(NodeBuffer);
const BUFFER_WRITE_UINT32BE = NodeBuffer.prototype.writeUInt32BE;
const CREATE_HASH = createHash;
const STRING = String;
const ARRAY_FROM = Array.from;

const FORBIDDEN_CODES = capturedFreeze(Object.assign(capturedCreate(null), {
  transcript: 'transcript_denied',
  transcripts: 'transcript_denied',
  messages: 'transcript_denied',
  prompt: 'transcript_denied',
  completion: 'model_invocation_denied',
  completions: 'model_invocation_denied',
  synthesis: 'model_invocation_denied',
  model: 'model_invocation_denied',
  diff: 'inline_evidence_denied',
  diffs: 'inline_evidence_denied',
  log: 'inline_evidence_denied',
  logs: 'inline_evidence_denied',
  ci: 'inline_evidence_denied',
  evidence: 'inline_evidence_denied',
  payload: 'inline_evidence_denied',
  text: 'inline_evidence_denied',
  output: 'inline_evidence_denied',
  bytes_inline: 'inline_evidence_denied',
}));

function denyForbiddenKeys(value, path) {
  for (const key of sortedCapturedKeys(value)) {
    const code = FORBIDDEN_CODES[key];
    if (code) {
      fail(code, `${path}.${key}`,
        `${path}.${key} is denied; default reduction aggregates typed receipts only.`);
    }
  }
}

function assertEnum(value, allowed, path) {
  if (!capturedIncludes(allowed, value)) {
    fail('invalid_format', path, `${path} is not part of the closed vocabulary.`);
  }
  return value;
}

function assertSafeInt(value, path, min, max) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value) || value < min || value > max) {
    fail('out_of_range', path, `${path} must be a safe integer in ${min}..${max}.`);
  }
  return value;
}

function assertNullableTimestamp(value, path) {
  if (value === null) return null;
  if (typeof value !== 'string' || !capturedTest(TIMESTAMP_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a canonical UTC timestamp or null.`);
  }
  const parsed = DATE_PARSE(value);
  if (!NUMBER_IS_SAFE_INTEGER(parsed) || DATE_ISO.call(new Date(parsed)) !== value) {
    fail('invalid_format', path, `${path} must be a canonical UTC timestamp or null.`);
  }
  return value;
}

function assertNullableSha(value, path) {
  if (value === null) return null;
  if (!isSha40(value)) {
    fail('invalid_format', path, `${path} must be a 40-hex SHA-1 object id or null.`);
  }
  return value;
}

function assertNullableBranch(value, path) {
  if (value === null) return null;
  if (typeof value !== 'string' || !capturedTest(BRANCH_NAME_PATTERN, value)
    || utf8ByteLength(value) > BRANCH_NAME_MAX_BYTES
    || value.includes('..') || value.includes('//') || value.includes('@{')
    || value.includes('/.') || value.endsWith('.lock') || value.normalize('NFC') !== value) {
    fail('invalid_format', path, `${path} must be a bounded git-ref-safe branch name or null.`);
  }
  return value;
}

function assertNullableProvider(value, path) {
  if (value === null) return null;
  if (!isKnownProvider(value)) {
    fail('unknown_provider', path, `${path} must be null or exactly one of ${knownProvidersJoined()}.`);
  }
  return value;
}

function assertNullableCursor(value, path) {
  if (value === null) return null;
  if (typeof value !== 'string' || !capturedTest(CURSOR_PATTERN, value)
    || capturedUtf8ByteLength(value) > MAX_CURSOR_BYTES) {
    fail('invalid_format', path, `${path} must be a bounded cursor token or null.`);
  }
  return value;
}

function assertCode(value, path) {
  if (typeof value !== 'string' || !capturedTest(CODE_PATTERN, value)
    || capturedUtf8ByteLength(value) > MAX_CODE_BYTES) {
    fail('invalid_format', path, `${path} must be a bounded content-free code.`);
  }
  return value;
}

function assertDigest(value, path) {
  if (typeof value !== 'string' || !capturedTest(SHA256_DIGEST_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a sha256:<64 hex> digest.`);
  }
  return value;
}

function parseData(kind, data, path) {
  denyForbiddenKeys(data, path);
  if (kind === 'identity') {
    const fields = closedObject(data, path, IDENTITY_DATA_KEYS);
    return {
      provider: assertNullableProvider(fields.provider, `${path}.provider`),
      branch: assertNullableBranch(fields.branch, `${path}.branch`),
      head: assertNullableSha(fields.head, `${path}.head`),
      tree: assertNullableSha(fields.tree, `${path}.tree`),
    };
  }
  if (kind === 'lifecycle') {
    const fields = closedObject(data, path, LIFECYCLE_DATA_KEYS);
    return { state: assertEnum(fields.state, LIFECYCLE_STATES, `${path}.state`) };
  }
  if (kind === 'timing') {
    const fields = closedObject(data, path, TIMING_DATA_KEYS);
    const expected = fields.expected_duration_ms;
    if (expected !== null) {
      assertSafeInt(expected, `${path}.expected_duration_ms`, MIN_DURATION_MS, MAX_EXPECTED_DURATION_MS);
    }
    return {
      started_at: assertNullableTimestamp(fields.started_at, `${path}.started_at`),
      expected_duration_ms: expected,
      deadline_at: assertNullableTimestamp(fields.deadline_at, `${path}.deadline_at`),
    };
  }
  if (kind === 'decision') {
    const fields = closedObject(data, path, DECISION_DATA_KEYS);
    return { code: assertCode(fields.code, `${path}.code`) };
  }
  if (kind === 'outcome') {
    const fields = closedObject(data, path, OUTCOME_DATA_KEYS);
    return { outcome: assertEnum(fields.outcome, TERMINAL_OUTCOMES, `${path}.outcome`) };
  }
  if (kind === 'attention') {
    const fields = closedObject(data, path, ATTENTION_DATA_KEYS);
    return { question_id: assertCode(fields.question_id, `${path}.question_id`) };
  }
  if (kind === 'error') {
    const fields = closedObject(data, path, ERROR_DATA_KEYS);
    return { code: assertCode(fields.code, `${path}.code`) };
  }
  const fields = closedObject(data, path, RETRIEVAL_DATA_KEYS);
  return {
    kind: assertEnum(fields.kind, RETRIEVAL_KINDS, `${path}.kind`),
    digest: assertDigest(fields.digest, `${path}.digest`),
    bytes: assertSafeInt(fields.bytes, `${path}.bytes`, 1, MAX_REDUCTION_CANONICAL_BYTES),
  };
}

export function validateDecisionReceiptV1(input, path = 'receipt') {
  assertNotProxy(input, path);
  denyForbiddenKeys(input, path);
  const fields = closedObject(input, path, RECEIPT_KEYS);
  if (fields.schema !== DECISION_RECEIPT_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `${path}.schema must be exactly "${DECISION_RECEIPT_SCHEMA_ID}".`);
  }
  if (!isAssignmentId(fields.assignment_id)) {
    fail('invalid_format', `${path}.assignment_id`,
      `${path}.assignment_id must match ${ASSIGNMENT_ID_PATTERN.source}.`);
  }
  assertSafeInt(fields.attempt, `${path}.attempt`, MIN_DISPATCH_ATTEMPT, MAX_DISPATCH_ATTEMPT);
  assertSafeInt(fields.generation, `${path}.generation`, MIN_GENERATION, MAX_GENERATION);
  assertSafeInt(fields.seq, `${path}.seq`, 1, 1_000_000);
  assertEnum(fields.kind, RECEIPT_KINDS, `${path}.kind`);
  return {
    schema: DECISION_RECEIPT_SCHEMA_ID,
    assignment_id: fields.assignment_id,
    attempt: fields.attempt,
    generation: fields.generation,
    seq: fields.seq,
    kind: fields.kind,
    cursor: assertNullableCursor(fields.cursor, `${path}.cursor`),
    observed_at: assertNullableTimestamp(fields.observed_at, `${path}.observed_at`),
    data: parseData(fields.kind, fields.data, `${path}.data`),
  };
}

function receiptContentCanon(receipt) {
  return canonicalJsonStringify({
    cursor: receipt.cursor,
    observed_at: receipt.observed_at,
    data: receipt.data,
  });
}

function sameReceiptCoordinates(left, right) {
  return left.assignment_id === right.assignment_id
    && left.attempt === right.attempt
    && left.generation === right.generation
    && left.seq === right.seq
    && left.kind === right.kind;
}

function compareReceipts(left, right) {
  if (left.assignment_id !== right.assignment_id) {
    return left.assignment_id < right.assignment_id ? -1 : 1;
  }
  if (left.attempt !== right.attempt) return left.attempt - right.attempt;
  if (left.generation !== right.generation) return left.generation - right.generation;
  if (left.seq !== right.seq) return left.seq - right.seq;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  const leftContent = receiptContentCanon(left);
  const rightContent = receiptContentCanon(right);
  if (leftContent !== rightContent) return leftContent < rightContent ? -1 : 1;
  return 0;
}

function emptyLane(assignmentId) {
  return {
    assignment_id: assignmentId,
    provider: null,
    branch: null,
    head: null,
    tree: null,
    attempt: null,
    generation: null,
    cursor: null,
    lifecycle: null,
    outcome: null,
    attention: false,
    error: null,
    hidden_failure: false,
    contradiction: false,
    unknown_timing: true,
    settled: false,
    stale_ignored: 0,
    started_at: null,
    deadline_at: null,
    expected_duration_ms: null,
    decisions: [],
    retrievals: [],
  };
}

function resetSettle(lane) {
  lane.lifecycle = null;
  lane.outcome = null;
  lane.attention = false;
  lane.error = null;
  lane.hidden_failure = false;
  lane.contradiction = false;
  lane.settled = false;
  lane.started_at = null;
  lane.deadline_at = null;
  lane.expected_duration_ms = null;
  lane.unknown_timing = true;
  lane.decisions = [];
  lane.retrievals = [];
}

function resetIdentity(lane) {
  lane.provider = null;
  lane.branch = null;
  lane.head = null;
  lane.tree = null;
  lane.cursor = null;
}

function timingUnknown(lane) {
  return lane.deadline_at === null
    && (lane.started_at === null || lane.expected_duration_ms === null);
}

function applyReceipt(lane, receipt) {
  const fence = { attempt: receipt.attempt, generation: receipt.generation };
  if (lane.attempt === null) {
    lane.attempt = fence.attempt;
    lane.generation = fence.generation;
  } else if (fence.attempt > lane.attempt) {
    resetIdentity(lane);
    resetSettle(lane);
    lane.attempt = fence.attempt;
    lane.generation = fence.generation;
  } else if (fence.attempt === lane.attempt && fence.generation > lane.generation) {
    resetIdentity(lane);
    resetSettle(lane);
    lane.generation = fence.generation;
  } else if (fence.attempt < lane.attempt
    || (fence.attempt === lane.attempt && fence.generation < lane.generation)) {
    lane.stale_ignored += 1;
    return;
  }

  if (receipt.cursor !== null) lane.cursor = receipt.cursor;

  const { kind, data } = receipt;
  if (kind === 'identity') {
    if (data.provider !== null) lane.provider = data.provider;
    if (data.branch !== null) lane.branch = data.branch;
    if (data.head !== null) lane.head = data.head;
    if (data.tree !== null) lane.tree = data.tree;
    return;
  }
  if (kind === 'lifecycle') {
    lane.lifecycle = data.state;
    if (data.state === 'needs_attention') lane.attention = true;
    return;
  }
  if (kind === 'timing') {
    if (data.started_at !== null) lane.started_at = data.started_at;
    if (data.deadline_at !== null) lane.deadline_at = data.deadline_at;
    if (data.expected_duration_ms !== null) lane.expected_duration_ms = data.expected_duration_ms;
    lane.unknown_timing = timingUnknown(lane);
    return;
  }
  if (kind === 'decision') {
    if (!capturedIncludes(lane.decisions, data.code)) lane.decisions.push(data.code);
    return;
  }
  if (kind === 'outcome') {
    if (lane.outcome !== null && lane.outcome !== data.outcome) {
      lane.contradiction = true;
      lane.outcome = null;
      lane.settled = false;
      return;
    }
    lane.outcome = data.outcome;
    lane.settled = !lane.contradiction;
    if (lane.outcome === 'completed' && lane.error !== null) lane.hidden_failure = true;
    return;
  }
  if (kind === 'attention') {
    lane.attention = true;
    return;
  }
  if (kind === 'error') {
    lane.error = data.code;
    if (lane.outcome === 'completed') lane.hidden_failure = true;
    return;
  }
  const key = `${data.kind}:${data.digest}:${STRING(data.bytes)}`;
  for (const existing of lane.retrievals) {
    if (`${existing.kind}:${existing.digest}:${STRING(existing.bytes)}` === key) return;
  }
  lane.retrievals.push({
    kind: data.kind,
    digest: data.digest,
    bytes: data.bytes,
  });
}

function freezeTruncation(record) {
  if (record === null) return null;
  return snapshotRecord({
    code: record.code,
    bound: record.bound,
    submitted: record.submitted,
    kept: record.kept,
    dropped: record.dropped,
  });
}

function boundList(values, max) {
  const sorted = [...values].sort();
  if (sorted.length <= max) return { kept: sorted, dropped: 0 };
  return { kept: sorted.slice(0, max), dropped: sorted.length - max };
}

function compareRetrievals(left, right) {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.digest !== right.digest) return left.digest < right.digest ? -1 : 1;
  return left.bytes - right.bytes;
}

function boundRetrievals(values, max) {
  const sorted = [...values].sort(compareRetrievals);
  if (sorted.length <= max) return { kept: sorted, dropped: 0 };
  return { kept: sorted.slice(0, max), dropped: sorted.length - max };
}

function framedDigest(domain, record) {
  const canonical = canonicalJsonStringify(record);
  const domainBytes = BUFFER_FROM(domain, 'utf8');
  const body = BUFFER_FROM(canonical, 'utf8');
  if (body.length > MAX_REDUCTION_CANONICAL_BYTES) {
    fail('out_of_range', 'reduction',
      'reduction exceeds the bounded canonical byte cap.');
  }
  const hash = CREATE_HASH('sha256');
  const prefix = BUFFER_ALLOC(4);
  BUFFER_WRITE_UINT32BE.call(prefix, domainBytes.length, 0);
  hash.update(prefix);
  hash.update(domainBytes);
  BUFFER_WRITE_UINT32BE.call(prefix, body.length, 0);
  hash.update(prefix);
  hash.update(body);
  return `sha256:${hash.digest('hex')}`;
}

function finalizeLane(lane) {
  const decisionsBound = boundList(lane.decisions, MAX_DECISIONS_PER_LANE);
  const retrievalsBound = boundRetrievals(lane.retrievals, MAX_RETRIEVALS_PER_LANE);
  const decisions = decisionsBound.kept;
  const retrievals = retrievalsBound.kept;
  return {
    lane: {
      assignment_id: lane.assignment_id,
      provider: lane.provider,
      branch: lane.branch,
      head: lane.head,
      tree: lane.tree,
      attempt: lane.attempt,
      generation: lane.generation,
      cursor: lane.cursor,
      lifecycle: lane.lifecycle,
      outcome: lane.outcome,
      attention: lane.attention,
      error: lane.error,
      hidden_failure: lane.hidden_failure,
      contradiction: lane.contradiction,
      unknown_timing: timingUnknown(lane),
      settled: lane.settled && !lane.contradiction && lane.outcome !== null,
      stale_ignored: lane.stale_ignored,
      started_at: lane.started_at,
      deadline_at: lane.deadline_at,
      expected_duration_ms: lane.expected_duration_ms,
      decisions,
      retrievals,
    },
    decisionDropped: decisionsBound.dropped,
    retrievalDropped: retrievalsBound.dropped,
  };
}

function parseRequest(input) {
  assertNotProxy(input, 'request');
  denyForbiddenKeys(input, 'request');
  const fields = closedObject(input, 'request', REQUEST_KEYS, REQUEST_REQUIRED_KEYS);
  if (fields.schema !== DECISION_REDUCTION_REQUEST_SCHEMA_ID) {
    fail('invalid_format', 'request.schema',
      `request.schema must be exactly "${DECISION_REDUCTION_REQUEST_SCHEMA_ID}".`);
  }
  assertRunId(fields.run_id, 'request.run_id');
  const reduction = hasOwn(fields, 'reduction')
    ? assertEnum(fields.reduction, REDUCTION_MODES, 'request.reduction')
    : DEFAULT_REDUCTION_MODE;
  assertDenseJsonArray(fields.receipts, 'request.receipts');
  const receipts = [];
  for (let index = 0; index < fields.receipts.length; index += 1) {
    receipts.push(validateDecisionReceiptV1(fields.receipts[index], `request.receipts[${index}]`));
  }
  return { run_id: fields.run_id, reduction, receipts };
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') {
    fail('invalid_type', path, `${path} must be a boolean.`);
  }
  return value;
}

function assertNullableSafeInt(value, path, min, max) {
  if (value === null) return null;
  return assertSafeInt(value, path, min, max);
}

function parseRetrievalRef(value, path) {
  denyForbiddenKeys(value, path);
  const fields = closedObject(value, path, RETRIEVAL_REF_KEYS);
  return {
    kind: assertEnum(fields.kind, RETRIEVAL_KINDS, `${path}.kind`),
    digest: assertDigest(fields.digest, `${path}.digest`),
    bytes: assertSafeInt(fields.bytes, `${path}.bytes`, 1, MAX_REDUCTION_CANONICAL_BYTES),
  };
}

function parseLaneReductionRecord(value, path) {
  denyForbiddenKeys(value, path);
  const fields = closedObject(value, path, LANE_REDUCTION_KEYS);
  if (!isAssignmentId(fields.assignment_id)) {
    fail('invalid_format', `${path}.assignment_id`,
      `${path}.assignment_id must match ${ASSIGNMENT_ID_PATTERN.source}.`);
  }
  const attempt = assertNullableSafeInt(
    fields.attempt, `${path}.attempt`, MIN_DISPATCH_ATTEMPT, MAX_DISPATCH_ATTEMPT,
  );
  const generation = assertNullableSafeInt(
    fields.generation, `${path}.generation`, MIN_GENERATION, MAX_GENERATION,
  );
  if ((attempt === null) !== (generation === null)) {
    fail('invalid_format', `${path}.generation`,
      `${path}.attempt and ${path}.generation must both be null or both be set.`);
  }
  const lifecycle = fields.lifecycle === null
    ? null
    : assertEnum(fields.lifecycle, LIFECYCLE_STATES, `${path}.lifecycle`);
  const outcome = fields.outcome === null
    ? null
    : assertEnum(fields.outcome, TERMINAL_OUTCOMES, `${path}.outcome`);
  const error = fields.error === null ? null : assertCode(fields.error, `${path}.error`);
  assertDenseJsonArray(fields.decisions, `${path}.decisions`);
  if (fields.decisions.length > MAX_DECISIONS_PER_LANE) {
    fail('out_of_range', `${path}.decisions`,
      `${path}.decisions exceeds ${MAX_DECISIONS_PER_LANE} entries.`);
  }
  const decisions = [];
  for (let index = 0; index < fields.decisions.length; index += 1) {
    const code = assertCode(fields.decisions[index], `${path}.decisions[${index}]`);
    if (index > 0 && decisions[index - 1] >= code) {
      fail('invalid_format', `${path}.decisions[${index}]`,
        `${path}.decisions must be unique and strictly sorted.`);
    }
    decisions.push(code);
  }
  assertDenseJsonArray(fields.retrievals, `${path}.retrievals`);
  if (fields.retrievals.length > MAX_RETRIEVALS_PER_LANE) {
    fail('out_of_range', `${path}.retrievals`,
      `${path}.retrievals exceeds ${MAX_RETRIEVALS_PER_LANE} entries.`);
  }
  const retrievals = [];
  for (let index = 0; index < fields.retrievals.length; index += 1) {
    const retrieval = parseRetrievalRef(fields.retrievals[index], `${path}.retrievals[${index}]`);
    if (index > 0 && compareRetrievals(retrievals[index - 1], retrieval) >= 0) {
      fail('invalid_format', `${path}.retrievals[${index}]`,
        `${path}.retrievals must be unique and strictly sorted.`);
    }
    retrievals.push(retrieval);
  }
  return {
    assignment_id: fields.assignment_id,
    provider: assertNullableProvider(fields.provider, `${path}.provider`),
    branch: assertNullableBranch(fields.branch, `${path}.branch`),
    head: assertNullableSha(fields.head, `${path}.head`),
    tree: assertNullableSha(fields.tree, `${path}.tree`),
    attempt,
    generation,
    cursor: assertNullableCursor(fields.cursor, `${path}.cursor`),
    lifecycle,
    outcome,
    attention: assertBoolean(fields.attention, `${path}.attention`),
    error,
    hidden_failure: assertBoolean(fields.hidden_failure, `${path}.hidden_failure`),
    contradiction: assertBoolean(fields.contradiction, `${path}.contradiction`),
    unknown_timing: assertBoolean(fields.unknown_timing, `${path}.unknown_timing`),
    settled: assertBoolean(fields.settled, `${path}.settled`),
    stale_ignored: assertSafeInt(fields.stale_ignored, `${path}.stale_ignored`, 0, MAX_RECEIPTS),
    started_at: assertNullableTimestamp(fields.started_at, `${path}.started_at`),
    deadline_at: assertNullableTimestamp(fields.deadline_at, `${path}.deadline_at`),
    expected_duration_ms: assertNullableSafeInt(
      fields.expected_duration_ms, `${path}.expected_duration_ms`,
      MIN_DURATION_MS, MAX_EXPECTED_DURATION_MS,
    ),
    decisions,
    retrievals,
  };
}

function parseTruncationRecord(value, path) {
  if (value === null) return null;
  denyForbiddenKeys(value, path);
  const fields = closedObject(value, path, TRUNCATION_KEYS);
  return {
    code: assertEnum(fields.code, TRUNCATION_CODES, `${path}.code`),
    bound: assertSafeInt(fields.bound, `${path}.bound`, 1, MAX_RECEIPTS),
    submitted: assertSafeInt(fields.submitted, `${path}.submitted`, 0, Number.MAX_SAFE_INTEGER),
    kept: assertSafeInt(fields.kept, `${path}.kept`, 0, MAX_RECEIPTS),
    dropped: assertSafeInt(fields.dropped, `${path}.dropped`, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function validateDecisionReductionV1(input, path = 'reduction') {
  assertNotProxy(input, path);
  denyForbiddenKeys(input, path);
  const fields = closedObject(input, path, REDUCTION_KEYS);
  if (fields.schema !== DECISION_REDUCTION_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `${path}.schema must be exactly "${DECISION_REDUCTION_SCHEMA_ID}".`);
  }
  if (fields.version !== DECISION_REDUCTION_VERSION) {
    fail('invalid_format', `${path}.version`,
      `${path}.version must be exactly ${DECISION_REDUCTION_VERSION}.`);
  }
  assertRunId(fields.run_id, `${path}.run_id`);
  assertEnum(fields.reduction, REDUCTION_MODES, `${path}.reduction`);
  assertBoolean(fields.exceptional, `${path}.exceptional`);
  assertBoolean(fields.truncated, `${path}.truncated`);
  if (fields.exceptional !== (fields.reduction === 'model_synthesis')) {
    fail('invalid_format', `${path}.exceptional`,
      `${path}.exceptional is true only for explicit model_synthesis.`);
  }
  assertDigest(fields.digest, `${path}.digest`);
  assertDenseJsonArray(fields.lanes, `${path}.lanes`);
  if (fields.lanes.length > MAX_ASSIGNMENTS) {
    fail('out_of_range', `${path}.lanes`,
      `${path}.lanes binds at most ${MAX_ASSIGNMENTS} lanes.`);
  }
  const lanes = [];
  for (let index = 0; index < fields.lanes.length; index += 1) {
    const lane = parseLaneReductionRecord(fields.lanes[index], `${path}.lanes[${index}]`);
    if (index > 0 && lanes[index - 1].assignment_id >= lane.assignment_id) {
      fail('invalid_format', `${path}.lanes[${index}].assignment_id`,
        `${path}.lanes must be unique and strictly sorted by assignment_id.`);
    }
    lanes.push(lane);
  }
  const truncation = parseTruncationRecord(fields.truncation, `${path}.truncation`);
  if (fields.truncated !== (truncation !== null)) {
    fail('invalid_format', `${path}.truncated`,
      `${path}.truncated must match presence of truncation provenance.`);
  }
  const payload = {
    schema: DECISION_REDUCTION_SCHEMA_ID,
    version: DECISION_REDUCTION_VERSION,
    run_id: fields.run_id,
    reduction: fields.reduction,
    exceptional: fields.exceptional,
    truncated: fields.truncated,
    truncation,
    lanes,
  };
  const expected = framedDigest(DECISION_REDUCTION_DIGEST_DOMAIN, payload);
  if (fields.digest !== expected) {
    fail('reduction_digest_mismatch', `${path}.digest`,
      `${path}.digest does not match the canonical reduction contents.`);
  }
  return {
    ...payload,
    digest: fields.digest,
  };
}

function countStale(sorted) {
  const maxFence = capturedCreate(null);
  for (const receipt of sorted) {
    const current = maxFence[receipt.assignment_id];
    if (!current
      || receipt.attempt > current.attempt
      || (receipt.attempt === current.attempt && receipt.generation > current.generation)) {
      maxFence[receipt.assignment_id] = {
        attempt: receipt.attempt,
        generation: receipt.generation,
      };
    }
  }
  const stale = capturedCreate(null);
  for (const receipt of sorted) {
    const fence = maxFence[receipt.assignment_id];
    const isStale = receipt.attempt < fence.attempt
      || (receipt.attempt === fence.attempt && receipt.generation < fence.generation);
    stale[receipt.assignment_id] = (stale[receipt.assignment_id] ?? 0) + (isStale ? 1 : 0);
  }
  return stale;
}

export function reduceDecisionReceiptsV1(input) {
  const request = parseRequest(input);
  const submitted = request.receipts.length;
  const sorted = [...request.receipts].sort(compareReceipts);
  let kept = sorted;
  let truncation = null;
  if (sorted.length > MAX_RECEIPTS) {
    kept = sorted.slice(sorted.length - MAX_RECEIPTS);
    truncation = {
      code: 'receipt_bound_exceeded',
      bound: MAX_RECEIPTS,
      submitted,
      kept: kept.length,
      dropped: submitted - kept.length,
    };
  }

  const staleCounts = countStale(kept);
  const lanes = capturedCreate(null);
  const assignmentIds = [];
  let previous = null;
  for (const receipt of kept) {
    if (!capturedHasOwn(lanes, receipt.assignment_id)) {
      if (assignmentIds.length >= MAX_ASSIGNMENTS) {
        fail('out_of_range', 'request.receipts',
          `A reduction binds at most ${MAX_ASSIGNMENTS} lanes.`);
      }
      lanes[receipt.assignment_id] = emptyLane(receipt.assignment_id);
      assignmentIds.push(receipt.assignment_id);
    }
    const lane = lanes[receipt.assignment_id];
    if (previous !== null && sameReceiptCoordinates(previous, receipt)) {
      if (receiptContentCanon(previous) !== receiptContentCanon(receipt)) {
        lane.contradiction = true;
      }
      previous = receipt;
      continue;
    }
    applyReceipt(lane, receipt);
    previous = receipt;
  }

  assignmentIds.sort();
  const projected = [];
  let decisionDropped = 0;
  let retrievalDropped = 0;
  for (const assignmentId of assignmentIds) {
    const lane = lanes[assignmentId];
    lane.stale_ignored = staleCounts[assignmentId] ?? 0;
    const finalized = finalizeLane(lane);
    projected.push(finalized.lane);
    decisionDropped += finalized.decisionDropped;
    retrievalDropped += finalized.retrievalDropped;
  }

  if (truncation === null && retrievalDropped > 0) {
    truncation = {
      code: 'retrieval_bound_exceeded',
      bound: MAX_RETRIEVALS_PER_LANE,
      submitted: retrievalDropped + MAX_RETRIEVALS_PER_LANE,
      kept: MAX_RETRIEVALS_PER_LANE,
      dropped: retrievalDropped,
    };
  } else if (truncation === null && decisionDropped > 0) {
    truncation = {
      code: 'decision_bound_exceeded',
      bound: MAX_DECISIONS_PER_LANE,
      submitted: decisionDropped + MAX_DECISIONS_PER_LANE,
      kept: MAX_DECISIONS_PER_LANE,
      dropped: decisionDropped,
    };
  }

  const truncated = truncation !== null;
  const payload = {
    schema: DECISION_REDUCTION_SCHEMA_ID,
    version: DECISION_REDUCTION_VERSION,
    run_id: request.run_id,
    reduction: request.reduction,
    exceptional: request.reduction === 'model_synthesis',
    truncated,
    truncation: freezeTruncation(truncation),
    lanes: projected,
  };
  const digest = framedDigest(DECISION_REDUCTION_DIGEST_DOMAIN, payload);
  return snapshotRecord({ ...payload, digest });
}

export function describeDecisionReducerV1() {
  return snapshotRecord({
    schema: DECISION_REDUCTION_SCHEMA_ID,
    version: DECISION_REDUCTION_VERSION,
    default_reduction: DEFAULT_REDUCTION_MODE,
    modes: ARRAY_FROM(REDUCTION_MODES),
    receipt_kinds: ARRAY_FROM(RECEIPT_KINDS),
    retrieval_kinds: ARRAY_FROM(RETRIEVAL_KINDS),
    bounds: {
      max_assignments: MAX_ASSIGNMENTS,
      max_receipts: MAX_RECEIPTS,
      max_decisions_per_lane: MAX_DECISIONS_PER_LANE,
      max_retrievals_per_lane: MAX_RETRIEVALS_PER_LANE,
      min_attempt: MIN_DISPATCH_ATTEMPT,
      max_attempt: MAX_DISPATCH_ATTEMPT,
      min_generation: MIN_GENERATION,
      max_generation: MAX_GENERATION,
    },
    api: ['describeDecisionReducerV1', 'reduceDecisionReceiptsV1', 'validateDecisionReceiptV1'],
    claims: {
      default_aggregates_typed_receipts: true,
      model_synthesis_explicit_only: true,
      never_invokes_model: true,
      never_consumes_transcripts: true,
      expensive_details_are_retrieval_refs: true,
      preserves_unknown: true,
      attempt_generation_fences: true,
    },
  });
}

export { RunContractV1Error, framedDigest as reductionFramedDigestV1 };

capturedFreeze(validateDecisionReceiptV1);
capturedFreeze(validateDecisionReductionV1);
capturedFreeze(reduceDecisionReceiptsV1);
capturedFreeze(describeDecisionReducerV1);
