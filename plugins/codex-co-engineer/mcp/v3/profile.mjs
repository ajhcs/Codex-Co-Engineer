import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { types } from 'node:util';

import { MAX_EXPECTED_DURATION_MS, MIN_DURATION_MS } from './contract.mjs';

// ProfileV1 (ADR 0001: deterministic_explicit_or_profile_resolution,
// profiles_data_only). Profiles are owner-authored, data-only selection
// records. They never carry executables, argv, credentials, environment
// values, moving refs, direct-mode configuration, or merge/push/PR
// authority; VerificationPolicyV1 remains the only executable command
// catalog. This module loads and validates profile data only. Assignment
// resolution, defaults, and selection questions belong to the resolver.
//
// Every exported direct-JS surface consumes static data only: live Proxy
// views are rejected before a single handler trap fires, revoked Proxy views
// are rejected before Array.isArray or any other target-inspecting builtin
// can raise a native TypeError. Nested profile data is read through one
// descriptor snapshot per container; the two optional environment trust-path
// values are each read once from their own descriptor. No accepted view can
// hide keys, forge active descriptors, or answer two observations differently.

export const PROFILE_SCHEMA = 'codex-co-engineer.profile.v1';
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const PROJECT_PROFILE_DIRNAME = '.codex';
export const PROJECT_PROFILE_FILENAME = 'co-engineer-profiles.json';
export const OWNER_PROFILE_DIRNAME = 'codex-co-engineer';
export const OWNER_PROFILE_FILENAME = 'profiles.json';

export const MAX_PROFILE_CATALOG_BYTES = 64 * 1024;
export const MAX_PROFILES_PER_CATALOG = 64;
export const MAX_PROFILE_STRUCTURE_NODES = 512;
export const MAX_PROFILE_STRUCTURE_DEPTH = 16;
export const MAX_PROFILE_OBJECT_KEYS = 64;

// Local ProfileV1 mirror of the bounded run vocabulary: the same four exact
// provider routes, the same assignment roles (including read-only verify), and
// the same bounded model identifier grammar. The mirror is deliberately local:
// this module stays import-free of the P02 run-manifest runtime, and the
// shared test fixtures fail the suite if either side ever drifts. A profile
// only names a data selection: it makes no model-membership, availability,
// qualification, resolution, or attestation claim. Preflight attests the
// effective provider/model later.
export const PROFILE_PROVIDERS = Object.freeze(['dsh', 'grok', 'cursor-local', 'cursor-cloud']);
export const PROFILE_ROLES = Object.freeze(['review', 'implement', 'verify']);

// Bounded requested-bytes model grammar mirrored from the assignment contract:
// first character alphanumeric, then alphanumerics plus `._/:-`, at most 128
// encoded UTF-8 bytes. Syntax and size only - no advertised-model membership
// is enforced here or anywhere else in ProfileV1.
export const PROFILE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;
export const PROFILE_MODEL_ID_MAX_BYTES = 128;

/**
 * Deprecated informational compatibility data: the DSH model identifiers that
 * 3.2.1 setup advertises. Retained only so older catalogs and diagnostics keep
 * reading one stable constant. ProfileV1 validation never consults this list,
 * so it cannot authorize or reject any requested model; membership,
 * availability, qualification, resolution, and attestation stay preflight or
 * resolver concerns.
 * @deprecated Informational compatibility data only; not an authorization list.
 */
export const PROFILE_DSH_MODELS = Object.freeze(['muse-spark-1.2-contributor', 'stealth/ox-alpha']);
export const MIN_PROFILE_EXPECTED_DURATION_MS = MIN_DURATION_MS;
export const MAX_PROFILE_EXPECTED_DURATION_MS = MAX_EXPECTED_DURATION_MS;

const SCOPES = Object.freeze(['project', 'owner']);
// One catalog may hold up to MAX_PROFILES_PER_CATALOG entries per scope, so
// the merged load result is bounded at one catalog worth per scope.
const MAX_LOADED_PROFILES = MAX_PROFILES_PER_CATALOG * SCOPES.length;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

// util.types.isProxy consults only the internal Proxy slot: it dispatches no
// handler trap and never touches the (possibly revoked) target, so this guard
// rejects live and revoked Proxy views before Array.isArray, prototype
// inspection, own-key enumeration, descriptor reads, or property access can
// observe or invoke handler behavior.
const PROXY_REJECTION_CODE = 'profile_proxy_rejected';

function assertStaticData(value, label) {
  const kind = typeof value;
  if ((kind === 'object' || kind === 'function') && value !== null && types.isProxy(value)) {
    fail(PROXY_REJECTION_CODE,
      `${label} must be static profile data; live or revoked Proxy views are rejected.`);
  }
  return value;
}

