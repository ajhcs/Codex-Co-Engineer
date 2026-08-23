import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readSanitizedArtifactV1 } from '../mcp/v3/artifact-reader.mjs';
import {
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
} from '../mcp/v3/artifact-ref.mjs';
import { openArtifactStoreV1 } from '../mcp/v3/artifact-store.mjs';
import {
  LOCAL_PROVIDER_RESULT_ARTIFACT_KIND,
  LOCAL_PROVIDER_RESULT_SINK_ERROR_CODES,
  LOCAL_PROVIDER_RESULT_SINK_FAILURE_KEYS,
  LOCAL_PROVIDER_RESULT_SINK_INLINE_TAIL_KEYS,
  LOCAL_PROVIDER_RESULT_SINK_INLINE_TAIL_MAX_BYTES,
  LOCAL_PROVIDER_RESULT_SINK_OPTION_KEYS,
  LOCAL_PROVIDER_RESULT_SINK_PROVIDERS,
  LOCAL_PROVIDER_RESULT_SINK_RECEIPT_KEYS,
  LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID,
  LOCAL_PROVIDER_RESULT_SINK_VERSION,
  collectCliProviderOutputV1,
  createLocalProviderResultCollectorV1,
  localProviderResultIdentityFromTaskV1,
  openLocalProviderArtifactStoreV1,
  sinkLocalProviderResultV1,
} from '../mcp/v3/local-provider-result-sink.mjs';
import { ARTIFACT_SANITIZER_VERSION } from '../mcp/v3/artifact-sanitizer.mjs';
import { runAcpTask, runCliFallback } from '../mcp/v3/acp-worker.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { createTask, readTask } from '../mcp/v3/task-store.mjs';
import {
  CHILD_B,
  CURSOR_MODEL,
  DSH_MODEL,
  GROK_MODEL,
  INLINE_TAIL_MAX,
  RUN_ID,
  REPLACEMENT,
  SECRET,
  SPLIT_SECRET,
  chunksOf,
  cursorText,
  dshObject,
  exact4096,
  grokText,
  identityFor,
  makeStoreRoot,
  oversizeTail,
  removeRoot,
  splitStringChunks,
  unicodeSplitWindow,
} from './fixtures/r1-local-provider-result-sink-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'acpx-fake-agent.mjs');
const FAKE_ACPX = path.join(HERE, 'fake-acpx.mjs');
const FAKE_CLI_TERMINAL_VERDICT = path.join(HERE, 'fake-cli-terminal-verdict.mjs');

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

async function readAllSanitized(store, ref) {
  let offset = 0;
  const parts = [];
  for (;;) {
    const page = await readSanitizedArtifactV1(store, ref, { offset, max_bytes: 8192 });
    parts.push(Buffer.from(page.selected_content, 'base64'));
    if (page.more !== true) {
      return Buffer.concat(parts).toString('utf8');
    }
    offset = page.next_offset;
  }
}

function assertReceiptShape(receipt, { published = true, empty = false } = {}) {
  assert.equal(receipt.schema, LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID);
  assert.equal(receipt.version, LOCAL_PROVIDER_RESULT_SINK_VERSION);
  assert.deepEqual(Object.keys(receipt), [...LOCAL_PROVIDER_RESULT_SINK_RECEIPT_KEYS]);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(receipt.published, published);
  assert.equal(receipt.empty, empty);
  assert.equal(receipt.artifact_kind, LOCAL_PROVIDER_RESULT_ARTIFACT_KIND);
}

function assertNoLeak(serialized, root, secrets) {
  assert.equal(serialized.includes(root), false, 'receipt echoed the store root');
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `receipt leaked ${secret}`);
  }
}

test('the closed sink vocabulary and caps are exported frozen', () => {
  assert.equal(LOCAL_PROVIDER_RESULT_SINK_SCHEMA_ID, 'codex-co-engineer.local-provider-result-sink.v1');
  assert.equal(LOCAL_PROVIDER_RESULT_SINK_VERSION, 1);
  assert.equal(LOCAL_PROVIDER_RESULT_SINK_INLINE_TAIL_MAX_BYTES, 4096);
  assert.equal(Object.isFrozen(LOCAL_PROVIDER_RESULT_SINK_PROVIDERS), true);
  assert.equal(Object.isFrozen(LOCAL_PROVIDER_RESULT_SINK_OPTION_KEYS), true);
  assert.equal(Object.isFrozen(LOCAL_PROVIDER_RESULT_SINK_RECEIPT_KEYS), true);
  assert.equal(Object.isFrozen(LOCAL_PROVIDER_RESULT_SINK_INLINE_TAIL_KEYS), true);
  assert.equal(Object.isFrozen(LOCAL_PROVIDER_RESULT_SINK_FAILURE_KEYS), true);
  assert.equal(Object.isFrozen(LOCAL_PROVIDER_RESULT_SINK_ERROR_CODES), true);
  assert.deepEqual([...LOCAL_PROVIDER_RESULT_SINK_PROVIDERS], ['grok', 'cursor-local', 'dsh']);
  assert.ok(LOCAL_PROVIDER_RESULT_SINK_RECEIPT_KEYS.includes('inline_tail'));
  assert.ok(LOCAL_PROVIDER_RESULT_SINK_ERROR_CODES.includes('local_provider_required'));
});

