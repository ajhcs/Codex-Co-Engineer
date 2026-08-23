import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseSanitizedReaderOptionsV1,
  readSanitizedArtifactV1,
} from '../mcp/v3/artifact-reader.mjs';
import {
  ARTIFACT_STORE_INGEST_CHUNK_BYTES,
  ARTIFACT_STORE_META_SUFFIX,
  ARTIFACT_STORE_RANGE_READ_MAX_BYTES,
} from '../mcp/v3/artifact-store.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  countingProxy,
  decodeSelected,
  digestOf,
  refFor,
  removeRoot,
  withPublished,
  withStore,
} from './fixtures/r1-artifact-reader-fixtures.mjs';

const PAYLOAD = Buffer.from('adversarial sanitized reader payload\n');
const isWindows = process.platform === 'win32';

async function expectCode(action, code, errorPath) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (code !== undefined) {
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    }
    if (errorPath !== undefined) assert.equal(error.path, errorPath);
    return error;
  }
  assert.fail(`expected a typed ${code ?? 'RunContractV1Error'} failure`);
}

async function fileHandlePrototype() {
  const handle = await openFile(new URL(import.meta.url), 'r');
  try {
    return Object.getPrototypeOf(handle);
  } finally {
    await handle.close();
  }
}

function existsRegularFile(target) {
  try {
    const stat = lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertContentFree(error, root, bytes) {
  const message = `${error.message}`;
  assert.equal(message.includes(root), false, 'error echoed the store root');
  assert.equal(message.includes('ENOENT'), false, 'error echoed an errno');
  assert.equal(message.includes('EEXIST'), false, 'error echoed an errno');
  assert.equal(message.includes('ELOOP'), false, 'error echoed an errno');
  if (Buffer.isBuffer(bytes)) {
    const text = bytes.toString('utf8');
    if (text.trim().length > 0) {
      assert.equal(message.includes(text.trim()), false, 'error echoed artifact bytes');
    }
  }
}

test('proxy, accessor, and alias refs fail closed with zero traps before I/O', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const { proxy, counts } = countingProxy(ref);
    const error = await expectCode(() => readSanitizedArtifactV1(store, proxy), 'proxy_denied');
    assertContentFree(error, root, PAYLOAD);
    assert.equal(counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has, 0);

    const accessor = { ...ref };
    let getterRuns = 0;
    Object.defineProperty(accessor, 'sha256', {
      enumerable: true,
      get() { getterRuns += 1; return digestOf(PAYLOAD); },
    });
    await expectCode(() => readSanitizedArtifactV1(store, accessor), 'accessor_property_denied');
    assert.equal(getterRuns, 0);

    const cyclic = { ...ref };
    cyclic.self = cyclic;
    await expectCode(() => readSanitizedArtifactV1(store, cyclic), 'aliased_reference_denied');

    await expectCode(() => readSanitizedArtifactV1(store, { ...ref, extra: 'x' }), 'unknown_key');
  });
});

test('option proxies and accessors never run', async () => {
  await withPublished(PAYLOAD, {}, async ({ store, ref, root }) => {
    const { proxy, counts } = countingProxy({ offset: 0, max_bytes: 4 });
    const error = await expectCode(
      () => readSanitizedArtifactV1(store, ref, proxy),
      'proxy_denied',
    );
    assertContentFree(error, root, PAYLOAD);
    assert.equal(counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has, 0);

    let optionGets = 0;
    const accessorOpts = {};
    Object.defineProperty(accessorOpts, 'offset', {
      enumerable: true,
      get() { optionGets += 1; return 0; },
    });
    await expectCode(
      () => readSanitizedArtifactV1(store, ref, accessorOpts),
      'accessor_property_denied',
    );
    assert.equal(optionGets, 0);

    const symbolled = { offset: 0 };
    Object.defineProperty(symbolled, Symbol('hidden'), { enumerable: true, value: 1 });
    await expectCode(() => parseSanitizedReaderOptionsV1(symbolled), 'symbol_key_denied');
  });
});

test('P07 hostile relative paths inherit exact denials on the reader', async () => {
  await withStore(async ({ store }) => {
    const cases = [
      [{ relative_path: '../outside.patch' }, 'alias_segment_denied'],
      [{ relative_path: '/absolute.patch' }, 'absolute_path_denied'],
      [{ relative_path: 'runs\\run\\x.patch' }, 'invalid_separator'],
      [{ relative_path: 'runs/run-x/con' }, 'reserved_device_name_denied'],
      [{ relative_path: 'runs/run-x/CON.txt' }, 'reserved_device_name_denied'],
      [{ relative_path: 'runs/run-x/a:b.patch' }, 'colon_denied'],
      [{ relative_path: 'runs/run-x/solid\u2044us.patch' }, 'separator_lookalike_denied'],
      [{ relative_path: 'runs/run-x/invis\u200bx.patch' }, 'invisible_character_denied'],
      [{ relative_path: 'runs/run-x/bell\u0007.patch' }, 'control_character_denied'],
    ];
    for (const [override, expected] of cases) {
      await expectCode(
        () => readSanitizedArtifactV1(store, refFor(PAYLOAD, override)),
        expected,
      );
    }
  });
});

