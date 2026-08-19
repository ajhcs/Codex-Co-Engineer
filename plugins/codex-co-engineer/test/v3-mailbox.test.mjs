import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  consumeReply,
  recordNeedsAttention,
  submitReply,
  waitForReply,
} from '../mcp/v3/mailbox.mjs';
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
