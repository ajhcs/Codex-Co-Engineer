import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  CAPABILITY_RECORD_ALLOWED_KEYS,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
  normalizeProviderCapabilitySnapshotV1,
  projectCapabilityRecordFromP17,
} from '../mcp/v3/capability-bridge.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  capabilitySnapshot,
  countingProxy,
  p17Record,
  projectedCapability,
  trapTotal,
} from './fixtures/r1-resolver-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

test('P17 bridge projects the complete closed capability record, not a four-field stub', () => {
  const projected = projectedCapability('grok');
  for (const key of CAPABILITY_RECORD_ALLOWED_KEYS) {
    assert.ok(Object.hasOwn(projected, key), `missing ${key}`);
  }
  assert.equal(projected.provider, 'grok');
  assert.equal(projected.same_session_reply, 'live_session_reply');
  assert.equal(projected.dispatch_certainty, 'confirmed_launch');
  assert.equal(projected.workspace_semantics, 'local_managed_worktree');
  assert.equal(projected.workspace_starting_point, 'run_base_sha');
  assert.equal(projected.create_pr_posture, 'prohibited');
  assert.equal(projected.replay_posture, 'never_replay');
  assert.equal(projected.merge_authority, 'none_codex_only_integration');
  assert.match(projected.source_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(projected));
  assert.ok(Object.isFrozen(projected.artifact_kinds));
});

test('P17 bridge encodes DSH and Cloud cross-field rules', () => {
  const dsh = projectedCapability('dsh');
  assert.equal(dsh.same_session_reply, 'unsupported_unresolved_attention');
  assert.equal(dsh.dispatch_certainty, 'uncertain_after_spawn');
  assert.equal(dsh.workspace_starting_point, 'run_base_sha');
  assert.equal(dsh.create_pr_posture, 'prohibited');

  const cloud = projectedCapability('cursor-cloud');
  assert.equal(cloud.same_session_reply, 'unsupported_unresolved_attention');
  assert.equal(cloud.dispatch_certainty, 'confirmed_launch');
  assert.equal(cloud.workspace_semantics, 'remote_provider_managed');
  assert.equal(cloud.workspace_starting_point, 'pinned_pushed_sha');
  assert.equal(cloud.create_pr_posture, 'non_authoritative_cloud_only');
});

test('incomplete P17 records and cross-field mismatches fail closed', () => {
  const incomplete = p17Record('grok');
  delete incomplete.replay_posture;
  assert.equal(errorOf(() => projectCapabilityRecordFromP17(incomplete)).code, 'invalid_replay_posture');

  assert.equal(
    errorOf(() => projectCapabilityRecordFromP17(p17Record('grok', {
      same_session_reply: 'unsupported_unresolved_attention',
    }))).code,
    'capability_reply_mismatch',
  );
  assert.equal(
    errorOf(() => projectCapabilityRecordFromP17(p17Record('dsh', {
      dispatch_certainty: 'confirmed_launch',
    }))).code,
    'capability_dispatch_certainty_mismatch',
  );
  assert.equal(
    errorOf(() => projectCapabilityRecordFromP17(p17Record('grok', {
      workspace_starting_point: 'pinned_pushed_sha',
    }))).code,
    'capability_workspace_mismatch',
  );
  assert.equal(
    errorOf(() => projectCapabilityRecordFromP17(p17Record('dsh', {
      create_pr_posture: 'non_authoritative_cloud_only',
    }))).code,
    'capability_merge_authority_mismatch',
  );
  assert.equal(
    errorOf(() => projectCapabilityRecordFromP17(p17Record('grok', {
      artifact_kinds: ['git_diff'],
    }))).code,
    'invalid_artifact_kinds',
  );
});

