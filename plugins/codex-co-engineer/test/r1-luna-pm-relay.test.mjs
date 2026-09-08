import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COORDINATION,
  DEFAULT_PM_MODEL,
  HOST_TASK_EXECUTOR,
  HOST_TASK_SEQUENCE,
  HOST_TASK_TOOL_ACTIONS,
  LIVE_WAIT_THREADS_TARGET_SCHEMA,
  LUNA_NATIVE_SUBAGENT_ROLE,
  LUNA_PM_SCHEMA,
  SOL_ADJUDICATOR_MODELS,
  SOL_ESCALATION_CRITERIA,
  USER_REPORTS,
  WAKING_KINDS,
  bindHostThread,
  buildEnvelope,
  classifyTaskPortGitOperation,
  createLunaPmSession,
  detectHostTaskTools,
  mergeReadyFactsPass,
  planLunaNativeSubagents,
  relayEvent,
  routeStructuredAttentionResponse,
  shouldEscalateToSol,
  shouldWakeLuna,
} from '../skills/delegate-to-co-engineer/references/luna-pm-relay.mjs';
import {
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  expectedLaneRefV1,
} from '../mcp/v3/git-authority.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  MANIFEST_DIGEST_HEX,
  RUN_ID as AUTH_RUN,
  validIdentity,
} from './fixtures/r1-git-authority-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const PLUGIN = path.join(HERE, '..');
const CONTRACT = path.join(HERE, 'fixtures', 'v3-luna-pm-relay', 'contract.json');
const EXPERIENCE = path.join(HERE, 'fixtures', 'v3-experience-contract.json');

const RUN_ID = 'auth-review';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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
    provider_selection: { grok: 'grok-4' },
    user_model_override: 'grok-4',
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

async function loadJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function pinnedSession(overrides = {}) {
  const created = createLunaPmSession(baseInput(overrides));
  const bound = bindHostThread(created, {
    threadId: THREAD, hostId: HOST_ID, afterCursor: '0',
  });
  assert.equal(bound.ok, true, bound.code);
  return bound.session;
}

test('Luna PM contract matches experience fixture and skill-owned TaskPort', async () => {
  const contract = await loadJson(CONTRACT);
  const experience = await loadJson(EXPERIENCE);
  assert.equal(contract.schema, LUNA_PM_SCHEMA);
  assert.equal(contract.default_model, DEFAULT_PM_MODEL);
  assert.deepEqual(contract.host_task_tools, HOST_TASK_TOOL_ACTIONS);
  assert.deepEqual(contract.wake_events, WAKING_KINDS);
  assert.deepEqual(contract.sol_escalation_criteria, SOL_ESCALATION_CRITERIA);
  assert.deepEqual(contract.sol_adjudicator, SOL_ADJUDICATOR_MODELS);
  assert.equal(contract.sol_medium_mandatory, false);
  assert.equal(experience.luna_pm.default_model, DEFAULT_PM_MODEL);
  assert.deepEqual(experience.luna_pm.wake_events, WAKING_KINDS);
  assert.deepEqual(experience.luna_pm.sol_escalation_criteria, SOL_ESCALATION_CRITERIA);
  assert.equal(experience.luna_pm.public_skill, false);
  assert.equal(COORDINATION.submissions, 1);
  assert.equal(COORDINATION.aggregate_wait, 'decision_or_attention');
  assert.equal(COORDINATION.merge_actor, 'sol');
  assert.equal(COORDINATION.luna_merges, false);
  assert.equal(contract.host_executor, HOST_TASK_EXECUTOR);
  assert.deepEqual(contract.wait_threads_target, LIVE_WAIT_THREADS_TARGET_SCHEMA);
  assert.deepEqual(HOST_TASK_SEQUENCE[0], 'create_thread');
});

