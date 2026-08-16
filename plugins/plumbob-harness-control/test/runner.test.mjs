import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getStoredJob,
  insertJob,
  listLifecycleEvents,
  openStore,
} from '../mcp/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('detached runner records completion and output in SQLite', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-runner-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const databaseFile = path.join(directory, 'control.sqlite3');
  const logFile = path.join(directory, 'job.log');
  const cancelFile = path.join(directory, 'job.cancel');
  const specFile = path.join(directory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'test-job-1234',
    kind: 'test',
    status: 'queued',
    summary: 'Runner test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'test-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: '/usr/bin/printf',
    args: ['runner-ok\\n'],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));
  assert.equal(exitCode, 0);

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'test-job-1234');
  const lifecycleEvents = listLifecycleEvents(completedStore, 'test-job-1234');
  completedStore.close();
  assert.equal(job.status, 'succeeded');
  assert.equal(job.lifecycle_state, 'completed');
  assert.equal(job.terminal_state, 'completed');
  assert.equal(job.failure_class, null);
  assert.deepEqual(
    lifecycleEvents.filter((event) => event.event_type !== 'heartbeat').map((event) => event.lifecycle_state),
    ['accepted', 'started', 'working', 'completed'],
  );
  assert.equal(lifecycleEvents.filter((event) => event.event_type === 'terminal').length, 1);
  assert.equal(job.exit_code, 0);
  assert.match(await readFile(logFile, 'utf8'), /runner-ok/);
});

test('runner redacts prompts and credential-shaped output before writing logs', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-redaction-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const databaseFile = path.join(directory, 'control.sqlite3');
  const logFile = path.join(directory, 'job.log');
  const cancelFile = path.join(directory, 'job.cancel');
  const specFile = path.join(directory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'redaction-job-1234',
    kind: 'test',
    status: 'queued',
    summary: 'Redaction test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  const prompt = 'full private prompt text';
  await writeFile(specFile, JSON.stringify({
    id: 'redaction-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: '/usr/bin/printf',
    args: [`${prompt}\napi_key=not-a-real-key\nsafe output\n`],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
    redactions: [prompt],
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  assert.equal(await new Promise((resolve) => runner.once('exit', resolve)), 0);
  const log = await readFile(logFile, 'utf8');
  assert.doesNotMatch(log, /full private prompt text/);
  assert.doesNotMatch(log, /not-a-real-key/);
  assert.match(log, /safe output/);
  assert.match(log, /\[REDACTED\]/);
});

test('detached runner treats Prime Agent JSON provider errors as failures', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-prime-runner-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const databaseFile = path.join(directory, 'control.sqlite3');
  const logFile = path.join(directory, 'job.log');
  const cancelFile = path.join(directory, 'job.cancel');
  const specFile = path.join(directory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'prime-job-1234',
    kind: 'prime_agent',
    status: 'queued',
    summary: 'Prime semantic failure test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  const providerError = JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized' },
  });
  await writeFile(specFile, JSON.stringify({
    id: 'prime-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: '/usr/bin/printf',
    args: [`${providerError}\\n`],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
    result_format: 'prime_agent_json',
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));
  assert.equal(exitCode, 0);

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'prime-job-1234');
  completedStore.close();
  assert.equal(job.status, 'failed');
  assert.equal(job.error, '401 Unauthorized');
});

test('detached runner fixes the deadline at acceptance before child startup', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-timeout-runner-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const databaseFile = path.join(directory, 'control.sqlite3');
  const logFile = path.join(directory, 'job.log');
  const cancelFile = path.join(directory, 'job.cancel');
  const specFile = path.join(directory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'timeout-job-1234',
    kind: 'deepseek_agent',
    status: 'queued',
    summary: 'Timeout precedence test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'timeout-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    env: {},
    cwd: directory,
    timeout_seconds: 0.05,
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'timeout-job-1234');
  completedStore.close();
  assert.equal(exitCode, 0);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.lifecycle_state, 'timeout');
  assert.equal(job.terminal_state, 'timeout');
  assert.equal(job.failure_class, 'timeout');
  assert.equal(job.exit_code, null);
  assert.equal(job.termination_reason, 'wall_clock_timeout');
  assert.equal(job.signal_sent, null);
  assert.match(job.error, /wall-clock deadline/);
  assert.equal(job.partial_output_available, 0);
  assert.ok(job.deadline_at);
  assert.equal(typeof job.elapsed_seconds, 'number');
});

