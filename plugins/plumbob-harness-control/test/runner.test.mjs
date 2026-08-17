import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
import { targetIdentityDigest } from '../mcp/preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function makeGitTarget(context, prefix, initial = 'initial\n') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
  await writeFile(path.join(directory, 'note.txt'), initial);
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', directory,
    '-c', 'user.name=Codex-Co-Engineer Test',
    '-c', 'user.email=codex-co-engineer@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  const expectedRoot = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const expectedHead = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const commonDirectory = spawnSync('git', ['-C', directory, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
  const expectedCommon = path.resolve(directory, commonDirectory);
  const identity = await stat(directory);
  return {
    directory,
    expectedRoot,
    expectedHead,
    expectedCommon,
    workspaceIdentity: { device: String(identity.dev), inode: String(identity.ino) },
  };
}

async function runTargetFixture(context, {
  prefix,
  id,
  command,
  args,
  allowedPaths,
  role = 'implement',
  workingDirectory = null,
  beforeDispatch = null,
  includeIdentities = false,
  controlShapedTarget = false,
}) {
  const target = await makeGitTarget(context, `${prefix}-target-`);
  const cwd = workingDirectory ? path.join(target.directory, workingDirectory) : target.directory;
  if (workingDirectory) await mkdir(cwd, { recursive: true });
  const cwdInfo = await stat(cwd);
  const cwdIdentity = { device: String(cwdInfo.dev), inode: String(cwdInfo.ino) };
  if (beforeDispatch) await beforeDispatch(target);
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
  context.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const databaseFile = path.join(stateDirectory, 'control.sqlite3');
  const logFile = path.join(stateDirectory, 'job.log');
  const cancelFile = path.join(stateDirectory, 'job.cancel');
  const specFile = path.join(stateDirectory, 'job.spec.json');
  const patchFile = path.join(stateDirectory, 'job.patch');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id,
    kind: 'grok_build',
    status: 'queued',
    summary: `${prefix} runner test`,
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  const targetContext = controlShapedTarget
    ? {
      schema_version: 'codex-co-engineer.target.v1',
      mode: 'explicit',
      working_directory: cwd,
      expected_git_root: target.expectedRoot,
      resolved_workspace: target.expectedRoot,
      resolved_cwd: cwd,
      git_common_directory: target.expectedCommon,
      expected_head: target.expectedHead,
      observed_head: target.expectedHead,
      allowed_paths: allowedPaths,
      role,
      target_fingerprint: targetIdentityDigest({
        mode: 'explicit',
        resolved_workspace: target.expectedRoot,
        resolved_cwd: cwd,
        git_common_directory: target.expectedCommon,
        git_head: target.expectedHead,
        workspace_identity: target.workspaceIdentity,
        cwd_identity: cwdIdentity,
      }),
      workspace_identity: target.workspaceIdentity,
      cwd_identity: cwdIdentity,
      isolation: role === 'implement'
        ? 'explicit-scoped-workspace'
        : 'read-only-process-contract',
    }
    : {
      working_directory: cwd,
      expected_git_root: target.expectedRoot,
      git_common_directory: target.expectedCommon,
      expected_head: target.expectedHead,
      allowed_paths: allowedPaths,
      role,
      ...(includeIdentities ? {
        schema_version: 'codex-co-engineer.target.v1',
        workspace_identity: target.workspaceIdentity,
        cwd_identity: cwdIdentity,
      } : {}),
    };
  await writeFile(specFile, JSON.stringify({
    id,
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    patch_artifact: patchFile,
    command,
    args: typeof args === 'function' ? args(target) : args,
    env: {},
    cwd,
    timeout_seconds: 60,
    kind: 'grok_build',
    target_context: targetContext,
  }));
  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  assert.equal(await new Promise((resolve) => runner.once('exit', resolve)), 0);
  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, id);
  completedStore.close();
  return { job, target };
}

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

