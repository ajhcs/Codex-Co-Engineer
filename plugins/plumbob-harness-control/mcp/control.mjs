#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  open,
  readFile,
  rename,
  stat,
  realpath,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findStoredRequest,
  getStoredJob,
  insertJob,
  listActiveStoredJobs,
  listLifecycleEvents,
  listStoredJobs,
  openStore,
  terminalizeJob,
  updateJob,
} from './store.mjs';
import { MODEL_API_KEY_FILE } from './secrets.mjs';
import {
  CONFIG_SCHEMA_VERSION,
  SERVER_IDENTITY,
  TARGET_SCHEMA_VERSION,
  normalizeDigest,
  sha256Digest,
  targetIdentityDigest,
} from './preflight.mjs';
import {
  buildGrokArgs,
  grokBuildFinalResponse,
  grokCapabilityProfile,
  grokVersionProbe,
  normalizeGrokConfiguration,
} from './grok-build.mjs';
import {
  DEFAULT_DSH_PATCH_FILE,
  dshBaseEnvironment,
  dshCapabilityProfile,
  dshChildEnvironment,
  dshReadinessMessage,
  dshVersionProbe,
  inspectDsh,
  normalizeDshOptions,
  resolveDshHome,
} from './dsh.mjs';
import { CapacityError, createCapacityReader } from './capacity.mjs';
import { readGrokCapacity } from './grok-capacity.mjs';
import { createDshReceiptReader } from './dsh-receipt.mjs';
import {
  createExclusiveStateFile,
  inspectStateFile,
  openStateFileRead,
  prepareStateFile,
  prepareStateDirectory,
  removeStateFile,
  resolveStateDirectory,
  revalidateStateDirectory,
  sameStateIdentity,
  stateResolutionMessage,
} from './state.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_HOME = process.env.HOME ?? '';
const WORKSPACE = path.resolve(
  process.env.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE
    ?? process.env.PLUMBOB_HARNESS_WORKSPACE
    ?? path.join(USER_HOME, '.local', 'share', 'codex-co-engineer', 'runtime'),
);
const STATE_RESOLUTION = resolveStateDirectory();
const STATE_DIR = STATE_RESOLUTION.directory;
const JOBS_DIR = STATE_DIR ? path.join(STATE_DIR, 'jobs') : null;
const DATABASE_FILE = STATE_DIR ? path.join(STATE_DIR, 'control.sqlite3') : null;
const DSH = process.env.CODEX_CO_ENGINEER_DSH_COMMAND ?? 'dsh';
const DSH_HOME_CONFIG = resolveDshHome({ env: process.env, stateDirectory: STATE_DIR });
const DSH_HOME = DSH_HOME_CONFIG.path;
const DSH_PATCH_FILE = DSH_HOME_CONFIG.source === 'managed-state'
  ? DEFAULT_DSH_PATCH_FILE
  : null;
const GROK = process.env.CODEX_CO_ENGINEER_GROK_COMMAND ?? 'grok';
const GROK_ENVIRONMENT_NAMES = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
  'XAI_API_KEY',
]);

