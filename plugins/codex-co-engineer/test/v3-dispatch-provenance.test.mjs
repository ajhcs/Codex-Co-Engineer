import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHILD_IDENTITY_SCHEMA_ID,
  DISPATCH_IDENTITY_SCHEMA_ID,
  MAX_DISPATCH_ATTEMPT,
  MAX_DURATION_MS,
  MAX_METRIC_COUNTER,
  MAX_RECORD_REVISION,
  PROVIDER_DRIVERS,
  PROVIDER_RUN_IDENTITY_SCHEMA_ID,
  RUN_IDENTITY_SCHEMA_ID,
  SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY,
  assertDispatchProvenanceRevisionProgressionV1,
  buildChildIdentityV1,
  buildDispatchProvenanceV1,
  buildDispatchIdentityV1,
  buildProviderRunIdentityV1,
  buildRunIdentityV1,
  deriveRequestIdempotencyKeyV1,
  projectDispatchTelemetryV1,
  validateChildIdentityV1,
  validateDispatchIdentityV1,
  validateProviderRunIdentityV1,
  validateRequestIdempotencyKeyV1,
  validateRunIdentityV1,
  validateDispatchProvenanceV1,
  validateDispatchTelemetryV1,
} from '../mcp/v3/dispatch-provenance.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const MANIFEST_DIGEST = 'a'.repeat(64);
const TUPLE = Object.freeze({
  run_id: 'run-identity-one',
  assignment_id: 'writer-one',
  repository_path: '/srv/repositories/example',
  base_sha: BASE_SHA,
});

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed contract error');
}

function successInput() {
  const run = buildRunIdentityV1({
    run_id: TUPLE.run_id,
    repository_path: TUPLE.repository_path,
    base_sha: TUPLE.base_sha,
    manifest_digest: MANIFEST_DIGEST,
  });
  const child = buildChildIdentityV1({ run_id: TUPLE.run_id, assignment_id: TUPLE.assignment_id });
  const dispatch = buildDispatchIdentityV1({
    run_id: TUPLE.run_id,
    assignment_id: TUPLE.assignment_id,
    attempt: 1,
  });
  const provider_run = buildProviderRunIdentityV1({
    provider: 'dsh',
    ...TUPLE,
    request_idempotency_key: deriveRequestIdempotencyKeyV1(TUPLE),
    agent_id: 'agent:dsh-1',
  });
  return {
    revision: 1,
    run,
    child,
    dispatch,
    provider_run,
    requested: { provider: 'dsh', model: 'stealth/ox-alpha' },
    resolved: { provider: 'dsh', model: 'stealth/ox-alpha', role: 'implement' },
    observed: { provider: 'dsh', model: 'stealth/ox-alpha' },
    model_mismatch: 'none',
    model_attestation: { model: 'stealth/ox-alpha', method: 'provider_runtime_report' },
    repository_exposure: SELECTED_EXTERNAL_PROVIDER_FULL_REPOSITORY,
    lineage: {
      manifest_digest: MANIFEST_DIGEST,
      resolved_plan_digest: 'b'.repeat(64),
      prompt_envelope_digest: 'c'.repeat(64),
    },
    timing: {
      opened_at: '2026-08-22T00:00:00.000Z',
      dispatched_at: '2026-08-22T00:00:01.000Z',
      settled_at: '2026-08-22T00:00:02.000Z',
      dispatch_latency_ms: 1000,
      total_duration_ms: 2000,
    },
    counters: { dispatch_calls: 1, wake_events: 0, outcome_events: 1 },
    outcome: 'succeeded',
    provider_claims: {
      claimed_model: 'stealth/ox-alpha',
      claimed_outcome: 'succeeded',
      claimed_head_sha: TUPLE.base_sha,
    },
    verified_facts: {
      base_sha_observed: TUPLE.base_sha,
      head_sha_observed: TUPLE.base_sha,
      evidence_kinds: ['provider_report', 'git_identity'],
    },
  };
}

