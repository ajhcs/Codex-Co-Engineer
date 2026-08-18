/*
 * Standalone, unwired ACP transport boundary.
 *
 * This module deliberately does not start a process or attach to a stream when
 * it is imported.  Call start() explicitly after constructing a proxy.  It is
 * a byte-oriented NDJSON bridge: every frame is checked for a strict UTF-8
 * representation and a JSON object before it is allowed to reach ACPX.
 *
 * The limits below are user-space transport limits only.  They do not cap the
 * Node heap, kernel pipe buffers, provider allocations, or descendants that
 * escape a process group.  A deployment still needs an OS-level cgroup or
 * equivalent memory and process limits (and a launcher policy that keeps the
 * provider in the owned process group).
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const CONTROL_FRAME_MAX_BYTES = 64 * 1024;
export const PROVIDER_FRAME_MAX_BYTES = 256 * 1024;
export const MAX_PROVIDER_FRAMES_PER_TURN = 2_000;
export const MAX_PROVIDER_BYTES_PER_TURN = 8 * 1024 * 1024;

// Friendly aliases for callers that prefer the direction in the name.
export const MAX_CONTROL_FRAME_BYTES = CONTROL_FRAME_MAX_BYTES;
export const MAX_ACP_FRAME_BYTES = PROVIDER_FRAME_MAX_BYTES;
export const MAX_PROVIDER_OUTPUT_FRAMES_PER_TURN = MAX_PROVIDER_FRAMES_PER_TURN;
export const MAX_PROVIDER_OUTPUT_BYTES_PER_TURN = MAX_PROVIDER_BYTES_PER_TURN;

export const ACP_BOUNDED_PROXY_LIMITS = Object.freeze({
  controlFrameBytes: CONTROL_FRAME_MAX_BYTES,
  providerFrameBytes: PROVIDER_FRAME_MAX_BYTES,
  providerFramesPerTurn: MAX_PROVIDER_FRAMES_PER_TURN,
  providerBytesPerTurn: MAX_PROVIDER_BYTES_PER_TURN,
});

export const TERMINAL_CLASSIFICATIONS = Object.freeze([
  'transport_overflow',
  'output_too_large',
  'malformed_transport',
]);

export const REMAINING_OS_LIMIT_REQUIREMENT =
  'An OS cgroup or equivalent memory/process limit is still required; this proxy only bounds transport frames and provider output per turn.';

const MINIMAL_PROVIDER_ENVIRONMENT = Object.freeze({
  PATH: typeof process.env.PATH === 'string' && process.env.PATH.length > 0
    ? process.env.PATH
    : '/usr/local/bin:/usr/bin:/bin',
});

const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_KILL_GRACE_MS = 500;
const MAX_TIMEOUT_MS = 60_000;
const SESSION_METHODS = new Set(['session/new', 'session/create', 'session/start']);
const PROMPT_METHODS = new Set(['session/prompt']);
const JSON_RPC_VERSION = '2.0';

const ERROR_MESSAGES = Object.freeze({
  transport_overflow: 'Transport frame limit exceeded.',
  output_too_large: 'Provider output limit exceeded.',
  malformed_transport: 'Malformed transport message.',
  concurrent_turn: 'A prompt turn is already in progress.',
  invalid_options: 'Proxy options are invalid.',
  invalid_state: 'Proxy is not in a writable state.',
  provider_unavailable: 'Provider process is unavailable.',
  closed: 'Proxy is closed.',
});

const TERMINAL_SET = new Set(TERMINAL_CLASSIFICATIONS);

function boundedTimeout(value, fallback) {
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, MAX_TIMEOUT_MS);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRpcId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 256)
    || Number.isSafeInteger(value);
}

function rpcIdKey(value) {
  return `${typeof value}:${String(value)}`;
}

function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new AcpBoundedProxyError('malformed_transport');
}

function safeFrameMessage(classification) {
  return ERROR_MESSAGES[classification] ?? ERROR_MESSAGES.malformed_transport;
}

function safeErrorCode(value) {
  return TERMINAL_SET.has(value) || Object.hasOwn(ERROR_MESSAGES, value) ? value : 'malformed_transport';
}

/**
 * Error type used by the proxy.  Its message is always selected from a fixed
 * bounded table; provider frames, prompts, process errors, and secrets never
 * become part of the error text.
 */
