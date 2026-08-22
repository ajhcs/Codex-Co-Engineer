// Durable local run store — exclusive ownership and idempotent submission
// (ADR 0001 identifiers `exact_identities`, `immutable_repo_base_identity`,
// `bounded_evidence`, `no_post_dispatch_fallback_or_replay`; Gate A
// `gate_a_idempotent_submission`).
//
// Additive v3 module. It persists one bounded canonical record per run in a
// caller-supplied existing private directory. Records bind the accepted P06
// RunIdentityV1, GitIdentityV1, initial DispatchProvenanceV1 /
// DispatchTelemetryV1 facts, and request idempotency key. Exact same key plus
// canonical body returns the existing record without mutation; conflicts and
// mismatched protected identity fail closed.
//
// The store never derives filesystem paths from untrusted strings, never
// follows symlinks, never overwrites an authoritative record, and never
// echoes record contents or credentials. Restore reopens by auditing
// canonical bytes and recomputing every accepted P06 digest. There is no
// journal/reducer, scheduler, provider driver, artifact store, workspace
// provisioning, cleanup, MCP wiring, or protected-ref implementation.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, open, opendir, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  capturedCreate,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedTest,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
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
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  freezeData,
} from './selection-json.mjs';

export const RUN_STORE_RECORD_SCHEMA_ID = 'codex-co-engineer.run-store-record.v1';
export const MAX_RUN_STORE_ENTRIES = 64;
export const MAX_RUN_STORE_DIRECTORY_ENTRIES = 160;
export const MAX_RUN_STORE_RECORD_BYTES = 64 * 1024;
export const MAX_RUN_STORE_FILENAME_BYTES = 80;
export const MAX_RUN_STORE_KEY_FILE_BYTES = 80;
export const MAX_RUN_STORE_DIAGNOSTIC_BYTES = 160;

export const RUN_STORE_RECORD_KEYS = capturedFreeze([
  'schema', 'run_id', 'request_idempotency_key', 'identity', 'git',
  'provenance', 'telemetry', 'canonical_digest',
]);
export const RUN_STORE_INPUT_KEYS = capturedFreeze([
  'run_id', 'request_idempotency_key', 'identity', 'git', 'provenance', 'telemetry',
]);

const RECORD_NAME_PATTERN = /^[a-z][a-z0-9-]{2,63}\.json$/u;
const KEY_NAME_PATTERN = /^k-[0-9a-f]{64}$/u;
const TEMP_NAME_PATTERN = /^\.tmp-[0-9a-f]{32}$/u;
const IDEMPOTENCY_HEX_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const HASH_ALGORITHM = 'sha256';
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const CREATE_HASH = createHash;
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

const STORE_CHAINS = new Map();

function diagnostic(value) {
  const text = STRING(value ?? '');
  return text.length <= MAX_RUN_STORE_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_RUN_STORE_DIAGNOSTIC_BYTES);
}

function failStore(code, field, message) {
  fail(code, field, diagnostic(message));
}

function mapErrno(error, field, fallback, fallbackMessage) {
  if (error instanceof RunContractV1Error) throw error;
  const errno = error?.code;
  if (errno === 'ENOENT') failStore('run_store_root_missing', field, 'The run store path does not exist.');
  if (errno === 'ELOOP' || errno === 'ENOTDIR') {
    failStore('run_store_root_unsafe', field, 'The run store path is not a real directory.');
  }
  if (errno === 'EEXIST') failStore('run_identity_conflict', field, fallbackMessage);
  failStore(fallback, field, fallbackMessage);
}

function assertSafeRootPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    failStore('run_store_root_unsafe', 'root', 'Run store root must be an absolute directory path.');
  }
  if (!path.isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    failStore('run_store_path_unsafe', 'root', 'Run store root must be an absolute, NUL-free path.');
  }
  if (value !== '/' && value.endsWith('/')) {
    failStore('run_store_path_unsafe', 'root', 'Run store root must not end with a trailing slash.');
  }
  if (path.normalize(value) !== value) {
    failStore('run_store_path_unsafe', 'root', 'Run store root must be a normalized absolute path.');
  }
  const parts = value.split('/');
  for (const part of parts) {
    if (part === '.' || part === '..') {
      failStore('run_store_path_unsafe', 'root', 'Run store root must not contain "." or ".." segments.');
    }
  }
  return value;
}

