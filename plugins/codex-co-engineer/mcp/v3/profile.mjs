import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { types } from 'node:util';

import { MAX_EXPECTED_DURATION_MS, MIN_DURATION_MS } from './contract.mjs';

// Capture every mutable intrinsic used on snapshot/loading/closure paths at
// module evaluation. Later monkeypatches of Object/Array/JSON/crypto/Map/Set
// must not change freeze, identity, digest, or TOCTOU verdicts.
const objectAssign = Object.assign;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectIsFrozen = Object.isFrozen;
const objectKeys = Object.keys;
const objectValues = Object.values;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const arrayFrom = Array.from;
const arrayPrototype = Array.prototype;
const arrayEvery = arrayPrototype.every;
const arrayIncludes = arrayPrototype.includes;
const arrayIterator = arrayPrototype[Symbol.iterator];
const arrayJoin = arrayPrototype.join;
const arrayMap = arrayPrototype.map;
const arrayPop = arrayPrototype.pop;
const arrayPush = arrayPrototype.push;
const arraySome = arrayPrototype.some;
const arraySort = arrayPrototype.sort;
const numberIsFinite = Number.isFinite;
const numberIsInteger = Number.isInteger;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const bufferByteLength = Buffer.byteLength;
const bufferIsBuffer = Buffer.isBuffer;
const arrayBufferIsView = ArrayBuffer.isView;
const Uint8ArrayCtor = Uint8Array;
const MapCtor = Map;
const SetCtor = Set;
const WeakMapCtor = WeakMap;
const mapForEach = Map.prototype.forEach;
const mapGet = Map.prototype.get;
const mapHas = Map.prototype.has;
const mapSet = Map.prototype.set;
const setAdd = Set.prototype.add;
const setHas = Set.prototype.has;
const weakMapGet = WeakMap.prototype.get;
const weakMapHas = WeakMap.prototype.has;
const weakMapSet = WeakMap.prototype.set;
const reflectOwnKeys = Reflect.ownKeys;
const stringIncludes = String.prototype.includes;
const stringReplace = String.prototype.replace;
const stringSlice = String.prototype.slice;
const stringStartsWith = String.prototype.startsWith;
const stringToLowerCase = String.prototype.toLowerCase;
const isProxyValue = types.isProxy;
const cryptoCreateHash = createHash;
const cryptoHashUpdate = objectGetPrototypeOf(createHash('sha256')).update;
const cryptoHashDigest = objectGetPrototypeOf(createHash('sha256')).digest;
const TextDecoderCtor = TextDecoder;
const textDecoderDecode = TextDecoder.prototype.decode;
const catalogSnapshotBrand = new WeakMapCtor();

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
export const PROFILE_PROVIDERS = objectFreeze(['dsh', 'grok', 'cursor-local', 'cursor-cloud']);
export const PROFILE_ROLES = objectFreeze(['review', 'implement', 'verify']);

// Bounded requested-bytes model grammar mirrored from the assignment contract:
// first character alphanumeric, then alphanumerics plus `._/:-`, at most 128
// encoded UTF-8 bytes. Syntax and size only - no advertised-model membership
// is enforced here or anywhere else in ProfileV1. A model identifier is an
// opaque identifier, not a path, ref, command, or credential, so the exact
// top-level `model` value is exempt from the generic semantic value scanners
// below; those scanners still cover every other profile string at any depth,
// and the grammar plus requested-byte bound remain the model's whole safety
// contract, identical on both sides of the shared run vocabulary.
export const PROFILE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;
export const PROFILE_MODEL_ID_MAX_BYTES = 128;

// The one exempt scan path: the top-level `model` field of a profile under
// validation (`<prefix>.model`). Deeper or differently named paths never match,
// so a non-string `model` container and every nested string stay fully scanned.
const MODEL_SCAN_EXEMPT_PATHS = new SetCtor(['profile.model']);

/**
 * Deprecated informational compatibility data: the DSH model identifiers that
 * 3.2.1 setup advertises. Retained only so older catalogs and diagnostics keep
 * reading one stable constant. ProfileV1 validation never consults this list,
 * so it cannot authorize or reject any requested model; membership,
 * availability, qualification, resolution, and attestation stay preflight or
 * resolver concerns.
 * @deprecated Informational compatibility data only; not an authorization list.
 */
export const PROFILE_DSH_MODELS = objectFreeze(['muse-spark-1.2-contributor', 'stealth/ox-alpha']);
export const MIN_PROFILE_EXPECTED_DURATION_MS = MIN_DURATION_MS;
export const MAX_PROFILE_EXPECTED_DURATION_MS = MAX_EXPECTED_DURATION_MS;

const SCOPES = objectFreeze(['project', 'owner']);
// One catalog may hold up to MAX_PROFILES_PER_CATALOG entries per scope, so
// the merged load result is bounded at one catalog worth per scope.
const MAX_LOADED_PROFILES = MAX_PROFILES_PER_CATALOG * SCOPES.length;

function fail(code, message) {
  throw objectAssign(new Error(message), { code });
}

// util.types.isProxy consults only the internal Proxy slot: it dispatches no
// handler trap and never touches the (possibly revoked) target, so this guard
// rejects live and revoked Proxy views before Array.isArray, prototype
// inspection, own-key enumeration, descriptor reads, or property access can
// observe or invoke handler behavior.
const PROXY_REJECTION_CODE = 'profile_proxy_rejected';

