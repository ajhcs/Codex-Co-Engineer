import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  ARTIFACT_SANITIZER_ERROR_CODES,
  ARTIFACT_SANITIZER_INGEST_CHUNK_BYTES,
  ARTIFACT_SANITIZER_OVERLAP_CHARS,
  ARTIFACT_SANITIZER_POLICY_ID,
  ARTIFACT_SANITIZER_REPLACEMENT,
  ARTIFACT_SANITIZER_SCHEMA_ID,
  ARTIFACT_SANITIZER_VERSION,
  REDACTION_KINDS,
  SANITIZER_CONTENT_ENCODING,
  SANITIZER_MEDIA_TYPES,
  sanitizeAndPublishArtifactV1,
} from '../mcp/v3/artifact-sanitizer.mjs';
import {
  ARTIFACT_STORE_SCHEMA_ID,
  openArtifactStoreV1,
} from '../mcp/v3/artifact-store.mjs';
import {
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
} from '../mcp/v3/artifact-ref.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  byteSplits,
  CHILD_A,
  CHILD_B,
  chunksOf,
  digestOf,
  makeStoreRoot,
  MALFORMED_RAW,
  MALFORMED_SANITIZED,
  rawRefFor,
  removeRoot,
  RUN_ID,
  SAMPLES,
  splitAt,
  UNPAIRED_RAW,
  UNPAIRED_SANITIZED,
} from './fixtures/r1-artifact-sanitizer-fixtures.mjs';

async function errorOfAsync(action, expectedCode, expectedPath) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    if (expectedCode !== undefined) {
      assert.equal(error.code, expectedCode, `expected ${expectedCode}, got ${error.code}: ${error.message}`);
    }
    if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
    return error;
  }
  assert.fail(`expected a typed ${expectedCode ?? 'RunContractV1Error'} failure`);
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

function assertProvenanceShape(provenance, sample, { sourceTruncated = false } = {}) {
  assert.equal(provenance.schema, ARTIFACT_SANITIZER_SCHEMA_ID);
  assert.equal(provenance.sanitizer_version, ARTIFACT_SANITIZER_VERSION);
  assert.equal(provenance.policy_id, ARTIFACT_SANITIZER_POLICY_ID);
  assert.deepEqual(Object.keys(provenance), [
    'schema', 'sanitizer_version', 'policy_id', 'source_digest', 'source_byte_length',
    'raw_ref', 'sanitized_ref', 'sanitized_digest', 'sanitized_byte_length',
    'redaction_counts', 'complete', 'source_truncated',
  ]);
  assert.equal(provenance.source_digest, digestOf(sample.raw));
  assert.equal(provenance.source_byte_length, sample.raw.byteLength);
  assert.equal(provenance.sanitized_digest, digestOf(sample.sanitized));
  assert.equal(provenance.sanitized_byte_length, sample.sanitized.byteLength);
  assert.deepEqual(provenance.redaction_counts, sample.counts);
  assert.equal(provenance.source_truncated, sourceTruncated);
  assert.equal(provenance.complete, sourceTruncated !== true);
  assert.equal(provenance.raw_ref.artifact_class, 'raw');
  assert.equal(provenance.sanitized_ref.artifact_class, 'sanitized');
  assert.equal(provenance.raw_ref.relative_path, provenance.sanitized_ref.relative_path);
  assert.equal(Object.isFrozen(provenance), true);
  assert.equal(Object.isFrozen(provenance.sanitized_ref), true);
  assert.equal(Object.isFrozen(provenance.redaction_counts), true);
}

