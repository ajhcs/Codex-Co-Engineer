// P17 capability-bridge (complete closed ProviderCapabilitiesV1 records).
//
// P05 ships before the P17 registry, so this module imports nothing from a
// future provider-capability package. It mirrors the complete closed record
// shape, enums, and cross-field rules through shared literals only. A
// four-field pseudo-record is not a capability. Snapshot digests bind
// through the P03 identity authority (IDENTITY_LABELS.PROVIDER_CAPABILITY).

import {
  capturedFreeze,
  capturedIncludes,
  capturedJoin,
  capturedTest,
  capturedUtf8ByteLength,
  isKnownProvider,
  knownProvidersJoined,
  sortedCapturedKeys,
} from './grammar.mjs';
import { IDENTITY_LABELS } from './identity.mjs';
import { assertDenseJsonArray } from './run-manifest.mjs';
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

export const PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID = 'codex-co-engineer.capability-snapshot.v1';
export const PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID = 'codex-co-engineer.provider-capabilities.v1';
export const EXACT_MODEL_SELECTION_POSTURES = capturedFreeze([
  'exact_and_attested', 'exact_unattested', 'not_supported',
]);
export const CAPABILITY_SNAPSHOT_ALLOWED_KEYS = capturedFreeze(['providers', 'schema']);
export const CAPABILITY_RECORD_ALLOWED_KEYS = capturedFreeze([
  'artifact_kinds', 'create_pr_posture', 'dispatch_certainty', 'exact_model_selection',
  'merge_authority', 'notes', 'provider', 'replay_posture', 'revision',
  'same_session_reply', 'source_digest', 'workspace_semantics', 'workspace_starting_point',
]);
const CAPABILITY_BRIDGE_INPUT_KEYS = capturedFreeze([...CAPABILITY_RECORD_ALLOWED_KEYS, 'schema']);
export const SAME_SESSION_REPLY_POSTURES = capturedFreeze([
  'live_session_reply', 'unsupported_unresolved_attention',
]);
export const DISPATCH_CERTAINTY_VALUES = capturedFreeze(['confirmed_launch', 'uncertain_after_spawn']);
export const REPLAY_POSTURES = capturedFreeze(['never_replay']);
export const CAPABILITY_ARTIFACT_KINDS = capturedFreeze([
  'acceptance_output', 'cloud_receipt', 'event_segment', 'git_diff',
  'provider_report', 'ref_snapshot', 'usage_evidence',
]);
export const MAX_CAPABILITY_ARTIFACT_KINDS = CAPABILITY_ARTIFACT_KINDS.length;
export const WORKSPACE_SEMANTICS_VALUES = capturedFreeze([
  'local_managed_worktree', 'remote_provider_managed',
]);
export const WORKSPACE_STARTING_POINTS = capturedFreeze(['pinned_pushed_sha', 'run_base_sha']);
export const MERGE_AUTHORITIES = capturedFreeze(['none_codex_only_integration']);
export const CREATE_PR_POSTURES = capturedFreeze(['non_authoritative_cloud_only', 'prohibited']);
export const MAX_CAPABILITY_NOTES_BYTES = 512;
export const REQUIRED_CAPABILITY_ARTIFACT_KIND = 'provider_report';
export const CAPABILITY_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
export const CAPABILITY_REVISION_MAX_BYTES = 64;
export const CAPABILITY_SOURCE_DIGEST_PATTERN = SHA256_DIGEST_PATTERN;

const ARRAY_PUSH = Array.prototype.push;
const SET_CTOR = Set;
const SET_ADD = SET_CTOR.prototype.add;
const SET_HAS = SET_CTOR.prototype.has;
const STRING = String;

function expectedWorkspace(provider) {
  const cloud = provider === 'cursor-cloud';
  return {
    semantics: cloud ? 'remote_provider_managed' : 'local_managed_worktree',
    startingPoint: cloud ? 'pinned_pushed_sha' : 'run_base_sha',
  };
}

function expectedSameSessionReply(provider) {
  return provider === 'dsh' || provider === 'cursor-cloud'
    ? 'unsupported_unresolved_attention'
    : 'live_session_reply';
}

function expectedDispatchCertainty(provider) {
  return provider === 'dsh' ? 'uncertain_after_spawn' : 'confirmed_launch';
}