test('detached runner keeps an exit-code-0 cancellation unambiguously cancelled', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-cancel-runner-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const databaseFile = path.join(directory, 'control.sqlite3');
  const logFile = path.join(directory, 'job.log');
  const cancelFile = path.join(directory, 'job.cancel');
  const specFile = path.join(directory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'cancel-job-1234',
    kind: 'deepseek_agent',
    status: 'queued',
    summary: 'Cancellation precedence test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'cancel-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 150)'],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  await writeFile(cancelFile, `${new Date().toISOString()}\n`);
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'cancel-job-1234');
  completedStore.close();
  assert.equal(exitCode, 0);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.exit_code, 0);
  assert.equal(job.termination_reason, 'cancelled_by_user');
  assert.equal(job.signal_sent, 'SIGTERM');
  assert.match(job.error, /Cancellation was requested/);
});

test('target timeout marks the checkout tainted and withholds a partial patch', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-target-timeout-test-'));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-target-timeout-state-'));
  context.after(async () => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(stateDirectory, { recursive: true, force: true }),
  ]));

  assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
  await writeFile(path.join(directory, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'note.txt']).status, 0);
  assert.equal(
    spawnSync('git', [
      '-C', directory,
      '-c', 'user.name=Co-Engineer Test',
      '-c', 'user.email=co-engineer-test@example.invalid',
      'commit', '-qm', 'initial',
    ]).status,
    0,
  );
  const expectedRoot = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const expectedHead = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const databaseFile = path.join(stateDirectory, 'control.sqlite3');
  const logFile = path.join(stateDirectory, 'job.log');
  const cancelFile = path.join(stateDirectory, 'job.cancel');
  const specFile = path.join(stateDirectory, 'job.spec.json');
  const patchFile = path.join(stateDirectory, 'job.patch');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'target-timeout-1234',
    kind: 'deepseek_agent',
    status: 'queued',
    summary: 'Target timeout taint test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'target-timeout-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    patch_artifact: patchFile,
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('note.txt', 'partial\\n'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    env: {},
    cwd: directory,
    timeout_seconds: 0.05,
    target_context: {
      working_directory: directory,
      expected_git_root: expectedRoot,
      expected_head: expectedHead,
      allowed_paths: ['note.txt'],
      role: 'implement',
    },
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'target-timeout-1234');
  completedStore.close();
  assert.equal(exitCode, 0);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.lifecycle_state, 'timeout');
  assert.equal(job.terminal_state, 'timeout');
  assert.equal(job.failure_class, 'timeout');
  assert.equal(job.exit_code, null);
  assert.equal(job.termination_reason, 'wall_clock_timeout');
  assert.equal(job.workspace_tainted, 1);
  assert.equal(job.patch_artifact, null);
  assert.match(job.error, /wall-clock deadline/);
});

test('detached runner refuses a target that is not a Git checkout before model execution', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-target-runner-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const databaseFile = path.join(directory, 'control.sqlite3');
  const logFile = path.join(directory, 'job.log');
  const cancelFile = path.join(directory, 'job.cancel');
  const specFile = path.join(directory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'target-job-1234',
    kind: 'deepseek_agent',
    status: 'queued',
    summary: 'Target preflight test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'target-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: '/usr/bin/printf',
    args: ['should-not-run\n'],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
    target_context: {
      working_directory: directory,
      expected_git_root: directory,
      expected_head: '0123456',
      allowed_paths: ['mcp'],
      role: 'review',
    },
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'target-job-1234');
  completedStore.close();
  assert.equal(exitCode, 0);
  assert.equal(job.status, 'failed');
  assert.equal(job.termination_reason, 'target_preflight_failed');
  assert.match(job.error, /Target preflight refused/);
  assert.equal(job.exit_code, null);
});

