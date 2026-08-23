// Disposable repository fixtures for W16-P15 scope, read-only, and
// merge-commit verification. Construction uses argv git only; the product
// verifier is never imported here so forged histories and hostile paths
// stay parent-failing until the verifier module exists.

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const RUN_ID = 'run-scope-verify-01';
export const ASSIGNMENT_ID = 'lane-writer';
export const READ_ONLY_ASSIGNMENT_ID = 'lane-verify';
export const OTHER_ASSIGNMENT_ID = 'lane-other';
export const BASE_REF = 'refs/heads/main';
export const WRITE_SCOPE = Object.freeze(['src/**']);
export const OTHER_WRITE_SCOPE = Object.freeze(['docs/**']);

const GIT = '/usr/bin/git';
const FIXTURE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'P15 Fixture',
  GIT_AUTHOR_EMAIL: 'p15@example.test',
  GIT_COMMITTER_NAME: 'P15 Fixture',
  GIT_COMMITTER_EMAIL: 'p15@example.test',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
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

export function identityRequest(repo, overrides = {}) {
  return {
    repository: {
      path: overrides.path ?? repo.path,
      base_sha: overrides.base_sha ?? repo.baseSha,
    },
    expected_base_ref: overrides.expected_base_ref ?? BASE_REF,
    candidate_head_sha: overrides.candidate_head_sha ?? overrides.head_sha ?? repo.headSha,
    run_id: overrides.run_id ?? RUN_ID,
    assignment_id: overrides.assignment_id ?? ASSIGNMENT_ID,
    sequence: overrides.sequence ?? 0,
  };
}

export function scopeRequest(repo, identity, overrides = {}) {
  const request = {
    identity_request: overrides.identity_request ?? identityRequest(repo, overrides),
    identity,
    access: overrides.access ?? 'writer',
    write_scope: overrides.write_scope ?? [...WRITE_SCOPE],
    other_write_scopes: overrides.other_write_scopes ?? [],
  };
  for (const key of Object.keys(overrides)) {
    if (key === 'path' || key === 'base_sha' || key === 'head_sha'
      || key === 'identity_request' || key === 'expected_base_ref'
      || key === 'candidate_head_sha' || key === 'run_id'
      || key === 'assignment_id' || key === 'sequence') {
      continue;
    }
    request[key] = overrides[key];
  }
  return request;
}

