// RunOrchestrationV1 — run dispatch orchestration boundary (P31).
//
// Additive v3 module. It binds accepted P26 preflight to accepted P29 closed
// credential/environment projection BEFORE any workspace, branch or ref,
// reservation, dispatch, credential handoff, or provider process exists.
//
// Fail-closed pipeline:
//   1. hostile-input quarantine of the orchestration request;
//   2. accepted P26 `validateRunPreflightV1()` — capacity denial and every
//      other preflight failure rethrow unchanged with zero side effects:
//      no environment projection, no credential-file read, no handoff, no
//      dispatcher call, no workspace, no reservation, no provider process;
//   3. only after a ready preflight, P29 closed projection per resolved
//      lane (`materializeProviderEnvironment`) plus isolation and
//      remote-mutation denial;
//   4. prepare returns that binding and still creates no handoff and no
//      process; dispatch is an explicit later intent through an injected
//      seam, never a hidden default and never supervisor cutover;
//   5. dispatch creates owner-only P29 handoffs (secrets never in argv),
//      invokes the injected dispatcher with the closed map, and on
//      failure/cancel/terminal/restart unlinks remaining handoff files
//      via the process identity P29 already owns.
//
// This boundary never provisions a workspace, never creates a branch or
// ref, never holds a reservation, never audits live refs (P30), never
// exposes a public API, and never claims Gate A. P23 composition is not
// invoked. Upstream P26/P29 denial codes pass through unchanged.

import { createHash } from 'node:crypto';

import {
  CREDENTIAL_BOUNDARY_ERROR_CODES,
  CREDENTIAL_BOUNDARY_SCHEMA_ID,
  CREDENTIAL_FILE_ENV_KEYS,
  CredentialBoundaryError,
  DSH_OX_MODEL,
  assertNoWorkerPushUrl,
  collectLaneSecrets,
  createCredentialHandoff,
  denyWorkerRemoteMutation,
  extractCredentialEnv,
  inspectArgvForSecrets,
  inspectEnvForSecrets,
  materializeProviderEnvironment,
  recoverCredentialHandoffByIdentity,
} from './credential-boundary.mjs';
import { capturedFreeze, capturedIncludes, capturedOwnKeys } from './grammar.mjs';
import {
  RUN_PREFLIGHT_ERROR_CODES,
  RUN_PREFLIGHT_SCHEMA_ID,
  RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
  validateRunPreflightV1,
} from './run-preflight.mjs';
import { RunContractV1Error, isPlainObject } from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

export const RUN_ORCHESTRATION_SCHEMA_ID = 'codex-co-engineer.run-orchestration.v1';
export const RUN_ORCHESTRATION_VERSION = 1;

export const ORCHESTRATION_INTENTS = capturedFreeze(['prepare', 'dispatch']);
export const ORCHESTRATION_REQUEST_ALLOWED_KEYS = capturedFreeze(['manifest', 'intent']);
export const ORCHESTRATION_OPTIONS_ALLOWED_KEYS = capturedFreeze([
  'host', 'spawn', 'env', 'dispatch',
]);

export const RUN_ORCHESTRATION_CHECKS = capturedFreeze([
  'request_quarantine',
  'preflight',
  'capacity',
  'closed_environment_projection',
  'provider_isolation',
  'remote_mutation_denied',
  'credential_handoff_deferred_until_dispatch',
  'cleanup_on_failure_cancel_terminal_restart',
]);

export const RUN_ORCHESTRATION_SIDE_EFFECTS = capturedFreeze([
  'workspace_created',
  'branch_or_ref_created',
  'reservation_held',
  'task_dispatched',
  'credentials_projected',
  'credential_handoff_created',
  'provider_process_started',
  'remote_mutated',
  'protected_ref_audited',
  'public_api_exposed',
]);

export const RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS = capturedFreeze([
  'workspace_created',
  'branch_or_ref_created',
  'reservation_held',
  'remote_mutated',
  'protected_ref_audited',
  'public_api_exposed',
]);

