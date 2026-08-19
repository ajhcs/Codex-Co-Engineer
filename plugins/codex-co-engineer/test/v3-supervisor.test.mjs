import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cancelTask,
  cleanupManagedWorkspace,
  createWriterWorkspace,
  launchWorker,
  submitTask,
  supervisorStatus,
  taskStatus,
} from '../mcp/v3/supervisor.mjs';
import { appendTaskEvent, createLaunchReservation, createTask, readRuntimeRecord, readTask, updateTask } from '../mcp/v3/task-store.mjs';

const SHA = 'a'.repeat(40);
const readyBoundary = async () => ({
  ready: true,
  status: 'prerequisites_ready',
  provider_started: false,
  boundary: 'systemd-user-service-cgroup',
});

test('writer workspace parses noisy pretty JSON and requests a bounded large buffer', async () => {
  const calls = [];
  const result = await createWriterWorkspace({
    taskId: 'parallel-one',
    repo: '/repo',
    execute: async (command, args, options) => {
      if (command === 'git') return { stdout: 'feature\n' };
      calls.push([command, args, options]);
      return { stdout: `npm ci: installing dependencies\n${JSON.stringify({
        task: 'parallel-one',
        branch: 'codex/parallel-one',
        start_sha: SHA,
        worktree_path: '/worktrees/parallel-one',
        status: 'ready',
      }, null, 2)}\n` };
    },
  });
  assert.equal(calls[0][0], 'worktree-bootstrap');
  assert.deepEqual(calls[0][1], ['create', 'parallel-one', '--repo', '/repo', '--base', 'feature']);
  assert.ok(calls[0][2].maxBuffer >= 16 * 1024 * 1024);
  assert.equal(result.worktree_path, '/worktrees/parallel-one');
  assert.equal(result.branch, 'codex/parallel-one');
});

test('invalid worktree receipt fails before dispatch', async () => {
  const execute = async (command) => command === 'git' ? { stdout: 'feature\n' } : { stdout: '{}' };
  await assert.rejects(
    createWriterWorkspace({ taskId: 'bad', repo: '/repo', execute }),
    (error) => error.code === 'worktree_create_failed',
  );
});

test('managed cleanup fails closed when lock inspection is not parseable', async () => {
  const result = await cleanupManagedWorkspace({
    workspace: { task: 'bad-lock', worktree_path: '/worktrees/bad-lock' },
    execute: async () => ({ stdout: 'worktree-bootstrap: warning\nnot-json\n' }),
  });
  assert.equal(result.state, 'cleanup_failed');
  assert.equal(result.cleaned, false);
  assert.equal(result.error.code, 'worktree_cleanup_failed');
});

