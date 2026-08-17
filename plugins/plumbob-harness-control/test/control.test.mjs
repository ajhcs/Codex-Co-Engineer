import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { insertJob, openStore } from '../mcp/store.mjs';

test('jobs rejects an invalid tail before entering the polling loop', async (context) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'plumbob-control-args-test-'));
  context.after(async () => rm(state, { recursive: true, force: true }));
  const previousState = process.env.PLUMBOB_HARNESS_STATE_DIR;
  process.env.PLUMBOB_HARNESS_STATE_DIR = state;
  const { dispatchControl, ToolError } = await import(`../mcp/control.mjs?args=${Date.now()}`);
  const logFile = path.join(state, 'job.log');

  const database = openStore(path.join(state, 'control.sqlite3'));
  insertJob(database, {
    id: 'active-job-1234',
    kind: 'deepseek_agent',
    status: 'running',
    summary: 'Argument validation test',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    child_pid: process.pid,
    log_file: logFile,
    cancel_file: path.join(state, 'job.cancel'),
  });
  database.close();

  const started = performance.now();
  await assert.rejects(
    dispatchControl('jobs', {
      action: 'wait',
      job_id: 'active-job-1234',
      wait_seconds: 55,
      tail_lines: 121,
    }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_argument'
      && /tail_lines/.test(error.message),
  );
  assert.ok(performance.now() - started < 1000, 'invalid tail should not consume wait time');
  await assert.rejects(
    dispatchControl('jobs', {
      action: 'wait',
      job_id: 'active-job-1234',
      wait_seconds: 56,
      tail_lines: 40,
    }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_argument'
      && /wait_seconds/.test(error.message),
  );

  await writeFile(logFile, 'api_key=not-a-real-secret\nsecond line\n');
  const inspected = await dispatchControl('jobs', {
    action: 'get',
    job_id: 'active-job-1234',
    tail_lines: 1,
    after_cursor: '0',
  });
  assert.equal(inspected.job.kind, 'deepseek_agent');
  assert.equal(inspected.log_tail, 'second line');
  assert.match(inspected.log_delta.data, /api_key=\[REDACTED\]/);
  assert.equal(inspected.next_cursor, String((await stat(logFile)).size));

  if (previousState === undefined) delete process.env.PLUMBOB_HARNESS_STATE_DIR;
  else process.env.PLUMBOB_HARNESS_STATE_DIR = previousState;
});

test('DeepSeek rejects fields from removed backends instead of silently ignoring them', async () => {
  const { dispatchControl, ToolError } = await import(`../mcp/control.mjs?kind=${Date.now()}`);
  await assert.rejects(
    dispatchControl('run', {
      schema_version: 'codex-co-engineer.config.v1',
      kind: 'deepseek_agent',
      request_id: 'kind-specific-1234',
      prompt: 'Bounded review prompt.',
      autonomy: 'high',
    }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_argument'
      && /autonomy/.test(error.message),
  );
});

test('non-Grok runs reject Grok-only fields instead of silently ignoring them', async () => {
  const { dispatchControl, ToolError } = await import(`../mcp/control.mjs?grok-fields=${Date.now()}`);
  await assert.rejects(
    dispatchControl('run', {
      schema_version: 'codex-co-engineer.config.v1',
      kind: 'deepseek_agent',
      request_id: 'grok-field-reject-1',
      prompt: 'Bounded review prompt.',
      model: 'grok-4.6',
    }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_argument'
      && /model/.test(error.message),
  );
});

test('explicit targets are not limited to the default workspace and allow implement contracts', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-target-policy-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
  await writeFile(path.join(directory, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', directory,
    '-c', 'user.name=Co-Engineer Test',
    '-c', 'user.email=co-engineer-test@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  const expectedHead = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const previousRoots = process.env.PLUMBOB_HARNESS_ALLOWED_ROOTS;
  delete process.env.PLUMBOB_HARNESS_ALLOWED_ROOTS;
  const { __testing } = await import(`../mcp/control.mjs?target-policy=${Date.now()}`);

  try {
    assert.equal(__testing.configuredTargetRoots(), null);
    const prepared = await __testing.prepareTarget({
      schema_version: 'codex-co-engineer.target.v1',
      mode: 'explicit',
      working_directory: directory,
      expected_git_root: directory,
      expected_head: expectedHead,
      allowed_paths: ['.'],
      role: 'implement',
    });
    assert.equal(prepared.cwd, directory);
    assert.equal(prepared.target.role, 'implement');
    assert.equal(prepared.target.isolation, 'explicit-scoped-workspace');
  } finally {
    if (previousRoots === undefined) delete process.env.PLUMBOB_HARNESS_ALLOWED_ROOTS;
    else process.env.PLUMBOB_HARNESS_ALLOWED_ROOTS = previousRoots;
  }
});

test('agent locks apply only to overlapping execution scopes', async () => {
  const { __testing } = await import(`../mcp/control.mjs?scope-policy=${Date.now()}`);
  assert.equal(__testing.executionScopesOverlap('/tmp/codebase-a', '/tmp/codebase-b'), false);
  assert.equal(__testing.executionScopesOverlap('/tmp/codebase-a', '/tmp/codebase-a/packages'), true);
  assert.equal(__testing.executionScopesOverlap(
    {
      working_directory: '/tmp/codebase-a/packages/one',
      expected_git_root: '/tmp/codebase-a',
      git_common_directory: '/tmp/codebase-a/.git',
    },
    {
      working_directory: '/tmp/codebase-a/packages/two',
      expected_git_root: '/tmp/codebase-a',
      git_common_directory: '/tmp/codebase-a/.git',
    },
  ), true);
  assert.equal(__testing.executionScopesOverlap(
    {
      working_directory: '/tmp/codebase-a',
      expected_git_root: '/tmp/codebase-a',
      git_common_directory: '/tmp/codebase-a/.git',
    },
    {
      working_directory: '/tmp/codebase-b',
      expected_git_root: '/tmp/codebase-b',
      git_common_directory: '/tmp/codebase-b/.git',
    },
  ), false);
});

test('omitted, null, and unknown target fields fail without default fallback', async () => {
  const { __testing, dispatchControl, ToolError } = await import(`../mcp/control.mjs?strict-target=${Date.now()}`);
  await assert.rejects(
    __testing.prepareTarget(null),
    (error) => error instanceof ToolError && error.code === 'invalid_target_context',
  );
  await assert.rejects(
    __testing.prepareTarget({ schema_version: 'codex-co-engineer.target.v1', mode: 'explicit' }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_target_context'
      && /working_directory/.test(error.message),
  );
  await assert.rejects(
    dispatchControl('status', { recent_limit: 0, unexpected: true }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_argument'
      && /unexpected/.test(error.message),
  );
});

test('preflight rejects a caller fingerprint mismatch before dispatch', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-fingerprint-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
  await writeFile(path.join(directory, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', directory,
    '-c', 'user.name=Codex-Co-Engineer Test',
    '-c', 'user.email=codex-co-engineer@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const { dispatchControl, ToolError } = await import(`../mcp/control.mjs?fingerprint=${Date.now()}`);
  await assert.rejects(
    dispatchControl('preflight', {
      schema_version: 'codex-co-engineer.config.v1',
      target_context: {
        schema_version: 'codex-co-engineer.target.v1',
        mode: 'explicit',
        working_directory: directory,
        expected_git_root: directory,
        expected_head: head,
        allowed_paths: ['.'],
        role: 'review',
      },
      expected_target_fingerprint: '0'.repeat(64),
    }),
    (error) => error instanceof ToolError && error.code === 'target_fingerprint_mismatch',
  );
});
