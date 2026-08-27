// Grok ACP ProviderDriverV1 adapter (P18).
//
// Additive v3 module. It owns ONLY the Grok-specific binding of the accepted
// P17 envelope/capability contract onto an injected bounded ACP transport:
//   - provider slot is exactly `grok` with the exact selected model;
//   - launch proof is the P03 ChildEnvelopeV1 text bytes plus raw lowercase
//     64-hex digest (digest-only launches stay denied by P17);
//   - capability declaration is the accepted P05/P17 13-field record
//     (confirmed_launch, live_session_reply, local_managed_worktree,
//     run_base_sha, never_replay, merge none, create_pr prohibited);
//   - preflight/launch/reconcile/cancel talk to a process-injected transport
//     suitable for deterministic tests, not a live Grok stdio client;
//   - launch is `dispatched` only after an authoritative ACP acknowledgement;
//     any exception, timeout, loss, or unusable receipt after spawn/dispatch
//     intent is returned as `dispatch_uncertain` and is never retried,
//     replayed, or fallback-substituted;
//   - live progress, detailed events, same-session reply identity,
//     cancellation confirmation, and restart reattach are supported exactly
//     where Grok ACP supports them, with stale identities failing closed;
//   - completed, failed, cancelled, cancel_confirmed, and already_terminal
//     latch process-local terminal evidence; later reconcile stays terminal
//     and later cancel is already_terminal with no further transport cancel.
//     cancel_requested stays nonterminal. Blocked-preflight receipts are
//     validated, then provider detail is replaced with a fixed local pair;
//   - event pages, text, counts, cursors, timings, and diagnostics are capped;
//     envelope/prompt content is dispatch evidence and must not enter
//     telemetry or driver detail messages.
//
// This slice does not cut the supervisor over, does not claim durable
// P19/P21 state, and is not live-transport qualification. Process-local
// lane risk from P17 bind-on-throw remains: the adapter keeps its own
// spawn/dispatch-intent map so a thrown caller still cannot replay.

import { Buffer as NodeBuffer } from 'node:buffer';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { MAX_TIMEOUT_MS } from './contract.mjs';
import {
  capturedCreate,
  capturedDefineProperty,
  capturedDescriptor,
  capturedFreeze,
  capturedIncludes,
  capturedIsArray,
  capturedJoin,
  capturedTest,
  capturedUtf8ByteLength,
  isModelId,
  sortedCapturedKeys,
} from './grammar.mjs';
import { DIGEST_HEX_LENGTH, IDENTITY_LABELS } from './identity.mjs';
import { parseChildEnvelopeV1 } from './prompt-compiler.mjs';
import {
  DRIVER_DECLARATION_SCHEMA_ID,
  DRIVER_FEATURE_VALUES,
  DRIVER_OPERATIONS,
  DRIVER_RESULT_SCHEMA_IDS,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_DRIVER_VERSION,
  RECONCILE_INCLUDE_VALUES,
  assertProviderDriverV1,
  bindProviderDriverV1,
  validateDriverCancelRequestV1,
  validateDriverDeclarationV1,
  validateDriverLaunchRequestV1,
  validateDriverPreflightRequestV1,
  validateDriverReconcileRequestV1,
} from './provider-driver.mjs';
import { boundedProviderValue } from './provider-result.mjs';
import {
  assertAllowedKeys,
  assertBoundedText,
  assertDenseJsonArray,
  assertJsonDataObject,
  isPlainObject,
} from './run-manifest.mjs';
import {
  SHA256_DIGEST_PATTERN,
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

export const GROK_PROVIDER_SLOT = 'grok';
export const GROK_ACP_AGENT = 'grok-build';
export const GROK_ACP_DRIVER_SCHEMA_ID = 'codex-co-engineer.grok-acp-driver.v1';
export const GROK_ACP_TRANSPORT_SCHEMA_ID = 'codex-co-engineer.grok-acp-transport.v1';
export const GROK_ACP_EVIDENCE_SCHEMA_ID = 'codex-co-engineer.grok-acp-evidence.v1';
export const GROK_ACP_CAPABILITY_REVISION = 'p18.grok-acp.1';

export const GROK_ACP_TRANSPORT_OPERATIONS = capturedFreeze([
  'preflight', 'spawn', 'dispatch', 'observe', 'cancel', 'reattach',
]);

export const GROK_ACP_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const GROK_ACP_QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
export const GROK_ACP_CURSOR_PATTERN = /^[0-9]{1,16}$/u;
export const GROK_ACP_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const MAX_GROK_ACP_EVENT_PAGE = 32;
export const MAX_GROK_ACP_EVENT_TEXT_BYTES = 4 * 1024;
export const MAX_GROK_ACP_EVENT_BYTES = 32 * 1024;
export const MAX_GROK_ACP_EVENT_DEPTH = 6;
export const MAX_GROK_ACP_EVENT_ITEMS = 64;
export const MAX_GROK_ACP_EVENT_KEYS = 32;
export const MAX_GROK_ACP_EVIDENCE_BYTES = 32 * 1024;
export const MAX_GROK_ACP_ATTENTION_PROMPT_BYTES = 256;
export const MAX_GROK_ACP_TIMING_MS = MAX_TIMEOUT_MS;
export const MAX_GROK_ACP_EVENT_COUNT = 1_000_000;

export const GROK_ACP_OBSERVE_STATUSES = capturedFreeze([
  'running', 'needs_attention', 'completed', 'failed', 'cancelled', 'lost',
]);
export const GROK_ACP_CANCEL_OUTCOMES = capturedFreeze([
  'cancel_requested', 'cancel_confirmed', 'already_terminal',
]);

const CHILD_ENVELOPE_DIGEST_PATTERN = new RegExp(`^[0-9a-f]{${DIGEST_HEX_LENGTH}}$`, 'u');
const DETAIL_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DETAIL_MESSAGE_MAX_BYTES = 512;

const ARRAY_PUSH = Array.prototype.push;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const IS_PROXY = utilTypes.isProxy;
const MAP_CTOR = Map;
const OBJECT_FREEZE = Object.freeze;
const SET_CTOR = Set;
const SET_ADD = SET_CTOR.prototype.add;
const SET_HAS = SET_CTOR.prototype.has;
const STRING = String;
const TIMING_SAFE_EQUAL = cryptoTimingSafeEqual;
const WEAK_MAP_CTOR = WeakMap;

const OMIT_EVENT_KEYS = capturedFreeze([
  'availablecommands', 'content', 'envelope_text', 'prompt', 'rawinput', 'rawoutput',
]);
const SENSITIVE_EVENT_KEY = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|cookie|credential|private[_-]?key|(?<![a-z0-9])prompt(?!_dispatched))/iu;

