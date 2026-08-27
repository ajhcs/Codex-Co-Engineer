// RunCandidateComposerV1 — deterministic run-owned candidate composition (P35;
// ADR 0001 `run_owned_candidate_composition`, `candidate_binary_safe_manifest_order`,
// `candidate_git_policy_revalidation`, `run_owned_candidate_ref_namespace`,
// `diagnostic_partial_candidate_never_ready`, `codex_only_final_acceptance`).
//
// Additive v3 module. It composes frozen, already-verified writer deltas in
// binary-safe manifest order onto the immutable run base, revalidates path
// ownership plus P28/P30 Git policy, and creates only the one-parent
// non-authoritative ref refs/codex-co-engineer/runs/<run-id>/candidate.
// Conflicts are never repaired. Required missing, rejected, or unresolved
// writer lanes block ready. Any diagnostic partial output is
// incomplete_candidate and can never receive ready_for_codex_review.
// Codex retains sole final acceptance/integration authority.
//
// This module does not import or own the server, supervisor, worker,
// provider, registry, runtime, scheduler, artifact-bridge, or release
// surfaces. Mutation is argv-only local Git plumbing under a disposable
// index. Remote, protected, default, tag, and merge refs are never written.

import { Buffer as NodeBuffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import { denyWorkerRemoteMutation } from './credential-boundary.mjs';
import {
  MAX_DURATION_MS,
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
} from './evidence-bundle.mjs';
import {
  ACTOR_VALUES,
  CANDIDATE_REF_LEAF,
  CANDIDATE_REF_NAMESPACE,
  DENIED_OPERATIONS,
  GIT_AUTHORITY_POLICY_V1,
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  bindAuthorityIdentityV1,
  classifyGitOperationV1,
  expectedCandidateRefV1,
  isRunOwnedCandidateRefV1,
  parseGitAuthorityPolicyV1,
} from './git-authority.mjs';
import {
  GIT_CLOSED_ENV,
  GIT_EXECUTABLE,
  MAX_GIT_ARG_BYTES,
  MAX_GIT_ARGS,
  MAX_GIT_TIME_MS,
} from './git-identity.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  capturedUtf8ByteLength,
  requiredAccessForRole,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import { auditProtectedRefsV1 } from './protected-ref-audit.mjs';
import {
  compiledRepoGlobMatchesPath,
  compileRepoGlob,
} from './repo-path-matcher.mjs';
import {
  RunContractV1Error,
  SCOPE_MAX_PATTERNS,
  assertBaseSha,
  assertRepositoryPath,
  assertRunId,
  assertWriteScopePatterns,
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

export const RUN_CANDIDATE_COMPOSER_SCHEMA_ID = 'codex-co-engineer.run-candidate-composer.v1';
export const RUN_CANDIDATE_COMPOSER_VERSION = 1;
export const RUN_CANDIDATE_COMPOSER_RECEIPT_SCHEMA_ID =
  'codex-co-engineer.run-candidate-composer-receipt.v1';

export const MAX_COMPOSER_OBJECT_KEYS = 32;
export const MAX_COMPOSER_KEY_BYTES = 128;
export const MAX_COMPOSER_LANES = 8;
export const MAX_COMPOSER_GIT_COMMANDS = 48;
export const MAX_COMPOSER_OUTPUT_BYTES = 262_144;
export const MAX_COMPOSER_TOTAL_TIME_MS = 30_000;
export const MODE_FILE = '100644';
export const MODE_EXEC = '100755';
export const MODE_SYMLINK = '120000';
export const MODE_GITLINK = '160000';
export const MODE_MISSING = '000000';
export const ZERO_SHA = '0'.repeat(40);
export const CANDIDATE_COMMIT_MESSAGE = 'codex-co-engineer run-owned candidate';
export const CANDIDATE_AUTHOR_NAME = 'codex-co-engineer';
export const CANDIDATE_AUTHOR_EMAIL = 'codex-co-engineer@local';
export const CANDIDATE_AUTHOR_DATE = '1970-01-01T00:00:00Z';

export const COMPOSER_STATUSES = capturedFreeze([
  'blocked', 'composed', 'incomplete_candidate',
]);
export const LANE_STATES = capturedFreeze([
  'missing', 'rejected', 'unresolved', 'verified',
]);
export const LANE_KINDS = capturedFreeze(['optional_advisory', 'required_writer']);
export const BLOCKING_LANE_STATES = capturedFreeze(['missing', 'rejected', 'unresolved']);
export const COMPOSER_CHECKS = capturedFreeze([
  'request_quarantine',
  'p28_authority_policy',
  'candidate_ref_namespace',
  'one_parent_base',
  'binary_safe_manifest_order',
  'path_ownership_revalidation',
  'delta_git_policy',
  'no_conflict_repair',
  'p30_protected_ref_audit',
  'remote_mutation_denied',
  'diagnostic_partial_never_ready',
  'codex_only_final_acceptance',
]);
export const COMPOSER_SIDE_EFFECT_NONCLAIMS = capturedFreeze([
  'config_mutated',
  'credentials_accessed',
  'default_branch_mutated',
  'head_mutated',
  'index_mutated',
  'integrated',
  'merge_performed',
  'pr_created',
  'protected_ref_mutated',
  'push_performed',
  'rebase_performed',
  'release_created',
  'remote_mutated',
  'tag_created',
  'worktree_mutated',
]);
export const GIT_MUTATION_COMMANDS = capturedFreeze([
  'commit-tree', 'read-tree', 'update-index', 'update-ref', 'write-tree',
]);
export const GIT_INSPECT_COMMANDS = capturedFreeze([
  'cat-file', 'diff-tree', 'merge-base', 'rev-list', 'rev-parse',
  'show-ref', 'symbolic-ref',
]);
export const GIT_ALLOWED_COMMANDS = capturedFreeze([
  ...GIT_INSPECT_COMMANDS, ...GIT_MUTATION_COMMANDS,
]);

export const REQUEST_ALLOWED_KEYS = capturedFreeze([
  'allow_diagnostic_partial_candidate', 'expected_base_ref',
  'expected_protected_refs', 'identity', 'lanes', 'schema', 'version',
]);
export const REQUEST_REQUIRED_KEYS = capturedFreeze([
  'expected_base_ref', 'expected_protected_refs', 'identity', 'lanes',
  'schema', 'version',
]);
export const IDENTITY_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'repository_path', 'run_id',
]);
export const IDENTITY_REQUIRED_KEYS = IDENTITY_ALLOWED_KEYS;
export const LANE_ALLOWED_KEYS = capturedFreeze([
  'access', 'assignment_id', 'head_sha', 'role', 'state', 'write_scope',
]);
export const LANE_REQUIRED_KEYS = capturedFreeze([
  'access', 'assignment_id', 'role', 'state', 'write_scope',
]);
export const EXPECTED_REF_ALLOWED_KEYS = capturedFreeze(['ref', 'sha']);
export const OPTIONS_ALLOWED_KEYS = capturedFreeze(['auditProtectedRefs', 'spawn']);
export const LANE_RESULT_KEYS = capturedFreeze([
  'applied', 'assignment_id', 'head_sha', 'kind', 'path_count', 'state', 'write_scope',
]);
export const RECEIPT_KEYS = capturedFreeze([
  'allow_diagnostic_partial_candidate', 'applied_assignment_ids',
  'assignment_id', 'base_sha', 'blocked_assignment_ids', 'candidate_ref',
  'candidate_sha', 'checks', 'discrepancies', 'facts', 'idempotent',
  'incomplete', 'lanes', 'parent_count', 'parent_sha',
  'ready_for_codex_review', 'run_id', 'schema', 'side_effects', 'status',
  'version',
]);

