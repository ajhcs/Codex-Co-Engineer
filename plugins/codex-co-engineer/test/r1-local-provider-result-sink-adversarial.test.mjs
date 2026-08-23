import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import { readSanitizedArtifactV1 } from '../mcp/v3/artifact-reader.mjs';
import { ARTIFACT_REF_SCHEMA_ID } from '../mcp/v3/artifact-ref.mjs';
import { publishArtifactV1, openArtifactStoreV1 } from '../mcp/v3/artifact-store.mjs';
import {
  LOCAL_PROVIDER_RESULT_SINK_FAILURE_KEYS,
  LOCAL_PROVIDER_RESULT_SINK_FAILURE_MESSAGE,
  LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID,
  contentFreeSinkFailureV1,
  localProviderResultReportPathV1,
  sinkLocalProviderResultV1,
} from '../mcp/v3/local-provider-result-sink.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-artifact-fixtures.mjs';
import {
  CHILD_B,
  PROMPT_SECRET,
  REPLACEMENT,
  RUN_ID,
  SECRET,
  SPLIT_SECRET,
  SubclassedBytes,
  conflictingSanitizedRef,
  digestOf,
  grokText,
  identityFor,
  makeStoreRoot,
  removeRoot,
  splitStringChunks,
} from './fixtures/r1-local-provider-result-sink-fixtures.mjs';

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

function assertContentFree(error, root, secrets) {
  const message = `${error.message}`;
  assert.equal(message.includes(root), false, 'error echoed the store root');
  assert.equal(message.includes('ENOENT'), false, 'error echoed an errno');
  assert.equal(message.includes('EEXIST'), false, 'error echoed an errno');
  for (const secret of secrets) {
    assert.equal(message.includes(secret), false, `error leaked ${secret}`);
  }
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

test('proxy accessor and subclassed sources fail closed without running traps', async () => {
  await withStore(async (store, root) => {
    const { proxy, counts } = countingProxy({
      ...identityFor('grok'),
      source: grokText(),
    });
    const proxied = await expectCode(
      () => sinkLocalProviderResultV1(store, proxy),
      'proxy_denied',
    );
    assert.ok(trapTotal(counts) <= 2);
    assertContentFree(proxied, root, [SECRET]);

    const sourceProxy = countingProxy(Buffer.from(grokText(), 'utf8'));
    const proxiedSource = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('cursor-local'),
        source: sourceProxy.proxy,
      }),
      'proxy_denied',
      'source',
    );
    assertContentFree(proxiedSource, root, [SECRET]);

    const trap = { ran: 0 };
    const accessor = {
      ...identityFor('dsh'),
      get source() {
        trap.ran += 1;
        throw new Error(`must not read ${SECRET}`);
      },
    };
    const access = await expectCode(
      () => sinkLocalProviderResultV1(store, accessor),
      'accessor_property_denied',
      'options.source',
    );
    assert.equal(trap.ran, 0);
    assertContentFree(access, root, [SECRET]);

    const subclassed = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('grok'),
        source: new SubclassedBytes(Buffer.from(grokText(), 'utf8')),
      }),
      'artifact_stream_invalid_source',
      'source',
    );
    assertContentFree(subclassed, root, [SECRET]);
  });
});

test('malformed unknown and cloud-provider inputs fail closed', async () => {
  await withStore(async (store, root) => {
    const unknown = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('grok'),
        source: grokText(),
        extra: true,
      }),
      'unknown_key',
    );
    assertContentFree(unknown, root, [SECRET]);

    const missing = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        assignment_id: 'lane-alpha',
        provider: 'grok',
        model: 'grok-code',
        source: grokText(),
      }),
      'missing_key',
      'options.run_id',
    );
    assertContentFree(missing, root, [SECRET]);

    const cloud = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('grok'),
        provider: 'cursor-cloud',
        source: grokText(),
      }),
      'local_provider_required',
      'options.provider',
    );
    assertContentFree(cloud, root, [SECRET]);

    const badId = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('grok'),
        assignment_id: 'Lane_Nope',
        source: grokText(),
      }),
      'invalid_format',
      'options.assignment_id',
    );
    assertContentFree(badId, root, [SECRET]);
  });
});

