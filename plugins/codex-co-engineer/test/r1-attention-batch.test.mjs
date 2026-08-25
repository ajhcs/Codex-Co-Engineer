// P34 AttentionBatchV1 focused coverage: owner-only latch, one reply round,
// unsupported unresolved + affected-lane cancel, restart of exact identities,
// required-unresolved candidate blocking, and P25 isolation.

import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ATTENTION_BATCH_DISPOSITIONS,
  ATTENTION_BATCH_FILE_NAME,
  ATTENTION_BATCH_ITEM_KEYS,
  ATTENTION_BATCH_PROVIDERS,
  ATTENTION_BATCH_RECORD_KEYS,
  ATTENTION_BATCH_REPLY_CAPABILITIES,
  ATTENTION_BATCH_SCHEMA_ID,
  ATTENTION_BATCH_SOURCE_KEYS,
  ATTENTION_BATCH_STATUSES,
  ATTENTION_BATCH_TASK_CURSOR_KEYS,
  ATTENTION_BATCH_UNRESOLVED_CODES,
  ATTENTION_BATCH_VERSION,
  describeAttentionBatchV1,
  openAttentionRoot,
} from '../mcp/v3/attention-batch.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  RUN_JOURNAL_EVENT_KINDS,
  RUN_JOURNAL_GENESIS_PREV as REDUCER_GENESIS,
} from '../mcp/v3/run-reducer.mjs';
import { createRunJournal } from '../mcp/v3/run-journal.mjs';
import { openRunStore } from '../mcp/v3/run-store.mjs';
import {
  makePrivateRoot as makeStoreRoot,
  makeSubmission,
} from './fixtures/r1-run-store-fixtures.mjs';
import {
  ASSIGNMENT_A,
  ASSIGNMENT_C,
  RUN_ID,
  RUN_JOURNAL_GENESIS_PREV,
  batchIdFor,
  cloudItem,
  cursorLocalItem,
  dshItem,
  grokItem,
  itemsAndSource,
  makePrivateRoot,
  makeReply,
  trackingCancel,
  trackingDeliver,
} from './fixtures/r1-attention-batch-fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../mcp/v3/attention-batch.mjs', import.meta.url));
const REDUCER_PATH = fileURLToPath(new URL('../mcp/v3/run-reducer.mjs', import.meta.url));
const JOURNAL_PATH = fileURLToPath(new URL('../mcp/v3/run-journal.mjs', import.meta.url));

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertFrozenTree(value) {
  assert.ok(value === null || typeof value !== 'object' || Object.isFrozen(value),
    'returned records must be frozen');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

async function withRoot(fn) {
  const root = await makePrivateRoot();
  try {
    const handle = await openAttentionRoot(root);
    return await fn({ root, handle });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('AttentionBatchV1 is the frozen v1 contract with exact record keys', () => {
  assert.equal(ATTENTION_BATCH_SCHEMA_ID, 'codex-co-engineer.attention-batch.v1');
  assert.equal(ATTENTION_BATCH_VERSION, 1);
  assert.deepEqual([...ATTENTION_BATCH_RECORD_KEYS], [
    'schema', 'version', 'run_id', 'batch_id', 'revision', 'status',
    'source', 'items', 'reply', 'unresolved',
  ]);
  assert.deepEqual([...ATTENTION_BATCH_STATUSES], ['open', 'reply_committed', 'resolved']);
  assert.deepEqual([...ATTENTION_BATCH_SOURCE_KEYS], [
    'journal_revision', 'journal_head_hash', 'task_cursors',
  ]);
  assert.deepEqual([...ATTENTION_BATCH_TASK_CURSOR_KEYS], [
    'assignment_id', 'task_id', 'event_cursor',
  ]);
  assert.deepEqual([...ATTENTION_BATCH_ITEM_KEYS], [
    'assignment_id', 'task_id', 'provider', 'required', 'session_id',
    'question_id', 'event_cursor', 'question_digest', 'prompt', 'options',
    'reply_capability', 'disposition', 'deadline_at',
  ]);
  assert.deepEqual([...ATTENTION_BATCH_PROVIDERS], [
    'grok', 'cursor-local', 'cursor-cloud', 'dsh',
  ]);
  assert.deepEqual([...ATTENTION_BATCH_REPLY_CAPABILITIES], ['same_session', 'unsupported']);
  assert.deepEqual([...ATTENTION_BATCH_DISPOSITIONS], ['pending', 'answered', 'unresolved']);
  assert.deepEqual([...ATTENTION_BATCH_UNRESOLVED_CODES], [
    'same_session_reply_unsupported',
    'late_attention_after_latch',
    'reply_delivery_failed',
    'reply_deadline_expired',
    'safe_cancel_unconfirmed',
  ]);
  const inventory = describeAttentionBatchV1();
  assert.equal(inventory.wake, false);
  assert.equal(inventory.remote_mutated, false);
  assert.equal(inventory.bounds.reply_round, 1);
  assert.deepEqual([...inventory.ownership.forbidden], [
    'p25_event_kind_change',
    'question_encoding_in_child_progress_note',
    'foreign_p25_journal_files',
    'scheduler',
    'provider_dispatch',
    'candidate_composition',
    'server_tool_wiring',
    'cleanup_implementation',
    'gate_a',
    'release',
  ]);
  assertFrozenTree(inventory);
});

test('first latch publishes one immutable sorted question set at a P25 boundary', async () => {
  await withRoot(async ({ root, handle }) => {
    const grok = grokItem();
    const local = cursorLocalItem();
    const { items, source } = itemsAndSource([local, grok]);
    const { cancel, calls } = trackingCancel();
    const receipt = await handle.latch({
      run_id: RUN_ID,
      source,
      items,
      expected_revision: 0,
      cancel,
    });
    assert.equal(receipt.created, true);
    assert.equal(receipt.wake, false);
    assert.equal(receipt.remote_mutated, false);
    assert.equal(receipt.complete_candidate_blocked, false);
    assert.equal(receipt.record.schema, ATTENTION_BATCH_SCHEMA_ID);
    assert.equal(receipt.record.version, 1);
    assert.equal(receipt.record.run_id, RUN_ID);
    assert.equal(receipt.record.revision, 1);
    assert.equal(receipt.record.status, 'open');
    assert.equal(receipt.record.reply, null);
    assert.deepEqual(receipt.record.items.map((item) => item.assignment_id), [
      ASSIGNMENT_A, local.assignment_id,
    ]);
    assert.equal(receipt.record.items[0].reply_capability, 'same_session');
    assert.equal(receipt.record.items[1].reply_capability, 'same_session');
    assert.equal(receipt.record.batch_id, batchIdFor(RUN_ID, source, items));
    assert.equal(calls.length, 0);
    assertFrozenTree(receipt);
    const stored = await readFile(
      path.join(root, 'runs', RUN_ID, ATTENTION_BATCH_FILE_NAME),
    );
    assert.match(stored.toString('utf8'), /\n$/u);
    const names = await readdir(path.join(root, 'runs', RUN_ID));
    assert.deepEqual(names, [ATTENTION_BATCH_FILE_NAME]);
  });
});

test('identical latch replay is idempotent and does not grow revision', async () => {
  await withRoot(async ({ handle }) => {
    const { items, source } = itemsAndSource([grokItem()]);
    const first = await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    });
    const second = await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.record.revision, 1);
    assert.equal(
      canonicalJsonStringify(first.record),
      canonicalJsonStringify(second.record),
    );
  });
});