export const RUN_ORCHESTRATION_ERROR_CODES = capturedFreeze([
  'orchestration_intent_invalid',
  'orchestration_dispatcher_required',
  'orchestration_selection_unresolved',
  'orchestration_dispatch_failed',
  'orchestration_session_unknown',
  'orchestration_lane_isolation_failed',
  'orchestration_argv_secret_denied',
]);

const PRIVATE_RECEIPT_KEYS = capturedFreeze([
  'schema', 'version', 'status', 'run_id', 'intent', 'preflight', 'lanes',
  'checks', 'side_effects',
]);
const PRIVATE_LANE_KEYS = capturedFreeze([
  'assignment_id', 'provider', 'model', 'status', 'identity',
  'projected_keys', 'credential_present',
]);
const PRIVATE_CROSS_PROVIDER_SECRET_KEYS = capturedFreeze([
  'CURSOR_API_KEY', 'MODEL_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY',
]);
const PRIVATE_ALWAYS_FORBIDDEN_KEYS = capturedFreeze([
  'BITBUCKET_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GIT_SSH',
  'GIT_SSH_COMMAND', 'NODE_OPTIONS', 'NODE_PATH', 'SSH_AGENT_PID',
  'SSH_AUTH_SOCK', 'WORKTREE_BOOTSTRAP_TASK',
  ...CREDENTIAL_FILE_ENV_KEYS,
]);
const PRIVATE_CONTENT_FREE = capturedFreeze({
  orchestration_intent_invalid: 'The orchestration intent is not in the closed vocabulary.',
  orchestration_dispatcher_required: 'Dispatch requires an injected dispatcher seam.',
  orchestration_selection_unresolved: 'Dispatch requires every lane to carry an exact provider.',
  orchestration_dispatch_failed: 'Provider dispatch failed closed.',
  orchestration_session_unknown: 'The orchestration session is not available.',
  orchestration_lane_isolation_failed: 'A lane projection violated provider isolation.',
  orchestration_argv_secret_denied: 'Provider argv cannot carry credential material.',
});

const PRIVATE_SESSIONS = new WeakMap();

function failOrchestration(code, errorPath) {
  fail(code, errorPath, PRIVATE_CONTENT_FREE[code] ?? 'The orchestration request failed closed.');
}

function sortedOwnKeys(value) {
  const keys = capturedOwnKeys(value);
  const sorted = [...keys];
  sorted.sort();
  return sorted;
}

function assertClosedKeySet(value, allowedKeys, errorPath) {
  for (const key of sortedOwnKeys(value)) {
    if (!capturedIncludes(allowedKeys, key)) {
      fail('invalid_format', `${errorPath}.${key}`,
        `${errorPath} carries a key outside the closed orchestration vocabulary.`);
    }
  }
}

function emptySideEffects() {
  const sideEffects = {};
  for (const claim of RUN_ORCHESTRATION_SIDE_EFFECTS) sideEffects[claim] = false;
  return sideEffects;
}

function laneIdentity(runId, assignmentId) {
  return createHash('sha256')
    .update(`p31:${runId}:${assignmentId}`)
    .digest('hex')
    .slice(0, 32);
}

function parseIntent(request) {
  if (!hasOwn(request, 'intent')) return 'prepare';
  const intent = ownDataValue(request, 'intent', 'request.intent');
  if (typeof intent !== 'string' || !capturedIncludes(ORCHESTRATION_INTENTS, intent)) {
    failOrchestration('orchestration_intent_invalid', 'request.intent');
  }
  return intent;
}

function parseRequest(request) {
  if (request === undefined || request === null) {
    fail('invalid_type', 'request', 'An orchestration request must be a plain JSON data object.');
  }
  assertNotProxy(request, 'request');
  if (!isPlainObject(request)) {
    fail('invalid_type', 'request', 'An orchestration request must be a plain JSON data object.');
  }
  assertDirectJsonClosure(request, 'request');
  freezeData(request);
  assertClosedKeySet(request, ORCHESTRATION_REQUEST_ALLOWED_KEYS, 'request');
  if (!hasOwn(request, 'manifest')) {
    fail('missing_key', 'request.manifest',
      'request.manifest is required; orchestration requests have no hidden defaults.');
  }
  const manifest = ownDataValue(request, 'manifest', 'request.manifest');
  const intent = parseIntent(request);
  return capturedFreeze({ manifest, intent });
}

