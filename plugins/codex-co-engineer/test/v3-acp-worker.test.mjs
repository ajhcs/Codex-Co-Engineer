import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { boundedEvent, publicError, runAcpTask, runCliFallback, sanitizeText } from '../mcp/v3/acp-worker.mjs';
import { submitReply } from '../mcp/v3/mailbox.mjs';
import { createTask, readTask, updateTask } from '../mcp/v3/task-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'acpx-fake-agent.mjs');
const FAKE_ACPX = path.join(HERE, 'fake-acpx.mjs');

async function fixture(extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-acp-'));
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  await createTask({
    root,
    prompt: extra.prompt ?? 'review this repository',
    record: {
      id: extra.id ?? 'task-1',
      status: 'accepted',
      provider: extra.provider ?? 'grok',
      cwd,
      agent_argv: extra.agentArgv ?? [process.execPath, FAKE_AGENT, '--mode', extra.mode ?? 'normal'],
      ...(extra.cliArgv ? { cli_argv: extra.cliArgv } : {}),
      timeout_ms: extra.timeoutMs ?? 5_000,
    },
  });
  return { root, cwd, taskId: extra.id ?? 'task-1' };
}

async function withFakeAcpx(mode, callback, options = {}) {
  const names = ['CODEX_CO_ENGINEER_ACPX_COMMAND', 'FAKE_ACPX_MODE', 'FAKE_ACPX_ARTIFACT_MARKER', 'FAKE_ACPX_DESCENDANT_PID_FILE'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = FAKE_ACPX;
  process.env.FAKE_ACPX_MODE = mode;
  if (options.artifactMarker) process.env.FAKE_ACPX_ARTIFACT_MARKER = options.artifactMarker;
  else delete process.env.FAKE_ACPX_ARTIFACT_MARKER;
  if (options.descendantPidFile) process.env.FAKE_ACPX_DESCENDANT_PID_FILE = options.descendantPidFile;
  else delete process.env.FAKE_ACPX_DESCENDANT_PID_FILE;
  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

async function processExited(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test('runs a prompt through ACP and persists a compact receipt', async () => {
  const value = await fixture();
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.transport, 'acp');
  assert.equal(terminal.prompt_dispatched, true);
  assert.match(terminal.acp_session_id, /^fake-session-/u);
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /session_ready/u);
  assert.match(events, /fake-chunk-1/u);
  assert.match(events, /"status":"completed"/u);
});

test('does not start a fresh ACP worker from transport_lost', async () => {
  const value = await fixture({ id: 'transport-lost-start' });
  await updateTask(value.root, value.taskId, { status: 'transport_lost' });
  await assert.rejects(
    runAcpTask({ root: value.root, taskId: value.taskId }),
    (error) => error.code === 'transport_lost',
  );
});

test('recursively bounds and redacts provider events and errors', () => {
  const prompt = 'private prompt sk-prompt-secret-1234567890';
  const event = {
    type: 'provider_update',
    text: `${prompt} xai-live-secret-1234567890`,
    nested: {
      prompt,
      apiKey: 'sk-live-secret-1234567890',
      authorization: 'Bearer live-secret-1234567890',
      token: 'structured-token-secret-1234567890',
      bearer: 'structured-bearer-secret-1234567890',
      rawOutput: 'private provider payload',
      deep: { deeper: { deepest: { value: 'bounded' } } },
    },
    list: Array.from({ length: 80 }, (_, index) => `entry-${index}`),
    huge: 'x'.repeat(20_000),
  };
  const safe = boundedEvent(event, prompt);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /private prompt|sk-prompt-secret|xai-live-secret|sk-live-secret|Bearer live-secret|structured-token-secret|structured-bearer-secret/u);
  assert.equal(safe.nested.apiKey, '[REDACTED]');
  assert.equal(safe.nested.authorization, '[REDACTED]');
  assert.equal(safe.nested.token, '[REDACTED]');
  assert.equal(safe.nested.bearer, '[REDACTED]');
  assert.equal(safe.nested.rawOutput, undefined);
  assert.ok(serialized.length < 32 * 1024);
  assert.equal(sanitizeText(`failure: ${prompt} ghp_live-secret-1234567890`, prompt).includes(prompt), false);
  const failure = publicError(new Error(`provider failed for ${prompt} with token ghp_live-secret-1234567890`), prompt);
  assert.doesNotMatch(failure.message, /private prompt|ghp_live-secret/u);
});

test('redacts environment-style assignments and bearer tokens from ACP events and errors', () => {
  const prompt = 'private assignment prompt';
  const assignments = [
    ['MODEL_API_KEY', 'plain-model-value-1234567890'].join('='),
    ['CURSOR_API_KEY', 'plain-cursor-value-1234567890'].join(': '),
    ['XAI_API_KEY', 'plain-xai-value-1234567890'].join(' = '),
    ['Authorization', ['Bearer', 'short-bearer-value-1234567890'].join(' ')].join(': '),
  ].join('\n');
  const payload = `${prompt}\n${assignments}`;
  const event = boundedEvent({ type: 'provider_update', text: payload, nested: { detail: payload } }, prompt);
  const failure = publicError(new Error(payload), prompt);
  for (const output of [JSON.stringify(event), failure.message]) {
    assert.doesNotMatch(output, /private assignment prompt|plain-model-value|plain-cursor-value|plain-xai-value|short-bearer-value/iu);
  }
});

