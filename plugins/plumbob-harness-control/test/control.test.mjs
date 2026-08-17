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

test('status probes Grok independently of a missing default workspace', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-grok-status-test-'));
  const state = path.join(directory, 'state');
  const missingWorkspace = path.join(directory, 'missing-default-workspace');
  const fakeGrok = path.join(directory, 'grok');
  await writeFile(fakeGrok, '#!/bin/sh\nprintf "grok 1.0.4 (test)\\n"\n', { mode: 0o755 });

  const previous = {
    command: process.env.CODEX_CO_ENGINEER_GROK_COMMAND,
    workspace: process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
  };
  process.env.CODEX_CO_ENGINEER_GROK_COMMAND = fakeGrok;
  process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE = missingWorkspace;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_GROK_COMMAND;
    else process.env.CODEX_CO_ENGINEER_GROK_COMMAND = previous.command;
    if (previous.workspace === undefined) delete process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE;
    else process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE = previous.workspace;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    await rm(directory, { recursive: true, force: true });
  });

  const { dispatchControl } = await import(`../mcp/control.mjs?grok-status=${Date.now()}`);
  const status = await dispatchControl('status', { recent_limit: 0 });
  assert.equal(status.targeting.default_workspace, missingWorkspace);
  assert.equal(status.grok_build.availability, 'installed');
  assert.equal(status.grok_build.executable_state, 'installed');
  assert.match(status.grok_build.version, /grok 1\.0\.4/);
  assert.deepEqual(status.grok_build.sandbox, {
    managed_by: 'grok_cli',
    enforcement: 'cli_managed',
  });

  const diagnosticStatus = await dispatchControl('status', { recent_limit: 0, diagnostics: true });
  assert.equal(diagnosticStatus.diagnostics.grok_build.ok, true);
  assert.equal(diagnosticStatus.diagnostics.grok_build.auth_state, 'ready');
  assert.equal(diagnosticStatus.grok_build.auth_state, 'ready');
  assert.equal(diagnosticStatus.grok_build.ready, true);
  assert.equal(diagnosticStatus.grok_build.auth_note, diagnosticStatus.diagnostics.grok_build.note);
  await writeFile(fakeGrok, `#!/bin/sh
if [ "$1" = "models" ]; then
  printf "login required: credentials unavailable\\n" >&2
  exit 1
fi
printf "grok 1.0.4 (test)\\n"
`, { mode: 0o755 });
  const failedDiagnosticStatus = await dispatchControl('status', { recent_limit: 0, diagnostics: true });
  assert.equal(failedDiagnosticStatus.diagnostics.grok_build.ok, false);
  assert.equal(failedDiagnosticStatus.diagnostics.grok_build.auth_state, 'unauthenticated');
  assert.equal(failedDiagnosticStatus.grok_build.auth_state, 'unauthenticated');
  assert.equal(failedDiagnosticStatus.grok_build.ready, false);
  assert.equal(failedDiagnosticStatus.grok_build.auth_note, failedDiagnosticStatus.diagnostics.grok_build.note);
});

test('status and jobs list expose bounded job summaries while jobs get keeps detail', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-compact-status-test-'));
  const state = directory;
  const fakeGrok = path.join(directory, 'grok');
  await writeFile(fakeGrok, '#!/bin/sh\nprintf "grok 1.0.4 (test)\\n"\n', { mode: 0o755 });
  const createdAt = new Date(Date.now() - 5000).toISOString();
  const targetContext = {
    schema_version: 'codex-co-engineer.target.v1',
    mode: 'explicit',
    working_directory: directory,
    expected_git_root: directory,
    expected_head: 'a'.repeat(40),
    allowed_paths: ['.'],
    role: 'review',
    prompt_should_not_escape: 'private-target-contract',
  };
  const effectiveConfiguration = {
    kind: 'grok_build',
    model: 'grok-4.6',
    prompt: 'private prompt that must remain available only through jobs get',
    target_fingerprint: 'sha256:' + 'b'.repeat(64),
    configuration_digest: 'sha256:' + 'c'.repeat(64),
  };
  const database = openStore(path.join(state, 'control.sqlite3'));
  insertJob(database, {
    id: 'grok-build-compact-1234',
    kind: 'grok_build',
    status: 'succeeded',
    summary: 'private summary that should not be copied into routine status',
    created_at: createdAt,
    updated_at: createdAt,
    started_at: createdAt,
    finished_at: new Date().toISOString(),
    elapsed_seconds: 4.2,
    termination_reason: 'x'.repeat(1000),
    effective_configuration: JSON.stringify(effectiveConfiguration),
    target_context: JSON.stringify(targetContext),
    log_file: path.join(state, 'job.log'),
    cancel_file: path.join(state, 'job.cancel'),
    log_bytes: 987654,
  });
  database.close();

  const previous = {
    command: process.env.CODEX_CO_ENGINEER_GROK_COMMAND,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
    workspace: process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE,
  };
  process.env.CODEX_CO_ENGINEER_GROK_COMMAND = fakeGrok;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE = directory;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_GROK_COMMAND;
    else process.env.CODEX_CO_ENGINEER_GROK_COMMAND = previous.command;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    if (previous.workspace === undefined) delete process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE;
    else process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE = previous.workspace;
    await rm(directory, { recursive: true, force: true });
  });

  const { dispatchControl } = await import(`../mcp/control.mjs?compact-status=${Date.now()}`);
  const status = await dispatchControl('status', { recent_limit: 1 });
  const recent = status.jobs.recent;
  assert.equal(recent.length, 1);
  assert.deepEqual(recent[0], {
    id: 'grok-build-compact-1234',
    kind: 'grok_build',
    role: 'review',
    status: 'completed',
    terminal_state: 'completed',
    failure_class: null,
    created_at: createdAt,
    started_at: createdAt,
    finished_at: recent[0].finished_at,
    deadline_at: null,
    last_activity_at: null,
    elapsed_seconds: 4.2,
    stalled: null,
    termination_reason: `${'x'.repeat(159)}…`,
    partial_output_available: null,
    workspace_changed: null,
    workspace_tainted: null,
    log_bytes: 987654,
  });
  const serializedStatus = JSON.stringify(status);
  assert.ok(serializedStatus.length < 5000, `status should remain compact (${serializedStatus.length} bytes)`);
  assert.doesNotMatch(serializedStatus, /private prompt|private-target-contract|effective_configuration|lifecycle/);

  const listed = await dispatchControl('jobs', { action: 'list', limit: 1 });
  assert.deepEqual(listed.jobs[0], recent[0]);
  const detailed = await dispatchControl('jobs', { action: 'get', job_id: 'grok-build-compact-1234', tail_lines: 0 });
  assert.equal(detailed.job.effective_configuration.prompt, effectiveConfiguration.prompt);
  assert.equal(detailed.job.target_context.prompt_should_not_escape, targetContext.prompt_should_not_escape);
  assert.ok(Array.isArray(detailed.job.lifecycle));
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
