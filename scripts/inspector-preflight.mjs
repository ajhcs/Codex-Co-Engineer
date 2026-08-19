#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-inspector-'));
const inspector = process.env.MCP_INSPECTOR_COMMAND ?? 'mcp-inspector';

function inspect(method, toolName) {
  const argv = [
    '--cli', 'node', 'plugins/plumbob-harness-control/mcp/v3/server.mjs',
    '--method', method,
  ];
  if (toolName) argv.push('--tool-name', toolName, '--tool-args-json', '{}');
  argv.push('--format', 'json', '-e', `CODEX_CO_ENGINEER_STATE_DIR=${state}`);
  const result = spawnSync(inspector, argv, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout).result ?? JSON.parse(result.stdout);
}

try {
  const listed = inspect('tools/list');
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['status', 'delegate', 'task', 'tasks', 'cancel']);
  const statusEnvelope = inspect('tools/call', 'status');
  const status = statusEnvelope.structuredContent
    ?? JSON.parse(statusEnvelope.content?.[0]?.text ?? '{}');
  assert.equal(status.version, '3.0.1');
  assert.equal(status.healthy, status.local_boundary.ready);
  assert.equal(status.active, 0);
  assert.deepEqual(status.tasks, []);
  assert.deepEqual(status.providers, ['grok', 'cursor-local', 'dsh', 'cursor-cloud']);
  for (const provider of ['grok', 'cursor-local', 'dsh']) {
    if (!status.local_boundary.ready) assert.equal(status.readiness[provider].ready, false);
  }
  process.stdout.write(`${JSON.stringify({ tools: listed.tools.map((tool) => tool.name), status }, null, 2)}\n`);
} finally {
  await rm(state, { recursive: true, force: true });
}
