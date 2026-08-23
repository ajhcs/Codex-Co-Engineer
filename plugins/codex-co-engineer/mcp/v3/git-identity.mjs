// GitIdentityV1 — independently derived repository identity, base-ref, and
// candidate-head facts (ADR 0001 identifiers `immutable_repo_base_identity`,
// `exact_identities`, `bounded_evidence`,
// `gate_a_exact_run_child_provider_workspace_git_identity`).
//
// Additive v3 module for W13-P14. It observes Git from the local repository
// through argv execution and never from provider claims. It binds repository
// path identity, expected base ref/name, exact base SHA, candidate head SHA,
// object types, reachability, ancestry, merge-base identity, and
// rewritten/stale history into P13 VerifiedFactV1 / EvidenceDiscrepancyV1
// snapshots. It does not own P15 scope/read-only/merge-commit checks, P16A
// trusted command policy, P28 Git mutation, or provider/workspace dispatch.
//
// Observation is fail-closed: spawn is argv-only (no shell), the child
// environment is a closed map that cannot inherit GIT_* / config / replace /
// graft influence, output/time/command counts are bounded, and typed errors
// never echo hostile bytes. Effective local, worktree, include, and includeIf
// config is observed through Git-native listing before ref/object/ancestry
// reads and again before a verified result is returned.

import { Buffer as NodeBuffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat as nodeLstat,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
} from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
  MAX_DURATION_MS,
  MAX_SEQUENCE,
} from './evidence-bundle.mjs';
import {
  capturedDescriptor,
  capturedFreeze,
  capturedHasOwn,
  capturedOwnKeys,
  capturedUtf8ByteLength,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
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
  hasOwn,
  optOwn,
} from './selection-json.mjs';

export const GIT_IDENTITY_SCHEMA_ID = 'codex-co-engineer.git-identity.v1';
export const GIT_IDENTITY_VERSION = 1;
export const GIT_EXECUTABLE = '/usr/bin/git';

export const MAX_GIT_COMMANDS = 20;
export const MAX_GIT_ARGS = 32;
export const MAX_GIT_ARG_BYTES = 256;
export const MAX_GIT_OUTPUT_BYTES = 4096;
export const MAX_GIT_TIME_MS = 5_000;
export const MAX_GIT_TOTAL_TIME_MS = 20_000;
export const MAX_BASE_REF_BYTES = 128;
export const MAX_BASE_REF_SEGMENTS = 6;

export const GIT_IDENTITY_REQUEST_ALLOWED_KEYS = capturedFreeze([
  'repository', 'expected_base_ref', 'candidate_head_sha',
  'run_id', 'assignment_id', 'sequence',
]);
export const GIT_IDENTITY_REQUEST_REQUIRED_KEYS = GIT_IDENTITY_REQUEST_ALLOWED_KEYS;
export const GIT_IDENTITY_REPOSITORY_ALLOWED_KEYS = capturedFreeze(['path', 'base_sha']);
export const GIT_IDENTITY_RESULT_ALLOWED_KEYS = capturedFreeze([
  'schema', 'version', 'status', 'facts', 'discrepancies', 'observation',
]);
export const GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS = capturedFreeze([
  'repository_path', 'git_dir', 'base_ref', 'base_sha', 'head_sha',
  'merge_base_sha', 'base_object_type', 'head_object_type',
  'worktree_head_ref', 'ancestor', 'duration_ms',
]);
export const GIT_IDENTITY_OPTIONS_ALLOWED_KEYS = capturedFreeze(['spawn']);
export const GIT_IDENTITY_STATUSES = capturedFreeze(['failed', 'verified']);

export const GIT_IDENTITY_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'ambiguous_ref_denied',
  'bounds_exceeded', 'config_influence_denied', 'detached_ref_denied',
  'env_influence_denied', 'exotic_prototype_denied', 'grafts_denied',
  'hostile_name_denied', 'invalid_format', 'invalid_type', 'missing_key',
  'non_commit_object', 'non_enumerable_property_denied', 'own_undefined_denied',
  'out_of_range', 'proxy_denied', 'replace_refs_denied', 'repository_invalid',
  'repository_missing', 'rewritten_history', 'stale_base', 'symbolic_ref_drift',
  'symbol_key_denied', 'unborn_ref_denied', 'unknown_key', 'unreachable_head',
  'wrong_merge_base', 'git_execution_failed',
]);

const PRIVATE_BASE_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/u;
const PRIVATE_OBJECT_TYPE_PATTERN = /^(?:blob|commit|tag|tree)$/u;
const PRIVATE_TRUE_FALSE_PATTERN = /^(?:true|false)$/u;
const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const GIT_BASE_REF_PATTERN = new RegExp(
  PRIVATE_BASE_REF_PATTERN.source, PRIVATE_BASE_REF_PATTERN.flags,
);

const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const MATH_FLOOR = Math.floor;
const MATH_MAX = Math.max;
const MATH_MIN = Math.min;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PUSH = Array.prototype.push;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const BUFFER_IS_BUFFER = NodeBuffer.isBuffer.bind(NodeBuffer);
const CRYPTO_CREATE_HASH = createHash;
const HASH_PROTOTYPE = Object.getPrototypeOf(CRYPTO_CREATE_HASH('sha256'));
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const PATH_JOIN = path.join;
const PATH_RESOLVE = path.resolve;
const SPAWN = nodeSpawn;
const LSTAT = nodeLstat;
const READDIR = nodeReaddir;
const READFILE = nodeReadFile;
const REALPATH = nodeRealpath;
const REFLECT_APPLY = Reflect.apply;
const IS_PROXY = utilTypes.isProxy;
const MAX_LAYOUT_FILE_BYTES = 4096;
const MAX_CONFIG_FILE_BYTES = 65_536;
const PROVENANCE_CONFIG_PATTERN = /(?:^|\n)[ \t]*(?:promisor|partialclonefilter|partialclone)[ \t]*=/u;
const EFFECTIVE_PROVENANCE_KEY_PATTERN =
  /^(?:extensions\.partialclone|remote\..+\.(?:promisor|partialclonefilter))$/iu;
const EFFECTIVE_CONFIG_LIST_ARGS = capturedFreeze([
  'config', '--includes', '--show-origin', '--show-scope', '--list', '-z',
]);

