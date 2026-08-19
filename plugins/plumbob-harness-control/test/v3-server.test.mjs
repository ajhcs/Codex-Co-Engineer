import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'v3', 'server.mjs');

async function conversation(messages, environment = process.env) {
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
  const values = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const done = new Promise((resolve, reject) => {
    lines.on('line', (line) => {
      values.push(JSON.parse(line));
      if (values.length === messages.length) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(
      `MCP server exited before the conversation completed (${code ?? signal}): ${stderr}`,
    )));
  });
  try {
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    await done;
    return values;
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    lines.close();
    await rm(state, { recursive: true, force: true });
  }
}

test('advertises only the thin public tool surface', async () => {
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  assert.equal(values[0].result.serverInfo.version, '3.0.1');
  assert.deepEqual(values[1].result.tools.map((tool) => tool.name), ['status', 'delegate', 'task', 'tasks', 'cancel']);
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