function parseOptions(options) {
  if (options === undefined) {
    return {
      host: null,
      spawn: undefined,
      dispatch: null,
      envOwner: null,
    };
  }
  assertNotProxy(options, 'options');
  if (!isPlainObject(options)) {
    fail('invalid_type', 'options', 'options must be a plain JSON data object.');
  }
  assertClosedKeySet(options, ORCHESTRATION_OPTIONS_ALLOWED_KEYS, 'options');
  let spawn;
  if (hasOwn(options, 'spawn')) {
    spawn = ownDataValue(options, 'spawn', 'options.spawn');
    if (typeof spawn !== 'function') {
      fail('invalid_type', 'options.spawn', 'options.spawn must be a spawn function.');
    }
    assertNotProxy(spawn, 'options.spawn');
  }
  let dispatch = null;
  if (hasOwn(options, 'dispatch')) {
    dispatch = ownDataValue(options, 'dispatch', 'options.dispatch');
    if (typeof dispatch !== 'function') {
      fail('invalid_type', 'options.dispatch', 'options.dispatch must be a function.');
    }
    assertNotProxy(dispatch, 'options.dispatch');
  }
  let host = null;
  if (hasOwn(options, 'host')) {
    host = ownDataValue(options, 'host', 'options.host');
  }
  return {
    host,
    spawn,
    dispatch,
    envOwner: hasOwn(options, 'env') ? options : null,
  };
}

function preflightOptionsFrom(parsed) {
  const options = {};
  if (parsed.host !== null) options.host = parsed.host;
  if (parsed.spawn !== undefined) options.spawn = parsed.spawn;
  return options;
}

function takeEnvAfterPreflight(parsed) {
  if (parsed.envOwner === null) return process.env;
  return ownDataValue(parsed.envOwner, 'env', 'options.env');
}

function allowedCredentialKey(provider, dshModel) {
  if (provider === 'grok') return 'XAI_API_KEY';
  if (provider === 'cursor-cloud') return 'CURSOR_API_KEY';
  if (provider === 'dsh' && dshModel === DSH_OX_MODEL) return 'OPENROUTER_API_KEY';
  if (provider === 'dsh') return 'MODEL_API_KEY';
  return null;
}

function assertLaneIsolation(env, provider, dshModel) {
  for (const key of PRIVATE_ALWAYS_FORBIDDEN_KEYS) {
    if (Object.hasOwn(env, key)) failOrchestration('orchestration_lane_isolation_failed', 'lanes');
  }
  const allowed = allowedCredentialKey(provider, dshModel);
  for (const key of PRIVATE_CROSS_PROVIDER_SECRET_KEYS) {
    if (key === allowed) continue;
    if (Object.hasOwn(env, key)) failOrchestration('orchestration_lane_isolation_failed', 'lanes');
  }
  if (env.GIT_TERMINAL_PROMPT !== '0' || env.GIT_ASKPASS !== '' || env.GIT_PUSH_OPTION_COUNT !== '0') {
    failOrchestration('orchestration_lane_isolation_failed', 'lanes');
  }
  assertNoWorkerPushUrl(env);
}

function foreignSecrets(envSource, provider, dshModel) {
  const allowed = allowedCredentialKey(provider, dshModel);
  const secrets = [];
  const extracted = extractCredentialEnv(envSource);
  for (const key of PRIVATE_CROSS_PROVIDER_SECRET_KEYS) {
    if (key === allowed) continue;
    if (typeof extracted[key] === 'string' && extracted[key].length > 0) secrets.push(extracted[key]);
  }
  const ambient = collectLaneSecrets(envSource);
  for (const value of ambient) {
    if (allowed && extracted[allowed] === value) continue;
    if (!secrets.includes(value)) secrets.push(value);
  }
  return secrets;
}

