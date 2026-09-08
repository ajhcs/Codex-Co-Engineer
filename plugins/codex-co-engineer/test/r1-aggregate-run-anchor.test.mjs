import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  AGGREGATE_RUN_ANCHOR_SCHEMA_ID,
  AGGREGATE_STORAGE_ROOT_KIND,
  MAX_AGGREGATE_TEMPORARIES,
  STORAGE_ROOT_SCHEMA_ID,
  initializeAggregateRunAnchorRoot,
  openAggregateRunAnchor,
} from '../mcp/v3/aggregate-run-anchor.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { createRunJournal } from '../mcp/v3/run-journal.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { openRunStore } from '../mcp/v3/run-store.mjs';
import {
  AGGREGATE_RUN_ID,
  defaultAnswers,
  makePlanInput,
  makePrivateRoot,
  makeReplyInput,
  makeSelectionRequest,
  makeSubmitInput,
} from './fixtures/r1-aggregate-run-anchor-fixtures.mjs';
import { makeSubmission } from './fixtures/r1-run-store-fixtures.mjs';

const WORKER = new URL('./fixtures/r1-aggregate-run-anchor-worker.mjs', import.meta.url).pathname;

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

async function withAnchor(fn, options = {}) {
  const root = await makePrivateRoot();
  try {
    const store = await initializeAggregateRunAnchorRoot(root);
    return await fn(root, store, options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function spawnWorker({ root, mode, runId = AGGREGATE_RUN_ID, assignmentCount = 1 }) {
  const child = spawn(process.execPath, [WORKER, root, mode, runId, String(assignmentCount)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    let finished = false;
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
    child.on('close', () => {
      if (finished) return;
      finished = true;
      resolve();
    });
  });
  const done = closed.then(() => {
    const lines = stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `worker must print exactly one JSON line (${stderr.trim()})`);
    assert.ok(lines[0].length <= 4096, 'worker JSON line exceeds the bounded length');
    return JSON.parse(lines[0]);
  });
  return { done, closed, child };
}

async function waitWorkers(workers) {
  const settled = await Promise.allSettled(workers.map((worker) => worker.done));
  await Promise.all(workers.map((worker) => worker.closed.catch(() => {})));
  const results = [];
  for (const item of settled) {
    if (item.status === 'rejected') throw item.reason;
    results.push(item.value);
  }
  return results;
}

test('initialize publishes an owner-only marker and open rejects unmarked empty roots', async () => {
  const root = await makePrivateRoot();
  try {
    assert.equal((await errorOf(() => openAggregateRunAnchor(root))).code,
      'aggregate_run_root_uninitialized');
    const store = await initializeAggregateRunAnchorRoot(root);
    assert.equal(store.root, root);
    assert.match(store.marker_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(typeof store.cas, 'undefined');
    const names = await readdir(root);
    assert.deepEqual(names.sort(), ['claims', 'runs', 'storage-root.v1']);
    const marker = JSON.parse((await readFile(path.join(root, 'storage-root.v1'), 'utf8')).trim());
    assert.equal(marker.schema, STORAGE_ROOT_SCHEMA_ID);
    assert.equal(marker.kind, AGGREGATE_STORAGE_ROOT_KIND);
    const stat = await lstat(path.join(root, 'storage-root.v1'));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    const claimsStat = await lstat(path.join(root, 'claims'));
    assert.equal(claimsStat.isDirectory(), true);
    assert.equal(claimsStat.mode & 0o777, 0o700);
    const reopened = await openAggregateRunAnchor(root);
    assert.equal(reopened.marker_digest, store.marker_digest);
    assert.equal((await errorOf(() => initializeAggregateRunAnchorRoot(root))).code,
      'aggregate_run_root_foreign');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('root audit tolerates the declared bounded lock-owner temporary allowance', async () => {
  const root = await makePrivateRoot();
  try {
    await initializeAggregateRunAnchorRoot(root);
    await writeFile(path.join(root, 'lock'), '{}\n', { mode: 0o600 });
    for (let index = 0; index < MAX_AGGREGATE_TEMPORARIES; index += 1) {
      await writeFile(path.join(root, `.lock-${index.toString(16).padStart(32, '0')}`), '{}\n', { mode: 0o600 });
    }
    const reopened = await openAggregateRunAnchor(root);
    assert.equal(reopened.root, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('submit persists 1- and 8-assignment identities and exact retry is idempotent', async () => {
  await withAnchor(async (root, store) => {
    const one = makeSubmitInput({ assignmentCount: 1 });
    const first = await store.submit(one);
    assert.equal(first.created, true);
    assert.equal(first.record.schema, AGGREGATE_RUN_ANCHOR_SCHEMA_ID);
    assert.equal(first.record.run_id, AGGREGATE_RUN_ID);
    assert.equal(first.coordination.phase, 'submitted');
    assert.equal(first.coordination.revision, 0);
    assertFrozenTree(first);
    const claimStat = await lstat(path.join(root, 'claims', `${AGGREGATE_RUN_ID}.json`));
    const runStat = await lstat(path.join(root, 'runs', AGGREGATE_RUN_ID));
    assert.equal(claimStat.isFile(), true);
    assert.equal(claimStat.nlink, 1);
    assert.equal(runStat.isDirectory(), true);
    const replay = await store.submit({ ...one });
    assert.equal(replay.created, false);
    assert.equal(replay.record.canonical_digest, first.record.canonical_digest);
    assert.equal(canonicalJsonStringify(replay.record), canonicalJsonStringify(first.record));
    const afterClaim = await lstat(path.join(root, 'claims', `${AGGREGATE_RUN_ID}.json`));
    assert.equal(afterClaim.ino, claimStat.ino);
    const claim = JSON.parse((await readFile(path.join(root, 'claims', `${AGGREGATE_RUN_ID}.json`), 'utf8')).trim());
    const stamp = JSON.parse((await readFile(path.join(root, 'runs', AGGREGATE_RUN_ID, 'created.json'), 'utf8')).trim());
    assert.equal(stamp.nonce, claim.nonce);
    assert.equal(stamp.record_canonical_digest, first.record.canonical_digest);

    const eight = makeSubmitInput({ runId: 'aggregate-eight-lane-run', assignmentCount: 8 });
    const createdEight = await store.submit(eight);
    assert.equal(createdEight.created, true);
    assert.notEqual(createdEight.record.canonical_digest, first.record.canonical_digest);
    assert.equal(createdEight.record.run_id, 'aggregate-eight-lane-run');
    assert.equal(eight.identity.manifest_digest !== one.identity.manifest_digest, true);
    const restarted = await openAggregateRunAnchor(root);
    const loaded = await restarted.getByRunId(AGGREGATE_RUN_ID);
    assert.equal(loaded.canonical_digest, first.record.canonical_digest);
    const coord = await restarted.getCoordination(AGGREGATE_RUN_ID);
    assert.equal(coord.phase, 'submitted');
    assert.equal(coord.revision, 0);
  });
});

test('P05 selection identity commits through the absorbing lattice and identical retries', async () => {
  await withAnchor(async (_root, store) => {
    const input = makeSubmitInput();
    await store.submit(input);
    const selection = makeSelectionRequest();
    assert.match(selection.identity.request_id, /^sel-[0-9a-f]{32}$/u);
    const requested = await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    assert.equal(requested.created, true);
    assert.equal(requested.coordination.phase, 'awaiting_selection');
    assert.equal(requested.coordination.revision, 1);
    assert.equal(requested.coordination.selection_request_binding.request_id, selection.identity.request_id);
    assert.equal(requested.coordination.selection_request_binding.digest, selection.identity.digest);
    const replayRequest = await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    assert.equal(replayRequest.created, false);
    assert.equal(replayRequest.coordination.state_digest, requested.coordination.state_digest);

    const resolved = await store.commitSelectionResolution({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 1,
      request_identity: selection.identity,
      reply_record: makeReplyInput(
        AGGREGATE_RUN_ID,
        selection.identity.request_id,
        defaultAnswers(1),
      ),
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    assert.equal(resolved.created, true);
    assert.equal(resolved.coordination.phase, 'resolution_ready');
    assert.equal(resolved.coordination.revision, 2);
    const replayResolved = await store.commitSelectionResolution({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 1,
      request_identity: selection.identity,
      reply_record: makeReplyInput(
        AGGREGATE_RUN_ID,
        selection.identity.request_id,
        defaultAnswers(1),
      ),
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    assert.equal(replayResolved.created, false);
    assert.equal(replayResolved.coordination.state_digest, resolved.coordination.state_digest);
  });
});

test('submitted@0 can absorb directly into resolution_ready@1 for a complete plan', async () => {
  await withAnchor(async (_root, store) => {
    await store.submit(makeSubmitInput());
    const first = await store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    assert.equal(first.created, true);
    assert.equal(first.coordination.phase, 'resolution_ready');
    assert.equal(first.coordination.revision, 1);
    assert.equal(first.coordination.selection_request_binding, null);
    const replay = await store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    assert.equal(replay.created, false);
    assert.equal((await errorOf(() => store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: makeSelectionRequest().identity,
      record: makeSelectionRequest().record,
    }))).code, 'aggregate_run_revision_conflict');
  });
});

test('root-kind reverse separation with P24 and P25 fails closed without writes', async () => {
  const p24 = await makePrivateRoot('r1-r24a-p24-');
  const p25 = await makePrivateRoot('r1-r24a-p25-');
  const r24a = await makePrivateRoot('r1-r24a-own-');
  try {
    const store = await openRunStore(p24);
    await store.submit(makeSubmission());
    const beforeP24 = (await readdir(p24)).sort();
    assert.equal((await errorOf(() => initializeAggregateRunAnchorRoot(p24))).code,
      'aggregate_run_root_shared');
    assert.equal((await errorOf(() => openAggregateRunAnchor(p24))).code,
      'aggregate_run_root_shared');
    assert.deepEqual((await readdir(p24)).sort(), beforeP24);

    await store.submit(makeSubmission({ runId: 'run-journal-bind' }));
    await createRunJournal({ root: p25, store, run_id: 'run-journal-bind' });
    const beforeP25 = (await readdir(p25)).sort();
    assert.equal((await errorOf(() => initializeAggregateRunAnchorRoot(p25))).code,
      'aggregate_run_root_shared');
    assert.equal((await errorOf(() => openAggregateRunAnchor(p25))).code,
      'aggregate_run_root_shared');
    assert.deepEqual((await readdir(p25)).sort(), beforeP25);

    const anchor = await initializeAggregateRunAnchorRoot(r24a);
    await anchor.submit(makeSubmitInput());
    const beforeR24a = (await readdir(r24a)).sort();
    const p24OnR24a = await errorOf(() => openRunStore(r24a));
    assert.ok(['run_store_foreign_entry', 'run_store_root_unsafe', 'run_store_not_regular']
      .includes(p24OnR24a.code), p24OnR24a.code);
    const p25OnR24a = await errorOf(() => createRunJournal({
      root: r24a, store, run_id: 'run-journal-bind',
    }));
    assert.ok(typeof p25OnR24a.code === 'string' && p25OnR24a.code.startsWith('run_'));
    assert.deepEqual((await readdir(r24a)).sort(), beforeR24a);
  } finally {
    await rm(p24, { recursive: true, force: true });
    await rm(p25, { recursive: true, force: true });
    await rm(r24a, { recursive: true, force: true });
  }
});

test('exact claim recovers the same identity; empty dir without claim is never adopted', async () => {
  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    const first = await store.submit(input);
    const claimPath = path.join(root, 'claims', `${AGGREGATE_RUN_ID}.json`);
    const claimBytes = await readFile(claimPath);
    await rm(path.join(root, 'runs', AGGREGATE_RUN_ID), { recursive: true, force: true });
    const recovered = await store.submit(input);
    assert.equal(recovered.record.canonical_digest, first.record.canonical_digest);
    assert.equal((await readFile(claimPath)).equals(claimBytes), true);

    const foreignId = 'aggregate-empty-dir-run';
    await mkdir(path.join(root, 'runs', foreignId), { mode: 0o700 });
    await chmod(path.join(root, 'runs', foreignId), 0o700);
    const emptyError = await errorOf(() => store.submit(makeSubmitInput({ runId: foreignId })));
    assert.equal(emptyError.code, 'aggregate_run_claim_conflict');
    assert.equal((await readdir(path.join(root, 'claims'))).includes(`${foreignId}.json`), false);
  });
});

test('exact claim resumes empty, anchor, and initial-coordination prefixes', async () => {
  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    const first = await store.submit(input);
    const runDir = path.join(root, 'runs', AGGREGATE_RUN_ID);
    const claimPath = path.join(root, 'claims', `${AGGREGATE_RUN_ID}.json`);
    const claimBytes = await readFile(claimPath);
    const claim = JSON.parse(claimBytes.toString('utf8').trim());

    await rm(path.join(runDir, 'anchor.json'));
    await rm(path.join(runDir, 'coordination.json'));
    await rm(path.join(runDir, 'created.json'));
    assert.deepEqual((await readdir(runDir)).filter((name) => !name.startsWith('.')), []);
    const empty = await store.submit(input);
    assert.equal(empty.record.canonical_digest, first.record.canonical_digest);
    assert.equal(empty.coordination.phase, 'submitted');
    assert.equal((await store.getByRunId(AGGREGATE_RUN_ID)).canonical_digest, first.record.canonical_digest);
    const emptyStamp = JSON.parse((await readFile(path.join(runDir, 'created.json'), 'utf8')).trim());
    assert.equal(emptyStamp.nonce, claim.nonce);

    await rm(path.join(runDir, 'coordination.json'));
    await rm(path.join(runDir, 'created.json'));
    const anchored = await store.submit(input);
    assert.equal(anchored.record.canonical_digest, first.record.canonical_digest);
    assert.equal((await store.getCoordination(AGGREGATE_RUN_ID)).phase, 'submitted');
    assert.equal((await readFile(claimPath)).equals(claimBytes), true);

    await rm(path.join(runDir, 'created.json'));
    const resumed = await store.submit(input);
    assert.equal(resumed.record.canonical_digest, first.record.canonical_digest);
    const loaded = await store.getByRunId(AGGREGATE_RUN_ID);
    assert.equal(loaded.canonical_digest, first.record.canonical_digest);
    const stamp = JSON.parse((await readFile(path.join(runDir, 'created.json'), 'utf8')).trim());
    assert.equal(stamp.nonce, claim.nonce);
    assert.equal(stamp.record_canonical_digest, first.record.canonical_digest);
  });
});

test('valid alternate stamp nonce substitution fails get, submit, and mutation', async () => {
  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    const first = await store.submit(input);
    const stampPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'created.json');
    const stampBytes = await readFile(stampPath);
    const stamp = JSON.parse(stampBytes.toString('utf8').trim());
    const alternate = stamp.nonce === 'ab'.repeat(16) ? 'cd'.repeat(16) : 'ab'.repeat(16);
    stamp.nonce = alternate;
    await writeFile(stampPath, `${canonicalJsonStringify(stamp)}\n`, { mode: 0o600 });
    await chmod(stampPath, 0o600);

    assert.equal((await errorOf(() => store.getByRunId(AGGREGATE_RUN_ID))).code,
      'aggregate_run_dir_swapped');
    assert.equal((await errorOf(() => store.getCoordination(AGGREGATE_RUN_ID))).code,
      'aggregate_run_dir_swapped');
    const replay = await errorOf(() => store.submit(input));
    assert.equal(replay.code, 'aggregate_run_dir_swapped');
    assert.notEqual(replay.code, undefined);
    assert.equal((await errorOf(() => store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    }))).code, 'aggregate_run_dir_swapped');
    assert.equal((await readFile(stampPath)).equals(Buffer.from(`${canonicalJsonStringify(stamp)}\n`)), true);
    assert.equal(first.created, true);
  });
});

test('cross-process 13/13 submit and mutation keep one winner without ENOTEMPTY or hang', {
  timeout: 60_000,
}, async () => {
  await withAnchor(async (root) => {
    const submits = Array.from({ length: 13 }, () => spawnWorker({ root, mode: 'submit' }));
    const submitResults = await waitWorkers(submits);
    const created = submitResults.filter((result) => result.ok && result.created);
    const idempotent = submitResults.filter((result) => result.ok && result.created === false);
    assert.equal(created.length, 1, JSON.stringify(submitResults));
    assert.equal(created.length + idempotent.length, 13);
    for (const result of submitResults) {
      assert.equal(result.ok, true, result.code);
      assert.notEqual(result.code, 'ENOTEMPTY');
    }
    const claimNames = (await readdir(path.join(root, 'claims')))
      .filter((name) => name.endsWith('.json'));
    assert.equal(claimNames.length, 1);
    const runNames = (await readdir(path.join(root, 'runs')))
      .filter((name) => !name.startsWith('.'));
    assert.equal(runNames.length, 1);

    const mutations = Array.from({ length: 13 }, () => spawnWorker({ root, mode: 'plan' }));
    const mutationResults = await waitWorkers(mutations);
    const mutationCreated = mutationResults.filter((result) => result.ok && result.created);
    const mutationReplay = mutationResults.filter((result) => result.ok && result.created === false);
    assert.equal(mutationCreated.length, 1, JSON.stringify(mutationResults));
    assert.equal(mutationCreated.length + mutationReplay.length, 13, JSON.stringify(mutationResults));
    for (const result of mutationResults) {
      assert.equal(result.ok, true, result.code);
      assert.notEqual(result.code, 'ENOTEMPTY');
    }
    const store = await openAggregateRunAnchor(root);
    const coord = await store.getCoordination(AGGREGATE_RUN_ID);
    assert.equal(coord.phase, 'resolution_ready');
    assert.equal(coord.revision, 1);
  });
});

test('conflicting cross-process submits keep the winner paths', { timeout: 60_000 }, async () => {
  await withAnchor(async (root) => {
    const first = spawnWorker({ root, mode: 'submit', runId: AGGREGATE_RUN_ID, assignmentCount: 1 });
    await waitWorkers([first]);
    const conflicts = Array.from({ length: 8 }, () => spawnWorker({
      root, mode: 'submit', runId: AGGREGATE_RUN_ID, assignmentCount: 8,
    }));
    const results = await waitWorkers(conflicts);
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.ok(result.code === 'aggregate_run_identity_conflict'
        || result.code === 'aggregate_run_idempotency_conflict', result.code);
      assert.notEqual(result.code, 'ENOTEMPTY');
    }
    const claims = await readdir(path.join(root, 'claims'));
    assert.equal(claims.filter((name) => name.endsWith('.json')).length, 1);
    const store = await openAggregateRunAnchor(root);
    const loaded = await store.getByRunId(AGGREGATE_RUN_ID);
    const expected = makeSubmitInput({ assignmentCount: 1 });
    assert.equal(loaded.run_id, expected.run_id);
  });
});
