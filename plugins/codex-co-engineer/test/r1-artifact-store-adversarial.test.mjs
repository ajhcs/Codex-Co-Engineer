import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, link, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARTIFACT_STORE_META_SUFFIX,
  auditArtifactStoreV1,
  MAX_ARTIFACT_STORE_AUDIT_FILES,
  MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES,
  MAX_ARTIFACT_STORE_META_BYTES,
  openArtifactStoreV1,
  verifyStoredArtifactsV1,
} from '../mcp/v3/artifact-store.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  accessorIterable,
  chunksOf,
  digestOf,
  emptyStream,
  makeStoreRoot,
  refFor,
  removeRoot,
  sabotagingSource,
  shortSource,
  stringChunkSource,
  SubclassedBytes,
  throwingSource,
} from './fixtures/r1-artifact-store-fixtures.mjs';
import { countingProxy } from './fixtures/r1-artifact-fixtures.mjs';

const PAYLOAD = Buffer.from('adversarial payload with distinctive bytes\n');
const BASE_REF = refFor(PAYLOAD);

const isWindows = process.platform === 'win32';

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (code !== undefined) {
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    }
    return error;
  }
  assert.fail(`expected a typed ${code ?? 'RunContractV1Error'} failure`);
}

function assertContentFree(error, root, bytes) {
  const message = `${error.message}`;
  assert.equal(message.includes(root), false, 'error echoed the store root');
  assert.equal(message.includes('ENOENT'), false, 'error echoed an errno');
  assert.equal(message.includes('EEXIST'), false, 'error echoed an errno');
  if (Buffer.isBuffer(bytes)) {
    assert.equal(message.includes(bytes.toString('utf8').trim()), false, 'error echoed artifact bytes');
  }
}

async function freshStore() {
  const root = makeStoreRoot();
  const store = await openArtifactStoreV1({ root });
  return { root, store };
}

async function closeAndReopen(root) {
  const reopened = await openArtifactStoreV1({ root });
  return reopened;
}

test('proxy, accessor, and alias/cycle references fail closed before any filesystem effect', async () => {
  const { root, store } = await freshStore();
  try {
    // Live proxy with a trap counter: zero traps may fire.
    const { proxy, counts } = countingProxy(BASE_REF);
    const error = await expectCode(() => store.publish(proxy, PAYLOAD), 'proxy_denied');
    assertContentFree(error, root, PAYLOAD);
    assert.equal(counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has, 0);

    // Accessor-dressed reference: the getter must never run.
    const accessor = { ...BASE_REF };
    let getterRuns = 0;
    Object.defineProperty(accessor, 'sha256', {
      enumerable: true,
      get() { getterRuns += 1; return digestOf(PAYLOAD); },
    });
    await expectCode(() => store.publish(accessor, PAYLOAD), 'accessor_property_denied');
    assert.equal(getterRuns, 0);

    // Aliased cyclic reference.
    const cyclic = { ...BASE_REF };
    cyclic.self = cyclic;
    await expectCode(() => store.publish(cyclic, PAYLOAD), 'aliased_reference_denied');

    // Unknown key keeps its P07 denial.
    await expectCode(
      () => store.publish({ ...BASE_REF, extra: 'x' }, PAYLOAD),
      'unknown_key',
    );
    // Malformed digest keeps its P07 denial.
    await expectCode(
      () => store.publish({ ...BASE_REF, sha256: digestOf(PAYLOAD).toUpperCase() }, PAYLOAD),
      'invalid_format',
    );
    // The store is still pristine: no artifacts, no temporaries.
    assert.equal((await store.audit()).artifacts, 0);
  } finally {
    removeRoot(root);
  }
});

