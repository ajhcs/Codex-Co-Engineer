import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildProcessBoundaryArgv,
  classifyExactProcessIdentity,
  inspectExactProcessBoundary,
  inspectProcessBoundary,
  launchProcessBoundary,
  PROCESS_IDENTITY_CLASSES,
  probeProcessBoundary,
  ProcessBoundaryError,
  restoreProcessBoundary,
  stopExactProcessBoundary,
  stopProcessBoundary,
} from '../mcp/v3/process-boundary.mjs';
import {
  createBoundaryHarness,
  lifecycleReceipt,
  procStat,
  procStatus,
} from './fixtures/r1-terminal-boundary-lifecycle-fixtures.mjs';

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

test('resets inherited manager environment and execs a closed env -i projection', () => {
  const argv = buildProcessBoundaryArgv({
    unit: 'codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service',
    description: 'codex-co-engineer-task:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    command: '/usr/bin/node',
    args: ['worker.mjs'],
    cwd: '/workspace/repo',
    env: { HOME: '/home/test-user', PATH: '/bin' },
    inherited: {
      HOME: '/home/test-user',
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/tmp/hostile-agent.sock',
      GH_TOKEN: 'ghp_manager-token',
      GIT_SSH: '/tmp/hostile-ssh',
    },
  });
  const unset = argv.find((entry) => String(entry).startsWith('--property=UnsetEnvironment='));
  assert.equal(typeof unset, 'string');
  assert.equal(unset.includes('SSH_AUTH_SOCK'), true);
  assert.equal(unset.includes('GH_TOKEN'), true);
  assert.equal(unset.includes('GIT_SSH'), true);
  assert.equal(unset.includes('HOME'), false);
  assert.equal(unset.includes('PATH'), false);
  assert.equal(argv.includes('--setenv=SSH_AUTH_SOCK=/tmp/hostile-agent.sock'), false);
  assert.equal(argv.includes('SSH_AUTH_SOCK=/tmp/hostile-agent.sock'), false);
  assert.equal(argv.includes('/usr/bin/env'), true);
  assert.equal(argv.includes('-i'), true);
  assert.equal(argv.includes('HOME=/home/test-user'), true);
  assert.equal(argv.includes('PATH=/bin'), true);
});

