import assert from 'node:assert/strict';
import test from 'node:test';

import { createWriterWorkspace } from '../mcp/v3/supervisor.mjs';

test('writer workspace uses the worktree-bootstrap receipt verbatim', async () => {
  const calls = [];
  const result = await createWriterWorkspace({
    taskId: 'parallel-one',
    repo: '/repo',
    execute: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({
        task: 'parallel-one',
        branch: 'codex/parallel-one',
        start_sha: 'a'.repeat(40),
        worktree_path: '/worktrees/parallel-one',
        status: 'ready',
      }) };
    },
  });
  assert.deepEqual(calls[0][0], 'worktree-bootstrap');
  assert.deepEqual(calls[0][1], ['create', 'parallel-one', '--repo', '/repo']);
  assert.equal(result.worktree_path, '/worktrees/parallel-one');
  assert.equal(result.branch, 'codex/parallel-one');
});

test('invalid worktree receipt fails before dispatch', async () => {
  await assert.rejects(
    createWriterWorkspace({ taskId: 'bad', repo: '/repo', execute: async () => ({ stdout: '{}' }) }),
    (error) => error.code === 'worktree_create_failed',
  );
});

