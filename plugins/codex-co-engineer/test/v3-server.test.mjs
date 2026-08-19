import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { appendTaskEvent, createTask } from '../mcp/v3/task-store.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'v3', 'server.mjs');

async function withServer(callback, environment = process.env) {
  const state = await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-server-'));
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...environment,
      CODEX_CO_ENGINEER_STATE_DIR: state,
      CODEX_CO_ENGINEER_GROK_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_CURSOR_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_ACPX_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_ACP_COMMAND: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const nextValue = () => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  });
  lines.on('line', (line) => {
    const waiter = pending.shift();
    if (waiter) waiter.resolve(JSON.parse(line));
  });
  child.once('error', (error) => {
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`MCP server exited (${code ?? signal}): ${stderr}`);
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  const request = async (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return nextValue();
  };
  try {
    return await callback({ state, request });
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    lines.close();
    await rm(state, { recursive: true, force: true });
  }
}

async function conversation(messages, environment = process.env) {
  return withServer(async ({ request }) => {
    const values = [];
    for (const message of messages) values.push(await request(message));
    return values;
  }, environment);
}

test('advertises only the thin public tool surface', async () => {
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  assert.equal(values[0].result.serverInfo.name, 'codex-co-engineer');
  assert.equal(values[0].result.serverInfo.title, 'Codex-Co-Engineer');
  assert.equal(values[0].result.serverInfo.version, '3.0.2');
  assert.deepEqual(values[1].result.tools.map((tool) => tool.name), ['status', 'delegate', 'task', 'tasks', 'cancel']);
  const taskTool = values[1].result.tools.find((tool) => tool.name === 'task');
  assert.deepEqual(Object.keys(taskTool.inputSchema.properties), ['task_id', 'wait_ms', 'cursor']);
  assert.equal(taskTool.inputSchema.properties.wait_ms.maximum, 60000);
  assert.match(taskTool.description, /event_cursor/u);
  assert.match(taskTool.description, /Unsolicited stdio callbacks/u);
});

test('task returns a compact live snapshot and can wait for the next event', async () => {
  await withServer(async ({ state, request }) => {
    await createTask({
      root: state,
      prompt: 'do not return this prompt',
      record: {
        id: 'server-wait',
        status: 'running',
        provider: 'grok',
        agent_argv: ['grok', 'agent'],
      },
    });
    await appendTaskEvent(state, 'server-wait', {
      type: 'provider',
      event: { type: 'text_delta', text: 'first-visible', pid: 12, argv: ['secret-argv'] },
    });
    const immediate = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'task', arguments: { task_id: 'server-wait' } },
    });
    const first = immediate.result.structuredContent;
    assert.equal(first.task.last_event.text, 'first-visible');
    assert.equal(first.task.agent_argv, undefined);
    assert.equal(first.progress.last_event.pid, undefined);
    assert.equal(first.progress.wait_reason, 'current');
    assert.doesNotMatch(JSON.stringify(first), /do not return this prompt|secret-argv/u);

    const pending = request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'task',
        arguments: { task_id: 'server-wait', wait_ms: 1000, cursor: first.progress.event_cursor },
      },
    });
    setTimeout(() => {
      appendTaskEvent(state, 'server-wait', {
        type: 'provider',
        event: { type: 'text_delta', text: 'second-visible' },
      }).catch(() => {});
    }, 20);
    const waited = (await pending).result.structuredContent;
    assert.equal(waited.progress.wait_reason, 'progress');
    assert.equal(waited.progress.last_event.text, 'second-visible');
    assert.ok(waited.progress.event_cursor !== first.progress.event_cursor);

    const invalid = await request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'task', arguments: { task_id: 'server-wait', cursor: 'nope' } },
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.result.structuredContent.error.code, 'invalid_event_cursor');
  });
});

test('status works without starting a daemon or provider', async () => {
  const [value] = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
  ]);
  assert.equal(
    value.result.structuredContent.healthy,
    value.result.structuredContent.local_boundary.ready,
  );
  assert.equal(value.result.structuredContent.active, 0);
});

test('status fails local providers closed when the MCP environment lacks the user-bus locator', async () => {
  const environment = { ...process.env };
  delete environment.XDG_RUNTIME_DIR;
  delete environment.DBUS_SESSION_BUS_ADDRESS;
  const [value] = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
  ], environment);
  const status = value.result.structuredContent;
  assert.equal(status.healthy, false);
  assert.equal(status.local_boundary.ready, false);
  for (const provider of ['grok', 'cursor-local', 'dsh']) assert.equal(status.readiness[provider].ready, false);
});
