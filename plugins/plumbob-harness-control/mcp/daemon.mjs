#!/usr/bin/env node

import { chmod, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { dispatchControl, ToolError } from './control.mjs';
import { loadModelApiKey } from './secrets.mjs';

const STATE_DIR = path.resolve(
  process.env.CODEX_CO_ENGINEER_STATE_DIR
    ?? process.env.PLUMBOB_HARNESS_STATE_DIR
    ?? path.join(
      process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? '', '.local', 'state'),
      'codex-co-engineer',
    ),
);
const SOCKET_FILE = path.join(STATE_DIR, 'control.sock');
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');
const IDLE_SECONDS = Number.parseInt(
  process.env.CODEX_CO_ENGINEER_DAEMON_IDLE_SECONDS
    ?? process.env.PLUMBOB_HARNESS_DAEMON_IDLE_SECONDS
    ?? '900',
  10,
);
let clients = 0;
let lastActivity = Date.now();
let mutationTail = Promise.resolve();

function serializeMutation(operation) {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.catch(() => {});
  return result;
}

function dispatch(name, args) {
  const operation = async () => {
    await loadModelApiKey();
    return dispatchControl(name, args);
  };
  if (name === 'runtime' || name === 'run' || name === 'cancel') return serializeMutation(operation);
  return operation();
}

async function socketIsLive() {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_FILE);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
if (await socketIsLive()) process.exit(0);
await unlink(SOCKET_FILE).catch(() => {});

const server = net.createServer((socket) => {
  clients += 1;
  lastActivity = Date.now();
  const input = readline.createInterface({ input: socket, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (message.name === '__ping') {
          socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
          return;
        }
        if (message.name === '__shutdown') {
          socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
          setImmediate(() => server.close());
          return;
        }
        const result = await dispatch(message.name, message.args ?? {});
        socket.write(`${JSON.stringify({ id: message.id, result })}\n`);
      } catch (error) {
        socket.write(`${JSON.stringify({
          id: message?.id ?? null,
          error: {
            code: error instanceof ToolError ? error.code : 'internal_error',
            message: error instanceof Error ? error.message : String(error),
          },
        })}\n`);
      }
    })();
  });
  socket.on('close', () => {
    clients = Math.max(0, clients - 1);
    lastActivity = Date.now();
  });
});

server.listen(SOCKET_FILE, async () => {
  await chmod(SOCKET_FILE, 0o600);
  await unlink(LOCK_FILE).catch(() => {});
});

const idleTimer = setInterval(() => {
  if (clients > 0 || Date.now() - lastActivity < IDLE_SECONDS * 1000) return;
  void dispatchControl('status', { recent_limit: 0 })
    .then((status) => {
      if (status.jobs.active === 0) server.close();
    })
    .catch(() => {});
}, Math.min(60000, Math.max(1000, IDLE_SECONDS * 500)));

async function cleanup() {
  clearInterval(idleTimer);
  await unlink(SOCKET_FILE).catch(() => {});
  await unlink(LOCK_FILE).catch(() => {});
}

server.on('close', () => {
  void cleanup().finally(() => process.exit(0));
});
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
