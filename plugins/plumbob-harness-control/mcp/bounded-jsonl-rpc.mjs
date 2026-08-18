import { spawn as defaultSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
export const BOUNDED_RPC_TIMEOUT_MS = 10_000;
export const BOUNDED_RPC_MAX_OUTPUT_BYTES = 128 * 1024;
export const BOUNDED_RPC_MAX_LINE_BYTES = 64 * 1024;
export const BOUNDED_RPC_MAX_LINES = 512;
export const BOUNDED_RPC_MAX_PENDING = 16;
const TERM_MS = 250;
const KILL_MS = 500;
const POLL_MS = 25;
const BASE_ENV = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'];
const PROVIDER_ENV = {
  codex: [...BASE_ENV, 'CODEX_HOME'],
  grok: [...BASE_ENV, 'XAI_API_KEY'],
};
export class BoundedRpcError extends Error {
  constructor(code, message = code, rpcCode = null) {
    super(message);
    this.name = 'BoundedRpcError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0
  ? Math.min(value, maximum) : fallback;
export function buildAllowlistedEnvironment(provider, source = process.env) {
  if (!PROVIDER_ENV[provider]) throw new BoundedRpcError('invalid_options', 'Unsupported capacity provider.');
  const environment = Object.create(null);
  for (const key of PROVIDER_ENV[provider]) {
    if (typeof source?.[key] === 'string' && source[key]) environment[key] = source[key];
  }
  return environment;
}
function groupExists(pid) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
function signalGroup(pid, signal) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, signal); return true; } catch (error) { return error?.code === 'ESRCH'; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitGroup(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (groupExists(pid) && Date.now() < deadline) await sleep(POLL_MS);
  return !groupExists(pid);
}
function waitChild(child, timeout) {
  if (!child || child.exitCode !== null || child.signalCode || typeof child.once !== 'function') {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    child.once('exit', () => finish(true));
    child.once('close', () => finish(true));
  });
}
async function terminate(child) {
  if (!child) return true;
  try { child.stdin?.end?.(); } catch { /* signal cleanup below */ }
  if (process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    if (groupExists(child.pid)) signalGroup(child.pid, 'SIGTERM');
    if (await waitGroup(child.pid, TERM_MS)) return true;
    signalGroup(child.pid, 'SIGKILL');
    return waitGroup(child.pid, KILL_MS);
  }
  try { child.kill?.('SIGTERM'); } catch { /* bounded fallback */ }
  if (await waitChild(child, TERM_MS)) return true;
  try { child.kill?.('SIGKILL'); } catch { /* report false */ }
  return waitChild(child, KILL_MS);
}
const toBuffer = (chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
export class BoundedJsonlRpcTransport {
  constructor({
    provider, wire = 'jsonrpc2', command, args = [], cwd,
    timeoutMs = BOUNDED_RPC_TIMEOUT_MS,
    maxOutputBytes = BOUNDED_RPC_MAX_OUTPUT_BYTES,
    maxLineBytes = BOUNDED_RPC_MAX_LINE_BYTES,
    maxLines = BOUNDED_RPC_MAX_LINES,
    spawnImpl = defaultSpawn, envSource = process.env, onNotification,
  } = {}) {
    if (!PROVIDER_ENV[provider] || !['codex', 'jsonrpc2'].includes(wire)) {
      throw new BoundedRpcError('invalid_options', 'Unsupported capacity transport.');
    }
    if (typeof command !== 'string' || !command || command.length > 256
      || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 4096)
      || typeof spawnImpl !== 'function') {
      throw new BoundedRpcError('invalid_options', 'Capacity process options are invalid.');
    }
    Object.assign(this, {
      provider,
      wire,
      command,
      args: [...args],
      cwd,
      timeoutMs: bounded(timeoutMs, BOUNDED_RPC_TIMEOUT_MS, BOUNDED_RPC_TIMEOUT_MS),
      maxOutputBytes: bounded(maxOutputBytes, BOUNDED_RPC_MAX_OUTPUT_BYTES, BOUNDED_RPC_MAX_OUTPUT_BYTES),
      maxLineBytes: bounded(maxLineBytes, BOUNDED_RPC_MAX_LINE_BYTES, BOUNDED_RPC_MAX_LINE_BYTES),
      maxLines: bounded(maxLines, BOUNDED_RPC_MAX_LINES, BOUNDED_RPC_MAX_LINES),
      spawnImpl,
      envSource,
      onNotification,
      child: null,
      timer: null,
      stopPromise: null,
      stopped: false,
      failure: null,
      nextId: 1,
      pending: new Map(),
      outputBytes: 0,
      lines: 0,
      decoder: new StringDecoder('utf8'),
      buffer: '',
    });
  }
  start() {
    if (process.platform === 'win32') {
      throw new BoundedRpcError('platform_unsupported', 'Verified POSIX process-group cleanup is required; Windows is unsupported.');
    }
    if (this.child) throw new BoundedRpcError('invalid_state', 'Capacity transport already started.');
    try {
      this.child = this.spawnImpl(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
        env: buildAllowlistedEnvironment(this.provider, this.envSource),
        ...(this.cwd ? { cwd: this.cwd } : {}),
      });
    } catch {
      throw new BoundedRpcError('spawn_error', 'Capacity process could not be started.');
    }
    if (!this.child?.stdin || !this.child?.stdout || !this.child?.stderr) {
      void this.stop();
      throw new BoundedRpcError('process_error', 'Capacity process stdio is unavailable.');
    }
    this.child.once?.('error', () => this._abort('process_error'));
    this.child.once?.('exit', () => {
      if (!this.stopped && this.pending.size) this._abort('process_exit');
    });
    this.child.stdout.on?.('data', (chunk) => this._stdout(chunk));
    this.child.stderr.on?.('data', (chunk) => this._stderr(chunk));
    this.child.stdout.on?.('error', () => this._abort('stdout_error'));
    this.child.stderr.on?.('error', () => this._abort('stderr_error'));
    this.child.stdin.on?.('error', () => this._abort('stdin_error'));
    this.timer = setTimeout(() => this._abort('timeout'), this.timeoutMs);
    return this;
  }
  _message(id, method, params) {
    const message = this.wire === 'jsonrpc2' ? { jsonrpc: '2.0', id, method } : { id, method };
    if (params !== undefined) message.params = params;
    return message;
  }
  _write(message) {
    if (this.stopped || !this.child?.stdin) throw this.failure ?? new BoundedRpcError('closed');
    const text = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(text) > this.maxLineBytes) throw new BoundedRpcError('output_limit');
    try {
      this.child.stdin.write(text, (error) => { if (error) this._abort('stdin_error'); });
    } catch { throw new BoundedRpcError('stdin_error'); }
  }
  request(method, params, { validateResult } = {}) {
    if (this.stopped) return Promise.reject(this.failure ?? new BoundedRpcError('closed'));
    if (this.pending.size >= BOUNDED_RPC_MAX_PENDING || typeof method !== 'string' || !method || method.length > 256) {
      return Promise.reject(new BoundedRpcError('invalid_options'));
    }
    const id = this.nextId++;
    const pending = new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject, validateResult }));
    try { this._write(this._message(id, method, params)); } catch (error) {
      const state = this.pending.get(id);
      this.pending.delete(id);
      state?.reject(error instanceof BoundedRpcError ? error : new BoundedRpcError('stdin_error'));
    }
    return pending;
  }
  notify(method, params) {
    const message = this.wire === 'jsonrpc2' ? { jsonrpc: '2.0', method } : { method };
    if (params !== undefined) message.params = params;
    this._write(message);
  }
  _response(message) {
    if (!isRecord(message)) throw new BoundedRpcError('protocol_error');
    if (this.wire === 'jsonrpc2' && message.jsonrpc !== '2.0') throw new BoundedRpcError('protocol_error');
    if (this.wire === 'codex' && Object.hasOwn(message, 'jsonrpc')) throw new BoundedRpcError('protocol_error');
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (!Object.hasOwn(message, 'id')) {
      if (typeof message.method !== 'string' || !message.method || hasResult || hasError) {
        throw new BoundedRpcError('protocol_error');
      }
      this.onNotification?.(message);
      return;
    }
    if (Object.hasOwn(message, 'method')) throw new BoundedRpcError('protocol_error');
    if (!Number.isSafeInteger(message.id)) throw new BoundedRpcError('protocol_error');
    const request = this.pending.get(message.id);
    if (!request) throw new BoundedRpcError('protocol_error');
    if (hasResult === hasError) throw new BoundedRpcError('protocol_error');
    this.pending.delete(message.id);
    if (hasError) {
      if (!isRecord(message.error)) throw new BoundedRpcError('protocol_error');
      const code = Number.isSafeInteger(message.error.code) ? message.error.code : null;
      request.reject(new BoundedRpcError('rpc_error', 'Capacity RPC request failed.', code));
      return;
    }
    try {
      if (request.validateResult && request.validateResult(message.result) === false) throw new BoundedRpcError('protocol_error');
      request.resolve(message.result);
    } catch (error) { request.reject(error instanceof BoundedRpcError ? error : new BoundedRpcError('protocol_error')); }
  }
  _line(line) {
    if (++this.lines > this.maxLines || Buffer.byteLength(line) > this.maxLineBytes) return this._abort('output_limit');
    if (!line.trim()) return;
    try { this._response(JSON.parse(line)); } catch (error) { this._abort(error instanceof BoundedRpcError ? error.code : 'protocol_error'); }
  }
  _count(chunk) {
    this.outputBytes += toBuffer(chunk).byteLength;
    if (this.outputBytes > this.maxOutputBytes) {
      this._abort('output_limit');
      return false;
    }
    return true;
  }
  _stdout(chunk) {
    if (this.stopped || !this._count(chunk)) return;
    this.buffer += this.decoder.write(toBuffer(chunk));
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this._line(line);
      if (this.stopped) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) this._abort('output_limit');
  }
  _stderr(chunk) { if (!this.stopped) this._count(chunk); }
  _abort(code) {
    if (this.failure || this.stopped) return;
    this.failure = new BoundedRpcError(code);
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    void this.stop();
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    clearTimeout(this.timer);
    for (const request of this.pending.values()) request.reject(this.failure ?? new BoundedRpcError('closed'));
    this.pending.clear();
    this.stopPromise = terminate(this.child);
    return this.stopPromise;
  }
  close() { return this.stop(); }
}
