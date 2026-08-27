import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RUN_JOURNAL_GENESIS_PREV } from '../mcp/v3/run-reducer.mjs';
import {
  MAX_RUN_JOURNAL_ENTRIES,
  createRunJournal,
  openRunJournal,
  validateBoundRunRecord,
} from '../mcp/v3/run-journal.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { openRunStore } from '../mcp/v3/run-store.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  makePrivateRoot,
  makeSubmission,
} from './fixtures/r1-run-store-fixtures.mjs';

const WORKER = new URL('./fixtures/r1-run-journal-worker.mjs', import.meta.url).pathname;

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

async function withJournal(fn, { runId = 'run-journal-main', open = false } = {}) {
  const storeRoot = await makePrivateRoot('r1-p25-store-');
  const journalRoot = await makePrivateRoot('r1-p25-journal-');
  try {
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId }));
    const journal = open
      ? await openRunJournal({ root: journalRoot, store, run_id: runId })
      : await createRunJournal({ root: journalRoot, store, run_id: runId });
    return await fn({ store, storeRoot, journalRoot, runId, journal });
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
}

async function readJournalFile(directory) {
  try {
    return await readFile(path.join(directory, 'journal.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

test('create and open bind an exact validated P24 record before any path exists', async () => {
  const storeRoot = await makePrivateRoot('r1-p25-store-');
  const journalRoot = await makePrivateRoot('r1-p25-journal-');
  try {
    const store = await openRunStore(storeRoot);
    // Unbound run: typed failure and zero filesystem side effects.
    const missing = await errorOf(() =>
      createRunJournal({ root: journalRoot, store, run_id: 'run-never-bound' }));
    assert.equal(missing.code, 'run_store_not_found');
    assert.deepEqual(await readdir(journalRoot), []);

    await store.submit(makeSubmission({ runId: 'run-journal-bind' }));
    const journal = await createRunJournal({ root: journalRoot, store, run_id: 'run-journal-bind' });
    assert.equal(journal.run_id, 'run-journal-bind');
    assert.match(journal.record_canonical_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(path.basename(path.dirname(journal.directory)), 'runs');
    assert.equal(path.basename(journal.directory), 'run-journal-bind');

    const rebound = await errorOf(() =>
      createRunJournal({ root: journalRoot, store, run_id: 'run-journal-bind' }));
    assert.equal(rebound.code, 'run_journal_already_exists');

    // Sharing the accepted P24 store root fails closed.
    const shared = await errorOf(() =>
      createRunJournal({ root: storeRoot, store, run_id: 'run-journal-bind' }));
    assert.equal(shared.code, 'run_journal_root_shared');

    // A record whose canonical digest was tampered with fails validation.
    const forged = snapshotCopy(await store.getByRunId('run-journal-bind'));
    forged.canonical_digest = `sha256:${'0'.repeat(64)}`;
    assert.equal((await errorOf(() => validateBoundRunRecord(forged))).code,
      'run_journal_record_mismatch');
    const swapped = snapshotCopy(await store.getByRunId('run-journal-bind'));
    const other = makeSubmission({ runId: 'run-other-identity' });
    swapped.identity = other.identity;
    assert.equal((await errorOf(() => validateBoundRunRecord(swapped))).code,
      'run_journal_identity_mismatch');

    const reopened = await openRunJournal({ root: journalRoot, store, run_id: 'run-journal-bind' });
    assert.equal(reopened.record_canonical_digest, journal.record_canonical_digest);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

function snapshotCopy(record) {
  return JSON.parse(canonicalJsonStringify(record));
}

test('one-child lifecycle appends dense chained entries and settles absorbingly', async () => {
  await withJournal(async ({ journal }) => {
    const first = await journal.append({ kind: 'run_opened', data: {} });
    assert.equal(first.created, true);
    assert.equal(first.entry.seq, 1);
    assert.equal(first.entry.prev, RUN_JOURNAL_GENESIS_PREV);
    assertFrozenTree(first.entry);

    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    await journal.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.tick' } });
    await journal.append({
      kind: 'child_artifact',
      data: { assignment_id: 'a0', artifact: { digest: `sha256:${'b'.repeat(64)}`, bytes: 4096 } },
    });
    await journal.append({ kind: 'child_terminal', data: { assignment_id: 'a0', outcome: 'completed' } });
    const settled = await journal.append({ kind: 'run_terminal', data: { outcome: 'completed' } });
    assert.equal(settled.state.revision, 6);
    assert.equal(settled.state.terminal, true);
    assert.equal(settled.state.run_outcome, 'completed');
    assert.equal(settled.state.artifacts_total, 1);
    assert.equal(settled.state.artifact_bytes_total, 4096);

    // Absorbing terminal state rejects every further event.
    const absorbed = await errorOf(() => journal.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: 'progress.late' },
    }));
    assert.equal(absorbed.code, 'run_journal_terminal_absorbed');

    const text = await readJournalFile(journal.directory);
    const lines = text.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 6);
    const seqs = lines.map((line) => JSON.parse(line).seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
  });
});

for (const childCount of [2, 8]) {
  test(`${childCount}-child lifecycle interleaves and settles only once every child is terminal`, async () => {
    await withJournal(async ({ journal }) => {
      await journal.append({ kind: 'run_opened', data: {} });
      const ids = Array.from({ length: childCount }, (_, index) => `child-${index}`);
      for (const id of ids) {
        await journal.append({ kind: 'child_started', data: { assignment_id: id } });
      }
      // A run terminal before all children settle is illegal.
      const early = await errorOf(() => journal.append({
        kind: 'run_terminal', data: { outcome: 'completed' },
      }));
      assert.equal(early.code, 'run_journal_transition_invalid');

      for (let index = 0; index < ids.length; index += 1) {
        await journal.append({
          kind: 'child_progress',
          data: { assignment_id: ids[index], note: 'progress.tick' },
        });
        await journal.append({
          kind: 'child_terminal',
          data: { assignment_id: ids[index], outcome: index % 2 === 0 ? 'completed' : 'failed' },
        });
      }
      if (childCount === 8) {
        const ninth = await errorOf(() => journal.append({
          kind: 'child_started', data: { assignment_id: 'child-over' },
        }));
        assert.equal(ninth.code, 'run_journal_children_exceeded');
      }

      const final = await journal.append({ kind: 'run_terminal', data: { outcome: 'completed' } });
      assert.equal(final.state.child_count, childCount);
      assert.equal(final.state.children.every((child) => child.outcome !== null), true);
      assert.deepEqual(
        final.state.children.map((child) => child.assignment_id),
        [...ids].sort(),
      );
    });
  });
}

test('exact head dedupe returns the stored entry without mutation; replay and body conflicts fail', async () => {
  await withJournal(async ({ journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    const submitted = await journal.append({
      kind: 'child_started',
      data: { assignment_id: 'a0' },
      dedupe_key: 'dispatch/a0/attempt-1',
    });
    assert.equal(submitted.created, true);

    const duplicate = await journal.append({
      kind: 'child_started',
      data: { assignment_id: 'a0' },
      dedupe_key: 'dispatch/a0/attempt-1',
      expected_seq: 2,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.deduped, true);
    assert.equal(duplicate.entry.seq, 2);
    assert.equal(canonicalJsonStringify(duplicate.entry), canonicalJsonStringify(submitted.entry));

    // The same body resubmitted once the head advanced is a replay.
    await journal.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.x' } });
    const inodeBefore = (await lstat(path.join(journal.directory, 'journal.jsonl'))).ino;
    const replayed = await errorOf(() => journal.append({
      kind: 'child_started',
      data: { assignment_id: 'a0' },
      dedupe_key: 'dispatch/a0/attempt-1',
    }));
    assert.equal(replayed.code, 'run_journal_replay_conflict');

    // The same key with a different body is a dedupe conflict at any position.
    const conflictingBody = await errorOf(() => journal.append({
      kind: 'child_started',
      data: { assignment_id: 'a1' },
      dedupe_key: 'dispatch/a0/attempt-1',
    }));
    assert.equal(conflictingBody.code, 'run_journal_dedupe_conflict');

    const inodeAfter = (await lstat(path.join(journal.directory, 'journal.jsonl'))).ino;
    assert.equal(inodeAfter, inodeBefore, 'conflicts and dedupe must not mutate the journal');
  });
});

test('compare-and-swap expected_seq gates concurrent optimism with typed conflicts', async () => {
  await withJournal(async ({ journal }) => {
    await journal.append({ kind: 'run_opened', data: {}, expected_seq: 1 });
    const raced = await journal.append({
      kind: 'child_started',
      data: { assignment_id: 'a0' },
      expected_seq: 3,
    }).then(
      () => null,
      (error) => error,
    );
    assert.equal(raced.code, 'run_journal_expectation_conflict');
    const correct = await journal.append({
      kind: 'child_started',
      data: { assignment_id: 'a0' },
      expected_seq: 2,
    });
    assert.equal(correct.created, true);
    assert.equal(correct.entry.seq, 2);
  });
});

test('crash and restart replay the exact derived state and republish stale caches', async () => {
  await withJournal(async ({ store, journalRoot, runId, journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    const liveState = await journal.currentState();

    // Simulate a crash after the journal rename but before the state cache publish.
    const cachePath = path.join(journal.directory, 'state.json');
    const staleCache = await readFile(cachePath);
    await journal.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.a' } });
    await writeFile(cachePath, staleCache);

    const restarted = await openRunJournal({ root: journalRoot, store, run_id: runId });
    const replayed = await restarted.currentState();
    assert.notEqual(replayed.revision, liveState.revision);
    assert.equal(replayed.revision, 3);
    assert.equal(replayed.event_counts.child_progress, 1);

    // The next append republishes the cache at the new head.
    await restarted.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.b' } });
    const finalState = await restarted.currentState();
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(cached.revision, 4);
    assert.equal(cached.revision, finalState.revision);
    assert.equal(cached.head_hash, finalState.head_hash);
  });
});

test('missing and stale derived-state caches rebuild exactly; disagreeing caches fail hard', async () => {
  await withJournal(async ({ store, journalRoot, runId, journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    const cachePath = path.join(journal.directory, 'state.json');
    const journalPath = path.join(journal.directory, 'journal.jsonl');
    const revTwoCache = Buffer.from(await readFile(cachePath));

    await rm(cachePath);
    const reopened = await openRunJournal({ root: journalRoot, store, run_id: runId });
    assert.equal((await reopened.currentState()).revision, 2);

    await reopened.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: 'progress.c' },
    });
    assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).revision, 3);

    // A well-formed older cache is a legal crash residue.
    await writeFile(cachePath, revTwoCache);
    const staleOk = await openRunJournal({ root: journalRoot, store, run_id: runId });
    assert.equal((await staleOk.currentState()).revision, 3);

    // A structurally valid cache that lies about its own prefix is tampering.
    const lying = JSON.parse(canonicalJsonStringify(
      JSON.parse(revTwoCache.toString('utf8')),
    ));
    lying.children[0].progress_events = 5;
    await writeFile(cachePath, `${canonicalJsonStringify(lying)}\n`);
    const mismatch = await errorOf(() => openRunJournal({ root: journalRoot, store, run_id: runId }));
    assert.equal(mismatch.code, 'run_journal_state_mismatch');

    // A consistent cache above a shortened-but-valid journal is regression.
    await writeFile(cachePath, revTwoCache);
    const firstLine = (await readFile(journalPath, 'utf8')).split('\n')[0];
    await writeFile(journalPath, `${firstLine}\n`);
    const regressed = await errorOf(() => openRunJournal({ root: journalRoot, store, run_id: runId }));
    assert.equal(regressed.code, 'run_journal_state_regression');
  });
});

test('torn tails heal by truncation on demand and automatically before the next append', async () => {
  await withJournal(async ({ journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    const journalPath = path.join(journal.directory, 'journal.jsonl');
    const good = await readFile(journalPath);
    await appendBytes(journalPath, '{"schema":"codex-co-engineer.run-jou');

    const healed = await journal.healTornTail();
    assert.equal(healed.healed, true);
    assert.equal(healed.state.revision, 2);
    assert.equal(await readFile(journalPath, 'utf8'), good.toString('utf8'));

    // Reads fail closed while torn; append heals first and then commits.
    await appendBytes(journalPath, '{"seq":3,"kind":"child_prog');
    const healedAgain = await journal.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: 'progress.after-crash' },
    });
    assert.equal(healedAgain.created, true);
    assert.equal(healedAgain.entry.seq, 3);
    assert.equal(healedAgain.state.event_counts.child_progress, 1);
  });
});

async function appendBytes(target, text) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(target, text);
}

test('committed corruption anywhere fails hard while torn-tail bytes stay healable', async () => {
  await withJournal(async ({ store, journalRoot, runId, journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    await journal.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.mid' } });
    const journalPath = path.join(journal.directory, 'journal.jsonl');
    const lines = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean);

    // Rewrite the middle entry's outcome fields: committed corruption.
    const forged = JSON.parse(lines[1]);
    forged.data.assignment_id = 'hijack';
    lines[1] = canonicalJsonStringify(forged);
    await writeFile(journalPath, `${lines.join('\n')}\n`);
    const corrupt = await errorOf(() => openRunJournal({ root: journalRoot, store, run_id: runId }));
    assert.equal(corrupt.code, 'run_journal_committed_corruption');

    // A fully-written but hash-breaking tail line is committed corruption too.
    const honest = [
      canonicalJsonStringify(JSON.parse(lines[0])),
      canonicalJsonStringify({ ...JSON.parse(lines[1]), data: { assignment_id: 'a0' } }),
      lines[2],
    ];
    const brokenHash = JSON.parse(honest[2]);
    brokenHash.hash = `sha256:${'f'.repeat(64)}`;
    await writeFile(journalPath, `${honest.join('\n')}\n${canonicalJsonStringify(brokenHash)}\n`);
    const tailCorrupt = await errorOf(() => journal.healTornTail());
    assert.equal(tailCorrupt.code, 'run_journal_committed_corruption');
  });
});

test('cursor paging is bounded, run-bound, tamper-evident, and diagnostics stay content-free', async () => {
  await withJournal(async ({ journal, runId }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    for (let index = 0; index < 5; index += 1) {
      await journal.append({
        kind: 'child_progress',
        data: { assignment_id: 'a0', note: `progress.${index}` },
      });
    }

    const page1 = await journal.readPage({ limit: 2 });
    assert.equal(page1.events.length, 2);
    assert.equal(page1.events[0].seq, 1);
    assert.deepEqual(Object.keys(page1.diagnostics).sort(), [
      'remaining_events', 'served_bytes', 'served_events', 'stale_temporaries', 'truncated',
    ]);
    assert.equal(page1.diagnostics.truncated, true);
    assert.equal(typeof page1.diagnostics.served_bytes, 'number');
    assertFrozenTree(page1);

    const page2 = await journal.readPage({ cursor: page1.next_cursor, limit: 2 });
    const page3 = await journal.readPage({ cursor: page2.next_cursor, limit: 2 });
    const page4 = await journal.readPage({ cursor: page3.next_cursor, limit: 2 });
    assert.equal(page4.events.length, 1);
    assert.equal(page4.next_cursor, null);
    assert.equal(page4.diagnostics.remaining_events, 0);
    const served = [...page1.events, ...page2.events, ...page3.events, ...page4.events];
    assert.deepEqual(served.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6, 7]);

    const position = await journal.cursorAfter(7);
    assert.equal(position.cursor.length <= 512, true);
    const emptyTail = await journal.readPage({ cursor: position.cursor, limit: 2 });
    assert.equal(emptyTail.events.length, 0);

    // Tampering with any token byte fails closed.
    const flipped = flipLastChar(page1.next_cursor);
    const tampered = await errorOf(() => journal.readPage({ cursor: flipped }));
    assert.equal(tampered.code, 'run_journal_cursor_invalid');

    // A cursor beyond the head is stale; a mismatched prefix hash is rejected.
    // Both forgeries carry valid seals: the cursor is tamper-evident, not secret.
    const { RUN_JOURNAL_CURSOR_DOMAIN } = await import('../mcp/v3/run-journal.mjs');
    const sealFor = (payloadText) => {
      const payload = Buffer.from(payloadText).toString('base64url');
      const seal = createHash('sha256').update(`${RUN_JOURNAL_CURSOR_DOMAIN}\n${payload}`, 'utf8').digest();
      return `${payload}.${seal.toString('base64url')}`;
    };
    const staleToken = sealFor(canonicalJsonStringify({
      v: 1,
      run: journal.run_fingerprint,
      seq: 99,
      head: RUN_JOURNAL_GENESIS_PREV,
    }));
    const stale = await errorOf(() => journal.readPage({ cursor: staleToken }));
    assert.equal(stale.code, 'run_journal_cursor_stale');

    const mismatchToken = sealFor(canonicalJsonStringify({
      v: 1,
      run: journal.run_fingerprint,
      seq: 0,
      head: `sha256:${'0'.repeat(64)}`,
    }));
    const mismatched = await errorOf(() => journal.readPage({ cursor: mismatchToken }));
    assert.equal(mismatched.code, 'run_journal_cursor_mismatch');

    // Cross-run reuse fails with the dedicated code. The sibling keeps its
    // own P24 store alive so every rebinding stays possible until asserted.
    const siblingStore = await makePrivateRoot('r1-p25-sibling-store-');
    const siblingRoot = await makePrivateRoot('r1-p25-sibling-root-');
    try {
      const siblingStoreHandle = await openRunStore(siblingStore);
      await siblingStoreHandle.submit(makeSubmission({ runId: 'run-journal-sibling' }));
      const second = await createRunJournal({
        root: siblingRoot,
        store: siblingStoreHandle,
        run_id: 'run-journal-sibling',
      });
      const crossRun = await errorOf(() => second.readPage({ cursor: page1.next_cursor }));
      assert.equal(crossRun.code, 'run_journal_cursor_cross_run');
    } finally {
      await rm(siblingStore, { recursive: true, force: true });
      await rm(siblingRoot, { recursive: true, force: true });
    }
    void runId;
  }, { runId: 'run-journal-pages' });
});