test('detached runner does not let cancellation during group cleanup override direct exit', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-cancel-cleanup-runner-test-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const databaseFile = path.join(directory, 'control.sqlite3');
  const logFile = path.join(directory, 'job.log');
  const cancelFile = path.join(directory, 'job.cancel');
  const helperReadyMarker = path.join(directory, 'helper-ready.marker');
  const cleanupMarker = path.join(directory, 'cleanup-started.marker');
  const specFile = path.join(directory, 'job.spec.json');
  const helperScript = [
    'const fs=require("node:fs");',
    `const ready=${JSON.stringify(helperReadyMarker)};`,
    `const marker=${JSON.stringify(cleanupMarker)};`,
    "fs.writeFileSync(ready, 'ready\\n');",
    "process.on('SIGTERM', () => { fs.writeFileSync(marker, 'cleanup-started\\n'); setTimeout(() => process.exit(0), 250); });",
    'setTimeout(() => process.exit(0), 5000);',
  ].join('\n');
  const childScript = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `const helper=spawn(process.execPath, ['-e', ${JSON.stringify(helperScript)}], {stdio:'ignore'});`,
    'helper.unref();',
    `const wait= setInterval(() => { if (fs.existsSync(${JSON.stringify(helperReadyMarker)})) { clearInterval(wait); process.exit(0); } }, 5);`,
    'setTimeout(() => process.exit(1), 2000);',
  ].join('\n');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'cancel-cleanup-job-1234',
    kind: 'deepseek_agent',
    status: 'queued',
    summary: 'Cancellation during cleanup precedence test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'cancel-cleanup-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: process.execPath,
    args: ['-e', childScript],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
  }));

  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  await waitForFile(cleanupMarker);
  await writeFile(cancelFile, `${new Date().toISOString()}\n`);
  const exitCode = await new Promise((resolve) => runner.once('exit', resolve));

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'cancel-cleanup-job-1234');
  completedStore.close();
  assert.equal(exitCode, 0);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.exit_code, 0);
  assert.equal(job.termination_reason, 'completed');
  assert.equal(job.workspace_tainted, null);
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

test('detached runner accepts matching workspace and cwd identities', async (context) => {
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-matching-target-identity',
    id: 'matching-target-identity-1234',
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('note.txt', 'identity-verified')"],
    allowedPaths: ['note.txt'],
    includeIdentities: true,
  });
  assert.equal(result.job.status, 'succeeded', result.job.error ?? undefined);
  assert.equal(result.job.workspace_changed, 1);
  assert.deepEqual(JSON.parse(result.job.changed_paths), ['note.txt']);
});

test('detached runner refuses a replaced checkout before provider execution', async (context) => {
  const marker = path.join(os.tmpdir(), `plumbob-replaced-target-${process.pid}-${Date.now()}.marker`);
  context.after(() => rm(marker, { force: true }));
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-replaced-target',
    id: 'replaced-target-identity-1234',
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'provider-ran\n')`],
    allowedPaths: ['note.txt'],
    includeIdentities: true,
    beforeDispatch: async (target) => {
      const original = `${target.directory}-original`;
      const replacement = `${target.directory}-replacement`;
      context.after(() => rm(original, { recursive: true, force: true }));
      await cp(target.directory, replacement, { recursive: true });
      await rename(target.directory, original);
      await rename(replacement, target.directory);
    },
  });
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.termination_reason, 'target_preflight_failed');
  assert.match(result.job.error, /identity mismatch/);
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
});

test('detached runner refuses a directory scope containing a symlink before provider execution', async (context) => {
  const externalDirectory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-scope-symlink-external-'));
  const externalFile = path.join(externalDirectory, 'outside.txt');
  const marker = path.join(externalDirectory, 'provider-ran.marker');
  context.after(() => rm(externalDirectory, { recursive: true, force: true }));
  await writeFile(externalFile, 'must remain unchanged\n');

  const result = await runTargetFixture(context, {
    prefix: 'plumbob-directory-scope-symlink',
    id: 'directory-scope-symlink-1234',
    command: process.execPath,
    args: ['-e', [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(externalFile)}, 'provider-ran\\n');`,
      `fs.writeFileSync(${JSON.stringify(marker)}, 'provider-ran\\n');`,
    ].join('\n')],
    allowedPaths: ['.'],
    beforeDispatch: async (target) => {
      await symlink(externalFile, path.join(target.directory, 'external-link'));
    },
  });

  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.termination_reason, 'target_preflight_failed');
  assert.match(result.job.error, /allowed path .*contains a symlink/);
  assert.equal(await readFile(externalFile, 'utf8'), 'must remain unchanged\n');
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
});

