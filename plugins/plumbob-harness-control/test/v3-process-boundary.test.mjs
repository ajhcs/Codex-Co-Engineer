import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildProcessBoundaryArgv,
  inspectProcessBoundary,
  launchProcessBoundary,
  probeProcessBoundary,
  ProcessBoundaryError,
  restoreProcessBoundary,
  stopProcessBoundary,
} from '../mcp/v3/process-boundary.mjs';

function receipt(overrides = {}) {
  return {
    version: 1,
    boundary: 'systemd-user-scope-cgroup',
    unit: 'codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope',
    description: 'codex-co-engineer-task:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    invocation_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    control_group: '/user.slice/user-1000.slice/user@1000.service/app.slice/codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope',
    ...overrides,
  };
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

test('builds a manager-owned systemd service without narrowing provider argv or environment', () => {
  const argv = buildProcessBoundaryArgv({
    unit: 'codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service',
    description: 'codex-co-engineer-task:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    command: '/usr/bin/node',
    args: ['worker.mjs', '--provider-capability', 'full'],
    cwd: '/workspace/repo',
    env: { HOME: '/home/test-user', MODEL_API_KEY: 'provider-secret' },
    logPath: '/state/task.log',
  });
  assert.deepEqual(argv, [
    '--user', '--quiet', '--collect', '--no-block', '--service-type=exec', '--unit=codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service',
    '--property=Description=codex-co-engineer-task:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '--property=KillMode=control-group',
    '--working-directory=/workspace/repo',
    '--property=StandardOutput=append:/state/task.log',
    '--property=StandardError=append:/state/task.log',
    '--setenv=HOME=/home/test-user',
    '--setenv=MODEL_API_KEY=provider-secret',
    '--', '/usr/bin/node', 'worker.mjs', '--provider-capability', 'full',
  ]);
  assert.equal(argv.some((entry) => /MemoryMax|TasksMax|NoNewPrivileges|Private|Restrict|Protect/iu.test(entry)), false);
});

test('probe fails closed without Linux cgroup/systemd prerequisites', async () => {
  const result = await probeProcessBoundary({
    adapter: {
      platform: 'linux',
      uid: 1000,
      readFile: async (file) => file.endsWith('controllers') ? 'memory pids' : '0::/user.slice/user-1000.slice',
      execFile: async () => { throw Object.assign(new Error('bus unavailable'), { stderr: 'Failed to connect to bus' }); },
      spawn: () => fakeChild(),
      sleep: async () => {},
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'systemd_user_manager_unavailable');
});

test('launch preserves cwd, full env, stdio, and provider command while verifying ownership', async () => {
  const calls = [];
  const host = {
    platform: 'linux',
    uid: 1000,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild();
    },
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
    readFile: async () => 'populated 1\nfrozen 0\n',
    sleep: async () => {},
  };
  const environment = { HOME: '/home/test-user', MODEL_API_KEY: 'provider-secret', PATH: '/bin' };
  const value = await launchProcessBoundary({
    command: '/usr/bin/node',
    args: ['worker.mjs', '--full-capability'],
    cwd: '/workspace/repo',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    logPath: '/state/task.log',
    adapter: host,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/systemd-run');
  assert.equal(calls[0].options.env.MODEL_API_KEY, environment.MODEL_API_KEY);
  assert.equal(calls[0].options.env.HOME, environment.HOME);
  assert.equal(calls[0].options.cwd, '/workspace/repo');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(calls[0].args.slice(-3), ['/usr/bin/node', 'worker.mjs', '--full-capability']);
  assert.equal(value.receipt.boundary, 'systemd-user-service-cgroup');
  assert.equal(value.receipt.unit.endsWith('.service'), true);
  assert.equal(value.child.pid, 4242);
  assert.equal(calls[0].args.includes('--setenv=MODEL_API_KEY=provider-secret'), true);
  assert.equal(calls[0].args.includes('--property=StandardOutput=append:/state/task.log'), true);
});

test('reports a failed systemd-run client before attempting unit ownership verification', async () => {
  let inspectCalls = 0;
  await assert.rejects(
    launchProcessBoundary({
      command: '/usr/bin/node',
      args: ['worker.mjs'],
      cwd: '/workspace/repo',
      env: { HOME: '/home/test-user', PATH: '/bin' },
      stdio: 'ignore',
      adapter: {
        platform: 'linux',
        uid: 1000,
        spawn: () => fakeChild(1),
        execFile: async () => {
          inspectCalls += 1;
          return { stdout: 'LoadState=not-found\n' };
        },
        readFile: async () => 'populated 0\n',
        sleep: async () => {},
      },
    }),
    (error) => error instanceof ProcessBoundaryError && error.code === 'systemd_run_failed',
  );
  // One best-effort cleanup inspection is allowed, but the launch loop must
  // not repeatedly poll a unit that systemd-run never queued.
  assert.ok(inspectCalls <= 1);
});

test('stop signals all members, escalates only after the owned cgroup stays populated, and is idempotent', async () => {
  const actions = [];
  let populated = true;
  let active = 'active';
  const host = {
    platform: 'linux',
    uid: 1000,
    spawn: () => fakeChild(),
    execFile: async (_command, args) => {
      if (args[1] === 'show') {
        return { stdout: [
          `Id=${receipt().unit}`,
          `Description=${receipt().description}`,
          `LoadState=loaded`,
          `ActiveState=${active}`,
          `ControlGroup=${receipt().control_group}`,
          'KillMode=control-group',
          `InvocationID=${receipt().invocation_id}`,
        ].join('\n') };
      }
      actions.push(args);
      if (args[1] === 'kill' && args.at(-2) === '--signal=KILL') populated = false;
      return { stdout: '' };
    },
    readFile: async () => `populated ${populated ? 1 : 0}\nfrozen 0\n`,
    sleep: async () => {},
  };
  const handle = restoreProcessBoundary(receipt(), { adapter: host });
  const stopped = await stopProcessBoundary(handle, { adapter: host, timeoutMs: 100 });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.forced, true);
  assert.deepEqual(actions, [
    ['--user', 'kill', '--kill-whom=all', '--signal=TERM', receipt().unit],
    ['--user', 'kill', '--kill-whom=all', '--signal=KILL', receipt().unit],
  ]);
  const second = await stopProcessBoundary(handle, { adapter: host, timeoutMs: 100 });
  assert.equal(second.idempotent, true);
  active = 'inactive';
  assert.equal((await inspectProcessBoundary(handle, { adapter: host })).found, true);
});

test('rejects forged or mismatched ownership receipts before systemd mutation', async () => {
  const handle = restoreProcessBoundary(receipt(), {
    adapter: {
      platform: 'linux', uid: 1000, spawn: () => fakeChild(), execFile: async () => ({ stdout: '' }),
      readFile: async () => 'populated 0\n', sleep: async () => {},
    },
  });
  await assert.rejects(
    stopProcessBoundary(handle, {
      adapter: {
        platform: 'linux', uid: 1000, spawn: () => fakeChild(), execFile: async () => ({ stdout: '' }),
        readFile: async () => 'populated 0\n', sleep: async () => {},
      },
    }),
    (error) => error instanceof ProcessBoundaryError && error.code === 'adapter_mismatch',
  );
  assert.throws(() => restoreProcessBoundary({ ...receipt(), control_group: '/tmp/not-a-cgroup' }, {
    adapter: { platform: 'linux', uid: 1000, spawn: () => fakeChild(), execFile: async () => ({ stdout: '' }), readFile: async () => '', sleep: async () => {} },
  }), (error) => error.code === 'invalid_control_group');
});