test('unsupported DSH and Cursor Cloud items become unresolved and cancel only those lanes', async () => {
  await withRoot(async ({ handle }) => {
    const grok = grokItem();
    const dsh = dshItem();
    const cloud = cloudItem();
    const { items, source } = itemsAndSource([grok, dsh, cloud]);
    const { cancel, calls } = trackingCancel();
    const receipt = await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0, cancel,
    });
    assert.equal(receipt.record.items[0].disposition, 'pending');
    assert.equal(receipt.record.items[1].disposition, 'unresolved');
    assert.equal(receipt.record.items[2].disposition, 'unresolved');
    assert.equal(receipt.complete_candidate_blocked, true);
    const codes = receipt.record.unresolved.map((entry) => `${entry.assignment_id}:${entry.code}`);
    assert.ok(codes.includes(`${dsh.assignment_id}:same_session_reply_unsupported`));
    assert.ok(codes.includes(`${cloud.assignment_id}:same_session_reply_unsupported`));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.assignment_id).sort(), [
      dsh.assignment_id, cloud.assignment_id,
    ].sort());
    assert.equal(calls.some((call) => call.assignment_id === grok.assignment_id), false);
  });
});

test('one reply round is durable before delivery and resolves exact same-session identities', async () => {
  await withRoot(async ({ handle }) => {
    const grok = grokItem();
    const { items, source } = itemsAndSource([grok]);
    const latched = await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    });
    const { deliver, calls } = trackingDeliver();
    const { cancel } = trackingCancel();
    const replied = await handle.reply({
      run_id: RUN_ID,
      batch_id: latched.record.batch_id,
      expected_revision: 1,
      reply: makeReply(latched.record.batch_id, [grok]),
      deliver,
      cancel,
    });
    assert.equal(replied.created, true);
    assert.equal(replied.record.status, 'resolved');
    assert.equal(replied.record.reply.round, 1);
    assert.equal(replied.record.items[0].disposition, 'answered');
    assert.equal(replied.complete_candidate_blocked, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].session_id, grok.session_id);
    assert.equal(calls[0].question_id, grok.question_id);
    assert.equal(calls[0].task_id, grok.task_id);
    assert.equal(calls[0].response, 'continue');
  });
});

