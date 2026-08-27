// ProtectedRefAuditV1 — live read-only comparison of declared
// protected/default refs against immutable expected identities (P30;
// ADR 0001 `gate_a_no_protected_ref_mutation`).
//
// Additive v3 module. It consumes accepted P28 GitAuthorityPolicyV1 and
// P29 credential/remote isolation without wrapping or weakening them.
// Observation is argv-only under the P29 inspect environment with
// isolation flags that cannot create advisory lock files. Receipts and
// errors are content-free: they never echo repository paths, URLs,
// credentials, provider text, or hostile refs. No Git mutation, no
// credential materialization, no remote I/O, no API, no run
// orchestration, no release, and no Gate A authority.

import { Buffer as NodeBuffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat as nodeLstat, readFile as nodeReadFile, realpath as nodeRealpath } from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  GIT_INSPECT_ENV,
  CredentialBoundaryError,
  denyWorkerRemoteMutation,
} from './credential-boundary.mjs';
import {
  MAX_DURATION_MS,
  MAX_SEQUENCE,
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
} from './evidence-bundle.mjs';
import {
  ACTOR_VALUES,
  DENIED_OPERATIONS,
  GIT_AUTHORITY_POLICY_V1,
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  bindAuthorityIdentityV1,
  classifyGitOperationV1,
  classifyRefV1,
  isProtectedRefV1,
  parseGitAuthorityPolicyV1,
} from './git-authority.mjs';
import {
  GIT_EXECUTABLE,
  MAX_GIT_ARG_BYTES,
  MAX_GIT_OUTPUT_BYTES,
  MAX_GIT_TIME_MS,
  MAX_GIT_TOTAL_TIME_MS,
} from './git-identity.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  capturedUtf8ByteLength,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import { RunContractV1Error, isSha40 } from './run-manifest.mjs';
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

export const PROTECTED_REF_AUDIT_SCHEMA_ID = 'codex-co-engineer.protected-ref-audit.v1';
export const PROTECTED_REF_AUDIT_VERSION = 1;
export const MAX_AUDIT_REFS = 16;
export const MAX_AUDIT_OBJECT_KEYS = 32;
export const MAX_AUDIT_KEY_BYTES = 128;
export const MAX_AUDIT_GIT_COMMANDS = 8;
export const MAX_AUDIT_GIT_ARGS = 64;
export const MAX_LAYOUT_FILE_BYTES = 4096;

export const PROTECTED_REF_AUDIT_STATUSES = capturedFreeze(['failed', 'verified']);
export const PROTECTED_REF_AUDIT_REPOSITORY_KINDS = capturedFreeze([
  'bare', 'linked_worktree', 'local',
]);
export const PROTECTED_REF_AUDIT_STORAGE_CLASSES = capturedFreeze([
  'absent', 'loose', 'packed', 'symbolic', 'unknown',
]);
export const PROTECTED_REF_AUDIT_FINDING_CODES = capturedFreeze([
  'aliased_ref', 'hostile_ref', 'missing_ref', 'moved_ref', 'packed_ref',
  'race_detected', 'symbolic_ref',
]);
export const PROTECTED_REF_AUDIT_FAILING_CODES = capturedFreeze([
  'aliased_ref', 'hostile_ref', 'missing_ref', 'moved_ref', 'race_detected',
  'symbolic_ref',
]);
export const PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS = capturedFreeze([
  'for-each-ref', 'rev-parse',
]);
export const PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS = capturedFreeze([
  'config_mutated', 'credentials_accessed', 'index_mutated',
  'packed_refs_rewritten', 'ref_mutated', 'remote_mutated', 'worktree_mutated',
]);
export const PROTECTED_REF_AUDIT_CHECKS = capturedFreeze([
  'request_quarantine',
  'p28_authority_policy',
  'p29_remote_mutation_denial',
  'protected_or_default_only',
  'canonical_repository',
  'replace_and_graft_absence',
  'declared_ref_snapshot',
  'packed_vs_loose_storage',
  'race_repeat_snapshot',
]);

export const REQUEST_ALLOWED_KEYS = capturedFreeze([
  'default_branch', 'expected_refs', 'identity', 'init_default_branch',
  'manifest_digest_hex', 'operation', 'origin_head_branch', 'schema',
  'sequence', 'version',
]);
export const REQUEST_REQUIRED_KEYS = capturedFreeze([
  'expected_refs', 'identity', 'schema', 'version',
]);
export const EXPECTED_REF_ALLOWED_KEYS = capturedFreeze(['ref', 'sha']);
export const OPTIONS_ALLOWED_KEYS = capturedFreeze(['spawn']);
export const COMPARISON_KEYS = capturedFreeze([
  'default_branch_target', 'outcome', 'protected', 'ref_class', 'storage',
]);
export const RECEIPT_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'comparisons', 'discrepancies', 'facts',
  'findings', 'observation', 'observed_classes', 'repository_kind', 'run_id',
  'schema', 'side_effects', 'status', 'version',
]);

export const PROTECTED_REF_AUDIT_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied',
  'audit_operation_denied', 'authority_identity_invalid', 'bounds_exceeded',
  'config_influence_denied', 'credential_content_denied',
  'env_influence_denied', 'exotic_prototype_denied',
  'expected_ref_not_protected', 'grafts_denied', 'git_execution_failed',
  'hostile_name_denied', 'invalid_format', 'invalid_type', 'missing_key',
  'non_enumerable_property_denied', 'out_of_range', 'own_undefined_denied',
  'proxy_denied', 'replace_refs_denied', 'remote_mutation_denied',
  'repository_invalid', 'repository_missing', 'symbol_key_denied',
  'unknown_key', 'value_depth_exceeded',
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TRUE_FALSE_PATTERN = /^(?:true|false)$/u;
const OBJECT_TYPE_PATTERN = /^(?:blob|commit|tag|tree)$/u;
const GITDIR_LINE_PATTERN = /^gitdir:[ \t]*(.+)$/u;

