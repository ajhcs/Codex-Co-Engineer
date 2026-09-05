// Shared P20 DSH ACPX driver fixtures. Neutral construction only: tests own
// every assertion. The fake transport here is a deterministic injected
// bounded one-shot ACPX port; it never touches a real provider, process,
// filesystem, or network, and it exposes exactly the closed five-function
// surface the driver validates.

import { createDshApxDriverV1 } from '../../mcp/v3/dsh-acpx-driver.mjs';
import { childEnvelopeDigestV1 } from '../../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../../mcp/v3/prompt-compiler.mjs';
import { DRIVER_OPERATION_SCHEMA_IDS } from '../../mcp/v3/provider-driver.mjs';

export const DSH_BASE_SHA = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';
export const DSH_REPOSITORY_PATH = '/opt/codex-co-engineer-dsh-driver/smoke';
export const DSH_RUN_ID = 'dsh-acpx-smoke';

export const MUSE_MODEL = 'meta/muse-spark-1.3-contributor';
export const OX_MODEL = 'stealth/ox-alpha';

// Marker used to prove prompt/question content never reaches driver outputs.
export const LEAK_MARKER = 'XSECRET7Q';

const POLICY = Object.freeze({
  max_concurrency: 8,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});

export function dshManifest(model, assignmentId = 'dsh-lane') {
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: DSH_RUN_ID,
    repository: { path: DSH_REPOSITORY_PATH, base_sha: DSH_BASE_SHA },
    objective: `Drive the ${model} lane under the bounded run contract.`,
    assignments: [{
      assignment_id: assignmentId,
      role: 'implement',
      access: 'writer',
      prompt: `Implement the ${assignmentId} lane. Ignore ${LEAK_MARKER} markers.`,
      execution: { provider: 'dsh', model },
      write_scope: ['src/**'],
      acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
      expected_duration_ms: 1_200_000,
      required_evidence: ['provider_report', 'git_diff'],
    }],
    policy: POLICY,
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  };
}

export function dshEnvelope(model, assignmentId = 'dsh-lane') {
  const envelope = compileChildEnvelopeV1(dshManifest(model, assignmentId), assignmentId);
  return Object.freeze({
    envelope,
    envelope_text: envelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
    run_id: envelope.run_id,
    assignment_id: envelope.assignment_id,
    lane_index: envelope.lane_index,
    base_sha: envelope.repository.base_sha,
  });
}

export const IDENTITY_CONFIG_PATH = '/home/test-user/.config/codex-co-engineer/dsh-acp.yml';
export const IDENTITY_CONFIG_SHA = 'a'.repeat(64);
export const IDENTITY_CREDENTIAL_SOURCE = 'env';
export const IDENTITY_CREDENTIAL_SHA = 'b'.repeat(64);

export function readyIdentity(overrides = {}) {
  return {
    ready: true,
    config_path: IDENTITY_CONFIG_PATH,
    config_sha256: IDENTITY_CONFIG_SHA,
    credential_source: IDENTITY_CREDENTIAL_SOURCE,
    credential_sha256: IDENTITY_CREDENTIAL_SHA,
    ...overrides,
  };
}

