import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OWNED_CORRECTION_ROUND_LIMIT,
  assertOwnedCorrectionBudgetV1,
  assertOwnedRevisionProducerV1,
  compactOwnedCorrectionFollowV1,
  compactOwnedCorrectionLineageV1,
  deriveOwnedRevisionRequestV1,
  ownedCorrectionBudgetRemainingV1,
  ownedCorrectionPolicyV1,
  ownedRevisionIdentityV1,
  parseOwnedRevisionRequestV1,
  producerFromRunReceiptV1,
  projectOwnedProducerCandidateV1,
} from '../mcp/v3/owned-delegation.mjs';
import { compileRunRequestV1 } from '../mcp/v3/run-request-compiler.mjs';
import { compileOwnedCorrectionPromptV1 } from '../mcp/v3/prompt-compiler.mjs';
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
      task_final: true,
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
  assert.equal(derived.correction.original_run_id, 'vale-hardening');
  assert.equal(derived.correction.original_assignment_id, 'social-implementation');
  assert.equal(derived.correction.round, 1);
  assert.equal(derived.correction.limit, OWNED_CORRECTION_ROUND_LIMIT);
  assert.equal(derived.correction.limit, 3);
  assert.equal(derived.run_request.assignments[0].expected_duration_ms, 900_000);
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

