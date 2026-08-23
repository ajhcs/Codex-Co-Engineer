// ScopeVerifierV1 — independently derived changed-path ownership, read-only
// mutation, and merge-commit facts (ADR 0001 identifiers
// `disjoint_writer_scopes`, `read_only_verification`,
// `candidate_git_policy_revalidation`, `bounded_evidence`,
// `gate_a_scope_and_read_only_detection`).
//
// Additive v3 module for W16-P15. It consumes only trusted P14 GitIdentityV1
// evidence plus P13 VerifiedFactV1 / EvidenceDiscrepancyV1 snapshots and
// never treats provider claims as authority. It observes the local repository
// through argv execution (`/usr/bin/git`, no shell) and binds content-free
// git_diff / head_sha facts (`platform_git` with `scope_match`,
// `read_only_no_changes`, and `merge_commit_absence`). It does not own P16A
// trusted command policy or runner, P28 Git mutation, P30/P35 composition,
// server/supervisor integration, network, or merge/rebase/push/PR.
//
// Observation is fail-closed: spawn is argv-only, the child environment is
// the P14 closed map (system/global/caller config and protocols disabled),
// output/time/command counts are bounded, typed errors never echo hostile
// bytes, and a pre/post fingerprint mismatch is an observation race.

import { Buffer as NodeBuffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
  MAX_DURATION_MS,
  MAX_SEQUENCE,
} from './evidence-bundle.mjs';
import {
  GIT_CLOSED_ENV,
  GIT_EXECUTABLE,
  GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS,
  GIT_IDENTITY_RESULT_ALLOWED_KEYS,
  GIT_IDENTITY_SCHEMA_ID,
  GIT_IDENTITY_STATUSES,
  GIT_IDENTITY_VERSION,
  MAX_GIT_ARGS,
  MAX_GIT_ARG_BYTES,
  MAX_GIT_COMMANDS,
  MAX_GIT_TIME_MS,
  MAX_GIT_TOTAL_TIME_MS,
  parseGitIdentityRequestV1,
  verifyGitIdentityV1,
} from './git-identity.mjs';
import {
  capturedDescriptor,
  capturedFreeze,
  capturedHasOwn,
  capturedOwnKeys,
  isKnownAccess,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  compiledRepoGlobMatchesPath,
  compileRepoGlob,
  assertRepoRelativePath,
  REPO_PATH_BATCH_MAX,
  RepoPathMatcherError,
} from './repo-path-matcher.mjs';
import {
  RunContractV1Error,
  assertWriteScopePatterns,
  isAssignmentId,
  isSha40,
  SCOPE_MAX_PATTERNS,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  hasOwn,
  optOwn,
} from './selection-json.mjs';

export const SCOPE_VERIFIER_SCHEMA_ID = 'codex-co-engineer.scope-verifier.v1';
export const SCOPE_VERIFIER_VERSION = 1;

export const MAX_SCOPE_OUTPUT_BYTES = 262_144;
export const MAX_CHANGED_PATHS = REPO_PATH_BATCH_MAX;
export const MAX_NEW_COMMITS = 64;
export const MAX_OTHER_WRITE_SCOPES = 7;

export const SCOPE_REQUEST_ALLOWED_KEYS = capturedFreeze([
  'identity_request', 'identity', 'access', 'write_scope', 'other_write_scopes',
]);
export const SCOPE_REQUEST_REQUIRED_KEYS = SCOPE_REQUEST_ALLOWED_KEYS;
export const SCOPE_OTHER_SCOPE_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'write_scope',
]);
export const SCOPE_RESULT_ALLOWED_KEYS = capturedFreeze([
  'schema', 'version', 'status', 'facts', 'discrepancies', 'observation',
]);
export const SCOPE_OBSERVATION_ALLOWED_KEYS = capturedFreeze([
  'repository_path', 'git_dir', 'base_sha', 'head_sha', 'access',
  'parent_count', 'new_commit_count', 'path_count', 'path_set_digest',
  'rename_count', 'copy_count', 'dirty', 'duration_ms',
]);
export const SCOPE_OPTIONS_ALLOWED_KEYS = capturedFreeze(['spawn']);
export const SCOPE_VERIFIER_STATUSES = capturedFreeze(['failed', 'verified']);

export const SCOPE_VERIFIER_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'bounds_exceeded',
  'conflicting_id', 'duplicate_id', 'env_influence_denied',
  'exotic_prototype_denied', 'git_execution_failed', 'hostile_name_denied',
  'identity_mismatch', 'invalid_format', 'invalid_type', 'missing_key',
  'non_enumerable_property_denied', 'observation_race', 'own_undefined_denied',
  'out_of_range', 'proxy_denied', 'symbol_key_denied', 'unknown_key',
  'unverified_identity',
]);

