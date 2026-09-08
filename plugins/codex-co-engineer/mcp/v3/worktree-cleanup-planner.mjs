// WorktreeCleanupPlannerV1 — R1-340 proof-bound worktree cleanup planner
// (ADR 0001 identifiers `manual_proof_bound_cleanup`, `no_automatic_gc`,
// `exact_identities`, `gate_a_safe_per_run_cleanup`,
// `gate_a_no_protected_ref_mutation`).
//
// Additive v3 pure planner. It binds one exact local cleanup target and
// emits a dry-run plan plus progressive machine-readable status. It never
// inspects the filesystem, never spawns Git, never deletes a worktree or
// ref, and never consults a clock. Age is recorded when observed and is
// never authority. There is no dependency graph and no global GC.
//
// Bound identity is the entire ownership surface:
//   repository path + base SHA, task, worktree, branch/ref, expected HEAD
//   and tree, lock identity, active/uncertain dispatch state, and owned
//   artifact paths. Topology is a caller-supplied snapshot. Immediately
//   before any later cleanup, a supported adapter must reread that
//   topology and refuse to execute a stale plan. Before every mutation it
//   must reobserve and CAS-bind the exact task/lock/repository/worktree/
//   ref/head/tree/topology digest. The ownership lock stays held until
//   worktree, ref, and owned-artifact destruction finish; clean_lock is
//   last. Unknown task_state, unknown lock_state, unknown ownership, and
//   bare repositories fail closed and never emit remove_worktree or
//   delete_ref_cas.
//
// Ref deletion is expressed only as expected-SHA compare-and-swap. Active,
// uncertain, unknown, dirty, mismatched, protected, remote, shared,
// unowned, bare, and symlink-escaping targets are refused. Outputs are
// detached, deeply frozen, and content-free on the error path.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { validateArtifactRelativePathV1 } from './artifact-path.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  capturedUtf8ByteLength,
} from './grammar.mjs';
import {
  classifyRefV1,
  expectedLaneRefV1,
  expectedRunBranchNameV1,
} from './git-authority.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  LOCK_ID_MAX_BYTES,
  LOCK_ID_MIN_BYTES,
  LOCK_ID_PATTERN,
} from './protected-identity.mjs';
import {
  RunContractV1Error,
  assertBaseSha,
  assertRepositoryPath,
  assertRunId,
  isAssignmentId,
  isSha40,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';

export const WORKTREE_CLEANUP_PLANNER_SCHEMA_ID =
  'codex-co-engineer.worktree-cleanup-planner.v1';
export const WORKTREE_CLEANUP_PLAN_SCHEMA_ID =
  'codex-co-engineer.worktree-cleanup-plan.v1';
export const WORKTREE_CLEANUP_STATUS_SCHEMA_ID =
  'codex-co-engineer.worktree-cleanup-status.v1';
export const WORKTREE_CLEANUP_PROOF_SCHEMA_ID =
  'codex-co-engineer.worktree-cleanup-proof.v1';
export const WORKTREE_CLEANUP_PLANNER_VERSION = 1;
export const WORKTREE_CLEANUP_HASH_DOMAIN =
  'codex-co-engineer.worktree-cleanup-hash.v1';

export const MAX_CLEANUP_OBJECT_KEYS = 32;
export const MAX_CLEANUP_KEY_BYTES = 128;
export const MAX_OWNED_ARTIFACT_PATHS = 8;
export const MAX_TASK_ID_BYTES = 80;
export const DIGEST_HEX_LENGTH = 64;

export const WORKTREE_CLEANUP_PLANNER_METHODS = capturedFreeze([
  'bindWorktreeCleanupProofV1',
  'planWorktreeCleanupV1',
  'describeWorktreeCleanupPlannerV1',
]);

export const DISPATCH_STATES = capturedFreeze(['inactive', 'active', 'uncertain']);
export const TASK_STATES = capturedFreeze(['inactive', 'active', 'unknown']);
export const LOCK_STATES = capturedFreeze(['unlocked', 'abandoned', 'active', 'unknown']);
export const REPOSITORY_KINDS = capturedFreeze(['local', 'bare', 'linked_worktree']);
export const REF_KINDS = capturedFreeze([
  'local_branch', 'remote', 'symbolic', 'tag', 'candidate',
]);
export const PLANNER_VERDICTS = capturedFreeze(['allow', 'deny']);
export const PLANNER_STATUSES = capturedFreeze(['plan_ready', 'refused']);
export const STATUS_PHASES = capturedFreeze([
  'bound', 'topology_observed', 'plan_ready', 'refused',
]);
export const PLAN_ACTIONS = capturedFreeze([
  'reread_topology',
  'remove_worktree',
  'delete_ref_cas',
  'remove_owned_artifact',
  'clean_lock',
]);
export const CLEANUP_BIND_FIELDS = capturedFreeze([
  'task_id',
  'lock_id',
  'lock_state',
  'lock_task_id',
  'repository_path',
  'repository_kind',
  'worktree_path',
  'worktree_realpath',
  'git_dir',
  'ref',
  'ref_kind',
  'ref_sha',
  'head_sha',
  'tree_sha',
  'task_state',
  'dispatch_state',
]);

export const WORKTREE_CLEANUP_CHECKS = capturedFreeze([
  'request_quarantine',
  'identity_binding',
  'topology_observed',
  'no_path_escape',
  'local_ref',
  'unprotected_ref',
  'owned_target',
  'identity_match',
  'known_task_state',
  'known_lock_state',
  'known_ownership',
  'non_bare_repository',
  'inactive_task',
  'certain_dispatch',
  'clean_worktree',
  'exclusive_worktree',
  'lock_held_until_complete',
  'age_not_authority',
  'ref_cas_only',
  'no_automatic_gc',
  'no_dependency_graph',
]);

export const WORKTREE_CLEANUP_REFUSAL_CODES = capturedFreeze([
  'active_target',
  'uncertain_dispatch',
  'unknown_task',
  'unknown_lock',
  'unknown_ownership',
  'bare_repository',
  'dirty_worktree',
  'identity_mismatch',
  'protected_ref',
  'remote_target',
  'shared_worktree',
  'unowned_target',
  'path_escape',
]);

export const WORKTREE_CLEANUP_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'aliased_reference_denied',
  'exotic_prototype_denied',
  'invalid_format',
  'invalid_type',
  'missing_key',
  'non_enumerable_property_denied',
  'out_of_range',
  'own_undefined_denied',
  'proxy_denied',
  'symbol_key_denied',
  'unknown_key',
  'value_depth_exceeded',
  ...WORKTREE_CLEANUP_REFUSAL_CODES,
]);

