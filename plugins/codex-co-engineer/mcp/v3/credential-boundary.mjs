// CredentialBoundaryV1 — P29 credential and remote-mutation isolation.
// Closed provider/operation environment projection, owner-only credential
// reads, argv-free secret handoff, exact-value redaction, and worker
// push/remote-mutation denial. Not a sandbox: same-UID malicious
// filesystem access is outside this boundary. P23 registry composition
// and P28 Git authority policy remain the accepted seams; this module
// does not wrap them.

import { Buffer as NodeBuffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  constants as fsConstants,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import { capturedFreeze, capturedHasOwn, capturedIncludes } from './grammar.mjs';
import { DENIED_OPERATIONS } from './git-authority.mjs';
import { assertNotProxy } from './selection-json.mjs';

export const CREDENTIAL_BOUNDARY_SCHEMA_ID = 'codex-co-engineer.credential-boundary.v1';
export const CREDENTIAL_BOUNDARY_VERSION = 1;
export const MAX_CREDENTIAL_BYTES = 16 * 1024;
export const MAX_HANDOFF_BYTES = 64 * 1024;
export const REDACTION_FRAGMENT_BYTES = 32;
export const REDACTION_FRAGMENT_STRIDE = 16;
export const REDACTED = '[REDACTED]';
export const HANDOFF_ENV_KEY = 'CODEX_CO_ENGINEER_CREDENTIAL_HANDOFF';
export const DEFAULT_DSH_MODEL = 'muse-spark-1.2-contributor';
export const DSH_OX_MODEL = 'stealth/ox-alpha';

export const OPERATIONAL_ENV_KEYS = capturedFreeze([
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'TERM', 'TMPDIR',
  'TZ', 'USER', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]);

export const SYSTEMD_CLIENT_ENV_KEYS = capturedFreeze([
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_SESSION_ID',
]);

export const GIT_INSPECT_ENV = capturedFreeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ALLOW_PROTOCOL: '',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_ASKPASS: '',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
});

export const GIT_HARDENING_ENV = capturedFreeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_PUSH_OPTION_COUNT: '0',
});

export const CREDENTIAL_ENV_KEYS = capturedFreeze([
  'CURSOR_API_KEY', 'MODEL_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY',
]);

export const CREDENTIAL_FILE_ENV_KEYS = capturedFreeze([
  'CODEX_CO_ENGINEER_MODEL_API_KEY_FILE',
  'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
  'CURSOR_API_KEY_FILE',
]);

export const PROVIDER_COMMAND_KEYS = capturedFreeze([
  'CODEX_CO_ENGINEER_ACPX_COMMAND',
  'CODEX_CO_ENGINEER_CURSOR_COMMAND',
  'CODEX_CO_ENGINEER_DSH_ACP_COMMAND',
  'CODEX_CO_ENGINEER_DSH_ACP_CONFIG',
  'CODEX_CO_ENGINEER_DSH_COMMAND',
  'CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG',
  'CODEX_CO_ENGINEER_DSH_PROFILE',
  'CODEX_CO_ENGINEER_GROK_COMMAND',
]);

export const DSH_ROUTE = capturedFreeze({
  [DEFAULT_DSH_MODEL]: capturedFreeze({
    credentialEnv: 'MODEL_API_KEY',
    credentialFileEnv: 'CODEX_CO_ENGINEER_MODEL_API_KEY_FILE',
    credentialFile: 'model-api-key',
    configEnv: 'CODEX_CO_ENGINEER_DSH_ACP_CONFIG',
  }),
  [DSH_OX_MODEL]: capturedFreeze({
    credentialEnv: 'OPENROUTER_API_KEY',
    credentialFileEnv: 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
    credentialFile: 'openrouter-api-key',
    configEnv: 'CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG',
  }),
});

export const CREDENTIAL_BOUNDARY_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'credential_empty', 'credential_file_changed',
  'credential_hardlink_denied', 'credential_owner_denied',
  'credential_permissions', 'credential_symlink_denied',
  'credential_too_large', 'credential_unreadable', 'exotic_prototype_denied',
  'invalid_credential_file', 'invalid_credential_path', 'invalid_env',
  'invalid_handoff', 'invalid_provider', 'proxy_denied', 'push_url_denied',
  'remote_mutation_denied', 'symbol_key_denied',
]);

