// Hostile coverage of the live Co-Engineer 3.4.0 Grok ACP grouped-attention
// false-success: ask_user_question unsupported, unanswered question dumped as
// result text, completed/succeeded with question_id null. Also covers the
// structured question bridge, duplicate reply, missing identity, unconfirmed
// delivery, restart reattach, and normal completion.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runAcpTask } from '../mcp/v3/acp-worker.mjs';
import {
  GROK_ACP_REPLY_REQUEST_SCHEMA_ID,
  bindGrokAcpDriverV1,
  grokAcpDriverDeclarationV1,
  inspectGrokAcpLaneEvidenceV1,
  submitGrokAcpAttentionReplyV1,
} from '../mcp/v3/grok-acp-driver.mjs';
import {
  OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT,
  QUESTION_BRIDGE_UNAVAILABLE_CODE,
  completedWithoutLiveQuestionIdentity,
  liveQuestionId,
} from '../mcp/v3/grok-question-bridge.mjs';
import { submitReply } from '../mcp/v3/mailbox.mjs';
import { buildDriverOperationRequestV1 } from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  SUPERVISOR_UNANSWERABLE_ATTENTION_REASON,
  classifySupervisorTerminalReceipt,
  projectSupervisorTerminalReceipt,
} from '../mcp/v3/supervisor.mjs';
import { createTask, readTask } from '../mcp/v3/task-store.mjs';
import {
  GROK_FIXTURE_MODEL,
  GROK_FIXTURE_SESSION_ID,
  buildGrokDriverFixtureV1,
  createScriptedGrokAcpTransportV1,
  grokAcpCallsOf,
} from './fixtures/r1-grok-acp-transport.mjs';
import {
  OBSERVED_UNSUPPORTED_QUESTION_EVENT,
  observedUnsupportedQuestionReceipt,
  quotedUnsupportedQuestionInSuccessfulResultReceipt,
} from './fixtures/r1-grok-attention-bridge-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'acpx-fake-agent.mjs');
const fixture = buildGrokDriverFixtureV1();

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code);
}

function requestFor(operation, extras = {}) {
  return buildDriverOperationRequestV1(operation, fixture.envelope, extras);
}

function identityFields() {
  return {
    provider: 'grok',
    model: GROK_FIXTURE_MODEL,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    lane_index: fixture.lane_index,
    base_sha: fixture.base_sha,
    child_envelope_digest: fixture.child_envelope_digest,
  };
}

function launchReady(transport = createScriptedGrokAcpTransportV1()) {
  const driver = bindGrokAcpDriverV1(transport);
  assert.equal(driver.preflight(requestFor('preflight')).disposition, 'ready');
  return { driver, transport };
}

async function workerFixture(mode, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-grok-bridge-'));
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  const taskId = extra.id ?? `grok-${mode}`;
  await createTask({
    root,
    prompt: extra.prompt ?? mode,
    record: {
      id: taskId,
      status: 'accepted',
      provider: 'grok',
      cwd,
      agent_argv: [process.execPath, FAKE_AGENT, '--mode', mode],
      timeout_ms: extra.timeoutMs ?? 8_000,
    },
  });
  return { root, cwd, taskId };
}

test('capability advertising remains live_session_reply only with a reply transport', () => {
  const declaration = grokAcpDriverDeclarationV1();
  assert.equal(declaration.capability.same_session_reply, 'live_session_reply');
  const transport = createScriptedGrokAcpTransportV1();
  assert.equal(typeof transport.reply, 'function');
});

test('observed unsupported-question transcript is preserved and never guessed from prose', () => {
  assert.match(OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT, /ask_user_question/u);
  assert.match(OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT, /I will not continue until answered/u);
  assert.equal(completedWithoutLiveQuestionIdentity({
    status: 'completed',
    result: OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT,
    attention: { question_id: null },
  }), false);
  assert.equal(completedWithoutLiveQuestionIdentity({
    status: 'completed',
    result: OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT,
    attention: { question_id: null },
    last_event: OBSERVED_UNSUPPORTED_QUESTION_EVENT,
  }), true);
});

