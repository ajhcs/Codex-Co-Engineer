import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DSH_PATCH_FILE,
  dshVersionProbe,
} from '../mcp/dsh.mjs';
import {
  __testing,
  CONTROL_JOB_ID_ENV,
  foldSessionUsage,
  resolveControlJobId,
  run,
  secureReceiptPlatformAvailable,
  validateControlJobId,
  writeUsageReceipt,
} from '../assets/dsh-headless-usage-runner.mjs';

const TEST_JOB_ID = 'deepseek-agent-20260817000000-abcdef12';

test('requires a validated control job ID before running or writing a receipt', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-job-id-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = path.join(directory, `${TEST_JOB_ID}.usage.json`);
  assert.equal(resolveControlJobId({ env: { [CONTROL_JOB_ID_ENV]: TEST_JOB_ID } }), TEST_JOB_ID);
  assert.equal(validateControlJobId(TEST_JOB_ID), TEST_JOB_ID);
  await assert.rejects(writeUsageReceipt({ schemaVersion: 1 }, receiptPath), /control_job_id_invalid/);
  await assert.rejects(writeUsageReceipt({ jobId: 'bad' }, receiptPath), /control_job_id_invalid/);
  await writeUsageReceipt({ jobId: TEST_JOB_ID }, receiptPath);
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).jobId, TEST_JOB_ID);
  assert.equal((await lstat(receiptPath)).mode & 0o7777, 0o600);
  await rm(receiptPath);
  let creates = 0;
  const ctx = {
    get(name) {
      if (name === 'agents') return { create() { creates += 1; } };
      return {};
    },
  };
  await assert.rejects(run(ctx, 'bounded task', undefined, { receipt: receiptPath, jobId: 'bad' }), /control_job_id_invalid/);
  assert.equal(creates, 0);
  await assert.rejects(lstat(receiptPath));
});

test('binds receipt writes to one exact owner-only nonsymlink jobs directory', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-target-binding-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    writeUsageReceipt({ jobId: TEST_JOB_ID }, path.join(root, 'other.usage.json')),
    /receipt_target_mismatch/,
  );

  await chmod(root, 0o755);
  await assert.rejects(
    writeUsageReceipt({ jobId: TEST_JOB_ID }, path.join(root, `${TEST_JOB_ID}.usage.json`)),
    /receipt_parent_unsafe/,
  );
  await chmod(root, 0o700);
  await chmod(root, 0o1700);
  await assert.rejects(
    writeUsageReceipt({ jobId: TEST_JOB_ID }, path.join(root, `${TEST_JOB_ID}.usage.json`)),
    /receipt_parent_unsafe/,
  );
  await chmod(root, 0o700);

  const realRoot = path.join(root, 'real-root');
  const jobsDir = path.join(realRoot, 'jobs');
  await mkdir(realRoot, { mode: 0o700 });
  await mkdir(jobsDir, { mode: 0o700 });
  const redirectedRoot = path.join(root, 'redirected-root');
  await symlink(realRoot, redirectedRoot);
  await assert.rejects(
    writeUsageReceipt(
      { jobId: TEST_JOB_ID },
      path.join(redirectedRoot, 'jobs', `${TEST_JOB_ID}.usage.json`),
    ),
    /receipt_parent_redirected/,
  );
});

test('descriptor-anchors temp and final writes across an ancestor swap', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-writer-swap-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const ancestor = path.join(root, 'ancestor');
  const jobsDir = path.join(ancestor, 'jobs');
  const movedAncestor = path.join(root, 'moved-ancestor');
  await mkdir(ancestor, { mode: 0o700 });
  await mkdir(jobsDir, { mode: 0o700 });
  const target = path.join(jobsDir, `${TEST_JOB_ID}.usage.json`);

  await assert.rejects(__testing.writeUsageReceiptWithHooks(
    { jobId: TEST_JOB_ID },
    target,
    {
      afterParentOpen: async () => {
        await rename(ancestor, movedAncestor);
        await mkdir(ancestor, { mode: 0o700 });
        await mkdir(jobsDir, { mode: 0o700 });
      },
    },
  ), /receipt_parent_replaced/);

  assert.deepEqual(await readdir(jobsDir), []);
  const anchoredFiles = await readdir(path.join(movedAncestor, 'jobs'));
  assert.deepEqual(anchoredFiles, [`${TEST_JOB_ID}.usage.json`]);
  assert.equal(anchoredFiles.some((name) => name.includes('.tmp-')), false);
});