export class AcpBoundedProxyError extends Error {
  constructor(code = 'malformed_transport') {
    const safeCode = safeErrorCode(code);
    super(safeFrameMessage(safeCode));
    this.name = 'AcpBoundedProxyError';
    this.code = safeCode;
    this.classification = TERMINAL_SET.has(safeCode) ? safeCode : null;
    this.terminal = this.classification !== null;
  }

  toJSON() {
    return {
      code: this.code,
      classification: this.classification,
      terminal: this.terminal,
      message: this.message,
    };
  }
}

export function normalizeAcpProxyError(error, fallback = 'malformed_transport') {
  if (error instanceof AcpBoundedProxyError) return error;
  return new AcpBoundedProxyError(safeErrorCode(fallback));
}

class FrameLimitError extends Error {
  constructor(classification) {
    super(classification);
    this.code = classification;
  }
}

class NdjsonFrameParser {
  constructor(maxFrameBytes) {
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  *feed(value) {
    const input = toBytes(value);
    if (input.length === 0) return;
    if (this.buffer.length === 0) {
      // Retain the stream chunk until each frame is consumed.  A chunk is
      // already bounded by the stream implementation; no extra copy is needed
      // unless a frame is yielded.
      this.buffer = input;
    } else {
      this.buffer = Buffer.concat([this.buffer, input]);
    }

    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      const length = newline + 1;
      const payloadLength = this.buffer[newline - 1] === 0x0d ? newline - 1 : newline;
      if (payloadLength > this.maxFrameBytes) {
        throw new FrameLimitError('overflow');
      }
      const frame = Buffer.from(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
      yield frame;
    }
    // A pending CR may be the first byte of a CRLF delimiter.  Otherwise a
    // partial payload is bounded before a delimiter arrives.
    if (this.buffer.length > this.maxFrameBytes
      || (this.buffer.length === this.maxFrameBytes + 1
        && this.buffer[this.buffer.length - 1] !== 0x0d)) {
      throw new FrameLimitError('overflow');
    }
  }

  finish() {
    if (this.buffer.length !== 0) {
      throw new FrameLimitError('malformed');
    }
  }
}

function parseFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length === 0 || frame[frame.length - 1] !== 0x0a) {
    throw new FrameLimitError('malformed');
  }
  let body = frame.subarray(0, frame.length - 1);
  if (body[body.length - 1] === 0x0d) body = body.subarray(0, body.length - 1);

  let text;
  try {
    // fatal=true is important: a replacement-decoding stream helper would
    // turn an invalid byte sequence into a different, parseable message.
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new FrameLimitError('malformed');
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameLimitError('malformed');
  }
  try {
    validateJsonNumbers(value);
  } catch {
    throw new FrameLimitError('malformed');
  }
  validateRpcObject(value);
  return value;
}

function validateJsonNumbers(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonNumbers(item);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) validateJsonNumbers(item);
  }
}

function validateRpcObject(value) {
  if (!isRecord(value)) throw new FrameLimitError('malformed');

  if (Object.hasOwn(value, 'jsonrpc') && value.jsonrpc !== JSON_RPC_VERSION) {
    throw new FrameLimitError('malformed');
  }

  const hasMethod = Object.hasOwn(value, 'method');
  const hasId = Object.hasOwn(value, 'id');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');

  if (hasMethod) {
    if (typeof value.method !== 'string' || value.method.length === 0 || value.method.length > 256) {
      throw new FrameLimitError('malformed');
    }
    if (hasResult || hasError) throw new FrameLimitError('malformed');
    if (hasId && !isRpcId(value.id)) throw new FrameLimitError('malformed');
    return value;
  }

  // A response must have an id and exactly one of result/error.  The proxy
  // still permits an arbitrary JSON result because ACP methods evolve.
  if (!hasId || !isRpcId(value.id) || hasResult === hasError) {
    throw new FrameLimitError('malformed');
  }
  if (hasError && !isRecord(value.error)) throw new FrameLimitError('malformed');
  return value;
}

