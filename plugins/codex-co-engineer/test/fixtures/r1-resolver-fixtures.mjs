// Shared P05 resolver/capability fixtures. Neutral construction only:
// tests own the assertions. These helpers never rank, default, or
// substitute a provider.

import {
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
  PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
  projectCapabilityRecordFromP17,
} from '../../mcp/v3/capability-bridge.mjs';
import { PROFILE_SCHEMA, profileProvenanceDigest, validateProfileDefinition } from '../../mcp/v3/profile.mjs';
import { CLOUD_STARTING_REF } from './r1-provider-model-fixtures.mjs';

export const PROVIDER_AVAILABILITY_SCHEMA_ID = 'codex-co-engineer.provider-availability.v1';

export { CLOUD_STARTING_REF };

export const BASE_SHA = CLOUD_STARTING_REF;

export const POLICY = Object.freeze({
  max_concurrency: 8,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});

export function capabilityFields(provider, overrides = {}) {
  const cloud = provider === 'cursor-cloud';
  const dsh = provider === 'dsh';
  return {
    artifact_kinds: ['provider_report'],
    create_pr_posture: cloud ? 'non_authoritative_cloud_only' : 'prohibited',
    dispatch_certainty: dsh ? 'uncertain_after_spawn' : 'confirmed_launch',
    exact_model_selection: 'exact_and_attested',
    merge_authority: 'none_codex_only_integration',
    notes: `${provider} fixture`,
    provider,
    replay_posture: 'never_replay',
    revision: 'p17.fixture.1',
    same_session_reply: (dsh || cloud) ? 'unsupported_unresolved_attention' : 'live_session_reply',
    workspace_semantics: cloud ? 'remote_provider_managed' : 'local_managed_worktree',
    workspace_starting_point: cloud ? 'pinned_pushed_sha' : 'run_base_sha',
    ...overrides,
  };
}

export function p17Record(provider, overrides = {}) {
  return {
    schema: PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
    ...capabilityFields(provider, overrides),
  };
}

export function projectedCapability(provider, overrides = {}) {
  return projectCapabilityRecordFromP17(p17Record(provider, overrides));
}

export function capabilitySnapshot(overridesByProvider = {}) {
  const providers = {
    'cursor-cloud': projectedCapability('cursor-cloud', overridesByProvider['cursor-cloud']),
    'cursor-local': projectedCapability('cursor-local', overridesByProvider['cursor-local']),
    dsh: projectedCapability('dsh', overridesByProvider.dsh),
    grok: projectedCapability('grok', overridesByProvider.grok),
  };
  for (const provider of Object.keys(overridesByProvider)) {
    if (overridesByProvider[provider] === null) delete providers[provider];
  }
  return {
    schema: PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_ID,
    providers,
  };
}

export function availabilitySnapshot(overrides = {}) {
  const providers = {
    'cursor-cloud': { status: 'available', models: ['claude-sonnet-4-5'] },
    'cursor-local': { status: 'available', models: ['composer-1'] },
    dsh: { status: 'available', models: null },
    grok: { status: 'available', models: ['grok-4'] },
    ...overrides,
  };
  for (const provider of Object.keys(providers)) {
    if (providers[provider] === null) delete providers[provider];
  }
  return {
    schema: PROVIDER_AVAILABILITY_SCHEMA_ID,
    providers,
  };
}

export function profileRecord(name, definition, scope = 'project') {
  const validated = validateProfileDefinition(name, {
    schema: PROFILE_SCHEMA,
    ...definition,
  });
  return {
    name,
    scope,
    source: `/tmp/${scope}/${name}.json`,
    definition: validated,
    digest: profileProvenanceDigest({ name, definition: validated }),
  };
}

export function profileCatalog(records) {
  return { profiles: records };
}

export function reviewer(id, kind = 'omitted') {
  const assignment = {
    assignment_id: id,
    role: 'review',
    access: 'read_only',
    prompt: `Review lane ${id}.`,
    write_scope: [],
    acceptance: [],
    expected_duration_ms: 600_000,
    required_evidence: ['provider_report', 'git_identity'],
  };
  if (kind === 'explicit') {
    assignment.execution = { provider: 'dsh', model: 'stealth/ox-alpha' };
  } else if (kind === 'profile') {
    assignment.execution = { profile: 'deep-security-review' };
  } else if (kind === 'grok') {
    assignment.execution = { provider: 'grok', model: 'grok-4' };
  }
  return assignment;
}

export function writer(id, scopes, execution) {
  const assignment = {
    assignment_id: id,
    role: 'implement',
    access: 'writer',
    prompt: `Implement lane ${id}.`,
    write_scope: scopes,
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
  };
  if (execution !== undefined) assignment.execution = execution;
  return assignment;
}

export function runManifest(assignments, overrides = {}) {
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'selection-resolution-run',
    repository: { path: '/repos/demo', base_sha: BASE_SHA },
    objective: 'Resolve omitted and profile lanes without ranking or fallback.',
    assignments,
    policy: { ...POLICY },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
    ...overrides,
  };
}

export function countingProxy(target) {
  const counts = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0, apply: 0 };
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      counts.get += 1;
      return Reflect.get(inner, property, receiver);
    },
    ownKeys(inner) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, property) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
    has(inner, property) {
      counts.has += 1;
      return Reflect.has(inner, property);
    },
    apply(inner, thisArg, args) {
      counts.apply += 1;
      return Reflect.apply(inner, thisArg, args);
    },
  });
  return { proxy, counts };
}

export function trapTotal(counts) {
  return counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has + counts.apply;
}

export function resolveInputs(manifest, extra = {}) {
  return {
    manifest,
    availability: availabilitySnapshot(),
    capabilities: capabilitySnapshot(),
    ...extra,
  };
}