const OPEN_READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);

const OPEN_WRITE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);

const IS_PROXY = utilTypes.isProxy;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const OBJECT_HAS_OWN = Object.hasOwn;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_PROTOTYPE = Object.prototype;

const CREDENTIAL_KEY_PATTERN = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|credential|private[_-]?key)$/iu;
const HOSTING_KEY_PATTERN = /^(?:GH|GITHUB|GITLAB|GL|BITBUCKET|BB|HG|GITEA|FORGEJO|SOURCEHUT)_/u;
const GIT_KEY_PATTERN = /^GIT_/u;
const SSH_KEY_PATTERN = /^SSH_/u;
const CONTROL_KEY_PATTERN = /^(?:WORKTREE_BOOTSTRAP_|CODEX_CO_ENGINEER_STATE_DIR$|MCP_|SUPERVISOR_|FAKE_ACPX_)/u;
const CLOSED_TEST_INJECTION_KEY = /^FAKE_ACPX_[A-Z0-9_]+$/u;
const HANDOFF_IDENTITY = /^[a-f0-9]{32}$/u;
const HANDOFF_IDENTITY_DIR = /^cce-p29-[a-f0-9]{32}$/u;

let closedProviderTestInjection = null;
const PUSH_URL_KEY_PATTERN = /(?:pushurl|insteadOf|askpass|credential)/iu;
const USERINFO_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/iu;
const TOKEN_QUERY = /[?&](?:token|access_token|api[_-]?key|secret|password|credential)=/iu;
const SCP_USERINFO = /^(?![a-z][a-z0-9+.-]*:\/\/)[^@\s]+@[^@\s]+:/u;

const CONTENT_FREE = capturedFreeze({
  accessor_property_denied: 'Environment input cannot use accessor properties.',
  credential_empty: 'Provider credential configuration is invalid.',
  credential_file_changed: 'Provider credential configuration is invalid.',
  credential_hardlink_denied: 'Provider credential configuration is invalid.',
  credential_owner_denied: 'Provider credential configuration is invalid.',
  credential_permissions: 'Provider credential configuration is invalid.',
  credential_symlink_denied: 'Provider credential configuration is invalid.',
  credential_too_large: 'Provider credential configuration is invalid.',
  credential_unreadable: 'Provider credential configuration is invalid.',
  exotic_prototype_denied: 'Environment input is not a direct data object.',
  invalid_credential_file: 'Provider credential configuration is invalid.',
  invalid_credential_path: 'Provider credential configuration is invalid.',
  invalid_env: 'Provider environment is invalid.',
  invalid_handoff: 'Provider credential configuration is invalid.',
  invalid_provider: 'Unsupported provider.',
  proxy_denied: 'Environment input cannot be a Proxy.',
  push_url_denied: 'Worker push URLs are not authorized.',
  remote_mutation_denied: 'Worker remote mutation is not authorized.',
  symbol_key_denied: 'Environment input cannot use symbol keys.',
});

export class CredentialBoundaryError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'CredentialBoundaryError';
    this.code = code;
  }
}

function fail(code, options) {
  throw new CredentialBoundaryError(code, CONTENT_FREE[code] ?? CONTENT_FREE.invalid_env, options);
}

function requirePlainSource(source, field = 'env') {
  if (source == null || (typeof source !== 'object' && typeof source !== 'function') || Array.isArray(source)) {
    fail('invalid_env');
  }
  if (IS_PROXY(source)) fail('proxy_denied');
  try {
    assertNotProxy(source, field);
  } catch (error) {
    if (error?.code === 'proxy_denied') fail('proxy_denied');
    throw error;
  }
  const proto = Object.getPrototypeOf(source);
  if (proto !== null && proto !== OBJECT_PROTOTYPE && source !== process.env) {
    // process.env is a special object; other exotic prototypes are denied.
    if (proto !== Object.getPrototypeOf(process.env)) fail('exotic_prototype_denied');
  }
  return source;
}