function encodeFrame(value, maxFrameBytes) {
  if (!isRecord(value)) throw new AcpBoundedProxyError('malformed_transport');
  validateRpcObject(value);
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new AcpBoundedProxyError('malformed_transport');
  }
  if (typeof text !== 'string') throw new AcpBoundedProxyError('malformed_transport');
  const frame = Buffer.from(`${text}\n`, 'utf8');
  if (frame.length - 1 > maxFrameBytes) throw new AcpBoundedProxyError('transport_overflow');
  return frame;
}

function frameFromRaw(value, maxFrameBytes) {
  let bytes;
  try {
    bytes = toBytes(value);
  } catch {
    throw new AcpBoundedProxyError('malformed_transport');
  }
  if (bytes.length === 0) throw new AcpBoundedProxyError('malformed_transport');
  if (bytes[bytes.length - 1] !== 0x0a) bytes = Buffer.concat([bytes, Buffer.from('\n')]);
  const firstNewline = bytes.indexOf(0x0a);
  const payloadLength = bytes[bytes.length - 2] === 0x0d ? bytes.length - 2 : bytes.length - 1;
  if (firstNewline !== bytes.length - 1 || payloadLength > maxFrameBytes) {
    throw new AcpBoundedProxyError(payloadLength > maxFrameBytes ? 'transport_overflow' : 'malformed_transport');
  }
  try {
    parseFrame(bytes);
  } catch (error) {
    if (error instanceof FrameLimitError && error.code === 'overflow') {
      throw new AcpBoundedProxyError('transport_overflow');
    }
    throw new AcpBoundedProxyError('malformed_transport');
  }
  return Buffer.from(bytes);
}

function groupExists(pid) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function signalGroup(pid, signal) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid) && Date.now() < deadline) await sleep(10);
  return !groupExists(pid);
}

function waitForChildExit(child, timeoutMs) {
  if (!child
    || (child.exitCode !== null && child.exitCode !== undefined)
    || child.signalCode
    || typeof child.once !== 'function') {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', () => finish(true));
    child.once('close', () => finish(true));
  });
}

function removeListener(stream, event, listener) {
  if (typeof stream?.removeListener === 'function') stream.removeListener(event, listener);
}

/**
 * Write one frame and wait for both the write callback and drain when the
 * writable reports backpressure.  The next frame is not attempted until this
 * promise resolves.
 */
function writeWithBackpressure(stream, frame) {
  if (!stream || typeof stream.write !== 'function' || stream.destroyed || stream.writableEnded) {
    return Promise.reject(new Error('writable unavailable'));
  }

  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drainDone = false;
    let settled = false;

    const cleanup = () => {
      removeListener(stream, 'drain', onDrain);
      removeListener(stream, 'error', onError);
    };
    const finish = () => {
      if (!settled && callbackDone && drainDone) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('writable failed'));
    };
    const onDrain = () => {
      drainDone = true;
      finish();
    };
    const onError = () => fail();

    if (typeof stream.once === 'function') {
      stream.once('error', onError);
      stream.once('drain', onDrain);
    }

    try {
      const accepted = stream.write(frame, (error) => {
        if (error) {
          fail();
          return;
        }
        callbackDone = true;
        finish();
      });
      if (accepted !== false) {
        drainDone = true;
        removeListener(stream, 'drain', onDrain);
        finish();
      }
    } catch {
      fail();
    }
  });
}

async function drainStream(stream) {
  if (!stream) return;
  try {
    for await (const _chunk of stream) {
      // Stderr is intentionally drained, never forwarded or copied into an
      // error.  Otherwise a noisy provider can block on its stderr pipe.
    }
  } catch {
    // Closing a pipe during bounded termination is expected.
  }
}

