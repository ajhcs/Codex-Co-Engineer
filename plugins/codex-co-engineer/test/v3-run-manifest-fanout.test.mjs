// Runtime tests for RunManifestV1 fan-out guarantees (P02, commit 3 of 4):
// a run carries exactly 1..8 independent assignments, assignment IDs are
// unique, concurrent writer scopes are disjoint, and no input — at any
// object depth, for any number of assignments — can express dependency
// edges or a general DAG. Every case exercises validateCompleteRunManifestV1
// (envelope + AssignmentManifestV1 + RunPolicyV1) exactly as callers will.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSIGNMENT_ALLOWED_KEYS,
  ASSIGNMENT_ID_PATTERN,
  POLICY_ALLOWED_KEYS,
  ROOT_ALLOWED_KEYS,
  RunContractV1Error,
  writerScopesOverlap,
} from '../mcp/v3/run-manifest.mjs';
import { validateCompleteRunManifestV1 } from '../mcp/v3/run-policy.mjs';

const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
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

function writerAssignment(id, scopes) {
  return {
    assignment_id: id,
    role: 'implement',
    access: 'writer',
    prompt: `Implement lane ${id}.`,
    execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
    write_scope: scopes,
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff', 'acceptance_results'],
  };
}

function reviewerAssignment(id) {
  return {
    assignment_id: id,
    role: 'review',
    access: 'read_only',
    prompt: `Review as ${id}.`,
    execution: { profile: 'deep-security-review' },
    write_scope: [],
    acceptance: [],
    expected_duration_ms: 600_000,
    required_evidence: ['provider_report', 'git_identity'],
  };
}

// Builds a valid run with n writer lanes owning disjoint srcN/** scopes.
function fanOutRun(n) {
  const assignments = [];
  if (n > 0) assignments.push(reviewerAssignment('review-1'));
  let writersNeeded = Math.max(0, n - 1);
  for (let i = 0; i < writersNeeded; i += 1) {
    assignments.push(writerAssignment(`lane-${i}`, [`src${i}/**`]));
  }
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'fanout-boundary-run',
    repository: { path: '/repos/demo', base_sha: BASE_SHA },
    objective: 'Verify bounded fan-out semantics.',
    assignments,
    policy: { ...POLICY },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  };
}

