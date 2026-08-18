import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AcpBoundedProxyError,
  AcpBoundedTransportProxy,
  CONTROL_FRAME_MAX_BYTES,
  MAX_PROVIDER_BYTES_PER_TURN,
  MAX_PROVIDER_FRAMES_PER_TURN,
  PROVIDER_FRAME_MAX_BYTES,
} from '../mcp/acp-bounded-proxy.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));

const PROVIDER_SCRIPT = String.raw`
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const mode = process.argv[1];
const pidFile = process.argv[2];
let input = Buffer.alloc(0);
let descendant;

function send(value) {
  process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
}

function startDescendant() {
  if (descendant) return;
  descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], {
    stdio: 'ignore',
  });
  if (pidFile) writeFileSync(pidFile, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
}

function request(value) {
  if (mode === 'env') {
    send({ method: 'environment', params: { hasSentinel: Boolean(process.env.ACP_PROXY_SENTINEL) } });
    return;
  }
  if (mode === 'unterminated') {
    process.stdout.write('x'.repeat(512 * 1024));
    return;
  }
  if (mode === 'oversized') {
    process.stdout.write(JSON.stringify({ method: 'session/update', params: { text: 'x'.repeat(256 * 1024) } }) + String.fromCharCode(10));
    return;
  }
  if (mode === 'invalid-utf8') {
    process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    return;
  }
  if (mode === 'malformed') {
    process.stdout.write('{"broken":' + String.fromCharCode(10));
    return;
  }
  if (mode === 'flood') {
    for (let index = 0; index < 10000; index += 1) {
      send({ method: 'session/update', params: { index } });
    }
    return;
  }
  if (mode === 'split-utf8') {
    const bytes = Buffer.from(JSON.stringify({ method: 'session/update', params: { text: 'split € bytes' } }) + String.fromCharCode(10));
    const split = bytes.indexOf(0xe2) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
    return;
  }
  if (mode === 'stubborn') {
    process.on('SIGTERM', () => {});
    startDescendant();
    process.stdout.write('x'.repeat(512 * 1024));
    return;
  }
  if (value.method === 'initialize') {
    send({ jsonrpc: '2.0', id: value.id, result: { protocolVersion: 1 } });
    return;
  }
  if (value.method === 'session/new') {
    send({ jsonrpc: '2.0', id: value.id, result: { sessionId: 'session-local' } });
    return;
  }
  if (value.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } } });
    send({ jsonrpc: '2.0', id: value.id, result: { stopReason: 'end_turn' } });
  }
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  let newline;
  while ((newline = input.indexOf(0x0a)) !== -1) {
    const line = input.subarray(0, newline).toString('utf8');
    input = input.subarray(newline + 1);
    try { request(JSON.parse(line)); } catch { process.exitCode = 64; }
  }
});
`;

function makeStreams() {
  const controlInput = new PassThrough();
  const controlOutput = new PassThrough();
  const received = [];
  controlOutput.on('data', (chunk) => received.push(Buffer.from(chunk)));
  return { controlInput, controlOutput, received };
}

function makeProxy(mode = 'normal', options = {}) {
  const streams = makeStreams();
  const providerArgs = [
    '--input-type=module',
    '-e',
    PROVIDER_SCRIPT,
    mode,
    options.pidFile ?? '',
  ];
  const child = options.spawnOwned ? null : spawn(process.execPath, providerArgs, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const proxyOptions = {
    ...streams,
    termGraceMs: options.termGraceMs ?? 100,
    killGraceMs: options.killGraceMs ?? 200,
  };
  if (child) proxyOptions.providerProcess = child;
  else {
    proxyOptions.providerCommand = process.execPath;
    proxyOptions.providerArgs = providerArgs;
  }
  const proxy = new AcpBoundedTransportProxy(proxyOptions);
  proxy.start();
  return { ...streams, child, proxy };
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function outputText(received) {
  return Buffer.concat(received).toString('utf8');
}

async function finish(proxy) {
  try {
    await proxy.close();
  } catch {
    // A terminal proxy rejects wait(); cleanup still completed.
  }
}

test('import is side-effect-free and exposes the exact fixed limits', () => {
  assert.equal(CONTROL_FRAME_MAX_BYTES, 64 * 1024);
  assert.equal(PROVIDER_FRAME_MAX_BYTES, 256 * 1024);
  assert.equal(MAX_PROVIDER_FRAMES_PER_TURN, 2000);
  assert.equal(MAX_PROVIDER_BYTES_PER_TURN, 8 * 1024 * 1024);
});

test('provider startup uses a minimal environment instead of inheriting ambient secrets', async (context) => {
  const previous = process.env.ACP_PROXY_SENTINEL;
  process.env.ACP_PROXY_SENTINEL = 'must-not-reach-provider';
  context.after(() => {
    if (previous === undefined) delete process.env.ACP_PROXY_SENTINEL;
    else process.env.ACP_PROXY_SENTINEL = previous;
  });
  const { proxy, controlInput, received } = makeProxy('env', { spawnOwned: true });
  context.after(() => finish(proxy));
  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  assert.equal(await waitFor(() => outputText(received).includes('hasSentinel')), true);
  assert.match(outputText(received), /"hasSentinel":false/u);
});

test('normal initialize/session/prompt flow forwards only validated frames', async (context) => {
  const { proxy, controlInput, controlOutput, received } = makeProxy();
  const providerEvents = [];
  proxy.on('provider_message', (message) => providerEvents.push(message));
  context.after(() => finish(proxy));

  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }) + '\n');
  controlInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'session-local', prompt: [{ type: 'text', text: 'hello' }] },
  }) + '\n');

  assert.equal(await waitFor(() => outputText(received).includes('"stopReason":"end_turn"')), true);
  const values = outputText(received).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(values[0].id, 1);
  assert.equal(values[1].result.sessionId, 'session-local');
  assert.equal(values.at(-1).id, 3);
  assert.equal(values.at(-1).result.stopReason, 'end_turn');
  assert.equal(providerEvents.length, values.length);
  assert.equal(proxy.activeTurn, null);
  assert.equal(proxy.state, 'running');
  controlOutput.resume();
});