test('traversal, devices, separators, and Unicode hostility inherit exact P07 behavior', async () => {
  const { root, store } = await freshStore();
  try {
    const cases = [
      [{ relative_path: '../outside.patch' }, 'alias_segment_denied'],
      [{ relative_path: 'a/../../b.patch' }, 'alias_segment_denied'],
      [{ relative_path: '/absolute.patch' }, 'absolute_path_denied'],
      [{ relative_path: 'runs\\run\\x.patch' }, 'invalid_separator'],
      [{ relative_path: 'runs/run-x/con' }, 'reserved_device_name_denied'],
      [{ relative_path: 'runs/run-x/CON.txt' }, 'reserved_device_name_denied'],
      [{ relative_path: 'runs/run-x/nul.dat' }, 'reserved_device_name_denied'],
      [{ relative_path: 'runs/run-x/aux' }, 'reserved_device_name_denied'],
      [{ relative_path: 'runs/run-x/trail.' }, 'edge_character_denied'],
      [{ relative_path: 'runs/run-x/ lead.patch' }, 'edge_character_denied'],
      [{ relative_path: 'runs/run-x/a:b.patch' }, 'colon_denied'],
      [{ relative_path: 'runs/run-x/solid\u2044us.patch' }, 'separator_lookalike_denied'],
      [{ relative_path: 'runs/run-x/invis\u200bx.patch' }, 'invisible_character_denied'],
      [{ relative_path: 'runs/run-x/bell\u0007.patch' }, 'control_character_denied'],
      [{ relative_path: 'runs/run-x/\u212an.patch' }, 'invalid_encoding'],
    ];
    for (const [override, expected] of cases) {
      await expectCode(
        () => store.publish(refFor(PAYLOAD, override), PAYLOAD),
        expected,
        'artifact_ref.relative_path',
      );
    }
    // Well-formed astral characters stay legal end-to-end.
    const astral = Buffer.from('emoji artifact');
    const astralRef = refFor(astral, {
      relative_path: `runs/${'r'.repeat(4)}-🎨/lane-日本語/artifact-𝔘.patch`,
    });
    await store.publish(astralRef, astral);
    assert.equal((await store.audit()).artifacts, 1);
    assert.equal(await store.verifyArtifact(astralRef).then((v) => v.verified), true);
  } finally {
    removeRoot(root);
  }
});

test('hostile sources are denied before any byte reaches disk', async () => {
  const { root, store } = await freshStore();
  try {
    // Proxy-wrapped buffer.
    const { proxy } = countingProxy(PAYLOAD);
    await expectCode(() => store.publish(BASE_REF, proxy), 'proxy_denied');
    // Subclassed view: not an intrinsic prototype.
    await expectCode(
      () => store.publish(BASE_REF, new SubclassedBytes(PAYLOAD.length)),
      'artifact_stream_invalid_source',
    );
    // SharedArrayBuffer-backed view.
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    await expectCode(() => store.publish(BASE_REF, shared), 'artifact_stream_invalid_source');
    // Plain strings and numbers are not sources.
    await expectCode(() => store.publish(BASE_REF, 'text'), 'artifact_stream_invalid_source');
    await expectCode(() => store.publish(BASE_REF, 42), 'artifact_stream_invalid_source');
    // Accessor-dressed iterable: its getter must never run.
    const trapLog = { iteratorGetter: 0 };
    await expectCode(
      () => store.publish(BASE_REF, accessorIterable(trapLog)),
      'artifact_stream_invalid_source',
    );
    assert.equal(trapLog.iteratorGetter, 0);
    // A class instance with a prototype chain (Node Readable) is refused.
    class FakeStream {
      async *[Symbol.asyncIterator]() { yield PAYLOAD; }
    }
    await expectCode(() => store.publish(BASE_REF, new FakeStream()), 'artifact_stream_invalid_source');
    // String chunks from a generator are refused mid-stream.
    await expectCode(
      () => store.publish(BASE_REF, stringChunkSource()),
      'artifact_stream_invalid_chunk',
    );
    assert.equal((await store.audit()).artifacts, 0);
  } finally {
    removeRoot(root);
  }
});

test('short, long, and throwing streams fail typed without echoing the underlying cause', async () => {
  const { root, store } = await freshStore();
  try {
    const declared = refFor(Buffer.alloc(16, 0x61), { relative_path: 'runs/r/short.bin' });
    await expectCode(() => store.publish(declared, shortSource(16, 4)), 'artifact_length_mismatch');
    await expectCode(() => store.publish(declared, emptyStream()), 'artifact_length_mismatch');
    const growing = refFor(Buffer.alloc(64, 0x62), { relative_path: 'runs/r/long.bin' });
    await expectCode(
      () => store.publish(growing, (async function* () {
        yield Buffer.alloc(64, 0x62);
        yield Buffer.alloc(2, 0x62);
      })()),
      'artifact_length_mismatch',
    );
    const underlying = new Error('secret internals about the host filesystem');
    const streamError = await expectCode(
      () => store.publish(declared, throwingSource(underlying)),
      'artifact_stream_failed',
    );
    assert.equal(streamError.message.includes('secret internals'), false);
    assert.equal((await store.audit()).artifacts, 0);
  } finally {
    removeRoot(root);
  }
});