test('the sink module uses P09/P10/P08 authorities and does not import protected seams', () => {
  const source = readFileSync(fileURLToPath(new URL('../mcp/v3/local-provider-result-sink.mjs', import.meta.url)), 'utf8');
  assert.match(source, /sanitizeAndPublishArtifactV1/u);
  assert.match(source, /readSanitizedArtifactV1/u);
  assert.match(source, /verifyStoredArtifactV1/u);
  assert.equal(source.includes('task-store.mjs'), false);
  assert.equal(source.includes('acp-worker.mjs'), false);
  assert.equal(source.includes('supervisor.mjs'), false);
  assert.equal(source.includes('server.mjs'), false);
  assert.equal(source.includes('provider-driver.mjs'), false);
  assert.equal(source.includes('cursor-cloud-worker.mjs'), false);
});

test('Grok Cursor and DSH strings JSON values and stream chunks publish under exact identity', async () => {
  await withStore(async (store, root) => {
    const grok = await sinkLocalProviderResultV1(store, {
      ...identityFor('grok'),
      source: grokText(),
    });
    assertReceiptShape(grok);
    assert.equal(grok.run_id, RUN_ID);
    assert.equal(grok.assignment_id, 'lane-alpha');
    assert.equal(grok.provider, 'grok');
    assert.equal(grok.model, GROK_MODEL);
    assert.equal(grok.raw_ref.artifact_class, 'raw');
    assert.equal(grok.sanitized_ref.artifact_class, 'sanitized');
    assert.equal(grok.raw_ref.relative_path, grok.sanitized_ref.relative_path);
    assert.equal(grok.complete, true);
    assert.equal(grok.source_truncated, false);
    assert.equal(grok.inline_tail.inline_clipped, false);
    assert.equal(grok.inline_tail.text, grokText());
    assert.equal(await readAllSanitized(store, grok.sanitized_ref), grokText());
    assert.equal(grok.sanitizer_version, ARTIFACT_SANITIZER_VERSION);
    assertNoLeak(JSON.stringify(grok), root, [SECRET]);

    const cursor = await sinkLocalProviderResultV1(store, {
      ...identityFor('cursor-local', { assignment_id: CHILD_B }),
      source: Buffer.from(cursorText(), 'utf8'),
    });
    assert.equal(cursor.provider, 'cursor-local');
    assert.equal(cursor.model, CURSOR_MODEL);
    assert.equal(cursor.inline_tail.text, cursorText());

    const dshJson = dshObject();
    const dsh = await sinkLocalProviderResultV1(store, {
      ...identityFor('dsh', { assignment_id: 'lane-gamma' }),
      source: dshJson,
    });
    assert.equal(dsh.provider, 'dsh');
    assert.equal(dsh.model, DSH_MODEL);
    assert.equal(dsh.media_type, 'application/json');
    assert.equal(dsh.inline_tail.text, JSON.stringify(dshJson));

    const streamed = 'streamed grok chunk-1chunk-2 VERDICT: STREAM PASS';
    const streamReceipt = await sinkLocalProviderResultV1(store, {
      ...identityFor('grok', { assignment_id: 'lane-delta' }),
      source: chunksOf(streamed, 7),
    });
    assert.equal(await readAllSanitized(store, streamReceipt.sanitized_ref), streamed);
    assert.equal(streamReceipt.inline_tail.text, streamed);
  });
});

