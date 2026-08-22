import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHILD_IDENTITY_SCHEMA_ID,
  DISPATCH_IDENTITY_SCHEMA_ID,
  PROVIDER_RUN_IDENTITY_SCHEMA_ID,
  RUN_IDENTITY_SCHEMA_ID,
  buildChildIdentityV1,
  buildDispatchIdentityV1,
  buildProviderRunIdentityV1,
  buildRunIdentityV1,
  deriveRequestIdempotencyKeyV1,
  validateChildIdentityV1,
  validateDispatchIdentityV1,
  validateProviderRunIdentityV1,
  validateRequestIdempotencyKeyV1,
  validateRunIdentityV1,
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
});
