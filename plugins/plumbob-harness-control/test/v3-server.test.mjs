import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'v3', 'server.mjs');

async function conversation(messages) {
  const state = await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-server-'));
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: { ...process.env, CODEX_CO_ENGINEER_STATE_DIR: state },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const values = [];
  const done = new Promise((resolve) => {
    lines.on('line', (line) => {
      values.push(JSON.parse(line));
      if (values.length === messages.length) resolve();
    });
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  await done;
  child.kill('SIGTERM');
  return values;
}

test('advertises only the thin public tool surface', async () => {
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  assert.equal(values[0].result.serverInfo.version, '3.0.0');
  assert.deepEqual(values[1].result.tools.map((tool) => tool.name), ['status', 'delegate', 'task', 'tasks', 'cancel']);
});

test('status works without starting a daemon or provider', async () => {
  const [value] = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
  ]);
  assert.equal(value.result.structuredContent.healthy, true);
  assert.equal(value.result.structuredContent.active, 0);
});

