// CursorLocalDriverV1 — local Cursor provider driver (P19 reconstruction).
//
// Additive v3 module. It binds the accepted P17 ProviderDriverV1 contract
// (four operations, exact ChildEnvelopeV1 proof, honest P05 capability
// declaration, process-local transitions) to an injected local session
// transport. It owns no provider transport of its own and claims none.
//
// Invariants enforced here, on top of the P17 validators this module calls
// as its single content-free quarantine:
//   - exact provenance binding: provider `cursor-local`, the resolved
//     model, repository path, run/assignment/lane identity, base sha, and
//     child envelope digest must all be present and equal on every
//     request; omitted fields are never derived and near-misses never
//     substitute;
//   - at most one spawn and at most one prompt dispatch per lane; the
//     `dispatched` disposition requires the transport's authoritative
//     acknowledgement; a pre-send spawn failure stays `not_sent` and is
//     kept strictly distinct from post-spawn `dispatch_uncertain`;
//   - same-session attention replies are attempt-once and bound to the
//     exact session, question, and answer; an unsupported reply posture
//     refuses explicitly without touching the transport;
//   - cancel, reattach, reconcile, restart, the terminal latch, and
//     already-terminal behavior preserve exact lane identity and never
//     bind an uncorrelated session;
//   - every host-visible progress/event/evidence leaf is bounded by UTF-8
//     bytes and redacted through one persistent per-lane window so secret,
//     token, Bearer, API-key, envelope-digest, and prompt signatures
//     cannot recombine across leaves, chunks, events, or reconciliations;
//   - every error surface is closed and content-free: hostile names and
//     values never appear in codes, paths, or messages;
//   - managed local worktrees and run_base_sha only: no direct-mode
//     widening, supervisor/registry/server cutover, durable store, or
//     protected-ref mutation. Legacy 3.2.1 behavior and public receipts
//     are untouched.

import { Buffer as NodeBuffer } from 'node:buffer';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  capturedDefineProperty,
  capturedDescriptor,
  capturedFreeze,
  capturedIncludes,
  capturedIsArray,
  capturedJoin,
  capturedTest,
  capturedUtf8ByteLength,
} from './grammar.mjs';
import { IDENTITY_LABELS } from './identity.mjs';
import { parseChildEnvelopeV1 } from './prompt-compiler.mjs';
import {
  DRIVER_RESULT_SCHEMA_IDS,
  PROVIDER_DRIVER_VERSION,
  validateDriverCancelRequestV1,
  validateDriverCancelResultV1,
  validateDriverDeclarationV1,
  validateDriverLaunchRequestV1,
  validateDriverLaunchResultV1,
  validateDriverPreflightRequestV1,
  validateDriverPreflightResultV1,
  validateDriverReconcileRequestV1,
  validateDriverReconcileResultV1,
} from './provider-driver.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  identityBoundDigest,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';

export { PROVIDER_DRIVER_VERSION };

export const CURSOR_LOCAL_DRIVER_SCHEMA_ID = 'codex-co-engineer.cursor-local-driver.v1';
export const CURSOR_LOCAL_PROVIDER = 'cursor-local';

const STRING = String;
const IS_PROXY = utilTypes.isProxy;
const TIMING_SAFE_EQUAL = cryptoTimingSafeEqual;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const OBJECT_FREEZE = Object.freeze;

export const CURSOR_LOCAL_OPTION_KEYS = capturedFreeze([
  'declaration', 'model', 'run_base_sha', 'transport', 'workspace_root',
]);

export const CURSOR_LOCAL_TRANSPORT_METHODS = capturedFreeze([
  'availability', 'cancel', 'observe', 'reply', 'send', 'spawn',
]);

export const CURSOR_LOCAL_EVIDENCE_REQUEST_SCHEMA_ID =
  'codex-co-engineer.cursor-local-evidence-request.v1';
export const CURSOR_LOCAL_EVIDENCE_SCHEMA_ID = 'codex-co-engineer.cursor-local-evidence.v1';
export const CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID =
  'codex-co-engineer.cursor-local-reply.v1';
export const CURSOR_LOCAL_REPLY_RESULT_SCHEMA_ID =
  'codex-co-engineer.cursor-local-reply-result.v1';

export const CURSOR_LOCAL_EVIDENCE_REQUEST_KEYS = capturedFreeze([
  'child_envelope_digest', 'envelope_text', 'schema', 'version',
]);
export const CURSOR_LOCAL_REPLY_REQUEST_KEYS = capturedFreeze([
  'answer_text', 'child_envelope_digest', 'envelope_text', 'question_id',
  'schema', 'session_id', 'version',
]);

export const EVIDENCE_KINDS = capturedFreeze(['attention', 'event', 'progress']);
export const OBSERVE_STATUSES = capturedFreeze(['attention', 'completed', 'failed', 'running']);
export const CANCEL_OUTCOMES = capturedFreeze(['confirmed', 'requested']);

// The only send failure that proves "nothing was written" is the explicit
// closed code below. Every other failure after a successful spawn is
// honestly reported as dispatch_uncertain instead of not_sent.
export const TRANSPORT_PRE_WRITE_FAILURE_CODE = 'pre_write_failure';
export const TRANSPORT_FAILURE_CODES = capturedFreeze([TRANSPORT_PRE_WRITE_FAILURE_CODE]);

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
export const SHA40_PATTERN = /^[0-9a-f]{40}$/u;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const WORKSPACE_ROOT_PATTERN = /^\/[A-Za-z0-9._/-]*$/u;

export const MAX_ANSWER_BYTES = 16 * 1024;
export const MAX_EVIDENCE_EVENTS = 64;
export const MAX_EVIDENCE_SEGMENT_BYTES = 8 * 1024;
export const MAX_LANE_EVIDENCE_BYTES = 64 * 1024;
export const REDACTION_CARRY_CHARS = 256;
export const REDACTION_SLICE_CHARS = 4096;

