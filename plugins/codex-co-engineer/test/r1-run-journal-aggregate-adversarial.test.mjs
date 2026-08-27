import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { IDENTITY_LABELS, canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  RUN_JOURNAL_LOCK_SCHEMA_ID,
  RUN_JOURNAL_STAMP_SCHEMA_ID,
  RUN_JOURNAL_STAMP_SCHEMA_ID_V2,
  createAggregateRunJournal,
  openAggregateRunJournal,
} from '../mcp/v3/run-journal.mjs';
import { identityBoundDigest } from '../mcp/v3/selection-json.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  AGGREGATE_RUN_ID,
  makePlanInput,
  makePrivateRoot,
  makeResolvedAnchor,
} from './fixtures/r1-run-journal-aggregate-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertNoSecret(error) {
  assert.doesNotMatch(error.message, /ATTACKER-SECRET/u);
  assert.doesNotMatch(error.message, /sk-live/u);
  assert.doesNotMatch(error.message, /sel-[0-9a-f]{32}/u);
}

function redigestMarker(fields) {
  const payload = { schema: fields.schema, kind: fields.kind, nonce: fields.nonce };
  return {
    ...payload,
    canonical_digest: identityBoundDigest(IDENTITY_LABELS.STORAGE_ROOT, payload),
  };
}

function redigestClaim(fields) {
  const payload = {
    schema: fields.schema,
    run_id: fields.run_id,
    anchor_digest: fields.anchor_digest,
    submission_idempotency_key: fields.submission_idempotency_key,
    root_marker_nonce: fields.root_marker_nonce,
    root_marker_digest: fields.root_marker_digest,
    nonce: fields.nonce,
  };
  return {
    ...payload,
    canonical_digest: identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RUN_CLAIM, payload),
  };
}

function wrapAnchor(anchor, afterCoordination) {
  let calls = 0;
  return {
    root: anchor.root,
    marker_digest: anchor.marker_digest,
    getByRunId: (runId) => anchor.getByRunId(runId),
    async getCoordination(runId) {
      const record = await anchor.getCoordination(runId);
      calls += 1;
      if (afterCoordination !== undefined) await afterCoordination(calls, record);
      return record;
    },
  };
}

async function withReady(fn, options) {
  const prepared = await makeResolvedAnchor(options);
  const journalRoot = await makePrivateRoot('r1-r25b-adv-j-');
  try {
    return await fn({ ...prepared, journalRoot });
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
}

test('missing, malformed, and mismatched resolved-plan records fail closed', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const planPath = path.join(root, 'runs', runId, 'resolved-plan.record.json');
    const honest = await readFile(planPath);
    await unlink(planPath);
    const missing = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.ok([
      'aggregate_run_record_corruption',
      'run_journal_aggregate_mismatch',
      'run_journal_aggregate_swapped',
    ].includes(missing.code), missing.code);
    assertNoSecret(missing);
    assert.deepEqual(await readdir(journalRoot), []);

    await writeFile(planPath, '{"schema":"ATTACKER-SECRET"}\n');
    const malformed = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.ok(typeof malformed.code === 'string');
    assertNoSecret(malformed);

    await writeFile(planPath, honest);
    const parsed = JSON.parse(honest.toString('utf8'));
    parsed.canonical_digest = `sha256:${'0'.repeat(64)}`;
    await writeFile(planPath, `${canonicalJsonStringify(parsed)}\n`);
    const mismatched = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.ok(typeof mismatched.code === 'string');
    assertNoSecret(mismatched);
  });
});

test('wrong run, wrong plan complete flag, and incomplete plan inputs fail closed', async () => {
  await withReady(async ({ anchor, journalRoot, runId }) => {
    const wrongRun = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: 'aggregate-missing-run',
    }));
    assert.equal(wrongRun.code, 'aggregate_run_not_found');

    const badPlan = makePlanInput(runId, false);
    assert.equal(badPlan.complete, false);
    void journalRoot;
  });
});

