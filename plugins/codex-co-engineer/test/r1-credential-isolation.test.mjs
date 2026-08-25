import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runAcpTask } from '../mcp/v3/acp-worker.mjs';
import {
  CredentialBoundaryError,
  createCredentialHandoff,
  denyWorkerRemoteMutation,
  installClosedProviderTestInjection,
  inspectArgvForSecrets,
  inspectEnvForSecrets,
  projectProviderEnvironment,
  recoverStaleCredentialHandoffs,
} from '../mcp/v3/credential-boundary.mjs';
import {
  classifyGitOperationV1,
} from '../mcp/v3/git-authority.mjs';
import {
  launchProcessBoundary,
  ProcessBoundaryError,
  restoreProcessBoundary,
  stopProcessBoundary,
} from '../mcp/v3/process-boundary.mjs';
import {
  composeProviderDriverV1,
  describeProviderRegistryV1,
  PROVIDER_REGISTRY_SLOTS,
} from '../mcp/v3/provider-registry.mjs';
import { submitTask } from '../mcp/v3/supervisor.mjs';
import { createTask } from '../mcp/v3/task-store.mjs';
import { HOSTILE_ENV } from './fixtures/r1-credential-boundary-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  MANIFEST_DIGEST_HEX,
  RUN_ID,
  operationRequest,
} from './fixtures/r1-git-authority-fixtures.mjs';

const SHA = 'a'.repeat(40);
const FAKE_AGENT = fileURLToPath(new URL('./acpx-fake-agent.mjs', import.meta.url));
const FAKE_ACPX = fileURLToPath(new URL('./fake-acpx.mjs', import.meta.url));
const HANDOFF_LOADER = fileURLToPath(new URL('../mcp/v3/credential-handoff-loader.mjs', import.meta.url));
const AMBIENT_SECRET_KEYS = [
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GH_TOKEN',
  'GITHUB_TOKEN', 'GITLAB_TOKEN', 'WORKTREE_BOOTSTRAP_TASK', 'MODEL_API_KEY',
  'OPENROUTER_API_KEY', 'CURSOR_API_KEY',
];

async function withAmbientSecrets(extra, build) {
  const assigned = { ...Object.fromEntries(AMBIENT_SECRET_KEYS.map((key) => [key, HOSTILE_ENV[key]])), ...extra };
  const previous = {};
  for (const [key, value] of Object.entries(assigned)) {
    previous[key] = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await build();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function collectStdout(child) {
  return new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', () => {});
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${text}`));
      else resolve(text);
    });
  });
}

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.emit('exit', null, 'SIGTERM'); };
  queueMicrotask(() => {
    child.emit('spawn');
    child.exitCode = exitCode;
    child.emit('exit', exitCode, null);
  });
  return child;
}

function showAdapter() {
  return {
    platform: 'linux',
    uid: 1000,
    execFile: async (_command, args) => {
      const unit = args.find((value) => value.startsWith('codex-co-engineer-') && value.endsWith('.service'))
        ?? 'codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service';
      const token = unit.slice('codex-co-engineer-'.length, -'.service'.length);
      return { stdout: [
        `Id=${unit}`,
        `Description=codex-co-engineer-task:${token}`,
        'LoadState=loaded',
        'ActiveState=active',
        `ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
        'KillMode=control-group',
        'InvocationID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'MainPID=4242',
      ].join('\n') };
    },
    readFile: async () => 'populated 0\nfrozen 0\n',
    sleep: async () => {},
  };
}