const PREFLIGHT_RECEIPT_KEYS = capturedFreeze([
  'ok', 'provider', 'model', 'run_id', 'assignment_id', 'lane_index', 'base_sha',
  'child_envelope_digest', 'repository_path', 'detail_code', 'detail_message',
]);
const SPAWN_RECEIPT_KEYS = capturedFreeze([
  'spawned', 'session_id', 'provider', 'model', 'run_id', 'assignment_id',
  'lane_index', 'base_sha', 'child_envelope_digest', 'repository_path',
]);
const DISPATCH_RECEIPT_KEYS = capturedFreeze([
  'acknowledged', 'session_id', 'request_id', 'provider', 'model', 'run_id',
  'assignment_id', 'lane_index', 'base_sha', 'child_envelope_digest', 'repository_path',
]);
const OBSERVE_RECEIPT_KEYS = capturedFreeze([
  'session_id', 'provider', 'model', 'run_id', 'assignment_id', 'lane_index',
  'base_sha', 'child_envelope_digest', 'repository_path', 'status', 'events', 'progress',
  'attention', 'cursor', 'elapsed_ms', 'event_count',
]);
const CANCEL_RECEIPT_KEYS = capturedFreeze([
  'outcome', 'session_id', 'provider', 'model', 'run_id', 'assignment_id',
  'lane_index', 'base_sha', 'child_envelope_digest', 'repository_path',
]);
const REATTACH_RECEIPT_KEYS = capturedFreeze([
  'reattached', 'session_id', 'provider', 'model', 'run_id', 'assignment_id',
  'lane_index', 'base_sha', 'child_envelope_digest', 'repository_path',
]);
const ATTENTION_KEYS = capturedFreeze(['session_id', 'question_id', 'prompt']);
const PROGRESS_KEYS = capturedFreeze(['cursor', 'event_count', 'elapsed_ms', 'status']);
const EVIDENCE_QUERY_KEYS = capturedFreeze([
  'run_id', 'assignment_id', 'child_envelope_digest', 'cursor',
]);
const POST_SPAWN_ERROR_CODES = capturedFreeze([
  'dispatch_ack_missing', 'transport_exception', 'transport_lost', 'transport_timeout',
]);
const TERMINAL_OBSERVE_STATUSES = capturedFreeze(['completed', 'failed', 'cancelled']);
const TERMINAL_CANCEL_OUTCOMES = capturedFreeze(['cancel_confirmed', 'already_terminal']);
const TERMINAL_LATCH_STATES = capturedFreeze([
  'terminal', 'cancel_confirmed', 'already_terminal',
]);
const POSSIBLE_SEND_STATES = capturedFreeze([
  'spawned', 'dispatch_uncertain', 'dispatched', 'in_progress', 'unresolved_attention',
  'terminal', 'cancel_requested', 'cancel_confirmed', 'already_terminal',
]);
const BLOCKED_PREFLIGHT_DETAIL = capturedFreeze({
  detail_code: 'preflight_blocked',
  detail_message: 'Grok ACP preflight is blocked; the lane fails closed with no fallback.',
});
const DRIVER_STORES = new WEAK_MAP_CTOR();

const GROK_ACP_NOTES = 'Grok ACP persistent session (grok-build). Launch confirms only after an authoritative ACP acknowledgement. Same-session reply is supported while the local worker is alive. Process-local lane state only; no durable P19/P21 store, supervisor cutover, or live-transport qualification.';