test('split UTF-8 code points are decoded strictly only after the frame is complete', async (context) => {
  const { proxy, controlInput, received } = makeProxy('split-utf8');
  context.after(() => finish(proxy));
  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} }) + '\n');
  assert.equal(await waitFor(() => outputText(received).includes('split € bytes')), true);
  assert.match(outputText(received), /split € bytes/u);
});

test('a 512 KiB unterminated provider frame is rejected before ACPX sees it', async (context) => {
  const { proxy, controlInput, received } = makeProxy('unterminated');
  context.after(() => finish(proxy));
  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} }) + '\n');
  await assert.rejects(proxy.wait(), (error) => error instanceof AcpBoundedProxyError
    && error.classification === 'output_too_large');
  assert.equal(received.length, 0);
});

test('an oversized newline-terminated provider frame is rejected before forwarding', async (context) => {
  const { proxy, controlInput, received } = makeProxy('oversized');
  context.after(() => finish(proxy));
  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} }) + '\n');
  await assert.rejects(proxy.wait(), (error) => error.classification === 'output_too_large');
  assert.equal(received.length, 0);
});

test('a ten-thousand-event turn stops at 2000 provider frames', async (context) => {
  const { proxy, controlInput, received } = makeProxy('flood');
  const providerEvents = [];
  proxy.on('provider_message', (message) => providerEvents.push(message));
  context.after(() => finish(proxy));
  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} }) + '\n');
  await assert.rejects(proxy.wait(), (error) => error.classification === 'output_too_large');
  const forwarded = outputText(received).trim().split('\n').filter(Boolean);
  assert.equal(forwarded.length, MAX_PROVIDER_FRAMES_PER_TURN);
  assert.equal(providerEvents.length, MAX_PROVIDER_FRAMES_PER_TURN);
  assert.equal(received.reduce((total, chunk) => total + chunk.length, 0) <= MAX_PROVIDER_BYTES_PER_TURN, true);
});

test('control input rejects an oversized partial frame and terminates the provider', async (context) => {
  const { proxy, controlInput } = makeProxy();
  context.after(() => finish(proxy));
  controlInput.write(Buffer.alloc(CONTROL_FRAME_MAX_BYTES + 1, 0x78));
  await assert.rejects(proxy.wait(), (error) => error.classification === 'transport_overflow');
});

test('invalid UTF-8 and malformed JSON are normalized without leaking bytes', async (context) => {
  const invalid = makeProxy('invalid-utf8');
  context.after(() => finish(invalid.proxy));
  invalid.controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} }) + '\n');
  await assert.rejects(invalid.proxy.wait(), (error) => error.classification === 'malformed_transport'
    && error.message.length < 128
    && !error.message.includes('c3'));

  const malformed = makeProxy('malformed');
  context.after(() => finish(malformed.proxy));
  malformed.controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} }) + '\n');
  await assert.rejects(malformed.proxy.wait(), (error) => error.classification === 'malformed_transport'
    && !error.message.includes('broken'));
});

test('concurrent prompt turns are rejected while the first turn remains active', async (context) => {
  const { proxy } = makeProxy('normal');
  context.after(() => finish(proxy));
  await proxy.send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} });
  await assert.rejects(
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: {} }),
    (error) => error.code === 'concurrent_turn' && error.terminal === false,
  );
});

test('backpressure is awaited before the next provider write', async (context) => {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let callback;
  const writes = [];
  stdin.write = (chunk, done) => {
    writes.push(Buffer.from(chunk));
    callback = done;
    return false;
  };
  stdin.end = () => {};
  stdin.destroy = () => {};
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 0;
  child.kill = () => { child.emit('exit', 0, null); };
  const proxy = new AcpBoundedTransportProxy({
    controlOutput: new PassThrough(),
    providerProcess: child,
    ownedProvider: false,
    termGraceMs: 0,
    killGraceMs: 0,
  }).start();
  context.after(() => finish(proxy));

  const pending = proxy.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes.length, 1);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  callback();
  stdin.emit('drain');
  await pending;
});

test('terminal cleanup kills a stubborn descendant in the owned process group', async (context) => {
  if (process.platform === 'win32') return context.skip('POSIX process groups are required by this slice');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'acp-proxy-descendant-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'descendant.pid');
  const { proxy, controlInput } = makeProxy('stubborn', { pidFile, termGraceMs: 50, killGraceMs: 100 });
  context.after(() => finish(proxy));
  controlInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} }) + '\n');
  assert.ok(await waitFor(async () => {
    try { return (await readFile(pidFile, 'utf8')).trim(); } catch { return false; }
  }));
  const processIds = JSON.parse(await readFile(pidFile, 'utf8'));
  const parentPid = Number(processIds.parent);
  const descendantPid = Number(processIds.descendant);
  await assert.rejects(proxy.wait(), (error) => error.classification === 'output_too_large');
  assert.equal(await waitFor(() => {
    try {
      process.kill(parentPid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  }), true);
  assert.equal(await waitFor(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  }), true);
});