test('empty results do not invent an artifact and exact 4096 stays unclipped', async () => {
  await withStore(async (store) => {
    const empty = await sinkLocalProviderResultV1(store, {
      ...identityFor('grok'),
      source: '',
    });
    assertReceiptShape(empty, { published: false, empty: true });
    assert.equal(empty.raw_ref, null);
    assert.equal(empty.sanitized_ref, null);
    assert.equal(empty.inline_tail, null);
    assert.equal(empty.source_byte_length, 0);

    const payload = exact4096('END!');
    assert.equal(Buffer.byteLength(payload, 'utf8'), INLINE_TAIL_MAX);
    const exact = await sinkLocalProviderResultV1(store, {
      ...identityFor('cursor-local', { assignment_id: CHILD_B }),
      source: payload,
    });
    assert.equal(exact.published, true);
    assert.equal(exact.inline_tail.inline_clipped, false);
    assert.equal(exact.inline_tail.source_truncated, false);
    assert.equal(exact.inline_tail.byte_length, INLINE_TAIL_MAX);
    assert.equal(exact.inline_tail.text.endsWith('END!'), true);
    assert.equal(exact.source_byte_length, INLINE_TAIL_MAX);
  });
});

test('inline tails distinguish UTF-8 alignment clipping from source truncation', async () => {
  await withStore(async (store) => {
    const window = unicodeSplitWindow();
    const unicode = await sinkLocalProviderResultV1(store, {
      ...identityFor('grok'),
      source: window,
    });
    assert.equal(unicode.inline_tail.inline_clipped, true);
    assert.equal(unicode.inline_tail.source_truncated, false);
    assert.equal(unicode.complete, true);
    assert.equal(unicode.inline_tail.text.isWellFormed(), true);
    assert.equal(unicode.inline_tail.text.includes('\uFFFD'), false);
    assert.ok(unicode.inline_tail.byte_length <= INLINE_TAIL_MAX);
    assert.ok(unicode.inline_tail.text.endsWith('s'.repeat(20)));

    const over = oversizeTail();
    const truncated = await sinkLocalProviderResultV1(store, {
      ...identityFor('dsh', { assignment_id: CHILD_B }),
      source: over,
      source_truncated: true,
    });
    assert.equal(truncated.source_truncated, true);
    assert.equal(truncated.complete, false);
    assert.equal(truncated.inline_tail.inline_clipped, true);
    assert.equal(truncated.inline_tail.source_truncated, true);
    assert.equal(truncated.inline_tail.complete, false);
    assert.match(truncated.inline_tail.text, /VERDICT: OVERSIZE PASS$/u);
    assert.equal(truncated.inline_tail.byte_length <= INLINE_TAIL_MAX, true);
    assert.equal(await readAllSanitized(store, truncated.sanitized_ref), over);
  });
});

test('CLI JSONL extraction preserves complete available output without bounding', () => {
  const stdout = [
    JSON.stringify({ result: 'result candidate', text: 'secondary' }),
    JSON.stringify({ text: 'next chunk' }),
    'plain tail',
  ].join('\n');
  const bytes = collectCliProviderOutputV1(stdout);
  assert.equal(bytes.toString('utf8'), 'result candidatenext chunk\nplain tail');
  assert.equal(collectCliProviderOutputV1('').byteLength, 0);
});

test('collector retains older chunks until the raw class cap', () => {
  const collector = createLocalProviderResultCollectorV1();
  collector.append('older-output-');
  collector.append('later-verdict');
  const snapshot = collector.snapshot();
  assert.equal(snapshot.overflow, false);
  assert.equal(snapshot.source.toString('utf8'), 'older-output-later-verdict');
});

test('legacy tasks without run identity do not bind a sink envelope', () => {
  assert.equal(localProviderResultIdentityFromTaskV1({
    id: 'task-1',
    provider: 'grok',
  }), null);
  const bound = localProviderResultIdentityFromTaskV1({
    id: 'task-1',
    run_id: RUN_ID,
    assignment_id: 'lane-alpha',
    provider: 'dsh',
    dsh_model: DSH_MODEL,
  });
  assert.equal(bound.run_id, RUN_ID);
  assert.equal(bound.model, DSH_MODEL);
  assert.equal(Object.isFrozen(bound), true);
});

async function workerFixture(extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-p11-acp-'));
  chmodSync(root, 0o700);
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  const id = extra.id ?? 'task-1';
  await createTask({
    root,
    prompt: extra.prompt ?? 'review this repository',
    record: {
      id,
      status: 'accepted',
      provider: extra.provider ?? 'grok',
      ...(extra.run_id ? { run_id: extra.run_id } : {}),
      ...(extra.assignment_id ? { assignment_id: extra.assignment_id } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.dshModel ? { dsh_model: extra.dshModel } : {}),
      cwd,
      agent_argv: extra.agentArgv ?? [process.execPath, FAKE_AGENT, '--mode', extra.mode ?? 'normal'],
      ...(extra.cliArgv ? { cli_argv: extra.cliArgv } : {}),
      timeout_ms: extra.timeoutMs ?? 5_000,
    },
  });
  return { root, cwd, taskId: id };
}