function flipLastChar(token) {
  const last = token.at(-1);
  const replacement = last === 'A' ? 'B' : 'A';
  return `${token.slice(0, -1)}${replacement}`;
}

test('cross-process appends serialize into one dense authoritative chain', async () => {
  await withJournal(async ({ storeRoot, journalRoot, runId, journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });

    const workers = ['w0', 'w1', 'w2'].map((prefix) => spawnWorker({
      storeRoot, journalRoot, runId, count: 6, prefix,
    }));
    const results = await Promise.all(workers.map((worker) => worker.done));
    for (const result of results) {
      assert.equal(result.ok, true,
        `worker failed: ${result.code ?? ''} ${result.message ?? ''}`);
      assert.equal(result.appended, 6);
    }
    const createdTotal = results.reduce((sum, result) => sum + result.created, 0);
    const dedupedTotal = results.reduce((sum, result) => sum + result.deduped, 0);
    assert.equal(createdTotal + dedupedTotal, 18);

    const final = await journal.currentState();
    assert.equal(final.revision, 20);
    assert.equal(final.event_counts.child_progress, 18);
    const text = await readJournalFile(journal.directory);
    const seqs = text.split('\n').filter(Boolean).map((line) => JSON.parse(line).seq);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, index) => index + 1));
  }, { runId: 'run-journal-concurrent' });
});

