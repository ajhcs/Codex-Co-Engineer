import { lstat, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { redactText } from './redaction.mjs';

export const DEFAULT_API_ORIGIN = 'https://api.cursor.com';
export const API_VERSION = 'v1';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_REPOSITORY_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_ARTIFACT_REDIRECTS = 5;

export function defaultApiKeyFile(env = process.env) {
  return path.resolve(path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? '.', '.config'), 'cursor-cloud-control', 'api-key'));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const responseDeadlines = new WeakMap();

function requestTimeoutError() {
  return new CursorApiError('request_timeout', 'Cursor response exceeded the configured time bound.');
}

function remainingDeadline(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw requestTimeoutError();
  return remaining;
}

export class CursorApiError extends Error {
  constructor(code, message, { status, details, retryable = false, ambiguous = false } = {}) {
    super(message);
    this.name = 'CursorApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}

function validOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new CursorApiError('invalid_origin', 'CURSOR_API_ORIGIN must be an http(s) origin.'); }
  const hostname = parsed.hostname.toLowerCase();
  const loopbackOrTest = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
    || hostname.endsWith('.test');
  if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !loopbackOrTest)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CursorApiError('invalid_origin', 'CURSOR_API_ORIGIN must use HTTPS, or HTTP only for loopback/.test test origins, without credentials, query, or fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new CursorApiError('invalid_origin', 'CURSOR_API_ORIGIN must not include a path.');
  }
  return parsed.origin;
}

