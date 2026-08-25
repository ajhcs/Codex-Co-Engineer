// Neutral fixtures for RunPreflightV1 tests: disposable repositories built
// with argv git only, run manifests, injected host facts, and a recording
// spawn that delegates to the real git binary while capturing every argv.
// Tests own the assertions; nothing here ranks, defaults, or substitutes.

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GIT_CLOSED_ENV,
  GIT_EXECUTABLE,
} from '../../mcp/v3/git-identity.mjs';
import { PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD } from '../../mcp/v3/run-preflight.mjs';

export { PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD };

export const RUN_ID = 'preflight-under-test';
export const ASSIGNMENT_ID_A = 'lane-alpha';
export const ASSIGNMENT_ID_B = 'lane-beta';

const FIXTURE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'P26 Fixture',
  GIT_AUTHOR_EMAIL: 'p26@example.test',
  GIT_COMMITTER_NAME: 'P26 Fixture',
  GIT_COMMITTER_EMAIL: 'p26@example.test',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
});

function runFixtureGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(GIT_EXECUTABLE, args, {
      cwd,
      env: { ...FIXTURE_ENV },
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
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function initRepo(root) {
  await mkdir(root, { recursive: true });
  await runFixtureGit(root, ['-c', 'init.defaultBranch=main', 'init', '--initial-branch=main']);
  return root;
}

async function commitAll(root, message, fileName = 'file.txt') {
  await writeFile(path.join(root, fileName), `${message}\n`, 'utf8');
  await runFixtureGit(root, ['add', '--', fileName]);
  await runFixtureGit(root, ['commit', '-m', message]);
  return runFixtureGit(root, ['rev-parse', 'HEAD']);
}

function wrapRepo(root, fields) {
  return { root, ...fields, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function createLinearRepo(prefix = 'p26-linear-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await initRepo(root);
  await commitAll(root, 'base commit', 'base.txt');
  const baseSha = await runFixtureGit(root, ['rev-parse', 'HEAD']);
  await commitAll(root, 'head commit', 'head.txt');
  const headSha = await runFixtureGit(root, ['rev-parse', 'HEAD']);
  return wrapRepo(root, { baseSha, headSha });
}

export async function createDetachedHeadRepo(prefix = 'p26-detached-') {
  const repo = await createLinearRepo(prefix);
  await runFixtureGit(repo.root, ['checkout', '--detach', repo.baseSha]);
  return repo;
}

export async function createTagObjectRepo(prefix = 'p26-tagobj-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await initRepo(root);
  await commitAll(root, 'base commit', 'base.txt');
  const baseSha = await runFixtureGit(root, ['rev-parse', 'HEAD']);
  const treeSha = await runFixtureGit(root, ['rev-parse', 'HEAD^{tree}']);
  const blobSha = await runFixtureGit(root, ['rev-parse', 'HEAD:base.txt']);
  await runFixtureGit(root, ['tag', '-a', '-m', 'release tag', 'v1', baseSha]);
  const tagSha = await runFixtureGit(root, ['rev-parse', 'v1']);
  return wrapRepo(root, { baseSha, headSha: baseSha, treeSha, blobSha, tagSha });
}

export async function createReplaceRefRepo(prefix = 'p26-replace-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await initRepo(root);
  const baseSha = await commitAll(root, 'base commit', 'base.txt');
  await commitAll(root, 'second commit', 'second.txt');
  const replacementSha = await runFixtureGit(root, ['rev-parse', 'HEAD']);
  // A raw ref write installs the shadow without plumbing validation, so the
  // fixture does not depend on `git replace` type rules.
  await runFixtureGit(root, ['update-ref', `refs/replace/${baseSha}`, replacementSha]);
  return wrapRepo(root, { baseSha, headSha: replacementSha });
}

export async function createBareRepo(prefix = 'p26-bare-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(root, { recursive: true });
  await runFixtureGit(root, ['-c', 'init.defaultBranch=main', 'init', '--bare', '--initial-branch=main']);
  return wrapRepo(root, { baseSha: null, headSha: null });
}

export async function createEmptyDirectory(prefix = 'p26-empty-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return wrapRepo(root, { baseSha: null, headSha: null });
}

export async function createSymlinkAliasRepo(prefix = 'p26-symlink-') {
  const repo = await createLinearRepo(prefix);
  const parent = path.dirname(repo.root);
  const alias = path.join(parent, `${path.basename(repo.root)}-alias`);
  await symlink(repo.root, alias, 'dir');
  return {
    ...repo,
    cleanup: () => {
      rm(alias, { force: true }).catch(() => {});
      return repo.cleanup();
    },
  };
}

export async function createLinkedWorktreeRepo(prefix = 'p26-worktree-') {
  const repo = await createLinearRepo(prefix);
  const worktreePath = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-wt`);
  await runFixtureGit(repo.root, ['worktree', 'add', worktreePath, repo.headSha]);
  return {
    ...repo,
    worktreePath,
    cleanup: () => rm(worktreePath, { recursive: true, force: true }).then(() => repo.cleanup()),
  };
}

export async function forgeGitDirFileRepo(prefix = 'p26-forged-') {
  const repo = await createLinearRepo(prefix);
  const bogusTarget = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-bogus-gitdir`);
  await mkdir(bogusTarget, { recursive: true });
  await rm(path.join(repo.root, '.git'), { recursive: true, force: true });
  await writeFile(path.join(repo.root, '.git'), `gitdir: ${bogusTarget}\n`, 'utf8');
  return { ...repo, bogusTarget };
}

// Two independent repositories; one worktree root's `.git` entry is replaced
// with a symlink at the other repository's real git directory, so git
// observations succeed while the layout is untrusted.
export async function createSymlinkedGitDirRepo(prefix = 'p26-symgit-') {
  const victim = await createLinearRepo(`${prefix}victim-`);
  const donorRoot = path.join(path.dirname(victim.root), `${path.basename(victim.root)}-donor`);
  await initRepo(donorRoot);
  await rm(path.join(victim.root, '.git'), { recursive: true, force: true });
  await symlink(path.join(donorRoot, '.git'), path.join(victim.root, '.git'), 'dir');
  return {
    root: victim.root,
    baseSha: victim.baseSha,
    headSha: victim.headSha,
    cleanup: () => rm(donorRoot, { recursive: true, force: true }).then(() => victim.cleanup()),
  };
}

const POLICY_TEMPLATE = Object.freeze({
  max_concurrency: 8,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});

export function writerLane(id, scopes, overrides = {}) {
  return {
    assignment_id: id,
    role: 'implement',
    access: 'writer',
    prompt: `Implement lane ${id}.`,
    write_scope: scopes,
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
    execution: { provider: 'grok', model: 'grok-4' },
    ...overrides,
  };
}

export function preflightManifest(assignments, overrides = {}) {
  const count = assignments.length;
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: RUN_ID,
    repository: {
      path: overrides.repositoryPath ?? '/run-fixtures/repository',
      base_sha: overrides.baseSha ?? '0123456789abcdef0123456789abcdef01234567',
    },
    objective: 'Validate the run before any launch surface runs.',
    assignments,
    policy: { ...POLICY_TEMPLATE, ...(overrides.policy ?? {}) },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  };
}

export function twoLaneManifest(overrides = {}) {
  return preflightManifest([
    writerLane(ASSIGNMENT_ID_A, ['src/alpha/**']),
    writerLane(ASSIGNMENT_ID_B, ['src/beta/**']),
  ], overrides);
}

export function laneManifestsForCount(count, overrides = {}) {
  const assignments = [];
  for (let index = 0; index < count; index += 1) {
    assignments.push(writerLane(`lane-${String(index).padStart(2, '0')}`, [`src/area-${index}/**`]));
  }
  return preflightManifest(assignments, overrides);
}

export function hostFacts(overrides = {}) {
  return {
    cpu_parallelism: 8,
    total_ram_bytes: 34_359_738_368,
    available_ram_bytes: 8 * PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD,
    ...overrides,
  };
}

export function createRecordingSpawn() {
  const records = [];
  let failNextStart = false;
  const spawnFn = (file, args, options) => {
    const envKeys = options && options.env ? Object.keys(options.env).sort() : [];
    records.push({ file, args: [...args], envKeys, cwd: options?.cwd });
    if (failNextStart) {
      failNextStart = false;
      throw new Error('injected spawn failure');
    }
    return nodeSpawn(file, args, options);
  };
  return {
    spawn: spawnFn,
    records,
    files: () => records.map((record) => record.file),
    commands: () => records.map((record) => record.args.filter(
      (arg) => !arg.startsWith('-') && !arg.includes('=') && arg !== '/usr/bin/git',
    )),
    failNext() {
      failNextStart = true;
    },
  };
}
