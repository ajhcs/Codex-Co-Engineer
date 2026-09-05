// DshApxDriverV1 - the P20 DSH ACPX provider driver for Muse Spark 1.2
// Contributor and Ox Alpha.
//
// Additive v3 adapter over the accepted P17 ProviderDriverV1 contract. This
// module owns ONLY the DSH-specific wiring; every request/result shape,
// capability posture, transition rule, and denial code is inherited from the
// accepted contract (no parallel envelope or capability schema):
//   - hard binding: provider `dsh` plus exactly `meta/muse-spark-1.3-contributor`
//     or `stealth/ox-alpha`; every other provider/model pairing fails closed;
//   - the four lifecycle operations (preflight, launch, reconcile, cancel)
//     are driven through an INJECTED BOUNDED ACPX ONE-SHOT TRANSPORT PORT.
//     The port owns every real interaction; this module performs none;
//   - honest uncertainty: ACPX provides no authoritative prompt-sent
//     acknowledgement, so after spawn/dispatch intent the launch posture is
//     uncertain. Any post-intent exception or loss is reported as the
//     `dispatch_uncertain` disposition and is NEVER replayed, retried, or
//     fallback-substituted onto this or another transport. Only a transport
//     failure that is provably pre-spawn (a marked pre-spawn error, or any
//     failure before the spawn call was ever made) may report `not_sent`;
//   - same-session reply is unsupported (`unsupported_unresolved_attention`):
//     unresolved attention surfaces honestly through the reconcile
//     disposition; no replacement prompt/session is ever started;
//   - live progress, detailed events, cancellation confirmation, and restart
//     recovery are read from RECORDED ACPX EVIDENCE through bounded pages;
//   - exact model/credential/config identity plus task/session correlation
//     fail closed on drift; forged or malformed receipts fail closed while
//     transport loss degrades honestly to uncertainty;
//   - events, records, cursors, lanes, attempts, operations, timestamps, and
//     diagnostics are capped; detail messages are composed only from closed
//     vocabulary words and validated integers, so provider prompt, reply, or
//     event content can never leak into protected telemetry.
//
// Non-claims: this slice qualifies no real transport. The module claims no
// durable P19/P21 store, scheduler, registry cutover, or supervisor cutover,
// and holds no merge/PR authority.

import {
  createHash as nodeCreateHash,
  timingSafeEqual as cryptoTimingSafeEqual,
} from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  DRIVER_DECLARATION_SCHEMA_ID,
  DRIVER_OPERATIONS,
  DRIVER_RESULT_SCHEMA_IDS,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_DRIVER_VERSION,
  assertCapabilityRequirementV1,
  bindProviderDriverV1,
  validateDriverDeclarationV1,
} from './provider-driver.mjs';
import {
  capturedFreeze,
  capturedIncludes,
  capturedJoin,
  capturedTest,
} from './grammar.mjs';
import { DIGEST_HEX_LENGTH } from './identity.mjs';
import { parseChildEnvelopeV1 } from './prompt-compiler.mjs';
import {
  assertAllowedKeys,
  assertBoundedText,
  assertDenseJsonArray,
  assertJsonDataObject,
  isPlainObject,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  optOwn,
} from './selection-json.mjs';

const IS_PROXY = utilTypes.isProxy;
const MAP_CTOR = Map;
const OBJECT_FREEZE = Object.freeze;
const TIMING_SAFE_EQUAL = cryptoTimingSafeEqual;
const CREATE_HASH = nodeCreateHash;

// ---------------------------------------------------------------------------
// Closed surface constants
// ---------------------------------------------------------------------------

export const DSH_ACPX_DRIVER_SCHEMA_ID = 'codex-co-engineer.dsh-acpx-driver.v1';
export const DSH_ACPX_DRIVER_VERSION = 1;
export const DSH_PROVIDER = 'dsh';

export const DSH_ALLOWED_MODELS = capturedFreeze([
  'meta/muse-spark-1.3-contributor',
  'stealth/ox-alpha',
]);

// Informational identity data mirroring the shipped supervisor DSH routing.
// The injected port resolves real paths and credentials; this map never
// touches the filesystem and confers no authority by itself.
export const DSH_MODEL_IDENTITIES = capturedFreeze({
  'meta/muse-spark-1.3-contributor': capturedFreeze({
    config_file: 'dsh-acp.yml',
    credential_env: 'OPENROUTER_API_KEY',
    credential_file_env: 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
    credential_file: 'openrouter-api-key',
  }),
  'stealth/ox-alpha': capturedFreeze({
    config_file: 'dsh-acp-ox-alpha.yml',
    credential_env: 'OPENROUTER_API_KEY',
    credential_file_env: 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
    credential_file: 'openrouter-api-key',
  }),
});

// The one workspace posture this driver accepts: a local managed worktree
// anchored at the immutable run base SHA. Direct mode fails closed.
export const DSH_WORKSPACE_MODES = capturedFreeze(['managed']);

export const DSH_ACPX_TRANSPORT_KEYS = capturedFreeze([
  'cancel', 'configIdentity', 'events', 'poll', 'spawn',
]);

const DSH_DRIVER_OPTION_KEYS = capturedFreeze(['now', 'transport', 'workspace_mode']);

// Recorded-evidence vocabulary the injected port must project raw ACPX output
// into. `absent` means the port found no recorded evidence for the session.
export const DSH_EVIDENCE_STATES = capturedFreeze([
  'absent', 'accepted', 'running', 'needs_attention',
  'completed', 'failed', 'cancelled',
]);
export const DSH_TERMINAL_EVIDENCE_STATES = capturedFreeze([
  'completed', 'failed', 'cancelled',
]);
// Hostile non-terminal poll states after a terminal latch. Reconcile must
// never map these back to in_progress, dispatch_uncertain, or
// unresolved_attention once completed/failed/cancelled or
// cancel_confirmed/already_terminal has been observed on the lane.
// Later cancel after any of those latches is a local already_terminal
// result and must not probe the injected port. cancel_requested stays
// nonterminal so a later cancel may still be delivered.
const DSH_POST_TERMINAL_REGRESSION_STATES = capturedFreeze([
  'accepted', 'running', 'needs_attention', 'absent',
]);
const DSH_TERMINAL_CANCEL_OUTCOMES = capturedFreeze([
  'confirmed', 'already_terminal',
]);
export const DSH_STOP_REASONS = capturedFreeze(['end_turn', 'cancelled', 'timeout', 'error']);
export const DSH_EVENT_KINDS = capturedFreeze([
  'text_delta', 'thought_delta', 'tool_call', 'tool_call_update',
  'status', 'usage', 'attention',
]);
export const DSH_CANCEL_OUTCOMES = capturedFreeze([
  'confirmed', 'requested', 'already_terminal',
]);
export const DSH_IDENTITY_UNAVAILABLE_REASONS = capturedFreeze([
  'config_unavailable', 'credential_unavailable',
]);

