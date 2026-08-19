import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { cancelCursorCloudTask, runCursorCloudTask } from '../mcp/v3/cursor-cloud-worker.mjs';
import { createTask, readTask } from '../mcp/v3/task-store.mjs';

const run = promisify(execFile);

test('uses stable Cursor agent/run idempotency and records returned PR', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cloud-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createTask({ root, prompt: 'implement it', record: {
    id: 'cloud-one', status: 'accepted', provider: 'cursor-cloud', role: 'implement', cwd: repo, create_pr: true,
  } });
  const observed = {};
  const sdk = { Agent: { archive: async (id) => { observed.archived = id; }, create: async (options) => {
    observed.create = options;
    return {
      send: async (prompt, options2) => {
        observed.send = { prompt, options: options2 };
        return { id: 'run-one', wait: async () => ({
          id: 'run-one', status: 'finished', result: 'done',
          git: { branches: [{ repoUrl: 'https://github.com/example/repo.git', branch: 'cursor/work', prUrl: 'https://github.com/example/repo/pull/1' }] },
        }) };
      },
      close() {},
    };
  } } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-one', sdk, apiKey: 'test-key' });
  assert.match(observed.create.agentId, /^bc-/u);
  assert.equal(observed.create.idempotencyKey, 'cloud-one:create');
  assert.equal(observed.create.cloud.autoCreatePR, true);
  assert.equal(observed.send.options.idempotencyKey, 'cloud-one:run:1');
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.pr_url, 'https://github.com/example/repo/pull/1');
  assert.equal(observed.archived, observed.create.agentId);
});

test('rejects an origin URL containing embedded credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-url-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://token@example.test/repo.git']);
  await createTask({ root, prompt: 'review', record: {
    id: 'cloud-url', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let created = false;
  const sdk = { Agent: { create: async () => { created = true; } } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-url', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cloud_repo_credentials',
  );
  assert.equal(created, false);
});

test('cancels the provider run and archives the cloud agent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-'));
  await createTask({ root, prompt: 'stop it', record: {
    id: 'cloud-cancel', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', provider_run_id: 'run-one', prompt_dispatched: true,
  } });
  const calls = [];
  let status = 'running';
  const sdk = { Agent: {
    listRuns: async () => ({ items: [{ id: 'run-one', status: 'running' }] }),
    cancelRun: async (runId, options) => { calls.push(['cancel', runId, options.agentId]); status = 'cancelled'; },
    getRun: async () => ({ id: 'run-one', status }),
    archive: async (agentId) => calls.push(['archive', agentId]),
  } };
  const terminal = await cancelCursorCloudTask({ root, taskId: 'cloud-cancel', sdk, apiKey: 'test-key' });
  assert.deepEqual(calls, [['cancel', 'run-one', 'bc-agent'], ['archive', 'bc-agent']]);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.provider_agent_archived, true);
});

test('cancels a discovered cloud run when the local receipt lacks its run id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-recover-cancel-'));
  await createTask({ root, prompt: 'stop it', record: {
    id: 'cloud-recover', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', prompt_dispatched: true,
  } });
  const calls = [];
  let status = 'running';
  const sdk = { Agent: {
    listRuns: async () => ({ items: [{ id: 'run-discovered', status: 'running' }] }),
    cancelRun: async (runId) => { calls.push(['cancel', runId]); status = 'cancelled'; },
    getRun: async () => ({ id: 'run-discovered', status }),
    archive: async (agentId) => calls.push(['archive', agentId]),
  } };
  const terminal = await cancelCursorCloudTask({ root, taskId: 'cloud-recover', sdk, apiKey: 'test-key' });
  assert.deepEqual(calls, [['cancel', 'run-discovered'], ['archive', 'bc-agent']]);
  assert.equal(terminal.status, 'cancelled');
});

test('times out, cancels, and archives a hanging cloud run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-timeout-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createTask({ root, prompt: 'hang', record: {
    id: 'cloud-timeout', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo, timeout_ms: 20,
  } });
  let cancelled = 0;
  let archived = 0;
  let finishRun;
  const finished = new Promise((resolve) => { finishRun = resolve; });
  const cloudRun = {
    id: 'run-hanging', status: 'running',
    wait: async () => finished,
    cancel: async () => {
      cancelled += 1;
      cloudRun.status = 'cancelled';
      finishRun({ id: 'run-hanging', status: 'cancelled', git: { branches: [] } });
    },
  };
  const sdk = { Agent: {
    create: async () => ({ send: async () => cloudRun, close() {} }),
    archive: async () => { archived += 1; },
  } };
  await assert.rejects(runCursorCloudTask({ root, taskId: 'cloud-timeout', sdk, apiKey: 'test-key' }), (error) => error.code === 'timeout');
  const terminal = (await readTask(root, 'cloud-timeout')).task;
  assert.equal(terminal.status, 'timeout');
  assert.ok(cancelled >= 1);
  assert.equal(archived, 1);
});
