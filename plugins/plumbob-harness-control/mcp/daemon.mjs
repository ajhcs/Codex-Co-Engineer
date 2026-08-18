#!/usr/bin/env node

import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { dispatchControl, ToolError } from './control.mjs';
import { SERVER_IDENTITY } from './preflight.mjs';
import { loadModelApiKey } from './secrets.mjs';
import {
  DAEMON_CONTROL_PROTOCOL,
  inspectStateFile,
  inspectStateSocket,
  prepareStateDirectory,
  removeStateFile,
  removeStateSocket,
  resolveStateDirectory,
  revalidateStateDirectory,
  stateDirectoryDigest,
  stateResolutionMessage,
} from './state.mjs';

const STATE_RESOLUTION = resolveStateDirectory();
const STATE_DIR = STATE_RESOLUTION.directory;
if (!STATE_DIR) throw new Error(stateResolutionMessage(STATE_RESOLUTION));
const SOCKET_FILE = path.join(STATE_DIR, 'control.sock');
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');
const STATE_HANDLE = await prepareStateDirectory(STATE_DIR);
await revalidateStateDirectory(STATE_HANDLE);
const STATE_DIGEST = stateDirectoryDigest(STATE_HANDLE);
const IDLE_SECONDS = Number.parseInt(
  process.env.CODEX_CO_ENGINEER_DAEMON_IDLE_SECONDS
    ?? process.env.PLUMBOB_HARNESS_DAEMON_IDLE_SECONDS
    ?? '900',
  10,
);
let clients = 0;
let lastActivity = Date.now();
let mutationTail = Promise.resolve();
let socketReady = false;
let boundSocketIdentity = null;

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

function pingArguments() {
  return {
    protocol: DAEMON_CONTROL_PROTOCOL,
    server_identity: SERVER_IDENTITY,
    state_directory_digest: STATE_DIGEST,
  };
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function sameServerIdentity(value) {
  return exactKeys(value, Object.keys(SERVER_IDENTITY))
    && value.name === SERVER_IDENTITY.name
    && value.version === SERVER_IDENTITY.version;
}

function validPingArguments(value) {
  return exactKeys(value, ['protocol', 'server_identity', 'state_directory_digest'])
    && value.protocol === DAEMON_CONTROL_PROTOCOL
    && sameServerIdentity(value.server_identity)
    && value.state_directory_digest === STATE_DIGEST;
}

function validPingResponse(value) {
  return exactKeys(value, ['ok', 'protocol', 'server_identity', 'state_directory_digest'])
    && value.ok === true
    && value.protocol === DAEMON_CONTROL_PROTOCOL
    && sameServerIdentity(value.server_identity)
    && value.state_directory_digest === STATE_DIGEST;
}

async function socketIsLive() {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_FILE);
    const input = readline.createInterface({ input: socket, crlfDelay: Infinity });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      input.close();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 'daemon-startup-ping', name: '__ping', args: pingArguments() })}\n`);
    });
    input.on('error', () => done(false));
    input.once('line', (line) => {
      try {
        done(validPingResponse(JSON.parse(line)?.result));
      } catch {
        done(false);
      }
    });
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

const existingSocket = await inspectStateSocket(STATE_HANDLE, path.basename(SOCKET_FILE), { required: false });
if (existingSocket) {
  if (await socketIsLive()) {
    await inspectStateSocket(
      STATE_HANDLE,
      path.basename(SOCKET_FILE),
      { expectedIdentity: existingSocket },
    );
    process.exit(0);
  }
  await revalidateStateDirectory(STATE_HANDLE);
  await removeStateSocket(
    STATE_HANDLE,
    path.basename(SOCKET_FILE),
    { expectedIdentity: existingSocket },
  );
}
await revalidateStateDirectory(STATE_HANDLE);
if (await inspectStateSocket(STATE_HANDLE, path.basename(SOCKET_FILE), { required: false })) {
  throw new Error('Co-Engineer control socket reappeared before daemon listen; refusing to replace it.');
}

const server = net.createServer((socket) => {
  if (!socketReady) {
    socket.destroy();
    return;
  }
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
          if (!validPingArguments(message.args)) {
            socket.write(`${JSON.stringify({
              id: message.id,
              error: {
                code: 'daemon_identity_mismatch',
                message: 'The daemon ping did not match this control protocol, server identity, and state directory.',
              },
            })}\n`);
            return;
          }
          socket.write(`${JSON.stringify({ id: message.id, result: { ok: true, ...pingArguments() } })}\n`);
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

// A pathname chmod after listen can be redirected by replacing the socket
// between lstat and chmod.  Create the socket at its final mode instead.
const previousUmask = process.umask(0o177);
let umaskRestored = false;
function restoreUmask() {
  if (umaskRestored) return;
  umaskRestored = true;
  process.umask(previousUmask);
}
server.once('error', restoreUmask);
server.listen(SOCKET_FILE, async () => {
  restoreUmask();
  try {
    await revalidateStateDirectory(STATE_HANDLE);
    const socketIdentity = await inspectStateSocket(
      STATE_HANDLE,
      path.basename(SOCKET_FILE),
      { mode: 0o600 },
    );
    await inspectStateSocket(
      STATE_HANDLE,
      path.basename(SOCKET_FILE),
      { expectedIdentity: socketIdentity, mode: 0o600 },
    );
    boundSocketIdentity = socketIdentity;
    socketReady = true;
    const lockIdentity = await inspectStateFile(
      STATE_HANDLE,
      path.basename(LOCK_FILE),
      { required: false },
    );
    if (lockIdentity) {
      await removeStateFile(
        STATE_HANDLE,
        path.basename(LOCK_FILE),
        { expectedIdentity: lockIdentity },
      );
    }
  } catch {
    server.close();
  }
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
  try {
    await revalidateStateDirectory(STATE_HANDLE);
  } catch {
    return;
  }
  if (boundSocketIdentity) {
    await removeStateSocket(
      STATE_HANDLE,
      path.basename(SOCKET_FILE),
      { required: false, expectedIdentity: boundSocketIdentity },
    ).catch(() => {});
  }
  const lockIdentity = await inspectStateFile(
    STATE_HANDLE,
    path.basename(LOCK_FILE),
    { required: false },
  ).catch(() => null);
  if (lockIdentity) {
    await removeStateFile(
      STATE_HANDLE,
      path.basename(LOCK_FILE),
      { expectedIdentity: lockIdentity },
    ).catch(() => {});
  }
}

server.on('close', () => {
  void cleanup().finally(() => process.exit(0));
});
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