test('feature-detects create_thread, send_message_to_thread, and wait_threads or read_thread', () => {
  const detected = detectHostTaskTools([...HOST_TOOLS, 'set_thread_pinned', 'spawn_agent']);
  assert.equal(detected.complete, true);
  assert.equal(detected.resolved.create_thread, 'create_thread');
  assert.equal(detected.resolved.send_message_to_thread, 'send_message_to_thread');
  assert.equal(detected.resolved.wait, 'wait_threads');
  assert.deepEqual(detected.optional, ['set_thread_pinned']);
  assert.equal(detected.cancellation_supported, false);
  assert.equal(detectHostTaskTools(['create_thread', 'send_message_to_thread', 'read_thread']).complete, true);
  assert.equal(detectHostTaskTools(['send_message_to_thread']).complete, false);
  assert.deepEqual(
    detectHostTaskTools(['create_task', 'resume_task', 'message_task', 'wait_task', 'cancel_thread']).rejected_aliases,
    ['create_task', 'resume_task', 'message_task', 'wait_task', 'cancel_thread'],
  );
});

test('pins a user-authorized Luna Max task without synthesizing a thread id', () => {
  const created = createLunaPmSession(baseInput());
  assert.equal(created.ok, true);
  assert.equal(created.mode, 'luna_max_pinned');
  assert.equal(created.pm, 'luna-max');
  assert.equal(created.action, 'create_thread');
  assert.equal(created.host_calls[0].tool, 'create_thread');
  assert.equal(created.host_calls[0].model, 'luna-max');
  assert.equal(created.session.thread_id, null);
  assert.equal(created.session.host_bound, false);
  assert.equal(created.user_report, USER_REPORTS.luna_pinned);
  assert.equal(created.preserved.user_model_override, 'grok-4');
  assert.deepEqual(created.preserved.provider_selection, { grok: 'grok-4' });
  assert.equal(created.preserved.merge_actor, 'sol');
  assert.equal(created.preserved.automatic_merge, false);
  assert.equal(created.preserved.learned_routing, false);
  assert.equal(created.preserved.semantic_memory, false);
  assert.equal(JSON.stringify(created.session).includes('seen_event_ids'), false);
});