test('exact observed unsupported-question transcript does not project succeeded', () => {
  const receipt = observedUnsupportedQuestionReceipt();
  assert.equal(receipt.status, 'completed');
  assert.equal(liveQuestionId(receipt.attention), null);
  assert.equal(receipt.result, OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT);
  const classified = classifySupervisorTerminalReceipt(receipt);
  assert.equal(classified.corrected, true);
  assert.equal(classified.projected_status, 'failed');
  assert.equal(classified.public_state, 'failed');
  assert.equal(classified.reason, SUPERVISOR_UNANSWERABLE_ATTENTION_REASON.code);
  assert.notEqual(classified.public_state, 'succeeded');
  const projected = projectSupervisorTerminalReceipt(receipt);
  assert.equal(projected.status, 'failed');
  assert.equal(projected.error.code, SUPERVISOR_UNANSWERABLE_ATTENTION_REASON.code);
  assert.doesNotMatch(JSON.stringify(projected.error), /option A or option B/u);
});

test('quoting the unanswered-question transcript in a normal completion stays succeeded', () => {
  const receipt = quotedUnsupportedQuestionInSuccessfulResultReceipt();
  const classified = classifySupervisorTerminalReceipt(receipt);
  assert.equal(classified.corrected, false);
  assert.equal(classified.public_state, 'succeeded');
  assert.equal(projectSupervisorTerminalReceipt(receipt), receipt);
});

test('Grok driver fails closed on the unsupported-question completion without identity', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'completed',
      session_id: GROK_FIXTURE_SESSION_ID,
      ...identityFields(),
      events: [OBSERVED_UNSUPPORTED_QUESTION_EVENT],
    },
  });
  const { driver } = launchReady(transport);
  driver.launch(requestFor('launch'));
  expectCode(() => driver.reconcile(requestFor('reconcile')), QUESTION_BRIDGE_UNAVAILABLE_CODE);
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
});

test('missing question identity on needs_attention fails closed', () => {
  const { driver } = launchReady(createScriptedGrokAcpTransportV1({
    observe: {
      status: 'needs_attention',
      session_id: GROK_FIXTURE_SESSION_ID,
      ...identityFields(),
    },
  }));
  driver.launch(requestFor('launch'));
  expectCode(() => driver.reconcile(requestFor('reconcile')), 'capability_reply_mismatch');
});

test('one structured reply resumes the exact Grok session once', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'needs_attention',
      session_id: GROK_FIXTURE_SESSION_ID,
      ...identityFields(),
      attention: { session_id: GROK_FIXTURE_SESSION_ID, question_id: 'q-ab-1' },
    },
  });
  const { driver } = launchReady(transport);
  driver.launch(requestFor('launch'));
  assert.equal(driver.reconcile(requestFor('reconcile')).disposition, 'unresolved_attention');
  const first = submitGrokAcpAttentionReplyV1(driver, {
    schema: GROK_ACP_REPLY_REQUEST_SCHEMA_ID,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: GROK_FIXTURE_SESSION_ID,
    question_id: 'q-ab-1',
    response: 'A',
  });
  assert.equal(first.answered, true);
  assert.equal(first.session_id, GROK_FIXTURE_SESSION_ID);
  assert.equal(first.question_id, 'q-ab-1');
  assert.equal(grokAcpCallsOf(transport, 'reply').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
  expectCode(() => submitGrokAcpAttentionReplyV1(driver, {
    schema: GROK_ACP_REPLY_REQUEST_SCHEMA_ID,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: GROK_FIXTURE_SESSION_ID,
    question_id: 'q-ab-1',
    response: 'B',
  }), 'reply_already_attempted');
  assert.equal(grokAcpCallsOf(transport, 'reply').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
});

test('unconfirmed reply delivery fails closed and is never retried', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'needs_attention',
      session_id: GROK_FIXTURE_SESSION_ID,
      ...identityFields(),
      attention: { session_id: GROK_FIXTURE_SESSION_ID, question_id: 'q-ab-1' },
    },
    reply: { answered: false, session_id: GROK_FIXTURE_SESSION_ID, question_id: 'q-ab-1', ...identityFields() },
  });
  const { driver } = launchReady(transport);
  driver.launch(requestFor('launch'));
  driver.reconcile(requestFor('reconcile'));
  expectCode(() => submitGrokAcpAttentionReplyV1(driver, {
    schema: GROK_ACP_REPLY_REQUEST_SCHEMA_ID,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: GROK_FIXTURE_SESSION_ID,
    question_id: 'q-ab-1',
    response: 'A',
  }), 'reply_delivery_unconfirmed');
  expectCode(() => submitGrokAcpAttentionReplyV1(driver, {
    schema: GROK_ACP_REPLY_REQUEST_SCHEMA_ID,
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
    session_id: GROK_FIXTURE_SESSION_ID,
    question_id: 'q-ab-1',
    response: 'A',
  }), 'reply_already_attempted');
  assert.equal(grokAcpCallsOf(transport, 'reply').length, 1);
});

