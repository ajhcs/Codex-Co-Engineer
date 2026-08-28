// FinalDecisionCardV1 adversarial coverage: forged receipts, stale CI,
// hidden/unknown checks, mismatched PR head, unknown fields, partial
// provider failure, ghost artifact assignment, truncation, and a valid
// ready case. Projection never derives readiness from provider prose and
// never merges.

import assert from 'node:assert/strict';
import { inspect, types as utilTypes } from 'node:util';
import test from 'node:test';

import {
  ACTIVE_GIT_OPERATIONS,
  ARTIFACT_TRUNCATION_REASON,
  BLOCKER_CODES,
  MAX_ARTIFACT_INPUT,
  MAX_ARTIFACT_RETAINED,
  MAX_BLOCKERS,
  PUBLIC_LABEL_BLOCKED,
  PUBLIC_LABEL_READY,
  projectFinalDecisionCardV1,
} from '../mcp/v3/final-decision-card.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  BRANCH,
  CONTENT_FREE,
  GHOST,
  HEAD_SHA,
  HOSTILE_GIT,
  HOSTILE_PATH,
  HOSTILE_PROSE,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  HOSTILE_URL,
  OTHER_SHA,
  PR_NUMBER,
  PR_URL,
  RUN_ID,
  TARGET,
  TREE_SHA,
  VERIFIER,
  WRITER,
  artifactRef,
  countingProxy,
  defaultCi,
  defaultLane,
  defaultLanes,
  defaultPr,
  defaultPush,
  defaultTests,
  defaultVerifier,
  defaultWorktree,
  forgedReceipt,
  matchingTopology,
  trapTotal,
  validRequest,
} from './fixtures/r1-final-decision-card-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(utilTypes.isProxy(error), false);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false, 'must not leak repository paths');
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_URL), false);
  assert.equal(text.includes(HOSTILE_GIT), false);
  assert.equal(text.includes(HOSTILE_SECRET), false);
  assert.equal(text.includes(HOSTILE_TOKEN), false);
  assert.equal(text.includes(HOSTILE_PROSE), false);
  for (const extra of extras) {
    if (typeof extra === 'string' && extra.length > 0 && extra.length < 500) {
      assert.equal(text.includes(extra), false, `leaked ${JSON.stringify(extra)}`);
    }
  }
  if (typeof value === 'object' && value && typeof value.message === 'string') {
    assert.match(value.message, CONTENT_FREE);
  }
}

function assertRejected(action, extras = []) {
  const error = errorOf(action);
  assertContentFree(error, extras);
  assertContentFree(error.path, extras);
  assertContentFree(inspect({
    name: error.name, code: error.code, path: error.path, message: error.message,
  }, { depth: 4, getters: true }), extras);
  assert.equal(String(error.message).includes('TypeError'), false);
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= 200);
  return error;
}

test('forged receipts cannot inject ready_for_sol_merge or provider prose', () => {
  const forged = assertRejected(() => projectFinalDecisionCardV1(forgedReceipt()));
  assert.equal(forged.code, 'unknown_key');

  const extraReady = validRequest();
  extraReady.ready_for_sol_merge = true;
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(extraReady)).code, 'unknown_key');

  const prose = validRequest();
  prose.notes = HOSTILE_PROSE;
  assert.equal(assertRejected(
    () => projectFinalDecisionCardV1(prose),
    [HOSTILE_PROSE],
  ).code, 'unknown_key');

  const claim = validRequest();
  claim.ci = { ...validRequest().ci, conclusion: 'success' };
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(claim)).code, 'unknown_key');

  const stringReady = validRequest({
    verifier: defaultVerifier({ accepted: 'true', status: 'verified' }),
  });
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(stringReady)).code, 'invalid_type');
});

test('stale CI never yields ready_for_sol_merge', () => {
  const staleFreshness = projectFinalDecisionCardV1(validRequest({
    ci: defaultCi({ freshness: 'stale' }),
  }));
  assert.equal(staleFreshness.ready_for_sol_merge, false);
  assert.equal(staleFreshness.label, PUBLIC_LABEL_BLOCKED);
  assert.equal(staleFreshness.blockers.includes('stale_ci'), true);
  assert.equal(staleFreshness.merge.cas.current_green_ci, false);
  assert.equal(staleFreshness.merge.cas.exact_head, false);
  assert.equal(staleFreshness.merge.cas.exact_tree, false);

  const staleHead = projectFinalDecisionCardV1(validRequest({
    ci: defaultCi({ observed_head: OTHER_SHA }),
  }));
  assert.equal(staleHead.ready_for_sol_merge, false);
  assert.equal(staleHead.blockers.includes('stale_ci'), true);
  assert.equal(staleHead.blockers.includes('missing_candidate_head'), true);
  assert.equal(staleHead.ci.observed_head, OTHER_SHA);
  assert.equal(staleHead.candidate.head, HEAD_SHA);
  assert.equal(staleHead.merge.cas.exact_head, false);
});