test('direct local mode uses the caller worktree and does not invoke bootstrap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-direct-'));
  const repo = path.join(root, 'repo');
  const calls = [];
  const launches = [];
  try {
    await mkdir(repo);
    const execute = async (command, args) => {
      calls.push([command, args]);
      if (args.includes('--show-toplevel')) return { stdout: `${repo}\n` };
      if (args.includes('--show-current')) return { stdout: 'feature\n' };
      if (args.includes('HEAD')) return { stdout: `${SHA}\n` };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    const value = await submitTask({
      task_id: 'direct-one',
      provider: 'grok',
      role: 'implement',
      repo,
      prompt: 'make the direct change',
      workspace_mode: 'direct',
    }, {
      root,
      env: {},
      execute,
      probeBoundary: readyBoundary,
      launch: async (request) => {
        launches.push(request);
        return { pid: 9001, process_group: 9001, process_start_ticks: '1' };
      },
    });
    assert.equal(value.task.workspace_mode, 'direct');
    assert.equal(value.task.workspace_kind, 'direct');
    assert.equal(value.task.branch, 'feature');
    assert.equal(value.task.start_sha, SHA);
    assert.equal(launches[0].writer, false);
    assert.equal(calls.some(([command]) => command === 'worktree-bootstrap'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local create_pr and starting_ref are rejected before workspace creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-input-'));
  let createCalls = 0;
  const createWorkspace = async () => {
    createCalls += 1;
    throw new Error('workspace should not be created');
  };
  try {
    await assert.rejects(
      submitTask({ task_id: 'local-pr', provider: 'grok', repo: '/repo', prompt: 'review', create_pr: true }, {
        root, createWorkspace,
      }),
      (error) => error.code === 'invalid_create_pr',
    );
    await assert.rejects(
      submitTask({ task_id: 'local-ref', provider: 'cursor-local', repo: '/repo', prompt: 'review', starting_ref: SHA }, {
        root, createWorkspace,
      }),
      (error) => error.code === 'invalid_starting_ref',
    );
    assert.equal(createCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local boundary failure happens before workspace, task, or prompt creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-preflight-'));
  let createCalls = 0;
  try {
    await assert.rejects(
      submitTask({ task_id: 'no-boundary', provider: 'grok', repo: '/repo', prompt: 'do not persist' }, {
        root,
        env: {},
        probeBoundary: async () => ({
          ready: false,
          status: 'unavailable',
          reason: 'systemd_user_manager_unavailable',
          provider_started: false,
        }),
        createWorkspace: async () => { createCalls += 1; },
      }),
      (error) => error.code === 'systemd_user_manager_unavailable'
        && error.message === 'The local systemd user manager is unavailable.',
    );
    assert.equal(createCalls, 0);
    await assert.rejects(readTask(root, 'no-boundary'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status makes boundary health explicit and fails only local providers closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-status-'));
  const providerReadiness = {
    grok: { installed: true, ready: true, transport: 'acp' },
    'cursor-local': { installed: true, ready: true, transport: 'acp' },
    dsh: { installed: true, ready: true, transport: 'acpx' },
    'cursor-cloud': { installed: true, ready: true, transport: 'cursor-sdk' },
  };
  try {
    const status = await supervisorStatus(root, {
      probeBoundary: async () => ({
        ready: false,
        status: 'unavailable',
        reason: 'systemd_user_manager_unavailable',
        provider_started: false,
      }),
      readProviderReadiness: async () => structuredClone(providerReadiness),
    });
    assert.equal(status.healthy, false);
    assert.equal(status.local_boundary.reason, 'systemd_user_manager_unavailable');
    for (const provider of ['grok', 'cursor-local', 'dsh']) {
      assert.equal(status.readiness[provider].ready, false);
      assert.equal(status.readiness[provider].reason, 'systemd_user_manager_unavailable');
    }
    assert.equal(status.readiness['cursor-cloud'].ready, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed launch failure marks the task failed and cleans an abandoned writer lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-failure-'));
  const calls = [];
  const workspace = {
    task: 'launch-fail',
    branch: 'codex/launch-fail',
    start_sha: SHA,
    worktree_path: '/worktrees/launch-fail',
    status: 'ready',
  };
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'lock' && args[1] === 'inspect') {
      return { stdout: JSON.stringify({
        task: 'launch-fail',
        lock_id: 'dead-lock',
        health: { state: 'abandoned' },
      }) };
    }
    return { stdout: '' };
  };
  try {
    await assert.rejects(
      submitTask({ task_id: 'launch-fail', provider: 'grok', repo: '/repo', prompt: 'implement' }, {
        root,
        env: {},
        execute,
        probeBoundary: readyBoundary,
        createWorkspace: async () => workspace,
        launch: async () => { throw Object.assign(new Error('worker failed at /home/test-user/private?token=secret'), { code: 'worker_failed' }); },
      }),
      (error) => {
        assert.equal(error.code, 'worker_failed');
        assert.equal(error.message, 'The worker failed to start.');
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    const task = (await readTask(root, 'launch-fail')).task;
    assert.equal(task.status, 'failed');
    assert.equal(task.error.code, 'worker_failed');
    assert.doesNotMatch(task.error.message, /private|secret/iu);
    assert.deepEqual(calls.at(-1), [
      'worktree-bootstrap',
      ['lock', 'clean', 'launch-fail', '--repo', '/worktrees/launch-fail', '--policy', 'dead-local', '--lock-id', 'dead-lock'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local worker launch persists its verified cgroup boundary before provider dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-boundary-'));
  const repo = path.join(root, 'repo');
  const receipt = {
    version: 1,
    boundary: 'systemd-user-scope-cgroup',
    unit: 'codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope',
    description: 'codex-co-engineer-task:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    invocation_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    control_group: '/user.slice/user-1000.slice/user@1000.service/app.slice/codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope',
  };
  try {
    await mkdir(repo);
    await createTask({
      root,
      prompt: 'bounded task',
      record: { id: 'bounded-one', status: 'accepted', provider: 'grok', cwd: repo },
    });
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    let launched;
    await launchWorker({
      root,
      taskId: 'bounded-one',
      cwd: repo,
      writer: false,
      provider: 'grok',
      env: {},
      launchBoundary: async (request) => {
        launched = request;
        return { child, handle: {}, receipt };
      },
    });
    const runtime = await readRuntimeRecord(root, 'bounded-one');
    assert.deepEqual(runtime.process_boundary, receipt);
    assert.equal(runtime.process_group, null);
    assert.equal(launched.command, process.execPath);
    assert.equal(launched.taskId, 'bounded-one');
    assert.equal(launched.cwd, repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('launch reservation keeps status from declaring a missing runtime during startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-launch-grace-'));
  const repo = path.join(root, 'repo');
  try {
    await mkdir(repo);
    const reservation = createLaunchReservation({ now: Date.now() });
    await createTask({
      root,
      prompt: 'launch grace',
      record: { id: 'launch-grace', status: 'accepted', provider: 'grok', cwd: repo, launch_reservation: reservation },
    });
    const during = await taskStatus(root, 'launch-grace');
    assert.equal(during.task.status, 'accepted');
    assert.equal(during.task.launch_reservation.token, reservation.token);

    await updateTask(root, 'launch-grace', {
      launch_reservation: { ...reservation, expires_at: new Date(Date.now() - 1).toISOString() },
    });
    const expired = await taskStatus(root, 'launch-grace');
    assert.equal(expired.task.status, 'transport_lost');
    assert.equal(expired.task.launch_reservation, null);
    assert.equal(await readRuntimeRecord(root, 'launch-grace'), null);
    assert.equal(expired.progress.wait_reason, 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task and status project live last_event from the event log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-progress-'));
  try {
    await createTask({
      root,
      prompt: 'keep this prompt private',
      record: {
        id: 'live-status',
        status: 'running',
        provider: 'grok',
        agent_argv: ['grok', 'agent', '--always-approve', 'stdio'],
      },
    });
    await appendTaskEvent(root, 'live-status', {
      type: 'provider',
      event: { type: 'text_delta', text: 'reviewing files', pid: 77 },
    });
    const value = await taskStatus(root, 'live-status');
    assert.equal(value.task.last_event.text, 'reviewing files');
    assert.equal(value.task.last_event.pid, undefined);
    assert.equal(value.progress.last_event.text, 'reviewing files');
    assert.equal(value.progress.wait_reason, 'current');
    assert.equal((await readTask(root, 'live-status')).task.last_event, undefined);
    const status = await supervisorStatus(root, {
      probeBoundary: readyBoundary,
      readProviderReadiness: async () => ({
        grok: { installed: true, ready: true, transport: 'acp' },
        'cursor-local': { installed: true, ready: true, transport: 'acp' },
        dsh: { installed: true, ready: true, transport: 'acpx' },
        'cursor-cloud': { installed: true, ready: true, transport: 'cursor-sdk' },
      }),
    });
    assert.equal(status.tasks[0].last_event.text, 'reviewing files');
    assert.doesNotMatch(JSON.stringify(value.progress), /keep this prompt private/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task wait returns when a later event arrives or the task is cancelled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-wait-'));
  try {
    await createTask({
      root,
      prompt: 'wait for cancel',
      record: { id: 'wait-cancel', status: 'running', provider: 'grok', cwd: root },
    });
    const baseline = await taskStatus(root, 'wait-cancel');
    const pending = taskStatus(root, 'wait-cancel', {
      cursor: baseline.progress.event_cursor,
      wait_ms: 1_000,
    });
    const cancellation = new Promise((resolve, reject) => {
      setTimeout(() => {
        cancelTask(root, 'wait-cancel', {
          stopBoundary: async () => {},
        }).then(resolve, reject);
      }, 20);
    });
    const [value] = await Promise.all([pending, cancellation]);
    assert.ok(['terminal', 'progress', 'attention'].includes(value.progress.wait_reason));
    assert.ok(['cancelling', 'cancelled', 'transport_lost'].includes(value.task.status));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a transport-lost task cannot start a fresh local worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-no-replay-'));
  const repo = path.join(root, 'repo');
  try {
    await mkdir(repo);
    await createTask({
      root,
      prompt: 'do not replay',
      record: { id: 'no-replay', status: 'transport_lost', provider: 'grok', cwd: repo },
    });
    await assert.rejects(
      launchWorker({
        root,
        taskId: 'no-replay',
        cwd: repo,
        writer: false,
        provider: 'grok',
        env: {},
        launchBoundary: async () => { throw new Error('must not launch'); },
      }),
      (error) => error.code === 'cancelled',
    );
    assert.equal((await readTask(root, 'no-replay')).task.status, 'transport_lost');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('boundary rollback failure preserves a recoverable runtime and transport-lost state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-supervisor-boundary-recovery-'));
  const repo = path.join(root, 'repo');
  const receipt = {
    version: 1,
    boundary: 'systemd-user-scope-cgroup',
    unit: 'codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope',
    description: 'codex-co-engineer-task:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    invocation_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    control_group: '/user.slice/user-1000.slice/user@1000.service/app.slice/codex-co-engineer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope',
  };
  try {
    await mkdir(repo);
    await createTask({
      root,
      prompt: 'persist boundary recovery',
      record: { id: 'boundary-recovery', status: 'accepted', provider: 'grok', cwd: repo },
    });
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    let stopCalls = 0;
    await assert.rejects(
      launchWorker({
        root,
        taskId: 'boundary-recovery',
        cwd: repo,
        writer: false,
        provider: 'grok',
        env: {},
        launchBoundary: async () => ({ child, handle: {}, receipt }),
        writeRuntime: async () => { throw Object.assign(new Error('runtime store unavailable'), { code: 'runtime_store_failed' }); },
        stopBoundary: async () => {
          stopCalls += 1;
          throw Object.assign(new Error('cgroup still populated'), { code: 'cgroup_not_empty' });
        },
      }),
      (error) => error.code === 'worker_boundary_uncertain',
    );
    const task = (await readTask(root, 'boundary-recovery')).task;
    assert.equal(stopCalls, 1);
    assert.equal(task.status, 'transport_lost');
    assert.equal(task.error.code, 'worker_boundary_uncertain');
    assert.deepEqual(task.runtime_recovery.process_boundary, receipt);
    assert.equal(task.runtime_recovery.process_group, null);
    let recovered;
    const cancelled = await cancelTask(root, 'boundary-recovery', {
      stopBoundary: async (runtime) => { recovered = runtime; },
    });
    assert.deepEqual(recovered.process_boundary, receipt);
    assert.equal(cancelled.status, 'cancelled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
