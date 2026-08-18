#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dispatchControl, ToolError } from './control.mjs';
import { SERVER_IDENTITY } from './preflight.mjs';
import { loadModelApiKey, modelApiKeyBindingDigest } from './secrets.mjs';
import {
  DAEMON_CONTROL_PROTOCOL,
  createExclusiveStateFile,
  inspectStateFile,
  inspectStateSocket,
  openStateFileRead,
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
const DAEMON_PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const DAEMON_ARGV = Object.freeze([
  process.execPath,
  '--no-warnings',
  path.resolve(fileURLToPath(import.meta.url)),
]);
const STATE_HANDLE = await prepareStateDirectory(STATE_DIR);
await revalidateStateDirectory(STATE_HANDLE);
const STATE_DIGEST = stateDirectoryDigest(STATE_HANDLE);
const CREDENTIAL_BINDING_DIGEST = await modelApiKeyBindingDigest();
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
let daemonPidIdentity = null;
let daemonProcessIdentity = null;
let draining = false;

function serializeMutation(operation) {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.catch(() => {});
  return result;
}

function dispatch(name, args) {
  const operation = async () => {
    if (draining && (name === 'runtime' || name === 'run' || name === 'cancel')) {
      throw new ToolError('daemon_draining', 'The Co-Engineer daemon is draining and will not accept mutations.');
    }
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
    credential_binding_digest: CREDENTIAL_BINDING_DIGEST,
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
  return exactKeys(value, [
    'protocol',
    'server_identity',
    'state_directory_digest',
    'credential_binding_digest',
  ])
    && value.protocol === DAEMON_CONTROL_PROTOCOL
    && sameServerIdentity(value.server_identity)
    && value.state_directory_digest === STATE_DIGEST
    && value.credential_binding_digest === CREDENTIAL_BINDING_DIGEST;
}

function validShutdownArguments(value) {
  return exactKeys(value, [
    'protocol',
    'server_identity',
    'state_directory_digest',
    'process_identity',
    'socket_identity',
  ])
    && value.protocol === DAEMON_CONTROL_PROTOCOL
    && sameServerIdentity(value.server_identity)
    && value.state_directory_digest === STATE_DIGEST
    && exactKeys(value.process_identity, ['pid', 'start_time'])
    && value.process_identity.pid === daemonProcessIdentity?.pid
    && value.process_identity.start_time === daemonProcessIdentity?.start_time
    && exactKeys(value.socket_identity, ['dev', 'ino'])
    && value.socket_identity.dev === boundSocketIdentity?.dev
    && value.socket_identity.ino === boundSocketIdentity?.ino;
}

async function beginVerifiedShutdown(args) {
  return serializeMutation(async () => {
    if (!validShutdownArguments(args)) {
      throw new ToolError(
        'daemon_identity_mismatch',
        'The daemon shutdown request did not match this process and socket identity.',
      );
    }
    if (draining) return { ok: true };
    const status = await dispatchControl('status', { recent_limit: 0 });
    if (status?.jobs?.active !== 0) {
      throw new ToolError('daemon_active_jobs', 'The Co-Engineer daemon has active jobs and will not shut down.');
    }
    draining = true;
    return { ok: true };
  });
}

async function beginIdleShutdown() {
  return serializeMutation(async () => {
    if (draining) return true;
    if (clients > 0 || Date.now() - lastActivity < IDLE_SECONDS * 1000) return false;
    const status = await dispatchControl('status', { recent_limit: 0 });
    if (status?.jobs?.active !== 0) return false;
    draining = true;
    return true;
  });
}

function validPingResponse(value) {
  return exactKeys(value, [
    'ok',
    'protocol',
    'server_identity',
    'state_directory_digest',
    'credential_binding_digest',
  ])
    && value.ok === true
    && value.protocol === DAEMON_CONTROL_PROTOCOL
    && sameServerIdentity(value.server_identity)
    && value.state_directory_digest === STATE_DIGEST
    && value.credential_binding_digest === CREDENTIAL_BINDING_DIGEST;
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
    input.on('error', () => done('unresponsive'));
    input.once('line', (line) => {
      try {
        const response = JSON.parse(line);
        if (validPingResponse(response?.result)) done('matching');
        else if (response?.error?.code === 'daemon_identity_mismatch') done('mismatch');
        else done('unresponsive');
      } catch {
        done('unresponsive');
      }
    });
    socket.once('error', (error) => done(error?.code === 'ECONNREFUSED' ? 'dead' : 'unresponsive'));
    socket.once('timeout', () => done('unresponsive'));
  });
}

function processStartTime(statText) {
  const closingParenthesis = statText.lastIndexOf(')');
  if (closingParenthesis < 0) return null;
  return statText.slice(closingParenthesis + 2).trim().split(/\s+/u)[19] ?? null;
}