test('hidden and unknown checks are exact blockers', () => {
  const hidden = projectFinalDecisionCardV1(validRequest({
    ci: defaultCi({ hidden_checks: true }),
  }));
  assert.equal(hidden.ready_for_sol_merge, false);
  assert.equal(hidden.blockers.includes('hidden_checks'), true);
  assert.equal(hidden.merge.sol_regular_merge_permitted, false);

  const unknown = projectFinalDecisionCardV1(validRequest({
    ci: defaultCi({ state: 'unknown', unknown_checks: true }),
  }));
  assert.equal(unknown.ready_for_sol_merge, false);
  assert.equal(unknown.blockers.includes('unknown_checks'), true);
  assert.equal(unknown.summary.ci === 'unknown' || unknown.blockers.includes('unknown_checks'), true);
});

test('mismatched PR head blocks even when CI is current green', () => {
  const card = projectFinalDecisionCardV1(validRequest({
    pr: defaultPr({ number: 7, head: OTHER_SHA }),
  }));
  assert.equal(card.ready_for_sol_merge, false);
  assert.equal(card.blockers.includes('mismatched_pr_head'), true);
  assert.equal(card.blockers.includes('missing_candidate_head'), true);
  assert.equal(card.pr.head, OTHER_SHA);
  assert.equal(card.candidate.head, HEAD_SHA);
  assert.equal(card.merge.cas.current_green_ci, true);
  assert.equal(card.merge.cas.exact_head, false);
  assert.equal(card.merge.card_can_merge, false);
});

test('unknown fields, proxies, and hostile URLs fail closed without leaking bytes', () => {
  const extra = validRequest();
  extra.extra = true;
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(extra)).code, 'unknown_key');

  const { proxy, counts } = countingProxy(validRequest());
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const hostilePr = validRequest({
    pr: defaultPr({ url: HOSTILE_URL, number: 9 }),
  });
  assert.equal(assertRejected(
    () => projectFinalDecisionCardV1(hostilePr),
    [HOSTILE_URL, 'token=secret'],
  ).code, 'unknown_key');
});

test('partial provider failure and unresolved lanes are complete blockers', () => {
  const lanes = [
    defaultLane({ assignment_id: VERIFIER, role: 'verify' }),
    defaultLane({
      assignment_id: WRITER, provider: 'dsh', status: 'failed', accepted: false,
    }),
  ];
  const partial = projectFinalDecisionCardV1(validRequest({
    lanes,
    topology: matchingTopology(lanes),
  }));
  assert.equal(partial.ready_for_sol_merge, false);
  assert.equal(partial.blockers.includes('partial_provider_failure'), true);
  assert.equal(partial.attribution.find((lane) => lane.assignment_id === WRITER).provider, 'dsh');
  assert.equal(partial.attribution.find((lane) => lane.assignment_id === WRITER).status, 'failed');

  const unresolvedLanes = [
    defaultLane({ assignment_id: VERIFIER, role: 'verify' }),
    defaultLane({
      assignment_id: WRITER, provider: 'cursor-cloud', status: 'unresolved', accepted: false,
    }),
  ];
  const unresolved = projectFinalDecisionCardV1(validRequest({
    lanes: unresolvedLanes,
    topology: matchingTopology(unresolvedLanes),
  }));
  assert.equal(unresolved.ready_for_sol_merge, false);
  assert.equal(unresolved.blockers.includes('unresolved_lanes'), true);
  assert.equal(unresolved.label, PUBLIC_LABEL_BLOCKED);
});

test('truncation provenance is deterministic and does not drop the ready decision', () => {
  const artifacts = [];
  for (let i = 1; i <= MAX_ARTIFACT_RETAINED + 2; i += 1) artifacts.push(artifactRef(i));
  const first = projectFinalDecisionCardV1(validRequest({ artifacts }));
  const second = projectFinalDecisionCardV1(validRequest({ artifacts }));
  assert.deepEqual(first.truncation, second.truncation);
  assert.equal(first.truncation.truncated, true);
  assert.equal(first.truncation.reason, ARTIFACT_TRUNCATION_REASON);
  assert.equal(first.truncation.omitted, 2);
  assert.equal(first.artifacts.length, MAX_ARTIFACT_RETAINED);
  assert.equal(first.ready_for_sol_merge, true);

  const overflow = [];
  for (let i = 1; i <= MAX_ARTIFACT_INPUT + 1; i += 1) overflow.push(artifactRef(i));
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(validRequest({
    artifacts: overflow,
  }))).code, 'bounds_exceeded');
});