test('identity builders emit closed, detached, immutable records', () => {
  const runInput = { ...TUPLE, manifest_digest: MANIFEST_DIGEST };
  delete runInput.assignment_id;
  const run = buildRunIdentityV1(runInput);
  const child = buildChildIdentityV1({ run_id: TUPLE.run_id, assignment_id: TUPLE.assignment_id });
  const dispatch = buildDispatchIdentityV1({
    run_id: TUPLE.run_id,
    assignment_id: TUPLE.assignment_id,
    attempt: 1,
  });
  assert.equal(run.schema, RUN_IDENTITY_SCHEMA_ID);
  assert.equal(child.schema, CHILD_IDENTITY_SCHEMA_ID);
  assert.equal(dispatch.schema, DISPATCH_IDENTITY_SCHEMA_ID);
  assert.ok(Object.isFrozen(run));
  assert.ok(Object.isFrozen(child));
  assert.ok(Object.isFrozen(dispatch));
  runInput.run_id = 'mutated-run';
  assert.equal(run.run_id, TUPLE.run_id);
  assert.equal(validateRunIdentityV1(run), true);
  assert.equal(validateChildIdentityV1(child), true);
  assert.equal(validateDispatchIdentityV1(dispatch), true);
});

test('idempotency keys bind the exact run, child, repository, and base SHA', () => {
  const first = deriveRequestIdempotencyKeyV1(TUPLE);
  const reordered = deriveRequestIdempotencyKeyV1({
    base_sha: TUPLE.base_sha,
    repository_path: TUPLE.repository_path,
    assignment_id: TUPLE.assignment_id,
    run_id: TUPLE.run_id,
  });
  assert.equal(first, reordered);
  assert.equal(first,
    'idem-v1-3b99a4a99b3be3e4854977a47f9032ecc7565d7d4ef8ffa7f5c19b656baf58a1');
  assert.match(first, /^idem-v1-[0-9a-f]{64}$/u);
  assert.equal(validateRequestIdempotencyKeyV1(first, TUPLE), true);
  for (const [field, value] of [
    ['run_id', 'run-identity-two'],
    ['assignment_id', 'writer-two'],
    ['repository_path', '/srv/repositories/other'],
    ['base_sha', '89abcdef0123456789abcdef0123456789abcdef'],
  ]) {
    assert.equal(
      errorOf(() => validateRequestIdempotencyKeyV1(first, { ...TUPLE, [field]: value })).code,
      'identity_mismatch',
      field,
    );
  }
});

test('provider-run identity derives its driver and permits uncertain dispatch without provider IDs', () => {
  const request_idempotency_key = deriveRequestIdempotencyKeyV1(TUPLE);
  const pending = buildProviderRunIdentityV1({
    provider: 'dsh',
    ...TUPLE,
    request_idempotency_key,
  });
  assert.deepEqual(pending, {
    schema: PROVIDER_RUN_IDENTITY_SCHEMA_ID,
    provider: 'dsh',
    driver: 'acpx',
    ...TUPLE,
    request_idempotency_key,
    agent_id: null,
    provider_run_id: null,
  });
  assert.equal(validateProviderRunIdentityV1(pending), true);
  const cloud = buildProviderRunIdentityV1({
    provider: 'cursor-cloud',
    ...TUPLE,
    request_idempotency_key,
    agent_id: 'agent:cloud-1',
    provider_run_id: 'run/cloud-1',
  });
  assert.equal(cloud.driver, 'cloud-sdk');
});

test('every provider identity derives the one closed driver mapping', () => {
  const expected = {
    grok: 'acp',
    'cursor-local': 'acp',
    dsh: 'acpx',
    'cursor-cloud': 'cloud-sdk',
  };
  assert.deepEqual({ ...PROVIDER_DRIVERS }, expected);
  for (const [provider, driver] of Object.entries(expected)) {
    const identity = buildProviderRunIdentityV1({
      provider,
      ...TUPLE,
      request_idempotency_key: deriveRequestIdempotencyKeyV1(TUPLE),
    });
    assert.equal(identity.driver, driver, provider);
    assert.equal(validateProviderRunIdentityV1(identity), true, provider);
  }
});