test('ACP startup failure falls back once before prompt dispatch', async () => {
  const value = await fixture({
    agentArgv: ['/definitely/missing/acp-agent'],
    cliArgv: [process.execPath, '-e', 'process.stdout.write("CLI_FALLBACK_OK")'],
    id: 'startup-failure',
  });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(terminal.status, 'completed');
  assert.equal(task.transport, 'cli');
  assert.equal(task.fallback_from, 'acp');
  assert.equal(task.result, 'CLI_FALLBACK_OK');
  assert.equal(task.prompt_dispatched, true);
  assert.equal(task.fallback_safe, false);
});

test('pre-aborted CLI fallback records a terminal cancellation', async () => {
  const value = await fixture({
    id: 'pre-aborted-fallback',
    cliArgv: [process.execPath, '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runCliFallback({ root: value.root, task: (await readTask(value.root, value.taskId)).task, prompt: 'private fallback prompt', signal: controller.signal }),
    (error) => error.code === 'cancelled',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'cancelled');
  assert.equal(task.error.code, 'cancelled');
  assert.ok(task.finished_at);
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /"status":"cancelled"/u);
  assert.equal((await readdir(path.join(value.root, 'tasks', value.taskId))).some((entry) => entry.startsWith('cli-prompt-')), false);
});

test('authentication failures do not trigger a futile CLI fallback', async () => {
  const value = await fixture({
    agentArgv: [process.execPath, '-e', 'console.error("Not signed in"); process.exit(1)'],
    cliArgv: [process.execPath, '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
    id: 'auth-failure',
  });
  await assert.rejects(runAcpTask({ root: value.root, taskId: value.taskId }));
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.transport, 'acp');
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.fallback_safe, true);
});

test('provider failure after dispatch is never marked safe to replay', async () => {
  const value = await fixture({ prompt: 'provider-failure', id: 'provider-failure' });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'failed');
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.prompt_dispatched, true);
  assert.equal(task.fallback_safe, false);
});

test('DSH scopes ACPX artifacts to the task and removes them after persistence', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-flow' });
  const artifactMarker = path.join(value.root, 'artifact-created');
  await withFakeAcpx('success', async () => {
    const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.transport, 'acp');
    assert.equal(terminal.result, 'DSH_FAKE_OK');
    assert.equal(terminal.acp_session_id, 'dsh-fake-session');
    assert.equal(terminal.dispatch_uncertain, true);
    assert.equal(terminal.prompt_dispatched, undefined);
    await access(artifactMarker);
    const entries = await readdir(path.join(value.root, 'tasks', value.taskId));
    assert.equal(entries.some((entry) => entry.startsWith('flow-input-')), false);
    assert.equal(entries.includes('acpx-home'), false);
  }, { artifactMarker });
});

test('DSH does not fall back after ACPX has spawned without an acknowledgement', async () => {
  const cliMarker = path.join((await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-dsh-cli-'))), 'cli-ran');
  const value = await fixture({
    provider: 'dsh',
    id: 'dsh-uncertain-spawn',
    cliArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(cliMarker)}, 'ran')`],
  });
  await assert.rejects(
    withFakeAcpx('fail-after-spawn', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_failed',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.dispatch_uncertain, true);
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.fallback_safe, false);
  await assert.rejects(access(cliMarker));
  assert.equal((await readdir(path.join(value.root, 'tasks', value.taskId))).includes('acpx-home'), false);
});

test('DSH deadline kills a detached ACPX descendant before terminalizing', async () => {
  const descendantPidFile = path.join((await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-dsh-tree-'))), 'descendant.pid');
  const value = await fixture({ provider: 'dsh', id: 'dsh-timeout-tree', timeoutMs: 1_000 });
  await assert.rejects(
    withFakeAcpx('timeout-tree', () => runAcpTask({ root: value.root, taskId: value.taskId }), { descendantPidFile }),
    (error) => error.code === 'timeout',
  );
  const pid = Number((await readFile(descendantPidFile, 'utf8')).trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.equal(await processExited(pid), true);
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'timeout');
  assert.equal(task.dispatch_uncertain, true);
  assert.equal(task.fallback_safe, false);
  assert.equal((await readdir(path.join(value.root, 'tasks', value.taskId))).includes('acpx-home'), false);
});

test('user-facing ACP permission requests persist needs_attention and accept one same-session reply', async () => {
  const value = await fixture({ prompt: 'need permission please', id: 'perm-one', timeoutMs: 8_000 });
  const running = runAcpTask({ root: value.root, taskId: value.taskId });
  const deadline = Date.now() + 5_000;
  let attention;
  while (Date.now() < deadline) {
    const current = (await readTask(value.root, value.taskId)).task;
    if (current.status === 'needs_attention') {
      attention = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(attention?.status, 'needs_attention');
  assert.ok(attention.attention?.session_id);
  assert.ok(attention.attention?.question_id);
  await submitReply(value.root, value.taskId, {
    session_id: attention.attention.session_id,
    question_id: attention.attention.question_id,
    response: 'allow_once',
  });
  const terminal = await running;
  assert.equal(terminal.status, 'completed');
  assert.equal((await readTask(value.root, value.taskId)).task.status, 'completed');
});