async function withFakeAcpx(mode, callback) {
  const names = ['CODEX_CO_ENGINEER_ACPX_COMMAND', 'FAKE_ACPX_MODE'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = FAKE_ACPX;
  process.env.FAKE_ACPX_MODE = mode;
  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('Grok ACP with run identity stores the complete result after terminal publication', async () => {
  const value = await workerFixture({
    provider: 'grok',
    id: 'grok-p11-sink',
    run_id: RUN_ID,
    assignment_id: 'lane-alpha',
    model: GROK_MODEL,
    prompt: 'terminal-verdict',
  });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result, /VERDICT: ACP PASS$/u);
  assert.equal(terminal.result_truncated, true);
  assert.equal(terminal.provider_result_sink.published, true);
  assert.equal(terminal.provider_result_sink.provider, 'grok');
  assert.equal(terminal.provider_result_sink.inline_tail.inline_clipped, true);
  assert.match(terminal.provider_result_sink.inline_tail.text, /VERDICT: ACP PASS$/u);
  const store = await openLocalProviderArtifactStoreV1(value.root);
  const stored = await readAllSanitized(store, terminal.provider_result_sink.sanitized_ref);
  assert.match(stored, /VERDICT: ACP PASS$/u);
  assert.ok(stored.length > String(terminal.result).length);
});

test('Cursor Local ACP with run identity preserves legacy bounded result beside artifacts', async () => {
  const value = await workerFixture({
    provider: 'cursor-local',
    id: 'cursor-p11-sink',
    run_id: RUN_ID,
    assignment_id: 'lane-beta',
    model: CURSOR_MODEL,
    prompt: 'terminal-verdict',
  });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.provider, 'cursor-local');
  assert.match(terminal.result, /VERDICT: ACP PASS$/u);
  assert.equal(terminal.provider_result_sink.published, true);
  assert.equal(terminal.provider_result_sink.assignment_id, 'lane-beta');
  assert.equal(terminal.provider_result_sink.inline_tail.source_truncated, false);
});

test('DSH ACPX with run identity sinks nested JSON after provider terminal', async () => {
  const value = await workerFixture({
    provider: 'dsh',
    id: 'dsh-p11-object',
    run_id: RUN_ID,
    assignment_id: 'lane-gamma',
    dshModel: DSH_MODEL,
  });
  const terminal = await withFakeAcpx('terminal-object', () => runAcpTask({
    root: value.root, taskId: value.taskId,
  }));
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result.nested.final, /VERDICT: DSH OBJECT PASS$/u);
  assert.equal(terminal.provider_result_sink.published, true);
  assert.equal(terminal.provider_result_sink.media_type, 'application/json');
  assert.match(terminal.provider_result_sink.inline_tail.text, /VERDICT: DSH OBJECT PASS/u);
});

test('CLI fallback with run identity stores complete available output when transport-clipped', async () => {
  const value = await workerFixture({
    id: 'cli-p11-sink',
    run_id: RUN_ID,
    assignment_id: 'lane-alpha',
    model: GROK_MODEL,
    cliArgv: [process.execPath, FAKE_CLI_TERMINAL_VERDICT],
  });
  const { task } = await readTask(value.root, value.taskId);
  const terminal = await runCliFallback({
    root: value.root,
    task,
    prompt: 'private fallback prompt',
  });
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result, /VERDICT: CLI PASS$/u);
  assert.equal(terminal.provider_result_sink.published, true);
  assert.match(terminal.provider_result_sink.inline_tail.text, /VERDICT: CLI PASS$/u);
  assert.equal(JSON.stringify(terminal.provider_result_sink).includes('private fallback prompt'), false);
});

test('legacy ACP completion without run identity keeps 3.2.1 result shape', async () => {
  const value = await workerFixture({ id: 'legacy-no-identity', prompt: 'normal' });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.provider_result_sink, undefined);
});

test('sanitized oversize fails closed without reporting an artifact', async () => {
  await withStore(async (store, root) => {
    const over = Buffer.alloc(MAX_SANITIZED_ARTIFACT_BYTE_LENGTH + 1, 0x61);
    const error = await errorOfAsync(
      () => sinkLocalProviderResultV1(store, {
        ...identityFor('grok'),
        source: over,
      }),
      'artifact_stream_over_cap',
    );
    assert.equal(JSON.stringify({ code: error.code, message: error.message }).includes(root), false);
  });
});