function assertStaticData(value, label) {
  const kind = typeof value;
  if ((kind === 'object' || kind === 'function') && value !== null && isProxyValue(value)) {
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
    return objectGetOwnPropertyDescriptors(value);
  } catch {
    fail(code, `${label} properties could not be inspected safely.`);
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  assertStaticData(value, 'Profile data');
  if (arrayIsArray(value)) return false;
  try {
    const prototype = objectGetPrototypeOf(value);
    return prototype === objectPrototype || prototype === null;
  } catch {
    return false;
  }
}

function dataObjectDescriptors(value, code, label) {
  assertStaticData(value, label);
  if (!isPlainObject(value)) fail(code, `${label} must be a plain data object.`);
  const descriptors = snapshotOwnDescriptors(value, code, label);
  const keys = reflectOwnKeys(descriptors);
  if (arraySome.call(keys, (key) => typeof key !== 'string')) {
    fail(code, `${label} must not define symbol properties.`);
  }
  if (keys.length > MAX_PROFILE_OBJECT_KEYS) {
    fail('profile_structure_too_complex', `${label} exceeds the bounded property count.`);
  }
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor.enumerable || !objectHasOwn(descriptor, 'value')) {
      fail(code, `${label} must contain enumerable data properties only.`);
    }
  }
  return descriptors;
}