function streamHasMethod(stream, method) {
  return stream && typeof stream[method] === 'function';
}

/**
 * A reusable, bidirectional bounded ACP transport proxy.
 *
 * The proxy owns the child process it starts.  On POSIX it starts the child
 * detached so descendants share a process group and can be terminated as one
 * unit.  `providerProcess` is accepted for deterministic tests and specialized
 * launchers; set ownedProvider=false when the supplied process is not owned.
 */
export class AcpBoundedTransportProxy extends EventEmitter {
  constructor(options = {}) {
    super();

    const provider = isRecord(options.provider) ? options.provider : {};
    const control = isRecord(options.control) ? options.control : {};
    this.controlInput = options.controlInput
      ?? options.controlReadable
      ?? options.input
      ?? control.input
      ?? control.readable
      ?? null;
    this.controlOutput = options.controlOutput
      ?? options.controlWritable
      ?? options.output
      ?? control.output
      ?? control.writable
      ?? null;
    this.providerProcess = options.providerProcess ?? options.child ?? null;
    this.providerCommand = options.providerCommand
      ?? options.command
      ?? provider.command
      ?? null;
    this.providerArgs = options.providerArgs
      ?? options.args
      ?? provider.args
      ?? [];
    this.cwd = options.cwd ?? provider.cwd;
    this.env = options.env ?? provider.env;
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.ownedProvider = options.ownedProvider !== false;
    this.termGraceMs = boundedTimeout(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
    this.killGraceMs = boundedTimeout(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
    this.onProviderFrame = typeof options.onProviderFrame === 'function'
      ? options.onProviderFrame
      : null;

    this.state = 'created';
    this.child = null;
    this.providerPid = null;
    this.terminalError = null;
    this.providerExit = null;
    this.sessionId = null;
    this.activeTurn = null;
    this.turnFrames = 0;
    this.turnBytes = 0;
    this.outboundRequests = new Map();
    this._providerWriteTail = Promise.resolve();
    this._stopPromise = null;
    this._doneSettled = false;
    this._doneResolve = null;
    this._doneReject = null;
    this.done = new Promise((resolve, reject) => {
      this._doneResolve = resolve;
      this._doneReject = reject;
    });
    // A caller can choose to observe wait(), but an unobserved terminal
    // failure must not become an unhandled-rejection process warning.
    this.done.catch(() => {});

    this._controlParser = new NdjsonFrameParser(CONTROL_FRAME_MAX_BYTES);
    this._providerParser = new NdjsonFrameParser(PROVIDER_FRAME_MAX_BYTES);
    this._pumpPromises = [];
  }

  start() {
    if (this.state !== 'created') throw new AcpBoundedProxyError('invalid_state');
    if (!Array.isArray(this.providerArgs)
      || this.providerArgs.some((argument) => typeof argument !== 'string')
      || typeof this.spawnImpl !== 'function') {
      throw new AcpBoundedProxyError('invalid_options');
    }

    let child = this.providerProcess;
    if (!child) {
      if (typeof this.providerCommand !== 'string'
        || this.providerCommand.length === 0
        || this.providerCommand.length > 1024) {
        throw new AcpBoundedProxyError('invalid_options');
      }
      try {
        child = this.spawnImpl(this.providerCommand, [...this.providerArgs], {
          cwd: this.cwd,
          // Never inherit ambient credentials/configuration by default.  A
          // later worker must pass an explicit, already-allowlisted env when a
          // provider needs credentials or a managed home.
          env: this.env ?? { ...MINIMAL_PROVIDER_ENVIRONMENT },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch {
        throw new AcpBoundedProxyError('provider_unavailable');
      }
    }

    if (!child || !streamHasMethod(child.stdin, 'write') || !child.stdout) {
      this.child = child;
      void this._terminateOwnedProvider();
      throw new AcpBoundedProxyError('provider_unavailable');
    }

    this.child = child;
    this.providerPid = Number.isSafeInteger(child.pid) ? child.pid : null;
    this.state = 'running';
    this._attachProcessListeners();
    this._pumpPromises.push(this._pumpProvider());
    this._pumpPromises.push(drainStream(this.child.stderr));
    if (this.controlInput) this._pumpPromises.push(this._pumpControl());
    return this;
  }

  connect() {
    return this.start();
  }

  /** Send one JSON object from the control side to the provider. */
  send(message) {
    if (this.state !== 'running') {
      return Promise.reject(this.terminalError ?? new AcpBoundedProxyError('invalid_state'));
    }
    let frame;
    try {
      frame = encodeFrame(message, CONTROL_FRAME_MAX_BYTES);
    } catch (error) {
      const normalized = normalizeAcpProxyError(error, 'malformed_transport');
      if (normalized.classification) this._terminalize(normalized.classification);
      return Promise.reject(this.terminalError ?? normalized);
    }
    return this._processOutboundFrame(frame, false).catch((error) => {
      if (error instanceof AcpBoundedProxyError && error.classification === 'malformed_transport') {
        this._terminalize('malformed_transport');
        throw this.terminalError;
      }
      throw error;
    });
  }

  /** Send one already encoded NDJSON frame from the control side. */
  sendRaw(frame) {
    if (this.state !== 'running') {
      return Promise.reject(this.terminalError ?? new AcpBoundedProxyError('invalid_state'));
    }
    try {
      return this._processOutboundFrame(frameFromRaw(frame, CONTROL_FRAME_MAX_BYTES), false).catch((error) => {
        if (error instanceof AcpBoundedProxyError && error.classification === 'malformed_transport') {
          this._terminalize('malformed_transport');
          throw this.terminalError;
        }
        throw error;
      });
    } catch (error) {
      const normalized = normalizeAcpProxyError(error, 'malformed_transport');
      if (normalized.classification) this._terminalize(normalized.classification);
      return Promise.reject(this.terminalError ?? normalized);
    }
  }

  sendControl(message) {
    return this.send(message);
  }

  write(message) {
    return this.send(message);
  }

  wait() {
    return this.done;
  }

  get terminalClassification() {
    return this.terminalError?.classification ?? null;
  }

  get error() {
    return this.terminalError;
  }

  async close() {
    if (this.state === 'created') {
      this.state = 'closed';
      this._settleDone({ reason: 'closed' });
      return { reason: 'closed' };
    }
    if (this.state === 'running') {
      this.state = 'closing';
      await this._terminateOwnedProvider();
      this._closeExternalPipes(false);
      this._settleDone({ reason: 'closed' });
    }
    if (this.state === 'failed') {
      await this._stopPromise;
      return { reason: 'closed', terminal: this.terminalError?.classification ?? 'malformed_transport' };
    }
    return this.done;
  }

  stop() {
    return this.close();
  }

  _attachProcessListeners() {
    if (typeof this.child.once === 'function') {
      this.child.once('error', () => this._terminalize('malformed_transport'));
      this.child.once('exit', (code, signal) => {
        this.providerExit = { code: Number.isInteger(code) ? code : null, signal: typeof signal === 'string' ? signal : null };
      });
    }
    if (typeof this.child.stdout.once === 'function') {
      this.child.stdout.once('error', () => this._terminalize('malformed_transport'));
    }
    if (typeof this.child.stderr.once === 'function') {
      this.child.stderr.once('error', () => {});
    }
    if (typeof this.child.stdin.once === 'function') {
      this.child.stdin.once('error', () => this._terminalize('malformed_transport'));
    }
    if (this.controlInput && typeof this.controlInput.once === 'function') {
      this.controlInput.once('error', () => this._terminalize('malformed_transport'));
    }
    if (this.controlOutput && typeof this.controlOutput.once === 'function') {
      this.controlOutput.once('error', () => this._terminalize('malformed_transport'));
    }
  }

  async _pumpControl() {
    try {
      for await (const chunk of this.controlInput) {
        if (this.state !== 'running') break;
        for (const frame of this._controlParser.feed(chunk)) {
          if (this.state !== 'running') break;
          await this._processOutboundFrame(frame, true);
        }
      }
      if (this.state === 'running') {
        this._controlParser.finish();
        this.state = 'closing';
        await this._terminateOwnedProvider();
        this._closeExternalPipes(false);
        this._settleDone({ reason: 'control_eof' });
      }
    } catch (error) {
      if (this.state === 'closing' || this.state === 'closed' || this.state === 'failed') return;
      const classification = error instanceof FrameLimitError
        ? (error.code === 'overflow' ? 'transport_overflow' : 'malformed_transport')
        : (error instanceof AcpBoundedProxyError && error.classification
          ? error.classification
          : 'malformed_transport');
      this._terminalize(classification);
    }
  }

  async _pumpProvider() {
    try {
      for await (const chunk of this.child.stdout) {
        if (this.state !== 'running') break;
        for (const frame of this._providerParser.feed(chunk)) {
          if (this.state !== 'running') break;
          await this._processProviderFrame(frame);
        }
      }
      if (this.state !== 'running') return;
      this._providerParser.finish();
      if (this.activeTurn || this.outboundRequests.size > 0) {
        this._terminalize('malformed_transport');
        return;
      }
      this.state = 'closing';
      await this._terminateOwnedProvider();
      this._closeExternalPipes(false);
      this._settleDone({ reason: 'provider_eof' });
    } catch (error) {
      if (this.state === 'closing' || this.state === 'closed' || this.state === 'failed') return;
      const classification = error instanceof FrameLimitError
        ? (error.code === 'overflow' || error.code === 'turn_output'
          ? 'output_too_large'
          : 'malformed_transport')
        : (error instanceof AcpBoundedProxyError && error.classification
          ? error.classification
          : 'malformed_transport');
      this._terminalize(classification);
    }
  }

  async _processOutboundFrame(frame, terminalOnError) {
    let message;
    try {
      message = parseFrame(frame);
    } catch (error) {
      const normalized = new AcpBoundedProxyError(
        error instanceof FrameLimitError && error.code === 'overflow'
          ? 'transport_overflow'
          : 'malformed_transport',
      );
      if (terminalOnError) this._terminalize(normalized.classification);
      throw normalized;
    }

    let tracked;
    try {
      tracked = this._trackOutbound(message);
    } catch (error) {
      const normalized = normalizeAcpProxyError(error, 'malformed_transport');
      if (terminalOnError || normalized.code === 'malformed_transport') {
        if (terminalOnError) this._terminalize(normalized.classification ?? 'malformed_transport');
      }
      throw normalized;
    }

    try {
      await this._writeProvider(frame);
      return { id: tracked?.id ?? null, method: tracked?.method ?? null };
    } catch {
      this._undoOutbound(tracked);
      this._terminalize('malformed_transport');
      throw this.terminalError;
    }
  }

  _trackOutbound(message) {
    if (!Object.hasOwn(message, 'method')) return null;
    const hasId = Object.hasOwn(message, 'id');
    if (!hasId) {
      if (PROMPT_METHODS.has(message.method)) throw new AcpBoundedProxyError('malformed_transport');
      if (SESSION_METHODS.has(message.method)) {
        if (this.activeTurn) throw new AcpBoundedProxyError('concurrent_turn');
        this.sessionId = null;
        this.turnFrames = 0;
        this.turnBytes = 0;
      }
      return null;
    }
    const key = rpcIdKey(message.id);
    if (this.outboundRequests.has(key)) throw new AcpBoundedProxyError('malformed_transport');

    const method = message.method;
    const isPrompt = PROMPT_METHODS.has(method);
    const isSession = SESSION_METHODS.has(method);
    if (isPrompt && this.activeTurn) throw new AcpBoundedProxyError('concurrent_turn');
    if (isSession && this.activeTurn) throw new AcpBoundedProxyError('concurrent_turn');

    const request = { id: message.id, method, kind: isPrompt ? 'prompt' : (isSession ? 'session' : 'request') };
    this.outboundRequests.set(key, request);

    if (isSession) {
      this.sessionId = null;
      this.activeTurn = null;
      this.turnFrames = 0;
      this.turnBytes = 0;
    }
    if (isPrompt) {
      this.activeTurn = { id: message.id, key };
      this.turnFrames = 0;
      this.turnBytes = 0;
    }
    return request;
  }

  _undoOutbound(request) {
    if (!request) return;
    this.outboundRequests.delete(rpcIdKey(request.id));
    if (request.kind === 'prompt' && this.activeTurn?.key === rpcIdKey(request.id)) {
      this.activeTurn = null;
      this.turnFrames = 0;
      this.turnBytes = 0;
    }
  }

  async _processProviderFrame(frame) {
    let message;
    try {
      message = parseFrame(frame);
    } catch (error) {
      if (error instanceof FrameLimitError && error.code === 'overflow') {
        throw new FrameLimitError('overflow');
      }
      throw new FrameLimitError('malformed');
    }

    if (this.activeTurn) {
      const nextFrames = this.turnFrames + 1;
      // Raw forwarded bytes include the NDJSON delimiter.  This keeps the
      // per-turn byte counter an exact count of what the control side sees.
      const nextBytes = this.turnBytes + frame.length;
      if (nextFrames > MAX_PROVIDER_FRAMES_PER_TURN || nextBytes > MAX_PROVIDER_BYTES_PER_TURN) {
        throw new FrameLimitError('turn_output');
      }
      this.turnFrames = nextFrames;
      this.turnBytes = nextBytes;
    }

    const terminalTurn = this._trackInbound(message);
    await this._writeControl(frame, message);
    this._emitSafe('provider_message', message);
    if (this.onProviderFrame) {
      try {
        await this.onProviderFrame(message);
      } catch {
        this._terminalize('malformed_transport');
        throw new FrameLimitError('malformed');
      }
    }
    if (terminalTurn) {
      this.activeTurn = null;
      this.turnFrames = 0;
      this.turnBytes = 0;
    }
  }

  _trackInbound(message) {
    if (Object.hasOwn(message, 'method')) return false;
    const request = this.outboundRequests.get(rpcIdKey(message.id));
    if (!request) throw new FrameLimitError('malformed');
    this.outboundRequests.delete(rpcIdKey(message.id));
    if (request.kind === 'session' && isRecord(message.result) && typeof message.result.sessionId === 'string') {
      this.sessionId = message.result.sessionId;
    }
    return request.kind === 'prompt';
  }

  async _writeProvider(frame) {
    if (!this.child?.stdin) throw new Error('provider stdin unavailable');
    const operation = this._providerWriteTail.then(async () => {
      if (this.state !== 'running' && this.state !== 'closing') throw new Error('provider is closed');
      await writeWithBackpressure(this.child.stdin, frame);
    });
    // Keep the queue alive after an individual failed write; the caller still
    // receives the original rejection and terminalizes the proxy.
    this._providerWriteTail = operation.catch(() => {});
    return operation;
  }

  async _writeControl(frame, message) {
    if (this.controlOutput) {
      try {
        await writeWithBackpressure(this.controlOutput, frame);
      } catch {
        this._terminalize('malformed_transport');
        throw new FrameLimitError('malformed');
      }
    }
  }

  _terminalize(classification) {
    const safeClassification = TERMINAL_SET.has(classification) ? classification : 'malformed_transport';
    if (this.terminalError || this.state === 'failed' || this.state === 'closed' || this.state === 'closing') {
      return this.terminalError;
    }
    this.terminalError = new AcpBoundedProxyError(safeClassification);
    this.state = 'failed';
    this._controlParser.buffer = Buffer.alloc(0);
    this._providerParser.buffer = Buffer.alloc(0);
    this.outboundRequests.clear();
    this.activeTurn = null;
    this.turnFrames = 0;
    this.turnBytes = 0;
    this._emitSafe('terminal', this.terminalError);
    this._closeExternalPipes(true);
    void this._terminateOwnedProvider().then(() => {
      this._settleDone(this.terminalError);
    });
    return this.terminalError;
  }

  _closeExternalPipes(destroy) {
    if (destroy) {
      try { this.controlInput?.destroy?.(); } catch { /* bounded close */ }
      try { this.controlOutput?.destroy?.(); } catch { /* bounded close */ }
      return;
    }
    try { this.controlInput?.destroy?.(); } catch { /* bounded close */ }
    try { this.controlOutput?.end?.(); } catch { /* bounded close */ }
  }

  async _terminateOwnedProvider() {
    if (this._stopPromise) return this._stopPromise;
    const child = this.child;
    if (!child) return true;

    this._stopPromise = (async () => {
      try { child.stdin?.end?.(); } catch { /* signal cleanup below */ }
      const pid = this.providerPid ?? child.pid;
      if (this.ownedProvider && process.platform !== 'win32' && Number.isSafeInteger(pid) && pid > 0) {
        const hadGroup = groupExists(pid);
        if (hadGroup) signalGroup(pid, 'SIGTERM');
        const goneAfterTerm = await waitForGroupGone(pid, this.termGraceMs);
        if (hadGroup && !goneAfterTerm) {
          signalGroup(pid, 'SIGKILL');
          await waitForGroupGone(pid, this.killGraceMs);
        }
        // A supplied child may not have been launched detached.  The normal
        // spawn path is group-owned, but a direct-child fallback still needs
        // to be reaped without assuming a negative-pid signal can reach it.
        if ((child.exitCode === null || child.exitCode === undefined) && !child.signalCode) {
          try { child.kill?.('SIGTERM'); } catch { /* bounded fallback */ }
          if (!(await waitForChildExit(child, this.termGraceMs))) {
            try { child.kill?.('SIGKILL'); } catch { /* bounded fallback */ }
            await waitForChildExit(child, this.killGraceMs);
          }
        }
      } else if (this.ownedProvider) {
        try { child.kill?.('SIGTERM'); } catch { /* bounded fallback */ }
        if (!(await waitForChildExit(child, this.termGraceMs))) {
          try { child.kill?.('SIGKILL'); } catch { /* bounded fallback */ }
          await waitForChildExit(child, this.killGraceMs);
        }
      } else {
        await waitForChildExit(child, this.termGraceMs);
      }

      try { child.stdin?.destroy?.(); } catch { /* bounded close */ }
      try { child.stdout?.destroy?.(); } catch { /* bounded close */ }
      try { child.stderr?.destroy?.(); } catch { /* bounded close */ }
      return true;
    })();
    return this._stopPromise;
  }

  _settleDone(value) {
    if (this._doneSettled) return;
    this._doneSettled = true;
    if (value instanceof AcpBoundedProxyError) {
      this._doneReject(value);
      this._emitSafe('close', value);
      return;
    }
    this._doneResolve(value);
    this._emitSafe('close', value);
  }

  _emitSafe(event, value) {
    try { this.emit(event, value); } catch { /* consumer callbacks cannot alter cleanup */ }
  }
}

export const BoundedAcpTransportProxy = AcpBoundedTransportProxy;
export const AcpTransportProxy = AcpBoundedTransportProxy;
export const BoundedAcpProxy = AcpBoundedTransportProxy;
export const AcpBoundedProxy = AcpBoundedTransportProxy;
export const AcpProxyError = AcpBoundedProxyError;
export const PROXY_LIMITS = ACP_BOUNDED_PROXY_LIMITS;

export function createAcpBoundedTransportProxy(options = {}) {
  return new AcpBoundedTransportProxy(options);
}

export function createAcpTransportProxy(options = {}) {
  return createAcpBoundedTransportProxy(options);
}

export function createBoundedAcpProxy(options = {}) {
  return createAcpBoundedTransportProxy(options);
}

export default AcpBoundedTransportProxy;