async function currentProcessStartTime() {
  const statText = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const startTime = processStartTime(statText);
  if (!startTime) throw new Error('Unable to verify the daemon process start time.');
  return startTime;
}

async function inspectDaemonProcess(pid) {
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) return null;
  try {
    const processDirectory = await lstat(`/proc/${pid}`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid === null || processDirectory.uid !== uid) return null;
    const [commandLine, statText] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const argv = commandLine.split('\0').filter(Boolean);
    const fields = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/u);
    return {
      pid,
      uid: processDirectory.uid,
      argv,
      start_time: fields[19] ?? null,
      state: fields[0] ?? null,
    };
  } catch {
    return null;
  }
}

function sameDaemonProcess(actual, expected) {
  return actual?.pid === expected?.pid
    && actual.uid === expected.uid
    && actual.start_time === expected.start_time
    && actual.state !== 'Z'
    && JSON.stringify(actual.argv) === JSON.stringify(DAEMON_ARGV);
}

async function claimDaemonPidFile() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) throw new Error('Cannot verify daemon process ownership on this runtime.');
  const existing = await inspectStateFile(
    STATE_HANDLE,
    path.basename(DAEMON_PID_FILE),
    { required: false },
  );
  if (existing) {
    let record = null;
    try {
      const opened = await openStateFileRead(
        STATE_HANDLE,
        path.basename(DAEMON_PID_FILE),
        { expectedIdentity: existing },
      );
      try {
        record = JSON.parse(await opened.file.readFile('utf8'));
      } finally {
        await opened.file.close();
      }
    } catch {
      throw new Error('An existing Co-Engineer daemon ownership record could not be verified.');
    }
    const validCurrentRecord = exactKeys(record, ['pid', 'uid', 'argv', 'start_time'])
      && Number.isInteger(record.pid)
      && record.pid >= 2
      && record.uid === uid
      && Array.isArray(record.argv)
      && JSON.stringify(record.argv) === JSON.stringify(DAEMON_ARGV)
      && typeof record.start_time === 'string'
      && record.start_time.length > 0;
    const validLegacyRecord = exactKeys(record, ['pid', 'start_time'])
      && Number.isInteger(record.pid)
      && record.pid >= 2
      && typeof record.start_time === 'string'
      && record.start_time.length > 0;
    if (validCurrentRecord || validLegacyRecord) {
      const actual = await inspectDaemonProcess(record.pid);
      const expected = validCurrentRecord
        ? record
        : { ...record, uid, argv: DAEMON_ARGV };
      if (sameDaemonProcess(actual, expected)) {
        throw new Error('An ownership-verified Co-Engineer daemon is already running.');
      }
    }
    await removeStateFile(
      STATE_HANDLE,
      path.basename(DAEMON_PID_FILE),
      { expectedIdentity: existing },
    );
  }

  const pidFile = await createExclusiveStateFile(STATE_HANDLE, path.basename(DAEMON_PID_FILE));
  if (!pidFile.created) throw new Error('The Co-Engineer daemon ownership record changed during startup.');
  try {
    daemonProcessIdentity = {
      pid: process.pid,
      start_time: await currentProcessStartTime(),
    };
    await pidFile.file.writeFile(JSON.stringify({
      ...daemonProcessIdentity,
      uid,
      argv: DAEMON_ARGV,
    }) + '\n');
  } finally {
    await pidFile.file.close();
  }
  daemonPidIdentity = pidFile.identity;
}

const existingSocket = await inspectStateSocket(STATE_HANDLE, path.basename(SOCKET_FILE), { required: false });
if (existingSocket) {
  const socketStatus = await socketIsLive();
  if (socketStatus === 'matching') {
    await inspectStateSocket(
      STATE_HANDLE,
      path.basename(SOCKET_FILE),
      { expectedIdentity: existingSocket },
    );
    process.exit(0);
  }
  if (socketStatus !== 'dead') {
    throw new Error('An existing Co-Engineer daemon socket is live but ownership-mismatched; refusing replacement.');
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
await claimDaemonPidFile();

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
          const result = await beginVerifiedShutdown(message.args);
          socket.write(`${JSON.stringify({ id: message.id, result })}\n`);
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
  void beginIdleShutdown()
    .then((ready) => {
      if (ready) server.close();
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
  if (daemonPidIdentity) {
    await removeStateFile(
      STATE_HANDLE,
      path.basename(DAEMON_PID_FILE),
      { required: false, expectedIdentity: daemonPidIdentity },
    ).catch(() => {});
  }
}

server.on('close', () => {
  void cleanup().finally(() => process.exit(0));
});
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
