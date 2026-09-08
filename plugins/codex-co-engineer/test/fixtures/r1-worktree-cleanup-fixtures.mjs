// Shared fixtures for R1-340 proof-bound worktree cleanup planner/adapter
// tests. Construction only: tests own the assertions. Injected operations
// never delete real worktrees or refs.

import { expectedLaneRefV1, expectedRunBranchNameV1 } from '../../mcp/v3/git-authority.mjs';
import { WORKTREE_CLEANUP_PROOF_SCHEMA_ID } from '../../mcp/v3/worktree-cleanup-planner.mjs';

export const RUN_ID = 'run-cleanup-01';
export const ASSIGNMENT_ID = 'lane-alpha';
export const TASK_ID = 'task-cleanup-01';
export const OTHER_TASK_ID = 'task-cleanup-99';
export const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
export const HEAD_SHA = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1';
export const TREE_SHA = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';
export const OTHER_SHA = 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3';
export const REPOSITORY_PATH = '/tmp/cce-r1-cleanup-repo';
export const WORKTREE_PATH = '/tmp/cce-r1-cleanup-worktree';
export const ESCAPE_PATH = '/etc/passwd';
export const GIT_DIR = '/tmp/cce-r1-cleanup-repo/.git/worktrees/task-cleanup-01';
export const OTHER_GIT_DIR = '/tmp/cce-r1-cleanup-repo/.git/worktrees/reused';
export const LOCK_ID = 'lock-cleanup-01';
export const OTHER_LOCK_ID = 'lock-cleanup-99';
export const MANIFEST_DIGEST_HEX = 'ab'.repeat(32);
export const ARTIFACT_PATH = 'tasks/task-cleanup-01/receipt.json';
export const ARTIFACT_PATH_B = 'tasks/task-cleanup-01/handoff.md';
export const CONTENT_FREE = /^[A-Za-z0-9_=.:/\[\]()";', -]+$/u;
export const HOSTILE_PATH = '/tmp/hostile-secret-path';
export const HOSTILE_URL = 'https://example.test/steal';
export const HOSTILE_GIT = 'git@example.test:steal.git';
export const HOSTILE_SECRET = 'sk-hostile-secret';

export const LANE_BRANCH = expectedRunBranchNameV1({
  assignment_id: ASSIGNMENT_ID,
  manifest_digest_hex: MANIFEST_DIGEST_HEX,
  run_id: RUN_ID,
});
export const LANE_REF = expectedLaneRefV1({
  assignment_id: ASSIGNMENT_ID,
  manifest_digest_hex: MANIFEST_DIGEST_HEX,
  run_id: RUN_ID,
});

export function validProof(overrides = {}) {
  return {
    schema: WORKTREE_CLEANUP_PROOF_SCHEMA_ID,
    version: 1,
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    task_id: TASK_ID,
    worktree_path: WORKTREE_PATH,
    ref: LANE_REF,
    branch: LANE_BRANCH,
    expected_head: HEAD_SHA,
    expected_tree: TREE_SHA,
    lock_id: LOCK_ID,
    dispatch_state: 'inactive',
    owned_artifact_paths: [ARTIFACT_PATH, ARTIFACT_PATH_B],
    manifest_digest_hex: MANIFEST_DIGEST_HEX,
    ...overrides,
  };
}

export function validTopology(overrides = {}) {
  return {
    repository_path: REPOSITORY_PATH,
    repository_kind: 'linked_worktree',
    worktree_path: WORKTREE_PATH,
    worktree_realpath: WORKTREE_PATH,
    worktree_present: true,
    git_dir: GIT_DIR,
    head_sha: HEAD_SHA,
    tree_sha: TREE_SHA,
    ref: LANE_REF,
    ref_sha: HEAD_SHA,
    ref_kind: 'local_branch',
    ref_present: true,
    lock_id: LOCK_ID,
    lock_state: 'abandoned',
    lock_task_id: TASK_ID,
    dirty: false,
    shared: false,
    checkout_count: 1,
    symlink: false,
    path_escape: false,
    dispatch_state: 'inactive',
    task_state: 'inactive',
    ...overrides,
  };
}

export function createMemoryCleanupHarness(initialTopology = validTopology()) {
  let topology = { ...initialTopology };
  const calls = {
    observe: 0,
    cleanLock: 0,
    removeWorktree: 0,
    deleteRefCas: 0,
    removeOwnedArtifact: 0,
  };
  const applied = [];
  const failures = {};
  const observeSequence = [];
  const afterSuccess = {};
  let observeFailAt = 0;

  function applyAfter(method) {
    if (afterSuccess[method]) {
      topology = { ...topology, ...afterSuccess[method] };
    }
  }

  function succeed(kind, details) {
    applied.push({ kind, ...details });
    return { applied: true, remaining: false };
  }

  const ops = {
    async observeTopology() {
      calls.observe += 1;
      if (observeFailAt > 0 && calls.observe === observeFailAt) {
        throw new Error('injected observe failure');
      }
      if (observeSequence.length > 0) {
        const next = observeSequence.shift();
        topology = { ...topology, ...next };
      }
      return { ...topology };
    },
    async cleanLock(operation) {
      calls.cleanLock += 1;
      if (failures.cleanLock) {
        if (failures.cleanLock === 'throw') throw new Error('injected lock failure');
        return { applied: false, remaining: true, code: failures.cleanLock };
      }
      topology = { ...topology, lock_state: 'unlocked' };
      applyAfter('cleanLock');
      return succeed('clean_lock', { lock_id: operation.lock_id });
    },
    async removeWorktree(operation) {
      calls.removeWorktree += 1;
      if (failures.removeWorktree) {
        if (failures.removeWorktree === 'throw') throw new Error('injected worktree failure');
        return { applied: false, remaining: true, code: failures.removeWorktree };
      }
      topology = { ...topology, worktree_present: false };
      applyAfter('removeWorktree');
      return succeed('remove_worktree', { worktree_path: operation.worktree_path });
    },
    async deleteRefCas(operation) {
      calls.deleteRefCas += 1;
      if (failures.deleteRefCas) {
        if (failures.deleteRefCas === 'throw') throw new Error('injected ref failure');
        return { applied: false, remaining: true, code: failures.deleteRefCas };
      }
      topology = { ...topology, ref_present: false };
      applyAfter('deleteRefCas');
      return succeed('delete_ref_cas', {
        ref: operation.ref,
        expected_sha: operation.expected_sha,
      });
    },
    async removeOwnedArtifact(operation) {
      calls.removeOwnedArtifact += 1;
      if (failures.removeOwnedArtifact) {
        if (failures.removeOwnedArtifact === 'throw') throw new Error('injected artifact failure');
        return { applied: false, remaining: true, code: failures.removeOwnedArtifact };
      }
      applyAfter('removeOwnedArtifact');
      return succeed('remove_owned_artifact', { relative_path: operation.relative_path });
    },
  };

  return {
    calls,
    applied,
    ops,
    get topology() {
      return topology;
    },
    setTopology(next) {
      topology = { ...topology, ...next };
    },
    failOn(method, code) {
      failures[method] = code;
    },
    failObserveOn(n) {
      observeFailAt = n;
    },
    mutateAfter(method, patch) {
      afterSuccess[method] = patch;
    },
    queueObserves(...snapshots) {
      observeSequence.push(...snapshots);
    },
  };
}
