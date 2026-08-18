import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  CursorLocalService,
  FOUNDATION_TOOLS,
  LocalRunLedger,
  SERVER_IDENTITY,
  TOOLS,
  buildArguments,
  createNdjsonCollector,
  projectAuth,
  resolveBinary,
  runStdio,
  validateToolInput,
} from '../mcp/local.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-local-control-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const state = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(config, { mode: 0o700 }), mkdir(state, { mode: 0o700 }), mkdir(workspace, { mode: 0o700 })]);
  await writeFile(path.join(config, 'cli-config.json'), JSON.stringify({
    version: 1,
    approvalMode: 'allowlist',
    permissions: {
      allow: ['Read(**)', 'Shell(git:status)'],
      deny: ['Write(**)', 'Mcp(*:*)', 'Shell(*)'],
    },
  }), { mode: 0o600 });
  const binary = path.join(root, 'cursor-agent');
  await writeFile(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'cursor-agent test-1.2.3'
  exit 0
fi
if [ "$1" = "status" ]; then
  printf '%s\\n' '{"authenticated":true,"email":"must-not-cross"}'
  exit 0
fi
printf '%s\\n' '{"type":"system","subtype":"init","cwd":"'"$HOME"'/.cursor/worktrees/test"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","result":"done","session_id":"session-test"}'
exit 0
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const env = {
    HOME: root,
    CURSOR_LOCAL_CLI_BIN: binary,
    CURSOR_LOCAL_CLI_HOME: home,
    CURSOR_LOCAL_CLI_CONFIG_DIR: config,
    CURSOR_LOCAL_CLI_WORKSPACE_ROOTS: root,
    CURSOR_LOCAL_CONTROL_STATE_DIR: state,
  };
  env.CURSOR_LOCAL_CLI_SHA256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  return { root, home, config, state, workspace, binary, env };
}

test('local MCP identity exposes status while retaining a deferred foundation', () => {
  assert.deepEqual(SERVER_IDENTITY, { name: 'cursor-local-control', version: '0.1.0' });
  assert.deepEqual(FOUNDATION_TOOLS.map((tool) => tool.name), ['status', 'run', 'runs']);
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['status']);
  assert.throws(() => validateToolInput('runs', { action: 'get', localRunId: 'run-000000000' }), /invalid format/);
  assert.throws(() => validateToolInput('run', { workspace: 'relative', prompt: 'x', mode: 'read_only' }), /absolute/);
  assert.match(resolveBinary({ HOME: '/tmp', CURSOR_LOCAL_CLI_BIN: '/tmp/agent' }).reason, /generic agent/);
});

test('local argument policy keeps read-only and implement invocation distinct', () => {
  const readOnly = buildArguments({ workspace: '/tmp/workspace', prompt: 'inspect', mode: 'read_only', worktreeName: 'test-ro' });
  const implement = buildArguments({ workspace: '/tmp/workspace', prompt: 'change', mode: 'implement', worktreeName: 'test-write' });
  assert.ok(readOnly.includes('--mode') && readOnly.includes('ask'));
  assert.equal(readOnly.includes('--force'), false);
  assert.ok(implement.includes('--force'));
  assert.equal(readOnly.includes('--worktree'), false);
  assert.ok(implement.includes('--worktree'));
  assert.ok(readOnly.includes('--sandbox') && readOnly.includes('enabled'));
});

test('NDJSON collector bounds events and redacts local credentials', () => {
  const seen = [];
  const collector = createNdjsonCollector({ maxEvents: 1, maxBytes: 2000, secrets: ['local-secret'], onEvent: (event) => seen.push(event) });
  collector.push('{"type":"assistant","message":{"content":[{"type":"text","text":"local-secret"}]}}\n');
  collector.push('{"type":"result","result":"second"}\n');
  const result = collector.finish();
  assert.equal(result.events.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes('local-secret'), false);
  assert.equal(seen.length, 2);
});

test('auth projection discards account identity and returns only compact state', () => {
  const projected = projectAuth('{"authenticated":true,"email":"ada@example.test","userId":"secret"}', { CURSOR_LOCAL_CLI_API_KEY: 'local-secret' });
  assert.deepEqual(projected, { state: 'authenticated', method: 'api_key_env', apiKeyConfigured: true, probeError: undefined });
  assert.equal(JSON.stringify(projected).includes('ada@example.test'), false);
});

