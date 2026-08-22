// Deterministic run resolver (ADR 0001 identifiers
// `deterministic_explicit_or_profile_resolution`, `profiles_data_only`,
// `no_post_dispatch_fallback_or_replay`, `run_cloud_lane_requires_pinned_starting_ref`).
//
// Additive v3 module for P05. It resolves every assignment's provider/model
// choice from validated explicit manifest data and validated ProfileV1 data
// only. There is no ranking, scoring, learning, cost model, hidden default,
// fallback, replay, or provider substitution: when the authored sources do
// not determine exactly one usable choice, the lane stays unresolved.
//
// Authored precedence, evaluated per assignment:
//   1. explicit assignment execution.provider + execution.model;
//   2. the assignment-level named profile only (provider field, then that
//      profile's authored `pre_dispatch_provider_preference` first entry).
//      A missing name or a profile that supplies no provider stops here;
//   3. for a truly omitted execution only, the run-level `manifest.profile`;
//   4. for a still-omitted execution, the single catalog record whose
//      `default: true` flag is set (a profile named "default" has no
//      authority by name);
//   5. otherwise the lane is unresolved and appears in SelectionRequestV1.
//
// A provider entry without a declared `models` list (absent or null) declares
// NO membership information — for every provider alike, DSH included.
// Availability and complete P17 capability snapshot digests bind the
// SelectionRequestV1 identity. Persistence belongs to P27; this module is
// pure. Answer re-resolution clones the caller manifest, replaces only
// answered execution objects, and leaves the original manifest and snapshots
// unchanged.