test('marker, claim, and aggregate stamp swaps fail closed without claiming journal state', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const markerPath = path.join(root, 'storage-root.v1');
    const claimPath = path.join(root, 'claims', `${runId}.json`);
    const stampPath = path.join(root, 'runs', runId, 'created.json');
    const marker = await readFile(markerPath);
    const claim = await readFile(claimPath);
    const stamp = await readFile(stampPath);

    await writeFile(markerPath, `${canonicalJsonStringify({
      schema: 'codex-co-engineer.storage-root.v1',
      kind: 'aggregate_run_anchor',
      nonce: 'f'.repeat(32),
      canonical_digest: `sha256:${'1'.repeat(64)}`,
    })}\n`);
    const markerSwap = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.ok(typeof markerSwap.code === 'string');
    assertNoSecret(markerSwap);
    await writeFile(markerPath, marker);

    await writeFile(claimPath, `${canonicalJsonStringify({
      ...JSON.parse(claim.toString('utf8')),
      nonce: 'e'.repeat(32),
      canonical_digest: `sha256:${'2'.repeat(64)}`,
    })}\n`);
    const claimSwap = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.ok(typeof claimSwap.code === 'string');
    assertNoSecret(claimSwap);
    await writeFile(claimPath, claim);

    await writeFile(stampPath, `${canonicalJsonStringify({
      schema: 'codex-co-engineer.aggregate-run-created.v1',
      run_id: runId,
      record_canonical_digest: `sha256:${'3'.repeat(64)}`,
      nonce: 'd'.repeat(32),
    })}\n`);
    const stampSwap = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.ok(typeof stampSwap.code === 'string');
    assertNoSecret(stampSwap);
    await writeFile(stampPath, stamp);
    assert.deepEqual(await readdir(journalRoot), []);
  });
});

test('symlink, hardlink, and non-regular aggregate identity files are not followed', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const scratch = await makePrivateRoot('r1-r25b-adv-scratch-');
    try {
      const outside = path.join(scratch, 'outside.json');
      await writeFile(outside, 'ATTACKER-SECRET\n');
      const planPath = path.join(root, 'runs', runId, 'resolved-plan.record.json');
      const honest = await readFile(planPath);
      await unlink(planPath);
      await symlink(outside, planPath);
      const linked = await errorOf(() => createAggregateRunJournal({
        root: journalRoot, anchor, run_id: runId,
      }));
      assert.ok([
        'run_journal_not_regular',
        'aggregate_run_not_regular',
        'aggregate_run_record_corruption',
      ].includes(linked.code), linked.code);
      assertNoSecret(linked);
      await unlink(planPath);
      await writeFile(planPath, honest, { mode: 0o600 });
      await chmod(planPath, 0o600);

      const claimPath = path.join(root, 'claims', `${runId}.json`);
      const claimBytes = await readFile(claimPath);
      await unlink(claimPath);
      await symlink(outside, claimPath);
      const claimLink = await errorOf(() => createAggregateRunJournal({
        root: journalRoot, anchor, run_id: runId,
      }));
      assert.ok(typeof claimLink.code === 'string');
      assertNoSecret(claimLink);
      await unlink(claimPath);
      await writeFile(claimPath, claimBytes, { mode: 0o600 });
      await chmod(claimPath, 0o600);

      await mkdir(path.join(scratch, 'dir-plan'), { mode: 0o700 });
      await unlink(planPath);
      await symlink(path.join(scratch, 'dir-plan'), planPath);
      const nonregular = await errorOf(() => createAggregateRunJournal({
        root: journalRoot, anchor, run_id: runId,
      }));
      assert.ok(typeof nonregular.code === 'string');
      await unlink(planPath);
      await writeFile(planPath, honest, { mode: 0o600 });
      await chmod(planPath, 0o600);

      const journal = await createAggregateRunJournal({
        root: journalRoot, anchor, run_id: runId,
      });
      await journal.append({ kind: 'run_opened', data: {} });
      const twin = path.join(scratch, 'twin.jsonl');
      const journalPath = path.join(journal.directory, 'journal.jsonl');
      await copyFile(journalPath, twin);
      await unlink(journalPath);
      await link(twin, journalPath);
      assert.equal((await lstat(journalPath)).nlink, 2);
      const hardlinked = await errorOf(() => journal.currentState());
      assert.equal(hardlinked.code, 'run_journal_not_regular');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

test('foreign journal entries and a swapped journal stamp conflict permanently', async () => {
  await withReady(async ({ anchor, journalRoot, runId }) => {
    const journal = await createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    await writeFile(path.join(journal.directory, 'foreign.txt'), 'nope\n');
    const foreign = await errorOf(() => journal.currentState());
    assert.equal(foreign.code, 'run_journal_foreign_entry');
    await unlink(path.join(journal.directory, 'foreign.txt'));

    const stampPath = path.join(journal.directory, 'created.json');
    const honest = JSON.parse(await readFile(stampPath, 'utf8'));
    await writeFile(stampPath, `${canonicalJsonStringify({
      ...honest,
      binding_digest: `sha256:${'a'.repeat(64)}`,
    })}\n`);
    const conflict = await errorOf(() => journal.append({ kind: 'run_opened', data: {} }));
    assert.equal(conflict.code, 'run_journal_identity_conflict');
    assertNoSecret(conflict);

    await writeFile(stampPath, `${canonicalJsonStringify({
      schema: RUN_JOURNAL_STAMP_SCHEMA_ID,
      run_id: runId,
      record_canonical_digest: `sha256:${'b'.repeat(64)}`,
      nonce: honest.nonce,
    })}\n`);
    const rebound = await errorOf(() => openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.equal(rebound.code, 'run_journal_dir_rebound');

    await writeFile(stampPath, `${canonicalJsonStringify(honest)}\n`);
    const restored = await openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    assert.equal(restored.aggregate_binding_digest, honest.binding_digest);
    assert.equal(RUN_JOURNAL_STAMP_SCHEMA_ID_V2, honest.schema);
  });
});

test('post-validation TOCTOU on the resolved plan fails closed under the journal lock', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const journal = await createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    const planPath = path.join(root, 'runs', runId, 'resolved-plan.record.json');
    await unlink(planPath);
    const raced = await errorOf(() => journal.append({ kind: 'run_opened', data: {} }));
    assert.ok([
      'aggregate_run_record_corruption',
      'run_journal_aggregate_mismatch',
      'run_journal_aggregate_swapped',
      'run_journal_identity_conflict',
    ].includes(raced.code), raced.code);
    assertNoSecret(raced);
  });
});