function resolveLaneExecution(assignment) {
  const execution = assignment?.execution;
  if (!execution || typeof execution !== 'object') {
    return { provider: null, model: null, dshModel: undefined, resolved: false };
  }
  if (typeof execution.profile === 'string' && execution.profile.length > 0) {
    return { provider: null, model: null, dshModel: undefined, resolved: false };
  }
  if (typeof execution.provider !== 'string' || typeof execution.model !== 'string') {
    return { provider: null, model: null, dshModel: undefined, resolved: false };
  }
  const dshModel = execution.provider === 'dsh' ? execution.model : undefined;
  return {
    provider: execution.provider,
    model: execution.model,
    dshModel,
    resolved: true,
  };
}

async function projectManifestLanes(runId, assignments, envSource) {
  const publicLanes = [];
  const internal = [];
  for (const assignment of assignments) {
    const assignmentId = assignment.assignment_id;
    const identity = laneIdentity(runId, assignmentId);
    const resolved = resolveLaneExecution(assignment);
    if (!resolved.resolved) {
      const lane = capturedFreeze({
        assignment_id: assignmentId,
        provider: null,
        model: null,
        status: 'selection_unresolved',
        identity,
        projected_keys: capturedFreeze([]),
        credential_present: false,
      });
      publicLanes.push(lane);
      internal.push({
        assignmentId, identity, unresolved: true, env: null, secrets: [], argv: capturedFreeze([assignmentId]),
      });
      continue;
    }
    const env = await materializeProviderEnvironment({
      provider: resolved.provider,
      source: envSource,
      dshModel: resolved.dshModel,
      operation: 'lane',
    });
    assertLaneIsolation(env, resolved.provider, resolved.dshModel);
    if (inspectEnvForSecrets(env, foreignSecrets(envSource, resolved.provider, resolved.dshModel))) {
      failOrchestration('orchestration_lane_isolation_failed', 'lanes');
    }
    const projectedKeys = Object.keys(env).sort();
    const credentialPresent = Object.keys(extractCredentialEnv(env)).length > 0;
    const argv = capturedFreeze([assignmentId]);
    const secrets = collectLaneSecrets(env);
    if (inspectArgvForSecrets(argv, secrets) || inspectArgvForSecrets(argv, collectLaneSecrets(envSource))) {
      failOrchestration('orchestration_argv_secret_denied', 'lanes');
    }
    const lane = capturedFreeze({
      assignment_id: assignmentId,
      provider: resolved.provider,
      model: resolved.model,
      status: 'projected',
      identity,
      projected_keys: capturedFreeze(projectedKeys),
      credential_present: credentialPresent,
    });
    publicLanes.push(lane);
    internal.push({
      assignmentId,
      identity,
      unresolved: false,
      provider: resolved.provider,
      model: resolved.model,
      dshModel: resolved.dshModel,
      env,
      secrets,
      argv,
    });
  }
  return { publicLanes, internal };
}

function buildReceipt({
  status, runId, intent, preflight, lanes, sideEffects,
}) {
  const receipt = capturedFreeze({
    schema: RUN_ORCHESTRATION_SCHEMA_ID,
    version: RUN_ORCHESTRATION_VERSION,
    status,
    run_id: runId,
    intent,
    preflight,
    lanes: capturedFreeze(lanes),
    checks: RUN_ORCHESTRATION_CHECKS,
    side_effects: capturedFreeze(sideEffects),
  });
  for (const key of PRIVATE_RECEIPT_KEYS) {
    if (!Object.hasOwn(receipt, key)) fail('invalid_format', 'receipt', 'Orchestration receipt is incomplete.');
  }
  for (const lane of lanes) {
    for (const key of PRIVATE_LANE_KEYS) {
      if (!Object.hasOwn(lane, key)) fail('invalid_format', 'lanes', 'Orchestration lane receipt is incomplete.');
    }
  }
  for (const claim of RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS) {
    if (receipt.side_effects[claim] !== false) {
      fail('invalid_format', 'side_effects', 'Orchestration claimed a denied side effect.');
    }
  }
  return freezeData(receipt);
}