test('correction prompt preserves a tail constraint beyond 4096 bytes and rejects overflow including UTF-8', () => {
  const tail = 'TAIL-CONSTRAINT: keep node --test green and do not add files outside src/**.';
  const originalPrompt = `${'a'.repeat(4200)}\n${tail}`;
  const derived = deriveOwnedRevisionRequestV1(producer({ prompt: originalPrompt }), revision());
  assert.match(derived.run_request.assignments[0].prompt, /TAIL-CONSTRAINT: keep node --test green/u);
  assert.match(derived.run_request.assignments[0].prompt, /do not add files outside src\/\*\*/u);
  assert.doesNotMatch(derived.run_request.assignments[0].prompt, /Write scope:\n- \*\*/u);

  const utf8Overflow = `${'é'.repeat(9000)}TAIL-CONSTRAINT-UTF8`;
  assert.throws(
    () => compileOwnedCorrectionPromptV1({
      producer_run_id: 'vale-hardening',
      producer_assignment_id: 'social-implementation',
      feedback: 'Fix the failing unit tests without widening scope.',
      write_scope: ['src/**'],
      provider: 'grok',
      model: 'grok-4',
      access: 'writer',
      original_prompt: utf8Overflow,
      expected_head: HEAD,
    }),
    (error) => error.code === 'bounded_context_overflow' && /16384-byte assignment bound/u.test(error.message),
  );
  assert.throws(
    () => deriveOwnedRevisionRequestV1(producer({
      prompt: `${'x'.repeat(16_000)}TAIL-CONSTRAINT-OVERSIZE`,
    }), revision()),
    (error) => error.code === 'bounded_context_overflow',
  );
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
  for (const confidence of [null, undefined, 'unknown', 'not_sent']) {
    assert.throws(
      () => assertOwnedRevisionProducerV1(
        producer({ dispatch_confidence: confidence }),
        parseOwnedRevisionRequestV1(revision()),
      ),
      (error) => error.code === 'revision_producer_active',
    );
  }
  assert.throws(
    () => assertOwnedRevisionProducerV1(
      producer({ task_id: null }),
      parseOwnedRevisionRequestV1(revision()),
    ),
    (error) => error.code === 'revision_lifecycle_unfinal',
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
      task_final: true,
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
      task_final: true,
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
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
  assert.deepEqual(packet.available_actions, ['review', 'revision']);
  assert.equal(packet.evidence_refs.length, 0);

  const dirty = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    request_idempotency_key: IDEMPOTENCY,
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      task_final: true,
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
      task_final: true,
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      head: HEAD,
      clean: true,
      result: { needs_correction: true },
      handoff: { current_head: HEAD, clean: true },
    }],
  });
  assert.equal(finding.next_action.action, 'review');
  assert.deepEqual(finding.available_actions, ['review', 'revision']);

  const prose = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    request_idempotency_key: IDEMPOTENCY,
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      task_final: true,
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      head: HEAD,
      clean: true,
      result: { finding: 'please request a correction of this successful work' },
      handoff: { current_head: HEAD, clean: true },
    }],
  });
  assert.equal(prose.next_action.action, 'review');
  assert.equal(prose.next_action.action !== 'revision', true);
  assert.deepEqual(prose.available_actions, ['review', 'revision']);

  const unknownClean = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    request_idempotency_key: IDEMPOTENCY,
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      task_final: true,
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      head: HEAD,
      handoff: { current_head: HEAD },
    }],
  });
  assert.equal(unknownClean.unresolved[0].reason, 'unresolved');
  assert.equal(unknownClean.next_action.action, 'inspect');
  assert.equal(unknownClean.available_actions.includes('revision'), false);

  const followed = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    request_idempotency_key: IDEMPOTENCY,
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      task_final: true,
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      head: HEAD,
      clean: true,
      correction_follow: {
        child_run_id: 'rev-abcd1234abcd1234',
        child_assignment_id: 'social-implementation',
        identity_digest: `sha256:${'2'.repeat(64)}`,
      },
      handoff: { current_head: HEAD, clean: true },
    }],
  });
  assert.equal(followed.next_action.action, 'inspect');
  assert.equal(followed.next_action.run_id, 'rev-abcd1234abcd1234');
  assert.equal(followed.available_actions.includes('revision'), false);

  const exhausted = projectRunCoordinationResponseV1({
    run_id: 'rev-abcd1234abcd1234',
    request_idempotency_key: IDEMPOTENCY,
    correction: {
      schema: 'codex-co-engineer.owned-delegation.v1',
      version: 1,
      lineage: 'owned_revision',
      producer_run_id: 'vale-hardening',
      producer_assignment_id: 'social-implementation',
      reviewed_head: HEAD,
      original_run_id: 'vale-hardening',
      original_assignment_id: 'social-implementation',
      round: 3,
      limit: 3,
    },
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      task_final: true,
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
      head: HEAD,
      clean: true,
      handoff: { current_head: HEAD, clean: true },
    }],
  });
  assert.equal(exhausted.next_action.action, 'review');
  assert.equal(exhausted.available_actions.includes('revision'), false);
  assert.equal(exhausted.available_actions.includes('resubmit'), true);

  const missingConfidence = projectRunCoordinationResponseV1({
    run_id: 'vale-hardening',
    request_idempotency_key: IDEMPOTENCY,
    lanes: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      access: 'writer',
      status: 'completed',
      task_final: true,
      prompt_dispatched: true,
      head: HEAD,
      clean: true,
      handoff: { current_head: HEAD, clean: true },
    }],
  });
  assert.equal(missingConfidence.unresolved[0].reason, 'unresolved');
  assert.equal(missingConfidence.next_action.action, 'inspect');
  assert.equal(missingConfidence.available_actions.includes('revision'), false);
});

test('correction rounds are a fixed chain-depth ceiling independent of duration', () => {
  const first = deriveOwnedRevisionRequestV1(producer(), revision());
  assert.equal(first.correction.round, 1);
  assert.equal(first.correction.limit, 3);
  assert.equal(first.run_request.assignments[0].expected_duration_ms, 900_000);

  const secondProducer = producer({
    run_id: first.identity.run_id,
    correction: first.correction,
  });
  const second = deriveOwnedRevisionRequestV1(secondProducer, revision());
  assert.equal(second.correction.round, 2);
  assert.equal(second.correction.original_run_id, 'vale-hardening');
  assert.equal(second.correction.producer_run_id, first.identity.run_id);
  assert.equal(second.run_request.assignments[0].expected_duration_ms, 900_000);

  const thirdProducer = producer({
    run_id: second.identity.run_id,
    correction: second.correction,
  });
  const third = deriveOwnedRevisionRequestV1(thirdProducer, revision());
  assert.equal(third.correction.round, 3);
  assert.equal(ownedCorrectionBudgetRemainingV1(third.correction), false);

  assert.throws(
    () => deriveOwnedRevisionRequestV1(producer({
      run_id: third.identity.run_id,
      correction: third.correction,
    }), revision()),
    (error) => error.code === 'revision_budget_exhausted'
      && /submit a new bounded assignment/u.test(error.message)
      && /does not start that assignment/u.test(error.message),
  );

  const policy = ownedCorrectionPolicyV1(producer({
    run_id: third.identity.run_id,
    correction: third.correction,
  }));
  assert.equal(policy.round, 4);
  assert.throws(
    () => assertOwnedCorrectionBudgetV1(policy),
    (error) => error.code === 'revision_budget_exhausted',
  );
});

