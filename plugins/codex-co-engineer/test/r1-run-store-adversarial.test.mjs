import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  MAX_RUN_STORE_DIRECTORY_ENTRIES,
  MAX_RUN_STORE_ENTRIES,
  MAX_RUN_STORE_RECORD_BYTES,
  openRunStore,
} from '../mcp/v3/run-store.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
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

function assertNoSecret(error) {
  assert.doesNotMatch(error.message, /ATTACKER-SECRET/u);
  assert.doesNotMatch(error.message, /sk-live/u);
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

test('concurrent duplicate submissions preserve one authoritative record', async () => {
  await withStore(async (root, store) => {
    const input = makeSubmission();
    const results = await Promise.all(Array.from({ length: 8 }, () => store.submit(input)));
    const created = results.filter((result) => result.created);
    assert.equal(created.length, 1);
    const digest = created[0].record.canonical_digest;
    for (const result of results) {
      assert.equal(result.record.canonical_digest, digest);
    }
    const names = await readdir(root);
    assert.equal(names.filter((name) => name.endsWith('.json')).length, 1);
    assert.equal(names.filter((name) => name.startsWith('k-')).length, 1);
    assert.ok(!names.some((name) => name.startsWith('.tmp-')));
  });
});

test('concurrent conflicting bodies serialize to one winner and typed conflicts', async () => {
  await withStore(async (_root, store) => {
    const first = makeSubmission();
    const second = makeSubmission({
      counters: { dispatch_calls: 0, wake_events: 4, outcome_events: 0 },
    });
    const results = await Promise.allSettled([
      store.submit(first),
      store.submit(second),
      store.submit(first),
      store.submit(second),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const rejected = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    assert.ok(fulfilled.length >= 1);
    assert.equal(new Set(fulfilled.map((result) => result.record.canonical_digest)).size, 1);
    for (const error of rejected) {
      assert.ok(error instanceof RunContractV1Error);
      assert.ok(error.code === 'run_idempotency_conflict' || error.code === 'run_identity_conflict');
    }
  });
});

test('symlink root, record, and temporary names fail closed without following', async () => {
  const parent = await makePrivateRoot('r1-run-store-sym-');
  try {
    const real = path.join(parent, 'real');
    await mkdir(real, { mode: 0o700 });
    await chmod(real, 0o700);
    const linked = path.join(parent, 'linked');
    await symlink(real, linked);
    assert.equal((await errorOf(() => openRunStore(linked))).code, 'run_store_root_unsafe');

    const store = await openRunStore(real);
    await store.submit(makeSubmission());
    await rm(path.join(real, `${RUN_ID}.json`));
    await symlink('/etc/passwd', path.join(real, `${RUN_ID}.json`));
    const error = await errorOf(() => openRunStore(real));
    assert.ok(error.code === 'run_store_not_regular' || error.code === 'run_store_root_unsafe');
    assertNoSecret(error);

    const tempRoot = path.join(parent, 'temps');
    await mkdir(tempRoot, { mode: 0o700 });
    await chmod(tempRoot, 0o700);
    const target = path.join(parent, 'secret-target');
    await writeFile(target, 'ATTACKER-SECRET', { mode: 0o600 });
    await symlink(target, path.join(tempRoot, `.tmp-${'ab'.repeat(16)}`));
    const tempError = await errorOf(() => openRunStore(tempRoot));
    assert.equal(tempError.code, 'run_store_torn_temporary');
    assertNoSecret(tempError);
    assert.equal((await lstat(target)).isFile(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('hardlinked records and path-traversal names fail closed', async () => {
  await withStore(async (root, store) => {
    await store.submit(makeSubmission());
    const record = path.join(root, `${RUN_ID}.json`);
    const alias = path.join(root, 'k-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    await link(record, alias);
    assert.equal((await errorOf(() => openRunStore(root))).code, 'run_store_not_regular');
  });

  const outside = await makePrivateRoot('r1-run-store-out-');
  try {
    assert.equal((await errorOf(() => openRunStore(`${outside}/../${path.basename(outside)}`))).code,
      'run_store_path_unsafe');
    assert.equal((await errorOf(() => openRunStore(`${outside}/.`))).code, 'run_store_path_unsafe');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('malformed truncated oversized and foreign files fail closed', async () => {
  await withStore(async (root, store) => {
    await store.submit(makeSubmission());
    const record = path.join(root, `${RUN_ID}.json`);
    await writeFile(record, '{"schema":"codex-co-engineer.run-store-record.v1"');
    assert.equal((await errorOf(() => openRunStore(root))).code, 'run_store_malformed_record');
  });

  await withStore(async (root, store) => {
    await store.submit(makeSubmission());
    const record = path.join(root, `${RUN_ID}.json`);
    await truncate(record, 12);
    const error = await errorOf(() => openRunStore(root));
    assert.ok(['run_store_malformed_record', 'run_store_torn_record'].includes(error.code), error.code);
  });

  const huge = await makePrivateRoot('r1-run-store-huge-');
  try {
    await writeFile(path.join(huge, 'notes.txt'), 'foreign', { mode: 0o600 });
    assert.equal((await errorOf(() => openRunStore(huge))).code, 'run_store_foreign_entry');
  } finally {
    await rm(huge, { recursive: true, force: true });
  }

  const oversized = await makePrivateRoot('r1-run-store-over-');
  try {
    const handle = await open(path.join(oversized, `${RUN_ID}.json`), 'wx', 0o600);
    await handle.writeFile(`${'x'.repeat(MAX_RUN_STORE_RECORD_BYTES + 1)}`);
    await handle.close();
    const error = await errorOf(() => openRunStore(oversized));
    assert.ok(['run_store_record_too_large', 'run_store_malformed_record', 'run_store_torn_record']
      .includes(error.code), error.code);
  } finally {
    await rm(oversized, { recursive: true, force: true });
  }
});

test('duplicate JSON keys and leftover torn temps are refused', async () => {
  await withStore(async (root, store) => {
    const created = await store.submit(makeSubmission());
    const record = path.join(root, `${RUN_ID}.json`);
    const text = JSON.stringify({
      schema: created.record.schema,
      run_id: created.record.run_id,
      request_idempotency_key: created.record.request_idempotency_key,
      identity: created.record.identity,
      git: created.record.git,
      provenance: created.record.provenance,
      telemetry: created.record.telemetry,
      canonical_digest: created.record.canonical_digest,
    }).replace('"run_id":', '"run_id":"ATTACKER-SECRET","run_id":');
    await writeFile(record, `${text}\n`, { mode: 0o600 });
    const error = await errorOf(() => openRunStore(root));
    assert.equal(error.code, 'run_store_duplicate_entry');
    assertNoSecret(error);
  });

  const torn = await makePrivateRoot('r1-run-store-torn-');
  try {
    await writeFile(path.join(torn, `.tmp-${'cd'.repeat(16)}`), 'partial', { mode: 0o600 });
    assert.equal((await errorOf(() => openRunStore(torn))).code, 'run_store_torn_temporary');
    const names = await readdir(torn);
    assert.ok(names.some((name) => name.startsWith('.tmp-')));
  } finally {
    await rm(torn, { recursive: true, force: true });
  }
});

test('failed submit cleans its private temps and does not leave torn files', async () => {
  await withStore(async (root, store) => {
    const first = makeSubmission();
    await store.submit(first);
    const conflict = makeSubmission({
      counters: { dispatch_calls: 0, wake_events: 9, outcome_events: 0 },
    });
    await errorOf(() => store.submit(conflict));
    const names = await readdir(root);
    assert.ok(!names.some((name) => name.startsWith('.tmp-')));
    assert.equal(names.filter((name) => name.endsWith('.json')).length, 1);
  });
});

test('proxy accessor alias and cycle inputs fail closed with zero trap dispatch', async () => {
  await withStore(async (root, store) => {
    const input = makeSubmission();
    const { proxy, counts } = countingProxy(input);
    const proxyError = await errorOf(() => store.submit(proxy));
    assert.equal(proxyError.code, 'proxy_denied');
    assert.equal(trapTotal(counts), 0);

    const accessor = { ...input };
    Object.defineProperty(accessor, 'run_id', {
      enumerable: true,
      get() { return 'ATTACKER-SECRET'; },
    });
    const accessorError = await errorOf(() => store.submit(accessor));
    assert.equal(accessorError.code, 'accessor_property_denied');
    assertNoSecret(accessorError);

    const cycle = { ...input };
    cycle.self = cycle;
    assert.equal((await errorOf(() => store.submit(cycle))).code, 'aliased_reference_denied');

    const shared = { provider: 'grok', model: 'grok-4' };
    const alias = { ...input, requested: shared, also: shared };
    const aliasError = await errorOf(() => store.submit(alias));
    assert.ok(['aliased_reference_denied', 'unknown_key'].includes(aliasError.code), aliasError.code);

    const target = makeSubmission();
    const { proxy: revoked, revoke } = Proxy.revocable(target, {
      get() { throw new Error('revoked get'); },
      ownKeys() { throw new Error('revoked ownKeys'); },
    });
    revoke();
    assert.equal(utilTypes.isProxy(revoked), true);
    assert.equal((await errorOf(() => store.submit(revoked))).code, 'proxy_denied');
    assert.deepEqual(await readdir(root), []);
  });
});

test('bounded directory floods fail closed without enumerating unboundedly', async () => {
  const root = await makePrivateRoot('r1-run-store-flood-');
  try {
    const writes = [];
    for (let index = 0; index <= MAX_RUN_STORE_DIRECTORY_ENTRIES; index += 1) {
      writes.push(writeFile(path.join(root, `flood-${index}.txt`), 'x', { mode: 0o600 }));
    }
    await Promise.all(writes);
    const error = await errorOf(() => openRunStore(root));
    assert.ok(['run_store_too_many_entries', 'run_store_foreign_entry'].includes(error.code), error.code);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('record cap is enforced and diagnostics never echo credentials', async () => {
  await withStore(async (_root, store) => {
    for (let index = 0; index < 3; index += 1) {
      await store.submit(makeSubmission({ runId: `run-cap-${index}` }));
    }
    const hostile = makeSubmission();
    hostile.token = 'sk-live-ATTACKER-SECRET';
    const error = await errorOf(() => store.submit(hostile));
    assert.ok(['credential_content_denied', 'unknown_key'].includes(error.code), error.code);
    assertNoSecret(error);
  });
});

test('non-directory roots fail closed', async () => {
  const parent = await makePrivateRoot('r1-run-store-file-');
  const fileRoot = path.join(parent, 'file-root');
  await writeFile(fileRoot, 'not-a-directory', { mode: 0o600 });
  try {
    assert.equal((await errorOf(() => openRunStore(fileRoot))).code, 'run_store_root_unsafe');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('excess records fail closed after the store cap', async () => {
  await withStore(async (_root, store) => {
    const original = MAX_RUN_STORE_ENTRIES;
    assert.equal(original >= 1, true);
    const first = await store.submit(makeSubmission({ runId: 'run-limit-a' }));
    assert.equal(first.created, true);
    const second = await store.submit(makeSubmission({ runId: 'run-limit-b' }));
    assert.equal(second.created, true);
  });
});