const SCOPE_GIT_ISOLATION_FLAGS = capturedFreeze([
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

const SEPARATOR_LOOKALIKES = capturedFreeze([
  0x2044, 0x2215, 0x27cb, 0x27cd, 0x29f8, 0xfe68, 0xff0f, 0xff3c,
]);
const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PRIVATE_MODE_PATTERN = /^[0-7]{6}$/u;
const PRIVATE_DIFF_STATUS_PATTERN = /^[ADMTRCUBX][0-9]{0,3}$/u;
const ZERO_SHA = '0'.repeat(40);
const MODE_SYMLINK = '120000';
const MODE_GITLINK = '160000';
const MODE_MISSING = '000000';

const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const MATH_FLOOR = Math.floor;
const MATH_MAX = Math.max;
const MATH_MIN = Math.min;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PUSH = Array.prototype.push;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const BUFFER_IS_BUFFER = NodeBuffer.isBuffer.bind(NodeBuffer);
const BUFFER_EQUALS = NodeBuffer.prototype.equals;
const CRYPTO_CREATE_HASH = createHash;
const HASH_PROTOTYPE = Object.getPrototypeOf(CRYPTO_CREATE_HASH('sha256'));
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const SPAWN = nodeSpawn;
const REFLECT_APPLY = Reflect.apply;
const STRING_FROM_CODE_POINT = String.fromCodePoint;
const IS_PROXY = utilTypes.isProxy;

function contractError(code, path, message) {
  return new RunContractV1Error(code, path, message);
}

function asContractError(error, path, code = 'git_execution_failed') {
  if (error instanceof RunContractV1Error) return error;
  return contractError(code, path, `${path} could not complete a git observation.`);
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
        `${path} carries a symbol property; scope records are direct JSON only.`);
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
        `${path}.${key} is required (${SCOPE_VERIFIER_SCHEMA_ID}); scope records have no hidden defaults.`);
    }
  }
}

function digestCanonical(value) {
  const canonical = canonicalJsonStringify(value);
  const hash = CRYPTO_CREATE_HASH('sha256');
  HASH_UPDATE.call(hash, BUFFER_FROM(canonical, 'utf8'));
  return HASH_DIGEST.call(hash, 'hex');
}

