import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';
import test from 'node:test';

import {
  ARTIFACT_SANITIZER_REPLACEMENT,
  sanitizeAndPublishArtifactV1,
} from '../mcp/v3/artifact-sanitizer.mjs';
import { openArtifactStoreV1 } from '../mcp/v3/artifact-store.mjs';
import {
  MAX_RAW_ARTIFACT_BYTE_LENGTH,
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
} from '../mcp/v3/artifact-ref.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-artifact-fixtures.mjs';
import {
  accessorIterable,
  CHILD_A,
  digestOf,
  emptyStream,
  endlessSource,
  makeStoreRoot,
  MALFORMED_RAW,
  MALFORMED_SANITIZED,
  rawRefFor,
  removeRoot,
  RUN_ID,
  SAMPLES,
  shortSource,
  splitAt,
  stringChunkSource,
  SubclassedBytes,
  throwingSource,
  UNPAIRED_RAW,
  UNPAIRED_SANITIZED,
} from './fixtures/r1-artifact-sanitizer-fixtures.mjs';

async function expectCode(action, code, expectedPath) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (code !== undefined) {
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    }
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
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
    const text = bytes.toString('utf8');
    if (text.trim().length > 0) {
      assert.equal(message.includes(text.trim()), false, 'error echoed artifact bytes');
    }
  }
  assert.equal(message.includes('sk-live-secret'), false);
  assert.equal(message.includes('super-secret-value'), false);
}

async function withStore(fn) {
  const root = makeStoreRoot();
  try {
    const store = await openArtifactStoreV1({ root });
    return await fn(store, root);
  } finally {
    removeRoot(root);
  }
}

test('every byte split of credentials, prompts, and UTF-8 is deterministic', async () => {
  await withStore(async (store) => {
    const cases = [
      ['credential', SAMPLES.credentialFormat],
      ['bearer', SAMPLES.bearer],
      ['env', SAMPLES.envAssignment],
      ['url', SAMPLES.urlCredential],
      ['prompt', SAMPLES.prompt],
      ['astral', SAMPLES.astral],
    ];
    for (const [name, sample] of cases) {
      const unsplit = await sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/unsplit/${name}.txt`,
        }),
        source: sample.raw,
      });
      assert.equal(unsplit.sanitized_digest, digestOf(sample.sanitized), name);
      for (let offset = 0; offset <= sample.raw.byteLength; offset += 1) {
        const provenance = await sanitizeAndPublishArtifactV1(store, {
          artifact_ref: rawRefFor(sample.raw, {
            relative_path: `runs/${RUN_ID}/splits/${name}/${offset}.txt`,
          }),
          source: splitAt(sample.raw, offset),
        });
        assert.equal(provenance.sanitized_digest, unsplit.sanitized_digest, `${name}@${offset}`);
        assert.deepEqual(provenance.redaction_counts, sample.counts, `${name}@${offset}`);
        assert.equal(provenance.source_digest, digestOf(sample.raw), `${name}@${offset}`);
        assert.equal(provenance.sanitized_byte_length, sample.sanitized.byteLength, `${name}@${offset}`);
      }
    }
  });
});

test('malformed and unpaired UTF-8 splits never clip and stay pinned', async () => {
  await withStore(async (store) => {
    const malformed = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(MALFORMED_RAW),
      source: MALFORMED_RAW,
    });
    assert.equal(malformed.sanitized_digest, digestOf(MALFORMED_SANITIZED));
    const unpaired = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(UNPAIRED_RAW, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/unpaired.txt`,
      }),
      source: UNPAIRED_RAW,
    });
    assert.equal(unpaired.sanitized_digest, digestOf(UNPAIRED_SANITIZED));
    for (const [label, bytes, expected] of [
      ['malformed', MALFORMED_RAW, malformed],
      ['unpaired', UNPAIRED_RAW, unpaired],
    ]) {
      for (let offset = 0; offset <= bytes.byteLength; offset += 1) {
        const provenance = await sanitizeAndPublishArtifactV1(store, {
          artifact_ref: rawRefFor(bytes, {
            relative_path: `runs/${RUN_ID}/unicode/${label}-${offset}.txt`,
          }),
          source: splitAt(bytes, offset),
        });
        assert.equal(provenance.sanitized_digest, expected.sanitized_digest, `${label}@${offset}`);
      }
    }
  });
});

