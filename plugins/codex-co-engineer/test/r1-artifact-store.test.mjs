import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  ARTIFACT_STORE_CONTENT_DIR,
  ARTIFACT_STORE_META_DIR,
  ARTIFACT_STORE_ERROR_CODES,
  ARTIFACT_STORE_INVENTORY_LABEL,
  ARTIFACT_STORE_MAX_DEPTH,
  ARTIFACT_STORE_META_SUFFIX,
  ARTIFACT_STORE_NAMESPACES,
  ARTIFACT_STORE_SCHEMA_ID,
  ARTIFACT_STORE_TEMP_NAME_PATTERN,
  MAX_ARTIFACT_STORE_AUDIT_FILES,
  MAX_ARTIFACT_STORE_META_BYTES,
  MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES,
  auditArtifactStoreV1,
  openArtifactStoreV1,
  publishArtifactV1,
  verifyStoredArtifactsV1,
  verifyStoredArtifactV1,
} from '../mcp/v3/artifact-store.mjs';
import {
  ARTIFACT_REF_SCHEMA_ID,
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
} from '../mcp/v3/artifact-ref.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  CHILD_B,
  chunksOf,
  digestOf,
  emptyStream,
  endlessSource,
  makeStoreRoot,
  refFor,
  removeRoot,
  RUN_ID,
} from './fixtures/r1-artifact-store-fixtures.mjs';

const PAYLOAD = Buffer.from('authoritative artifact bytes for P08\n');
const SECOND = Buffer.from('a second artifact published through a stream\n');

async function errorOfAsync(action, expectedCode, expectedPath) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (expectedCode !== undefined) assert.equal(error.code, expectedCode);
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
    return error;
  }
  assert.fail(`expected a typed ${expectedCode ?? 'RunContractV1Error'} failure`);
}

test('the closed vocabulary and layout constants are exported frozen', () => {
  assert.equal(ARTIFACT_STORE_SCHEMA_ID, 'codex-co-engineer.artifact-store.v1');
  assert.deepEqual([...ARTIFACT_STORE_NAMESPACES], ['raw', 'sanitized']);
  assert.equal(Object.isFrozen(ARTIFACT_STORE_NAMESPACES), true);
  assert.equal(Object.isFrozen(ARTIFACT_STORE_ERROR_CODES), true);
  for (const code of [
    'artifact_content_conflict', 'artifact_metadata_conflict', 'artifact_digest_mismatch',
    'artifact_length_mismatch', 'artifact_torn_publication', 'artifact_torn_temporary',
    'artifact_foreign_entry', 'artifact_stream_over_cap', 'artifact_not_found',
  ]) {
    assert.ok(ARTIFACT_STORE_ERROR_CODES.includes(code), code);
  }
  assert.equal(ARTIFACT_STORE_CONTENT_DIR, 'content');
  assert.equal(ARTIFACT_STORE_META_DIR, 'meta');
  assert.equal(ARTIFACT_STORE_META_SUFFIX, '.json');
  assert.match(ARTIFACT_STORE_TEMP_NAME_PATTERN.source, /tmp/);
  assert.equal(typeof ARTIFACT_STORE_INVENTORY_LABEL, 'string');
  assert.equal(ARTIFACT_STORE_MAX_DEPTH > 0, true);
  assert.equal(MAX_ARTIFACT_STORE_AUDIT_FILES > 0, true);
  assert.equal(MAX_ARTIFACT_STORE_META_BYTES >= MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES, true);
});