test('detached runner refuses success when the provider replaces the checkout during execution', async (context) => {
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-postflight-replaced-target',
    id: 'postflight-replaced-target-1234',
    command: process.execPath,
    args: (target) => ['-e', [
      "const fs=require('node:fs');",
      `const root=${JSON.stringify(target.directory)};`,
      'const replacement=`${root}-replacement`;',
      'fs.cpSync(root, replacement, { recursive: true });',
      'fs.renameSync(root, `${root}-original`);',
      'fs.renameSync(replacement, root);',
    ].join('\n')],
    allowedPaths: ['note.txt'],
    role: 'review',
    includeIdentities: true,
    beforeDispatch: async (target) => {
      context.after(() => rm(`${target.directory}-original`, { recursive: true, force: true }));
    },
  });
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.termination_reason, 'scope_verification_failed');
  assert.match(result.job.error, /identity mismatch/);
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

test('detached runner drains provider descendants before final snapshot and patch publication', async (context) => {
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-descendant-drain',
    id: 'descendant-drain-1234',
    command: process.execPath,
    args: (target) => ['-e', [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      "const helper=spawn(process.execPath, ['-e', \"setTimeout(() => require('node:fs').writeFileSync('note.txt', 'late descendant edit\\\\n'), 800)\"], {cwd: process.cwd(), stdio: 'ignore'});",
      "fs.writeFileSync('note.txt', 'direct provider edit\\n');",
      'process.exit(0);',
    ].join('\n')],
    allowedPaths: ['note.txt'],
    includeIdentities: true,
  });

  assert.equal(result.job.status, 'succeeded', result.job.error ?? undefined);
  assert.equal(result.job.workspace_changed, 1);
  assert.match(await readFile(result.job.patch_artifact, 'utf8'), /direct provider edit/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await readFile(path.join(result.target.directory, 'note.txt'), 'utf8'), 'direct provider edit\n');
});

test('detached runner bounds an escaped pipe-holder and withholds the patch', async (context) => {
  if (process.platform === 'win32') {
    context.skip('process-group and detached-pipe containment are POSIX-only');
    return;
  }
  const pidFile = path.join(os.tmpdir(), `plumbob-escaped-pipe-${process.pid}-${Date.now()}.pid`);
  const cleanupHolder = async () => {
    const holderPid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
    if (Number.isInteger(holderPid) && holderPid > 0) {
      try { process.kill(holderPid, 'SIGKILL'); } catch {}
    }
    await rm(pidFile, { force: true });
  };
  context.after(cleanupHolder);

  const result = await runTargetFixture(context, {
    prefix: 'plumbob-escaped-pipe-holder',
    id: 'escaped-pipe-holder-1234',
    command: process.execPath,
    args: () => ['-e', [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      `const pidFile=${JSON.stringify(pidFile)};`,
      `const holder=spawn(process.execPath, ['-e', ${JSON.stringify('setInterval(() => {}, 10000);')}], {detached:true, stdio:['ignore', 1, 2]});`,
      'fs.writeFileSync(pidFile, String(holder.pid));',
      'holder.unref();',
      "fs.writeFileSync('note.txt', 'escaped pipe-holder edit\\n');",
      'process.exit(0);',
    ].join('\n')],
    allowedPaths: ['note.txt'],
    includeIdentities: true,
  });
  await cleanupHolder();

  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.termination_reason, 'output_drain_failed');
  assert.equal(result.job.failure_class, 'tool_error');
  assert.equal(result.job.workspace_tainted, 1);
  assert.equal(result.job.patch_artifact, null);
  assert.deepEqual(JSON.parse(result.job.changed_paths), []);
  assert.match(result.job.error, /output streams did not drain/);
});

test('detached runner captures an untracked root-relative path from a nested working directory', async (context) => {
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-nested-working-directory',
    id: 'nested-working-directory-1234',
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('new.txt', 'nested new file\\n')"],
    allowedPaths: ['sub/new.txt'],
    workingDirectory: 'sub',
    controlShapedTarget: true,
  });
  assert.equal(result.job.status, 'succeeded');
  assert.equal(result.job.workspace_changed, 1);
  assert.deepEqual(JSON.parse(result.job.changed_paths), ['sub/new.txt']);
  assert.ok(result.job.patch_artifact);
  assert.match(await readFile(result.job.patch_artifact, 'utf8'), /nested new file/);
});