export const PROOF_ALLOWED_KEYS = capturedFreeze([
  'assignment_id',
  'base_sha',
  'branch',
  'dispatch_state',
  'expected_head',
  'expected_tree',
  'lock_id',
  'manifest_digest_hex',
  'owned_artifact_paths',
  'ref',
  'repository_path',
  'run_id',
  'schema',
  'task_id',
  'version',
  'worktree_path',
]);
export const PROOF_REQUIRED_KEYS = capturedFreeze([
  'assignment_id',
  'base_sha',
  'dispatch_state',
  'expected_head',
  'expected_tree',
  'lock_id',
  'manifest_digest_hex',
  'owned_artifact_paths',
  'ref',
  'repository_path',
  'run_id',
  'task_id',
  'worktree_path',
]);
export const TOPOLOGY_ALLOWED_KEYS = capturedFreeze([
  'age_ms',
  'checkout_count',
  'dirty',
  'dispatch_state',
  'git_dir',
  'head_sha',
  'lock_id',
  'lock_state',
  'lock_task_id',
  'path_escape',
  'ref',
  'ref_kind',
  'ref_present',
  'ref_sha',
  'repository_kind',
  'repository_path',
  'shared',
  'symlink',
  'task_state',
  'tree_sha',
  'worktree_path',
  'worktree_present',
  'worktree_realpath',
]);
export const TOPOLOGY_REQUIRED_KEYS = capturedFreeze([
  'checkout_count',
  'dirty',
  'dispatch_state',
  'git_dir',
  'head_sha',
  'lock_id',
  'lock_state',
  'lock_task_id',
  'path_escape',
  'ref',
  'ref_kind',
  'ref_present',
  'ref_sha',
  'repository_kind',
  'repository_path',
  'shared',
  'symlink',
  'task_state',
  'tree_sha',
  'worktree_path',
  'worktree_present',
  'worktree_realpath',
]);
export const PLAN_INPUT_ALLOWED_KEYS = capturedFreeze(['proof', 'topology']);
export const PLAN_INPUT_REQUIRED_KEYS = PLAN_INPUT_ALLOWED_KEYS;

export const BOUND_PROOF_KEYS = capturedFreeze([
  'assignment_id',
  'base_sha',
  'branch',
  'dispatch_state',
  'expected_head',
  'expected_tree',
  'lock_id',
  'manifest_digest_hex',
  'owned_artifact_paths',
  'ref',
  'repository_path',
  'run_id',
  'schema',
  'task_id',
  'version',
  'worktree_path',
]);

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_DIR_PATTERN = /^\/[A-Za-z0-9._:-][A-Za-z0-9._:/-]{0,4094}$/u;