test('symlinked parents, targets, and sidecars are never followed', async () => {
  if (isWindows) return;
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    // Seed one namespace so intermediate directories exist.
    await store.publish(BASE_REF, PAYLOAD);
    const outside = mkdtempSync(path.join(tmpdir(), 'cce-p08-outside-'), { mode: 0o700 });
    try {
      // Symlink at a parent component of a future publication.
      const parentLink = path.join(root, 'sanitized', 'content', 'runs', 'link');
      await symlink(outside, parentLink, 'dir');
      // The structural sweep condemns the link before any publication walk
      // could resolve through it; nothing is ever followed.
      await expectCode(
        () => store.publish(refFor(Buffer.from('x'), { relative_path: 'runs/link/x.bin' }),
          Buffer.from('x')),
        'artifact_entry_unsafe',
      );
      await expectCode(() => store.audit(), 'artifact_entry_unsafe');
      await rm(parentLink);

      // Symlink planted exactly at the destination content name: first strip
      // the authoritative artifact, then occupy its name with a link.
      const target = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
        'lane-alpha', 'diff.patch');
      rmSync(target);
      const bait = Buffer.from('bait bytes never adopted');
      writeFileSync(path.join(outside, 'bait.bin'), bait);
      await symlink(path.join(outside, 'bait.bin'), target);
      await expectCode(
        () => store.verifyArtifact(BASE_REF),
        'artifact_entry_unsafe',
      );
      await expectCode(
        () => store.publish(BASE_REF, PAYLOAD),
        'artifact_entry_unsafe',
      );
      // The bait file must be untouched by every attempt above.
      assert.equal(readFileSync(path.join(outside, 'bait.bin')).equals(bait), true);
      await unlink(target);

      // Symlinked sidecar.
      const metaTarget = path.join(root, 'sanitized', 'meta', 'runs', 'run-store-01',
        'lane-alpha', `diff.patch${ARTIFACT_STORE_META_SUFFIX}`);
      writeFileSync(path.join(outside, 'fake.json'), '{"schema":"x"}');
      rmSync(metaTarget);
      await symlink(path.join(outside, 'fake.json'), metaTarget);
      await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_entry_unsafe');
      await unlink(metaTarget);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    removeRoot(root);
  }
});

test('hardlinked stored artifacts are rejected wherever they can be proven', async () => {
  if (isWindows) return;
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    const outside = mkdtempSync(path.join(tmpdir(), 'cce-p08-hard-'), { mode: 0o700 });
    try {
      const contentPath = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
        'lane-alpha', 'diff.patch');
      // Exfiltrate one more directory entry onto the same inode.
      await link(contentPath, path.join(outside, 'alias.bin'));
      await expectCode(() => closeAndReopen(root), 'artifact_entry_unsafe');
      await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_entry_unsafe');
      await expectCode(() => store.audit(), 'artifact_entry_unsafe');
      // Restoring single-link discipline restores verification.
      await unlink(path.join(outside, 'alias.bin'));
      assert.equal(await store.verifyArtifact(BASE_REF).then((v) => v.verified), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    removeRoot(root);
  }
});

