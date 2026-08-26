// Disposable repository fixtures for P35 run-owned candidate composition.
// Construction uses argv git only. Disposable repositories never attach
// remotes, credentials, or push URLs. Tests own the assertions.

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONSTRAINED_VERIFICATION_SCHEMA_ID,
  CONSTRAINED_VERIFICATION_VERSION,
} from '../../mcp/v3/constrained-verification-runner.mjs';
import {
  expectedCandidateRefV1,
} from '../../mcp/v3/git-authority.mjs';
import {
  RUN_API_BOUNDARY_SCHEMA_ID,
  RUN_API_BOUNDARY_VERSION,
} from '../../mcp/v3/run-api-boundary.mjs';
import {
  RUN_CANDIDATE_COMPOSER_SCHEMA_ID,
  RUN_CANDIDATE_COMPOSER_VERSION,
} from '../../mcp/v3/run-candidate-composer.mjs';
import {
  RUN_COMBINED_VERIFIER_SCHEMA_ID,
  RUN_COMBINED_VERIFIER_VERSION,
} from '../../mcp/v3/run-combined-verifier.mjs';
import {
  ASSIGNMENT_ID as API_ASSIGNMENT_ID,
  BASE_SHA as API_BASE_SHA,
  RUN_ID as API_RUN_ID,
  validLane,
  validOrchestration,
} from './r1-run-api-boundary-fixtures.mjs';

export const RUN_ID = 'run-candidate-01';
export const ASSIGNMENT_A = 'lane-writer-a';
export const ASSIGNMENT_B = 'lane-writer-b';
export const ASSIGNMENT_VERIFY = 'lane-verify';
export const MAIN_REF = 'refs/heads/main';
export const HOSTILE_SECRET = 'sk-live-do-not-leak';
export const HOSTILE_PATH = '/tmp/secret-repo-do-not-leak';
export const HOSTILE_TOKEN = 'github_pat_hostiletoken';
export const BINARY_BYTES = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x61]);

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
  GIT_AUTHOR_NAME: 'p35',
  GIT_AUTHOR_EMAIL: 'p35@example.test',
  GIT_COMMITTER_NAME: 'p35',
  GIT_COMMITTER_EMAIL: 'p35@example.test',
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

export function git(cwd, args, env = GIT_ENV) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'init.defaultBranch=main',
    '-c', 'user.name=p35',
    '-c', 'user.email=p35@example.test',
    ...args,
  ], { cwd, encoding: 'buffer', env });
  if (result.status !== 0) {
    const error = new Error('disposable git command failed');
    error.code = 'git_fixture_failed';
    error.stderr = result.stderr?.toString('utf8');
    error.stdout = result.stdout?.toString('utf8');
    throw error;
  }
  return result.stdout.toString('utf8').trim();
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