test('restart retries only the exact latched identities after a durable reply', async () => {
  await withRoot(async ({ handle }) => {
    const grok = grokItem();
    const { items, source } = itemsAndSource([grok]);
    const latched = await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    });
    const firstDeliver = trackingDeliver('failed');
    const { cancel } = trackingCancel();
    const failed = await handle.reply({
      run_id: RUN_ID,
      batch_id: latched.record.batch_id,
      expected_revision: 1,
      reply: makeReply(latched.record.batch_id, [grok], 'allow_once'),
      deliver: firstDeliver.deliver,
      cancel,
    });
    assert.equal(failed.record.items[0].disposition, 'unresolved');
    assert.ok(failed.record.unresolved.some((entry) => entry.code === 'reply_delivery_failed'));

    const grok2 = grokItem();
    const { items: lateItems, source: lateSource } = itemsAndSource([grok2]);
    const retry = trackingDeliver();
    const error = await errorOf(() => handle.reply({
      run_id: RUN_ID,
      batch_id: latched.record.batch_id,
      expected_revision: failed.record.revision,
      reply: makeReply(latched.record.batch_id, [grok2], 'different'),
      deliver: retry.deliver,
      cancel,
    }));
    assert.equal(error.code, 'attention_batch_reply_conflict');
    assert.equal(retry.calls.length, 0);
    assert.equal(
      canonicalJsonStringify((await handle.get(RUN_ID)).record.reply),
      canonicalJsonStringify(failed.record.reply),
    );
    assert.equal(lateItems.length, 1);
    assert.equal(lateSource.task_cursors.length, 1);
  });
});

test('required unresolved blocks a complete candidate; optional unresolved does not', async () => {
  await withRoot(async ({ handle }) => {
    const requiredCloud = cloudItem({ required: true });
    const optionalDsh = dshItem({ required: false, assignmentId: ASSIGNMENT_A, taskId: 'task-opt' });
    const requiredPair = itemsAndSource([requiredCloud]);
    const requiredReceipt = await handle.latch({
      run_id: 'run-required-block',
      source: requiredPair.source,
      items: requiredPair.items,
      expected_revision: 0,
      cancel: trackingCancel().cancel,
    });
    assert.equal(requiredReceipt.complete_candidate_blocked, true);

    const optionalPair = itemsAndSource([optionalDsh]);
    const optionalReceipt = await handle.latch({
      run_id: 'run-optional-open',
      source: optionalPair.source,
      items: optionalPair.items,
      expected_revision: 0,
      cancel: trackingCancel().cancel,
    });
    assert.equal(optionalReceipt.complete_candidate_blocked, false);
    assert.equal(optionalReceipt.record.items[0].disposition, 'unresolved');
  });
});

