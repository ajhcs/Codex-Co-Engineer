// Scripted local Cursor transport fixtures for the P19 cursor-local driver
// tests. Neutral construction only: the fixtures record every transport
// call and script closed outcomes; the tests own every assertion.
//
// The fixture never touches a real Cursor CLI, network, or repository. It
// exists so the driver's lifecycle, identity binding, redaction bounds,
// and content-free error surfaces can be exercised offline.

import { childEnvelopeDigestV1 } from '../../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../../mcp/v3/prompt-compiler.mjs';
import { p17Record } from './r1-resolver-fixtures.mjs';

export const DRIVER_DECLARATION_SCHEMA_ID = 'codex-co-engineer.driver-declaration.v1';
export const CURSOR_LOCAL_FIXTURE_BASE_SHA = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c2';
export const CURSOR_LOCAL_FIXTURE_REPOSITORY_PATH = '/opt/codex-co-engineer-driver-contract/local-worktree';
export const CURSOR_LOCAL_FIXTURE_RUN_ID = 'cursor-local-driver-spec';
export const CURSOR_LOCAL_FIXTURE_ASSIGNMENT_ID = 'local-lane';
export const CURSOR_LOCAL_FIXTURE_MODEL = 'composer-1';
export const FIXTURE_SESSION_PREFIX = 'sess-local-';
export const FIXTURE_QUESTION_ID = 'q-attn-1';
export const FIXTURE_QUESTION_TEXT = 'Approve writing the integration spec?';

// A secret-shaped payload used to prove redaction; never a real value.
export const SECRET_BEARER_TOKEN = 'Bearer sk-live-abcdef0123456789';
export const SECRET_API_KEY_PAIR = 'api_key = "super-secret-value-1234567890"';
export const SECRET_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
export const SECRET_SPLIT_HEAD = 'Bearer sk-li';
export const SECRET_SPLIT_TAIL = 've-9988776655443322';

export function buildCursorLocalFixtureV1(overrides = {}) {
  const manifest = Object.freeze({
    schema: 'codex-co-engineer.run.v1',
    run_id: overrides.run_id ?? CURSOR_LOCAL_FIXTURE_RUN_ID,
    repository: Object.freeze({
      path: overrides.repository_path ?? CURSOR_LOCAL_FIXTURE_REPOSITORY_PATH,
      base_sha: overrides.base_sha ?? CURSOR_LOCAL_FIXTURE_BASE_SHA,
    }),
    objective: 'Exercise the cursor-local driver end to end offline.',
    assignments: Object.freeze([Object.freeze({
      assignment_id: overrides.assignment_id ?? CURSOR_LOCAL_FIXTURE_ASSIGNMENT_ID,
      role: 'implement',
      access: 'writer',
      prompt: 'Implement the lane exactly as instructed by the envelope.',
      execution: Object.freeze({
        provider: overrides.provider ?? 'cursor-local',
        model: overrides.model ?? CURSOR_LOCAL_FIXTURE_MODEL,
      }),
      write_scope: Object.freeze(['docs/**']),
      acceptance: Object.freeze([Object.freeze({
        command_id: 'unit-tests', timeout_ms: 600_000,
      })]),
      expected_duration_ms: 1_200_000,
      required_evidence: Object.freeze(['provider_report']),
    })]),
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
  const assignmentId = overrides.assignment_id ?? CURSOR_LOCAL_FIXTURE_ASSIGNMENT_ID;
  const envelope = compileChildEnvelopeV1(manifest, assignmentId);
  return Object.freeze({
    manifest,
    envelope,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    base_sha: envelope.repository.base_sha,
    repository_path: envelope.repository.path,
    provider: envelope.execution.provider,
    model: envelope.execution.model,
    envelope_text: envelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
  });
}

export function cursorLocalDeclaration(capabilityOverrides = {}, featureOverrides = {}) {
  return {
    schema: DRIVER_DECLARATION_SCHEMA_ID,
    capability: p17Record('cursor-local', capabilityOverrides),
    features: {
      cancellation: 'supported',
      detailed_events: 'supported',
      live_progress: 'supported',
      restart: 'reconcile_reattach_only',
      ...featureOverrides,
    },
  };
}

function cloneRequest(request) {
  // Requests are validated direct JSON by the time they reach the
  // transport; a shallow structured copy is enough for call records.
  if (request === null || typeof request !== 'object') return request;
  const clone = {};
  for (const key of Object.keys(request)) {
    const value = request[key];
    clone[key] = (value !== null && typeof value === 'object')
      ? JSON.parse(JSON.stringify(value))
      : value;
  }
  return clone;
}

class TransportFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransportFailure';
    this.code = code;
  }
}

