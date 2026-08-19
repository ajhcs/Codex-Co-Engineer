import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  CursorLocalService,
  FOUNDATION_TOOLS,
  HOST_TRUSTED_RUNS_ENV,
  LocalRunLedger,
  MAX_LOCAL_LEDGER_RECORDS,
  SERVER_IDENTITY,
  TOOLS,
  buildArguments,
  createNdjsonCollector,
  projectAuth,
  resolveBinary,
  runStdio,
  terminateProcessGroup,
  toolsForEnvironment,
  validateToolInput,
} from '../mcp/local.mjs';

const LOCAL_MODULE_URL = new URL('../mcp/local.mjs', import.meta.url).href;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function childResult(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stdout: '', stderr: '' });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForFile(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function ledgerChild(state, script, extra = {}) {
  return spawn(process.execPath, ['--input-type=module', '-e', script, state], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, LOCAL_MODULE_URL, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

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

test('local MCP identity keeps host-trusted execution opt-in', () => {
  assert.deepEqual(SERVER_IDENTITY, { name: 'cursor-local-control', version: '0.2.0' });
  assert.deepEqual(FOUNDATION_TOOLS.map((tool) => tool.name), ['status', 'run', 'runs']);
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['status']);
  assert.deepEqual(toolsForEnvironment({}), TOOLS);
  assert.deepEqual(toolsForEnvironment({ [HOST_TRUSTED_RUNS_ENV]: '1' }), FOUNDATION_TOOLS);
  assert.throws(() => validateToolInput('runs', { action: 'get', localRunId: 'run-000000000' }), /invalid format/);
  assert.throws(() => validateToolInput('run', { workspace: 'relative', prompt: 'x', mode: 'read_only' }), /absolute/);
  assert.throws(() => validateToolInput('run', { workspace: '/tmp', prompt: 'x', mode: 'read_only' }), /execution_profile/);
  assert.throws(() => validateToolInput('run', { workspace: '/tmp', prompt: 'x', mode: 'read_only', execution_profile: 'host_trusted' }), /requestId/);
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
  assert.ok(readOnly.includes('--sandbox') && readOnly.includes('disabled'));
  assert.equal(readOnly.at(-2), '--');
  assert.equal(readOnly.at(-1), 'inspect');
  assert.equal(buildArguments({ workspace: '/tmp/workspace', prompt: '--endpoint=https://attacker.invalid --plugin-dir=/tmp', mode: 'read_only', worktreeName: 'test-ro' }).at(-1), '--endpoint=https://attacker.invalid --plugin-dir=/tmp');
});

test('NDJSON collector bounds events and redacts local credentials', () => {
  const seen = [];
  const collector = createNdjsonCollector({ maxEvents: 1, maxBytes: 2000, secrets: ['local-secret'], onEvent: (event) => seen.push(event) });
  collector.push('{"type":"assistant","message":{"content":[{"type":"text","text":"local-secret"}]}}\n');
  collector.push('{"type":"result","result":"second"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"overflow"}]}}\n'.repeat(1000));
  collector.push('{"type":"result","result":"after-cap"}\n');
  const result = collector.finish();
  assert.equal(result.events.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes('local-secret'), false);
  assert.equal(seen.length, 1);
});

test('NDJSON collector preserves split UTF-8 and fails closed on invalid bytes', () => {
  const source = Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"héllo 😀"}]}}\n', 'utf8');
  const collector = createNdjsonCollector();
  for (const byte of source) collector.push(Buffer.from([byte]));
  const result = collector.finish();
  assert.equal(result.events[0].text, 'héllo 😀');
  assert.equal(result.invalidUtf8, false);

  const invalid = createNdjsonCollector();
  invalid.push(Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"', 'utf8'));
  invalid.push(Buffer.from([0xc3]));
  invalid.push(Buffer.from('"}]}}\n', 'utf8'));
  const invalidResult = invalid.finish();
  assert.equal(invalidResult.events.length, 0);
  assert.equal(invalidResult.invalidUtf8, true);
  assert.equal(invalidResult.truncated, true);
});