// Descriptor-first single snapshot: walkers derive keys, bounds, and child
// values from one getOwnPropertyDescriptors observation per container and
// never re-read properties through the object, so no stateful view can change
// between validation steps or differ between what was validated and what is
// encoded, hashed, or returned.
function snapshotOwnDescriptors(value, code, label) {
  assertStaticData(value, label);
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code, `${label} properties could not be inspected safely.`);
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  assertStaticData(value, 'Profile data');
  if (Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function dataObjectDescriptors(value, code, label) {
  assertStaticData(value, label);
  if (!isPlainObject(value)) fail(code, `${label} must be a plain data object.`);
  const descriptors = snapshotOwnDescriptors(value, code, label);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) {
    fail(code, `${label} must not define symbol properties.`);
  }
  if (keys.length > MAX_PROFILE_OBJECT_KEYS) {
    fail('profile_structure_too_complex', `${label} exceeds the bounded property count.`);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${label} must contain enumerable data properties only.`);
    }
  }
  return descriptors;
}

function dataArrayValues(value, code, label, maxItems = MAX_PROFILE_OBJECT_KEYS) {
  assertStaticData(value, label);
  if (!Array.isArray(value)) fail(code, `${label} must be an array.`);
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(code, `${label} could not be inspected safely.`);
  }
  if (prototype !== Array.prototype && prototype !== null) {
    fail(code, `${label} must be a standard data array.`);
  }
  const descriptors = snapshotOwnDescriptors(value, code, label);
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 0 || length > maxItems) {
    fail('profile_structure_too_complex', `${label} exceeds the bounded item count.`);
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !expected.has(key)) || keys.length !== expected.size) {
    fail(code, `${label} must be dense and must not define extra properties.`);
  }
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${label} must contain enumerable data items only.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function requireNormalizedAbsolute(value, code, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || value.includes('\0') || path.resolve(value) !== value) {
    fail(code, `${label} must be an absolute, normalized path.`);
  }
  return value;
}

// Environment values are read from one own descriptor per consumed key, never
// by property access or a whole-object descriptor expansion. This keeps the
// work constant even when the ambient environment contains many unrelated
// variables, while accessors and inherited trust-path values still fail
// closed. Node's process.env has a host-provided exotic prototype and is the
// sole non-plain object accepted here.
function readEnvironment(env, label) {
  assertStaticData(env, `The ${label} environment`);
  let prototype;
  try {
    prototype = Object.getPrototypeOf(env);
  } catch {
    fail('invalid_profile_environment', `The ${label} environment could not be inspected safely.`);
  }
  if (env !== process.env && prototype !== Object.prototype && prototype !== null) {
    fail('invalid_profile_environment',
      `The ${label} environment must be a plain data object.`);
  }
  const read = (key) => {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(env, key);
    } catch {
      fail('invalid_profile_environment',
        `The ${label} environment could not be inspected safely.`);
    }
    if (descriptor === undefined) return undefined;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid_profile_environment',
        `The ${label} environment must expose ${key} as a static data value.`);
    }
    return descriptor.value;
  };
  return { xdgConfigHome: read('XDG_CONFIG_HOME'), home: read('HOME') };
}

function defaultOwnerConfigDir(environment) {
  if (typeof environment.xdgConfigHome === 'string' && environment.xdgConfigHome.length > 0
    && path.isAbsolute(environment.xdgConfigHome)
    && path.resolve(environment.xdgConfigHome) === environment.xdgConfigHome) {
    return environment.xdgConfigHome;
  }
  const home = typeof environment.home === 'string' && environment.home.length > 0
    && path.isAbsolute(environment.home) && path.resolve(environment.home) === environment.home
    ? environment.home
    : homedir();
  requireNormalizedAbsolute(home, 'invalid_profile_owner_config_dir', 'owner home directory');
  return path.join(home, '.config');
}

// Explicit roots: exactly one catalog path per scope, so lookup never depends
// on filesystem enumeration order. Arguments are captured as one static
// descriptor snapshot before any value is used; Proxy views and accessor
// bearing argument objects are rejected instead of dereferenced.
export function profileRoots(options = {}) {
  assertStaticData(options, 'The profile root arguments');
  const arguments_ = dataObjectDescriptors(options, 'invalid_profile_options',
    'The profile root arguments');
  const argument = (key) => (Object.hasOwn(arguments_, key) ? arguments_[key].value : undefined);
  const envArgument = argument('env');
  const repositoryPath = argument('repositoryPath');
  const ownerConfigDir = argument('ownerConfigDir');
  const repo = requireNormalizedAbsolute(repositoryPath, 'invalid_profile_repository_path', 'repositoryPath');
  const ownerDir = ownerConfigDir === undefined
    ? defaultOwnerConfigDir(readEnvironment(
      envArgument === undefined ? process.env : envArgument,
      'profile root',
    ))
    : requireNormalizedAbsolute(ownerConfigDir, 'invalid_profile_owner_config_dir', 'ownerConfigDir');
  return Object.freeze({
    project: Object.freeze({
      scope: 'project',
      dir: path.join(repo, PROJECT_PROFILE_DIRNAME),
      file: path.join(repo, PROJECT_PROFILE_DIRNAME, PROJECT_PROFILE_FILENAME),
    }),
    owner: Object.freeze({
      scope: 'owner',
      dir: path.join(ownerDir, OWNER_PROFILE_DIRNAME),
      file: path.join(ownerDir, OWNER_PROFILE_DIRNAME, OWNER_PROFILE_FILENAME),
    }),
  });
}

export function isValidProfileName(value) {
  return typeof value === 'string' && PROFILE_NAME_PATTERN.test(value);
}

// Rejects duplicate object keys anywhere in the document. JSON.parse alone
// silently keeps the last duplicate, which could quietly change selection
// data such as the provider named by a profile.
export function assertNoDuplicateCatalogKeys(text) {
  if (typeof text !== 'string') {
    fail('invalid_profile_catalog_json', 'Profile catalog JSON must be text.');
  }
  const scopes = [{ object: false, keys: new Set() }];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        const scope = scopes[scopes.length - 1];
        if (scope.object) {
          let cursor = index + 1;
          while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
          if (text[cursor] === ':') {
            let key;
            try {
              key = JSON.parse(text.slice(stringStart - 1, index + 1));
            } catch {
              fail('invalid_profile_catalog_json', 'Profile catalog contains an invalid key string.');
            }
            if (scope.keys.has(key)) {
              fail('duplicate_profile_key', 'Profile catalog defines the same object key more than once.');
            }
            scope.keys.add(key);
          }
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      stringStart = index + 1;
      continue;
    }
    if (char === '{') scopes.push({ object: true, keys: new Set() });
    else if (char === '[') scopes.push({ object: false, keys: new Set() });
    else if (char === '}' || char === ']') {
      scopes.pop();
      if (scopes.length === 0) fail('invalid_profile_catalog_json', 'Profile catalog JSON is unbalanced.');
    }
  }
  if (inString || scopes.length !== 1) {
    fail('invalid_profile_catalog_json', 'Profile catalog JSON is incomplete.');
  }
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function requireOwnerControl(entry, label, kind) {
  if (label !== 'owner') return;
  const effectiveUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : undefined;
  if ((effectiveUid !== undefined && entry.uid !== effectiveUid) || (entry.mode & 0o022n) !== 0n) {
    fail('profile_catalog_not_owner_controlled',
      `The owner profile ${kind} must be owned by the current user and not writable by group or other users.`);
  }
}

async function assertDirectoryUnchanged(dir, before, label) {
  let after;
  try {
    after = await lstat(dir, { bigint: true });
  } catch (error) {
    fail('profile_catalog_changed_during_read', `The ${label} profile directory changed while its catalog was read.`);
  }
  if (!sameEntry(before, after)) {
    fail('profile_catalog_changed_during_read', `The ${label} profile directory changed while its catalog was read.`);
  }
}

async function readCatalogText(file, label) {
  let handle;
  try {
    // A read-only open of a FIFO waits for a writer before fstat can reject
    // it. O_NONBLOCK makes the handle inspection authoritative without ever
    // waiting on attacker-controlled special-file behavior; it is inert for
    // regular files.
    handle = await open(file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    if (error && (error.code === 'ENOTDIR' || error.code === 'ELOOP')) {
      fail('profile_catalog_not_regular', `The ${label} profile catalog path is not a regular file location.`);
    }
    fail('profile_catalog_unreadable', `The ${label} profile catalog could not be opened safely.`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail('profile_catalog_not_regular', `The ${label} profile catalog must be a regular non-symlink file.`);
    }
    requireOwnerControl(before, label, 'catalog');
    if (before.size > BigInt(MAX_PROFILE_CATALOG_BYTES)) {
      fail('profile_catalog_too_large', `The ${label} profile catalog exceeds ${MAX_PROFILE_CATALOG_BYTES} bytes.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameEntry(before, after)) {
      fail('profile_catalog_changed_during_read', `The ${label} profile catalog changed while it was read.`);
    }
    if (bytes.byteLength > MAX_PROFILE_CATALOG_BYTES) {
      fail('profile_catalog_too_large', `The ${label} profile catalog exceeds ${MAX_PROFILE_CATALOG_BYTES} bytes.`);
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      fail('invalid_profile_catalog_json', `The ${label} profile catalog must not begin with a UTF-8 BOM.`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('invalid_profile_catalog_encoding', `The ${label} profile catalog must be valid UTF-8.`);
    }
  } catch (error) {
    if (error?.code?.startsWith?.('profile_') || error?.code?.startsWith?.('invalid_profile_')) throw error;
    fail('profile_catalog_unreadable', `The ${label} profile catalog could not be read safely.`);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function requireRealDirectoryOrMissing(dir, label) {
  const entry = await lstat(dir, { bigint: true }).catch((error) => {
    if (error && error.code === 'ENOENT') return undefined;
    fail('profile_catalog_unreadable', `The ${label} profile directory could not be inspected.`);
  });
  if (entry !== undefined && (entry.isSymbolicLink() || !entry.isDirectory())) {
    fail('profile_catalog_not_regular', `The ${label} profile directory must be a real non-symlink directory.`);
  }
  if (entry !== undefined) requireOwnerControl(entry, label, 'directory');
  return entry;
}

function parseCatalog(text, label) {
  assertNoDuplicateCatalogKeys(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid_profile_catalog_json', `The ${label} profile catalog is not valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    fail('invalid_profile_catalog_shape', `The ${label} profile catalog must be a JSON object keyed by profile name.`);
  }
  const names = Object.keys(parsed);
  if (names.length > MAX_PROFILES_PER_CATALOG) {
    fail('profile_catalog_too_many_entries', `The ${label} profile catalog exceeds ${MAX_PROFILES_PER_CATALOG} profiles.`);
  }
  return parsed;
}

export const ALLOWED_PROFILE_FIELDS = Object.freeze([
  'schema', 'provider', 'model', 'role', 'expected_duration_ms', 'policy',
]);
export const ALLOWED_PROFILE_POLICY_FIELDS = Object.freeze(['pre_dispatch_provider_preference']);
export const MAX_PROVIDER_PREFERENCE_ENTRIES = PROFILE_PROVIDERS.length;

// Keys are normalized (case and -/_ folded) before classification so trivial
// mutations cannot smuggle a forbidden field past an exact-match list.
const normalizeKey = (key) => String(key).toLowerCase().replace(/[-_ ]+/gu, '');

const FORBIDDEN_KEY_CLASSES = Object.freeze([
  ['profile_credential_key_rejected', Object.freeze([
    'credential', 'credentials', 'apikey', 'apisecret', 'token', 'tokens',
    'secret', 'secrets', 'password', 'passwd', 'auth', 'authorization',
    'bearer', 'cookie', 'sessiontoken', 'sessionkey', 'accesstoken',
    'refreshtoken', 'privatekey', 'signingkey',
  ])],
  ['profile_environment_key_rejected', Object.freeze([
    'env', 'environment', 'envvar', 'envvars', 'environmentvariable',
    'environmentvariables', 'envfile', 'dotenv', 'variables',
  ])],
  ['profile_executable_key_rejected', Object.freeze([
    'executable', 'exec', 'bin', 'binary', 'command', 'commands', 'cmd',
    'argv', 'args', 'argument', 'arguments', 'shell', 'shellcommand',
    'script', 'entrypoint', 'interpreter', 'run', 'runner',
    'runnercommand', 'commandid',
    'commandcatalog', 'commandcatalogs', 'verification',
    'verificationpolicy', 'verificationpolicyv1', 'verificationcommand',
    'verificationcommands', 'argvtemplate', 'template', 'templates',
    'workingdirectory', 'cwd', 'network', 'environmentallowlist',
    'timeout', 'timeoutms', 'cpulimit', 'memorylimit', 'pidslimit',
  ])],
  ['profile_authority_key_rejected', Object.freeze([
    'merge', 'allowmerge', 'mergeauthority', 'mergemode', 'push',
    'allowpush', 'pushurl', 'createpr', 'autocreatepr',
    'createpullrequest', 'prmode', 'protectedrefs', 'protectedref',
    'protect', 'protectedbranch', 'protectedbranches', 'forcepush',
    'deletebranch', 'defaultbranch',
  ])],
  ['profile_direct_mode_key_rejected', Object.freeze([
    'workspacemode', 'workspace', 'workspaces', 'worktree', 'direct',
    'directmode', 'directworkspace',
  ])],
  ['profile_moving_ref_key_rejected', Object.freeze([
    'ref', 'refs', 'branch', 'startingref', 'baseref', 'head', 'tag',
    'tags', 'remote', 'remotes', 'origin', 'latest', 'pin', 'pinnedref',
  ])],
  ['profile_embedded_content_key_rejected', Object.freeze([
    'prompt', 'prompts', 'prompttemplate', 'systemprompt', 'messages',
    'message', 'system', 'instructions', 'instruction', 'result',
    'results', 'output', 'outputs', 'response', 'responses', 'content',
    'body', 'text', 'notes', 'description', 'comments', 'context',
    'memory', 'history', 'transcript',
  ])],
]);

// Credential vocabulary matches by substring so mutations such as
// client_secret or api_key_v2 cannot slip past exact-match lists.
const CREDENTIAL_CODE = 'profile_credential_key_rejected';
const CREDENTIAL_TOKENS = FORBIDDEN_KEY_CLASSES[0][1];

function classifyKey(key) {
  const normalized = normalizeKey(key);
  if (CREDENTIAL_TOKENS.some((token) => normalized.includes(token))) return CREDENTIAL_CODE;
  for (const [code, members] of FORBIDDEN_KEY_CLASSES) {
    if (members.includes(normalized)) return code;
  }
  return undefined;
}

function rejectKey(name, key, code, fallbackCode) {
  if (code !== undefined) {
    fail(code, `Profile "${name}" must not define that forbidden field; profiles are data-only.`);
  }
  fail(fallbackCode, `Profile "${name}" defines an unknown field.`);
}

// Value scans are defense in depth: even a future allowlisted string field
// must never carry secret material, environment interpolation, shell syntax,
// or moving-ref names.
const SECRET_VALUE_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/u, null],
  [/\bxox[baprs]-[A-Za-z0-9-]+/u, null],
  [/\bgh[pou]_[A-Za-z0-9]{16,}/u, null],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/u, null],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu, null],
  [/^[a-f0-9]{40,}$/iu, null],
  [/^[A-Za-z0-9+/]{43,}={0,2}$/u, null],
];
const ENV_VALUE_PATTERNS = [
  /\$\{[^}]*\}/u,
  /\$[A-Za-z_][A-Za-z0-9_]*/u,
  /\$\([^)]*\)/u,
  /%[A-Za-z_][A-Za-z0-9_]*%/u,
  /`[^`]*`/u,
];
const SHELL_VALUE_PATTERNS = [
  /[;&|<>`]/u,
  /(^|[^A-Za-z0-9])(?:sh|bash|zsh|fish|pwsh|powershell|cmd)(?![A-Za-z0-9])/iu,
  /^#!/u,
  /(?:^|[^A-Za-z0-9])(?:sudo|eval|exec)\s/u,
];
const MOVING_REF_VALUE_PATTERNS = [
  /^refs\//u, /^(?:origin|upstream)\//u, /^HEAD(?:@|$)/u, /@\{/u,
  /^(?:main|master|develop|trunk|latest)$/iu,
];