function grokEnvironment() {
  return Object.fromEntries(
    GROK_ENVIRONMENT_NAMES
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}
const RUNNER = path.join(PLUGIN_ROOT, 'mcp', 'runner.mjs');
const WEB_HOST = '127.0.0.1';
const WEB_PORT = 3180;
const DSH_WEB_LOCK_FILE = 'dsh-web-runtime.lock';
const DSH_WEB_LOCK_SCHEMA = 'codex-co-engineer.dsh-web-lock.v1';
const FINAL_STATES = new Set([
  'completed',
  'succeeded',
  'failed',
  'timeout',
  'timed_out',
  'cancelled',
  'uncertain',
]);
const ACTIVE_STATES = new Set([
  'accepted', 'started', 'working',
  'queued', 'starting', 'running', 'cancelling',
]);
const PLUGIN_VERSION = SERVER_IDENTITY.version;
const WAIT_LIMITS = Object.freeze({
  list_limit: { minimum: 1, maximum: 25, default: 10 },
  tail_lines: { minimum: 0, maximum: 120, default: 40 },
  wait_seconds: { minimum: 1, maximum: 55, default: 30 },
  log_page_bytes: { minimum: 1, maximum: 12000, default: 12000 },
});
const LOG_PAGE_MAX_BYTES = WAIT_LIMITS.log_page_bytes.maximum;
const COMPACT_JOB_TEXT_MAX_LENGTH = 160;
const TARGET_ROLES = new Set(['review', 'implement', 'verify']);
const TARGET_MODES = new Set(['default', 'explicit', 'staged']);
const TARGET_CONTEXT_KEYS = new Set([
  'schema_version',
  'mode',
  'source',
  'working_directory',
  'expected_git_root',
  'expected_head',
  'allowed_paths',
  'role',
]);

const TARGET_SOURCE_TYPES = new Set(['local', 'github']);
const TARGET_SOURCE_KEYS = new Set(['type', 'path', 'repository', 'ref']);
const TARGET_STAGE_ROOT_NAME = 'targets';
const TARGET_STAGE_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const TARGET_STAGE_MAX_LEASES = 8;
const TARGET_STAGE_LOCK_STALE_MS = 2 * 60 * 1000;
const TARGET_STAGE_ACQUIRE_TIMEOUT_MS = 60 * 1000;
const TARGET_STAGE_RECONCILE_LIMIT = 256;
const TARGET_STAGE_GIT_TIMEOUT_MS = 15 * 1000;
const TARGET_STAGE_DEADLINE_MS = 45 * 1000;
const TARGET_STAGE_MAX_BYTES = 256 * 1024 * 1024;
const TARGET_STAGE_MAX_ENTRIES = 100_000;

// Grok's built-in `read-only` profile explicitly permits writes to these
// locations.  The runner can detect a changed checkout after the fact, but
// that is not a prevention boundary. Refuse review/verify targets rooted in a
// provider-writable directory unless the connector created an owner-only,
// isolated staged checkout beneath its identity-bound state directory.
const GROK_READ_ONLY_WRITABLE_ROOTS = Object.freeze([...new Set([
  '/tmp',
  '/var/tmp',
  '/private/tmp',
  '/private/var/tmp',
  os.tmpdir(),
  process.env.TMPDIR,
  USER_HOME ? path.join(USER_HOME, '.grok') : null,
].filter((value) => typeof value === 'string' && value.length > 0)
  .map((value) => path.resolve(value)))]);

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let agentSubmissionTail = Promise.resolve();
let stateHandle;
let jobsHandle;
let databaseStateIdentity;
let databaseJobsIdentity;
let databaseFileIdentity;
let statePreparationTail = Promise.resolve();
let controlProcessStartTime;

const SQLITE_STATE_CHILDREN = Object.freeze([
  'control.sqlite3-wal',
  'control.sqlite3-shm',
]);

async function inspectSqliteStateChildren(expectedDatabaseIdentity = null) {
  const currentDatabaseIdentity = await inspectStateFile(
    stateHandle,
    path.basename(DATABASE_FILE),
    { expectedIdentity: expectedDatabaseIdentity },
  );
  for (const child of SQLITE_STATE_CHILDREN) {
    // SQLite may create and remove WAL sidecars as connections come and go,
    // so bind the durable database identity while requiring every sidecar
    // that is present to remain a single owner-only regular file.
    await inspectStateFile(stateHandle, child, { required: false });
  }
  return currentDatabaseIdentity;
}

async function ensureStateOnce() {
  if (!STATE_DIR || !JOBS_DIR || !DATABASE_FILE) {
    throw new ToolError('state_unavailable', stateResolutionMessage(STATE_RESOLUTION));
  }
  try {
    stateHandle = await prepareStateDirectory(STATE_DIR);
    jobsHandle = await prepareStateDirectory(JOBS_DIR);
    await revalidateStateDirectory(stateHandle);
    await revalidateStateDirectory(jobsHandle);
    const currentStateIdentity = stateHandle.components.at(-1);
    const currentJobsIdentity = jobsHandle.components.at(-1);
    if (database) {
      if (!sameStateIdentity(databaseStateIdentity, currentStateIdentity)
        || !sameStateIdentity(databaseJobsIdentity, currentJobsIdentity)) {
        throw new ToolError(
          'state_identity_changed',
          'The Co-Engineer state or jobs directory changed after the SQLite ledger was opened; refusing to reuse the old ledger.',
        );
      }
      await inspectSqliteStateChildren(databaseFileIdentity);
    } else {
      // DatabaseSync accepts only a path, not an already verified fd. Securely
      // pre-create (or validate) that path with O_EXCL|O_NOFOLLOW first. The
      // enclosing identity-bound 0700 directory is the same-uid trust boundary
      // for the unavoidable interval before DatabaseSync opens the path.
      const preparedDatabaseIdentity = await prepareStateFile(
        stateHandle,
        path.basename(DATABASE_FILE),
      );
      for (const child of SQLITE_STATE_CHILDREN) {
        await inspectStateFile(stateHandle, child, { required: false });
      }
      await revalidateStateDirectory(stateHandle);
      const candidate = openStore(DATABASE_FILE);
      try {
        // The ledger must be opened only while both the state and jobs
        // directory identities still match the prepared handles. Recheck the
        // database and any SQLite WAL/SHM sidecars immediately after open.
        await revalidateStateDirectory(stateHandle);
        await revalidateStateDirectory(jobsHandle);
        const confirmedDatabaseIdentity = await inspectSqliteStateChildren(
          preparedDatabaseIdentity,
        );
        database = candidate;
        databaseStateIdentity = currentStateIdentity;
        databaseJobsIdentity = currentJobsIdentity;
        databaseFileIdentity = confirmedDatabaseIdentity;
      } catch (error) {
        candidate.close();
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      error?.code ?? 'state_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function ensureState() {
  const result = statePreparationTail.then(ensureStateOnce, ensureStateOnce);
  statePreparationTail = result.catch(() => {});
  return result;
}

function processStartTimeFromStat(statText) {
  const closingParenthesis = statText.lastIndexOf(')');
  if (closingParenthesis < 0) return null;
  return statText.slice(closingParenthesis + 2).trim().split(/\s+/u)[19] ?? null;
}

async function currentControlProcessStartTime() {
  if (controlProcessStartTime !== undefined) return controlProcessStartTime;
  try {
    controlProcessStartTime = processStartTimeFromStat(
      await readFile(`/proc/${process.pid}/stat`, 'utf8'),
    );
  } catch {
    controlProcessStartTime = null;
  }
  return controlProcessStartTime;
}

async function processIdentityAlive(record) {
  if (!Number.isInteger(record?.pid) || record.pid < 2) return false;
  try {
    process.kill(record.pid, 0);
    if (typeof record.start_time !== 'string' || !record.start_time) return true;
    const observed = processStartTimeFromStat(
      await readFile(`/proc/${record.pid}/stat`, 'utf8'),
    );
    return observed !== null && observed === record.start_time;
  } catch {
    return false;
  }
}

function runtimeLockError(message) {
  return new ToolError('runtime_lock_unverifiable', message);
}

async function readWebRuntimeLock() {
  await ensureState();
  const name = DSH_WEB_LOCK_FILE;
  const identity = await inspectStateFile(stateHandle, name, { required: false });
  if (!identity) return null;
  let record;
  try {
    const opened = await openStateFileRead(stateHandle, name, { expectedIdentity: identity });
    try {
      record = JSON.parse(await opened.file.readFile('utf8'));
    } finally {
      await opened.file.close();
    }
    await inspectStateFile(stateHandle, name, { expectedIdentity: identity });
  } catch {
    throw runtimeLockError('The DSH web runtime lock could not be identity-verified; refusing to start another listener.');
  }
  if (record?.schema_version !== DSH_WEB_LOCK_SCHEMA
    || !['starting', 'active'].includes(record.state)
    || !Number.isInteger(record.pid)
    || record.pid < 2
    || typeof record.start_time !== 'string'
    || !record.start_time
    || (record.state === 'active'
      && (typeof record.job_id !== 'string' || !/^[a-z0-9-]{8,96}$/u.test(record.job_id)))) {
    throw runtimeLockError('The DSH web runtime lock has an invalid ownership record; refusing replacement.');
  }
  return { identity, record };
}

async function releaseWebRuntimeLock(lock) {
  if (!lock) return;
  await lock.file?.close().catch(() => {});
  try {
    await removeStateFile(
      stateHandle,
      DSH_WEB_LOCK_FILE,
      { expectedIdentity: lock.identity },
    );
  } catch (error) {
    // A different owner may have reclaimed the exact lock after this holder
    // lost its path. Never remove or overwrite that replacement.
    if (error?.code !== 'state_identity_changed' && error?.code !== 'state_child_missing') throw error;
  }
}

async function writeWebRuntimeLock(lock, record) {
  const payload = `${JSON.stringify(record)}\n`;
  await lock.file.truncate(0);
  await lock.file.write(payload, 0, 'utf8');
  await lock.file.sync();
  await inspectStateFile(stateHandle, DSH_WEB_LOCK_FILE, { expectedIdentity: lock.identity });
  lock.record = record;
}

async function acquireWebRuntimeLock() {
  await ensureState();
  const owner = {
    schema_version: DSH_WEB_LOCK_SCHEMA,
    state: 'starting',
    pid: process.pid,
    start_time: await currentControlProcessStartTime(),
    created_at: new Date().toISOString(),
  };
  if (!owner.start_time) throw runtimeLockError('The DSH web runtime owner process could not be identity-verified.');

  while (true) {
    const existing = await readWebRuntimeLock();
    if (existing) {
      const active = await activeWebJob();
      const ownerAlive = await processIdentityAlive(existing.record);
      if (active) {
        throw new ToolError(
          'workspace_busy',
          `A managed DSH web runtime is already active: ${active.id}`,
        );
      }
      if (existing.record.state === 'starting' && ownerAlive) {
        throw new ToolError(
          'workspace_busy',
          'Another Co-Engineer process is starting the DSH web runtime; retry after startup completes.',
        );
      }
      // An active lock with no active job is a completed or failed startup.
      // Reclaim only this exact inode; a concurrent replacement is left
      // untouched and the next loop observes its owner.
      await removeStateFile(
        stateHandle,
        DSH_WEB_LOCK_FILE,
        { expectedIdentity: existing.identity },
      );
      continue;
    }

    const created = await createExclusiveStateFile(stateHandle, DSH_WEB_LOCK_FILE);
    if (!created.created) continue;
    try {
      await created.file.write(`${JSON.stringify(owner)}\n`, 0, 'utf8');
      await created.file.sync();
      await inspectStateFile(stateHandle, DSH_WEB_LOCK_FILE, { expectedIdentity: created.identity });
      return { file: created.file, identity: created.identity, record: owner };
    } catch (error) {
      await created.file.close().catch(() => {});
      await removeStateFile(
        stateHandle,
        DSH_WEB_LOCK_FILE,
        { expectedIdentity: created.identity },
      ).catch(() => {});
      throw error;
    }
  }
}

async function promoteWebRuntimeLock(lock, jobId) {
  if (!lock) return;
  await writeWebRuntimeLock(lock, {
    ...lock.record,
    state: 'active',
    job_id: jobId,
    activated_at: new Date().toISOString(),
  });
}

let database;

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeSpec(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function validateJobId(id) {
  if (!/^[a-z0-9-]{8,96}$/.test(id ?? '')) {
    throw new ToolError('invalid_job_id', 'The job ID is invalid.');
  }
  return id;
}

function clampInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolError('invalid_argument', `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function storedJson(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function storedBoolean(value) {
  if (value === undefined || value === null) return null;
  return Boolean(Number(value));
}

function publicJobKind(kind) {
  return kind === 'dsh_agent' ? 'deepseek_agent' : kind;
}

function isAgentJobKind(kind) {
  return kind === 'deepseek_agent' || kind === 'dsh_agent'
    || kind === 'grok_build' || kind === 'dsh_web';
}

function jobExecutionScope(job) {
  const effectiveConfiguration = storedJson(job.effective_configuration);
  const target = storedJson(job.target_context);
  return {
    working_directory: path.resolve(
      effectiveConfiguration?.working_directory
        ?? target?.working_directory
        ?? WORKSPACE,
    ),
    expected_git_root: target?.expected_git_root ?? null,
    git_common_directory: target?.git_common_directory ?? null,
  };
}

function scopeDescriptor(value) {
  if (typeof value === 'string') {
    return {
      working_directory: path.resolve(value),
      expected_git_root: null,
      git_common_directory: null,
    };
  }
  return {
    working_directory: path.resolve(value?.working_directory ?? WORKSPACE),
    expected_git_root: value?.expected_git_root ? path.resolve(value.expected_git_root) : null,
    git_common_directory: value?.git_common_directory
      ? path.resolve(value.git_common_directory)
      : null,
  };
}

function executionScopesOverlap(left, right) {
  const leftScope = scopeDescriptor(left);
  const rightScope = scopeDescriptor(right);
  if (leftScope.git_common_directory && rightScope.git_common_directory
    && leftScope.git_common_directory === rightScope.git_common_directory) {
    return true;
  }
  const leftPaths = [leftScope.expected_git_root, leftScope.working_directory].filter(Boolean);
  const rightPaths = [rightScope.expected_git_root, rightScope.working_directory].filter(Boolean);
  return leftPaths.some((leftPath) => rightPaths.some((rightPath) =>
    isPathWithin(leftPath, rightPath) || isPathWithin(rightPath, leftPath)));
}

async function listActiveJobs() {
  await ensureState();
  const jobs = [];
  for (const job of listActiveStoredJobs(database)) {
    const reconciled = await reconcile(job);
    if (ACTIVE_STATES.has(reconciled.lifecycle_state ?? reconciled.status)) jobs.push(reconciled);
  }
  return jobs;
}

async function startAgentJob(scope, starter, { ignoreJobIds = [] } = {}) {
  const ignored = new Set(ignoreJobIds);
  let release;
  const previous = agentSubmissionTail;
  agentSubmissionTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const active = (await listActiveJobs()).find((job) => isAgentJobKind(job.kind)
      && !ignored.has(job.id)
      && ACTIVE_STATES.has(job.status)
      && executionScopesOverlap(jobExecutionScope(job), scope));
    if (active) {
      throw new ToolError('workspace_busy', `An agent already has write access to this execution scope: ${active.id}`);
    }
    return await starter();
  } finally {
    release();
  }
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertGrokReadOnlyTarget(target) {
  if (!target || !['review', 'verify'].includes(target.role)) return;
  const candidate = path.resolve(target.working_directory ?? target.resolved_cwd ?? '');
  const writableRoot = GROK_READ_ONLY_WRITABLE_ROOTS.find((root) => isPathWithin(root, candidate));
  if (writableRoot) {
    throw new ToolError(
      'grok_read_only_target_unverifiable',
      `Grok ${target.role} targets cannot be rooted in ${writableRoot}: the built-in read-only profile permits provider writes there. Use a target-specific custom profile with fail-closed startup or a non-writable target root.`,
    );
  }
}

function configuredTargetRoots() {
  const configured = process.env.CODEX_CO_ENGINEER_ALLOWED_ROOTS
    ?? process.env.PLUMBOB_HARNESS_ALLOWED_ROOTS;
  if (!configured?.trim()) return null;
  const roots = configured.split(path.delimiter).filter(Boolean);
  return roots.length > 0
    ? [...new Set(roots.map((root) => path.resolve(root)))]
    : null;
}

function normalizeTargetPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new ToolError('invalid_target_context', `${label} must be an absolute path without NUL bytes.`);
  }
  return value;
}

function normalizeAllowedPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240
    || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new ToolError('invalid_target_context', 'allowed_paths must contain short, relative paths.');
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new ToolError('invalid_target_context', 'allowed_paths cannot escape the expected Git root.');
  }
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '');
}

async function gitCommonDirectory(gitRoot) {
  const result = spawnSync('git', ['-C', gitRoot, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.status !== 0 || !result.stdout?.trim()) return gitRoot;
  const candidate = path.resolve(gitRoot, result.stdout.trim());
  return realpath(candidate).catch(() => gitRoot);
}

function gitOutput(cwd, args, label) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new ToolError('invalid_target_context', `${label} is not a Git checkout.`);
  }
  return result.stdout.trim();
}

async function targetGitMetadata(cwd) {
  const rootCandidate = gitOutput(cwd, ['rev-parse', '--show-toplevel'], 'working_directory');
  const resolvedRoot = await realpath(rootCandidate).catch(() => {
    throw new ToolError('invalid_target_context', 'The Git root does not resolve to an existing directory.');
  });
  const head = gitOutput(cwd, ['rev-parse', 'HEAD'], 'working_directory');
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    throw new ToolError('invalid_target_context', 'Git HEAD is not a full 40-character revision.');
  }
  return {
    root: resolvedRoot,
    head: head.toLowerCase(),
    common: await gitCommonDirectory(resolvedRoot),
  };
}

function sourceRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 240
    || value.includes('\0') || /\s/.test(value) || value.startsWith('-')) {
    throw new ToolError(
      'invalid_target_source',
      'target_context.source.ref must be a non-empty Git ref without whitespace, NUL bytes, or a leading dash.',
    );
  }
  return value;
}

function githubRepository(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || value.includes('\0')) {
    throw new ToolError(
      'invalid_target_source',
      'target_context.source.repository must be a GitHub HTTPS URL.',
    );
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new ToolError('invalid_target_source', 'target_context.source.repository must be a GitHub HTTPS URL.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:'
    || !['github.com', 'www.github.com'].includes(hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/[^/]+\/[^/]+(?:\.git)?\/?$/.test(parsed.pathname)) {
    throw new ToolError(
      'invalid_target_source',
      'target_context.source.repository must be an https://github.com/OWNER/REPOSITORY URL without credentials, query, or fragment data.',
    );
  }
  return `https://github.com/${parsed.pathname.slice(1).replace(/\/$/, '')}`;
}

function stageGitEnvironment() {
  return {
    ...process.env,
    // Staging must never wait for an interactive credential prompt. Existing
    // user/session credentials may still be used by Git's configured helper.
    GIT_TERMINAL_PROMPT: '0',
  };
}

function stageDeadlineError() {
  return new ToolError('target_stage_timeout', 'Target staging exceeded its bounded preparation deadline.');
}

function assertStageDeadlineAt(deadlineAt) {
  if (!Number.isFinite(deadlineAt)) return TARGET_STAGE_GIT_TIMEOUT_MS;
  if (Date.now() >= deadlineAt) throw stageDeadlineError();
  return Math.max(1, Math.ceil(deadlineAt - Date.now()));
}

function stageProcessGroupExists(pid) {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function signalStageProcessGroup(pid, signal) {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function waitStageChild(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, Math.max(1, timeoutMs));
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', done);
    child.once('exit', done);
  });
}

async function terminateStageProcess(child) {
  if (!child) return;
  if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    signalStageProcessGroup(child.pid, 'SIGTERM');
    if (await waitStageChild(child, 250) && !stageProcessGroupExists(child.pid)) return;
    signalStageProcessGroup(child.pid, 'SIGKILL');
    await waitStageChild(child, 250);
    return;
  }
  try { child.kill?.('SIGTERM'); } catch { /* bounded fallback */ }
  if (await waitStageChild(child, 250)) return;
  try { child.kill?.('SIGKILL'); } catch { /* bounded fallback */ }
  await waitStageChild(child, 250);
}

async function runStageGit(args, label, deadlineAt) {
  const timeoutMs = Math.min(TARGET_STAGE_GIT_TIMEOUT_MS, assertStageDeadlineAt(deadlineAt));
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    const finish = (error, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const failAndTerminate = async (error) => {
      if (settled) return;
      await terminateStageProcess(child);
      finish(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void failAndTerminate(stageDeadlineError());
    }, timeoutMs);
    try {
      child = spawn('git', args, {
        env: stageGitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      finish(new ToolError('target_stage_failed', `${label} could not be started: ${error?.message ?? 'spawn failed'}`));
      return;
    }
    const collect = (target, chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += buffer.length;
      if (outputBytes > 1024 * 1024) {
        void failAndTerminate(new ToolError('target_stage_failed', `${label} exceeded the bounded output limit.`));
        return;
      }
      target.push(buffer);
    };
    child.stdout?.on('data', (chunk) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', (error) => {
      void failAndTerminate(new ToolError('target_stage_failed', `${label} failed: ${error?.message ?? 'process error'}`));
    });
    child.once('close', (status, signal) => {
      if (settled) return;
      if (timedOut || Date.now() >= deadlineAt) {
        void failAndTerminate(stageDeadlineError());
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (status !== 0) {
        const detail = concise(stderrText || stdoutText || `git exited with ${signal ?? status}`, 360);
        finish(new ToolError('target_stage_failed', `${label} failed${detail ? `: ${detail}` : '.'}`));
        return;
      }
      finish(null, stdoutText.trim());
    });
  });
}

async function optionalStageGit(args, deadlineAt) {
  try {
    return { ok: true, output: await runStageGit(args, 'Git ref query', deadlineAt), error: '' };
  } catch (error) {
    if (error?.code === 'target_stage_timeout') throw error;
    return { ok: false, output: '', error: error?.message ?? 'git failed' };
  }
}

async function assertStageSize(directory, deadlineAt) {
  const pending = [directory];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    assertStageDeadlineAt(deadlineAt);
    const current = pending.pop();
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      assertStageDeadlineAt(deadlineAt);
      entries += 1;
      if (entries > TARGET_STAGE_MAX_ENTRIES) {
        throw new ToolError('target_stage_too_large', 'The staged checkout exceeds the bounded entry limit.');
      }
      const childPath = path.join(current, child.name);
      const metadata = await lstat(childPath);
      assertStageDeadlineAt(deadlineAt);
      if (metadata.isSymbolicLink()) {
        throw new ToolError('target_stage_failed', `The staged checkout contains a symbolic link: ${childPath}`);
      }
      if (metadata.isDirectory()) pending.push(childPath);
      else bytes += metadata.size;
      if (bytes > TARGET_STAGE_MAX_BYTES) {
        throw new ToolError('target_stage_too_large', 'The staged checkout exceeds the bounded byte limit.');
      }
    }
  }
}

async function sourceGitRoot(sourcePath, deadlineAt) {
  const metadata = await stageTargetGitMetadata(sourcePath, deadlineAt);
  const status = await runStageGit([
    '-C', metadata.root,
    'status', '--porcelain=v1', '--untracked-files=all', '--ignored=no',
  ], 'local source status', deadlineAt);
  if (status) {
    throw new ToolError(
      'target_source_dirty',
      'The local source checkout has uncommitted or untracked files; commit the review state or use a clean GitHub ref before staging.',
    );
  }
  const roots = configuredTargetRoots();
  if (roots && !roots.some((root) => isPathWithin(root, metadata.root))) {
    throw new ToolError('target_outside_allowlist', 'The local source Git root is outside the administrator-configured target roots.');
  }
  return metadata;
}

function fullCommit(value, label) {
  const commit = String(value ?? '').trim().split(/\s+/, 1)[0];
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new ToolError('target_stage_failed', `${label} did not resolve to a full Git commit.`);
  }
  return commit.toLowerCase();
}

async function stageGitCommonDirectory(gitRoot, deadlineAt) {
  const result = await optionalStageGit([
    '-C', gitRoot,
    'rev-parse', '--git-common-dir',
  ], deadlineAt);
  if (!result.ok || !result.output) return gitRoot;
  const candidate = path.resolve(gitRoot, result.output);
  return realpath(candidate).catch(() => gitRoot);
}

async function stageTargetGitMetadata(cwd, deadlineAt) {
  const rootCandidate = await runStageGit(
    ['-C', cwd, 'rev-parse', '--show-toplevel'],
    'working_directory inspection',
    deadlineAt,
  );
  const resolvedRoot = await realpath(rootCandidate).catch(() => {
    throw new ToolError('invalid_target_context', 'The Git root does not resolve to an existing directory.');
  });
  const head = await runStageGit(
    ['-C', cwd, 'rev-parse', 'HEAD'],
    'working_directory inspection',
    deadlineAt,
  );
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    throw new ToolError('invalid_target_context', 'Git HEAD is not a full 40-character revision.');
  }
  return {
    root: resolvedRoot,
    head: head.toLowerCase(),
    common: await stageGitCommonDirectory(resolvedRoot, deadlineAt),
  };
}

