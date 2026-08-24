// Minimal inert ProviderDriverV1 template/scaffold (P22).
//
// Imports the accepted P17 public contract only. This is not a fifth
// provider, transport, credential, process, filesystem, remote, fallback,
// retry, or registry surface. Every identity is caller-supplied, validated
// through P17, frozen, and never substituted. Unsupported operations fail
// closed. Launch never sends a prompt.

import { types as utilTypes } from 'node:util';

import {
  capturedCreate,
  capturedDefineProperty,
  capturedFreeze,
  capturedIncludes,
  capturedIsArray,
  capturedTest,
  isKnownProvider,
  isModelId,
} from './grammar.mjs';
import {
  DRIVER_DECLARATION_SCHEMA_ID,
  DRIVER_DISPOSITIONS,
  DRIVER_FEATURE_VALUES,
  DRIVER_OPERATIONS,
  DRIVER_RESULT_SCHEMA_IDS,
  PROVIDER_DRIVER_SCHEMA_ID,
  PROVIDER_DRIVER_VERSION,
  assertProviderDriverV1,
  bindProviderDriverV1,
  describeProviderDriverContractV1,
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
  ASSIGNMENT_ID_PATTERN,
  RUN_ID_PATTERN,
  SHA40_PATTERN,
  assertAllowedKeys,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  optOwn,
} from './selection-json.mjs';

export const FUTURE_HARNESS_TEMPLATE_SCHEMA_ID = 'codex-co-engineer.future-harness-template.v1';
export const FUTURE_HARNESS_TEMPLATE_VERSION = 1;

export const FUTURE_HARNESS_IDENTITY_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'branch', 'lane_index', 'model', 'provider',
  'request_id', 'run_id', 'workspace_semantics', 'workspace_starting_point',
]);

export const FUTURE_HARNESS_TEMPLATE_OPTION_KEYS = capturedFreeze([
  'declaration', 'identity',
]);

export const FUTURE_HARNESS_FAIL_CLOSED_FEATURES = capturedFreeze({
  cancellation: 'unsupported',
  detailed_events: 'unsupported',
  live_progress: 'unsupported',
  restart: 'unsupported',
});

export const FUTURE_HARNESS_REQUEST_ID_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/u;
export const FUTURE_HARNESS_BRANCH_PATTERN = /^[a-z][a-z0-9._/-]{0,127}$/u;

const REQUEST_VALIDATORS = capturedFreeze({
  preflight: validateDriverPreflightRequestV1,
  launch: validateDriverLaunchRequestV1,
  reconcile: validateDriverReconcileRequestV1,
  cancel: validateDriverCancelRequestV1,
});

const RESULT_VALIDATORS = capturedFreeze({
  preflight: validateDriverPreflightResultV1,
  launch: validateDriverLaunchResultV1,
  reconcile: validateDriverReconcileResultV1,
  cancel: validateDriverCancelResultV1,
});

const PRE_LAUNCH_STATES = capturedFreeze(['absent', 'ready', 'blocked', 'not_sent']);
const POSSIBLE_SEND_STATES = capturedFreeze([
  'dispatch_uncertain', 'dispatched', 'in_progress', 'unresolved_attention',
  'terminal', 'cancel_requested', 'cancel_confirmed', 'already_terminal',
]);

const IS_PROXY = utilTypes.isProxy;
const NUMBER_IS_INTEGER = Number.isInteger;
const OBJECT_FREEZE = Object.freeze;
const TEMPLATE_STORES = new WeakMap();

function assertPattern(value, pattern, path, label) {
  if (typeof value !== 'string' || !capturedTest(pattern, value)) {
    fail('invalid_format', path, `${path} must be a bounded ${label}.`);
  }
  return value;
}