async function cleanupIdentities(identities) {
  for (const identity of identities) {
    try {
      await recoverCredentialHandoffByIdentity(identity);
    } catch {
      // Best-effort cleanup must stay content-free and non-throwing.
    }
  }
}

async function stopDispatchers(stops) {
  for (const stop of stops) {
    if (typeof stop !== 'function') continue;
    try {
      await stop();
    } catch {
      // Stop failures must not resurrect secrets or skip remaining cleanup.
    }
  }
}

async function cleanupSession(session) {
  if (!session) return { cleaned: true, missing: true };
  session.cleaned = true;
  await stopDispatchers(session.stops);
  await cleanupIdentities(session.identities);
  session.stops = [];
  return { cleaned: true, missing: false };
}

async function createLaneHandoff(lane) {
  const secrets = extractCredentialEnv(lane.env);
  if (Object.keys(secrets).length === 0) return null;
  return createCredentialHandoff(secrets, { identity: lane.identity });
}

async function dispatchLanes(internal, parsed, sideEffects) {
  if (typeof parsed.dispatch !== 'function') {
    failOrchestration('orchestration_dispatcher_required', 'options.dispatch');
  }
  for (const lane of internal) {
    if (lane.unresolved) failOrchestration('orchestration_selection_unresolved', 'lanes');
  }
  const identities = internal.map((lane) => lane.identity);
  const stops = [];
  const session = { identities, stops, internal, parsed, cleaned: false };
  try {
    for (const lane of internal) {
      if (inspectArgvForSecrets(lane.argv, lane.secrets)
        || inspectArgvForSecrets(lane.argv, collectLaneSecrets(lane.env))) {
        failOrchestration('orchestration_argv_secret_denied', 'dispatch');
      }
      const handoff = await createLaneHandoff(lane);
      if (handoff) sideEffects.credential_handoff_created = true;
      const result = await parsed.dispatch(capturedFreeze({
        assignment_id: lane.assignmentId,
        provider: lane.provider,
        model: lane.model,
        env: lane.env,
        argv: lane.argv,
        identity: lane.identity,
      }));
      sideEffects.task_dispatched = true;
      sideEffects.provider_process_started = true;
      if (result && typeof result.stop === 'function') stops.push(result.stop);
    }
  } catch (error) {
    await cleanupSession(session);
    if (error instanceof RunContractV1Error || error instanceof CredentialBoundaryError) throw error;
    failOrchestration('orchestration_dispatch_failed', 'dispatch');
  }
  return session;
}

export async function orchestrateRunDispatchV1(request, options) {
  const parsedRequest = parseRequest(request);
  const parsedOptions = parseOptions(options);
  const sideEffects = emptySideEffects();
  const preflight = await validateRunPreflightV1(
    { manifest: parsedRequest.manifest },
    preflightOptionsFrom(parsedOptions),
  );
  const envSource = takeEnvAfterPreflight(parsedOptions);
  const projected = await projectManifestLanes(
    preflight.run_id,
    parsedRequest.manifest.assignments,
    envSource,
  );
  sideEffects.credentials_projected = projected.internal.some((lane) => !lane.unresolved);
  let session = null;
  let status = 'prepared';
  if (parsedRequest.intent === 'dispatch') {
    session = await dispatchLanes(projected.internal, parsedOptions, sideEffects);
  }
  if (parsedRequest.intent === 'dispatch') status = 'dispatched';
  const receipt = buildReceipt({
    status,
    runId: preflight.run_id,
    intent: parsedRequest.intent,
    preflight,
    lanes: projected.publicLanes,
    sideEffects,
  });
  PRIVATE_SESSIONS.set(receipt, {
    identities: projected.internal.map((lane) => lane.identity),
    stops: session?.stops ?? [],
    internal: projected.internal,
    parsed: parsedOptions,
    cleaned: false,
  });
  return receipt;
}