test('create result binds the actual host thread id and cursor', () => {
  const created = createLunaPmSession(baseInput({ host_tools: [...HOST_TOOLS, 'set_thread_pinned'] }));
  const bound = bindHostThread(created, {
    threadId: THREAD, hostId: HOST_ID, afterCursor: '0',
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.action, 'bind_thread');
  assert.equal(bound.session.thread_id, THREAD);
  assert.equal(bound.session.host_id, HOST_ID);
  assert.equal(bound.session.host_bound, true);
  assert.equal(bound.session.last_cursor, '0');
  assert.equal(bound.host_calls[0].tool, 'set_thread_pinned');
  assert.equal(bound.host_calls[0].threadId, THREAD);
  const queued = bindHostThread(created, {
    clientThreadId: 'client_luna_1', hostId: HOST_ID, afterCursor: '0',
  });
  assert.equal(queued.ok, false);
  assert.equal(queued.code, 'setup_pending');
  assert.equal(queued.action, 'resume_needed');
  assert.equal(queued.resume_needed, true);
  assert.equal(queued.session.thread_id, null);
  assert.equal(queued.session.host_bound, false);
  assert.equal(queued.session.queued_thread, true);
  assert.equal(queued.host_calls.length, 0);
  const relayed = relayEvent(queued.session, envelope());
  assert.equal(relayed.ok, false);
  assert.equal(relayed.code, 'setup_pending');
  assert.equal(relayed.host_calls.length, 0);
});

test('continues an already host-bound Luna thread for the same run', () => {
  const created = createLunaPmSession(baseInput({
    thread_id: THREAD,
    host_bound: true,
    last_cursor: '4',
  }));
  assert.equal(created.ok, true);
  assert.equal(created.action, 'continue_bound_thread');
  assert.equal(created.host_calls.length, 0);
  assert.equal(created.session.thread_id, THREAD);
});

test('wakes Luna on compact kinds, never on progress, and never wakes Sol on completed', () => {
  const session = pinnedSession();
  let cursor = 0;
  for (const kind of WAKING_KINDS) {
    if (kind === 'merge_ready') continue;
    cursor += 1;
    const forwarded = relayEvent(session, envelope({
      message_id: `msg-${kind}`,
      kind,
      event_cursor: String(cursor),
      event_summary: kind === 'question'
        ? questionSummary({ correlation_id: `msg-${kind}` })
        : { assignment_state: { assignment_id: 'lane-alpha', state: 'complete' } },
    }));
    assert.equal(forwarded.ok, true, `${kind}: ${forwarded.code}`);
    assert.equal(forwarded.wake_luna, true, kind);
    assert.equal(forwarded.wake_sol, false, kind);
  }
  assert.equal(shouldWakeLuna('progress'), false);
  assert.equal(shouldEscalateToSol(envelope({ kind: 'completed', sol_criterion: 'release_authority_decision' })), false);
});

test('forwards identity-bound sanitized envelopes and resumes from a bounded recent-id window', () => {
  const session = pinnedSession();
  const first = relayEvent(session, envelope({ event_cursor: '2' }));
  assert.equal(first.ok, true);
  assert.equal(first.action, 'bind_and_forward');
  assert.equal(first.message.run_id, RUN_ID);
  assert.equal(first.message.message_id, 'msg-complete');
  assert.equal(first.message.event_cursor, '2');
  assert.equal(first.message.kind, 'completed');
  assert.equal(first.host_calls.map((call) => call.tool).join(','), 'send_message_to_thread,wait_threads');
  assert.equal(first.host_calls[0].threadId, THREAD);
  assert.equal(typeof first.host_calls[0].prompt, 'string');
  assert.ok(first.host_calls[0].prompt.length > 0);
  assert.deepEqual(first.host_calls[1].targets, [{
    threadId: THREAD, hostId: HOST_ID, afterCursor: '2',
  }]);
  assert.equal(typeof first.host_calls[1].timeoutMs, 'number');
  assert.equal(first.session.recent_ids.length, 1);
  assert.equal(typeof first.session.recent_digest, 'string');
  assert.equal(JSON.stringify(first.session).includes('seen_event_ids'), false);

  const second = relayEvent(first.session, envelope({
    message_id: 'msg-timeout',
    kind: 'timeout',
    event_cursor: '3',
  }));
  assert.equal(second.ok, true);
  assert.equal(second.session.last_cursor, '3');
  assert.deepEqual(second.session.recent_ids, ['msg-complete', 'msg-timeout']);
});

test('merge_ready alone wakes Sol High exactly once', () => {
  const session = pinnedSession();
  const ready = relayEvent(session, envelope({
    message_id: 'msg-merge',
    kind: 'merge_ready',
    event_summary: mergeReadySummary(),
  }));
  assert.equal(ready.ok, true, ready.code);
  assert.equal(ready.action, 'wake_sol_merge_ready');
  assert.equal(ready.pm, 'luna-max');
  assert.equal(ready.sol, 'sol-high');
  assert.equal(ready.wake_luna, false);
  assert.equal(ready.wake_sol, true);
  assert.equal(ready.host_calls[0].tool, 'create_thread');
  assert.equal(ready.host_calls[0].model, 'sol-high');
  assert.equal(ready.host_calls[1].tool, 'send_message_to_thread');
  assert.equal(typeof ready.host_calls[1].prompt, 'string');
  assert.equal(ready.host_calls[1].bind_created_thread, true);
  assert.equal(ready.host_calls[2].tool, 'wait_threads');
  assert.equal(mergeReadyFactsPass(mergeReadySummary({ ci_current: false })), false);
  const again = relayEvent(ready.session, envelope({
    message_id: 'msg-merge-2',
    kind: 'merge_ready',
    event_cursor: '2',
    event_summary: mergeReadySummary(),
  }));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'duplicate_event');
  assert.equal(again.wake_sol, false);
});

