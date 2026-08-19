import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    requested_profile: 'read-only_for_review_verify',
    enforcement: 'fallback_warning_fail_closed_runner_postflight',
    writable_builtin_roots: 'rejected_for_review_verify',
  });
  assert.deepEqual(status.grok_build.capabilities.transport, {
    selected: 'direct-headless',
    acp: 'not_exposed',
  });
  assert.equal(status.grok_build.capabilities.main_session_profile.effective, 'unknown');
  assert.equal(status.grok_build.capabilities.delegation.requested, 'cli-default');
  assert.equal(status.grok_build.capabilities.delegation.effective, 'unknown');

  const diagnosticStatus = await dispatchControl('status', { recent_limit: 0, diagnostics: true });
  assert.equal(diagnosticStatus.diagnostics.grok_build.ok, true);
  assert.equal(diagnosticStatus.diagnostics.grok_build.auth_state, 'ready');
  assert.equal(diagnosticStatus.grok_build.auth_state, 'ready');
  assert.equal(diagnosticStatus.grok_build.ready, true);
  assert.equal(diagnosticStatus.grok_build.auth_note, diagnosticStatus.diagnostics.grok_build.note);
  await writeFile(fakeGrok, `#!/bin/sh
if [ "$1" = "models" ]; then
  printf "You are not authenticated.\nDefault model: grok-4.6\n"
  exit 0
fi
printf "grok 1.0.4 (test)\n"
`, { mode: 0o755 });
  const misleadingSuccessStatus = await dispatchControl('status', { recent_limit: 0, diagnostics: true });
  assert.equal(misleadingSuccessStatus.diagnostics.grok_build.ok, false);
  assert.equal(misleadingSuccessStatus.diagnostics.grok_build.auth_state, 'unauthenticated');
  assert.equal(misleadingSuccessStatus.grok_build.auth_state, 'unauthenticated');
  assert.equal(misleadingSuccessStatus.grok_build.ready, false);
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
  await writeFile(path.join(state, 'job.log'), [
    JSON.stringify({ type: 'reasoning', text: 'private chain of thought must not be returned' }),
    JSON.stringify({ type: 'text', text: 'final actionable finding' }),
    JSON.stringify({ type: 'result', result: { status: 'completed' } }),
  ].join('\n') + '\n');
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
  assert.equal(detailed.final_response.text, 'final actionable finding');
  assert.equal(detailed.final_response.source, 'grok_streaming_json');
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

test('active workspace locking does not depend on the bounded recent-job list', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-active-lock-query-test-'));
  const state = path.join(directory, 'state');
  const target = path.join(directory, 'target');
  await mkdir(target);
  assert.equal(spawnSync('git', ['init', '-q', target]).status, 0);
  await writeFile(path.join(target, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', target, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', target,
    '-c', 'user.name=Co-Engineer Test',
    '-c', 'user.email=co-engineer-test@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  const previousState = process.env.CODEX_CO_ENGINEER_STATE_DIR;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  context.after(async () => {
    if (previousState === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previousState;
    await rm(directory, { recursive: true, force: true });
  });

  const { __testing, ToolError } = await import(`../mcp/control.mjs?active-lock-query=${Date.now()}`);
  await mkdir(state, { mode: 0o700 });
  const database = openStore(path.join(state, 'control.sqlite3'));
  const newest = Date.now();
  for (let index = 0; index < 120; index += 1) {
    const createdAt = new Date(newest - index * 1000).toISOString();
    insertJob(database, {
      id: `completed-recent-${index}`,
      kind: 'deepseek_agent',
      status: 'succeeded',
      lifecycle_state: 'completed',
      terminal_state: 'completed',
      summary: 'recent terminal fixture',
      created_at: createdAt,
      updated_at: createdAt,
      finished_at: createdAt,
      log_file: path.join(state, `completed-${index}.log`),
      cancel_file: path.join(state, `completed-${index}.cancel`),
    });
  }
  const activeCreatedAt = new Date(newest - 121000).toISOString();
  insertJob(database, {
    id: 'active-old-agent',
    kind: 'deepseek_agent',
    status: 'running',
    lifecycle_state: 'working',
    summary: 'old active fixture',
    created_at: activeCreatedAt,
    updated_at: activeCreatedAt,
    child_pid: process.pid,
    log_file: path.join(state, 'active.log'),
    cancel_file: path.join(state, 'active.cancel'),
    target_context: JSON.stringify({
      working_directory: target,
      expected_git_root: target,
      git_common_directory: path.join(target, '.git'),
      role: 'implement',
    }),
    effective_configuration: JSON.stringify({ working_directory: target }),
  });
  database.close();

  await assert.rejects(
    __testing.startAgentJob({
      working_directory: target,
      expected_git_root: target,
      git_common_directory: path.join(target, '.git'),
    }, () => 'must-not-start'),
    (error) => error instanceof ToolError
      && error.code === 'workspace_busy'
      && /active-old-agent/.test(error.message),
  );
  const active = await __testing.listActiveJobs();
  assert.deepEqual(active.map((job) => job.id), ['active-old-agent']);
});