const DEFINE = Object.defineProperty;
const OBJECT_IS = Object.is;
const IS_INT = Number.isSafeInteger;
const STRING = String;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const BUFFER_IS_BUFFER = NodeBuffer.isBuffer.bind(NodeBuffer);
const IS_ARRAY = Array.isArray;
const OWN_KEYS = Reflect.ownKeys;
const SET_CTOR = Set;
const HASH = createHash;
const HASH_DIGEST = Object.getPrototypeOf(HASH('sha256')).digest;
const HASH_UPDATE = Object.getPrototypeOf(HASH('sha256')).update;
const IS_PROXY = utilTypes.isProxy;
const REFLECT_APPLY = Reflect.apply;
const ARRAY_PUSH = Array.prototype.push;
const PATH_JOIN = path.join;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const PATH_RESOLVE = path.resolve;
const SPAWN = nodeSpawn;
const LSTAT = nodeLstat;
const READFILE = nodeReadFile;
const REALPATH = nodeRealpath;
const MATH_MIN = Math.min;
const MATH_MAX = Math.max;
const MATH_FLOOR = Math.floor;

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

const FORBIDDEN_ENV_KEYS = capturedFreeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE', 'GIT_QUARANTINE_PATH',
  'GIT_PROXY_COMMAND', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_TRACE',
  'GIT_TRACE2', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
]);

const MSG = capturedFreeze({
  accessor_property_denied: 'ProtectedRefAuditV1 denies accessor inputs.',
  aliased_reference_denied: 'ProtectedRefAuditV1 denies aliased inputs.',
  audit_operation_denied: 'ProtectedRefAuditV1 permits read-only inspect only.',
  authority_identity_invalid: 'ProtectedRefAuditV1 rejected the credential-free repository identity.',
  bounds_exceeded: 'ProtectedRefAuditV1 exceeded a closed observation bound.',
  config_influence_denied: 'ProtectedRefAuditV1 denies config, replace, or graft influence.',
  credential_content_denied: 'ProtectedRefAuditV1 denies credentials and remote mutation material.',
  env_influence_denied: 'ProtectedRefAuditV1 denies git environment influence.',
  exotic_prototype_denied: 'ProtectedRefAuditV1 denies exotic prototypes.',
  expected_ref_not_protected: 'ProtectedRefAuditV1 audits only P28 protected or default refs.',
  grafts_denied: 'ProtectedRefAuditV1 denies grafts and shallow history.',
  git_execution_failed: 'ProtectedRefAuditV1 could not complete a git observation.',
  hostile_name_denied: 'ProtectedRefAuditV1 denied a hostile ref or argument.',
  invalid_format: 'ProtectedRefAuditV1 rejected a value that violates a closed grammar.',
  invalid_type: 'ProtectedRefAuditV1 rejected a non-JSON audit value.',
  missing_key: 'ProtectedRefAuditV1 requires every canonical audit key.',
  non_enumerable_property_denied: 'ProtectedRefAuditV1 denies non-enumerable properties.',
  out_of_range: 'ProtectedRefAuditV1 rejected a value outside closed bounds.',
  own_undefined_denied: 'ProtectedRefAuditV1 denies own undefined values.',
  proxy_denied: 'ProtectedRefAuditV1 denies Proxy inputs.',
  replace_refs_denied: 'ProtectedRefAuditV1 denies replace refs.',
  remote_mutation_denied: 'ProtectedRefAuditV1 denies remote mutation and credential access.',
  repository_invalid: 'ProtectedRefAuditV1 rejected an untrusted repository layout.',
  repository_missing: 'ProtectedRefAuditV1 could not observe the declared repository.',
  symbol_key_denied: 'ProtectedRefAuditV1 denies symbol keys.',
  unknown_key: 'ProtectedRefAuditV1 rejects keys outside the closed vocabulary.',
  value_depth_exceeded: 'ProtectedRefAuditV1 rejected nested input that exceeds closed depth.',
});

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!capturedHasOwn(values, key)) continue;
    DEFINE(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function deny(code, pathLabel) {
  fail(code, pathLabel, MSG[code] ?? MSG.invalid_format);
}

function publicCode(error) {
  if (error instanceof RunContractV1Error
    && capturedIncludes(PROTECTED_REF_AUDIT_ERROR_CODES, error.code)) {
    return error.code;
  }
  return 'invalid_type';
}

function remap(error, pathLabel) {
  deny(publicCode(error), pathLabel);
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
  if (keys.length > MAX_AUDIT_OBJECT_KEYS) deny('out_of_range', pathLabel);
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (typeof key !== 'string' || BYTE_LENGTH(key, 'utf8') > MAX_AUDIT_KEY_BYTES) {
      deny('out_of_range', pathLabel);
    }
    if (!allowedSet.has(key)) deny('unknown_key', pathLabel);
  }
  try {
    assertDirectJsonClosure(input, pathLabel);
  } catch (error) { remap(error, pathLabel); }
  return input;
}

function requireKeys(input, keys, pathLabel) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasOwn(input, keys[i])) deny('missing_key', pathLabel);
  }
}

function digestOf(value) {
  const hash = HASH('sha256');
  HASH_UPDATE.call(hash, canonicalJsonStringify(value));
  const digest = HASH_DIGEST.call(hash, 'hex');
  if (!capturedTest(SHA256_PATTERN, digest)) deny('invalid_format', 'digest');
  return digest;
}