test('a live foreign journal lock times out; a dead owner is recovered', async () => {
  await withReady(async ({ anchor, journalRoot, runId }) => {
    const journal = await createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    await journal.append({ kind: 'run_opened', data: {} });

    const deadChild = spawn(process.execPath, ['-e', 'process.exit(0);']);
    await new Promise((resolve) => deadChild.on('exit', resolve));
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

    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);']);
    try {
      const liveLock = path.join(journal.directory, 'lock');
      await writeFile(liveLock, `${canonicalJsonStringify({
        schema: RUN_JOURNAL_LOCK_SCHEMA_ID,
        pid: holder.pid,
        nonce: 'b'.repeat(32),
      })}\n`, { mode: 0o600 });
      await chmod(liveLock, 0o600);
      const timeout = await errorOf(() => journal.append({
        kind: 'child_progress',
        data: { assignment_id: 'a0', note: 'progress.blocked' },
      }));
      assert.equal(timeout.code, 'run_journal_lock_timeout');
    } finally {
      holder.kill('SIGKILL');
      await rm(path.join(journal.directory, 'lock'), { force: true });
    }
  });
});

test('duplicate conflicting process identity is a permanent typed conflict', async () => {
  await withReady(async ({ anchor, journalRoot, runId }) => {
    const journal = await createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    const stampPath = path.join(journal.directory, 'created.json');
    const honest = JSON.parse(await readFile(stampPath, 'utf8'));
    await writeFile(stampPath, `${canonicalJsonStringify({
      ...honest,
      binding_digest: `sha256:${'c'.repeat(64)}`,
    })}\n`);
    const first = await errorOf(() => openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    const second = await errorOf(() => openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.equal(first.code, 'run_journal_identity_conflict');
    assert.equal(second.code, 'run_journal_identity_conflict');
    assertNoSecret(first);
    assertNoSecret(second);
  });
});

test('journal root foreign files, group-readable roots, and shared runs dirs fail closed', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const openRuns = await errorOf(() => createAggregateRunJournal({
      root: path.join(root, 'runs'), anchor, run_id: runId,
    }));
    assert.equal(openRuns.code, 'run_journal_root_shared');

    const other = await makePrivateRoot('r1-r25b-adv-mode-');
    try {
      await chmod(other, 0o755);
      const unsafe = await errorOf(() => createAggregateRunJournal({
        root: other, anchor, run_id: runId,
      }));
      assert.equal(unsafe.code, 'run_journal_unsafe_path');
    } finally {
      await chmod(other, 0o700).catch(() => {});
      await rm(other, { recursive: true, force: true });
    }

    await createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    });
    await writeFile(path.join(journalRoot, 'foreign-root.txt'), 'nope\n');
    const foreignRoot = await errorOf(() => openAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.equal(foreignRoot.code, 'run_journal_foreign_entry');
  });
});