test('NDJSON collector enforces exact byte boundaries and unterminated-line bounds', () => {
  const exact = createNdjsonCollector({ maxBytes: 2 });
  exact.push(Buffer.from('{}\n'));
  assert.deepEqual(exact.finish(), { events: [{ type: 'unknown' }], bytes: 2, truncated: false, invalidUtf8: false });

  const oversized = createNdjsonCollector({ maxBytes: 5_000_000 });
  oversized.push(Buffer.alloc(256 * 1024 + 1, 0x61));
  const oversizedResult = oversized.finish();
  assert.equal(oversizedResult.events.length, 0);
  assert.equal(oversizedResult.truncated, true);
});

test('LocalRunLedger serializes independent MCP processes without lost updates', async (context) => {
  const fixtureValue = await fixture(context);
  const script = `
    const { LocalRunLedger } = await import(process.env.LOCAL_MODULE_URL);
    const ledger = new LocalRunLedger({ stateDir: process.argv[1], lockTimeoutMs: 5000, staleLockMs: 25 });
    await ledger.add({ localRunId: 'lrun-child-' + process.env.CHILD_INDEX.padStart(8, '0'), requestId: 'child-request-' + process.env.CHILD_INDEX.padStart(8, '0'), requestDigest: process.env.CHILD_INDEX, lifecycle: 'accepted' });
  `;
  const children = Array.from({ length: 8 }, (_, index) => ledgerChild(fixtureValue.state, script, { CHILD_INDEX: String(index) }));
  const results = await Promise.all(children.map(childResult));
  assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stderr).join('\n'));
  const persisted = await new LocalRunLedger({ stateDir: fixtureValue.state }).read();
  assert.equal(persisted.runs.length, 8);
  assert.deepEqual(new Set(persisted.runs.map((entry) => entry.requestId)).size, 8);
});

test('LocalRunLedger recovers a crashed owner and stale lock directory', async (context) => {
  const fixtureValue = await fixture(context);
  const holdScript = `
    const { LocalRunLedger } = await import(process.env.LOCAL_MODULE_URL);
    const { writeFile } = await import('node:fs/promises');
    const ledger = new LocalRunLedger({ stateDir: process.argv[1], lockTimeoutMs: 5000, staleLockMs: 60000 });
    await ledger.withLock(async () => { await writeFile(process.env.READY_FILE, 'locked'); await new Promise(() => {}); });
  `;
  const readyFile = path.join(fixtureValue.root, 'holder-ready');
  const holder = ledgerChild(fixtureValue.state, holdScript, { READY_FILE: readyFile });
  await waitForFile(readyFile);
  holder.kill('SIGKILL');
  await childResult(holder);
  const recovered = new LocalRunLedger({ stateDir: fixtureValue.state, lockTimeoutMs: 1000, staleLockMs: 60000 });
  await recovered.add({ localRunId: 'lrun-recovered-00001', requestId: 'recovered-request-1', requestDigest: 'recovered', lifecycle: 'accepted' });
  assert.ok((await recovered.find('lrun-recovered-00001')));

  await mkdir(path.join(fixtureValue.state, 'runs.lock'), { mode: 0o700 });
  const old = new Date(Date.now() - 10_000);
  await utimes(path.join(fixtureValue.state, 'runs.lock'), old, old);
  const staleRecovered = new LocalRunLedger({ stateDir: fixtureValue.state, lockTimeoutMs: 1000, staleLockMs: 1 });
  await staleRecovered.add({ localRunId: 'lrun-stale-recovered-0001', requestId: 'stale-recovered-1', requestDigest: 'stale', lifecycle: 'accepted' });
  assert.ok((await staleRecovered.find('lrun-stale-recovered-0001')));
});

