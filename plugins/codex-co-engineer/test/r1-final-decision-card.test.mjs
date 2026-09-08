// FinalDecisionCardV1 focused coverage: valid ready case, exact identity,
// typed evidence, compact summary, artifact refs bound to attribution,
// Sol-only merge permission, and frozen deterministic JSON. The card never
// merges.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  ARTIFACT_TRUNCATION_REASON,
  BLOCKER_CODES,
  CARD_CHECKS,
  CARD_SIDE_EFFECT_NONCLAIMS,
  FINAL_DECISION_CARD_RESULT_SCHEMA_ID,
  FINAL_DECISION_CARD_SCHEMA_ID,
  FINAL_DECISION_CARD_VERSION,
  MAX_BLOCKERS,
  PUBLIC_LABEL_BLOCKED,
  PUBLIC_LABEL_READY,
  SOL_CAS_CHECKS,
  SOL_REGULAR_MERGE_ACTOR,
  describeFinalDecisionCardV1,
  projectFinalDecisionCardV1,
} from '../mcp/v3/final-decision-card.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  BRANCH,
  HEAD_SHA,
  PR_HOST,
  PR_NUMBER,
  PR_OWNER,
  PR_PROVIDER,
  PR_REPO,
  PR_URL,
  RUN_ID,
  TARGET,
  TREE_SHA,
  VERIFIER,
  WRITER,
  artifactRef,
  defaultLanes,
  defaultPush,
  defaultVerifier,
  defaultWorktree,
  matchingTopology,
  validRequest,
} from './fixtures/r1-final-decision-card-fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../mcp/v3/final-decision-card.mjs', import.meta.url));

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertFrozenTree(value) {
  assert.ok(value === null || typeof value !== 'object' || Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

test('FinalDecisionCardV1 is a closed frozen v1 card and cannot merge', () => {
  assert.equal(FINAL_DECISION_CARD_SCHEMA_ID, 'codex-co-engineer.final-decision-card.v1');
  assert.equal(FINAL_DECISION_CARD_VERSION, 1);
  assert.equal(FINAL_DECISION_CARD_SCHEMA_ID.includes('4.0.0'), false);
  const inventory = describeFinalDecisionCardV1();
  const again = describeFinalDecisionCardV1();
  assert.ok(Object.isFrozen(inventory));
  assert.deepEqual(inventory, again);
  assert.equal(inventory.card_can_merge, false);
  assert.equal(inventory.sol_regular_merge_actor, SOL_REGULAR_MERGE_ACTOR);
  assert.deepEqual([...inventory.sol_cas_checks], [...SOL_CAS_CHECKS]);
  assert.equal(inventory.composed_surfaces.git, 'not invoked');
  assert.equal(inventory.composed_surfaces.ui, 'not owned');
  assert.equal(inventory.rule, 'typed_facts_only_never_provider_prose');
  assert.equal(inventory.public_labels.includes(PUBLIC_LABEL_READY), true);
  assert.equal(BLOCKER_CODES.includes('stale_ci'), true);
  assert.equal(BLOCKER_CODES.includes('stale_evidence'), true);
  assert.equal(BLOCKER_CODES.includes('active_git_operation'), true);
  assert.equal(MAX_BLOCKERS, BLOCKER_CODES.length);
  assert.equal(inventory.max_blockers, BLOCKER_CODES.length);
  assert.ok(MAX_BLOCKERS > 16);
  assert.equal(CARD_CHECKS.includes('card_cannot_merge'), true);
  assert.equal(CARD_CHECKS.includes('no_active_git_operation'), true);
  assert.equal(CARD_CHECKS.includes('required_lanes_accepted'), true);
  assert.equal(CARD_CHECKS.includes('artifact_assignment_bound'), true);
  assert.equal(BLOCKER_CODES.includes('unknown_assignment'), true);
});

test('P-card source does not import server, supervisor, provider, UI, or Git I/O', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  for (const forbidden of [
    'server.mjs', 'supervisor.mjs', 'run-runtime.mjs', 'run-scheduler.mjs',
    'provider-registry.mjs', 'mailbox.mjs', 'acp-worker.mjs', 'display-only.js',
    'experience-ui-resource.mjs', 'child_process', 'node:fs', 'node:net',
    'node:http',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('a valid typed request projects the ready PR card', () => {
  const request = validRequest();
  const first = projectFinalDecisionCardV1(request);
  const second = projectFinalDecisionCardV1(request);
  assert.deepEqual(first, second);
  assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(second));
  assertFrozenTree(first);
  assert.equal(first.schema, FINAL_DECISION_CARD_RESULT_SCHEMA_ID);
  assert.equal(first.label, PUBLIC_LABEL_READY);
  assert.equal(first.ready_for_sol_merge, true);
  assert.deepEqual([...first.blockers], []);
  assert.equal(first.candidate.branch, BRANCH);
  assert.equal(first.candidate.head, HEAD_SHA);
  assert.equal(first.candidate.tree, TREE_SHA);
  assert.equal(first.worktree.clean, true);
  assert.equal(first.worktree.state, 'clean');
  assert.equal(first.worktree.active_git_operation, 'none');
  assert.equal(first.verifier.accepted, true);
  assert.equal(first.verifier.observed_head, HEAD_SHA);
  assert.equal(first.verifier.observed_tree, TREE_SHA);
  assert.equal(first.tests.passed, true);
  assert.equal(first.tests.observed_head, HEAD_SHA);
  assert.equal(first.ci.state, 'green');
  assert.equal(first.ci.freshness, 'current');
  assert.equal(first.ci.observed_tree, TREE_SHA);
  assert.equal(first.push.state, 'published-non-force');
  assert.equal(first.push.force, false);
  assert.equal(first.push.observed_head, HEAD_SHA);
  assert.equal(first.pr.url, PR_URL);
  assert.equal(first.pr.number, PR_NUMBER);
  assert.equal(first.pr.target_branch, TARGET);
  assert.equal(first.pr.head, HEAD_SHA);
  assert.equal(first.pr.tree, TREE_SHA);
  assert.equal(first.pr.state, 'open');
  assert.equal(first.pr.is_draft, true);
  assert.equal(first.pr.provider, PR_PROVIDER);
  assert.equal(first.pr.host, PR_HOST);
  assert.equal(first.pr.owner, PR_OWNER);
  assert.equal(first.pr.repo, PR_REPO);
  assert.equal(first.attribution[0].accepted, true);
  assert.equal(first.attribution[1].accepted, true);
  assert.equal(first.attribution.length, 2);
  assert.equal(first.attribution[0].assignment_id, VERIFIER);
  assert.equal(first.attribution[1].assignment_id, WRITER);
  assert.equal(first.attribution[1].provider, 'grok');
  assert.equal(first.topology.current, true);
  assert.equal(first.protected_ref.mutated, false);
  assert.equal(first.summary.ready_for_sol_merge, true);
  assert.equal(first.summary.branch, BRANCH);
  assert.match(first.summary.text, new RegExp(HEAD_SHA, 'u'));
  assert.equal(first.artifacts.length, 1);
  assert.equal(first.artifacts[0].artifact_kind, 'git_diff');
  assert.equal(first.artifacts[0].assignment_id, WRITER);
  assert.equal(first.truncation.truncated, false);
  assert.equal(first.truncation.reason, null);
  assert.equal(first.merge.card_can_merge, false);
  assert.equal(first.merge.actor, SOL_REGULAR_MERGE_ACTOR);
  assert.equal(first.merge.sol_regular_merge_permitted, true);
  assert.equal(first.merge.cas.exact_head, true);
  assert.equal(first.merge.cas.exact_tree, true);
  assert.equal(first.merge.cas.current_green_ci, true);
  assert.equal(first.merge.cas.topology, true);
  for (const key of CARD_SIDE_EFFECT_NONCLAIMS) {
    assert.equal(first.side_effects[key], false, key);
  }
  request.candidate.head = OTHER_MUTATION();
  assert.equal(first.candidate.head, HEAD_SHA);
});

function OTHER_MUTATION() {
  return 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
}

test('mutating the request after projection cannot drift the frozen card', () => {
  const request = validRequest();
  const card = projectFinalDecisionCardV1(request);
  request.worktree.clean = false;
  request.ci.state = 'red';
  request.pr.head = 'ffffffffffffffffffffffffffffffffffffffff';
  request.lanes[0].status = 'failed';
  request.ready_for_sol_merge = false;
  assert.equal(card.ready_for_sol_merge, true);
  assert.equal(card.worktree.clean, true);
  assert.equal(card.ci.state, 'green');
  assert.equal(card.pr.head, HEAD_SHA);
  assert.equal(card.attribution[0].status, 'completed');
  assert.equal(Object.isFrozen(card), true);
  assert.throws(() => {
    card.ready_for_sol_merge = false;
  }, TypeError);
});

test('dirty worktree, unpublished head, and missing verifier are exact blockers', () => {
  const dirty = projectFinalDecisionCardV1(validRequest({
    worktree: defaultWorktree({ clean: false }),
  }));
  assert.equal(dirty.label, PUBLIC_LABEL_BLOCKED);
  assert.equal(dirty.ready_for_sol_merge, false);
  assert.equal(dirty.blockers.includes('dirty_worktree'), true);
  assert.equal(dirty.merge.sol_regular_merge_permitted, false);
  assert.equal(dirty.merge.card_can_merge, false);

  const unpublished = projectFinalDecisionCardV1(validRequest({
    push: defaultPush({ published: false, force: false }),
  }));
  assert.equal(unpublished.blockers.includes('unpublished_head'), true);
  assert.equal(unpublished.push.state, 'unpublished');
  assert.equal(unpublished.ready_for_sol_merge, false);

  const unverified = projectFinalDecisionCardV1(validRequest({
    verifier: defaultVerifier({ accepted: false, status: 'blocked' }),
  }));
  assert.equal(unverified.blockers.includes('missing_verifier_acceptance'), true);
  assert.equal(unverified.ready_for_sol_merge, false);
});

test('artifact overflow records deterministic truncation provenance', () => {
  const artifacts = [];
  for (let i = 1; i <= 9; i += 1) artifacts.push(artifactRef(i));
  const card = projectFinalDecisionCardV1(validRequest({ artifacts }));
  assert.equal(card.ready_for_sol_merge, true);
  assert.equal(card.truncation.truncated, true);
  assert.deepEqual([...card.truncation.fields], ['artifacts']);
  assert.equal(card.truncation.original_count, 9);
  assert.equal(card.truncation.retained, 8);
  assert.equal(card.truncation.omitted, 1);
  assert.equal(card.truncation.reason, ARTIFACT_TRUNCATION_REASON);
  assert.equal(card.artifacts.length, 8);
  const again = projectFinalDecisionCardV1(validRequest({ artifacts }));
  assert.deepEqual(card.artifacts, again.artifacts);
  assert.equal(canonicalJsonStringify(card.truncation), canonicalJsonStringify(again.truncation));
});

test('lane topology CAS uses the live assignment set, not a caller current flag', () => {
  const lanes = defaultLanes();
  const mismatched = matchingTopology(lanes);
  mismatched.expected_digest = 'ab'.repeat(32);
  const card = projectFinalDecisionCardV1(validRequest({ lanes, topology: mismatched }));
  assert.equal(card.ready_for_sol_merge, false);
  assert.equal(card.blockers.includes('missing_topology'), true);
  assert.equal(card.topology.current, false);
  assert.equal(card.merge.cas.topology, false);
  assert.equal(card.summary.ready_for_sol_merge, false);
  assert.equal(typeof card.identity, 'undefined');
  assert.equal(JSON.stringify(card).includes(RUN_ID), true);
});

test('unknown schema and missing required keys fail closed', () => {
  assert.equal(errorOf(() => projectFinalDecisionCardV1(validRequest({
    schema: 'codex-co-engineer.experience-projection.v1',
  }))).code, 'invalid_format');
  const missing = validRequest();
  delete missing.verifier;
  assert.equal(errorOf(() => projectFinalDecisionCardV1(missing)).code, 'missing_key');
});