export function validateFutureHarnessIdentityV1(identity) {
  const path = 'future_harness.identity';
  if (identity === undefined || identity === null) {
    fail('missing_key', path, `${path} is required; identities are never inferred or substituted.`);
  }
  assertDirectJsonClosure(identity, path);
  assertPlainObject(identity, 'invalid_type', path, path);
  assertAllowedKeys(identity, FUTURE_HARNESS_IDENTITY_KEYS, path);
  for (const key of FUTURE_HARNESS_IDENTITY_KEYS) {
    if (!hasOwn(identity, key)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} must be caller-supplied.`);
    }
  }
  const provider = optOwn(identity, 'provider');
  if (!isKnownProvider(provider)) {
    fail('unknown_provider', `${path}.provider`,
      `${path}.provider must be a caller-supplied P05 provider slot.`);
  }
  const model = optOwn(identity, 'model');
  if (!isModelId(model)) {
    fail('invalid_exact_model_selection', `${path}.model`,
      `${path}.model must be the exact caller-supplied model identifier.`);
  }
  assertPattern(optOwn(identity, 'run_id'), RUN_ID_PATTERN, `${path}.run_id`, 'run_id');
  assertPattern(
    optOwn(identity, 'assignment_id'), ASSIGNMENT_ID_PATTERN,
    `${path}.assignment_id`, 'assignment_id',
  );
  const laneIndex = optOwn(identity, 'lane_index');
  if (!NUMBER_IS_INTEGER(laneIndex) || laneIndex < 0 || laneIndex > 7) {
    fail('invalid_format', `${path}.lane_index`,
      `${path}.lane_index must be an integer in 0..=7.`);
  }
  assertPattern(optOwn(identity, 'request_id'), FUTURE_HARNESS_REQUEST_ID_PATTERN,
    `${path}.request_id`, 'request_id');
  assertPattern(optOwn(identity, 'branch'), FUTURE_HARNESS_BRANCH_PATTERN,
    `${path}.branch`, 'branch');
  assertPattern(optOwn(identity, 'base_sha'), SHA40_PATTERN, `${path}.base_sha`, 'base_sha');
  return freezeData({
    provider,
    model,
    run_id: optOwn(identity, 'run_id'),
    assignment_id: optOwn(identity, 'assignment_id'),
    lane_index: laneIndex,
    request_id: optOwn(identity, 'request_id'),
    branch: optOwn(identity, 'branch'),
    base_sha: optOwn(identity, 'base_sha'),
    workspace_semantics: optOwn(identity, 'workspace_semantics'),
    workspace_starting_point: optOwn(identity, 'workspace_starting_point'),
  });
}

function assertIdentityMatchesDeclaration(identity, declaration) {
  if (identity.provider !== declaration.capability.provider) {
    fail('provider_slot_mismatch', 'future_harness.identity.provider',
      'Caller-supplied provider must equal the P17 capability provider slot.');
  }
  if (identity.workspace_semantics !== declaration.capability.workspace_semantics
    || identity.workspace_starting_point !== declaration.capability.workspace_starting_point) {
    fail('capability_workspace_mismatch', 'future_harness.identity.workspace_semantics',
      'Caller-supplied workspace posture must equal the P17 capability workspace posture.');
  }
}

function assertEnvelopeIdentity(view, identity, operation) {
  const envelope = view.envelope;
  const path = `driver.${operation}.request`;
  if (envelope.execution.provider !== identity.provider) {
    fail('provider_slot_mismatch', `${path}.envelope_text`,
      'Proven child provider does not match the frozen caller-supplied identity.');
  }
  if (envelope.execution.model !== identity.model) {
    fail('invalid_exact_model_selection', `${path}.envelope_text`,
      'Proven child model does not match the frozen caller-supplied identity.');
  }
  if (envelope.run_id !== identity.run_id
    || envelope.assignment_id !== identity.assignment_id
    || envelope.lane_index !== identity.lane_index
    || envelope.repository.base_sha !== identity.base_sha) {
    fail('stale_identity_denied', path,
      'Proven child run/assignment/lane/base identity does not match the frozen caller-supplied identity.');
  }
  if (identity.workspace_starting_point === 'run_base_sha') {
    if (envelope.starting_ref !== null) {
      fail('capability_workspace_mismatch', `${path}.envelope_text`,
        'Local template lanes start at the frozen base_sha and never carry a starting_ref.');
    }
  } else if (envelope.starting_ref !== identity.base_sha) {
    fail('capability_workspace_mismatch', `${path}.envelope_text`,
      'Pinned starting_ref must equal the frozen caller-supplied base_sha.');
  }
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
      'A previous launch may have sent the prompt; the lane is never replayed.');
  }
  if (operation === 'reconcile') {
    if (capturedIncludes(PRE_LAUNCH_STATES, state) && state !== 'not_sent') {
      fail('not_dispatched', path,
        'Reconcile addresses an existing dispatch; this child has no launch observation.');
    }
    if (state === 'not_sent') {
      fail('not_dispatched', path,
        'A not_sent launch never reached a provider; reconcile cannot invent a dispatch.');
    }
    if (view.intent === 'restart_reattach' && !capturedIncludes(POSSIBLE_SEND_STATES, state)) {
      fail('not_dispatched', `${path}.intent`,
        'restart_reattach recovers existing provider work and is never a relaunch.');
    }
    return;
  }
  if (capturedIncludes(PRE_LAUNCH_STATES, state)) {
    fail('not_dispatched', path,
      'Cancel addresses an existing dispatch; this child has no launch observation.');
  }
}

function detailFor(operation, disposition) {
  if (operation === 'preflight' && disposition === 'blocked') {
    return capturedFreeze({
      detail_code: 'model_unattested',
      detail_message: 'The installed driver cannot attest the requested model.',
    });
  }
  if (operation === 'launch' && disposition === 'not_sent') {
    return capturedFreeze({
      detail_code: 'transport_unavailable',
      detail_message: 'No provider transport is configured.',
    });
  }
  return undefined;
}

function buildResult(operation, view, identity, disposition) {
  const result = {
    schema: DRIVER_RESULT_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    lane_index: identity.lane_index,
    base_sha: identity.base_sha,
    child_envelope_digest: view.child_envelope_digest,
    disposition,
  };
  const detail = detailFor(operation, disposition);
  if (detail !== undefined) {
    result.detail_code = detail.detail_code;
    result.detail_message = detail.detail_message;
  }
  return result;
}

function runOperation(store, operation, request) {
  const view = REQUEST_VALIDATORS[operation](request);
  assertEnvelopeIdentity(view, store.identity, operation);
  const state = store.state;
  assertTransition(operation, state, view);
  let disposition;
  if (operation === 'preflight') {
    const attested = store.declaration.capability.exact_model_selection === 'exact_and_attested';
    disposition = attested ? 'ready' : 'blocked';
  } else if (operation === 'launch') {
    disposition = 'not_sent';
  } else {
    fail('unsupported_capability', `driver.${operation}.request`,
      `Template operation "${operation}" is inert and fails closed with no provider transport.`);
  }
  if (!capturedIncludes(DRIVER_DISPOSITIONS[operation], disposition)) {
    fail('invalid_format', `driver.${operation}.result.disposition`,
      'Template disposition is outside the closed P17 vocabulary.');
  }
  const frozen = RESULT_VALIDATORS[operation](
    buildResult(operation, view, store.identity, disposition),
    view.request,
    store.declaration,
  );
  store.state = disposition;
  return frozen;
}

function installOperation(driver, store, operation) {
  capturedDefineProperty(driver, operation, {
    value: function futureHarnessTemplateOperation(request) {
      return runOperation(store, operation, request);
    },
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

export function createFutureHarnessDriverTemplateV1(options) {
  const path = 'future_harness.template';
  if (options === undefined || options === null) {
    fail('missing_key', path, `${path} requires caller-supplied identity and declaration.`);
  }
  if (options !== null && (typeof options === 'object' || typeof options === 'function')
    && IS_PROXY(options)) {
    fail('proxy_denied', path, `${path} is a live or revoked Proxy; template options must be direct JSON.`);
  }
  assertDirectJsonClosure(options, path);
  assertPlainObject(options, 'invalid_type', path, path);
  assertAllowedKeys(options, FUTURE_HARNESS_TEMPLATE_OPTION_KEYS, path);
  if (!hasOwn(options, 'identity') || !hasOwn(options, 'declaration')) {
    fail('missing_key', path, `${path} requires own identity and declaration fields.`);
  }
  const identity = validateFutureHarnessIdentityV1(optOwn(options, 'identity'));
  const declaration = validateDriverDeclarationV1(optOwn(options, 'declaration'));
  assertIdentityMatchesDeclaration(identity, declaration);
  const store = {
    identity,
    declaration,
    state: 'absent',
  };
  const driver = capturedCreate(null);
  for (const operation of DRIVER_OPERATIONS) {
    installOperation(driver, store, operation);
  }
  OBJECT_FREEZE(driver);
  TEMPLATE_STORES.set(driver, store);
  assertProviderDriverV1(driver);
  return driver;
}

export function bindFutureHarnessDriverTemplateV1(options) {
  const driver = createFutureHarnessDriverTemplateV1(options);
  const bound = bindProviderDriverV1(driver, TEMPLATE_STORES.get(driver).declaration);
  TEMPLATE_STORES.set(bound, TEMPLATE_STORES.get(driver));
  return bound;
}

export function inspectFutureHarnessTemplateBindingV1(driver) {
  const path = 'future_harness.template.binding';
  if (driver !== null && (typeof driver === 'object' || typeof driver === 'function')
    && IS_PROXY(driver)) {
    fail('proxy_denied', path, `${path} is a live or revoked Proxy.`);
  }
  if (driver === null || typeof driver !== 'object' || capturedIsArray(driver)) {
    fail('invalid_type', path, `${path} must be a concrete driver object.`);
  }
  const store = TEMPLATE_STORES.get(driver);
  if (store === undefined) {
    fail('stale_identity_denied', path, 'No frozen template binding exists for this driver object.');
  }
  return freezeData({
    schema: FUTURE_HARNESS_TEMPLATE_SCHEMA_ID,
    version: FUTURE_HARNESS_TEMPLATE_VERSION,
    identity: store.identity,
    declaration: store.declaration,
    state: store.state,
  });
}

export function describeFutureHarnessDriverTemplateV1() {
  const contract = describeProviderDriverContractV1();
  return capturedFreeze({
    schema: FUTURE_HARNESS_TEMPLATE_SCHEMA_ID,
    version: FUTURE_HARNESS_TEMPLATE_VERSION,
    driver_schema: PROVIDER_DRIVER_SCHEMA_ID,
    driver_version: PROVIDER_DRIVER_VERSION,
    declaration_schema: DRIVER_DECLARATION_SCHEMA_ID,
    operations: capturedFreeze([...DRIVER_OPERATIONS]),
    features: DRIVER_FEATURE_VALUES,
    fail_closed_features: FUTURE_HARNESS_FAIL_CLOSED_FEATURES,
    identity_keys: FUTURE_HARNESS_IDENTITY_KEYS,
    relaunch_operations: capturedFreeze([]),
    transports: capturedFreeze([]),
    live_transport_qualification: false,
    inert: true,
    contract_schema: contract.schema,
  });
}

capturedFreeze(validateFutureHarnessIdentityV1);
capturedFreeze(createFutureHarnessDriverTemplateV1);
capturedFreeze(bindFutureHarnessDriverTemplateV1);
capturedFreeze(inspectFutureHarnessTemplateBindingV1);
capturedFreeze(describeFutureHarnessDriverTemplateV1);