test('the closed vocabulary and version constants are exported frozen', () => {
  assert.equal(ARTIFACT_SANITIZER_SCHEMA_ID, 'codex-co-engineer.artifact-sanitizer.v1');
  assert.equal(ARTIFACT_SANITIZER_VERSION, 1);
  assert.equal(ARTIFACT_SANITIZER_POLICY_ID, 'codex-co-engineer.artifact-redaction.v1');
  assert.equal(SANITIZER_CONTENT_ENCODING, 'identity');
  assert.equal(ARTIFACT_SANITIZER_REPLACEMENT, '[REDACTED]');
  assert.equal(ARTIFACT_SANITIZER_INGEST_CHUNK_BYTES > 0, true);
  assert.equal(ARTIFACT_SANITIZER_OVERLAP_CHARS > 0, true);
  assert.deepEqual([...SANITIZER_MEDIA_TYPES], [
    'application/json', 'application/x-ndjson', 'text/markdown', 'text/plain',
  ]);
  assert.deepEqual([...REDACTION_KINDS], [
    'credential_formats', 'bearer_credentials', 'env_assignments', 'url_credentials', 'prompts',
  ]);
  assert.equal(Object.isFrozen(SANITIZER_MEDIA_TYPES), true);
  assert.equal(Object.isFrozen(REDACTION_KINDS), true);
  assert.equal(Object.isFrozen(ARTIFACT_SANITIZER_ERROR_CODES), true);
  for (const code of [
    'artifact_stream_over_cap', 'artifact_stream_invalid_source', 'artifact_stream_invalid_chunk',
    'sanitizer_media_type_denied', 'sanitizer_content_encoding_denied', 'sanitizer_empty_output',
  ]) {
    assert.ok(ARTIFACT_SANITIZER_ERROR_CODES.includes(code), code);
  }
});

test('a validated buffer source publishes raw and sanitized and returns frozen provenance', async () => {
  await withStore(async (store, root) => {
    const sample = SAMPLES.plain;
    const provenance = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
    });
    assertProvenanceShape(provenance, sample);
    assert.equal(await store.verifyArtifact(provenance.raw_ref).then((v) => v.verified), true);
    assert.equal(await store.verifyArtifact(provenance.sanitized_ref).then((v) => v.verified), true);
    const projected = JSON.stringify(provenance);
    assert.equal(projected.includes(root), false);
    assert.equal(projected.includes(path.basename(root)), false);
    assert.equal(projected.includes(sample.raw.toString('utf8').trim()), false);
    const report = await store.audit();
    assert.equal(report.schema, ARTIFACT_STORE_SCHEMA_ID);
    assert.equal(report.artifacts, 2);
    assert.equal(report.namespaces.raw.artifacts, 1);
    assert.equal(report.namespaces.sanitized.artifacts, 1);
  });
});

test('intrinsic Buffer and Uint8Array views keep the same digest; own surface overrides are denied', async () => {
  await withStore(async (store, root) => {
    const sample = SAMPLES.plain;
    const viaBuffer = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/buffer.txt`,
      }),
      source: sample.raw,
    });
    const uint8 = Uint8Array.from(sample.raw);
    const viaUint8 = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(uint8, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/uint8.txt`,
      }),
      source: uint8,
    });
    assert.equal(viaBuffer.source_digest, digestOf(sample.raw));
    assert.equal(viaUint8.source_digest, viaBuffer.source_digest);
    assert.equal(viaUint8.sanitized_digest, viaBuffer.sanitized_digest);
    assertProvenanceShape(viaBuffer, sample);
    assertProvenanceShape(viaUint8, sample);

    let getterRuns = 0;
    const dressed = Buffer.from(sample.raw);
    Object.defineProperty(dressed, 'byteLength', {
      configurable: true,
      get() {
        getterRuns += 1;
        throw new Error('attacker getter must never run');
      },
    });
    const dressedError = await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/dressed-source.txt`,
        }),
        source: dressed,
      }),
      'artifact_stream_invalid_source',
      'source',
    );
    assert.equal(getterRuns, 0);
    assert.equal(dressedError.message.includes('attacker getter'), false);
    assert.equal(dressedError.message.includes(root), false);

    const attacker = Buffer.from('ATTACKER_SUBSTITUTED_BYTES\n');
    const overridden = Uint8Array.from(sample.raw);
    Object.defineProperty(overridden, 'subarray', {
      configurable: true,
      writable: true,
      value() { return attacker; },
    });
    async function* dressedChunk() { yield overridden; }
    const chunkError = await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/dressed-chunk.txt`,
        }),
        source: dressedChunk(),
      }),
      'artifact_stream_invalid_chunk',
      'source',
    );
    assert.equal(chunkError.message.includes('ATTACKER_SUBSTITUTED_BYTES'), false);
    const report = await store.audit();
    assert.equal(report.artifacts, 4);
    assert.equal(report.namespaces.raw.artifacts, 2);
    assert.equal(report.namespaces.sanitized.artifacts, 2);
  });
});