function truncateForMessage(value) {
  const text = STRING(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function detachFrozenJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (capturedIsArray(value)) {
    const clone = [];
    for (let index = 0; index < value.length; index += 1) {
      ARRAY_PUSH.call(clone, detachFrozenJson(value[index]));
    }
    return OBJECT_FREEZE(clone);
  }
  const clone = {};
  const keys = sortedCapturedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    capturedDefineProperty(clone, key, {
      value: detachFrozenJson(optOwn(value, key)),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return OBJECT_FREEZE(clone);
}

function digestsEqual(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && capturedTest(CHILD_ENVELOPE_DIGEST_PATTERN, left)
    && capturedTest(CHILD_ENVELOPE_DIGEST_PATTERN, right)
    && TIMING_SAFE_EQUAL(BUFFER_FROM(left, 'hex'), BUFFER_FROM(right, 'hex'));
}

function laneKey(runId, assignmentId) {
  return `${runId}\u0000${assignmentId}`;
}

function storeFor(driver) {
  const store = DRIVER_STORES.get(driver);
  if (store === undefined) {
    fail('invalid_surface', 'grok_acp_driver',
      'inspectGrokAcpLaneEvidenceV1 requires a driver created by this adapter.');
  }
  return store;
}

function grokCapabilityRecord() {
  return {
    schema: PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
    artifact_kinds: capturedFreeze(['event_segment', 'git_diff', 'provider_report']),
    create_pr_posture: 'prohibited',
    dispatch_certainty: 'confirmed_launch',
    exact_model_selection: 'exact_and_attested',
    merge_authority: 'none_codex_only_integration',
    notes: GROK_ACP_NOTES,
    provider: GROK_PROVIDER_SLOT,
    replay_posture: 'never_replay',
    revision: GROK_ACP_CAPABILITY_REVISION,
    same_session_reply: 'live_session_reply',
    workspace_semantics: 'local_managed_worktree',
    workspace_starting_point: 'run_base_sha',
  };
}

export function grokAcpDriverDeclarationV1() {
  return validateDriverDeclarationV1({
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: grokCapabilityRecord(),
    features: {
      cancellation: 'supported',
      detailed_events: 'supported',
      live_progress: 'supported',
      restart: 'reconcile_reattach_only',
    },
  });
}

function assertPatternedId(value, pattern, path, label) {
  if (typeof value !== 'string' || !capturedTest(pattern, value)) {
    fail('invalid_format', path, `${path} must be a bounded ${label}.`);
  }
  return value;
}

function assertDigest(value, path) {
  if (typeof value !== 'string' || !capturedTest(CHILD_ENVELOPE_DIGEST_PATTERN, value)) {
    fail('invalid_format', path,
      `${path} must be a raw lowercase ${DIGEST_HEX_LENGTH}-hex sha256 digest.`);
  }
  return value;
}

function assertExactModel(value, path) {
  if (!isModelId(value)) {
    fail('invalid_exact_model_selection', path,
      `${path} must be the exact selected Grok model identifier.`);
  }
  return value;
}

function identityFromEnvelope(envelope, childEnvelopeDigest) {
  const provider = envelope.execution.provider;
  if (provider !== GROK_PROVIDER_SLOT) {
    fail('provider_slot_mismatch', 'envelope.execution.provider',
      `The Grok ACP adapter hard-binds provider "${GROK_PROVIDER_SLOT}"; received `
      + `"${truncateForMessage(provider)}".`);
  }
  const model = envelope.execution.model;
  if (typeof model !== 'string' || model.length === 0) {
    fail('invalid_exact_model_selection', 'envelope.execution.model',
      'The Grok ACP adapter requires the exact selected model; digest-or-profile-only launches are denied.');
  }
  assertExactModel(model, 'envelope.execution.model');
  if (envelope.starting_ref !== null) {
    fail('capability_workspace_mismatch', 'envelope.starting_ref',
      'Grok lanes start at the run immutable base_sha and never carry a starting_ref.');
  }
  return capturedFreeze({
    provider: GROK_PROVIDER_SLOT,
    model,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    base_sha: envelope.repository.base_sha,
    repository_path: envelope.repository.path,
    child_envelope_digest: childEnvelopeDigest,
    workspace_semantics: 'local_managed_worktree',
    workspace_starting_point: 'run_base_sha',
  });
}

function assertReceiptIdentity(receipt, identity, path) {
  const expected = capturedFreeze({
    provider: identity.provider,
    model: identity.model,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    lane_index: identity.lane_index,
    base_sha: identity.base_sha,
    child_envelope_digest: identity.child_envelope_digest,
  });
  for (const key of sortedCapturedKeys(expected)) {
    if (!hasOwn(receipt, key)) {
      fail('malformed_receipt', `${path}.${key}`, `${path}.${key} must echo the exact Grok lane identity.`);
    }
    const actual = optOwn(receipt, key);
    const value = expected[key];
    const equal = key === 'child_envelope_digest' ? digestsEqual(actual, value) : actual === value;
    if (!equal) {
      fail('stale_identity_denied', `${path}.${key}`,
        `${path}.${key} must echo ${truncateForMessage(value)}; received ${truncateForMessage(actual)}.`);
    }
  }
  if (hasOwn(receipt, 'repository_path') && optOwn(receipt, 'repository_path') !== identity.repository_path) {
    fail('stale_identity_denied', `${path}.repository_path`,
      'Transport workspace path does not match the exact managed worktree identity.');
  }
}

function assertClosedReceipt(receipt, allowedKeys, path) {
  if (receipt === undefined || receipt === null) {
    fail('malformed_receipt', path, `${path} must be a plain transport receipt.`);
  }
  assertDirectJsonClosure(receipt, path);
  assertPlainObject(receipt, 'malformed_receipt', path, path);
  assertAllowedKeys(receipt, allowedKeys, path);
}

function boundedDiagnosticMessage(code, fallback) {
  const text = typeof fallback === 'string' && fallback.length > 0 ? fallback : code;
  if (capturedUtf8ByteLength(text) <= DETAIL_MESSAGE_MAX_BYTES) return text;
  return `${text.slice(0, 64)}`;
}

function assertDetailPair(receipt, path) {
  const code = optOwn(receipt, 'detail_code');
  const message = optOwn(receipt, 'detail_message');
  if (typeof code !== 'string' || !capturedTest(DETAIL_CODE_PATTERN, code)) {
    fail('invalid_format', `${path}.detail_code`,
      `${path}.detail_code violates the bounded detail-code grammar.`);
  }
  assertBoundedText(message, {
    min: 1, max: DETAIL_MESSAGE_MAX_BYTES, path: `${path}.detail_message`, label: 'detail_message',
  });
  return capturedFreeze({ detail_code: code, detail_message: message });
}

function sanitizeEventNode(value, depth, budget, seen) {
  if (budget.remaining <= 0) return '[truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'string') {
    let text = value;
    if (capturedUtf8ByteLength(text) > MAX_GROK_ACP_EVENT_TEXT_BYTES) {
      text = `${text.slice(0, MAX_GROK_ACP_EVENT_TEXT_BYTES)}…`;
    }
    const size = capturedUtf8ByteLength(text);
    if (size > budget.remaining) {
      budget.remaining = 0;
      return '[truncated]';
    }
    budget.remaining -= size;
    return text;
  }
  if (typeof value !== 'object') return '[redacted]';
  assertNotProxy(value, 'grok_acp.event');
  if (seen.has(value) || depth >= MAX_GROK_ACP_EVENT_DEPTH) return '[truncated]';
  seen.add(value);
  if (capturedIsArray(value)) {
    assertDenseJsonArray(value, 'grok_acp.event');
    const out = [];
    const limit = Math.min(value.length, MAX_GROK_ACP_EVENT_ITEMS);
    for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
      ARRAY_PUSH.call(out, sanitizeEventNode(ownDataValue(value, STRING(index), `grok_acp.event[${index}]`),
        depth + 1, budget, seen));
    }
    if (value.length > limit) ARRAY_PUSH.call(out, '[truncated]');
    return OBJECT_FREEZE(out);
  }
  if (!isPlainObject(value)) return '[redacted]';
  const out = {};
  const keys = sortedCapturedKeys(value);
  const limit = Math.min(keys.length, MAX_GROK_ACP_EVENT_KEYS);
  for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
    const key = keys[index];
    const normalized = key.toLowerCase();
    if (capturedIncludes(OMIT_EVENT_KEYS, normalized)) continue;
    if (SENSITIVE_EVENT_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeEventNode(optOwn(value, key), depth + 1, budget, seen);
  }
  return OBJECT_FREEZE(out);
}

function boundEventPage(events, path) {
  if (events === undefined) return capturedFreeze([]);
  assertDenseJsonArray(events, path);
  const start = Math.max(0, events.length - MAX_GROK_ACP_EVENT_PAGE);
  const page = [];
  const budget = { remaining: MAX_GROK_ACP_EVENT_BYTES };
  for (let index = start; index < events.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const event = ownDataValue(events, STRING(index), entryPath);
    ARRAY_PUSH.call(page, sanitizeEventNode(event, 0, budget, new WeakSet()));
  }
  return capturedFreeze({
    events: OBJECT_FREEZE(page),
    truncated: events.length > MAX_GROK_ACP_EVENT_PAGE || budget.remaining <= 0,
    dropped_prefix: start,
  });
}

function boundAttention(attention, sessionId, path) {
  if (attention === undefined) return undefined;
  assertClosedReceipt(attention, ATTENTION_KEYS, path);
  const observedSession = assertPatternedId(
    optOwn(attention, 'session_id'), GROK_ACP_SESSION_ID_PATTERN, `${path}.session_id`, 'session_id',
  );
  if (observedSession !== sessionId) {
    fail('stale_identity_denied', `${path}.session_id`,
      'Attention session_id must match the live Grok ACP session; cross-session reply identity is denied.');
  }
  const questionId = assertPatternedId(
    optOwn(attention, 'question_id'), GROK_ACP_QUESTION_ID_PATTERN, `${path}.question_id`, 'question_id',
  );
  const projected = {
    session_id: observedSession,
    question_id: questionId,
  };
  if (hasOwn(attention, 'prompt')) {
    const prompt = optOwn(attention, 'prompt');
    if (typeof prompt !== 'string') {
      fail('invalid_type', `${path}.prompt`, `${path}.prompt must be a string when present.`);
    }
    projected.prompt = capturedUtf8ByteLength(prompt) > MAX_GROK_ACP_ATTENTION_PROMPT_BYTES
      ? `${prompt.slice(0, MAX_GROK_ACP_ATTENTION_PROMPT_BYTES)}…`
      : prompt;
  }
  return freezeData(projected);
}

function boundProgress(progress, path) {
  if (progress === undefined) return undefined;
  assertClosedReceipt(progress, PROGRESS_KEYS, path);
  const projected = {};
  if (hasOwn(progress, 'cursor')) {
    projected.cursor = assertPatternedId(
      optOwn(progress, 'cursor'), GROK_ACP_CURSOR_PATTERN, `${path}.cursor`, 'event cursor',
    );
  }
  if (hasOwn(progress, 'event_count')) {
    const count = optOwn(progress, 'event_count');
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_GROK_ACP_EVENT_COUNT) {
      fail('invalid_format', `${path}.event_count`,
        `${path}.event_count must be a bounded integer count.`);
    }
    projected.event_count = count;
  }
  if (hasOwn(progress, 'elapsed_ms')) {
    const elapsed = optOwn(progress, 'elapsed_ms');
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > MAX_GROK_ACP_TIMING_MS) {
      fail('invalid_format', `${path}.elapsed_ms`,
        `${path}.elapsed_ms must be a bounded millisecond timing.`);
    }
    projected.elapsed_ms = elapsed;
  }
  if (hasOwn(progress, 'status')) {
    const status = optOwn(progress, 'status');
    if (!capturedIncludes(GROK_ACP_OBSERVE_STATUSES, status)) {
      fail('invalid_format', `${path}.status`,
        `${path}.status must be one of ${capturedJoin(GROK_ACP_OBSERVE_STATUSES, ', ')}.`);
    }
    projected.status = status;
  }
  return freezeData(projected);
}