function isSymlinkStat(metadata) {
  return typeof metadata?.isSymbolicLink === 'function' && metadata.isSymbolicLink();
}

async function lstatOrNull(target) {
  try {
    return await LSTAT(target);
  } catch {
    return null;
  }
}

function resolveLayoutPath(raw, fromDir, pathLabel) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) {
    deny('repository_invalid', pathLabel);
  }
  const resolved = PATH_IS_ABSOLUTE(raw) ? PATH_RESOLVE(raw) : PATH_RESOLVE(fromDir, raw);
  if (!PATH_IS_ABSOLUTE(resolved) || PATH_RESOLVE(resolved) !== resolved) {
    deny('repository_invalid', pathLabel);
  }
  return resolved;
}

async function readBoundedUtf8(target, pathLabel) {
  const metadata = await lstatOrNull(target);
  if (metadata === null) return null;
  if (isSymlinkStat(metadata) || typeof metadata.isFile !== 'function' || !metadata.isFile()) {
    deny('repository_invalid', pathLabel);
  }
  if (typeof metadata.size === 'number' && metadata.size > MAX_LAYOUT_FILE_BYTES) {
    deny('repository_invalid', pathLabel);
  }
  let text;
  try {
    text = await READFILE(target, { encoding: 'utf8' });
  } catch {
    deny('repository_invalid', pathLabel);
  }
  if (typeof text !== 'string' || BYTE_LENGTH(text, 'utf8') > MAX_LAYOUT_FILE_BYTES) {
    deny('repository_invalid', pathLabel);
  }
  return text;
}

async function realpathOf(target, pathLabel) {
  try {
    return await REALPATH(target);
  } catch {
    deny('repository_invalid', pathLabel);
  }
}

async function assertDirectoryNotSymlink(target, pathLabel) {
  let metadata;
  try {
    metadata = await LSTAT(target);
  } catch {
    deny('repository_invalid', pathLabel);
  }
  if (isSymlinkStat(metadata) || typeof metadata.isDirectory !== 'function' || !metadata.isDirectory()) {
    deny('repository_invalid', pathLabel);
  }
  return realpathOf(target, pathLabel);
}

function oneLayoutLine(text, pathLabel) {
  if (typeof text !== 'string') deny('repository_invalid', pathLabel);
  let value = text;
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.endsWith('\r')) value = value.slice(0, -1);
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    deny('repository_invalid', pathLabel);
  }
  return value;
}

function assertInspectEnv(env, pathLabel) {
  if (env !== GIT_INSPECT_ENV) deny('env_influence_denied', pathLabel);
  for (let i = 0; i < FORBIDDEN_ENV_KEYS.length; i += 1) {
    if (capturedHasOwn(env, FORBIDDEN_ENV_KEYS[i])) deny('env_influence_denied', pathLabel);
  }
}

function assertGitArgv(args, pathLabel) {
  if (!IS_ARRAY(args)) deny('invalid_type', pathLabel);
  if (args.length > MAX_AUDIT_GIT_ARGS) deny('bounds_exceeded', pathLabel);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string' || arg.length === 0 || arg.includes('\0')) {
      deny('hostile_name_denied', pathLabel);
    }
    if (BYTE_LENGTH(arg, 'utf8') > MAX_GIT_ARG_BYTES) deny('bounds_exceeded', pathLabel);
  }
}

function assertReadonlyCommand(args, pathLabel) {
  let command;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-C' || arg === '--git-dir' || arg === '-c') {
      i += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('-')) continue;
    command = arg;
    break;
  }
  if (!capturedIncludes(PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS, command)) {
    deny('audit_operation_denied', pathLabel);
  }
}

function createSession(spawnFn) {
  const startedAt = Date.now();
  return {
    spawn: spawnFn,
    commands: 0,
    startedAt,
    deadlineAt: startedAt + MAX_GIT_TOTAL_TIME_MS,
  };
}

function remainingMs(session) {
  const left = session.deadlineAt - Date.now();
  return left > 0 ? left : 0;
}

