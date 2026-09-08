import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
} from '../assets/acpx-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'acpx-fake-agent.mjs');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const stateOffset = stat.lastIndexOf(')') + 2;
      if (stateOffset > 1 && stat[stateOffset] === 'Z') return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await delay(25);
  return !processAlive(pid);
}

async function fixture(mode, timeoutMs = 2_000, sessionOptions = undefined) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-acpx-runtime-'));
  const cwd = path.join(root, 'worktree');
  const stateDir = path.join(root, 'state');
  await mkdir(cwd);
  await mkdir(stateDir);
  const runtime = createAcpRuntime({
    cwd,
    sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: { grok: [process.execPath, FAKE_AGENT, '--mode', mode] },
    }),
    mcpServers: [],
    permissionMode: 'approve-all',
    timeoutMs,
  });
  try {
    const handle = await runtime.ensureSession({
      sessionKey: `runtime-${mode}`,
      agent: 'grok',
      mode: 'persistent',
      cwd,
      sessionOptions,
    });
    return { root, cwd, runtime, handle };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('session rules are bounded and preserve existing ACPX session metadata', async () => {
  const value = await fixture('capture-wire', 2_000, {
    rules: 'Return only the requested final answer.',
    allowedTools: ['Read'],
    maxTurns: 3,
    systemPrompt: { append: 'Existing Claude append rule.' },
  });
  try {
    const params = JSON.parse(await readFile(path.join(value.cwd, '.acpx-fake-session-new.json'), 'utf8'));
    assert.equal(params._meta.rules, 'Return only the requested final answer.');
    assert.deepEqual(params._meta.systemPrompt, { append: 'Existing Claude append rule.' });
    assert.deepEqual(params._meta.claudeCode.options, {
      allowedTools: ['Read'],
      maxTurns: 3,
    });
  } finally {
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
  }
});

test('session rules reject malformed or over-bound values explicitly', async () => {
  const boundary = await fixture('capture-wire', 2_000, { rules: 'x'.repeat(4 * 1024) });
  try {
    const params = JSON.parse(await readFile(path.join(boundary.cwd, '.acpx-fake-session-new.json'), 'utf8'));
    assert.equal(params._meta.rules, 'x'.repeat(4 * 1024));
  } finally {
    await boundary.runtime.close({ handle: boundary.handle, reason: 'test_cleanup' });
  }
  for (const rules of ['', '   ', 'contains\0nul', 'x'.repeat(4 * 1024 + 1), 42]) {
    await assert.rejects(
      fixture('normal', 2_000, { rules }),
      (error) => error?.code === 'ACP_SESSION_RULES_INVALID',
    );
  }
});

test('caps an unterminated ACP NDJSON frame and fails the turn closed', async () => {
  const value = await fixture('raw-partial-frame', 1_000);
  const startedAt = Date.now();
  try {
    const turn = value.runtime.startTurn({
      handle: value.handle,
      text: 'raw-partial-frame',
      mode: 'prompt',
      requestId: 'raw-partial-frame',
      timeoutMs: 1_000,
    });
    for await (const _event of turn.events) {}
    const result = await Promise.race([
      turn.result,
      delay(2_000).then(() => { throw new Error('ACP frame failure did not settle the turn.'); }),
    ]);
    assert.equal(result.status, 'failed');
    assert.ok(Date.now() - startedAt < 750, 'oversized frame should fail before the task deadline');
  } finally {
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
  }
});

test('bounds the queued ACP events instead of retaining unbounded output', async () => {
  const value = await fixture('normal', 3_000);
  try {
    const turn = value.runtime.startTurn({
      handle: value.handle,
      text: 'queue-overflow',
      mode: 'prompt',
      requestId: 'queue-overflow',
      timeoutMs: 3_000,
    });
    await delay(750);
    await assert.rejects(
      (async () => {
        for await (const _event of turn.events) {}
      })(),
      (error) => error?.code === 'ACP_EVENT_QUEUE_LIMIT',
    );
  } finally {
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
  }
});

test('kills hostile detached ACP descendants during runtime close', async () => {
  const value = await fixture('normal', 3_000);
  let descendantPid;
  let closed = false;
  const originalPath = process.env.PATH;
  try {
    const turn = value.runtime.startTurn({
      handle: value.handle,
      text: 'hostile-descendant',
      mode: 'prompt',
      requestId: 'hostile-descendant',
      timeoutMs: 3_000,
    });
    const result = await turn.result;
    assert.equal(result.status, 'completed');
    descendantPid = Number(await readFile(path.join(value.cwd, '.acpx-fake-descendant.pid'), 'utf8'));
    assert.ok(processAlive(descendantPid), 'fixture descendant should still be running before close');
    // Linux cleanup must not depend on an external process-list command.
    if (process.platform === 'linux') process.env.PATH = path.join(value.root, 'no-process-list-command');
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
    closed = true;
    assert.equal(await waitForProcessExit(descendantPid), true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (!closed) await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' }).catch(() => {});
    if (descendantPid && processAlive(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
  }
});

test('turn timeout settles and runtime close leaves no ACP child', async () => {
  const value = await fixture('normal', 500);
  try {
    const turn = value.runtime.startTurn({
      handle: value.handle,
      text: 'hostile-timeout',
      mode: 'prompt',
      requestId: 'hostile-timeout',
      timeoutMs: 500,
    });
    const result = await Promise.race([
      turn.result,
      delay(3_000).then(() => { throw new Error('ACP timeout did not settle the turn.'); }),
    ]);
    assert.equal(result.status, 'failed');
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
  } finally {
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' }).catch(() => {});
  }
});