function digestBytes(text) {
  const hash = CRYPTO_CREATE_HASH('sha256');
  HASH_UPDATE.call(hash, BUFFER_FROM(text, 'utf8'));
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

function decodeUtf8(buffer, path) {
  let text;
  try {
    text = buffer.toString('utf8');
  } catch {
    fail('git_execution_failed', path, `${path} produced an invalid git observation encoding.`);
  }
  let roundtrip;
  try {
    roundtrip = BUFFER_FROM(text, 'utf8');
  } catch {
    fail('git_execution_failed', path, `${path} produced an invalid git observation encoding.`);
  }
  if (roundtrip.length !== buffer.length || !REFLECT_APPLY(BUFFER_EQUALS, roundtrip, [buffer])) {
    fail('hostile_name_denied', path, `${path} produced a non-UTF-8 git observation.`);
  }
  return text;
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
  const argv = [GIT_EXECUTABLE, ...SCOPE_GIT_ISOLATION_FLAGS, ...args];
  assertGitArgv(argv, `${path}.argv`);
  const spawnOptions = {
    cwd: '/',
    env: GIT_CLOSED_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
  assertClosedEnv(spawnOptions.env, `${path}.env`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = session.spawn(GIT_EXECUTABLE, argv.slice(1), spawnOptions);
    } catch {
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
        if (next > MAX_SCOPE_OUTPUT_BYTES) {
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
          const stdoutBuffer = BUFFER_CONCAT(stdoutChunks);
          const stderrBuffer = BUFFER_CONCAT(stderrChunks);
          if (signal !== null && signal !== undefined) {
            finish(contractError(
              'git_execution_failed', path, `${path} could not complete a git observation.`,
            ));
            return;
          }
          finish(null, {
            exit_code: typeof code === 'number' ? code : 1,
            stdout: decodeUtf8(stdoutBuffer, path),
            stderr: decodeUtf8(stderrBuffer, `${path}.stderr`),
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

async function gitRequired(session, args, path) {
  const result = await runGit(session, args, path);
  if (result.exit_code !== 0) {
    fail('git_execution_failed', path, `${path} could not complete a git observation.`);
  }
  return result.stdout;
}

function repoFlags(repositoryPath, gitDir) {
  return capturedFreeze(['-C', repositoryPath, '--git-dir', gitDir]);
}

function parseOptions(options, path = 'options') {
  if (options === undefined) {
    return freezeRecord(SCOPE_OPTIONS_ALLOWED_KEYS, { spawn: SPAWN });
  }
  assertNotProxy(options, path);
  assertPlainObject(options, 'invalid_type', path, path);
  assertClosedKeySet(options, SCOPE_OPTIONS_ALLOWED_KEYS, path);
  let spawn = SPAWN;
  if (hasOwn(options, 'spawn')) {
    spawn = optOwn(options, 'spawn');
    if (typeof spawn !== 'function') {
      fail('invalid_type', `${path}.spawn`, `${path}.spawn must be a spawn function.`);
    }
    assertNotProxy(spawn, `${path}.spawn`);
  }
  return freezeRecord(SCOPE_OPTIONS_ALLOWED_KEYS, { spawn });
}

function splitNul(text) {
  if (typeof text !== 'string') return [];
  if (text.length === 0) return [];
  const parts = text.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function assertObservedPath(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('hostile_name_denied', path, `${path} is not a repository-relative path.`);
  }
  if (value.includes('\0') || value.includes('\r') || value.includes('\\')) {
    fail('hostile_name_denied', path, `${path} is not a repository-relative path.`);
  }
  try {
    assertRepoRelativePath(value, 'path');
  } catch (error) {
    if (error instanceof RepoPathMatcherError || error instanceof RunContractV1Error) {
      fail('hostile_name_denied', path, `${path} is not a repository-relative path.`);
    }
    throw error;
  }
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      fail('hostile_name_denied', path, `${path} is not a repository-relative path.`);
    }
    for (let look = 0; look < SEPARATOR_LOOKALIKES.length; look += 1) {
      if (SEPARATOR_LOOKALIKES[look] === codePoint) {
        fail('hostile_name_denied', path, `${path} contains a confusable path separator.`);
      }
    }
    if (STRING_FROM_CODE_POINT(codePoint).normalize('NFC')
      !== STRING_FROM_CODE_POINT(codePoint)) {
      fail('hostile_name_denied', path, `${path} must use NFC-normalized path segments.`);
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (value.normalize('NFC') !== value) {
    fail('hostile_name_denied', path, `${path} must use NFC-normalized path segments.`);
  }
  return value;
}

function addUniquePath(paths, seen, value, path) {
  const observed = assertObservedPath(value, path);
  if (seen.has(observed)) return;
  if (paths.length >= MAX_CHANGED_PATHS) {
    fail('bounds_exceeded', path, `${path} exceeds the changed-path cap.`);
  }
  seen.add(observed);
  REFLECT_APPLY(ARRAY_PUSH, paths, [observed]);
}

function isRenameOrCopyStatus(status) {
  return status.charCodeAt(0) === 0x52 || status.charCodeAt(0) === 0x43;
}

function parseDiffTreeRaw(stdout, path) {
  const parts = splitNul(stdout);
  const records = [];
  const paths = [];
  const seen = new Set();
  let renameCount = 0;
  let copyCount = 0;
  let index = 0;
  while (index < parts.length) {
    const header = parts[index];
    index += 1;
    if (typeof header !== 'string' || header.length === 0 || header.charCodeAt(0) !== 0x3a) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    const fields = header.slice(1).split(' ');
    if (fields.length !== 5) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    const [oldMode, newMode, oldSha, newSha, status] = fields;
    if (!PRIVATE_MODE_PATTERN.test(oldMode) || !PRIVATE_MODE_PATTERN.test(newMode)
      || !isSha40(oldSha) && oldSha !== ZERO_SHA
      || !isSha40(newSha) && newSha !== ZERO_SHA
      || !PRIVATE_DIFF_STATUS_PATTERN.test(status)) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    if (!isSha40(oldSha) && oldSha !== ZERO_SHA) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    if (!isSha40(newSha) && newSha !== ZERO_SHA) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    const kind = status.charCodeAt(0);
    let sourcePath = '';
    let destPath = '';
    if (isRenameOrCopyStatus(status)) {
      if (index + 1 >= parts.length) {
        fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
      }
      sourcePath = parts[index];
      destPath = parts[index + 1];
      index += 2;
      addUniquePath(paths, seen, sourcePath, path);
      addUniquePath(paths, seen, destPath, path);
      if (kind === 0x52) renameCount += 1;
      else copyCount += 1;
    } else {
      if (index >= parts.length) {
        fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
      }
      destPath = parts[index];
      index += 1;
      addUniquePath(paths, seen, destPath, path);
    }
    REFLECT_APPLY(ARRAY_PUSH, records, [capturedFreeze({
      old_mode: oldMode,
      new_mode: newMode,
      status,
      source_path: sourcePath,
      dest_path: destPath,
    })]);
  }
  return { records, paths, seen, rename_count: renameCount, copy_count: copyCount };
}

function parseStatusPorcelain(stdout, path, paths, seen) {
  const parts = splitNul(stdout);
  let index = 0;
  while (index < parts.length) {
    const entry = parts[index];
    index += 1;
    if (typeof entry !== 'string' || entry.length < 2) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    const xy0 = entry.charCodeAt(0);
    const xy1 = entry.charCodeAt(1);
    if (xy0 > 0x7e || xy1 > 0x7e || xy0 < 0x20 || xy1 < 0x20) {
      fail('hostile_name_denied', path, `${path} produced an unexpected git observation.`);
    }
    const renamed = xy0 === 0x52 || xy0 === 0x43 || xy1 === 0x52 || xy1 === 0x43;
    if (entry.length === 2) {
      if (!renamed || index + 1 >= parts.length) {
        fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
      }
      addUniquePath(paths, seen, parts[index], path);
      addUniquePath(paths, seen, parts[index + 1], path);
      index += 2;
      continue;
    }
    if (entry.charCodeAt(2) !== 0x20) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    addUniquePath(paths, seen, entry.slice(3), path);
    if (renamed) {
      if (index >= parts.length) {
        fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
      }
      addUniquePath(paths, seen, parts[index], path);
      index += 1;
    }
  }
}

function parseLsFilesOthers(stdout, path, paths, seen) {
  const parts = splitNul(stdout);
  for (let index = 0; index < parts.length; index += 1) {
    addUniquePath(paths, seen, parts[index], path);
  }
}

function parseRevListParents(stdout, path, expectedHead, allowEmpty) {
  if (stdout.includes('\0') || stdout.includes('\r')) {
    fail('git_execution_failed', path, `${path} produced extra git output.`);
  }
  let text = stdout;
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.length === 0) {
    if (!allowEmpty) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    return { commits: [], parent_count: 1, merge: false };
  }
  const lines = text.split('\n');
  if (lines.length > MAX_NEW_COMMITS) {
    fail('bounds_exceeded', path, `${path} exceeds the new-commit cap.`);
  }
  let merge = false;
  let parentCount = 1;
  let sawHead = expectedHead === undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const tokens = line.split(' ');
    if (tokens.length < 1 || !isSha40(tokens[0])) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    for (let token = 1; token < tokens.length; token += 1) {
      if (!isSha40(tokens[token])) {
        fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
      }
    }
    const parents = tokens.length - 1;
    if (tokens[0] === expectedHead) {
      sawHead = true;
      parentCount = parents;
    }
    if (parents !== 1) merge = true;
  }
  if (expectedHead !== undefined && !sawHead && lines.length > 0) {
    parentCount = lines[0].split(' ').length - 1;
  }
  return { commits: lines, parent_count: parentCount, merge };
}

function compileScopePatterns(patterns, path) {
  const compiled = [];
  for (let index = 0; index < patterns.length; index += 1) {
    try {
      REFLECT_APPLY(ARRAY_PUSH, compiled, [
        compileRepoGlob(patterns[index], `${path}[${index}]`),
      ]);
    } catch (error) {
      if (error instanceof RepoPathMatcherError) {
        fail('invalid_format', `${path}[${index}]`,
          `${path}[${index}] is not a matchable repository glob.`);
      }
      throw error;
    }
  }
  return capturedFreeze(compiled);
}

function snapshotWriteScope(value, path, { minPatterns, maxPatterns }) {
  assertWriteScopePatterns(value, path, { minPatterns, maxPatterns });
  const patterns = [];
  for (let index = 0; index < value.length; index += 1) {
    REFLECT_APPLY(ARRAY_PUSH, patterns, [optOwn(value, String(index))]);
  }
  return {
    patterns: capturedFreeze(patterns),
    compiled: compileScopePatterns(patterns, path),
  };
}

function pathMatchesAny(pathname, compiled, path) {
  for (let index = 0; index < compiled.length; index += 1) {
    try {
      if (compiledRepoGlobMatchesPath(compiled[index], pathname, 'path') === true) {
        return true;
      }
    } catch (error) {
      if (error instanceof RepoPathMatcherError) {
        fail('hostile_name_denied', path, `${path} is not a repository-relative path.`);
      }
      throw error;
    }
  }
  return false;
}

function parseOtherWriteScopes(input, path, selfAssignmentId) {
  const value = optOwn(input, 'other_write_scopes');
  assertNotProxy(value, path);
  if (!ARRAY_IS_ARRAY(value)) {
    fail('invalid_type', path, `${path} must be an array of trusted writer scopes.`);
  }
  if (value.length > MAX_OTHER_WRITE_SCOPES) {
    fail('out_of_range', path, `${path} exceeds the other-writer cap.`);
  }
  const snapshots = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = optOwn(value, String(index));
    assertPlainObject(entry, 'invalid_type', entryPath, entryPath);
    assertClosedKeySet(entry, SCOPE_OTHER_SCOPE_ALLOWED_KEYS, entryPath);
    requiredKeys(entry, SCOPE_OTHER_SCOPE_ALLOWED_KEYS, entryPath);
    const assignmentId = optOwn(entry, 'assignment_id');
    if (!isAssignmentId(assignmentId)) {
      fail('invalid_format', `${entryPath}.assignment_id`,
        `${entryPath}.assignment_id violates the assignment-id grammar.`);
    }
    if (assignmentId === selfAssignmentId) {
      fail('conflicting_id', `${entryPath}.assignment_id`,
        `${entryPath}.assignment_id must not repeat the observed assignment.`);
    }
    if (seen.has(assignmentId)) {
      fail('duplicate_id', `${entryPath}.assignment_id`,
        `${entryPath}.assignment_id repeats an identity.`);
    }
    seen.add(assignmentId);
    const scope = snapshotWriteScope(
      optOwn(entry, 'write_scope'), `${entryPath}.write_scope`,
      { minPatterns: 1, maxPatterns: SCOPE_MAX_PATTERNS },
    );
    REFLECT_APPLY(ARRAY_PUSH, snapshots, [capturedFreeze({
      assignment_id: assignmentId,
      write_scope: scope.patterns,
      compiled: scope.compiled,
    })]);
  }
  return capturedFreeze(snapshots);
}

function parseObservationMap(input, path) {
  assertPlainObject(input, 'invalid_type', path, path);
  assertClosedKeySet(input, GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS, path);
  requiredKeys(input, GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS, path);
  const values = {};
  for (let index = 0; index < GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS.length; index += 1) {
    const key = GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS[index];
    values[key] = optOwn(input, key);
  }
  if (typeof values.repository_path !== 'string' || typeof values.git_dir !== 'string'
    || typeof values.base_ref !== 'string' || typeof values.worktree_head_ref !== 'string'
    || typeof values.base_object_type !== 'string' || typeof values.head_object_type !== 'string'
    || typeof values.ancestor !== 'boolean'
    || typeof values.duration_ms !== 'number' || !NUMBER_IS_SAFE_INTEGER(values.duration_ms)) {
    fail('invalid_type', path, `${path} is not a trusted git identity observation.`);
  }
  if (!isSha40(values.base_sha) || !isSha40(values.head_sha)
    || (values.merge_base_sha !== '' && !isSha40(values.merge_base_sha))) {
    fail('invalid_format', path, `${path} is not a trusted git identity observation.`);
  }
  return freezeRecord(GIT_IDENTITY_OBSERVATION_ALLOWED_KEYS, values);
}

function parseTrustedIdentity(input, path, request) {
  assertPlainObject(input, 'invalid_type', path, path);
  assertClosedKeySet(input, GIT_IDENTITY_RESULT_ALLOWED_KEYS, path);
  requiredKeys(input, GIT_IDENTITY_RESULT_ALLOWED_KEYS, path);
  const schema = optOwn(input, 'schema');
  const version = optOwn(input, 'version');
  const status = optOwn(input, 'status');
  if (schema !== GIT_IDENTITY_SCHEMA_ID || version !== GIT_IDENTITY_VERSION) {
    fail('identity_mismatch', path, `${path} is not a trusted git identity snapshot.`);
  }
  let statusAllowed = false;
  for (let index = 0; index < GIT_IDENTITY_STATUSES.length; index += 1) {
    if (GIT_IDENTITY_STATUSES[index] === status) statusAllowed = true;
  }
  if (!statusAllowed) {
    fail('invalid_format', `${path}.status`, `${path}.status is outside the closed identity vocabulary.`);
  }
  const factsInput = optOwn(input, 'facts');
  const discrepanciesInput = optOwn(input, 'discrepancies');
  if (!ARRAY_IS_ARRAY(factsInput) || !ARRAY_IS_ARRAY(discrepanciesInput)) {
    fail('invalid_type', path, `${path} is not a trusted git identity snapshot.`);
  }
  const facts = [];
  for (let index = 0; index < factsInput.length; index += 1) {
    REFLECT_APPLY(ARRAY_PUSH, facts, [
      parseVerifiedFactV1(optOwn(factsInput, String(index)), `${path}.facts[${index}]`),
    ]);
  }
  const discrepancies = [];
  for (let index = 0; index < discrepanciesInput.length; index += 1) {
    REFLECT_APPLY(ARRAY_PUSH, discrepancies, [
      parseEvidenceDiscrepancyV1(
        optOwn(discrepanciesInput, String(index)), `${path}.discrepancies[${index}]`,
      ),
    ]);
  }
  if (status !== 'verified' || discrepancies.length !== 0) {
    fail('unverified_identity', path, `${path} is not a verified git identity snapshot.`);
  }
  const observation = parseObservationMap(optOwn(input, 'observation'), `${path}.observation`);
  if (observation.repository_path !== request.repository.path
    || observation.base_sha !== request.repository.base_sha
    || observation.head_sha !== request.candidate_head_sha
    || observation.base_ref !== request.expected_base_ref
    || observation.ancestor !== true
    || observation.merge_base_sha !== request.repository.base_sha) {
    fail('identity_mismatch', path, `${path} does not match the trusted identity request.`);
  }
  let sawIdentity = false;
  let sawHead = false;
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    if (fact.run_id !== request.run_id || fact.assignment_id !== request.assignment_id) {
      fail('identity_mismatch', `${path}.facts[${index}]`,
        `${path}.facts[${index}] identity does not match the trusted identity request.`);
    }
    if (fact.status !== 'verified' || fact.authority !== 'platform_git'
      || fact.method !== 'ancestry_check') {
      fail('unverified_identity', `${path}.facts[${index}]`,
        `${path} is not a verified git identity snapshot.`);
    }
    if (fact.fact_kind === 'git_identity') {
      if (fact.payload.base_sha !== request.repository.base_sha
        || fact.payload.head_sha !== request.candidate_head_sha) {
        fail('identity_mismatch', `${path}.facts[${index}]`,
          `${path}.facts[${index}] does not match the trusted identity request.`);
      }
      sawIdentity = true;
    }
    if (fact.fact_kind === 'head_sha') {
      if (fact.payload.sha !== request.candidate_head_sha) {
        fail('identity_mismatch', `${path}.facts[${index}]`,
          `${path}.facts[${index}] does not match the trusted identity request.`);
      }
      sawHead = true;
    }
  }
  if (!sawIdentity || !sawHead) {
    fail('unverified_identity', path, `${path} is not a verified git identity snapshot.`);
  }
  return freezeRecord(GIT_IDENTITY_RESULT_ALLOWED_KEYS, {
    schema,
    version,
    status,
    facts: capturedFreeze(facts),
    discrepancies: capturedFreeze(discrepancies),
    observation,
  });
}

export function parseScopeVerifierRequestV1(input, path = 'scope') {
  assertPlainObject(input, 'invalid_type', path, `${path}`);
  assertClosedKeySet(input, SCOPE_REQUEST_ALLOWED_KEYS, path);
  assertNestedClosedKeys(input, 'identity_request', [
    'repository', 'expected_base_ref', 'candidate_head_sha',
    'run_id', 'assignment_id', 'sequence',
  ], path);
  assertNestedClosedKeys(input, 'identity', GIT_IDENTITY_RESULT_ALLOWED_KEYS, path);
  assertDirectJsonClosure(input, path);
  requiredKeys(input, SCOPE_REQUEST_REQUIRED_KEYS, path);
  const identityRequest = parseGitIdentityRequestV1(
    optOwn(input, 'identity_request'), `${path}.identity_request`,
  );
  const identity = parseTrustedIdentity(
    optOwn(input, 'identity'), `${path}.identity`, identityRequest,
  );
  const access = optOwn(input, 'access');
  if (!isKnownAccess(access)) {
    fail('invalid_format', `${path}.access`, `${path}.access must be "writer" or "read_only".`);
  }
  const minPatterns = access === 'read_only' ? 0 : 1;
  const maxPatterns = access === 'read_only' ? 0 : SCOPE_MAX_PATTERNS;
  const writeScope = snapshotWriteScope(
    optOwn(input, 'write_scope'), `${path}.write_scope`, { minPatterns, maxPatterns },
  );
  const otherWriteScopes = parseOtherWriteScopes(
    input, `${path}.other_write_scopes`, identityRequest.assignment_id,
  );
  return freezeRecord(capturedFreeze([
    ...SCOPE_REQUEST_ALLOWED_KEYS, 'compiled_write_scope',
  ]), {
    identity_request: identityRequest,
    identity,
    access,
    write_scope: writeScope.patterns,
    other_write_scopes: otherWriteScopes,
    compiled_write_scope: writeScope.compiled,
  });
}

function identityFingerprint(result) {
  return digestCanonical({
    repository_path: result.observation.repository_path,
    git_dir: result.observation.git_dir,
    base_ref: result.observation.base_ref,
    base_sha: result.observation.base_sha,
    head_sha: result.observation.head_sha,
    merge_base_sha: result.observation.merge_base_sha,
    worktree_head_ref: result.observation.worktree_head_ref,
    ancestor: result.observation.ancestor,
    status: result.status,
  });
}

function assertLiveIdentity(trusted, live, path) {
  if (live.status !== 'verified' || live.discrepancies.length !== 0) {
    fail('unverified_identity', path, `${path} is not a verified git identity snapshot.`);
  }
  if (identityFingerprint(trusted) !== identityFingerprint(live)) {
    fail('observation_race', path, `${path} observed a git identity race.`);
  }
}

function classifyDiffRecords(records, path) {
  let symlink = false;
  let gitlink = false;
  let typeChange = false;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status0 = record.status.charCodeAt(0);
    if (status0 === 0x54) typeChange = true;
    if (status0 === 0x55 || status0 === 0x58 || status0 === 0x42) {
      fail('git_execution_failed', path, `${path} produced an unexpected git observation.`);
    }
    if (record.old_mode === MODE_SYMLINK || record.new_mode === MODE_SYMLINK) symlink = true;
    if (record.old_mode === MODE_GITLINK || record.new_mode === MODE_GITLINK) gitlink = true;
    const oldFile = record.old_mode !== MODE_MISSING && record.old_mode !== MODE_SYMLINK
      && record.old_mode !== MODE_GITLINK;
    const newFile = record.new_mode !== MODE_MISSING && record.new_mode !== MODE_SYMLINK
      && record.new_mode !== MODE_GITLINK;
    const oldSpecial = record.old_mode === MODE_SYMLINK || record.old_mode === MODE_GITLINK;
    const newSpecial = record.new_mode === MODE_SYMLINK || record.new_mode === MODE_GITLINK;
    if ((oldFile && newSpecial) || (oldSpecial && newFile) || (oldSpecial && newSpecial
      && record.old_mode !== record.new_mode)) {
      typeChange = true;
    }
  }
  return { symlink, gitlink, type_change: typeChange };
}

async function observeScope(session, flags, baseSha, headSha, path) {
  const sameCommit = baseSha === headSha;
  const diffText = await gitRequired(session, [
    ...flags, 'diff-tree', '--no-commit-id', '--raw', '--full-index', '-z', '-r',
    '-M', '-C', '--end-of-options', baseSha, headSha,
  ], `${path}.diff`);
  const parsed = parseDiffTreeRaw(diffText, `${path}.diff`);
  const statusText = await gitRequired(session, [
    ...flags, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    '--ignore-submodules=none',
  ], `${path}.status`);
  parseStatusPorcelain(statusText, `${path}.status`, parsed.paths, parsed.seen);
  const untrackedText = await gitRequired(session, [
    ...flags, 'ls-files', '-z', '--others', '--exclude-standard',
  ], `${path}.untracked`);
  parseLsFilesOthers(untrackedText, `${path}.untracked`, parsed.paths, parsed.seen);
  let parent;
  if (sameCommit) {
    parent = { commits: [], parent_count: 1, merge: false, new_commit_count: 0 };
  } else {
    const rangeText = await gitRequired(session, [
      ...flags, 'rev-list', '--parents', `--max-count=${MAX_NEW_COMMITS + 1}`,
      headSha, '--not', baseSha,
    ], `${path}.parents`);
    parent = parseRevListParents(rangeText, `${path}.parents`, headSha, false);
    parent.new_commit_count = parent.commits.length;
  }
  REFLECT_APPLY(ARRAY_SORT, parsed.paths, [(left, right) => {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }]);
  const pathSetDigest = digestCanonical(parsed.paths);
  const fingerprint = digestCanonical({
    diff: digestBytes(diffText),
    status: digestBytes(statusText),
    untracked: digestBytes(untrackedText),
    parents: parent.commits,
    path_set_digest: pathSetDigest,
  });
  const operations = classifyDiffRecords(parsed.records, `${path}.diff`);
  return {
    paths: capturedFreeze(parsed.paths),
    path_count: parsed.paths.length,
    path_set_digest: pathSetDigest,
    rename_count: parsed.rename_count,
    copy_count: parsed.copy_count,
    parent_count: parent.parent_count,
    new_commit_count: parent.new_commit_count,
    merge: parent.merge === true || (!sameCommit && parent.parent_count !== 1),
    dirty: statusText.length > 0 || untrackedText.length > 0,
    symlink: operations.symlink,
    gitlink: operations.gitlink,
    type_change: operations.type_change,
    fingerprint,
  };
}

function durationOf(session, path) {
  assertDeadline(session, path);
  return MATH_MAX(0, MATH_FLOOR(Date.now() - session.startedAt));
}

function emitFact(kind, method, request, inputDigest, outputDigest, status, payload, durationMs) {
  const boundedDuration = durationMs > MAX_DURATION_MS ? MAX_DURATION_MS : durationMs;
  return parseVerifiedFactV1({
    fact_id: kind === 'git_diff' ? 'git-diff' : 'head-sha',
    fact_kind: kind,
    status,
    code: 'host_observed',
    run_id: request.identity_request.run_id,
    assignment_id: request.identity_request.assignment_id,
    sequence: kind === 'git_diff' ? request.identity_request.sequence
      : request.identity_request.sequence + 1,
    subject: kind === 'git_diff' ? 'diff' : 'head',
    authority: 'platform_git',
    method,
    input_digest: inputDigest,
    output_digest: outputDigest,
    exit_code: null,
    duration_ms: boundedDuration,
    truncated: false,
    payload,
    artifact_digests: [],
  });
}

function emitDiscrepancy(id, kind, code, request, factIds, sequence) {
  return parseEvidenceDiscrepancyV1({
    discrepancy_id: id,
    discrepancy_kind: kind,
    status: 'recorded',
    code,
    run_id: request.identity_request.run_id,
    assignment_id: request.identity_request.assignment_id,
    sequence,
    claim_ids: [],
    fact_ids: factIds,
    artifact_digests: [],
  });
}

export async function verifyScopeV1(input, options) {
  const request = parseScopeVerifierRequestV1(input);
  const parsedOptions = parseOptions(options);
  const pathLabel = 'scope';
  const livePre = await verifyGitIdentityV1(request.identity_request, parsedOptions);
  assertLiveIdentity(request.identity, livePre, `${pathLabel}.identity`);
  const session = createSession(parsedOptions.spawn);
  const repositoryPath = livePre.observation.repository_path;
  const gitDir = livePre.observation.git_dir;
  const flags = repoFlags(repositoryPath, gitDir);
  const pre = await observeScope(
    session, flags, livePre.observation.base_sha, livePre.observation.head_sha, pathLabel,
  );
  const livePost = await verifyGitIdentityV1(request.identity_request, parsedOptions);
  assertLiveIdentity(request.identity, livePost, `${pathLabel}.identity`);
  const post = await observeScope(
    session, flags, livePost.observation.base_sha, livePost.observation.head_sha, pathLabel,
  );
  if (pre.fingerprint !== post.fingerprint
    || identityFingerprint(livePre) !== identityFingerprint(livePost)) {
    fail('observation_race', pathLabel, `${pathLabel} observed a git identity or worktree race.`);
  }
  const durationMs = durationOf(session, pathLabel);
  const observation = freezeRecord(SCOPE_OBSERVATION_ALLOWED_KEYS, {
    repository_path: repositoryPath,
    git_dir: gitDir,
    base_sha: livePost.observation.base_sha,
    head_sha: livePost.observation.head_sha,
    access: request.access,
    parent_count: post.parent_count,
    new_commit_count: post.new_commit_count,
    path_count: post.path_count,
    path_set_digest: post.path_set_digest,
    rename_count: post.rename_count,
    copy_count: post.copy_count,
    dirty: post.dirty,
    duration_ms: durationMs,
  });
  const inputDigest = digestCanonical({
    repository: request.identity_request.repository,
    expected_base_ref: request.identity_request.expected_base_ref,
    candidate_head_sha: request.identity_request.candidate_head_sha,
    access: request.access,
    write_scope: request.write_scope,
  });
  const outputDigest = digestCanonical(observation);
  if (!PRIVATE_SHA256_PATTERN.test(inputDigest) || !PRIVATE_SHA256_PATTERN.test(outputDigest)) {
    fail('git_execution_failed', pathLabel, `${pathLabel} could not bind observation digests.`);
  }
  let ownedMismatch = false;
  let overlap = false;
  if (request.access === 'writer') {
    for (let index = 0; index < post.paths.length; index += 1) {
      const pathname = post.paths[index];
      if (!pathMatchesAny(pathname, request.compiled_write_scope, `${pathLabel}.diff`)) {
        ownedMismatch = true;
      }
      for (let other = 0; other < request.other_write_scopes.length; other += 1) {
        if (pathMatchesAny(
          pathname, request.other_write_scopes[other].compiled, `${pathLabel}.diff`,
        )) {
          overlap = true;
        }
      }
    }
  }
  const discrepancies = [];
  const pushDiscrepancy = (id, kind, code, factIds) => {
    const sequence = request.identity_request.sequence + discrepancies.length;
    if (sequence > MAX_SEQUENCE) return;
    try {
      REFLECT_APPLY(ARRAY_PUSH, discrepancies, [
        emitDiscrepancy(id, kind, code, request, factIds, sequence),
      ]);
    } catch (error) {
      if (error instanceof RunContractV1Error && error.code === 'out_of_range') return;
      throw error;
    }
  };
  const diffFactId = 'git-diff';
  const headFactId = 'head-sha';
  if (post.merge) {
    pushDiscrepancy('merge-commit', 'integrity', 'artifact_integrity_failure', [headFactId]);
  }
  if (request.access === 'read_only' && (post.path_count > 0 || post.dirty
    || livePost.observation.head_sha !== livePost.observation.base_sha)) {
    pushDiscrepancy('read-only-mutation', 'integrity', 'artifact_integrity_failure', [diffFactId]);
  }
  if (ownedMismatch) {
    pushDiscrepancy('scope-mismatch', 'integrity', 'artifact_integrity_failure', [diffFactId]);
  }
  if (overlap) {
    pushDiscrepancy('scope-overlap', 'integrity', 'artifact_integrity_failure', [diffFactId]);
  }
  if (post.symlink) {
    pushDiscrepancy('symlink-change', 'security', 'security_boundary', [diffFactId]);
  }
  if (post.gitlink) {
    pushDiscrepancy('submodule-change', 'security', 'security_boundary', [diffFactId]);
  }
  if (post.type_change) {
    pushDiscrepancy('type-change', 'security', 'security_boundary', [diffFactId]);
  }
  const verified = discrepancies.length === 0
    && (request.access !== 'read_only' || post.path_count === 0)
    && (request.access !== 'writer' || !ownedMismatch)
    && post.merge !== true;
  const status = verified ? 'verified' : 'failed';
  const diffMethod = request.access === 'read_only' ? 'read_only_no_changes' : 'scope_match';
  const facts = capturedFreeze([
    emitFact(
      'git_diff', diffMethod, request, inputDigest, outputDigest, status,
      { path_count: post.path_count, path_set_digest: post.path_set_digest },
      durationMs,
    ),
    emitFact(
      'head_sha', 'merge_commit_absence', request, inputDigest, outputDigest, status,
      { sha: request.identity_request.candidate_head_sha },
      durationMs,
    ),
  ]);
  const result = freezeRecord(SCOPE_RESULT_ALLOWED_KEYS, {
    schema: SCOPE_VERIFIER_SCHEMA_ID,
    version: SCOPE_VERIFIER_VERSION,
    status,
    facts,
    discrepancies: capturedFreeze(discrepancies),
    observation,
  });
  assertDeadline(session, pathLabel);
  return result;
}

OBJECT_FREEZE(SCOPE_VERIFIER_ERROR_CODES);