function integerEnv(name, fallback, min, max) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CursorApiError('invalid_configuration', `${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export async function loadApiKey(env = process.env, { pluginRoot } = {}) {
  const direct = typeof env.CURSOR_API_KEY === 'string' ? env.CURSOR_API_KEY.trim() : '';
  if (direct) return direct;
  const fileName = typeof env.CURSOR_API_KEY_FILE === 'string' && env.CURSOR_API_KEY_FILE.trim()
    ? env.CURSOR_API_KEY_FILE.trim()
    : defaultApiKeyFile(env);
  if (!fileName.startsWith('/')) throw new CursorApiError('invalid_configuration', 'CURSOR_API_KEY_FILE must be an absolute path.');
  if (pluginRoot) {
    const resolvedFile = path.resolve(fileName);
    const resolvedRoot = path.resolve(pluginRoot);
    if (resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new CursorApiError('invalid_configuration', 'CURSOR_API_KEY_FILE must point outside the plugin directory.');
    }
  }
  let metadata;
  try { metadata = await lstat(fileName); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new CursorApiError('credential_file_error', 'Unable to inspect CURSOR_API_KEY_FILE.');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CursorApiError('credential_file_error', 'CURSOR_API_KEY_FILE is not a regular file.');
  if ((metadata.mode & 0o077) !== 0) throw new CursorApiError('credential_file_permissions', 'CURSOR_API_KEY_FILE must be owner-only (mode 0600 or stricter).');
  let content;
  try { content = (await readFile(fileName, 'utf8')).trim(); } catch {
    throw new CursorApiError('credential_file_error', 'Unable to read CURSOR_API_KEY_FILE.');
  }
  return content || null;
}

export function authHeaderFromKey(apiKey, scheme = 'bearer') {
  if (typeof apiKey !== 'string' || !apiKey) throw new CursorApiError('credentials_missing', 'CURSOR_API_KEY is not configured.');
  const normalized = String(scheme).toLowerCase();
  if (normalized === 'bearer') return `Bearer ${apiKey}`;
  if (normalized !== 'basic') throw new CursorApiError('invalid_configuration', 'CURSOR_API_AUTH_SCHEME must be basic or bearer.');
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
}

function classifyHttp(status) {
  if (status === 401) return ['authentication_failed', false];
  if (status === 403) return ['permission_denied', false];
  if (status === 404) return ['not_found', false];
  if (status === 409) return ['conflict', false];
  if (status === 410) return ['stream_expired', false];
  if (status === 429) return ['rate_limited', true];
  if (status >= 500) return ['upstream_failure', true];
  if (status === 408) return ['upstream_timeout', true];
  if (status >= 400) return ['bad_request', false];
  return ['upstream_failure', false];
}

async function boundedBody(response, maxBytes, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (timeoutMs <= 0) throw requestTimeoutError();
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CursorApiError('response_too_large', 'Cursor response exceeded the configured size limit.');
  }
  if (!response.body?.getReader) {
    let timer;
    let text;
    try {
      text = await Promise.race([
        response.text(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(requestTimeoutError()), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new CursorApiError('response_too_large', 'Cursor response exceeded the configured size limit.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CursorApiError('response_too_large', 'Cursor response exceeded the configured size limit.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (timedOut) throw requestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }

  if (timedOut) throw requestTimeoutError();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function contentType(response) {
  return String(response.headers?.get?.('content-type') ?? '').toLowerCase().split(';', 1)[0].trim();
}

const ARTIFACT_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ARTIFACT_METADATA_HOSTS = new Set([
  'instance-data',
  'instance-data.ec2.internal',
  'metadata',
  'metadata.azure.com',
  'metadata.azure.internal',
  'metadata.google.com',
  'metadata.google.internal',
]);

function unsafeIpv4(hostname) {
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second, third] = octets;
  return first === 0
    || first === 10
    || first === 100 && second >= 64 && second <= 127
    || first === 127
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 0 && third === 0
    || first === 192 && second === 0 && third === 2
    || first === 192 && second === 88 && third === 99
    || first === 192 && second === 168
    || first === 198 && (second === 18 || second === 19)
    || first === 198 && second === 51 && third === 100
    || first === 203 && second === 0 && third === 113
    || first >= 224;
}

function parseIpv6(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const sections = value.split('::');
  if (sections.length > 2) return null;
  const parseSection = (section) => {
    if (!section) return [];
    const values = section.split(':');
    const groups = [];
    for (const part of values) {
      if (part.includes('.')) {
        const octets = part.split('.').map((entry) => Number(entry));
        if (octets.length !== 4 || octets.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parseSection(sections[0]);
  const right = sections.length === 2 ? parseSection(sections[1]) : [];
  if (!left || !right) return null;
  if (sections.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length >= 8) return null;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

function unsafeIpv6(hostname) {
  const groups = parseIpv6(hostname);
  if (!groups) return false;
  const allZero = groups.every((group) => group === 0);
  const loopback = allZero || groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const uniqueLocal = (groups[0] & 0xfe00) === 0xfc00;
  const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
  const siteLocal = (groups[0] & 0xffc0) === 0xfec0;
  const multicast = (groups[0] & 0xff00) === 0xff00;
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const ipv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  if (ipv4Mapped) {
    const first = groups[6] >> 8;
    const second = groups[6] & 0xff;
    const third = groups[7] >> 8;
    const fourth = groups[7] & 0xff;
    return unsafeIpv4(`${first}.${second}.${third}.${fourth}`);
  }
  return loopback || uniqueLocal || linkLocal || siteLocal || multicast || ipv4Compatible;
}

function validateArtifactUrl(value) {
  let parsed;
  try { parsed = value instanceof URL ? value : new URL(value); } catch {
    throw new CursorApiError('invalid_artifact_url', 'Cursor returned an invalid artifact URL.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(normalizedHost);
  const unsafeHost = ARTIFACT_METADATA_HOSTS.has(hostname)
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || ipVersion === 4 && unsafeIpv4(normalizedHost)
    || ipVersion === 6 && unsafeIpv6(normalizedHost);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !hostname || unsafeHost) {
    throw new CursorApiError('invalid_artifact_url', 'Cursor returned an unsafe artifact URL.');
  }
  return parsed;
}

export class CursorApiClient {
  constructor({
    apiKey,
    authScheme = process.env.CURSOR_API_AUTH_SCHEME ?? 'bearer',
    origin = process.env.CURSOR_API_ORIGIN ?? DEFAULT_API_ORIGIN,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = integerEnv('CURSOR_CLOUD_CONTROL_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, 250, 60_000),
    repositoryTimeoutMs = integerEnv('CURSOR_CLOUD_CONTROL_REPOSITORY_TIMEOUT_MS', DEFAULT_REPOSITORY_TIMEOUT_MS, 1_000, 60_000),
    maxResponseBytes = integerEnv('CURSOR_CLOUD_CONTROL_MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES, 1024, 20_000_000),
  } = {}) {
    this.apiKey = apiKey ?? null;
    this.authScheme = String(authScheme).toLowerCase();
    this.origin = validOrigin(origin ?? DEFAULT_API_ORIGIN);
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.repositoryTimeoutMs = repositoryTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.secrets = this.apiKey ? [this.apiKey] : [];
    if (typeof this.fetchImpl !== 'function') throw new CursorApiError('fetch_unavailable', 'Node fetch is unavailable.');
  }

  authHeader() { return authHeaderFromKey(this.apiKey, this.authScheme); }

  url(pathname, query = undefined) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/v1/')) throw new CursorApiError('internal_error', 'Unsupported Cursor API path.');
    const parsed = new URL(pathname, `${this.origin}/`);
    if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined) parsed.searchParams.set(key, String(value));
    return parsed;
  }

  async request(pathname, { method = 'GET', query, body, accept = 'application/json', lastEventId, timeoutMs = this.requestTimeoutMs, retryRead = method === 'GET' } = {}) {
    const url = this.url(pathname, query);
    const attempts = retryRead && method === 'GET' ? 3 : 1;
    const deadline = Date.now() + timeoutMs;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = remainingDeadline(deadline);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      const headers = { Accept: accept, Authorization: this.authHeader() };
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try {
        const serialized = body === undefined ? undefined : JSON.stringify(body);
        if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > DEFAULT_MAX_REQUEST_BYTES) {
          throw new CursorApiError('request_too_large', 'Cursor request exceeded the configured size limit.');
        }
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: serialized,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const wrapped = error instanceof CursorApiError
          ? error
          : new CursorApiError(error?.name === 'AbortError' ? 'request_timeout' : 'network_error', 'Cursor API request failed.', { retryable: true });
        lastError = wrapped;
        if (attempt + 1 < attempts && Date.now() < deadline) {
          await sleep(Math.min(100 * (2 ** attempt), remainingDeadline(deadline)));
          continue;
        }
        throw wrapped;
      }
      clearTimeout(timer);
      if (!response.ok) {
        let detail = '';
        try {
          detail = await boundedBody(response, Math.min(this.maxResponseBytes, 100_000), remainingDeadline(deadline));
        } catch (error) {
          if (error?.code === 'request_timeout') throw error;
        }
        const [code, retryable] = classifyHttp(response.status);
        const safeDetail = detail ? redactText(detail, this.secrets) : '';
        const message = safeDetail ? `Cursor API returned HTTP ${response.status}: ${safeDetail}` : `Cursor API returned HTTP ${response.status}.`;
        const error = new CursorApiError(code, message, { status: response.status, retryable });
        lastError = error;
        if (retryable && attempt + 1 < attempts && Date.now() < deadline) {
          await sleep(Math.min(100 * (2 ** attempt), remainingDeadline(deadline)));
          continue;
        }
        throw error;
      }
      responseDeadlines.set(response, deadline);
      return response;
    }
    throw lastError ?? new CursorApiError('network_error', 'Cursor API request failed.');
  }

  async json(pathname, options = {}) {
    const response = await this.request(pathname, options);
    if (response.status === 204) return {};
    const type = contentType(response);
    if (!['application/json', 'application/problem+json', 'text/json'].includes(type)) {
      throw new CursorApiError('invalid_content_type', 'Cursor API returned a non-JSON response.');
    }
    const deadline = responseDeadlines.get(response) ?? (Date.now() + (options.timeoutMs ?? this.requestTimeoutMs));
    const text = await boundedBody(response, this.maxResponseBytes, remainingDeadline(deadline));
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch {
      throw new CursorApiError('invalid_json', 'Cursor API returned invalid JSON.');
    }
  }

  async stream(pathname, { lastEventId, timeoutMs = this.requestTimeoutMs } = {}) {
    const response = await this.request(pathname, {
      method: 'GET',
      accept: 'text/event-stream',
      lastEventId,
      timeoutMs,
      retryRead: false,
    });
    const type = contentType(response);
    if (type !== 'text/event-stream') {
      throw new CursorApiError('invalid_content_type', 'Cursor stream did not return text/event-stream.');
    }
    return response;
  }

  async fetchPresigned(urlValue, { maxBytes = DEFAULT_MAX_ARTIFACT_BYTES, timeoutMs = this.requestTimeoutMs, maxRedirects = DEFAULT_MAX_ARTIFACT_REDIRECTS } = {}) {
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
      throw new CursorApiError('invalid_configuration', 'maxRedirects must be an integer between 0 and 10.');
    }
    let current = validateArtifactUrl(urlValue);
    const deadline = Date.now() + timeoutMs;
    let redirects = 0;
    while (true) {
      const remaining = remainingDeadline(deadline);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let response;
      try {
        response = await this.fetchImpl(current, {
          method: 'GET',
          // Presigned artifact hosts must never receive the Cursor API key.
          headers: { Accept: '*/*' },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof CursorApiError) throw error;
        throw new CursorApiError(error?.name === 'AbortError' ? 'request_timeout' : 'network_error', 'Artifact download failed.');
      } finally { clearTimeout(timer); }

      if (ARTIFACT_REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maxRedirects) {
          await response.body?.cancel?.().catch(() => {});
          throw new CursorApiError('artifact_redirect_limit', 'Artifact download exceeded the redirect limit.');
        }
        const location = response.headers?.get?.('location');
        await response.body?.cancel?.().catch(() => {});
        if (!location) throw new CursorApiError('artifact_download_failed', `Artifact redirect returned HTTP ${response.status} without a location.`, { status: response.status });
        let next;
        try { next = new URL(location, current); } catch {
          throw new CursorApiError('invalid_artifact_url', 'Cursor returned an invalid artifact redirect.');
        }
        validateArtifactUrl(next);
        current = next;
        redirects += 1;
        continue;
      }
      if (!response.ok) throw new CursorApiError('artifact_download_failed', `Artifact download returned HTTP ${response.status}.`, { status: response.status });
      return boundedBytes(response, maxBytes, remainingDeadline(deadline));
    }
  }

  me() { return this.json('/v1/me'); }
  models() { return this.json('/v1/models'); }
  // Cursor documents this endpoint as slow and rate-limited to one call per
  // user per minute. Give it one longer attempt instead of applying the
  // generic three-attempt GET retry policy.
  repositories() {
    return this.json('/v1/repositories', {
      timeoutMs: this.repositoryTimeoutMs,
      retryRead: false,
    });
  }
  listAgents(query) { return this.json('/v1/agents', { query }); }
  getAgent(agentId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}`); }
  createAgent(body) {
    const timeoutMs = Array.isArray(body?.repos) && body.repos.length > 0
      ? this.repositoryTimeoutMs
      : this.requestTimeoutMs;
    return this.json('/v1/agents', {
      method: 'POST',
      body,
      retryRead: false,
      timeoutMs,
    });
  }
  listRuns(agentId, query) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/runs`, { query }); }
  getRun(agentId, runId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`); }
  createRun(agentId, body) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/runs`, { method: 'POST', body, retryRead: false }); }
  cancelRun(agentId, runId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', retryRead: false }); }
  streamRun(agentId, runId, options) {
    const path = `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
    return this.stream(path, options);
  }
  usage(agentId, runId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/usage`, { query: runId ? { runId } : undefined }); }
  artifacts(agentId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/artifacts`); }
  artifactDownload(agentId, artifactPath) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/artifacts/download`, { query: { path: artifactPath } }); }
  archive(agentId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/archive`, { method: 'POST', retryRead: false }); }
  unarchive(agentId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}/unarchive`, { method: 'POST', retryRead: false }); }
  deleteAgent(agentId) { return this.json(`/v1/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE', retryRead: false }); }
}

async function boundedBytes(response, maxBytes, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new CursorApiError('artifact_too_large', 'Artifact exceeds the configured size limit.');
  if (!response.body?.getReader) {
    let timer;
    const bytes = new Uint8Array(await Promise.race([
      response.arrayBuffer(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new CursorApiError('request_timeout', 'Artifact response exceeded the configured time bound.')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer)));
    if (bytes.byteLength > maxBytes) throw new CursorApiError('artifact_too_large', 'Artifact exceeds the configured size limit.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CursorApiError('artifact_too_large', 'Artifact exceeds the configured size limit.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (timedOut) throw new CursorApiError('request_timeout', 'Artifact response exceeded the configured time bound.');
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }
  if (timedOut) throw new CursorApiError('request_timeout', 'Artifact response exceeded the configured time bound.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function clientFromEnvironment({ fetchImpl, apiKey, ...options } = {}) {
  return new CursorApiClient({
    apiKey,
    fetchImpl,
    origin: options.origin ?? process.env.CURSOR_API_ORIGIN ?? DEFAULT_API_ORIGIN,
    authScheme: options.authScheme ?? process.env.CURSOR_API_AUTH_SCHEME ?? 'bearer',
    ...options,
  });
}
