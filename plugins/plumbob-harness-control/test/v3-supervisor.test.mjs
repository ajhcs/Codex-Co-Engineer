import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWriterWorkspace, launchWorker, submitTask } from '../mcp/v3/supervisor.mjs';
import { createTask, readRuntimeRecord, readTask } from '../mcp/v3/task-store.mjs';

const SHA = 'a'.repeat(40);

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
        createWorkspace: async () => workspace,
        launch: async () => { throw Object.assign(new Error('worker failed'), { code: 'worker_failed' }); },
      }),
      (error) => error.code === 'worker_failed',
    );
    const task = (await readTask(root, 'launch-fail')).task;
    assert.equal(task.status, 'failed');
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
