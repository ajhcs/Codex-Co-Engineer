import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
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
    if (!configured) {
      return {
        directory: null,
        source: 'environment',
        reason: 'CURSOR_CLOUD_CONTROL_STATE_DIR is empty.',
      };
    }
    if (!path.isAbsolute(configured)) {
      return {
        directory: null,
        source: 'environment',
        reason: 'CURSOR_CLOUD_CONTROL_STATE_DIR must be an absolute path.',
      };
    }
    return {
      directory: configured,
      source: 'environment',
      reason: null,
    };
  }
  if (Object.prototype.hasOwnProperty.call(env, 'CODEX_TASK_STATE_ROOT')) {
    const sharedRoot = nonEmptyString(env.CODEX_TASK_STATE_ROOT);
    if (!sharedRoot) {
      return {
        directory: null,
        source: 'task_state_root',
        reason: 'CODEX_TASK_STATE_ROOT is empty.',
      };
    }
    if (!path.isAbsolute(sharedRoot)) {
      return {
        directory: null,
        source: 'task_state_root',
        reason: 'CODEX_TASK_STATE_ROOT must be an absolute path.',
      };
    }
    return {
      directory: path.join(sharedRoot, 'cursor-cloud-control'),
      source: 'task_state_root',
      reason: null,
    };
  }
  const xdg = nonEmptyString(env.XDG_STATE_HOME);
  if (xdg) {
    if (!path.isAbsolute(xdg)) {
      return {
        directory: null,
        source: 'xdg_state_home',
        reason: 'XDG_STATE_HOME must be an absolute path.',
      };
    }
    return { directory: path.join(xdg, 'cursor-cloud-control'), source: 'xdg_state_home', reason: null };
  }
  const home = nonEmptyString(env.HOME);
  if (home) {
    if (!path.isAbsolute(home)) {
      return {
        directory: null,
        source: 'home',
        reason: 'HOME must be an absolute path.',
      };
    }
    return { directory: path.join(home, '.local', 'state', 'cursor-cloud-control'), source: 'home', reason: null };
  }
  return {
    directory: null,
    source: 'unconfigured',
    reason: 'Set CURSOR_CLOUD_CONTROL_STATE_DIR, CODEX_TASK_STATE_ROOT, or HOME/XDG_STATE_HOME before using Cursor mutations.',
  };
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

function assertSecureLedgerDirectory(metadata, label) {
  assertOwnerOnly(metadata, label, { directory: true });
  if ((metadata.mode & 0o7777) !== 0o700) {
    throw new CursorApiError('ledger_permissions', `${label} must have mode 0700.`);
  }
}

function assertSecureLedgerFile(metadata, label) {
  assertOwnerOnly(metadata, label);
  if (metadata.nlink !== 1) {
    throw new CursorApiError('ledger_permissions', `${label} must have exactly one hard link.`);
  }
  if ((metadata.mode & 0o7777) !== 0o600) {
    throw new CursorApiError('ledger_permissions', `${label} must have mode 0600.`);
  }
}

function fileIdentity(metadata) {
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertFileIdentity(metadata, expected, label) {
  if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
    throw new CursorApiError('ledger_permissions', `${label} changed during an operation.`);
  }
}

export function secureLedgerOpenFlags(flags, noFollow = fsConstants.O_NOFOLLOW) {
  if (!Number.isInteger(noFollow) || noFollow === 0) {
    throw new CursorApiError('ledger_unavailable', 'Secure no-follow ledger file operations are unavailable on this host.');
  }
  return flags | noFollow;
}

const noFollowFlags = secureLedgerOpenFlags;

function ledgerFileError(error, file, label = 'Submission ledger') {
  if (error instanceof CursorApiError) return error;
  if (error?.code === 'ELOOP') {
    return new CursorApiError('ledger_permissions', `${label} must not be a symbolic link (${file}).`);
  }
  return unavailable(error, file);
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
  if ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) {
    throw new CursorApiError(
      'ledger_permissions',
      `Submission ledger path component must not be group/world-writable unless it has the sticky bit (${component}).`,
    );
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
  assertSecureLedgerDirectory(metadata, 'Submission ledger directory');
  return snapshot;
}

async function confirmMissingLedgerFile(file, snapshot) {
  await revalidatePath(snapshot);
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw ledgerFileError(error, file);
  }
  throw new CursorApiError('ledger_permissions', 'Submission ledger appeared while its absence was being verified.');
}

