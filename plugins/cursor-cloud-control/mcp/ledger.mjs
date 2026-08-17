import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CursorApiError } from './client.mjs';

const MAX_RECORDS = 500;
const LEDGER_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_STALE_MS = 1_000;
const DEFAULT_PENDING_RECOVERY_MS = 5 * 60 * 1_000;
const processStateQueues = new Map();
const activeSubmissionOwners = new Map();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite value cannot be digested.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  throw new TypeError(`Unsupported digest value: ${typeof value}`);
}

export function requestDigest(kind, value) {
  return createHash('sha256').update(JSON.stringify({ kind, value: canonical(value) })).digest('hex');
}

function now() { return new Date().toISOString(); }

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveStateDirectory(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'CURSOR_CLOUD_CONTROL_STATE_DIR')) {
    const configured = nonEmptyString(env.CURSOR_CLOUD_CONTROL_STATE_DIR);
    return {
      directory: configured ? path.resolve(configured) : null,
      source: 'environment',
      reason: configured ? null : 'CURSOR_CLOUD_CONTROL_STATE_DIR is empty.',
    };
  }
  const xdg = nonEmptyString(env.XDG_STATE_HOME);
  if (xdg) return { directory: path.resolve(path.join(xdg, 'cursor-cloud-control')), source: 'xdg_state_home', reason: null };
  const home = nonEmptyString(env.HOME);
  if (home) return { directory: path.resolve(path.join(home, '.local', 'state', 'cursor-cloud-control')), source: 'home', reason: null };
  return { directory: null, source: 'unconfigured', reason: 'Set CURSOR_CLOUD_CONTROL_STATE_DIR or HOME/XDG_STATE_HOME before using Cursor mutations.' };
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnerOnly(metadata, label, { directory = false } = {}) {
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new CursorApiError('ledger_permissions', `${label} must be an owner-only real ${directory ? 'directory' : 'file'}.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new CursorApiError('ledger_permissions', `${label} must not be group/world-readable or writable.`);
  }
  const uid = currentUid();
  if (uid !== null && metadata.uid !== uid) {
    throw new CursorApiError('ledger_permissions', `${label} must be owned by the MCP process user.`);
  }
}

function unavailable(error, target) {
  if (error instanceof CursorApiError) return error;
  const suffix = target ? ` (${target})` : '';
  if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT'].includes(error?.code)) {
    return new CursorApiError('ledger_unavailable', `Durable submission state is not writable${suffix}.`);
  }
  if (error?.code === 'ENOENT') {
    return new CursorApiError('ledger_unavailable', `Durable submission state is unavailable${suffix}.`);
  }
  return new CursorApiError('ledger_unavailable', `Unable to prepare durable submission state${suffix}.`);
}

function pathComponentSnapshot(component, metadata) {
  return { component, dev: metadata.dev, ino: metadata.ino };
}

function assertDirectoryComponent(metadata, component) {
  if (metadata.isSymbolicLink()) {
    throw new CursorApiError('ledger_permissions', `Submission ledger path component must be a real directory (${component}).`);
  }
  if (!metadata.isDirectory()) {
    throw new CursorApiError('ledger_unavailable', `Submission ledger path component is not a directory (${component}).`);
  }
}

async function revalidatePath(snapshot) {
  for (const expected of snapshot) {
    let metadata;
    try {
      metadata = await lstat(expected.component);
    } catch (error) {
      throw unavailable(error, expected.component);
    }
    assertDirectoryComponent(metadata, expected.component);
    if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
      throw new CursorApiError('ledger_permissions', `Submission ledger path component changed during an operation (${expected.component}).`);
    }
  }
}

async function inspectPathComponents(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const snapshot = [];
  let component = root;

  let metadata;
  try {
    metadata = await lstat(component);
  } catch (error) {
    throw unavailable(error, component);
  }
  assertDirectoryComponent(metadata, component);
  snapshot.push(pathComponentSnapshot(component, metadata));

  const relative = path.relative(root, absolute);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    await revalidatePath(snapshot);
    component = path.join(component, part);
    try {
      metadata = await lstat(component);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw unavailable(error, component);
      try {
        await mkdir(component, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== 'EEXIST') throw unavailable(createError, component);
      }
      await revalidatePath(snapshot);
      try {
        metadata = await lstat(component);
      } catch (createdError) {
        throw unavailable(createdError, component);
      }
    }
    assertDirectoryComponent(metadata, component);
    snapshot.push(pathComponentSnapshot(component, metadata));
  }
  await revalidatePath(snapshot);
  return snapshot;
}

async function inspectOrCreateDirectory(directory) {
  if (!directory) throw new CursorApiError('ledger_unavailable', 'No durable submission state directory is configured.');
  const snapshot = await inspectPathComponents(directory);
  const metadata = await lstat(directory);
  assertOwnerOnly(metadata, 'Submission ledger directory', { directory: true });
  return snapshot;
}

async function inspectLedgerFile(file, { allowMissing = true } = {}) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw unavailable(error, file);
  }
  assertOwnerOnly(metadata, 'Submission ledger');
  return metadata;
}

function validateRecord(record) {
  return Boolean(record && typeof record === 'object' && !Array.isArray(record)
    && typeof record.requestId === 'string'
    && typeof record.kind === 'string'
    && typeof record.digest === 'string'
    && /^[0-9a-f]{64}$/i.test(record.digest)
    && ['pending', 'completed', 'failed', 'uncertain'].includes(record.status)
    && (record.agentId === null || typeof record.agentId === 'string')
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && (record.owner === undefined || (record.owner && typeof record.owner === 'object'
      && !Array.isArray(record.owner)
      && Number.isInteger(record.owner.pid) && record.owner.pid > 0
      && typeof record.owner.token === 'string' && record.owner.token.length > 0
      && typeof record.owner.startedAt === 'string')));
}

function activeOwnerKey(stateDir, requestId) {
  return `${stateDir}\0${requestId}`;
}

function timestampMilliseconds(timestamp) {
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

async function probeWritable(directory, snapshot) {
  const temporary = path.join(directory, `.submissions-probe-${process.pid}-${randomUUID()}.tmp`);
  let safeToCleanup = true;
  try {
    await revalidatePath(snapshot);
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    const metadata = await lstat(temporary);
    assertOwnerOnly(metadata, 'Submission ledger probe');
    await revalidatePath(snapshot);
  } catch (error) {
    safeToCleanup = false;
    throw unavailable(error, directory);
  } finally {
    if (safeToCleanup) await unlink(temporary).catch(() => {});
  }
}

function lockTimeoutError(lockPath) {
  return new CursorApiError('ledger_lock_timeout', `Timed out waiting for the durable submission lock (${lockPath}).`);
}

function validLockOwner(owner) {
  return Boolean(owner && typeof owner === 'object' && !Array.isArray(owner)
    && typeof owner.token === 'string' && owner.token.length > 0
    && Number.isInteger(owner.pid) && owner.pid > 0);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled by this user.
    // Any other non-ESRCH error is treated as alive so lock recovery fails closed.
    return error?.code !== 'ESRCH';
  }
}

async function readLockOwner(lockPath) {
  const ownerPath = path.join(lockPath, 'owner.json');
  let metadata;
  try {
    metadata = await lstat(ownerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw unavailable(error, ownerPath);
  }
  assertOwnerOnly(metadata, 'Submission ledger lock owner');
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
  return validLockOwner(owner) ? owner : null;
}

async function removeStaleLock(lockPath, staleMs) {
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw unavailable(error, lockPath);
  }
  assertOwnerOnly(metadata, 'Submission ledger lock', { directory: true });
  if (Date.now() - metadata.mtimeMs < staleMs) return false;

  const owner = await readLockOwner(lockPath);
  // An unknown owner is deliberately never removed. A process can crash between
  // mkdir(lock) and writing owner.json, so a malformed or absent marker must
  // eventually time out rather than being guessed to be stale.
  if (!owner || processIsAlive(owner.pid)) return false;

  const ownerPath = path.join(lockPath, 'owner.json');
  try {
    await unlink(ownerPath);
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code === 'ENOTEMPTY') return false;
    throw unavailable(error, lockPath);
  }
}

async function acquireFileLock(directory, snapshot, {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  retryMs = DEFAULT_LOCK_RETRY_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
} = {}) {
  const lockPath = path.join(directory, 'submissions.lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  const owner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
  const deadline = Date.now() + timeoutMs;

  while (true) {
    await revalidatePath(snapshot);
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      assertOwnerOnly(await lstat(lockPath), 'Submission ledger lock', { directory: true });
      await writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      assertOwnerOnly(await lstat(ownerPath), 'Submission ledger lock owner');
      await revalidatePath(snapshot);
      return {
        async release() {
          await revalidatePath(snapshot);
          let metadata;
          try {
            metadata = await lstat(lockPath);
          } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw unavailable(error, lockPath);
          }
          assertOwnerOnly(metadata, 'Submission ledger lock', { directory: true });
          const current = await readLockOwner(lockPath);
          if (!current || current.token !== owner.token || current.pid !== owner.pid) {
            throw new CursorApiError('ledger_permissions', 'Submission ledger lock ownership changed during an operation.');
          }
          try {
            await unlink(ownerPath);
            await rmdir(lockPath);
          } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw unavailable(error, lockPath);
          }
        },
      };
    } catch (error) {
      if (created) {
        await unlink(ownerPath).catch(() => {});
        await rmdir(lockPath).catch(() => {});
      }
      if (error?.code !== 'EEXIST') throw unavailable(error, lockPath);
      await removeStaleLock(lockPath, staleMs);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockTimeoutError(lockPath);
    await sleep(Math.min(retryMs, remaining));
  }
}

async function withProcessStateLock(key, operation) {
  const previous = processStateQueues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  processStateQueues.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (processStateQueues.get(key) === tail) processStateQueues.delete(key);
  }
}

export class SubmissionLedger {
  constructor({
    stateDir,
    env = process.env,
    source,
    reason,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    lockRetryMs = DEFAULT_LOCK_RETRY_MS,
    lockStaleMs = DEFAULT_LOCK_STALE_MS,
    pendingRecoveryMs = DEFAULT_PENDING_RECOVERY_MS,
    clock = () => Date.now(),
  } = {}) {
    const resolved = stateDir === undefined ? resolveStateDirectory(env) : {
      directory: stateDir ? path.resolve(stateDir) : null,
      source: source ?? 'explicit',
      reason: stateDir ? null : (reason ?? 'No durable submission state directory is configured.'),
    };
    this.stateDir = resolved.directory;
    this.source = source ?? resolved.source;
    this.configurationReason = reason ?? resolved.reason;
    this.file = this.stateDir ? path.join(this.stateDir, 'submissions.json') : null;
    this.lockTimeoutMs = Number.isInteger(lockTimeoutMs) && lockTimeoutMs > 0 ? lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = Number.isInteger(lockRetryMs) && lockRetryMs > 0 ? lockRetryMs : DEFAULT_LOCK_RETRY_MS;
    this.lockStaleMs = Number.isInteger(lockStaleMs) && lockStaleMs >= 0 ? lockStaleMs : DEFAULT_LOCK_STALE_MS;
    this.pendingRecoveryMs = Number.isInteger(pendingRecoveryMs) && pendingRecoveryMs >= 0
      ? pendingRecoveryMs : DEFAULT_PENDING_RECOVERY_MS;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.records = new Map();
    this.loaded = false;
  }

  ownerFor(requestId) {
    return activeSubmissionOwners.get(activeOwnerKey(this.stateDir, requestId)) ?? null;
  }

  setOwner(requestId, owner) {
    if (owner?.token) activeSubmissionOwners.set(activeOwnerKey(this.stateDir, requestId), owner.token);
  }

  clearOwner(requestId, owner) {
    const key = activeOwnerKey(this.stateDir, requestId);
    if (!owner || activeSubmissionOwners.get(key) === owner.token) activeSubmissionOwners.delete(key);
  }

  isPendingStale(record) {
    const updatedAt = timestampMilliseconds(record.updatedAt);
    return updatedAt === null || this.clock() - updatedAt >= this.pendingRecoveryMs;
  }

  recoverPending(record) {
    if (record.status !== 'pending' || this.ownerFor(record.requestId) || !this.isPendingStale(record)) return record;
    const recoveredAt = new Date(this.clock()).toISOString();
    return {
      ...record,
      status: 'uncertain',
      updatedAt: recoveredAt,
      staleAt: recoveredAt,
      recoveryReason: 'stale_pending',
      reconciliationRequired: true,
    };
  }

  async loadLatestUnlocked({ probe = false } = {}) {
    if (this.configurationReason) throw new CursorApiError('ledger_unavailable', this.configurationReason);
    const snapshot = await inspectOrCreateDirectory(this.stateDir);
    const records = new Map();
    let recovered = false;
    const metadata = await inspectLedgerFile(this.file);
    if (metadata) {
      let parsed;
      try {
        parsed = JSON.parse(await readFile(this.file, 'utf8'));
      } catch {
        throw new CursorApiError('ledger_corrupt', 'Submission ledger is not valid JSON.');
      }
      if (parsed?.version !== LEDGER_VERSION || !Array.isArray(parsed.records) || parsed.records.some((record) => !validateRecord(record))) {
        throw new CursorApiError('ledger_corrupt', 'Submission ledger has an unsupported or invalid record format.');
      }
      for (const record of parsed.records.slice(-MAX_RECORDS)) {
        const normalized = this.recoverPending(record);
        if (normalized !== record) recovered = true;
        records.set(record.requestId, normalized);
      }
    }
    await revalidatePath(snapshot);
    if (probe) await probeWritable(this.stateDir, snapshot);
    await revalidatePath(snapshot);
    this.records = records;
    this.loaded = true;
    return recovered;
  }

  async loadLatest(options = {}) {
    return this.withFileLock(async () => undefined, options);
  }

  async init() {
    await this.loadLatest({ probe: true });
  }

  async persistUnlocked() {
    const snapshot = await inspectOrCreateDirectory(this.stateDir);
    await inspectLedgerFile(this.file);
    await revalidatePath(snapshot);
    const records = [...this.records.values()].slice(-MAX_RECORDS);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    let safeToCleanup = true;
    try {
      await writeFile(temporary, JSON.stringify({ version: LEDGER_VERSION, records }), { flag: 'wx', mode: 0o600 });
      assertOwnerOnly(await lstat(temporary), 'Submission ledger temporary file');
      await revalidatePath(snapshot);
      await rename(temporary, this.file);
      await revalidatePath(snapshot);
      assertOwnerOnly(await lstat(this.file), 'Submission ledger');
    } catch (error) {
      safeToCleanup = false;
      throw unavailable(error, this.file);
    } finally {
      if (safeToCleanup) await unlink(temporary).catch(() => {});
    }
  }

  async withMutation(operation) {
    return this.withFileLock(operation);
  }

  async withFileLock(operation, { probe = false } = {}) {
    if (this.configurationReason) throw new CursorApiError('ledger_unavailable', this.configurationReason);
    if (!this.stateDir) throw new CursorApiError('ledger_unavailable', 'No durable submission state directory is configured.');
    return withProcessStateLock(this.stateDir, async () => {
      const snapshot = await inspectOrCreateDirectory(this.stateDir);
      const lock = await acquireFileLock(this.stateDir, snapshot, {
        timeoutMs: this.lockTimeoutMs,
        retryMs: this.lockRetryMs,
        staleMs: this.lockStaleMs,
      });
      try {
        // A ledger instance may have read an older snapshot while another MCP
        // process was mutating. Always reload only after owning the lock.
        const recovered = await this.loadLatestUnlocked({ probe });
        if (recovered) await this.persistUnlocked();
        return await operation();
      } finally {
        await lock.release();
      }
    });
  }

  async readiness() {
    try {
      await this.init();
      return {
        ready: true,
        directory: this.stateDir,
        source: this.source,
        durability: 'owner-only-local-ledger',
      };
    } catch (error) {
      return {
        ready: false,
        directory: this.stateDir,
        source: this.source,
        durability: 'owner-only-local-ledger',
        reason: error?.message ?? 'Durable submission state is unavailable.',
        code: error?.code ?? 'ledger_unavailable',
      };
    }
  }

  async lookup(requestId) {
    return this.withFileLock(async () => this.records.get(requestId) ?? null);
  }

  async begin({ requestId, kind, digest, agentId = null }) {
    return this.withMutation(async () => {
      const existing = this.records.get(requestId);
      if (existing) {
        if (existing.digest !== digest || existing.kind !== kind) {
          throw new CursorApiError('request_id_conflict', 'The request ID was already used for a different operation.');
        }
        if (existing.status === 'uncertain') {
          throw new CursorApiError('uncertain_submission', 'A prior submission has an uncertain transport outcome; reconcile it before retrying.', { ambiguous: true });
        }
        if (existing.status === 'pending') {
          if (this.isPendingStale(existing) && !this.ownerFor(requestId)) {
            const recovered = this.recoverPending(existing);
            this.records.set(requestId, recovered);
            await this.persistUnlocked();
            throw new CursorApiError('uncertain_submission', 'A prior submission remained pending beyond the recovery bound; reconcile it before retrying.', { ambiguous: true });
          }
          throw new CursorApiError('submission_in_progress', 'A submission with this request ID is already in progress.');
        }
        if (existing.status === 'failed') {
          const timestamp = new Date(this.clock()).toISOString();
          const owner = { pid: process.pid, token: randomUUID(), startedAt: timestamp };
          const record = {
            ...existing,
            status: 'pending',
            agentId: agentId ?? existing.agentId ?? null,
            owner,
            updatedAt: timestamp,
          };
          this.records.set(requestId, record);
          this.setOwner(requestId, owner);
          await this.persistUnlocked();
          return { duplicate: false, record };
        }
        return { duplicate: true, record: existing };
      }
      const timestamp = new Date(this.clock()).toISOString();
      const owner = { pid: process.pid, token: randomUUID(), startedAt: timestamp };
      const record = { requestId, kind, digest, status: 'pending', agentId, owner, createdAt: timestamp, updatedAt: timestamp };
      this.records.set(requestId, record);
      this.setOwner(requestId, owner);
      await this.persistUnlocked();
      return { duplicate: false, record };
    });
  }

  async complete(requestId, fields = {}) {
    return this.withMutation(async () => {
      const current = this.records.get(requestId);
      if (!current) {
        throw new CursorApiError('ledger_record_missing', 'The durable submission record disappeared before completion could be recorded.');
      }
      const record = {
        ...current,
        ...fields,
        status: 'completed',
        updatedAt: new Date(this.clock()).toISOString(),
      };
      if (record.agentId === undefined) record.agentId = null;
      this.records.set(requestId, record);
      try {
        await this.persistUnlocked();
      } finally {
        // The provider call has already completed by the time finalization is
        // attempted. Never leave this process-local owner live when durable
        // finalization fails: the on-disk pending record must be allowed to
        // age into uncertain and be reconciled after a restart.
        this.clearOwner(requestId, current.owner);
      }
    });
  }

  async fail(requestId, fields = {}) {
    return this.withMutation(async () => {
      const current = this.records.get(requestId);
      if (!current) {
        throw new CursorApiError('ledger_record_missing', 'The durable submission record disappeared before failure could be recorded.');
      }
      const record = { ...current, ...fields, status: 'failed', updatedAt: new Date(this.clock()).toISOString() };
      if (record.agentId === undefined) record.agentId = null;
      this.records.set(requestId, record);
      try {
        await this.persistUnlocked();
      } finally {
        this.clearOwner(requestId, current.owner);
      }
    });
  }

  async uncertain(requestId, fields = {}) {
    return this.withMutation(async () => {
      const current = this.records.get(requestId);
      if (!current) {
        if (typeof fields.kind !== 'string' || !/^[0-9a-f]{64}$/i.test(fields.digest ?? '')) {
          throw new CursorApiError('ledger_record_missing', 'The durable submission record disappeared before uncertainty could be recorded.');
        }
        const timestamp = new Date(this.clock()).toISOString();
        const recovered = {
          requestId,
          kind: fields.kind,
          digest: fields.digest,
          status: 'uncertain',
          agentId: fields.agentId ?? null,
          ...(fields.runId ? { runId: fields.runId } : {}),
          recoveryReason: 'missing_final_record',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.records.set(requestId, recovered);
        await this.persistUnlocked();
        return;
      }
      if ((fields.kind && fields.kind !== current.kind) || (fields.digest && fields.digest !== current.digest)) {
        throw new CursorApiError('request_id_conflict', 'The request ID was already used for a different operation.');
      }
      const record = { ...current, ...fields, status: 'uncertain', updatedAt: new Date(this.clock()).toISOString() };
      if (record.agentId === undefined) record.agentId = null;
      this.records.set(requestId, record);
      try {
        await this.persistUnlocked();
      } finally {
        this.clearOwner(requestId, current.owner);
      }
    });
  }
}
