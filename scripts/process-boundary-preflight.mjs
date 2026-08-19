#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  launchProcessBoundary,
  probeProcessBoundary,
  stopProcessBoundary,
} from '../plugins/plumbob-harness-control/mcp/v3/process-boundary.mjs';

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(read, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the process-boundary acceptance condition.');
}

const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-boundary-'));
const fixture = path.join(root, 'worker.mjs');
const pidFile = path.join(root, 'descendant.pid');
let launched;
let descendantPid;

try {
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    "import { writeFile } from 'node:fs/promises';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    'child.unref();',
    'await writeFile(process.argv[2], `${child.pid}\\n`, { mode: 0o600 });',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o600 });

  const probe = await probeProcessBoundary();
  assert.equal(probe.ready, true, JSON.stringify(probe));
  launched = await launchProcessBoundary({
    command: process.execPath,
    args: [fixture, pidFile],
    cwd: root,
    env: process.env,
    stdio: 'ignore',
    taskId: 'release-boundary-preflight',
  });
  descendantPid = Number(await waitFor(
    () => readFile(pidFile, 'utf8'),
    (value) => Number.isInteger(Number(value.trim())),
  ));
  assert.equal(processAlive(descendantPid), true);
  const stopped = await stopProcessBoundary(launched.handle);
  assert.equal(stopped.cgroup_empty, true);
  await waitFor(async () => processAlive(descendantPid), (alive) => alive === false);
  process.stdout.write(`${JSON.stringify({ boundary: probe.boundary, cgroup_empty: true, detached_descendant_alive: false })}\n`);
} finally {
  if (launched?.handle) await stopProcessBoundary(launched.handle).catch(() => {});
  if (descendantPid && processAlive(descendantPid)) {
    try { process.kill(descendantPid, 'SIGKILL'); } catch {}
  }
  await rm(root, { recursive: true, force: true });
}
