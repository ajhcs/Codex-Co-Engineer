// Disposable repository fixtures for P30 live protected-ref audit.
// Construction uses argv git only. Disposable repositories never attach
// remotes, credentials, or push URLs. Tests own the assertions.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PROTECTED_REF_AUDIT_SCHEMA_ID,
  PROTECTED_REF_AUDIT_VERSION,
} from '../../mcp/v3/protected-ref-audit.mjs';

export const RUN_ID = 'run-protected-ref-01';
export const ASSIGNMENT_ID = 'lane-audit';
export const MAIN_REF = 'refs/heads/main';
export const MASTER_REF = 'refs/heads/master';
export const CONTENT_FREE = /^[A-Za-z0-9_=.:/\[\]()";', -]+$/u;

export const GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'p30',
  GIT_AUTHOR_EMAIL: 'p30@example.test',
  GIT_COMMITTER_NAME: 'p30',
  GIT_COMMITTER_EMAIL: 'p30@example.test',
});

export function countingProxy(target) {
  const counts = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0, apply: 0 };
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      counts.get += 1;
      return Reflect.get(inner, property, receiver);
    },
    ownKeys(inner) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, property) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
    has(inner, property) {
      counts.has += 1;
      return Reflect.has(inner, property);
    },
    apply() {
      counts.apply += 1;
      throw new Error('proxy apply must never run');
    },
  });
  return { proxy, counts };
}

export function trapTotal(counts) {
  return counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has + counts.apply;
}

export function git(cwd, args, env = GIT_ENV) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'init.defaultBranch=main',
    '-c', 'user.name=p30',
    '-c', 'user.email=p30@example.test',
    ...args,
  ], { cwd, encoding: 'utf8', env });
  if (result.status !== 0) {
    const error = new Error('disposable git command failed');
    error.code = 'git_fixture_failed';
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

export async function cleanupRepo(root) {
  await rm(root, { recursive: true, force: true });
}

function wrap(root, fields) {
  return {
    path: root,
    ...fields,
    cleanup: () => cleanupRepo(root),
  };
}

async function emptyRepo(prefix, extraArgs = []) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  git(root, ['init', '--initial-branch=main', ...extraArgs]);
  return root;
}