export const RUN_CANDIDATE_COMPOSER_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'bounds_exceeded',
  'conflict_unresolved', 'delta_policy_denied', 'exotic_prototype_denied',
  'git_execution_failed', 'invalid_format', 'invalid_type', 'missing_key',
  'non_enumerable_property_denied', 'out_of_range', 'own_undefined_denied',
  'path_ownership_denied', 'protected_ref_write_denied', 'proxy_denied',
  'remote_mutation_denied', 'symbol_key_denied', 'unknown_key',
  'unverified_delta_denied', 'value_depth_exceeded',
]);

const DEFINE = Object.defineProperty;
const IS_INT = Number.isSafeInteger;
const STRING = String;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const BUFFER_IS_BUFFER = NodeBuffer.isBuffer.bind(NodeBuffer);
const IS_ARRAY = capturedIsArray;
const OWN_KEYS = capturedOwnKeys;
const SET_CTOR = Set;
const HASH = createHash;
const HASH_DIGEST = Object.getPrototypeOf(HASH('sha256')).digest;
const HASH_UPDATE = Object.getPrototypeOf(HASH('sha256')).update;
const IS_PROXY = utilTypes.isProxy;
const PATH_JOIN = path.join;
const SPAWN = nodeSpawn;
const MATH_MIN = Math.min;
const MATH_MAX = Math.max;
const MATH_FLOOR = Math.floor;
const BASE_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MODE_PATTERN = /^(?:000000|100644|100755|120000|160000)$/u;
const STATUS_PATTERN = /^[A-Z][0-9]{0,3}$/u;

const GIT_ISOLATION_FLAGS = capturedFreeze([
  '--no-replace-objects',
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c', 'core.useReplaceRefs=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'gc.auto=0',
  '-c', 'advice.detachedHead=false',
  '-c', 'log.showSignature=false',
  '-c', 'core.fsmonitor=',
  '-c', 'core.useBuiltinFSMonitor=false',
  '-c', 'core.untrackedCache=false',
]);

const COMMIT_ENV = capturedFreeze({
  GIT_AUTHOR_NAME: CANDIDATE_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: CANDIDATE_AUTHOR_EMAIL,
  GIT_AUTHOR_DATE: CANDIDATE_AUTHOR_DATE,
  GIT_COMMITTER_NAME: CANDIDATE_AUTHOR_NAME,
  GIT_COMMITTER_EMAIL: CANDIDATE_AUTHOR_EMAIL,
  GIT_COMMITTER_DATE: CANDIDATE_AUTHOR_DATE,
});

const MSG = capturedFreeze({
  accessor_property_denied: 'RunCandidateComposerV1 denies accessor inputs.',
  aliased_reference_denied: 'RunCandidateComposerV1 denies aliased inputs.',
  bounds_exceeded: 'RunCandidateComposerV1 exceeded a closed composition bound.',
  conflict_unresolved: 'RunCandidateComposerV1 never repairs overlapping or conflicting deltas.',
  delta_policy_denied: 'RunCandidateComposerV1 rejects symlink, submodule, rename, copy, or mode-change deltas.',
  exotic_prototype_denied: 'RunCandidateComposerV1 denies exotic prototypes.',
  git_execution_failed: 'RunCandidateComposerV1 could not complete a git composition step.',
  invalid_format: 'RunCandidateComposerV1 rejected a value that violates a closed grammar.',
  invalid_type: 'RunCandidateComposerV1 rejected a non-JSON composition value.',
  missing_key: 'RunCandidateComposerV1 requires every canonical composition key.',
  non_enumerable_property_denied: 'RunCandidateComposerV1 denies non-enumerable properties.',
  out_of_range: 'RunCandidateComposerV1 rejected a value outside closed bounds.',
  own_undefined_denied: 'RunCandidateComposerV1 denies own undefined values.',
  path_ownership_denied: 'RunCandidateComposerV1 rejected a delta path outside the lane write scope.',
  protected_ref_write_denied: 'RunCandidateComposerV1 denies writes to protected or default refs.',
  proxy_denied: 'RunCandidateComposerV1 denies Proxy inputs.',
  remote_mutation_denied: 'RunCandidateComposerV1 denies push, fetch, and remote mutation.',
  symbol_key_denied: 'RunCandidateComposerV1 denies symbol keys.',
  unknown_key: 'RunCandidateComposerV1 rejects keys outside the closed vocabulary.',
  unverified_delta_denied: 'RunCandidateComposerV1 composes only frozen verified writer deltas.',
  value_depth_exceeded: 'RunCandidateComposerV1 rejected nested input that exceeds closed depth.',
});

function deny(code, pathLabel) {
  fail(code, pathLabel, MSG[code] ?? MSG.invalid_format);
}

function publicCode(error) {
  if (error instanceof RunContractV1Error
    && capturedIncludes(RUN_CANDIDATE_COMPOSER_ERROR_CODES, error.code)) {
    return error.code;
  }
  return 'invalid_type';
}

