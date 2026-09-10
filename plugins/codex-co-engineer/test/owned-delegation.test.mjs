import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOwnedRevisionProducerV1,
  deriveOwnedRevisionRequestV1,
  ownedRevisionIdentityV1,
  parseOwnedRevisionRequestV1,
  producerFromRunReceiptV1,
  projectOwnedProducerCandidateV1,
} from '../mcp/v3/owned-delegation.mjs';
import { projectRunCoordinationResponseV1 } from '../mcp/v3/run-coordination-response.mjs';

const HEAD = 'b'.repeat(40);
const IDEMPOTENCY = `sha256:${'d'.repeat(64)}`;

function producer(overrides = {}) {
  return {
    run_id: 'vale-hardening',
    assignment_id: 'social-implementation',
    task_id: 'ce-vale-hardening-social',
    provider: 'grok',
    model: 'grok-4',
    role: 'implement',
    access: 'writer',
    write_scope: ['src/**'],
    capabilities: ['read_run_receipts', 'read_provider_logs', 'read_own_worktree'],
    expected_duration_ms: 900_000,
    repo: '/tmp/fixture-repo',
    objective: 'Implement the slice.',
    prompt: 'Implement the social ingestion slice and keep the existing tests green.',
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 60_000, parameters: {} }],
    required_evidence: ['provider_report', 'git_identity', 'git_diff'],
    request_idempotency_key: IDEMPOTENCY,
    phase: 'completed',
    status: 'completed',
    prompt_dispatched: true,
    dispatch_confidence: 'authoritative',
    head: HEAD,
    clean: true,
    evidence_refs: [],
    ...overrides,
  };
}

function revision(overrides = {}) {
  return {
    assignment_id: 'social-implementation',
    feedback: 'Fix the failing unit tests without widening scope.',
    expected_head: HEAD,
    expected_idempotency_key: IDEMPOTENCY,
    ...overrides,
  };
}

test('valid clean revision preserves authority and derives a fresh identity', () => {
  const derived = deriveOwnedRevisionRequestV1(producer(), revision());
  assert.match(derived.identity.run_id, /^rev-[0-9a-f]{16}$/u);
  assert.equal(derived.run_request.assignments[0].provider, 'grok');
  assert.equal(derived.run_request.assignments[0].model, 'grok-4');
  assert.deepEqual(derived.run_request.assignments[0].write_scope, ['src/**']);
  assert.equal(derived.run_request.base_sha, HEAD);
  assert.match(derived.run_request.assignments[0].prompt, /Fix the failing unit tests/u);
  assert.match(derived.run_request.assignments[0].prompt, /src\/\*\*/u);
  assert.match(derived.run_request.assignments[0].prompt, /Implement the social ingestion slice/u);
  assert.match(derived.run_request.assignments[0].prompt, /Implement the slice/u);
  assert.match(derived.run_request.assignments[0].prompt, /unit-tests/u);
  assert.match(derived.run_request.assignments[0].prompt, /Reviewed HEAD: /u);
  assert.match(derived.run_request.assignments[0].prompt, /fresh owned revision/u);
  assert.equal(derived.producer_run_id, 'vale-hardening');
  assert.equal(derived.correction.lineage, 'owned_revision');
  assert.equal(derived.correction.reviewed_head, HEAD);
});

test('empty reviewer scope is not presented as unrestricted write access', () => {
  const derived = deriveOwnedRevisionRequestV1(producer({
    role: 'review',
    access: 'read_only',
    write_scope: [],
  }), revision());
  assert.match(derived.run_request.assignments[0].prompt, /read-only; no write scope/u);
  assert.doesNotMatch(derived.run_request.assignments[0].prompt, /Write scope:\n- \*\*/u);
});

test('duplicate revision inputs reuse the same durable identity', () => {
  const first = ownedRevisionIdentityV1({ producer: producer(), revision: parseOwnedRevisionRequestV1(revision()) });
  const second = ownedRevisionIdentityV1({ producer: producer(), revision: parseOwnedRevisionRequestV1(revision()) });
  assert.equal(second.run_id, first.run_id);
  assert.equal(second.digest, first.digest);
  const changed = ownedRevisionIdentityV1({
    producer: producer(),
    revision: parseOwnedRevisionRequestV1(revision({ feedback: 'Different correction.' })),
  });
  assert.notEqual(changed.run_id, first.run_id);
});