function scanValue(name, key, value) {
  for (const [pattern] of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      fail('profile_secret_value_rejected', `Profile "${name}" field ${key} looks like secret material.`);
    }
  }
  if (ENV_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail('profile_environment_value_rejected', `Profile "${name}" field ${key} must not contain environment interpolation.`);
  }
  if (SHELL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail('profile_shell_value_rejected', `Profile "${name}" field ${key} must not contain shell syntax.`);
  }
  if (MOVING_REF_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail('profile_moving_ref_value_rejected', `Profile "${name}" field ${key} names a moving ref.`);
  }
}

function deepScanStrings(name, container, prefix) {
  const stack = [{ value: container, depth: 0, field: prefix }];
  const seen = new Set();
  let nodes = 0;
  let stringBytes = 0;
  while (stack.length > 0) {
    const { value, depth, field } = stack.pop();
    nodes += 1;
    if (nodes > MAX_PROFILE_STRUCTURE_NODES || depth > MAX_PROFILE_STRUCTURE_DEPTH) {
      fail('profile_structure_too_complex', `Profile "${name}" exceeds the bounded data structure limits.`);
    }
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value, 'utf8');
      if (stringBytes > MAX_PROFILE_CATALOG_BYTES) {
        fail('profile_structure_too_complex', `Profile "${name}" exceeds the bounded string-data limit.`);
      }
      scanValue(name, field, value);
      continue;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      continue;
    }
    if (typeof value !== 'object') {
      fail('invalid_profile_data_value', `Profile "${name}" contains a non-data value.`);
    }
    assertStaticData(value, `Profile "${name}" data`);
    if (seen.has(value)) {
      fail('invalid_profile_data_graph', `Profile "${name}" contains a cycle or shared object identity.`);
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const values = dataArrayValues(value, 'invalid_profile_data_value', 'Profile data array');
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push({ value: values[index], depth: depth + 1, field: `${field}[${index}]` });
      }
    } else {
      const descriptors = dataObjectDescriptors(value, 'invalid_profile_data_value', 'Profile data object');
      const keys = Object.keys(descriptors);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        stack.push({ value: descriptors[key].value, depth: depth + 1, field: `${field}.${key}` });
      }
    }
  }
}