const DENIED_PROOF_KEYS = capturedFreeze({
  age: 'invalid_format',
  age_ms: 'invalid_format',
  automatic_gc: 'invalid_format',
  gc: 'invalid_format',
  max_age_ms: 'invalid_format',
  older_than: 'invalid_format',
  stale: 'invalid_format',
  allow_fallback: 'invalid_format',
  create_pr: 'invalid_format',
  merge: 'invalid_format',
  push: 'invalid_format',
  rebase: 'invalid_format',
  remote: 'invalid_format',
});

const MSG = capturedFreeze({
  accessor_property_denied: 'Worktree cleanup denies accessor inputs.',
  aliased_reference_denied: 'Worktree cleanup denies aliased inputs.',
  exotic_prototype_denied: 'Worktree cleanup denies exotic prototypes.',
  invalid_format: 'Worktree cleanup rejected a value that violates a closed grammar.',
  invalid_type: 'Worktree cleanup rejected a non-JSON value.',
  missing_key: 'Worktree cleanup requires every canonical key.',
  non_enumerable_property_denied: 'Worktree cleanup denies non-enumerable properties.',
  out_of_range: 'Worktree cleanup rejected a value outside closed bounds.',
  own_undefined_denied: 'Worktree cleanup denies own undefined values.',
  proxy_denied: 'Worktree cleanup denies Proxy inputs.',
  symbol_key_denied: 'Worktree cleanup denies symbol keys.',
  unknown_key: 'Worktree cleanup rejects keys outside the closed vocabulary.',
  value_depth_exceeded: 'Worktree cleanup rejected nested input that exceeds closed depth.',
  active_target: 'Worktree cleanup refused an active target.',
  uncertain_dispatch: 'Worktree cleanup refused an uncertain dispatch target.',
  unknown_task: 'Worktree cleanup refused an unknown task state.',
  unknown_lock: 'Worktree cleanup refused an unknown lock state.',
  unknown_ownership: 'Worktree cleanup refused unknown ownership topology.',
  bare_repository: 'Worktree cleanup refused a bare repository.',
  dirty_worktree: 'Worktree cleanup refused a dirty worktree.',
  identity_mismatch: 'Worktree cleanup refused a mismatched identity.',
  protected_ref: 'Worktree cleanup refused a protected ref.',
  remote_target: 'Worktree cleanup refused a remote target.',
  shared_worktree: 'Worktree cleanup refused a shared worktree.',
  unowned_target: 'Worktree cleanup refused an unowned target.',
  path_escape: 'Worktree cleanup refused a path-escape target.',
});

const CREATE_HASH = createHash;
const HASH_UPDATE = Object.getPrototypeOf(CREATE_HASH('sha256')).update;
const HASH_DIGEST = Object.getPrototypeOf(CREATE_HASH('sha256')).digest;
const IS_ARRAY = capturedIsArray;
const STRING = String;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const OWN_KEYS = capturedOwnKeys;
const SET_CTOR = Set;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const JSON_PARSE = JSON.parse;

function deny(code, path) {
  fail(code, path, MSG[code] ?? MSG.invalid_format);
}

function publicCode(error) {
  if (error instanceof RunContractV1Error && capturedIncludes(WORKTREE_CLEANUP_ERROR_CODES, error.code)) {
    return error.code;
  }
  return 'invalid_type';
}

function remap(error, path) {
  deny(publicCode(error), path);
}

function assertClosedObject(input, allowed, path) {
  if (input === undefined || input === null) deny('invalid_type', path);
  if (typeof input === 'object' || typeof input === 'function') {
    try { assertNotProxy(input, path); } catch (error) { remap(error, path); }
  }
  if (typeof input !== 'object') deny('invalid_type', path);
  try {
    assertPlainObject(input, 'invalid_type', path, path);
  } catch (error) { remap(error, path); }
  let keys;
  try { keys = OWN_KEYS(input); } catch { deny('invalid_type', path); }
  if (keys.length > MAX_CLEANUP_OBJECT_KEYS) deny('out_of_range', path);
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    if (typeof key !== 'string' || BYTE_LENGTH(key, 'utf8') > MAX_CLEANUP_KEY_BYTES) {
      deny('out_of_range', path);
    }
    if (capturedHasOwn(DENIED_PROOF_KEYS, key) && path === 'proof') {
      deny(DENIED_PROOF_KEYS[key], `${path}.${key}`);
    }
    if (!allowedSet.has(key)) deny('unknown_key', `${path}.${key}`);
  }
  try {
    assertDirectJsonClosure(input, path);
  } catch (error) { remap(error, path); }
  return input;
}