test('explicit Sol High adjudication stays an exception on Luna Max PM', () => {
  const session = pinnedSession();
  const escalated = relayEvent(session, envelope({
    message_id: 'msg-risk',
    kind: 'question',
    sol_criterion: 'security_or_protected_ref_risk',
    sol_authorized: true,
    sol_model: 'sol-high',
    event_summary: questionSummary({
      question_id: 'q-risk', question_ids: ['q-risk'], correlation_id: 'msg-risk',
    }),
  }));
  assert.equal(escalated.ok, true);
  assert.equal(escalated.action, 'sol_adjudicate');
  assert.equal(escalated.pm, 'luna-max');
  assert.equal(escalated.sol, 'sol-high');
  assert.equal(escalated.wake_sol, true);
});

test('Luna native subagents stay local analysis beside Co-Engineer writers', () => {
  const planned = planLunaNativeSubagents(
    [{ id: 'read-diff', role: 'local_analysis', access: 'read_only', scope: 'docs/' }],
    [['src/auth.ts']],
    { parent_depth: 1, external_lane_count: 1 },
  );
  assert.equal(planned.ok, true);
  assert.equal(planned.subagents[0].role, LUNA_NATIVE_SUBAGENT_ROLE);
  assert.equal(planned.subagents[0].depth, 2);
  const created = createLunaPmSession(baseInput({
    native_subagents: [{ id: 'read-diff', scope: 'docs/' }],
  }));
  assert.equal(created.ok, true);
  assert.equal(created.native_subagents.length, 1);
});

test('publisher may non-force push the task-owned unprotected Codex branch and open a draft PR', () => {
  const laneRef = expectedLaneRefV1({
    run_id: AUTH_RUN, assignment_id: ASSIGNMENT_ID, manifest_digest_hex: MANIFEST_DIGEST_HEX,
  });
  const push = classifyTaskPortGitOperation({
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: 'publisher',
    operation: 'push',
    identity: validIdentity({ head_sha: BASE_SHA }),
    manifest_digest_hex: MANIFEST_DIGEST_HEX,
    ref: laneRef,
    publication: { user_authorized_publication: true, draft: true, force: false },
  });
  assert.equal(push.verdict, 'allowed');
  const draft = classifyTaskPortGitOperation({
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: 'publisher',
    operation: 'create_pr',
    identity: validIdentity(),
    manifest_digest_hex: MANIFEST_DIGEST_HEX,
    ref: laneRef,
    publication: { user_authorized_publication: true, draft: true, force: false },
  });
  assert.equal(draft.verdict, 'allowed');
});

test('JS adapter is a request/validation layer; Codex skill is the host executor', async () => {
  const files = [
    'mcp/v3/server.mjs',
    'mcp/v3/supervisor.mjs',
    'mcp/v3/task-store.mjs',
    'mcp/v3/run-runtime.mjs',
    'mcp/v3/attention-batch.mjs',
    'mcp/v3/grok-acp-driver.mjs',
    'mcp/v3/cursor-local-driver.mjs',
    'mcp/v3/cursor-cloud-driver.mjs',
    'mcp/v3/dsh-acpx-driver.mjs',
    'mcp/v3/git-authority.mjs',
    'mcp/v3/luna-pm-host-adapter.mjs',
  ];
  for (const relative of files) {
    const source = await readFile(path.join(PLUGIN, relative), 'utf8');
    assert.equal(source.includes('luna-pm-relay'), false, relative);
  }
  const adapter = await readFile(path.join(PLUGIN, 'mcp/v3/luna-pm-host-adapter.mjs'), 'utf8');
  assert.equal(adapter.includes('executeHostCall'), false);
  assert.equal(adapter.includes('hostClient['), false);
  assert.match(adapter, /does not invoke/u);
  const skill = await readFile(
    path.join(PLUGIN, 'skills/delegate-to-co-engineer/references/luna-pm-relay.mjs'),
    'utf8',
  );
  assert.equal(skill.includes('luna-pm-host-adapter.mjs'), true);
  const lunaPm = await readFile(
    path.join(PLUGIN, 'skills/delegate-to-co-engineer/references/luna-pm.md'),
    'utf8',
  );
  assert.match(lunaPm, /Exact Codex Desktop host-tool sequence/u);
  assert.match(lunaPm, /create_thread/u);
  assert.match(lunaPm, /send_message_to_thread/u);
  assert.match(lunaPm, /wait_threads/u);
  assert.match(lunaPm, /set_thread_archived/u);
  assert.match(lunaPm, /set_thread_pinned/u);
  const config = await readFile(path.join(REPO, 'docs', 'configuration.md'), 'utf8');
  assert.match(config, /host-dependent Codex Desktop task-management/u);
  assert.match(config, /never silently\s+substitutes Sol/u);
  assert.match(config, /create_thread/u);
  assert.match(config, /set_thread_pinned/u);
  assert.match(config, /Do not invent `cancel_thread`/u);
  assert.match(config, /must not add a sixth tool/u);
});

