// Aggregate pre-dispatch run anchor (R24A).
//
// Additive v3 module. It persists one immutable AggregateRunAnchorV1 plus
// absorbing coordination state for runs whose P05 provider/model selection is
// still unresolved. The caller supplies a private root distinct from accepted
// P24/P25. Open requires an explicit storage-root.v1 marker of kind
// aggregate_run_anchor; unmarked empty roots are typed uninitialized and
// nonempty P24/P25/foreign roots fail closed. Root-level claims/<run_id>.json
// bind identity before runs/<run_id> is adopted. High-level mutations publish
// full canonical records before coordination references. There is no public
// raw-digest CAS, journal, reducer, scheduler, provider, workspace, server,
// or MCP wiring, and no migration of P24/P25.

import { Buffer as NodeBuffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedTest,
  sortedCapturedKeys,
} from './grammar.mjs';
import { IDENTITY_LABELS, canonicalJsonStringify } from './identity.mjs';
import {
  assertBoundDigest,
  assertHexDigest,
  assertSharedGitIdentityV1,
  closedObject,
  fail,
  snapshotRecord,
  validateGitIdentityV1,
  validateRunIdentityV1,
} from './protected-identity.mjs';
import {
  selectionRequestIdentity,
  validateSelectionRequestV1,
} from './resolver.mjs';
import { RunContractV1Error, assertRunId, utf8ByteLength } from './run-manifest.mjs';
import {
  REQUEST_ID_PATTERN,
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  freezeData,
  identityBoundDigest,
} from './selection-json.mjs';

export const STORAGE_ROOT_SCHEMA_ID = 'codex-co-engineer.storage-root.v1';
export const AGGREGATE_RUN_ANCHOR_SCHEMA_ID = 'codex-co-engineer.aggregate-run-anchor.v1';
export const AGGREGATE_RUN_COORDINATION_SCHEMA_ID = 'codex-co-engineer.aggregate-run-coordination.v1';
export const AGGREGATE_RUN_CLAIM_SCHEMA_ID = 'codex-co-engineer.aggregate-run-claim.v1';
export const AGGREGATE_RUN_STAMP_SCHEMA_ID = 'codex-co-engineer.aggregate-run-created.v1';
export const AGGREGATE_RUN_LOCK_SCHEMA_ID = 'codex-co-engineer.aggregate-run-lock.v1';
export const AGGREGATE_NAMESPACE_LOCK_SCHEMA_ID = 'codex-co-engineer.aggregate-namespace-lock.v1';
export const AGGREGATE_SUBMISSION_SCHEMA_ID = 'codex-co-engineer.aggregate-run-submission.v1';
export const AGGREGATE_SELECTION_REPLY_SCHEMA_ID = 'codex-co-engineer.selection-reply.v1';
export const AGGREGATE_RESOLVED_PLAN_SCHEMA_ID = 'codex-co-engineer.resolved-plan.v1';
export const AGGREGATE_STORAGE_ROOT_KIND = 'aggregate_run_anchor';

export const AGGREGATE_RUN_PHASES = capturedFreeze([
  'submitted', 'awaiting_selection', 'resolution_ready',
]);
export const AGGREGATE_RUN_ANCHOR_KEYS = capturedFreeze([
  'schema', 'run_id', 'identity', 'git', 'manifest_digest',
  'submission_idempotency_key', 'canonical_digest',
]);
export const AGGREGATE_RUN_ANCHOR_INPUT_KEYS = capturedFreeze([
  'run_id', 'identity', 'git', 'manifest_digest',
]);
export const AGGREGATE_RUN_COORDINATION_KEYS = capturedFreeze([
  'schema', 'run_id', 'anchor_digest', 'revision', 'phase',
  'selection_request_binding', 'selection_reply_digest', 'resolved_plan_digest',
  'state_digest',
]);
export const AGGREGATE_SELECTION_BINDING_KEYS = capturedFreeze([
  'run_id', 'request_id', 'digest', 'record_digest',
]);
export const AGGREGATE_REQUEST_IDENTITY_KEYS = capturedFreeze([
  'digest', 'request_id', 'run_id',
]);
export const AGGREGATE_SUBMISSION_KEYS = capturedFreeze([
  'schema', 'run_id', 'git_digest', 'repository_path', 'base_sha', 'manifest_digest',
]);
export const AGGREGATE_CLAIM_KEYS = capturedFreeze([
  'schema', 'run_id', 'anchor_digest', 'submission_idempotency_key',
  'root_marker_nonce', 'root_marker_digest', 'nonce', 'canonical_digest',
]);
export const AGGREGATE_MARKER_KEYS = capturedFreeze([
  'schema', 'kind', 'nonce', 'canonical_digest',
]);
export const AGGREGATE_SELECTION_REPLY_INPUT_KEYS = capturedFreeze([
  'schema', 'run_id', 'request_id', 'answers',
]);
export const AGGREGATE_SELECTION_REPLY_KEYS = capturedFreeze([
  'schema', 'run_id', 'request_id', 'answers', 'canonical_digest',
]);
export const AGGREGATE_RESOLVED_PLAN_INPUT_KEYS = capturedFreeze([
  'schema', 'run_id', 'complete',
]);
export const AGGREGATE_RESOLVED_PLAN_KEYS = capturedFreeze([
  'schema', 'run_id', 'complete', 'canonical_digest',
]);
export const AGGREGATE_COMMIT_REQUEST_KEYS = capturedFreeze([
  'run_id', 'expected_revision', 'request_identity', 'record',
]);
export const AGGREGATE_COMMIT_RESOLUTION_KEYS = capturedFreeze([
  'run_id', 'expected_revision', 'request_identity', 'reply_record',
  'resolved_plan_record',
]);
export const AGGREGATE_COMMIT_PLAN_KEYS = capturedFreeze([
  'run_id', 'expected_revision', 'resolved_plan_record',
]);
export const SELECTION_ANSWER_KEYS = capturedFreeze(['assignment_id', 'model', 'provider']);

export const MAX_AGGREGATE_RUNS = 64;
export const MAX_AGGREGATE_RUN_DIRECTORY_ENTRIES = 16;
export const MAX_AGGREGATE_ROOT_ENTRIES = 8;
export const MAX_AGGREGATE_CLAIMS_DIRECTORY_ENTRIES = MAX_AGGREGATE_RUNS + 4;
export const MAX_AGGREGATE_RUNS_DIRECTORY_ENTRIES = MAX_AGGREGATE_RUNS + 4;
export const MAX_AGGREGATE_ANCHOR_BYTES = 64 * 1024;
export const MAX_AGGREGATE_COORDINATION_BYTES = 16 * 1024;
export const MAX_AGGREGATE_CLAIM_BYTES = 4 * 1024;
export const MAX_AGGREGATE_MARKER_BYTES = 512;
export const MAX_AGGREGATE_STAMP_BYTES = 256;
export const MAX_AGGREGATE_LOCK_BYTES = 160;
export const MAX_AGGREGATE_RECORD_BYTES = 16 * 1024;
export const MAX_AGGREGATE_TEMPORARIES = 8;
export const MAX_AGGREGATE_FILENAME_BYTES = 80;
export const MAX_AGGREGATE_DIAGNOSTIC_BYTES = 160;
export const AGGREGATE_LOCK_WAIT_MS = 8_000;
export const AGGREGATE_LOCK_POLL_MS = 10;
export const AGGREGATE_LOCK_MAX_AGE_MS = 30_000;
export const MAX_AGGREGATE_LOCK_STEALS = 4;

const MARKER_NAME = 'storage-root.v1';
const CLAIMS_NAME = 'claims';
const RUNS_NAME = 'runs';
const LOCK_NAME = 'lock';
const ANCHOR_NAME = 'anchor.json';
const COORDINATION_NAME = 'coordination.json';
const STAMP_NAME = 'created.json';
const REQUEST_RECORD_NAME = 'selection-request.record.json';
const REPLY_RECORD_NAME = 'selection-reply.record.json';
const PLAN_RECORD_NAME = 'resolved-plan.record.json';
const TEMP_NAME_PATTERN = /^\.tmp-[0-9a-f]{32}$/u;
const LOCK_OWNER_NAME_PATTERN = /^\.lock-[0-9a-f]{32}$/u;
const P24_RECORD_NAME_PATTERN = /^[a-z][a-z0-9-]{2,63}\.json$/u;
const P24_KEY_NAME_PATTERN = /^k-[0-9a-f]{64}$/u;
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const TIMING_SAFE_EQUAL = timingSafeEqual;
const RANDOM_BYTES = randomBytes;
const JSON_PARSE = JSON.parse;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const STRING = String;

const ROOT_OPEN_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_DIRECTORY ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const FILE_READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const FILE_CREATE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);

const ROOT_CHAINS = new Map();

function diagnostic(value) {
  const text = STRING(value ?? '');
  return text.length <= MAX_AGGREGATE_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_AGGREGATE_DIAGNOSTIC_BYTES);
}

function failAnchor(code, field, message) {
  fail(code, field, diagnostic(message));
}

function mapErrno(error, field, fallback, fallbackMessage) {
  if (error instanceof RunContractV1Error) throw error;
  const errno = error?.code;
  if (errno === 'ENOENT') {
    failAnchor('aggregate_run_root_missing', field, 'The aggregate run path does not exist.');
  }
  if (errno === 'ELOOP' || errno === 'ENOTDIR') {
    failAnchor('aggregate_run_root_unsafe', field, 'The aggregate run path is not a real directory.');
  }
  if (errno === 'EEXIST' || errno === 'ENOTEMPTY') {
    failAnchor('aggregate_run_identity_conflict', field, fallbackMessage);
  }
  failAnchor(fallback, field, fallbackMessage);
}

function assertSafeRootPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    failAnchor('aggregate_run_root_unsafe', 'root',
      'Aggregate run root must be an absolute directory path.');
  }
  if (!path.isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    failAnchor('aggregate_run_path_unsafe', 'root',
      'Aggregate run root must be an absolute, NUL-free path.');
  }
  if (value !== '/' && value.endsWith('/')) {
    failAnchor('aggregate_run_path_unsafe', 'root',
      'Aggregate run root must not end with a trailing slash.');
  }
  if (path.normalize(value) !== value) {
    failAnchor('aggregate_run_path_unsafe', 'root',
      'Aggregate run root must be a normalized absolute path.');
  }
  for (const part of value.split('/')) {
    if (part === '.' || part === '..') {
      failAnchor('aggregate_run_path_unsafe', 'root',
        'Aggregate run root must not contain "." or ".." segments.');
    }
  }
  return value;
}

function assertSafeChildName(name, field) {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..') {
    failAnchor('aggregate_run_foreign_entry', field, 'Aggregate run directory entry is not an allowed name.');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || path.basename(name) !== name) {
    failAnchor('aggregate_run_path_unsafe', field, 'Aggregate run names must be single path components.');
  }
  if (utf8ByteLength(name) > MAX_AGGREGATE_FILENAME_BYTES) {
    failAnchor('aggregate_run_foreign_entry', field, 'Aggregate run filename exceeds the bounded length.');
  }
  return name;
}

function childPath(rootPath, name) {
  const safe = assertSafeChildName(name, 'name');
  const joined = path.join(rootPath, safe);
  if (path.dirname(joined) !== rootPath || path.basename(joined) !== safe) {
    failAnchor('aggregate_run_path_unsafe', 'name', 'Aggregate run child path escaped the private root.');
  }
  return joined;
}

function ownerUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function sameIdentity(left, right) {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

function assertPrivateDirectory(stat, field, label) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    failAnchor('aggregate_run_root_unsafe', field, `The aggregate run ${label} must be a real directory.`);
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failAnchor('aggregate_run_root_unsafe', field, `The aggregate run ${label} must be owned by the current user.`);
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failAnchor('aggregate_run_root_unsafe', field,
      `The aggregate run ${label} must be private (no group or other access).`);
  }
}

function assertRegularUnsharedFile(stat, field) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    failAnchor('aggregate_run_not_regular', field, 'Aggregate run files must be regular non-symlink files.');
  }
  if (!NUMBER_IS_SAFE_INTEGER(stat.nlink) || stat.nlink !== 1) {
    failAnchor('aggregate_run_not_regular', field, 'Aggregate run files must not be hardlinked.');
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failAnchor('aggregate_run_root_unsafe', field, 'Aggregate run files must be owned by the current user.');
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failAnchor('aggregate_run_root_unsafe', field, 'Aggregate run files must be owner-only.');
  }
}

function swapCodeFor(label) {
  if (label === 'root') return 'aggregate_run_root_swapped';
  if (label === 'marker') return 'aggregate_run_marker_swapped';
  if (label === 'claims') return 'aggregate_run_claims_swapped';
  if (label === 'runs') return 'aggregate_run_runs_swapped';
  if (label === 'directory' || label === 'run') return 'aggregate_run_dir_swapped';
  if (label === 'claim') return 'aggregate_run_claim_swapped';
  return 'aggregate_run_root_swapped';
}