function assertSafeChildName(name, field) {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..') {
    failStore('run_store_foreign_entry', field, 'Run store directory entry is not an allowed name.');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || path.basename(name) !== name) {
    failStore('run_store_path_unsafe', field, 'Run store filenames must be single path components.');
  }
  if (utf8ByteLength(name) > MAX_RUN_STORE_FILENAME_BYTES) {
    failStore('run_store_foreign_entry', field, 'Run store filename exceeds the bounded length.');
  }
  return name;
}

function ownerUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function assertPrivateEntry(stat, field, kind) {
  if (stat.isSymbolicLink()) {
    failStore('run_store_root_unsafe', field, `The run store ${kind} must not be a symbolic link.`);
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failStore('run_store_root_unsafe', field,
      `The run store ${kind} must be owned by the current user.`);
  }
  if ((stat.mode & 0o022) !== 0) {
    failStore('run_store_root_unsafe', field,
      `The run store ${kind} must not be writable by group or other users.`);
  }
  if (kind === 'directory' && (stat.mode & 0o077) !== 0) {
    failStore('run_store_root_unsafe', field,
      'The run store directory must be private (no group or other access).');
  }
}

function assertRegularUnsharedFile(stat, field) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    failStore('run_store_not_regular', field, 'Run store files must be regular non-symlink files.');
  }
  if (!NUMBER_IS_SAFE_INTEGER(stat.nlink) || stat.nlink !== 1) {
    failStore('run_store_not_regular', field, 'Run store files must not be hardlinked.');
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failStore('run_store_root_unsafe', field, 'Run store files must be owned by the current user.');
  }
  if ((stat.mode & 0o077) !== 0) {
    failStore('run_store_root_unsafe', field, 'Run store files must be owner-only.');
  }
}

