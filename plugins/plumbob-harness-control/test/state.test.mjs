import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SERVER_IDENTITY } from '../mcp/preflight.mjs';
import {
  DAEMON_CONTROL_PROTOCOL,
  inspectStateSocket,
  openAppendStateFile,
  prepareStateFile,
  prepareStateDirectory,
  resolveStateDirectory,
  revalidateStateDirectory,
  stateDirectoryDigest,
  stateResolutionMessage,
} from '../mcp/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function socketRpc(socketFile, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketFile);
    let buffer = '';
    const done = (error, value) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(2000);
    socket.once('error', (error) => done(error));
    socket.once('timeout', () => done(new Error('Timed out waiting for daemon RPC response.')));
    socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        done(null, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        done(error);
      }
    });
  });
}

test('Co-Engineer state resolution prefers explicit, legacy, shared, then verified XDG/HOME roots', () => {
  const root = '/var/tmp/codex-co-engineer-state-test';
  assert.deepEqual(resolveStateDirectory({
    CODEX_CO_ENGINEER_STATE_DIR: path.join(root, 'explicit'),
    PLUMBOB_HARNESS_STATE_DIR: path.join(root, 'legacy'),
    CODEX_TASK_STATE_ROOT: path.join(root, 'shared'),
    XDG_STATE_HOME: path.join(root, 'xdg'),
    HOME: root,
  }), {
    directory: path.join(root, 'explicit'),
    source: 'environment',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({
    PLUMBOB_HARNESS_STATE_DIR: path.join(root, 'legacy'),
    CODEX_TASK_STATE_ROOT: path.join(root, 'shared'),
    HOME: root,
  }), {
    directory: path.join(root, 'legacy'),
    source: 'legacy_environment',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({
    CODEX_TASK_STATE_ROOT: path.join(root, 'shared'),
    HOME: root,
  }), {
    directory: path.join(root, 'shared', 'codex-co-engineer'),
    source: 'task_state_root',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({ XDG_STATE_HOME: path.join(root, 'xdg'), HOME: root }), {
    directory: path.join(root, 'xdg', 'codex-co-engineer'),
    source: 'xdg_state_home',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({ HOME: root }), {
    directory: path.join(root, '.local', 'state', 'codex-co-engineer'),
    source: 'home',
    reason: null,
  });
});

test('malformed explicit, shared, and XDG roots fail closed instead of falling through', () => {
  const home = '/var/tmp/codex-co-engineer-state-test';
  const emptyShared = resolveStateDirectory({ CODEX_TASK_STATE_ROOT: '', HOME: home });
  assert.deepEqual(emptyShared, {
    directory: null,
    source: 'task_state_root',
    reason: 'CODEX_TASK_STATE_ROOT is empty; set it to a writable absolute path or remove the variable to use XDG/HOME fallback.',
  });
  assert.match(stateResolutionMessage(emptyShared), /CODEX_TASK_STATE_ROOT is empty/);

  const relativeShared = resolveStateDirectory({ CODEX_TASK_STATE_ROOT: 'relative-state', HOME: home });
  assert.deepEqual(relativeShared, {
    directory: null,
    source: 'task_state_root',
    reason: 'CODEX_TASK_STATE_ROOT must be an absolute path; refusing a relative shared state root.',
  });

  const emptyExplicit = resolveStateDirectory({
    CODEX_CO_ENGINEER_STATE_DIR: '',
    CODEX_TASK_STATE_ROOT: path.join(home, 'shared'),
    HOME: home,
  });
  assert.equal(emptyExplicit.directory, null);
  assert.equal(emptyExplicit.source, 'environment');
  assert.match(emptyExplicit.reason, /CODEX_CO_ENGINEER_STATE_DIR is empty/);

  const relativeXdg = resolveStateDirectory({ XDG_STATE_HOME: 'relative-xdg', HOME: home });
  assert.deepEqual(relativeXdg, {
    directory: null,
    source: 'xdg_state_home',
    reason: 'XDG_STATE_HOME must be an absolute path; refusing a relative XDG state root.',
  });

  const emptyXdg = resolveStateDirectory({ XDG_STATE_HOME: '', HOME: home });
  assert.deepEqual(emptyXdg, {
    directory: null,
    source: 'xdg_state_home',
    reason: 'XDG_STATE_HOME is empty; set it to a writable absolute path or remove the variable to use HOME fallback.',
  });

  const unconfigured = resolveStateDirectory({});
  assert.equal(unconfigured.directory, null);
  assert.equal(unconfigured.source, 'unconfigured');
  assert.match(unconfigured.reason, /CODEX_CO_ENGINEER_STATE_DIR/);
});

test('state preparation rejects symlinked roots, unsafe modes, and identity swaps', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-state-safety-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const external = await mkdtemp(path.join(os.tmpdir(), 'codex-state-external-'));
  context.after(() => rm(external, { recursive: true, force: true }));
  const linked = path.join(root, 'linked');
  await symlink(external, linked);
  await assert.rejects(
    prepareStateDirectory(path.join(linked, 'codex-co-engineer')),
    (error) => error?.code === 'state_symlink' && /symbolic link/.test(error.message),
  );

  const unsafe = path.join(root, 'unsafe');
  await mkdir(unsafe, { mode: 0o700 });
  await chmod(unsafe, 0o777);
  await assert.rejects(
    prepareStateDirectory(unsafe),
    (error) => error?.code === 'state_permissions' && /0700/.test(error.message),
  );
  assert.equal((await lstat(unsafe)).mode & 0o777, 0o777, 'preparation must not chmod an untrusted directory');

  const groupWritableAncestor = path.join(root, 'group-writable-ancestor');
  await mkdir(groupWritableAncestor, { mode: 0o700 });
  await chmod(groupWritableAncestor, 0o770);
  await assert.rejects(
    prepareStateDirectory(path.join(groupWritableAncestor, 'state')),
    (error) => error?.code === 'state_ancestor_unsafe' && /group\/world-writable/.test(error.message),
  );
  assert.equal(
    (await lstat(groupWritableAncestor)).mode & 0o777,
    0o770,
    'preparation must reject rather than chmod a current-user-owned writable ancestor',
  );

  const prepared = await prepareStateDirectory(path.join(root, 'prepared'));
  const replacement = path.join(root, 'replacement');
  await mkdir(replacement, { mode: 0o700 });
  await rm(prepared.directory, { recursive: true, force: true });
  await symlink(replacement, prepared.directory);
  await assert.rejects(
    revalidateStateDirectory(prepared),
    (error) => error?.code === 'state_symlink' || error?.code === 'state_identity_changed',
  );
});

test('secure state children reject file and socket redirection', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-state-children-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const state = await prepareStateDirectory(path.join(root, 'state'));
  const external = path.join(root, 'external.txt');
  await writeFile(external, 'outside-sentinel', { mode: 0o600 });

  const databaseFile = path.join(state.directory, 'control.sqlite3');
  await symlink(external, databaseFile);
  await assert.rejects(
    prepareStateFile(state, 'control.sqlite3'),
    (error) => error?.code === 'state_symlink',
  );
  assert.equal(await readFile(external, 'utf8'), 'outside-sentinel');

  await rm(databaseFile);
  await writeFile(databaseFile, '', { mode: 0o600 });
  await chmod(databaseFile, 0o644);
  await assert.rejects(
    prepareStateFile(state, 'control.sqlite3'),
    (error) => error?.code === 'state_child_permissions',
  );

  await rm(databaseFile);
  await writeFile(databaseFile, '', { mode: 0o600 });
  const databaseHardLink = path.join(root, 'database-hard-link');
  await link(databaseFile, databaseHardLink);
  await assert.rejects(
    prepareStateFile(state, 'control.sqlite3'),
    (error) => error?.code === 'state_child_links',
  );

  await rm(databaseFile);
  await symlink(external, path.join(state.directory, 'daemon.log'));
  await assert.rejects(
    openAppendStateFile(state, 'daemon.log'),
    (error) => error?.code === 'state_symlink',
  );
  assert.equal(await readFile(external, 'utf8'), 'outside-sentinel');

  const socketFile = path.join(state.directory, 'control.sock');
  await writeFile(socketFile, '', { mode: 0o600 });
  await assert.rejects(
    inspectStateSocket(state, 'control.sock'),
    (error) => error?.code === 'state_child_type',
  );
  await rm(socketFile);
  await symlink(external, socketFile);
  await assert.rejects(
    inspectStateSocket(state, 'control.sock'),
    (error) => error?.code === 'state_symlink',
  );
});

test('server and daemon use the same XDG_STATE_HOME path when no explicit root is configured', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-state-xdg-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const xdg = path.join(root, 'xdg');
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const expected = path.join(xdg, 'codex-co-engineer');
  const socketFile = path.join(expected, 'control.sock');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
    'CODEX_CO_ENGINEER_STATE_DIR',
    'PLUMBOB_HARNESS_STATE_DIR',
    'CODEX_TASK_STATE_ROOT',
    'XDG_STATE_HOME',
  ].includes(name)));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'status', arguments: { recent_limit: 0 } },
    },
  ];
  const result = spawnSync(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs'), '--stdio'], {
    cwd: ROOT,
    env: {
      ...inherited,
      HOME: home,
      XDG_STATE_HOME: xdg,
      MODEL_API_KEY: '',
      CODEX_CO_ENGINEER_DAEMON_IDLE_SECONDS: '60',
      CODEX_CO_ENGINEER_MODEL_API_KEY_FILE: path.join(root, 'missing-model-key'),
    },
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(responses[1]?.result?.content, `Unexpected server response: ${result.stdout}\n${result.stderr}`);
  assert.equal(responses[1].result.content[0].type, 'text');
  const statusBody = JSON.parse(responses[1].result.content[0].text);
  const daemonLog = await readFile(path.join(expected, 'daemon.log'), 'utf8').catch(() => '');
  assert.equal(statusBody.control_plane?.health, 'healthy', `Unexpected status response: ${JSON.stringify(statusBody)}\nDaemon log: ${daemonLog}`);
  assert.equal((await lstat(expected)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(expected, 'jobs'))).mode & 0o777, 0o700);
  const databaseMetadata = await lstat(path.join(expected, 'control.sqlite3'));
  assert.equal(databaseMetadata.isFile(), true);
  assert.equal(databaseMetadata.nlink, 1);
  assert.equal(databaseMetadata.mode & 0o777, 0o600);
  for (const child of ['control.sqlite3-wal', 'control.sqlite3-shm']) {
    const metadata = await lstat(path.join(expected, child));
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    assert.equal(metadata.mode & 0o777, 0o600);
  }
  const logMetadata = await lstat(path.join(expected, 'daemon.log'));
  assert.equal(logMetadata.isFile(), true);
  assert.equal(logMetadata.nlink, 1);
  assert.equal(logMetadata.mode & 0o777, 0o600);
  const socketMetadata = await lstat(socketFile);
  assert.equal(socketMetadata.isSocket(), true);
  assert.equal(socketMetadata.nlink, 1);
  assert.equal(socketMetadata.mode & 0o777, 0o600);
  if (typeof process.getuid === 'function') {
    assert.equal(databaseMetadata.uid, process.getuid());
    assert.equal(logMetadata.uid, process.getuid());
    assert.equal(socketMetadata.uid, process.getuid());
  }
  await assert.rejects(lstat(path.join(home, '.local', 'state', 'codex-co-engineer')));

  const genericPing = await socketRpc(socketFile, {
    id: 'state-test-generic-ping',
    name: '__ping',
    args: {},
  });
  assert.equal(genericPing.error?.code, 'daemon_identity_mismatch');

  const prepared = await prepareStateDirectory(expected);
  const exactPing = await socketRpc(socketFile, {
    id: 'state-test-exact-ping',
    name: '__ping',
    args: {
      protocol: DAEMON_CONTROL_PROTOCOL,
      server_identity: SERVER_IDENTITY,
      state_directory_digest: stateDirectoryDigest(prepared),
    },
  });
  assert.deepEqual(exactPing.result, {
    ok: true,
    protocol: DAEMON_CONTROL_PROTOCOL,
    server_identity: SERVER_IDENTITY,
    state_directory_digest: stateDirectoryDigest(prepared),
  });

  await socketRpc(socketFile, {
    id: 'state-test-shutdown',
    name: '__shutdown',
    args: {},
  });
});