test('status reports local state and fail-closed sandbox without spawning a provider child', async (context) => {
  const fixtureValue = await fixture(context);
  const ledger = new LocalRunLedger({ stateDir: fixtureValue.state, source: 'environment' });
  const service = new CursorLocalService({ env: fixtureValue.env, ledger });
  const localStatus = await service.call('status', { action: 'local' });
  assert.equal(localStatus.ok, true);
  assert.equal(localStatus.status.surface, 'local-cli');
  assert.equal(localStatus.status.binary.available, true);
  assert.match(localStatus.status.binary.version, /test-1\.2\.3/);
  assert.equal(localStatus.status.binary.digestConfigured, true);
  assert.equal(localStatus.status.binary.drift, false);
  assert.equal(localStatus.status.sandbox.ready, false);
  assert.equal(localStatus.status.safety.cloudLedgerShared, false);

  const authStatus = await service.call('status', { action: 'auth' });
  assert.equal(authStatus.status.auth.state, 'authenticated');
  assert.equal(JSON.stringify(authStatus).includes('must-not-cross'), false);
  await assert.rejects(service.call('status', { action: 'local', workspace: '/tmp' }), /allowlist/);

  let spawnCalls = 0;
  const guardedService = new CursorLocalService({
    env: fixtureValue.env,
    ledger,
    spawnImpl: (...args) => { spawnCalls += 1; throw new Error(`provider spawn must not happen: ${args[0]}`); },
  });
  await assert.rejects(guardedService.verifyRunEnvironment({
    workspace: fixtureValue.workspace,
    prompt: 'inspect fixture',
    mode: 'read_only',
    requestId: 'local-request-0001',
    waitMs: 5_000,
  }), /sandbox/);
  assert.equal(spawnCalls, 0);
  await assert.rejects(guardedService.call('run', {
    workspace: fixtureValue.workspace,
    prompt: 'inspect fixture',
    mode: 'read_only',
  }), /foundation_not_exposed|deferred/);
  assert.equal(spawnCalls, 0);
  await assert.rejects(readFile(path.join(fixtureValue.state, 'runs.json'), 'utf8'), { code: 'ENOENT' });
});

test('run fails closed when read-only permission deny is missing', async (context) => {
  const fixtureValue = await fixture(context);
  await writeFile(path.join(fixtureValue.config, 'cli-config.json'), JSON.stringify({ version: 1, permissions: { allow: [], deny: ['Mcp(*:*)'] } }), { mode: 0o600 });
  const service = new CursorLocalService({ env: fixtureValue.env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  await assert.rejects(service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'read_only' }), /Write\(\*\*\)/);
});

test('local MCP process exposes status only and rejects deferred foundation calls', async () => {
  const output = [];
  const outputStream = new Writable({ write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); } });
  const service = new CursorLocalService({ env: { HOME: '/tmp', CURSOR_LOCAL_CONTROL_STATE_DIR: `/tmp/cursor-local-catalog-${process.pid}` } });
  await runStdio({
    input: Readable.from([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run', arguments: {} } }),
      '',
    ].join('\n')),
    output: outputStream,
    service,
  });
  const responses = output.join('').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'cursor-local-control');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['status']);
  assert.equal(responses[2].result.isError, true);
  assert.equal(responses[2].result.structuredContent.error.code, 'foundation_not_exposed');
});

test('local MCP manifest forwards only administrator pins and omits activation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.mcp.json', import.meta.url), 'utf8'));
  const local = manifest.mcpServers['cursor-local-control'];
  assert.ok(local);
  for (const name of ['CURSOR_LOCAL_CLI_SHA256', 'CURSOR_LOCAL_CLI_SANDBOX_BIN', 'CURSOR_LOCAL_CLI_SANDBOX_SHA256']) {
    assert.ok(local.env_vars.includes(name));
  }
  assert.equal(local.env_vars.includes('CURSOR_LOCAL_CLI_ENABLE_RUNS'), false);
});