async function refCandidates(root, ref, deadlineAt) {
  if (!ref) return [];
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const verified = await optionalStageGit(['-C', root, 'cat-file', '-e', `${ref}^{commit}`], deadlineAt);
    if (!verified.ok) throw new ToolError('target_stage_ref_not_found', `Local source ref ${ref} was not found.`);
    return [{ ref, commit: ref.toLowerCase(), direct: true }];
  }
  const normalized = ref.startsWith('refs/') ? ref : null;
  const names = normalized
    ? [normalized]
    : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/remotes/origin/${ref}`];
  const result = await optionalStageGit([
    '-C', root,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    ...names.map((name) => name),
  ], deadlineAt);
  if (!result.ok) {
    throw new ToolError('target_stage_ref_not_found', `Local source ref ${ref} could not be resolved.`);
  }
  const output = result.output;
  return output.split(/\r?\n/)
    .map((line) => {
      const [refName, objectName] = line.trim().split(/\s+/, 2);
      return refName && objectName ? { ref: refName, object: objectName } : null;
    })
    .filter(Boolean);
}

async function resolveLocalRef(root, ref, fallbackHead, deadlineAt) {
  if (!ref) return { commit: fallbackHead, ref: null };
  const candidates = await refCandidates(root, ref, deadlineAt);
  if (candidates.length === 0) {
    throw new ToolError('target_stage_ref_not_found', `Local source ref ${ref} was not found.`);
  }
  const resolved = [];
  for (const candidate of candidates) {
    resolved.push({
      ...candidate,
      commit: candidate.direct
        ? candidate.commit
        : fullCommit(await runStageGit([
          '-C', root,
          'rev-parse', '--verify', `${candidate.ref}^{commit}`,
        ], 'local source ref resolution', deadlineAt), 'local source ref'),
    });
  }
  const distinctCommits = new Set(resolved.map((candidate) => candidate.commit));
  if (resolved.length !== 1 || distinctCommits.size !== 1) {
    throw new ToolError(
      'target_stage_ref_ambiguous',
      `Local source ref ${ref} is ambiguous; use an exact refs/heads/* or refs/tags/* name.`,
    );
  }
  return { commit: resolved[0].commit, ref: resolved[0].ref };
}

function parseRemoteRefs(output) {
  return output.split(/\r?\n/).map((line) => {
    const [object, ref] = line.trim().split(/\s+/, 2);
    return object && ref && /^[0-9a-f]{40}$/i.test(object) ? { object: object.toLowerCase(), ref } : null;
  }).filter(Boolean);
}

async function resolveGithubRef(repository, ref, deadlineAt) {
  if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
    return { commit: ref.toLowerCase(), ref: ref.toLowerCase() };
  }
  const names = ref?.startsWith('refs/')
    ? [ref]
    : ref
      ? [`refs/heads/${ref}`, `refs/tags/${ref}`]
      : ['HEAD'];
  const matches = [];
  for (const name of names) {
    const query = name.startsWith('refs/tags/')
      ? [name, `${name}^{}`]
      : [name];
    const remoteResult = await optionalStageGit(['ls-remote', repository, ...query], deadlineAt);
    if (!remoteResult.ok) {
      throw new ToolError('target_stage_failed', 'GitHub source ref resolution failed.');
    }
    const remote = parseRemoteRefs(remoteResult.output);
    const exact = remote.filter((candidate) => candidate.ref === name);
    const peeled = remote.filter((candidate) => candidate.ref === `${name}^{}`);
    if (exact.length > 1 || peeled.length > 1) {
      throw new ToolError(
        'target_stage_ref_ambiguous',
        `GitHub source ref ${ref ?? 'HEAD'} returned multiple exact or peeled objects.`,
      );
    }
    if (exact.length !== 1) continue;
    // Annotated tags must bind to the peeled commit advertised by the
    // remote. Lightweight tags and branches have no ^{} row and retain the
    // exact object they advertise.
    matches.push({ ref: name, commit: peeled[0]?.object ?? exact[0].object });
  }
  if (matches.length === 0) throw new ToolError('target_stage_ref_not_found', `GitHub source ref ${ref ?? 'HEAD'} was not found.`);
  const distinctCommits = new Set(matches.map((candidate) => candidate.commit));
  if (matches.length !== 1 || distinctCommits.size !== 1) {
    throw new ToolError(
      'target_stage_ref_ambiguous',
      `GitHub source ref ${ref} is ambiguous; use an exact refs/heads/* or refs/tags/* name.`,
    );
  }
  return matches[0];
}

function leaseDescriptor(source, repository, ref, resolvedHead) {
  return {
    type: source.type,
    repository,
    ref: ref ?? 'HEAD',
    resolved_head: resolvedHead,
  };
}

function sameFsIdentity(left, right) {
  return Boolean(left && right)
    && String(left.dev ?? left.device) === String(right.dev ?? right.device)
    && String(left.ino ?? left.inode) === String(right.ino ?? right.inode);
}

async function leaseDirectoryIdentity(directory, label = 'target staging lease') {
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ToolError('target_stage_failed', `${label} is not a private directory: ${directory}`);
  }
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

async function readLeaseChild(leaseDirectory, name, expectedDirectoryIdentity) {
  const leaseHandle = await prepareStateDirectory(leaseDirectory);
  if (!sameFsIdentity(leaseHandle.components.at(-1), expectedDirectoryIdentity)) {
    throw new ToolError('target_stage_identity_changed', `Target staging lease changed while reading ${name}.`);
  }
  const identity = await inspectStateFile(leaseHandle, name, { required: false });
  if (!identity) return null;
  const opened = await openStateFileRead(leaseHandle, name, { expectedIdentity: identity });
  try {
    return { value: JSON.parse(await opened.file.readFile('utf8')), identity };
  } catch {
    return null;
  } finally {
    await opened.file.close();
  }
}

async function writeLease(leaseFile, value, { expectedDirectoryIdentity = null } = {}) {
  const leaseDirectory = path.dirname(leaseFile);
  const before = await leaseDirectoryIdentity(leaseDirectory);
  if (expectedDirectoryIdentity && !sameFsIdentity(before, expectedDirectoryIdentity)) {
    throw new ToolError('target_stage_identity_changed', 'Target staging lease changed before metadata publication.');
  }
  const temporary = `${leaseFile}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    const beforeRename = await leaseDirectoryIdentity(leaseDirectory);
    if (!sameFsIdentity(before, beforeRename)
      || (expectedDirectoryIdentity && !sameFsIdentity(beforeRename, expectedDirectoryIdentity))) {
      throw new ToolError('target_stage_identity_changed', 'Target staging lease changed before metadata publication.');
    }
    await rename(temporary, leaseFile);
    const after = await leaseDirectoryIdentity(leaseDirectory);
    if (!sameFsIdentity(before, after)
      || (expectedDirectoryIdentity && !sameFsIdentity(after, expectedDirectoryIdentity))) {
      throw new ToolError('target_stage_identity_changed', 'Target staging lease changed during metadata publication.');
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeLeaseOwner(leaseDirectory, expectedDirectoryIdentity) {
  const leaseHandle = await prepareStateDirectory(leaseDirectory);
  if (!sameFsIdentity(leaseHandle.components.at(-1), expectedDirectoryIdentity)) {
    throw new ToolError('target_stage_identity_changed', 'Target staging lease changed before ownership publication.');
  }
  const owner = await createExclusiveStateFile(leaseHandle, 'owner.json');
  if (!owner.created) {
    await owner.file?.close().catch(() => {});
    throw new ToolError('target_stage_busy', 'Another control-plane operation owns this target staging lease.');
  }
  const record = {
    schema_version: 'codex-co-engineer.target-lease-owner.v1',
    pid: process.pid,
    start_time: await currentControlProcessStartTime(),
    created_at: new Date().toISOString(),
  };
  if (!record.start_time) {
    await owner.file.close().catch(() => {});
    await removeStateFile(leaseHandle, 'owner.json', { expectedIdentity: owner.identity }).catch(() => {});
    throw new ToolError('target_stage_failed', 'Target staging owner process could not be identity-verified.');
  }
  try {
    await owner.file.write(`${JSON.stringify(record)}\n`, 0, 'utf8');
    await owner.file.sync();
    await inspectStateFile(leaseHandle, 'owner.json', { expectedIdentity: owner.identity });
  } finally {
    await owner.file.close();
  }
  return { record, identity: owner.identity };
}

async function removeLeaseChild(leaseDirectory, name, expectedDirectoryIdentity) {
  const leaseHandle = await prepareStateDirectory(leaseDirectory);
  if (!sameFsIdentity(leaseHandle.components.at(-1), expectedDirectoryIdentity)) return false;
  const identity = await inspectStateFile(leaseHandle, name, { required: false });
  if (!identity) return false;
  await removeStateFile(leaseHandle, name, { expectedIdentity: identity });
  return true;
}

async function removeLeaseDirectory(stageRoot, directory, expectedIdentity) {
  await revalidateStateDirectory(stageRoot);
  const observed = await lstat(directory).catch(() => null);
  if (!observed || !observed.isDirectory() || observed.isSymbolicLink()
    || !sameFsIdentity(observed, expectedIdentity)) return false;
  // Revalidate both the parent and the exact lease inode immediately before
  // removal. A slow clone can outlive a stale-lock check; if another owner
  // replaced this path, its inode is left untouched.
  await revalidateStateDirectory(stageRoot);
  const confirmed = await lstat(directory).catch(() => null);
  if (!confirmed || !sameFsIdentity(confirmed, expectedIdentity)) return false;
  await rm(directory, { recursive: true, force: true });
  const remaining = await lstat(directory).catch(() => null);
  if (remaining && sameFsIdentity(remaining, expectedIdentity)) return false;
  return true;
}

async function targetLeaseOwner(leaseDirectory, expectedDirectoryIdentity) {
  const owner = await readLeaseChild(leaseDirectory, 'owner.json', expectedDirectoryIdentity).catch(() => null);
  if (!owner?.value) return { record: null, alive: false };
  const record = owner.value;
  const valid = record.schema_version === 'codex-co-engineer.target-lease-owner.v1'
    && Number.isInteger(record.pid)
    && record.pid >= 2
    && typeof record.start_time === 'string'
    && record.start_time.length > 0;
  return { record: valid ? record : null, alive: valid && await processIdentityAlive(record) };
}

async function activeStageCheckouts(deadlineAt) {
  if (!database) return new Map();
  const active = new Map();
  // Pruning must not trust a dead runner's stale active row. Reconcile a
  // bounded number of oldest rows before deciding which staged checkout is
  // protected by a live job.
  for (const stored of listActiveStoredJobs(database, TARGET_STAGE_RECONCILE_LIMIT)) {
    assertStageDeadlineAt(deadlineAt);
    const job = await reconcile(stored);
    assertStageDeadlineAt(deadlineAt);
    if (!ACTIVE_STATES.has(job.lifecycle_state ?? job.status)) continue;
    const target = storedJson(job.target_context);
    if (target?.target_origin === 'control_plane_staged' && target.working_directory) {
      active.set(path.resolve(target.working_directory), target.workspace_identity ?? null);
    }
  }
  return active;
}

async function pruneTargetLeases(stageRoot, deadlineAt) {
  assertStageDeadlineAt(deadlineAt);
  await revalidateStateDirectory(stageRoot);
  const active = await activeStageCheckouts(deadlineAt);
  const entries = await readdir(stageRoot.directory, { withFileTypes: true }).catch(() => []);
  const leases = [];
  for (const entry of entries) {
    assertStageDeadlineAt(deadlineAt);
    if (!entry.isDirectory() || !entry.name.startsWith('lease-')) continue;
    const directory = path.join(stageRoot.directory, entry.name);
    const checkout = path.join(directory, 'checkout');
    const observed = await lstat(directory).catch(() => null);
    if (!observed || observed.isSymbolicLink() || !observed.isDirectory()) continue;
    const directoryIdentity = { dev: String(observed.dev), ino: String(observed.ino) };
    const leaseChild = await readLeaseChild(directory, 'lease.json', directoryIdentity).catch(() => null);
    const lease = leaseChild?.value ?? null;
    const owner = await targetLeaseOwner(directory, directoryIdentity);
    const expectedActiveIdentity = active.get(path.resolve(checkout));
    const checkoutObserved = await lstat(checkout).catch(() => null);
    const checkoutIdentity = checkoutObserved && !checkoutObserved.isSymbolicLink()
      ? { dev: String(checkoutObserved.dev), ino: String(checkoutObserved.ino) }
      : null;
    const lastUsed = Date.parse(lease?.last_used_at ?? '') || observed?.mtimeMs || 0;
    const activeIdentityMatches = expectedActiveIdentity
      && checkoutIdentity
      && sameFsIdentity(expectedActiveIdentity, checkoutIdentity);
    leases.push({
      directory,
      checkout,
      directoryIdentity,
      lastUsed,
      active: Boolean(activeIdentityMatches),
      ownerAlive: owner.alive,
      valid: Boolean(lease),
    });
  }
  const now = Date.now();
  const expired = leases
    .filter((lease) => !lease.active && !lease.ownerAlive && (lease.valid
      ? now - lease.lastUsed > TARGET_STAGE_LEASE_TTL_MS
      : now - lease.lastUsed > TARGET_STAGE_LOCK_STALE_MS))
    .sort((left, right) => left.lastUsed - right.lastUsed);
  for (const lease of expired) await removeLeaseDirectory(
    stageRoot,
    lease.directory,
    lease.directoryIdentity,
  ).catch(() => {});
  assertStageDeadlineAt(deadlineAt);
  const survivors = leases.filter((lease) => !expired.includes(lease));
  const overQuota = survivors
    // A recent entry without lease.json is an in-progress clone. Never evict
    // that lock merely because the quota is full; stale locks are reclaimed
    // by the TTL branch above.
    .filter((lease) => !lease.active && !lease.ownerAlive && lease.valid)
    .sort((left, right) => left.lastUsed - right.lastUsed)
    .slice(0, Math.max(0, survivors.length - TARGET_STAGE_MAX_LEASES));
  for (const lease of overQuota) await removeLeaseDirectory(
    stageRoot,
    lease.directory,
    lease.directoryIdentity,
  ).catch(() => {});
  assertStageDeadlineAt(deadlineAt);
  await revalidateStateDirectory(stageRoot);
}

async function stagedCheckoutClean(checkout, deadlineAt) {
  try {
    const result = await runStageGit([
    '-C', checkout,
    'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching',
    ], 'staged checkout status', deadlineAt);
    return !result;
  } catch (error) {
    if (error?.code === 'target_stage_timeout') throw error;
    return false;
  }
}

async function existingStageLease(
  leaseDirectory,
  leaseFile,
  checkout,
  descriptorDigest,
  resolvedHead,
  sourceType,
  deadlineAt,
) {
  const directoryMetadata = await lstat(leaseDirectory).catch(() => null);
  if (!directoryMetadata?.isDirectory() || directoryMetadata.isSymbolicLink()) return null;
  const leaseIdentity = { dev: String(directoryMetadata.dev), ino: String(directoryMetadata.ino) };
  const owner = await targetLeaseOwner(leaseDirectory, leaseIdentity);
  if (owner.record && owner.alive) return null;
  const leaseChild = await readLeaseChild(leaseDirectory, 'lease.json', leaseIdentity).catch(() => null);
  const lease = leaseChild?.value ?? null;
  if (!lease || lease.descriptor_digest !== descriptorDigest || lease.resolved_head !== resolvedHead
    || lease.source_type !== sourceType || lease.tainted === true) return null;
  if (await exists(path.join(leaseDirectory, 'tainted'))) return null;
  const metadata = await stageTargetGitMetadata(checkout, deadlineAt).catch((error) => {
    if (error?.code === 'target_stage_timeout') throw error;
    return null;
  });
  if (!metadata || metadata.root !== path.resolve(checkout) || metadata.head !== resolvedHead) return null;
  if (!await stagedCheckoutClean(checkout, deadlineAt)) return null;
  const checkoutIdentity = await directoryIdentity(checkout, 'staged checkout').catch(() => null);
  if (!checkoutIdentity || (lease.checkout_identity && !sameFsIdentity(lease.checkout_identity, checkoutIdentity))) return null;
  const refreshed = { ...lease, last_used_at: new Date().toISOString() };
  await writeLease(leaseFile, refreshed, { expectedDirectoryIdentity: leaseIdentity });
  return {
    directory: path.resolve(checkout),
    head: resolvedHead,
    common: metadata.common,
    source_type: sourceType,
    lease_directory: path.resolve(leaseDirectory),
    lease_identity: leaseIdentity,
    taint_file: path.join(leaseDirectory, 'tainted'),
  };
}

async function stageTargetSource(source) {
  const stageDeadlineAt = Date.now() + TARGET_STAGE_DEADLINE_MS;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ToolError('invalid_target_source', 'target_context.source must identify a local checkout or GitHub repository.');
  }
  for (const key of Object.keys(source)) {
    if (!TARGET_SOURCE_KEYS.has(key)) {
      throw new ToolError('invalid_target_source', `target_context.source.${key} is not supported.`);
    }
  }
  if (!TARGET_SOURCE_TYPES.has(source.type)) {
    throw new ToolError('invalid_target_source', 'target_context.source.type must be local or github.');
  }
  const ref = sourceRef(source.ref);
  let repository;
  let sourceMetadata = null;
  if (source.type === 'local') {
    if (Object.hasOwn(source, 'repository')) {
      throw new ToolError('invalid_target_source', 'Local sources must use path, not repository.');
    }
    if (typeof source.path !== 'string' || !path.isAbsolute(source.path) || source.path.includes('\0')) {
      throw new ToolError('invalid_target_source', 'target_context.source.path must be an absolute local Git path.');
    }
    sourceMetadata = await sourceGitRoot(await realpath(source.path).catch(() => {
      throw new ToolError('invalid_target_source', 'target_context.source.path does not resolve to a local Git checkout.');
    }), stageDeadlineAt);
    const writableSourceRoot = GROK_READ_ONLY_WRITABLE_ROOTS.find((root) => isPathWithin(root, sourceMetadata.root));
    if (writableSourceRoot) {
      throw new ToolError(
        'target_source_unverifiable',
        `The local source Git root is beneath ${writableSourceRoot}, where the built-in provider profile permits writes; move the source to a non-temporary root or use a GitHub source for staged review.`,
      );
    }
    repository = sourceMetadata.root;
  } else {
    if (Object.hasOwn(source, 'path')) {
      throw new ToolError('invalid_target_source', 'GitHub sources must use repository, not path.');
    }
    repository = githubRepository(source.repository);
  }

  assertStageDeadlineAt(stageDeadlineAt);
  await ensureState();
  assertStageDeadlineAt(stageDeadlineAt);
  const stateWritableRoot = GROK_READ_ONLY_WRITABLE_ROOTS.find((root) => STATE_DIR && isPathWithin(root, STATE_DIR));
  if (stateWritableRoot) {
    throw new ToolError(
      'target_stage_state_unverifiable',
      `Staged targets cannot use a state directory beneath ${stateWritableRoot}; the provider's built-in read-only profile permits writes there. Configure a non-temporary Co-Engineer state directory.`,
    );
  }
  const stageRoot = await prepareStateDirectory(path.join(STATE_DIR, TARGET_STAGE_ROOT_NAME));
  await revalidateStateDirectory(stageRoot);
  assertStageDeadlineAt(stageDeadlineAt);
  await pruneTargetLeases(stageRoot, stageDeadlineAt);
  assertStageDeadlineAt(stageDeadlineAt);
  const resolved = source.type === 'local'
    ? await resolveLocalRef(sourceMetadata.root, ref, sourceMetadata.head, stageDeadlineAt)
    : await resolveGithubRef(repository, ref, stageDeadlineAt);
  assertStageDeadlineAt(stageDeadlineAt);
  const resolvedHead = resolved.commit;
  const resolvedRef = resolved.ref;
  const descriptor = leaseDescriptor(source, repository, ref, resolvedHead);
  const descriptorDigest = sha256Digest(descriptor);
  const leaseDirectory = path.join(stageRoot.directory, `lease-${descriptorDigest}`);
  const leaseFile = path.join(leaseDirectory, 'lease.json');
  const checkout = path.join(leaseDirectory, 'checkout');
  const acquireStarted = Date.now();
  let acquired = false;
  let leaseIdentity = null;

  // A deterministic lease makes preflight and the subsequent run observe the
  // same checkout. A second caller waits for an in-progress clone, then
  // reuses it; a dead owner is reclaimed only after a bounded stale period.
  while (!acquired) {
    try {
      await mkdir(leaseDirectory, { mode: 0o700 });
      leaseIdentity = await leaseDirectoryIdentity(leaseDirectory);
      const owner = await writeLeaseOwner(leaseDirectory, leaseIdentity);
      if (!owner.record.start_time) throw new ToolError('target_stage_failed', 'Target staging owner is not verifiable.');
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (leaseIdentity) {
          await removeLeaseDirectory(stageRoot, leaseDirectory, leaseIdentity).catch(() => {});
          leaseIdentity = null;
        }
        if (error?.code === 'state_symlink' || error?.code === 'state_not_directory') {
          throw new ToolError('target_stage_failed', `Target staging lease is not a private directory: ${leaseDirectory}`);
        }
        throw error;
      }
      const reusable = await existingStageLease(
        leaseDirectory,
        leaseFile,
        checkout,
        descriptorDigest,
        resolvedHead,
        source.type,
        stageDeadlineAt,
      );
      if (reusable) {
        await revalidateStateDirectory(stageRoot);
        assertStageDeadlineAt(stageDeadlineAt);
        return reusable;
      }
      const observed = await lstat(leaseDirectory).catch(() => null);
      if (!observed?.isDirectory() || observed.isSymbolicLink()) {
        throw new ToolError('target_stage_failed', `Target staging lease is not a private directory: ${leaseDirectory}`);
      }
      const observedIdentity = { dev: String(observed.dev), ino: String(observed.ino) };
      const owner = await targetLeaseOwner(leaseDirectory, observedIdentity);
      const existingLease = await readLeaseChild(leaseDirectory, 'lease.json', observedIdentity).catch(() => null);
      if (existingLease?.value && !owner.alive) {
        // A completed lease that no longer points at a clean, untainted
        // checkout is disposable. Reclaim it by inode before cloning a fresh
        // copy; never recursively remove a replacement at the same path.
        await removeLeaseDirectory(stageRoot, leaseDirectory, observedIdentity);
        continue;
      }
      // A clone may block the event loop for longer than the stale-lock TTL.
      // Reclaim only when the recorded owner is absent/dead, and fence the
      // recursive cleanup to the exact directory inode observed above.
      if (!owner.alive && Date.now() - observed.mtimeMs > TARGET_STAGE_LOCK_STALE_MS) {
        await removeLeaseDirectory(stageRoot, leaseDirectory, observedIdentity);
        continue;
      }
      if (Date.now() - acquireStarted >= TARGET_STAGE_ACQUIRE_TIMEOUT_MS) {
        throw new ToolError('target_stage_busy', 'Another control-plane operation is staging this target; retry after it completes.');
      }
      assertStageDeadlineAt(stageDeadlineAt);
      await sleep(200);
    }
  }

  let temporaryCheckout;
  let temporaryCheckoutIdentity = null;
  try {
    assertStageDeadlineAt(stageDeadlineAt);
    await revalidateStateDirectory(stageRoot);
    if (!leaseIdentity || !sameFsIdentity(
      await leaseDirectoryIdentity(leaseDirectory),
      leaseIdentity,
    )) throw new ToolError('target_stage_identity_changed', 'Target staging lease changed before cloning.');
    temporaryCheckout = await mkdtemp(path.join(leaseDirectory, 'checkout-tmp-'));
    await chmod(temporaryCheckout, 0o700);
    temporaryCheckoutIdentity = await leaseDirectoryIdentity(temporaryCheckout, 'temporary target checkout');
    const cloneArgs = ['clone', '--no-checkout', '--no-tags'];
    if (source.type === 'local') cloneArgs.push('--no-local');
    cloneArgs.push(repository, temporaryCheckout);
    await runStageGit(cloneArgs, 'target source clone', stageDeadlineAt);
    assertStageDeadlineAt(stageDeadlineAt);
    await assertStageSize(temporaryCheckout, stageDeadlineAt);
    if (resolvedRef) {
      await runStageGit(['-C', temporaryCheckout, 'fetch', '--no-tags', 'origin', resolvedRef], 'target source ref fetch', stageDeadlineAt);
      assertStageDeadlineAt(stageDeadlineAt);
      await runStageGit(['-C', temporaryCheckout, 'checkout', '--detach', 'FETCH_HEAD'], 'target source ref checkout', stageDeadlineAt);
    } else {
      await runStageGit(['-C', temporaryCheckout, 'checkout', '--detach', resolvedHead], 'target source checkout', stageDeadlineAt);
    }
    assertStageDeadlineAt(stageDeadlineAt);
    // A staged review never needs its origin and must not expose a private
    // source URL or a credential-bearing remote to the provider.
    await runStageGit(['-C', temporaryCheckout, 'remote', 'remove', 'origin'], 'target source remote cleanup', stageDeadlineAt);
    assertStageDeadlineAt(stageDeadlineAt);
    await assertStageSize(temporaryCheckout, stageDeadlineAt);
    const stagedMetadata = await stageTargetGitMetadata(temporaryCheckout, stageDeadlineAt);
    if (stagedMetadata.head !== resolvedHead) {
      throw new ToolError('target_stage_failed', `The staged checkout resolved ${stagedMetadata.head}, expected ${resolvedHead}.`);
    }
    await revalidateStateDirectory(stageRoot);
    const leaseBeforePublish = await leaseDirectoryIdentity(leaseDirectory);
    if (!sameFsIdentity(leaseBeforePublish, leaseIdentity)) {
      throw new ToolError('target_stage_identity_changed', 'Target staging lease was replaced during cloning.');
    }
    const existingCheckout = await lstat(checkout).catch(() => null);
    if (existingCheckout) {
      throw new ToolError('target_stage_identity_changed', 'Target staging checkout was replaced during cloning.');
    }
    await rename(temporaryCheckout, checkout);
    temporaryCheckout = null;
    temporaryCheckoutIdentity = null;
    const checkoutIdentity = await directoryIdentity(checkout, 'staged checkout');
    // Git reports an absolute common-directory path. Recompute it after the
    // atomic publish so the first caller and later lease reusers bind the same
    // final checkout identity rather than the temporary pre-rename pathname.
    const publishedMetadata = await stageTargetGitMetadata(checkout, stageDeadlineAt);
    if (publishedMetadata.head !== resolvedHead) {
      throw new ToolError('target_stage_failed', `The published checkout resolved ${publishedMetadata.head}, expected ${resolvedHead}.`);
    }
    const now = new Date().toISOString();
    await writeLease(leaseFile, {
      schema_version: 'codex-co-engineer.target-lease.v1',
      descriptor_digest: descriptorDigest,
      source_type: source.type,
      resolved_head: resolvedHead,
      created_at: now,
      last_used_at: now,
      checkout_identity: checkoutIdentity,
    }, { expectedDirectoryIdentity: leaseIdentity });
    await removeLeaseChild(leaseDirectory, 'owner.json', leaseIdentity).catch(() => {});
    await revalidateStateDirectory(stageRoot);
    return {
      directory: path.resolve(checkout),
      head: resolvedHead,
      common: publishedMetadata.common,
      source_type: source.type,
      lease_directory: path.resolve(leaseDirectory),
      lease_identity: leaseIdentity,
      taint_file: path.join(leaseDirectory, 'tainted'),
    };
  } catch (error) {
    if (temporaryCheckout && temporaryCheckoutIdentity) {
      const currentTemporary = await lstat(temporaryCheckout).catch(() => null);
      if (currentTemporary && sameFsIdentity(currentTemporary, temporaryCheckoutIdentity)) {
        await rm(temporaryCheckout, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (acquired && leaseIdentity) {
      await removeLeaseDirectory(stageRoot, leaseDirectory, leaseIdentity).catch(() => {});
    }
    throw error;
  }
}

async function directoryIdentity(directory, label) {
  const info = await stat(directory).catch(() => {
    throw new ToolError('invalid_target_context', `${label} does not resolve to an existing directory.`);
  });
  if (!info.isDirectory()) {
    throw new ToolError('invalid_target_context', `${label} must resolve to a directory.`);
  }
  return {
    device: String(info.dev),
    inode: String(info.ino),
  };
}

async function prepareTarget(rawTarget) {
  if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    throw new ToolError('invalid_target_context', 'target_context must be a versioned object; omitted and null targets are not allowed.');
  }
  for (const key of Object.keys(rawTarget)) {
    if (!TARGET_CONTEXT_KEYS.has(key)) {
      throw new ToolError('invalid_target_context', `target_context.${key} is not supported.`);
    }
  }
  if (rawTarget.schema_version !== TARGET_SCHEMA_VERSION) {
    throw new ToolError('invalid_target_context', `target_context.schema_version must be ${TARGET_SCHEMA_VERSION}.`);
  }
  if (!TARGET_MODES.has(rawTarget.mode)) {
    throw new ToolError('invalid_target_context', 'target_context.mode must be default, explicit, or staged.');
  }

  let staged = null;
  if (rawTarget.mode === 'staged') {
    const stagedKeys = new Set(['schema_version', 'mode', 'source', 'allowed_paths', 'role']);
    for (const key of Object.keys(rawTarget)) {
      if (!stagedKeys.has(key)) {
        throw new ToolError('invalid_target_context', `target_context.${key} is not supported when mode=staged.`);
      }
    }
    if (rawTarget.role === 'implement') {
      throw new ToolError(
        'invalid_target_context',
        'Staged targets are read-only review or verify checkouts; implement runs require an explicit workspace target.',
      );
    }
    staged = await stageTargetSource(rawTarget.source);
    rawTarget = {
      schema_version: TARGET_SCHEMA_VERSION,
      mode: 'explicit',
      working_directory: staged.directory,
      expected_git_root: staged.directory,
      expected_head: staged.head,
      allowed_paths: rawTarget.allowed_paths,
      role: rawTarget.role,
    };
  }

  if (Object.hasOwn(rawTarget, 'source')) {
    throw new ToolError('invalid_target_context', 'target_context.source is only valid when mode=staged.');
  }

  const isDefault = rawTarget.mode === 'default';
  const targetKeys = new Set(Object.keys(rawTarget));
  if (isDefault) {
    for (const key of ['working_directory', 'expected_git_root', 'expected_head']) {
      if (targetKeys.has(key)) {
        throw new ToolError('invalid_target_context', `target_context.${key} is only valid when mode=explicit.`);
      }
    }
  } else {
    for (const key of ['working_directory', 'expected_git_root', 'expected_head', 'allowed_paths', 'role']) {
      if (!targetKeys.has(key)) {
        throw new ToolError('invalid_target_context', `target_context.${key} is required when mode=explicit.`);
      }
    }
  }
  if (isDefault && rawTarget.role === 'implement') {
    throw new ToolError('invalid_target_context', 'The default workspace cannot be used for implement runs; provide an explicit target.');
  }
  const workingDirectory = normalizeTargetPath(
    isDefault ? WORKSPACE : rawTarget.working_directory,
    'working_directory',
  );
  const expectedGitRoot = isDefault
    ? null
    : normalizeTargetPath(rawTarget.expected_git_root, 'expected_git_root');
  if (!isDefault && (typeof rawTarget.expected_head !== 'string' || !/^[0-9a-f]{40}$/i.test(rawTarget.expected_head))) {
    throw new ToolError('invalid_target_context', 'expected_head must be a full 40-character hexadecimal Git revision.');
  }
  const allowedPaths = rawTarget.allowed_paths === undefined
    ? ['.']
    : rawTarget.allowed_paths;
  if (!Array.isArray(allowedPaths) || allowedPaths.length < 1 || allowedPaths.length > 200) {
    throw new ToolError('invalid_target_context', 'allowed_paths must contain 1 to 200 relative paths.');
  }
  if (new Set(allowedPaths).size !== allowedPaths.length) {
    throw new ToolError('invalid_target_context', 'allowed_paths must not contain duplicates.');
  }
  const role = rawTarget.role ?? 'review';
  if (!TARGET_ROLES.has(role)) {
    throw new ToolError('invalid_target_context', 'role must be review, implement, or verify.');
  }
  const resolvedWorkingDirectory = await realpath(workingDirectory).catch(() => {
    throw new ToolError('invalid_target_context', 'working_directory does not resolve to an existing directory.');
  });
  const resolvedGitRoot = expectedGitRoot
    ? await realpath(expectedGitRoot).catch(() => {
      throw new ToolError('invalid_target_context', 'expected_git_root does not resolve to an existing directory.');
    })
    : null;
  if (resolvedWorkingDirectory !== path.resolve(workingDirectory)
    || (resolvedGitRoot && resolvedGitRoot !== path.resolve(expectedGitRoot))) {
    throw new ToolError('invalid_target_context', 'target paths may not contain symlinks.');
  }
  const metadata = staged
    ? {
      root: resolvedGitRoot,
      head: rawTarget.expected_head.toLowerCase(),
      common: staged.common,
    }
    : await targetGitMetadata(resolvedWorkingDirectory);
  if (resolvedGitRoot && metadata.root !== resolvedGitRoot) {
    throw new ToolError('invalid_target_context', `working_directory is not inside expected_git_root (${metadata.root}).`);
  }
  const exactRoot = resolvedGitRoot ?? metadata.root;
  if (!isPathWithin(exactRoot, resolvedWorkingDirectory)) {
    throw new ToolError('invalid_target_context', 'working_directory must be inside expected_git_root.');
  }
  if (!isDefault && metadata.head !== rawTarget.expected_head.toLowerCase()) {
    throw new ToolError('target_head_mismatch', `Expected HEAD ${rawTarget.expected_head}, found ${metadata.head}.`);
  }
  const targetRoots = configuredTargetRoots();
  if (!staged && targetRoots && !targetRoots.some((root) => isPathWithin(root, resolvedWorkingDirectory))) {
    throw new ToolError('target_outside_allowlist', 'working_directory is outside the administrator-configured target roots.');
  }
  if (!staged && targetRoots && !targetRoots.some((root) => isPathWithin(root, exactRoot))) {
    throw new ToolError('target_outside_allowlist', 'expected_git_root is outside the administrator-configured target roots.');
  }
  const normalizedAllowedPaths = allowedPaths.map(normalizeAllowedPath);
  const cwdIdentity = await directoryIdentity(resolvedWorkingDirectory, 'working_directory');
  const workspaceIdentity = await directoryIdentity(exactRoot, 'expected_git_root');
  const targetFingerprint = targetIdentityDigest({
    mode: rawTarget.mode,
    resolved_workspace: exactRoot,
    resolved_cwd: resolvedWorkingDirectory,
    git_common_directory: metadata.common,
    git_head: metadata.head,
    allowed_paths: normalizedAllowedPaths,
    role,
    workspace_identity: workspaceIdentity,
    cwd_identity: cwdIdentity,
  });
  return {
    cwd: resolvedWorkingDirectory,
    target: {
      schema_version: TARGET_SCHEMA_VERSION,
      mode: rawTarget.mode,
      working_directory: resolvedWorkingDirectory,
      expected_git_root: exactRoot,
      resolved_workspace: exactRoot,
      resolved_cwd: resolvedWorkingDirectory,
      git_common_directory: metadata.common,
      expected_head: metadata.head,
      observed_head: metadata.head,
      allowed_paths: normalizedAllowedPaths,
      role,
      target_fingerprint: targetFingerprint,
      workspace_identity: workspaceIdentity,
      cwd_identity: cwdIdentity,
      ...(staged ? { target_origin: 'control_plane_staged' } : {}),
      ...(staged ? {
        stage_lease_directory: staged.lease_directory,
        stage_lease_identity: staged.lease_identity,
        stage_taint_file: staged.taint_file,
      } : {}),
      isolation: role === 'implement'
        ? 'explicit-scoped-workspace'
        : 'read-only-process-contract',
    },
    targetFingerprint,
  };
}

function concise(value, maximum = 120) {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function newJobId(kind) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${kind}-${stamp}-${randomBytes(4).toString('hex')}`;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isOwned(job) {
  if (!isAlive(job.child_pid)) return false;
  try {
    const environment = await readFile(`/proc/${job.child_pid}/environ`);
    return environment.includes(Buffer.from(`PLUMBOB_CONTROL_JOB_ID=${job.id}\0`));
  } catch {
    return false;
  }
}

async function logBytes(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

function elapsedSince(startedAt, finishedAt = new Date().toISOString()) {
  const start = Date.parse(startedAt ?? '');
  const finish = Date.parse(finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  return Math.max(0, Math.round(((finish - start) / 1000) * 1000) / 1000);
}

async function reconcile(job) {
  const lifecycleState = job.lifecycle_state ?? job.status;
  if (!ACTIVE_STATES.has(lifecycleState) && !ACTIVE_STATES.has(job.status)) return job;
  if ((job.status === 'queued' || job.status === 'starting')
    && Date.now() - Date.parse(job.created_at) < 15000) return job;
  if (isAlive(job.child_pid) || isAlive(job.runner_pid)) return job;

  const finishedAt = new Date().toISOString();
  const cancelled = await exists(job.cancel_file);
  const bytes = await logBytes(job.log_file);
  const outcome = cancelled ? 'cancelled' : 'failed';
  const patch = {
    finished_at: finishedAt,
    elapsed_seconds: elapsedSince(job.started_at ?? job.created_at, finishedAt),
    termination_reason: cancelled ? 'cancelled_by_user' : 'process_lost',
    failure_class: cancelled ? 'cancelled' : 'process_failure',
    error: job.error ?? (cancelled
      ? 'Cancellation was requested, but the managed process disappeared before completion.'
      : 'The recorded process is no longer running.'),
    partial_output_available: bytes > 0 ? 1 : 0,
    log_bytes: bytes,
  };
  return terminalizeJob(database, job.id, outcome, patch, {
    termination_reason: patch.termination_reason,
  }).job;
}

async function getJob(id) {
  await ensureState();
  validateJobId(id);
  const job = getStoredJob(database, id);
  if (!job) throw new ToolError('job_not_found', `No managed job named ${id}.`);
  return reconcile(job);
}

async function listJobs(limit = 10) {
  await ensureState();
  const jobs = [];
  for (const job of listStoredJobs(database, limit)) {
    jobs.push(await reconcile(job));
  }
  return jobs;
}

function publicJob(job) {
  const effectiveConfiguration = storedJson(job.effective_configuration);
  const targetContext = storedJson(job.target_context);
  return {
    id: job.id,
    kind: publicJobKind(job.kind),
    status: job.lifecycle_state ?? ({
      queued: 'accepted',
      starting: 'started',
      running: 'working',
      cancelling: 'working',
      succeeded: 'completed',
      timed_out: 'timeout',
      uncertain: 'failed',
    }[job.status] ?? job.status),
    terminal_state: job.terminal_state ?? null,
    failure_class: job.failure_class ?? null,
    summary: job.summary,
    created_at: job.created_at,
    started_at: job.started_at ?? null,
    finished_at: job.finished_at ?? null,
    exit_code: job.exit_code ?? null,
    signal: job.signal ?? null,
    signal_sent: job.signal_sent ?? null,
    forced_kill: storedBoolean(job.forced_kill),
    error: job.error ?? null,
    termination_reason: job.termination_reason ?? null,
    deadline_at: job.deadline_at ?? null,
    elapsed_seconds: typeof job.elapsed_seconds === 'number' ? job.elapsed_seconds : null,
    last_activity_at: job.last_activity_at ?? null,
    partial_output_available: storedBoolean(job.partial_output_available),
    workspace_changed: storedBoolean(job.workspace_changed),
    workspace_tainted: storedBoolean(job.workspace_tainted),
    changed_paths: storedJson(job.changed_paths, []),
    heartbeat: storedJson(job.heartbeat),
    stalled: storedBoolean(job.stalled),
    log_bytes: typeof job.log_bytes === 'number' ? job.log_bytes : null,
    patch_artifact: job.patch_artifact ?? null,
    url: job.url ?? null,
    request_id: job.request_id ?? null,
    request_fingerprint: job.request_fingerprint ?? null,
    target_fingerprint: targetContext?.target_fingerprint
      ?? effectiveConfiguration?.target_fingerprint
      ?? null,
    configuration_digest: effectiveConfiguration?.configuration_digest ?? null,
    timeout_seconds: job.timeout_seconds ?? null,
    effective_configuration: effectiveConfiguration,
    target_context: targetContext,
    lifecycle: database
      ? listLifecycleEvents(database, job.id).map((event) => ({
        sequence: event.sequence,
        state: event.lifecycle_state,
        type: event.event_type,
        at: event.occurred_at,
      }))
      : [],
    adapter_versions: job.adapter_versions ? JSON.parse(job.adapter_versions) : null,
  };
}

function compactText(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return text.length <= COMPACT_JOB_TEXT_MAX_LENGTH
    ? text
    : `${text.slice(0, COMPACT_JOB_TEXT_MAX_LENGTH - 1)}…`;
}

function publicLifecycleState(job) {
  return job.lifecycle_state ?? ({
    queued: 'accepted',
    starting: 'started',
    running: 'working',
    cancelling: 'working',
    succeeded: 'completed',
    timed_out: 'timeout',
    uncertain: 'failed',
  }[job.status] ?? job.status);
}

/**
 * The status/list surfaces are intentionally summaries.  Keep provider
 * configuration, target contracts, prompts, logs, and lifecycle history on
 * the explicit jobs get path so routine health checks remain small and safe.
 */