// Every detail_code this driver can emit. Codes and messages are fixed
// vocabulary; transports never author either.
export const DSH_DETAIL_CODES = capturedFreeze([
  'already_terminal',
  'cancel_confirmed',
  'cancel_requested',
  'dsh_config_unavailable',
  'dsh_credential_unavailable',
  'dsh_transport_unavailable',
  'evidence_absent',
  'live_progress',
  'restart_evidence_absent',
  'terminal_evidence',
  'transport_prespawn_denied',
  'unresolved_attention',
]);

// Bounds. Counts, cursors, text, lanes, attempts, operations, and clock
// readings above these bounds fail closed.
export const DSH_MAX_LANES = 64;
export const DSH_MAX_LAUNCH_ATTEMPTS = 2;
export const DSH_MAX_LANE_OPERATIONS = 256;
export const DSH_MAX_RECORDED_EVENTS = 1024;
export const DSH_MAX_EVENT_PAGE_RECORDS = 64;
export const DSH_MAX_EVENT_RECORD_BYTES = 4096;
export const DSH_MAX_CURSOR = 1_000_000_000;
export const DSH_MAX_SESSION_REF_BYTES = 128;
export const DSH_MAX_CONFIG_PATH_BYTES = 1024;
export const DSH_MAX_TIME_MS = 4102444800000; // 2100-01-01T00:00:00Z

export const DSH_SESSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const DSH_QUESTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
export const DSH_DIGEST_HEX_PATTERN = new RegExp(`^[0-9a-f]{${DIGEST_HEX_LENGTH}}$`, 'u');
export const DSH_ABSOLUTE_PATH_PATTERN = /^\/[^\\%]*$/u;
export const DSH_TRANSPORT_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const DSH_IDENTITY_KEYS = capturedFreeze([
  'config_path', 'config_sha256', 'credential_sha256', 'credential_source', 'ready',
]);
const DSH_IDENTITY_UNAVAILABLE_KEYS = capturedFreeze(['ready', 'reason']);
const DSH_DISPATCH_PAYLOAD_KEYS = capturedFreeze([
  'assignment_id', 'attempted_at_ms', 'base_sha', 'child_envelope_digest',
  'envelope_text', 'lane_index', 'model', 'run_id',
]);
const DSH_POLL_REQUEST_KEYS = capturedFreeze(['correlation', 'session_ref']);
const DSH_CANCEL_REQUEST_KEYS = capturedFreeze(['correlation', 'session_ref']);
const DSH_EVENTS_REQUEST_KEYS = capturedFreeze([
  'correlation', 'cursor', 'max_records', 'session_ref',
]);
const DSH_CORRELATION_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'child_envelope_digest', 'lane_index', 'model', 'run_id',
]);
const DSH_SPAWN_RECEIPT_KEYS = capturedFreeze(['observed_at_ms', 'session_ref']);
const DSH_IDENTITY_RECEIPT_KEYS = capturedFreeze([
  ...DSH_IDENTITY_KEYS, ...DSH_IDENTITY_UNAVAILABLE_KEYS,
]);
const DSH_EVIDENCE_RECEIPT_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'child_envelope_digest', 'cursor', 'event_count',
  'lane_index', 'model', 'question_ref', 'run_id', 'session_ref', 'state',
  'stop_reason', 'updated_at_ms',
]);
const DSH_EVENT_PAGE_KEYS = capturedFreeze(['next_cursor', 'records', 'truncated']);
const DSH_EVENT_RECORD_KEYS = capturedFreeze(['bytes', 'kind', 'seq']);
const DSH_CANCEL_RECEIPT_KEYS = capturedFreeze([...DSH_CORRELATION_KEYS, 'outcome', 'session_ref']);
const IDENTITY_DRIFT_FIELDS = capturedFreeze([
  'config_path', 'config_sha256', 'credential_source', 'credential_sha256',
]);

function laneKey(envelope) {
  return `${envelope.run_id}\u0000${envelope.assignment_id}`;
}

// Hash-then-compare keeps the comparison constant time without leaking length.
function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(CREATE_HASH('sha256').update(left, 'utf8').digest(), 'hex');
  const rightBytes = Buffer.from(CREATE_HASH('sha256').update(right, 'utf8').digest(), 'hex');
  return TIMING_SAFE_EQUAL(leftBytes, rightBytes);
}

// ---------------------------------------------------------------------------
// Declaration: the honest DSH posture, hard-bound at construction
// ---------------------------------------------------------------------------

function buildDshAcpDeclarationV1() {
  const declaration = {
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: {
      schema: PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
      artifact_kinds: ['provider_report'],
      create_pr_posture: 'prohibited',
      dispatch_certainty: 'uncertain_after_spawn',
      exact_model_selection: 'exact_and_attested',
      merge_authority: 'none_codex_only_integration',
      notes: 'DSH ACPX one-shot flow for Muse Spark 1.3 Contributor or Ox Alpha. '
        + 'ACPX gives no authoritative prompt-sent acknowledgement, so launches stay '
        + 'uncertain after spawn and are never replayed. Same-session reply is '
        + 'unsupported; attention surfaces unresolved instead of starting a '
        + 'replacement prompt or session.',
      provider: DSH_PROVIDER,
      replay_posture: 'never_replay',
      revision: 'p20.dsh-acpx.1',
      same_session_reply: 'unsupported_unresolved_attention',
      workspace_semantics: 'local_managed_worktree',
      workspace_starting_point: 'run_base_sha',
    },
    features: {
      cancellation: 'supported',
      detailed_events: 'supported',
      live_progress: 'supported',
      restart: 'reconcile_reattach_only',
    },
  };
  const validated = validateDriverDeclarationV1(declaration);
  // Belt and braces: the declaration this module ships must keep asserting the
  // exact DSH truth even if the literal above is ever edited.
  assertCapabilityRequirementV1(validated, {
    create_pr_posture: 'prohibited',
    dispatch_certainty: 'uncertain_after_spawn',
    exact_model_selection: 'exact_and_attested',
    merge_authority: 'none_codex_only_integration',
    replay_posture: 'never_replay',
    same_session_reply: 'unsupported_unresolved_attention',
    workspace_semantics: 'local_managed_worktree',
    workspace_starting_point: 'run_base_sha',
  });
  return validated;
}