const CLOSED_GIT_ENV = capturedFreeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ALLOW_PROTOCOL: '',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_ASKPASS: '',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
});

const GIT_ISOLATION_FLAGS = capturedFreeze([
  '--no-replace-objects',
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c', 'core.useReplaceRefs=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'gc.auto=0',
  '-c', 'advice.detachedHead=false',
  '-c', 'log.showSignature=false',
]);

const FORBIDDEN_ENV_KEYS = capturedFreeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE', 'GIT_QUARANTINE_PATH',
  'GIT_PROXY_COMMAND', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_TRACE',
  'GIT_TRACE2', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
]);

export const GIT_CLOSED_ENV = CLOSED_GIT_ENV;

function contractError(code, path, message) {
  return new RunContractV1Error(code, path, message);
}

function asContractError(error, path, code = 'git_execution_failed') {
  if (error instanceof RunContractV1Error) return error;
  return contractError(code, path, `${path} could not complete a git observation.`);
}

function isSymlinkStat(metadata) {
  return typeof metadata?.isSymbolicLink === 'function' && metadata.isSymbolicLink();
}

function assertOwnedHandle(value, path) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    fail('git_execution_failed', path, `${path} could not start a git observation.`);
  }
  try {
    if (IS_PROXY(value)) {
      fail('proxy_denied', path,
        `${path} is a live or revoked Proxy; git observation accepts owned process handles only.`);
    }
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    fail('git_execution_failed', path, `${path} could not start a git observation.`);
  }
}

function readHandleField(handle, key, path) {
  assertOwnedHandle(handle, path);
  let value;
  try {
    value = handle[key];
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    fail('git_execution_failed', path, `${path} could not start a git observation.`);
  }
  if (value !== null && value !== undefined
    && (typeof value === 'object' || typeof value === 'function')) {
    assertOwnedHandle(value, path);
  }
  return value;
}

function invokeHandle(handle, key, args, path) {
  const method = readHandleField(handle, key, path);
  if (typeof method !== 'function') {
    fail('git_execution_failed', path, `${path} could not start a git observation.`);
  }
  try {
    return REFLECT_APPLY(method, handle, args);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    fail('git_execution_failed', path, `${path} could not start a git observation.`);
  }
}

function ownedChunk(chunk, path) {
  try {
    if (typeof chunk === 'string') return BUFFER_FROM(chunk, 'utf8');
    if (BUFFER_IS_BUFFER(chunk)) return BUFFER_FROM(chunk);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
  }
  fail('git_execution_failed', path, `${path} could not complete a git observation.`);
}

function assertClosedKeySet(input, allowedKeys, path) {
  let ownKeys;
  try {
    ownKeys = capturedOwnKeys(input);
  } catch {
    fail('invalid_type', path, `${path} keys could not be inspected safely.`);
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', path,
        `${path} carries a symbol property; git identity records are direct JSON only.`);
    }
    let allowed = false;
    for (let allowedIndex = 0; allowedIndex < allowedKeys.length; allowedIndex += 1) {
      if (allowedKeys[allowedIndex] === key) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      fail('unknown_key', path, `${path} carries a key outside the closed vocabulary.`);
    }
  }
}

function assertNestedClosedKeys(input, key, allowedKeys, path) {
  const descriptor = capturedDescriptor(input, key);
  if (descriptor === undefined) return;
  if (descriptor.get !== undefined || descriptor.set !== undefined) return;
  const value = descriptor.value;
  if (value === null || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) return;
  try {
    if (IS_PROXY(value)) return;
  } catch {
    return;
  }
  assertClosedKeySet(value, allowedKeys, `${path}.${key}`);
}

async function lstatOrNull(target) {
  try {
    return await LSTAT(target);
  } catch {
    return null;
  }
}

function oneLayoutLine(text, path, code) {
  if (typeof text !== 'string') {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  let value = text;
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.endsWith('\r')) value = value.slice(0, -1);
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  return value;
}

function resolveLayoutPath(raw, fromDir, path, code) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  const resolved = PATH_IS_ABSOLUTE(raw) ? PATH_RESOLVE(raw) : PATH_RESOLVE(fromDir, raw);
  if (!PATH_IS_ABSOLUTE(resolved) || PATH_RESOLVE(resolved) !== resolved) {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  return resolved;
}

function isDirectChildPath(parent, child) {
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  if (!child.startsWith(prefix)) return false;
  const rest = child.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/') && rest !== '.' && rest !== '..';
}