function ownString(source, key) {
  if (typeof key === 'symbol') fail('symbol_key_denied');
  if (!OBJECT_HAS_OWN(source, key)) return undefined;
  const descriptor = GET_DESCRIPTOR(source, key);
  if (descriptor === undefined || !descriptor.enumerable) fail('accessor_property_denied');
  if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
    fail('accessor_property_denied');
  }
  const value = descriptor.value;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.includes('\0')) fail('invalid_env');
  return value;
}

function copyKeys(source, keys, output) {
  for (const key of keys) {
    const value = ownString(source, key);
    if (value !== undefined && value.length > 0) output[key] = value;
  }
  return output;
}

export function isCredentialEnvKey(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (capturedIncludes(CREDENTIAL_ENV_KEYS, name)) return true;
  if (capturedIncludes(CREDENTIAL_FILE_ENV_KEYS, name)) return true;
  return CREDENTIAL_KEY_PATTERN.test(name);
}

export function isForbiddenProviderEnvKey(name) {
  if (typeof name !== 'string' || name.length === 0) return true;
  if (GIT_KEY_PATTERN.test(name) && !capturedHasOwn(GIT_HARDENING_ENV, name)) return true;
  if (SSH_KEY_PATTERN.test(name)) return true;
  if (HOSTING_KEY_PATTERN.test(name)) return true;
  if (CONTROL_KEY_PATTERN.test(name)) return true;
  if (capturedIncludes(CREDENTIAL_FILE_ENV_KEYS, name)) return true;
  if (PUSH_URL_KEY_PATTERN.test(name)) return true;
  if (name === HANDOFF_ENV_KEY) return true;
  if (name === 'NODE_OPTIONS' || name === 'NODE_PATH' || name === 'NODE_REPL_EXTERNAL_MODULE') return true;
  return false;
}

function resolveDshRoute(dshModel) {
  const model = dshModel ?? DEFAULT_DSH_MODEL;
  const route = DSH_ROUTE[model];
  if (!route) fail('invalid_provider');
  return route;
}

function providerAllowlist(provider, dshModel, operation) {
  const keys = [...OPERATIONAL_ENV_KEYS];
  if (operation === 'systemd_client') return [...SYSTEMD_CLIENT_ENV_KEYS];
  if (operation === 'sdk_probe') return [...OPERATIONAL_ENV_KEYS, 'npm_config_prefix', 'NPM_CONFIG_PREFIX'];
  if (operation === 'git_inspect') return [];
  if (provider === 'grok') {
    keys.push('XAI_API_KEY', 'CODEX_CO_ENGINEER_GROK_COMMAND');
  } else if (provider === 'cursor-local') {
    keys.push('CODEX_CO_ENGINEER_CURSOR_COMMAND');
  } else if (provider === 'cursor-cloud') {
    keys.push('CURSOR_API_KEY');
  } else if (provider === 'dsh') {
    const route = resolveDshRoute(dshModel);
    keys.push(
      'CODEX_CO_ENGINEER_DSH_COMMAND',
      'CODEX_CO_ENGINEER_ACPX_COMMAND',
      'CODEX_CO_ENGINEER_DSH_ACP_COMMAND',
      'CODEX_CO_ENGINEER_DSH_PROFILE',
      route.configEnv,
    );
    if (operation !== 'readiness_probe') keys.push(route.credentialEnv);
  } else if (provider !== undefined) {
    fail('invalid_provider');
  }
  return keys.filter((key) => !isForbiddenProviderEnvKey(key) || capturedHasOwn(GIT_HARDENING_ENV, key));
}