// ---------------------------------------------------------------------------
// Injected transport port validation
// ---------------------------------------------------------------------------

export function assertDshAcpTransportV1(transport) {
  const path = 'dsh_transport';
  assertNotProxy(transport, path);
  if (!isPlainObject(transport)) {
    if (typeof transport === 'object' && transport !== null && !Array.isArray(transport)) {
      fail('exotic_prototype_denied', path,
        `${path} must use the standard or null object prototype; exotic prototypes are denied.`);
    }
    fail('invalid_type', path,
      `${path} must be a plain record of exactly five concrete synchronous functions.`);
  }
  const entries = assertJsonDataObject(transport, path);
  const expected = new Set(DSH_ACPX_TRANSPORT_KEYS);
  if (entries.length !== DSH_ACPX_TRANSPORT_KEYS.length
    || entries.some(({ key }) => !expected.has(key))) {
    const received = entries.map(({ key }) => key).join(', ') || 'none';
    fail('invalid_surface', path,
      `${path} must expose exactly ${capturedJoin(DSH_ACPX_TRANSPORT_KEYS, ', ')}; received ${received}.`);
  }
  for (const { key, value } of entries) {
    if (typeof value !== 'function' || IS_PROXY(value)) {
      fail('invalid_operation', `${path}.${key}`,
        `${path}.${key} must be a concrete synchronous transport function.`);
    }
  }
  return capturedFreeze({
    keys: [...DSH_ACPX_TRANSPORT_KEYS],
    mode: 'injected_bounded_one_shot_port',
    schema: DSH_ACPX_DRIVER_SCHEMA_ID,
  });
}

// ---------------------------------------------------------------------------
// Receipt validation (recorded ACPX evidence projected by the port)
// ---------------------------------------------------------------------------

function assertReceiptObject(value, keys, label) {
  const path = `dsh_transport.${label}`;
  assertDirectJsonClosure(value, path);
  assertPlainObject(value, 'invalid_type', path, path);
  assertAllowedKeys(value, keys, path);
}

function assertHexDigest(value, path) {
  if (typeof value !== 'string' || !capturedTest(DSH_DIGEST_HEX_PATTERN, value)) {
    fail('invalid_format', path,
      `${path} must be a raw lowercase ${DIGEST_HEX_LENGTH}-hex sha256 digest.`);
  }
}

function assertBoundedInteger(value, min, max, path, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('invalid_format', path,
      `${path} must be an integer from ${min} to ${max}; ${label} outside its bound fails closed.`);
  }
}

function assertClosedValue(value, vocabulary, path, label) {
  if (!capturedIncludes(vocabulary, value)) {
    fail('invalid_format', path,
      `${path} must be exactly one of ${capturedJoin(vocabulary, ', ')}; ${label} is denied.`);
  }
}

export function validateDshConfigIdentityV1(value, model) {
  if (!capturedIncludes(DSH_ALLOWED_MODELS, model)) {
    fail('dsh_model_denied', 'dsh_transport.config_identity.model',
      `The DSH model must be exactly one of ${capturedJoin(DSH_ALLOWED_MODELS, ', ')}.`);
  }
  assertReceiptObject(value, DSH_IDENTITY_RECEIPT_KEYS, 'config_identity');
  const ready = optOwn(value, 'ready');
  if (ready !== true && ready !== false) {
    fail('invalid_format', 'dsh_transport.config_identity.ready',
      'dsh_transport.config_identity.ready must be a primitive boolean.');
  }
  if (ready === false) {
    if (hasOwn(value, 'reason')) {
      assertClosedValue(optOwn(value, 'reason'), DSH_IDENTITY_UNAVAILABLE_REASONS,
        'dsh_transport.config_identity.reason', 'identity-unavailability reason');
      return freezeData({ ready: false, reason: optOwn(value, 'reason') });
    }
    return freezeData({ ready: false, reason: null });
  }
  if (hasOwn(value, 'reason')) {
    fail('invalid_format', 'dsh_transport.config_identity.reason',
      'A ready DSH config identity carries no unavailability reason.');
  }
  for (const key of ['config_path', 'config_sha256', 'credential_source', 'credential_sha256']) {
    if (!hasOwn(value, key)) {
      fail('missing_key', `dsh_transport.config_identity.${key}`,
        `A ready DSH config identity must declare ${key}; partial identity is a guess.`);
    }
  }
  const configPath = optOwn(value, 'config_path');
  assertBoundedText(configPath, {
    min: 1, max: DSH_MAX_CONFIG_PATH_BYTES, allowBlank: true,
    path: 'dsh_transport.config_identity.config_path', label: 'config_path',
  });
  if (!capturedTest(DSH_ABSOLUTE_PATH_PATTERN, configPath)) {
    fail('invalid_format', 'dsh_transport.config_identity.config_path',
      'dsh_transport.config_identity.config_path must be an absolute POSIX-style path.');
  }
  assertHexDigest(optOwn(value, 'config_sha256'), 'dsh_transport.config_identity.config_sha256');
  const credentialSource = optOwn(value, 'credential_source');
  assertClosedValue(credentialSource, ['env', 'file'],
    'dsh_transport.config_identity.credential_source', 'credential source');
  assertHexDigest(optOwn(value, 'credential_sha256'), 'dsh_transport.config_identity.credential_sha256');
  return freezeData({
    config_path: configPath,
    config_sha256: optOwn(value, 'config_sha256'),
    credential_sha256: optOwn(value, 'credential_sha256'),
    credential_source: credentialSource,
    ready: true,
    reason: null,
  });
}

function assertIdentityUnchanged(current, prior, operation) {
  if (!current.ready) {
    fail('dsh_identity_unavailable', `driver.${operation}.request`,
      'The DSH config identity became unavailable after preflight; the lane fails closed.');
  }
  for (const key of IDENTITY_DRIFT_FIELDS) {
    if (!constantTimeEqual(current[key], prior[key])) {
      fail('dsh_identity_drift', `driver.${operation}.request.${key}`,
        `The exact ${key} drifted from the identity recorded at DSH preflight; `
        + 'model/config/credential drift fails the lane closed.');
    }
  }
}