test('a validated buffer publication returns detached frozen content-free metadata', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const receipt = await store.publish(refFor(PAYLOAD), PAYLOAD);
    assert.equal(receipt.schema, ARTIFACT_STORE_SCHEMA_ID);
    assert.deepEqual(Object.keys(receipt), [
      'schema', 'artifact_ref', 'namespace', 'byte_length', 'sha256', 'ref_digest', 'created',
    ]);
    assert.equal(receipt.created, true);
    assert.equal(receipt.namespace, 'sanitized');
    assert.equal(receipt.byte_length, PAYLOAD.length);
    assert.equal(receipt.sha256, digestOf(PAYLOAD));
    assert.equal(receipt.artifact_ref.relative_path, `runs/${RUN_ID}/lane-alpha/diff.patch`);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.artifact_ref), true);
    assert.match(receipt.ref_digest, /^[0-9a-f]{64}$/u);
    // Content-free: the receipt never carries the root path or any bytes.
    const projected = JSON.stringify(receipt);
    assert.equal(projected.includes(root), false);
    assert.equal(projected.includes(path.basename(root)), false);
    assert.equal(projected.includes(PAYLOAD.toString('utf8').trim()), false);
    // Detached: mutating the caller view afterwards changes nothing.
    const verdict = await store.verifyArtifact(refFor(PAYLOAD));
    assert.equal(verdict.verified, true);
    assert.deepEqual(Object.keys(verdict), [
      'schema', 'artifact_ref', 'namespace', 'byte_length', 'sha256', 'verified',
    ]);
  } finally {
    removeRoot(root);
  }
});

test('buffer and bounded async stream sources store identical state deterministically', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const viaBuffer = await store.publish(refFor(SECOND), SECOND);
    const streamRef = refFor(SECOND, {
      assignment_id: CHILD_B,
      relative_path: `runs/${RUN_ID}/${CHILD_B}/diff.patch`,
    });
    const viaStream = await store.publish(streamRef, chunksOf(SECOND, 5));
    assert.equal(viaBuffer.sha256, viaStream.sha256);
    assert.equal(viaBuffer.byte_length, viaStream.byte_length);
    const batch = await store.verifyArtifacts([streamRef, refFor(SECOND)]);
    assert.equal(batch.length, 2);
    for (const verdict of batch) assert.equal(verdict.verified, true);
  } finally {
    removeRoot(root);
  }
});

test('exact same validated ref plus bytes is idempotent; nothing else is', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const first = await store.publish(refFor(PAYLOAD), PAYLOAD);
    const replay = await store.publish(refFor(PAYLOAD), PAYLOAD);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(first.ref_digest, replay.ref_digest);
    assert.equal(replay.byte_length, first.byte_length);
    assert.equal(replay.sha256, first.sha256);
    // Conflicting content at the same location fails closed.
    const other = Buffer.from('conflicting content');
    await errorOfAsync(
      () => store.publish(refFor(other), other),
      'artifact_content_conflict',
    );
    // Same digest with mismatched metadata fails closed.
    await errorOfAsync(
      () => store.publish(refFor(PAYLOAD, { media_type: 'application/json' }), PAYLOAD),
      'artifact_metadata_conflict',
    );
    await errorOfAsync(
      () => store.publish(refFor(PAYLOAD, { run_id: `${RUN_ID}-x` }), PAYLOAD),
      'artifact_metadata_conflict',
    );
    // The authoritative artifact survived every conflict untouched.
    assert.equal((await store.audit()).artifacts, 1);
    assert.equal((await store.publish(refFor(PAYLOAD), PAYLOAD)).created, false);
  } finally {
    removeRoot(root);
  }
});

test('raw and sanitized namespaces stay disjoint at one relative path', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const sharedPath = `runs/${RUN_ID}/shared/report.bin`;
    const sanitized = Buffer.from('model-facing projection');
    const raw = Buffer.from('owner-only local evidence that never faces the model');
    const sanitizedRef = refFor(sanitized, { relative_path: sharedPath });
    const rawRef = refFor(raw, { relative_path: sharedPath, artifact_class: 'raw' });
    await store.publish(sanitizedRef, sanitized);
    await store.publish(rawRef, raw);
    const report = await store.audit();
    assert.equal(report.namespaces.sanitized.artifacts, 1);
    assert.equal(report.namespaces.raw.artifacts, 1);
    assert.deepEqual(report.entries.map((entry) => entry.artifact_class), ['raw', 'sanitized']);
    assert.equal(await store.verifyArtifact(sanitizedRef).then((v) => v.verified), true);
    assert.equal(await store.verifyArtifact(rawRef).then((v) => v.verified), true);
  } finally {
    removeRoot(root);
  }
});