test('restart reattach resumes the exact session and never relaunches', () => {
  const transport = createScriptedGrokAcpTransportV1({
    observe: {
      status: 'needs_attention',
      session_id: GROK_FIXTURE_SESSION_ID,
      ...identityFields(),
      attention: { session_id: GROK_FIXTURE_SESSION_ID, question_id: 'q-ab-1' },
    },
  });
  const { driver } = launchReady(transport);
  driver.launch(requestFor('launch'));
  const receipt = driver.reconcile(requestFor('reconcile', { intent: 'restart_reattach' }));
  assert.equal(receipt.disposition, 'unresolved_attention');
  assert.equal(grokAcpCallsOf(transport, 'reattach').length, 1);
  assert.equal(grokAcpCallsOf(transport, 'dispatch').length, 1);
  const evidence = inspectGrokAcpLaneEvidenceV1(driver, {
    run_id: fixture.run_id,
    assignment_id: fixture.assignment_id,
    child_envelope_digest: fixture.child_envelope_digest,
  });
  assert.equal(evidence.attention.session_id, GROK_FIXTURE_SESSION_ID);
  assert.equal(evidence.attention.question_id, 'q-ab-1');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
});

test('normal Grok completion stays terminal succeeded without question identity', () => {
  const { driver } = launchReady();
  driver.launch(requestFor('launch'));
  assert.equal(driver.reconcile(requestFor('reconcile')).disposition, 'terminal');
  const classified = classifySupervisorTerminalReceipt({
    status: 'completed',
    result: 'implemented the requested change',
    error: null,
    last_event: { type: 'text_delta', text: 'implemented the requested change' },
  });
  assert.equal(classified.corrected, false);
  assert.equal(classified.public_state, 'succeeded');
});

test('live ACP unsupported ask_user_question transcript fails and keeps question_id null', async () => {
  const value = await workerFixture('ask-user-unsupported', {
    prompt: 'ask one A/B question before any work',
    id: 'grok-unsupported-live',
  });
  let agentPid;
  try {
    const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
    try {
      agentPid = Number(readFileSync(path.join(value.cwd, '.acpx-fake-agent.pid'), 'utf8'));
    } catch {
      agentPid = undefined;
    }
    assert.equal(terminal.status, 'failed');
    assert.notEqual(terminal.status, 'completed');
    assert.equal(liveQuestionId(terminal.attention), null);
    assert.equal(terminal.error.code, QUESTION_BRIDGE_UNAVAILABLE_CODE);
    assert.match(String(terminal.result ?? ''), /I will not continue until answered/u);
    const classified = classifySupervisorTerminalReceipt(terminal);
    assert.notEqual(classified.public_state, 'succeeded');
    if (Number.isInteger(agentPid) && agentPid > 0) {
      const deadline = Date.now() + 2_000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(agentPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          alive = false;
          break;
        }
      }
      assert.equal(alive, false, 'unsupported-question fixture agent must be reaped after runAcpTask');
    }
  } finally {
    if (Number.isInteger(agentPid) && agentPid > 0) {
      try { process.kill(agentPid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }
});

test('live ACP structured question bridge latches identity and one reply resumes the session', async () => {
  const value = await workerFixture('ask-user-question', {
    prompt: 'ask-user-question before work',
    id: 'grok-elicit-live',
    timeoutMs: 8_000,
  });
  const running = runAcpTask({ root: value.root, taskId: value.taskId });
  const deadline = Date.now() + 5_000;
  let attention;
  while (Date.now() < deadline) {
    const current = (await readTask(value.root, value.taskId)).task;
    if (current.status === 'needs_attention') {
      attention = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(attention?.status, 'needs_attention');
  assert.ok(attention.attention?.session_id);
  assert.ok(attention.attention?.question_id);
  await submitReply(value.root, value.taskId, {
    session_id: attention.attention.session_id,
    question_id: attention.attention.question_id,
    response: 'A',
  });
  const terminal = await running;
  assert.equal(terminal.status, 'completed');
  assert.match(String(terminal.result ?? ''), /question-selected-A/u);
});