test('later questions cannot open a second round and cancel only the late lanes', async () => {
  await withRoot(async ({ handle }) => {
    const grok = grokItem();
    const first = itemsAndSource([grok]);
    await handle.latch({
      run_id: RUN_ID, source: first.source, items: first.items, expected_revision: 0,
    });
    const late = cloudItem();
    const second = itemsAndSource([late]);
    const { cancel, calls } = trackingCancel();
    const receipt = await handle.latch({
      run_id: RUN_ID,
      source: second.source,
      items: second.items,
      expected_revision: 1,
      cancel,
    });
    assert.equal(receipt.created, false);
    assert.equal(receipt.record.items.length, 1);
    assert.equal(receipt.record.items[0].assignment_id, grok.assignment_id);
    assert.ok(receipt.record.unresolved.some((entry) => (
      entry.assignment_id === late.assignment_id
      && entry.code === 'late_attention_after_latch'
    )));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].assignment_id, late.assignment_id);
    assert.equal(receipt.complete_candidate_blocked, true);
  });
});

test('unsupported-only batch accepts the empty one-round reply and resolves', async () => {
  await withRoot(async ({ handle }) => {
    const dsh = dshItem({ required: false });
    const { items, source } = itemsAndSource([dsh]);
    const latched = await handle.latch({
      run_id: RUN_ID,
      source,
      items,
      expected_revision: 0,
      cancel: trackingCancel().cancel,
    });
    const replied = await handle.reply({
      run_id: RUN_ID,
      batch_id: latched.record.batch_id,
      expected_revision: 1,
      reply: makeReply(latched.record.batch_id, []),
    });
    assert.equal(replied.record.status, 'resolved');
    assert.equal(replied.record.reply.answers.length, 0);
    assert.equal(replied.record.reply.round, 1);
  });
});

test('P25 journal bytes stay unchanged and attention never writes journal files', async () => {
  const storeRoot = await makeStoreRoot('r1-p34-p25-store-');
  const journalRoot = await makeStoreRoot('r1-p34-p25-journal-');
  const attentionRoot = await makePrivateRoot('r1-p34-p25-attention-');
  try {
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId: RUN_ID }));
    const journal = await createRunJournal({ root: journalRoot, store, run_id: RUN_ID });
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    await journal.append({
      kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.tick' },
    });
    const before = await readFile(path.join(journal.directory, 'journal.jsonl'));
    const state = await journal.currentState();
    const grok = grokItem();
    const { items, source } = itemsAndSource([grok]);
    source.journal_revision = state.revision;
    source.journal_head_hash = state.head_hash;
    const handle = await openAttentionRoot(attentionRoot);
    await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    });
    const after = await readFile(path.join(journal.directory, 'journal.jsonl'));
    assert.equal(Buffer.compare(before, after), 0);
    const attentionNames = await readdir(path.join(attentionRoot, 'runs', RUN_ID));
    assert.equal(attentionNames.includes('journal.jsonl'), false);
    assert.equal(attentionNames.includes('state.json'), false);
    assert.equal(attentionNames.includes('created.json'), false);
    assert.deepEqual(attentionNames, [ATTENTION_BATCH_FILE_NAME]);
    const journalNames = await readdir(journal.directory);
    assert.equal(journalNames.includes(ATTENTION_BATCH_FILE_NAME), false);
    assert.deepEqual([...RUN_JOURNAL_EVENT_KINDS], [
      'run_opened', 'child_started', 'child_progress', 'child_artifact',
      'child_terminal', 'run_terminal',
    ]);
    assert.equal(RUN_JOURNAL_GENESIS_PREV, REDUCER_GENESIS);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
    await rm(attentionRoot, { recursive: true, force: true });
  }
});

test('P34 source does not import P25, mailbox, scheduler, or server surfaces', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  for (const forbidden of [
    'run-journal.mjs',
    'run-reducer.mjs',
    'mailbox.mjs',
    'server.mjs',
    'supervisor.mjs',
    'run-orchestration.mjs',
    'provider-registry.mjs',
  ]) {
    assert.equal(source.includes(`from './${forbidden}'`), false, forbidden);
  }
  const reducer = await readFile(REDUCER_PATH, 'utf8');
  const journal = await readFile(JOURNAL_PATH, 'utf8');
  assert.match(reducer, /export const RUN_JOURNAL_EVENT_KINDS/u);
  assert.match(journal, /journal\.jsonl/u);
  assert.equal(reducer.includes('attention-batch'), false);
  assert.equal(journal.includes('attention-batch.v1.json'), false);
});