test('declared byte_length and sha256 are untrusted claims checked before publication', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const wrongLength = refFor(Buffer.from('0123456789'), {});
    await errorOfAsync(
      () => store.publish({ ...wrongLength, byte_length: 11 }, Buffer.from('0123456789')),
      'artifact_length_mismatch',
    );
    await errorOfAsync(
      () => store.publish({
        ...wrongLength, sha256: 'bb'.repeat(32),
      }, Buffer.from('0123456789')),
      'artifact_digest_mismatch',
    );
    // Short and empty streams fail against their declared claims.
    await errorOfAsync(() => store.publish(wrongLength, emptyStream()), 'artifact_length_mismatch');
    // Nothing was published and no temporary was left behind.
    const report = await store.audit();
    assert.equal(report.artifacts, 0);
    assert.equal(report.inventory_digest.length, 64);
    await errorOfAsync(
      () => store.verifyArtifact(wrongLength),
      'artifact_not_found',
    );
  } finally {
    removeRoot(root);
  }
});

test('the class cap is enforced before over-allocation on streams and buffers alike', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    // Declaring above the class cap stays a P07 denial before any effect.
    await errorOfAsync(
      () => store.publish(refFor(
        Buffer.alloc(MAX_SANITIZED_ARTIFACT_BYTE_LENGTH + 1),
        { relative_path: `runs/${RUN_ID}/too-big.bin` },
      ), Buffer.alloc(1)),
      'out_of_range',
    );
    // A declaration pinned exactly at the cap plus a source that outruns it
    // hits the store's own streaming enforcement.
    const atCap = refFor(PAYLOAD, {
      relative_path: `runs/${RUN_ID}/at-cap.bin`,
      byte_length: MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
    });
    await errorOfAsync(
      () => publishArtifactV1(store, atCap,
        Buffer.alloc(MAX_SANITIZED_ARTIFACT_BYTE_LENGTH + 1)),
      'artifact_stream_over_cap',
    );
    // A hostile endless stream is stopped by the cap without unbounded work.
    await errorOfAsync(
      () => publishArtifactV1(store, atCap, (async function* () {
        while (true) yield Buffer.alloc(4096, 0x61);
      })()),
      'artifact_stream_over_cap',
    );
    await errorOfAsync(
      () => publishArtifactV1(store, atCap, endlessSource()),
      'artifact_stream_over_cap',
    );
    // The raw namespace tolerates what sanitized cannot.
    const beyondSanitized = Buffer.alloc(MAX_SANITIZED_ARTIFACT_BYTE_LENGTH + 1, 0x64);
    const rawReceipt = await store.publish(
      refFor(beyondSanitized, { artifact_class: 'raw', relative_path: `runs/${RUN_ID}/wide.bin` }),
      beyondSanitized,
    );
    assert.equal(rawReceipt.namespace, 'raw');
    assert.equal((await store.audit()).namespaces.raw.bytes, beyondSanitized.length);
  } finally {
    removeRoot(root);
  }
});

test('verification audits a bounded ordered batch and inherits P07 batch discipline', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const refs = [];
    for (let index = 0; index < 4; index += 1) {
      const bytes = Buffer.from(`artifact-${index}`);
      const ref = refFor(bytes, { relative_path: `runs/${RUN_ID}/lane-${index}/a.patch` });
      await store.publish(ref, bytes);
      refs.push(ref);
    }
    const forward = await store.verifyArtifacts(refs);
    const backward = await store.verifyArtifacts([...refs].reverse());
    assert.deepEqual(JSON.stringify(forward), JSON.stringify(backward));
    // Duplicates are denied instead of collapsed (P07 vocabulary).
    await errorOfAsync(() => store.verifyArtifacts([refs[0], refs[0]]), 'duplicate_artifact_ref');
    // Batches above the closed bound are denied before any verification.
    const tooMany = Array.from({ length: 65 }, (_, index) => refFor(
      Buffer.from([index]), { relative_path: `runs/${RUN_ID}/overflow/${index}.bin` },
    ));
    await errorOfAsync(() => store.verifyArtifacts(tooMany), 'refs_exceeded');
  } finally {
    removeRoot(root);
  }
});