test('FIFOs and other non-regular entries are condemned without blocking or following', async () => {
  if (isWindows) return;
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    const contentDir = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha');
    rmSync(path.join(contentDir, 'diff.patch'));
    const fifoPath = path.join(contentDir, 'diff.patch');
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [fifoPath]);
    // Verification must not block on a writer-less FIFO (O_NONBLOCK opens).
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_entry_unsafe');
    await expectCode(() => closeAndReopen(root), 'artifact_entry_unsafe');
    // Publishing onto the FIFO location fails closed as well.
    await expectCode(() => store.publish(BASE_REF, PAYLOAD), 'artifact_entry_unsafe');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('root swaps between operations are proven and rejected', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    // Replace the root directory wholesale (new device/inode at same path).
    const moved = `${root}-moved`;
    rmSync(moved, { recursive: true, force: true });
    const renamed = renameSync(root, moved);
    mkdirSync(root, { mode: 0o700 });
    try {
      await expectCode(() => store.publish(refFor(Buffer.from('y'), { relative_path: 'y.bin' }),
        Buffer.from('y')), 'artifact_root_unsafe');
      await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_root_unsafe');
    } finally {
      if (renamed) rmSync(moved, { recursive: true, force: true });
    }
  } finally {
    rmSync(`${root}-moved`, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('parent swaps interleaved into a live publication are proven and rejected', async (t) => {
  if (isWindows) return;
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    const deepBytes = Buffer.from('parent swap victim payload');
    const deepRef = refFor(deepBytes, {
      relative_path: 'runs/run-store-01/lane-alpha/deep/deeper/swap.patch',
    });
    // After the first chunk arrives, replace a captured ancestor directory
    // with a brand-new inode at the same path. Publication must fail typed
    // and leave no authoritative artifact behind for that reference.
    let outcome = null;
    try {
      await store.publish(deepRef, sabotagingSource(async () => {
        const ancestor = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01');
        const staged = `${ancestor}-staged`;
        renameSync(ancestor, staged);
        mkdirSync(ancestor, { recursive: true, mode: 0o700 });
        rmSync(staged, { recursive: true, force: true });
      }));
    } catch (error) {
      outcome = error;
    }
    assert.ok(outcome instanceof RunContractV1Error,
      `expected a typed failure, got ${String(outcome)}`);
    assertContentFree(outcome, root, deepBytes);
    try {
      await store.verifyArtifact(deepRef);
      assert.fail('expected a typed verification failure');
    } catch (error) {
      assert.ok(error instanceof RunContractV1Error);
      assert.ok(
        error.code === 'artifact_not_found' || error.code === 'artifact_torn_publication',
        `unexpected code ${error.code}`,
      );
    }
    // The hostile deletion orphaned previously authoritative sidecars too.
    // Nothing heals silently: every later operation keeps failing closed
    // until an operator acts outside this module.
    await expectCode(() => store.verifyArtifact(BASE_REF));
  } finally {
    removeRoot(root);
  }
});

test('crash debris: torn temporaries, orphaned content, and orphaned sidecars stay rejected after restart', async () => {
  const root = makeStoreRoot();
  try {
    const seed = await openArtifactStoreV1({ root });
    await seed.publish(BASE_REF, PAYLOAD);
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    const metaLeaf = path.join(root, 'sanitized', 'meta', 'runs', 'run-store-01',
      'lane-alpha', `diff.patch${ARTIFACT_STORE_META_SUFFIX}`);

    // Leftover temporary in the content tree.
    writeFileSync(path.join(path.dirname(contentLeaf), '.tmp-' + 'a'.repeat(32)), 'torn temp');
    await expectCode(() => closeAndReopen(root), 'artifact_torn_temporary');
    await expectCode(() => auditArtifactStoreV1(seed), 'artifact_torn_temporary');
    rmSync(path.join(path.dirname(contentLeaf), '.tmp-' + 'a'.repeat(32)));

    // Content without sidecar.
    const orphanContent = path.join(path.dirname(contentLeaf), 'orphan.bin');
    writeFileSync(orphanContent, 'no sidecar');
    await expectCode(() => closeAndReopen(root), 'artifact_torn_publication');
    rmSync(orphanContent);

    // Sidecar without content.
    const orphanMeta = path.join(path.dirname(metaLeaf), 'ghost.bin.json');
    writeFileSync(orphanMeta, '{}');
    await expectCode(() => closeAndReopen(root), 'artifact_torn_publication');
    rmSync(orphanMeta);

    // Foreign names.
    writeFileSync(path.join(path.dirname(contentLeaf), 'bad\x01name'), 'foreign');
    await expectCode(() => closeAndReopen(root), 'artifact_foreign_entry');
    rmSync(path.join(path.dirname(contentLeaf), 'bad\x01name'));
    writeFileSync(path.join(path.dirname(contentLeaf), `${'x'.repeat(129)}`), 'x');
    await expectCode(() => closeAndReopen(root), 'artifact_foreign_entry');
    rmSync(path.join(path.dirname(contentLeaf), `${'x'.repeat(129)}`));
    // A legal name without a sidecar is a torn publication.
    writeFileSync(path.join(path.dirname(contentLeaf), 'legalname.bin'), 'x');
    await expectCode(() => closeAndReopen(root), 'artifact_torn_publication');
    rmSync(path.join(path.dirname(contentLeaf), 'legalname.bin'));

    // After removing every injected fault the store verifies again.
    assert.equal(await auditArtifactStoreV1(seed).then((r) => r.artifacts), 1);
  } finally {
    removeRoot(root);
  }
});

test('a reserved temporary-name parent cannot publish and later self-condemns', async () => {
  const { root, store } = await freshStore();
  try {
    const reserved = `.tmp-${'a'.repeat(32)}`;
    const bytes = Buffer.from('temp-segment payload');
    const reservedRef = refFor(bytes, { relative_path: `runs/${reserved}/x.bin` });
    await expectCode(() => store.publish(reservedRef, bytes), 'artifact_reserved_name_denied');
    // Denial leaves the store clean: later audit/open must not self-condemn.
    assert.equal((await store.audit()).artifacts, 0);
    assert.equal((await closeAndReopen(root).then((reopened) => reopened.audit())).artifacts, 0);

    // Operator-planted reserved parents remain crash debris, not artifacts.
    mkdirSync(path.join(root, 'sanitized', 'content', 'runs', reserved), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(root, 'sanitized', 'content', 'runs', reserved, 'x.bin'), bytes);
    await expectCode(() => store.audit(), 'artifact_torn_temporary');
    await expectCode(() => closeAndReopen(root), 'artifact_torn_temporary');
  } finally {
    removeRoot(root);
  }
});

test('verification compares stored snapshots and never trusts a caller-forged digest', async () => {
  const { root, store } = await freshStore();
  try {
    await store.publish(BASE_REF, PAYLOAD);
    await expectCode(
      () => store.verifyArtifact(refFor(PAYLOAD, { media_type: 'application/json' })),
      'artifact_metadata_conflict',
    );
    await expectCode(
      () => store.verifyArtifact(refFor(PAYLOAD, { run_id: 'run-store-99' })),
      'artifact_metadata_conflict',
    );
    assert.equal(await store.verifyArtifact(BASE_REF).then((verdict) => verdict.verified), true);

    const swapped = Buffer.from(PAYLOAD.map((byte) => byte ^ 0x01));
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    writeFileSync(contentLeaf, swapped);
    await expectCode(() => store.verifyArtifact(refFor(swapped)), 'artifact_content_conflict');
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_digest_mismatch');
  } finally {
    removeRoot(root);
  }
});

test('truncated, oversized, swapped, and malformed stored state fails verification and restart', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    const metaLeaf = path.join(root, 'sanitized', 'meta', 'runs', 'run-store-01',
      'lane-alpha', `diff.patch${ARTIFACT_STORE_META_SUFFIX}`);

    // Truncation.
    writeFileSync(contentLeaf, PAYLOAD.subarray(0, 8));
    await expectCode(() => closeAndReopen(root), 'artifact_entry_unsafe');
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_entry_unsafe');
    writeFileSync(contentLeaf, PAYLOAD);

    // Same-size content swap under one path.
    const swapped = Buffer.from(PAYLOAD.map((byte) => byte ^ 0x01));
    writeFileSync(contentLeaf, swapped);
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_digest_mismatch');
    writeFileSync(contentLeaf, PAYLOAD);

    // Oversized content beyond the class cap.
    writeFileSync(contentLeaf, Buffer.concat([PAYLOAD, Buffer.alloc(300 * 1024, 0x21)]));
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_entry_unsafe');
    writeFileSync(contentLeaf, PAYLOAD);

    // Malformed sidecars: garbage, duplicate keys, extra keys, wrong location.
    for (const broken of [
      'not json at all',
      '{"schema":"codex-co-engineer.artifact-store.v1","schema":"dup"}',
      JSON.stringify({
        schema: 'codex-co-engineer.artifact-store.v1',
        artifact_ref: BASE_REF,
        byte_length: PAYLOAD.length,
        sha256: digestOf(PAYLOAD),
        extra: true,
      }),
      JSON.stringify({
        schema: 'codex-co-engineer.artifact-ref.v1',
        artifact_ref: BASE_REF,
        byte_length: PAYLOAD.length,
        sha256: digestOf(PAYLOAD),
      }),
      JSON.stringify({
        schema: 'codex-co-engineer.artifact-store.v1',
        artifact_ref: BASE_REF,
        byte_length: PAYLOAD.length + 1,
        sha256: digestOf(PAYLOAD),
      }),
    ]) {
      const original = readFileSync(metaLeaf, 'utf8');
      writeFileSync(metaLeaf, `${broken}\n`);
      await expectCode(() => store.verifyArtifact(BASE_REF), undefined);
      writeFileSync(metaLeaf, original);
    }

    // A sidecar describing a different relative path than its location.
    const misplaced = JSON.stringify({
      schema: 'codex-co-engineer.artifact-store.v1',
      artifact_ref: refFor(PAYLOAD, { relative_path: 'runs/elsewhere/x.patch' }),
      byte_length: PAYLOAD.length,
      sha256: digestOf(PAYLOAD),
    });
    const original = readFileSync(metaLeaf, 'utf8');
    writeFileSync(metaLeaf, `${misplaced}\n`);
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_foreign_entry');
    writeFileSync(metaLeaf, original);

    // Everything healed: verification passes again.
    assert.equal(await store.verifyArtifact(BASE_REF).then((v) => v.verified), true);
  } finally {
    removeRoot(root);
  }
});

