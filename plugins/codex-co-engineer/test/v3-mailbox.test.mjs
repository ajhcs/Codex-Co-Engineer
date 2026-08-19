import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  consumeReply,
  recordNeedsAttention,
  replyDecision,
  submitReply,
  waitForReply,
} from '../mcp/v3/mailbox.mjs';

function createMockWatch() {
  const state = { opened: 0, closed: 0, errorHandler: null };
  const watch = (_directory, _options, listener) => {
    state.opened += 1;
    const watcher = {
      close() { state.closed += 1; },
      on(event, handler) {
        if (event === 'error') state.errorHandler = handler;
        return this;
      },
    };
    watcher.listener = listener;
    return watcher;
  };
  return { watch, state };
}
import { createTask, readTask } from '../mcp/v3/task-store.mjs';

async function attentionTask(root, extra = {}) {
  await createTask({
    root,
    prompt: 'ask a question',
    record: {
      id: extra.id ?? 'mail-one',
      status: extra.status ?? 'running',
      provider: extra.provider ?? 'grok',
      transport: extra.transport ?? 'acp',
      acp_session_id: extra.session_id ?? 'fake-session-1',
    },
  });
}

test('same-session reply is recorded exactly once and resumes running when consumed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-mailbox-'));
  try {
    await attentionTask(root);
    const pending = waitForReply(root, 'mail-one', 'q-1', { wait_ms: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordNeedsAttention(root, 'mail-one', {
      session_id: 'fake-session-1',
      question_id: 'q-1',
      prompt: 'Allow the edit?',
      options: [{ optionId: 'allow', kind: 'allow_once' }],
    });
    assert.equal((await readTask(root, 'mail-one')).task.status, 'needs_attention');
    const recorded = await submitReply(root, 'mail-one', {
      session_id: 'fake-session-1',
      question_id: 'q-1',
      response: 'allow_once',
    });
    assert.equal(recorded.reply.question_id, 'q-1');
    await assert.rejects(
      submitReply(root, 'mail-one', {
        session_id: 'fake-session-1',
        question_id: 'q-1',
        response: 'allow_once',
      }),
      (error) => error.code === 'reply_already_recorded',
    );
    const consumed = await pending;
    assert.equal(consumed.response, 'allow_once');
    assert.equal((await readTask(root, 'mail-one')).task.status, 'running');
    assert.equal(await consumeReply(root, 'mail-one', 'q-1'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsupported providers report the limitation instead of pretending a new prompt is a continuation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-mailbox-cap-'));
  try {
    await attentionTask(root, { id: 'dsh-one', provider: 'dsh' });
    await recordNeedsAttention(root, 'dsh-one', {
      session_id: 'dsh-session-1',
      question_id: 'q-dsh',
    });
    await assert.rejects(
      submitReply(root, 'dsh-one', {
        session_id: 'dsh-session-1',
        question_id: 'q-dsh',
        response: 'allow_once',
      }),
      (error) => error.code === 'same_session_reply_unsupported',
    );

    await attentionTask(root, { id: 'cloud-one', provider: 'cursor-cloud' });
    await recordNeedsAttention(root, 'cloud-one', {
      session_id: 'cloud-session-1',
      question_id: 'q-cloud',
    });
    await assert.rejects(
      submitReply(root, 'cloud-one', {
        session_id: 'cloud-session-1',
        question_id: 'q-cloud',
        response: 'allow_once',
      }),
      (error) => error.code === 'same_session_reply_unsupported',
    );

    await attentionTask(root, { id: 'cli-one', provider: 'grok', transport: 'cli' });
    await recordNeedsAttention(root, 'cli-one', {
      session_id: 'cli-session-1',
      question_id: 'q-cli',
    });
    await assert.rejects(
      submitReply(root, 'cli-one', {
        session_id: 'cli-session-1',
        question_id: 'q-cli',
        response: 'allow_once',
      }),
      (error) => error.code === 'same_session_reply_unsupported',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replyDecision fails closed on unmatched free text', () => {
  assert.equal(replyDecision({ response: 'sure, go ahead' }).outcome, 'cancel');
  assert.equal(replyDecision({ response: 'please allow this once' }).outcome, 'cancel');
  assert.equal(replyDecision({ response: { optionId: 'not-offered' } }).outcome, 'cancel');
  assert.equal(replyDecision({ response: 'allow_once' }).outcome, 'allow_once');
  assert.equal(replyDecision({ response: 'reject_always' }).outcome, 'reject_always');
  assert.deepEqual(
    replyDecision({ response: 'pick-me' }, [{ optionId: 'pick-me', kind: 'allow_once' }]),
    { outcome: 'allow_once', optionId: 'pick-me' },
  );
});

test('reply watcher errors re-arm once then fall back without crashing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-mailbox-watch-'));
  try {
    await attentionTask(root, { id: 'mail-watch' });
    const { watch, state } = createMockWatch();
    const pending = waitForReply(root, 'mail-watch', 'q-watch', {
      wait_ms: 1_000,
      watch,
      fallback_ms: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    state.errorHandler(new Error('watch failed'));
    await new Promise((resolve) => setTimeout(resolve, 15));
    state.errorHandler(new Error('watch failed again'));
    state.errorHandler(new Error('later watcher error must not crash'));
    await recordNeedsAttention(root, 'mail-watch', {
      session_id: 'fake-session-1',
      question_id: 'q-watch',
      prompt: 'Allow the edit?',
    });
    await submitReply(root, 'mail-watch', {
      session_id: 'fake-session-1',
      question_id: 'q-watch',
      response: 'allow_once',
    });
    const consumed = await pending;
    assert.equal(consumed.response, 'allow_once');
    assert.ok(state.opened >= 2);
    assert.equal(state.closed, state.opened);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
