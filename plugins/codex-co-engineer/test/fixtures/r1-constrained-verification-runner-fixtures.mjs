// Shared fixtures for the W16-P16C constrained verification-runner tests.
// Hostile local helpers and injected process/Git boundaries. No product
// imports beyond P16A/P16B and no real external network.

import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveApprovedVerificationCommandV1 } from '../../mcp/v3/approved-verification-command.mjs';
import {
  countingProxy,
  trapTotal,
  validCommand,
  validPolicy,
} from './r1-verification-policy-fixtures.mjs';

export { countingProxy, trapTotal, validCommand, validPolicy };

const execFile = promisify(execFileCallback);

export const GIT_EXECUTABLE = '/usr/bin/git';
export const TRUE_EXECUTABLE = '/usr/bin/true';
export const HEAD_SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const HEAD_SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'P16C',
  GIT_AUTHOR_EMAIL: 'p16c@example.test',
  GIT_COMMITTER_NAME: 'P16C',
  GIT_COMMITTER_EMAIL: 'p16c@example.test',
  GIT_TERMINAL_PROMPT: '0',
};

export function gitIdentitySnapshot(overrides = {}) {
  const head = overrides.head_sha ?? HEAD_SHA_A;
  return {
    head_sha: head,
    status: '',
    refs: `${head} refs/heads/main\n`,
    config: 'user.email=p16c@example.test\n',
    worktrees: `${overrides.gitdir ?? '/tmp/cce-p16c-candidate/.git'}\n`,
    gitdir: overrides.gitdir ?? '/tmp/cce-p16c-candidate/.git',
    ...overrides,
  };
}

export function fakeChild(options = {}) {
  const child = new EventEmitter();
  child.pid = options.pid ?? 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    if (options.hang === true && options.ignoreKill === true) return true;
    const code = options.killCode === undefined ? null : options.killCode;
    const sig = options.killSignal === undefined ? (signal ?? 'SIGTERM') : options.killSignal;
    queueMicrotask(() => child.emit('exit', code, sig));
    return true;
  };
  queueMicrotask(() => {
    if (typeof child.emit === 'function') child.emit('spawn');
    if (options.stdout !== undefined) child.stdout.write(options.stdout);
    if (options.stderr !== undefined) child.stderr.write(options.stderr);
    if (options.floodBytes > 0) {
      child.stdout.write(Buffer.alloc(options.floodBytes, 0x41));
    }
    if (options.hang !== true) {
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', options.code ?? 0, options.signal ?? null);
    }
  });
  return child;
}

export function recordingAdapter(overrides = {}) {
  const calls = {
    spawn: [],
    mkdir: [],
    rmdir: [],
    kill: [],
  };
  const adapter = {
    nowMs: overrides.nowMs ?? (() => Date.now()),
    randomId: overrides.randomId ?? (() => {
      const bytes = new Uint8Array(16);
      for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
      return Buffer.from(bytes).toString('hex');
    }),
    tmpRoot: overrides.tmpRoot ?? (() => path.resolve(tmpdir())),
    lstat: overrides.lstat ?? ((target, options) => lstat(target, options ?? { bigint: true })),
    mkdir: async (target, options) => {
      calls.mkdir.push(target);
      if (overrides.mkdir) return overrides.mkdir(target, options);
      return mkdir(target, options);
    },
    realpath: overrides.realpath ?? ((target) => realpath(target)),
    rmdirExact: async (record) => {
      calls.rmdir.push(record.path);
      if (overrides.rmdirExact) return overrides.rmdirExact(record);
      return rm(record.path, { recursive: true, force: false });
    },
    spawn: (file, args, options) => {
      calls.spawn.push({ file, args, options });
      if (overrides.spawn) return overrides.spawn(file, args, options);
      return fakeChild(overrides.child ?? {});
    },
    killProcessGroup: (pid, signal) => {
      calls.kill.push({ pid, signal });
      if (overrides.killProcessGroup) return overrides.killProcessGroup(pid, signal);
    },
    listDescendants: overrides.listDescendants ?? (async () => []),
  };
  if (overrides.readGitIdentity) adapter.readGitIdentity = overrides.readGitIdentity;
  else if (overrides.git) {
    adapter.readGitIdentity = async () => overrides.git;
  }
  return { adapter, calls };
}

export async function makeTempRoot(prefix = 'cce-p16c-') {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function writeRunnable(file, body = '#!/bin/sh\nexit 0\n') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, { encoding: 'utf8', mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function initCandidateRepo(root) {
  await mkdir(root, { recursive: true });
  await execFile(GIT_EXECUTABLE, ['init', '--initial-branch=main', root], { env: GIT_ENV });
  await execFile(GIT_EXECUTABLE, ['-C', root, 'config', 'user.email', 'p16c@example.test'], { env: GIT_ENV });
  await execFile(GIT_EXECUTABLE, ['-C', root, 'config', 'user.name', 'P16C'], { env: GIT_ENV });
  await writeFile(path.join(root, 'README'), 'p16c\n');
  await execFile(GIT_EXECUTABLE, ['-C', root, 'add', 'README'], { env: GIT_ENV });
  await execFile(GIT_EXECUTABLE, ['-C', root, 'commit', '-m', 'init'], { env: GIT_ENV });
  const { stdout } = await execFile(
    GIT_EXECUTABLE, ['-C', root, 'rev-parse', 'HEAD'], { env: GIT_ENV },
  );
  return stdout.trim();
}

export function policyForExecutable(executable, overrides = {}) {
  const command = {
    executable,
    argv_template: overrides.argv_template ?? ['ok'],
    command_id: overrides.command_id ?? 'unit-tests',
  };
  for (const key of ['timeout_ms', 'resources', 'environment', 'mutation', 'network', 'parameters']) {
    if (Object.hasOwn(overrides, key) && overrides[key] !== undefined) {
      command[key] = overrides[key];
    }
  }
  return validPolicy({
    commands: [validCommand(command)],
  });
}

export function validSelection(overrides = {}) {
  return {
    command_id: 'unit-tests',
    ...overrides,
  };
}

export function genuineRequest({ policy, executable, candidate, selection, intentOverrides }) {
  const resolvedPolicy = policy ?? policyForExecutable(executable);
  const intent = resolveApprovedVerificationCommandV1({
    policy: resolvedPolicy,
    selection: selection ?? validSelection(),
  });
  return {
    policy: resolvedPolicy,
    intent: intentOverrides === undefined ? intent : { ...intent, ...intentOverrides },
    candidate,
  };
}