test('oversized, endless, huge, short, and over-declared streams fail without publication', async () => {
  await withStore(async (store, root) => {
    const overSanitized = Buffer.alloc(MAX_SANITIZED_ARTIFACT_BYTE_LENGTH + 1, 0x61);
    const overSanitizedError = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(overSanitized, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/over-sanitized.txt`,
        }),
        source: overSanitized,
      }),
      'artifact_stream_over_cap',
      'sanitized',
    );
    assertContentFree(overSanitizedError, root, overSanitized);

    const atRawCap = rawRefFor(Buffer.alloc(1, 0x61), {
      relative_path: `runs/${RUN_ID}/${CHILD_A}/over-raw.txt`,
      byte_length: MAX_RAW_ARTIFACT_BYTE_LENGTH,
      sha256: 'ab'.repeat(32),
    });
    const overRawError = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: atRawCap,
        source: Buffer.alloc(MAX_RAW_ARTIFACT_BYTE_LENGTH + 1, 0x61),
      }),
      'artifact_stream_over_cap',
      'source',
    );
    assertContentFree(overRawError, root);

    const endlessError = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(Buffer.alloc(1, 0x61), {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/endless.txt`,
          byte_length: MAX_RAW_ARTIFACT_BYTE_LENGTH,
          sha256: 'ab'.repeat(32),
        }),
        source: endlessSource(),
      }),
      'artifact_stream_over_cap',
    );
    assertContentFree(endlessError, root);

    const declared = rawRefFor(Buffer.alloc(16, 0x61), {
      relative_path: `runs/${RUN_ID}/${CHILD_A}/short.txt`,
    });
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: declared,
        source: shortSource(16, 4),
      }),
      'artifact_length_mismatch',
    );
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: declared,
        source: emptyStream(),
      }),
      'artifact_length_mismatch',
    );
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: declared,
        source: (async function* grow() {
          yield Buffer.alloc(16, 0x61);
          yield Buffer.alloc(2, 0x61);
        })(),
      }),
      'artifact_length_mismatch',
    );

    const streamError = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: declared,
        source: throwingSource(new Error('secret internals about the host filesystem')),
      }),
      'artifact_stream_failed',
    );
    assert.equal(streamError.message.includes('secret internals'), false);
    assert.equal((await store.audit()).artifacts, 0);
  });
});

const INTRINSIC_VIEW_SURFACE_KEYS = ['buffer', 'byteOffset', 'byteLength', 'subarray'];

function copyView(kind, bytes) {
  return kind === 'Buffer' ? Buffer.from(bytes) : Uint8Array.from(bytes);
}

function dressAccessor(view, key, trap) {
  Object.defineProperty(view, key, {
    configurable: true,
    enumerable: false,
    get() {
      trap.runs += 1;
      throw new Error('attacker getter must never run');
    },
    set() {
      trap.runs += 1;
      throw new Error('attacker setter must never run');
    },
  });
  return view;
}

function dressData(view, key) {
  const attacker = Buffer.from('ATTACKER_SUBSTITUTED_BYTES\n');
  let value;
  if (key === 'buffer') value = attacker.buffer;
  else if (key === 'byteOffset') value = 1;
  else if (key === 'byteLength') value = 1;
  else value = () => attacker;
  Object.defineProperty(view, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
  return view;
}

async function* streamOf(view) {
  yield view;
}

test('own accessors and data overrides on intrinsic byte views fail closed without traps or substitution', async () => {
  await withStore(async (store, root) => {
    const sample = SAMPLES.plain;
    const viaBuffer = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/clean-buffer.txt`,
      }),
      source: sample.raw,
    });
    const uint8 = Uint8Array.from(sample.raw);
    const viaUint8 = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(uint8, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/clean-uint8.txt`,
      }),
      source: uint8,
    });
    assert.equal(viaBuffer.source_digest, digestOf(sample.raw));
    assert.equal(viaUint8.source_digest, viaBuffer.source_digest);
    assert.equal(viaUint8.sanitized_digest, viaBuffer.sanitized_digest);
    assert.equal(viaBuffer.sanitized_digest, digestOf(sample.sanitized));

    const viaUint8Stream = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(uint8, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/clean-uint8-stream.txt`,
      }),
      source: streamOf(Uint8Array.from(sample.raw)),
    });
    assert.equal(viaUint8Stream.source_digest, viaBuffer.source_digest);
    assert.equal(viaUint8Stream.sanitized_digest, viaBuffer.sanitized_digest);

    let caseIndex = 0;
    for (const kind of ['Buffer', 'Uint8Array']) {
      for (const key of INTRINSIC_VIEW_SURFACE_KEYS) {
        for (const dress of ['accessor', 'data']) {
          for (const mode of ['source', 'chunk']) {
            caseIndex += 1;
            const trap = { runs: 0 };
            const view = copyView(kind, sample.raw);
            if (dress === 'accessor') dressAccessor(view, key, trap);
            else dressData(view, key);
            const expectedCode = mode === 'chunk'
              ? 'artifact_stream_invalid_chunk'
              : 'artifact_stream_invalid_source';
            const source = mode === 'chunk' ? streamOf(view) : view;
            const error = await expectCode(
              () => sanitizeAndPublishArtifactV1(store, {
                artifact_ref: rawRefFor(sample.raw, {
                  relative_path: `runs/${RUN_ID}/${CHILD_A}/override-${caseIndex}.txt`,
                }),
                source,
              }),
              expectedCode,
              'source',
            );
            assert.equal(trap.runs, 0, `${kind} ${key} ${dress} ${mode} executed a getter`);
            assertContentFree(error, root, sample.raw);
            assert.equal(error.message.includes('attacker getter'), false);
            assert.equal(error.message.includes('ATTACKER_SUBSTITUTED_BYTES'), false);
            assert.equal(error instanceof RunContractV1Error, true);
            assert.equal(error.code, expectedCode);
          }
        }
      }
    }

    const substituting = Buffer.from(sample.raw);
    let substituteRuns = 0;
    Object.defineProperty(substituting, 'byteLength', {
      configurable: true,
      get() {
        substituteRuns += 1;
        return 0;
      },
    });
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/substituting-byteLength.txt`,
        }),
        source: substituting,
      }),
      'artifact_stream_invalid_source',
      'source',
    );
    assert.equal(substituteRuns, 0);

    const report = await store.audit();
    assert.equal(report.artifacts, 6);
    assert.equal(report.namespaces.raw.artifacts, 3);
    assert.equal(report.namespaces.sanitized.artifacts, 3);
  });
});