function remap(error, pathLabel) {
  deny(publicCode(error), pathLabel);
}

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!Object.hasOwn(values, key)) continue;
    DEFINE(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function assertClosedObject(input, allowed, pathLabel) {
  if (input === undefined || input === null) deny('invalid_type', pathLabel);
  if (typeof input === 'object' || typeof input === 'function') {
    try { assertNotProxy(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  }
  if (typeof input !== 'object') deny('invalid_type', pathLabel);
  try {
    assertPlainObject(input, 'invalid_type', pathLabel, pathLabel);
  } catch (error) { remap(error, pathLabel); }
  let keys;
  try { keys = OWN_KEYS(input); } catch { deny('invalid_type', pathLabel); }
  if (keys.length > MAX_COMPOSER_OBJECT_KEYS) deny('out_of_range', pathLabel);
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (typeof key !== 'string' || BYTE_LENGTH(key, 'utf8') > MAX_COMPOSER_KEY_BYTES) {
      deny('out_of_range', pathLabel);
    }
    if (!allowedSet.has(key)) deny('unknown_key', pathLabel);
  }
  try { assertDirectJsonClosure(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  return input;
}

function requireKeys(input, keys, pathLabel) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasOwn(input, keys[i])) deny('missing_key', pathLabel);
  }
}

function ownString(input, key, pathLabel) {
  const value = ownDataValue(input, key, pathLabel);
  if (typeof value !== 'string') deny('invalid_type', pathLabel);
  return value;
}

function digestOf(value) {
  const hash = HASH('sha256');
  HASH_UPDATE.call(hash, canonicalJsonStringify(value));
  return HASH_DIGEST.call(hash, 'hex');
}

function gitCommandOf(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-C' || arg === '--git-dir' || arg === '-c' || arg === '--namespace') {
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && !arg.startsWith('-')) return arg;
  }
  return undefined;
}

function assertGitArgv(args, pathLabel) {
  if (!IS_ARRAY(args) || args.length === 0 || args.length > MAX_GIT_ARGS + GIT_ISOLATION_FLAGS.length + 4) {
    deny('bounds_exceeded', pathLabel);
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string' || BYTE_LENGTH(arg, 'utf8') > MAX_GIT_ARG_BYTES) {
      deny('bounds_exceeded', pathLabel);
    }
    if (arg.includes('\0')) deny('invalid_format', pathLabel);
  }
  const command = gitCommandOf(args);
  if (!capturedIncludes(GIT_ALLOWED_COMMANDS, command)) deny('remote_mutation_denied', pathLabel);
  if (capturedIncludes(DENIED_OPERATIONS, command) || command === 'push' || command === 'fetch') {
    deny('remote_mutation_denied', pathLabel);
  }
}

function assertClosedEnv(env, pathLabel) {
  try { assertNotProxy(env, pathLabel); } catch (error) { remap(error, pathLabel); }
  const keys = OWN_KEYS(env);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key !== 'string') deny('symbol_key_denied', pathLabel);
    const value = env[key];
    if (typeof value !== 'string') deny('invalid_type', pathLabel);
  }
}

function createSession(spawnFn) {
  const startedAt = Date.now();
  return {
    spawn: spawnFn,
    commands: 0,
    startedAt,
    deadlineAt: startedAt + MAX_COMPOSER_TOTAL_TIME_MS,
  };
}

function remainingMs(session) {
  return MATH_MAX(0, session.deadlineAt - Date.now());
}

function ownedChunk(chunk, pathLabel) {
  try {
    if (typeof chunk === 'string') return BUFFER_FROM(chunk, 'utf8');
    if (BUFFER_IS_BUFFER(chunk)) return BUFFER_FROM(chunk);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
  }
  deny('git_execution_failed', pathLabel);
}

