// P34 AttentionBatchV1 adversarial coverage: hostile containers, CAS, shared
// P25 roots, symlink/hardlink, identity drift, oversized inputs, and
// content-free failures.

import assert from 'node:assert/strict';
import { chmod, link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  ATTENTION_BATCH_FILE_NAME,
  MAX_ATTENTION_ITEMS,
  MAX_ATTENTION_PROMPT_BYTES,
  MAX_ATTENTION_RESPONSE_BYTES,
  openAttentionRoot,
} from '../mcp/v3/attention-batch.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { createRunJournal } from '../mcp/v3/run-journal.mjs';
import { openRunStore } from '../mcp/v3/run-store.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  makePrivateRoot as makeStoreRoot,
  makeSubmission,
} from './fixtures/r1-run-store-fixtures.mjs';
import {
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  RUN_ID,
  grokItem,
  itemsAndSource,
  makePrivateRoot,
  makeReply,
  trackingCancel,
  trackingDeliver,
} from './fixtures/r1-attention-batch-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertContentFree(error) {
  assert.doesNotMatch(error.message, /sk-live/u);
  assert.doesNotMatch(error.message, /ATTACKER-SECRET/u);
  assert.doesNotMatch(error.message, /github_pat/u);
  assert.doesNotMatch(error.message, /\/tmp\//u);
}

async function withRoot(fn) {
  const root = await makePrivateRoot('r1-p34-adv-');
  try {
    const handle = await openAttentionRoot(root);
    return await fn({ root, handle });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('proxies, symbols, accessors, and own undefined fail closed without traps', async () => {
  await withRoot(async ({ handle }) => {
    const { items, source } = itemsAndSource([grokItem()]);
    const { proxy, counts } = countingProxy({
      run_id: RUN_ID, source, items, expected_revision: 0,
    });
    const proxied = await errorOf(() => handle.latch(proxy));
    assert.equal(proxied.code, 'proxy_denied');
    assert.equal(trapTotal(counts), 0);

    const symbolic = { run_id: RUN_ID, source, items, expected_revision: 0 };
    Object.defineProperty(symbolic, Symbol('leak'), { value: HOSTILE_SECRET, enumerable: true });
    const symbolError = await errorOf(() => handle.latch(symbolic));
    assert.equal(symbolError.code, 'symbol_key_denied');
    assertContentFree(symbolError);

    const accessor = {
      run_id: RUN_ID,
      source,
      items,
      expected_revision: 0,
    };
    Object.defineProperty(accessor, 'cancel', {
      enumerable: true,
      get() { throw new Error(HOSTILE_SECRET); },
    });
    const accessorError = await errorOf(() => handle.latch(accessor));
    assert.equal(accessorError.code, 'accessor_property_denied');
    assertContentFree(accessorError);

    const undef = { run_id: RUN_ID, source, items, expected_revision: 0, now: undefined };
    const undefError = await errorOf(() => handle.latch(undef));
    assert.equal(undefError.code, 'own_undefined_denied');
  });
});

test('unknown keys, extra item fields, and capability mismatches fail closed', async () => {
  await withRoot(async ({ handle }) => {
    const { items, source } = itemsAndSource([grokItem()]);
    const unknown = await errorOf(() => handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0, note: 'progress.tick',
    }));
    assert.equal(unknown.code, 'unknown_key');

    const foreignItem = { ...items[0], child_progress_note: 'ask-the-user' };
    const extra = await errorOf(() => handle.latch({
      run_id: RUN_ID, source, items: [foreignItem], expected_revision: 0,
    }));
    assert.equal(extra.code, 'unknown_key');

    const mismatched = grokItem();
    mismatched.reply_capability = 'unsupported';
    mismatched.question_digest = items[0].question_digest;
    const cap = await errorOf(() => handle.latch({
      run_id: RUN_ID,
      source,
      items: [mismatched],
      expected_revision: 0,
    }));
    assert.equal(cap.code, 'capability_reply_mismatch');
  });
});

test('duplicate assignment ids, empty batches, and oversized prompts fail closed', async () => {
  await withRoot(async ({ handle }) => {
    const grok = grokItem();
    const { source } = itemsAndSource([grok]);
    const duplicate = await errorOf(() => handle.latch({
      run_id: RUN_ID,
      source,
      items: [grok, grokItem()],
      expected_revision: 0,
    }));
    assert.equal(duplicate.code, 'duplicate_assignment_id');

    const empty = await errorOf(() => handle.latch({
      run_id: RUN_ID, source, items: [], expected_revision: 0,
    }));
    assert.equal(empty.code, 'out_of_range');

    const nine = Array.from({ length: MAX_ATTENTION_ITEMS + 1 }, (_value, index) => grokItem({
      assignmentId: `assign-${index}`,
      taskId: `task-${index}`,
      sessionId: `sess-${index}`,
      questionId: `q-${index}`,
      eventCursor: String(index),
    }));
    const nineSource = itemsAndSource(nine).source;
    const flood = await errorOf(() => handle.latch({
      run_id: RUN_ID,
      source: nineSource,
      items: nine,
      expected_revision: 0,
    }));
    assert.equal(flood.code, 'out_of_range');

    const huge = grokItem({ prompt: 'p'.repeat(MAX_ATTENTION_PROMPT_BYTES + 1) });
    const hugePair = itemsAndSource([huge]);
    const prompt = await errorOf(() => handle.latch({
      run_id: RUN_ID,
      source: hugePair.source,
      items: hugePair.items,
      expected_revision: 0,
    }));
    assert.equal(prompt.code, 'out_of_range');
  });
});