test('builds a manager-owned systemd service without putting credential values in argv', () => {
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
    '--', '/usr/bin/env', '-i', 'HOME=/home/test-user', '/usr/bin/node', 'worker.mjs', '--provider-capability', 'full',
  ]);
  assert.equal(argv.some((entry) => entry.includes('provider-secret')), false);
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
    readFile: async (file) => {
      if (file.endsWith('/cgroup.events')) return 'populated 1\nfrozen 0\n';
      if (file.endsWith('/cgroup.procs')) return '4242\n';
      const procMatch = /\/proc\/(\d+)\/(stat|cgroup|status)$/u.exec(file);
      if (procMatch?.[2] === 'stat') return procStat({ pid: Number(procMatch[1]), ppid: 1, startTicks: '100' });
      if (procMatch?.[2] === 'status') return procStatus({ pid: Number(procMatch[1]) });
      if (procMatch?.[2] === 'cgroup') {
        return '0::/user.slice/user-1000.slice/user@1000.service/app.slice/codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service\n';
      }
      return 'populated 1\nfrozen 0\n';
    },
    readlink: async () => 'pid:[4026531836]',
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
  assert.equal(calls[0].options.env.MODEL_API_KEY, undefined);
  assert.equal(JSON.stringify(calls[0].options.env).includes('provider-secret'), false);
  assert.equal(calls[0].options.cwd, '/workspace/repo');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(calls[0].args.at(-1), '--full-capability');
  assert.equal(calls[0].args.includes('worker.mjs'), true);
  assert.equal(calls[0].args.includes('--setenv=HOME=/home/test-user'), true);
  assert.equal(calls[0].args.includes('--setenv=PATH=/bin'), true);
  assert.equal(calls[0].args.includes('/usr/bin/env'), true);
  assert.equal(calls[0].args.includes('-i'), true);
  assert.equal(calls[0].args.includes('HOME=/home/test-user'), true);
  assert.equal(calls[0].args.some((entry) => String(entry).includes('provider-secret')), false);
  assert.equal(calls[0].args.includes('--setenv=MODEL_API_KEY=provider-secret'), false);
  assert.equal(value.receipt.boundary, 'systemd-user-service-cgroup');
  assert.equal(value.receipt.unit.endsWith('.service'), true);
  assert.equal(value.child.pid, 4242);
  assert.equal(calls[0].args.includes('--property=StandardOutput=append:/state/task.log'), true);
  assert.equal(calls[0].args.some((entry) => String(entry).includes('credential-handoff-loader.mjs')), true);
  host.readFile = async (file) => {
    if (file.endsWith('/cgroup.events')) return 'populated 0\nfrozen 0\n';
    if (file.endsWith('/cgroup.procs')) return '';
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  host.execFile = async (_command, args) => {
    const unit = args.find((value) => value.startsWith('codex-co-engineer-') && value.endsWith('.service'))
      ?? 'codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service';
    const token = unit.slice('codex-co-engineer-'.length, -'.service'.length);
    return { stdout: [
      `Id=${unit}`,
      `Description=codex-co-engineer-task:${token}`,
      'LoadState=loaded',
      'ActiveState=inactive',
      `ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
      'KillMode=control-group',
      'InvocationID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'MainPID=0',
    ].join('\n') };
  };
  await stopProcessBoundary(value.handle, { adapter: host, timeoutMs: 100 });
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
          `MainPID=${populated ? 4242 : 0}`,
        ].join('\n') };
      }
      actions.push(args);
      if (args[1] === 'kill' && args.at(-2) === '--signal=KILL') {
        populated = false;
        active = 'inactive';
      }
      return { stdout: '' };
    },
    readFile: async (file) => {
      if (file.endsWith('/cgroup.events')) return `populated ${populated ? 1 : 0}\nfrozen 0\n`;
      if (file.endsWith('/cgroup.procs')) return populated ? '4242\n' : '';
      const procMatch = /\/proc\/(\d+)\/(stat|cgroup|status)$/u.exec(file);
      if (!procMatch) return '';
      if (!populated) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (procMatch[2] === 'stat') return procStat({ pid: Number(procMatch[1]), ppid: 1, startTicks: '100' });
      if (procMatch[2] === 'status') return procStatus({ pid: Number(procMatch[1]) });
      return `0::${receipt().control_group}\n`;
    },
    readlink: async () => {
      if (!populated) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return 'pid:[4026531836]';
    },
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

test('exact inspection is inactive_empty only when the unit and cgroup path are both gone', async () => {
  const harness = createBoundaryHarness({ found: false, populated: false, activeState: 'inactive' });
  harness.state.found = false;
  harness.state.populated = false;
  const inspection = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(inspection.state, 'inactive_empty');
  assert.equal(inspection.stop_allowed, false);
});

test('exact inspection is unknown when the unit is gone but the cgroup stays populated', async () => {
  const harness = createBoundaryHarness({ found: false, populated: true });
  harness.state.found = false;
  harness.state.populated = true;
  const inspection = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(inspection.state, 'unknown');
  assert.equal(inspection.stop_allowed, false);
});

test('exact stop uses systemctl --user stop for the verified unit only', async () => {
  const harness = createBoundaryHarness();
  const stopped = await stopExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
    timeoutMs: 100,
  });
  assert.equal(stopped.state, 'inactive_empty');
  assert.equal(stopped.cgroup_empty, true);
  assert.equal(harness.state.stopCalls, 1);
  assert.equal(harness.state.actions.some((args) => args[1] === 'kill'), false);
  const second = await stopExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
    timeoutMs: 100,
  });
  assert.equal(second.idempotent, true);
  assert.equal(harness.state.stopCalls, 1);
});

test('exact inspection does not treat a mismatched generation as this task', async () => {
  const harness = createBoundaryHarness();
  const forged = lifecycleReceipt({ invocation_id: 'ffffffffffffffffffffffffffffffff' });
  const inspection = await inspectExactProcessBoundary(forged, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(inspection.state, 'unknown');
  assert.equal(inspection.identity_matched, false);
  assert.equal(inspection.stop_allowed, false);
});

function identityBoundary(receipt, extras = {}) {
  return {
    expected_cgroup: receipt.control_group,
    expected_unit: receipt.unit,
    expected_invocation_id: receipt.invocation_id,
    expected_description: receipt.description,
    unit_inactive: extras.unit_inactive === true,
    cgroup_empty: extras.cgroup_empty === true,
    observed_unit: extras.observed_unit ?? receipt.unit,
    observed_invocation_id: extras.observed_invocation_id ?? receipt.invocation_id,
    observed_description: extras.observed_description ?? receipt.description,
  };
}

test('exact identity classifier treats matching Z and X as exited only with inactive empty cgroup', () => {
  const receipt = lifecycleReceipt();
  const expected = { pid: 4242, start_ticks: '100', nspid: '4242', ns_inode: '4026531836', cgroup: receipt.control_group };
  for (const state of ['Z', 'X']) {
    const observed = { pid: 4242, start_ticks: '100', nspid: '4242', ns_inode: '4026531836', state, cgroup: receipt.control_group };
    const blocked = classifyExactProcessIdentity({
      expected,
      observed,
      boundary: identityBoundary(receipt, { unit_inactive: false, cgroup_empty: false }),
    });
    assert.equal(blocked.class, 'visibility_unknown');
    assert.equal(blocked.exited, false);
    assert.equal(blocked.cgroup_empty_allowed, false);
    const exited = classifyExactProcessIdentity({
      expected,
      observed,
      boundary: identityBoundary(receipt, { unit_inactive: true, cgroup_empty: true }),
    });
    assert.equal(exited.class, 'exited');
    assert.equal(exited.exited, true);
    assert.equal(exited.live, false);
    assert.equal(exited.cgroup_empty_allowed, true);
    assert.equal(PROCESS_IDENTITY_CLASSES.includes(exited.class), true);
  }
});

test('matching live escaped descendant is containment failure and never empty', () => {
  const receipt = lifecycleReceipt();
  const classified = classifyExactProcessIdentity({
    expected: { pid: 4300, start_ticks: '110', nspid: '4300', cgroup: receipt.control_group },
    observed: {
      pid: 4300,
      start_ticks: '110',
      nspid: '4300',
      state: 'S',
      cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/foreign.service',
    },
    boundary: identityBoundary(receipt, { unit_inactive: true, cgroup_empty: true }),
  });
  assert.equal(classified.class, 'containment_failure_live_outside_cgroup');
  assert.equal(classified.live, true);
  assert.equal(classified.cgroup_empty_allowed, false);
  assert.equal(classified.code, 'cgroup_not_empty');
});

test('PID reuse via different start ticks fails closed', () => {
  const receipt = lifecycleReceipt();
  const classified = classifyExactProcessIdentity({
    expected: { pid: 4242, start_ticks: '100', cgroup: receipt.control_group },
    observed: { pid: 4242, start_ticks: '999', state: 'S', cgroup: receipt.control_group },
    boundary: identityBoundary(receipt, { unit_inactive: true, cgroup_empty: true }),
  });
  assert.equal(classified.class, 'pid_reuse');
  assert.equal(classified.fail_closed, true);
  assert.equal(classified.cgroup_empty_allowed, false);
  assert.equal(classified.code, 'worker_boundary_identity_mismatch');
});

test('namespace mismatch and unreadable proc fail closed', () => {
  const receipt = lifecycleReceipt();
  const mismatch = classifyExactProcessIdentity({
    expected: { pid: 4242, start_ticks: '100', nspid: '4242', ns_inode: '4026531836', cgroup: receipt.control_group },
    observed: {
      pid: 4242,
      start_ticks: '100',
      nspid: '1',
      ns_inode: '4026531836',
      state: 'S',
      cgroup: receipt.control_group,
    },
    boundary: identityBoundary(receipt, { unit_inactive: true, cgroup_empty: true }),
  });
  assert.equal(mismatch.class, 'namespace_mismatch');
  assert.equal(mismatch.fail_closed, true);
  const unread = classifyExactProcessIdentity({
    expected: { pid: 4242, start_ticks: '100', cgroup: receipt.control_group },
    observed: { unreadable: true },
    boundary: identityBoundary(receipt, { unit_inactive: true, cgroup_empty: true }),
  });
  assert.equal(unread.class, 'visibility_unknown');
  assert.equal(unread.fail_closed, true);
  const missingWithoutEmpty = classifyExactProcessIdentity({
    expected: { pid: 4242, start_ticks: '100', cgroup: receipt.control_group },
    observed: { missing: true },
    boundary: identityBoundary(receipt, { unit_inactive: false, cgroup_empty: false }),
  });
  assert.equal(missingWithoutEmpty.fail_closed, true);
  assert.equal(missingWithoutEmpty.exited, false);
});

test('exact inspection refuses inactive_empty for a live escaped remembered descendant', async () => {
  const harness = createBoundaryHarness({
    activeState: 'inactive',
    populated: false,
    procCgroups: { 4300: '/user.slice/user-1000.slice/user@1000.service/app.slice/escaped.service' },
    procTicks: { 4300: '110' },
  });
  const inspection = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
    rememberedIdentities: [{ pid: 4300, start_ticks: '110', cgroup: harness.receipt.control_group }],
  });
  assert.equal(inspection.state, 'unknown');
  assert.equal(inspection.empty, false);
  assert.equal(inspection.stop_allowed, false);
  assert.equal(inspection.code, 'cgroup_not_empty');
  await assert.rejects(
    stopExactProcessBoundary(harness.receipt, {
      adapter: harness.adapter,
      expectedLeader: harness.leader,
      rememberedIdentities: [{ pid: 4300, start_ticks: '110', cgroup: harness.receipt.control_group }],
      timeoutMs: 100,
    }),
    (error) => error.code === 'cgroup_not_empty',
  );
});

test('exact inspection treats matching zombie descendants as exited once the unit is inactive and empty', async () => {
  const harness = createBoundaryHarness({
    activeState: 'inactive',
    populated: false,
    procStates: { 4300: 'Z' },
    procPresentWhenEmpty: { 4300: true },
  });
  const inspection = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
    rememberedIdentities: [{ pid: 4300, start_ticks: '110', nspid: '4300', cgroup: harness.receipt.control_group }],
  });
  assert.equal(inspection.state, 'inactive_empty');
  assert.equal(inspection.empty, true);
});

test('forged unit identity cannot stop or clean another boundary', async () => {
  const harness = createBoundaryHarness();
  const forged = lifecycleReceipt({ token: 'ffffffffffffffffffffffffffffffff', invocation_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });
  const inspection = await inspectExactProcessBoundary(forged, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(inspection.state, 'unknown');
  assert.equal(inspection.identity_matched, false);
  await assert.rejects(
    stopExactProcessBoundary(forged, { adapter: harness.adapter, expectedLeader: harness.leader, timeoutMs: 100 }),
    (error) => error.code === 'worker_boundary_identity_mismatch',
  );
  assert.equal(harness.state.stopCalls, 0);
});

test('kill(0) success is never treated as live proof by the classifier', () => {
  const receipt = lifecycleReceipt();
  const zombie = classifyExactProcessIdentity({
    expected: { pid: 7, start_ticks: '1', cgroup: receipt.control_group },
    observed: { pid: 7, start_ticks: '1', state: 'Z', cgroup: receipt.control_group },
    boundary: identityBoundary(receipt, { unit_inactive: true, cgroup_empty: true }),
  });
  assert.equal(zombie.class, 'exited');
  assert.equal(zombie.live, false);
});