test('oversized and malformed sidecars are bounded before allocation', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    const metaLeaf = path.join(root, 'sanitized', 'meta', 'runs', 'run-store-01',
      'lane-alpha', `diff.patch${ARTIFACT_STORE_META_SUFFIX}`);
    writeFileSync(metaLeaf, `${'x'.repeat(MAX_ARTIFACT_STORE_META_BYTES + 1)}`);
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_metadata_malformed');
    await expectCode(() => closeAndReopen(root), 'artifact_metadata_malformed');
  } finally {
    removeRoot(root);
  }
});

test('unsafe roots are refused before anything else happens', async () => {
  const missing = path.join(makeStoreRoot(), 'does-not-exist');
  try {
    await expectCode(() => openArtifactStoreV1({ root: missing }), 'artifact_root_missing');
    const tooOpen = makeStoreRoot();
    try {
      chmodSync(tooOpen, 0o755);
      await expectCode(() => openArtifactStoreV1({ root: tooOpen }), 'artifact_root_unsafe');
      chmodSync(tooOpen, 0o700);
      // Root that is actually a file.
      const fileRoot = path.join(makeStoreRoot(), 'file-root');
      writeFileSync(fileRoot, 'not a directory');
      await expectCode(() => openArtifactStoreV1({ root: fileRoot }), 'artifact_root_unsafe');
      // Symlinked root.
      const real = makeStoreRoot();
      const linkRoot = `${real}-link`;
      try {
        symlinkSync(real, linkRoot, 'dir');
        await expectCode(() => openArtifactStoreV1({ root: linkRoot }), 'artifact_root_unsafe');
      } finally {
        rmSync(linkRoot, { force: true });
        removeRoot(real);
      }
      // Hostile option shapes.
      await expectCode(() => openArtifactStoreV1({ root: 'relative/path' }), 'artifact_root_unsafe');
      await expectCode(() => openArtifactStoreV1({ root: `${makeStoreRoot()}/../x` }), 'artifact_root_unsafe');
      await expectCode(() => openArtifactStoreV1(null), 'invalid_type');
      await expectCode(() => openArtifactStoreV1({ root: '/tmp/x', extra: 1 }), 'unknown_key');
    } finally {
      removeRoot(tooOpen);
    }
  } finally {
    removeRoot(path.dirname(missing));
  }
});

