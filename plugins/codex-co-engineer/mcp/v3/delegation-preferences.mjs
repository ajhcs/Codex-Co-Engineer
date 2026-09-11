// DelegationPreferencesV1 — explicit reusable provider ownership for simple
// run_request assignments. Preferences fill omitted provider/model fields by
// role. Exact assignment selections win. Unknown providers never substitute.

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedOwnKeys,
  isKnownProvider,
  isKnownRole,
  isModelId,
  knownProvidersJoined,
} from './grammar.mjs';
import { RunContractV1Error } from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  freezeData,
  ownDataValue,
} from './selection-json.mjs';

export const DELEGATION_PREFERENCES_SCHEMA_ID = 'codex-co-engineer.delegation-preferences.v1';
export const DELEGATION_PREFERENCES_VERSION = 1;
export const DELEGATION_PREFERENCE_ROLES = capturedFreeze(['implement', 'review', 'verify']);
export const DELEGATION_PREFERENCE_ENTRY_KEYS = capturedFreeze(['provider', 'model']);

function preferenceError(code, field, message) {
  throw new RunContractV1Error(code, field, message);
}

function emptyPreferences() {
  return freezeData({
    schema: DELEGATION_PREFERENCES_SCHEMA_ID,
    version: DELEGATION_PREFERENCES_VERSION,
    by_role: {},
    attention: null,
  });
}

function parseEntry(value, field) {
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, 'preference');
  assertDirectJsonClosure(value, field);
  for (const key of capturedOwnKeys(value)) {
    if (typeof key !== 'string') preferenceError('symbol_key_denied', field);
    if (!capturedIncludes(DELEGATION_PREFERENCE_ENTRY_KEYS, key)) {
      preferenceError('unknown_key', `${field}.${key}`, 'Preference entries accept only provider and optional model.');
    }
  }
  if (!capturedHasOwn(value, 'provider')) {
    preferenceError('missing_key', `${field}.provider`, 'A reusable preference must name an exact provider.');
  }
  const provider = ownDataValue(value, 'provider', `${field}.provider`);
  if (typeof provider !== 'string') {
    preferenceError('invalid_type', `${field}.provider`, 'provider must be a string.');
  }
  const known = isKnownProvider(provider);
  let model;
  if (capturedHasOwn(value, 'model')) {
    model = ownDataValue(value, 'model', `${field}.model`);
    if (typeof model !== 'string' || !isModelId(model)) {
      preferenceError('invalid_model', `${field}.model`, 'The preferred model is not in the provider model grammar.');
    }
  }
  return freezeData({
    provider,
    ...(model !== undefined ? { model } : {}),
    known,
  });
}

/**
 * Parse optional run_request.preferences. Omitted preferences preserve the
 * legacy explicit-provider path. Invalid shapes fail closed.
 */
export function parseDelegationPreferencesV1(value, field = 'run_request.preferences') {
  if (value === undefined) return emptyPreferences();
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, 'preferences');
  assertDirectJsonClosure(value, field);
  const byRole = {};
  for (const key of capturedOwnKeys(value)) {
    if (typeof key !== 'string') preferenceError('symbol_key_denied', field);
    if (!capturedIncludes(DELEGATION_PREFERENCE_ROLES, key) || !isKnownRole(key)) {
      preferenceError('unknown_key', `${field}.${key}`, 'Preferences are keyed by implement, review, or verify.');
    }
    byRole[key] = parseEntry(ownDataValue(value, key, `${field}.${key}`), `${field}.${key}`);
  }
  return freezeData({
    schema: DELEGATION_PREFERENCES_SCHEMA_ID,
    version: DELEGATION_PREFERENCES_VERSION,
    by_role: freezeData(byRole),
    attention: null,
  });
}

/**
 * Resolve one assignment's provider/model. Explicit assignment fields win.
 * Unknown preferred providers never become a different slot. Model may be
 * omitted; the run-request compiler applies the closed provider default.
 */