function requireKeys(input, keys, path) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasOwn(input, keys[i])) deny('missing_key', `${path}.${keys[i]}`);
  }
}

function readString(object, key, path) {
  const value = ownDataValue(object, key, path);
  if (typeof value !== 'string') deny('invalid_type', path);
  return value;
}

function readBoolean(object, key, path) {
  const value = ownDataValue(object, key, path);
  if (value !== true && value !== false) deny('invalid_type', path);
  return value;
}

function readInteger(object, key, path, min, max) {
  const value = ownDataValue(object, key, path);
  if (!NUMBER_IS_SAFE_INTEGER(value) || value < min || value > max) deny('out_of_range', path);
  return value;
}

function assertTaskId(value, path) {
  if (typeof value !== 'string' || !capturedTest(TASK_ID_PATTERN, value)) {
    deny('invalid_format', path);
  }
  if (capturedUtf8ByteLength(value) > MAX_TASK_ID_BYTES) deny('out_of_range', path);
}

function assertLockId(value, path) {
  if (typeof value !== 'string' || !capturedTest(LOCK_ID_PATTERN, value)) {
    deny('invalid_format', path);
  }
  const bytes = capturedUtf8ByteLength(value);
  if (bytes < LOCK_ID_MIN_BYTES || bytes > LOCK_ID_MAX_BYTES) deny('out_of_range', path);
}

function assertDigestHex(value, path) {
  if (typeof value !== 'string' || value.length !== DIGEST_HEX_LENGTH
    || !capturedTest(DIGEST_HEX_PATTERN, value)) {
    deny('invalid_format', path);
  }
}

function assertSha(value, path) {
  if (!isSha40(value)) deny('invalid_format', path);
}

function assertClosedChoice(value, allowed, path) {
  if (typeof value !== 'string' || !capturedIncludes(allowed, value)) {
    deny('invalid_format', path);
  }
}

function parseOwnedArtifactPaths(value, path) {
  try { assertNotProxy(value, path); } catch (error) { remap(error, path); }
  if (!IS_ARRAY(value)) deny('invalid_type', path);
  if (value.length > MAX_OWNED_ARTIFACT_PATHS) deny('out_of_range', path);
  const seen = new SET_CTOR();
  const paths = [];
  for (let i = 0; i < value.length; i += 1) {
    const entryPath = `${path}[${i}]`;
    let item;
    try { item = ownDataValue(value, STRING(i), entryPath); } catch (error) { remap(error, path); }
    let validated;
    try {
      validated = validateArtifactRelativePathV1(item, entryPath);
    } catch (error) { remap(error, entryPath); }
    if (seen.has(validated.path)) deny('invalid_format', entryPath);
    seen.add(validated.path);
    paths.push(validated.path);
  }
  return capturedFreeze(paths);
}

function expectedBranch(proof) {
  return expectedRunBranchNameV1({
    assignment_id: proof.assignment_id,
    manifest_digest_hex: proof.manifest_digest_hex,
    run_id: proof.run_id,
  });
}

function expectedRef(proof) {
  return expectedLaneRefV1({
    assignment_id: proof.assignment_id,
    manifest_digest_hex: proof.manifest_digest_hex,
    run_id: proof.run_id,
  });
}

function classifyBoundRef(proof) {
  return classifyRefV1({
    ref: proof.ref,
    identity: {
      repository_path: proof.repository_path,
      base_sha: proof.base_sha,
      run_id: proof.run_id,
      assignment_id: proof.assignment_id,
    },
    manifest_digest_hex: proof.manifest_digest_hex,
    default_branch: 'main',
  });
}

