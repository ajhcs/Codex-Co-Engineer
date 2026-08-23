import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_READER_ERROR_CODES,
  ARTIFACT_READER_MAX_RANGE_BYTES,
  ARTIFACT_READER_MAX_WIRE_BYTES,
  ARTIFACT_READER_OPTION_KEYS,
  ARTIFACT_READER_PAGE_KEYS,
  ARTIFACT_READER_SCHEMA_ID,
  parseSanitizedReaderOptionsV1,
  readSanitizedArtifactV1,
} from '../mcp/v3/artifact-reader.mjs';
import {
  ARTIFACT_STORE_INGEST_CHUNK_BYTES,
  ARTIFACT_STORE_RANGE_READ_MAX_BYTES,
} from '../mcp/v3/artifact-store.mjs';
import { MAX_SANITIZED_ARTIFACT_BYTE_LENGTH } from '../mcp/v3/artifact-ref.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  CHILD_B,
  decodeSelected,
  digestOf,
  longRelativePath,
  refFor,
  withPublished,
  withStore,
} from './fixtures/r1-artifact-reader-fixtures.mjs';

const PAYLOAD = Buffer.from('bounded sanitized reader payload for P10\n');

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

function errorOf(action, expectedCode, expectedPath) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (expectedCode !== undefined) assert.equal(error.code, expectedCode);
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
    return error;
  }
  assert.fail(`expected a typed ${expectedCode ?? 'RunContractV1Error'} failure`);
}

function assertUnknownProvenance(page) {
  assert.equal(page.source_byte_length, null);
  assert.equal(page.redaction_count, null);
  assert.equal(page.sanitizer_version, null);
  assert.equal(page.complete, null);
  assert.equal(page.upstream_truncated, null);
  assert.notEqual(page.complete, false);
  assert.notEqual(page.upstream_truncated, false);
  assert.notEqual(page.source_byte_length, 0);
  assert.notEqual(page.redaction_count, 0);
}

function assertPageShape(page) {
  assert.equal(page.schema, ARTIFACT_READER_SCHEMA_ID);
  assert.deepEqual(Object.keys(page), [...ARTIFACT_READER_PAGE_KEYS]);
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.artifact_ref), true);
  assert.equal(page.namespace, 'sanitized');
  assert.equal(page.selected_encoding, 'base64');
  assert.equal(typeof page.selected_content, 'string');
  assert.equal(decodeSelected(page).byteLength, page.selected_byte_length);
  assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= ARTIFACT_READER_MAX_WIRE_BYTES);
  assertUnknownProvenance(page);
}

test('the closed reader vocabulary and caps are exported frozen', () => {
  assert.equal(ARTIFACT_READER_SCHEMA_ID, 'codex-co-engineer.artifact-reader.v1');
  assert.equal(Object.isFrozen(ARTIFACT_READER_ERROR_CODES), true);
  assert.equal(Object.isFrozen(ARTIFACT_READER_OPTION_KEYS), true);
  assert.equal(Object.isFrozen(ARTIFACT_READER_PAGE_KEYS), true);
  assert.deepEqual([...ARTIFACT_READER_OPTION_KEYS], ['offset', 'max_bytes']);
  for (const code of ['raw_artifact_denied', 'out_of_range', 'invalid_type', 'unknown_key']) {
    assert.ok(ARTIFACT_READER_ERROR_CODES.includes(code), code);
  }
  assert.equal(ARTIFACT_READER_MAX_RANGE_BYTES, ARTIFACT_STORE_RANGE_READ_MAX_BYTES);
  assert.equal(ARTIFACT_READER_MAX_RANGE_BYTES, 8192);
  assert.equal(ARTIFACT_READER_MAX_WIRE_BYTES, 12288);
  assert.ok(ARTIFACT_READER_MAX_RANGE_BYTES < MAX_SANITIZED_ARTIFACT_BYTE_LENGTH);
  assert.ok(ARTIFACT_STORE_INGEST_CHUNK_BYTES < MAX_SANITIZED_ARTIFACT_BYTE_LENGTH);
});