async function commit(root, message, fileName = 'file.txt', contents = message) {
  await writeFile(path.join(root, fileName), `${contents}\n`, 'utf8');
  git(root, ['add', '--', fileName]);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

export function validIdentity(repositoryPath, baseSha, overrides = {}) {
  return {
    repository_path: repositoryPath,
    base_sha: baseSha,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    ...overrides,
  };
}

export function validRequest(repositoryPath, baseSha, overrides = {}) {
  const expectedRefs = overrides.expected_refs ?? [{ ref: MAIN_REF, sha: baseSha }];
  const request = {
    schema: PROTECTED_REF_AUDIT_SCHEMA_ID,
    version: PROTECTED_REF_AUDIT_VERSION,
    identity: overrides.identity ?? validIdentity(repositoryPath, baseSha, overrides.identity_overrides),
    expected_refs: expectedRefs,
  };
  for (const key of Object.keys(overrides)) {
    if (key === 'identity_overrides' || key === 'expected_refs' || key === 'identity') continue;
    request[key] = overrides[key];
  }
  if (overrides.identity) request.identity = overrides.identity;
  if (overrides.expected_refs) request.expected_refs = overrides.expected_refs;
  return request;
}

export async function createLocalProtectedRepo(prefix = 'p30-local-') {
  const root = await emptyRepo(prefix);
  const baseSha = await commit(root, 'base', 'base.txt', 'base');
  git(root, ['tag', 'v1', baseSha]);
  const tagSha = git(root, ['rev-parse', 'refs/tags/v1']);
  return wrap(root, { baseSha, headSha: baseSha, tagSha, kind: 'local' });
}

export async function createPackedProtectedRepo(prefix = 'p30-packed-') {
  const repo = await createLocalProtectedRepo(prefix);
  git(repo.path, ['pack-refs', '--all']);
  return { ...repo, kind: 'packed' };
}

export async function createBareProtectedRepo(prefix = 'p30-bare-') {
  const source = await createLocalProtectedRepo(`${prefix}src-`);
  const bareRoot = path.join(path.dirname(source.path), `${path.basename(source.path)}-bare`);
  git(path.dirname(source.path), ['clone', '--bare', '--local', source.path, bareRoot]);
  const baseSha = git(bareRoot, ['rev-parse', 'refs/heads/main']);
  const tagSha = git(bareRoot, ['rev-parse', 'refs/tags/v1']);
  return wrap(bareRoot, {
    baseSha,
    headSha: baseSha,
    tagSha,
    kind: 'bare',
    cleanup: async () => {
      await cleanupRepo(bareRoot);
      await source.cleanup();
    },
  });
}

export async function createLinkedWorktreeProtectedRepo(prefix = 'p30-wt-') {
  const repo = await createLocalProtectedRepo(prefix);
  const worktreePath = path.join(path.dirname(repo.path), `${path.basename(repo.path)}-wt`);
  git(repo.path, ['worktree', 'add', '--detach', worktreePath, repo.headSha]);
  return {
    ...repo,
    worktreePath,
    kind: 'linked_worktree',
    cleanup: async () => {
      await rm(worktreePath, { recursive: true, force: true });
      await repo.cleanup();
    },
  };
}

export async function createMovedProtectedRepo(prefix = 'p30-moved-') {
  const repo = await createLocalProtectedRepo(prefix);
  const original = repo.baseSha;
  const movedSha = await commit(repo.path, 'moved', 'moved.txt', 'moved');
  return { ...repo, baseSha: original, headSha: movedSha, movedSha, kind: 'moved' };
}

export async function createSymbolicProtectedRepo(prefix = 'p30-sym-') {
  const repo = await createLocalProtectedRepo(prefix);
  git(repo.path, ['symbolic-ref', 'refs/heads/release', MAIN_REF]);
  return { ...repo, aliasRef: 'refs/heads/release', kind: 'symbolic' };
}

export async function createAliasedLooseProtectedRepo(prefix = 'p30-alias-') {
  const repo = await createLocalProtectedRepo(prefix);
  git(repo.path, ['branch', 'master', repo.baseSha]);
  const loose = path.join(repo.path, '.git', 'refs', 'heads', 'main');
  await rm(loose, { force: true });
  await symlink('master', loose);
  return { ...repo, kind: 'aliased' };
}

export async function createMissingDefaultRepo(prefix = 'p30-missing-') {
  const repo = await createLocalProtectedRepo(prefix);
  return { ...repo, kind: 'missing' };
}

export async function createReplaceProtectedRepo(prefix = 'p30-replace-') {
  const repo = await createLocalProtectedRepo(prefix);
  const tree = git(repo.path, ['rev-parse', 'HEAD^{tree}']);
  const forged = git(repo.path, ['commit-tree', tree, '-m', 'forged-replace']);
  git(repo.path, ['update-ref', `refs/replace/${repo.baseSha}`, forged]);
  return { ...repo, extra: { forged }, kind: 'replace' };
}

export async function createGraftsProtectedRepo(prefix = 'p30-grafts-') {
  const repo = await createLocalProtectedRepo(prefix);
  const infoDir = path.join(repo.path, '.git', 'info');
  await mkdir(infoDir, { recursive: true });
  await writeFile(path.join(infoDir, 'grafts'), `${repo.headSha} ${'0'.repeat(40)}\n`, 'utf8');
  return { ...repo, kind: 'grafts' };
}

export async function createSymlinkAliasPathRepo(prefix = 'p30-linkpath-') {
  const repo = await createLocalProtectedRepo(prefix);
  const alias = path.join(path.dirname(repo.path), `${path.basename(repo.path)}-alias`);
  await symlink(repo.path, alias, 'dir');
  return {
    ...repo,
    aliasPath: alias,
    cleanup: async () => {
      await rm(alias, { force: true });
      await repo.cleanup();
    },
  };
}

export async function snapshotRepositoryIdentity(root) {
  const entries = [];
  async function walk(relative) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      entries.push({ p: relative, t: 'dir', m: metadata.mode });
      const children = await readdir(absolute);
      children.sort();
      for (const child of children) await walk(path.join(relative, child));
      return;
    }
    if (metadata.isSymbolicLink()) {
      entries.push({ p: relative, t: 'link', m: metadata.mode });
      return;
    }
    const digest = createHash('sha256');
    if (metadata.size <= 1024 * 1024) digest.update(await readFile(absolute));
    else digest.update(String(metadata.size));
    entries.push({
      p: relative, t: 'file', m: metadata.mode, s: metadata.size, h: digest.digest('hex'),
    });
  }
  await walk('');
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return { entries, refs };
}

export function createRecordingSpawn(mutateOnDeclaredSnapshot) {
  const records = [];
  let declaredSnapshots = 0;
  const spawnFn = (file, args, options) => {
    const env = options?.env ?? {};
    records.push({
      file,
      args: [...args],
      envKeys: Object.keys(env).sort(),
      env: { ...env },
      cwd: options?.cwd,
    });
    const isForEach = Array.isArray(args) && args.includes('for-each-ref');
    const isReplace = Array.isArray(args) && args.includes('refs/replace');
    if (typeof mutateOnDeclaredSnapshot === 'function' && isForEach && !isReplace) {
      declaredSnapshots += 1;
      if (declaredSnapshots === 2) mutateOnDeclaredSnapshot();
    }
    return spawn(file, args, options);
  };
  return { spawn: spawnFn, records };
}

export function fixtureGitCommands(records) {
  const commands = [];
  for (const record of records) {
    for (let i = 0; i < record.args.length; i += 1) {
      const arg = record.args[i];
      if (arg === '-C' || arg === '--git-dir' || arg === '-c') {
        i += 1;
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('-')) continue;
      commands.push(arg);
      break;
    }
  }
  return commands;
}