test('closed schemas reject unknown, missing, malformed, and caller-derived fields', () => {
  const run = {
    schema: RUN_IDENTITY_SCHEMA_ID,
    run_id: TUPLE.run_id,
    repository_path: TUPLE.repository_path,
    base_sha: TUPLE.base_sha,
    manifest_digest: MANIFEST_DIGEST,
  };
  assert.equal(errorOf(() => validateRunIdentityV1({ ...run, prompt: 'secret' })).code, 'unknown_key');
  const missing = { ...run };
  delete missing.base_sha;
  assert.equal(errorOf(() => validateRunIdentityV1(missing)).code, 'missing_key');
  assert.equal(errorOf(() => buildDispatchIdentityV1({
    run_id: TUPLE.run_id,
    assignment_id: TUPLE.assignment_id,
    attempt: 0,
  })).code, 'out_of_range');
  assert.equal(errorOf(() => buildProviderRunIdentityV1({
    provider: 'unknown',
    ...TUPLE,
    request_idempotency_key: deriveRequestIdempotencyKeyV1(TUPLE),
  })).code, 'unknown_provider');
  assert.equal(errorOf(() => buildProviderRunIdentityV1({
    provider: 'dsh',
    driver: 'acp',
    ...TUPLE,
    request_idempotency_key: deriveRequestIdempotencyKeyV1(TUPLE),
  })).code, 'unknown_key');
});

test('provenance composes exact requested, resolved, observed, and verified identities', () => {
  const input = successInput();
  const record = buildDispatchProvenanceV1(input);
  assert.equal(validateDispatchProvenanceV1(record), true);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.verified_facts.evidence_kinds));
  input.requested.model = 'mutated-after-build';
  assert.equal(record.requested.model, 'stealth/ox-alpha');

  const telemetry = projectDispatchTelemetryV1(record);
  assert.equal(validateDispatchTelemetryV1(telemetry), true);
  assert.equal(telemetry.requested_model, 'stealth/ox-alpha');
  assert.equal(telemetry.resolved_model, 'stealth/ox-alpha');
  assert.equal(telemetry.observed_model, 'stealth/ox-alpha');
  assert.equal(telemetry.model_attested, true);
  assert.equal(telemetry.agent_ref, 'agent:dsh-1');
  const serialized = JSON.stringify(telemetry);
  assert.equal(Object.hasOwn(telemetry, 'provider_claims'), false);
  assert.equal(Object.hasOwn(telemetry, 'verified_facts'), false);
  assert.doesNotMatch(serialized, /claimed_head_sha|claimed_outcome|provider_claims|verified_facts|credential/u);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 4096);
});

test('uncertain dispatch remains representable without provider IDs and cannot be replayed', () => {
  const input = successInput();
  input.provider_run = buildProviderRunIdentityV1({
    provider: 'dsh',
    ...TUPLE,
    request_idempotency_key: deriveRequestIdempotencyKeyV1(TUPLE),
  });
  input.observed = { provider: null, model: null };
  input.model_mismatch = 'served_model_not_observed';
  input.model_attestation = null;
  input.outcome = 'dispatch_uncertain';
  input.timing = {
    opened_at: '2026-08-22T00:00:00.000Z',
    dispatched_at: null,
    settled_at: null,
    dispatch_latency_ms: null,
    total_duration_ms: null,
  };
  input.counters = { dispatch_calls: 1, wake_events: 0, outcome_events: 0 };
  const record = buildDispatchProvenanceV1(input);
  assert.equal(record.provider_run.agent_id, null);
  assert.equal(record.provider_run.provider_run_id, null);
  assert.equal(projectDispatchTelemetryV1(record).agent_ref, null);

  const replay = { ...input, counters: { ...input.counters, dispatch_calls: 2 } };
  assert.equal(errorOf(() => buildDispatchProvenanceV1(replay)).code, 'out_of_range');
});

test('observed model divergence is evidence and never promoted into success', () => {
  const input = successInput();
  input.observed = { provider: 'dsh', model: 'muse-spark-1.2-contributor' };
  input.model_mismatch = 'observed_model_divergence';
  input.model_attestation = {
    model: 'muse-spark-1.2-contributor',
    method: 'independent_provider_query',
  };
  input.outcome = 'failed';
  input.provider_claims.claimed_outcome = 'succeeded';
  const record = buildDispatchProvenanceV1(input);
  assert.equal(record.resolved.model, 'stealth/ox-alpha');
  assert.equal(record.observed.model, 'muse-spark-1.2-contributor');
  assert.equal(record.outcome, 'failed');

  input.outcome = 'succeeded';
  assert.equal(errorOf(() => buildDispatchProvenanceV1(input)).code, 'model_unverified');
});