function runFixtureGit(cwd, args, env = FIXTURE_ENV) {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        const error = new Error(`fixture git failed: ${args.join(' ')}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function emptyRepo(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await runFixtureGit(root, ['-c', 'init.defaultBranch=main', 'init', '--initial-branch=main']);
  return root;
}

async function writeAndAdd(root, relative, contents) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  await runFixtureGit(root, ['add', '--', relative]);
}

async function commit(root, message) {
  await runFixtureGit(root, ['commit', '-m', `${message} ${root}`]);
  return runFixtureGit(root, ['rev-parse', 'HEAD']);
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

export async function createInScopeWriterRepo() {
  const root = await emptyRepo('p15-inscope-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  await writeAndAdd(root, 'docs/readme.txt', 'docs\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await writeAndAdd(root, 'src/added.txt', 'added\n');
  const headSha = await commit(root, 'head');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { files: ['src/added.txt'] } });
}

export async function createOutOfScopeWriterRepo() {
  const root = await emptyRepo('p15-outofscope-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await writeAndAdd(root, 'docs/secret.txt', 'secret\n');
  const headSha = await commit(root, 'head');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { files: ['docs/secret.txt'] } });
}

export async function createReadOnlyUnchangedRepo() {
  const root = await emptyRepo('p15-readonly-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  return wrap(root, { baseSha, headSha: baseSha, extra: {} });
}

export async function createReadOnlyMutatedRepo() {
  const repo = await createInScopeWriterRepo();
  return repo;
}

export async function createRenameInScopeRepo() {
  const root = await emptyRepo('p15-rename-');
  await writeAndAdd(root, 'src/old.txt', 'rename-me\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await runFixtureGit(root, ['mv', '--', 'src/old.txt', 'src/new.txt']);
  const headSha = await commit(root, 'rename');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { from: 'src/old.txt', to: 'src/new.txt' } });
}

export async function createRenameEscapingRepo() {
  const root = await emptyRepo('p15-rename-escape-');
  await writeAndAdd(root, 'src/old.txt', 'escape-me\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await runFixtureGit(root, ['mv', '--', 'src/old.txt', 'docs/escaped.txt']);
  const headSha = await commit(root, 'escape');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, {
    baseSha, headSha, extra: { from: 'src/old.txt', to: 'docs/escaped.txt' },
  });
}

export async function createCopyInScopeRepo() {
  const root = await emptyRepo('p15-copy-');
  await writeAndAdd(root, 'src/original.txt', 'unique-copy-blob-p15-0123456789\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await writeAndAdd(root, 'src/copied.txt', 'unique-copy-blob-p15-0123456789\n');
  const headSha = await commit(root, 'copy');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { from: 'src/original.txt', to: 'src/copied.txt' } });
}

export async function createCopyEscapingRepo() {
  const root = await emptyRepo('p15-copy-escape-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  await writeAndAdd(root, 'docs/secret.txt', 'unique-copy-blob-docs-9876543210\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await writeAndAdd(root, 'src/fromdocs.txt', 'unique-copy-blob-docs-9876543210\n');
  const headSha = await commit(root, 'copy-escape');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, {
    baseSha, headSha, extra: { from: 'docs/secret.txt', to: 'src/fromdocs.txt' },
  });
}

export async function createIgnoredOutOfScopeRepo() {
  const root = await emptyRepo('p15-ignored-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  await writeAndAdd(root, 'docs/readme.txt', 'docs\n');
  await writeAndAdd(root, '.gitignore', 'scratch.ignored\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await writeAndAdd(root, 'src/added.txt', 'added\n');
  const headSha = await commit(root, 'head');
  await runFixtureGit(root, ['checkout', 'main']);
  await writeFile(path.join(root, 'docs', 'scratch.ignored'), 'ignored-out\n', 'utf8');
  return wrap(root, { baseSha, headSha, extra: { ignored: 'docs/scratch.ignored' } });
}

export async function createHiddenIndexFlagRepo() {
  const repo = await createInScopeWriterRepo();
  await runFixtureGit(repo.path, ['update-index', '--assume-unchanged', '--', 'src/keep.txt']);
  await runFixtureGit(repo.path, ['update-index', '--skip-worktree', '--', 'docs/readme.txt']);
  repo.extra = { ...repo.extra, assume_unchanged: 'src/keep.txt', skip_worktree: 'docs/readme.txt' };
  return repo;
}

export async function createFileModeHiddenChmodRepo() {
  const repo = await createReadOnlyUnchangedRepo();
  await runFixtureGit(repo.path, ['config', 'core.fileMode', 'false']);
  await chmod(path.join(repo.path, 'src', 'keep.txt'), 0o755);
  repo.extra = { ...repo.extra, chmod: 'src/keep.txt' };
  return repo;
}

export async function createUntrackedSymlinkRepo() {
  const repo = await createInScopeWriterRepo();
  await symlink('keep.txt', path.join(repo.path, 'src', 'link-untracked.txt'));
  repo.extra = { ...repo.extra, untracked: 'src/link-untracked.txt' };
  return repo;
}

export async function createDeletionInScopeRepo() {
  const root = await emptyRepo('p15-delete-');
  await writeAndAdd(root, 'src/gone.txt', 'delete-me\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await runFixtureGit(root, ['rm', '--', 'src/gone.txt']);
  const headSha = await commit(root, 'delete');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { deleted: 'src/gone.txt' } });
}

export async function createOverlapRepo() {
  const root = await emptyRepo('p15-overlap-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  await writeAndAdd(root, 'docs/readme.txt', 'docs\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await writeAndAdd(root, 'docs/taken.txt', 'overlap\n');
  const headSha = await commit(root, 'overlap');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { files: ['docs/taken.txt'] } });
}

export async function createMergeCommitRepo() {
  const root = await emptyRepo('p15-merge-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['checkout', '-b', 'candidate']);
  await runFixtureGit(root, ['checkout', '-b', 'topic']);
  await writeAndAdd(root, 'src/topic.txt', 'topic\n');
  await commit(root, 'topic');
  await runFixtureGit(root, ['checkout', 'candidate']);
  await writeAndAdd(root, 'src/mainline.txt', 'mainline\n');
  await commit(root, 'mainline');
  await runFixtureGit(root, [
    'merge', '--no-ff', '--no-edit', '-m', `merge ${root}`, 'topic',
  ]);
  const headSha = await runFixtureGit(root, ['rev-parse', 'HEAD']);
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: {} });
}

export async function createMergeHeadEqualsBaseRepo() {
  const merge = await createMergeCommitRepo();
  await runFixtureGit(merge.path, ['checkout', 'candidate']);
  await runFixtureGit(merge.path, ['checkout', '-B', 'main', merge.headSha]);
  merge.baseSha = merge.headSha;
  return merge;
}

export async function createHistoricalMergeRepo() {
  const merge = await createMergeCommitRepo();
  await runFixtureGit(merge.path, ['checkout', 'candidate']);
  await writeAndAdd(merge.path, 'src/after-merge.txt', 'later\n');
  const headSha = await commit(merge.path, 'after-merge');
  await runFixtureGit(merge.path, ['checkout', 'main']);
  merge.headSha = headSha;
  merge.extra = { ...merge.extra, after: 'src/after-merge.txt' };
  return merge;
}

export async function createSymlinkRepo() {
  const root = await emptyRepo('p15-symlink-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await symlink('keep.txt', path.join(root, 'src', 'link.txt'));
  await runFixtureGit(root, ['add', '--', 'src/link.txt']);
  const headSha = await commit(root, 'symlink');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { link: 'src/link.txt' } });
}

export async function createGitlinkRepo() {
  const root = await emptyRepo('p15-gitlink-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await runFixtureGit(root, [
    'update-index', '--add', '--cacheinfo', `160000,${baseSha},src/vendor`,
  ]);
  const headSha = await commit(root, 'gitlink');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { gitlink: 'src/vendor' } });
}

export async function createTypeChangeRepo() {
  const root = await emptyRepo('p15-typechange-');
  await writeAndAdd(root, 'src/file.txt', 'plain\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  await runFixtureGit(root, ['rm', '--', 'src/file.txt']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await symlink('keep-target', path.join(root, 'src', 'file.txt'));
  await runFixtureGit(root, ['add', '--', 'src/file.txt']);
  const headSha = await commit(root, 'typechange');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { path: 'src/file.txt' } });
}

export async function createUnicodeNfcRepo() {
  const root = await emptyRepo('p15-nfc-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  const nfcName = 'src/caf\u00e9.txt';
  await writeAndAdd(root, nfcName, 'nfc\n');
  const headSha = await commit(root, 'nfc');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { path: nfcName } });
}

export async function createNonNfcRepo() {
  const root = await emptyRepo('p15-nfd-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  const nfdName = 'src/cafe\u0301.txt';
  await writeAndAdd(root, nfdName, 'nfd\n');
  const headSha = await commit(root, 'nfd');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { path: nfdName } });
}

export async function createConfusableSeparatorRepo() {
  const root = await emptyRepo('p15-confusable-');
  await writeAndAdd(root, 'src/keep.txt', 'keep\n');
  const baseSha = await commit(root, 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  const hostile = `src/look${String.fromCodePoint(0x2215)}alike.txt`;
  await writeAndAdd(root, hostile, 'confusable\n');
  const headSha = await commit(root, 'confusable');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { path: hostile } });
}

export async function createUntrackedInScopeRepo() {
  const repo = await createInScopeWriterRepo();
  await writeFile(path.join(repo.path, 'src', 'scratch.txt'), 'untracked\n', 'utf8');
  repo.extra = { ...repo.extra, untracked: 'src/scratch.txt' };
  return repo;
}

export async function createUntrackedOutOfScopeRepo() {
  const repo = await createInScopeWriterRepo();
  await writeFile(path.join(repo.path, 'docs', 'scratch.txt'), 'untracked\n', 'utf8');
  repo.extra = { ...repo.extra, untracked: 'docs/scratch.txt' };
  return repo;
}

export async function createStagedUntrackedMixRepo() {
  const repo = await createInScopeWriterRepo();
  await writeFile(path.join(repo.path, 'src', 'staged.txt'), 'staged\n', 'utf8');
  await runFixtureGit(repo.path, ['add', '--', 'src/staged.txt']);
  repo.extra = { ...repo.extra, staged: 'src/staged.txt' };
  return repo;
}

export { runFixtureGit };
