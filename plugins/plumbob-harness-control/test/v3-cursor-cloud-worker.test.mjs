import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { cancelCursorCloudTask, reconcileCursorCloudTask, runCursorCloudTask } from '../mcp/v3/cursor-cloud-worker.mjs';
import { createTask, readTask, updateTask } from '../mcp/v3/task-store.mjs';

const run = promisify(execFile);

test('uses stable Cursor agent/run idempotency and records returned PR', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cloud-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await run('git', ['-C', repo, '-c', 'user.name=Co-Engineer Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  const { stdout: head } = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
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
  assert.equal(observed.create.cloud.repos[0].startingRef, head.trim());
  assert.equal(observed.send.options.idempotencyKey, 'cloud-one:run:1');
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.pr_url, 'https://github.com/example/repo/pull/1');
  assert.equal(terminal.provider_agent_archived, true);
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

test('rejects repository URLs with query, fragment, or non-http origin data', async () => {
  for (const [suffix, expectedCode] of [
    ['?token=secret', 'cursor_cloud_repo_credentials'],
    ['#fragment', 'cursor_cloud_repo_credentials'],
    ['ssh://git@example.test/repo.git', 'cursor_cloud_repo_credentials'],
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-url-shape-'));
    const repo = path.join(root, 'repo');
    await run('git', ['init', '-b', 'main', repo]);
    await run('git', ['-C', repo, 'remote', 'add', 'origin', suffix.includes('://') ? suffix : `https://example.test/repo.git${suffix}`]);
    await createTask({ root, prompt: 'review', record: {
      id: `cloud-url-${suffix.replace(/[^a-z]+/giu, '-')}`, status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    } });
    await assert.rejects(
      runCursorCloudTask({ root, taskId: `cloud-url-${suffix.replace(/[^a-z]+/giu, '-')}`, sdk: { Agent: {} }, apiKey: 'test-key' }),
      (error) => error.code === expectedCode,
    );
  }
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

test('refuses to cancel an arbitrary cloud run when the receipt lacks its run id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-recover-cancel-'));
  await createTask({ root, prompt: 'stop it', record: {
    id: 'cloud-recover', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', prompt_dispatched: true,
  } });
  const calls = [];
  const sdk = { Agent: {
    listRuns: async () => ({ items: [{ id: 'run-discovered', status: 'running' }] }),
    cancelRun: async (runId) => { calls.push(['cancel', runId]); },
    archive: async (agentId) => calls.push(['archive', agentId]),
  } };
  await assert.rejects(
    cancelCursorCloudTask({ root, taskId: 'cloud-recover', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cancel_unconfirmed',
  );
  assert.deepEqual(calls, []);
  assert.equal((await readTask(root, 'cloud-recover')).task.status, 'transport_lost');
});

test('times out, cancels, and archives a hanging cloud run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-timeout-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createTask({ root, prompt: 'hang', record: {
    id: 'cloud-timeout', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo, timeout_ms: 200,
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

test('does not claim cancellation succeeded when provider state cannot be checked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-uncertain-'));
  await createTask({ root, prompt: 'stop it', record: {
    id: 'cloud-cancel-uncertain', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', provider_run_id: 'run-one', prompt_dispatched: true,
  } });
  let archived = 0;
  const sdk = { Agent: {
    listRuns: async () => { throw Object.assign(new Error('network down'), { code: 'network_error' }); },
    getRun: async () => { throw Object.assign(new Error('network down'), { code: 'network_error' }); },
    archive: async () => { archived += 1; },
  } };
  await assert.rejects(
    cancelCursorCloudTask({ root, taskId: 'cloud-cancel-uncertain', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cancel_unconfirmed',
  );
  assert.equal(archived, 0);
  assert.equal((await readTask(root, 'cloud-cancel-uncertain')).task.status, 'transport_lost');
});

test('keeps cancellation terminal while reporting a failed archive truthfully', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-archive-'));
  await createTask({ root, prompt: 'stop it', record: {
    id: 'cloud-cancel-archive', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', provider_run_id: 'run-one', prompt_dispatched: true,
  } });
  let status = 'running';
  const sdk = { Agent: {
    listRuns: async () => ({ items: [{ id: 'run-one', status: 'running' }] }),
    cancelRun: async () => { status = 'cancelled'; },
    getRun: async () => ({ id: 'run-one', status }),
    archive: async () => { throw Object.assign(new Error('archive unavailable'), { code: 'network_error' }); },
  } };
  const terminal = await cancelCursorCloudTask({ root, taskId: 'cloud-cancel-archive', sdk, apiKey: 'test-key' });
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.provider_agent_archived, false);
});

test('does not recover an arbitrary cloud run after an uncertain dispatch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-dispatch-uncertain-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createTask({ root, prompt: 'review', record: {
    id: 'cloud-dispatch-uncertain', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let archived = 0;
  const sdk = { Agent: {
    create: async () => ({
      send: async () => { throw Object.assign(new Error('request lost'), { code: 'network_error', isRetryable: true }); },
      close() {},
    }),
    listRuns: async () => ({ items: [
      { id: 'old-run', requestId: 'other-key', status: 'finished' },
      { id: 'new-run', requestId: 'unrelated-key', status: 'running' },
    ] }),
    archive: async () => { archived += 1; },
  } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-dispatch-uncertain', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cloud_dispatch_uncertain',
  );
  const terminal = (await readTask(root, 'cloud-dispatch-uncertain')).task;
  assert.equal(terminal.status, 'transport_lost');
  assert.equal(terminal.finished_at, undefined);
  assert.equal(archived, 0);
});

test('requires an immutable commit starting reference for implementation tasks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-start-ref-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await run('git', ['-C', repo, '-c', 'user.name=Co-Engineer Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  await createTask({ root, prompt: 'implement', record: {
    id: 'cloud-start-ref', status: 'accepted', provider: 'cursor-cloud', role: 'implement', cwd: repo, starting_ref: 'main',
  } });
  let created = false;
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-start-ref', sdk: { Agent: { create: async () => { created = true; } } }, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cloud_start_ref_invalid',
  );
  assert.equal(created, false);
});