test('concurrent identical submissions compose into one winner plus idempotent losers', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const submissions = Array.from({ length: 8 }, () =>
      store.publish(refFor(PAYLOAD), PAYLOAD));
    const receipts = await Promise.all(submissions);
    const created = receipts.filter((receipt) => receipt.created);
    assert.equal(created.length, 1);
    const digests = new Set(receipts.map((receipt) => receipt.ref_digest));
    assert.equal(digests.size, 1);
    const report = await store.audit();
    assert.equal(report.artifacts, 1);
    assert.equal(report.namespaces.sanitized.artifacts, 1);
  } finally {
    removeRoot(root);
  }
});

test('concurrent conflicting submissions fail closed with one deterministic winner', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const winner = Buffer.from('the winning bytes');
    const loser = Buffer.from('the losing bytes!');
    const attempts = [
      ...Array.from({ length: 4 }, () => ({ ref: refFor(winner), source: winner })),
      ...Array.from({ length: 4 }, () => ({ ref: refFor(loser), source: loser })),
    ];
    const settled = await Promise.allSettled(attempts.map(({ ref, source }) =>
      store.publish(ref, source)));
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length + rejected.length, attempts.length);
    assert.equal(fulfilled.length >= 1, true);
    for (const rejection of rejected) {
      assert.ok(rejection.reason instanceof RunContractV1Error);
      assert.equal(rejection.reason.code, 'artifact_content_conflict');
    }
    const survivingDigests = new Set(fulfilled.map((entry) => entry.value.sha256));
    assert.equal(survivingDigests.size, 1);
    const report = await store.audit();
    assert.equal(report.artifacts, 1);
    assert.equal(report.entries[0].byte_length,
      fulfilled[0].value.byte_length);
    const survivingBytes = fulfilled[0].value.sha256 === digestOf(winner) ? winner : loser;
    assert.equal(await store.verifyArtifact(refFor(survivingBytes))
      .then((verdict) => verdict.verified), true);
  } finally {
    removeRoot(root);
  }
});

test('restart verification reproduces one stable inventory fingerprint', async () => {
  const root = makeStoreRoot();
  try {
    const first = await openArtifactStoreV1({ root });
    await first.publish(refFor(PAYLOAD), PAYLOAD);
    await first.publish(refFor(SECOND, {
      assignment_id: CHILD_B,
      relative_path: `runs/${RUN_ID}/${CHILD_B}/diff.patch`,
      artifact_class: 'raw',
    }), SECOND);
    const before = await first.audit();
    assert.equal(before.artifacts, 2);
    assert.equal(before.inventory_digest.length, 64);

    const reopened = await openArtifactStoreV1({ root });
    const after = await reopened.audit();
    assert.equal(after.inventory_digest, before.inventory_digest);
    assert.deepEqual(after.namespaces, before.namespaces);
    assert.deepEqual(JSON.stringify(after.entries), JSON.stringify(before.entries));

    // Any meaningful stored change must move the fingerprint.
    const third = Buffer.from('a third artifact');
    await reopened.publish(refFor(third, {
      relative_path: `runs/${RUN_ID}/third/a.patch`,
    }), third);
    const changed = await reopened.audit();
    assert.notEqual(changed.inventory_digest, before.inventory_digest);
    assert.equal(changed.artifacts, 3);
  } finally {
    removeRoot(root);
  }
});

test('audits are sorted, bounded, and describe only content-free metadata', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    for (let index = 0; index < 3; index += 1) {
      const bytes = Buffer.from(`audit-${index}`);
      await store.publish(refFor(bytes, {
        relative_path: `runs/${RUN_ID}/z-${2 - index}/a.patch`,
      }), bytes);
    }
    const report = await store.audit();
    assert.equal(report.schema, ARTIFACT_STORE_SCHEMA_ID);
    const paths = report.entries.map((entry) => entry.relative_path);
    assert.deepEqual(paths, [...paths].sort());
    for (const entry of report.entries) {
      assert.deepEqual(Object.keys(entry), [
        'artifact_class', 'relative_path', 'byte_length', 'sha256',
      ]);
    }
    const projected = JSON.stringify(report);
    assert.equal(projected.includes(root), false);
  } finally {
    removeRoot(root);
  }
});