async function inspectLedgerFile(file, snapshot, {
  allowMissing = true,
  expectedIdentity,
  read = false,
  label = 'Submission ledger',
} = {}) {
  await revalidatePath(snapshot);
  let handle;
  try {
    handle = await open(file, noFollowFlags(fsConstants.O_RDONLY));
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      await confirmMissingLedgerFile(file, snapshot);
      return null;
    }
    throw ledgerFileError(error, file, label);
  }

  try {
    const before = await handle.stat();
    assertSecureLedgerFile(before, label);
    const identity = fileIdentity(before);
    if (expectedIdentity) assertFileIdentity(before, expectedIdentity, label);

    const contents = read ? await handle.readFile({ encoding: 'utf8' }) : undefined;
    const after = await handle.stat();
    assertSecureLedgerFile(after, label);
    assertFileIdentity(after, identity, label);
    if (expectedIdentity) assertFileIdentity(after, expectedIdentity, label);

    await revalidatePath(snapshot);
    let pathMetadata;
    try {
      pathMetadata = await lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new CursorApiError('ledger_permissions', `${label} changed during an operation.`);
      }
      throw error;
    }
    assertSecureLedgerFile(pathMetadata, label);
    assertFileIdentity(pathMetadata, identity, label);
    await revalidatePath(snapshot);
    return { contents, identity };
  } catch (error) {
    throw ledgerFileError(error, file, label);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function cleanupTemporaryFile(file, expectedIdentity) {
  if (!expectedIdentity) return;
  try {
    const metadata = await lstat(file);
    if (!metadata.isSymbolicLink()
      && metadata.dev === expectedIdentity.dev
      && metadata.ino === expectedIdentity.ino) {
      await unlink(file);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Cleanup is best effort. The operation's original fail-closed error is
      // more useful than a secondary cleanup error.
    }
  }
}

async function writeLedgerFile(file, payload, snapshot) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let identity;
  let renamed = false;
  try {
    await revalidatePath(snapshot);
    try {
      handle = await open(
        temporary,
        noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
        0o600,
      );
    } catch (error) {
      throw ledgerFileError(error, temporary, 'Submission ledger temporary file');
    }

    const before = await handle.stat();
    assertSecureLedgerFile(before, 'Submission ledger temporary file');
    identity = fileIdentity(before);
    await handle.writeFile(payload, { encoding: 'utf8' });
    const after = await handle.stat();
    assertSecureLedgerFile(after, 'Submission ledger temporary file');
    assertFileIdentity(after, identity, 'Submission ledger temporary file');

    await revalidatePath(snapshot);
    const temporaryMetadata = await lstat(temporary);
    assertSecureLedgerFile(temporaryMetadata, 'Submission ledger temporary file');
    assertFileIdentity(temporaryMetadata, identity, 'Submission ledger temporary file');
    await handle.close();
    handle = null;

    // Reject an existing unsafe ledger before replacing it. A later race can
    // only replace the directory entry; rename never follows that entry.
    await inspectLedgerFile(file, snapshot);
    await revalidatePath(snapshot);
    await rename(temporary, file);
    renamed = true;
    await revalidatePath(snapshot);
    await inspectLedgerFile(file, snapshot, { allowMissing: false, expectedIdentity: identity });
  } catch (error) {
    throw ledgerFileError(error, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await cleanupTemporaryFile(temporary, identity);
  }
}

function validateRecord(record) {
  return Boolean(record && typeof record === 'object' && !Array.isArray(record)
    && typeof record.requestId === 'string'
    && typeof record.kind === 'string'
    && typeof record.digest === 'string'
    && /^[0-9a-f]{64}$/i.test(record.digest)
    && ['pending', 'completed', 'failed', 'uncertain'].includes(record.status)
    && (record.agentId === null || typeof record.agentId === 'string')
    && (record.providerAgentId === undefined || record.providerAgentId === null
      || typeof record.providerAgentId === 'string' && record.providerAgentId.length > 0 && record.providerAgentId.length <= 256)
    && (record.providerNotFoundConfirmations === undefined
      || Number.isInteger(record.providerNotFoundConfirmations)
      && record.providerNotFoundConfirmations >= 0
      && record.providerNotFoundConfirmations <= 2)
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

function activeReservation(record) {
  return record?.status === 'pending' || record?.status === 'uncertain';
}

const RECONCILIATION_FIELDS = Object.freeze([
  'reconciliationReason',
  'reconciliationRequired',
  'reconciledAt',
  'releasedAt',
  'staleAt',
  'recoveryReason',
  'failureCode',
  'providerCode',
  'providerNotFoundConfirmations',
]);

const ATTEMPT_FIELDS = Object.freeze(['runId', 'providerRunId']);

function clearAttemptMetadata(record, { clearAttempt = false } = {}) {
  const output = { ...record };
  for (const field of RECONCILIATION_FIELDS) delete output[field];
  if (clearAttempt) for (const field of ATTEMPT_FIELDS) delete output[field];
  return output;
}

function capRecords(records) {
  const terminal = records.filter((record) => !activeReservation(record));
  const keptTerminal = terminal.slice(-MAX_RECORDS);
  const terminalSet = new Set(keptTerminal);
  // Preserve the original order so restart/replay semantics remain stable,
  // while guaranteeing that no pending or uncertain reservation is evicted by
  // terminal history growth.
  return records.filter((record) => activeReservation(record) || terminalSet.has(record));
}

function recordProviderAgentId(record) {
  // Records written before the providerAgentId field was introduced used the
  // local agentId as the provider target. Preserve that legacy reconciliation
  // behavior while making new generated IDs explicitly non-provider IDs.
  // Lifecycle/cancellation reservations historically stored an explicit null
  // providerAgentId even though their exact agent target lived in agentId.
  // A non-null providerAgentId always wins; otherwise the exact stored agent
  // target is the safe fallback. Provider-assigned creates have both fields
  // null and therefore still cannot be guessed during reconciliation.
  return record?.providerAgentId ?? record?.agentId ?? null;
}

function findProviderReservation(records, requestId, providerId) {
  if (providerId === null) return null;
  return [...records.values()].find((record) => (
    record.requestId !== requestId
    && activeReservation(record)
    // New lifecycle/cancellation records intentionally carry an explicit
    // null providerAgentId: their target is exact for reconciliation, but
    // they are not create/follow-up provider-ID reservations that should
    // block an unrelated operation on the same agent. Legacy records without
    // the field retain their historical agentId reservation behavior.
    && (Object.hasOwn(record, 'providerAgentId') ? record.providerAgentId : record.agentId ?? null) !== null
    && (Object.hasOwn(record, 'providerAgentId') ? record.providerAgentId : record.agentId ?? null) === providerId
  )) ?? null;
}

function throwProviderReservationConflict(record) {
  if (!record) return;
  if (record.status === 'uncertain') {
    throw new CursorApiError(
      'uncertain_submission',
      'A prior submission for this provider agent ID has an uncertain transport outcome; reconcile it before retrying.',
      { ambiguous: true },
    );
  }
  throw new CursorApiError('submission_in_progress', 'A submission for this provider agent ID is already in progress.');
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

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function readLockOwnerSnapshot(lockPath) {
  const ownerPath = path.join(lockPath, 'owner.json');
  let metadata;
  try {
    metadata = await lstat(ownerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { owner: null, present: false, identity: null, contents: null };
    throw unavailable(error, ownerPath);
  }
  assertOwnerOnly(metadata, 'Submission ledger lock owner');
  const identity = fileIdentity(metadata);
  let owner;
  let contents;
  try {
    contents = await readFile(ownerPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CursorApiError('ledger_permissions', 'Submission ledger lock owner changed during stale-lock inspection.');
    }
    throw unavailable(error, ownerPath);
  }
  let confirmed;
  try {
    confirmed = await lstat(ownerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CursorApiError('ledger_permissions', 'Submission ledger lock owner changed during stale-lock inspection.');
    }
    throw unavailable(error, ownerPath);
  }
  assertOwnerOnly(confirmed, 'Submission ledger lock owner');
  assertFileIdentity(confirmed, identity, 'Submission ledger lock owner');
  try {
    owner = JSON.parse(contents);
  } catch {
    owner = null;
  }
  return { owner: validLockOwner(owner) ? owner : null, present: true, identity, contents };
}

async function readLockOwner(lockPath) {
  return (await readLockOwnerSnapshot(lockPath)).owner;
}

function lockIsStale(metadata, staleMs, clock) {
  const observedAt = clock();
  return Number.isFinite(observedAt)
    && Number.isFinite(metadata.mtimeMs)
    && observedAt >= metadata.mtimeMs
    && observedAt - metadata.mtimeMs >= staleMs;
}

async function confirmStaleLockIdentity(lockPath, initial, ownerSnapshot, staleMs, clock) {
  let confirmed;
  try {
    confirmed = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw unavailable(error, lockPath);
  }
  assertOwnerOnly(confirmed, 'Submission ledger lock', { directory: true });
  // The lock must remain the same old directory from the first observation
  // through the owner read. A replacement lock (or a fresh mtime) is left for
  // its owner; never remove a path merely because it has the same name.
  if (!sameFileIdentity(initial, confirmed)
    || confirmed.mtimeMs !== initial.mtimeMs
    || !lockIsStale(confirmed, staleMs, clock)) return null;

  const ownerPath = path.join(lockPath, 'owner.json');
  if (ownerSnapshot.present) {
    let currentOwner;
    try {
      currentOwner = await lstat(ownerPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw unavailable(error, ownerPath);
    }
    assertOwnerOnly(currentOwner, 'Submission ledger lock owner');
    if (!sameFileIdentity(ownerSnapshot.identity, currentOwner)) return null;
    // A stable inode is not enough if a writer replaced the contents in place;
    // compare the bounded owner marker before deciding to unlink it.
    let contents;
    try {
      contents = await readFile(ownerPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw unavailable(error, ownerPath);
    }
    if (contents !== ownerSnapshot.contents) return null;
  } else {
    try {
      await lstat(ownerPath);
      return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw unavailable(error, ownerPath);
    }
  }
  return confirmed;
}

async function claimStaleLock(lockPath) {
  const claimPath = path.join(lockPath, '.reclaiming');
  const claim = { pid: process.pid, token: randomUUID(), claimedAt: Date.now() };
  try {
    await writeFile(claimPath, JSON.stringify(claim), { flag: 'wx', mode: 0o600 });
    const metadata = await lstat(claimPath);
    assertOwnerOnly(metadata, 'Submission ledger stale-lock claim');
    return { path: claimPath, identity: fileIdentity(metadata), contents: JSON.stringify(claim) };
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw unavailable(error, claimPath);
  }
}

async function releaseStaleLockClaim(claim) {
  if (!claim) return;
  try {
    const metadata = await lstat(claim.path);
    assertOwnerOnly(metadata, 'Submission ledger stale-lock claim');
    if (!sameFileIdentity(metadata, claim.identity)) return;
    await unlink(claim.path);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Cleanup is best effort. The caller's stale-lock decision remains
      // fail-closed if another process replaced the claim marker.
    }
  }
}

async function removeStaleLock(lockPath, staleMs, clock = Date.now) {
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw unavailable(error, lockPath);
  }
  assertOwnerOnly(metadata, 'Submission ledger lock', { directory: true });
  if (!lockIsStale(metadata, staleMs, clock)) return false;

  const ownerSnapshot = await readLockOwnerSnapshot(lockPath);
  const owner = ownerSnapshot.owner;
  // A valid live owner always wins. An absent or malformed marker is
  // reclaimable only after the age and identity checks below prove this is the
  // same old lock directory and marker we inspected.
  if (owner && processIsAlive(owner.pid)) return false;
  const confirmed = await confirmStaleLockIdentity(lockPath, metadata, ownerSnapshot, staleMs, clock);
  if (!confirmed) return false;

  // Claim the old directory before touching owner.json. A contender cannot
  // create a replacement lock while this directory still exists, and a
  // second reclaimer cannot race us through the fixed claim marker. The
  // claim is removed only immediately before rmdir(lockPath); if a new owner
  // wins that mkdir race, rmdir returns ENOTEMPTY and its marker is untouched.
  const claim = await claimStaleLock(lockPath);
  if (!claim) return false;
  let removedOwner = false;
  const ownerPath = path.join(lockPath, 'owner.json');
  try {
    const claimedLock = await lstat(lockPath);
    assertOwnerOnly(claimedLock, 'Submission ledger lock', { directory: true });
    if (!sameFileIdentity(metadata, claimedLock)) return false;
    if (ownerSnapshot.present) {
      const currentOwner = await lstat(ownerPath);
      assertOwnerOnly(currentOwner, 'Submission ledger lock owner');
      if (!sameFileIdentity(ownerSnapshot.identity, currentOwner)) return false;
      const currentContents = await readFile(ownerPath, 'utf8');
      if (currentContents !== ownerSnapshot.contents) return false;
      await unlink(ownerPath);
      removedOwner = true;
    }
    await releaseStaleLockClaim(claim);
    const beforeRemove = await lstat(lockPath);
    assertOwnerOnly(beforeRemove, 'Submission ledger lock', { directory: true });
    if (!sameFileIdentity(metadata, beforeRemove)) return false;
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return removedOwner;
    if (error?.code === 'ENOTEMPTY') return false;
    throw unavailable(error, lockPath);
  } finally {
    // If the lock was not removed, retain neither our claim nor a partially
    // removed marker. Both cleanup operations are identity checked.
    if (!removedOwner || await lstat(lockPath).then(() => true).catch(() => false)) {
      await releaseStaleLockClaim(claim);
    }
  }
}

async function acquireFileLock(directory, snapshot, {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  retryMs = DEFAULT_LOCK_RETRY_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
  clock = Date.now,
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
      await removeStaleLock(lockPath, staleMs, clock);
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
      ...clearAttemptMetadata(record, { clearAttempt: true }),
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
    const ledgerFile = await inspectLedgerFile(this.file, snapshot, { read: true });
    if (ledgerFile) {
      let parsed;
      try {
        parsed = JSON.parse(ledgerFile.contents);
      } catch {
        throw new CursorApiError('ledger_corrupt', 'Submission ledger is not valid JSON.');
      }
      if (parsed?.version !== LEDGER_VERSION || !Array.isArray(parsed.records) || parsed.records.some((record) => !validateRecord(record))) {
        throw new CursorApiError('ledger_corrupt', 'Submission ledger has an unsupported or invalid record format.');
      }
      const cappedRecords = capRecords(parsed.records);
      // Persist terminal-history trimming during restart as well as on the
      // next mutation. Active pending/uncertain reservations are retained by
      // capRecords, so this write can only remove old terminal history.
      if (cappedRecords.length !== parsed.records.length) recovered = true;
      for (const record of cappedRecords) {
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
    const records = capRecords([...this.records.values()]);
    await writeLedgerFile(this.file, JSON.stringify({ version: LEDGER_VERSION, records }), snapshot);
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
        clock: this.clock,
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

  async begin({
    requestId,
    kind,
    digest,
    agentId = null,
    providerAgentId = agentId,
    runId = undefined,
    reconciliationFingerprint = null,
    reconciliationHints = null,
  }) {
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
          throwProviderReservationConflict(findProviderReservation(this.records, requestId, providerAgentId));
          const timestamp = new Date(this.clock()).toISOString();
          const owner = { pid: process.pid, token: randomUUID(), startedAt: timestamp };
          const record = {
            ...clearAttemptMetadata(existing, { clearAttempt: true }),
            status: 'pending',
            agentId: agentId ?? existing.agentId ?? null,
            providerAgentId: providerAgentId ?? existing.providerAgentId ?? null,
            ...(runId !== undefined ? { runId: runId ?? null } : {}),
            ...(reconciliationFingerprint ? { reconciliationFingerprint } : {}),
            ...(reconciliationHints ? { reconciliationHints } : {}),
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

      // An explicit provider ID is also an idempotency boundary. If a prior
      // request with that ID has an uncertain transport outcome, accepting a
      // different request ID could create a duplicate agent after the first
      // request eventually becomes visible at Cursor. Keep the reservation
      // live until the caller explicitly reconciles it.
      throwProviderReservationConflict(findProviderReservation(this.records, requestId, providerAgentId));

      const timestamp = new Date(this.clock()).toISOString();
      const owner = { pid: process.pid, token: randomUUID(), startedAt: timestamp };
      const record = {
        requestId,
        kind,
        digest,
        status: 'pending',
        agentId,
        providerAgentId: providerAgentId ?? null,
        ...(runId !== undefined ? { runId: runId ?? null } : {}),
        ...(reconciliationFingerprint ? { reconciliationFingerprint } : {}),
        ...(reconciliationHints ? { reconciliationHints } : {}),
        owner,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
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
        ...clearAttemptMetadata(current),
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
      return { duplicate: false, record };
    });
  }

  async fail(requestId, fields = {}) {
    return this.withMutation(async () => {
      const current = this.records.get(requestId);
      if (!current) {
        throw new CursorApiError('ledger_record_missing', 'The durable submission record disappeared before failure could be recorded.');
      }
      const record = {
        ...clearAttemptMetadata(current),
        ...fields,
        status: 'failed',
        reconciliationRequired: false,
        updatedAt: new Date(this.clock()).toISOString(),
      };
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
          ...(fields.providerAgentId !== undefined ? { providerAgentId: fields.providerAgentId } : {}),
          ...(fields.runId ? { runId: fields.runId } : {}),
          ...(Number.isInteger(fields.providerNotFoundConfirmations)
            ? { providerNotFoundConfirmations: fields.providerNotFoundConfirmations }
            : {}),
          ...(fields.reconciliationFingerprint ? { reconciliationFingerprint: fields.reconciliationFingerprint } : {}),
          ...(fields.reconciliationHints ? { reconciliationHints: fields.reconciliationHints } : {}),
          recoveryReason: 'missing_final_record',
          reconciliationRequired: true,
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
      const record = {
        ...clearAttemptMetadata(current),
        ...fields,
        status: 'uncertain',
        reconciliationRequired: true,
        updatedAt: new Date(this.clock()).toISOString(),
      };
      if (record.agentId === undefined) record.agentId = null;
      this.records.set(requestId, record);
      try {
        await this.persistUnlocked();
      } finally {
        this.clearOwner(requestId, current.owner);
      }
    });
  }

  /**
   * Finalize an uncertain reservation after the provider has been checked
   * through an explicit, bounded reconciliation path. This is deliberately
   * narrower than fail(): callers cannot attach arbitrary fields or release a
   * live reservation by accident. The resulting failed record is retryable,
   * while its reconciliation metadata prevents a second reconciliation from
   * being mistaken for a fresh provider observation.
   */
  async reconcile(requestId, { agentId } = {}) {
    return this.withMutation(async () => {
      const current = this.records.get(requestId);
      if (!current) {
        throw new CursorApiError('ledger_record_missing', 'The durable submission record disappeared before reconciliation could be recorded.');
      }
      if (current.status === 'failed' && current.reconciliationReason === 'provider_not_found') {
        return { duplicate: true, record: current };
      }
      if (current.status === 'completed') return { duplicate: true, record: current };
      if (current.status !== 'uncertain') {
        if (current.status === 'pending') {
          throw new CursorApiError('submission_in_progress', 'The submission is still in progress; reconcile it only after transport uncertainty is recorded.');
        }
        throw new CursorApiError('reconciliation_not_required', 'The submission does not require provider-absence reconciliation.');
      }
      const currentProviderAgentId = recordProviderAgentId(current);
      if (currentProviderAgentId === null) {
        throw new CursorApiError('reconciliation_target_missing', 'The uncertain reservation has no stored provider agent ID to reconcile.');
      }
      if (agentId !== undefined && currentProviderAgentId !== null && currentProviderAgentId !== agentId) {
        throw new CursorApiError('reconciliation_target_mismatch', 'The provider agent ID does not match the uncertain reservation.');
      }

      const timestamp = new Date(this.clock()).toISOString();
      const record = {
        ...current,
        agentId: agentId ?? current.agentId ?? null,
        providerAgentId: agentId ?? currentProviderAgentId,
        status: 'failed',
        failureCode: 'provider_not_found',
        reconciliationReason: 'provider_not_found',
        reconciliationRequired: false,
        reconciledAt: timestamp,
        updatedAt: timestamp,
      };
      this.records.set(requestId, record);
      try {
        await this.persistUnlocked();
      } finally {
        this.clearOwner(requestId, current.owner);
      }
      return { duplicate: false, record };
    });
  }

  /**
   * Explicitly release an uncertain reservation after the caller has accepted
   * that provider state could not be proven. This never contacts Cursor and
   * never resubmits the original mutation; the durable receipt remains in the
   * terminal failed history with an explicit operator-release reason.
   */
  async release(requestId, { reason = 'operator_release' } = {}) {
    return this.withMutation(async () => {
      const current = this.records.get(requestId);
      if (!current) {
        throw new CursorApiError('ledger_record_missing', 'The durable submission record disappeared before release could be recorded.');
      }
      if (current.status === 'failed' && current.reconciliationReason === reason) return { duplicate: true, record: current };
      if (current.status === 'completed') return { duplicate: true, record: current };
      if (current.status !== 'uncertain') {
        if (current.status === 'pending') throw new CursorApiError('submission_in_progress', 'The submission is still in progress; release it only after uncertainty is recorded.');
        throw new CursorApiError('reconciliation_not_required', 'The submission does not require uncertainty release.');
      }
      const timestamp = new Date(this.clock()).toISOString();
      const record = {
        ...clearAttemptMetadata(current),
        status: 'failed',
        failureCode: 'uncertain_released',
        reconciliationReason: reason,
        reconciliationRequired: false,
        releasedAt: timestamp,
        updatedAt: timestamp,
      };
      this.records.set(requestId, record);
      try {
        await this.persistUnlocked();
      } finally {
        this.clearOwner(requestId, current.owner);
      }
      return { duplicate: false, record };
    });
  }
}