function requireProvider(name, provider) {
  if (!PROFILE_PROVIDERS.includes(provider)) {
    fail('unsupported_profile_provider', `Profile "${name}" provider must be one of ${PROFILE_PROVIDERS.join(', ')}.`);
  }
  return provider;
}

function requireModel(name, model, provider) {
  // A model name is meaningful only beside an explicit known provider.
  if (!PROFILE_PROVIDERS.includes(provider)) {
    fail('invalid_profile_model_for_provider',
      `Profile "${name}" may name a model only beside one of ${PROFILE_PROVIDERS.join(', ')}.`);
  }
  // One grammar for every exact provider: syntax and requested-byte size only.
  // No static allowlist is consulted, so a pattern-valid model is accepted on
  // every route even when no advertisement lists it yet.
  if (typeof model !== 'string' || model.includes('..')
    || !PROFILE_MODEL_ID_PATTERN.test(model)
    || Buffer.byteLength(model, 'utf8') > PROFILE_MODEL_ID_MAX_BYTES) {
    fail('invalid_profile_model',
      `Profile "${name}" model must match the bounded model grammar ${PROFILE_MODEL_ID_PATTERN.source}`
      + ` (at most ${PROFILE_MODEL_ID_MAX_BYTES} UTF-8 bytes).`);
  }
  return model;
}

