import assert from 'node:assert/strict';
import test from 'node:test';

import {
  USER_REPORTS,
  bindHostThread,
  buildEnvelope,
  classifyTaskPortGitOperation,
  createLunaPmSession,
  planLunaNativeSubagents,
  relayEvent,
  sanitizeEvidenceRefs,
} from '../skills/delegate-to-co-engineer/references/luna-pm-relay.mjs';
import {
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  expectedLaneRefV1,
} from '../mcp/v3/git-authority.mjs';
import {
  ASSIGNMENT_ID,
  MANIFEST_DIGEST_HEX,
  RUN_ID as AUTH_RUN,
  validIdentity,
} from './fixtures/r1-git-authority-fixtures.mjs';

const RUN_ID = 'auth-review';
const OTHER_RUN = 'other-review';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = 'cccccccccccccccccccccccccccccccccccccccc';
const DIGEST = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const THREAD = 'thr_host_luna_1';
const HOST_ID = 'codex-desktop';
const HOST_TOOLS = Object.freeze(['create_thread', 'send_message_to_thread', 'wait_threads']);
const QUESTION_DIGEST = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

function baseInput(overrides = {}) {
  return {
    run_id: RUN_ID,
    luna_authorized: true,
    luna_available: true,
    host_tools: HOST_TOOLS,
    external_writer_scopes: [['src/auth.ts']],
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    message_id: 'msg-complete',
    run_id: RUN_ID,
    assignment_id: 'lane-alpha',
    attempt_id: '1',
    from_task_id: THREAD,
    to_task_id: THREAD,
    correlation_id: 'msg-complete',
    kind: 'completed',
    generation: '1',
    event_cursor: '1',
    created_at: '2026-08-28T00:00:00Z',
    event_summary: {
      assignment_state: { assignment_id: 'lane-alpha', state: 'complete' },
      candidate_head: SHA,
      candidate_tree: TREE,
    },
    ...overrides,
  };
}

function pinnedSession() {
  const bound = bindHostThread(createLunaPmSession(baseInput()), {
    threadId: THREAD, hostId: HOST_ID, afterCursor: '0',
  });
  assert.equal(bound.ok, true);
  return bound.session;
}

function gitRequest(overrides = {}) {
  return {
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: 'publisher',
    operation: 'push',
    identity: validIdentity(),
    manifest_digest_hex: MANIFEST_DIGEST_HEX,
    ref: expectedLaneRefV1({
      run_id: AUTH_RUN, assignment_id: ASSIGNMENT_ID, manifest_digest_hex: MANIFEST_DIGEST_HEX,
    }),
    publication: { user_authorized_publication: true, draft: true, force: false },
    ...overrides,
  };
}

function mergeReadySummary(overrides = {}) {
  return {
    assignment_state: { assignment_id: 'lane-alpha', state: 'complete' },
    candidate_head: SHA,
    candidate_tree: TREE,
    expected_head: SHA,
    current_head: SHA,
    current_tree: TREE,
    ci_green: true,
    ci_current: true,
    verifier_accepted: true,
    failed_check_count: 0,
    hidden_failed_checks: false,
    merge_topology_ok: true,
    ...overrides,
  };
}

function questionSummary(overrides = {}) {
  return {
    assignment_id: 'lane-alpha',
    task_id: THREAD,
    attempt: '1',
    generation: '1',
    session_id: 'sess-grok-1',
    question_id: 'q-1',
    provider: 'grok',
    correlation_id: 'msg-complete',
    question_digest: QUESTION_DIGEST,
    question_ids: ['q-1'],
    question_schema: 'choice',
    ...overrides,
  };
}

function assertDegraded(result, code) {
  assert.equal(result.mode, 'degraded_inline');
  assert.equal(result.pm, 'current_codex_task');
  assert.equal(result.sol, null);
  assert.equal(result.wake_sol, false);
  assert.match(result.user_report, /continuing in this Codex task/u);
  assert.match(result.user_report, /not substituting Sol/u);
  if (code) assert.equal(result.code, code);
}

