import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { boundedEvent, publicError, runAcpTask, runCliFallback, sanitizeText } from '../mcp/v3/acp-worker.mjs';
import { createTask, readTask } from '../mcp/v3/task-store.mjs';

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
      timeout_ms: 5_000,
    },
  });
  return { root, cwd, taskId: extra.id ?? 'task-1' };
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

test('recursively bounds and redacts provider events and errors', () => {
  const prompt = 'private prompt sk-prompt-secret-1234567890';
  const event = {
    type: 'provider_update',
    text: `${prompt} xai-live-secret-1234567890`,
    nested: {
      prompt,
      apiKey: 'sk-live-secret-1234567890',
      authorization: 'Bearer live-secret-1234567890',
      rawOutput: 'private provider payload',
      deep: { deeper: { deepest: { value: 'bounded' } } },
    },
    list: Array.from({ length: 80 }, (_, index) => `entry-${index}`),
    huge: 'x'.repeat(20_000),
  };
  const safe = boundedEvent(event, prompt);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /private prompt|sk-prompt-secret|xai-live-secret|sk-live-secret|Bearer live-secret/u);
  assert.equal(safe.nested.apiKey, '[REDACTED]');
  assert.equal(safe.nested.authorization, '[REDACTED]');
  assert.equal(safe.nested.rawOutput, undefined);
  assert.ok(serialized.length < 32 * 1024);
  assert.equal(sanitizeText(`failure: ${prompt} ghp_live-secret-1234567890`, prompt).includes(prompt), false);
  const failure = publicError(new Error(`provider failed for ${prompt} with token ghp_live-secret-1234567890`), prompt);
  assert.doesNotMatch(failure.message, /private prompt|ghp_live-secret/u);
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

test('DSH uses the owner-only ACPX flow input and persists its result', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-flow' });
  const previous = process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
  process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = FAKE_ACPX;
  try {
    const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.transport, 'acp');
    assert.equal(terminal.result, 'DSH_FAKE_OK');
    assert.equal(terminal.acp_session_id, 'dsh-fake-session');
    const entries = await readdir(path.join(value.root, 'tasks', value.taskId));
    assert.equal(entries.some((entry) => entry.startsWith('flow-input-')), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
    else process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = previous;
  }
});