test('proxy, revoked proxy, subclass, shared buffer, accessor, and arbitrary streams fail closed', async () => {
  await withStore(async (store, root) => {
    const sample = SAMPLES.credentialFormat;
    const ref = rawRefFor(sample.raw);

    const { proxy, counts } = countingProxy(sample.raw);
    const proxyError = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: proxy }),
      'proxy_denied',
    );
    assertContentFree(proxyError, root, sample.raw);
    assert.equal(trapTotal(counts), 0);

    const { proxy: revoked, revoke } = Proxy.revocable(sample.raw, {
      get() { throw new Error('revoked get'); },
    });
    revoke();
    assert.equal(utilTypes.isProxy(revoked), true);
    const revokedError = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: revoked }),
      'proxy_denied',
    );
    assertContentFree(revokedError, root, sample.raw);

    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: ref,
        source: new SubclassedBytes(sample.raw.byteLength),
      }),
      'artifact_stream_invalid_source',
    );

    const shared = new Uint8Array(new SharedArrayBuffer(8));
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: shared }),
      'artifact_stream_invalid_source',
    );

    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: 'text' }),
      'artifact_stream_invalid_source',
    );
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: 42 }),
      'artifact_stream_invalid_source',
    );

    const trapLog = { iteratorGetter: 0 };
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: accessorIterable(trapLog) }),
      'artifact_stream_invalid_source',
    );
    assert.equal(trapLog.iteratorGetter, 0);

    class FakeStream {
      async *[Symbol.asyncIterator]() { yield sample.raw; }
    }
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: new FakeStream() }),
      'artifact_stream_invalid_source',
    );

    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: ref, source: stringChunkSource() }),
      'artifact_stream_invalid_chunk',
    );

    let getterRuns = 0;
    const accessorOptions = {
      artifact_ref: ref,
      source: sample.raw,
    };
    Object.defineProperty(accessorOptions, 'source_truncated', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return true;
      },
    });
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, accessorOptions),
      'accessor_property_denied',
    );
    assert.equal(getterRuns, 0);

    assert.equal((await store.audit()).artifacts, 0);
  });
});

test('declared digest mismatch, caller regex, and option hostility fail content-free', async () => {
  await withStore(async (store, root) => {
    const sample = SAMPLES.mixed;
    const digestError = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, { sha256: 'cd'.repeat(32) }),
        source: sample.raw,
      }),
      'artifact_digest_mismatch',
    );
    assertContentFree(digestError, root, sample.raw);

    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw),
        source: sample.raw,
        policy: { regex: /secret/u },
      }),
      'unknown_key',
    );

    const { proxy, counts } = countingProxy(rawRefFor(sample.raw));
    await expectCode(
      () => sanitizeAndPublishArtifactV1(store, { artifact_ref: proxy, source: sample.raw }),
      'proxy_denied',
    );
    assert.equal(trapTotal(counts), 0);

    assert.equal((await store.audit()).artifacts, 0);
  });
});

test('idempotent replay, conflict, truncation, and class separation stay truthful', async () => {
  await withStore(async (store, root) => {
    const sample = SAMPLES.github;
    const first = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
      source_truncated: true,
    });
    assert.equal(first.complete, false);
    assert.equal(first.source_truncated, true);
    assert.equal(first.sanitized_digest, digestOf(sample.sanitized));
    assert.deepEqual(first.redaction_counts, sample.counts);

    const replay = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
      source_truncated: true,
    });
    assert.equal(replay.sanitized_digest, first.sanitized_digest);
    assert.equal(replay.source_digest, first.source_digest);
    assert.equal((await store.verifyArtifact(first.raw_ref)).verified, true);
    assert.equal((await store.verifyArtifact(first.sanitized_ref)).verified, true);

    const other = Buffer.from('conflicting sanitizer payload\n');
    const conflict = await expectCode(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(other),
        source: other,
      }),
      'artifact_content_conflict',
    );
    assertContentFree(conflict, root, other);

    const report = await store.audit();
    assert.equal(report.artifacts, 2);
    assert.equal(report.namespaces.raw.artifacts, 1);
    assert.equal(report.namespaces.sanitized.artifacts, 1);
    const projected = JSON.stringify(first);
    assert.equal(projected.includes(root), false);
    assert.equal(projected.includes('ghs_abcdefghijklmnop'), false);
    assert.equal(projected.includes(ARTIFACT_SANITIZER_REPLACEMENT), false);
  });
});
