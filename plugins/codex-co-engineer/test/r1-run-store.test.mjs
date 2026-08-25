import assert from 'node:assert/strict';
import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import test from 'node:test';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  MAX_RUN_STORE_ENTRIES,
  RUN_STORE_RECORD_SCHEMA_ID,
  openRunStore,
} from '../mcp/v3/run-store.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  RUN_ID,
  makePrivateRoot,
  makeSubmission,
} from './fixtures/r1-run-store-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertFrozenTree(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') assertFrozenTree(child);
    }
  }
}

async function withStore(fn) {
  const root = await makePrivateRoot();
  try {
    const store = await openRunStore(root);
    return await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('openRunStore accepts an existing private root and rejects missing or unsafe roots', async () => {
  const root = await makePrivateRoot();
  try {
    const store = await openRunStore(root);
    assert.equal(store.root, root);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const missing = `${root}-missing`;
  assert.equal((await errorOf(() => openRunStore(missing))).code, 'run_store_root_missing');
  assert.equal((await errorOf(() => openRunStore('relative/store'))).code, 'run_store_path_unsafe');
  assert.equal((await errorOf(() => openRunStore(`${root}/../escape`))).code, 'run_store_path_unsafe');
});

test('submit persists a P06-bound canonical record and reopens it after restart', async () => {
  await withStore(async (root, store) => {
    const input = makeSubmission();
    const first = await store.submit(input);
    assert.equal(first.created, true);
    assert.equal(first.record.schema, RUN_STORE_RECORD_SCHEMA_ID);
    assert.equal(first.record.run_id, RUN_ID);
    assert.equal(first.record.request_idempotency_key, input.request_idempotency_key);
    assert.equal(first.record.identity.digest, input.identity.digest);
    assert.equal(first.record.git.digest, input.git.digest);
    assert.equal(first.record.provenance.run.digest, input.identity.digest);
    assert.match(first.record.canonical_digest, /^sha256:[0-9a-f]{64}$/u);
    assertFrozenTree(first.record);

    const names = await readdir(root);
    assert.ok(names.includes(`${RUN_ID}.json`));
    assert.ok(names.some((name) => name.startsWith('k-')));
    assert.ok(!names.some((name) => name.startsWith('.tmp-')));
    const recordStat = await lstat(`${root}/${RUN_ID}.json`);
    assert.equal(recordStat.isFile(), true);
    assert.equal(recordStat.nlink, 1);
    assert.equal(recordStat.mode & 0o777, 0o600);

    const restarted = await openRunStore(root);
    const loaded = await restarted.getByRunId(RUN_ID);
    assert.equal(loaded.canonical_digest, first.record.canonical_digest);
    assert.equal(canonicalJsonStringify(loaded), canonicalJsonStringify(first.record));
    const byKey = await restarted.getByIdempotencyKey(input.request_idempotency_key);
    assert.equal(byKey.canonical_digest, first.record.canonical_digest);
    const listed = await restarted.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].run_id, RUN_ID);
    assert.equal(listed[0].request_idempotency_key, input.request_idempotency_key);
    assert.equal(listed[0].canonical_digest, first.record.canonical_digest);
    assert.equal(Object.hasOwn(listed[0], 'provenance'), false);
    assert.equal(Object.hasOwn(listed[0], 'telemetry'), false);
  });
});

test('exact same key and canonical body is idempotent and does not mutate the record', async () => {
  await withStore(async (root, store) => {
    const input = makeSubmission();
    const first = await store.submit(input);
    const before = await lstat(`${root}/${RUN_ID}.json`);
    const replay = await store.submit({ ...input });
    assert.equal(replay.created, false);
    assert.equal(replay.record.canonical_digest, first.record.canonical_digest);
    assert.equal(canonicalJsonStringify(replay.record), canonicalJsonStringify(first.record));
    const after = await lstat(`${root}/${RUN_ID}.json`);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ino, before.ino);
  });
});

test('same key with a different body fails closed without mutation', async () => {
  await withStore(async (root, store) => {
    const input = makeSubmission();
    const first = await store.submit(input);
    const conflict = makeSubmission({
      counters: { dispatch_calls: 0, wake_events: 1, outcome_events: 0 },
    });
    assert.equal(conflict.request_idempotency_key, input.request_idempotency_key);
    assert.notEqual(
      canonicalJsonStringify(conflict.provenance),
      canonicalJsonStringify(input.provenance),
    );
    const error = await errorOf(() => store.submit(conflict));
    assert.equal(error.code, 'run_idempotency_conflict');
    const loaded = await store.getByRunId(RUN_ID);
    assert.equal(loaded.canonical_digest, first.record.canonical_digest);
    const names = await readdir(root);
    assert.equal(names.filter((name) => name.endsWith('.json')).length, 1);
  });
});

test('same run with a different key or body fails closed', async () => {
  await withStore(async (_root, store) => {
    const input = makeSubmission();
    await store.submit(input);
    const otherKey = makeSubmission({ attempt: 2 });
    assert.equal(otherKey.run_id, input.run_id);
    assert.notEqual(otherKey.request_idempotency_key, input.request_idempotency_key);
    assert.equal((await errorOf(() => store.submit(otherKey))).code, 'run_identity_conflict');
  });
});

test('mismatched protected identity fails closed before any write', async () => {
  await withStore(async (root, store) => {
    const input = makeSubmission();
    const other = makeSubmission({ runId: 'other-run-identity' });
    const mismatch = {
      ...input,
      identity: other.identity,
    };
    const error = await errorOf(() => store.submit(mismatch));
    assert.equal(error.code, 'run_identity_mismatch');
    assert.deepEqual(await readdir(root), []);
  });
});

test('run id and request key map to the identical stored record', async () => {
  await withStore(async (_root, store) => {
    const input = makeSubmission();
    const created = await store.submit(input);
    const byId = await store.getByRunId(input.run_id);
    const byKey = await store.getByIdempotencyKey(input.request_idempotency_key);
    assert.equal(byId.canonical_digest, created.record.canonical_digest);
    assert.equal(byKey.canonical_digest, created.record.canonical_digest);
    assert.equal(canonicalJsonStringify(byId), canonicalJsonStringify(byKey));
  });
});

test('directory mode 0700 is required and files stay owner-only', async () => {
  const root = await makePrivateRoot();
  try {
    await chmod(root, 0o755);
    assert.equal((await errorOf(() => openRunStore(root))).code, 'run_store_root_unsafe');
    await chmod(root, 0o700);
    const store = await openRunStore(root);
    await store.submit(makeSubmission());
    const stat = await lstat(`${root}/${RUN_ID}.json`);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store enumeration stays bounded and missing lookups fail closed', async () => {
  await withStore(async (_root, store) => {
    assert.equal((await errorOf(() => store.getByRunId(RUN_ID))).code, 'run_store_not_found');
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(await store.submit(makeSubmission({ runId: `run-store-case-${index}` })));
    }
    const listed = await store.list();
    assert.equal(listed.length, 3);
    assert.deepEqual(listed.map((entry) => entry.run_id), [
      'run-store-case-0', 'run-store-case-1', 'run-store-case-2',
    ]);
    assert.equal(created.length <= MAX_RUN_STORE_ENTRIES, true);
  });
});