function compactJob(job) {
  const targetContext = storedJson(job.target_context);
  const effectiveConfiguration = storedJson(job.effective_configuration);
  const role = targetContext?.role ?? effectiveConfiguration?.role ?? null;
  return {
    id: job.id,
    kind: publicJobKind(job.kind),
    role: TARGET_ROLES.has(role) ? role : null,
    status: publicLifecycleState(job),
    terminal_state: job.terminal_state ?? null,
    failure_class: compactText(job.failure_class),
    created_at: job.created_at,
    started_at: job.started_at ?? null,
    finished_at: job.finished_at ?? null,
    deadline_at: job.deadline_at ?? null,
    last_activity_at: job.last_activity_at ?? null,
    elapsed_seconds: typeof job.elapsed_seconds === 'number' ? job.elapsed_seconds : null,
    stalled: storedBoolean(job.stalled),
    termination_reason: compactText(job.termination_reason),
    partial_output_available: storedBoolean(job.partial_output_available),
    workspace_changed: storedBoolean(job.workspace_changed),
    workspace_tainted: storedBoolean(job.workspace_tainted),
    log_bytes: typeof job.log_bytes === 'number' ? job.log_bytes : null,
  };
}

function redactLog(value) {
  return String(value)
    .replace(/((?:api[_-]?key|authorization|bearer|access[_-]?token|secret)\s*[:=]\s*)[^\s,]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

async function tailLog(file, lineCount) {
  if (!(await exists(file))) return { text: '', truncated: false };
  const info = await stat(file);
  const bytes = Math.min(info.size, 65536);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, info.size - bytes);
    const clean = redactLog(buffer.toString('utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''));
    const lines = clean.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const selected = lines.slice(-lineCount).join('\n').trim();
    const text = selected.length <= LOG_PAGE_MAX_BYTES ? selected : selected.slice(-LOG_PAGE_MAX_BYTES);
    return {
      text,
      truncated: info.size > bytes || selected.length > LOG_PAGE_MAX_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function logSuffix(file, maximumBytes = 1_048_576) {
  if (!(await exists(file))) return '';
  const info = await stat(file);
  const bytes = Math.min(info.size, maximumBytes);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    if (bytes > 0) await handle.read(buffer, 0, bytes, info.size - bytes);
    return redactLog(buffer.toString('utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''));
  } finally {
    await handle.close();
  }
}

async function terminalGrokResponse(job) {
  const lifecycle = job?.lifecycle_state ?? job?.status;
  if (job?.kind !== 'grok_build' || !['completed', 'succeeded'].includes(lifecycle)) return null;
  const parsed = grokBuildFinalResponse(await logSuffix(job.log_file));
  if (!parsed) return null;
  const configuration = storedJson(job.effective_configuration);
  const outputFormat = configuration?.grok_configuration?.output_format
    ?? configuration?.output_format;
  return {
    ...parsed,
    source: outputFormat === 'json' ? 'grok_json' : 'grok_streaming_json',
  };
}

function parseCursor(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d{1,16}$/.test(text)) {
    throw new ToolError('invalid_cursor', 'after_cursor must be a non-negative byte offset with at most 16 digits.');
  }
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor)) {
    throw new ToolError('invalid_cursor', 'after_cursor is outside the supported byte-offset range.');
  }
  return cursor;
}

async function readLogPage(file, afterCursor, limitBytes) {
  if (!(await exists(file))) {
    return {
      data: '',
      cursor: String(afterCursor),
      next_cursor: String(afterCursor),
      log_bytes: 0,
      truncated_before: afterCursor > 0,
      truncated_after: false,
    };
  }
  const info = await stat(file);
  if (afterCursor > info.size) {
    throw new ToolError('invalid_cursor', 'after_cursor is beyond the current log size.');
  }
  const bytes = Math.min(limitBytes, info.size - afterCursor);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    if (bytes > 0) await handle.read(buffer, 0, bytes, afterCursor);
    const nextCursor = afterCursor + bytes;
    return {
      data: redactLog(buffer.toString('utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')),
      cursor: String(afterCursor),
      next_cursor: String(nextCursor),
      log_bytes: info.size,
      truncated_before: afterCursor > 0,
      truncated_after: nextCursor < info.size,
    };
  } finally {
    await handle.close();
  }
}

async function portOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: WEB_HOST, port: WEB_PORT });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(350);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