test('cancellation persists before child ownership is proven and never signals a foreign PID', async (context) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'plumbob-cancel-intent-test-'));
  const previousState = process.env.CODEX_CO_ENGINEER_STATE_DIR;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  context.after(async () => {
    if (previousState === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previousState;
    await rm(state, { recursive: true, force: true });
  });

  const { dispatchControl } = await import(`../mcp/control.mjs?cancel-intent=${Date.now()}`);
  const database = openStore(path.join(state, 'control.sqlite3'));
  const foreignCancelFile = path.join(state, 'foreign.cancel');
  insertJob(database, {
    id: 'foreign-running-job',
    kind: 'grok_build',
    status: 'running',
    lifecycle_state: 'working',
    summary: 'foreign PID fixture',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    child_pid: process.pid,
    log_file: path.join(state, 'foreign.log'),
    cancel_file: foreignCancelFile,
  });
  const acceptedCancelFile = path.join(state, 'accepted.cancel');
  insertJob(database, {
    id: 'accepted-no-child-job',
    kind: 'deepseek_agent',
    status: 'queued',
    lifecycle_state: 'accepted',
    summary: 'accepted cancellation fixture',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    log_file: path.join(state, 'accepted.log'),
    cancel_file: acceptedCancelFile,
  });
  database.close();

  const foreign = await dispatchControl('cancel', { job_id: 'foreign-running-job' });
  assert.equal(foreign.ok, true);
  assert.equal(foreign.job.termination_reason, 'cancel_requested');
  assert.equal(foreign.job.signal_sent, null);
  assert.equal(foreign.job.status, 'working');
  assert.match(await readFile(foreignCancelFile, 'utf8'), /T/);

  const accepted = await dispatchControl('cancel', { job_id: 'accepted-no-child-job' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.job.terminal_state, 'cancelled');
  assert.match(await readFile(acceptedCancelFile, 'utf8'), /T/);
});