test('exposes a fail-closed platform guard for required POSIX primitives', () => {
  assert.equal(secureReceiptPlatformAvailable(), true);
  assert.equal(secureReceiptPlatformAvailable({ constants: {}, getuid: () => 0 }), false);
  assert.equal(secureReceiptPlatformAvailable({ constants: { O_NOFOLLOW: 1 }, getuid: undefined }), false);
  assert.equal(secureReceiptPlatformAvailable({
    constants: { O_NOFOLLOW: 1 },
    getuid: () => 0,
    platform: 'linux',
  }), false);
  assert.equal(secureReceiptPlatformAvailable({
    constants: { O_DIRECTORY: 2, O_NOFOLLOW: 1 },
    getuid: () => 0,
    platform: 'darwin',
  }), false);
  assert.equal(secureReceiptPlatformAvailable({
    constants: { O_DIRECTORY: 2, O_NOFOLLOW: 1 },
    getuid: () => 0,
    platform: 'linux',
  }), true);
});

function event(seq, type, data) {
  return { seq, time: seq, type, data };
}

function usageChunk(seq, turn, step, inputTokens, outputTokens) {
  return event(seq, 'assistant/chunk', {
    turn,
    step,
    chunk: {
      type: 'usage',
      usage: { inputTokens, outputTokens },
    },
  });
}

function assistantMessage(seq, turn, step, inputTokens, outputTokens, model, text = '') {
  return event(seq, 'assistant/message', {
    turn,
    step,
    message: {
      id: `message-${seq}`,
      role: 'assistant',
      content: text === '' ? [] : [{ type: 'text', text }],
      source: { kind: 'model', provider: 'meta', model },
    },
    usage: { inputTokens, outputTokens },
  });
}

function session(id, events, parentSession, seedLength = 0) {
  return {
    id,
    header: {
      id,
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(seedLength === 0 ? {} : { seedLength }),
    },
    events,
    firstLiveSeq: seedLength,
  };
}

function contextFor({ root, children = [], disposed = false, malformedUsage = false }) {
  const handlers = new Map();
  const all = new Map([[root.id, root], ...children.map((child) => [child.id, child])]);
  let rootAgent;
  const agents = {
    async create(options) {
      root.id = options.sessionId;
      root.header.id = options.sessionId;
      for (const child of children) child.header.parentSession = options.sessionId;
      all.delete('root-session');
      all.set(root.id, root);
      rootAgent = {
        session: root,
        ctx: {
          on(type, callback) {
            const list = handlers.get(`agent:${type}`) ?? [];
            list.push(callback);
            handlers.set(`agent:${type}`, list);
            return () => list.splice(list.indexOf(callback), 1);
          },
        },
        async whenIdle() {},
        followup() {
          const offset = root.events.length;
          const generated = [
            event(offset, 'turn/start', { turn: 1 }),
            usageChunk(offset + 1, 1, 0, 10, 20),
            assistantMessage(offset + 2, 1, 0, 10, 20, 'muse-spark-1.2-contributor', 'final answer'),
          ];
          if (malformedUsage) generated.push(usageChunk(offset + 3, 1, 1, -1, 4));
          generated.push(event(offset + generated.length, 'turn/end', {
            turn: 1,
            reason: { kind: 'completed' },
          }));
          root.events.push(...generated);
          if (children.length > 0) {
            for (const callback of handlers.get('session/created') ?? []) callback(children[0]);
          }
          if (disposed) all.delete(children[0]?.id);
        },
      };
      return { agent: rootAgent };
    },
    get(id) {
      if (id === root.id) return rootAgent;
      if (children.some((child) => child.id === id)) return { status: 'idle' };
      return undefined;
    },
  };
  const sessions = {
    list() { return [...all.values()]; },
    async flush() {},
  };
  const defaultModel = {
    currentSelection() {
      return { provider: 'meta', model: 'muse-spark-1.2-contributor' };
    },
  };
  return {
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'sessions') return sessions;
      if (name === 'agentDefaultModel') return defaultModel;
      return undefined;
    },
    on(type, callback) {
      const list = handlers.get(type) ?? [];
      list.push(callback);
      handlers.set(type, list);
      return () => list.splice(list.indexOf(callback), 1);
    },
  };
}