export function bindWorktreeCleanupProofV1(input) {
  const object = assertClosedObject(input, PROOF_ALLOWED_KEYS, 'proof');
  requireKeys(object, PROOF_REQUIRED_KEYS, 'proof');
  if (hasOwn(object, 'schema')) {
    if (readString(object, 'schema', 'proof.schema') !== WORKTREE_CLEANUP_PROOF_SCHEMA_ID) {
      deny('invalid_format', 'proof.schema');
    }
  }
  if (hasOwn(object, 'version')) {
    if (ownDataValue(object, 'version', 'proof.version') !== WORKTREE_CLEANUP_PLANNER_VERSION) {
      deny('invalid_format', 'proof.version');
    }
  }
  const runId = readString(object, 'run_id', 'proof.run_id');
  try { assertRunId(runId, 'proof.run_id'); } catch (error) { remap(error, 'proof.run_id'); }
  const assignmentId = readString(object, 'assignment_id', 'proof.assignment_id');
  if (!isAssignmentId(assignmentId)) deny('invalid_format', 'proof.assignment_id');
  const taskId = readString(object, 'task_id', 'proof.task_id');
  assertTaskId(taskId, 'proof.task_id');
  const repositoryPath = readString(object, 'repository_path', 'proof.repository_path');
  try { assertRepositoryPath(repositoryPath, 'proof.repository_path'); } catch (error) {
    remap(error, 'proof.repository_path');
  }
  const worktreePath = readString(object, 'worktree_path', 'proof.worktree_path');
  try { assertRepositoryPath(worktreePath, 'proof.worktree_path'); } catch (error) {
    remap(error, 'proof.worktree_path');
  }
  if (worktreePath === repositoryPath) deny('invalid_format', 'proof.worktree_path');
  const baseSha = readString(object, 'base_sha', 'proof.base_sha');
  try { assertBaseSha(baseSha, 'proof.base_sha'); } catch (error) { remap(error, 'proof.base_sha'); }
  const expectedHead = readString(object, 'expected_head', 'proof.expected_head');
  assertSha(expectedHead, 'proof.expected_head');
  const expectedTree = readString(object, 'expected_tree', 'proof.expected_tree');
  assertSha(expectedTree, 'proof.expected_tree');
  const lockId = readString(object, 'lock_id', 'proof.lock_id');
  assertLockId(lockId, 'proof.lock_id');
  const dispatchState = readString(object, 'dispatch_state', 'proof.dispatch_state');
  assertClosedChoice(dispatchState, DISPATCH_STATES, 'proof.dispatch_state');
  const manifestDigestHex = readString(object, 'manifest_digest_hex', 'proof.manifest_digest_hex');
  assertDigestHex(manifestDigestHex, 'proof.manifest_digest_hex');
  const refValue = readString(object, 'ref', 'proof.ref');
  const ownedArtifacts = parseOwnedArtifactPaths(
    ownDataValue(object, 'owned_artifact_paths', 'proof.owned_artifact_paths'),
    'proof.owned_artifact_paths',
  );
  const bound = {
    schema: WORKTREE_CLEANUP_PROOF_SCHEMA_ID,
    version: WORKTREE_CLEANUP_PLANNER_VERSION,
    repository_path: repositoryPath,
    base_sha: baseSha,
    run_id: runId,
    assignment_id: assignmentId,
    task_id: taskId,
    worktree_path: worktreePath,
    ref: refValue,
    branch: expectedBranch({
      assignment_id: assignmentId,
      manifest_digest_hex: manifestDigestHex,
      run_id: runId,
    }),
    expected_head: expectedHead,
    expected_tree: expectedTree,
    lock_id: lockId,
    dispatch_state: dispatchState,
    owned_artifact_paths: ownedArtifacts,
    manifest_digest_hex: manifestDigestHex,
  };
  if (hasOwn(object, 'branch')) {
    const branch = readString(object, 'branch', 'proof.branch');
    if (branch !== bound.branch) deny('invalid_format', 'proof.branch');
  }
  return freezeData(JSON_PARSE(canonicalJsonStringify(bound)));
}