test('hostile environment and systemd-run argv inspection keeps secrets off the client', async () => {
  const calls = [];
  const host = {
    ...showAdapter(),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild();
    },
  };
  const env = {
    ...HOSTILE_ENV,
    HOME: '/home/test-user',
  };
  const launched = await launchProcessBoundary({
    command: '/usr/bin/node',
    args: ['worker.mjs'],
    cwd: '/workspace/repo',
    env: projectProviderEnvironment({ provider: 'grok', source: env, operation: 'lane' }),
    stdio: 'ignore',
    adapter: host,
  });
  assert.equal(calls.length, 1);
  const secrets = [
    HOSTILE_ENV.XAI_API_KEY, HOSTILE_ENV.MODEL_API_KEY, HOSTILE_ENV.OPENROUTER_API_KEY,
    HOSTILE_ENV.CURSOR_API_KEY, HOSTILE_ENV.GH_TOKEN, HOSTILE_ENV.GIT_SSH_COMMAND,
  ];
  assert.equal(inspectArgvForSecrets(calls[0].args, secrets), false);
  assert.equal(inspectEnvForSecrets(calls[0].options.env, secrets), false);
  assert.equal(calls[0].args.includes('--setenv=XAI_API_KEY=xai-secret-value-abcdef'), false);
  assert.equal(calls[0].args.some((entry) => String(entry).includes('credential-handoff-loader.mjs')), true);
  assert.equal(calls[0].args.some((entry) => String(entry).startsWith('--setenv=GIT_SSH')), false);
  await stopProcessBoundary(launched.handle, { adapter: host, timeoutMs: 100 });
});

test('spawn failure and cancel cleanup remove the credential handoff file', async () => {
  const calls = [];
  await assert.rejects(
    launchProcessBoundary({
      command: '/usr/bin/node',
      args: ['worker.mjs'],
      cwd: '/workspace/repo',
      env: { HOME: '/tmp/home', PATH: '/bin', MODEL_API_KEY: 'cleanup-secret-value' },
      stdio: 'ignore',
      adapter: {
        ...showAdapter(),
        spawn: (command, args, options) => {
          calls.push({ command, args, options });
          return fakeChild(1);
        },
      },
    }),
    (error) => error instanceof ProcessBoundaryError && error.code === 'systemd_run_failed',
  );
  assert.equal(inspectArgvForSecrets(calls[0].args, ['cleanup-secret-value']), false);
  const handoff = calls[0].args.find((entry) => typeof entry === 'string' && entry.endsWith('env.json'));
  assert.equal(typeof handoff, 'string');
  await assert.rejects(import('node:fs/promises').then((fs) => fs.lstat(handoff)), (error) => error.code === 'ENOENT');
});

