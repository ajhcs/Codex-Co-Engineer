// Deterministic injected Grok ACP transport for P18 tests.
// Records closed operation requests and plays scripted receipts or failures.
// This is not a live Grok client.

import { RunContractV1Error } from '../../mcp/v3/run-manifest.mjs';
import { childEnvelopeDigestV1 } from '../../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../../mcp/v3/prompt-compiler.mjs';

export const GROK_FIXTURE_BASE_SHA = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1';
export const GROK_FIXTURE_REPOSITORY_PATH = '/opt/codex-co-engineer-grok-acp/suite';
export const GROK_FIXTURE_RUN_ID = 'grok-acp-driver-suite';
export const GROK_FIXTURE_ASSIGNMENT_ID = 'grok-lane';
export const GROK_FIXTURE_MODEL = 'grok-4';
export const GROK_FIXTURE_SESSION_ID = 'sess-grok-acp-1';

export function buildGrokDriverFixtureV1(overrides = {}) {
  const assignment = {
    assignment_id: GROK_FIXTURE_ASSIGNMENT_ID,
    role: 'implement',
    access: 'writer',
    prompt: 'Implement the Grok ACP lane exactly as instructed by the envelope.',
    execution: { provider: 'grok', model: GROK_FIXTURE_MODEL },
    write_scope: ['mcp/**'],
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
    ...overrides.assignment,
  };
  const manifest = Object.freeze({
    schema: 'codex-co-engineer.run.v1',
    run_id: GROK_FIXTURE_RUN_ID,
    repository: Object.freeze({
      path: GROK_FIXTURE_REPOSITORY_PATH,
      base_sha: GROK_FIXTURE_BASE_SHA,
    }),
    objective: 'Exercise the Grok ACP ProviderDriverV1 adapter end to end.',
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
  const envelope = compileChildEnvelopeV1(manifest, GROK_FIXTURE_ASSIGNMENT_ID);
  return Object.freeze({
    manifest,
    envelope,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    base_sha: envelope.repository.base_sha,
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
    repository_path: request.repository_path,
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
    value.path ?? 'grok_acp_transport',
    value.message ?? 'Scripted Grok ACP transport failure.',
  );
  if (value.spawned === true) error.spawned = true;
  return error;
}

const TRANSPORT_CALLS = new WeakMap();

export function createScriptedGrokAcpTransportV1(script = {}) {
  const calls = [];
  let sessionId = script.session_id ?? GROK_FIXTURE_SESSION_ID;
  let requestId;

  function record(operation, request) {
    calls.push({ operation, request });
  }

  function play(name, request, buildDefault) {
    record(name, request);
    const next = takeScripted(script, name);
    if (next.kind === 'default') return buildDefault();
    const value = next.value;
    if (typeof value === 'function') return value(request, { sessionId, requestId, calls });
    if (value === 'default') return buildDefault();
    if (value?.throw) throw asError(value.throw);
    if (value?.fail) throw asError(value.fail);
    return value;
  }

  const transport = {
    preflight: (request) => play('preflight', request, () => ({
      ok: true,
      ...identityFromRequest(request),
    })),
    spawn: (request) => play('spawn', request, () => ({
      spawned: true,
      session_id: sessionId,
      ...identityFromRequest(request),
    })),
    dispatch: (request) => play('dispatch', request, () => {
      requestId = request.request_id;
      sessionId = request.session_id ?? sessionId;
      return {
        acknowledged: true,
        session_id: sessionId,
        request_id: requestId,
        provider: request.provider,
        model: request.model,
        run_id: request.run_id,
        assignment_id: request.assignment_id,
        lane_index: request.lane_index,
        base_sha: request.base_sha,
        child_envelope_digest: request.child_envelope_digest,
      };
    }),
    observe: (request) => play('observe', request, () => ({
      session_id: request.session_id ?? sessionId,
      status: 'completed',
      ...identityFromRequest(request),
    })),
    cancel: (request) => play('cancel', request, () => ({
      outcome: 'cancel_confirmed',
      session_id: request.session_id ?? sessionId,
      ...identityFromRequest(request),
    })),
    reattach: (request) => play('reattach', request, () => ({
      reattached: true,
      session_id: request.session_id ?? sessionId,
      ...identityFromRequest(request),
    })),
  };
  TRANSPORT_CALLS.set(transport, calls);
  return transport;
}

export function grokAcpTransportCalls(transport) {
  return TRANSPORT_CALLS.get(transport) ?? [];
}

export function grokAcpCallsOf(transport, operation) {
  return grokAcpTransportCalls(transport).filter((entry) => entry.operation === operation);
}