test('duplicate cross-process submissions keep exactly one committed entry per dedupe key', async () => {
  await withJournal(async ({ storeRoot, journalRoot, runId, journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });

    const sameKey = ['d0', 'd1', 'd2'].map(() => spawnWorker({
      storeRoot,
      journalRoot,
      runId,
      count: 1,
      prefix: 'same.key',
    }));
    const outcomes = await Promise.all(sameKey.map((worker) => worker.done));
    // All workers used identical prefixes, so all three targeted one key/body.
    const created = outcomes.filter((result) => result.ok && result.created === 1).length;
    const deduped = outcomes.filter((result) => result.ok && result.deduped === 1).length;
    const conflicted = outcomes.filter((result) => !result.ok
      && (result.code === 'run_journal_replay_conflict'
        || result.code === 'run_journal_dedupe_conflict')).length;
    assert.equal(created + deduped + conflicted, 3);
    assert.equal(created <= 1, true, 'at most one worker may create the entry');

    const state = await journal.currentState();
    assert.equal(state.event_counts.child_progress <= 1, true);
  }, { runId: 'run-journal-duplicate' });
});

function spawnWorker({ storeRoot, journalRoot, runId, count, prefix }) {
  const child = spawn(process.execPath, [WORKER, storeRoot, journalRoot, runId, String(count), prefix]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('exit', () => {
      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
      } catch (error) {
        reject(new Error(`worker produced no result (${stderr.trim()}): ${error.message}`));
      }
    });
    child.on('error', reject);
  });
  return { done, child };
}