function validateCapabilityRecordFields(record, path) {
  if (!hasOwn(record, 'provider')) {
    fail('missing_key', `${path}.provider`,
      `${path}.provider is required; a capability record names its provider slot.`);
  }
  const provider = optOwn(record, 'provider');
  if (!isKnownProvider(provider)) {
    fail('unknown_provider', `${path}.provider`,
      `${path}.provider must be exactly one of ${knownProvidersJoined()}.`);
  }
  const revision = optOwn(record, 'revision');
  if (typeof revision !== 'string' || !capturedTest(CAPABILITY_REVISION_PATTERN, revision)
    || capturedUtf8ByteLength(revision) > CAPABILITY_REVISION_MAX_BYTES) {
    fail('invalid_capability_revision', `${path}.revision`,
      `${path}.revision must match ${CAPABILITY_REVISION_PATTERN.source} `
      + `(max ${CAPABILITY_REVISION_MAX_BYTES} bytes); an unversioned posture is not provenance.`);
  }
  const notes = optOwn(record, 'notes');
  if (typeof notes !== 'string' || notes.length === 0
    || capturedUtf8ByteLength(notes) > MAX_CAPABILITY_NOTES_BYTES) {
    fail('invalid_capability_notes', `${path}.notes`,
      `${path}.notes must be 1-${MAX_CAPABILITY_NOTES_BYTES} bytes of bounded operator guidance.`);
  }
  const exactModelSelection = optOwn(record, 'exact_model_selection');
  if (!capturedIncludes(EXACT_MODEL_SELECTION_POSTURES, exactModelSelection)) {
    fail('invalid_exact_model_selection', `${path}.exact_model_selection`,
      `${path}.exact_model_selection must be exactly one of ${capturedJoin(EXACT_MODEL_SELECTION_POSTURES, ', ')}.`);
  }
  const sameSessionReply = optOwn(record, 'same_session_reply');
  if (!capturedIncludes(SAME_SESSION_REPLY_POSTURES, sameSessionReply)) {
    fail('invalid_same_session_reply', `${path}.same_session_reply`,
      `${path}.same_session_reply must be exactly one of ${capturedJoin(SAME_SESSION_REPLY_POSTURES, ', ')}.`);
  }
  const expectedReply = expectedSameSessionReply(provider);
  if (sameSessionReply !== expectedReply) {
    fail('capability_reply_mismatch', `${path}.same_session_reply`,
      `${path}.same_session_reply must be "${expectedReply}" for provider "${provider}".`);
  }
  const dispatchCertainty = optOwn(record, 'dispatch_certainty');
  if (!capturedIncludes(DISPATCH_CERTAINTY_VALUES, dispatchCertainty)) {
    fail('invalid_dispatch_certainty', `${path}.dispatch_certainty`,
      `${path}.dispatch_certainty must be exactly one of ${capturedJoin(DISPATCH_CERTAINTY_VALUES, ', ')}.`);
  }
  const expectedCertainty = expectedDispatchCertainty(provider);
  if (dispatchCertainty !== expectedCertainty) {
    fail('capability_dispatch_certainty_mismatch', `${path}.dispatch_certainty`,
      `${path}.dispatch_certainty must be "${expectedCertainty}" for provider "${provider}".`);
  }
  const replayPosture = optOwn(record, 'replay_posture');
  if (!capturedIncludes(REPLAY_POSTURES, replayPosture)) {
    fail('invalid_replay_posture', `${path}.replay_posture`,
      `${path}.replay_posture must be exactly ${capturedJoin(REPLAY_POSTURES, ', ')}.`);
  }
  const artifactKinds = optOwn(record, 'artifact_kinds');
  assertNotProxy(artifactKinds, `${path}.artifact_kinds`);
  assertDenseJsonArray(artifactKinds, `${path}.artifact_kinds`);
  if (artifactKinds.length === 0 || artifactKinds.length > MAX_CAPABILITY_ARTIFACT_KINDS) {
    fail('invalid_artifact_kinds', `${path}.artifact_kinds`,
      `${path}.artifact_kinds must carry 1-${MAX_CAPABILITY_ARTIFACT_KINDS} closed artifact kinds.`);
  }
  const seenKinds = new SET_CTOR();
  for (let index = 0; index < artifactKinds.length; index += 1) {
    const kindPath = `${path}.artifact_kinds[${index}]`;
    const kind = ownDataValue(artifactKinds, STRING(index), kindPath);
    if (!capturedIncludes(CAPABILITY_ARTIFACT_KINDS, kind)) {
      fail('invalid_artifact_kinds', kindPath,
        `${kindPath} must be one of ${capturedJoin(CAPABILITY_ARTIFACT_KINDS, ', ')}.`);
    }
    if (SET_HAS.call(seenKinds, kind)) {
      fail('invalid_artifact_kinds', kindPath, `${kindPath} repeats artifact kind "${kind}".`);
    }
    SET_ADD.call(seenKinds, kind);
  }
  if (!SET_HAS.call(seenKinds, REQUIRED_CAPABILITY_ARTIFACT_KIND)) {
    fail('invalid_artifact_kinds', `${path}.artifact_kinds`,
      `${path}.artifact_kinds must include "${REQUIRED_CAPABILITY_ARTIFACT_KIND}"; `
      + 'a provider that cannot report itself cannot be evidenced.');
  }
  const workspaceSemantics = optOwn(record, 'workspace_semantics');
  if (!capturedIncludes(WORKSPACE_SEMANTICS_VALUES, workspaceSemantics)) {
    fail('invalid_workspace_semantics', `${path}.workspace_semantics`,
      `${path}.workspace_semantics must be exactly one of ${capturedJoin(WORKSPACE_SEMANTICS_VALUES, ', ')}.`);
  }
  const workspaceStartingPoint = optOwn(record, 'workspace_starting_point');
  if (!capturedIncludes(WORKSPACE_STARTING_POINTS, workspaceStartingPoint)) {
    fail('invalid_workspace_starting_point', `${path}.workspace_starting_point`,
      `${path}.workspace_starting_point must be exactly one of ${capturedJoin(WORKSPACE_STARTING_POINTS, ', ')}.`);
  }
  const expected = expectedWorkspace(provider);
  if (workspaceSemantics !== expected.semantics || workspaceStartingPoint !== expected.startingPoint) {
    fail('capability_workspace_mismatch', `${path}.workspace_starting_point`,
      `${path}: provider "${provider}" must declare workspace semantics "${expected.semantics}" `
      + `starting at "${expected.startingPoint}"; declared `
      + `"${workspaceSemantics}" starting at "${workspaceStartingPoint}".`);
  }
  const mergeAuthority = optOwn(record, 'merge_authority');
  if (!capturedIncludes(MERGE_AUTHORITIES, mergeAuthority)) {
    fail('invalid_merge_authority', `${path}.merge_authority`,
      `${path}.merge_authority must be exactly ${capturedJoin(MERGE_AUTHORITIES, ', ')}.`);
  }
  const createPrPosture = optOwn(record, 'create_pr_posture');
  if (!capturedIncludes(CREATE_PR_POSTURES, createPrPosture)) {
    fail('invalid_create_pr_posture', `${path}.create_pr_posture`,
      `${path}.create_pr_posture must be exactly one of ${capturedJoin(CREATE_PR_POSTURES, ', ')}.`);
  }
  if (createPrPosture === 'non_authoritative_cloud_only' && provider !== 'cursor-cloud') {
    fail('capability_merge_authority_mismatch', `${path}.create_pr_posture`,
      `${path}.create_pr_posture "non_authoritative_cloud_only" is valid only for "cursor-cloud"; `
      + `provider "${provider}" must declare "prohibited".`);
  }
  const kinds = [...seenKinds];
  kinds.sort();
  return freezeData({
    artifact_kinds: capturedFreeze(kinds),
    create_pr_posture: createPrPosture,
    dispatch_certainty: dispatchCertainty,
    exact_model_selection: exactModelSelection,
    merge_authority: mergeAuthority,
    notes,
    provider,
    replay_posture: replayPosture,
    revision,
    same_session_reply: sameSessionReply,
    workspace_semantics: workspaceSemantics,
    workspace_starting_point: workspaceStartingPoint,
  });
}