test('the valid ready case still fails closed on protected-ref mutation and force push', () => {
  const ready = projectFinalDecisionCardV1(validRequest());
  assert.equal(ready.label, PUBLIC_LABEL_READY);
  assert.equal(ready.ready_for_sol_merge, true);
  assert.equal(ready.merge.cas.exact_head, true);
  assert.equal(ready.merge.cas.exact_tree, true);
  assert.equal(ready.worktree.active_git_operation, 'none');
  assert.equal(ready.pr.is_draft, true);
  assert.equal(ready.pr.state, 'open');
  assert.equal(ready.pr.url, PR_URL);

  const mutated = projectFinalDecisionCardV1(validRequest({
    protected_ref: { mutated: true },
  }));
  assert.equal(mutated.ready_for_sol_merge, false);
  assert.equal(mutated.blockers.includes('protected_ref_mutation'), true);

  const forced = projectFinalDecisionCardV1(validRequest({
    push: defaultPush({ published: true, force: true }),
  }));
  assert.equal(forced.ready_for_sol_merge, false);
  assert.equal(forced.blockers.includes('force_push'), true);
  assert.equal(forced.push.state, 'force');
  assert.equal(forced.merge.card_can_merge, false);
});

test('format-only SHAs and stale booleans cannot authorize a substituted head or tree', () => {
  const substitutedHead = projectFinalDecisionCardV1(validRequest({
    verifier: defaultVerifier({ observed_head: OTHER_SHA }),
  }));
  assert.equal(substitutedHead.ready_for_sol_merge, false);
  assert.equal(substitutedHead.merge.cas.exact_head, false);
  assert.equal(substitutedHead.merge.cas.exact_tree, false);
  assert.equal(substitutedHead.blockers.includes('missing_candidate_head'), true);
  assert.equal(substitutedHead.candidate.head, HEAD_SHA);

  const substitutedTree = projectFinalDecisionCardV1(validRequest({
    tests: {
      present: true,
      passed: true,
      observed_head: HEAD_SHA,
      observed_tree: OTHER_SHA,
      freshness: 'current',
    },
  }));
  assert.equal(substitutedTree.ready_for_sol_merge, false);
  assert.equal(substitutedTree.merge.cas.exact_head, false);
  assert.equal(substitutedTree.merge.cas.exact_tree, false);
  assert.equal(substitutedTree.blockers.includes('missing_candidate_tree'), true);

  const swappedCandidate = projectFinalDecisionCardV1(validRequest({
    candidate: {
      branch: BRANCH,
      head: OTHER_SHA,
      tree: TREE_SHA,
      composed: true,
    },
  }));
  assert.equal(swappedCandidate.ready_for_sol_merge, false);
  assert.equal(swappedCandidate.merge.cas.exact_head, false);
  assert.equal(swappedCandidate.merge.cas.exact_tree, false);
  assert.equal(swappedCandidate.blockers.includes('missing_candidate_head'), true);
  assert.equal(isSha40Like(swappedCandidate.candidate.head), true);

  const staleBoolean = projectFinalDecisionCardV1(validRequest({
    push: defaultPush({ freshness: 'stale' }),
  }));
  assert.equal(staleBoolean.ready_for_sol_merge, false);
  assert.equal(staleBoolean.merge.cas.exact_head, false);
  assert.equal(staleBoolean.merge.cas.exact_tree, false);
  assert.equal(staleBoolean.blockers.includes('stale_evidence'), true);
  assert.equal(staleBoolean.push.observed_head, HEAD_SHA);
});

