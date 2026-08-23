import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { initializeAggregateRunAnchorRoot } from '../mcp/v3/aggregate-run-anchor.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  RUN_JOURNAL_CURSOR_DOMAIN,
  RUN_JOURNAL_STAMP_SCHEMA_ID,
  RUN_JOURNAL_STAMP_SCHEMA_ID_V2,
  bindAggregateResolution,
  createAggregateRunJournal,
  createRunJournal,
  openAggregateRunJournal,
  openRunJournal,
  validateBoundAggregateResolution,
} from '../mcp/v3/run-journal.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  RUN_JOURNAL_EVENT_KINDS,
  RUN_JOURNAL_GENESIS_PREV,
  RUN_JOURNAL_HASH_DOMAIN,
  RUN_JOURNAL_STATE_SCHEMA_ID,
} from '../mcp/v3/run-reducer.mjs';
import { openRunStore } from '../mcp/v3/run-store.mjs';
import {
  AGGREGATE_RUN_ID,
  makePrivateRoot,
  makeResolvedAnchor,
  makeSubmitInput,
} from './fixtures/r1-run-journal-aggregate-fixtures.mjs';
import {
  makePrivateRoot as makeStoreRoot,
  makeSubmission,
} from './fixtures/r1-run-store-fixtures.mjs';

const GOLDEN = JSON.parse(await readFile(
  new URL('./fixtures/r1-run-journal-legacy-bytes.json', import.meta.url),
  'utf8',
));
const WORKER = fileURLToPath(new URL('./fixtures/r1-run-journal-aggregate-worker.mjs', import.meta.url));

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

function assertNoSecret(error) {
  assert.doesNotMatch(error.message, /ATTACKER-SECRET/u);
  assert.doesNotMatch(error.message, /sk-live/u);
  assert.doesNotMatch(JSON.stringify(error), /ATTACKER-SECRET/u);
}

