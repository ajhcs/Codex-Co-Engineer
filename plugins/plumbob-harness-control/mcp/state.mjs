import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

const COMPONENT_STATE_DIRECTORY = 'codex-co-engineer';
const OWNER_ONLY_DIRECTORY_MODE = 0o700;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function invalid(source, reason) {
  return { directory: null, source, reason };
}

function configuredAbsolute(env, name, source) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return undefined;
  const value = nonEmptyString(env[name]);
  if (!value) return invalid(source, `${name} is empty; set it to a writable absolute path.`);
  if (!path.isAbsolute(value)) {
    return invalid(source, `${name} must be an absolute path; refusing a relative state directory.`);
  }
  return { directory: path.resolve(value), source, reason: null };
}

/**
 * Resolve the one durable state directory shared by the Co-Engineer
 * lifecycle components. Explicit component settings always win, including
 * malformed settings: an empty or relative value must not silently fall
 * through to a different state location.
 */
export function resolveStateDirectory(env = process.env) {
  const explicit = configuredAbsolute(env, 'CODEX_CO_ENGINEER_STATE_DIR', 'environment');
  if (explicit !== undefined) return explicit;

  const legacy = configuredAbsolute(env, 'PLUMBOB_HARNESS_STATE_DIR', 'legacy_environment');
  if (legacy !== undefined) return legacy;

  if (Object.prototype.hasOwnProperty.call(env, 'CODEX_TASK_STATE_ROOT')) {
    const sharedRoot = nonEmptyString(env.CODEX_TASK_STATE_ROOT);
    if (!sharedRoot) {
      return invalid(
        'task_state_root',
        'CODEX_TASK_STATE_ROOT is empty; set it to a writable absolute path or remove the variable to use XDG/HOME fallback.',
      );
    }
    if (!path.isAbsolute(sharedRoot)) {
      return invalid(
        'task_state_root',
        'CODEX_TASK_STATE_ROOT must be an absolute path; refusing a relative shared state root.',
      );
    }
    return {
      directory: path.join(path.resolve(sharedRoot), COMPONENT_STATE_DIRECTORY),
      source: 'task_state_root',
      reason: null,
    };
  }

  if (Object.prototype.hasOwnProperty.call(env, 'XDG_STATE_HOME')) {
    const xdg = nonEmptyString(env.XDG_STATE_HOME);
    if (!xdg) {
      return invalid(
        'xdg_state_home',
        'XDG_STATE_HOME is empty; set it to a writable absolute path or remove the variable to use HOME fallback.',
      );
    }
    if (!path.isAbsolute(xdg)) {
      return invalid(
        'xdg_state_home',
        'XDG_STATE_HOME must be an absolute path; refusing a relative XDG state root.',
      );
    }
    return {
      directory: path.resolve(path.join(xdg, COMPONENT_STATE_DIRECTORY)),
      source: 'xdg_state_home',
      reason: null,
    };
  }

  const home = nonEmptyString(env.HOME);
  if (home && path.isAbsolute(home)) {
    return {
      directory: path.resolve(path.join(home, '.local', 'state', COMPONENT_STATE_DIRECTORY)),
      source: 'home',
      reason: null,
    };
  }

  return invalid(
    'unconfigured',
    'No durable Co-Engineer state directory is configured. Set CODEX_CO_ENGINEER_STATE_DIR, PLUMBOB_HARNESS_STATE_DIR, CODEX_TASK_STATE_ROOT, or an absolute HOME/XDG_STATE_HOME path.',
  );
}