let versionCache;
function versions() {
  if (versionCache) return versionCache;
  const run = (command, args, env = undefined) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      ...(env ? { env } : {}),
    });
    return concise(result.stdout || result.stderr || 'unavailable', 80);
  };
  const dshVersion = dshVersionProbe(DSH, process.env, DSH_HOME);
  versionCache = {
    deepseek_harness: dshVersion.version ?? dshVersion.detail ?? 'unavailable',
    grok: run(GROK, ['--version'], grokEnvironment()),
  };
  versionCache.compatible = {
    deepseek_harness: dshVersion.compatible,
  };
  return versionCache;
}

let dshReadinessCache;
function deepseekReadiness() {
  // Keep only a compact identity snapshot between calls.  Every call still
  // lstat-checks the home/profile and compares it with the snapshot, so a
  // replaced directory or profile cannot remain trusted for daemon lifetime.
  const status = inspectDsh({
    command: DSH,
    home: DSH_HOME,
    source: DSH_HOME_CONFIG.source,
    patchFile: DSH_PATCH_FILE,
    cwd: PLUGIN_ROOT,
    env: process.env,
    initialize: !dshReadinessCache?.ok,
    expectedIdentity: dshReadinessCache?.ok ? dshReadinessCache.identity : null,
  });
  if (status.ok) dshReadinessCache = status;
  else dshReadinessCache = null;
  return status;
}