export async function createBaseRepo(prefix = 'p35-compose-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  git(root, ['init', '--initial-branch=main']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'src/keep.txt'), 'keep-src\n', 'utf8');
  await writeFile(path.join(root, 'docs/keep.txt'), 'keep-docs\n', 'utf8');
  git(root, ['add', '--', 'src/keep.txt', 'docs/keep.txt']);
  git(root, ['commit', '-m', 'base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  return wrap(root, { baseSha, headSha: baseSha, mainRef: MAIN_REF });
}

export async function addWriterCommit(repo, {
  assignmentId,
  relativePath,
  contents,
  binary = false,
} = {}) {
  const branch = `lane-${assignmentId}`;
  git(repo.path, ['checkout', '-B', branch, repo.baseSha]);
  const abs = path.join(repo.path, relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  if (binary) await writeFile(abs, contents);
  else await writeFile(abs, contents, 'utf8');
  git(repo.path, ['add', '--', relativePath]);
  git(repo.path, ['commit', '-m', `delta-${assignmentId}`]);
  const headSha = git(repo.path, ['rev-parse', 'HEAD']);
  git(repo.path, ['checkout', '--detach', repo.baseSha]);
  git(repo.path, ['checkout', '-B', 'main', repo.baseSha]);
  return headSha;
}

export async function addSymlinkWriter(repo, assignmentId = ASSIGNMENT_A) {
  const branch = `lane-${assignmentId}`;
  git(repo.path, ['checkout', '-B', branch, repo.baseSha]);
  await symlink('keep.txt', path.join(repo.path, 'src/link'));
  git(repo.path, ['add', '--', 'src/link']);
  git(repo.path, ['commit', '-m', 'symlink']);
  const headSha = git(repo.path, ['rev-parse', 'HEAD']);
  git(repo.path, ['checkout', '-B', 'main', repo.baseSha]);
  return headSha;
}

export async function addRenameWriter(repo, assignmentId = ASSIGNMENT_A) {
  const branch = `lane-${assignmentId}`;
  git(repo.path, ['checkout', '-B', branch, repo.baseSha]);
  git(repo.path, ['mv', '--', 'src/keep.txt', 'src/renamed.txt']);
  git(repo.path, ['commit', '-m', 'rename']);
  const headSha = git(repo.path, ['rev-parse', 'HEAD']);
  git(repo.path, ['checkout', '-B', 'main', repo.baseSha]);
  return headSha;
}

export async function addModeChangeWriter(repo, assignmentId = ASSIGNMENT_A) {
  const branch = `lane-${assignmentId}`;
  git(repo.path, ['checkout', '-B', branch, repo.baseSha]);
  await chmod(path.join(repo.path, 'src/keep.txt'), 0o755);
  git(repo.path, ['add', '--', 'src/keep.txt']);
  git(repo.path, ['commit', '-m', 'mode']);
  const headSha = git(repo.path, ['rev-parse', 'HEAD']);
  git(repo.path, ['checkout', '-B', 'main', repo.baseSha]);
  return headSha;
}

export function writerLane(assignmentId, writeScope, state, headSha = null) {
  const lane = {
    assignment_id: assignmentId,
    role: 'implement',
    access: 'writer',
    write_scope: [...writeScope],
    state,
  };
  if (headSha !== null) lane.head_sha = headSha;
  return lane;
}

export function verifyLane(state = 'verified') {
  return {
    assignment_id: ASSIGNMENT_VERIFY,
    role: 'verify',
    access: 'read_only',
    write_scope: [],
    state,
  };
}

export function composeRequest(repo, lanes, overrides = {}) {
  const request = {
    schema: RUN_CANDIDATE_COMPOSER_SCHEMA_ID,
    version: RUN_CANDIDATE_COMPOSER_VERSION,
    identity: {
      repository_path: repo.path,
      base_sha: repo.baseSha,
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_A,
    },
    expected_base_ref: MAIN_REF,
    expected_protected_refs: [{ ref: MAIN_REF, sha: repo.baseSha }],
    lanes,
    ...overrides,
  };
  if (overrides.identity) request.identity = { ...request.identity, ...overrides.identity };
  return request;
}

export function candidateRef() {
  return expectedCandidateRefV1({ run_id: RUN_ID });
}

export function inspectRepo(repo) {
  const head = git(repo.path, ['rev-parse', 'HEAD']);
  const main = git(repo.path, ['rev-parse', MAIN_REF]);
  const remotes = git(repo.path, ['remote']);
  let candidate = null;
  try {
    candidate = git(repo.path, ['rev-parse', '--verify', '--end-of-options', candidateRef()]);
  } catch {
    candidate = null;
  }
  return { head, main, remotes, candidate };
}

export function parentsOf(repo, sha) {
  const line = git(repo.path, ['rev-list', '--parents', '--max-count=1', sha]);
  return line.split(' ').slice(1);
}

export function fileAt(repo, sha, relativePath) {
  return spawnSync('/usr/bin/git', ['-C', repo.path, 'show', `${sha}:${relativePath}`], {
    encoding: 'buffer', env: GIT_ENV,
  }).stdout;
}

export function verificationStub(outcome = 'pass') {
  return {
    schema: CONSTRAINED_VERIFICATION_SCHEMA_ID,
    version: CONSTRAINED_VERIFICATION_VERSION,
    command_id: 'unit-tests',
    outcome: { result: outcome, exit_code: outcome === 'pass' ? 0 : 1 },
    candidate_audit: { unchanged: true },
    facts: [],
  };
}

export async function executeVerificationStub() {
  return verificationStub();
}

export function boundOrchestration(repo) {
  const raw = validOrchestration({
    lanes: [validLane({ assignment_id: ASSIGNMENT_A })],
  });
  return JSON.parse(JSON.stringify(raw)
    .replaceAll(API_RUN_ID, RUN_ID)
    .replaceAll(API_ASSIGNMENT_ID, ASSIGNMENT_A)
    .replaceAll(API_BASE_SHA, repo.baseSha));
}

export function verifyRequest(repo, composition, overrides = {}) {
  const orchestration = boundOrchestration(repo);
  return {
    schema: RUN_COMBINED_VERIFIER_SCHEMA_ID,
    version: RUN_COMBINED_VERIFIER_VERSION,
    identity: {
      repository_path: repo.path,
      base_sha: repo.baseSha,
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_A,
      provider: 'grok',
    },
    expected_base_ref: MAIN_REF,
    expected_protected_refs: [{ ref: MAIN_REF, sha: repo.baseSha }],
    composition,
    orchestration,
    verification: {
      candidate: {
        repository: { path: repo.path, base_sha: repo.baseSha },
        expected_base_sha: repo.baseSha,
        expected_head_sha: composition.candidate_sha,
      },
      intent: { command_id: 'unit-tests' },
      policy: { schema: 'codex-co-engineer.verification-policy.v1' },
    },
    ...overrides,
  };
}

export { RUN_API_BOUNDARY_SCHEMA_ID, RUN_API_BOUNDARY_VERSION };
