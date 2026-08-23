// CursorCloudDriverV1 — the P21 Cursor Cloud SDK adapter over accepted
// ProviderDriverV1.
//
// Additive v3 module. It owns ONLY the Cursor Cloud-specific binding of the
// accepted P17 envelope/capability contract onto an injected bounded Cursor
// SDK transport. Existing mcp/v3/cursor-cloud-worker.mjs is not modified:
//   - provider slot is exactly `cursor-cloud`; every other provider fails
//     closed with provider_slot_mismatch;
//   - exact requested/effective model, provider repository identity,
//     immutable starting SHA, ChildEnvelope text/digest, run/assignment/lane,
//     stable request id, cloud agent id, provider run id, and branch identity
//     are required on transport receipts;
//   - preflight rejects dirty checkout, absent/credential-bearing/mutable
//     repository identity, non-commit starting refs, base advancement,
//     merge/create-PR/push authority, and ambiguous duplicate identities;
//   - launch reports dispatched only after an authoritative SDK run identity
//     (agent id + provider run id + request id). Any uncertainty after
//     create/send intent is dispatch_uncertain and is never replayed or
//     fallback-substituted;
//   - reconcile restart reattaches by the exact recorded agent/run/request
//     identity only; terminal verification requires provider-reported state
//     plus independently verifiable Git/branch/base evidence and claims
//     nothing the transport did not expose;
//   - cancel targets only the exact recorded run and reports cancel/archive
//     outcomes truthfully; terminal latches make later cancel already_terminal
//     with no further transport;
//   - same-session reply is unsupported_unresolved_attention, never a new run;
//   - result/event/error data is bounded and content-free; hostile JSON,
//     proxies, accessors, caps, secrets, and prompt text fail closed.
//   - post-transport receipt validation is quarantined locally: thrown
//     diagnostics keep only a closed local code and a fixed operation path,
//     message, and name. Provider-authored identity values, unknown keys,
//     detail pairs, raw errors, stacks, causes, and expected canonical
//     path/model/branch/run/request values never appear on public errors,
//     results, or evidence. Caller-request validation is not collapsed.
//
// Capability posture is honest: remote managed workspace starting at a pinned
// pushed SHA, exact-model selection only when attested, merge none, create PR
// prohibited, never_replay. This slice is not live-transport qualification.

import { Buffer as NodeBuffer } from 'node:buffer';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  DRIVER_DECLARATION_SCHEMA_ID,
  DRIVER_FEATURE_VALUES,
  DRIVER_OPERATIONS,
  DRIVER_RESULT_SCHEMA_IDS,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_DRIVER_VERSION,
  assertProviderDriverV1,
  bindProviderDriverV1,
  validateDriverCancelRequestV1,
  validateDriverDeclarationV1,
  validateDriverLaunchRequestV1,
  validateDriverPreflightRequestV1,
  validateDriverReconcileRequestV1,
} from './provider-driver.mjs';
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
import {
  SHA40_PATTERN,
  RunContractV1Error,
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
} from './selection-json.mjs';

export const CURSOR_CLOUD_PROVIDER_SLOT = 'cursor-cloud';
export const CURSOR_CLOUD_DRIVER_SCHEMA_ID = 'codex-co-engineer.cursor-cloud-driver.v1';
export const CURSOR_CLOUD_TRANSPORT_SCHEMA_ID = 'codex-co-engineer.cursor-cloud-transport.v1';
export const CURSOR_CLOUD_EVIDENCE_SCHEMA_ID = 'codex-co-engineer.cursor-cloud-evidence.v1';
export const CURSOR_CLOUD_CAPABILITY_REVISION = 'p21.cursor-cloud.1';
export const CURSOR_CLOUD_DRIVER_VERSION = 1;

export const CURSOR_CLOUD_TRANSPORT_OPERATIONS = capturedFreeze([
  'preflight', 'create', 'send', 'observe', 'cancel', 'reattach',
]);