test('LocalRunLedger preserves 201+ request tombstones across restart and fails closed at capacity', async (context) => {
  const fixtureValue = await fixture(context);
  const maxRecords = 256;
  const records = Array.from({ length: 201 }, (_, index) => ({
    localRunId: `lrun-terminal-${String(index).padStart(8, '0')}`,
    requestId: `terminal-request-${String(index).padStart(8, '0')}`,
    requestDigest: `terminal-digest-${index}`,
    lifecycle: 'terminal',
    terminalState: 'succeeded',
  }));
  const ledger = new LocalRunLedger({ stateDir: fixtureValue.state, maxRecords });
  await ledger.write({ version: 1, runs: records });

  const restarted = new LocalRunLedger({ stateDir: fixtureValue.state, maxRecords });
  const oldest = await restarted.findRequest(records[0].requestId);
  assert.equal(oldest.requestDigest, records[0].requestDigest);
  const duplicate = await restarted.add({ ...records[0], localRunId: 'lrun-retry-00000001' });
  assert.equal(duplicate.localRunId, records[0].localRunId);

  for (let index = records.length; index < maxRecords; index += 1) {
    await restarted.add({
      localRunId: `lrun-terminal-${String(index).padStart(8, '0')}`,
      requestId: `terminal-request-${String(index).padStart(8, '0')}`,
      requestDigest: `terminal-digest-${index}`,
      lifecycle: 'terminal',
      terminalState: 'succeeded',
    });
  }
  await assert.rejects(
    restarted.add({ localRunId: 'lrun-capacity-0000001', requestId: 'capacity-request-0001', requestDigest: 'capacity', lifecycle: 'accepted' }),
    /capacity|durable reservations/i,
  );

  const capacityState = path.join(fixtureValue.root, 'capacity-state');
  const capacityLedger = new LocalRunLedger({ stateDir: capacityState, maxRecords: 1 });
  await capacityLedger.add({
    localRunId: 'lrun-capacity-existing',
    requestId: 'capacity-existing-0001',
    requestDigest: 'existing',
    lifecycle: 'terminal',
    terminalState: 'succeeded',
  });
  let spawnCalls = 0;
  const service = new CursorLocalService({
    env: { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' },
    ledger: capacityLedger,
    spawnImpl: () => { spawnCalls += 1; throw new Error('spawn must not be reached at ledger capacity'); },
  });
  await assert.rejects(service.call('run', {
    workspace: fixtureValue.workspace,
    prompt: 'capacity check',
    mode: 'read_only',
    execution_profile: 'host_trusted',
    requestId: 'capacity-new-request-0001',
  }), /capacity|durable reservations/i);
  assert.equal(spawnCalls, 0);
  assert.ok(MAX_LOCAL_LEDGER_RECORDS >= maxRecords);
});

test('process-group termination rejects a reused PID before TERM/KILL', async () => {
  const originalKill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => {
    if (signal !== 0) signals.push({ pid, signal });
    return true;
  };
  try {
    await assert.rejects(
      terminateProcessGroup({ pid: process.pid }, { startToken: 'pid-reuse-does-not-match', graceMs: 0 }),
      /identity changed/i,
    );
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(signals, []);
});

test('auth projection discards account identity and returns only compact state', () => {
  const projected = projectAuth('{"authenticated":true,"email":"ada@example.test","userId":"secret"}', { CURSOR_LOCAL_CLI_API_KEY: 'local-secret' });
  assert.deepEqual(projected, { state: 'authenticated', method: 'api_key_env', apiKeyConfigured: true, probeError: undefined });
  assert.equal(JSON.stringify(projected).includes('ada@example.test'), false);
});

test('status reports local state and keeps host-trusted execution disabled by default', async (context) => {
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
    execution_profile: 'host_trusted',
    requestId: 'local-request-0001',
    waitMs: 5_000,
  }), /host-trusted/i);
  assert.equal(spawnCalls, 0);
  await assert.rejects(guardedService.call('run', {
    workspace: fixtureValue.workspace,
    prompt: 'inspect fixture',
    mode: 'read_only',
    execution_profile: 'host_trusted',
  }), /disabled|foundation_not_exposed/i);
  assert.equal(spawnCalls, 0);
  await assert.rejects(readFile(path.join(fixtureValue.state, 'runs.json'), 'utf8'), { code: 'ENOENT' });
});