function projectEvidence(observe, include, identity, sessionId) {
  const wantEvents = capturedIncludes(include, 'detailed_events');
  const wantProgress = capturedIncludes(include, 'live_progress');
  const page = wantEvents ? boundEventPage(optOwn(observe, 'events'), 'transport.observe.events') : capturedFreeze({
    events: capturedFreeze([]), truncated: false, dropped_prefix: 0,
  });
  const progress = wantProgress || hasOwn(observe, 'progress') || hasOwn(observe, 'cursor')
    || hasOwn(observe, 'elapsed_ms') || hasOwn(observe, 'event_count')
    ? boundProgress({
      ...(hasOwn(observe, 'progress') ? optOwn(observe, 'progress') : {}),
      ...(hasOwn(observe, 'cursor') ? { cursor: optOwn(observe, 'cursor') } : {}),
      ...(hasOwn(observe, 'elapsed_ms') ? { elapsed_ms: optOwn(observe, 'elapsed_ms') } : {}),
      ...(hasOwn(observe, 'event_count') ? { event_count: optOwn(observe, 'event_count') } : {}),
      ...(hasOwn(observe, 'status') ? { status: optOwn(observe, 'status') } : {}),
    }, 'transport.observe.progress')
    : undefined;
  const attention = hasOwn(observe, 'attention')
    ? boundAttention(optOwn(observe, 'attention'), sessionId, 'transport.observe.attention')
    : undefined;
  const projected = {
    schema: GROK_ACP_EVIDENCE_SCHEMA_ID,
    provider: identity.provider,
    model: identity.model,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    lane_index: identity.lane_index,
    base_sha: identity.base_sha,
    child_envelope_digest: identity.child_envelope_digest,
    session_id: sessionId,
    status: optOwn(observe, 'status'),
    truncated: page.truncated === true,
  };
  if (wantEvents) projected.events = page.events;
  if (wantProgress && progress !== undefined) projected.progress = progress;
  if (attention !== undefined) projected.attention = attention;
  if (progress?.cursor !== undefined) projected.cursor = progress.cursor;
  else if (hasOwn(observe, 'cursor')) {
    projected.cursor = assertPatternedId(
      optOwn(observe, 'cursor'), GROK_ACP_CURSOR_PATTERN, 'transport.observe.cursor', 'event cursor',
    );
  }
  const bounded = boundedProviderValue(projected, {
    limit: MAX_GROK_ACP_EVENT_TEXT_BYTES,
    maxDepth: MAX_GROK_ACP_EVENT_DEPTH,
    maxItems: MAX_GROK_ACP_EVENT_ITEMS,
    maxBytes: MAX_GROK_ACP_EVIDENCE_BYTES,
  });
  return freezeData({
    ...bounded.value,
    evidence_truncated: bounded.result_truncated === true || page.truncated === true,
  });
}

function driverResult(operation, identity, disposition, details = {}) {
  const result = {
    schema: DRIVER_RESULT_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    lane_index: identity.lane_index,
    base_sha: identity.base_sha,
    child_envelope_digest: identity.child_envelope_digest,
    disposition,
  };
  if (details.detail_code !== undefined) result.detail_code = details.detail_code;
  if (details.detail_message !== undefined) result.detail_message = details.detail_message;
  return freezeData(result);
}

function isPostSpawnFailure(error) {
  if (error === null || typeof error !== 'object') return false;
  if (error.spawned === true) return true;
  return typeof error.code === 'string' && capturedIncludes(POST_SPAWN_ERROR_CODES, error.code);
}