function requireDeepSeekReady() {
  const prepared = deepseekReadiness();
  if (!prepared.ok) {
    throw new ToolError('dsh_unavailable', dshReadinessMessage(prepared));
  }
  // This second, initialization-free check is deliberately adjacent to the
  // caller's spawn.  It catches home/profile replacement after status or
  // preflight succeeded without rerunning the DSH provider-free setup.
  const status = inspectDsh({
    command: DSH,
    home: DSH_HOME,
    source: DSH_HOME_CONFIG.source,
    patchFile: DSH_PATCH_FILE,
    cwd: PLUGIN_ROOT,
    env: process.env,
    initialize: false,
    expectedIdentity: prepared.identity,
  });
  if (!status.ok) {
    dshReadinessCache = null;
    throw new ToolError('dsh_unavailable', dshReadinessMessage(status));
  }
  dshReadinessCache = status;
  return status;
}

function managedDshOverlayConfigured() {
  return DSH_HOME_CONFIG.source === 'managed-state'
    && DSH_PATCH_FILE === DEFAULT_DSH_PATCH_FILE;
}

function verifiedManagedDshOverlay(status) {
  return status?.ok === true && managedDshOverlayConfigured();
}

function normalizeDshForTool(value) {
  if (!managedDshOverlayConfigured()) {
    if (value !== undefined) {
      throw new ToolError(
        'dsh_options_unavailable',
        'dsh_options require the verified Co-Engineer managed headless overlay; custom DSH homes have an unknown capability/configuration surface.',
      );
    }
    return null;
  }
  try {
    return normalizeDshOptions(value ?? {});
  } catch (error) {
    throw new ToolError('invalid_dsh_configuration', error?.message ?? 'Invalid dsh_options.');
  }
}

function dshCapabilities(readiness, configuration = {}) {
  return verifiedManagedDshOverlay(readiness)
    ? dshCapabilityProfile(configuration)
    : null;
}

function dshWorkerEnvironment(configuration) {
  return configuration
    ? dshChildEnvironment(DSH_HOME, configuration)
    : dshBaseEnvironment(DSH_HOME);
}

/**
 * The usage runner is an adapter-owned control path.  Its two environment
 * variables must be written after any caller/provider environment so a
 * provider cannot redirect the receipt to another job or disable collection.
 */
function startJobEnvironment(kind, id, env, readiness = dshReadinessCache) {
  const childEnvironment = { ...env };
  // These names are connector-owned even when collection is disabled. Strip
  // any inherited/provider value before deciding whether the verified managed
  // overlay may receive the authoritative exact-job values.
  delete childEnvironment.CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER;
  delete childEnvironment.CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH;
  if (kind === 'deepseek_agent' && verifiedManagedDshOverlay(readiness)) {
    childEnvironment.CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER = '1';
    childEnvironment.CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH = path.join(
      JOBS_DIR,
      `${id}.usage.json`,
    );
  }
  return childEnvironment;
}

let productionCapacityReader;

/**
 * Build the provider reader only when capacity is first requested.  The DSH
 * reader itself is lazy as well: account-only or Codex/Grok requests do not
 * touch the managed jobs directory, while selected DSH jobs are bound to the
 * exact control jobs directory and reconciled store lookup.
 */
function getProductionCapacityReader() {
  if (productionCapacityReader) return productionCapacityReader;
  let dshReceiptReader = null;
  if (managedDshOverlayConfigured()) {
    let reader;
    dshReceiptReader = async (jobId) => {
      const readiness = requireDeepSeekReady();
      if (!verifiedManagedDshOverlay(readiness)) {
        throw new CapacityError(
          'dsh_receipt_unsupported',
          'DSH receipts require the verified Co-Engineer managed headless overlay.',
        );
      }
      reader ??= createDshReceiptReader({ jobsDir: JOBS_DIR, loadJob: getJob });
      return reader(jobId);
    };
  }
  productionCapacityReader = createCapacityReader({
    // The command is administrator-selected at MCP process startup.  Pass it
    // explicitly so Grok capacity uses the same executable as status and run;
    // the capacity helper otherwise defaults to the literal `grok` command.
    readGrok: (options) => readGrokCapacity({ ...options, command: GROK }),
    readDshReceipt: dshReceiptReader,
  });
  return productionCapacityReader;
}

function readProductionCapacity(args = {}) {
  return getProductionCapacityReader()(args);
}

async function startJob({
  kind,
  summary,
  command,
  args,
  env = {},
  url = null,
  requestId = null,
  requestFingerprint = null,
  timeoutSeconds = null,
  outputDir = null,
  resultFormat = null,
  cwd = WORKSPACE,
  targetContext = null,
  effectiveConfiguration = null,
  redactions = [],
}) {
  await ensureState();
  if (!targetContext || !effectiveConfiguration?.target_fingerprint || !path.isAbsolute(cwd)) {
    throw new ToolError(
      'missing_target_contract',
      'Every managed job requires one resolved target, absolute cwd, and target fingerprint.',
    );
  }
  const id = newJobId(kind.replaceAll('_', '-'));
  const createdAt = new Date().toISOString();
  const deadlineAt = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? new Date(Date.parse(createdAt) + timeoutSeconds * 1000).toISOString()
    : null;
  const logFile = path.join(JOBS_DIR, `${id}.log`);
  const cancelFile = path.join(JOBS_DIR, `${id}.cancel`);
  const specFile = path.join(JOBS_DIR, `${id}.spec.json`);
  const patchArtifact = targetContext ? path.join(JOBS_DIR, `${id}.patch`) : null;
  const job = {
    id,
    kind,
    status: 'queued',
    summary,
    created_at: createdAt,
    updated_at: createdAt,
    log_file: logFile,
    cancel_file: cancelFile,
    url,
    request_id: requestId,
    request_fingerprint: requestFingerprint,
    output_dir: outputDir,
    timeout_seconds: timeoutSeconds,
    deadline_at: deadlineAt,
    adapter_versions: JSON.stringify(versions()),
    effective_configuration: effectiveConfiguration ? JSON.stringify(effectiveConfiguration) : null,
    target_context: targetContext ? JSON.stringify(targetContext) : null,
    patch_artifact: patchArtifact,
  };

  insertJob(database, job);
  await writeSpec(specFile, {
    id,
    kind,
    database_file: DATABASE_FILE,
    log_file: logFile,
    cancel_file: cancelFile,
    command,
    args,
    env: startJobEnvironment(kind, id, env),
    cwd,
    timeout_seconds: timeoutSeconds,
    deadline_at: deadlineAt,
    result_format: resultFormat,
    target_context: targetContext,
    patch_artifact: patchArtifact,
    redactions,
  });

  try {
    const runner = spawn(process.execPath, [RUNNER, specFile], {
      detached: true,
      env: process.env,
      stdio: 'ignore',
    });
    runner.unref();
  } catch (error) {
    terminalizeJob(database, id, 'failed', {
      finished_at: new Date().toISOString(),
      termination_reason: 'runner_spawn_failed',
      failure_class: 'process_failure',
      elapsed_seconds: 0,
      error: error instanceof Error ? error.message : String(error),
    }, { termination_reason: 'runner_spawn_failed' });
  }

  return getJob(id);
}

