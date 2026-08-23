// Durable append-only run journal, cursor paging, and torn-tail healing (P25)
// plus the R25B aggregate resolution binding.
//
// Additive v3 module. Legacy create/open/append/read first binds an exact
// validated accepted-P24 durable run record (the `openRunStore(...)` handle
// plus the `getByRunId` result) by run identity and canonical digest, then
// operates on one per-run private directory inside a separate caller-supplied
// existing private journal root. The P24 store root is never written to and
// sharing it as the journal root fails closed, because the accepted P24 flat
// root rejects foreign entries.
//
// Aggregate create/open is a distinct entrypoint. It binds the same P25
// journal root/run identity to an exact validated R24A aggregate anchor that
// is already resolution_ready, with its marker/claim/anchor/coordination/
// resolved-plan identity durably verified. It writes stamp v2 and never
// claims a P24 record. Legacy open never claims aggregate state; aggregate
// open never claims legacy state. There is no migration, cross-open, root
// adoption, empty-root inference, or legacy-to-aggregate fallback.
//
// Storage layout (all paths derived only from validated identifiers):
//   <root>/runs/<run_id>/journal.jsonl   append-only bounded canonical JSONL
//   <root>/runs/<run_id>/state.json      atomically published derived state
//   <root>/runs/<run_id>/lock            advisory cross-process lock file
//   <root>/runs/<run_id>/.tmp-<32hex>    same-directory private temporaries
//
// Entries form a domain-separated SHA-256 hash chain with dense sequences.
// Appends serialize in-process and across processes through the lock, support
// compare-and-swap `expected_seq`, exact dedupe of the head entry, typed
// replay conflicts, and full lattice validation before any byte is written.
// Publication is crash-safe: same-directory temporary, complete write, file
// fsync, atomic rename, directory fsync, then the derived state is published
// the same way. A crash can therefore only leave an unpublished temporary or
// a stale state cache; a torn final line without its newline terminator is
// healed by truncation under the lock, while any committed corruption,
// regression, malformed or foreign entry, symlink, hardlink, root swap, or
// flood fails hard. Cursors are opaque run-bound checksummed tokens; pages
// are bounded and diagnostics are content-free counts.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
import {
  AGGREGATE_CLAIM_KEYS,
  AGGREGATE_MARKER_KEYS,
  AGGREGATE_RESOLVED_PLAN_KEYS,
  AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
  AGGREGATE_RUN_CLAIM_SCHEMA_ID,
  AGGREGATE_RUN_STAMP_SCHEMA_ID,
  AGGREGATE_STORAGE_ROOT_KIND,
  MAX_AGGREGATE_CLAIM_BYTES,
  MAX_AGGREGATE_MARKER_BYTES,
  MAX_AGGREGATE_RECORD_BYTES,
  MAX_AGGREGATE_STAMP_BYTES,
  STORAGE_ROOT_SCHEMA_ID,
  validateAggregateRunAnchorV1,
  validateAggregateRunCoordinationV1,
} from './aggregate-run-anchor.mjs';
import { IDENTITY_LABELS, canonicalJsonStringify } from './identity.mjs';
import {
  assertBoundDigest,
  assertSharedGitIdentityV1,
  closedObject,
  fail,
  snapshotRecord,
  validateGitIdentityV1,
  validateRunIdentityV1,
} from './protected-identity.mjs';
import {
  projectDispatchTelemetryV1,
  validateDispatchProvenanceV1,
  validateDispatchTelemetryV1,
} from './protected-telemetry.mjs';
import { RunContractV1Error, assertRunId, utf8ByteLength } from './run-manifest.mjs';
import {
  RUN_JOURNAL_ENTRY_SCHEMA_ID,
  RUN_JOURNAL_GENESIS_PREV,
  RUN_JOURNAL_HASH_DOMAIN,
  applyRunJournalEntryV1,
  reduceRunJournalEntriesV1,
  validateRunJournalEventDataV1,
  validateRunJournalEntryV1,
  validateRunJournalStateV1,
} from './run-reducer.mjs';
import { RUN_STORE_RECORD_KEYS, RUN_STORE_RECORD_SCHEMA_ID } from './run-store.mjs';
import {
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  freezeData,
  identityBoundDigest,
} from './selection-json.mjs';

export const RUN_JOURNAL_LOCK_SCHEMA_ID = 'codex-co-engineer.run-journal-lock.v1';
export const RUN_JOURNAL_STAMP_SCHEMA_ID = 'codex-co-engineer.run-journal-created.v1';
export const RUN_JOURNAL_STAMP_SCHEMA_ID_V2 = 'codex-co-engineer.run-journal-created.v2';
export const RUN_JOURNAL_CURSOR_DOMAIN = 'codex-co-engineer.run-journal-cursor.v1';
export const RUN_JOURNAL_AGGREGATE_BINDING_DOMAIN =
  'codex-co-engineer.run-journal-aggregate-binding.v1';
export const RUN_JOURNAL_AGGREGATE_BINDING_KEYS = capturedFreeze([
  'run_id', 'marker_digest', 'claim_digest', 'anchor_digest',
  'coordination_digest', 'resolved_plan_digest', 'phase', 'revision',
]);
export const RUN_JOURNAL_AGGREGATE_BINDING_RECORD_KEYS = capturedFreeze([
  ...RUN_JOURNAL_AGGREGATE_BINDING_KEYS, 'binding_digest',
]);

export const MAX_RUN_JOURNAL_ENTRIES = 512;
export const MAX_RUN_JOURNAL_ENTRY_BYTES = 4096;
export const MAX_RUN_JOURNAL_FILE_BYTES = MAX_RUN_JOURNAL_ENTRIES * (MAX_RUN_JOURNAL_ENTRY_BYTES + 1);
export const MAX_RUN_JOURNAL_PAGE_EVENTS = 64;
export const MAX_RUN_JOURNAL_PAGE_BYTES = 65_536;
export const MAX_RUN_DIRECTORIES = 256;
export const MAX_RUN_JOURNAL_STATE_BYTES = 262_144;
export const MAX_RUN_JOURNAL_CURSOR_CHARS = 512;
export const MAX_RUN_JOURNAL_TEMPORARIES = 8;
export const MAX_RUN_JOURNAL_DIRECTORY_ENTRIES = 16;
export const MAX_RUN_JOURNAL_ROOT_ENTRIES = 8;
export const MAX_RUN_JOURNAL_LOCK_BYTES = 160;
export const MAX_RUN_JOURNAL_STAMP_BYTES = 384;
export const MAX_RUN_JOURNAL_DIAGNOSTIC_BYTES = 160;
export const RUN_JOURNAL_LOCK_WAIT_MS = 2_000;
export const RUN_JOURNAL_LOCK_POLL_MS = 10;
export const RUN_JOURNAL_LOCK_MAX_AGE_MS = 30_000;
export const MAX_RUN_JOURNAL_LOCK_STEALS = 4;

const JOURNAL_NAME = 'journal.jsonl';
const STATE_NAME = 'state.json';
const LOCK_NAME = 'lock';
const STAMP_NAME = 'created.json';
const AGGREGATE_MARKER_NAME = 'storage-root.v1';
const AGGREGATE_CLAIMS_NAME = 'claims';
const AGGREGATE_RUNS_NAME = 'runs';
const AGGREGATE_PLAN_RECORD_NAME = 'resolved-plan.record.json';
const AGGREGATE_STAMP_NAME = 'created.json';
const TEMP_NAME_PATTERN = /^\.tmp-[0-9a-f]{32}$/u;
const LOCK_OWNER_NAME_PATTERN = /^\.lock-[0-9a-f]{32}$/u;
const HEX_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const JOURNAL_MODE_LEGACY = 'legacy';
const JOURNAL_MODE_AGGREGATE = 'aggregate';
const HASH_ALGORITHM = 'sha256';
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const CREATE_HASH = createHash;
const RANDOM_BYTES = randomBytes;
const TIMING_SAFE_EQUAL = timingSafeEqual;
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
const FILE_WRITE_FLAGS = fsConstants.O_RDWR
  | (fsConstants.O_NOFOLLOW ?? 0);

const MAX_AUDIT_ATTEMPTS = 24;

const JOURNAL_CHAINS = new Map();

// Internal-only signal: the observed bytes were replaced atomically while
// being read. Callers retry; it never escapes the module.
class JournalVolatility extends Error {}

function diagnostic(value) {
  const text = STRING(value ?? '');
  return text.length <= MAX_RUN_JOURNAL_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_RUN_JOURNAL_DIAGNOSTIC_BYTES);
}

function failJournal(code, field, message) {
  fail(code, field, diagnostic(message));
}

function mapErrno(error, field, code, message) {
  if (error instanceof RunContractV1Error) throw error;
  const errno = error?.code;
  if (errno === 'ENOENT') failJournal('run_journal_not_found', field, 'The run journal path does not exist.');
  if (errno === 'ELOOP' || errno === 'ENOTDIR') {
    failJournal('run_journal_unsafe_path', field, 'The run journal path is not a real directory entry.');
  }
  failJournal(code, field, message);
}

// ---------------------------------------------------------------------------
// Path and filesystem safety
// ---------------------------------------------------------------------------

function assertSafeRootPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    failJournal('run_journal_unsafe_path', 'root', 'Journal root must be an absolute directory path.');
  }
  if (!path.isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    failJournal('run_journal_path_unsafe', 'root', 'Journal root must be an absolute, NUL-free path.');
  }
  if (value !== '/' && value.endsWith('/')) {
    failJournal('run_journal_path_unsafe', 'root', 'Journal root must not end with a trailing slash.');
  }
  if (path.normalize(value) !== value) {
    failJournal('run_journal_path_unsafe', 'root', 'Journal root must be a normalized absolute path.');
  }
  for (const part of value.split('/')) {
    if (part === '.' || part === '..') {
      failJournal('run_journal_path_unsafe', 'root', 'Journal root must not contain "." or ".." segments.');
    }
  }
  return value;
}

function assertSafeChildName(name, field) {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..') {
    failJournal('run_journal_foreign_entry', field, 'Journal directory entry is not an allowed name.');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || path.basename(name) !== name) {
    failJournal('run_journal_path_unsafe', field, 'Journal names must be single path components.');
  }
  if (utf8ByteLength(name) > 80) {
    failJournal('run_journal_foreign_entry', field, 'Journal filename exceeds the bounded length.');
  }
  return name;
}