export function stateResolutionMessage(resolution) {
  if (resolution?.directory) return null;
  return resolution?.reason
    ?? 'No durable Co-Engineer state directory is available.';
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function absoluteStatePath(directory) {
  const value = nonEmptyString(directory);
  if (!value || !path.isAbsolute(value)) {
    throw new StateDirectoryError(
      'state_path_invalid',
      'A durable Co-Engineer state directory must be a non-empty absolute path.',
    );
  }
  return path.resolve(value);
}

function metadataIdentity(metadata, component) {
  if (metadata?.dev === undefined || metadata?.ino === undefined) {
    throw new StateDirectoryError(
      'state_identity_unsupported',
      `Cannot verify the filesystem identity of the Co-Engineer state component ${component}; durable state is disabled on this filesystem/runtime.`,
    );
  }
  return {
    component,
    dev: String(metadata.dev),
    ino: String(metadata.ino),
  };
}

function assertDirectoryMetadata(metadata, component) {
  if (metadata.isSymbolicLink()) {
    throw new StateDirectoryError(
      'state_symlink',
      `Co-Engineer state component is a symbolic link and will not be followed: ${component}.`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new StateDirectoryError(
      'state_not_directory',
      `Co-Engineer state component is not a directory: ${component}.`,
    );
  }
}

function assertOwner(metadata, component, { final = false } = {}) {
  const uid = currentUid();
  if (uid === null || metadata?.uid === undefined) {
    throw new StateDirectoryError(
      'state_identity_unsupported',
      `Cannot verify ownership of the Co-Engineer state component ${component}; durable state is disabled on this platform/runtime.`,
    );
  }
  if (metadata.uid !== uid) {
    throw new StateDirectoryError(
      'state_owner',
      `Co-Engineer state ${final ? 'directory' : 'component'} is not owned by the MCP process user: ${component}.`,
    );
  }
}

function assertFinalMode(metadata, component) {
  // Do not repair an existing directory. A compromised or shared directory
  // must be replaced by the administrator rather than silently chmod'd.
  if ((metadata.mode & 0o7777) !== OWNER_ONLY_DIRECTORY_MODE) {
    throw new StateDirectoryError(
      'state_permissions',
      `Co-Engineer state directory must have owner-only mode 0700: ${component}.`,
    );
  }
}

function assertAncestorSafety(metadata, component) {
  const mode = metadata.mode & 0o7777;
  const sticky = (mode & 0o1000) !== 0;
  // A sticky shared directory such as /tmp prevents other users from
  // replacing an already-owned child. Any non-sticky group/world-writable
  // ancestor can redirect creation and is not acceptable, even when the
  // current user owns that ancestor.
  if ((mode & 0o022) !== 0 && !sticky) {
    throw new StateDirectoryError(
      'state_ancestor_unsafe',
      `Co-Engineer state has an unsafe group/world-writable ancestor without a sticky bit: ${component}.`,
    );
  }
}

async function inspectComponent(component, { final = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(component);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new StateDirectoryError(
      'state_unavailable',
      `Unable to inspect Co-Engineer state component ${component}: ${error?.message ?? String(error)}.`,
      { cause: error },
    );
  }
  assertDirectoryMetadata(metadata, component);
  if (final) {
    assertOwner(metadata, component, { final: true });
    assertFinalMode(metadata, component);
  } else {
    assertAncestorSafety(metadata, component);
  }
  return metadataIdentity(metadata, component);
}

export function sameStateIdentity(expected, metadata) {
  return expected.dev === String(metadata.dev) && expected.ino === String(metadata.ino);
}

function requirePreparedHandle(handle) {
  if (!handle || typeof handle !== 'object' || !Array.isArray(handle.components)
    || typeof handle.directory !== 'string' || !path.isAbsolute(handle.directory)) {
    throw new StateDirectoryError(
      'state_identity_invalid',
      'A prepared Co-Engineer state-directory handle is required.',
    );
  }
  return handle;
}

function secureChildPath(handle, name) {
  requirePreparedHandle(handle);
  if (typeof name !== 'string' || name.length === 0 || path.basename(name) !== name
    || name === '.' || name === '..') {
    throw new StateDirectoryError(
      'state_child_invalid',
      'Co-Engineer state child names must be one non-empty basename.',
    );
  }
  return path.join(handle.directory, name);
}

function assertSecureChildMetadata(metadata, child, {
  kind = 'file',
  mode = 0o600,
} = {}) {
  if (metadata.isSymbolicLink()) {
    throw new StateDirectoryError(
      'state_symlink',
      `Co-Engineer state child is a symbolic link and will not be followed: ${child}.`,
    );
  }
  const matchesKind = kind === 'socket' ? metadata.isSocket() : metadata.isFile();
  if (!matchesKind) {
    throw new StateDirectoryError(
      'state_child_type',
      `Co-Engineer state child must be a real ${kind}: ${child}.`,
    );
  }
  assertOwner(metadata, child, { final: true });
  if (metadata.nlink !== 1) {
    throw new StateDirectoryError(
      'state_child_links',
      `Co-Engineer state child must have exactly one filesystem link: ${child}.`,
    );
  }
  if (mode !== null && (metadata.mode & 0o7777) !== mode) {
    throw new StateDirectoryError(
      'state_child_permissions',
      `Co-Engineer state ${kind} must have owner-only mode ${mode.toString(8).padStart(4, '0')}: ${child}.`,
    );
  }
}

function noFollowFlag() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new StateDirectoryError(
      'state_identity_unsupported',
      'This platform/runtime does not expose O_NOFOLLOW; refusing secure Co-Engineer state-file access.',
    );
  }
  return constants.O_NOFOLLOW;
}