test('a dead owner lock is recovered within bounds; a live foreign owner times out typed', async () => {
  await withJournal(async ({ journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });

    // Dead-owner recovery.
    const deadChild = spawn(process.execPath, ['-e', 'process.exit(0);']);
    await new Promise((resolve) => deadChild.on('exit', resolve));
    const { RUN_JOURNAL_LOCK_SCHEMA_ID } = await import('../mcp/v3/run-journal.mjs');
    const deadLock = path.join(journal.directory, 'lock');
    await writeFile(deadLock, `${canonicalJsonStringify({
      schema: RUN_JOURNAL_LOCK_SCHEMA_ID,
      pid: deadChild.pid,
      nonce: 'a'.repeat(32),
    })}\n`, { mode: 0o600 });
    await chmod(deadLock, 0o600);
    const recovered = await journal.append({
      kind: 'child_started',
      data: { assignment_id: 'a0' },
    });
    assert.equal(recovered.created, true);
    assert.equal((await journal.currentState()).event_counts.child_started, 1);

    // Live foreign owner times out within the bounded wait.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);']);
    try {
      const liveLock = path.join(journal.directory, 'lock');
      await writeFile(liveLock, `${canonicalJsonStringify({
        schema: RUN_JOURNAL_LOCK_SCHEMA_ID,
        pid: holder.pid,
        nonce: 'b'.repeat(32),
      })}\n`, { mode: 0o600 });
      await chmod(liveLock, 0o600);
      const startedAt = Date.now();
      const timeout = await errorOf(() => journal.append({
        kind: 'child_progress',
        data: { assignment_id: 'a0', note: 'progress.blocked' },
      }));
      assert.equal(timeout.code, 'run_journal_lock_timeout');
      assert.equal(Date.now() - startedAt >= 1500, true);
    } finally {
      holder.kill('SIGKILL');
      await rm(path.join(journal.directory, 'lock'), { force: true });
    }
  });
});