export function resolveAssignmentPreferenceV1(assignment, preferences, field) {
  const role = assignment?.role;
  const requestedProvider = assignment?.provider;
  const requestedModel = assignment?.model;
  const preference = role && preferences?.by_role && capturedHasOwn(preferences.by_role, role)
    ? preferences.by_role[role]
    : undefined;

  if (requestedProvider !== undefined) {
    if (typeof requestedProvider !== 'string' || !isKnownProvider(requestedProvider)) {
      preferenceError('unknown_provider', `${field}.provider`, `provider must be one of ${knownProvidersJoined()}.`);
    }
    const model = requestedModel !== undefined
      ? requestedModel
      : (preference && preference.known === true && preference.provider === requestedProvider
        ? preference.model
        : undefined);
    return freezeData({
      provider: requestedProvider,
      ...(model !== undefined ? { model } : {}),
      source: 'explicit',
    });
  }

  if (preference === undefined) {
    preferenceError('missing_key', `${field}.provider`, 'provider is required unless a reusable role preference fills it.');
  }
  if (preference.known !== true) {
    preferenceError(
      'preferred_provider_unavailable',
      `${field}.provider`,
      'The preferred provider is unknown or unavailable; supply an explicit four-slot provider instead of substituting.',
    );
  }
  const model = requestedModel !== undefined ? requestedModel : preference.model;
  return freezeData({
    provider: preference.provider,
    ...(model !== undefined ? { model } : {}),
    source: 'preference',
  });
}

/**
 * Inspect a simple run_request for reusable preferences without compiling Git
 * identity. Used by the adapter to surface honest attention before dispatch.
 */
export function inspectDelegationPreferencesV1(request, field = 'run_request') {
  assertNotProxy(request, field);
  assertPlainObject(request, 'invalid_type', field, 'run_request');
  const raw = capturedHasOwn(request, 'preferences')
    ? ownDataValue(request, 'preferences', `${field}.preferences`)
    : undefined;
  const preferences = parseDelegationPreferencesV1(raw, `${field}.preferences`);
  const assignments = capturedHasOwn(request, 'assignments')
    ? ownDataValue(request, 'assignments', `${field}.assignments`)
    : undefined;
  const resolved = [];
  const usedUnknown = [];
  if (Array.isArray(assignments)) {
    for (let index = 0; index < assignments.length; index += 1) {
      const assignmentField = `${field}.assignments[${index}]`;
      const assignment = assignments[index];
      if (!assignment || typeof assignment !== 'object') continue;
      const role = capturedHasOwn(assignment, 'role')
        ? ownDataValue(assignment, 'role', `${assignmentField}.role`)
        : undefined;
      const provider = capturedHasOwn(assignment, 'provider')
        ? ownDataValue(assignment, 'provider', `${assignmentField}.provider`)
        : undefined;
      const model = capturedHasOwn(assignment, 'model')
        ? ownDataValue(assignment, 'model', `${assignmentField}.model`)
        : undefined;
      const preference = role && preferences.by_role && capturedHasOwn(preferences.by_role, role)
        ? preferences.by_role[role]
        : undefined;
      if (provider === undefined && preference && preference.known !== true) {
        usedUnknown.push(freezeData({
          role,
          provider: preference.provider,
          code: 'preferred_provider_unavailable',
        }));
        continue;
      }
      resolved.push(resolveAssignmentPreferenceV1(
        { role, provider, model },
        preferences,
        assignmentField,
      ));
    }
  }
  const attention = usedUnknown.length === 0 ? null : freezeData({
    status: 'blocked',
    code: 'preferred_provider_unavailable',
    next_action: 'supply_explicit_provider',
    items: usedUnknown,
  });
  return freezeData({
    preferences: freezeData({
      ...preferences,
      attention,
    }),
    attention,
    resolved,
  });
}

capturedFreeze(parseDelegationPreferencesV1);
capturedFreeze(resolveAssignmentPreferenceV1);
capturedFreeze(inspectDelegationPreferencesV1);