function requireRole(name, role) {
  if (!PROFILE_ROLES.includes(role)) {
    fail('unsupported_profile_role', `Profile "${name}" role must be one of ${PROFILE_ROLES.join(', ')}.`);
  }
  return role;
}

function requireExpectedDuration(name, duration) {
  if (!Number.isInteger(duration) || duration < MIN_PROFILE_EXPECTED_DURATION_MS
    || duration > MAX_PROFILE_EXPECTED_DURATION_MS) {
    fail('invalid_profile_expected_duration_ms',
      `Profile "${name}" expected_duration_ms must be an integer from ${MIN_PROFILE_EXPECTED_DURATION_MS}`
      + ` to ${MAX_PROFILE_EXPECTED_DURATION_MS}.`);
  }
  return duration;
}

function requirePolicy(name, policy) {
  const descriptors = dataObjectDescriptors(policy, 'invalid_profile_policy', `Profile "${name}" policy`);
  const canonical = {};
  for (const key of Object.keys(descriptors)) {
    const classification = classifyKey(key);
    if (!ALLOWED_PROFILE_POLICY_FIELDS.includes(key) || classification !== undefined) {
      rejectKey(name, key, classification, 'unknown_profile_policy_field');
    }
    if (key === 'pre_dispatch_provider_preference') {
      canonical[key] = requireProviderPreference(name, descriptors[key].value);
    }
  }
  return canonical;
}

