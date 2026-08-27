// ProviderDriverV1 — closed provider-driver envelope/capability contract
// (P17; ADR 0001 identifiers `no_post_dispatch_fallback_or_replay`,
// `exact_identities`, `bounded_evidence`, `gate_a_no_duplicate_dispatch`,
// `gate_a_decision_or_attention_no_silent_unanswerable`).
//
// Additive v3 module. It owns ONLY the pure contract:
//   - the four-operation lifecycle (preflight, launch, reconcile, cancel)
//     plus typed results for each operation;
//   - exact ChildEnvelopeV1 launch proof (text bytes + raw lowercase 64-hex
//     P03 digest; digest-only launches are denied);
//   - honest capability declaration aligned to the accepted P05 13-field
//     ProviderCapabilitiesV1 bridge (no parallel capability schema);
//   - driver-surface features for live progress, restart reattach,
//     cancellation, and detailed events, which fail closed when unsupported;
//   - process-local status transitions with no durable store, scheduler,
//     registry cutover, or provider transport (P18/P20/P19/P21).
//
// Direct-JS inputs use the P05 descriptor-first closure: live and revoked
// Proxies, accessors, symbols, exotic prototypes, sparse arrays, aliases,
// cycles, functions, and own undefined are rejected without running caller
// code. Validated values are detached deep-frozen clones. Replay, fallback,
// resend, merge, and direct-mode keys keep the P02 forbidden-class codes.

import { Buffer as NodeBuffer } from 'node:buffer';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  CAPABILITY_RECORD_ALLOWED_KEYS,
  CREATE_PR_POSTURES,
  DISPATCH_CERTAINTY_VALUES,
  EXACT_MODEL_SELECTION_POSTURES,
  MERGE_AUTHORITIES,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
  REPLAY_POSTURES,
  SAME_SESSION_REPLY_POSTURES,
  WORKSPACE_SEMANTICS_VALUES,
  WORKSPACE_STARTING_POINTS,
  normalizeProviderCapabilitySnapshotV1,
  projectCapabilityRecordFromP17,
} from './capability-bridge.mjs';
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
  sortedCapturedKeys,
} from './grammar.mjs';
import { DIGEST_HEX_LENGTH, IDENTITY_LABELS, childEnvelopeDigestV1 } from './identity.mjs';
import { parseChildEnvelopeV1 } from './prompt-compiler.mjs';
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

export {
  CAPABILITY_RECORD_ALLOWED_KEYS,
  CREATE_PR_POSTURES,
  DISPATCH_CERTAINTY_VALUES,
  EXACT_MODEL_SELECTION_POSTURES,
  MERGE_AUTHORITIES,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
  REPLAY_POSTURES,
  SAME_SESSION_REPLY_POSTURES,
  WORKSPACE_SEMANTICS_VALUES,
  WORKSPACE_STARTING_POINTS,
  normalizeProviderCapabilitySnapshotV1,
  projectCapabilityRecordFromP17,
};

export const PROVIDER_DRIVER_SCHEMA_ID = 'codex-co-engineer.provider-driver.v1';
export const PROVIDER_DRIVER_VERSION = 1;
export const DRIVER_DECLARATION_SCHEMA_ID = 'codex-co-engineer.driver-declaration.v1';

export const DRIVER_OPERATIONS = capturedFreeze([
  'preflight', 'launch', 'reconcile', 'cancel',
]);

export const DRIVER_OPERATION_SCHEMA_IDS = capturedFreeze({
  preflight: 'codex-co-engineer.driver-preflight.v1',
  launch: 'codex-co-engineer.driver-launch.v1',
  reconcile: 'codex-co-engineer.driver-reconcile.v1',
  cancel: 'codex-co-engineer.driver-cancel.v1',
});

export const DRIVER_RESULT_SCHEMA_IDS = capturedFreeze({
  preflight: 'codex-co-engineer.driver-preflight-result.v1',
  launch: 'codex-co-engineer.driver-launch-result.v1',
  reconcile: 'codex-co-engineer.driver-reconcile-result.v1',
  cancel: 'codex-co-engineer.driver-cancel-result.v1',
});

export const DRIVER_SHARED_REQUEST_KEYS = capturedFreeze([
  'schema', 'version', 'envelope_text', 'child_envelope_digest',
]);
export const DRIVER_RECONCILE_REQUEST_KEYS = capturedFreeze([
  ...DRIVER_SHARED_REQUEST_KEYS, 'include', 'intent',
]);
export const DRIVER_REQUEST_KEYS = DRIVER_RECONCILE_REQUEST_KEYS;