export function projectCapabilityRecordFromP17(record) {
  const path = 'capability_record';
  if (record === undefined || record === null) {
    fail('invalid_type', path, `${path} must be a plain ProviderCapabilitiesV1 record object.`);
  }
  assertDirectJsonClosure(record, `$.${path}`);
  assertPlainObject(record, 'invalid_type', path, `${path}`);
  for (const key of sortedCapturedKeys(record)) {
    if (!capturedIncludes(CAPABILITY_BRIDGE_INPUT_KEYS, key)) {
      fail('unknown_capability_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed capability record vocabulary.`);
    }
  }
  if (optOwn(record, 'schema') !== PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID) {
    fail('invalid_capability_schema', `${path}.schema`,
      `${path}.schema must be exactly "${PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID}".`);
  }
  const normalized = validateCapabilityRecordFields(record, path);
  return freezeData({
    ...normalized,
    source_digest: identityBoundDigest(IDENTITY_LABELS.PROVIDER_CAPABILITY, record),
  });
}

function assertProjectedCapabilityRecord(provider, entry, path) {
  for (const key of sortedCapturedKeys(entry)) {
    if (!capturedIncludes(CAPABILITY_RECORD_ALLOWED_KEYS, key)) {
      fail('unknown_capability_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed capability record vocabulary.`);
    }
  }
  if (hasOwn(entry, 'provider') && optOwn(entry, 'provider') !== provider) {
    fail('provider_slot_mismatch', `${path}.provider`,
      `${path}.provider must be exactly "${provider}" when the record restates its provider slot.`);
  }
  for (const key of CAPABILITY_RECORD_ALLOWED_KEYS) {
    if (!hasOwn(entry, key)) {
      fail('missing_key', `${path}.${key}`,
        `${path}.${key} is required; capability records are complete closed shapes with no hidden defaults.`);
    }
  }
  const sourceDigest = optOwn(entry, 'source_digest');
  if (typeof sourceDigest !== 'string' || !capturedTest(CAPABILITY_SOURCE_DIGEST_PATTERN, sourceDigest)) {
    fail('invalid_capability_source_digest', `${path}.source_digest`,
      `${path}.source_digest must be a lowercase sha256:<64 hex> record digest; `
      + 'a posture without its source binding is a guess.');
  }
  const normalized = validateCapabilityRecordFields(entry, path);
  return capturedFreeze({ ...normalized, source_digest: sourceDigest });
}

export function normalizeProviderCapabilitySnapshotV1(capabilities) {
  if (capabilities === undefined || capabilities === null) {
    fail('capability_snapshot_required', '$.capabilities',
      'capabilities is required explicit caller data; resolution never assumes provider capability postures.');
  }
  assertDirectJsonClosure(capabilities, '$');
  assertPlainObject(capabilities, 'invalid_capability_snapshot', '$', 'capability snapshot');
  for (const key of sortedCapturedKeys(capabilities)) {
    if (!capturedIncludes(CAPABILITY_SNAPSHOT_ALLOWED_KEYS, key)) {
      fail('unknown_capability_key', `$.${key}`,
        `$.${key} is not part of the closed capability snapshot vocabulary.`);
    }
  }
  if (!hasOwn(capabilities, 'schema')) {
    fail('missing_key', '$.schema', '$.schema is required; an inherited schema string is not capability data.');
  }
  if (optOwn(capabilities, 'schema') !== PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID) {
    fail('invalid_capability_schema', '$.schema',
      `capabilities.schema must be exactly "${PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID}".`);
  }
  if (!hasOwn(capabilities, 'providers')) {
    fail('missing_key', '$.providers', '$.providers is required; capability snapshots have no hidden default.');
  }
  const providers = optOwn(capabilities, 'providers');
  assertPlainObject(providers, 'invalid_capability_snapshot', '$.providers', 'capabilities.providers');
  const normalized = [];
  for (const provider of sortedCapturedKeys(providers)) {
    const path = `providers.${provider}`;
    if (!isKnownProvider(provider)) {
      fail('unknown_provider', path, `${path} is not one of ${knownProvidersJoined()}.`);
    }
    const entry = optOwn(providers, provider);
    assertPlainObject(entry, 'invalid_capability_snapshot', path, `${path} capability record`);
    ARRAY_PUSH.call(normalized, assertProjectedCapabilityRecord(provider, entry, path));
  }
  const digest = identityBoundDigest(IDENTITY_LABELS.PROVIDER_CAPABILITY, {
    providers: normalized,
    schema: PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
  });
  return freezeData({
    digest,
    providers: normalized,
    schema: PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
  });
}

capturedFreeze(projectCapabilityRecordFromP17);
capturedFreeze(normalizeProviderCapabilitySnapshotV1);
