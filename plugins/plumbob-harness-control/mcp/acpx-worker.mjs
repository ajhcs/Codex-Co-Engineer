/*
 * Disabled, provider-free ACPX conformance worker.
 *
 * This file is intentionally unwired from the MCP server.  Importing it has
 * no side effects and it exports no in-process API.  Environment replacement,
 * umask changes, and chdir are reachable only through direct CLI execution.
 *
 * Activation prerequisites that this inner worker cannot truthfully provide:
 *   1. an outer control plane must verify TargetContext and its fingerprint;
 *   2. Bubblewrap (or an equivalent outer sandbox) must enforce target mounts;
 *   3. a clean outer launcher environment must exist before Node starts;
 *   4. an outer process group/cgroup plus memory/process limits must contain it;
 *   5. the outer transport must bound ACP partial frames and queued events.
 *
 * The embedded ACPX parser can buffer an unterminated NDJSON frame, and its
 * internal event queue precedes this worker's compact projection.  Neither is
 * honestly bounded here; activation therefore requires an outer memory and
 * transport boundary.
 */

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const LIMITS = Object.freeze({
  maxInputLineBytes: 16 * 1024,
  maxPromptBytes: 4096,
  maxEventTextBytes: 512,
  maxEventsPerTurn: 64,
  maxOutputLineBytes: 2048,
  maxControlOutputBytes: 32 * 1024,
  maxTurnOutputBytes: 16 * 1024,
  terminalReserveBytes: 1024,
  maxPinnedAgentBytes: 64 * 1024,
  maxVolatileStoreBytes: 256 * 1024,
  absoluteJobDeadlineMs: 2500,
  controlDeadlineMs: 3000,
  upstreamOperationTimeoutMs: 30_000,
});

const AGENT_NAME = 'fake';
const ACPX_VERSION = '0.13.0';
const AGENT_BASENAME = 'acpx-fake-agent.mjs';
const PINNED_AGENT_PATH = fileURLToPath(new URL('../test/acpx-fake-agent.mjs', import.meta.url));
const PINNED_AGENT_SHA256 = '9a870b9a5b0544fa768aa4a7d4843a3d9cf9e67160f1ae572e1ccde56d8d95c7';
const PINNED_AGENT_ARGV0 = 'acpx-verified-fake-agent';
const FIXTURE_MODES = new Set([
  'normal',
  'raw-partial-frame',
  'silent-initialize',
  'silent-session-create',
]);
const MANAGED_DIRECTORY_MODE = 0o700;
const MANAGED_FILE_MODE = 0o600;
const MODE_MASK = 0o7777;
const JOB_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const BUNDLE_URL = new URL('../assets/acpx-runtime.mjs', import.meta.url);
const ACTIVATION_PREREQUISITES = Object.freeze([
  'verified-target-context-and-fingerprint',
  'outer-bubblewrap-target-policy',
  'outer-clean-launcher-environment',
  'outer-memory-and-process-limits',
  'outer-process-group-or-cgroup-reaping',
  'outer-bounded-acp-transport',
]);
const LOCAL_WORKER_ERROR = Symbol('local-worker-error');

function codedError(code, message) {
  return Object.assign(new Error(message), { code, [LOCAL_WORKER_ERROR]: true });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (utf8Bytes(text) <= limit) return text;
  const suffix = '…';
  const available = Math.max(0, limit - utf8Bytes(suffix));
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = utf8Bytes(character);
    if (used + size > available) break;
    result += character;
    used += size;
  }
  return `${result}${suffix}`;
}

function boundedError(error) {
  return truncateUtf8(error instanceof Error ? error.message : String(error), 256);
}

const PUBLIC_WORKER_ERROR_CODES = new Set([
  'busy',
  'input_too_large',
  'invalid_id',
  'invalid_json',
  'invalid_prompt',
  'invalid_reason',
  'invalid_request',
  'output_too_large',
  'prompt_too_large',
  'single_turn_only',
  'unsupported_op',
  'worker_closing',
  'worker_timeout',
]);