export function projectProviderEnvironment({
  provider, source = process.env, dshModel, operation = 'lane',
} = {}) {
  const envSource = requirePlainSource(source);
  if (operation === 'git_inspect') return { ...GIT_INSPECT_ENV };
  if (operation === 'systemd_client') {
    const output = Object.create(null);
    copyKeys(envSource, SYSTEMD_CLIENT_ENV_KEYS, output);
    return output;
  }
  if (operation === 'service') {
    const output = Object.create(null);
    copyKeys(envSource, OPERATIONAL_ENV_KEYS, output);
    copyKeys(envSource, PROVIDER_COMMAND_KEYS, output);
    Object.assign(output, GIT_HARDENING_ENV);
    for (const key of CREDENTIAL_ENV_KEYS) delete output[key];
    for (const key of CREDENTIAL_FILE_ENV_KEYS) delete output[key];
    delete output[HANDOFF_ENV_KEY];
    return output;
  }
  const output = Object.create(null);
  copyKeys(envSource, providerAllowlist(provider, dshModel, operation), output);
  if (operation === 'lane' || operation === 'readiness') {
    Object.assign(output, GIT_HARDENING_ENV);
  }
  if (provider === 'dsh') {
    const route = resolveDshRoute(dshModel);
    for (const other of Object.values(DSH_ROUTE)) {
      if (other.credentialEnv !== route.credentialEnv) delete output[other.credentialEnv];
      delete output[other.credentialFileEnv];
    }
  } else {
    delete output.MODEL_API_KEY;
    delete output.OPENROUTER_API_KEY;
    if (provider !== 'grok') delete output.XAI_API_KEY;
    if (provider !== 'cursor-cloud') delete output.CURSOR_API_KEY;
  }
  for (const key of CREDENTIAL_FILE_ENV_KEYS) delete output[key];
  return output;
}

export function systemdClientEnvironment(source = process.env) {
  return projectProviderEnvironment({ source, operation: 'systemd_client' });
}

export function extractCredentialEnv(env) {
  const source = requirePlainSource(env);
  const secrets = Object.create(null);
  for (const key of CREDENTIAL_ENV_KEYS) {
    const value = ownString(source, key);
    if (value !== undefined && value.length > 0) secrets[key] = value;
  }
  return secrets;
}

export function omitCredentialEnv(env) {
  const source = requirePlainSource(env);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') fail('symbol_key_denied');
    if (isCredentialEnvKey(key)) continue;
    const value = ownString(source, key);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function configHome(source) {
  const xdg = ownString(source, 'XDG_CONFIG_HOME');
  if (xdg) {
    if (!path.isAbsolute(xdg) || path.resolve(xdg) !== xdg) fail('invalid_credential_path');
    return xdg;
  }
  const home = ownString(source, 'HOME');
  const root = home && path.isAbsolute(home) ? path.resolve(home) : homedir();
  return path.join(root, '.config');
}

function requireAbsolutePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    fail('invalid_credential_path');
  }
  // Overrides must fail before path.resolve would convert a relative path.
  if (!path.isAbsolute(filePath) || filePath.includes('//') || filePath.includes('\\')) {
    fail('invalid_credential_path');
  }
  if (path.normalize(filePath) !== filePath || path.resolve(filePath) !== filePath) {
    fail('invalid_credential_path');
  }
  return filePath;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function validateCredentialStat(metadata, maxBytes = MAX_CREDENTIAL_BYTES) {
  if (typeof metadata?.isSymbolicLink === 'function' && metadata.isSymbolicLink()) {
    fail('credential_symlink_denied');
  }
  if (typeof metadata?.isFile !== 'function' || !metadata.isFile()) fail('invalid_credential_file');
  if (metadata.nlink !== 1n && metadata.nlink !== 1) fail('credential_hardlink_denied');
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid?.();
  if (Number.isInteger(uid) && Number(metadata.uid) !== uid) fail('credential_owner_denied');
  const mode = Number(metadata.mode);
  if ((mode & 0o7777) !== 0o600) fail('credential_permissions');
  const size = Number(metadata.size);
  if (!Number.isFinite(size) || size < 0) fail('invalid_credential_file');
  if (size === 0) fail('credential_empty');
  if (size > maxBytes) fail('credential_too_large');
}