function dataArrayValues(value, code, label, maxItems = MAX_PROFILE_OBJECT_KEYS) {
  assertStaticData(value, label);
  if (!arrayIsArray(value)) fail(code, `${label} must be an array.`);
  let prototype;
  try {
    prototype = objectGetPrototypeOf(value);
  } catch {
    fail(code, `${label} could not be inspected safely.`);
  }
  if (prototype !== arrayPrototype && prototype !== null) {
    fail(code, `${label} must be a standard data array.`);
  }
  const descriptors = snapshotOwnDescriptors(value, code, label);
  const length = descriptors.length?.value;
  if (!numberIsInteger(length) || length < 0 || length > maxItems) {
    fail('profile_structure_too_complex', `${label} exceeds the bounded item count.`);
  }
  const expected = new SetCtor();
  setAdd.call(expected, 'length');
  for (let index = 0; index < length; index += 1) {
    setAdd.call(expected, String(index));
  }
  const keys = reflectOwnKeys(descriptors);
  if (arraySome.call(keys, (key) => typeof key !== 'string' || !setHas.call(expected, key))
    || keys.length !== expected.size) {
    fail(code, `${label} must be dense and must not define extra properties.`);
  }
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !objectHasOwn(descriptor, 'value')) {
      fail(code, `${label} must contain enumerable data items only.`);
    }
    arrayPush.call(values, descriptor.value);
  }
  return values;
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function requireNormalizedAbsolute(value, code, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || stringIncludes.call(value, '\0') || path.resolve(value) !== value) {
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
    prototype = objectGetPrototypeOf(env);
  } catch {
    fail('invalid_profile_environment', `The ${label} environment could not be inspected safely.`);
  }
  if (env !== process.env && prototype !== objectPrototype && prototype !== null) {
    fail('invalid_profile_environment',
      `The ${label} environment must be a plain data object.`);
  }
  const read = (key) => {
    let descriptor;
    try {
      descriptor = objectGetOwnPropertyDescriptor(env, key);
    } catch {
      fail('invalid_profile_environment',
        `The ${label} environment could not be inspected safely.`);
    }
    if (descriptor === undefined) return undefined;
    if (!descriptor.enumerable || !objectHasOwn(descriptor, 'value')) {
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
  const argument = (key) => (objectHasOwn(arguments_, key) ? arguments_[key].value : undefined);
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
  return objectFreeze({
    project: objectFreeze({
      scope: 'project',
      dir: path.join(repo, PROJECT_PROFILE_DIRNAME),
      file: path.join(repo, PROJECT_PROFILE_DIRNAME, PROJECT_PROFILE_FILENAME),
    }),
    owner: objectFreeze({
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
  const scopes = [{ object: false, keys: new SetCtor() }];
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
              key = jsonParse(stringSlice.call(text, stringStart - 1, index + 1));
            } catch {
              fail('invalid_profile_catalog_json', 'Profile catalog contains an invalid key string.');
            }
            if (setHas.call(scope.keys, key)) {
              fail('duplicate_profile_key', 'Profile catalog defines the same object key more than once.');
            }
            setAdd.call(scope.keys, key);
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
    if (char === '{') arrayPush.call(scopes, { object: true, keys: new SetCtor() });
    else if (char === '[') arrayPush.call(scopes, { object: false, keys: new SetCtor() });
    else if (char === '}' || char === ']') {
      arrayPop.call(scopes);
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
  } catch {
    fail('profile_catalog_changed_during_read', `The ${label} profile directory changed while its catalog was read.`);
  }
  if (!sameEntry(before, after)) {
    fail('profile_catalog_changed_during_read', `The ${label} profile directory changed while its catalog was read.`);
  }
}

function isProfileError(error) {
  const code = error && error.code;
  return typeof code === 'string'
    && (stringStartsWith.call(code, 'profile_') || stringStartsWith.call(code, 'invalid_profile_'));
}

function catalogOpenFlags() {
  return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
}

// Post-read re-observation primitives for the whole-catalog bracket. Absence
// is a first-class observation (missing <-> present is drift), while an entry
// that cannot be inspected at all becomes an explicit marker which can only
// ever widen the drift verdict - it can never masquerade as stability.
async function recaptureCatalogDirectory(dir) {
  try {
    return await lstat(dir, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    return null;
  }
}

async function recaptureCatalogFile(file) {
  let handle;
  try {
    handle = await open(file, catalogOpenFlags());
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    return null;
  }
  try {
    return await handle.stat({ bigint: true });
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

function sameObservation(before, after) {
  if (before === null || after === null) return false;
  if (before === undefined || after === undefined) return before === after;
  return sameEntry(before, after);
}

// Private whole-catalog bracket verdict over two observation sets. Any
// missing<->present flip, inode replacement, deletion, or in-place mutation
// of ANY source fails typed before records are parsed or a digest is issued.
function assertCatalogObservationsStable(before, after) {
  for (let index = 0; index < SCOPES.length; index += 1) {
    const scope = SCOPES[index];
    const captured = before[scope];
    const recaptured = after[scope];
    if (!sameObservation(captured.directory, recaptured.directory)
      || !sameObservation(captured.file, recaptured.file)) {
      fail('profile_catalog_changed_during_read',
        `The ${scope} profile catalog changed while it was read.`);
    }
  }
}

async function readCatalogText(file, label) {
  let handle;
  try {
    // A read-only open of a FIFO waits for a writer before fstat can reject
    // it. O_NONBLOCK makes the handle inspection authoritative without ever
    // waiting on attacker-controlled special-file behavior; it is inert for
    // regular files.
    handle = await open(file, catalogOpenFlags());
  } catch (error) {
    if (error && error.code === 'ENOENT') return { text: undefined, stat: undefined };
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
      return {
        stat: before,
        text: textDecoderDecode.call(new TextDecoderCtor('utf-8', { fatal: true }), bytes),
      };
    } catch {
      fail('invalid_profile_catalog_encoding', `The ${label} profile catalog must be valid UTF-8.`);
    }
  } catch (error) {
    if (isProfileError(error)) throw error;
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
    parsed = jsonParse(text);
  } catch {
    fail('invalid_profile_catalog_json', `The ${label} profile catalog is not valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    fail('invalid_profile_catalog_shape', `The ${label} profile catalog must be a JSON object keyed by profile name.`);
  }
  const names = objectKeys(parsed);
  if (names.length > MAX_PROFILES_PER_CATALOG) {
    fail('profile_catalog_too_many_entries', `The ${label} profile catalog exceeds ${MAX_PROFILES_PER_CATALOG} profiles.`);
  }
  return parsed;
}

export const ALLOWED_PROFILE_FIELDS = objectFreeze([
  'schema', 'provider', 'model', 'role', 'expected_duration_ms', 'policy', 'default',
]);
export const ALLOWED_PROFILE_POLICY_FIELDS = objectFreeze(['pre_dispatch_provider_preference']);
export const MAX_PROVIDER_PREFERENCE_ENTRIES = PROFILE_PROVIDERS.length;

// Keys are normalized (case and -/_ folded) before classification so trivial
// mutations cannot smuggle a forbidden field past an exact-match list.
const normalizeKey = (key) => stringReplace.call(stringToLowerCase.call(String(key)), /[-_ ]+/gu, '');

const FORBIDDEN_KEY_CLASSES = objectFreeze([
  ['profile_credential_key_rejected', objectFreeze([
    'credential', 'credentials', 'apikey', 'apisecret', 'token', 'tokens',
    'secret', 'secrets', 'password', 'passwd', 'auth', 'authorization',
    'bearer', 'cookie', 'sessiontoken', 'sessionkey', 'accesstoken',
    'refreshtoken', 'privatekey', 'signingkey',
  ])],
  ['profile_environment_key_rejected', objectFreeze([
    'env', 'environment', 'envvar', 'envvars', 'environmentvariable',
    'environmentvariables', 'envfile', 'dotenv', 'variables',
  ])],
  ['profile_executable_key_rejected', objectFreeze([
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
  ['profile_authority_key_rejected', objectFreeze([
    'merge', 'allowmerge', 'mergeauthority', 'mergemode', 'push',
    'allowpush', 'pushurl', 'createpr', 'autocreatepr',
    'createpullrequest', 'prmode', 'protectedrefs', 'protectedref',
    'protect', 'protectedbranch', 'protectedbranches', 'forcepush',
    'deletebranch', 'defaultbranch',
  ])],
  ['profile_direct_mode_key_rejected', objectFreeze([
    'workspacemode', 'workspace', 'workspaces', 'worktree', 'direct',
    'directmode', 'directworkspace',
  ])],
  ['profile_moving_ref_key_rejected', objectFreeze([
    'ref', 'refs', 'branch', 'startingref', 'baseref', 'head', 'tag',
    'tags', 'remote', 'remotes', 'origin', 'latest', 'pin', 'pinnedref',
  ])],
  ['profile_embedded_content_key_rejected', objectFreeze([
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
  if (arraySome.call(CREDENTIAL_TOKENS, (token) => stringIncludes.call(normalized, token))) return CREDENTIAL_CODE;
  for (let index = 0; index < FORBIDDEN_KEY_CLASSES.length; index += 1) {
    const pair = FORBIDDEN_KEY_CLASSES[index];
    if (arrayIncludes.call(pair[1], normalized)) return pair[0];
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
  if (arraySome.call(ENV_VALUE_PATTERNS, (pattern) => pattern.test(value))) {
    fail('profile_environment_value_rejected', `Profile "${name}" field ${key} must not contain environment interpolation.`);
  }
  if (arraySome.call(SHELL_VALUE_PATTERNS, (pattern) => pattern.test(value))) {
    fail('profile_shell_value_rejected', `Profile "${name}" field ${key} must not contain shell syntax.`);
  }
  if (arraySome.call(MOVING_REF_VALUE_PATTERNS, (pattern) => pattern.test(value))) {
    fail('profile_moving_ref_value_rejected', `Profile "${name}" field ${key} names a moving ref.`);
  }
}

// `exemptPaths` skips only the generic semantic value scan for exactly matching
// field paths (today: the top-level opaque model identifier). It never skips
// the walk itself: exempt values still count toward every structural bound,
// still pass through the descriptor snapshot and static-data/identity-graph
// checks, and any string at any other path is scanned as before.
function deepScanStrings(name, container, prefix, exemptPaths = MODEL_SCAN_EXEMPT_PATHS) {
  const stack = [{ value: container, depth: 0, field: prefix }];
  const seen = new SetCtor();
  let nodes = 0;
  let stringBytes = 0;
  while (stack.length > 0) {
    const { value, depth, field } = arrayPop.call(stack);
    nodes += 1;
    if (nodes > MAX_PROFILE_STRUCTURE_NODES || depth > MAX_PROFILE_STRUCTURE_DEPTH) {
      fail('profile_structure_too_complex', `Profile "${name}" exceeds the bounded data structure limits.`);
    }
    if (typeof value === 'string') {
      stringBytes += bufferByteLength(value, 'utf8');
      if (stringBytes > MAX_PROFILE_CATALOG_BYTES) {
        fail('profile_structure_too_complex', `Profile "${name}" exceeds the bounded string-data limit.`);
      }
      if (!setHas.call(exemptPaths, field)) scanValue(name, field, value);
      continue;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && numberIsFinite(value))) {
      continue;
    }
    if (typeof value !== 'object') {
      fail('invalid_profile_data_value', `Profile "${name}" contains a non-data value.`);
    }
    assertStaticData(value, `Profile "${name}" data`);
    if (setHas.call(seen, value)) {
      fail('invalid_profile_data_graph', `Profile "${name}" contains a cycle or shared object identity.`);
    }
    setAdd.call(seen, value);
    if (arrayIsArray(value)) {
      const values = dataArrayValues(value, 'invalid_profile_data_value', 'Profile data array');
      for (let index = values.length - 1; index >= 0; index -= 1) {
        arrayPush.call(stack, { value: values[index], depth: depth + 1, field: `${field}[${index}]` });
      }
    } else {
      const descriptors = dataObjectDescriptors(value, 'invalid_profile_data_value', 'Profile data object');
      const keys = objectKeys(descriptors);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        arrayPush.call(stack, { value: descriptors[key].value, depth: depth + 1, field: `${field}.${key}` });
      }
    }
  }
}

function requireProvider(name, provider) {
  if (!arrayIncludes.call(PROFILE_PROVIDERS, provider)) {
    fail('unsupported_profile_provider', `Profile "${name}" provider must be one of ${arrayJoin.call(PROFILE_PROVIDERS, ', ')}.`);
  }
  return provider;
}

function requireModel(name, model, provider) {
  // A model name is meaningful only beside an explicit known provider.
  if (!arrayIncludes.call(PROFILE_PROVIDERS, provider)) {
    fail('invalid_profile_model_for_provider',
      `Profile "${name}" may name a model only beside one of ${arrayJoin.call(PROFILE_PROVIDERS, ', ')}.`);
  }
  // One grammar for every exact provider, identical to the shared assignment
  // authority: syntax and requested-byte size only. No static allowlist and no
  // extra profile-only clause (such as a '..' traversal guard) is consulted, so
  // a pattern-valid model is accepted exactly where the shared grammar accepts
  // it - model identifiers are opaque, never parsed as paths, refs, commands,
  // or credentials.
  if (typeof model !== 'string'
    || !PROFILE_MODEL_ID_PATTERN.test(model)
    || bufferByteLength(model, 'utf8') > PROFILE_MODEL_ID_MAX_BYTES) {
    fail('invalid_profile_model',
      `Profile "${name}" model must match the bounded model grammar ${PROFILE_MODEL_ID_PATTERN.source}`
      + ` (at most ${PROFILE_MODEL_ID_MAX_BYTES} UTF-8 bytes).`);
  }
  return model;
}

function requireRole(name, role) {
  if (!arrayIncludes.call(PROFILE_ROLES, role)) {
    fail('unsupported_profile_role', `Profile "${name}" role must be one of ${arrayJoin.call(PROFILE_ROLES, ', ')}.`);
  }
  return role;
}

function requireExpectedDuration(name, duration) {
  if (!numberIsInteger(duration) || duration < MIN_PROFILE_EXPECTED_DURATION_MS
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
  const keys = objectKeys(descriptors);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const classification = classifyKey(key);
    if (!arrayIncludes.call(ALLOWED_PROFILE_POLICY_FIELDS, key) || classification !== undefined) {
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
    || !arrayEvery.call(values, (entry) => typeof entry === 'string')) {
    fail('invalid_profile_provider_preference',
      `Profile "${name}" pre_dispatch_provider_preference must be 1-${MAX_PROVIDER_PREFERENCE_ENTRIES} provider names.`);
  }
  const seen = new SetCtor();
  const copy = [];
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    requireProvider(name, entry);
    if (setHas.call(seen, entry)) {
      fail('duplicate_profile_preference_provider', `Profile "${name}" repeats provider "${entry}" in its preference order.`);
    }
    setAdd.call(seen, entry);
    arrayPush.call(copy, entry);
  }
  return copy;
}

// Optional prerequisite metadata only: `default: true` marks an
// owner-authored candidate default for later run-resolution work. Absence is
// ordinary, the value must be primitive `true` exactly, and the flag confers
// no authority here - lookup stays exact-name, a profile named "default" has
// no authority by name, and selection itself stays a resolver concern.
function requireDefaultFlag(name, value) {
  if (value !== true) {
    fail('invalid_profile_default',
      `Profile "${name}" default must be the primitive boolean true when present.`);
  }
  return true;
}

// Structural validation shared by loading and later linting. Field-level
// policy/provider/model validation is layered on top of this check.
export function validateProfileDefinition(name, raw) {
  if (!isValidProfileName(name)) {
    fail('invalid_profile_name', `Profile name must match ${PROFILE_NAME_PATTERN.source}.`);
  }
  const descriptors = dataObjectDescriptors(raw, 'invalid_profile_definition', `Profile "${name}"`);
  if (!objectHasOwn(descriptors, 'schema') || descriptors.schema.value !== PROFILE_SCHEMA) {
    fail('invalid_profile_schema', `Profile "${name}" must declare schema "${PROFILE_SCHEMA}".`);
  }

  // Fail closed on dangerous content before any structural leniency.
  deepScanStrings(name, raw, 'profile');

  const canonical = { schema: PROFILE_SCHEMA };
  const definitionKeys = objectKeys(descriptors);
  for (let index = 0; index < definitionKeys.length; index += 1) {
    const key = definitionKeys[index];
    if (key === 'schema') continue;
    const classification = classifyKey(key);
    if (!arrayIncludes.call(ALLOWED_PROFILE_FIELDS, key) || classification !== undefined) {
      rejectKey(name, key, classification, 'unknown_profile_field');
    }
  }
  const has = (field) => objectHasOwn(descriptors, field);
  if (has('provider')) canonical.provider = requireProvider(name, descriptors.provider.value);
  // A model name is meaningful only beside its explicit provider selection.
  if (has('model')) canonical.model = requireModel(name, descriptors.model.value, canonical.provider);
  if (has('role')) canonical.role = requireRole(name, descriptors.role.value);
  if (has('expected_duration_ms')) canonical.expected_duration_ms = requireExpectedDuration(name, descriptors.expected_duration_ms.value);
  if (has('policy')) canonical.policy = requirePolicy(name, descriptors.policy.value);
  if (has('default')) canonical.default = requireDefaultFlag(name, descriptors.default.value);
  return deepFreezeData(canonical);
}

function appendCanonicalToken(state, token) {
  const tokenBytes = bufferByteLength(token, 'utf8');
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
  if (bufferByteLength(value, 'utf8') > MAX_PROFILE_CATALOG_BYTES) {
    fail('invalid_profile_canonical_data',
      `Canonical profile data exceeds ${MAX_PROFILE_CATALOG_BYTES} encoded bytes.`);
  }
  return appendCanonicalToken(state, jsonStringify(value));
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
    return appendCanonicalToken(state, jsonStringify(value));
  }
  if (typeof value === 'number' && numberIsFinite(value)) {
    return appendCanonicalToken(state, jsonStringify(value));
  }
  if (typeof value !== 'object') {
    fail('invalid_profile_canonical_data', 'Canonical profile data contains an unsupported value.');
  }
  assertStaticData(value, 'Canonical profile data');
  if (setHas.call(seen, value)) fail('invalid_profile_canonical_data', 'Canonical profile data contains a cycle or alias.');
  setAdd.call(seen, value);
  if (arrayIsArray(value)) {
    const values = dataArrayValues(value, 'invalid_profile_canonical_data', 'Canonical profile array');
    const output = [appendCanonicalToken(state, '[')];
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) arrayPush.call(output, appendCanonicalToken(state, ','));
      arrayPush.call(output, canonicalProfileJsonInner(values[index], seen, depth + 1, state));
    }
    arrayPush.call(output, appendCanonicalToken(state, ']'));
    return arrayJoin.call(output, '');
  }
  const descriptors = dataObjectDescriptors(value, 'invalid_profile_canonical_data', 'Canonical profile object');
  const keys = objectKeys(descriptors);
  arraySort.call(keys);
  const output = [appendCanonicalToken(state, '{')];
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) arrayPush.call(output, appendCanonicalToken(state, ','));
    const key = keys[index];
    arrayPush.call(output, canonicalStringToken(key, state));
    arrayPush.call(output, appendCanonicalToken(state, ':'));
    arrayPush.call(output, canonicalProfileJsonInner(descriptors[key].value, seen, depth + 1, state));
  }
  arrayPush.call(output, appendCanonicalToken(state, '}'));
  return arrayJoin.call(output, '');
}

export function canonicalProfileJson(value) {
  assertStaticData(value, 'Canonical profile data');
  return canonicalProfileJsonInner(value, new SetCtor(), 0, { nodes: 0, bytes: 0 });
}

// Stable provenance digest over validated canonical data. Scope and source
// path are recorded beside the digest so the same content synced across
// scopes keeps one content identity while remaining traceable to origin.
export function profileProvenanceDigest(payload = {}) {
  assertStaticData(payload, 'The provenance arguments');
  const arguments_ = dataObjectDescriptors(payload, 'invalid_profile_provenance_payload',
    'The provenance arguments');
  const name = objectHasOwn(arguments_, 'name') ? arguments_.name.value : undefined;
  const definition = objectHasOwn(arguments_, 'definition') ? arguments_.definition.value : undefined;
  if (!isValidProfileName(name)) fail('invalid_profile_name', 'Profile name is invalid.');
  if (!isPlainObject(definition)) fail('invalid_profile_definition', 'Profile definition must be validated data.');
  // Closed-input gate: only definitions that pass full ProfileV1 validation
  // can be digested, and the hash is computed over validator-owned frozen
  // canonical output - never over the caller's view, so hidden keys,
  // accessors, or late-changing views cannot launder arbitrary content into
  // a provenance identity or destabilize it between calls.
  const validated = validateProfileDefinition(name, definition);
  const canonicalPayload = canonicalProfileJson({ definition: validated, name, schema: PROFILE_SCHEMA });
  const hash = cryptoCreateHash('sha256');
  cryptoHashUpdate.call(hash, canonicalPayload);
  return `sha256:${cryptoHashDigest.call(hash, 'hex')}`;
}

function deepFreezeData(value) {
  const stack = [value];
  const seen = new SetCtor();
  while (stack.length > 0) {
    const current = arrayPop.call(stack);
    if (typeof current !== 'object' || current === null || setHas.call(seen, current)) continue;
    assertStaticData(current, 'Validated profile data');
    setAdd.call(seen, current);
    if (arrayIsArray(current)) {
      const values = dataArrayValues(current, 'invalid_profile_definition', 'Validated profile array');
      for (let index = 0; index < values.length; index += 1) arrayPush.call(stack, values[index]);
    } else {
      const descriptors = dataObjectDescriptors(current, 'invalid_profile_definition', 'Validated profile object');
      const children = objectValues(descriptors);
      for (let index = 0; index < children.length; index += 1) {
        arrayPush.call(stack, children[index].value);
      }
    }
    objectFreeze(current);
  }
  return value;
}

function buildRecord(name, raw, scope, source) {
  const definition = deepFreezeData(validateProfileDefinition(name, raw));
  return objectFreeze({
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
//
// Binding catalog contract: read raw bounded inputs for both scopes first.
// Only after every read, re-observe every directory and file across the whole
// catalog. missing<->present, replacement, deletion, or in-place mutation
// fails typed before any catalog is parsed into authoritative records or a
// digest is issued. Per-scope self-checks still run around each read; they
// are not sufficient on their own (project from one era + owner from another
// would otherwise become a never-coexistent hybrid).
export async function loadProfiles(options = {}) {
  const roots = profileRoots(options);
  const captured = objectCreate(null);
  for (let index = 0; index < SCOPES.length; index += 1) {
    const scope = SCOPES[index];
    const root = roots[scope];
    const directory = await requireRealDirectoryOrMissing(root.dir, scope);
    const read = directory === undefined
      ? { text: undefined, stat: undefined }
      : await readCatalogText(root.file, scope);
    if (directory !== undefined) await assertDirectoryUnchanged(root.dir, directory, scope);
    captured[scope] = objectFreeze({ directory, file: read.stat, text: read.text });
  }

  const recaptured = objectCreate(null);
  for (let index = 0; index < SCOPES.length; index += 1) {
    const scope = SCOPES[index];
    const root = roots[scope];
    recaptured[scope] = objectFreeze({
      directory: await recaptureCatalogDirectory(root.dir),
      file: await recaptureCatalogFile(root.file),
    });
  }
  assertCatalogObservationsStable(captured, recaptured);

  const catalogs = new MapCtor();
  const loadedScopes = new SetCtor();
  for (let index = 0; index < SCOPES.length; index += 1) {
    const scope = SCOPES[index];
    const text = captured[scope].text;
    if (text !== undefined) setAdd.call(loadedScopes, scope);
    mapSet.call(catalogs, scope, text === undefined ? {} : parseCatalog(text, scope));
  }

  const primary = new MapCtor();
  const shadowed = [];
  for (let index = 0; index < SCOPES.length; index += 1) {
    const scope = SCOPES[index];
    const root = roots[scope];
    const catalog = mapGet.call(catalogs, scope);
    const names = objectKeys(catalog);
    arraySort.call(names);
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      const name = names[nameIndex];
      const record = buildRecord(name, catalog[name], scope, root.file);
      if (mapHas.call(primary, name)) {
        arrayPush.call(shadowed, objectFreeze({
          ...record,
          reason: 'project_scope_precedence',
          primary_digest: mapGet.call(primary, name).digest,
        }));
      } else {
        mapSet.call(primary, name, record);
      }
    }
  }

  const profiles = [];
  mapForEach.call(primary, (record) => { arrayPush.call(profiles, record); });
  arraySort.call(profiles, (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const sources = [];
  for (let index = 0; index < SCOPES.length; index += 1) {
    const scope = SCOPES[index];
    arrayPush.call(sources, objectFreeze({
      scope,
      file: roots[scope].file,
      loaded: setHas.call(loadedScopes, scope),
    }));
  }
  return objectFreeze({
    roots,
    profiles: objectFreeze(profiles),
    shadowed: objectFreeze(shadowed),
    sources: objectFreeze(sources),
  });
}

function assertTrustedCatalogSnapshot(value) {
  if (!weakMapHas.call(catalogSnapshotBrand, value)) {
    fail('invalid_profile_snapshot',
      'Resolver authority requires a loader-branded catalog snapshot.');
  }
}

// Exact-name lookup only. There are no fuzzy matches, defaults, or fallbacks
// here; unresolved choices are surfaced by the resolver, not guessed. The
// load result is consumed as one static descriptor snapshot: records are
// matched against snapshotted data names, so no live or revoked Proxy view
// can intercept the lookup, and malformed or over-large results fail with
// typed codes instead of native errors.
//
// Legacy findProfile remains a data utility over loadProfiles()-shaped
// results. Resolver authority over a catalog snapshot consumes only a
// loader-branded snapshot (or a separately trusted reload from disk); a
// shape-compatible caller object with catalog_digest is rejected.
export function findProfile(loaded, name) {
  assertStaticData(loaded, 'The loadProfiles() result');
  if (loaded === undefined || loaded === null || !isPlainObject(loaded)) {
    fail('invalid_profile_load_result', 'loadProfiles() result is required.');
  }
  const descriptors = dataObjectDescriptors(loaded, 'invalid_profile_load_result',
    'The loadProfiles() result');
  if (objectHasOwn(descriptors, 'catalog_digest')) assertTrustedCatalogSnapshot(loaded);
  if (!objectHasOwn(descriptors, 'profiles')) {
    fail('invalid_profile_load_result', 'loadProfiles() result is missing its profile list.');
  }
  const list = dataArrayValues(descriptors.profiles.value, 'invalid_profile_load_result',
    'The loadProfiles() profile list', MAX_LOADED_PROFILES);
  if (!isValidProfileName(name)) {
    fail('invalid_profile_name', `Profile name must match ${PROFILE_NAME_PATTERN.source}.`);
  }
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    assertStaticData(record, 'The loaded profile record');
    const recordDescriptors = dataObjectDescriptors(record, 'invalid_profile_load_result',
      'The loaded profile record');
    if (!objectHasOwn(recordDescriptors, 'name')) {
      fail('invalid_profile_load_result', 'The loaded profile record is missing its name.');
    }
    const recordName = recordDescriptors.name.value;
    if (!isValidProfileName(recordName)) {
      fail('invalid_profile_load_result', 'The loaded profile record name is invalid.');
    }
    if (recordName === name) {
      const expectedFields = ['name', 'scope', 'source', 'definition', 'digest'];
      const recordFields = objectKeys(recordDescriptors);
      if (recordFields.length !== expectedFields.length
        || arraySome.call(expectedFields, (field) => !objectHasOwn(recordDescriptors, field))) {
        fail('invalid_profile_load_result',
          'The matching loaded profile record must contain exactly the loadProfiles() record fields.');
      }
      const scope = recordDescriptors.scope.value;
      if (!arrayIncludes.call(SCOPES, scope)) {
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
      return objectFreeze({ name: recordName, scope, source, definition, digest });
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Whole-catalog snapshot port (additive). P05 consumes one immutable catalog
// snapshot instead of rereading files: this API performs exactly one
// loadProfiles() read of both scopes and closes the merged result into a
// detached, deeply frozen JSON-only snapshot bound to per-record provenance
// digests and one whole-catalog digest. Resolver authority consumes only a
// loader-branded snapshot; a separately trusted recovery is a fresh load
// from disk, never a shape-compatible caller object. Internal stability and
// closure predicates stay private. The snapshot adds no executable,
// environment, default, or route-selection behavior.
// ---------------------------------------------------------------------------

// Domain separation for the catalog-level digest. Per-record provenance
// digests stay content-only and path-independent; this whole-catalog binding
// is deliberately origin-aware: it covers each scope's presence and exact
// source file plus every record binding in deterministic name order, so
// content, precedence, ordering, presence, or origin drift yields a
// different digest.
const PROFILE_CATALOG_SNAPSHOT_DIGEST_DOMAIN = 'codex-co-engineer.profile-catalog.v1';

function rejectNonJsonSnapshotValue(value, label) {
  const kind = typeof value;
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint' || kind === 'undefined'
    || (kind === 'number' && !numberIsFinite(value))
    || bufferIsBuffer(value) || arrayBufferIsView(value) || value instanceof Uint8ArrayCtor) {
    fail('invalid_profile_snapshot_closure', `${label} must be JSON-only data.`);
  }
}

// Detached JSON-only clone: functions, symbols, bigint, undefined, non-finite
// numbers, accessors, proxies, exotic containers, cycles/aliases, Map/Set/
// RegExp/typed arrays, and unfrozen containers fail typed. Every emitted
// container is a new frozen identity.
function cloneFrozenJsonData(value, seen, label) {
  rejectNonJsonSnapshotValue(value, label);
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && numberIsFinite(value))) {
    return value;
  }
  if (typeof value !== 'object') {
    fail('invalid_profile_snapshot_closure', `${label} must be JSON-only data.`);
  }
  assertStaticData(value, label);
  if (setHas.call(seen, value)) {
    fail('invalid_profile_snapshot_closure', `${label} must not contain a cycle or alias.`);
  }
  setAdd.call(seen, value);
  if (!objectIsFrozen(value)) {
    fail('invalid_profile_snapshot_closure', `${label} must be deeply frozen.`);
  }
  if (arrayIsArray(value)) {
    const values = dataArrayValues(value, 'invalid_profile_snapshot_closure', label, MAX_LOADED_PROFILES);
    const clone = [];
    for (let index = 0; index < values.length; index += 1) {
      arrayPush.call(clone, cloneFrozenJsonData(values[index], seen, `${label}[${index}]`));
    }
    return objectFreeze(clone);
  }
  const descriptors = dataObjectDescriptors(value, 'invalid_profile_snapshot_closure', label);
  const keys = objectKeys(descriptors);
  const clone = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    objectDefineProperty(clone, key, {
      value: cloneFrozenJsonData(descriptors[key].value, seen, `${label}.${key}`),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return objectFreeze(clone);
}

// Incrementally hashed JSON frames: no single canonical string is ever
// materialized, so even a fully loaded two-scope catalog stays far below the
// bounded canonical encoding budget while every bound value keeps
// unambiguous framing.
function computeProfileCatalogDigest(loaded) {
  const hash = cryptoCreateHash('sha256');
  const bind = (label, value) => cryptoHashUpdate.call(hash, `${jsonStringify([label, value])}\n`);
  bind('digest_domain', PROFILE_CATALOG_SNAPSHOT_DIGEST_DOMAIN);
  const sources = loaded.sources;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    bind('source', [source.scope, source.file, source.loaded]);
  }
  const profiles = loaded.profiles;
  for (let index = 0; index < profiles.length; index += 1) {
    const record = profiles[index];
    bind('profile', [record.name, record.scope, record.source, record.digest]);
  }
  const shadowed = loaded.shadowed;
  for (let index = 0; index < shadowed.length; index += 1) {
    const record = shadowed[index];
    bind('shadowed',
      [record.name, record.scope, record.source, record.reason, record.digest, record.primary_digest]);
  }
  return `sha256:${cryptoHashDigest.call(hash, 'hex')}`;
}

// Closure proof over the emitted graph: every container must be a plain,
// dense, static, deeply frozen value - no accessor, symbol key, exotic
// prototype, Map/Set escape, or unfrozen object can reach a consumer through
// a snapshot.
function assertSnapshotClosure(value, seen = new SetCtor()) {
  if (value === null || typeof value !== 'object' || setHas.call(seen, value)) return;
  rejectNonJsonSnapshotValue(value, 'The profile catalog snapshot');
  setAdd.call(seen, value);
  assertStaticData(value, 'The profile catalog snapshot');
  if (!objectIsFrozen(value)) {
    fail('invalid_profile_snapshot_closure', 'The profile catalog snapshot must be deeply frozen.');
  }
  const children = arrayIsArray(value)
    ? dataArrayValues(value, 'invalid_profile_snapshot_closure',
      'The profile catalog snapshot array', MAX_LOADED_PROFILES)
    : arrayMap.call(objectValues(dataObjectDescriptors(value, 'invalid_profile_snapshot_closure',
      'The profile catalog snapshot container')), (descriptor) => descriptor.value);
  for (let index = 0; index < children.length; index += 1) {
    assertSnapshotClosure(children[index], seen);
  }
}

function brandCatalogSnapshot(snapshot, digest) {
  weakMapSet.call(catalogSnapshotBrand, snapshot, objectFreeze({ catalog_digest: digest }));
  return snapshot;
}

// One read, one closed snapshot: `options` are exactly loadProfiles()' options
// (repositoryPath, ownerConfigDir, env) and keep their typed rejections for
// hostile direct-JS views and mid-read catalog drift. `profiles` lists
// normalized ProfileV1 records in deterministic name order; `shadowed` keeps
// project-precedence losers visible; `catalog_digest` binds the whole
// ordered catalog. Resolution reuses findProfile(snapshot, name) only for a
// loader-branded snapshot, so a run resolves its run_profile plus every
// assignment profile from this one object without touching the filesystem
// again.
export async function loadProfileCatalogSnapshot(options = {}) {
  const loaded = await loadProfiles(options);
  const roots = cloneFrozenJsonData(loaded.roots, new SetCtor(), 'The profile catalog snapshot roots');
  const sources = cloneFrozenJsonData(loaded.sources, new SetCtor(), 'The profile catalog snapshot sources');
  const profiles = cloneFrozenJsonData(loaded.profiles, new SetCtor(), 'The profile catalog snapshot profiles');
  const shadowed = cloneFrozenJsonData(loaded.shadowed, new SetCtor(), 'The profile catalog snapshot shadowed records');
  const catalogDigest = computeProfileCatalogDigest({ sources, profiles, shadowed });
  const snapshot = objectFreeze({
    schema: PROFILE_SCHEMA,
    catalog_digest: catalogDigest,
    roots,
    sources,
    profiles,
    shadowed,
  });
  assertSnapshotClosure(snapshot);
  return brandCatalogSnapshot(snapshot, catalogDigest);
}

objectFreeze(profileRoots);
objectFreeze(isValidProfileName);
objectFreeze(assertNoDuplicateCatalogKeys);
objectFreeze(validateProfileDefinition);
objectFreeze(canonicalProfileJson);
objectFreeze(profileProvenanceDigest);
objectFreeze(loadProfiles);
objectFreeze(findProfile);
objectFreeze(loadProfileCatalogSnapshot);