async function withAggregateJournal(fn, { branch = 'selection', runId = AGGREGATE_RUN_ID } = {}) {
  const prepared = await makeResolvedAnchor({ branch, runId });
  const journalRoot = await makePrivateRoot('r1-r25b-journal-');
  try {
    const journal = await createAggregateRunJournal({
      root: journalRoot,
      anchor: prepared.anchor,
      run_id: runId,
    });
    return await fn({
      ...prepared,
      journalRoot,
      journal,
    });
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
}

function spawnWorker({ anchorRoot, journalRoot, runId, count, prefix }) {
  const child = spawn(process.execPath, [
    WORKER, anchorRoot, journalRoot, runId, String(count), prefix,
  ]);
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

test('legacy stamp, fingerprint, six events, reducer, cursor, and entrypoints stay byte-identical', async () => {
  assert.equal(RUN_JOURNAL_STAMP_SCHEMA_ID, GOLDEN.stampSchemaV1);
  assert.equal(RUN_JOURNAL_STAMP_SCHEMA_ID_V2, GOLDEN.stampSchemaV2);
  assert.deepEqual([...RUN_JOURNAL_EVENT_KINDS], GOLDEN.eventKinds);
  assert.equal(RUN_JOURNAL_GENESIS_PREV, GOLDEN.genesisPrev);
  assert.equal(RUN_JOURNAL_HASH_DOMAIN, GOLDEN.hashDomain);
  assert.equal(RUN_JOURNAL_CURSOR_DOMAIN, GOLDEN.cursorDomain);
  assert.equal(RUN_JOURNAL_STATE_SCHEMA_ID, GOLDEN.stateSchema);

  const sample = GOLDEN.fingerprintSample;
  const fingerprint = createHash('sha256')
    .update(`${RUN_JOURNAL_HASH_DOMAIN}\n${sample.runId}\n${sample.recordDigest}\n`, 'utf8')
    .digest('hex');
  assert.equal(fingerprint, sample.fingerprint);

  const storeRoot = await makeStoreRoot('r1-r25b-legacy-store-');
  const journalRoot = await makePrivateRoot('r1-r25b-legacy-journal-');
  try {
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId: 'run-journal-bind' }));
    const journal = await createRunJournal({
      root: journalRoot, store, run_id: 'run-journal-bind',
    });
    assert.equal(typeof journal.record_canonical_digest, 'string');
    assert.equal(journal.aggregate_binding_digest, undefined);
    const stamp = JSON.parse(await readFile(path.join(journal.directory, 'created.json'), 'utf8'));
    assert.equal(stamp.schema, GOLDEN.stampSchemaV1);
    assert.deepEqual(Object.keys(stamp).sort(), GOLDEN.stampV1Keys);
    assert.match(stamp.nonce, /^[0-9a-f]{32}$/u);
    assert.equal(stamp.run_id, 'run-journal-bind');
    assert.equal(stamp.record_canonical_digest, journal.record_canonical_digest);

    const opened = await journal.append({ kind: 'run_opened', data: {} });
    assert.equal(opened.entry.hash, GOLDEN.runOpenedHash);
    const line = (await readFile(path.join(journal.directory, 'journal.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)[0];
    assert.equal(line, GOLDEN.runOpenedLine);

    const reopened = await openRunJournal({
      root: journalRoot, store, run_id: 'run-journal-bind',
    });
    assert.equal(reopened.record_canonical_digest, journal.record_canonical_digest);
    assert.equal(reopened.run_fingerprint, journal.run_fingerprint);
    assert.equal((await reopened.currentState()).head_hash, GOLDEN.runOpenedHash);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('selection-branch resolution_ready binds stamp v2 and exact reopen/replay', async () => {
  await withAggregateJournal(async ({ journal, journalRoot, anchor, runId, root }) => {
    assert.equal(journal.run_id, runId);
    assert.equal(journal.record_canonical_digest, undefined);
    assert.match(journal.aggregate_binding_digest, /^sha256:[0-9a-f]{64}$/u);
    assertFrozenTree(journal.aggregate_binding_digest);

    const stamp = JSON.parse(await readFile(path.join(journal.directory, 'created.json'), 'utf8'));
    assert.equal(stamp.schema, GOLDEN.stampSchemaV2);
    assert.deepEqual(Object.keys(stamp).sort(), GOLDEN.stampV2Keys);
    assert.equal(stamp.run_id, runId);
    assert.equal(stamp.binding_digest, journal.aggregate_binding_digest);

    const bound = await bindAggregateResolution(anchor, runId);
    assert.equal(bound.phase, 'resolution_ready');
    assert.equal(bound.revision, 2);
    assert.equal(bound.binding_digest, journal.aggregate_binding_digest);
    assert.equal(validateBoundAggregateResolution(bound).binding_digest, bound.binding_digest);

    const first = await journal.append({ kind: 'run_opened', data: {} });
    assert.equal(first.created, true);
    assert.equal(first.entry.hash, GOLDEN.runOpenedHash);
    const line = (await readFile(path.join(journal.directory, 'journal.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)[0];
    assert.equal(line, GOLDEN.runOpenedLine);

    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    const live = await journal.currentState();

    const reopened = await openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    assert.equal(reopened.aggregate_binding_digest, journal.aggregate_binding_digest);
    assert.equal(reopened.run_fingerprint, journal.run_fingerprint);
    const replayed = await reopened.currentState();
    assert.equal(canonicalJsonStringify(replayed), canonicalJsonStringify(live));

    const again = await openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    assert.equal(again.aggregate_binding_digest, journal.aggregate_binding_digest);
    assert.equal(canonicalJsonStringify(await again.currentState()), canonicalJsonStringify(live));
    void root;
  });
});

test('direct-plan resolution_ready@1 binds a distinct identity and replays after restart', async () => {
  await withAggregateJournal(async ({ journal, journalRoot, anchor, runId }) => {
    const bound = await bindAggregateResolution(anchor, runId);
    assert.equal(bound.phase, 'resolution_ready');
    assert.equal(bound.revision, 1);
    assert.equal(journal.aggregate_binding_digest, bound.binding_digest);

    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    const cachePath = path.join(journal.directory, 'state.json');
    const stale = await readFile(cachePath);
    await journal.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.a' } });
    await writeFile(cachePath, stale);

    const restarted = await openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    const replayed = await restarted.currentState();
    assert.equal(replayed.revision, 3);
    assert.equal(replayed.event_counts.child_progress, 1);
    await restarted.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.b' } });
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(cached.revision, 4);
  }, { branch: 'plan', runId: 'direct-plan-run' });
});

test('pre-resolution and empty roots never infer or claim aggregate journal state', async () => {
  const root = await makePrivateRoot('r1-r25b-preres-');
  const journalRoot = await makePrivateRoot('r1-r25b-preres-j-');
  try {
    const anchor = await initializeAggregateRunAnchorRoot(root);
    assert.equal((await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: AGGREGATE_RUN_ID,
    }))).code, 'aggregate_run_not_found');
    assert.deepEqual(await readdir(journalRoot), []);

    await anchor.submit(makeSubmitInput());
    const submitted = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: AGGREGATE_RUN_ID,
    }));
    assert.equal(submitted.code, 'run_journal_aggregate_not_ready');
    assertNoSecret(submitted);
    assert.deepEqual(await readdir(journalRoot), []);

    const missingOpen = await errorOf(() => openAggregateRunJournal({
      root: journalRoot, anchor, run_id: AGGREGATE_RUN_ID,
    }));
    assert.ok(missingOpen.code === 'run_journal_not_found'
      || missingOpen.code === 'run_journal_aggregate_not_ready');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('legacy and aggregate entrypoints never cross-open or share roots', async () => {
  const prepared = await makeResolvedAnchor();
  const journalRoot = await makePrivateRoot('r1-r25b-cross-j-');
  const storeRoot = await makeStoreRoot('r1-r25b-cross-p24-');
  try {
    const journal = await createAggregateRunJournal({
      root: journalRoot, anchor: prepared.anchor, run_id: AGGREGATE_RUN_ID,
    });
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId: AGGREGATE_RUN_ID }));
    const legacyOpen = await errorOf(() => openRunJournal({
      root: journalRoot, store, run_id: AGGREGATE_RUN_ID,
    }));
    assert.equal(legacyOpen.code, 'run_journal_dir_rebound');
    assert.equal(journal.aggregate_binding_digest.startsWith('sha256:'), true);

    const legacyRoot = await makePrivateRoot('r1-r25b-cross-legacy-');
    try {
      await createRunJournal({ root: legacyRoot, store, run_id: AGGREGATE_RUN_ID });
      const aggOpen = await errorOf(() => openAggregateRunJournal({
        root: legacyRoot, anchor: prepared.anchor, run_id: AGGREGATE_RUN_ID,
      }));
      assert.equal(aggOpen.code, 'run_journal_dir_rebound');
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
    }

    const sharedAnchor = await errorOf(() => createAggregateRunJournal({
      root: prepared.root, anchor: prepared.anchor, run_id: AGGREGATE_RUN_ID,
    }));
    assert.equal(sharedAnchor.code, 'run_journal_root_shared');

    const storeAsAnchor = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor: store, run_id: AGGREGATE_RUN_ID,
    }));
    assert.equal(storeAsAnchor.code, 'invalid_type');

    const extra = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor: prepared.anchor, run_id: AGGREGATE_RUN_ID, store,
    }));
    assert.equal(extra.code, 'unknown_key');
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test('selection and direct-plan bindings differ; identical reopen stays idempotent', async () => {
  const selection = await makeResolvedAnchor({ branch: 'selection', runId: 'bridge-select-run' });
  const plan = await makeResolvedAnchor({ branch: 'plan', runId: 'bridge-plan-run' });
  const selectRoot = await makePrivateRoot('r1-r25b-sel-j-');
  const planRoot = await makePrivateRoot('r1-r25b-plan-j-');
  try {
    const selectJournal = await createAggregateRunJournal({
      root: selectRoot, anchor: selection.anchor, run_id: 'bridge-select-run',
    });
    const planJournal = await createAggregateRunJournal({
      root: planRoot, anchor: plan.anchor, run_id: 'bridge-plan-run',
    });
    assert.notEqual(selectJournal.aggregate_binding_digest, planJournal.aggregate_binding_digest);
    const selectAgain = await openAggregateRunJournal({
      root: selectRoot, anchor: selection.anchor, run_id: 'bridge-select-run',
    });
    assert.equal(selectAgain.aggregate_binding_digest, selectJournal.aggregate_binding_digest);
    const exists = await errorOf(() => createAggregateRunJournal({
      root: selectRoot, anchor: selection.anchor, run_id: 'bridge-select-run',
    }));
    assert.equal(exists.code, 'run_journal_already_exists');
  } finally {
    await rm(selection.root, { recursive: true, force: true });
    await rm(plan.root, { recursive: true, force: true });
    await rm(selectRoot, { recursive: true, force: true });
    await rm(planRoot, { recursive: true, force: true });
  }
});

test('cross-process aggregate appends serialize through the existing journal lock', async () => {
  await withAggregateJournal(async ({ journal, journalRoot, root, runId }) => {
    await journal.append({ kind: 'run_opened', data: {} });
    await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
    const workers = ['w0', 'w1', 'w2'].map((prefix) => spawnWorker({
      anchorRoot: root, journalRoot, runId, count: 4, prefix,
    }));
    const results = await Promise.all(workers.map((worker) => worker.done));
    for (const result of results) {
      assert.equal(result.ok, true, `worker failed: ${result.code ?? ''} ${result.message ?? ''}`);
    }
    const createdTotal = results.reduce((sum, result) => sum + result.created, 0);
    const dedupedTotal = results.reduce((sum, result) => sum + result.deduped, 0);
    assert.equal(createdTotal + dedupedTotal, 12);
    const final = await journal.currentState();
    assert.equal(final.revision, 14);
    assert.equal(final.event_counts.child_progress, 12);
  });
});