async function openDirectoryHandle(dirPath, field) {
  let handle;
  try {
    handle = await open(dirPath, ROOT_OPEN_FLAGS);
  } catch (error) {
    mapErrno(error, field, 'aggregate_run_root_unsafe',
      'The aggregate run directory could not be opened without following links.');
  }
  try {
    const stat = await handle.stat();
    assertPrivateDirectory(stat, field, field === 'root' ? 'root' : 'directory');
    return { handle, path: dirPath, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function reverifyDirectory(token, label) {
  const opened = await reopenDirectory(token, label);
  await opened.handle.close().catch(() => {});
}

async function reopenDirectory(token, label) {
  let opened;
  try {
    opened = await openDirectoryHandle(token.path, label);
  } catch (error) {
    if (error instanceof RunContractV1Error
      && (error.code === 'aggregate_run_root_missing' || error.code === 'aggregate_run_root_unsafe')) {
      failAnchor(swapCodeFor(label), label, `The aggregate run ${label} was replaced during use.`);
    }
    throw error;
  }
  try {
    if (!sameIdentity(opened, token)) {
      failAnchor(swapCodeFor(label), label, `The aggregate run ${label} was replaced during use.`);
    }
    return opened;
  } catch (error) {
    await opened.handle.close().catch(() => {});
    throw error;
  }
}

async function syncDirectory(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP') return;
    failAnchor('aggregate_run_unreadable', 'directory',
      'The aggregate run directory could not be synchronized.');
  }
}

async function enumerateDirectory(token, maxEntries, field) {
  let dir;
  try {
    dir = await opendir(token.path, { bufferSize: 16 });
  } catch (error) {
    mapErrno(error, field, 'aggregate_run_unreadable',
      'The aggregate run directory could not be enumerated.');
  }
  const names = [];
  try {
    let count = 0;
    while (true) {
      const entry = await dir.read();
      if (entry === null) break;
      count += 1;
      if (count > maxEntries) {
        failAnchor('aggregate_run_flood', field,
          `Aggregate run directories must not exceed ${maxEntries} entries.`);
      }
      if (entry.name === '.' || entry.name === '..') continue;
      names.push(assertSafeChildName(entry.name, field));
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return names;
}

async function readBoundedFile(dirToken, name, maxBytes, field) {
  const target = childPath(dirToken.path, name);
  let handle;
  try {
    handle = await open(target, FILE_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      failAnchor('aggregate_run_not_regular', field, 'Aggregate run files must be regular non-symlink files.');
    }
    mapErrno(error, field, 'aggregate_run_unreadable', 'The aggregate run file could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) > maxBytes) {
      failAnchor('aggregate_run_too_large', field, `Aggregate run files must not exceed ${maxBytes} bytes.`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      failAnchor('aggregate_run_too_large', field, `Aggregate run files must not exceed ${maxBytes} bytes.`);
    }
    const after = await handle.stat();
    if (!sameIdentity(stat, after) || Number(after.size) !== Number(stat.size)
      || Number(after.nlink) !== Number(stat.nlink)) {
      failAnchor('aggregate_run_unreadable', field, 'The aggregate run file changed while it was read.');
    }
    return { bytes, stat, path: target };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectFileIdentity(dirToken, name, field) {
  const opened = await readBoundedFile(dirToken, name, Number.MAX_SAFE_INTEGER, field);
  if (opened === null) return null;
  return { path: opened.path, dev: opened.stat.dev, ino: opened.stat.ino };
}

async function reopenFileIdentity(token, label, maxBytes, field) {
  const dirPath = path.dirname(token.path);
  const name = path.basename(token.path);
  const fakeDir = { path: dirPath };
  const opened = await readBoundedFile(fakeDir, name, maxBytes, field);
  if (opened === null) {
    failAnchor(swapCodeFor(label), label, `The aggregate run ${label} was replaced during use.`);
  }
  if (!sameIdentity(opened.stat, token)) {
    failAnchor(swapCodeFor(label), label, `The aggregate run ${label} was replaced during use.`);
  }
  return opened;
}

function equalBytes(left, right) {
  if (!NodeBuffer.isBuffer(left) || !NodeBuffer.isBuffer(right) || left.length !== right.length) {
    return false;
  }
  return TIMING_SAFE_EQUAL(left, right);
}

async function writePrivateTemp(dirToken, bytes, field) {
  const tempName = `.tmp-${RANDOM_BYTES(16).toString('hex')}`;
  const tempPath = childPath(dirToken.path, tempName);
  let handle;
  try {
    handle = await open(tempPath, FILE_CREATE_FLAGS, 0o600);
  } catch (error) {
    mapErrno(error, field, 'aggregate_run_unreadable', 'A private temporary file could not be created.');
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) !== bytes.byteLength) {
      failAnchor('aggregate_run_unreadable', field, 'Temporary write was truncated.');
    }
    return { name: tempName, path: tempPath, dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function atomicPublish(dirToken, finalName, bytes, field) {
  const temp = await writePrivateTemp(dirToken, bytes, field);
  const finalPath = childPath(dirToken.path, finalName);
  try {
    await rename(temp.path, finalPath);
  } catch (error) {
    await unlink(temp.path).catch(() => {});
    mapErrno(error, field, 'aggregate_run_unreadable',
      'The aggregate run file could not be published atomically.');
  }
  await syncDirectory(dirToken.handle);
  const reread = await readBoundedFile(dirToken, finalName, bytes.byteLength, field);
  if (reread === null || !equalBytes(reread.bytes, bytes) || !sameIdentity(reread.stat, temp)) {
    failAnchor('aggregate_run_unreadable', field, 'Detached or unverifiable publication is not success.');
  }
  return { path: reread.path, dev: reread.stat.dev, ino: reread.stat.ino };
}

async function exclusivePublish(dirToken, finalName, bytes, field) {
  const temp = await writePrivateTemp(dirToken, bytes, field);
  const finalPath = childPath(dirToken.path, finalName);
  try {
    await link(temp.path, finalPath);
  } catch (error) {
    await unlink(temp.path).catch(() => {});
    if (error?.code === 'EEXIST') return { published: false };
    if (error?.code === 'ELOOP') {
      failAnchor('aggregate_run_not_regular', field, 'Aggregate run files must be regular non-symlink files.');
    }
    mapErrno(error, field, 'aggregate_run_unreadable',
      'The aggregate run file could not be published exclusively.');
  }
  await unlink(temp.path).catch(() => {});
  await syncDirectory(dirToken.handle);
  const reread = await readBoundedFile(dirToken, finalName, bytes.byteLength, field);
  if (reread === null || !equalBytes(reread.bytes, bytes) || !sameIdentity(reread.stat, temp)) {
    failAnchor('aggregate_run_unreadable', field, 'Detached or unverifiable publication is not success.');
  }
  return { published: true, path: reread.path, dev: reread.stat.dev, ino: reread.stat.ino };
}

async function removeStaleTemporaries(dirToken, names) {
  let removed = 0;
  for (const name of names) {
    if (!capturedTest(TEMP_NAME_PATTERN, name) && !capturedTest(LOCK_OWNER_NAME_PATTERN, name)) {
      continue;
    }
    const target = childPath(dirToken.path, name);
    let handle;
    try {
      handle = await open(target, FILE_READ_FLAGS);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
        failAnchor('aggregate_run_not_regular', 'temporary',
          'A leftover temporary path is not a regular file and was not followed.');
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.isSymbolicLink() || !stat.isFile()) {
        failAnchor('aggregate_run_not_regular', 'temporary',
          'A leftover temporary path is not a regular file and was not followed.');
      }
    } finally {
      await handle.close().catch(() => {});
    }
    try {
      await unlink(target);
      removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (removed > 0) await syncDirectory(dirToken.handle);
  return removed;
}

function pidAlive(pid) {
  if (!NUMBER_IS_SAFE_INTEGER(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validLockPidShape(pid) {
  return NUMBER_IS_SAFE_INTEGER(pid) && pid >= 1 && pid <= 0xffffffff;
}

async function readLockFile(dirToken, schemaId) {
  const target = childPath(dirToken.path, LOCK_NAME);
  let handle;
  try {
    handle = await open(target, FILE_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') {
      failAnchor('aggregate_run_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    throw error;
  }
  let opened;
  try {
    const stat = await handle.stat();
    if (stat.isSymbolicLink() || !stat.isFile()) {
      failAnchor('aggregate_run_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    const uid = ownerUid();
    if (uid !== undefined && Number(stat.uid) !== uid) {
      failAnchor('aggregate_run_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    if ((Number(stat.mode) & 0o077) !== 0 || Number(stat.size) > MAX_AGGREGATE_LOCK_BYTES) {
      failAnchor('aggregate_run_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(stat, after) || Number(after.size) !== Number(stat.size)) return null;
    opened = { bytes, stat };
  } finally {
    await handle.close().catch(() => {});
  }
  let text;
  try {
    text = TEXT_DECODER.decode(opened.bytes);
  } catch {
    failAnchor('aggregate_run_lock_corrupt', LOCK_NAME,
      'The lock file is malformed and was not followed.');
  }
  let parsed;
  try {
    parsed = JSON_PARSE(text.endsWith('\n') ? text.slice(0, -1) : text);
  } catch {
    failAnchor('aggregate_run_lock_corrupt', LOCK_NAME,
      'The lock file is malformed and was not followed.');
  }
  const keys = parsed === null || typeof parsed !== 'object' ? [] : sortedCapturedKeys(parsed);
  if (text.length > MAX_AGGREGATE_LOCK_BYTES || keys.length !== 3
    || !keys.includes('schema') || !keys.includes('pid') || !keys.includes('nonce')
    || parsed.schema !== schemaId
    || !validLockPidShape(parsed.pid)
    || typeof parsed.nonce !== 'string'
    || !capturedTest(NONCE_PATTERN, parsed.nonce)) {
    failAnchor('aggregate_run_lock_corrupt', LOCK_NAME,
      'The lock file is malformed and was not followed.');
  }
  return { schema: parsed.schema, pid: parsed.pid, nonce: parsed.nonce, dev: opened.stat.dev, ino: opened.stat.ino };
}

async function lockAgeMs(dirToken) {
  let handle;
  try {
    handle = await open(childPath(dirToken.path, LOCK_NAME), FILE_READ_FLAGS);
  } catch {
    return 0;
  }
  try {
    const stat = await handle.stat();
    return Math.max(0, Date.now() - Number(stat.mtimeMs));
  } catch {
    return 0;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function acquireLock(dirToken, schemaId) {
  const deadline = Date.now() + AGGREGATE_LOCK_WAIT_MS;
  let steals = 0;
  while (true) {
    const ownerName = `.lock-${RANDOM_BYTES(16).toString('hex')}`;
    const ownerPath = childPath(dirToken.path, ownerName);
    const ownerBody = `${canonicalJsonStringify({
      schema: schemaId,
      pid: process.pid,
      nonce: RANDOM_BYTES(16).toString('hex'),
    })}\n`;
    let handle;
    try {
      handle = await open(ownerPath, FILE_CREATE_FLAGS, 0o600);
    } catch (error) {
      mapErrno(error, 'lock', 'aggregate_run_unreadable', 'The lock owner file could not be created.');
    }
    try {
      await handle.writeFile(ownerBody, 'utf8');
    } finally {
      await handle.close().catch(() => {});
    }
    let acquired = false;
    try {
      await link(ownerPath, childPath(dirToken.path, LOCK_NAME));
      acquired = true;
    } catch (error) {
      if (error?.code === 'ENOENT') acquired = false;
      else if (error?.code !== 'EEXIST') {
        await unlink(ownerPath).catch(() => {});
        mapErrno(error, 'lock', 'aggregate_run_unreadable', 'The lock could not be acquired exclusively.');
      }
    }
    await unlink(ownerPath).catch(() => {});
    if (acquired) {
      const held = await readLockFile(dirToken, schemaId);
      if (held === null || held.pid !== process.pid) {
        failAnchor('aggregate_run_lock_corrupt', LOCK_NAME, 'The acquired lock was replaced before use.');
      }
      return held;
    }
    const existing = await readLockFile(dirToken, schemaId);
    if (existing === null) continue;
    const ageMs = await lockAgeMs(dirToken);
    const stale = !pidAlive(existing.pid) || ageMs > AGGREGATE_LOCK_MAX_AGE_MS;
    if (stale && steals < MAX_AGGREGATE_LOCK_STEALS) {
      const current = await readLockFile(dirToken, schemaId).catch(() => null);
      if (current !== null && current.pid === existing.pid
        && Number(current.dev) === Number(existing.dev)
        && Number(current.ino) === Number(existing.ino)) {
        try {
          await unlink(childPath(dirToken.path, LOCK_NAME));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        steals += 1;
        continue;
      }
      continue;
    }
    if (Date.now() >= deadline) {
      failAnchor('aggregate_run_lock_timeout', LOCK_NAME,
        'The aggregate run lock stayed contended for the bounded wait.');
    }
    await sleep(AGGREGATE_LOCK_POLL_MS);
  }
}

async function releaseLock(dirToken, token, schemaId) {
  const held = await readLockFile(dirToken, schemaId).catch(() => null);
  if (held === null) return;
  if (held.nonce !== token.nonce
    || Number(held.dev) !== Number(token.dev)
    || Number(held.ino) !== Number(token.ino)) {
    return;
  }
  await unlink(childPath(dirToken.path, LOCK_NAME)).catch(() => {});
}

function decodeStrictUtf8(bytes, field) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbb) {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run files must not begin with a UTF-8 BOM.');
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run files must not begin with a UTF-8 BOM.');
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run files must be valid UTF-8.');
  }
}

function assertNoDuplicateJsonKeys(text, field) {
  if (typeof text !== 'string') {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run records must be UTF-8 JSON text.');
  }
  const scopes = [{ object: false, keys: new Set() }];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        const scope = scopes[scopes.length - 1];
        if (scope.object) {
          let cursor = index + 1;
          while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\n'
            || text[cursor] === '\r' || text[cursor] === '\t')) {
            cursor += 1;
          }
          if (text[cursor] === ':') {
            let key;
            try {
              key = JSON_PARSE(text.slice(stringStart - 1, index + 1));
            } catch {
              failAnchor('aggregate_run_malformed', field, 'Aggregate run JSON key is invalid.');
            }
            if (scope.keys.has(key)) {
              failAnchor('aggregate_run_duplicate_entry', field,
                'Aggregate run JSON objects must not contain duplicate keys.');
            }
            scope.keys.add(key);
          }
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index + 1;
      continue;
    }
    if (char === '{') {
      scopes.push({ object: true, keys: new Set() });
      if (scopes.length > 40) {
        failAnchor('aggregate_run_malformed', field, 'Aggregate run JSON exceeds the nesting bound.');
      }
      continue;
    }
    if (char === '[') {
      scopes.push({ object: false, keys: new Set() });
      if (scopes.length > 40) {
        failAnchor('aggregate_run_malformed', field, 'Aggregate run JSON exceeds the nesting bound.');
      }
      continue;
    }
    if (char === '}' || char === ']') {
      if (scopes.length <= 1) {
        failAnchor('aggregate_run_malformed', field, 'Aggregate run JSON is unbalanced.');
      }
      scopes.pop();
    }
  }
  if (inString || scopes.length !== 1) {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run JSON is incomplete.');
  }
}

function parseCanonicalObject(bytes, field, maxBytes) {
  if (!NodeBuffer.isBuffer(bytes) || bytes.byteLength === 0) {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run record is truncated.');
  }
  if (bytes.byteLength > maxBytes) {
    failAnchor('aggregate_run_too_large', field, 'Aggregate run file exceeds the bounded size.');
  }
  const text = decodeStrictUtf8(bytes, field);
  if (!text.endsWith('\n')) {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run records must end with a single newline.');
  }
  const body = text.slice(0, -1);
  assertNoDuplicateJsonKeys(body, field);
  let parsed;
  try {
    parsed = JSON_PARSE(body);
  } catch {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run record is not valid JSON.');
  }
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run record must be a JSON object.');
  }
  if (canonicalJsonStringify(parsed) !== body) {
    failAnchor('aggregate_run_malformed', field, 'Aggregate run records must be canonical UTF-8 JSON.');
  }
  assertDirectJsonClosure(parsed, field);
  return parsed;
}

function encodeRecord(record, maxBytes, field) {
  const bytes = BUFFER_FROM(`${canonicalJsonStringify(record)}\n`, 'utf8');
  if (bytes.byteLength > maxBytes) {
    failAnchor('aggregate_run_too_large', field, `Aggregate run records must not exceed ${maxBytes} bytes.`);
  }
  return bytes;
}

export function deriveAggregateSubmissionKeyV1(runId, git, manifestDigest) {
  assertRunId(runId, 'run_id');
  const boundGit = validateGitIdentityV1(git, 'git');
  assertHexDigest(manifestDigest, 'manifest_digest');
  return identityBoundDigest(IDENTITY_LABELS.AGGREGATE_SUBMISSION_IDEMPOTENCY, {
    schema: AGGREGATE_SUBMISSION_SCHEMA_ID,
    run_id: runId,
    git_digest: boundGit.digest,
    repository_path: boundGit.repository_path,
    base_sha: boundGit.base_sha,
    manifest_digest: manifestDigest,
  });
}

function bindMarkerPayload(nonce) {
  if (typeof nonce !== 'string' || !capturedTest(NONCE_PATTERN, nonce)) {
    failAnchor('invalid_format', 'nonce', 'Storage root nonce must be 32 lowercase hex characters.');
  }
  const payload = {
    schema: STORAGE_ROOT_SCHEMA_ID,
    kind: AGGREGATE_STORAGE_ROOT_KIND,
    nonce,
  };
  const canonicalDigest = identityBoundDigest(IDENTITY_LABELS.STORAGE_ROOT, payload);
  const record = snapshotRecord({ ...payload, canonical_digest: canonicalDigest });
  return { record, bytes: encodeRecord(record, MAX_AGGREGATE_MARKER_BYTES, MARKER_NAME) };
}

function parseStoredMarker(bytes, field = MARKER_NAME) {
  const parsed = parseCanonicalObject(bytes, field, MAX_AGGREGATE_MARKER_BYTES);
  const fields = closedObject(parsed, field, AGGREGATE_MARKER_KEYS);
  if (fields.schema !== STORAGE_ROOT_SCHEMA_ID) {
    failAnchor('aggregate_run_malformed', `${field}.schema`,
      `Storage root schema must be exactly "${STORAGE_ROOT_SCHEMA_ID}".`);
  }
  if (fields.kind !== AGGREGATE_STORAGE_ROOT_KIND) {
    failAnchor('aggregate_run_root_foreign', `${field}.kind`,
      'Storage root marker kind must be exactly aggregate_run_anchor.');
  }
  const rebuilt = bindMarkerPayload(fields.nonce);
  if (rebuilt.record.canonical_digest !== fields.canonical_digest
    || !equalBytes(rebuilt.bytes, bytes)) {
    failAnchor('aggregate_run_identity_mismatch', field,
      'Storage root marker digest does not match its canonical form.');
  }
  return rebuilt;
}

function bindClaimPayload(fields) {
  assertRunId(fields.run_id, 'run_id');
  assertBoundDigest(fields.anchor_digest, 'anchor_digest');
  assertBoundDigest(fields.submission_idempotency_key, 'submission_idempotency_key');
  assertBoundDigest(fields.root_marker_digest, 'root_marker_digest');
  if (typeof fields.root_marker_nonce !== 'string' || !capturedTest(NONCE_PATTERN, fields.root_marker_nonce)) {
    failAnchor('invalid_format', 'root_marker_nonce',
      'Claim root marker nonce must be 32 lowercase hex characters.');
  }
  if (typeof fields.nonce !== 'string' || !capturedTest(NONCE_PATTERN, fields.nonce)) {
    failAnchor('invalid_format', 'nonce', 'Claim nonce must be 32 lowercase hex characters.');
  }
  const payload = {
    schema: AGGREGATE_RUN_CLAIM_SCHEMA_ID,
    run_id: fields.run_id,
    anchor_digest: fields.anchor_digest,
    submission_idempotency_key: fields.submission_idempotency_key,
    root_marker_nonce: fields.root_marker_nonce,
    root_marker_digest: fields.root_marker_digest,
    nonce: fields.nonce,
  };
  const canonicalDigest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RUN_CLAIM, payload);
  const record = snapshotRecord({ ...payload, canonical_digest: canonicalDigest });
  return { record, bytes: encodeRecord(record, MAX_AGGREGATE_CLAIM_BYTES, 'claim') };
}

function parseStoredClaim(bytes, field = 'claim') {
  const parsed = parseCanonicalObject(bytes, field, MAX_AGGREGATE_CLAIM_BYTES);
  const fields = closedObject(parsed, field, AGGREGATE_CLAIM_KEYS);
  if (fields.schema !== AGGREGATE_RUN_CLAIM_SCHEMA_ID) {
    failAnchor('aggregate_run_malformed', `${field}.schema`,
      `Claim schema must be exactly "${AGGREGATE_RUN_CLAIM_SCHEMA_ID}".`);
  }
  const rebuilt = bindClaimPayload(fields);
  if (rebuilt.record.canonical_digest !== fields.canonical_digest
    || !equalBytes(rebuilt.bytes, bytes)) {
    failAnchor('aggregate_run_identity_mismatch', field,
      'Claim digest does not match its canonical form.');
  }
  return rebuilt;
}

function bindAnchorPayload(fields) {
  const identity = validateRunIdentityV1(fields.identity, 'identity');
  const git = validateGitIdentityV1(fields.git, 'git');
  assertSharedGitIdentityV1(identity.git, git, 'git');
  assertRunId(fields.run_id, 'run_id');
  assertHexDigest(fields.manifest_digest, 'manifest_digest');
  if (identity.run_id !== fields.run_id) {
    failAnchor('aggregate_run_identity_mismatch', 'run_id',
      'Aggregate run records must bind one run identity.');
  }
  if (identity.manifest_digest !== fields.manifest_digest) {
    failAnchor('aggregate_run_identity_mismatch', 'manifest_digest',
      'manifest_digest must equal the bound run identity manifest digest.');
  }
  if (identity.git.digest !== git.digest) {
    failAnchor('aggregate_run_identity_mismatch', 'git',
      'Git identity does not match the immutable repository/base authority.');
  }
  const submissionKey = deriveAggregateSubmissionKeyV1(fields.run_id, git, fields.manifest_digest);
  const payload = {
    schema: AGGREGATE_RUN_ANCHOR_SCHEMA_ID,
    run_id: fields.run_id,
    identity,
    git,
    manifest_digest: fields.manifest_digest,
    submission_idempotency_key: submissionKey,
  };
  const canonicalDigest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RUN_ANCHOR, payload);
  const record = snapshotRecord({ ...payload, canonical_digest: canonicalDigest });
  return { record, bytes: encodeRecord(record, MAX_AGGREGATE_ANCHOR_BYTES, 'anchor') };
}

export function validateAggregateRunAnchorV1(value, path = 'anchor') {
  const fields = closedObject(value, path, AGGREGATE_RUN_ANCHOR_KEYS);
  if (fields.schema !== AGGREGATE_RUN_ANCHOR_SCHEMA_ID) {
    failAnchor('invalid_format', `${path}.schema`,
      `Aggregate run anchor schema must be exactly "${AGGREGATE_RUN_ANCHOR_SCHEMA_ID}".`);
  }
  const rebuilt = bindAnchorPayload(fields);
  if (rebuilt.record.canonical_digest !== fields.canonical_digest) {
    failAnchor('aggregate_run_identity_mismatch', `${path}.canonical_digest`,
      'Anchor digest does not match its canonical form.');
  }
  return rebuilt.record;
}

function parseSubmitInput(input) {
  if (input === undefined || input === null) {
    failAnchor('invalid_type', 'record', 'Aggregate run submission must be a plain JSON data object.');
  }
  assertDirectJsonClosure(input, 'record');
  const fields = closedObject(input, 'record', AGGREGATE_RUN_ANCHOR_INPUT_KEYS);
  return bindAnchorPayload(fields);
}

function parseStoredAnchor(bytes, field = 'anchor') {
  const parsed = parseCanonicalObject(bytes, field, MAX_AGGREGATE_ANCHOR_BYTES);
  const record = validateAggregateRunAnchorV1(parsed, field);
  const rebuilt = bindAnchorPayload(record);
  if (!equalBytes(rebuilt.bytes, bytes)) {
    failAnchor('aggregate_run_identity_mismatch', field,
      'Stored canonical bytes do not match the recomputed anchor.');
  }
  return rebuilt;
}

function parseNullableDigest(value, field) {
  if (value === null) return null;
  assertBoundDigest(value, field);
  return value;
}

function parseSelectionBinding(value, runId, field) {
  if (value === null) return null;
  const fields = closedObject(value, field, AGGREGATE_SELECTION_BINDING_KEYS);
  assertRunId(fields.run_id, `${field}.run_id`);
  if (fields.run_id !== runId) {
    failAnchor('aggregate_run_identity_mismatch', `${field}.run_id`,
      'Selection request binding must name the bound run.');
  }
  if (typeof fields.request_id !== 'string' || !capturedTest(REQUEST_ID_PATTERN, fields.request_id)) {
    failAnchor('invalid_format', `${field}.request_id`, 'Selection request id must match sel-<32hex>.');
  }
  assertBoundDigest(fields.digest, `${field}.digest`);
  assertBoundDigest(fields.record_digest, `${field}.record_digest`);
  return snapshotRecord(fields);
}

function sameBinding(left, right) {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return left.run_id === right.run_id
    && left.request_id === right.request_id
    && left.digest === right.digest
    && left.record_digest === right.record_digest;
}

function bindCoordinationPayload(fields) {
  assertRunId(fields.run_id, 'run_id');
  assertBoundDigest(fields.anchor_digest, 'anchor_digest');
  if (!NUMBER_IS_SAFE_INTEGER(fields.revision) || fields.revision < 0 || fields.revision > 2) {
    failAnchor('invalid_format', 'revision', 'Coordination revision must be 0, 1, or 2.');
  }
  if (!capturedIncludes(AGGREGATE_RUN_PHASES, fields.phase)) {
    failAnchor('invalid_format', 'phase', 'Coordination phase is not a legal aggregate run phase.');
  }
  const binding = parseSelectionBinding(fields.selection_request_binding, fields.run_id,
    'selection_request_binding');
  const reply = parseNullableDigest(fields.selection_reply_digest, 'selection_reply_digest');
  const plan = parseNullableDigest(fields.resolved_plan_digest, 'resolved_plan_digest');
  if (fields.phase === 'submitted') {
    if (fields.revision !== 0 || binding !== null || reply !== null || plan !== null) {
      failAnchor('aggregate_run_phase_conflict', 'phase',
        'submitted coordination must be revision 0 with empty bindings.');
    }
  } else if (fields.phase === 'awaiting_selection') {
    if (fields.revision !== 1 || binding === null || reply !== null || plan !== null) {
      failAnchor('aggregate_run_phase_conflict', 'phase',
        'awaiting_selection coordination must be revision 1 with a request binding only.');
    }
  } else if (fields.revision === 2) {
    if (binding === null || reply === null || plan === null) {
      failAnchor('aggregate_run_phase_conflict', 'phase',
        'resolution_ready@2 must bind request, reply, and resolved plan.');
    }
  } else if (fields.revision === 1) {
    if (binding !== null || reply !== null || plan === null) {
      failAnchor('aggregate_run_phase_conflict', 'phase',
        'resolution_ready@1 must bind only a resolved plan.');
    }
  } else {
    failAnchor('aggregate_run_phase_conflict', 'revision',
      'resolution_ready revision must be 1 or 2.');
  }
  const payload = {
    schema: AGGREGATE_RUN_COORDINATION_SCHEMA_ID,
    run_id: fields.run_id,
    anchor_digest: fields.anchor_digest,
    revision: fields.revision,
    phase: fields.phase,
    selection_request_binding: binding,
    selection_reply_digest: reply,
    resolved_plan_digest: plan,
  };
  const stateDigest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RUN_COORDINATION, payload);
  const record = snapshotRecord({ ...payload, state_digest: stateDigest });
  return { record, bytes: encodeRecord(record, MAX_AGGREGATE_COORDINATION_BYTES, 'coordination') };
}

export function validateAggregateRunCoordinationV1(value, path = 'coordination') {
  const fields = closedObject(value, path, AGGREGATE_RUN_COORDINATION_KEYS);
  if (fields.schema !== AGGREGATE_RUN_COORDINATION_SCHEMA_ID) {
    failAnchor('invalid_format', `${path}.schema`,
      `Coordination schema must be exactly "${AGGREGATE_RUN_COORDINATION_SCHEMA_ID}".`);
  }
  const rebuilt = bindCoordinationPayload(fields);
  if (rebuilt.record.state_digest !== fields.state_digest) {
    failAnchor('aggregate_run_identity_mismatch', `${path}.state_digest`,
      'Coordination digest does not match its canonical form.');
  }
  return rebuilt.record;
}

function parseStoredCoordination(bytes, field = 'coordination') {
  const parsed = parseCanonicalObject(bytes, field, MAX_AGGREGATE_COORDINATION_BYTES);
  const record = validateAggregateRunCoordinationV1(parsed, field);
  const rebuilt = bindCoordinationPayload(record);
  if (!equalBytes(rebuilt.bytes, bytes)) {
    failAnchor('aggregate_run_identity_mismatch', field,
      'Stored canonical bytes do not match the recomputed coordination.');
  }
  return rebuilt;
}

function initialCoordination(anchor) {
  return bindCoordinationPayload({
    schema: AGGREGATE_RUN_COORDINATION_SCHEMA_ID,
    run_id: anchor.run_id,
    anchor_digest: anchor.canonical_digest,
    revision: 0,
    phase: 'submitted',
    selection_request_binding: null,
    selection_reply_digest: null,
    resolved_plan_digest: null,
  });
}

function stampRecord(runId, anchorDigest, nonceHex) {
  return {
    schema: AGGREGATE_RUN_STAMP_SCHEMA_ID,
    run_id: runId,
    record_canonical_digest: anchorDigest,
    nonce: nonceHex,
  };
}

function bindStampPayload(runId, anchorDigest, nonceHex) {
  assertRunId(runId, 'run_id');
  assertBoundDigest(anchorDigest, 'record_canonical_digest');
  if (typeof nonceHex !== 'string' || !capturedTest(NONCE_PATTERN, nonceHex)) {
    failAnchor('invalid_format', 'nonce', 'Creation stamp nonce must be 32 lowercase hex characters.');
  }
  const record = stampRecord(runId, anchorDigest, nonceHex);
  return { record, bytes: encodeRecord(record, MAX_AGGREGATE_STAMP_BYTES, STAMP_NAME) };
}

async function verifyCreationStamp(dirToken, binding, claimNonce) {
  const rebound = () => failAnchor('aggregate_run_dir_swapped', STAMP_NAME,
    'The run directory is not the private aggregate run created for this claim.');
  let expected;
  try {
    expected = bindStampPayload(binding.run_id, binding.canonical_digest, claimNonce);
  } catch (error) {
    if (error instanceof RunContractV1Error) rebound();
    throw error;
  }
  const opened = await readBoundedFile(dirToken, STAMP_NAME, MAX_AGGREGATE_STAMP_BYTES, STAMP_NAME);
  if (opened === null || !equalBytes(opened.bytes, expected.bytes)) rebound();
}

function classifyRootName(name) {
  if (name === MARKER_NAME) return 'marker';
  if (name === CLAIMS_NAME) return 'claims';
  if (name === RUNS_NAME) return 'runs';
  if (name === LOCK_NAME) return 'lock';
  if (capturedTest(TEMP_NAME_PATTERN, name) || capturedTest(LOCK_OWNER_NAME_PATTERN, name)) return 'temp';
  return 'foreign';
}

function classifyUnmarkedRoot(names) {
  if (names.length === 0) return 'empty';
  let sawP24 = false;
  let sawRuns = false;
  for (const name of names) {
    if (capturedTest(TEMP_NAME_PATTERN, name) || capturedTest(LOCK_OWNER_NAME_PATTERN, name)) continue;
    if (capturedTest(P24_RECORD_NAME_PATTERN, name) || capturedTest(P24_KEY_NAME_PATTERN, name)) {
      sawP24 = true;
      continue;
    }
    if (name === RUNS_NAME) {
      sawRuns = true;
      continue;
    }
    return 'foreign';
  }
  if (sawP24) return 'p24';
  if (sawRuns) return 'p25';
  return 'foreign';
}

async function mkdirExclusive(target, field) {
  try {
    await mkdir(target, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    mapErrno(error, field, 'aggregate_run_unreadable', 'The aggregate run directory could not be created.');
  }
}

async function ensurePrivateDirectory(parent, name, field) {
  const target = childPath(parent.path, name);
  await mkdirExclusive(target, field);
  const opened = await openDirectoryHandle(target, field);
  return opened;
}

function withRootChain(token, operation) {
  const id = `${STRING(token.dev)}:${STRING(token.ino)}`;
  const previous = ROOT_CHAINS.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.catch(() => {}).then(() => {
    if (ROOT_CHAINS.get(id) === settled) ROOT_CHAINS.delete(id);
  });
  ROOT_CHAINS.set(id, settled);
  return current;
}

async function readAndParseMarker(rootToken) {
  const opened = await readBoundedFile(rootToken, MARKER_NAME, MAX_AGGREGATE_MARKER_BYTES, 'marker');
  if (opened === null) return null;
  const parsed = parseStoredMarker(opened.bytes);
  return { ...parsed, stat: opened.stat, path: opened.path };
}

async function auditMarkedRoot(rootToken, { createMissing = false } = {}) {
  const names = await enumerateDirectory(rootToken, MAX_AGGREGATE_ROOT_ENTRIES, 'root');
  const marker = await readAndParseMarker(rootToken);
  if (marker === null) {
    const kind = classifyUnmarkedRoot(names);
    if (kind === 'empty') {
      failAnchor('aggregate_run_root_uninitialized', 'root',
        'The aggregate run root has not been initialized.');
    }
    if (kind === 'p24' || kind === 'p25') {
      failAnchor('aggregate_run_root_shared', 'root',
        'The aggregate run root must be separate from accepted P24 and P25 roots.');
    }
    failAnchor('aggregate_run_root_foreign', 'root',
      'The aggregate run root contains a foreign layout.');
  }
  const allowed = [];
  for (const name of names) {
    const kind = classifyRootName(name);
    if (kind === 'foreign') {
      failAnchor('aggregate_run_root_foreign', 'root',
        'The aggregate run root contains a foreign entry.');
    }
    if (kind === 'temp') allowed.push(name);
    else allowed.push(name);
  }
  await removeStaleTemporaries(rootToken, names);
  let claims = null;
  let runs = null;
  if (!names.includes(CLAIMS_NAME)) {
    if (!createMissing) {
      failAnchor('aggregate_run_root_unreadable', 'claims',
        'The initialized aggregate run root is missing its claims directory.');
    }
    claims = await ensurePrivateDirectory(rootToken, CLAIMS_NAME, 'claims');
  } else {
    claims = await openDirectoryHandle(childPath(rootToken.path, CLAIMS_NAME), 'claims');
  }
  try {
    if (!names.includes(RUNS_NAME)) {
      if (!createMissing) {
        failAnchor('aggregate_run_root_unreadable', 'runs',
          'The initialized aggregate run root is missing its runs directory.');
      }
      runs = await ensurePrivateDirectory(rootToken, RUNS_NAME, 'runs');
    } else {
      runs = await openDirectoryHandle(childPath(rootToken.path, RUNS_NAME), 'runs');
    }
  } catch (error) {
    await claims.handle.close().catch(() => {});
    throw error;
  }
  return { marker, claims, runs };
}

function claimNameFor(runId) {
  assertRunId(runId, 'run_id');
  return `${runId}.json`;
}

async function auditNamespace(claimsToken, runsToken) {
  const claimNames = await enumerateDirectory(claimsToken, MAX_AGGREGATE_CLAIMS_DIRECTORY_ENTRIES, 'claims');
  const runNames = await enumerateDirectory(runsToken, MAX_AGGREGATE_RUNS_DIRECTORY_ENTRIES, 'runs');
  const claimTemps = [];
  const claims = [];
  for (const name of claimNames) {
    if (capturedTest(TEMP_NAME_PATTERN, name) || capturedTest(LOCK_OWNER_NAME_PATTERN, name)
      || name === LOCK_NAME) {
      claimTemps.push(name);
      continue;
    }
    if (!name.endsWith('.json')) {
      failAnchor('aggregate_run_foreign_entry', 'claims',
        'The claims directory contains a foreign entry.');
    }
    const runId = name.slice(0, -'.json'.length);
    assertRunId(runId, 'claims');
    claims.push(runId);
  }
  await removeStaleTemporaries(claimsToken, claimTemps);
  const runTemps = [];
  const runs = [];
  for (const name of runNames) {
    if (capturedTest(TEMP_NAME_PATTERN, name) || capturedTest(LOCK_OWNER_NAME_PATTERN, name)
      || name === LOCK_NAME) {
      runTemps.push(name);
      continue;
    }
    assertRunId(name, 'runs');
    const child = await openDirectoryHandle(childPath(runsToken.path, name), 'runs');
    await child.handle.close().catch(() => {});
    runs.push(name);
  }
  await removeStaleTemporaries(runsToken, runTemps);
  if (claims.length > MAX_AGGREGATE_RUNS || runs.length > MAX_AGGREGATE_RUNS) {
    failAnchor('aggregate_run_flood', 'runs',
      `The aggregate run root must not exceed ${MAX_AGGREGATE_RUNS} runs.`);
  }
  return { claims, runs };
}

function allowedRunFile(name) {
  return name === ANCHOR_NAME || name === COORDINATION_NAME || name === STAMP_NAME
    || name === LOCK_NAME || name === REQUEST_RECORD_NAME || name === REPLY_RECORD_NAME
    || name === PLAN_RECORD_NAME
    || capturedTest(TEMP_NAME_PATTERN, name)
    || capturedTest(LOCK_OWNER_NAME_PATTERN, name);
}

async function auditRunLayout(dirToken) {
  const names = await enumerateDirectory(dirToken, MAX_AGGREGATE_RUN_DIRECTORY_ENTRIES, 'directory');
  const temporaries = [];
  for (const name of names) {
    if (capturedTest(TEMP_NAME_PATTERN, name) || capturedTest(LOCK_OWNER_NAME_PATTERN, name)) {
      temporaries.push(name);
      continue;
    }
    if (!allowedRunFile(name)) {
      failAnchor('aggregate_run_foreign_entry', 'directory',
        'The aggregate run directory contains a foreign entry.');
    }
  }
  return { names, temporaries };
}

function durableRunFileNames(names) {
  return names.filter((name) => !capturedTest(TEMP_NAME_PATTERN, name)
    && !capturedTest(LOCK_OWNER_NAME_PATTERN, name) && name !== LOCK_NAME);
}

function classifyExactSubmitPrefix(names) {
  const durable = durableRunFileNames(names);
  if (durable.length === 0) return 'empty';
  const set = new Set(durable);
  if (durable.length === 1 && set.has(ANCHOR_NAME)) return 'anchor';
  if (durable.length === 2 && set.has(ANCHOR_NAME) && set.has(COORDINATION_NAME)) {
    return 'anchor_coordination';
  }
  return null;
}

async function publishExactIfAbsent(dirToken, name, bytes, maxBytes, field, mismatchCode, mismatchMessage) {
  const existing = await readBoundedFile(dirToken, name, maxBytes, field);
  if (existing !== null) {
    if (!equalBytes(existing.bytes, bytes)) {
      failAnchor(mismatchCode, field, mismatchMessage);
    }
    return { published: false };
  }
  const published = await exclusivePublish(dirToken, name, bytes, field);
  if (published.published) return { published: true };
  const raced = await readBoundedFile(dirToken, name, maxBytes, field);
  if (raced === null) {
    failAnchor('aggregate_run_unreadable', field, 'An existing aggregate run file could not be verified.');
  }
  if (!equalBytes(raced.bytes, bytes)) {
    failAnchor(mismatchCode, field, mismatchMessage);
  }
  return { published: false };
}

async function loadCompleteRun(dirToken, runId, claimRecord) {
  const cleaned = await auditRunLayout(dirToken);
  await removeStaleTemporaries(dirToken, cleaned.temporaries);
  const names = durableRunFileNames(cleaned.names);
  if (!names.includes(ANCHOR_NAME) || !names.includes(COORDINATION_NAME) || !names.includes(STAMP_NAME)) {
    return { complete: false, names };
  }
  const anchorOpened = await readBoundedFile(dirToken, ANCHOR_NAME, MAX_AGGREGATE_ANCHOR_BYTES, ANCHOR_NAME);
  const coordOpened = await readBoundedFile(dirToken, COORDINATION_NAME, MAX_AGGREGATE_COORDINATION_BYTES,
    COORDINATION_NAME);
  if (anchorOpened === null || coordOpened === null) {
    failAnchor('aggregate_run_record_corruption', 'directory',
      'A committed aggregate run file is missing.');
  }
  const anchor = parseStoredAnchor(anchorOpened.bytes);
  const coordination = parseStoredCoordination(coordOpened.bytes);
  if (anchor.record.run_id !== runId || coordination.record.run_id !== runId) {
    failAnchor('aggregate_run_identity_mismatch', 'run_id',
      'Stored aggregate run files do not bind the claimed run id.');
  }
  if (coordination.record.anchor_digest !== anchor.record.canonical_digest) {
    failAnchor('aggregate_run_identity_mismatch', 'anchor_digest',
      'Coordination does not bind the stored anchor digest.');
  }
  if (claimRecord.anchor_digest !== anchor.record.canonical_digest
    || claimRecord.run_id !== runId) {
    failAnchor('aggregate_run_identity_mismatch', 'claim',
      'The durable claim does not match the stored aggregate anchor.');
  }
  await verifyCreationStamp(dirToken, anchor.record, claimRecord.nonce);
  await verifyReferencedRecords(dirToken, coordination.record);
  return {
    complete: true,
    names,
    anchor,
    coordination,
    anchorIdentity: { path: anchorOpened.path, dev: anchorOpened.stat.dev, ino: anchorOpened.stat.ino },
  };
}

async function assertExactSubmitPrefix(dirToken, prepared, prefixKind) {
  if (prefixKind === 'empty') return;
  const anchorOpened = await readBoundedFile(dirToken, ANCHOR_NAME, MAX_AGGREGATE_ANCHOR_BYTES, ANCHOR_NAME);
  if (anchorOpened === null) {
    failAnchor('aggregate_run_unreadable', ANCHOR_NAME,
      'An existing aggregate run file could not be verified.');
  }
  parseStoredAnchor(anchorOpened.bytes);
  if (!equalBytes(anchorOpened.bytes, prepared.bytes)) {
    failAnchor('aggregate_run_identity_conflict', ANCHOR_NAME,
      'Run id already binds a different aggregate anchor.');
  }
  if (prefixKind !== 'anchor_coordination') return;
  const expectedCoord = initialCoordination(prepared.record);
  const coordOpened = await readBoundedFile(dirToken, COORDINATION_NAME, MAX_AGGREGATE_COORDINATION_BYTES,
    COORDINATION_NAME);
  if (coordOpened === null) {
    failAnchor('aggregate_run_unreadable', COORDINATION_NAME,
      'An existing coordination file could not be verified.');
  }
  parseStoredCoordination(coordOpened.bytes);
  if (!equalBytes(coordOpened.bytes, expectedCoord.bytes)) {
    failAnchor('aggregate_run_unreadable', COORDINATION_NAME,
      'An existing coordination file could not be verified.');
  }
}

async function publishInitialRunFiles(dirToken, prepared, claimRecord) {
  const existing = await loadCompleteRun(dirToken, prepared.record.run_id, claimRecord);
  if (existing.complete) {
    if (existing.anchor.record.canonical_digest !== prepared.record.canonical_digest) {
      failAnchor('aggregate_run_identity_conflict', 'run_id',
        'Run id already binds a different aggregate anchor.');
    }
    return { created: false, anchor: existing.anchor, coordination: existing.coordination };
  }
  const prefixKind = classifyExactSubmitPrefix(existing.names);
  if (prefixKind === null) {
    failAnchor('aggregate_run_unreadable', 'directory',
      'The claimed run directory is not a complete aggregate run.');
  }
  await assertExactSubmitPrefix(dirToken, prepared, prefixKind);
  const coord = initialCoordination(prepared.record);
  const stamp = bindStampPayload(
    prepared.record.run_id,
    prepared.record.canonical_digest,
    claimRecord.nonce,
  );
  if (prefixKind === 'empty') {
    await publishExactIfAbsent(dirToken, ANCHOR_NAME, prepared.bytes, MAX_AGGREGATE_ANCHOR_BYTES,
      ANCHOR_NAME, 'aggregate_run_identity_conflict',
      'Run id already binds a different aggregate anchor.');
  }
  if (prefixKind === 'empty' || prefixKind === 'anchor') {
    await publishExactIfAbsent(dirToken, COORDINATION_NAME, coord.bytes, MAX_AGGREGATE_COORDINATION_BYTES,
      COORDINATION_NAME, 'aggregate_run_unreadable',
      'An existing coordination file could not be verified.');
  }
  await publishExactIfAbsent(dirToken, STAMP_NAME, stamp.bytes, MAX_AGGREGATE_STAMP_BYTES,
    STAMP_NAME, 'aggregate_run_dir_swapped',
    'The run directory is not the private aggregate run created for this claim.');
  const loaded = await loadCompleteRun(dirToken, prepared.record.run_id, claimRecord);
  if (!loaded.complete) {
    failAnchor('aggregate_run_unreadable', 'directory', 'Published aggregate run files did not verify.');
  }
  return { created: true, anchor: loaded.anchor, coordination: loaded.coordination };
}

function claimsMatch(existing, prepared, marker) {
  return existing.run_id === prepared.record.run_id
    && existing.anchor_digest === prepared.record.canonical_digest
    && existing.submission_idempotency_key === prepared.record.submission_idempotency_key
    && existing.root_marker_nonce === marker.record.nonce
    && existing.root_marker_digest === marker.record.canonical_digest;
}

function conflictExistingClaim(existing, prepared, marker) {
  if (claimsMatch(existing, prepared, marker)) return null;
  if (existing.submission_idempotency_key === prepared.record.submission_idempotency_key
    && existing.anchor_digest !== prepared.record.canonical_digest) {
    failAnchor('aggregate_run_idempotency_conflict', 'submission_idempotency_key',
      'Submission key already binds a different aggregate anchor.');
  }
  failAnchor('aggregate_run_identity_conflict', 'run_id',
    'Run id already binds a different aggregate claim.');
}

async function readClaim(claimsToken, runId) {
  const opened = await readBoundedFile(claimsToken, claimNameFor(runId), MAX_AGGREGATE_CLAIM_BYTES, 'claim');
  if (opened === null) return null;
  const parsed = parseStoredClaim(opened.bytes);
  return { ...parsed, stat: opened.stat, path: opened.path };
}

async function completeSubmit(ctx, prepared) {
  const { root, marker, claims, runs } = ctx;
  const namespace = await auditNamespace(claims, runs);
  const runId = prepared.record.run_id;
  const hasClaim = namespace.claims.includes(runId);
  const hasRun = namespace.runs.includes(runId);
  if (hasRun && !hasClaim) {
    failAnchor('aggregate_run_claim_conflict', 'run_id',
      'An empty or foreign run directory without an exact durable claim is never adopted.');
  }
  let claimRecord;
  let claimIdentity;
  if (!hasClaim) {
    if (namespace.claims.length >= MAX_AGGREGATE_RUNS) {
      failAnchor('aggregate_run_flood', 'claims',
        `The aggregate run root must not exceed ${MAX_AGGREGATE_RUNS} claims.`);
    }
    const claim = bindClaimPayload({
      schema: AGGREGATE_RUN_CLAIM_SCHEMA_ID,
      run_id: runId,
      anchor_digest: prepared.record.canonical_digest,
      submission_idempotency_key: prepared.record.submission_idempotency_key,
      root_marker_nonce: marker.record.nonce,
      root_marker_digest: marker.record.canonical_digest,
      nonce: RANDOM_BYTES(16).toString('hex'),
    });
    const published = await exclusivePublish(claims, claimNameFor(runId), claim.bytes, 'claim');
    if (!published.published) {
      const existing = await readClaim(claims, runId);
      if (existing === null) {
        failAnchor('aggregate_run_unreadable', 'claim', 'A concurrent claim could not be read.');
      }
      conflictExistingClaim(existing.record, prepared, marker);
      claimRecord = existing.record;
      claimIdentity = { path: existing.path, dev: existing.stat.dev, ino: existing.stat.ino };
    } else {
      claimRecord = claim.record;
      claimIdentity = { path: published.path, dev: published.dev, ino: published.ino };
    }
  } else {
    const existing = await readClaim(claims, runId);
    if (existing === null) {
      failAnchor('aggregate_run_unreadable', 'claim', 'A durable claim could not be read.');
    }
    conflictExistingClaim(existing.record, prepared, marker);
    claimRecord = existing.record;
    claimIdentity = { path: existing.path, dev: existing.stat.dev, ino: existing.stat.ino };
  }

  const runPath = childPath(runs.path, runId);
  if (!hasRun) {
    await mkdirExclusive(runPath, 'run_id');
    await syncDirectory(runs.handle);
  }
  const dirToken = await openDirectoryHandle(runPath, 'directory');
  let runLock = null;
  try {
    runLock = await acquireLock(dirToken, AGGREGATE_RUN_LOCK_SCHEMA_ID);
    const result = await publishInitialRunFiles(dirToken, prepared, claimRecord);
    await reverifyDirectory(root, 'root');
    await reverifyDirectory(claims, 'claims');
    await reverifyDirectory(runs, 'runs');
    await reverifyDirectory(dirToken, 'directory');
    await reopenFileIdentity(claimIdentity, 'claim', MAX_AGGREGATE_CLAIM_BYTES, 'claim');
    const markerAfter = await readAndParseMarker(root);
    if (markerAfter === null || markerAfter.record.canonical_digest !== marker.record.canonical_digest
      || !sameIdentity(markerAfter.stat, marker.stat)) {
      failAnchor('aggregate_run_marker_swapped', 'marker',
        'The aggregate run marker was replaced during use.');
    }
    return snapshotRecord({
      created: result.created,
      record: result.anchor.record,
      coordination: result.coordination.record,
      claim: claimRecord,
    });
  } finally {
    if (runLock !== null) await releaseLock(dirToken, runLock, AGGREGATE_RUN_LOCK_SCHEMA_ID);
    await dirToken.handle.close().catch(() => {});
  }
}

function parseRequestIdentity(value, runId, field) {
  const fields = closedObject(value, field, AGGREGATE_REQUEST_IDENTITY_KEYS);
  assertRunId(fields.run_id, `${field}.run_id`);
  if (fields.run_id !== runId) {
    failAnchor('aggregate_run_identity_mismatch', `${field}.run_id`,
      'Request identity must name the bound run.');
  }
  if (typeof fields.request_id !== 'string' || !capturedTest(REQUEST_ID_PATTERN, fields.request_id)) {
    failAnchor('invalid_format', `${field}.request_id`, 'Request identity id must match sel-<32hex>.');
  }
  assertBoundDigest(fields.digest, `${field}.digest`);
  return snapshotRecord(fields);
}

function bindSelectionRequestRecord(runId, requestIdentity, record) {
  if (record === undefined || record === null) {
    failAnchor('invalid_type', 'record', 'Selection request record must be a plain JSON data object.');
  }
  assertDirectJsonClosure(record, 'record');
  validateSelectionRequestV1(record);
  const identity = selectionRequestIdentity(record);
  if (identity.run_id !== runId || requestIdentity.run_id !== runId) {
    failAnchor('aggregate_run_identity_mismatch', 'request_identity.run_id',
      'Selection request record must bind the aggregate run id.');
  }
  if (identity.request_id !== requestIdentity.request_id || identity.digest !== requestIdentity.digest) {
    failAnchor('aggregate_run_identity_mismatch', 'request_identity',
      'Request identity does not match the canonical selection request record.');
  }
  const bytes = encodeRecord(record, MAX_AGGREGATE_RECORD_BYTES, REQUEST_RECORD_NAME);
  const recordDigest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RUN_ANCHOR, {
    schema: 'codex-co-engineer.aggregate-request-record.v1',
    run_id: runId,
    request_id: identity.request_id,
    digest: identity.digest,
    body: record,
  });
  return {
    record: snapshotRecord(record),
    bytes,
    identity,
    recordDigest,
    binding: snapshotRecord({
      run_id: runId,
      request_id: identity.request_id,
      digest: identity.digest,
      record_digest: recordDigest,
    }),
  };
}

function bindReplyRecord(runId, requestIdentity, record) {
  if (record === undefined || record === null) {
    failAnchor('invalid_type', 'reply_record', 'Selection reply record must be a plain JSON data object.');
  }
  assertDirectJsonClosure(record, 'reply_record');
  const fields = closedObject(record, 'reply_record', AGGREGATE_SELECTION_REPLY_INPUT_KEYS);
  if (fields.schema !== AGGREGATE_SELECTION_REPLY_SCHEMA_ID) {
    failAnchor('invalid_format', 'reply_record.schema',
      `Selection reply schema must be exactly "${AGGREGATE_SELECTION_REPLY_SCHEMA_ID}".`);
  }
  assertRunId(fields.run_id, 'reply_record.run_id');
  if (fields.run_id !== runId) {
    failAnchor('aggregate_run_identity_mismatch', 'reply_record.run_id',
      'Selection reply record must bind the aggregate run id.');
  }
  if (fields.request_id !== requestIdentity.request_id) {
    failAnchor('aggregate_run_identity_mismatch', 'reply_record.request_id',
      'Selection reply record must bind the committed request id.');
  }
  if (!Array.isArray(fields.answers)) {
    failAnchor('invalid_type', 'reply_record.answers', 'Selection reply answers must be a dense JSON array.');
  }
  const answers = [];
  for (let index = 0; index < fields.answers.length; index += 1) {
    const answer = closedObject(fields.answers[index], `reply_record.answers[${index}]`,
      SELECTION_ANSWER_KEYS);
    answers.push(snapshotRecord(answer));
  }
  const payload = {
    schema: AGGREGATE_SELECTION_REPLY_SCHEMA_ID,
    run_id: fields.run_id,
    request_id: fields.request_id,
    answers,
  };
  const canonicalDigest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_SELECTION_REPLY, payload);
  const stored = snapshotRecord({ ...payload, canonical_digest: canonicalDigest });
  return { record: stored, bytes: encodeRecord(stored, MAX_AGGREGATE_RECORD_BYTES, REPLY_RECORD_NAME) };
}

function bindPlanRecord(runId, record) {
  if (record === undefined || record === null) {
    failAnchor('invalid_type', 'resolved_plan_record',
      'Resolved plan record must be a plain JSON data object.');
  }
  assertDirectJsonClosure(record, 'resolved_plan_record');
  const fields = closedObject(record, 'resolved_plan_record', AGGREGATE_RESOLVED_PLAN_INPUT_KEYS);
  if (fields.schema !== AGGREGATE_RESOLVED_PLAN_SCHEMA_ID) {
    failAnchor('invalid_format', 'resolved_plan_record.schema',
      `Resolved plan schema must be exactly "${AGGREGATE_RESOLVED_PLAN_SCHEMA_ID}".`);
  }
  assertRunId(fields.run_id, 'resolved_plan_record.run_id');
  if (fields.run_id !== runId) {
    failAnchor('aggregate_run_identity_mismatch', 'resolved_plan_record.run_id',
      'Resolved plan record must bind the aggregate run id.');
  }
  if (fields.complete !== true) {
    failAnchor('aggregate_run_phase_conflict', 'resolved_plan_record.complete',
      'Resolved plan records must be complete.');
  }
  const payload = {
    schema: AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
    run_id: fields.run_id,
    complete: true,
  };
  const canonicalDigest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RESOLVED_PLAN, payload);
  const stored = snapshotRecord({ ...payload, canonical_digest: canonicalDigest });
  return { record: stored, bytes: encodeRecord(stored, MAX_AGGREGATE_RECORD_BYTES, PLAN_RECORD_NAME) };
}

async function adoptOrPublishRecord(dirToken, name, prepared, field) {
  const existing = await readBoundedFile(dirToken, name, MAX_AGGREGATE_RECORD_BYTES, field);
  if (existing === null) {
    const published = await exclusivePublish(dirToken, name, prepared.bytes, field);
    if (published.published) return { created: true, record: prepared.record };
    const raced = await readBoundedFile(dirToken, name, MAX_AGGREGATE_RECORD_BYTES, field);
    if (raced === null) {
      failAnchor('aggregate_run_record_corruption', field, 'A committed record could not be read.');
    }
    if (!equalBytes(raced.bytes, prepared.bytes)) {
      failAnchor('aggregate_run_orphan_conflict', field,
        'A differing orphan record conflicts permanently.');
    }
    return { created: false, record: prepared.record };
  }
  if (!equalBytes(existing.bytes, prepared.bytes)) {
    failAnchor('aggregate_run_orphan_conflict', field,
      'A differing orphan record conflicts permanently.');
  }
  return { created: false, record: prepared.record };
}

function assertExpectedRevision(value, expected, field) {
  if (!capturedHasOwn({ expected_revision: value }, 'expected_revision') && value === undefined) {
    failAnchor('missing_key', field, 'expected_revision is mandatory.');
  }
  if (!NUMBER_IS_SAFE_INTEGER(value)) {
    failAnchor('invalid_format', field, 'expected_revision must be an exact safe integer.');
  }
  if (value !== expected) {
    failAnchor('aggregate_run_revision_conflict', field,
      'The expected revision does not match the committed coordination head.');
  }
}

function corruptCommitted(field, message) {
  failAnchor('aggregate_run_record_corruption', field, message);
}

async function verifyCommittedRecord(dirToken, name, digest, field, kind) {
  const opened = await readBoundedFile(dirToken, name, MAX_AGGREGATE_RECORD_BYTES, field);
  if (opened === null) {
    corruptCommitted(field, 'A committed aggregate record is missing.');
  }
  let parsed;
  try {
    parsed = parseCanonicalObject(opened.bytes, field, MAX_AGGREGATE_RECORD_BYTES);
  } catch (error) {
    if (error instanceof RunContractV1Error) {
      corruptCommitted(field, 'A committed aggregate record is malformed.');
    }
    throw error;
  }
  if (kind === 'request') {
    try {
      validateSelectionRequestV1(parsed);
    } catch (error) {
      if (error instanceof RunContractV1Error) {
        corruptCommitted(field, 'A committed selection request record failed verification.');
      }
      throw error;
    }
    const identity = selectionRequestIdentity(parsed);
    const recordDigest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RUN_ANCHOR, {
      schema: 'codex-co-engineer.aggregate-request-record.v1',
      run_id: identity.run_id,
      request_id: identity.request_id,
      digest: identity.digest,
      body: parsed,
    });
    if (recordDigest !== digest || !equalBytes(encodeRecord(parsed, MAX_AGGREGATE_RECORD_BYTES, field), opened.bytes)) {
      corruptCommitted(field, 'A committed selection request record digest does not match.');
    }
    return;
  }
  if (kind === 'reply') {
    let rebuilt;
    try {
      rebuilt = bindReplyRecord(parsed.run_id, { request_id: parsed.request_id }, {
        schema: parsed.schema,
        run_id: parsed.run_id,
        request_id: parsed.request_id,
        answers: parsed.answers,
      });
    } catch (error) {
      if (error instanceof RunContractV1Error) {
        corruptCommitted(field, 'A committed selection reply record is malformed.');
      }
      throw error;
    }
    if (rebuilt.record.canonical_digest !== digest || !equalBytes(rebuilt.bytes, opened.bytes)) {
      corruptCommitted(field, 'A committed selection reply record digest does not match.');
    }
    return;
  }
  let rebuilt;
  try {
    rebuilt = bindPlanRecord(parsed.run_id, {
      schema: parsed.schema,
      run_id: parsed.run_id,
      complete: parsed.complete,
    });
  } catch (error) {
    if (error instanceof RunContractV1Error) {
      corruptCommitted(field, 'A committed resolved plan record is malformed.');
    }
    throw error;
  }
  if (rebuilt.record.canonical_digest !== digest || !equalBytes(rebuilt.bytes, opened.bytes)) {
    corruptCommitted(field, 'A committed resolved plan record digest does not match.');
  }
}

async function verifyReferencedRecords(dirToken, coordination) {
  if (coordination.selection_request_binding !== null) {
    await verifyCommittedRecord(dirToken, REQUEST_RECORD_NAME,
      coordination.selection_request_binding.record_digest, REQUEST_RECORD_NAME, 'request');
  }
  if (coordination.selection_reply_digest !== null) {
    await verifyCommittedRecord(dirToken, REPLY_RECORD_NAME,
      coordination.selection_reply_digest, REPLY_RECORD_NAME, 'reply');
  }
  if (coordination.resolved_plan_digest !== null) {
    await verifyCommittedRecord(dirToken, PLAN_RECORD_NAME,
      coordination.resolved_plan_digest, PLAN_RECORD_NAME, 'plan');
  }
}

async function mutateRun(ctx, runId, mutator) {
  const { root, marker, claims, runs } = ctx;
  const namespace = await auditNamespace(claims, runs);
  if (!namespace.claims.includes(runId)) {
    failAnchor('aggregate_run_not_found', 'run_id', 'No aggregate run exists for that run id.');
  }
  const claim = await readClaim(claims, runId);
  if (claim === null) {
    failAnchor('aggregate_run_not_found', 'claim', 'No durable claim exists for that run id.');
  }
  if (claim.record.root_marker_digest !== marker.record.canonical_digest
    || claim.record.root_marker_nonce !== marker.record.nonce) {
    failAnchor('aggregate_run_identity_mismatch', 'claim',
      'The durable claim does not bind this storage root marker.');
  }
  if (!namespace.runs.includes(runId)) {
    failAnchor('aggregate_run_not_found', 'run_id',
      'A durable claim without a complete run directory is not yet an aggregate run.');
  }
  const dirToken = await openDirectoryHandle(childPath(runs.path, runId), 'directory');
  let runLock = null;
  try {
    runLock = await acquireLock(dirToken, AGGREGATE_RUN_LOCK_SCHEMA_ID);
    const loaded = await loadCompleteRun(dirToken, runId, claim.record);
    if (!loaded.complete) {
      failAnchor('aggregate_run_unreadable', 'directory',
        'The claimed run directory is not a complete aggregate run.');
    }
    const result = await mutator(dirToken, loaded);
    await reverifyDirectory(root, 'root');
    await reverifyDirectory(claims, 'claims');
    await reverifyDirectory(runs, 'runs');
    await reverifyDirectory(dirToken, 'directory');
    await reopenFileIdentity({ path: claim.path, dev: claim.stat.dev, ino: claim.stat.ino },
      'claim', MAX_AGGREGATE_CLAIM_BYTES, 'claim');
    const markerAfter = await readAndParseMarker(root);
    if (markerAfter === null || !sameIdentity(markerAfter.stat, marker.stat)
      || markerAfter.record.canonical_digest !== marker.record.canonical_digest) {
      failAnchor('aggregate_run_marker_swapped', 'marker',
        'The aggregate run marker was replaced during use.');
    }
    return result;
  } finally {
    if (runLock !== null) await releaseLock(dirToken, runLock, AGGREGATE_RUN_LOCK_SCHEMA_ID);
    await dirToken.handle.close().catch(() => {});
  }
}

async function publishCoordination(dirToken, next) {
  await atomicPublish(dirToken, COORDINATION_NAME, next.bytes, COORDINATION_NAME);
  const verified = await readBoundedFile(dirToken, COORDINATION_NAME, MAX_AGGREGATE_COORDINATION_BYTES,
    COORDINATION_NAME);
  if (verified === null || !equalBytes(verified.bytes, next.bytes)) {
    failAnchor('aggregate_run_unreadable', COORDINATION_NAME,
      'Published coordination record did not verify.');
  }
  return parseStoredCoordination(verified.bytes);
}

function assertCapturedIdentities(token, audited) {
  if (audited.marker.record.canonical_digest !== token.marker_digest
    || audited.marker.record.nonce !== token.marker_nonce
    || !sameIdentity(audited.marker.stat, { dev: token.marker_dev, ino: token.marker_ino })) {
    failAnchor('aggregate_run_marker_swapped', 'marker',
      'The aggregate run marker was replaced during use.');
  }
  if (!sameIdentity(audited.claims, { dev: token.claims_dev, ino: token.claims_ino })) {
    failAnchor('aggregate_run_claims_swapped', 'claims',
      'The aggregate run claims directory was replaced during use.');
  }
  if (!sameIdentity(audited.runs, { dev: token.runs_dev, ino: token.runs_ino })) {
    failAnchor('aggregate_run_runs_swapped', 'runs',
      'The aggregate run runs directory was replaced during use.');
  }
}

function assembleHandle(rootToken, auditedOpen) {
  const token = capturedFreeze({
    path: rootToken.path,
    dev: rootToken.dev,
    ino: rootToken.ino,
    marker_digest: auditedOpen.marker.record.canonical_digest,
    marker_nonce: auditedOpen.marker.record.nonce,
    marker_dev: auditedOpen.marker.stat.dev,
    marker_ino: auditedOpen.marker.stat.ino,
    claims_dev: auditedOpen.claims.dev,
    claims_ino: auditedOpen.claims.ino,
    runs_dev: auditedOpen.runs.dev,
    runs_ino: auditedOpen.runs.ino,
  });

  async function operate(fn) {
    return withRootChain(token, async () => {
      const root = await reopenDirectory(token, 'root');
      let namespaceLock = null;
      let claims = null;
      let runs = null;
      try {
        const audited = await auditMarkedRoot(root, { createMissing: false });
        claims = audited.claims;
        runs = audited.runs;
        assertCapturedIdentities(token, audited);
        namespaceLock = await acquireLock(root, AGGREGATE_NAMESPACE_LOCK_SCHEMA_ID);
        const ctx = {
          root,
          marker: audited.marker,
          claims,
          runs,
        };
        const result = await fn(ctx);
        const rootAfter = await reopenDirectory(token, 'root');
        try {
          const auditedAfter = await auditMarkedRoot(rootAfter, { createMissing: false });
          try {
            assertCapturedIdentities(token, auditedAfter);
          } finally {
            await auditedAfter.claims.handle.close().catch(() => {});
            await auditedAfter.runs.handle.close().catch(() => {});
          }
        } finally {
          await rootAfter.handle.close().catch(() => {});
        }
        return result;
      } finally {
        if (namespaceLock !== null) await releaseLock(root, namespaceLock, AGGREGATE_NAMESPACE_LOCK_SCHEMA_ID);
        if (claims !== null) await claims.handle.close().catch(() => {});
        if (runs !== null) await runs.handle.close().catch(() => {});
        await root.handle.close().catch(() => {});
      }
    });
  }

  return capturedFreeze({
    root: token.path,
    marker_digest: token.marker_digest,
    async submit(input) {
      const prepared = parseSubmitInput(input);
      return operate((ctx) => completeSubmit(ctx, prepared));
    },
    async getByRunId(runId) {
      assertRunId(runId, 'run_id');
      return operate(async (ctx) => {
        const loaded = await mutateRun(ctx, runId, async (_dir, current) => current);
        return loaded.anchor.record;
      });
    },
    async getCoordination(runId) {
      assertRunId(runId, 'run_id');
      return operate(async (ctx) => {
        const loaded = await mutateRun(ctx, runId, async (_dir, current) => current);
        return loaded.coordination.record;
      });
    },
    async commitSelectionRequest(input) {
      if (input === undefined || input === null) {
        failAnchor('invalid_type', 'commit', 'commitSelectionRequest requires a plain JSON object.');
      }
      assertDirectJsonClosure(input, 'commit');
      const fields = closedObject(input, 'commit', AGGREGATE_COMMIT_REQUEST_KEYS);
      assertRunId(fields.run_id, 'run_id');
      const requestIdentity = parseRequestIdentity(fields.request_identity, fields.run_id, 'request_identity');
      const prepared = bindSelectionRequestRecord(fields.run_id, requestIdentity, fields.record);
      return operate((ctx) => mutateRun(ctx, fields.run_id, async (dirToken, loaded) => {
        assertExpectedRevision(fields.expected_revision, 0, 'expected_revision');
        const current = loaded.coordination.record;
        if (current.phase === 'awaiting_selection' && sameBinding(current.selection_request_binding, prepared.binding)) {
          await verifyCommittedRecord(dirToken, REQUEST_RECORD_NAME, prepared.recordDigest,
            REQUEST_RECORD_NAME, 'request');
          return snapshotRecord({
            created: false,
            record: loaded.anchor.record,
            coordination: current,
          });
        }
        if (current.phase !== 'submitted' || current.revision !== 0) {
          failAnchor('aggregate_run_revision_conflict', 'expected_revision',
            'commitSelectionRequest requires submitted@0.');
        }
        await adoptOrPublishRecord(dirToken, REQUEST_RECORD_NAME, prepared, REQUEST_RECORD_NAME);
        const next = bindCoordinationPayload({
          schema: AGGREGATE_RUN_COORDINATION_SCHEMA_ID,
          run_id: current.run_id,
          anchor_digest: current.anchor_digest,
          revision: 1,
          phase: 'awaiting_selection',
          selection_request_binding: prepared.binding,
          selection_reply_digest: null,
          resolved_plan_digest: null,
        });
        const coordination = await publishCoordination(dirToken, next);
        return snapshotRecord({
          created: true,
          record: loaded.anchor.record,
          coordination: coordination.record,
        });
      }));
    },
    async commitSelectionResolution(input) {
      if (input === undefined || input === null) {
        failAnchor('invalid_type', 'commit', 'commitSelectionResolution requires a plain JSON object.');
      }
      assertDirectJsonClosure(input, 'commit');
      const fields = closedObject(input, 'commit', AGGREGATE_COMMIT_RESOLUTION_KEYS);
      assertRunId(fields.run_id, 'run_id');
      const requestIdentity = parseRequestIdentity(fields.request_identity, fields.run_id, 'request_identity');
      const reply = bindReplyRecord(fields.run_id, requestIdentity, fields.reply_record);
      const plan = bindPlanRecord(fields.run_id, fields.resolved_plan_record);
      return operate((ctx) => mutateRun(ctx, fields.run_id, async (dirToken, loaded) => {
        assertExpectedRevision(fields.expected_revision, 1, 'expected_revision');
        const current = loaded.coordination.record;
        if (current.phase === 'resolution_ready' && current.revision === 2
          && current.selection_reply_digest === reply.record.canonical_digest
          && current.resolved_plan_digest === plan.record.canonical_digest
          && current.selection_request_binding !== null
          && current.selection_request_binding.request_id === requestIdentity.request_id
          && current.selection_request_binding.digest === requestIdentity.digest) {
          return snapshotRecord({
            created: false,
            record: loaded.anchor.record,
            coordination: current,
          });
        }
        if (current.phase !== 'awaiting_selection' || current.revision !== 1) {
          failAnchor('aggregate_run_revision_conflict', 'expected_revision',
            'commitSelectionResolution requires awaiting_selection@1.');
        }
        if (current.selection_request_binding.request_id !== requestIdentity.request_id
          || current.selection_request_binding.digest !== requestIdentity.digest
          || current.selection_request_binding.run_id !== requestIdentity.run_id) {
          failAnchor('aggregate_run_binding_conflict', 'request_identity',
            'Resolution must bind the committed selection request identity.');
        }
        await adoptOrPublishRecord(dirToken, REPLY_RECORD_NAME, reply, REPLY_RECORD_NAME);
        await adoptOrPublishRecord(dirToken, PLAN_RECORD_NAME, plan, PLAN_RECORD_NAME);
        const next = bindCoordinationPayload({
          schema: AGGREGATE_RUN_COORDINATION_SCHEMA_ID,
          run_id: current.run_id,
          anchor_digest: current.anchor_digest,
          revision: 2,
          phase: 'resolution_ready',
          selection_request_binding: current.selection_request_binding,
          selection_reply_digest: reply.record.canonical_digest,
          resolved_plan_digest: plan.record.canonical_digest,
        });
        const coordination = await publishCoordination(dirToken, next);
        return snapshotRecord({
          created: true,
          record: loaded.anchor.record,
          coordination: coordination.record,
        });
      }));
    },
    async commitResolvedPlan(input) {
      if (input === undefined || input === null) {
        failAnchor('invalid_type', 'commit', 'commitResolvedPlan requires a plain JSON object.');
      }
      assertDirectJsonClosure(input, 'commit');
      const fields = closedObject(input, 'commit', AGGREGATE_COMMIT_PLAN_KEYS);
      assertRunId(fields.run_id, 'run_id');
      const plan = bindPlanRecord(fields.run_id, fields.resolved_plan_record);
      return operate((ctx) => mutateRun(ctx, fields.run_id, async (dirToken, loaded) => {
        assertExpectedRevision(fields.expected_revision, 0, 'expected_revision');
        const current = loaded.coordination.record;
        if (current.phase === 'resolution_ready' && current.revision === 1
          && current.resolved_plan_digest === plan.record.canonical_digest
          && current.selection_request_binding === null) {
          return snapshotRecord({
            created: false,
            record: loaded.anchor.record,
            coordination: current,
          });
        }
        if (current.phase !== 'submitted' || current.revision !== 0) {
          failAnchor('aggregate_run_revision_conflict', 'expected_revision',
            'commitResolvedPlan requires submitted@0.');
        }
        await adoptOrPublishRecord(dirToken, PLAN_RECORD_NAME, plan, PLAN_RECORD_NAME);
        const next = bindCoordinationPayload({
          schema: AGGREGATE_RUN_COORDINATION_SCHEMA_ID,
          run_id: current.run_id,
          anchor_digest: current.anchor_digest,
          revision: 1,
          phase: 'resolution_ready',
          selection_request_binding: null,
          selection_reply_digest: null,
          resolved_plan_digest: plan.record.canonical_digest,
        });
        const coordination = await publishCoordination(dirToken, next);
        return snapshotRecord({
          created: true,
          record: loaded.anchor.record,
          coordination: coordination.record,
        });
      }));
    },
  });
}

async function openMarkedRoot(rootPath, { initialize = false } = {}) {
  const resolved = assertSafeRootPath(rootPath);
  const opened = await openDirectoryHandle(resolved, 'root');
  try {
    if (initialize) {
      const names = await enumerateDirectory(opened, MAX_AGGREGATE_ROOT_ENTRIES, 'root');
      if (names.length !== 0) {
        const kind = classifyUnmarkedRoot(names);
        if (kind === 'p24' || kind === 'p25') {
          failAnchor('aggregate_run_root_shared', 'root',
            'The aggregate run root must be separate from accepted P24 and P25 roots.');
        }
        failAnchor('aggregate_run_root_foreign', 'root',
          'initializeAggregateRunAnchorRoot requires a completely empty private root.');
      }
      const marker = bindMarkerPayload(RANDOM_BYTES(16).toString('hex'));
      const published = await exclusivePublish(opened, MARKER_NAME, marker.bytes, 'marker');
      if (!published.published) {
        failAnchor('aggregate_run_identity_conflict', 'root',
          'The aggregate run root marker could not be published exclusively.');
      }
      await ensurePrivateDirectory(opened, CLAIMS_NAME, 'claims').then((token) => token.handle.close());
      await ensurePrivateDirectory(opened, RUNS_NAME, 'runs').then((token) => token.handle.close());
      await syncDirectory(opened.handle);
    }
    const audited = await auditMarkedRoot(opened, { createMissing: initialize });
    try {
      return assembleHandle(opened, audited);
    } finally {
      await audited.claims.handle.close().catch(() => {});
      await audited.runs.handle.close().catch(() => {});
    }
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function initializeAggregateRunAnchorRoot(rootPath) {
  return openMarkedRoot(rootPath, { initialize: true });
}

export async function openAggregateRunAnchor(rootPath) {
  return openMarkedRoot(rootPath, { initialize: false });
}

capturedFreeze(initializeAggregateRunAnchorRoot);
capturedFreeze(openAggregateRunAnchor);
capturedFreeze(deriveAggregateSubmissionKeyV1);
capturedFreeze(validateAggregateRunAnchorV1);
capturedFreeze(validateAggregateRunCoordinationV1);