test('nonexistent host aliases are rejected and do not invent a thread', () => {
  const created = createLunaPmSession(baseInput({
    host_tools: ['create_task', 'resume_task', 'message_task', 'wait_task'],
  }));
  assert.equal(created.ok, true);
  assert.equal(created.action, 'degraded_inline');
  assertDegraded(created, 'fictional_host_alias');
  assert.deepEqual(created.host_api_gap.rejected_aliases, [
    'create_task', 'resume_task', 'message_task', 'wait_task',
  ]);
  assert.equal(created.session.thread_id, null);
  assert.equal(created.host_calls.length, 0);
});

test('missing host task tools degrade inline and report the host API gap', () => {
  const created = createLunaPmSession(baseInput({ host_tools: ['status', 'delegate'] }));
  assert.equal(created.ok, true);
  assert.equal(created.action, 'degraded_inline');
  assertDegraded(created, 'missing_host_task_tools');
  assert.ok(created.host_api_gap.missing.includes('create_thread'));
  assert.equal(created.host_calls.length, 0);
  const relayed = relayEvent(created.session, envelope());
  assertDegraded(relayed, 'missing_host_task_tools');
});

test('Luna unauthorized or unavailable never substitutes Sol', () => {
  const unauthorized = createLunaPmSession(baseInput({ luna_authorized: false }));
  assertDegraded(unauthorized, 'luna_unauthorized');
  const unavailable = createLunaPmSession(baseInput({ luna_available: false }));
  assertDegraded(unavailable, 'luna_max_unavailable');
  assert.equal(unavailable.pm === 'sol-medium', false);
  assert.equal(unavailable.sol, null);
});