export const REDACTED_MARKER = '[REDACTED]';

// Closed signature vocabulary. Matches are replaced wholesale inside the
// persistent carry window, so a signature split across chunks, leaves,
// events, or reconciliations recombines only inside the window and is then
// redacted before any host-visible byte exists.
const SIGNATURE_PATTERNS = capturedFreeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bBasic\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/giu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/giu,
  /\b(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|cookie|credential|private[_-]?key)(?:\s*[:=]\s*)\s*(?:"[^"]*"|'[^']*'|[^\s,;&'"]+)/giu,
]);

function safeErrorCode(error) {
  // Reading properties off a thrown value may itself throw or run caller
  // code (getters, proxy traps). Only a plain own data property whose value
  // is exactly one closed code is ever honored; everything else fails
  // closed as post-spawn uncertainty.
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined;
  }
  try {
    const descriptor = capturedDescriptor(error, 'code');
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
      return undefined;
    }
    const value = descriptor.value;
    return typeof value === 'string' && capturedIncludes(TRANSPORT_FAILURE_CODES, value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function digestsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length) return false;
  try {
    return TIMING_SAFE_EQUAL(BUFFER_FROM(left, 'utf8'), BUFFER_FROM(right, 'utf8'));
  } catch {
    return false;
  }
}

function cutUtf8Bytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (capturedUtf8ByteLength(text) <= maxBytes) return text;
  const buffer = BUFFER_FROM(text, 'utf8');
  let cut = maxBytes;
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return buffer.subarray(0, cut).toString('utf8');
}

function redactSignatures(text) {
  let redacted = text;
  for (let index = 0; index < SIGNATURE_PATTERNS.length; index += 1) {
    redacted = redacted.replace(SIGNATURE_PATTERNS[index], REDACTED_MARKER);
  }
  return redacted;
}

// Persistent per-lane redaction window. Pieces enter in order; a bounded
// tail is withheld until the next piece arrives, so signatures split
// across pieces recombine inside the window and are redacted there. The
// window stays open for the life of the lane (including across reconcile
// calls); it is flushed once, when the lane reaches its terminal latch.
function createRedactionWindow() {
  let carry = '';
  let sealed = false;
  return freezeData({
    push(piece) {
      if (sealed || typeof piece !== 'string' || piece.length === 0) return '';
      const combined = carry + piece;
      if (combined.length <= REDACTION_CARRY_CHARS) {
        carry = combined;
        return '';
      }
      const emitLength = combined.length - REDACTION_CARRY_CHARS;
      carry = combined.slice(emitLength);
      return redactSignatures(combined.slice(0, emitLength));
    },
    flush() {
      if (sealed) return '';
      sealed = true;
      return carry.length === 0 ? '' : redactSignatures(carry);
    },
  });
}

// Bounded evidence sink. All host-visible text funnels through the lane's
// redaction window first, then through UTF-8 byte bounds per segment and
// per lane. Overflow sets `truncated` and drops further input silently:
// bounding failures are never errors and never leak content.
function createEvidenceSink() {
  const segments = [];
  const state = {
    current: '',
    currentBytes: 0,
    currentKind: undefined,
    seq: 0,
    totalBytes: 0,
    truncated: false,
  };
  function sealCurrent() {
    if (state.currentKind === undefined) return;
    capturedDefineProperty(segments, STRING(state.seq), {
      value: freezeData({
        bytes: state.currentBytes,
        kind: state.currentKind,
        seq: state.seq,
        text: state.current,
      }),
      enumerable: true,
      configurable: false,
      writable: false,
    });
    segments.length = state.seq + 1;
    state.seq += 1;
    state.current = '';
    state.currentBytes = 0;
    state.currentKind = undefined;
  }
  function ingest(text, kind) {
    if (state.truncated || typeof text !== 'string' || text.length === 0) return;
    let remaining = text;
    while (remaining.length > 0) {
      if (segments.length >= MAX_EVIDENCE_EVENTS
        || state.totalBytes >= MAX_LANE_EVIDENCE_BYTES) {
        state.truncated = true;
        return;
      }
      if (state.currentKind !== undefined
        && (state.currentKind !== kind || state.currentBytes >= MAX_EVIDENCE_SEGMENT_BYTES)) {
        sealCurrent();
        continue;
      }
      const room = Math.min(
        MAX_LANE_EVIDENCE_BYTES - state.totalBytes,
        MAX_EVIDENCE_SEGMENT_BYTES - state.currentBytes,
      );
      if (room <= 0) {
        state.truncated = true;
        return;
      }
      const piece = cutUtf8Bytes(remaining, room);
      state.current += piece;
      const pieceBytes = capturedUtf8ByteLength(piece);
      state.currentBytes += pieceBytes;
      state.totalBytes += pieceBytes;
      if (state.currentKind === undefined) state.currentKind = kind;
      remaining = remaining.slice(piece.length);
    }
  }
  return freezeData({
    ingest,
    drain() {
      sealCurrent();
      return freezeData({
        events: freezeData([...segments]),
        total_bytes: state.totalBytes,
        truncated: state.truncated,
      });
    },
  });
}

function requireExactString(source, key, path, pattern, code) {
  const value = optOwn(source, key);
  if (typeof value !== 'string' || !capturedTest(pattern, value)) {
    fail(code ?? 'invalid_format', `${path}.${key}`,
      `${path}.${key} is missing or outside the closed grammar.`);
  }
  return value;
}