function assertSessionBounds(session, pathLabel) {
  if (session.commands >= MAX_AUDIT_GIT_COMMANDS) deny('bounds_exceeded', pathLabel);
  if (Date.now() >= session.deadlineAt) deny('bounds_exceeded', pathLabel);
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

function runGit(session, args, pathLabel) {
  assertGitArgv(args, `${pathLabel}.args`);
  assertReadonlyCommand(args, pathLabel);
  assertSessionBounds(session, pathLabel);
  const budget = remainingMs(session);
  if (budget <= 0) deny('bounds_exceeded', pathLabel);
  session.commands += 1;
  const argv = [...GIT_ISOLATION_FLAGS, ...args];
  assertGitArgv(argv, `${pathLabel}.argv`);
  const spawnOptions = {
    cwd: '/',
    env: GIT_INSPECT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
  assertInspectEnv(spawnOptions.env, `${pathLabel}.env`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = session.spawn(GIT_EXECUTABLE, argv, spawnOptions);
    } catch {
      reject(new RunContractV1Error(
        'git_execution_failed', pathLabel, MSG.git_execution_failed,
      ));
      return;
    }
    if (child === null || (typeof child !== 'object' && typeof child !== 'function')) {
      reject(new RunContractV1Error(
        'git_execution_failed', pathLabel, MSG.git_execution_failed,
      ));
      return;
    }
    try {
      if (IS_PROXY(child)) deny('proxy_denied', pathLabel);
    } catch (error) {
      reject(error instanceof RunContractV1Error
        ? error
        : new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error instanceof RunContractV1Error
        ? error
        : new RunContractV1Error('git_execution_failed', pathLabel, MSG.git_execution_failed));
      else resolve(result);
    };
    const exceed = () => {
      if (exceeded) return;
      exceeded = true;
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish(new RunContractV1Error('bounds_exceeded', pathLabel, MSG.bounds_exceeded));
    };
    timer = setTimeout(exceed, MATH_MIN(MAX_GIT_TIME_MS, budget));
    const onChunk = (target, getSize, setSize) => (chunk) => {
      try {
        const owned = ownedChunk(chunk, pathLabel);
        const next = getSize() + owned.length;
        setSize(next);
        if (next > MAX_GIT_OUTPUT_BYTES) {
          exceed();
          return;
        }
        REFLECT_APPLY(ARRAY_PUSH, target, [owned]);
      } catch (error) {
        finish(error);
      }
    };
    try {
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', onChunk(stdoutChunks, () => stdoutBytes, (value) => { stdoutBytes = value; }));
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', onChunk(stderrChunks, () => stderrBytes, (value) => { stderrBytes = value; }));
      }
      child.once('error', () => {
        finish(new RunContractV1Error(
          'git_execution_failed', pathLabel, MSG.git_execution_failed,
        ));
      });
      child.once('close', (code, signal) => {
        if (exceeded) return;
        if (Date.now() >= session.deadlineAt) {
          finish(new RunContractV1Error('bounds_exceeded', pathLabel, MSG.bounds_exceeded));
          return;
        }
        if (signal !== null && signal !== undefined) {
          finish(new RunContractV1Error(
            'git_execution_failed', pathLabel, MSG.git_execution_failed,
          ));
          return;
        }
        finish(null, {
          exit_code: typeof code === 'number' ? code : 1,
          stdout: BUFFER_CONCAT(stdoutChunks).toString('utf8'),
          stderr: BUFFER_CONCAT(stderrChunks).toString('utf8'),
        });
      });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish(new RunContractV1Error(
        'git_execution_failed', pathLabel, MSG.git_execution_failed,
      ));
    }
  });
}

async function gitLines(session, args, pathLabel, count) {
  const result = await runGit(session, args, pathLabel);
  if (result.exit_code !== 0) deny('git_execution_failed', pathLabel);
  let text = result.stdout;
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.includes('\0') || text.includes('\r')) deny('git_execution_failed', pathLabel);
  const lines = text.length === 0 ? [] : text.split('\n');
  if (count !== undefined && lines.length !== count) deny('git_execution_failed', pathLabel);
  return lines;
}

function cwdFlags(repositoryPath) {
  return capturedFreeze(['-C', repositoryPath]);
}

function parseExpectedRef(input, pathLabel, seenRefs, seenObjects) {
  const object = assertClosedObject(input, EXPECTED_REF_ALLOWED_KEYS, pathLabel);
  requireKeys(object, EXPECTED_REF_ALLOWED_KEYS, pathLabel);
  for (const prior of seenObjects) {
    if (OBJECT_IS(prior, input)) deny('aliased_reference_denied', pathLabel);
  }
  seenObjects.push(input);
  const refValue = optOwn(object, 'ref');
  if (typeof refValue !== 'string') deny('invalid_type', `${pathLabel}.ref`);
  const sha = optOwn(object, 'sha');
  if (typeof sha !== 'string' || !isSha40(sha)) deny('invalid_format', `${pathLabel}.sha`);
  if (seenRefs.has(refValue)) deny('invalid_format', pathLabel);
  seenRefs.add(refValue);
  return { ref: refValue, sha };
}