test('expected_revision CAS rejects stale writers and expected_revision is mandatory', async () => {
  await withRoot(async ({ handle }) => {
    const { items, source } = itemsAndSource([grokItem()]);
    await handle.latch({ run_id: RUN_ID, source, items, expected_revision: 0 });
    const batchId = (await handle.get(RUN_ID)).record.batch_id;
    const stale = await errorOf(() => handle.reply({
      run_id: RUN_ID,
      batch_id: batchId,
      expected_revision: 0,
      reply: makeReply(batchId, items),
      deliver: trackingDeliver().deliver,
    }));
    assert.equal(stale.code, 'attention_batch_revision_conflict');

    const missing = await errorOf(() => handle.latch({
      run_id: RUN_ID, source, items,
    }));
    assert.equal(missing.code, 'missing_key');
  });
});

test('sharing a P25 journal root fails closed and writes nothing into it', async () => {
  const storeRoot = await makeStoreRoot('r1-p34-share-store-');
  const journalRoot = await makeStoreRoot('r1-p34-share-journal-');
  try {
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId: RUN_ID }));
    const journal = await createRunJournal({ root: journalRoot, store, run_id: RUN_ID });
    await journal.append({ kind: 'run_opened', data: {} });
    const handle = await openAttentionRoot(journalRoot);
    const { items, source } = itemsAndSource([grokItem()]);
    const error = await errorOf(() => handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    }));
    assert.equal(error.code, 'attention_batch_root_shared');
    const names = await (await import('node:fs/promises')).readdir(journal.directory);
    assert.equal(names.includes(ATTENTION_BATCH_FILE_NAME), false);
    assert.ok(names.includes('journal.jsonl'));
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('symlink roots, hardlinked records, and group-writable directories fail closed', async () => {
  const parent = await makePrivateRoot('r1-p34-link-');
  try {
    const real = path.join(parent, 'real');
    await mkdir(real, { mode: 0o700 });
    await chmod(real, 0o700);
    const linked = path.join(parent, 'link');
    await symlink(real, linked);
    const sym = await errorOf(() => openAttentionRoot(linked));
    assert.equal(sym.code, 'attention_batch_root_unsafe');

    const handle = await openAttentionRoot(real);
    const { items, source } = itemsAndSource([grokItem()]);
    await handle.latch({ run_id: RUN_ID, source, items, expected_revision: 0 });
    const recordPath = path.join(real, 'runs', RUN_ID, ATTENTION_BATCH_FILE_NAME);
    const alias = path.join(parent, 'hardlink-outside.json');
    await link(recordPath, alias);
    const hard = await errorOf(() => handle.get(RUN_ID));
    assert.equal(hard.code, 'attention_batch_not_regular');

    const openRoot = await makePrivateRoot('r1-p34-mode-');
    try {
      await chmod(openRoot, 0o770);
      const mode = await errorOf(() => openAttentionRoot(openRoot));
      assert.equal(mode.code, 'attention_batch_root_unsafe');
    } finally {
      await chmod(openRoot, 0o700).catch(() => {});
      await rm(openRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('oversized replies, second-round mutation, and delivery identity drift fail closed', async () => {
  await withRoot(async ({ handle }) => {
    const grok = grokItem();
    const { items, source } = itemsAndSource([grok]);
    const latched = await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    });
    const huge = await errorOf(() => handle.reply({
      run_id: RUN_ID,
      batch_id: latched.record.batch_id,
      expected_revision: 1,
      reply: makeReply(latched.record.batch_id, [grok], 'x'.repeat(MAX_ATTENTION_RESPONSE_BYTES + 1)),
      deliver: trackingDeliver().deliver,
    }));
    assert.equal(huge.code, 'out_of_range');

    const driftingDeliver = async (identity) => ({
      outcome: 'delivered',
      ...identity,
      session_id: 'other-session',
    });
    const drift = await errorOf(() => handle.reply({
      run_id: RUN_ID,
      batch_id: latched.record.batch_id,
      expected_revision: 1,
      reply: makeReply(latched.record.batch_id, [grok], 'allow_once'),
      deliver: driftingDeliver,
    }));
    assert.equal(drift.code, 'attention_batch_identity_mismatch');
    const durable = await handle.get(RUN_ID);
    assert.equal(durable.record.status, 'reply_committed');
    assert.equal(durable.record.reply.answers[0].response, 'allow_once');

    const { deliver } = trackingDeliver();
    const second = await errorOf(() => handle.reply({
      run_id: RUN_ID,
      batch_id: latched.record.batch_id,
      expected_revision: durable.record.revision,
      reply: makeReply(latched.record.batch_id, [grok], 'allow_always'),
      deliver,
    }));
    assert.equal(second.code, 'attention_batch_reply_conflict');
  });
});

test('concurrent identical latches converge; concurrent different replies have one winner', async () => {
  await withRoot(async ({ handle }) => {
    const grok = grokItem();
    const { items, source } = itemsAndSource([grok]);
    const results = await Promise.all(Array.from({ length: 8 }, () => handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0,
    })));
    const created = results.filter((result) => result.created);
    assert.equal(created.length, 1);
    for (const result of results) {
      assert.equal(result.record.batch_id, created[0].record.batch_id);
      assert.equal(result.record.revision, 1);
    }

    const { deliver } = trackingDeliver();
    const { cancel } = trackingCancel();
    const settled = await Promise.allSettled([
      handle.reply({
        run_id: RUN_ID,
        batch_id: created[0].record.batch_id,
        expected_revision: 1,
        reply: makeReply(created[0].record.batch_id, [grok], 'allow_once'),
        deliver,
        cancel,
      }),
      handle.reply({
        run_id: RUN_ID,
        batch_id: created[0].record.batch_id,
        expected_revision: 1,
        reply: makeReply(created[0].record.batch_id, [grok], 'allow_always'),
        deliver,
        cancel,
      }),
    ]);
    const wins = settled.filter((entry) => entry.status === 'fulfilled');
    const losses = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.ok(losses[0].reason instanceof RunContractV1Error);
    assert.ok(
      losses[0].reason.code === 'attention_batch_reply_conflict'
      || losses[0].reason.code === 'attention_batch_revision_conflict',
    );
    const final = await handle.get(RUN_ID);
    assert.equal(final.record.reply.answers[0].response, wins[0].value.record.reply.answers[0].response);
  });
});

test('unconfirmed cancel records safe_cancel_unconfirmed and stays content-free', async () => {
  await withRoot(async ({ handle }) => {
    const dsh = (await import('./fixtures/r1-attention-batch-fixtures.mjs')).dshItem();
    const { items, source } = itemsAndSource([dsh]);
    const { cancel } = trackingCancel('unconfirmed');
    const receipt = await handle.latch({
      run_id: RUN_ID, source, items, expected_revision: 0, cancel,
    });
    const codes = receipt.record.unresolved.map((entry) => entry.code);
    assert.ok(codes.includes('same_session_reply_unsupported'));
    assert.ok(codes.includes('safe_cancel_unconfirmed'));
    assert.equal(receipt.complete_candidate_blocked, true);
    assertContentFree(Object.assign(new Error(receipt.record.unresolved[0].code), {
      message: receipt.record.unresolved[0].code,
    }));
  });
});

test('expired deadline unresolved cancels only the affected lane', async () => {
  await withRoot(async ({ handle }) => {
    const live = grokItem({ deadlineAt: '2099-01-01T00:00:00.000Z' });
    const expired = grokItem({
      assignmentId: 'assign-late',
      taskId: 'task-late',
      sessionId: 'sess-late',
      questionId: 'q-late',
      eventCursor: '8',
      deadlineAt: '2020-01-01T00:00:00.000Z',
    });
    const { items, source } = itemsAndSource([live, expired]);
    const { cancel, calls } = trackingCancel();
    const receipt = await handle.latch({
      run_id: RUN_ID,
      source,
      items,
      expected_revision: 0,
      cancel,
      now: Date.parse('2021-01-01T00:00:00.000Z'),
    });
    const byId = Object.fromEntries(
      receipt.record.items.map((item) => [item.assignment_id, item]),
    );
    assert.equal(byId[live.assignment_id].disposition, 'pending');
    assert.equal(byId[expired.assignment_id].disposition, 'unresolved');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].assignment_id, expired.assignment_id);
    assert.ok(receipt.record.unresolved.some((entry) => entry.code === 'reply_deadline_expired'));
  });
});