test('host-trusted read-only execution requires explicit provider deny rules', async (context) => {
  const fixtureValue = await fixture(context);
  await writeFile(path.join(fixtureValue.config, 'cli-config.json'), JSON.stringify({ version: 1, permissions: { allow: [], deny: ['Mcp(*:*)'] } }), { mode: 0o600 });
  const env = { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' };
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'read_only', execution_profile: 'host_trusted' }),
    /Write\(\*\*\)/,
  );
  const implementEnvironment = await service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'implement', execution_profile: 'host_trusted' });
  assert.equal(implementEnvironment.boundary, 'host_trusted');
});

test('host-trusted implement rejects unrestricted approval and missing MCP deny rules', async (context) => {
  const fixtureValue = await fixture(context);
  const env = { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' };
  await writeFile(path.join(fixtureValue.config, 'cli-config.json'), JSON.stringify({
    version: 1,
    approvalMode: 'unrestricted',
    permissions: { allow: [], deny: ['Write(**)', 'Shell(*)'] },
  }), { mode: 0o600 });
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'implement', execution_profile: 'host_trusted' }),
    /Unrestricted Cursor CLI approval mode/,
  );
  await writeFile(path.join(fixtureValue.config, 'cli-config.json'), JSON.stringify({
    version: 1,
    approvalMode: 'allowlist',
    permissions: { allow: [], deny: ['Write(**)', 'Shell(*)'] },
  }), { mode: 0o600 });
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'implement', execution_profile: 'host_trusted' }),
    /Mcp\(\*:\*\)/,
  );
});

test('host-trusted runs reject group-writable home and config directories', async (context) => {
  const fixtureValue = await fixture(context);
  const env = { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' };
  await chmod(fixtureValue.home, 0o750);
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'implement', execution_profile: 'host_trusted' }),
    /owner-only|0700/,
  );
  await chmod(fixtureValue.home, 0o700);
  await chmod(fixtureValue.config, 0o750);
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'read_only', execution_profile: 'host_trusted' }),
    /permission config|owner-only|0700/,
  );
});

test('explicit relative Cursor config directory fails closed instead of falling back to HOME', async (context) => {
  const fixtureValue = await fixture(context);
  const env = { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1', CURSOR_LOCAL_CLI_CONFIG_DIR: 'relative-config' };
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'read_only', execution_profile: 'host_trusted' }),
    /CONFIG_DIR|config directory|configuration/i,
  );
});

test('host-trusted read-only rejects a symlinked project Cursor config directory', async (context) => {
  const fixtureValue = await fixture(context);
  const external = path.join(fixtureValue.root, 'external-project-config');
  await mkdir(external, { mode: 0o700 });
  await writeFile(path.join(external, 'cli.json'), JSON.stringify({
    permissions: { allow: [], deny: ['Write(**)', 'Shell(*)', 'Mcp(*:*)'] },
  }), { mode: 0o600 });
  await symlink(external, path.join(fixtureValue.workspace, '.cursor'));
  const env = { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' };
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'read_only', execution_profile: 'host_trusted' }),
    /project \.cursor directory must be a real directory|invalid or not owner-only/,
  );
});