function requireProviderPreference(name, preference) {
  const values = dataArrayValues(preference, 'invalid_profile_provider_preference',
    `Profile "${name}" pre_dispatch_provider_preference`);
  if (values.length === 0 || values.length > MAX_PROVIDER_PREFERENCE_ENTRIES
    || !values.every((entry) => typeof entry === 'string')) {
    fail('invalid_profile_provider_preference',
      `Profile "${name}" pre_dispatch_provider_preference must be 1-${MAX_PROVIDER_PREFERENCE_ENTRIES} provider names.`);
  }
  const seen = new Set();
  for (const entry of values) {
    requireProvider(name, entry);
    if (seen.has(entry)) {
      fail('duplicate_profile_preference_provider', `Profile "${name}" repeats provider "${entry}" in its preference order.`);
    }
    seen.add(entry);
  }
  return [...values];
}

// Structural validation shared by loading and later linting. Field-level
// policy/provider/model validation is layered on top of this check.
export function validateProfileDefinition(name, raw) {
  if (!isValidProfileName(name)) {
    fail('invalid_profile_name', `Profile name must match ${PROFILE_NAME_PATTERN.source}.`);
  }
  const descriptors = dataObjectDescriptors(raw, 'invalid_profile_definition', `Profile "${name}"`);
  if (!Object.hasOwn(descriptors, 'schema') || descriptors.schema.value !== PROFILE_SCHEMA) {
    fail('invalid_profile_schema', `Profile "${name}" must declare schema "${PROFILE_SCHEMA}".`);
  }

  // Fail closed on dangerous content before any structural leniency.
  deepScanStrings(name, raw, 'profile');

  const canonical = { schema: PROFILE_SCHEMA };
  for (const key of Object.keys(descriptors)) {
    if (key === 'schema') continue;
    const classification = classifyKey(key);
    if (!ALLOWED_PROFILE_FIELDS.includes(key) || classification !== undefined) {
      rejectKey(name, key, classification, 'unknown_profile_field');
    }
  }
  const has = (field) => Object.hasOwn(descriptors, field);
  if (has('provider')) canonical.provider = requireProvider(name, descriptors.provider.value);
  // A model name is meaningful only beside its explicit provider selection.
  if (has('model')) canonical.model = requireModel(name, descriptors.model.value, canonical.provider);
  if (has('role')) canonical.role = requireRole(name, descriptors.role.value);
  if (has('expected_duration_ms')) canonical.expected_duration_ms = requireExpectedDuration(name, descriptors.expected_duration_ms.value);
  if (has('policy')) canonical.policy = requirePolicy(name, descriptors.policy.value);
  return deepFreezeData(canonical);
}

function appendCanonicalToken(state, token) {
  const tokenBytes = Buffer.byteLength(token, 'utf8');
  if (state.bytes + tokenBytes > MAX_PROFILE_CATALOG_BYTES) {
    fail('invalid_profile_canonical_data',
      `Canonical profile data exceeds ${MAX_PROFILE_CATALOG_BYTES} encoded bytes.`);
  }
  state.bytes += tokenBytes;
  return token;
}