function sameIdentity(left, right) {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

async function openRootHandle(rootPath) {
  const resolved = assertSafeRootPath(rootPath);
  let handle;
  try {
    handle = await open(resolved, ROOT_OPEN_FLAGS);
  } catch (error) {
    mapErrno(error, 'root', 'run_store_root_unsafe',
      'The run store root could not be opened without following links.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      failStore('run_store_root_unsafe', 'root', 'The run store root must be a real directory.');
    }
    assertPrivateEntry(stat, 'root', 'directory');
    return { handle, path: resolved, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertRootUnchanged(token) {
  const opened = await openRootHandle(token.path);
  try {
    if (!sameIdentity(opened, token)) {
      failStore('run_store_root_unsafe', 'root',
        'The run store root was replaced during use.');
    }
    return opened;
  } catch (error) {
    await opened.handle.close().catch(() => {});
    throw error;
  }
}

function childPath(rootPath, name) {
  const safe = assertSafeChildName(name, 'name');
  const joined = path.join(rootPath, safe);
  if (path.dirname(joined) !== rootPath || path.basename(joined) !== safe) {
    failStore('run_store_path_unsafe', 'name', 'Run store child path escaped the private root.');
  }
  return joined;
}

function recordNameFor(runId) {
  assertRunId(runId, 'run_id');
  return `${runId}.json`;
}

function keyNameFor(requestKey, field = 'request_idempotency_key') {
  if (typeof requestKey !== 'string') {
    failStore('invalid_format', field, 'Request idempotency key must be a sha256 digest.');
  }
  const match = IDEMPOTENCY_HEX_PATTERN.exec(requestKey);
  if (!match) failStore('invalid_format', field, 'Request idempotency key must be a sha256 digest.');
  return `k-${match[1]}`;
}

function classifyName(name) {
  if (capturedTest(TEMP_NAME_PATTERN, name)) return 'temp';
  if (capturedTest(RECORD_NAME_PATTERN, name)) return 'record';
  if (capturedTest(KEY_NAME_PATTERN, name)) return 'key';
  return 'foreign';
}

function equalBytes(left, right) {
  if (!NodeBuffer.isBuffer(left) || !NodeBuffer.isBuffer(right) || left.length !== right.length) {
    return false;
  }
  return TIMING_SAFE_EQUAL(left, right);
}

function hashCanonical(canonical) {
  return `sha256:${CREATE_HASH(HASH_ALGORITHM).update(canonical, 'utf8').digest('hex')}`;
}

function bindRecord(payload) {
  const canonical = canonicalJsonStringify(payload);
  const record = snapshotRecord({ ...payload, canonical_digest: hashCanonical(canonical) });
  const bytes = BUFFER_FROM(`${canonicalJsonStringify(record)}\n`, 'utf8');
  if (bytes.byteLength > MAX_RUN_STORE_RECORD_BYTES) {
    failStore('run_store_record_too_large', 'record',
      `Run store records must not exceed ${MAX_RUN_STORE_RECORD_BYTES} bytes.`);
  }
  return { record, canonical, bytes };
}

function assertMatchingIdentities(input) {
  const identity = validateRunIdentityV1(input.identity, 'identity');
  const git = validateGitIdentityV1(input.git, 'git');
  assertSharedGitIdentityV1(identity.git, git, 'git');
  const provenance = validateDispatchProvenanceV1(input.provenance);
  const telemetry = validateDispatchTelemetryV1(input.telemetry);
  if (identity.run_id !== input.run_id || provenance.run.run_id !== input.run_id) {
    failStore('run_identity_mismatch', 'run_id',
      'Run store records must bind one run identity.');
  }
  if (identity.digest !== provenance.run.digest) {
    failStore('run_identity_mismatch', 'identity',
      'Run identity does not match the stored provenance run.');
  }
  if (git.digest !== provenance.git.digest || git.digest !== identity.git.digest) {
    failStore('run_identity_mismatch', 'git',
      'Git identity does not match the immutable repository/base authority.');
  }
  if (provenance.provider_run.request_idempotency_key !== input.request_idempotency_key) {
    failStore('run_identity_mismatch', 'request_idempotency_key',
      'Request idempotency key does not match the protected provider-run key.');
  }
  const projected = projectDispatchTelemetryV1(provenance);
  const projectedCanonical = canonicalJsonStringify(projected);
  const telemetryCanonical = canonicalJsonStringify(telemetry);
  if (projectedCanonical !== telemetryCanonical) {
    failStore('run_identity_mismatch', 'telemetry',
      'Telemetry must be the content-free projection of the stored provenance.');
  }
  return { identity, git, provenance, telemetry };
}

function parseSubmitInput(input) {
  if (input === undefined || input === null) {
    failStore('invalid_type', 'record', 'Run store submission must be a plain JSON data object.');
  }
  assertDirectJsonClosure(input, 'record');
  const fields = closedObject(input, 'record', RUN_STORE_INPUT_KEYS);
  assertRunId(fields.run_id, 'run_id');
  assertBoundDigest(fields.request_idempotency_key, 'request_idempotency_key');
  const bound = assertMatchingIdentities(fields);
  return bindRecord({
    schema: RUN_STORE_RECORD_SCHEMA_ID,
    run_id: fields.run_id,
    request_idempotency_key: fields.request_idempotency_key,
    identity: bound.identity,
    git: bound.git,
    provenance: bound.provenance,
    telemetry: bound.telemetry,
  });
}

function assertNoDuplicateJsonKeys(text, field) {
  if (typeof text !== 'string') {
    failStore('run_store_malformed_record', field, 'Run store records must be UTF-8 JSON text.');
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
              failStore('run_store_malformed_record', field, 'Run store JSON key is invalid.');
            }
            if (scope.keys.has(key)) {
              failStore('run_store_duplicate_entry', field,
                'Run store JSON objects must not contain duplicate keys.');
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
        failStore('run_store_malformed_record', field, 'Run store JSON exceeds the nesting bound.');
      }
      continue;
    }
    if (char === '[') {
      scopes.push({ object: false, keys: new Set() });
      if (scopes.length > 40) {
        failStore('run_store_malformed_record', field, 'Run store JSON exceeds the nesting bound.');
      }
      continue;
    }
    if (char === '}' || char === ']') {
      if (scopes.length <= 1) {
        failStore('run_store_malformed_record', field, 'Run store JSON is unbalanced.');
      }
      scopes.pop();
    }
  }
  if (inString || scopes.length !== 1) {
    failStore('run_store_malformed_record', field, 'Run store JSON is incomplete.');
  }
}

function decodeUtf8(bytes, field) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failStore('run_store_malformed_record', field, 'Run store records must not begin with a UTF-8 BOM.');
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    failStore('run_store_malformed_record', field, 'Run store records must be valid UTF-8.');
  }
}