test('treats a non-retryable dispatch rejection as a failed task, not an uncertain remote run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-dispatch-rejected-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createTask({ root, prompt: 'review', record: {
    id: 'cloud-dispatch-rejected', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const sdk = { Agent: {
    create: async () => ({
      send: async () => { throw Object.assign(new Error('invalid prompt'), { code: 'invalid_argument', isRetryable: false }); },
      close() {},
    }),
  } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-dispatch-rejected', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'invalid_argument',
  );
  assert.equal((await readTask(root, 'cloud-dispatch-rejected')).task.status, 'failed');
});

test('records a truthful archive flag when terminal cleanup fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-archive-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createTask({ root, prompt: 'review', record: {
    id: 'cloud-archive-fails', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const sdk = { Agent: {
    create: async () => ({
      send: async () => ({ id: 'run-finished', wait: async () => ({ id: 'run-finished', status: 'finished', result: 'done', git: { branches: [] } }) }),
      close() {},
    }),
    archive: async () => { throw Object.assign(new Error('archive unavailable'), { code: 'network_error' }); },
  } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-archive-fails', sdk, apiKey: 'test-key' });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.provider_agent_archived, false);
});

test('reconciliation fails closed without an exact recorded run identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-reconcile-identity-'));
  await createTask({ root, prompt: 'review', record: {
    id: 'cloud-reconcile-identity', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', prompt_dispatched: true,
  } });
  let listed = 0;
  let lookedUp = 0;
  const task = await reconcileCursorCloudTask({
    root,
    taskId: 'cloud-reconcile-identity',
    sdk: { Agent: {
      listRuns: async () => { listed += 1; return { items: [{ id: 'arbitrary', status: 'finished' }] }; },
      getRun: async () => { lookedUp += 1; return { id: 'arbitrary', status: 'finished' }; },
    } },
    apiKey: 'test-key',
  });
  assert.equal(task.status, 'transport_lost');
  assert.equal(task.error.code, 'cursor_run_identity_missing');
  assert.equal(listed, 0);
  assert.equal(lookedUp, 0);
});

test('reconciliation records a truthful archive result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-reconcile-archive-'));
  await createTask({ root, prompt: 'review', record: {
    id: 'cloud-reconcile-archive', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', provider_run_id: 'run-finished', prompt_dispatched: true,
  } });
  const task = await reconcileCursorCloudTask({
    root,
    taskId: 'cloud-reconcile-archive',
    sdk: { Agent: {
      getRun: async () => ({ id: 'run-finished', status: 'finished', wait: async () => ({
        id: 'run-finished', status: 'finished', result: 'done', git: { branches: [] },
      }) }),
      archive: async () => { throw Object.assign(new Error('archive unavailable'), { code: 'network_error' }); },
    } },
    apiKey: 'test-key',
  });
  assert.equal(task.status, 'completed');
  assert.equal(task.provider_agent_archived, false);
});

test('does not dispatch after cancellation wins the provider-agent registration race', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-race-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createTask({ root, prompt: 'review', record: {
    id: 'cloud-race', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let sent = false;
  const sdk = { Agent: {
    create: async () => {
      await updateTask(root, 'cloud-race', { status: 'cancelling' });
      return { send: async () => { sent = true; }, close() {} };
    },
  } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-race', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cancelled',
  );
  assert.equal(sent, false);
  assert.equal((await readTask(root, 'cloud-race')).task.status, 'cancelled');
});