function parseExpectedRefs(input, pathLabel) {
  try { assertNotProxy(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  if (!IS_ARRAY(input)) deny('invalid_type', pathLabel);
  if (input.length < 1 || input.length > MAX_AUDIT_REFS) deny('out_of_range', pathLabel);
  const seenRefs = new SET_CTOR();
  const seenObjects = [];
  const refs = [];
  for (let i = 0; i < input.length; i += 1) {
    let item;
    try {
      item = ownDataValue(input, STRING(i), `${pathLabel}[${i}]`);
    } catch (error) { remap(error, pathLabel); }
    refs.push(parseExpectedRef(item, `${pathLabel}[${i}]`, seenRefs, seenObjects));
  }
  return capturedFreeze(refs);
}

function parseSequence(input, pathLabel) {
  if (!hasOwn(input, 'sequence')) return 0;
  const value = optOwn(input, 'sequence');
  if (typeof value !== 'number' || !IS_INT(value) || value < 0 || value > MAX_SEQUENCE) {
    deny('out_of_range', pathLabel);
  }
  return value;
}

function parseOptionalBranch(input, key, pathLabel) {
  if (!hasOwn(input, key)) return undefined;
  const value = optOwn(input, key);
  if (typeof value !== 'string' || value.length === 0
    || capturedUtf8ByteLength(value) > MAX_AUDIT_KEY_BYTES) {
    deny('invalid_format', `${pathLabel}.${key}`);
  }
  return value;
}

function assertAuditOperation(operation, pathLabel) {
  try {
    denyWorkerRemoteMutation(operation);
  } catch (error) {
    if (error instanceof CredentialBoundaryError) deny('remote_mutation_denied', pathLabel);
    if (error instanceof RunContractV1Error) remap(error, pathLabel);
    deny('remote_mutation_denied', pathLabel);
  }
  if (capturedIncludes(DENIED_OPERATIONS, operation)) deny('remote_mutation_denied', pathLabel);
  if (operation !== 'read_only_inspect') deny('audit_operation_denied', pathLabel);
  return operation;
}

function classifyDeclaredRef(entry, identity, extras) {
  const request = { ref: entry.ref, identity };
  for (const key of [
    'default_branch', 'origin_head_branch', 'init_default_branch', 'manifest_digest_hex',
  ]) {
    if (extras[key] !== undefined) request[key] = extras[key];
  }
  const classified = classifyRefV1(request);
  if (classified.ref_class === 'unclassified' || classified.code === 'branch_namespace_violation') {
    deny('hostile_name_denied', 'expected_refs');
  }
  if (classified.protected !== true || isProtectedRefV1(request) !== true) {
    deny('expected_ref_not_protected', 'expected_refs');
  }
  return classified;
}

export function parseProtectedRefAuditRequestV1(input, pathLabel = 'protected_ref_audit') {
  const object = assertClosedObject(input, REQUEST_ALLOWED_KEYS, pathLabel);
  requireKeys(object, REQUEST_REQUIRED_KEYS, pathLabel);
  if (optOwn(object, 'schema') !== PROTECTED_REF_AUDIT_SCHEMA_ID) {
    deny('invalid_format', `${pathLabel}.schema`);
  }
  if (optOwn(object, 'version') !== PROTECTED_REF_AUDIT_VERSION) {
    deny('invalid_format', `${pathLabel}.version`);
  }
  const identityInput = optOwn(object, 'identity');
  const bound = bindAuthorityIdentityV1(identityInput);
  const repositoryPath = optOwn(identityInput, 'repository_path');
  const expectedRefs = parseExpectedRefs(optOwn(object, 'expected_refs'), `${pathLabel}.expected_refs`);
  const extras = {
    default_branch: parseOptionalBranch(object, 'default_branch', pathLabel),
    origin_head_branch: parseOptionalBranch(object, 'origin_head_branch', pathLabel),
    init_default_branch: parseOptionalBranch(object, 'init_default_branch', pathLabel),
  };
  if (hasOwn(object, 'manifest_digest_hex')) {
    const digest = optOwn(object, 'manifest_digest_hex');
    if (typeof digest !== 'string' || !capturedTest(/^[0-9a-f]{64}$/u, digest)) {
      deny('invalid_format', `${pathLabel}.manifest_digest_hex`);
    }
    extras.manifest_digest_hex = digest;
  }
  const operation = hasOwn(object, 'operation')
    ? optOwn(object, 'operation')
    : 'read_only_inspect';
  if (typeof operation !== 'string') deny('invalid_type', `${pathLabel}.operation`);
  assertAuditOperation(operation, `${pathLabel}.operation`);
  parseGitAuthorityPolicyV1(GIT_AUTHORITY_POLICY_V1);
  const classified = [];
  for (let i = 0; i < expectedRefs.length; i += 1) {
    classified.push(classifyDeclaredRef(expectedRefs[i], identityInput, extras));
  }
  const sequence = parseSequence(object, `${pathLabel}.sequence`);
  return freezeRecord([
    'schema', 'version', 'identity', 'repository_path', 'expected_refs',
    'classified', 'extras', 'operation', 'sequence',
  ], {
    schema: PROTECTED_REF_AUDIT_SCHEMA_ID,
    version: PROTECTED_REF_AUDIT_VERSION,
    identity: bound,
    repository_path: repositoryPath,
    expected_refs: expectedRefs,
    classified: capturedFreeze(classified),
    extras: freezeRecord(
      ['default_branch', 'origin_head_branch', 'init_default_branch', 'manifest_digest_hex'],
      extras,
    ),
    operation,
    sequence,
  });
}

function parseOptions(options, pathLabel = 'options') {
  if (options === undefined) {
    return freezeRecord(OPTIONS_ALLOWED_KEYS, { spawn: SPAWN });
  }
  try { assertNotProxy(options, pathLabel); } catch (error) { remap(error, pathLabel); }
  if (options === null || typeof options !== 'object' || IS_ARRAY(options)) {
    deny('invalid_type', pathLabel);
  }
  let keys;
  try { keys = OWN_KEYS(options); } catch { deny('invalid_type', pathLabel); }
  if (keys.length > MAX_AUDIT_OBJECT_KEYS) deny('out_of_range', pathLabel);
  const allowed = new SET_CTOR(OPTIONS_ALLOWED_KEYS);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (typeof key !== 'string' || BYTE_LENGTH(key, 'utf8') > MAX_AUDIT_KEY_BYTES) {
      deny('out_of_range', pathLabel);
    }
    if (!allowed.has(key)) deny('unknown_key', pathLabel);
  }
  let spawn = SPAWN;
  if (hasOwn(options, 'spawn')) {
    spawn = optOwn(options, 'spawn');
    if (typeof spawn !== 'function') deny('invalid_type', `${pathLabel}.spawn`);
    try { assertNotProxy(spawn, `${pathLabel}.spawn`); } catch (error) { remap(error, pathLabel); }
  }
  return freezeRecord(OPTIONS_ALLOWED_KEYS, { spawn });
}

function assertAuthorityInspect(request) {
  const verdict = classifyGitOperationV1({
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: 'platform',
    operation: 'read_only_inspect',
    identity: {
      repository_path: request.repository_path,
      base_sha: request.identity.base_sha,
      run_id: request.identity.run_id,
      assignment_id: request.identity.assignment_id,
    },
  });
  if (verdict.verdict !== 'allowed' || verdict.code !== 'authority_ok') {
    deny('audit_operation_denied', 'operation');
  }
  if (!capturedIncludes(ACTOR_VALUES, 'platform')) deny('invalid_format', 'actor');
}

async function observeRepositoryKind(session, repositoryPath, pathLabel) {
  let metadata;
  try {
    metadata = await LSTAT(repositoryPath);
  } catch {
    deny('repository_missing', `${pathLabel}.identity.repository_path`);
  }
  if (typeof metadata?.isDirectory !== 'function' || !metadata.isDirectory() || isSymlinkStat(metadata)) {
    deny('repository_invalid', `${pathLabel}.identity.repository_path`);
  }
  let resolved;
  try {
    resolved = await REALPATH(repositoryPath);
  } catch {
    deny('repository_missing', `${pathLabel}.identity.repository_path`);
  }
  if (resolved !== repositoryPath || !PATH_IS_ABSOLUTE(resolved) || PATH_RESOLVE(resolved) !== resolved) {
    deny('repository_invalid', `${pathLabel}.identity.repository_path`);
  }
  const lines = await gitLines(
    session,
    [...cwdFlags(repositoryPath), 'rev-parse', '--path-format=absolute',
      '--is-bare-repository', '--is-inside-work-tree', '--absolute-git-dir',
      '--git-common-dir', '--git-path', 'packed-refs', '--git-path', 'info/grafts',
      '--git-path', 'shallow'],
    `${pathLabel}.repository`,
    7,
  );
  const [bare, inside, gitDir, commonDir, packedRefsPath, graftsPath, shallowPath] = lines;
  if (!capturedTest(TRUE_FALSE_PATTERN, bare) || !capturedTest(TRUE_FALSE_PATTERN, inside)) {
    deny('repository_invalid', `${pathLabel}.repository`);
  }
  for (const candidate of [gitDir, commonDir, packedRefsPath, graftsPath, shallowPath]) {
    if (!PATH_IS_ABSOLUTE(candidate) || PATH_RESOLVE(candidate) !== candidate || candidate.includes('\0')) {
      deny('repository_invalid', `${pathLabel}.repository`);
    }
  }
  const gitDirReal = await assertDirectoryNotSymlink(gitDir, `${pathLabel}.repository`);
  const commonReal = await assertDirectoryNotSymlink(commonDir, `${pathLabel}.repository`);
  let kind;
  if (bare === 'true') {
    if (inside !== 'false' || gitDirReal !== repositoryPath) {
      deny('repository_invalid', `${pathLabel}.repository`);
    }
    kind = 'bare';
  } else {
    if (inside !== 'true') deny('repository_invalid', `${pathLabel}.repository`);
    const gitEntry = PATH_JOIN(repositoryPath, '.git');
    let entryMeta;
    try {
      entryMeta = await LSTAT(gitEntry);
    } catch {
      deny('repository_invalid', `${pathLabel}.repository`);
    }
    if (isSymlinkStat(entryMeta)) deny('repository_invalid', `${pathLabel}.repository`);
    if (typeof entryMeta.isDirectory === 'function' && entryMeta.isDirectory()) {
      const entryReal = await realpathOf(gitEntry, `${pathLabel}.repository`);
      if (entryReal !== gitDirReal) deny('repository_invalid', `${pathLabel}.repository`);
      kind = 'local';
    } else if (typeof entryMeta.isFile === 'function' && entryMeta.isFile()) {
      const text = await readBoundedUtf8(gitEntry, `${pathLabel}.repository`);
      if (text === null) deny('repository_invalid', `${pathLabel}.repository`);
      const match = GITDIR_LINE_PATTERN.exec(oneLayoutLine(text, `${pathLabel}.repository`));
      if (match === null) deny('repository_invalid', `${pathLabel}.repository`);
      const declared = resolveLayoutPath(match[1].trim(), repositoryPath, `${pathLabel}.repository`);
      const declaredReal = await assertDirectoryNotSymlink(declared, `${pathLabel}.repository`);
      if (declaredReal !== gitDirReal) deny('repository_invalid', `${pathLabel}.repository`);
      const commondirText = await readBoundedUtf8(
        PATH_JOIN(declared, 'commondir'), `${pathLabel}.repository`,
      );
      if (commondirText === null) deny('repository_invalid', `${pathLabel}.repository`);
      const declaredCommon = await assertDirectoryNotSymlink(
        resolveLayoutPath(
          oneLayoutLine(commondirText, `${pathLabel}.repository`),
          declared,
          `${pathLabel}.repository`,
        ),
        `${pathLabel}.repository`,
      );
      if (declaredCommon !== commonReal) deny('repository_invalid', `${pathLabel}.repository`);
      kind = 'linked_worktree';
    } else {
      deny('repository_invalid', `${pathLabel}.repository`);
    }
  }
  const graftsMeta = await lstatOrNull(graftsPath);
  if (graftsMeta !== null) deny('grafts_denied', `${pathLabel}.grafts`);
  const shallowMeta = await lstatOrNull(shallowPath);
  if (shallowMeta !== null) deny('grafts_denied', `${pathLabel}.shallow`);
  return freezeRecord(
    ['kind', 'git_dir', 'common_dir', 'packed_refs_path'],
    {
      kind,
      git_dir: gitDirReal,
      common_dir: commonReal,
      packed_refs_path: packedRefsPath,
    },
  );
}

function parseRefRecords(lines, pathLabel) {
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length !== 4) deny('git_execution_failed', pathLabel);
    const [objectname, objecttype, symref, refname] = parts;
    if (!isSha40(objectname) || !capturedTest(OBJECT_TYPE_PATTERN, objecttype)) {
      deny('git_execution_failed', pathLabel);
    }
    if (typeof refname !== 'string' || refname.length === 0) deny('git_execution_failed', pathLabel);
    records.push(freezeRecord(
      ['objectname', 'objecttype', 'symref', 'refname'],
      { objectname, objecttype, symref, refname },
    ));
  }
  return capturedFreeze(records);
}