async function readBoundedUtf8(target, maxBytes, path, code) {
  const metadata = await lstatOrNull(target);
  if (metadata === null) return null;
  if (isSymlinkStat(metadata) || typeof metadata.isFile !== 'function' || !metadata.isFile()) {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  if (typeof metadata.size === 'number' && metadata.size > maxBytes) {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  let text;
  try {
    text = await READFILE(target, { encoding: 'utf8' });
  } catch {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  if (typeof text !== 'string' || BUFFER_BYTE_LENGTH(text) > maxBytes) {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  return text;
}

async function realpathOf(target, path, code) {
  try {
    return await REALPATH(target);
  } catch {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
}

async function assertDirectoryNotSymlink(target, path, code) {
  let metadata;
  try {
    metadata = await LSTAT(target);
  } catch {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  if (isSymlinkStat(metadata) || typeof metadata.isDirectory !== 'function' || !metadata.isDirectory()) {
    fail(code, path, `${path} is not a trusted git layout.`);
  }
  return realpathOf(target, path, code);
}

async function assertNoExternalObjectProvenance(gitCommonDir, path) {
  await assertDirectoryNotSymlink(
    PATH_JOIN(gitCommonDir, 'objects'), path, 'config_influence_denied',
  );
  const infoDir = PATH_JOIN(gitCommonDir, 'objects', 'info');
  const alternateNames = ['alternates', 'http-alternates'];
  for (let index = 0; index < alternateNames.length; index += 1) {
    const target = PATH_JOIN(infoDir, alternateNames[index]);
    if (await lstatOrNull(target) !== null) {
      fail('config_influence_denied', path,
        `${path} must not observe external object provenance.`);
    }
  }
  const packDir = PATH_JOIN(gitCommonDir, 'objects', 'pack');
  const packMeta = await lstatOrNull(packDir);
  if (packMeta !== null) {
    if (isSymlinkStat(packMeta)
      || typeof packMeta.isDirectory !== 'function'
      || !packMeta.isDirectory()) {
      fail('config_influence_denied', path,
        `${path} must not observe external object provenance.`);
    }
    let names;
    try {
      names = await READDIR(packDir);
    } catch {
      fail('config_influence_denied', path,
        `${path} must not observe external object provenance.`);
    }
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (typeof name === 'string' && name.endsWith('.promisor')) {
        fail('config_influence_denied', path,
          `${path} must not observe external object provenance.`);
      }
    }
  }
  const configText = await readBoundedUtf8(
    PATH_JOIN(gitCommonDir, 'config'), MAX_CONFIG_FILE_BYTES, path, 'config_influence_denied',
  );
  if (configText !== null && PROVENANCE_CONFIG_PATTERN.test(configText)) {
    fail('config_influence_denied', path,
      `${path} must not observe external object provenance.`);
  }
}

function denyExternalObjectProvenance(path) {
  fail('config_influence_denied', path,
    `${path} must not observe external object provenance.`);
}

function isProhibitedEffectiveConfigKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  EFFECTIVE_PROVENANCE_KEY_PATTERN.lastIndex = 0;
  return EFFECTIVE_PROVENANCE_KEY_PATTERN.test(key);
}

function assertNoProhibitedEffectiveConfig(stdout, path) {
  if (typeof stdout !== 'string') denyExternalObjectProvenance(path);
  if (stdout.length === 0) return;
  const fields = stdout.split('\0');
  let limit = fields.length;
  if (limit > 0 && fields[limit - 1] === '') limit -= 1;
  if (limit % 3 !== 0) {
    fail('git_execution_failed', path, `${path} could not complete a git observation.`);
  }
  for (let index = 0; index < limit; index += 3) {
    const record = fields[index + 2];
    if (typeof record !== 'string' || record.length === 0) continue;
    const newline = record.indexOf('\n');
    const key = newline === -1 ? record : record.slice(0, newline);
    if (isProhibitedEffectiveConfigKey(key)) denyExternalObjectProvenance(path);
  }
}

async function assertNoEffectiveProvenanceConfig(session, flags, path) {
  const result = await gitMaybe(
    session,
    [...flags, ...EFFECTIVE_CONFIG_LIST_ARGS],
    `${path}.config`,
  );
  if (result.exit_code !== 0) {
    fail('git_execution_failed', path, `${path} could not complete a git observation.`);
  }
  assertNoProhibitedEffectiveConfig(result.stdout, path);
}

function parseGitFile(contents, worktreePath, path) {
  const line = oneLayoutLine(contents, path, 'repository_invalid');
  if (line.length < 7 || line.slice(0, 7) !== 'gitdir:') {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  return resolveLayoutPath(line.slice(7).trim(), worktreePath, path, 'repository_invalid');
}

async function assertLinkedWorktree(repositoryPath, gitFilePath, observedGitDir, path) {
  const gitFileText = await readBoundedUtf8(
    gitFilePath, MAX_LAYOUT_FILE_BYTES, path, 'repository_invalid',
  );
  if (gitFileText === null) {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  const declaredGitDir = parseGitFile(gitFileText, repositoryPath, path);
  const declaredReal = await assertDirectoryNotSymlink(
    declaredGitDir, path, 'repository_invalid',
  );
  const observedReal = await realpathOf(observedGitDir, path, 'repository_invalid');
  if (declaredReal !== observedReal) {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  const commondirText = await readBoundedUtf8(
    PATH_JOIN(declaredGitDir, 'commondir'), MAX_LAYOUT_FILE_BYTES, path, 'repository_invalid',
  );
  if (commondirText === null) {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  const commonDir = await assertDirectoryNotSymlink(
    resolveLayoutPath(
      oneLayoutLine(commondirText, path, 'repository_invalid'),
      declaredGitDir, path, 'repository_invalid',
    ),
    path,
    'repository_invalid',
  );
  const worktreesRoot = await assertDirectoryNotSymlink(
    PATH_JOIN(commonDir, 'worktrees'), path, 'repository_invalid',
  );
  if (!isDirectChildPath(worktreesRoot, declaredReal)) {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  const backpointerText = await readBoundedUtf8(
    PATH_JOIN(declaredGitDir, 'gitdir'), MAX_LAYOUT_FILE_BYTES, path, 'repository_invalid',
  );
  if (backpointerText === null) {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  const backpointer = resolveLayoutPath(
    oneLayoutLine(backpointerText, path, 'repository_invalid'),
    declaredGitDir, path, 'repository_invalid',
  );
  const expectedGitFile = PATH_JOIN(repositoryPath, '.git');
  let resolvedBack;
  try {
    resolvedBack = await REALPATH(backpointer);
  } catch {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  let resolvedGitFile;
  try {
    resolvedGitFile = await REALPATH(expectedGitFile);
  } catch {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  if (resolvedBack !== resolvedGitFile && resolvedBack !== repositoryPath) {
    fail('repository_invalid', path, `${path} is not a trusted git layout.`);
  }
  await assertNoExternalObjectProvenance(commonDir, path);
}

async function assertSafeRepositoryLayout(repositoryPath, observedGitDir, path) {
  const gitFilePath = PATH_JOIN(repositoryPath, '.git');
  const layoutPath = `${path}.repository.path`;
  let metadata;
  try {
    metadata = await LSTAT(gitFilePath);
  } catch {
    fail('repository_invalid', layoutPath,
      `${layoutPath} is not a git worktree root.`);
  }
  if (isSymlinkStat(metadata)) {
    fail('repository_invalid', layoutPath, `${layoutPath} is not a trusted git layout.`);
  }
  if (typeof metadata.isDirectory === 'function' && metadata.isDirectory()) {
    const resolved = await realpathOf(gitFilePath, layoutPath, 'repository_invalid');
    const observedReal = await realpathOf(observedGitDir, layoutPath, 'repository_invalid');
    if (resolved !== observedReal) {
      fail('repository_invalid', layoutPath, `${layoutPath} is not a trusted git layout.`);
    }
    await assertNoExternalObjectProvenance(gitFilePath, path);
    return;
  }
  if (typeof metadata.isFile !== 'function' || !metadata.isFile()) {
    fail('repository_invalid', layoutPath, `${layoutPath} is not a trusted git layout.`);
  }
  await assertLinkedWorktree(repositoryPath, gitFilePath, observedGitDir, path);
}

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!capturedHasOwn(values, key)) continue;
    OBJECT_DEFINE_PROPERTY(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function requiredKeys(input, keys, path) {
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!hasOwn(input, key)) {
      fail('missing_key', `${path}.${key}`,
        `${path}.${key} is required (${GIT_IDENTITY_SCHEMA_ID}); git identity records have no hidden defaults.`);
    }
  }
}

function digestCanonical(value) {
  const canonical = canonicalJsonStringify(value);
  const hash = CRYPTO_CREATE_HASH('sha256');
  HASH_UPDATE.call(hash, BUFFER_FROM(canonical, 'utf8'));
  return HASH_DIGEST.call(hash, 'hex');
}

function assertClosedEnv(env, path) {
  if (env === null || typeof env !== 'object' || ARRAY_IS_ARRAY(env)) {
    fail('env_influence_denied', path, `${path} must be the closed git environment map.`);
  }
  for (let index = 0; index < FORBIDDEN_ENV_KEYS.length; index += 1) {
    const key = FORBIDDEN_ENV_KEYS[index];
    if (capturedHasOwn(env, key)) {
      fail('env_influence_denied', path,
        `${path} must not carry git configuration, replace, graft, or directory overrides.`);
    }
  }
}

function assertGitArgv(args, path) {
  if (!ARRAY_IS_ARRAY(args)) fail('invalid_type', path, `${path} must be an argv array.`);
  if (args.length > MAX_GIT_ARGS) {
    fail('bounds_exceeded', path, `${path} exceeds the git argv arity cap.`);
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string' || arg.length === 0) {
      fail('hostile_name_denied', `${path}[${index}]`, `${path} entries must be non-empty strings.`);
    }
    if (arg.includes('\0')) {
      fail('hostile_name_denied', `${path}[${index}]`, `${path} entries must not contain NUL.`);
    }
    if (BUFFER_BYTE_LENGTH(arg) > MAX_GIT_ARG_BYTES) {
      fail('bounds_exceeded', `${path}[${index}]`, `${path} exceeds the git argument byte cap.`);
    }
  }
}

function oneLine(text, path, pattern) {
  if (typeof text !== 'string') {
    fail('git_execution_failed', path, `${path} did not produce a bounded git observation.`);
  }
  let value = text;
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.endsWith('\r')) value = value.slice(0, -1);
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    fail('git_execution_failed', path, `${path} produced extra git output.`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
  }
  return value;
}

function parseObservedSha(text, path) {
  const value = oneLine(text, path);
  if (!isSha40(value)) {
    fail('git_execution_failed', path, `${path} did not resolve to an exact commit SHA.`);
  }
  return value;
}

function assertBaseRefName(value, path) {
  if (typeof value !== 'string') {
    fail('invalid_type', path, `${path} must be a git branch ref string.`);
  }
  if (capturedUtf8ByteLength(value) > MAX_BASE_REF_BYTES) {
    fail('out_of_range', path, `${path} exceeds the base-ref byte cap.`);
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')
    || value.startsWith('-') || value.includes('..') || value.includes('@{')
    || value.includes('\\') || value.includes('//') || value.endsWith('.lock')
    || value.endsWith('.') || value.includes('~') || value.includes('^')
    || value.includes(':') || value.includes('?') || value.includes('*')
    || value.includes('[') || value.includes(' ') || value.includes('@')
    || value === 'HEAD' || value === 'refs/heads/HEAD') {
    fail('hostile_name_denied', path, `${path} is not an allowed base branch ref.`);
  }
  const segments = value.split('/');
  if (segments.length > MAX_BASE_REF_SEGMENTS) {
    fail('out_of_range', path, `${path} exceeds the base-ref segment cap.`);
  }
  if (!PRIVATE_BASE_REF_PATTERN.test(value)) {
    fail('hostile_name_denied', path, `${path} is not an allowed base branch ref.`);
  }
  return value;
}

function parseRepository(input, path) {
  const value = optOwn(input, 'repository');
  assertPlainObject(value, 'invalid_type', path, path);
  assertClosedKeySet(value, GIT_IDENTITY_REPOSITORY_ALLOWED_KEYS, path);
  requiredKeys(value, GIT_IDENTITY_REPOSITORY_ALLOWED_KEYS, path);
  const repositoryPath = optOwn(value, 'path');
  assertRepositoryPath(repositoryPath, `${path}.path`);
  const baseSha = optOwn(value, 'base_sha');
  assertBaseSha(baseSha, `${path}.base_sha`);
  return freezeRecord(GIT_IDENTITY_REPOSITORY_ALLOWED_KEYS, {
    path: repositoryPath, base_sha: baseSha,
  });
}

function assertSequence(value, path) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value)) {
    fail('invalid_type', path, `${path} must be a safe integer sequence.`);
  }
  if (value < 0 || value > MAX_SEQUENCE - 1) {
    fail('out_of_range', path,
      `${path} must be an injected sequence in 0..${MAX_SEQUENCE - 1} so the paired head fact can bind.`);
  }
  return value;
}

export function parseGitIdentityRequestV1(input, path = 'git_identity') {
  assertPlainObject(input, 'invalid_type', path, `${path}`);
  assertClosedKeySet(input, GIT_IDENTITY_REQUEST_ALLOWED_KEYS, path);
  assertNestedClosedKeys(input, 'repository', GIT_IDENTITY_REPOSITORY_ALLOWED_KEYS, path);
  assertDirectJsonClosure(input, path);
  requiredKeys(input, GIT_IDENTITY_REQUEST_REQUIRED_KEYS, path);
  const repository = parseRepository(input, `${path}.repository`);
  const expectedBaseRef = assertBaseRefName(
    optOwn(input, 'expected_base_ref'), `${path}.expected_base_ref`,
  );
  const candidateHeadSha = optOwn(input, 'candidate_head_sha');
  assertBaseSha(candidateHeadSha, `${path}.candidate_head_sha`);
  const runId = optOwn(input, 'run_id');
  assertRunId(runId, `${path}.run_id`);
  const assignmentId = optOwn(input, 'assignment_id');
  if (!isAssignmentId(assignmentId)) {
    fail('invalid_format', `${path}.assignment_id`,
      `${path}.assignment_id violates the assignment-id grammar.`);
  }
  const sequence = assertSequence(optOwn(input, 'sequence'), `${path}.sequence`);
  return freezeRecord(GIT_IDENTITY_REQUEST_ALLOWED_KEYS, {
    repository,
    expected_base_ref: expectedBaseRef,
    candidate_head_sha: candidateHeadSha,
    run_id: runId,
    assignment_id: assignmentId,
    sequence,
  });
}

function parseOptions(options, path = 'options') {
  if (options === undefined) {
    return freezeRecord(GIT_IDENTITY_OPTIONS_ALLOWED_KEYS, { spawn: SPAWN });
  }
  assertNotProxy(options, path);
  assertPlainObject(options, 'invalid_type', path, path);
  assertClosedKeySet(options, GIT_IDENTITY_OPTIONS_ALLOWED_KEYS, path);
  let spawn = SPAWN;
  if (hasOwn(options, 'spawn')) {
    spawn = optOwn(options, 'spawn');
    if (typeof spawn !== 'function') {
      fail('invalid_type', `${path}.spawn`, `${path}.spawn must be a spawn function.`);
    }
    assertNotProxy(spawn, `${path}.spawn`);
  }
  return freezeRecord(GIT_IDENTITY_OPTIONS_ALLOWED_KEYS, { spawn });
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

function assertDeadline(session, path) {
  if (Date.now() >= session.deadlineAt) {
    fail('bounds_exceeded', path, `${path} exceeds the git wall-clock cap.`);
  }
}

function remainingMs(session) {
  const left = session.deadlineAt - Date.now();
  return left > 0 ? left : 0;
}

function assertSessionBounds(session, path) {
  if (session.commands >= MAX_GIT_COMMANDS) {
    fail('bounds_exceeded', path, `${path} exceeds the git command-count cap.`);
  }
  assertDeadline(session, path);
}

function listenStream(stream, event, handler, path) {
  if (stream === undefined || stream === null) return;
  invokeHandle(stream, 'on', [event, handler], path);
}

function runGit(session, args, path) {
  assertGitArgv(args, `${path}.args`);
  assertSessionBounds(session, path);
  const budget = remainingMs(session);
  if (budget <= 0) {
    fail('bounds_exceeded', path, `${path} exceeds the git wall-clock cap.`);
  }
  session.commands += 1;
  const argv = [GIT_EXECUTABLE, ...GIT_ISOLATION_FLAGS, ...args];
  assertGitArgv(argv, `${path}.argv`);
  const spawnOptions = {
    cwd: '/',
    env: CLOSED_GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
  assertClosedEnv(spawnOptions.env, `${path}.env`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = session.spawn(GIT_EXECUTABLE, argv.slice(1), spawnOptions);
    } catch (error) {
      reject(contractError(
        'git_execution_failed', path, `${path} could not start a git observation.`,
      ));
      return;
    }
    try {
      assertOwnedHandle(child, path);
    } catch (error) {
      reject(asContractError(error, path));
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
      if (error) reject(asContractError(error, path));
      else resolve(result);
    };
    const exceed = () => {
      if (exceeded) return;
      exceeded = true;
      try { invokeHandle(child, 'kill', ['SIGKILL'], path); } catch { /* already exited */ }
      finish(contractError(
        'bounds_exceeded', path, `${path} exceeded a closed git output or time bound.`,
      ));
    };
    timer = setTimeout(exceed, MATH_MIN(MAX_GIT_TIME_MS, budget));
    const onChunk = (target, getSize, setSize) => (chunk) => {
      try {
        const owned = ownedChunk(chunk, path);
        const next = getSize() + owned.length;
        setSize(next);
        if (next > MAX_GIT_OUTPUT_BYTES) {
          exceed();
          return;
        }
        REFLECT_APPLY(ARRAY_PUSH, target, [owned]);
      } catch (error) {
        finish(asContractError(error, path));
      }
    };
    try {
      listenStream(
        readHandleField(child, 'stdout', path),
        'data',
        onChunk(stdoutChunks, () => stdoutBytes, (value) => { stdoutBytes = value; }),
        path,
      );
      listenStream(
        readHandleField(child, 'stderr', path),
        'data',
        onChunk(stderrChunks, () => stderrBytes, (value) => { stderrBytes = value; }),
        path,
      );
      invokeHandle(child, 'once', ['error', () => {
        finish(contractError(
          'git_execution_failed', path, `${path} could not complete a git observation.`,
        ));
      }], path);
      invokeHandle(child, 'once', ['close', (code, signal) => {
        if (exceeded) return;
        try {
          if (Date.now() >= session.deadlineAt) {
            finish(contractError(
              'bounds_exceeded', path, `${path} exceeds the git wall-clock cap.`,
            ));
            return;
          }
          const stdout = BUFFER_CONCAT(stdoutChunks).toString('utf8');
          const stderr = BUFFER_CONCAT(stderrChunks).toString('utf8');
          if (signal !== null && signal !== undefined) {
            finish(contractError(
              'git_execution_failed', path, `${path} could not complete a git observation.`,
            ));
            return;
          }
          finish(null, {
            exit_code: typeof code === 'number' ? code : 1,
            stdout,
            stderr,
          });
        } catch (error) {
          finish(asContractError(error, path));
        }
      }], path);
    } catch (error) {
      try { invokeHandle(child, 'kill', ['SIGKILL'], path); } catch { /* already exited */ }
      finish(asContractError(error, path));
    }
  });
}

async function gitLine(session, args, path, pattern) {
  const result = await runGit(session, args, path);
  if (result.exit_code !== 0) {
    fail('git_execution_failed', path, `${path} could not complete a git observation.`);
  }
  return oneLine(result.stdout, path, pattern);
}

async function gitLines(session, args, path, count) {
  const result = await runGit(session, args, path);
  if (result.exit_code !== 0) {
    fail('git_execution_failed', path, `${path} could not complete a git observation.`);
  }
  let text = result.stdout;
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.includes('\0') || text.includes('\r')) {
    fail('git_execution_failed', path, `${path} produced extra git output.`);
  }
  const lines = text.split('\n');
  if (lines.length !== count) {
    fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
  }
  return lines;
}

async function gitMaybe(session, args, path) {
  const result = await runGit(session, args, path);
  return result;
}

function cwdFlags(repositoryPath) {
  return capturedFreeze(['-C', repositoryPath]);
}

function repoFlags(repositoryPath, gitDir) {
  return capturedFreeze(['-C', repositoryPath, '--git-dir', gitDir]);
}

async function assertLocalRepository(session, repositoryPath, path) {
  let metadata;
  try {
    metadata = await LSTAT(repositoryPath);
  } catch {
    fail('repository_missing', `${path}.repository.path`,
      `${path}.repository.path does not identify an accessible directory.`);
  }
  if (typeof metadata?.isDirectory !== 'function' || !metadata.isDirectory()
    || (typeof metadata.isSymbolicLink === 'function' && metadata.isSymbolicLink())) {
    fail('repository_invalid', `${path}.repository.path`,
      `${path}.repository.path must be a real directory, not a symlink or file.`);
  }
  let resolved;
  try {
    resolved = await REALPATH(repositoryPath);
  } catch {
    fail('repository_missing', `${path}.repository.path`,
      `${path}.repository.path does not identify an accessible directory.`);
  }
  if (resolved !== repositoryPath || !PATH_IS_ABSOLUTE(resolved) || PATH_RESOLVE(resolved) !== resolved) {
    fail('repository_invalid', `${path}.repository.path`,
      `${path}.repository.path must be the real, absolute worktree root.`);
  }
  let identityLines;
  try {
    identityLines = await gitLines(
      session,
      [...cwdFlags(repositoryPath), 'rev-parse', '--path-format=absolute',
        '--is-inside-work-tree', '--is-bare-repository', '--show-toplevel', '--absolute-git-dir'],
      `${path}.repository`,
      4,
    );
  } catch (error) {
    if (error instanceof RunContractV1Error && error.code === 'git_execution_failed') {
      fail('repository_invalid', `${path}.repository.path`,
        `${path}.repository.path is not a git worktree root.`);
    }
    throw error;
  }
  const [inside, bare, toplevel, gitDir] = identityLines;
  if (!PRIVATE_TRUE_FALSE_PATTERN.test(inside) || inside !== 'true') {
    fail('repository_invalid', `${path}.repository.path`,
      `${path}.repository.path is not a git worktree root.`);
  }
  if (!PRIVATE_TRUE_FALSE_PATTERN.test(bare) || bare !== 'false') {
    fail('repository_invalid', `${path}.repository.path`,
      `${path}.repository.path must not be a bare repository.`);
  }
  if (toplevel !== repositoryPath) {
    fail('repository_invalid', `${path}.repository.path`,
      `${path}.repository.path must equal the git worktree toplevel.`);
  }
  if (!PATH_IS_ABSOLUTE(gitDir) || PATH_RESOLVE(gitDir) !== gitDir || gitDir.includes('\0')) {
    fail('repository_invalid', `${path}.repository.path`,
      `${path}.repository.path did not yield an absolute git directory.`);
  }
  return gitDir;
}

async function assertNoReplaceOrGrafts(session, flags, path) {
  const replace = await gitMaybe(
    session,
    [...flags, 'for-each-ref', '--format=%(refname)', '--', 'refs/replace'],
    `${path}.replace`,
  );
  if (replace.exit_code !== 0) {
    fail('replace_refs_denied', `${path}.replace`,
      `${path} could not independently inspect replace refs.`);
  }
  const replaceText = replace.stdout.replace(/\n$/u, '');
  if (replaceText.length > 0) {
    fail('replace_refs_denied', `${path}.replace`,
      `${path} must not observe git replace refs.`);
  }
  const [graftsPath, shallowPath] = await gitLines(
    session,
    [...flags, 'rev-parse', '--path-format=absolute',
      '--git-path', 'info/grafts', '--git-path', 'shallow'],
    `${path}.grafts`,
    2,
  );
  if (!PATH_IS_ABSOLUTE(graftsPath) || PATH_RESOLVE(graftsPath) !== graftsPath) {
    fail('grafts_denied', `${path}.grafts`, `${path} produced a non-absolute grafts path.`);
  }
  if (!PATH_IS_ABSOLUTE(shallowPath) || PATH_RESOLVE(shallowPath) !== shallowPath) {
    fail('rewritten_history', `${path}.shallow`, `${path} produced a non-absolute shallow path.`);
  }
  try {
    await LSTAT(graftsPath);
    fail('grafts_denied', `${path}.grafts`, `${path} must not observe git grafts.`);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
  }
  try {
    await LSTAT(shallowPath);
    fail('rewritten_history', `${path}.shallow`,
      `${path} must not observe shallow history as a complete ancestry.`);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
  }
}

async function observeWorktreeHeadRef(session, flags, path) {
  const result = await gitMaybe(
    session,
    [...flags, 'symbolic-ref', '--quiet', '--end-of-options', 'HEAD'],
    `${path}.HEAD`,
  );
  if (result.exit_code !== 0) {
    fail('detached_ref_denied', `${path}.HEAD`,
      `${path}.HEAD must be attached to a branch ref.`);
  }
  const headRef = oneLine(result.stdout, `${path}.HEAD`, PRIVATE_BASE_REF_PATTERN);
  if (headRef === 'refs/heads/HEAD') {
    fail('hostile_name_denied', `${path}.HEAD`, `${path}.HEAD is not an allowed branch ref.`);
  }
  return headRef;
}

async function observeBaseRef(session, flags, expectedBaseRef, expectedBaseSha, path) {
  const exists = await gitMaybe(
    session,
    [...flags, 'show-ref', '--verify', '--', expectedBaseRef],
    `${path}.expected_base_ref`,
  );
  if (exists.exit_code !== 0) {
    fail('unborn_ref_denied', `${path}.expected_base_ref`,
      `${path}.expected_base_ref does not name an existing commit.`);
  }
  const fullNameResult = await gitMaybe(
    session,
    [...flags, 'rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', expectedBaseRef],
    `${path}.expected_base_ref`,
  );
  if (fullNameResult.exit_code !== 0) {
    fail('unborn_ref_denied', `${path}.expected_base_ref`,
      `${path}.expected_base_ref does not name an existing commit.`);
  }
  const fullName = oneLine(
    fullNameResult.stdout, `${path}.expected_base_ref`, PRIVATE_BASE_REF_PATTERN,
  );
  if (fullName !== expectedBaseRef) {
    fail('symbolic_ref_drift', `${path}.expected_base_ref`,
      `${path}.expected_base_ref resolved to a different ref name.`);
  }
  const asSymbolic = await gitMaybe(
    session,
    [...flags, 'symbolic-ref', '--quiet', '--end-of-options', expectedBaseRef],
    `${path}.expected_base_ref`,
  );
  if (asSymbolic.exit_code === 0) {
    fail('symbolic_ref_drift', `${path}.expected_base_ref`,
      `${path}.expected_base_ref must be a direct branch ref, not a symbolic ref.`);
  }
  const direct = await gitMaybe(
    session,
    [...flags, 'rev-parse', '--verify', '--end-of-options', expectedBaseRef],
    `${path}.expected_base_ref`,
  );
  if (direct.exit_code !== 0) {
    fail('unborn_ref_denied', `${path}.expected_base_ref`,
      `${path}.expected_base_ref does not name an existing commit.`);
  }
  const observedBaseSha = parseObservedSha(direct.stdout, `${path}.expected_base_ref`);
  const objectType = await gitLine(
    session,
    [...flags, 'cat-file', '-t', '--', observedBaseSha],
    `${path}.expected_base_ref`,
    PRIVATE_OBJECT_TYPE_PATTERN,
  );
  if (objectType !== 'commit') {
    fail('non_commit_object', `${path}.expected_base_ref`,
      `${path}.expected_base_ref is not a commit object.`);
  }
  const peeled = await gitMaybe(
    session,
    [...flags, 'rev-parse', '--verify', '--end-of-options', `${expectedBaseRef}^{commit}`],
    `${path}.expected_base_ref`,
  );
  if (peeled.exit_code !== 0) {
    fail('non_commit_object', `${path}.expected_base_ref`,
      `${path}.expected_base_ref does not peel to a commit.`);
  }
  const peeledSha = parseObservedSha(peeled.stdout, `${path}.expected_base_ref`);
  if (peeledSha !== observedBaseSha) {
    fail('non_commit_object', `${path}.expected_base_ref`,
      `${path}.expected_base_ref is not a commit object.`);
  }
  if (expectedBaseSha !== observedBaseSha) {
    const expectedType = await gitMaybe(
      session,
      [...flags, 'cat-file', '-t', '--', expectedBaseSha],
      `${path}.repository.base_sha`,
    );
    if (expectedType.exit_code !== 0) {
      fail('non_commit_object', `${path}.repository.base_sha`,
        `${path}.repository.base_sha is not a readable git object.`);
    }
    const expectedObjectType = oneLine(
      expectedType.stdout, `${path}.repository.base_sha`, PRIVATE_OBJECT_TYPE_PATTERN,
    );
    if (expectedObjectType !== 'commit') {
      fail('non_commit_object', `${path}.repository.base_sha`,
        `${path}.repository.base_sha is not a commit object.`);
    }
  }
  return { sha: observedBaseSha, object_type: objectType };
}

async function observeHeadSha(session, flags, candidateHeadSha, path) {
  const typeResult = await gitMaybe(
    session,
    [...flags, 'cat-file', '-t', '--', candidateHeadSha],
    `${path}.candidate_head_sha`,
  );
  if (typeResult.exit_code !== 0) {
    fail('unreachable_head', `${path}.candidate_head_sha`,
      `${path}.candidate_head_sha is not a readable git object.`);
  }
  const objectType = oneLine(
    typeResult.stdout, `${path}.candidate_head_sha`, PRIVATE_OBJECT_TYPE_PATTERN,
  );
  if (objectType !== 'commit') {
    fail('non_commit_object', `${path}.candidate_head_sha`,
      `${path}.candidate_head_sha is not a commit object.`);
  }
  const peeled = await gitMaybe(
    session,
    [...flags, 'rev-parse', '--verify', '--end-of-options', `${candidateHeadSha}^{commit}`],
    `${path}.candidate_head_sha`,
  );
  if (peeled.exit_code !== 0) {
    fail('non_commit_object', `${path}.candidate_head_sha`,
      `${path}.candidate_head_sha does not peel to a commit.`);
  }
  const observedHeadSha = parseObservedSha(peeled.stdout, `${path}.candidate_head_sha`);
  if (observedHeadSha !== candidateHeadSha) {
    fail('ambiguous_ref_denied', `${path}.candidate_head_sha`,
      `${path}.candidate_head_sha did not resolve to itself.`);
  }
  return { sha: observedHeadSha, object_type: objectType };
}

async function observeAncestry(session, flags, expectedBaseSha, observedBaseSha, headSha, path) {
  const ancestorResult = await gitMaybe(
    session,
    [...flags, 'merge-base', '--is-ancestor', '--', expectedBaseSha, headSha],
    `${path}.ancestry`,
  );
  if (ancestorResult.exit_code !== 0 && ancestorResult.exit_code !== 1) {
    fail('git_execution_failed', `${path}.ancestry`,
      `${path}.ancestry could not complete a merge-base ancestor check.`);
  }
  const ancestor = ancestorResult.exit_code === 0;
  const mergeBaseResult = await gitMaybe(
    session,
    [...flags, 'merge-base', '--all', '--', expectedBaseSha, headSha],
    `${path}.merge_base`,
  );
  let mergeBaseSha = '';
  if (mergeBaseResult.exit_code === 0) {
    const lines = mergeBaseResult.stdout.endsWith('\n')
      ? mergeBaseResult.stdout.slice(0, -1).split('\n')
      : mergeBaseResult.stdout.split('\n');
    if (lines.length !== 1 || !isSha40(lines[0])) {
      mergeBaseSha = '';
    } else {
      mergeBaseSha = lines[0];
    }
  }
  const baseMoved = observedBaseSha !== expectedBaseSha;
  let staleBase = false;
  let rewrittenBase = false;
  if (baseMoved) {
    const expectedStillAncestor = await gitMaybe(
      session,
      [...flags, 'merge-base', '--is-ancestor', '--', expectedBaseSha, observedBaseSha],
      `${path}.stale_base`,
    );
    if (expectedStillAncestor.exit_code === 0) staleBase = true;
    else rewrittenBase = true;
  }
  const wrongMergeBase = !isSha40(mergeBaseSha) || mergeBaseSha !== expectedBaseSha;
  const unreachableHead = ancestor !== true;
  return {
    ancestor,
    merge_base_sha: isSha40(mergeBaseSha) ? mergeBaseSha : '',
    stale_base: staleBase,
    rewritten_base: rewrittenBase,
    wrong_merge_base: wrongMergeBase,
    unreachable_head: unreachableHead,
  };
}

function durationOf(session, path) {
  assertDeadline(session, path);
  return MATH_MAX(0, MATH_FLOOR(Date.now() - session.startedAt));
}

function emitFact(kind, request, inputDigest, outputDigest, status, payload, durationMs) {
  const boundedDuration = durationMs > MAX_DURATION_MS ? MAX_DURATION_MS : durationMs;
  return parseVerifiedFactV1({
    fact_id: kind === 'git_identity' ? 'git-identity' : 'head-sha',
    fact_kind: kind,
    status,
    code: 'host_observed',
    run_id: request.run_id,
    assignment_id: request.assignment_id,
    sequence: kind === 'git_identity' ? request.sequence : request.sequence + 1,
    subject: kind === 'git_identity' ? 'repository' : 'head',
    authority: 'platform_git',
    method: 'ancestry_check',
    input_digest: inputDigest,
    output_digest: outputDigest,
    exit_code: null,
    duration_ms: boundedDuration,
    truncated: false,
    payload,
    artifact_digests: [],
  });
}

function emitDiscrepancy(id, request, factIds, sequence) {
  return parseEvidenceDiscrepancyV1({
    discrepancy_id: id,
    discrepancy_kind: 'integrity',
    status: 'recorded',
    code: 'artifact_integrity_failure',
    run_id: request.run_id,
    assignment_id: request.assignment_id,
    sequence,
    claim_ids: [],
    fact_ids: factIds,
    artifact_digests: [],
  });
}

export async function verifyGitIdentityV1(input, options) {
  const request = parseGitIdentityRequestV1(input);
  const parsedOptions = parseOptions(options);
  const pathLabel = 'git_identity';
  const session = createSession(parsedOptions.spawn);
  const repositoryPath = request.repository.path;
  const gitDir = await assertLocalRepository(session, repositoryPath, pathLabel);
  await assertSafeRepositoryLayout(repositoryPath, gitDir, pathLabel);
  const flags = repoFlags(repositoryPath, gitDir);
  await assertNoEffectiveProvenanceConfig(session, flags, pathLabel);
  await assertNoReplaceOrGrafts(session, flags, pathLabel);
  const worktreeHeadRef = await observeWorktreeHeadRef(session, flags, pathLabel);
  const base = await observeBaseRef(
    session, flags, request.expected_base_ref, request.repository.base_sha, pathLabel,
  );
  const head = await observeHeadSha(
    session, flags, request.candidate_head_sha, pathLabel,
  );
  const ancestry = await observeAncestry(
    session, flags, request.repository.base_sha, base.sha, head.sha, pathLabel,
  );
  const durationMs = durationOf(session, pathLabel);
  const observation = freezeRecord(GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS, {
    repository_path: repositoryPath,
    git_dir: gitDir,
    base_ref: request.expected_base_ref,
    base_sha: base.sha,
    head_sha: head.sha,
    merge_base_sha: ancestry.merge_base_sha,
    base_object_type: base.object_type,
    head_object_type: head.object_type,
    worktree_head_ref: worktreeHeadRef,
    ancestor: ancestry.ancestor,
    duration_ms: durationMs,
  });
  const inputDigest = digestCanonical({
    repository: request.repository,
    expected_base_ref: request.expected_base_ref,
    candidate_head_sha: request.candidate_head_sha,
  });
  const outputDigest = digestCanonical(observation);
  if (!PRIVATE_SHA256_PATTERN.test(inputDigest) || !PRIVATE_SHA256_PATTERN.test(outputDigest)) {
    fail('git_execution_failed', pathLabel, `${pathLabel} could not bind observation digests.`);
  }
  const discrepancies = [];
  const pushDiscrepancy = (id, factIds) => {
    const sequence = request.sequence + discrepancies.length;
    if (sequence > MAX_SEQUENCE) return;
    try {
      REFLECT_APPLY(ARRAY_PUSH, discrepancies, [
        emitDiscrepancy(id, request, factIds, sequence),
      ]);
    } catch (error) {
      if (error instanceof RunContractV1Error && error.code === 'out_of_range') return;
      throw error;
    }
  };
  if (ancestry.stale_base) pushDiscrepancy('stale-base', ['git-identity']);
  if (ancestry.rewritten_base) pushDiscrepancy('rewritten-history', ['git-identity', 'head-sha']);
  if (ancestry.unreachable_head) pushDiscrepancy('unreachable-head', ['head-sha']);
  if (ancestry.wrong_merge_base) pushDiscrepancy('wrong-merge-base', ['git-identity', 'head-sha']);
  const verified = discrepancies.length === 0
    && base.sha === request.repository.base_sha
    && head.sha === request.candidate_head_sha
    && ancestry.ancestor === true
    && ancestry.merge_base_sha === request.repository.base_sha;
  const status = verified ? 'verified' : 'failed';
  const facts = capturedFreeze([
    emitFact(
      'git_identity', request, inputDigest, outputDigest, status,
      { base_sha: request.repository.base_sha, head_sha: request.candidate_head_sha },
      durationMs,
    ),
    emitFact(
      'head_sha', request, inputDigest, outputDigest, status,
      { sha: request.candidate_head_sha },
      durationMs,
    ),
  ]);
  const result = freezeRecord(GIT_IDENTITY_RESULT_ALLOWED_KEYS, {
    schema: GIT_IDENTITY_SCHEMA_ID,
    version: GIT_IDENTITY_VERSION,
    status,
    facts,
    discrepancies: capturedFreeze(discrepancies),
    observation,
  });
  if (status === 'verified') {
    await assertNoEffectiveProvenanceConfig(session, flags, pathLabel);
  }
  assertDeadline(session, pathLabel);
  return result;
}

OBJECT_FREEZE(GIT_IDENTITY_ERROR_CODES);
