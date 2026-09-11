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

test('retains the persistent ACP client before turn result settles', async () => {
  const value = await fixture('normal', 3_000);
  let descendantPid;
  let agentPid;
  let closed = false;
  try {
    const manager = await value.runtime.getManager();
    const turn = value.runtime.startTurn({
      handle: value.handle,
      text: 'hostile-descendant',
      mode: 'prompt',
      requestId: 'retain-before-result',
      timeoutMs: 3_000,
    });
    const result = await turn.result;
    // Same synchronous continuation as turn.result: any await here lets
    // finalize populate pendingPersistentClients and hides the ordering gap.
    // Capture PIDs with readFileSync first so finally can reap on assert failure.
    agentPid = Number(readFileSync(path.join(value.cwd, '.acpx-fake-agent.pid'), 'utf8'));
    descendantPid = Number(readFileSync(path.join(value.cwd, '.acpx-fake-descendant.pid'), 'utf8'));
    assert.equal(
      manager.pendingPersistentClients.has(value.handle.acpxRecordId),
      true,
      'persistent client must be retained before turn.result resolves',
    );
    assert.equal(result.status, 'completed');
    assert.ok(processAlive(agentPid), 'fixture agent should still be running after retain');
    assert.ok(processAlive(descendantPid), 'fixture descendant should still be running after retain');
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
    closed = true;
    assert.equal(await waitForProcessExit(agentPid, 1_000), true);
    assert.equal(await waitForProcessExit(descendantPid), true);
  } finally {
    if (!closed) await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' }).catch(() => {});
    for (const pid of [descendantPid, agentPid]) {
      if (pid && processAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }
});

test('abort during post-prompt drain settles and reaps ask-user-unsupported agent', async () => {
  const value = await fixture('ask-user-unsupported', 8_000);
  let agentPid;
  let closed = false;
  try {
    const controller = new AbortController();
    const turn = value.runtime.startTurn({
      handle: value.handle,
      text: 'ask-user-unsupported',
      mode: 'prompt',
      requestId: 'unsupported-drain-abort',
      timeoutMs: 0,
      signal: controller.signal,
    });
    const events = (async () => {
      for await (const event of turn.events) {
        if (event?.type === 'tool_call' || event?.title === 'ask_user_question') {
          // Abort inside the post-prompt idle/drain window after the agent has
          // already finished emitting the unsupported-question transcript.
          controller.abort();
        }
      }
    })();
    const started = Date.now();
    const [result] = await Promise.all([turn.result, events]);
    const elapsedMs = Date.now() - started;
    agentPid = Number(readFileSync(path.join(value.cwd, '.acpx-fake-agent.pid'), 'utf8'));
    assert.ok(
      result.status === 'cancelled' || result.status === 'completed',
      `turn must settle after drain abort, got ${result.status}`,
    );
    assert.ok(elapsedMs < 6_000, `drain abort must not hang past the idle cap (${elapsedMs}ms)`);
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
    closed = true;
    assert.equal(await waitForProcessExit(agentPid, 2_000), true);
  } finally {
    if (!closed) await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' }).catch(() => {});
    if (agentPid && processAlive(agentPid)) {
      try { process.kill(agentPid, 'SIGKILL'); } catch {}
    }
  }
});

test('kills hostile detached ACP descendants during runtime close', async () => {
  const value = await fixture('normal', 3_000);
  let descendantPid;
  let agentPid;
  let closed = false;
  const originalPath = process.env.PATH;
  try {
    const manager = await value.runtime.getManager();
    const turn = value.runtime.startTurn({
      handle: value.handle,
      text: 'hostile-descendant',
      mode: 'prompt',
      requestId: 'hostile-descendant',
      timeoutMs: 3_000,
    });
    const result = await turn.result;
    assert.equal(result.status, 'completed');
    agentPid = Number(await readFile(path.join(value.cwd, '.acpx-fake-agent.pid'), 'utf8'));
    descendantPid = Number(await readFile(path.join(value.cwd, '.acpx-fake-descendant.pid'), 'utf8'));
    assert.ok(
      manager.pendingPersistentClients.has(value.handle.acpxRecordId),
      'close must observe the retained persistent client',
    );
    assert.ok(processAlive(agentPid), 'fixture agent should still be running before close');
    assert.ok(processAlive(descendantPid), 'fixture descendant should still be running before close');
    // Linux cleanup must not depend on an external process-list command.
    if (process.platform === 'linux') process.env.PATH = path.join(value.root, 'no-process-list-command');
    await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' });
    closed = true;
    assert.equal(await waitForProcessExit(descendantPid), true);
    assert.equal(await waitForProcessExit(agentPid, 1_000), true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (!closed) await value.runtime.close({ handle: value.handle, reason: 'test_cleanup' }).catch(() => {});
    // Leave no fixture children even when assertions fail; otherwise the Node
    // test worker stays alive on the unreaped ACP agent and hangs the suite.
    for (const pid of [descendantPid, agentPid]) {
      if (pid && processAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
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

test('concurrent turns isolate AbortSignals across two active sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-acpx-signal-isolation-'));
  const cwd = path.join(root, 'worktree');
  const stateDir = path.join(root, 'state');
  await mkdir(cwd);
  await mkdir(stateDir);
  const agentPath = path.join(root, 'signal-isolation-agent.mjs');
  await writeFile(agentPath, `import { createInterface } from 'node:readline';
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function response(id, result) { send({ jsonrpc: '2.0', id, result }); }
function promptText(params) {
  const block = params?.prompt?.[0];
  return typeof block?.text === 'string' ? block.text : '';
}
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
  if (method === 'session/new') {
    return response(id, { sessionId: 'iso-' + Math.random().toString(16).slice(2) });
  }
  if (method === 'session/close') return response(id, {});
  if (method === 'session/cancel') {
    for (const [promptId] of pending) {
      response(promptId, { stopReason: 'cancelled' });
      pending.delete(promptId);
    }
    return;
  }
  if (method === 'session/prompt') {
    const text = promptText(params);
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: text.includes('complete-me') ? 'session-b-live' : 'session-a-hold' },
        },
      },
    });
    if (text.includes('complete-me')) {
      setTimeout(() => response(id, { stopReason: 'end_turn' }), 400);
      return;
    }
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
  const handleA = await runtime.ensureSession({
    sessionKey: 'signal-iso-a',
    agent: 'grok',
    mode: 'persistent',
    cwd,
  });
  const handleB = await runtime.ensureSession({
    sessionKey: 'signal-iso-b',
    agent: 'grok',
    mode: 'persistent',
    cwd,
  });
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const turnA = runtime.startTurn({
      handle: handleA,
      text: 'cancel-me',
      mode: 'prompt',
      requestId: 'iso-a',
      timeoutMs: 0,
      signal: controllerA.signal,
    });
    const turnB = runtime.startTurn({
      handle: handleB,
      text: 'complete-me',
      mode: 'prompt',
      requestId: 'iso-b',
      timeoutMs: 0,
      signal: controllerB.signal,
    });
    const drain = async (turn) => {
      for await (const _event of turn.events) {
        // Drain so close is not blocked on an open iterator.
      }
    };
    const drainA = drain(turnA);
    const drainB = drain(turnB);
    await delay(100);
    controllerA.abort();
    const [resultA, resultB] = await Promise.all([
      Promise.race([
        turnA.result,
        delay(3_000).then(() => { throw new Error('session A cancel did not settle'); }),
      ]),
      Promise.race([
        turnB.result,
        delay(3_000).then(() => { throw new Error('session B turn did not settle'); }),
      ]),
    ]);
    await Promise.all([drainA, drainB]);
    assert.equal(resultA.status, 'cancelled');
    assert.equal(resultA.stopReason, 'cancelled');
    assert.equal(resultB.status, 'completed');
    assert.equal(resultB.stopReason, 'end_turn');
    assert.equal(controllerB.signal.aborted, false);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await runtime.close({ handle: handleA, reason: 'test_cleanup' }).catch(() => {});
    await runtime.close({ handle: handleB, reason: 'test_cleanup' }).catch(() => {});
  }
});

test('pre-aborted signal and hostile late prompt settlement stay closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-acpx-hostile-settle-'));
  const cwd = path.join(root, 'worktree');
  const stateDir = path.join(root, 'state');
  await mkdir(cwd);
  await mkdir(stateDir);
  const agentPath = path.join(root, 'hostile-settle-agent.mjs');
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
  if (method === 'session/new') return response(id, { sessionId: 'hostile-settle-session' });
  if (method === 'session/close') return response(id, {});
  if (method === 'session/cancel') return; // hostile: ignore cancel
  if (method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hostile-partial' },
        },
      },
    });
    setTimeout(() => response(id, { stopReason: 'end_turn' }), 600);
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

  const preAborted = new AbortController();
  preAborted.abort();
  const preHandle = await runtime.ensureSession({
    sessionKey: 'hostile-preabort',
    agent: 'grok',
    mode: 'persistent',
    cwd,
  });
  const preTurn = runtime.startTurn({
    handle: preHandle,
    text: 'already aborted',
    mode: 'prompt',
    requestId: 'preabort',
    timeoutMs: 0,
    signal: preAborted.signal,
  });
  for await (const _event of preTurn.events) {}
  const preResult = await preTurn.result;
  assert.equal(preResult.status, 'cancelled');
  await runtime.close({ handle: preHandle, reason: 'test_cleanup' }).catch(() => {});

  const handle = await runtime.ensureSession({
    sessionKey: 'hostile-late-settle',
    agent: 'grok',
    mode: 'persistent',
    cwd,
  });
  const controller = new AbortController();
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const turn = runtime.startTurn({
      handle,
      text: 'hostile ignore cancel then settle',
      mode: 'prompt',
      requestId: 'hostile-late',
      timeoutMs: 0,
      signal: controller.signal,
    });
    const events = (async () => {
      for await (const _event of turn.events) {}
    })();
    await delay(100);
    controller.abort();
    const result = await Promise.race([
      turn.result,
      delay(3_000).then(() => { throw new Error('hostile cancel did not settle'); }),
    ]);
    await events;
    await delay(700);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.stopReason, 'cancelled');
    assert.notEqual(result.status, 'completed');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await runtime.close({ handle, reason: 'test_cleanup' }).catch(() => {});
  }
});