function parseStoredRecord(bytes, field) {
  if (!NodeBuffer.isBuffer(bytes) || bytes.byteLength === 0) {
    failStore('run_store_malformed_record', field, 'Run store record is truncated.');
  }
  if (bytes.byteLength > MAX_RUN_STORE_RECORD_BYTES) {
    failStore('run_store_record_too_large', field,
      `Run store records must not exceed ${MAX_RUN_STORE_RECORD_BYTES} bytes.`);
  }
  const text = decodeUtf8(bytes, field);
  assertNoDuplicateJsonKeys(text, field);
  let parsed;
  try {
    parsed = JSON_PARSE(text);
  } catch {
    failStore('run_store_malformed_record', field, 'Run store record is not valid JSON.');
  }
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failStore('run_store_malformed_record', field, 'Run store record must be a JSON object.');
  }
  assertDirectJsonClosure(parsed, field);
  const fields = closedObject(parsed, field, RUN_STORE_RECORD_KEYS);
  if (fields.schema !== RUN_STORE_RECORD_SCHEMA_ID) {
    failStore('run_store_malformed_record', `${field}.schema`,
      `Run store schema must be exactly "${RUN_STORE_RECORD_SCHEMA_ID}".`);
  }
  assertRunId(fields.run_id, `${field}.run_id`);
  assertBoundDigest(fields.request_idempotency_key, `${field}.request_idempotency_key`);
  if (!capturedTest(SHA256_DIGEST_PATTERN, fields.canonical_digest)) {
    failStore('invalid_format', `${field}.canonical_digest`,
      'Run store canonical digest must be a sha256 digest.');
  }
  const bound = assertMatchingIdentities(fields);
  const rebuilt = bindRecord({
    schema: RUN_STORE_RECORD_SCHEMA_ID,
    run_id: fields.run_id,
    request_idempotency_key: fields.request_idempotency_key,
    identity: bound.identity,
    git: bound.git,
    provenance: bound.provenance,
    telemetry: bound.telemetry,
  });
  if (rebuilt.record.canonical_digest !== fields.canonical_digest
    || !equalBytes(rebuilt.bytes, bytes)) {
    failStore('run_identity_mismatch', field,
      'Stored canonical bytes do not match the recomputed P06-bound record.');
  }
  return rebuilt;
}

async function openChildFile(rootPath, name, flags, field) {
  const target = childPath(rootPath, name);
  try {
    return await open(target, flags, 0o600);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      failStore('run_store_not_regular', field, 'Run store files must be regular non-symlink files.');
    }
    if (error?.code === 'EEXIST') return undefined;
    mapErrno(error, field, 'run_store_unreadable', 'The run store file could not be opened safely.');
  }
}