test('supervisor launch inspects a closed grok environment against a hostile parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-p29-supervisor-'));
  const repo = path.join(root, 'repo');
  let launched;
  try {
    await mkdir(repo);
    await submitTask({
      task_id: 'p29-grok-isolation',
      provider: 'grok',
      repo,
      prompt: 'do not leak credentials',
      workspace_mode: 'direct',
      expected_duration_ms: 10_000,
    }, {
      root,
      env: HOSTILE_ENV,
      execute: async (_command, args) => {
        if (args.includes('--show-toplevel')) return { stdout: `${repo}\n` };
        if (args.includes('--show-current')) return { stdout: 'feature\n' };
        if (args.includes('HEAD')) return { stdout: `${SHA}\n` };
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
      probeBoundary: async () => ({
        ready: true, status: 'prerequisites_ready', provider_started: false,
        boundary: 'systemd-user-service-cgroup',
      }),
      launch: async (request) => {
        launched = request;
        return { pid: 9101, process_group: 9101, process_start_ticks: '9' };
      },
    });
    assert.equal(launched.env.XAI_API_KEY, HOSTILE_ENV.XAI_API_KEY);
    assert.equal(launched.env.GH_TOKEN, undefined);
    assert.equal(launched.env.GIT_SSH, undefined);
    assert.equal(launched.env.SSH_AUTH_SOCK, undefined);
    assert.equal(launched.env.MODEL_API_KEY, undefined);
    assert.equal(launched.env.CURSOR_API_KEY, undefined);
    assert.equal(launched.env.WORKTREE_BOOTSTRAP_TASK, undefined);
    assert.equal(launched.env.CODEX_CO_ENGINEER_MODEL_API_KEY_FILE, undefined);
    assert.equal(launched.env.GIT_TERMINAL_PROMPT, '0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P23 registry composition and P28 denied operations remain exact', () => {
  const inventory = describeProviderRegistryV1();
  assert.deepEqual([...PROVIDER_REGISTRY_SLOTS], ['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
  assert.equal(inventory.slots.length, 4);
  assert.equal(typeof composeProviderDriverV1, 'function');
  const denied = classifyGitOperationV1(operationRequest({
    operation: 'push',
    actor: 'worker',
    identity: {
      repository_path: '/tmp/cce-r1-authority-repo',
      base_sha: BASE_SHA,
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
    },
    manifest_digest_hex: MANIFEST_DIGEST_HEX,
  }));
  assert.equal(denied.verdict, 'denied');
  assert.equal(denied.message.includes('/tmp'), false);
  assert.throws(() => denyWorkerRemoteMutation('push'), (error) => (
    error instanceof CredentialBoundaryError && error.code === 'remote_mutation_denied'
  ));
  assert.throws(() => denyWorkerRemoteMutation('create_pr'), (error) => error.code === 'remote_mutation_denied');
  assert.throws(() => denyWorkerRemoteMutation('merge'), (error) => error.code === 'remote_mutation_denied');
  assert.throws(() => denyWorkerRemoteMutation('rebase'), (error) => error.code === 'remote_mutation_denied');
  assert.throws(() => denyWorkerRemoteMutation('tag_create'), (error) => error.code === 'remote_mutation_denied');
  assert.throws(() => denyWorkerRemoteMutation('release_create'), (error) => error.code === 'remote_mutation_denied');
});

describe('closed Grok and Cursor Local ACP/service projection', { concurrency: 1 }, () => {
test('cursor-local systemd launch unsets manager secrets and always uses the closed loader', async () => {
  const calls = [];
  await withAmbientSecrets({}, async () => {
    const host = {
      ...showAdapter(),
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return fakeChild();
      },
    };
    const launched = await launchProcessBoundary({
      command: '/usr/bin/node',
      args: ['worker.mjs'],
      cwd: '/workspace/repo',
      env: projectProviderEnvironment({ provider: 'cursor-local', source: HOSTILE_ENV, operation: 'lane' }),
      stdio: 'ignore',
      adapter: host,
    });
    assert.equal(calls.length, 1);
    const unset = calls[0].args.find((entry) => String(entry).startsWith('--property=UnsetEnvironment='));
    assert.equal(typeof unset, 'string');
    assert.equal(unset.includes('SSH_AUTH_SOCK'), true);
    assert.equal(unset.includes('GH_TOKEN'), true);
    assert.equal(calls[0].args.includes('--setenv=SSH_AUTH_SOCK=/tmp/hostile-agent.sock'), false);
    assert.equal(calls[0].args.includes('SSH_AUTH_SOCK=/tmp/hostile-agent.sock'), false);
    assert.equal(calls[0].args.includes('/usr/bin/env'), true);
    assert.equal(calls[0].args.includes('-i'), true);
    assert.equal(calls[0].args.some((entry) => String(entry).includes('credential-handoff-loader.mjs')), true);
    assert.equal(inspectArgvForSecrets(calls[0].args, [HOSTILE_ENV.CURSOR_API_KEY, HOSTILE_ENV.XAI_API_KEY, HOSTILE_ENV.GH_TOKEN]), false);
    await stopProcessBoundary(launched.handle, { adapter: host, timeoutMs: 100 });
  });
});

test('handoff loader child is a closed projection plus authorized secrets only', async () => {
  const created = await createCredentialHandoff({ XAI_API_KEY: HOSTILE_ENV.XAI_API_KEY });
  const child = spawn(process.execPath, [
    HANDOFF_LOADER, created.path, '--', process.execPath, '-e',
    'process.stdout.write(JSON.stringify(process.env))',
  ], {
    env: (() => {
      const env = {
        ...HOSTILE_ENV,
        PATH: process.env.PATH ?? HOSTILE_ENV.PATH,
        HOME: process.env.HOME ?? HOSTILE_ENV.HOME,
      };
      delete env.NODE_OPTIONS;
      return env;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = await collectStdout(child);
  const env = JSON.parse(stdout);
  assert.equal(env.XAI_API_KEY, HOSTILE_ENV.XAI_API_KEY);
  assert.equal(env.PATH, process.env.PATH ?? HOSTILE_ENV.PATH);
  for (const key of AMBIENT_SECRET_KEYS) assert.equal(env[key], undefined, key);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.CURSOR_API_KEY, undefined);
  assert.equal(env.MODEL_API_KEY, undefined);
  assert.equal(env.CODEX_CO_ENGINEER_CREDENTIAL_HANDOFF, undefined);
});

test('supervisor launch inspects a closed cursor-local environment against a hostile parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-p29-cursor-local-'));
  const repo = path.join(root, 'repo');
  let launched;
  try {
    await mkdir(repo);
    await submitTask({
      task_id: 'p29-cursor-local-isolation',
      provider: 'cursor-local',
      repo,
      prompt: 'do not leak credentials',
      workspace_mode: 'direct',
      expected_duration_ms: 10_000,
    }, {
      root,
      env: HOSTILE_ENV,
      execute: async (_command, args) => {
        if (args.includes('--show-toplevel')) return { stdout: `${repo}\n` };
        if (args.includes('--show-current')) return { stdout: 'feature\n' };
        if (args.includes('HEAD')) return { stdout: `${SHA}\n` };
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
      probeBoundary: async () => ({
        ready: true, status: 'prerequisites_ready', provider_started: false,
        boundary: 'systemd-user-service-cgroup',
      }),
      launch: async (request) => {
        launched = request;
        return { pid: 9102, process_group: 9102, process_start_ticks: '9' };
      },
    });
    assert.equal(launched.env.CURSOR_API_KEY, undefined);
    assert.equal(launched.env.XAI_API_KEY, undefined);
    assert.equal(launched.env.GH_TOKEN, undefined);
    assert.equal(launched.env.SSH_AUTH_SOCK, undefined);
    assert.equal(launched.env.GIT_TERMINAL_PROMPT, '0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const provider of ['grok', 'cursor-local']) {
  test(`${provider} ACP children omit manager and process ambient secrets`, async () => {
    await withAmbientSecrets({
      XAI_API_KEY: HOSTILE_ENV.XAI_API_KEY,
      FAKE_ACPX_HOSTILE: 'ambient-fake-acpx-secret',
    }, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `co-engineer-p29-acp-${provider}-`));
      const cwd = path.join(root, 'worktree');
      try {
        await mkdir(cwd);
        await createTask({
          root,
          prompt: 'review this repository',
          record: {
            id: `${provider}-ambient`,
            status: 'accepted',
            provider,
            cwd,
            agent_argv: [process.execPath, FAKE_AGENT, '--mode', 'normal'],
            timeout_ms: 5_000,
          },
        });
        const terminal = await runAcpTask({ root, taskId: `${provider}-ambient` });
        assert.equal(terminal.status, 'completed');
        const observed = JSON.parse(await readFile(path.join(cwd, '.acpx-fake-observed.json'), 'utf8'));
        assert.equal(observed.env.SSH_AUTH_SOCK, undefined);
        assert.equal(observed.env.GH_TOKEN, undefined);
        assert.equal(observed.env.GITHUB_TOKEN, undefined);
        assert.equal(observed.env.GIT_SSH, undefined);
        assert.equal(observed.env.MODEL_API_KEY, undefined);
        assert.equal(observed.env.OPENROUTER_API_KEY, undefined);
        assert.equal(observed.env.CURSOR_API_KEY, undefined);
        assert.equal(observed.env.WORKTREE_BOOTSTRAP_TASK, undefined);
        if (provider === 'grok') {
          assert.equal(observed.env.XAI_API_KEY, HOSTILE_ENV.XAI_API_KEY);
        } else {
          assert.equal(observed.env.XAI_API_KEY, undefined);
        }
        assert.equal(observed.env.FAKE_ACPX_HOSTILE, undefined);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}

test('restart reconstructs handoff identity and cleans without exposing paths or values', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'cce-p29-restart-'));
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const calls = [];
  const host = {
    ...showAdapter(),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild();
    },
  };
  try {
    const launched = await launchProcessBoundary({
      command: '/usr/bin/node',
      args: ['worker.mjs'],
      cwd: '/workspace/repo',
      env: { HOME: '/home/test-user', PATH: '/bin', MODEL_API_KEY: 'restart-secret-value' },
      stdio: 'ignore',
      adapter: host,
    });
    const handoff = calls[0].args.find((entry) => typeof entry === 'string' && entry.endsWith('env.json'));
    assert.equal(typeof handoff, 'string');
    assert.equal(handoff.startsWith(runtime), true);
    assert.equal(JSON.stringify(launched.receipt).includes(handoff), false);
    assert.equal(JSON.stringify(launched.receipt).includes('restart-secret-value'), false);
    assert.equal(inspectArgvForSecrets(calls[0].args, ['restart-secret-value']), false);
    const metadata = await lstat(handoff);
    assert.equal(metadata.isFile(), true);
    const restored = restoreProcessBoundary(launched.receipt, { adapter: host });
    host.readFile = async () => 'populated 0\nfrozen 0\n';
    await stopProcessBoundary(restored, { adapter: host, timeoutMs: 100 });
    await assert.rejects(lstat(handoff), (error) => error.code === 'ENOENT');
  } finally {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    await rm(runtime, { recursive: true, force: true });
  }
});

test('stale identity handoffs recover without echoing paths or values', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'cce-p29-stale-'));
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  try {
    const created = await createCredentialHandoff(
      { MODEL_API_KEY: 'stale-secret-value' },
      { identity: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    );
    await lstat(created.path);
    const recovered = await recoverStaleCredentialHandoffs({ directory: runtime });
    assert.equal(recovered.recovered >= 1, true);
    await assert.rejects(lstat(created.path), (error) => error.code === 'ENOENT');
    assert.equal(JSON.stringify(recovered).includes(created.path), false);
    assert.equal(JSON.stringify(recovered).includes('stale-secret-value'), false);
  } finally {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    await rm(runtime, { recursive: true, force: true });
  }
});

test('DSH ACPX nested children omit ambient FAKE_ACPX and secrets except closed injection', async () => {
  const previousCommand = process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
  try {
    await withAmbientSecrets({
      FAKE_ACPX_HOSTILE: 'ambient-fake-acpx-secret',
      FAKE_ACPX_MODE: 'should-not-win',
      MODEL_API_KEY: HOSTILE_ENV.MODEL_API_KEY,
    }, async () => {
      process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = FAKE_ACPX;
      installClosedProviderTestInjection({ FAKE_ACPX_MODE: 'success' });
      const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-p29-dsh-acpx-'));
      const cwd = path.join(root, 'worktree');
      try {
        await mkdir(cwd);
        await createTask({
          root,
          prompt: 'do not leak credentials',
          record: {
            id: 'dsh-ambient',
            status: 'accepted',
            provider: 'dsh',
            cwd,
            agent_argv: [process.execPath, FAKE_AGENT, '--mode', 'normal'],
            timeout_ms: 5_000,
          },
        });
        const terminal = await runAcpTask({ root, taskId: 'dsh-ambient' });
        assert.equal(terminal.status, 'completed');
        const keys = JSON.parse(await readFile(path.join(cwd, '.fake-acpx-env-keys.json'), 'utf8'));
        assert.equal(keys.includes('FAKE_ACPX_MODE'), true);
        assert.equal(keys.includes('FAKE_ACPX_HOSTILE'), false);
        assert.equal(keys.includes('GH_TOKEN'), false);
        assert.equal(keys.includes('SSH_AUTH_SOCK'), false);
        assert.equal(keys.includes('GITHUB_TOKEN'), false);
        assert.equal(keys.includes('WORKTREE_BOOTSTRAP_TASK'), false);
        assert.equal(JSON.stringify(keys).includes('ambient-fake-acpx-secret'), false);
        assert.equal(JSON.stringify(keys).includes(HOSTILE_ENV.MODEL_API_KEY), false);
      } finally {
        installClosedProviderTestInjection(null);
        await rm(root, { recursive: true, force: true });
      }
    });
  } finally {
    installClosedProviderTestInjection(null);
    if (previousCommand === undefined) delete process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
    else process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = previousCommand;
  }
});
});
