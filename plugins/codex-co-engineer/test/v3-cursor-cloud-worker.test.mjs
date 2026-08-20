import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { cancelCursorCloudTask, reconcileCursorCloudTask, runCursorCloudTask } from '../mcp/v3/cursor-cloud-worker.mjs';
import { extendTaskDeadline } from '../mcp/v3/supervisor.mjs';
import { createTask, readTask, updateTask } from '../mcp/v3/task-store.mjs';

async function createCloudTask({ root, prompt, record }) {
  return createTask({
    root,
    prompt,
    record: {
      timeout_ms: 30_000,
      ...record,
    },
  });
}

const run = promisify(execFile);

async function commitRepo(repo) {
  await run('git', ['-C', repo, '-c', 'user.name=Co-Engineer Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
}

async function createCloudRepo(root) {
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  return repo;
}

test('uses stable Cursor agent/run idempotency and records returned PR', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cloud-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await run('git', ['-C', repo, '-c', 'user.name=Co-Engineer Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  const { stdout: head } = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
  await createCloudTask({ root, prompt: 'implement it', record: {
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

test('uses the configured origin instead of an insteadOf credential rewrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-config-'));
  const repo = await createCloudRepo(root);
  await run('git', [
    '-C', repo, 'config',
    'url.https://x-access-token:ghs_testtoken12345678@github.com/.insteadOf',
    'https://github.com/',
  ]);
  await createCloudTask({ root, prompt: 'implement it', record: {
    id: 'cloud-origin-config', status: 'accepted', provider: 'cursor-cloud', role: 'implement', cwd: repo,
  } });
  const sdk = { Agent: { archive: async () => {}, create: async () => ({
    send: async () => ({ id: 'run-origin', wait: async () => ({ id: 'run-origin', status: 'finished', result: 'done' }) }),
    close() {},
  }) } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-origin-config', sdk, apiKey: 'test-key' });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.provider_repo_url, 'https://github.com/example/repo.git');
  assert.doesNotMatch(JSON.stringify(terminal), /ghs_testtoken|x-access-token/u);
});

test('rejects an initial run with a mismatched request identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-request-mismatch-'));
  const repo = await createCloudRepo(root);
  await createCloudTask({ root, prompt: 'reject the wrong run', record: {
    id: 'cloud-request-mismatch', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let providerStatus = 'running';
  let archived = 0;
  const sdk = { Agent: {
    create: async () => ({
      send: async () => ({
        id: 'run-request-mismatch', agentId: 'bc-request-mismatch', requestId: 'wrong-request',
        wait: async () => ({ id: 'run-request-mismatch', status: 'finished', git: { branches: [] } }),
        cancel: async () => { providerStatus = 'cancelled'; },
      }),
      close() {},
    }),
    getRun: async (runId, options) => ({ id: runId, agentId: options.agentId, status: providerStatus }),
    archive: async () => { archived += 1; },
  } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-request-mismatch', sdk, apiKey: 'cursor-secret' }),
    (error) => error.code === 'cursor_run_identity_mismatch',
  );
  const task = (await readTask(root, 'cloud-request-mismatch')).task;
  assert.equal(task.status, 'failed');
  assert.equal(task.provider_run_id, undefined);
  assert.equal(archived, 1);
});

test('pins review tasks to the exact local HEAD and rejects mutable refs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-review-sha-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  const { stdout: head } = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
  await createCloudTask({ root, prompt: 'review it', record: {
    id: 'cloud-review-sha', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const observed = {};
  const sdk = { Agent: {
    create: async (options) => {
      observed.options = options;
      return { send: async () => ({ id: 'run-review', wait: async () => ({ id: 'run-review', status: 'finished', git: { branches: [] } }) }), close() {} };
    },
    archive: async () => {},
  } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-review-sha', sdk, apiKey: 'test-key' });
  assert.equal(observed.options.mode, 'plan');
  assert.equal(observed.options.cloud.repos[0].startingRef, head.trim());
  assert.equal(terminal.status, 'completed');

  const mutableRoot = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-review-ref-'));
  const mutableRepo = path.join(mutableRoot, 'repo');
  await run('git', ['init', '-b', 'main', mutableRepo]);
  await commitRepo(mutableRepo);
  await run('git', ['-C', mutableRepo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root: mutableRoot, prompt: 'review it', record: {
    id: 'cloud-review-ref', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: mutableRepo, starting_ref: 'main',
  } });
  let created = false;
  await assert.rejects(
    runCursorCloudTask({ root: mutableRoot, taskId: 'cloud-review-ref', sdk: { Agent: { create: async () => { created = true; } } }, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cloud_start_ref_invalid',
  );
  assert.equal(created, false);
});

test('rejects an origin URL containing embedded credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-url-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://token@example.test/repo.git']);
  await createCloudTask({ root, prompt: 'review', record: {
    id: 'cloud-url', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let created = false;
  const sdk = { Agent: { create: async () => { created = true; } } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-url', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cloud_origin_credentials',
  );
  assert.equal(created, false);
});

test('rejects repository URLs with query or fragment data', async () => {
  for (const [suffix, expectedCode] of [
    ['?token=secret', 'cursor_cloud_origin_credentials'],
    ['#fragment', 'cursor_cloud_origin_credentials'],
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-url-shape-'));
    const repo = path.join(root, 'repo');
    await run('git', ['init', '-b', 'main', repo]);
    await commitRepo(repo);
    await run('git', ['-C', repo, 'remote', 'add', 'origin', suffix.includes('://') ? suffix : `https://example.test/repo.git${suffix}`]);
    await createCloudTask({ root, prompt: 'review', record: {
      id: `cloud-url-${suffix.replace(/[^a-z]+/giu, '-')}`, status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    } });
    await assert.rejects(
      runCursorCloudTask({ root, taskId: `cloud-url-${suffix.replace(/[^a-z]+/giu, '-')}`, sdk: { Agent: {} }, apiKey: 'test-key' }),
      (error) => error.code === expectedCode,
    );
  }
});

test('canonicalizes HTTPS and SSH origins without sending transport credentials', async () => {
  const origins = [
    ['https://github.com/example/repo.git', 'https://github.com/example/repo.git'],
    ['git@github.com:example/repo.git', 'https://github.com/example/repo.git'],
    ['ssh://git@github.com/example/repo.git', 'https://github.com/example/repo.git'],
  ];
  for (const [index, [origin, expected]] of origins.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-shapes-'));
    const repo = path.join(root, 'repo');
    await run('git', ['init', '-b', 'main', repo]);
    await commitRepo(repo);
    await run('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
    const taskId = `cloud-origin-${index}`;
    await createCloudTask({ root, prompt: 'review', record: {
      id: taskId,
      status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    } });
    let createOptions;
    const sdk = { Agent: { archive: async () => {}, create: async (options) => {
      createOptions = options;
      return { send: async () => ({ id: 'run-origin-shape', wait: async () => ({ id: 'run-origin-shape', status: 'finished', result: 'done' }) }), close() {} };
    } } };
    await runCursorCloudTask({ root, taskId, sdk, apiKey: 'test-key' });
    assert.equal(createOptions.cloud.repos[0].url, expected);
    assert.doesNotMatch(JSON.stringify(createOptions), /git@|ssh:|token|password/iu);
  }
});

test('fails before provider dispatch when the origin is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-missing-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await createCloudTask({ root, prompt: 'must not dispatch', record: {
    id: 'cloud-origin-missing', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let createCalls = 0;
  let sendCalls = 0;
  const sdk = { Agent: {
    create: async () => { createCalls += 1; return { send: async () => { sendCalls += 1; } }; },
  } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-origin-missing', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cloud_origin_missing',
  );
  const task = (await readTask(root, 'cloud-origin-missing')).task;
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'cursor_cloud_origin_missing');
  assert.equal(createCalls, 0);
  assert.equal(sendCalls, 0);
});

test('uses a credential-free provider repository override when local origin is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-override-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await createCloudTask({ root, prompt: 'use the provider override', record: {
    id: 'cloud-origin-override', status: 'accepted', provider: 'cursor-cloud', role: 'implement', cwd: repo,
    provider_repo_url: 'git@github.com:example/repo.git',
  } });
  let createOptions;
  const sdk = { Agent: {
    archive: async () => {},
    create: async (options) => {
      createOptions = options;
      return { send: async () => ({ id: 'run-origin-override', wait: async () => ({ id: 'run-origin-override', status: 'finished', result: 'done' }) }), close() {} };
    },
  } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-origin-override', sdk, apiKey: 'test-key' });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.provider_repo_url, 'https://github.com/example/repo.git');
  assert.equal(createOptions.cloud.repos[0].url, 'https://github.com/example/repo.git');
  assert.doesNotMatch(JSON.stringify(createOptions), /git@|ssh:|secret|token/iu);
});

test('rejects a dirty Cloud checkout before creating a provider agent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-workspace-dirty-'));
  const repo = await createCloudRepo(root);
  await run('git', ['-C', repo, 'config', 'user.name', 'Co-Engineer Test']);
  await writeFile(path.join(repo, 'dirty.txt'), 'uncommitted\n');
  await createCloudTask({ root, prompt: 'must not dispatch', record: {
    id: 'cloud-workspace-dirty', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let createCalls = 0;
  await assert.rejects(
    runCursorCloudTask({
      root,
      taskId: 'cloud-workspace-dirty',
      sdk: { Agent: { create: async () => { createCalls += 1; } } },
      apiKey: 'test-key',
    }),
    (error) => error.code === 'cursor_cloud_workspace_dirty',
  );
  assert.equal(createCalls, 0);
  assert.equal((await readTask(root, 'cloud-workspace-dirty')).task.status, 'failed');
});

test('rejects credential-bearing provider overrides before creating a cloud run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-override-invalid-'));
  const repo = await createCloudRepo(root);
  await createCloudTask({ root, prompt: 'must not dispatch', record: {
    id: 'cloud-origin-override-invalid', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    provider_repo_url: 'https://token:secret@example.test/repo.git',
  } });
  let createCalls = 0;
  const sdk = { Agent: { create: async () => { createCalls += 1; } } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-origin-override-invalid', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'cursor_cloud_repo_credentials',
  );
  assert.equal(createCalls, 0);
  assert.equal((await readTask(root, 'cloud-origin-override-invalid')).task.status, 'failed');
});

test('rejects a derived origin that changes after supervisor preflight', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-changed-'));
  const repo = await createCloudRepo(root);
  const { stdout: head } = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
  await createCloudTask({ root, prompt: 'must not dispatch', record: {
    id: 'cloud-origin-changed', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    starting_ref: head.trim(), provider_repo_url: 'https://github.com/example/repo.git',
    provider_repo_identity: 'github.com/example/repo', provider_repo_source: 'derived', provider_origin_kind: 'https',
  } });
  await run('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);
  let createCalls = 0;
  await assert.rejects(
    runCursorCloudTask({
      root,
      taskId: 'cloud-origin-changed',
      sdk: { Agent: { create: async () => { createCalls += 1; } } },
      apiKey: 'test-key',
    }),
    (error) => error.code === 'cursor_cloud_origin_changed',
  );
  assert.equal(createCalls, 0);
  assert.equal((await readTask(root, 'cloud-origin-changed')).task.status, 'failed');
});

test('allows an explicit provider repository override when the local origin changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-override-change-'));
  const repo = await createCloudRepo(root);
  const { stdout: head } = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
  await createCloudTask({ root, prompt: 'use the explicit provider repository', record: {
    id: 'cloud-origin-override-change', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    starting_ref: head.trim(), provider_repo_url: 'https://github.com/provider/repo.git',
    provider_repo_identity: 'github.com/provider/repo', provider_repo_source: 'explicit', provider_origin_kind: 'override',
  } });
  await run('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);
  let createOptions;
  const terminal = await runCursorCloudTask({
    root,
    taskId: 'cloud-origin-override-change',
    sdk: { Agent: {
      archive: async () => {},
      create: async (options) => {
        createOptions = options;
        return { send: async () => ({ id: 'run-origin-override-change', wait: async () => ({ id: 'run-origin-override-change', status: 'finished', result: 'done' }) }), close() {} };
      },
    } },
    apiKey: 'test-key',
  });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.provider_repo_source, 'explicit');
  assert.equal(createOptions.cloud.repos[0].url, 'https://github.com/provider/repo.git');
});

test('canonicalizes equivalent SSH forms and drops default port 22', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-origin-ssh-port-'));
  const expectedIdentity = 'github.com/example/repo';
  for (const [index, origin] of [
    'git@github.com:example/repo.git',
    'ssh://git@github.com:22/example/repo.git',
    'https://github.com/example/repo.git',
  ].entries()) {
    const repo = path.join(root, `repo-${index}`);
    await run('git', ['init', '-b', 'main', repo]);
    await commitRepo(repo);
    await run('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
    await createCloudTask({ root, prompt: 'review', record: {
      id: `cloud-origin-ssh-port-${index}`, status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    } });
    let createOptions;
    const terminal = await runCursorCloudTask({
      root,
      taskId: `cloud-origin-ssh-port-${index}`,
      sdk: { Agent: { archive: async () => {}, create: async (options) => {
        createOptions = options;
        return { send: async () => ({ id: `run-origin-ssh-port-${index}`, wait: async () => ({ id: `run-origin-ssh-port-${index}`, status: 'finished', result: 'done' }) }), close() {} };
      } } },
      apiKey: 'test-key',
    });
    assert.equal(terminal.provider_repo_identity, expectedIdentity);
    assert.equal(createOptions.cloud.repos[0].url, 'https://github.com/example/repo.git');
  }
});

test('cancels the provider run and archives the cloud agent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-'));
  await createCloudTask({ root, prompt: 'stop it', record: {
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
  await createCloudTask({ root, prompt: 'stop it', record: {
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
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root, prompt: 'hang', record: {
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
    getRun: async () => ({ id: cloudRun.id, status: cloudRun.status }),
    archive: async () => { archived += 1; },
  } };
  await assert.rejects(runCursorCloudTask({ root, taskId: 'cloud-timeout', sdk, apiKey: 'test-key' }), (error) => error.code === 'timeout');
  const terminal = (await readTask(root, 'cloud-timeout')).task;
  assert.equal(terminal.status, 'timeout');
  assert.ok(cancelled >= 1);
  assert.equal(archived, 1);
});

test('keeps a task transport-lost when provider confirmation remains active after cancel', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-confirmation-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root, prompt: 'fail after dispatch', record: {
    id: 'cloud-cancel-confirmation', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  let archived = 0;
  const cloudRun = {
    id: 'run-active',
    status: 'running',
    wait: async () => { throw Object.assign(new Error('stream lost'), { code: 'network_error', isRetryable: true }); },
    cancel: async () => { cloudRun.status = 'cancelled'; },
  };
  const sdk = { Agent: {
    create: async () => ({ send: async () => cloudRun, close() {} }),
    getRun: async () => ({ id: 'run-active', status: 'running' }),
    archive: async () => { archived += 1; },
  } };
  await assert.rejects(
    runCursorCloudTask({ root, taskId: 'cloud-cancel-confirmation', sdk, apiKey: 'test-key' }),
    (error) => error.code === 'network_error',
  );
  const task = (await readTask(root, 'cloud-cancel-confirmation')).task;
  assert.equal(task.status, 'transport_lost');
  assert.equal(archived, 0);
});

test('does not claim cancellation succeeded when provider state cannot be checked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-uncertain-'));
  await createCloudTask({ root, prompt: 'stop it', record: {
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

test('maps cancellation SDK or credential loading failure to transport_lost', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-load-'));
  await createCloudTask({ root, prompt: 'stop it', record: {
    id: 'cloud-cancel-load', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', provider_run_id: 'run-one', prompt_dispatched: true,
  } });
  let thrown;
  try {
    await cancelCursorCloudTask({
      root,
      taskId: 'cloud-cancel-load',
      apiKey: 'test-key',
      loadSdk: async () => { throw new Error('https://user:secret@example.test/?token=leak'); },
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'cursor_cancel_unconfirmed');
  assert.doesNotMatch(thrown?.message ?? '', /secret|leak/iu);
  const task = (await readTask(root, 'cloud-cancel-load')).task;
  assert.equal(task.status, 'transport_lost');
  assert.equal(task.error.code, 'cursor_cancel_unconfirmed');
  assert.doesNotMatch(task.error.message, /secret|leak/iu);
});

test('keeps cancellation terminal while reporting a failed archive truthfully', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-cancel-archive-'));
  await createCloudTask({ root, prompt: 'stop it', record: {
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
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root, prompt: 'review', record: {
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
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await run('git', ['-C', repo, '-c', 'user.name=Co-Engineer Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  await createCloudTask({ root, prompt: 'implement', record: {
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
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root, prompt: 'review', record: {
    id: 'cloud-dispatch-rejected', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const sdk = { Agent: {
    create: async () => ({
      send: async () => { throw Object.assign(new Error('invalid prompt at https://user:secret@example.test/repo.git?token=leak'), { code: 'invalid_argument', isRetryable: false }); },
      close() {},
    }),
  } };
  let thrown;
  try {
    await runCursorCloudTask({ root, taskId: 'cloud-dispatch-rejected', sdk, apiKey: 'test-key' });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'invalid_argument');
  assert.doesNotMatch(thrown?.message ?? '', /secret|leak/iu);
  assert.equal((await readTask(root, 'cloud-dispatch-rejected')).task.status, 'failed');
});

test('records a truthful archive flag when terminal cleanup fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-archive-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root, prompt: 'review', record: {
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
  await createCloudTask({ root, prompt: 'review', record: {
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

test('reconciliation rejects a provider response for a different run identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-reconcile-mismatch-'));
  await createCloudTask({ root, prompt: 'review', record: {
    id: 'cloud-reconcile-mismatch', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', provider_run_id: 'run-recorded', prompt_dispatched: true,
  } });
  const task = await reconcileCursorCloudTask({
    root,
    taskId: 'cloud-reconcile-mismatch',
    sdk: { Agent: { getRun: async () => ({ id: 'run-other', agentId: 'bc-agent', status: 'finished' }) } },
    apiKey: 'test-key',
  });
  assert.equal(task.status, 'transport_lost');
  assert.equal(task.error.code, 'cursor_run_identity_mismatch');
});

test('maps reconciliation SDK or credential loading failure to transport_lost', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-reconcile-load-'));
  await createCloudTask({ root, prompt: 'review', record: {
    id: 'cloud-reconcile-load', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-agent', provider_run_id: 'run-one', prompt_dispatched: true,
  } });
  const task = await reconcileCursorCloudTask({
    root,
    taskId: 'cloud-reconcile-load',
    loadSdk: async () => { throw new Error('https://user:secret@example.test/?token=leak'); },
    apiKey: 'test-key',
  });
  assert.equal(task.status, 'transport_lost');
  assert.equal(task.error.code, 'cursor_reconcile_failed');
  assert.doesNotMatch(task.error.message, /secret|leak/iu);
});

test('reconciliation records a truthful archive result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-reconcile-archive-'));
  await createCloudTask({ root, prompt: 'review', record: {
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
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root, prompt: 'review', record: {
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

test('cancels and archives an exact late run when cancellation overlaps a pending send', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-pending-send-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await createCloudTask({ root, prompt: 'cancel while dispatch is pending', record: {
    id: 'cloud-pending-send', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    provider_agent_id: 'bc-pending-send',
  } });
  let signalSendStarted;
  const sendStarted = new Promise((resolve) => { signalSendStarted = resolve; });
  let releaseOriginalSend;
  const originalSend = new Promise((resolve) => { releaseOriginalSend = resolve; });
  let providerStatus = 'running';
  let cancelCalls = 0;
  let archiveCalls = 0;
  const lateRun = {
    id: 'run-late',
    agentId: 'bc-pending-send',
    status: 'running',
    wait: async () => ({ id: 'run-late', status: providerStatus, git: { branches: [] } }),
    cancel: async () => { cancelCalls += 1; providerStatus = 'cancelled'; },
  };
  let createCalls = 0;
  const sdk = { Agent: {
    create: async () => {
      createCalls += 1;
      if (createCalls === 1) {
        return {
          send: async () => {
            signalSendStarted();
            return originalSend;
          },
          close() {},
        };
      }
      return { send: async () => lateRun, close() {} };
    },
    listRuns: async () => ({ items: [{ id: 'run-late', agentId: 'bc-pending-send', status: providerStatus }] }),
    cancelRun: async (runId, options) => {
      assert.equal(runId, 'run-late');
      assert.equal(options.agentId, 'bc-pending-send');
      cancelCalls += 1;
      providerStatus = 'cancelled';
    },
    getRun: async (runId, options) => ({ id: runId, agentId: options.agentId, status: providerStatus }),
    archive: async (agentId) => {
      assert.equal(agentId, 'bc-pending-send');
      archiveCalls += 1;
    },
  } };
  const worker = runCursorCloudTask({ root, taskId: 'cloud-pending-send', sdk, apiKey: 'cursor-secret' }).catch((error) => error);
  await sendStarted;
  const dispatched = (await readTask(root, 'cloud-pending-send')).task;
  assert.equal(dispatched.prompt_dispatched, true);
  assert.equal(dispatched.provider_run_id, undefined);
  await updateTask(root, 'cloud-pending-send', { status: 'cancelling' });
  const cancelled = await cancelCursorCloudTask({ root, taskId: 'cloud-pending-send', sdk, apiKey: 'cursor-secret' });
  assert.equal(cancelled.status, 'cancelled');
  releaseOriginalSend(lateRun);
  const workerError = await worker;
  assert.equal(workerError.code, 'cancelled');
  const final = (await readTask(root, 'cloud-pending-send')).task;
  assert.equal(final.status, 'cancelled');
  assert.equal(final.provider_run_id, 'run-late');
  assert.equal(final.provider_run_cancelled, true);
  assert.equal(cancelCalls, 1);
  assert.equal(archiveCalls, 1);
  assert.notEqual(final.status, 'running');
  assert.notEqual(final.status, 'completed');
});

test('does not overwrite a cancellation receipt when pending send returns a different run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-pending-mismatch-'));
  const repo = await createCloudRepo(root);
  await createCloudTask({ root, prompt: 'cancel the mismatched late run', record: {
    id: 'cloud-pending-mismatch', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
    provider_agent_id: 'bc-pending-mismatch',
  } });
  let signalSendStarted;
  const sendStarted = new Promise((resolve) => { signalSendStarted = resolve; });
  let releaseOriginalSend;
  const originalSend = new Promise((resolve) => { releaseOriginalSend = resolve; });
  let recoveredStatus = 'running';
  let lateStatus = 'running';
  let createCalls = 0;
  let recoveredCancelCalls = 0;
  let lateCancelCalls = 0;
  let archiveCalls = 0;
  const recoveredRun = {
    id: 'run-recovered',
    agentId: 'bc-pending-mismatch',
    wait: async () => ({ id: 'run-recovered', status: recoveredStatus, git: { branches: [] } }),
  };
  const lateRun = {
    id: 'run-different',
    agentId: 'bc-pending-mismatch',
    wait: async () => ({ id: 'run-different', status: lateStatus, git: { branches: [] } }),
    cancel: async () => { lateCancelCalls += 1; lateStatus = 'cancelled'; },
  };
  const sdk = { Agent: {
    create: async () => {
      createCalls += 1;
      if (createCalls === 1) {
        return {
          send: async () => {
            signalSendStarted();
            return originalSend;
          },
          close() {},
        };
      }
      return { send: async () => recoveredRun, close() {} };
    },
    listRuns: async () => ({ items: [] }),
    cancelRun: async (runId, options) => {
      assert.equal(runId, 'run-recovered');
      assert.equal(options.agentId, 'bc-pending-mismatch');
      recoveredCancelCalls += 1;
      recoveredStatus = 'cancelled';
    },
    getRun: async (runId, options) => ({
      id: runId,
      agentId: options.agentId,
      status: runId === 'run-recovered' ? recoveredStatus : lateStatus,
    }),
    archive: async () => { archiveCalls += 1; },
  } };
  const worker = runCursorCloudTask({ root, taskId: 'cloud-pending-mismatch', sdk, apiKey: 'cursor-secret' }).catch((error) => error);
  await sendStarted;
  await updateTask(root, 'cloud-pending-mismatch', { status: 'cancelling' });
  const cancelled = await cancelCursorCloudTask({ root, taskId: 'cloud-pending-mismatch', sdk, apiKey: 'cursor-secret' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.provider_run_id, 'run-recovered');
  releaseOriginalSend(lateRun);
  const workerError = await worker;
  assert.equal(workerError.code, 'cursor_run_identity_mismatch');
  const final = (await readTask(root, 'cloud-pending-mismatch')).task;
  assert.equal(final.status, 'cancelled');
  assert.equal(final.provider_run_id, 'run-recovered');
  assert.equal(final.provider_run_cancelled, true);
  assert.equal(recoveredCancelCalls, 1);
  assert.equal(lateCancelCalls, 1);
  assert.equal(archiveCalls, 1);
});

test('recovers a crashed dispatch only by replaying its exact idempotent create request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-crash-recovery-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  const { stdout: head } = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
  await createCloudTask({ root, prompt: 'recover this exact dispatch', record: {
    id: 'cloud-crash-recovery', status: 'starting', provider: 'cursor-cloud', role: 'review', cwd: repo,
    provider_agent_id: 'bc-crash-recovery', provider_repo_url: 'https://github.com/example/repo.git',
    starting_ref: head.trim(), prompt_dispatched: true, run_idempotency_key: 'cloud-crash-recovery:run:1',
  } });
  const observed = {};
  const sdk = { Agent: {
    create: async (options) => {
      observed.create = options;
      return {
        send: async (prompt, sendOptions) => {
          observed.send = { prompt, sendOptions };
          return {
            id: 'run-crash-recovered', agentId: 'bc-crash-recovery', status: 'finished',
            wait: async () => ({ id: 'run-crash-recovered', status: 'finished', result: 'recovered', git: { branches: [] } }),
          };
        },
        close() {},
      };
    },
    archive: async () => {},
  } };
  const reconciled = await reconcileCursorCloudTask({ root, taskId: 'cloud-crash-recovery', sdk, apiKey: 'cursor-secret' });
  assert.equal(observed.create.agentId, 'bc-crash-recovery');
  assert.equal(observed.create.cloud.repos[0].startingRef, head.trim());
  assert.equal(observed.send.prompt, 'recover this exact dispatch');
  assert.equal(observed.send.sendOptions.idempotencyKey, 'cloud-crash-recovery:run:1');
  assert.equal(reconciled.status, 'completed');
  assert.equal(reconciled.provider_run_id, 'run-crash-recovered');
});

test('accepts one exact provider request identity and leaves ambiguous matches transport_lost', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-request-identity-'));
  const key = 'cloud-request-identity:run:1';
  const runResult = {
    id: 'run-request-identity', agentId: 'bc-request-identity', status: 'finished',
    wait: async () => ({ id: 'run-request-identity', status: 'finished', result: 'done', git: { branches: [] } }),
  };
  await createCloudTask({ root, prompt: 'recover by request identity', record: {
    id: 'cloud-request-identity', status: 'starting', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-request-identity', prompt_dispatched: true, run_idempotency_key: key,
  } });
  let created = 0;
  const exactSdk = { Agent: {
    listRuns: async () => ({ items: [{ id: runResult.id, agentId: runResult.agentId, requestId: key, status: 'finished' }] }),
    getRun: async () => runResult,
    create: async () => { created += 1; return null; },
    archive: async () => {},
  } };
  const exact = await reconcileCursorCloudTask({ root, taskId: 'cloud-request-identity', sdk: exactSdk, apiKey: 'cursor-secret' });
  assert.equal(exact.status, 'completed');
  assert.equal(created, 0);

  const ambiguousRoot = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-request-ambiguous-'));
  await createCloudTask({ root: ambiguousRoot, prompt: 'ambiguous request identity', record: {
    id: 'cloud-request-ambiguous', status: 'starting', provider: 'cursor-cloud', role: 'review', cwd: ambiguousRoot,
    provider_agent_id: 'bc-request-ambiguous', prompt_dispatched: true, run_idempotency_key: key,
  } });
  let ambiguousCreated = 0;
  const ambiguousSdk = { Agent: {
    listRuns: async () => ({ items: [
      { id: 'run-a', agentId: 'bc-request-ambiguous', requestId: key, status: 'running' },
      { id: 'run-b', agentId: 'bc-request-ambiguous', requestId: key, status: 'running' },
    ] }),
    create: async () => { ambiguousCreated += 1; return null; },
  } };
  const ambiguous = await reconcileCursorCloudTask({ root: ambiguousRoot, taskId: 'cloud-request-ambiguous', sdk: ambiguousSdk, apiKey: 'cursor-secret' });
  assert.equal(ambiguous.status, 'transport_lost');
  assert.equal(ambiguousCreated, 0);
});

test('recursively redacts prompt, bearer, and API-key material from normal provider results', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-result-redaction-'));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '-b', 'main', repo]);
  await commitRepo(repo);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  const prompt = 'private prompt value';
  const apiKey = 'cursor-api-secret-123';
  const modelKey = 'env-model-value-1234567890';
  const cursorKey = 'env-cursor-value-1234567890';
  const xaiKey = 'env-xai-value-1234567890';
  const bearer = 'structured-bearer-value-1234567890';
  const commonTokens = [
    ['sk', 'live-token-value-1234567890'].join('-'),
    ['xai', 'live-token-value-1234567890'].join('-'),
    ['ghp', 'live-token-value-1234567890'].join('_'),
  ];
  await createCloudTask({ root, prompt, record: {
    id: 'cloud-result-redaction', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const sdk = { Agent: {
    create: async () => ({
      send: async () => ({ id: 'run-redaction', wait: async () => ({
        id: 'run-redaction', status: 'finished',
        result: [
          `provider echoed ${prompt}; Authorization: Bearer ${apiKey}; api_key=${apiKey}`,
          ['MODEL_API_KEY', modelKey].join('='),
          ['CURSOR_API_KEY', cursorKey].join(': '),
          ['XAI_API_KEY', xaiKey].join(' = '),
          ...commonTokens,
        ].join('; '),
        error: {
          message: `failed for ${prompt}`,
          token: apiKey,
          bearer,
          MODEL_API_KEY: modelKey,
          CURSOR_API_KEY: cursorKey,
          XAI_API_KEY: xaiKey,
          nested: { prompt, authorization: `Bearer ${apiKey}` },
        },
        git: { branches: [{ repoUrl: 'https://example.test/repo.git', prUrl: `https://example.test/pull?token=${apiKey}` }] },
      }) }),
      close() {},
    }),
    archive: async () => {},
  } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-result-redaction', sdk, apiKey });
  const task = (await readTask(root, 'cloud-result-redaction')).task;
  const serialized = JSON.stringify(task);
  assert.equal(terminal.status, 'completed');
  assert.doesNotMatch(serialized, new RegExp(prompt, 'u'));
  assert.doesNotMatch(serialized, new RegExp(apiKey, 'u'));
  for (const secret of [modelKey, cursorKey, xaiKey, bearer, ...commonTokens]) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
  }
  assert.doesNotMatch(serialized, /Bearer\s+cursor-api-secret/iu);
  assert.equal(task.provider_error.token, '[redacted]');
  assert.equal(task.provider_error.bearer, '[redacted]');
  assert.equal(task.provider_error.MODEL_API_KEY, '[redacted]');
  assert.equal(task.provider_error.CURSOR_API_KEY, '[redacted]');
  assert.equal(task.provider_error.XAI_API_KEY, '[redacted]');
  assert.equal(task.provider_error.nested.prompt, '[redacted]');
  assert.equal(task.branches[0].prUrl, 'https://example.test/pull?token=[redacted]');
});

test('Cursor Cloud preserves a terminal verdict at the end of long output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-result-tail-'));
  const repo = await createCloudRepo(root);
  const source = `${'x'.repeat(5_000)}\nVERDICT: CLOUD PASS`;
  await createCloudTask({ root, prompt: 'review', record: {
    id: 'cloud-result-tail', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const sdk = { Agent: {
    create: async () => ({
      send: async () => ({ id: 'run-tail', wait: async () => ({
        id: 'run-tail', status: 'finished', result: source, git: { branches: [] },
      }) }),
      close() {},
    }),
    archive: async () => {},
  } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-result-tail', sdk, apiKey: 'test-key' });
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result, /VERDICT: CLOUD PASS$/u);
  assert.equal(terminal.result_truncated, true);
  assert.equal(terminal.result_original_chars, source.length);
});

test('Cursor Cloud preserves bounded nested provider result values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-result-object-'));
  const repo = await createCloudRepo(root);
  const source = {
    progress: 'x'.repeat(5_000),
    nested: { final: `${'y'.repeat(5_000)}\nVERDICT: CLOUD OBJECT PASS` },
    token: 'cursor-object-secret-123456',
  };
  await createCloudTask({ root, prompt: 'review', record: {
    id: 'cloud-result-object', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const sdk = { Agent: {
    create: async () => ({
      send: async () => ({ id: 'run-object', wait: async () => ({
        id: 'run-object', status: 'finished', result: source, git: { branches: [] },
      }) }),
      close() {},
    }),
    archive: async () => {},
  } };
  const terminal = await runCursorCloudTask({ root, taskId: 'cloud-result-object', sdk, apiKey: 'test-key' });
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result.nested.final, /VERDICT: CLOUD OBJECT PASS$/u);
  assert.equal(terminal.result.token, '[redacted]');
  assert.equal(terminal.result_truncated, true);
  assert.equal(terminal.result_original_chars, source.progress.length + source.nested.final.length + source.token.length);
});

test('redacts token-only URL userinfo from provider output receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-token-url-redaction-'));
  const repo = await createCloudRepo(root);
  const token = 'provider-token-only';
  await createCloudTask({ root, prompt: 'review', record: {
    id: 'cloud-token-url-redaction', status: 'accepted', provider: 'cursor-cloud', role: 'review', cwd: repo,
  } });
  const sdk = { Agent: {
    create: async () => ({
      send: async () => ({ id: 'run-token-url-redaction', wait: async () => ({
        id: 'run-token-url-redaction', status: 'finished',
        git: { branches: [{ repoUrl: `https://${token}@example.test/repo.git` }] },
      }) }),
      close() {},
    }),
    archive: async () => {},
  } };
  await runCursorCloudTask({ root, taskId: 'cloud-token-url-redaction', sdk, apiKey: 'test-key' });
  const task = (await readTask(root, 'cloud-token-url-redaction')).task;
  assert.equal(task.branches[0].repoUrl, 'https://[redacted]@example.test/repo.git');
  assert.doesNotMatch(JSON.stringify(task), new RegExp(token, 'u'));
});

test('recursively redacts prompt and provider credentials from reconciled results', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-reconcile-redaction-'));
  const prompt = 'reconcile private prompt';
  const apiKey = 'reconcile-api-secret-456';
  await createCloudTask({ root, prompt, record: {
    id: 'cloud-reconcile-redaction', status: 'running', provider: 'cursor-cloud', role: 'review', cwd: root,
    provider_agent_id: 'bc-reconcile-redaction', provider_run_id: 'run-reconcile-redaction', prompt_dispatched: true,
  } });
  const sdk = { Agent: {
    getRun: async () => ({
      id: 'run-reconcile-redaction', agentId: 'bc-reconcile-redaction', status: 'finished',
      wait: async () => ({
        id: 'run-reconcile-redaction', status: 'finished',
        result: `result included ${prompt} and Bearer ${apiKey}`,
        error: { authorization: `Bearer ${apiKey}`, detail: prompt },
        git: { branches: [] },
      }),
    }),
    archive: async () => {},
  } };
  const task = await reconcileCursorCloudTask({ root, taskId: 'cloud-reconcile-redaction', sdk, apiKey });
  assert.equal(task.status, 'completed');
  const serialized = JSON.stringify(task);
  assert.doesNotMatch(serialized, new RegExp(prompt, 'u'));
  assert.doesNotMatch(serialized, new RegExp(apiKey, 'u'));
  assert.equal(task.provider_error.authorization, '[redacted]');
});

test('run-completion wait re-arms when an audited deadline extension is recorded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-cursor-deadline-extend-'));
  const repo = await createCloudRepo(root);
  const originalMs = 400;
  await createCloudTask({ root, prompt: 'keep going', record: {
    id: 'cloud-deadline-extend',
    status: 'accepted',
    provider: 'cursor-cloud',
    role: 'review',
    cwd: repo,
    timeout_ms: originalMs,
    deadline_at: new Date(Date.now() + originalMs).toISOString(),
    expected_duration_ms: 150,
    duration_margin: 1.2,
    deadline_source: 'margin',
    deadline_extensions: [],
  } });
  let finishRun;
  const finished = new Promise((resolve) => { finishRun = resolve; });
  const cloudRun = {
    id: 'run-extend',
    status: 'running',
    wait: async () => finished,
    cancel: async () => { cloudRun.status = 'cancelled'; },
  };
  const sdk = { Agent: {
    create: async () => ({ send: async () => cloudRun, close() {} }),
    getRun: async () => ({ id: cloudRun.id, status: cloudRun.status }),
    archive: async () => {},
  } };
  const worker = runCursorCloudTask({
    root,
    taskId: 'cloud-deadline-extend',
    sdk,
    apiKey: 'test-key',
    deadlineRefreshMs: 20,
  });
  const started = Date.now();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readTask(root, 'cloud-deadline-extend')).task.status === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await readTask(root, 'cloud-deadline-extend')).task.status, 'running');
  await extendTaskDeadline(root, 'cloud-deadline-extend', {
    expected_duration_ms: 5_000,
    reason: 'provider is still running the test suite',
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  finishRun({ id: 'run-extend', status: 'finished', result: 'done', git: { branches: [] } });
  const terminal = await worker;
  assert.equal(terminal.status, 'completed');
  assert.ok(Date.now() - started > originalMs);
  assert.equal((await readTask(root, 'cloud-deadline-extend')).task.deadline_source, 'extended');
});
