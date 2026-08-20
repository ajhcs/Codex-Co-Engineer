#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'codex-co-engineer');
const manifest = JSON.parse(await readFile(path.join(PLUGIN, '.mcp.json'), 'utf8'));
const definition = manifest.mcpServers?.['codex-co-engineer'];
assert.ok(definition, 'Co-Engineer MCP definition is missing.');

const required = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
for (const name of required) {
  assert.ok(definition.env_vars?.includes(name), `MCP environment allowlist is missing ${name}.`);
  assert.ok(process.env[name], `Release host environment is missing ${name}.`);
}

const state = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-mcp-environment-'));
const childEnvironment = {};
for (const name of definition.env_vars) {
  if (process.env[name] !== undefined) childEnvironment[name] = process.env[name];
}
childEnvironment.CODEX_CO_ENGINEER_STATE_DIR = state;
// Keep this acceptance focused on the manifest-filtered MCP/systemd boundary;
// provider authentication has its own status checks and must not make the
// boundary proof depend on external CLI latency.
childEnvironment.CODEX_CO_ENGINEER_GROK_COMMAND = '/bin/false';
childEnvironment.CODEX_CO_ENGINEER_CURSOR_COMMAND = '/bin/false';
childEnvironment.CODEX_CO_ENGINEER_DSH_COMMAND = '/bin/false';
childEnvironment.CODEX_CO_ENGINEER_ACPX_COMMAND = '/bin/false';
childEnvironment.CODEX_CO_ENGINEER_DSH_ACP_COMMAND = 'false';

const child = spawn(definition.command, definition.args, {
  cwd: PLUGIN,
  env: childEnvironment,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });

try {
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP status. ${stderr}`)), 15_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`MCP exited before status: ${code ?? signal}. ${stderr}`));
    });
    output.once('line', (line) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    })}\n`);
  });
  const status = response.result?.structuredContent;
  assert.equal(status?.version, '3.2.0');
  assert.equal(status?.healthy, true, JSON.stringify(status?.local_boundary));
  assert.equal(status?.local_boundary?.ready, true, JSON.stringify(status?.local_boundary));
  assert.equal(status?.local_boundary?.boundary, 'systemd-user-service-cgroup');
  process.stdout.write(`${JSON.stringify({
    version: status.version,
    healthy: status.healthy,
    local_boundary: status.local_boundary,
    environment_forwarded: required,
  })}\n`);
} finally {
  child.kill('SIGTERM');
  output.close();
  await rm(state, { recursive: true, force: true });
}
