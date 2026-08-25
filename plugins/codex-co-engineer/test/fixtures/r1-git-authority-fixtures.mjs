// Shared fixtures for the P28 GitAuthorityPolicyV1 tests.
// Construction only: tests own the assertions. Disposable repositories
// never attach remotes or credentials.

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
} from '../../mcp/v3/git-authority.mjs';

export const RUN_ID = 'run-authority-01';
export const ASSIGNMENT_ID = 'lane-alpha';
export const OTHER_ASSIGNMENT_ID = 'lane-beta';
export const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
export const REPOSITORY_PATH = '/tmp/cce-r1-authority-repo';
export const MANIFEST_DIGEST_HEX = 'ab'.repeat(32);
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
  GIT_AUTHOR_NAME: 'p28',
  GIT_AUTHOR_EMAIL: 'p28@example.test',
  GIT_COMMITTER_NAME: 'p28',
  GIT_COMMITTER_EMAIL: 'p28@example.test',
});

export function validIdentity(overrides = {}) {
  return {
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    ...overrides,
  };
}

export function operationRequest(overrides = {}) {
  return {
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: 'worker',
    operation: 'commit_on_lane_branch',
    identity: validIdentity(),
    manifest_digest_hex: MANIFEST_DIGEST_HEX,
    ...overrides,
  };
}

export function git(cwd, args) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'init.defaultBranch=main',
    '-c', 'user.name=p28',
    '-c', 'user.email=p28@example.test',
    ...args,
  ], { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) {
    const error = new Error('disposable git command failed');
    error.code = 'git_fixture_failed';
    throw error;
  }
  return result.stdout;
}

export async function withDisposableRepo(build) {
  const root = await mkdtemp(path.join(tmpdir(), 'cce-r1-p28-'));
  try {
    return await build(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function initRepo(root) {
  git(root, ['init', '--initial-branch=main']);
  git(root, ['commit', '--allow-empty', '-m', 'base']);
}

export function parentCounts(root, spec = 'HEAD') {
  const output = git(root, ['rev-list', '--parents', '--reverse', spec]);
  const counts = [];
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    counts.push(line.split(' ').length - 1);
  }
  return counts;
}

export async function writeLinearHistory(root) {
  await initRepo(root);
  git(root, ['commit', '--allow-empty', '-m', 'second']);
  return parentCounts(root);
}

export async function writeMergeHistory(root) {
  await initRepo(root);
  git(root, ['checkout', '-b', 'other']);
  git(root, ['commit', '--allow-empty', '-m', 'side']);
  git(root, ['checkout', 'main']);
  git(root, ['merge', '--no-ff', '-m', 'merge', 'other']);
  return parentCounts(root);
}

export async function writeOctopusHistory(root) {
  await initRepo(root);
  git(root, ['checkout', '-b', 'one']);
  git(root, ['commit', '--allow-empty', '-m', 'one']);
  git(root, ['checkout', 'main']);
  git(root, ['checkout', '-b', 'two']);
  git(root, ['commit', '--allow-empty', '-m', 'two']);
  git(root, ['checkout', 'main']);
  git(root, ['merge', '--no-ff', '-m', 'octopus', 'one', 'two']);
  return parentCounts(root);
}

export async function writeDefaultBranchTarget(root) {
  await initRepo(root);
  await writeFile(path.join(root, 'tracked.txt'), 'lane\n', 'utf8');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'tracked']);
  const defaultBranch = git(root, ['symbolic-ref', '--short', 'HEAD']).trim();
  return { defaultBranch, counts: parentCounts(root) };
}