function readTransportResult(result, path) {
  // One structural quarantine for every transport result: proxies,
  // accessors, symbols, non-enumerables, exotic prototypes, sparse arrays,
  // cycles, aliases, and unknown shapes are rejected without running any
  // caller code, before a single field is read.
  if (result === null || result === undefined) {
    fail('invalid_transport_result', path, 'The transport returned no result object.');
  }
  assertNotProxy(result, path);
  assertDirectJsonClosure(result, path);
  assertPlainObject(result, 'invalid_transport_result', path, path);
  return result;
}

function requireBindingEcho(result, expectedDigest, path) {
  const echo = optOwn(result, 'binding_digest');
  if (typeof echo !== 'string' || !digestsEqual(echo, expectedDigest)) {
    fail('uncorrelated_session', `${path}.binding_digest`,
      'The transport session did not echo the exact lane binding digest.');
  }
  return echo;
}

function requireSessionEcho(result, expectedSessionId, path) {
  const echo = optOwn(result, 'session_id');
  if (typeof echo !== 'string' || echo !== expectedSessionId) {
    fail('uncorrelated_session', `${path}.session_id`,
      'The transport session id does not match the exact spawned session.');
  }
  return echo;
}

function callTransport(transportMethods, methodName, argument) {
  let produced;
  try {
    produced = transportMethods[methodName](argument);
  } catch (error) {
    return { ok: false, error };
  }
  if (produced instanceof Promise || (produced !== null && typeof produced === 'object'
    && typeof produced.then === 'function')) {
    // The P19 surface is synchronous and process-local. A promise-returning
    // transport would make dispatch certainty unobservable, so it is
    // rejected before any await can hide an ambiguous send.
    return { ok: false, error: new Error('transport returned a promise') };
  }
  return { ok: true, value: produced };
}

function buildLaneBindingDigest(view, model) {
  return identityBoundDigest(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, {
    assignment_id: view.envelope.assignment_id,
    base_sha: view.envelope.repository.base_sha,
    child_envelope_digest: `sha256:${view.child_envelope_digest}`,
    lane_index: view.envelope.lane_index,
    model,
    provider: CURSOR_LOCAL_PROVIDER,
    repository_path: view.envelope.repository.path,
    run_id: view.envelope.run_id,
  });
}

function laneKeyFor(view) {
  return `${view.envelope.run_id}\u0000${view.envelope.assignment_id}`;
}

function assertAttentionQuestionShape(question, path) {
  assertPlainObject(question, 'invalid_transport_result', path, path);
  const keys = Object.keys(question).sort();
  if (keys.length !== 2 || keys[0] !== 'question_id' || keys[1] !== 'question_text') {
    fail('invalid_transport_result', path,
      'An attention question must carry exactly question_id and question_text.');
  }
  requireExactString(question, 'question_id', path, QUESTION_ID_PATTERN,
    'invalid_transport_result');
  const text = optOwn(question, 'question_text');
  if (typeof text !== 'string' || text.length === 0) {
    fail('invalid_transport_result', `${path}.question_text`,
      'An attention question must carry non-empty question text.');
  }
}

export function describeCursorLocalDriverV1() {
  return capturedFreeze({
    schema: CURSOR_LOCAL_DRIVER_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    provider: CURSOR_LOCAL_PROVIDER,
    operations: capturedFreeze(['preflight', 'launch', 'reconcile', 'cancel']),
    transports: capturedFreeze([]),
    transport_methods: CURSOR_LOCAL_TRANSPORT_METHODS,
    transport_mode: 'injected_local_session_seam',
    workspace_semantics: 'local_managed_worktree',
    workspace_starting_point: 'run_base_sha',
    replay_posture: 'never_replay',
    relaunch_operations: capturedFreeze([]),
    direct_mode: capturedFreeze([]),
    durable_store: false,
    bounds: freezeData({
      max_answer_bytes: MAX_ANSWER_BYTES,
      max_evidence_events: MAX_EVIDENCE_EVENTS,
      max_evidence_segment_bytes: MAX_EVIDENCE_SEGMENT_BYTES,
      max_lane_evidence_bytes: MAX_LANE_EVIDENCE_BYTES,
    }),
    evidence_kinds: EVIDENCE_KINDS,
    observe_statuses: OBSERVE_STATUSES,
    cancel_outcomes: CANCEL_OUTCOMES,
  });
}