function childPath(rootPath, name) {
  const safe = assertSafeChildName(name, 'name');
  const joined = path.join(rootPath, safe);
  if (path.dirname(joined) !== rootPath || path.basename(joined) !== safe) {
    failJournal('run_journal_path_unsafe', 'name', 'Journal child path escaped the private root.');
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
    failJournal('run_journal_unsafe_path', field, `The journal ${label} must be a real directory.`);
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failJournal('run_journal_unsafe_path', field, `The journal ${label} must be owned by the current user.`);
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failJournal('run_journal_unsafe_path', field,
      `The journal ${label} must be private (no group or other access).`);
  }
}

function assertRegularUnsharedFile(stat, field) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    failJournal('run_journal_not_regular', field, 'Journal files must be regular non-symlink files.');
  }
  if (!NUMBER_IS_SAFE_INTEGER(stat.nlink) || stat.nlink !== 1) {
    failJournal('run_journal_not_regular', field, 'Journal files must not be hardlinked.');
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failJournal('run_journal_unsafe_path', field, 'Journal files must be owned by the current user.');
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failJournal('run_journal_unsafe_path', field, 'Journal files must be owner-only.');
  }
}

async function openDirectoryHandle(dirPath, field) {
  let handle;
  try {
    handle = await open(dirPath, ROOT_OPEN_FLAGS);
  } catch (error) {
    mapErrno(error, field, 'run_journal_unsafe_path', 'The journal directory could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    assertPrivateDirectory(stat, field, 'directory');
    return { handle, path: dirPath, dev: stat.dev, ino: stat.ino, mode: stat.mode };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function reopenAndVerify(token, label) {
  let opened;
  try {
    opened = await openDirectoryHandle(token.path, label);
  } catch (error) {
    if (error instanceof RunContractV1Error
      && (error.code === 'run_journal_not_found' || error.code === 'run_journal_unsafe_path')) {
      failJournal('run_journal_root_swapped', label, `The journal ${label} was replaced during use.`);
    }
    throw error;
  }
  try {
    if (!sameIdentity(opened, token)) {
      failJournal('run_journal_root_swapped', label, `The journal ${label} was replaced during use.`);
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
    failJournal('run_journal_io_failed', 'directory', 'The journal directory could not be synchronized.');
  }
}

async function enumerateDirectory(token, maxEntries, field) {
  let dir;
  try {
    dir = await opendir(token.path, { bufferSize: 16 });
  } catch (error) {
    mapErrno(error, field, 'run_journal_io_failed', 'The journal directory could not be enumerated.');
  }
  const names = [];
  try {
    let count = 0;
    while (true) {
      const entry = await dir.read();
      if (entry === null) break;
      count += 1;
      if (count > maxEntries) {
        failJournal('run_journal_flood', field,
          `Journal directories must not exceed ${maxEntries} entries.`);
      }
      if (entry.name === '.' || entry.name === '..') continue;
      names.push(assertSafeChildName(entry.name, field));
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return names;
}

async function readBoundedFile(dirToken, name, maxBytes, field, volatile = false) {
  const target = childPath(dirToken.path, name);
  let handle;
  try {
    handle = await open(target, FILE_READ_FLAGS);
  } catch (error) {
    // A missing file is a legitimate observation (fresh journal); only
    // instability after a successful open signals an atomic replacement.
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      failJournal('run_journal_not_regular', field, 'Journal files must be regular non-symlink files.');
    }
    mapErrno(error, field, 'run_journal_io_failed', 'The journal file could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) > maxBytes) {
      failJournal('run_journal_file_too_large', field,
        `Journal files must not exceed ${maxBytes} bytes.`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      failJournal('run_journal_file_too_large', field,
        `Journal files must not exceed ${maxBytes} bytes.`);
    }
    const after = await handle.stat();
    if (!sameIdentity(stat, after) || Number(after.size) !== Number(stat.size)
      || Number(after.nlink) !== Number(stat.nlink)) {
      if (volatile || Number(after.nlink) === 0) throw new JournalVolatility('replaced');
      failJournal('run_journal_io_failed', field, 'The journal file changed while it was read.');
    }
    return { bytes, stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectChildFile(dirToken, name, field, volatile = false) {
  const target = childPath(dirToken.path, name);
  let handle;
  try {
    handle = await open(target, FILE_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (volatile) throw new JournalVolatility('inspect-vanished');
      return { kind: 'missing' };
    }
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      failJournal('run_journal_not_regular', field, 'Journal entries must be regular non-symlink files.');
    }
    mapErrno(error, field, 'run_journal_io_failed', 'The journal entry could not be inspected.');
  }
  try {
    const stat = await handle.stat();
    if (stat.isSymbolicLink() || !stat.isFile()) {
      failJournal('run_journal_not_regular', field, 'Journal entries must be regular non-symlink files.');
    }
    return { kind: 'file', stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

function isJournalVolatility(error) {
  return error instanceof JournalVolatility;
}

async function atomicPublish(dirToken, finalName, bytes, field) {
  const tempName = `.tmp-${RANDOM_BYTES(16).toString('hex')}`;
  const tempPath = childPath(dirToken.path, tempName);
  const finalPath = childPath(dirToken.path, finalName);
  let handle;
  try {
    handle = await open(tempPath, FILE_CREATE_FLAGS, 0o600);
  } catch (error) {
    mapErrno(error, field, 'run_journal_io_failed', 'A private temporary file could not be created.');
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) !== bytes.byteLength) {
      failJournal('run_journal_io_failed', field, 'Temporary write was truncated.');
    }
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    mapErrno(error, field, 'run_journal_io_failed', 'The journal file could not be published atomically.');
  }
  await syncDirectory(dirToken.handle);
  return tempName;
}

async function removeStaleTemporaries(dirToken, names) {
  let removed = 0;
  for (const name of names) {
    if (!capturedTest(TEMP_NAME_PATTERN, name)) continue;
    const target = childPath(dirToken.path, name);
    let handle;
    try {
      handle = await open(target, FILE_READ_FLAGS);
    } catch (error) {
      if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
        failJournal('run_journal_torn_temporary', 'temporary',
          'A leftover temporary path is not a regular file and was not followed.');
      }
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.isSymbolicLink() || !stat.isFile()) {
        failJournal('run_journal_torn_temporary', 'temporary',
          'A leftover temporary path is not a regular file and was not followed.');
      }
      const uid = ownerUid();
      if (uid !== undefined && Number(stat.uid) !== uid) {
        failJournal('run_journal_torn_temporary', 'temporary',
          'A leftover temporary file is not owned by the current user.');
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

// ---------------------------------------------------------------------------
// Accepted P24 durable run record binding
// ---------------------------------------------------------------------------

function hashCanonical(canonical) {
  return `sha256:${CREATE_HASH(HASH_ALGORITHM).update(canonical, 'utf8').digest('hex')}`;
}

export function validateBoundRunRecord(record) {
  if (record === undefined || record === null || typeof record !== 'object' || Array.isArray(record)) {
    failJournal('invalid_type', 'record', 'A bound run record must be a plain JSON data object.');
  }
  assertDirectJsonClosure(record, 'record');
  const fields = closedObject(record, 'record', RUN_STORE_RECORD_KEYS);
  if (fields.schema !== RUN_STORE_RECORD_SCHEMA_ID) {
    failJournal('run_journal_record_invalid', 'record.schema',
      `The bound record schema must be exactly "${RUN_STORE_RECORD_SCHEMA_ID}".`);
  }
  assertRunId(fields.run_id, 'record.run_id');
  assertBoundDigest(fields.request_idempotency_key, 'record.request_idempotency_key');
  if (typeof fields.canonical_digest !== 'string'
    || !capturedTest(SHA256_DIGEST_PATTERN, fields.canonical_digest)) {
    failJournal('run_journal_record_invalid', 'record.canonical_digest',
      'The bound record canonical digest must be a sha256 digest.');
  }
  const identity = validateRunIdentityV1(fields.identity, 'identity');
  const git = validateGitIdentityV1(fields.git, 'git');
  assertSharedGitIdentityV1(identity.git, git, 'git');
  const provenance = validateDispatchProvenanceV1(fields.provenance);
  const telemetry = validateDispatchTelemetryV1(fields.telemetry);
  if (identity.run_id !== fields.run_id || provenance.run.run_id !== fields.run_id) {
    failJournal('run_journal_identity_mismatch', 'record.run_id',
      'The bound record must bind exactly one run identity.');
  }
  if (identity.digest !== provenance.run.digest) {
    failJournal('run_journal_identity_mismatch', 'record.identity',
      'The run identity does not match the stored provenance run.');
  }
  if (git.digest !== provenance.git.digest || git.digest !== identity.git.digest) {
    failJournal('run_journal_identity_mismatch', 'record.git',
      'The Git identity does not match the immutable repository/base authority.');
  }
  if (provenance.provider_run.request_idempotency_key !== fields.request_idempotency_key) {
    failJournal('run_journal_identity_mismatch', 'record.request_idempotency_key',
      'The request idempotency key does not match the protected provider-run key.');
  }
  const projectedCanonical = canonicalJsonStringify(projectDispatchTelemetryV1(provenance));
  if (projectedCanonical !== canonicalJsonStringify(telemetry)) {
    failJournal('run_journal_identity_mismatch', 'record.telemetry',
      'Telemetry must be the content-free projection of the stored provenance.');
  }
  const rebuilt = hashCanonical(canonicalJsonStringify({
    schema: fields.schema,
    run_id: fields.run_id,
    request_idempotency_key: fields.request_idempotency_key,
    identity,
    git,
    provenance,
    telemetry,
  }));
  if (rebuilt !== fields.canonical_digest) {
    failJournal('run_journal_record_mismatch', 'record.canonical_digest',
      'The bound record canonical digest does not match its recomputed value.');
  }
  return snapshotRecord({
    schema: fields.schema,
    run_id: fields.run_id,
    request_idempotency_key: fields.request_idempotency_key,
    identity,
    git,
    provenance,
    telemetry,
    canonical_digest: fields.canonical_digest,
  });
}

function assertStoreHandle(store) {
  if (store === undefined || store === null || typeof store !== 'object'
    || typeof store.getByRunId !== 'function' || typeof store.root !== 'string') {
    failJournal('invalid_type', 'store',
      'The journal requires an accepted P24 openRunStore(...) handle.');
  }
  return store;
}

function parseJournalOptions(options) {
  if (options === undefined || options === null || typeof options !== 'object'
    || Array.isArray(options)) {
    failJournal('invalid_type', 'options', 'Journal options must be a plain options object.');
  }
  for (const key of sortedCapturedKeys(options)) {
    if (!capturedIncludes(['root', 'store', 'run_id'], key)) {
      failJournal('unknown_key', `options.${key}`, `options.${key} is not part of the closed options.`);
    }
  }
  for (const key of ['root', 'store', 'run_id']) {
    if (!capturedHasOwn(options, key)) {
      failJournal('missing_key', `options.${key}`, `options.${key} is required.`);
    }
  }
  const runId = options.run_id;
  assertRunId(runId, 'run_id');
  return {
    root: assertSafeRootPath(options.root),
    store: assertStoreHandle(options.store),
    runId,
    journalMode: JOURNAL_MODE_LEGACY,
  };
}

function assertAnchorHandle(anchor) {
  if (anchor === undefined || anchor === null || typeof anchor !== 'object'
    || typeof anchor.getByRunId !== 'function'
    || typeof anchor.getCoordination !== 'function'
    || typeof anchor.root !== 'string'
    || typeof anchor.marker_digest !== 'string') {
    failJournal('invalid_type', 'anchor',
      'The aggregate journal requires an openAggregateRunAnchor(...) handle.');
  }
  assertBoundDigest(anchor.marker_digest, 'anchor.marker_digest');
  return {
    handle: anchor,
    root: assertSafeRootPath(anchor.root),
    markerDigest: anchor.marker_digest,
  };
}

function parseAggregateJournalOptions(options) {
  if (options === undefined || options === null || typeof options !== 'object'
    || Array.isArray(options)) {
    failJournal('invalid_type', 'options', 'Journal options must be a plain options object.');
  }
  for (const key of sortedCapturedKeys(options)) {
    if (!capturedIncludes(['root', 'anchor', 'run_id'], key)) {
      failJournal('unknown_key', `options.${key}`, `options.${key} is not part of the closed options.`);
    }
  }
  for (const key of ['root', 'anchor', 'run_id']) {
    if (!capturedHasOwn(options, key)) {
      failJournal('missing_key', `options.${key}`, `options.${key} is required.`);
    }
  }
  const runId = options.run_id;
  assertRunId(runId, 'run_id');
  const anchor = assertAnchorHandle(options.anchor);
  return {
    root: assertSafeRootPath(options.root),
    anchor: anchor.handle,
    anchorRoot: anchor.root,
    markerDigest: anchor.markerDigest,
    runId,
    journalMode: JOURNAL_MODE_AGGREGATE,
  };
}

function claimDigestPayload(fields) {
  return {
    schema: fields.schema,
    run_id: fields.run_id,
    anchor_digest: fields.anchor_digest,
    submission_idempotency_key: fields.submission_idempotency_key,
    root_marker_nonce: fields.root_marker_nonce,
    root_marker_digest: fields.root_marker_digest,
    nonce: fields.nonce,
  };
}

export function computeAggregateBindingDigest(parts) {
  if (parts === undefined || parts === null || typeof parts !== 'object' || Array.isArray(parts)) {
    failJournal('invalid_type', 'binding', 'An aggregate binding must be a plain JSON data object.');
  }
  const fields = closedObject(
    parts,
    'binding',
    RUN_JOURNAL_AGGREGATE_BINDING_RECORD_KEYS,
    RUN_JOURNAL_AGGREGATE_BINDING_KEYS,
  );
  assertRunId(fields.run_id, 'binding.run_id');
  assertBoundDigest(fields.marker_digest, 'binding.marker_digest');
  assertBoundDigest(fields.claim_digest, 'binding.claim_digest');
  assertBoundDigest(fields.anchor_digest, 'binding.anchor_digest');
  assertBoundDigest(fields.coordination_digest, 'binding.coordination_digest');
  assertBoundDigest(fields.resolved_plan_digest, 'binding.resolved_plan_digest');
  if (fields.phase !== 'resolution_ready') {
    failJournal('run_journal_aggregate_not_ready', 'binding.phase',
      'Aggregate journals require a resolution_ready R24A coordination phase.');
  }
  if (typeof fields.revision !== 'number' || !NUMBER_IS_SAFE_INTEGER(fields.revision)
    || (fields.revision !== 1 && fields.revision !== 2)) {
    failJournal('run_journal_aggregate_not_ready', 'binding.revision',
      'Aggregate journals require a resolution_ready revision of 1 or 2.');
  }
  const canonical = canonicalJsonStringify({
    run_id: fields.run_id,
    marker_digest: fields.marker_digest,
    claim_digest: fields.claim_digest,
    anchor_digest: fields.anchor_digest,
    coordination_digest: fields.coordination_digest,
    resolved_plan_digest: fields.resolved_plan_digest,
    phase: fields.phase,
    revision: fields.revision,
  });
  const digest = CREATE_HASH(HASH_ALGORITHM)
    .update(`${RUN_JOURNAL_AGGREGATE_BINDING_DOMAIN}\n${canonical}\n`, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

export function validateBoundAggregateResolution(record) {
  if (record === undefined || record === null || typeof record !== 'object' || Array.isArray(record)) {
    failJournal('invalid_type', 'binding', 'An aggregate binding must be a plain JSON data object.');
  }
  assertDirectJsonClosure(record, 'binding');
  const fields = closedObject(record, 'binding', RUN_JOURNAL_AGGREGATE_BINDING_RECORD_KEYS);
  const rebuilt = computeAggregateBindingDigest(fields);
  if (typeof fields.binding_digest !== 'string'
    || !capturedTest(SHA256_DIGEST_PATTERN, fields.binding_digest)
    || rebuilt !== fields.binding_digest) {
    failJournal('run_journal_record_mismatch', 'binding.binding_digest',
      'The aggregate binding digest does not match its recomputed value.');
  }
  return snapshotRecord({
    run_id: fields.run_id,
    marker_digest: fields.marker_digest,
    claim_digest: fields.claim_digest,
    anchor_digest: fields.anchor_digest,
    coordination_digest: fields.coordination_digest,
    resolved_plan_digest: fields.resolved_plan_digest,
    phase: fields.phase,
    revision: fields.revision,
    binding_digest: fields.binding_digest,
  });
}

function failAggregateMismatch(field, message) {
  failJournal('run_journal_aggregate_mismatch', field, message);
}

function parseCanonicalStoredBytes(bytes, field) {
  if (bytes === null || bytes === undefined) {
    failAggregateMismatch(field, 'The aggregate identity record is missing.');
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failAggregateMismatch(field, 'The aggregate identity record is malformed.');
  }
  let text;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    failAggregateMismatch(field, 'The aggregate identity record is malformed.');
  }
  if (!text.endsWith('\n')) {
    failAggregateMismatch(field, 'The aggregate identity record is malformed.');
  }
  const body = text.slice(0, -1);
  let parsed;
  try {
    parsed = JSON_PARSE(body);
  } catch {
    failAggregateMismatch(field, 'The aggregate identity record is malformed.');
  }
  if (canonicalJsonStringify(parsed) !== body) {
    failAggregateMismatch(field, 'The aggregate identity record is malformed.');
  }
  return parsed;
}

function validateDurableMarker(parsed) {
  let fields;
  try {
    fields = closedObject(parsed, AGGREGATE_MARKER_NAME, AGGREGATE_MARKER_KEYS);
  } catch (error) {
    if (error instanceof RunContractV1Error) {
      failAggregateMismatch(AGGREGATE_MARKER_NAME, 'The aggregate root marker is malformed.');
    }
    throw error;
  }
  if (fields.schema !== STORAGE_ROOT_SCHEMA_ID
    || fields.kind !== AGGREGATE_STORAGE_ROOT_KIND
    || typeof fields.nonce !== 'string'
    || !capturedTest(NONCE_PATTERN, fields.nonce)) {
    failAggregateMismatch(AGGREGATE_MARKER_NAME, 'The aggregate root marker is malformed.');
  }
  const digest = identityBoundDigest(IDENTITY_LABELS.STORAGE_ROOT, {
    schema: fields.schema,
    kind: fields.kind,
    nonce: fields.nonce,
  });
  if (digest !== fields.canonical_digest) {
    failAggregateMismatch(AGGREGATE_MARKER_NAME, 'The aggregate root marker digest does not match.');
  }
  return snapshotRecord(fields);
}

function validateDurableClaim(parsed, runId) {
  let fields;
  try {
    fields = closedObject(parsed, 'claim', AGGREGATE_CLAIM_KEYS);
  } catch (error) {
    if (error instanceof RunContractV1Error) {
      failAggregateMismatch('claim', 'The aggregate claim is malformed.');
    }
    throw error;
  }
  if (fields.schema !== AGGREGATE_RUN_CLAIM_SCHEMA_ID || fields.run_id !== runId) {
    failAggregateMismatch('claim', 'The aggregate claim does not bind this run.');
  }
  const digest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RUN_CLAIM, claimDigestPayload(fields));
  if (digest !== fields.canonical_digest) {
    failAggregateMismatch('claim', 'The aggregate claim digest does not match.');
  }
  return snapshotRecord(fields);
}

function validateDurablePlan(parsed, runId) {
  let fields;
  try {
    fields = closedObject(parsed, AGGREGATE_PLAN_RECORD_NAME, AGGREGATE_RESOLVED_PLAN_KEYS);
  } catch (error) {
    if (error instanceof RunContractV1Error) {
      failAggregateMismatch(AGGREGATE_PLAN_RECORD_NAME, 'The resolved-plan record is malformed.');
    }
    throw error;
  }
  if (fields.schema !== AGGREGATE_RESOLVED_PLAN_SCHEMA_ID
    || fields.run_id !== runId
    || fields.complete !== true) {
    failAggregateMismatch(AGGREGATE_PLAN_RECORD_NAME, 'The resolved-plan record does not bind this run.');
  }
  const digest = identityBoundDigest(IDENTITY_LABELS.AGGREGATE_RESOLVED_PLAN, {
    schema: fields.schema,
    run_id: fields.run_id,
    complete: true,
  });
  if (digest !== fields.canonical_digest) {
    failAggregateMismatch(AGGREGATE_PLAN_RECORD_NAME, 'The resolved-plan record digest does not match.');
  }
  return snapshotRecord(fields);
}

function validateDurableAggregateStamp(parsed, runId, anchorDigest, claimNonce) {
  const keys = parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    ? []
    : sortedCapturedKeys(parsed);
  if (keys.length !== 4
    || !keys.includes('schema') || !keys.includes('run_id')
    || !keys.includes('record_canonical_digest') || !keys.includes('nonce')
    || parsed.schema !== AGGREGATE_RUN_STAMP_SCHEMA_ID
    || parsed.run_id !== runId
    || parsed.record_canonical_digest !== anchorDigest
    || parsed.nonce !== claimNonce
    || typeof parsed.nonce !== 'string'
    || !capturedTest(NONCE_PATTERN, parsed.nonce)) {
    failAggregateMismatch(AGGREGATE_STAMP_NAME, 'The aggregate run stamp does not match this claim.');
  }
}

function projectAggregateBinding(fields) {
  return {
    run_id: fields.run_id,
    marker_digest: fields.marker_digest,
    claim_digest: fields.claim_digest,
    anchor_digest: fields.anchor_digest,
    coordination_digest: fields.coordination_digest,
    resolved_plan_digest: fields.resolved_plan_digest,
    phase: fields.phase,
    revision: fields.revision,
  };
}

async function observeAggregateResolution(anchor, runId) {
  const record = await anchor.getByRunId(runId);
  const validated = validateAggregateRunAnchorV1(record);
  if (validated.run_id !== runId) {
    failJournal('run_journal_identity_mismatch', 'run_id',
      'The bound aggregate anchor must carry the exact requested run identity.');
  }
  const coordination = await anchor.getCoordination(runId);
  const coord = validateAggregateRunCoordinationV1(coordination);
  if (coord.run_id !== runId || coord.anchor_digest !== validated.canonical_digest) {
    failJournal('run_journal_identity_mismatch', 'coordination',
      'The bound aggregate coordination does not match the anchor identity.');
  }
  if (coord.phase !== 'resolution_ready' || coord.resolved_plan_digest === null) {
    failJournal('run_journal_aggregate_not_ready', 'phase',
      'Aggregate journals require a resolution_ready R24A resolved plan.');
  }
  if (coord.revision !== 1 && coord.revision !== 2) {
    failJournal('run_journal_aggregate_not_ready', 'revision',
      'Aggregate journals require a resolution_ready revision of 1 or 2.');
  }
  return {
    run_id: runId,
    marker_digest: anchor.marker_digest,
    anchor_digest: validated.canonical_digest,
    coordination_digest: coord.state_digest,
    resolved_plan_digest: coord.resolved_plan_digest,
    phase: coord.phase,
    revision: coord.revision,
  };
}

async function readDurableAggregateIdentity(anchorRoot, runId, observed) {
  const rootToken = await openDirectoryHandle(anchorRoot, 'anchor');
  try {
    const markerOpened = await readBoundedFile(
      rootToken, AGGREGATE_MARKER_NAME, MAX_AGGREGATE_MARKER_BYTES, AGGREGATE_MARKER_NAME,
    );
    const marker = validateDurableMarker(parseCanonicalStoredBytes(
      markerOpened === null ? null : markerOpened.bytes, AGGREGATE_MARKER_NAME,
    ));
    if (marker.canonical_digest !== observed.marker_digest) {
      failJournal('run_journal_aggregate_swapped', AGGREGATE_MARKER_NAME,
        'The aggregate root marker changed during binding.');
    }
    const claimsToken = await openDirectoryHandle(
      childPath(rootToken.path, AGGREGATE_CLAIMS_NAME), 'claim',
    );
    let claim;
    try {
      const claimName = `${runId}.json`;
      const claimOpened = await readBoundedFile(
        claimsToken, claimName, MAX_AGGREGATE_CLAIM_BYTES, 'claim',
      );
      claim = validateDurableClaim(
        parseCanonicalStoredBytes(claimOpened === null ? null : claimOpened.bytes, 'claim'),
        runId,
      );
    } finally {
      await claimsToken.handle.close().catch(() => {});
    }
    if (claim.anchor_digest !== observed.anchor_digest
      || claim.root_marker_digest !== marker.canonical_digest
      || claim.root_marker_nonce !== marker.nonce) {
      failAggregateMismatch('claim', 'The aggregate claim does not bind this marker and anchor.');
    }
    const runsToken = await openDirectoryHandle(
      childPath(rootToken.path, AGGREGATE_RUNS_NAME), 'runs',
    );
    try {
      const runToken = await openDirectoryHandle(childPath(runsToken.path, runId), 'directory');
      try {
        const planOpened = await readBoundedFile(
          runToken, AGGREGATE_PLAN_RECORD_NAME, MAX_AGGREGATE_RECORD_BYTES, AGGREGATE_PLAN_RECORD_NAME,
        );
        const plan = validateDurablePlan(
          parseCanonicalStoredBytes(
            planOpened === null ? null : planOpened.bytes, AGGREGATE_PLAN_RECORD_NAME,
          ),
          runId,
        );
        if (plan.canonical_digest !== observed.resolved_plan_digest) {
          failJournal('run_journal_aggregate_swapped', AGGREGATE_PLAN_RECORD_NAME,
            'The resolved-plan record changed during binding.');
        }
        const stampOpened = await readBoundedFile(
          runToken, AGGREGATE_STAMP_NAME, MAX_AGGREGATE_STAMP_BYTES, AGGREGATE_STAMP_NAME,
        );
        validateDurableAggregateStamp(
          parseCanonicalStoredBytes(
            stampOpened === null ? null : stampOpened.bytes, AGGREGATE_STAMP_NAME,
          ),
          runId,
          observed.anchor_digest,
          claim.nonce,
        );
      } finally {
        await runToken.handle.close().catch(() => {});
      }
    } finally {
      await runsToken.handle.close().catch(() => {});
    }
    return {
      ...observed,
      claim_digest: claim.canonical_digest,
    };
  } finally {
    await rootToken.handle.close().catch(() => {});
  }
}

export async function bindAggregateResolution(anchor, runId) {
  assertRunId(runId, 'run_id');
  const bound = assertAnchorHandle(anchor);
  const first = await observeAggregateResolution(bound.handle, runId);
  const durable = await readDurableAggregateIdentity(bound.root, runId, first);
  const second = await observeAggregateResolution(bound.handle, runId);
  const firstProj = projectAggregateBinding(durable);
  const secondProj = {
    ...projectAggregateBinding({
      ...second,
      claim_digest: durable.claim_digest,
    }),
  };
  if (canonicalJsonStringify(firstProj) !== canonicalJsonStringify(secondProj)
    || first.marker_digest !== second.marker_digest
    || first.anchor_digest !== second.anchor_digest
    || first.coordination_digest !== second.coordination_digest
    || first.resolved_plan_digest !== second.resolved_plan_digest
    || first.revision !== second.revision) {
    failJournal('run_journal_aggregate_swapped', 'anchor',
      'The aggregate resolution identity changed during binding.');
  }
  const bindingDigest = computeAggregateBindingDigest(firstProj);
  return validateBoundAggregateResolution({
    ...firstProj,
    binding_digest: bindingDigest,
  });
}

async function verifyAggregateRootSeparation(anchor, rootToken) {
  const names = [anchor.root];
  names.push(path.join(anchor.root, AGGREGATE_CLAIMS_NAME));
  names.push(path.join(anchor.root, AGGREGATE_RUNS_NAME));
  for (const candidate of names) {
    let handle;
    try {
      handle = await open(assertSafeRootPath(candidate), ROOT_OPEN_FLAGS);
    } catch {
      continue;
    }
    try {
      const stat = await handle.stat();
      if (sameIdentity(stat, rootToken)) {
        failJournal('run_journal_root_shared', 'root',
          'The journal root must be separate from the R24A aggregate root.');
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Journal parsing, verification, and replay
// ---------------------------------------------------------------------------

function decodeStrictUtf8(bytes, field) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failJournal('run_journal_committed_corruption', field,
      'Journal files must not begin with a UTF-8 BOM.');
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    failJournal('run_journal_committed_corruption', field, 'Journal files must be valid UTF-8.');
  }
}

function entryHash(seq, prev, kind, data, dedupeKey) {
  const body = canonicalJsonStringify({
    seq,
    prev,
    kind,
    data,
    ...(dedupeKey === undefined ? {} : { dedupe_key: dedupeKey }),
  });
  const digest = CREATE_HASH(HASH_ALGORITHM)
    .update(`${RUN_JOURNAL_HASH_DOMAIN}\n${body}`, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function parseCommittedLine(line, index) {
  // Every rejection of a newline-terminated line is committed corruption:
  // the line claimed a committed boundary, so no specific shape detail is
  // echoed beyond the constant typed code.
  try {
    let parsed;
    try {
      parsed = JSON_PARSE(line);
    } catch {
      throw new Error('json');
    }
    if (parsed === undefined || parsed === null || typeof parsed !== 'object'
      || Array.isArray(parsed)) {
      throw new Error('shape');
    }
    if (canonicalJsonStringify(parsed) !== line) throw new Error('canonical');
    const entry = validateRunJournalEntryV1(parsed);
    const recomputed = entryHash(
      entry.seq,
      entry.prev,
      entry.kind,
      entry.data,
      entry.dedupe_key === undefined ? undefined : entry.dedupe_key,
    );
    if (recomputed !== entry.hash) throw new Error('hash');
    return freezeData(entry);
  } catch (error) {
    if (error instanceof RunContractV1Error && error.code === 'run_journal_committed_corruption') {
      throw error;
    }
    failJournal('run_journal_committed_corruption', `${JOURNAL_NAME}[${index}]`,
      'A committed journal line failed closed-form verification.');
  }
}

// Splits raw journal bytes into committed newline-terminated entries and an
// optional unterminated torn tail segment (the only healable damage).
function parseJournalBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes.byteLength === 0) {
    return { entries: [], entryLines: [], tornTailBytes: 0 };
  }
  const text = decodeStrictUtf8(bytes, JOURNAL_NAME);
  const segments = text.split('\n');
  const tail = segments.pop();
  const tornTailBytes = tail === ''
    ? 0
    : NodeBuffer.byteLength(tail, 'utf8');
  const entries = [];
  const entryLines = [];
  for (let index = 0; index < segments.length; index += 1) {
    const line = segments[index];
    if (line.length === 0) {
      failJournal('run_journal_committed_corruption', `${JOURNAL_NAME}[${index}]`,
        'Committed journal lines must be non-empty.');
    }
    entries.push(parseCommittedLine(line, index));
    entryLines.push(NodeBuffer.byteLength(line, 'utf8') + 1);
  }
  return { entries, entryLines, tornTailBytes };
}

function replayJournal(entries) {
  return reduceRunJournalEntriesV1(entries);
}

async function auditStateCache(dirToken, entries, replayedState, volatile = false) {
  const opened = volatile
    ? await (async () => {
        try {
          return await readBoundedFile(
            dirToken, STATE_NAME, MAX_RUN_JOURNAL_STATE_BYTES, STATE_NAME, true,
          );
        } catch (error) {
          if (isJournalVolatility(error)) throw error;
          throw error;
        }
      })()
    : await readBoundedFile(dirToken, STATE_NAME, MAX_RUN_JOURNAL_STATE_BYTES, STATE_NAME);
  if (opened === null) return { present: false };
  const text = decodeStrictUtf8(opened.bytes, STATE_NAME);
  if (!text.endsWith('\n')) {
    failJournal('run_journal_state_mismatch', STATE_NAME,
      'The derived state cache must end with a single newline.');
  }
  const body = text.slice(0, -1);
  let parsed;
  try {
    parsed = JSON_PARSE(body);
  } catch {
    failJournal('run_journal_state_mismatch', STATE_NAME,
      'The derived state cache is not valid JSON.');
  }
  if (canonicalJsonStringify(parsed) !== body) {
    failJournal('run_journal_state_mismatch', STATE_NAME,
      'The derived state cache is not canonical JSON.');
  }
  validateRunJournalStateV1(parsed);
  if (parsed.revision > replayedState.revision) {
    failJournal('run_journal_state_regression', STATE_NAME,
      'The derived state cache revision exceeds the committed journal head.');
  }
  const prefixState = replayJournal(entries.slice(0, parsed.revision));
  if (canonicalJsonStringify(prefixState) !== body) {
    failJournal('run_journal_state_mismatch', STATE_NAME,
      'The derived state cache disagrees with the exact journal replay.');
  }
  return { present: true, revision: parsed.revision };
}

// Verifies this directory is exactly the private journal created for the
// bound record. Survives inode reuse: a deleted-and-recreated or foreign
// substituted directory cannot carry the creation stamp of this binding.
async function verifyCreationStamp(dirToken, binding, journalMode = JOURNAL_MODE_LEGACY) {
  const opened = await readBoundedFile(dirToken, STAMP_NAME, MAX_RUN_JOURNAL_STAMP_BYTES, STAMP_NAME);
  const rebound = () => failJournal('run_journal_dir_rebound', STAMP_NAME,
    'The run directory is not the private journal created for this bound record.');
  if (opened === null) rebound();
  let text;
  try {
    text = TEXT_DECODER.decode(opened.bytes);
  } catch {
    rebound();
  }
  let parsed;
  try {
    parsed = JSON_PARSE(text.slice(0, -1));
  } catch {
    rebound();
  }
  const keys = parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    ? []
    : sortedCapturedKeys(parsed);
  if (!text.endsWith('\n') || canonicalJsonStringify(parsed) !== text.slice(0, -1)
    || keys.length !== 4
    || !keys.includes('schema') || !keys.includes('run_id')
    || !keys.includes('nonce')
    || parsed.run_id !== binding.run_id
    || typeof parsed.nonce !== 'string'
    || !capturedTest(NONCE_PATTERN, parsed.nonce)) {
    rebound();
  }
  if (journalMode === JOURNAL_MODE_AGGREGATE) {
    if (!keys.includes('binding_digest')
      || parsed.schema !== RUN_JOURNAL_STAMP_SCHEMA_ID_V2) {
      rebound();
    }
    if (parsed.binding_digest !== binding.binding_digest) {
      failJournal('run_journal_identity_conflict', STAMP_NAME,
        'The run journal already binds a different aggregate resolution identity.');
    }
    return;
  }
  if (!keys.includes('record_canonical_digest')
    || parsed.schema !== RUN_JOURNAL_STAMP_SCHEMA_ID
    || parsed.record_canonical_digest !== binding.canonical_digest) {
    rebound();
  }
}

async function writeCreationStamp(dirToken, binding, nonceHex, journalMode = JOURNAL_MODE_LEGACY) {
  const record = journalMode === JOURNAL_MODE_AGGREGATE
    ? {
      schema: RUN_JOURNAL_STAMP_SCHEMA_ID_V2,
      run_id: binding.run_id,
      binding_digest: binding.binding_digest,
      nonce: nonceHex,
    }
    : {
      schema: RUN_JOURNAL_STAMP_SCHEMA_ID,
      run_id: binding.run_id,
      record_canonical_digest: binding.canonical_digest,
      nonce: nonceHex,
    };
  const body = `${canonicalJsonStringify(record)}\n`;
  if (NodeBuffer.byteLength(body, 'utf8') > MAX_RUN_JOURNAL_STAMP_BYTES) {
    failJournal('run_journal_file_too_large', STAMP_NAME,
      `Journal files must not exceed ${MAX_RUN_JOURNAL_STAMP_BYTES} bytes.`);
  }
  await atomicPublish(dirToken, STAMP_NAME, NodeBuffer.from(body, 'utf8'), STAMP_NAME);
}

// Every operation re-verifies the shared runs/ namespace: bounded count,
// exact run-id grammar, and plain-directory entries without symlinks.
async function auditRunsSiblings(dirToken) {
  const runsPath = path.dirname(dirToken.path);
  let dir;
  try {
    dir = await opendir(runsPath, { bufferSize: 16 });
  } catch (error) {
    mapErrno(error, 'runs', 'run_journal_unsafe_path',
      'The journal runs directory could not be re-verified.');
  }
  const seen = [];
  try {
    let count = 0;
    while (true) {
      const entry = await dir.read();
      if (entry === null) break;
      count += 1;
      if (count > MAX_RUN_DIRECTORIES + 1) {
        failJournal('run_journal_flood', 'runs',
          `The journal root must not exceed ${MAX_RUN_DIRECTORIES} run directories.`);
      }
      if (entry.name === '.' || entry.name === '..') continue;
      assertSafeChildName(entry.name, 'runs');
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        failJournal('run_journal_unsafe_path', 'runs',
          'The journal runs namespace must contain only real directories.');
      }
      seen.push(entry.name);
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return seen;
}

async function auditLayout(dirToken, volatile = false) {
  await auditRunsSiblings(dirToken);
  const names = await enumerateDirectory(dirToken, MAX_RUN_JOURNAL_DIRECTORY_ENTRIES, 'directory');
  const temporaries = [];
  for (const name of names) {
    if (capturedTest(TEMP_NAME_PATTERN, name) || capturedTest(LOCK_OWNER_NAME_PATTERN, name)) {
      temporaries.push(name);
      continue;
    }
    if (name !== JOURNAL_NAME && name !== STATE_NAME && name !== LOCK_NAME
      && name !== STAMP_NAME) {
      failJournal('run_journal_foreign_entry', 'directory',
        'The run journal directory contains a foreign entry.');
    }
    let inspection;
    try {
      inspection = await inspectChildFile(dirToken, name, name, volatile);
    } catch (error) {
      if (volatile && isJournalVolatility(error)) throw error;
      throw error;
    }
    if (inspection.kind === 'file') assertRegularUnsharedFile(inspection.stat, name);
  }
  if (temporaries.length > MAX_RUN_JOURNAL_TEMPORARIES) {
    failJournal('run_journal_flood', 'temporary',
      `Run journals must not accumulate more than ${MAX_RUN_JOURNAL_TEMPORARIES} temporaries.`);
  }
  return { names, temporaries };
}

// ---------------------------------------------------------------------------
// Advisory cross-process lock with bounded stale recovery
// ---------------------------------------------------------------------------

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

// The lock file is intentionally volatile across processes: contenders may
// always observe it appearing, vanishing, being replaced, or carrying two
// links inside our own link(tmp->lock)/unlink(tmp) window. Mutual exclusion
// lives in the exclusive name, so the advisory reader skips the nlink rule;
// hostile shapes (symlink, oversized, malformed content) stay hard failures.
async function readLockFile(dirToken) {
  const target = childPath(dirToken.path, LOCK_NAME);
  let handle;
  try {
    handle = await open(target, FILE_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') {
      failJournal('run_journal_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    throw error;
  }
  let opened;
  try {
    const stat = await handle.stat();
    if (stat.isSymbolicLink() || !stat.isFile()) {
      failJournal('run_journal_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    const uid = ownerUid();
    if (uid !== undefined && Number(stat.uid) !== uid) {
      failJournal('run_journal_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    if ((Number(stat.mode) & 0o077) !== 0 || Number(stat.size) > MAX_RUN_JOURNAL_LOCK_BYTES) {
      failJournal('run_journal_lock_corrupt', LOCK_NAME,
        'The lock file is malformed and was not followed.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(stat, after) || Number(after.size) !== Number(stat.size)) {
      return null;
    }
    opened = { bytes, stat };
  } catch (error) {
    if (isJournalVolatility(error)) return null;
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
  if (opened === null) return null;
  let text;
  try {
    text = TEXT_DECODER.decode(opened.bytes);
  } catch {
    failJournal('run_journal_lock_corrupt', LOCK_NAME,
      'The lock file is malformed and was not followed.');
  }
  let parsed;
  try {
    parsed = JSON_PARSE(text);
  } catch {
    failJournal('run_journal_lock_corrupt', LOCK_NAME,
      'The lock file is malformed and was not followed.');
  }
  const keys = parsed === null || typeof parsed !== 'object' ? [] : sortedCapturedKeys(parsed);
  if (text.length > MAX_RUN_JOURNAL_LOCK_BYTES || keys.length !== 3
    || !keys.includes('schema') || !keys.includes('pid') || !keys.includes('nonce')
    || parsed.schema !== RUN_JOURNAL_LOCK_SCHEMA_ID
    || !validLockPidShape(parsed.pid)
    || typeof parsed.nonce !== 'string'
    || !capturedTest(/^[0-9a-f]{32}$/u, parsed.nonce)) {
    failJournal('run_journal_lock_corrupt', LOCK_NAME,
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

async function acquireRunLock(dirToken) {
  const deadline = Date.now() + RUN_JOURNAL_LOCK_WAIT_MS;
  let steals = 0;
  while (true) {
    const ownerName = `.lock-${RANDOM_BYTES(16).toString('hex')}`;
    const ownerPath = childPath(dirToken.path, ownerName);
    const ownerBody = canonicalJsonStringify({
      schema: RUN_JOURNAL_LOCK_SCHEMA_ID,
      pid: process.pid,
      nonce: RANDOM_BYTES(16).toString('hex'),
    });
    let handle;
    try {
      handle = await open(ownerPath, FILE_CREATE_FLAGS, 0o600);
    } catch (error) {
      mapErrno(error, 'lock', 'run_journal_io_failed', 'The lock owner file could not be created.');
    }
    let acquired;
    try {
      await handle.writeFile(`${ownerBody}\n`, 'utf8');
    } finally {
      await handle.close().catch(() => {});
    }
    try {
      await link(ownerPath, childPath(dirToken.path, LOCK_NAME));
      acquired = true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // A concurrent cleaner removed our owner file; restart the attempt.
        acquired = false;
      } else if (error?.code !== 'EEXIST') {
        await unlink(ownerPath).catch(() => {});
        mapErrno(error, 'lock', 'run_journal_io_failed', 'The lock could not be acquired exclusively.');
      } else {
        acquired = false;
      }
    }
    await unlink(ownerPath).catch(() => {});
    if (acquired) {
      const held = await readLockFile(dirToken);
      if (held === null || held.pid !== process.pid) {
        failJournal('run_journal_lock_corrupt', LOCK_NAME,
          'The acquired lock was replaced before use.');
      }
      return { dev: held.dev, ino: held.ino, nonce: held.nonce };
    }
    const existing = await readLockFile(dirToken);
    if (existing === null) continue;
    const ageMs = await lockAgeMs(dirToken);
    const stale = !pidAlive(existing.pid) || ageMs > RUN_JOURNAL_LOCK_MAX_AGE_MS;
    if (stale && steals < MAX_RUN_JOURNAL_LOCK_STEALS) {
      let current;
      try {
        current = await readLockFile(dirToken);
      } catch {
        current = null;
      }
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
      failJournal('run_journal_lock_timeout', LOCK_NAME,
        'The run journal lock stayed contended for the bounded wait.');
    }
    await sleep(RUN_JOURNAL_LOCK_POLL_MS);
  }
}

async function releaseRunLock(dirToken, token) {
  const held = await readLockFile(dirToken).catch(() => null);
  if (held === null) return;
  if (held.nonce !== token.nonce
    || Number(held.dev) !== Number(token.dev)
    || Number(held.ino) !== Number(token.ino)) {
    return;
  }
  await unlink(childPath(dirToken.path, LOCK_NAME)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Opaque run-bound cursor tokens
// ---------------------------------------------------------------------------

function runFingerprint(runId, recordDigest) {
  const digest = CREATE_HASH(HASH_ALGORITHM)
    .update(`${RUN_JOURNAL_HASH_DOMAIN}\n${runId}\n${recordDigest}\n`, 'utf8')
    .digest('hex');
  return digest;
}

function base64url(bytes) {
  return NodeBuffer.from(bytes).toString('base64url');
}

function encodeCursorToken(fingerprint, seq, headHash) {
  const payload = base64url(canonicalJsonStringify({ v: 1, run: fingerprint, seq, head: headHash }));
  const seal = base64url(
    CREATE_HASH(HASH_ALGORITHM).update(`${RUN_JOURNAL_CURSOR_DOMAIN}\n${payload}`, 'utf8').digest(),
  );
  return `${payload}.${seal}`;
}

function decodeCursorToken(token, fingerprint) {
  const invalid = () => failJournal('run_journal_cursor_invalid', 'cursor',
    'The cursor token is malformed or was tampered with.');
  if (typeof token !== 'string' || token.length === 0
    || token.length > MAX_RUN_JOURNAL_CURSOR_CHARS) invalid();
  const parts = token.split('.');
  if (parts.length !== 2) invalid();
  const [payload, seal] = parts;
  if (!capturedTest(BASE64URL_PATTERN, payload) || !capturedTest(BASE64URL_PATTERN, seal)) invalid();
  const expected = base64url(
    CREATE_HASH(HASH_ALGORITHM).update(`${RUN_JOURNAL_CURSOR_DOMAIN}\n${payload}`, 'utf8').digest(),
  );
  const sealed = NodeBuffer.from(seal, 'base64url');
  const wanted = NodeBuffer.from(expected, 'base64url');
  if (sealed.length !== wanted.length || !TIMING_SAFE_EQUAL(sealed, wanted)) invalid();
  let text;
  try {
    text = TEXT_DECODER.decode(NodeBuffer.from(payload, 'base64url'));
  } catch {
    invalid();
  }
  let parsed;
  try {
    parsed = JSON_PARSE(text);
  } catch {
    invalid();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || sortedCapturedKeys(parsed).length !== 4
    || !capturedHasOwn(parsed, 'v') || !capturedHasOwn(parsed, 'run')
    || !capturedHasOwn(parsed, 'seq') || !capturedHasOwn(parsed, 'head')) invalid();
  if (parsed.v !== 1
    || typeof parsed.seq !== 'number' || !NUMBER_IS_SAFE_INTEGER(parsed.seq)
    || parsed.seq < 0 || parsed.seq > MAX_RUN_JOURNAL_ENTRIES
    || (parsed.head !== RUN_JOURNAL_GENESIS_PREV && !capturedTest(SHA256_DIGEST_PATTERN, parsed.head))) {
    invalid();
  }
  if (typeof parsed.run !== 'string' || !capturedTest(HEX_PATTERN, parsed.run)) invalid();
  if (parsed.run !== fingerprint) {
    failJournal('run_journal_cursor_cross_run', 'cursor',
      'The cursor token belongs to a different run binding.');
  }
  return { seq: parsed.seq, head: parsed.head };
}

// ---------------------------------------------------------------------------
// Shared operation plumbing
// ---------------------------------------------------------------------------

async function verifyRootSeparation(store, rootToken) {
  let storeHandle;
  try {
    storeHandle = await open(assertSafeRootPath(store.root), ROOT_OPEN_FLAGS);
  } catch (error) {
    failJournal('run_journal_store_invalid', 'store',
      'The accepted P24 store root could not be verified.');
  }
  try {
    const stat = await storeHandle.stat();
    if (sameIdentity(stat, rootToken)) {
      failJournal('run_journal_root_shared', 'root',
        'The journal root must be separate from the accepted P24 store root.');
    }
  } finally {
    await storeHandle.close().catch(() => {});
  }
}

function withRunChain(dirToken, operation) {
  const id = `${STRING(dirToken.dev)}:${STRING(dirToken.ino)}:${STRING(dirToken.path)}`;
  const previous = JOURNAL_CHAINS.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.catch(() => {}).then(() => {
    if (JOURNAL_CHAINS.get(id) === settled) JOURNAL_CHAINS.delete(id);
  });
  JOURNAL_CHAINS.set(id, settled);
  return current;
}

function bindingDigestOf(binding, journalMode) {
  return journalMode === JOURNAL_MODE_AGGREGATE ? binding.binding_digest : binding.canonical_digest;
}

async function buildHandle(parsed, binding, mode) {
  const { root, store, runId } = parsed;
  const journalMode = parsed.journalMode ?? JOURNAL_MODE_LEGACY;
  const digest = bindingDigestOf(binding, journalMode);
  if (binding.run_id !== runId || typeof digest !== 'string'
    || !capturedTest(SHA256_DIGEST_PATTERN, digest)) {
    failJournal('run_journal_identity_mismatch', 'run_id',
      'The bound record must carry the exact requested run identity.');
  }
  const rootToken = await openDirectoryHandle(root, 'root');
  try {
    if (journalMode === JOURNAL_MODE_AGGREGATE) {
      await verifyAggregateRootSeparation(parsed.anchor, rootToken);
    } else {
      await verifyRootSeparation(store, rootToken);
    }
    const rootNames = await enumerateDirectory(rootToken, MAX_RUN_JOURNAL_ROOT_ENTRIES, 'root');
    if (!rootNames.includes('runs')) {
      if (mode !== 'create') {
        failJournal('run_journal_not_found', 'root',
          'The journal root does not contain a runs directory yet.');
      }
      await mkdirExclusive(path.join(root, 'runs'), 'runs');
      await syncDirectory(rootToken.handle);
    } else if (rootNames.length !== 1) {
      failJournal('run_journal_foreign_entry', 'root',
        'The journal root contains a foreign entry.');
    }
    const runsToken = await openDirectoryHandle(path.join(root, 'runs'), 'runs');
    try {
      const runNames = await enumerateDirectory(runsToken, MAX_RUN_DIRECTORIES + 1, 'runs');
      if (runNames.length > MAX_RUN_DIRECTORIES) {
        failJournal('run_journal_flood', 'runs',
          `The journal root must not exceed ${MAX_RUN_DIRECTORIES} run directories.`);
      }
      for (const name of runNames) {
        assertRunId(name, 'runs');
        const childToken = await openDirectoryHandle(path.join(runsToken.path, name), 'runs');
        await childToken.handle.close().catch(() => {});
      }
      if (mode === 'create' && runNames.includes(runId)) {
        failJournal('run_journal_already_exists', 'run_id',
          'A run journal directory already exists for that run id.');
      }
      if (mode === 'open' && !runNames.includes(runId)) {
        failJournal('run_journal_not_found', 'run_id',
          'No run journal directory exists for that run id.');
      }
      if (mode === 'create') {
        await mkdirExclusive(path.join(runsToken.path, runId), 'run_id');
        await syncDirectory(runsToken.handle);
      }
      const dirToken = await openDirectoryHandle(path.join(runsToken.path, runId), 'directory');
      try {
        if (dirToken.path !== path.join(runsToken.path, runId)) {
          failJournal('run_journal_path_unsafe', 'run_id',
            'The run directory name must equal the bound run id.');
        }
        if (mode === 'create') {
          await verifyCreationStamp(dirToken, binding, journalMode).then(() => {
            failJournal('run_journal_already_exists', 'run_id',
              'A run journal already exists for that run identity.');
          }, (error) => {
            if (error instanceof RunContractV1Error
              && error.code === 'run_journal_identity_conflict') {
              throw error;
            }
            if (!(error instanceof RunContractV1Error
              && error.code === 'run_journal_dir_rebound')) throw error;
          });
          await writeCreationStamp(
            dirToken, binding, RANDOM_BYTES(16).toString('hex'), journalMode,
          );
        } else {
          await verifyCreationStamp(dirToken, binding, journalMode);
        }
        const fingerprint = runFingerprint(binding.run_id, digest);
        return assembleHandle({
          root,
          store,
          anchor: parsed.anchor,
          runId,
          binding,
          fingerprint,
          journalMode,
          rootToken: capturedFreeze({ path: rootToken.path, dev: rootToken.dev, ino: rootToken.ino }),
          runsToken: capturedFreeze({ path: runsToken.path, dev: runsToken.dev, ino: runsToken.ino }),
          dirToken: capturedFreeze({ path: dirToken.path, dev: dirToken.dev, ino: dirToken.ino }),
        });
      } finally {
        await dirToken.handle.close().catch(() => {});
      }
    } finally {
      await runsToken.handle.close().catch(() => {});
    }
  } finally {
    await rootToken.handle.close().catch(() => {});
  }
}

async function mkdirExclusive(target, field) {
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      failJournal(field === 'runs' ? 'run_journal_unsafe_path' : 'run_journal_already_exists', field,
        field === 'runs'
          ? 'The journal runs directory was replaced concurrently.'
          : 'A run journal directory already exists for that run id.');
    }
    mapErrno(error, field, 'run_journal_io_failed', 'The journal directory could not be created.');
  }
}

async function bindRecord(store, runId) {
  const record = await store.getByRunId(runId);
  return validateBoundRunRecord(record);
}

function assembleHandle(context) {
  const { store, anchor, runId, binding, fingerprint, rootToken, dirToken } = context;
  const journalMode = context.journalMode ?? JOURNAL_MODE_LEGACY;
  // Snapshot cache for the serialized operation chain. Reads always fully
  // re-audit; a locked mutation may reuse the snapshot only while the journal
  // bytes are exactly the audited ones, so any external modification forces a
  // full parse/replay before anything else happens.
  let snapshot = null;

  async function rebind() {
    if (journalMode === JOURNAL_MODE_AGGREGATE) {
      const fresh = await bindAggregateResolution(anchor, runId);
      if (fresh.binding_digest !== binding.binding_digest) {
        failJournal('run_journal_identity_conflict', 'run_id',
          'The aggregate resolution identity does not match this journal binding.');
      }
      return fresh;
    }
    const fresh = await bindRecord(store, runId);
    if (fresh.canonical_digest !== binding.canonical_digest) {
      failJournal('run_journal_identity_mismatch', 'run_id',
        'The accepted P24 record for this run changed under the journal.');
    }
    return fresh;
  }

  async function operate(mutating, fn) {
    return withRunChain(dirToken, async () => {
      await rebind();
      const rootOpened = await reopenAndVerify(rootToken, 'root');
      let dirOpened = null;
      try {
        dirOpened = await reopenAndVerify(dirToken, 'directory');
        await verifyCreationStamp(dirOpened, binding, journalMode);
        let lockToken = null;
        try {
          if (mutating) lockToken = await acquireRunLock(dirOpened);
          if (journalMode === JOURNAL_MODE_AGGREGATE) {
            await rebind();
            await verifyCreationStamp(dirOpened, binding, journalMode);
          }
          const result = await fn(dirOpened, lockToken);
          const rootAfter = await reopenAndVerify(rootToken, 'root');
          await rootAfter.handle.close().catch(() => {});
          return result;
        } finally {
          if (lockToken !== null) await releaseRunLock(dirOpened, lockToken);
        }
      } finally {
        if (dirOpened !== null) await dirOpened.handle.close().catch(() => {});
        await rootOpened.handle.close().catch(() => {});
      }
    });
  }

  const identityFields = journalMode === JOURNAL_MODE_AGGREGATE
    ? {
      root: rootToken.path,
      directory: dirToken.path,
      run_id: runId,
      aggregate_binding_digest: binding.binding_digest,
      run_fingerprint: fingerprint,
    }
    : {
      root: rootToken.path,
      directory: dirToken.path,
      run_id: runId,
      record_canonical_digest: binding.canonical_digest,
      run_fingerprint: fingerprint,
    };

  return capturedFreeze({
    ...identityFields,

    async currentState() {
      return operate(true, async (dirOpened) => {
        const audited = await auditedJournal(dirOpened, true, false);
        return audited.state;
      });
    },

    async append(event) {
      if (event === undefined || event === null || typeof event !== 'object' || Array.isArray(event)) {
        failJournal('invalid_type', 'event', 'A journal append must be a plain event object.');
      }
      for (const key of sortedCapturedKeys(event)) {
        if (!capturedIncludes(['kind', 'data', 'dedupe_key', 'expected_seq'], key)) {
          failJournal('unknown_key', `event.${key}`, `event.${key} is not part of the closed append shape.`);
        }
      }
      for (const key of ['kind', 'data']) {
        if (!(key in event)) failJournal('missing_key', `event.${key}`, `event.${key} is required.`);
      }
      if (capturedHasOwn(event, 'expected_seq')
        && (typeof event.expected_seq !== 'number' || !NUMBER_IS_SAFE_INTEGER(event.expected_seq)
          || event.expected_seq < 1)) {
        failJournal('invalid_format', 'event.expected_seq',
          'event.expected_seq must be a positive safe integer.');
      }
      const kind = event.kind;
      const data = event.data;
      const dedupeKey = capturedHasOwn(event, 'dedupe_key') ? event.dedupe_key : undefined;
      const expectedSeq = capturedHasOwn(event, 'expected_seq') ? event.expected_seq : undefined;
      if (dedupeKey !== undefined && (typeof dedupeKey !== 'string'
        || !capturedTest(/^[\x21-\x7e]{1,128}$/u, dedupeKey))) {
        failJournal('invalid_format', 'event.dedupe_key',
          'event.dedupe_key must be 1-128 printable ASCII characters.');
      }
      return operate(true, async (dirOpened) => {
        const cleaned = await auditLayout(dirOpened);
        await removeStaleTemporaries(dirOpened, cleaned.temporaries);
        const audited = await auditedJournal(dirOpened, false, false);
        let current = audited;
        if (audited.tornTailBytes > 0) {
          await healTornTailLocked(dirOpened, audited.bytes, audited.tornTailBytes);
          current = await auditedJournal(dirOpened, true, true);
        }
        return commitAppend(dirOpened, current, kind, data, dedupeKey, expectedSeq);
      });
    },

    async healTornTail() {
      return operate(true, async (dirOpened) => {
        const cleaned = await auditLayout(dirOpened);
        const removed = await removeStaleTemporaries(dirOpened, cleaned.temporaries);
        const audited = await auditedJournal(dirOpened, true, true);
        if (audited.tornTailBytes === 0) {
          return snapshotRecord({
            healed: false,
            removed_temporaries: removed,
            state: audited.state,
          });
        }
        await healTornTailLocked(dirOpened, audited.bytes, audited.tornTailBytes);
        const healed = await auditedJournal(dirOpened, true, true);
        await republishStateCache(dirOpened, healed.entries, healed.state);
        return snapshotRecord({
          healed: true,
          removed_temporaries: removed,
          state: healed.state,
        });
      });
    },

    async cursorAfter(seq) {
      if (typeof seq !== 'number' || !NUMBER_IS_SAFE_INTEGER(seq) || seq < 0) {
        failJournal('invalid_format', 'seq', 'seq must be a non-negative safe integer.');
      }
      return operate(true, async (dirOpened) => {
        const audited = await auditedJournal(dirOpened, true, false);
        if (seq > audited.state.revision) {
          failJournal('run_journal_cursor_stale', 'seq',
            'The requested cursor position is beyond the committed journal head.');
        }
        const head = seq === 0 ? RUN_JOURNAL_GENESIS_PREV : audited.entries[seq - 1].hash;
        return snapshotRecord({
          seq,
          head_hash: head,
          cursor: encodeCursorToken(fingerprint, seq, head),
        });
      });
    },

    async readPage(options) {
      let cursor = null;
      let limit = MAX_RUN_JOURNAL_PAGE_EVENTS;
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
          failJournal('invalid_type', 'options', 'readPage options must be a plain object.');
        }
        for (const key of sortedCapturedKeys(options)) {
          if (!capturedIncludes(['cursor', 'limit'], key)) {
            failJournal('unknown_key', `options.${key}`, `options.${key} is not part of the closed page shape.`);
          }
        }
        if ('cursor' in options) cursor = options.cursor;
        if ('limit' in options) {
          limit = options.limit;
          if (typeof limit !== 'number' || !NUMBER_IS_SAFE_INTEGER(limit)
            || limit < 1 || limit > MAX_RUN_JOURNAL_PAGE_EVENTS) {
            failJournal('invalid_format', 'options.limit',
              `options.limit must be between 1 and ${MAX_RUN_JOURNAL_PAGE_EVENTS}.`);
          }
        }
      }
      return operate(true, async (dirOpened) => {
        const audited = await auditedJournal(dirOpened, true, false);
        let start = 1;
        if (cursor !== null && cursor !== undefined) {
          const decoded = decodeCursorToken(cursor, fingerprint);
          if (decoded.seq > audited.state.revision) {
            failJournal('run_journal_cursor_stale', 'cursor',
              'The cursor points beyond the committed journal head.');
          }
          const actualHead = decoded.seq === 0
            ? RUN_JOURNAL_GENESIS_PREV
            : audited.entries[decoded.seq - 1].hash;
          if (actualHead !== decoded.head) {
            failJournal('run_journal_cursor_mismatch', 'cursor',
              'The cursor prefix hash no longer matches this run journal.');
          }
          start = decoded.seq + 1;
        }
        const events = [];
        let servedBytes = 0;
        let truncated = false;
        let index = start;
        while (index <= audited.state.revision) {
          if (events.length >= limit) {
            truncated = index <= audited.state.revision;
            break;
          }
          const lineBytes = audited.entryLines[index - 1];
          if (servedBytes + lineBytes > MAX_RUN_JOURNAL_PAGE_BYTES && events.length > 0) {
            truncated = true;
            break;
          }
          events.push(audited.entries[index - 1]);
          servedBytes += lineBytes;
          index += 1;
        }
        const remaining = Math.max(0, audited.state.revision - (start - 1 + events.length));
        const nextCursor = events.length > 0 && remaining > 0
          ? encodeCursorToken(fingerprint, start - 1 + events.length, audited.entries[start - 2 + events.length].hash)
          : null;
        return snapshotRecord({
          events,
          next_cursor: nextCursor,
          diagnostics: freezeData({
            served_events: events.length,
            served_bytes: servedBytes,
            truncated,
            remaining_events: remaining,
            stale_temporaries: temporaryCount(audited),
          }),
        });
      });
    },
  });

  async function auditedJournal(dirToken, forceFullAudit, mutateSnapshot) {
    // Lock-free readers may observe an atomic rename mid-flight; any complete
    // byte snapshot is valid, so such observations retry within bounds.
    for (let attempt = 0; ; attempt += 1) {
      let opened;
      try {
        opened = await readBoundedFile(
          dirToken, JOURNAL_NAME, MAX_RUN_JOURNAL_FILE_BYTES, JOURNAL_NAME, !mutateSnapshot,
        );
      } catch (error) {
        if (isJournalVolatility(error) && attempt < MAX_AUDIT_ATTEMPTS) {
          await sleep(RUN_JOURNAL_LOCK_POLL_MS * (attempt % 8 === 7 ? 8 : 1));
          continue;
        }
        throw error;
      }
      const bytes = opened === null ? null : opened.bytes;
      const unchanged = snapshot !== null
        && ((snapshot.bytes === null && bytes === null)
          || (snapshot.bytes !== null && bytes !== null && snapshot.bytes.equals(bytes)));
      if (!forceFullAudit && unchanged) {
        if (mutateSnapshot) return snapshot;
        return { ...snapshot, layout: await auditLayout(dirToken, !mutateSnapshot) };
      }
      try {
        const parsed = parseJournalBytes(bytes);
        if (parsed.entries.length > MAX_RUN_JOURNAL_ENTRIES) {
          failJournal('run_journal_flood', JOURNAL_NAME,
            `Run journals must not exceed ${MAX_RUN_JOURNAL_ENTRIES} entries.`);
        }
        const state = reduceRunJournalEntriesV1(parsed.entries);
        const cache = await auditStateCache(
          dirToken, parsed.entries, state, !mutateSnapshot,
        );
        const audited = {
          layout: await auditLayout(dirToken, !mutateSnapshot),
          bytes,
          entries: parsed.entries,
          entryLines: parsed.entryLines,
          tornTailBytes: parsed.tornTailBytes,
          state,
          cacheRevision: cache.present ? cache.revision : null,
        };
        snapshot = audited;
        return audited;
      } catch (error) {
        if (isJournalVolatility(error) && attempt < MAX_AUDIT_ATTEMPTS) {
          await sleep(RUN_JOURNAL_LOCK_POLL_MS * (attempt % 8 === 7 ? 8 : 1));
          continue;
        }
        throw error;
      }
    }
  }

  function temporaryCount(audited) {
    return audited.layout.temporaries.length;
  }

  function dedupeIndexOf(entries) {
  const index = new Map();
  for (const entry of entries) {
    if (entry.dedupe_key !== undefined) index.set(entry.dedupe_key, entry.seq);
  }
  return index;
}

async function commitAppend(dirOpened, audited, kind, data, dedupeKey, expectedSeq) {
    const state = audited.state;
    const candidateSeq = state.revision + 1;
    const existingDedupeSeq = dedupeKey === undefined
      ? undefined
      : dedupeIndexOf(audited.entries).get(dedupeKey);
    if (dedupeKey !== undefined && existingDedupeSeq !== undefined) {
      const existingSeq = existingDedupeSeq;
      const existing = audited.entries[existingSeq - 1];
      const sameBody = canonicalEventBody(existing.kind, existing.data, existing.dedupe_key)
        === canonicalEventBody(kind, data, dedupeKey);
      if (sameBody) {
        if (existingSeq === state.revision
          && (expectedSeq === undefined || expectedSeq === existingSeq)) {
          return snapshotRecord({
            created: false,
            deduped: true,
            entry: existing,
            state,
          });
        }
        if (expectedSeq !== undefined && expectedSeq !== existingSeq) {
          failJournal('run_journal_expectation_conflict', 'expected_seq',
            'The compare-and-swap sequence expectation does not match the journal.');
        }
        failJournal('run_journal_replay_conflict', 'dedupe_key',
          'That dedupe key already committed earlier in the journal; resubmission is a replay.');
      }
      failJournal('run_journal_dedupe_conflict', 'dedupe_key',
        'That dedupe key already binds a different journal event body.');
    }
    if (expectedSeq !== undefined && expectedSeq !== candidateSeq) {
      failJournal('run_journal_expectation_conflict', 'expected_seq',
        'The compare-and-swap sequence expectation does not match the next journal position.');
    }
    if (candidateSeq > MAX_RUN_JOURNAL_ENTRIES) {
      failJournal('run_journal_flood', JOURNAL_NAME,
        `Run journals must not exceed ${MAX_RUN_JOURNAL_ENTRIES} entries.`);
    }
    const normalized = validateRunJournalEventDataV1(kind, data);
    const hash = entryHash(candidateSeq, state.head_hash, normalized.kind, normalized.data, dedupeKey);
    const candidate = freezeData(validateRunJournalEntryV1({
      schema: RUN_JOURNAL_ENTRY_SCHEMA_ID,
      seq: candidateSeq,
      kind: normalized.kind,
      data: normalized.data,
      ...(dedupeKey === undefined ? {} : { dedupe_key: dedupeKey }),
      prev: state.head_hash,
      hash,
    }));
    const nextState = applyRunJournalEntryV1(state, candidate);
    const line = `${canonicalJsonStringify(candidate)}\n`;
    const lineBytes = NodeBuffer.byteLength(line, 'utf8');
    if (lineBytes > MAX_RUN_JOURNAL_ENTRY_BYTES + 1) {
      failJournal('run_journal_entry_too_large', 'event',
        `Journal entries must not exceed ${MAX_RUN_JOURNAL_ENTRY_BYTES} bytes.`);
    }
    const previousBytes = audited.bytes ?? NodeBuffer.alloc(0);
    const newBytes = NodeBuffer.concat([previousBytes, NodeBuffer.from(line, 'utf8')]);
    if (newBytes.byteLength > MAX_RUN_JOURNAL_FILE_BYTES) {
      failJournal('run_journal_file_too_large', JOURNAL_NAME,
        `Journal files must not exceed ${MAX_RUN_JOURNAL_FILE_BYTES} bytes.`);
    }
    await atomicPublish(dirOpened, JOURNAL_NAME, newBytes, JOURNAL_NAME);
    // Publish verification: durable bytes must equal exactly the audited
    // prefix plus this one verified entry; nothing else counts as committed.
    const reread = await readBoundedFile(
      dirOpened, JOURNAL_NAME, MAX_RUN_JOURNAL_FILE_BYTES, JOURNAL_NAME,
    );
    if (reread === null || !reread.bytes.equals(newBytes)) {
      failJournal('run_journal_publish_unverified', JOURNAL_NAME,
        'The published journal did not verify against the appended entry.');
    }
    snapshot = {
      layout: audited.layout,
      bytes: newBytes,
      entries: [...audited.entries, candidate],
      entryLines: [...audited.entryLines, lineBytes],
      tornTailBytes: 0,
      state: nextState,
      cacheRevision: nextState.revision,
    };
    await republishStateCache(dirOpened, snapshot.entries, snapshot.state);
    return snapshotRecord({
      created: true,
      deduped: false,
      entry: candidate,
      state: nextState,
    });
  }

}

function canonicalEventBody(kind, data, dedupeKey) {
  return canonicalJsonStringify(dedupeKey === undefined
    ? { kind, data }
    : { kind, data, dedupe_key: dedupeKey });
}

async function healTornTailLocked(dirToken, bytes, tornTailBytes) {
  const goodLength = Number(bytes.byteLength) - tornTailBytes;
  const target = childPath(dirToken.path, JOURNAL_NAME);
  let handle;
  try {
    handle = await open(target, FILE_WRITE_FLAGS);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') {
      failJournal('run_journal_not_regular', JOURNAL_NAME,
        'The journal file must stay a regular non-symlink file while it is healed.');
    }
    if (error?.code === 'ENOENT') {
      failJournal('run_journal_not_found', JOURNAL_NAME,
        'The journal file disappeared before it could be healed.');
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, JOURNAL_NAME);
    await handle.truncate(goodLength);
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  await syncDirectory(dirToken.handle);
}

async function republishStateCache(dirToken, entries, state) {
  const canonical = `${canonicalJsonStringify(state)}\n`;
  const bytes = NodeBuffer.from(canonical, 'utf8');
  if (bytes.byteLength > MAX_RUN_JOURNAL_STATE_BYTES) {
    failJournal('run_journal_state_too_large', STATE_NAME,
      'The derived state cache exceeds the bounded size.');
  }
  await atomicPublish(dirToken, STATE_NAME, bytes, STATE_NAME);
  const reread = await readBoundedFile(dirToken, STATE_NAME, MAX_RUN_JOURNAL_STATE_BYTES, STATE_NAME);
  if (reread === null || !reread.bytes.equals(bytes)) {
    failJournal('run_journal_publish_unverified', STATE_NAME,
      'The published derived state did not verify.');
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function createRunJournal(options) {
  const parsed = parseJournalOptions(options);
  // Binding comes first: no journal path is created or read before an exact
  // validated accepted-P24 record exists for this run identity.
  const binding = await bindRecord(parsed.store, parsed.runId);
  const handle = await buildHandle(parsed, binding, 'create');
  // Restore-time discipline mirrors the accepted P24 store: the full layout,
  // chain, replay, and cache audit run before the caller sees the handle.
  await handle.currentState();
  return handle;
}

export async function openRunJournal(options) {
  const parsed = parseJournalOptions(options);
  const binding = await bindRecord(parsed.store, parsed.runId);
  const handle = await buildHandle(parsed, binding, 'open');
  await handle.currentState();
  return handle;
}

export async function createAggregateRunJournal(options) {
  const parsed = parseAggregateJournalOptions(options);
  const binding = await bindAggregateResolution(parsed.anchor, parsed.runId);
  const handle = await buildHandle(parsed, binding, 'create');
  await handle.currentState();
  return handle;
}

export async function openAggregateRunJournal(options) {
  const parsed = parseAggregateJournalOptions(options);
  const binding = await bindAggregateResolution(parsed.anchor, parsed.runId);
  const handle = await buildHandle(parsed, binding, 'open');
  await handle.currentState();
  return handle;
}
