import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

async function fixture(mode, timeoutMs = 2_000) {
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
  const handle = await runtime.ensureSession({
    sessionKey: `runtime-${mode}`,
    agent: 'grok',
    mode: 'persistent',
    cwd,
  });
  return { root, cwd, runtime, handle };
}

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

test('partial agent reply before a fixed turn timeout is not completed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-acpx-partial-timeout-'));
  const cwd = path.join(root, 'worktree');
  const stateDir = path.join(root, 'state');
  await mkdir(cwd);
  await mkdir(stateDir);
  const agentPath = path.join(root, 'partial-timeout-agent.mjs');
  await writeFile(agentPath, `import { createInterface } from 'node:readline';
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function response(id, result) { send({ jsonrpc: '2.0', id, result }); }
async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return response(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'session/new') return response(id, { sessionId: 'partial-timeout-session' });
  if (method === 'session/close') return response(id, {});
  if (method === 'session/cancel') return;
  if (method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial-before-timeout' },
        },
      },
    });
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
process.stdin.resume();
input.on('line', (line) => { try { handle(JSON.parse(line)); } catch {} });
process.once('SIGTERM', () => process.exit(0));
`);
  const runtime = createAcpRuntime({
    cwd,
    sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: { grok: [process.execPath, agentPath] },
    }),
    mcpServers: [],
    permissionMode: 'approve-all',
    timeoutMs: 2_000,
  });
  const handle = await runtime.ensureSession({
    sessionKey: 'partial-timeout',
    agent: 'grok',
    mode: 'persistent',
    cwd,
  });
  try {
    const turn = runtime.startTurn({
      handle,
      text: 'partial then hang',
      mode: 'prompt',
      requestId: 'partial-timeout',
      timeoutMs: 400,
    });
    const chunks = [];
    for await (const event of turn.events) {
      if (event?.type === 'text_delta' && typeof event.text === 'string') chunks.push(event.text);
    }
    const result = await Promise.race([
      turn.result,
      delay(3_000).then(() => { throw new Error('partial timeout did not settle'); }),
    ]);
    assert.equal(result.status, 'failed');
    assert.notEqual(result.status, 'completed');
    assert.notEqual(result.stopReason, 'end_turn');
    assert.deepEqual(chunks, ['partial-before-timeout']);
  } finally {
    await runtime.close({ handle, reason: 'test_cleanup' }).catch(() => {});
  }
});

test('turn AbortSignal owns cancellation when the fixed turn timeout is disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-acpx-signal-cancel-'));
  const cwd = path.join(root, 'worktree');
  const stateDir = path.join(root, 'state');
  await mkdir(cwd);
  await mkdir(stateDir);
  const agentPath = path.join(root, 'signal-cancel-agent.mjs');
  await writeFile(agentPath, `import { createInterface } from 'node:readline';
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function response(id, result) { send({ jsonrpc: '2.0', id, result }); }
const pending = new Map();
async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return response(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'session/new') return response(id, { sessionId: 'signal-cancel-session' });
  if (method === 'session/close') return response(id, {});
  if (method === 'session/cancel') {
    for (const [promptId] of pending) {
      response(promptId, { stopReason: 'cancelled' });
      pending.delete(promptId);
    }
    return;
  }
  if (method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'waiting-for-cancel' },
        },
      },
    });
    pending.set(id, params.sessionId);
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
process.stdin.resume();
input.on('line', (line) => { try { handle(JSON.parse(line)); } catch {} });
process.once('SIGTERM', () => process.exit(0));
`);
  const runtime = createAcpRuntime({
    cwd,
    sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: { grok: [process.execPath, agentPath] },
    }),
    mcpServers: [],
    permissionMode: 'approve-all',
    timeoutMs: 5_000,
  });
  const handle = await runtime.ensureSession({
    sessionKey: 'signal-cancel',
    agent: 'grok',
    mode: 'persistent',
    cwd,
  });
  try {
    const controller = new AbortController();
    const turn = runtime.startTurn({
      handle,
      text: 'hold open for signal cancel',
      mode: 'prompt',
      requestId: 'signal-owned-cancel',
      timeoutMs: 0,
      signal: controller.signal,
    });
    const events = (async () => {
      for await (const _event of turn.events) {
        // Drain so close is not blocked on an open iterator.
      }
    })();
    await delay(100);
    controller.abort();
    const result = await Promise.race([
      turn.result,
      delay(3_000).then(() => { throw new Error('signal-owned cancel did not settle'); }),
    ]);
    await events;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.stopReason, 'cancelled');
  } finally {
    await runtime.close({ handle, reason: 'test_cleanup' }).catch(() => {});
  }
});