function callTransport(store, operation, request) {
  const handler = capturedDescriptor(store.handlers, operation)?.value;
  if (typeof handler !== 'function' || IS_PROXY(handler)) {
    fail('invalid_operation', `grok_acp_transport.${operation}`,
      `grok_acp_transport.${operation} must be a concrete function.`);
  }
  return handler.call(store.transport, request);
}

function transportIdentityRequest(identity, extras = {}) {
  return detachFrozenJson({
    provider: identity.provider,
    model: identity.model,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    lane_index: identity.lane_index,
    base_sha: identity.base_sha,
    repository_path: identity.repository_path,
    child_envelope_digest: identity.child_envelope_digest,
    workspace_semantics: identity.workspace_semantics,
    workspace_starting_point: identity.workspace_starting_point,
    ...extras,
  });
}

function assertNoContentKeys(request, path) {
  if (hasOwn(request, 'envelope_text') || hasOwn(request, 'prompt') || hasOwn(request, 'text')) {
    fail('content_in_telemetry_denied', path,
      `${path} must not carry envelope or prompt content; that byte string is dispatch evidence only.`);
  }
}

function getLane(store, identity) {
  return store.lanes.get(laneKey(identity.run_id, identity.assignment_id));
}

function putLane(store, identity, record) {
  store.lanes.set(laneKey(identity.run_id, identity.assignment_id), capturedFreeze({
    ...record,
    identity,
  }));
}

function assertLaneIdentity(record, identity, path) {
  if (record === undefined) return;
  if (!digestsEqual(record.identity.child_envelope_digest, identity.child_envelope_digest)
    || record.identity.model !== identity.model
    || record.identity.base_sha !== identity.base_sha
    || record.identity.repository_path !== identity.repository_path
    || record.identity.provider !== identity.provider) {
    fail('stale_identity_denied', path,
      'Session/run/child/model/workspace identity does not match the exact Grok lane previously observed.');
  }
}