test('grouped attention retains identity and routes one structured response', () => {
  const packed = buildEnvelope(envelope({
    kind: 'question',
    event_summary: questionSummary(),
  }));
  assert.equal(packed.ok, true, packed.code);
  assert.equal(packed.envelope.event_summary.question_identity.task_id, THREAD);
  assert.equal(packed.envelope.event_summary.question_identity.assignment_id, 'lane-alpha');
  assert.equal(packed.envelope.event_summary.question_identity.attempt, '1');
  assert.equal(packed.envelope.event_summary.question_identity.generation, '1');
  assert.equal(packed.envelope.event_summary.question_identity.session_id, 'sess-grok-1');
  assert.equal(packed.envelope.event_summary.question_identities.length, 1);
  const routed = routeStructuredAttentionResponse(packed.envelope, {
    assignment_id: 'lane-alpha',
    question_id: 'q-1',
    session_id: 'sess-grok-1',
    task_id: THREAD,
    response: 'use the stricter validator',
  });
  assert.equal(routed.ok, true, routed.code);
  assert.equal(routed.response.answers.length, 1);
  const mismatched = routeStructuredAttentionResponse(packed.envelope, {
    assignment_id: 'lane-beta',
    question_id: 'q-1',
    session_id: 'sess-grok-1',
    task_id: THREAD,
    response: 'no',
  });
  assert.equal(mismatched.code, 'grouped_attention_identity_mismatch');

  const grouped = buildEnvelope(envelope({
    kind: 'question',
    event_summary: questionSummary({ question_ids: ['q-1', 'q-2'] }),
  }));
  assert.equal(grouped.ok, true, grouped.code);
  assert.deepEqual(grouped.envelope.event_summary.question_ids, ['q-1', 'q-2']);
  assert.equal(grouped.envelope.event_summary.question_identity, null);
  assert.equal(grouped.envelope.event_summary.question_identities.length, 2);
  assert.equal(grouped.envelope.event_summary.question_identities[0].question_id, 'q-1');
  assert.equal(grouped.envelope.event_summary.question_identities[1].question_id, 'q-2');
  const singular = routeStructuredAttentionResponse(grouped.envelope, {
    assignment_id: 'lane-alpha',
    question_id: 'q-1',
    session_id: 'sess-grok-1',
    task_id: THREAD,
    response: 'only one',
  });
  assert.equal(singular.ok, false);
  assert.equal(singular.code, 'invalid_structured_response');
  const covering = routeStructuredAttentionResponse(grouped.envelope, {
    answers: [
      {
        assignment_id: 'lane-alpha', question_id: 'q-1', session_id: 'sess-grok-1',
        task_id: THREAD, response: 'use the stricter validator',
      },
      {
        assignment_id: 'lane-alpha', question_id: 'q-2', session_id: 'sess-grok-1',
        task_id: THREAD, response: 'keep the docs change',
      },
    ],
  });
  assert.equal(covering.ok, true, covering.code);
  assert.deepEqual(covering.response.answers.map((row) => row.question_id), ['q-1', 'q-2']);
});