function canonicalRecords(records) {
  return canonicalJsonStringify(records);
}

async function observeDeclaredRefs(session, repositoryPath, expectedRefs, pathLabel) {
  const patterns = [];
  for (let i = 0; i < expectedRefs.length; i += 1) patterns.push(expectedRefs[i].ref);
  const lines = await gitLines(
    session,
    [...cwdFlags(repositoryPath), 'for-each-ref',
      '--format=%(objectname)%09%(objecttype)%09%(symref)%09%(refname)',
      '--', ...patterns],
    pathLabel,
  );
  return parseRefRecords(lines, pathLabel);
}

async function assertNoReplaceRefs(session, repositoryPath, pathLabel) {
  const lines = await gitLines(
    session,
    [...cwdFlags(repositoryPath), 'for-each-ref', '--format=%(refname)', '--', 'refs/replace'],
    `${pathLabel}.replace`,
  );
  if (lines.length > 1 || (lines.length === 1 && lines[0].length > 0)) {
    deny('replace_refs_denied', `${pathLabel}.replace`);
  }
}

async function classifyStorage(layout, refValue) {
  const candidates = [
    PATH_JOIN(layout.git_dir, refValue),
    PATH_JOIN(layout.common_dir, refValue),
  ];
  let loose = false;
  let aliased = false;
  for (let i = 0; i < candidates.length; i += 1) {
    const metadata = await lstatOrNull(candidates[i]);
    if (metadata === null) continue;
    if (isSymlinkStat(metadata)) {
      aliased = true;
      continue;
    }
    if (typeof metadata.isFile === 'function' && metadata.isFile()) loose = true;
  }
  return { loose, aliased };
}