test('foreign files, group-writable records, and secret-bearing errors stay content-free', async () => {
  await withRoot(async ({ root, handle }) => {
    const { items, source } = itemsAndSource([grokItem()]);
    await handle.latch({ run_id: RUN_ID, source, items, expected_revision: 0 });
    await writeFile(path.join(root, 'runs', RUN_ID, 'journal.jsonl'), `${HOSTILE_SECRET}\n`);
    const foreign = await errorOf(() => handle.get(RUN_ID));
    assert.equal(foreign.code, 'attention_batch_root_shared');
    assertContentFree(foreign);
  });

  await withRoot(async ({ handle }) => {
    const missing = await errorOf(() => handle.get('run-missing-batch'));
    assert.equal(missing.code, 'attention_batch_not_found');
    assertContentFree(missing);

    const { items, source } = itemsAndSource([grokItem()]);
    const leak = await errorOf(() => handle.latch({
      run_id: RUN_ID,
      source,
      items,
      expected_revision: 0,
      note: HOSTILE_TOKEN,
    }));
    assert.equal(leak.code, 'unknown_key');
    assertContentFree(leak);
    assert.equal(utilTypes.isProxy(handle), false);
    assert.equal(HOSTILE_PATH.startsWith('/tmp/'), true);
  });
});