test('revision progression is monotonic, identity-stable, and terminal-absorbing', () => {
  const first = buildDispatchProvenanceV1(successInput());
  const nextInput = successInput();
  nextInput.revision = 2;
  nextInput.counters.wake_events = 1;
  const next = buildDispatchProvenanceV1(nextInput);
  assert.equal(assertDispatchProvenanceRevisionProgressionV1(first, next), true);

  const sameRevisionInput = successInput();
  sameRevisionInput.counters.wake_events = 1;
  const sameRevision = buildDispatchProvenanceV1(sameRevisionInput);
  assert.equal(errorOf(() => assertDispatchProvenanceRevisionProgressionV1(first, sameRevision)).code,
    'revision_conflict');

  const changedOutcomeInput = successInput();
  changedOutcomeInput.revision = 2;
  changedOutcomeInput.outcome = 'failed';
  const changedOutcome = buildDispatchProvenanceV1(changedOutcomeInput);
  assert.equal(errorOf(() => assertDispatchProvenanceRevisionProgressionV1(first, changedOutcome)).code,
    'terminal_outcome_changed');
});

test('reconciliation may fill a previously unknown provider ID but never replace it', () => {
  const pendingInput = successInput();
  pendingInput.provider_run = buildProviderRunIdentityV1({
    provider: 'dsh', ...TUPLE,
    request_idempotency_key: deriveRequestIdempotencyKeyV1(TUPLE),
  });
  pendingInput.observed = { provider: null, model: null };
  pendingInput.model_mismatch = 'served_model_not_observed';
  pendingInput.model_attestation = null;
  pendingInput.outcome = 'dispatch_uncertain';
  pendingInput.timing = { opened_at: '2026-08-22T00:00:00.000Z', dispatched_at: null,
    settled_at: null, dispatch_latency_ms: null, total_duration_ms: null };
  pendingInput.counters = { dispatch_calls: 1, wake_events: 0, outcome_events: 0 };
  const pending = buildDispatchProvenanceV1(pendingInput);

  const reconciledInput = successInput();
  reconciledInput.revision = 2;
  reconciledInput.outcome = 'failed';
  const reconciled = buildDispatchProvenanceV1(reconciledInput);
  assert.equal(assertDispatchProvenanceRevisionProgressionV1(pending, reconciled), true);

  const replacedInput = successInput();
  replacedInput.revision = 3;
  replacedInput.outcome = 'failed';
  replacedInput.provider_run = buildProviderRunIdentityV1({
    provider: 'dsh', ...TUPLE,
    request_idempotency_key: deriveRequestIdempotencyKeyV1(TUPLE),
    agent_id: 'agent:dsh-2',
  });
  const replaced = buildDispatchProvenanceV1(replacedInput);
  assert.equal(errorOf(() => assertDispatchProvenanceRevisionProgressionV1(reconciled, replaced)).code,
    'identity_mismatch');
});

test('content-bearing and inconsistent provenance fails closed', () => {
  const cases = [
    ['root prompt', (input) => { input.prompt = 'secret'; }, 'unknown_key'],
    ['resolved substitution', (input) => { input.resolved.model = 'other-model'; }, 'identity_mismatch'],
    ['lineage drift', (input) => { input.lineage.manifest_digest = 'd'.repeat(64); }, 'identity_mismatch'],
    ['base drift', (input) => { input.verified_facts.base_sha_observed = 'f'.repeat(40); }, 'identity_mismatch'],
    ['unattested success', (input) => {
      input.observed = { provider: null, model: null };
      input.model_mismatch = 'served_model_not_observed';
      input.model_attestation = null;
    }, 'model_unverified'],
    ['noncanonical time', (input) => { input.timing.opened_at = '2026-13-99T00:00:00.000Z'; }, 'invalid_format'],
    ['duration mismatch', (input) => { input.timing.total_duration_ms = 1999; }, 'lifecycle_conflict'],
  ];
  for (const [name, mutate, code] of cases) {
    const input = successInput();
    mutate(input);
    assert.equal(errorOf(() => buildDispatchProvenanceV1(input)).code, code, name);
  }

  const telemetry = projectDispatchTelemetryV1(buildDispatchProvenanceV1(successInput()));
  assert.equal(errorOf(() => validateDispatchTelemetryV1({ ...telemetry, result: 'secret' })).code,
    'unknown_key');
});