test('server refuses a symlinked SQLite ledger without touching its target', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-state-db-symlink-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const external = path.join(root, 'external-ledger');
  await writeFile(external, 'external-ledger-sentinel', { mode: 0o600 });
  await symlink(external, path.join(state, 'control.sqlite3'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
    'CODEX_CO_ENGINEER_STATE_DIR',
    'PLUMBOB_HARNESS_STATE_DIR',
    'CODEX_TASK_STATE_ROOT',
    'XDG_STATE_HOME',
  ].includes(name)));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'status', arguments: { recent_limit: 0 } },
    },
  ];
  const result = spawnSync(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs'), '--stdio'], {
    cwd: ROOT,
    env: {
      ...inherited,
      CODEX_CO_ENGINEER_STATE_DIR: state,
      MODEL_API_KEY: '',
      CODEX_CO_ENGINEER_DAEMON_IDLE_SECONDS: '60',
      CODEX_CO_ENGINEER_MODEL_API_KEY_FILE: path.join(root, 'missing-model-key'),
    },
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(responses[1]?.result?.isError, true, `Unexpected server response: ${result.stdout}\n${result.stderr}`);
  const failure = JSON.parse(responses[1].result.content[0].text);
  assert.equal(failure.code, 'state_symlink');
  assert.equal(await readFile(external, 'utf8'), 'external-ledger-sentinel');
  assert.equal((await lstat(path.join(state, 'control.sqlite3'))).isSymbolicLink(), true);

  await socketRpc(path.join(state, 'control.sock'), {
    id: 'state-symlink-test-shutdown',
    name: '__shutdown',
    args: {},
  });
});
