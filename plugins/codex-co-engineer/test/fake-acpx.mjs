#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const agentIndex = argv.indexOf('--agent');
const cwdIndex = argv.indexOf('--cwd');
const timeoutIndex = argv.indexOf('--timeout');
const execIndex = argv.indexOf('exec');
const fileIndex = argv.indexOf('--file');
if (
  agentIndex < 0
  || cwdIndex < 0
  || timeoutIndex < 0
  || execIndex < 0
  || fileIndex < 0
  || argv[fileIndex + 1] !== '-'
  || argv[execIndex + 1] !== '--file'
  || !argv.includes('--approve-all')
  || !argv.includes('--json-strict')
  || argv[argv.indexOf('--format') + 1] !== 'json'
) {
  process.stderr.write('missing required ACPX exec arguments\n');
  process.exit(2);
}
const agent = argv[agentIndex + 1];
const cwd = argv[cwdIndex + 1];
const timeout = Number(argv[timeoutIndex + 1]);
if (
  typeof agent !== 'string'
  || !agent.includes("'--mode'")
  || typeof cwd !== 'string'
  || !path.isAbsolute(cwd)
  || !Number.isInteger(timeout)
  || timeout < 1
) {
  process.stderr.write('invalid deterministic ACPX invocation\n');
  process.exit(5);
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
if (prompt.length === 0) {
  process.stderr.write('missing stdin prompt\n');
  process.exit(4);
}
if (argv.some((entry) => entry === prompt)) {
  process.stderr.write('prompt must not be passed in ACPX argv\n');
  process.exit(6);
}

const fakeMode = process.env.FAKE_ACPX_MODE ?? 'success';
await writeFile(
  path.join(cwd, '.acpx-fake-observed.json'),
  `${JSON.stringify({ argv: process.argv.slice(1), cwd, env_keys: Object.keys(process.env).sort() })}\n`,
  { mode: 0o600 },
);
await writeFile(
  path.join(cwd, '.fake-acpx-env-keys.json'),
  `${JSON.stringify(Object.keys(process.env).sort())}\n`,
  { mode: 0o600 },
);
const home = process.env.HOME;
if (typeof home !== 'string' || !path.isAbsolute(home)) {
  process.stderr.write('task-scoped HOME is required\n');
  process.exit(7);
}
const homeMetadata = await stat(home);
if (!homeMetadata.isDirectory() || (homeMetadata.mode & 0o077) !== 0) {
  process.stderr.write('task-scoped HOME is not owner-only\n');
  process.exit(8);
}
await mkdir(path.join(home, '.acpx', 'sessions'), { recursive: true, mode: 0o700 });
await writeFile(path.join(home, '.acpx', 'sessions', 'session.json'), 'private fake session\n', { mode: 0o600 });
if (process.env.FAKE_ACPX_ARTIFACT_MARKER) {
  await writeFile(process.env.FAKE_ACPX_ARTIFACT_MARKER, 'created\n', { mode: 0o600 });
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

async function sendSplit(message) {
  const payload = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  const marker = Buffer.from('😀', 'utf8');
  const markerOffset = payload.indexOf(marker);
  const split = markerOffset >= 0 ? markerOffset + 1 : Math.floor(payload.length / 2);
  await new Promise((resolve, reject) => process.stdout.write(payload.subarray(0, split), (error) => (error ? reject(error) : resolve())));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve, reject) => process.stdout.write(payload.subarray(split), (error) => (error ? reject(error) : resolve())));
}

async function sendRequest(id, method, params = {}) {
  await send({ jsonrpc: '2.0', id, method, params });
}

async function sendResponse(id, result) {
  await send({ jsonrpc: '2.0', id, result });
}

async function sendError(id, code, message) {
  await send({ jsonrpc: '2.0', id, error: { code, message } });
}

if (fakeMode === 'timeout-tree') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  descendant.unref();
  if (process.env.FAKE_ACPX_DESCENDANT_PID_FILE) {
    await writeFile(process.env.FAKE_ACPX_DESCENDANT_PID_FILE, `${descendant.pid}\n`, { mode: 0o600 });
  }
  process.on('SIGTERM', () => {});
}

await sendRequest(0, 'initialize', { protocolVersion: 1 });
if (fakeMode === 'auth-error') {
  await sendError(0, -32001, '401: authentication_required (synthetic test)');
  process.exit(1);
}
await sendResponse(0, { protocolVersion: 1, agentCapabilities: {} });
await sendRequest(1, 'session/new', { cwd });
if (fakeMode === 'duplicate-id') await sendRequest(1, 'session/new', { cwd });
await sendResponse(1, { sessionId: 'dsh-fake-session' });
await sendRequest(2, 'session/prompt', {
  sessionId: fakeMode === 'wrong-session' ? 'unexpected-session' : 'dsh-fake-session',
  prompt: [{ type: 'text', text: prompt }],
});

if (fakeMode === 'fail-after-spawn') {
  process.stderr.write('fake ACPX failed after spawn\n');
  process.exitCode = 17;
} else if (fakeMode === 'provider-error') {
  await sendError(2, -32603, '402: billing_not_configured (synthetic test)');
  process.exitCode = 1;
} else if (fakeMode === 'invalid-result') {
  await send({ jsonrpc: '2.0', id: 2, result: {} });
} else if (fakeMode === 'unmatched-result') {
  await send({ jsonrpc: '2.0', id: 999, result: { stopReason: 'end_turn', content: [{ type: 'text', text: 'SHOULD_NOT_SUCCEED' }] } });
} else if (fakeMode === 'malformed') {
  await new Promise((resolve, reject) => process.stdout.write('not-json\n', (error) => (error ? reject(error) : resolve())));
} else if (fakeMode === 'wrong-result-session') {
  await send({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn', sessionId: 'unexpected-session' } });
} else if (fakeMode === 'timeout-tree') {
  setInterval(() => {}, 1_000);
} else {
  const output = fakeMode === 'terminal-verdict'
    ? `${'x'.repeat(5000)}\nVERDICT: DSH PASS`
    : fakeMode === 'terminal-object'
      ? { progress: 'x'.repeat(5000), nested: { final: `${'y'.repeat(5000)}\nVERDICT: DSH OBJECT PASS` } }
      : fakeMode === 'utf8'
        ? 'UTF8_OK 😀 café'
        : fakeMode === 'thought-first'
          ? 'THOUGHT_RESULT'
      : 'DSH_FAKE_OK';
  if (fakeMode === 'thought-first') {
    await send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'dsh-fake-session',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'PRIVATE_THOUGHT_SHOULD_NOT_BE_STORED' },
        },
      },
    });
  }
  const update = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'dsh-fake-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: typeof output === 'string' ? output : 'DSH_OBJECT_PROGRESS' },
      },
    },
  };
  if (fakeMode === 'utf8') await sendSplit(update);
  else await send(update);
  await sendResponse(2, {
    stopReason: 'end_turn',
    ...(fakeMode === 'terminal-object' ? { output } : {}),
  });
}