export const CURSOR_CLOUD_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const CURSOR_CLOUD_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const CURSOR_CLOUD_REQUEST_ID_PATTERN = /^ccr-[0-9a-f]{32}$/u;
export const CURSOR_CLOUD_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
export const CURSOR_CLOUD_REPO_IDENTITY_PATTERN = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/u;
export const CURSOR_CLOUD_REPO_URL_PATTERN = /^https:\/\/[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/u;
export const CURSOR_CLOUD_CURSOR_PATTERN = /^[0-9]{1,16}$/u;

export const MAX_CURSOR_CLOUD_EVENT_PAGE = 32;
export const MAX_CURSOR_CLOUD_EVENT_BYTES = 32 * 1024;
export const MAX_CURSOR_CLOUD_EVENT_COUNT = 1_000_000;
export const MAX_CURSOR_CLOUD_TIMING_MS = 86_400_000;
export const MAX_CURSOR_CLOUD_CURSOR_BYTES = 16;
export const MAX_CURSOR_CLOUD_QUESTION_ID_BYTES = 80;

export const CURSOR_CLOUD_OBSERVE_STATUSES = capturedFreeze([
  'running', 'needs_attention', 'completed', 'failed', 'cancelled', 'lost',
]);
export const CURSOR_CLOUD_CANCEL_OUTCOMES = capturedFreeze([
  'cancel_requested', 'cancel_confirmed', 'already_terminal',
]);
export const CURSOR_CLOUD_EVENT_KINDS = capturedFreeze([
  'status', 'git', 'usage', 'attention', 'truncated',
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
const SET_HAS = SET_CTOR.prototype.has;
const STRING = String;
const TIMING_SAFE_EQUAL = cryptoTimingSafeEqual;
const WEAK_MAP_CTOR = WeakMap;

export const CURSOR_CLOUD_DETAIL_CODES = capturedFreeze([
  'already_terminal',
  'archive_failed',
  'archive_confirmed',
  'base_advanced',
  'cancel_confirmed',
  'cancel_requested',
  'duplicate_identity',
  'live_progress',
  'model_unattested',
  'origin_missing',
  'preflight_blocked',
  'restart_evidence_absent',
  'starting_ref_invisible',
  'starting_ref_invalid',
  'terminal_evidence',
  'transport_unavailable',
  'unresolved_attention',
  'workspace_dirty',
]);

const PREFLIGHT_RECEIPT_KEYS = capturedFreeze([
  'ok', 'provider', 'model', 'requested_model', 'effective_model',
  'run_id', 'assignment_id', 'lane_index', 'base_sha', 'child_envelope_digest',
  'starting_sha', 'repository_identity', 'repository_url', 'workspace_clean',
  'starting_ref_visible', 'starting_ref_commit', 'head_sha', 'duplicate_identities',
  'credential_bearing', 'auto_create_pr', 'detail_code', 'detail_message',
]);
const CREATE_RECEIPT_KEYS = capturedFreeze([
  'created', 'agent_id', 'provider', 'model', 'run_id', 'assignment_id',
  'lane_index', 'base_sha', 'child_envelope_digest', 'starting_sha',
  'repository_identity',
]);
const SEND_RECEIPT_KEYS = capturedFreeze([
  'acknowledged', 'agent_id', 'provider_run_id', 'request_id', 'branch',
  'provider', 'model', 'run_id', 'assignment_id', 'lane_index', 'base_sha',
  'child_envelope_digest', 'starting_sha', 'repository_identity',
]);
const OBSERVE_RECEIPT_KEYS = capturedFreeze([
  'agent_id', 'provider_run_id', 'request_id', 'branch', 'provider', 'model',
  'run_id', 'assignment_id', 'lane_index', 'base_sha', 'child_envelope_digest',
  'starting_sha', 'repository_identity', 'status', 'head_sha', 'merge_base_sha',
  'linear_history', 'events', 'progress', 'attention', 'cursor', 'elapsed_ms',
  'event_count',
]);
const CANCEL_RECEIPT_KEYS = capturedFreeze([
  'outcome', 'archived', 'agent_id', 'provider_run_id', 'request_id', 'branch', 'provider',
  'model', 'run_id', 'assignment_id', 'lane_index', 'base_sha',
  'child_envelope_digest', 'starting_sha', 'repository_identity',
]);
const REATTACH_RECEIPT_KEYS = capturedFreeze([
  'reattached', 'agent_id', 'provider_run_id', 'request_id', 'branch', 'provider',
  'model', 'run_id', 'assignment_id', 'lane_index', 'base_sha',
  'child_envelope_digest', 'starting_sha', 'repository_identity',
]);
const PROGRESS_KEYS = capturedFreeze(['cursor', 'event_count', 'elapsed_ms', 'status']);
const ATTENTION_KEYS = capturedFreeze(['question_id']);
const EVENT_RECORD_KEYS = capturedFreeze(['bytes', 'kind']);
const EVIDENCE_QUERY_KEYS = capturedFreeze([
  'run_id', 'assignment_id', 'child_envelope_digest',
]);
const IDENTITY_ECHO_KEYS = capturedFreeze([
  'provider', 'model', 'run_id', 'assignment_id', 'lane_index', 'base_sha',
  'child_envelope_digest',
]);
const CONTENT_FORBIDDEN_KEYS = capturedFreeze([
  'allow_merge', 'api_key', 'authorization', 'create_pr', 'credential',
  'envelope_text', 'fallback', 'password', 'prompt', 'push', 'resend',
  'retry_dispatch', 'secret', 'token',
]);
const POST_INTENT_ERROR_CODES = capturedFreeze([
  'send_ack_missing', 'transport_exception', 'transport_lost', 'transport_timeout',
]);
const TRANSPORT_COLLAPSE_CODES = capturedFreeze([
  'send_ack_missing', 'transport_exception', 'transport_lost', 'transport_timeout',
]);
const TRANSPORT_COLLAPSE_MESSAGES = capturedFreeze({
  send_ack_missing: 'cursor cloud send acknowledgement missing',
  transport_exception: 'cursor cloud transport failed',
  transport_lost: 'cursor cloud transport lost',
  transport_timeout: 'cursor cloud transport timed out',
});
const CLOSED_RECEIPT_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'content_key_denied',
  'credential_content_denied', 'dependency_not_allowed', 'detail_pair_denied',
  'direct_mode_rejected', 'duplicate_identity', 'executable_content_denied',
  'exotic_prototype_denied', 'invalid_exact_model_selection', 'invalid_format',
  'invalid_json_type', 'invalid_json_value', 'invalid_object', 'invalid_type',
  'malformed_receipt', 'merge_authority_denied', 'own_undefined_denied',
  'proxy_denied', 'replay_or_fallback_denied', 'repository_credentials',
  'stale_identity_denied', 'unknown_key', 'value_depth_exceeded',
]);
const CLOSED_RECEIPT_PATHS = capturedFreeze({
  preflight: 'cursor_cloud_transport.preflight',
  create: 'cursor_cloud_transport.create',
  send: 'cursor_cloud_transport.send',
  observe: 'cursor_cloud_transport.observe',
  cancel: 'cursor_cloud_transport.cancel',
  reattach: 'cursor_cloud_transport.reattach',
});
const CLOSED_RECEIPT_MESSAGES = capturedFreeze({
  preflight: 'Cursor Cloud preflight receipt failed closed validation; transport detail is omitted.',
  create: 'Cursor Cloud create receipt failed closed validation; transport detail is omitted.',
  send: 'Cursor Cloud send receipt failed closed validation; transport detail is omitted.',
  observe: 'Cursor Cloud observe receipt failed closed validation; transport detail is omitted.',
  cancel: 'Cursor Cloud cancel receipt failed closed validation; transport detail is omitted.',
  reattach: 'Cursor Cloud reattach receipt failed closed validation; transport detail is omitted.',
});
const CLOSED_RECEIPT_VALIDATION_MESSAGES = capturedFreeze({
  unknown_key: 'contains a key outside the closed Cursor Cloud receipt vocabulary.',
  replay_or_fallback_denied: 'must not enable replay or fallback.',
  credential_content_denied: 'must not carry credential material.',
  merge_authority_denied: 'must not enable merge or create-PR authority.',
  executable_content_denied: 'must not carry executable content.',
  dependency_not_allowed: 'must not carry dependency edges.',
  direct_mode_rejected: 'must not select direct workspace mode.',
  content_key_denied: 'must not carry forbidden content keys.',
  malformed_receipt: 'must be a plain closed Cursor Cloud receipt.',
  invalid_type: 'must be a plain closed Cursor Cloud receipt.',
  proxy_denied: 'must be concrete JSON data, not a Proxy.',
});
const CURSOR_CLOUD_PROGRESS_STATUSES = capturedFreeze([
  ...CURSOR_CLOUD_OBSERVE_STATUSES,
  'truncated',
]);
const TERMINAL_OBSERVE_STATUSES = capturedFreeze(['completed', 'failed', 'cancelled']);
const TERMINAL_CANCEL_OUTCOMES = capturedFreeze(['cancel_confirmed', 'already_terminal']);
const TERMINAL_LATCH_STATES = capturedFreeze([
  'terminal', 'cancel_confirmed', 'already_terminal',
]);
const POSSIBLE_SEND_STATES = capturedFreeze([
  'created', 'dispatch_uncertain', 'dispatched', 'in_progress', 'unresolved_attention',
  'terminal', 'cancel_requested', 'cancel_confirmed', 'already_terminal',
]);
const BLOCKED_PREFLIGHT_CODES = capturedFreeze([
  'base_advanced', 'model_unattested', 'origin_missing', 'preflight_blocked',
  'starting_ref_invisible', 'starting_ref_invalid', 'transport_unavailable',
  'workspace_dirty',
]);
const BLOCKED_PREFLIGHT_MESSAGES = capturedFreeze({
  base_advanced: 'pinned starting sha no longer matches workspace head',
  model_unattested: 'requested model is not attested by the cloud transport',
  origin_missing: 'provider repository identity is absent',
  preflight_blocked: 'cursor cloud preflight is blocked; the lane fails closed',
  starting_ref_invisible: 'starting sha is not provider-visible',
  starting_ref_invalid: 'starting ref is not an immutable commit sha',
  transport_unavailable: 'cursor cloud preflight failed before create intent',
  workspace_dirty: 'workspace checkout is dirty',
});

const DRIVER_STORES = new WEAK_MAP_CTOR();

const CURSOR_CLOUD_NOTES = 'Cursor Cloud SDK remote managed workspace. Launch confirms only after an authoritative agent/run/request identity. Same-session reply is unsupported. Create PR and merge are prohibited. Process-local lane state only; no supervisor cutover or live-transport qualification.';

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
    fail('invalid_surface', 'cursor_cloud_driver',
      'inspectCursorCloudLaneEvidenceV1 requires a driver created by this adapter.');
  }
  return store;
}

function cursorCloudCapabilityRecord() {
  return {
    schema: PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
    artifact_kinds: capturedFreeze([
      'cloud_receipt', 'git_diff', 'provider_report', 'ref_snapshot',
    ]),
    create_pr_posture: 'prohibited',
    dispatch_certainty: 'confirmed_launch',
    exact_model_selection: 'exact_and_attested',
    merge_authority: 'none_codex_only_integration',
    notes: CURSOR_CLOUD_NOTES,
    provider: CURSOR_CLOUD_PROVIDER_SLOT,
    replay_posture: 'never_replay',
    revision: CURSOR_CLOUD_CAPABILITY_REVISION,
    same_session_reply: 'unsupported_unresolved_attention',
    workspace_semantics: 'remote_provider_managed',
    workspace_starting_point: 'pinned_pushed_sha',
  };
}