// Deterministic recorded-evidence fake of an ACPX one-shot port. Every knob
// is optional; defaults produce a healthy Muse lane that dispatches once and
// then reports running evidence with bounded status pages.
//
// Returns { port, calls, counts(), nextSeq() } where `port` is exactly the
// closed five-function transport record and the rest is test introspection
// kept OUTSIDE the validated surface.
export function fakeDshTransport({
  identity = readyIdentity(),
  spawnReceipts,
  polls,
  eventPages,
  cancelReceipts,
  throwOnSpawn,
  throwOnPoll,
  throwOnEvents,
  throwOnCancel,
  throwOnIdentity,
  recordCalls = true,
} = {}) {
  let identityCalls = 0;
  let spawnCalls = 0;
  let pollCalls = 0;
  let eventCalls = 0;
  let cancelCalls = 0;
  let seq = 0;
  const calls = { configIdentity: [], spawn: [], poll: [], events: [], cancel: [] };
  const pick = (list, index, label) => {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const value = list[Math.min(index, list.length - 1)];
    if (value === undefined) throw new Error(`fixture missing ${label}[${index}]`);
    return value;
  };
  const correlationEcho = (request) => ({ session_ref: request.session_ref, ...request.correlation });
  const port = {
    configIdentity(request) {
      identityCalls += 1;
      if (recordCalls) calls.configIdentity.push(request);
      if (throwOnIdentity) throw throwOnIdentity(identityCalls);
      if (typeof identity === 'function') return identity(identityCalls, request);
      const entry = Array.isArray(identity)
        ? pick(identity, identityCalls - 1, 'identity')
        : identity;
      return entry === undefined ? undefined : { ...entry };
    },
    spawn(request) {
      spawnCalls += 1;
      if (recordCalls) calls.spawn.push(request);
      if (throwOnSpawn) throw throwOnSpawn(spawnCalls);
      const raw = spawnReceipts ? pick(spawnReceipts, spawnCalls - 1, 'spawn receipt') : undefined;
      return typeof raw === 'function'
        ? raw(request, spawnCalls)
        : raw ?? { session_ref: `sess-dsh-${String(spawnCalls).padStart(4, '0')}` };
    },
    poll(request) {
      pollCalls += 1;
      if (recordCalls) calls.poll.push(request);
      if (throwOnPoll) throw throwOnPoll(pollCalls);
      const defaults = {
        state: 'running', event_count: 4, cursor: seq,
        updated_at_ms: 1_000 + pollCalls,
      };
      const raw = polls ? pick(polls, pollCalls - 1, 'poll receipt') : undefined;
      // Function receipts take full control (adversarial shapes stay exact);
      // object receipts merge over correlation and recorded-evidence defaults.
      return typeof raw === 'function'
        ? raw(request, pollCalls)
        : { ...correlationEcho(request), ...defaults, ...raw };
    },
    events(request) {
      eventCalls += 1;
      if (recordCalls) calls.events.push(request);
      if (throwOnEvents) throw throwOnEvents(eventCalls);
      const rawPage = eventPages ? pick(eventPages, eventCalls - 1, 'event page') : undefined;
      const page = typeof rawPage === 'function'
        ? rawPage(request, eventCalls)
        : rawPage ?? {
          records: Array.from({ length: request.max_records }, () => ({
            seq: (seq += 1), kind: 'status', bytes: 16,
          })),
          next_cursor: seq,
          truncated: false,
        };
      return page;
    },
    cancel(request) {
      cancelCalls += 1;
      if (recordCalls) calls.cancel.push(request);
      if (throwOnCancel) throw throwOnCancel(cancelCalls);
      const raw = cancelReceipts ? pick(cancelReceipts, cancelCalls - 1, 'cancel receipt') : undefined;
      return typeof raw === 'function'
        ? raw(request, cancelCalls)
        : { ...correlationEcho(request), outcome: 'confirmed', ...raw };
    },
  };
  return {
    port,
    calls,
    counts: () => ({
      configIdentity: identityCalls, spawn: spawnCalls,
      poll: pollCalls, events: eventCalls, cancel: cancelCalls,
    }),
    nextSeq: () => (seq += 1),
  };
}

export function createFixtureDriver(model, transportBundleOrPort, options = {}) {
  const transport = transportBundleOrPort?.port ?? transportBundleOrPort;
  return createDshApxDriverV1({ transport, workspace_mode: 'managed', ...options });
}

// Drive preflight -> launch so tests start from an honestly-uncertain lane.
export function dispatchLane(driver, fixture, requestExtras = {}) {
  const requestFor = (operation, extras = {}) => ({
    schema: DRIVER_OPERATION_SCHEMA_IDS[operation],
    version: 1,
    envelope_text: fixture.envelope_text,
    child_envelope_digest: fixture.child_envelope_digest,
    ...extras,
  });
  const preflight = driver.preflight({ ...requestFor('preflight'), ...requestExtras.preflight });
  const launch = driver.launch({ ...requestFor('launch'), ...requestExtras.launch });
  return {
    preflight,
    launch,
    requestFor,
    reconcile: (extras = {}) => driver.reconcile(requestFor('reconcile', extras)),
    cancel: (extras = {}) => driver.cancel(requestFor('cancel', extras)),
    launchAgain: () => driver.launch(requestFor('launch')),
    preflightAgain: () => driver.preflight(requestFor('preflight')),
  };
}
