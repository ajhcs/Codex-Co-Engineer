import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileRunRequestV1,
  RUN_REQUEST_DEFAULT_CAPABILITIES,
  RUN_REQUEST_DEFAULT_EXPECTED_DURATION_MS,
} from '../mcp/v3/run-request-compiler.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const TREE_SHA = 'c'.repeat(40);
const OBSERVED = Object.freeze({
  base_sha: BASE_SHA,
  head_sha: HEAD_SHA,
  tree_sha: TREE_SHA,
  branch: 'main',
  clean: true,
  remote_present: true,
  remote_count: 1,
});

function observeGit(_repo, requestedBaseSha) {
  return Promise.resolve({
    ...OBSERVED,
    base_sha: requestedBaseSha ?? OBSERVED.head_sha,
  });
}

function request(overrides = {}) {
  return {
    run_id: 'vale-hardening',
    repo: '/tmp/fixture-repo',
    objective: 'Implement and review the hardening plan.',
    assignments: [{
      assignment_id: 'social-implementation',
      provider: 'grok',
      role: 'implement',
      access: 'write',
      prompt: 'Implement the social ingestion slice.',
      expected_duration_ms: 900_000,
    }],
    ...overrides,
  };
}

test('compiles a small request into server-owned identities and bounded lane data', async () => {
  const compiled = await compileRunRequestV1(request(), { observeGit });

  assert.equal(compiled.schema, 'codex-co-engineer.run-request.v1');
  assert.equal(compiled.git.base_sha, HEAD_SHA);
  assert.equal(compiled.git.clean, true);
  assert.equal(compiled.manifest.repository.base_sha, HEAD_SHA);
  assert.equal(compiled.assignments[0].model, 'grok-4');
  assert.deepEqual(compiled.assignments[0].write_scope, ['**']);
  assert.deepEqual(compiled.assignments[0].capabilities, [...RUN_REQUEST_DEFAULT_CAPABILITIES]);
  assert.match(compiled.assignments[0].task_id, /^ce-/u);
  assert.match(compiled.request_idempotency_key, /^sha256:[0-9a-f]{64}$/u);
  assert.match(compiled.run_identity.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(compiled.assignments[0].dispatch_identity.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(compiled.assignments[0].provider_run_identity.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(compiled.dispatch_identities[0].assignment_id, 'social-implementation');
  assert.equal(compiled.provider_run_identities[0].provider, 'grok');
  assert.match(compiled.manifest_digest, /^[0-9a-f]{64}$/u);
  assert.equal(compiled.assignments[0].prompt, 'Implement the social ingestion slice.');
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.assignments[0]), true);
  assert.equal(compiled.public_summary.assignments[0].prompt, undefined);
});

test('derives access from role when omitted and still rejects an explicit mismatch', async () => {
  const withoutAccess = request({
    assignments: [{
      assignment_id: 'auth-review',
      provider: 'grok',
      role: 'review',
      prompt: 'Review the current auth changes.',
      expected_duration_ms: 300_000,
    }],
  });
  const compiled = await compileRunRequestV1(withoutAccess, { observeGit });
  assert.equal(compiled.assignments[0].access, 'read_only');
  assert.deepEqual(compiled.assignments[0].write_scope, []);
  assert.equal(compiled.manifest.assignments[0].access, 'read_only');

  await assert.rejects(
    compileRunRequestV1({
      ...withoutAccess,
      assignments: [{ ...withoutAccess.assignments[0], access: 'writer' }],
    }, { observeGit }),
    (error) => error.code === 'role_access_mismatch',
  );
});

test('semantic request identities are stable across object key order', async () => {
  const first = await compileRunRequestV1(request(), { observeGit });
  const second = await compileRunRequestV1({
    assignments: [{
      expected_duration_ms: 900_000,
      prompt: 'Implement the social ingestion slice.',
      access: 'write',
      role: 'implement',
      provider: 'grok',
      assignment_id: 'social-implementation',
    }],
    objective: 'Implement and review the hardening plan.',
    repo: '/tmp/fixture-repo',
    run_id: 'vale-hardening',
  }, { observeGit });

  assert.equal(second.request_idempotency_key, first.request_idempotency_key);
  assert.equal(second.manifest_digest, first.manifest_digest);
  assert.equal(second.run_identity.digest, first.run_identity.digest);
  assert.equal(second.assignments[0].task_id, first.assignments[0].task_id);
});

test('omitted duration is identical to the explicit semantic default and invalid supplied values fail', async () => {
  const assignment = { ...request().assignments[0] };
  delete assignment.expected_duration_ms;
  const omitted = await compileRunRequestV1(request({ assignments: [assignment] }), { observeGit });
  const explicit = await compileRunRequestV1(request({
    assignments: [{ ...assignment, expected_duration_ms: RUN_REQUEST_DEFAULT_EXPECTED_DURATION_MS }],
  }), { observeGit });

  assert.equal(omitted.assignments[0].expected_duration_ms, 600_000);
  assert.equal(omitted.request_idempotency_key, explicit.request_idempotency_key);
  assert.equal(omitted.manifest_digest, explicit.manifest_digest);
  assert.equal(omitted.assignments[0].task_id, explicit.assignments[0].task_id);

  await assert.rejects(
    compileRunRequestV1(request({
      assignments: [{ ...assignment, expected_duration_ms: 0 }],
    }), { observeGit }),
    (error) => error.code === 'out_of_range',
  );
  await assert.rejects(
    compileRunRequestV1(request({
      assignments: [{ ...assignment, expected_duration_ms: null }],
    }), { observeGit }),
    (error) => error.code === 'invalid_type',
  );
});

test('semantic changes alter the derived request identity', async () => {
  const baseline = await compileRunRequestV1(request(), { observeGit });
  const changedObjective = await compileRunRequestV1(request({
    objective: 'Implement a different hardening plan.',
  }), { observeGit });
  const changedProvider = await compileRunRequestV1(request({
    assignments: [{
      ...request().assignments[0],
      provider: 'cursor-local',
    }],
  }), { observeGit });
  const changedScope = await compileRunRequestV1(request({
    assignments: [{
      ...request().assignments[0],
      write_scope: ['src/**'],
    }],
  }), { observeGit });
  const changedBase = await compileRunRequestV1(request({ base_sha: BASE_SHA }), { observeGit });

  assert.notEqual(changedObjective.request_idempotency_key, baseline.request_idempotency_key);
  assert.notEqual(changedProvider.request_idempotency_key, baseline.request_idempotency_key);
  assert.notEqual(changedScope.request_idempotency_key, baseline.request_idempotency_key);
  assert.notEqual(changedBase.request_idempotency_key, baseline.request_idempotency_key);
});

test('derivation rejects caller-supplied provenance and dirty source state', async () => {
  await assert.rejects(
    compileRunRequestV1(request({ request_idempotency_key: 'sha256:' + '0'.repeat(64) }), { observeGit }),
    (error) => error.code === 'derived_field_denied',
  );
  await assert.rejects(
    compileRunRequestV1(request(), {
      observeGit: async () => ({ ...OBSERVED, clean: false }),
    }),
    (error) => error.code === 'repository_dirty',
  );
});

test('cloud lanes receive an exact server-derived starting ref', async () => {
  const compiled = await compileRunRequestV1(request({
    assignments: [{
      assignment_id: 'cloud-review',
      provider: 'cursor-cloud',
      role: 'review',
      access: 'read',
      prompt: 'Review the hardening changes.',
      expected_duration_ms: 300_000,
    }],
  }), { observeGit });

  assert.equal(compiled.assignments[0].starting_ref, HEAD_SHA);
  assert.equal(compiled.manifest.assignments[0].starting_ref, HEAD_SHA);
  assert.deepEqual(compiled.manifest.assignments[0].write_scope, []);
});

test('multiple writers accept disjoint static scope prefixes and reject overlapping ones', async () => {
  const writer = (assignmentId, writeScope) => ({
    assignment_id: assignmentId,
    provider: 'grok',
    role: 'implement',
    access: 'write',
    prompt: `Implement ${assignmentId}.`,
    expected_duration_ms: 60_000,
    write_scope: [writeScope],
  });
  const disjoint = await compileRunRequestV1(request({
    run_id: 'disjoint-writers',
    assignments: [writer('api-writer', 'src/api/**'), writer('ui-writer', 'src/ui/**')],
  }), { observeGit });
  assert.deepEqual(disjoint.assignments.map((entry) => entry.write_scope), [
    ['src/api/**'],
    ['src/ui/**'],
  ]);

  await assert.rejects(
    compileRunRequestV1(request({
      run_id: 'overlapping-writers',
      assignments: [writer('src-writer', 'src/**'), writer('api-writer', 'src/api/**')],
    }), { observeGit }),
    (error) => error.code === 'overlapping_writer_scope',
  );
});