test('namespace privacy and structure violations fail closed', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    // Group-readable published file.
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    chmod(contentLeaf, 0o644);
    await expectCode(() => closeAndReopen(root), 'artifact_entry_unsafe');
    await expectCode(() => store.verifyArtifact(BASE_REF), 'artifact_entry_unsafe');
    chmod(contentLeaf, 0o600);
    // Group-writable namespace directory.
    const nsDir = path.join(root, 'sanitized');
    chmod(nsDir, 0o770);
    await expectCode(() => closeAndReopen(root), 'artifact_root_unsafe');
    chmod(nsDir, 0o700);
    // A foreign directory inside a namespace.
    mkdirSync(path.join(root, 'sanitized', 'smuggled'), { mode: 0o700 });
    await expectCode(() => closeAndReopen(root), 'artifact_foreign_entry');
    rmSync(path.join(root, 'sanitized', 'smuggled'), { recursive: true, force: true });
    // A foreign file directly inside a namespace.
    writeFileSync(path.join(root, 'sanitized', 'stray.bin'), 'x');
    await expectCode(() => closeAndReopen(root), 'artifact_foreign_entry');
    rmSync(path.join(root, 'sanitized', 'stray.bin'));
    assert.equal((await store.audit()).artifacts, 1);
  } finally {
    removeRoot(root);
  }
});