export async function loadCredentialFile(filePath, { maxBytes = MAX_CREDENTIAL_BYTES, openFile = open } = {}) {
  const resolved = requireAbsolutePath(filePath);
  let handle;
  try {
    handle = await openFile(resolved, OPEN_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') fail('credential_symlink_denied', { cause: error });
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') fail('invalid_credential_file', { cause: error });
    fail('credential_unreadable', { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    validateCredentialStat(before, maxBytes);
    if (Number(before.size) > maxBytes) fail('credential_too_large');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || bytes.length !== Number(before.size)) {
      fail('credential_file_changed');
    }
    const text = bytes.toString('utf8').trim();
    if (!text || text.includes('\0')) fail('invalid_credential_file');
    if (BYTE_LENGTH(text) > maxBytes) fail('credential_too_large');
    return text;
  } finally {
    await handle.close().catch(() => {});
  }
}

function credentialSpec(provider, dshModel) {
  if (provider === 'grok') {
    return { credentialEnv: 'XAI_API_KEY', credentialFileEnv: null, defaultFile: null };
  }
  if (provider === 'cursor-cloud') {
    return {
      credentialEnv: 'CURSOR_API_KEY',
      credentialFileEnv: 'CURSOR_API_KEY_FILE',
      defaultFile: ['cursor-cloud-control', 'api-key'],
    };
  }
  if (provider === 'dsh') {
    const route = resolveDshRoute(dshModel);
    return {
      credentialEnv: route.credentialEnv,
      credentialFileEnv: route.credentialFileEnv,
      defaultFile: ['codex-co-engineer', route.credentialFile],
    };
  }
  if (provider === 'cursor-local') return null;
  fail('invalid_provider');
}

export async function loadProviderCredential({ provider, source = process.env, dshModel } = {}) {
  const envSource = requirePlainSource(source);
  const spec = credentialSpec(provider, dshModel);
  if (!spec) return null;
  const existing = ownString(envSource, spec.credentialEnv)?.trim();
  if (existing) {
    if (BYTE_LENGTH(existing) > MAX_CREDENTIAL_BYTES) fail('credential_too_large');
    return { name: spec.credentialEnv, value: existing };
  }
  if (!spec.defaultFile && !spec.credentialFileEnv) return null;
  const override = spec.credentialFileEnv ? ownString(envSource, spec.credentialFileEnv)?.trim() : undefined;
  if (override) {
    return { name: spec.credentialEnv, value: await loadCredentialFile(requireAbsolutePath(override)) };
  }
  const file = path.join(configHome(envSource), ...spec.defaultFile);
  return { name: spec.credentialEnv, value: await loadCredentialFile(requireAbsolutePath(file)) };
}

export async function materializeProviderEnvironment({
  provider, source = process.env, dshModel, operation = 'lane',
} = {}) {
  const projected = projectProviderEnvironment({ provider, source, dshModel, operation });
  if (operation === 'readiness_probe' && (provider === 'dsh' || provider === undefined)) {
    return projected;
  }
  if (operation === 'sdk_probe' || operation === 'git_inspect' || operation === 'systemd_client' || operation === 'service') {
    return projected;
  }
  try {
    const loaded = await loadProviderCredential({ provider, source, dshModel });
    if (loaded) projected[loaded.name] = loaded.value;
  } catch (error) {
    if (operation === 'readiness' || operation === 'readiness_probe') throw error;
    if (provider === 'dsh' || provider === 'cursor-cloud') throw error;
  }
  for (const key of CREDENTIAL_FILE_ENV_KEYS) delete projected[key];
  return projected;
}

export function collectLaneSecrets(env = process.env) {
  const source = requirePlainSource(env);
  const secrets = [];
  for (const key of CREDENTIAL_ENV_KEYS) {
    const value = ownString(source, key);
    if (value) secrets.push(value);
  }
  return secrets;
}

export function credentialRedactionFragments(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return [];
  const fragments = [secret];
  const bytes = NodeBuffer.from(secret, 'utf8');
  if (bytes.length <= REDACTION_FRAGMENT_BYTES) return fragments;
  for (let offset = 0; offset <= bytes.length - REDACTION_FRAGMENT_BYTES; offset += REDACTION_FRAGMENT_STRIDE) {
    fragments.push(bytes.subarray(offset, offset + REDACTION_FRAGMENT_BYTES).toString('utf8'));
  }
  const tail = bytes.subarray(bytes.length - REDACTION_FRAGMENT_BYTES).toString('utf8');
  if (!fragments.includes(tail)) fragments.push(tail);
  return fragments;
}

function redactSecretSlices(text, secret, minimum = REDACTION_FRAGMENT_BYTES) {
  if (typeof secret !== 'string' || secret.length === 0 || text.length === 0) return text;
  if (text.includes(secret)) return text.split(secret).join(REDACTED);
  if (secret.includes(text)) return REDACTED;
  if (secret.length < 4) return text;
  const needle = Math.min(minimum, secret.length);
  let output = text;
  let index = 0;
  while (index <= output.length - needle) {
    const window = output.slice(index, index + needle);
    const found = secret.indexOf(window);
    if (found < 0) {
      index += 1;
      continue;
    }
    let length = needle;
    while (index + length < output.length && found + length < secret.length
      && output[index + length] === secret[found + length]) {
      length += 1;
    }
    output = `${output.slice(0, index)}${REDACTED}${output.slice(index + length)}`;
    index += REDACTED.length;
  }
  return output;
}

export function redactExactValues(value, secrets = []) {
  let text = String(value ?? '');
  const ordered = [...secrets]
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) text = redactSecretSlices(text, secret);
  return text;
}

function runtimeHandoffRoot() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (typeof runtime === 'string' && path.isAbsolute(runtime) && path.resolve(runtime) === runtime) {
    return runtime;
  }
  return tmpdir();
}