test('reads never allocate a whole-file buffer; hashing uses the fixed ingest chunk', async () => {
  const bytes = Buffer.alloc(ARTIFACT_STORE_INGEST_CHUNK_BYTES + 4096, 0x63);
  await withPublished(bytes, { relative_path: 'runs/run-store-01/lane-alpha/wide.bin' }, async ({ store, ref }) => {
    const proto = await fileHandlePrototype();
    const originalRead = proto.read;
    const requested = [];
    proto.read = function patchedRead(buffer, offset, length, position) {
      const size = typeof length === 'number' ? length : buffer?.byteLength;
      requested.push(size);
      return originalRead.apply(this, arguments);
    };
    try {
      const page = await readSanitizedArtifactV1(store, ref, { offset: 100, max_bytes: 32 });
      assert.equal(decodeSelected(page).equals(bytes.subarray(100, 132)), true);
      assert.ok(requested.length >= 2, 'expected more than one chunked read of a file larger than the ingest chunk');
      for (const size of requested) {
        assert.ok(size <= ARTIFACT_STORE_INGEST_CHUNK_BYTES, `read requested ${size}`);
        assert.notEqual(size, bytes.length);
      }
    } finally {
      proto.read = originalRead;
    }
  });
});

test('same-size content tamper fails digest verification', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    const swapped = Buffer.from(PAYLOAD.map((byte) => byte ^ 0x01));
    writeFileSync(contentLeaf, swapped);
    const error = await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_digest_mismatch');
    assertContentFree(error, root, PAYLOAD);
    assertContentFree(error, root, swapped);
  });
});

test('sidecar/ref conflict and malformed sidecars fail closed', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    await expectCode(
      () => readSanitizedArtifactV1(store, refFor(PAYLOAD, { media_type: 'application/json' })),
      'artifact_metadata_conflict',
    );
    const metaLeaf = path.join(root, 'sanitized', 'meta', 'runs', 'run-store-01',
      'lane-alpha', `diff.patch${ARTIFACT_STORE_META_SUFFIX}`);
    const original = readFileSync(metaLeaf);
    writeFileSync(metaLeaf, '{"schema":"nope"}\n');
    await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_metadata_malformed');
    writeFileSync(metaLeaf, original);
    const misplaced = JSON.stringify({
      schema: 'codex-co-engineer.artifact-store.v1',
      artifact_ref: refFor(PAYLOAD, { relative_path: 'runs/elsewhere/x.patch' }),
      byte_length: PAYLOAD.length,
      sha256: digestOf(PAYLOAD),
    });
    writeFileSync(metaLeaf, `${misplaced}\n`);
    await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_foreign_entry');
    writeFileSync(metaLeaf, original);
  });
});