function isSha40Like(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

test('required lanes that are cancelled, failed, blocked, or nonterminal never yield ready', () => {
  const blocking = [
    'cancelled', 'failed', 'blocked', 'needs_attention', 'unresolved',
    'transport_lost', 'environment_blocked', 'unknown', 'running',
  ];
  for (const status of blocking) {
    const lanes = [
      defaultLane({ assignment_id: VERIFIER, role: 'verify' }),
      defaultLane({
        assignment_id: WRITER, status, accepted: false,
      }),
    ];
    const card = projectFinalDecisionCardV1(validRequest({
      lanes,
      topology: matchingTopology(lanes),
    }));
    assert.equal(card.ready_for_sol_merge, false, status);
    assert.equal(card.label, PUBLIC_LABEL_BLOCKED, status);
    if (
      status === 'cancelled' || status === 'failed' || status === 'blocked'
      || status === 'transport_lost' || status === 'environment_blocked'
    ) {
      assert.equal(card.blockers.includes('partial_provider_failure'), true, status);
    } else {
      assert.equal(card.blockers.includes('unresolved_lanes'), true, status);
    }
  }

  const completedNotAccepted = [
    defaultLane({ assignment_id: VERIFIER, role: 'verify' }),
    defaultLane({ assignment_id: WRITER, status: 'completed', accepted: false }),
  ];
  const notAccepted = projectFinalDecisionCardV1(validRequest({
    lanes: completedNotAccepted,
    topology: matchingTopology(completedNotAccepted),
  }));
  assert.equal(notAccepted.ready_for_sol_merge, false);
  assert.equal(notAccepted.blockers.includes('unresolved_lanes'), true);
});

test('number-only or arbitrary HTTPS PR identity is not projected as trusted', () => {
  const numberOnly = validRequest();
  numberOnly.pr = {
    head: HEAD_SHA,
    target_branch: TARGET,
    number: PR_NUMBER,
  };
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(numberOnly)).code, 'missing_key');

  const urlOnly = validRequest();
  urlOnly.pr = {
    head: HEAD_SHA,
    target_branch: TARGET,
    url: PR_URL,
  };
  const urlError = assertRejected(() => projectFinalDecisionCardV1(urlOnly), [HOSTILE_URL]);
  assert.equal(urlError.code === 'missing_key' || urlError.code === 'unknown_key', true);

  const arbitraryUrl = validRequest();
  arbitraryUrl.pr = defaultPr({ url: HOSTILE_URL });
  assert.equal(assertRejected(
    () => projectFinalDecisionCardV1(arbitraryUrl),
    [HOSTILE_URL, 'token=secret'],
  ).code, 'unknown_key');

  const notDraft = projectFinalDecisionCardV1(validRequest({
    pr: defaultPr({ is_draft: false }),
  }));
  assert.equal(notDraft.ready_for_sol_merge, false);
  assert.equal(notDraft.blockers.includes('missing_draft_pr'), true);
  assert.equal(notDraft.pr.url, PR_URL);

  const closed = projectFinalDecisionCardV1(validRequest({
    pr: defaultPr({ state: 'closed' }),
  }));
  assert.equal(closed.ready_for_sol_merge, false);
  assert.equal(closed.blockers.includes('missing_draft_pr'), true);
});

test('active git operations block readiness even when porcelain is clean', () => {
  for (const operation of ACTIVE_GIT_OPERATIONS) {
    if (operation === 'none') continue;
    const card = projectFinalDecisionCardV1(validRequest({
      worktree: defaultWorktree({ clean: true, active_git_operation: operation }),
    }));
    assert.equal(card.ready_for_sol_merge, false, operation);
    assert.equal(card.worktree.clean, true, operation);
    assert.equal(card.worktree.state, 'clean', operation);
    assert.equal(card.worktree.active_git_operation, operation);
    assert.equal(card.blockers.includes('active_git_operation'), true, operation);
    assert.equal(card.blockers.includes('dirty_worktree'), false, operation);
  }
});

