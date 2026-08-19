import { watch as watchDirectory } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { providerCapabilities } from './contract.mjs';
import { appendTaskEvent, readTask, taskPaths, updateTask, waitDelay } from './task-store.mjs';

const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESPONSE_MAX_BYTES = 16 * 1024;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function requireQuestionId(value) {
  if (typeof value !== 'string' || !QUESTION_ID.test(value)) {
    fail('invalid_question_id', 'question_id must be 1-80 safe characters.');
  }
  return value;
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    fail('invalid_session_id', 'session_id must be a stable live-session identifier.');
  }
  return value;
}

function replyPaths(root, taskId, questionId) {
  const paths = taskPaths(root, taskId);
  const directory = path.join(paths.directory, 'replies');
  return {
    directory,
    pending: path.join(directory, `${questionId}.json`),
    accepted: path.join(directory, `${questionId}.accepted.json`),
    attention: path.join(paths.directory, 'attention.json'),
  };
}

async function writeExclusiveJson(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

export async function readAttention(root, taskId) {
  const file = path.join(taskPaths(root, taskId).directory, 'attention.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function recordNeedsAttention(root, taskId, attention) {
  const sessionId = requireSessionId(attention?.session_id);
  const questionId = requireQuestionId(attention?.question_id);
  const paths = replyPaths(root, taskId, questionId);
  const record = {
    session_id: sessionId,
    question_id: questionId,
    prompt: typeof attention.prompt === 'string' ? attention.prompt.slice(0, 4_096) : null,
    options: Array.isArray(attention.options) ? attention.options.slice(0, 8) : null,
    stage: typeof attention.stage === 'string' ? attention.stage : 'provider_feedback',
    at: new Date().toISOString(),
  };
  const current = await readAttention(root, taskId);
  if (current && current.question_id !== questionId && current.consumed !== true) {
    fail('attention_pending', 'A different unanswered question is already pending.');
  }
  await writeAtomicJson(paths.attention, record);
  const task = await updateTask(root, taskId, {
    status: 'needs_attention',
    attention: {
      session_id: sessionId,
      question_id: questionId,
      stage: record.stage,
    },
  });
  await appendTaskEvent(root, taskId, {
    type: 'needs_attention',
    session_id: sessionId,
    question_id: questionId,
    stage: record.stage,
  });
  return { task, attention: record };
}

function boundedResponse(value) {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value);
    if (bytes > RESPONSE_MAX_BYTES) fail('invalid_reply', 'reply.response exceeds its byte limit.');
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > RESPONSE_MAX_BYTES) fail('invalid_reply', 'reply.response exceeds its byte limit.');
    return value;
  }
  fail('invalid_reply', 'reply.response must be a string or object.');
}

export function assertSameSessionReplySupported(task) {
  const capabilities = providerCapabilities(task?.provider);
  if (task?.transport === 'cli' || capabilities.same_session_reply !== true) {
    fail(
      'same_session_reply_unsupported',
      capabilities.notes
        ?? 'This provider transport cannot resume the same live session; a new prompt is not a continuation.',
    );
  }
  return capabilities;
}

export async function submitReply(root, taskId, { session_id, question_id, response } = {}) {
  const sessionId = requireSessionId(session_id);
  const questionId = requireQuestionId(question_id);
  const { task } = await readTask(root, taskId);
  assertSameSessionReplySupported(task);
  if (task.status !== 'needs_attention') {
    fail('reply_not_expected', 'No outstanding needs_attention question exists for this task.');
  }
  const attention = await readAttention(root, taskId);
  if (!attention || attention.question_id !== questionId || attention.session_id !== sessionId) {
    fail('reply_identity_mismatch', 'session_id and question_id must match the live attention request.');
  }
  const paths = replyPaths(root, taskId, questionId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700).catch(() => {});
  const payload = {
    session_id: sessionId,
    question_id: questionId,
    response: boundedResponse(response),
    at: new Date().toISOString(),
  };
  try {
    await writeExclusiveJson(paths.pending, payload);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('reply_already_recorded', 'This question was already answered exactly once.');
    }
    throw error;
  }
  await appendTaskEvent(root, taskId, {
    type: 'reply_recorded',
    session_id: sessionId,
    question_id: questionId,
  });
  return { task: (await readTask(root, taskId)).task, reply: payload };
}