function parseTopology(input) {
  const object = assertClosedObject(input, TOPOLOGY_ALLOWED_KEYS, 'topology');
  requireKeys(object, TOPOLOGY_REQUIRED_KEYS, 'topology');
  const repositoryPath = readString(object, 'repository_path', 'topology.repository_path');
  try { assertRepositoryPath(repositoryPath, 'topology.repository_path'); } catch (error) {
    remap(error, 'topology.repository_path');
  }
  const worktreePath = readString(object, 'worktree_path', 'topology.worktree_path');
  try { assertRepositoryPath(worktreePath, 'topology.worktree_path'); } catch (error) {
    remap(error, 'topology.worktree_path');
  }
  const worktreeRealpath = readString(object, 'worktree_realpath', 'topology.worktree_realpath');
  try { assertRepositoryPath(worktreeRealpath, 'topology.worktree_realpath'); } catch (error) {
    remap(error, 'topology.worktree_realpath');
  }
  const gitDir = readString(object, 'git_dir', 'topology.git_dir');
  if (!capturedTest(GIT_DIR_PATTERN, gitDir) || gitDir.includes('..')) {
    deny('invalid_format', 'topology.git_dir');
  }
  const headSha = readString(object, 'head_sha', 'topology.head_sha');
  assertSha(headSha, 'topology.head_sha');
  const treeSha = readString(object, 'tree_sha', 'topology.tree_sha');
  assertSha(treeSha, 'topology.tree_sha');
  const refValue = readString(object, 'ref', 'topology.ref');
  const refSha = readString(object, 'ref_sha', 'topology.ref_sha');
  assertSha(refSha, 'topology.ref_sha');
  const lockId = readString(object, 'lock_id', 'topology.lock_id');
  assertLockId(lockId, 'topology.lock_id');
  const lockTaskId = readString(object, 'lock_task_id', 'topology.lock_task_id');
  assertTaskId(lockTaskId, 'topology.lock_task_id');
  const topology = {
    repository_path: repositoryPath,
    repository_kind: readString(object, 'repository_kind', 'topology.repository_kind'),
    worktree_path: worktreePath,
    worktree_realpath: worktreeRealpath,
    worktree_present: readBoolean(object, 'worktree_present', 'topology.worktree_present'),
    git_dir: gitDir,
    head_sha: headSha,
    tree_sha: treeSha,
    ref: refValue,
    ref_sha: refSha,
    ref_kind: readString(object, 'ref_kind', 'topology.ref_kind'),
    ref_present: readBoolean(object, 'ref_present', 'topology.ref_present'),
    lock_id: lockId,
    lock_state: readString(object, 'lock_state', 'topology.lock_state'),
    lock_task_id: lockTaskId,
    dirty: readBoolean(object, 'dirty', 'topology.dirty'),
    shared: readBoolean(object, 'shared', 'topology.shared'),
    checkout_count: readInteger(object, 'checkout_count', 'topology.checkout_count', 0, 64),
    symlink: readBoolean(object, 'symlink', 'topology.symlink'),
    path_escape: readBoolean(object, 'path_escape', 'topology.path_escape'),
    dispatch_state: readString(object, 'dispatch_state', 'topology.dispatch_state'),
    task_state: readString(object, 'task_state', 'topology.task_state'),
  };
  assertClosedChoice(topology.repository_kind, REPOSITORY_KINDS, 'topology.repository_kind');
  assertClosedChoice(topology.ref_kind, REF_KINDS, 'topology.ref_kind');
  assertClosedChoice(topology.lock_state, LOCK_STATES, 'topology.lock_state');
  assertClosedChoice(topology.dispatch_state, DISPATCH_STATES, 'topology.dispatch_state');
  assertClosedChoice(topology.task_state, TASK_STATES, 'topology.task_state');
  if (hasOwn(object, 'age_ms')) {
    topology.age_ms = readInteger(object, 'age_ms', 'topology.age_ms', 0, 2 ** 53 - 1);
  }
  return topology;
}

export function topologyDigestV1(topology) {
  const snapshot = { ...topology };
  delete snapshot.age_ms;
  const hash = CREATE_HASH('sha256');
  HASH_UPDATE.call(hash, WORKTREE_CLEANUP_HASH_DOMAIN);
  HASH_UPDATE.call(hash, '\u0000');
  HASH_UPDATE.call(hash, canonicalJsonStringify(snapshot));
  return HASH_DIGEST.call(hash, 'hex');
}

export function cleanupBindDigestV1(bound, topology) {
  const snapshot = {
    task_id: bound.task_id,
    lock_id: topology.lock_id,
    lock_state: topology.lock_state,
    lock_task_id: topology.lock_task_id,
    repository_path: topology.repository_path,
    repository_kind: topology.repository_kind,
    worktree_path: topology.worktree_path,
    worktree_realpath: topology.worktree_realpath,
    git_dir: topology.git_dir,
    ref: topology.ref,
    ref_kind: topology.ref_kind,
    ref_sha: topology.ref_sha,
    head_sha: topology.head_sha,
    tree_sha: topology.tree_sha,
    task_state: topology.task_state,
    dispatch_state: topology.dispatch_state,
  };
  return topologyDigestV1(snapshot);
}

function emptyChecks() {
  const checks = {};
  for (let i = 0; i < WORKTREE_CLEANUP_CHECKS.length; i += 1) {
    checks[WORKTREE_CLEANUP_CHECKS[i]] = false;
  }
  return checks;
}

function statusRecord(sequence, phase, verdict, code) {
  return {
    schema: WORKTREE_CLEANUP_STATUS_SCHEMA_ID,
    sequence,
    phase,
    verdict,
    code,
  };
}