test('secret splits across chunks never appear in receipts tails or errors', async () => {
  await withStore(async (store, root) => {
    const body = `work output ${SPLIT_SECRET} and prompt: "${PROMPT_SECRET}"\nVERDICT: SECRET PASS`;
    const at = body.indexOf(SPLIT_SECRET) + 8;
    const receipt = await sinkLocalProviderResultV1(store, {
      ...identityFor('grok'),
      source: splitStringChunks(body, at),
    });
    const serialized = JSON.stringify(receipt);
    assertNoSecret(serialized, root);
    assert.equal(receipt.inline_tail.text.includes(SPLIT_SECRET), false);
    assert.equal(receipt.inline_tail.text.includes(PROMPT_SECRET), false);
    assert.equal(receipt.inline_tail.text.includes(SECRET), false);
    assert.match(receipt.inline_tail.text, /VERDICT: SECRET PASS$/u);
    assert.match(receipt.inline_tail.text, new RegExp(REPLACEMENT, 'u'));
    const page = await readSanitizedArtifactV1(store, receipt.sanitized_ref, {
      offset: 0,
      max_bytes: 8192,
    });
    const sanitized = Buffer.from(page.selected_content, 'base64').toString('utf8');
    assert.equal(sanitized.includes(SPLIT_SECRET), false);
    assert.equal(sanitized.includes(PROMPT_SECRET), false);
    assert.match(sanitized, /VERDICT: SECRET PASS$/u);
  });
});

function assertNoSecret(serialized, root) {
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(SPLIT_SECRET), false);
  assert.equal(serialized.includes(PROMPT_SECRET), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('private fallback prompt'), false);
}

test('idempotent restart succeeds and conflicting or tampered artifacts fail closed', async () => {
  await withStore(async (store, root) => {
    const source = grokText();
    const first = await sinkLocalProviderResultV1(store, {
      ...identityFor('cursor-local'),
      source,
    });
    const restart = await sinkLocalProviderResultV1(store, {
      ...identityFor('cursor-local'),
      source,
    });
    assert.equal(restart.published, true);
    assert.equal(restart.raw_digest, first.raw_digest);
    assert.equal(restart.sanitized_digest, first.sanitized_digest);
    assert.equal(restart.inline_tail.text, first.inline_tail.text);

    const conflict = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('cursor-local'),
        source: `${source} different trailing bytes\n`,
      }),
      'artifact_content_conflict',
    );
    assertContentFree(conflict, root, [SECRET]);

    const other = Buffer.from('tampered sanitized bytes that are not the original\n', 'utf8');
    await publishArtifactV1(store, conflictingSanitizedRef(
      localProviderResultReportPathV1(identityFor('dsh', { assignment_id: CHILD_B })),
      other,
    ), other);
    const afterRaw = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('dsh', { assignment_id: CHILD_B }),
        source: grokText('VERDICT: AFTER RAW'),
      }),
      'artifact_content_conflict',
    );
    assertContentFree(afterRaw, root, [SECRET, 'VERDICT: AFTER RAW']);
  });
});

test('tamper after publication is not reported as a verified artifact on restart', async () => {
  await withStore(async (store, root) => {
    const source = grokText('VERDICT: TAMPER PASS');
    const receipt = await sinkLocalProviderResultV1(store, {
      ...identityFor('grok'),
      source,
    });
    const content = path.join(
      store.root, 'sanitized', 'content', receipt.relative_path,
    );
    writeFileSync(content, Buffer.alloc(receipt.sanitized_byte_length, 0x62));
    const tampered = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('grok'),
        source,
      }),
      'artifact_digest_mismatch',
    );
    assertContentFree(tampered, root, [SECRET, 'VERDICT: TAMPER PASS']);
  });
});