export function handoffPathFromProcessIdentity(identity) {
  if (typeof identity !== 'string' || !HANDOFF_IDENTITY.test(identity)) fail('invalid_handoff');
  return requireAbsolutePath(path.join(runtimeHandoffRoot(), `cce-p29-${identity}`, 'env.json'));
}

async function prepareHandoffDirectory({ directory, identity } = {}) {
  if (directory) return requireAbsolutePath(directory);
  if (identity !== undefined) {
    const root = path.dirname(handoffPathFromProcessIdentity(identity));
    await cleanupCredentialHandoff(path.join(root, 'env.json')).catch(() => {});
    try {
      await mkdir(root, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('invalid_handoff', { cause: error });
    }
    return root;
  }
  return mkdtemp(path.join(runtimeHandoffRoot(), 'cce-p29-handoff-'));
}

export function installClosedProviderTestInjection(source) {
  if (source == null) {
    closedProviderTestInjection = null;
    return;
  }
  const envSource = requirePlainSource(source, 'testInjection');
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(envSource)) {
    if (typeof key !== 'string') fail('symbol_key_denied');
    if (!CLOSED_TEST_INJECTION_KEY.test(key)) continue;
    const value = ownString(envSource, key);
    if (value !== undefined && value.length > 0) output[key] = value;
  }
  closedProviderTestInjection = output;
}

export function applyClosedProviderTestInjection(env) {
  if (!closedProviderTestInjection) return env;
  const output = env ?? Object.create(null);
  for (const [key, value] of Object.entries(closedProviderTestInjection)) output[key] = value;
  return output;
}

export async function recoverCredentialHandoffByIdentity(identity) {
  try {
    return await cleanupCredentialHandoff(handoffPathFromProcessIdentity(identity));
  } catch (error) {
    if (error instanceof CredentialBoundaryError && error.code === 'invalid_handoff') {
      return { cleaned: false, missing: true };
    }
    throw error;
  }
}

export async function recoverStaleCredentialHandoffs({ directory } = {}) {
  const root = directory ?? runtimeHandoffRoot();
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    return { recovered: 0 };
  }
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { recovered: 0 };
  }
  let recovered = 0;
  for (const entry of entries) {
    if (!HANDOFF_IDENTITY_DIR.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      await cleanupCredentialHandoff(path.join(candidate, 'env.json'));
      recovered += 1;
    } catch {
      // Best-effort stale recovery must stay content-free and non-throwing.
    }
  }
  return { recovered };
}

export async function createCredentialHandoff(secrets, { directory, identity } = {}) {
  const payloadEnv = Object.create(null);
  const source = requirePlainSource(secrets);
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') fail('symbol_key_denied');
    if (!isCredentialEnvKey(key)) continue;
    const value = ownString(source, key);
    if (value !== undefined) payloadEnv[key] = value;
  }
  const json = `${JSON.stringify({ schema: CREDENTIAL_BOUNDARY_SCHEMA_ID, version: CREDENTIAL_BOUNDARY_VERSION, env: payloadEnv })}\n`;
  if (BYTE_LENGTH(json) > MAX_HANDOFF_BYTES) fail('credential_too_large');
  const root = await prepareHandoffDirectory({ directory, identity });
  await chmod(root, 0o700).catch(() => {});
  const filePath = path.join(root, 'env.json');
  const handle = await open(requireAbsolutePath(filePath), OPEN_WRITE_FLAGS, 0o600);
  try {
    await handle.writeFile(json, 'utf8');
    await handle.datasync?.().catch(() => {});
    const metadata = await handle.stat({ bigint: true });
    validateCredentialStat(metadata, MAX_HANDOFF_BYTES);
  } finally {
    await handle.close().catch(() => {});
  }
  return { path: filePath, directory: root };
}