test('buffer and bounded async stream sources produce identical sanitized digests', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.plain;
    const viaBuffer = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
    });
    const streamRef = rawRefFor(sample.raw, {
      assignment_id: CHILD_B,
      relative_path: `runs/${RUN_ID}/${CHILD_B}/artifact.txt`,
    });
    const viaStream = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: streamRef,
      source: chunksOf(sample.raw, 5),
    });
    assert.equal(viaBuffer.sanitized_digest, viaStream.sanitized_digest);
    assert.equal(viaBuffer.source_digest, viaStream.source_digest);
    assert.deepEqual(viaBuffer.redaction_counts, viaStream.redaction_counts);
    assertProvenanceShape(viaBuffer, sample);
    assertProvenanceShape(viaStream, sample);
  });
});

test('the built-in policy redacts credentials, bearer, env, URL, and prompt forms', async () => {
  await withStore(async (store) => {
    const cases = [
      ['credentialFormat', SAMPLES.credentialFormat],
      ['bearer', SAMPLES.bearer],
      ['envAssignment', SAMPLES.envAssignment],
      ['urlCredential', SAMPLES.urlCredential],
      ['prompt', SAMPLES.prompt],
      ['mixed', SAMPLES.mixed],
      ['github', SAMPLES.github],
      ['aws', SAMPLES.aws],
      ['cursorKey', SAMPLES.cursorKey],
    ];
    for (const [name, sample] of cases) {
      const provenance = await sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/${name}.txt`,
        }),
        source: sample.raw,
      });
      assertProvenanceShape(provenance, sample);
      assert.equal(provenance.sanitized_digest, digestOf(sample.sanitized), name);
    }
  });
});

test('json and markdown identity-encoded text media types are accepted', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.prompt;
    for (const mediaType of ['application/json', 'application/x-ndjson', 'text/markdown']) {
      const bytes = sample.raw;
      const provenance = await sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(bytes, {
          media_type: mediaType,
          relative_path: `runs/${RUN_ID}/${CHILD_A}/${mediaType.replace('/', '-')}.txt`,
        }),
        source: bytes,
      });
      assert.equal(provenance.sanitized_ref.media_type, mediaType);
      assert.equal(provenance.sanitized_digest, digestOf(sample.sanitized));
    }
  });
});

test('octet-stream and non-identity encodings are refused before publication', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.plain;
    await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, { media_type: 'application/octet-stream' }),
        source: sample.raw,
      }),
      'sanitizer_media_type_denied',
      'artifact_ref.media_type',
    );
    await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, { content_encoding: 'base64' }),
        source: sample.raw,
      }),
      'sanitizer_content_encoding_denied',
      'artifact_ref.content_encoding',
    );
    await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, { artifact_class: 'sanitized' }),
        source: sample.raw,
      }),
      'unknown_artifact_class',
      'artifact_ref.artifact_class',
    );
    assert.equal((await store.audit()).artifacts, 0);
  });
});

test('source_truncated is recorded truthfully and never inferred by clipping', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.plain;
    const provenance = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
      source_truncated: true,
    });
    assertProvenanceShape(provenance, sample, { sourceTruncated: true });
    assert.equal(provenance.complete, false);
    assert.equal(provenance.sanitized_byte_length, sample.sanitized.byteLength);
    assert.equal(provenance.sanitized_byte_length <= MAX_SANITIZED_ARTIFACT_BYTE_LENGTH, true);
  });
});

test('exact same validated ref plus bytes is idempotent; conflicting content is not', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.plain;
    const first = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
    });
    const replay = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
    });
    assert.equal(first.source_digest, replay.source_digest);
    assert.equal(first.sanitized_digest, replay.sanitized_digest);
    assert.equal(first.sanitized_ref.sha256, replay.sanitized_ref.sha256);
    const other = Buffer.from('conflicting sanitizer payload\n');
    await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(other),
        source: other,
      }),
      'artifact_content_conflict',
    );
    assert.equal((await store.audit()).artifacts, 2);
  });
});

test('provenance and denials are content-free', async () => {
  await withStore(async (store, root) => {
    const sample = SAMPLES.credentialFormat;
    const error = await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, { sha256: 'bb'.repeat(32) }),
        source: sample.raw,
      }),
      'artifact_digest_mismatch',
    );
    const message = `${error.message}`;
    assert.equal(message.includes(root), false);
    assert.equal(message.includes('sk-live-secret'), false);
    assert.equal(message.includes('ENOENT'), false);
    const provenance = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/clean.txt`,
      }),
      source: sample.raw,
    });
    const projected = JSON.stringify(provenance);
    assert.equal(projected.includes('sk-live-secret'), false);
    assert.equal(projected.includes(ARTIFACT_SANITIZER_REPLACEMENT) === false
      || projected.includes(sample.raw.toString('utf8')) === false, true);
    assert.equal(projected.includes(root), false);
  });
});