test('stale attempt, stale generation, and duplicate message ids are rejected', () => {
  const session = pinnedSession();
  const first = relayEvent(session, envelope({ event_cursor: '4', generation: '3', attempt_id: '2' }));
  assert.equal(first.ok, true);
  const duplicate = relayEvent(first.session, envelope({
    event_cursor: '5', generation: '3', attempt_id: '2',
  }));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.action, 'ignore_duplicate');
  assert.equal(duplicate.code, 'duplicate_event');
  assert.equal(duplicate.session.last_cursor, '4');
  const stale = relayEvent(first.session, envelope({
    message_id: 'msg-b', event_cursor: '3', generation: '3', attempt_id: '2',
  }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_event');
  const staleGen = relayEvent(first.session, envelope({
    message_id: 'msg-c', event_cursor: '5', generation: '1', attempt_id: '2',
  }));
  assert.equal(staleGen.code, 'stale_generation');
  const staleAttempt = relayEvent(first.session, envelope({
    message_id: 'msg-d', event_cursor: '5', generation: '3', attempt_id: '1',
  }));
  assert.equal(staleAttempt.code, 'stale_attempt');
});

test('wrong thread or run identity is rejected and unbound create does not invent a thread', () => {
  const session = pinnedSession();
  const wrongRun = relayEvent(session, envelope({ run_id: OTHER_RUN, message_id: 'msg-other' }));
  assert.equal(wrongRun.ok, false);
  assert.equal(wrongRun.action, 'reject_identity');
  assert.equal(wrongRun.code, 'wrong_run_identity');
  const wrongThread = relayEvent(session, envelope({ to_task_id: 'other-thread', message_id: 'msg-thread' }));
  assert.equal(wrongThread.ok, false);
  assert.equal(wrongThread.code, 'wrong_thread_identity');
  const created = createLunaPmSession(baseInput({ thread_id: `luna-${RUN_ID}` }));
  assert.equal(created.session.thread_id, null);
  assert.equal(created.action, 'create_thread');
  const missingBind = bindHostThread(created, {});
  assert.equal(missingBind.ok, false);
  assert.equal(missingBind.code, 'wrong_thread_identity');
});

test('over-bound bodies become artifact_ref and routine progress does not wake', () => {
  const spilled = buildEnvelope(envelope({
    body: 'x'.repeat(800),
    payload_digest: DIGEST,
  }));
  assert.equal(spilled.ok, true);
  assert.equal(spilled.envelope.artifact_ref.kind, 'spilled_body');
  assert.equal(spilled.envelope.artifact_ref.artifact_class, 'sanitized');
  const session = pinnedSession();
  const progress = relayEvent(session, envelope({
    message_id: 'msg-progress',
    kind: 'progress',
    event_summary: { assignment_state: { assignment_id: 'lane-alpha', state: 'running' } },
  }));
  assert.equal(progress.ok, true);
  assert.equal(progress.action, 'append_progress');
  assert.equal(progress.wake_luna, false);
  assert.equal(progress.wake_sol, false);
  assert.equal(progress.host_calls.length, 0);
});

test('grouped attention requires every needed question id', () => {
  const missing = buildEnvelope(envelope({
    kind: 'question',
    event_summary: { question_schema: 'choice' },
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'grouped_attention_missing_ids');
  const missingIdentity = buildEnvelope(envelope({
    kind: 'question',
    event_summary: { question_ids: ['q-1'], question_schema: 'choice' },
  }));
  assert.equal(missingIdentity.ok, false);
  assert.equal(missingIdentity.code, 'grouped_attention_missing_identity');
  const grouped = buildEnvelope(envelope({
    kind: 'question',
    event_summary: questionSummary({ question_ids: ['q-1', 'q-2'] }),
  }));
  assert.equal(grouped.ok, true, grouped.code);
  assert.deepEqual(grouped.envelope.event_summary.question_ids, ['q-1', 'q-2']);
  assert.equal(grouped.envelope.event_summary.question_identities.length, 2);
  assert.equal(grouped.envelope.event_summary.question_identity, null);
  for (const identity of grouped.envelope.event_summary.question_identities) {
    assert.equal(identity.task_id, THREAD);
    assert.equal(identity.assignment_id, 'lane-alpha');
    assert.equal(identity.session_id, 'sess-grok-1');
    assert.equal(identity.attempt, '1');
    assert.equal(identity.generation, '1');
    assert.equal(identity.correlation_id, 'msg-complete');
    assert.equal(identity.question_digest, QUESTION_DIGEST);
  }
});

test('Luna failure falls back inline without a Sol substitute', () => {
  const session = pinnedSession();
  const failed = relayEvent(session, envelope({ luna_failed: true }));
  assert.equal(failed.ok, true);
  assert.equal(failed.action, 'degraded_inline');
  assertDegraded(failed, 'luna_failed');
  assert.equal(failed.host_calls.length, 0);
});

test('unauthorized Sol escalation is rejected, including Sol Medium as default PM', () => {
  const solDefault = createLunaPmSession(baseInput({ default_pm: 'sol-medium' }));
  assert.equal(solDefault.ok, false);
  assert.equal(solDefault.action, 'reject_sol_escalation');
  assert.equal(solDefault.code, 'unauthorized_sol_escalation');
  assert.match(solDefault.user_report, /not substituting Sol/u);

  const override = createLunaPmSession(baseInput({ user_model_override: 'sol-high' }));
  assert.equal(override.ok, false);
  assert.equal(override.code, 'unauthorized_sol_escalation');

  const session = pinnedSession();
  const wake = relayEvent(session, envelope({
    message_id: 'msg-sol',
    kind: 'question',
    wake_sol: true,
    event_summary: questionSummary({ correlation_id: 'msg-sol' }),
  }));
  assert.equal(wake.ok, false);
  assert.equal(wake.action, 'reject_sol_escalation');
  assert.equal(wake.code, 'unauthorized_sol_escalation');

  const child = relayEvent(session, envelope({
    message_id: 'msg-child',
    kind: 'merge_ready',
    from_task_id: 'child-analysis-1',
    event_summary: mergeReadySummary(),
  }));
  assert.equal(child.ok, false);
  assert.equal(child.code, 'unauthorized_sol_escalation');
});

test('normal completion never wakes Sol even when asked', () => {
  const session = pinnedSession();
  const completed = relayEvent(session, envelope({
    wake_sol: true,
    sol_criterion: 'release_authority_decision',
    sol_authorized: true,
  }));
  assert.equal(completed.ok, true);
  assert.equal(completed.action, 'complete_no_sol');
  assert.equal(completed.wake_luna, true);
  assert.equal(completed.wake_sol, false);
  assert.equal(completed.sol, null);
  assert.match(completed.user_report, /does not wake Sol/u);
});

test('duplicate Co-Engineer writer assignment and depth or lane-budget violations are rejected', () => {
  const overlap = planLunaNativeSubagents(
    [{ id: 'rewrite', role: 'local_analysis', access: 'read_only', write_scope: ['src/auth.ts'] }],
    [['src/auth.ts']],
  );
  assert.equal(overlap.ok, false);
  assert.equal(overlap.code, 'duplicate_writer_assignment');
  const writerRole = planLunaNativeSubagents(
    [{ id: 'rewrite', role: 'implement', access: 'writer' }],
    [['docs/guide.md']],
  );
  assert.equal(writerRole.ok, false);
  const depth = planLunaNativeSubagents(
    [{ id: 'too-deep', scope: 'docs/' }],
    [['src/auth.ts']],
    { parent_depth: 2, external_lane_count: 1 },
  );
  assert.equal(depth.code, 'native_subagent_depth');
  const budget = planLunaNativeSubagents(
    [{ id: 'one' }, { id: 'two' }],
    [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']],
    { parent_depth: 1, external_lane_count: 7 },
  );
  assert.equal(budget.code, 'native_subagent_bound');
  const created = createLunaPmSession(baseInput({
    native_subagents: [{ id: 'rewrite', write_scope: ['src/auth.ts'] }],
  }));
  assert.equal(created.ok, false);
  assert.equal(created.action, 'reject_duplicate_writer');
  assert.equal(created.code, 'duplicate_writer_assignment');
});

test('raw transcripts and secrets never enter relay evidence', () => {
  const secret = sanitizeEvidenceRefs([
    { kind: 'transcript', transcript: 'sk-leakedsecretvalue', artifact_class: 'sanitized' },
  ]);
  assert.equal(secret[0].denied, true);
  const raw = sanitizeEvidenceRefs([{ kind: 'git_diff', artifact_class: 'raw', sha256: DIGEST }]);
  assert.equal(raw[0].code, 'secret_or_transcript_evidence');
  const session = pinnedSession();
  const relayed = relayEvent(session, envelope({
    evidence_refs: [{ prompt: 'SYSTEM', stdout: 'token=github_pat_hostileleak' }],
  }));
  assert.equal(relayed.ok, false);
  assert.equal(relayed.code, 'secret_or_transcript_evidence');
});

test('publisher cannot push other or protected refs, non-draft PRs, or force, tag, or release', () => {
  const other = classifyTaskPortGitOperation(gitRequest({
    ref: 'refs/heads/codex/run-aaaaaaaaaaaaaaaa/lane-beta',
  }));
  assert.equal(other.verdict, 'denied');
  const protectedRef = classifyTaskPortGitOperation(gitRequest({ ref: 'refs/heads/main' }));
  assert.equal(protectedRef.verdict, 'denied');
  assert.equal(protectedRef.code, 'default_branch_target_denied');
  const nonDraft = classifyTaskPortGitOperation(gitRequest({
    operation: 'create_pr',
    publication: { user_authorized_publication: true, draft: false, force: false },
  }));
  assert.equal(nonDraft.code, 'non_draft_pr_denied');
  const forced = classifyTaskPortGitOperation(gitRequest({
    publication: { user_authorized_publication: true, draft: true, force: true },
  }));
  assert.equal(forced.code, 'push_authority_denied');
  const forcePush = classifyTaskPortGitOperation(gitRequest({ operation: 'force_push' }));
  assert.equal(forcePush.code, 'push_authority_denied');
  const tag = classifyTaskPortGitOperation(gitRequest({ operation: 'tag_create' }));
  assert.equal(tag.code, 'protected_ref_write_denied');
  const release = classifyTaskPortGitOperation(gitRequest({ operation: 'release_create' }));
  assert.equal(release.code, 'protected_ref_write_denied');
});

test('merge_ready does not wake Sol without exact head, CI, verifier, and topology facts', () => {
  const session = pinnedSession();
  const incomplete = relayEvent(session, envelope({
    message_id: 'msg-merge-incomplete',
    kind: 'merge_ready',
    event_summary: {
      candidate_head: SHA,
      candidate_tree: TREE,
      verifier_accepted: true,
    },
  }));
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'merge_ready_incomplete');
  assert.equal(incomplete.wake_sol, false);
  const stale = relayEvent(session, envelope({
    message_id: 'msg-merge-stale',
    kind: 'merge_ready',
    event_summary: mergeReadySummary({ ci_current: false }),
  }));
  assert.equal(stale.code, 'merge_ready_incomplete');
  const hidden = relayEvent(session, envelope({
    message_id: 'msg-merge-hidden',
    kind: 'merge_ready',
    event_summary: mergeReadySummary({ hidden_failed_checks: true }),
  }));
  assert.equal(hidden.code, 'merge_ready_incomplete');
});

test('messages cannot force-push, merge, rebase, tag, release, delete refs, or override verification', () => {
  const session = pinnedSession();
  const forced = relayEvent(session, envelope({
    message_id: 'msg-force',
    git_operation: gitRequest({ operation: 'force_push' }),
  }));
  assert.equal(forced.ok, false);
  assert.equal(forced.code, 'git_override_denied');
  const merge = relayEvent(session, envelope({
    message_id: 'msg-merge-op',
    git_operation: gitRequest({ actor: 'worker', operation: 'merge_pr' }),
  }));
  assert.equal(merge.ok, false);
  assert.equal(['git_override_denied', 'merge_authority_denied'].includes(merge.code), true, merge.code);
});

test('Luna and workers cannot merge; Sol fails on changed head, stale CI, failed checks, and identity drift', () => {
  const luna = classifyTaskPortGitOperation(gitRequest({ actor: 'luna', operation: 'merge_pr' }));
  assert.equal(luna.verdict, 'denied');
  assert.equal(luna.code, 'merge_authority_denied');
  const worker = classifyTaskPortGitOperation(gitRequest({ actor: 'worker', operation: 'merge_pr' }));
  assert.equal(worker.code, 'merge_authority_denied');

  const publication = {
    user_authorized_publication: true,
    expected_head: SHA,
    current_head: SHA,
    current_tree: TREE,
    candidate_tree: TREE,
    ci_green: true,
    ci_current: true,
    failed_check_count: 0,
    hidden_failed_checks: false,
    verifier_accepted: true,
    merge_topology_ok: true,
    force: false,
  };
  const ready = classifyTaskPortGitOperation(gitRequest({
    actor: 'sol',
    operation: 'merge_pr',
    identity: validIdentity({ head_sha: SHA }),
    publication,
  }));
  assert.equal(ready.verdict, 'allowed');

  const changedHead = classifyTaskPortGitOperation(gitRequest({
    actor: 'sol',
    operation: 'merge_pr',
    identity: validIdentity({ head_sha: SHA }),
    publication: { ...publication, current_head: OTHER },
  }));
  assert.equal(changedHead.code, 'expected_head_mismatch');
  const staleCi = classifyTaskPortGitOperation(gitRequest({
    actor: 'sol',
    operation: 'merge_pr',
    identity: validIdentity({ head_sha: SHA }),
    publication: { ...publication, ci_current: false },
  }));
  assert.equal(staleCi.code, 'stale_ci');
  const failed = classifyTaskPortGitOperation(gitRequest({
    actor: 'sol',
    operation: 'merge_pr',
    identity: validIdentity({ head_sha: SHA }),
    publication: { ...publication, ci_green: false, failed_check_count: 1 },
  }));
  assert.equal(failed.code, 'failed_checks_present');
  const hidden = classifyTaskPortGitOperation(gitRequest({
    actor: 'sol',
    operation: 'merge_pr',
    identity: validIdentity({ head_sha: SHA }),
    publication: { ...publication, hidden_failed_checks: true },
  }));
  assert.equal(hidden.code, 'failed_checks_present');
  const drift = classifyTaskPortGitOperation(gitRequest({
    actor: 'sol',
    operation: 'merge_pr',
    identity: validIdentity({ head_sha: SHA }),
    publication: { ...publication, current_tree: OTHER },
  }));
  assert.equal(drift.code, 'identity_drift');
});

test('safe inline fallback keeps one Codex task and does not invent a model', () => {
  const created = createLunaPmSession(baseInput({
    host_tools: [],
    luna_available: false,
  }));
  assert.equal(created.ok, true);
  assert.equal(created.action, 'degraded_inline');
  assertDegraded(created);
  assert.equal(created.session.thread_id, null);
  assert.equal(created.preserved.submissions, 1);
  assert.equal(created.preserved.aggregate_wait, 'decision_or_attention');
  assert.equal(created.user_report.includes(USER_REPORTS.no_sol_substitute), true);
  assert.equal(JSON.stringify(created).includes('sol-medium'), false);
});