function validateSpawnReceiptV1(value) {
  assertReceiptObject(value, DSH_SPAWN_RECEIPT_KEYS, 'spawn_receipt');
  const sessionRef = optOwn(value, 'session_ref');
  assertBoundedText(sessionRef, {
    min: 1, max: DSH_MAX_SESSION_REF_BYTES,
    path: 'dsh_transport.spawn_receipt.session_ref', label: 'session_ref',
  });
  if (!capturedTest(DSH_SESSION_REF_PATTERN, sessionRef)) {
    fail('invalid_format', 'dsh_transport.spawn_receipt.session_ref',
      `dsh_transport.spawn_receipt.session_ref violates ${DSH_SESSION_REF_PATTERN.source}.`);
  }
  if (hasOwn(value, 'observed_at_ms')) {
    assertBoundedInteger(optOwn(value, 'observed_at_ms'), 0, DSH_MAX_TIME_MS,
      'dsh_transport.spawn_receipt.observed_at_ms', 'observed_at_ms');
  }
  return freezeData({ session_ref: sessionRef });
}

function correlationFor(lane) {
  return freezeData({
    assignment_id: lane.assignment_id,
    base_sha: lane.base_sha,
    child_envelope_digest: lane.child_envelope_digest,
    lane_index: lane.lane_index,
    model: lane.model,
    run_id: lane.run_id,
  });
}

function assertReceiptCorrelation(receipt, lane, pathPrefix) {
  for (const key of DSH_CORRELATION_KEYS) {
    const actual = optOwn(receipt, key);
    const expected = lane[key];
    const equal = key === 'child_envelope_digest'
      ? constantTimeEqual(actual, expected)
      : actual === expected;
    if (!equal) {
      fail('dsh_correlation_mismatch', `${pathPrefix}.${key}`,
        `Recorded ACPX evidence carries a ${key} that does not match this lane's exact `
        + 'child identity; task/session correlation fails closed.');
    }
  }
  if (!constantTimeEqual(optOwn(receipt, 'session_ref'), lane.dispatch.session_ref)) {
    fail('dsh_correlation_mismatch', `${pathPrefix}.session_ref`,
      'Recorded ACPX evidence names a different session than this lane dispatched; '
      + 'correlation fails closed.');
  }
}

function validateEvidenceReceiptV1(value, lane) {
  assertReceiptObject(value, DSH_EVIDENCE_RECEIPT_KEYS, 'poll_receipt');
  assertReceiptCorrelation(value, lane, 'dsh_transport.poll_receipt');
  const state = optOwn(value, 'state');
  assertClosedValue(state, DSH_EVIDENCE_STATES, 'dsh_transport.poll_receipt.state', 'evidence state');
  const stopReasonPresent = hasOwn(value, 'stop_reason');
  if (stopReasonPresent) {
    if (!capturedIncludes(DSH_TERMINAL_EVIDENCE_STATES, state)) {
      fail('invalid_format', 'dsh_transport.poll_receipt.stop_reason',
        'stop_reason is only valid on terminal recorded evidence.');
    }
    assertClosedValue(optOwn(value, 'stop_reason'), DSH_STOP_REASONS,
      'dsh_transport.poll_receipt.stop_reason', 'stop_reason');
  }
  const questionPresent = hasOwn(value, 'question_ref');
  if (questionPresent) {
    if (state !== 'needs_attention') {
      fail('invalid_format', 'dsh_transport.poll_receipt.question_ref',
        'question_ref is only valid on needs_attention recorded evidence.');
    }
    const questionRef = optOwn(value, 'question_ref');
    if (typeof questionRef !== 'string' || !capturedTest(DSH_QUESTION_REF_PATTERN, questionRef)) {
      fail('invalid_format', 'dsh_transport.poll_receipt.question_ref',
        `dsh_transport.poll_receipt.question_ref violates ${DSH_QUESTION_REF_PATTERN.source}.`);
    }
  }
  assertBoundedInteger(optOwn(value, 'event_count'), 0, DSH_MAX_RECORDED_EVENTS,
    'dsh_transport.poll_receipt.event_count', 'event_count');
  assertBoundedInteger(optOwn(value, 'cursor'), 0, DSH_MAX_CURSOR,
    'dsh_transport.poll_receipt.cursor', 'cursor');
  assertBoundedInteger(optOwn(value, 'updated_at_ms'), 0, DSH_MAX_TIME_MS,
    'dsh_transport.poll_receipt.updated_at_ms', 'updated_at_ms');
  return freezeData({
    cursor: optOwn(value, 'cursor'),
    event_count: optOwn(value, 'event_count'),
    question_ref: questionPresent ? optOwn(value, 'question_ref') : null,
    state,
    stop_reason: stopReasonPresent ? optOwn(value, 'stop_reason') : null,
    updated_at_ms: optOwn(value, 'updated_at_ms'),
  });
}

function validateEventPageV1(value, request) {
  assertReceiptObject(value, DSH_EVENT_PAGE_KEYS, 'event_page');
  const records = optOwn(value, 'records');
  assertDenseJsonArray(records, 'dsh_transport.event_page.records');
  if (records.length > request.max_records) {
    fail('event_page_overbound', 'dsh_transport.event_page.records',
      `The event page returned ${records.length} records while the driver bounded the page `
      + `to ${request.max_records}.`);
  }
  let previousSeq = request.cursor;
  const normalized = [];
  for (let index = 0; index < records.length; index += 1) {
    const path = `dsh_transport.event_page.records[${index}]`;
    const record = records[index];
    assertDirectJsonClosure(record, path);
    assertPlainObject(record, 'invalid_type', path, path);
    assertAllowedKeys(record, DSH_EVENT_RECORD_KEYS, path);
    const seq = optOwn(record, 'seq');
    assertBoundedInteger(seq, 0, DSH_MAX_CURSOR, `${path}.seq`, 'seq');
    if (seq <= previousSeq) {
      fail('invalid_format', `${path}.seq`,
        'Event page sequence numbers must strictly increase past the requested cursor.');
    }
    const kind = optOwn(record, 'kind');
    assertClosedValue(kind, DSH_EVENT_KINDS, `${path}.kind`, 'event kind');
    assertBoundedInteger(optOwn(record, 'bytes'), 0, DSH_MAX_EVENT_RECORD_BYTES, `${path}.bytes`, 'bytes');
    previousSeq = seq;
    normalized.push(freezeData({ bytes: optOwn(record, 'bytes'), kind, seq }));
  }
  const nextCursor = optOwn(value, 'next_cursor');
  assertBoundedInteger(nextCursor, 0, DSH_MAX_CURSOR, 'dsh_transport.event_page.next_cursor', 'next_cursor');
  if (nextCursor < previousSeq) {
    fail('invalid_format', 'dsh_transport.event_page.next_cursor',
      'next_cursor must not move backwards past the last returned record.');
  }
  const truncated = optOwn(value, 'truncated');
  if (typeof truncated !== 'boolean') {
    fail('invalid_format', 'dsh_transport.event_page.truncated',
      'dsh_transport.event_page.truncated must be a primitive boolean.');
  }
  return freezeData({ next_cursor: nextCursor, records: normalized, truncated });
}

