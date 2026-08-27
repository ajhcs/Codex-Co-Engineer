// Inert P22 future-harness conformance fixtures. Fake identities and
// scripted drivers only. Callers inject every identity; nothing reads the
// clock, network, credentials, or process table.

import { FUTURE_HARNESS_FAIL_CLOSED_FEATURES } from '../../mcp/v3/future-harness.mjs';
import { childEnvelopeDigestV1 } from '../../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../../mcp/v3/prompt-compiler.mjs';
import {
  DRIVER_DECLARATION_SCHEMA_ID,
  DRIVER_RESULT_SCHEMA_IDS,
  PROVIDER_DRIVER_VERSION,
} from '../../mcp/v3/provider-driver.mjs';
import { p17Record } from './r1-resolver-fixtures.mjs';

export const FUTURE_HARNESS_FIXTURE_BASE_SHA = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1';
export const FUTURE_HARNESS_FIXTURE_REPOSITORY_PATH = '/repo/future-harness-conformance';
export const FUTURE_HARNESS_FIXTURE_RUN_ID = 'future-harness-kit';
export const FUTURE_HARNESS_FIXTURE_ASSIGNMENT_ID = 'contract-lane';
export const FUTURE_HARNESS_FIXTURE_REQUEST_ID = 'req-conformance-1';
export const FUTURE_HARNESS_FIXTURE_BRANCH = 'codex-co-engineer/future-harness-kit';
export const FUTURE_HARNESS_SECRET_CANARY = 'sk-leakedsecretvalue';
export const FUTURE_HARNESS_PATH_CANARY = '/opt/secret-user/.ssh/id_ed25519';

const PROVIDER_MODELS = Object.freeze({
  grok: 'grok-4',
  'cursor-local': 'composer-1',
  'cursor-cloud': 'claude-sonnet-4-5',
  dsh: 'stealth/ox-alpha',
});

export function futureHarnessFailClosedDeclarationV1(provider, capabilityOverrides = {}) {
  return {
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: p17Record(provider, {
      create_pr_posture: 'prohibited',
      notes: `${provider} future-harness fail-closed fixture`,
      revision: 'p22.fixture.1',
      ...capabilityOverrides,
    }),
    features: { ...FUTURE_HARNESS_FAIL_CLOSED_FEATURES },
  };
}

export function futureHarnessSupportedDeclarationV1(provider, featureOverrides = {}, capabilityOverrides = {}) {
  return {
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: p17Record(provider, {
      create_pr_posture: 'prohibited',
      notes: `${provider} future-harness supported-feature fixture`,
      revision: 'p22.fixture.1',
      ...capabilityOverrides,
    }),
    features: {
      cancellation: 'supported',
      detailed_events: 'supported',
      live_progress: 'supported',
      restart: 'reconcile_reattach_only',
      ...featureOverrides,
    },
  };
}

export function buildFutureHarnessFixtureV1(provider = 'dsh', overrides = {}) {
  const model = overrides.model ?? PROVIDER_MODELS[provider];
  const baseSha = overrides.base_sha ?? FUTURE_HARNESS_FIXTURE_BASE_SHA;
  const assignment = {
    assignment_id: FUTURE_HARNESS_FIXTURE_ASSIGNMENT_ID,
    role: 'implement',
    access: 'writer',
    prompt: 'Implement the future-harness contract lane exactly.',
    execution: { provider, model },
    write_scope: ['mcp/**'],
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
  };
  if (provider === 'cursor-cloud') assignment.starting_ref = baseSha;
  const manifest = Object.freeze({
    schema: 'codex-co-engineer.run.v1',
    run_id: FUTURE_HARNESS_FIXTURE_RUN_ID,
    repository: Object.freeze({
      path: FUTURE_HARNESS_FIXTURE_REPOSITORY_PATH,
      base_sha: baseSha,
    }),
    objective: 'Exercise the P22 future-harness conformance kit.',
    assignments: Object.freeze([Object.freeze(assignment)]),
    policy: Object.freeze({
      max_concurrency: 8,
      require_same_base: true,
      require_disjoint_writer_scopes: true,
      allow_post_dispatch_fallback: false,
      allow_merge: false,
      allow_create_pr: false,
      attention_mode: 'aggregate',
      completion_mode: 'all_settled_then_verify',
    }),
    return_contract: Object.freeze({ mode: 'verified_decision', include_artifact_refs: true }),
  });
  const envelope = compileChildEnvelopeV1(manifest, FUTURE_HARNESS_FIXTURE_ASSIGNMENT_ID);
  const identity = Object.freeze({
    provider,
    model,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    request_id: FUTURE_HARNESS_FIXTURE_REQUEST_ID,
    branch: FUTURE_HARNESS_FIXTURE_BRANCH,
    base_sha: envelope.repository.base_sha,
    workspace_semantics: provider === 'cursor-cloud' ? 'remote_provider_managed' : 'local_managed_worktree',
    workspace_starting_point: provider === 'cursor-cloud' ? 'pinned_pushed_sha' : 'run_base_sha',
  });
  return Object.freeze({
    manifest,
    envelope,
    identity,
    envelope_text: envelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
  });
}

export function futureHarnessTemplateOptionsV1(provider = 'dsh', declarationOverrides = {}) {
  const fixture = buildFutureHarnessFixtureV1(provider);
  return Object.freeze({
    fixture,
    options: Object.freeze({
      identity: fixture.identity,
      declaration: futureHarnessFailClosedDeclarationV1(provider, declarationOverrides),
    }),
  });
}

function detailFor(operation, disposition) {
  if (operation === 'preflight' && disposition === 'blocked') {
    return {
      detail_code: 'model_unattested',
      detail_message: 'The installed driver cannot attest the requested model.',
    };
  }
  if (operation === 'launch' && disposition === 'not_sent') {
    return {
      detail_code: 'transport_unavailable',
      detail_message: 'No provider transport is configured.',
    };
  }
  return {};
}

export function scriptedFutureHarnessResultV1(operation, request, fixture, disposition, extra = {}) {
  return {
    schema: DRIVER_RESULT_SCHEMA_IDS[operation],
    version: PROVIDER_DRIVER_VERSION,
    run_id: fixture.identity.run_id,
    assignment_id: fixture.identity.assignment_id,
    lane_index: fixture.identity.lane_index,
    base_sha: fixture.identity.base_sha,
    child_envelope_digest: request.child_envelope_digest,
    disposition,
    ...detailFor(operation, disposition),
    ...extra,
  };
}

export function createScriptedFutureHarnessDriverV1(fixture, dispositions = {}) {
  const chosen = {
    preflight: 'ready',
    launch: 'dispatch_uncertain',
    reconcile: 'terminal',
    cancel: 'already_terminal',
    ...dispositions,
  };
  let terminal = false;
  return {
    preflight: (request) => scriptedFutureHarnessResultV1(
      'preflight', request, fixture, chosen.preflight,
    ),
    launch: (request) => scriptedFutureHarnessResultV1(
      'launch', request, fixture, chosen.launch,
    ),
    reconcile: (request) => {
      const disposition = terminal ? 'terminal' : chosen.reconcile;
      if (disposition === 'terminal') terminal = true;
      return scriptedFutureHarnessResultV1('reconcile', request, fixture, disposition);
    },
    cancel: (request) => {
      const disposition = terminal ? 'already_terminal' : chosen.cancel;
      if (disposition === 'already_terminal' || disposition === 'cancel_confirmed') {
        terminal = true;
      }
      return scriptedFutureHarnessResultV1('cancel', request, fixture, disposition);
    },
  };
}