test('entry caps, byte bounds, and private modes hold across the whole journal', async () => {
  await withJournal(async ({ journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    for (let index = 0; index < MAX_RUN_JOURNAL_ENTRIES - 2; index += 1) {
      await journal.append({
        kind: 'child_progress',
        data: { assignment_id: 'a0', note: `p.${index}` },
      });
    }
    assert.equal((await journal.currentState()).revision, MAX_RUN_JOURNAL_ENTRIES);
    const flooded = await errorOf(() => journal.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: 'p.over' },
    }));
    assert.equal(flooded.code, 'run_journal_flood');

    const stat = await lstat(path.join(journal.directory, 'journal.jsonl'));
    assert.equal(stat.mode & 0o777, 0o600);
    const dirStat = await lstat(journal.directory);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const runsStat = await lstat(path.join(path.dirname(journal.directory)));
    assert.equal(runsStat.mode & 0o777, 0o700);
  }, { runId: 'run-journal-caps' });
});

test('oversized single events are rejected before anything is written', async () => {
  await withJournal(async ({ journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    const before = await readJournalFile(journal.directory);
    const oversized = await errorOf(() => journal.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: 'progress.' + 'x'.repeat(4000) },
    }));
    assert.equal(oversized.code, 'invalid_format');
    assert.equal(await readJournalFile(journal.directory), before);
  });
});

test('mode tightening of the supplied root is respected as a privacy precondition', async () => {
  const storeRoot = await makePrivateRoot('r1-p25-store-');
  const journalRoot = await makePrivateRoot('r1-p25-journal-');
  try {
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId: 'run-journal-mode' }));
    await chmod(journalRoot, 0o755);
    const unsafe = await errorOf(() =>
      createRunJournal({ root: journalRoot, store, run_id: 'run-journal-mode' }));
    assert.equal(unsafe.code, 'run_journal_unsafe_path');
    await chmod(journalRoot, 0o700);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('hardlinked journal files fail closed', async () => {
  await withJournal(async ({ journal }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    const journalPath = path.join(journal.directory, 'journal.jsonl');
    const scratch = await mkdtemp(path.join(tmpdir(), 'r1-p25-hardlink-'));
    try {
      const twin = path.join(scratch, 'twin.jsonl');
      await copyFile(journalPath, twin);
      await rm(journalPath);
      const { link } = await import('node:fs/promises');
      await link(twin, journalPath);
      const stat = await lstat(journalPath);
      assert.equal(stat.nlink, 2);
      const hardlinked = await errorOf(() => journal.currentState());
      assert.equal(hardlinked.code, 'run_journal_not_regular');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