async function cancelJob(job) {
  job = await reconcile(job);
  if (FINAL_STATES.has(job.status)) return job;
  // Cancellation is a durable intent, not a process signal.  A job can be
  // accepted/started before the runner has recorded a child PID, and a stale
  // or replaced PID must not make the request disappear.  Persist the intent
  // first; ownership proof below gates only the best-effort signal.
  await writeFile(job.cancel_file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  updateJob(database, job.id, {
    status: 'cancelling',
    updated_at: new Date().toISOString(),
    termination_reason: 'cancel_requested',
    error: 'Cancellation requested; waiting for the managed process to exit.',
  });

  if (!(await isOwned(job))) return getJob(job.id);

  let termSignalSent = false;
  try {
    process.kill(-job.child_pid, 'SIGTERM');
    termSignalSent = true;
    updateJob(database, job.id, { signal_sent: 'SIGTERM' });
  } catch {}
  await sleep(1200);
  if (termSignalSent && await isOwned(job)) {
    try {
      process.kill(-job.child_pid, 'SIGKILL');
      updateJob(database, job.id, { signal_sent: 'SIGKILL', forced_kill: 1 });
    } catch {}
  }
  await sleep(150);
  return getJob(job.id);
}

async function activeWebJob() {
  const jobs = await listActiveJobs();
  return jobs.find((job) => job.kind === 'dsh_web' && ACTIVE_STATES.has(job.status)) ?? null;
}

async function statusTool(args) {
  const recentLimit = clampInteger(args.recent_limit, 5, 0, 15, 'recent_limit');
  const jobs = await listJobs(Math.max(recentLimit, 15));
  const activeJobs = await listActiveJobs();
  const web = activeJobs.find((job) => job.kind === 'dsh_web' && ACTIVE_STATES.has(job.status));
  const listening = await portOpen();
  const detectedVersions = versions();
  const grokStatus = grokVersionProbe(GROK, PLUGIN_ROOT, grokEnvironment());
  const deepseekStatus = deepseekReadiness();
  // The default path deliberately avoids a provider request.  When the
  // caller explicitly asks for diagnostics, use that bounded read-only probe
  // as the source of truth for the summary returned in this same response.
  const grokDiagnostic = args.diagnostics === true ? grokAuthDoctor() : null;
  const deepseekConfigured = detectedVersions.compatible.deepseek_harness;
  const deepseekReady = deepseekConfigured && deepseekStatus.ok;
  const deepseekCapabilities = deepseekReady ? dshCapabilities(deepseekStatus) : null;
  const uiState = web && listening ? 'running' : listening ? 'occupied_unmanaged' : web ? web.status : 'stopped';
  const result = {
    ok: true,
    integration: 'control-only',
    control_plane: { health: 'healthy', version: PLUGIN_VERSION, transport: 'unix_socket', ledger: 'sqlite_wal' },
    headless_agent: {
      availability: deepseekReady ? 'available' : 'unavailable',
      configured: deepseekConfigured && deepseekStatus.configured,
      usable: deepseekReady,
      kind: 'deepseek_agent',
      version_compatible: detectedVersions.compatible.deepseek_harness,
      readiness_reason: deepseekReady ? null : deepseekStatus.reason,
      readiness_detail: deepseekReady ? null : deepseekStatus.detail,
      dsh_home: deepseekStatus.home,
      dsh_home_source: deepseekStatus.source,
      profile: deepseekStatus.profile,
      capability_state: deepseekCapabilities ? 'verified-managed-overlay' : 'unknown',
      capability_note: deepseekCapabilities
        ? null
        : 'Capabilities are reported only for the verified Co-Engineer managed headless overlay; custom or unavailable profiles remain unknown.',
      ...(deepseekCapabilities ? { capabilities: deepseekCapabilities } : {}),
    },
    grok_build: {
      kind: 'grok_build',
      availability: grokStatus.executable_state === 'missing'
        ? 'missing'
        : grokStatus.executable_state === 'installed'
          ? 'installed'
          : 'unavailable',
      executable: GROK,
      version: grokStatus.version,
      executable_state: grokStatus.executable_state,
      sandbox: {
        managed_by: 'grok_cli',
        requested_profile: 'read-only_for_review_verify',
        enforcement: 'fallback_warning_fail_closed_runner_postflight',
        writable_builtin_roots: 'rejected_for_review_verify',
      },
      capabilities: grokCapabilityProfile(),
      auth_state: grokDiagnostic?.auth_state ?? 'unknown',
      ready: grokDiagnostic?.ok === true && grokDiagnostic.auth_state === 'ready',
      auth_note: grokDiagnostic?.note ?? (grokStatus.executable_state === 'missing'
        ? 'Install the official Grok Build CLI and authenticate it with `grok login` (or provide XAI_API_KEY) before dispatch.'
        : 'Auth remains unknown in the default status path; call status with diagnostics=true to run the documented read-only `grok models` probe. Status never opens a browser or starts a coding request.'),
      api_key_available: Boolean(process.env.XAI_API_KEY),
    },
    targeting: {
      mode: configuredTargetRoots() ? 'administrator-allowlisted' : 'explicit-target-any-git-root',
      administrator_roots_configured: Boolean(configuredTargetRoots()),
      warning: configuredTargetRoots()
        ? null
        : 'Explicit target_context is required for non-default checkouts; administrator roots are unrestricted unless CODEX_CO_ENGINEER_ALLOWED_ROOTS is set.',
      default_workspace: WORKSPACE,
      implement_targets: 'explicit-scoped-workspace',
    },
    ui: {
      optional: true,
      state: uiState,
      url: `http://${WEB_HOST}:${WEB_PORT}`,
      managed_job: web?.id ?? null,
    },
    // Keep the old field for clients that have not adopted the explicit UI section.
    runtime: {
      state: uiState,
      url: `http://${WEB_HOST}:${WEB_PORT}`,
      managed_job: web?.id ?? null,
      optional: true,
    },
    credentials: { model_api_key_available: Boolean(process.env.MODEL_API_KEY) },
    credential_setup: { protected_file: MODEL_API_KEY_FILE },
    workspace: {
      path: WORKSPACE,
      deepseek_configured: deepseekReady,
      deepseek_executable_compatible: deepseekConfigured,
      dsh_command: DSH,
      dsh_home: deepseekStatus.home,
      dsh_home_configured: deepseekStatus.configured,
      dsh_home_source: deepseekStatus.source,
      dsh_profile: deepseekStatus.profile,
      dsh_ready: deepseekReady,
      grok_command: GROK,
    },
    versions: detectedVersions,
    jobs: {
      active: activeJobs.length,
      recent: jobs.slice(0, recentLimit).map(compactJob),
    },
  };
  if (grokDiagnostic) {
    result.diagnostics = {
      grok_build: grokDiagnostic,
    };
  }
  return result;
}

async function capacityTool(args) {
  try {
    return await readProductionCapacity(args);
  } catch (error) {
    if (error instanceof CapacityError) {
      throw new ToolError(error.code, error.message);
    }
    throw error;
  }
}

function isTerminalDshJob(job) {
  return job?.kind === 'deepseek_agent'
    && (FINAL_STATES.has(job?.status) || FINAL_STATES.has(job?.lifecycle_state)
      || FINAL_STATES.has(job?.terminal_state));
}

/**
 * Jobs get may include a compact terminal DSH usage snapshot.  Keep this off
 * list/status/wait/logs: routine lifecycle surfaces must not read receipts or
 * reveal provider usage metadata.  The capacity reader strips paths and raw
 * provider fields, and its error shape is a bounded code only.
 */
async function terminalDshUsage(job) {
  if (!isTerminalDshJob(job)) return null;
  const result = await readProductionCapacity({
    providers: ['dsh'],
    dsh_job_id: job.id,
    include_usage: true,
    refresh: true,
    max_age_seconds: 60,
  });
  const entry = result.providers?.[0];
  if (!entry) return { status: 'unavailable', error: { code: 'capacity_query_failed' } };
  return {
    status: entry.status,
    observed_at: entry.observed_at ?? null,
    freshness: entry.freshness ?? { state: 'unknown', age_seconds: null },
    usage: entry.usage ?? null,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function grokAuthDoctor() {
  const executable = grokVersionProbe(GROK, PLUGIN_ROOT, grokEnvironment());
  if (executable.executable_state === 'missing') {
    return {
      ok: false,
      auth_state: 'unavailable',
      executable_state: 'missing',
      note: 'Install the official Grok Build CLI before checking authentication.',
    };
  }
  // `grok models` is the CLI's documented non-mutating availability/auth
  // probe. It may perform a read-only provider request, but it never starts a
  // coding session or invokes browser/device login.
  const result = spawnSync(GROK, ['models'], {
    cwd: PLUGIN_ROOT,
    env: grokEnvironment(),
    encoding: 'utf8',
    timeout: 15000,
  });
  const output = redactLog(concise(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, 240));
  const unauthenticated = /(?:login|auth|credential|unauthori[sz]ed|token)/i.test(output);
  return {
    ok: result.status === 0 && !unauthenticated,
    auth_state: unauthenticated ? 'unauthenticated' : result.status === 0 ? 'ready' : 'unknown',
    executable_state: executable.executable_state,
    exit_code: result.status,
    detail: output || null,
    note: result.status === 0 && !unauthenticated
      ? 'The official Grok models probe completed without starting a coding task.'
      : unauthenticated
        ? 'Authenticate with `grok login` or provide XAI_API_KEY; status never opens a browser.'
        : 'Authentication could not be determined without starting a coding request.',
  };
}

function dshWebPermissionMode(role) {
  if (role === 'implement') return 'workspace-write';
  if (role === 'review' || role === 'verify') return 'read-only';
  throw new ToolError('invalid_target_context', 'dsh_web requires a review, verify, or implement target role.');
}

async function runtimeTool(args) {
  if (args.action === 'start') {
    if (args.schema_version !== CONFIG_SCHEMA_VERSION) {
      throw new ToolError('invalid_configuration', `schema_version must be ${CONFIG_SCHEMA_VERSION}.`);
    }
    const timeoutSeconds = clampInteger(args.timeout_seconds, 3600, 60, 21600, 'timeout_seconds');
    const expectedFingerprint = expectedTargetFingerprint(args.expected_target_fingerprint);
    const { cwd, target, targetFingerprint } = await prepareTarget(args.target_context);
    assertTargetFingerprint(expectedFingerprint, targetFingerprint);
    requireDeepSeekReady();
    const managed = await activeWebJob();
    const listening = await portOpen();
    if (managed && listening) return { ok: true, already_running: true, job: publicJob(managed) };
    return startAgentJob({
      working_directory: cwd,
      expected_git_root: target.expected_git_root,
      git_common_directory: target.git_common_directory,
    }, async () => {
      // Re-check the global UI/port state after acquiring the same execution
      // lock used by headless agent jobs.  A concurrent runtime start either
      // reuses its managed listener or fails closed; it never races a second
      // DSH web process into the same workspace/port.
      const currentManaged = await activeWebJob();
      const currentListening = await portOpen();
      if (currentManaged && currentListening) {
        return { ok: true, already_running: true, job: publicJob(currentManaged) };
      }
      if (currentManaged) {
        throw new ToolError('workspace_busy', `A managed DSH web runtime is already active: ${currentManaged.id}`);
      }
      if (currentListening) {
        throw new ToolError('port_occupied', `Port ${WEB_PORT} is occupied by an unmanaged process.`);
      }
      requireDeepSeekReady();
      const runtimeDshConfiguration = normalizeDshForTool(undefined);
      const permissionMode = dshWebPermissionMode(target.role);
      let runtimeLock;
      let runtimeLockPromoted = false;
      try {
        // The fixed web port is a process-wide resource. The SQLite job query
        // and in-memory submission tail are useful diagnostics, but only this
        // owner-only O_EXCL lock closes the cross-process start race.
        runtimeLock = await acquireWebRuntimeLock();
        const job = await startJob({
          kind: 'dsh_web',
          summary: 'DeepSeek Harness web UI',
          command: DSH,
          args: [
            '--profile', 'web',
            ...(DSH_PATCH_FILE ? ['--patch', DSH_PATCH_FILE] : []),
            '--host', WEB_HOST,
            '--port', String(WEB_PORT),
          ],
          env: {
            ...dshWorkerEnvironment(runtimeDshConfiguration),
            DSH_PERMISSION_MODE: permissionMode,
          },
          url: `http://${WEB_HOST}:${WEB_PORT}`,
          timeoutSeconds,
          cwd,
          targetContext: target,
          effectiveConfiguration: (() => {
            const configuration = {
              schema_version: CONFIG_SCHEMA_VERSION,
              kind: 'dsh_web',
              timeout_seconds: timeoutSeconds,
              working_directory: cwd,
              target_fingerprint: targetFingerprint,
              target_context: target,
              role: target.role,
              permission_mode: permissionMode,
            };
            configuration.configuration_digest = sha256Digest(configuration);
            return configuration;
          })(),
        });
        await promoteWebRuntimeLock(runtimeLock, job.id);
        runtimeLockPromoted = true;
        for (let attempt = 0; attempt < 20 && !(await portOpen()); attempt += 1) await sleep(100);
        const currentJob = await getJob(job.id);
        // A provider that exits during startup must not leave an owner-only
        // lock behind. Keep the lock for a still-running slow startup so a
        // concurrent caller cannot launch a second listener.
        if (!await portOpen() && FINAL_STATES.has(currentJob.status)) {
          await releaseWebRuntimeLock(runtimeLock);
          runtimeLock = null;
          runtimeLockPromoted = false;
        }
        return { ok: true, job: publicJob(currentJob), listening: await portOpen() };
      } finally {
        if (runtimeLock && !runtimeLockPromoted) await releaseWebRuntimeLock(runtimeLock).catch(() => {});
      }
    }, { ignoreJobIds: managed ? [managed.id] : [] });
  }
  if (args.action === 'stop') {
    const managed = await activeWebJob();
    if (!managed) {
      if (await portOpen()) throw new ToolError('unmanaged_runtime', 'The listener is not plugin-owned and will not be stopped.');
      return { ok: true, already_stopped: true };
    }
    return { ok: true, job: publicJob(await cancelJob(managed)) };
  }
  throw new ToolError('invalid_action', 'runtime.action must be start or stop.');
}

function requireCredential() {
  if (!process.env.MODEL_API_KEY) {
    throw new ToolError('missing_credential', 'MODEL_API_KEY is not available to the plugin process.');
  }
}

function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new ToolError('invalid_request_id', 'request_id must be 8 to 128 letters, digits, dots, colons, underscores, or hyphens.');
  }
  return value;
}

function requestFingerprint(value) {
  return sha256Digest(value);
}

function expectedTargetFingerprint(value) {
  const normalized = normalizeDigest(value);
  if (!normalized) {
    throw new ToolError(
      'invalid_target_fingerprint',
      'expected_target_fingerprint must be a SHA-256 digest (64 hexadecimal characters, optionally prefixed with sha256:).',
    );
  }
  return normalized;
}

function assertTargetFingerprint(expected, actual) {
  if (expected !== actual) {
    throw new ToolError(
      'target_fingerprint_mismatch',
      'The resolved target fingerprint does not match the caller-supplied expected fingerprint; refusing dispatch.',
    );
  }
}

function bindTarget(args, targetFingerprint) {
  const binding = args.target_binding ?? 'caller';
  if (binding !== 'caller' && binding !== 'control_plane') {
    throw new ToolError('invalid_target_binding', 'target_binding must be control_plane when supplied.');
  }
  if (binding === 'control_plane') {
    // Supplying an assertion alongside the explicit control-plane binding is
    // allowed and still checked; omitting it is the convenience path.
    if (Object.hasOwn(args, 'expected_target_fingerprint')) {
      assertTargetFingerprint(expectedTargetFingerprint(args.expected_target_fingerprint), targetFingerprint);
    }
    return { expected: targetFingerprint, source: 'control_plane' };
  }
  const expected = expectedTargetFingerprint(args.expected_target_fingerprint);
  assertTargetFingerprint(expected, targetFingerprint);
  return { expected, source: 'caller' };
}

async function findRequest(id, fingerprint) {
  await ensureState();
  const existing = findStoredRequest(database, id);
  if (!existing) return null;
  if (existing.request_fingerprint !== fingerprint) {
    throw new ToolError('request_id_conflict', 'request_id was already used with different inputs.');
  }
  return existing;
}

function rejectUnsupportedRunFields(args, allowed, kind) {
  for (const field of Object.keys(args)) {
    if (!allowed.has(field)) {
      throw new ToolError(
        'invalid_argument',
        `${field} is not supported for run.kind=${kind}; use the kind-specific fields shown in the tool schema.`,
      );
    }
  }
}

function promptMetadata(prompt) {
  return {
    prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
    prompt_characters: prompt.length,
  };
}

function targetPreamble(target) {
  if (!target) return '';
  const instructions = target.role === 'implement'
    ? 'You may modify files only under the allowed paths for this implementation run. Do not change the Git root or checkout HEAD.'
    : `Do not modify files during this ${target.role} run.`;
  return [
    'The connector will enforce this target contract before and after execution.',
    `Working directory: ${target.working_directory}`,
    `Expected Git root: ${target.expected_git_root}`,
    `Expected HEAD: ${target.expected_head}`,
    `Allowed paths: ${target.allowed_paths.join(', ')}`,
    `Operation role: ${target.role}. ${instructions}`,
  ].join('\n');
}

function agentConfiguration({
  kind,
  id,
  prompt,
  timeoutSeconds,
  cwd,
  target,
  targetBinding = 'caller',
  dshConfiguration = null,
  grokConfiguration = null,
}) {
  const configuration = {
    schema_version: CONFIG_SCHEMA_VERSION,
    kind,
    request_id: id,
    ...promptMetadata(prompt),
    timeout_seconds: timeoutSeconds,
    timeout_range_seconds: {
      minimum: 60,
      maximum: 21600,
      default: 3600,
    },
    working_directory: cwd,
    target_fingerprint: target?.target_fingerprint ?? null,
    target_binding: targetBinding,
    targeting_mode: target
      ? target.target_origin === 'control_plane_staged'
        ? 'control-plane-staged'
        : target.mode === 'default'
        ? 'explicit-default-workspace'
        : (configuredTargetRoots() ? 'administrator-allowlisted' : 'explicit-target-any-git-root')
      : 'default-workspace',
    target_execution_scope: target
      ? {
        git_root: target.expected_git_root,
        git_common_directory: target.git_common_directory,
      }
      : null,
    permission_mode: target?.role === 'implement'
      ? 'workspace-write-scoped'
      : target
        ? 'read-only-process-contract'
        : 'workspace-write',
    target_context: target,
    ...(kind === 'deepseek_agent' && dshConfiguration
      ? { dsh_configuration: dshConfiguration }
      : {}),
    ...(kind === 'grok_build' ? { grok_configuration: grokConfiguration } : {}),
  };
  configuration.configuration_digest = sha256Digest(configuration);
  return configuration;
}

const GROK_CONFIGURATION_FIELDS = new Set([
  'model',
  'agent',
  'delegation',
  'output_format',
  'json_schema',
  'verbatim',
  'include_partial_messages',
  'session_id',
  'resume',
  'continue_session',
  'reasoning_effort',
  'max_turns',
  'sandbox_profile',
  'permission_mode',
  'rules',
  'allowed_tools',
  'disallowed_tools',
  'allow_rules',
  'deny_rules',
  'always_approve',
  'no_auto_update',
  'no_plan',
  'no_subagents',
  'no_memory',
  'disable_web_search',
  'experimental_memory',
  'fork_session',
]);
const DSH_CONFIGURATION_FIELDS = new Set(['dsh_options']);

function grokInput(args) {
  return Object.fromEntries([...GROK_CONFIGURATION_FIELDS]
    .filter((field) => Object.hasOwn(args, field))
    .map((field) => [field, args[field]]));
}

function normalizeGrokForTool(args, role) {
  try {
    return normalizeGrokConfiguration(grokInput(args), role);
  } catch (error) {
    if (error?.code === 'invalid_grok_configuration') {
      throw new ToolError(error.code, error.message);
    }
    throw error;
  }
}

function preflightAllowedFields(args) {
  const allowed = new Set([
    'schema_version',
    'kind',
    'request_id',
    'prompt',
    'timeout_seconds',
    'target_context',
    'expected_target_fingerprint',
    'target_binding',
    ...DSH_CONFIGURATION_FIELDS,
    ...GROK_CONFIGURATION_FIELDS,
  ]);
  for (const field of Object.keys(args)) {
    if (!allowed.has(field)) {
      throw new ToolError('invalid_argument', `preflight.${field} is not supported.`);
    }
  }
}

async function preflightTool(args) {
  preflightAllowedFields(args);
  if (args.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new ToolError('invalid_configuration', `schema_version must be ${CONFIG_SCHEMA_VERSION}.`);
  }
  if (!Object.hasOwn(args, 'target_context')) {
    throw new ToolError('missing_target_context', 'preflight requires a versioned target_context; use mode=default to select the configured workspace.');
  }
  const { cwd, target, targetFingerprint } = await prepareTarget(args.target_context);
  const binding = bindTarget(args, targetFingerprint);

  let kind = args.kind ?? 'preflight';
  if (kind !== 'preflight' && !['deepseek_agent', 'grok_build'].includes(kind)) {
    throw new ToolError('invalid_kind', 'preflight.kind must be deepseek_agent or grok_build.');
  }
  const commonFields = new Set(['schema_version', 'kind', 'request_id', 'prompt', 'timeout_seconds', 'target_context', 'expected_target_fingerprint', 'target_binding']);
  const kindFields = kind === 'grok_build'
    ? GROK_CONFIGURATION_FIELDS
    : kind === 'deepseek_agent'
      ? DSH_CONFIGURATION_FIELDS
      : new Set();
  for (const field of Object.keys(args)) {
    if (!commonFields.has(field) && !kindFields.has(field)) {
      throw new ToolError('invalid_argument', `preflight.${field} is not supported for kind=${kind}.`);
    }
  }
  if (args.prompt !== undefined
    && (typeof args.prompt !== 'string' || args.prompt.trim().length < 1 || args.prompt.length > 12000
      || /[\u0000\u007f]/.test(args.prompt))) {
    throw new ToolError('invalid_prompt', 'prompt must contain 1 to 12000 text characters without NUL or DEL controls.');
  }
  let dshReadiness = null;
  if (kind === 'deepseek_agent') dshReadiness = requireDeepSeekReady();
  if (args.request_id !== undefined) requestId(args.request_id);
  const configuration = {
    schema_version: CONFIG_SCHEMA_VERSION,
    kind,
    request_id: args.request_id ?? null,
    ...(args.prompt === undefined ? {} : promptMetadata(args.prompt)),
    ...(args.timeout_seconds === undefined
      ? { timeout_seconds: 3600 }
      : { timeout_seconds: clampInteger(args.timeout_seconds, 3600, 60, 21600, 'timeout_seconds') }),
    working_directory: cwd,
    target_fingerprint: targetFingerprint,
    target_binding: binding.source,
    target_context: target,
  };
  let grokCapabilities = null;
  let deepseekCapabilities = null;
  if (kind === 'deepseek_agent') {
    const dshConfiguration = normalizeDshForTool(args.dsh_options);
    if (dshConfiguration) configuration.dsh_configuration = dshConfiguration;
    deepseekCapabilities = dshCapabilities(dshReadiness, dshConfiguration ?? {});
  }
  if (kind === 'grok_build') {
    configuration.grok_configuration = normalizeGrokForTool(args, target.role);
    assertGrokReadOnlyTarget(target);
    grokCapabilities = grokCapabilityProfile(grokInput(args), target.role);
  }
  configuration.configuration_digest = sha256Digest(configuration);
  return {
    ok: true,
    schema_version: CONFIG_SCHEMA_VERSION,
    target_fingerprint: targetFingerprint,
    expected_target_fingerprint: binding.expected,
    target_binding: binding.source,
    target_match: true,
    resolved_workspace: target.resolved_workspace,
    resolved_cwd: target.resolved_cwd,
    configuration_digest: configuration.configuration_digest,
    transport: 'stdio',
    protocol_version: null,
    server_identity: SERVER_IDENTITY,
    available_tools: null,
    configuration,
    ...(deepseekCapabilities
      ? { capabilities: { deepseek_agent: deepseekCapabilities } }
      : grokCapabilities
        ? { capabilities: { grok_build: grokCapabilities } }
        : {}),
  };
}

async function runTool(args) {
  if (args.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new ToolError('invalid_configuration', `schema_version must be ${CONFIG_SCHEMA_VERSION}.`);
  }
  const supportedKinds = new Set(['deepseek_agent', 'grok_build']);
  if (!supportedKinds.has(args.kind)) {
    throw new ToolError('invalid_kind', 'run.kind must be deepseek_agent or grok_build.');
  }
  const id = requestId(args.request_id);
  const timeoutSeconds = clampInteger(args.timeout_seconds, 3600, 60, 21600, 'timeout_seconds');
  if (args.kind === 'grok_build') {
    const allowed = new Set([
      'schema_version',
      'kind',
      'request_id',
      'prompt',
      'timeout_seconds',
      'target_context',
      'expected_target_fingerprint',
      'target_binding',
      ...GROK_CONFIGURATION_FIELDS,
    ]);
    rejectUnsupportedRunFields(args, allowed, args.kind);
    if (typeof args.prompt !== 'string' || args.prompt.trim().length < 1 || args.prompt.length > 12000
      || /[\u0000\u007f]/.test(args.prompt)) {
      throw new ToolError('invalid_prompt', 'prompt must contain 1 to 12000 characters without NUL or DEL control characters.');
    }
    if (!Object.hasOwn(args, 'target_context')) {
      throw new ToolError('missing_target_context', 'run requires an explicit versioned target_context; use mode=default to select the configured workspace.');
    }
    const { cwd, target, targetFingerprint } = await prepareTarget(args.target_context);
    const binding = bindTarget(args, targetFingerprint);
    const grokConfiguration = normalizeGrokForTool(args, target.role);
    assertGrokReadOnlyTarget(target);
    const grokCapabilities = grokCapabilityProfile(grokInput(args), target.role);
    const effectiveConfiguration = agentConfiguration({
      kind: args.kind,
      id,
      prompt: args.prompt,
      timeoutSeconds,
      cwd,
      target,
      targetBinding: binding.source,
      grokConfiguration,
    });
    const fingerprint = requestFingerprint({
      kind: args.kind,
      prompt: args.prompt,
      effective_configuration: effectiveConfiguration,
    });
    const existing = await findRequest(id, fingerprint);
    if (existing) {
      return {
        ok: true,
        deduplicated: true,
        job: publicJob(existing),
        capabilities: { grok_build: grokCapabilities },
      };
    }
    const activeTask = [
      'This is the active user task. Complete it now; do not treat it as setup or a request for another task.',
      targetPreamble(target),
      '',
      args.prompt,
    ].join('\n');
    const grokArgs = buildGrokArgs({
      prompt: activeTask,
      cwd,
      configuration: grokConfiguration,
    });
    const job = await startAgentJob({
      working_directory: cwd,
      expected_git_root: target?.expected_git_root ?? null,
      git_common_directory: target?.git_common_directory ?? null,
    }, () => startJob({
      kind: 'grok_build',
      summary: `Grok Build task ${id}`,
      command: GROK,
      args: grokArgs,
      requestId: id,
      requestFingerprint: fingerprint,
      timeoutSeconds,
      resultFormat: grokConfiguration.output_format === 'streaming-json'
        ? 'grok_streaming_json'
        : grokConfiguration.output_format === 'streaming-messages-json'
          ? 'grok_streaming_json'
          : grokConfiguration.output_format === 'json'
            ? 'grok_json'
            : null,
      cwd,
      targetContext: target,
      effectiveConfiguration,
      redactions: [args.prompt, activeTask],
    }));
    return {
      ok: true,
      job: publicJob(job),
      effective_configuration: effectiveConfiguration,
      capabilities: { grok_build: grokCapabilities },
      next: 'Use jobs action=wait with until=terminal, or jobs action=logs for cursor pages.',
    };
  }
  if (args.kind === 'deepseek_agent') {
    const allowed = new Set([
      'schema_version',
      'kind',
      'request_id',
      'prompt',
      'timeout_seconds',
      'target_context',
      'expected_target_fingerprint',
      'target_binding',
      'dsh_options',
    ]);
    rejectUnsupportedRunFields(args, allowed, args.kind);
    if (typeof args.prompt !== 'string' || args.prompt.trim().length < 1 || args.prompt.length > 12000
      || /[\u0000\u007f]/.test(args.prompt)) {
      throw new ToolError('invalid_prompt', 'prompt must contain 1 to 12000 text characters without NUL or DEL controls.');
    }
    if (!Object.hasOwn(args, 'target_context')) {
      throw new ToolError('missing_target_context', 'run requires an explicit versioned target_context; use mode=default to select the configured workspace.');
    }
    const { cwd, target, targetFingerprint } = await prepareTarget(args.target_context);
    const binding = bindTarget(args, targetFingerprint);
    const dshConfiguration = normalizeDshForTool(args.dsh_options);
    const deepseekCapabilities = dshConfiguration
      ? dshCapabilityProfile(dshConfiguration)
      : null;
    const effectiveConfiguration = agentConfiguration({
      kind: args.kind,
      id,
      prompt: args.prompt,
      timeoutSeconds,
      cwd,
      target,
      targetBinding: binding.source,
      dshConfiguration,
    });
    const fingerprint = requestFingerprint({
      kind: args.kind,
      prompt: args.prompt,
      effective_configuration: effectiveConfiguration,
    });
    const existing = await findRequest(id, fingerprint);
    if (existing) {
      return {
        ok: true,
        deduplicated: true,
        job: publicJob(existing),
        ...(deepseekCapabilities
          ? { capabilities: { deepseek_agent: deepseekCapabilities } }
          : {}),
      };
    }
    requireCredential();
    requireDeepSeekReady();
    const activeTask = [
      'This is the active user task. Complete it now; do not treat it as setup or a request for another task.',
      targetPreamble(target),
      '',
      args.prompt,
    ].join('\n');
    const job = await startAgentJob({
      working_directory: cwd,
      expected_git_root: target?.expected_git_root ?? null,
      git_common_directory: target?.git_common_directory ?? null,
    }, () => {
      requireDeepSeekReady();
      return startJob({
        kind: 'deepseek_agent',
        summary: `DeepSeek task ${id}`,
        command: DSH,
        args: [
          '--profile', 'headless',
          ...(DSH_PATCH_FILE ? ['--patch', DSH_PATCH_FILE] : []),
          activeTask,
        ],
        env: {
          ...dshWorkerEnvironment(dshConfiguration),
          DSH_PERMISSION_MODE: target.role === 'implement' ? 'workspace-write' : 'read-only',
        },
        requestId: id,
        requestFingerprint: fingerprint,
        timeoutSeconds,
        cwd,
        targetContext: target,
        effectiveConfiguration,
        redactions: [args.prompt],
      });
    });
    return {
      ok: true,
      job: publicJob(job),
      effective_configuration: effectiveConfiguration,
      ...(deepseekCapabilities
        ? { capabilities: { deepseek_agent: deepseekCapabilities } }
        : {}),
      next: 'Use jobs action=wait with until=terminal, or jobs action=logs for cursor pages.',
    };
  }
}

async function waitForJob(job, seconds, until, afterCursor = null) {
  const initialStatus = job.status;
  const initialUpdated = job.updated_at;
  const initialSize = await logBytes(job.log_file);
  const baselineCursor = afterCursor ?? initialSize;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(500);
    const current = await getJob(job.id);
    const size = await logBytes(current.log_file);
    const changed = current.status !== initialStatus
      || current.updated_at !== initialUpdated
      || size !== initialSize;
    if (until === 'terminal' && FINAL_STATES.has(current.status)) return current;
    if (until === 'change' && (changed || size > baselineCursor)) return current;
  }
  return getJob(job.id);
}