test('host-trusted read-only rejects unrestricted project approval mode', async (context) => {
  const fixtureValue = await fixture(context);
  const projectDirectory = path.join(fixtureValue.workspace, '.cursor');
  await mkdir(projectDirectory, { mode: 0o700 });
  await writeFile(path.join(projectDirectory, 'cli.json'), JSON.stringify({
    approvalMode: 'unrestricted',
    permissions: { allow: [], deny: ['Write(**)', 'Shell(*)', 'Mcp(*:*)'] },
  }), { mode: 0o600 });
  const env = { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' };
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  await assert.rejects(
    service.verifyRunEnvironment({ workspace: fixtureValue.workspace, prompt: 'x', mode: 'read_only', execution_profile: 'host_trusted' }),
    /Unrestricted Cursor CLI approval mode/,
  );
});

test('host-trusted run invokes cursor-agent directly with bounded, honest receipts', async (context) => {
  const fixtureValue = await fixture(context);
  const env = {
    ...fixtureValue.env,
    [HOST_TRUSTED_RUNS_ENV]: '1',
    CURSOR_LOCAL_CLI_API_KEY: 'local-secret',
    CURSOR_API_KEY: 'cloud-secret-must-not-cross',
  };
  let spawned;
  const service = new CursorLocalService({
    env,
    ledger: new LocalRunLedger({ stateDir: fixtureValue.state }),
    spawnImpl: (...args) => { spawned = args; return spawn(...args); },
  });
  const result = await service.call('run', {
    workspace: fixtureValue.workspace,
    prompt: 'inspect fixture',
    mode: 'read_only',
    execution_profile: 'host_trusted',
    requestId: 'host-trusted-read-only-0001',
    waitMs: 5_000,
    maxEvents: 10,
    maxBytes: 20_000,
  });
  assert.equal(result.ok, true);
  assert.equal(spawned[0], fixtureValue.binary);
  assert.equal(spawned[2].cwd, fixtureValue.workspace);
  assert.equal(spawned[2].env.CURSOR_API_KEY, 'local-secret');
  assert.equal(spawned[2].env.CLOUD_API_KEY, undefined);
  assert.equal(spawned[2].env.MODEL_API_KEY, undefined);
  assert.ok(spawned[1].includes('--sandbox') && spawned[1].includes('disabled'));
  assert.equal(spawned[1].includes('--force'), false);
  assert.equal(result.receipt.execution.boundary, 'host_trusted');
  assert.equal(result.receipt.execution.authority, 'mcp_process_user');
  assert.equal(result.receipt.execution.outerSandbox, 'none');
  assert.equal(result.receipt.execution.providerSandbox, 'disabled');
  assert.equal(result.receipt.workspaceChanged, null);
  assert.equal(result.receipt.workspaceChangeProof, 'not_attested_host_trusted');
  assert.equal(result.receipt.terminalState, 'succeeded');
  assert.equal(JSON.stringify(result).includes('cloud-secret-must-not-cross'), false);
});

test('host-trusted lifecycle fails closed without a valid provider cwd and retains redacted stderr', async (context) => {
  const fixtureValue = await fixture(context);
  await writeFile(fixtureValue.binary, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'cursor-agent test-no-cwd'
  exit 0
fi
printf '%s\\n' '{"type":"system","subtype":"init"}'
printf 'provider-secret\\n' >&2
printf '%s\\n' '{"type":"result","subtype":"success","result":"done"}'
exit 0
`, { mode: 0o700 });
  await chmod(fixtureValue.binary, 0o700);
  const env = {
    ...fixtureValue.env,
    [HOST_TRUSTED_RUNS_ENV]: '1',
    CURSOR_LOCAL_CLI_API_KEY: 'provider-secret',
  };
  env.CURSOR_LOCAL_CLI_SHA256 = createHash('sha256').update(await readFile(fixtureValue.binary)).digest('hex');
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }), spawnImpl: (...args) => spawn(...args) });
  const result = await service.call('run', {
    workspace: fixtureValue.workspace,
    prompt: 'inspect fixture',
    mode: 'read_only',
    execution_profile: 'host_trusted',
    requestId: 'host-trusted-no-cwd-0001',
    waitMs: 5_000,
  });
  assert.equal(result.receipt.terminalState, 'environment_blocked');
  assert.equal(result.receipt.logs.events.some((event) => event.type === 'stderr' && event.text.includes('provider-secret') === false), true);
  assert.equal(JSON.stringify(result).includes('provider-secret'), false);
});

test('host-trusted catalog exposes run lifecycle only after administrator activation', async (context) => {
  const fixtureValue = await fixture(context);
  const output = [];
  const outputStream = new Writable({ write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); } });
  await runStdio({
    input: Readable.from([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      '',
    ].join('\n')),
    output: outputStream,
    service: new CursorLocalService({ env: { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' }, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) }),
  });
  const response = JSON.parse(output.join('').trim());
  assert.deepEqual(response.result.tools.map((tool) => tool.name), ['status', 'run', 'runs']);
});

test('host-trusted cancellation escalates an owned process group after TERM', async (context) => {
  const fixtureValue = await fixture(context);
  await writeFile(fixtureValue.binary, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'cursor-agent test-long-running'
  exit 0
fi
if [ "$1" = "status" ]; then
  printf '%s\\n' '{"authenticated":true}'
  exit 0
fi
printf '%s\\n' '{"type":"system","subtype":"init","cwd":"'"$HOME"'/.cursor/worktrees/test"}'
trap '' TERM INT
sleep 30 &
wait
`, { mode: 0o700 });
  await chmod(fixtureValue.binary, 0o700);
  const env = {
    ...fixtureValue.env,
    [HOST_TRUSTED_RUNS_ENV]: '1',
  };
  env.CURSOR_LOCAL_CLI_SHA256 = createHash('sha256').update(await readFile(fixtureValue.binary)).digest('hex');
  const service = new CursorLocalService({ env, ledger: new LocalRunLedger({ stateDir: fixtureValue.state }) });
  const started = await service.call('run', {
    workspace: fixtureValue.workspace,
    prompt: 'long-running fixture',
    mode: 'read_only',
    execution_profile: 'host_trusted',
    requestId: 'host-trusted-cancel-0001',
    waitMs: 0,
    timeoutMs: 30_000,
  });
  const cancelled = await service.call('runs', { action: 'cancel', localRunId: started.receipt.localRunId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.run.terminalState, 'cancelled');
  assert.equal(cancelled.run.execution.boundary, 'host_trusted');
});

test('host-trusted spawn failure finalizes the local receipt instead of leaving it accepted', async (context) => {
  const fixtureValue = await fixture(context);
  const env = { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' };
  const service = new CursorLocalService({
    env,
    ledger: new LocalRunLedger({ stateDir: fixtureValue.state }),
    spawnImpl: () => { const error = new Error('spawn denied'); error.code = 'EACCES'; throw error; },
  });
  await assert.rejects(service.call('run', {
    workspace: fixtureValue.workspace,
    prompt: 'spawn failure fixture',
    mode: 'implement',
    execution_profile: 'host_trusted',
    requestId: 'host-trusted-spawn-failure-0001',
  }), /start the local Cursor CLI/);
  const record = await service.ledger.findRequest('host-trusted-spawn-failure-0001');
  assert.equal(record.lifecycle, 'terminal');
  assert.equal(record.terminalState, 'failed');
  assert.equal(record.error, 'EACCES');
});

test('local service reconciles persisted runs whose owner process disappeared', async (context) => {
  const fixtureValue = await fixture(context);
  const ledger = new LocalRunLedger({ stateDir: fixtureValue.state });
  await ledger.add({
    localRunId: 'lrun-orphaned-00001',
    requestId: 'orphaned-request-1',
    requestDigest: 'orphaned-digest',
    lifecycle: 'working',
    terminalState: null,
    execution: { ownerPid: 999999, ownerStart: '1', childPid: null, childStart: null },
  });
  const service = new CursorLocalService({ env: { ...fixtureValue.env, [HOST_TRUSTED_RUNS_ENV]: '1' }, ledger });
  const result = await service.call('runs', { action: 'get', localRunId: 'lrun-orphaned-00001' });
  assert.equal(result.run.lifecycle, 'terminal');
  assert.equal(result.run.terminalState, 'transport_lost');
  assert.equal(result.run.error, 'owner_process_lost');
});

test('local MCP process exposes status only and rejects unactivated host-trusted calls', async () => {
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
  assert.ok(local.env_vars.includes(HOST_TRUSTED_RUNS_ENV));
  assert.equal(local.env_vars.includes('CURSOR_LOCAL_CLI_ENABLE_RUNS'), false);
});