function findRecord(records, refValue) {
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].refname === refValue) return records[i];
  }
  return null;
}

async function compareDeclared(layout, expectedRefs, classified, records) {
  const comparisons = [];
  const findings = [];
  const classes = new SET_CTOR();
  let packedCount = 0;
  let looseCount = 0;
  let symbolicCount = 0;
  let missingCount = 0;
  for (let i = 0; i < expectedRefs.length; i += 1) {
    const expected = expectedRefs[i];
    const classed = classified[i];
    const record = findRecord(records, expected.ref);
    const storageProbe = await classifyStorage(layout, expected.ref);
    let outcome = 'match';
    let storage = 'unknown';
    if (record === null) {
      outcome = 'missing_ref';
      storage = 'absent';
      missingCount += 1;
    } else if (record.refname !== expected.ref) {
      outcome = 'aliased_ref';
      storage = 'unknown';
    } else if (typeof record.symref === 'string' && record.symref.length > 0) {
      outcome = 'symbolic_ref';
      storage = 'symbolic';
      symbolicCount += 1;
    } else if (storageProbe.aliased) {
      outcome = 'aliased_ref';
      storage = 'loose';
    } else if (record.objectname !== expected.sha) {
      outcome = 'moved_ref';
      storage = storageProbe.loose ? 'loose' : 'packed';
    } else {
      storage = storageProbe.loose ? 'loose' : 'packed';
    }
    if (storage === 'packed') {
      packedCount += 1;
      classes.add('packed_ref');
    } else if (storage === 'loose') {
      looseCount += 1;
    }
    if (outcome !== 'match') classes.add(outcome);
    const comparison = freezeRecord(COMPARISON_KEYS, {
      outcome: outcome === 'match' ? 'match' : outcome,
      storage,
      ref_class: classed.ref_class,
      protected: classed.protected,
      default_branch_target: classed.default_branch_target,
    });
    comparisons.push(comparison);
    if (outcome !== 'match') {
      findings.push(freezeRecord(
        ['code', 'ref_class', 'storage', 'protected', 'default_branch_target'],
        {
          code: outcome,
          ref_class: classed.ref_class,
          storage,
          protected: classed.protected,
          default_branch_target: classed.default_branch_target,
        },
      ));
    }
  }
  return {
    comparisons: capturedFreeze(comparisons),
    findings,
    classes,
    packedCount,
    looseCount,
    symbolicCount,
    missingCount,
  };
}

function sortedClasses(classes) {
  const values = [];
  for (let i = 0; i < PROTECTED_REF_AUDIT_FINDING_CODES.length; i += 1) {
    const code = PROTECTED_REF_AUDIT_FINDING_CODES[i];
    if (classes.has(code)) values.push(code);
  }
  return capturedFreeze(values);
}

function failingFrom(classes) {
  for (let i = 0; i < PROTECTED_REF_AUDIT_FAILING_CODES.length; i += 1) {
    if (classes.has(PROTECTED_REF_AUDIT_FAILING_CODES[i])) return true;
  }
  return false;
}

function discrepancyKind(_classes) {
  return 'security';
}

function sideEffects() {
  const values = {};
  for (let i = 0; i < PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS.length; i += 1) {
    values[PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS[i]] = false;
  }
  return freezeRecord(PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS, values);
}

