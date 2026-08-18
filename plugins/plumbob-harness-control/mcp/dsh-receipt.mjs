import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  stat,
} from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import path from 'node:path';

/**
 * The DSH headless usage runner writes one receipt beside the managed job
 * artifacts.  This reader is intentionally independent of the runner: the
 * receipt is useful only when the job directory and the terminal job record
 * have already crossed the Co-Engineer trust boundary.
 */
export const DSH_RECEIPT_SCHEMA_VERSION = 1;
export const DSH_RECEIPT_SOURCE = 'dsh-headless-live';
export const DSH_RECEIPT_SCOPE = 'task';
export const DSH_RECEIPT_MAX_BYTES = 64 * 1024;
export const DSH_RECEIPT_JOB_ID_PATTERN = /^[a-z0-9-]{8,96}$/;

const OWNER_ONLY_MASK = 0o077;
const MODE_MASK = 0o7777;
const JOBS_DIRECTORY_MODE = 0o700;
const RECEIPT_FILE_MODE = 0o600;
const RECEIPT_FILE_SUFFIX = '.usage.json';
const DSH_KIND = 'deepseek_agent';
const TERMINAL_STATES = new Set([
  'completed', 'succeeded', 'failed', 'cancelled', 'timeout', 'timed_out', 'uncertain',
]);
const TOKEN_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
]);
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 80;

/**
 * Errors deliberately expose only a stable code.  Callers can safely map
 * these to a compact unavailable/error entry without retaining filesystem
 * paths, raw JSON, or provider output.
 */