test('lineage and follow records persist original root, round, and child identity', () => {
  const derived = deriveOwnedRevisionRequestV1(producer(), revision());
  const compacted = compactOwnedCorrectionLineageV1(derived.correction);
  assert.equal(compacted.original_run_id, 'vale-hardening');
  assert.equal(compacted.round, 1);
  assert.equal(compacted.limit, 3);
  const follow = compactOwnedCorrectionFollowV1({
    child_run_id: derived.identity.run_id,
    child_assignment_id: 'social-implementation',
    identity_digest: derived.identity.digest,
  });
  assert.equal(follow.child_run_id, derived.identity.run_id);
  assert.equal(follow.identity_digest, derived.identity.digest);
  assert.throws(
    () => compactOwnedCorrectionLineageV1({
      ...derived.correction,
      round: 4,
    }),
    (error) => error.code === 'invalid_format',
  );
  assert.throws(
    () => compactOwnedCorrectionLineageV1({
      schema: 'codex-co-engineer.owned-delegation.v1',
      version: 1,
      lineage: 'owned_revision',
      producer_run_id: 'vale-hardening',
      producer_assignment_id: 'social-implementation',
      reviewed_head: HEAD,
    }),
    (error) => error.code === 'missing_key',
  );
});

test('valid maximum Unicode feedback compiles and empty capabilities stay empty', async () => {
  const feedback = 'é'.repeat(2048);
  const derived = deriveOwnedRevisionRequestV1(producer({ capabilities: [] }), revision({ feedback }));
  const compiled = await compileRunRequestV1(derived.run_request, {
    observeGit: async () => ({ base_sha: HEAD, head_sha: HEAD, tree_sha: 'c'.repeat(40),
      branch: 'main', clean: true, remote_present: true, remote_count: 1 }),
  });
  assert.deepEqual(compiled.assignments[0].capabilities, []);
  assert.ok(compiled.assignments[0].prompt.includes(feedback));
  assert.ok(Buffer.byteLength(compiled.objective, 'utf8') <= 4096);
});

test('terminal uncertainty requires inspection while active uncertainty waits', () => {
  for (const status of ['completed', 'failed', 'timeout', 'cancelled']) {
    const packet = projectRunCoordinationResponseV1({
      run_id: 'terminal-uncertainty', phase: 'completed',
      lanes: [producer({ status, phase: status, task_final: true, dispatch_confidence: 'uncertain' })],
    });
    assert.equal(packet.next_action.action, 'inspect');
    assert.equal(packet.available_actions.includes('revision'), false);
  }
  for (const task_final of [false, undefined]) {
    const packet = projectRunCoordinationResponseV1({
      run_id: 'lifecycle-missing', lanes: [producer({ task_final })],
    });
    assert.equal(packet.next_action.action, 'inspect');
    assert.equal(packet.available_actions.includes('revision'), false);
  }
  const active = projectRunCoordinationResponseV1({
    run_id: 'active-uncertainty', lanes: [producer({ status: 'running', phase: 'running', task_final: false, dispatch_confidence: 'uncertain' })],
  });
  assert.equal(active.next_action.action, 'wait');
});