test('detached runner fails closed when an implement target makes no workspace change', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-no-change-runner-test-'));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-no-change-state-test-'));
  context.after(async () => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(stateDirectory, { recursive: true, force: true }),
  ]));

  assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
  await writeFile(path.join(directory, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', directory,
    '-c', 'user.name=Co-Engineer Test',
    '-c', 'user.email=co-engineer-test@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  const expectedRoot = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const expectedHead = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const databaseFile = path.join(stateDirectory, 'control.sqlite3');
  const logFile = path.join(stateDirectory, 'job.log');
  const cancelFile = path.join(stateDirectory, 'job.cancel');
  const specFile = path.join(stateDirectory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'no-change-job-1234',
    kind: 'grok_build',
    status: 'queued',
    summary: 'No-change implement test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'no-change-job-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: '/usr/bin/true',
    args: [],
    env: {},
    cwd: directory,
    timeout_seconds: 60,
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
  assert.equal(await new Promise((resolve) => runner.once('exit', resolve)), 0);

  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'no-change-job-1234');
  completedStore.close();
  assert.equal(job.status, 'failed');
  assert.equal(job.termination_reason, 'no_workspace_change');
  assert.equal(job.failure_class, 'contract_violation');
  assert.equal(job.workspace_changed, 0);
  assert.match(job.error, /without changing/);
});

test('detached runner detects an edit to a pre-dirty allowlisted file', async (context) => {
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-pre-dirty-edit',
    id: 'pre-dirty-edit-1234',
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('note.txt', 'model edit after pre-dirty state\\n')"],
    allowedPaths: ['note.txt'],
    beforeDispatch: (target) => writeFile(path.join(target.directory, 'note.txt'), 'pre-existing local edit\n'),
  });
  assert.equal(result.job.status, 'succeeded');
  assert.equal(result.job.workspace_changed, 1);
  assert.deepEqual(JSON.parse(result.job.changed_paths), ['note.txt']);
});

test('detached runner treats a change-then-revert as no net workspace change', async (context) => {
  const target = await makeGitTarget(context, 'plumbob-revert-target-', 'committed\n');
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'plumbob-revert-state-'));
  context.after(() => rm(stateDirectory, { recursive: true, force: true }));
  await writeFile(path.join(target.directory, 'note.txt'), 'pre-existing local edit\n');
  const databaseFile = path.join(stateDirectory, 'control.sqlite3');
  const logFile = path.join(stateDirectory, 'job.log');
  const cancelFile = path.join(stateDirectory, 'job.cancel');
  const specFile = path.join(stateDirectory, 'job.spec.json');
  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'revert-no-change-1234',
    kind: 'grok_build',
    status: 'queued',
    summary: 'Change then revert contract test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'revert-no-change-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('note.txt', 'transient\\n'); fs.writeFileSync('note.txt', 'pre-existing local edit\\n')"],
    env: {},
    cwd: target.directory,
    timeout_seconds: 60,
    kind: 'grok_build',
    target_context: {
      working_directory: target.directory,
      expected_git_root: target.expectedRoot,
      expected_head: target.expectedHead,
      allowed_paths: ['note.txt'],
      role: 'implement',
    },
  }));
  const runner = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'runner.mjs'), specFile], {
    stdio: 'ignore',
  });
  assert.equal(await new Promise((resolve) => runner.once('exit', resolve)), 0);
  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'revert-no-change-1234');
  completedStore.close();
  assert.equal(job.status, 'failed');
  assert.equal(job.termination_reason, 'no_workspace_change');
  assert.equal(job.failure_class, 'contract_violation');
  assert.equal(job.workspace_changed, 0);
});

test('detached runner refuses ignored and out-of-scope changes with stable contract reasons', async (context) => {
  const ignored = await runTargetFixture(context, {
    prefix: 'plumbob-ignored-change',
    id: 'ignored-file-change-1234',
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('.ignored', 'changed\\n')"],
    allowedPaths: ['note.txt'],
    beforeDispatch: async (target) => {
      await writeFile(path.join(target.directory, '.gitignore'), '.ignored\n');
      await writeFile(path.join(target.directory, '.ignored'), 'initial\n');
    },
  });
  /* The helper's target is already snapshotted before runner execution. */
  assert.equal(ignored.job.termination_reason, 'ignored_file_change');
  assert.equal(ignored.job.failure_class, 'tool_error');

  const outOfScope = await runTargetFixture(context, {
    prefix: 'plumbob-out-of-scope-change',
    id: 'out-of-scope-change-1234',
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('outside.txt', 'changed\\n')"],
    allowedPaths: ['note.txt'],
  });
  assert.equal(outOfScope.job.termination_reason, 'scope_violation');
  assert.equal(outOfScope.job.failure_class, 'tool_error');
});