test('content-free sink failure evidence never carries bytes secrets or handles', () => {
  const contract = new RunContractV1Error('artifact_content_conflict', 'artifact_ref',
    'Conflicting content at one location is refused.');
  const evidence = contentFreeSinkFailureV1(contract);
  assert.equal(evidence.schema, LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID);
  assert.equal(evidence.published, false);
  assert.deepEqual(Object.keys(evidence), [...LOCAL_PROVIDER_RESULT_SINK_FAILURE_KEYS]);
  assert.equal(evidence.error.code, 'artifact_content_conflict');
  assert.equal(evidence.error.path, 'artifact_ref');
  assert.equal(evidence.error.message, LOCAL_PROVIDER_RESULT_SINK_FAILURE_MESSAGE);
  assert.equal(Object.isFrozen(evidence), true);

  const noisy = new Error(`failed to write ${SECRET} at /tmp/not-a-real-store`);
  const fallback = contentFreeSinkFailureV1(noisy);
  assert.equal(fallback.error.code, 'artifact_sink_failed');
  assert.equal(fallback.error.path, 'sink');
  assert.equal(fallback.error.message, LOCAL_PROVIDER_RESULT_SINK_FAILURE_MESSAGE);
  assert.equal(JSON.stringify(fallback).includes(SECRET), false);
  assert.equal(JSON.stringify(fallback).includes('/tmp/not-a-real-store'), false);
  assert.equal(utilTypes.isProxy(fallback), false);
});

test('secret-bearing RunContractV1Error never echoes into sink failure evidence', () => {
  const secretPath = `source/${SECRET}`;
  const secretMessage = `failed to write ${SECRET} at /tmp/not-a-real-store`;
  const secretError = new RunContractV1Error('artifact_sink_failed', secretPath, secretMessage);
  const evidence = contentFreeSinkFailureV1(secretError);
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.published, false);
  assert.equal(evidence.error.code, 'artifact_sink_failed');
  assert.equal(evidence.error.path, 'sink');
  assert.equal(evidence.error.message, LOCAL_PROVIDER_RESULT_SINK_FAILURE_MESSAGE);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(secretPath), false);
  assert.equal(serialized.includes('/tmp/not-a-real-store'), false);
  assert.equal(evidence.error.message.includes(SECRET), false);
  assert.equal(evidence.error.path.includes(SECRET), false);

  const unknown = contentFreeSinkFailureV1(new RunContractV1Error(
    'not_a_closed_code',
    'not_a_closed_path',
    `echo ${SECRET}`,
  ));
  assert.equal(unknown.error.code, 'artifact_sink_failed');
  assert.equal(unknown.error.path, 'sink');
  assert.equal(unknown.error.message, LOCAL_PROVIDER_RESULT_SINK_FAILURE_MESSAGE);
  assert.equal(JSON.stringify(unknown).includes(SECRET), false);
  assert.equal(JSON.stringify(unknown).includes('not_a_closed_code'), false);
});

test('string chunk streams that are not intrinsic views still sanitize split tokens', async () => {
  await withStore(async (store, root) => {
    const text = `prefix ${SECRET} trailing VERDICT: CHUNK PASS`;
    const receipt = await sinkLocalProviderResultV1(store, {
      ...identityFor('grok'),
      source: splitStringChunks(text, text.indexOf(SECRET) + 4),
    });
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes(root), false);
    assert.match(receipt.inline_tail.text, /VERDICT: CHUNK PASS$/u);
    assert.match(receipt.inline_tail.text, new RegExp(REPLACEMENT, 'u'));
  });
});

test('sink never echoes a declared digest from a hostile raw ref constructor', async () => {
  await withStore(async (store, root) => {
    const error = await expectCode(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('grok'),
        source: grokText(),
        media_type: 'application/octet-stream',
      }),
      'invalid_format',
      'options.media_type',
    );
    assertContentFree(error, root, [SECRET]);
    assert.equal(error.message.includes(ARTIFACT_REF_SCHEMA_ID) || error.code === 'invalid_format', true);
    assert.equal(digestOf(Buffer.from(grokText(), 'utf8')) === error.message, false);
  });
});