function validateCancelReceiptV1(value, lane) {
  assertReceiptObject(value, DSH_CANCEL_RECEIPT_KEYS, 'cancel_receipt');
  assertReceiptCorrelation(value, lane, 'dsh_transport.cancel_receipt');
  const outcome = optOwn(value, 'outcome');
  assertClosedValue(outcome, DSH_CANCEL_OUTCOMES, 'dsh_transport.cancel_receipt.outcome', 'cancel outcome');
  return freezeData({ outcome });
}

function isProvablyPreSpawn(error) {
  if (error === null || typeof error !== 'object') return false;
  try {
    if (IS_PROXY(error)) return false;
    const prototype = Object.getPrototypeOf(error);
    if (prototype !== Error.prototype && prototype !== Object.prototype) return false;
    const phase = Object.getOwnPropertyDescriptor(error, 'phase');
    if (!phase || phase.get !== undefined || phase.value !== 'prespawn') return false;
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    return Boolean(code && code.get === undefined
      && typeof code.value === 'string'
      && capturedTest(DSH_TRANSPORT_ERROR_CODE_PATTERN, code.value));
  } catch {
    return false;
  }
}

function isTypedContractError(error) {
  return error instanceof Error && error.name === 'RunContractV1Error';
}

// ---------------------------------------------------------------------------
// Driver construction
// ---------------------------------------------------------------------------