// Build a scripted transport plus its call record. `scenario` selects the
// closed outcome sequence; `overrides` replaces individual methods for
// targeted hostile cases.
export function createCursorLocalTransportStub(scenario = 'happy', overrides = {}) {
  const state = {
    acks: 0,
    availabilityCalls: 0,
    bindingEchoCorrupt: overrides.binding_echo_corrupt === true,
    cancelCalls: 0,
    cancels: [],
    completedAfter: overrides.completed_after ?? (scenario === 'attention' ? 3 : 2),
    observes: 0,
    observeResults: [],
    questionAnswered: false,
    replies: 0,
    replyRecords: [],
    sends: 0,
    sendRecords: [],
    sessionCounter: 0,
    spawnCalls: 0,
    spawnRecords: [],
  };
  const calls = [];
  const record = (method, request) => calls.push({ method, request: cloneRequest(request) });
  const sessionIdFor = () => `${FIXTURE_SESSION_PREFIX}${state.spawnCalls}`;
  const binding = (request, fallback) => (state.bindingEchoCorrupt
    ? 'sha256:' + 'f'.repeat(64)
    : (request?.binding_digest ?? fallback));

  const methods = {
    availability() {
      state.availabilityCalls += 1;
      record('availability', {});
      if (scenario === 'unavailable') return { available: false };
      if (scenario === 'availability_failure') {
        throw new TransportFailure(undefined, 'availability probe exploded');
      }
      return { available: true };
    },
    spawn(request) {
      state.spawnCalls += 1;
      state.sessionCounter = state.spawnCalls;
      record('spawn', request);
      state.spawnRecords.push(cloneRequest(request));
      if (scenario === 'spawn_failure') throw new Error(`spawn pipe broke: ${SECRET_BEARER_TOKEN}`);
      return {
        binding_digest: binding(request),
        session_id: sessionIdFor(),
      };
    },
    send(request) {
      state.sends += 1;
      record('send', request);
      state.sendRecords.push(cloneRequest(request));
      if (scenario === 'pre_write_failure') {
        throw new TransportFailure('pre_write_failure', 'nothing was written');
      }
      if (scenario === 'ambiguous_send') throw new Error('connection reset mid-write');
      if (scenario === 'send_getter_bomb') {
        throw new TransportFailure(undefined, `boom ${SECRET_API_KEY_PAIR}`);
      }
      state.acks += 1;
      return { acknowledged: true, binding_digest: binding(request), session_id: request.session_id };
    },
    observe(request) {
      state.observes += 1;
      record('observe', request);
      if (scenario === 'session_lost' && state.observes === 1) {
        return {
          binding_digest: binding(request),
          events: ['progress line'],
          session_id: request.session_id,
          status: 'running',
        };
      }
      if (scenario === 'wrong_binding_echo' && state.observes === 1) {
        return { binding_digest: 'sha256:' + '0'.repeat(64), session_id: request.session_id, status: 'running' };
      }
      if (scenario === 'observe_throws') throw new Error(`observe died ${SECRET_AWS_KEY}`);
      const index = state.observes;
      state.observeResults.push(index);
      if (scenario === 'attention') {
        if (index === 1) {
          return {
            binding_digest: binding(request),
            question: { question_id: FIXTURE_QUESTION_ID, question_text: FIXTURE_QUESTION_TEXT },
            session_id: request.session_id,
            status: 'attention',
          };
        }
        if (!state.questionAnswered && index > 1) {
          return {
            binding_digest: binding(request),
            question: { question_id: FIXTURE_QUESTION_ID, question_text: FIXTURE_QUESTION_TEXT },
            session_id: request.session_id,
            status: 'attention',
          };
        }
        const wantsProgress = Array.isArray(request.include)
          && request.include.includes('live_progress');
        return {
          binding_digest: binding(request),
          ...(wantsProgress
            ? { progress_text: index >= state.completedAfter ? 'spec approved and drafted' : 'drafting' }
            : {}),
          session_id: request.session_id,
          status: index >= state.completedAfter ? 'completed' : 'running',
        };
      }
      if (scenario === 'cancel_requested_flow') {
        const wantsProgress = Array.isArray(request.include)
          && request.include.includes('live_progress');
        return {
          binding_digest: binding(request),
          ...(wantsProgress
            ? { progress_text: index === 1 ? 'winding down' : 'stopped' } : {}),
          session_id: request.session_id,
          status: index >= 2 ? 'completed' : 'running',
        };
      }
      if (scenario === 'secret_chunks') {
        if (index === 1) {
          return {
            binding_digest: binding(request),
            events: [
              `${SECRET_SPLIT_HEAD}`,
              `${SECRET_SPLIT_TAIL} rotated`,
              `key material ${SECRET_API_KEY_PAIR}`,
              `aws ${SECRET_AWS_KEY} leaked`,
              '😀😀😀 multi-byte tail 😀',
            ],
            progress_text: 'streaming chunks',
            session_id: request.session_id,
            status: 'running',
          };
        }
        const wantsEvents = Array.isArray(request.include)
          && request.include.includes('detailed_events');
        return {
          binding_digest: binding(request),
          ...(wantsEvents
            ? { events: [`final chunk carries ${SECRET_SPLIT_HEAD}`, `${SECRET_SPLIT_TAIL} across calls`] }
            : {}),
          session_id: request.session_id,
          status: 'completed',
        };
      }
      if (scenario === 'flood') {
        const wantsEvents = Array.isArray(request.include)
          && request.include.includes('detailed_events');
        const wantsProgress = Array.isArray(request.include)
          && request.include.includes('live_progress');
        return {
          binding_digest: binding(request),
          ...(wantsEvents
            ? {
              events: Array.from(
                { length: 40 },
                (_, i) => `chunk-${i} ${SECRET_BEARER_TOKEN}`.concat(' x'.repeat(400)),
              ),
            }
            : {}),
          ...(wantsProgress ? { progress_text: 'x'.repeat(120_000) } : {}),
          session_id: request.session_id,
          status: index >= 2 ? 'completed' : 'running',
        };
      }
      const wantsProgress = Array.isArray(request.include)
        && request.include.includes('live_progress');
      return {
        binding_digest: binding(request),
        ...(wantsProgress
          ? { progress_text: index >= state.completedAfter ? 'lane finished' : 'working' }
          : {}),
        session_id: request.session_id,
        status: index >= state.completedAfter ? 'completed' : 'running',
      };
    },
    cancel(request) {
      state.cancelCalls += 1;
      record('cancel', request);
      state.cancels.push(cloneRequest(request));
      if (scenario === 'cancel_requested_flow') {
        return { binding_digest: binding(request), outcome: 'requested', session_id: request.session_id };
      }
      return { binding_digest: binding(request), outcome: 'confirmed', session_id: request.session_id };
    },
    reply(request) {
      state.replies += 1;
      record('reply', request);
      state.replyRecords.push(cloneRequest(request));
      if (scenario === 'reply_fails_once') throw new Error('reply pipe broke');
      state.questionAnswered = true;
      return { answered: true, binding_digest: binding(request), session_id: request.session_id };
    },
  };

  const transport = { ...methods, ...overrides.transport };
  return { calls, state, transport };
}

// Getter-bearing hostile result helpers: reading any field through these
// objects would trip the counters. The driver must reject them with zero
// counter increments.
export function getterBombResult(base, counter, key = 'status') {
  const result = { ...base };
  delete result[key];
  Object.defineProperty(result, key, {
    enumerable: true,
    get() {
      counter.reads += 1;
      return base[key];
    },
  });
  return result;
}
