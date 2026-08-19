import assert from 'node:assert/strict';
import test from 'node:test';

import { createWriterWorkspace } from '../mcp/v3/supervisor.mjs';

test('writer workspace uses the worktree-bootstrap receipt verbatim', async () => {
  const calls = [];
  const result = await createWriterWorkspace({
    taskId: 'parallel-one',
    repo: '/repo',
    execute: async (command, args, options) => {
      const call = [command, args, options];
      if (command === 'git') return { stdout: 'feature\n' };
      const response = { stdout: JSON.stringify({
        task: 'parallel-one',
        branch: 'codex/parallel-one',
        start_sha: 'a'.repeat(40),
        worktree_path: '/worktrees/parallel-one',
        status: 'ready',
      }) };
      calls.push(call);
      return response;
    },
  });
  assert.deepEqual(calls[0][0], 'worktree-bootstrap');
  assert.deepEqual(calls[0][1], ['create', 'parallel-one', '--repo', '/repo', '--base', 'feature']);
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