function refuse(bound, topology, checks, statuses, code, failedCheck) {
  checks[failedCheck] = false;
  checks.age_not_authority = true;
  checks.ref_cas_only = true;
  checks.no_automatic_gc = true;
  checks.no_dependency_graph = true;
  checks.lock_held_until_complete = true;
  statuses.push(statusRecord(statuses.length + 1, 'refused', 'deny', code));
  return freezeData({
    schema: WORKTREE_CLEANUP_PLANNER_SCHEMA_ID,
    version: WORKTREE_CLEANUP_PLANNER_VERSION,
    status: 'refused',
    verdict: 'deny',
    code,
    checks,
    bound,
    topology_digest: topologyDigestV1(topology),
    bind_digest: cleanupBindDigestV1(bound, topology),
    plan: {
      schema: WORKTREE_CLEANUP_PLAN_SCHEMA_ID,
      dry_run: true,
      age_authority: false,
      automatic_gc: false,
      dependency_graph: false,
      lock_held_until_complete: true,
      operations: [],
    },
    statuses,
  });
}

function evaluateSafety(bound, topology, checks) {
  const ownedRef = expectedRef(bound);
  let classification;
  try {
    classification = classifyBoundRef({ ...bound, ref: topology.ref });
  } catch {
    return { code: 'protected_ref', check: 'unprotected_ref' };
  }
  if (topology.symlink === true || topology.path_escape === true
    || topology.worktree_realpath !== bound.worktree_path
    || topology.worktree_path !== bound.worktree_path) {
    return { code: 'path_escape', check: 'no_path_escape' };
  }
  checks.no_path_escape = true;

  if (topology.repository_kind === 'bare') {
    return { code: 'bare_repository', check: 'non_bare_repository' };
  }
  checks.non_bare_repository = true;

  if (topology.ref_kind === 'remote' || topology.ref.startsWith('refs/remotes/')) {
    return { code: 'remote_target', check: 'local_ref' };
  }
  checks.local_ref = true;

  if (classification.protected === true || classification.ref_class !== 'worker_lane') {
    return { code: 'protected_ref', check: 'unprotected_ref' };
  }
  checks.unprotected_ref = true;

  const ownsWorktree = topology.worktree_path === bound.worktree_path
    && topology.repository_path === bound.repository_path
    && topology.lock_id === bound.lock_id
    && topology.lock_task_id === bound.task_id
    && topology.ref === bound.ref
    && bound.ref === ownedRef;
  if (!ownsWorktree) {
    return { code: 'unowned_target', check: 'owned_target' };
  }
  checks.owned_target = true;

  if (topology.head_sha !== bound.expected_head
    || topology.tree_sha !== bound.expected_tree
    || topology.ref_sha !== bound.expected_head
    || topology.ref !== bound.ref) {
    return { code: 'identity_mismatch', check: 'identity_match' };
  }
  checks.identity_match = true;

  if (topology.task_state === 'unknown') {
    return { code: 'unknown_task', check: 'known_task_state' };
  }
  checks.known_task_state = true;

  if (topology.lock_state === 'unknown') {
    return { code: 'unknown_lock', check: 'known_lock_state' };
  }
  checks.known_lock_state = true;

  if (bound.dispatch_state === 'active' || topology.dispatch_state === 'active'
    || topology.task_state === 'active' || topology.lock_state === 'active') {
    return { code: 'active_target', check: 'inactive_task' };
  }
  checks.inactive_task = true;

  if ((topology.worktree_present === true || topology.ref_present === true)
    && topology.lock_state !== 'abandoned') {
    return { code: 'unknown_ownership', check: 'known_ownership' };
  }
  checks.known_ownership = true;

  if (bound.dispatch_state === 'uncertain' || topology.dispatch_state === 'uncertain') {
    return { code: 'uncertain_dispatch', check: 'certain_dispatch' };
  }
  checks.certain_dispatch = true;

  if (topology.dirty === true) {
    return { code: 'dirty_worktree', check: 'clean_worktree' };
  }
  checks.clean_worktree = true;

  if (topology.shared === true || topology.checkout_count > 1) {
    return { code: 'shared_worktree', check: 'exclusive_worktree' };
  }
  checks.exclusive_worktree = true;

  return null;
}

function mutationBind(bound) {
  return {
    task_id: bound.task_id,
    lock_id: bound.lock_id,
    repository_path: bound.repository_path,
    worktree_path: bound.worktree_path,
    ref: bound.ref,
    expected_head: bound.expected_head,
    expected_tree: bound.expected_tree,
  };
}