export class DshReceiptError extends Error {
  constructor(code, message = 'The DSH usage receipt is unavailable.') {
    super(message);
    this.name = 'DshReceiptError';
    this.code = code;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, message) {
  throw new DshReceiptError(code, message);
}

function safeText(value, maximum) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function safeTimestamp(value) {
  const text = safeText(value, MAX_TIMESTAMP_LENGTH);
  return text !== null && Number.isFinite(Date.parse(text)) ? text : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Receipt trust is intentionally limited to the POSIX/Linux primitives used
 * by the managed state boundary. Do not silently drop O_NOFOLLOW or ownership
 * checks on a platform that cannot provide them. The arguments make this
 * guard unit-testable without mutating process/fs globals.
 */
export function secureReceiptPlatformAvailable(options = {}) {
  const constants = Object.hasOwn(options, 'constants') ? options.constants : fsConstants;
  const getuid = Object.hasOwn(options, 'getuid') ? options.getuid : process.getuid;
  const platform = Object.hasOwn(options, 'platform') ? options.platform : process.platform;
  return platform === 'linux'
    && typeof constants?.O_NOFOLLOW === 'number'
    && typeof constants?.O_DIRECTORY === 'number'
    && typeof getuid === 'function';
}

function requireSecureReceiptPlatform() {
  if (!secureReceiptPlatformAvailable()) {
    fail('platform_unsupported', 'The managed DSH receipt reader requires Linux directory descriptors, procfs, owner checks, O_DIRECTORY, and O_NOFOLLOW.');
  }
}

function currentUid() {
  requireSecureReceiptPlatform();
  let uid;
  try {
    uid = process.getuid();
  } catch {
    fail('platform_unsupported', 'The managed DSH receipt reader could not determine the process owner.');
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    fail('platform_unsupported', 'The managed DSH receipt reader could not determine the process owner.');
  }
  return uid;
}

function assertOwnerOnly(metadata, kind) {
  if ((metadata.mode & OWNER_ONLY_MASK) !== 0) {
    fail(`${kind}_permissions`, `The managed DSH ${kind} must be owner-only.`);
  }
  const uid = currentUid();
  if (metadata.uid !== uid) {
    fail(`${kind}_owner`, `The managed DSH ${kind} is not owned by the MCP process user.`);
  }
}

function assertExactReceiptMode(metadata) {
  if ((metadata.mode & MODE_MASK) !== RECEIPT_FILE_MODE) {
    fail('receipt_permissions', 'The managed DSH receipt must have exact mode 0600.');
  }
}

function assertJobsDirectoryMetadata(metadata, expectedIdentity = null) {
  if (!metadata.isDirectory()) {
    fail('jobs_dir_not_directory', 'The managed DSH jobs path must be a directory.');
  }
  assertOwnerOnly(metadata, 'jobs_dir');
  if ((metadata.mode & MODE_MASK) !== JOBS_DIRECTORY_MODE) {
    fail('jobs_dir_permissions', 'The managed DSH jobs directory must have exact mode 0700.');
  }
  const identity = fileIdentity(metadata);
  if (expectedIdentity !== null && !sameIdentity(expectedIdentity, identity)) {
    fail('jobs_dir_replaced', 'The managed DSH jobs directory changed while reading.');
  }
  return identity;
}

function fileIdentity(metadata) {
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}

function absoluteJobsDirectory(jobsDir) {
  if (typeof jobsDir !== 'string' || jobsDir.length === 0 || jobsDir.includes('\0')
    || !path.isAbsolute(jobsDir)) {
    fail('invalid_options', 'An absolute managed DSH jobs directory is required.');
  }
  return path.resolve(jobsDir);
}

/** Validate the same lower-case slug accepted by the control daemon. */
export function validateDshJobId(jobId) {
  if (typeof jobId !== 'string' || !DSH_RECEIPT_JOB_ID_PATTERN.test(jobId)) {
    fail('invalid_job_id', 'The DSH job ID is invalid.');
  }
  return jobId;
}

function terminalState(job) {
  if (!isRecord(job)) return null;
  // Store rows use lifecycle_state as the source of truth and retain status
  // for old clients. Every supplied state must be terminal: a contradictory
  // active field must never be hidden by a terminal confirmation field.
  const states = ['lifecycle_state', 'status', 'terminal_state']
    .filter((field) => Object.hasOwn(job, field) && job[field] !== null && job[field] !== undefined)
    .map((field) => job[field]);
  if (states.length === 0 || states.some((state) => typeof state !== 'string' || !TERMINAL_STATES.has(state))) {
    return null;
  }
  const lifecycle = typeof job.lifecycle_state === 'string' ? job.lifecycle_state : null;
  const status = typeof job.status === 'string' ? job.status : null;
  const terminal = typeof job.terminal_state === 'string' ? job.terminal_state : null;
  return lifecycle ?? status ?? terminal;
}

/**
 * Normalize the only job shape accepted by the secure reader.  An object is
 * required so a caller cannot accidentally read a receipt for an active or
 * non-DSH job merely by knowing its filename.
 */
export function validateTerminalDshJob(job, expectedId = null) {
  if (!isRecord(job)) fail('invalid_job', 'A managed terminal DSH job is required.');
  if (job.kind !== DSH_KIND) fail('wrong_job_kind', 'The selected job is not a managed DSH job.');
  const jobId = validateDshJobId(job.id);
  if (expectedId !== null && jobId !== expectedId) {
    fail('job_identity_mismatch', 'The managed store returned a different DSH job.');
  }
  const state = terminalState(job);
  if (state === null) fail('job_not_terminal', 'The managed DSH job is not terminal.');
  return { id: jobId, kind: DSH_KIND, lifecycle_state: state };
}

function requireJobIdentity(receipt, jobId) {
  if (!Object.hasOwn(receipt, 'jobId')) {
    fail('receipt_identity_missing', 'The DSH usage receipt must identify its managed job.');
  }
  const value = validateDshJobId(receipt.jobId);
  if (value !== jobId) {
    fail('receipt_identity_mismatch', 'The DSH receipt belongs to a different job.');
  }
  // Reject a legacy alias that disagrees with the mandatory canonical field,
  // but never treat the alias as sufficient identity on its own.
  if (Object.hasOwn(receipt, 'job_id')) {
    const alias = validateDshJobId(receipt.job_id);
    if (alias !== value) fail('receipt_identity_mismatch', 'The DSH receipt contains conflicting job identities.');
  }
}

function optionalSessionIdentity(receipt, rootSessionId) {
  for (const field of ['sessionId', 'session_id', 'root_session_id']) {
    if (!Object.hasOwn(receipt, field)) continue;
    const value = safeText(receipt[field], MAX_SESSION_ID_LENGTH);
    if (value === null || value !== rootSessionId) {
      fail('receipt_identity_mismatch', 'The DSH receipt contains a different session identity.');
    }
  }
}

function compactReceipt(receipt, jobId) {
  if (!isRecord(receipt)
    || receipt.schemaVersion !== DSH_RECEIPT_SCHEMA_VERSION
    || receipt.source !== DSH_RECEIPT_SOURCE
    || receipt.scope !== DSH_RECEIPT_SCOPE
    || typeof receipt.aggregationComplete !== 'boolean') {
    fail('invalid_receipt', 'The DSH usage receipt schema is not trusted.');
  }

  requireJobIdentity(receipt, jobId);
  const rootSessionId = safeText(receipt.rootSessionId, MAX_SESSION_ID_LENGTH);
  const observedAt = safeTimestamp(receipt.observedAt);
  if (rootSessionId === null || observedAt === null) {
    fail('invalid_receipt', 'The DSH usage receipt identity or observation time is invalid.');
  }
  optionalSessionIdentity(receipt, rootSessionId);

  const confidence = receipt.confidence;
  if (!['exact', 'observed', 'unknown'].includes(confidence)) {
    fail('invalid_receipt', 'The DSH usage receipt confidence is invalid.');
  }
  const usageSamples = safeCount(receipt.usageSamples);
  if (usageSamples === null) {
    fail('invalid_receipt', 'The DSH usage sample count is invalid.');
  }
  const complete = receipt.aggregationComplete;
  if ((complete && !['exact', 'unknown'].includes(confidence))
    || (!complete && confidence !== 'observed')
    || (confidence === 'exact' && usageSamples === 0)
    || (confidence === 'unknown' && usageSamples !== 0)) {
    fail('invalid_receipt', 'The DSH usage confidence and sample count disagree.');
  }

  if (!isRecord(receipt.counts)) {
    fail('invalid_receipt', 'The DSH token counters are missing.');
  }
  const counts = {};
  let total = 0;
  for (const field of TOKEN_FIELDS) {
    if (!Object.hasOwn(receipt.counts, field)) {
      fail('invalid_receipt', 'The DSH token counters are incomplete.');
    }
    const value = safeCount(receipt.counts[field]);
    if (value === null || value > Number.MAX_SAFE_INTEGER - total) {
      fail('invalid_receipt', 'The DSH token counters are invalid.');
    }
    counts[field] = value;
    total += value;
  }
  const declaredTotal = safeCount(receipt.counts.totalTokens);
  if (declaredTotal === null || declaredTotal !== total) {
    fail('invalid_receipt', 'The DSH total token counter is inconsistent.');
  }
  if (confidence === 'unknown' && total !== 0) {
    fail('invalid_receipt', 'An unknown DSH usage total must be zero.');
  }

  // Return a deliberately small canonical shape.  In particular, provider
  // spend, account balance, rate-limit, prompt, and model fields are never
  // propagated even when a future or tampered receipt contains them.
  return {
    schemaVersion: DSH_RECEIPT_SCHEMA_VERSION,
    source: DSH_RECEIPT_SOURCE,
    scope: DSH_RECEIPT_SCOPE,
    rootSessionId,
    observedAt,
    aggregationComplete: complete,
    confidence,
    usageSamples,
    counts: {
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
      cacheReadTokens: counts.cacheReadTokens,
      cacheWriteTokens: counts.cacheWriteTokens,
      totalTokens: total,
    },
  };
}

async function inspectOriginalJobsDirectory(jobsDir, expectedIdentity = null) {
  requireSecureReceiptPlatform();
  let canonical;
  let metadata;
  try {
    [canonical, metadata] = await Promise.all([realpath(jobsDir), lstat(jobsDir)]);
  } catch (error) {
    fail(error?.code === 'ENOENT' ? 'jobs_dir_missing' : 'jobs_dir_unavailable', 'The managed DSH jobs directory is unavailable.');
  }
  if (canonical !== jobsDir || metadata.isSymbolicLink()) {
    fail(expectedIdentity === null ? 'jobs_dir_symlink' : 'jobs_dir_replaced', 'The managed DSH jobs directory may not be redirected.');
  }
  return assertJobsDirectoryMetadata(metadata, expectedIdentity);
}

async function assertJobsDirectoryAnchor(anchor) {
  let opened;
  let viaProc;
  try {
    [opened, viaProc] = await Promise.all([
      anchor.handle.stat(),
      stat(anchor.path),
    ]);
  } catch {
    fail('platform_unsupported', 'The managed DSH receipt reader requires an accessible Linux procfs descriptor path.');
  }
  assertJobsDirectoryMetadata(opened, anchor.identity);
  assertJobsDirectoryMetadata(viaProc, anchor.identity);
}

async function openJobsDirectoryAnchor(jobsDir) {
  const listedIdentity = await inspectOriginalJobsDirectory(jobsDir);
  let handle;
  try {
    handle = await open(
      jobsDir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    assertJobsDirectoryMetadata(opened, listedIdentity);
    const anchor = {
      handle,
      identity: listedIdentity,
      originalPath: jobsDir,
      path: `/proc/self/fd/${handle.fd}`,
    };
    await assertJobsDirectoryAnchor(anchor);
    await inspectOriginalJobsDirectory(jobsDir, listedIdentity);
    return anchor;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error instanceof DshReceiptError) throw error;
    if (error?.code === 'ELOOP') fail('jobs_dir_symlink', 'The managed DSH jobs directory may not be a symlink.');
    fail('jobs_dir_unavailable', 'The managed DSH jobs directory is unavailable.');
  }
}

async function readReceiptFile(anchor, receiptName) {
  requireSecureReceiptPlatform();
  const receiptPath = path.join(anchor.path, receiptName);
  let listed;
  try {
    listed = await lstat(receiptPath);
  } catch (error) {
    fail(error?.code === 'ENOENT' ? 'receipt_missing' : 'receipt_unavailable', 'The DSH usage receipt is unavailable.');
  }
  if (listed.isSymbolicLink()) fail('receipt_symlink', 'The DSH usage receipt may not be a symlink.');
  if (!listed.isFile()) fail('receipt_not_regular', 'The DSH usage receipt must be a regular file.');
  if (listed.nlink !== 1) fail('receipt_hardlink', 'The DSH usage receipt may not be hard-linked.');
  assertOwnerOnly(listed, 'receipt');
  assertExactReceiptMode(listed);
  if (listed.size > DSH_RECEIPT_MAX_BYTES) fail('receipt_too_large', 'The DSH usage receipt exceeds its size bound.');

  // The receipt path is rooted beneath /proc/self/fd/<jobs-dir-fd>, so parent
  // replacement cannot redirect this lstat/open pair. O_NOFOLLOW protects the
  // final component; fstat re-checks identity, owner, mode, type, and size.
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(receiptPath, flags);
    const opened = await handle.stat();
    if (!opened.isFile()) fail('receipt_not_regular', 'The DSH usage receipt must be a regular file.');
    if (opened.nlink !== 1) fail('receipt_hardlink', 'The DSH usage receipt may not be hard-linked.');
    if (!sameIdentity(fileIdentity(listed), fileIdentity(opened))) {
      fail('receipt_replaced', 'The DSH usage receipt changed while it was being read.');
    }
    assertOwnerOnly(opened, 'receipt');
    assertExactReceiptMode(opened);
    if (opened.size > DSH_RECEIPT_MAX_BYTES) fail('receipt_too_large', 'The DSH usage receipt exceeds its size bound.');
    if (!Number.isSafeInteger(opened.size) || opened.size < 0) {
      fail('receipt_unavailable', 'The DSH usage receipt size is invalid.');
    }
    const expectedSize = opened.size;
    const buffer = Buffer.alloc(expectedSize);
    let bytesRead = 0;
    while (bytesRead < expectedSize) {
      const result = await handle.read(buffer, bytesRead, expectedSize - bytesRead, bytesRead);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0) {
        fail('receipt_truncated', 'The DSH usage receipt changed size while it was being read.');
      }
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== expectedSize) {
      fail('receipt_size_changed', 'The DSH usage receipt size changed while it was being read.');
    }
    const afterRead = await handle.stat();
    if (!afterRead.isFile()
      || afterRead.nlink !== 1
      || !sameIdentity(fileIdentity(listed), fileIdentity(afterRead))
      || afterRead.size !== expectedSize) {
      fail('receipt_changed', 'The DSH usage receipt changed while it was being read.');
    }
    assertOwnerOnly(afterRead, 'receipt');
    assertExactReceiptMode(afterRead);
    const bytes = buffer.subarray(0, bytesRead);
    await assertJobsDirectoryAnchor(anchor);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('receipt_encoding', 'The DSH usage receipt is not valid UTF-8.');
    }
  } catch (error) {
    if (error instanceof DshReceiptError) throw error;
    if (error?.code === 'ELOOP') fail('receipt_symlink', 'The DSH usage receipt may not be a symlink.');
    if (error?.code === 'ENOENT') fail('receipt_missing', 'The DSH usage receipt is unavailable.');
    fail('receipt_unavailable', 'The DSH usage receipt is unavailable.');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readForJob(jobsDir, loadJob, jobId, hooks = {}) {
  const selectedId = validateDshJobId(jobId);
  let job;
  try {
    job = await loadJob(selectedId);
  } catch (error) {
    if (error instanceof DshReceiptError) throw error;
    fail('job_lookup_failed', 'The managed DSH job lookup failed.');
  }
  if (job === null || job === undefined) fail('job_not_found', 'The managed DSH job was not found.');
  const managedJob = validateTerminalDshJob(job, selectedId);
  try {
    const anchor = await openJobsDirectoryAnchor(jobsDir);
    try {
      if (typeof hooks.afterParentOpen === 'function') await hooks.afterParentOpen();
      await assertJobsDirectoryAnchor(anchor);
      const encoded = await readReceiptFile(
        anchor,
        `${managedJob.id}${RECEIPT_FILE_SUFFIX}`,
      );
      await inspectOriginalJobsDirectory(jobsDir, anchor.identity);
      let parsed;
      try {
        parsed = JSON.parse(encoded);
      } catch {
        fail('invalid_json', 'The DSH usage receipt is not valid JSON.');
      }
      return compactReceipt(parsed, managedJob.id);
    } finally {
      await anchor.handle.close().catch(() => {});
    }
  } catch (error) {
    if (error instanceof DshReceiptError) throw error;
    fail('receipt_unavailable', 'The DSH usage receipt is unavailable.');
  }
}

/**
 * Create a reader bound to one administrator-selected jobs directory.  The
 * returned function accepts a managed job ID, loads the exact terminal store
 * row, and reads the exact descriptor-anchored `<job-id>.usage.json` receipt.
 */
function createDshReceiptReaderInternal({ jobsDir, loadJob } = {}, hooks = {}) {
  const directory = absoluteJobsDirectory(jobsDir);
  if (typeof loadJob !== 'function') {
    fail('invalid_options', 'An exact managed DSH job loader is required.');
  }
  requireSecureReceiptPlatform();
  return (jobId) => readForJob(directory, loadJob, jobId, hooks);
}

export function createDshReceiptReader(options = {}) {
  return createDshReceiptReaderInternal(options);
}

/** Convenience form for integrations that do not need a reusable reader. */
export async function readDshReceipt({ jobsDir, loadJob, jobId } = {}) {
  return createDshReceiptReader({ jobsDir, loadJob })(jobId);
}

export const __testing = Object.freeze({
  compactReceipt,
  createDshReceiptReaderWithHooks: createDshReceiptReaderInternal,
  inspectOriginalJobsDirectory,
  openJobsDirectoryAnchor,
  readReceiptFile,
  requireSecureReceiptPlatform,
  terminalState,
});