export function createDshApxDriverV1(options) {
  const optionsPath = 'dsh_driver_options';
  assertNotProxy(options, optionsPath);
  if (options === undefined || options === null || !isPlainObject(options)) {
    fail('invalid_type', optionsPath,
      `${optionsPath} must be a plain object carrying transport and workspace_mode.`);
  }
  assertAllowedKeys(options, DSH_DRIVER_OPTION_KEYS, optionsPath);
  for (const key of ['transport', 'workspace_mode']) {
    if (!hasOwn(options, key)) {
      fail('missing_key', `${optionsPath}.${key}`,
        `${optionsPath}.${key} is required; the driver inherits no hidden transport or workspace default.`);
    }
  }
  const transport = optOwn(options, 'transport');
  assertDshAcpTransportV1(transport);

  const workspaceMode = optOwn(options, 'workspace_mode');
  if (!capturedIncludes(DSH_WORKSPACE_MODES, workspaceMode)) {
    fail('direct_mode_rejected', `${optionsPath}.workspace_mode`,
      `${optionsPath}.workspace_mode must be exactly "managed"; direct mode and every other `
      + 'workspace semantics fail closed for DSH runs.');
  }

  let clock = Date.now.bind(Date);
  if (hasOwn(options, 'now')) {
    const provided = optOwn(options, 'now');
    if (typeof provided !== 'function' || IS_PROXY(provided)) {
      fail('invalid_type', `${optionsPath}.now`,
        `${optionsPath}.now must be a concrete clock function.`);
    }
    clock = provided;
  }

  const declaration = buildDshAcpDeclarationV1();
  const lanes = new MAP_CTOR();

  function nowMs(operation) {
    let value;
    try {
      value = clock();
    } catch {
      value = Number.NaN;
    }
    assertBoundedInteger(value, 0, DSH_MAX_TIME_MS,
      `driver.${operation}.request.clock`, 'clock reading');
    return value;
  }

  function callTransport(name, argument) {
    return transport[name].call(transport, argument);
  }

  function existingLane(envelope) {
    return lanes.get(laneKey(envelope));
  }

  function beginOperation(lane, operation, timestamp) {
    if (!Number.isInteger(lane.operation_count + 1)
      || lane.operation_count + 1 > DSH_MAX_LANE_OPERATIONS) {
      fail('operation_budget_exceeded', `driver.${operation}.request`,
        `At most ${DSH_MAX_LANE_OPERATIONS} driver operations are permitted per DSH lane; `
        + 'the budget fails closed.');
    }
    if (timestamp < lane.observed_at_ms) {
      fail('timing_regression_denied', `driver.${operation}.request.clock`,
        'Clock time moved backwards on a live DSH lane; timing regressions fail closed.');
    }
  }

  function advance(lane, patch, timestamp) {
    return freezeData({
      ...lane,
      ...patch,
      observed_at_ms: Math.max(lane.observed_at_ms, timestamp),
      operation_count: lane.operation_count + 1,
    });
  }

  function assertDshBinding(envelope, operation) {
    if (envelope.execution.provider !== DSH_PROVIDER) {
      fail('provider_slot_mismatch', `driver.${operation}.request.envelope_text`,
        `The DSH ACPX driver binds provider "${DSH_PROVIDER}" exactly; cross-provider `
        + 'substitution fails closed.');
    }
    const model = envelope.execution.model;
    if (!capturedIncludes(DSH_ALLOWED_MODELS, model)) {
      fail('dsh_model_denied', `driver.${operation}.request.envelope_text`,
        `The DSH ACPX driver binds exactly ${capturedJoin(DSH_ALLOWED_MODELS, ', ')}; `
        + 'every other model fails closed.');
    }
    return model;
  }

  function requireKnownLane(envelope, model, request, operation) {
    const prior = existingLane(envelope);
    if (prior === undefined) {
      fail('not_preflighted', `driver.${operation}.request`,
        'No DSH preflight identity exists for this exact child lane.');
    }
    if (!constantTimeEqual(prior.child_envelope_digest, request.child_envelope_digest)) {
      fail('stale_identity_denied', `driver.${operation}.request.child_envelope_digest`,
        'The request digest does not match the child recorded at DSH preflight.');
    }
    if (prior.model !== model) {
      fail('dsh_model_drift', `driver.${operation}.request.envelope_text`,
        'The envelope model differs from the exact model recorded at DSH preflight.');
    }
    return prior;
  }

  function currentIdentity(model, operation) {
    return validateDshConfigIdentityV1(
      callTransport('configIdentity', freezeData({ model })), model);
  }

  function baseResult(operation, request, envelope, disposition) {
    return {
      schema: DRIVER_RESULT_SCHEMA_IDS[operation],
      version: PROVIDER_DRIVER_VERSION,
      run_id: envelope.run_id,
      assignment_id: envelope.assignment_id,
      lane_index: envelope.lane_index,
      base_sha: envelope.repository.base_sha,
      child_envelope_digest: request.child_envelope_digest,
      disposition,
    };
  }

  // Content-free diagnostics: fragments combine closed-vocabulary words and
  // integers already validated against bounds. Nothing a provider or a hostile
  // transport authored can reach a detail message.
  function withDetail(result, code, fragments) {
    return { ...result, detail_code: code, detail_message: fragments.join(' ') };
  }

  function progressFragments(lane, extra = []) {
    return [
      `events=${lane.events_seen}`,
      `cursor=${lane.cursor}`,
      `truncated=${lane.events_truncated ? 'true' : 'false'}`,
      ...extra,
    ];
  }

  function requireDispatch(lane, operation) {
    if (lane.dispatch.state !== 'spawn_accepted' && lane.dispatch.state !== 'intent_only') {
      fail('not_dispatched', `driver.${operation}.request`,
        'This DSH lane holds no dispatch intent to reconcile or cancel.');
    }
  }

  function hasTerminalLatch(lane) {
    return lane.terminal_latch !== null && lane.terminal_latch !== undefined;
  }

  function evidenceLatch(evidence) {
    return freezeData({
      kind: 'evidence',
      state: evidence.state,
      stop_reason: evidence.stop_reason,
    });
  }

  function cancelLatch(outcome) {
    return freezeData({ kind: 'cancel', outcome });
  }

  function denyTerminalRegression(operation) {
    fail('terminal_regression_denied', `driver.${operation}.request`,
      'Recorded ACPX evidence moved backwards from a latched terminal disposition; '
      + 'terminal regressions fail closed.');
  }

  function latchedTerminalResult(operation, request, envelope, lane, includeCount) {
    const terminal = baseResult(operation, request, envelope, 'terminal');
    if (!includeCount) return terminal;
    const latch = lane.terminal_latch;
    const extra = latch.kind === 'evidence'
      ? [
        `state=${latch.state}`,
        ...(latch.stop_reason ? [`stop_reason=${latch.stop_reason}`] : []),
      ]
      : [`outcome=${latch.outcome}`];
    return withDetail(terminal, 'terminal_evidence', [...extra, ...progressFragments(lane)]);
  }

  function localAlreadyTerminalCancel(request, envelope, lane, timestamp) {
    lanes.set(laneKey(envelope), advance(lane, {}, timestamp));
    return withDetail(
      baseResult('cancel', request, envelope, 'already_terminal'),
      'already_terminal',
      ['outcome=already_terminal'],
    );
  }

  function readIdentityOrBlocked(request, envelope, model) {
    try {
      return { identity: currentIdentity(model, 'preflight'), error: null };
    } catch (error) {
      // Malformed or forged identity receipts fail closed with their typed
      // codes; only genuine probe loss degrades to an honest blocked result.
      if (isTypedContractError(error)) throw error;
      return {
        identity: null,
        error: withDetail(baseResult('preflight', request, envelope, 'blocked'),
          'dsh_transport_unavailable', ['transport=configIdentity', `model=${model}`]),
      };
    }
  }

  // --- preflight -------------------------------------------------------------

  function preflight(request) {
    const operation = 'preflight';
    const envelope = parseChildEnvelopeV1(request.envelope_text);
    const model = assertDshBinding(envelope, operation);
    const timestamp = nowMs(operation);
    const prior = existingLane(envelope);
    if (prior === undefined && lanes.size >= DSH_MAX_LANES) {
      fail('lane_budget_exceeded', `driver.${operation}.request`,
        `At most ${DSH_MAX_LANES} DSH lanes may exist per process; the lane budget fails closed.`);
    }
    const probed = readIdentityOrBlocked(request, envelope, model);
    if (probed.error) return probed.error;
    const identity = probed.identity;
    if (!identity.ready) {
      const code = identity.reason === 'credential_unavailable'
        ? 'dsh_credential_unavailable'
        : 'dsh_config_unavailable';
      return withDetail(baseResult(operation, request, envelope, 'blocked'),
        code, [`reason=${identity.reason ?? 'unknown'}`, `model=${model}`]);
    }
    beginOperation(prior ?? freezeData({ observed_at_ms: timestamp, operation_count: 0 }), operation, timestamp);
    lanes.set(laneKey(envelope), freezeData({
      assignment_id: envelope.assignment_id,
      base_sha: envelope.repository.base_sha,
      child_envelope_digest: request.child_envelope_digest,
      cursor: 0,
      dispatch: freezeData({ receipt_valid: false, session_ref: null, state: 'none' }),
      events_seen: 0,
      events_truncated: false,
      identity,
      launch_attempts: prior?.launch_attempts ?? 0,
      lane_index: envelope.lane_index,
      model,
      observed_at_ms: Math.max(prior?.observed_at_ms ?? timestamp, timestamp),
      operation_count: (prior?.operation_count ?? 0) + 1,
      run_id: envelope.run_id,
      terminal_latch: prior?.terminal_latch ?? null,
    }));
    return baseResult(operation, request, envelope, 'ready');
  }

  // --- launch ----------------------------------------------------------------

  function launch(request) {
    const operation = 'launch';
    const envelope = parseChildEnvelopeV1(request.envelope_text);
    const model = assertDshBinding(envelope, operation);
    const lane = requireKnownLane(envelope, model, request, operation);
    const timestamp = nowMs(operation);
    beginOperation(lane, operation, timestamp);

    // Exact model/config/credential identity must still hold immediately
    // before spawn. Drift throws before anything is sent, so failing closed
    // here can never leave a half-dispatched lane behind. Any other probe
    // failure is equally provably pre-spawn: the spawn call was never made.
    try {
      assertIdentityUnchanged(currentIdentity(model, operation), lane.identity, operation);
    } catch (error) {
      if (isTypedContractError(error)) throw error;
      lanes.set(laneKey(envelope), advance(lane, {
        dispatch: freezeData({ receipt_valid: false, session_ref: null, state: 'not_sent' }),
        launch_attempts: lane.launch_attempts + 1,
      }, timestamp));
      return withDetail(baseResult(operation, request, envelope, 'not_sent'),
        'transport_prespawn_denied', ['probe=configIdentity', `model=${model}`]);
    }

    if (lane.launch_attempts >= DSH_MAX_LAUNCH_ATTEMPTS) {
      fail('launch_budget_exceeded', `driver.${operation}.request`,
        `At most ${DSH_MAX_LAUNCH_ATTEMPTS} launch attempts are permitted per DSH lane; `
        + 'the budget fails closed.');
    }

    const payload = freezeData({
      assignment_id: envelope.assignment_id,
      attempted_at_ms: timestamp,
      base_sha: envelope.repository.base_sha,
      child_envelope_digest: request.child_envelope_digest,
      envelope_text: request.envelope_text,
      lane_index: envelope.lane_index,
      model,
      run_id: envelope.run_id,
    });
    assertAllowedKeys(payload, DSH_DISPATCH_PAYLOAD_KEYS, `driver.${operation}.payload`);

    // Spawn intent begins here. Everything after this point resolves to an
    // honest disposition and never throws, so the P17 lane state always lands
    // in a possibly-sent state and no duplicate launch can follow.
    try {
      const receipt = validateSpawnReceiptV1(callTransport('spawn', payload));
      lanes.set(laneKey(envelope), advance(lane, {
        dispatch: freezeData({ receipt_valid: true, session_ref: receipt.session_ref, state: 'spawn_accepted' }),
        launch_attempts: lane.launch_attempts + 1,
      }, timestamp));
      // No authoritative prompt-sent acknowledgement exists, so the posture
      // stays uncertain_after_spawn even when the port accepted the spawn.
      return baseResult(operation, request, envelope, 'dispatch_uncertain');
    } catch (error) {
      const provablyPrespawn = isProvablyPreSpawn(error);
      lanes.set(laneKey(envelope), advance(lane, {
        dispatch: freezeData({
          receipt_valid: false,
          session_ref: null,
          state: provablyPrespawn ? 'not_sent' : 'intent_only',
        }),
        launch_attempts: lane.launch_attempts + 1,
      }, timestamp));
      if (provablyPrespawn) {
        return withDetail(baseResult(operation, request, envelope, 'not_sent'),
          'transport_prespawn_denied', ['probe=spawn', `model=${model}`]);
      }
      // Exception or loss after spawn intent stays dispatch_uncertain forever:
      // never replayed, retried, or fallback-substituted.
      return baseResult(operation, request, envelope, 'dispatch_uncertain');
    }
  }

  // --- reconcile ---------------------------------------------------------------

  function applyEventPage(lane, includeCount, operation) {
    if (!includeCount) return lane;
    const remaining = DSH_MAX_RECORDED_EVENTS - lane.events_seen;
    if (remaining <= 0) return freezeData({ ...lane, events_truncated: true });
    const pageRequest = freezeData({
      correlation: correlationFor(lane),
      cursor: lane.cursor,
      max_records: Math.min(DSH_MAX_EVENT_PAGE_RECORDS, remaining),
      session_ref: lane.dispatch.session_ref,
    });
    let page;
    try {
      page = validateEventPageV1(callTransport('events', pageRequest), pageRequest);
    } catch (error) {
      if (isTypedContractError(error)) throw error;
      fail('dsh_events_unavailable', `driver.${operation}.request.include`,
        'The recorded ACPX event page could not be read; the reconcile fails closed instead of guessing.');
    }
    return freezeData({
      ...lane,
      cursor: Math.max(lane.cursor, page.next_cursor),
      events_seen: Math.min(DSH_MAX_RECORDED_EVENTS, lane.events_seen + page.records.length),
      events_truncated: lane.events_truncated || page.truncated,
    });
  }

  function reconcile(request) {
    const operation = 'reconcile';
    const envelope = parseChildEnvelopeV1(request.envelope_text);
    const model = assertDshBinding(envelope, operation);
    const lane = requireKnownLane(envelope, model, request, operation);
    const timestamp = nowMs(operation);
    beginOperation(lane, operation, timestamp);
    requireDispatch(lane, operation);
    const includeCount = Array.isArray(request.include) ? request.include.length : 0;

    function commit(updatedLane, patch) {
      const next = advance(updatedLane, patch, timestamp);
      lanes.set(laneKey(envelope), next);
      return next;
    }

    if (lane.dispatch.session_ref === null) {
      // An intent-only lane carries no session handle: nothing can be
      // observed or correlated, so honesty stays at uncertainty and no
      // doomed transport call is made. The child is never replayed to
      // recover a handle. A latched terminal disposition is retained
      // instead of degrading back to uncertainty.
      if (hasTerminalLatch(lane)) {
        return latchedTerminalResult(operation, request, envelope, commit(lane, {}), includeCount);
      }
      commit(lane, {});
      const uncertain = baseResult(operation, request, envelope, 'dispatch_uncertain');
      return includeCount
        ? withDetail(uncertain, 'evidence_absent', progressFragments(lane, ['evidence=unavailable']))
        : uncertain;
    }

    // Exact identity must hold on every observation too: credential or config
    // DRIFT fails the observation closed with a typed error below, while a
    // lost identity/evidence probe degrades honestly to uncertainty unless a
    // terminal latch already exists. After terminal evidence, uncertainty is
    // denied; the latched terminal disposition is retained instead.
    let evidence;
    try {
      const identity = currentIdentity(model, operation);
      assertIdentityUnchanged(identity, lane.identity, operation);
      evidence = validateEvidenceReceiptV1(callTransport('poll', freezeData({
        correlation: correlationFor(lane),
        session_ref: lane.dispatch.session_ref,
      })), lane);
    } catch (error) {
      if (isTypedContractError(error)) throw error;
      if (hasTerminalLatch(lane)) {
        return latchedTerminalResult(operation, request, envelope, commit(lane, {}), includeCount);
      }
      // Loss or exception during observation degrades honestly to uncertainty.
      // It never invents a terminal state and never replays the child.
      commit(lane, {});
      const uncertain = baseResult(operation, request, envelope, 'dispatch_uncertain');
      return includeCount
        ? withDetail(uncertain, 'evidence_absent', progressFragments(lane, ['evidence=unavailable']))
        : uncertain;
    }

    // Hostile running/accepted/absent/needs_attention after a terminal latch
    // fails closed with one typed regression. The lane is left untouched so
    // no second spawn, provider/model substitution, or attention answer can
    // follow from the denied observation.
    if (hasTerminalLatch(lane) && capturedIncludes(DSH_POST_TERMINAL_REGRESSION_STATES, evidence.state)) {
      denyTerminalRegression(operation);
    }

    const updated = applyEventPage(lane, includeCount, operation);
    const progress = progressFragments(updated);

    if (capturedIncludes(DSH_TERMINAL_EVIDENCE_STATES, evidence.state)) {
      const latch = hasTerminalLatch(lane) ? lane.terminal_latch : evidenceLatch(evidence);
      commit(updated, { terminal_latch: latch });
      const terminal = baseResult(operation, request, envelope, 'terminal');
      return includeCount
        ? withDetail(terminal, 'terminal_evidence', [
          `state=${evidence.state}`,
          ...(evidence.stop_reason ? [`stop_reason=${evidence.stop_reason}`] : []),
          ...progress,
        ])
        : terminal;
    }

    if (hasTerminalLatch(lane)) {
      return latchedTerminalResult(operation, request, envelope, commit(updated, {}), includeCount);
    }

    commit(updated, {});
    if (evidence.state === 'absent') {
      const code = request.intent === 'restart_reattach'
        ? 'restart_evidence_absent'
        : 'evidence_absent';
      const uncertain = baseResult(operation, request, envelope, 'dispatch_uncertain');
      return includeCount ? withDetail(uncertain, code, progress) : uncertain;
    }
    if (evidence.state === 'needs_attention') {
      // Same-session reply is unsupported: surface the attention honestly and
      // never answer it or start a replacement prompt or session.
      const attention = baseResult(operation, request, envelope, 'unresolved_attention');
      return includeCount
        ? withDetail(attention, 'unresolved_attention', [...progress, 'same_session_reply=unsupported'])
        : attention;
    }
    const running = baseResult(operation, request, envelope, 'in_progress');
    return includeCount ? withDetail(running, 'live_progress', progress) : running;
  }

  // --- cancel ---------------------------------------------------------------

  function cancel(request) {
    const operation = 'cancel';
    const envelope = parseChildEnvelopeV1(request.envelope_text);
    const model = assertDshBinding(envelope, operation);
    const lane = requireKnownLane(envelope, model, request, operation);
    const timestamp = nowMs(operation);
    beginOperation(lane, operation, timestamp);
    requireDispatch(lane, operation);
    // After completed/failed/cancelled evidence or a confirmed/
    // already_terminal cancel, every later cancel is a local
    // already_terminal result. The injected port is not probed again:
    // no configIdentity, cancel, poll, events, spawn, reply, or reattach.
    // cancel_requested is not a terminal latch, so a later cancel may
    // still be delivered as a control signal.
    if (hasTerminalLatch(lane)) {
      return localAlreadyTerminalCancel(request, envelope, lane, timestamp);
    }
    if (lane.dispatch.session_ref === null) {
      fail('dsh_cancel_unresolved', `driver.${operation}.request`,
        'This DSH lane holds only an unconfirmed spawn intent and no session handle; '
        + 'cancellation stays unresolved instead of claiming a delivery it cannot target.');
    }

    // A cancellation is a control signal, not a prompt: a lost or failing
    // cancellation request fails this operation closed with a typed error and
    // leaves the lane state untouched, so a later cancel or reconcile remains
    // possible without any replay of the child. Identity drift still denies
    // the operation through its typed drift code below.
    let receipt;
    try {
      const identity = currentIdentity(model, operation);
      assertIdentityUnchanged(identity, lane.identity, operation);
      receipt = validateCancelReceiptV1(callTransport('cancel', freezeData({
        correlation: correlationFor(lane),
        session_ref: lane.dispatch.session_ref,
      })), lane);
    } catch (error) {
      if (isTypedContractError(error)) throw error;
      fail('dsh_cancel_unresolved', `driver.${operation}.request`,
        'The DSH cancellation request could not be resolved; the lane stays untouched '
        + 'and cancellation may be requested again without any replay.');
    }
    const latchWorthy = capturedIncludes(DSH_TERMINAL_CANCEL_OUTCOMES, receipt.outcome);
    const terminalLatch = latchWorthy
      ? (hasTerminalLatch(lane) ? lane.terminal_latch : cancelLatch(receipt.outcome))
      : lane.terminal_latch ?? null;
    lanes.set(laneKey(envelope), advance(lane, { terminal_latch: terminalLatch }, timestamp));
    const disposition = receipt.outcome === 'confirmed'
      ? 'cancel_confirmed'
      : receipt.outcome === 'requested' ? 'cancel_requested' : 'already_terminal';
    return withDetail(baseResult(operation, request, envelope, disposition),
      disposition, [`outcome=${receipt.outcome}`]);
  }

  const operations = { cancel, launch, preflight, reconcile };
  const driver = bindProviderDriverV1(operations, declaration);

  return OBJECT_FREEZE({
    capability: declaration.capability,
    declaration,
    driver,
    features: declaration.features,
    models: DSH_ALLOWED_MODELS,
    provider: DSH_PROVIDER,
    schema: DSH_ACPX_DRIVER_SCHEMA_ID,
    version: DSH_ACPX_DRIVER_VERSION,
    workspace_mode: 'managed',
    workspace_semantics: 'local_managed_worktree',
    workspace_starting_point: 'run_base_sha',
  });
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export function describeDshApxDriverV1() {
  return capturedFreeze({
    bounds: capturedFreeze({
      event_page_records: DSH_MAX_EVENT_PAGE_RECORDS,
      event_record_bytes: DSH_MAX_EVENT_RECORD_BYTES,
      lanes: DSH_MAX_LANES,
      lane_operations: DSH_MAX_LANE_OPERATIONS,
      launch_attempts: DSH_MAX_LAUNCH_ATTEMPTS,
      max_cursor: DSH_MAX_CURSOR,
      max_time_ms: DSH_MAX_TIME_MS,
      recorded_events: DSH_MAX_RECORDED_EVENTS,
      session_ref_bytes: DSH_MAX_SESSION_REF_BYTES,
    }),
    cancel_outcomes: [...DSH_CANCEL_OUTCOMES],
    claims: capturedFreeze({
      durable_run_store: false,
      live_transport_qualification: false,
      merge_or_pr_authority: false,
      real_transport_configured: false,
      replay_or_fallback: false,
      same_session_reply: false,
      supervisor_cutover: false,
    }),
    detail_codes: [...DSH_DETAIL_CODES],
    event_kinds: [...DSH_EVENT_KINDS],
    evidence_states: [...DSH_EVIDENCE_STATES],
    operations: [...DRIVER_OPERATIONS],
    provider: DSH_PROVIDER,
    models: [...DSH_ALLOWED_MODELS],
    schema: DSH_ACPX_DRIVER_SCHEMA_ID,
    transport_keys: [...DSH_ACPX_TRANSPORT_KEYS],
    transport_mode: 'injected_bounded_one_shot_port',
    version: DSH_ACPX_DRIVER_VERSION,
  });
}

capturedFreeze(assertDshAcpTransportV1);
capturedFreeze(createDshApxDriverV1);
capturedFreeze(describeDshApxDriverV1);
capturedFreeze(validateDshConfigIdentityV1);