test('secrets split across a chunk boundary redact to the same bytes and counts', async () => {
  await withStore(async (store) => {
    const cases = [
      ['credential', SAMPLES.credentialFormat, 9],
      ['bearer', SAMPLES.bearer, 20],
      ['env', SAMPLES.envAssignment, 16],
      ['url', SAMPLES.urlCredential, 18],
      ['prompt', SAMPLES.prompt, 12],
    ];
    for (const [name, sample, offset] of cases) {
      const unsplit = await sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/unsplit-${name}.txt`,
        }),
        source: sample.raw,
      });
      const provenance = await sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/split-${name}.txt`,
        }),
        source: splitAt(sample.raw, offset),
      });
      assert.equal(provenance.sanitized_digest, unsplit.sanitized_digest, name);
      assert.equal(provenance.sanitized_digest, digestOf(sample.sanitized), name);
      assert.deepEqual(provenance.redaction_counts, sample.counts, name);
    }
  });
});

test('one-byte streams and mixed-policy splits stay deterministic', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.mixed;
    const viaBytes = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: byteSplits(sample.raw),
    });
    assertProvenanceShape(viaBytes, sample);
    const viaFive = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw, {
        assignment_id: CHILD_B,
        relative_path: `runs/${RUN_ID}/${CHILD_B}/mixed.txt`,
      }),
      source: chunksOf(sample.raw, 5),
    });
    assert.equal(viaFive.sanitized_digest, viaBytes.sanitized_digest);
    assert.deepEqual(viaFive.redaction_counts, sample.counts);
  });
});

test('astral UTF-8 sequences survive every split without clipping', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.astral;
    const unsplit = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(sample.raw),
      source: sample.raw,
    });
    assertProvenanceShape(unsplit, sample);
    for (let offset = 0; offset <= sample.raw.byteLength; offset += 1) {
      const provenance = await sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/astral-${offset}.txt`,
        }),
        source: splitAt(sample.raw, offset),
      });
      assert.equal(provenance.sanitized_digest, unsplit.sanitized_digest);
      assert.equal(provenance.sanitized_byte_length, sample.sanitized.byteLength);
    }
  });
});

test('malformed and unpaired UTF-8 become U+FFFD deterministically', async () => {
  await withStore(async (store) => {
    const malformed = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(MALFORMED_RAW),
      source: MALFORMED_RAW,
    });
    assert.equal(malformed.sanitized_digest, digestOf(MALFORMED_SANITIZED));
    const malformedSplit = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(MALFORMED_RAW, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/malformed-split.txt`,
      }),
      source: splitAt(MALFORMED_RAW, 2),
    });
    assert.equal(malformedSplit.sanitized_digest, malformed.sanitized_digest);

    const unpaired = await sanitizeAndPublishArtifactV1(store, {
      artifact_ref: rawRefFor(UNPAIRED_RAW, {
        relative_path: `runs/${RUN_ID}/${CHILD_A}/unpaired.txt`,
      }),
      source: UNPAIRED_RAW,
    });
    assert.equal(unpaired.sanitized_digest, digestOf(UNPAIRED_SANITIZED));
    for (let offset = 1; offset < UNPAIRED_RAW.byteLength; offset += 1) {
      const split = await sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(UNPAIRED_RAW, {
          relative_path: `runs/${RUN_ID}/${CHILD_A}/unpaired-${offset}.txt`,
        }),
        source: splitAt(UNPAIRED_RAW, offset),
      });
      assert.equal(split.sanitized_digest, unpaired.sanitized_digest);
    }
  });
});

test('unknown option keys and missing required keys fail closed', async () => {
  await withStore(async (store) => {
    const sample = SAMPLES.plain;
    await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw),
        source: sample.raw,
        regex: /secret/u,
      }),
      'unknown_key',
    );
    await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        source: sample.raw,
      }),
      'missing_key',
      'options.artifact_ref',
    );
    await errorOfAsync(
      () => sanitizeAndPublishArtifactV1(store, {
        artifact_ref: rawRefFor(sample.raw),
      }),
      'missing_key',
      'options.source',
    );
  });
});