test('detached runner permits scoped implement targets and records a patch artifact', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-implement-runner-test-'));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-implement-state-test-'));
  context.after(async () => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(stateDirectory, { recursive: true, force: true }),
  ]));

  assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
  await writeFile(path.join(directory, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'note.txt']).status, 0);
  assert.equal(
    spawnSync('git', [
      '-C', directory,
      '-c', 'user.name=Co-Engineer Test',
      '-c', 'user.email=co-engineer-test@example.invalid',
      'commit', '-qm', 'initial',
    ]).status,
    0,
  );
  const expectedRoot = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const expectedHead = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const databaseFile = path.join(stateDirectory, 'control.sqlite3');
  const logFile = path.join(stateDirectory, 'job.log');
  const cancelFile = path.join(stateDirectory, 'job.cancel');
  const specFile = path.join(stateDirectory, 'job.spec.json');
  const patchFile = path.join(stateDirectory, 'job.patch');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'implement-job-1234',
    kind: 'deepseek_agent',
    status: 'queued',
    summary: 'Scoped implement test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'implement-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    patch_artifact: patchFile,
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('note.txt', 'updated\\n'); fs.writeFileSync('new.txt', 'new\\n')"],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
    target_context: {
      working_directory: directory,
      expected_git_root: expectedRoot,
      expected_head: expectedHead,
      allowed_paths: ['note.txt', 'new.txt'],
      role: 'implement',
    },
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'implement-job-1234');
  completedStore.close();
  assert.equal(exitCode, 0);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.workspace_changed, 1);
  assert.deepEqual(JSON.parse(job.changed_paths), ['new.txt', 'note.txt']);
  assert.equal(job.patch_artifact, patchFile);
  assert.match(await readFile(patchFile, 'utf8'), /updated/);
});

test('grok runner invokes a fake executable with exact argv and OAuth-only environment', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-grok-runner-test-'));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-grok-state-test-'));
  context.after(async () => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(stateDirectory, { recursive: true, force: true }),
  ]));

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
  const databaseFile = path.join(stateDirectory, 'control.sqlite3');
  const logFile = path.join(stateDirectory, 'job.log');
  const cancelFile = path.join(stateDirectory, 'job.cancel');
  const specFile = path.join(stateDirectory, 'job.spec.json');
  const argvFile = path.join(stateDirectory, 'argv.json');
  const fake = path.join(stateDirectory, 'grok');
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv: process.argv.slice(2), model: process.env.MODEL_API_KEY ?? null, xai: process.env.XAI_API_KEY ?? null }));
console.log(JSON.stringify({ type: 'future_event', text: 'hello' }));
console.log(JSON.stringify({ type: 'completion', status: 'completed' }));
setTimeout(() => process.exit(0), 25);
`, { mode: 0o755 });

  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'grok-runner-1234',
    kind: 'grok_build',
    status: 'queued',
    summary: 'Grok argv test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  const prompt = 'single prompt with $(not-shell-expanded)';
  await writeFile(specFile, JSON.stringify({
    id: 'grok-runner-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: fake,
    args: ['--no-auto-update', '-p', prompt, '--cwd', directory, '--output-format', 'streaming-json'],
    env: { XAI_API_KEY: 'xai-fake', FAKE_RECORD_FILE: argvFile },
    cwd: directory,
    timeout_seconds: 60,
    kind: 'grok_build',
    result_format: 'grok_streaming_json',
    redactions: [prompt],
    target_context: {
      working_directory: directory,
      expected_git_root: directory,
      expected_head: head,
      git_common_directory: path.join(directory, '.git'),
      allowed_paths: ['.'],
      role: 'review',
    },
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    env: { ...process.env, MODEL_API_KEY: 'model-secret', XAI_API_KEY: 'runner-xai-secret' },
    stdio: 'ignore',
  });
  assert.equal(await new Promise((resolve) => runner.once('exit', resolve)), 0);
  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'grok-runner-1234');
  completedStore.close();
  assert.equal(job.status, 'succeeded');
  const recorded = JSON.parse(await readFile(argvFile, 'utf8'));
  assert.deepEqual(recorded.argv, ['--no-auto-update', '-p', prompt, '--cwd', directory, '--output-format', 'streaming-json']);
  assert.equal(recorded.model, null);
  assert.equal(recorded.xai, 'xai-fake');
});
