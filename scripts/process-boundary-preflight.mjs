#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  classifyExactProcessIdentity,
  freezeExactProcessIdentity,
  inspectExactProcessBoundary,
  launchProcessBoundary,
  observeExactProcessIdentity,
  probeProcessBoundary,
  PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS,
  stopProcessBoundary,
} from '../plugins/codex-co-engineer/mcp/v3/process-boundary.mjs';

async function waitFor(read, predicate, timeoutMs = PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS.exact_unit_stop_and_empty_proof) {
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

function descendantExited(classified) {
  return classified?.class === 'exited' && classified.live !== true && classified.cgroup_empty_allowed === true;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-boundary-'));
const fixture = path.join(root, 'worker.mjs');
const pidFile = path.join(root, 'descendant.pid');
let launched;
let descendantPid;
let descendantIdentity;

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
    (value) => Number.isSafeInteger(Number(value.trim())) && Number(value.trim()) > 1,
  ));
  const observed = await observeExactProcessIdentity(descendantPid);
  descendantIdentity = freezeExactProcessIdentity(observed);
  assert.equal(Boolean(descendantIdentity), true, JSON.stringify(observed));
  assert.equal(observed.state === 'Z' || observed.state === 'X' || observed.state === 'x', false);
  const stopped = await stopProcessBoundary(launched.handle, {
    rememberedIdentities: [descendantIdentity],
    timeoutMs: PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS.exact_unit_stop_and_empty_proof,
  });
  assert.equal(stopped.cgroup_empty, true);
  const proof = await waitFor(async () => {
    const inspection = await inspectExactProcessBoundary(launched.receipt, {
      rememberedIdentities: [descendantIdentity],
    });
    const classified = classifyExactProcessIdentity({
      expected: descendantIdentity,
      observed: await observeExactProcessIdentity(descendantIdentity.pid),
      boundary: {
        expected_cgroup: launched.handle.control_group,
        expected_unit: launched.handle.unit,
        expected_invocation_id: launched.handle.invocation_id,
        unit_inactive: inspection.state === 'inactive_empty',
        cgroup_empty: inspection.state === 'inactive_empty' && inspection.empty === true,
      },
    });
    if (classified.class === 'containment_failure_live_outside_cgroup' || classified.class === 'pid_reuse' || classified.class === 'namespace_mismatch') {
      throw Object.assign(new Error(`owned descendant classification ${classified.class}`), { code: classified.code ?? classified.class });
    }
    return { inspection, classified };
  }, ({ inspection, classified }) => inspection.state === 'inactive_empty' && descendantExited(classified));
  assert.equal(proof.inspection.state, 'inactive_empty');
  assert.equal(proof.classified.live, false);
  process.stdout.write(`${JSON.stringify({ boundary: probe.boundary, cgroup_empty: true, detached_descendant_alive: false })}\n`);
} finally {
  if (launched?.handle) await stopProcessBoundary(launched.handle).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