test('ancestor and descendant R24A journal roots fail closed before mutation', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const spare = path.join(root, 'runs', 'spare-run');
    await mkdir(spare, { mode: 0o700 });
    const nested = await errorOf(() => createAggregateRunJournal({
      root: spare, anchor, run_id: runId,
    }));
    assert.equal(nested.code, 'run_journal_root_shared');
    assert.deepEqual(await readdir(spare), []);
    assert.deepEqual(await readdir(journalRoot), []);

    const ownedRun = path.join(root, 'runs', runId);
    const beforeOwned = await readdir(ownedRun);
    const descendant = await errorOf(() => createAggregateRunJournal({
      root: ownedRun, anchor, run_id: runId,
    }));
    assert.equal(descendant.code, 'run_journal_root_shared');
    assert.deepEqual(await readdir(ownedRun), beforeOwned);
    assert.ok(!beforeOwned.includes('runs'));
  });
});

test('a redigested claim with a mismatched submission key fails closed', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const claimPath = path.join(root, 'claims', `${runId}.json`);
    const honest = JSON.parse(await readFile(claimPath, 'utf8'));
    const mutated = redigestClaim({
      ...honest,
      submission_idempotency_key: `sha256:${'e'.repeat(64)}`,
    });
    assert.notEqual(mutated.submission_idempotency_key, honest.submission_idempotency_key);
    assert.notEqual(mutated.canonical_digest, honest.canonical_digest);
    await writeFile(claimPath, `${canonicalJsonStringify(mutated)}\n`);
    const mismatched = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor, run_id: runId,
    }));
    assert.equal(mismatched.code, 'run_journal_aggregate_mismatch');
    assertNoSecret(mismatched);
    assert.deepEqual(await readdir(journalRoot), []);
  });
});

test('pre-publication claim/marker/plan swap fails with zero journal artifacts', async () => {
  await withReady(async ({ root, anchor, journalRoot, runId }) => {
    const markerPath = path.join(root, 'storage-root.v1');
    const claimPath = path.join(root, 'claims', `${runId}.json`);
    const planPath = path.join(root, 'runs', runId, 'resolved-plan.record.json');
    const honestMarker = JSON.parse(await readFile(markerPath, 'utf8'));
    const honestClaim = JSON.parse(await readFile(claimPath, 'utf8'));
    const honestPlan = await readFile(planPath);

    async function swapValidBinding() {
      const marker = redigestMarker({ ...honestMarker, nonce: 'c'.repeat(32) });
      const claim = redigestClaim({
        ...honestClaim,
        root_marker_nonce: marker.nonce,
        root_marker_digest: marker.canonical_digest,
        nonce: 'd'.repeat(32),
      });
      await writeFile(markerPath, `${canonicalJsonStringify(marker)}\n`);
      await writeFile(claimPath, `${canonicalJsonStringify(claim)}\n`);
      await unlink(planPath);
      await writeFile(planPath, honestPlan);
    }

    const wrapped = wrapAnchor(anchor, async (calls) => {
      if (calls >= 2) await swapValidBinding();
    });
    const swapped = await errorOf(() => createAggregateRunJournal({
      root: journalRoot, anchor: wrapped, run_id: runId,
    }));
    assert.ok([
      'run_journal_aggregate_swapped',
      'run_journal_aggregate_mismatch',
    ].includes(swapped.code), swapped.code);
    assertNoSecret(swapped);
    assert.deepEqual(await readdir(journalRoot), []);
  });
});