function canonicalStringToken(value, state) {
  // JSON escaping can expand one input code point into six encoded bytes.
  // Reject an already-over-budget raw string before asking JSON.stringify to
  // allocate that expansion, then charge the exact encoded token.
  if (Buffer.byteLength(value, 'utf8') > MAX_PROFILE_CATALOG_BYTES) {
    fail('invalid_profile_canonical_data',
      `Canonical profile data exceeds ${MAX_PROFILE_CATALOG_BYTES} encoded bytes.`);
  }
  return appendCanonicalToken(state, JSON.stringify(value));
}

function canonicalProfileJsonInner(value, seen, depth, state) {
  if (depth > MAX_PROFILE_STRUCTURE_DEPTH) {
    fail('invalid_profile_canonical_data', 'Canonical profile data exceeds the bounded nesting depth.');
  }
  state.nodes += 1;
  if (state.nodes > MAX_PROFILE_STRUCTURE_NODES) {
    fail('invalid_profile_canonical_data',
      `Canonical profile data exceeds ${MAX_PROFILE_STRUCTURE_NODES} structure nodes.`);
  }
  if (typeof value === 'string') return canonicalStringToken(value, state);
  if (typeof value === 'boolean' || value === null) {
    return appendCanonicalToken(state, JSON.stringify(value));
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return appendCanonicalToken(state, JSON.stringify(value));
  }
  if (typeof value !== 'object') {
    fail('invalid_profile_canonical_data', 'Canonical profile data contains an unsupported value.');
  }
  assertStaticData(value, 'Canonical profile data');
  if (seen.has(value)) fail('invalid_profile_canonical_data', 'Canonical profile data contains a cycle or alias.');
  seen.add(value);
  if (Array.isArray(value)) {
    const values = dataArrayValues(value, 'invalid_profile_canonical_data', 'Canonical profile array');
    const output = [appendCanonicalToken(state, '[')];
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) output.push(appendCanonicalToken(state, ','));
      output.push(canonicalProfileJsonInner(values[index], seen, depth + 1, state));
    }
    output.push(appendCanonicalToken(state, ']'));
    return output.join('');
  }
  const descriptors = dataObjectDescriptors(value, 'invalid_profile_canonical_data', 'Canonical profile object');
  const keys = Object.keys(descriptors).sort();
  const output = [appendCanonicalToken(state, '{')];
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) output.push(appendCanonicalToken(state, ','));
    const key = keys[index];
    output.push(canonicalStringToken(key, state));
    output.push(appendCanonicalToken(state, ':'));
    output.push(canonicalProfileJsonInner(descriptors[key].value, seen, depth + 1, state));
  }
  output.push(appendCanonicalToken(state, '}'));
  return output.join('');
}

export function canonicalProfileJson(value) {
  assertStaticData(value, 'Canonical profile data');
  return canonicalProfileJsonInner(value, new Set(), 0, { nodes: 0, bytes: 0 });
}

// Stable provenance digest over validated canonical data. Scope and source
// path are recorded beside the digest so the same content synced across
// scopes keeps one content identity while remaining traceable to origin.
export function profileProvenanceDigest(payload = {}) {
  assertStaticData(payload, 'The provenance arguments');
  const arguments_ = dataObjectDescriptors(payload, 'invalid_profile_provenance_payload',
    'The provenance arguments');
  const name = Object.hasOwn(arguments_, 'name') ? arguments_.name.value : undefined;
  const definition = Object.hasOwn(arguments_, 'definition') ? arguments_.definition.value : undefined;
  if (!isValidProfileName(name)) fail('invalid_profile_name', 'Profile name is invalid.');
  if (!isPlainObject(definition)) fail('invalid_profile_definition', 'Profile definition must be validated data.');
  // Closed-input gate: only definitions that pass full ProfileV1 validation
  // can be digested, and the hash is computed over validator-owned frozen
  // canonical output - never over the caller's view, so hidden keys,
  // accessors, or late-changing views cannot launder arbitrary content into
  // a provenance identity or destabilize it between calls.
  const validated = validateProfileDefinition(name, definition);
  const canonicalPayload = canonicalProfileJson({ definition: validated, name, schema: PROFILE_SCHEMA });
  return `sha256:${createHash('sha256').update(canonicalPayload).digest('hex')}`;
}

function deepFreezeData(value) {
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    assertStaticData(current, 'Validated profile data');
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...dataArrayValues(current, 'invalid_profile_definition', 'Validated profile array'));
    } else {
      const descriptors = dataObjectDescriptors(current, 'invalid_profile_definition', 'Validated profile object');
      stack.push(...Object.values(descriptors).map((descriptor) => descriptor.value));
    }
    Object.freeze(current);
  }
  return value;
}

function buildRecord(name, raw, scope, source) {
  const definition = deepFreezeData(validateProfileDefinition(name, raw));
  return Object.freeze({
    name,
    scope,
    source,
    definition,
    digest: profileProvenanceDigest({ name, definition }),
  });
}