function planOperations(bound, topology) {
  const operations = [{
    action: 'reread_topology',
    bind: [...CLEANUP_BIND_FIELDS],
  }];
  if (topology.worktree_present === true) {
    operations.push({
      action: 'remove_worktree',
      ...mutationBind(bound),
    });
  }
  if (topology.ref_present === true) {
    operations.push({
      action: 'delete_ref_cas',
      ...mutationBind(bound),
      expected_sha: bound.expected_head,
    });
  }
  for (let i = 0; i < bound.owned_artifact_paths.length; i += 1) {
    operations.push({
      action: 'remove_owned_artifact',
      ...mutationBind(bound),
      relative_path: bound.owned_artifact_paths[i],
    });
  }
  if (topology.lock_state === 'abandoned') {
    operations.push({
      action: 'clean_lock',
      ...mutationBind(bound),
      expected_state: 'abandoned',
    });
  }
  return operations;
}

export function planWorktreeCleanupV1(input) {
  const object = assertClosedObject(input, PLAN_INPUT_ALLOWED_KEYS, 'request');
  requireKeys(object, PLAN_INPUT_REQUIRED_KEYS, 'request');
  const bound = bindWorktreeCleanupProofV1(ownDataValue(object, 'proof', 'request.proof'));
  const topology = parseTopology(ownDataValue(object, 'topology', 'request.topology'));
  const checks = emptyChecks();
  checks.request_quarantine = true;
  checks.identity_binding = true;
  checks.topology_observed = true;
  const statuses = [
    statusRecord(1, 'bound', 'pending', null),
    statusRecord(2, 'topology_observed', 'pending', null),
  ];
  const failure = evaluateSafety(bound, topology, checks);
  checks.age_not_authority = true;
  checks.ref_cas_only = true;
  checks.no_automatic_gc = true;
  checks.no_dependency_graph = true;
  checks.lock_held_until_complete = true;
  if (failure) {
    return refuse(bound, topology, checks, statuses, failure.code, failure.check);
  }
  statuses.push(statusRecord(3, 'plan_ready', 'allow', null));
  return freezeData({
    schema: WORKTREE_CLEANUP_PLANNER_SCHEMA_ID,
    version: WORKTREE_CLEANUP_PLANNER_VERSION,
    status: 'plan_ready',
    verdict: 'allow',
    code: null,
    checks,
    bound,
    topology_digest: topologyDigestV1(topology),
    bind_digest: cleanupBindDigestV1(bound, topology),
    plan: {
      schema: WORKTREE_CLEANUP_PLAN_SCHEMA_ID,
      dry_run: true,
      age_authority: false,
      automatic_gc: false,
      dependency_graph: false,
      lock_held_until_complete: true,
      operations: planOperations(bound, topology),
    },
    statuses,
  });
}

export function describeWorktreeCleanupPlannerV1() {
  return freezeData({
    schema: WORKTREE_CLEANUP_PLANNER_SCHEMA_ID,
    version: WORKTREE_CLEANUP_PLANNER_VERSION,
    rule: 'proof_bound_dry_run_plan_without_age_gc',
    methods: [...WORKTREE_CLEANUP_PLANNER_METHODS],
    checks: [...WORKTREE_CLEANUP_CHECKS],
    refusal_codes: [...WORKTREE_CLEANUP_REFUSAL_CODES],
    plan_actions: [...PLAN_ACTIONS],
    bind_fields: [...CLEANUP_BIND_FIELDS],
    dispatch_states: [...DISPATCH_STATES],
    side_effects: capturedFreeze({
      filesystem_invoked: false,
      git_invoked: false,
      worktree_removed: false,
      ref_deleted: false,
      lock_cleaned: false,
      remote_mutated: false,
      automatic_gc: false,
      dependency_graph: false,
      age_authority: false,
    }),
    composed_surfaces: capturedFreeze({
      git_authority: 'P28 classifyRefV1 / expectedLaneRefV1; delete is CAS-only',
      artifact_paths: 'P07 relative owned artifact paths',
      filesystem: 'not invoked; topology is a caller snapshot',
      git: 'not invoked',
      adapter: 'later reread/execute with injected operations',
      automatic_gc: 'forbidden',
      gate_a: 'not claimed',
    }),
  });
}

capturedFreeze(bindWorktreeCleanupProofV1);
capturedFreeze(planWorktreeCleanupV1);
capturedFreeze(topologyDigestV1);
capturedFreeze(cleanupBindDigestV1);
capturedFreeze(describeWorktreeCleanupPlannerV1);