function runGit(session, args, pathLabel, extra = {}) {
  assertGitArgv(args, pathLabel);
  if (session.commands >= MAX_COMPOSER_GIT_COMMANDS) deny('bounds_exceeded', pathLabel);
  const budget = remainingMs(session);
  if (budget <= 0) deny('bounds_exceeded', pathLabel);
  session.commands += 1;
  const env = extra.env === undefined ? GIT_CLOSED_ENV : extra.env;
  assertClosedEnv(env, pathLabel);
  const stdinBytes = extra.stdin;
  if (stdinBytes !== undefined && !BUFFER_IS_BUFFER(stdinBytes)) deny('invalid_type', pathLabel);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = session.spawn(GIT_EXECUTABLE, [...GIT_ISOLATION_FLAGS, ...args], {
        cwd: '/',
        env,
        stdio: [stdinBytes === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
      return;
    }
    if (child === null || (typeof child !== 'object' && typeof child !== 'function') || IS_PROXY(child)) {
      reject(new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let settled = false;
    let exceeded = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const exceed = () => {
      if (exceeded) return;
      exceeded = true;
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish(new RunContractV1Error('bounds_exceeded', pathLabel, MSG.bounds_exceeded));
    };
    const timer = setTimeout(exceed, MATH_MIN(MAX_GIT_TIME_MS, budget));
    const onOut = (chunk) => {
      try {
        const owned = ownedChunk(chunk, pathLabel);
        stdoutBytes += owned.length;
        if (stdoutBytes > MAX_COMPOSER_OUTPUT_BYTES) {
          exceed();
          return;
        }
        stdoutChunks.push(owned);
      } catch (error) {
        finish(error instanceof RunContractV1Error
          ? error
          : new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
      }
    };
    const onErr = (chunk) => {
      try {
        const owned = ownedChunk(chunk, pathLabel);
        if (owned.length > MAX_COMPOSER_OUTPUT_BYTES) exceed();
        else stderrChunks.push(owned);
      } catch {
        exceed();
      }
    };
    try {
      if (child.stdout) child.stdout.on('data', onOut);
      if (child.stderr) child.stderr.on('data', onErr);
      child.once('error', () => {
        finish(new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
      });
      child.once('close', (code, signal) => {
        if (exceeded) return;
        if (signal !== null && signal !== undefined) {
          finish(new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
          return;
        }
        finish(null, {
          exit_code: typeof code === 'number' ? code : 1,
          stdout: BUFFER_CONCAT(stdoutChunks),
          stderr: BUFFER_CONCAT(stderrChunks),
        });
      });
      if (stdinBytes !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(stdinBytes);
      }
    } catch {
      finish(new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
    }
  });
}

function repoArgs(repositoryPath, args) {
  return ['-C', repositoryPath, ...args];
}

function indexEnv(indexPath) {
  return capturedFreeze({
    ...GIT_CLOSED_ENV,
    GIT_INDEX_FILE: indexPath,
    ...COMMIT_ENV,
  });
}

function commitEnv() {
  return capturedFreeze({ ...GIT_CLOSED_ENV, ...COMMIT_ENV });
}

function oneLine(buffer, pathLabel, pattern) {
  const text = buffer.toString('utf8');
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (line.includes('\n') || (pattern !== undefined && !capturedTest(pattern, line))) {
    deny('git_execution_failed', pathLabel);
  }
  return line;
}

function parseUtf8Path(bytes, pathLabel) {
  const text = bytes.toString('utf8');
  if (BUFFER_FROM(text, 'utf8').length !== bytes.length) deny('delta_policy_denied', pathLabel);
  if (text.length === 0 || text.startsWith('/') || text.includes('\0') || text.includes('\\')) {
    deny('delta_policy_denied', pathLabel);
  }
  const segments = text.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.length === 0 || segment === '.' || segment === '..') deny('delta_policy_denied', pathLabel);
  }
  if (text.normalize('NFC') !== text) deny('delta_policy_denied', pathLabel);
  return text;
}

function splitNul(buffer) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      parts.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function parseDiffTree(buffer, pathLabel) {
  if (buffer.length === 0) {
    return { records: [], paths: [], rename: false, copy: false };
  }
  const parts = splitNul(buffer);
  const records = [];
  const paths = [];
  const seen = new SET_CTOR();
  let rename = false;
  let copy = false;
  let index = 0;
  while (index < parts.length) {
    const headerBytes = parts[index];
    index += 1;
    if (headerBytes.length === 0) continue;
    const header = headerBytes.toString('utf8');
    if (!header.startsWith(':')) deny('git_execution_failed', pathLabel);
    const fields = header.slice(1).split(' ');
    if (fields.length !== 5) deny('git_execution_failed', pathLabel);
    const [oldMode, newMode, oldSha, newSha, status] = fields;
    if (!capturedTest(MODE_PATTERN, oldMode) || !capturedTest(MODE_PATTERN, newMode)) {
      deny('delta_policy_denied', pathLabel);
    }
    if ((oldSha !== ZERO_SHA && !isSha40(oldSha)) || (newSha !== ZERO_SHA && !isSha40(newSha))) {
      deny('git_execution_failed', pathLabel);
    }
    if (!capturedTest(STATUS_PATTERN, status)) deny('delta_policy_denied', pathLabel);
    const status0 = status.charAt(0);
    if (status0 === 'R') rename = true;
    if (status0 === 'C') copy = true;
    if (index >= parts.length) deny('git_execution_failed', pathLabel);
    const firstPath = parseUtf8Path(parts[index], pathLabel);
    index += 1;
    let secondPath;
    if (status0 === 'R' || status0 === 'C') {
      if (index >= parts.length) deny('git_execution_failed', pathLabel);
      secondPath = parseUtf8Path(parts[index], pathLabel);
      index += 1;
    }
    const changedPath = secondPath === undefined ? firstPath : secondPath;
    if (seen.has(changedPath)) deny('conflict_unresolved', pathLabel);
    seen.add(changedPath);
    paths.push(changedPath);
    records.push({
      old_mode: oldMode,
      new_mode: newMode,
      old_sha: oldSha,
      new_sha: newSha,
      status: status0,
      path: changedPath,
    });
  }
  paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { records, paths, rename, copy };
}

function denyDeltaPolicy(record, pathLabel) {
  if (record.status === 'R' || record.status === 'C' || record.status === 'T'
    || record.status === 'U' || record.status === 'X' || record.status === 'B') {
    deny('delta_policy_denied', pathLabel);
  }
  if (record.old_mode === MODE_SYMLINK || record.new_mode === MODE_SYMLINK) {
    deny('delta_policy_denied', pathLabel);
  }
  if (record.old_mode === MODE_GITLINK || record.new_mode === MODE_GITLINK) {
    deny('delta_policy_denied', pathLabel);
  }
  if (record.old_mode !== MODE_MISSING && record.new_mode !== MODE_MISSING
    && record.old_mode !== record.new_mode) {
    deny('delta_policy_denied', pathLabel);
  }
  if (record.new_mode !== MODE_MISSING && record.new_mode !== MODE_FILE) {
    deny('delta_policy_denied', pathLabel);
  }
}

function pathOwned(pathValue, compiledScopes) {
  for (let i = 0; i < compiledScopes.length; i += 1) {
    if (compiledRepoGlobMatchesPath(compiledScopes[i], pathValue, 'path') === true) return true;
  }
  return false;
}

function parseExpectedRefs(input, pathLabel) {
  try { assertNotProxy(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  if (!IS_ARRAY(input) || input.length < 1 || input.length > 16) deny('out_of_range', pathLabel);
  const refs = [];
  for (let i = 0; i < input.length; i += 1) {
    const entryPath = `${pathLabel}[${i}]`;
    const object = assertClosedObject(ownDataValue(input, STRING(i), entryPath),
      EXPECTED_REF_ALLOWED_KEYS, entryPath);
    requireKeys(object, EXPECTED_REF_ALLOWED_KEYS, entryPath);
    const ref = ownString(object, 'ref', entryPath);
    const sha = ownString(object, 'sha', entryPath);
    if (!isSha40(sha)) deny('invalid_format', entryPath);
    refs.push(freezeRecord(EXPECTED_REF_ALLOWED_KEYS, { ref, sha }));
  }
  return capturedFreeze(refs);
}

function parseLane(input, pathLabel, seen) {
  const object = assertClosedObject(input, LANE_ALLOWED_KEYS, pathLabel);
  requireKeys(object, LANE_REQUIRED_KEYS, pathLabel);
  const assignmentId = ownString(object, 'assignment_id', pathLabel);
  if (!isAssignmentId(assignmentId)) deny('invalid_format', pathLabel);
  if (seen.has(assignmentId)) deny('invalid_format', pathLabel);
  seen.add(assignmentId);
  const role = ownString(object, 'role', pathLabel);
  const access = ownString(object, 'access', pathLabel);
  let expectedAccess;
  try { expectedAccess = requiredAccessForRole(role); } catch { deny('invalid_format', pathLabel); }
  if (access !== expectedAccess) deny('invalid_format', pathLabel);
  const state = ownString(object, 'state', pathLabel);
  if (!capturedIncludes(LANE_STATES, state)) deny('invalid_format', pathLabel);
  const kind = access === 'writer' ? 'required_writer' : 'optional_advisory';
  const minPatterns = access === 'writer' ? 1 : 0;
  const maxPatterns = access === 'writer' ? SCOPE_MAX_PATTERNS : 0;
  const writeScopeValue = ownDataValue(object, 'write_scope', pathLabel);
  try {
    assertWriteScopePatterns(writeScopeValue, `${pathLabel}.write_scope`, { minPatterns, maxPatterns });
  } catch (error) { remap(error, pathLabel); }
  const writeScope = [];
  for (let i = 0; i < writeScopeValue.length; i += 1) writeScope.push(writeScopeValue[i]);
  const compiled = [];
  for (let i = 0; i < writeScope.length; i += 1) {
    compiled.push(compileRepoGlob(writeScope[i], `${pathLabel}.write_scope`));
  }
  let headSha = null;
  if (hasOwn(object, 'head_sha')) {
    headSha = ownString(object, 'head_sha', pathLabel);
    if (!isSha40(headSha)) deny('invalid_format', pathLabel);
  }
  if (kind === 'required_writer' && state === 'verified' && headSha === null) {
    deny('missing_key', pathLabel);
  }
  if (state !== 'verified' && headSha !== null) deny('unverified_delta_denied', pathLabel);
  return freezeRecord(capturedFreeze([
    ...LANE_ALLOWED_KEYS, 'compiled_write_scope', 'kind',
  ]), {
    assignment_id: assignmentId,
    role,
    access,
    state,
    write_scope: capturedFreeze([...writeScope]),
    compiled_write_scope: capturedFreeze(compiled),
    head_sha: headSha,
    kind,
  });
}

function parseLanes(input, pathLabel) {
  try { assertNotProxy(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  if (!IS_ARRAY(input) || input.length < 1 || input.length > MAX_COMPOSER_LANES) {
    deny('out_of_range', pathLabel);
  }
  const seen = new SET_CTOR();
  const lanes = [];
  for (let i = 0; i < input.length; i += 1) {
    lanes.push(parseLane(ownDataValue(input, STRING(i), `${pathLabel}[${i}]`), `${pathLabel}[${i}]`, seen));
  }
  return capturedFreeze(lanes);
}

function parseIdentity(input, pathLabel) {
  const object = assertClosedObject(input, IDENTITY_ALLOWED_KEYS, pathLabel);
  requireKeys(object, IDENTITY_REQUIRED_KEYS, pathLabel);
  const repositoryPath = ownString(object, 'repository_path', pathLabel);
  try { assertRepositoryPath(repositoryPath, pathLabel); } catch (error) { remap(error, pathLabel); }
  const baseSha = ownString(object, 'base_sha', pathLabel);
  try { assertBaseSha(baseSha, pathLabel); } catch (error) { remap(error, pathLabel); }
  const runId = ownString(object, 'run_id', pathLabel);
  try { assertRunId(runId, pathLabel); } catch (error) { remap(error, pathLabel); }
  const assignmentId = ownString(object, 'assignment_id', pathLabel);
  if (!isAssignmentId(assignmentId)) deny('invalid_format', pathLabel);
  return freezeRecord(IDENTITY_ALLOWED_KEYS, {
    repository_path: repositoryPath,
    base_sha: baseSha,
    run_id: runId,
    assignment_id: assignmentId,
  });
}

export function parseRunCandidateComposeRequestV1(input) {
  const pathLabel = 'compose';
  const object = assertClosedObject(input, REQUEST_ALLOWED_KEYS, pathLabel);
  requireKeys(object, REQUEST_REQUIRED_KEYS, pathLabel);
  if (ownString(object, 'schema', pathLabel) !== RUN_CANDIDATE_COMPOSER_SCHEMA_ID) {
    deny('invalid_format', pathLabel);
  }
  if (ownDataValue(object, 'version', pathLabel) !== RUN_CANDIDATE_COMPOSER_VERSION) {
    deny('invalid_format', pathLabel);
  }
  const identity = parseIdentity(ownDataValue(object, 'identity', pathLabel), `${pathLabel}.identity`);
  const expectedBaseRef = ownString(object, 'expected_base_ref', pathLabel);
  if (!capturedTest(BASE_REF_PATTERN, expectedBaseRef)) deny('invalid_format', pathLabel);
  const expectedProtectedRefs = parseExpectedRefs(
    ownDataValue(object, 'expected_protected_refs', pathLabel), `${pathLabel}.expected_protected_refs`,
  );
  const lanes = parseLanes(ownDataValue(object, 'lanes', pathLabel), `${pathLabel}.lanes`);
  let allowDiagnostic = false;
  if (hasOwn(object, 'allow_diagnostic_partial_candidate')) {
    const flag = ownDataValue(object, 'allow_diagnostic_partial_candidate', pathLabel);
    if (flag !== true && flag !== false) deny('invalid_type', pathLabel);
    allowDiagnostic = flag === true;
  }
  return freezeRecord(capturedFreeze([
    ...REQUEST_ALLOWED_KEYS, 'candidate_ref',
  ]), {
    schema: RUN_CANDIDATE_COMPOSER_SCHEMA_ID,
    version: RUN_CANDIDATE_COMPOSER_VERSION,
    identity,
    expected_base_ref: expectedBaseRef,
    expected_protected_refs: expectedProtectedRefs,
    lanes,
    allow_diagnostic_partial_candidate: allowDiagnostic,
    candidate_ref: expectedCandidateRefV1({ run_id: identity.run_id }),
  });
}

function parseOptions(options, pathLabel = 'options') {
  if (options === undefined) {
    return freezeRecord(OPTIONS_ALLOWED_KEYS, {
      spawn: SPAWN, auditProtectedRefs: auditProtectedRefsV1,
    });
  }
  try { assertNotProxy(options, pathLabel); } catch (error) { remap(error, pathLabel); }
  try { assertPlainObject(options, 'invalid_type', pathLabel, pathLabel); } catch (error) {
    remap(error, pathLabel);
  }
  let keys;
  try { keys = OWN_KEYS(options); } catch { deny('invalid_type', pathLabel); }
  const allowedSet = new SET_CTOR(OPTIONS_ALLOWED_KEYS);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (!allowedSet.has(key)) deny('unknown_key', pathLabel);
  }
  let spawn = SPAWN;
  if (hasOwn(options, 'spawn')) {
    spawn = optOwn(options, 'spawn');
    if (typeof spawn !== 'function' || IS_PROXY(spawn)) deny('invalid_type', pathLabel);
  }
  let audit = auditProtectedRefsV1;
  if (hasOwn(options, 'auditProtectedRefs')) {
    audit = optOwn(options, 'auditProtectedRefs');
    if (typeof audit !== 'function' || IS_PROXY(audit)) deny('invalid_type', pathLabel);
  }
  return freezeRecord(OPTIONS_ALLOWED_KEYS, { spawn, auditProtectedRefs: audit });
}

function emptySideEffects() {
  const values = {};
  for (let i = 0; i < COMPOSER_SIDE_EFFECT_NONCLAIMS.length; i += 1) {
    values[COMPOSER_SIDE_EFFECT_NONCLAIMS[i]] = false;
  }
  return freezeRecord(COMPOSER_SIDE_EFFECT_NONCLAIMS, values);
}

function classifyLanes(lanes) {
  const applied = [];
  const blocked = [];
  const results = [];
  for (let i = 0; i < lanes.length; i += 1) {
    const lane = lanes[i];
    const blocking = lane.kind === 'required_writer'
      && capturedIncludes(BLOCKING_LANE_STATES, lane.state);
    if (blocking) blocked.push(lane.assignment_id);
    const eligible = lane.kind === 'required_writer' && lane.state === 'verified';
    if (eligible) applied.push(lane);
    results.push(freezeRecord(LANE_RESULT_KEYS, {
      assignment_id: lane.assignment_id,
      kind: lane.kind,
      state: lane.state,
      applied: false,
      path_count: 0,
      head_sha: lane.head_sha,
      write_scope: lane.write_scope,
    }));
  }
  return { applied, blocked, results };
}

async function assertCommit(session, repositoryPath, sha, pathLabel) {
  const typeResult = await runGit(
    session, repoArgs(repositoryPath, ['cat-file', '-t', '--', sha]), pathLabel,
  );
  if (typeResult.exit_code !== 0 || oneLine(typeResult.stdout, pathLabel) !== 'commit') {
    deny('unverified_delta_denied', pathLabel);
  }
}

async function assertAncestor(session, repositoryPath, baseSha, headSha, pathLabel) {
  const result = await runGit(
    session,
    repoArgs(repositoryPath, ['merge-base', '--is-ancestor', '--', baseSha, headSha]),
    pathLabel,
  );
  if (result.exit_code !== 0) deny('unverified_delta_denied', pathLabel);
}

async function observeDiff(session, repositoryPath, baseSha, headSha, pathLabel) {
  const raw = await runGit(session, repoArgs(repositoryPath, [
    'diff-tree', '--no-commit-id', '--raw', '--full-index', '-z', '-r',
    '-M', '-C', '--find-copies-harder', '--end-of-options', baseSha, headSha,
  ]), pathLabel);
  if (raw.exit_code !== 0) deny('git_execution_failed', pathLabel);
  return parseDiffTree(raw.stdout, pathLabel);
}

function revalidateRecords(records, lane, appliedPaths, siblingScopes, pathLabel) {
  if (records.rename === true || records.copy === true) deny('delta_policy_denied', pathLabel);
  for (let i = 0; i < records.records.length; i += 1) {
    const record = records.records[i];
    denyDeltaPolicy(record, pathLabel);
    if (appliedPaths.has(record.path)) deny('conflict_unresolved', pathLabel);
    if (pathOwned(record.path, siblingScopes)) deny('path_ownership_denied', pathLabel);
    if (!pathOwned(record.path, lane.compiled_write_scope)) deny('path_ownership_denied', pathLabel);
  }
}

function indexInfoBytes(records) {
  const chunks = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const mode = record.new_mode === MODE_MISSING ? MODE_MISSING : record.new_mode;
    const sha = record.new_mode === MODE_MISSING ? ZERO_SHA : record.new_sha;
    chunks.push(BUFFER_FROM(`${mode} ${sha}\t${record.path}\0`, 'utf8'));
  }
  return BUFFER_CONCAT(chunks);
}

async function currentRefSha(session, repositoryPath, ref, pathLabel) {
  const symbolic = await runGit(
    session, repoArgs(repositoryPath, ['symbolic-ref', '--quiet', '--end-of-options', ref]), pathLabel,
  );
  if (symbolic.exit_code === 0) deny('protected_ref_write_denied', pathLabel);
  const parsed = await runGit(
    session, repoArgs(repositoryPath, ['rev-parse', '--verify', '--end-of-options', ref]), pathLabel,
  );
  if (parsed.exit_code !== 0) return null;
  const sha = oneLine(parsed.stdout, pathLabel, /^[0-9a-f]{40}$/u);
  if (!isSha40(sha)) deny('git_execution_failed', pathLabel);
  return sha;
}

async function parentCountOf(session, repositoryPath, sha, pathLabel) {
  const result = await runGit(
    session, repoArgs(repositoryPath, ['rev-list', '--parents', '--max-count=1', sha]), pathLabel,
  );
  if (result.exit_code !== 0) deny('git_execution_failed', pathLabel);
  const line = oneLine(result.stdout, pathLabel);
  const parts = line.split(' ');
  if (parts[0] !== sha) deny('git_execution_failed', pathLabel);
  return parts.length - 1;
}

function emitFact(kind, method, request, status, payload, sequence, durationMs) {
  const factId = kind === 'git_diff' ? 'git-diff' : 'git-identity';
  return parseVerifiedFactV1({
    fact_id: factId,
    fact_kind: kind,
    status,
    code: 'host_observed',
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    sequence,
    subject: kind === 'git_diff' ? 'diff' : 'candidate',
    authority: 'platform_git',
    method,
    input_digest: digestOf({
      run_id: request.identity.run_id, base_sha: request.identity.base_sha,
    }),
    output_digest: digestOf(payload),
    exit_code: status === 'verified' ? 0 : 1,
    duration_ms: durationMs > MAX_DURATION_MS ? MAX_DURATION_MS : durationMs,
    truncated: false,
    payload,
    artifact_digests: [],
  });
}

function emitDiscrepancy(id, request, factIds, sequence) {
  return parseEvidenceDiscrepancyV1({
    discrepancy_id: id,
    discrepancy_kind: id === 'conflict' ? 'integrity' : 'security',
    status: 'recorded',
    code: id === 'conflict' ? 'claim_fact_mismatch' : 'security_boundary',
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    sequence,
    claim_ids: [],
    fact_ids: factIds,
    artifact_digests: [],
  });
}

function durationOf(session) {
  return MATH_MAX(0, MATH_FLOOR(Date.now() - session.startedAt));
}

function bindAuthority(request) {
  parseGitAuthorityPolicyV1(GIT_AUTHORITY_POLICY_V1);
  const identity = bindAuthorityIdentityV1({
    repository_path: request.identity.repository_path,
    base_sha: request.identity.base_sha,
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
  });
  denyWorkerRemoteMutation('compose_candidate_non_authoritative');
  const candidateRef = request.candidate_ref;
  if (!isRunOwnedCandidateRefV1(candidateRef, request.identity.run_id)) {
    deny('protected_ref_write_denied', 'compose.candidate_ref');
  }
  if (!candidateRef.startsWith(CANDIDATE_REF_NAMESPACE)
    || !candidateRef.endsWith(`/${CANDIDATE_REF_LEAF}`)) {
    deny('protected_ref_write_denied', 'compose.candidate_ref');
  }
  const verdict = classifyGitOperationV1({
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: ACTOR_VALUES[1],
    operation: 'compose_candidate_non_authoritative',
    identity: {
      repository_path: request.identity.repository_path,
      base_sha: request.identity.base_sha,
      run_id: request.identity.run_id,
      assignment_id: request.identity.assignment_id,
    },
    ref: candidateRef,
    history: { parent_counts: [1] },
  });
  if (verdict.verdict !== 'allowed' || verdict.ref_class !== 'platform_run_owned') {
    deny(verdict.code === 'protected_ref_write_denied'
      ? 'protected_ref_write_denied'
      : 'remote_mutation_denied', 'compose.ref');
  }
  return candidateRef;
}

function siblingScopesOf(lanes, assignmentId) {
  const compiled = [];
  for (let i = 0; i < lanes.length; i += 1) {
    const lane = lanes[i];
    if (lane.assignment_id === assignmentId || lane.kind !== 'required_writer') continue;
    for (let j = 0; j < lane.compiled_write_scope.length; j += 1) {
      compiled.push(lane.compiled_write_scope[j]);
    }
  }
  return compiled;
}

function receiptOf(request, values) {
  return freezeData(freezeRecord(RECEIPT_KEYS, {
    schema: RUN_CANDIDATE_COMPOSER_RECEIPT_SCHEMA_ID,
    version: RUN_CANDIDATE_COMPOSER_VERSION,
    status: values.status,
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    base_sha: request.identity.base_sha,
    candidate_ref: request.candidate_ref,
    candidate_sha: values.candidate_sha,
    parent_sha: values.parent_sha,
    parent_count: values.parent_count,
    applied_assignment_ids: capturedFreeze(values.applied_assignment_ids),
    blocked_assignment_ids: capturedFreeze(values.blocked_assignment_ids),
    lanes: capturedFreeze(values.lanes),
    allow_diagnostic_partial_candidate: request.allow_diagnostic_partial_candidate,
    incomplete: values.status === 'incomplete_candidate',
    ready_for_codex_review: false,
    idempotent: values.idempotent === true,
    checks: COMPOSER_CHECKS,
    side_effects: emptySideEffects(),
    facts: capturedFreeze(values.facts),
    discrepancies: capturedFreeze(values.discrepancies),
  }));
}

async function auditAfter(request, options, session) {
  return options.auditProtectedRefs({
    schema: 'codex-co-engineer.protected-ref-audit.v1',
    version: 1,
    identity: {
      repository_path: request.identity.repository_path,
      base_sha: request.identity.base_sha,
      run_id: request.identity.run_id,
      assignment_id: request.identity.assignment_id,
    },
    expected_refs: request.expected_protected_refs.map((entry) => ({
      ref: entry.ref, sha: entry.sha,
    })),
  }, { spawn: session.spawn });
}

export async function composeRunOwnedCandidateV1(input, options) {
  const request = parseRunCandidateComposeRequestV1(input);
  const parsedOptions = parseOptions(options);
  bindAuthority(request);
  const classified = classifyLanes(request.lanes);
  const durationPlaceholder = 0;
  if (classified.blocked.length > 0 && request.allow_diagnostic_partial_candidate !== true) {
    return receiptOf(request, {
      status: 'blocked',
      candidate_sha: null,
      parent_sha: request.identity.base_sha,
      parent_count: 0,
      applied_assignment_ids: [],
      blocked_assignment_ids: classified.blocked,
      lanes: classified.results,
      idempotent: false,
      facts: [
        emitFact('git_identity', 'ancestry_check', request, 'failed', {
          base_sha: request.identity.base_sha, head_sha: request.identity.base_sha,
        }, 0, durationPlaceholder),
      ],
      discrepancies: [emitDiscrepancy('required-lane', request, ['git-identity'], 1)],
    });
  }
  if (classified.applied.length === 0) {
    return receiptOf(request, {
      status: request.allow_diagnostic_partial_candidate === true
        ? 'incomplete_candidate' : 'blocked',
      candidate_sha: null,
      parent_sha: request.identity.base_sha,
      parent_count: 0,
      applied_assignment_ids: [],
      blocked_assignment_ids: classified.blocked,
      lanes: classified.results,
      idempotent: false,
      facts: [
        emitFact('git_identity', 'ancestry_check', request, 'failed', {
          base_sha: request.identity.base_sha, head_sha: request.identity.base_sha,
        }, 0, durationPlaceholder),
      ],
      discrepancies: [emitDiscrepancy('incomplete-candidate', request, ['git-identity'], 1)],
    });
  }

  const session = createSession(parsedOptions.spawn);
  const repositoryPath = request.identity.repository_path;
  await assertCommit(session, repositoryPath, request.identity.base_sha, 'compose.base_sha');
  const appliedPaths = new SET_CTOR();
  const appliedIds = [];
  const laneResults = classified.results.map((entry) => ({ ...entry }));
  const indexRoot = await mkdtemp(PATH_JOIN(tmpdir(), 'cce-p35-index-'));
  const indexPath = PATH_JOIN(indexRoot, 'index');
  try {
    const env = indexEnv(indexPath);
    const readTree = await runGit(
      session,
      repoArgs(repositoryPath, ['read-tree', '--reset', '--', request.identity.base_sha]),
      'compose.read-tree',
      { env },
    );
    if (readTree.exit_code !== 0) deny('git_execution_failed', 'compose.read-tree');

    for (let i = 0; i < classified.applied.length; i += 1) {
      const lane = classified.applied[i];
      await assertCommit(session, repositoryPath, lane.head_sha, 'compose.lane');
      await assertAncestor(
        session, repositoryPath, request.identity.base_sha, lane.head_sha, 'compose.lane',
      );
      const diff = await observeDiff(
        session, repositoryPath, request.identity.base_sha, lane.head_sha, 'compose.diff',
      );
      revalidateRecords(
        diff, lane, appliedPaths, siblingScopesOf(request.lanes, lane.assignment_id), 'compose.diff',
      );
      if (diff.records.length > 0) {
        const update = await runGit(
          session,
          repoArgs(repositoryPath, ['update-index', '--add', '--remove', '-z', '--index-info']),
          'compose.update-index',
          { env, stdin: indexInfoBytes(diff.records) },
        );
        if (update.exit_code !== 0) deny('conflict_unresolved', 'compose.update-index');
      }
      for (let p = 0; p < diff.paths.length; p += 1) appliedPaths.add(diff.paths[p]);
      appliedIds.push(lane.assignment_id);
      for (let r = 0; r < laneResults.length; r += 1) {
        if (laneResults[r].assignment_id === lane.assignment_id) {
          laneResults[r].applied = true;
          laneResults[r].path_count = diff.paths.length;
        }
      }
    }

    const treeResult = await runGit(
      session, repoArgs(repositoryPath, ['write-tree']), 'compose.write-tree', { env },
    );
    if (treeResult.exit_code !== 0) deny('git_execution_failed', 'compose.write-tree');
    const treeSha = oneLine(treeResult.stdout, 'compose.write-tree', /^[0-9a-f]{40}$/u);
    const commitResult = await runGit(
      session,
      repoArgs(repositoryPath, [
        'commit-tree', treeSha, '-p', request.identity.base_sha, '-m', CANDIDATE_COMMIT_MESSAGE,
      ]),
      'compose.commit-tree',
      { env: commitEnv() },
    );
    if (commitResult.exit_code !== 0) deny('git_execution_failed', 'compose.commit-tree');
    const candidateSha = oneLine(commitResult.stdout, 'compose.commit-tree', /^[0-9a-f]{40}$/u);
    const parents = await parentCountOf(session, repositoryPath, candidateSha, 'compose.parents');
    if (parents !== 1) deny('git_execution_failed', 'compose.parents');
    const existing = await currentRefSha(session, repositoryPath, request.candidate_ref, 'compose.ref');
    const idempotent = existing === candidateSha;
    if (existing !== candidateSha) {
      const updateRef = await runGit(
        session,
        repoArgs(repositoryPath, [
          'update-ref', '--no-deref', '--', request.candidate_ref, candidateSha,
        ]),
        'compose.update-ref',
        { env: commitEnv() },
      );
      if (updateRef.exit_code !== 0) deny('git_execution_failed', 'compose.update-ref');
    }
    const confirm = await currentRefSha(session, repositoryPath, request.candidate_ref, 'compose.ref');
    if (confirm !== candidateSha) deny('git_execution_failed', 'compose.ref');
    const audit = await auditAfter(request, parsedOptions, session);
    if (audit.status !== 'verified') deny('protected_ref_write_denied', 'compose.audit');

    const durationMs = durationOf(session);
    const paths = [...appliedPaths].sort();
    const pathDigest = digestOf(paths);
    if (!capturedTest(SHA256_PATTERN, pathDigest)) deny('git_execution_failed', 'compose.diff');
    const status = classified.blocked.length > 0 ? 'incomplete_candidate' : 'composed';
    const frozenLanes = laneResults.map((entry) => freezeRecord(LANE_RESULT_KEYS, entry));
    return receiptOf(request, {
      status,
      candidate_sha: candidateSha,
      parent_sha: request.identity.base_sha,
      parent_count: 1,
      applied_assignment_ids: appliedIds,
      blocked_assignment_ids: classified.blocked,
      lanes: frozenLanes,
      idempotent,
      facts: [
        emitFact('git_identity', 'ancestry_check', request, 'verified', {
          base_sha: request.identity.base_sha, head_sha: candidateSha,
        }, 0, durationMs),
        emitFact('git_diff', 'scope_match', request, 'verified', {
          path_count: paths.length, path_set_digest: pathDigest,
        }, 1, durationMs),
      ],
      discrepancies: status === 'incomplete_candidate'
        ? [emitDiscrepancy('incomplete-candidate', request, ['git-identity'], 2)]
        : [],
    });
  } finally {
    await rm(indexRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function describeRunCandidateComposerV1() {
  return freezeData(capturedFreeze({
    schema: RUN_CANDIDATE_COMPOSER_SCHEMA_ID,
    version: RUN_CANDIDATE_COMPOSER_VERSION,
    receipt_schema: RUN_CANDIDATE_COMPOSER_RECEIPT_SCHEMA_ID,
    rule: 'frozen_verified_child_deltas_binary_safe_manifest_order',
    api: capturedFreeze([
      'composeRunOwnedCandidateV1', 'describeRunCandidateComposerV1',
      'parseRunCandidateComposeRequestV1',
    ]),
    statuses: COMPOSER_STATUSES,
    lane_states: LANE_STATES,
    checks: COMPOSER_CHECKS,
    error_codes: RUN_CANDIDATE_COMPOSER_ERROR_CODES,
    side_effect_nonclaims: COMPOSER_SIDE_EFFECT_NONCLAIMS,
    candidate_ref_namespace: CANDIDATE_REF_NAMESPACE,
    candidate_ref_leaf: CANDIDATE_REF_LEAF,
    max_lanes: MAX_COMPOSER_LANES,
    conflict_repair: false,
    ready_for_codex_review: false,
    remote_mutated: false,
    gate_a_claimed: false,
    imports_server: false,
    imports_supervisor: false,
    imports_runtime: false,
    imports_scheduler: false,
    imports_provider: false,
    composed_surfaces: capturedFreeze({
      git_authority: GIT_AUTHORITY_SCHEMA_ID,
      protected_ref_audit: 'codex-co-engineer.protected-ref-audit.v1',
      evidence_bundle: 'codex-co-engineer.evidence-bundle.v1',
    }),
  }));
}

capturedFreeze(parseRunCandidateComposeRequestV1);
capturedFreeze(composeRunOwnedCandidateV1);
capturedFreeze(describeRunCandidateComposerV1);