test('a schema-valid maximally failing candidate returns every ordered blocker', () => {
  const lanes = [
    defaultLane({ assignment_id: VERIFIER, role: 'verify' }),
    defaultLane({
      assignment_id: WRITER, status: 'cancelled', accepted: false,
    }),
  ];
  const request = validRequest({
    candidate: {
      branch: BRANCH,
      head: HEAD_SHA,
      tree: TREE_SHA,
      composed: false,
    },
    worktree: defaultWorktree({
      clean: false,
      active_git_operation: 'rebase',
    }),
    verifier: defaultVerifier({
      accepted: false,
      status: 'blocked',
      observed_head: OTHER_SHA,
      observed_tree: OTHER_SHA,
      freshness: 'stale',
    }),
    tests: defaultTests({
      present: false,
      passed: false,
      observed_head: OTHER_SHA,
      observed_tree: OTHER_SHA,
      freshness: 'stale',
    }),
    ci: defaultCi({
      state: 'red',
      hidden_checks: true,
      unknown_checks: true,
      observed_head: OTHER_SHA,
      observed_tree: OTHER_SHA,
      freshness: 'stale',
    }),
    push: defaultPush({
      published: false,
      force: true,
      observed_head: OTHER_SHA,
      observed_tree: OTHER_SHA,
      freshness: 'stale',
    }),
    pr: defaultPr({
      is_draft: false,
      state: 'closed',
      head: OTHER_SHA,
      tree: OTHER_SHA,
      freshness: 'stale',
    }),
    topology: {
      digest: 'ab'.repeat(32),
      expected_digest: 'cd'.repeat(32),
    },
    protected_ref: { mutated: true },
    lanes,
  });
  let card;
  assert.doesNotThrow(() => {
    card = projectFinalDecisionCardV1(request);
  });
  const expectedBlockers = [
    'active_git_operation',
    'candidate_not_composed',
    'ci_not_green',
    'dirty_worktree',
    'force_push',
    'hidden_checks',
    'mismatched_pr_head',
    'missing_candidate_head',
    'missing_candidate_tree',
    'missing_draft_pr',
    'missing_topology',
    'missing_verifier_acceptance',
    'partial_provider_failure',
    'protected_ref_mutation',
    'stale_ci',
    'stale_evidence',
    'tests_not_passed',
    'unknown_checks',
    'unpublished_head',
  ];
  assert.equal(card.label, PUBLIC_LABEL_BLOCKED);
  assert.equal(card.ready_for_sol_merge, false);
  assert.equal(card.merge.card_can_merge, false);
  assert.equal(card.merge.sol_regular_merge_permitted, false);
  assert.ok(expectedBlockers.length > 16);
  assert.ok(expectedBlockers.length <= MAX_BLOCKERS);
  assert.ok(BLOCKER_CODES.length > 16);
  assert.deepEqual([...card.blockers], expectedBlockers);
  assert.deepEqual(
    [...card.blockers],
    [...BLOCKER_CODES].filter((code) => expectedBlockers.includes(code)),
  );
  assert.equal(new Set(card.blockers).size, card.blockers.length);
  assert.equal(Object.isFrozen(card.blockers), true);
  assert.equal(card.summary.ready_for_sol_merge, false);
  assert.equal(card.summary.blocker_count, expectedBlockers.length);
  const again = projectFinalDecisionCardV1(request);
  assert.deepEqual(again.blockers, card.blockers);
});

test('a ghost artifact assignment_id is never trusted and never yields ready', () => {
  const lanes = defaultLanes();
  assert.deepEqual(lanes.map((lane) => lane.assignment_id).sort(), [VERIFIER, WRITER].sort());
  const ghost = artifactRef(1, {
    assignment_id: GHOST,
    relative_path: `runs/${RUN_ID}/${GHOST}/diff-1.patch`,
  });
  const card = projectFinalDecisionCardV1(validRequest({
    lanes,
    artifacts: [ghost],
  }));
  assert.equal(card.ready_for_sol_merge, false);
  assert.equal(card.label, PUBLIC_LABEL_BLOCKED);
  assert.deepEqual([...card.blockers], ['unknown_assignment']);
  assert.equal(card.merge.sol_regular_merge_permitted, false);
  assert.equal(card.merge.card_can_merge, false);
  assert.equal(card.summary.ready_for_sol_merge, false);
  assert.deepEqual(
    [...card.attribution.map((lane) => lane.assignment_id)],
    [VERIFIER, WRITER],
  );
  assert.equal(card.attribution.some((lane) => lane.assignment_id === GHOST), false);

  const omittedGhost = [];
  for (let i = 1; i <= MAX_ARTIFACT_RETAINED; i += 1) omittedGhost.push(artifactRef(i));
  omittedGhost.push(artifactRef(MAX_ARTIFACT_RETAINED + 1, {
    assignment_id: 'lane-zzz',
    relative_path: `runs/${RUN_ID}/lane-zzz/diff-tail.patch`,
  }));
  const truncated = projectFinalDecisionCardV1(validRequest({ artifacts: omittedGhost }));
  assert.equal(truncated.ready_for_sol_merge, false);
  assert.equal(truncated.truncation.truncated, true);
  assert.equal(truncated.blockers.includes('unknown_assignment'), true);
  assert.equal(truncated.artifacts.some((ref) => ref.assignment_id === 'lane-zzz'), false);

  const missingAssignment = artifactRef(1);
  delete missingAssignment.assignment_id;
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(validRequest({
    artifacts: [missingAssignment],
  }))).code, 'missing_key');
});

test('duplicate lanes and defaultLanes remain a closed identity set', () => {
  const lanes = [...defaultLanes(), { ...defaultLanes()[0] }];
  assert.equal(assertRejected(() => projectFinalDecisionCardV1(validRequest({
    lanes,
    topology: matchingTopology(lanes),
  }))).code, 'invalid_format');
});