test('capability snapshots require every closed field and bind a digest', () => {
  const snapshot = capabilitySnapshot();
  const normalized = normalizeProviderCapabilitySnapshotV1(snapshot);
  assert.equal(normalized.schema, PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID);
  assert.match(normalized.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(normalized.providers.length, 4);
  assert.deepEqual(normalized.providers.map((entry) => entry.provider),
    ['cursor-cloud', 'cursor-local', 'dsh', 'grok']);
  const again = normalizeProviderCapabilitySnapshotV1(snapshot);
  assert.equal(again.digest, normalized.digest);
});

test('forged or drifted capability source_digest fails closed', () => {
  const snapshot = capabilitySnapshot();
  snapshot.providers.grok = {
    ...projectedCapability('grok'),
    source_digest: 'sha256:not-hex',
  };
  assert.equal(
    errorOf(() => normalizeProviderCapabilitySnapshotV1(snapshot)).code,
    'invalid_capability_source_digest',
  );
  snapshot.providers.grok = {
    ...projectedCapability('grok'),
    source_digest: 'not-a-digest',
  };
  assert.equal(
    errorOf(() => normalizeProviderCapabilitySnapshotV1(snapshot)).code,
    'invalid_capability_source_digest',
  );
});

test('capability snapshot rejects missing fields, unknown keys, and inherited schema', () => {
  assert.equal(
    errorOf(() => normalizeProviderCapabilitySnapshotV1(undefined)).code,
    'capability_snapshot_required',
  );
  const missingField = capabilitySnapshot();
  missingField.providers.grok = { ...projectedCapability('grok') };
  delete missingField.providers.grok.notes;
  assert.equal(errorOf(() => normalizeProviderCapabilitySnapshotV1(missingField)).code, 'missing_key');

  const unknown = capabilitySnapshot();
  unknown.extra = true;
  assert.equal(errorOf(() => normalizeProviderCapabilitySnapshotV1(unknown)).code, 'unknown_capability_key');

  const missingSchema = { providers: capabilitySnapshot().providers };
  assert.equal(errorOf(() => normalizeProviderCapabilitySnapshotV1(missingSchema)).code, 'missing_key');

  const proto = { schema: PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID };
  const inherited = Object.create(proto);
  inherited.providers = capabilitySnapshot().providers;
  assert.equal(
    errorOf(() => normalizeProviderCapabilitySnapshotV1(inherited)).code,
    'exotic_prototype_denied',
  );
});

test('live and revoked proxies are denied with zero traps before reflection', () => {
  const live = countingProxy(p17Record('grok'));
  const liveError = errorOf(() => projectCapabilityRecordFromP17(live.proxy));
  assert.equal(liveError.code, 'proxy_denied');
  assert.equal(trapTotal(live.counts), 0);
  assert.equal(utilTypes.isProxy(live.proxy), true);

  const { proxy, revoke } = Proxy.revocable(p17Record('grok'), {
    get() { throw new Error('revoked getter ran'); },
    ownKeys() { throw new Error('revoked ownKeys ran'); },
  });
  revoke();
  const revokedError = errorOf(() => projectCapabilityRecordFromP17(proxy));
  assert.equal(revokedError.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);

  const snapshotProxy = countingProxy(capabilitySnapshot());
  const snapError = errorOf(() => normalizeProviderCapabilitySnapshotV1(snapshotProxy.proxy));
  assert.equal(snapError.code, 'proxy_denied');
  assert.equal(trapTotal(snapshotProxy.counts), 0);
});

test('getters and own undefined on capability records are denied without invoking accessors', () => {
  let reads = 0;
  const getterRecord = p17Record('grok');
  Object.defineProperty(getterRecord, 'notes', {
    enumerable: true,
    get() {
      reads += 1;
      return 'trap';
    },
  });
  assert.equal(errorOf(() => projectCapabilityRecordFromP17(getterRecord)).code, 'accessor_property_denied');
  assert.equal(reads, 0);

  const undefinedRecord = p17Record('grok');
  undefinedRecord.notes = undefined;
  assert.equal(errorOf(() => projectCapabilityRecordFromP17(undefinedRecord)).code, 'own_undefined_denied');
});

test('bridge schema identity is exact', () => {
  assert.equal(
    errorOf(() => projectCapabilityRecordFromP17(p17Record('grok', {
      schema: PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
    }))).code,
    'invalid_capability_schema',
  );
  const snapshot = capabilitySnapshot();
  snapshot.schema = PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID;
  assert.equal(
    errorOf(() => normalizeProviderCapabilitySnapshotV1(snapshot)).code,
    'invalid_capability_schema',
  );
});
