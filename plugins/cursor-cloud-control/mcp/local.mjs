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
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { redactError, redactText } from './redaction.mjs';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2024-11-05']);
export const SERVER_IDENTITY = Object.freeze({ name: 'cursor-local-control', version: '0.1.0' });

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
export const LOCAL_RUN_ID_PATTERN = /^lrun-[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/ -]{0,255}$/;
const SAFE_EVENT_TYPE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_EVENT_LINE_BYTES = 256 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_LEDGER_RECORDS = 200;
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
      model: { type: 'string', minLength: 1, maxLength: MAX_MODEL_CHARS },
      timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
      waitMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS },
      maxEvents: { type: 'integer', minimum: 1, maximum: MAX_EVENTS, default: DEFAULT_MAX_EVENTS },
      maxBytes: { type: 'integer', minimum: 1_024, maximum: MAX_BYTES, default: DEFAULT_MAX_BYTES },
      requestId: { type: 'string', minLength: 8, maxLength: 128, pattern: REQUEST_ID_PATTERN.source },
    },
    required: ['workspace', 'prompt', 'mode'],
    additionalProperties: false,
  },
  runs: {
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

// The process-facing catalog is intentionally status-only until a real host
// acceptance run proves the native boundary around a Cursor process. The
// typed run/runs foundation remains packaged for review and future versioning,
// but it is not reachable through this release's MCP surface.
export const TOOLS = Object.freeze([FOUNDATION_TOOLS[0]]);

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
    unknown(value, ['workspace', 'prompt', 'mode', 'model', 'timeoutMs', 'waitMs', 'maxEvents', 'maxBytes', 'requestId']);
    absolutePath(value.workspace, 'arguments.workspace');
    string(value.prompt, 'arguments.prompt', { min: 1, max: MAX_PROMPT_CHARS });
    if (!['read_only', 'implement'].includes(value.mode)) fail('arguments.mode must be read_only or implement.');
    string(value.model, 'arguments.model', { min: 1, max: MAX_MODEL_CHARS, optional: true });
    integer(value.timeoutMs, 'arguments.timeoutMs', { min: 1_000, max: MAX_TIMEOUT_MS, optional: true });
    integer(value.waitMs, 'arguments.waitMs', { min: 0, max: MAX_WAIT_MS, optional: true });
    integer(value.maxEvents, 'arguments.maxEvents', { min: 1, max: MAX_EVENTS, optional: true });
    integer(value.maxBytes, 'arguments.maxBytes', { min: 1_024, max: MAX_BYTES, optional: true });
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
  let metadata;
  try { metadata = await lstat(file); } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return false;
    throw new LocalRuntimeError(error?.code ?? 'state_unavailable', `Unable to inspect ${label}.`);
  }
  assertOwnerOnly(metadata, label);
  if (metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o600) throw new LocalRuntimeError('state_permissions', `${label} must have mode 0600 and one hard link.`);
  return true;
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export class LocalRunLedger {
  constructor({ stateDir, source = 'environment', reason = null } = {}) {
    this.stateDir = stateDir ?? null;
    this.source = source;
    this.reason = reason;
    this.file = this.stateDir ? path.join(this.stateDir, 'runs.json') : null;
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

  async read() {
    await this.ensure();
    let content;
    try { content = await readFile(this.file, 'utf8'); } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, runs: [] };
      throw new LocalRuntimeError('state_unavailable', 'Unable to read the local run ledger.');
    }
    try {
      const parsed = JSON.parse(content);
      if (parsed?.version !== 1 || !Array.isArray(parsed.runs) || parsed.runs.length > MAX_LEDGER_RECORDS) throw new Error('invalid shape');
      return parsed;
    } catch {
      throw new LocalRuntimeError('state_corrupt', 'The local run ledger is corrupt.');
    }
  }

  async write(value) {
    await this.ensure();
    const payload = JSON.stringify({ version: 1, runs: value.runs.slice(-MAX_LEDGER_RECORDS) }, null, 2);
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

  async update(localRunId, updater) {
    this.queue = this.queue.then(async () => {
      const current = await this.read();
      const index = current.runs.findIndex((entry) => entry.localRunId === localRunId);
      if (index < 0) return null;
      current.runs[index] = updater(structuredClone(current.runs[index]));
      await this.write(current);
      return current.runs[index];
    });
    return this.queue;
  }

  async add(record) {
    this.queue = this.queue.then(async () => {
      const current = await this.read();
      current.runs = current.runs.filter((entry) => entry.localRunId !== record.localRunId && !(record.requestId && entry.requestId === record.requestId));
      current.runs.push(record);
      await this.write(current);
      return record;
    });
    return this.queue;
  }

  async find(localRunId) {
    const current = await this.read();
    return current.runs.find((entry) => entry.localRunId === localRunId) ?? null;
  }

  async findRequest(requestId) {
    if (!requestId) return null;
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

async function ownerOnlyPath(value, label) {
  if (!value || !path.isAbsolute(value)) throw new LocalRuntimeError('invalid_configuration', `${label} must be an absolute path.`);
  let metadata;
  try { metadata = await lstat(value); } catch { throw new LocalRuntimeError('configuration_unavailable', `${label} is unavailable.`); }
  assertOwnerOnly(metadata, label, { directory: true });
  if ((metadata.mode & 0o7777) !== 0o700) throw new LocalRuntimeError('state_permissions', `${label} must have mode 0700.`);
  return value;
}

function configDirectory(env) {
  const configured = nonEmpty(env.CURSOR_LOCAL_CLI_CONFIG_DIR);
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  const home = nonEmpty(env.HOME);
  if (home && path.isAbsolute(home)) return path.join(home, '.cursor');
  return null;
}

async function inspectPermissionConfig(env, workspace) {
  const directory = configDirectory(env);
  if (!directory) return { configured: false, reason: 'CURSOR_LOCAL_CLI_CONFIG_DIR or absolute HOME is required.' };
  let metadata;
  try { metadata = await lstat(directory); } catch { return { configured: false, path: path.join(directory, 'cli-config.json'), reason: 'config directory is unavailable' }; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    return { configured: false, path: path.join(directory, 'cli-config.json'), reason: 'config directory must be a real owner-only directory' };
  }
  const globalPath = path.join(directory, 'cli-config.json');
  let global = null;
  try {
    await lstat(globalPath);
    await secureFile(globalPath, 'Cursor local CLI config', { allowMissing: false });
    global = JSON.parse(await readFile(globalPath, 'utf8'));
  } catch (error) {
    return { configured: false, path: globalPath, reason: error.code === 'ENOENT' ? 'cli-config.json is absent' : 'cli-config.json is invalid or not owner-only' };
  }
  if (global?.version !== 1 || !global.permissions || !Array.isArray(global.permissions.allow) || !Array.isArray(global.permissions.deny)) {
    return { configured: false, path: globalPath, reason: 'cli-config.json does not match schema version 1' };
  }
  const projectPath = workspace ? path.join(workspace, '.cursor', 'cli.json') : null;
  let project = null;
  if (projectPath) {
    try {
      await lstat(projectPath);
      await secureFile(projectPath, 'Project Cursor local CLI permissions', { allowMissing: false });
      project = JSON.parse(await readFile(projectPath, 'utf8'));
      if (!project?.permissions || !Array.isArray(project.permissions.allow) || !Array.isArray(project.permissions.deny)) {
        return { configured: false, path: globalPath, projectPath, reason: 'project cli.json has an invalid permission shape' };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') return { configured: false, path: globalPath, projectPath, reason: 'project cli.json is invalid or not owner-only' };
    }
  }
  const allow = [...global.permissions.allow, ...(project?.permissions?.allow ?? [])];
  const deny = [...global.permissions.deny, ...(project?.permissions?.deny ?? [])];
  const approvalMode = global.approvalMode ?? 'default';
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

async function binaryMetadata(binaryPath, { expectedSha256 = null, label = 'binary' } = {}) {
  if (!binaryPath) return { available: false, path: null, reason: 'binary path is not configured' };
  let metadata;
  try { metadata = await lstat(binaryPath); } catch (error) {
    return { available: false, path: binaryPath, reason: error?.code === 'ENOENT' ? 'binary is absent' : 'binary is unavailable' };
  }
  if (metadata.isSymbolicLink()) {
    try { binaryPath = await realpath(binaryPath); metadata = await lstat(binaryPath); } catch { return { available: false, path: binaryPath, reason: 'binary symlink target is unavailable' }; }
  }
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) return { available: false, path: binaryPath, reason: `${label} must be an executable regular file` };
  if (metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0) return { available: false, path: binaryPath, reason: `${label} must not be group/other-writable and must have one hard link` };
  if (metadata.size > MAX_BINARY_BYTES) return { available: false, path: binaryPath, reason: 'binary exceeds the configured size bound' };
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(binaryPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const sha256 = hash.digest('hex');
  const digestConfigured = typeof expectedSha256 === 'string' && SANDBOX_DIGEST_PATTERN.test(expectedSha256);
  return {
    available: true,
    path: binaryPath,
    sha256,
    expectedSha256: digestConfigured ? expectedSha256 : null,
    digestConfigured,
    drift: digestConfigured ? sha256 !== expectedSha256 : null,
    sizeBytes: metadata.size,
    mode: metadata.mode & 0o7777,
  };
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

export function buildArguments({ workspace, prompt, mode, model, worktreeName }) {
  const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--sandbox', 'enabled', '--trust', '--workspace', workspace];
  if (mode === 'implement') args.push('--worktree', worktreeName);
  if (mode === 'read_only') args.push('--mode', 'ask');
  else args.push('--force');
  if (model !== undefined) args.push('--model', model);
  args.push(prompt);
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
  let pending = '';
  let bytes = 0;
  let truncated = false;
  const events = [];
  const parseLine = (line) => {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > MAX_EVENT_LINE_BYTES) { truncated = true; return; }
    bytes += lineBytes;
    if (bytes > maxBytes) { truncated = true; return; }
    let parsed;
    try { parsed = JSON.parse(line); } catch { parsed = { type: 'invalid', message: 'invalid JSON event' }; }
    const event = normalizeEvent(parsed, secrets);
    if (events.length < maxEvents) events.push(event);
    else truncated = true;
    onEvent(event);
  };
  return {
    push(chunk) {
      if (truncated && bytes >= maxBytes) return;
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(pending, 'utf8') > MAX_EVENT_LINE_BYTES && !pending.includes('\n')) { truncated = true; return; }
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        parseLine(line);
        if (bytes >= maxBytes || truncated && events.length >= maxEvents) break;
      }
    },
    finish() {
      if (pending && bytes < maxBytes && !truncated) parseLine(pending);
      return { events, bytes: Math.min(bytes, maxBytes), truncated };
    },
  };
}

function processKill(child) {
  if (!child?.pid) return false;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw new LocalRuntimeError('cancel_failed', 'Unable to signal the owned local process group.');
  }
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

function publicRecord(record, { maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, secrets = [] } = {}) {
  const output = structuredClone(record);
  output.logs = {
    format: 'stream-json',
    events: (record.logs?.events ?? []).slice(0, maxEvents),
    bytes: Math.min(record.logs?.bytes ?? 0, maxBytes),
    truncated: Boolean(record.logs?.truncated),
  };
  delete output.pid;
  delete output.argv;
  delete output.promptDigest;
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
  }

  secrets() { return localSecrets(this.env); }

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
        runEnabled: false,
        sandboxReady: sandbox.ready === true,
        runUnavailableReason: 'Local provider execution is intentionally deferred pending real host acceptance of Cursor inside the native boundary; no provider child is spawned by this release.',
        readOnlyDefault: true,
        implementDeferredUntilHostAcceptance: true,
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
    const workspace = await allowedWorkspace(value.workspace, this.env);
    const binary = await this.binaryStatus();
    if (!binary.available) throw new LocalRuntimeError('binary_unavailable', binary.reason ?? 'Cursor CLI binary is unavailable.');
    if (!binary.digestConfigured) throw new LocalRuntimeError('binary_digest_unpinned', 'CURSOR_LOCAL_CLI_SHA256 must pin the local Cursor CLI binary before a run.');
    if (binary.drift) throw new LocalRuntimeError('binary_drift', 'The local Cursor CLI binary digest differs from the administrator pin.');
    const config = await inspectPermissionConfig(this.env, workspace);
    permissionReady(config, value.mode);
    const home = nonEmpty(this.env.CURSOR_LOCAL_CLI_HOME);
    if (!home || !path.isAbsolute(home)) throw new LocalRuntimeError('isolated_home_required', 'CURSOR_LOCAL_CLI_HOME must be an absolute owner-only directory for local runs.');
    await ownerOnlyPath(home, 'CURSOR_LOCAL_CLI_HOME');
    const configDir = configDirectory(this.env);
    if (!nonEmpty(this.env.CURSOR_LOCAL_CLI_CONFIG_DIR) || !configDir || !path.isAbsolute(configDir)) throw new LocalRuntimeError('invalid_configuration', 'CURSOR_LOCAL_CLI_CONFIG_DIR must be explicitly configured as an absolute directory.');
    await ownerOnlyPath(configDir, 'CURSOR_LOCAL_CLI_CONFIG_DIR');
    const sandbox = await nativeSandboxStatus(this.env, this.execFileImpl);
    if (!sandbox.ready) throw new LocalRuntimeError('sandbox_unavailable', sandbox.reason ?? 'A passing native sandbox preflight is required before a local run.');
    return { workspace, binary, config, home, configDir, sandbox };
  }

  async run(value) {
    throw new LocalRuntimeError('foundation_not_exposed', 'Local provider execution is deferred pending real host acceptance; this MCP release never spawns Cursor.');
    /* c8 ignore next -- retained foundation code is unreachable by design. */
    const environment = await this.verifyRunEnvironment(value);
    const readiness = await this.ledger.ensure();
    const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const waitMs = value.waitMs ?? DEFAULT_WAIT_MS;
    const maxEvents = value.maxEvents ?? DEFAULT_MAX_EVENTS;
    const maxBytes = value.maxBytes ?? DEFAULT_MAX_BYTES;
    const promptDigest = digest(value.prompt);
    const requestDigest = digest({ kind: 'local-cli-run', workspace: environment.workspace, mode: value.mode, model: value.model ?? null, promptDigest });
    const existing = await this.ledger.findRequest(value.requestId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new LocalRuntimeError('request_conflict', 'The local requestId was already used for a different request.');
      return { ok: true, receipt: { ...publicRecord(existing, { maxEvents, maxBytes, secrets: this.secrets() }), duplicate: true } };
    }
    const localId = `lrun-${randomUUID()}`;
    const worktreeName = `cursor-local-${localId.slice(5, 21)}`;
    const args = buildArguments({ workspace: environment.workspace, prompt: value.prompt, mode: value.mode, model: value.model, worktreeName });
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
      execution: { strategy: 'cursor-cli-worktree', worktreeName, cwd: null },
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
      workspaceChangeProof: 'native-sandbox-readonly-target',
      sandbox: { path: environment.sandbox.path, sha256: environment.sandbox.sha256 },
      logs: { format: 'stream-json', events: [], bytes: 0, truncated: false },
    };
    await this.ledger.add(record);
    const childEnv = childEnvironment(this.env, { home: environment.home, configDir: environment.configDir });
    const sandboxArgs = buildSandboxArguments({
      sandboxPath: environment.sandbox.path,
      home: environment.home,
      configDir: environment.configDir,
      workspace: environment.workspace,
      binaryPath: environment.binary.path,
      cursorArguments: args,
    });
    const child = this.spawnImpl(environment.sandbox.path, sandboxArgs, {
      cwd: '/',
      env: childEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runtime = { record, child, startedAtMs: Date.now(), cancelRequested: false, timeoutHandle: null, done: null, systemEventSeen: false };
    this.active.set(localId, runtime);
    const collector = createNdjsonCollector({ maxEvents, maxBytes, secrets: this.secrets(), onEvent: (event) => {
      if (event.type === 'system') runtime.systemEventSeen = true;
      if (event.cwd) {
        const worktreeRoot = path.join(path.resolve(environment.home), '.cursor', 'worktrees');
        const allowedCwd = record.mode === 'implement'
          ? isPathWithin(worktreeRoot, event.cwd)
          : isPathWithin(environment.workspace, event.cwd) || isPathWithin(worktreeRoot, event.cwd);
        if (!allowedCwd) {
          runtime.environmentBlocked = true;
          try { processKill(child); } catch {}
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
    record.lifecycle = 'started';
    void this.ledger.update(localId, (entry) => ({ ...entry, lifecycle: 'started' }));
    child.stdout?.on('data', (chunk) => collector.push(chunk));
    child.stderr?.on('data', (chunk) => {
      const valueText = redactText(chunk.toString('utf8'), this.secrets());
      if (record.logs.events.length < maxEvents && record.logs.bytes < maxBytes) record.logs.events.push({ type: 'stderr', text: valueText });
      else record.logs.truncated = true;
    });
    runtime.done = new Promise((resolve) => {
      const finish = async (code, signal) => {
        if (runtime.finished) return;
        runtime.finished = true;
        if (runtime.timeoutHandle) clearTimeout(runtime.timeoutHandle);
        const collected = collector.finish();
        record.logs.events = collected.events;
        record.logs.bytes = collected.bytes;
        record.logs.truncated ||= collected.truncated;
        record.exitCode = Number.isInteger(code) ? code : null;
        record.signal = signal ?? null;
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - runtime.startedAtMs;
        const expectedWorktreeRoot = path.join(path.resolve(environment.home), '.cursor', 'worktrees');
        if (!runtime.systemEventSeen || (record.mode === 'implement' && !isPathWithin(expectedWorktreeRoot, record.execution.cwd))) {
          runtime.environmentBlocked = true;
        }
        record.workspaceChanged = runtime.environmentBlocked ? null : false;
        record.lifecycle = 'terminal';
        record.terminalState = runtime.environmentBlocked ? 'environment_blocked'
          : runtime.cancelRequested ? 'cancelled'
            : runtime.timedOut ? 'timed_out'
              : code === 0 ? 'succeeded' : 'failed';
        if (record.mode === 'read_only' && record.workspaceChanged) record.terminalState = 'workspace_changed';
        await this.ledger.update(localId, () => ({ ...record }));
        this.active.delete(localId);
        resolve();
      };
      child.once?.('error', (error) => { record.error = error.code ?? 'spawn_error'; finish(null, null); });
      child.once?.('close', finish);
      runtime.timeoutHandle = setTimeout(() => {
        runtime.timedOut = true;
        try { processKill(child); } catch {}
      }, timeoutMs);
    });
    await Promise.race([runtime.done, sleep(waitMs)]);
    const current = await this.ledger.find(localId);
    return { ok: true, receipt: publicRecord(current ?? record, { maxEvents, maxBytes, secrets: this.secrets() }) };
  }

  async runs(value) {
    throw new LocalRuntimeError('foundation_not_exposed', 'Local process lifecycle is deferred pending real host acceptance; this MCP release never adopts or cancels local processes.');
    /* c8 ignore next -- retained foundation code is unreachable by design. */
    const current = await this.ledger.find(value.localRunId);
    if (!current) throw new LocalRuntimeError('not_found', `Unknown local run ${value.localRunId}.`);
    if (value.action === 'get') return { ok: true, run: publicRecord(current, { secrets: this.secrets() }) };
    if (value.action === 'logs') return { ok: true, localRunId: current.localRunId, logs: publicRecord(current, { maxEvents: value.maxEvents, maxBytes: value.maxBytes, secrets: this.secrets() }).logs };
    const runtime = this.active.get(value.localRunId);
    if (!runtime) throw new LocalRuntimeError('not_running', 'The local run is not owned by this MCP process and cannot be cancelled.');
    runtime.cancelRequested = true;
    processKill(runtime.child);
    await Promise.race([runtime.done, sleep(5_000)]);
    const updated = await this.ledger.find(value.localRunId);
    return { ok: true, cancelled: true, run: publicRecord(updated ?? current, { secrets: this.secrets() }) };
  }

  async call(name, rawArguments) {
    if (!['status', 'run', 'runs'].includes(name)) throw new LocalInputError('unknown_tool', `Unknown local tool ${name}.`);
    if (name !== 'status') throw new LocalRuntimeError('foundation_not_exposed', 'Local run and lifecycle tools are deferred pending real host acceptance; use status for this release.');
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
        instructions: 'Cursor Local Control invokes only the administrator-selected local Cursor CLI. Local IDs, state, logs, credentials, and permissions are separate from Cursor Cloud Control.',
      } })}\n`);
      continue;
    }
    if (message.method === 'ping') { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`); continue; }
    if (message.method === 'tools/list') { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })}\n`); continue; }
    if (message.method === 'tools/call') {
      const result = await handleToolCall(message.params?.name, message.params?.arguments ?? {}, service);
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      continue;
    }
    output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method ${message.method ?? 'unknown'} not found.` } })}\n`);
  }
}

if (process.argv.includes('--stdio')) {
  try { await runStdio(); } catch (error) {
    process.stderr.write(`${redactError(error).message}\n`);
    process.exitCode = 1;
  }
}