test('dirty, stale, and active producers are rejected instead of replayed', () => {
  assert.throws(
    () => assertOwnedRevisionProducerV1(producer({ clean: false }), parseOwnedRevisionRequestV1(revision())),
    (error) => error.code === 'revision_producer_dirty',
  );
  assert.throws(
    () => assertOwnedRevisionProducerV1(producer(), parseOwnedRevisionRequestV1(revision({ expected_head: 'c'.repeat(40) }))),
    (error) => error.code === 'revision_producer_stale',
  );
  assert.throws(
    () => assertOwnedRevisionProducerV1(producer({ phase: 'running', status: 'running' }), parseOwnedRevisionRequestV1(revision())),
    (error) => error.code === 'revision_producer_active',
  );
  assert.throws(
    () => assertOwnedRevisionProducerV1(producer({ dispatch_confidence: 'uncertain' }), parseOwnedRevisionRequestV1(revision())),
    (error) => error.code === 'revision_producer_active',
  );
  assert.throws(
    () => deriveOwnedRevisionRequestV1(producer({ request_idempotency_key: `sha256:${'e'.repeat(64)}` }), revision()),
    (error) => error.code === 'revision_identity_mismatch',
  );
});

test('producer receipts keep write scope and git identity for correction handoff', () => {
  const snapshot = producerFromRunReceiptV1({
    run_id: 'vale-hardening',
    repo: '/tmp/fixture-repo',
    request_idempotency_key: IDEMPOTENCY,
    git: { head: HEAD, base_sha: 'a'.repeat(40) },
    clean: true,
    lanes: [{
      assignment_id: 'social-implementation',
      task_id: 'ce-vale-hardening-social',
      provider: 'grok',
      model: 'grok-4',
      role: 'implement',
      access: 'writer',
      write_scope: ['src/**'],
      phase: 'completed',
      status: 'completed',
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      handoff: { current_head: HEAD, clean: true },
    }],
  }, 'social-implementation');
  assert.deepEqual(snapshot.write_scope, ['src/**']);
  assert.equal(snapshot.head, HEAD);
  assert.equal(snapshot.clean, true);
});

test('fresh workspace proof is required and stale handoff is not a substitute', () => {
  const record = {
    run_id: 'vale-hardening',
    compiled: {
      repo: '/tmp/fixture-repo',
      objective: 'Implement the slice.',
      request_idempotency_key: IDEMPOTENCY,
      assignments: [producer()],
    },
  };
  const lane = {
    assignment_id: 'social-implementation',
    task_id: 'ce-vale-hardening-social',
    phase: 'completed',
    prompt_dispatched: true,
    dispatch_confidence: 'authoritative',
    handoff: { current_head: HEAD, clean: true },
  };
  const projected = projectOwnedProducerCandidateV1({
    record,
    assignment: producer(),
    lane,
    workspace: { current_head: HEAD, clean: true },
  });
  assert.equal(projected.head, HEAD);
  assert.equal(projected.clean, true);
  assert.throws(
    () => projectOwnedProducerCandidateV1({ record, assignment: producer(), lane, workspace: {} }),
    (error) => error.code === 'revision_workspace_uninspectable',
  );
  assert.throws(
    () => projectOwnedProducerCandidateV1({
      record,
      assignment: producer({ provider: 'cursor-cloud', model: 'claude-sonnet-4-5' }),
      lane,
      workspace: { current_head: HEAD, clean: true },
    }),
    (error) => error.code === 'revision_workspace_unsupported',
  );
});

test('coordination packets expose per-assignment identity and review as the completed next action', () => {
  const packet = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    phase: 'completed',
    request_idempotency_key: IDEMPOTENCY,
    git: { base_sha: 'a'.repeat(40), digest: `sha256:${'f'.repeat(64)}` },
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      request_idempotency_key: IDEMPOTENCY,
      head: HEAD,
      clean: true,
      child_identity_digest: `sha256:${'1'.repeat(64)}`,
      handoff: { current_head: HEAD, clean: true },
    }],
  });
  assert.equal(packet.git.head, null);
  assert.equal(packet.producers[0].head, HEAD);
  assert.equal(packet.producers[0].status, 'completed');
  assert.equal(packet.producers[0].request_idempotency_key, IDEMPOTENCY);
  assert.equal(packet.request_idempotency_key, IDEMPOTENCY);
  assert.equal(packet.unresolved.length, 0);
  assert.equal(packet.next_action.action, 'review');
  assert.deepEqual(packet.available_actions, ['review']);
  assert.equal(packet.evidence_refs.length, 0);

  const dirty = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    request_idempotency_key: IDEMPOTENCY,
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      head: HEAD,
      clean: false,
      handoff: { current_head: HEAD, clean: false },
    }],
  });
  assert.equal(dirty.unresolved[0].reason, 'dirty');
  assert.equal(dirty.next_action.action, 'inspect');
  assert.equal(dirty.available_actions.includes('revision'), false);

  const finding = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    request_idempotency_key: IDEMPOTENCY,
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      head: HEAD,
      clean: true,
      result: { needs_correction: true },
      handoff: { current_head: HEAD, clean: true },
    }],
  });
  assert.equal(finding.next_action.action, 'review');
  assert.deepEqual(finding.available_actions, ['review', 'revision']);
});
