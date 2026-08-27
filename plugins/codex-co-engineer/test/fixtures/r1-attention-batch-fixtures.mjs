// Neutral builders for AttentionBatchV1 tests. Tests own the assertions.

import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ATTENTION_BATCH_SCHEMA_ID,
  attentionQuestionDigestV1,
  deriveAttentionBatchIdV1,
  openAttentionRoot,
} from '../../mcp/v3/attention-batch.mjs';
import { RUN_JOURNAL_GENESIS_PREV } from '../../mcp/v3/run-reducer.mjs';

export const RUN_ID = 'run-attention-main';
export const ASSIGNMENT_A = 'assign-a';
export const ASSIGNMENT_B = 'assign-b';
export const ASSIGNMENT_C = 'assign-c';
export const TASK_A = 'task-a0';
export const TASK_B = 'task-b0';
export const TASK_C = 'task-c0';
export const SESSION_A = 'sess-a0';
export const SESSION_B = 'sess-b0';
export const SESSION_C = 'sess-c0';
export const QUESTION_A = 'q-a0';
export const QUESTION_B = 'q-b0';
export const QUESTION_C = 'q-c0';
export const CURSOR_A = '0';
export const CURSOR_B = '24';
export const CURSOR_C = '48';
export const HOSTILE_SECRET = 'sk-live-ATTACKER-SECRET';
export const HOSTILE_PATH = '/tmp/hostile-repo';
export const HOSTILE_TOKEN = 'github_pat_hostile';

export { ATTENTION_BATCH_SCHEMA_ID, RUN_JOURNAL_GENESIS_PREV };

export async function makePrivateRoot(prefix = 'r1-p34-attention-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

export async function openRoot(prefix) {
  const root = await makePrivateRoot(prefix);
  const handle = await openAttentionRoot(root);
  return { root, handle };
}

export function makeCursor({
  assignmentId = ASSIGNMENT_A,
  taskId = TASK_A,
  eventCursor = CURSOR_A,
} = {}) {
  return {
    assignment_id: assignmentId,
    task_id: taskId,
    event_cursor: eventCursor,
  };
}

export function makeSource({
  journalRevision = 2,
  journalHeadHash = `sha256:${'ab'.repeat(32)}`,
  cursors = [makeCursor()],
} = {}) {
  return {
    journal_revision: journalRevision,
    journal_head_hash: journalHeadHash,
    task_cursors: cursors,
  };
}

export function makeItem({
  assignmentId = ASSIGNMENT_A,
  taskId = TASK_A,
  provider = 'grok',
  required = true,
  sessionId = SESSION_A,
  questionId = QUESTION_A,
  eventCursor = CURSOR_A,
  prompt = 'Choose the next writer step',
  options = ['continue', 'stop'],
  disposition = 'pending',
  deadlineAt = null,
} = {}) {
  const replyCapability = provider === 'dsh' || provider === 'cursor-cloud'
    ? 'unsupported'
    : 'same_session';
  const item = {
    assignment_id: assignmentId,
    task_id: taskId,
    provider,
    required,
    session_id: sessionId,
    question_id: questionId,
    event_cursor: eventCursor,
    question_digest: 'sha256:' + '00'.repeat(32),
    prompt,
    options,
    reply_capability: replyCapability,
    disposition,
    deadline_at: deadlineAt,
  };
  item.question_digest = attentionQuestionDigestV1(item);
  return item;
}

export function grokItem(overrides = {}) {
  return makeItem({ provider: 'grok', ...overrides });
}

export function cursorLocalItem(overrides = {}) {
  return makeItem({
    assignmentId: ASSIGNMENT_B,
    taskId: TASK_B,
    provider: 'cursor-local',
    sessionId: SESSION_B,
    questionId: QUESTION_B,
    eventCursor: CURSOR_B,
    ...overrides,
  });
}

export function dshItem(overrides = {}) {
  return makeItem({
    assignmentId: ASSIGNMENT_B,
    taskId: TASK_B,
    provider: 'dsh',
    sessionId: SESSION_B,
    questionId: QUESTION_B,
    eventCursor: CURSOR_B,
    prompt: 'DSH cannot host a same-session reply',
    options: null,
    ...overrides,
  });
}

export function cloudItem(overrides = {}) {
  return makeItem({
    assignmentId: ASSIGNMENT_C,
    taskId: TASK_C,
    provider: 'cursor-cloud',
    sessionId: SESSION_C,
    questionId: QUESTION_C,
    eventCursor: CURSOR_C,
    prompt: 'Cloud cannot host a same-session reply',
    options: null,
    required: true,
    ...overrides,
  });
}

export function itemsAndSource(items) {
  const sorted = [...items].sort((left, right) => {
    if (left.assignment_id < right.assignment_id) return -1;
    if (left.assignment_id > right.assignment_id) return 1;
    return 0;
  });
  return {
    items: sorted,
    source: makeSource({
      cursors: sorted.map((item) => makeCursor({
        assignmentId: item.assignment_id,
        taskId: item.task_id,
        eventCursor: item.event_cursor,
      })),
    }),
  };
}

export function batchIdFor(runId, source, items) {
  return deriveAttentionBatchIdV1(runId, source, items);
}

export function makeAnswer(item, response = 'continue') {
  return {
    assignment_id: item.assignment_id,
    task_id: item.task_id,
    session_id: item.session_id,
    question_id: item.question_id,
    response,
  };
}

export function makeReply(batchId, items, response = 'continue') {
  return {
    batch_id: batchId,
    round: 1,
    answers: items.map((item) => makeAnswer(item, response)),
  };
}

export function trackingCancel(outcome = 'confirmed') {
  const calls = [];
  const cancel = async (identity) => {
    calls.push(identity);
    return { outcome, ...identity };
  };
  return { cancel, calls };
}

export function trackingDeliver(outcome = 'delivered') {
  const calls = [];
  const deliver = async (identity) => {
    calls.push(identity);
    return { outcome, ...identity };
  };
  return { deliver, calls };
}

export function failingDeliver() {
  const calls = [];
  const deliver = async (identity) => {
    calls.push(identity);
    throw new Error(HOSTILE_SECRET);
  };
  return { deliver, calls };
}