async function readExactFile(rootPath, name, maxBytes, field) {
  const handle = await openChildFile(rootPath, name, FILE_READ_FLAGS, field);
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    const size = Number(stat.size);
    if (!NUMBER_IS_SAFE_INTEGER(size) || size > maxBytes) {
      failStore('run_store_record_too_large', field, 'Run store file exceeds the bounded size.');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      failStore('run_store_record_too_large', field, 'Run store file exceeds the bounded size.');
    }
    const after = await handle.stat();
    if (Number(after.ino) !== Number(stat.ino) || Number(after.dev) !== Number(stat.dev)
      || Number(after.size) !== Number(stat.size) || Number(after.nlink) !== Number(stat.nlink)) {
      failStore('run_store_unreadable', field, 'The run store file changed while it was read.');
    }
    return { bytes, stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectChild(rootPath, name, field) {
  const handle = await openChildFile(rootPath, name, FILE_READ_FLAGS, field);
  if (handle === null) return { kind: 'missing' };
  try {
    const stat = await handle.stat();
    if (stat.isSymbolicLink() || !stat.isFile()) {
      failStore('run_store_not_regular', field, 'Run store files must be regular non-symlink files.');
    }
    return { kind: 'file', stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function syncDirectory(rootHandle) {
  try {
    await rootHandle.sync();
  } catch (error) {
    if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP') return;
    failStore('run_store_unreadable', 'root', 'The run store directory could not be synchronized.');
  }
}

async function writePrivateTemp(root, bytes) {
  const name = `.tmp-${RANDOM_BYTES(16).toString('hex')}`;
  const target = childPath(root.path, name);
  const handle = await openChildFile(root.path, name, FILE_CREATE_FLAGS, 'temporary');
  if (handle === null || handle === undefined) {
    failStore('run_store_unreadable', 'temporary', 'A private temporary file could not be created exclusively.');
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, 'temporary');
    if (Number(stat.size) !== bytes.byteLength) {
      failStore('run_store_unreadable', 'temporary', 'Temporary write was truncated.');
    }
    await syncDirectory(root.handle);
    return { name, path: target };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(target).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function unlinkPrivateTemp(rootPath, name) {
  if (!capturedTest(TEMP_NAME_PATTERN, name)) return;
  const target = childPath(rootPath, name);
  try {
    const handle = await open(target, FILE_READ_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.isSymbolicLink()) {
        failStore('run_store_torn_temporary', 'temporary',
          'A leftover temporary path is not a regular file and was not followed.');
      }
      const uid = ownerUid();
      if (uid !== undefined && Number(stat.uid) !== uid) return;
    } finally {
      await handle.close().catch(() => {});
    }
    await unlink(target);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    if (error?.code === 'ENOENT') return;
    if (error?.code === 'ELOOP') {
      failStore('run_store_torn_temporary', 'temporary',
        'A leftover temporary path is a symbolic link and was not followed.');
    }
  }
}

async function exclusiveLink(tmpPath, destPath, field) {
  try {
    await link(tmpPath, destPath);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    if (error?.code === 'ELOOP') {
      failStore('run_store_not_regular', field, 'Run store files must be regular non-symlink files.');
    }
    mapErrno(error, field, 'run_store_unreadable', 'The run store record could not be published exclusively.');
  }
  return true;
}

async function readKeyPointer(rootPath, keyName, field) {
  const opened = await readExactFile(rootPath, keyName, MAX_RUN_STORE_KEY_FILE_BYTES, field);
  if (opened === null) return null;
  const text = decodeUtf8(opened.bytes, field).replace(/\n$/u, '');
  assertRunId(text, field);
  return text;
}

async function enumerateDirectory(root) {
  let dir;
  try {
    dir = await opendir(root.path, { bufferSize: 16 });
  } catch (error) {
    mapErrno(error, 'root', 'run_store_unreadable', 'The run store directory could not be enumerated.');
  }
  const names = [];
  try {
    let count = 0;
    while (true) {
      const entry = await dir.read();
      if (entry === null) break;
      count += 1;
      if (count > MAX_RUN_STORE_DIRECTORY_ENTRIES) {
        failStore('run_store_too_many_entries', 'root',
          `Run store directories must not exceed ${MAX_RUN_STORE_DIRECTORY_ENTRIES} entries.`);
      }
      if (entry.name === '.' || entry.name === '..') continue;
      names.push(assertSafeChildName(entry.name, 'root'));
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return names;
}

async function auditStore(root) {
  const before = await root.handle.stat();
  const names = await enumerateDirectory(root);
  const after = await root.handle.stat();
  if (!sameIdentity(before, after) || Number(before.mode) !== Number(after.mode)) {
    failStore('run_store_root_unsafe', 'root',
      'The run store root changed while it was audited.');
  }
  const records = capturedCreate(null);
  const keys = capturedCreate(null);
  const seenKeys = capturedCreate(null);
  let recordCount = 0;
  for (const name of names) {
    const kind = classifyName(name);
    if (kind === 'temp') {
      failStore('run_store_torn_temporary', 'temporary',
        'Leftover temporary files are not authoritative and are not followed.');
    }
    if (kind === 'foreign') {
      failStore('run_store_foreign_entry', 'root',
        'The run store directory contains a foreign or oversized entry.');
    }
    const inspection = await inspectChild(root.path, name, kind);
    if (inspection.kind !== 'file') {
      failStore('run_store_not_regular', kind, 'Run store files must be regular non-symlink files.');
    }
    assertRegularUnsharedFile(inspection.stat, kind);
    if (kind === 'record') {
      recordCount += 1;
      if (recordCount > MAX_RUN_STORE_ENTRIES) {
        failStore('run_store_too_many_entries', 'root',
          `Run store directories must not exceed ${MAX_RUN_STORE_ENTRIES} records.`);
      }
      const opened = await readExactFile(root.path, name, MAX_RUN_STORE_RECORD_BYTES, 'record');
      if (opened === null) {
        failStore('run_store_torn_record', 'record', 'A named run record could not be read.');
      }
      const parsed = parseStoredRecord(opened.bytes, 'record');
      const expectedName = recordNameFor(parsed.record.run_id);
      if (expectedName !== name) {
        failStore('run_store_foreign_entry', 'record',
          'Record filename does not match the bound run id.');
      }
      if (capturedHasOwn(records, parsed.record.run_id)) {
        failStore('run_store_duplicate_entry', 'run_id',
          'Run store directories must contain one record per run id.');
      }
      if (capturedHasOwn(seenKeys, parsed.record.request_idempotency_key)) {
        failStore('run_store_duplicate_entry', 'request_idempotency_key',
          'Run store directories must contain one record per request idempotency key.');
      }
      records[parsed.record.run_id] = parsed.record;
      seenKeys[parsed.record.request_idempotency_key] = parsed.record.run_id;
    } else {
      const runId = await readKeyPointer(root.path, name, 'key');
      const hex = name.slice(2);
      const requestKey = `sha256:${hex}`;
      if (capturedHasOwn(keys, requestKey)) {
        failStore('run_store_duplicate_entry', 'request_idempotency_key',
          'Run store directories must contain one key pointer per request.');
      }
      keys[requestKey] = runId;
    }
  }
  const recordIds = sortedCapturedKeys(records);
  for (const runId of recordIds) {
    const record = records[runId];
    const expectedKeyName = keyNameFor(record.request_idempotency_key);
    const pointed = keys[record.request_idempotency_key];
    if (pointed === undefined) {
      failStore('run_store_torn_record', 'request_idempotency_key',
        'Run records require a matching request idempotency pointer.');
    }
    if (pointed !== runId) {
      failStore('run_identity_mismatch', 'request_idempotency_key',
        'Request idempotency pointer does not name the stored run.');
    }
    if (!capturedIncludes(names, expectedKeyName)) {
      failStore('run_store_torn_record', 'request_idempotency_key',
        'Run records require a matching request idempotency pointer.');
    }
  }
  for (const requestKey of sortedCapturedKeys(keys)) {
    if (!capturedHasOwn(seenKeys, requestKey)) {
      failStore('run_store_torn_record', 'request_idempotency_key',
        'A request idempotency pointer has no matching run record.');
    }
  }
  return { records, keys: seenKeys };
}

function withStoreChain(token, operation) {
  const id = `${STRING(token.dev)}:${STRING(token.ino)}`;
  const previous = STORE_CHAINS.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.catch(() => {}).then(() => {
    if (STORE_CHAINS.get(id) === settled) STORE_CHAINS.delete(id);
  });
  STORE_CHAINS.set(id, settled);
  return current;
}

function conflictFor(existing, candidate) {
  if (existing.run_id === candidate.run_id
    && existing.request_idempotency_key === candidate.request_idempotency_key
    && existing.canonical_digest === candidate.canonical_digest) {
    return null;
  }
  if (existing.request_idempotency_key === candidate.request_idempotency_key) {
    failStore('run_idempotency_conflict', 'request_idempotency_key',
      'Request idempotency key already binds a different canonical body.');
  }
  failStore('run_identity_conflict', 'run_id',
    'Run id already binds a different body or request idempotency key.');
}

function listProjection(record) {
  return snapshotRecord({
    run_id: record.run_id,
    request_idempotency_key: record.request_idempotency_key,
    identity_digest: record.identity.digest,
    git_digest: record.git.digest,
    canonical_digest: record.canonical_digest,
  });
}

async function operate(token, fn) {
  return withStoreChain(token, async () => {
    const root = await assertRootUnchanged(token);
    try {
      const inventory = await auditStore(root);
      return await fn(root, inventory);
    } finally {
      await root.handle.close().catch(() => {});
    }
  });
}

async function publishRecord(root, prepared) {
  const recordName = recordNameFor(prepared.record.run_id);
  const keyName = keyNameFor(prepared.record.request_idempotency_key);
  const keyBytes = BUFFER_FROM(`${prepared.record.run_id}\n`, 'utf8');
  const recordTmp = await writePrivateTemp(root, prepared.bytes);
  let keyTmp;
  try {
    keyTmp = await writePrivateTemp(root, keyBytes);
    const keyPath = childPath(root.path, keyName);
    const recordPath = childPath(root.path, recordName);
    const linkedKey = await exclusiveLink(keyTmp.path, keyPath, 'request_idempotency_key');
    if (!linkedKey) {
      const owner = await readKeyPointer(root.path, keyName, 'request_idempotency_key');
      const existingName = owner ? recordNameFor(owner) : recordName;
      const existing = await readExactFile(root.path, existingName, MAX_RUN_STORE_RECORD_BYTES, 'record');
      if (existing === null) {
        failStore('run_store_torn_record', 'request_idempotency_key',
          'A request idempotency pointer has no matching run record.');
      }
      const parsed = parseStoredRecord(existing.bytes, 'record');
      conflictFor(parsed.record, prepared.record);
      return { record: parsed.record, created: false };
    }
    const linkedRecord = await exclusiveLink(recordTmp.path, recordPath, 'run_id');
    if (!linkedRecord) {
      await unlink(keyPath).catch(() => {});
      const existing = await readExactFile(root.path, recordName, MAX_RUN_STORE_RECORD_BYTES, 'record');
      if (existing === null) {
        failStore('run_identity_conflict', 'run_id',
          'Run id already binds a different body or request idempotency key.');
      }
      const parsed = parseStoredRecord(existing.bytes, 'record');
      conflictFor(parsed.record, prepared.record);
      return { record: parsed.record, created: false };
    }
    await unlinkPrivateTemp(root.path, recordTmp.name);
    await unlinkPrivateTemp(root.path, keyTmp.name);
    await syncDirectory(root.handle);
    const published = await readExactFile(root.path, recordName, MAX_RUN_STORE_RECORD_BYTES, 'record');
    if (published === null) {
      failStore('run_store_torn_record', 'record', 'Published run record could not be re-read.');
    }
    const parsed = parseStoredRecord(published.bytes, 'record');
    return { record: parsed.record, created: true };
  } finally {
    await unlinkPrivateTemp(root.path, recordTmp.name);
    if (keyTmp) await unlinkPrivateTemp(root.path, keyTmp.name);
  }
}

export async function openRunStore(rootPath) {
  const opened = await openRootHandle(rootPath);
  try {
    const inventory = await auditStore(opened);
    const token = capturedFreeze({
      path: opened.path,
      dev: opened.dev,
      ino: opened.ino,
    });
    freezeData(inventory.records);
    freezeData(inventory.keys);
    return capturedFreeze({
      root: token.path,
      async submit(input) {
        const prepared = parseSubmitInput(input);
        return operate(token, async (root, current) => {
          const existing = current.records[prepared.record.run_id];
          const keyed = current.keys[prepared.record.request_idempotency_key];
          if (existing) {
            conflictFor(existing, prepared.record);
            return { record: existing, created: false };
          }
          if (keyed !== undefined) {
            const other = current.records[keyed];
            if (other) conflictFor(other, prepared.record);
            failStore('run_idempotency_conflict', 'request_idempotency_key',
              'Request idempotency key already binds a different canonical body.');
          }
          if (sortedCapturedKeys(current.records).length >= MAX_RUN_STORE_ENTRIES) {
            failStore('run_store_too_many_entries', 'root',
              `Run store directories must not exceed ${MAX_RUN_STORE_ENTRIES} records.`);
          }
          return publishRecord(root, prepared);
        });
      },
      async getByRunId(runId) {
        assertRunId(runId, 'run_id');
        return operate(token, async (_root, current) => {
          const record = current.records[runId];
          if (!record) failStore('run_store_not_found', 'run_id', 'No run record exists for that run id.');
          return record;
        });
      },
      async getByIdempotencyKey(requestKey) {
        assertBoundDigest(requestKey, 'request_idempotency_key');
        return operate(token, async (_root, current) => {
          const runId = current.keys[requestKey];
          if (runId === undefined) {
            failStore('run_store_not_found', 'request_idempotency_key',
              'No run record exists for that request idempotency key.');
          }
          return current.records[runId];
        });
      },
      async list() {
        return operate(token, async (_root, current) => {
          const ids = sortedCapturedKeys(current.records);
          const entries = ids.map((runId) => listProjection(current.records[runId]));
          return capturedFreeze(entries);
        });
      },
    });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

capturedFreeze(openRunStore);
capturedFreeze(parseSubmitInput);
capturedFreeze(parseStoredRecord);