function violationOf(mutate, laneCount = 3) {
  const manifest = fanOutRun(laneCount);
  mutate(manifest);
  try {
    validateCompleteRunManifestV1(manifest);
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error?.constructor?.name}`);
    return error;
  }
  assert.fail('expected the mutated manifest to be rejected');
}

test('run fan-out accepts exactly 1 assignment', () => {
  const summary = validateCompleteRunManifestV1(fanOutRun(1));
  assert.equal(summary.assignment_count, 1);
  assert.deepEqual([...summary.assignment_ids], ['review-1']);
});

test('run fan-out accepts exactly 8 independent assignments', () => {
  const summary = validateCompleteRunManifestV1(fanOutRun(8));
  assert.equal(summary.assignment_count, 8);
  assert.equal(new Set(summary.assignment_ids).size, 8);
});

test('run fan-out rejects 0 assignments', () => {
  const error = violationOf((manifest) => { manifest.assignments = []; });
  assert.equal(error.code, 'out_of_range');
  assert.equal(error.path, 'assignments');
  assert.match(error.message, /between 1 and 8 assignments; received 0/u);
});

test('run fan-out rejects 9 assignments', () => {
  const error = violationOf((manifest) => {
    manifest.assignments.push(writerAssignment('lane-extra', ['src9/**']));
  }, 8);
  assert.equal(error.code, 'out_of_range');
  assert.equal(error.path, 'assignments');
  assert.match(error.message, /received 9/u);
});

test('duplicate assignment IDs are rejected wherever they repeat', () => {
  const error = violationOf((manifest) => {
    manifest.assignments[1].assignment_id = manifest.assignments[0].assignment_id;
  });
  assert.equal(error.code, 'duplicate_assignment_id');
  assert.equal(error.path, 'assignments[1].assignment_id');
  assert.match(error.message, /not unique within the run/u);
});

test('identical writer scopes collide deterministically', () => {
  const error = violationOf((manifest) => {
    manifest.assignments[2].write_scope = ['src0/**'];
  });
  assert.equal(error.code, 'overlapping_writer_scope');
  assert.equal(error.path, 'assignments[1].write_scope');
  assert.match(error.message, /"lane-0" \("src0\/\*\*"\) and "lane-1"/u);
});

test('nested writer scopes collide; genuinely disjoint trees pass', () => {
  const nested = violationOf((manifest) => {
    manifest.run_id = 'nested-scope-run';
    manifest.assignments[2].write_scope = ['src0/a/b/**'];
  });
  assert.equal(nested.code, 'overlapping_writer_scope');

  const disjoint = fanOutRun(3);
  disjoint.run_id = 'disjoint-scope-run';
  disjoint.assignments[1].write_scope = ['src/client/**'];
  disjoint.assignments[2].write_scope = ['docs/**/*.md'];
  const summary = validateCompleteRunManifestV1(disjoint);
  assert.equal(summary.assignment_count, 3);
});

test('catch-all scopes overlap every writer lane', () => {
  for (const pattern of ['**', 'src0/**', 'src0']) {
    const error = violationOf((manifest) => {
      manifest.assignments[2].write_scope = [pattern];
    });
    assert.equal(error.code, 'overlapping_writer_scope', `pattern ${pattern} must overlap src0/**`);
  }
});

test('scope prefix intersection is conservative and deterministic', () => {
  const cases = [
    ['src/**', 'src/**', true],
    ['src/**', 'src/a/**', true],
    ['src', 'src/**', true],
    ['src/**', 'test/**', false],
    ['README.md', 'docs/**', false],
    ['**', 'anything/else', true],
    ['a/b', 'a/c', false],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(writerScopesOverlap(left, right), expected, `${left} vs ${right}`);
  }
});

test('read-only lanes never collide with writer scopes', () => {
  const mixed = fanOutRun(2);
  mixed.run_id = 'mixed-lane-run';
  mixed.assignments[0] = reviewerAssignment('review-1');
  mixed.assignments[0].write_scope = [];
  const summary = validateCompleteRunManifestV1(mixed);
  assert.equal(summary.assignment_count, 2);
});

test('dependency vocabulary is denied at the manifest root', () => {
  for (const key of ['depends_on', 'dependencies', 'blocked_by']) {
    const error = violationOf((manifest) => { manifest[key] = ['other']; });
    assert.equal(error.code, 'dependency_not_allowed', key);
    assert.equal(error.path, `$.${key}`);
    assert.match(error.message, /forbidden \(dependency_not_allowed\)/u);
  }
});

test('dependency vocabulary is denied on assignments', () => {
  for (const key of ['depends_on', 'dependencies', 'blocked_by', 'requires', 'after', 'needs']) {
    const error = violationOf((manifest) => { manifest.assignments[1][key] = ['review-1']; });
    assert.equal(error.code, 'dependency_not_allowed', key);
    assert.equal(error.path, `assignments[1].${key}`);
  }
});

test('dependency vocabulary is denied inside nested acceptance entries and parameters', () => {
  const inAcceptance = violationOf((manifest) => {
    manifest.assignments[1].acceptance[0].blocked_by = 'lint';
  });
  assert.equal(inAcceptance.code, 'dependency_not_allowed');
  assert.equal(inAcceptance.path, 'assignments[1].acceptance[0].blocked_by');

  const inParameters = violationOf((manifest) => {
    manifest.assignments[1].acceptance[0].parameters = { depends_on: 'lint' };
  });
  assert.equal(inParameters.code, 'dependency_not_allowed');
  assert.equal(inParameters.path, 'assignments[1].acceptance[0].parameters.depends_on');

  const inExecution = violationOf((manifest) => {
    manifest.assignments[1].execution.dependencies = ['profile-x'];
  });
  assert.equal(inExecution.code, 'dependency_not_allowed');
  assert.equal(inExecution.path, 'assignments[1].execution.dependencies');
});

test('an eight-lane fully-connected DAG attempt is still just one rejection', () => {
  const dagAttempt = fanOutRun(8);
  dagAttempt.run_id = 'dag-attempt-run';
  for (let i = 1; i < dagAttempt.assignments.length; i += 1) {
    dagAttempt.assignments[i].dependencies = dagAttempt.assignments
      .slice(0, i)
      .map((assignment) => assignment.assignment_id);
  }
  try {
    validateCompleteRunManifestV1(dagAttempt);
    assert.fail('DAG-shaped manifest must be rejected');
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error);
    assert.equal(error.code, 'dependency_not_allowed');
    assert.equal(error.path, 'assignments[1].dependencies');
  }
});

test('no edge vocabulary exists anywhere in the closed key sets', () => {
  const forbiddenEverywhere = new Set([
    'depends_on', 'dependencies', 'blocked_by', 'requires', 'needs',
    'after', 'before', 'prerequisites', 'waits_for', 'parents', 'children',
    'dag', 'edges',
  ]);
  for (const [label, keys] of [
    ['root', ROOT_ALLOWED_KEYS],
    ['policy', POLICY_ALLOWED_KEYS],
    ['assignment', ASSIGNMENT_ALLOWED_KEYS],
  ]) {
    assert.ok(Object.isFrozen(keys), `${label} key set must be frozen`);
    for (const key of keys) {
      assert.ok(!forbiddenEverywhere.has(key), `${label} vocabulary must not contain ${key}`);
    }
  }
  assert.match(String(ASSIGNMENT_ID_PATTERN), /\^/u);
});