function requireSession(receipt) {
  assertNotProxy(receipt, 'receipt');
  if (!isPlainObject(receipt) && typeof receipt !== 'object') {
    failOrchestration('orchestration_session_unknown', 'receipt');
  }
  const session = PRIVATE_SESSIONS.get(receipt);
  if (!session) failOrchestration('orchestration_session_unknown', 'receipt');
  return session;
}

function identitiesFromReceipt(receipt) {
  const lanes = receipt?.lanes;
  if (!Array.isArray(lanes)) return [];
  const identities = [];
  for (const lane of lanes) {
    if (lane && typeof lane.identity === 'string') identities.push(lane.identity);
  }
  return identities;
}

export async function cancelRunDispatchV1(receipt) {
  let session = null;
  try {
    session = requireSession(receipt);
  } catch (error) {
    await cleanupIdentities(identitiesFromReceipt(receipt));
    if (error instanceof RunContractV1Error && error.code === 'orchestration_session_unknown') {
      return freezeData({ status: 'cancelled', cleaned: true, missing: true });
    }
    throw error;
  }
  await cleanupSession(session);
  return freezeData({ status: 'cancelled', cleaned: true, missing: false });
}

export async function completeRunDispatchV1(receipt) {
  const session = requireSession(receipt);
  await cleanupSession(session);
  return freezeData({ status: 'terminal', cleaned: true, missing: false });
}

export async function restartRunDispatchV1(receipt, options) {
  const session = requireSession(receipt);
  await stopDispatchers(session.stops);
  session.stops = [];
  await cleanupIdentities(session.identities);
  const parsed = parseOptions(options);
  const dispatch = parsed.dispatch ?? session.parsed.dispatch;
  if (typeof dispatch !== 'function') {
    failOrchestration('orchestration_dispatcher_required', 'options.dispatch');
  }
  const restartOptions = {
    ...session.parsed,
    dispatch,
  };
  const sideEffects = emptySideEffects();
  sideEffects.credentials_projected = true;
  const next = await dispatchLanes(session.internal, restartOptions, sideEffects);
  session.stops = next.stops;
  session.parsed = restartOptions;
  session.cleaned = false;
  return freezeData({
    status: 'dispatched',
    cleaned: false,
    restarted: true,
    side_effects: capturedFreeze(sideEffects),
  });
}

export function denyRunRemoteMutationV1(operation) {
  return denyWorkerRemoteMutation(operation);
}

export function describeRunOrchestrationV1() {
  const inventory = capturedFreeze({
    schema: RUN_ORCHESTRATION_SCHEMA_ID,
    version: RUN_ORCHESTRATION_VERSION,
    rule: 'preflight_then_closed_projection_before_any_launch_side_effect',
    intents: ORCHESTRATION_INTENTS,
    checks: RUN_ORCHESTRATION_CHECKS,
    error_codes: RUN_ORCHESTRATION_ERROR_CODES,
    side_effects: RUN_ORCHESTRATION_SIDE_EFFECTS,
    always_false_side_effects: RUN_ORCHESTRATION_ALWAYS_FALSE_SIDE_EFFECTS,
    composed_surfaces: capturedFreeze({
      preflight: RUN_PREFLIGHT_SCHEMA_ID,
      credential_boundary: CREDENTIAL_BOUNDARY_SCHEMA_ID,
      credential_error_codes: CREDENTIAL_BOUNDARY_ERROR_CODES,
      preflight_error_codes: RUN_PREFLIGHT_ERROR_CODES,
      preflight_nonclaims: RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
      provider_registry: 'P23 registry owns composition; not invoked here',
      protected_ref_audit: 'P30 live-ref audit is not invoked here',
      supervisor_server: 'no cutover; dispatch is an injected seam',
      public_api: 'not exposed',
      gate_a: 'not claimed',
    }),
  });
  return freezeData(inventory);
}

capturedFreeze(orchestrateRunDispatchV1);
capturedFreeze(cancelRunDispatchV1);
capturedFreeze(completeRunDispatchV1);
capturedFreeze(restartRunDispatchV1);
capturedFreeze(denyRunRemoteMutationV1);
capturedFreeze(describeRunOrchestrationV1);