test('prompt result command environment and credential fields cannot enter provenance or telemetry', () => {
  const cases = [
    ['run.prompt', (input) => { input.run = { ...input.run, prompt: 'prompt-sentinel' }; }],
    ['child.result', (input) => { input.child = { ...input.child, result: 'result-sentinel' }; }],
    ['dispatch.argv', (input) => { input.dispatch = { ...input.dispatch, argv: ['sh'] }; }],
    ['provider_run.credential', (input) => {
      input.provider_run = { ...input.provider_run, credential: 'credential-sentinel' };
    }],
    ['requested.prompt', (input) => { input.requested.prompt = 'prompt-sentinel'; }],
    ['resolved.command', (input) => { input.resolved.command = 'command-sentinel'; }],
    ['observed.result', (input) => { input.observed.result = 'result-sentinel'; }],
    ['model_attestation.token', (input) => {
      input.model_attestation.token = 'credential-sentinel';
    }],
    ['lineage.environment', (input) => { input.lineage.environment = { SECRET: 'sentinel' }; }],
    ['timing.stderr', (input) => { input.timing.stderr = 'result-sentinel'; }],
    ['counters.api_key', (input) => { input.counters.api_key = 'credential-sentinel'; }],
    ['provider_claims.prompt', (input) => {
      input.provider_claims.prompt = 'prompt-sentinel';
    }],
    ['verified_facts.result', (input) => {
      input.verified_facts.result = 'result-sentinel';
    }],
  ];
  for (const [name, mutate] of cases) {
    const input = successInput();
    mutate(input);
    const error = errorOf(() => buildDispatchProvenanceV1(input));
    assert.equal(error.code, 'unknown_key', name);
  }

  const claimInput = successInput();
  claimInput.provider_claims.claimed_model = 'credential-sentinel';
  const telemetry = projectDispatchTelemetryV1(buildDispatchProvenanceV1(claimInput));
  const bytes = JSON.stringify(telemetry);
  assert.doesNotMatch(bytes, /prompt-sentinel|result-sentinel|command-sentinel|credential-sentinel/u);
  for (const key of ['prompt', 'result', 'command', 'commands', 'argv', 'env', 'environment',
    'credential', 'credentials', 'secret', 'token', 'api_key', 'stdout', 'stderr']) {
    assert.equal(Object.hasOwn(telemetry, key), false, key);
    assert.equal(errorOf(() => validateDispatchTelemetryV1({ ...telemetry, [key]: 'sentinel' })).code,
      'unknown_key', key);
  }
});

test('telemetry projection is deterministic bounded and rejects identity tampering', () => {
  const first = projectDispatchTelemetryV1(buildDispatchProvenanceV1(successInput()));
  const secondInput = successInput();
  secondInput.provider_claims.claimed_outcome = 'failed';
  secondInput.provider_claims.claimed_head_sha = 'f'.repeat(40);
  const second = projectDispatchTelemetryV1(buildDispatchProvenanceV1(secondInput));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.lineage));
  assert.ok(Object.isFrozen(first.timing));
  assert.ok(Object.isFrozen(first.counters));
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 4096);

  for (const [name, mutate, code] of [
    ['driver', (value) => { value.driver = 'acp'; }, 'identity_mismatch'],
    ['lineage', (value) => { value.lineage.manifest_digest = 'not-a-digest'; }, 'invalid_format'],
    ['model evidence', (value) => { value.model_attested = false; }, 'identity_mismatch'],
    ['duration', (value) => { value.timing.total_duration_ms = 1; }, 'lifecycle_conflict'],
  ]) {
    const tampered = JSON.parse(JSON.stringify(first));
    mutate(tampered);
    assert.equal(errorOf(() => validateDispatchTelemetryV1(tampered)).code, code, name);
  }
});

