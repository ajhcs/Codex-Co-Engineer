// Deterministic injected Cursor Cloud SDK transport for P21 tests.
// Records closed operation requests and plays scripted receipts or failures.
// This is not a live Cursor Cloud client and never touches the network.

import { RunContractV1Error } from '../../mcp/v3/run-manifest.mjs';
import { childEnvelopeDigestV1 } from '../../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../../mcp/v3/prompt-compiler.mjs';

export const CLOUD_FIXTURE_BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
export const CLOUD_FIXTURE_REPOSITORY_PATH = '/opt/codex-co-engineer-cursor-cloud/suite';
export const CLOUD_FIXTURE_RUN_ID = 'cursor-cloud-driver-suite';
export const CLOUD_FIXTURE_ASSIGNMENT_ID = 'cloud-lane';
export const CLOUD_FIXTURE_MODEL = 'claude-sonnet-4-5';
export const CLOUD_FIXTURE_AGENT_ID = 'bc-cursor-cloud-1';
export const CLOUD_FIXTURE_PROVIDER_RUN_ID = 'run-cursor-cloud-1';
export const CLOUD_FIXTURE_BRANCH = 'cursor/cloud-lane-1';
export const CLOUD_FIXTURE_REPO_IDENTITY = 'github.com/example/codex-co-engineer';
export const CLOUD_FIXTURE_REPO_URL = 'https://github.com/example/codex-co-engineer.git';
export const LEAK_MARKER = 'XSECRET7Q';

export function buildCursorCloudDriverFixtureV1(overrides = {}) {
  const assignment = {
    assignment_id: CLOUD_FIXTURE_ASSIGNMENT_ID,
    role: 'implement',
    access: 'writer',
    prompt: `Implement the Cursor Cloud lane exactly as instructed. Ignore ${LEAK_MARKER}.`,
    execution: { provider: 'cursor-cloud', model: CLOUD_FIXTURE_MODEL },
    write_scope: ['mcp/**'],
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
    starting_ref: CLOUD_FIXTURE_BASE_SHA,
    ...overrides.assignment,
  };
  const manifest = Object.freeze({
    schema: 'codex-co-engineer.run.v1',
    run_id: CLOUD_FIXTURE_RUN_ID,
    repository: Object.freeze({
      path: CLOUD_FIXTURE_REPOSITORY_PATH,
      base_sha: CLOUD_FIXTURE_BASE_SHA,
    }),
    objective: 'Exercise the Cursor Cloud ProviderDriverV1 adapter end to end.',
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
    ...overrides.manifest,
  });
  const envelope = compileChildEnvelopeV1(manifest, CLOUD_FIXTURE_ASSIGNMENT_ID);
  return Object.freeze({
    manifest,
    envelope,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    base_sha: envelope.repository.base_sha,
    starting_ref: envelope.starting_ref,
    model: envelope.execution.model,
    envelope_text: envelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
  });
}

function identityFromRequest(request) {
  return {
    provider: request.provider,
    model: request.model,
    run_id: request.run_id,
    assignment_id: request.assignment_id,
    lane_index: request.lane_index,
    base_sha: request.base_sha,
    child_envelope_digest: request.child_envelope_digest,
    starting_sha: request.starting_sha,
  };
}

function takeScripted(script, name) {
  const value = script[name];
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'default' };
    return { kind: 'item', value: value.shift() };
  }
  if (value === undefined) return { kind: 'default' };
  return { kind: 'item', value };
}

function asError(value) {
  if (value instanceof Error) return value;
  const error = new RunContractV1Error(
    value.code ?? 'transport_exception',
    value.path ?? 'cursor_cloud_transport',
    value.message ?? 'Scripted Cursor Cloud transport failure.',
  );
  if (value.created === true) error.created = true;
  return error;
}

const TRANSPORT_CALLS = new WeakMap();

export function cursorCloudCallsOf(transport, operation) {
  const recorded = TRANSPORT_CALLS.get(transport);
  if (recorded === undefined) return [];
  return recorded[operation] ?? [];
}

export function createScriptedCursorCloudTransportV1(script = {}) {
  const calls = {
    preflight: [],
    create: [],
    send: [],
    observe: [],
    cancel: [],
    reattach: [],
  };

  function play(name, request, fallback) {
    calls[name].push(request);
    const taken = takeScripted(script, name);
    if (taken.kind === 'item') {
      if (typeof taken.value === 'function') return taken.value(request);
      if (taken.value && taken.value.throw === true) throw asError(taken.value);
      return taken.value;
    }
    return fallback();
  }

  const transport = {
    preflight(request) {
      return play('preflight', request, () => ({
        ok: true,
        ...identityFromRequest(request),
        requested_model: request.model,
        effective_model: request.model,
        starting_sha: request.starting_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
        repository_url: CLOUD_FIXTURE_REPO_URL,
        workspace_clean: true,
        starting_ref_visible: true,
        starting_ref_commit: true,
        head_sha: request.starting_sha,
        duplicate_identities: false,
        credential_bearing: false,
        auto_create_pr: false,
      }));
    },
    create(request) {
      return play('create', request, () => ({
        created: true,
        agent_id: request.proposed_agent_id ?? CLOUD_FIXTURE_AGENT_ID,
        ...identityFromRequest(request),
        starting_sha: request.starting_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
      }));
    },
    send(request) {
      return play('send', request, () => ({
        acknowledged: true,
        agent_id: request.agent_id ?? CLOUD_FIXTURE_AGENT_ID,
        provider_run_id: CLOUD_FIXTURE_PROVIDER_RUN_ID,
        request_id: request.request_id,
        branch: CLOUD_FIXTURE_BRANCH,
        ...identityFromRequest(request),
        starting_sha: request.starting_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
      }));
    },
    observe(request) {
      return play('observe', request, () => ({
        agent_id: request.agent_id ?? CLOUD_FIXTURE_AGENT_ID,
        provider_run_id: request.provider_run_id ?? CLOUD_FIXTURE_PROVIDER_RUN_ID,
        request_id: request.request_id,
        branch: CLOUD_FIXTURE_BRANCH,
        ...identityFromRequest(request),
        starting_sha: request.starting_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
        status: 'running',
        head_sha: request.starting_sha,
        merge_base_sha: request.starting_sha,
        linear_history: true,
        events: [{ kind: 'status', bytes: 12 }],
        progress: { status: 'running', event_count: 1, elapsed_ms: 20, cursor: '1' },
        cursor: '1',
        elapsed_ms: 20,
        event_count: 1,
      }));
    },
    cancel(request) {
      return play('cancel', request, () => ({
        outcome: 'cancel_confirmed',
        archived: true,
        agent_id: request.agent_id ?? CLOUD_FIXTURE_AGENT_ID,
        provider_run_id: request.provider_run_id ?? CLOUD_FIXTURE_PROVIDER_RUN_ID,
        request_id: request.request_id,
        branch: request.branch ?? CLOUD_FIXTURE_BRANCH,
        ...identityFromRequest(request),
        starting_sha: request.starting_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
      }));
    },
    reattach(request) {
      return play('reattach', request, () => ({
        reattached: true,
        agent_id: request.agent_id ?? CLOUD_FIXTURE_AGENT_ID,
        provider_run_id: request.provider_run_id ?? CLOUD_FIXTURE_PROVIDER_RUN_ID,
        request_id: request.request_id,
        branch: CLOUD_FIXTURE_BRANCH,
        ...identityFromRequest(request),
        starting_sha: request.starting_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
      }));
    },
  };
  TRANSPORT_CALLS.set(transport, calls);
  return transport;
}