function stateOpenError(error, child) {
  if (error instanceof StateDirectoryError) return error;
  if (error?.code === 'ELOOP') {
    return new StateDirectoryError(
      'state_symlink',
      `Co-Engineer state child is a symbolic link and will not be followed: ${child}.`,
      { cause: error },
    );
  }
  return new StateDirectoryError(
    'state_unavailable',
    `Unable to open Co-Engineer state child ${child}: ${error?.message ?? String(error)}.`,
    { cause: error },
  );
}

async function lstatChild(child, { required = true } = {}) {
  try {
    return await lstat(child);
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    throw new StateDirectoryError(
      error?.code === 'ENOENT' ? 'state_child_missing' : 'state_unavailable',
      `Unable to inspect Co-Engineer state child ${child}: ${error?.message ?? String(error)}.`,
      { cause: error },
    );
  }
}

function canonicalAbsoluteFile(file) {
  const value = nonEmptyString(file);
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new StateDirectoryError(
      'state_path_invalid',
      'A Co-Engineer state file must use one canonical absolute path.',
    );
  }
  return value;
}

/** Synchronous file inspection for Node APIs such as DatabaseSync. */
export function inspectStateFilePathSync(file, {
  required = true,
  expectedIdentity = null,
} = {}) {
  const child = canonicalAbsoluteFile(file);
  let metadata;
  try {
    metadata = lstatSync(child);
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    throw new StateDirectoryError(
      error?.code === 'ENOENT' ? 'state_child_missing' : 'state_unavailable',
      `Unable to inspect Co-Engineer state child ${child}: ${error?.message ?? String(error)}.`,
      { cause: error },
    );
  }
  assertSecureChildMetadata(metadata, child, { kind: 'file', mode: 0o600 });
  if (expectedIdentity && !sameStateIdentity(expectedIdentity, metadata)) {
    throw new StateDirectoryError(
      'state_identity_changed',
      `Co-Engineer state child changed during use: ${child}.`,
    );
  }
  return Object.freeze(metadataIdentity(metadata, child));
}

/**
 * Synchronous O_EXCL|O_NOFOLLOW preparation for path-only synchronous APIs.
 * Callers remain responsible for preparing and identity-binding the parent.
 */