test('symlinks, hardlinks, FIFOs, and devices are never followed or blocked on', async () => {
  if (isWindows) return;
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    const outside = mkdtempSync(path.join(tmpdir(), 'cce-p10-outside-'), { mode: 0o700 });
    try {
      const original = readFileSync(contentLeaf);
      rmSync(contentLeaf);
      symlinkSync(path.join(outside, 'bait.bin'), contentLeaf);
      writeFileSync(path.join(outside, 'bait.bin'), Buffer.from('bait bytes never adopted'));
      await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_entry_unsafe');
      rmSync(contentLeaf);
      writeFileSync(contentLeaf, original, { mode: 0o600 });

      const { link } = await import('node:fs/promises');
      await link(contentLeaf, path.join(outside, 'alias.bin'));
      await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_entry_unsafe');
      rmSync(path.join(outside, 'alias.bin'));

      rmSync(contentLeaf);
      const { execFileSync } = await import('node:child_process');
      execFileSync('mkfifo', [contentLeaf]);
      await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_entry_unsafe');
      rmSync(contentLeaf);
      writeFileSync(contentLeaf, original, { mode: 0o600 });

      const devicePath = `${contentLeaf}.dev`;
      try {
        execFileSync('mknod', [devicePath, 'c', '1', '3'], { stdio: 'ignore' });
        rmSync(contentLeaf);
        renameSync(devicePath, contentLeaf);
        await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_entry_unsafe');
        rmSync(contentLeaf);
        writeFileSync(contentLeaf, original, { mode: 0o600 });
      } catch {
        rmSync(devicePath, { force: true });
        if (!existsRegularFile(contentLeaf)) {
          rmSync(contentLeaf, { force: true });
          writeFileSync(contentLeaf, original, { mode: 0o600 });
        }
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('torn content, missing artifacts, and leftover temporaries fail closed', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    writeFileSync(path.join(path.dirname(contentLeaf), '.tmp-' + 'a'.repeat(32)), 'torn');
    await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_torn_temporary');
    rmSync(path.join(path.dirname(contentLeaf), '.tmp-' + 'a'.repeat(32)));

    const saved = readFileSync(contentLeaf);
    rmSync(contentLeaf);
    await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_torn_publication');
    writeFileSync(contentLeaf, saved, { mode: 0o600 });

    const missing = refFor(Buffer.from('nope'), { relative_path: 'runs/run-store-01/missing/x.bin' });
    await expectCode(() => readSanitizedArtifactV1(store, missing), 'artifact_not_found');
  });
});

test('root and path swaps are rejected; mid-read mutation cannot pass digest/stability checks', async () => {
  if (isWindows) return;
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const moved = `${root}-moved`;
    rmSync(moved, { recursive: true, force: true });
    renameSync(root, moved);
    mkdirSync(root, { mode: 0o700 });
    try {
      const error = await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_root_unsafe');
      assertContentFree(error, root, PAYLOAD);
    } finally {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
  });

  const large = Buffer.alloc(ARTIFACT_STORE_INGEST_CHUNK_BYTES + 2048, 0x71);
  await withPublished(large, { relative_path: 'runs/run-store-01/lane-alpha/mut.bin' }, async ({ root, store, ref }) => {
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'mut.bin');
    const proto = await fileHandlePrototype();
    const originalRead = proto.read;
    let mutated = false;
    proto.read = async function patchedRead(buffer, offset, length, position) {
      const result = await originalRead.apply(this, arguments);
      if (!mutated && buffer?.byteLength === ARTIFACT_STORE_INGEST_CHUNK_BYTES && result.bytesRead > 0) {
        writeFileSync(contentLeaf, Buffer.from(large.map((byte) => byte ^ 0x01)));
        mutated = true;
      }
      return result;
    };
    try {
      const error = await expectCode(() => readSanitizedArtifactV1(store, ref));
      assert.ok(
        error.code === 'artifact_digest_mismatch' || error.code === 'artifact_torn_publication'
          || error.code === 'artifact_length_mismatch' || error.code === 'artifact_entry_unsafe',
        `unexpected code ${error.code}`,
      );
      assertContentFree(error, root, large);
    } finally {
      proto.read = originalRead;
    }
  });
});

test('frozen output cannot be mutated; errors stay content-free', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const page = await readSanitizedArtifactV1(store, ref, { offset: 0, max_bytes: 8 });
    assert.equal(Object.isFrozen(page), true);
    assert.throws(() => { page.selected_content = 'mutated'; });
    assert.throws(() => { page.artifact_ref.relative_path = 'x'; });
    assert.equal(page.selected_content !== 'mutated', true);

    const probes = [
      () => readSanitizedArtifactV1(store, countingProxy(ref).proxy),
      () => readSanitizedArtifactV1(store, refFor(PAYLOAD, { artifact_class: 'raw' })),
      () => readSanitizedArtifactV1(store, ref, { offset: -1 }),
      () => readSanitizedArtifactV1(store, ref, { max_bytes: ARTIFACT_STORE_RANGE_READ_MAX_BYTES + 1 }),
      () => readSanitizedArtifactV1(store, refFor(PAYLOAD, { relative_path: '../escape' })),
      () => readSanitizedArtifactV1(store, refFor(PAYLOAD, { relative_path: 'runs/missing/nope.bin' })),
    ];
    for (const probe of probes) {
      try {
        await probe();
      } catch (error) {
        assert.ok(error instanceof RunContractV1Error);
        assertContentFree(error, root, PAYLOAD);
      }
    }
  });
});

test('group-readable stored files and chmod traps fail closed without leaking paths', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    chmodSync(contentLeaf, 0o644);
    const error = await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_entry_unsafe');
    assertContentFree(error, root, PAYLOAD);
    chmodSync(contentLeaf, 0o600);
  });
});

test('truncated content and oversized planted files fail verification on read', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const contentLeaf = path.join(root, 'sanitized', 'content', 'runs', 'run-store-01',
      'lane-alpha', 'diff.patch');
    writeFileSync(contentLeaf, PAYLOAD.subarray(0, 4));
    await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_entry_unsafe');
    writeFileSync(contentLeaf, PAYLOAD);
    writeFileSync(contentLeaf, Buffer.concat([PAYLOAD, Buffer.alloc(300 * 1024, 0x21)]));
    await expectCode(() => readSanitizedArtifactV1(store, ref), 'artifact_entry_unsafe');
  });
});