// Deterministic load: project first, then owner. A name defined in both
// scopes resolves to the project record; the owner record is reported as
// deterministically shadowed instead of silently dropped. This is file
// precedence only; assignment/run resolution stays in the resolver.
export async function loadProfiles(options = {}) {
  const roots = profileRoots(options);
  const catalogs = new Map();
  const loadedScopes = new Set();
  for (const scope of SCOPES) {
    const root = roots[scope];
    const directory = await requireRealDirectoryOrMissing(root.dir, scope);
    const text = directory === undefined ? undefined : await readCatalogText(root.file, scope);
    if (directory !== undefined) await assertDirectoryUnchanged(root.dir, directory, scope);
    if (text !== undefined) loadedScopes.add(scope);
    catalogs.set(scope, text === undefined ? {} : parseCatalog(text, scope));
  }

  const primary = new Map();
  const shadowed = [];
  for (const scope of SCOPES) {
    const root = roots[scope];
    const catalog = catalogs.get(scope);
    for (const name of Object.keys(catalog).sort()) {
      const record = buildRecord(name, catalog[name], scope, root.file);
      if (primary.has(name)) {
        shadowed.push(Object.freeze({
          ...record,
          reason: 'project_scope_precedence',
          primary_digest: primary.get(name).digest,
        }));
      } else {
        primary.set(name, record);
      }
    }
  }

  const profiles = [...primary.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze({
    roots,
    profiles: Object.freeze(profiles),
    shadowed: Object.freeze(shadowed),
    sources: Object.freeze(SCOPES.map((scope) => Object.freeze({
      scope,
      file: roots[scope].file,
      loaded: loadedScopes.has(scope),
    }))),
  });
}

// Exact-name lookup only. There are no fuzzy matches, defaults, or fallbacks
// here; unresolved choices are surfaced by the resolver, not guessed. The
// load result is consumed as one static descriptor snapshot: records are
// matched against snapshotted data names, so no live or revoked Proxy view
// can intercept the lookup, and malformed or over-large results fail with
// typed codes instead of native errors.
export function findProfile(loaded, name) {
  assertStaticData(loaded, 'The loadProfiles() result');
  if (loaded === undefined || loaded === null || !isPlainObject(loaded)) {
    fail('invalid_profile_load_result', 'loadProfiles() result is required.');
  }
  const descriptors = dataObjectDescriptors(loaded, 'invalid_profile_load_result',
    'The loadProfiles() result');
  if (!Object.hasOwn(descriptors, 'profiles')) {
    fail('invalid_profile_load_result', 'loadProfiles() result is missing its profile list.');
  }
  const list = dataArrayValues(descriptors.profiles.value, 'invalid_profile_load_result',
    'The loadProfiles() profile list', MAX_LOADED_PROFILES);
  if (!isValidProfileName(name)) {
    fail('invalid_profile_name', `Profile name must match ${PROFILE_NAME_PATTERN.source}.`);
  }
  for (const record of list) {
    assertStaticData(record, 'The loaded profile record');
    const recordDescriptors = dataObjectDescriptors(record, 'invalid_profile_load_result',
      'The loaded profile record');
    if (!Object.hasOwn(recordDescriptors, 'name')) {
      fail('invalid_profile_load_result', 'The loaded profile record is missing its name.');
    }
    const recordName = recordDescriptors.name.value;
    if (!isValidProfileName(recordName)) {
      fail('invalid_profile_load_result', 'The loaded profile record name is invalid.');
    }
    if (recordName === name) {
      const expectedFields = ['name', 'scope', 'source', 'definition', 'digest'];
      const recordFields = Object.keys(recordDescriptors);
      if (recordFields.length !== expectedFields.length
        || expectedFields.some((field) => !Object.hasOwn(recordDescriptors, field))) {
        fail('invalid_profile_load_result',
          'The matching loaded profile record must contain exactly the loadProfiles() record fields.');
      }
      const scope = recordDescriptors.scope.value;
      if (!SCOPES.includes(scope)) {
        fail('invalid_profile_load_result', 'The matching loaded profile record scope is invalid.');
      }
      const source = requireNormalizedAbsolute(recordDescriptors.source.value,
        'invalid_profile_load_result', 'loaded profile source');
      const definition = validateProfileDefinition(recordName, recordDescriptors.definition.value);
      const digest = profileProvenanceDigest({ name: recordName, definition });
      if (recordDescriptors.digest.value !== digest) {
        fail('invalid_profile_load_result',
          'The matching loaded profile record digest does not bind its validated definition.');
      }
      // Never return caller-owned record or definition identity. The
      // validator-created definition and this closed frozen record are safe
      // for downstream consumers even if the supplied load view is mutated
      // immediately after lookup.
      return Object.freeze({ name: recordName, scope, source, definition, digest });
    }
  }
  return undefined;
}