async function jobsTool(args) {
  if (args.action === 'list') {
    const limit = clampInteger(args.limit, WAIT_LIMITS.list_limit.default, WAIT_LIMITS.list_limit.minimum, WAIT_LIMITS.list_limit.maximum, 'limit');
    return {
      ok: true,
      limits: WAIT_LIMITS,
      jobs: (await listJobs(limit)).map(compactJob),
    };
  }
  if (!['get', 'wait', 'logs'].includes(args.action)) {
    throw new ToolError('invalid_action', 'jobs.action must be list, get, wait, or logs.');
  }
  if (!args.job_id) throw new ToolError('missing_job_id', 'job_id is required for get and wait.');
  // Validate all wait/tail/cursor controls before the first polling sleep.
  const lines = clampInteger(
    args.tail_lines,
    WAIT_LIMITS.tail_lines.default,
    WAIT_LIMITS.tail_lines.minimum,
    WAIT_LIMITS.tail_lines.maximum,
    'tail_lines',
  );
  const afterCursor = parseCursor(args.after_cursor);
  const until = args.until ?? 'change';
  if (!['change', 'terminal'].includes(until)) {
    throw new ToolError('invalid_until', 'until must be change or terminal.');
  }
  const seconds = args.action === 'wait'
    ? clampInteger(
      args.wait_seconds,
      WAIT_LIMITS.wait_seconds.default,
      WAIT_LIMITS.wait_seconds.minimum,
      WAIT_LIMITS.wait_seconds.maximum,
      'wait_seconds',
    )
    : null;
  const pageBytes = args.action === 'logs'
    ? clampInteger(
      args.limit_bytes,
      WAIT_LIMITS.log_page_bytes.default,
      WAIT_LIMITS.log_page_bytes.minimum,
      WAIT_LIMITS.log_page_bytes.maximum,
      'limit_bytes',
    )
    : null;
  let job = await getJob(args.job_id);
  if (args.action === 'logs') {
    const log = await readLogPage(job.log_file, afterCursor ?? 0, pageBytes);
    return {
      ok: true,
      limits: WAIT_LIMITS,
      job: publicJob(job),
      log,
    };
  }
  if (args.action === 'wait') {
    if (!FINAL_STATES.has(job.status)) job = await waitForJob(job, seconds, until, afterCursor);
  }
  const tail = lines > 0
    ? await tailLog(job.log_file, lines)
    : { text: '', truncated: false };
  const logDelta = afterCursor === null
    ? null
    : await readLogPage(job.log_file, afterCursor, LOG_PAGE_MAX_BYTES);
  const currentLogBytes = await logBytes(job.log_file);
  const response = {
    ok: true,
    limits: WAIT_LIMITS,
    effective_parameters: {
      tail_lines: lines,
      wait_seconds: seconds,
      until: args.action === 'wait' ? until : null,
      after_cursor: afterCursor === null ? null : String(afterCursor),
    },
    job: publicJob(job),
    log_tail: tail.text,
    log_tail_truncated: tail.truncated,
    next_cursor: String(currentLogBytes),
    log_delta: logDelta,
  };
  if (args.action === 'get') {
    const finalResponse = await terminalGrokResponse(job);
    if (finalResponse) response.final_response = finalResponse;
    const usage = await terminalDshUsage(job);
    if (usage) response.dsh_usage = usage;
  }
  return response;
}

async function cancelTool(args) {
  if (!args.job_id) throw new ToolError('missing_job_id', 'job_id is required.');
  return { ok: true, job: publicJob(await cancelJob(await getJob(args.job_id))) };
}

function rejectUnknownToolFields(args, allowed, toolName) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('invalid_argument', `${toolName} arguments must be an object.`);
  }
  for (const field of Object.keys(args)) {
    if (!allowed.has(field)) {
      throw new ToolError('invalid_argument', `${toolName}.${field} is not supported.`);
    }
  }
}

function validateToolArguments(name, args) {
  if (name === 'preflight' || name === 'run') return;
  if (name === 'status') {
    rejectUnknownToolFields(args, new Set(['recent_limit', 'diagnostics']), name);
    return;
  }
  if (name === 'capacity') {
    rejectUnknownToolFields(args, new Set([
      'providers',
      'refresh',
      'max_age_seconds',
      'include_usage',
      'grok_session_id',
      'dsh_job_id',
    ]), name);
    return;
  }
  if (name === 'runtime') {
    const allowed = args?.action === 'start'
      ? new Set(['action', 'schema_version', 'timeout_seconds', 'target_context', 'expected_target_fingerprint'])
      : new Set(['action']);
    rejectUnknownToolFields(args, allowed, name);
    return;
  }
  if (name === 'cancel') {
    rejectUnknownToolFields(args, new Set(['job_id']), name);
    return;
  }
  if (name === 'jobs') {
    const byAction = {
      list: new Set(['action', 'limit']),
      get: new Set(['action', 'job_id', 'tail_lines', 'after_cursor']),
      wait: new Set(['action', 'job_id', 'tail_lines', 'wait_seconds', 'until', 'after_cursor']),
      logs: new Set(['action', 'job_id', 'after_cursor', 'limit_bytes']),
    };
    rejectUnknownToolFields(args, byAction[args?.action] ?? new Set(['action']), name);
  }
}



export async function dispatchControl(name, args = {}) {
  validateToolArguments(name, args);
  if (name === 'status') return statusTool(args);
  if (name === 'capacity') return capacityTool(args);
  if (name === 'runtime') return runtimeTool(args);
  if (name === 'preflight') return preflightTool(args);
  if (name === 'run') return runTool(args);
  if (name === 'jobs') return jobsTool(args);
  if (name === 'cancel') return cancelTool(args);
  throw new ToolError('unknown_tool', `Unknown tool: ${name}`);
}

export const __testing = Object.freeze({
  configuredTargetRoots,
  dshWebPermissionMode,
  executionScopesOverlap,
  deepseekReadiness,
  getProductionCapacityReader,
  listActiveJobs,
  readWebRuntimeLock,
  acquireWebRuntimeLock,
  releaseWebRuntimeLock,
  runStageGit,
  assertStageSize,
  resolveGithubRef,
  resolveLocalRef,
  prepareTarget,
  assertGrokReadOnlyTarget,
  startAgentJob,
  startJobEnvironment,
});

export { ToolError };