export const DRIVER_RESULT_REQUIRED_KEYS = capturedFreeze([
  'schema', 'version', 'run_id', 'assignment_id', 'lane_index', 'base_sha',
  'child_envelope_digest', 'disposition',
]);
export const DRIVER_RESULT_KEYS = capturedFreeze([
  ...DRIVER_RESULT_REQUIRED_KEYS, 'detail_code', 'detail_message',
]);

export const PREFLIGHT_DISPOSITIONS = capturedFreeze(['ready', 'blocked']);
export const LAUNCH_DISPOSITIONS = capturedFreeze([
  'not_sent', 'dispatch_uncertain', 'dispatched',
]);
export const RECONCILE_DISPOSITIONS = capturedFreeze([
  'in_progress', 'terminal', 'unresolved_attention', 'dispatch_uncertain',
]);
export const CANCEL_DISPOSITIONS = capturedFreeze([
  'cancel_requested', 'cancel_confirmed', 'already_terminal',
]);
export const DRIVER_DISPOSITIONS = capturedFreeze({
  preflight: PREFLIGHT_DISPOSITIONS,
  launch: LAUNCH_DISPOSITIONS,
  reconcile: RECONCILE_DISPOSITIONS,
  cancel: CANCEL_DISPOSITIONS,
});

export const DRIVER_FEATURE_KEYS = capturedFreeze([
  'cancellation', 'detailed_events', 'live_progress', 'restart',
]);
export const DRIVER_FEATURE_VALUES = capturedFreeze({
  cancellation: capturedFreeze(['supported', 'unsupported']),
  detailed_events: capturedFreeze(['supported', 'unsupported']),
  live_progress: capturedFreeze(['supported', 'unsupported']),
  restart: capturedFreeze(['reconcile_reattach_only', 'unsupported']),
});
export const RECONCILE_INTENTS = capturedFreeze(['observe', 'restart_reattach']);
export const RECONCILE_INCLUDE_VALUES = capturedFreeze([
  'detailed_events', 'live_progress',
]);
export const DRIVER_DECLARATION_KEYS = capturedFreeze([
  'schema', 'capability', 'features',
]);
export const CAPABILITY_REQUIREMENT_KEYS = capturedFreeze([
  'artifact_kinds', 'create_pr_posture', 'dispatch_certainty',
  'exact_model_selection', 'merge_authority', 'replay_posture',
  'same_session_reply', 'workspace_semantics', 'workspace_starting_point',
]);

export const DETAIL_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const DETAIL_MESSAGE_MAX_BYTES = 512;
export const CHILD_ENVELOPE_DIGEST_PATTERN = new RegExp(`^[0-9a-f]{${DIGEST_HEX_LENGTH}}$`, 'u');

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

const REQUEST_KEYS_BY_OPERATION = capturedFreeze({
  preflight: DRIVER_SHARED_REQUEST_KEYS,
  launch: DRIVER_SHARED_REQUEST_KEYS,
  reconcile: DRIVER_RECONCILE_REQUEST_KEYS,
  cancel: DRIVER_SHARED_REQUEST_KEYS,
});

const POSSIBLE_SEND_STATES = capturedFreeze([
  'dispatch_uncertain', 'dispatched', 'in_progress', 'unresolved_attention',
  'terminal', 'cancel_requested', 'cancel_confirmed', 'already_terminal',
]);
const PRE_LAUNCH_STATES = capturedFreeze(['absent', 'ready', 'blocked', 'not_sent']);