test('detached runner detects edits to existing files inside a bounded ignored directory', async (context) => {
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-bounded-ignored-edit',
    id: 'bounded-ignored-edit-1234',
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('ignored/entry.txt', 'changed\\n')"],
    allowedPaths: ['note.txt'],
    role: 'review',
    beforeDispatch: async (target) => {
      await writeFile(path.join(target.directory, '.gitignore'), 'ignored/\n');
      await mkdir(path.join(target.directory, 'ignored'));
      await writeFile(path.join(target.directory, 'ignored', 'entry.txt'), 'initial\n');
    },
  });
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.termination_reason, 'ignored_file_change');
  assert.equal(result.job.failure_class, 'tool_error');
  assert.deepEqual(JSON.parse(result.job.changed_paths), ['ignored/entry.txt']);
  assert.match(result.job.error, /ignored\/entry\.txt/);
});

test('detached runner refuses an ignored directory that exceeds the integrity bound', async (context) => {
  const result = await runTargetFixture(context, {
    prefix: 'plumbob-large-ignored-directory',
    id: 'large-ignored-directory-1234',
    command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); fs.writeFileSync('ignored/entry-0000.txt', 'changed\\n')"],
    allowedPaths: ['note.txt'],
    beforeDispatch: async (target) => {
      await writeFile(path.join(target.directory, '.gitignore'), 'ignored/\n');
      const ignoredDirectory = path.join(target.directory, 'ignored');
      await mkdir(ignoredDirectory);
      await Promise.all(Array.from({ length: 2048 }, (_, index) => writeFile(
        path.join(ignoredDirectory, `entry-${String(index).padStart(4, '0')}.txt`),
        'initial\n',
      )));
    },
  });
  // Integrity verification is bounded: the runner refuses this target before
  // provider execution instead of recursively hashing an unbounded tree.
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.termination_reason, 'target_preflight_failed');
  assert.equal(result.job.failure_class, 'tool_error');
  assert.match(result.job.error, /bounded entry limit/);
  assert.deepEqual(JSON.parse(result.job.changed_paths), []);
});

test('deepseek runner invokes DSH directly with only its profile environment', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-deepseek-runner-test-'));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-deepseek-state-test-'));
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
  const recordFile = path.join(stateDirectory, 'deepseek.json');
  const fake = path.join(stateDirectory, 'dsh');
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  model: process.env.MODEL_API_KEY ?? null,
  dshHome: process.env.DSH_HOME ?? null,
  xai: process.env.XAI_API_KEY ?? null,
  permission: process.env.DSH_PERMISSION_MODE ?? null,
}));
console.log('deepseek-ok');
`, { mode: 0o755 });

  const createdAt = new Date().toISOString();
  const database = openStore(databaseFile);
  insertJob(database, {
    id: 'deepseek-runner-1234',
    kind: 'deepseek_agent',
    status: 'queued',
    summary: 'DeepSeek direct invocation test',
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
  });
  database.close();
  await writeFile(specFile, JSON.stringify({
    id: 'deepseek-runner-1234',
    database_file: databaseFile,
    log_file: logFile,
    cancel_file: cancelFile,
    command: fake,
    args: ['--profile', 'headless', 'active task'],
    env: { DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_MODE: 'DISABLED' },
    cwd: directory,
    timeout_seconds: 60,
    kind: 'deepseek_agent',
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
    env: {
      ...process.env,
      MODEL_API_KEY: 'model-secret',
      DSH_HOME: '/tmp/test-dsh-home',
      XAI_API_KEY: 'must-not-leak',
    },
    stdio: 'ignore',
  });
  assert.equal(await new Promise((resolve) => runner.once('exit', resolve)), 0);
  const completedStore = openStore(databaseFile);
  const job = getStoredJob(completedStore, 'deepseek-runner-1234');
  completedStore.close();
  assert.equal(job.status, 'succeeded');
  const recorded = JSON.parse(await readFile(recordFile, 'utf8'));
  assert.deepEqual(recorded.argv, ['--profile', 'headless', 'active task']);
  assert.equal(recorded.cwd, directory);
  assert.equal(recorded.model, 'model-secret');
  assert.equal(recorded.dshHome, '/tmp/test-dsh-home');
  assert.equal(recorded.xai, null);
  assert.equal(recorded.permission, 'read-only');
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