test('folds in-memory usage and replaces chunk usage with the assistant fallback', () => {
  const folded = foldSessionUsage(session('root', [
    usageChunk(0, 1, 0, 9, 11),
    assistantMessage(1, 1, 0, 10, 12, 'muse-spark-1.2-contributor'),
  ]));
  assert.deepEqual(folded.counts, {
    inputTokens: 10,
    outputTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(folded.usageSamples, 1);
  assert.equal(folded.malformedUsageEvents, 0);
});

test('counts malformed usage payloads instead of silently discarding them', () => {
  const folded = foldSessionUsage(session('root', [
    usageChunk(0, 1, 0, 9, 11),
    usageChunk(1, 1, 1, -1, 2),
    event(2, 'assistant/chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'usage', usage: {} },
    }),
    event(3, 'assistant/message', {
      turn: 1,
      step: 3,
      message: { role: 'assistant', content: [] },
    }),
  ]));
  assert.equal(folded.usageSamples, 1);
  assert.equal(folded.malformedUsageEvents, 3);
  assert.equal(folded.counts.inputTokens, 9);
  assert.equal(folded.counts.outputTokens, 11);
});

test('runs a fake headless task, aggregates a live child, and writes only a compact receipt', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-headless-usage-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = session('root-session', [event(0, 'request/header', {
    header: { config: { provider: 'meta', model: 'muse-spark-1.2-contributor' } },
  })]);
  const child = session('child-session', [
    assistantMessage(0, 1, 0, 99, 99, 'seed-model'),
    assistantMessage(1, 1, 0, 5, 6, 'muse-spark-1.2-contributor'),
  ], root.id, 1);
  const ctx = contextFor({ root, children: [child] });
  const output = [];
  const errors = [];
  const exits = [];
  const receiptPath = path.join(directory, `${TEST_JOB_ID}.usage.json`);
  const result = await run(ctx, 'bounded task', {
    stdout: { write(value) { output.push(value); } },
    stderr: { write(value) { errors.push(value); } },
    exit(code) { exits.push(code); },
  }, { receipt: receiptPath, jobId: TEST_JOB_ID });
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const metadata = await lstat(receiptPath);
  assert.equal(result.rootSessionId.startsWith('session-'), true);
  assert.equal(output.join(''), 'final answer\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(exits, [0]);
  assert.equal(receipt.aggregationComplete, true);
  assert.equal(receipt.jobId, TEST_JOB_ID);
  assert.equal(receipt.sessionCount, 2);
  assert.equal(receipt.descendantSessionCount, 1);
  assert.equal(receipt.usageSamples, 2);
  assert.deepEqual(receipt.counts, {
    inputTokens: 15,
    outputTokens: 26,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 41,
  });
  assert.equal(receipt.model, 'muse-spark-1.2-contributor');
  assert.equal(receipt.spend, null);
  assert.equal(receipt.accountRemaining, null);
  assert.equal(receipt.rateLimit, null);
  assert.equal(Object.hasOwn(receipt, 'prompt'), false);
  assert.equal(metadata.mode & 0o077, 0);
});

test('downgrades mixed usage to observed when any usage event is malformed', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-headless-malformed-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = session('root-session', []);
  const ctx = contextFor({ root, malformedUsage: true });
  const receiptPath = path.join(directory, `${TEST_JOB_ID}.usage.json`);
  const result = await run(ctx, 'bounded task', {
    stdout: { write() {} },
    stderr: { write() {} },
    exit() {},
  }, { receipt: receiptPath, jobId: TEST_JOB_ID });
  assert.equal(result.receipt.usageSamples, 1);
  assert.equal(result.receipt.malformedUsageEventCount, 1);
  assert.equal(result.receipt.aggregationComplete, false);
  assert.equal(result.receipt.confidence, 'observed');
  assert.equal(result.receipt.counts.totalTokens, 30);
});

test('marks a child disposed before the final fold as incomplete', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-headless-disposed-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = session('root-session', []);
  const child = session('disposed-child', [assistantMessage(0, 1, 0, 5, 6, 'muse')], root.id);
  const ctx = contextFor({ root, children: [child], disposed: true });
  const exits = [];
  const receiptPath = path.join(directory, `${TEST_JOB_ID}.usage.json`);
  const result = await run(ctx, 'bounded task', {
    stdout: { write() {} },
    stderr: { write() {} },
    exit(code) { exits.push(code); },
  }, { receipt: receiptPath, jobId: TEST_JOB_ID });
  assert.equal(result.receipt.aggregationComplete, false);
  assert.equal(result.receipt.confidence, 'observed');
  assert.equal(result.receipt.missingDescendantCount, 1);
  assert.deepEqual(exits, [0]);
});

test('installed dsh dump composes the managed patch without a provider call', async (context) => {
  const version = dshVersionProbe();
  if (!version.compatible) return context.skip('compatible dsh executable cannot be spawned in this environment');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-dump-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dump = (selected) => spawnSync('dsh', [
    '--profile', 'headless',
    '--patch', DEFAULT_DSH_PATCH_FILE,
    '--dump-config',
  ], {
    cwd: directory,
    env: {
      ...process.env,
      DSH_HOME: path.join(directory, selected ? 'home-selected' : 'home-standard'),
      ...(selected ? { CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER: 'enabled' } : {}),
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  for (const selected of [false, true]) {
    const result = dump(selected);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /name mismatch/);
    assert.match(result.stdout, /id: headless-runner/);
    assert.match(result.stdout, /name: '@deepseek-ai\/dsh-headless'/);
    assert.match(result.stdout, /id: headless-usage-runner/);
    assert.match(result.stdout, /name: \.\/dsh-headless-usage-runner\.mjs/);
  }
});