import { validateResolvedStartingRefV1 } from './assignment-manifest.mjs';
import { normalizeProviderCapabilitySnapshotV1 } from './capability-bridge.mjs';
import {
  capturedFreeze,
  capturedIncludes,
  capturedIsArray,
  capturedJoin,
  capturedTest,
  isKnownProvider,
  isModelId,
  isProfileName,
  knownProvidersJoined,
  sortedCapturedKeys,
} from './grammar.mjs';
import { IDENTITY_LABELS } from './identity.mjs';
import {
  findProfile,
  profileProvenanceDigest,
  validateProfileDefinition,
} from './profile.mjs';
import {
  MAX_ASSIGNMENTS,
  PROVIDERS,
  assertDenseJsonArray,
  isAssignmentId,
  utf8ByteLength,
} from './run-manifest.mjs';
import { parseRunManifestV1 } from './run-policy.mjs';
import {
  REQUEST_ID_HEX_LENGTH,
  REQUEST_ID_PATTERN,
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  canonicalSelectionJson,
  deriveRequestId,
  fail,
  freezeData,
  hasOwn,
  identityBoundDigest,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';

export {
  REQUEST_ID_HEX_LENGTH,
  REQUEST_ID_PATTERN,
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  canonicalSelectionJson,
};
export {
  CAPABILITY_ARTIFACT_KINDS,
  CAPABILITY_RECORD_ALLOWED_KEYS,
  CAPABILITY_REVISION_MAX_BYTES,
  CAPABILITY_REVISION_PATTERN,
  CAPABILITY_SNAPSHOT_ALLOWED_KEYS,
  CAPABILITY_SOURCE_DIGEST_PATTERN,
  CREATE_PR_POSTURES,
  DISPATCH_CERTAINTY_VALUES,
  EXACT_MODEL_SELECTION_POSTURES,
  MAX_CAPABILITY_ARTIFACT_KINDS,
  MAX_CAPABILITY_NOTES_BYTES,
  MERGE_AUTHORITIES,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
  REPLAY_POSTURES,
  REQUIRED_CAPABILITY_ARTIFACT_KIND,
  SAME_SESSION_REPLY_POSTURES,
  WORKSPACE_SEMANTICS_VALUES,
  WORKSPACE_STARTING_POINTS,
  normalizeProviderCapabilitySnapshotV1,
  projectCapabilityRecordFromP17,
} from './capability-bridge.mjs';

export const RESOLVED_RUN_SCHEMA_ID = 'codex-co-engineer.resolved-run.v1';
export const SELECTION_REQUEST_SCHEMA_ID = 'codex-co-engineer.selection-request.v1';
export const ANSWERED_RUN_SCHEMA_ID = 'codex-co-engineer.answered-run.v1';
export const PROVIDER_AVAILABILITY_SCHEMA_ID = 'codex-co-engineer.provider-availability.v1';
export const RUN_REPOSITORY_EXPOSURE = 'selected_external_provider_full_repository';

export const RESOLVED_REASONS = capturedFreeze([
  'explicit_assignment',
  'assignment_profile',
  'assignment_profile_preference',
  'run_profile',
  'run_profile_preference',
  'default_profile',
  'default_profile_preference',
]);
export const UNRESOLVED_REASONS = capturedFreeze([
  'profile_not_found',
  'run_profile_not_found',
  'provider_missing',
  'provider_unsupported',
  'provider_unavailable',
  'model_ambiguous',
  'model_unavailable',
]);
export const RESOLUTION_REASONS = capturedFreeze([...RESOLVED_REASONS, ...UNRESOLVED_REASONS]);
export const REASON_CLASSES = capturedFreeze({
  profile_not_found: 'missing',
  run_profile_not_found: 'missing',
  provider_missing: 'missing',
  provider_unsupported: 'unsupported',
  provider_unavailable: 'unavailable',
  model_unavailable: 'unavailable',
  model_ambiguous: 'ambiguous',
});
export const ANSWER_SCOPES = capturedFreeze(['provider_and_model', 'model_only']);
export const PROVIDER_AVAILABILITY_STATUSES = capturedFreeze(['available', 'unavailable']);
export const MAX_AVAILABILITY_MODELS = 16;
export const MAX_SELECTION_REQUEST_BYTES = 16 * 1024;
export const MAX_SELECTION_QUESTIONS = MAX_ASSIGNMENTS;

export const SELECTION_REQUEST_ALLOWED_KEYS = capturedFreeze([
  'availability_digest', 'capability_snapshot_digest', 'choices', 'digest',
  'question_count', 'questions', 'request_id', 'run_id', 'schema',
]);
export const SELECTION_QUESTION_ALLOWED_KEYS = capturedFreeze([
  'answer_scope', 'assignment_id', 'reason', 'reason_class', 'requested',
  'selectable_providers',
]);
export const SELECTION_REQUESTED_ALLOWED_KEYS = capturedFreeze([
  'model', 'profile', 'provider', 'provider_preference', 'resolved_profile',
  'resolved_profile_digest', 'resolved_profile_scope', 'run_profile',
]);
export const SELECTION_CHOICES_ALLOWED_KEYS = capturedFreeze(['providers']);
export const SELECTION_CHOICE_ENTRY_ALLOWED_KEYS = capturedFreeze(['models', 'provider']);
export const SELECTION_ANSWER_ALLOWED_KEYS = capturedFreeze(['assignment_id', 'model', 'provider']);
export const REPLY_IDENTITY_ALLOWED_KEYS = capturedFreeze(['digest', 'request_id', 'run_id']);

const PROVIDER_BEARING_REASONS = capturedFreeze([
  'provider_unsupported', 'provider_unavailable', 'model_ambiguous', 'model_unavailable',
]);
const MODEL_ONLY_REASONS = capturedFreeze(['model_ambiguous', 'model_unavailable']);
const PROFILE_RECORD_ALLOWED_KEYS = capturedFreeze(['definition', 'digest', 'name', 'scope', 'source']);
const PROFILE_LOAD_ALLOWED_KEYS = capturedFreeze([
  'catalog_digest', 'profiles', 'roots', 'schema', 'shadowed', 'sources',
]);
const PROFILE_SCOPES = capturedFreeze(['owner', 'project']);
const RESOLVER_OPTIONS = capturedFreeze([
  'availability', 'capabilities', 'manifest', 'profiles',
]);
const SELECTION_RESOLUTION_OPTIONS = capturedFreeze([
  ...RESOLVER_OPTIONS, 'answers', 'replyIdentity', 'request',
]);

const ARRAY_PUSH = Array.prototype.push;
const SET_CTOR = Set;
const SET_ADD = SET_CTOR.prototype.add;
const SET_HAS = SET_CTOR.prototype.has;
const STRING = String;
const STRUCTURED_CLONE = structuredClone;

function normalizeAvailabilityModels(provider, models) {
  if (models === undefined || models === null) return null;
  assertNotProxy(models, `providers.${provider}.models`);
  assertDenseJsonArray(models, `providers.${provider}.models`);
  if (models.length === 0 || models.length > MAX_AVAILABILITY_MODELS) {
    fail('invalid_availability_models', `providers.${provider}.models`,
      `providers.${provider}.models must carry 1-${MAX_AVAILABILITY_MODELS} exact model identifiers.`);
  }
  const seen = new SET_CTOR();
  const normalized = [];
  for (let index = 0; index < models.length; index += 1) {
    const path = `providers.${provider}.models[${index}]`;
    const model = ownDataValue(models, STRING(index), path);
    if (!isModelId(model)) {
      fail('invalid_availability_models', path,
        `${path} must match the bounded provider model identifier grammar.`);
    }
    if (SET_HAS.call(seen, model)) {
      fail('duplicate_availability_model', path, `${path} repeats model "${model}".`);
    }
    SET_ADD.call(seen, model);
    ARRAY_PUSH.call(normalized, model);
  }
  normalized.sort();
  return normalized;
}

export function normalizeProviderAvailabilityV1(availability) {
  if (availability === undefined || availability === null) {
    fail('availability_required', '$.availability',
      'availability is required explicit caller data; resolution never invents a default provider snapshot.');
  }
  assertDirectJsonClosure(availability, '$');
  assertPlainObject(availability, 'invalid_availability', '$', 'availability');
  const keys = sortedCapturedKeys(availability);
  if (keys.length === 0) fail('missing_key', '$.providers', 'availability.providers is required.');
  for (const key of keys) {
    if (key !== 'schema' && key !== 'providers') {
      fail('unknown_availability_key', `$.${key}`, `$.${key} is not part of the closed availability vocabulary.`);
    }
  }
  if (!hasOwn(availability, 'schema')) {
    fail('missing_key', '$.schema', '$.schema is required; an inherited schema string is not availability data.');
  }
  if (optOwn(availability, 'schema') !== PROVIDER_AVAILABILITY_SCHEMA_ID) {
    fail('invalid_availability_schema', '$.schema',
      `availability.schema must be exactly "${PROVIDER_AVAILABILITY_SCHEMA_ID}".`);
  }
  if (!hasOwn(availability, 'providers')) {
    fail('missing_key', '$.providers', '$.providers is required; availability has no hidden default.');
  }
  const providers = optOwn(availability, 'providers');
  assertPlainObject(providers, 'invalid_availability', '$.providers', 'availability.providers');
  const normalized = [];
  for (const provider of sortedCapturedKeys(providers)) {
    const path = `providers.${provider}`;
    if (!isKnownProvider(provider)) {
      fail('unknown_provider', path, `${path} is not one of ${knownProvidersJoined()}.`);
    }
    const entry = optOwn(providers, provider);
    assertPlainObject(entry, 'invalid_availability', path, `${path} entry`);
    for (const key of sortedCapturedKeys(entry)) {
      if (key !== 'status' && key !== 'models') {
        fail('unknown_availability_key', `${path}.${key}`,
          `${path}.${key} is not part of the closed availability vocabulary.`);
      }
    }
    if (!hasOwn(entry, 'status')) {
      fail('missing_key', `${path}.status`,
        `${path}.status is required as an own property; availability has no hidden default.`);
    }
    const status = optOwn(entry, 'status');
    if (!capturedIncludes(PROVIDER_AVAILABILITY_STATUSES, status)) {
      fail('invalid_availability_status', `${path}.status`,
        `${path}.status must be exactly one of ${capturedJoin(PROVIDER_AVAILABILITY_STATUSES, ', ')}.`);
    }
    const models = normalizeAvailabilityModels(provider, optOwn(entry, 'models'));
    ARRAY_PUSH.call(normalized, capturedFreeze({
      models: models === null ? null : capturedFreeze(models),
      provider,
      status,
    }));
  }
  const digest = identityBoundDigest(IDENTITY_LABELS.RESOLUTION_SNAPSHOT, {
    providers: normalized,
    schema: PROVIDER_AVAILABILITY_SCHEMA_ID,
  });
  return freezeData({ digest, providers: normalized, schema: PROVIDER_AVAILABILITY_SCHEMA_ID });
}

function availabilityIndex(availability) {
  const index = new Map();
  for (const entry of availability.providers) index.set(entry.provider, entry);
  return index;
}

function capabilityIndex(capabilities) {
  const index = new Map();
  for (const entry of capabilities.providers) index.set(entry.provider, entry);
  return index;
}

function indexProfileRecords(profiles) {
  if (profiles === undefined) {
    return capturedFreeze({ byName: new Map(), defaultRecord: null });
  }
  assertDirectJsonClosure(profiles, '$.profiles');
  assertPlainObject(profiles, 'invalid_profile_load_result', '$.profiles', 'The profile load result');
  for (const key of sortedCapturedKeys(profiles)) {
    if (!capturedIncludes(PROFILE_LOAD_ALLOWED_KEYS, key)) {
      fail('unknown_profile_load_key', `$.profiles.${key}`,
        `$.profiles.${key} is not part of a profile catalog or load result.`);
    }
  }
  if (!hasOwn(profiles, 'profiles')) {
    fail('missing_key', '$.profiles.profiles', 'profiles.profiles is required as an own property.');
  }
  const list = optOwn(profiles, 'profiles');
  assertNotProxy(list, '$.profiles.profiles');
  assertDenseJsonArray(list, '$.profiles.profiles');
  const branded = hasOwn(profiles, 'catalog_digest');
  const byName = new Map();
  const defaults = [];
  for (let index = 0; index < list.length; index += 1) {
    const path = `$.profiles.profiles[${index}]`;
    const record = ownDataValue(list, STRING(index), path);
    assertPlainObject(record, 'invalid_profile_record', path, `${path} profile record`);
    for (const key of sortedCapturedKeys(record)) {
      if (!capturedIncludes(PROFILE_RECORD_ALLOWED_KEYS, key)) {
        fail('unknown_profile_record_key', `${path}.${key}`, `${path}.${key} is not part of a profile record.`);
      }
    }
    for (const required of ['definition', 'digest', 'name', 'scope']) {
      if (!hasOwn(record, required)) {
        fail('missing_key', `${path}.${required}`,
          `${path}.${required} is required as an own property; inherited fields are not profile data.`);
      }
    }
    const name = optOwn(record, 'name');
    if (!isProfileName(name)) {
      fail('invalid_profile_name', `${path}.name`, `${path}.name must be a bounded profile name.`);
    }
    if (byName.has(name)) {
      fail('duplicate_profile_record', `${path}.name`, `The profile input defines "${name}" more than once.`);
    }
    let trusted;
    if (branded) {
      trusted = findProfile(profiles, name);
      if (trusted === undefined) {
        fail('invalid_profile_record', path,
          `${path} is not reachable through the branded catalog snapshot.`);
      }
    } else {
      const scope = optOwn(record, 'scope');
      if (!capturedIncludes(PROFILE_SCOPES, scope)) {
        fail('invalid_profile_record', `${path}.scope`, `${path}.scope must be "project" or "owner".`);
      }
      let definition;
      try {
        definition = validateProfileDefinition(name, optOwn(record, 'definition'));
      } catch (error) {
        fail(error?.code ?? 'invalid_profile_record', `${path}.definition`,
          `${path}.definition is not a valid ProfileV1 definition: ${error?.message ?? 'rejected'}`);
      }
      const digest = optOwn(record, 'digest');
      if (typeof digest !== 'string' || !capturedTest(SHA256_DIGEST_PATTERN, digest)) {
        fail('invalid_profile_record', `${path}.digest`, `${path}.digest must be a sha256 provenance digest.`);
      }
      const expectedDigest = profileProvenanceDigest({ name, definition });
      if (digest !== expectedDigest) {
        fail('profile_record_digest_mismatch', `${path}.digest`,
          `${path}.digest does not match the profile definition content.`);
      }
      trusted = capturedFreeze({ name, scope, definition, digest });
    }
    byName.set(name, trusted);
    if (hasOwn(trusted.definition, 'default') && trusted.definition.default === true) {
      ARRAY_PUSH.call(defaults, trusted);
    }
  }
  if (defaults.length > 1) {
    fail('ambiguous_default_profile', '$.profiles',
      'The catalog declares more than one default:true profile; resolution never ranks defaults.');
  }
  return capturedFreeze({
    byName,
    defaultRecord: defaults.length === 1 ? defaults[0] : null,
  });
}

function profileProviderChoice(definition) {
  if (hasOwn(definition, 'provider') && typeof definition.provider === 'string') {
    return capturedFreeze({
      provider: definition.provider,
      model: hasOwn(definition, 'model') && typeof definition.model === 'string'
        ? definition.model
        : null,
      via: 'provider_field',
      preference: null,
    });
  }
  const policy = optOwn(definition, 'policy');
  const preference = policy && typeof policy === 'object' && hasOwn(policy, 'pre_dispatch_provider_preference')
    ? optOwn(policy, 'pre_dispatch_provider_preference')
    : undefined;
  assertNotProxy(preference, 'policy.pre_dispatch_provider_preference');
  if (capturedIsArray(preference) && preference.length > 0) {
    const first = ownDataValue(preference, '0', 'policy.pre_dispatch_provider_preference[0]');
    const copy = [];
    for (let index = 0; index < preference.length; index += 1) {
      ARRAY_PUSH.call(copy, ownDataValue(
        preference, STRING(index), `policy.pre_dispatch_provider_preference[${index}]`,
      ));
    }
    return capturedFreeze({
      provider: first,
      model: null,
      via: 'preference',
      preference: capturedFreeze(copy),
    });
  }
  return null;
}

function applyChoice(lane, record, choice, foundReason, preferenceReason) {
  lane.status = 'resolved';
  lane.reason = choice.via === 'preference' ? preferenceReason : foundReason;
  lane.resolved_profile = record.name;
  lane.resolved_profile_scope = record.scope;
  lane.resolved_profile_digest = record.digest;
  lane.provider_preference = choice.preference;
  lane.provider = choice.provider;
  lane.requested_model = choice.model;
  lane.provider_status = 'available';
}

function laneRecord(assignment, runProfileName) {
  const execution = hasOwn(assignment, 'execution') ? optOwn(assignment, 'execution') : undefined;
  const authoredProfile = execution !== undefined && typeof execution === 'object' && execution !== null
    && hasOwn(execution, 'profile') && typeof optOwn(execution, 'profile') === 'string'
    ? optOwn(execution, 'profile')
    : null;
  return {
    assignment_id: assignment.assignment_id,
    status: 'unresolved',
    reason: null,
    reason_class: null,
    answer_scope: null,
    authored_profile: authoredProfile,
    run_profile: runProfileName === undefined ? null : runProfileName,
    resolved_profile: null,
    resolved_profile_scope: null,
    resolved_profile_digest: null,
    provider_preference: null,
    provider: null,
    requested_model: null,
    provider_status: null,
    exact_model_selection: null,
    capability_revision: null,
    capability_source_digest: null,
    attested_effective_model: null,
  };
}

function resolveLaneProvider(lane, assignment, context) {
  if (hasOwn(assignment, 'execution')) {
    const execution = optOwn(assignment, 'execution');
    if (hasOwn(execution, 'provider')) {
      lane.status = 'resolved';
      lane.reason = 'explicit_assignment';
      lane.provider = optOwn(execution, 'provider');
      lane.requested_model = hasOwn(execution, 'model') && typeof optOwn(execution, 'model') === 'string'
        ? optOwn(execution, 'model')
        : null;
      lane.provider_status = 'available';
      return;
    }
    const authored = context.profileIndex.byName.get(optOwn(execution, 'profile'));
    if (authored === undefined) {
      lane.reason = 'profile_not_found';
      return;
    }
    const choice = profileProviderChoice(authored.definition);
    if (choice === null) {
      lane.reason = 'provider_missing';
      lane.resolved_profile = authored.name;
      lane.resolved_profile_scope = authored.scope;
      lane.resolved_profile_digest = authored.digest;
      return;
    }
    applyChoice(lane, authored, choice, 'assignment_profile', 'assignment_profile_preference');
    return;
  }

  if (context.runProfileName !== undefined) {
    const runRecord = context.profileIndex.byName.get(context.runProfileName);
    if (runRecord === undefined) {
      lane.reason = 'run_profile_not_found';
      return;
    }
    const choice = profileProviderChoice(runRecord.definition);
    if (choice !== null) {
      applyChoice(lane, runRecord, choice, 'run_profile', 'run_profile_preference');
      return;
    }
  }
  const defaultRecord = context.profileIndex.defaultRecord;
  if (defaultRecord !== null) {
    const choice = profileProviderChoice(defaultRecord.definition);
    if (choice !== null) {
      applyChoice(lane, defaultRecord, choice, 'default_profile', 'default_profile_preference');
      return;
    }
  }
  lane.reason = 'provider_missing';
}

function applyAvailability(lane, context) {
  if (lane.status !== 'resolved') return;
  const entry = context.availability.get(lane.provider);
  if (entry === undefined) {
    lane.status = 'unresolved';
    lane.reason = 'provider_unsupported';
    lane.provider_status = 'unsupported';
    return;
  }
  if (entry.status !== 'available') {
    lane.status = 'unresolved';
    lane.reason = 'provider_unavailable';
    lane.provider_status = 'unavailable';
    return;
  }
  if (lane.requested_model === null) {
    lane.status = 'unresolved';
    lane.reason = 'model_ambiguous';
    return;
  }
  if (entry.models !== null && !capturedIncludes(entry.models, lane.requested_model)) {
    lane.status = 'unresolved';
    lane.reason = 'model_unavailable';
  }
}

function applyCapabilityPosture(lane, context) {
  if (lane.status !== 'resolved') return;
  const record = context.capabilityIndex.get(lane.provider);
  if (record === undefined) {
    fail('capability_record_missing', `assignments.${lane.assignment_id}`,
      `assignments.${lane.assignment_id}: provider "${lane.provider}" has no declared capability record; `
      + 'resolution never guesses capabilities for a resolved lane.');
  }
  lane.exact_model_selection = record.exact_model_selection;
  lane.capability_revision = record.revision;
  lane.capability_source_digest = record.source_digest;
  if (record.exact_model_selection === 'not_supported' && lane.requested_model !== null) {
    fail('exact_model_selection_unsupported', `assignments.${lane.assignment_id}`,
      `assignments.${lane.assignment_id}: provider "${lane.provider}" declares exact_model_selection `
      + `"not_supported" but the lane requires exact model "${lane.requested_model}".`);
  }
}

function answerScopeFor(lane) {
  return lane.provider_status === 'available' ? 'model_only' : 'provider_and_model';
}

function questionFor(lane, selectableProviders) {
  return {
    assignment_id: lane.assignment_id,
    reason: lane.reason,
    reason_class: lane.reason_class,
    answer_scope: lane.answer_scope,
    selectable_providers: capturedFreeze([...selectableProviders]),
    requested: {
      profile: lane.authored_profile,
      run_profile: lane.run_profile,
      resolved_profile: lane.resolved_profile,
      resolved_profile_digest: lane.resolved_profile_digest,
      resolved_profile_scope: lane.resolved_profile_scope,
      provider_preference: lane.provider_preference === null || lane.provider_preference === undefined
        ? null
        : capturedFreeze([...lane.provider_preference]),
      provider: lane.provider,
      model: lane.requested_model,
    },
  };
}

function capabilityEligible(entry) {
  return entry !== undefined && entry.exact_model_selection !== 'not_supported';
}

function selectabilityFailure(lane, record) {
  if (record === undefined) {
    fail('capability_record_missing', `assignments.${lane.assignment_id}`,
      `assignments.${lane.assignment_id}: the model_only question names provider "${lane.provider}", `
      + 'which has no declared capability record; no answer for this lane could ever re-resolve.');
  }
  fail('exact_model_selection_unsupported', `assignments.${lane.assignment_id}`,
    `assignments.${lane.assignment_id}: provider "${lane.provider}" declares exact_model_selection `
    + '"not_supported", so its model_only question has no honorable answer; '
    + 'resolution fails closed instead of asking one.');
}

function refCompatibleProviders(assignment, providers) {
  assertNotProxy(assignment, 'assignment');
  const pinned = hasOwn(assignment, 'starting_ref');
  return providers.filter((provider) => (provider === 'cursor-cloud' ? pinned : !pinned));
}

function requestContentDigest(payload) {
  return identityBoundDigest(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, payload);
}

function buildSelectionRequest(runId, lanes, assignmentsById, availabilitySnapshot, capabilitySnapshot) {
  const capIndex = new Map(
    capabilitySnapshot.providers.map((record) => [record.provider, record]),
  );
  const eligible = new Map();
  for (const entry of availabilitySnapshot.providers) {
    if (entry.status === 'available' && capabilityEligible(capIndex.get(entry.provider))) {
      eligible.set(entry.provider,
        entry.models === null ? null : capturedFreeze([...entry.models]));
    }
  }
  const catalogProviders = [...eligible.keys()].sort();
  for (const lane of lanes) {
    if (lane.status === 'unresolved' && lane.answer_scope === 'model_only'
      && !eligible.has(lane.provider)) {
      selectabilityFailure(lane, capIndex.get(lane.provider));
    }
  }

  const questions = [];
  for (const lane of lanes) {
    if (lane.status !== 'unresolved') continue;
    const assignment = assignmentsById.get(lane.assignment_id);
    const compatible = refCompatibleProviders(assignment, catalogProviders);
    let selectable;
    if (lane.answer_scope === 'model_only') {
      if (!capturedIncludes(compatible, lane.provider)) {
        const pinned = hasOwn(assignment, 'starting_ref');
        fail(lane.provider === 'cursor-cloud' ? 'selection_route_unpinned' : 'selection_route_pinned_local',
          `assignments.${lane.assignment_id}.starting_ref`,
          `assignments.${lane.assignment_id} asks a model-only question against "${lane.provider}" `
            + (pinned
              ? 'while pinning a Cloud starting_ref no local route may carry.'
              : 'without the exact pushed starting_ref every Cloud lane must pin.'));
      }
      selectable = [lane.provider];
    } else {
      if (compatible.length === 0) {
        fail('selection_routes_exhausted', `assignments.${lane.assignment_id}`,
          `assignments.${lane.assignment_id}: no available, capable route matches its `
            + 'starting-ref contract; resolution fails closed instead of asking one.');
      }
      selectable = compatible;
    }
    ARRAY_PUSH.call(questions, questionFor(lane, selectable));
  }

  const choices = {
    providers: [...eligible.entries()]
      .map(([provider, models]) => ({ models, provider }))
      .sort((left, right) => (left.provider < right.provider ? -1 : 1)),
  };
  const digestPayload = {
    availability_digest: availabilitySnapshot.digest,
    capability_snapshot_digest: capabilitySnapshot.digest,
    choices,
    questions,
    run_id: runId,
    schema: SELECTION_REQUEST_SCHEMA_ID,
  };
  const digest = requestContentDigest(digestPayload);
  const request = freezeData({
    availability_digest: availabilitySnapshot.digest,
    capability_snapshot_digest: capabilitySnapshot.digest,
    schema: SELECTION_REQUEST_SCHEMA_ID,
    run_id: runId,
    request_id: deriveRequestId(digest),
    digest,
    question_count: questions.length,
    questions,
    choices,
  });
  if (utf8ByteLength(canonicalSelectionJson(request)) > MAX_SELECTION_REQUEST_BYTES) {
    fail('selection_request_too_large', '$',
      `The aggregated selection request exceeds ${MAX_SELECTION_REQUEST_BYTES} bytes.`);
  }
  return request;
}

export function resolveRunSelectionV1(options = {}) {
  assertDirectJsonClosure(options, '$');
  assertPlainObject(options, 'invalid_resolver_input', '$', 'resolver options');
  for (const key of sortedCapturedKeys(options)) {
    if (!capturedIncludes(RESOLVER_OPTIONS, key)) {
      fail('unknown_resolver_option', `$.${key}`, `$.${key} is not a resolver option.`);
    }
  }
  const manifestInput = optOwn(options, 'manifest');
  const profiles = optOwn(options, 'profiles');
  const availability = optOwn(options, 'availability');
  const capabilities = optOwn(options, 'capabilities');
  if (manifestInput === undefined || manifestInput === null) {
    fail('missing_key', '$.manifest', '$.manifest is required.');
  }
  const manifest = parseRunManifestV1(manifestInput);
  const runProfileName = hasOwn(manifest, 'profile') ? optOwn(manifest, 'profile') : undefined;
  const availabilitySnapshot = normalizeProviderAvailabilityV1(availability);
  const capabilitySnapshot = normalizeProviderCapabilitySnapshotV1(capabilities);
  const context = capturedFreeze({
    profileIndex: indexProfileRecords(profiles),
    runProfileName,
    availability: availabilityIndex(availabilitySnapshot),
    capabilityIndex: capabilityIndex(capabilitySnapshot),
    availabilitySnapshot,
    capabilitySnapshot,
  });

  const byId = new Map();
  for (const assignment of manifest.assignments) byId.set(assignment.assignment_id, assignment);
  const orderedIds = [...byId.keys()].sort();
  const lanes = [];
  for (const assignmentId of orderedIds) {
    const assignment = byId.get(assignmentId);
    const lane = laneRecord(assignment, context.runProfileName);
    resolveLaneProvider(lane, assignment, context);
    applyAvailability(lane, context);
    applyCapabilityPosture(lane, context);
    if (lane.status === 'unresolved') {
      lane.reason_class = REASON_CLASSES[lane.reason];
      lane.answer_scope = answerScopeFor(lane);
    } else {
      validateResolvedStartingRefV1(assignment, lane.provider, `assignments.${assignment.assignment_id}`);
    }
    ARRAY_PUSH.call(lanes, freezeData(lane));
  }

  const resolvedAssignmentIds = lanes.filter((lane) => lane.status === 'resolved').map((lane) => lane.assignment_id);
  const unresolvedAssignmentIds = lanes.filter((lane) => lane.status === 'unresolved').map((lane) => lane.assignment_id);
  const selectionRequest = unresolvedAssignmentIds.length === 0
    ? null
    : buildSelectionRequest(manifest.run_id, lanes, byId,
      context.availabilitySnapshot, context.capabilitySnapshot);

  return freezeData({
    schema: RESOLVED_RUN_SCHEMA_ID,
    run_id: manifest.run_id,
    repository_exposure: RUN_REPOSITORY_EXPOSURE,
    complete: unresolvedAssignmentIds.length === 0,
    assignment_count: lanes.length,
    assignments: lanes,
    resolved_assignment_ids: capturedFreeze(resolvedAssignmentIds),
    unresolved_assignment_ids: capturedFreeze(unresolvedAssignmentIds),
    selection_request: selectionRequest,
    availability_digest: availabilitySnapshot.digest,
    availability: availabilitySnapshot,
    capabilities: capabilitySnapshot,
    capability_snapshot_digest: capabilitySnapshot.digest,
  });
}

function validateRequestedProvenance(requested, path) {
  assertPlainObject(requested, 'invalid_selection_request', path, `${path}`);
  for (const key of sortedCapturedKeys(requested)) {
    if (!capturedIncludes(SELECTION_REQUESTED_ALLOWED_KEYS, key)) {
      fail('unknown_selection_request_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed requested-provenance vocabulary.`);
    }
  }
  for (const key of SELECTION_REQUESTED_ALLOWED_KEYS) {
    if (!hasOwn(requested, key)) {
      fail('invalid_selection_request', `${path}.${key}`,
        `${path}.${key} is required as an own property; inherited or omitted fields are not provenance.`);
    }
  }
  const profileNames = ['profile', 'run_profile', 'resolved_profile'];
  for (const key of profileNames) {
    const value = optOwn(requested, key);
    if (value !== null && !isProfileName(value)) {
      fail('invalid_selection_request', `${path}.${key}`,
        `${path}.${key} must be null or a bounded profile name.`);
    }
  }
  const resolvedScope = optOwn(requested, 'resolved_profile_scope');
  if (resolvedScope !== null && !capturedIncludes(PROFILE_SCOPES, resolvedScope)) {
    fail('invalid_selection_request', `${path}.resolved_profile_scope`,
      `${path}.resolved_profile_scope must be null, "project", or "owner".`);
  }
  const resolvedDigest = optOwn(requested, 'resolved_profile_digest');
  if (resolvedDigest !== null
    && (typeof resolvedDigest !== 'string' || !capturedTest(SHA256_DIGEST_PATTERN, resolvedDigest))) {
    fail('invalid_selection_request', `${path}.resolved_profile_digest`,
      `${path}.resolved_profile_digest must be null or a sha256 provenance digest.`);
  }
  const provenanceParts = [
    optOwn(requested, 'resolved_profile'),
    resolvedScope,
    resolvedDigest,
  ];
  if (provenanceParts.some((part) => part !== null) && provenanceParts.some((part) => part === null)) {
    fail('invalid_selection_request', `${path}.resolved_profile`,
      `${path}.resolved_profile, .resolved_profile_scope, and .resolved_profile_digest `
      + 'must be jointly present or jointly null.');
  }
  const preference = optOwn(requested, 'provider_preference');
  if (preference !== null) {
    assertNotProxy(preference, `${path}.provider_preference`);
    assertDenseJsonArray(preference, `${path}.provider_preference`);
    if (preference.length > PROVIDERS.length) {
      fail('invalid_selection_request', `${path}.provider_preference`,
        `${path}.provider_preference exceeds the provider vocabulary.`);
    }
    const seen = new SET_CTOR();
    for (let index = 0; index < preference.length; index += 1) {
      const entryPath = `${path}.provider_preference[${index}]`;
      const provider = ownDataValue(preference, STRING(index), entryPath);
      if (!isKnownProvider(provider)) {
        fail('invalid_selection_request', entryPath,
          `${entryPath} is not one of ${knownProvidersJoined()}.`);
      }
      if (SET_HAS.call(seen, provider)) {
        fail('invalid_selection_request', entryPath, `${entryPath} repeats provider "${provider}".`);
      }
      SET_ADD.call(seen, provider);
    }
  }
  const requestedProvider = optOwn(requested, 'provider');
  if (requestedProvider !== null && !isKnownProvider(requestedProvider)) {
    fail('invalid_selection_request', `${path}.provider`,
      `${path}.provider must be null or one of ${knownProvidersJoined()}.`);
  }
  const requestedModel = optOwn(requested, 'model');
  if (requestedModel !== null && !isModelId(requestedModel)) {
    fail('invalid_selection_request', `${path}.model`,
      `${path}.model must be null or match the bounded provider model identifier grammar.`);
  }
}

function validateQuestion(question, path) {
  assertPlainObject(question, 'invalid_selection_request', path, `${path}`);
  for (const key of sortedCapturedKeys(question)) {
    if (!capturedIncludes(SELECTION_QUESTION_ALLOWED_KEYS, key)) {
      fail('unknown_selection_request_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed selection question vocabulary.`);
    }
  }
  for (const key of SELECTION_QUESTION_ALLOWED_KEYS) {
    if (!hasOwn(question, key)) {
      fail('invalid_selection_request', `${path}.${key}`,
        `${path}.${key} is required as an own property; inherited or omitted fields are not question data.`);
    }
  }
  if (!isAssignmentId(optOwn(question, 'assignment_id'))) {
    fail('invalid_selection_request', `${path}.assignment_id`,
      `${path}.assignment_id must be a bounded assignment identifier.`);
  }
  const reason = optOwn(question, 'reason');
  if (!capturedIncludes(RESOLUTION_REASONS, reason)) {
    fail('invalid_selection_request', `${path}.reason`,
      `${path}.reason must be one of ${capturedJoin(RESOLUTION_REASONS, ', ')}.`);
  }
  if (optOwn(question, 'reason_class') !== REASON_CLASSES[reason]) {
    fail('invalid_selection_request', `${path}.reason_class`,
      `${path}.reason_class must be exactly "${REASON_CLASSES[reason]}" for reason "${reason}".`);
  }
  const answerScope = optOwn(question, 'answer_scope');
  if (!capturedIncludes(ANSWER_SCOPES, answerScope)) {
    fail('invalid_selection_request', `${path}.answer_scope`,
      `${path}.answer_scope must be one of ${capturedJoin(ANSWER_SCOPES, ', ')}.`);
  }
  const scopeIsModelOnly = answerScope === 'model_only';
  if (scopeIsModelOnly !== capturedIncludes(MODEL_ONLY_REASONS, reason)) {
    fail('invalid_selection_request', `${path}.answer_scope`,
      `${path}.answer_scope "${answerScope}" does not pair with reason "${reason}".`);
  }
  const selectable = optOwn(question, 'selectable_providers');
  assertNotProxy(selectable, `${path}.selectable_providers`);
  assertDenseJsonArray(selectable, `${path}.selectable_providers`);
  if (selectable.length === 0 || selectable.length > PROVIDERS.length) {
    fail('invalid_selection_request', `${path}.selectable_providers`,
      `${path}.selectable_providers must carry 1-${PROVIDERS.length} selectable providers.`);
  }
  let previousSelectable = null;
  for (let index = 0; index < selectable.length; index += 1) {
    const routePath = `${path}.selectable_providers[${index}]`;
    const provider = ownDataValue(selectable, STRING(index), routePath);
    if (!isKnownProvider(provider)) {
      fail('invalid_selection_request', routePath,
        `${routePath} must be one of ${knownProvidersJoined()}.`);
    }
    if (previousSelectable !== null && provider <= previousSelectable) {
      fail('invalid_selection_request', routePath,
        `${path}.selectable_providers must be strictly ascending without duplicates.`);
    }
    previousSelectable = provider;
  }
  validateRequestedProvenance(optOwn(question, 'requested'), `${path}.requested`);
  const requestedProvider = optOwn(optOwn(question, 'requested'), 'provider');
  const hasProvider = typeof requestedProvider === 'string';
  if (capturedIncludes(PROVIDER_BEARING_REASONS, reason) !== hasProvider) {
    fail('invalid_selection_request', `${path}.requested.provider`,
      `${path}.requested.provider presence does not pair with reason "${reason}".`);
  }
  if (scopeIsModelOnly && (selectable.length !== 1 || selectable[0] !== requestedProvider)) {
    fail('invalid_selection_request', `${path}.selectable_providers`,
      `${path}.selectable_providers must be exactly the lane's own provider for a model-only question.`);
  }
}

function validateChoices(choices, path) {
  assertPlainObject(choices, 'invalid_selection_request', path, `${path} choices`);
  for (const key of sortedCapturedKeys(choices)) {
    if (!capturedIncludes(SELECTION_CHOICES_ALLOWED_KEYS, key)) {
      fail('unknown_selection_request_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed choices vocabulary.`);
    }
  }
  if (!hasOwn(choices, 'providers')) {
    fail('invalid_selection_request', `${path}.providers`,
      `${path}.providers is required as an own property; inherited arrays are not choice data.`);
  }
  const entries = optOwn(choices, 'providers');
  assertNotProxy(entries, `${path}.providers`);
  assertDenseJsonArray(entries, `${path}.providers`);
  if (entries.length > PROVIDERS.length) {
    fail('invalid_selection_request', `${path}.providers`,
      `${path}.providers exceeds the ${PROVIDERS.length}-provider vocabulary.`);
  }
  let previousProvider = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}.providers[${index}]`;
    const entry = ownDataValue(entries, STRING(index), entryPath);
    assertPlainObject(entry, 'invalid_selection_request', entryPath, `${entryPath} entry`);
    for (const key of sortedCapturedKeys(entry)) {
      if (!capturedIncludes(SELECTION_CHOICE_ENTRY_ALLOWED_KEYS, key)) {
        fail('unknown_selection_request_key', `${entryPath}.${key}`,
          `${entryPath}.${key} is not part of the closed choice entry vocabulary.`);
      }
    }
    for (const key of SELECTION_CHOICE_ENTRY_ALLOWED_KEYS) {
      if (!hasOwn(entry, key)) {
        fail('invalid_selection_request', `${entryPath}.${key}`,
          `${entryPath}.${key} is required as an own property (models may be exactly null).`);
      }
    }
    const provider = optOwn(entry, 'provider');
    if (!isKnownProvider(provider)) {
      fail('invalid_selection_request', `${entryPath}.provider`,
        `${entryPath}.provider must be one of ${knownProvidersJoined()}.`);
    }
    if (previousProvider !== null && provider <= previousProvider) {
      fail('invalid_selection_request', `${entryPath}.provider`,
        `${path}.providers must be strictly ascending with exactly-one entry per provider.`);
    }
    previousProvider = provider;
    const models = optOwn(entry, 'models');
    if (models !== null) {
      assertNotProxy(models, `${entryPath}.models`);
      assertDenseJsonArray(models, `${entryPath}.models`);
      if (models.length === 0 || models.length > MAX_AVAILABILITY_MODELS) {
        fail('invalid_selection_request', `${entryPath}.models`,
          `${entryPath}.models must carry 1-${MAX_AVAILABILITY_MODELS} exact model identifiers.`);
      }
      let previousModel = null;
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const modelPath = `${entryPath}.models[${modelIndex}]`;
        const model = ownDataValue(models, STRING(modelIndex), modelPath);
        if (!isModelId(model)) {
          fail('invalid_selection_request', modelPath,
            `${modelPath} must match the bounded provider model identifier grammar.`);
        }
        if (previousModel !== null && model <= previousModel) {
          fail('invalid_selection_request', modelPath,
            `${entryPath}.models must be strictly ascending without duplicates.`);
        }
        previousModel = model;
      }
    }
  }
}

export function validateSelectionRequestV1(request) {
  assertDirectJsonClosure(request, '$');
  assertPlainObject(request, 'invalid_selection_request', '$', 'selection request');
  for (const key of sortedCapturedKeys(request)) {
    if (!capturedIncludes(SELECTION_REQUEST_ALLOWED_KEYS, key)) {
      fail('unknown_selection_request_key', `$.${key}`,
        `$.${key} is not part of the closed SelectionRequestV1 vocabulary.`);
    }
  }
  for (const key of SELECTION_REQUEST_ALLOWED_KEYS) {
    if (!hasOwn(request, key)) {
      fail('missing_key', `$.${key}`, `$.${key} is required as an own property.`);
    }
  }
  if (optOwn(request, 'schema') !== SELECTION_REQUEST_SCHEMA_ID) {
    fail('invalid_selection_request', '$.schema',
      `$.schema must be exactly "${SELECTION_REQUEST_SCHEMA_ID}".`);
  }
  const runId = optOwn(request, 'run_id');
  if (typeof runId !== 'string' || runId.length < 3) {
    fail('invalid_selection_request', '$.run_id', '$.run_id must be the run identifier.');
  }
  const availabilityDigest = optOwn(request, 'availability_digest');
  const capabilityDigest = optOwn(request, 'capability_snapshot_digest');
  if (typeof availabilityDigest !== 'string' || !capturedTest(SHA256_DIGEST_PATTERN, availabilityDigest)) {
    fail('invalid_selection_request', '$.availability_digest',
      '$.availability_digest must be a lowercase sha256:<64 hex> snapshot digest.');
  }
  if (typeof capabilityDigest !== 'string' || !capturedTest(SHA256_DIGEST_PATTERN, capabilityDigest)) {
    fail('invalid_selection_request', '$.capability_snapshot_digest',
      '$.capability_snapshot_digest must be a lowercase sha256:<64 hex> snapshot digest.');
  }
  const questions = optOwn(request, 'questions');
  assertNotProxy(questions, '$.questions');
  assertDenseJsonArray(questions, '$.questions');
  if (questions.length > MAX_SELECTION_QUESTIONS) {
    fail('invalid_selection_request', '$.questions',
      `$.questions exceeds the ${MAX_SELECTION_QUESTIONS}-assignment bound.`);
  }
  if (optOwn(request, 'question_count') !== questions.length) {
    fail('invalid_selection_request', '$.question_count',
      '$.question_count must equal the number of questions.');
  }
  let previousId = null;
  for (let index = 0; index < questions.length; index += 1) {
    const question = ownDataValue(questions, STRING(index), `$.questions[${index}]`);
    validateQuestion(question, `$.questions[${index}]`);
    const assignmentId = optOwn(question, 'assignment_id');
    if (previousId !== null && assignmentId <= previousId) {
      fail('invalid_selection_request', `$.questions[${index}].assignment_id`,
        '$.questions must be strictly ascending by assignment_id without duplicates.');
    }
    previousId = assignmentId;
  }
  validateChoices(optOwn(request, 'choices'), '$.choices');
  const canonical = canonicalSelectionJson(request);
  if (utf8ByteLength(canonical) > MAX_SELECTION_REQUEST_BYTES) {
    fail('selection_request_too_large', '$',
      `The aggregated selection request exceeds ${MAX_SELECTION_REQUEST_BYTES} bytes.`);
  }
  const digest = requestContentDigest({
    availability_digest: availabilityDigest,
    capability_snapshot_digest: capabilityDigest,
    choices: optOwn(request, 'choices'),
    questions,
    run_id: runId,
    schema: optOwn(request, 'schema'),
  });
  if (digest !== optOwn(request, 'digest')) {
    fail('selection_request_digest_mismatch', '$.digest',
      '$.digest does not match the canonical content of '
      + '{availability_digest, capability_snapshot_digest, choices, questions, run_id, schema}; '
      + 'any snapshot drift moves the question identity.');
  }
  const derivedRequestId = deriveRequestId(digest);
  if (optOwn(request, 'request_id') !== derivedRequestId) {
    fail('selection_request_id_mismatch', '$.request_id',
      `$.request_id must be exactly "${derivedRequestId}" for this digest.`);
  }
  if (!capturedTest(REQUEST_ID_PATTERN, derivedRequestId)) {
    fail('invalid_selection_request', '$.request_id',
      `$.request_id must match ${REQUEST_ID_PATTERN.source}.`);
  }
  return true;
}

export function selectionRequestIdentity(request) {
  validateSelectionRequestV1(request);
  return capturedFreeze({
    run_id: optOwn(request, 'run_id'),
    request_id: optOwn(request, 'request_id'),
    digest: optOwn(request, 'digest'),
  });
}

function requireUsableQuestionIndex(request) {
  validateSelectionRequestV1(request);
  const offeredModels = new Map();
  const choiceProviders = optOwn(optOwn(request, 'choices'), 'providers');
  for (let index = 0; index < choiceProviders.length; index += 1) {
    const entry = ownDataValue(choiceProviders, STRING(index), `$.choices.providers[${index}]`);
    offeredModels.set(optOwn(entry, 'provider'), optOwn(entry, 'models'));
  }
  const questions = new Map();
  const list = optOwn(request, 'questions');
  for (let index = 0; index < list.length; index += 1) {
    const question = ownDataValue(list, STRING(index), `$.questions[${index}]`);
    questions.set(optOwn(question, 'assignment_id'), question);
  }
  return capturedFreeze({ offeredModels, questions });
}

function modelProblem(model, declaredModels) {
  if (!isModelId(model)) return 'invalid_model_format';
  if (declaredModels !== null && declaredModels !== undefined) {
    assertNotProxy(declaredModels, 'choices.models');
    if (capturedIsArray(declaredModels) && !capturedIncludes(declaredModels, model)) {
      return 'model_not_offered';
    }
  }
  return null;
}

function answerContentProblems(answer, question, offeredModels) {
  const problems = [];
  const requested = optOwn(question, 'requested');
  const laneProvider = requested && typeof requested === 'object'
    ? optOwn(requested, 'provider')
    : undefined;
  if (optOwn(question, 'answer_scope') === 'model_only') {
    if (hasOwn(answer, 'provider')) {
      ARRAY_PUSH.call(problems, {
        assignment_id: optOwn(question, 'assignment_id'),
        code: 'provider_rejected_for_model_only',
      });
    } else if (!hasOwn(answer, 'model') || typeof optOwn(answer, 'model') !== 'string') {
      ARRAY_PUSH.call(problems, {
        assignment_id: optOwn(question, 'assignment_id'),
        code: 'model_required',
      });
    } else {
      const code = modelProblem(optOwn(answer, 'model'),
        typeof laneProvider === 'string' ? offeredModels.get(laneProvider) : undefined);
      if (code !== null) {
        ARRAY_PUSH.call(problems, { assignment_id: optOwn(question, 'assignment_id'), code });
      }
    }
    return problems;
  }
  if (!hasOwn(answer, 'provider') || typeof optOwn(answer, 'provider') !== 'string') {
    ARRAY_PUSH.call(problems, {
      assignment_id: optOwn(question, 'assignment_id'),
      code: 'provider_required',
    });
    return problems;
  }
  const selectable = optOwn(question, 'selectable_providers');
  const provider = optOwn(answer, 'provider');
  if (!offeredModels.has(provider)
    || !capturedIsArray(selectable)
    || !capturedIncludes(selectable, provider)) {
    ARRAY_PUSH.call(problems, {
      assignment_id: optOwn(question, 'assignment_id'),
      code: 'provider_not_selectable',
    });
    return problems;
  }
  if (!hasOwn(answer, 'model') || typeof optOwn(answer, 'model') !== 'string') {
    ARRAY_PUSH.call(problems, {
      assignment_id: optOwn(question, 'assignment_id'),
      code: 'model_required',
    });
    return problems;
  }
  const code = modelProblem(optOwn(answer, 'model'), offeredModels.get(provider));
  if (code !== null) {
    ARRAY_PUSH.call(problems, { assignment_id: optOwn(question, 'assignment_id'), code });
  }
  return problems;
}

function byProblemIdentity(left, right) {
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  const leftId = left.assignment_id ?? '';
  const rightId = right.assignment_id ?? '';
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return 0;
}

export function classifySelectionAnswersV1(request, answers, replyIdentity) {
  assertNotProxy(answers, '$.answers');
  assertNotProxy(replyIdentity, '$.reply_identity');
  const { offeredModels, questions } = requireUsableQuestionIndex(request);
  const problems = [];
  if (replyIdentity === undefined || replyIdentity === null) {
    ARRAY_PUSH.call(problems, { assignment_id: null, code: 'reply_identity_required' });
  } else {
    assertPlainObject(replyIdentity, 'invalid_reply_identity', '$.reply_identity', 'reply identity');
    assertDirectJsonClosure(replyIdentity, '$.reply_identity');
    let unknownKey = false;
    for (const key of sortedCapturedKeys(replyIdentity)) {
      if (!capturedIncludes(REPLY_IDENTITY_ALLOWED_KEYS, key)) unknownKey = true;
    }
    if (unknownKey) ARRAY_PUSH.call(problems, { assignment_id: null, code: 'unknown_reply_identity_key' });
    let incomplete = false;
    for (const key of REPLY_IDENTITY_ALLOWED_KEYS) {
      if (!hasOwn(replyIdentity, key)) incomplete = true;
    }
    if (incomplete) ARRAY_PUSH.call(problems, { assignment_id: null, code: 'incomplete_reply_identity' });
    if (hasOwn(replyIdentity, 'run_id') && optOwn(replyIdentity, 'run_id') !== optOwn(request, 'run_id')) {
      ARRAY_PUSH.call(problems, { assignment_id: null, code: 'stale_run_mismatch' });
    }
    if (hasOwn(replyIdentity, 'request_id')
      && optOwn(replyIdentity, 'request_id') !== optOwn(request, 'request_id')) {
      ARRAY_PUSH.call(problems, { assignment_id: null, code: 'stale_request_id' });
    }
    if (hasOwn(replyIdentity, 'digest') && optOwn(replyIdentity, 'digest') !== optOwn(request, 'digest')) {
      ARRAY_PUSH.call(problems, { assignment_id: null, code: 'stale_digest' });
    }
  }
  if (!capturedIsArray(answers)) {
    ARRAY_PUSH.call(problems, { assignment_id: null, code: 'invalid_answers' });
    return freezeData({ ok: false, problems: capturedFreeze(problems.sort(byProblemIdentity)) });
  }
  assertDirectJsonClosure(answers, '$.answers');
  const answeredIds = [];
  const answered = new SET_CTOR();
  let shapeValid = true;
  for (let index = 0; index < answers.length; index += 1) {
    const answer = ownDataValue(answers, STRING(index), `$.answers[${index}]`);
    if (typeof answer !== 'object' || answer === null || capturedIsArray(answer)) {
      shapeValid = false;
      continue;
    }
    for (const key of sortedCapturedKeys(answer)) {
      if (!capturedIncludes(SELECTION_ANSWER_ALLOWED_KEYS, key)) shapeValid = false;
    }
    const assignmentId = optOwn(answer, 'assignment_id');
    if (!hasOwn(answer, 'assignment_id') || typeof assignmentId !== 'string' || assignmentId.length === 0) {
      shapeValid = false;
      continue;
    }
    ARRAY_PUSH.call(answeredIds, assignmentId);
  }
  if (!shapeValid) ARRAY_PUSH.call(problems, { assignment_id: null, code: 'invalid_answer_shape' });
  if (new SET_CTOR(answeredIds).size !== answeredIds.length) {
    ARRAY_PUSH.call(problems, { assignment_id: null, code: 'duplicate_answer' });
  }
  for (let index = 0; index < answers.length; index += 1) {
    const answer = ownDataValue(answers, STRING(index), `$.answers[${index}]`);
    const assignmentId = typeof answer === 'object' && answer !== null ? optOwn(answer, 'assignment_id') : undefined;
    if (typeof answer !== 'object' || answer === null || typeof assignmentId !== 'string') continue;
    if (!questions.has(assignmentId)) {
      ARRAY_PUSH.call(problems, { assignment_id: assignmentId, code: 'unexpected_answer' });
      continue;
    }
    SET_ADD.call(answered, assignmentId);
    ARRAY_PUSH.call(problems, ...answerContentProblems(answer, questions.get(assignmentId), offeredModels));
  }
  for (const [assignmentId] of questions) {
    if (!SET_HAS.call(answered, assignmentId)) {
      ARRAY_PUSH.call(problems, { assignment_id: assignmentId, code: 'missing_answer' });
    }
  }
  problems.sort(byProblemIdentity);
  return freezeData({ ok: problems.length === 0, problems: capturedFreeze(problems) });
}

function selectionOptions({ manifest, profiles, availability, capabilities }) {
  const options = { availability, capabilities, manifest };
  if (profiles !== undefined) options.profiles = profiles;
  return options;
}

export function resolveSelectionAnswersV1(options = {}) {
  assertDirectJsonClosure(options, '$');
  assertPlainObject(options, 'invalid_resolver_input', '$', 'resolver options');
  for (const key of sortedCapturedKeys(options)) {
    if (!capturedIncludes(SELECTION_RESOLUTION_OPTIONS, key)) {
      fail('unknown_resolver_option', `$.${key}`, `$.${key} is not a selection resolution option.`);
    }
  }
  const manifest = optOwn(options, 'manifest');
  const profiles = optOwn(options, 'profiles');
  const availability = optOwn(options, 'availability');
  const capabilities = optOwn(options, 'capabilities');
  const request = optOwn(options, 'request');
  const answers = optOwn(options, 'answers');
  const replyIdentity = optOwn(options, 'replyIdentity');
  if (manifest === undefined || manifest === null) fail('missing_key', '$.manifest', '$.manifest is required.');
  if (request === undefined || request === null) {
    fail('missing_key', '$.request', '$.request is required: the outstanding SelectionRequestV1.');
  }
  if (answers === undefined || answers === null) {
    fail('missing_key', '$.answers', '$.answers is required: the accepted answer batch.');
  }
  if (replyIdentity === undefined || replyIdentity === null) {
    fail('missing_key', '$.replyIdentity', '$.replyIdentity is required: the trusted reply triple.');
  }

  const availabilitySnapshot = normalizeProviderAvailabilityV1(availability);
  const capabilitySnapshot = normalizeProviderCapabilitySnapshotV1(capabilities);
  if (optOwn(request, 'availability_digest') !== availabilitySnapshot.digest
    || optOwn(request, 'capability_snapshot_digest') !== capabilitySnapshot.digest) {
    fail('selection_snapshot_mismatch', '$.request',
      '$.request binds snapshot digests that do not match the persisted availability and '
      + 'capability evidence; drifted snapshots cannot resolve answers.');
  }
  validateSelectionRequestV1(request);

  const originalPlan = resolveRunSelectionV1(selectionOptions({
    manifest, profiles, availability, capabilities,
  }));
  const derived = originalPlan.selection_request;
  if (derived === null) {
    fail('no_outstanding_selection_request', '$.request',
      'The run has no outstanding selection question; there is nothing to answer.');
  }
  if (derived.digest !== optOwn(request, 'digest')
    || derived.request_id !== optOwn(request, 'request_id')
    || derived.run_id !== optOwn(request, 'run_id')) {
    fail('stale_selection_request', '$.request',
      '$.request does not reproduce the question the unchanged manifest and snapshots derive; '
      + 'a stale question cannot bind answers.');
  }

  const classification = classifySelectionAnswersV1(request, answers, replyIdentity);
  if (!classification.ok) {
    const codes = classification.problems.map((problem) => problem.code).join(', ');
    fail('selection_answers_rejected', '$.answers',
      `The answer batch was not acceptable (${codes}); only ok batches re-resolve.`);
  }

  const answerByAssignmentId = new Map();
  for (let index = 0; index < answers.length; index += 1) {
    const answer = ownDataValue(answers, STRING(index), `$.answers[${index}]`);
    answerByAssignmentId.set(optOwn(answer, 'assignment_id'), answer);
  }
  const questionByAssignmentId = new Map();
  const questionList = optOwn(request, 'questions');
  for (let index = 0; index < questionList.length; index += 1) {
    const question = ownDataValue(questionList, STRING(index), `$.questions[${index}]`);
    questionByAssignmentId.set(optOwn(question, 'assignment_id'), question);
  }

  const detached = STRUCTURED_CLONE(manifest);
  const answeredAssignmentIds = [];
  const answeredAssignments = [];
  for (let index = 0; index < detached.assignments.length; index += 1) {
    const assignment = detached.assignments[index];
    const question = questionByAssignmentId.get(assignment.assignment_id);
    if (question === undefined) {
      ARRAY_PUSH.call(answeredAssignments, assignment);
      continue;
    }
    const answer = answerByAssignmentId.get(assignment.assignment_id);
    const provider = optOwn(question, 'answer_scope') === 'model_only'
      ? optOwn(optOwn(question, 'requested'), 'provider')
      : optOwn(answer, 'provider');
    const model = optOwn(answer, 'model');
    ARRAY_PUSH.call(answeredAssignmentIds, assignment.assignment_id);
    ARRAY_PUSH.call(answeredAssignments, {
      ...assignment,
      execution: capturedFreeze({ model, provider }),
    });
  }
  const answeredManifest = freezeData({
    ...detached,
    assignments: answeredAssignments,
  });
  const answeredPlan = resolveRunSelectionV1(selectionOptions({
    manifest: answeredManifest, profiles, availability, capabilities,
  }));
  if (!answeredPlan.complete) {
    fail('answered_run_incomplete', '$',
      'Re-resolution of the unchanged manifest with the accepted answers did not complete; '
      + 'resolution refuses to hand back a partially answered run.');
  }
  if (answeredPlan.availability_digest !== originalPlan.availability_digest
    || answeredPlan.capability_snapshot_digest !== originalPlan.capability_snapshot_digest) {
    fail('selection_snapshot_mismatch', '$',
      'Snapshot digests moved between classification and re-resolution; refusing.');
  }
  answeredAssignmentIds.sort();
  return freezeData({
    schema: ANSWERED_RUN_SCHEMA_ID,
    run_id: answeredPlan.run_id,
    request_id: optOwn(request, 'request_id'),
    digest: optOwn(request, 'digest'),
    answered_assignment_ids: capturedFreeze(answeredAssignmentIds),
    availability_digest: answeredPlan.availability_digest,
    capability_snapshot_digest: answeredPlan.capability_snapshot_digest,
    plan: answeredPlan,
  });
}

capturedFreeze(normalizeProviderAvailabilityV1);
capturedFreeze(resolveRunSelectionV1);
capturedFreeze(validateSelectionRequestV1);
capturedFreeze(selectionRequestIdentity);
capturedFreeze(classifySelectionAnswersV1);
capturedFreeze(resolveSelectionAnswersV1);