export async function consumeReply(root, taskId, questionId) {
  const id = requireQuestionId(questionId);
  const paths = replyPaths(root, taskId, id);
  try {
    await readFile(paths.accepted, 'utf8');
    return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let payload;
  try {
    payload = JSON.parse(await readFile(paths.pending, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    await writeExclusiveJson(paths.accepted, { ...payload, consumed_at: new Date().toISOString() });
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  await updateTask(root, taskId, {
    status: 'running',
    attention: null,
    last_reply: {
      session_id: payload.session_id,
      question_id: payload.question_id,
      at: payload.at,
    },
  });
  await appendTaskEvent(root, taskId, {
    type: 'reply_delivered',
    session_id: payload.session_id,
    question_id: payload.question_id,
  });
  await unlink(paths.attention).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return payload;
}

export async function waitForReply(root, taskId, questionId, {
  signal,
  now = Date.now,
  watch = watchDirectory,
  delay = waitDelay,
  fallback_ms = 1_000,
  wait_ms = 3_600_000,
} = {}) {
  const id = requireQuestionId(questionId);
  const paths = replyPaths(root, taskId, id);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700).catch(() => {});
  const deadline = now() + wait_ms;
  const consume = () => consumeReply(root, taskId, id);

  const existing = await consume();
  if (existing) return existing;
  if (signal?.aborted) fail('cancelled', 'Reply wait was cancelled.');

  let watcher = null;
  let watchFailed = false;
  let rearmAttempted = false;
  let notify = null;

  const closeWatcher = () => {
    try { watcher?.close?.(); } catch { /* already closed */ }
    watcher = null;
  };

  const onWatchError = () => {
    if (!rearmAttempted) {
      rearmAttempted = true;
      arm();
      notify?.();
      return;
    }
    watchFailed = true;
    closeWatcher();
    notify?.();
  };

  const arm = () => {
    closeWatcher();
    try {
      watcher = watch(paths.directory, { persistent: true }, () => notify?.());
      if (!watcher || typeof watcher.close !== 'function') {
        watchFailed = true;
        watcher = null;
        return;
      }
      if (typeof watcher.on === 'function') {
        watcher.on('error', onWatchError);
      }
    } catch {
      watchFailed = true;
      watcher = null;
    }
  };

  try {
    arm();
    const raced = await consume();
    if (raced) return raced;
    while (now() < deadline) {
      if (signal?.aborted) fail('cancelled', 'Reply wait was cancelled.');
      const remaining = deadline - now();
      const waitForNotify = new Promise((resolve) => {
        notify = () => resolve('watch');
      });
      const reason = await Promise.race([
        waitForNotify,
        delay(watchFailed ? Math.min(fallback_ms, remaining) : remaining, signal).then((value) => (value === 'abort' ? 'abort' : 'timeout')),
      ]);
      notify = null;
      const payload = await consume();
      if (payload) return payload;
      if (reason === 'abort') fail('cancelled', 'Reply wait was cancelled.');
      if (reason === 'timeout' && !watchFailed) break;
    }
    fail('reply_timeout', 'Timed out waiting for a same-session reply.');
  } finally {
    closeWatcher();
  }
}

const RECOGNIZED_REPLY_OUTCOMES = Object.freeze([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
  'cancel',
]);

export function replyDecision(payload, options = []) {
  const value = typeof payload?.response === 'string'
    ? payload.response
    : payload?.response?.outcome ?? payload?.response?.optionId ?? payload?.response?.option_id;
  if (RECOGNIZED_REPLY_OUTCOMES.includes(value)) {
    return { outcome: value };
  }
  const matched = Array.isArray(options)
    ? options.find((option) => option?.optionId === value || option?.kind === value)
    : null;
  if (typeof matched?.kind === 'string' && matched.kind.length > 0) {
    return { outcome: matched.kind, ...(matched.optionId ? { optionId: matched.optionId } : {}) };
  }
  return { outcome: 'cancel' };
}