test('the reader module does not import P09 sanitizer internals', () => {
  const source = readFileSync(fileURLToPath(new URL('../mcp/v3/artifact-reader.mjs', import.meta.url)), 'utf8');
  assert.equal(source.includes('artifact-sanitizer'), false);
  assert.equal(/from '\.\/.*sanitiz/u.test(source), false);
  assert.equal(source.includes('supervisor.mjs'), false);
  assert.equal(source.includes('server.mjs'), false);
});

test('option defaults and bounded intrinsic integers are validated before I/O', () => {
  assert.deepEqual(parseSanitizedReaderOptionsV1(), { offset: 0, max_bytes: ARTIFACT_READER_MAX_RANGE_BYTES });
  assert.deepEqual(parseSanitizedReaderOptionsV1({}), { offset: 0, max_bytes: ARTIFACT_READER_MAX_RANGE_BYTES });
  assert.deepEqual(
    parseSanitizedReaderOptionsV1({ offset: 4, max_bytes: 8 }),
    { offset: 4, max_bytes: 8 },
  );
  assert.equal(Object.isFrozen(parseSanitizedReaderOptionsV1({ offset: 1 })), true);

  errorOf(() => parseSanitizedReaderOptionsV1(null), 'invalid_type');
  errorOf(() => parseSanitizedReaderOptionsV1({ offset: -1 }), 'out_of_range', 'options.offset');
  errorOf(() => parseSanitizedReaderOptionsV1({ offset: 0.5 }), 'invalid_type', 'options.offset');
  errorOf(() => parseSanitizedReaderOptionsV1({ max_bytes: ARTIFACT_READER_MAX_RANGE_BYTES + 1 }),
    'out_of_range', 'options.max_bytes');
  errorOf(() => parseSanitizedReaderOptionsV1({ offset: MAX_SANITIZED_ARTIFACT_BYTE_LENGTH + 1 }),
    'out_of_range', 'options.offset');
  errorOf(() => parseSanitizedReaderOptionsV1({ extra: 1 }), 'unknown_key');
  errorOf(() => parseSanitizedReaderOptionsV1({ offset: '0' }), 'invalid_type', 'options.offset');
  errorOf(() => parseSanitizedReaderOptionsV1({ max_bytes: 1n }), 'invalid_json_type');
  errorOf(() => parseSanitizedReaderOptionsV1({ offset: Number.NaN }), 'invalid_json_value', 'options.offset');
  errorOf(() => parseSanitizedReaderOptionsV1({ offset: Number.POSITIVE_INFINITY }),
    'invalid_json_value', 'options.offset');
  errorOf(() => parseSanitizedReaderOptionsV1({ offset: Object(0) }), 'exotic_prototype_denied');
});

test('a small sanitized artifact returns a frozen JSON-safe page of the selected bytes', async () => {
  await withPublished(PAYLOAD, {}, async ({ root, store, ref }) => {
    const page = await readSanitizedArtifactV1(store, ref);
    assertPageShape(page);
    assert.equal(page.byte_length, PAYLOAD.length);
    assert.equal(page.sha256, digestOf(PAYLOAD));
    assert.equal(page.offset, 0);
    assert.equal(page.max_bytes, ARTIFACT_READER_MAX_RANGE_BYTES);
    assert.equal(page.selected_byte_length, PAYLOAD.length);
    assert.equal(decodeSelected(page).equals(PAYLOAD), true);
    assert.equal(page.reader_clipped, false);
    assert.equal(page.more, false);
    assert.equal(page.next_offset, null);
    const projected = JSON.stringify(page);
    assert.equal(projected.includes(root), false);
    assert.equal(projected.includes(path.basename(root)), false);
    JSON.parse(projected);
    const mutated = { ...ref, media_type: 'application/json' };
    assert.equal(page.artifact_ref.media_type, 'text/plain');
    assert.equal(mutated.media_type, 'application/json');
  });
});

test('range pages are deterministic and reconstruct the sanitized artifact', async () => {
  const bytes = Buffer.alloc(64, 0);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
  await withPublished(bytes, { relative_path: 'runs/run-store-01/lane-alpha/pages.bin' }, async ({ store, ref }) => {
    const pageSize = 16;
    const parts = [];
    let offset = 0;
    let pages = 0;
    while (true) {
      const page = await readSanitizedArtifactV1(store, ref, { offset, max_bytes: pageSize });
      assertPageShape(page);
      assert.equal(page.offset, offset);
      assert.equal(page.max_bytes, pageSize);
      const slice = decodeSelected(page);
      assert.equal(slice.equals(bytes.subarray(offset, offset + slice.length)), true);
      const again = await readSanitizedArtifactV1(store, ref, { offset, max_bytes: pageSize });
      assert.equal(again.selected_content, page.selected_content);
      assert.equal(again.next_offset, page.next_offset);
      parts.push(slice);
      pages += 1;
      if (!page.more) break;
      offset = page.next_offset;
    }
    assert.equal(pages, 4);
    assert.equal(Buffer.concat(parts).equals(bytes), true);
  });
});

test('range and cap boundaries include empty EOF and single-byte windows', async () => {
  await withPublished(PAYLOAD, {}, async ({ store, ref }) => {
    const empty = await readSanitizedArtifactV1(store, ref, { offset: PAYLOAD.length, max_bytes: 8 });
    assertPageShape(empty);
    assert.equal(empty.selected_byte_length, 0);
    assert.equal(empty.selected_content, '');
    assert.equal(empty.more, false);
    assert.equal(empty.reader_clipped, false);

    const none = await readSanitizedArtifactV1(store, ref, { offset: 0, max_bytes: 0 });
    assert.equal(none.selected_byte_length, 0);
    assert.equal(none.more, true);
    assert.equal(none.next_offset, 0);
    assert.equal(none.reader_clipped, false);

    const last = await readSanitizedArtifactV1(store, ref, {
      offset: PAYLOAD.length - 1, max_bytes: 1,
    });
    assert.equal(decodeSelected(last).equals(PAYLOAD.subarray(PAYLOAD.length - 1)), true);
    assert.equal(last.more, false);

    await errorOfAsync(
      () => readSanitizedArtifactV1(store, ref, { offset: PAYLOAD.length + 1, max_bytes: 1 }),
      'out_of_range',
      'offset',
    );
  });
});

test('raw ArtifactRefV1 is denied before any artifact I/O', async () => {
  await withStore(async ({ store, root }) => {
    const raw = Buffer.from('owner-only raw evidence that must never face the model');
    const rawRef = refFor(raw, { artifact_class: 'raw', relative_path: 'runs/run-store-01/raw/secret.bin' });
    await store.publish(rawRef, raw);
    const error = await errorOfAsync(
      () => readSanitizedArtifactV1(store, rawRef),
      'raw_artifact_denied',
      'artifact_ref.artifact_class',
    );
    assert.equal(error.message.includes(root), false);
    assert.equal(error.message.includes('secret'), false);
    assert.equal(error.message.includes(raw.toString('utf8')), false);
    assert.equal((await store.verifyArtifact(rawRef)).verified, true);
  });
});

test('disjoint raw and sanitized siblings at one path: only sanitized is readable', async () => {
  await withStore(async ({ store }) => {
    const shared = 'runs/run-store-01/shared/report.bin';
    const sanitized = Buffer.from('model-facing projection');
    const raw = Buffer.from('owner-only local evidence');
    const sanitizedRef = refFor(sanitized, { relative_path: shared });
    const rawRef = refFor(raw, { relative_path: shared, artifact_class: 'raw', assignment_id: CHILD_B });
    await store.publish(sanitizedRef, sanitized);
    await store.publish(rawRef, raw);
    const page = await readSanitizedArtifactV1(store, sanitizedRef);
    assert.equal(decodeSelected(page).equals(sanitized), true);
    await errorOfAsync(() => readSanitizedArtifactV1(store, rawRef), 'raw_artifact_denied');
  });
});

test('a max-range page of a larger artifact pages rather than claiming completeness', async () => {
  const bytes = Buffer.alloc(ARTIFACT_READER_MAX_RANGE_BYTES + 64, 0x61);
  await withPublished(bytes, { relative_path: 'runs/run-store-01/lane-alpha/large.bin' }, async ({ store, ref }) => {
    const page = await readSanitizedArtifactV1(store, ref);
    assertPageShape(page);
    assert.equal(page.byte_length, bytes.length);
    assert.ok(page.selected_byte_length <= ARTIFACT_READER_MAX_RANGE_BYTES);
    assert.equal(page.more, true);
    assert.equal(typeof page.next_offset, 'number');
    assert.equal(page.complete, null);
    assert.equal(page.upstream_truncated, null);
    const rest = await readSanitizedArtifactV1(store, ref, {
      offset: page.next_offset,
      max_bytes: ARTIFACT_READER_MAX_RANGE_BYTES,
    });
    assert.equal(Buffer.concat([decodeSelected(page), decodeSelected(rest)]).equals(bytes), true);
  });
});

test('a long relative path plus a max range is clipped by the wire cap, not marked upstream-truncated', async () => {
  const bytes = Buffer.alloc(ARTIFACT_READER_MAX_RANGE_BYTES, 0x62);
  await withPublished(bytes, { relative_path: longRelativePath() }, async ({ store, ref }) => {
    const page = await readSanitizedArtifactV1(store, ref, {
      offset: 0, max_bytes: ARTIFACT_READER_MAX_RANGE_BYTES,
    });
    assertPageShape(page);
    assert.equal(page.reader_clipped, true);
    assert.equal(page.more, true);
    assert.ok(page.selected_byte_length < ARTIFACT_READER_MAX_RANGE_BYTES);
    assert.equal(page.upstream_truncated, null);
    assert.equal(page.complete, null);
    assert.equal(decodeSelected(page).equals(bytes.subarray(0, page.selected_byte_length)), true);
  });
});

test('Unicode bytes round-trip and a range may split a multibyte sequence', async () => {
  const text = Buffer.from('日本語🎨 café', 'utf8');
  await withPublished(text, {
    relative_path: 'runs/run-store-01/lane-日本語/note-🎨.md',
    media_type: 'text/markdown',
  }, async ({ store, ref }) => {
    const full = await readSanitizedArtifactV1(store, ref);
    assert.equal(decodeSelected(full).equals(text), true);
    const split = await readSanitizedArtifactV1(store, ref, { offset: 1, max_bytes: 1 });
    assert.equal(split.selected_byte_length, 1);
    assert.equal(decodeSelected(split)[0], text[1]);
  });
});

test('invalid UTF-8 and interior NUL bytes stay exact base64 ranges', async () => {
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f]);
  await withPublished(binary, {
    relative_path: 'runs/run-store-01/lane-alpha/binary.bin',
    media_type: 'application/octet-stream',
  }, async ({ store, ref }) => {
    const page = await readSanitizedArtifactV1(store, ref);
    assert.equal(decodeSelected(page).equals(binary), true);
    JSON.stringify(page);
  });
});

test('content_encoding on the ref does not reinterpret stored byte offsets', async () => {
  const bytes = Buffer.from('not-really-base64-payload');
  await withPublished(bytes, {
    relative_path: 'runs/run-store-01/lane-alpha/encoded.bin',
    content_encoding: 'base64',
  }, async ({ store, ref }) => {
    const page = await readSanitizedArtifactV1(store, ref, { offset: 4, max_bytes: 7 });
    assert.equal(decodeSelected(page).equals(bytes.subarray(4, 11)), true);
    assert.equal(page.selected_encoding, 'base64');
  });
});