function truncateForMessage(value) {
  const text = STRING(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function requestKeysFor(operation) {
  return REQUEST_KEYS_BY_OPERATION[operation];
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

function assertLowerHexDigest64(value, path) {
  if (typeof value !== 'string' || !capturedTest(CHILD_ENVELOPE_DIGEST_PATTERN, value)) {
    fail('invalid_format', path,
      `${path} must be a raw lowercase ${DIGEST_HEX_LENGTH}-hex sha256 digest.`);
  }
}

function digestsEqual(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && capturedTest(CHILD_ENVELOPE_DIGEST_PATTERN, left)
    && capturedTest(CHILD_ENVELOPE_DIGEST_PATTERN, right)
    && TIMING_SAFE_EQUAL(BUFFER_FROM(left, 'hex'), BUFFER_FROM(right, 'hex'));
}

function proveChildEnvelope(request, path) {
  const envelopeText = optOwn(request, 'envelope_text');
  if (typeof envelopeText !== 'string') {
    fail('invalid_type', `${path}.envelope_text`,
      `${path}.envelope_text must be the exact compiled ChildEnvelopeV1 text.`);
  }
  const parsed = parseChildEnvelopeV1(envelopeText);
  const textBytes = capturedUtf8ByteLength(envelopeText);
  if (textBytes !== parsed.envelope_byte_length) {
    fail('envelope_byte_length_mismatch', `${path}.envelope_text`,
      `${path}.envelope_text encodes ${textBytes} UTF-8 bytes while its strict parse declares `
      + `${parsed.envelope_byte_length}.`);
  }
  assertLowerHexDigest64(optOwn(request, 'child_envelope_digest'), `${path}.child_envelope_digest`);
  const actual = childEnvelopeDigestV1(parsed).digest;
  if (!digestsEqual(actual, optOwn(request, 'child_envelope_digest'))) {
    fail('child_envelope_digest_mismatch', `${path}.child_envelope_digest`,
      `${path}.child_envelope_digest does not equal the sha256 digest of the supplied envelope bytes.`);
  }
  return capturedFreeze({ envelope: parsed, child_envelope_digest: actual });
}

function normalizeReconcileInclude(request, path) {
  if (!hasOwn(request, 'include')) return capturedFreeze([]);
  const include = optOwn(request, 'include');
  assertDenseJsonArray(include, `${path}.include`);
  if (include.length === 0 || include.length > RECONCILE_INCLUDE_VALUES.length) {
    fail('invalid_format', `${path}.include`,
      `${path}.include must list 1-${RECONCILE_INCLUDE_VALUES.length} closed feature names.`);
  }
  const seen = new SET_CTOR();
  const normalized = [];
  for (let index = 0; index < include.length; index += 1) {
    const entryPath = `${path}.include[${index}]`;
    const value = ownDataValue(include, STRING(index), entryPath);
    if (!capturedIncludes(RECONCILE_INCLUDE_VALUES, value)) {
      fail('invalid_format', entryPath,
        `${entryPath} must be exactly one of ${capturedJoin(RECONCILE_INCLUDE_VALUES, ', ')}.`);
    }
    if (SET_HAS.call(seen, value)) {
      fail('invalid_format', entryPath, `${entryPath} repeats include "${value}".`);
    }
    SET_ADD.call(seen, value);
    ARRAY_PUSH.call(normalized, value);
  }
  normalized.sort();
  return capturedFreeze(normalized);
}

function normalizeReconcileIntent(request, path) {
  if (!hasOwn(request, 'intent')) return 'observe';
  const intent = optOwn(request, 'intent');
  if (!capturedIncludes(RECONCILE_INTENTS, intent)) {
    fail('invalid_format', `${path}.intent`,
      `${path}.intent must be exactly one of ${capturedJoin(RECONCILE_INTENTS, ', ')}.`);
  }
  return intent;
}

function validateDriverRequest(request, operation) {
  const path = `driver.${operation}.request`;
  if (request === undefined || request === null) {
    fail('invalid_type', path, `${path} must be a plain driver request object.`);
  }
  assertDirectJsonClosure(request, path);
  assertPlainObject(request, 'invalid_type', path, `${path}`);
  const allowed = requestKeysFor(operation);
  assertAllowedKeys(request, allowed, path);
  for (const key of DRIVER_SHARED_REQUEST_KEYS) {
    if (hasOwn(request, key)) continue;
    if (key === 'envelope_text' && operation === 'launch'
      && hasOwn(request, 'child_envelope_digest')) {
      fail('digest_only_launch_denied', `${path}.envelope_text`,
        'A digest-only launch is forbidden: the exact compiled ChildEnvelopeV1 text must accompany its digest.');
    }
    fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
  }
  if (optOwn(request, 'schema') !== DRIVER_OPERATION_SCHEMA_IDS[operation]) {
    fail('schema_mismatch', `${path}.schema`,
      `${path}.schema must be exactly "${DRIVER_OPERATION_SCHEMA_IDS[operation]}".`);
  }
  if (optOwn(request, 'version') !== PROVIDER_DRIVER_VERSION) {
    fail('invalid_format', `${path}.version`,
      `${path}.version must be exactly ${PROVIDER_DRIVER_VERSION}.`);
  }
  const proof = proveChildEnvelope(request, path);
  const intent = operation === 'reconcile' ? normalizeReconcileIntent(request, path) : undefined;
  const include = operation === 'reconcile' ? normalizeReconcileInclude(request, path) : undefined;
  const detached = detachFrozenJson(request);
  const operationDigest = identityBoundDigest(IDENTITY_LABELS.PROVIDER_OPERATION, {
    child_envelope_digest: proof.child_envelope_digest,
    operation,
    schema: DRIVER_OPERATION_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
  });
  if (!capturedTest(SHA256_DIGEST_PATTERN, operationDigest)) {
    fail('invalid_format', `${path}.operation_digest`,
      'Provider-operation digest must be a lowercase sha256:<64 hex> binding.');
  }
  return capturedFreeze({
    operation,
    request: detached,
    envelope: proof.envelope,
    child_envelope_digest: proof.child_envelope_digest,
    operation_digest: operationDigest,
    intent,
    include,
  });
}

function assertDisposition(value, operation, path) {
  const allowed = DRIVER_DISPOSITIONS[operation];
  if (!capturedIncludes(allowed, value)) {
    fail('invalid_format', path,
      `${path} must be exactly one of ${capturedJoin(allowed, ', ')}.`);
  }
}

function validateDetailPair(result, operation, path) {
  const hasCode = hasOwn(result, 'detail_code');
  const hasMessage = hasOwn(result, 'detail_message');
  if (hasCode !== hasMessage) {
    fail('detail_pair_incomplete', `${path}.detail_code`,
      `${path}.detail_code and ${path}.detail_message must be provided together.`);
  }
  const disposition = optOwn(result, 'disposition');
  const required = (operation === 'preflight' && disposition === 'blocked')
    || (operation === 'launch' && disposition === 'not_sent');
  const forbidden = (operation === 'preflight' && disposition === 'ready')
    || (operation === 'launch' && disposition !== 'not_sent');
  if (required && !hasCode) {
    fail('missing_key', `${path}.detail_code`,
      `A ${operation} result with disposition "${disposition}" requires a bounded detail_code/detail_message pair.`);
  }
  if (forbidden && hasCode) {
    fail('detail_pair_denied', `${path}.detail_code`,
      `A ${operation} result with disposition "${disposition}" must not carry a detail pair.`);
  }
  if (!hasCode) return;
  const code = optOwn(result, 'detail_code');
  if (typeof code !== 'string' || !capturedTest(DETAIL_CODE_PATTERN, code)) {
    fail('invalid_format', `${path}.detail_code`,
      `${path}.detail_code violates the bounded grammar ${DETAIL_CODE_PATTERN.source}.`);
  }
  assertBoundedText(optOwn(result, 'detail_message'), {
    min: 1, max: DETAIL_MESSAGE_MAX_BYTES, path: `${path}.detail_message`, label: 'detail_message',
  });
}

function assertResultIdentity(result, view, path) {
  const expected = capturedFreeze({
    run_id: view.envelope.run_id,
    assignment_id: view.envelope.assignment_id,
    lane_index: view.envelope.lane_index,
    base_sha: view.envelope.repository.base_sha,
    child_envelope_digest: view.child_envelope_digest,
  });
  for (const key of sortedCapturedKeys(expected)) {
    const actual = optOwn(result, key);
    const value = expected[key];
    const equal = key === 'child_envelope_digest' ? digestsEqual(actual, value) : actual === value;
    if (!equal) {
      fail('receipt_identity_mismatch', `${path}.${key}`,
        `${path}.${key} must echo the exact request identity (${truncateForMessage(value)}), received ${truncateForMessage(actual)}.`);
    }
  }
}

function assertCapabilityHonesty(result, operation, declaration, path) {
  const capability = declaration.capability;
  const disposition = optOwn(result, 'disposition');
  if (operation === 'launch' && disposition === 'dispatched'
    && capability.dispatch_certainty === 'uncertain_after_spawn') {
    fail('capability_dispatch_certainty_mismatch', `${path}.disposition`,
      `${path}.disposition "dispatched" is forbidden when the P05 capability declares `
      + `"uncertain_after_spawn"; report dispatch_uncertain instead.`);
  }
  if (operation === 'reconcile' && disposition === 'unresolved_attention'
    && capability.same_session_reply === 'live_session_reply') {
    return;
  }
  if (operation === 'launch' && disposition !== 'not_sent'
    && capability.replay_posture !== 'never_replay') {
    fail('invalid_replay_posture', `${path}.disposition`,
      'A launched observation is only valid when the P05 capability declares never_replay.');
  }
}

function validateDriverResultWithView(result, view, operation, declaration) {
  const path = `driver.${operation}.result`;
  if (result === undefined || result === null) {
    fail('invalid_type', path, `${path} must be a plain driver result object.`);
  }
  assertDirectJsonClosure(result, path);
  assertPlainObject(result, 'invalid_type', path, `${path}`);
  assertAllowedKeys(result, DRIVER_RESULT_KEYS, path);
  for (const key of DRIVER_RESULT_REQUIRED_KEYS) {
    if (!hasOwn(result, key)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
  if (optOwn(result, 'schema') !== DRIVER_RESULT_SCHEMA_IDS[operation]) {
    fail('schema_mismatch', `${path}.schema`,
      `${path}.schema must be exactly "${DRIVER_RESULT_SCHEMA_IDS[operation]}".`);
  }
  if (optOwn(result, 'version') !== PROVIDER_DRIVER_VERSION) {
    fail('invalid_format', `${path}.version`,
      `${path}.version must be exactly ${PROVIDER_DRIVER_VERSION}.`);
  }
  assertDisposition(optOwn(result, 'disposition'), operation, `${path}.disposition`);
  validateDetailPair(result, operation, path);
  assertResultIdentity(result, view, path);
  if (declaration !== undefined) {
    assertCapabilityHonesty(result, operation, declaration, path);
  }
  return detachFrozenJson(result);
}

function validateFeatures(features, path) {
  assertPlainObject(features, 'invalid_type', path, `${path}`);
  assertAllowedKeys(features, DRIVER_FEATURE_KEYS, path);
  const normalized = capturedCreate(null);
  for (const key of DRIVER_FEATURE_KEYS) {
    if (!hasOwn(features, key)) {
      fail('missing_key', `${path}.${key}`,
        `${path}.${key} is required; driver features have no hidden defaults.`);
    }
    const value = optOwn(features, key);
    if (!capturedIncludes(DRIVER_FEATURE_VALUES[key], value)) {
      fail('invalid_format', `${path}.${key}`,
        `${path}.${key} must be exactly one of ${capturedJoin(DRIVER_FEATURE_VALUES[key], ', ')}.`);
    }
    normalized[key] = value;
  }
  return freezeData({
    cancellation: normalized.cancellation,
    detailed_events: normalized.detailed_events,
    live_progress: normalized.live_progress,
    restart: normalized.restart,
  });
}

export function validateDriverDeclarationV1(declaration) {
  const path = 'driver_declaration';
  if (declaration === undefined || declaration === null) {
    fail('missing_key', path,
      `${path} is required; a driver never inherits hidden capability or feature defaults.`);
  }
  assertDirectJsonClosure(declaration, `$.${path}`);
  assertPlainObject(declaration, 'invalid_type', path, path);
  assertAllowedKeys(declaration, DRIVER_DECLARATION_KEYS, path);
  for (const key of DRIVER_DECLARATION_KEYS) {
    if (!hasOwn(declaration, key)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
  if (optOwn(declaration, 'schema') !== DRIVER_DECLARATION_SCHEMA_ID) {
    fail('schema_mismatch', `${path}.schema`,
      `${path}.schema must be exactly "${DRIVER_DECLARATION_SCHEMA_ID}".`);
  }
  const projected = projectCapabilityRecordFromP17(optOwn(declaration, 'capability'));
  const features = validateFeatures(optOwn(declaration, 'features'), `${path}.features`);
  return freezeData({
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: freezeData({
      schema: PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
      artifact_kinds: projected.artifact_kinds,
      create_pr_posture: projected.create_pr_posture,
      dispatch_certainty: projected.dispatch_certainty,
      exact_model_selection: projected.exact_model_selection,
      merge_authority: projected.merge_authority,
      notes: projected.notes,
      provider: projected.provider,
      replay_posture: projected.replay_posture,
      revision: projected.revision,
      same_session_reply: projected.same_session_reply,
      source_digest: projected.source_digest,
      workspace_semantics: projected.workspace_semantics,
      workspace_starting_point: projected.workspace_starting_point,
    }),
    features,
  });
}

function requirementMismatchCode(key) {
  if (key === 'same_session_reply') return 'capability_reply_mismatch';
  if (key === 'dispatch_certainty') return 'capability_dispatch_certainty_mismatch';
  if (key === 'workspace_semantics' || key === 'workspace_starting_point') {
    return 'capability_workspace_mismatch';
  }
  if (key === 'create_pr_posture' || key === 'merge_authority') {
    return 'capability_merge_authority_mismatch';
  }
  if (key === 'replay_posture') return 'invalid_replay_posture';
  if (key === 'exact_model_selection') return 'invalid_exact_model_selection';
  if (key === 'artifact_kinds') return 'invalid_artifact_kinds';
  return 'unsupported_capability';
}

export function assertCapabilityRequirementV1(declaration, requirement) {
  const validated = validateDriverDeclarationV1(declaration);
  const path = 'capability_requirement';
  if (requirement === undefined || requirement === null) {
    fail('invalid_type', path, `${path} must be a plain object of P05 assertable fields.`);
  }
  assertDirectJsonClosure(requirement, `$.${path}`);
  assertPlainObject(requirement, 'invalid_type', path, path);
  assertAllowedKeys(requirement, CAPABILITY_REQUIREMENT_KEYS, path);
  const keys = sortedCapturedKeys(requirement);
  if (keys.length === 0) {
    fail('missing_key', path, `${path} must assert at least one closed P05 capability field.`);
  }
  const capability = validated.capability;
  for (const key of keys) {
    if (!capturedIncludes(CAPABILITY_REQUIREMENT_KEYS, key)) {
      fail('unknown_capability_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed P05 capability requirement vocabulary.`);
    }
    const expected = optOwn(requirement, key);
    const actual = capability[key];
    if (key === 'artifact_kinds') {
      assertDenseJsonArray(expected, `${path}.${key}`);
      for (let index = 0; index < expected.length; index += 1) {
        const kind = ownDataValue(expected, STRING(index), `${path}.${key}[${index}]`);
        if (!capturedIncludes(actual, kind)) {
          fail('unsupported_capability', `${path}.${key}`,
            `Capability does not declare artifact kind "${kind}"; unsupported evidence fails closed.`);
        }
      }
      continue;
    }
    if (expected !== actual) {
      fail(requirementMismatchCode(key), `${path}.${key}`,
        `${path}.${key} requires "${truncateForMessage(expected)}" but the P05 capability declares `
        + `"${truncateForMessage(actual)}"; unsupported postures fail closed with no fallback.`);
    }
  }
  return validated.capability;
}

export function assertDriverFeatureV1(declaration, feature) {
  const validated = validateDriverDeclarationV1(declaration);
  const path = `driver_declaration.features.${feature}`;
  if (!capturedIncludes(DRIVER_FEATURE_KEYS, feature)) {
    fail('unknown_key', path, `${path} is not a closed driver feature.`);
  }
  const value = validated.features[feature];
  if (value === 'unsupported') {
    fail('unsupported_capability', path,
      `Feature "${feature}" is declared unsupported; the driver fails closed with no fallback or replay.`);
  }
  return value;
}

function denyUnsupportedFeature(declaration, feature, path) {
  if (declaration.features[feature] === 'unsupported') {
    fail('unsupported_capability', path,
      `Feature "${feature}" is declared unsupported; the driver fails closed with no fallback or replay.`);
  }
}

function assertEnvelopeProvider(view, declaration) {
  const envelopeProvider = view.envelope.execution.provider;
  if (envelopeProvider !== null && envelopeProvider !== declaration.capability.provider) {
    fail('provider_slot_mismatch', 'driver_declaration.capability.provider',
      `driver_declaration.capability.provider must be exactly "${envelopeProvider}" for this child envelope.`);
  }
}

function assertRequestedFeatures(view, declaration) {
  assertEnvelopeProvider(view, declaration);
  if (view.operation === 'cancel') {
    denyUnsupportedFeature(declaration, 'cancellation', 'driver_declaration.features.cancellation');
  }
  if (view.operation !== 'reconcile') return;
  if (view.intent === 'restart_reattach') {
    denyUnsupportedFeature(declaration, 'restart', 'driver.reconcile.request.intent');
  }
  for (let index = 0; index < view.include.length; index += 1) {
    const feature = view.include[index];
    denyUnsupportedFeature(declaration, feature, `driver.reconcile.request.include[${index}]`);
  }
}

function laneKey(envelope) {
  return `${envelope.run_id}\u0000${envelope.assignment_id}`;
}

function assertTransition(operation, state, view) {
  const path = `driver.${operation}.request`;
  if (operation === 'preflight') {
    if (state === 'absent' || state === 'ready' || state === 'blocked' || state === 'not_sent') {
      return;
    }
    fail('invalid_transition', path,
      'Preflight cannot run after a prompt may have been dispatched; reconcile or cancel instead.');
  }
  if (operation === 'launch') {
    if (state === 'absent') {
      fail('not_preflighted', path,
        'Launch requires a prior preflight:ready result for this exact child identity.');
    }
    if (state === 'blocked') {
      fail('blocked_lane_denied', path,
        'A blocked preflight cannot launch; the lane fails closed with no fallback.');
    }
    if (state === 'ready' || state === 'not_sent') return;
    fail('replay_denied', path,
      'A previous launch may have sent the prompt; the lane is never replayed onto this or another transport.');
  }
  if (operation === 'reconcile') {
    if (capturedIncludes(PRE_LAUNCH_STATES, state) && state !== 'not_sent') {
      fail('not_dispatched', path,
        'Reconcile addresses an existing dispatch; this child has no launch observation.');
    }
    if (state === 'not_sent') {
      fail('not_dispatched', path,
        'A not_sent launch never reached the provider; reconcile cannot invent a dispatch.');
    }
    if (view.intent === 'restart_reattach' && !capturedIncludes(POSSIBLE_SEND_STATES, state)) {
      fail('not_dispatched', `${path}.intent`,
        'restart_reattach is reconcile-only recovery of existing provider work and never a relaunch.');
    }
    return;
  }
  if (capturedIncludes(PRE_LAUNCH_STATES, state)) {
    fail('not_dispatched', path,
      'Cancel addresses an existing dispatch; this child has no launch observation.');
  }
}

function nextState(operation, disposition) {
  if (operation === 'preflight') return disposition;
  if (operation === 'launch') return disposition;
  if (operation === 'reconcile') return disposition;
  return disposition;
}

export function validateDriverPreflightRequestV1(request) {
  return validateDriverRequest(request, 'preflight');
}

export function validateDriverLaunchRequestV1(request) {
  return validateDriverRequest(request, 'launch');
}

export function validateDriverReconcileRequestV1(request) {
  return validateDriverRequest(request, 'reconcile');
}

export function validateDriverCancelRequestV1(request) {
  return validateDriverRequest(request, 'cancel');
}

export function validateDriverPreflightResultV1(result, request, declaration) {
  const view = validateDriverRequest(request, 'preflight');
  const validated = declaration === undefined ? undefined : validateDriverDeclarationV1(declaration);
  return validateDriverResultWithView(result, view, 'preflight', validated);
}

export function validateDriverLaunchResultV1(result, request, declaration) {
  const view = validateDriverRequest(request, 'launch');
  const validated = declaration === undefined ? undefined : validateDriverDeclarationV1(declaration);
  return validateDriverResultWithView(result, view, 'launch', validated);
}

export function validateDriverReconcileResultV1(result, request, declaration) {
  const view = validateDriverRequest(request, 'reconcile');
  const validated = declaration === undefined ? undefined : validateDriverDeclarationV1(declaration);
  return validateDriverResultWithView(result, view, 'reconcile', validated);
}

export function validateDriverCancelResultV1(result, request, declaration) {
  const view = validateDriverRequest(request, 'cancel');
  const validated = declaration === undefined ? undefined : validateDriverDeclarationV1(declaration);
  return validateDriverResultWithView(result, view, 'cancel', validated);
}

export function assertProviderDriverV1(driver) {
  const path = 'provider_driver';
  if (driver !== null && (typeof driver === 'object' || typeof driver === 'function')
    && IS_PROXY(driver)) {
    fail('proxy_denied', path,
      `${path} is a live or revoked Proxy; driver surfaces accept concrete operation functions only.`);
  }
  if (!isPlainObject(driver)) {
    if (typeof driver === 'object' && driver !== null && !capturedIsArray(driver)) {
      fail('exotic_prototype_denied', path,
        `${path} must use the standard or null object prototype; exotic prototypes are denied.`);
    }
    fail('invalid_type', path,
      `${path} must be a plain record of exactly four operation functions.`);
  }
  const entries = assertJsonDataObject(driver, path);
  const expected = new SET_CTOR(DRIVER_OPERATIONS);
  if (entries.length !== DRIVER_OPERATIONS.length
    || entries.some(({ key }) => !SET_HAS.call(expected, key))) {
    const received = entries.map(({ key }) => key).join(', ') || 'none';
    fail('invalid_surface', path,
      `${path} must expose exactly the own operations ${capturedJoin(DRIVER_OPERATIONS, ', ')}; received ${received}.`);
  }
  for (const { key, value } of entries) {
    if (typeof value !== 'function' || IS_PROXY(value)) {
      fail('invalid_operation', `${path}.${key}`,
        `${path}.${key} must be a concrete function implementing the "${key}" operation.`);
    }
  }
  return capturedFreeze({
    schema: PROVIDER_DRIVER_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    operations: capturedFreeze([...DRIVER_OPERATIONS]),
  });
}

export function bindProviderDriverV1(driver, declaration) {
  assertProviderDriverV1(driver);
  const validatedDeclaration = validateDriverDeclarationV1(declaration);
  const lanes = new MAP_CTOR();
  const bound = {};
  for (const operation of DRIVER_OPERATIONS) {
    const handler = capturedDescriptor(driver, operation)?.value;
    if (typeof handler !== 'function' || IS_PROXY(handler)) {
      fail('invalid_operation', `provider_driver.${operation}`,
        `provider_driver.${operation} must be a concrete function.`);
    }
    capturedDefineProperty(bound, operation, {
      value: function boundDriverOperation(request) {
        const view = validateDriverRequest(request, operation);
        assertRequestedFeatures(view, validatedDeclaration);
        const key = laneKey(view.envelope);
        const prior = lanes.get(key);
        if (prior !== undefined && !digestsEqual(prior.child_envelope_digest, view.child_envelope_digest)) {
          fail('stale_identity_denied', `driver.${operation}.request.child_envelope_digest`,
            'The request envelope digest does not match the exact child previously observed on this lane.');
        }
        const state = prior === undefined ? 'absent' : prior.state;
        assertTransition(operation, state, view);
        const result = handler.call(driver, view.request);
        const frozen = validateDriverResultWithView(result, view, operation, validatedDeclaration);
        lanes.set(key, capturedFreeze({
          child_envelope_digest: view.child_envelope_digest,
          state: nextState(operation, frozen.disposition),
        }));
        return frozen;
      },
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return OBJECT_FREEZE(bound);
}

export function buildDriverOperationRequestV1(operation, envelope, extras = {}) {
  if (!hasOwn(DRIVER_OPERATION_SCHEMA_IDS, operation)) {
    fail('unknown_operation', 'operation',
      `operation must be one of ${capturedJoin(DRIVER_OPERATIONS, ', ')}.`);
  }
  if (extras === undefined || extras === null) {
    fail('invalid_type', 'request_extras', 'request extras must be a plain object when present.');
  }
  assertDirectJsonClosure(extras, 'request_extras');
  assertPlainObject(extras, 'invalid_type', 'request_extras', 'request extras');
  const extraKeys = operation === 'reconcile'
    ? capturedFreeze(['include', 'intent'])
    : capturedFreeze([]);
  assertAllowedKeys(extras, extraKeys, 'request_extras');
  const request = {
    schema: DRIVER_OPERATION_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: envelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
  };
  if (hasOwn(extras, 'intent')) request.intent = optOwn(extras, 'intent');
  if (hasOwn(extras, 'include')) request.include = optOwn(extras, 'include');
  return detachFrozenJson(validateDriverRequest(request, operation).request);
}

export function describeProviderDriverContractV1() {
  return capturedFreeze({
    schema: PROVIDER_DRIVER_SCHEMA_ID,
    version: PROVIDER_DRIVER_VERSION,
    operations: capturedFreeze([...DRIVER_OPERATIONS]),
    request_schema_ids: DRIVER_OPERATION_SCHEMA_IDS,
    result_schema_ids: DRIVER_RESULT_SCHEMA_IDS,
    request_keys: DRIVER_REQUEST_KEYS,
    result_keys: DRIVER_RESULT_KEYS,
    dispositions: capturedFreeze({
      preflight: [...PREFLIGHT_DISPOSITIONS],
      launch: [...LAUNCH_DISPOSITIONS],
      reconcile: [...RECONCILE_DISPOSITIONS],
      cancel: [...CANCEL_DISPOSITIONS],
    }),
    capability_schema_id: PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
    capability_snapshot_schema_id: PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
    capability_record_keys: CAPABILITY_RECORD_ALLOWED_KEYS,
    features: DRIVER_FEATURE_VALUES,
    reconcile_intents: RECONCILE_INTENTS,
    relaunch_operations: capturedFreeze([]),
    transports: capturedFreeze([]),
    detail_code_pattern: DETAIL_CODE_PATTERN.source,
    detail_message_max_bytes: DETAIL_MESSAGE_MAX_BYTES,
  });
}

capturedFreeze(validateDriverDeclarationV1);
capturedFreeze(assertCapabilityRequirementV1);
capturedFreeze(assertDriverFeatureV1);
capturedFreeze(validateDriverPreflightRequestV1);
capturedFreeze(validateDriverLaunchRequestV1);
capturedFreeze(validateDriverReconcileRequestV1);
capturedFreeze(validateDriverCancelRequestV1);
capturedFreeze(validateDriverPreflightResultV1);
capturedFreeze(validateDriverLaunchResultV1);
capturedFreeze(validateDriverReconcileResultV1);
capturedFreeze(validateDriverCancelResultV1);
capturedFreeze(assertProviderDriverV1);
capturedFreeze(bindProviderDriverV1);
capturedFreeze(buildDriverOperationRequestV1);
capturedFreeze(describeProviderDriverContractV1);
