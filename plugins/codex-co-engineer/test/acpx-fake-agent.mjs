/* Minimal ACP stdio agent used by the v3 ACP worker tests. */

import { spawn } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const FIXTURE_MODES = new Set([
  'normal',
  'raw-partial-frame',
  'silent-initialize',
  'silent-session-create',
]);
const modeIndex = process.argv.indexOf('--mode');
const fixtureMode = modeIndex === 2 ? process.argv[3] : undefined;
if (process.argv.length !== 4 || !FIXTURE_MODES.has(fixtureMode)) {
  process.stderr.write('acpx-fake-agent: invalid fixed fixture mode\n');
  process.exit(2);
}

const sessions = new Set();
const pendingPrompts = new Map();
let nextId = 1;
let descendant = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function errorResponse(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function observeEnvironment() {
  const observed = {
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right))),
  };
  await writeFile(join(process.cwd(), '.acpx-fake-observed.json'), `${JSON.stringify(observed)}\n`, { mode: 0o600 });
}

async function spawnDescendant({ nonCooperative = false } = {}) {
  if (descendant && descendant.exitCode === null) return;
  const source = nonCooperative
    ? 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
    : 'setInterval(() => {}, 1000)';
  descendant = spawn(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    detached: nonCooperative,
    stdio: 'ignore',
  });
  if (nonCooperative) {
    descendant.unref();
    // Let the detached fixture install its SIGTERM handler before the ACP
    // update tells the test that cancellation can begin.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await writeFile(join(process.cwd(), '.acpx-fake-descendant.pid'), `${descendant.pid}\n`, { mode: 0o600 });
}

async function cleanupDescendant() {
  if (!descendant || descendant.exitCode !== null) return;
  try {
    descendant.kill('SIGTERM');
  } catch {
    // The child may have exited between the check and kill.
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    descendant.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sessionUpdate(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  });
}

async function finishPrompt(id, sessionId, stopReason = 'end_turn') {
  pendingPrompts.delete(id);
  await cleanupDescendant();
  response(id, { stopReason });
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    await observeEnvironment();
    if (fixtureMode === 'silent-initialize') return;
    response(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {} },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'session/new') {
    if (fixtureMode === 'silent-session-create') return;
    const sessionId = `fake-session-${sessions.size + 1}`;
    sessions.add(sessionId);
    response(id, { sessionId });
    return;
  }
  if (method === 'session/close') {
    await cleanupDescendant();
    await writeFile(join(process.cwd(), '.acpx-fake-close.json'), `${JSON.stringify(params)}\n`, { mode: 0o600 });
    response(id, {});
    return;
  }
  if (method === 'session/cancel') {
    for (const [promptId, prompt] of pendingPrompts) {
      if (prompt.sessionId !== params.sessionId) continue;
      if (prompt.hostileTimeout) continue;
      clearTimeout(prompt.timer);
      await finishPrompt(promptId, prompt.sessionId, 'cancelled');
    }
    return;
  }
  if (method === 'session/prompt') {
    if (!sessions.has(params.sessionId)) {
      errorResponse(id, -32001, 'unknown session');
      return;
    }
    const text = Array.isArray(params.prompt)
      ? params.prompt.filter((entry) => entry?.type === 'text').map((entry) => entry.text).join(' ')
      : '';
    if (fixtureMode === 'raw-partial-frame') {
      // Deliberately exercise the embedded ACPX parser's upstream-unbounded
      // partial-line accumulator.  The outer launcher must impose the real
      // transport/memory limit; this disabled worker only supplies a deadline.
      process.stdout.write(`{"jsonrpc":"2.0","method":"session/update","params":{"padding":"${'x'.repeat(512 * 1024)}`);
      pendingPrompts.set(id, { sessionId: params.sessionId, timer: null, hostileTimeout: true });
      return;
    }
    if (text.includes('hostile-descendant')) {
      await spawnDescendant({ nonCooperative: true });
    } else if (text.includes('slow') || text.includes('cancel')) {
      await spawnDescendant();
    }
    if (text.includes('provider-failure')) {
      errorResponse(id, -32077, `provider rendered argv and prompt: ${text}`);
      return;
    }
    if (text.includes('queue-overflow')) {
      for (let index = 0; index < 1_200; index += 1) {
        sessionUpdate(params.sessionId, `queue-overflow-${index}-${'x'.repeat(5_000)}`);
      }
      await finishPrompt(id, params.sessionId);
      return;
    }
    if (text.includes('hostile-timeout')) {
      pendingPrompts.set(id, { sessionId: params.sessionId, timer: null, hostileTimeout: true });
      return;
    }
    sessionUpdate(params.sessionId, text.includes('large') ? 'x'.repeat(5000) : 'fake-chunk-1');
    if (text.includes('large')) sessionUpdate(params.sessionId, 'fake-chunk-2');
    if (text.includes('output-overflow')) {
      for (let index = 0; index < 100; index += 1) {
        sessionUpdate(params.sessionId, `overflow-${index}-${'x'.repeat(5000)}`);
      }
      await finishPrompt(id, params.sessionId);
      return;
    }
    if (text.includes('permission')) {
      const permissionId = nextId++;
      pendingPrompts.set(id, { sessionId: params.sessionId, timer: null });
      send({
        jsonrpc: '2.0',
        id: permissionId,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'fake-permission', title: 'Fake permission' },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject once' },
          ],
        },
      });
      pendingPrompts.get(id).permissionId = permissionId;
      return;
    }
    if (text.includes('slow') || text.includes('cancel')) {
      const timer = setTimeout(() => finishPrompt(id, params.sessionId), 2_000);
      pendingPrompts.set(id, { sessionId: params.sessionId, timer });
      return;
    }
    await finishPrompt(id, params.sessionId);
    return;
  }
  // ACP clients answer our permission request with a JSON-RPC response.  The
  // response id is not a method, so resolve it against the active prompt.
  if (Object.hasOwn(message, 'result') && id !== undefined) {
    for (const [promptId, prompt] of pendingPrompts) {
      if (prompt.permissionId !== id) continue;
      const selected = params?.outcome?.optionId ?? message.result?.outcome?.optionId;
      sessionUpdate(prompt.sessionId, selected === 'allow' ? 'permission-selected-allow' : 'permission-selected-reject');
      await finishPrompt(promptId, prompt.sessionId);
      return;
    }
  }
  if (id !== undefined) errorResponse(id, -32601, `unsupported method: ${method}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
// Keep the stdio fixture alive even when Node decides the readline wrapper has
// no pending work between protocol frames.
process.stdin.resume();
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  Promise.resolve(handleRequest(message)).catch(async (error) => {
    await appendFile(join(process.cwd(), '.acpx-fake-agent-errors.log'), `${error?.stack ?? error}\n`).catch(() => {});
    if (message.id !== undefined) errorResponse(message.id, -32099, 'fake agent error');
  });
});

async function shutdown() {
  await cleanupDescendant();
  input.close();
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