export function cursorCloudDriverDeclarationV1() {
  return validateDriverDeclarationV1({
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: cursorCloudCapabilityRecord(),
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

function assertCommitSha(value, path) {
  if (typeof value !== 'string' || !capturedTest(SHA40_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a lowercase 40-hex commit sha.`);
  }
  return value;
}

function assertExactModel(value, path) {
  if (!isModelId(value)) {
    fail('invalid_exact_model_selection', path,
      `${path} must be the exact selected Cursor Cloud model identifier.`);
  }
  return value;
}

function assertRepositoryIdentity(value, path) {
  if (typeof value !== 'string' || !capturedTest(CURSOR_CLOUD_REPO_IDENTITY_PATTERN, value)
    || value.includes('@') || value.includes('://')) {
    fail('invalid_format', path,
      `${path} must be a credential-free immutable host/path repository identity.`);
  }
  return value;
}

function assertRepositoryUrl(value, path) {
  if (typeof value !== 'string' || !capturedTest(CURSOR_CLOUD_REPO_URL_PATTERN, value)
    || value.includes('@') || value.includes('?') || value.includes('#')) {
    fail('invalid_format', path,
      `${path} must be a credential-free https repository url.`);
  }
  return value;
}

function identityFromEnvelope(envelope, childEnvelopeDigest) {
  const provider = envelope.execution.provider;
  if (provider !== CURSOR_CLOUD_PROVIDER_SLOT) {
    fail('provider_slot_mismatch', 'envelope.execution.provider',
      `The Cursor Cloud adapter hard-binds provider "${CURSOR_CLOUD_PROVIDER_SLOT}"; received `
      + `"${truncateForMessage(provider)}".`);
  }
  const model = envelope.execution.model;
  if (typeof model !== 'string' || model.length === 0) {
    fail('invalid_exact_model_selection', 'envelope.execution.model',
      'The Cursor Cloud adapter requires the exact selected model; digest-or-profile-only launches are denied.');
  }
  assertExactModel(model, 'envelope.execution.model');
  const startingSha = envelope.starting_ref;
  if (typeof startingSha !== 'string' || !capturedTest(SHA40_PATTERN, startingSha)) {
    fail('capability_workspace_mismatch', 'envelope.starting_ref',
      'Cursor Cloud lanes pin one exact provider-visible starting SHA.');
  }
  if (startingSha !== envelope.repository.base_sha) {
    fail('capability_workspace_mismatch', 'envelope.starting_ref',
      'Cursor Cloud starting SHA must equal the immutable run base SHA; base advancement is denied.');
  }
  return capturedFreeze({
    provider: CURSOR_CLOUD_PROVIDER_SLOT,
    model,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    base_sha: envelope.repository.base_sha,
    repository_path: envelope.repository.path,
    child_envelope_digest: childEnvelopeDigest,
    starting_sha: startingSha,
    workspace_semantics: 'remote_provider_managed',
    workspace_starting_point: 'pinned_pushed_sha',
  });
}

function assertRequiredFalse(receipt, key, path, code, message) {
  if (!hasOwn(receipt, key) || optOwn(receipt, key) !== false) {
    fail(code, `${path}.${key}`, message);
  }
}

function assertCursorToken(value, path) {
  if (typeof value !== 'string') {
    fail('invalid_type', path, `${path} must be a cursor string.`);
  }
  if (capturedUtf8ByteLength(value) > MAX_CURSOR_CLOUD_CURSOR_BYTES) {
    fail('invalid_format', path, `${path} exceeds the cursor byte cap.`);
  }
  return assertPatternedId(value, CURSOR_CLOUD_CURSOR_PATTERN, path, 'event cursor');
}

function assertBoundedCount(value, path, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    fail('invalid_format', path, `${path} must be a bounded non-negative integer.`);
  }
  return value;
}

function assertBoundRepositoryAndSha(receipt, identity, boundRepository, path) {
  if (!hasOwn(receipt, 'starting_sha')) {
    fail('malformed_receipt', `${path}.starting_sha`,
      `${path}.starting_sha must echo the immutable pinned starting SHA.`);
  }
  const startingSha = assertCommitSha(optOwn(receipt, 'starting_sha'), `${path}.starting_sha`);
  if (startingSha !== identity.starting_sha) {
    fail('stale_identity_denied', `${path}.starting_sha`,
      'Transport starting SHA does not match the immutable pinned commit.');
  }
  if (!hasOwn(receipt, 'repository_identity')) {
    fail('malformed_receipt', `${path}.repository_identity`,
      `${path}.repository_identity must echo the bound provider repository identity.`);
  }
  const repositoryIdentity = assertRepositoryIdentity(
    optOwn(receipt, 'repository_identity'), `${path}.repository_identity`,
  );
  if (boundRepository !== undefined && repositoryIdentity !== boundRepository) {
    fail('stale_identity_denied', `${path}.repository_identity`,
      'Transport repository identity drifted from the bound provider repository.');
  }
  return repositoryIdentity;
}

function assertReceiptIdentity(receipt, identity, path, boundRepository) {
  for (const key of IDENTITY_ECHO_KEYS) {
    if (!hasOwn(receipt, key)) {
      fail('malformed_receipt', path,
        `${path} must echo the exact Cursor Cloud lane identity.`);
    }
    const actual = optOwn(receipt, key);
    const value = identity[key];
    const equal = key === 'child_envelope_digest' ? digestsEqual(actual, value) : actual === value;
    if (!equal) {
      fail('stale_identity_denied', path,
        `${path} identity does not match the bound Cursor Cloud lane.`);
    }
  }
  return assertBoundRepositoryAndSha(receipt, identity, boundRepository, path);
}

function collapsedTransportError(operation, error) {
  let code = 'transport_exception';
  try {
    if (error !== null && typeof error === 'object' && !IS_PROXY(error)
      && typeof error.code === 'string'
      && capturedIncludes(TRANSPORT_COLLAPSE_CODES, error.code)) {
      code = error.code;
    }
  } catch {
    code = 'transport_exception';
  }
  return new RunContractV1Error(
    code,
    `cursor_cloud_transport.${operation}`,
    optOwn(TRANSPORT_COLLAPSE_MESSAGES, code),
  );
}

function closedReceiptCode(error) {
  try {
    if (error instanceof RunContractV1Error && typeof error.code === 'string'
      && capturedIncludes(CLOSED_RECEIPT_ERROR_CODES, error.code)) {
      return error.code;
    }
  } catch {
    return 'malformed_receipt';
  }
  return 'malformed_receipt';
}

function closedReceiptError(operation, error) {
  return new RunContractV1Error(
    closedReceiptCode(error),
    optOwn(CLOSED_RECEIPT_PATHS, operation),
    optOwn(CLOSED_RECEIPT_MESSAGES, operation),
  );
}

function inspectProviderReceipt(operation, fn) {
  try {
    return fn();
  } catch (error) {
    throw closedReceiptError(operation, error);
  }
}

function closedReceiptValidationMessage(code, path) {
  const suffix = optOwn(CLOSED_RECEIPT_VALIDATION_MESSAGES, code)
    ?? 'failed closed Cursor Cloud receipt validation.';
  return `${path} ${suffix}`;
}

function invokeTransport(store, operation, request) {
  try {
    return callTransport(store, operation, request);
  } catch (error) {
    throw collapsedTransportError(operation, error);
  }
}

function guardLifecycle(operation, fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    throw collapsedTransportError(operation, error);
  }
}

function hasExactRecordedRunIdentity(record) {
  return record !== undefined
    && typeof record.agent_id === 'string'
    && typeof record.provider_run_id === 'string'
    && typeof record.request_id === 'string'
    && typeof record.branch === 'string';
}

function evidenceTruncatedFlag(events, progress, status, priorTruncated) {
  if (priorTruncated === true) return true;
  if (status === 'truncated') return true;
  if (progress !== undefined && progress.status === 'truncated') return true;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].kind === 'truncated') return true;
  }
  return false;
}

function assertClosedReceipt(receipt, allowedKeys, path) {
  if (receipt === undefined || receipt === null) {
    fail('malformed_receipt', path, `${path} must be a plain transport receipt.`);
  }
  assertDirectJsonClosure(receipt, path);
  assertPlainObject(receipt, 'malformed_receipt', path, path);
  try {
    assertAllowedKeys(receipt, allowedKeys, path);
  } catch (error) {
    const code = closedReceiptCode(error);
    fail(code, path, closedReceiptValidationMessage(code, path));
  }
}

function assertNoContentKeys(value, path) {
  const keys = sortedCapturedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (capturedIncludes(CONTENT_FORBIDDEN_KEYS, key)) {
      if (key === 'create_pr' || key === 'allow_merge' || key === 'push') {
        fail('merge_authority_denied', `${path}.${key}`,
          `${path}.${key} is prohibited; Cursor Cloud runs never create a PR, merge, or push.`);
      }
      if (key === 'fallback' || key === 'resend' || key === 'retry_dispatch') {
        fail('replay_or_fallback_denied', `${path}.${key}`,
          `${path}.${key} is forbidden; Cursor Cloud never replays or fallback-substitutes.`);
      }
      fail('content_key_denied', `${path}.${key}`,
        `${path}.${key} is forbidden on Cursor Cloud transport messages.`);
    }
  }
}

function boundedDiagnosticMessage(code, fallback) {
  const text = typeof fallback === 'string' && fallback.length > 0 ? fallback : code;
  if (capturedUtf8ByteLength(text) <= DETAIL_MESSAGE_MAX_BYTES) return text;
  return text.slice(0, 64);
}

function blockedPreflightDetail(code) {
  const mapped = capturedIncludes(BLOCKED_PREFLIGHT_CODES, code) ? code : 'preflight_blocked';
  return capturedFreeze({
    detail_code: mapped,
    detail_message: BLOCKED_PREFLIGHT_MESSAGES[mapped],
  });
}

function driverResult(operation, identity, disposition, extras = {}) {
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
  if (hasOwn(extras, 'detail_code')) result.detail_code = optOwn(extras, 'detail_code');
  if (hasOwn(extras, 'detail_message')) result.detail_message = optOwn(extras, 'detail_message');
  return freezeData(result);
}

function transportIdentityRequest(identity, extras = {}) {
  return detachFrozenJson({
    provider: identity.provider,
    model: identity.model,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    lane_index: identity.lane_index,
    base_sha: identity.base_sha,
    child_envelope_digest: identity.child_envelope_digest,
    starting_sha: identity.starting_sha,
    repository_path: identity.repository_path,
    ...extras,
  });
}

function bindRequestId(identity, agentId) {
  const digest = identityBoundDigest(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, {
    agent_id: agentId,
    assignment_id: identity.assignment_id,
    child_envelope_digest: identity.child_envelope_digest,
    model: identity.model,
    provider: identity.provider,
    run_id: identity.run_id,
    starting_sha: identity.starting_sha,
  });
  if (!capturedTest(SHA256_DIGEST_PATTERN, digest)) {
    fail('invalid_format', 'send.request_id', 'Cursor Cloud request id binding must be a sha256 digest.');
  }
  return `ccr-${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function proposedAgentId(identity) {
  const digest = identityBoundDigest(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, {
    assignment_id: identity.assignment_id,
    child_envelope_digest: identity.child_envelope_digest,
    provider: identity.provider,
    run_id: identity.run_id,
    starting_sha: identity.starting_sha,
  });
  return `bc-${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

export function assertCursorCloudTransportV1(transport) {
  const path = 'cursor_cloud_transport';
  if (transport !== null && (typeof transport === 'object' || typeof transport === 'function')
    && IS_PROXY(transport)) {
    fail('proxy_denied', path,
      `${path} is a live or revoked Proxy; the Cursor Cloud adapter accepts a concrete injected transport only.`);
  }
  if (!isPlainObject(transport)) {
    if (typeof transport === 'object' && transport !== null && !capturedIsArray(transport)) {
      fail('exotic_prototype_denied', path,
        `${path} must use the standard or null object prototype; exotic prototypes are denied.`);
    }
    fail('invalid_type', path,
      `${path} must be a plain record of the closed Cursor Cloud SDK transport operations.`);
  }
  const entries = assertJsonDataObject(transport, path);
  const expected = new SET_CTOR(CURSOR_CLOUD_TRANSPORT_OPERATIONS);
  if (entries.length !== CURSOR_CLOUD_TRANSPORT_OPERATIONS.length
    || entries.some(({ key }) => !SET_HAS.call(expected, key))) {
    const received = entries.map(({ key }) => key).join(', ') || 'none';
    fail('invalid_surface', path,
      `${path} must expose exactly ${capturedJoin(CURSOR_CLOUD_TRANSPORT_OPERATIONS, ', ')}; received ${received}.`);
  }
  for (const { key, value } of entries) {
    if (typeof value !== 'function' || IS_PROXY(value)) {
      fail('invalid_operation', `${path}.${key}`,
        `${path}.${key} must be a concrete synchronous transport function.`);
    }
  }
  return capturedFreeze({
    schema: CURSOR_CLOUD_TRANSPORT_SCHEMA_ID,
    operations: capturedFreeze([...CURSOR_CLOUD_TRANSPORT_OPERATIONS]),
    mode: 'injected_bounded_sdk_port',
  });
}

function callTransport(store, operation, request) {
  const handler = capturedDescriptor(store.handlers, operation)?.value;
  if (typeof handler !== 'function' || IS_PROXY(handler)) {
    fail('invalid_operation', `cursor_cloud_transport.${operation}`,
      `cursor_cloud_transport.${operation} must be a concrete function.`);
  }
  return handler.call(store.transport, request);
}

function getLane(store, identity) {
  return store.lanes.get(laneKey(identity.run_id, identity.assignment_id));
}

function putLane(store, identity, patch) {
  const prior = getLane(store, identity) ?? capturedCreate(null);
  const next = freezeData({
    ...prior,
    ...patch,
    identity,
  });
  store.lanes.set(laneKey(identity.run_id, identity.assignment_id), next);
  return next;
}

function assertLaneIdentity(prior, identity, path) {
  if (prior === undefined) return;
  if (!digestsEqual(prior.identity.child_envelope_digest, identity.child_envelope_digest)) {
    fail('stale_identity_denied', `${path}.child_envelope_digest`,
      'The request envelope digest does not match the exact Cursor Cloud child previously observed.');
  }
  if (prior.identity.model !== identity.model) {
    fail('stale_identity_denied', `${path}.model`,
      'The envelope model differs from the exact model recorded at Cursor Cloud preflight.');
  }
  if (prior.identity.starting_sha !== identity.starting_sha) {
    fail('stale_identity_denied', `${path}.starting_sha`,
      'The pinned starting SHA differs from the immutable SHA recorded at preflight.');
  }
}

function laneMayHaveSent(record) {
  return record !== undefined && (
    record.created === true
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

function isPostIntentFailure(error) {
  return error !== null && typeof error === 'object'
    && typeof error.code === 'string'
    && capturedIncludes(POST_INTENT_ERROR_CODES, error.code);
}

function markUncertain(store, identity, extras = {}) {
  putLane(store, identity, {
    state: 'dispatch_uncertain',
    model: identity.model,
    agent_id: extras.agent_id,
    provider_run_id: extras.provider_run_id,
    request_id: extras.request_id,
    branch: extras.branch,
    repository_identity: extras.repository_identity,
    created: true,
    dispatch_intent: true,
  });
  return driverResult('launch', identity, 'dispatch_uncertain');
}

function assertExactRunBinding(receipt, record, path) {
  const checks = capturedFreeze([
    ['agent_id', CURSOR_CLOUD_AGENT_ID_PATTERN, 'agent_id'],
    ['provider_run_id', CURSOR_CLOUD_RUN_ID_PATTERN, 'provider_run_id'],
    ['request_id', CURSOR_CLOUD_REQUEST_ID_PATTERN, 'request_id'],
    ['branch', CURSOR_CLOUD_BRANCH_PATTERN, 'branch'],
  ]);
  for (const [key, pattern, label] of checks) {
    if (record[key] === undefined) continue;
    if (!hasOwn(receipt, key)) {
      fail('stale_identity_denied', `${path}.${key}`,
        `${path}.${key} must echo the exact recorded Cursor Cloud ${label}.`);
    }
    const actual = assertPatternedId(optOwn(receipt, key), pattern, `${path}.${key}`, label);
    if (actual !== record[key]) {
      fail('stale_identity_denied', `${path}.${key}`,
        `Receipt ${key} must match the exact recorded Cursor Cloud ${label}.`);
    }
  }
}

function projectEvents(events, path) {
  if (events === undefined) return capturedFreeze([]);
  assertDenseJsonArray(events, path);
  if (events.length > MAX_CURSOR_CLOUD_EVENT_PAGE) {
    fail('invalid_format', path,
      `${path} must contain at most ${MAX_CURSOR_CLOUD_EVENT_PAGE} event records.`);
  }
  const projected = [];
  for (let index = 0; index < events.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = events[index];
    assertDirectJsonClosure(entry, entryPath);
    assertPlainObject(entry, 'malformed_receipt', entryPath, entryPath);
    assertAllowedKeys(entry, EVENT_RECORD_KEYS, entryPath);
    const kind = optOwn(entry, 'kind');
    if (!capturedIncludes(CURSOR_CLOUD_EVENT_KINDS, kind)) {
      fail('invalid_format', `${entryPath}.kind`,
        `${entryPath}.kind must be one of ${capturedJoin(CURSOR_CLOUD_EVENT_KINDS, ', ')}.`);
    }
    const bytes = optOwn(entry, 'bytes');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CURSOR_CLOUD_EVENT_BYTES) {
      fail('invalid_format', `${entryPath}.bytes`,
        `${entryPath}.bytes must be a bounded non-negative integer.`);
    }
    ARRAY_PUSH.call(projected, freezeData({ kind, bytes }));
  }
  return capturedFreeze(projected);
}

function projectProgress(progress, path) {
  if (progress === undefined) return undefined;
  assertDirectJsonClosure(progress, path);
  assertPlainObject(progress, 'malformed_receipt', path, path);
  assertAllowedKeys(progress, PROGRESS_KEYS, path);
  const projected = {};
  if (hasOwn(progress, 'cursor')) {
    projected.cursor = assertCursorToken(optOwn(progress, 'cursor'), `${path}.cursor`);
  }
  if (hasOwn(progress, 'event_count')) {
    projected.event_count = assertBoundedCount(
      optOwn(progress, 'event_count'), `${path}.event_count`, MAX_CURSOR_CLOUD_EVENT_COUNT,
    );
  }
  if (hasOwn(progress, 'elapsed_ms')) {
    projected.elapsed_ms = assertBoundedCount(
      optOwn(progress, 'elapsed_ms'), `${path}.elapsed_ms`, MAX_CURSOR_CLOUD_TIMING_MS,
    );
  }
  if (hasOwn(progress, 'status')) {
    const status = optOwn(progress, 'status');
    if (!capturedIncludes(CURSOR_CLOUD_PROGRESS_STATUSES, status)) {
      fail('invalid_format', `${path}.status`,
        `${path}.status must be a closed Cursor Cloud progress status.`);
    }
    projected.status = status;
  }
  return freezeData(projected);
}

function projectAttention(attention, path) {
  if (attention === undefined) return undefined;
  assertDirectJsonClosure(attention, path);
  assertPlainObject(attention, 'malformed_receipt', path, path);
  assertAllowedKeys(attention, ATTENTION_KEYS, path);
  const questionId = optOwn(attention, 'question_id');
  assertBoundedText(questionId, {
    min: 1, max: MAX_CURSOR_CLOUD_QUESTION_ID_BYTES, path: `${path}.question_id`, label: 'question_id',
  });
  return freezeData({ question_id: questionId });
}

function projectGitEvidence(receipt, identity, path) {
  const startingSha = assertCommitSha(optOwn(receipt, 'starting_sha'), `${path}.starting_sha`);
  if (startingSha !== identity.starting_sha) {
    fail('stale_identity_denied', `${path}.starting_sha`,
      'Git evidence starting SHA does not match the immutable pinned commit.');
  }
  const evidence = {
    starting_sha: startingSha,
    repository_identity: assertRepositoryIdentity(
      optOwn(receipt, 'repository_identity'), `${path}.repository_identity`,
    ),
  };
  if (hasOwn(receipt, 'head_sha')) {
    evidence.head_sha = assertCommitSha(optOwn(receipt, 'head_sha'), `${path}.head_sha`);
  }
  if (hasOwn(receipt, 'merge_base_sha')) {
    evidence.merge_base_sha = assertCommitSha(optOwn(receipt, 'merge_base_sha'), `${path}.merge_base_sha`);
  }
  if (hasOwn(receipt, 'branch')) {
    evidence.branch = assertPatternedId(
      optOwn(receipt, 'branch'), CURSOR_CLOUD_BRANCH_PATTERN, `${path}.branch`, 'branch',
    );
  }
  if (hasOwn(receipt, 'linear_history')) {
    const linear = optOwn(receipt, 'linear_history');
    if (linear !== true && linear !== false) {
      fail('malformed_receipt', `${path}.linear_history`,
        `${path}.linear_history must be an exact boolean when present.`);
    }
    evidence.linear_history = linear;
  }
  return freezeData(evidence);
}

function requireTerminalGitEvidence(git, identity, path) {
  if (git.head_sha === undefined || git.branch === undefined || git.merge_base_sha === undefined) {
    fail('malformed_receipt', path,
      'Terminal Cursor Cloud evidence requires independently verifiable head, merge-base, and branch identity.');
  }
  if (git.starting_sha !== identity.starting_sha) {
    fail('stale_identity_denied', `${path}.starting_sha`,
      'Terminal Git evidence starting SHA does not match the immutable pinned commit.');
  }
  if (git.merge_base_sha !== identity.starting_sha && git.merge_base_sha !== git.head_sha) {
    fail('stale_identity_denied', `${path}.merge_base_sha`,
      'Terminal merge-base must equal the pinned starting SHA or the observed head; the adapter claims no extra ancestry.');
  }
}

function runPreflight(store, request) {
  const view = validateDriverPreflightRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  if (laneMayHaveSent(prior)) {
    fail('invalid_transition', 'driver.preflight.request',
      'Preflight cannot run after a Cursor Cloud prompt may have been dispatched; reconcile or cancel instead.');
  }
  const probe = transportIdentityRequest(identity);
  assertNoContentKeys(probe, 'cursor_cloud_transport.preflight.request');
  let receipt;
  try {
    receipt = invokeTransport(store, 'preflight', probe);
  } catch (error) {
    void error;
    putLane(store, identity, { state: 'blocked', model: identity.model });
    return driverResult('preflight', identity, 'blocked', blockedPreflightDetail('transport_unavailable'));
  }
  return inspectProviderReceipt('preflight', () => {
  assertClosedReceipt(receipt, PREFLIGHT_RECEIPT_KEYS, 'transport.preflight.result');
  const repositoryIdentity = assertReceiptIdentity(receipt, identity, 'transport.preflight.result');
  assertRequiredFalse(
    receipt, 'credential_bearing', 'transport.preflight.result', 'repository_credentials',
    'transport.preflight.result.credential_bearing must be exactly false.',
  );
  assertRequiredFalse(
    receipt, 'duplicate_identities', 'transport.preflight.result', 'duplicate_identity',
    'transport.preflight.result.duplicate_identities must be exactly false.',
  );
  assertRequiredFalse(
    receipt, 'auto_create_pr', 'transport.preflight.result', 'merge_authority_denied',
    'transport.preflight.result.auto_create_pr must be exactly false.',
  );
  const ok = optOwn(receipt, 'ok');
  if (ok === true) {
    if (hasOwn(receipt, 'detail_code') || hasOwn(receipt, 'detail_message')) {
      fail('detail_pair_denied', 'transport.preflight.result.detail_code',
        'A ready Cursor Cloud preflight receipt must not carry a detail pair.');
    }
    const requested = assertExactModel(
      optOwn(receipt, 'requested_model'), 'transport.preflight.result.requested_model',
    );
    const effective = assertExactModel(
      optOwn(receipt, 'effective_model'), 'transport.preflight.result.effective_model',
    );
    if (requested !== identity.model || effective !== identity.model) {
      putLane(store, identity, { state: 'blocked', model: identity.model });
      return driverResult('preflight', identity, 'blocked', blockedPreflightDetail('model_unattested'));
    }
    assertCommitSha(optOwn(receipt, 'starting_sha'), 'transport.preflight.result.starting_sha');
    assertCommitSha(optOwn(receipt, 'head_sha'), 'transport.preflight.result.head_sha');
    if (optOwn(receipt, 'head_sha') !== identity.starting_sha
      || optOwn(receipt, 'starting_sha') !== identity.starting_sha) {
      putLane(store, identity, { state: 'blocked', model: identity.model });
      return driverResult('preflight', identity, 'blocked', blockedPreflightDetail('base_advanced'));
    }
    if (optOwn(receipt, 'workspace_clean') !== true) {
      putLane(store, identity, { state: 'blocked', model: identity.model });
      return driverResult('preflight', identity, 'blocked', blockedPreflightDetail('workspace_dirty'));
    }
    if (optOwn(receipt, 'starting_ref_commit') !== true) {
      putLane(store, identity, { state: 'blocked', model: identity.model });
      return driverResult('preflight', identity, 'blocked', blockedPreflightDetail('starting_ref_invalid'));
    }
    if (optOwn(receipt, 'starting_ref_visible') !== true) {
      putLane(store, identity, { state: 'blocked', model: identity.model });
      return driverResult('preflight', identity, 'blocked', blockedPreflightDetail('starting_ref_invisible'));
    }
    assertRepositoryUrl(optOwn(receipt, 'repository_url'), 'transport.preflight.result.repository_url');
    putLane(store, identity, {
      state: 'ready',
      model: identity.model,
      repository_identity: repositoryIdentity,
      repository_url: optOwn(receipt, 'repository_url'),
      requested_model: requested,
      effective_model: effective,
    });
    return driverResult('preflight', identity, 'ready');
  }
  if (ok !== false) {
    fail('malformed_receipt', 'transport.preflight.result.ok',
      'transport.preflight.result.ok must be an exact boolean.');
  }
  const blockedCode = hasOwn(receipt, 'detail_code') ? optOwn(receipt, 'detail_code') : 'preflight_blocked';
  if (typeof blockedCode !== 'string' || !capturedTest(DETAIL_CODE_PATTERN, blockedCode)) {
    fail('invalid_format', 'transport.preflight.result.detail_code',
      'transport.preflight.result.detail_code violates the bounded detail-code grammar.');
  }
  putLane(store, identity, { state: 'blocked', model: identity.model });
  return driverResult('preflight', identity, 'blocked', blockedPreflightDetail(blockedCode));
  });
}

function runLaunch(store, request) {
  const view = validateDriverLaunchRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  assertLaneIdentity(prior, identity, 'driver.launch.request');
  if (prior === undefined || (prior.state !== 'ready' && prior.state !== 'not_sent')) {
    if (prior !== undefined && prior.created === true) {
      fail('replay_denied', 'driver.launch.request',
        'A previous Cursor Cloud launch may have sent the prompt; the lane is never replayed or fallback-substituted.');
    }
    fail('not_preflighted', 'driver.launch.request',
      'Launch requires a prior preflight:ready result for this exact Cursor Cloud child identity.');
  }
  if (prior.state === 'blocked') {
    fail('blocked_lane_denied', 'driver.launch.request',
      'A blocked Cursor Cloud preflight cannot launch; the lane fails closed with no fallback.');
  }

  const proposed = proposedAgentId(identity);
  let createInvoked = false;
  let agentId;
  let repositoryIdentity = prior.repository_identity;
  try {
    const createRequest = transportIdentityRequest(identity, {
      proposed_agent_id: proposed,
      repository_url: prior.repository_url,
      repository_identity: prior.repository_identity,
      auto_create_pr: false,
    });
    assertNoContentKeys(createRequest, 'cursor_cloud_transport.create.request');
    if (optOwn(createRequest, 'auto_create_pr') !== false) {
      fail('merge_authority_denied', 'cursor_cloud_transport.create.request.auto_create_pr',
        'Cursor Cloud create must send auto_create_pr false; automatic PR creation is prohibited.');
    }
    createInvoked = true;
    const created = invokeTransport(store, 'create', createRequest);
    const createdView = inspectProviderReceipt('create', () => {
      assertClosedReceipt(created, CREATE_RECEIPT_KEYS, 'transport.create.result');
      if (optOwn(created, 'created') !== true) {
        fail('malformed_receipt', 'transport.create.result.created',
          'transport.create.result.created must be exactly true.');
      }
      return {
        repositoryIdentity: assertReceiptIdentity(
          created, identity, 'transport.create.result', prior.repository_identity,
        ),
        agentId: assertPatternedId(
          optOwn(created, 'agent_id'), CURSOR_CLOUD_AGENT_ID_PATTERN,
          'transport.create.result.agent_id', 'agent_id',
        ),
      };
    });
    repositoryIdentity = createdView.repositoryIdentity;
    agentId = createdView.agentId;
  } catch (error) {
    if (error instanceof RunContractV1Error && createInvoked !== true && !isPostIntentFailure(error)) {
      throw error;
    }
    if (createInvoked || isPostIntentFailure(error)) {
      return markUncertain(store, identity, { repository_identity: repositoryIdentity });
    }
    putLane(store, identity, { state: 'not_sent', model: identity.model });
    return driverResult('launch', identity, 'not_sent', {
      detail_code: 'transport_unavailable',
      detail_message: boundedDiagnosticMessage('transport_unavailable',
        'Cursor Cloud create failed before intent; no prompt was dispatched.'),
    });
  }

  putLane(store, identity, {
    state: 'created',
    model: identity.model,
    agent_id: agentId,
    repository_identity: repositoryIdentity,
    created: true,
    dispatch_intent: true,
  });

  const requestId = bindRequestId(identity, agentId);
  try {
    const sendRequest = detachFrozenJson({
      ...transportIdentityRequest(identity, {
        agent_id: agentId,
        request_id: requestId,
        repository_identity: repositoryIdentity,
        auto_create_pr: false,
      }),
      envelope_text: view.request.envelope_text,
    });
    const ack = invokeTransport(store, 'send', sendRequest);
    return inspectProviderReceipt('send', () => {
      assertClosedReceipt(ack, SEND_RECEIPT_KEYS, 'transport.send.result');
      if (optOwn(ack, 'acknowledged') !== true) {
        return markUncertain(store, identity, {
          agent_id: agentId, request_id: requestId, repository_identity: repositoryIdentity,
        });
      }
      const ackRepo = assertReceiptIdentity(
        ack, identity, 'transport.send.result', repositoryIdentity,
      );
      const ackAgent = assertPatternedId(
        optOwn(ack, 'agent_id'), CURSOR_CLOUD_AGENT_ID_PATTERN, 'transport.send.result.agent_id', 'agent_id',
      );
      if (ackAgent !== agentId) {
        fail('stale_identity_denied', 'transport.send.result.agent_id',
          'Send acknowledgement agent_id must match the created Cursor Cloud agent.');
      }
      const ackRequestId = assertPatternedId(
        optOwn(ack, 'request_id'), CURSOR_CLOUD_REQUEST_ID_PATTERN, 'transport.send.result.request_id', 'request_id',
      );
      if (ackRequestId !== requestId) {
        fail('stale_identity_denied', 'transport.send.result.request_id',
          'Send acknowledgement request_id must match the exact dispatch attempt.');
      }
      const providerRunId = assertPatternedId(
        optOwn(ack, 'provider_run_id'), CURSOR_CLOUD_RUN_ID_PATTERN,
        'transport.send.result.provider_run_id', 'provider_run_id',
      );
      const branch = assertPatternedId(
        optOwn(ack, 'branch'), CURSOR_CLOUD_BRANCH_PATTERN, 'transport.send.result.branch', 'branch',
      );
      putLane(store, identity, {
        state: 'dispatched',
        model: identity.model,
        agent_id: ackAgent,
        provider_run_id: providerRunId,
        request_id: ackRequestId,
        branch,
        repository_identity: ackRepo,
        created: true,
        dispatch_intent: true,
        acknowledged: true,
      });
      return driverResult('launch', identity, 'dispatched');
    });
  } catch (error) {
    void error;
    return markUncertain(store, identity, {
      agent_id: agentId, request_id: requestId, repository_identity: repositoryIdentity,
    });
  }
}

function observeLane(store, identity, record, include) {
  const extras = {
    include: [...include],
    agent_id: record.agent_id,
    provider_run_id: record.provider_run_id,
    request_id: record.request_id,
    branch: record.branch,
    repository_identity: record.repository_identity,
  };
  const observeRequest = transportIdentityRequest(identity, extras);
  assertNoContentKeys(observeRequest, 'cursor_cloud_transport.observe.request');
  const receipt = invokeTransport(store, 'observe', observeRequest);
  return inspectProviderReceipt('observe', () => {
  assertClosedReceipt(receipt, OBSERVE_RECEIPT_KEYS, 'transport.observe.result');
  assertReceiptIdentity(receipt, identity, 'transport.observe.result', record.repository_identity);
  assertExactRunBinding(receipt, record, 'transport.observe.result');
  const status = optOwn(receipt, 'status');
  if (!capturedIncludes(CURSOR_CLOUD_OBSERVE_STATUSES, status)) {
    fail('invalid_format', 'transport.observe.result.status',
      `transport.observe.result.status must be one of ${capturedJoin(CURSOR_CLOUD_OBSERVE_STATUSES, ', ')}.`);
  }
  if (hasOwn(receipt, 'elapsed_ms')) {
    assertBoundedCount(
      optOwn(receipt, 'elapsed_ms'), 'transport.observe.result.elapsed_ms', MAX_CURSOR_CLOUD_TIMING_MS,
    );
  }
  if (hasOwn(receipt, 'event_count')) {
    assertBoundedCount(
      optOwn(receipt, 'event_count'), 'transport.observe.result.event_count', MAX_CURSOR_CLOUD_EVENT_COUNT,
    );
  }
  if (hasOwn(receipt, 'cursor')) {
    assertCursorToken(optOwn(receipt, 'cursor'), 'transport.observe.result.cursor');
  }
  const git = projectGitEvidence(receipt, identity, 'transport.observe.result');
  const events = capturedIncludes(include, 'detailed_events')
    ? projectEvents(optOwn(receipt, 'events'), 'transport.observe.result.events')
    : capturedFreeze([]);
  const progress = capturedIncludes(include, 'live_progress')
    ? projectProgress(optOwn(receipt, 'progress'), 'transport.observe.result.progress')
    : undefined;
  const attention = projectAttention(optOwn(receipt, 'attention'), 'transport.observe.result.attention');
  if (capturedIncludes(TERMINAL_OBSERVE_STATUSES, status)) {
    requireTerminalGitEvidence(git, identity, 'transport.observe.result');
  }
  return capturedFreeze({
    receipt,
    status,
    git,
    events,
    progress,
    attention,
    agent_id: optOwn(receipt, 'agent_id'),
    provider_run_id: optOwn(receipt, 'provider_run_id'),
    request_id: optOwn(receipt, 'request_id'),
    branch: optOwn(receipt, 'branch'),
  });
  });
}

function reconcileDisposition(status) {
  if (status === 'needs_attention') return 'unresolved_attention';
  if (status === 'lost') return 'dispatch_uncertain';
  if (capturedIncludes(TERMINAL_OBSERVE_STATUSES, status)) return 'terminal';
  return 'in_progress';
}

function latchedTerminalResult(operation, identity, record) {
  const extras = operation === 'reconcile' && record.terminal_detail
    ? record.terminal_detail
    : {};
  return driverResult(operation, identity, 'terminal', extras);
}

function runReconcile(store, request) {
  const view = validateDriverReconcileRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  if (prior === undefined || prior.created !== true) {
    fail('not_dispatched', 'driver.reconcile.request',
      'Reconcile addresses an existing Cursor Cloud dispatch; this child has no launch observation.');
  }
  assertLaneIdentity(prior, identity, 'driver.reconcile.request');
  const include = view.include ?? capturedFreeze([]);
  const latched = hasTerminalLatch(prior);

  if (view.intent === 'restart_reattach' && !latched) {
    if (!hasExactRecordedRunIdentity(prior)) {
      putLane(store, identity, { ...prior, state: 'dispatch_uncertain' });
      return driverResult('reconcile', identity, 'dispatch_uncertain');
    }
    const reattachRequest = transportIdentityRequest(identity, {
      agent_id: prior.agent_id,
      provider_run_id: prior.provider_run_id,
      request_id: prior.request_id,
      branch: prior.branch,
      repository_identity: prior.repository_identity,
    });
    assertNoContentKeys(reattachRequest, 'cursor_cloud_transport.reattach.request');
    const reattached = invokeTransport(store, 'reattach', reattachRequest);
    inspectProviderReceipt('reattach', () => {
      assertClosedReceipt(reattached, REATTACH_RECEIPT_KEYS, 'transport.reattach.result');
      if (optOwn(reattached, 'reattached') !== true) {
        fail('stale_identity_denied', 'transport.reattach.result.reattached',
          'restart_reattach recovered no live Cursor Cloud run; the lane fails closed and is never relaunched.');
      }
      assertReceiptIdentity(reattached, identity, 'transport.reattach.result', prior.repository_identity);
      assertExactRunBinding(reattached, prior, 'transport.reattach.result');
      const agentId = assertPatternedId(
        optOwn(reattached, 'agent_id'), CURSOR_CLOUD_AGENT_ID_PATTERN,
        'transport.reattach.result.agent_id', 'agent_id',
      );
      putLane(store, identity, { ...prior, agent_id: agentId, reattached: true });
    });
  }

  if (latched) {
    putLane(store, identity, {
      ...prior,
      state: capturedIncludes(TERMINAL_LATCH_STATES, prior.state) ? prior.state : 'terminal',
      terminal_latch: true,
    });
    return latchedTerminalResult('reconcile', identity, prior);
  }

  const currentBeforeObserve = getLane(store, identity);
  if (!hasExactRecordedRunIdentity(currentBeforeObserve)) {
    putLane(store, identity, { ...currentBeforeObserve, state: 'dispatch_uncertain' });
    return driverResult('reconcile', identity, 'dispatch_uncertain');
  }

  const observed = observeLane(store, identity, currentBeforeObserve, include);
  const current = getLane(store, identity);
  const disposition = current.state === 'dispatch_uncertain' && observed.status === 'lost'
    ? 'dispatch_uncertain'
    : reconcileDisposition(observed.status);
  const nextState = disposition === 'unresolved_attention' ? 'unresolved_attention'
    : disposition === 'terminal' ? 'terminal'
      : disposition === 'dispatch_uncertain' ? 'dispatch_uncertain'
        : 'in_progress';
  const terminalDetail = nextState === 'terminal'
    ? capturedFreeze({
      detail_code: 'terminal_evidence',
      detail_message: boundedDiagnosticMessage('terminal_evidence',
        `status=${observed.status} branch=${observed.git.branch} head=${observed.git.head_sha}`),
    })
    : undefined;
  const attentionDetail = nextState === 'unresolved_attention'
    ? capturedFreeze({
      detail_code: 'unresolved_attention',
      detail_message: boundedDiagnosticMessage('unresolved_attention',
        'same-session reply is unsupported; the question remains unresolved evidence'),
    })
    : undefined;
  const priorTruncated = current.evidence !== undefined && current.evidence.evidence_truncated === true;
  putLane(store, identity, {
    ...current,
    state: nextState,
    evidence: freezeData({
      schema: CURSOR_CLOUD_EVIDENCE_SCHEMA_ID,
      run_id: identity.run_id,
      assignment_id: identity.assignment_id,
      child_envelope_digest: identity.child_envelope_digest,
      agent_id: observed.agent_id ?? current.agent_id ?? null,
      provider_run_id: observed.provider_run_id ?? current.provider_run_id ?? null,
      request_id: observed.request_id ?? current.request_id ?? null,
      branch: observed.branch ?? current.branch ?? null,
      git: observed.git,
      events: observed.events,
      progress: observed.progress ?? null,
      attention: observed.attention ?? null,
      status: observed.status,
      evidence_truncated: evidenceTruncatedFlag(
        observed.events, observed.progress, observed.status, priorTruncated,
      ),
    }),
    last_status: observed.status,
    agent_id: observed.agent_id ?? current.agent_id,
    provider_run_id: observed.provider_run_id ?? current.provider_run_id,
    request_id: observed.request_id ?? current.request_id,
    branch: observed.branch ?? current.branch,
    terminal_latch: nextState === 'terminal',
    terminal_detail: terminalDetail,
  });
  if (nextState === 'unresolved_attention') {
    return driverResult('reconcile', identity, disposition, attentionDetail);
  }
  if (nextState === 'terminal') {
    return driverResult('reconcile', identity, disposition, terminalDetail);
  }
  if (capturedIncludes(include, 'live_progress') && observed.progress !== undefined) {
    return driverResult('reconcile', identity, disposition, {
      detail_code: 'live_progress',
      detail_message: boundedDiagnosticMessage('live_progress',
        `status=${observed.status} events=${observed.progress.event_count ?? 0}`),
    });
  }
  return driverResult('reconcile', identity, disposition);
}

function runCancel(store, request) {
  const view = validateDriverCancelRequestV1(request);
  const identity = identityFromEnvelope(view.envelope, view.child_envelope_digest);
  const prior = getLane(store, identity);
  if (prior === undefined || prior.created !== true) {
    fail('not_dispatched', 'driver.cancel.request',
      'Cancel addresses an existing Cursor Cloud dispatch; this child has no launch observation.');
  }
  assertLaneIdentity(prior, identity, 'driver.cancel.request');
  if (hasTerminalLatch(prior)) {
    putLane(store, identity, { ...prior, state: 'already_terminal', terminal_latch: true });
    return driverResult('cancel', identity, 'already_terminal', {
      detail_code: 'already_terminal',
      detail_message: boundedDiagnosticMessage('already_terminal', 'outcome=already_terminal'),
    });
  }
  if (!hasExactRecordedRunIdentity(prior)) {
    fail('stale_identity_denied', 'driver.cancel.request',
      'Cursor Cloud cancellation requires the exact recorded agent, run, request, and branch identity; refusing to cancel an arbitrary run.');
  }
  const cancelRequest = transportIdentityRequest(identity, {
    agent_id: prior.agent_id,
    provider_run_id: prior.provider_run_id,
    request_id: prior.request_id,
    branch: prior.branch,
    repository_identity: prior.repository_identity,
  });
  assertNoContentKeys(cancelRequest, 'cursor_cloud_transport.cancel.request');
  const receipt = invokeTransport(store, 'cancel', cancelRequest);
  return inspectProviderReceipt('cancel', () => {
  assertClosedReceipt(receipt, CANCEL_RECEIPT_KEYS, 'transport.cancel.result');
  assertReceiptIdentity(receipt, identity, 'transport.cancel.result', prior.repository_identity);
  assertExactRunBinding(receipt, prior, 'transport.cancel.result');
  const outcome = optOwn(receipt, 'outcome');
  if (!capturedIncludes(CURSOR_CLOUD_CANCEL_OUTCOMES, outcome)) {
    fail('invalid_format', 'transport.cancel.result.outcome',
      `transport.cancel.result.outcome must be one of ${capturedJoin(CURSOR_CLOUD_CANCEL_OUTCOMES, ', ')}.`);
  }
  const archived = optOwn(receipt, 'archived');
  if (archived !== true && archived !== false) {
    fail('malformed_receipt', 'transport.cancel.result.archived',
      'transport.cancel.result.archived must be an exact boolean.');
  }
  const archiveCode = archived === true ? 'archive_confirmed' : 'archive_failed';
  if (outcome === 'cancel_requested') {
    putLane(store, identity, {
      ...prior,
      state: 'cancel_requested',
      cancel_outcome: outcome,
      archived,
      terminal_latch: false,
    });
    return driverResult('cancel', identity, 'cancel_requested', {
      detail_code: 'cancel_requested',
      detail_message: boundedDiagnosticMessage('cancel_requested', `outcome=cancel_requested archived=${archived}`),
    });
  }
  putLane(store, identity, {
    ...prior,
    state: outcome,
    cancel_outcome: outcome,
    archived,
    terminal_latch: true,
  });
  return driverResult('cancel', identity, outcome, {
    detail_code: outcome === 'already_terminal' ? 'already_terminal' : archiveCode,
    detail_message: boundedDiagnosticMessage(archiveCode, `outcome=${outcome} archived=${archived}`),
  });
  });
}

export function createCursorCloudDriverV1(transport) {
  assertCursorCloudTransportV1(transport);
  const handlers = capturedCreate(null);
  for (const operation of CURSOR_CLOUD_TRANSPORT_OPERATIONS) {
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
    value: (request) => guardLifecycle('preflight', () => runPreflight(store, request)),
    enumerable: true, configurable: false, writable: false,
  });
  capturedDefineProperty(driver, 'launch', {
    value: (request) => guardLifecycle('launch', () => runLaunch(store, request)),
    enumerable: true, configurable: false, writable: false,
  });
  capturedDefineProperty(driver, 'reconcile', {
    value: (request) => guardLifecycle('reconcile', () => runReconcile(store, request)),
    enumerable: true, configurable: false, writable: false,
  });
  capturedDefineProperty(driver, 'cancel', {
    value: (request) => guardLifecycle('cancel', () => runCancel(store, request)),
    enumerable: true, configurable: false, writable: false,
  });
  OBJECT_FREEZE(driver);
  DRIVER_STORES.set(driver, store);
  assertProviderDriverV1(driver);
  return driver;
}

export function bindCursorCloudDriverV1(transport) {
  const driver = createCursorCloudDriverV1(transport);
  const bound = bindProviderDriverV1(driver, cursorCloudDriverDeclarationV1());
  DRIVER_STORES.set(bound, DRIVER_STORES.get(driver));
  return bound;
}

export function inspectCursorCloudLaneEvidenceV1(driver, query) {
  const path = 'cursor_cloud_evidence.query';
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
  const store = storeFor(driver);
  const record = store.lanes.get(laneKey(optOwn(query, 'run_id'), optOwn(query, 'assignment_id')));
  if (record === undefined || !digestsEqual(record.identity.child_envelope_digest, digest)) {
    fail('stale_identity_denied', path,
      'No Cursor Cloud evidence is stored for this exact child identity.');
  }
  if (record.evidence === undefined) {
    return freezeData({
      schema: CURSOR_CLOUD_EVIDENCE_SCHEMA_ID,
      run_id: record.identity.run_id,
      assignment_id: record.identity.assignment_id,
      child_envelope_digest: record.identity.child_envelope_digest,
      agent_id: record.agent_id ?? null,
      provider_run_id: record.provider_run_id ?? null,
      request_id: record.request_id ?? null,
      branch: record.branch ?? null,
      git: null,
      events: capturedFreeze([]),
      progress: null,
      attention: null,
      status: record.last_status ?? null,
      evidence_truncated: false,
    });
  }
  return record.evidence;
}

export function describeCursorCloudDriverV1() {
  const declaration = cursorCloudDriverDeclarationV1();
  return capturedFreeze({
    schema: CURSOR_CLOUD_DRIVER_SCHEMA_ID,
    version: CURSOR_CLOUD_DRIVER_VERSION,
    provider: CURSOR_CLOUD_PROVIDER_SLOT,
    driver_operations: capturedFreeze([...DRIVER_OPERATIONS]),
    transport_schema: CURSOR_CLOUD_TRANSPORT_SCHEMA_ID,
    transport_operations: capturedFreeze([...CURSOR_CLOUD_TRANSPORT_OPERATIONS]),
    capability: declaration.capability,
    features: declaration.features,
    workspace_semantics: 'remote_provider_managed',
    workspace_starting_point: 'pinned_pushed_sha',
    merge_authority: 'none_codex_only_integration',
    create_pr_posture: 'prohibited',
    confirmation_rule: 'launch_dispatched_only_after_authoritative_sdk_run_identity',
    post_intent_loss_rule: 'exception_timeout_or_loss_after_create_or_send_returns_dispatch_uncertain_never_replayed',
    live_qualification: false,
    durable_store: false,
    supervisor_cutover: false,
    claims: capturedFreeze({
      durable_run_store: false,
      live_transport_qualification: false,
      merge_or_pr_authority: false,
      real_transport_configured: false,
      replay_or_fallback: false,
      same_session_reply: false,
      supervisor_cutover: false,
    }),
    bounds: capturedFreeze({
      event_page: MAX_CURSOR_CLOUD_EVENT_PAGE,
      event_bytes: MAX_CURSOR_CLOUD_EVENT_BYTES,
      event_count: MAX_CURSOR_CLOUD_EVENT_COUNT,
      timing_ms: MAX_CURSOR_CLOUD_TIMING_MS,
      cursor_bytes: MAX_CURSOR_CLOUD_CURSOR_BYTES,
      cursor_pattern: CURSOR_CLOUD_CURSOR_PATTERN.source,
    }),
    identities: capturedFreeze([
      'provider', 'model', 'requested_model', 'effective_model', 'run_id',
      'assignment_id', 'lane_index', 'base_sha', 'child_envelope_digest',
      'starting_sha', 'repository_identity', 'agent_id', 'provider_run_id',
      'request_id', 'branch',
    ]),
    observe_statuses: capturedFreeze([...CURSOR_CLOUD_OBSERVE_STATUSES]),
    cancel_outcomes: capturedFreeze([...CURSOR_CLOUD_CANCEL_OUTCOMES]),
    detail_codes: capturedFreeze([...CURSOR_CLOUD_DETAIL_CODES]),
    later_real_cursor_cloud_route: capturedFreeze({
      preflight: 'inspect clean local checkout, credential-free origin, and pinned pushed SHA without creating an agent',
      create: 'Agent.create with autoCreatePR false and the exact repository/starting SHA',
      send: 'agent.send with a stable request/idempotency id; treat as dispatched only after agent/run/request identity',
      observe: 'getRun plus independently verifiable Git/branch/base evidence; never copy envelope bytes into diagnostics',
      cancel: 'cancel the exact recorded run and report archive truthfully',
      reattach: 'recover the exact recorded agent/run/request identity with no new prompt',
      forbidden: capturedFreeze([
        'cli_fallback_after_send', 'digest_only_launch', 'create_pr', 'merge_or_push',
        'post_intent_retry', 'provider_or_model_substitution', 'same_session_reply',
      ]),
    }),
    feature_values: DRIVER_FEATURE_VALUES,
  });
}

capturedFreeze(assertCursorCloudTransportV1);
capturedFreeze(createCursorCloudDriverV1);
capturedFreeze(bindCursorCloudDriverV1);
capturedFreeze(inspectCursorCloudLaneEvidenceV1);
capturedFreeze(describeCursorCloudDriverV1);
capturedFreeze(cursorCloudDriverDeclarationV1);
