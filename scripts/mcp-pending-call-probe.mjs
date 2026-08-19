#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createTask, writeRuntimeRecord } from '../plugins/codex-co-engineer/mcp/v3/task-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'plugins', 'codex-co-engineer', 'mcp', 'v3', 'server.mjs');
const requested = Number.parseInt(process.argv.find((entry, index, all) => all[index - 1] === '--wait-ms') ?? '2000', 10);

if (!Number.isInteger(requested) || requested < 1) {
  process.stderr.write('Usage: node scripts/mcp-pending-call-probe.mjs --wait-ms <milliseconds>\n');
  process.exit(2);
}

const state = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-pending-call-'));
const child = spawn(process.execPath, ['--no-warnings', SERVER], {
  cwd: path.join(ROOT, 'plugins', 'codex-co-engineer'),
  env: {
    ...process.env,
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
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });

function request(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Probe timed out waiting for MCP. ${stderr}`)), requested + 15_000);
    const onLine = (line) => {
      clearTimeout(timer);
      lines.off('line', onLine);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    lines.on('line', onLine);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`MCP exited (${code ?? signal}): ${stderr}`));
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

try {
  await createTask({
    root: state,
    prompt: 'pending-call probe; this task stays running',
    record: {
      id: 'pending-call-probe',
      status: 'running',
      provider: 'grok',
      deadline_at: new Date(Date.now() + Math.max(requested * 2, 60_000)).toISOString(),
    },
  });
  const proc = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  await writeRuntimeRecord(state, 'pending-call-probe', {
    pid: process.pid,
    process_group: process.pid,
    process_start_ticks: proc.slice(proc.lastIndexOf(')') + 2).trim().split(/\s+/u)[19],
  });
  const started = Date.now();
  const response = await request({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'task',
      arguments: {
        task_id: 'pending-call-probe',
        wait_until: 'terminal',
        wait_ms: requested,
      },
    },
  });
  const elapsed = Date.now() - started;
  const body = response.result?.structuredContent ?? {};
  const report = {
    requested_wait_ms: requested,
    elapsed_ms: elapsed,
    wait_reason: body.progress?.wait_reason ?? null,
    task_status: body.task?.status ?? null,
    returned_before_request: elapsed + 50 < requested,
    notes: 'This probe measures the local stdio MCP server only. It is not a Codex Desktop 5-minute/30-minute/4-hour result.',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (body.progress?.wait_reason !== 'timeout' && body.progress?.wait_reason !== 'deadline' && body.progress?.wait_reason !== 'transport_budget') {
    process.exitCode = 1;
  }
} finally {
  child.kill('SIGTERM');
  lines.close();
  await rm(state, { recursive: true, force: true });
}