function emitFact(request, status, inputDigest, outputDigest, durationMs) {
  const bounded = durationMs > MAX_DURATION_MS ? MAX_DURATION_MS : durationMs;
  const headSha = capturedHasOwn(request.identity, 'head_sha')
    ? request.identity.head_sha
    : request.identity.base_sha;
  return parseVerifiedFactV1({
    fact_id: 'protected-ref-audit',
    fact_kind: 'git_identity',
    status,
    code: 'host_observed',
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    sequence: request.sequence,
    subject: 'protected-refs',
    authority: 'platform_git',
    method: 'protected_ref_snapshot_compare',
    input_digest: inputDigest,
    output_digest: outputDigest,
    exit_code: status === 'verified' ? 0 : 1,
    duration_ms: bounded,
    truncated: false,
    payload: { base_sha: request.identity.base_sha, head_sha: headSha },
    artifact_digests: [],
  });
}

function emitDiscrepancy(request, classes) {
  const kind = discrepancyKind(classes);
  return parseEvidenceDiscrepancyV1({
    discrepancy_id: 'protected-ref-audit',
    discrepancy_kind: kind,
    status: 'recorded',
    code: 'security_boundary',
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    sequence: request.sequence,
    claim_ids: [],
    fact_ids: ['protected-ref-audit'],
    artifact_digests: [],
  });
}

export async function auditProtectedRefsV1(input, options) {
  const request = parseProtectedRefAuditRequestV1(input);
  const parsedOptions = parseOptions(options);
  assertAuthorityInspect(request);
  const pathLabel = 'protected_ref_audit';
  const session = createSession(parsedOptions.spawn);
  const layout = await observeRepositoryKind(session, request.repository_path, pathLabel);
  await assertNoReplaceRefs(session, request.repository_path, pathLabel);
  const first = await observeDeclaredRefs(
    session, request.repository_path, request.expected_refs, `${pathLabel}.refs`,
  );
  const compared = await compareDeclared(
    layout, request.expected_refs, request.classified, first,
  );
  const second = await observeDeclaredRefs(
    session, request.repository_path, request.expected_refs, `${pathLabel}.refs_repeat`,
  );
  if (canonicalRecords(first) !== canonicalRecords(second)) {
    compared.classes.add('race_detected');
    compared.findings.push(freezeRecord(
      ['code', 'ref_class', 'storage', 'protected', 'default_branch_target'],
      {
        code: 'race_detected',
        ref_class: 'unclassified',
        storage: 'unknown',
        protected: true,
        default_branch_target: false,
      },
    ));
  }
  const observedClasses = sortedClasses(compared.classes);
  const failed = failingFrom(compared.classes);
  const status = failed ? 'failed' : 'verified';
  const durationMs = MATH_MAX(0, MATH_FLOOR(Date.now() - session.startedAt));
  const inputDigest = digestOf({
    expected_refs: request.expected_refs,
    base_sha: request.identity.base_sha,
  });
  const outputDigest = digestOf({
    comparisons: compared.comparisons,
    observed_classes: observedClasses,
    repository_kind: layout.kind,
  });
  const fact = emitFact(request, status, inputDigest, outputDigest, durationMs);
  const discrepancies = failed ? capturedFreeze([emitDiscrepancy(request, compared.classes)]) : capturedFreeze([]);
  const observation = freezeRecord(
    ['command_count', 'compared_count', 'duration_ms', 'loose_count', 'missing_count',
      'packed_count', 'symbolic_count'],
    {
      command_count: session.commands,
      compared_count: request.expected_refs.length,
      duration_ms: durationMs,
      loose_count: compared.looseCount,
      missing_count: compared.missingCount,
      packed_count: compared.packedCount,
      symbolic_count: compared.symbolicCount,
    },
  );
  return freezeRecord(RECEIPT_KEYS, {
    schema: PROTECTED_REF_AUDIT_SCHEMA_ID,
    version: PROTECTED_REF_AUDIT_VERSION,
    status,
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    base_sha: request.identity.base_sha,
    repository_kind: layout.kind,
    comparisons: compared.comparisons,
    findings: capturedFreeze(compared.findings),
    observed_classes: observedClasses,
    facts: capturedFreeze([fact]),
    discrepancies,
    side_effects: sideEffects(),
    observation,
  });
}

export function describeProtectedRefAuditV1() {
  return freezeData(capturedFreeze({
    schema: PROTECTED_REF_AUDIT_SCHEMA_ID,
    version: PROTECTED_REF_AUDIT_VERSION,
    rule: 'read_only_live_protected_ref_compare',
    max_audit_refs: MAX_AUDIT_REFS,
    max_audit_git_args: MAX_AUDIT_GIT_ARGS,
    readonly_git_commands: PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS,
    git_spawn_posture: 'argv_only_p29_inspect_env_no_optional_locks',
    inspect_env: GIT_INSPECT_ENV,
    finding_codes: PROTECTED_REF_AUDIT_FINDING_CODES,
    failing_codes: PROTECTED_REF_AUDIT_FAILING_CODES,
    repository_kinds: PROTECTED_REF_AUDIT_REPOSITORY_KINDS,
    checks: PROTECTED_REF_AUDIT_CHECKS,
    error_codes: PROTECTED_REF_AUDIT_ERROR_CODES,
    side_effect_nonclaims: PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS,
    composed_surfaces: capturedFreeze({
      git_authority: 'P28 classifyRefV1/isProtectedRefV1/classifyGitOperationV1/parseGitAuthorityPolicyV1',
      credential_isolation: 'P29 GIT_INSPECT_ENV and denyWorkerRemoteMutation',
      evidence: 'P13 git_identity + protected_ref_snapshot_compare',
      api_or_orchestration: 'not invoked; P30 is library observation only',
      remote_mutation: 'denied',
    }),
  }));
}

capturedFreeze(parseProtectedRefAuditRequestV1);
capturedFreeze(auditProtectedRefsV1);
capturedFreeze(describeProtectedRefAuditV1);