test('directory floods and nesting depth hit bounded enumeration denials', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    await store.publish(BASE_REF, PAYLOAD);
    const leafDir = path.join(root, 'sanitized', 'meta', 'runs', 'run-store-01', 'lane-alpha');
    // Flood one directory past the enumeration bound with legal-looking names.
    for (let index = 0; index <= MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES; index += 1) {
      writeFileSync(path.join(leafDir, `flood-${String(index).padStart(4, '0')}.json`), '{}');
    }
    await expectCode(() => closeAndReopen(root), 'artifact_inventory_exceeded');
    for (let index = 0; index <= MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES; index += 1) {
      rmSync(path.join(leafDir, `flood-${String(index).padStart(4, '0')}.json`));
    }

    // Nest deeper than the inherited segment bound.
    let deep = path.join(root, 'sanitized', 'content');
    for (let level = 0; level < 20; level += 1) {
      deep = path.join(deep, `l${level}`);
    }
    mkdirSync(deep, { recursive: true, mode: 0o700 });
    await expectCode(() => closeAndReopen(root), 'artifact_inventory_exceeded');
    rmSync(path.join(root, 'sanitized', 'content', 'l0'), { recursive: true, force: true });

    // The audit-file ceiling is enforced on the sweep itself.
    const manyRoot = makeStoreRoot();
    try {
      const manyStore = await openArtifactStoreV1({ root: manyRoot });
      const floodDir = path.join(manyRoot, 'raw', 'content');
      mkdirSync(path.join(manyRoot, 'raw', 'meta'), { recursive: true, mode: 0o700 });
      mkdirSync(floodDir, { recursive: true, mode: 0o700 });
      const filler = Buffer.alloc(1024, 0x66);
      for (let index = 0; index < MAX_ARTIFACT_STORE_AUDIT_FILES + 1; index += 1) {
        writeFileSync(path.join(floodDir, `f${String(index).padStart(5, '0')}`), filler);
        writeFileSync(path.join(manyRoot, 'raw', 'meta', `f${String(index).padStart(5, '0')}.json`), '{}');
      }
      await expectCode(() => auditArtifactStoreV1(manyStore), 'artifact_inventory_exceeded');
    } finally {
      removeRoot(manyRoot);
    }
  } finally {
    removeRoot(root);
  }
});

test('every typed denial stays content-free across the whole battery', async () => {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    const observations = [];
    const probes = [
      () => store.publish(countingProxy(BASE_REF).proxy, PAYLOAD),
      () => store.publish(BASE_REF, stringChunkSource()),
      () => store.verifyArtifact(BASE_REF),
      () => store.publish(refFor(PAYLOAD, { relative_path: '../escape' }), PAYLOAD),
      () => openArtifactStoreV1({ root: `${root}/missing` }),
      () => store.publish(BASE_REF, new SubclassedBytes(4)),
    ];
    for (const probe of probes) {
      try {
        await probe();
      } catch (error) {
        if (error instanceof RunContractV1Error) observations.push(error);
        else throw error;
      }
    }
    assert.equal(observations.length >= 4, true);
    for (const error of observations) assertContentFree(error, root, PAYLOAD);
  } finally {
    removeRoot(root);
  }
});