function dispatchRequestId(identity, sessionId) {
  const digest = identityBoundDigest(IDENTITY_LABELS.DISPATCH_ATTEMPT, {
    assignment_id: identity.assignment_id,
    child_envelope_digest: identity.child_envelope_digest,
    model: identity.model,
    provider: identity.provider,
    run_id: identity.run_id,
    session_id: sessionId,
  });
  if (!capturedTest(SHA256_DIGEST_PATTERN, digest)) {
    fail('invalid_format', 'dispatch.request_id', 'Dispatch request id binding must be a sha256 digest.');
  }
  return `gak-${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

export function assertGrokAcpTransportV1(transport) {
  const path = 'grok_acp_transport';
  if (transport !== null && (typeof transport === 'object' || typeof transport === 'function')
    && IS_PROXY(transport)) {
    fail('proxy_denied', path,
      `${path} is a live or revoked Proxy; the Grok adapter accepts a concrete injected transport only.`);
  }
  if (!isPlainObject(transport)) {
    if (typeof transport === 'object' && transport !== null && !capturedIsArray(transport)) {
      fail('exotic_prototype_denied', path,
        `${path} must use the standard or null object prototype; exotic prototypes are denied.`);
    }
    fail('invalid_type', path,
      `${path} must be a plain record of the closed Grok ACP transport operations.`);
  }
  const entries = assertJsonDataObject(transport, path);
  if (entries.length !== GROK_ACP_TRANSPORT_OPERATIONS.length
    || entries.some(({ key }) => !capturedIncludes(GROK_ACP_TRANSPORT_OPERATIONS, key))) {
    const received = entries.map(({ key }) => key).join(', ') || 'none';
    fail('invalid_surface', path,
      `${path} must expose exactly ${capturedJoin(GROK_ACP_TRANSPORT_OPERATIONS, ', ')}; received ${received}.`);
  }
  for (const { key, value } of entries) {
    if (typeof value !== 'function' || IS_PROXY(value)) {
      fail('invalid_operation', `${path}.${key}`,
        `${path}.${key} must be a concrete function implementing "${key}".`);
    }
  }
  return capturedFreeze({
    schema: GROK_ACP_TRANSPORT_SCHEMA_ID,
    operations: capturedFreeze([...GROK_ACP_TRANSPORT_OPERATIONS]),
    provider: GROK_PROVIDER_SLOT,
    agent: GROK_ACP_AGENT,
  });
}

function laneMayHaveSent(record) {
  return record !== undefined && (
    record.spawned === true
    || record.dispatch_intent === true
    || capturedIncludes(POSSIBLE_SEND_STATES, record.state)
  );
}

function hasTerminalLatch(record) {
  if (record === undefined) return false;
  if (record.terminal_latch === true) return true;
  if (capturedIncludes(TERMINAL_LATCH_STATES, record.state)) return true;
  if (record.last_status !== undefined
    && capturedIncludes(TERMINAL_OBSERVE_STATUSES, record.last_status)) {
    return true;
  }
  return record.cancel_outcome !== undefined
    && capturedIncludes(TERMINAL_CANCEL_OUTCOMES, record.cancel_outcome);
}

function runPreflight(store, request) {
  const view = validateDriverPreflightRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  if (laneMayHaveSent(prior)) {
    fail('invalid_transition', 'driver.preflight.request',
      'Preflight cannot run after a Grok prompt may have been dispatched; reconcile or cancel instead.');
  }
  const probe = transportIdentityRequest(identity);
  assertNoContentKeys(probe, 'grok_acp_transport.preflight.request');
  let receipt;
  try {
    receipt = callTransport(store, 'preflight', probe);
  } catch (error) {
    const blocked = driverResult('preflight', identity, 'blocked', {
      detail_code: 'transport_unavailable',
      detail_message: boundedDiagnosticMessage('transport_unavailable',
        'Grok ACP preflight failed before any session was spawned.'),
    });
    putLane(store, identity, { state: 'blocked', model: identity.model });
    void error;
    return blocked;
  }
  assertClosedReceipt(receipt, PREFLIGHT_RECEIPT_KEYS, 'transport.preflight.result');
  assertReceiptIdentity(receipt, identity, 'transport.preflight.result');
  const ok = optOwn(receipt, 'ok');
  if (ok === true) {
    if (hasOwn(receipt, 'detail_code') || hasOwn(receipt, 'detail_message')) {
      fail('detail_pair_denied', 'transport.preflight.result.detail_code',
        'A ready Grok preflight receipt must not carry a detail pair.');
    }
    putLane(store, identity, { state: 'ready', model: identity.model });
    return driverResult('preflight', identity, 'ready');
  }
  if (ok !== false) {
    fail('malformed_receipt', 'transport.preflight.result.ok',
      'transport.preflight.result.ok must be an exact boolean.');
  }
  assertDetailPair(receipt, 'transport.preflight.result');
  putLane(store, identity, { state: 'blocked', model: identity.model });
  return driverResult('preflight', identity, 'blocked', BLOCKED_PREFLIGHT_DETAIL);
}

function markUncertain(store, identity, extras = {}) {
  putLane(store, identity, {
    state: 'dispatch_uncertain',
    model: identity.model,
    session_id: extras.session_id,
    request_id: extras.request_id,
    spawned: true,
    dispatch_intent: true,
  });
  return driverResult('launch', identity, 'dispatch_uncertain');
}

function runLaunch(store, request) {
  const view = validateDriverLaunchRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  assertLaneIdentity(prior, identity, 'driver.launch.request');
  if (prior === undefined || (prior.state !== 'ready' && prior.state !== 'not_sent')) {
    if (prior !== undefined && prior.spawned === true) {
      fail('replay_denied', 'driver.launch.request',
        'A previous Grok launch may have sent the prompt; the lane is never replayed or fallback-substituted.');
    }
    fail('not_preflighted', 'driver.launch.request',
      'Launch requires a prior preflight:ready result for this exact Grok child identity.');
  }
  if (prior.state === 'blocked') {
    fail('blocked_lane_denied', 'driver.launch.request',
      'A blocked Grok preflight cannot launch; the lane fails closed with no fallback.');
  }

  let sessionId;
  let spawnReturned = false;
  try {
    const spawnRequest = transportIdentityRequest(identity);
    assertNoContentKeys(spawnRequest, 'grok_acp_transport.spawn.request');
    const spawned = callTransport(store, 'spawn', spawnRequest);
    spawnReturned = true;
    assertClosedReceipt(spawned, SPAWN_RECEIPT_KEYS, 'transport.spawn.result');
    if (optOwn(spawned, 'spawned') !== true) {
      fail('malformed_receipt', 'transport.spawn.result.spawned',
        'transport.spawn.result.spawned must be exactly true.');
    }
    assertReceiptIdentity(spawned, identity, 'transport.spawn.result');
    sessionId = assertPatternedId(
      optOwn(spawned, 'session_id'), GROK_ACP_SESSION_ID_PATTERN, 'transport.spawn.result.session_id', 'session_id',
    );
  } catch (error) {
    if (spawnReturned || isPostSpawnFailure(error)) {
      return markUncertain(store, identity);
    }
    putLane(store, identity, { state: 'not_sent', model: identity.model });
    return driverResult('launch', identity, 'not_sent', {
      detail_code: typeof error?.code === 'string' && capturedTest(DETAIL_CODE_PATTERN, error.code)
        ? error.code : 'spawn_failed',
      detail_message: boundedDiagnosticMessage('spawn_failed',
        'Grok ACP spawn failed before a session existed; no prompt was dispatched.'),
    });
  }

  putLane(store, identity, {
    state: 'spawned',
    model: identity.model,
    session_id: sessionId,
    spawned: true,
    dispatch_intent: true,
  });

  const requestId = dispatchRequestId(identity, sessionId);
  try {
    const dispatchRequest = detachFrozenJson({
      ...transportIdentityRequest(identity, { session_id: sessionId, request_id: requestId }),
      envelope_text: view.request.envelope_text,
    });
    const ack = callTransport(store, 'dispatch', dispatchRequest);
    assertClosedReceipt(ack, DISPATCH_RECEIPT_KEYS, 'transport.dispatch.result');
    if (optOwn(ack, 'acknowledged') !== true) {
      return markUncertain(store, identity, { session_id: sessionId, request_id: requestId });
    }
    assertReceiptIdentity(ack, identity, 'transport.dispatch.result');
    const ackSession = assertPatternedId(
      optOwn(ack, 'session_id'), GROK_ACP_SESSION_ID_PATTERN, 'transport.dispatch.result.session_id', 'session_id',
    );
    if (ackSession !== sessionId) {
      fail('stale_identity_denied', 'transport.dispatch.result.session_id',
        'Dispatch acknowledgement session_id must match the spawned Grok ACP session.');
    }
    const ackRequestId = assertPatternedId(
      optOwn(ack, 'request_id'), GROK_ACP_REQUEST_ID_PATTERN, 'transport.dispatch.result.request_id', 'request_id',
    );
    if (ackRequestId !== requestId) {
      fail('stale_identity_denied', 'transport.dispatch.result.request_id',
        'Dispatch acknowledgement request_id must match the exact dispatch attempt.');
    }
    putLane(store, identity, {
      state: 'dispatched',
      model: identity.model,
      session_id: sessionId,
      request_id: requestId,
      spawned: true,
      dispatch_intent: true,
      acknowledged: true,
    });
    return driverResult('launch', identity, 'dispatched');
  } catch (error) {
    void error;
    return markUncertain(store, identity, { session_id: sessionId, request_id: requestId });
  }
}

function observeLane(store, identity, record, include) {
  const extras = { include: [...include] };
  if (record.session_id !== undefined) extras.session_id = record.session_id;
  if (record.request_id !== undefined) extras.request_id = record.request_id;
  const observeRequest = transportIdentityRequest(identity, extras);
  assertNoContentKeys(observeRequest, 'grok_acp_transport.observe.request');
  const receipt = callTransport(store, 'observe', observeRequest);
  assertClosedReceipt(receipt, OBSERVE_RECEIPT_KEYS, 'transport.observe.result');
  assertReceiptIdentity(receipt, identity, 'transport.observe.result');
  const sessionId = assertPatternedId(
    optOwn(receipt, 'session_id'), GROK_ACP_SESSION_ID_PATTERN, 'transport.observe.result.session_id', 'session_id',
  );
  if (record.session_id !== undefined && sessionId !== record.session_id) {
    fail('stale_identity_denied', 'transport.observe.result.session_id',
      'Observed session_id does not match the spawned Grok ACP session.');
  }
  const status = optOwn(receipt, 'status');
  if (!capturedIncludes(GROK_ACP_OBSERVE_STATUSES, status)) {
    fail('invalid_format', 'transport.observe.result.status',
      `transport.observe.result.status must be one of ${capturedJoin(GROK_ACP_OBSERVE_STATUSES, ', ')}.`);
  }
  if (hasOwn(receipt, 'elapsed_ms')) {
    const elapsed = optOwn(receipt, 'elapsed_ms');
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > MAX_GROK_ACP_TIMING_MS) {
      fail('invalid_format', 'transport.observe.result.elapsed_ms',
        'elapsed_ms must be a bounded millisecond timing.');
    }
  }
  if (hasOwn(receipt, 'event_count')) {
    const count = optOwn(receipt, 'event_count');
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_GROK_ACP_EVENT_COUNT) {
      fail('invalid_format', 'transport.observe.result.event_count',
        'event_count must be a bounded integer count.');
    }
  }
  const evidence = projectEvidence(receipt, include, identity, sessionId);
  if (status === 'needs_attention' && evidence.attention === undefined) {
    fail('capability_reply_mismatch', 'transport.observe.result.attention',
      'Grok ACP needs_attention requires the exact live session_id and question_id; silent unanswerable attention is denied.');
  }
  return capturedFreeze({ receipt, sessionId, status, evidence });
}

function reconcileDisposition(status) {
  if (status === 'needs_attention') return 'unresolved_attention';
  if (status === 'lost') return 'dispatch_uncertain';
  if (capturedIncludes(TERMINAL_OBSERVE_STATUSES, status)) return 'terminal';
  return 'in_progress';
}

function runReconcile(store, request) {
  const view = validateDriverReconcileRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  if (prior === undefined || prior.spawned !== true) {
    fail('not_dispatched', 'driver.reconcile.request',
      'Reconcile addresses an existing Grok dispatch; this child has no launch observation.');
  }
  assertLaneIdentity(prior, identity, 'driver.reconcile.request');
  const include = view.include ?? capturedFreeze([]);
  const latched = hasTerminalLatch(prior);

  if (view.intent === 'restart_reattach' && !latched) {
    const reattachRequest = transportIdentityRequest(identity, {
      session_id: prior.session_id,
      request_id: prior.request_id,
    });
    assertNoContentKeys(reattachRequest, 'grok_acp_transport.reattach.request');
    const reattached = callTransport(store, 'reattach', reattachRequest);
    assertClosedReceipt(reattached, REATTACH_RECEIPT_KEYS, 'transport.reattach.result');
    if (optOwn(reattached, 'reattached') !== true) {
      fail('stale_identity_denied', 'transport.reattach.result.reattached',
        'restart_reattach recovered no live Grok ACP session; the lane fails closed and is never relaunched.');
    }
    assertReceiptIdentity(reattached, identity, 'transport.reattach.result');
    const sessionId = assertPatternedId(
      optOwn(reattached, 'session_id'), GROK_ACP_SESSION_ID_PATTERN, 'transport.reattach.result.session_id', 'session_id',
    );
    if (prior.session_id !== undefined && sessionId !== prior.session_id) {
      fail('stale_identity_denied', 'transport.reattach.result.session_id',
        'Reattached session_id does not match the spawned Grok ACP session.');
    }
    putLane(store, identity, { ...prior, session_id: sessionId, reattached: true });
  }

  if (latched) {
    putLane(store, identity, {
      ...prior,
      state: capturedIncludes(TERMINAL_LATCH_STATES, prior.state) ? prior.state : 'terminal',
      terminal_latch: true,
    });
    return driverResult('reconcile', identity, 'terminal');
  }

  const observed = observeLane(store, identity, getLane(store, identity), include);
  const disposition = prior.state === 'dispatch_uncertain' && observed.status === 'lost'
    ? 'dispatch_uncertain'
    : reconcileDisposition(observed.status);
  const nextState = disposition === 'unresolved_attention' ? 'unresolved_attention'
    : disposition === 'terminal' ? 'terminal'
      : disposition === 'dispatch_uncertain' ? 'dispatch_uncertain'
        : 'in_progress';
  putLane(store, identity, {
    ...getLane(store, identity),
    state: nextState,
    evidence: observed.evidence,
    last_status: observed.status,
    session_id: observed.sessionId,
    terminal_latch: nextState === 'terminal',
  });
  return driverResult('reconcile', identity, disposition);
}

function runCancel(store, request) {
  const view = validateDriverCancelRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  if (prior === undefined || prior.spawned !== true) {
    fail('not_dispatched', 'driver.cancel.request',
      'Cancel addresses an existing Grok dispatch; this child has no launch observation.');
  }
  assertLaneIdentity(prior, identity, 'driver.cancel.request');
  if (hasTerminalLatch(prior)) {
    putLane(store, identity, { ...prior, state: 'already_terminal', terminal_latch: true });
    return driverResult('cancel', identity, 'already_terminal');
  }
  const cancelRequest = transportIdentityRequest(identity, {
    session_id: prior.session_id,
    request_id: prior.request_id,
  });
  assertNoContentKeys(cancelRequest, 'grok_acp_transport.cancel.request');
  const receipt = callTransport(store, 'cancel', cancelRequest);
  assertClosedReceipt(receipt, CANCEL_RECEIPT_KEYS, 'transport.cancel.result');
  assertReceiptIdentity(receipt, identity, 'transport.cancel.result');
  if (prior.session_id !== undefined) {
    const sessionId = assertPatternedId(
      optOwn(receipt, 'session_id'), GROK_ACP_SESSION_ID_PATTERN, 'transport.cancel.result.session_id', 'session_id',
    );
    if (sessionId !== prior.session_id) {
      fail('stale_identity_denied', 'transport.cancel.result.session_id',
        'Cancel confirmation session_id must match the live Grok ACP session.');
    }
  }
  const outcome = optOwn(receipt, 'outcome');
  if (!capturedIncludes(GROK_ACP_CANCEL_OUTCOMES, outcome)) {
    fail('invalid_format', 'transport.cancel.result.outcome',
      `transport.cancel.result.outcome must be one of ${capturedJoin(GROK_ACP_CANCEL_OUTCOMES, ', ')}.`);
  }
  putLane(store, identity, {
    ...prior,
    state: outcome,
    cancel_outcome: outcome,
    terminal_latch: capturedIncludes(TERMINAL_CANCEL_OUTCOMES, outcome),
  });
  return driverResult('cancel', identity, outcome);
}

export function createGrokAcpDriverV1(transport) {
  assertGrokAcpTransportV1(transport);
  const handlers = capturedCreate(null);
  for (const operation of GROK_ACP_TRANSPORT_OPERATIONS) {
    const handler = capturedDescriptor(transport, operation)?.value;
    capturedDefineProperty(handlers, operation, {
      value: handler,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  OBJECT_FREEZE(handlers);
  const store = {
    transport,
    handlers,
    lanes: new MAP_CTOR(),
  };
  const driver = capturedCreate(null);
  capturedDefineProperty(driver, 'preflight', {
    value: (request) => runPreflight(store, request),
    enumerable: true, configurable: false, writable: false,
  });
  capturedDefineProperty(driver, 'launch', {
    value: (request) => runLaunch(store, request),
    enumerable: true, configurable: false, writable: false,
  });
  capturedDefineProperty(driver, 'reconcile', {
    value: (request) => runReconcile(store, request),
    enumerable: true, configurable: false, writable: false,
  });
  capturedDefineProperty(driver, 'cancel', {
    value: (request) => runCancel(store, request),
    enumerable: true, configurable: false, writable: false,
  });
  OBJECT_FREEZE(driver);
  DRIVER_STORES.set(driver, store);
  assertProviderDriverV1(driver);
  return driver;
}

export function bindGrokAcpDriverV1(transport) {
  const driver = createGrokAcpDriverV1(transport);
  const bound = bindProviderDriverV1(driver, grokAcpDriverDeclarationV1());
  DRIVER_STORES.set(bound, DRIVER_STORES.get(driver));
  return bound;
}

export function inspectGrokAcpLaneEvidenceV1(driver, query) {
  const path = 'grok_acp_evidence.query';
  if (query === undefined || query === null) {
    fail('invalid_type', path, `${path} must be a plain evidence query object.`);
  }
  assertDirectJsonClosure(query, path);
  assertPlainObject(query, 'invalid_type', path, path);
  assertAllowedKeys(query, EVIDENCE_QUERY_KEYS, path);
  for (const key of ['run_id', 'assignment_id', 'child_envelope_digest']) {
    if (!hasOwn(query, key)) fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
  }
  const digest = assertDigest(optOwn(query, 'child_envelope_digest'), `${path}.child_envelope_digest`);
  if (hasOwn(query, 'cursor')) {
    assertPatternedId(optOwn(query, 'cursor'), GROK_ACP_CURSOR_PATTERN, `${path}.cursor`, 'event cursor');
  }
  const store = storeFor(driver);
  const record = store.lanes.get(laneKey(optOwn(query, 'run_id'), optOwn(query, 'assignment_id')));
  if (record === undefined || !digestsEqual(record.identity.child_envelope_digest, digest)) {
    fail('stale_identity_denied', path,
      'No Grok ACP evidence is stored for this exact child identity.');
  }
  if (record.evidence === undefined) {
    return freezeData({
      schema: GROK_ACP_EVIDENCE_SCHEMA_ID,
      run_id: record.identity.run_id,
      assignment_id: record.identity.assignment_id,
      child_envelope_digest: record.identity.child_envelope_digest,
      session_id: record.session_id ?? null,
      events: capturedFreeze([]),
      evidence_truncated: false,
    });
  }
  return record.evidence;
}

export function describeGrokAcpAdapterSurfaceV1() {
  const declaration = grokAcpDriverDeclarationV1();
  return capturedFreeze({
    schema: GROK_ACP_DRIVER_SCHEMA_ID,
    provider: GROK_PROVIDER_SLOT,
    agent: GROK_ACP_AGENT,
    driver_operations: capturedFreeze([...DRIVER_OPERATIONS]),
    transport_schema: GROK_ACP_TRANSPORT_SCHEMA_ID,
    transport_operations: capturedFreeze([...GROK_ACP_TRANSPORT_OPERATIONS]),
    capability: declaration.capability,
    features: declaration.features,
    workspace_semantics: 'local_managed_worktree',
    workspace_starting_point: 'run_base_sha',
    merge_authority: 'none_codex_only_integration',
    create_pr_posture: 'prohibited',
    confirmation_rule: 'launch_dispatched_only_after_authoritative_acp_ack',
    post_spawn_loss_rule: 'exception_timeout_or_loss_returns_dispatch_uncertain_never_replayed',
    live_qualification: false,
    durable_store: false,
    supervisor_cutover: false,
    bounds: capturedFreeze({
      event_page: MAX_GROK_ACP_EVENT_PAGE,
      event_text_bytes: MAX_GROK_ACP_EVENT_TEXT_BYTES,
      event_bytes: MAX_GROK_ACP_EVENT_BYTES,
      event_depth: MAX_GROK_ACP_EVENT_DEPTH,
      event_items: MAX_GROK_ACP_EVENT_ITEMS,
      evidence_bytes: MAX_GROK_ACP_EVIDENCE_BYTES,
      attention_prompt_bytes: MAX_GROK_ACP_ATTENTION_PROMPT_BYTES,
      timing_ms: MAX_GROK_ACP_TIMING_MS,
      cursor_pattern: GROK_ACP_CURSOR_PATTERN.source,
    }),
    identities: capturedFreeze([
      'provider', 'model', 'run_id', 'assignment_id', 'lane_index', 'base_sha',
      'child_envelope_digest', 'session_id', 'request_id', 'repository_path',
      'workspace_semantics', 'workspace_starting_point',
    ]),
    later_real_grok_acp_route: capturedFreeze({
      preflight: 'probe grok-build ACP without spawning a prompt session',
      spawn: 'ensureSession({ agent: grok-build, mode: persistent, cwd: managed worktree at run_base_sha })',
      dispatch: 'startTurn with exact ChildEnvelopeV1 text; treat as dispatched only after ACP acknowledgement',
      observe: 'page turn.events / live progress with the closed caps; never copy envelope bytes into diagnostics',
      cancel: 'turn.cancel and wait for cancellation confirmation',
      reattach: 'ensureSession resume of the persisted ACP session identity with no new prompt',
      forbidden: capturedFreeze([
        'cli_fallback_after_spawn', 'digest_only_launch', 'direct_mode', 'merge_or_create_pr',
        'post_spawn_retry', 'provider_or_model_substitution',
      ]),
    }),
    feature_values: DRIVER_FEATURE_VALUES,
  });
}

capturedFreeze(assertGrokAcpTransportV1);
capturedFreeze(createGrokAcpDriverV1);
capturedFreeze(bindGrokAcpDriverV1);
capturedFreeze(inspectGrokAcpLaneEvidenceV1);
capturedFreeze(describeGrokAcpAdapterSurfaceV1);
capturedFreeze(grokAcpDriverDeclarationV1);