export function prepareStateFilePathSync(file) {
  const child = canonicalAbsoluteFile(file);
  let descriptor;
  let createdIdentity = null;
  try {
    descriptor = openSync(
      child,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const metadata = fstatSync(descriptor);
    assertSecureChildMetadata(metadata, child, { kind: 'file', mode: 0o600 });
    createdIdentity = metadataIdentity(metadata, child);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw stateOpenError(error, child);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return inspectStateFilePathSync(child, { expectedIdentity: createdIdentity });
}

async function inspectSecureStateChild(handle, name, {
  required = true,
  expectedIdentity = null,
  kind = 'file',
  mode = 0o600,
} = {}) {
  const child = secureChildPath(handle, name);
  await revalidateStateDirectory(handle);
  const metadata = await lstatChild(child, { required });
  if (!metadata) return null;
  assertSecureChildMetadata(metadata, child, { kind, mode });
  const identity = metadataIdentity(metadata, child);
  if (expectedIdentity && !sameStateIdentity(expectedIdentity, metadata)) {
    throw new StateDirectoryError(
      'state_identity_changed',
      `Co-Engineer state child changed during use: ${child}.`,
    );
  }
  await revalidateStateDirectory(handle);
  const confirmed = await lstatChild(child);
  assertSecureChildMetadata(confirmed, child, { kind, mode });
  if (!sameStateIdentity(identity, confirmed)) {
    throw new StateDirectoryError(
      'state_identity_changed',
      `Co-Engineer state child changed during validation: ${child}.`,
    );
  }
  return Object.freeze(identity);
}

/** Inspect an existing owner-only regular child beneath prepared state. */
export async function inspectStateFile(handle, name, options = {}) {
  return inspectSecureStateChild(handle, name, { ...options, kind: 'file', mode: 0o600 });
}

/** Inspect an existing owner-only Unix socket beneath prepared state. */
export async function inspectStateSocket(handle, name, options = {}) {
  return inspectSecureStateChild(handle, name, {
    ...options,
    kind: 'socket',
    mode: options.mode === null ? null : 0o600,
  });
}

/**
 * Create one new regular state child with O_EXCL|O_NOFOLLOW, or validate the
 * existing child without following it. This is used to pre-create SQLite's
 * path before the path-only DatabaseSync API opens it.
 */
export async function prepareStateFile(handle, name) {
  const child = secureChildPath(handle, name);
  await revalidateStateDirectory(handle);
  let created = null;
  let createdIdentity = null;
  try {
    created = await open(
      child,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const metadata = await created.stat();
    assertSecureChildMetadata(metadata, child, { kind: 'file', mode: 0o600 });
    createdIdentity = metadataIdentity(metadata, child);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw stateOpenError(error, child);
  } finally {
    await created?.close().catch(() => {});
  }
  return inspectStateFile(handle, name, { expectedIdentity: createdIdentity });
}

/**
 * Attempt to create a new owner-only regular child without following links.
 * A secure existing file is returned as `created: false`; an unsafe existing
 * object is rejected instead of being treated as lock contention.
 */
export async function createExclusiveStateFile(handle, name) {
  const child = secureChildPath(handle, name);
  await revalidateStateDirectory(handle);
  let file;
  try {
    file = await open(
      child,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const metadata = await file.stat();
    assertSecureChildMetadata(metadata, child, { kind: 'file', mode: 0o600 });
    const identity = metadataIdentity(metadata, child);
    await inspectStateFile(handle, name, { expectedIdentity: identity });
    return { created: true, file, path: child, identity: Object.freeze(identity) };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return {
        created: false,
        file: null,
        path: child,
        identity: await inspectStateFile(handle, name),
      };
    }
    await file?.close().catch(() => {});
    throw stateOpenError(error, child);
  }
}

/** Open a verified owner-only regular state child for reading by fd. */
export async function openStateFileRead(handle, name, { expectedIdentity = null } = {}) {
  const child = secureChildPath(handle, name);
  await revalidateStateDirectory(handle);
  let file;
  try {
    file = await open(child, constants.O_RDONLY | noFollowFlag());
    const metadata = await file.stat();
    assertSecureChildMetadata(metadata, child, { kind: 'file', mode: 0o600 });
    const identity = metadataIdentity(metadata, child);
    if (expectedIdentity && !sameStateIdentity(expectedIdentity, metadata)) {
      throw new StateDirectoryError(
        'state_identity_changed',
        `Co-Engineer state child changed before it was opened: ${child}.`,
      );
    }
    await inspectStateFile(handle, name, { expectedIdentity: identity });
    return { file, path: child, identity: Object.freeze(identity) };
  } catch (error) {
    await file?.close().catch(() => {});
    throw stateOpenError(error, child);
  }
}

/** Open one append-only owner-only state child without following symlinks. */
export async function openAppendStateFile(handle, name) {
  const child = secureChildPath(handle, name);
  await revalidateStateDirectory(handle);
  let file;
  try {
    file = await open(
      child,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollowFlag(),
      0o600,
    );
    const metadata = await file.stat();
    assertSecureChildMetadata(metadata, child, { kind: 'file', mode: 0o600 });
    const identity = metadataIdentity(metadata, child);
    await inspectStateFile(handle, name, { expectedIdentity: identity });
    return { file, path: child, identity: Object.freeze(identity) };
  } catch (error) {
    await file?.close().catch(() => {});
    throw stateOpenError(error, child);
  }
}

async function removeSecureStateChild(handle, name, {
  expectedIdentity = null,
  kind = 'file',
  required = false,
} = {}) {
  const child = secureChildPath(handle, name);
  const inspect = kind === 'socket' ? inspectStateSocket : inspectStateFile;
  const identity = await inspect(handle, name, { required, expectedIdentity });
  if (!identity) return false;
  await revalidateStateDirectory(handle);
  await inspect(handle, name, { expectedIdentity: identity });
  try {
    await unlink(child);
  } catch (error) {
    throw new StateDirectoryError(
      'state_unavailable',
      `Unable to remove Co-Engineer state ${kind} ${child}: ${error?.message ?? String(error)}.`,
      { cause: error },
    );
  }
  await revalidateStateDirectory(handle);
  if (await lstatChild(child, { required: false })) {
    throw new StateDirectoryError(
      'state_identity_changed',
      `Co-Engineer state ${kind} reappeared while it was being removed: ${child}.`,
    );
  }
  return true;
}

export async function removeStateFile(handle, name, options = {}) {
  return removeSecureStateChild(handle, name, { ...options, kind: 'file' });
}

export async function removeStateSocket(handle, name, options = {}) {
  return removeSecureStateChild(handle, name, { ...options, kind: 'socket' });
}

export function stateDirectoryDigest(handle) {
  requirePreparedHandle(handle);
  const identity = handle.components.at(-1);
  return createHash('sha256').update(JSON.stringify({
    directory: handle.directory,
    dev: identity.dev,
    ino: identity.ino,
  })).digest('hex');
}

/** Revalidate an existing prepared directory and reject component swaps. */
export async function revalidateStateDirectory(handle) {
  requirePreparedHandle(handle);
  for (const expected of handle.components) {
    let metadata;
    try {
      metadata = await lstat(expected.component);
    } catch (error) {
      throw new StateDirectoryError(
        'state_identity_changed',
        `Co-Engineer state component disappeared during use: ${expected.component}.`,
        { cause: error },
      );
    }
    assertDirectoryMetadata(metadata, expected.component);
    if (!sameStateIdentity(expected, metadata)) {
      throw new StateDirectoryError(
        'state_identity_changed',
        `Co-Engineer state component changed during use: ${expected.component}.`,
      );
    }
    const isFinal = expected.component === handle.directory;
    if (isFinal) {
      assertOwner(metadata, expected.component, { final: true });
      assertFinalMode(metadata, expected.component);
    } else {
      assertAncestorSafety(metadata, expected.component);
    }
  }
  return handle;
}

/**
 * Create missing state components with 0700 and return an identity-bound
 * handle. Existing components are never chmod-repaired. Every component is
 * lstat-checked, and the finished tree is revalidated before the handle is
 * returned to the caller.
 */
export async function prepareStateDirectory(directory) {
  const absolute = absoluteStatePath(directory);
  const uid = currentUid();
  if (uid === null) {
    throw new StateDirectoryError(
      'state_identity_unsupported',
      'Cannot verify the current user for durable Co-Engineer state; refusing to create or open the state directory.',
    );
  }

  const root = path.parse(absolute).root;
  const components = [];
  const rootIdentity = await inspectComponent(root);
  if (!rootIdentity) {
    throw new StateDirectoryError(
      'state_unavailable',
      `The filesystem root for Co-Engineer state is unavailable: ${root}.`,
    );
  }
  components.push(rootIdentity);

  const relative = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let component = root;
  for (let index = 0; index < relative.length; index += 1) {
    component = path.join(component, relative[index]);
    const final = index === relative.length - 1;
    let identity = await inspectComponent(component, { final });
    if (!identity) {
      // Revalidate the parent before creating a missing child. This catches a
      // replacement of an ancestor without attempting a repair or following
      // a newly introduced symlink.
      await revalidateStateDirectory({ directory: absolute, components: [...components] });
      try {
        await mkdir(component, { mode: OWNER_ONLY_DIRECTORY_MODE });
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new StateDirectoryError(
            'state_unavailable',
            `Unable to create Co-Engineer state component ${component}: ${error?.message ?? String(error)}.`,
            { cause: error },
          );
        }
      }
      identity = await inspectComponent(component, { final });
      if (!identity) {
        throw new StateDirectoryError(
          'state_unavailable',
          `Co-Engineer state component could not be created: ${component}.`,
        );
      }
    }
    components.push(identity);
  }

  const handle = Object.freeze({
    directory: absolute,
    components: Object.freeze(components),
  });
  await revalidateStateDirectory(handle);
  return handle;
}

export class StateDirectoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'StateDirectoryError';
    this.code = code;
  }
}

export const STATE_DIRECTORY_NAME = COMPONENT_STATE_DIRECTORY;
export const STATE_DIRECTORY_MODE = OWNER_ONLY_DIRECTORY_MODE;
export const DAEMON_CONTROL_PROTOCOL = 'codex-co-engineer.daemon.v1';
