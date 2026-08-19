#!/usr/bin/env node

/*
 * The local Cursor Agent adapter is intentionally a separate MCP server from
 * the Cloud Agents control plane.  It invokes one administrator-selected
 * executable, keeps a different ledger, and never accepts Cloud agent/run
 * identifiers.  The CLI is an external process: this module does not import
 * or share the Cloud API client, Cloud submission ledger, or Cloud receipts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { TextDecoder } from 'node:util';
import { redactError, redactText } from './redaction.mjs';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2024-11-05']);
export const SERVER_IDENTITY = Object.freeze({ name: 'cursor-local-control', version: '0.2.0' });

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_WAIT_MS = 1_000;
export const MAX_WAIT_MS = 30_000;
export const DEFAULT_MAX_EVENTS = 200;
export const MAX_EVENTS = 500;
export const DEFAULT_MAX_BYTES = 2_000_000;
export const MAX_BYTES = 5_000_000;
export const MAX_PROMPT_CHARS = 40_000;
export const MAX_MODEL_CHARS = 200;
export const MAX_WORKSPACE_CHARS = 4_096;
export const HOST_TRUSTED_RUNS_ENV = 'CURSOR_LOCAL_CLI_ENABLE_HOST_TRUSTED_RUNS';
export const LOCAL_RUN_ID_PATTERN = /^lrun-[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/ -]{0,255}$/;
const SAFE_EVENT_TYPE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_EVENT_LINE_BYTES = 256 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
// Request IDs/digests are durable tombstones.  Never evict the oldest 200 (or
// any other terminal subset): once this bounded reservation ledger or its
// byte budget is full, a new request fails closed before spawn.  The limit is
// deliberately high enough for normal local use while remaining finite.
export const MAX_LOCAL_LEDGER_RECORDS = 10_000;
const MAX_LEDGER_RECORDS = MAX_LOCAL_LEDGER_RECORDS;
const DEFAULT_LEDGER_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LEDGER_LOCK_STALE_MS = 30_000;
const DEFAULT_LEDGER_LOCK_POLL_MS = 25;
const MAX_LEDGER_LOCK_POLL_MS = 1_000;
const MAX_LEDGER_FILE_BYTES = 8 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW;
const DIRECTORY = constants.O_DIRECTORY;
const SAFE_CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';
const SANDBOX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class LocalInputError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LocalInputError';
    this.code = code;
    this.details = details;
  }
}

export class LocalRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LocalRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, details) {
  throw new LocalInputError('invalid_input', message, details);
}

function object(value, label = 'arguments') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function unknown(value, allowed, label = 'arguments') {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not supported.`);
}

function string(value, label, { min = 0, max = 1000, pattern, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${label} must be a string of ${min}-${max} characters.`);
  }
  if (value.includes('\u0000')) fail(`${label} must not contain NUL bytes.`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format.`);
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}

function absolutePath(value, label, { optional = false } = {}) {
  string(value, label, { min: 1, max: MAX_WORKSPACE_CHARS, optional });
  if (value !== undefined && !path.isAbsolute(value)) fail(`${label} must be an absolute path.`);
  return value;
}

function localRunId(value, label = 'arguments.localRunId', optional = false) {
  return string(value, label, { min: 1, max: 128, pattern: LOCAL_RUN_ID_PATTERN, optional });
}

function requestId(value, label = 'arguments.requestId') {
  return string(value, label, { min: 8, max: 128, pattern: REQUEST_ID_PATTERN, optional: true });
}

export const TOOL_SCHEMAS = Object.freeze({
  status: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['local', 'auth', 'permissions'], default: 'local' },
      workspace: { type: 'string', minLength: 1, maxLength: MAX_WORKSPACE_CHARS, pattern: '^/' },
    },
    additionalProperties: false,
  },
  run: {
    type: 'object',
    properties: {
      workspace: { type: 'string', minLength: 1, maxLength: MAX_WORKSPACE_CHARS, pattern: '^/' },
      prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS },
      mode: { type: 'string', enum: ['read_only', 'implement'] },
      execution_profile: { type: 'string', enum: ['host_trusted'] },
      model: { type: 'string', minLength: 1, maxLength: MAX_MODEL_CHARS },
      timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
      waitMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS },
      maxEvents: { type: 'integer', minimum: 1, maximum: MAX_EVENTS, default: DEFAULT_MAX_EVENTS },
      maxBytes: { type: 'integer', minimum: 1_024, maximum: MAX_BYTES, default: DEFAULT_MAX_BYTES },
      requestId: { type: 'string', minLength: 8, maxLength: 128, pattern: REQUEST_ID_PATTERN.source },
    },
    required: ['workspace', 'prompt', 'mode', 'execution_profile', 'requestId'],
    additionalProperties: false,
  },
  runs: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: { action: { const: 'get' }, localRunId: { type: 'string', pattern: LOCAL_RUN_ID_PATTERN.source } },
        required: ['action', 'localRunId'], additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: { const: 'logs' },
          localRunId: { type: 'string', pattern: LOCAL_RUN_ID_PATTERN.source },
          maxEvents: { type: 'integer', minimum: 1, maximum: MAX_EVENTS },
          maxBytes: { type: 'integer', minimum: 1_024, maximum: MAX_BYTES },
        },
        required: ['action', 'localRunId'], additionalProperties: false,
      },
      {
        type: 'object',
        properties: { action: { const: 'cancel' }, localRunId: { type: 'string', pattern: LOCAL_RUN_ID_PATTERN.source } },
        required: ['action', 'localRunId'], additionalProperties: false,
      },
    ],
  },
});

export const FOUNDATION_TOOLS = Object.freeze([
  {
    name: 'status',
    description: 'Inspect the local Cursor CLI binary, compact authentication state, or administrator-controlled permission config. Never returns credentials or account identity.',
    inputSchema: TOOL_SCHEMAS.status,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run',
    description: 'Start one bounded local Cursor CLI run in read_only or isolated-worktree implement mode. The target path must be administrator-allowlisted.',
    inputSchema: TOOL_SCHEMAS.run,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'runs',
    description: 'Get bounded local run state/logs or cancel one owned local process group. Local IDs and receipts never refer to Cloud Agents.',
    inputSchema: TOOL_SCHEMAS.runs,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
]);

// The public/default process-facing catalog is status-only. An administrator
// may explicitly opt into the host-trusted direct-CLI profile; that profile
// never invokes the retained Bubblewrap foundation or claims an outer sandbox.
export const TOOLS = Object.freeze([FOUNDATION_TOOLS[0]]);

export function hostTrustedRunsEnabled(env = process.env) {
  return env[HOST_TRUSTED_RUNS_ENV] === '1';
}

export function toolsForEnvironment(env = process.env) {
  return hostTrustedRunsEnabled(env) ? FOUNDATION_TOOLS : TOOLS;
}

export function validateToolInput(name, rawArguments = {}) {
  const value = object(rawArguments);
  if (!Object.hasOwn(TOOL_SCHEMAS, name)) throw new LocalInputError('unknown_tool', `Unknown local tool ${name}.`);
  if (name === 'status') {
    unknown(value, ['action', 'workspace']);
    if (value.action !== undefined && !['local', 'auth', 'permissions'].includes(value.action)) fail('arguments.action is not supported.');
    absolutePath(value.workspace, 'arguments.workspace', { optional: true });
    return { ...value, action: value.action ?? 'local' };
  }
  if (name === 'run') {
    unknown(value, ['workspace', 'prompt', 'mode', 'execution_profile', 'model', 'timeoutMs', 'waitMs', 'maxEvents', 'maxBytes', 'requestId']);
    absolutePath(value.workspace, 'arguments.workspace');
    string(value.prompt, 'arguments.prompt', { min: 1, max: MAX_PROMPT_CHARS });
    if (!['read_only', 'implement'].includes(value.mode)) fail('arguments.mode must be read_only or implement.');
    if (value.execution_profile !== 'host_trusted') fail('arguments.execution_profile must be host_trusted.');
    string(value.model, 'arguments.model', { min: 1, max: MAX_MODEL_CHARS, optional: true });
    integer(value.timeoutMs, 'arguments.timeoutMs', { min: 1_000, max: MAX_TIMEOUT_MS, optional: true });
    integer(value.waitMs, 'arguments.waitMs', { min: 0, max: MAX_WAIT_MS, optional: true });
    integer(value.maxEvents, 'arguments.maxEvents', { min: 1, max: MAX_EVENTS, optional: true });
    integer(value.maxBytes, 'arguments.maxBytes', { min: 1_024, max: MAX_BYTES, optional: true });
    if (value.requestId === undefined) fail('arguments.requestId is required for durable local runs.');
    requestId(value.requestId);
    return value;
  }
  if (name === 'runs') {
    unknown(value, ['action', 'localRunId', 'maxEvents', 'maxBytes']);
    if (!['get', 'logs', 'cancel'].includes(value.action)) fail('arguments.action must be get, logs, or cancel.');
    localRunId(value.localRunId);
    if (value.action === 'logs') {
      integer(value.maxEvents, 'arguments.maxEvents', { min: 1, max: MAX_EVENTS, optional: true });
      integer(value.maxBytes, 'arguments.maxBytes', { min: 1_024, max: MAX_BYTES, optional: true });
    } else if (value.maxEvents !== undefined || value.maxBytes !== undefined) {
      fail('arguments.maxEvents/maxBytes are valid only for action=logs.');
    }
    return value;
  }
  throw new LocalInputError('unknown_tool', `Unknown local tool ${name}.`);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveStateDirectory(env = process.env) {
  if (Object.hasOwn(env, 'CURSOR_LOCAL_CONTROL_STATE_DIR')) {
    const explicit = nonEmpty(env.CURSOR_LOCAL_CONTROL_STATE_DIR);
    if (!explicit || !path.isAbsolute(explicit)) return { directory: null, source: 'environment', reason: 'CURSOR_LOCAL_CONTROL_STATE_DIR must be a non-empty absolute path.' };
    return { directory: explicit, source: 'environment', reason: null };
  }
  const xdg = nonEmpty(env.XDG_STATE_HOME);
  if (xdg) {
    if (!path.isAbsolute(xdg)) return { directory: null, source: 'xdg_state_home', reason: 'XDG_STATE_HOME must be absolute.' };
    return { directory: path.join(xdg, 'cursor-local-control'), source: 'xdg_state_home', reason: null };
  }
  const home = nonEmpty(env.HOME);
  if (home && path.isAbsolute(home)) return { directory: path.join(home, '.local', 'state', 'cursor-local-control'), source: 'home', reason: null };
  return { directory: null, source: 'unconfigured', reason: 'Set CURSOR_LOCAL_CONTROL_STATE_DIR, XDG_STATE_HOME, or an absolute HOME.' };
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnerOnly(metadata, label, { directory = false } = {}) {
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new LocalRuntimeError('state_permissions', `${label} must be a real ${directory ? 'directory' : 'file'}.`);
  }
  if ((metadata.mode & 0o077) !== 0) throw new LocalRuntimeError('state_permissions', `${label} must be owner-only.`);
  if (currentUid() !== null && metadata.uid !== currentUid()) throw new LocalRuntimeError('state_permissions', `${label} must be owned by the MCP process user.`);
}

async function secureDirectory(directory, label = 'Local state directory') {
  if (!directory || !path.isAbsolute(directory)) throw new LocalRuntimeError('state_unavailable', `${label} must be an absolute path.`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  assertOwnerOnly(metadata, label, { directory: true });
  if ((metadata.mode & 0o7777) !== 0o700) throw new LocalRuntimeError('state_permissions', `${label} must have mode 0700.`);
  return directory;
}

async function secureFile(file, label = 'Local ledger', { allowMissing = true } = {}) {
  if (!Number.isInteger(NOFOLLOW) || NOFOLLOW === 0) throw new LocalRuntimeError('state_unavailable', `${label} requires O_NOFOLLOW support.`);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return false;
    throw new LocalRuntimeError(error?.code ?? 'state_unavailable', `Unable to inspect ${label}.`);
  }
  try {
    const metadata = await handle.stat();
    assertOwnerOnly(metadata, label);
    if (metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o600) throw new LocalRuntimeError('state_permissions', `${label} must have mode 0600 and one hard link.`);
    return true;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readSecureFile(file, label, { allowMissing = false, maxBytes = MAX_LEDGER_FILE_BYTES } = {}) {
  if (!Number.isInteger(NOFOLLOW) || NOFOLLOW === 0) throw new LocalRuntimeError('state_unavailable', `${label} requires O_NOFOLLOW support.`);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw new LocalRuntimeError(error?.code ?? 'state_unavailable', `Unable to read ${label}.`);
  }
  try {
    const metadata = await handle.stat();
    assertOwnerOnly(metadata, label);
    if (metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o600) throw new LocalRuntimeError('state_permissions', `${label} must have mode 0600 and one hard link.`);
    if (metadata.size > maxBytes) throw new LocalRuntimeError('state_corrupt', `${label} exceeds its size bound.`);
    return await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    throw new LocalRuntimeError('state_unavailable', `Unable to read ${label}.`);
  } finally {
    await handle.close().catch(() => {});
  }
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function capLedgerRuns(runs, maxRecords = MAX_LEDGER_RECORDS) {
  if (runs.length > maxRecords) {
    throw new LocalRuntimeError('state_limit', `The local request ledger is at capacity (${maxRecords} durable reservations).`);
  }
  return runs;
}

export class LocalRunLedger {
  constructor({
    stateDir,
    source = 'environment',
    reason = null,
    lockTimeoutMs = DEFAULT_LEDGER_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_LEDGER_LOCK_STALE_MS,
    lockPollMs = DEFAULT_LEDGER_LOCK_POLL_MS,
    maxRecords = MAX_LEDGER_RECORDS,
  } = {}) {
    this.stateDir = stateDir ?? null;
    this.source = source;
    this.reason = reason;
    this.file = this.stateDir ? path.join(this.stateDir, 'runs.json') : null;
    this.lockFile = this.stateDir ? path.join(this.stateDir, 'runs.lock') : null;
    this.lockTimeoutMs = Number.isInteger(lockTimeoutMs) && lockTimeoutMs >= 0 ? lockTimeoutMs : DEFAULT_LEDGER_LOCK_TIMEOUT_MS;
    this.staleLockMs = Number.isInteger(staleLockMs) && staleLockMs >= 0 ? staleLockMs : DEFAULT_LEDGER_LOCK_STALE_MS;
    this.lockPollMs = Number.isInteger(lockPollMs) && lockPollMs > 0
      ? Math.min(lockPollMs, MAX_LEDGER_LOCK_POLL_MS)
      : DEFAULT_LEDGER_LOCK_POLL_MS;
    this.maxRecords = Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= MAX_LEDGER_RECORDS
      ? maxRecords
      : MAX_LEDGER_RECORDS;
    this.queue = Promise.resolve();
  }

  async readiness() {
    if (!this.stateDir) return { ready: false, directory: null, source: this.source, reason: this.reason ?? 'No local state directory is configured.' };
    try {
      await secureDirectory(this.stateDir);
      await secureFile(this.file);
      return { ready: true, directory: this.stateDir, source: this.source, durability: 'owner-only-local-ledger' };
    } catch (error) {
      return { ready: false, directory: this.stateDir, source: this.source, reason: error.message, code: error.code };
    }
  }

  async ensure() {
    const readiness = await this.readiness();
    if (!readiness.ready) throw new LocalRuntimeError(readiness.code ?? 'state_unavailable', readiness.reason ?? 'Local state is unavailable.');
    return readiness;
  }

  async _readUnlocked() {
    const content = await readSecureFile(this.file, 'Local ledger', { allowMissing: true });
    if (content === null) return { version: 1, runs: [] };
    try {
      const parsed = JSON.parse(content);
      if (parsed?.version !== 1 || !Array.isArray(parsed.runs)) throw new Error('invalid shape');
      parsed.runs = capLedgerRuns(parsed.runs, this.maxRecords);
      return parsed;
    } catch (error) {
      if (error instanceof LocalRuntimeError) throw error;
      throw new LocalRuntimeError('state_corrupt', 'The local run ledger is corrupt.');
    }
  }

  async _writeUnlocked(value) {
    const payload = JSON.stringify({ version: 1, runs: capLedgerRuns(value.runs, this.maxRecords) }, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > MAX_LEDGER_FILE_BYTES) {
      throw new LocalRuntimeError('state_limit', 'The local run ledger exceeds its size bound.');
    }
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await secureFile(temporary, 'Temporary local ledger', { allowMissing: false });
      await rename(temporary, this.file);
      await secureFile(this.file, 'Local ledger', { allowMissing: false });
    } catch (error) {
      try { await unlink(temporary); } catch {}
      throw error;
    }
  }

  async _lockOwner(lockDirectory) {
    const ownerFile = path.join(lockDirectory, 'owner.json');
    let metadata;
    try {
      metadata = await lstat(lockDirectory);
    } catch (error) {
      if (error?.code === 'ENOENT') return { present: false, owner: null, metadata: null };
      throw new LocalRuntimeError('state_lock_unavailable', 'Unable to inspect the local ledger lock.');
    }
    assertOwnerOnly(metadata, 'Local ledger lock', { directory: true });
    if ((metadata.mode & 0o7777) !== 0o700) throw new LocalRuntimeError('state_lock_permissions', 'Local ledger lock must have mode 0700.');
    let ownerMetadata;
    try {
      const ownerStat = await lstat(ownerFile);
      await secureFile(ownerFile, 'Local ledger lock owner', { allowMissing: false });
      if (ownerStat.size > 4 * 1024) throw new LocalRuntimeError('state_lock_corrupt', 'Local ledger lock owner metadata is too large.');
      ownerMetadata = JSON.parse(await readSecureFile(ownerFile, 'Local ledger lock owner', { maxBytes: 4 * 1024 }));
    } catch (error) {
      if (error?.code === 'ENOENT') return { present: true, owner: null, metadata };
      if (error instanceof LocalRuntimeError && error.code !== 'state_lock_corrupt') throw error;
      ownerMetadata = null;
    }
    if (ownerMetadata !== null && (
      !ownerMetadata || typeof ownerMetadata !== 'object' || Array.isArray(ownerMetadata)
      || !Number.isSafeInteger(ownerMetadata.pid) || ownerMetadata.pid < 1
      || typeof ownerMetadata.start !== 'string' || ownerMetadata.start.length > 128
      || typeof ownerMetadata.token !== 'string' || !/^[a-f0-9-]{16,128}$/u.test(ownerMetadata.token)
      || typeof ownerMetadata.acquiredAt !== 'string'
    )) ownerMetadata = null;
    return { present: true, owner: ownerMetadata, metadata };
  }

  async _processStart(pid) {
    if (process.platform === 'win32') return null;
    try {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = text.lastIndexOf(') ');
      if (close < 0) return null;
      const fields = text.slice(close + 2).trim().split(/\s+/u);
      return /^\d+$/u.test(fields[19] ?? '') ? fields[19] : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return null;
    }
  }

  async _ownerAlive(owner) {
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
    if (owner.start && owner.start !== 'unknown') {
      const currentStart = await this._processStart(owner.pid);
      if (currentStart !== null) return currentStart === owner.start;
    }
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  async _staleLock(lockInfo) {
    if (!lockInfo.present) return false;
    if (lockInfo.owner && await this._ownerAlive(lockInfo.owner)) return false;
    const ageMs = Math.max(0, Date.now() - (lockInfo.metadata?.mtimeMs ?? Date.now()));
    // A lock with a proven dead owner is reclaimable immediately.  A lock
    // whose owner record was never committed (for example, a crashed process
    // between mkdir and writeFile) needs an age bound before reclamation.
    return Boolean(lockInfo.owner) || ageMs >= this.staleLockMs;
  }

  async _reclaimStaleLock() {
    const quarantine = `${this.lockFile}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(this.lockFile, quarantine);
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      if (error?.code === 'EEXIST') return false;
      throw new LocalRuntimeError('state_lock_unavailable', 'Unable to quarantine a stale local ledger lock.');
    }
    try {
      await rm(quarantine, { recursive: true, force: true });
    } catch {
      // The lock has already been removed from the active path.  Do not let a
      // best-effort quarantine cleanup strand all future ledger operations.
    }
    return true;
  }

  async _acquireLock() {
    await this.ensure();
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    const owner = {
      pid: process.pid,
      start: await this._processStart(process.pid) ?? 'unknown',
      token,
      acquiredAt: new Date().toISOString(),
    };
    let created = false;
    while (true) {
      try {
        await mkdir(this.lockFile, { mode: 0o700 });
        created = true;
        await secureDirectory(this.lockFile, 'Local ledger lock');
        const ownerFile = path.join(this.lockFile, 'owner.json');
        await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await secureFile(ownerFile, 'Local ledger lock owner', { allowMissing: false });
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          const lockInfo = await this._lockOwner(this.lockFile);
          if (!lockInfo.present) return;
          if (!lockInfo.owner || lockInfo.owner.token !== token) {
            throw new LocalRuntimeError('state_lock_lost', 'The local ledger lock owner changed before release.');
          }
          const quarantine = `${this.lockFile}.release-${process.pid}-${token}`;
          try {
            await rename(this.lockFile, quarantine);
          } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw new LocalRuntimeError('state_lock_lost', 'Unable to release the local ledger lock.');
          }
          await rm(quarantine, { recursive: true, force: true });
        };
      } catch (error) {
        if (created) {
          created = false;
          await rm(this.lockFile, { recursive: true, force: true }).catch(() => {});
        }
        if (error?.code !== 'EEXIST') {
          if (error instanceof LocalRuntimeError) throw error;
          throw new LocalRuntimeError('state_lock_unavailable', 'Unable to acquire the local ledger lock.');
        }
        const lockInfo = await this._lockOwner(this.lockFile);
        if (!lockInfo.present) continue;
        if (await this._staleLock(lockInfo)) {
          await this._reclaimStaleLock();
          continue;
        }
        if (Date.now() >= deadline) throw new LocalRuntimeError('state_lock_timeout', 'The local run ledger is busy in another MCP process.');
        await sleep(Math.min(this.lockPollMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  async withLock(operation) {
    if (typeof operation !== 'function') throw new LocalRuntimeError('invalid_input', 'Ledger lock operation must be a function.');
    const release = await this._acquireLock();
    try { return await operation(); } finally { await release(); }
  }

  async read() {
    await this.flush();
    return this.withLock(() => this._readUnlocked());
  }

  async write(value) {
    return this.withLock(() => this._writeUnlocked(value));
  }

  _enqueue(operation) {
    const pending = this.queue.catch(() => {}).then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async flush() {
    await this.queue;
  }

  async update(localRunId, updater) {
    return this._enqueue(async () => this.withLock(async () => {
      const current = await this._readUnlocked();
      const index = current.runs.findIndex((entry) => entry.localRunId === localRunId);
      if (index < 0) return null;
      current.runs[index] = updater(structuredClone(current.runs[index]));
      await this._writeUnlocked(current);
      return current.runs[index];
    }));
  }

  async add(record) {
    return this._enqueue(async () => this.withLock(async () => {
      const current = await this._readUnlocked();
      const existing = current.runs.find((entry) => entry.localRunId === record.localRunId
        || (record.requestId && entry.requestId === record.requestId));
      if (existing) {
        if (existing.requestDigest !== record.requestDigest) {
          throw new LocalRuntimeError('request_conflict', 'The local requestId was already used for a different request.');
        }
        return existing;
      }
      current.runs = current.runs.filter((entry) => entry.localRunId !== record.localRunId && !(record.requestId && entry.requestId === record.requestId));
      current.runs.push(record);
      await this._writeUnlocked(current);
      return record;
    }));
  }

  async find(localRunId) {
    await this.flush();
    const current = await this.read();
    return current.runs.find((entry) => entry.localRunId === localRunId) ?? null;
  }

  async findRequest(requestId) {
    if (!requestId) return null;
    await this.flush();
    const current = await this.read();
    return current.runs.find((entry) => entry.requestId === requestId) ?? null;
  }
}

export function resolveBinary(env = process.env) {
  const configured = nonEmpty(env.CURSOR_LOCAL_CLI_BIN);
  const home = nonEmpty(env.HOME);
  const candidate = configured ?? (home && path.isAbsolute(home) ? path.join(home, '.local', 'bin', 'cursor-agent') : null);
  if (!candidate || !path.isAbsolute(candidate)) return { path: null, reason: 'CURSOR_LOCAL_CLI_BIN must be an absolute path or HOME must be absolute.' };
  if (path.basename(candidate) === 'agent') return { path: null, reason: 'The generic agent command is reserved; configure cursor-agent explicitly.' };
  if (!['cursor-agent', 'cursor-local-agent'].includes(path.basename(candidate))) return { path: null, reason: 'Only cursor-agent or cursor-local-agent executables are accepted.' };
  return { path: path.resolve(candidate), reason: null };
}

export function parseRoots(env = process.env) {
  const raw = nonEmpty(env.CURSOR_LOCAL_CLI_WORKSPACE_ROOTS);
  if (!raw) return [];
  const roots = raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  if (roots.length > 20 || roots.some((entry) => !path.isAbsolute(entry))) throw new LocalRuntimeError('invalid_configuration', 'CURSOR_LOCAL_CLI_WORKSPACE_ROOTS must contain absolute paths.');
  return roots.map((entry) => path.resolve(entry));
}

async function allowedWorkspace(workspace, env) {
  if (!path.isAbsolute(workspace)) throw new LocalRuntimeError('invalid_workspace', 'The workspace must be absolute.');
  let requestedMetadata;
  try { requestedMetadata = await lstat(workspace); } catch { throw new LocalRuntimeError('invalid_workspace', 'The workspace does not exist or is not accessible.'); }
  if (requestedMetadata.isSymbolicLink()) throw new LocalRuntimeError('invalid_workspace', 'The workspace path must not be a symbolic link.');
  let resolved;
  try { resolved = await realpath(workspace); } catch { throw new LocalRuntimeError('invalid_workspace', 'The workspace does not exist or is not accessible.'); }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new LocalRuntimeError('invalid_workspace', 'The workspace must be a real directory.');
  const roots = [];
  for (const root of parseRoots(env)) {
    try { roots.push(await realpath(root)); } catch {}
  }
  const isBelow = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (!roots.some((root) => isBelow(root, resolved))) {
    throw new LocalRuntimeError('workspace_not_allowlisted', 'The workspace is outside the administrator allowlist.');
  }
  return resolved;
}

async function attestDirectory(value, label, { ownerOnly = false } = {}) {
  if (!value || !path.isAbsolute(value)) throw new LocalRuntimeError('invalid_configuration', `${label} must be an absolute directory.`);
  if (!Number.isInteger(NOFOLLOW) || NOFOLLOW === 0 || !Number.isInteger(DIRECTORY) || DIRECTORY === 0) {
    throw new LocalRuntimeError('state_unavailable', `${label} requires secure directory descriptor support.`);
  }
  let requested;
  try { requested = await lstat(value); } catch (error) {
    throw new LocalRuntimeError('configuration_unavailable', `${label} is unavailable.`, { cause: error?.code });
  }
  if (requested.isSymbolicLink()) throw new LocalRuntimeError('state_permissions', `${label} must not be a symbolic link.`);
  let resolved;
  try { resolved = await realpath(value); } catch { throw new LocalRuntimeError('configuration_unavailable', `${label} is unavailable.`); }
  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new LocalRuntimeError('state_permissions', `${label} must be a real directory.`);
    if (ownerOnly) {
      assertOwnerOnly(metadata, label, { directory: true });
      if ((metadata.mode & 0o7777) !== 0o700) throw new LocalRuntimeError('state_permissions', `${label} must have mode 0700.`);
    }
    return { path: resolved, identity: fileIdentity(metadata) };
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    throw new LocalRuntimeError('configuration_unavailable', `${label} is unavailable.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ownerOnlyPath(value, label) {
  return (await attestDirectory(value, label, { ownerOnly: true })).path;
}

async function existingDirectory(value, label) {
  if (!value || !path.isAbsolute(value)) throw new LocalRuntimeError('invalid_configuration', `${label} must be an absolute directory.`);
  let metadata;
  try { metadata = await lstat(value); } catch (error) {
    throw new LocalRuntimeError('configuration_unavailable', `${label} is unavailable.`, { cause: error?.code });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new LocalRuntimeError('invalid_configuration', `${label} must be a real directory.`);
  }
  return value;
}

function configDirectory(env) {
  const configured = nonEmpty(env.CURSOR_LOCAL_CLI_CONFIG_DIR);
  if (configured) return path.isAbsolute(configured) ? path.resolve(configured) : null;
  const home = nonEmpty(env.HOME);
  if (home && path.isAbsolute(home)) return path.join(home, '.cursor');
  return null;
}

async function inspectPermissionConfig(env, workspace) {
  const directory = configDirectory(env);
  if (!directory) return { configured: false, reason: 'CURSOR_LOCAL_CLI_CONFIG_DIR or absolute HOME is required.' };
  let metadata;
  try { metadata = await lstat(directory); } catch { return { configured: false, path: path.join(directory, 'cli-config.json'), reason: 'config directory is unavailable' }; }
  try {
    assertOwnerOnly(metadata, 'Cursor local CLI config directory', { directory: true });
    if ((metadata.mode & 0o7777) !== 0o700) throw new LocalRuntimeError('state_permissions', 'Cursor local CLI config directory must have mode 0700.');
  } catch {
    return { configured: false, path: path.join(directory, 'cli-config.json'), reason: 'config directory must be a real owner-only directory' };
  }
  const globalPath = path.join(directory, 'cli-config.json');
  let global = null;
  try {
    global = JSON.parse(await readSecureFile(globalPath, 'Cursor local CLI config', { allowMissing: false, maxBytes: 256 * 1024 }));
  } catch (error) {
    return { configured: false, path: globalPath, reason: error.code === 'ENOENT' ? 'cli-config.json is absent' : 'cli-config.json is invalid or not owner-only' };
  }
  if (global?.version !== 1 || !global.permissions || !Array.isArray(global.permissions.allow) || !Array.isArray(global.permissions.deny)) {
    return { configured: false, path: globalPath, reason: 'cli-config.json does not match schema version 1' };
  }
  const projectDirectory = workspace ? path.join(workspace, '.cursor') : null;
  const projectPath = projectDirectory ? path.join(projectDirectory, 'cli.json') : null;
  let project = null;
  if (projectDirectory) {
    try {
      const projectDirectoryMetadata = await lstat(projectDirectory);
      assertOwnerOnly(projectDirectoryMetadata, 'Project Cursor local CLI config directory', { directory: true });
      if ((projectDirectoryMetadata.mode & 0o7777) !== 0o700) throw new LocalRuntimeError('state_permissions', 'Project Cursor local CLI config directory must have mode 0700.');
      project = JSON.parse(await readSecureFile(projectPath, 'Project Cursor local CLI permissions', { allowMissing: false, maxBytes: 256 * 1024 }));
      if (!project?.permissions || !Array.isArray(project.permissions.allow) || !Array.isArray(project.permissions.deny)) {
        return { configured: false, path: globalPath, projectPath, reason: 'project cli.json has an invalid permission shape' };
      }
      if (project.approvalMode !== undefined && typeof project.approvalMode !== 'string') {
        return { configured: false, path: globalPath, projectPath, reason: 'project cli.json has an invalid approval mode' };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') return { configured: false, path: globalPath, projectPath, reason: 'project cli.json is invalid or not owner-only' };
    }
  }
  const allow = [...global.permissions.allow, ...(project?.permissions?.allow ?? [])];
  const deny = [...global.permissions.deny, ...(project?.permissions?.deny ?? [])];
  const approvalModes = [global.approvalMode, project?.approvalMode].filter((value) => typeof value === 'string');
  const approvalMode = approvalModes.includes('unrestricted')
    ? 'unrestricted'
    : (project?.approvalMode ?? global.approvalMode ?? 'default');
  return {
    configured: true,
    path: globalPath,
    projectPath,
    version: global.version,
    approvalMode,
    allowCount: allow.length,
    denyCount: deny.length,
    denyWriteAll: deny.includes('Write(**)'),
    denyShellAll: deny.includes('Shell(*)'),
    denyMcpAll: deny.includes('Mcp(*:*)'),
    digest: digest({ global, project }),
    raw: { global, project },
  };
}

function permissionReady(config, mode) {
  if (!config?.configured) throw new LocalRuntimeError('permission_config_unavailable', config?.reason ?? 'A secure Cursor CLI permission config is required.');
  if (config.approvalMode === 'unrestricted') throw new LocalRuntimeError('permission_config_unsafe', 'Unrestricted Cursor CLI approval mode is not permitted.');
  if (mode === 'read_only' && !config.denyWriteAll) throw new LocalRuntimeError('permission_config_unsafe', 'Read-only runs require an explicit Write(**) deny rule.');
  if (mode === 'read_only' && !config.denyShellAll) throw new LocalRuntimeError('permission_config_unsafe', 'Read-only runs require an explicit Shell(*) deny rule.');
  if (!config.denyMcpAll) throw new LocalRuntimeError('permission_config_unsafe', 'Local runs require an explicit Mcp(*:*) deny rule unless a future allowlist is implemented.');
}

function fileIdentity(metadata) {
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

function sameFileIdentity(left, right) {
  return left?.dev === String(right?.dev) && left?.ino === String(right?.ino);
}

async function binaryMetadata(binaryPath, { expectedSha256 = null, label = 'binary' } = {}) {
  if (!binaryPath) return { available: false, path: null, reason: 'binary path is not configured' };
  if (!Number.isInteger(NOFOLLOW) || NOFOLLOW === 0) return { available: false, path: binaryPath, reason: `${label} requires O_NOFOLLOW support` };
  let metadata;
  try { metadata = await lstat(binaryPath); } catch (error) {
    return { available: false, path: binaryPath, reason: error?.code === 'ENOENT' ? 'binary is absent' : 'binary is unavailable' };
  }
  if (metadata.isSymbolicLink()) {
    try { binaryPath = await realpath(binaryPath); } catch { return { available: false, path: binaryPath, reason: 'binary symlink target is unavailable' }; }
  }
  let handle;
  try {
    handle = await open(binaryPath, constants.O_RDONLY | NOFOLLOW);
    metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) return { available: false, path: binaryPath, reason: `${label} must be an executable regular file` };
    if (metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0) return { available: false, path: binaryPath, reason: `${label} must not be group/other-writable and must have one hard link` };
    if (metadata.size > MAX_BINARY_BYTES) return { available: false, path: binaryPath, reason: 'binary exceeds the configured size bound' };
    const identity = fileIdentity(metadata);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let offset = 0;
    while (offset < metadata.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - offset), offset);
      if (bytesRead === 0) return { available: false, path: binaryPath, reason: `${label} changed while it was being read` };
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(identity, after) || after.size !== metadata.size) return { available: false, path: binaryPath, reason: `${label} changed while it was being read` };
    const sha256 = hash.digest('hex');
    const digestConfigured = typeof expectedSha256 === 'string' && SANDBOX_DIGEST_PATTERN.test(expectedSha256);
    return {
      available: true,
      path: binaryPath,
      identity,
      sha256,
      expectedSha256: digestConfigured ? expectedSha256 : null,
      digestConfigured,
      drift: digestConfigured ? sha256 !== expectedSha256 : null,
      sizeBytes: metadata.size,
      mode: metadata.mode & 0o7777,
    };
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    return { available: false, path: binaryPath, reason: error?.code === 'ELOOP' ? `${label} must not be a symbolic link` : `${label} is unavailable` };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function resolveSandbox(env = process.env) {
  const configured = nonEmpty(env.CURSOR_LOCAL_CLI_SANDBOX_BIN);
  if (!configured || !path.isAbsolute(configured)) {
    return { path: null, reason: 'CURSOR_LOCAL_CLI_SANDBOX_BIN must be an absolute native sandbox path.' };
  }
  const resolved = path.resolve(configured);
  if (path.basename(resolved) !== 'bwrap') {
    return { path: null, reason: 'Only the fixed native bwrap sandbox is accepted.' };
  }
  return { path: resolved, reason: null };
}

const SANDBOX_PROBE_ARGS = Object.freeze([
  '--die-with-parent',
  '--unshare-pid',
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--proc', '/proc',
  '--tmpfs', '/tmp',
  '--', '/bin/true',
]);

async function nativeSandboxStatus(env, execFileImpl) {
  const resolved = resolveSandbox(env);
  if (!resolved.path) return { ready: false, path: null, reason: resolved.reason, digestConfigured: false, drift: null };
  const expected = nonEmpty(env.CURSOR_LOCAL_CLI_SANDBOX_SHA256);
  if (!SANDBOX_DIGEST_PATTERN.test(expected ?? '')) {
    return { ready: false, path: resolved.path, reason: 'CURSOR_LOCAL_CLI_SANDBOX_SHA256 must pin the native sandbox digest.', digestConfigured: false, drift: null };
  }
  const binary = await binaryMetadata(resolved.path, { expectedSha256: expected, label: 'native sandbox' });
  if (!binary.available) return { ready: false, ...binary, reason: binary.reason ?? 'native sandbox is unavailable' };
  if (binary.drift) return { ready: false, ...binary, reason: 'native sandbox digest drift detected' };
  try {
    await execText(execFileImpl, binary.path, SANDBOX_PROBE_ARGS, {
      env: { PATH: SAFE_CHILD_PATH, HOME: '/', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      timeout: 5_000,
    });
    return { ready: true, ...binary, probe: 'bwrap-ro-root-proc-dev-tmpfs' };
  } catch (error) {
    return { ready: false, ...binary, reason: error?.code === 'ETIMEDOUT' ? 'native sandbox preflight timed out' : 'native sandbox preflight failed' };
  }
}

function safeVersion(output) {
  const value = String(output ?? '').trim().split(/\r?\n/, 1)[0].trim();
  return value && SAFE_VERSION_PATTERN.test(value) ? value : null;
}

function localSecrets(env) {
  const values = [];
  if (typeof env.CURSOR_LOCAL_CLI_API_KEY === 'string' && env.CURSOR_LOCAL_CLI_API_KEY) values.push(env.CURSOR_LOCAL_CLI_API_KEY);
  return values;
}

function childEnvironment(env, { home, configDir }) {
  const output = {
    PATH: SAFE_CHILD_PATH,
    HOME: home,
    LANG: env.LANG ?? 'C.UTF-8',
    LC_ALL: env.LC_ALL ?? 'C.UTF-8',
    CURSOR_CONFIG_DIR: configDir,
  };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (typeof env[name] === 'string' && env[name]) output[name] = env[name];
  }
  if (typeof env.CURSOR_LOCAL_CLI_API_KEY === 'string' && env.CURSOR_LOCAL_CLI_API_KEY) output.CURSOR_API_KEY = env.CURSOR_LOCAL_CLI_API_KEY;
  return output;
}

export function buildArguments({ workspace, prompt, mode, model, worktreeName, executionProfile = 'host_trusted' }) {
  if (executionProfile !== 'host_trusted') throw new LocalInputError('invalid_input', 'Only the host_trusted execution profile is exposed.');
  const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--sandbox', 'disabled', '--trust', '--workspace', workspace];
  if (mode === 'implement') args.push('--worktree', worktreeName);
  if (mode === 'read_only') args.push('--mode', 'ask');
  else args.push('--force');
  if (model !== undefined) args.push('--model', model);
  // Cursor's headless CLI accepts the prompt as a positional argument.  Keep
  // the conventional option terminator immediately before it so prompt text
  // beginning with "--endpoint", "--plugin-dir", "--force", or any future
  // option can never be reparsed as a CLI flag.
  args.push('--', prompt);
  return args;
}

export function buildSandboxArguments({ sandboxPath, home, configDir, workspace, binaryPath, cursorArguments }) {
  return [
    '--die-with-parent',
    '--unshare-pid',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', home, home,
    '--ro-bind', configDir, configDir,
    '--ro-bind', workspace, workspace,
    '--chdir', workspace,
    '--setenv', 'HOME', home,
    '--setenv', 'CURSOR_CONFIG_DIR', configDir,
    '--', binaryPath,
    ...cursorArguments,
  ];
}

function isPathWithin(root, candidate) {
  if (!root || !candidate || !path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeEvent(value, secrets) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { type: 'invalid', message: 'event was not an object' };
  const type = typeof value.type === 'string' && SAFE_EVENT_TYPE_PATTERN.test(value.type) ? value.type : 'unknown';
  const output = { type };
  if (typeof value.subtype === 'string' && SAFE_EVENT_TYPE_PATTERN.test(value.subtype)) output.subtype = value.subtype;
  if (typeof value.session_id === 'string' && value.session_id.length <= 128) output.sessionId = value.session_id;
  if (value.type === 'system' && typeof value.apiKeySource === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.apiKeySource)) output.apiKeySource = value.apiKeySource;
  if (value.type === 'system' && typeof value.cwd === 'string' && path.isAbsolute(value.cwd)) output.cwd = value.cwd;
  if (value.type === 'assistant') {
    const textValue = value.message?.content?.find?.((entry) => entry?.type === 'text')?.text;
    if (typeof textValue === 'string') output.text = redactText(textValue, secrets);
  }
  if (value.type === 'result' && typeof value.result === 'string') output.result = redactText(value.result, secrets);
  if (value.type === 'tool_call') output.tool = 'tool_call';
  return output;
}

export function createNdjsonCollector({ maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, secrets = [], onEvent = () => {} } = {}) {
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let truncated = false;
  let limitReached = false;
  let invalidUtf8 = false;
  let finished = false;
  const events = [];
  const strictDecoder = new TextDecoder('utf-8', { fatal: true });
  const stop = ({ invalid = false, dropped = false } = {}) => {
    if (invalid) invalidUtf8 = true;
    if (dropped) truncated = true;
    limitReached = true;
    pending = Buffer.alloc(0);
  };
  const parseLine = (lineBytes) => {
    let payload = lineBytes;
    if (payload.at(-1) === 0x0d) payload = payload.subarray(0, payload.length - 1);
    const lineBytesLength = payload.byteLength;
    if (lineBytesLength > MAX_EVENT_LINE_BYTES) { stop({ dropped: true }); return; }
    if (bytes + lineBytesLength > maxBytes) { stop({ dropped: true }); return; }
    let line;
    try {
      // Decode complete byte-delimited lines strictly.  Buffer.toString()
      // would replace malformed bytes, and decoding each stream chunk would
      // corrupt a multibyte character split across chunks.
      line = strictDecoder.decode(payload);
    } catch {
      stop({ invalid: true, dropped: true });
      return;
    }
    bytes += lineBytesLength;
    if (bytes > maxBytes) { truncated = true; limitReached = true; return; }
    let parsed;
    try { parsed = JSON.parse(line); } catch { parsed = { type: 'invalid', message: 'invalid JSON event' }; }
    const event = normalizeEvent(parsed, secrets);
    if (events.length >= maxEvents) {
      truncated = true;
      limitReached = true;
      return;
    }
    events.push(event);
    onEvent(event);
    if (events.length >= maxEvents || bytes >= maxBytes) limitReached = true;
  };
  return {
    push(chunk) {
      if (finished || limitReached) {
        if (chunk && (Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length > 0)) truncated = true;
        return;
      }
      let value;
      try {
        value = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8');
      } catch {
        stop({ invalid: true, dropped: true });
        return;
      }
      if (value.length === 0) return;
      let offset = 0;
      while (offset < value.length && !limitReached) {
        const newline = value.indexOf(0x0a, offset);
        const end = newline < 0 ? value.length : newline;
        const segment = value.subarray(offset, end);
        if (pending.length + segment.length > MAX_EVENT_LINE_BYTES) {
          stop({ dropped: true });
          break;
        }
        if (segment.length > 0) pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
        if (newline < 0) break;
        const line = pending;
        pending = Buffer.alloc(0);
        parseLine(line);
        offset = newline + 1;
        if (limitReached) {
          if (offset < value.length) truncated = true;
          break;
        }
        // Empty lines are valid JSON input boundaries but are represented as
        // bounded invalid events, matching the previous collector contract.
      }
    },
    finish() {
      if (!finished && pending.length > 0 && !limitReached) parseLine(pending);
      finished = true;
      pending = Buffer.alloc(0);
      return { events, bytes: Math.min(bytes, maxBytes), truncated, invalidUtf8 };
    },
  };
}

// Capture arbitrary stderr bytes without decoding each stream chunk in
// isolation.  TextDecoder's streaming mode carries incomplete UTF-8 sequences
// across pushes; fatal mode makes malformed input fail closed instead of
// inserting replacement characters that could alter/redact secrets
// unpredictably.  Redaction is deliberately performed by the caller only
// after finish() has reassembled the complete bounded string.
function createStrictTextCollector({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  let truncated = false;
  let invalidUtf8 = false;
  let finished = false;

  const failClosed = () => {
    invalidUtf8 = true;
    decoder = null;
    text = '';
  };

  return {
    push(chunk) {
      if (finished || invalidUtf8) {
        if (chunk && (Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length > 0)) truncated = true;
        return;
      }
      let value;
      try {
        value = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk), 'utf8');
      } catch {
        failClosed();
        return;
      }
      if (value.length === 0) return;
      const remaining = Math.max(0, maxBytes - bytes);
      const accepted = value.subarray(0, remaining);
      if (accepted.length < value.length) truncated = true;
      if (accepted.length === 0) return;
      bytes += accepted.length;
      try {
        text += decoder.decode(accepted, { stream: true });
      } catch {
        failClosed();
      }
    },
    finish() {
      if (!finished) {
        finished = true;
        if (decoder) {
          try { text += decoder.decode(); } catch { failClosed(); }
        }
      }
      return { text: invalidUtf8 ? '' : text, bytes, truncated, invalidUtf8 };
    },
  };
}

function processKill(child, signal = 'SIGTERM') {
  if (!child?.pid) return false;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw new LocalRuntimeError('cancel_failed', 'Unable to signal the owned local process group.');
  }
}

function processGroupExists(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function terminateProcessGroup(child, { graceMs = 2_000, startToken = null } = {}) {
  if (!child?.pid) return false;
  // A PID is not an ownership proof.  Active runs pass the exact start token
  // captured immediately after spawn; recovery passes the durable token and
  // requires a fresh procfs match.  Unknown/unreadable identities are never
  // signalled, even if a process group happens to exist at that number.
  if (typeof startToken !== 'string' || startToken.length === 0 || startToken === 'unknown') return false;
  if (!processGroupExists(child.pid)) return false;
  // The token is re-read immediately before TERM even for the MCP process
  // that originally spawned this child.  Durable ownership is not a shortcut
  // around PID-reuse protection.
  if (!(await processMatches(child.pid, startToken))) {
    throw new LocalRuntimeError('process_identity_changed', 'The owned process identity changed before termination.');
  }
  const signaled = processKill(child, 'SIGTERM');
  if (!signaled) return false;
  const deadline = Date.now() + graceMs;
  while (processGroupExists(child.pid) && Date.now() < deadline) await sleep(25);
  if (processGroupExists(child.pid)) {
    // Re-check immediately before the escalation signal as well.  If the
    // leader exited, descendants are no longer safely attributable to this
    // PID token; leave them alone and let reconciliation report transport_lost.
    if (!(await processMatches(child.pid, startToken))) {
      throw new LocalRuntimeError('process_identity_changed', 'The owned process identity changed before termination escalation.');
    }
    try { processKill(child, 'SIGKILL'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  return true;
}

async function processStartToken(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform === 'win32') return null;
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(') ');
    if (close < 0) return null;
    const fields = text.slice(close + 2).trim().split(/\s+/u);
    return /^\d+$/u.test(fields[19] ?? '') ? fields[19] : null;
  } catch {
    return null;
  }
}

function processStartTokenSync(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform === 'win32') return null;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(') ');
    if (close < 0) return null;
    const fields = text.slice(close + 2).trim().split(/\s+/u);
    return /^\d+$/u.test(fields[19] ?? '') ? fields[19] : null;
  } catch {
    return null;
  }
}

async function processMatches(pid, start) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  if (typeof start !== 'string' || start === 'unknown') return false;
  const current = await processStartToken(pid);
  return current !== null && current === start;
}

async function terminateProcessGroupByPid(pid, startToken, { graceMs = 2_000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform === 'win32') return false;
  const fakeChild = { pid };
  return terminateProcessGroup(fakeChild, { graceMs, startToken });
}

async function execText(execFileImpl, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, { ...options, encoding: 'utf8', maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

async function versionProbe(binary, env, execFileImpl) {
  try {
    const response = await execText(execFileImpl, binary, ['--version'], { env, timeout: 10_000 });
    return safeVersion(response.stdout);
  } catch (error) {
    return safeVersion(error?.stdout) ?? null;
  }
}

async function authProbe(binary, env, execFileImpl) {
  try {
    const response = await execText(execFileImpl, binary, ['status', '--format', 'json'], { env, timeout: 15_000 });
    return projectAuth(response.stdout, env);
  } catch (error) {
    return projectAuth(error?.stdout, env, error);
  }
}

export function projectAuth(value, env = {}, error = null) {
  let parsed = null;
  try { parsed = JSON.parse(String(value ?? '')); } catch {}
  const configuredApiKey = typeof env.CURSOR_LOCAL_CLI_API_KEY === 'string' && env.CURSOR_LOCAL_CLI_API_KEY.length > 0;
  const authenticated = parsed?.authenticated === true
    || parsed?.isAuthenticated === true
    || parsed?.status === 'authenticated'
    || parsed?.authStatus === 'authenticated';
  const notAuthenticated = parsed?.authenticated === false
    || parsed?.isAuthenticated === false
    || parsed?.status === 'not_authenticated'
    || parsed?.authStatus === 'not_authenticated';
  return {
    state: authenticated ? 'authenticated' : (notAuthenticated ? 'not_authenticated' : (error ? 'unknown' : 'unknown')),
    method: configuredApiKey ? 'api_key_env' : 'browser_or_unknown',
    apiKeyConfigured: configuredApiKey,
    probeError: error ? (error.code === 'ETIMEDOUT' ? 'timeout' : 'status_unavailable') : undefined,
  };
}

function scrub(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrub(child, secrets)]));
  return value;
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function clipEventToBytes(event, maxBytes) {
  if (maxBytes <= 0) return null;
  if (serializedBytes(event) <= maxBytes) return event;
  // Normalized provider events only carry untrusted text in these fields.
  // Clip by Unicode code points (never split a UTF-16 surrogate) and retain
  // the event discriminator/metadata so the receipt remains interpretable.
  for (const key of ['text', 'result']) {
    if (typeof event?.[key] !== 'string') continue;
    const points = Array.from(event[key]);
    let low = 0;
    let high = points.length;
    let best = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = { ...event, [key]: points.slice(0, middle).join('') };
      if (serializedBytes(candidate) <= maxBytes) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best) return best;
  }
  return null;
}

function boundEvents(events, { maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, secrets = [] } = {}) {
  const bounded = [];
  let bytes = 0;
  let truncated = false;
  for (const source of events ?? []) {
    if (bounded.length >= maxEvents) {
      truncated = true;
      break;
    }
    const safe = scrub(source, secrets);
    const remaining = maxBytes - bytes;
    const event = clipEventToBytes(safe, remaining);
    if (!event) {
      truncated = true;
      break;
    }
    const eventBytes = serializedBytes(event);
    bounded.push(event);
    bytes += eventBytes;
    if (eventBytes < serializedBytes(safe)) truncated = true;
  }
  if ((events?.length ?? 0) > bounded.length) truncated = true;
  return { events: bounded, bytes, truncated };
}

function publicRecord(record, { maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, secrets = [] } = {}) {
  const output = structuredClone(record);
  const bounded = boundEvents(record.logs?.events ?? [], { maxEvents, maxBytes, secrets });
  output.logs = {
    format: 'stream-json',
    events: bounded.events,
    // This is the actual UTF-8 size of the normalized events returned above,
    // not the provider's unbounded/raw counter.
    bytes: bounded.bytes,
    truncated: Boolean(record.logs?.truncated) || bounded.truncated,
    ...(record.logs?.invalidUtf8 ? { invalidUtf8: true } : {}),
  };
  delete output.pid;
  delete output.argv;
  delete output.promptDigest;
  if (output.execution && typeof output.execution === 'object') {
    delete output.execution.ownerPid;
    delete output.execution.ownerStart;
    delete output.execution.childPid;
    delete output.execution.childStart;
    delete output.execution.processGroupId;
  }
  return scrub(output, secrets);
}

export class CursorLocalService {
  constructor({ env = process.env, spawnImpl = nodeSpawn, execFileImpl = nodeExecFile, ledger } = {}) {
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.execFileImpl = execFileImpl;
    const state = resolveStateDirectory(env);
    this.ledger = ledger ?? new LocalRunLedger({ stateDir: state.directory, source: state.source, reason: state.reason });
    this.active = new Map();
    this.ownerStartPromise = processStartToken(process.pid);
  }

  secrets() { return localSecrets(this.env); }

  tools() { return toolsForEnvironment(this.env); }

  async reconcilePersistedRuns() {
    const snapshot = await this.ledger.read();
    for (const persisted of snapshot.runs) {
      if (!['accepted', 'started', 'working'].includes(persisted.lifecycle) || this.active.has(persisted.localRunId)) continue;
      const execution = persisted.execution ?? {};
      const ownerPid = execution.ownerPid;
      const ownerStart = execution.ownerStart;
      // A live owner may be another MCP process that is still responsible for
      // its child.  Only a dead owner is recoverable by this process.
      if (await processMatches(ownerPid, ownerStart)) continue;
      const childPid = execution.childPid;
      const childStart = execution.childStart;
      const childCanBeIdentified = typeof childStart === 'string' && childStart !== 'unknown';
      const childAlive = childCanBeIdentified
        ? await processMatches(childPid, childStart)
        : false;
      // Never turn an unverified PID into a signal target.  An unreadable or
      // missing durable start token is itself transport loss; the next owner
      // records that fact but leaves unrelated processes untouched.
      if (childAlive) await terminateProcessGroupByPid(childPid, childStart).catch(() => {});
      await this.ledger.update(persisted.localRunId, (entry) => ({
        ...entry,
        lifecycle: 'terminal',
        terminalState: 'transport_lost',
        error: 'owner_process_lost',
        finishedAt: entry.finishedAt ?? new Date().toISOString(),
        durationMs: entry.durationMs ?? null,
      }));
    }
  }

  async binaryStatus() {
    const resolved = resolveBinary(this.env);
    const expectedSha256 = nonEmpty(this.env.CURSOR_LOCAL_CLI_SHA256);
    const binary = await binaryMetadata(resolved.path, { expectedSha256, label: 'Cursor local CLI binary' });
    if (!binary.available) return { ...binary, configuredPath: resolved.path, reason: binary.reason ?? resolved.reason };
    const configDir = configDirectory(this.env);
    const home = nonEmpty(this.env.CURSOR_LOCAL_CLI_HOME) ?? nonEmpty(this.env.HOME);
    const childEnv = childEnvironment(this.env, { home: home && path.isAbsolute(home) ? home : '/', configDir: configDir ?? '/' });
    const version = await versionProbe(binary.path, childEnv, this.execFileImpl);
    return { ...binary, version, configuredPath: resolved.path };
  }

  async status(value) {
    const workspace = value.workspace ? await allowedWorkspace(value.workspace, this.env) : undefined;
    const binary = await this.binaryStatus();
    const config = workspace ? await inspectPermissionConfig(this.env, workspace).catch((error) => ({ configured: false, reason: error.message })) : await inspectPermissionConfig(this.env);
    const sandbox = await nativeSandboxStatus(this.env, this.execFileImpl);
    const hostTrusted = hostTrustedRunsEnabled(this.env);
    const local = {
      surface: 'local-cli',
      contractVersion: 1,
      binary: {
        available: binary.available,
        path: binary.path ?? binary.configuredPath ?? null,
        configuredPath: binary.configuredPath ?? null,
        ...(binary.version ? { version: binary.version } : {}),
        ...(binary.sha256 ? { sha256: binary.sha256 } : {}),
        ...(binary.expectedSha256 ? { expectedSha256: binary.expectedSha256 } : {}),
        ...(binary.digestConfigured !== undefined ? { digestConfigured: binary.digestConfigured } : {}),
        ...(binary.drift !== undefined ? { drift: binary.drift } : {}),
        ...(binary.sizeBytes !== undefined ? { sizeBytes: binary.sizeBytes } : {}),
        ...(binary.reason ? { reason: binary.reason } : {}),
      },
      state: await this.ledger.readiness(),
      config: {
        path: config.path ?? configDirectory(this.env),
        projectPath: config.projectPath ?? null,
        configured: config.configured === true,
        ...(config.version !== undefined ? { version: config.version } : {}),
        ...(config.approvalMode ? { approvalMode: config.approvalMode } : {}),
        ...(config.allowCount !== undefined ? { allowCount: config.allowCount, denyCount: config.denyCount } : {}),
        ...(config.denyWriteAll !== undefined ? { denyWriteAll: config.denyWriteAll } : {}),
        ...(config.denyShellAll !== undefined ? { denyShellAll: config.denyShellAll } : {}),
        ...(config.denyMcpAll !== undefined ? { denyMcpAll: config.denyMcpAll } : {}),
        ...(config.digest ? { digest: config.digest } : {}),
        ...(config.reason ? { reason: config.reason } : {}),
      },
      sandbox: {
        ready: sandbox.ready === true,
        path: sandbox.path ?? null,
        ...(sandbox.sha256 ? { sha256: sandbox.sha256 } : {}),
        ...(sandbox.expectedSha256 ? { expectedSha256: sandbox.expectedSha256 } : {}),
        ...(sandbox.digestConfigured !== undefined ? { digestConfigured: sandbox.digestConfigured } : {}),
        ...(sandbox.drift !== undefined ? { drift: sandbox.drift } : {}),
        ...(sandbox.probe ? { probe: sandbox.probe } : {}),
        ...(sandbox.reason ? { reason: sandbox.reason } : {}),
      },
      safety: {
        runEnabled: hostTrusted,
        executionProfile: hostTrusted ? 'host_trusted' : null,
        boundary: hostTrusted ? 'host_trusted' : 'status_only',
        authority: hostTrusted ? 'mcp_process_user' : null,
        outerSandbox: 'none',
        providerSandbox: hostTrusted ? 'disabled' : 'not_used',
        sandboxReady: sandbox.ready === true,
        runUnavailableReason: hostTrusted ? null : 'Host-trusted local execution is disabled; set CURSOR_LOCAL_CLI_ENABLE_HOST_TRUSTED_RUNS=1 in the administrator MCP environment to expose it.',
        readOnlyDefault: true,
        implementExplicitOnly: true,
        genericAgentAliasAccepted: false,
        cloudLedgerShared: false,
      },
      documentation: {
        installation: 'https://cursor.com/docs/cli/installation',
        authentication: 'https://cursor.com/docs/cli/reference/authentication',
        headless: 'https://cursor.com/docs/cli/headless',
        permissions: 'https://cursor.com/docs/cli/reference/permissions',
      },
    };
    if (value.action === 'local' || value.action === 'permissions') return { ok: true, status: local };
    if (value.action === 'auth') {
      if (!binary.available) return { ok: true, status: { ...local, auth: { state: 'unavailable', method: 'none', apiKeyConfigured: false } } };
      const home = nonEmpty(this.env.CURSOR_LOCAL_CLI_HOME) ?? nonEmpty(this.env.HOME);
      const configDir = configDirectory(this.env);
      const childEnv = childEnvironment(this.env, { home: home && path.isAbsolute(home) ? home : '/', configDir: configDir ?? '/' });
      const auth = await authProbe(binary.path, childEnv, this.execFileImpl);
      return { ok: true, status: { ...local, auth } };
    }
    throw new LocalInputError('invalid_input', `Unsupported status action ${value.action}.`);
  }

  async verifyRunEnvironment(value) {
    if (!hostTrustedRunsEnabled(this.env)) {
      throw new LocalRuntimeError('host_trusted_disabled', 'Host-trusted local execution is disabled by the administrator.');
    }
    const workspace = await allowedWorkspace(value.workspace, this.env);
    const binary = await this.binaryStatus();
    if (!binary.available) throw new LocalRuntimeError('binary_unavailable', binary.reason ?? 'Cursor CLI binary is unavailable.');
    if (binary.drift) throw new LocalRuntimeError('binary_drift', 'The local Cursor CLI binary digest differs from the administrator pin.');
    const configuredConfigDir = nonEmpty(this.env.CURSOR_LOCAL_CLI_CONFIG_DIR);
    if (configuredConfigDir && !path.isAbsolute(configuredConfigDir)) {
      throw new LocalRuntimeError('invalid_configuration', 'CURSOR_LOCAL_CLI_CONFIG_DIR must be an absolute path; it will not fall back to HOME.');
    }
    const config = await inspectPermissionConfig(this.env, workspace);
    permissionReady(config, value.mode);
    const home = nonEmpty(this.env.CURSOR_LOCAL_CLI_HOME) ?? nonEmpty(this.env.HOME);
    if (!home || !path.isAbsolute(home)) throw new LocalRuntimeError('local_home_required', 'CURSOR_LOCAL_CLI_HOME or HOME must be an absolute directory for host-trusted runs.');
    const workspaceAttestation = await attestDirectory(workspace, 'Cursor workspace');
    const homeAttestation = await attestDirectory(home, 'Cursor local CLI home', { ownerOnly: true });
    const configDir = configDirectory(this.env);
    if (!configDir || !path.isAbsolute(configDir)) throw new LocalRuntimeError('invalid_configuration', 'CURSOR_LOCAL_CLI_CONFIG_DIR or HOME must resolve to an absolute Cursor config directory.');
    const configAttestation = await attestDirectory(configDir, 'Cursor local CLI config directory', { ownerOnly: true });
    return {
      workspace: workspaceAttestation.path,
      workspaceIdentity: workspaceAttestation.identity,
      binary,
      config,
      home: homeAttestation.path,
      homeIdentity: homeAttestation.identity,
      configDir: configAttestation.path,
      configIdentity: configAttestation.identity,
      boundary: 'host_trusted',
    };
  }

  async revalidateRunEnvironment(value, environment) {
    const workspace = await allowedWorkspace(value.workspace, this.env);
    const workspaceAttestation = await attestDirectory(workspace, 'Cursor workspace');
    const homeValue = nonEmpty(this.env.CURSOR_LOCAL_CLI_HOME) ?? nonEmpty(this.env.HOME);
    const configuredConfigDir = nonEmpty(this.env.CURSOR_LOCAL_CLI_CONFIG_DIR);
    if (configuredConfigDir && !path.isAbsolute(configuredConfigDir)) {
      throw new LocalRuntimeError('environment_changed', 'CURSOR_LOCAL_CLI_CONFIG_DIR became relative before spawn.');
    }
    const configValue = configDirectory(this.env);
    const homeAttestation = await attestDirectory(homeValue, 'Cursor local CLI home', { ownerOnly: true });
    const configAttestation = await attestDirectory(configValue, 'Cursor local CLI config directory', { ownerOnly: true });
    const binary = await this.binaryStatus();
    if (!binary.available || binary.path !== environment.binary.path
      || !sameFileIdentity(binary.identity, environment.binary.identity)
      || binary.sha256 !== environment.binary.sha256) {
      throw new LocalRuntimeError('environment_changed', 'The local execution environment changed before spawn.');
    }
    const config = await inspectPermissionConfig(this.env, workspaceAttestation.path);
    permissionReady(config, value.mode);
    if (config.digest !== environment.config.digest
      || workspaceAttestation.path !== environment.workspace
      || !sameFileIdentity(workspaceAttestation.identity, environment.workspaceIdentity)
      || homeAttestation.path !== environment.home
      || !sameFileIdentity(homeAttestation.identity, environment.homeIdentity)
      || configAttestation.path !== environment.configDir
      || !sameFileIdentity(configAttestation.identity, environment.configIdentity)) {
      throw new LocalRuntimeError('environment_changed', 'The local execution environment changed before spawn.');
    }
  }

  async run(value) {
    await this.reconcilePersistedRuns();
    const environment = await this.verifyRunEnvironment(value);
    const ownerStart = await this.ownerStartPromise;
    if (ownerStart === null) throw new LocalRuntimeError('process_identity_unavailable', 'The MCP process start identity could not be attested.');
    const readiness = await this.ledger.ensure();
    const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const waitMs = value.waitMs ?? DEFAULT_WAIT_MS;
    const maxEvents = value.maxEvents ?? DEFAULT_MAX_EVENTS;
    const maxBytes = value.maxBytes ?? DEFAULT_MAX_BYTES;
    const promptDigest = digest(value.prompt);
    const requestDigest = digest({ kind: 'local-cli-run', executionProfile: value.execution_profile, workspace: environment.workspace, mode: value.mode, model: value.model ?? null, promptDigest });
    const existing = await this.ledger.findRequest(value.requestId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new LocalRuntimeError('request_conflict', 'The local requestId was already used for a different request.');
      return { ok: true, receipt: { ...publicRecord(existing, { maxEvents, maxBytes, secrets: this.secrets() }), duplicate: true } };
    }
    const localId = `lrun-${randomUUID()}`;
    const worktreeName = `cursor-local-${localId.slice(5, 21)}`;
    const args = buildArguments({ workspace: environment.workspace, prompt: value.prompt, mode: value.mode, model: value.model, worktreeName, executionProfile: value.execution_profile });
    const startedAt = new Date().toISOString();
    const record = {
      localRunId: localId,
      requestId: value.requestId ?? null,
      requestDigest,
      surface: 'local-cli',
      contractVersion: 1,
      lifecycle: 'accepted',
      terminalState: null,
      mode: value.mode,
      workspace: environment.workspace,
      execution: {
        strategy: 'cursor-cli-direct',
        executionProfile: 'host_trusted',
        boundary: 'host_trusted',
        authority: 'mcp_process_user',
        outerSandbox: 'none',
        providerSandbox: 'disabled',
        ownerPid: process.pid,
        ownerStart,
        childPid: null,
        childStart: null,
        processGroupId: null,
        worktreeName,
        cwd: null,
      },
      binary: { path: environment.binary.path, version: environment.binary.version ?? null, sha256: environment.binary.sha256 ?? null },
      permissionProfile: value.mode,
      auth: { method: typeof this.env.CURSOR_LOCAL_CLI_API_KEY === 'string' && this.env.CURSOR_LOCAL_CLI_API_KEY ? 'api_key_env' : 'browser_or_unknown' },
      timeoutMs,
      startedAt,
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      workspaceChanged: null,
      workspaceChangeProof: 'not_attested_host_trusted',
      sandbox: { outer: 'none', provider: 'disabled' },
      logs: { format: 'stream-json', events: [], bytes: 0, truncated: false },
    };
    const persisted = await this.ledger.add(record);
    if (persisted?.localRunId !== localId) {
      return { ok: true, receipt: { ...publicRecord(persisted, { maxEvents, maxBytes, secrets: this.secrets() }), duplicate: true } };
    }
    try {
      await this.revalidateRunEnvironment(value, environment);
    } catch (error) {
      record.lifecycle = 'terminal';
      record.terminalState = 'environment_blocked';
      record.error = error?.code ?? 'environment_changed';
      record.finishedAt = new Date().toISOString();
      record.durationMs = 0;
      await this.ledger.update(localId, () => ({ ...record }));
      throw error;
    }
    const childEnv = childEnvironment(this.env, { home: environment.home, configDir: environment.configDir });
    let child;
    try {
      child = this.spawnImpl(environment.binary.path, args, {
        cwd: environment.workspace,
        env: childEnv,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      record.lifecycle = 'terminal';
      record.terminalState = 'failed';
      record.error = error?.code ?? 'spawn_error';
      record.finishedAt = new Date().toISOString();
      record.durationMs = 0;
      await this.ledger.update(localId, () => ({ ...record }));
      throw new LocalRuntimeError('spawn_failed', 'Unable to start the local Cursor CLI process.');
    }
    record.execution.childPid = Number.isSafeInteger(child?.pid) ? child.pid : null;
    // Attach stream/exit handlers before any asynchronous procfs lookup: a
    // short-lived CLI can emit and close during that lookup.
    record.execution.childStart = record.execution.childPid === null ? null : 'unknown';
    record.execution.processGroupId = record.execution.childPid;
    // Read the token synchronously in the spawn return path as well as via the
    // async fallback.  A CLI can finish before an awaited procfs read runs;
    // the immediate descriptor identity is what lets us both persist and
    // safely reap such short-lived launches.
    const immediateChildStart = record.execution.childPid === null ? null : processStartTokenSync(record.execution.childPid);
    const childStartPromise = record.execution.childPid === null || immediateChildStart !== null
      ? Promise.resolve(immediateChildStart)
      : processStartToken(record.execution.childPid);
    let resolveLaunchReady;
    const launchReady = new Promise((resolve) => { resolveLaunchReady = resolve; });
    const runtime = {
      record,
      child,
      startedAtMs: Date.now(),
      cancelRequested: false,
      timeoutHandle: null,
      done: null,
      systemEventSeen: false,
      launchReady,
      childStart: null,
      identityAttested: false,
    };
    this.active.set(localId, runtime);
    const cleanupProcessGroup = (options = {}) => terminateProcessGroup(child, {
      ...options,
      startToken: runtime.childStart,
    });
    const collector = createNdjsonCollector({ maxEvents, maxBytes, secrets: this.secrets(), onEvent: (event) => {
      if (event.type === 'system') runtime.systemEventSeen = true;
      if (event.cwd) {
        const worktreeRoot = path.join(path.resolve(environment.home), '.cursor', 'worktrees');
        const allowedCwd = record.mode === 'implement'
          ? isPathWithin(worktreeRoot, event.cwd)
          : isPathWithin(environment.workspace, event.cwd) || isPathWithin(worktreeRoot, event.cwd);
        if (!allowedCwd) {
          runtime.environmentBlocked = true;
          void cleanupProcessGroup().catch(() => {});
        }
      }
      if (event.cwd) record.execution.cwd = event.cwd;
      record.logs.events.push(event);
      if (record.logs.events.length > maxEvents) record.logs.events = record.logs.events.slice(-maxEvents);
      record.logs.bytes = Math.min(maxBytes, record.logs.bytes + Buffer.byteLength(JSON.stringify(event), 'utf8'));
      if (record.logs.bytes >= maxBytes) record.logs.truncated = true;
      if (event.type === 'result') record.result = event.result ?? null;
      void this.ledger.update(localId, (entry) => ({ ...entry, lifecycle: 'working', logs: record.logs, execution: record.execution, result: record.result ?? null }));
    } });
    const stderrCollector = createStrictTextCollector({ maxBytes });
    child.stdout?.on('data', (chunk) => collector.push(chunk));
    child.stderr?.on('data', (chunk) => stderrCollector.push(chunk));
    runtime.done = new Promise((resolve) => {
      const finish = async (code, signal) => {
        if (runtime.finishPromise) return runtime.finishPromise;
        runtime.finished = true;
        runtime.finishPromise = (async () => {
          try {
            // If close/error raced the procfs lookup, wait until launch
            // ownership has either been durably recorded or failed closed.
            await runtime.launchReady;
            if (runtime.timeoutHandle) clearTimeout(runtime.timeoutHandle);
            // `close` describes the leader, not necessarily every member of
            // its detached process group.  Reap descendants after leader exit
            // only with the exact start token captured for this launch.
            try { await cleanupProcessGroup({ graceMs: 250 }); } catch { runtime.descendantCleanupFailed = true; }
            const collected = collector.finish();
            const stderr = stderrCollector.finish();
            const stderrEvent = stderr.bytes > 0 || stderr.invalidUtf8
              ? { type: 'stderr', text: redactText(stderr.text, this.secrets()), ...(stderr.invalidUtf8 ? { invalidUtf8: true } : {}) }
              : null;
            const bounded = boundEvents(
              [...collected.events, ...(stderrEvent ? [stderrEvent] : [])],
              { maxEvents, maxBytes, secrets: this.secrets() },
            );
            record.logs.events = bounded.events;
            record.logs.bytes = bounded.bytes;
            record.logs.truncated ||= collected.truncated || stderr.truncated || bounded.truncated;
            record.logs.invalidUtf8 ||= collected.invalidUtf8 || stderr.invalidUtf8;
            record.exitCode = Number.isInteger(code) ? code : null;
            record.signal = signal ?? null;
            record.finishedAt = new Date().toISOString();
            record.durationMs = Date.now() - runtime.startedAtMs;
            const expectedWorktreeRoot = path.join(path.resolve(environment.home), '.cursor', 'worktrees');
            const cwdAttested = record.execution.cwd && (record.mode === 'implement'
              ? isPathWithin(expectedWorktreeRoot, record.execution.cwd)
              : isPathWithin(environment.workspace, record.execution.cwd) || isPathWithin(expectedWorktreeRoot, record.execution.cwd));
            if (!runtime.systemEventSeen || !cwdAttested) {
              runtime.environmentBlocked = true;
            }
            // A direct host-trusted process has no outer filesystem observer.
            // Do not report a clean workspace as proof merely because Cursor
            // exited.
            record.workspaceChanged = null;
            record.lifecycle = 'terminal';
            record.terminalState = runtime.descendantCleanupFailed || runtime.identityUnavailable || runtime.launchPersistenceFailed ? 'transport_lost'
              : runtime.environmentBlocked ? 'environment_blocked'
                : runtime.cancelRequested ? 'cancelled'
                  : runtime.timedOut ? 'timed_out'
                    : code === 0 ? 'succeeded' : 'failed';
            if (record.mode === 'read_only' && record.workspaceChanged) record.terminalState = 'workspace_changed';
            await this.ledger.update(localId, () => ({ ...record }));
          } catch (error) {
            // A ledger/cleanup failure must not strand runtime.done forever or
            // leave an accepted/working receipt pretending to be durable.
            record.lifecycle = 'terminal';
            record.terminalState = 'transport_lost';
            record.error ||= error?.code ?? 'local_runtime_failed';
            record.finishedAt ||= new Date().toISOString();
            record.durationMs ??= Date.now() - runtime.startedAtMs;
            await this.ledger.update(localId, () => ({ ...record })).catch(() => {});
          } finally {
            this.active.delete(localId);
            resolve();
          }
        })();
        return runtime.finishPromise;
      };
      child.once?.('error', (error) => { record.error = error.code ?? 'spawn_error'; void finish(null, null); });
      child.once?.('close', (...args) => { void finish(...args); });
      runtime.timeoutHandle = setTimeout(() => {
        runtime.timedOut = true;
        void cleanupProcessGroup().catch(() => {});
      }, timeoutMs);
    });

    // Capture and durably persist the child start identity before this method
    // can return.  A process that exits before procfs can be read is marked
    // transport_lost; its unknown PID/group is intentionally never signalled.
    let launchError = null;
    try {
      runtime.childStart = await childStartPromise;
      record.execution.childStart = runtime.childStart ?? 'unknown';
      runtime.identityAttested = runtime.childStart !== null;
      if (!runtime.identityAttested) runtime.identityUnavailable = true;
      const launched = await this.ledger.update(localId, (entry) => ({
        ...entry,
        lifecycle: 'started',
        execution: { ...entry.execution, childPid: record.execution.childPid, childStart: record.execution.childStart, processGroupId: record.execution.processGroupId },
      }));
      if (!launched) throw new LocalRuntimeError('launch_persist_failed', 'The local launch ownership record disappeared before spawn completed.');
      if (runtime.identityUnavailable) {
        record.lifecycle = 'terminal';
        record.terminalState = 'transport_lost';
        record.error = 'process_identity_unavailable';
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - runtime.startedAtMs;
        await this.ledger.update(localId, () => ({ ...record }));
        launchError = new LocalRuntimeError('process_identity_unavailable', 'The local child start identity could not be attested.');
      }
    } catch (error) {
      runtime.launchPersistenceFailed = true;
      record.error ||= error?.code ?? 'launch_persist_failed';
      launchError = error instanceof LocalRuntimeError
        ? error
        : new LocalRuntimeError('launch_persist_failed', 'Unable to durably record local launch ownership.');
      if (runtime.identityAttested) await cleanupProcessGroup().catch(() => {});
    } finally {
      resolveLaunchReady();
    }
    if (launchError) {
      await Promise.race([runtime.done, sleep(5_000)]);
      throw launchError;
    }
    await Promise.race([runtime.done, sleep(waitMs)]);
    const current = await this.ledger.find(localId);
    return { ok: true, receipt: publicRecord(current ?? record, { maxEvents, maxBytes, secrets: this.secrets() }) };
  }

  async runs(value) {
    await this.reconcilePersistedRuns();
    const current = await this.ledger.find(value.localRunId);
    if (!current) throw new LocalRuntimeError('not_found', `Unknown local run ${value.localRunId}.`);
    if (value.action === 'get') return { ok: true, run: publicRecord(current, { secrets: this.secrets() }) };
    if (value.action === 'logs') return { ok: true, localRunId: current.localRunId, logs: publicRecord(current, { maxEvents: value.maxEvents, maxBytes: value.maxBytes, secrets: this.secrets() }).logs };
    const runtime = this.active.get(value.localRunId);
    if (!runtime) throw new LocalRuntimeError('not_running', 'The local run is not owned by this MCP process and cannot be cancelled.');
    runtime.cancelRequested = true;
    await terminateProcessGroup(runtime.child, { startToken: runtime.childStart });
    await Promise.race([runtime.done, sleep(5_000)]);
    const updated = await this.ledger.find(value.localRunId);
    return { ok: true, cancelled: true, run: publicRecord(updated ?? current, { secrets: this.secrets() }) };
  }

  async shutdown() {
    const runtimes = [...this.active.values()];
    for (const runtime of runtimes) {
      runtime.cancelRequested = true;
      await terminateProcessGroup(runtime.child, { startToken: runtime.childStart }).catch(() => {});
    }
    await Promise.all(runtimes.map((runtime) => Promise.race([runtime.done, sleep(5_000)])));
  }

  async call(name, rawArguments) {
    if (!['status', 'run', 'runs'].includes(name)) throw new LocalInputError('unknown_tool', `Unknown local tool ${name}.`);
    if (name !== 'status' && !hostTrustedRunsEnabled(this.env)) {
      throw new LocalRuntimeError('foundation_not_exposed', 'Host-trusted local execution is disabled; use status or enable CURSOR_LOCAL_CLI_ENABLE_HOST_TRUSTED_RUNS=1 in the administrator MCP environment.');
    }
    const value = validateToolInput(name, rawArguments ?? {});
    if (name === 'status') return this.status(value);
    if (name === 'run') return this.run(value);
    if (name === 'runs') return this.runs(value);
    throw new LocalInputError('unknown_tool', `Unknown local tool ${name}.`);
  }
}

function errorResult(error, secrets = []) {
  const safe = redactError(error, secrets);
  return { ok: false, error: safe };
}

export async function handleToolCall(name, rawArguments, service = new CursorLocalService()) {
  try {
    const payload = await service.call(name, rawArguments);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  } catch (error) {
    const payload = errorResult(error, service.secrets());
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
}

export async function runStdio({ input = process.stdin, output = process.stdout, service = new CursorLocalService() } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } })}\n`);
        continue;
      }
      if (message.method?.startsWith('notifications/')) continue;
      if (message.method === 'initialize') {
        const requested = message.params?.protocolVersion;
        const negotiated = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_IDENTITY,
          instructions: 'Cursor Local Control invokes only the administrator-selected local Cursor CLI. Host-trusted runs use the MCP process user with no outer sandbox; local IDs, state, logs, credentials, and permissions are separate from Cursor Cloud Control.',
        } })}\n`);
        continue;
      }
      if (message.method === 'ping') { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`); continue; }
      if (message.method === 'tools/list') { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: service.tools() } })}\n`); continue; }
      if (message.method === 'tools/call') {
        const result = await handleToolCall(message.params?.name, message.params?.arguments ?? {}, service);
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
        continue;
      }
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method ${message.method ?? 'unknown'} not found.` } })}\n`);
    }
  } finally {
    await service.shutdown?.();
  }
}

if (process.argv.includes('--stdio')) {
  try { await runStdio(); } catch (error) {
    process.stderr.write(`${redactError(error).message}\n`);
    process.exitCode = 1;
  }
}