test('DSH web permission follows the target role', async () => {
  const { __testing } = await import(`../mcp/control.mjs?dsh-web-permission=${Date.now()}`);
  assert.equal(__testing.dshWebPermissionMode('review'), 'read-only');
  assert.equal(__testing.dshWebPermissionMode('verify'), 'read-only');
  assert.equal(__testing.dshWebPermissionMode('implement'), 'workspace-write');
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

test('capacity dispatch validates bounded provider selectors before any provider call', async () => {
  const { dispatchControl, ToolError } = await import(`../mcp/control.mjs?capacity-validation=${Date.now()}`);
  await assert.rejects(
    dispatchControl('capacity', { unexpected: true }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_argument'
      && /unexpected/.test(error.message),
  );
  await assert.rejects(
    dispatchControl('capacity', { providers: ['codex', 'codex'] }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_options'
      && /duplicate/.test(error.message),
  );
  await assert.rejects(
    dispatchControl('capacity', { max_age_seconds: 3601 }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_options'
      && /max_age_seconds/.test(error.message),
  );
});

test('production Grok capacity uses the administrator-selected executable', async (context) => {
  const previousCommand = process.env.CODEX_CO_ENGINEER_GROK_COMMAND;
  // This path must not be silently replaced by the literal `grok` fallback.
  process.env.CODEX_CO_ENGINEER_GROK_COMMAND = '/definitely/missing/codex-test-grok';
  context.after(() => {
    if (previousCommand === undefined) delete process.env.CODEX_CO_ENGINEER_GROK_COMMAND;
    else process.env.CODEX_CO_ENGINEER_GROK_COMMAND = previousCommand;
  });
  const { dispatchControl } = await import(`../mcp/control.mjs?grok-capacity-command=${Date.now()}`);
  const result = await dispatchControl('capacity', {
    providers: ['grok'],
    refresh: true,
    max_age_seconds: 0,
  });
  assert.equal(result.providers[0].status, 'unavailable');
  assert.deepEqual(result.providers[0].error, { code: 'capacity_query_failed' });
});

test('production Grok capacity sends bounded RPC to the selected executable from safe cwd', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-grok-capacity-selected-test-'));
  const state = path.join(directory, 'state');
  const invocation = path.join(directory, 'invocation.jsonl');
  const fakeGrok = path.join(directory, 'selected-grok');
  const fakeProgram = [
    '#!/usr/bin/env node',
    "const { appendFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(invocation)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');`,
    "let buffer = '';",
    'function respond(request) {',
    "  const result = request.method === 'initialize' ? { protocolVersion: 1, authMethods: [] } : { config: { creditUsagePercent: 17 } };",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
    '}',
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { buffer += chunk; let newline; while ((newline = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line.trim()) respond(JSON.parse(line)); } });",
    'process.stdin.resume();',
    'const keepAlive = setInterval(() => {}, 1000);',
    "process.stdin.on('end', () => clearInterval(keepAlive));",
  ].join('\n');
  await writeFile(fakeGrok, fakeProgram, { mode: 0o700 });
  const previous = {
    command: process.env.CODEX_CO_ENGINEER_GROK_COMMAND,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
  };
  process.env.CODEX_CO_ENGINEER_GROK_COMMAND = fakeGrok;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_GROK_COMMAND;
    else process.env.CODEX_CO_ENGINEER_GROK_COMMAND = previous.command;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    await rm(directory, { recursive: true, force: true });
  });
  const { dispatchControl } = await import(`../mcp/control.mjs?grok-capacity-selected=${Date.now()}`);
  const result = await dispatchControl('capacity', {
    providers: ['grok'],
    refresh: true,
    max_age_seconds: 0,
  });
  assert.equal(result.providers[0].status, 'available');
  assert.equal(result.providers[0].capacity.used_percent, 17);
  const calls = (await readFile(invocation, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(calls, [{ argv: ['agent', 'stdio'], cwd: '/' }]);
});

test('preflight rejects a caller fingerprint mismatch before dispatch', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-fingerprint-test-'));
  const state = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-grok-profile-state-'));
  const previous = {
    command: process.env.CODEX_CO_ENGINEER_GROK_COMMAND,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
  };
  process.env.CODEX_CO_ENGINEER_GROK_COMMAND = '/bin/true';
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_GROK_COMMAND;
    else process.env.CODEX_CO_ENGINEER_GROK_COMMAND = previous.command;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    await rm(directory, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
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
  const { __testing, dispatchControl, ToolError } = await import(`../mcp/control.mjs?fingerprint=${Date.now()}`);
  const targetContext = {
    schema_version: 'codex-co-engineer.target.v1',
    mode: 'explicit',
    working_directory: directory,
    expected_git_root: directory,
    expected_head: head,
    allowed_paths: ['.'],
    role: 'review',
  };
  await assert.rejects(
    dispatchControl('preflight', {
      schema_version: 'codex-co-engineer.config.v1',
      target_context: targetContext,
      expected_target_fingerprint: '0'.repeat(64),
    }),
    (error) => error instanceof ToolError && error.code === 'target_fingerprint_mismatch',
  );

  const prepared = await __testing.prepareTarget(targetContext);
  await assert.rejects(
    dispatchControl('preflight', {
      schema_version: 'codex-co-engineer.config.v1',
      kind: 'grok_build',
      target_context: targetContext,
      expected_target_fingerprint: prepared.targetFingerprint,
      agent: 'project-review',
      delegation: { enabled: false },
    }),
    (error) => error instanceof ToolError
      && error.code === 'grok_read_only_target_unverifiable'
      && /built-in read-only profile permits provider writes/.test(error.message),
  );
});

test('staging enforces one absolute deadline across Git and checkout scans', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-stage-deadline-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { __testing, ToolError } = await import(`../mcp/control.mjs?stage-deadline=${Date.now()}`);
  await assert.rejects(
    __testing.runStageGit(
      ['-c', 'alias.codex-deadline-wait=!sleep 5', 'codex-deadline-wait'],
      'bounded staging deadline test',
      Date.now() + 100,
    ),
    (error) => error instanceof ToolError && error.code === 'target_stage_timeout',
  );
  await assert.rejects(
    __testing.assertStageSize(directory, Date.now() - 1),
    (error) => error instanceof ToolError && error.code === 'target_stage_timeout',
  );
});

test('local annotated tags resolve and bind their peeled commit', async (context) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-annotated-tag-test-'));
  context.after(() => rm(repository, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
  await writeFile(path.join(repository, 'note.txt'), 'annotated\n');
  assert.equal(spawnSync('git', ['-C', repository, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', repository,
    '-c', 'user.name=Codex-Co-Engineer Test',
    '-c', 'user.email=codex-co-engineer@example.invalid',
    'commit', '-qm', 'annotated',
  ]).status, 0);
  const head = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(spawnSync('git', [
    '-C', repository,
    '-c', 'user.name=Codex-Co-Engineer Test',
    '-c', 'user.email=codex-co-engineer@example.invalid',
    'tag', '-a', 'annotated-release', '-m', 'annotated release',
  ]).status, 0);
  const { __testing } = await import(`../mcp/control.mjs?annotated-ref=${Date.now()}`);
  const resolved = await __testing.resolveLocalRef(
    repository,
    'refs/tags/annotated-release',
    head,
    Date.now() + 5000,
  );
  assert.deepEqual(resolved, { ref: 'refs/tags/annotated-release', commit: head });
  const remoteResolved = await __testing.resolveGithubRef(
    repository,
    'refs/tags/annotated-release',
    Date.now() + 5000,
  );
  assert.deepEqual(remoteResolved, { ref: 'refs/tags/annotated-release', commit: head });
});

test('control-plane binding computes the fingerprint and stages a clean local source outside its original path', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-staging-test-'));
  // Keep the source outside /tmp so the provider-writable-root policy can
  // prove that only the staged copy is exposed when state itself is temporary.
  const source = path.join(process.cwd(), `.codex-co-engineer-staging-source-${path.basename(directory)}`);
  // Use an owner-controlled, non-provider-writable host location. The staged
  // workflow intentionally rejects state beneath broad writable roots such as
  // /tmp and /mnt/d, and the fixture must remain portable across CI users.
  const state = path.join(
    os.homedir(),
    '.local',
    'state',
    `codex-co-engineer-staging-state-${path.basename(directory)}`,
  );
  await mkdir(source);
  assert.equal(spawnSync('git', ['init', '-q', source]).status, 0);
  await writeFile(path.join(source, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', source, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', source,
    '-c', 'user.name=Codex-Co-Engineer Test',
    '-c', 'user.email=codex-co-engineer@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  const previous = {
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
    roots: process.env.CODEX_CO_ENGINEER_ALLOWED_ROOTS,
  };
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  delete process.env.CODEX_CO_ENGINEER_ALLOWED_ROOTS;
  context.after(async () => {
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    if (previous.roots === undefined) delete process.env.CODEX_CO_ENGINEER_ALLOWED_ROOTS;
    else process.env.CODEX_CO_ENGINEER_ALLOWED_ROOTS = previous.roots;
    await rm(source, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });

  const { __testing, dispatchControl, ToolError } = await import(`../mcp/control.mjs?staging=${Date.now()}`);
  const staged = await dispatchControl('preflight', {
    schema_version: 'codex-co-engineer.config.v1',
    kind: 'grok_build',
    target_binding: 'control_plane',
    target_context: {
      schema_version: 'codex-co-engineer.target.v1',
      mode: 'staged',
      source: { type: 'local', path: source },
      role: 'review',
    },
  });
  assert.equal(staged.target_binding, 'control_plane');
  assert.equal(staged.expected_target_fingerprint, staged.target_fingerprint);
  assert.notEqual(staged.resolved_workspace, source);
  assert.match(staged.resolved_workspace, /\/targets\/lease-[0-9a-f]{64}\/checkout$/);
  assert.equal(staged.configuration.target_context.target_origin, 'control_plane_staged');
  assert.equal(await stat(staged.resolved_workspace).then((value) => value.isDirectory()), true);
  const leasePath = path.join(path.dirname(staged.resolved_workspace), 'lease.json');
  const lease = JSON.parse(await readFile(leasePath, 'utf8'));
  assert.equal(lease.schema_version, 'codex-co-engineer.target-lease.v1');
  assert.equal(lease.resolved_head, staged.configuration.target_context.expected_head);

  const stagedAgain = await dispatchControl('preflight', {
    schema_version: 'codex-co-engineer.config.v1',
    kind: 'grok_build',
    target_binding: 'control_plane',
    target_context: {
      schema_version: 'codex-co-engineer.target.v1',
      mode: 'staged',
      source: { type: 'local', path: source },
      role: 'review',
    },
  });
  assert.equal(stagedAgain.resolved_workspace, staged.resolved_workspace);
  assert.equal(stagedAgain.target_fingerprint, staged.target_fingerprint);

  // Expired inactive leases are reclaimed before the next staging request;
  // the deterministic descriptor still gives the caller the same checkout.
  await writeFile(leasePath, JSON.stringify({
    ...lease,
    last_used_at: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString(),
  }));
  const stagedAfterExpiry = await dispatchControl('preflight', {
    schema_version: 'codex-co-engineer.config.v1',
    kind: 'grok_build',
    target_binding: 'control_plane',
    target_context: {
      schema_version: 'codex-co-engineer.target.v1',
      mode: 'staged',
      source: { type: 'local', path: source },
      role: 'review',
    },
  });
  assert.equal(stagedAfterExpiry.resolved_workspace, staged.resolved_workspace);

  const explicit = await dispatchControl('preflight', {
    schema_version: 'codex-co-engineer.config.v1',
    target_binding: 'control_plane',
    target_context: {
      schema_version: 'codex-co-engineer.target.v1',
      mode: 'explicit',
      working_directory: source,
      expected_git_root: source,
      expected_head: spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      allowed_paths: ['.'],
      role: 'review',
    },
  });
  assert.equal(explicit.target_binding, 'control_plane');
  assert.equal(explicit.target_fingerprint, explicit.expected_target_fingerprint);
  const sourceHead = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const reviewIdentity = await __testing.prepareTarget({
    schema_version: 'codex-co-engineer.target.v1',
    mode: 'explicit',
    working_directory: source,
    expected_git_root: source,
    expected_head: sourceHead,
    allowed_paths: ['.'],
    role: 'review',
  });
  const verifyIdentity = await __testing.prepareTarget({
    schema_version: 'codex-co-engineer.target.v1',
    mode: 'explicit',
    working_directory: source,
    expected_git_root: source,
    expected_head: sourceHead,
    allowed_paths: ['note.txt'],
    role: 'verify',
  });
  assert.notEqual(reviewIdentity.targetFingerprint, verifyIdentity.targetFingerprint);
  await assert.rejects(
    dispatchControl('preflight', {
      schema_version: 'codex-co-engineer.config.v1',
      target_binding: 'control_plane',
      target_context: {
        schema_version: 'codex-co-engineer.target.v1',
        mode: 'staged',
        source: { type: 'github', repository: 'https://github.com/example/repo?token=bad' },
        role: 'review',
      },
    }),
    (error) => error instanceof ToolError && error.code === 'invalid_target_source',
  );
});

test('managed DSH options flow through preflight, run configuration, and child environment', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-control-test-'));
  const state = path.join(directory, 'state');
  const targetDirectory = path.join(directory, 'target');
  const fakeDsh = path.join(directory, 'dsh');
  await mkdir(targetDirectory);
  assert.equal(spawnSync('git', ['init', '-q', targetDirectory]).status, 0);
  await writeFile(path.join(targetDirectory, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', targetDirectory, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', targetDirectory,
    '-c', 'user.name=Co-Engineer Test',
    '-c', 'user.email=co-engineer-test@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  await writeFile(fakeDsh, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "--version" ]; then printf 'dsh 0.1.0-rc.6\\n'; exit 0; fi
  if [ "$argument" = "--dump-config" ]; then
    mkdir -p "$DSH_HOME/profiles/headless"
    chmod 700 "$DSH_HOME" "$DSH_HOME/profiles" "$DSH_HOME/profiles/headless"
    printf '{}\\n' > "$DSH_HOME/profiles/headless/package.json"
    chmod 600 "$DSH_HOME/profiles/headless/package.json"
    exit 0
  fi
done
if [ -n "$MODEL_API_KEY" ]; then credential=present; else credential=missing; fi
printf '%s|%s|%s|%s|%s|%s\\n' "$DSH_TOOLS_MODE" "$CODEX_CO_ENGINEER_DSH_MODEL" "$CODEX_CO_ENGINEER_DSH_MAX_TOKENS" "$CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER" "$CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH" "$credential" > "$DSH_HOME/child-env.txt"
printf 'completed fixture\\n'
`, { mode: 0o755 });
  const previous = {
    command: process.env.CODEX_CO_ENGINEER_DSH_COMMAND,
    home: process.env.CODEX_CO_ENGINEER_DSH_HOME,
    dshHome: process.env.DSH_HOME,
    key: process.env.MODEL_API_KEY,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
    workspace: process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE,
  };
  process.env.CODEX_CO_ENGINEER_DSH_COMMAND = fakeDsh;
  delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
  delete process.env.DSH_HOME;
  process.env.MODEL_API_KEY = 'test-only-placeholder';
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE = targetDirectory;
  context.after(async () => {
    for (const [name, value] of Object.entries({
      CODEX_CO_ENGINEER_DSH_COMMAND: previous.command,
      CODEX_CO_ENGINEER_DSH_HOME: previous.home,
      DSH_HOME: previous.dshHome,
      MODEL_API_KEY: previous.key,
      CODEX_CO_ENGINEER_STATE_DIR: previous.state,
      CODEX_CO_ENGINEER_RUNTIME_WORKSPACE: previous.workspace,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  const { __testing, dispatchControl, ToolError } = await import(`../mcp/control.mjs?dsh-profile=${Date.now()}`);
  const head = spawnSync('git', ['-C', targetDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const targetContext = {
    schema_version: 'codex-co-engineer.target.v1',
    mode: 'explicit',
    working_directory: targetDirectory,
    expected_git_root: targetDirectory,
    expected_head: head,
    allowed_paths: ['.'],
    role: 'review',
  };
  const prepared = await __testing.prepareTarget(targetContext);
  const dshOptions = {
    model: 'muse-spark-1.2-contributor',
    tool_mode: 'both',
    max_tokens: 4096,
  };
  const status = await dispatchControl('status', { recent_limit: 0 });
  assert.equal(status.headless_agent.capability_state, 'verified-managed-overlay');
  assert.equal(status.headless_agent.capabilities.model.connector_input_modalities[0], 'text');
  assert.equal(status.headless_agent.capabilities.execution.image_input_exposed, false);

  const preflight = await dispatchControl('preflight', {
    schema_version: 'codex-co-engineer.config.v1',
    kind: 'deepseek_agent',
    target_context: targetContext,
    expected_target_fingerprint: prepared.targetFingerprint,
    dsh_options: dshOptions,
  });
  assert.deepEqual(preflight.configuration.dsh_configuration, dshOptions);
  assert.equal(preflight.capabilities.deepseek_agent.tools.effective_mode, 'both');
  assert.equal(preflight.capabilities.deepseek_agent.delegation.subagent.background_mode, 'continuable');
  assert.equal(preflight.capabilities.deepseek_agent.delegation.fork.background_mode, 'one-shot');
  await assert.rejects(
    dispatchControl('preflight', {
      schema_version: 'codex-co-engineer.config.v1',
      kind: 'deepseek_agent',
      target_context: targetContext,
      expected_target_fingerprint: prepared.targetFingerprint,
      dsh_options: { workflow: true },
    }),
    (error) => error instanceof ToolError
      && error.code === 'invalid_dsh_configuration'
      && /workflow/.test(error.message),
  );

  const run = await dispatchControl('run', {
    schema_version: 'codex-co-engineer.config.v1',
    kind: 'deepseek_agent',
    request_id: 'dsh-profile-run-1',
    prompt: 'Review the fixture without changing it.',
    target_context: targetContext,
    expected_target_fingerprint: prepared.targetFingerprint,
    dsh_options: dshOptions,
  });
  assert.deepEqual(run.effective_configuration.dsh_configuration, dshOptions);
  const terminal = await dispatchControl('jobs', {
    action: 'wait', job_id: run.job.id, wait_seconds: 10, until: 'terminal', tail_lines: 0,
  });
  assert.equal(terminal.job.status, 'completed');
  assert.deepEqual(
    (await readFile(path.join(state, 'dsh-home', 'child-env.txt'), 'utf8')).trim().split('|'),
    [
      'both',
      'muse-spark-1.2-contributor',
      '4096',
      '1',
      path.join(state, 'jobs', `${run.job.id}.usage.json`),
      'present',
    ],
  );
});

test('custom DSH homes keep capability status unknown', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-custom-home-test-'));
  const customHome = path.join(directory, 'custom-home');
  const state = path.join(directory, 'state');
  const fakeDsh = path.join(directory, 'dsh');
  await writeFile(fakeDsh, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "--version" ]; then printf 'dsh 0.1.0-rc.6\\n'; exit 0; fi
  if [ "$argument" = "--dump-config" ]; then
    mkdir -p "$DSH_HOME/profiles/headless"
    printf '{}\\n' > "$DSH_HOME/profiles/headless/package.json"
    exit 0
  fi
done
exit 0
`, { mode: 0o755 });
  const previous = {
    command: process.env.CODEX_CO_ENGINEER_DSH_COMMAND,
    home: process.env.CODEX_CO_ENGINEER_DSH_HOME,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
  };
  process.env.CODEX_CO_ENGINEER_DSH_COMMAND = fakeDsh;
  process.env.CODEX_CO_ENGINEER_DSH_HOME = customHome;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = state;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_COMMAND;
    else process.env.CODEX_CO_ENGINEER_DSH_COMMAND = previous.command;
    if (previous.home === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
    else process.env.CODEX_CO_ENGINEER_DSH_HOME = previous.home;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    await rm(directory, { recursive: true, force: true });
  });
  const { dispatchControl } = await import(`../mcp/control.mjs?dsh-custom=${Date.now()}`);
  const status = await dispatchControl('status', { recent_limit: 0 });
  assert.equal(status.headless_agent.usable, true);
  assert.equal(status.headless_agent.capability_state, 'unknown');
  assert.equal(Object.hasOwn(status.headless_agent, 'capabilities'), false);
});

test('only verified managed DeepSeek jobs receive exact connector-owned usage env', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-usage-env-test-'));
  const previous = {
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
    home: process.env.CODEX_CO_ENGINEER_DSH_HOME,
    dshHome: process.env.DSH_HOME,
  };
  process.env.CODEX_CO_ENGINEER_STATE_DIR = directory;
  delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
  delete process.env.DSH_HOME;
  context.after(async () => {
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    if (previous.home === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
    else process.env.CODEX_CO_ENGINEER_DSH_HOME = previous.home;
    if (previous.dshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.dshHome;
    await rm(directory, { recursive: true, force: true });
  });

  const { __testing } = await import(`../mcp/control.mjs?dsh-usage-env=${Date.now()}`);
  const jobId = 'deepseek-usage-1234';
  const configuredOnly = __testing.startJobEnvironment('deepseek_agent', jobId, {
    CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER: 'provider-value',
    CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH: '/provider/receipt.json',
    DSH_HOME: '/managed/home',
  });
  assert.equal(Object.hasOwn(configuredOnly, 'CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER'), false);
  assert.equal(Object.hasOwn(configuredOnly, 'CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH'), false);
  assert.equal(configuredOnly.DSH_HOME, '/managed/home');

  const environment = __testing.startJobEnvironment('deepseek_agent', jobId, {
    CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER: 'provider-value',
    CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH: '/provider/receipt.json',
    DSH_HOME: '/managed/home',
  }, { ok: true });
  assert.equal(environment.CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER, '1');
  assert.equal(
    environment.CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH,
    path.join(directory, 'jobs', `${jobId}.usage.json`),
  );
  assert.equal(environment.DSH_HOME, '/managed/home');
  const webEnvironment = __testing.startJobEnvironment('dsh_web', jobId, {
    CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER: 'provider-value',
    CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH: '/provider/receipt.json',
  }, { ok: true });
  assert.equal(Object.hasOwn(webEnvironment, 'CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER'), false);
  assert.equal(Object.hasOwn(webEnvironment, 'CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH'), false);
});

test('production DSH capacity is bound to terminal managed jobs and jobs get exposes only compact usage', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-capacity-integration-test-'));
  const jobsDirectory = path.join(directory, 'jobs');
  await mkdir(jobsDirectory, { mode: 0o700 });
  const fakeDsh = path.join(directory, 'dsh');
  const probeFile = path.join(directory, 'dsh-home.probe');
  await writeFile(fakeDsh, `#!/bin/sh
printf 'probe\\n' >> "$DSH_HOME.probe"
for argument in "$@"; do
  if [ "$argument" = "--version" ]; then printf 'dsh 0.1.0-rc.6\\n'; exit 0; fi
  if [ "$argument" = "--dump-config" ]; then
    mkdir -p "$DSH_HOME/profiles/headless"
    chmod 700 "$DSH_HOME" "$DSH_HOME/profiles" "$DSH_HOME/profiles/headless"
    printf '{}\\n' > "$DSH_HOME/profiles/headless/package.json"
    chmod 600 "$DSH_HOME/profiles/headless/package.json"
    exit 0
  fi
done
exit 64
`, { mode: 0o755 });
  const jobId = 'deepseek-capacity-1234';
  const logFile = path.join(jobsDirectory, `${jobId}.log`);
  const cancelFile = path.join(jobsDirectory, `${jobId}.cancel`);
  await writeFile(logFile, '', { mode: 0o600 });
  const previous = {
    command: process.env.CODEX_CO_ENGINEER_DSH_COMMAND,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
    home: process.env.CODEX_CO_ENGINEER_DSH_HOME,
    dshHome: process.env.DSH_HOME,
  };
  process.env.CODEX_CO_ENGINEER_DSH_COMMAND = fakeDsh;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = directory;
  delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
  delete process.env.DSH_HOME;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_COMMAND;
    else process.env.CODEX_CO_ENGINEER_DSH_COMMAND = previous.command;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    if (previous.home === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
    else process.env.CODEX_CO_ENGINEER_DSH_HOME = previous.home;
    if (previous.dshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.dshHome;
    await rm(directory, { recursive: true, force: true });
  });

  const database = openStore(path.join(directory, 'control.sqlite3'));
  insertJob(database, {
    id: jobId,
    kind: 'deepseek_agent',
    status: 'succeeded',
    summary: 'DSH capacity integration fixture',
    created_at: new Date(Date.now() - 1000).toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(path.join(jobsDirectory, `${jobId}.usage.json`), JSON.stringify({
    schemaVersion: 1,
    source: 'dsh-headless-live',
    scope: 'task',
    jobId,
    rootSessionId: 'session-capacity-opaque',
    observedAt: new Date().toISOString(),
    aggregationComplete: true,
    confidence: 'exact',
    usageSamples: 1,
    counts: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 18,
    },
    secret_provider_field: 'must-not-escape',
  }) + '\n', { mode: 0o600 });

  const { dispatchControl } = await import(`../mcp/control.mjs?dsh-capacity-integration=${Date.now()}`);
  const accountCapacity = await dispatchControl('capacity', { providers: ['dsh'] });
  assert.equal(accountCapacity.providers[0].status, 'unsupported');
  await assert.rejects(readFile(probeFile), { code: 'ENOENT' });
  const capacity = await dispatchControl('capacity', {
    providers: ['dsh'],
    dsh_job_id: jobId,
    refresh: true,
    max_age_seconds: 0,
  });
  assert.equal(capacity.providers[0].status, 'available');
  assert.equal(capacity.providers[0].usage.total_tokens, 18);
  assert.match(await readFile(probeFile, 'utf8'), /probe/);
  assert.equal(JSON.stringify(capacity).includes('secret_provider_field'), false);

  const detailed = await dispatchControl('jobs', { action: 'get', job_id: jobId, tail_lines: 0 });
  assert.equal(detailed.dsh_usage.status, 'available');
  assert.equal(detailed.dsh_usage.freshness.state, 'fresh');
  assert.equal(typeof detailed.dsh_usage.freshness.age_seconds, 'number');
  assert.equal(detailed.dsh_usage.usage.total_tokens, 18);
  assert.equal(JSON.stringify(detailed.dsh_usage).includes('usage.json'), false);
  assert.equal(JSON.stringify(detailed.dsh_usage).includes(directory), false);

  const listed = await dispatchControl('jobs', { action: 'list', limit: 1 });
  assert.equal(Object.hasOwn(listed.jobs[0], 'dsh_usage'), false);
  const status = await dispatchControl('status', { recent_limit: 1 });
  assert.equal(JSON.stringify(status).includes('dsh_usage'), false);
  assert.equal(JSON.stringify(status).includes('usage.json'), false);
});

test('configured but unverified managed DSH cannot read an otherwise valid receipt', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-unverified-receipt-test-'));
  const jobsDirectory = path.join(directory, 'jobs');
  await mkdir(jobsDirectory, { mode: 0o700 });
  const fakeDsh = path.join(directory, 'dsh');
  const probeFile = path.join(directory, 'dsh-home.probe');
  await writeFile(fakeDsh, `#!/bin/sh
printf 'probe\\n' >> "$DSH_HOME.probe"
for argument in "$@"; do
  if [ "$argument" = "--version" ]; then printf 'dsh 0.1.0-rc.6\\n'; exit 0; fi
  if [ "$argument" = "--dump-config" ]; then exit 1; fi
done
exit 64
`, { mode: 0o755 });
  const jobId = 'deepseek-unverified-1234';
  const logFile = path.join(jobsDirectory, `${jobId}.log`);
  await writeFile(logFile, '', { mode: 0o600 });
  const previous = {
    command: process.env.CODEX_CO_ENGINEER_DSH_COMMAND,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
    home: process.env.CODEX_CO_ENGINEER_DSH_HOME,
    dshHome: process.env.DSH_HOME,
  };
  process.env.CODEX_CO_ENGINEER_DSH_COMMAND = fakeDsh;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = directory;
  delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
  delete process.env.DSH_HOME;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_COMMAND;
    else process.env.CODEX_CO_ENGINEER_DSH_COMMAND = previous.command;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    if (previous.home === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
    else process.env.CODEX_CO_ENGINEER_DSH_HOME = previous.home;
    if (previous.dshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.dshHome;
    await rm(directory, { recursive: true, force: true });
  });

  const database = openStore(path.join(directory, 'control.sqlite3'));
  insertJob(database, {
    id: jobId,
    kind: 'deepseek_agent',
    status: 'succeeded',
    summary: 'Unverified DSH receipt fixture',
    created_at: new Date(Date.now() - 1000).toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    log_file: logFile,
    cancel_file: path.join(jobsDirectory, `${jobId}.cancel`),
  });
  database.close();
  await writeFile(path.join(jobsDirectory, `${jobId}.usage.json`), JSON.stringify({
    schemaVersion: 1,
    source: 'dsh-headless-live',
    scope: 'task',
    jobId,
    rootSessionId: 'session-unverified-opaque',
    observedAt: new Date().toISOString(),
    aggregationComplete: true,
    confidence: 'exact',
    usageSamples: 1,
    counts: { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 },
  }), { mode: 0o600 });

  const { __testing, dispatchControl } = await import(`../mcp/control.mjs?dsh-unverified=${Date.now()}`);
  const result = await dispatchControl('capacity', {
    providers: ['dsh'],
    dsh_job_id: jobId,
    refresh: true,
    max_age_seconds: 0,
  });
  assert.equal(result.providers[0].status, 'unavailable');
  assert.equal(result.providers[0].usage, null);
  assert.match(await readFile(probeFile, 'utf8'), /probe/);
  assert.equal(JSON.stringify(result).includes(directory), false);

  const environment = __testing.startJobEnvironment('deepseek_agent', jobId, {
    CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER: 'provider-value',
    CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH: '/provider/receipt.json',
  });
  assert.equal(Object.hasOwn(environment, 'CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER'), false);
  assert.equal(Object.hasOwn(environment, 'CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH'), false);
});

test('production DSH capacity fails closed for invalid, missing, active, and wrong-kind jobs', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-capacity-fail-closed-test-'));
  const jobsDirectory = path.join(directory, 'jobs');
  await mkdir(jobsDirectory, { mode: 0o700 });
  const fakeDsh = path.join(directory, 'dsh');
  await writeFile(fakeDsh, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "--version" ]; then printf 'dsh 0.1.0-rc.6\\n'; exit 0; fi
  if [ "$argument" = "--dump-config" ]; then
    mkdir -p "$DSH_HOME/profiles/headless"
    chmod 700 "$DSH_HOME" "$DSH_HOME/profiles" "$DSH_HOME/profiles/headless"
    printf '{}\\n' > "$DSH_HOME/profiles/headless/package.json"
    chmod 600 "$DSH_HOME/profiles/headless/package.json"
    exit 0
  fi
done
exit 64
`, { mode: 0o755 });
  const previous = {
    command: process.env.CODEX_CO_ENGINEER_DSH_COMMAND,
    state: process.env.CODEX_CO_ENGINEER_STATE_DIR,
    home: process.env.CODEX_CO_ENGINEER_DSH_HOME,
    dshHome: process.env.DSH_HOME,
  };
  process.env.CODEX_CO_ENGINEER_DSH_COMMAND = fakeDsh;
  process.env.CODEX_CO_ENGINEER_STATE_DIR = directory;
  delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
  delete process.env.DSH_HOME;
  context.after(async () => {
    if (previous.command === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_COMMAND;
    else process.env.CODEX_CO_ENGINEER_DSH_COMMAND = previous.command;
    if (previous.state === undefined) delete process.env.CODEX_CO_ENGINEER_STATE_DIR;
    else process.env.CODEX_CO_ENGINEER_STATE_DIR = previous.state;
    if (previous.home === undefined) delete process.env.CODEX_CO_ENGINEER_DSH_HOME;
    else process.env.CODEX_CO_ENGINEER_DSH_HOME = previous.home;
    if (previous.dshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.dshHome;
    await rm(directory, { recursive: true, force: true });
  });

  const jobs = [
    ['deepseek-invalid-1', 'deepseek_agent', 'succeeded'],
    ['deepseek-missing-1', 'deepseek_agent', 'succeeded'],
    ['deepseek-active-1', 'deepseek_agent', 'running'],
    ['grok-wrong-kind-1', 'grok_build', 'succeeded'],
  ];
  const database = openStore(path.join(directory, 'control.sqlite3'));
  for (const [id, kind, status] of jobs) {
    insertJob(database, {
      id,
      kind,
      status,
      summary: 'DSH receipt validation fixture',
      created_at: new Date(Date.now() - 2000).toISOString(),
      updated_at: new Date().toISOString(),
      ...(status === 'succeeded' ? { finished_at: new Date().toISOString() } : {}),
      ...(status === 'running' ? { child_pid: process.pid } : {}),
      log_file: path.join(jobsDirectory, `${id}.log`),
      cancel_file: path.join(jobsDirectory, `${id}.cancel`),
    });
    await writeFile(path.join(jobsDirectory, `${id}.log`), '', { mode: 0o600 });
  }
  database.close();

  const receipt = (jobId) => ({
    schemaVersion: 1,
    source: 'dsh-headless-live',
    scope: 'task',
    jobId,
    rootSessionId: `session-${jobId}`,
    observedAt: new Date().toISOString(),
    aggregationComplete: true,
    confidence: 'exact',
    usageSamples: 1,
    counts: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1 },
  });
  await writeFile(
    path.join(jobsDirectory, 'deepseek-invalid-1.usage.json'),
    JSON.stringify(receipt('different-job-1')),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(jobsDirectory, 'deepseek-active-1.usage.json'),
    JSON.stringify(receipt('deepseek-active-1')),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(jobsDirectory, 'grok-wrong-kind-1.usage.json'),
    JSON.stringify(receipt('grok-wrong-kind-1')),
    { mode: 0o600 },
  );

  const { dispatchControl } = await import(`../mcp/control.mjs?dsh-capacity-fail-closed=${Date.now()}`);
  for (const jobId of ['deepseek-invalid-1', 'deepseek-missing-1', 'deepseek-active-1', 'grok-wrong-kind-1']) {
    const result = await dispatchControl('capacity', {
      providers: ['dsh'],
      dsh_job_id: jobId,
      refresh: true,
      max_age_seconds: 0,
    });
    assert.equal(result.providers[0].status, 'unavailable', jobId);
    assert.equal(result.providers[0].scope, 'job', jobId);
    assert.equal(JSON.stringify(result).includes(directory), false, jobId);
  }
});