function quarantineControlRequest(request, allowedKeys, schemaId, path) {
  if (request === null || request === undefined) {
    fail('invalid_type', path, `${path} must be a plain request object.`);
  }
  assertNotProxy(request, path);
  assertDirectJsonClosure(request, path);
  assertPlainObject(request, 'invalid_type', path, path);
  for (const key of Object.keys(request)) {
    if (!capturedIncludes(allowedKeys, key)) {
      fail('unknown_key', `${path}.${key}`,
        `${path} carries a key outside the closed schema.`);
    }
  }
  for (const key of allowedKeys) {
    if (!hasOwn(request, key)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} is required; nothing is derived.`);
    }
  }
  if (optOwn(request, 'schema') !== schemaId) {
    fail('schema_mismatch', `${path}.schema`, `${path}.schema must be exactly "${schemaId}".`);
  }
  if (optOwn(request, 'version') !== PROVIDER_DRIVER_VERSION) {
    fail('invalid_format', `${path}.version`,
      `${path}.version must be exactly ${PROVIDER_DRIVER_VERSION}.`);
  }
  return request;
}

function resolveControlLane(request, lanes, options, path) {
  const parsed = parseChildEnvelopeV1(optOwn(request, 'envelope_text'));
  const digest = requireExactString(request, 'child_envelope_digest', path, /^[0-9a-f]{64}$/u);
  const key = `${parsed.run_id}\u0000${parsed.assignment_id}`;
  const lane = lanes.get(key);
  if (lane === undefined || !digestsEqual(lane.childEnvelopeDigest, digest)) {
    fail('unknown_lane', `${path}.child_envelope_digest`,
      'No live lane is bound to this exact child envelope digest.');
  }
  if (parsed.repository.base_sha !== options.runBaseSha
    || parsed.execution.provider !== CURSOR_LOCAL_PROVIDER
    || parsed.execution.model !== options.model) {
    fail('stale_identity_denied', `${path}.envelope_text`,
      'The request envelope does not match the exact bound lane identity.');
  }
  return lane;
}

function assertProvenanceBound(view, options, path) {
  const execution = view.envelope.execution;
  if (execution.provider !== CURSOR_LOCAL_PROVIDER) {
    fail('provider_slot_mismatch', `${path}.envelope_text`,
      `The cursor-local driver binds only exact "${CURSOR_LOCAL_PROVIDER}" envelopes; `
      + 'unresolved or foreign provider slots are refused.');
  }
  if (typeof execution.model !== 'string' || execution.model.length === 0) {
    fail('model_unresolved', `${path}.envelope_text`,
      'The envelope carries no exact model; omitted models are never derived.');
  }
  if (execution.model !== options.model) {
    fail('model_substitution_denied', `${path}.envelope_text`,
      'The envelope model does not equal the exact bound model; substitution is denied.');
  }
  if (view.envelope.repository.base_sha !== options.runBaseSha) {
    fail('base_sha_substitution_denied', `${path}.envelope_text`,
      'The envelope base sha does not equal the exact run base sha; retargeting is denied.');
  }
}

function requireFeature(declaration, feature, path) {
  if (declaration.features[feature] === 'unsupported') {
    fail('unsupported_capability', path,
      `Feature "${feature}" is declared unsupported; the driver fails closed with no fallback.`);
  }
}

const DETAIL_MESSAGES = freezeData({
  dispatch_not_written: freezeData({
    detail_code: 'dispatch_not_written',
    detail_message: 'The transport guaranteed that no prompt bytes were written; '
      + 'nothing reached the provider.',
  }),
  spawn_unavailable: freezeData({
    detail_code: 'spawn_unavailable',
    detail_message: 'The cursor-local session could not be spawned; no prompt was dispatched.',
  }),
  transport_unavailable: freezeData({
    detail_code: 'transport_unavailable',
    detail_message: 'The cursor-local transport reported no availability for this host.',
  }),
});

const DETAIL_FOR = freezeData({
  launch_not_sent_spawn: DETAIL_MESSAGES.spawn_unavailable,
  launch_not_sent_prewrite: DETAIL_MESSAGES.dispatch_not_written,
  preflight_blocked: DETAIL_MESSAGES.transport_unavailable,
});

export function createCursorLocalDriverV1(options) {
  const path = 'cursor_local_driver.options';
  if (options === null || options === undefined) {
    fail('invalid_type', path, 'Driver options are required; nothing is defaulted.');
  }

  // Single content-free structural quarantine over the options. The JSON
  // leaves are closed directly; the transport is validated separately as a
  // plain concrete-method object so its functions never enter the JSON
  // closure. Neither pass ever invokes caller code.
  assertNotProxy(options, path);
  assertPlainObject(options, 'invalid_type', path, path);
  for (const key of Object.keys(options)) {
    if (!capturedIncludes(CURSOR_LOCAL_OPTION_KEYS, key)) {
      fail('unknown_key', `${path}.${key}`, `${path} carries a key outside the closed option set.`);
    }
  }
  for (const key of ['declaration', 'model', 'run_base_sha', 'transport']) {
    if (!hasOwn(options, key)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
  for (const key of ['declaration', 'model', 'run_base_sha', 'workspace_root']) {
    if (hasOwn(options, key)) assertDirectJsonClosure(ownDataValue(options, key, `${path}.${key}`), `${path}.${key}`);
  }

  const declaration = validateDriverDeclarationV1(optOwn(options, 'declaration'));
  if (declaration.capability.provider !== CURSOR_LOCAL_PROVIDER) {
    fail('provider_mismatch', `${path}.declaration.capability.provider`,
      `The cursor-local driver requires the exact "${CURSOR_LOCAL_PROVIDER}" capability slot.`);
  }
  if (declaration.capability.workspace_semantics !== 'local_managed_worktree'
    || declaration.capability.workspace_starting_point !== 'run_base_sha') {
    fail('capability_workspace_mismatch', `${path}.declaration.capability`,
      'Only managed local worktrees started from the run base sha are in scope.');
  }
  if (declaration.capability.replay_posture !== 'never_replay') {
    fail('invalid_replay_posture', `${path}.declaration.capability.replay_posture`,
      'The cursor-local driver never replays a dispatched prompt.');
  }
  if (!capturedIncludes(['confirmed_launch', 'uncertain_after_spawn'],
    declaration.capability.dispatch_certainty)) {
    fail('capability_dispatch_certainty_mismatch',
      `${path}.declaration.capability.dispatch_certainty`,
      'Dispatch certainty must name a closed P05 posture.');
  }
  if (!capturedIncludes(['live_session_reply', 'unsupported_unresolved_attention'],
    declaration.capability.same_session_reply)) {
    fail('capability_reply_mismatch', `${path}.declaration.capability.same_session_reply`,
      'Same-session reply must name a closed P05 posture.');
  }

  const model = requireExactString(options, 'model', path, MODEL_ID_PATTERN, 'invalid_model');
  const runBaseSha = requireExactString(options, 'run_base_sha', path, SHA40_PATTERN,
    'invalid_run_base_sha');
  const workspaceRoot = hasOwn(options, 'workspace_root')
    ? requireExactString(options, 'workspace_root', path, WORKSPACE_ROOT_PATTERN,
      'invalid_workspace_root')
    : undefined;

  const transportPath = `${path}.transport`;
  const transportInput = optOwn(options, 'transport');
  if (transportInput !== null && (typeof transportInput === 'object'
    || typeof transportInput === 'function') && IS_PROXY(transportInput)) {
    fail('proxy_denied', transportPath,
      'The transport is a live or revoked Proxy; concrete method objects only.');
  }
  if (transportInput === null || typeof transportInput !== 'object'
    || capturedIsArray(transportInput)) {
    fail('invalid_type', transportPath, 'The transport must be a plain object of methods.');
  }
  let transportPrototype;
  try {
    transportPrototype = Object.getPrototypeOf(transportInput);
  } catch {
    fail('exotic_prototype_denied', transportPath, 'The transport prototype rejected inspection.');
  }
  if (transportPrototype !== Object.prototype && transportPrototype !== null) {
    fail('exotic_prototype_denied', transportPath,
      'The transport must use the standard or null prototype.');
  }
  const transportKeys = Object.keys(transportInput).sort();
  const expectedKeys = [...CURSOR_LOCAL_TRANSPORT_METHODS].sort();
  if (transportKeys.length !== expectedKeys.length
    || transportKeys.some((key, index) => key !== expectedKeys[index])) {
    fail('invalid_surface', transportPath,
      `The transport must expose exactly ${capturedJoin(CURSOR_LOCAL_TRANSPORT_METHODS, ', ')}.`);
  }
  const transportMethods = {};
  for (const method of CURSOR_LOCAL_TRANSPORT_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(transportInput, method);
    if (!descriptor || !descriptor.enumerable || descriptor.get !== undefined
      || descriptor.set !== undefined || typeof descriptor.value !== 'function'
      || IS_PROXY(descriptor.value)) {
      fail('invalid_operation', `${transportPath}.${method}`,
        `Transport ${method} must be a plain concrete function.`);
    }
    transportMethods[method] = descriptor.value;
  }

  // Detached, fully validated configuration. No live caller object is kept:
  // nothing can mutate a validated value back into an unvalidated one.
  const config = freezeData({ model, runBaseSha, workspaceRoot });

  const lanes = new Map();

  function laneFromView(view) {
    const key = laneKeyFor(view);
    const digestHex = view.child_envelope_digest;
    const existing = lanes.get(key);
    if (existing !== undefined && !digestsEqual(existing.childEnvelopeDigest, digestHex)) {
      fail('stale_identity_denied', 'driver.request.child_envelope_digest',
        'The request envelope digest does not match the exact child previously bound to this lane.');
    }
    if (existing !== undefined) return existing;
    const lane = {
      assignmentId: view.envelope.assignment_id,
      bindingDigest: buildLaneBindingDigest(view, model),
      childEnvelopeDigest: digestHex,
      evidence: null,
      laneIndex: view.envelope.lane_index,
      phase: {
        acked: false,
        replyAttempts: 0,
        replyOutcome: undefined,
        sendAttempted: false,
        sendUncertain: false,
        spawned: false,
        sessionId: undefined,
      },
      question: undefined,
      repositoryPath: view.envelope.repository.path,
      runId: view.envelope.run_id,
      state: 'absent',
      terminalReason: undefined,
      window: createRedactionWindow(),
    };
    lanes.set(key, lane);
    return lane;
  }

  function ensureEvidenceSink(lane) {
    if (lane.evidence === null) lane.evidence = createEvidenceSink();
    return lane.evidence;
  }

  function ingestVisibleText(lane, sink, text, kind) {
    let pending = typeof text === 'string' ? text : '';
    while (pending.length > 0) {
      let head = pending.slice(0, REDACTION_SLICE_CHARS);
      // Never split a UTF-16 surrogate pair at the slice boundary: the
      // redaction window must see whole characters or its emitted bytes
      // could disagree with the bounded byte accounting.
      if (head.length === REDACTION_SLICE_CHARS) {
        const last = head.charCodeAt(head.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
      }
      pending = pending.slice(head.length);
      const emitted = lane.window.push(head);
      if (emitted.length > 0) sink.ingest(emitted, kind);
    }
  }

  function flushLaneWindow(lane) {
    if (lane.evidence === null && lane.windowFlushed) return;
    lane.windowFlushed = true;
    const emitted = lane.window.flush();
    if (emitted.length > 0) {
      const sink = ensureEvidenceSink(lane);
      sink.ingest(emitted, 'event');
    }
  }

  function receiptFor(operation, view, disposition, detail) {
    const receipt = {
      schema: DRIVER_RESULT_SCHEMA_IDS[operation],
      version: PROVIDER_DRIVER_VERSION,
      run_id: view.envelope.run_id,
      assignment_id: view.envelope.assignment_id,
      lane_index: view.envelope.lane_index,
      base_sha: view.envelope.repository.base_sha,
      child_envelope_digest: view.child_envelope_digest,
      disposition,
    };
    if (detail !== undefined) {
      receipt.detail_code = detail.detail_code;
      receipt.detail_message = detail.detail_message;
    }
    return receipt;
  }

  const driver = {};

  capturedDefineProperty(driver, 'preflight', {
    configurable: false,
    enumerable: true,
    value: function preflight(request) {
      const view = validateDriverPreflightRequestV1(request);
      assertProvenanceBound(view, config, 'driver.preflight.request');
      const lane = laneFromView(view);
      if (!(lane.state === 'absent' || lane.state === 'ready' || lane.state === 'blocked'
        || lane.state === 'not_sent')) {
        fail('invalid_transition', 'driver.preflight.request',
          'Preflight cannot run after a prompt may have been dispatched.');
      }
      if (lane.state === 'ready' || lane.state === 'blocked') {
        return validateDriverPreflightResultV1(
          receiptFor('preflight', view, lane.state,
            lane.state === 'blocked' ? DETAIL_FOR.preflight_blocked : undefined),
          request, declaration,
        );
      }
      const probe = freezeData({ binding_digest: lane.bindingDigest });
      const outcome = callTransport(transportMethods, 'availability', probe);
      if (!outcome.ok) {
        lane.state = 'blocked';
        return validateDriverPreflightResultV1(
          receiptFor('preflight', view, 'blocked', DETAIL_FOR.preflight_blocked),
          request, declaration,
        );
      }
      const availability = readTransportResult(outcome.value, 'driver.preflight.availability.result');
      const available = optOwn(availability, 'available');
      if (available !== true && available !== false) {
        fail('invalid_transport_result', 'driver.preflight.availability.result.available',
          'Transport availability must be exactly true or false.');
      }
      lane.state = available ? 'ready' : 'blocked';
      return validateDriverPreflightResultV1(
        receiptFor('preflight', view, lane.state,
          available ? undefined : DETAIL_FOR.preflight_blocked),
        request, declaration,
      );
    },
  });

  capturedDefineProperty(driver, 'launch', {
    configurable: false,
    enumerable: true,
    value: function launch(request) {
      const view = validateDriverLaunchRequestV1(request);
      assertProvenanceBound(view, config, 'driver.launch.request');
      const lane = laneFromView(view);
      if (lane.state === 'absent') {
        fail('not_preflighted', 'driver.launch.request',
          'Launch requires a prior preflight:ready result for this exact child identity.');
      }
      if (lane.state === 'blocked') {
        fail('blocked_lane_denied', 'driver.launch.request',
          'A blocked preflight cannot launch; the lane fails closed with no fallback.');
      }
      if (lane.phase.spawned || lane.phase.sendAttempted) {
        fail('replay_denied', 'driver.launch.request',
          'This lane already spawned or dispatched; prompts are never replayed.');
      }
      const spawnRequest = freezeData({
        assignment_id: lane.assignmentId,
        base_sha: config.runBaseSha,
        binding_digest: lane.bindingDigest,
        lane_index: lane.laneIndex,
        model: config.model,
        repository_path: lane.repositoryPath,
        run_id: lane.runId,
        ...(config.workspaceRoot !== undefined ? { workspace_root: config.workspaceRoot } : {}),
      });
      const spawnOutcome = callTransport(transportMethods, 'spawn', spawnRequest);
      if (!spawnOutcome.ok) {
        lane.state = 'not_sent';
        return validateDriverLaunchResultV1(
          receiptFor('launch', view, 'not_sent', DETAIL_FOR.launch_not_sent_spawn),
          request, declaration,
        );
      }
      const spawned = readTransportResult(spawnOutcome.value, 'driver.launch.spawn.result');
      const sessionId = requireExactString(spawned, 'session_id', 'driver.launch.spawn.result',
        SESSION_ID_PATTERN, 'invalid_transport_result');
      requireBindingEcho(spawned, lane.bindingDigest, 'driver.launch.spawn.result');
      lane.phase.spawned = true;
      lane.phase.sessionId = sessionId;
      lane.state = 'spawned';

      // Exactly one dispatch attempt per lane, forever.
      lane.phase.sendAttempted = true;
      const sendRequest = freezeData({
        binding_digest: lane.bindingDigest,
        prompt_utf8_bytes: capturedUtf8ByteLength(view.request.envelope_text),
        prompt_text: view.request.envelope_text,
        session_id: sessionId,
      });
      const sendOutcome = callTransport(transportMethods, 'send', sendRequest);
      if (!sendOutcome.ok) {
        if (safeErrorCode(sendOutcome.error) === TRANSPORT_PRE_WRITE_FAILURE_CODE) {
          lane.state = 'not_sent';
          return validateDriverLaunchResultV1(
            receiptFor('launch', view, 'not_sent', DETAIL_FOR.launch_not_sent_prewrite),
            request, declaration,
          );
        }
        lane.phase.sendUncertain = true;
        lane.state = 'dispatch_uncertain';
        return validateDriverLaunchResultV1(
          receiptFor('launch', view, 'dispatch_uncertain'), request, declaration,
        );
      }
      const sent = readTransportResult(sendOutcome.value, 'driver.launch.send.result');
      requireBindingEcho(sent, lane.bindingDigest, 'driver.launch.send.result');
      requireSessionEcho(sent, sessionId, 'driver.launch.send.result');
      if (optOwn(sent, 'acknowledged') !== true) {
        fail('acknowledgement_required', 'driver.launch.send.result.acknowledged',
          'The transport must authoritatively acknowledge the prompt before dispatched.');
      }
      lane.phase.acked = true;
      lane.state = 'dispatched';
      return validateDriverLaunchResultV1(
        receiptFor('launch', view, 'dispatched'), request, declaration,
      );
    },
  });

  capturedDefineProperty(driver, 'reconcile', {
    configurable: false,
    enumerable: true,
    value: function reconcile(request) {
      const view = validateDriverReconcileRequestV1(request);
      assertProvenanceBound(view, config, 'driver.reconcile.request');
      const lane = laneFromView(view);
      if (!lane.phase.sendAttempted) {
        fail('not_dispatched', 'driver.reconcile.request',
          'Reconcile addresses an existing dispatch; no prompt was ever attempted.');
      }
      if (view.intent === 'restart_reattach') {
        requireFeature(declaration, 'restart', 'driver.reconcile.request.intent');
      }
      for (let index = 0; index < view.include.length; index += 1) {
        requireFeature(declaration, view.include[index],
          `driver.reconcile.request.include[${index}]`);
      }
      if (lane.state === 'terminal') {
        return validateDriverReconcileResultV1(
          receiptFor('reconcile', view, 'terminal'), request, declaration,
        );
      }
      const observeRequest = freezeData({
        binding_digest: lane.bindingDigest,
        include: freezeData([...view.include]),
        intent: view.intent,
        session_id: lane.phase.sessionId,
      });
      const observeOutcome = callTransport(transportMethods, 'observe', observeRequest);
      if (!observeOutcome.ok) {
        fail('observe_failed', 'driver.reconcile.observe',
          'The transport observation failed; the lane keeps its exact identity and state.');
      }
      const observed = readTransportResult(observeOutcome.value, 'driver.reconcile.observe.result');
      requireBindingEcho(observed, lane.bindingDigest, 'driver.reconcile.observe.result');
      requireSessionEcho(observed, lane.phase.sessionId, 'driver.reconcile.observe.result');
      const status = requireExactString(observed, 'status', 'driver.reconcile.observe.result',
        /^[a-z_]{1,24}$/u, 'invalid_transport_result');
      if (!capturedIncludes(OBSERVE_STATUSES, status)) {
        fail('invalid_transport_result', 'driver.reconcile.observe.result.status',
          'Observation status is outside the closed vocabulary.');
      }

      const wantsEvidence = capturedIncludes(view.include, 'detailed_events')
        || capturedIncludes(view.include, 'live_progress');
      const sink = wantsEvidence ? ensureEvidenceSink(lane) : undefined;
      const progressText = optOwn(observed, 'progress_text');
      if (progressText !== undefined) {
        if (typeof progressText !== 'string' || progressText.length === 0) {
          fail('invalid_transport_result', 'driver.reconcile.observe.result.progress_text',
            'Progress text must be a non-empty string when present.');
        }
        if (!wantsEvidence) {
          fail('evidence_include_required', 'driver.reconcile.observe.result.progress_text',
            'Progress text arrives only when live_progress or detailed_events is included.');
        }
        ingestVisibleText(lane, sink, progressText, 'progress');
      }
      const events = optOwn(observed, 'events');
      if (events !== undefined) {
        if (!capturedIsArray(events)) {
          fail('invalid_transport_result', 'driver.reconcile.observe.result.events',
            'Events must arrive as a dense array of strings.');
        }
        const eventCount = events.length;
        if (!wantsEvidence && eventCount > 0) {
          fail('evidence_include_required', 'driver.reconcile.observe.result.events',
            'Event text arrives only when detailed_events or live_progress is included.');
        }
        for (let index = 0; index < eventCount; index += 1) {
          const chunk = optOwn(events, STRING(index));
          if (typeof chunk !== 'string' || chunk.length === 0) {
            fail('invalid_transport_result',
              `driver.reconcile.observe.result.events[${index}]`,
              'Every event chunk must be a non-empty string.');
          }
          if (sink !== undefined) ingestVisibleText(lane, sink, chunk, 'event');
        }
      }
      const question = optOwn(observed, 'question');
      if (status === 'attention') {
        if (question === undefined) {
          fail('invalid_transport_result', 'driver.reconcile.observe.result.question',
            'An attention observation must carry exactly one question.');
        }
        assertAttentionQuestionShape(question, 'driver.reconcile.observe.result.question');
        if (wantsEvidence) {
          ingestVisibleText(lane, sink, optOwn(question, 'question_text'), 'attention');
        }
        lane.question = freezeData({ question_id: optOwn(question, 'question_id') });
        lane.state = 'unresolved_attention';
        return validateDriverReconcileResultV1(
          receiptFor('reconcile', view, 'unresolved_attention'), request, declaration,
        );
      }
      if (question !== undefined) {
        fail('invalid_transport_result', 'driver.reconcile.observe.result.question',
          'A non-attention observation must not carry a question.');
      }
      if (status === 'completed' || status === 'failed') {
        lane.state = 'terminal';
        lane.terminalReason = status;
        flushLaneWindow(lane);
        return validateDriverReconcileResultV1(
          receiptFor('reconcile', view, 'terminal'), request, declaration,
        );
      }
      lane.state = 'in_progress';
      return validateDriverReconcileResultV1(
        receiptFor('reconcile', view, 'in_progress'), request, declaration,
      );
    },
  });

  capturedDefineProperty(driver, 'cancel', {
    configurable: false,
    enumerable: true,
    value: function cancel(request) {
      const view = validateDriverCancelRequestV1(request);
      assertProvenanceBound(view, config, 'driver.cancel.request');
      const lane = laneFromView(view);
      requireFeature(declaration, 'cancellation', 'driver.cancel.request');
      if (!lane.phase.sendAttempted) {
        fail('not_dispatched', 'driver.cancel.request',
          'Cancel addresses an existing dispatch; no prompt was ever attempted.');
      }
      if (lane.state === 'terminal') {
        return validateDriverCancelResultV1(
          receiptFor('cancel', view, 'already_terminal'), request, declaration,
        );
      }
      const cancelRequest = freezeData({
        binding_digest: lane.bindingDigest,
        session_id: lane.phase.sessionId,
      });
      const cancelOutcome = callTransport(transportMethods, 'cancel', cancelRequest);
      if (!cancelOutcome.ok) {
        fail('cancel_failed', 'driver.cancel',
          'The cancellation request failed; the lane keeps its exact identity and state.');
      }
      const cancelled = readTransportResult(cancelOutcome.value, 'driver.cancel.result');
      requireBindingEcho(cancelled, lane.bindingDigest, 'driver.cancel.result');
      requireSessionEcho(cancelled, lane.phase.sessionId, 'driver.cancel.result');
      const outcome = requireExactString(cancelled, 'outcome', 'driver.cancel.result',
        /^[a-z_]{1,24}$/u, 'invalid_transport_result');
      if (!capturedIncludes(CANCEL_OUTCOMES, outcome)) {
        fail('invalid_transport_result', 'driver.cancel.result.outcome',
          'Cancellation outcome is outside the closed vocabulary.');
      }
      if (outcome === 'confirmed') {
        lane.state = 'terminal';
        lane.terminalReason = 'cancelled';
        flushLaneWindow(lane);
        return validateDriverCancelResultV1(
          receiptFor('cancel', view, 'cancel_confirmed'), request, declaration,
        );
      }
      lane.state = 'cancel_requested';
      return validateDriverCancelResultV1(
        receiptFor('cancel', view, 'cancel_requested'), request, declaration,
      );
    },
  });

  function submitAttentionReply(request) {
    const replyPath = 'cursor_local.reply.request';
    quarantineControlRequest(request, CURSOR_LOCAL_REPLY_REQUEST_KEYS,
      CURSOR_LOCAL_REPLY_REQUEST_SCHEMA_ID, replyPath);
    // An unsupported reply posture refuses explicitly, before any lane or
    // transport is consulted, and never starts a new prompt instead.
    if (declaration.capability.same_session_reply !== 'live_session_reply') {
      fail('reply_unsupported', `${replyPath}.schema`,
        'Same-session reply is unsupported for this posture; the refusal is explicit.');
    }
    const answerText = requireExactString(request, 'answer_text', replyPath, /^[\s\S]+$/u,
      'invalid_answer');
    if (capturedUtf8ByteLength(answerText) > MAX_ANSWER_BYTES) {
      fail('answer_too_large', `${replyPath}.answer_text`,
        `answer_text exceeds the ${MAX_ANSWER_BYTES}-byte bound.`);
    }
    const sessionId = requireExactString(request, 'session_id', replyPath, SESSION_ID_PATTERN,
      'invalid_format');
    const questionId = requireExactString(request, 'question_id', replyPath, QUESTION_ID_PATTERN,
      'invalid_format');
    const lane = resolveControlLane(request, lanes, config, replyPath);
    if (lane.phase.replyAttempts > 0) {
      fail('reply_already_attempted', `${replyPath}.question_id`,
        'This question was already answered once; replies are attempt-once.');
    }
    if (lane.state !== 'unresolved_attention' || lane.question === undefined) {
      fail('no_attention_question', `${replyPath}.question_id`,
        'No attention question is outstanding on this exact lane.');
    }
    if (lane.question.question_id !== questionId) {
      fail('question_mismatch', `${replyPath}.question_id`,
        'The reply question does not equal the exact outstanding question.');
    }
    if (lane.phase.sessionId !== sessionId) {
      fail('uncorrelated_session', `${replyPath}.session_id`,
        'The reply session does not match the exact spawned session.');
    }
    // Consume the one-shot budget before touching the transport so a
    // throwing or lying transport can never earn a second attempt.
    lane.phase.replyAttempts += 1;
    const replyRequest = freezeData({
      answer_text: answerText,
      binding_digest: lane.bindingDigest,
      question_id: questionId,
      session_id: sessionId,
    });
    const replyOutcome = callTransport(transportMethods, 'reply', replyRequest);
    if (!replyOutcome.ok) {
      lane.phase.replyOutcome = 'failed';
      fail('reply_transport_failed', 'cursor_local.reply',
        'The same-session reply failed once and will never be retried.');
    }
    const replied = readTransportResult(replyOutcome.value, 'cursor_local.reply.result');
    requireBindingEcho(replied, lane.bindingDigest, 'cursor_local.reply.result');
    requireSessionEcho(replied, sessionId, 'cursor_local.reply.result');
    if (optOwn(replied, 'answered') !== true) {
      lane.phase.replyOutcome = 'failed';
      fail('reply_transport_failed', 'cursor_local.reply.result.answered',
        'The transport did not authoritatively confirm the reply.');
    }
    lane.phase.replyOutcome = 'answered';
    lane.question = undefined;
    lane.state = 'in_progress';
    return freezeData({
      schema: CURSOR_LOCAL_REPLY_RESULT_SCHEMA_ID,
      version: PROVIDER_DRIVER_VERSION,
      run_id: lane.runId,
      assignment_id: lane.assignmentId,
      lane_index: lane.laneIndex,
      base_sha: config.runBaseSha,
      child_envelope_digest: lane.childEnvelopeDigest,
      session_id: sessionId,
      question_id: questionId,
      answered: true,
    });
  }

  function readEvidence(request) {
    const evidencePath = 'cursor_local.evidence.request';
    quarantineControlRequest(request, CURSOR_LOCAL_EVIDENCE_REQUEST_KEYS,
      CURSOR_LOCAL_EVIDENCE_REQUEST_SCHEMA_ID, evidencePath);
    const lane = resolveControlLane(request, lanes, config, evidencePath);
    if (lane.evidence === null) {
      return freezeData({
        schema: CURSOR_LOCAL_EVIDENCE_SCHEMA_ID,
        version: PROVIDER_DRIVER_VERSION,
        events: freezeData([]),
        total_bytes: 0,
        truncated: false,
      });
    }
    const drained = lane.evidence.drain();
    return freezeData({
      schema: CURSOR_LOCAL_EVIDENCE_SCHEMA_ID,
      version: PROVIDER_DRIVER_VERSION,
      events: drained.events,
      total_bytes: drained.total_bytes,
      truncated: drained.truncated,
    });
  }

  return freezeData({
    schema: CURSOR_LOCAL_DRIVER_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    provider: CURSOR_LOCAL_PROVIDER,
    declaration,
    driver: OBJECT_FREEZE(driver),
    controls: freezeData({
      readEvidence: capturedFreeze(readEvidence),
      submitAttentionReply: capturedFreeze(submitAttentionReply),
    }),
  });
}

capturedFreeze(createCursorLocalDriverV1);
capturedFreeze(describeCursorLocalDriverV1);