export async function cleanupCredentialHandoff(target) {
  const filePath = typeof target === 'string' ? target : target?.path;
  if (!filePath) return { cleaned: true, missing: true };
  try {
    requireAbsolutePath(filePath);
  } catch {
    return { cleaned: false, missing: true };
  }
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail('invalid_handoff');
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof CredentialBoundaryError) throw error;
      fail('invalid_handoff', { cause: error });
    }
  }
  const dir = path.dirname(filePath);
  try {
    await rmdir(dir);
  } catch {
    // Directory may still contain unrelated files; leave it.
  }
  return { cleaned: true, missing: false };
}

export async function consumeCredentialHandoff(filePath) {
  const resolved = requireAbsolutePath(filePath);
  let payload;
  try {
    const text = await loadCredentialFile(resolved, { maxBytes: MAX_HANDOFF_BYTES });
    payload = JSON.parse(text);
  } catch (error) {
    await cleanupCredentialHandoff(resolved).catch(() => {});
    if (error instanceof CredentialBoundaryError) throw error;
    fail('invalid_handoff', { cause: error });
  }
  await cleanupCredentialHandoff(resolved).catch(() => {});
  if (!payload || payload.schema !== CREDENTIAL_BOUNDARY_SCHEMA_ID || payload.version !== CREDENTIAL_BOUNDARY_VERSION
    || !payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) {
    fail('invalid_handoff');
  }
  requirePlainSource(payload.env, 'handoff.env');
  const env = Object.create(null);
  for (const key of CREDENTIAL_ENV_KEYS) {
    const value = ownString(payload.env, key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function assertCredentialFreeRemote(value) {
  if (value == null) return value;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('push_url_denied');
  if (USERINFO_URL.test(value) || TOKEN_QUERY.test(value) || /:\/\//u.test(value) && /@/u.test(value)) {
    fail('push_url_denied');
  }
  if (/\bpushurl\b/iu.test(value) || /\binsteadof\b/iu.test(value)) fail('push_url_denied');
  return value;
}

export function denyWorkerRemoteMutation(operation) {
  if (typeof operation !== 'string' || operation.length === 0) fail('remote_mutation_denied');
  if (capturedIncludes(DENIED_OPERATIONS, operation)) fail('remote_mutation_denied');
  if (/^(?:push|force_push|merge|rebase|create_pr|merge_pr|tag_create|tag_delete|release_create|remote_mutate|credential_helper|fetch|pull|delete_ref|protected_ref_update)$/u.test(operation)) {
    fail('remote_mutation_denied');
  }
  return operation;
}

export function assertNoWorkerPushUrl(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return assertCredentialFreeRemote(value);
  requirePlainSource(value, 'remote');
  for (const key of ['pushurl', 'pushUrl', 'push_url', 'url', 'insteadOf', 'insteadof']) {
    if (OBJECT_HAS_OWN(value, key)) {
      denyWorkerRemoteMutation('remote_mutate');
    }
  }
  return value;
}

export function spawnProviderChild(command, args, { cwd, env, stdio = 'pipe', detached = false, spawn = nodeSpawn } = {}) {
  const projected = env ?? {};
  requirePlainSource(projected);
  for (const key of Reflect.ownKeys(projected)) {
    if (typeof key !== 'string') fail('symbol_key_denied');
    if (isForbiddenProviderEnvKey(key) && !capturedHasOwn(GIT_HARDENING_ENV, key) && !isCredentialEnvKey(key)) {
      fail('invalid_env');
    }
  }
  return spawn(command, args, { cwd, env: projected, stdio, detached, shell: false });
}

export function inspectEnvForSecrets(env, secrets = []) {
  const serialized = JSON.stringify(env ?? {});
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && serialized.includes(secret)) return true;
  }
  return false;
}

export function inspectArgvForSecrets(argv, secrets = []) {
  const serialized = JSON.stringify(argv ?? []);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && serialized.includes(secret)) return true;
  }
  return false;
}