test('identity revisions durations and counters accept exact safe maxima and reject overflow', () => {
  const dispatch = buildDispatchIdentityV1({
    run_id: TUPLE.run_id,
    assignment_id: TUPLE.assignment_id,
    attempt: MAX_DISPATCH_ATTEMPT,
  });
  assert.equal(dispatch.attempt, Number.MAX_SAFE_INTEGER);
  assert.equal(errorOf(() => buildDispatchIdentityV1({
    run_id: TUPLE.run_id,
    assignment_id: TUPLE.assignment_id,
    attempt: Number.MAX_SAFE_INTEGER + 1,
  })).code, 'out_of_range');

  const input = successInput();
  const openedAt = Date.parse(input.timing.opened_at);
  input.revision = MAX_RECORD_REVISION;
  input.timing.dispatched_at = input.timing.opened_at;
  input.timing.settled_at = new Date(openedAt + MAX_DURATION_MS).toISOString();
  input.timing.dispatch_latency_ms = 0;
  input.timing.total_duration_ms = MAX_DURATION_MS;
  input.counters.wake_events = MAX_METRIC_COUNTER;
  input.counters.outcome_events = MAX_METRIC_COUNTER;
  const record = buildDispatchProvenanceV1(input);
  assert.equal(record.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(record.counters.wake_events, Number.MAX_SAFE_INTEGER);

  for (const [name, mutate] of [
    ['revision', (value) => { value.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ['duration', (value) => { value.timing.total_duration_ms = MAX_DURATION_MS + 1; }],
    ['wake counter', (value) => { value.counters.wake_events = Number.MAX_SAFE_INTEGER + 1; }],
  ]) {
    const overflow = successInput();
    mutate(overflow);
    assert.equal(errorOf(() => buildDispatchProvenanceV1(overflow)).code, 'out_of_range', name);
  }
});

test('Proxy and accessor inputs fail without dispatching caller code', () => {
  let traps = 0;
  const proxy = new Proxy({ ...TUPLE }, {
    ownKeys() { traps += 1; throw new Error('trap'); },
    get() { traps += 1; throw new Error('trap'); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('trap'); },
  });
  assert.equal(errorOf(() => deriveRequestIdempotencyKeyV1(proxy)).code, 'invalid_type');
  assert.equal(traps, 0);

  const accessor = { ...TUPLE };
  Object.defineProperty(accessor, 'prompt', {
    enumerable: true,
    get() { traps += 1; return 'secret'; },
  });
  assert.equal(errorOf(() => deriveRequestIdempotencyKeyV1(accessor)).code, 'invalid_object');
  assert.equal(traps, 0);

  const { proxy: revoked, revoke } = Proxy.revocable({ ...TUPLE }, {});
  revoke();
  assert.equal(errorOf(() => deriveRequestIdempotencyKeyV1(revoked)).code, 'invalid_type');

  const nested = successInput();
  nested.requested = new Proxy(nested.requested, {
    ownKeys() { traps += 1; throw new Error('trap'); },
    get() { traps += 1; throw new Error('trap'); },
  });
  assert.equal(errorOf(() => buildDispatchProvenanceV1(nested)).code, 'invalid_type');
  assert.equal(traps, 0);
});

test('non-JSON direct inputs fail closed before provenance construction', () => {
  const symbolInput = successInput();
  symbolInput.requested[Symbol('credential')] = 'sentinel';
  assert.equal(errorOf(() => buildDispatchProvenanceV1(symbolInput)).code, 'invalid_object');

  const hiddenInput = successInput();
  Object.defineProperty(hiddenInput.requested, 'prompt', {
    enumerable: false,
    value: 'sentinel',
  });
  assert.equal(errorOf(() => buildDispatchProvenanceV1(hiddenInput)).code, 'invalid_object');

  const sparseInput = successInput();
  sparseInput.verified_facts.evidence_kinds = new Array(1);
  assert.equal(errorOf(() => buildDispatchProvenanceV1(sparseInput)).code, 'invalid_array');

  const aliasedInput = successInput();
  aliasedInput.observed = aliasedInput.requested;
  assert.equal(errorOf(() => buildDispatchProvenanceV1(aliasedInput)).code, 'invalid_json_value');

  const cyclicInput = successInput();
  cyclicInput.requested.cycle = cyclicInput.requested;
  assert.equal(errorOf(() => buildDispatchProvenanceV1(cyclicInput)).code, 'invalid_json_value');

  const exoticInput = successInput();
  exoticInput.requested = new Date('2026-08-22T00:00:00.000Z');
  assert.equal(errorOf(() => buildDispatchProvenanceV1(exoticInput)).code, 'invalid_type');
});