function publicWorkerError(error, fallbackCode = 'worker_error') {
  if (error?.[LOCAL_WORKER_ERROR] === true && PUBLIC_WORKER_ERROR_CODES.has(error?.code)) {
    return {
      code: error.code,
      message: boundedError(error),
    };
  }
  return {
    code: fallbackCode,
    message: 'ACP worker operation failed.',
  };
}

class AbsoluteDeadline {
  #expiresAt;

  constructor(milliseconds) {
    this.#expiresAt = Date.now() + milliseconds;
  }

  remainingMilliseconds() {
    return Math.max(0, this.#expiresAt - Date.now());
  }

  async run(promise, message) {
    const remaining = this.remainingMilliseconds();
    const guarded = Promise.resolve(promise);
    if (remaining === 0) {
      guarded.catch(() => {});
      throw codedError('worker_timeout', message);
    }
    let timer;
    try {
      return await Promise.race([
        guarded,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(codedError('worker_timeout', message)), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireSafeRequestId(value) {
  if (typeof value !== 'string' || !SAFE_REQUEST_ID_PATTERN.test(value)) {
    throw codedError('invalid_id', 'id must be a short safe string.');
  }
  return value;
}

function requireExactKeys(value, allowed) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw codedError('invalid_request', `unsupported request field: ${truncateUtf8(unexpected[0], 64)}`);
  }
}

function requirePrompt(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw codedError('invalid_prompt', 'prompt must be non-empty text.');
  }
  if (utf8Bytes(value) > LIMITS.maxPromptBytes) {
    throw codedError('prompt_too_large', 'prompt exceeds the worker byte bound.');
  }
  if (/[\u0000\u007f]/u.test(value)) {
    throw codedError('invalid_prompt', 'prompt contains an unsupported control character.');
  }
  return value;
}

function requireReason(value) {
  if (value === undefined) return 'cancelled';
  if (typeof value !== 'string' || utf8Bytes(value) > 128 || /[\u0000\u007f]/u.test(value)) {
    throw codedError('invalid_reason', 'reason must be at most 128 bytes without NUL or DEL.');
  }
  return value;
}

function requireAbsoluteNormalizedPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const normalized = resolve(value);
  if (normalized !== value) throw new Error(`${label} must already be normalized.`);
  return normalized;
}

function isSameOrWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function pathsOverlap(left, right) {
  return isSameOrWithin(left, right) || isSameOrWithin(right, left);
}

function unsafeBroadRoots() {
  return new Set([
    parse(process.cwd()).root,
    '/',
    '/tmp',
    '/var/tmp',
    '/mnt',
    '/mnt/d',
    homedir(),
  ].map((entry) => resolve(entry)));
}

function rejectBroadPath(path, label) {
  if (unsafeBroadRoots().has(path)) throw new Error(`${label} is an unsafe broad root.`);
}

async function canonicalExistingPath(path, label, expectedType) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (expectedType === 'directory' && !stat.isDirectory()) throw new Error(`${label} must be a directory.`);
  if (expectedType === 'file' && !stat.isFile()) throw new Error(`${label} must be a regular file.`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must be canonical and contain no path aliases.`);
  return { path: canonical, stat };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function currentUid() {
  if (typeof process.getuid !== 'function') throw new Error('ACPX conformance worker requires POSIX ownership checks.');
  return process.getuid();
}

async function verifyPinnedAgent() {
  const expectedPath = resolve(PINNED_AGENT_PATH);
  if (expectedPath !== PINNED_AGENT_PATH || basename(expectedPath) !== AGENT_BASENAME) {
    throw new Error('pinned fake-agent path is not exact.');
  }
  const expectedParent = dirname(expectedPath);
  await canonicalExistingPath(expectedParent, 'pinned fake-agent parent', 'directory');
  const beforeRecord = await canonicalExistingPath(expectedPath, 'pinned fake-agent', 'file');
  const before = beforeRecord.stat;
  const mode = before.mode & MODE_MASK;
  if (before.uid !== currentUid()) throw new Error('pinned fake-agent owner mismatch.');
  if (before.nlink !== 1) throw new Error('pinned fake-agent must have exactly one hard link.');
  if ((mode & 0o400) === 0 || (mode & 0o111) !== 0 || (mode & 0o022) !== 0) {
    throw new Error('pinned fake-agent mode is unsafe.');
  }
  const sourceBytes = await readFile(expectedPath);
  if (sourceBytes.length === 0 || sourceBytes.length > LIMITS.maxPinnedAgentBytes) {
    throw new Error('pinned fake-agent source size is invalid.');
  }
  let sourceText;
  try {
    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch {
    throw new Error('pinned fake-agent source is not valid UTF-8.');
  }
  if (sourceText.includes('\0') || !Buffer.from(sourceText, 'utf8').equals(sourceBytes)) {
    throw new Error('pinned fake-agent source does not round-trip as UTF-8.');
  }
  const afterRecord = await canonicalExistingPath(expectedPath, 'pinned fake-agent', 'file');
  if (!sameFileIdentity(before, afterRecord.stat)) {
    throw new Error('pinned fake-agent changed while it was verified.');
  }
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  if (digest !== PINNED_AGENT_SHA256) throw new Error('pinned fake-agent digest mismatch.');
  return Object.freeze({
    path: expectedPath,
    sourceText,
    digest,
    uid: before.uid,
    mode,
    nlink: before.nlink,
    size: before.size,
  });
}

function assertManagedStat(stat, path, type) {
  const expectedMode = type === 'directory' ? MANAGED_DIRECTORY_MODE : MANAGED_FILE_MODE;
  if (stat.uid !== currentUid()) throw new Error(`managed path owner mismatch: ${path}`);
  if ((stat.mode & MODE_MASK) !== expectedMode) {
    throw new Error(`managed path mode mismatch: ${path}`);
  }
  if (type === 'directory' && !stat.isDirectory()) throw new Error(`managed path is not a directory: ${path}`);
  if (type === 'file') {
    if (!stat.isFile()) throw new Error(`managed path is not a regular file: ${path}`);
    if (stat.nlink !== 1) throw new Error(`managed file has multiple hard links: ${path}`);
  }
}

async function assertManagedTree(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`managed path became a symbolic link: ${path}`);
  if (stat.isDirectory()) {
    assertManagedStat(stat, path, 'directory');
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`managed tree contains a symbolic link: ${join(path, entry.name)}`);
      await assertManagedTree(join(path, entry.name));
    }
    return;
  }
  assertManagedStat(stat, path, 'file');
}

async function preparePaths(raw, jobId) {
  const cwdInput = requireAbsoluteNormalizedPath(raw.cwd, 'cwd');
  const runtimeInput = requireAbsoluteNormalizedPath(raw.runtimeRoot, 'runtime-root');
  const [cwdRecord, agent] = await Promise.all([
    canonicalExistingPath(cwdInput, 'cwd', 'directory'),
    verifyPinnedAgent(),
  ]);
  rejectBroadPath(cwdRecord.path, 'cwd');
  rejectBroadPath(runtimeInput, 'runtime-root');
  if (basename(runtimeInput) !== `acpx-${jobId}`) {
    throw new Error('runtime-root basename must be acpx-<job-id>.');
  }

  const runtimeParentInput = dirname(runtimeInput);
  const runtimeParent = await canonicalExistingPath(runtimeParentInput, 'runtime-root parent', 'directory');
  const canonicalRuntime = join(runtimeParent.path, basename(runtimeInput));
  if (canonicalRuntime !== runtimeInput) throw new Error('runtime-root parent contains a path alias.');
  for (const [leftLabel, left, rightLabel, right] of [
    ['cwd', cwdRecord.path, 'runtime-root', canonicalRuntime],
    ['cwd', cwdRecord.path, 'pinned fake-agent', agent.path],
    ['runtime-root', canonicalRuntime, 'pinned fake-agent', agent.path],
  ]) {
    if (pathsOverlap(left, right)) throw new Error(`${leftLabel} and ${rightLabel} must not overlap.`);
  }

  try {
    await lstat(canonicalRuntime);
    throw new Error('runtime-root must not already exist.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(canonicalRuntime, { mode: MANAGED_DIRECTORY_MODE });
  const canonicalCreatedRoot = await realpath(canonicalRuntime);
  if (canonicalCreatedRoot !== canonicalRuntime) throw new Error('runtime-root creation produced an alias.');
  const homeDir = join(canonicalRuntime, 'home');
  const stateDir = join(canonicalRuntime, 'state');
  await mkdir(homeDir, { mode: MANAGED_DIRECTORY_MODE });
  await mkdir(stateDir, { mode: MANAGED_DIRECTORY_MODE });
  await assertManagedTree(canonicalRuntime);
  return {
    cwd: cwdRecord.path,
    agent,
    runtimeRoot: canonicalRuntime,
    homeDir,
    stateDir,
  };
}

function sanitizeCliEnvironment(homeDir) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    NODE_NO_WARNINGS: '1',
    npm_package_name: 'acpx',
    npm_package_version: ACPX_VERSION,
  });
}

function compactEvent(event) {
  if (!isPlainObject(event)) throw codedError('unknown_runtime_event', 'runtime emitted a non-object event.');
  switch (event.type) {
    case 'text_delta':
      return {
        type: 'text',
        stream: event.stream === 'thought' ? 'thought' : 'output',
        text: truncateUtf8(event.text, LIMITS.maxEventTextBytes),
        ...(event.tag ? { tag: truncateUtf8(event.tag, 64) } : {}),
      };
    case 'status':
      return {
        type: 'status',
        text: truncateUtf8(event.text, LIMITS.maxEventTextBytes),
        ...(event.tag ? { tag: truncateUtf8(event.tag, 64) } : {}),
        ...(Number.isSafeInteger(event.used) ? { used: event.used } : {}),
        ...(Number.isSafeInteger(event.size) ? { size: event.size } : {}),
      };
    case 'tool_call':
      return {
        type: 'tool',
        ...(typeof event.toolCallId === 'string' ? { id: truncateUtf8(event.toolCallId, 96) } : {}),
        ...(typeof event.status === 'string' ? { status: truncateUtf8(event.status, 64) } : {}),
        ...(typeof event.title === 'string' ? { title: truncateUtf8(event.title, 160) } : {}),
        ...(typeof event.kind === 'string' ? { kind: truncateUtf8(event.kind, 64) } : {}),
      };
    default:
      throw codedError('unknown_runtime_event', `unsupported runtime event type: ${truncateUtf8(event.type, 64)}`);
  }
}

function normalizeResult(result) {
  if (!isPlainObject(result)) {
    return { status: 'failed', error: { code: 'unknown_runtime_status', message: 'runtime returned a non-object result' } };
  }
  if (result.status === 'completed' || result.status === 'cancelled') {
    return {
      status: result.status,
      ...(result.stopReason ? { stopReason: truncateUtf8(result.stopReason, 64) } : {}),
    };
  }
  if (result.status === 'failed') {
    return {
      status: 'failed',
      error: {
        code: 'runtime_failed',
        message: 'ACP runtime turn failed.',
      },
    };
  }
  return {
    status: 'failed',
    error: {
      code: 'unknown_runtime_status',
      message: 'ACP runtime returned an unsupported status.',
    },
  };
}

function createVolatileRuntimeStore() {
  const records = new Map();
  return Object.freeze({
    async load(sessionId) {
      const direct = records.get(sessionId);
      const record = direct ?? [...records.values()].find((candidate) => (
        candidate?.sessionKey === sessionId || candidate?.acpxRecordId === sessionId
      ));
      return record === undefined ? undefined : structuredClone(record);
    },
    async save(record) {
      const encoded = JSON.stringify(record);
      if (utf8Bytes(encoded) > LIMITS.maxVolatileStoreBytes) {
        throw codedError('volatile_state_too_large', 'volatile ACP state exceeded its byte bound.');
      }
      if (typeof record?.acpxRecordId !== 'string' || record.acpxRecordId.length === 0) {
        throw codedError('invalid_volatile_state', 'volatile ACP state has no managed record id.');
      }
      const replacement = structuredClone(record);
      const existing = records.get(record.acpxRecordId);
      records.set(record.acpxRecordId, replacement);
      let totalBytes = 0;
      for (const candidate of records.values()) totalBytes += utf8Bytes(JSON.stringify(candidate));
      if (totalBytes > LIMITS.maxVolatileStoreBytes) {
        if (existing === undefined) records.delete(record.acpxRecordId);
        else records.set(record.acpxRecordId, existing);
        throw codedError('volatile_state_too_large', 'volatile ACP state exceeded its byte bound.');
      }
    },
    clear() {
      records.clear();
    },
    get byteLength() {
      let bytes = 0;
      for (const record of records.values()) bytes += utf8Bytes(JSON.stringify(record));
      return bytes;
    },
  });
}

async function createRuntime(paths, fixtureMode) {
  const {
    createAcpRuntime,
    createAgentRegistry,
  } = await import(BUNDLE_URL.href);
  const agentArgv = [
    process.execPath,
    '--input-type=module',
    '--eval',
    paths.agent.sourceText,
    PINNED_AGENT_ARGV0,
    '--mode',
    fixtureMode,
  ];
  const agentRegistry = createAgentRegistry({ overrides: { [AGENT_NAME]: agentArgv } });
  if (JSON.stringify(agentRegistry.resolve(AGENT_NAME)) !== JSON.stringify(agentArgv)) {
    throw new Error('ACPX fake-agent registry did not resolve to the fixed argv.');
  }
  const sessionStore = createVolatileRuntimeStore();
  paths.sessionStore = sessionStore;
  return createAcpRuntime({
    cwd: paths.cwd,
    sessionStore,
    agentRegistry,
    mcpServers: [],
    permissionMode: 'deny-all',
    nonInteractivePermissions: 'deny',
    timeoutMs: LIMITS.upstreamOperationTimeoutMs,
    onPermissionRequest: async () => ({ outcome: 'reject_always' }),
  });
}

class AcpxCliWorker {
  #runtime;
  #paths;
  #sessionKey;
  #handle;
  #ensurePromise;
  #active;
  #promptStarted = false;
  #closing = false;
  #cleanupFailure;
  #controlOutputBytes = 0;

  constructor(runtime, paths, jobId, targetProfileDigest) {
    this.#runtime = runtime;
    this.#paths = paths;
    this.#sessionKey = `job-${jobId}-${targetProfileDigest}`;
  }

  writeFrame(payload, turnBudget = null, { terminal = false } = {}) {
    const encoded = `${JSON.stringify(payload)}\n`;
    const bytes = utf8Bytes(encoded);
    if (bytes > LIMITS.maxOutputLineBytes) return false;
    if (!turnBudget) {
      if (this.#controlOutputBytes + bytes > LIMITS.maxControlOutputBytes) return false;
      this.#controlOutputBytes += bytes;
      process.stdout.write(encoded);
      return true;
    }
    const available = terminal
      ? LIMITS.maxTurnOutputBytes
      : LIMITS.maxTurnOutputBytes - LIMITS.terminalReserveBytes;
    if (terminal && bytes > LIMITS.terminalReserveBytes) return false;
    if (turnBudget.usedBytes + bytes > available) return false;
    turnBudget.usedBytes += bytes;
    process.stdout.write(encoded);
    return true;
  }

  reply(id, payload, turnBudget = null, options = {}) {
    return this.writeFrame({ id: id ?? null, ...payload }, turnBudget, options);
  }

  fail(id, error, turnBudget = null, { terminal = false, fallbackCode = 'worker_error' } = {}) {
    const publicError = publicWorkerError(error, fallbackCode);
    const payload = {
      type: 'error',
      error: {
        code: publicError.code,
        message: publicError.message,
      },
    };
    if (this.reply(id, payload, turnBudget, { terminal })) return;
    if (terminal) {
      // Fixed-size fallback fits the reserved terminal frame even when the
      // original error message could not be encoded within it.
      this.reply(id, {
        type: 'error',
        error: { code: 'terminal_output_error', message: 'turn terminated' },
      }, turnBudget, { terminal: true });
    }
  }

  ready() {
    this.writeFrame({
      id: null,
      type: 'ready',
      disabled: true,
      activation_ready: false,
      prerequisites: ACTIVATION_PREREQUISITES,
    });
  }

  async ensureHandle(deadline) {
    if (this.#handle) return this.#handle;
    const verifiedAgent = await deadline.run(
      verifyPinnedAgent(),
      'pinned fake-agent verification exceeded the job deadline.',
    );
    if (verifiedAgent.path !== this.#paths.agent.path
      || verifiedAgent.digest !== this.#paths.agent.digest
      || verifiedAgent.uid !== this.#paths.agent.uid
      || verifiedAgent.mode !== this.#paths.agent.mode
      || verifiedAgent.nlink !== this.#paths.agent.nlink
      || verifiedAgent.size !== this.#paths.agent.size
      || verifiedAgent.sourceText !== this.#paths.agent.sourceText) {
      throw new Error('pinned fake-agent provenance changed before launch.');
    }
    this.#ensurePromise ??= this.#runtime.ensureSession({
      sessionKey: this.#sessionKey,
      agent: AGENT_NAME,
      mode: 'oneshot',
    });
    try {
      const handle = await deadline.run(
        this.#ensurePromise,
        'ACP initialization/session creation exceeded the absolute job deadline.',
      );
      this.#handle = handle;
      return handle;
    } finally {
      if (this.#handle) this.#ensurePromise = null;
    }
  }

  async discardHandle(deadline, reason = 'conformance-turn-complete') {
    if (!this.#handle && this.#ensurePromise) {
      this.#handle = await deadline.run(
        this.#ensurePromise,
        'pending ACP session creation did not settle before cleanup.',
      );
      this.#ensurePromise = null;
    }
    if (!this.#handle) return;
    const handle = this.#handle;
    await deadline.run(
      this.#runtime.close({
        handle,
        reason,
        discardPersistentState: true,
      }),
      'runtime discard exceeded the absolute deadline.',
    );
    this.#handle = null;
  }

  async startPrompt(request) {
    requireExactKeys(request, ['id', 'op', 'prompt']);
    if (this.#closing) throw codedError('worker_closing', 'worker is closing.');
    if (this.#promptStarted) throw codedError('single_turn_only', 'this worker accepts exactly one prompt.');
    if (this.#active) throw codedError('busy', 'one prompt is already active.');
    const id = requireSafeRequestId(request.id);
    const prompt = requirePrompt(request.prompt);
    this.#promptStarted = true;
    const deadline = new AbsoluteDeadline(LIMITS.absoluteJobDeadlineMs);
    const abortController = new AbortController();
    const state = {
      id,
      turn: null,
      done: null,
      deadline,
      abortController,
      cancelRequested: false,
      eventCount: 0,
      outputExceeded: false,
      hardTimedOut: false,
      cleanupError: null,
      budget: { usedBytes: 0 },
    };
    this.#active = state;
    const hardTimer = setTimeout(() => {
      state.hardTimedOut = true;
      abortController.abort(codedError('worker_timeout', 'absolute ACP job deadline elapsed.'));
      if (state.turn) {
        Promise.resolve().then(() => state.turn.cancel({ reason: 'worker-hard-timeout' })).catch(() => {});
        Promise.resolve().then(() => state.turn.closeStream({ reason: 'worker-hard-timeout' })).catch(() => {});
      }
    }, deadline.remainingMilliseconds());
    hardTimer.unref?.();
    state.done = (async () => {
      let terminalResult;
      let terminalError;
      try {
        const handle = await this.ensureHandle(deadline);
        if (state.cancelRequested) {
          terminalResult = { status: 'cancelled', stopReason: 'cancelled-before-start' };
          return;
        }
        const turn = this.#runtime.startTurn({
          handle,
          text: prompt,
          mode: 'prompt',
          requestId: id,
          timeoutMs: LIMITS.upstreamOperationTimeoutMs,
          signal: abortController.signal,
        });
        state.turn = turn;
        if (state.cancelRequested) {
          await deadline.run(
            turn.cancel({ reason: 'cancelled-before-prompt' }),
            'turn cancellation exceeded the absolute job deadline.',
          );
        }
        const events = turn.events[Symbol.asyncIterator]();
        while (true) {
          const next = await deadline.run(
            events.next(),
            'ACP event stream exceeded the absolute job deadline.',
          );
          if (next.done) break;
          if (state.eventCount >= LIMITS.maxEventsPerTurn) {
            state.outputExceeded = true;
            break;
          }
          const compact = compactEvent(next.value);
          if (!this.writeFrame({ id, type: 'event', event: compact }, state.budget)) {
            state.outputExceeded = true;
            break;
          }
          state.eventCount += 1;
        }
        if (state.outputExceeded) {
          await deadline.run(
            turn.cancel({ reason: 'output-bound-exceeded' }),
            'bounded turn cancellation exceeded the absolute job deadline.',
          );
          if (typeof events.return === 'function') {
            await deadline.run(
              events.return(),
              'ACP event stream did not close before the absolute job deadline.',
            );
          }
        }
        terminalResult = normalizeResult(await deadline.run(
          turn.result,
          'ACP result exceeded the absolute job deadline.',
        ));
        if (state.outputExceeded) {
          terminalError = codedError('output_too_large', 'turn output exceeded the worker byte bound.');
        }
      } catch (error) {
        terminalError = error;
      } finally {
        try {
          await this.discardHandle(deadline);
        } catch (error) {
          state.cleanupError ??= error;
        } finally {
          this.#paths.sessionStore.clear();
        }
        try {
          await deadline.run(
            assertManagedTree(this.#paths.runtimeRoot),
            'managed-tree validation exceeded the absolute job deadline.',
          );
        } catch (error) {
          state.cleanupError ??= error;
        }
        clearTimeout(hardTimer);
        if (state.hardTimedOut) {
          terminalError ??= codedError('worker_timeout', 'absolute ACP job deadline elapsed.');
        }
        if (state.cleanupError) this.#cleanupFailure ??= state.cleanupError;
        terminalError ??= state.cleanupError;
        if (terminalError) {
          this.fail(id, terminalError, state.budget, { terminal: true });
        } else {
          this.reply(id, { type: 'result', result: terminalResult }, state.budget, { terminal: true });
        }
        this.#active = null;
      }
    })();
    if (!this.reply(id, { type: 'accepted', op: 'prompt' }, state.budget)) {
      state.outputExceeded = true;
    }
  }

  async cancel(request) {
    requireExactKeys(request, ['id', 'op', 'reason']);
    const id = requireSafeRequestId(request.id);
    const reason = requireReason(request.reason);
    if (!this.#active) {
      this.reply(id, { type: 'result', result: { cancelled: false } });
      return;
    }
    const active = this.#active;
    active.cancelRequested = true;
    if (active.turn) {
      await active.deadline.run(
        active.turn.cancel({ reason }),
        'turn cancellation exceeded the absolute job deadline.',
      );
    }
    this.reply(id, { type: 'result', result: { cancelled: true } });
  }

  async close(request, deadline = new AbsoluteDeadline(LIMITS.controlDeadlineMs)) {
    requireExactKeys(request, ['id', 'op']);
    const id = requireSafeRequestId(request.id);
    this.#closing = true;
    let cleanupError = this.#cleanupFailure;
    const active = this.#active;
    if (active) {
      active.cancelRequested = true;
      if (active.turn) {
        try {
          await deadline.run(
            active.turn.cancel({ reason: 'worker-close' }),
            'turn close cancellation exceeded the cleanup deadline.',
          );
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        await deadline.run(active.done, 'active turn did not settle before the cleanup deadline.');
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      await this.discardHandle(deadline, 'worker-close');
    } catch (error) {
      cleanupError ??= error;
    } finally {
      this.#paths.sessionStore.clear();
    }
    try {
      await deadline.run(
        assertManagedTree(this.#paths.runtimeRoot),
        'managed-tree validation exceeded the cleanup deadline.',
      );
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      this.#cleanupFailure ??= cleanupError;
      throw cleanupError;
    }
    this.reply(id, { type: 'result', result: { closed: true } });
  }

  async dispatch(request) {
    if (!isPlainObject(request)) throw codedError('invalid_request', 'request must be an object.');
    if (typeof request.op !== 'string') throw codedError('invalid_request', 'op is required.');
    switch (request.op) {
      case 'prompt':
        await this.startPrompt(request);
        return;
      case 'cancel':
        await this.cancel(request);
        return;
      case 'status':
        requireExactKeys(request, ['id', 'op']);
        this.reply(requireSafeRequestId(request.id), {
          type: 'result',
          result: {
            active: Boolean(this.#active),
            closed: this.#closing,
            disabled: true,
            activation_ready: false,
            prerequisites: ACTIVATION_PREREQUISITES,
          },
        });
        return;
      case 'close':
        await this.close(request);
        return;
      case 'shutdown':
        requireExactKeys(request, ['id', 'op']);
        try {
          await this.close(request);
          exitAfterStdoutFlush(0);
        } catch (error) {
          this.fail(request.id, error, null, { fallbackCode: 'worker_shutdown_error' });
          process.stderr.write('acpx-worker cleanup failure\n');
          exitAfterStdoutFlush(1);
        }
        return;
      default:
        throw codedError('unsupported_op', `unsupported op: ${truncateUtf8(request.op, 64)}`);
    }
  }
}

function parseArgs(argv) {
  const allowed = new Set([
    '--cwd',
    '--runtime-root',
    '--fixture-mode',
    '--job-id',
    '--target-profile-digest',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) {
      throw new Error('Usage: acpx-worker.mjs --cwd <dir> --runtime-root <fresh-dir> --fixture-mode <fixed-mode> --job-id <id> --target-profile-digest <sha256>');
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (Object.hasOwn(values, flag)) throw new Error(`duplicate ${flag}`);
    values[flag] = value;
  }
  for (const flag of allowed) {
    if (!Object.hasOwn(values, flag)) throw new Error(`missing ${flag}`);
  }
  if (!JOB_ID_PATTERN.test(values['--job-id'])) throw new Error('job-id is invalid.');
  if (!DIGEST_PATTERN.test(values['--target-profile-digest'])) throw new Error('target-profile-digest must be 64 lowercase hexadecimal characters.');
  if (!FIXTURE_MODES.has(values['--fixture-mode'])) throw new Error('fixture-mode is invalid.');
  return {
    cwd: values['--cwd'],
    runtimeRoot: values['--runtime-root'],
    fixtureMode: values['--fixture-mode'],
    jobId: values['--job-id'],
    targetProfileDigest: values['--target-profile-digest'],
  };
}

function exitAfterStdoutFlush(code) {
  process.stdout.write('', () => process.exit(code));
}

async function runCli(argv) {
  const options = parseArgs(argv);
  process.umask(0o077);
  const paths = await preparePaths(options, options.jobId);
  sanitizeCliEnvironment(paths.homeDir);
  process.chdir(paths.cwd);
  const runtime = await createRuntime(paths, options.fixtureMode);
  const worker = new AcpxCliWorker(
    runtime,
    paths,
    options.jobId,
    options.targetProfileDigest,
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let signalClosing = false;
  const onSignal = async () => {
    if (signalClosing) return;
    signalClosing = true;
    try {
      await worker.close({ id: 'signal', op: 'close' });
      exitAfterStdoutFlush(0);
    } catch (error) {
      worker.fail('signal', error, null, { fallbackCode: 'worker_cleanup_error' });
      process.stderr.write('acpx-worker cleanup failure\n');
      exitAfterStdoutFlush(1);
    }
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  worker.ready();
  try {
    for await (const line of input) {
      if (utf8Bytes(line) > LIMITS.maxInputLineBytes) {
        worker.fail(null, codedError('input_too_large', 'input line exceeds the worker byte bound.'));
        continue;
      }
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        worker.fail(null, codedError('invalid_json', 'input line is not valid JSON.'));
        continue;
      }
      try {
        await worker.dispatch(request);
      } catch (error) {
        const id = isPlainObject(request) && typeof request.id === 'string' ? request.id : null;
        worker.fail(id, error);
      }
    }
  } finally {
    input.close();
    if (!signalClosing) {
      signalClosing = true;
      try {
        await worker.close({ id: 'eof', op: 'close' });
      } catch (error) {
        worker.fail('eof', error, null, { fallbackCode: 'worker_cleanup_error' });
        process.stderr.write('acpx-worker cleanup failure\n');
        exitAfterStdoutFlush(1);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`acpx-worker: ${boundedError(error)}\n`);
    process.exitCode = 1;
  });
}
